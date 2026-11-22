// Quota tab renderer, countdown ticker, and loader controller for Agy Lens.

import {
  CAL_POOLS,
  CHEV,
  deltaLevel,
  errorBox,
  esc,
  fmtCost,
  fmtCycleSpan,
  fmtDeltaPct,
  fmtInt,
  fmtPctNum,
  fmtTime,
  fmtUsd,
  fraction,
  isNum,
  isUnlimited,
  levelOf,
  makeLoader,
  num,
  parseDate,
  pctText,
  QUOTA_STALE_MS,
  resetText,
  tsOf,
} from '../format.js';

export const RESET_RETRY_MS = 3000;

export function quotaKey(d) {
  if (!d || typeof d !== 'object') return '';
  const { fetched_at: _f, ...rest } = d;
  return JSON.stringify(rest);
}

export function quotaMetaHtml(data, { t, lang }) {
  if (!data || data.error) return '';
  return [data.tier || data.plan, t('autoTag'), data.fetched_at ? fmtTime(data.fetched_at, false, lang) : '']
    .filter(Boolean).map(esc).join(' · ');
}

// Dedupe by display name (case-insensitive), keeping the first id seen.
export function dedupeModels(list) {
  const seen = new Set();
  const out = [];
  for (const m of Array.isArray(list) ? list : []) {
    if (!m) continue;
    const name = String(m.display_name || m.id || '').trim();
    const k = name.toLowerCase();
    if (!name || seen.has(k)) continue;
    seen.add(k);
    out.push({ id: m.id || '', name, levels: Array.isArray(m.levels) ? m.levels : [] });
  }
  return out;
}

export function poolLimits(p, lang = 'en') {
  const raw = Array.isArray(p.limits) && p.limits.length ? p.limits : [{ remaining_fraction: p.remaining_fraction, reset_time: p.reset_time }];
  return raw.map((l) => ({
    kind: l.kind || '',
    inferred: !!l.inferred,
    f: fraction(l.remaining_fraction),
    reset_time: l.reset_time || null,
    label: (lang === 'zh' ? l.label_zh : l.label) || l.label || '',
  }));
}

export function limitLabel(l, single, t) {
  const kinds = t('limitKinds');
  let name;
  if (l.kind && kinds[l.kind] && l.kind !== 'unknown') name = kinds[l.kind];
  else if (l.label) name = l.label;
  else name = single ? t('limit') : kinds.unknown;
  return l.inferred && l.kind !== 'none' ? `≈${name}` : name;
}

export function meterHtml(f, name) {
  const on = f == null ? 0 : Math.round(f * 20);
  let dots = '';
  for (let i = 0; i < 20; i += 1) dots += `<i class="${i < on ? 'on' : ''}"></i>`;
  return `<div class="meter" role="progressbar" aria-label="${esc(name)}" aria-valuemin="0" aria-valuemax="100"${f != null ? ` aria-valuenow="${Math.round(f * 100)}"` : ''}>${dots}</div>`;
}

export function poolWeeklyValuationHtml(category, l, historyData, t, lang) {
  if (!l || l.kind !== 'weekly' || !historyData || historyData.error) return '';
  const cyclesMap = historyData.weekly_cycles && typeof historyData.weekly_cycles === 'object' ? historyData.weekly_cycles : {};
  const weeklyValueUsd = historyData.weekly_value_usd && typeof historyData.weekly_value_usd === 'object' ? historyData.weekly_value_usd : {};
  const list = Array.isArray(cyclesMap[category]) ? cyclesMap[category] : [];
  const curCy = list.find((cy) => cy.is_current || (l.reset_time && tsOf(cy.reset_time) === tsOf(l.reset_time))) || null;
  const refVal = num(weeklyValueUsd[category]);
  if (curCy && isNum(curCy.weekly_value_usd) && curCy.weekly_value_usd > 0) {
    const spentStr = fmtCost(curCy.cycle_cost_usd || curCy.observed_cost_usd, { estimated: !!curCy.cost_estimated, partial: !!curCy.cost_partial }) || '$0.00';
    const estStr = fmtUsd(curCy.weekly_value_usd);
    const dStr = fmtDeltaPct(curCy.change_pct);
    const dLvl = deltaLevel(curCy.change_pct);
    const dTip = isNum(curCy.prev_weekly_value_usd) ? t('deltaTip', fmtUsd(curCy.prev_weekly_value_usd)) : '';
    const deltaHtml = dStr ? `<span class="wdelta${dLvl ? ` ${dLvl}` : ''}"${dTip ? ` title="${esc(dTip)}"` : ''}>${esc(dStr)}</span>` : '';
    return `<div class="wbudget-val num"><span>${esc(t('cycleSpent', spentStr))}</span><span>${esc(t('weeklyEstValue', estStr))}${deltaHtml}</span></div>`;
  }
  if (curCy && num(curCy.used_fraction) > 0) {
    const rightVal = refVal > 0 ? t('weeklyPrevRef', fmtUsd(refVal)) : t('weeklyCollecting');
    return `<div class="wbudget-val num"><span>${esc(t('cycleLowUsage'))}</span><span>${esc(rightVal)}</span></div>`;
  }
  if (refVal > 0) {
    return `<div class="wbudget-val num"><span>${esc(t('weeklyPrevRef', fmtUsd(refVal)))}</span></div>`;
  }
  return '';
}

export function weeklyCyclesHtml(historyData, openKeys, t, lang) {
  const cyclesMap = historyData && !historyData.error && historyData.weekly_cycles && typeof historyData.weekly_cycles === 'object'
    ? historyData.weekly_cycles
    : null;
  if (!cyclesMap) return '';
  const pn = t('poolShort');
  const sections = [];
  let maxWeeks = 0;
  for (const pk of CAL_POOLS) {
    const list = Array.isArray(cyclesMap[pk]) ? cyclesMap[pk] : [];
    if (!list.length) continue;
    maxWeeks = Math.max(maxWeeks, list.length);
    const rows = list.map((cy) => {
      const span = fmtCycleSpan(cy.cycle_start, cy.reset_time, lang);
      const curBadge = cy.is_current ? `<span class="wtag">${esc(t('cycleCurrent'))}</span>` : '';
      const usedPctStr = fmtPctNum(num(cy.used_fraction) * 100);
      const costStr = fmtCost(cy.observed_cost_usd, { estimated: !!cy.cost_estimated, partial: !!cy.cost_partial });
      let rightHtml;
      if (isNum(cy.weekly_value_usd) && cy.weekly_value_usd > 0) {
        const valStr = fmtUsd(cy.weekly_value_usd);
        const dStr = fmtDeltaPct(cy.change_pct);
        const dLvl = deltaLevel(cy.change_pct);
        const dTip = isNum(cy.prev_weekly_value_usd) ? t('deltaTip', fmtUsd(cy.prev_weekly_value_usd)) : '';
        const deltaHtml = dStr ? `<span class="wdelta${dLvl ? ` ${dLvl}` : ''}"${dTip ? ` title="${esc(dTip)}"` : ''}>${esc(dStr)}</span>` : '';
        rightHtml = `${esc(usedPctStr)} · ${esc(costStr || '$0.00')} → <b>${esc(valStr)}</b>${deltaHtml}`;
      } else {
        rightHtml = `${esc(usedPctStr)} · ${esc(t('weeklyCollecting'))}`;
      }
      const obsTxt = cy.eval_obs_at ? fmtTime(cy.eval_obs_at, true, lang) : fmtTime(cy.observed_at, true, lang);
      const tip = t('cycleTip', fmtTime(cy.cycle_start, true, lang), fmtTime(cy.reset_time, true, lang), obsTxt);
      return `<li title="${esc(tip)}"><span>${esc(span)}${curBadge}</span><span class="num dim">${rightHtml}</span></li>`;
    }).join('');
    sections.push(`<div class="wcycles-pool"><div class="lbl">${esc(pn[pk] || pk)}</div><ul class="mini">${rows}</ul></div>`);
  }
  if (!sections.length) return '';
  return `<details class="wcycles" data-key="weekly-cycles"${openKeys && openKeys.has('weekly-cycles') ? ' open' : ''}>
    <summary>${CHEV}<span>${esc(t('weeklyHistoryTitle', fmtInt(maxWeeks, lang)))}</span></summary>
    <div class="wcycles-body">${sections.join('')}<p class="wcycles-note">${esc(t('weeklyHistoryNote'))}</p></div>
  </details>`;
}

export function limitHtml(l, single, t, lang, extraHtml = '') {
  const name = limitLabel(l, single, t);
  if (isUnlimited(l)) {
    return `<div class="limit free"><div class="limit-head"><span>${esc(t('unlimited'))}</span></div></div>`;
  }
  const f = l.f;
  const resetTitle = l.reset_time ? t('resetAt', fmtTime(l.reset_time, true, lang)) : '';
  return `<div class="limit ${levelOf(f)}">
    <div class="limit-head"><span${l.inferred ? ` title="${esc(t('inferred'))}"` : ''}>${esc(name)}${f != null ? ` · ${esc(t('used', pctText(1 - f)))}` : ''}</span>
      <span class="num" data-reset="${esc(l.reset_time || '')}" title="${esc(resetTitle)}">${esc(resetText(l.reset_time, t, lang))}</span></div>
    <div class="limit-body">${meterHtml(f, name)}<div class="limit-pct num">${pctText(f)}<span class="lbl">${esc(t('remaining'))}</span></div></div>
    ${extraHtml}
  </div>`;
}

export function poolHtml(p, { openKeys, historyData = null, t, lang }) {
  const limits = poolLimits(p, lang);
  const localizedCat = p.category && p.category !== 'other' ? t('categoriesQuota')[p.category] : '';
  const label = localizedCat || (lang === 'zh' ? p.label_zh : p.label) || p.label || (p.category === 'other' ? t('categoriesQuota').other : '') || p.id || '?';
  const tag = (m) => `<span class="tag" title="${esc(m.id)}">${esc(m.name)}${m.levels.length ? `<span class="dim">${esc(m.levels.join(' · '))}</span>` : ''}</span>`;
  const families = dedupeModels(p.families);
  const shownList = families.length ? families : dedupeModels(p.models);
  const shown = new Set(shownList.map((m) => m.name.toLowerCase()));
  const hidden = dedupeModels(p.hidden_models).filter((m) => !shown.has(m.name.toLowerCase()));
  const key = `pool:${p.id || label}`;
  const more = hidden.length
    ? `<details class="more" data-key="${esc(key)}"${openKeys && openKeys.has(key) ? ' open' : ''}><summary>${CHEV}<span>${esc(t('moreModels', hidden.length))}</span></summary><div class="tags">${hidden.map(tag).join('')}</div></details>`
    : '';
  return `<div class="pool">
    <div class="pool-label">${esc(label)}</div>
    ${limits.map((l) => limitHtml(l, limits.length === 1, t, lang, poolWeeklyValuationHtml(p.category, l, historyData, t, lang))).join('')}
    ${shownList.length ? `<div class="tags">${shownList.map(tag).join('')}</div>` : ''}
    ${more}
  </div>`;
}

export function renderQuotaHtml({ data, historyData = null, error, openKeys, t, lang }) {
  let meta = '';
  let tip = '';
  let body = '';
  if (error) {
    body = `${errorBox(t('requestFailed'), error)}<div class="guide-acts"><button type="button" class="guide-btn" data-retry="quota">${esc(t('retry'))}</button></div>`;
  } else if (!data) {
    body = `<p class="empty"><span class="spin"></span>${esc(t('loading'))}</p>`;
  } else if (data.error) {
    if (data.error === 'unavailable') {
      const steps = t('quotaTrouble').map((s) => `<li>${esc(s)}</li>`).join('');
      body = `<div class="guide-empty">
        <h3>${esc(t('quotaUnavailable'))}</h3>
        <p>${esc(data.message || t('quotaUnavailableHint'))}</p>
        <ol class="guide-steps">${steps}</ol>
        <div class="guide-acts"><button type="button" class="guide-btn" data-retry="quota">${esc(t('retry'))}</button></div>
      </div>`;
    } else {
      body = `${errorBox(t('quotaFailed'), data.message || data.error)}<div class="guide-acts"><button type="button" class="guide-btn" data-retry="quota">${esc(t('retry'))}</button></div>`;
    }
  }
  if (data && !data.error) {
    meta = quotaMetaHtml(data, { t, lang });
    tip = data.fetched_at ? t('fetchedAt', fmtTime(data.fetched_at, true, lang)) : '';
    const pools = Array.isArray(data.pools) ? data.pools : [];
    const cyclesHtml = weeklyCyclesHtml(historyData, openKeys, t, lang);
    if (!error) {
      body = pools.length
        ? pools.map((p) => poolHtml(p, { openKeys, historyData, t, lang })).join('') + cyclesHtml
        : `<p class="empty">${esc(t('noPools'))}</p>${cyclesHtml}`;
    }
  }
  return `<div id="quota-meta" class="meta num" title="${esc(tip)}"${meta ? '' : ' hidden'}>${meta}</div>${body}`;
}

export function createQuotaController({
  pane,
  openKeys,
  getTab,
  getHistoryData = () => null,
  getT,
  getLang,
  getJson,
  keepScroll,
  setMeta,
  onBusyChange,
  onDataChange,
}) {
  const resetFired = new Set();
  let resetTimer = null;

  function paint() {
    const html = renderQuotaHtml({
      data: loader.data,
      historyData: getHistoryData(),
      error: loader.error,
      openKeys,
      t: getT(),
      lang: getLang(),
    });
    keepScroll(() => { pane.innerHTML = html; });
  }

  const loader = makeLoader('/api/quota', QUOTA_STALE_MS, {
    getJson,
    onBusyChange,
    paint: () => {
      paint();
      if (onDataChange) onDataChange();
    },
    keyOf: quotaKey,
    onMeta: (d) => {
      const t = getT();
      const lang = getLang();
      setMeta('quota', quotaMetaHtml(d, { t, lang }), d && d.fetched_at ? t('fetchedAt', fmtTime(d.fetched_at, true, lang)) : '');
    },
    onSilent: () => {
      paint();
      if (onDataChange) onDataChange();
    },
  });

  function scheduleResetRefresh() {
    if (resetTimer) return;
    resetTimer = setTimeout(() => {
      resetTimer = null;
      if (getTab() === 'quota' && !document.hidden) loader.load({ refresh: true, silent: true });
    }, RESET_RETRY_MS);
  }

  function tickCountdowns() {
    if (getTab() !== 'quota' || document.hidden) return;
    const now = Date.now();
    const t = getT();
    const lang = getLang();
    pane.querySelectorAll('[data-reset]').forEach((el) => {
      const iso = el.getAttribute('data-reset');
      if (!iso) return;
      el.textContent = resetText(iso, t, lang, now);
      const d = parseDate(iso);
      if (d && d.getTime() <= now && !resetFired.has(iso)) {
        resetFired.add(iso);
        scheduleResetRefresh();
      }
    });
  }

  return {
    loader,
    paint,
    tickCountdowns,
  };
}
