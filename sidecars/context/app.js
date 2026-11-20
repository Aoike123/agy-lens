(() => {
  'use strict';

  const POLL_MS = 3000;
  const QUOTA_STALE_MS = 60 * 1000;
  const HISTORY_STALE_MS = 5 * 60 * 1000;
  const SEGMENT_COLORS = ['var(--c-system)', 'var(--c-user)', 'var(--c-agent)', 'var(--c-tool)', 'var(--c-custom)'];
  const CONVERSATION = { user: 'var(--c-user)', agent: 'var(--c-agent)', tool: 'var(--c-tool)', system_messages: 'var(--c-sysmsg)' };
  const SYSTEM = new Set(['system_prompt', 'system_tools', 'system_overhead']);
  const TABS = ['overview', 'quota', 'history'];
  const PERIODS = ['today', 'd7', 'd30', 'all'];
  const HEAT_MIN_WEEKS = 12;
  const HEAT_MAX_WEEKS = 26;
  const CONV_VISIBLE = 12;
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
      copy: '复制文本', copied: '已复制', copyTitle: '按 CLI 输出格式复制报告',
      gridTitle: '每个点代表上下文窗口的 1%',
      tokenUsage: 'Token 用量', freeSpace: '剩余空间',
      checkpointBuffer: (n) => `检查点缓冲 ${n} tokens，不计入用量`,
      checkpoints: '检查点', checkpointN: (n) => `检查点 ${n}`, inContext: '在上下文中',
      olderCheckpoints: (n) => `${n} 个较早检查点已摘要，不在上下文中`,
      knowledgeFiles: '知识文件', artifactFiles: '产物文件', skillFiles: '技能文件', systemFiles: '系统文件', autoLoaded: '自动加载',
      conversationFolder: '对话目录',
      related: '相关命令 /artifact · /skill · /rewind', updated: (t) => `更新于 ${t}`,
      budget: (b, p) => `请求预算 ${b}，已用 ${p}%`, budgetHint: '超出请求预算后，应用会裁剪较早的历史，即使原生窗口更大',
      budgetOver: '已超出请求预算，较早的历史会被裁剪',
      headings: {
        'Token usage by category': '按类别的 Token 用量',
        'Estimated after compaction · updates next turn': '压缩后的估算值，下一轮更新',
        'Estimated usage (awaiting generation)': '估算用量，等待生成',
      },
      categories: {
        user: '用户消息', agent: '智能体回复', tool: '工具调用', system_prompt: '系统提示词', system_tools: '系统工具',
        system_overhead: '系统开销', rules: '规则', skills: '技能', subagents: '子智能体', legacy_workflows: '旧版工作流',
        workflows: '工作流', plugins: '插件', mcp_tools: 'MCP 工具', system_messages: '系统消息',
      },
      noConversation: '打开一个对话以查看上下文用量',
      noDatabase: '这个对话还没有保存的数据，先发送一条消息',
      readFailed: (m) => `无法读取这个对话：${m}`,
      speedTitle: '输出速度', speedWaiting: '模型完成一次回复后显示生成速度', speedCalls: (n) => `${n} 次调用`,
      streaming: '流式速度', e2e: '端到端', ttft: '首字延迟', cacheHit: '缓存命中', avgOf: (v) => `均值 ${v}`,
      peak: (v) => `峰值 ${v} tok/s`, lastReply: (n) => `上次回复输出 ${n} tok`,
      thinkingNote: (a, b) => `，思考 ${a} · 回复 ${b}`, streamNote: (v) => `，流式 ${v}`,
      speedTip: (s, e, t, o) => `流式 ${s} tok/s · 端到端 ${e} tok/s · 首字 ${t} · 输出 ${o} tok`,
      byModelSpeed: '按模型', agentMain: '主智能体', agentSub: '子智能体',
      sessionTitle: '本会话累计', sessionTokens: 'tokens，不含缓存',
      ioLine: (i, o, c) => `输入 ${i} · 输出 ${o} · 缓存读取 ${c}`, hitLine: (p) => `缓存命中 ${p}%`,
      span: (a, b) => `${a} 至 ${b}`,
      quotaTitle: '模型额度', fetchedAt: (t) => `获取于 ${t}`,
      remaining: '剩余', used: (p) => `已用 ${p}`, resetIn: (d) => `${d}后重置`, resetAt: (t) => `重置时间 ${t}`,
      resetPassed: '已到重置时间，刷新查看', noReset: '无重置时间', unlimited: '不限 · 无重置',
      inferred: '根据重置时间推断，应用未直接说明额度周期',
      limit: '额度', limitKinds: { '5h': '5 小时限额', daily: '每日限额', weekly: '每周限额', none: '不限额', unknown: '限额' },
      categoriesQuota: { claude_gpt: 'Claude / GPT-OSS 模型', gemini: 'Gemini 模型', tab: 'Tab 补全', other: '其他模型' },
      moreModels: (n) => `其他 ${n} 个模型`, noPools: '没有可显示的额度信息',
      quotaUnavailable: '额度信息暂不可用', quotaUnavailableHint: '语言服务器没有提供额度数据，稍后刷新再试',
      quotaFailed: '获取额度失败', requestFailed: '请求失败',
      dur: { d: '天', h: '小时', m: '分', s: '秒' },
      historyTitle: '历史用量', scanning: '正在扫描所有对话，可能需要几秒', historyFailed: '扫描历史失败',
      periods: { today: '今天', d7: '近 7 天', d30: '近 30 天', all: '全部' },
      colPeriod: '时段', colTokens: 'Tokens', colCalls: '调用', colCost: '参考价',
      callsConvs: (c, n) => `${c} 次调用 · ${n} 个对话`, calls: (n) => `${n} 次调用`,
      tokensNoCache: 'tokens，不含缓存读取',
      refNote: '参考价按公开单价估算，不代表实际账单', refPartial: '部分模型没有公开单价，未计入，≥ 表示下限',
      noRefPrice: '没有参考价', partialTip: '仅含有参考价的模型',
      byModel: '按模型', noModels: '暂无模型用量', legInput: '输入', legCache: '缓存读取', legOutput: '输出',
      activity: '活跃度', activeDays: (a, w) => `近 ${w} 周活跃 ${a} 天`,
      dayTip: (d, t, c) => `${d} · ${t} tok（含缓存）· ${c} 次调用`, less: '少', more: '多',
      byConversation: '按会话', untitled: '未命名对话', moreConvs: (n) => `再显示 ${n} 个`,
      sources: (d, c) => `桌面 ${d} · CLI ${c} 个对话`, errors: (n) => `${n} 个无法读取`,
      scannedAt: (t, ms) => `扫描于 ${t}${ms != null ? `，用时 ${ms} ms` : ''}`,
      weekdays: ['日', '一', '二', '三', '四', '五', '六'],
    },
    en: {
      'tab.overview': 'Overview', 'tab.quota': 'Quota', 'tab.history': 'History',
      loading: 'Loading…', refresh: 'Refresh', unknown: 'Unknown', tokens: 'tokens', live: 'Live',
      copy: 'Copy as text', copied: 'Copied', copyTitle: 'Copy the report as the CLI prints it',
      gridTitle: 'Each dot is 1% of the context window',
      tokenUsage: 'Token usage', freeSpace: 'Free space',
      checkpointBuffer: (n) => `Checkpoint buffer ${n} tokens, not counted in usage`,
      checkpoints: 'Checkpoints', checkpointN: (n) => `Checkpoint ${n}`, inContext: 'in context',
      olderCheckpoints: (n) => `${n} older checkpoint(s) summarized, not in context`,
      knowledgeFiles: 'Knowledge files', artifactFiles: 'Artifact files', skillFiles: 'Skill files', systemFiles: 'System files', autoLoaded: 'auto-loaded',
      conversationFolder: 'conversation folder',
      related: 'Related /artifact · /skill · /rewind', updated: (t) => `Updated ${t}`,
      budget: (b, p) => `Request budget ${b}, ${p}% used`, budgetHint: 'Past the request budget the app trims older history, even though the native window is larger',
      budgetOver: 'Over the request budget, older history is being trimmed',
      headings: {},
      categories: {},
      noConversation: 'Open a conversation to see its context usage',
      noDatabase: 'This conversation has no saved data yet. Send a message first',
      readFailed: (m) => `Couldn't read this conversation: ${m}`,
      speedTitle: 'Output speed', speedWaiting: 'Generation speed appears after the model finishes a reply', speedCalls: (n) => `${n} calls`,
      streaming: 'Streaming', e2e: 'End to end', ttft: 'First token', cacheHit: 'Cache hit', avgOf: (v) => `avg ${v}`,
      peak: (v) => `peak ${v} tok/s`, lastReply: (n) => `Last reply ${n} tok`,
      thinkingNote: (a, b) => `, thinking ${a} · response ${b}`, streamNote: (v) => `, streamed in ${v}`,
      speedTip: (s, e, t, o) => `streaming ${s} tok/s · end to end ${e} tok/s · first token ${t} · output ${o} tok`,
      byModelSpeed: 'By model', agentMain: 'main agent', agentSub: 'subagent',
      sessionTitle: 'This conversation', sessionTokens: 'tokens, excluding cache',
      ioLine: (i, o, c) => `in ${i} · out ${o} · cache read ${c}`, hitLine: (p) => `cache hit ${p}%`,
      span: (a, b) => `${a} to ${b}`,
      quotaTitle: 'Model quota', fetchedAt: (t) => `Fetched ${t}`,
      remaining: 'left', used: (p) => `${p} used`, resetIn: (d) => `Resets in ${d}`, resetAt: (t) => `Resets at ${t}`,
      resetPassed: 'Reset time reached, refresh to update', noReset: 'No reset time', unlimited: 'Unlimited · no reset',
      inferred: 'Inferred from the reset time; the app does not state the window',
      limit: 'Quota', limitKinds: { '5h': '5-hour limit', daily: 'Daily limit', weekly: 'Weekly limit', none: 'No limit', unknown: 'Limit' },
      categoriesQuota: { claude_gpt: 'Claude / GPT-OSS models', gemini: 'Gemini models', tab: 'Tab completion', other: 'Other models' },
      moreModels: (n) => `${n} more models`, noPools: 'No quota information to show',
      quotaUnavailable: 'Quota unavailable', quotaUnavailableHint: 'The language server did not provide quota data. Try refreshing later',
      quotaFailed: 'Could not load quota', requestFailed: 'Request failed',
      dur: { d: 'd', h: 'h', m: 'm', s: 's' },
      historyTitle: 'Usage history', scanning: 'Scanning all conversations, this can take a few seconds', historyFailed: 'History scan failed',
      periods: { today: 'Today', d7: 'Last 7 days', d30: 'Last 30 days', all: 'All time' },
      colPeriod: 'Period', colTokens: 'Tokens', colCalls: 'Calls', colCost: 'Ref. cost',
      callsConvs: (c, n) => `${c} calls · ${n} conversations`, calls: (n) => `${n} calls`,
      tokensNoCache: 'tokens, excluding cache reads',
      refNote: 'Reference cost from public list prices, not your bill', refPartial: 'Some models have no public price and are left out, so ≥ marks a lower bound',
      noRefPrice: 'no reference price', partialTip: 'priced models only',
      byModel: 'By model', noModels: 'No model usage yet', legInput: 'Input', legCache: 'Cache read', legOutput: 'Output',
      activity: 'Activity', activeDays: (a, w) => `Active ${a} days in the last ${w} weeks`,
      dayTip: (d, t, c) => `${d} · ${t} tok incl. cache · ${c} calls`, less: 'Less', more: 'More',
      byConversation: 'By conversation', untitled: 'Untitled conversation', moreConvs: (n) => `Show ${n} more`,
      sources: (d, c) => `Desktop ${d} · CLI ${c} conversations`, errors: (n) => `${n} unreadable`,
      scannedAt: (t, ms) => `Scanned ${t}${ms != null ? ` in ${ms} ms` : ''}`,
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
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

  function fmtTok(n) {
    n = num(n);
    if (n >= 1e9) { const v = n / 1e9; return Number.isInteger(v) ? `${v}B` : `${v.toFixed(1)}B`; }
    if (n >= 1e6) { const v = n / 1e6; return Number.isInteger(v) ? `${v}M` : `${v.toFixed(1)}M`; }
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
    return String(n);
  }
  const fmtInt = (n) => num(n).toLocaleString(locale());
  const fmtTps = (v) => (isNum(v) ? v.toFixed(1) : '—');
  const fmtSec = (v) => (isNum(v) ? `${v.toFixed(2)}s` : '—');
  function fmtUsd(v) {
    if (v > 0 && v < 0.01) return '<$0.01';
    return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  function parseDate(iso) {
    const d = new Date(iso);
    return iso && !Number.isNaN(d.getTime()) ? d : null;
  }
  function fmtTime(iso, withDate) {
    const d = parseDate(iso);
    if (!d) return '—';
    const opts = { hour: '2-digit', minute: '2-digit' };
    if (withDate) Object.assign(opts, { month: 'short', day: 'numeric' });
    return d.toLocaleString(locale(), opts);
  }
  function fmtAgo(iso) {
    const d = parseDate(iso);
    if (!d) return '—';
    const sec = Math.round((d.getTime() - Date.now()) / 1000);
    const rtf = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' });
    const a = Math.abs(sec);
    if (a < 60) return rtf.format(Math.round(sec), 'second');
    if (a < 3600) return rtf.format(Math.round(sec / 60), 'minute');
    if (a < 86400) return rtf.format(Math.round(sec / 3600), 'hour');
    if (a < 86400 * 30) return rtf.format(Math.round(sec / 86400), 'day');
    return d.toLocaleDateString(locale(), { year: 'numeric', month: 'short', day: 'numeric' });
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

  /** Reference cost: ≥ when some calls were unpriced, an explicit "no reference price" when none were. */
  function costHtml(value, { partial = false, calls = 0, label = true } = {}) {
    if (!isNum(value)) {
      if (num(calls) > 0) return `<span class="dim" title="${esc(t('noRefPrice'))}">—${label ? ` ${esc(t('noRefPrice'))}` : ''}</span>`;
      return '<span class="dim">—</span>';
    }
    const tip = partial ? `${t('partialTip')} · ${t('refPartial')}` : t('refNote');
    return `<span title="${esc(tip)}">${partial ? '≥' : ''}${esc(fmtUsd(value))}${label ? ` <span class="lbl">${esc(t('colCost'))}</span>` : ''}</span>`;
  }

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
  const openKeys = new Set(); // expanded <details data-key> across repaints

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

  const categoryName = (c) => t('categories')[c.key] || c.name;

  function categoryRow(c) {
    const color = CONVERSATION[c.key] || (SYSTEM.has(c.key) ? 'var(--c-system)' : 'var(--c-custom)');
    const shape = CONVERSATION[c.key] ? '' : ' sq';
    return `<div class="row"><span class="mark${shape}" style="background:${color}"></span><span class="ellipsis">${esc(categoryName(c))}</span>`
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
    const note = r.heading === 'Token usage by category' ? '' : `<p class="note" style="margin:0 0 8px">${esc(t('headings')[r.heading] || r.heading)}</p>`;
    const buffer = r.checkpoint_buffer ? `<p class="note">${esc(t('checkpointBuffer', fmtTok(r.checkpoint_buffer)))}</p>` : '';
    return `<section><h2>${esc(t('tokenUsage'))}</h2>${note}
      <div class="group">${conv.map(categoryRow).join('')}</div>
      ${rest.length ? `<div class="group">${rest.map(categoryRow).join('')}</div>` : ''}
      <div class="group">${free}</div>${buffer}</section>`;
  }

  function checkpoints(r) {
    const ck = r.checkpoint_view;
    if (!ck) return '';
    const older = ck.historical ? `<p class="note">${esc(t('olderCheckpoints', ck.historical))}</p>` : '';
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

  /** Recent calls as bars: streaming tok/s on a zero baseline, latest in the accent. */
  function trendBars(recent) {
    if (!Array.isArray(recent) || recent.length < 2) return '';
    const vals = recent.map((x) => (isNum(x.streaming_tps) ? x.streaming_tps : null));
    const max = Math.max(0, ...vals.filter((v) => v != null));
    if (!max) return '';
    const bars = recent.map((x, i) => {
      const v = vals[i];
      const tip = t('speedTip', fmtTps(x.streaming_tps), fmtTps(x.e2e_tps), fmtSec(x.ttft_sec), fmtTok(x.output_tokens));
      const cls = [v == null ? 'none' : '', i === recent.length - 1 ? 'last' : ''].join(' ').trim();
      const h = v == null ? 2 : Math.max(2, Math.round(v / max * 36));
      return `<span class="${cls}" style="height:${h}px" title="${esc(tip)}"></span>`;
    }).join('');
    return `<div class="trend"><div class="bars">${bars}</div><span class="lbl">${esc(t('peak', max.toFixed(0)))}</span></div>`;
  }

  function speedByModel(list) {
    if (!Array.isArray(list) || list.length < 2) return '';
    const rows = list.map((m, i) => {
      const key = `spd:${m.model || i}`;
      const name = m.display_name || m.model || '?';
      const agent = m.agent === 'main' ? t('agentMain') : m.agent === 'subagent' ? t('agentSub') : '';
      const bars = trendBars(m.recent);
      const head = `<span class="ellipsis">${esc(name)}${agent ? ` <span class="dim">· ${esc(agent)}</span>` : ''}</span>`
        + `<span class="rv num"><b>${fmtTps(m.avg_streaming_tps)}</b> tok/s · ${esc(fmtSec(m.avg_ttft_sec))} · ${esc(t('calls', fmtInt(m.calls)))}</span>`;
      if (!bars) return `<li><div class="rh">${head}</div></li>`;
      return `<li><details data-key="${esc(key)}"${openKeys.has(key) ? ' open' : ''}><summary class="rh" style="width:auto;display:flex">${head}</summary>
        <div style="margin-top:8px">${bars}</div></details></li>`;
    }).join('');
    return `<h2 style="margin:16px 0 4px">${esc(t('byModelSpeed'))} <span class="hint">${esc(t('streaming'))} · ${esc(t('ttft'))}</span></h2><ul class="rank">${rows}</ul>`;
  }

  function speed(r) {
    const s = r.speed;
    if (!s || !s.latest) {
      return `<section><h2>${esc(t('speedTitle'))}</h2><p class="note" style="margin:0">${esc(t('speedWaiting'))}</p></section>`;
    }
    const l = s.latest;
    const thinking = l.thinking_tokens > 0 ? t('thinkingNote', fmtTok(l.thinking_tokens), fmtTok(l.response_tokens)) : '';
    const stream = l.streaming_sec != null ? t('streamNote', fmtSec(l.streaming_sec)) : '';
    return `<section><h2>${esc(t('speedTitle'))} <span class="hint">${esc(t('speedCalls', s.calls))}</span></h2>
      <div class="speed-head">
        <div><div class="lbl">${esc(t('streaming'))}</div>
          <div class="fig num">${fmtTps(l.streaming_tps)}<span class="unit">tok/s</span></div>
          <div class="lbl num">${esc(t('avgOf', `${fmtTps(s.avg_streaming_tps)} tok/s`))}</div></div>
        ${trendBars(s.recent)}
      </div>
      <div class="stats">
        <div><div class="lbl">${esc(t('e2e'))}</div><div class="v num">${fmtTps(l.e2e_tps)}<span class="unit">tok/s</span></div></div>
        <div><div class="lbl">${esc(t('ttft'))}</div><div class="v num">${fmtSec(l.ttft_sec)}</div></div>
        <div><div class="lbl">${esc(t('cacheHit'))}</div><div class="v num">${isNum(l.cache_hit_pct) ? `${l.cache_hit_pct.toFixed(0)}%` : '—'}</div></div>
      </div>
      <p class="note num">${esc(t('lastReply', fmtTok(l.output_tokens)) + thinking + stream)}</p>
      ${speedByModel(s.by_model)}
    </section>`;
  }

  function session(r) {
    const s = r.session;
    if (!s || typeof s !== 'object' || !num(s.calls)) return '';
    const total = isNum(s.total_tokens) ? s.total_tokens : num(s.input) + num(s.output);
    const span = s.first_at && s.last_at ? `<p class="note num">${esc(t('span', fmtTime(s.first_at, true), fmtTime(s.last_at, true)))}</p>` : '';
    const models = Array.isArray(s.by_model) && s.by_model.length > 1
      ? `<ul class="mini" style="margin-top:8px">${s.by_model.map((m) => `<li><span class="ellipsis" title="${esc(m.model || '')}">${esc(m.display_name || m.model || '?')}</span>`
        + `<span class="num dim">${fmtTok(num(m.input) + num(m.output))} · ${esc(t('calls', fmtInt(m.calls)))}${isNum(m.est_cost_usd) ? ` · ${esc(fmtUsd(m.est_cost_usd))}` : ''}</span></li>`).join('')}</ul>`
      : '';
    return `<section><h2>${esc(t('sessionTitle'))} <span class="hint">${esc(t('speedCalls', fmtInt(s.calls)))}</span></h2>
      <div class="session-head">
        <div class="fig num" title="${esc(fmtInt(total))}">${fmtTok(total)}<span class="unit">${esc(t('sessionTokens'))}</span></div>
        <div class="cost num">${costHtml(s.est_cost_usd, { partial: !!s.cost_partial, calls: s.calls })}</div>
      </div>
      <p class="note num" style="margin-top:4px">${esc(t('ioLine', fmtTok(s.input), fmtTok(s.output), fmtTok(s.cache_read)))}${isNum(s.cache_hit_pct) ? ` · ${esc(t('hitLine', s.cache_hit_pct.toFixed(0)))}` : ''}</p>
      ${span}${models}
    </section>`;
  }

  function renderOverview(r) {
    const limit = r.limit_tokens;
    panes.overview.innerHTML = `
      <div class="top">
        <div class="model"><span class="live on" title="${esc(t('live'))}"></span><span class="ellipsis">${esc(r.model)}</span></div>
        <button id="copy" title="${esc(t('copyTitle'))}">${esc(t('copy'))}</button>
      </div>
      <div class="usage">
        <span class="big num">${fmtTok(r.used_tokens)}</span>
        <span class="of num">/ ${limit ? fmtTok(limit) : esc(t('unknown'))} ${esc(t('tokens'))}</span>
        ${limit ? `<span class="pct num">${num(r.used_pct).toFixed(1)}%</span>` : ''}
      </div>
      ${budget(r)}
      ${grid(r)}
      ${speed(r)}
      ${session(r)}
      ${categories(r)}
      ${checkpoints(r)}
      ${files(t('knowledgeFiles'), '/rules', r.knowledge_files)}
      ${files(t('artifactFiles'), '/artifact', r.artifact_files)}
      ${files(t('skillFiles'), '/skill', r.skill_files)}
      ${files(t('systemFiles'), t('autoLoaded'), r.system_files)}
      <footer><span>${esc(t('related'))}</span><span class="num">${esc(t('updated', fmtTime(r.updatedAt)))}</span></footer>`;
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
    const st = { data: null, loading: false, error: null, loadedAt: 0 };
    st.load = async (refresh) => {
      if (st.loading) return;
      st.loading = true;
      st.error = null;
      paint();
      try {
        const data = await getJson(path, refresh ? { refresh: 'true' } : null);
        if (!data || typeof data !== 'object') throw new Error('invalid response');
        st.data = data;
        st.loadedAt = Date.now();
      } catch (err) {
        st.error = (err && err.message) || String(err);
      } finally {
        st.loading = false;
        paint();
      }
    };
    st.open = () => {
      if (!st.loading && (!st.data || Date.now() - st.loadedAt > staleMs)) st.load(false);
      else paint();
    };
    return st;
  }

  function toolbar(id, title, meta, loading) {
    return `<div class="toolbar"><h2>${esc(title)}</h2>
      <button data-refresh="${id}" ${loading ? 'disabled' : ''}>${loading ? '<span class="spin"></span>' : ''}${esc(t('refresh'))}</button></div>
      ${meta ? `<div class="meta num">${meta}</div>` : ''}`;
  }

  // --- quota ------------------------------------------------------------------

  const quota = makeLoader('/api/quota', QUOTA_STALE_MS, () => paintQuota());
  const fraction = (v) => (isNum(v) ? Math.min(1, Math.max(0, v)) : null);
  const levelOf = (f) => (f == null ? 'unknown' : f < 0.05 ? 'crit' : f < 0.2 ? 'warn' : '');
  const pctText = (f) => (f == null ? '—' : `${(f * 100).toFixed(f < 0.1 && f > 0 ? 1 : 0)}%`);
  const isUnlimited = (l) => l.kind === 'none' || (!l.reset_time && (l.f == null || l.f >= 1));

  function resetText(iso) {
    const d = parseDate(iso);
    if (!d) return t('noReset');
    const left = d.getTime() - Date.now();
    return left <= 0 ? t('resetPassed') : t('resetIn', fmtDuration(left));
  }

  // Dedupe by display name (case-insensitive), keeping the first id seen.
  function dedupeModels(list) {
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

  function poolLimits(p) {
    const raw = Array.isArray(p.limits) && p.limits.length ? p.limits : [{ remaining_fraction: p.remaining_fraction, reset_time: p.reset_time }];
    return raw.map((l) => ({
      kind: l.kind || '', inferred: !!l.inferred, f: fraction(l.remaining_fraction), reset_time: l.reset_time || null,
      label: (lang === 'zh' ? l.label_zh : l.label) || l.label || '',
    }));
  }

  function limitLabel(l, single) {
    const kinds = t('limitKinds');
    let name;
    if (l.kind && kinds[l.kind] && l.kind !== 'unknown') name = kinds[l.kind];
    else if (l.label) name = l.label;
    else name = single ? t('limit') : kinds.unknown;
    return l.inferred && l.kind !== 'none' ? `≈${name}` : name;
  }

  const meter = (f, name) => {
    const on = f == null ? 0 : Math.round(f * 20);
    let dots = '';
    for (let i = 0; i < 20; i += 1) dots += `<i class="${i < on ? 'on' : ''}"></i>`;
    return `<div class="meter" role="progressbar" aria-label="${esc(name)}" aria-valuemin="0" aria-valuemax="100"${f != null ? ` aria-valuenow="${Math.round(f * 100)}"` : ''}>${dots}</div>`;
  };

  function limitHtml(l, single) {
    const name = limitLabel(l, single);
    if (isUnlimited(l)) {
      return `<div class="limit free"><div class="limit-head"><span>${esc(name)}</span><span>${esc(t('unlimited'))}</span></div></div>`;
    }
    const f = l.f;
    const resetTitle = l.reset_time ? t('resetAt', fmtTime(l.reset_time, true)) : '';
    return `<div class="limit ${levelOf(f)}">
      <div class="limit-head"><span${l.inferred ? ` title="${esc(t('inferred'))}"` : ''}>${esc(name)}${f != null ? ` · ${esc(t('used', pctText(1 - f)))}` : ''}</span>
        <span class="num" data-reset="${esc(l.reset_time || '')}" title="${esc(resetTitle)}">${esc(resetText(l.reset_time))}</span></div>
      <div class="limit-body">${meter(f, name)}<div class="limit-pct num">${pctText(f)}<span class="lbl">${esc(t('remaining'))}</span></div></div>
    </div>`;
  }

  function poolHtml(p) {
    const limits = poolLimits(p);
    const label = (p.category && t('categoriesQuota')[p.category]) || (lang === 'zh' ? p.label_zh : p.label) || p.label || p.id || '?';
    const tag = (m) => `<span class="tag" title="${esc(m.id)}">${esc(m.name)}${m.levels.length ? `<span class="dim">${esc(m.levels.join(' · '))}</span>` : ''}</span>`;
    const families = dedupeModels(p.families);
    const shownList = families.length ? families : dedupeModels(p.models);
    const shown = new Set(shownList.map((m) => m.name.toLowerCase()));
    const hidden = dedupeModels(p.hidden_models).filter((m) => !shown.has(m.name.toLowerCase()));
    const key = `pool:${p.id || label}`;
    const more = hidden.length
      ? `<details class="more" data-key="${esc(key)}"${openKeys.has(key) ? ' open' : ''}><summary>${esc(t('moreModels', hidden.length))}</summary><div class="tags">${hidden.map(tag).join('')}</div></details>`
      : '';
    return `<div class="pool">
      <div class="pool-label">${esc(label)}</div>
      ${limits.map((l) => limitHtml(l, limits.length === 1)).join('')}
      ${shownList.length ? `<div class="tags">${shownList.map(tag).join('')}</div>` : ''}
      ${more}
    </div>`;
  }

  function paintQuota() {
    const { data, loading, error } = quota;
    let meta = '';
    let body = '';
    if (error) body = errorBox(t('requestFailed'), error);
    else if (!data) body = `<p class="empty"><span class="spin"></span>${esc(t('loading'))}</p>`;
    else if (data.error) {
      body = data.error === 'unavailable'
        ? errorBox(t('quotaUnavailable'), data.message || t('quotaUnavailableHint'))
        : errorBox(t('quotaFailed'), data.message || data.error);
    }
    if (data && !data.error) {
      meta = [data.tier, data.plan && data.plan !== data.tier ? data.plan : '', data.fetched_at ? t('fetchedAt', fmtTime(data.fetched_at)) : '']
        .filter(Boolean).map(esc).join(' · ');
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
  let period = PERIODS.includes(store.get('ctx.period', 'd30')) ? store.get('ctx.period', 'd30') : 'd30';
  let convLimit = CONV_VISIBLE;
  const newTok = (x) => num(x && x.input) + num(x && x.output);
  const allTok = (x) => newTok(x) + num(x && x.cache_read);

  function headline(tot, partial) {
    const p = tot[period] || {};
    return `<div class="headline">
      <div class="lbl">${esc(t('periods')[period])}</div>
      <div class="fig num" title="${esc(fmtInt(newTok(p)))}">${fmtTok(newTok(p))}<span class="unit">${esc(t('tokensNoCache'))}</span></div>
      <div class="lbl num">${esc(t('callsConvs', fmtInt(p.calls), fmtInt(p.conversations)))} · ${costHtml(p.est_cost_usd, { partial, calls: p.calls, label: false })}</div>
      <div class="lbl num">${esc(t('ioLine', fmtTok(p.input), fmtTok(p.output), fmtTok(p.cache_read)))}</div>
    </div>`;
  }

  function periodTable(tot, partial) {
    const rows = PERIODS.map((k) => {
      const p = tot[k] || {};
      return `<tr data-period="${k}" aria-selected="${k === period}" tabindex="0">
        <td>${esc(t('periods')[k])}</td><td class="num">${fmtTok(newTok(p))}</td><td class="num">${fmtInt(p.calls)}</td>
        <td class="num">${costHtml(p.est_cost_usd, { partial, calls: p.calls, label: false })}</td></tr>`;
    }).join('');
    return `<table class="periods"><thead><tr><th>${esc(t('colPeriod'))}</th><th>${esc(t('colTokens'))}</th><th>${esc(t('colCalls'))}</th><th>${esc(t('colCost'))}</th></tr></thead>
      <tbody>${rows}</tbody></table>
      <p class="note">${esc(t('refNote'))}${partial ? `. ${esc(t('refPartial'))}` : ''}</p>`;
  }

  const parseDay = (s) => { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, (m || 1) - 1, d || 1); };
  const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  /** GitHub-style grid: weeks across, Sun..Sat down; spans from the first active week (12–26 weeks), fluid width. */
  function heatmap(daily) {
    if (!Array.isArray(daily) || !daily.length) return '';
    const byDay = new Map(daily.map((d) => [d.date, d]));
    const end = parseDay(daily[daily.length - 1].date);
    if (Number.isNaN(end.getTime())) return '';
    const firstActive = daily.find((d) => num(d.tokens) > 0 || num(d.calls) > 0);
    const spanDays = firstActive ? Math.round((end - parseDay(firstActive.date)) / 86400000) + 1 : 0;
    const weeks = Math.min(HEAT_MAX_WEEKS, Math.max(HEAT_MIN_WEEKS, Math.ceil((spanDays + (6 - end.getDay())) / 7)));
    const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - end.getDay() - 7 * (weeks - 1));
    const days = [];
    for (let i = 0; i < weeks * 7; i += 1) days.push(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
    const vals = days.filter((d) => d <= end).map((d) => num((byDay.get(dayKey(d)) || {}).tokens)).filter((v) => v > 0).sort((a, b) => a - b);
    const q = (p) => vals[Math.min(vals.length - 1, Math.floor(p * vals.length))];
    const cuts = vals.length ? [q(0.25), q(0.5), q(0.75)] : [];
    const level = (v) => (v <= 0 ? 0 : v <= cuts[0] ? 1 : v <= cuts[1] ? 2 : v <= cuts[2] ? 3 : 4);
    const wd = t('weekdays');
    let html = '';
    let lastLabelCol = -9;
    for (let w = 0; w < weeks; w += 1) {
      const first = days[w * 7];
      const monthStart = days.slice(w * 7, w * 7 + 7).find((d) => d.getDate() === 1);
      if ((w === 0 || monthStart) && w - lastLabelCol >= 4 && w <= weeks - 3) {
        const m = (monthStart || first).toLocaleDateString(locale(), { month: 'short' });
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
      const tip = t('dayTip', `${dayKey(d)} ${wd[d.getDay()]}`, fmtInt(e.tokens), fmtInt(e.calls));
      html += `<span class="cell l${level(num(e.tokens))}" style="${style}" title="${esc(tip)}"></span>`;
    });
    const scale = `<span class="scale"><span class="t">${esc(t('less'))}</span>${[0, 1, 2, 3, 4].map((l) => `<span class="cell l${l}"></span>`).join('')}<span class="t">${esc(t('more'))}</span></span>`;
    return `<section><h2>${esc(t('activity'))}</h2>
      <div class="heat" style="grid-template-columns:auto repeat(${weeks}, minmax(0, 1fr))">${html}</div>
      <div class="heat-foot"><span>${esc(t('activeDays', active, weeks))}</span>${scale}</div></section>`;
  }

  function byModel(list) {
    if (!Array.isArray(list) || !list.length) return `<section><h2>${esc(t('byModel'))}</h2><p class="note" style="margin:0">${esc(t('noModels'))}</p></section>`;
    const max = Math.max(1, ...list.map(allTok));
    const seg = (v, cls) => (v > 0 ? `<span class="${cls}" style="width:${(v / max * 100).toFixed(2)}%"></span>` : '');
    const legend = `<div class="legend"><span><i class="seg-in"></i>${esc(t('legInput'))}</span><span><i class="seg-cache"></i>${esc(t('legCache'))}</span><span><i class="seg-out"></i>${esc(t('legOutput'))}</span></div>`;
    const rows = list.slice(0, 12).map((m) => {
      const tip = `${m.model}\n${t('ioLine', fmtInt(m.input), fmtInt(m.output), fmtInt(m.cache_read))}\n${t('calls', fmtInt(m.calls))}`;
      return `<li title="${esc(tip)}">
        <div class="rh"><span class="ellipsis">${esc(m.display_name || m.model || '?')}</span>
          <span class="rv num"><b>${fmtTok(newTok(m))}</b> · ${esc(t('calls', fmtInt(m.calls)))}${isNum(m.est_cost_usd) ? ` · ${esc(fmtUsd(m.est_cost_usd))}` : ''}</span></div>
        <div class="hbar">${seg(num(m.input), 'seg-in')}${seg(num(m.cache_read), 'seg-cache')}${seg(num(m.output), 'seg-out')}</div>
      </li>`;
    }).join('');
    return `<section><h2>${esc(t('byModel'))} <span class="hint">${esc(t('colTokens'))} · ${esc(t('colCalls'))}</span></h2>${legend}<ul class="rank">${rows}</ul></section>`;
  }

  function byConversation(list) {
    if (!Array.isArray(list) || !list.length) return '';
    const rows = list.slice(0, convLimit).map((c) => {
      const title = c.title ? String(c.title) : '';
      const agentName = title.startsWith('@');
      const shown = title || `${t('untitled')} · ${String(c.id || '').slice(0, 8)}`;
      const sub = [c.display_name || c.model, fmtAgo(c.last_at), c.source && c.source !== 'desktop' ? c.source : ''].filter(Boolean).join(' · ');
      return `<li title="${esc(c.id || '')}">
        <span class="ellipsis${agentName || !title ? ' dim' : ''}">${esc(shown)}</span>
        <span class="rv num"><b>${fmtTok(newTok(c))}</b>${isNum(c.est_cost_usd) ? esc(fmtUsd(c.est_cost_usd)) : esc(t('calls', fmtInt(c.calls)))}</span>
        <span class="sub ellipsis">${esc(sub)}</span>
      </li>`;
    }).join('');
    const rest = list.length - convLimit;
    const more = rest > 0 ? `<button data-more-convs style="margin-top:8px">${esc(t('moreConvs', Math.min(rest, CONV_VISIBLE * 2)))}</button>` : '';
    return `<section><h2>${esc(t('byConversation'))} <span class="hint">${fmtInt(list.length)}</span></h2><ul class="convs">${rows}</ul>${more}</section>`;
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
        const partial = Array.isArray(data.by_model) && data.by_model.some((m) => num(m.calls) > 0 && !isNum(m.est_cost_usd));
        const foot = [t('sources', fmtInt(src.desktop), fmtInt(src.cli))];
        if (num(data.errors) > 0) foot.push(t('errors', fmtInt(data.errors)));
        body = headline(tot, partial) + periodTable(tot, partial) + heatmap(data.daily) + byModel(data.by_model)
          + byConversation(data.by_conversation) + `<footer><span>${esc(foot.join(' · '))}</span></footer>`;
      }
    }
    panes.history.innerHTML = toolbar('history', t('historyTitle'), meta, loading) + body;
  }

  function setPeriod(k) {
    if (!PERIODS.includes(k) || k === period) return;
    period = k;
    store.set('ctx.period', k);
    paintHistory();
    const row = panes.history.querySelector(`tr[data-period="${k}"]`);
    if (row) row.focus();
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
    if (b) {
      if (b.dataset.refresh === 'quota') quota.load(true);
      else if (b.dataset.refresh === 'history') history.load(true);
      return;
    }
    if (e.target.closest('[data-more-convs]')) { convLimit += CONV_VISIBLE * 2; paintHistory(); return; }
    const row = e.target.closest('tr[data-period]');
    if (row) setPeriod(row.dataset.period);
  });
  panes.history.addEventListener('keydown', (e) => {
    const row = e.target.closest && e.target.closest('tr[data-period]');
    if (!row) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setPeriod(row.dataset.period); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const i = PERIODS.indexOf(period) + (e.key === 'ArrowDown' ? 1 : -1);
      setPeriod(PERIODS[Math.min(PERIODS.length - 1, Math.max(0, i))]);
    }
  });
  document.addEventListener('toggle', (e) => {
    const d = e.target;
    if (!d || !d.matches || !d.matches('details[data-key]')) return;
    if (d.open) openKeys.add(d.dataset.key); else openKeys.delete(d.dataset.key);
  }, true);
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
