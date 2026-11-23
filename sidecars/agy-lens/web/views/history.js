// History tab renderer (totals, sessions, list, calibration, pricing sync, share card) and controller for Agy Lens.

import { createTranslator, localeFor } from '../i18n.js';
import {
  allTok,
  budgetLevel,
  CHEV,
  CONV_VISIBLE,
  convWeeklyLabel,
  dayKey,
  errorBox,
  esc,
  fmtAgo,
  fmtCost,
  fmtInt,
  fmtPctNum,
  fmtTime,
  fmtTok,
  fmtUsd,
  formatPoolName,
  hasAnyWeeklyValue,
  HISTORY_STALE_MS,
  HISTORY_VIEWS,
  isNum,
  isSubagent,
  knownQuotaPools,
  LIST_SORTS,
  liveWeeklyEntry,
  makeHeatScale,
  makeLoader,
  mergeModels,
  MODEL_VISIBLE,
  modelWeeklyLabel,
  newTok,
  num,
  parseDay,
  periodCostByPool,
  periodCutoff,
  PERIODS,
  periodWeeklySummary,
  pricingSourceName,
  poolRowLabel,
  pricingTip,
  SESSION_PERIODS,
  sliceModelsForPeriod,
  sortActivePools,
  SOURCE_FILTERS,
  tsOf,
  withSubtree,
} from '../format.js';
import { openShareCardModal, refreshShareCardModal } from './share-card.js';

const HEAT_ALL_MIN_WEEKS = 26;
const HEAT_ALL_MAX_WEEKS = 52;
const SHARE_ICON = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2.5v7.5"/><path d="M5 5.5L8 2.5l3 3"/><path d="M3 10.5v2a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-2"/></svg>';

export function historyKey(d) {
  if (!d || typeof d !== 'object') return '';
  const { scanned_at: _s, elapsed_ms: _e, ...rest } = d;
  return JSON.stringify(rest);
}

export function matchesQuery(c, q) {
  if (!q) return true;
  if (String(c.title || '').toLowerCase().includes(q)) return true;
  if (String(c.display_name || '').toLowerCase().includes(q)) return true;
  if (String(c.model || '').toLowerCase().includes(q)) return true;
  if (String(c.id || '').toLowerCase().includes(q)) return true;
  if (Array.isArray(c.by_model)) {
    return c.by_model.some((m) => String((m && m.display_name) || '').toLowerCase().includes(q)
      || String((m && m.model) || '').toLowerCase().includes(q));
  }
  return false;
}

function periodRowHtml(data, { period = 'd30', pricingSyncing = false, t, lang = 'en' }) {
  const pills = PERIODS.map((k) => {
    const on = k === period;
    return `<button class="pill" type="button" role="tab" data-period="${k}" aria-selected="${on}" tabindex="${on ? 0 : -1}">${esc(t('periodPills')[k])}</button>`;
  }).join('');
  const tip = pricingTip(data && data.pricing_source, data && data.pricing_fetched_at, {}, t, lang);
  const share = `<button class="share-btn" type="button" data-share-card title="${esc(t('shareCardTip'))}">${SHARE_ICON}<span>${esc(t('shareCard'))}</span></button>`;
  const sync = `<button type="button" class="sync-btn" data-sync-prices ${pricingSyncing ? 'disabled' : ''} title="${esc(tip)}">${pricingSyncing ? `<span class="spin"></span>${esc(t('syncingPrices'))}` : esc(t('syncPrices'))}</button>`;
  return `<div class="period-row"><div class="period-bar" role="tablist" aria-label="${esc(t('periodBarAria'))}">${pills}</div><div class="period-actions">${share}${sync}</div></div>`;
}

export function renderTotalsHeroHtml(data, { period = 'd30', quotaData = null, pricingSyncing = false, pricingNotice = null, t = createTranslator('en'), lang = 'en' } = {}) {
  const tot = (data && data.totals) || {};
  const p = tot[period] || {};
  const costPartial = Boolean(p.cost_partial)
    || (period === 'all' && Array.isArray(data && data.by_model) && data.by_model.some((m) => num(m.calls) > 0 && !isNum(m.est_cost_usd)));
  const costStr = fmtCost(p.est_cost_usd, { estimated: !!p.cost_estimated, partial: costPartial && isNum(p.est_cost_usd) });
  const costTip = pricingTip(data && data.pricing_source, data && data.pricing_fetched_at, { partial: costPartial }, t, lang);
  const pc = t('poolCompact');
  const weeklyValueUsd = (data && data.weekly_value_usd) || {};
  const poolList = knownQuotaPools(quotaData && !quotaData.error ? quotaData.weekly : null, weeklyValueUsd);
  const liveEntries = poolList.map((k) => ({ k, eff: liveWeeklyEntry(quotaData, k) })).filter((x) => x.eff != null);
  const hasVal = hasAnyWeeklyValue(weeklyValueUsd);
  const valParts = poolList.filter((k) => num(weeklyValueUsd[k]) > 0).map((k) => `${formatPoolName(k, pc)} ${fmtUsd(num(weeklyValueUsd[k]))}`);

  const statusLabel = liveEntries.length ? t('liveSynced') : hasVal ? t('weeklyCached') : t('weeklyOffline');
  let liveCls = '';
  if (liveEntries.length) {
    const worst = Math.max(...liveEntries.map((x) => x.eff.used));
    const lvl = budgetLevel(worst / 100);
    liveCls = lvl === 'crit' ? 'txt-crit' : lvl === 'warn' ? 'txt-warn' : '';
  }

  const hasPeriodUsage = num(p.calls) > 0 || allTok(p) > 0 || (isNum(p.est_cost_usd) && p.est_cost_usd > 0);
  const quotaCalibration = (data && data.quota_calibration) || null;
  const periodWeekly = hasPeriodUsage ? periodWeeklySummary(data && data.by_model, period, weeklyValueUsd, quotaCalibration) : [];

  let quotaVal;
  let quotaSub = '';
  let weeklyPoolsRow = '';
  if (periodWeekly.length) {
    const top = periodWeekly[0];
    const estParts = periodWeekly.map((x) => `${formatPoolName(x.pool, pc)} ≈ ${fmtPctNum(x.pct)} (${fmtUsd(x.cost)})`);
    const tipParts = [t('periodWeeklyTip', estParts.join(' · '), statusLabel)];
    if (valParts.length) tipParts.push(t('weeklyRefTip', valParts.join(' · ')));
    const tip = tipParts.join('\n');
    quotaVal = `<button type="button" class="inline-link on" data-go-tab="quota" title="${esc(tip)}">≈ ${esc(fmtPctNum(top.pct))}</button>`;
    quotaSub = `<div class="hero-stat-sub ellipsis" title="${esc(tip)}">${esc(formatPoolName(top.pool, pc))} · <span${liveCls ? ` class="${liveCls}"` : ''}>${esc(statusLabel)}</span></div>`;
    if (periodWeekly.length >= 2) {
      weeklyPoolsRow = `<div class="hero-weekly-pools num" title="${esc(t('weeklySizeTip'))}">
        <span class="dim">${esc(t('weeklyEstPools'))}</span>
        <span>${periodWeekly.map((x) => `${esc(formatPoolName(x.pool, pc))} <b>≈ ${esc(fmtPctNum(x.pct))}</b>`).join('<span class="dim"> · </span>')}</span>
      </div>`;
    }
  } else if (liveEntries.length) {
    const activeCostPools = hasPeriodUsage ? Object.keys(periodCostByPool(data && data.by_model, period).cost_by_pool) : [];
    const cyclesMap = (data && data.weekly_cycles) || {};
    const isSampling = activeCostPools.some((pk) => Array.isArray(cyclesMap[pk]) && cyclesMap[pk].some((cy) => cy && cy.is_current && !isNum(cy.weekly_value_usd)));
    if (isSampling) {
      const tip = t('weeklyEstimatingTip');
      quotaVal = `<button type="button" class="inline-link" data-go-tab="quota" title="${esc(tip)}">${esc(t('weeklyEstimating'))}</button>`;
      quotaSub = `<div class="hero-stat-sub ellipsis" title="${esc(tip)}"><span${liveCls ? ` class="${liveCls}"` : ''}>${esc(statusLabel)}</span></div>`;
    } else {
      const tip = valParts.length ? t('weeklyRefTip', valParts.join(' · ')) : t('liveWeeklyTip');
      quotaVal = `<button type="button" class="inline-link on${liveCls ? ` ${liveCls}` : ''}" data-go-tab="quota" title="${esc(tip)}">${esc(statusLabel)}</button>`;
    }
  } else if (hasVal) {
    const tip = valParts.length ? t('weeklyRefTip', valParts.join(' · ')) : t('weeklyCachedTip');
    quotaVal = `<button type="button" class="inline-link on" data-go-tab="quota" title="${esc(tip)}">${esc(statusLabel)}</button>`;
  } else {
    quotaVal = `<button type="button" class="inline-link" data-go-tab="quota" title="${esc(t('weeklyOfflineTip'))}">${esc(statusLabel)}</button>`;
  }

  const syncNote = pricingNotice
    ? `<div id="history-sync-note" class="sync-note ${pricingNotice.ok ? 'ok' : 'err'}">${esc(pricingNotice.text)}</div>`
    : '<div id="history-sync-note" class="sync-note" hidden></div>';
  return `${periodRowHtml(data, { period, pricingSyncing, t, lang })}${syncNote}
    <div class="hero">
      <div class="fig num" title="${esc(fmtInt(newTok(p), lang))}">${fmtTok(newTok(p))}<span class="unit">${esc(t('tokens'))}</span></div>
      <div class="sub num">${esc(t('exclCache'))} · ${esc(t('convsCount', fmtInt(p.conversations, lang)))}</div>
    </div>
    <div class="hero-stats">
      <div><div class="lbl">${esc(t('legInput'))}</div><div class="v num" title="${esc(fmtInt(p.input, lang))}">${fmtTok(p.input)}</div></div>
      <div><div class="lbl">${esc(t('legOutput'))}</div><div class="v num" title="${esc(fmtInt(p.output, lang))}">${fmtTok(p.output)}</div></div>
      <div><div class="lbl">${esc(t('legCache'))}</div><div class="v num" title="${esc(fmtInt(p.cache_read, lang))}">${fmtTok(p.cache_read)}</div></div>
      <div><div class="lbl">${esc(t('colCalls'))}</div><div class="v num">${fmtInt(p.calls, lang)}</div></div>
      <div title="${esc(costTip)}"><div class="lbl">${esc(t('colCost'))}</div><div class="v num">${costStr ? esc(costStr) : '<span class="dim">—</span>'}</div></div>
      <div><div class="lbl">${esc(t('weeklyQuota'))}</div><div class="v num">${quotaVal}</div>${quotaSub}</div>
    </div>${weeklyPoolsRow}`;
}

export function hasCliSources(data) {
  const src = (data && data.sources) || {};
  if (num(src.cli) > 0) return true;
  const all = Array.isArray(data && data.by_conversation) ? data.by_conversation : [];
  return all.some((c) => c && c.source && c.source !== 'desktop');
}

const CHILD_VISIBLE = 40;
let convIndexCache = { data: null, map: new Map() };
function convIndex(data) {
  if (convIndexCache.data !== data) {
    const map = new Map();
    for (const c of (data && data.by_conversation) || []) if (c && c.id) map.set(String(c.id), c);
    convIndexCache = { data, map };
  }
  return convIndexCache.map;
}

const sourceLabel = (s, t) => (s && t('sourceNames')[s]) || s || '';

function convDisplayTitle(c, t) {
  const title = c && c.title ? String(c.title) : '';
  return title || `${t('untitled')} · ${String((c && c.id) || '').slice(0, 8)}`;
}

// Direct subagents of a conversation, by usage of their own subtree.
function childrenOf(c, data) {
  const ids = Array.isArray(c && c.children) ? c.children : [];
  if (!ids.length) return [];
  const idx = convIndex(data);
  return ids.map((id) => idx.get(id)).filter(Boolean)
    .sort((a, b) => newTok(withSubtree(b)) - newTok(withSubtree(a)) || tsOf(withSubtree(b).last_at) - tsOf(withSubtree(a).last_at));
}

function childListHtml(c, data, maxTok, ctx) {
  const { t } = ctx;
  const kids = childrenOf(c, data);
  const total = Array.isArray(c.children) ? c.children.length : 0;
  const rows = kids.slice(0, CHILD_VISIBLE).map((k, i) => convItemHtml(k, i, maxTok, data, { ...ctx, tree: true, showSubBadge: false, parentTitle: '' })).join('');
  const hidden = total - Math.min(kids.length, CHILD_VISIBLE);
  const note = hidden > 0 ? `<p class="note conv-children-note">${esc(t('moreChildren', hidden))}</p>` : '';
  return rows ? `<ul class="conv-list conv-children">${rows}</ul>${note}` : note;
}

function convDetailHtml(c, data, { tree = false, maxTok = 0, openKeys, t, lang } = {}) {
  const weeklyValueUsd = (data && data.weekly_value_usd) || null;
  const totalIn = num(c.input) + num(c.cache_read);
  const hit = totalIn > 0 ? `${(num(c.cache_read) / totalIn * 100).toFixed(0)}%` : '—';
  const think = isNum(c.thinking) ? fmtTok(c.thinking) : '—';
  const first = c.first_at ? fmtTime(c.first_at, true, lang) : '';
  const last = c.last_at ? fmtTime(c.last_at, true, lang) : '';
  const spanText = first && last && first !== last ? t('span', first, last) : (last || first);
  const metaBits = [];
  if (c.source) metaBits.push(esc(sourceLabel(c.source, t)));
  if (isSubagent(c)) metaBits.push(esc(t('agentSub')));
  if (c.id) metaBits.push(`<span class="mono" title="${esc(c.id)}">${esc(String(c.id).slice(0, 8))}</span>`);
  const costStr = fmtCost(c.est_cost_usd, { estimated: !!c.cost_estimated, partial: !!c.cost_partial && isNum(c.est_cost_usd) });
  const costTip = pricingTip(data && data.pricing_source, data && data.pricing_fetched_at, { partial: !!c.cost_partial }, t, lang);
  const costRow = costStr
    ? `<div class="conv-row"><span class="lbl">${esc(t('colCost'))}</span><span class="num" title="${esc(costTip)}">${esc(costStr)}</span></div>`
    : '';
  const quotaCalibration = (data && data.quota_calibration) || null;
  const wVal = convWeeklyLabel(c, { compact: false, weeklyValueUsd, quotaCalibration, t });
  const cPools = c.cost_by_pool || {};
  const activePools = sortActivePools(c, weeklyValueUsd, quotaCalibration);
  const pn = t('poolShort');
  const poolRows = activePools.length > 1
    ? `<div class="conv-models"><ul class="mini">${activePools.map((pk) => {
      const cost = num(cPools[pk]);
      const lbl = poolRowLabel(c, pk, { weeklyValueUsd, quotaCalibration, t });
      return `<li><span class="dim">${esc(formatPoolName(pk, pn))}</span><span class="num dim">${esc(fmtUsd(cost))}${lbl ? ` · ${esc(lbl)}` : ''}</span></li>`;
    }).join('')}</ul></div>`
    : '';
  // Hierarchy: this conversation's own usage vs. its subagents (all levels).
  const self = c.self || null;
  const subN = num(c.total && c.total.subagents);
  let treeRows = '';
  if (subN > 0) {
    const own = self || c;
    const ownCost = fmtCost(own.est_cost_usd, { estimated: !!own.cost_estimated, partial: !!own.cost_partial && isNum(own.est_cost_usd) });
    const tot = c.total;
    const subCostVal = isNum(tot.est_cost_usd) ? tot.est_cost_usd - num(own.est_cost_usd) : null;
    const subCost = fmtCost(subCostVal, { estimated: !!tot.cost_estimated, partial: !!tot.cost_partial && isNum(subCostVal) });
    const subTok = newTok(tot) - newTok(own);
    treeRows = `<div class="conv-models conv-tree"><div class="lbl">${esc(t('usageLevels'))}</div><ul class="mini">
      <li><span>${esc(t('selfUsage'))}</span><span class="num dim">${fmtTok(newTok(own))}${ownCost ? ` · ${esc(ownCost)}` : ''}</span></li>
      <li><span>${esc(t('subagentsUsage', fmtInt(subN, lang)))}</span><span class="num dim">${fmtTok(subTok)}${subCost ? ` · ${esc(subCost)}` : ''}</span></li>
    </ul></div>`;
  }
  const kidsSlot = tree && Array.isArray(c.children) && c.children.length
    ? (() => {
      const key = `conv:${c.id}`;
      const filled = openKeys && openKeys.has(key);
      return `<div class="conv-kids" data-children-of="${esc(c.id)}" data-max-tok="${maxTok}"${filled ? ' data-filled="1"' : ''}>${filled ? childListHtml(c, data, maxTok, { openKeys, t, lang }) : ''}</div>`;
    })()
    : '';
  const mergedModels = mergeModels(c.by_model);
  const models = mergedModels.length
    ? `<div class="conv-models"><div class="lbl">${esc(subN > 0 ? t('byModelSelf') : t('byModel'))}</div><ul class="mini">${mergedModels.map((m) => {
      const mc = fmtCost(m.est_cost_usd, { estimated: m.cost_estimated, partial: m.cost_partial && isNum(m.est_cost_usd) });
      return `<li><span class="ellipsis" title="${esc(m.ids.join(', ') || m.name)}">${esc(m.name)}</span>
        <span class="num dim">${fmtTok(newTok(m))}${mc ? ` · ${esc(mc)}` : ` · ${esc(t('calls', fmtInt(m.calls, lang)))}`}</span></li>`;
    }).join('')}</ul></div>`
    : '';
  return `<div class="conv-detail">
    <div class="conv-kv">
      <div><div class="lbl">${esc(t('legInput'))}</div><div class="v num" title="${esc(fmtInt(c.input, lang))}">${fmtTok(c.input)}</div></div>
      <div><div class="lbl">${esc(t('legOutput'))}</div><div class="v num" title="${esc(fmtInt(c.output, lang))}">${fmtTok(c.output)}</div></div>
      <div><div class="lbl">${esc(t('legCache'))}</div><div class="v num" title="${esc(fmtInt(c.cache_read, lang))}">${fmtTok(c.cache_read)}</div></div>
      <div><div class="lbl">${esc(t('legThinking'))}</div><div class="v num" title="${isNum(c.thinking) ? esc(fmtInt(c.thinking, lang)) : ''}">${think}</div></div>
      <div><div class="lbl">${esc(t('cacheHit'))}</div><div class="v num">${hit}</div></div>
      <div><div class="lbl">${esc(t('colCalls'))}</div><div class="v num">${fmtInt(c.calls, lang)}</div></div>
    </div>
    ${costRow}
    <div class="conv-row" title="${esc(t('weeklySizeTip'))}"><span class="lbl">${esc(t('weeklyQuota'))}</span><span class="num">${esc(wVal)}</span></div>
    ${poolRows}
    ${spanText ? `<div class="conv-foot num">${esc(spanText)}</div>` : ''}
    ${metaBits.length ? `<div class="conv-foot num">${metaBits.join(' · ')}</div>` : ''}
    ${treeRows}
    ${models}
    ${kidsSlot}
  </div>`;
}

// tree: show the conversation with all its subagents (totals) and let it
// expand into its direct subagents; otherwise its own usage only.
function convItemHtml(raw, i, maxTok, data, { tree = false, parentTitle = '', showSubBadge = false, openKeys, t, lang } = {}) {
  const c = tree ? withSubtree(raw) : raw;
  const id = String(c.id || i);
  const key = `conv:${id}`;
  const title = c.title ? String(c.title) : '';
  const muted = !title || title.startsWith('@') || Boolean(c.is_subagent);
  const shown = title || `${t('untitled')} · ${id.slice(0, 8)}`;
  const subN = num(raw.total && raw.total.subagents);
  const agentTag = raw.agent && raw.agent !== 'self' && raw.parent_id && !title.startsWith('@') ? `@${raw.agent}` : '';
  const parentBit = parentTitle ? t('subagentOf', parentTitle) : '';
  const treeTag = subN > 0
    ? (tree ? t('inclSubs', fmtInt(subN, lang)) : t('treeTotal', fmtInt(subN, lang), fmtCost(raw.total.est_cost_usd, { estimated: !!raw.total.cost_estimated }) || fmtTok(newTok(raw.total))))
    : '';
  const subLeft = [agentTag, parentBit, c.display_name || c.model, treeTag, fmtAgo(c.last_at, lang)].filter(Boolean).join(' · ');
  const wTag = convWeeklyLabel(c, {
    compact: true,
    weeklyValueUsd: (data && data.weekly_value_usd) || null,
    quotaCalibration: (data && data.quota_calibration) || null,
    t,
  });
  const costStr = fmtCost(c.est_cost_usd, { estimated: !!c.cost_estimated, partial: !!c.cost_partial && isNum(c.est_cost_usd) });
  const rightBits = [];
  if (costStr) rightBits.push(costStr);
  if (wTag) rightBits.push(wTag);
  if (!rightBits.length) rightBits.push(t('calls', fmtInt(c.calls, lang)));
  const subBadge = showSubBadge && isSubagent(raw)
    ? `<span class="sub-badge">${esc(t('agentSub'))}</span>`
    : '';
  let bar = '';
  if (maxTok > 0) {
    const seg = (v, cls) => (v > 0 ? `<span class="${cls}" style="width:${(v / maxTok * 100).toFixed(2)}%"></span>` : '');
    bar = `<div class="hbar conv-bar">${seg(num(c.input), 'seg-in')}${seg(num(c.output), 'seg-out')}</div>`;
  }
  return `<li class="conv-item"><details data-key="${esc(key)}"${openKeys && openKeys.has(key) ? ' open' : ''}>
    <summary class="conv-sum">
      <div class="conv-top">
        ${CHEV}
        <span class="conv-title-wrap"><span class="conv-title ellipsis${muted ? ' dim' : ''}" title="${esc(shown)}">${esc(shown)}</span>${subBadge}</span>
        <span class="conv-val num" title="${esc(fmtInt(newTok(c), lang))}">${fmtTok(newTok(c))}</span>
      </div>
      <div class="conv-meta"><span class="ellipsis">${esc(subLeft)}</span><span class="num">${esc(rightBits.join(' · '))}</span></div>
      ${bar}
    </summary>
    ${convDetailHtml(c, data, { tree, maxTok, openKeys, t, lang })}
  </details></li>`;
}

function summarizeConvs(list, t, lang) {
  let tok = 0;
  let calls = 0;
  for (const c of list) { tok += newTok(c); calls += num(c.calls); }
  return `<div class="summary num">${esc(t('summaryLine', fmtInt(list.length, lang), fmtTok(tok), fmtInt(calls, lang)))}</div>`;
}

function sortListItems(list, sortKey, useTree = true) {
  const viewOf = (c) => (useTree && c.children && c.children.length ? withSubtree(c) : c);
  return list.slice().sort((a, b) => {
    const va = viewOf(a);
    const vb = viewOf(b);
    if (sortKey === 'tokens') return newTok(vb) - newTok(va) || tsOf(vb.last_at) - tsOf(va.last_at);
    if (sortKey === 'calls') return num(vb.calls) - num(va.calls) || tsOf(vb.last_at) - tsOf(va.last_at);
    return tsOf(vb.last_at) - tsOf(va.last_at) || newTok(vb) - newTok(va);
  });
}

export function renderListBodyHtml(data, {
  listSort = 'recent',
  listSource = 'all',
  hideSubagents = false,
  searchQuery = '',
  listLimit = CONV_VISIBLE,
  openKeys = new Set(),
  t = createTranslator('en'),
  lang = 'en',
} = {}) {
  const all = Array.isArray(data && data.by_conversation) ? data.by_conversation : [];
  const cli = hasCliSources(data);
  const srcFilter = cli ? listSource : 'all';
  const q = String(searchQuery || '').trim().toLowerCase();
  const idx = convIndex(data);

  if (hideSubagents) {
    const filtered = sortListItems(all.filter((c) => {
      if (isSubagent(c)) return false;
      if (srcFilter !== 'all' && (c.source || 'desktop') !== srcFilter) return false;
      return matchesQuery(c, q);
    }), listSort, false);
    if (!filtered.length) {
      return `<p class="empty">${esc(all.length ? t('noMatches') : t('noConversations'))}</p>`;
    }
    const rows = filtered.slice(0, listLimit).map((c, i) => convItemHtml(c, i, 0, data, { tree: false, openKeys, t, lang })).join('');
    const rest = filtered.length - listLimit;
    const more = rest > 0 ? `<button type="button" class="quiet-btn" data-more-list>${CHEV}<span>${esc(t('moreConvs', Math.min(rest, CONV_VISIBLE * 2)))}</span></button>` : '';
    return summarizeConvs(filtered, t, lang) + `<ul class="conv-list">${rows}</ul>` + more;
  }

  if (q) {
    const filtered = sortListItems(all.filter((c) => {
      if (srcFilter !== 'all' && (c.source || 'desktop') !== srcFilter) return false;
      return matchesQuery(c, q);
    }), listSort, true);
    if (!filtered.length) {
      return `<p class="empty">${esc(all.length ? t('noMatches') : t('noConversations'))}</p>`;
    }
    const rows = filtered.slice(0, listLimit).map((c, i) => {
      const par = c.parent_id && idx.has(String(c.parent_id)) ? idx.get(String(c.parent_id)) : null;
      const parentTitle = par ? convDisplayTitle(par, t) : '';
      return convItemHtml(c, i, 0, data, {
        tree: Boolean(c.children && c.children.length),
        parentTitle,
        showSubBadge: true,
        openKeys,
        t,
        lang,
      });
    }).join('');
    const rest = filtered.length - listLimit;
    const more = rest > 0 ? `<button type="button" class="quiet-btn" data-more-list>${CHEV}<span>${esc(t('moreConvs', Math.min(rest, CONV_VISIBLE * 2)))}</span></button>` : '';
    return summarizeConvs(filtered, t, lang) + `<ul class="conv-list">${rows}</ul>` + more;
  }

  // Default view: group subagents inside their parent conversation trees, and
  // badge any standalone orphan subagents at the top level.
  const tops = sortListItems(all.filter((c) => {
    if (c.parent_id && idx.has(String(c.parent_id))) return false;
    if (srcFilter !== 'all' && (c.source || 'desktop') !== srcFilter) return false;
    return true;
  }), listSort, true);
  if (!tops.length) {
    return `<p class="empty">${esc(all.length ? t('noMatches') : t('noConversations'))}</p>`;
  }
  let tok = 0;
  let calls = 0;
  let subs = 0;
  for (const c of tops) {
    const v = withSubtree(c);
    tok += newTok(v);
    calls += num(v.calls);
    subs += num(c.total && c.total.subagents);
  }
  const summary = subs > 0
    ? `<div class="summary num">${esc(t('summaryTree', fmtInt(tops.length, lang), fmtInt(subs, lang), fmtTok(tok), fmtInt(calls, lang)))}</div>`
    : summarizeConvs(tops, t, lang);
  const rows = tops.slice(0, listLimit).map((c, i) => convItemHtml(c, i, 0, data, {
    tree: true,
    showSubBadge: true,
    openKeys,
    t,
    lang,
  })).join('');
  const rest = tops.length - listLimit;
  const more = rest > 0 ? `<button type="button" class="quiet-btn" data-more-list>${CHEV}<span>${esc(t('moreConvs', Math.min(rest, CONV_VISIBLE * 2)))}</span></button>` : '';
  return summary + `<ul class="conv-list">${rows}</ul>` + more;
}

export function createHistoryController({
  pane,
  store,
  openKeys,
  getTab,
  getQuotaData,
  getT,
  getLang,
  getJson,
  keepScroll,
  setMeta,
  onBusyChange,
  onPricingSynced,
  onDataChange,
}) {
  let listHasCli = false;
  let period = PERIODS.includes(store.get('ctx.period', 'd30')) ? store.get('ctx.period', 'd30') : 'd30';
  let historyView = HISTORY_VIEWS.includes(store.get('ctx.historyView', 'totals')) ? store.get('ctx.historyView', 'totals') : 'totals';
  let sessionsPeriod = 'all';
  let hideSubagents = false;
  let showAllModels = false;
  let listSort = 'recent';
  let listSource = 'all';
  let searchQuery = '';
  let sessionsLimit = CONV_VISIBLE;
  let listLimit = CONV_VISIBLE;

  let pricingSyncing = false;
  let pricingNotice = null;
  let pricingNoticeTimer = null;
  let lastQuotaWeeklySig = '';

  function historyMetaHtml(data, manualLoading) {
    const t = getT();
    const lang = getLang();
    if (!data || data.error) return '';
    if (manualLoading) return `<span class="spin"></span>${esc(t('scanning'))}`;
    if (!data.scanned_at) return esc(t('autoTag'));
    return `${esc(t('autoTag'))} · ${esc(fmtTime(data.scanned_at, false, lang))}`;
  }

  function historyMetaTip(data) {
    const t = getT();
    const lang = getLang();
    return data && data.scanned_at ? t('scannedAt', fmtTime(data.scanned_at, true, lang), data.elapsed_ms) : '';
  }

  function historySourcesText(data) {
    const t = getT();
    const lang = getLang();
    const src = (data && data.sources) || {};
    const foot = [t('sources', fmtInt(src.desktop, lang), fmtInt(src.cli, lang))];
    if (num(data && data.errors) > 0) foot.push(t('errors', fmtInt(data.errors, lang)));
    return foot.join(' · ');
  }

  function historySubNav() {
    const t = getT();
    const btns = HISTORY_VIEWS.map((k) => {
      const on = k === historyView;
      return `<button class="seg-btn" type="button" role="tab" data-hview="${k}" aria-selected="${on}" tabindex="${on ? 0 : -1}">${esc(t('hviews')[k])}</button>`;
    }).join('');
    return `<div class="seg" role="tablist" aria-label="${esc(t('hviewAria'))}">${btns}</div>`;
  }

  function totalsHero(data) {
    return renderTotalsHeroHtml(data, {
      period,
      quotaData: getQuotaData(),
      pricingSyncing,
      pricingNotice,
      t: getT(),
      lang: getLang(),
    });
  }

  function heatFooter(summary) {
    const t = getT();
    const scale = `<span class="scale"><span class="t">${esc(t('less'))}</span>${[0, 1, 2, 3, 4].map((l) => `<span class="cell l${l}"></span>`).join('')}<span class="t">${esc(t('more'))}</span></span>`;
    return `<div class="heat-foot"><span>${esc(summary)}</span>${scale}</div>`;
  }

  function heatmapToday(data) {
    const t = getT();
    const lang = getLang();
    const hours = Array.isArray(data.hourly_today) && data.hourly_today.length ? data.hourly_today : null;
    if (!hours) {
      const daily = Array.isArray(data.daily) ? data.daily : [];
      const last = daily[daily.length - 1];
      if (!last) return '';
      const active = num(last.tokens) > 0 || num(last.calls) > 0;
      const tip = t('dayTip', last.date, fmtInt(last.tokens, lang), fmtInt(last.calls, lang));
      return `<section><h2>${esc(t('activity'))}</h2>
        <div class="heat-d7" style="grid-template-columns:1fr"><div class="d7-item today"><span class="cell l${active ? 4 : 0}" style="height:28px;aspect-ratio:auto" title="${esc(tip)}"></span></div></div>
        ${heatFooter(t('activeToday', active))}</section>`;
    }
    const byH = new Map(hours.map((h) => [num(h.hour), h]));
    const vals = [];
    for (let h = 0; h < 24; h += 1) vals.push(num((byH.get(h) || {}).tokens));
    const level = makeHeatScale(vals);
    let html = '<span class="ax" style="grid-row:1;grid-column:2 / span 2">00</span>'
      + '<span class="ax" style="grid-row:1;grid-column:8 / span 2">06</span>'
      + '<span class="ax r" style="grid-row:1;grid-column:12 / span 2">11</span>'
      + `<span class="ax row-lbl" style="grid-row:2;grid-column:1">${esc(t('am'))}</span>`
      + `<span class="ax row-lbl" style="grid-row:3;grid-column:1">${esc(t('pm'))}</span>`;
    let active = 0;
    for (let h = 0; h < 24; h += 1) {
      const e = byH.get(h) || { tokens: 0, calls: 0 };
      if (num(e.tokens) > 0 || num(e.calls) > 0) active += 1;
      const r = h < 12 ? 2 : 3;
      const c = (h % 12) + 2;
      const h1 = String(h).padStart(2, '0');
      const h2 = String(h + 1).padStart(2, '0');
      const tip = t('hourTip', h1, h2, fmtInt(e.tokens, lang), fmtInt(e.calls, lang));
      html += `<span class="cell l${level(num(e.tokens))}" style="grid-row:${r};grid-column:${c}" title="${esc(tip)}"></span>`;
    }
    html += '<span class="ax" style="grid-row:4;grid-column:2 / span 2">12</span>'
      + '<span class="ax" style="grid-row:4;grid-column:8 / span 2">18</span>'
      + '<span class="ax r" style="grid-row:4;grid-column:12 / span 2">23</span>';
    return `<section><h2>${esc(t('activity'))}</h2><div class="heat heat-hours">${html}</div>${heatFooter(t('activeHours', active))}</section>`;
  }

  function heatmapD7(daily) {
    const t = getT();
    const lang = getLang();
    const slice = daily.slice(-7);
    if (!slice.length) return '';
    const level = makeHeatScale(slice.map((d) => num(d.tokens)));
    const wd = t('weekdays');
    let active = 0;
    const tiles = slice.map((e, i) => {
      const dt = parseDay(e.date);
      const isToday = i === slice.length - 1;
      if (num(e.tokens) > 0 || num(e.calls) > 0) active += 1;
      const w = Number.isNaN(dt.getTime()) ? '' : wd[dt.getDay()];
      const dayNum = Number.isNaN(dt.getTime()) ? '' : dt.getDate();
      const tip = t('dayTip', `${e.date} ${w}`, fmtInt(e.tokens, lang), fmtInt(e.calls, lang));
      return `<div class="d7-item${isToday ? ' today' : ''}" title="${esc(tip)}">
        <span class="cell l${level(num(e.tokens))}"></span>
        <span class="d7-lbl">${esc(w)}<b>${esc(dayNum)}</b></span>
      </div>`;
    }).join('');
    return `<section><h2>${esc(t('activity'))}</h2><div class="heat-d7">${tiles}</div>${heatFooter(t('activeDaysOf', active, slice.length))}</section>`;
  }

  function heatmapD30(daily) {
    const t = getT();
    const lang = getLang();
    const byDay = new Map(daily.map((d) => [d.date, d]));
    const end = parseDay(daily[daily.length - 1].date);
    if (Number.isNaN(end.getTime())) return '';
    const minDay = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 29);
    const start = new Date(minDay.getFullYear(), minDay.getMonth(), minDay.getDate() - minDay.getDay());
    const endSat = new Date(end.getFullYear(), end.getMonth(), end.getDate() + (6 - end.getDay()));
    const totalDays = Math.round((endSat - start) / 86400000) + 1;
    const weeks = Math.round(totalDays / 7);
    const inRange = [];
    for (let i = 0; i < totalDays; i += 1) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      if (d >= minDay && d <= end) inRange.push(num((byDay.get(dayKey(d)) || {}).tokens));
    }
    const level = makeHeatScale(inRange);
    const wd = t('weekdays');
    let html = '';
    for (let c = 0; c < 7; c += 1) html += `<span class="ax wd" style="grid-row:1;grid-column:${c + 2}">${esc(wd[c])}</span>`;
    let active = 0;
    for (let w = 0; w < weeks; w += 1) {
      const wkDay = new Date(start.getFullYear(), start.getMonth(), start.getDate() + w * 7);
      const lblDay = wkDay < minDay ? minDay : wkDay;
      const wkLbl = `${lblDay.getMonth() + 1}/${lblDay.getDate()}`;
      html += `<span class="ax wk" style="grid-row:${w + 2};grid-column:1">${esc(wkLbl)}</span>`;
      for (let c = 0; c < 7; c += 1) {
        const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + w * 7 + c);
        const style = `grid-row:${w + 2};grid-column:${c + 2}`;
        if (d < minDay || d > end) { html += `<span class="cell future" style="${style}"></span>`; continue; }
        const e = byDay.get(dayKey(d)) || { tokens: 0, calls: 0 };
        if (num(e.tokens) > 0 || num(e.calls) > 0) active += 1;
        const tip = t('dayTip', `${dayKey(d)} ${wd[d.getDay()]}`, fmtInt(e.tokens, lang), fmtInt(e.calls, lang));
        html += `<span class="cell l${level(num(e.tokens))}" style="${style}" title="${esc(tip)}"></span>`;
      }
    }
    return `<section><h2>${esc(t('activity'))}</h2><div class="heat heat-d30">${html}</div>${heatFooter(t('activeDaysOf', active, 30))}</section>`;
  }

  function heatmapAll(daily) {
    const t = getT();
    const lang = getLang();
    const loc = localeFor(lang);
    const byDay = new Map(daily.map((d) => [d.date, d]));
    const end = parseDay(daily[daily.length - 1].date);
    if (Number.isNaN(end.getTime())) return '';
    const firstActive = daily.find((d) => num(d.tokens) > 0 || num(d.calls) > 0);
    let need = 0;
    if (firstActive) {
      const fa = parseDay(firstActive.date);
      const endSun = new Date(end.getFullYear(), end.getMonth(), end.getDate() - end.getDay());
      const firstSun = new Date(fa.getFullYear(), fa.getMonth(), fa.getDate() - fa.getDay());
      need = Math.round((endSun - firstSun) / (7 * 86400000)) + 1;
    }
    const weeks = Math.min(HEAT_ALL_MAX_WEEKS, Math.max(HEAT_ALL_MIN_WEEKS, need));
    const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - end.getDay() - 7 * (weeks - 1));
    const days = [];
    for (let i = 0; i < weeks * 7; i += 1) days.push(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
    const level = makeHeatScale(days.filter((d) => d <= end).map((d) => num((byDay.get(dayKey(d)) || {}).tokens)));
    const wd = t('weekdays');
    let html = '';
    let lastLabelCol = -9;
    const minGap = weeks > 36 ? 6 : 3;
    for (let w = 0; w < weeks; w += 1) {
      const first = days[w * 7];
      const monthStart = days.slice(w * 7, w * 7 + 7).find((d) => d.getDate() === 1);
      if ((w === 0 || monthStart) && w - lastLabelCol >= minGap && w <= weeks - 3) {
        const m = (monthStart || first).toLocaleDateString(loc, { month: 'short' });
        html += `<span class="ax" style="grid-row:1;grid-column:${w + 2} / span 4">${esc(m)}</span>`;
        lastLabelCol = w;
      }
    }
    [1, 3, 5].forEach((r) => { html += `<span class="ax" style="grid-row:${r + 2};grid-column:1">${esc(wd[r])}</span>`; });
    let active = 0;
    days.forEach((d, i) => {
      const style = `grid-row:${(i % 7) + 2};grid-column:${Math.floor(i / 7) + 2}`;
      if (d > end) { html += `<span class="cell future" style="${style}"></span>`; return; }
      const e = byDay.get(dayKey(d)) || { tokens: 0, calls: 0 };
      if (num(e.tokens) > 0 || num(e.calls) > 0) active += 1;
      const tip = t('dayTip', `${dayKey(d)} ${wd[d.getDay()]}`, fmtInt(e.tokens, lang), fmtInt(e.calls, lang));
      html += `<span class="cell l${level(num(e.tokens))}" style="${style}" title="${esc(tip)}"></span>`;
    });
    const cls = weeks > 32 ? 'heat heat-all dense' : 'heat heat-all';
    return `<section><h2>${esc(t('activity'))}</h2>
      <div class="${cls}" style="grid-template-columns:auto repeat(${weeks}, minmax(0, 1fr))">${html}</div>
      ${heatFooter(t('activeDays', active, weeks))}</section>`;
  }

  function heatmap(data) {
    if (period === 'today') return heatmapToday(data);
    const daily = Array.isArray(data && data.daily) ? data.daily : [];
    if (!daily.length) return '';
    if (period === 'd7') return heatmapD7(daily);
    if (period === 'd30') return heatmapD30(daily);
    return heatmapAll(daily);
  }

  function byModel(data) {
    const t = getT();
    const lang = getLang();
    const quotaCalibration = (data && data.quota_calibration) || null;
    const merged = mergeModels(sliceModelsForPeriod(data.by_model, period), { period, quotaCalibration });
    if (!merged.length) return `<section id="history-models"><h2>${esc(t('byModel'))}</h2><p class="note" style="margin:0">${esc(t('noModels'))}</p></section>`;
    const weeklyValueUsd = (data && data.weekly_value_usd) || null;
    const max = Math.max(1, ...merged.map(allTok));
    const seg = (v, cls) => (v > 0 ? `<span class="${cls}" style="width:${(v / max * 100).toFixed(2)}%"></span>` : '');
    const legend = `<div class="legend"><span><i class="seg-in"></i>${esc(t('legInput'))}</span><span><i class="seg-cache"></i>${esc(t('legCache'))}</span><span><i class="seg-out"></i>${esc(t('legOutput'))}</span></div>`;
    const visible = showAllModels ? merged : merged.slice(0, MODEL_VISIBLE);
    const rows = visible.map((m) => {
      const wTag = modelWeeklyLabel(m, { compact: true, weeklyValueUsd, quotaCalibration, t });
      const costStr = fmtCost(m.est_cost_usd, { estimated: m.cost_estimated, partial: m.cost_partial && isNum(m.est_cost_usd) });
      const tip = `${m.ids.join(', ') || m.name}\n${t('ioLine', fmtInt(m.input, lang), fmtInt(m.output, lang), fmtInt(m.cache_read, lang))}\n${t('calls', fmtInt(m.calls, lang))}`;
      const subRight = costStr || t('calls', fmtInt(m.calls, lang));
      return `<li title="${esc(tip)}">
        <div class="rh"><span class="ellipsis">${esc(m.name)}</span>
          <span class="rv num"><b>${fmtTok(newTok(m))}</b></span></div>
        <div class="rmeta num"><span${wTag ? ` title="${esc(t('weeklySizeTip'))}"` : ''}>${esc(wTag || t('calls', fmtInt(m.calls, lang)))}</span><span>${wTag ? esc(subRight) : (costStr ? esc(costStr) : '')}</span></div>
        <div class="hbar">${seg(m.input, 'seg-in')}${seg(m.cache_read, 'seg-cache')}${seg(m.output, 'seg-out')}</div>
      </li>`;
    }).join('');
    const rest = merged.length - MODEL_VISIBLE;
    const toggle = rest > 0
      ? `<button type="button" class="quiet-btn" data-toggle-models aria-expanded="${showAllModels}">${CHEV}<span>${esc(showAllModels ? t('showLess') : t('showMoreModels', rest))}</span></button>`
      : '';
    const hint = hasAnyWeeklyValue(weeklyValueUsd) ? `${t('colTokens')} · ${t('weeklyQuota')}` : t('colTokens');
    return `<section id="history-models"><h2>${esc(t('byModel'))} <span class="hint">${esc(hint)}</span></h2>${legend}<ul class="rank">${rows}</ul>${toggle}</section>`;
  }

  // Fills a conversation's subagent list the first time it is opened.
  function expandChildren(details) {
    const slot = details && details.querySelector(':scope > .conv-detail > [data-children-of]');
    if (!slot || slot.dataset.filled === '1' || !loader.data || loader.data.error) return;
    const c = convIndex(loader.data).get(slot.dataset.childrenOf);
    if (!c) return;
    slot.innerHTML = childListHtml(c, loader.data, Number(slot.dataset.maxTok) || 0, {
      openKeys,
      t: getT(),
      lang: getLang(),
    });
    slot.dataset.filled = '1';
  }

  // By usage: top-level conversations ranked by usage including all their
  // subagents; each expands into its subagents, level by level.
  function sessionsBodyHtml(data) {
    const t = getT();
    const lang = getLang();
    const all = Array.isArray(data && data.by_conversation) ? data.by_conversation : [];
    const idx = convIndex(data);
    const cutoff = periodCutoff(sessionsPeriod);
    const tops = all.filter((c) => !(c.parent_id && idx.has(String(c.parent_id))));
    const filtered = tops.filter((c) => {
      if (sessionsPeriod !== 'all') {
        const ts = tsOf(withSubtree(c).last_at);
        if (ts < cutoff) return false;
      }
      return true;
    }).sort((a, b) => {
      const ta = withSubtree(a);
      const tb = withSubtree(b);
      return newTok(tb) - newTok(ta) || tsOf(tb.last_at) - tsOf(ta.last_at) || String(a.id || '').localeCompare(String(b.id || ''));
    });
    if (!filtered.length) {
      return `<p class="empty">${esc(all.length ? t('noMatches') : t('noConversations'))}</p>`;
    }
    const maxTok = Math.max(1, newTok(withSubtree(filtered[0])));
    const legend = `<div class="legend" style="margin-top:12px"><span><i class="seg-in"></i>${esc(t('legInput'))}</span><span><i class="seg-out"></i>${esc(t('legOutput'))}</span></div>`;
    const rows = filtered.slice(0, sessionsLimit).map((c, i) => convItemHtml(c, i, maxTok, data, { tree: true, openKeys, t, lang })).join('');
    const rest = filtered.length - sessionsLimit;
    const more = rest > 0 ? `<button type="button" class="quiet-btn" data-more-sessions>${CHEV}<span>${esc(t('moreConvs', Math.min(rest, CONV_VISIBLE * 2)))}</span></button>` : '';
    let tok = 0;
    let calls = 0;
    let subs = 0;
    for (const c of filtered) {
      const v = withSubtree(c);
      tok += newTok(v);
      calls += num(v.calls);
      subs += num(c.total && c.total.subagents);
    }
    const summary = `<div class="summary num">${esc(t('summaryTree', fmtInt(filtered.length, lang), fmtInt(subs, lang), fmtTok(tok), fmtInt(calls, lang)))}</div>`;
    return summary + legend + `<ul class="conv-list">${rows}</ul>` + more;
  }

  function sessionsViewHtml(data) {
    const t = getT();
    const pBtns = SESSION_PERIODS.map((k) => `<button class="fchip" type="button" data-speriod="${k}" aria-pressed="${k === sessionsPeriod}">${esc(t('shortPeriods')[k])}</button>`).join('');
    const controls = `<div class="filters"><div class="fgroup">${pBtns}</div></div>`;
    return controls + `<div id="history-sessions-body">${sessionsBodyHtml(data)}</div>`;
  }

  function updateSessionsBody() {
    if (historyView !== 'sessions' || !loader.data || loader.data.error) return;
    const body = pane.querySelector('#history-sessions-body');
    if (body) keepScroll(() => { body.innerHTML = sessionsBodyHtml(loader.data); });
    else paint();
  }

  function listBodyHtml(data) {
    if (!hasCliSources(data) && listSource !== 'all') listSource = 'all';
    return renderListBodyHtml(data, {
      listSort,
      listSource,
      hideSubagents,
      searchQuery,
      listLimit,
      openKeys,
      t: getT(),
      lang: getLang(),
    });
  }

  function listViewHtml(data) {
    const t = getT();
    const cli = hasCliSources(data);
    listHasCli = cli;
    if (!cli && listSource !== 'all') listSource = 'all';
    const search = `<div class="search-box">
      <input id="history-search" class="search-input" type="search" value="${esc(searchQuery)}" placeholder="${esc(t('searchPlaceholder'))}" aria-label="${esc(t('searchPlaceholder'))}" autocomplete="off">
      <button id="history-search-clear" class="search-clear" type="button" title="${esc(t('clearSearch'))}" aria-label="${esc(t('clearSearch'))}"${searchQuery ? '' : ' hidden'}>&times;</button>
    </div>`;
    const sortBtns = LIST_SORTS.map((k) => `<button class="fchip" type="button" data-hsort="${k}" aria-pressed="${k === listSort}">${esc(t('sorts')[k])}</button>`).join('');
    const srcBtns = cli
      ? `<div class="fgroup">${SOURCE_FILTERS.map((k) => `<button class="fchip" type="button" data-hsource="${k}" aria-pressed="${k === listSource}">${esc(t('sourceFilters')[k])}</button>`).join('')}</div>`
      : '';
    const subBtn = `<button class="fchip" type="button" data-hide-sub aria-pressed="${hideSubagents}">${esc(t('hideSubagents'))}</button>`;
    const controls = `<div class="filters"><div class="fgroup">${sortBtns}</div>${srcBtns}${subBtn}</div>`;
    return search + controls + `<div id="history-list-body">${listBodyHtml(data)}</div>`;
  }

  function updateListBody() {
    if (historyView !== 'list' || !loader.data || loader.data.error) return;
    const body = pane.querySelector('#history-list-body');
    if (body) keepScroll(() => { body.innerHTML = listBodyHtml(loader.data); });
    const clr = pane.querySelector('#history-search-clear');
    if (clr) clr.hidden = !searchQuery;
    pane.querySelectorAll('[data-hsort]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.hsort === listSort)));
    pane.querySelectorAll('[data-hsource]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.hsource === listSource)));
    pane.querySelectorAll('[data-hide-sub]').forEach((b) => b.setAttribute('aria-pressed', String(hideSubagents)));
  }

  function onSilent(data) {
    if (historyView === 'list' && pane.querySelector('#history-search') && pane.querySelector('#history-list-body') && hasCliSources(data) === listHasCli) {
      setMeta('history', historyMetaHtml(data, false), historyMetaTip(data));
      updateListBody();
      const src = pane.querySelector('#history-sources');
      if (src) src.textContent = historySourcesText(data);
      return;
    }
    const inp = pane.querySelector('#history-search');
    const focused = inp && document.activeElement === inp;
    const selStart = focused ? inp.selectionStart : null;
    const selEnd = focused ? inp.selectionEnd : null;
    paint();
    if (focused) {
      const next = pane.querySelector('#history-search');
      if (next) {
        next.focus();
        if (selStart != null && selEnd != null) {
          try { next.setSelectionRange(selStart, selEnd); } catch { /* ignore */ }
        }
      }
    }
  }

  function paint() {
    const t = getT();
    const { data, loading, manual, error } = loader;
    let body = '';
    if (error) {
      body = `${errorBox(t('requestFailed'), error)}<div class="guide-acts"><button type="button" class="guide-btn" data-retry="history">${esc(t('retry'))}</button></div>`;
    } else if (!data) {
      body = `<p class="empty"><span class="spin"></span>${esc(t('scanning'))}</p>`;
    } else if (data.error) {
      body = `${errorBox(t('historyFailed'), data.message || data.error)}<div class="guide-acts"><button type="button" class="guide-btn" data-retry="history">${esc(t('retry'))}</button></div>`;
    }
    if (data && !data.error && !error) {
      const meta = historyMetaHtml(data, loading && manual);
      const src = data.sources || {};
      const totalDbs = num(src.desktop) + num(src.cli);
      const noConvs = !Array.isArray(data.by_conversation) || !data.by_conversation.length;
      let viewBody;
      if (historyView === 'totals' && noConvs && (totalDbs === 0 || num(data.totals && data.totals.all && data.totals.all.calls) === 0) && !num(data.errors)) {
        viewBody = `<div class="guide-empty"><h3>${esc(t('historyEmptyTitle'))}</h3><p>${esc(t('historyEmptyHint'))}</p></div>`;
      } else if (historyView === 'sessions') viewBody = sessionsViewHtml(data);
      else if (historyView === 'list') viewBody = listViewHtml(data);
      else viewBody = totalsHero(data) + heatmap(data) + byModel(data);
      body = `${historySubNav()}${viewBody}<footer id="history-footer"><span id="history-sources">${esc(historySourcesText(data))}</span><span id="history-meta" class="num" title="${esc(historyMetaTip(data))}">${meta}</span></footer>`;
    }
    keepScroll(() => { pane.innerHTML = body; });
  }

  const loader = makeLoader('/api/history', HISTORY_STALE_MS, {
    getJson,
    onBusyChange,
    paint: () => {
      paint();
      refreshShareCardModal({ data: loader.data, period, lang: getLang(), t: getT() });
      if (onDataChange) onDataChange();
    },
    keyOf: historyKey,
    onMeta: (d) => setMeta('history', historyMetaHtml(d, false), historyMetaTip(d)),
    onSilent: (d) => {
      onSilent(d);
      refreshShareCardModal({ data: d, period, lang: getLang(), t: getT() });
      if (onDataChange) onDataChange();
    },
  });

  function syncFromQuota() {
    const quotaData = getQuotaData();
    const w = (quotaData && !quotaData.error && quotaData.weekly) || {};
    const cycles = (loader.data && !loader.data.error && loader.data.weekly_cycles) || {};
    const poolList = knownQuotaPools(w, cycles);
    const sig = JSON.stringify(poolList.map((k) => [k, w[k] || null]));
    if (sig === lastQuotaWeeklySig) return;
    lastQuotaWeeklySig = sig;
    if (loader.data && !loader.data.error && !loader.loading) {
      const staleCycle = poolList.some((k) => {
        const lk = w[k];
        if (!lk || !lk.reset_time) return false;
        const latest = Array.isArray(cycles[k]) && cycles[k][0];
        if (!latest || tsOf(latest.reset_time) !== tsOf(lk.reset_time)) return true;
        return Math.abs(num(latest.remaining_fraction) - num(lk.remaining_fraction)) > 1e-6;
      });
      if (staleCycle) loader.load({ refresh: false, silent: true });
    }
    if (getTab() === 'history' && loader.data && !loader.data.error) onSilent(loader.data);
  }

  function setHistoryView(next, focusBtn) {
    if (!HISTORY_VIEWS.includes(next) || next === historyView) return;
    historyView = next;
    store.set('ctx.historyView', historyView);
    paint();
    if (focusBtn) {
      const btn = pane.querySelector(`.seg-btn[data-hview="${historyView}"]`);
      if (btn) btn.focus();
    }
  }

  function setPeriod(k, focusBtn) {
    if (!PERIODS.includes(k) || k === period) return;
    period = k;
    store.set('ctx.period', k);
    paint();
    if (focusBtn) {
      const btn = pane.querySelector(`.pill[data-period="${k}"]`);
      if (btn) btn.focus();
    }
  }

  function setSessionsPeriod(next) {
    if (SESSION_PERIODS.includes(next) && next !== sessionsPeriod) {
      sessionsPeriod = next;
      sessionsLimit = CONV_VISIBLE;
      paint();
    }
  }

  function setListSort(next) {
    if (LIST_SORTS.includes(next) && next !== listSort) {
      listSort = next;
      listLimit = CONV_VISIBLE;
      updateListBody();
    }
  }

  function setListSource(next) {
    if (SOURCE_FILTERS.includes(next) && next !== listSource) {
      listSource = next;
      listLimit = CONV_VISIBLE;
      updateListBody();
    }
  }

  function toggleHideSubagents() {
    hideSubagents = !hideSubagents;
    if (historyView === 'list') { listLimit = CONV_VISIBLE; updateListBody(); }
    else { sessionsLimit = CONV_VISIBLE; paint(); }
  }

  function setSearchQuery(q, { clearInput = false } = {}) {
    searchQuery = q;
    listLimit = CONV_VISIBLE;
    if (clearInput) {
      const inp = pane.querySelector('#history-search');
      if (inp) { inp.value = ''; inp.focus(); }
    }
    updateListBody();
  }

  function setPricingNotice(ok, text) {
    if (pricingNoticeTimer) { clearTimeout(pricingNoticeTimer); pricingNoticeTimer = null; }
    pricingNotice = { ok, text };
    if (ok) {
      pricingNoticeTimer = setTimeout(() => {
        pricingNoticeTimer = null;
        pricingNotice = null;
        const note = pane.querySelector('#history-sync-note');
        if (note) {
          note.hidden = true;
          note.textContent = '';
          note.className = 'sync-note';
        }
      }, 3500);
    }
  }

  function clearPricingNotice() {
    if (pricingNoticeTimer) { clearTimeout(pricingNoticeTimer); pricingNoticeTimer = null; }
    pricingNotice = null;
  }

  async function syncPricing() {
    if (pricingSyncing) return;
    pricingSyncing = true;
    clearPricingNotice();
    paint();
    let syncOk = false;
    const t = getT();
    const lang = getLang();
    try {
      const res = await getJson('/api/pricing', { refresh: 'true' });
      if (res && res.error) {
        setPricingNotice(false, t('pricingSyncFail') + (res.message ? ` (${res.message})` : ''));
      } else {
        syncOk = true;
        setPricingNotice(true, t('pricingSyncOk', fmtInt(res && res.count, lang), pricingSourceName(res && res.source, t)));
      }
    } catch (err) {
      setPricingNotice(false, t('pricingSyncFail') + (err && err.message ? ` (${err.message})` : ''));
    } finally {
      pricingSyncing = false;
      paint();
      if (syncOk) {
        loader.load({ refresh: true, silent: true });
        if (onPricingSynced) onPricingSynced();
      }
    }
  }

  function toggleModels(btn) {
    const collapsing = showAllModels;
    const prevY = window.scrollY;
    const beforeTop = btn ? btn.getBoundingClientRect().top : null;
    showAllModels = !showAllModels;
    const sec = pane.querySelector('#history-models');
    if (sec && loader.data && !loader.data.error) sec.outerHTML = byModel(loader.data);
    else paint();
    if (collapsing && beforeTop != null) {
      const afterBtn = pane.querySelector('[data-toggle-models]');
      if (afterBtn) {
        const targetY = Math.max(0, window.scrollY + (afterBtn.getBoundingClientRect().top - beforeTop));
        if (Math.abs(window.scrollY - targetY) > 0.5) window.scrollTo(0, targetY);
        return;
      }
    }
    if (window.scrollY !== prevY) window.scrollTo(0, prevY);
  }

  function openShareCard() {
    if (!loader.data || loader.data.error) return;
    openShareCardModal({ data: loader.data, period, lang: getLang(), t: getT() });
  }

  function refreshShareCard() {
    refreshShareCardModal({ data: loader.data || {}, period, lang: getLang(), t: getT() });
  }

  return {
    loader,
    paint,
    syncFromQuota,
    getPeriod: () => period,
    setPeriod,
    getHistoryView: () => historyView,
    setHistoryView,
    setSessionsPeriod,
    setListSort,
    setListSource,
    toggleHideSubagents,
    expandChildren,
    setSearchQuery,
    moreSessions: () => { sessionsLimit += CONV_VISIBLE * 2; updateSessionsBody(); },
    moreList: () => { listLimit += CONV_VISIBLE * 2; updateListBody(); },
    syncPricing,
    clearPricingNotice,
    toggleModels,
    openShareCard,
    refreshShareCard,
    getSearchQuery: () => searchQuery,
  };
}
