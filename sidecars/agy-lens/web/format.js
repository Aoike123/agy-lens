// Shared pure formatting, pool/weekly quota math, and loader helpers for Agy Lens.
// Pure ES module: zero DOM or browser global references so it runs in Node.js 24+.

import { createTranslator } from './i18n.js';

export const CHEV = '<svg class="chev" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 2.5L8 6l-3.5 3.5"/></svg>';
export const CAL_POOLS = ['gemini', 'claude_gpt'];
export const TABS = ['overview', 'quota', 'history'];
export const PERIODS = ['today', 'd7', 'd30', 'all'];
export const HISTORY_VIEWS = ['totals', 'sessions', 'list'];
export const SESSION_PERIODS = ['all', 'd30', 'd7', 'today'];
export const LIST_SORTS = ['recent', 'tokens', 'calls'];
export const SOURCE_FILTERS = ['all', 'desktop', 'cli'];
export const QUOTA_STALE_MS = 60 * 1000;
export const HISTORY_STALE_MS = 60 * 1000;
export const CONV_VISIBLE = 8;
export const MODEL_VISIBLE = 5;

const DEFAULT_T = createTranslator('en');

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}[c]));

export const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
export const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
export const newTok = (x) => num(x && x.input) + num(x && x.output);
export const allTok = (x) => newTok(x) + num(x && x.cache_read);
export const isSubagent = (c) => Boolean(c && (c.is_subagent || String(c.title || '').startsWith('@')));

function resolveLoc(langOrLocale) {
  if (langOrLocale === 'zh-CN' || langOrLocale === 'zh') return 'zh-CN';
  return 'en';
}

export function fmtTok(n) {
  n = num(n);
  if (n >= 1e9) { const v = n / 1e9; return Number.isInteger(v) ? `${v}B` : `${v.toFixed(1)}B`; }
  if (n >= 1e6) { const v = n / 1e6; return Number.isInteger(v) ? `${v}M` : `${v.toFixed(1)}M`; }
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

export const fmtInt = (n, lang = 'en') => num(n).toLocaleString(resolveLoc(lang));
export const fmtTps = (v) => (isNum(v) ? v.toFixed(1) : '—');
export const fmtSec = (v) => (isNum(v) ? `${v.toFixed(2)}s` : '—');

export function fmtPctNum(p) {
  if (!isNum(p) || p <= 0) return '0%';
  if (p < 0.1) return '<0.1%';
  if (p >= 100) return `${Math.round(p)}%`;
  const s = p.toFixed(1);
  return `${s.endsWith('.0') ? s.slice(0, -2) : s}%`;
}

export function fmtDeltaPct(p) {
  if (!isNum(p)) return '';
  const r = Math.round(p * 10) / 10;
  if (r === 0) return '0%';
  const sign = r > 0 ? '+' : '-';
  const abs = Math.abs(r);
  if (abs >= 100) return `${sign}${Math.round(abs)}%`;
  const s = abs.toFixed(1);
  return `${sign}${s.endsWith('.0') ? s.slice(0, -2) : s}%`;
}

export const deltaLevel = (p) => (!isNum(p) ? '' : p <= -10 ? 'crit' : p < 0 ? 'warn' : p > 0 ? 'ok' : '');

export function fmtCycleSpan(startIso, endIso, lang = 'en') {
  const a = parseDate(startIso);
  const b = parseDate(endIso);
  if (!a && !b) return '—';
  const loc = resolveLoc(lang);
  const opts = lang === 'zh' ? { month: 'numeric', day: 'numeric' } : { month: 'short', day: 'numeric' };
  const fa = a ? a.toLocaleDateString(loc, opts) : '?';
  const fb = b ? b.toLocaleDateString(loc, opts) : '?';
  return `${fa} – ${fb}`;
}

export function fmtUsd(v) {
  if (!isNum(v)) return '';
  if (v > 0 && v < 0.01) return '<$0.01';
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function fmtCost(v, { estimated = false, partial = false } = {}) {
  if (!isNum(v)) return '';
  const prefix = partial ? '≥' : (estimated ? '≈' : '');
  return `${prefix}${fmtUsd(v)}`;
}

export function pricingSourceName(src, t = DEFAULT_T) {
  if (src === 'litellm') return 'LiteLLM';
  if (src === 'openrouter') return 'OpenRouter';
  return t('pricingBuiltin');
}

export function pricingTip(src, fetchedAt, { partial = false } = {}, t = DEFAULT_T, lang = t.lang || 'en') {
  const parts = [t('pricingSrc', pricingSourceName(src, t))];
  if (fetchedAt) parts.push(fmtTime(fetchedAt, true, lang));
  parts.push(t('pricingEstNote'));
  if (partial) parts.push(t('pricingPartialNote'));
  return parts.join(' · ');
}

export const budgetLevel = (ratio) => (ratio >= 0.95 ? 'crit' : ratio >= 0.8 ? 'warn' : '');

export function parseDate(iso) {
  const d = new Date(iso);
  return iso && !Number.isNaN(d.getTime()) ? d : null;
}

export const tsOf = (iso) => {
  const d = parseDate(iso);
  return d ? d.getTime() : -Infinity;
};

export function fmtTime(iso, withDate = false, lang = 'en') {
  const d = parseDate(iso);
  if (!d) return '—';
  const opts = { hour: '2-digit', minute: '2-digit' };
  if (withDate) Object.assign(opts, { month: 'short', day: 'numeric' });
  return d.toLocaleString(resolveLoc(lang), opts);
}

export function fmtAgo(iso, lang = 'en', nowMs = Date.now()) {
  const d = parseDate(iso);
  if (!d) return '—';
  const loc = resolveLoc(lang);
  const sec = Math.round((d.getTime() - nowMs) / 1000);
  const rtf = new Intl.RelativeTimeFormat(loc, { numeric: 'auto' });
  const a = Math.abs(sec);
  if (a < 60) return rtf.format(Math.round(sec), 'second');
  if (a < 3600) return rtf.format(Math.round(sec / 60), 'minute');
  if (a < 86400) return rtf.format(Math.round(sec / 3600), 'hour');
  if (a < 86400 * 30) return rtf.format(Math.round(sec / 86400), 'day');
  return d.toLocaleDateString(loc, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function fmtDuration(ms, tOrUnits = DEFAULT_T, lang) {
  if (!isNum(ms)) return '—';
  const isFn = typeof tOrUnits === 'function';
  const u = isFn ? tOrUnits('dur') : (tOrUnits || DEFAULT_T('dur'));
  const resolvedLang = lang || (isFn && tOrUnits.lang) || 'en';
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const sp = resolvedLang === 'zh' ? '' : ' ';
  if (d) return `${d}${u.d}${sp}${h}${u.h}`;
  if (h) return `${h}${u.h}${sp}${m}${u.m}`;
  if (m) return `${m}${u.m}${sp}${sec}${u.s}`;
  return `${sec}${u.s}`;
}

export const errorBox = (title, msg) => `<div class="error" role="alert"><b>${esc(title)}</b>${msg ? esc(msg) : ''}</div>`;

export const parseDay = (s) => {
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
};

export const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function periodCutoff(p, now = new Date()) {
  if (p === 'all') return -Infinity;
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (p === 'today') return base.getTime();
  if (p === 'd7') { base.setDate(base.getDate() - 6); return base.getTime(); }
  if (p === 'd30') { base.setDate(base.getDate() - 29); return base.getTime(); }
  return -Infinity;
}

export function makeHeatScale(values) {
  const nz = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (!nz.length) return () => 0;
  const q = (p) => nz[Math.min(nz.length - 1, Math.floor(p * nz.length))];
  const cuts = [q(0.25), q(0.5), q(0.75)];
  return (v) => (v <= 0 ? 0 : v <= cuts[0] ? 1 : v <= cuts[1] ? 2 : v <= cuts[2] ? 3 : 4);
}

// The CLI's cell allocation: at least one cell per non-empty segment, scaled down on overflow.
export function gridCells(segments, limit, total) {
  let counts = segments.map((n) => (!n || !limit ? 0 : Math.max(1, Math.floor(n / limit * total))));
  const used = counts.reduce((a, b) => a + b, 0);
  if (used > total) counts = counts.map((c) => Math.floor(c * total / used));
  return [...counts, total - counts.reduce((a, b) => a + b, 0)];
}

export function clampPct(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n * 10) / 10 : null;
}

export function inferPool(id) {
  const s = String(id || '').toLowerCase();
  if (s.includes('claude') || s.includes('anthropic') || s.includes('gpt') || s.includes('openai')) return 'claude_gpt';
  if (s.includes('gemini') || s.includes('orchestrator')) return 'gemini';
  return 'other';
}

export const fraction = (v) => (isNum(v) ? Math.min(1, Math.max(0, v)) : null);
export const levelOf = (f) => (f == null ? 'unknown' : f < 0.05 ? 'crit' : f < 0.2 ? 'warn' : '');
export const pctText = (f) => {
  if (f == null) return '—';
  const p = f * 100;
  if (p > 0 && p < 10) {
    const s = p.toFixed(1);
    return `${s.endsWith('.0') ? s.slice(0, -2) : s}%`;
  }
  return `${Math.round(p)}%`;
};
export const isUnlimited = (l) => l.kind === 'none' || (!l.reset_time && l.f != null && l.f >= 1);

export function resetText(iso, t = DEFAULT_T, lang = t.lang || 'en', nowMs = Date.now()) {
  const d = parseDate(iso);
  if (!d) return t('noReset');
  const left = d.getTime() - nowMs;
  return left <= 0 ? t('resetPassed') : t('resetIn', fmtDuration(left, t, lang));
}

export function liveWeeklyEntry(quotaData, pool) {
  const w = quotaData && !quotaData.error && quotaData.weekly;
  const e = w && w[pool];
  if (!e || !isNum(e.remaining_fraction)) return null;
  const f = Math.min(1, Math.max(0, e.remaining_fraction));
  const left = Math.round(f * 1000) / 10;
  return { left, used: Math.round((100 - left) * 10) / 10, reset_time: e.reset_time || null, live: true };
}

export const effectiveWeekly = (quotaData, pool) => liveWeeklyEntry(quotaData, pool);
export const hasAnyWeekly = (quotaData) => CAL_POOLS.some((k) => liveWeeklyEntry(quotaData, k) != null);
export const hasAnyWeeklyValue = (weeklyValueUsd) => CAL_POOLS.some((k) => num(weeklyValueUsd && weeklyValueUsd[k]) > 0);

/** Size an USD spend against a pool's implied 100% weekly quota value (unclamped). */
export function costWeeklyPct(costUsd, pool, weeklyValueUsd) {
  const val = num(weeklyValueUsd && weeklyValueUsd[pool]);
  if (!isNum(costUsd) || costUsd <= 0 || val <= 0) return null;
  return (costUsd / val) * 100;
}

/** Estimate a model's total spend as % of one weekly quota of its pool. */
export function modelWeeklyLabel(m, { compact = true, weeklyValueUsd = null, t = DEFAULT_T } = {}) {
  const pool = (m && m.pool) || inferPool((m && m.ids && m.ids[0]) || (m && m.name));
  const pct = costWeeklyPct(m && m.est_cost_usd, pool, weeklyValueUsd);
  if (pct != null) return t('ofPoolQuota', fmtPctNum(pct));
  return compact ? '' : t('weeklyPending');
}

/** Label for one pool row inside conversation/session detail: spend ÷ pool weekly value. */
export function poolRowLabel(c, pk, { weeklyValueUsd = null, t = DEFAULT_T } = {}) {
  const pct = costWeeklyPct(c && c.cost_by_pool && c.cost_by_pool[pk], pk, weeklyValueUsd);
  return pct != null ? t('ofPoolQuota', fmtPctNum(pct)) : '';
}

/**
 * A conversation seen with all its subagents: own fields replaced by the
 * subtree totals from the backend (`total`). Conversations without subagents
 * are returned as-is.
 */
export function withSubtree(c) {
  if (!c || !c.total || !num(c.total.subagents)) return c;
  const tot = c.total;
  let pool = c.pool || 'other';
  if (tot.cost_by_pool && typeof tot.cost_by_pool === 'object') {
    let bestPool = null;
    let bestCost = 0;
    for (const pk of Object.keys(tot.cost_by_pool)) {
      const v = num(tot.cost_by_pool[pk]);
      if (v > bestCost || (v > 0 && v === bestCost && pk === pool)) {
        bestCost = v;
        bestPool = pk;
      }
    }
    if (bestPool) pool = bestPool;
  }
  return {
    ...c,
    pool,
    input: tot.input,
    output: tot.output,
    cache_read: tot.cache_read,
    thinking: tot.thinking,
    calls: tot.calls,
    d7_tokens: tot.d7_tokens,
    d7_by_pool: tot.d7_by_pool,
    cost_by_pool: tot.cost_by_pool,
    est_cost_usd: tot.est_cost_usd,
    cost_estimated: tot.cost_estimated,
    cost_partial: tot.cost_partial,
    last_at: tot.last_at || c.last_at,
    self: c,
  };
}

/**
 * Estimate a conversation's (or subtree's) size relative to one official
 * weekly quota: `pool_cost / pool_weekly_value_usd`. Never falls back to 7-day
 * token share when official weekly valuation is unavailable.
 */
export function convWeeklyLabel(c, { compact = true, weeklyValueUsd = null, t = DEFAULT_T } = {}) {
  if (!c) return compact ? '' : t('weeklyPending');
  const primary = (c && c.pool) || inferPool((c && c.model) || (c && c.display_name));
  const cPools = c.cost_by_pool;
  if (cPools && typeof cPools === 'object') {
    const own = costWeeklyPct(cPools[primary], primary, weeklyValueUsd);
    if (own != null) return t('ofPoolQuota', fmtPctNum(own));
    let best = null;
    for (const pk of CAL_POOLS) {
      const pct = costWeeklyPct(cPools[pk], pk, weeklyValueUsd);
      if (pct != null && (best === null || num(cPools[pk]) > num(cPools[best[0]]))) {
        best = [pk, pct];
      }
    }
    if (best) return t('ofPoolQuota', fmtPctNum(best[1]));
  }
  const direct = CAL_POOLS.includes(primary) ? costWeeklyPct(c.est_cost_usd, primary, weeklyValueUsd) : null;
  if (direct != null) return t('ofPoolQuota', fmtPctNum(direct));
  return compact ? '' : t('weeklyPending');
}

/** Slice by_model rows to a given period (`today` | `d7` | `d30` | `all`), dropping unused models. */
export function sliceModelsForPeriod(list, period = 'all') {
  const out = [];
  for (const m of Array.isArray(list) ? list : []) {
    if (!m || typeof m !== 'object') continue;
    const p = m.periods && typeof m.periods === 'object' && m.periods[period] && typeof m.periods[period] === 'object'
      ? m.periods[period]
      : null;
    if (!p) {
      out.push(m);
      continue;
    }
    const input = num(p.input);
    const output = num(p.output);
    const cacheRead = num(p.cache_read);
    const calls = num(p.calls);
    if (calls <= 0 && input + output + cacheRead <= 0) continue;
    const hasCost = Object.prototype.hasOwnProperty.call(p, 'est_cost_usd');
    const estCost = hasCost ? p.est_cost_usd : (period === 'all' ? m.est_cost_usd : null);
    const estFlag = Object.prototype.hasOwnProperty.call(p, 'cost_estimated') ? Boolean(p.cost_estimated) : Boolean(m.cost_estimated);
    const partFlag = Object.prototype.hasOwnProperty.call(p, 'cost_partial') ? Boolean(p.cost_partial) : Boolean(m.cost_partial);
    out.push({
      ...m,
      input,
      output,
      cache_read: cacheRead,
      thinking: Object.prototype.hasOwnProperty.call(p, 'thinking') ? num(p.thinking) : num(m.thinking),
      calls,
      est_cost_usd: estCost,
      cost_estimated: estFlag,
      cost_partial: partFlag,
    });
  }
  return out;
}

/** Merge duplicate display names so raw model variants never clutter inline rows. */
export function mergeModels(list) {
  const map = new Map();
  for (const m of Array.isArray(list) ? list : []) {
    if (!m) continue;
    const name = String(m.display_name || m.model || '?').trim();
    let g = map.get(name);
    if (!g) {
      g = {
        name,
        ids: [],
        pool: m.pool || inferPool(m.model || name),
        input: 0,
        output: 0,
        cache_read: 0,
        thinking: 0,
        calls: 0,
        d7_tokens: null,
        est_cost_usd: null,
        cost_estimated: false,
        cost_partial: false,
      };
      map.set(name, g);
    }
    if (m.model && !g.ids.includes(m.model)) g.ids.push(m.model);
    g.input += num(m.input);
    g.output += num(m.output);
    g.cache_read += num(m.cache_read);
    g.thinking += num(m.thinking);
    g.calls += num(m.calls);
    if (isNum(m.d7_tokens)) g.d7_tokens = (g.d7_tokens || 0) + m.d7_tokens;
    if (isNum(m.est_cost_usd)) g.est_cost_usd = (g.est_cost_usd || 0) + m.est_cost_usd;
    else if (num(m.calls) > 0) g.cost_partial = true;
    if (m.cost_estimated) g.cost_estimated = true;
    if (m.cost_partial) g.cost_partial = true;
  }
  return [...map.values()].sort((a, b) => allTok(b) - allTok(a) || newTok(b) - newTok(a));
}

export async function getJson(path, query, fetchFn) {
  if (typeof fetchFn !== 'function') throw new Error('fetch function required');
  const qs = new URLSearchParams(query || {}).toString();
  const res = await fetchFn(qs ? `${path}?${qs}` : path);
  return res.json();
}

export function makeLoader(path, staleMs, { getJson: getJsonFn, paint, keyOf, onMeta, onSilent, onBusyChange }) {
  const st = { data: null, lastKey: '', loading: false, manual: false, error: null, loadedAt: 0 };
  st.load = async ({ refresh = false, silent = false } = {}) => {
    if (st.loading) return;
    const bg = silent && Boolean(st.data);
    st.loading = true;
    st.manual = !bg;
    if (!bg) st.error = null;
    if (onBusyChange) onBusyChange();
    if (!bg) paint();
    try {
      const data = await getJsonFn(path, refresh ? { refresh: 'true' } : null);
      if (!data || typeof data !== 'object') throw new Error('invalid response');
      st.loadedAt = Date.now();
      if (bg && data.error && st.data && !st.data.error) return;
      const nextKey = keyOf(data);
      const changed = nextKey !== st.lastKey || Boolean(st.error);
      st.data = data;
      st.lastKey = nextKey;
      st.error = null;
      if (bg) {
        if (changed) onSilent(data);
        else onMeta(data);
      }
    } catch (err) {
      if (!bg) st.error = (err && err.message) || String(err);
    } finally {
      st.loading = false;
      st.manual = false;
      if (onBusyChange) onBusyChange();
      if (!bg) paint();
    }
  };
  st.open = () => {
    if (!st.data) {
      if (!st.loading) st.load({ refresh: false, silent: false });
      else paint();
    } else {
      paint();
      if (!st.loading && Date.now() - st.loadedAt > staleMs) st.load({ refresh: false, silent: true });
    }
  };
  return st;
}
