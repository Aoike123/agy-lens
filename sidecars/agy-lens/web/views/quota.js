// Quota tab renderer, countdown ticker, and loader controller for Agy Lens.

import {
  CHEV,
  errorBox,
  esc,
  fmtTime,
  fraction,
  isUnlimited,
  levelOf,
  makeLoader,
  parseDate,
  pctText,
  QUOTA_STALE_MS,
  resetText,
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

export function limitHtml(l, single, t, lang) {
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
  </div>`;
}

export function poolHtml(p, { openKeys, t, lang }) {
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
    ${limits.map((l) => limitHtml(l, limits.length === 1, t, lang)).join('')}
    ${shownList.length ? `<div class="tags">${shownList.map(tag).join('')}</div>` : ''}
    ${more}
  </div>`;
}

export function renderQuotaHtml({ data, error, openKeys, t, lang }) {
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
    if (!error) body = pools.length ? pools.map((p) => poolHtml(p, { openKeys, t, lang })).join('') : `<p class="empty">${esc(t('noPools'))}</p>`;
  }
  return `<div id="quota-meta" class="meta num" title="${esc(tip)}"${meta ? '' : ' hidden'}>${meta}</div>${body}`;
}

export function createQuotaController({
  pane,
  openKeys,
  getTab,
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
