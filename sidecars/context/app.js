(() => {
  'use strict';

  const POLL_MS = 3000;
  const AUTO_REFRESH_MS = 65 * 1000;
  const QUOTA_STALE_MS = 60 * 1000;
  const HISTORY_STALE_MS = 60 * 1000;
  const RESET_RETRY_MS = 3000;
  const SEGMENT_COLORS = ['var(--c-system)', 'var(--c-user)', 'var(--c-agent)', 'var(--c-tool)', 'var(--c-custom)'];
  const CONVERSATION = { user: 'var(--c-user)', agent: 'var(--c-agent)', tool: 'var(--c-tool)', system_messages: 'var(--c-sysmsg)' };
  const SYSTEM = new Set(['system_prompt', 'system_tools', 'system_overhead']);
  const TABS = ['overview', 'quota', 'history'];
  const PERIODS = ['today', 'd7', 'd30', 'all'];
  const HISTORY_VIEWS = ['totals', 'sessions', 'list'];
  const SESSION_PERIODS = ['all', 'd30', 'd7', 'today'];
  const LIST_SORTS = ['recent', 'tokens', 'calls'];
  const SOURCE_FILTERS = ['all', 'desktop', 'cli'];
  const HEAT_MIN_WEEKS = 10;
  const HEAT_MAX_WEEKS = 20;
  const CONV_VISIBLE = 8;
  const MODEL_VISIBLE = 5;
  const CHEV = '<svg class="chev" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 2.5L8 6l-3.5 3.5"/></svg>';
  const params = new URLSearchParams(location.search);
  const conversationId = (window.sidecar && window.sidecar.conversationId) || params.get('conversationId') || '';
  const doFetch = (window.sidecar && window.sidecar.fetch) || fetch;
  const $ = (id) => document.getElementById(id);
  const panes = { overview: $('overview'), quota: $('quota'), history: $('history') };

  // --- i18n -------------------------------------------------------------------

  const I18N = {
    zh: {
      'tab.overview': '概览', 'tab.quota': '额度', 'tab.history': '历史',
      loading: '加载中…', refresh: '刷新', autoTag: '自动刷新',
      refreshTip: (s) => `刷新 · 自动刷新中（每 ${s} 秒）`, langAria: '切换语言',
      unknown: '未知', tokens: 'tokens', live: '实时',
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
      median: (v) => `中位数 ${v} tok/s`, sep: '。', lastReply: (n) => `上次回复输出 ${n} tok`,
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
      periodPills: { today: '今天', d7: '7 天', d30: '30 天', all: '全部' }, periodBarAria: '统计时段',
      colPeriod: '时段', colTokens: 'Tokens', colCalls: '调用', colConvs: '对话', colCost: '参考价',
      callsConvs: (c, n) => `${c} 次调用 · ${n} 个对话`, calls: (n) => `${n} 次调用`,
      tokensNoCache: 'tokens，不含缓存读取', exclCache: '不含缓存读取',
      refNote: '参考价按公开单价估算，不代表实际账单', refPartial: '部分模型没有公开单价，未计入，≥ 表示下限',
      noRefPrice: '没有参考价', partialTip: '仅含有参考价的模型',
      byModel: '按模型', noModels: '暂无模型用量', showMoreModels: (n) => `展开其余 ${n} 个模型`, showLess: '收起',
      legInput: '输入', legCache: '缓存读取', legOutput: '输出', legThinking: '思考',
      activity: '活跃度', activeDays: (a, w) => `近 ${w} 周活跃 ${a} 天`,
      dayTip: (d, t, c) => `${d} · ${t} tok（含缓存）· ${c} 次调用`, less: '少', more: '多',
      byConversation: '按会话', untitled: '未命名对话', moreConvs: (n) => `再显示 ${n} 个`,
      hviews: { totals: '按总量', sessions: '按会话', list: '会话列表' }, hviewAria: '历史分类视图',
      shortPeriods: { all: '全部', d30: '近30天', d7: '近7天', today: '今天' },
      hideSubagents: '隐藏子智能体', searchPlaceholder: '搜索标题、模型或 ID', clearSearch: '清除搜索',
      sorts: { recent: '最近活跃', tokens: '按用量', calls: '按调用' },
      sourceFilters: { all: '全部', desktop: '桌面', cli: 'CLI' }, sourceNames: { desktop: '桌面', cli: 'CLI' },
      summaryLine: (n, tok, calls) => `${n} 个会话 · ${tok} tokens（不含缓存）· ${calls} 次调用`,
      noMatches: '没有符合条件的会话', noConversations: '暂无会话记录',
      sources: (d, c) => `桌面 ${d} · CLI ${c} 个对话`, errors: (n) => `${n} 个无法读取`,
      scannedAt: (t, ms) => `扫描于 ${t}${ms != null ? `，用时 ${ms} ms` : ''}`,
      weekdays: ['日', '一', '二', '三', '四', '五', '六'],
    },
    en: {
      'tab.overview': 'Overview', 'tab.quota': 'Quota', 'tab.history': 'History',
      loading: 'Loading…', refresh: 'Refresh', autoTag: 'Auto',
      refreshTip: (s) => `Refresh · Auto-refresh every ${s}s`, langAria: 'Language',
      unknown: 'Unknown', tokens: 'tokens', live: 'Live',
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
      median: (v) => `median ${v} tok/s`, sep: '. ', lastReply: (n) => `Last reply ${n} tok`,
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
      periodPills: { today: 'Today', d7: '7d', d30: '30d', all: 'All' }, periodBarAria: 'Time period',
      colPeriod: 'Period', colTokens: 'Tokens', colCalls: 'Calls', colConvs: 'Conversations', colCost: 'Ref. cost',
      callsConvs: (c, n) => `${c} calls · ${n} conversations`, calls: (n) => `${n} ${n === '1' ? 'call' : 'calls'}`,
      tokensNoCache: 'tokens, excluding cache reads', exclCache: 'excluding cache reads',
      refNote: 'Reference cost from public list prices, not your bill', refPartial: 'Some models have no public price and are left out, so ≥ marks a lower bound',
      noRefPrice: 'no reference price', partialTip: 'priced models only',
      byModel: 'By model', noModels: 'No model usage yet', showMoreModels: (n) => `Show ${n} more`, showLess: 'Show less',
      legInput: 'Input', legCache: 'Cache read', legOutput: 'Output', legThinking: 'Thinking',
      activity: 'Activity', activeDays: (a, w) => `Active ${a} days in the last ${w} weeks`,
      dayTip: (d, t, c) => `${d} · ${t} tok incl. cache · ${c} calls`, less: 'Less', more: 'More',
      byConversation: 'By conversation', untitled: 'Untitled conversation', moreConvs: (n) => `Show ${n} more`,
      hviews: { totals: 'Totals', sessions: 'By session', list: 'Session list' }, hviewAria: 'History views',
      shortPeriods: { all: 'All', d30: '30d', d7: '7d', today: 'Today' },
      hideSubagents: 'Hide subagents', searchPlaceholder: 'Search title, model or ID', clearSearch: 'Clear search',
      sorts: { recent: 'Recent', tokens: 'Usage', calls: 'Calls' },
      sourceFilters: { all: 'All', desktop: 'Desktop', cli: 'CLI' }, sourceNames: { desktop: 'Desktop', cli: 'CLI' },
      summaryLine: (n, tok, calls) => `${n} ${n === '1' ? 'conversation' : 'conversations'} · ${tok} tok excl. cache · ${calls} ${calls === '1' ? 'call' : 'calls'}`,
      noMatches: 'No matching conversations', noConversations: 'No conversations yet',
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

  /** Recent calls as bars: streaming tok/s on a zero baseline, latest in the accent.
      The scale tops out at 2× the median so one very short stream does not flatten the rest. */
  function trendBars(recent) {
    if (!Array.isArray(recent) || recent.length < 2) return '';
    const vals = recent.map((x) => (isNum(x.streaming_tps) ? x.streaming_tps : null));
    const sorted = vals.filter((v) => v != null).sort((a, b) => a - b);
    if (!sorted.length || !sorted[sorted.length - 1]) return '';
    const median = sorted[Math.floor((sorted.length - 1) / 2)];
    const top = Math.min(sorted[sorted.length - 1], Math.max(median * 2, 1));
    const bars = recent.map((x, i) => {
      const v = vals[i];
      const tip = t('speedTip', fmtTps(x.streaming_tps), fmtTps(x.e2e_tps), fmtSec(x.ttft_sec), fmtTok(x.output_tokens));
      const cls = [v == null ? 'none' : '', v != null && v > top ? 'clip' : '', i === recent.length - 1 ? 'last' : ''].join(' ').trim();
      const h = v == null ? 2 : Math.max(2, Math.round(Math.min(v, top) / top * 36));
      return `<span class="${cls}" style="height:${h}px" title="${esc(tip)}"></span>`;
    }).join('');
    return `<div class="trend"><div class="bars">${bars}</div><span class="lbl">${esc(t('median', median.toFixed(0)))}</span></div>`;
  }

  function speedByModel(list) {
    if (!Array.isArray(list) || list.length < 2) return '';
    const rows = list.map((m, i) => {
      const key = `spd:${m.model || i}`;
      const name = m.display_name || m.model || '?';
      const agent = m.agent === 'main' ? t('agentMain') : m.agent === 'subagent' ? t('agentSub') : '';
      const bars = trendBars(m.recent);
      const body = `<span class="ellipsis" title="${esc(m.model || '')}">${esc(name)}${agent ? ` <span class="dim">· ${esc(agent)}</span>` : ''}</span>`
        + `<span class="rv num"><b>${fmtTps(m.avg_streaming_tps)}</b> tok/s</span>`
        + `<span class="sub num">${esc(t('ttft'))} ${esc(fmtSec(m.avg_ttft_sec))} · ${esc(t('calls', fmtInt(m.calls)))}</span>`;
      if (!bars) return `<li><div class="spd-row plain">${body}</div></li>`;
      return `<li><details data-key="${esc(key)}"${openKeys.has(key) ? ' open' : ''}><summary class="spd-row">${CHEV}${body}</summary>
        <div class="spd-trend">${bars}</div></details></li>`;
    }).join('');
    return `<h2 style="margin:20px 0 4px">${esc(t('byModelSpeed'))} <span class="hint">${esc(t('streaming'))}</span></h2><ul class="spd">${rows}</ul>`;
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
    const meta = [];
    if (isNum(s.cache_hit_pct)) meta.push(t('hitLine', s.cache_hit_pct.toFixed(0)));
    if (s.first_at && s.last_at) meta.push(t('span', fmtTime(s.first_at, true), fmtTime(s.last_at, true)));
    const models = Array.isArray(s.by_model) && s.by_model.length > 1
      ? `<ul class="mini" style="margin-top:12px">${s.by_model.map((m) => `<li><span class="ellipsis" title="${esc(m.model || '')}">${esc(m.display_name || m.model || '?')}</span>`
        + `<span class="num dim">${fmtTok(num(m.input) + num(m.output))}${isNum(m.est_cost_usd) ? ` · ${esc(fmtUsd(m.est_cost_usd))}` : ` · ${esc(t('calls', fmtInt(m.calls)))}`}</span></li>`).join('')}</ul>`
      : '';
    return `<section><h2>${esc(t('sessionTitle'))} <span class="hint">${esc(t('speedCalls', fmtInt(s.calls)))}</span></h2>
      <div class="session-head">
        <div><div class="fig num" title="${esc(fmtInt(total))}">${fmtTok(total)}<span class="unit">${esc(t('tokens'))}</span></div>
          <div class="lbl">${esc(t('exclCache'))}</div></div>
        <div class="cost num">${costHtml(s.est_cost_usd, { partial: !!s.cost_partial, calls: s.calls })}</div>
      </div>
      <div class="stats">
        <div><div class="lbl">${esc(t('legInput'))}</div><div class="v num">${fmtTok(s.input)}</div></div>
        <div><div class="lbl">${esc(t('legOutput'))}</div><div class="v num">${fmtTok(s.output)}</div></div>
        <div><div class="lbl">${esc(t('legCache'))}</div><div class="v num">${fmtTok(s.cache_read)}</div></div>
      </div>
      ${meta.length ? `<p class="note num">${esc(meta.join(' · '))}</p>` : ''}
      ${models}
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

  let overviewBusy = false;
  let overviewSpin = false;

  async function refreshReport({ force = false } = {}) {
    if (!force && (document.hidden || tab !== 'overview')) return;
    if (overviewBusy) return;
    overviewBusy = true;
    overviewSpin = force || (!report && !overviewMessage);
    if (force) lastJson = '';
    if (overviewSpin) syncRefreshButton();
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
    } finally {
      overviewBusy = false;
      overviewSpin = false;
      syncRefreshButton();
    }
  }

  // --- shared loader for quota / history -------------------------------------

  function makeLoader(path, staleMs, { paint, keyOf, onMeta, onSilent }) {
    const st = { data: null, lastKey: '', loading: false, manual: false, error: null, loadedAt: 0 };
    st.load = async ({ refresh = false, silent = false } = {}) => {
      if (st.loading) return;
      const bg = silent && Boolean(st.data);
      st.loading = true;
      st.manual = !bg;
      if (!bg) st.error = null;
      syncRefreshButton();
      if (!bg) paint();
      try {
        const data = await getJson(path, refresh ? { refresh: 'true' } : null);
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
        syncRefreshButton();
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

  function setMeta(id, html, tip) {
    const el = $(`${id}-meta`);
    if (!el) return;
    el.innerHTML = html;
    el.hidden = !html;
    if (tip !== undefined) el.title = tip;
  }

  // --- quota ------------------------------------------------------------------

  function quotaKey(d) {
    if (!d || typeof d !== 'object') return '';
    const { fetched_at: _f, ...rest } = d;
    return JSON.stringify(rest);
  }
  function quotaMetaHtml(data) {
    if (!data || data.error) return '';
    return [data.tier || data.plan, t('autoTag'), data.fetched_at ? fmtTime(data.fetched_at) : '']
      .filter(Boolean).map(esc).join(' · ');
  }
  const quota = makeLoader('/api/quota', QUOTA_STALE_MS, {
    paint: () => paintQuota(),
    keyOf: quotaKey,
    onMeta: (d) => setMeta('quota', quotaMetaHtml(d), d && d.fetched_at ? t('fetchedAt', fmtTime(d.fetched_at, true)) : ''),
    onSilent: () => paintQuota(),
  });
  const resetFired = new Set(); // reset_time ISO strings that already triggered a post-reset refresh
  let resetTimer = null;
  const fraction = (v) => (isNum(v) ? Math.min(1, Math.max(0, v)) : null);
  const levelOf = (f) => (f == null ? 'unknown' : f < 0.05 ? 'crit' : f < 0.2 ? 'warn' : '');
  const pctText = (f) => (f == null ? '—' : `${(f * 100).toFixed(f < 0.1 && f > 0 ? 1 : 0)}%`);
  const isUnlimited = (l) => l.kind === 'none' || (!l.reset_time && l.f != null && l.f >= 1);

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
      return `<div class="limit free"><div class="limit-head"><span>${esc(t('unlimited'))}</span></div></div>`;
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
      ? `<details class="more" data-key="${esc(key)}"${openKeys.has(key) ? ' open' : ''}><summary>${CHEV}<span>${esc(t('moreModels', hidden.length))}</span></summary><div class="tags">${hidden.map(tag).join('')}</div></details>`
      : '';
    return `<div class="pool">
      <div class="pool-label">${esc(label)}</div>
      ${limits.map((l) => limitHtml(l, limits.length === 1)).join('')}
      ${shownList.length ? `<div class="tags">${shownList.map(tag).join('')}</div>` : ''}
      ${more}
    </div>`;
  }

  function paintQuota() {
    const { data, error } = quota;
    let meta = '';
    let tip = '';
    let body = '';
    if (error) body = errorBox(t('requestFailed'), error);
    else if (!data) body = `<p class="empty"><span class="spin"></span>${esc(t('loading'))}</p>`;
    else if (data.error) {
      body = data.error === 'unavailable'
        ? errorBox(t('quotaUnavailable'), data.message || t('quotaUnavailableHint'))
        : errorBox(t('quotaFailed'), data.message || data.error);
    }
    if (data && !data.error) {
      meta = quotaMetaHtml(data);
      tip = data.fetched_at ? t('fetchedAt', fmtTime(data.fetched_at, true)) : '';
      const pools = Array.isArray(data.pools) ? data.pools : [];
      if (!error) body = pools.length ? pools.map(poolHtml).join('') : `<p class="empty">${esc(t('noPools'))}</p>`;
    }
    panes.quota.innerHTML = `<div id="quota-meta" class="meta num" title="${esc(tip)}"${meta ? '' : ' hidden'}>${meta}</div>${body}`;
  }

  function scheduleResetRefresh() {
    if (resetTimer) return;
    resetTimer = setTimeout(() => {
      resetTimer = null;
      if (tab === 'quota' && !document.hidden) quota.load({ refresh: true, silent: true });
    }, RESET_RETRY_MS);
  }

  function tickCountdowns() {
    if (tab !== 'quota' || document.hidden) return;
    const now = Date.now();
    panes.quota.querySelectorAll('[data-reset]').forEach((el) => {
      const iso = el.getAttribute('data-reset');
      if (!iso) return;
      el.textContent = resetText(iso);
      const d = parseDate(iso);
      if (d && d.getTime() <= now && !resetFired.has(iso)) {
        resetFired.add(iso);
        scheduleResetRefresh();
      }
    });
  }

  // --- history ----------------------------------------------------------------

  function historyKey(d) {
    if (!d || typeof d !== 'object') return '';
    const { scanned_at: _s, elapsed_ms: _e, ...rest } = d;
    return JSON.stringify(rest);
  }
  function historyMetaHtml(data, manualLoading) {
    if (!data || data.error) return '';
    if (manualLoading) return `<span class="spin"></span>${esc(t('scanning'))}`;
    if (!data.scanned_at) return esc(t('autoTag'));
    return `${esc(t('autoTag'))} · ${esc(fmtTime(data.scanned_at))}`;
  }
  function historyMetaTip(data) {
    return data && data.scanned_at ? t('scannedAt', fmtTime(data.scanned_at, true), data.elapsed_ms) : '';
  }
  function historySourcesText(data) {
    const src = (data && data.sources) || {};
    const foot = [t('sources', fmtInt(src.desktop), fmtInt(src.cli))];
    if (num(data && data.errors) > 0) foot.push(t('errors', fmtInt(data.errors)));
    return foot.join(' · ');
  }
  const history = makeLoader('/api/history', HISTORY_STALE_MS, {
    paint: () => paintHistory(),
    keyOf: historyKey,
    onMeta: (d) => setMeta('history', historyMetaHtml(d, false), historyMetaTip(d)),
    onSilent: (d) => onHistorySilent(d),
  });
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
  const newTok = (x) => num(x && x.input) + num(x && x.output);
  const allTok = (x) => newTok(x) + num(x && x.cache_read);
  const isSubagent = (c) => Boolean(c && (c.is_subagent || String(c.title || '').startsWith('@')));
  const tsOf = (iso) => { const d = parseDate(iso); return d ? d.getTime() : -Infinity; };
  const sourceLabel = (s) => (s && t('sourceNames')[s]) || s || '';

  function periodCutoff(p) {
    if (p === 'all') return -Infinity;
    const now = new Date();
    const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (p === 'today') return base.getTime();
    if (p === 'd7') { base.setDate(base.getDate() - 6); return base.getTime(); }
    if (p === 'd30') { base.setDate(base.getDate() - 29); return base.getTime(); }
    return -Infinity;
  }

  function historySubNav() {
    const btns = HISTORY_VIEWS.map((k) => {
      const on = k === historyView;
      return `<button class="seg-btn" type="button" role="tab" data-hview="${k}" aria-selected="${on}" tabindex="${on ? 0 : -1}">${esc(t('hviews')[k])}</button>`;
    }).join('');
    return `<div class="seg" role="tablist" aria-label="${esc(t('hviewAria'))}">${btns}</div>`;
  }

  function periodBar() {
    const pills = PERIODS.map((k) => {
      const on = k === period;
      return `<button class="pill" type="button" role="tab" data-period="${k}" aria-selected="${on}" tabindex="${on ? 0 : -1}">${esc(t('periodPills')[k])}</button>`;
    }).join('');
    return `<div class="period-bar" role="tablist" aria-label="${esc(t('periodBarAria'))}">${pills}</div>`;
  }

  function totalsHero(tot, partial) {
    const p = tot[period] || {};
    const costTip = partial ? `${t('refNote')}${t('sep')}${t('refPartial')}` : t('refNote');
    return `${periodBar()}
      <div class="hero">
        <div class="fig num" title="${esc(fmtInt(newTok(p)))}">${fmtTok(newTok(p))}<span class="unit">${esc(t('tokens'))}</span></div>
        <div class="sub">${esc(t('exclCache'))}</div>
      </div>
      <div class="hero-stats">
        <div><div class="lbl">${esc(t('legInput'))}</div><div class="v num" title="${esc(fmtInt(p.input))}">${fmtTok(p.input)}</div></div>
        <div><div class="lbl">${esc(t('legOutput'))}</div><div class="v num" title="${esc(fmtInt(p.output))}">${fmtTok(p.output)}</div></div>
        <div><div class="lbl">${esc(t('legCache'))}</div><div class="v num" title="${esc(fmtInt(p.cache_read))}">${fmtTok(p.cache_read)}</div></div>
        <div><div class="lbl">${esc(t('colCalls'))}</div><div class="v num">${fmtInt(p.calls)}</div></div>
        <div><div class="lbl">${esc(t('colConvs'))}</div><div class="v num">${fmtInt(p.conversations)}</div></div>
        <div><div class="lbl">${esc(t('colCost'))}<span class="help-mark" title="${esc(costTip)}" aria-label="${esc(costTip)}">?</span></div>
          <div class="v num">${costHtml(p.est_cost_usd, { partial, calls: p.calls, label: false })}</div></div>
      </div>`;
  }

  const parseDay = (s) => { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, (m || 1) - 1, d || 1); };
  const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  /** GitHub-style grid: weeks across, Sun..Sat down; compact 10–12 weeks when activity is recent, up to 20 weeks when older weeks have activity. */
  function heatmap(daily) {
    if (!Array.isArray(daily) || !daily.length) return '';
    const byDay = new Map(daily.map((d) => [d.date, d]));
    const end = parseDay(daily[daily.length - 1].date);
    if (Number.isNaN(end.getTime())) return '';
    const firstActive = daily.find((d) => num(d.tokens) > 0 || num(d.calls) > 0);
    const spanDays = firstActive ? Math.round((end - parseDay(firstActive.date)) / 86400000) + 1 : 0;
    const baseWeeks = (panes.history.clientWidth || 360) >= 420 ? 12 : HEAT_MIN_WEEKS;
    const need = firstActive ? Math.ceil((spanDays + (6 - end.getDay())) / 7) : 0;
    const weeks = Math.min(HEAT_MAX_WEEKS, Math.max(baseWeeks, need));
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
      if ((w === 0 || monthStart) && w - lastLabelCol >= 3 && w <= weeks - 2) {
        const m = (monthStart || first).toLocaleDateString(locale(), { month: 'short' });
        html += `<span class="ax" style="grid-row:1;grid-column:${w + 2} / span 3">${esc(m)}</span>`;
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

  /** Merge duplicate display names so raw model variants never clutter inline rows. */
  function mergeModels(list) {
    const map = new Map();
    for (const m of Array.isArray(list) ? list : []) {
      if (!m) continue;
      const name = String(m.display_name || m.model || '?').trim();
      let g = map.get(name);
      if (!g) {
        g = { name, ids: [], input: 0, output: 0, cache_read: 0, thinking: 0, calls: 0, est_cost_usd: null, partial: false };
        map.set(name, g);
      }
      if (m.model && !g.ids.includes(m.model)) g.ids.push(m.model);
      g.input += num(m.input);
      g.output += num(m.output);
      g.cache_read += num(m.cache_read);
      g.thinking += num(m.thinking);
      g.calls += num(m.calls);
      if (isNum(m.est_cost_usd)) g.est_cost_usd = (g.est_cost_usd || 0) + m.est_cost_usd;
      else if (num(m.calls) > 0) g.partial = true;
    }
    return [...map.values()].sort((a, b) => allTok(b) - allTok(a) || newTok(b) - newTok(a));
  }

  function byModel(list) {
    const merged = mergeModels(list);
    if (!merged.length) return `<section><h2>${esc(t('byModel'))}</h2><p class="note" style="margin:0">${esc(t('noModels'))}</p></section>`;
    const max = Math.max(1, ...merged.map(allTok));
    const seg = (v, cls) => (v > 0 ? `<span class="${cls}" style="width:${(v / max * 100).toFixed(2)}%"></span>` : '');
    const legend = `<div class="legend"><span><i class="seg-in"></i>${esc(t('legInput'))}</span><span><i class="seg-cache"></i>${esc(t('legCache'))}</span><span><i class="seg-out"></i>${esc(t('legOutput'))}</span></div>`;
    const visible = showAllModels ? merged : merged.slice(0, MODEL_VISIBLE);
    const rows = visible.map((m) => {
      const tip = `${m.ids.join(', ') || m.name}\n${t('ioLine', fmtInt(m.input), fmtInt(m.output), fmtInt(m.cache_read))}\n${t('calls', fmtInt(m.calls))}`;
      const cost = isNum(m.est_cost_usd) ? ` · ${m.partial ? '≥' : ''}${esc(fmtUsd(m.est_cost_usd))}` : '';
      return `<li title="${esc(tip)}">
        <div class="rh"><span class="ellipsis">${esc(m.name)}</span>
          <span class="rv num"><b>${fmtTok(newTok(m))}</b>${cost}</span></div>
        <div class="hbar">${seg(m.input, 'seg-in')}${seg(m.cache_read, 'seg-cache')}${seg(m.output, 'seg-out')}</div>
      </li>`;
    }).join('');
    const rest = merged.length - MODEL_VISIBLE;
    const toggle = rest > 0
      ? `<button type="button" class="quiet-btn" data-toggle-models aria-expanded="${showAllModels}">${CHEV}<span>${esc(showAllModels ? t('showLess') : t('showMoreModels', rest))}</span></button>`
      : '';
    return `<section><h2>${esc(t('byModel'))} <span class="hint">${esc(t('colTokens'))}</span></h2>${legend}<ul class="rank">${rows}</ul>${toggle}</section>`;
  }

  function convDetailHtml(c) {
    const totalIn = num(c.input) + num(c.cache_read);
    const hit = totalIn > 0 ? `${(num(c.cache_read) / totalIn * 100).toFixed(0)}%` : '—';
    const think = isNum(c.thinking) ? fmtTok(c.thinking) : '—';
    const first = c.first_at ? fmtTime(c.first_at, true) : '';
    const last = c.last_at ? fmtTime(c.last_at, true) : '';
    const spanText = first && last && first !== last ? t('span', first, last) : (last || first);
    const metaBits = [];
    if (c.source) metaBits.push(esc(sourceLabel(c.source)));
    if (isSubagent(c)) metaBits.push(esc(t('agentSub')));
    if (c.id) metaBits.push(`<span class="mono" title="${esc(c.id)}">${esc(String(c.id).slice(0, 8))}</span>`);
    const mergedModels = mergeModels(c.by_model);
    const models = mergedModels.length
      ? `<div class="conv-models"><div class="lbl">${esc(t('byModel'))}</div><ul class="mini">${mergedModels.map((m) => `<li>
          <span class="ellipsis" title="${esc(m.ids.join(', ') || m.name)}">${esc(m.name)}</span>
          <span class="num dim">${fmtTok(newTok(m))} · ${isNum(m.est_cost_usd) ? `${m.partial ? '≥' : ''}${esc(fmtUsd(m.est_cost_usd))}` : esc(t('calls', fmtInt(m.calls)))}</span>
        </li>`).join('')}</ul></div>`
      : '';
    return `<div class="conv-detail">
      <div class="conv-kv">
        <div><div class="lbl">${esc(t('legInput'))}</div><div class="v num" title="${esc(fmtInt(c.input))}">${fmtTok(c.input)}</div></div>
        <div><div class="lbl">${esc(t('legOutput'))}</div><div class="v num" title="${esc(fmtInt(c.output))}">${fmtTok(c.output)}</div></div>
        <div><div class="lbl">${esc(t('legCache'))}</div><div class="v num" title="${esc(fmtInt(c.cache_read))}">${fmtTok(c.cache_read)}</div></div>
        <div><div class="lbl">${esc(t('legThinking'))}</div><div class="v num" title="${isNum(c.thinking) ? esc(fmtInt(c.thinking)) : ''}">${think}</div></div>
        <div><div class="lbl">${esc(t('cacheHit'))}</div><div class="v num">${hit}</div></div>
        <div><div class="lbl">${esc(t('colCalls'))}</div><div class="v num">${fmtInt(c.calls)}</div></div>
      </div>
      <div class="conv-row"><span class="lbl">${esc(t('colCost'))}</span><span class="num">${costHtml(c.est_cost_usd, { partial: !!c.cost_partial, calls: c.calls })}</span></div>
      ${spanText ? `<div class="conv-foot num">${esc(spanText)}</div>` : ''}
      ${metaBits.length ? `<div class="conv-foot num">${metaBits.join(' · ')}</div>` : ''}
      ${models}
    </div>`;
  }

  function convItemHtml(c, i, maxTok) {
    const id = String(c.id || i);
    const key = `conv:${id}`;
    const title = c.title ? String(c.title) : '';
    const muted = !title || title.startsWith('@') || Boolean(c.is_subagent);
    const shown = title || `${t('untitled')} · ${id.slice(0, 8)}`;
    const subLeft = [c.display_name || c.model, fmtAgo(c.last_at)].filter(Boolean).join(' · ');
    const subRight = isNum(c.est_cost_usd)
      ? costHtml(c.est_cost_usd, { partial: !!c.cost_partial, calls: c.calls, label: false })
      : esc(t('calls', fmtInt(c.calls)));
    let bar = '';
    if (maxTok > 0) {
      const seg = (v, cls) => (v > 0 ? `<span class="${cls}" style="width:${(v / maxTok * 100).toFixed(2)}%"></span>` : '');
      bar = `<div class="hbar conv-bar">${seg(num(c.input), 'seg-in')}${seg(num(c.output), 'seg-out')}</div>`;
    }
    return `<li class="conv-item"><details data-key="${esc(key)}"${openKeys.has(key) ? ' open' : ''}>
      <summary class="conv-sum">
        <div class="conv-top">
          ${CHEV}
          <span class="conv-title ellipsis${muted ? ' dim' : ''}" title="${esc(shown)}">${esc(shown)}</span>
          <span class="conv-val num" title="${esc(fmtInt(newTok(c)))}">${fmtTok(newTok(c))}</span>
        </div>
        <div class="conv-meta"><span class="ellipsis">${esc(subLeft)}</span><span class="num">${subRight}</span></div>
        ${bar}
      </summary>
      ${convDetailHtml(c)}
    </details></li>`;
  }

  function summarizeConvs(list) {
    let tok = 0;
    let calls = 0;
    for (const c of list) { tok += newTok(c); calls += num(c.calls); }
    return `<div class="summary num">${esc(t('summaryLine', fmtInt(list.length), fmtTok(tok), fmtInt(calls)))}</div>`;
  }

  function sessionsViewHtml(data) {
    const all = Array.isArray(data.by_conversation) ? data.by_conversation : [];
    const pBtns = SESSION_PERIODS.map((k) => `<button class="fchip" type="button" data-speriod="${k}" aria-pressed="${k === sessionsPeriod}">${esc(t('shortPeriods')[k])}</button>`).join('');
    const subBtn = `<button class="fchip" type="button" data-hide-sub aria-pressed="${hideSubagents}">${esc(t('hideSubagents'))}</button>`;
    const controls = `<div class="filters"><div class="fgroup">${pBtns}</div>${subBtn}</div>`;
    const cutoff = periodCutoff(sessionsPeriod);
    const filtered = all.filter((c) => {
      if (hideSubagents && isSubagent(c)) return false;
      if (sessionsPeriod !== 'all') {
        const ts = tsOf(c.last_at);
        if (ts < cutoff) return false;
      }
      return true;
    }).sort((a, b) => newTok(b) - newTok(a) || tsOf(b.last_at) - tsOf(a.last_at) || String(a.id || '').localeCompare(String(b.id || '')));
    if (!filtered.length) {
      return controls + `<p class="empty">${esc(all.length ? t('noMatches') : t('noConversations'))}</p>`;
    }
    const maxTok = Math.max(1, newTok(filtered[0]));
    const legend = `<div class="legend" style="margin-top:12px"><span><i class="seg-in"></i>${esc(t('legInput'))}</span><span><i class="seg-out"></i>${esc(t('legOutput'))}</span></div>`;
    const rows = filtered.slice(0, sessionsLimit).map((c, i) => convItemHtml(c, i, maxTok)).join('');
    const rest = filtered.length - sessionsLimit;
    const more = rest > 0 ? `<button type="button" class="quiet-btn" data-more-sessions>${CHEV}<span>${esc(t('moreConvs', Math.min(rest, CONV_VISIBLE * 2)))}</span></button>` : '';
    return controls + summarizeConvs(filtered) + legend + `<ul class="conv-list">${rows}</ul>` + more;
  }

  function matchesQuery(c, q) {
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

  function hasCliSources(data) {
    const src = (data && data.sources) || {};
    if (num(src.cli) > 0) return true;
    const all = Array.isArray(data && data.by_conversation) ? data.by_conversation : [];
    return all.some((c) => c && c.source && c.source !== 'desktop');
  }

  function listBodyHtml(data) {
    const all = Array.isArray(data && data.by_conversation) ? data.by_conversation : [];
    const cli = hasCliSources(data);
    if (!cli && listSource !== 'all') listSource = 'all';
    const q = searchQuery.trim().toLowerCase();
    const filtered = all.filter((c) => {
      if (hideSubagents && isSubagent(c)) return false;
      if (listSource !== 'all' && (c.source || 'desktop') !== listSource) return false;
      return matchesQuery(c, q);
    }).sort((a, b) => {
      if (listSort === 'tokens') return newTok(b) - newTok(a) || tsOf(b.last_at) - tsOf(a.last_at);
      if (listSort === 'calls') return num(b.calls) - num(a.calls) || tsOf(b.last_at) - tsOf(a.last_at);
      return tsOf(b.last_at) - tsOf(a.last_at) || newTok(b) - newTok(a);
    });
    if (!filtered.length) {
      return `<p class="empty">${esc(all.length ? t('noMatches') : t('noConversations'))}</p>`;
    }
    const rows = filtered.slice(0, listLimit).map((c, i) => convItemHtml(c, i, 0)).join('');
    const rest = filtered.length - listLimit;
    const more = rest > 0 ? `<button type="button" class="quiet-btn" data-more-list>${CHEV}<span>${esc(t('moreConvs', Math.min(rest, CONV_VISIBLE * 2)))}</span></button>` : '';
    return summarizeConvs(filtered) + `<ul class="conv-list">${rows}</ul>` + more;
  }

  function listViewHtml(data) {
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
    if (historyView !== 'list' || !history.data || history.data.error) return;
    const body = $('history-list-body');
    if (body) body.innerHTML = listBodyHtml(history.data);
    const clr = $('history-search-clear');
    if (clr) clr.hidden = !searchQuery;
    panes.history.querySelectorAll('[data-hsort]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.hsort === listSort)));
    panes.history.querySelectorAll('[data-hsource]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.hsource === listSource)));
    panes.history.querySelectorAll('[data-hide-sub]').forEach((b) => b.setAttribute('aria-pressed', String(hideSubagents)));
  }

  function onHistorySilent(data) {
    if (historyView === 'list' && $('history-search') && $('history-list-body') && hasCliSources(data) === listHasCli) {
      setMeta('history', historyMetaHtml(data, false), historyMetaTip(data));
      updateListBody();
      const src = $('history-sources');
      if (src) src.textContent = historySourcesText(data);
      return;
    }
    const inp = $('history-search');
    const focused = inp && document.activeElement === inp;
    const selStart = focused ? inp.selectionStart : null;
    const selEnd = focused ? inp.selectionEnd : null;
    paintHistory();
    if (focused) {
      const next = $('history-search');
      if (next) {
        next.focus();
        if (selStart != null && selEnd != null) {
          try { next.setSelectionRange(selStart, selEnd); } catch { /* ignore */ }
        }
      }
    }
  }

  function paintHistory() {
    const { data, loading, manual, error } = history;
    let body = '';
    if (error) body = errorBox(t('requestFailed'), error);
    else if (!data) body = `<p class="empty"><span class="spin"></span>${esc(t('scanning'))}</p>`;
    else if (data.error) body = errorBox(t('historyFailed'), data.message || data.error);
    if (data && !data.error && !error) {
      const tot = data.totals || {};
      const partial = Array.isArray(data.by_model) && data.by_model.some((m) => num(m.calls) > 0 && !isNum(m.est_cost_usd));
      const meta = historyMetaHtml(data, loading && manual);
      let viewBody;
      if (historyView === 'sessions') viewBody = sessionsViewHtml(data);
      else if (historyView === 'list') viewBody = listViewHtml(data);
      else viewBody = totalsHero(tot, partial) + heatmap(data.daily) + byModel(data.by_model);
      body = `${historySubNav()}${viewBody}<footer id="history-footer"><span id="history-sources">${esc(historySourcesText(data))}</span><span id="history-meta" class="num" title="${esc(historyMetaTip(data))}">${meta}</span></footer>`;
    }
    panes.history.innerHTML = body;
  }

  function setHistoryView(next, focusBtn) {
    if (!HISTORY_VIEWS.includes(next) || next === historyView) return;
    historyView = next;
    store.set('ctx.historyView', historyView);
    paintHistory();
    if (focusBtn) {
      const btn = panes.history.querySelector(`.seg-btn[data-hview="${historyView}"]`);
      if (btn) btn.focus();
    }
  }

  function setPeriod(k, focusBtn) {
    if (!PERIODS.includes(k) || k === period) return;
    period = k;
    store.set('ctx.period', k);
    paintHistory();
    if (focusBtn) {
      const btn = panes.history.querySelector(`.pill[data-period="${k}"]`);
      if (btn) btn.focus();
    }
  }

  // --- tabs, language, lifecycle ---------------------------------------------

  function syncRefreshButton() {
    const btn = $('refresh');
    if (!btn) return;
    const busy = (tab === 'overview' && overviewSpin)
      || (tab === 'quota' && quota.loading)
      || (tab === 'history' && history.loading);
    btn.classList.toggle('busy', busy);
    btn.setAttribute('aria-busy', String(busy));
    const tip = t('refreshTip', tab === 'overview' ? 3 : 60);
    btn.title = tip;
    btn.setAttribute('aria-label', tip);
  }

  function applyStatic() {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.getAttribute('data-i18n')); });
    const pill = $('lang');
    if (pill) {
      pill.setAttribute('aria-label', t('langAria'));
      pill.querySelectorAll('[data-lang]').forEach((b) => {
        b.setAttribute('aria-pressed', String(b.dataset.lang === lang));
      });
    }
    syncRefreshButton();
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
    syncRefreshButton();
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

  function autoRefreshActive() {
    if (document.hidden) return;
    if (tab === 'quota' && quota.data) quota.load({ refresh: false, silent: true });
    else if (tab === 'history' && history.data) history.load({ refresh: false, silent: true });
  }

  function onWake() {
    if (document.hidden) return;
    if (tab === 'overview') { refreshReport(); return; }
    if (tab === 'quota') {
      tickCountdowns();
      if (quota.data && Date.now() - quota.loadedAt > QUOTA_STALE_MS) quota.load({ refresh: false, silent: true });
    } else if (tab === 'history') {
      if (history.data && Date.now() - history.loadedAt > HISTORY_STALE_MS) history.load({ refresh: false, silent: true });
    }
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
  $('refresh').addEventListener('click', () => {
    if (tab === 'overview') refreshReport({ force: true });
    else if (tab === 'quota') quota.load({ refresh: true, silent: false });
    else history.load({ refresh: true, silent: false });
  });
  $('lang').addEventListener('click', (e) => {
    const b = e.target.closest('[data-lang]');
    if (b && b.dataset.lang !== lang) setLang(b.dataset.lang);
  });
  document.addEventListener('click', (e) => {
    const hv = e.target.closest('[data-hview]');
    if (hv) { setHistoryView(hv.dataset.hview, false); return; }
    const sp = e.target.closest('[data-speriod]');
    if (sp) {
      if (SESSION_PERIODS.includes(sp.dataset.speriod) && sp.dataset.speriod !== sessionsPeriod) {
        sessionsPeriod = sp.dataset.speriod;
        sessionsLimit = CONV_VISIBLE;
        paintHistory();
      }
      return;
    }
    const hs = e.target.closest('[data-hsort]');
    if (hs) {
      if (LIST_SORTS.includes(hs.dataset.hsort) && hs.dataset.hsort !== listSort) {
        listSort = hs.dataset.hsort;
        listLimit = CONV_VISIBLE;
        updateListBody();
      }
      return;
    }
    const hsrc = e.target.closest('[data-hsource]');
    if (hsrc) {
      if (SOURCE_FILTERS.includes(hsrc.dataset.hsource) && hsrc.dataset.hsource !== listSource) {
        listSource = hsrc.dataset.hsource;
        listLimit = CONV_VISIBLE;
        updateListBody();
      }
      return;
    }
    if (e.target.closest('[data-hide-sub]')) {
      hideSubagents = !hideSubagents;
      if (historyView === 'list') { listLimit = CONV_VISIBLE; updateListBody(); }
      else { sessionsLimit = CONV_VISIBLE; paintHistory(); }
      return;
    }
    if (e.target.closest('#history-search-clear')) {
      searchQuery = '';
      listLimit = CONV_VISIBLE;
      const inp = $('history-search');
      if (inp) { inp.value = ''; inp.focus(); }
      updateListBody();
      return;
    }
    if (e.target.closest('[data-toggle-models]')) { showAllModels = !showAllModels; paintHistory(); return; }
    if (e.target.closest('[data-more-sessions]')) { sessionsLimit += CONV_VISIBLE * 2; paintHistory(); return; }
    if (e.target.closest('[data-more-list]')) { listLimit += CONV_VISIBLE * 2; updateListBody(); return; }
    const pBtn = e.target.closest('[data-period]');
    if (pBtn) setPeriod(pBtn.dataset.period, false);
  });
  panes.history.addEventListener('input', (e) => {
    if (e.target && e.target.id === 'history-search') {
      searchQuery = e.target.value;
      listLimit = CONV_VISIBLE;
      updateListBody();
    }
  });
  panes.history.addEventListener('keydown', (e) => {
    if (e.target && e.target.id === 'history-search' && e.key === 'Escape' && searchQuery) {
      e.preventDefault();
      searchQuery = '';
      listLimit = CONV_VISIBLE;
      e.target.value = '';
      updateListBody();
      return;
    }
    if (e.target.closest && e.target.closest('.seg') && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      const i = HISTORY_VIEWS.indexOf(historyView) + (e.key === 'ArrowRight' ? 1 : -1);
      setHistoryView(HISTORY_VIEWS[(i + HISTORY_VIEWS.length) % HISTORY_VIEWS.length], true);
      return;
    }
    if (e.target.closest && e.target.closest('.period-bar') && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      const i = PERIODS.indexOf(period) + (e.key === 'ArrowRight' ? 1 : -1);
      setPeriod(PERIODS[(i + PERIODS.length) % PERIODS.length], true);
    }
  });
  document.addEventListener('toggle', (e) => {
    const d = e.target;
    if (!d || !d.matches || !d.matches('details[data-key]')) return;
    if (d.open) openKeys.add(d.dataset.key); else openKeys.delete(d.dataset.key);
  }, true);
  document.addEventListener('visibilitychange', onWake);
  window.addEventListener('focus', onWake);

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
    setInterval(autoRefreshActive, AUTO_REFRESH_MS);
  }
  start();
})();
