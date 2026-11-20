// Sidecar backend for the Context Usage panel.
//
// Serves the panel (index.html, styles.css, app.js) and:
// - /api/report   runs context_report.py (the same parser as the /context skill)
//                 on the open conversation's database. The model's context
//                 window and display name come from the app's live model
//                 catalog (GetAvailableModels), like the agy CLI.
// - /api/quota    model quota pools from the app's language server
//                 (GetUserStatus / GetAvailableModels / RetrieveUserQuotaSummary).
// - /api/history  token usage across all conversations (history_scanner.py).
// - /api/pricing  opt-in public model pricing sync (LiteLLM / OpenRouter,
//                 cached 24h in DATA_DIR/pricing-cache.json).
//
// The only channel to the language server is lsRequest(), which uses the
// address and CSRF token the app hands the sidecar in its environment.
//
// Pure helpers are exported for tests. Set CONTEXT_PANEL_NO_SERVER=1 to import
// this module without starting the sidecar server.

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
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
const PRICING_PATH = join(DATA_DIR, 'pricing-cache.json');
const PRICING_TTL_MS = 24 * 60 * 60 * 1000;
const PRICING_TIMEOUT_MS = 10 * 1000;
const PRICING_MAX_BYTES = 20 * 1024 * 1024;
const PRICING_LITELLM_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const PRICING_OPENROUTER_URL = 'https://openrouter.ai/api/v1/models';
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

// Deep copy with emails, token-like strings, secret-named string fields and
// personal profile fields replaced, for the debugging dump.
const PERSONAL_KEY = /picture|avatar|photo/i;
const PERSON_PARENT = /^(userStatus|user_status|user|profile|account)$/;
export function redact(value, key = '', parent = '') {
  if (Array.isArray(value)) return value.map((v) => redact(v, key, parent));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redact(v, k, key);
    return out;
  }
  if (typeof value === 'string') {
    if (SECRET_KEY.test(key) || PERSONAL_KEY.test(key)) return '[redacted]';
    if (/^(name|displayName|display_name)$/.test(key) && PERSON_PARENT.test(parent)) return '[redacted]';
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

function rootOf(resp) {
  if (!resp || typeof resp !== 'object' || Array.isArray(resp)) return null;
  return resp.response && typeof resp.response === 'object' ? resp.response : resp;
}

function statusOf(resp) {
  const root = rootOf(resp);
  return root ? (pick(root, 'userStatus', 'user_status') || root) : null;
}

function modelConfigData(resp) {
  return pick(statusOf(resp), 'cascadeModelConfigData', 'cascade_model_config_data');
}

function asList(container) {
  if (Array.isArray(container)) return container.map((m) => [undefined, m]);
  if (container && typeof container === 'object') return Object.entries(container);
  return [];
}

// Normalizes one model-like entry to {id, display_name, provider, quota} where
// quota is {remaining_fraction, reset_time} or null when it has no quota info.
// display_name is null when the server gives none (internal models).
function modelEntry(m, key) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  const alias = pick(m, 'modelOrAlias', 'model_or_alias');
  const id = String(
    (typeof key === 'string' && key) ||
    pick(m, 'modelId', 'model_id') ||
    pick(alias, 'model', 'alias') ||
    (typeof m.model === 'string' ? m.model : undefined) ||
    pick(m, 'id', 'name', 'label') || ''
  );
  if (!id) return null;
  const display = pick(m, 'displayName', 'display_name', 'label');
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
  const provider = pick(m, 'modelProvider', 'model_provider');
  return { id, display_name: display ? String(display) : null, provider: provider ? String(provider) : '', quota };
}

function listModels(resp) {
  const out = [];
  const root = rootOf(resp);
  if (!root) return out;
  const add = (container) => {
    for (const [k, m] of asList(container)) { const e = modelEntry(m, k); if (e) out.push(e); }
  };
  add(root.models);
  add(pick(modelConfigData(resp), 'clientModelConfigs', 'client_model_configs'));
  add(pick(statusOf(resp), 'clientModelConfigs', 'client_model_configs'));
  return out;
}

// Model IDs the app's model picker shows, in picker order.
function visibleModelIds(statusResp, modelsResp) {
  const ids = new Set();
  for (const resp of [modelsResp, statusResp]) {
    const root = rootOf(resp);
    for (const sort of asList(pick(root, 'agentModelSorts', 'agent_model_sorts')).map(([, s]) => s)) {
      for (const g of asList(pick(sort, 'groups')).map(([, x]) => x)) {
        for (const [, id] of asList(pick(g, 'modelIds', 'model_ids'))) if (typeof id === 'string') ids.add(id);
      }
    }
  }
  for (const resp of [statusResp, modelsResp]) {
    for (const [, c] of asList(pick(modelConfigData(resp), 'clientModelConfigs', 'client_model_configs'))) {
      const id = pick(c, 'modelId', 'model_id');
      if (typeof id === 'string') ids.add(id);
    }
  }
  return ids;
}

// groupedModels: family id -> {display_name, levels: [{suffix, display}]}
function modelFamilies(statusResp, modelsResp) {
  const fams = new Map();
  for (const resp of [modelsResp, statusResp]) {
    for (const src of [pick(rootOf(resp), 'groupedModels', 'grouped_models'), pick(modelConfigData(resp), 'groupedModels', 'grouped_models')]) {
      if (!src || typeof src !== 'object' || Array.isArray(src)) continue;
      for (const [fid, g] of Object.entries(src)) {
        if (fams.has(fid) || !g || typeof g !== 'object') continue;
        const levels = asList(pick(g, 'supportedThinkingLevels', 'supported_thinking_levels'))
          .map(([, l]) => ({ suffix: String(pick(l, 'thinkingSuffix', 'thinking_suffix') || ''), display: String(pick(l, 'thinkingDisplayName', 'thinking_display_name') || '') }))
          .filter((l) => l.suffix);
        fams.set(fid, { display_name: String(pick(g, 'displayName', 'display_name') || fid), levels });
      }
    }
  }
  return fams;
}

function familyOf(fams, id) {
  for (const [fid, f] of fams) {
    if (id === fid) return { fid, f, level: null };
    for (const l of f.levels) if (id === `${fid}-${l.suffix}`) return { fid, f, level: l.display || l.suffix };
  }
  return null;
}

const PROVIDER_ORDER = ['Gemini', 'Claude', 'GPT-OSS', 'OpenAI'];

function providerName(m) {
  const p = m.provider.toUpperCase();
  const text = `${m.id} ${m.display_name || ''}`.toLowerCase();
  if (p.includes('ANTHROPIC') || /claude/.test(text)) return 'Claude';
  if (/gpt-oss|gpt_oss/.test(text)) return 'GPT-OSS';
  if (p.includes('OPENAI') || /\bgpt/.test(text)) return 'OpenAI';
  if (p.includes('GOOGLE') || /gemini/.test(text)) return 'Gemini';
  return null;
}

function isTabModel(m) {
  return /^tab[_-]/i.test(m.id);
}

const HOUR = 3600 * 1000;
const SLACK = 2 * 60 * 1000;
const LIMIT_LABELS = {
  '5h': ['5-hour limit', '5 小时限额'],
  daily: ['Daily limit', '每日限额'],
  weekly: ['Weekly limit', '每周限额'],
  none: ['Unlimited · no reset', '不限 · 无重置'],
  unknown: ['Quota', '额度'],
};
const LIMIT_ORDER = { weekly: 0, '5h': 1, daily: 2, unknown: 3, none: 4 };
const SUMMARY_POOL_LABELS = {
  gemini: ['Gemini models', 'Gemini 模型'],
  claude_gpt: ['Claude / GPT-OSS models', 'Claude / GPT-OSS 模型'],
  other: ['Other models', '其他模型'],
};

// The LS reports no window length, so the limit kind is inferred from the
// time left until reset (a rolling 5-hour window never resets later than 5h
// from now).
export function inferLimit(remaining_fraction, reset_time, now = Date.now()) {
  let kind = 'unknown';
  if (!reset_time) {
    if (remaining_fraction === 1) kind = 'none';
  } else {
    const dt = Date.parse(reset_time) - now;
    if (dt >= 0 && dt <= 5 * HOUR + SLACK) kind = '5h';
    else if (dt > 0 && dt <= 24 * HOUR + SLACK) kind = 'daily';
    else if (dt > 0 && dt <= 7 * 24 * HOUR + SLACK) kind = 'weekly';
  }
  const [label, label_zh] = LIMIT_LABELS[kind];
  return { kind, inferred: kind !== 'unknown', label, label_zh, remaining_fraction, reset_time };
}

function summaryCategory(bucketId, groupName) {
  for (const raw of [bucketId, groupName]) {
    const text = String(raw || '').toLowerCase();
    if (!text) continue;
    if (/gemini|google/.test(text)) return 'gemini';
    if (/(?:^|[^a-z0-9])3p(?:$|[^a-z0-9])|claude|gpt|third/.test(text)) return 'claude_gpt';
  }
  return 'other';
}

function summaryLimitKind(bucketId, displayName) {
  const text = `${bucketId || ''} ${displayName || ''}`.toLowerCase();
  if (/weekly|(?:^|[^a-z0-9])7[-_\s]?d(?:ay)?s?(?:$|[^a-z0-9])/.test(text)) return 'weekly';
  if (/(?:^|[^a-z0-9])(?:5[-_\s]?h(?:our)?s?|five)(?:$|[^a-z0-9])/.test(text)) return '5h';
  if (/daily|(?:^|[^a-z0-9])24[-_\s]?h(?:our)?s?(?:$|[^a-z0-9])/.test(text)) return 'daily';
  return null;
}

function sortLimits(limits) {
  return limits.slice().sort((a, b) => (LIMIT_ORDER[a.kind] ?? 9) - (LIMIT_ORDER[b.kind] ?? 9));
}

function mergeLimitLists(existing, incoming) {
  const byKind = new Map();
  const hasExplicitIncoming = incoming.some((l) => !l.inferred);
  for (const l of existing) {
    if (hasExplicitIncoming && l.inferred && (l.kind === 'none' || l.kind === 'unknown')) continue;
    byKind.set(l.kind, l);
  }
  for (const l of incoming) {
    const prev = byKind.get(l.kind);
    if (!prev) { byKind.set(l.kind, l); continue; }
    if (prev.inferred && !l.inferred) { byKind.set(l.kind, l); continue; }
    if (prev.inferred === l.inferred && prev.remaining_fraction === null && l.remaining_fraction !== null) {
      byKind.set(l.kind, l);
    }
  }
  return sortLimits([...byKind.values()]);
}

// Parses RetrieveUserQuotaSummary defensively across response.groups,
// quotaSummary.groups, groups, or top-level buckets.
export function parseQuotaSummary(summaryResp, now = Date.now()) {
  const byCategory = {};
  const weekly = {};
  const root = rootOf(summaryResp);
  if (!root) return { byCategory, weekly };
  const container = pick(root, 'quotaSummary', 'quota_summary') || root;
  const groups = pick(container, 'groups', 'quotaGroups', 'quota_groups');
  const topBuckets = pick(container, 'buckets', 'quotaBuckets', 'quota_buckets');

  const bucketPairs = [];
  if (Array.isArray(groups)) {
    for (const g of groups) {
      if (!g || typeof g !== 'object') continue;
      const gName = pick(g, 'displayName', 'display_name', 'name', 'groupId', 'group_id', 'id');
      const bs = pick(g, 'buckets', 'quotaBuckets', 'quota_buckets');
      if (Array.isArray(bs)) {
        for (const b of bs) bucketPairs.push([b, gName ? String(gName) : '']);
      }
    }
  }
  if (Array.isArray(topBuckets)) {
    for (const b of topBuckets) bucketPairs.push([b, '']);
  }

  for (const [b, groupName] of bucketPairs) {
    if (!b || typeof b !== 'object' || Array.isArray(b)) continue;
    const bucketId = pick(b, 'bucketId', 'bucket_id', 'id');
    const displayName = pick(b, 'displayName', 'display_name', 'label', 'name');
    const q = pick(b, 'quotaInfo', 'quota_info', 'quota') || b;
    const reset = toIso(pick(q, 'resetTime', 'reset_time', 'resetAt'));
    let frac = toFraction(pick(q, 'remainingFraction', 'remaining_fraction', 'fractionRemaining'));
    if (frac === null && reset) frac = 0;
    if (frac === null && !reset) continue;

    const category = summaryCategory(bucketId, groupName || displayName);
    const explicitKind = summaryLimitKind(bucketId, displayName);
    const limit = explicitKind
      ? {
          kind: explicitKind,
          inferred: false,
          label: LIMIT_LABELS[explicitKind][0],
          label_zh: LIMIT_LABELS[explicitKind][1],
          remaining_fraction: frac,
          reset_time: reset,
        }
      : { ...inferLimit(frac, reset, now), inferred: true };

    if (!byCategory[category]) {
      const [defEn, defZh] = SUMMARY_POOL_LABELS[category] || SUMMARY_POOL_LABELS.other;
      const label = category === 'other' && groupName ? groupName : defEn;
      const label_zh = category === 'other' && groupName ? groupName : defZh;
      byCategory[category] = { category, label, label_zh, limits: [] };
    }
    byCategory[category].limits = mergeLimitLists(byCategory[category].limits, [limit]);
  }

  for (const [cat, entry] of Object.entries(byCategory)) {
    const wk = entry.limits.find((l) => l.kind === 'weekly' && l.remaining_fraction !== null);
    if (wk) weekly[cat] = { remaining_fraction: wk.remaining_fraction, reset_time: wk.reset_time };
  }
  return { byCategory, weekly };
}

function findPlan(resp) {
  const status = statusOf(resp);
  if (!status) return null;
  const planStatus = pick(status, 'planStatus', 'plan_status');
  const planInfo = pick(planStatus, 'planInfo', 'plan_info') || pick(status, 'planInfo', 'plan_info');
  const name = pick(planInfo, 'planName', 'plan_name', 'teamsTier', 'teams_tier', 'name') ||
    pick(status, 'planName', 'plan_name');
  return name ? String(name) : null;
}

function findTier(resp) {
  const tier = pick(statusOf(resp), 'userTier', 'user_tier');
  const name = typeof tier === 'string' ? tier : pick(tier, 'name', 'id');
  return name ? String(name) : null;
}

function dedupeByName(models, exclude = new Set()) {
  const seen = new Set(exclude);
  const out = [];
  for (const m of models) {
    const name = m.display_name || m.id;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ id: m.id, display_name: name });
  }
  return out;
}

// Builds the /api/quota payload (without fetched_at) from the raw responses of
// GetUserStatus, GetAvailableModels and RetrieveUserQuotaSummary (any may be null).
export function parseQuota(statusResp, modelsResp, now = Date.now(), summaryResp = null) {
  const byId = new Map();
  for (const e of [...listModels(modelsResp), ...listModels(statusResp)]) {
    const prev = byId.get(e.id);
    if (!prev) { byId.set(e.id, e); continue; }
    if (!prev.quota && e.quota) prev.quota = e.quota;
    if (!prev.display_name && e.display_name) prev.display_name = e.display_name;
    if (!prev.provider && e.provider) prev.provider = e.provider;
  }
  const visible = visibleModelIds(statusResp, modelsResp);
  const hasPicker = visible.size > 0;
  const isVisible = (m) => (hasPicker ? visible.has(m.id) : !!m.display_name && !isTabModel(m));
  const order = [...visible];
  const rank = (m) => { const i = order.indexOf(m.id); return i < 0 ? Infinity : i; };
  const fams = modelFamilies(statusResp, modelsResp);

  const groups = new Map();
  for (const m of byId.values()) {
    if (!m.quota) continue;
    const tab = isTabModel(m);
    const key = `${tab ? 'tab' : 'm'}|${m.quota.remaining_fraction}|${m.quota.reset_time}`;
    if (!groups.has(key)) groups.set(key, { tab, ...m.quota, members: [] });
    groups.get(key).members.push(m);
  }

  const usedIds = new Map();
  const pools = [...groups.values()].map((g) => {
    const members = g.members.slice().sort((a, b) => rank(a) - rank(b) || (a.display_name || a.id).localeCompare(b.display_name || b.id));
    const shown = members.filter(isVisible);
    const models = dedupeByName(shown);
    const hidden_models = dedupeByName(members.filter((m) => !isVisible(m)), new Set(models.map((m) => m.display_name)));

    const families = [];
    const famIndex = new Map();
    for (const m of shown) {
      const fam = familyOf(fams, m.id);
      const fkey = fam ? `f:${fam.fid}` : `n:${m.display_name || m.id}`;
      if (!famIndex.has(fkey)) {
        famIndex.set(fkey, families.length);
        families.push(fam
          ? { id: fam.fid, display_name: fam.f.display_name, levels: [] }
          : { id: m.id, display_name: m.display_name || m.id, levels: [] });
      }
      const entry = families[famIndex.get(fkey)];
      if (fam?.level && !entry.levels.includes(fam.level)) entry.levels.push(fam.level);
    }

    let kind = 'models';
    let label;
    let label_zh;
    let slug;
    if (g.tab) {
      kind = 'tab';
      label = 'Tab completion';
      label_zh = 'Tab 补全';
      slug = 'tab';
    } else {
      const provs = new Set((shown.length ? shown : members).map(providerName).filter(Boolean));
      const names = [...provs].sort((a, b) => PROVIDER_ORDER.indexOf(a) - PROVIDER_ORDER.indexOf(b));
      if (names.length) {
        label = `${names.join(' / ')} models`;
        label_zh = `${names.join(' / ')} 模型`;
        if (names.length === 1 && names[0] === 'Gemini') slug = 'gemini';
        else if (names.every((x) => x !== 'Gemini')) slug = 'claude_gpt';
        else slug = names.join('_').toLowerCase().replace(/[^a-z0-9_]/g, '');
      } else {
        const list = models.length ? models : hidden_models;
        label = list.length <= 2 ? list.map((m) => m.display_name).join(' / ') : `${list[0].display_name} +${list.length - 1}`;
        label_zh = label;
        slug = 'other';
      }
    }
    const n = (usedIds.get(slug) || 0) + 1;
    usedIds.set(slug, n);

    return {
      id: n > 1 ? `${slug}-${n}` : slug,
      category: slug,
      kind,
      label,
      label_zh,
      remaining_fraction: g.remaining_fraction,
      reset_time: g.reset_time,
      limits: [inferLimit(g.remaining_fraction, g.reset_time, now)],
      models,
      families,
      hidden_models,
    };
  });
  const summary = parseQuotaSummary(summaryResp, now);
  const matchedSummaryCats = new Set();
  for (const pool of pools) {
    const sumEntry = summary.byCategory[pool.category];
    if (!sumEntry) continue;
    matchedSummaryCats.add(pool.category);
    pool.limits = mergeLimitLists(pool.limits, sumEntry.limits);
    const primary = pool.limits.find((l) => l.kind === '5h') || pool.limits[0];
    if (primary) {
      pool.remaining_fraction = primary.remaining_fraction;
      pool.reset_time = primary.reset_time;
    }
  }
  for (const [cat, sumEntry] of Object.entries(summary.byCategory)) {
    if (matchedSummaryCats.has(cat) || !sumEntry.limits.length) continue;
    const n = (usedIds.get(cat) || 0) + 1;
    usedIds.set(cat, n);
    const primary = sumEntry.limits.find((l) => l.kind === '5h') || sumEntry.limits[0];
    pools.push({
      id: n > 1 ? `${cat}-${n}` : cat,
      category: cat,
      kind: 'models',
      label: sumEntry.label,
      label_zh: sumEntry.label_zh,
      remaining_fraction: primary ? primary.remaining_fraction : null,
      reset_time: primary ? primary.reset_time : null,
      limits: sumEntry.limits,
      models: [],
      families: [],
      hidden_models: [],
    });
  }

  const last = (p) => (p.kind === 'tab' || (p.limits.length === 1 && p.limits[0].kind === 'none') ? 1 : 0);
  const minFrac = (p) => {
    const fracs = p.limits.map((l) => l.remaining_fraction).filter((f) => typeof f === 'number');
    return fracs.length ? Math.min(...fracs) : (p.remaining_fraction ?? Infinity);
  };
  pools.sort((a, b) => last(a) - last(b) || minFrac(a) - minFrac(b) || a.label.localeCompare(b.label));
  return {
    pools,
    weekly: summary.weekly,
    plan: findPlan(statusResp) ?? findPlan(modelsResp),
    tier: findTier(statusResp) ?? findTier(modelsResp),
  };
}

let quotaCache = null; // { at, result }
let quotaInFlight = null;
let quotaRawWritten = false;
let quotaRawHasSummary = false;

function shouldWriteQuotaRaw(hasSummary) {
  if (!existsSync(QUOTA_RAW_PATH)) return true;
  if (!hasSummary) return false;
  if (quotaRawHasSummary) return false;
  try {
    const existing = JSON.parse(readFileSync(QUOTA_RAW_PATH, 'utf8'));
    if (existing && typeof existing === 'object' && existing.RetrieveUserQuotaSummary && !existing.RetrieveUserQuotaSummary.error) {
      quotaRawHasSummary = true;
      return false;
    }
  } catch { /* corrupt file -> rewrite */ }
  return true;
}

async function fetchQuota() {
  const fetched_at = new Date().toISOString();
  const body = { metadata: LS_METADATA };
  const [status, models, summary] = await Promise.allSettled([
    lsRequest('GetUserStatus', body),
    lsRequest('GetAvailableModels', body),
    lsRequest('RetrieveUserQuotaSummary', body),
  ]);
  const statusResp = status.status === 'fulfilled' ? status.value : null;
  const modelsResp = models.status === 'fulfilled' ? models.value : null;
  const summaryResp = summary.status === 'fulfilled' ? summary.value : null;
  if (!statusResp && !modelsResp && !summaryResp) {
    const reason = status.reason || models.reason || summary.reason;
    const noLs = status.reason?.code === 'NO_LS';
    return { pools: [], weekly: {}, plan: null, tier: null, fetched_at, error: noLs ? 'unavailable' : 'failed', message: reason?.message || 'request failed' };
  }
  if ((!quotaRawWritten || summaryResp) && shouldWriteQuotaRaw(!!summaryResp)) {
    quotaRawWritten = true;
    if (summaryResp) quotaRawHasSummary = true;
    try {
      mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(QUOTA_RAW_PATH, JSON.stringify(redact({
        written_at: fetched_at,
        GetUserStatus: statusResp ?? { error: status.reason?.message },
        GetAvailableModels: modelsResp ?? { error: models.reason?.message },
        RetrieveUserQuotaSummary: summaryResp ?? { error: summary.reason?.message },
      }), null, 2));
    } catch (err) {
      console.error('[context] could not write quota-raw.json:', err.message);
    }
  }
  const parsed = parseQuota(statusResp, modelsResp, Date.now(), summaryResp);
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

// --- pricing ------------------------------------------------------------------

const LITELLM_ALLOWED_PROVIDER = /^(?:anthropic|gemini|google|openai|vertex_ai(?:-[a-z-]+)?)$/;
const LITELLM_ALLOWED_PREFIX = /^(?:anthropic|gemini|google|openai|vertex_ai)\//;
const LITELLM_SKIP_ID = /^(?:us|eu|au|jp|apac|global)\.|^anthropic\.|^ft:|\/ft:|(?:^|[:/_-])batch(?:$|[:/_-])|:(?:free|extended|thinking|nitro|floor)$|-v\d+:\d+$|@/;
const LITELLM_ALLOWED_MODE = /^(?:chat|completion|responses|image_generation)$/;
const OPENROUTER_SKIP_ID = /:(?:batch|free|extended|thinking|nitro|floor)$/;
const OPENROUTER_ALLOWED_PREFIX = /^(?:anthropic|google|openai)\//;
const RELEVANT_MODEL = /(?:claude|gemini|gpt)/;

function perMillion(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Number((n * 1e6).toFixed(6));
}

// Normalizes LiteLLM's model_prices_and_context_window.json into
// { [lowerId]: { input, output, cache_read } } (USD per 1M tokens).
export function parseLiteLLMPricing(json) {
  const out = {};
  if (!json || typeof json !== 'object' || Array.isArray(json)) return out;
  for (const [key, m] of Object.entries(json)) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) continue;
    const id = String(key).trim().toLowerCase();
    if (!id || id === 'sample_spec') continue;
    const provider = typeof m.litellm_provider === 'string' ? m.litellm_provider.trim().toLowerCase() : '';
    if (provider && !LITELLM_ALLOWED_PROVIDER.test(provider)) continue;
    if (id.includes('/')) {
      if (!LITELLM_ALLOWED_PREFIX.test(id)) continue;
      if (id.indexOf('/') !== id.lastIndexOf('/')) continue;
    }
    if (LITELLM_SKIP_ID.test(id)) continue;
    if (!RELEVANT_MODEL.test(id)) continue;
    if (typeof m.mode === 'string' && m.mode && !LITELLM_ALLOWED_MODE.test(m.mode.toLowerCase())) continue;

    const input = perMillion(m.input_cost_per_token);
    const output = perMillion(m.output_cost_per_token);
    if (input === null || output === null || (input === 0 && output === 0)) continue;
    const rawCache = perMillion(m.cache_read_input_token_cost);
    const cache_read = rawCache !== null ? rawCache : Number((input * 0.1).toFixed(6));
    out[id] = { input, output, cache_read };
  }
  return out;
}

// Normalizes OpenRouter's /api/v1/models payload into
// { [lowerId]: { input, output, cache_read } } (USD per 1M tokens).
export function parseOpenRouterPricing(json) {
  const out = {};
  const list = Array.isArray(json) ? json : (Array.isArray(json?.data) ? json.data : null);
  if (!list) return out;
  for (const m of list) {
    if (!m || typeof m !== 'object' || !m.id || !m.pricing || typeof m.pricing !== 'object') continue;
    const id = String(m.id).trim().toLowerCase();
    if (!id || OPENROUTER_SKIP_ID.test(id)) continue;
    if (!RELEVANT_MODEL.test(id) && !OPENROUTER_ALLOWED_PREFIX.test(id)) continue;

    const input = perMillion(m.pricing.prompt);
    const output = perMillion(m.pricing.completion);
    if (input === null || output === null || (input === 0 && output === 0)) continue;
    const rawCache = perMillion(m.pricing.input_cache_read);
    const cache_read = rawCache !== null ? rawCache : Number((input * 0.1).toFixed(6));
    out[id] = { input, output, cache_read };
  }
  return out;
}

function fetchHttpsJson(url, timeoutMs = PRICING_TIMEOUT_MS, redirects = 3) {
  const deadline = Date.now() + timeoutMs;
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') return Promise.reject(new Error('non-https URL rejected'));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err); else resolve(val);
    };
    const req = https.get(parsed, {
      headers: { Accept: 'application/json' },
      timeout: timeoutMs,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        const remaining = Math.max(1000, deadline - Date.now());
        const next = new URL(res.headers.location, parsed).href;
        clearTimeout(timer);
        settled = true;
        fetchHttpsJson(next, remaining, redirects - 1).then(resolve, reject);
        return;
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        finish(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      let total = 0;
      res.on('data', (chunk) => {
        total += chunk.length;
        if (total > PRICING_MAX_BYTES) {
          req.destroy(new Error('response too large'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        try {
          finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (e) {
          finish(e);
        }
      });
      res.on('error', (e) => finish(e));
    });
    const timer = setTimeout(() => req.destroy(new Error('timeout')), timeoutMs);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => finish(e));
  });
}

function writeJsonAtomic(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const text = JSON.stringify(data);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, path);
  } catch {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    writeFileSync(path, text);
  }
}

function readPricingMeta(now = Date.now()) {
  try {
    if (!existsSync(PRICING_PATH)) {
      return { source: 'builtin', fetched_at: null, count: 0, stale: true };
    }
    const raw = JSON.parse(readFileSync(PRICING_PATH, 'utf8'));
    if (!raw || typeof raw !== 'object' || !raw.models || typeof raw.models !== 'object' || Array.isArray(raw.models)) {
      return { source: 'builtin', fetched_at: null, count: 0, stale: true };
    }
    const count = Object.keys(raw.models).length;
    const source = raw.source === 'litellm' || raw.source === 'openrouter' ? raw.source : 'builtin';
    const fetched_at = typeof raw.fetched_at === 'string' && !Number.isNaN(Date.parse(raw.fetched_at)) ? raw.fetched_at : null;
    const age = fetched_at ? now - Date.parse(fetched_at) : Infinity;
    const stale = count === 0 || !fetched_at || age >= PRICING_TTL_MS;
    return { source: count > 0 ? source : 'builtin', fetched_at, count, stale };
  } catch {
    return { source: 'builtin', fetched_at: null, count: 0, stale: true };
  }
}

let pricingInFlight = null;

async function syncPricing() {
  const errors = [];
  const attempts = [
    ['litellm', PRICING_LITELLM_URL, parseLiteLLMPricing],
    ['openrouter', PRICING_OPENROUTER_URL, parseOpenRouterPricing],
  ];
  for (const [source, url, parse] of attempts) {
    try {
      const raw = await fetchHttpsJson(url, PRICING_TIMEOUT_MS);
      const models = parse(raw);
      const count = Object.keys(models).length;
      if (count === 0) throw new Error('empty pricing table');
      const fetched_at = new Date().toISOString();
      writeJsonAtomic(PRICING_PATH, { source, fetched_at, models });
      historyCache = null;
      cache.clear();
      return { source, fetched_at, count, stale: false };
    } catch (err) {
      errors.push(`${source}: ${err.message}`);
    }
  }
  const meta = readPricingMeta();
  return { ...meta, error: 'failed', message: errors.join('; ') };
}

async function pricing({ refresh = false, sync = false } = {}) {
  const meta = readPricingMeta();
  if (!refresh && !(sync && meta.stale)) return meta;
  if (!pricingInFlight) {
    pricingInFlight = syncPricing().finally(() => { pricingInFlight = null; });
  }
  return pricingInFlight;
}

// --- history ------------------------------------------------------------------

let historyCache = null; // { at, pricingStamp, result }
let historyInFlight = null;

async function scanHistory() {
  const { cmd, pre } = await findPython();
  mkdirSync(DATA_DIR, { recursive: true });
  const args = [...pre, HISTORY_SCRIPT, '--json', '--cache', HISTORY_CACHE_PATH];
  if (existsSync(PRICING_PATH)) args.push('--pricing-file', PRICING_PATH);
  const out = await run(cmd, args, HISTORY_TIMEOUT_MS);
  return JSON.parse(out);
}

async function history(refresh) {
  const pricingStamp = fileStamp(PRICING_PATH);
  if (!refresh && historyCache && historyCache.pricingStamp === pricingStamp && Date.now() - historyCache.at < HISTORY_TTL_MS) {
    return historyCache.result;
  }
  if (!historyInFlight) {
    historyInFlight = scanHistory()
      .then((result) => {
        historyCache = { at: Date.now(), pricingStamp: fileStamp(PRICING_PATH), result };
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
  const key = [fileStamp(db), fileStamp(`${db}-wal`), workspace, fileStamp(CATALOG_PATH), fileStamp(PRICING_PATH)].join('|');
  const cached = cache.get(conversationId);
  if (cached && cached.key === key) return cached.report;

  const { cmd, pre } = await findPython();
  const args = [...pre, SCRIPT, '--db', db, '--json'];
  if (existsSync(CATALOG_PATH)) args.push('--model-catalog', CATALOG_PATH);
  if (existsSync(PRICING_PATH)) args.push('--pricing-file', PRICING_PATH);
  if (workspace) args.push('--workspace', workspace);
  const out = await run(cmd, args);
  const result = { ...JSON.parse(out), updatedAt: new Date().toISOString() };
  cache.set(conversationId, { key, report: result });
  return result;
}

// --- static assets & server ---------------------------------------------------

export const NO_CACHE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  Pragma: 'no-cache',
};

// Appends ?v=<stamp> to local asset href/src attributes (e.g. styles.css,
// app.js) so WebViews cannot pair a newly served HTML shell with stale JS/CSS.
export function stampAssetUrls(html, stamps) {
  let out = String(html);
  for (const [asset, raw] of Object.entries(stamps || {})) {
    if (!raw || raw === '-') continue;
    const v = encodeURIComponent(String(raw));
    const escaped = asset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`((?:^|\\s)(?:href|src)=)(["'])((?:\\.?\\/)?${escaped})(?:\\?[^"']*)?\\2`, 'g');
    out = out.replace(re, (_, attr, quote, path) => `${attr}${quote}${path}?v=${v}${quote}`);
  }
  return out;
}

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
        let body = readFileSync(join(HERE, file), 'utf8');
        if (path === '/') {
          body = stampAssetUrls(body, {
            'styles.css': fileStamp(join(HERE, 'styles.css')),
            'app.js': fileStamp(join(HERE, 'app.js')),
          });
        }
        return new Response(body, {
          contentType,
          headers: NO_CACHE_HEADERS,
        });
      } catch {
        return new Response('Not found', { status: 404, headers: NO_CACHE_HEADERS });
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
      return { pools: [], weekly: {}, plan: null, tier: null, fetched_at: new Date().toISOString(), error: 'failed', message: err.message };
    }
  }, 'GET');

  app.api('/api/history', async (data) => {
    try {
      return await history(truthy(data?.refresh));
    } catch (err) {
      return { error: 'failed', message: err.message };
    }
  }, 'GET');

  app.api('/api/pricing', async (data) => {
    try {
      return await pricing({ refresh: truthy(data?.refresh), sync: truthy(data?.sync) });
    } catch (err) {
      return { ...readPricingMeta(), error: 'failed', message: err.message };
    }
  }, 'GET');

  app.run();
  refreshCatalog();
}
