// Overview tab renderer and controller for Agy Lens.

import {
  CHEV,
  convWeeklyLabel,
  esc,
  fmtCost,
  fmtInt,
  fmtPctNum,
  fmtSec,
  fmtTime,
  fmtTok,
  fmtTps,
  fmtUsd,
  formatPoolName,
  gridCells,
  hasAnyWeeklyValue,
  HISTORY_STALE_MS,
  isNum,
  knownQuotaPools,
  newTok,
  num,
  poolRowLabel,
  pricingTip,
  QUOTA_STALE_MS,
  sortActivePools,
} from '../format.js';

const SEGMENT_COLORS = ['var(--c-system)', 'var(--c-user)', 'var(--c-agent)', 'var(--c-tool)', 'var(--c-custom)'];
const CONVERSATION = { user: 'var(--c-user)', agent: 'var(--c-agent)', tool: 'var(--c-tool)', system_messages: 'var(--c-sysmsg)' };
const SYSTEM = new Set(['system_prompt', 'system_tools', 'system_overhead']);

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function splitPath(path, conversationId, t) {
  const trimmed = String(path || '').replace(/\/$/, '');
  const i = trimmed.lastIndexOf('/');
  const name = trimmed.slice(i + 1) + (String(path || '').endsWith('/') ? '/' : '');
  let dir = i > 0 ? trimmed.slice(0, i) : '';
  if (conversationId) dir = dir.replace(new RegExp(`^.*/brain/${escapeRegExp(conversationId)}`), t('conversationFolder'));
  return { name, dir };
}

function gridHtml(r, t) {
  const counts = gridCells(r.grid_segments || [], r.limit_tokens, 100);
  let dots = '';
  counts.forEach((n, i) => {
    dots += (i === 5 ? '<span class="dot"></span>' : `<span class="dot" style="background:${SEGMENT_COLORS[i]}"></span>`).repeat(n);
  });
  return `<div class="grid" title="${esc(t('gridTitle'))}">${dots}</div>`;
}

function budgetHtml(r, t) {
  const b = r.request_budget_tokens;
  const limit = r.limit_tokens;
  if (!b || b <= 0 || !limit || b === limit) return '';
  const pct = (num(r.used_tokens) / b * 100).toFixed(1);
  const over = r.used_tokens > b;
  return `<p class="budget num${over ? ' over' : ''}" title="${esc(over ? t('budgetOver') : t('budgetHint'))}">${esc(t('budget', fmtTok(b), pct))}</p>`;
}

function categoryRow(c, t) {
  const name = t('categories')[c.key] || c.name;
  const color = CONVERSATION[c.key] || (SYSTEM.has(c.key) ? 'var(--c-system)' : 'var(--c-custom)');
  const shape = CONVERSATION[c.key] ? '' : ' sq';
  return `<div class="row"><span class="mark${shape}" style="background:${color}"></span><span class="ellipsis">${esc(name)}</span>`
    + `<span class="tok num">${fmtTok(c.tokens)}</span><span class="p num">${num(c.pct).toFixed(1)}%</span></div>`;
}

function categoriesHtml(r, t) {
  const cats = r.categories || [];
  const conv = cats.filter((c) => CONVERSATION[c.key]);
  const rest = cats.filter((c) => !CONVERSATION[c.key]);
  const limit = r.limit_tokens;
  const freePct = limit ? (r.free_tokens / limit * 100).toFixed(1) : '0.0';
  const free = `<div class="row"><span class="mark free"></span><span class="dim">${esc(t('freeSpace'))}</span>`
    + `<span class="tok num">${fmtTok(r.free_tokens)}</span><span class="p num">${freePct}%</span></div>`;
  const note = r.heading === 'Token usage by category' ? '' : `<p class="note" style="margin:0 0 8px">${esc(t('headings')[r.heading] || r.heading)}</p>`;
  const buffer = r.checkpoint_buffer ? `<p class="note">${esc(t('checkpointBuffer', fmtTok(r.checkpoint_buffer)))}</p>` : '';
  return `<section><h2>${esc(t('tokenUsage'))}</h2>${note}
    <div class="group">${conv.map((c) => categoryRow(c, t)).join('')}</div>
    ${rest.length ? `<div class="group">${rest.map((c) => categoryRow(c, t)).join('')}</div>` : ''}
    <div class="group">${free}</div>${buffer}</section>`;
}

function checkpointsHtml(r, t) {
  const ck = r.checkpoint_view;
  if (!ck) return '';
  const older = ck.historical ? `<p class="note">${esc(t('olderCheckpoints', ck.historical))}</p>` : '';
  return `<section><h2>${esc(t('checkpoints'))} <span class="hint">${esc(ck.count)} · /rewind</span></h2>
    <div class="ck-main"><span>${esc(t('checkpointN', ck.active_number))}: ${esc(ck.active_text)}</span><span class="badge">${esc(t('inContext'))}</span></div>${older}</section>`;
}

function filesHtml(title, hint, items, conversationId, t) {
  if (!items || !items.length) return '';
  const rows = items.map((f) => {
    const { name, dir } = splitPath(f.path, conversationId, t);
    return `<li title="${esc(f.path)}"><span class="name">${esc(name)}<span class="dir">&lrm;${esc(dir)}</span></span>`
      + `<span class="tok num">${f.tokens > 0 ? fmtTok(f.tokens) : ''}</span></li>`;
  }).join('');
  return `<section><h2>${esc(title)} <span class="hint">${esc(hint)}</span></h2><ul class="files">${rows}</ul></section>`;
}

/** Recent calls as bars: streaming tok/s only (never e2e fallback); buffered bursts render as quiet stubs. */
function trendBars(recent, t) {
  if (!Array.isArray(recent) || recent.length < 2) return '';
  const vals = recent.map((x) => (!x.buffered && isNum(x.streaming_tps) ? x.streaming_tps : null));
  const sorted = vals.filter((v) => v != null).sort((a, b) => a - b);
  if (!sorted.length || !sorted[sorted.length - 1]) return '';
  const median = sorted[Math.floor((sorted.length - 1) / 2)];
  const top = Math.min(sorted[sorted.length - 1], Math.max(median * 2, 1));
  const bars = recent.map((x, i) => {
    const v = vals[i];
    if (v == null) {
      const tip = t('bufTip', fmtTps(x.e2e_tps), fmtSec(x.total_sec));
      return `<span class="sbar buf" title="${esc(tip)}"></span>`;
    }
    const tip = t('speedTip', fmtTps(x.streaming_tps), fmtTps(x.e2e_tps), fmtSec(x.ttft_sec), fmtTok(x.output_tokens));
    const cls = ['sbar', v > top ? 'clip' : '', i === recent.length - 1 ? 'last' : ''].filter(Boolean).join(' ');
    const h = Math.max(2, Math.round(Math.min(v, top) / top * 36));
    return `<span class="${cls}" style="height:${h}px" title="${esc(tip)}"></span>`;
  }).join('');
  return `<div class="trend"><div class="bars">${bars}</div><span class="lbl">${esc(t('median', median.toFixed(0)))}</span></div>`;
}

function speedByModel(list, openKeys, t, lang) {
  if (!Array.isArray(list) || list.length < 2) return '';
  const rows = list.map((m, i) => {
    const key = `spd:${m.model || i}:${m.agent || 'main'}`;
    const name = m.display_name || m.model || '?';
    const agent = m.agent === 'main' ? t('agentMain') : m.agent === 'subagent' ? t('agentSub') : '';
    const bars = trendBars(m.recent, t);
    const body = `<span class="ellipsis" title="${esc(m.model || '')}">${esc(name)}${agent ? ` <span class="dim">· ${esc(agent)}</span>` : ''}</span>`
      + `<span class="rv num"><b>${fmtTps(m.avg_streaming_tps)}</b> tok/s</span>`
      + `<span class="sub num">${esc(t('ttft'))} ${esc(fmtSec(m.avg_ttft_sec))} · ${esc(t('calls', fmtInt(m.calls, lang)))}</span>`;
    if (!bars) return `<li><div class="spd-row plain">${body}</div></li>`;
    return `<li><details data-key="${esc(key)}"${openKeys && openKeys.has(key) ? ' open' : ''}><summary class="spd-row">${CHEV}${body}</summary>
      <div class="spd-trend">${bars}</div></details></li>`;
  }).join('');
  return `<h2 style="margin:20px 0 4px">${esc(t('byModelSpeed'))} <span class="hint">${esc(t('streaming'))}</span></h2><ul class="spd">${rows}</ul>`;
}

function speedHtml(r, openKeys, t, lang) {
  const s = r.speed;
  if (!s || !s.latest) {
    return `<section><h2>${esc(t('speedTitle'))}</h2><p class="note" style="margin:0">${esc(t('speedWaiting'))}</p></section>`;
  }
  const l = s.latest;
  const latestValid = !l.buffered && isNum(l.streaming_tps);
  const headVal = latestValid ? l.streaming_tps : s.avg_streaming_tps;
  const headSub = !latestValid && isNum(s.avg_streaming_tps)
    ? t('bufFallback')
    : t('avgOf', `${fmtTps(s.avg_streaming_tps)} tok/s`);
  const thinking = l.thinking_tokens > 0 ? t('thinkingNote', fmtTok(l.thinking_tokens), fmtTok(l.response_tokens)) : '';
  const stream = l.streaming_sec != null ? t('streamNote', fmtSec(l.streaming_sec)) : '';
  return `<section><h2>${esc(t('speedTitle'))} <span class="hint">${esc(t('speedCalls', s.calls))}</span></h2>
    <div class="speed-head">
      <div title="${esc(t('tipStream'))}"><div class="lbl">${esc(t('streaming'))}</div>
        <div class="fig num">${fmtTps(headVal)}<span class="unit">tok/s</span></div>
        <div class="lbl num">${esc(headSub)}</div></div>
      ${trendBars(s.recent, t)}
    </div>
    <div class="stats">
      <div title="${esc(t('tipE2e', fmtTps(s.avg_e2e_tps)))}"><div class="lbl">${esc(t('e2e'))}</div><div class="v num">${fmtTps(l.e2e_tps)}<span class="unit">tok/s</span></div></div>
      <div title="${esc(t('tipTtft', fmtSec(s.avg_ttft_sec)))}"><div class="lbl">${esc(t('ttft'))}</div><div class="v num">${fmtSec(l.ttft_sec)}</div></div>
      <div><div class="lbl">${esc(t('cacheHit'))}</div><div class="v num">${isNum(l.cache_hit_pct) ? `${l.cache_hit_pct.toFixed(0)}%` : '—'}</div></div>
    </div>
    <p class="note num">${esc(t('lastReply', fmtTok(l.output_tokens)) + thinking + stream)}</p>
    ${speedByModel(s.by_model, openKeys, t, lang)}
  </section>`;
}

// The conversation including all its subagents. The live session covers
// subagents whose databases still exist; History also remembers ones Antigravity
// has deleted, so its subtree total wins when it is larger.
function sessionWithSubagents(s, hd, conversationId) {
  const hc = hd && conversationId && Array.isArray(hd.by_conversation)
    ? hd.by_conversation.find((c) => c && c.id === conversationId)
    : null;
  const tot = hc && hc.total;
  if (!tot || !num(tot.subagents) || num(tot.calls) <= num(s.calls)) return s;
  const prompt = num(tot.input) + num(tot.cache_read);
  let subPool = hc.pool || s.pool || 'other';
  if (tot.cost_by_pool && typeof tot.cost_by_pool === 'object') {
    let bestCost = 0;
    for (const pk of Object.keys(tot.cost_by_pool)) {
      const v = num(tot.cost_by_pool[pk]);
      if (v > bestCost) { bestCost = v; subPool = pk; }
    }
  }
  return {
    ...s,
    pool: subPool,
    input: tot.input,
    output: tot.output,
    cache_read: tot.cache_read,
    thinking: tot.thinking,
    calls: tot.calls,
    total_tokens: num(tot.input) + num(tot.output),
    cache_hit_pct: prompt > 0 ? Math.round(num(tot.cache_read) / prompt * 1000) / 10 : null,
    est_cost_usd: tot.est_cost_usd,
    cost_estimated: tot.cost_estimated,
    cost_partial: tot.cost_partial,
    d7_tokens: tot.d7_tokens,
    d7_by_pool: tot.d7_by_pool,
    cost_by_pool: tot.cost_by_pool,
    quota_cost_by_pool: tot.quota_cost_by_pool || null,
    subagents: tot.subagents,
    self: { input: hc.input, output: hc.output, cache_read: hc.cache_read, calls: hc.calls, est_cost_usd: hc.est_cost_usd, cost_estimated: hc.cost_estimated },
  };
}

function sessionHtml(r, { historyData, conversationId = '', t, lang }) {
  const hd = historyData && !historyData.error ? historyData : null;
  const s = r.session && typeof r.session === 'object' ? sessionWithSubagents(r.session, hd, conversationId) : r.session;
  if (!s || typeof s !== 'object' || !num(s.calls)) return '';
  const total = isNum(s.total_tokens) ? s.total_tokens : num(s.input) + num(s.output);
  const meta = [];
  if (isNum(s.cache_hit_pct)) meta.push(t('hitLine', s.cache_hit_pct.toFixed(0)));
  if (s.first_at && s.last_at) meta.push(t('span', fmtTime(s.first_at, true, lang), fmtTime(s.last_at, true, lang)));
  const costStr = fmtCost(s.est_cost_usd, { estimated: !!s.cost_estimated, partial: !!s.cost_partial });
  const costTip = pricingTip(s.pricing_source, null, { partial: !!s.cost_partial }, t, lang);
  const weeklyValueUsd = (hd && hd.weekly_value_usd) || null;
  const quotaCalibration = (hd && hd.quota_calibration) || null;
  let weeklyHtml = '';
  let poolRows = '';
  if (hasAnyWeeklyValue(weeklyValueUsd)) {
    const sCtx = s.model || !(Array.isArray(s.by_model) && s.by_model[0])
      ? s
      : { ...s, model: s.by_model[0].model, display_name: s.by_model[0].display_name };
    const wTag = convWeeklyLabel(sCtx, { compact: true, weeklyValueUsd, quotaCalibration, t });
    if (wTag) {
      weeklyHtml = `<div class="session-weekly dim num" title="${esc(t('weeklySizeTip'))}">${esc(wTag)}</div>`;
    }
    const cPools = s.cost_by_pool || {};
    const activePools = sortActivePools(s, weeklyValueUsd, quotaCalibration);
    const pn = t('poolShort');
    if (activePools.length > 1) {
      poolRows = `<div class="session-pools"><ul class="mini">${activePools.map((pk) => {
        const cost = num(cPools[pk]);
        const lbl = poolRowLabel(s, pk, { weeklyValueUsd, quotaCalibration, t });
        return `<li><span class="dim">${esc(formatPoolName(pk, pn))}</span><span class="num dim">${esc(fmtUsd(cost))}${lbl ? ` · ${esc(lbl)}` : ''}</span></li>`;
      }).join('')}</ul></div>`;
    }
  }
  const models = Array.isArray(s.by_model) && s.by_model.length > 1
    ? `<ul class="mini" style="margin-top:12px">${s.by_model.map((m) => {
      const mc = fmtCost(m.est_cost_usd, { estimated: !!m.cost_estimated });
      return `<li><span class="ellipsis" title="${esc(m.model || '')}">${esc(m.display_name || m.model || '?')}</span>`
        + `<span class="num dim">${fmtTok(num(m.input) + num(m.output))}${mc ? ` · ${esc(mc)}` : ` · ${esc(t('calls', fmtInt(m.calls, lang)))}`}</span></li>`;
    }).join('')}</ul>`
    : '';
  const rightBits = [];
  if (costStr) rightBits.push(`<div class="session-cost num" title="${esc(costTip)}">${esc(costStr)}</div>`);
  if (weeklyHtml) rightBits.push(weeklyHtml);
  return `<section><h2>${esc(t('sessionTitle'))} <span class="hint">${esc(t('speedCalls', fmtInt(s.calls, lang)))}</span></h2>
    <div class="session-head">
      <div><div class="fig num" title="${esc(fmtInt(total, lang))}">${fmtTok(total)}<span class="unit">${esc(t('tokens'))}</span></div>
        <div class="lbl">${esc(t('exclCache'))}</div></div>
      ${rightBits.length ? `<div class="session-right">${rightBits.join('')}</div>` : ''}
    </div>
    <div class="stats">
      <div><div class="lbl">${esc(t('legInput'))}</div><div class="v num">${fmtTok(s.input)}</div></div>
      <div><div class="lbl">${esc(t('legOutput'))}</div><div class="v num">${fmtTok(s.output)}</div></div>
      <div><div class="lbl">${esc(t('legCache'))}</div><div class="v num">${fmtTok(s.cache_read)}</div></div>
    </div>
    ${poolRows}
    ${subagentsHtml(s, t, lang)}
    ${meta.length ? `<p class="note num">${esc(meta.join(' · '))}</p>` : ''}
    ${models}
  </section>`;
}

function subagentsHtml(s, t, lang) {
  const n = num(s.subagents);
  if (!n || !s.self) return '';
  const own = s.self;
  const ownCost = fmtCost(own.est_cost_usd, { estimated: !!own.cost_estimated });
  const subCostVal = isNum(s.est_cost_usd) ? Math.max(0, s.est_cost_usd - num(own.est_cost_usd)) : null;
  const subCost = fmtCost(subCostVal, { estimated: !!s.cost_estimated });
  const subTok = Math.max(0, newTok(s) - newTok(own));
  return `<div class="session-pools"><div class="lbl">${esc(t('usageLevels'))}</div><ul class="mini">
    <li><span class="dim">${esc(t('selfUsage'))}</span><span class="num dim">${fmtTok(newTok(own))}${ownCost ? ` · ${esc(ownCost)}` : ''}</span></li>
    <li><span class="dim">${esc(t('subagentsUsage', fmtInt(n, lang)))}</span><span class="num dim">${fmtTok(subTok)}${subCost ? ` · ${esc(subCost)}` : ''}</span></li>
  </ul></div>`;
}

export function renderOverviewHtml(r, { conversationId = '', historyData = null, openKeys, t, lang = 'en' }) {
  const limit = r.limit_tokens;
  return `
    <div class="top">
      <div class="model"><span class="live on" title="${esc(t('live'))}"></span><span class="ellipsis">${esc(r.model)}</span></div>
      <button id="copy" title="${esc(t('copyTitle'))}">${esc(t('copy'))}</button>
    </div>
    <div class="usage">
      <span class="big num">${fmtTok(r.used_tokens)}</span>
      <span class="of num">/ ${limit ? fmtTok(limit) : esc(t('unknown'))} ${esc(t('tokens'))}</span>
      ${limit ? `<span class="pct num">${num(r.used_pct).toFixed(1)}%</span>` : ''}
    </div>
    ${budgetHtml(r, t)}
    ${gridHtml(r, t)}
    ${speedHtml(r, openKeys, t, lang)}
    ${sessionHtml(r, { historyData, conversationId, t, lang })}
    ${categoriesHtml(r, t)}
    ${checkpointsHtml(r, t)}
    ${filesHtml(t('knowledgeFiles'), '/rules', r.knowledge_files, conversationId, t)}
    ${filesHtml(t('artifactFiles'), '/artifact', r.artifact_files, conversationId, t)}
    ${filesHtml(t('skillFiles'), '/skill', r.skill_files, conversationId, t)}
    ${filesHtml(t('systemFiles'), t('autoLoaded'), r.system_files, conversationId, t)}
    <footer><span>${esc(t('related'))}</span><span class="num">${esc(t('updated', fmtTime(r.updatedAt, false, lang)))}</span></footer>`;
}

export function showOverviewMessageHtml(key, args, t) {
  if (key === 'noConversation' || key === 'noDatabase') {
    const title = key === 'noConversation' ? t('noConvTitle') : t('noDbTitle');
    const hint = key === 'noConversation' ? t('noConvHint') : t('noDbHint');
    return `<div class="guide-empty">
      <h3>${esc(title)}</h3><p>${esc(hint)}</p>
      <div class="guide-acts">
        <button type="button" class="guide-btn" data-go-tab="quota">${esc(t('goQuota'))}</button>
        <button type="button" class="guide-btn" data-go-tab="history">${esc(t('goHistory'))}</button>
      </div>
    </div>`;
  }
  return `<p class="empty">${esc(t(key, ...args))}</p>`;
}

export function createOverviewController({
  pane,
  conversationId,
  getWorkspace,
  getTab,
  getHistoryLoader,
  getQuotaLoader,
  openKeys,
  getT,
  getLang,
  getJson,
  keepScroll,
  onSpinChange,
}) {
  let report = null;
  let lastJson = '';
  let overviewMessage = null;
  let overviewBusy = false;
  let overviewSpin = false;
  let lastOverviewWeeklySig = '';
  let lastOverviewHistoryTry = 0;
  let lastOverviewQuotaTry = 0;

  function overviewWeeklySig() {
    const historyLoader = getHistoryLoader();
    const hd = historyLoader && historyLoader.data && !historyLoader.data.error ? historyLoader.data : null;
    const wv = (hd && hd.weekly_value_usd) || {};
    const hc = hd && conversationId && Array.isArray(hd.by_conversation)
      ? hd.by_conversation.find((c) => c && c.id === conversationId)
      : null;
    const hcSig = hc ? `${num(hc.total && hc.total.calls)}:${num(hc.total && hc.total.est_cost_usd)}` : '';
    const valSig = `${knownQuotaPools(wv).map((k) => `${k}:${num(wv[k])}`).join(',')}|${hd && Array.isArray(hd.by_conversation) ? hd.by_conversation.length : 0}|${hcSig}`;
    const sesSig = report && report.session ? `${report.session.calls}:${num(report.session.est_cost_usd)}:${num(report.session.subagents)}` : '';
    return `${valSig}|${sesSig}`;
  }

  function ensureWeekly() {
    if (getTab() !== 'overview' || !report || !report.session || !num(report.session.calls)) return;
    const historyLoader = getHistoryLoader();
    const quotaLoader = getQuotaLoader();
    const now = Date.now();
    if (historyLoader && !historyLoader.loading) {
      const hasErr = Boolean(historyLoader.error || (historyLoader.data && historyLoader.data.error));
      const stale = !historyLoader.data || hasErr || now - historyLoader.loadedAt > HISTORY_STALE_MS;
      const cooldown = hasErr ? 60000 : 15000;
      if (stale && now - lastOverviewHistoryTry > cooldown) {
        lastOverviewHistoryTry = now;
        historyLoader.load({ refresh: false, silent: true });
      }
    }
    if (quotaLoader && !quotaLoader.loading) {
      const hasErr = Boolean(quotaLoader.error || (quotaLoader.data && quotaLoader.data.error));
      const stale = !quotaLoader.data || hasErr || now - quotaLoader.loadedAt > QUOTA_STALE_MS;
      const cooldown = hasErr ? 60000 : 15000;
      if (stale && now - lastOverviewQuotaTry > cooldown) {
        lastOverviewQuotaTry = now;
        quotaLoader.load({ refresh: false, silent: true });
      }
    }
  }

  async function copy(event) {
    if (!report) return;
    const btn = event.currentTarget;
    const t = getT();
    try {
      await navigator.clipboard.writeText(report.text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = report.text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    btn.textContent = t('copied');
    setTimeout(() => { btn.textContent = getT()('copy'); }, 1500);
  }

  function render(r) {
    lastOverviewWeeklySig = overviewWeeklySig();
    ensureWeekly();
    const historyLoader = getHistoryLoader();
    const html = renderOverviewHtml(r, {
      conversationId,
      historyData: historyLoader ? historyLoader.data : null,
      openKeys,
      t: getT(),
      lang: getLang(),
    });
    keepScroll(() => { pane.innerHTML = html; });
    const copyBtn = pane.querySelector('#copy');
    if (copyBtn) copyBtn.addEventListener('click', copy);
  }

  function showMessage(key, ...args) {
    report = null;
    lastJson = '';
    overviewMessage = [key, ...args];
    pane.innerHTML = showOverviewMessageHtml(key, args, getT());
  }

  function paint() {
    if (report) render(report);
    else if (overviewMessage) showMessage(...overviewMessage);
    else pane.innerHTML = `<p class="empty">${esc(getT()('loading'))}</p>`;
  }

  function syncWeekly() {
    if (getTab() !== 'overview' || !report || !report.session || !num(report.session.calls)) return;
    const sig = overviewWeeklySig();
    if (sig === lastOverviewWeeklySig) return;
    render(report);
  }

  async function refresh({ force = false } = {}) {
    if (!force && (document.hidden || getTab() !== 'overview')) return;
    if (overviewBusy) return;
    overviewBusy = true;
    overviewSpin = force || (!report && !overviewMessage);
    if (force) lastJson = '';
    if (overviewSpin && onSpinChange) onSpinChange();
    try {
      const data = await getJson('/api/report', { conversationId, workspace: getWorkspace() });
      if (data.error === 'no-conversation') return showMessage('noConversation');
      if (data.error === 'no-database') return showMessage('noDatabase');
      if (data.error) return showMessage('readFailed', data.message || data.error);
      const json = JSON.stringify(data);
      if (json === lastJson) return;
      lastJson = json;
      report = data;
      overviewMessage = null;
      render(data);
    } catch {
      const dot = pane.querySelector('.live');
      if (dot) dot.classList.remove('on');
    } finally {
      overviewBusy = false;
      overviewSpin = false;
      if (onSpinChange) onSpinChange();
    }
  }

  return {
    render,
    showMessage,
    paint,
    refresh,
    copy,
    isSpinning: () => overviewSpin,
    getReport: () => report,
    resetCache: () => { lastJson = ''; },
    ensureWeekly,
    syncWeekly,
  };
}
