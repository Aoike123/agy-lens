#!/usr/bin/env node
/**
 * Multi-conversation token-usage scanner for Antigravity conversation databases.
 *
 * Pure Node.js ESM port of history_scanner.py using built-in `node:sqlite`
 * (zero Python or external npm dependencies). Always opens databases read-only.
 *
 *   node history_scanner.mjs --json [--cache PATH] [--root DIR[=label]]... [--days 365] [--pricing-file PATH]
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { Msg, formatLocalIso, localDateKey, openReadOnlyDb, roundN } from './pb.mjs';

export const CACHE_VERSION = 4;

const GEN_FIELDS = new Set([1, 3]); // chat_model, planner_config
const CHAT_FIELDS = new Set([4, 19, 21]); // usage, response_model, model_display_name
const PLANNER_FIELDS = new Set([28]); // model_name
const USAGE_FIELDS = new Set([2, 3, 5, 9]); // input, output, cache_read, thinking
const STEP_MD_FIELDS = new Set([1]); // created_at
const STEP_UI_OUTER = new Set([19]);
const STEP_UI_INNER = new Set([2]);

// --- pricing & pools ---------------------------------------------------------

// Built-in official public list prices in USD per 1M tokens
// (input, output, cache_read), used offline or as fallback when no synced
// pricing file is passed via --pricing-file.
export const PRICES_USD_PER_1M = [
  ['gemini-3.1-pro', [2.0, 12.0, 0.2]],
  ['gemini-3-pro', [2.0, 12.0, 0.2]],
  ['gemini-3-flash', [0.5, 3.0, 0.05]],
  ['gemini-2.5-pro', [1.25, 10.0, 0.3125]],
  ['gemini-2.5-flash', [0.3, 2.5, 0.075]],
  ['gemini-2.0-flash-lite', [0.075, 0.3, 0.075]],
  ['gemini-2.0-flash', [0.1, 0.4, 0.025]],
  ['claude-opus-4-6', [15.0, 75.0, 1.5]],
  ['claude-opus-4-5', [15.0, 75.0, 1.5]],
  ['claude-opus-4-1', [15.0, 75.0, 1.5]],
  ['claude-opus-4', [15.0, 75.0, 1.5]],
  ['claude-sonnet-4-6', [3.0, 15.0, 0.3]],
  ['claude-sonnet-4-5', [3.0, 15.0, 0.3]],
  ['claude-sonnet-4', [3.0, 15.0, 0.3]],
  ['claude-3-7-sonnet', [3.0, 15.0, 0.3]],
  ['claude-3-5-sonnet', [3.0, 15.0, 0.3]],
  ['claude-haiku-4-5', [0.8, 4.0, 0.08]],
  ['claude-3-5-haiku', [0.8, 4.0, 0.08]],
  ['gpt-oss-120b', [0.15, 0.6, 0.075]],
  ['gpt-oss-20b', [0.05, 0.2, 0.025]],
];

export const PREVIEW_FAMILY_FALLBACKS = [
  ['claude-opus-5', 'claude-opus-4-6'],
  ['claude-opus', 'claude-opus-4-6'],
  ['claude-sonnet-5', 'claude-sonnet-4-6'],
  ['claude-sonnet', 'claude-sonnet-4-6'],
  ['claude-haiku', 'claude-haiku-4-5'],
  ['gemini-3.8-flash', 'gemini-2.5-flash'],
  ['gemini-3.5-flash', 'gemini-2.5-flash'],
  ['gemini-3.1-flash', 'gemini-2.5-flash'],
  ['gemini-2.5-flash-lite', 'gemini-2.5-flash'],
  ['gemini-flash-', 'gemini-2.5-flash'],
  ['gemini-4-', 'gemini-2.5-pro'],
];

export const POOLS = ['gemini', 'claude_gpt', 'other'];
const VER_DOT_RE = /(?<=\d)\.(?=\d)/g;

const cmpCode = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const normVer = (s) => s.replace(VER_DOT_RE, '-');
const normNum = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

function expandHome(p) {
  const s = String(p || '');
  if (s === '~') return homedir();
  if (s.startsWith('~/') || s.startsWith('~\\')) return join(homedir(), s.slice(2));
  return s;
}

function extractPrice(v) {
  if (Array.isArray(v) && v.length === 3) {
    const vals = v.map(normNum);
    return vals.every((x) => x !== null) ? vals : null;
  }
  if (v && typeof v === 'object') {
    const inp = normNum(v.input);
    const out = normNum(v.output);
    if (inp === null || out === null) return null;
    const rawCache = v.cache_read;
    const cache = rawCache == null ? inp * 0.1 : normNum(rawCache);
    if (cache === null) return null;
    return [inp, out, cache];
  }
  return null;
}

/**
 * Load normalized pricing cache JSON -> [modelsObj, source, fetchedAt].
 * Missing or invalid files silently fall back to [{}, 'builtin', null].
 */
export function loadPricingFile(filePath) {
  if (!filePath) return [{}, 'builtin', null];
  let data;
  try {
    data = JSON.parse(readFileSync(expandHome(filePath), 'utf8'));
  } catch {
    return [{}, 'builtin', null];
  }
  if (!data || typeof data !== 'object' || Array.isArray(data) || !data.models || typeof data.models !== 'object' || Array.isArray(data.models)) {
    return [{}, 'builtin', null];
  }
  const models = Object.create(null);
  let count = 0;
  for (const [k, v] of Object.entries(data.models)) {
    if (typeof k !== 'string') continue;
    const key = k.trim().toLowerCase();
    const p = extractPrice(v);
    if (key && p !== null) {
      models[key] = { input: p[0], output: p[1], cache_read: p[2] };
      count += 1;
    }
  }
  if (count === 0) return [{}, 'builtin', null];
  const source = typeof data.source === 'string' && data.source.trim() ? data.source.trim() : 'custom';
  const fetchedAt = typeof data.fetched_at === 'string' && data.fetched_at.trim() ? data.fetched_at.trim() : null;
  return [models, source, fetchedAt];
}

function matchSlug(slug, key) {
  if (!key) return 0;
  if (slug.includes('-lite') && !key.includes('-lite')) return 0;
  if (slug === key) return 10000 + key.length;
  const ns = normVer(slug);
  const nk = normVer(key);
  if (ns === nk) return 5000 + key.length;
  if (slug.startsWith(`${key}-`) || slug.startsWith(`${key}:`)) return key.length;
  if (ns.startsWith(`${nk}-`) || ns.startsWith(`${nk}:`)) return key.length;
  return 0;
}

function lookupCustom(slug, customPrices) {
  if (!customPrices || typeof customPrices !== 'object') return null;
  let bestScore = 0;
  let bestBare = -1;
  let bestPrice = null;
  for (const [origK, rawV] of Object.entries(customPrices)) {
    const kl = origK.trim().toLowerCase();
    const slash = kl.lastIndexOf('/');
    const bare = slash >= 0 ? kl.slice(slash + 1) : kl;
    const sc = matchSlug(slug, bare);
    if (sc <= 0) continue;
    const p = extractPrice(rawV);
    if (p === null) continue;
    const isBare = slash < 0 ? 1 : 0;
    if (sc > bestScore || (sc === bestScore && isBare > bestBare)) {
      bestScore = sc;
      bestBare = isBare;
      bestPrice = p;
    }
  }
  return bestPrice;
}

function lookupBuiltin(slug) {
  let bestScore = 0;
  let bestPrice = null;
  for (const [prefix, p] of PRICES_USD_PER_1M) {
    const sc = matchSlug(slug, prefix);
    if (sc > bestScore) {
      bestScore = sc;
      bestPrice = p;
    }
  }
  return bestPrice;
}

function lookupDirect(slug, customPrices) {
  return lookupCustom(slug, customPrices) || lookupBuiltin(slug);
}

function previewTarget(slug) {
  for (const [prefix, target] of PREVIEW_FAMILY_FALLBACKS) {
    if (slug.startsWith(prefix)) return target;
  }
  if (slug.includes('orchestrator')) return 'gemini-2.5-pro';
  return null;
}

export function priceInfo(model, customPrices = null) {
  const raw = String(model || '').trim().toLowerCase();
  const slash = raw.lastIndexOf('/');
  const slug = slash >= 0 ? raw.slice(slash + 1) : raw;
  if (!slug || slug === 'unknown' || slug.startsWith('tab_')) return [null, false];
  let p = lookupDirect(slug, customPrices);
  if (p !== null) return [p, false];
  const target = previewTarget(slug);
  if (target !== null) {
    p = lookupDirect(target, customPrices);
    if (p !== null) return [p, true];
  }
  return [null, false];
}

export function priceFor(model, customPrices = null) {
  return priceInfo(model, customPrices)[0];
}

export function callCostInfo(model, inp, out, cacheRead, customPrices = null) {
  const [p, estimated] = priceInfo(model, customPrices);
  if (p === null) return [null, false];
  return [(inp * p[0] + out * p[1] + cacheRead * p[2]) / 1_000_000, estimated];
}

export function callCost(model, inp, out, cacheRead, customPrices = null) {
  return callCostInfo(model, inp, out, cacheRead, customPrices)[0];
}

export function modelPool(modelId) {
  const s = String(modelId || '').trim().toLowerCase();
  if (!s || s === 'unknown' || s.startsWith('tab_')) return 'other';
  if (s.includes('claude') || s.includes('gpt') || s.includes('openai')) return 'claude_gpt';
  if (s.includes('gemini') || s.includes('orchestrator')) return 'gemini';
  return 'other';
}

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

export async function parseDb(dbPath) {
  const p = String(dbPath);
  const fallbackTs = statSync(p).mtimeMs / 1000;
  const conn = await openReadOnlyDb(p);
  let gens;
  let stamps;
  let firstInput;
  try {
    try {
      gens = conn.prepare('SELECT data FROM gen_metadata ORDER BY idx').all();
    } catch (err) {
      if (!String(err?.message || '').includes('no such table')) throw err;
      conn.prepare('SELECT 1 FROM sqlite_master LIMIT 1').all();
      return { calls: [], names: {}, first_input: null };
    }
    stamps = plannerTimestamps(conn);
    firstInput = firstUserText(conn);
  } finally {
    conn.close();
  }

  const calls = [];
  const names = Object.create(null);
  for (let i = 0; i < gens.length; i += 1) {
    const g = parseGeneration(gens[i].data);
    if (!g) continue;
    let [model, display] = g;
    const [, , inp, out, cache, think] = g;
    if (!(inp || out || cache || think)) continue;
    if (model) {
      if (display) names[model] = display;
    } else {
      model = display ? DISPLAY_PREFIX + display : 'unknown';
    }
    calls.push([generationTime(stamps, i, fallbackTs), model, inp, out, cache, think]);
  }
  return { calls, names: { ...names }, first_input: firstInput };
}

export async function loadTitles(roots) {
  const titles = new Map();
  const agents = new Map();
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
        const sel = ['conversation_id', 'title', 'preview', 'agent_name']
          .map((c) => (cols.has(c) ? c : "''"))
          .join(', ');
        for (const row of conn.prepare(`SELECT ${sel} FROM conversation_summaries`).iterate()) {
          const vals = Object.values(row);
          const cid = row.conversation_id ?? vals[0];
          const title = row.title ?? vals[1];
          const preview = row.preview ?? vals[2];
          const agent = row.agent_name ?? vals[3];
          if (!cid) continue;
          const id = String(cid);
          const t = truncateTitle(title || preview || '');
          if (t && !titles.has(id)) titles.set(id, t);
          const a = agent != null ? String(agent).trim() : '';
          if (a && !agents.has(id)) agents.set(id, a);
        }
      } finally {
        conn.close();
      }
    } catch {
      continue;
    }
  }
  return [titles, agents];
}

// --- cache -------------------------------------------------------------------

export function loadCache(cachePath) {
  if (!cachePath) return {};
  try {
    const data = JSON.parse(readFileSync(expandHome(cachePath), 'utf8'));
    if (data && typeof data === 'object' && data.version === CACHE_VERSION && data.dbs && typeof data.dbs === 'object' && !Array.isArray(data.dbs)) {
      return data.dbs;
    }
  } catch { /* ignore */ }
  return {};
}

export function saveCache(cachePath, dbs) {
  if (!cachePath) return;
  const target = expandHome(cachePath);
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(tmp, JSON.stringify({ version: CACHE_VERSION, dbs }), 'utf8');
    renameSync(tmp, target);
  } catch {
    try { unlinkSync(tmp); } catch { /* ignore */ }
  }
}

// --- aggregation -------------------------------------------------------------

export function defaultRoots(geminiDir = process.env.ANTIGRAVITY_GEMINI_DIR || join(homedir(), '.gemini')) {
  return [
    [join(geminiDir, 'antigravity', 'conversations'), 'desktop'],
    [join(geminiDir, 'antigravity-cli', 'conversations'), 'cli'],
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

export async function scan(roots, {
  cachePath = null,
  days = 365,
  now = new Date(),
  stats = null,
  pricingFile = null,
} = {}) {
  const t0 = performance.now();
  const totalDays = Math.max(1, Number(days) || 365);
  const st = stats || {};
  st.hits = 0;
  st.misses = 0;

  const [customPrices, pricingSource, pricingFetchedAt] = loadPricingFile(pricingFile);
  const oldCache = loadCache(cachePath);
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
      let entry;
      if (cached && typeof cached === 'object' && sameFp(cached.fp, fp) && Array.isArray(cached.calls)) {
        st.hits += 1;
        entry = cached;
      } else {
        st.misses += 1;
        try {
          const parsed = await parseDb(db.path);
          entry = { fp, ...parsed };
        } catch {
          errors += 1;
          continue;
        }
      }
      newCache[key] = entry;
      sources[label] += 1;
      perDb.push([key, entry, label, db.stem]);
    }
  }

  saveCache(cachePath, newCache);

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
      calls: 0,
      est_cost_usd: null,
      cost_partial: false,
      cost_estimated: false,
      is_subagent: false,
      by_model: [],
      _first: null,
      _last: -Infinity,
      _models: new Map(),
      _first_input: entry.first_input ?? null,
    };
    convs.push(conv);

    for (const [ts, rawModel, inp, out, cache, think] of entry.calls) {
      let model = rawModel;
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
      const cost = p !== null ? (inp * p[0] + out * p[1] + cache * p[2]) / 1_000_000 : null;

      let pool = poolCache.get(model);
      if (!pool) {
        pool = modelPool(model);
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
        conv.d7_by_pool[pool] += d7Tok;
        d7ByPool[pool] += d7Tok;
      }
      conv.calls += 1;
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
      cm.calls += 1;
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
          t.calls += 1;
          if (cost !== null) {
            t.est_cost_usd = (t.est_cost_usd ?? 0) + cost;
            if (isEst) t.cost_estimated = true;
          }
          convSets[w].add(key);
        }
      }

      let bm = byModel.get(model);
      if (!bm) {
        bm = {
          model, display_name: null, pool, input: 0, output: 0, cache_read: 0, thinking: 0,
          d7_tokens: 0, calls: 0, est_cost_usd: null, cost_estimated: false,
        };
        byModel.set(model, bm);
      }
      bm.input += inp;
      bm.output += out;
      bm.cache_read += cache;
      bm.thinking += think;
      if (inD7) bm.d7_tokens += inp + out;
      bm.calls += 1;
      if (cost !== null) {
        bm.est_cost_usd = (bm.est_cost_usd ?? 0) + cost;
        if (isEst) bm.cost_estimated = true;
      }

      const slot = daily.get(dk);
      if (slot) {
        slot[0] += inp + out + cache;
        slot[1] += 1;
      }
      if (dk === todayKey) {
        const hslot = hourlyToday[hour];
        hslot[0] += inp + out + cache;
        hslot[1] += 1;
      }
    }
  }

  for (const [w] of windows) {
    const t = totals[w];
    t.conversations = convSets[w].size;
    if (t.est_cost_usd !== null) t.est_cost_usd = roundN(t.est_cost_usd, 4);
  }

  const models = Array.from(byModel.values());
  for (const bm of models) {
    bm.display_name = names.get(bm.model) ?? null;
    if (bm.est_cost_usd !== null) bm.est_cost_usd = roundN(bm.est_cost_usd, 4);
  }
  models.sort((a, b) => {
    const ta = a.input + a.output + a.cache_read;
    const tb = b.input + b.output + b.cache_read;
    if (tb !== ta) return tb - ta;
    return cmpCode(a.model, b.model);
  });

  convs.sort((a, b) => (b._last !== a._last ? b._last - a._last : cmpCode(a.id, b.id)));
  const capped = convs.slice(0, MAX_CONVERSATIONS);
  const [titles, agents] = capped.length ? await loadTitles(roots) : [new Map(), new Map()];
  for (const c of capped) {
    const cmodels = Array.from(c._models.values());
    for (const cm of cmodels) {
      cm.display_name = names.get(cm.model) ?? null;
      if (cm.est_cost_usd !== null) cm.est_cost_usd = roundN(cm.est_cost_usd, 4);
    }
    let bestModel = cmodels[0];
    for (let i = 1; i < cmodels.length; i += 1) {
      const m = cmodels[i];
      const mt = m.input + m.output + m.cache_read;
      const bt = bestModel.input + bestModel.output + bestModel.cache_read;
      if (mt > bt || (mt === bt && cmpCode(m.model, bestModel.model) > 0)) bestModel = m;
    }
    c.model = bestModel.model;
    c.display_name = names.get(c.model) ?? null;

    const primaryPool = poolCache.get(c.model) || modelPool(c.model);
    const maxD7Pool = Math.max(c.d7_by_pool.gemini, c.d7_by_pool.claude_gpt, c.d7_by_pool.other);
    if (maxD7Pool > 0) {
      let bestP = POOLS[0];
      for (let i = 1; i < POOLS.length; i += 1) {
        const p = POOLS[i];
        const diff = c.d7_by_pool[p] - c.d7_by_pool[bestP];
        if (diff > 0 || (diff === 0 && p === primaryPool && bestP !== primaryPool)) {
          bestP = p;
        }
      }
      c.pool = bestP;
    } else {
      c.pool = primaryPool;
    }

    cmodels.sort((a, b) => {
      const ta = a.input + a.output;
      const tb = b.input + b.output;
      if (tb !== ta) return tb - ta;
      return cmpCode(a.model, b.model);
    });
    c.by_model = cmodels;

    const agent = agents.get(c.id);
    c.is_subagent = Boolean(agent);
    c.title = titles.get(c.id) || c._first_input || (agent && agent !== 'self' ? `@${agent}` : null);
    c.first_at = formatLocalIso(c._first);
    c.last_at = formatLocalIso(c._last);
    if (c.est_cost_usd !== null) c.est_cost_usd = roundN(c.est_cost_usd, 4);
    delete c._first;
    delete c._last;
    delete c._models;
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
    pricing_source: pricingSource,
    pricing_fetched_at: pricingFetchedAt,
    sources,
    errors,
    scanned_at: formatLocalIso(Date.now() / 1000),
    elapsed_ms: Math.trunc(performance.now() - t0),
  };
}

// --- CLI ---------------------------------------------------------------------

async function cliMain(argv) {
  let cachePath = null;
  let days = 365;
  let pricingFile = null;
  const rawRoots = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') continue;
    if (a === '--cache' && i + 1 < argv.length) cachePath = argv[++i];
    else if (a === '--days' && i + 1 < argv.length) days = parseInt(argv[++i], 10) || 365;
    else if (a === '--pricing-file' && i + 1 < argv.length) pricingFile = argv[++i];
    else if (a === '--root' && i + 1 < argv.length) rawRoots.push(argv[++i]);
  }
  const roots = rawRoots.length ? rawRoots.map(parseRoot) : defaultRoots();
  const report = await scan(roots, { cachePath, days, pricingFile });
  process.stdout.write(`${JSON.stringify(report)}\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cliMain(process.argv.slice(2)).then((code) => process.exit(code));
}
