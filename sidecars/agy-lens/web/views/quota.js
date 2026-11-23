// Quota tab renderer, countdown ticker, and loader controller for Agy Lens.

import {
  CHEV,
  CYCLE_PERIODS,
  deltaLevel,
  errorBox,
  esc,
  fmtCost,
  fmtCycleDuration,
  fmtCycleSpan,
  fmtDeltaPct,
  fmtInt,
  fmtPctNum,
  fmtTime,
  fmtUsd,
  formatPoolName,
  fraction,
  isNum,
  isUnlimited,
  knownQuotaPools,
  levelOf,
  makeLoader,
  num,
  parseDate,
  parseDay,
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

// Luminous Google-tonal semantic stops aligned with Overview's dot grid palette.
// 68%–100% stays cohesive in emerald green so healthy bars never clash on screen.
const QUOTA_COLOR_STOPS = [
  [0.0, [242, 95, 92]],
  [0.2, [245, 132, 52]],
  [0.42, [249, 171, 0]],
  [0.68, [70, 198, 126]],
  [1.0, [56, 194, 124]],
];

const toHexByte = (n) => Math.round(n).toString(16).padStart(2, '0');

/** Map remaining quota fraction [0..1] to a luminous coral-red -> amber -> emerald-green hex color. */
export function quotaColor(f) {
  if (!isNum(f)) return '#38c27c';
  const x = Math.min(1, Math.max(0, f));
  for (let i = 1; i < QUOTA_COLOR_STOPS.length; i += 1) {
    const [x0, c0] = QUOTA_COLOR_STOPS[i - 1];
    const [x1, c1] = QUOTA_COLOR_STOPS[i];
    if (x <= x1) {
      const t = x1 > x0 ? (x - x0) / (x1 - x0) : 0;
      const r = c0[0] + t * (c1[0] - c0[0]);
      const g = c0[1] + t * (c1[1] - c0[1]);
      const b = c0[2] + t * (c1[2] - c0[2]);
      return `#${toHexByte(r)}${toHexByte(g)}${toHexByte(b)}`;
    }
  }
  const last = QUOTA_COLOR_STOPS[QUOTA_COLOR_STOPS.length - 1][1];
  return `#${toHexByte(last[0])}${toHexByte(last[1])}${toHexByte(last[2])}`;
}

export function meterHtml(f, name) {
  const on = f == null ? 0 : (f > 0 ? Math.max(1, Math.round(f * 20)) : 0);
  const color = quotaColor(f);
  let dots = '';
  for (let i = 0; i < 20; i += 1) {
    dots += i < on ? '<i class="on"></i>' : '<i></i>';
  }
  return `<div class="meter" style="--mc:${color}" role="progressbar" aria-label="${esc(name)}" aria-valuemin="0" aria-valuemax="100"${f != null ? ` aria-valuenow="${Math.round(f * 100)}"` : ''}>${dots}</div>`;
}

export function poolWeeklyValuationHtml(category, l, historyData, t, lang) {
  if (!l || l.kind !== 'weekly' || !historyData || historyData.error) return '';
  const cyclesMap = historyData.weekly_cycles && typeof historyData.weekly_cycles === 'object' ? historyData.weekly_cycles : {};
  const weeklyValueUsd = historyData.weekly_value_usd && typeof historyData.weekly_value_usd === 'object' ? historyData.weekly_value_usd : {};
  const list = Array.isArray(cyclesMap[category]) ? cyclesMap[category] : [];
  const curCy = list.find((cy) => cy.is_current || (l.reset_time && tsOf(cy.reset_time) === tsOf(l.reset_time))) || null;
  const refVal = num(weeklyValueUsd[category]);

  if (curCy && isNum(curCy.weekly_value_usd) && curCy.weekly_value_usd > 0) {
    const estStr = fmtUsd(curCy.weekly_value_usd);
    const dStr = fmtDeltaPct(curCy.change_pct);
    const dLvl = deltaLevel(curCy.change_pct);
    const dTip = isNum(curCy.prev_weekly_value_usd) ? t('deltaTip', fmtUsd(curCy.prev_weekly_value_usd)) : '';
    const deltaHtml = dStr ? `<span class="wdelta${dLvl ? ` ${dLvl}` : ''}"${dTip ? ` title="${esc(dTip)}"` : ''}>${esc(dStr)}</span>` : '';
    let leftTxt;
    if (curCy.valuation_method === 'delta') {
      const obsCostStr = fmtCost(curCy.observed_cost_usd, { estimated: !!curCy.cost_estimated, partial: !!curCy.cost_partial }) || '$0.00';
      leftTxt = t('deltaSpent', obsCostStr);
    } else {
      const spentStr = fmtCost(curCy.cycle_cost_usd || curCy.observed_cost_usd, { estimated: !!curCy.cost_estimated, partial: !!curCy.cost_partial }) || '$0.00';
      leftTxt = t('cycleSpent', spentStr);
    }
    return `<div class="wbudget-val num"><span>${esc(leftTxt)}</span><span>${esc(t('weeklyEstValue', estStr))}${deltaHtml}</span></div>`;
  }
  if (curCy && (curCy.valuation_method === 'delta' || num(curCy.used_fraction) > 0)) {
    const spentVal = curCy.cycle_cost_usd || curCy.observed_cost_usd;
    const leftTxt = spentVal > 0
      ? t('cycleSpent', fmtCost(spentVal, { estimated: !!curCy.cost_estimated, partial: !!curCy.cost_partial }) || '$0.00')
      : t('cycleLowUsage');
    const rightVal = refVal > 0 ? t('weeklyPrevRef', fmtUsd(refVal)) : t('weeklyEstimating');
    return `<div class="wbudget-val num"><span>${esc(leftTxt)}</span><span>${esc(rightVal)}</span></div>`;
  }
  if (refVal > 0) {
    return `<div class="wbudget-val num"><span>${esc(t('weeklyPrevRef', fmtUsd(refVal)))}</span></div>`;
  }
  return '';
}

const BAR_ROWS_MIN = 3;
const BAR_ROWS_MAX = 12;
const BAR_ASPECT_RATIO = 0.29;
const BAR_COLS_MONTH = 10;
const BAR_COLS_M3 = 14;
const BAR_COLS_ALL_MIN = 24;
const BAR_COLS_ALL_MAX = 52;
const EARLY_CYCLE_MS = 6.5 * 86400_000;

const POOL_COLORS = {
  gemini: 'var(--c-agent)',
  claude_gpt: 'var(--c-tool)',
  claude_opus: 'var(--c-custom)',
  claude_sonnet: 'var(--c-sysmsg)',
};
const EXTRA_POOL_COLORS = ['var(--c-user)', 'var(--c-custom)', 'var(--c-sysmsg)', 'var(--c-system)'];

function poolColor(pk, idx) {
  return POOL_COLORS[pk] || EXTRA_POOL_COLORS[idx % EXTRA_POOL_COLORS.length];
}

function toLocalDay(iso) {
  const d = parseDate(iso);
  return d ? new Date(d.getFullYear(), d.getMonth(), d.getDate()) : null;
}

function isEarlyResetCycle(cy) {
  if (!cy || !cy.ended_at) return false;
  const resetMs = tsOf(cy.reset_time);
  const endedMs = tsOf(cy.ended_at);
  if (Number.isFinite(resetMs) && Number.isFinite(endedMs) && resetMs - endedMs > 3600_000) return true;
  return isNum(cy.cycle_duration_ms) && cy.cycle_duration_ms > 0 && cy.cycle_duration_ms < EARLY_CYCLE_MS;
}

function resolveAnchorDay(historyData, cyclesMap, orderedPools, anchorIso) {
  const daily = Array.isArray(historyData && historyData.daily) ? historyData.daily : [];
  if (daily.length) {
    const last = parseDay(daily[daily.length - 1].date);
    if (!Number.isNaN(last.getTime())) return last;
  }
  const scanned = historyData && historyData.scanned_at ? toLocalDay(historyData.scanned_at) : null;
  if (scanned) return scanned;
  const fetched = anchorIso ? toLocalDay(anchorIso) : null;
  if (fetched) return fetched;
  let latest = null;
  for (const pk of orderedPools) {
    for (const cy of cyclesMap[pk] || []) {
      for (const iso of [cy && cy.observed_at, cy && cy.cycle_start, cy && cy.ended_at, cy && cy.reset_time]) {
        const d = iso ? toLocalDay(iso) : null;
        if (d && (!latest || d.getTime() > latest.getTime())) latest = d;
      }
    }
  }
  if (latest) return latest;
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function cycleHeatLevel(val, maxVal) {
  if (!isNum(val) || val <= 0 || !isNum(maxVal) || maxVal <= 0) return 0;
  const r = val / maxVal;
  return r >= 0.85 ? 4 : r >= 0.6 ? 3 : r >= 0.35 ? 2 : 1;
}

function cycleRangeStats(cyclesList, allList) {
  let maxInRange = 0;
  let totalVal = 0;
  let valuedCount = 0;
  let early = 0;
  for (const cy of cyclesList) {
    if (isEarlyResetCycle(cy)) early += 1;
    if (isNum(cy.weekly_value_usd) && cy.weekly_value_usd > 0) {
      maxInRange = Math.max(maxInRange, cy.weekly_value_usd);
      totalVal += cy.weekly_value_usd;
      valuedCount += 1;
    }
  }
  const allMax = Math.max(0, ...allList.map((cy) => (isNum(cy.weekly_value_usd) && cy.weekly_value_usd > 0 ? cy.weekly_value_usd : 0)));
  const count = Array.isArray(cyclesList) ? cyclesList.length : cyclesList.size;
  return {
    count,
    early,
    maxVal: maxInRange > 0 ? maxInRange : allMax,
    totalVal,
    valuedCount,
  };
}

function cycleHeatFooter(summary, summaryTip, t) {
  const scale = `<span class="scale"><span class="t">${esc(t('less'))}</span>${[0, 1, 2, 3, 4].map((l) => `<span class="cell l${l}"></span>`).join('')}<span class="t">${esc(t('more'))}</span></span>`;
  return `<div class="heat-foot"><span class="num"${summaryTip ? ` title="${esc(summaryTip)}"` : ''}>${esc(summary)}</span>${scale}</div>`;
}

function fmtAxisUsd(v) {
  if (!isNum(v) || v <= 0) return '0';
  if (v >= 1000) return `$${(v / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  if (v >= 10) return `$${Math.round(v)}`;
  return `$${v.toFixed(1).replace(/\.0$/, '')}`;
}

function fmtAxisDate(iso) {
  const d = parseDate(iso);
  return d ? `${d.getMonth() + 1}/${d.getDate()}` : '';
}

function cycleOverlapsRange(cy, minDay, endDay) {
  if (!cy) return false;
  if (cy.is_current) return true;
  const startRaw = toLocalDay(cy.cycle_start || cy.first_seen_at || cy.observed_at || cy.ended_at || cy.reset_time);
  if (!startRaw) return false;
  const endRaw = toLocalDay(cy.ended_at || cy.reset_time || cy.observed_at) || startRaw;
  return endRaw.getTime() >= minDay.getTime() && startRaw.getTime() <= endDay.getTime();
}

function cycleBarTip(cy, t, lang) {
  const endIso = cy.ended_at || cy.reset_time;
  const span = fmtCycleSpan(cy.cycle_start, endIso, lang);
  const durStr = fmtCycleDuration(cy.cycle_duration_ms, lang);
  const usedPctStr = fmtPctNum(num(cy.used_fraction) * 100);
  const hasVal = isNum(cy.weekly_value_usd) && cy.weekly_value_usd > 0;
  const spentVal = cy.cycle_cost_usd || cy.observed_cost_usd;
  const tipCost = fmtCost(spentVal, { estimated: !!cy.cost_estimated, partial: !!cy.cost_partial });
  const badge = cy.is_current ? t('cycleCurrent') : (isEarlyResetCycle(cy) ? t('cycleEarlyMark') : '');
  return [
    badge,
    span,
    durStr,
    hasVal ? t('weeklyEstValue', fmtUsd(cy.weekly_value_usd)) : (cy.is_current ? t('weeklyEstimating') : t('cycleLowUsage')),
    tipCost ? t('cycleSpentShort', tipCost) : '',
    t('used', usedPctStr),
  ].filter(Boolean).join(' · ');
}

function cycleBarXAxis(cols, shown, modeCls) {
  if (!shown.length) return '';
  const startCol = cols - shown.length + 1;
  const dateOf = (cy) => fmtAxisDate((cy && (cy.cycle_start || cy.observed_at || cy.ended_at || cy.reset_time)) || '');
  let ticks = '';
  if (cols <= 10) {
    for (let i = 0; i < shown.length; i += 1) {
      const lbl = dateOf(shown[i]);
      if (lbl) ticks += `<span class="ax c" style="grid-column:${startCol + i}">${esc(lbl)}</span>`;
    }
  } else if (cols <= 18) {
    const rightCol = Math.max(1, cols - 1);
    if (shown.length >= 2 && rightCol - startCol >= 3) {
      const leftLbl = dateOf(shown[0]);
      if (leftLbl) ticks += `<span class="ax" style="grid-column:${startCol} / span 2">${esc(leftLbl)}</span>`;
      if (rightCol - startCol >= 6) {
        const step = Math.max(3, Math.ceil(shown.length / 3));
        for (let i = step; i < shown.length - 1; i += step) {
          const col = startCol + i;
          if (col + 2 > rightCol - 1) break;
          const lbl = dateOf(shown[i]);
          if (lbl) ticks += `<span class="ax" style="grid-column:${col} / span 2">${esc(lbl)}</span>`;
        }
      }
    }
    const rightLbl = dateOf(shown[shown.length - 1]);
    if (rightLbl) {
      ticks += `<span class="ax r" style="grid-column:${rightCol} / span ${Math.min(2, cols)}">${esc(rightLbl)}</span>`;
    }
  } else {
    const rightCol = Math.max(1, cols - 3);
    if (shown.length >= 2 && rightCol - startCol >= 4) {
      const leftLbl = dateOf(shown[0]);
      if (leftLbl) ticks += `<span class="ax" style="grid-column:${startCol} / span 4">${esc(leftLbl)}</span>`;
      if (shown.length >= 12) {
        const step = Math.max(6, Math.ceil(shown.length / 4));
        for (let i = step; i < shown.length - 1; i += step) {
          const col = startCol + i;
          if (col + 4 > rightCol - 1) break;
          const lbl = dateOf(shown[i]);
          if (lbl) ticks += `<span class="ax" style="grid-column:${col} / span 4">${esc(lbl)}</span>`;
        }
      }
    }
    const rightLbl = dateOf(shown[shown.length - 1]);
    if (rightLbl) {
      ticks += `<span class="ax r" style="grid-column:${rightCol} / span ${Math.min(4, cols)}">${esc(rightLbl)}</span>`;
    }
  }
  if (!ticks) return '';
  return `<div class="cy-x${modeCls ? ` ${modeCls}` : ''}" style="--cols:${cols}">${ticks}</div>`;
}

function cycleBarRows(cols) {
  return Math.max(BAR_ROWS_MIN, Math.min(BAR_ROWS_MAX, Math.round(cols * BAR_ASPECT_RATIO)));
}

function cycleBarChart(list, endDay, period, t, lang) {
  let source = list;
  if (period === 'month') {
    const minDay = new Date(endDay.getFullYear(), endDay.getMonth(), 1);
    source = list.filter((cy) => cycleOverlapsRange(cy, minDay, endDay));
  } else if (period === 'm3') {
    const minDay = new Date(endDay.getFullYear(), endDay.getMonth() - 3, endDay.getDate() + 1);
    source = list.filter((cy) => cycleOverlapsRange(cy, minDay, endDay));
  }
  const chrono = [...source].reverse();
  const shown = chrono.slice(-BAR_COLS_ALL_MAX);
  const cols = period === 'all'
    ? Math.min(BAR_COLS_ALL_MAX, Math.max(BAR_COLS_ALL_MIN, shown.length))
    : period === 'm3'
      ? Math.min(BAR_COLS_ALL_MAX, Math.max(BAR_COLS_M3, shown.length))
      : Math.min(BAR_COLS_ALL_MAX, Math.max(BAR_COLS_MONTH, shown.length));
  const rows = cycleBarRows(cols);
  const modeCls = cols > 32 ? 'all dense' : cols >= 19 ? 'all' : cols >= 11 ? 'm3' : '';
  const stats = cycleRangeStats(shown, list);

  const emptyCells = '<span class="cell l0"></span>'.repeat(rows);
  let barsHtml = '';
  const ghostCols = Math.max(0, cols - shown.length);
  for (let i = 0; i < ghostCols; i += 1) {
    barsHtml += `<div class="cbar ghost" aria-hidden="true">${emptyCells}</div>`;
  }
  for (const cy of shown) {
    const hasVal = isNum(cy.weekly_value_usd) && cy.weekly_value_usd > 0 && stats.maxVal > 0;
    const litRows = hasVal ? Math.max(1, Math.min(rows, Math.round((cy.weekly_value_usd / stats.maxVal) * rows))) : 0;
    const lvl = hasVal ? cycleHeatLevel(cy.weekly_value_usd, stats.maxVal) : 0;
    let cells = '';
    for (let r = rows - 1; r >= 0; r -= 1) {
      cells += r < litRows ? `<span class="cell l${lvl}"></span>` : '<span class="cell l0"></span>';
    }
    const tip = cycleBarTip(cy, t, lang);
    barsHtml += `<div class="cbar${cy.is_current ? ' cur' : ''}${!hasVal ? ' unvalued' : ''}" title="${esc(tip)}">${cells}</div>`;
  }

  const yHtml = stats.maxVal > 0
    ? `<div class="cy-y" aria-hidden="true"><span>${esc(fmtAxisUsd(stats.maxVal))}</span><span>${esc(fmtAxisUsd(stats.maxVal / 2))}</span><span>0</span></div>`
    : '<div class="cy-y" aria-hidden="true"></div>';
  const xHtml = cycleBarXAxis(cols, shown, modeCls);
  const summary = period === 'all'
    ? t('cycleAllResets', fmtInt(stats.count, lang), stats.early)
    : period === 'm3'
      ? t('cycleInMonths', fmtInt(stats.count, lang), 3, stats.early)
      : t('cycleInMonth', fmtInt(stats.count, lang), stats.early);
  const summaryTip = stats.valuedCount > 0
    ? t('cycleSummaryTip', fmtUsd(stats.totalVal), fmtUsd(stats.totalVal / stats.valuedCount))
    : '';
  return {
    html: `<div class="cy-chart">${xHtml}${yHtml}<div class="cy-cols${modeCls ? ` ${modeCls}` : ''}" style="--cols:${cols};--rows:${rows}">${barsHtml}</div></div>${cycleHeatFooter(summary, summaryTip, t)}`,
    maxVal: stats.maxVal,
  };
}

export function weeklyCyclesHtml(historyData, _openKeys, t, lang, poolOrder = null, { period = 'month', anchorIso = null } = {}) {
  const cyclesMap = historyData && !historyData.error && historyData.weekly_cycles && typeof historyData.weekly_cycles === 'object'
    ? historyData.weekly_cycles
    : null;
  if (!cyclesMap) return '';
  const seenPools = new Set();
  const orderedPools = [];
  for (const pk of Array.isArray(poolOrder) ? poolOrder : []) {
    if (pk && !seenPools.has(pk) && Array.isArray(cyclesMap[pk]) && cyclesMap[pk].length) {
      seenPools.add(pk);
      orderedPools.push(pk);
    }
  }
  for (const pk of knownQuotaPools(cyclesMap)) {
    if (!seenPools.has(pk) && Array.isArray(cyclesMap[pk]) && cyclesMap[pk].length) {
      seenPools.add(pk);
      orderedPools.push(pk);
    }
  }
  if (!orderedPools.length) return '';

  const p = CYCLE_PERIODS.includes(period) ? period : 'month';
  const endDay = resolveAnchorDay(historyData, cyclesMap, orderedPools, anchorIso);
  const pn = t('poolShort');
  const pillLabels = t('cyclePills');
  const pills = CYCLE_PERIODS.map((k) => {
    const on = k === p;
    return `<button class="pill" type="button" role="tab" data-qperiod="${k}" aria-selected="${on}" tabindex="${on ? 0 : -1}">${esc(pillLabels[k])}</button>`;
  }).join('');

  const sections = [];
  for (let poolIdx = 0; poolIdx < orderedPools.length; poolIdx += 1) {
    const pk = orderedPools[poolIdx];
    const list = cyclesMap[pk];
    const color = poolColor(pk, poolIdx);
    const chart = cycleBarChart(list, endDay, p, t, lang);

    const latest = list[0] || null;
    const peakStr = chart.maxVal > 0 ? t('cyclePeak', fmtUsd(chart.maxVal)) : '';
    const peakHtml = peakStr ? `<span>${esc(peakStr)}</span>` : '';
    const curHtml = list.filter((cy) => cy.is_current).map((cy) => {
      const valHtml = isNum(cy.weekly_value_usd) && cy.weekly_value_usd > 0
        ? `<span class="wcy-cur">${esc(fmtUsd(cy.weekly_value_usd))}</span>`
        : '';
      return `<span class="wcy-cur-grp"><span class="wtag">${esc(t('cycleCurrent'))}</span>${valHtml}</span>`;
    }).join('');
    const dStr = latest ? fmtDeltaPct(latest.change_pct) : '';
    const dLvl = latest ? deltaLevel(latest.change_pct) : '';
    const dTip = latest && isNum(latest.prev_weekly_value_usd) ? t('deltaTip', fmtUsd(latest.prev_weekly_value_usd)) : '';
    const deltaHtml = dStr ? `<span class="wdelta${dLvl ? ` ${dLvl}` : ''}"${dTip ? ` title="${esc(dTip)}"` : ''}>${esc(dStr)}</span>` : '';
    const joinedMeta = [peakHtml, curHtml].filter(Boolean).join('<span class="wcy-sep" aria-hidden="true">·</span>');
    const metaHtml = joinedMeta || deltaHtml
      ? `<div class="wcy-pool-meta num">${joinedMeta}${deltaHtml}</div>`
      : '';

    sections.push(`<div class="wcy-pool" style="--heat-c:${color}">`
      + `<div class="wcy-pool-head"><div class="wcy-pool-title"><span class="mark" style="background:${color}"></span><span>${esc(formatPoolName(pk, pn))}</span></div>${metaHtml}</div>`
      + chart.html
      + '</div>');
  }
  if (!sections.length) return '';
  return `<section class="wcycles" aria-label="${esc(t('cycleHistoryHeading'))}">
    <div class="wcycles-head">
      <div class="pool-label">${esc(t('cycleHistoryHeading'))}</div>
      <div class="period-bar" role="tablist" aria-label="${esc(t('periodBarAria'))}">${pills}</div>
    </div>
    <div class="wcycles-body">${sections.join('')}</div>
  </section>`;
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

export function isUnlimitedPool(p, lang = 'en') {
  if (!p) return false;
  const limits = poolLimits(p, lang);
  return limits.length > 0 && limits.every((l) => isUnlimited(l));
}

export function poolHtml(p, { openKeys, historyData = null, free = false, t, lang }) {
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
  return `<div class="pool${free ? ' pool-free' : ''}">
    <div class="pool-label">${esc(label)}</div>
    ${limits.map((l) => limitHtml(l, limits.length === 1, t, lang, poolWeeklyValuationHtml(p.category, l, historyData, t, lang))).join('')}
    ${shownList.length ? `<div class="tags">${shownList.map(tag).join('')}</div>` : ''}
    ${more}
  </div>`;
}

export function renderQuotaHtml({ data, historyData = null, error, openKeys, cyclePeriod = 'month', t, lang }) {
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
    const limitedPools = pools.filter((p) => !isUnlimitedPool(p, lang));
    const unlimitedPools = pools.filter((p) => isUnlimitedPool(p, lang));
    const poolOrder = limitedPools.map((p) => p && p.category).filter(Boolean);
    const cyclesHtml = weeklyCyclesHtml(historyData, openKeys, t, lang, poolOrder, {
      period: cyclePeriod,
      anchorIso: data.fetched_at,
    });
    if (!error) {
      body = pools.length
        ? limitedPools.map((p) => poolHtml(p, { openKeys, historyData, t, lang })).join('')
          + cyclesHtml
          + unlimitedPools.map((p) => poolHtml(p, { openKeys, historyData, free: true, t, lang })).join('')
        : `<p class="empty">${esc(t('noPools'))}</p>${cyclesHtml}`;
    }
  }
  return `<div id="quota-meta" class="meta num" title="${esc(tip)}"${meta ? '' : ' hidden'}>${meta}</div>${body}`;
}

export function createQuotaController({
  pane,
  store = null,
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
  let cyclePeriod = store && CYCLE_PERIODS.includes(store.get('ctx.cyclePeriod', 'month'))
    ? store.get('ctx.cyclePeriod', 'month')
    : 'month';

  function paint() {
    const html = renderQuotaHtml({
      data: loader.data,
      historyData: getHistoryData(),
      error: loader.error,
      openKeys,
      cyclePeriod,
      t: getT(),
      lang: getLang(),
    });
    keepScroll(() => { pane.innerHTML = html; });
  }

  function setCyclePeriod(k, focusBtn = false) {
    if (!CYCLE_PERIODS.includes(k) || k === cyclePeriod) return;
    cyclePeriod = k;
    if (store) store.set('ctx.cyclePeriod', k);
    if (loader.data || loader.error) paint();
    if (focusBtn) {
      const btn = pane.querySelector(`.pill[data-qperiod="${k}"]`);
      if (btn) btn.focus();
    }
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
    getCyclePeriod: () => cyclePeriod,
    setCyclePeriod,
  };
}
