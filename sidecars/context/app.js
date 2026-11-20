(() => {
  'use strict';

  const POLL_MS = 3000;
  const QUOTA_STALE_MS = 60 * 1000;
  const HISTORY_STALE_MS = 5 * 60 * 1000;
  const SEGMENT_COLORS = ['var(--c-system)', 'var(--c-user)', 'var(--c-agent)', 'var(--c-tool)', 'var(--c-custom)'];
  const CONVERSATION = { user: 'var(--c-user)', agent: 'var(--c-agent)', tool: 'var(--c-tool)', system_messages: 'var(--c-sysmsg)' };
  const SYSTEM = new Set(['system_prompt', 'system_tools', 'system_overhead']);
  const TABS = ['overview', 'quota', 'history'];
  const params = new URLSearchParams(location.search);
  const conversationId = (window.sidecar && window.sidecar.conversationId) || params.get('conversationId') || '';
  const doFetch = (window.sidecar && window.sidecar.fetch) || fetch;
  const $ = (id) => document.getElementById(id);
  const panes = { overview: $('overview'), quota: $('quota'), history: $('history') };

  // --- i18n -------------------------------------------------------------------

  const I18N = {
    zh: {
      'tab.overview': '概览', 'tab.quota': '额度', 'tab.history': '历史',
      loading: '加载中…', refresh: '刷新', unknown: '未知', tokens: 'tokens', live: '实时',
      copy: '复制为文本', copied: '已复制', copyTitle: '按 CLI 输出格式复制报告',
      gridTitle: '每个点代表上下文窗口的 1%',
      tokenUsage: 'Token 用量', freeSpace: '剩余空间',
      checkpointBuffer: (n) => `检查点缓冲：${n} tokens（不计入用量）`,
      checkpoints: '检查点', checkpointN: (n) => `检查点 ${n}`, inContext: '在上下文中',
      olderCheckpoints: (n) => `${n} 个较早检查点已摘要，不在上下文中`,
      knowledgeFiles: '知识文件', artifactFiles: '产物文件', skillFiles: '技能文件', systemFiles: '系统文件', autoLoaded: '自动加载',
      conversationFolder: '对话目录',
      related: '相关：/artifact · /skill · /rewind', updated: (t) => `更新于 ${t}`,
      budget: (b, p) => `请求预算 ${b} · 已用 ${p}%`, budgetHint: '超出请求预算后，应用会裁剪较早的历史，即使原生窗口更大',
      budgetOver: '已超出请求预算，较早历史会被裁剪',
      headings: {
        'Token usage by category': '按类别的 Token 用量',
        'Estimated after compaction · updates next turn': '压缩后估算 · 下一轮更新',
        'Estimated usage (awaiting generation)': '估算用量（等待生成）',
      },
      categories: {
        user: '用户消息', agent: '智能体回复', tool: '工具调用', system_prompt: '系统提示词', system_tools: '系统工具',
        system_overhead: '系统开销', rules: '规则', skills: '技能', subagents: '子智能体', legacy_workflows: '旧版工作流',
        workflows: '工作流', plugins: '插件', mcp_tools: 'MCP 工具', system_messages: '系统消息',
      },
      noConversation: '打开一个对话以查看其上下文用量。',
      noDatabase: '该对话还没有保存的数据，请先发送一条消息。',
      readFailed: (m) => `无法读取该对话：${m}`,
      speedTitle: '输出速度', speedWaiting: '等待模型完成一次回复后显示生成速度', speedCalls: (n) => `最近 ${n} 次调用`,
      streamSpeed: '流式速度', e2eSpeed: '端到端速度', ttft: '首字延迟 TTFT', avg: (v) => `均值 ${v}`,
      totalTime: (v) => `总耗时 ${v}`, cacheHit: (p) => `缓存命中 ${p}%`,
      thisOutput: (n) => `本次输出 ${n} tok`, thinkingNote: (a, b) => `（思考 ${a} · 回复 ${b}）`, streamNote: (v) => ` · 流式 ${v}`,
      speedTip: (s, e, t, o) => `流式 ${s} tok/s · 端到端 ${e} tok/s · TTFT ${t} · 输出 ${o} tok`,
      quotaTitle: '模型额度', plan: (p) => `套餐：${p}`, fetchedAt: (t) => `获取于 ${t}`,
      remaining: '剩余', resetIn: (d) => `${d} 后重置`, resetAt: (t) => `重置时间 ${t}`, resetPassed: '已到重置时间 · 点击刷新',
      noReset: '无重置时间', noPools: '没有可显示的额度信息。',
      quotaUnavailable: '额度信息暂不可用', quotaUnavailableHint: '语言服务器未提供额度数据，可稍后刷新重试。',
      quotaFailed: '获取额度失败', requestFailed: '请求失败',
      dur: { d: '天', h: '小时', m: '分', s: '秒' },
      historyTitle: '历史用量', scanning: '正在扫描所有对话，可能需要几秒…',
      historyFailed: '扫描历史失败',
      periods: { today: '今天', d7: '近 7 天', d30: '近 30 天', all: '全部' },
      calls: (n) => `${n} 次调用`, convs: (n) => `${n} 个对话`,
      io: (i, o, c) => `输入 ${i} · 输出 ${o} · 缓存 ${c}`,
      refPrice: '参考价', refNote: '费用按公开单价估算，仅供参考，不代表实际账单。', refPartial: '部分模型没有公开单价，未计入费用（≥ 表示下限）。', pricedOnly: '参考价 · 仅含有参考价的模型', noRefPrice: '无参考价',
      byModel: '按模型', noModels: '暂无模型用量。',
      legInput: '输入', legCache: '缓存读取', legOutput: '输出',
      activity: '活跃度', activeDays: (a, n) => `近 ${n} 天中活跃 ${a} 天`,
      dayTip: (d, t, c) => `${d} · ${t} tok · ${c} 次调用`, less: '少', more: '多',
      sources: (d, c) => `桌面 ${d} · CLI ${c} 个对话`, errors: (n) => `${n} 个无法读取`,
      scannedAt: (t, ms) => `扫描于 ${t}${ms != null ? `（${ms} ms）` : ''}`,
      weekdays: ['日', '一', '二', '三', '四', '五', '六'],
    },
    en: {
      'tab.overview': 'Overview', 'tab.quota': 'Quota', 'tab.history': 'History',
      loading: 'Loading…', refresh: 'Refresh', unknown: 'Unknown', tokens: 'tokens', live: 'Live',
      copy: 'Copy as text', copied: 'Copied', copyTitle: 'Copy the report as the CLI prints it',
      gridTitle: 'Each dot is 1% of the context window',
      tokenUsage: 'Token usage', freeSpace: 'Free space',
      checkpointBuffer: (n) => `Checkpoint buffer: ${n} tokens (not counted in usage)`,
      checkpoints: 'Checkpoints', checkpointN: (n) => `Checkpoint ${n}`, inContext: 'in context',
      olderCheckpoints: (n) => `${n} older checkpoint(s) summarized, not in context`,
      knowledgeFiles: 'Knowledge files', artifactFiles: 'Artifact files', skillFiles: 'Skill files', systemFiles: 'System files', autoLoaded: 'auto-loaded',
      conversationFolder: 'conversation folder',
      related: 'Related: /artifact · /skill · /rewind', updated: (t) => `Updated ${t}`,
      budget: (b, p) => `Request budget ${b} · ${p}% used`, budgetHint: 'Past the request budget the app trims older history, even though the native window is larger',
      budgetOver: 'Over the request budget; older history is being trimmed',
      headings: {},
      categories: {},
      noConversation: 'Open a conversation to see its context usage.',
      noDatabase: 'This conversation has no saved data yet. Send a message first.',
      readFailed: (m) => `Couldn't read this conversation: ${m}`,
      speedTitle: 'Output Speed', speedWaiting: 'Generation speed appears after the model finishes a reply', speedCalls: (n) => `last ${n} calls`,
      streamSpeed: 'Streaming', e2eSpeed: 'End-to-end', ttft: 'Time to first token', avg: (v) => `avg ${v}`,
      totalTime: (v) => `total ${v}`, cacheHit: (p) => `cache hit ${p}%`,
      thisOutput: (n) => `This reply: ${n} tok`, thinkingNote: (a, b) => ` (thinking ${a} · response ${b})`, streamNote: (v) => ` · streaming ${v}`,
      speedTip: (s, e, t, o) => `streaming ${s} tok/s · end-to-end ${e} tok/s · TTFT ${t} · output ${o} tok`,
      quotaTitle: 'Model quota', plan: (p) => `Plan: ${p}`, fetchedAt: (t) => `Fetched ${t}`,
      remaining: 'left', resetIn: (d) => `Resets in ${d}`, resetAt: (t) => `Resets at ${t}`, resetPassed: 'Reset time reached · refresh',
      noReset: 'No reset time', noPools: 'No quota information to show.',
      quotaUnavailable: 'Quota unavailable', quotaUnavailableHint: 'The language server did not provide quota data. Try refreshing later.',
      quotaFailed: 'Could not load quota', requestFailed: 'Request failed',
      dur: { d: 'd', h: 'h', m: 'm', s: 's' },
      historyTitle: 'Usage history', scanning: 'Scanning all conversations, this can take a few seconds…',
      historyFailed: 'History scan failed',
      periods: { today: 'Today', d7: 'Last 7 days', d30: 'Last 30 days', all: 'All time' },
      calls: (n) => `${n} calls`, convs: (n) => `${n} conversations`,
      io: (i, o, c) => `in ${i} · out ${o} · cache ${c}`,
      refPrice: 'reference', refNote: 'Costs are estimated from public list prices, for reference only, not your actual bill.', refPartial: 'Some models have no public price and are not counted (≥ marks a lower bound).', pricedOnly: 'reference · priced models only', noRefPrice: 'no reference price',
      byModel: 'By model', noModels: 'No model usage yet.',
      legInput: 'Input', legCache: 'Cache read', legOutput: 'Output',
      activity: 'Activity', activeDays: (a, n) => `Active ${a} of the last ${n} days`,
      dayTip: (d, t, c) => `${d} · ${t} tok · ${c} calls`, less: 'Less', more: 'More',
      sources: (d, c) => `Desktop ${d} · CLI ${c} conversations`, errors: (n) => `${n} unreadable`,
      scannedAt: (t, ms) => `Scanned ${t}${ms != null ? ` (${ms} ms)` : ''}`,
      weekdays: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    },
  };

  const store = {
    get(k, d) { try { return localStorage.getItem(k) || d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
  };
  let lang = store.get('ctx.lang', 'zh') === 'en' ? 'en' : 'zh';
  let tab = TABS.includes(store.get('ctx.tab', 'overview')) ? store.get('ctx.tab', 'overview') : 'overview';

  function t(key, ...args) {
    const v = I18N[lang][key] !== undefined ? I18N[lang][key] : I18N.en[key];
    return typeof v === 'function' ? v(...args) : v;
  }
  const locale = () => (lang === 'zh' ? 'zh-CN' : 'en');

  // --- formatting -------------------------------------------------------------

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

  function fmtTok(n) {
    n = num(n);
    if (n >= 1e9) { const v = n / 1e9; return Number.isInteger(v) ? `${v}B` : `${v.toFixed(1)}B`; }
    if (n >= 1e6) { const v = n / 1e6; return Number.isInteger(v) ? `${v}M` : `${v.toFixed(1)}M`; }
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
    return String(n);
  }
  const fmtInt = (n) => num(n).toLocaleString(locale());
  function fmtCost(v) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
    if (v > 0 && v < 0.01) return '<$0.01';
    return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  function fmtTime(iso, withDate) {
    const d = new Date(iso);
    if (!iso || Number.isNaN(d.getTime())) return '—';
    const opts = { hour: '2-digit', minute: '2-digit' };
    if (withDate) Object.assign(opts, { month: 'short', day: 'numeric' });
    return d.toLocaleString(locale(), opts);
  }
  function fmtDuration(ms) {
    const u = t('dur');
    const s = Math.max(0, Math.floor(ms / 1000));
    const d = Math.floor(s / 86400); const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60); const sec = s % 60;
    const sp = lang === 'zh' ? '' : ' ';
    if (d) return `${d}${u.d}${sp}${h}${u.h}`;
    if (h) return `${h}${u.h}${sp}${m}${u.m}`;
    if (m) return `${m}${u.m}${sp}${sec}${u.s}`;
    return `${sec}${u.s}`;
  }
  const errorBox = (title, msg) => `<div class="error" role="alert"><b>${esc(title)}</b>${msg ? esc(msg) : ''}</div>`;

  async function getJson(path, query) {
    const qs = new URLSearchParams(query || {}).toString();
    const res = await doFetch(qs ? `${path}?${qs}` : path);
    return res.json();
  }

  // --- overview ---------------------------------------------------------------

  let workspace = '';
  let report = null;
  let lastJson = '';
  let overviewMessage = null; // [key, ...args] while showing a message instead of a report

  // The CLI's cell allocation: at least one cell per non-empty segment, scaled down on overflow.
  function gridCells(segments, limit, total) {
    let counts = segments.map((n) => (!n || !limit ? 0 : Math.max(1, Math.floor(n / limit * total))));
    const used = counts.reduce((a, b) => a + b, 0);
    if (used > total) counts = counts.map((c) => Math.floor(c * total / used));
    return [...counts, total - counts.reduce((a, b) => a + b, 0)];
  }

  function grid(r) {
    const counts = gridCells(r.grid_segments || [], r.limit_tokens, 100);
    let dots = '';
    counts.forEach((n, i) => {
      dots += (i === 5 ? '<span class="dot"></span>' : `<span class="dot" style="background:${SEGMENT_COLORS[i]}"></span>`).repeat(n);
    });
    return `<div class="grid" title="${esc(t('gridTitle'))}">${dots}</div>`;
  }

  function budget(r) {
    const b = r.request_budget_tokens;
    const limit = r.limit_tokens;
    if (!b || b <= 0 || !limit || b === limit) return '';
    const pct = (num(r.used_tokens) / b * 100).toFixed(1);
    const over = r.used_tokens > b;
    return `<p class="budget num${over ? ' over' : ''}" title="${esc(over ? t('budgetOver') : t('budgetHint'))}">${esc(t('budget', fmtTok(b), pct))}</p>`;
  }

  function categoryName(c) {
    return t('categories')[c.key] || c.name;
  }

  function categoryRow(c) {
    const color = CONVERSATION[c.key] || (SYSTEM.has(c.key) ? 'var(--c-system)' : 'var(--c-custom)');
    const shape = CONVERSATION[c.key] ? '' : ' sq';
    return `<div class="row"><span class="mark${shape}" style="background:${color}"></span><span>${esc(categoryName(c))}</span>`
      + `<span class="tok num">${fmtTok(c.tokens)}</span><span class="p num">${num(c.pct).toFixed(1)}%</span></div>`;
  }

  function categories(r) {
    const cats = r.categories || [];
    const conv = cats.filter((c) => CONVERSATION[c.key]);
    const rest = cats.filter((c) => !CONVERSATION[c.key]);
    const limit = r.limit_tokens;
    const freePct = limit ? (r.free_tokens / limit * 100).toFixed(1) : '0.0';
    const free = `<div class="row"><span class="mark free"></span><span class="dim">${esc(t('freeSpace'))}</span>`
      + `<span class="tok num">${fmtTok(r.free_tokens)}</span><span class="p num">${freePct}%</span></div>`;
    const note = r.heading === 'Token usage by category' ? '' : `<p class="note">${esc(t('headings')[r.heading] || r.heading)}</p>`;
    const buffer = r.checkpoint_buffer ? `<p class="note">${esc(t('checkpointBuffer', fmtTok(r.checkpoint_buffer)))}</p>` : '';
    return `<section><h2>${esc(t('tokenUsage'))}</h2>${note}
      <div class="group">${conv.map(categoryRow).join('')}</div>
      ${rest.length ? `<div class="group">${rest.map(categoryRow).join('')}</div>` : ''}
      <div class="group">${free}</div>${buffer}</section>`;
  }

  function checkpoints(r) {
    const ck = r.checkpoint_view;
    if (!ck) return '';
    const older = ck.historical ? `<div class="dim" style="font-size:12px">${esc(t('olderCheckpoints', ck.historical))}</div>` : '';
    return `<section><h2>${esc(t('checkpoints'))} <span class="hint">${esc(ck.count)} · /rewind</span></h2>
      <div class="ck-main"><span>${esc(t('checkpointN', ck.active_number))}: ${esc(ck.active_text)}</span><span class="badge">${esc(t('inContext'))}</span></div>${older}</section>`;
  }

  function splitPath(path) {
    const trimmed = path.replace(/\/$/, '');
    const i = trimmed.lastIndexOf('/');
    const name = trimmed.slice(i + 1) + (path.endsWith('/') ? '/' : '');
    let dir = i > 0 ? trimmed.slice(0, i) : '';
    if (conversationId) dir = dir.replace(new RegExp(`^.*/brain/${conversationId}`), t('conversationFolder'));
    return { name, dir };
  }

  function files(title, hint, items) {
    if (!items || !items.length) return '';
    const rows = items.map((f) => {
      const { name, dir } = splitPath(f.path);
      return `<li title="${esc(f.path)}"><span class="name">${esc(name)}<span class="dir">&lrm;${esc(dir)}</span></span>`
        + `<span class="tok num">${f.tokens > 0 ? fmtTok(f.tokens) : ''}</span></li>`;
    }).join('');
    return `<section><h2>${esc(title)} <span class="hint">${esc(hint)}</span></h2><ul class="files">${rows}</ul></section>`;
  }

  function speed(r) {
    const s = r.speed;
    if (!s || !s.latest) {
      return `<section><h2>${esc(t('speedTitle'))}</h2><p class="note">${esc(t('speedWaiting'))}</p></section>`;
    }
    const l = s.latest;
    const fmtTps = (v) => (typeof v === 'number' ? v.toFixed(1) : '—');
    const fmtSec = (v) => (typeof v === 'number' ? `${v.toFixed(2)}s` : '—');
    const ttftSub = typeof l.cache_hit_pct === 'number' ? t('cacheHit', l.cache_hit_pct.toFixed(0)) : t('avg', fmtSec(s.avg_ttft_sec));
    const thinkingNote = l.thinking_tokens > 0 ? t('thinkingNote', fmtTok(l.thinking_tokens), fmtTok(l.response_tokens)) : '';
    const streamNote = l.streaming_sec != null ? t('streamNote', fmtSec(l.streaming_sec)) : '';
    let bars = '';
    if (Array.isArray(s.recent) && s.recent.length > 1) {
      const vals = s.recent.map((x) => (x.streaming_tps != null ? x.streaming_tps : (x.e2e_tps || 0)));
      const maxVal = Math.max(1, ...vals);
      bars = `<div class="speed-bars">${s.recent.map((x, i) => {
        const h = Math.max(15, Math.round((vals[i] / maxVal) * 100));
        const tip = t('speedTip', fmtTps(x.streaming_tps), fmtTps(x.e2e_tps), fmtSec(x.ttft_sec), fmtTok(x.output_tokens));
        return `<span class="speed-bar" style="height:${h}%" title="${esc(tip)}"></span>`;
      }).join('')}</div>`;
    }
    return `<section><h2>${esc(t('speedTitle'))} <span class="hint">${esc(t('speedCalls', s.calls))}</span></h2>
      <div class="speed-grid">
        <div class="speed-card"><div class="k">${esc(t('streamSpeed'))}</div><div class="v num">${fmtTps(l.streaming_tps)} <span class="unit">tok/s</span></div><div class="sub num">${esc(t('avg', `${fmtTps(s.avg_streaming_tps)} tok/s`))}</div></div>
        <div class="speed-card"><div class="k">${esc(t('e2eSpeed'))}</div><div class="v num">${fmtTps(l.e2e_tps)} <span class="unit">tok/s</span></div><div class="sub num">${esc(t('totalTime', fmtSec(l.total_sec)))}</div></div>
        <div class="speed-card"><div class="k" title="${esc(t('ttft'))}">${esc(t('ttft'))}</div><div class="v num">${fmtSec(l.ttft_sec)}</div><div class="sub num">${esc(ttftSub)}</div></div>
      </div>
      <div class="note num" style="margin:0">${esc(t('thisOutput', fmtTok(l.output_tokens)) + thinkingNote + streamNote)}</div>
      ${bars}
    </section>`;
  }

  function renderOverview(r) {
    const limit = r.limit_tokens;
    const updated = fmtTime(r.updatedAt);
    panes.overview.innerHTML = `
      <div class="top">
        <div class="model"><span class="live on" title="${esc(t('live'))}"></span>${esc(r.model)}</div>
        <button id="copy" title="${esc(t('copyTitle'))}">${esc(t('copy'))}</button>
      </div>
      <div class="usage">
        <span class="big num">${fmtTok(r.used_tokens)}</span>
        <span class="of">/ ${limit ? fmtTok(limit) : esc(t('unknown'))} ${esc(t('tokens'))}</span>
        ${limit ? `<span class="pct num">${num(r.used_pct).toFixed(1)}%</span>` : ''}
      </div>
      ${budget(r)}
      ${grid(r)}
      ${speed(r)}
      ${categories(r)}
      ${checkpoints(r)}
      ${files(t('knowledgeFiles'), '/rules', r.knowledge_files)}
      ${files(t('artifactFiles'), '/artifact', r.artifact_files)}
      ${files(t('skillFiles'), '/skill', r.skill_files)}
      ${files(t('systemFiles'), t('autoLoaded'), r.system_files)}
      <footer><span>${esc(t('related'))}</span><span>${esc(t('updated', updated))}</span></footer>`;
    $('copy').addEventListener('click', copy);
  }

  function showMessage(key, ...args) {
    report = null;
    lastJson = '';
    overviewMessage = [key, ...args];
    panes.overview.innerHTML = `<p class="empty">${esc(t(key, ...args))}</p>`;
  }

  function paintOverview() {
    if (report) renderOverview(report);
    else if (overviewMessage) showMessage(...overviewMessage);
    else panes.overview.innerHTML = `<p class="empty">${esc(t('loading'))}</p>`;
  }

  async function copy(event) {
    if (!report) return;
    const btn = event.currentTarget;
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
    setTimeout(() => { btn.textContent = t('copy'); }, 1500);
  }

  async function refreshReport() {
    if (document.hidden || tab !== 'overview') return;
    try {
      const data = await getJson('/api/report', { conversationId, workspace });
      if (data.error === 'no-conversation') return showMessage('noConversation');
      if (data.error === 'no-database') return showMessage('noDatabase');
      if (data.error) return showMessage('readFailed', data.message || data.error);
      const json = JSON.stringify(data);
      if (json === lastJson) return;
      lastJson = json;
      report = data;
      overviewMessage = null;
      renderOverview(data);
    } catch {
      const dot = panes.overview.querySelector('.live');
      if (dot) dot.classList.remove('on');
    }
  }

  // --- shared loader for quota / history -------------------------------------

  function makeLoader(path, staleMs, paint) {
    const st = { data: null, loading: false, error: null, loadedAt: 0, seq: 0 };
    st.load = async (refresh) => {
      if (st.loading) return;
      st.loading = true;
      st.error = null;
      const seq = ++st.seq;
      paint();
      try {
        const data = await getJson(path, refresh ? { refresh: 'true' } : null);
        if (seq !== st.seq) return;
        if (!data || typeof data !== 'object') throw new Error('invalid response');
        st.data = data;
        st.loadedAt = Date.now();
      } catch (err) {
        if (seq !== st.seq) return;
        st.error = (err && err.message) || String(err);
      } finally {
        if (seq === st.seq) { st.loading = false; paint(); }
      }
    };
    st.open = () => {
      if (!st.loading && (!st.data || Date.now() - st.loadedAt > staleMs)) st.load(false);
      else paint();
    };
    return st;
  }

  function toolbar(id, title, meta, loading) {
    return `<div class="toolbar"><h2 style="margin:0">${esc(title)}</h2>
      <button data-refresh="${id}" ${loading ? 'disabled' : ''}>${loading ? '<span class="spin"></span>' : ''}${esc(t('refresh'))}</button></div>
      ${meta ? `<div class="toolbar"><span class="meta">${meta}</span></div>` : ''}`;
  }

  // --- quota ------------------------------------------------------------------

  const quota = makeLoader('/api/quota', QUOTA_STALE_MS, () => paintQuota());

  function resetText(iso) {
    if (!iso) return t('noReset');
    const at = new Date(iso).getTime();
    if (Number.isNaN(at)) return t('noReset');
    const left = at - Date.now();
    return left <= 0 ? t('resetPassed') : t('resetIn', fmtDuration(left));
  }

  function poolHtml(p) {
    const f = typeof p.remaining_fraction === 'number' && Number.isFinite(p.remaining_fraction)
      ? Math.min(1, Math.max(0, p.remaining_fraction)) : null;
    const level = f == null ? 'unknown' : f < 0.05 ? 'crit' : f < 0.2 ? 'warn' : '';
    const pct = f == null ? '—' : `${(f * 100).toFixed(f < 0.1 && f > 0 ? 1 : 0)}%`;
    const models = Array.isArray(p.models) ? p.models : [];
    const chips = models.map((m) => `<span class="chip" title="${esc(m.id || '')}">${esc(m.display_name || m.id || '?')}</span>`).join('');
    const resetTitle = p.reset_time ? t('resetAt', fmtTime(p.reset_time, true)) : '';
    return `<div class="pool ${level}">
      <div class="pool-head"><span class="pool-label" title="${esc(p.id || '')}">${esc(p.label || p.id || '?')}</span>
        <span><span class="pool-pct num">${pct}</span> <span class="dim" style="font-size:11px">${esc(t('remaining'))}</span></span></div>
      <div class="meter" role="progressbar" aria-valuemin="0" aria-valuemax="100" ${f != null ? `aria-valuenow="${Math.round(f * 100)}"` : ''}><span style="width:${f == null ? 0 : (f * 100).toFixed(1)}%"></span></div>
      <div class="pool-reset num" data-reset="${esc(p.reset_time || '')}" title="${esc(resetTitle)}">${esc(resetText(p.reset_time))}</div>
      ${chips ? `<div class="chips">${chips}</div>` : ''}
    </div>`;
  }

  function paintQuota() {
    const { data, loading, error } = quota;
    let meta = '';
    let body = '';
    if (error) {
      body = errorBox(t('requestFailed'), error);
    } else if (!data) {
      body = `<p class="empty"><span class="spin"></span>${esc(t('loading'))}</p>`;
    } else if (data.error) {
      body = data.error === 'unavailable'
        ? errorBox(t('quotaUnavailable'), data.message || t('quotaUnavailableHint'))
        : errorBox(t('quotaFailed'), data.message || data.error);
    }
    if (data && !data.error) {
      const bits = [];
      if (data.plan) bits.push(esc(t('plan', data.plan)));
      if (data.fetched_at) bits.push(esc(t('fetchedAt', fmtTime(data.fetched_at))));
      meta = bits.join(' · ');
      const pools = Array.isArray(data.pools) ? data.pools : [];
      if (!error) body = pools.length ? pools.map(poolHtml).join('') : `<p class="empty">${esc(t('noPools'))}</p>`;
    }
    panes.quota.innerHTML = toolbar('quota', t('quotaTitle'), meta, loading) + body;
  }

  function tickCountdowns() {
    if (tab !== 'quota' || document.hidden) return;
    panes.quota.querySelectorAll('[data-reset]').forEach((el) => {
      const iso = el.getAttribute('data-reset');
      if (iso) el.textContent = resetText(iso);
    });
  }

  // --- history ----------------------------------------------------------------

  const history = makeLoader('/api/history', HISTORY_STALE_MS, () => paintHistory());
  const totalTok = (x) => num(x && x.input) + num(x && x.output) + num(x && x.cache_read);

  function periodCard(key, p, partial) {
    p = p || {};
    return `<div class="period">
      <div class="k">${esc(t('periods')[key])}</div>
      <div class="v num" title="${esc(fmtInt(totalTok(p)))} tokens">${fmtTok(totalTok(p))}</div>
      <div class="sub num">${esc(t('calls', fmtInt(p.calls)))} · ${esc(t('convs', fmtInt(p.conversations)))}</div>
      <div class="sub num" title="${esc(t('io', fmtInt(p.input), fmtInt(p.output), fmtInt(p.cache_read)))}">${esc(t('io', fmtTok(p.input), fmtTok(p.output), fmtTok(p.cache_read)))}</div>
      ${costLine(p, partial)}
    </div>`;
  }

  // Window costs only sum calls whose model has a reference price, so they are partial
  // whenever any model with calls is unpriced.
  function costLine(p, partial) {
    const priced = typeof p.est_cost_usd === 'number' && Number.isFinite(p.est_cost_usd);
    let value; let tip; let label;
    if (!priced) {
      value = '—';
      label = num(p.calls) > 0 ? t('noRefPrice') : t('refPrice');
      tip = num(p.calls) > 0 ? t('noRefPrice') : t('refNote');
    } else if (partial) {
      value = `≥${fmtCost(p.est_cost_usd)}`;
      label = t('pricedOnly');
      tip = `${t('refNote')} ${t('refPartial')}`;
    } else {
      value = fmtCost(p.est_cost_usd);
      label = t('refPrice');
      tip = t('refNote');
    }
    return `<div class="cost num" title="${esc(tip)}">${esc(value)} <span class="dim">${esc(label)}</span></div>`;
  }

  function byModel(list) {
    if (!Array.isArray(list) || !list.length) return `<p class="note">${esc(t('noModels'))}</p>`;
    const max = Math.max(1, ...list.map(totalTok));
    const seg = (v, color) => (v > 0 ? `<span style="width:${(v / max * 100).toFixed(2)}%;background:${color}"></span>` : '');
    const legend = `<div class="mlegend"><span><i style="background:var(--c-user)"></i>${esc(t('legInput'))}</span>`
      + `<span><i style="background:var(--c-system)"></i>${esc(t('legCache'))}</span>`
      + `<span><i style="background:var(--c-agent)"></i>${esc(t('legOutput'))}</span></div>`;
    const rows = list.slice(0, 12).map((m) => {
      const tip = `${m.model}\n${t('io', fmtInt(m.input), fmtInt(m.output), fmtInt(m.cache_read))}\n${t('calls', fmtInt(m.calls))} · ${fmtCost(m.est_cost_usd)} ${t('refPrice')}`;
      return `<div class="mrow" title="${esc(tip)}">
        <div class="mrow-head"><span class="name">${esc(m.display_name || m.model || '?')}</span>
          <span class="num dim">${fmtTok(totalTok(m))} · ${esc(fmtCost(m.est_cost_usd))}</span></div>
        <div class="mbar">${seg(num(m.input), 'var(--c-user)')}${seg(num(m.cache_read), 'var(--c-system)')}${seg(num(m.output), 'var(--c-agent)')}</div>
      </div>`;
    }).join('');
    return legend + rows;
  }

  function heatmap(daily) {
    if (!Array.isArray(daily) || !daily.length) return '';
    const parse = (s) => { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, (m || 1) - 1, d || 1); };
    const nonzero = daily.map((d) => num(d.tokens)).filter((v) => v > 0).sort((a, b) => a - b);
    const q = (p) => nonzero[Math.min(nonzero.length - 1, Math.floor(p * nonzero.length))];
    const cuts = nonzero.length ? [q(0.25), q(0.5), q(0.75)] : [];
    const level = (v) => (v <= 0 ? 0 : v <= cuts[0] ? 1 : v <= cuts[1] ? 2 : v <= cuts[2] ? 3 : 4);
    const first = parse(daily[0].date);
    let cells = '<span class="cell pad"></span>'.repeat(Number.isNaN(first.getTime()) ? 0 : first.getDay());
    for (const d of daily) {
      const wd = t('weekdays')[parse(d.date).getDay()] || '';
      const tip = t('dayTip', `${d.date} ${wd}`, fmtInt(d.tokens), fmtInt(d.calls));
      cells += `<span class="cell l${level(num(d.tokens))}" title="${esc(tip)}"></span>`;
    }
    const active = daily.filter((d) => num(d.tokens) > 0 || num(d.calls) > 0).length;
    const legend = `<div class="heat-legend"><span class="t">${esc(t('less'))}</span>${[0, 1, 2, 3, 4].map((l) => `<span class="cell l${l}"></span>`).join('')}<span class="t">${esc(t('more'))}</span></div>`;
    return `<section><h2>${esc(t('activity'))} <span class="hint">${esc(t('activeDays', active, daily.length))}</span></h2>
      <div class="heat-wrap"><div class="heat">${cells}</div></div>${legend}</section>`;
  }

  function paintHistory() {
    const { data, loading, error } = history;
    let body = '';
    let meta = '';
    if (error) body = errorBox(t('requestFailed'), error);
    else if (!data) body = `<p class="empty"><span class="spin"></span>${esc(t('scanning'))}</p>`;
    else if (data.error) body = errorBox(t('historyFailed'), data.message || data.error);
    if (data && !data.error) {
      if (loading) meta = `<span class="spin"></span>${esc(t('scanning'))}`;
      else if (data.scanned_at) meta = esc(t('scannedAt', fmtTime(data.scanned_at, true), data.elapsed_ms));
      if (!error) {
        const tot = data.totals || {};
        const src = data.sources || {};
        const partial = Array.isArray(data.by_model) && data.by_model.some((m) => num(m.calls) > 0 && typeof m.est_cost_usd !== 'number');
        const foot = [t('sources', fmtInt(src.desktop), fmtInt(src.cli))];
        if (num(data.errors) > 0) foot.push(t('errors', fmtInt(data.errors)));
        body = `<div class="periods">${['today', 'd7', 'd30', 'all'].map((k) => periodCard(k, tot[k], partial)).join('')}</div>
          <p class="note" style="margin:8px 0 0">${esc(t('refNote'))}${partial ? ` ${esc(t('refPartial'))}` : ''}</p>
          <section><h2>${esc(t('byModel'))}</h2>${byModel(data.by_model)}</section>
          ${heatmap(data.daily)}
          <footer><span>${esc(foot.join(' · '))}</span></footer>`;
      }
    }
    panes.history.innerHTML = toolbar('history', t('historyTitle'), meta, loading) + body;
  }

  // --- tabs, language, lifecycle ---------------------------------------------

  function applyStatic() {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.getAttribute('data-i18n')); });
    $('lang').textContent = lang === 'zh' ? 'EN' : '中';
  }

  function setTab(next) {
    tab = TABS.includes(next) ? next : 'overview';
    store.set('ctx.tab', tab);
    document.querySelectorAll('.tab').forEach((b) => {
      const on = b.dataset.tab === tab;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    });
    TABS.forEach((k) => { panes[k].hidden = k !== tab; });
    if (tab === 'overview') refreshReport();
    else if (tab === 'quota') quota.open();
    else history.open();
  }

  function setLang(next) {
    lang = next === 'en' ? 'en' : 'zh';
    store.set('ctx.lang', lang);
    applyStatic();
    paintOverview();
    if (quota.data || quota.loading || quota.error) paintQuota();
    if (history.data || history.loading || history.error) paintHistory();
  }

  document.querySelector('.tabs').addEventListener('click', (e) => {
    const b = e.target.closest('.tab');
    if (b) setTab(b.dataset.tab);
  });
  document.querySelector('.tabs').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const i = TABS.indexOf(tab) + (e.key === 'ArrowRight' ? 1 : -1);
    setTab(TABS[(i + TABS.length) % TABS.length]);
    const btn = document.querySelector(`.tab[data-tab="${tab}"]`);
    if (btn) btn.focus();
  });
  $('lang').addEventListener('click', () => setLang(lang === 'zh' ? 'en' : 'zh'));
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-refresh]');
    if (!b) return;
    if (b.dataset.refresh === 'quota') quota.load(true);
    else if (b.dataset.refresh === 'history') history.load(true);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (tab === 'overview') refreshReport();
    else tickCountdowns();
  });

  async function start() {
    applyStatic();
    if (window.sidecar && window.sidecar.getWorkspaceUris) {
      try {
        const uris = await window.sidecar.getWorkspaceUris();
        workspace = (uris && uris[0]) || '';
      } catch { /* no workspace */ }
      if (window.sidecar.onWorkspaceChange) {
        window.sidecar.onWorkspaceChange((next) => {
          const w = (next && next[0]) || '';
          if (w !== workspace) { workspace = w; lastJson = ''; refreshReport(); }
        });
      }
    }
    setTab(tab);
    setInterval(refreshReport, POLL_MS);
    setInterval(tickCountdowns, 1000);
  }
  start();
})();
