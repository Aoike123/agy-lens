#!/usr/bin/env node
/**
 * Multi-conversation token-usage scanner for Antigravity conversation databases.
 *
 * Pure Node.js ESM using built-in `node:sqlite` (zero Python or external
 * npm dependencies). Always opens databases read-only.
 *
 *   node lib/history.mjs --json [--cache PATH] [--root DIR[=label]]... [--days 365] [--pricing-file PATH]
 */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { POOLS, catalogDisplay, loadModelCatalog, modelPool } from './catalog.mjs';
import { calibratePoolWeights, calibratedCallCost, filterExternalSegments } from './calibration.mjs';
import {
  Msg,
  cmpCode,
  defaultGeminiDir,
  expandHome,
  formatLocalIso,
  localDateKey,
  openReadOnlyDb,
  roundN,
  writeJsonAtomic,
} from './pb.mjs';
import { LONG_CONTEXT_THRESHOLD, costOf, costPartsOf, loadPricingFile, priceInfo } from './pricing.mjs';

export const CACHE_VERSION = 6;
export const ENUM_PREFIX = 'enum:';

const GEN_FIELDS = new Set([1, 3]); // chat_model, planner_config
const CHAT_FIELDS = new Set([4, 19, 21]); // usage, response_model, model_display_name
const PLANNER_FIELDS = new Set([28]); // model_name
const USAGE_FIELDS = new Set([2, 3, 5, 9]); // input, output, cache_read, thinking
const STEP_MD_FIELDS = new Set([1]); // created_at
const STEP_UI_OUTER = new Set([19]);
const STEP_UI_INNER = new Set([2]);

// --- per-database parsing ----------------------------------------------------

export const STEP_PLANNER_RESPONSE = 15;
export const MAX_CONVERSATIONS = 500;
export const DISPLAY_PREFIX = 'display:';
export const TITLE_MAX = 80;

export function fingerprint(dbPath) {
  let st;
  try {
    st = statSync(dbPath, { bigint: true });
  } catch {
    return null;
  }
  const fp = [String(st.mtimeNs), String(st.size), '0', '0'];
  try {
    const wst = statSync(`${dbPath}-wal`, { bigint: true });
    fp[2] = String(wst.mtimeNs);
    fp[3] = String(wst.size);
  } catch { /* no wal */ }
  return fp;
}

function sameFp(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === 4 && b.length === 4
    && a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

export function plannerTimestamps(conn) {
  let rows;
  try {
    rows = conn.prepare('SELECT metadata FROM steps WHERE step_type = ? ORDER BY idx').all(STEP_PLANNER_RESPONSE);
  } catch {
    return [];
  }
  const stamps = [];
  for (const row of rows) {
    const created = new Msg(row.metadata, STEP_MD_FIELDS).msg(1);
    const sec = created ? created.int(1) : 0;
    if (sec > 0) stamps.push(sec);
  }
  return stamps;
}

export function generationTime(stamps, i, fallbackTs) {
  if (!stamps.length) return fallbackTs;
  return i < stamps.length ? stamps[i] : stamps[stamps.length - 1];
}

export function generationTimestamps(conn, count, fallbackTs) {
  const stamps = plannerTimestamps(conn);
  const out = new Array(count);
  for (let i = 0; i < count; i += 1) out[i] = generationTime(stamps, i, fallbackTs);
  return out;
}

export function parseGeneration(data) {
  if (!data || data.length === 0) return null;
  const gen = new Msg(data, GEN_FIELDS);
  const chat = gen.msg(1, CHAT_FIELDS);
  const usage = chat ? chat.msg(4, USAGE_FIELDS) : null;
  if (!usage) return null;
  const planner = gen.msg(3, PLANNER_FIELDS);
  const model = (planner ? planner.str(28) : '') || chat.str(19);
  return [model, chat.str(21), usage.int(2), usage.int(3), usage.int(5), usage.int(9)];
}

function truncateTitle(raw) {
  const text = String(raw || '').trim().split(/\s+/).filter(Boolean).join(' ');
  if (!text) return null;
  const chars = Array.from(text);
  return chars.length <= TITLE_MAX ? text : `${chars.slice(0, TITLE_MAX - 1).join('')}…`;
}

export function firstUserText(conn) {
  let row;
  try {
    row = conn.prepare('SELECT step_payload FROM steps WHERE step_type = 14 ORDER BY idx LIMIT 1').get();
  } catch {
    return null;
  }
  if (!row || !row.step_payload) return null;
  const ui = new Msg(row.step_payload, STEP_UI_OUTER).msg(19, STEP_UI_INNER);
  return ui ? truncateTitle(ui.str(2)) : null;
}

// ModelUsageStats: 1 model enum, 2 input, 3 output, 5 cache_read, 7 message id,
// 9 thinking, 11 response id.
const USAGE_ID_FIELDS = new Set([1, 2, 3, 5, 7, 9, 11]);
const STEP_USAGE_MD_FIELDS = new Set([1, 9, 28]); // created_at, usage, retries[].usage

const usageId = (u) => u.str(11) || u.str(7);

/**
 * Extracts exact timestamps per response/message ID from steps.metadata so
 * gen_metadata calls do not drift when step/generation counts diverge.
 */
export function stepUsageTimestamps(stepRows) {
  const map = new Map();
  for (const row of stepRows) {
    if (!row || !row.metadata) continue;
    const md = new Msg(row.metadata, STEP_USAGE_MD_FIELDS);
    const created = md.msg(1);
    const sec = created ? created.int(1) : 0;
    if (sec <= 0) continue;
    const usages = [md.msg(9, USAGE_ID_FIELDS)];
    for (const retry of md.msgs(28)) usages.push(retry.msg(2, USAGE_ID_FIELDS));
    for (const u of usages) {
      if (!u) continue;
      const id = usageId(u);
      if (id && !map.has(id)) map.set(id, sec);
    }
  }
  return map;
}

/**
 * Model calls recorded only in step metadata, not in gen_metadata: context
 * compaction / checkpoint summaries (CHECKPOINT steps) and their retries.
 * Records whose response id is already in gen_metadata are skipped.
 */
export function stepOnlyUsage(stepRows, seenIds, enumModels, fallbackModel, fallbackTs) {
  const calls = [];
  for (const row of stepRows) {
    if (!row || !row.metadata) continue;
    const md = new Msg(row.metadata, STEP_USAGE_MD_FIELDS);
    const usages = [md.msg(9, USAGE_ID_FIELDS)];
    for (const retry of md.msgs(28)) usages.push(retry.msg(2, USAGE_ID_FIELDS));
    const created = md.msg(1);
    const sec = created ? created.int(1) : 0;
    for (const u of usages) {
      if (!u) continue;
      const id = usageId(u);
      if (!id || seenIds.has(id)) continue;
      const inp = u.int(2);
      const out = u.int(3);
      const cache = u.int(5);
      const think = u.int(9);
      if (!(inp || out || cache || think)) continue;
      seenIds.add(id);
      const enumNum = u.int(1);
      let model;
      if (enumNum > 0 && enumModels.has(enumNum)) model = enumModels.get(enumNum);
      else if (enumNum > 0) model = `${ENUM_PREFIX}${enumNum}`;
      else model = fallbackModel || 'unknown';
      calls.push([sec > 0 ? sec : fallbackTs, model, inp, out, cache, think]);
    }
  }
  return calls;
}

export async function parseDb(dbPath) {
  const p = String(dbPath);
  const fallbackTs = statSync(p).mtimeMs / 1000;
  const conn = await openReadOnlyDb(p);
  let gens;
  let stamps;
  let firstInput;
  let stepRows = [];
  try {
    try {
      gens = conn.prepare('SELECT data FROM gen_metadata ORDER BY idx').all();
    } catch (err) {
      if (!String(err?.message || '').includes('no such table')) throw err;
      conn.prepare('SELECT 1 FROM sqlite_master LIMIT 1').all();
      return { calls: [], names: {}, enums: {}, first_input: null };
    }
    stamps = plannerTimestamps(conn);
    firstInput = firstUserText(conn);
    try {
      stepRows = conn.prepare('SELECT metadata FROM steps ORDER BY idx').all();
    } catch { /* no steps table */ }
  } finally {
    conn.close();
  }

  const idTimestamps = stepUsageTimestamps(stepRows);
  const calls = [];
  const names = Object.create(null);
  const seenIds = new Set();
  const enumModels = new Map();
  const modelCounts = new Map();
  for (let i = 0; i < gens.length; i += 1) {
    const g = parseGeneration(gens[i].data);
    const u = new Msg(gens[i].data, GEN_FIELDS).msg(1, CHAT_FIELDS)?.msg(4, USAGE_ID_FIELDS);
    const id = u ? usageId(u) : '';
    if (id) seenIds.add(id);
    if (!g) continue;
    let [model, display] = g;
    const [, , inp, out, cache, think] = g;
    if (!(inp || out || cache || think)) continue;
    if (model) {
      if (display) names[model] = display;
      if (u && u.int(1)) enumModels.set(u.int(1), model);
    } else {
      model = display ? DISPLAY_PREFIX + display : 'unknown';
    }
    modelCounts.set(model, (modelCounts.get(model) || 0) + 1);
    const ts = (id && idTimestamps.has(id)) ? idTimestamps.get(id) : generationTime(stamps, i, fallbackTs);
    calls.push([ts, model, inp, out, cache, think]);
  }
  let mainModel = null;
  for (const [m, n] of modelCounts) {
    if (mainModel === null || n > modelCounts.get(mainModel)) mainModel = m;
  }
  calls.push(...stepOnlyUsage(stepRows, seenIds, enumModels, mainModel, fallbackTs));
  return { calls, names: { ...names }, enums: Object.fromEntries(enumModels), first_input: firstInput };
}

export async function loadTitles(roots) {
  const titles = new Map();
  const agents = new Map();
  const parents = new Map(); // conversation id -> parent conversation id (subagents)
  const seen = new Set();
  for (const [root] of roots) {
    const p = join(dirname(resolve(expandHome(root))), 'conversation_summaries.db');
    let st;
    try { st = statSync(p); } catch { continue; }
    if (!st.isFile()) continue;
    let rp;
    try { rp = realpathSync(p); } catch { rp = resolve(p); }
    if (seen.has(rp)) continue;
    seen.add(rp);
    try {
      const conn = await openReadOnlyDb(p);
      try {
        const cols = new Set(conn.prepare('PRAGMA table_info(conversation_summaries)').all().map((r) => r.name));
        const sel = ['conversation_id', 'title', 'preview', 'agent_name', 'parent_conversation_id']
          .map((c, i) => (cols.has(c) ? c : `'' AS c${i}`))
          .join(', ');
        for (const row of conn.prepare(`SELECT ${sel} FROM conversation_summaries`).iterate()) {
          const vals = Object.values(row);
          const cid = row.conversation_id ?? vals[0];
          const title = row.title ?? vals[1];
          const preview = row.preview ?? vals[2];
          const agent = row.agent_name ?? vals[3];
          const parent = row.parent_conversation_id ?? vals[4];
          if (!cid) continue;
          const id = String(cid);
          const t = truncateTitle(title || preview || '');
          if (t && !titles.has(id)) titles.set(id, t);
          const a = agent != null ? String(agent).trim() : '';
          if (a && !agents.has(id)) agents.set(id, a);
          const pid = parent != null ? String(parent).trim() : '';
          if (pid && pid !== id && !parents.has(id)) parents.set(id, pid);
        }
        // Newer builds also keep links in a dedicated table.
        try {
          for (const row of conn.prepare('SELECT conversation_id, parent_id FROM conversation_parents').iterate()) {
            const id = row.conversation_id ? String(row.conversation_id) : '';
            const pid = row.parent_id ? String(row.parent_id).trim() : '';
            if (id && pid && pid !== id && !parents.has(id)) parents.set(id, pid);
          }
        } catch { /* table absent */ }
      } finally {
        conn.close();
      }
    } catch {
      continue;
    }
  }
  return [titles, agents, parents];
}

/**
 * Live subagent database paths plus archived subagent entries (when a subagent
 * DB was deleted from disk) and known model enum mappings below `conversationId`.
 */
export async function findSubagentSources(roots, conversationId, cachePath = null) {
  if (!conversationId) return { dbPaths: [], archivedEntries: [], enums: {} };
  const [, , summaryParents] = await loadTitles(roots);
  const parents = new Map(summaryParents);
  const { dbs: cachedDbs, enums: cachedEnums } = cachePath ? loadCacheFile(cachePath) : { dbs: {}, enums: {} };
  const mergedEnums = Object.create(null);
  if (cachedEnums && typeof cachedEnums === 'object') {
    for (const [k, v] of Object.entries(cachedEnums)) {
      if (typeof v === 'string' && v && !v.startsWith(ENUM_PREFIX)) mergedEnums[k] = v;
    }
  }
  const normKey = (k) => (process.platform === 'win32' ? String(k).toLowerCase() : String(k));
  const rootSet = new Set(roots.map(([rawRoot]) => normKey(resolve(expandHome(rawRoot)))));
  const archivedById = new Map();
  for (const [key, entry] of Object.entries(cachedDbs || {})) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.enums && typeof entry.enums === 'object') {
      for (const [k, v] of Object.entries(entry.enums)) {
        if (typeof v === 'string' && v && !v.startsWith(ENUM_PREFIX)) mergedEnums[k] = v;
      }
    }
    if (!rootSet.has(normKey(dirname(key)))) continue;
    const base = basename(key);
    const stem = base.endsWith('.db') ? base.slice(0, -3) : base;
    if (typeof entry.parent === 'string' && entry.parent && entry.parent !== stem && !parents.has(stem)) {
      parents.set(stem, entry.parent);
    }
    if (Array.isArray(entry.calls) && entry.calls.length && !existsSync(key)) {
      const prev = archivedById.get(stem);
      if (!prev || rowCalls(entry) > rowCalls(prev)) archivedById.set(stem, entry);
    }
  }
  const kids = new Map();
  for (const [id, pid] of parents) {
    if (!kids.has(pid)) kids.set(pid, []);
    kids.get(pid).push(id);
  }
  const dbPaths = [];
  const archivedEntries = [];
  const seen = new Set([conversationId]);
  const queue = [...(kids.get(conversationId) || [])];
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    let foundLive = false;
    for (const [root] of roots) {
      const p = join(resolve(expandHome(root)), `${id}.db`);
      if (existsSync(p)) {
        dbPaths.push(p);
        foundLive = true;
        break;
      }
    }
    if (!foundLive && archivedById.has(id)) {
      archivedEntries.push(archivedById.get(id));
    }
    queue.push(...(kids.get(id) || []));
  }
  return { dbPaths, archivedEntries, enums: mergedEnums };
}

/**
 * Database paths of every subagent conversation below `conversationId`
 * (children, grandchildren, ...) that still exist under `roots`.
 */
export async function findSubagentDbs(roots, conversationId) {
  const { dbPaths } = await findSubagentSources(roots, conversationId, null);
  return dbPaths;
}

// --- cache -------------------------------------------------------------------

// Older cache versions are still read so usage from conversations Antigravity has
// since deleted is not lost on upgrade; their live entries are re-parsed.
const READABLE_CACHE_VERSIONS = new Set([4, 5, CACHE_VERSION]);

// Returns { dbs, legacy, enums }: `legacy` records which legacy cache files were imported.
export function loadCacheFile(cachePath) {
  if (!cachePath) return { dbs: {}, legacy: {}, enums: {} };
  try {
    const data = JSON.parse(readFileSync(expandHome(cachePath), 'utf8'));
    if (data && typeof data === 'object' && READABLE_CACHE_VERSIONS.has(data.version) && data.dbs && typeof data.dbs === 'object' && !Array.isArray(data.dbs)) {
      const legacy = data.legacy && typeof data.legacy === 'object' && !Array.isArray(data.legacy) ? data.legacy : {};
      const enums = data.enums && typeof data.enums === 'object' && !Array.isArray(data.enums) ? data.enums : {};
      if (data.version === CACHE_VERSION) return { dbs: data.dbs, legacy, enums };
      const out = Object.create(null);
      for (const [k, v] of Object.entries(data.dbs)) {
        if (v && typeof v === 'object') out[k] = { ...v, stale: true };
      }
      return { dbs: out, legacy: {}, enums };
    }
  } catch { /* ignore */ }
  return { dbs: {}, legacy: {}, enums: {} };
}

export function loadCache(cachePath) {
  return loadCacheFile(cachePath).dbs;
}

const isCallRow = (r) => Array.isArray(r) && r.length >= 6 && Number.isFinite(r[0]) && typeof r[1] === 'string'
  && Number.isFinite(r[2]) && Number.isFinite(r[3]) && Number.isFinite(r[4]) && Number.isFinite(r[5]);

const rowCalls = (entry) => {
  let n = 0;
  for (const r of entry.calls) n += Array.isArray(r) && r.length >= 8 ? r[6] : 1;
  return n;
};

/**
 * Reads another history cache (older plugin builds, other installs, backups:
 * versions 3–6 share the call-row layout) and returns its entries for
 * conversation databases that no longer exist, as { key: entry }.
 */
export function readLegacyCache(filePath) {
  let data;
  try {
    data = JSON.parse(readFileSync(expandHome(filePath), 'utf8'));
  } catch {
    return {};
  }
  if (!data || typeof data !== 'object' || ![3, 4, 5, CACHE_VERSION].includes(data.version) || !data.dbs || typeof data.dbs !== 'object' || Array.isArray(data.dbs)) {
    return {};
  }
  const out = Object.create(null);
  for (const [key, e] of Object.entries(data.dbs)) {
    if (!e || typeof e !== 'object' || !Array.isArray(e.calls)) continue;
    const calls = e.calls.filter(isCallRow);
    if (!calls.length || existsSync(key)) continue;
    out[resolve(key)] = {
      calls,
      names: e.names && typeof e.names === 'object' && !Array.isArray(e.names) ? e.names : {},
      first_input: typeof e.first_input === 'string' ? e.first_input : null,
      ...(typeof e.label === 'string' ? { label: e.label } : {}),
      ...(e.archived ? { archived: true } : {}),
    };
  }
  return out;
}

const legacyStamp = (p) => {
  try {
    const st = statSync(p);
    return `${Math.trunc(st.mtimeMs)}:${st.size}`;
  } catch {
    return null;
  }
};

/**
 * History caches left by other plugin builds / installs and backups under
 * Antigravity's sidecar data folder (files named *history-cache.json, depth <= 4).
 */
export function findLegacyHistoryCaches(geminiDir = defaultGeminiDir(), maxDepth = 4) {
  const root = join(expandHome(geminiDir), 'antigravity', 'sidecar_data');
  const out = [];
  const walk = (dir, depth) => {
    let ents;
    try {
      ents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (depth < maxDepth) walk(full, depth + 1);
      } else if (ent.isFile() && ent.name.endsWith('history-cache.json')) {
        out.push(full);
      }
    }
  };
  walk(root, 0);
  return out.sort(cmpCode);
}

// --- weekly quota cycles ----------------------------------------------------

export const WEEK_SEC = 7 * 24 * 3600;
export const MIN_CYCLE_USED_FRACTION = 0.05;
export const MIN_DELTA_FINE_FRACTION = 0.03;
export const MIN_DELTA_COARSE_FRACTION = 0.05;
const isFineFraction = (rem) => Math.abs(rem * 100 - Math.round(rem * 100)) > 1e-4;

function normalizeCycleObsPoints(rawObs, resetMs, fallbackObs) {
  const src = Array.isArray(rawObs) && rawObs.length ? rawObs : [fallbackObs];
  const valid = [];
  for (const item of src) {
    if (!item || typeof item !== 'object') continue;
    const ms = Date.parse(item.observed_at);
    if (!Number.isFinite(ms)) continue;
    const effMs = Math.min(ms, resetMs);
    let rem = Number(item.remaining_fraction);
    if (!Number.isFinite(rem)) {
      const u = Number(item.used_fraction);
      if (!Number.isFinite(u)) continue;
      rem = 1 - u;
    }
    rem = Math.min(1, Math.max(0, rem));
    valid.push({ ms: effMs, rem, used: roundN(1 - rem, 8) });
  }
  valid.sort((a, b) => a.ms - b.ms || a.used - b.used);
  const out = [];
  for (const pt of valid) {
    const prev = out[out.length - 1];
    if (prev && Math.abs(prev.rem - pt.rem) <= 1e-6) continue;
    out.push(pt);
  }
  return out;
}

function pickBestDeltaPair(obsPoints, saturated) {
  if (!Array.isArray(obsPoints) || obsPoints.length < 2) return null;
  let bestUnsat = null;
  for (let i = 0; i < obsPoints.length; i += 1) {
    const a = obsPoints[i];
    for (let j = i + 1; j < obsPoints.length; j += 1) {
      const b = obsPoints[j];
      if (b.ms <= a.ms || b.rem <= 0 || b.used <= a.used) continue;
      const delta = roundN(b.used - a.used, 8);
      if (delta <= 0) continue;
      if (
        !bestUnsat
        || delta > bestUnsat.delta
        || (delta === bestUnsat.delta && (a.ms < bestUnsat.start.ms || (a.ms === bestUnsat.start.ms && b.ms < bestUnsat.end.ms)))
      ) {
        bestUnsat = { start: a, end: b, delta };
      }
    }
  }
  if (!saturated || (bestUnsat && bestUnsat.delta >= 0.2)) return bestUnsat;
  const firstSat = obsPoints.find((p) => p.rem <= 0);
  if (!firstSat) return bestUnsat;
  let minPre = null;
  for (const p of obsPoints) {
    if (p.ms >= firstSat.ms || p.used >= firstSat.used) continue;
    if (!minPre || p.used < minPre.used || (p.used === minPre.used && p.ms < minPre.ms)) {
      minPre = p;
    }
  }
  if (!minPre) return bestUnsat;
  const satDelta = roundN(1 - minPre.used, 8);
  if (satDelta > 0 && (!bestUnsat || satDelta > bestUnsat.delta)) {
    return { start: minPre, end: firstSat, delta: satDelta };
  }
  return bestUnsat;
}

/**
 * Prepares persistent per-pool quota cycles for single-pass accumulation
 * inside `scan()`. Uses known `[cycle_start, min(eval_obs_at, reset_time)]`
 * (preferring `peak_unsaturated` >= 20% on saturated cycles) when consecutive
 * reset timestamps establish `cycle_start`; otherwise evaluates using the
 * largest monotonic in-cycle sample delta `[eval_start_at, eval_obs_at]`.
 */
export function prepareQuotaCycles(quotaCycles) {
  const map = new Map();
  if (!quotaCycles || typeof quotaCycles !== 'object' || Array.isArray(quotaCycles)) return map;
  const poolsSrc = quotaCycles.pools && typeof quotaCycles.pools === 'object' && !Array.isArray(quotaCycles.pools)
    ? quotaCycles.pools
    : quotaCycles;
  for (const [pool, list] of Object.entries(poolsSrc)) {
    if (!Array.isArray(list) || !list.length) continue;
    const out = [];
    for (const cy of list) {
      if (!cy || typeof cy !== 'object') continue;
      const resetMs = Date.parse(cy.reset_time);
      if (!Number.isFinite(resetMs)) continue;
      const rem = typeof cy.remaining_fraction === 'number' && Number.isFinite(cy.remaining_fraction)
        ? Math.min(1, Math.max(0, cy.remaining_fraction))
        : (typeof cy.used_fraction === 'number' && Number.isFinite(cy.used_fraction)
          ? Math.min(1, Math.max(0, 1 - cy.used_fraction))
          : null);
      if (rem === null) continue;
      const used = roundN(1 - rem, 8);
      const obsParsed = Date.parse(cy.observed_at);
      const obsMs = Number.isFinite(obsParsed) ? Math.min(obsParsed, resetMs) : resetMs;
      const firstParsed = Date.parse(cy.first_seen_at);
      const firstMs = Number.isFinite(firstParsed) ? Math.min(firstParsed, obsMs) : obsMs;
      const sat = Boolean(cy.saturated) || rem <= 0;

      const startParsed = cy.cycle_start ? Date.parse(cy.cycle_start) : NaN;
      const startSource = typeof cy.cycle_start_source === 'string'
        ? cy.cycle_start_source
        : (Number.isFinite(startParsed) ? 'explicit' : 'unknown');
      const hasCycleStart = Number.isFinite(startParsed) && startParsed < resetMs && startSource !== 'unknown';
      const cycleStartMs = hasCycleStart ? startParsed : null;
      const cycleStartIso = hasCycleStart ? new Date(cycleStartMs).toISOString() : null;
      const cycleDurationMs = hasCycleStart
        ? (Number.isFinite(cy.cycle_duration_ms) && cy.cycle_duration_ms > 0 ? cy.cycle_duration_ms : (resetMs - cycleStartMs))
        : null;

      let valuationMethod;
      let evalStartMs;
      let evalObsMs;
      let evalUsed;
      let evalStartInclusive;
      let cycleSpanStartSec;
      let minUsedFraction = MIN_CYCLE_USED_FRACTION;

      const rawObsSeed = Array.isArray(cy.observations) && cy.observations.length
        ? cy.observations
        : [
            ...(cy.peak_unsaturated ? [cy.peak_unsaturated] : []),
            { observed_at: new Date(obsMs).toISOString(), remaining_fraction: rem, used_fraction: used },
          ];
      const baseObsPoints = normalizeCycleObsPoints(rawObsSeed, resetMs, {
        observed_at: new Date(obsMs).toISOString(),
        remaining_fraction: rem,
        used_fraction: used,
      });

      if (hasCycleStart) {
        valuationMethod = 'cycle';
        evalStartMs = cycleStartMs;
        evalObsMs = obsMs;
        evalUsed = used;
        evalStartInclusive = true;
        cycleSpanStartSec = cycleStartMs / 1000;
        const peak = cy.peak_unsaturated;
        if (sat && peak && typeof peak === 'object') {
          const pObsMs = Date.parse(peak.observed_at);
          const pUsed = typeof peak.used_fraction === 'number' && Number.isFinite(peak.used_fraction)
            ? Math.min(1, Math.max(0, peak.used_fraction))
            : (typeof peak.remaining_fraction === 'number' && Number.isFinite(peak.remaining_fraction)
              ? roundN(1 - Math.min(1, Math.max(0, peak.remaining_fraction)), 8)
              : NaN);
          if (Number.isFinite(pObsMs) && Number.isFinite(pUsed) && pUsed >= 0.2 && pUsed < 1) {
            evalObsMs = Math.min(pObsMs, resetMs);
            evalUsed = pUsed;
          }
        }
      } else {
        valuationMethod = 'delta';
        cycleSpanStartSec = firstMs / 1000;
        const best = pickBestDeltaPair(baseObsPoints, sat);
        if (best) {
          evalStartMs = best.start.ms;
          evalObsMs = best.end.ms;
          evalUsed = best.delta;
          evalStartInclusive = best.start.used <= 0;
          minUsedFraction = (isFineFraction(best.start.rem) || isFineFraction(best.end.rem))
            ? MIN_DELTA_FINE_FRACTION
            : MIN_DELTA_COARSE_FRACTION;
        } else {
          evalStartMs = firstMs;
          evalObsMs = obsMs;
          evalUsed = 0;
          evalStartInclusive = false;
          minUsedFraction = MIN_DELTA_COARSE_FRACTION;
        }
      }

      const segPoints = hasCycleStart && (!baseObsPoints.length || baseObsPoints[0].ms > cycleStartMs)
        ? [{ ms: cycleStartMs, rem: 1, used: 0 }, ...baseObsPoints]
        : baseObsPoints;
      const segments = [];
      if (segPoints.length >= 2) {
        let anchor = segPoints[0];
        for (let k = 1; k < segPoints.length; k += 1) {
          const b = segPoints[k];
          if (b.ms <= anchor.ms || b.rem <= 0 || b.used <= anchor.used) continue;
          const delta = roundN(b.used - anchor.used, 8);
          const isLast = k === segPoints.length - 1;
          if (delta < 0.005 && !isLast) continue;
          if (delta <= 0) continue;
          segments.push({
            startSec: anchor.ms / 1000,
            endSec: b.ms / 1000,
            startInclusive: anchor.used <= 0,
            delta,
            fine: isFineFraction(anchor.rem) || isFineFraction(b.rem),
            inEvalWindow: anchor.ms >= evalStartMs - 1000 && b.ms <= evalObsMs + 1000,
            calls: 0,
            costUsd: 0,
            costPartial: false,
            costByModel: new Map(),
          });
          anchor = b;
        }
      }

      out.push({
        cycle_start: cycleStartIso,
        cycle_start_source: hasCycleStart ? startSource : 'unknown',
        cycle_duration_ms: cycleDurationMs,
        reset_time: new Date(resetMs).toISOString(),
        ended_at: null,
        first_seen_at: new Date(firstMs).toISOString(),
        observed_at: new Date(obsMs).toISOString(),
        eval_start_at: new Date(evalStartMs).toISOString(),
        eval_obs_at: new Date(evalObsMs).toISOString(),
        valuation_method: valuationMethod,
        remaining_fraction: rem,
        used_fraction: used,
        eval_used_fraction: evalUsed,
        saturated: sat,
        plan: typeof cy.plan === 'string' && cy.plan ? cy.plan : null,
        tier: typeof cy.tier === 'string' && cy.tier ? cy.tier : null,
        _startSec: hasCycleStart ? cycleStartMs / 1000 : null,
        _cycleSpanStartSec: cycleSpanStartSec,
        _resetSec: resetMs / 1000,
        _endSec: resetMs / 1000,
        _rawEndedAtMs: cy.ended_at ? Date.parse(cy.ended_at) : NaN,
        _evalStartSec: evalStartMs / 1000,
        _evalStartInclusive: evalStartInclusive,
        _evalObsSec: evalObsMs / 1000,
        _minUsedFraction: minUsedFraction,
        _evalCostByModel: new Map(),
        _segments: segments,
        observed_cost_usd: 0,
        cycle_cost_usd: 0,
        observed_calls: 0,
        cycle_calls: 0,
        cost_estimated: false,
        cost_partial: false,
      });
    }
    if (out.length) {
      out.sort((a, b) => b._resetSec - a._resetSec);
      for (let i = 0; i < out.length; i += 1) {
        const cy = out[i];
        let effEndMs = cy._resetSec * 1000;
        if (Number.isFinite(cy._rawEndedAtMs) && cy._rawEndedAtMs < effEndMs && (cy._startSec === null || cy._rawEndedAtMs > cy._startSec * 1000)) {
          effEndMs = cy._rawEndedAtMs;
        } else if (i > 0) {
          const newer = out[i - 1];
          const newerBoundMs = newer._startSec !== null ? newer._startSec * 1000 : Date.parse(newer.first_seen_at);
          const cyObsMs = Date.parse(cy.observed_at);
          if (
            Number.isFinite(newerBoundMs)
            && newerBoundMs < effEndMs - 120_000
            && (cy._startSec === null || newerBoundMs > cy._startSec * 1000)
            && newerBoundMs >= cyObsMs - 120_000
          ) {
            effEndMs = newerBoundMs;
          }
        }
        if (effEndMs < cy._resetSec * 1000) {
          cy.ended_at = new Date(effEndMs).toISOString();
          cy._endSec = effEndMs / 1000;
          if (cy._startSec !== null) cy.cycle_duration_ms = Math.max(0, effEndMs - cy._startSec * 1000);
        }
        delete cy._rawEndedAtMs;
      }
      map.set(pool, out);
    }
  }
  return map;
}

export const ARCHIVE_BUCKET_SEC = 900;
export const ARCHIVE_LONG_THRESHOLD = LONG_CONTEXT_THRESHOLD;

/**
 * Antigravity keeps only its newest conversations on disk. When a database
 * disappears its calls are kept here, merged into 15-minute buckets per model
 * (rows: [ts, model, input, output, cache_read, thinking, calls, long_context]).
 * Long-context calls get their own bucket so tiered prices stay exact.
 */
export function archiveEntry(entry) {
  if (entry.archived) return entry;
  const buckets = new Map();
  for (const row of entry.calls) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const [ts, model, inp, out, cache, think] = row;
    const n = row.length >= 8 ? row[6] : 1;
    const long = row.length >= 8 ? (row[7] ? 1 : 0) : (inp + cache > ARCHIVE_LONG_THRESHOLD ? 1 : 0);
    const bts = Math.floor(ts / ARCHIVE_BUCKET_SEC) * ARCHIVE_BUCKET_SEC;
    const k = `${bts}\u0000${model}\u0000${long}`;
    const b = buckets.get(k);
    if (b) {
      b[2] += inp; b[3] += out; b[4] += cache; b[5] += think; b[6] += n;
    } else {
      buckets.set(k, [bts, model, inp, out, cache, think, n, long]);
    }
  }
  const out = { ...entry, calls: Array.from(buckets.values()), archived: true };
  delete out.fp;
  delete out.stale;
  return out;
}

export function saveCache(cachePath, dbs, legacy = null, enums = null) {
  if (!cachePath) return;
  try {
    const payload = { version: CACHE_VERSION, dbs };
    if (legacy && Object.keys(legacy).length) payload.legacy = legacy;
    if (enums && Object.keys(enums).length) payload.enums = enums;
    writeJsonAtomic(cachePath, payload);
  } catch { /* ignore */ }
}

// --- aggregation -------------------------------------------------------------

const TREE_SUM_FIELDS = ['input', 'output', 'cache_read', 'thinking', 'calls', 'd7_tokens'];

/**
 * Arranges conversations as parent -> subagent trees. Each conversation keeps
 * its own usage and gets `total`: itself plus every descendant (subagents of
 * subagents included). Parents referenced but without usage of their own become
 * placeholders via makePlaceholder(id). Returns conversations depth-first,
 * roots and siblings by latest activity in their subtree, cut to `cap`.
 */
export function buildConversationTree(convs, parentOf, cap, makePlaceholder) {
  const byId = new Map();
  for (const c of convs) if (!byId.has(c.id)) byId.set(c.id, c);
  // Placeholders for parents (and their ancestors) that have no usage themselves.
  for (const c of convs) {
    let pid = parentOf.get(c.id);
    const guard = new Set([c.id]);
    while (pid && !byId.has(pid) && !guard.has(pid)) {
      guard.add(pid);
      byId.set(pid, makePlaceholder(pid));
      pid = parentOf.get(pid);
    }
  }
  const parent = new Map();
  for (const id of byId.keys()) {
    const pid = parentOf.get(id);
    if (!pid || pid === id || !byId.has(pid)) continue;
    // Refuse links that would close a cycle.
    let p = pid;
    const seen = new Set([id]);
    let cyclic = false;
    while (p) {
      if (seen.has(p)) { cyclic = true; break; }
      seen.add(p);
      p = parent.get(p) || null;
    }
    if (!cyclic) parent.set(id, pid);
  }
  const kids = new Map();
  for (const [id, pid] of parent) {
    if (!kids.has(pid)) kids.set(pid, []);
    kids.get(pid).push(id);
  }

  const trackQuotaCost = convs.some((c) => Boolean(c && c._quotaCostByPool));
  const totals = new Map();
  const sumOf = (id) => {
    if (totals.has(id)) return totals.get(id);
    const c = byId.get(id);
    const t = {
      input: 0, output: 0, cache_read: 0, thinking: 0, calls: 0, d7_tokens: 0,
      est_cost_usd: null, cost_estimated: false, cost_partial: false,
      d7_by_pool: {}, cost_by_pool: {}, subagents: 0, _last: -Infinity, _models: new Map(),
      ...(trackQuotaCost ? { quota_cost_by_pool: {} } : {}),
    };
    const add = (x, models, n) => {
      for (const f of TREE_SUM_FIELDS) t[f] += x[f] || 0;
      if (x.est_cost_usd !== null && x.est_cost_usd !== undefined) t.est_cost_usd = (t.est_cost_usd ?? 0) + x.est_cost_usd;
      if (x.cost_estimated) t.cost_estimated = true;
      if (x.cost_partial) t.cost_partial = true;
      for (const [k, v] of Object.entries(x.d7_by_pool || {})) t.d7_by_pool[k] = (t.d7_by_pool[k] ?? 0) + v;
      for (const [k, v] of Object.entries(x.cost_by_pool || {})) t.cost_by_pool[k] = (t.cost_by_pool[k] ?? 0) + v;
      if (trackQuotaCost) {
        const qSrc = x._quotaCostByPool || x.quota_cost_by_pool || x.cost_by_pool || {};
        for (const [k, v] of Object.entries(qSrc)) t.quota_cost_by_pool[k] = (t.quota_cost_by_pool[k] ?? 0) + v;
      }
      t._last = Math.max(t._last, x._last ?? -Infinity);
      for (const [m, v] of models) t._models.set(m, (t._models.get(m) || 0) + v);
      t.subagents += n;
    };
    const own = new Map();
    for (const cm of c._models.values()) own.set(cm.model, cm.input + cm.output + cm.cache_read);
    add(c, own, 0);
    for (const k of kids.get(id) || []) {
      const kt = sumOf(k);
      add(kt, kt._models, kt.subagents + 1);
    }
    totals.set(id, t);
    return t;
  };
  for (const id of byId.keys()) sumOf(id);

  const order = (ids) => ids.sort((a, b) => {
    const la = totals.get(a)._last;
    const lb = totals.get(b)._last;
    return lb !== la ? lb - la : cmpCode(a, b);
  });
  const out = [];
  const visit = (id, depth, rootId) => {
    const c = byId.get(id);
    const t = totals.get(id);
    let model = null;
    let best = -1;
    for (const [m, v] of t._models) if (v > best || (v === best && cmpCode(m, model) > 0)) { best = v; model = m; }
    c.parent_id = parent.get(id) || null;
    c.root_id = rootId;
    c.depth = depth;
    c.children = order([...(kids.get(id) || [])]);
    const { _models, ...rest } = t;
    c.total = {
      ...rest,
      d7_by_pool: { ...t.d7_by_pool },
      cost_by_pool: { ...t.cost_by_pool },
      ...(trackQuotaCost ? { quota_cost_by_pool: { ...t.quota_cost_by_pool } } : {}),
      model,
    };
    if (c.placeholder) {
      c._first = null;
      c._last = t._last;
    }
    out.push(c);
    for (const k of c.children) visit(k, depth + 1, rootId);
  };
  for (const id of order([...byId.keys()].filter((id) => !parent.has(id)))) visit(id, 0, id);
  if (out.length <= cap) return out;
  // Over the cap: keep top-level conversations first, then subagents level by
  // level, so no tree vanishes (each root's `total` still covers everything).
  const keep = new Set();
  const maxDepth = out.reduce((m, c) => Math.max(m, c.depth), 0);
  for (let d = 0; d <= maxDepth && keep.size < cap; d += 1) {
    for (const c of out) {
      if (keep.size >= cap) break;
      if (c.depth === d && (d === 0 || keep.has(c.parent_id))) keep.add(c.id);
    }
  }
  return out.filter((c) => keep.has(c.id));
}

export function defaultRoots(geminiDir = defaultGeminiDir()) {
  const base = expandHome(geminiDir);
  return [
    [join(base, 'antigravity', 'conversations'), 'desktop'],
    [join(base, 'antigravity-cli', 'conversations'), 'cli'],
  ];
}

export function parseRoot(spec) {
  const s = String(spec);
  const idx = s.lastIndexOf('=');
  if (idx >= 0) {
    const d = s.slice(0, idx);
    const label = s.slice(idx + 1);
    if (label && !label.includes('/') && !label.includes('\\')) {
      return [expandHome(d), label];
    }
  }
  return [expandHome(s), 'desktop'];
}

const emptyTotals = () => ({
  input: 0, output: 0, cache_read: 0, thinking: 0, calls: 0, conversations: 0,
  est_cost_usd: null, cost_estimated: false,
});

const emptyPools = () => ({ gemini: 0, claude_gpt: 0, other: 0 });

function dominantPool(primaryPool, ...maps) {
  for (const m of maps) {
    if (!m || typeof m !== 'object') continue;
    const keys = [...POOLS, ...Object.keys(m).filter((k) => !POOLS.includes(k)).sort()];
    let bestP = null;
    let bestVal = 0;
    for (const p of keys) {
      const val = m[p] || 0;
      if (val <= 0) continue;
      if (bestP === null || val > bestVal || (val === bestVal && p === primaryPool && bestP !== primaryPool)) {
        bestP = p;
        bestVal = val;
      }
    }
    if (bestP !== null) return bestP;
  }
  return primaryPool;
}

export async function scan(roots, {
  cachePath = null,
  days = 365,
  now = new Date(),
  stats = null,
  pricingFile = null,
  modelCatalogPath = null,
  maxConversations = MAX_CONVERSATIONS,
  quotaCycles = null,
  legacyCachePaths = [],
} = {}) {
  const t0 = performance.now();
  const totalDays = Math.max(1, Number(days) || 365);
  const cap = Math.max(0, Number.isFinite(maxConversations) ? maxConversations : MAX_CONVERSATIONS);
  const st = stats || {};
  st.hits = 0;
  st.misses = 0;

  const [customPrices, pricingSource, pricingFetchedAt] = loadPricingFile(pricingFile);
  const catalog = loadModelCatalog(modelCatalogPath);
  const { dbs: oldCache, legacy: oldLegacy, enums: oldEnums } = loadCacheFile(cachePath);
  const newCache = Object.create(null);
  const sources = { desktop: 0, cli: 0 };
  let errors = 0;
  const perDb = [];

  for (const [rawRoot, label] of roots) {
    if (!(label in sources)) sources[label] = 0;
    const rootDir = expandHome(rawRoot);
    let entries;
    try {
      entries = readdirSync(rootDir, { withFileTypes: true });
    } catch {
      continue;
    }
    const dbs = [];
    for (const ent of entries) {
      if (!ent.name.endsWith('.db')) continue;
      const full = join(rootDir, ent.name);
      try {
        if (ent.isFile() || (ent.isSymbolicLink() && statSync(full).isFile())) {
          dbs.push({ name: ent.name, stem: ent.name.slice(0, -3), path: full });
        }
      } catch { /* ignore */ }
    }
    dbs.sort((a, b) => cmpCode(a.path, b.path));

    for (const db of dbs) {
      const key = resolve(db.path);
      const fp = fingerprint(db.path);
      if (fp === null) {
        errors += 1;
        continue;
      }
      const cached = Object.prototype.hasOwnProperty.call(oldCache, key) ? oldCache[key] : null;
      const usable = cached && typeof cached === 'object' && Array.isArray(cached.calls) && !cached.archived;
      let entry;
      if (usable && !cached.stale && sameFp(cached.fp, fp)) {
        st.hits += 1;
        entry = cached;
      } else {
        st.misses += 1;
        try {
          const parsed = await parseDb(db.path);
          entry = { fp, label, ...parsed };
        } catch {
          errors += 1;
          // Keep the last good result (e.g. database briefly locked) instead of dropping its usage.
          if (!usable) continue;
          entry = cached;
        }
      }
      newCache[key] = entry;
      sources[label] += 1;
      perDb.push([key, entry, label, db.stem]);
    }
  }

  // Conversations Antigravity deleted from disk: keep counting their usage, from
  // this cache and from other history caches (older builds, backups).
  const normKey = (k) => (process.platform === 'win32' ? k.toLowerCase() : k);
  const rootLabels = new Map();
  for (const [rawRoot, label] of roots) rootLabels.set(normKey(resolve(expandHome(rawRoot))), label);
  const liveKeys = new Set(Object.keys(newCache).map(normKey));
  const archived = new Map(); // normKey -> [key, entry]
  const offerArchived = (key, cached) => {
    if (!cached || typeof cached !== 'object' || !Array.isArray(cached.calls) || !cached.calls.length) return false;
    const nk = normKey(key);
    if (liveKeys.has(nk) || !rootLabels.has(normKey(dirname(key)))) return false;
    const prev = archived.get(nk);
    if (prev && rowCalls(prev[1]) >= rowCalls(cached)) return false;
    if (!prev && existsSync(key)) return false;
    archived.set(nk, [prev ? prev[0] : key, archiveEntry(cached)]);
    return true;
  };
  for (const [key, cached] of Object.entries(oldCache)) offerArchived(key, cached);

  const legacy = { ...oldLegacy };
  let importedCount = 0;
  const ownCache = cachePath ? normKey(resolve(expandHome(cachePath))) : null;
  for (const lp of legacyCachePaths || []) {
    const full = resolve(expandHome(lp));
    if (normKey(full) === ownCache) continue;
    const stamp = legacyStamp(full);
    if (stamp === null || legacy[full] === stamp) continue;
    for (const [key, entry] of Object.entries(readLegacyCache(full))) {
      if (offerArchived(key, entry)) importedCount += 1;
    }
    legacy[full] = stamp;
  }

  for (const [nk, [key, entry]] of archived) {
    const dir = dirname(key);
    const label = typeof entry.label === 'string' && entry.label ? entry.label : rootLabels.get(normKey(dir));
    const base = key.slice(dir.length + 1);
    newCache[key] = entry;
    perDb.push([key, entry, label, base.endsWith('.db') ? base.slice(0, -3) : base]);
    void nk;
  }
  const archivedCount = archived.size;
  st.imported = importedCount;

  // Subagent links (conversation_summaries) are stored on entries too, so a
  // conversation keeps its place in the tree after Antigravity deletes it.
  const [titles, agents, summaryParents] = perDb.length ? await loadTitles(roots) : [new Map(), new Map(), new Map()];
  const parentOf = new Map();
  for (const [, entry, , stem] of perDb) {
    const pid = summaryParents.get(stem);
    if (pid) entry.parent = pid;
    const agent = agents.get(stem);
    if (agent) entry.agent = agent;
    if (typeof entry.parent === 'string' && entry.parent && entry.parent !== stem) parentOf.set(stem, entry.parent);
  }
  for (const [id, pid] of summaryParents) if (!parentOf.has(id)) parentOf.set(id, pid);

  const globalEnums = new Map();
  if (oldEnums && typeof oldEnums === 'object') {
    for (const [k, v] of Object.entries(oldEnums)) {
      if (typeof v === 'string' && v && !v.startsWith(ENUM_PREFIX)) globalEnums.set(String(k), v);
    }
  }
  for (const [, entry] of perDb) {
    if (entry.enums && typeof entry.enums === 'object') {
      for (const [k, v] of Object.entries(entry.enums)) {
        if (typeof v === 'string' && v && !v.startsWith(ENUM_PREFIX)) globalEnums.set(String(k), v);
      }
    }
  }

  saveCache(cachePath, newCache, legacy, Object.fromEntries(globalEnums));

  const parentIds = new Set(parentOf.values());
  const rootOf = (id) => {
    let cur = id;
    const seen = new Set([cur]);
    while (parentOf.has(cur)) {
      const p = parentOf.get(cur);
      if (!p || seen.has(p)) break;
      seen.add(p);
      cur = p;
    }
    return cur;
  };

  const todayKey = localDateKey(now);
  const nowHour = now.getHours();
  const d7Key = localDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6));
  const d30Key = localDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29));
  const windows = [
    ['today', todayKey],
    ['d7', d7Key],
    ['d30', d30Key],
    ['all', '0000-01-01'],
  ];

  const totals = {
    today: emptyTotals(),
    d7: emptyTotals(),
    d30: emptyTotals(),
    all: emptyTotals(),
  };
  const convSets = { today: new Set(), d7: new Set(), d30: new Set(), all: new Set() };
  const byModel = new Map();
  const names = new Map();
  const daily = new Map();
  for (let i = 0; i < totalDays; i += 1) {
    const dk = localDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (totalDays - 1) + i));
    daily.set(dk, [0, 0]);
  }
  const hourlyToday = Array.from({ length: 24 }, () => [0, 0]);
  const d7ByPool = emptyPools();
  const nowSec = now.getTime() / 1000;
  const cycleAccum = prepareQuotaCycles(quotaCycles);
  const periodModelParts = new Map(); // pool -> Map<period, Map<model, [in, out, cache]>>
  const dtCache = new Map();
  const priceCache = new Map();
  const poolCache = new Map();

  for (const [, entry] of perDb) {
    if (entry.names && typeof entry.names === 'object') {
      for (const [mid, disp] of Object.entries(entry.names)) names.set(mid, disp);
    }
  }
  const byDisplay = new Map();
  for (const mid of Array.from(names.keys()).sort(cmpCode)) {
    const disp = names.get(mid);
    if (!byDisplay.has(disp)) byDisplay.set(disp, mid);
  }

  const convs = [];
  for (const [key, entry, label, stem] of perDb) {
    if (!entry.calls || !entry.calls.length) continue;
    const conv = {
      id: stem,
      source: label,
      title: null,
      model: null,
      display_name: null,
      pool: 'other',
      first_at: null,
      last_at: null,
      input: 0,
      output: 0,
      cache_read: 0,
      thinking: 0,
      d7_tokens: 0,
      d7_by_pool: emptyPools(),
      cost_by_pool: emptyPools(),
      calls: 0,
      est_cost_usd: null,
      cost_partial: false,
      cost_estimated: false,
      is_subagent: false,
      archived: Boolean(entry.archived),
      by_model: [],
      _first: null,
      _last: -Infinity,
      _models: new Map(),
      _modelParts: new Map(),
      _first_input: entry.first_input ?? null,
    };
    convs.push(conv);

    const rootId = rootOf(stem);
    const convKey = (rootId !== stem || parentIds.has(stem)) ? rootId : key;

    for (const row of entry.calls) {
      const [ts, rawModel, inp, out, cache, think] = row;
      // Archived rows are pre-aggregated: [.., calls, long_context].
      const n = row.length >= 8 ? row[6] : 1;
      const longCtx = row.length >= 8 ? Boolean(row[7]) : null;
      let model = rawModel;
      if (model.startsWith(ENUM_PREFIX)) {
        const resolved = globalEnums.get(model.slice(ENUM_PREFIX.length));
        model = resolved || 'unknown';
      }
      if (model.startsWith(DISPLAY_PREFIX)) {
        const disp = model.slice(DISPLAY_PREFIX.length);
        model = byDisplay.has(disp) ? byDisplay.get(disp) : disp;
        if (!names.has(model)) names.set(model, disp);
      }

      const sec = Math.trunc(ts);
      let dh = dtCache.get(sec);
      if (!dh) {
        const dt = new Date(ts * 1000);
        if (!Number.isNaN(dt.getTime()) && dt.getFullYear() >= 1970 && dt.getFullYear() <= 2100) {
          dh = [localDateKey(dt), dt.getHours()];
        } else {
          dh = [todayKey, nowHour];
        }
        dtCache.set(sec, dh);
      }
      const [dk, hour] = dh;

      let pinfo = priceCache.get(model);
      if (!pinfo) {
        pinfo = priceInfo(model, customPrices);
        priceCache.set(model, pinfo);
      }
      const [p, isEst] = pinfo;
      const parts = p !== null ? costPartsOf(p, inp, out, cache, longCtx) : null;
      const cost = p !== null ? costOf(p, inp, out, cache, longCtx) : null;

      let pool = poolCache.get(model);
      if (!pool) {
        pool = modelPool(model, catalog);
        poolCache.set(model, pool);
      }

      const inD7 = dk >= d7Key && dk <= todayKey;
      conv.input += inp;
      conv.output += out;
      conv.cache_read += cache;
      conv.thinking += think;
      if (inD7) {
        const d7Tok = inp + out;
        conv.d7_tokens += d7Tok;
        conv.d7_by_pool[pool] = (conv.d7_by_pool[pool] ?? 0) + d7Tok;
        d7ByPool[pool] = (d7ByPool[pool] ?? 0) + d7Tok;
      }
      if (parts !== null) {
        conv.cost_by_pool[pool] = (conv.cost_by_pool[pool] ?? 0) + cost;
        let cmp = conv._modelParts.get(model);
        if (!cmp) {
          cmp = [pool, 0, 0, 0];
          conv._modelParts.set(model, cmp);
        }
        cmp[1] += parts[0];
        cmp[2] += parts[1];
        cmp[3] += parts[2];
      }
      const poolCycles = cycleAccum.get(pool);
      if (poolCycles) {
        for (const cy of poolCycles) {
          if (ts >= cy._cycleSpanStartSec && ts < cy._endSec) {
            cy.cycle_calls += n;
            if (cost !== null) cy.cycle_cost_usd += cost;
            const afterEvalStart = cy._evalStartInclusive ? ts >= cy._evalStartSec : ts > cy._evalStartSec;
            if (cy.eval_used_fraction > 0 && afterEvalStart && ts <= cy._evalObsSec + 5) {
              cy.observed_calls += n;
              if (parts !== null) {
                cy.observed_cost_usd += cost;
                if (isEst) cy.cost_estimated = true;
                let em = cy._evalCostByModel.get(model);
                if (!em) {
                  em = { in: 0, out: 0, cache: 0, total: 0 };
                  cy._evalCostByModel.set(model, em);
                }
                em.in += parts[0];
                em.out += parts[1];
                em.cache += parts[2];
                em.total += cost;
              } else {
                cy.cost_partial = true;
              }
            }
            if (cy._segments.length) {
              for (let si = 0; si < cy._segments.length; si += 1) {
                const seg = cy._segments[si];
                const isLastSeg = si === cy._segments.length - 1;
                const afterSegStart = seg.startInclusive ? ts >= seg.startSec : ts > seg.startSec;
                const beforeSegEnd = isLastSeg ? ts <= seg.endSec + 5 : ts <= seg.endSec;
                if (afterSegStart && beforeSegEnd) {
                  seg.calls += n;
                  if (parts !== null) {
                    seg.costUsd += cost;
                    let sm = seg.costByModel.get(model);
                    if (!sm) {
                      sm = { in: 0, out: 0, cache: 0, total: 0 };
                      seg.costByModel.set(model, sm);
                    }
                    sm.in += parts[0];
                    sm.out += parts[1];
                    sm.cache += parts[2];
                    sm.total += cost;
                  } else {
                    seg.costPartial = true;
                  }
                  break;
                }
              }
            }
          }
        }
      }
      conv.calls += n;
      if (cost !== null) {
        conv.est_cost_usd = (conv.est_cost_usd ?? 0) + cost;
        if (isEst) conv.cost_estimated = true;
      } else {
        conv.cost_partial = true;
      }
      conv._first = conv._first === null ? ts : Math.min(conv._first, ts);
      conv._last = Math.max(conv._last, ts);

      let cm = conv._models.get(model);
      if (!cm) {
        cm = {
          model, display_name: null, input: 0, output: 0, cache_read: 0, thinking: 0,
          calls: 0, est_cost_usd: null, cost_estimated: false,
        };
        conv._models.set(model, cm);
      }
      cm.input += inp;
      cm.output += out;
      cm.cache_read += cache;
      cm.thinking += think;
      cm.calls += n;
      if (cost !== null) {
        cm.est_cost_usd = (cm.est_cost_usd ?? 0) + cost;
        if (isEst) cm.cost_estimated = true;
      }

      for (const [w, start] of windows) {
        if (dk >= start && (w === 'all' || dk <= todayKey)) {
          const t = totals[w];
          t.input += inp;
          t.output += out;
          t.cache_read += cache;
          t.thinking += think;
          t.calls += n;
          if (cost !== null) {
            t.est_cost_usd = (t.est_cost_usd ?? 0) + cost;
            if (isEst) t.cost_estimated = true;
          }
          convSets[w].add(convKey);
        }
      }

      let bm = byModel.get(model);
      if (!bm) {
        bm = {
          model, display_name: null, pool, input: 0, output: 0, cache_read: 0, thinking: 0,
          d7_tokens: 0, calls: 0, est_cost_usd: null, cost_estimated: false,
          periods: {},
        };
        for (const [w] of windows) {
          bm.periods[w] = {
            input: 0, output: 0, cache_read: 0, thinking: 0, calls: 0,
            est_cost_usd: null, cost_estimated: false, cost_partial: false,
          };
        }
        byModel.set(model, bm);
      }
      for (const [w, start] of windows) {
        if (dk >= start && (w === 'all' || dk <= todayKey)) {
          const pm = bm.periods[w];
          pm.input += inp;
          pm.output += out;
          pm.cache_read += cache;
          pm.thinking += think;
          pm.calls += n;
          if (parts !== null) {
            pm.est_cost_usd = (pm.est_cost_usd ?? 0) + cost;
            if (isEst) pm.cost_estimated = true;
            let pPoolMap = periodModelParts.get(pool);
            if (!pPoolMap) {
              pPoolMap = new Map();
              periodModelParts.set(pool, pPoolMap);
            }
            let pWinMap = pPoolMap.get(w);
            if (!pWinMap) {
              pWinMap = new Map();
              pPoolMap.set(w, pWinMap);
            }
            let pArr = pWinMap.get(model);
            if (!pArr) {
              pArr = [0, 0, 0];
              pWinMap.set(model, pArr);
            }
            pArr[0] += parts[0];
            pArr[1] += parts[1];
            pArr[2] += parts[2];
          } else {
            pm.cost_partial = true;
          }
        }
      }
      bm.input += inp;
      bm.output += out;
      bm.cache_read += cache;
      bm.thinking += think;
      if (inD7) bm.d7_tokens += inp + out;
      bm.calls += n;
      if (cost !== null) {
        bm.est_cost_usd = (bm.est_cost_usd ?? 0) + cost;
        if (isEst) bm.cost_estimated = true;
      }

      const slot = daily.get(dk);
      if (slot) {
        slot[0] += inp + out + cache;
        slot[1] += n;
      }
      if (dk === todayKey) {
        const hslot = hourlyToday[hour];
        hslot[0] += inp + out + cache;
        hslot[1] += n;
      }
    }
  }

  for (const [w] of windows) {
    const t = totals[w];
    t.conversations = convSets[w].size;
    if (t.est_cost_usd !== null) t.est_cost_usd = roundN(t.est_cost_usd, 4);
  }

  const models = Array.from(byModel.values());
  const calNames = new Map(names);
  for (const bm of models) {
    bm.display_name = names.get(bm.model) || catalogDisplay(bm.model, catalog);
    if (bm.display_name && !calNames.has(bm.model)) calNames.set(bm.model, bm.display_name);
    if (bm.est_cost_usd !== null) bm.est_cost_usd = roundN(bm.est_cost_usd, 4);
    for (const pm of Object.values(bm.periods)) {
      if (pm && pm.est_cost_usd !== null) pm.est_cost_usd = roundN(pm.est_cost_usd, 4);
    }
  }
  models.sort((a, b) => {
    const ta = a.input + a.output + a.cache_read;
    const tb = b.input + b.output + b.cache_read;
    if (tb !== ta) return tb - ta;
    return cmpCode(a.model, b.model);
  });

  const weeklyCyclesOut = { gemini: [], claude_gpt: [], other: [] };
  const weeklyValueOut = { gemini: null, claude_gpt: null, other: null };
  const quotaCalibrationOut = {};
  for (const [pk, list] of cycleAccum.entries()) {
    const poolSegments = [];
    for (let i = 0; i < Math.min(6, list.length); i += 1) {
      poolSegments.push(...list[i]._segments);
    }
    const cal = calibratePoolWeights(poolSegments, { modelNames: calNames });
    if (cal.calibrated) {
      const periodCostUsd = { today: 0, d7: 0, d30: 0, all: 0 };
      const modelPeriodCost = {};
      const pPoolMap = periodModelParts.get(pk);
      if (pPoolMap) {
        for (const [w] of windows) {
          const pWinMap = pPoolMap.get(w);
          if (!pWinMap) continue;
          let wSum = 0;
          for (const [m, pArr] of pWinMap) {
            const cVal = calibratedCallCost(cal, m, pArr[0], pArr[1], pArr[2]);
            wSum += cVal;
            if (!modelPeriodCost[m]) modelPeriodCost[m] = { today: 0, d7: 0, d30: 0, all: 0 };
            modelPeriodCost[m][w] = roundN(cVal, 6);
          }
          periodCostUsd[w] = roundN(wSum, 6);
        }
      }
      cal.period_cost_usd = periodCostUsd;
      cal.model_period_cost = modelPeriodCost;
    }
    quotaCalibrationOut[pk] = cal;

    const outList = list.map((cy, idx) => {
      const evalSegs = cy._segments.filter((s) => s.inEvalWindow);
      const { clean: evalClean, externalDelta: cyExtDelta } = filterExternalSegments(evalSegs);
      let effectiveUsed = cy.eval_used_fraction;
      let effectiveCost = cy.observed_cost_usd;
      let evalMap = cy._evalCostByModel;
      if (cyExtDelta > 0) {
        if (cy.valuation_method === 'delta') {
          effectiveUsed = roundN(evalClean.reduce((acc, s) => acc + s.delta, 0), 8);
          effectiveCost = evalClean.reduce((acc, s) => acc + s.costUsd, 0);
          evalMap = new Map();
          for (const s of evalClean) {
            for (const [m, mv] of s.costByModel) {
              let em = evalMap.get(m);
              if (!em) {
                em = { in: 0, out: 0, cache: 0, total: 0 };
                evalMap.set(m, em);
              }
              em.in += mv.in;
              em.out += mv.out;
              em.cache += mv.cache;
              em.total += mv.total;
            }
          }
        } else if (effectiveUsed > cyExtDelta) {
          effectiveUsed = roundN(effectiveUsed - cyExtDelta, 8);
        } else {
          effectiveUsed = 0;
        }
      }

      let evalCostForWeekly = effectiveCost;
      if (cal.calibrated && evalMap.size > 0) {
        evalCostForWeekly = 0;
        for (const [m, mv] of evalMap) {
          evalCostForWeekly += calibratedCallCost(cal, m, mv.in, mv.out, mv.cache);
        }
      }

      const valid = effectiveUsed >= cy._minUsedFraction && evalCostForWeekly > 0;
      const isCurrent = idx === 0 && (cy._startSec !== null
        ? (nowSec >= cy._startSec && nowSec < cy._endSec)
        : (nowSec < cy._endSec));
      return {
        cycle_start: cy.cycle_start,
        cycle_start_source: cy.cycle_start_source,
        cycle_duration_ms: cy.cycle_duration_ms,
        reset_time: cy.reset_time,
        ended_at: cy.ended_at || null,
        first_seen_at: cy.first_seen_at,
        observed_at: cy.observed_at,
        eval_start_at: cy.eval_start_at,
        eval_obs_at: cy.eval_obs_at,
        valuation_method: cy.valuation_method,
        remaining_fraction: cy.remaining_fraction,
        used_fraction: cy.used_fraction,
        eval_used_fraction: effectiveUsed,
        external_used_fraction: roundN(cyExtDelta, 8),
        saturated: cy.saturated,
        is_current: isCurrent,
        observed_cost_usd: roundN(effectiveCost, 4),
        cycle_cost_usd: roundN(cy.cycle_cost_usd, 4),
        observed_calls: cy.observed_calls,
        cycle_calls: cy.cycle_calls,
        weekly_value_usd: valid ? roundN(evalCostForWeekly / effectiveUsed, 2) : null,
        prev_weekly_value_usd: null,
        change_pct: null,
        cost_estimated: cy.cost_estimated,
        cost_partial: cy.cost_partial,
        plan: cy.plan,
        tier: cy.tier,
      };
    });
    for (let i = 0; i < outList.length; i += 1) {
      const curVal = outList[i].weekly_value_usd;
      if (!curVal || curVal <= 0) continue;
      for (let j = i + 1; j < outList.length; j += 1) {
        const prevVal = outList[j].weekly_value_usd;
        if (prevVal && prevVal > 0) {
          outList[i].prev_weekly_value_usd = prevVal;
          outList[i].change_pct = roundN(((curVal - prevVal) / prevVal) * 100, 1);
          break;
        }
      }
    }
    weeklyCyclesOut[pk] = outList;
    const latestValid = outList.find((x) => x.weekly_value_usd !== null && x.weekly_value_usd > 0);
    weeklyValueOut[pk] = latestValid ? latestValid.weekly_value_usd : null;
  }

  const anyCalibrated = Object.values(quotaCalibrationOut).some((q) => q && q.calibrated);
  if (anyCalibrated) {
    for (const c of convs) {
      const qbp = { ...c.cost_by_pool };
      const sumsByCalPool = new Map();
      for (const [m, cmp] of c._modelParts) {
        const [pk, cIn, cOut, cCache] = cmp;
        const cal = quotaCalibrationOut[pk];
        if (!cal || !cal.calibrated) continue;
        sumsByCalPool.set(pk, (sumsByCalPool.get(pk) || 0) + calibratedCallCost(cal, m, cIn, cOut, cCache));
      }
      for (const [pk, val] of sumsByCalPool) qbp[pk] = val;
      c._quotaCostByPool = qbp;
    }
  }

  const capped = buildConversationTree(convs, parentOf, cap, (id) => ({
    id,
    source: null,
    title: null,
    model: null,
    display_name: null,
    pool: 'other',
    first_at: null,
    last_at: null,
    input: 0,
    output: 0,
    cache_read: 0,
    thinking: 0,
    d7_tokens: 0,
    d7_by_pool: emptyPools(),
    cost_by_pool: emptyPools(),
    calls: 0,
    est_cost_usd: null,
    cost_partial: false,
    cost_estimated: false,
    is_subagent: false,
    archived: false,
    placeholder: true,
    by_model: [],
    _first: null,
    _last: -Infinity,
    _models: new Map(),
    _modelParts: new Map(),
    _first_input: null,
  }));
  for (const c of capped) {
    const cmodels = Array.from(c._models.values());
    for (const cm of cmodels) {
      cm.display_name = names.get(cm.model) || catalogDisplay(cm.model, catalog);
      if (cm.est_cost_usd !== null) cm.est_cost_usd = roundN(cm.est_cost_usd, 4);
    }
    let bestModel = cmodels[0] || null;
    for (let i = 1; i < cmodels.length; i += 1) {
      const m = cmodels[i];
      const mt = m.input + m.output + m.cache_read;
      const bt = bestModel.input + bestModel.output + bestModel.cache_read;
      if (mt > bt || (mt === bt && cmpCode(m.model, bestModel.model) > 0)) bestModel = m;
    }
    // A conversation with no calls of its own (only subagents) takes its
    // subtree's main model, so the row still says what did the work.
    c.model = bestModel ? bestModel.model : (c.total && c.total.model) || null;
    c.display_name = c.model ? names.get(c.model) || catalogDisplay(c.model, catalog) : null;

    const primaryPool = poolCache.get(c.model) || modelPool(c.model, catalog);
    c.pool = dominantPool(primaryPool, c.cost_by_pool, c.total && c.total.cost_by_pool, c.d7_by_pool);

    cmodels.sort((a, b) => {
      const ta = a.input + a.output;
      const tb = b.input + b.output;
      if (tb !== ta) return tb - ta;
      return cmpCode(a.model, b.model);
    });
    c.by_model = cmodels;

    const agent = agents.get(c.id) || null;
    c.agent = agent;
    c.is_subagent = Boolean(c.parent_id) || Boolean(agent);
    c.title = titles.get(c.id) || c._first_input || (agent && agent !== 'self' ? `@${agent}` : null);
    if (c.total) {
      const tot = c.total;
      if (tot.est_cost_usd !== null) tot.est_cost_usd = roundN(tot.est_cost_usd, 4);
      for (const pk of Object.keys(tot.cost_by_pool)) tot.cost_by_pool[pk] = roundN(tot.cost_by_pool[pk], 6);
      if (tot.quota_cost_by_pool) {
        for (const pk of Object.keys(tot.quota_cost_by_pool)) tot.quota_cost_by_pool[pk] = roundN(tot.quota_cost_by_pool[pk], 6);
      }
      tot.last_at = formatLocalIso(tot._last);
      delete tot._last;
      delete tot.model;
    }
    c.first_at = formatLocalIso(c._first);
    c.last_at = formatLocalIso(c._last);
    if (c.est_cost_usd !== null) c.est_cost_usd = roundN(c.est_cost_usd, 4);
    for (const pk of Object.keys(c.cost_by_pool)) c.cost_by_pool[pk] = roundN(c.cost_by_pool[pk], 6);
    delete c._first;
    delete c._last;
    delete c._models;
    delete c._modelParts;
    delete c._quotaCostByPool;
    delete c._first_input;
  }

  const dailyOut = Array.from(daily.keys())
    .sort(cmpCode)
    .map((date) => {
      const [tokens, calls] = daily.get(date);
      return { date, tokens, calls };
    });

  return {
    totals,
    by_model: models,
    by_conversation: capped,
    daily: dailyOut,
    hourly_today: hourlyToday.map(([tokens, calls], hour) => ({ hour, tokens, calls })),
    d7_by_pool: d7ByPool,
    weekly_cycles: weeklyCyclesOut,
    weekly_value_usd: weeklyValueOut,
    quota_calibration: quotaCalibrationOut,
    pricing_source: pricingSource,
    pricing_fetched_at: pricingFetchedAt,
    sources,
    archived_conversations: archivedCount,
    errors,
    scanned_at: formatLocalIso(Date.now() / 1000),
    elapsed_ms: Math.trunc(performance.now() - t0),
  };
}

// --- CLI ---------------------------------------------------------------------

export async function cliMain(argv) {
  let cachePath = null;
  let days = 365;
  let pricingFile = null;
  let modelCatalogPath = null;
  const rawRoots = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') continue;
    if (a === '--cache' && i + 1 < argv.length) cachePath = argv[++i];
    else if (a === '--days' && i + 1 < argv.length) days = parseInt(argv[++i], 10) || 365;
    else if (a === '--pricing-file' && i + 1 < argv.length) pricingFile = argv[++i];
    else if (a === '--model-catalog' && i + 1 < argv.length) modelCatalogPath = argv[++i];
    else if (a === '--root' && i + 1 < argv.length) rawRoots.push(argv[++i]);
  }
  const roots = rawRoots.length ? rawRoots.map(parseRoot) : defaultRoots();
  const report = await scan(roots, { cachePath, days, pricingFile, modelCatalogPath });
  process.stdout.write(`${JSON.stringify(report)}\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cliMain(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
