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

function cycleDiffFooter(summary, summaryTip, t) {
  const leg = '<span class="cy-leg">'
    + `<span class="cy-leg-item"><span class="cell diff-shrink"></span><span>${esc(t('cycleLegShrink'))}</span></span>`
    + `<span class="cy-leg-item"><span class="cell diff-grow"></span><span>${esc(t('cycleLegGrow'))}</span></span>`
    + '</span>';
  return `<div class="heat-foot"><span class="num"${summaryTip ? ` title="${esc(summaryTip)}"` : ''}>${esc(summary)}</span>${leg}</div>`;
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

const pad2 = (n) => String(n).padStart(2, '0');

export function cycleKeyOf(cy) {
  return String((cy && (cy.cycle_start || cy.reset_time || cy.observed_at)) || '');
}

export function formatSegSpan(startIso, endIso, lang = 'en') {
  const a = parseDate(startIso);
  const b = parseDate(endIso);
  if (!a && !b) return '—';
  const hm = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const dm = (d) => `${d.getMonth() + 1}/${d.getDate()}`;
  if (!a) return `${dm(b)} ${hm(b)}`;
  if (!b) return `${dm(a)} ${hm(a)}`;
  const sameDay = a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  return sameDay ? `${dm(a)} ${hm(a)}–${hm(b)}` : `${dm(a)} ${hm(a)}–${dm(b)} ${hm(b)}`;
}

export function pickDefaultSegIndex(segments) {
  if (!Array.isArray(segments) || !segments.length) return -1;
  let bestSurgeIdx = -1;
  let bestSurgeRatio = -1;
  let lastValuedIdx = -1;
  for (let i = 0; i < segments.length; i += 1) {
    const s = segments[i];
    if (!s) continue;
    if (s.kind === 'surge' && isNum(s.burn_ratio) && s.burn_ratio > bestSurgeRatio) {
      bestSurgeRatio = s.burn_ratio;
      bestSurgeIdx = i;
    }
    if (isNum(s.implied_weekly_usd) && s.implied_weekly_usd > 0) {
      lastValuedIdx = i;
    }
  }
  if (bestSurgeIdx >= 0) return bestSurgeIdx;
  if (lastValuedIdx >= 0) return lastValuedIdx;
  return segments.length - 1;
}

export function renderSegmentFootHtml(seg, totalSegs, t, lang = 'en') {
  if (!seg) return `<span class="sf-empty">${esc(t('cycleDrillNoSegs'))}</span>`;
  const span = formatSegSpan(seg.start_at, seg.end_at, lang);
  const usedStr = fmtPctNum(num(seg.used_delta) * 100);
  if (seg.kind === 'external') {
    return `<span class="sf-val is-ext"><span class="seg-foot-val">${esc(t('cycleDrillExternal'))}</span></span>`
      + '<span class="sf-tag"></span>'
      + `<span class="sf-span">${esc(span)}</span>`
      + `<span class="sf-spend"><span class="sf-used">${esc(t('cycleDrillUsed', usedStr))}</span></span>`
      + '<span class="sf-conc"></span>';
  }
  let valInner = '<span class="seg-foot-val dim">&mdash;</span>';
  if (isNum(seg.implied_weekly_usd) && seg.implied_weekly_usd > 0) {
    const ratioStr = isNum(seg.burn_ratio) ? seg.burn_ratio.toFixed(1).replace(/\.0$/, '') : '';
    const badge = seg.kind === 'surge' && ratioStr
      ? `<span class="seg-foot-surge">${esc(t('cycleDrillSurge', ratioStr))}</span>`
      : '';
    valInner = `<span class="seg-foot-val">${esc(fmtUsd(seg.implied_weekly_usd))}</span>${badge}`;
  }
  const tagText = seg.is_gap
    ? t('cycleDrillGap')
    : ((seg.one_sample || (totalSegs === 1 && !seg.low_confidence))
      ? t('cycleDrillOneSample')
      : (seg.low_confidence ? t('cycleDrillLowSample') : ''));
  const spendStr = fmtCost(seg.cost_usd, { partial: Boolean(seg.cost_partial) }) || fmtUsd(seg.cost_usd || 0);
  const concText = seg.peak_concurrency > 0
    ? t('cycleDrillConc', seg.peak_concurrency, seg.p90_concurrency || 0)
    : '';
  return `<span class="sf-val">${valInner}</span>`
    + `<span class="sf-tag">${tagText ? `<span class="seg-foot-gap">${esc(tagText)}</span>` : ''}</span>`
    + `<span class="sf-span">${esc(span)}</span>`
    + `<span class="sf-spend"><span class="sf-cost">${esc(spendStr)}</span><span class="sf-sep" aria-hidden="true">·</span><span class="sf-used">${esc(t('cycleDrillUsed', usedStr))}</span></span>`
    + `<span class="sf-conc">${concText ? esc(concText) : ''}</span>`;
}

export function renderDrillHeaderHtml(cy, poolRefVal, t) {
  const dateLabel = fmtAxisDate(cy && (cy.cycle_start || cy.observed_at || cy.ended_at || cy.reset_time)) || '—';
  const refBase = (cy && cy.segment_baseline_usd) || poolRefVal || 0;
  const compactUsd = (v) => (v >= 100 ? `$${Math.round(v).toLocaleString('en')}` : fmtUsd(v));
  const navHtml = '<span class="wcy-drill-nav">'
    + `<button type="button" class="cy-back-btn" data-cy-back>&larr; ${esc(t('cycleDrillBack'))}</button>`
    + `<span class="cy-drill-title">${esc(t('cycleDrillTitle', dateLabel))}</span>`
    + '</span>';
  const statBits = [];
  if (cy && isNum(cy.weekly_value_usd) && cy.weekly_value_usd > 0) {
    statBits.push(`<span>${esc(t('cycleDrillAvg', compactUsd(cy.weekly_value_usd)))}</span>`);
  }
  if (refBase > 0) {
    statBits.push(`<span>${esc(t('cycleDrillBase', compactUsd(refBase)))}</span>`);
  }
  const statsHtml = statBits.length
    ? `<span class="wcy-drill-stats">${statBits.join('<span class="wcy-sep" aria-hidden="true">·</span>')}</span>`
    : '';
  return `<div class="wcy-head-drill num">${navHtml}${statsHtml}</div>`;
}

export function renderCycleDrillHtml(cy, poolRefVal = 0, activeIdx = -1, t, lang = 'en') {
  const segs = Array.isArray(cy && cy.segments) ? cy.segments : [];
  if (!segs.length) {
    return `<div class="seg-empty">${esc(t('cycleDrillNoSegs'))}</div>`;
  }
  const selIdx = activeIdx >= 0 && activeIdx < segs.length ? activeIdx : pickDefaultSegIndex(segs);
  const baseVal = (cy && cy.segment_baseline_usd) || poolRefVal || 0;
  let maxY = baseVal > 0 ? baseVal : 0;
  for (const s of segs) {
    if (s && isNum(s.implied_weekly_usd) && s.implied_weekly_usd > maxY) {
      maxY = s.implied_weekly_usd;
    }
  }
  const totalDelta = segs.reduce((acc, s) => acc + Math.max(0.005, num(s && s.used_delta)), 0) || segs.length;
  const refBottomPct = maxY > 0 && baseVal > 0 ? Math.max(2, Math.min(98, (baseVal / maxY) * 100)) : null;
  const refLine = refBottomPct !== null
    ? `<div class="seg-ref-line" style="bottom:${refBottomPct.toFixed(1)}%" aria-hidden="true"></div>`
    : '';

  const bars = segs.map((s, idx) => {
    const flexW = Math.max(8, (Math.max(0.005, num(s.used_delta)) / totalDelta) * 100);
    const hasVal = isNum(s.implied_weekly_usd) && s.implied_weekly_usd > 0 && maxY > 0;
    const hPct = hasVal ? Math.max(6, Math.min(100, (s.implied_weekly_usd / maxY) * 100)) : (s.kind === 'external' ? 100 : 12);
    const cls = ['sbar'];
    if (s.kind === 'external') cls.push('is-ext');
    else if (s.kind === 'surge') cls.push('is-surge');
    else if (s.kind === 'slow') cls.push('is-slow');
    if (idx === selIdx) cls.push('is-active');
    const ratioStr = s.kind === 'surge' && isNum(s.burn_ratio) ? s.burn_ratio.toFixed(1).replace(/\.0$/, '') : '';
    const tagHtml = ratioStr && hPct >= 18 ? `<span class="sbar-tag">${esc(ratioStr)}×</span>` : '';
    const tipParts = [formatSegSpan(s.start_at, s.end_at, lang)];
    if (s.kind === 'external') tipParts.push(t('cycleDrillExternal'));
    else if (hasVal) tipParts.push(fmtUsd(s.implied_weekly_usd));
    tipParts.push(t('cycleDrillUsed', fmtPctNum(num(s.used_delta) * 100)));
    if (s.peak_concurrency > 0) tipParts.push(t('cycleDrillConc', s.peak_concurrency, s.p90_concurrency || 0));
    return `<div class="${cls.join(' ')}" data-seg-idx="${idx}" style="flex:${flexW.toFixed(2)} 1 0" aria-label="${esc(tipParts.join(' · '))}">`
      + `<div class="sbar-fill" style="height:${hPct.toFixed(1)}%">${tagHtml}</div></div>`;
  }).join('');

  const fmtX = (iso) => {
    const d = parseDate(iso);
    return d ? `${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}` : '';
  };
  const xHtml = `<div class="seg-x"><span>${esc(fmtX(segs[0].start_at))}</span><span>${esc(fmtX(segs[segs.length - 1].end_at))}</span></div>`;
  const yHtml = maxY > 0
    ? `<div class="seg-y" aria-hidden="true"><span>${esc(fmtAxisUsd(maxY))}</span><span>${esc(fmtAxisUsd(maxY / 2))}</span><span>0</span></div>`
    : '<div class="seg-y" aria-hidden="true"></div>';
  const footHtml = `<div class="seg-foot num">${renderSegmentFootHtml(segs[selIdx], segs.length, t, lang)}</div>`;
  return `<div class="seg-chart">${xHtml}${yHtml}<div class="seg-plot">${refLine}${bars}</div></div>${footHtml}`;
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

function cycleBarChart(list, endDay, period, t, lang, pk = '', drillEntry = null) {
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
  const isValuedCycle = (cy) => !!(cy && isNum(cy.weekly_value_usd) && cy.weekly_value_usd > 0);
  const curCy = shown.find((cy) => cy.is_current) || list.find((cy) => cy.is_current) || null;
  const refCy = isValuedCycle(curCy)
    ? curCy
    : ([...shown].reverse().find(isValuedCycle) || list.find(isValuedCycle) || null);
  const hasRef = !!(refCy && stats.maxVal > 0);
  const refRows = hasRef ? Math.max(1, Math.min(rows, Math.round((refCy.weekly_value_usd / stats.maxVal) * rows))) : 0;

  const emptyCells = '<span class="cell l0"></span>'.repeat(rows);
  let barsHtml = '';
  const ghostCols = Math.max(0, cols - shown.length);
  for (let i = 0; i < ghostCols; i += 1) {
    barsHtml += `<div class="cbar ghost" aria-hidden="true">${emptyCells}</div>`;
  }
  for (let i = 0; i < shown.length; i += 1) {
    const cy = shown[i];
    const hasVal = isNum(cy.weekly_value_usd) && cy.weekly_value_usd > 0 && stats.maxVal > 0;
    const isRefBar = cy === refCy;
    const litRows = hasVal ? Math.max(1, Math.min(rows, Math.round((cy.weekly_value_usd / stats.maxVal) * rows))) : 0;
    const lvl = hasVal ? cycleHeatLevel(cy.weekly_value_usd, stats.maxVal) : 0;
    let cells = '';
    for (let r = rows - 1; r >= 0; r -= 1) {
      if (hasVal && r < litRows) {
        const isShrink = hasRef && !isRefBar && r >= refRows;
        cells += `<span class="cell l${lvl}${isShrink ? ' diff-shrink' : ''}"></span>`;
      } else if (hasVal && hasRef && !isRefBar && r < refRows) {
        cells += '<span class="cell diff-grow"></span>';
      } else {
        cells += '<span class="cell l0"></span>';
      }
    }
    const tip = cycleBarTip(cy, t, lang);
    const colIdx = ghostCols + i;
    const oxPct = `${(((colIdx + 0.5) / cols) * 100).toFixed(1)}%`;
    const cKey = cycleKeyOf(cy);
    barsHtml += `<div class="cbar${cy.is_current ? ' cur' : ''}${!hasVal ? ' unvalued' : ''}" data-cy-pool="${esc(pk)}" data-cy-key="${esc(cKey)}" data-cy-ox="${oxPct}" role="button" tabindex="0" title="${esc(tip)}">${cells}</div>`;
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
  const overviewHtml = `<div class="cy-overview"><div class="cy-chart">${xHtml}${yHtml}<div class="cy-cols${modeCls ? ` ${modeCls}` : ''}" style="--cols:${cols};--rows:${rows}">${barsHtml}</div></div>${cycleDiffFooter(summary, summaryTip, t)}</div>`;

  const drilledCy = drillEntry && drillEntry.cycleKey
    ? (shown.find((c) => cycleKeyOf(c) === drillEntry.cycleKey) || list.find((c) => cycleKeyOf(c) === drillEntry.cycleKey) || null)
    : null;
  const isDrilled = Boolean(drilledCy);
  const oxStyle = drillEntry && drillEntry.ox ? ` style="--ox:${esc(drillEntry.ox)}"` : '';
  const refVal = (refCy && refCy.weekly_value_usd) || stats.maxVal || 0;
  const drillBody = isDrilled
    ? renderCycleDrillHtml(drilledCy, refVal, drillEntry.activeIdx, t, lang)
    : '';
  const stageHtml = `<div class="cy-stage" data-ref-val="${refVal}"${oxStyle}>${overviewHtml}<div class="cy-drill" aria-hidden="${!isDrilled}">${drillBody}</div></div>`;
  return {
    html: stageHtml,
    maxVal: stats.maxVal,
    refVal,
    drilledCy,
  };
}

export function weeklyCyclesHtml(historyData, _openKeys, t, lang, poolOrder = null, { period = 'month', anchorIso = null, activeDrills = null } = {}) {
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
    const drillEntry = activeDrills && activeDrills.get ? activeDrills.get(pk) : null;
    const chart = cycleBarChart(list, endDay, p, t, lang, pk, drillEntry);

    const latest = list[0] || null;
    const peakStr = chart.maxVal > 0 ? t('cyclePeak', fmtUsd(chart.maxVal)) : '';
    const peakHtml = peakStr ? `<span>${esc(peakStr)}</span>` : '';
    const curHtml = list.filter((cy) => cy.is_current).map((cy) => {
      const valHtml = isNum(cy.weekly_value_usd) && cy.weekly_value_usd > 0
        ? `<span class="wcy-cur">${esc(fmtUsd(cy.weekly_value_usd))}</span>`
        : `<span>${esc(t('weeklyEstimating'))}</span>`;
      return `<span class="wcy-cur-grp"><span class="wtag">${esc(t('cycleCurrent'))}</span>${valHtml}</span>`;
    }).join('');
    const dStr = latest ? fmtDeltaPct(latest.change_pct) : '';
    const dLvl = latest ? deltaLevel(latest.change_pct) : '';
    const dTip = latest && isNum(latest.prev_weekly_value_usd) ? t('deltaTip', fmtUsd(latest.prev_weekly_value_usd)) : '';
    const deltaHtml = dStr ? `<span class="wdelta${dLvl ? ` ${dLvl}` : ''}"${dTip ? ` title="${esc(dTip)}"` : ''}>${esc(dStr)}</span>` : '';
    const joinedMeta = [peakHtml, curHtml].filter(Boolean).join('<span class="wcy-sep" aria-hidden="true">·</span>');
    const overMeta = joinedMeta || deltaHtml ? `<div class="wcy-head-over">${joinedMeta}${deltaHtml}</div>` : '';
    const drillMeta = chart.drilledCy ? renderDrillHeaderHtml(chart.drilledCy, chart.refVal, t) : '';
    const metaHtml = overMeta || drillMeta ? `<div class="wcy-pool-meta num">${overMeta}${drillMeta}</div>` : '';

    sections.push(`<div class="wcy-pool${chart.drilledCy ? ' is-drill' : ''}" data-pool="${esc(pk)}" style="--heat-c:${color}">`
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

export function renderQuotaHtml({ data, historyData = null, error, openKeys, cyclePeriod = 'month', activeDrills = null, t, lang }) {
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
      activeDrills,
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
  const drillState = new Map(); // pk -> { cycleKey, ox, activeIdx }
  const leaveTimers = new Map(); // pk -> timerId
  let cyclePeriod = store && CYCLE_PERIODS.includes(store.get('ctx.cyclePeriod', 'month'))
    ? store.get('ctx.cyclePeriod', 'month')
    : 'month';

  function clearLeaveTimer(pk) {
    const id = leaveTimers.get(pk);
    if (id) {
      clearTimeout(id);
      leaveTimers.delete(pk);
    }
  }

  function closeDrill(pk, poolEl = null) {
    clearLeaveTimer(pk);
    drillState.delete(pk);
    const el = poolEl || (pane && pane.querySelector ? pane.querySelector(`.wcy-pool[data-pool="${pk}"]`) : null);
    if (!el) return;
    el.classList.remove('is-drill');
    const drillEl = el.querySelector('.cy-drill');
    const overEl = el.querySelector('.cy-overview');
    if (drillEl) drillEl.setAttribute('aria-hidden', 'true');
    if (overEl) overEl.setAttribute('aria-hidden', 'false');
  }

  function openDrill(barEl) {
    if (!barEl || !pane) return;
    const pk = barEl.getAttribute('data-cy-pool') || '';
    const cycleKey = barEl.getAttribute('data-cy-key') || '';
    const ox = barEl.getAttribute('data-cy-ox') || '50%';
    if (!pk || !cycleKey) return;
    const poolEl = barEl.closest('.wcy-pool');
    if (!poolEl) return;

    clearLeaveTimer(pk);
    const cur = drillState.get(pk);
    if (poolEl.classList.contains('is-drill') && cur && cur.cycleKey === cycleKey) {
      closeDrill(pk, poolEl);
      return;
    }

    const hist = getHistoryData();
    const list = hist && hist.weekly_cycles && Array.isArray(hist.weekly_cycles[pk]) ? hist.weekly_cycles[pk] : [];
    const cy = list.find((c) => cycleKeyOf(c) === cycleKey);
    if (!cy) return;

    const stageEl = poolEl.querySelector('.cy-stage');
    const drillEl = poolEl.querySelector('.cy-drill');
    const overEl = poolEl.querySelector('.cy-overview');
    const metaEl = poolEl.querySelector('.wcy-pool-meta') || poolEl.querySelector('.wcy-pool-head');
    if (!stageEl || !drillEl) return;

    const refAttr = Number(stageEl.getAttribute('data-ref-val') || 0);
    const poolRefVal = Number.isFinite(refAttr) && refAttr > 0 ? refAttr : ((hist.weekly_value_usd && hist.weekly_value_usd[pk]) || 0);
    const activeIdx = pickDefaultSegIndex(cy.segments);
    drillState.set(pk, { cycleKey, ox, activeIdx });

    if (stageEl.style && typeof stageEl.style.setProperty === 'function') {
      stageEl.style.setProperty('--ox', ox);
    } else {
      stageEl.setAttribute('style', `--ox:${ox}`);
    }
    const t = getT();
    const lang = getLang();
    drillEl.innerHTML = renderCycleDrillHtml(cy, poolRefVal, activeIdx, t, lang);
    drillEl.setAttribute('aria-hidden', 'false');
    if (overEl) overEl.setAttribute('aria-hidden', 'true');

    if (metaEl) {
      const nextHeadHtml = renderDrillHeaderHtml(cy, poolRefVal, t);
      metaEl.innerHTML = `${metaEl.innerHTML.replace(/<div class="wcy-head-drill\b[\s\S]*$/i, '')}${nextHeadHtml}`;
    }

    if (!poolEl.classList.contains('is-drill')) {
      void drillEl.offsetWidth; // flush pre-transition scaleX(.18) frame so CSS transition blooms smoothly
      poolEl.classList.add('is-drill');
    }
  }

  function paint() {
    const html = renderQuotaHtml({
      data: loader.data,
      historyData: getHistoryData(),
      error: loader.error,
      openKeys,
      cyclePeriod,
      activeDrills: drillState,
      t: getT(),
      lang: getLang(),
    });
    keepScroll(() => { pane.innerHTML = html; });
  }

  function setCyclePeriod(k, focusBtn = false) {
    if (!CYCLE_PERIODS.includes(k) || k === cyclePeriod) return;
    for (const id of leaveTimers.values()) clearTimeout(id);
    leaveTimers.clear();
    drillState.clear();
    cyclePeriod = k;
    if (store) store.set('ctx.cyclePeriod', k);
    if (loader.data || loader.error) paint();
    if (focusBtn) {
      const btn = pane.querySelector(`.pill[data-qperiod="${k}"]`);
      if (btn) btn.focus();
    }
  }

  if (pane && typeof pane.addEventListener === 'function') {
    pane.addEventListener('click', (e) => {
      const backBtn = e.target && e.target.closest ? e.target.closest('[data-cy-back]') : null;
      if (backBtn) {
        const poolEl = backBtn.closest('.wcy-pool');
        const pk = poolEl ? (poolEl.getAttribute('data-pool') || '') : '';
        if (pk) closeDrill(pk, poolEl);
        return;
      }
      const bar = e.target && e.target.closest ? e.target.closest('.cbar[data-cy-key]') : null;
      if (bar) openDrill(bar);
    });

    pane.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        for (const pk of [...drillState.keys()]) closeDrill(pk);
        return;
      }
      if (e.key === 'Enter' || e.key === ' ') {
        const bar = e.target && e.target.closest ? e.target.closest('.cbar[data-cy-key]') : null;
        if (bar) {
          if (typeof e.preventDefault === 'function') e.preventDefault();
          openDrill(bar);
        }
      }
    });

    pane.addEventListener('mouseover', (e) => {
      const poolEl = e.target && e.target.closest ? e.target.closest('.wcy-pool[data-pool]') : null;
      if (!poolEl) return;
      const pk = poolEl.getAttribute('data-pool') || '';
      clearLeaveTimer(pk);

      const sbar = e.target.closest ? e.target.closest('.sbar[data-seg-idx]') : null;
      if (!sbar || !poolEl.classList.contains('is-drill')) return;
      const st = drillState.get(pk);
      const idx = Number(sbar.getAttribute('data-seg-idx'));
      if (!st || !Number.isInteger(idx) || st.activeIdx === idx) return;

      const hist = getHistoryData();
      const list = hist && hist.weekly_cycles && Array.isArray(hist.weekly_cycles[pk]) ? hist.weekly_cycles[pk] : [];
      const cy = list.find((c) => cycleKeyOf(c) === st.cycleKey);
      const segs = cy && Array.isArray(cy.segments) ? cy.segments : [];
      if (!segs[idx]) return;

      st.activeIdx = idx;
      poolEl.querySelectorAll('.sbar').forEach((b) => {
        b.classList.toggle('is-active', Number(b.getAttribute('data-seg-idx')) === idx);
      });
      const foot = poolEl.querySelector('.seg-foot');
      if (foot) {
        foot.innerHTML = renderSegmentFootHtml(segs[idx], segs.length, getT(), getLang());
      }
    });

    pane.addEventListener('mouseout', (e) => {
      const poolEl = e.target && e.target.closest ? e.target.closest('.wcy-pool[data-pool]') : null;
      if (!poolEl || !poolEl.classList.contains('is-drill')) return;
      if (e.relatedTarget && typeof poolEl.contains === 'function' && poolEl.contains(e.relatedTarget)) return;
      const pk = poolEl.getAttribute('data-pool') || '';
      if (!pk) return;
      clearLeaveTimer(pk);
      const tid = setTimeout(() => closeDrill(pk), 320);
      leaveTimers.set(pk, tid);
    });
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
