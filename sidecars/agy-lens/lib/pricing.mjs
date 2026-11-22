// Model USD/1M pricing tables, lookup with preview-family fallback, and
// opt-in LiteLLM / OpenRouter pricing sync. Pure ESM, zero external dependencies.

import { existsSync, readFileSync } from 'node:fs';
import https from 'node:https';
import { join } from 'node:path';
import { defaultDataDir, expandHome, writeJsonAtomic } from './pb.mjs';

export const PRICING_TTL_MS = 24 * 60 * 60 * 1000;
export const PRICING_TIMEOUT_MS = 10 * 1000;
export const PRICING_MAX_BYTES = 20 * 1024 * 1024;
export const PRICING_LITELLM_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
export const PRICING_OPENROUTER_URL = 'https://openrouter.ai/api/v1/models';

// Built-in official public list prices in USD per 1M tokens
// (input, output, cache_read), used offline or as fallback when no synced
// pricing file is passed via --pricing-file. Snapshot of the LiteLLM public
// price list on 2026-11-22; refresh it when Antigravity ships new model families
// so offline estimates stay close to what "Sync prices" returns.
export const PRICES_USD_PER_1M = [
  ['gemini-4-neon', [3.0, 15.0, 0.15]],
  ['gemini-4-argon', [2.0, 10.0, 0.1]],
  ['gemini-4-carbon', [2.0, 10.0, 0.1]],
  ['gemini-4-hydrogen', [1.5, 7.5, 0.075]],
  ['gemini-3.8-flash', [0.75, 3.75, 0.075]],
  ['gemini-3.7-flash', [0.75, 3.75, 0.075]],
  ['gemini-3.6-flash', [0.75, 3.75, 0.075]],
  ['gemini-3.5-flash-lite', [0.3, 2.5, 0.03]],
  ['gemini-3.5-flash', [1.5, 9.0, 0.15]],
  ['gemini-3.1-flash-lite', [0.25, 1.5, 0.025]],
  ['gemini-3.1-pro', [2.0, 12.0, 0.2, { threshold: 200000, input: 4.0, output: 18.0, cache_read: 0.4 }]],
  ['gemini-3-pro', [2.0, 12.0, 0.2, { threshold: 200000, input: 4.0, output: 18.0, cache_read: 0.4 }]],
  ['gemini-3-flash', [0.5, 3.0, 0.05]],
  ['gemini-2.5-pro', [1.25, 10.0, 0.125, { threshold: 200000, input: 2.5, output: 15.0, cache_read: 0.25 }]],
  ['gemini-2.5-flash-lite', [0.1, 0.4, 0.01]],
  ['gemini-2.5-flash', [0.3, 2.5, 0.03]],
  ['gemini-2.0-flash-lite', [0.075, 0.3, 0.0075]],
  ['gemini-2.0-flash', [0.15, 0.6, 0.015]],
  ['claude-opus-5-5', [4.0, 20.0, 0.2]],
  ['claude-opus-5', [5.0, 25.0, 0.5]],
  ['claude-opus-4-8', [5.0, 25.0, 0.5]],
  ['claude-opus-4-7', [5.0, 25.0, 0.5]],
  ['claude-opus-4-6', [5.0, 25.0, 0.5]],
  ['claude-opus-4-5', [5.0, 25.0, 0.5]],
  ['claude-opus-4-1', [15.0, 75.0, 1.5]],
  ['claude-opus-4', [15.0, 75.0, 1.5]],
  ['claude-sonnet-5-5', [2.0, 10.0, 0.1]],
  ['claude-sonnet-5', [2.0, 10.0, 0.2]],
  ['claude-sonnet-4-6', [3.0, 15.0, 0.3]],
  ['claude-sonnet-4-5', [3.0, 15.0, 0.3]],
  ['claude-sonnet-4', [3.0, 15.0, 0.3]],
  ['claude-3-7-sonnet', [3.0, 15.0, 0.3]],
  ['claude-3-5-sonnet', [3.0, 15.0, 0.3]],
  ['claude-haiku-5-5', [0.1, 0.5, 0.01]],
  ['claude-haiku-4-5', [1.0, 5.0, 0.1]],
  ['claude-3-5-haiku', [0.8, 4.0, 0.08]],
  ['gpt-oss-120b', [0.15, 0.6, 0.075]],
  ['gpt-oss-20b', [0.05, 0.2, 0.025]],
];

// Unreleased / internal ids are estimated from the closest published family.
export const PREVIEW_FAMILY_FALLBACKS = [
  ['claude-opus', 'claude-opus-4-6'],
  ['claude-sonnet', 'claude-sonnet-4-6'],
  ['claude-haiku', 'claude-haiku-4-5'],
  ['neon', 'gemini-4-neon'],
  ['argon', 'gemini-4-argon'],
  ['carbon', 'gemini-4-carbon'],
  ['hydrogen', 'gemini-4-hydrogen'],
  ['gemini-flash', 'gemini-3.8-flash'],
  ['gemini', 'gemini-3.1-pro'],
];

const VER_DOT_RE = /(?<=\d)\.(?=\d)/g;
const normVer = (s) => s.replace(VER_DOT_RE, '-');
const normNum = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
export const LONG_CONTEXT_THRESHOLD = 200000;

// Optional long-context tier: prompts (input + cache read) above `threshold` tokens
// are billed at these prices instead (e.g. Gemini Pro models above 200k).
function extractTier(t) {
  if (!t || typeof t !== 'object') return null;
  const input = normNum(t.input);
  const output = normNum(t.output);
  if (input === null || output === null) return null;
  const cache = t.cache_read == null ? input * 0.1 : normNum(t.cache_read);
  if (cache === null) return null;
  const threshold = normNum(t.threshold) || LONG_CONTEXT_THRESHOLD;
  return { threshold, input, output, cache_read: cache };
}

function extractPrice(v) {
  if (Array.isArray(v) && (v.length === 3 || v.length === 4)) {
    const vals = v.slice(0, 3).map(normNum);
    if (!vals.every((x) => x !== null)) return null;
    const tier = v.length === 4 ? extractTier(v[3]) : null;
    return tier ? [...vals, tier] : vals;
  }
  if (v && typeof v === 'object') {
    const inp = normNum(v.input);
    const out = normNum(v.output);
    if (inp === null || out === null) return null;
    const rawCache = v.cache_read;
    const cache = rawCache == null ? inp * 0.1 : normNum(rawCache);
    if (cache === null) return null;
    const tier = extractTier(v.above_200k);
    return tier ? [inp, out, cache, tier] : [inp, out, cache];
  }
  return null;
}

/**
 * USD cost of one model call. `p` is a price from priceInfo(); input and cache read
 * together form the prompt, which decides whether the long-context tier applies.
 * `longContext` (boolean) overrides that decision for pre-aggregated rows, whose
 * summed prompt no longer says anything about the size of each call.
 */
export function costOf(p, inp = 0, out = 0, cacheRead = 0, longContext = null) {
  if (!p) return null;
  const i = normTokens(inp);
  const o = normTokens(out);
  const c = normTokens(cacheRead);
  const tier = p[3];
  const useTier = typeof longContext === 'boolean' ? longContext : (tier ? i + c > tier.threshold : false);
  if (tier && useTier) {
    return (i * tier.input + o * tier.output + c * tier.cache_read) / 1_000_000;
  }
  return (i * p[0] + o * p[1] + c * p[2]) / 1_000_000;
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
      if (p[3]) models[key].above_200k = { ...p[3] };
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
  return bestPrice ? { score: bestScore, price: bestPrice } : null;
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
  return bestPrice ? { score: bestScore, price: bestPrice } : null;
}

function lookupDirect(slug, customPrices) {
  const custom = lookupCustom(slug, customPrices);
  const builtin = lookupBuiltin(slug);
  if (custom && custom.score >= 5000) return custom.price;
  if (builtin && builtin.score >= 5000) return builtin.price;
  if (custom) return custom.price;
  return builtin ? builtin.price : null;
}

function previewTarget(slug) {
  if (slug.includes('embedding')) return null;
  if (slug.includes('claude')) {
    if (slug.includes('opus')) return 'claude-opus-4-6';
    if (slug.includes('sonnet')) return 'claude-sonnet-4-6';
    if (slug.includes('haiku')) return 'claude-haiku-4-5';
    return null;
  }
  if (slug.includes('gpt-oss')) return 'gpt-oss-120b';
  // Gemini 4 tiers keep their element name in internal ids, e.g. gemini-pro-orchestrator-neon.
  for (const tier of ['neon', 'argon', 'carbon', 'hydrogen']) {
    if (slug.includes(tier) && (slug.includes('gemini') || slug.includes('orchestrator'))) return `gemini-4-${tier}`;
  }
  if (slug.includes('gemini') || slug.includes('orchestrator')) {
    return slug.includes('flash') ? 'gemini-3.8-flash' : 'gemini-3.1-pro';
  }
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

function normTokens(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function callCostInfo(model, inp = 0, out = 0, cacheRead = 0, customPrices = null) {
  const [p, estimated] = priceInfo(model, customPrices);
  if (p === null) return [null, false];
  return [costOf(p, inp, out, cacheRead), estimated];
}

export function callCost(model, inp, out, cacheRead, customPrices = null) {
  return callCostInfo(model, inp, out, cacheRead, customPrices)[0];
}

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
    const tierIn = perMillion(m.input_cost_per_token_above_200k_tokens);
    const tierOut = perMillion(m.output_cost_per_token_above_200k_tokens);
    if (tierIn !== null && tierOut !== null) {
      const tierCache = perMillion(m.cache_read_input_token_cost_above_200k_tokens);
      out[id].above_200k = {
        threshold: LONG_CONTEXT_THRESHOLD,
        input: tierIn,
        output: tierOut,
        cache_read: tierCache !== null ? tierCache : Number((tierIn * 0.1).toFixed(6)),
      };
    }
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

export function fetchHttpsJson(url, timeoutMs = PRICING_TIMEOUT_MS, redirects = 3) {
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

export function readPricingMeta(pricingPathOrNow, nowArg = Date.now()) {
  let pricingPath = join(defaultDataDir(), 'pricing-cache.json');
  let now = nowArg;
  if (typeof pricingPathOrNow === 'number') {
    now = pricingPathOrNow;
  } else if (typeof pricingPathOrNow === 'string' && pricingPathOrNow) {
    pricingPath = expandHome(pricingPathOrNow);
  }
  try {
    if (!existsSync(pricingPath)) {
      return { source: 'builtin', fetched_at: null, count: 0, stale: true };
    }
    const raw = JSON.parse(readFileSync(pricingPath, 'utf8'));
    if (!raw || typeof raw !== 'object' || !raw.models || typeof raw.models !== 'object' || Array.isArray(raw.models)) {
      return { source: 'builtin', fetched_at: null, count: 0, stale: true };
    }
    const count = Object.keys(raw.models).length;
    const source = typeof raw.source === 'string' && raw.source.trim() ? raw.source.trim() : 'custom';
    const fetched_at = typeof raw.fetched_at === 'string' && !Number.isNaN(Date.parse(raw.fetched_at)) ? raw.fetched_at : null;
    const age = fetched_at ? now - Date.parse(fetched_at) : Infinity;
    const stale = count === 0 || !fetched_at || age >= PRICING_TTL_MS;
    return { source: count > 0 ? source : 'builtin', fetched_at, count, stale };
  } catch {
    return { source: 'builtin', fetched_at: null, count: 0, stale: true };
  }
}

export async function syncPricing(optsOrPath = {}) {
  const pricingPath = typeof optsOrPath === 'string' && optsOrPath
    ? expandHome(optsOrPath)
    : expandHome(optsOrPath?.pricingPath || join(defaultDataDir(), 'pricing-cache.json'));
  const timeoutMs = optsOrPath?.timeoutMs ?? PRICING_TIMEOUT_MS;
  const errors = [];
  const attempts = [
    ['litellm', PRICING_LITELLM_URL, parseLiteLLMPricing],
    ['openrouter', PRICING_OPENROUTER_URL, parseOpenRouterPricing],
  ];
  for (const [source, url, parse] of attempts) {
    try {
      const raw = await fetchHttpsJson(url, timeoutMs);
      const models = parse(raw);
      const count = Object.keys(models).length;
      if (count === 0) throw new Error('empty pricing table');
      const fetched_at = new Date().toISOString();
      writeJsonAtomic(pricingPath, { source, fetched_at, models });
      return { source, fetched_at, count, stale: false };
    } catch (err) {
      errors.push(`${source}: ${err.message}`);
    }
  }
  const meta = readPricingMeta(pricingPath);
  return { ...meta, error: 'failed', message: errors.join('; ') };
}
