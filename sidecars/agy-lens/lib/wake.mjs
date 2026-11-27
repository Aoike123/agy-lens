// Opt-in quota cycle auto-wake helper via Antigravity's official local
// ConversationService HTTP+JSON API. Defaults strictly OFF (zero token calls
// unless the user explicitly enables auto-wake for a pool).
// Pure ESM, zero external dependencies.

import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { isValidPoolSlug } from './catalog.mjs';
import { writeJsonAtomic } from './pb.mjs';
import { priceInfo } from './pricing.mjs';

export const WAKE_STATE_VERSION = 1;
export const AUTO_WAKE_COOLDOWN_MS = 12 * 60 * 60 * 1000;
export const WAKE_POLL_INTERVAL_MS = 1000;
export const WAKE_POLL_TIMEOUT_MS = 25 * 1000;
export const WAKE_PROMPT = 'Reply with only "OK". Do not use any tools.';
export const WAKE_TITLE = 'Agy Lens · Cycle Wake';
export const WAKE_TAG = 'agy-lens-wake';

const defaultInFlight = new Set();
const defaultMemoryGuard = new Map(); // `${filePath}::${poolCategory}` -> { lastAttemptMs, latched }
const defaultSleep = (ms) => new Promise((r) => {
  const tid = setTimeout(r, ms);
  tid.unref?.();
});

function guardKey(filePath, poolCategory) {
  return `${filePath || ''}::${poolCategory}`;
}

function isModelRejectedError(err) {
  if (!err || err.code === 'NO_LS') return false;
  const msg = String(err.message || '');
  if (/timeout/i.test(msg)) return false;
  return /\bHTTP (?:400|404)\b/i.test(msg);
}

const EFFORT_SCORES = [
  [/\bminimal\b|\(minimal\)/i, 0],
  [/\blow\b|\(low\)/i, 1],
  [/\bmedium\b|\(medium\)/i, 2],
  [/\bhigh\b|\(high\)/i, 3],
  [/\bxhigh\b|\bextra\s+high\b|\(xhigh\)/i, 4],
  [/\bmax\b|\(max\)/i, 5],
];

function effortScore(text) {
  for (const [re, score] of EFFORT_SCORES) {
    if (re.test(text)) return score;
  }
  return 2.5;
}

function heuristicUnitCost(id, displayName) {
  const s = `${id || ''} ${displayName || ''}`.toLowerCase();
  if (/gpt[-_ ]?oss[-_ ]?20b/.test(s)) return 0.1;
  if (/flash[-_ ]?lite/.test(s)) return 0.35;
  if (/gpt[-_ ]?oss/.test(s)) return 0.4;
  if (/haiku/.test(s)) return 0.8;
  if (/flash/.test(s)) return 1.2;
  if (/hydrogen/.test(s)) return 3.0;
  if (/sonnet|argon|carbon/.test(s)) return 4.5;
  if (/pro/.test(s)) return 5.5;
  if (/opus|neon/.test(s)) return 10.0;
  return 50.0;
}

/**
 * Returns true when a finite quota pool's weekly limit is full (100%) and has
 * no active reset_time yet (Antigravity's lazy-start "starts on first use" state).
 */
export function isPoolPendingStart(pool) {
  if (!pool || typeof pool !== 'object') return false;
  if (pool.kind === 'tab' || pool.category === 'tab') return false;
  const lims = Array.isArray(pool.limits) ? pool.limits : [];
  const wk = lims.find((l) => l && l.kind === 'weekly');
  if (!wk) return false;
  return typeof wk.remaining_fraction === 'number'
    && Number.isFinite(wk.remaining_fraction)
    && wk.remaining_fraction >= 1 - 1e-6
    && !wk.reset_time;
}

/**
 * Returns true when a finite quota pool has an active weekly cycle with a
 * valid reset_time strictly in the future. Used to re-arm the per-cycle latch.
 */
export function isPoolActivelyRunning(pool, nowMs = Date.now()) {
  if (!pool || typeof pool !== 'object') return false;
  if (pool.kind === 'tab' || pool.category === 'tab') return false;
  const lims = Array.isArray(pool.limits) ? pool.limits : [];
  const wk = lims.find((l) => l && l.kind === 'weekly');
  if (!wk || !wk.reset_time) return false;
  const resetMs = Date.parse(wk.reset_time);
  return Number.isFinite(resetMs) && resetMs > nowMs;
}

/**
 * Ranks models inside one quota pool from cheapest/lightest to most expensive,
 * preferring visible non-orchestrator models with lowest public pricing and
 * lowest thinking effort.
 */
export function rankWakeModels(pool, customPrices = {}) {
  if (!pool || typeof pool !== 'object') return [];
  const visible = Array.isArray(pool.models) && pool.models.length ? pool.models : [];
  const raw = visible.length ? visible : (Array.isArray(pool.hidden_models) ? pool.hidden_models : []);
  const seen = new Set();
  const ranked = [];
  for (const m of raw) {
    if (!m || typeof m !== 'object') continue;
    const id = typeof m.id === 'string' ? m.id.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const displayName = typeof m.display_name === 'string' && m.display_name.trim() ? m.display_name.trim() : id;
    const text = `${id} ${displayName}`;
    const isOrch = /\borchestrator\b/i.test(text) ? 1 : 0;
    const [p] = priceInfo(id, customPrices);
    const unitCost = p ? (p[0] + p[1] * 0.25) : heuristicUnitCost(id, displayName);
    const effort = effortScore(text);
    ranked.push({
      id,
      display_name: displayName,
      unit_cost: Math.round(unitCost * 10000) / 10000,
      _orch: isOrch,
      _effort: effort,
    });
  }
  ranked.sort((a, b) => (
    (a._orch - b._orch)
    || (a.unit_cost - b.unit_cost)
    || (a._effort - b._effort)
    || a.id.localeCompare(b.id)
  ));
  return ranked.map(({ id, display_name, unit_cost }) => ({ id, display_name, unit_cost }));
}

export function pickCheapestWakeModel(pool, customPrices = {}) {
  return rankWakeModels(pool, customPrices)[0] || null;
}

function emptyPoolEntry() {
  return {
    auto: false,
    pending_latched: false,
    last_attempt_at: null,
    last_success_at: null,
    last_model: null,
    last_model_name: null,
    last_cleanup: null,
    last_error: null,
  };
}

function normalizeIsoOrNull(v) {
  if (typeof v !== 'string' || !v.trim()) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export function normalizeWakeState(raw) {
  const out = { version: WAKE_STATE_VERSION, pools: {} };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const src = raw.pools && typeof raw.pools === 'object' && !Array.isArray(raw.pools) ? raw.pools : {};
  for (const [pk, entry] of Object.entries(src)) {
    if (!isValidPoolSlug(pk) || pk === 'tab' || !entry || typeof entry !== 'object') continue;
    out.pools[pk] = {
      auto: Boolean(entry.auto),
      pending_latched: Boolean(entry.pending_latched),
      last_attempt_at: normalizeIsoOrNull(entry.last_attempt_at),
      last_success_at: normalizeIsoOrNull(entry.last_success_at),
      last_model: typeof entry.last_model === 'string' && entry.last_model.trim() ? entry.last_model.trim() : null,
      last_model_name: typeof entry.last_model_name === 'string' && entry.last_model_name.trim() ? entry.last_model_name.trim() : null,
      last_cleanup: entry.last_cleanup === 'deleted' || entry.last_cleanup === 'archived' || entry.last_cleanup === 'kept'
        ? entry.last_cleanup
        : null,
      last_error: typeof entry.last_error === 'string' && entry.last_error.trim() ? entry.last_error.trim().slice(0, 200) : null,
    };
  }
  return out;
}

export function loadWakeState(filePath) {
  if (!filePath || !existsSync(filePath)) return normalizeWakeState(null);
  try {
    return normalizeWakeState(JSON.parse(readFileSync(filePath, 'utf8')));
  } catch {
    return normalizeWakeState(null);
  }
}

export function saveWakeState(filePath, state) {
  const norm = normalizeWakeState(state);
  if (filePath) {
    try {
      writeJsonAtomic(filePath, norm);
    } catch (err) {
      console.error('[agy-lens] could not write quota-wake.json:', err.message);
    }
  }
  return norm;
}

function writeWakeStateStrict(filePath, state) {
  const norm = normalizeWakeState(state);
  if (filePath) writeJsonAtomic(filePath, norm);
  return norm;
}

/**
 * Re-arms the per-cycle pending latch once a pool is observed in a genuine
 * running weekly cycle (future reset_time). Never clears on errors or null reset.
 */
export function reconcileWakeState(filePath, quotaResult, { nowMs = Date.now(), memoryGuard = defaultMemoryGuard } = {}) {
  const st = loadWakeState(filePath);
  if (!quotaResult || quotaResult.error || !Array.isArray(quotaResult.pools)) return st;
  let dirty = false;
  for (const pool of quotaResult.pools) {
    if (!pool || !isValidPoolSlug(pool.category) || pool.category === 'tab') continue;
    if (!isPoolActivelyRunning(pool, nowMs)) continue;
    const entry = st.pools[pool.category];
    if (entry && entry.pending_latched) {
      entry.pending_latched = false;
      dirty = true;
    }
    const gk = guardKey(filePath, pool.category);
    const mem = memoryGuard && memoryGuard.get(gk);
    if (mem && mem.latched) {
      memoryGuard.set(gk, { ...mem, latched: false });
    }
  }
  return dirty ? saveWakeState(filePath, st) : st;
}

export function setPoolAutoWake(filePath, poolCategory, auto, { memoryGuard = defaultMemoryGuard } = {}) {
  if (!isValidPoolSlug(poolCategory) || poolCategory === 'tab') {
    throw new Error('Invalid quota pool');
  }
  const st = loadWakeState(filePath);
  const cur = st.pools[poolCategory] || emptyPoolEntry();
  cur.auto = Boolean(auto);
  if (!cur.auto) {
    const hadErr = Boolean(cur.last_error);
    cur.pending_latched = false;
    if (hadErr) cur.last_attempt_at = null;
    cur.last_error = null;
    const gk = guardKey(filePath, poolCategory);
    const mem = memoryGuard && memoryGuard.get(gk);
    if (mem) {
      memoryGuard.set(gk, {
        lastAttemptMs: hadErr ? NaN : mem.lastAttemptMs,
        latched: false,
      });
    }
  }
  st.pools[poolCategory] = cur;
  return saveWakeState(filePath, st);
}

/**
 * Calls Antigravity's documented local Connect HTTP+JSON ConversationService.
 */
export function conversationRequest(method, body, { timeoutMs = 15000 } = {}) {
  const addr = (process.env.ANTIGRAVITY_LS_ADDRESS || '').trim();
  const csrf = (process.env.ANTIGRAVITY_CSRF_TOKEN || '').trim();
  if (!addr || !csrf) {
    const err = new Error('Language server unavailable');
    err.code = 'NO_LS';
    return Promise.reject(err);
  }
  return new Promise((resolve, reject) => {
    const base = new URL(addr.startsWith('http') ? addr : `http://${addr}`);
    const data = JSON.stringify(body || {});
    const transport = base.protocol === 'https:' ? https : http;
    const req = transport.request({
      hostname: base.hostname,
      port: base.port,
      path: `/product.v1.ConversationService/${method}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
        'x-antigravity-csrf-token': csrf,
        'Content-Length': Buffer.byteLength(data),
      },
      timeout: timeoutMs,
      rejectUnauthorized: false,
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          let detail = '';
          try {
            const parsed = JSON.parse(text);
            detail = parsed?.message || parsed?.error || '';
          } catch { /* ignore */ }
          reject(new Error(`${method}: HTTP ${res.statusCode}${detail ? ` (${detail})` : ''}`));
          return;
        }
        if (!text.trim()) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(text));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`${method}: timeout`)));
    req.on('error', reject);
    req.end(data);
  });
}

export function buildWakePayload(wakeState, quotaResult = null, { inFlightPools = defaultInFlight, customPrices = {} } = {}) {
  const st = normalizeWakeState(wakeState);
  const pools = {};
  const quotaPools = quotaResult && !quotaResult.error && Array.isArray(quotaResult.pools) ? quotaResult.pools : [];
  const byCat = new Map();
  for (const p of quotaPools) {
    if (p && isValidPoolSlug(p.category) && p.category !== 'tab') {
      byCat.set(p.category, p);
    }
  }
  const allKeys = new Set([...Object.keys(st.pools), ...byCat.keys()]);
  for (const pk of allKeys) {
    const entry = st.pools[pk] || emptyPoolEntry();
    const qp = byCat.get(pk) || null;
    const model = qp ? pickCheapestWakeModel(qp, customPrices) : null;
    pools[pk] = {
      auto: Boolean(entry.auto),
      pending: qp ? isPoolPendingStart(qp) : false,
      latched: Boolean(entry.pending_latched),
      in_flight: Boolean(inFlightPools && inFlightPools.has(pk)),
      model: model ? { id: model.id, display_name: model.display_name } : null,
      last_attempt_at: entry.last_attempt_at,
      last_success_at: entry.last_success_at,
      last_model: entry.last_model,
      last_model_name: entry.last_model_name,
      last_cleanup: entry.last_cleanup,
      last_error: entry.last_error,
    };
  }
  return { pools };
}

function readRunState(resp) {
  return resp?.conversation?.state?.runState
    || resp?.state?.runState
    || resp?.conversation?.state?.run_state
    || resp?.state?.run_state
    || '';
}

function readConversationId(resp) {
  const raw = resp?.conversation?.id || resp?.id || '';
  return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * Auto-wakes a pending pool by sending a minimal message on its cheapest model
 * to start Antigravity's lazy weekly countdown, waits for idle, and deletes
 * (or archives) the temp chat. Strictly requires auto === true for the pool.
 */
export async function wakePoolCycle({
  poolCategory,
  wakeStatePath = null,
  quotaResult = null,
  refreshQuota = null,
  customPrices = {},
  inFlightPools = defaultInFlight,
  memoryGuard = defaultMemoryGuard,
  writeStateFn = writeWakeStateStrict,
  requestFn = conversationRequest,
  sleepFn = defaultSleep,
  nowFn = Date.now,
  pollIntervalMs = WAKE_POLL_INTERVAL_MS,
  pollTimeoutMs = WAKE_POLL_TIMEOUT_MS,
  autoCooldownMs = AUTO_WAKE_COOLDOWN_MS,
} = {}) {
  if (!isValidPoolSlug(poolCategory) || poolCategory === 'tab') {
    return { ok: false, error: 'invalid_pool', message: 'Invalid quota pool' };
  }
  if (inFlightPools.has(poolCategory)) {
    return { ok: false, error: 'in_flight', message: 'Wake already in progress for this pool' };
  }

  const st0 = loadWakeState(wakeStatePath);
  const entry0 = st0.pools[poolCategory] || emptyPoolEntry();
  const gk = guardKey(wakeStatePath, poolCategory);
  const mem0 = memoryGuard && memoryGuard.get(gk);
  const nowMs = nowFn();
  const diskAttemptMs = entry0.last_attempt_at ? Date.parse(entry0.last_attempt_at) : NaN;
  const memAttemptMs = mem0 && Number.isFinite(mem0.lastAttemptMs) ? mem0.lastAttemptMs : NaN;
  const lastAttemptMs = Number.isFinite(diskAttemptMs) && Number.isFinite(memAttemptMs)
    ? Math.max(diskAttemptMs, memAttemptMs)
    : (Number.isFinite(diskAttemptMs) ? diskAttemptMs : memAttemptMs);

  if (!entry0.auto) {
    return { ok: true, skipped: 'disabled', pool: poolCategory };
  }
  if (entry0.pending_latched || (mem0 && mem0.latched)) {
    return { ok: true, skipped: 'latched', pool: poolCategory };
  }
  if (Number.isFinite(lastAttemptMs) && nowMs - lastAttemptMs < autoCooldownMs) {
    return { ok: true, skipped: 'cooldown', pool: poolCategory };
  }

  inFlightPools.add(poolCategory);
  try {
    const freshQuota = typeof refreshQuota === 'function' ? await refreshQuota(true) : quotaResult;
    if (!freshQuota || freshQuota.error || !Array.isArray(freshQuota.pools)) {
      const msg = (freshQuota && freshQuota.message) || 'Quota unavailable';
      return { ok: false, error: 'quota_unavailable', message: msg };
    }
    const pool = freshQuota.pools.find((p) => p && p.category === poolCategory);
    if (!pool) {
      return { ok: false, error: 'pool_not_found', message: 'Quota pool not found' };
    }
    if (!isPoolPendingStart(pool)) {
      reconcileWakeState(wakeStatePath, freshQuota, { nowMs: nowFn(), memoryGuard });
      return { ok: true, skipped: 'already_started', pool: poolCategory, quota: freshQuota };
    }

    const candidates = rankWakeModels(pool, customPrices);
    if (!candidates.length) {
      return { ok: false, error: 'no_model', message: 'No callable model found in this pool' };
    }

    // Persist latch + attempt timestamp BEFORE any billable RPC call.
    // If state cannot be persisted to disk, abort with 0 model calls.
    const attemptMs = nowFn();
    const attemptIso = new Date(attemptMs).toISOString();
    const st1 = loadWakeState(wakeStatePath);
    const cur1 = st1.pools[poolCategory] || emptyPoolEntry();
    cur1.last_attempt_at = attemptIso;
    cur1.pending_latched = true;
    cur1.last_error = null;
    st1.pools[poolCategory] = cur1;
    try {
      writeStateFn(wakeStatePath, st1);
    } catch (err) {
      return {
        ok: false,
        error: 'state_write_failed',
        message: `Could not persist wake lock: ${(err && err.message) || err}`,
      };
    }
    if (memoryGuard) memoryGuard.set(gk, { lastAttemptMs: attemptMs, latched: true });

    let chosen = null;
    let convId = '';
    let lastCreateErr = null;
    for (const cand of candidates.slice(0, 2)) {
      try {
        const created = await requestFn('CreateConversation', {
          title: WAKE_TITLE,
          model: cand.id,
          tags: [WAKE_TAG],
          prompt: [{ text: WAKE_PROMPT }],
        }, { timeoutMs: 15000 });
        chosen = cand;
        convId = readConversationId(created);
        lastCreateErr = null;
        break;
      } catch (err) {
        lastCreateErr = err;
        // Only fall back to candidate #2 on explicit invalid-model rejection
        // (HTTP 400/404). Never retry on timeout/5xx/429 to prevent double-send.
        if (!isModelRejectedError(err)) break;
      }
    }

    if (!chosen) {
      const msg = (lastCreateErr && lastCreateErr.message) || 'Failed to create wake conversation';
      const stErr = loadWakeState(wakeStatePath);
      const curErr = stErr.pools[poolCategory] || emptyPoolEntry();
      curErr.pending_latched = true;
      curErr.last_error = msg.slice(0, 200);
      stErr.pools[poolCategory] = curErr;
      saveWakeState(wakeStatePath, stErr);
      return { ok: false, error: 'create_failed', message: msg };
    }

    let idle = false;
    if (convId) {
      const deadline = nowFn() + Math.max(0, pollTimeoutMs);
      while (nowFn() <= deadline) {
        try {
          const info = await requestFn('GetConversation', { conversationId: convId }, { timeoutMs: 8000 });
          const rs = readRunState(info);
          if (rs === 'RUN_STATE_IDLE' || rs === 'RUN_STATE_CANCELLING') {
            idle = true;
            break;
          }
        } catch {
          break;
        }
        if (nowFn() + pollIntervalMs > deadline) break;
        await sleepFn(pollIntervalMs);
      }
    }

    let cleanup = null;
    if (convId) {
      if (idle) {
        try {
          await requestFn('DeleteConversation', { conversationId: convId }, { timeoutMs: 8000 });
          cleanup = 'deleted';
        } catch {
          try {
            await requestFn('UpdateConversation', {
              conversationId: convId,
              annotations: { archived: true },
            }, { timeoutMs: 8000 });
            cleanup = 'archived';
          } catch {
            cleanup = 'kept';
          }
        }
      } else {
        try {
          await requestFn('UpdateConversation', {
            conversationId: convId,
            annotations: { archived: true },
          }, { timeoutMs: 8000 });
          cleanup = 'archived';
        } catch {
          cleanup = 'kept';
        }
      }
    }

    let postQuota = freshQuota;
    if (typeof refreshQuota === 'function') {
      try {
        postQuota = await refreshQuota(true);
      } catch { /* keep previous snapshot */ }
    }

    const doneMs = nowFn();
    const doneIso = new Date(doneMs).toISOString();
    const postPool = postQuota && !postQuota.error && Array.isArray(postQuota.pools)
      ? postQuota.pools.find((p) => p && p.category === poolCategory)
      : null;
    const startedNow = Boolean(postPool && isPoolActivelyRunning(postPool, doneMs));
    const stDone = loadWakeState(wakeStatePath);
    const curDone = stDone.pools[poolCategory] || emptyPoolEntry();
    curDone.last_success_at = doneIso;
    curDone.last_model = chosen.id;
    curDone.last_model_name = chosen.display_name;
    curDone.last_cleanup = cleanup;
    curDone.last_error = null;
    curDone.pending_latched = !startedNow;
    stDone.pools[poolCategory] = curDone;
    saveWakeState(wakeStatePath, stDone);
    if (memoryGuard) memoryGuard.set(gk, { lastAttemptMs: attemptMs, latched: !startedNow });

    return {
      ok: true,
      pool: poolCategory,
      model: chosen.id,
      model_name: chosen.display_name,
      cleanup,
      quota: postQuota,
    };
  } finally {
    inFlightPools.delete(poolCategory);
  }
}
