// Sidecar backend for the Agy Lens (agy-lens) panel.
//
// Serves the web panel from web/ and exposes local-only JSON endpoints:
// - /api/report   context breakdown, speed stats, and session usage via lib/context.mjs
//                 (using live model catalog limits when available).
// - /api/quota    model quota pools from the app's language server via lib/quota.mjs
//                 (GetUserStatus / GetAvailableModels / RetrieveUserQuotaSummary).
// - /api/history  token usage across all conversations via lib/history.mjs.
// - /api/pricing  opt-in public model pricing sync (LiteLLM / OpenRouter,
//                 cached 24h in DATA_DIR/pricing-cache.json) via lib/pricing.mjs.
//
// Pure helpers are re-exported for unit tests. Set CONTEXT_PANEL_NO_SERVER=1 to
// import this module without starting the SidecarApp server.

import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildModelCatalog, writeModelCatalog } from './lib/catalog.mjs';
import { buildReport, workspacePath } from './lib/context.mjs';
import { defaultRoots, findLegacyHistoryCaches, findSubagentSources, scan as scanHistoryNative } from './lib/history.mjs';
import { defaultDataDir, defaultGeminiDir, fileStamp, hasNodeSqlite } from './lib/pb.mjs';
import {
  parseLiteLLMPricing,
  parseOpenRouterPricing,
  readPricingMeta,
  syncPricing,
} from './lib/pricing.mjs';
import {
  LS_METADATA,
  fetchQuota,
  inferLimit,
  loadQuotaCycles,
  lsRequest,
  mergeQuotaObservation,
  parseQuota,
  parseQuotaSummary,
  recordQuotaCycles,
  redact,
} from './lib/quota.mjs';
import {
  checkForUpdate,
  compareSemver,
  detectInstallMode,
  extractZipEntries,
  installReleaseUpdate,
  isAllowedUpdateUrl,
  parseGithubRelease,
  parseManifestRelease,
  parseSha256Sums,
  readCurrentVersion,
  readUpdateMeta,
} from './lib/updater.mjs';
import { bundleWebApp, computeWebJsStamp } from './lib/web-bundle.mjs';

export {
  buildModelCatalog,
  bundleWebApp,
  checkForUpdate,
  compareSemver,
  computeWebJsStamp,
  detectInstallMode,
  extractZipEntries,
  inferLimit,
  installReleaseUpdate,
  isAllowedUpdateUrl,
  loadQuotaCycles,
  mergeQuotaObservation,
  parseGithubRelease,
  parseLiteLLMPricing,
  parseManifestRelease,
  parseOpenRouterPricing,
  parseQuota,
  parseQuotaSummary,
  parseSha256Sums,
  readCurrentVersion,
  readUpdateMeta,
  recordQuotaCycles,
  redact,
};

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, '../..');
const WEB_DIR = join(HERE, 'web');
const DATA_DIR = defaultDataDir();
const CATALOG_PATH = join(DATA_DIR, 'model-catalog.json');
const CATALOG_TTL_MS = 10 * 60 * 1000;
const QUOTA_RAW_PATH = join(DATA_DIR, 'quota-raw.json');
const QUOTA_CYCLES_PATH = join(DATA_DIR, 'quota-cycles.json');
const QUOTA_TTL_MS = 60 * 1000;
const HISTORY_CACHE_PATH = join(DATA_DIR, 'history-cache.json');
const HISTORY_TTL_MS = 60 * 1000;
const PRICING_PATH = join(DATA_DIR, 'pricing-cache.json');
const UPDATE_CACHE_PATH = join(DATA_DIR, 'update-cache.json');
const CURRENT_VERSION = readCurrentVersion(PLUGIN_ROOT);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET query parameters arrive as strings; JSON bodies as booleans.
export function truthy(v) {
  return v === true || v === 1 || (typeof v === 'string' && /^(1|true|yes)$/i.test(v.trim()));
}

// --- language server catalog --------------------------------------------------

let catalogFetchedAt = 0;

async function refreshCatalog(force = false) {
  if (!force && Date.now() - catalogFetchedAt < CATALOG_TTL_MS && existsSync(CATALOG_PATH)) return;
  catalogFetchedAt = Date.now();
  try {
    const resp = await lsRequest('GetAvailableModels', { metadata: LS_METADATA });
    if (writeModelCatalog(CATALOG_PATH, resp, null)) catalogFetchedAt = Date.now();
  } catch (err) {
    console.error('[agy-lens] model catalog unavailable, using built-in limits:', err.message);
  }
}

// --- quota cache --------------------------------------------------------------

let quotaCache = null; // { at, result }
let quotaInFlight = null;

async function quota(refresh) {
  if (!refresh && quotaCache && Date.now() - quotaCache.at < QUOTA_TTL_MS) return quotaCache.result;
  if (!quotaInFlight) {
    quotaInFlight = fetchQuota({
      forceRaw: Boolean(refresh),
      catalogPath: CATALOG_PATH,
      quotaRawPath: QUOTA_RAW_PATH,
      quotaCyclesPath: QUOTA_CYCLES_PATH,
      onCatalogWritten: () => { catalogFetchedAt = Date.now(); },
    })
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

// --- pricing cache ------------------------------------------------------------

let pricingInFlight = null;

async function pricing({ refresh = false, sync = false } = {}) {
  const meta = readPricingMeta(PRICING_PATH);
  if (!refresh && !(sync && meta.stale)) return meta;
  if (!pricingInFlight) {
    pricingInFlight = syncPricing(PRICING_PATH)
      .then((res) => {
        if (res && !res.error) {
          historyCache = null;
          cache.clear();
        }
        return res;
      })
      .finally(() => { pricingInFlight = null; });
  }
  return pricingInFlight;
}

// --- update check & self-update -----------------------------------------------

let updateInFlight = null;
let updateInstallInFlight = null;

async function updateStatus({ refresh = false } = {}) {
  const mode = detectInstallMode(PLUGIN_ROOT);
  if (!refresh) {
    const meta = readUpdateMeta(UPDATE_CACHE_PATH, CURRENT_VERSION);
    if (!meta.stale || truthy(process.env.AGY_LENS_NO_UPDATE_CHECK)) {
      return truthy(process.env.AGY_LENS_NO_UPDATE_CHECK) ? { ...meta, ...mode, disabled: true } : { ...meta, ...mode };
    }
  }
  if (!updateInFlight) {
    updateInFlight = checkForUpdate({
      updateCachePath: UPDATE_CACHE_PATH,
      currentVersion: CURRENT_VERSION,
      force: Boolean(refresh),
    }).finally(() => { updateInFlight = null; });
  }
  const res = await updateInFlight;
  return { ...res, ...mode };
}

async function installUpdate(targetVersion = null) {
  const mode = detectInstallMode(PLUGIN_ROOT);
  if (!mode.can_self_update) {
    return {
      ok: false,
      error: 'unsupported',
      message: `Self-update is unavailable (${mode.install_mode})`,
      ...mode,
    };
  }
  if (!updateInstallInFlight) {
    updateInstallInFlight = installReleaseUpdate({
      rootDir: PLUGIN_ROOT,
      dataDir: DATA_DIR,
      updateCachePath: UPDATE_CACHE_PATH,
      currentVersion: CURRENT_VERSION,
      targetVersion,
    }).finally(() => { updateInstallInFlight = null; });
  }
  return updateInstallInFlight;
}

// --- history cache ------------------------------------------------------------

let historyCache = null; // { at, pricingStamp, catalogStamp, cSig, result }
let historyInFlight = null;

async function scanHistory(quotaCycles = null) {
  mkdirSync(DATA_DIR, { recursive: true });
  await refreshCatalog(false);
  if (!(await hasNodeSqlite())) {
    throw new Error('Node.js built-in SQLite (node:sqlite) is unavailable. Requires Node.js 22.5+.');
  }
  const pricingFile = existsSync(PRICING_PATH) ? PRICING_PATH : null;
  const modelCatalogPath = existsSync(CATALOG_PATH) ? CATALOG_PATH : null;
  return await scanHistoryNative(defaultRoots(defaultGeminiDir()), {
    cachePath: HISTORY_CACHE_PATH,
    pricingFile,
    modelCatalogPath,
    quotaCycles,
    legacyCachePaths: findLegacyHistoryCaches(defaultGeminiDir()),
  });
}

// Persistent official weekly quota cycle ledger enriched with the current live
// (or cached) quota response. Never waits long on the language server.
async function currentQuotaCycles(refresh = false) {
  let q = null;
  try {
    q = await Promise.race([quota(Boolean(refresh)), new Promise((r) => { setTimeout(() => r(null), 3000).unref?.(); })]);
  } catch { /* quota unavailable */ }
  const ledger = loadQuotaCycles(QUOTA_CYCLES_PATH, QUOTA_RAW_PATH);
  return q && !q.error ? mergeQuotaObservation(ledger, q).ledger : ledger;
}

const cyclesSig = (ledger) => {
  const pools = (ledger && ledger.pools) || {};
  return Object.keys(pools).sort().map((pk) => {
    const arr = Array.isArray(pools[pk]) ? pools[pk] : [];
    return `${pk}=[${arr.map((c) => `${c.cycle_start || ''}:${c.cycle_start_source || ''}:${c.reset_time}@${c.observed_at}:${c.remaining_fraction}:${c.saturated ? 1 : 0}:${Array.isArray(c.observations) ? c.observations.length : 0}`).join(',')}]`;
  }).join('|');
};

async function history(refresh) {
  const pricingStamp = fileStamp(PRICING_PATH);
  const catalogStamp = fileStamp(CATALOG_PATH);
  const quotaCycles = await currentQuotaCycles(refresh);
  const cSig = cyclesSig(quotaCycles);
  if (!refresh && historyCache && historyCache.pricingStamp === pricingStamp && historyCache.catalogStamp === catalogStamp && historyCache.cSig === cSig && Date.now() - historyCache.at < HISTORY_TTL_MS) {
    return historyCache.result;
  }
  if (!historyInFlight) {
    historyInFlight = scanHistory(quotaCycles)
      .then((result) => {
        historyCache = { at: Date.now(), pricingStamp: fileStamp(PRICING_PATH), catalogStamp: fileStamp(CATALOG_PATH), cSig, result };
        return result;
      })
      .finally(() => { historyInFlight = null; });
  }
  return historyInFlight;
}

// --- report cache -------------------------------------------------------------

const cache = new Map(); // conversationId -> { key, report }

async function report(conversationId, workspaceUri) {
  if (!UUID.test(conversationId || '')) {
    return { error: 'no-conversation' };
  }
  const conversationsDir = join(defaultGeminiDir(), 'antigravity', 'conversations');
  const db = join(conversationsDir, `${conversationId}.db`);
  if (!existsSync(db)) {
    return { error: 'no-database' };
  }
  await refreshCatalog();
  const workspace = workspacePath(workspaceUri);
  let subagentDbPaths = [];
  let archivedSubagents = [];
  let enumMap = null;
  try {
    const found = await findSubagentSources(defaultRoots(defaultGeminiDir()), conversationId, HISTORY_CACHE_PATH);
    subagentDbPaths = found.dbPaths;
    archivedSubagents = found.archivedEntries;
    enumMap = found.enums;
  } catch { /* summaries unavailable: own usage only */ }
  const subStamps = subagentDbPaths.map((p) => `${fileStamp(p)}/${fileStamp(`${p}-wal`)}`).join(',');
  const archStamp = archivedSubagents.length ? fileStamp(HISTORY_CACHE_PATH) : '';
  const key = [fileStamp(db), fileStamp(`${db}-wal`), workspace, fileStamp(CATALOG_PATH), fileStamp(PRICING_PATH), subStamps, archStamp].join('|');
  const cached = cache.get(conversationId);
  if (cached && cached.key === key) return cached.report;

  if (!(await hasNodeSqlite())) {
    throw new Error('Node.js built-in SQLite (node:sqlite) is unavailable. Requires Node.js 22.5+.');
  }
  const modelCatalogPath = existsSync(CATALOG_PATH) ? CATALOG_PATH : null;
  const pricingFile = existsSync(PRICING_PATH) ? PRICING_PATH : null;
  const parsed = await buildReport({
    dbPath: db,
    conversationId,
    workspace,
    modelCatalogPath,
    pricingFile,
    subagentDbPaths,
    archivedSubagents,
    enumMap,
  });
  const result = { ...parsed, updatedAt: new Date().toISOString() };
  cache.set(conversationId, { key, report: result });
  return result;
}

// --- static assets & server ---------------------------------------------------

export const NO_CACHE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  Pragma: 'no-cache',
};

export const STATIC_HEADERS = {
  ...NO_CACHE_HEADERS,
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
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

function stripAppModuleType(html) {
  return String(html).replace(/<script\b([^>]*)>/gi, (tag, attrs) => {
    if (!/\bsrc\s*=\s*(?:"[^"]*\bapp\.js(?:\?[^"]*)?"|'[^']*\bapp\.js(?:\?[^"]*)?')/i.test(attrs)) {
      return tag;
    }
    const cleaned = attrs.replace(/\s+\btype\s*=\s*(?:"module"|'module'|module\b)/gi, '');
    return `<script${cleaned}>`;
  });
}

export function renderIndexHtml(webDir = WEB_DIR) {
  const html = stripAppModuleType(readFileSync(join(webDir, 'index.html'), 'utf8'));
  return stampAssetUrls(html, {
    'styles.css': fileStamp(join(webDir, 'styles.css')),
    'app.js': computeWebJsStamp(webDir),
  });
}

let webBundleCache = null; // { webDir, stamp, code }

export function getBundledAppJs(webDir = WEB_DIR) {
  const resolvedDir = resolve(webDir);
  const stamp = computeWebJsStamp(resolvedDir);
  if (stamp !== '-' && webBundleCache && webBundleCache.webDir === resolvedDir && webBundleCache.stamp === stamp) {
    return webBundleCache.code;
  }
  const code = bundleWebApp(resolvedDir, 'app.js');
  if (stamp !== '-') {
    webBundleCache = { webDir: resolvedDir, stamp, code };
  }
  return code;
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function collectWebRoutes(dir, prefix = '') {
  const routes = [];
  if (!existsSync(dir)) return routes;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, ent.name);
    const rel = prefix ? posix.join(prefix, ent.name) : ent.name;
    if (ent.isDirectory()) {
      routes.push(...collectWebRoutes(abs, rel));
    } else if (ent.isFile()) {
      const mime = MIME_TYPES[extname(ent.name).toLowerCase()];
      if (mime) routes.push([`/${rel}`, abs, mime]);
    }
  }
  return routes;
}

if (!truthy(process.env.CONTEXT_PANEL_NO_SERVER)) {
  const { Response, SidecarApp } = await import('sidecar_sdk');
  const app = new SidecarApp();

  const staticRoutes = [['/', join(WEB_DIR, 'index.html'), 'text/html; charset=utf-8'], ...collectWebRoutes(WEB_DIR)];
  for (const [routePath, absPath, contentType] of staticRoutes) {
    app.page(routePath, (req) => {
      if (req?.method === 'OPTIONS') {
        return new Response('', { status: 204, headers: STATIC_HEADERS });
      }
      try {
        let body;
        if (routePath === '/' || routePath === '/index.html') {
          body = renderIndexHtml(WEB_DIR);
        } else if (routePath === '/app.js') {
          body = getBundledAppJs(WEB_DIR);
        } else {
          body = readFileSync(absPath, 'utf8');
        }
        return new Response(body, {
          contentType,
          headers: STATIC_HEADERS,
        });
      } catch {
        return new Response('Not found', { status: 404, headers: STATIC_HEADERS });
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
      return { ...readPricingMeta(PRICING_PATH), error: 'failed', message: err.message };
    }
  }, 'GET');

  app.api('/api/update', async (data) => {
    try {
      return await updateStatus({ refresh: truthy(data?.refresh) });
    } catch (err) {
      return {
        ...readUpdateMeta(UPDATE_CACHE_PATH, CURRENT_VERSION),
        ...detectInstallMode(PLUGIN_ROOT),
        error: 'failed',
        message: err.message,
      };
    }
  }, 'GET');

  app.api('/api/update/install', async (data) => {
    try {
      const res = await installUpdate(data?.version || null);
      if (res && res.ok && res.updated && res.restarting) {
        setTimeout(() => { process.exit(0); }, 300);
      }
      return res;
    } catch (err) {
      return {
        ok: false,
        error: 'install_failed',
        message: err?.message || String(err),
        ...detectInstallMode(PLUGIN_ROOT),
      };
    }
  }, 'POST');

  app.run();
  refreshCatalog();
  const QUOTA_BG_POLL_MS = 5 * 60 * 1000;
  quota(false).catch(() => {});
  const quotaBgTimer = setInterval(() => { quota(false).catch(() => {}); }, QUOTA_BG_POLL_MS);
  quotaBgTimer.unref?.();
}
