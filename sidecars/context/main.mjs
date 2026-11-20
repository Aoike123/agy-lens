// Sidecar backend for the Context Usage panel.
//
// Serves the panel (index.html, styles.css, app.js) and:
// - /api/report   runs context_report.py (the same parser as the /context skill)
//                 on the open conversation's database. The model's context
//                 window and display name come from the app's live model
//                 catalog (GetAvailableModels), like the agy CLI.
// - /api/quota    model quota pools from the app's language server
//                 (GetUserStatus / GetAvailableModels).
// - /api/history  token usage across all conversations (history_scanner.py).
//
// The only channel to the language server is lsRequest(), which uses the
// address and CSRF token the app hands the sidecar in its environment.
//
// Pure helpers are exported for tests. Set CONTEXT_PANEL_NO_SERVER=1 to import
// this module without starting the sidecar server.

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'context_report.py');
const HISTORY_SCRIPT = join(HERE, 'history_scanner.py');
const GEMINI_DIR = process.env.ANTIGRAVITY_GEMINI_DIR || join(homedir(), '.gemini');
const CONVERSATIONS = join(GEMINI_DIR, 'antigravity', 'conversations');
const DATA_DIR = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR || join(HERE, '.data');
const CATALOG_PATH = join(DATA_DIR, 'model-catalog.json');
const CATALOG_TTL_MS = 10 * 60 * 1000;
const QUOTA_RAW_PATH = join(DATA_DIR, 'quota-raw.json');
const QUOTA_TTL_MS = 60 * 1000;
const HISTORY_CACHE_PATH = join(DATA_DIR, 'history-cache.json');
const HISTORY_TTL_MS = 60 * 1000;
const HISTORY_TIMEOUT_MS = 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LS_METADATA = { ideName: 'antigravity', extensionName: 'antigravity' };

// GET query parameters arrive as strings; JSON bodies as booleans.
export function truthy(v) {
  return v === true || v === 1 || (typeof v === 'string' && /^(1|true|yes)$/i.test(v.trim()));
}

// --- python -------------------------------------------------------------------

const PYTHON_CANDIDATES = process.platform === 'win32'
  ? [['python', []], ['py', ['-3']], ['python3', []]]
  : [['python3', []], ['python', []]];
let python = null;

function run(cmd, args, timeout = 20000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, {
      timeout,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      windowsHide: true,
    }, (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout)));
  });
}

async function findPython() {
  if (python) return python;
  for (const [cmd, pre] of PYTHON_CANDIDATES) {
    try {
      const out = await run(cmd, [...pre, '--version'], 5000);
      if (/^Python 3\./.test(out.trim())) {
        python = { cmd, pre };
        return python;
      }
    } catch { /* try the next candidate */ }
  }
  throw new Error('Python 3 not found. Install it from python.org and restart Antigravity.');
}

// --- language server ----------------------------------------------------------

let catalogFetchedAt = 0;

function lsRequest(method, body) {
  const addr = (process.env.ANTIGRAVITY_LS_ADDRESS || '').trim();
  const csrf = (process.env.ANTIGRAVITY_CSRF_TOKEN || '').trim();
  if (!addr || !csrf) {
    const err = new Error('no language server address');
    err.code = 'NO_LS';
    return Promise.reject(err);
  }
  const base = new URL(addr.startsWith('http') ? addr : `http://${addr}`);
  const data = JSON.stringify(body);
  const transport = base.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request({
      hostname: base.hostname,
      port: base.port,
      path: `/exa.language_server_pb.LanguageServerService/${method}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
        'x-codeium-csrf-token': csrf,
        'Content-Length': Buffer.byteLength(data),
      },
      timeout: 5000,
      rejectUnauthorized: false,
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`${method}: HTTP ${res.statusCode}`));
          return;
        }
        try { resolve(JSON.parse(text)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`${method}: timeout`)));
    req.on('error', reject);
    req.end(data);
  });
}

async function refreshCatalog() {
  if (Date.now() - catalogFetchedAt < CATALOG_TTL_MS && existsSync(CATALOG_PATH)) return;
  catalogFetchedAt = Date.now();
  try {
    const resp = await lsRequest('GetAvailableModels', { metadata: LS_METADATA });
    const models = resp?.response?.models || resp?.models || {};
    const catalog = {};
    for (const [id, m] of Object.entries(models)) {
      const maxTokens = Number(m?.maxTokens) || 0;
      if (maxTokens > 0) catalog[id] = { maxTokens, displayName: m.displayName || '' };
    }
    if (Object.keys(catalog).length) {
      mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(CATALOG_PATH, JSON.stringify(catalog));
    }
  } catch (err) {
    console.error('[context] model catalog unavailable, using built-in limits:', err.message);
  }
}

// --- quota --------------------------------------------------------------------

const SECRET_KEY = /token|secret|password|passwd|auth|cookie|session|credential|api_?key|email|csrf/i;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const JWT_LIKE = /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+|\bya29\.[A-Za-z0-9._~+/=-]+/g;

// Deep copy with emails, token-like strings and secret-named string fields
// replaced, for the debugging dump.
export function redact(value, key = '') {
  if (Array.isArray(value)) return value.map((v) => redact(v, key));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redact(v, k);
    return out;
  }
  if (typeof value === 'string') {
    if (SECRET_KEY.test(key)) return '[redacted]';
    return value.replace(EMAIL, '[email]').replace(BEARER, '[redacted]').replace(JWT_LIKE, '[redacted]');
  }
  return value;
}

function pick(obj, ...keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  return undefined;
}

function toFraction(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(1, Math.max(0, n));
}

function toIso(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'object') {
    // protobuf Timestamp as an object {seconds, nanos}
    const s = Number(v.seconds);
    if (!Number.isFinite(s)) return null;
    return new Date(s * 1000 + Math.floor((Number(v.nanos) || 0) / 1e6)).toISOString();
  }
  if (typeof v === 'number' || /^\d+(\.\d+)?$/.test(String(v))) {
    const n = Number(v);
    const d = new Date(n < 1e12 ? n * 1000 : n); // seconds or milliseconds
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Normalizes one model-like entry to {id, display_name, quota} where quota is
// {remaining_fraction, reset_time} or null when the entry has no quota info.
function modelEntry(m, key) {
  if (!m || typeof m !== 'object') return null;
  const alias = pick(m, 'modelOrAlias', 'model_or_alias');
  const id = String(
    (typeof key === 'string' && key) ||
    pick(alias, 'model', 'alias') ||
    (typeof m.model === 'string' ? m.model : undefined) ||
    pick(m, 'modelId', 'model_id', 'id', 'name', 'label') || ''
  );
  if (!id) return null;
  const display = String(pick(m, 'displayName', 'display_name', 'label', 'name') || id);
  const q = pick(m, 'quotaInfo', 'quota_info', 'quota');
  let quota = null;
  if (q && typeof q === 'object') {
    const reset = toIso(pick(q, 'resetTime', 'reset_time', 'resetAt'));
    let frac = toFraction(pick(q, 'remainingFraction', 'remaining_fraction', 'fractionRemaining'));
    // proto3 JSON omits zero values: quota info with a reset time but no
    // fraction means the quota is used up.
    if (frac === null && reset) frac = 0;
    quota = { remaining_fraction: frac, reset_time: reset };
  }
  return { id, display_name: display, quota };
}

function listModels(resp) {
  const out = [];
  if (!resp || typeof resp !== 'object') return out;
  const root = resp.response && typeof resp.response === 'object' ? resp.response : resp;
  const collect = (container) => {
    if (Array.isArray(container)) container.forEach((m) => { const e = modelEntry(m); if (e) out.push(e); });
    else if (container && typeof container === 'object') {
      for (const [k, m] of Object.entries(container)) { const e = modelEntry(m, k); if (e) out.push(e); }
    }
  };
  collect(root.models);
  const status = pick(root, 'userStatus', 'user_status') || root;
  const cfg = pick(status, 'cascadeModelConfigData', 'cascade_model_config_data');
  collect(pick(cfg, 'clientModelConfigs', 'client_model_configs'));
  collect(pick(status, 'clientModelConfigs', 'client_model_configs'));
  return out;
}

function findPlan(resp) {
  if (!resp || typeof resp !== 'object') return null;
  const root = resp.response && typeof resp.response === 'object' ? resp.response : resp;
  const status = pick(root, 'userStatus', 'user_status') || root;
  const planStatus = pick(status, 'planStatus', 'plan_status');
  const planInfo = pick(planStatus, 'planInfo', 'plan_info') || pick(status, 'planInfo', 'plan_info');
  const tier = pick(status, 'userTier', 'user_tier');
  const name = pick(planInfo, 'planName', 'plan_name', 'teamsTier', 'teams_tier', 'name') ||
    (typeof tier === 'string' ? tier : pick(tier, 'name', 'id')) ||
    pick(status, 'planName', 'plan_name', 'tier');
  return name ? String(name) : null;
}

function poolLabel(models) {
  const names = models.map((m) => m.display_name);
  if (names.length <= 2) return names.join(' / ');
  return `${names[0]} +${names.length - 1}`;
}

// Builds the /api/quota payload (without fetched_at) from the raw responses of
// GetUserStatus and GetAvailableModels (either may be null).
export function parseQuota(statusResp, modelsResp) {
  const byId = new Map();
  for (const e of [...listModels(modelsResp), ...listModels(statusResp)]) {
    const prev = byId.get(e.id);
    if (!prev) { byId.set(e.id, e); continue; }
    if (!prev.quota && e.quota) prev.quota = e.quota;
    if (prev.display_name === prev.id && e.display_name !== e.id) prev.display_name = e.display_name;
  }
  const groups = new Map();
  for (const m of byId.values()) {
    if (!m.quota) continue;
    const key = `${m.quota.remaining_fraction}|${m.quota.reset_time}`;
    if (!groups.has(key)) groups.set(key, { ...m.quota, models: [] });
    groups.get(key).models.push({ id: m.id, display_name: m.display_name });
  }
  const pools = [...groups.values()].map((g) => {
    g.models.sort((a, b) => a.display_name.localeCompare(b.display_name));
    return {
      id: g.models.map((m) => m.id).sort()[0],
      label: poolLabel(g.models),
      remaining_fraction: g.remaining_fraction,
      reset_time: g.reset_time,
      models: g.models,
    };
  });
  pools.sort((a, b) => {
    const fa = a.remaining_fraction ?? Infinity;
    const fb = b.remaining_fraction ?? Infinity;
    return fa - fb || a.label.localeCompare(b.label);
  });
  return { pools, plan: findPlan(statusResp) ?? findPlan(modelsResp) };
}

let quotaCache = null; // { at, result }
let quotaInFlight = null;
let quotaRawWritten = false;

async function fetchQuota() {
  const fetched_at = new Date().toISOString();
  const body = { metadata: LS_METADATA };
  const [status, models] = await Promise.allSettled([
    lsRequest('GetUserStatus', body),
    lsRequest('GetAvailableModels', body),
  ]);
  const statusResp = status.status === 'fulfilled' ? status.value : null;
  const modelsResp = models.status === 'fulfilled' ? models.value : null;
  if (!statusResp && !modelsResp) {
    const reason = status.reason || models.reason;
    const noLs = status.reason?.code === 'NO_LS';
    return { pools: [], plan: null, fetched_at, error: noLs ? 'unavailable' : 'failed', message: reason?.message || 'request failed' };
  }
  if (!quotaRawWritten) {
    quotaRawWritten = true;
    try {
      mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(QUOTA_RAW_PATH, JSON.stringify(redact({
        written_at: fetched_at,
        GetUserStatus: statusResp ?? { error: status.reason?.message },
        GetAvailableModels: modelsResp ?? { error: models.reason?.message },
      }), null, 2));
    } catch (err) {
      console.error('[context] could not write quota-raw.json:', err.message);
    }
  }
  const parsed = parseQuota(statusResp, modelsResp);
  const result = { ...parsed, fetched_at };
  if (!parsed.pools.length) {
    result.error = 'unavailable';
    result.message = 'The language server did not report any model quota.';
  }
  return result;
}

async function quota(refresh) {
  if (!refresh && quotaCache && Date.now() - quotaCache.at < QUOTA_TTL_MS) return quotaCache.result;
  if (!quotaInFlight) {
    quotaInFlight = fetchQuota()
      .then((result) => {
        // Errors are cached for the same TTL so a broken LS isn't hammered;
        // refresh:true bypasses the cache.
        quotaCache = { at: Date.now(), result };
        return result;
      })
      .finally(() => { quotaInFlight = null; });
  }
  return quotaInFlight;
}

// --- history ------------------------------------------------------------------

let historyCache = null; // { at, result }
let historyInFlight = null;

async function scanHistory() {
  const { cmd, pre } = await findPython();
  mkdirSync(DATA_DIR, { recursive: true });
  const out = await run(cmd, [...pre, HISTORY_SCRIPT, '--json', '--cache', HISTORY_CACHE_PATH], HISTORY_TIMEOUT_MS);
  return JSON.parse(out);
}

async function history(refresh) {
  if (!refresh && historyCache && Date.now() - historyCache.at < HISTORY_TTL_MS) return historyCache.result;
  if (!historyInFlight) {
    historyInFlight = scanHistory()
      .then((result) => {
        historyCache = { at: Date.now(), result };
        return result;
      })
      .finally(() => { historyInFlight = null; });
  }
  return historyInFlight;
}

// --- report -------------------------------------------------------------------

const cache = new Map(); // conversationId -> { key, report }

function workspacePath(uri) {
  if (!uri || !uri.startsWith('file:')) return '';
  let p = decodeURIComponent(uri.replace(/^file:\/\//, ''));
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
  return p;
}

function fileStamp(path) {
  try {
    const s = statSync(path);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return '-';
  }
}

async function report(conversationId, workspaceUri) {
  if (!UUID.test(conversationId || '')) {
    return { error: 'no-conversation' };
  }
  const db = join(CONVERSATIONS, `${conversationId}.db`);
  if (!existsSync(db)) {
    return { error: 'no-database' };
  }
  await refreshCatalog();
  const workspace = workspacePath(workspaceUri);
  const key = [fileStamp(db), fileStamp(`${db}-wal`), workspace, fileStamp(CATALOG_PATH)].join('|');
  const cached = cache.get(conversationId);
  if (cached && cached.key === key) return cached.report;

  const { cmd, pre } = await findPython();
  const args = [...pre, SCRIPT, '--db', db, '--json'];
  if (existsSync(CATALOG_PATH)) args.push('--model-catalog', CATALOG_PATH);
  if (workspace) args.push('--workspace', workspace);
  const out = await run(cmd, args);
  const result = { ...JSON.parse(out), updatedAt: new Date().toISOString() };
  cache.set(conversationId, { key, report: result });
  return result;
}

// --- server -------------------------------------------------------------------

if (!process.env.CONTEXT_PANEL_NO_SERVER) {
  const { Response, SidecarApp } = await import('sidecar_sdk');
  const app = new SidecarApp();

  const STATIC = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
    '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
  };
  for (const [path, [file, contentType]] of Object.entries(STATIC)) {
    app.page(path, () => {
      try {
        return new Response(readFileSync(join(HERE, file), 'utf8'), {
          contentType,
          headers: { 'Cache-Control': 'no-cache' },
        });
      } catch {
        return new Response('Not found', { status: 404 });
      }
    });
  }

  app.api('/api/report', async (data) => {
    try {
      return await report(data.conversationId, data.workspace);
    } catch (err) {
      return { error: 'failed', message: err.message };
    }
  }, 'GET');

  app.api('/api/quota', async (data) => {
    try {
      return await quota(truthy(data?.refresh));
    } catch (err) {
      return { pools: [], plan: null, fetched_at: new Date().toISOString(), error: 'failed', message: err.message };
    }
  }, 'GET');

  app.api('/api/history', async (data) => {
    try {
      return await history(truthy(data?.refresh));
    } catch (err) {
      return { error: 'failed', message: err.message };
    }
  }, 'GET');

  app.run();
  refreshCatalog();
}
