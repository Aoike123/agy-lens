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
  const HEAT_ALL_MIN_WEEKS = 26;
  const HEAT_ALL_MAX_WEEKS = 52;
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
      median: (v) => `中位数 ${v} tok/s`, lastReply: (n) => `上次回复输出 ${n} tok`,
      thinkingNote: (a, b) => `，思考 ${a} · 回复 ${b}`, streamNote: (v) => `，流式 ${v}`,
      speedTip: (s, e, t, o) => `流式 ${s} tok/s · 端到端 ${e} tok/s · 首字 ${t} · 输出 ${o} tok`,
      bufTip: (e, tot) => `缓冲/短回复，未计入流式测速 · 端到端 ${e} tok/s · 总耗时 ${tot}`,
      bufFallback: '上次为缓冲输出 · 显示会话均值',
      tipStream: '输出 ÷ 流式耗时，已过滤缓冲突发',
      tipE2e: (v) => `输出 ÷ (首字延迟 + 流式耗时) · 均值 ${v} tok/s`,
      tipTtft: (v) => `请求到首个流式分片耗时，含排队与前置思考 · 均值 ${v}`,
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
      colPeriod: '时段', colTokens: 'Tokens', colCalls: '调用', colConvs: '对话', colCost: '估算费用',
      callsConvs: (c, n) => `${c} 次调用 · ${n} 个对话`, convsCount: (n) => `${n} 个对话`, calls: (n) => `${n} 次调用`,
      tokensNoCache: 'tokens，不含缓存读取', exclCache: '不含缓存读取',
      weeklyQuota: '周额度', d7Share: '近7天占比',
      liveSynced: '官方同步', liveWeeklyTip: '已从本地语言服务器自动同步官方周额度',
      liveWeeklyHead: (parts) => `官方周额度 · ${parts}`,
      liveWeeklyPart: (p, u) => `${p} 已用 ${u}`,
      calAction: '校准', calDone: '已校准', calClear: '清除', calSave: '保存',
      calTitle: '校准官方周额度剩余 %', calHint: '对照左下角 View Usage 弹窗填入',
      calTip: '点击对照 View Usage 弹窗校准周额度',
      poolShort: { gemini: 'Gemini', claude_gpt: 'Claude / GPT', other: '其他' },
      poolCompact: { gemini: 'Gemini', claude_gpt: 'Claude/GPT', other: '其他' },
      calPoolLeft: (p) => `${p} 周剩余 %`, calBarLabel: (p, u) => `${p} 周额度已用 ${u}`,
      ofD7: (p) => `占近7天已用 ${p}`, ofPoolQuota: (p) => `≈ 周额度 ${p}`, d7Zero: '近7天 0%',
      syncPrices: '同步官网价', syncingPrices: '同步中…', pricingBuiltin: '内置官网价',
      pricingSrc: (s) => `价格来源：${s}`,
      pricingEstNote: '预览模型按同系列公开价估算标 ≈',
      pricingPartialNote: '含无公开价调用，≥ 表示下限',
      byModel: '按模型', noModels: '暂无模型用量', showMoreModels: (n) => `展开其余 ${n} 个模型`, showLess: '收起',
      legInput: '输入', legCache: '缓存读取', legOutput: '输出', legThinking: '思考',
      activity: '活跃度', am: '上午', pm: '下午',
      hourTip: (h1, h2, tok, c) => `今日 ${h1}:00–${h2}:00 · ${tok} tok（含缓存）· ${c} 次调用`,
      activeHours: (n) => `今日活跃 ${n} 小时`, activeToday: (a) => (a ? '今日活跃' : '今日暂无活动'),
      activeDaysOf: (a, n) => `近 ${n} 天活跃 ${a} 天`, activeDays: (a, w) => `近 ${w} 周活跃 ${a} 天`,
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
      helpTip: '使用指南与指标说明', helpClose: '关闭',
      welcomeTitle: '欢迎使用 Pulse',
      welcomeSub: '100% 本地只读，刷新不消耗任何 Token，无需安装 Python。',
      welcomeItems: [
        ['概览', '当前对话的上下文占用、输出速度与本会话累计'],
        ['额度', '各模型池的每周限额与 5 小时重置倒计时'],
        ['历史', '全量用量统计、热力图、按会话与官网价估算'],
      ],
      welcomeDone: '知道了', welcomeGlossary: '指标说明',
      glossaryTitle: '指标说明与使用指南',
      glossaryItems: [
        ['原生窗口 vs 请求预算', '原生窗口是模型理论容量（如 1M）；超出「请求预算」（通常 256k）后，应用会自动裁剪较早历史。'],
        ['不含缓存读取', '总用量只统计新产生的「输入 + 输出」，缓存读取单独列出，避免重复计算虚高。'],
        ['流式速度 · 端到端 · 首字延迟', '流式速度已过滤短回复与缓冲突发；端到端 = 总输出 ÷ (首字延迟 + 流式耗时)。'],
        ['≈ 与 ≥ 标记', '≈ 表示同系列公开价估算（预览模型）或根据重置时间推断；≥ 表示包含无公开单价调用时的费用下限。'],
        ['隐私与自动刷新', '所有会话数据库仅以只读方式访问；仅在点击「同步官网价」时请求公开价格列表。概览每 3 秒更新，额度与历史每 65 秒静默刷新。'],
      ],
      noConvTitle: '先打开一个对话',
      noConvHint: '在左侧打开任意对话后，这里会实时显示它的上下文占用、输出速度和本会话统计。你也可以先看看：',
      noDbTitle: '新对话已就绪',
      noDbHint: '发送第一条消息后，这里会自动显示上下文占用、输出速度与本会话累计。',
      goQuota: '查看额度', goHistory: '查看历史',
      quotaTrouble: ['1. 确认已登录 Antigravity 账号', '2. 在插件管理中关闭再重新开启 Pulse', '3. 点击下方按钮重试'],
      retry: '立即重试',
      historyEmptyTitle: '还没有历史记录',
      historyEmptyHint: '聊几轮后，这里会自动汇总你的 Token 用量、活跃热力图与会话排行。',
      pricingSyncOk: (n, src) => `已同步 ${n} 个模型官网价（${src}）`,
      pricingSyncFail: '同步失败，继续使用内置官网价',
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
      median: (v) => `median ${v} tok/s`, lastReply: (n) => `Last reply ${n} tok`,
      thinkingNote: (a, b) => `, thinking ${a} · response ${b}`, streamNote: (v) => `, streamed in ${v}`,
      speedTip: (s, e, t, o) => `streaming ${s} tok/s · end to end ${e} tok/s · first token ${t} · output ${o} tok`,
      bufTip: (e, tot) => `Buffered burst (excluded from streaming rate) · e2e ${e} tok/s · total ${tot}`,
      bufFallback: 'Last reply buffered · showing session avg',
      tipStream: 'Output ÷ streaming duration, excluding buffered bursts',
      tipE2e: (v) => `Output ÷ (first token + streaming) · avg ${v} tok/s`,
      tipTtft: (v) => `Request to first streamed chunk, incl. queue & pre-thinking · avg ${v}`,
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
      colPeriod: 'Period', colTokens: 'Tokens', colCalls: 'Calls', colConvs: 'Conversations', colCost: 'Est. cost',
      callsConvs: (c, n) => `${c} calls · ${n} conversations`, convsCount: (n) => `${n} ${n === '1' ? 'conversation' : 'conversations'}`, calls: (n) => `${n} ${n === '1' ? 'call' : 'calls'}`,
      tokensNoCache: 'tokens, excluding cache reads', exclCache: 'excluding cache reads',
      weeklyQuota: 'Weekly quota', d7Share: '7d share',
      liveSynced: 'Live', liveWeeklyTip: 'Auto-synced from the local language server',
      liveWeeklyHead: (parts) => `Official weekly · ${parts}`,
      liveWeeklyPart: (p, u) => `${p} ${u} used`,
      calAction: 'Calibrate', calDone: 'Calibrated', calClear: 'Clear', calSave: 'Save',
      calTitle: 'Calibrate official weekly % left', calHint: 'Match the View Usage popup',
      calTip: 'Calibrate against the View Usage popup',
      poolShort: { gemini: 'Gemini', claude_gpt: 'Claude / GPT', other: 'Other' },
      poolCompact: { gemini: 'Gemini', claude_gpt: 'Claude/GPT', other: 'Other' },
      calPoolLeft: (p) => `${p} % left`, calBarLabel: (p, u) => `${p} weekly ${u} used`,
      ofD7: (p) => `${p} of 7d usage`, ofPoolQuota: (p) => `≈ ${p} weekly`, d7Zero: '0% in 7d',
      syncPrices: 'Sync prices', syncingPrices: 'Syncing…', pricingBuiltin: 'Built-in list prices',
      pricingSrc: (s) => `Prices: ${s}`,
      pricingEstNote: 'Preview models estimated from family list prices (≈)',
      pricingPartialNote: 'Includes unpriced calls (≥ lower bound)',
      byModel: 'By model', noModels: 'No model usage yet', showMoreModels: (n) => `Show ${n} more`, showLess: 'Show less',
      legInput: 'Input', legCache: 'Cache read', legOutput: 'Output', legThinking: 'Thinking',
      activity: 'Activity', am: 'AM', pm: 'PM',
      hourTip: (h1, h2, tok, c) => `Today ${h1}:00–${h2}:00 · ${tok} tok incl. cache · ${c} calls`,
      activeHours: (n) => `Active ${n}h today`, activeToday: (a) => (a ? 'Active today' : 'No activity today'),
      activeDaysOf: (a, n) => `Active ${a} / ${n} days`, activeDays: (a, w) => `Active ${a} days in ${w}w`,
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
      helpTip: 'Quick guide & glossary', helpClose: 'Close',
      welcomeTitle: 'Welcome to Pulse',
      welcomeSub: '100% local & read-only. Zero tokens per refresh, no Python needed.',
      welcomeItems: [
        ['Overview', 'Live context window, output speed and this-conversation totals'],
        ['Quota', 'Per-pool weekly and 5-hour limits with reset countdowns'],
        ['History', 'Totals, activity heatmap, per-session breakdown and pricing'],
      ],
      welcomeDone: 'Got it', welcomeGlossary: 'Glossary',
      glossaryTitle: 'Quick guide & glossary',
      glossaryItems: [
        ['Native window vs Request budget', 'The native window is the model capacity (e.g. 1M). Past the request budget (usually 256k), the app trims older history.'],
        ['Excluding cache reads', 'Headline totals count fresh input + output only; cached prompt reads are shown separately so numbers stay realistic.'],
        ['Streaming · End-to-end · TTFT', 'Streaming excludes tiny/buffered bursts. End-to-end divides output by (first-token wait + streaming time).'],
        ['≈ and ≥ markers', '≈ marks same-family price estimates (preview models) or inferred limit windows. ≥ marks a lower bound when some calls lack pricing.'],
        ['Privacy & auto-refresh', 'Conversation DBs are opened strictly read-only. Public pricing is fetched only when you click Sync prices. Overview updates every 3s; Quota & History every 65s.'],
      ],
      noConvTitle: 'Open a conversation first',
      noConvHint: 'Select any conversation in Antigravity to see its live context usage, output speed and session stats. Meanwhile you can inspect:',
      noDbTitle: 'New conversation ready',
      noDbHint: 'Send your first message and this panel will automatically populate context, speed and session usage.',
      goQuota: 'View Quota', goHistory: 'View History',
      quotaTrouble: ['1. Make sure you are signed in to Antigravity', '2. Toggle Pulse off and on under Customizations → Installed', '3. Click Retry below'],
      retry: 'Retry',
      historyEmptyTitle: 'No history yet',
      historyEmptyHint: 'Once you send a few messages, your token totals, heatmap and session rankings will appear here.',
      pricingSyncOk: (n, src) => `Synced ${n} model prices (${src})`,
      pricingSyncFail: 'Sync failed; using built-in list prices',
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
  function fmtPctNum(p) {
    if (!isNum(p) || p <= 0) return '0%';
    if (p < 0.1) return '<0.1%';
    if (p >= 100) return `${Math.round(p)}%`;
    const s = p.toFixed(1);
    return `${s.endsWith('.0') ? s.slice(0, -2) : s}%`;
  }
  function fmtUsd(v) {
    if (!isNum(v)) return '';
    if (v > 0 && v < 0.01) return '<$0.01';
    return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  function fmtCost(v, { estimated = false, partial = false } = {}) {
    if (!isNum(v)) return '';
    const prefix = partial ? '≥' : (estimated ? '≈' : '');
    return `${prefix}${fmtUsd(v)}`;
  }
  function pricingSourceName(src) {
    if (src === 'litellm') return 'LiteLLM';
    if (src === 'openrouter') return 'OpenRouter';
    return t('pricingBuiltin');
  }
  function pricingTip(src, fetchedAt, { partial = false } = {}) {
    const parts = [t('pricingSrc', pricingSourceName(src))];
    if (fetchedAt) parts.push(fmtTime(fetchedAt, true));
    parts.push(t('pricingEstNote'));
    if (partial) parts.push(t('pricingPartialNote'));
    return parts.join(' · ');
  }
  const budgetLevel = (ratio) => (ratio >= 0.95 ? 'crit' : ratio >= 0.8 ? 'warn' : '');
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
  function keepScroll(fn) {
    const y = window.scrollY;
    fn();
    if (window.scrollY !== y) window.scrollTo(0, y);
  }

  const CAL_POOLS = ['gemini', 'claude_gpt'];
  function clampPct(v) {
    if (v === '' || v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n * 10) / 10 : null;
  }
  function readWeeklyLeft() {
    try {
      const o = JSON.parse(store.get('ctx.weeklyLeft', '') || '{}');
      return { gemini: clampPct(o && o.gemini), claude_gpt: clampPct(o && o.claude_gpt) };
    } catch { return { gemini: null, claude_gpt: null }; }
  }
  let weeklyLeft = readWeeklyLeft();
  let calEditorOpen = false;
  let pricingSyncing = false;
  let pricingNotice = null; // { ok: boolean, text: string } | null
  let pricingNoticeTimer = null;
  let guideMode = store.get('ctx.onboarded', '') === '1' ? null : 'welcome'; // null | 'welcome' | 'glossary'
  const hasCal = () => weeklyLeft.gemini != null || weeklyLeft.claude_gpt != null;
  function setWeeklyLeft(next) {
    weeklyLeft = { gemini: clampPct(next && next.gemini), claude_gpt: clampPct(next && next.claude_gpt) };
    try {
      if (hasCal()) localStorage.setItem('ctx.weeklyLeft', JSON.stringify(weeklyLeft));
      else localStorage.removeItem('ctx.weeklyLeft');
    } catch { /* storage unavailable */ }
    calEditorOpen = false;
    if (history.data || history.loading || history.error) paintHistory();
  }
  function inferPool(id) {
    const s = String(id || '').toLowerCase();
    if (s.includes('gemini') || s.includes('orchestrator')) return 'gemini';
    if (s.includes('claude') || s.includes('gpt') || s.includes('openai')) return 'claude_gpt';
    return 'other';
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

  /** Recent calls as bars: streaming tok/s only (never e2e fallback); buffered bursts render as quiet stubs. */
  function trendBars(recent) {
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
        ${trendBars(s.recent)}
      </div>
      <div class="stats">
        <div title="${esc(t('tipE2e', fmtTps(s.avg_e2e_tps)))}"><div class="lbl">${esc(t('e2e'))}</div><div class="v num">${fmtTps(l.e2e_tps)}<span class="unit">tok/s</span></div></div>
        <div title="${esc(t('tipTtft', fmtSec(s.avg_ttft_sec)))}"><div class="lbl">${esc(t('ttft'))}</div><div class="v num">${fmtSec(l.ttft_sec)}</div></div>
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
    const costStr = fmtCost(s.est_cost_usd, { estimated: !!s.cost_estimated, partial: !!s.cost_partial });
    const costTip = pricingTip(s.pricing_source, null, { partial: !!s.cost_partial });
    const hd = history.data && !history.data.error ? history.data : null;
    let weeklyHtml = '';
    let poolRows = '';
    if (hd) {
      const sPools = s.d7_by_pool || {};
      const rawD7ByPool = hd.d7_by_pool || {};
      const d7ByPool = {};
      for (const pk of new Set([...Object.keys(rawD7ByPool), ...Object.keys(sPools)])) {
        d7ByPool[pk] = Math.max(num(rawD7ByPool[pk]), num(sPools[pk]));
      }
      const d7Total = Math.max(newTok(hd.totals && hd.totals.d7), num(s.d7_tokens));
      const sCtx = s.model || !(Array.isArray(s.by_model) && s.by_model[0])
        ? s
        : { ...s, model: s.by_model[0].model, display_name: s.by_model[0].display_name };
      const wTag = convWeeklyLabel(sCtx, d7Total, d7ByPool, { compact: false });
      if (wTag) {
        const primary = sCtx.pool || inferPool(sCtx.model || sCtx.display_name);
        const eff = effectiveWeekly(primary) || CAL_POOLS.map((k) => effectiveWeekly(k)).find(Boolean) || null;
        if (eff && eff.live) {
          weeklyHtml = `<div class="session-weekly dim num" title="${esc(t('liveWeeklyTip'))}">${esc(wTag)}</div>`;
        } else {
          weeklyHtml = `<button type="button" class="inline-link session-weekly num" data-go-tab="history" title="${esc(t('calTip'))}">${esc(wTag)}</button>`;
        }
      }
      const activePools = Object.keys(sPools).filter((k) => num(sPools[k]) > 0);
      const pn = t('poolShort');
      if (activePools.length > 1) {
        poolRows = `<div class="session-pools"><ul class="mini">${activePools.map((pk) => {
          const tok = num(sPools[pk]);
          const eff = effectiveWeekly(pk);
          const pt = num(d7ByPool[pk]);
          const lbl = eff != null && pt > 0 ? t('ofPoolQuota', fmtPctNum(tok / pt * eff.used)) : (d7Total > 0 ? t('ofD7', fmtPctNum(tok / d7Total * 100)) : '');
          return `<li><span class="dim">${esc(pn[pk] || pk)}</span><span class="num dim">${fmtTok(tok)}${lbl ? ` · ${esc(lbl)}` : ''}</span></li>`;
        }).join('')}</ul></div>`;
      }
    }
    const models = Array.isArray(s.by_model) && s.by_model.length > 1
      ? `<ul class="mini" style="margin-top:12px">${s.by_model.map((m) => {
        const mc = fmtCost(m.est_cost_usd, { estimated: !!m.cost_estimated });
        return `<li><span class="ellipsis" title="${esc(m.model || '')}">${esc(m.display_name || m.model || '?')}</span>`
          + `<span class="num dim">${fmtTok(num(m.input) + num(m.output))}${mc ? ` · ${esc(mc)}` : ` · ${esc(t('calls', fmtInt(m.calls)))}`}</span></li>`;
      }).join('')}</ul>`
      : '';
    const rightBits = [];
    if (costStr) rightBits.push(`<div class="session-cost num" title="${esc(costTip)}">${esc(costStr)}</div>`);
    if (weeklyHtml) rightBits.push(weeklyHtml);
    return `<section><h2>${esc(t('sessionTitle'))} <span class="hint">${esc(t('speedCalls', fmtInt(s.calls)))}</span></h2>
      <div class="session-head">
        <div><div class="fig num" title="${esc(fmtInt(total))}">${fmtTok(total)}<span class="unit">${esc(t('tokens'))}</span></div>
          <div class="lbl">${esc(t('exclCache'))}</div></div>
        ${rightBits.length ? `<div class="session-right">${rightBits.join('')}</div>` : ''}
      </div>
      <div class="stats">
        <div><div class="lbl">${esc(t('legInput'))}</div><div class="v num">${fmtTok(s.input)}</div></div>
        <div><div class="lbl">${esc(t('legOutput'))}</div><div class="v num">${fmtTok(s.output)}</div></div>
        <div><div class="lbl">${esc(t('legCache'))}</div><div class="v num">${fmtTok(s.cache_read)}</div></div>
      </div>
      ${poolRows}
      ${meta.length ? `<p class="note num">${esc(meta.join(' · '))}</p>` : ''}
      ${models}
    </section>`;
  }

  function renderOverview(r) {
    lastOverviewWeeklySig = overviewWeeklySig();
    ensureWeeklyForOverview();
    const limit = r.limit_tokens;
    keepScroll(() => {
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
    });
    $('copy').addEventListener('click', copy);
  }

  function showMessage(key, ...args) {
    report = null;
    lastJson = '';
    overviewMessage = [key, ...args];
    if (key === 'noConversation' || key === 'noDatabase') {
      const title = key === 'noConversation' ? t('noConvTitle') : t('noDbTitle');
      const hint = key === 'noConversation' ? t('noConvHint') : t('noDbHint');
      panes.overview.innerHTML = `<div class="guide-empty">
        <h3>${esc(title)}</h3><p>${esc(hint)}</p>
        <div class="guide-acts">
          <button type="button" class="guide-btn" data-go-tab="quota">${esc(t('goQuota'))}</button>
          <button type="button" data-go-tab="history">${esc(t('goHistory'))}</button>
        </div>
      </div>`;
      return;
    }
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
    paint: () => { paintQuota(); syncHistoryFromQuota(); syncOverviewWeekly(); },
    keyOf: quotaKey,
    onMeta: (d) => setMeta('quota', quotaMetaHtml(d), d && d.fetched_at ? t('fetchedAt', fmtTime(d.fetched_at, true)) : ''),
    onSilent: () => { paintQuota(); syncHistoryFromQuota(); syncOverviewWeekly(); },
  });
  let lastQuotaWeeklySig = '';
  function liveWeeklyEntry(pool) {
    const w = quota.data && !quota.data.error && quota.data.weekly;
    const e = w && w[pool];
    if (!e || !isNum(e.remaining_fraction)) return null;
    const f = Math.min(1, Math.max(0, e.remaining_fraction));
    const left = Math.round(f * 1000) / 10;
    return { left, used: Math.round((100 - left) * 10) / 10, reset_time: e.reset_time || null, live: true };
  }
  function effectiveWeekly(pool) {
    const live = liveWeeklyEntry(pool);
    if (live) return live;
    if (weeklyLeft[pool] != null) {
      const left = weeklyLeft[pool];
      return { left, used: Math.round((100 - left) * 10) / 10, reset_time: null, live: false };
    }
    return null;
  }
  const hasAnyWeekly = () => CAL_POOLS.some((k) => effectiveWeekly(k) != null);
  function syncHistoryFromQuota() {
    const w = (quota.data && !quota.data.error && quota.data.weekly) || {};
    const sig = JSON.stringify(CAL_POOLS.map((k) => w[k] || null));
    if (sig === lastQuotaWeeklySig) return;
    lastQuotaWeeklySig = sig;
    if (tab === 'history' && history.data && !history.data.error) onHistorySilent(history.data);
  }
  function ensureQuotaForHistory(force = false) {
    if (quota.loading) return;
    if (force || !quota.data || Date.now() - quota.loadedAt > QUOTA_STALE_MS) {
      quota.load({ refresh: force, silent: true });
    }
  }
  let lastOverviewWeeklySig = '';
  let lastOverviewHistoryTry = 0;
  let lastOverviewQuotaTry = 0;
  function overviewWeeklySig() {
    const hd = typeof history !== 'undefined' && history.data && !history.data.error ? history.data : null;
    const d7Total = hd ? newTok(hd.totals && hd.totals.d7) : -1;
    const d7ByPool = (hd && hd.d7_by_pool) || {};
    const poolSig = CAL_POOLS.map((k) => num(d7ByPool[k])).join(',');
    const effSig = CAL_POOLS.map((k) => {
      const e = effectiveWeekly(k);
      return e ? `${e.used}:${e.live ? 1 : 0}` : 'n';
    }).join('|');
    const sesSig = report && report.session ? `${report.session.calls}:${num(report.session.d7_tokens)}` : '';
    return `${d7Total}|${poolSig}|${effSig}|${sesSig}`;
  }
  function ensureWeeklyForOverview() {
    if (tab !== 'overview' || !report || !report.session || !num(report.session.calls)) return;
    if (typeof history === 'undefined') return;
    const now = Date.now();
    if (!history.loading) {
      const hasErr = Boolean(history.error || (history.data && history.data.error));
      const stale = !history.data || hasErr || now - history.loadedAt > HISTORY_STALE_MS;
      const cooldown = hasErr ? 60000 : 15000;
      if (stale && now - lastOverviewHistoryTry > cooldown) {
        lastOverviewHistoryTry = now;
        history.load({ refresh: false, silent: true });
      }
    }
    if (!quota.loading) {
      const hasErr = Boolean(quota.error || (quota.data && quota.data.error));
      const stale = !quota.data || hasErr || now - quota.loadedAt > QUOTA_STALE_MS;
      const cooldown = hasErr ? 60000 : 15000;
      if (stale && now - lastOverviewQuotaTry > cooldown) {
        lastOverviewQuotaTry = now;
        quota.load({ refresh: false, silent: true });
      }
    }
  }
  function syncOverviewWeekly() {
    if (tab !== 'overview' || !report || !report.session || !num(report.session.calls)) return;
    const sig = overviewWeeklySig();
    if (sig === lastOverviewWeeklySig) return;
    renderOverview(report);
  }
  const resetFired = new Set(); // reset_time ISO strings that already triggered a post-reset refresh
  let resetTimer = null;
  const fraction = (v) => (isNum(v) ? Math.min(1, Math.max(0, v)) : null);
  const levelOf = (f) => (f == null ? 'unknown' : f < 0.05 ? 'crit' : f < 0.2 ? 'warn' : '');
  const pctText = (f) => {
    if (f == null) return '—';
    const p = f * 100;
    if (p > 0 && p < 10) {
      const s = p.toFixed(1);
      return `${s.endsWith('.0') ? s.slice(0, -2) : s}%`;
    }
    return `${Math.round(p)}%`;
  };
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
      meta = quotaMetaHtml(data);
      tip = data.fetched_at ? t('fetchedAt', fmtTime(data.fetched_at, true)) : '';
      const pools = Array.isArray(data.pools) ? data.pools : [];
      if (!error) body = pools.length ? pools.map(poolHtml).join('') : `<p class="empty">${esc(t('noPools'))}</p>`;
    }
    keepScroll(() => {
      panes.quota.innerHTML = `<div id="quota-meta" class="meta num" title="${esc(tip)}"${meta ? '' : ' hidden'}>${meta}</div>${body}`;
    });
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
    paint: () => { paintHistory(); syncOverviewWeekly(); },
    keyOf: historyKey,
    onMeta: (d) => setMeta('history', historyMetaHtml(d, false), historyMetaTip(d)),
    onSilent: (d) => { onHistorySilent(d); syncOverviewWeekly(); },
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

  function periodRow(data) {
    const pills = PERIODS.map((k) => {
      const on = k === period;
      return `<button class="pill" type="button" role="tab" data-period="${k}" aria-selected="${on}" tabindex="${on ? 0 : -1}">${esc(t('periodPills')[k])}</button>`;
    }).join('');
    const tip = pricingTip(data && data.pricing_source, data && data.pricing_fetched_at);
    const sync = `<button class="sync-btn" type="button" data-sync-prices ${pricingSyncing ? 'disabled' : ''} title="${esc(tip)}">${pricingSyncing ? `<span class="spin"></span>${esc(t('syncingPrices'))}` : esc(t('syncPrices'))}</button>`;
    return `<div class="period-row"><div class="period-bar" role="tablist" aria-label="${esc(t('periodBarAria'))}">${pills}</div>${sync}</div>`;
  }

  function calEditorHtml() {
    const editable = CAL_POOLS.filter((k) => !liveWeeklyEntry(k));
    if (!calEditorOpen || !editable.length) return '';
    const pn = t('poolShort');
    const field = (k) => `<label class="cal-field"><span class="lbl">${esc(t('calPoolLeft', pn[k]))}</span>
      <span class="cal-input-row"><input id="cal-${k}" class="budget-input cal-input num" type="number" min="0" max="100" step="1" value="${weeklyLeft[k] != null ? esc(weeklyLeft[k]) : ''}" placeholder="0–100"><span class="dim">%</span></span></label>`;
    const clear = hasCal() ? `<button type="button" data-cal-clear>${esc(t('calClear'))}</button>` : '';
    return `<div class="budget-ed">
      <div class="lbl">${esc(t('calTitle'))}</div>
      <div class="cal-hint">${esc(t('calHint'))}</div>
      <div class="cal-grid">${editable.map(field).join('')}</div>
      <div class="cal-acts"><button type="button" class="budget-save" data-cal-save>${esc(t('calSave'))}</button>${clear}</div>
    </div>`;
  }

  function totalsHero(data) {
    const tot = data.totals || {};
    const p = tot[period] || {};
    const d7Total = newTok(tot.d7);
    const todayTotal = newTok(tot.today);
    const costPartial = Boolean(p.cost_partial)
      || (period === 'all' && Array.isArray(data.by_model) && data.by_model.some((m) => num(m.calls) > 0 && !isNum(m.est_cost_usd)));
    const costStr = fmtCost(p.est_cost_usd, { estimated: !!p.cost_estimated, partial: costPartial && isNum(p.est_cost_usd) });
    const costTip = pricingTip(data.pricing_source, data.pricing_fetched_at, { partial: costPartial });
    const pn = t('poolShort');
    const pc = t('poolCompact');
    const entries = CAL_POOLS.map((k) => ({ k, eff: effectiveWeekly(k) })).filter((x) => x.eff != null);
    const liveEntries = entries.filter((x) => x.eff.live);
    const allLive = liveEntries.length === CAL_POOLS.length;
    const manualOnly = entries.filter((x) => !x.eff.live);
    let quotaLbl = t('weeklyQuota');
    let quotaVal;
    if (allLive) {
      const worst = Math.max(...liveEntries.map((x) => x.eff.used));
      const lvl = budgetLevel(worst / 100);
      const cls = lvl === 'crit' ? ' txt-crit' : lvl === 'warn' ? ' txt-warn' : '';
      quotaVal = `<span class="num${cls}" title="${esc(t('liveWeeklyTip'))}">${esc(t('liveSynced'))}</span>`;
    } else if (manualOnly.length) {
      const worst = Math.max(...entries.map((x) => x.eff.used));
      const lvl = budgetLevel(worst / 100);
      const cls = lvl === 'crit' ? ' txt-crit' : lvl === 'warn' ? ' txt-warn' : ' on';
      const txt = manualOnly.length === 1 && !liveEntries.length
        ? `${pn[manualOnly[0].k]} ${fmtPctNum(manualOnly[0].eff.used)}`
        : t('calDone');
      quotaVal = `<button type="button" class="inline-link num${cls}" data-toggle-cal title="${esc(t('calTip'))}">${esc(txt)}</button>`;
    } else if (!entries.length && period === 'today' && d7Total > 0) {
      quotaLbl = t('d7Share');
      quotaVal = `<button type="button" class="inline-link num on" data-toggle-cal title="${esc(t('calTip'))}">${esc(fmtPctNum(todayTotal / d7Total * 100))}</button>`;
    } else {
      quotaVal = `<button type="button" class="inline-link" data-toggle-cal title="${esc(t('calTip'))}">${esc(t('calAction'))}</button>`;
    }
    let barsHtml = '';
    if (entries.length) {
      const liveHead = liveEntries.length
        ? `<div class="wbudget-cap num" title="${esc(t('liveWeeklyTip'))}">${esc(t('liveWeeklyHead', liveEntries.map((x) => t('liveWeeklyPart', pc[x.k], fmtPctNum(x.eff.used))).join(' · ')))}</div>`
        : '';
      const items = entries.map(({ k, eff }) => {
        const usedPct = Math.max(0, Math.min(100, eff.used));
        const lvl = budgetLevel(usedPct / 100);
        const leftTxt = eff.live ? pn[k] : t('calBarLabel', pn[k], fmtPctNum(usedPct));
        const resetBit = eff.live && eff.reset_time ? resetText(eff.reset_time) : '';
        const rightTxt = [resetBit, `${t('remaining')} ${fmtPctNum(eff.left)}`].filter(Boolean).join(' · ');
        const resetTitle = eff.live && eff.reset_time ? t('resetAt', fmtTime(eff.reset_time, true)) : '';
        return `<div><div class="wbudget-head num"><span>${esc(leftTxt)}</span><span${resetTitle ? ` title="${esc(resetTitle)}"` : ''}>${esc(rightTxt)}</span></div>
          <div class="wbar ${lvl}" role="progressbar" aria-label="${esc(t('calBarLabel', pn[k], fmtPctNum(usedPct)))}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(usedPct)}">
            <span style="width:${usedPct.toFixed(1)}%"></span></div></div>`;
      }).join('');
      barsHtml = `<div class="wbudget">${liveHead}${items}</div>`;
    }
    const syncNote = pricingNotice
      ? `<div id="history-sync-note" class="sync-note ${pricingNotice.ok ? 'ok' : 'err'}">${esc(pricingNotice.text)}</div>`
      : '<div id="history-sync-note" class="sync-note" hidden></div>';
    return `${periodRow(data)}${syncNote}
      <div class="hero">
        <div class="fig num" title="${esc(fmtInt(newTok(p)))}">${fmtTok(newTok(p))}<span class="unit">${esc(t('tokens'))}</span></div>
        <div class="sub num">${esc(t('exclCache'))} · ${esc(t('convsCount', fmtInt(p.conversations)))}</div>
      </div>
      <div class="hero-stats">
        <div><div class="lbl">${esc(t('legInput'))}</div><div class="v num" title="${esc(fmtInt(p.input))}">${fmtTok(p.input)}</div></div>
        <div><div class="lbl">${esc(t('legOutput'))}</div><div class="v num" title="${esc(fmtInt(p.output))}">${fmtTok(p.output)}</div></div>
        <div><div class="lbl">${esc(t('legCache'))}</div><div class="v num" title="${esc(fmtInt(p.cache_read))}">${fmtTok(p.cache_read)}</div></div>
        <div><div class="lbl">${esc(t('colCalls'))}</div><div class="v num">${fmtInt(p.calls)}</div></div>
        <div title="${esc(costTip)}"><div class="lbl">${esc(t('colCost'))}</div><div class="v num">${costStr ? esc(costStr) : '<span class="dim">—</span>'}</div></div>
        <div><div class="lbl">${esc(quotaLbl)}</div><div class="v">${quotaVal}</div></div>
      </div>
      ${barsHtml}<div id="history-cal">${calEditorHtml()}</div>`;
  }

  const parseDay = (s) => { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, (m || 1) - 1, d || 1); };
  const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  function makeHeatScale(values) {
    const nz = values.filter((v) => v > 0).sort((a, b) => a - b);
    if (!nz.length) return () => 0;
    const q = (p) => nz[Math.min(nz.length - 1, Math.floor(p * nz.length))];
    const cuts = [q(0.25), q(0.5), q(0.75)];
    return (v) => (v <= 0 ? 0 : v <= cuts[0] ? 1 : v <= cuts[1] ? 2 : v <= cuts[2] ? 3 : 4);
  }

  function heatFooter(summary) {
    const scale = `<span class="scale"><span class="t">${esc(t('less'))}</span>${[0, 1, 2, 3, 4].map((l) => `<span class="cell l${l}"></span>`).join('')}<span class="t">${esc(t('more'))}</span></span>`;
    return `<div class="heat-foot"><span>${esc(summary)}</span>${scale}</div>`;
  }

  function heatmapToday(data) {
    const hours = Array.isArray(data.hourly_today) && data.hourly_today.length ? data.hourly_today : null;
    if (!hours) {
      const daily = Array.isArray(data.daily) ? data.daily : [];
      const last = daily[daily.length - 1];
      if (!last) return '';
      const active = num(last.tokens) > 0 || num(last.calls) > 0;
      const tip = t('dayTip', last.date, fmtInt(last.tokens), fmtInt(last.calls));
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
      const tip = t('hourTip', h1, h2, fmtInt(e.tokens), fmtInt(e.calls));
      html += `<span class="cell l${level(num(e.tokens))}" style="grid-row:${r};grid-column:${c}" title="${esc(tip)}"></span>`;
    }
    html += '<span class="ax" style="grid-row:4;grid-column:2 / span 2">12</span>'
      + '<span class="ax" style="grid-row:4;grid-column:8 / span 2">18</span>'
      + '<span class="ax r" style="grid-row:4;grid-column:12 / span 2">23</span>';
    return `<section><h2>${esc(t('activity'))}</h2><div class="heat heat-hours">${html}</div>${heatFooter(t('activeHours', active))}</section>`;
  }

  function heatmapD7(daily) {
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
      const tip = t('dayTip', `${e.date} ${w}`, fmtInt(e.tokens), fmtInt(e.calls));
      return `<div class="d7-item${isToday ? ' today' : ''}" title="${esc(tip)}">
        <span class="cell l${level(num(e.tokens))}"></span>
        <span class="d7-lbl">${esc(w)}<b>${esc(dayNum)}</b></span>
      </div>`;
    }).join('');
    return `<section><h2>${esc(t('activity'))}</h2><div class="heat-d7">${tiles}</div>${heatFooter(t('activeDaysOf', active, slice.length))}</section>`;
  }

  function heatmapD30(daily) {
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
        const tip = t('dayTip', `${dayKey(d)} ${wd[d.getDay()]}`, fmtInt(e.tokens), fmtInt(e.calls));
        html += `<span class="cell l${level(num(e.tokens))}" style="${style}" title="${esc(tip)}"></span>`;
      }
    }
    return `<section><h2>${esc(t('activity'))}</h2><div class="heat heat-d30">${html}</div>${heatFooter(t('activeDaysOf', active, 30))}</section>`;
  }

  function heatmapAll(daily) {
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
    const cls = weeks > 32 ? 'heat heat-all dense' : 'heat heat-all';
    return `<section><h2>${esc(t('activity'))}</h2>
      <div class="${cls}" style="grid-template-columns:auto repeat(${weeks}, minmax(0, 1fr))">${html}</div>
      ${heatFooter(t('activeDays', active, weeks))}</section>`;
  }

  /** Period-adaptive activity heatmap: Today (24h), 7d (7 tiles), 30d (calendar weeks), All (26–52w). */
  function heatmap(data) {
    if (period === 'today') return heatmapToday(data);
    const daily = Array.isArray(data && data.daily) ? data.daily : [];
    if (!daily.length) return '';
    if (period === 'd7') return heatmapD7(daily);
    if (period === 'd30') return heatmapD30(daily);
    return heatmapAll(daily);
  }

  /** Estimate an item's weekly quota % (live official or calibrated fallback) or 7d usage share %. */
  function modelWeeklyLabel(m, d7Total, d7ByPool, { compact = true } = {}) {
    const d7 = isNum(m && m.d7_tokens) ? m.d7_tokens : newTok(m);
    const pool = (m && m.pool) || inferPool((m && m.ids && m.ids[0]) || (m && m.name));
    if (d7 <= 0) return compact ? '' : t('d7Zero');
    const eff = effectiveWeekly(pool);
    const poolTotal = num(d7ByPool && d7ByPool[pool]);
    if (eff != null && poolTotal > 0) return t('ofPoolQuota', fmtPctNum(d7 / poolTotal * eff.used));
    if (d7Total > 0) return t('ofD7', fmtPctNum(d7 / d7Total * 100));
    return compact ? '' : t('d7Zero');
  }

  function convWeeklyLabel(c, d7Total, d7ByPool, { compact = true } = {}) {
    const d7 = isNum(c && c.d7_tokens) ? c.d7_tokens : newTok(c);
    if (d7 <= 0) return compact ? '' : t('d7Zero');
    const primary = (c && c.pool) || inferPool((c && c.model) || (c && c.display_name));
    const cPools = (c && c.d7_by_pool) || null;
    const primaryD7 = cPools && isNum(cPools[primary]) ? cPools[primary] : d7;
    const effPrimary = effectiveWeekly(primary);
    if (effPrimary != null && num(d7ByPool && d7ByPool[primary]) > 0 && primaryD7 > 0) {
      return t('ofPoolQuota', fmtPctNum(primaryD7 / num(d7ByPool[primary]) * effPrimary.used));
    }
    if (cPools) {
      let best = null;
      let bestEff = null;
      for (const pk of CAL_POOLS) {
        const eff = effectiveWeekly(pk);
        if (eff != null && num(cPools[pk]) > 0 && num(d7ByPool && d7ByPool[pk]) > 0) {
          if (!best || num(cPools[pk]) > num(cPools[best])) { best = pk; bestEff = eff; }
        }
      }
      if (best) return t('ofPoolQuota', fmtPctNum(num(cPools[best]) / num(d7ByPool[best]) * bestEff.used));
    }
    if (d7Total > 0) return t('ofD7', fmtPctNum(d7 / d7Total * 100));
    return compact ? '' : t('d7Zero');
  }

  /** Merge duplicate display names so raw model variants never clutter inline rows. */
  function mergeModels(list) {
    const map = new Map();
    for (const m of Array.isArray(list) ? list : []) {
      if (!m) continue;
      const name = String(m.display_name || m.model || '?').trim();
      let g = map.get(name);
      if (!g) {
        g = { name, ids: [], pool: m.pool || inferPool(m.model || name), input: 0, output: 0, cache_read: 0, thinking: 0, calls: 0, d7_tokens: null, est_cost_usd: null, cost_estimated: false, cost_partial: false };
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
    }
    return [...map.values()].sort((a, b) => allTok(b) - allTok(a) || newTok(b) - newTok(a));
  }

  function byModel(data) {
    const merged = mergeModels(data.by_model);
    if (!merged.length) return `<section id="history-models"><h2>${esc(t('byModel'))}</h2><p class="note" style="margin:0">${esc(t('noModels'))}</p></section>`;
    const d7Total = newTok(data.totals && data.totals.d7);
    const d7ByPool = data.d7_by_pool || {};
    const max = Math.max(1, ...merged.map(allTok));
    const seg = (v, cls) => (v > 0 ? `<span class="${cls}" style="width:${(v / max * 100).toFixed(2)}%"></span>` : '');
    const legend = `<div class="legend"><span><i class="seg-in"></i>${esc(t('legInput'))}</span><span><i class="seg-cache"></i>${esc(t('legCache'))}</span><span><i class="seg-out"></i>${esc(t('legOutput'))}</span></div>`;
    const visible = showAllModels ? merged : merged.slice(0, MODEL_VISIBLE);
    const rows = visible.map((m) => {
      const wTag = modelWeeklyLabel(m, d7Total, d7ByPool, { compact: true });
      const costStr = fmtCost(m.est_cost_usd, { estimated: m.cost_estimated, partial: m.cost_partial && isNum(m.est_cost_usd) });
      const tip = `${m.ids.join(', ') || m.name}\n${t('ioLine', fmtInt(m.input), fmtInt(m.output), fmtInt(m.cache_read))}\n${t('calls', fmtInt(m.calls))}`;
      const subRight = costStr || t('calls', fmtInt(m.calls));
      return `<li title="${esc(tip)}">
        <div class="rh"><span class="ellipsis">${esc(m.name)}</span>
          <span class="rv num"><b>${fmtTok(newTok(m))}</b></span></div>
        <div class="rmeta num"><span>${esc(wTag || t('calls', fmtInt(m.calls)))}</span><span>${wTag ? esc(subRight) : (costStr ? esc(costStr) : '')}</span></div>
        <div class="hbar">${seg(m.input, 'seg-in')}${seg(m.cache_read, 'seg-cache')}${seg(m.output, 'seg-out')}</div>
      </li>`;
    }).join('');
    const rest = merged.length - MODEL_VISIBLE;
    const toggle = rest > 0
      ? `<button type="button" class="quiet-btn" data-toggle-models aria-expanded="${showAllModels}">${CHEV}<span>${esc(showAllModels ? t('showLess') : t('showMoreModels', rest))}</span></button>`
      : '';
    const hint = `${t('colTokens')} · ${hasAnyWeekly() ? t('weeklyQuota') : t('d7Share')}`;
    return `<section id="history-models"><h2>${esc(t('byModel'))} <span class="hint">${esc(hint)}</span></h2>${legend}<ul class="rank">${rows}</ul>${toggle}</section>`;
  }

  function convDetailHtml(c, data) {
    const d7Total = newTok(data && data.totals && data.totals.d7);
    const d7ByPool = (data && data.d7_by_pool) || {};
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
    const costStr = fmtCost(c.est_cost_usd, { estimated: !!c.cost_estimated, partial: !!c.cost_partial && isNum(c.est_cost_usd) });
    const costTip = pricingTip(data && data.pricing_source, data && data.pricing_fetched_at, { partial: !!c.cost_partial });
    const costRow = costStr
      ? `<div class="conv-row"><span class="lbl">${esc(t('colCost'))}</span><span class="num" title="${esc(costTip)}">${esc(costStr)}</span></div>`
      : '';
    const wLabel = hasAnyWeekly() ? t('weeklyQuota') : t('d7Share');
    const wVal = convWeeklyLabel(c, d7Total, d7ByPool, { compact: false });
    const cPools = c.d7_by_pool || {};
    const activePools = Object.keys(cPools).filter((k) => num(cPools[k]) > 0);
    const pn = t('poolShort');
    const poolRows = activePools.length > 1
      ? `<div class="conv-models"><ul class="mini">${activePools.map((pk) => {
        const tok = num(cPools[pk]);
        const eff = effectiveWeekly(pk);
        const pt = num(d7ByPool[pk]);
        const lbl = eff != null && pt > 0 ? t('ofPoolQuota', fmtPctNum(tok / pt * eff.used)) : (d7Total > 0 ? t('ofD7', fmtPctNum(tok / d7Total * 100)) : '');
        return `<li><span class="dim">${esc(pn[pk] || pk)}</span><span class="num dim">${fmtTok(tok)}${lbl ? ` · ${esc(lbl)}` : ''}</span></li>`;
      }).join('')}</ul></div>`
      : '';
    const mergedModels = mergeModels(c.by_model);
    const models = mergedModels.length
      ? `<div class="conv-models"><div class="lbl">${esc(t('byModel'))}</div><ul class="mini">${mergedModels.map((m) => {
        const mc = fmtCost(m.est_cost_usd, { estimated: m.cost_estimated, partial: m.cost_partial && isNum(m.est_cost_usd) });
        return `<li><span class="ellipsis" title="${esc(m.ids.join(', ') || m.name)}">${esc(m.name)}</span>
          <span class="num dim">${fmtTok(newTok(m))}${mc ? ` · ${esc(mc)}` : ` · ${esc(t('calls', fmtInt(m.calls)))}`}</span></li>`;
      }).join('')}</ul></div>`
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
      ${costRow}
      <div class="conv-row"><span class="lbl">${esc(wLabel)}</span><span class="num">${esc(wVal)}</span></div>
      ${poolRows}
      ${spanText ? `<div class="conv-foot num">${esc(spanText)}</div>` : ''}
      ${metaBits.length ? `<div class="conv-foot num">${metaBits.join(' · ')}</div>` : ''}
      ${models}
    </div>`;
  }

  function convItemHtml(c, i, maxTok, data) {
    const id = String(c.id || i);
    const key = `conv:${id}`;
    const title = c.title ? String(c.title) : '';
    const muted = !title || title.startsWith('@') || Boolean(c.is_subagent);
    const shown = title || `${t('untitled')} · ${id.slice(0, 8)}`;
    const subLeft = [c.display_name || c.model, fmtAgo(c.last_at)].filter(Boolean).join(' · ');
    const d7Total = newTok(data && data.totals && data.totals.d7);
    const d7ByPool = (data && data.d7_by_pool) || {};
    const wTag = convWeeklyLabel(c, d7Total, d7ByPool, { compact: true });
    const costStr = fmtCost(c.est_cost_usd, { estimated: !!c.cost_estimated, partial: !!c.cost_partial && isNum(c.est_cost_usd) });
    const rightBits = [];
    if (costStr) rightBits.push(costStr);
    if (wTag) rightBits.push(wTag);
    if (!rightBits.length) rightBits.push(t('calls', fmtInt(c.calls)));
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
        <div class="conv-meta"><span class="ellipsis">${esc(subLeft)}</span><span class="num">${esc(rightBits.join(' · '))}</span></div>
        ${bar}
      </summary>
      ${convDetailHtml(c, data)}
    </details></li>`;
  }

  function summarizeConvs(list) {
    let tok = 0;
    let calls = 0;
    for (const c of list) { tok += newTok(c); calls += num(c.calls); }
    return `<div class="summary num">${esc(t('summaryLine', fmtInt(list.length), fmtTok(tok), fmtInt(calls)))}</div>`;
  }

  function sessionsBodyHtml(data) {
    const all = Array.isArray(data && data.by_conversation) ? data.by_conversation : [];
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
      return `<p class="empty">${esc(all.length ? t('noMatches') : t('noConversations'))}</p>`;
    }
    const maxTok = Math.max(1, newTok(filtered[0]));
    const legend = `<div class="legend" style="margin-top:12px"><span><i class="seg-in"></i>${esc(t('legInput'))}</span><span><i class="seg-out"></i>${esc(t('legOutput'))}</span></div>`;
    const rows = filtered.slice(0, sessionsLimit).map((c, i) => convItemHtml(c, i, maxTok, data)).join('');
    const rest = filtered.length - sessionsLimit;
    const more = rest > 0 ? `<button type="button" class="quiet-btn" data-more-sessions>${CHEV}<span>${esc(t('moreConvs', Math.min(rest, CONV_VISIBLE * 2)))}</span></button>` : '';
    return summarizeConvs(filtered) + legend + `<ul class="conv-list">${rows}</ul>` + more;
  }

  function sessionsViewHtml(data) {
    const pBtns = SESSION_PERIODS.map((k) => `<button class="fchip" type="button" data-speriod="${k}" aria-pressed="${k === sessionsPeriod}">${esc(t('shortPeriods')[k])}</button>`).join('');
    const subBtn = `<button class="fchip" type="button" data-hide-sub aria-pressed="${hideSubagents}">${esc(t('hideSubagents'))}</button>`;
    const controls = `<div class="filters"><div class="fgroup">${pBtns}</div>${subBtn}</div>`;
    return controls + `<div id="history-sessions-body">${sessionsBodyHtml(data)}</div>`;
  }

  function updateSessionsBody() {
    if (historyView !== 'sessions' || !history.data || history.data.error) return;
    const body = $('history-sessions-body');
    if (body) keepScroll(() => { body.innerHTML = sessionsBodyHtml(history.data); });
    else paintHistory();
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
    const rows = filtered.slice(0, listLimit).map((c, i) => convItemHtml(c, i, 0, data)).join('');
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
    if (body) keepScroll(() => { body.innerHTML = listBodyHtml(history.data); });
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
    keepScroll(() => { panes.history.innerHTML = body; });
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

  function paintGuide() {
    const slot = $('guide-slot');
    const helpBtn = $('help');
    if (helpBtn) helpBtn.setAttribute('aria-expanded', String(guideMode === 'glossary'));
    if (!slot) return;
    if (!guideMode) {
      slot.hidden = true;
      slot.innerHTML = '';
      return;
    }
    if (guideMode === 'welcome') {
      const items = t('welcomeItems').map(([k, v]) => `<li class="guide-item"><b>${esc(k)}</b><span>${esc(v)}</span></li>`).join('');
      slot.innerHTML = `<aside class="guide-card" aria-label="${esc(t('welcomeTitle'))}">
        <div class="guide-head"><h3>${esc(t('welcomeTitle'))}</h3><button type="button" class="guide-close" data-guide-dismiss aria-label="${esc(t('helpClose'))}">&times;</button></div>
        <p class="guide-sub">${esc(t('welcomeSub'))}</p>
        <ul class="guide-list">${items}</ul>
        <div class="guide-acts">
          <button type="button" class="guide-btn" data-guide-dismiss>${esc(t('welcomeDone'))}</button>
          <button type="button" data-guide-glossary>${esc(t('welcomeGlossary'))}</button>
        </div>
      </aside>`;
    } else {
      const items = t('glossaryItems').map(([k, v]) => `<li class="guide-item"><b>${esc(k)}</b><span>${esc(v)}</span></li>`).join('');
      slot.innerHTML = `<aside class="guide-card" aria-label="${esc(t('glossaryTitle'))}">
        <div class="guide-head"><h3>${esc(t('glossaryTitle'))}</h3><button type="button" class="guide-close" data-guide-close>${esc(t('helpClose'))}</button></div>
        <ul class="guide-list">${items}</ul>
      </aside>`;
    }
    slot.hidden = false;
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
    const helpBtn = $('help');
    if (helpBtn) {
      helpBtn.title = t('helpTip');
      helpBtn.setAttribute('aria-label', t('helpTip'));
    }
    syncRefreshButton();
    paintGuide();
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
    if (tab === 'overview') { syncOverviewWeekly(); ensureWeeklyForOverview(); refreshReport(); }
    else if (tab === 'quota') quota.open();
    else { history.open(); ensureQuotaForHistory(false); }
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
    else if (tab === 'history' && history.data) {
      history.load({ refresh: false, silent: true });
      ensureQuotaForHistory(false);
    }
  }

  function onWake() {
    if (document.hidden) return;
    if (tab === 'overview') { refreshReport(); return; }
    if (tab === 'quota') {
      tickCountdowns();
      if (quota.data && Date.now() - quota.loadedAt > QUOTA_STALE_MS) quota.load({ refresh: false, silent: true });
    } else if (tab === 'history') {
      if (history.data && Date.now() - history.loadedAt > HISTORY_STALE_MS) history.load({ refresh: false, silent: true });
      ensureQuotaForHistory(false);
    }
  }

  function setPricingNotice(ok, text) {
    if (pricingNoticeTimer) { clearTimeout(pricingNoticeTimer); pricingNoticeTimer = null; }
    pricingNotice = { ok, text };
    if (ok) {
      pricingNoticeTimer = setTimeout(() => {
        pricingNoticeTimer = null;
        pricingNotice = null;
        const note = $('history-sync-note');
        if (note) {
          note.hidden = true;
          note.textContent = '';
          note.className = 'sync-note';
        }
      }, 3500);
    }
  }

  async function syncPricing() {
    if (pricingSyncing) return;
    pricingSyncing = true;
    if (pricingNoticeTimer) { clearTimeout(pricingNoticeTimer); pricingNoticeTimer = null; }
    pricingNotice = null;
    paintHistory();
    let syncOk = false;
    try {
      const res = await getJson('/api/pricing', { refresh: 'true' });
      if (res && res.error) {
        setPricingNotice(false, t('pricingSyncFail') + (res.message ? ` (${res.message})` : ''));
      } else {
        syncOk = true;
        setPricingNotice(true, t('pricingSyncOk', fmtInt(res && res.count), pricingSourceName(res && res.source)));
      }
    } catch (err) {
      setPricingNotice(false, t('pricingSyncFail') + (err && err.message ? ` (${err.message})` : ''));
    } finally {
      pricingSyncing = false;
      paintHistory();
      if (syncOk) {
        history.load({ refresh: true, silent: true });
        if (report) refreshReport({ force: true });
      }
    }
  }

  function toggleCalEditor(open) {
    calEditorOpen = open;
    const slot = $('history-cal');
    if (slot) keepScroll(() => { slot.innerHTML = calEditorHtml(); });
    else paintHistory();
    if (calEditorOpen) {
      const inp = panes.history.querySelector('.cal-input');
      if (inp) inp.focus({ preventScroll: true });
    }
  }

  function toggleModels(btn) {
    const collapsing = showAllModels;
    const prevY = window.scrollY;
    const beforeTop = btn ? btn.getBoundingClientRect().top : null;
    showAllModels = !showAllModels;
    const sec = $('history-models');
    if (sec && history.data && !history.data.error) sec.outerHTML = byModel(history.data);
    else paintHistory();
    if (collapsing && beforeTop != null) {
      const afterBtn = panes.history.querySelector('[data-toggle-models]');
      if (afterBtn) {
        const targetY = Math.max(0, window.scrollY + (afterBtn.getBoundingClientRect().top - beforeTop));
        if (Math.abs(window.scrollY - targetY) > 0.5) window.scrollTo(0, targetY);
        return;
      }
    }
    if (window.scrollY !== prevY) window.scrollTo(0, prevY);
  }

  function saveCalInputs() {
    const next = { ...weeklyLeft };
    for (const k of CAL_POOLS) {
      const el = $(`cal-${k}`);
      if (el) next[k] = el.value;
    }
    setWeeklyLeft(next);
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
  $('help').addEventListener('click', () => {
    if (guideMode === 'welcome') store.set('ctx.onboarded', '1');
    guideMode = guideMode === 'glossary' ? null : 'glossary';
    paintGuide();
  });
  $('refresh').addEventListener('click', () => {
    if (tab === 'overview') refreshReport({ force: true });
    else if (tab === 'quota') quota.load({ refresh: true, silent: false });
    else { pricingNotice = null; history.load({ refresh: true, silent: false }); ensureQuotaForHistory(true); }
  });
  $('lang').addEventListener('click', (e) => {
    const b = e.target.closest('[data-lang]');
    if (b && b.dataset.lang !== lang) setLang(b.dataset.lang);
  });
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-guide-dismiss]')) { store.set('ctx.onboarded', '1'); guideMode = null; paintGuide(); return; }
    if (e.target.closest('[data-guide-glossary]')) { store.set('ctx.onboarded', '1'); guideMode = 'glossary'; paintGuide(); return; }
    if (e.target.closest('[data-guide-close]')) { guideMode = null; paintGuide(); return; }
    const goTab = e.target.closest('[data-go-tab]');
    if (goTab) { setTab(goTab.dataset.goTab); return; }
    const retryBtn = e.target.closest('[data-retry]');
    if (retryBtn) {
      if (retryBtn.dataset.retry === 'quota') quota.load({ refresh: true, silent: false });
      else if (retryBtn.dataset.retry === 'history') { pricingNotice = null; history.load({ refresh: true, silent: false }); ensureQuotaForHistory(true); }
      return;
    }
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
    if (e.target.closest('[data-sync-prices]')) { syncPricing(); return; }
    if (e.target.closest('[data-toggle-cal]')) { toggleCalEditor(!calEditorOpen); return; }
    if (e.target.closest('[data-cal-save]')) { saveCalInputs(); return; }
    if (e.target.closest('[data-cal-clear]')) { setWeeklyLeft({ gemini: null, claude_gpt: null }); return; }
    const modBtn = e.target.closest('[data-toggle-models]');
    if (modBtn) { toggleModels(modBtn); return; }
    if (e.target.closest('[data-more-sessions]')) { sessionsLimit += CONV_VISIBLE * 2; updateSessionsBody(); return; }
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
    if (e.target && e.target.classList && e.target.classList.contains('cal-input')) {
      if (e.key === 'Enter') { e.preventDefault(); saveCalInputs(); }
      else if (e.key === 'Escape') { e.preventDefault(); toggleCalEditor(false); }
      return;
    }
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
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && guideMode === 'glossary') {
      guideMode = null;
      paintGuide();
      const hb = $('help');
      if (hb) hb.focus();
    }
  });
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
