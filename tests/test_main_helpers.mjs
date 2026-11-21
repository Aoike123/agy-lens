// Tests for the pure helpers in sidecars/context/main.mjs.
// Run (Node >= 18): node --test tests/test_main_helpers.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

process.env.CONTEXT_PANEL_NO_SERVER = '1';
const {
  NO_CACHE_HEADERS,
  buildModelCatalog,
  inferLimit,
  parseLiteLLMPricing,
  parseOpenRouterPricing,
  parseQuota,
  parseQuotaSummary,
  redact,
  stampAssetUrls,
  truthy,
} = await import('../sidecars/context/main.mjs');

const NOW = Date.parse('2026-11-20T10:00:00Z');
const G = { remainingFraction: 0.72, resetTime: '2026-11-20T10:56:17Z' };
const C = { remainingFraction: 0.69, resetTime: '2026-11-20T14:42:42Z' };

// Trimmed copy of the real GetUserStatus / GetAvailableModels shapes.
const STATUS = {
  userStatus: {
    name: 'Some Person',
    email: 'someone@example.com',
    profilePictureUrl: 'data:image/png;base64,AAAA',
    planStatus: { planInfo: { teamsTier: 'TEAMS_TIER_PRO', planName: 'Pro' } },
    cascadeModelConfigData: {
      clientModelConfigs: [
        { label: 'Gemini 4 Neon (High)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M532' }, quotaInfo: G, modelId: 'gemini-4-neon-high' },
        { label: 'Gemini 4 Neon (Low)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M534' }, quotaInfo: G, modelId: 'gemini-4-neon-low' },
        { label: 'Orchestrator (Neon)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M537' }, quotaInfo: G, modelId: 'gemini-pro-orchestrator-neon' },
        { label: 'Claude Opus 5.5 (High)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M402' }, quotaInfo: C, modelId: 'claude-opus-5-5-high' },
        { label: 'GPT-OSS 120B (Medium)', modelOrAlias: { model: 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM' }, quotaInfo: C, modelId: 'gpt-oss-120b-medium' },
      ],
      groupedModels: {
        'gemini-4-neon': { displayName: 'Gemini 4 Neon', supportedThinkingLevels: [{ thinkingSuffix: 'high', thinkingDisplayName: 'High' }, { thinkingSuffix: 'low', thinkingDisplayName: 'Low' }] },
      },
    },
    userTier: { id: 'g1-ultra-tier', name: 'Google AI Ultra' },
  },
};
const MODELS = {
  response: {
    models: {
      'gemini-4-neon-high': { displayName: 'Gemini 4 Neon (High)', quotaInfo: G, modelProvider: 'MODEL_PROVIDER_GOOGLE' },
      'gemini-4-neon-low': { displayName: 'Gemini 4 Neon (Low)', quotaInfo: G, modelProvider: 'MODEL_PROVIDER_GOOGLE' },
      'gemini-4-neon-tiered-high': { displayName: 'Gemini 4 Neon (High)', quotaInfo: G, modelProvider: 'MODEL_PROVIDER_GOOGLE' },
      'gemini-pro-orchestrator-neon': { displayName: 'Orchestrator (Neon)', quotaInfo: G, modelProvider: 'MODEL_PROVIDER_GOOGLE' },
      'gemini-2.5-flash': { displayName: 'Gemini 3.5 Flash Lite', quotaInfo: G, modelProvider: 'MODEL_PROVIDER_GOOGLE' },
      'gemini-2.5-flash-lite': { displayName: 'Gemini 3.5 Flash Lite', quotaInfo: G, modelProvider: 'MODEL_PROVIDER_GOOGLE' },
      'gemini-3.8-flash-tiered': { quotaInfo: G, modelProvider: 'MODEL_PROVIDER_GOOGLE' },
      'claude-opus-5-5-high': { displayName: 'Claude Opus 5.5 (High)', quotaInfo: C, modelProvider: 'MODEL_PROVIDER_ANTHROPIC' },
      'gpt-oss-120b-medium': { displayName: 'GPT-OSS 120B (Medium)', quotaInfo: C, modelProvider: 'MODEL_PROVIDER_OPENAI' },
      tab_flash_lite_preview: { quotaInfo: { remainingFraction: 1 }, modelProvider: 'MODEL_PROVIDER_GOOGLE' },
      tab_jump_flash_lite_preview: { quotaInfo: { remainingFraction: 1 }, modelProvider: 'MODEL_PROVIDER_GOOGLE' },
    },
    agentModelSorts: [{ displayName: 'Recommended', groups: [{ modelIds: ['gemini-4-neon-high', 'gemini-4-neon-low', 'gemini-pro-orchestrator-neon', 'claude-opus-5-5-high', 'gpt-oss-120b-medium'] }] }],
  },
};

test('truthy handles query strings and booleans', () => {
  for (const v of [true, 'true', 'TRUE', '1', 1, 'yes']) assert.equal(truthy(v), true, String(v));
  for (const v of [false, 'false', '0', '', undefined, null, 0]) assert.equal(truthy(v), false, String(v));
});

test('parseQuota on real-shaped data: categories, order, plan, tier', () => {
  const r = parseQuota(STATUS, MODELS, NOW);
  assert.equal(r.plan, 'Pro');
  assert.equal(r.tier, 'Google AI Ultra');
  assert.deepEqual(r.pools.map((p) => p.category), ['claude_gpt', 'gemini', 'tab']);
  const [claude, gemini, tab] = r.pools;
  assert.equal(claude.id, 'claude_gpt');
  assert.equal(claude.kind, 'models');
  assert.equal(claude.label, 'Claude / GPT-OSS models');
  assert.equal(claude.label_zh, 'Claude / GPT-OSS 模型');
  assert.equal(claude.remaining_fraction, 0.69);
  assert.equal(claude.reset_time, '2026-11-20T14:42:42.000Z');
  assert.equal(gemini.label, 'Gemini models');
  assert.equal(gemini.label_zh, 'Gemini 模型');
  assert.equal(tab.kind, 'tab');
  assert.equal(tab.label_zh, 'Tab 补全');
});

test('parseQuota dedupes models, hides internal ones, groups families', () => {
  const gemini = parseQuota(STATUS, MODELS, NOW).pools.find((p) => p.category === 'gemini');
  // Picker order, one entry per display name, no MODEL_PLACEHOLDER ids.
  assert.deepEqual(gemini.models, [
    { id: 'gemini-4-neon-high', display_name: 'Gemini 4 Neon (High)' },
    { id: 'gemini-4-neon-low', display_name: 'Gemini 4 Neon (Low)' },
    { id: 'gemini-pro-orchestrator-neon', display_name: 'Orchestrator (Neon)' },
  ]);
  assert.deepEqual(gemini.families, [
    { id: 'gemini-4-neon', display_name: 'Gemini 4 Neon', levels: ['High', 'Low'] },
    { id: 'gemini-pro-orchestrator-neon', display_name: 'Orchestrator (Neon)', levels: [] },
  ]);
  // Tiered duplicate of a visible name is dropped; duplicate names collapse;
  // nameless internal models fall back to their id.
  assert.deepEqual(gemini.hidden_models.map((m) => m.display_name).sort(), ['Gemini 3.5 Flash Lite', 'gemini-3.8-flash-tiered']);
  const all = JSON.stringify(parseQuota(STATUS, MODELS, NOW));
  assert.ok(!all.includes('MODEL_PLACEHOLDER'));
  const tab = parseQuota(STATUS, MODELS, NOW).pools.find((p) => p.kind === 'tab');
  assert.deepEqual(tab.models, []);
  assert.equal(tab.hidden_models.length, 2);
});

test('parseQuota infers limit kinds', () => {
  const pools = parseQuota(STATUS, MODELS, NOW).pools;
  for (const p of pools) assert.equal(p.limits.length, 1);
  assert.equal(pools[0].limits[0].kind, '5h');
  assert.equal(pools[0].limits[0].label_zh, '5 小时限额');
  assert.equal(pools[0].limits[0].inferred, true);
  assert.equal(pools[2].limits[0].kind, 'none');
  assert.equal(pools[2].limits[0].label_zh, '不限 · 无重置');

  const iso = (h) => new Date(NOW + h * 3600e3).toISOString();
  assert.equal(inferLimit(0.5, iso(4.9), NOW).kind, '5h');
  assert.equal(inferLimit(0.5, iso(12), NOW).kind, 'daily');
  assert.equal(inferLimit(0.5, iso(100), NOW).kind, 'weekly');
  assert.equal(inferLimit(0.5, iso(1000), NOW).kind, 'unknown');
  assert.equal(inferLimit(0.5, iso(-1), NOW).kind, 'unknown');
  assert.equal(inferLimit(0.5, null, NOW).kind, 'unknown');
  assert.equal(inferLimit(0.5, null, NOW).inferred, false);
  assert.equal(inferLimit(1, null, NOW).kind, 'none');
});

test('parseQuota without picker info falls back to named models', () => {
  const models = {
    models: {
      'gemini-3-pro': { displayName: 'Gemini 3 Pro', quotaInfo: { remainingFraction: 0.8, resetTime: '2026-11-20T12:00:00Z' } },
      'gemini-3-flash': { displayName: 'Gemini 3 Flash', quotaInfo: { remainingFraction: 0.8, resetTime: '2026-11-20T12:00:00Z' } },
      'claude-sonnet': { displayName: 'Claude Sonnet', quotaInfo: { remainingFraction: 0.1, resetTime: '2026-11-21T00:00:00Z' } },
      internal: { quotaInfo: { remainingFraction: 0.8, resetTime: '2026-11-20T12:00:00Z' } },
      'no-quota': { displayName: 'No Quota' },
    },
  };
  const r = parseQuota(null, models, NOW);
  assert.equal(r.pools.length, 2);
  assert.equal(r.pools[0].category, 'claude_gpt');
  assert.equal(r.pools[0].label, 'Claude models');
  assert.equal(r.pools[0].limits[0].kind, 'daily');
  assert.deepEqual(r.pools[1].models.map((m) => m.id).sort(), ['gemini-3-flash', 'gemini-3-pro']);
  assert.deepEqual(r.pools[1].hidden_models, [{ id: 'internal', display_name: 'internal' }]);
  assert.equal(r.plan, null);
  assert.equal(r.tier, null);
});

test('parseQuota: omitted fraction with reset = 0, empty quotaInfo = null, timestamps', () => {
  const status = { userStatus: { cascadeModelConfigData: { clientModelConfigs: [
    { label: 'Model A', modelId: 'a', quotaInfo: { resetTime: '2026-11-20T10:30:00Z' } },
    { label: 'Model B', modelId: 'b', quotaInfo: { remainingFraction: '0.5', resetTime: { seconds: 1700000000 } } },
    { label: 'Model C', modelId: 'c', quotaInfo: {} },
  ] } } };
  const r = parseQuota(status, null, NOW);
  assert.equal(r.pools[0].models[0].id, 'a');
  assert.equal(r.pools[0].remaining_fraction, 0);
  assert.equal(r.pools[1].remaining_fraction, 0.5);
  assert.equal(r.pools[1].reset_time, new Date(1700000000 * 1000).toISOString());
  assert.equal(r.pools[2].remaining_fraction, null);
  assert.equal(r.pools[2].category, 'other');
  assert.equal(r.pools[2].label, 'Model C');
  assert.equal(new Set(r.pools.map((p) => p.id)).size, 3);
});

test('parseQuota survives garbage', () => {
  for (const junk of [null, undefined, 42, 'x', [], {}, { models: 'nope' }, { userStatus: null }, { response: { models: [null, 1, 'x'] } }]) {
    assert.deepEqual(parseQuota(junk, junk, NOW, junk), { pools: [], weekly: {}, plan: null, tier: null });
  }
});

test('redact removes emails, tokens, secret fields and profile data', () => {
  const r = redact({
    email: 'a@b.com',
    note: 'contact me at someone@example.org please',
    apiKey: 'abc',
    accessToken: 'xyz',
    maxTokens: 100,
    nested: [{ idToken: 'eyJhbGciOiJIUzI1NiJ9xxxx.eyJzdWIiOiIxMjM0NTY3ODkwIn0yyyy.abcdefghijklmnop' }],
    header: 'Bearer abc.def',
    plain: 'Gemini 3 Pro',
    userStatus: { name: 'Some Person', profilePictureUrl: 'data:image/png;base64,AAAA', userTier: { name: 'Google AI Ultra' } },
  });
  assert.equal(r.email, '[redacted]');
  assert.equal(r.note, 'contact me at [email] please');
  assert.equal(r.apiKey, '[redacted]');
  assert.equal(r.accessToken, '[redacted]');
  assert.equal(r.maxTokens, 100);
  assert.equal(r.nested[0].idToken, '[redacted]');
  assert.equal(r.header, '[redacted]');
  assert.equal(r.plain, 'Gemini 3 Pro');
  assert.equal(r.userStatus.name, '[redacted]');
  assert.equal(r.userStatus.profilePictureUrl, '[redacted]');
  assert.equal(r.userStatus.userTier.name, 'Google AI Ultra');
});

test('NO_CACHE_HEADERS disables WebView caching', () => {
  assert.equal(NO_CACHE_HEADERS['Cache-Control'], 'no-store, no-cache, must-revalidate');
  assert.equal(NO_CACHE_HEADERS.Pragma, 'no-cache');
});

test('stampAssetUrls busts cache on styles.css and app.js without touching other refs', () => {
  const indexPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'sidecars', 'context', 'index.html');
  const html = readFileSync(indexPath, 'utf8');
  const stamped = stampAssetUrls(html, { 'styles.css': '1700000000000:4096', 'app.js': '1700000000001:8192' });
  assert.ok(stamped.includes('href="styles.css?v=1700000000000%3A4096"'));
  assert.ok(stamped.includes('src="app.js?v=1700000000001%3A8192"'));
  assert.ok(stamped.includes('src="/preload.js"'));
  assert.ok(!stamped.includes('preload.js?v='));

  // Replaces existing query, supports single quotes and ./ or /, skips data-* and missing stamps.
  const sample = [
    `<link rel="stylesheet" href='./styles.css?v=old'>`,
    `<script src="/app.js?v=old"></script>`,
    `<div data-src="app.js" data-href="styles.css"></div>`,
    `<a href="https://example.com/styles.css">ext</a>`,
  ].join('\n');
  const out = stampAssetUrls(sample, { 'styles.css': '100:20', 'app.js': '-' });
  assert.ok(out.includes(`href='./styles.css?v=100%3A20'`));
  assert.ok(out.includes(`src="/app.js?v=old"`));
  assert.ok(out.includes(`data-src="app.js" data-href="styles.css"`));
  assert.ok(out.includes(`href="https://example.com/styles.css"`));
});

test('parseLiteLLMPricing normalizes per-1M USD prices and filters noisy providers', () => {
  const sample = {
    sample_spec: { input_cost_per_token: 0.001, output_cost_per_token: 0.002 },
    'Claude-Opus-4-6': {
      litellm_provider: 'anthropic',
      mode: 'chat',
      input_cost_per_token: 0.000005,
      output_cost_per_token: 0.000025,
      cache_read_input_token_cost: 0.0000005,
    },
    'anthropic/claude-sonnet-4-6': {
      litellm_provider: 'anthropic',
      mode: 'chat',
      input_cost_per_token: 0.000003,
      output_cost_per_token: 0.000015,
      // cache_read absent -> defaults to input * 0.1 = 0.3
    },
    'gemini-2.5-pro': {
      litellm_provider: 'gemini',
      mode: 'chat',
      input_cost_per_token: 0.00000125,
      output_cost_per_token: 0.00001,
      cache_read_input_token_cost: 0.0000003125,
    },
    'vertex_ai/gemini-3.8-flash': {
      litellm_provider: 'vertex_ai-language-models',
      mode: 'chat',
      input_cost_per_token: 0.000000825,
      output_cost_per_token: 0.000004125,
      cache_read_input_token_cost: 0.0000000825,
    },
    'openai/gpt-oss-120b': {
      input_cost_per_token: 0.00000015,
      output_cost_per_token: 0.0000006,
      cache_read_input_token_cost: 0,
    },
    // Filtered out: Bedrock/Azure/regional/batch/free/non-chat/other providers/zero/negative
    'us.anthropic.claude-opus-4-6-v1': { litellm_provider: 'bedrock_converse', mode: 'chat', input_cost_per_token: 5.5e-6, output_cost_per_token: 2.75e-5 },
    'anthropic.claude-sonnet-4-6': { litellm_provider: 'bedrock_converse', mode: 'chat', input_cost_per_token: 3e-6, output_cost_per_token: 1.5e-5 },
    'azure_ai/claude-opus-4-6': { litellm_provider: 'azure_ai', mode: 'chat', input_cost_per_token: 5e-6, output_cost_per_token: 2.5e-5 },
    'vertex_ai/global/gemini-2.5-pro': { litellm_provider: 'vertex_ai', mode: 'chat', input_cost_per_token: 1.25e-6, output_cost_per_token: 1e-5 },
    'vertex_ai/claude-opus-4-6@20260205': { litellm_provider: 'vertex_ai', mode: 'chat', input_cost_per_token: 5e-6, output_cost_per_token: 2.5e-5 },
    'mistral/mistral-large': { litellm_provider: 'mistral', mode: 'chat', input_cost_per_token: 2e-6, output_cost_per_token: 6e-6 },
    'gemini-embedding-001': { litellm_provider: 'gemini', mode: 'embedding', input_cost_per_token: 1e-7, output_cost_per_token: 0 },
    'gpt-4o-batch': { litellm_provider: 'openai', mode: 'chat', input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 },
    'ft:gpt-4o': { litellm_provider: 'openai', mode: 'chat', input_cost_per_token: 3e-6, output_cost_per_token: 1e-5 },
    'gemini-free': { litellm_provider: 'gemini', mode: 'chat', input_cost_per_token: 0, output_cost_per_token: 0 },
    'gemini-bad': { litellm_provider: 'gemini', mode: 'chat', input_cost_per_token: -1, output_cost_per_token: 1e-6 },
  };
  const r = parseLiteLLMPricing(sample);
  assert.deepEqual(Object.keys(r).sort(), [
    'anthropic/claude-sonnet-4-6',
    'claude-opus-4-6',
    'gemini-2.5-pro',
    'openai/gpt-oss-120b',
    'vertex_ai/gemini-3.8-flash',
  ]);
  assert.deepEqual(r['claude-opus-4-6'], { input: 5, output: 25, cache_read: 0.5 });
  assert.deepEqual(r['anthropic/claude-sonnet-4-6'], { input: 3, output: 15, cache_read: 0.3 });
  assert.deepEqual(r['gemini-2.5-pro'], { input: 1.25, output: 10, cache_read: 0.3125 });
  assert.deepEqual(r['vertex_ai/gemini-3.8-flash'], { input: 0.825, output: 4.125, cache_read: 0.0825 });
  assert.deepEqual(r['openai/gpt-oss-120b'], { input: 0.15, output: 0.6, cache_read: 0 });

  for (const junk of [null, undefined, 42, 'x', [], {}]) {
    assert.deepEqual(parseLiteLLMPricing(junk), {});
  }
});

test('parseOpenRouterPricing normalizes per-1M USD prices and filters variants', () => {
  const sample = {
    data: [
      { id: 'Anthropic/Claude-Opus-4.6', pricing: { prompt: '0.000005', completion: '0.000025', input_cache_read: '0.0000005' } },
      { id: 'anthropic/claude-opus-4.6:batch', pricing: { prompt: '0.0000025', completion: '0.0000125' } },
      { id: 'google/gemini-3.8-flash', pricing: { prompt: '0.000000825', completion: '0.000004125', input_cache_read: '0.0000000825' } },
      { id: 'google/gemini-3.1-flash-image', pricing: { prompt: '0.0000005', completion: '0.000003' } },
      { id: 'google/gemini-2.5-pro:free', pricing: { prompt: '0', completion: '0' } },
      { id: 'openai/gpt-oss-120b', pricing: { prompt: '0.00000015', completion: '0.0000006', input_cache_read: '-1' } },
      { id: 'openrouter/auto', pricing: { prompt: '-1', completion: '-1' } },
      { id: 'meta-llama/llama-3.3-70b-instruct', pricing: { prompt: '0.0000002', completion: '0.0000008' } },
      null,
      { id: 'openai/missing-pricing' },
    ],
  };
  const r = parseOpenRouterPricing(sample);
  assert.deepEqual(Object.keys(r).sort(), [
    'anthropic/claude-opus-4.6',
    'google/gemini-3.1-flash-image',
    'google/gemini-3.8-flash',
    'openai/gpt-oss-120b',
  ]);
  assert.deepEqual(r['anthropic/claude-opus-4.6'], { input: 5, output: 25, cache_read: 0.5 });
  assert.deepEqual(r['google/gemini-3.8-flash'], { input: 0.825, output: 4.125, cache_read: 0.0825 });
  assert.deepEqual(r['google/gemini-3.1-flash-image'], { input: 0.5, output: 3, cache_read: 0.05 });
  assert.deepEqual(r['openai/gpt-oss-120b'], { input: 0.15, output: 0.6, cache_read: 0.015 });

  for (const junk of [null, undefined, 42, 'x', {}, { data: 'bad' }, { data: [null, {}] }]) {
    assert.deepEqual(parseOpenRouterPricing(junk), {});
  }
});

test('parseQuotaSummary handles groups, quotaSummary, top-level buckets, proto3 zero and fallback', () => {
  const documented = {
    response: {
      groups: [
        {
          displayName: 'Gemini Limit Remaining',
          buckets: [
            { bucketId: 'gemini-5h', displayName: 'Five Hour Limit Remaining', remainingFraction: 1.0, resetTime: '2026-11-20T15:00:00Z' },
            { bucketId: 'gemini-weekly', displayName: 'Weekly Limit Remaining', remainingFraction: 0.833, resetTime: '2026-11-27T00:00:00Z' },
          ],
        },
        {
          displayName: 'Third Party Limit Remaining',
          buckets: [
            // proto3 omits remainingFraction when 0
            { bucketId: '3p-weekly', displayName: 'Weekly Limit Remaining', resetTime: '2026-11-26T00:00:00Z' },
            { bucketId: '3p-5h', displayName: 'Five Hour Limit Remaining', remainingFraction: 0.65, resetTime: '2026-11-20T14:42:42Z' },
          ],
        },
      ],
    },
  };
  const s = parseQuotaSummary(documented, NOW);
  // Ordered weekly first, then 5h; both inferred: false.
  assert.deepEqual(s.byCategory.gemini.limits.map((l) => [l.kind, l.inferred, l.remaining_fraction]), [
    ['weekly', false, 0.833],
    ['5h', false, 1],
  ]);
  assert.deepEqual(s.byCategory.claude_gpt.limits.map((l) => [l.kind, l.inferred, l.remaining_fraction]), [
    ['weekly', false, 0],
    ['5h', false, 0.65],
  ]);
  assert.deepEqual(s.weekly, {
    gemini: { remaining_fraction: 0.833, reset_time: '2026-11-27T00:00:00.000Z' },
    claude_gpt: { remaining_fraction: 0, reset_time: '2026-11-26T00:00:00.000Z' },
  });

  // quotaSummary.groups + daily + unknown bucket falling back to inferLimit (inferred: true).
  const qs = parseQuotaSummary({
    quotaSummary: {
      groups: [
        {
          displayName: 'Custom Group',
          buckets: [
            { bucketId: 'custom-24h', displayName: 'Daily Limit', remainingFraction: 0.4, resetTime: '2026-11-21T08:00:00Z' },
            { bucketId: 'mystery', displayName: 'Mystery', remainingFraction: 0.5, resetTime: '2026-11-20T13:00:00Z' },
          ],
        },
      ],
    },
  }, NOW);
  assert.equal(qs.byCategory.other.label, 'Custom Group');
  assert.deepEqual(qs.byCategory.other.limits.map((l) => [l.kind, l.inferred]), [
    ['5h', true],
    ['daily', false],
  ]);
  assert.deepEqual(qs.weekly, {});

  // Top-level buckets + bare groups.
  const top = parseQuotaSummary({
    buckets: [
      { bucketId: 'google-7d', remainingFraction: 0.9, resetTime: '2026-11-25T00:00:00Z' },
    ],
  }, NOW);
  assert.equal(top.weekly.gemini.remaining_fraction, 0.9);
  assert.equal(top.byCategory.gemini.limits[0].inferred, false);

  for (const junk of [null, undefined, 42, 'x', [], {}, { groups: 'bad' }]) {
    assert.deepEqual(parseQuotaSummary(junk, NOW), { byCategory: {}, weekly: {} });
  }
});

test('parseQuota merges RetrieveUserQuotaSummary limits and exposes top-level weekly', () => {
  const summary = {
    response: {
      groups: [
        {
          displayName: 'Gemini Limit Remaining',
          buckets: [
            { bucketId: 'gemini-weekly', displayName: 'Weekly Limit Remaining', remainingFraction: 0.8, resetTime: '2026-11-27T00:00:00Z' },
            { bucketId: 'gemini-5h', displayName: 'Five Hour Limit Remaining', remainingFraction: 0.72, resetTime: '2026-11-20T10:56:17Z' },
          ],
        },
        {
          displayName: 'Claude / GPT Limit Remaining',
          buckets: [
            { bucketId: '3p-weekly', displayName: 'Weekly Limit Remaining', remainingFraction: 0.41, resetTime: '2026-11-26T00:00:00Z' },
            { bucketId: '3p-5h', displayName: 'Five Hour Limit Remaining', remainingFraction: 0.69, resetTime: '2026-11-20T14:42:42Z' },
          ],
        },
      ],
    },
  };
  const r = parseQuota(STATUS, MODELS, NOW, summary);
  assert.deepEqual(r.pools.map((p) => p.category), ['claude_gpt', 'gemini', 'tab']);
  assert.deepEqual(r.weekly, {
    gemini: { remaining_fraction: 0.8, reset_time: '2026-11-27T00:00:00.000Z' },
    claude_gpt: { remaining_fraction: 0.41, reset_time: '2026-11-26T00:00:00.000Z' },
  });
  const [claude, gemini, tab] = r.pools;
  // Deduplicated by kind, ordered weekly then 5h, preferring explicit (inferred: false).
  assert.deepEqual(claude.limits.map((l) => [l.kind, l.inferred, l.remaining_fraction]), [
    ['weekly', false, 0.41],
    ['5h', false, 0.69],
  ]);
  assert.deepEqual(gemini.limits.map((l) => [l.kind, l.inferred, l.remaining_fraction]), [
    ['weekly', false, 0.8],
    ['5h', false, 0.72],
  ]);
  assert.equal(gemini.models.length, 3);
  assert.equal(tab.limits[0].kind, 'none');

  // Summary-only pool creation when GetUserStatus/GetAvailableModels are absent.
  const only = parseQuota(null, null, NOW, summary);
  assert.deepEqual(only.pools.map((p) => p.category), ['claude_gpt', 'gemini']);
  assert.equal(only.pools[0].limits[0].kind, 'weekly');
  assert.deepEqual(only.pools[0].models, []);
  assert.equal(only.weekly.claude_gpt.remaining_fraction, 0.41);

  // Null summary keeps inferred 5h and empty weekly map.
  const without = parseQuota(STATUS, MODELS, NOW, null);
  assert.deepEqual(without.weekly, {});
  assert.equal(without.pools[0].limits.length, 1);
  assert.equal(without.pools[0].limits[0].inferred, true);
});

test('parseQuota hides models dropped from agentModelSorts, falls back to clientModelSorts, and orders family levels by server metadata', () => {
  const status = {
    userStatus: {
      cascadeModelConfigData: {
        clientModelConfigs: [
          { label: 'Gemini 4 Neon (High)', modelId: 'gemini-4-neon-high', quotaInfo: G },
          { label: 'Gemini 4 Neon (XHigh)', modelId: 'gemini-4-neon-xhigh', quotaInfo: G },
          { label: 'Gemini 4 Neon (Medium)', modelId: 'gemini-4-neon-medium', quotaInfo: G },
          { label: 'Gemini 4 Neon (Low)', modelId: 'gemini-4-neon-low', quotaInfo: G },
          { label: 'Orchestrator (Neon)', modelId: 'gemini-pro-orchestrator-neon', quotaInfo: G },
          { label: 'Deprecated Hidden', modelId: 'deprecated-hidden', quotaInfo: G, hidden: true },
        ],
        clientModelSorts: [
          { name: 'Recommended', groups: [{ modelLabels: ['Gemini 4 Neon (Medium)', 'Gemini 4 Neon (Low)'] }] },
        ],
        groupedModels: {
          'gemini-4-neon': {
            displayName: 'Gemini 4 Neon',
            supportedThinkingLevels: [
              { thinkingSuffix: 'low', thinkingDisplayName: 'Low' },
              { thinkingSuffix: 'medium', thinkingDisplayName: 'Medium' },
              { thinkingSuffix: 'high', thinkingDisplayName: 'High' },
              { thinkingSuffix: 'xhigh', thinkingDisplayName: 'Extra High' },
            ],
          },
        },
      },
    },
  };
  const models = {
    response: {
      models: {
        'gemini-4-neon-high': { displayName: 'Gemini 4 Neon (High)', quotaInfo: G, modelProvider: 'MODEL_PROVIDER_GOOGLE' },
        'gemini-4-neon-xhigh': { displayName: 'Gemini 4 Neon (XHigh)', quotaInfo: G, modelProvider: 'MODEL_PROVIDER_GOOGLE' },
        'gemini-4-neon-medium': { displayName: 'Gemini 4 Neon (Medium)', quotaInfo: G, modelProvider: 'MODEL_PROVIDER_GOOGLE' },
        'gemini-4-neon-low': { displayName: 'Gemini 4 Neon (Low)', quotaInfo: G, modelProvider: 'MODEL_PROVIDER_GOOGLE' },
        'gemini-pro-orchestrator-neon': { displayName: 'Orchestrator (Neon)', quotaInfo: G, modelProvider: 'MODEL_PROVIDER_GOOGLE' },
        'deprecated-hidden': { displayName: 'Deprecated Hidden', quotaInfo: G, modelProvider: 'MODEL_PROVIDER_GOOGLE', hidden: true },
      },
      agentModelSorts: [
        { groups: [{ modelIds: ['gemini-4-neon-high', 'gemini-4-neon-xhigh', 'gemini-4-neon-medium', 'gemini-4-neon-low', 'deprecated-hidden'] }] },
      ],
    },
  };
  const r = parseQuota(status, models, NOW);
  const gem = r.pools.find((p) => p.category === 'gemini');
  assert.deepEqual(gem.families, [
    { id: 'gemini-4-neon', display_name: 'Gemini 4 Neon', levels: ['Low', 'Medium', 'High', 'Extra High'] },
  ]);
  assert.deepEqual(gem.hidden_models.map((m) => m.id).sort(), ['deprecated-hidden', 'gemini-pro-orchestrator-neon']);

  // clientModelSorts fallback when agentModelSorts is absent.
  const noAgentSorts = parseQuota(status, { response: { models: models.response.models } }, NOW);
  const gem2 = noAgentSorts.pools.find((p) => p.category === 'gemini');
  assert.deepEqual(gem2.models.map((m) => m.id), ['gemini-4-neon-medium', 'gemini-4-neon-low']);
});

test('parseQuota separates unlimited pools by provider and creates dynamic pools & summary groups', () => {
  const models = {
    response: {
      models: {
        'gemini-4-neon-high': { displayName: 'Gemini 4 Neon (High)', quotaInfo: { remainingFraction: 1 }, modelProvider: 'MODEL_PROVIDER_GOOGLE' },
        'claude-opus-5-5-high': { displayName: 'Claude Opus 5.5 (High)', quotaInfo: { remainingFraction: 1 }, modelProvider: 'MODEL_PROVIDER_ANTHROPIC' },
        'deepseek-r2': { displayName: 'DeepSeek R2', quotaInfo: { remainingFraction: 1 }, modelProvider: 'MODEL_PROVIDER_DEEPSEEK' },
      },
      agentModelSorts: [{ groups: [{ modelIds: ['gemini-4-neon-high', 'claude-opus-5-5-high', 'deepseek-r2'] }] }],
    },
  };
  const r = parseQuota(null, models, NOW);
  assert.equal(r.pools.length, 3);
  assert.deepEqual(r.pools.map((p) => p.category).sort(), ['claude_gpt', 'deepseek', 'gemini']);
  const ds = r.pools.find((p) => p.category === 'deepseek');
  assert.equal(ds.label, 'DeepSeek models');
  assert.equal(ds.label_zh, 'DeepSeek 模型');

  const multiSum = parseQuotaSummary({
    groups: [
      { displayName: 'Custom Alpha', buckets: [{ bucketId: 'b1', window: 'weekly', remainingFraction: 0.9, resetTime: '2026-11-27T00:00:00Z' }] },
      { displayName: 'Custom Beta', buckets: [{ bucketId: 'b2', window: '5h', remainingFraction: 0.5, resetTime: '2026-11-25T00:00:00Z' }] },
    ],
  }, NOW);
  assert.equal(multiSum.byCategory.other.label, 'Custom Alpha');
  assert.equal(multiSum.byCategory.other.limits[0].kind, 'weekly');
  assert.equal(multiSum.byCategory.other.limits[0].inferred, false);
  assert.equal(multiSum.byCategory.custom_custom_beta.label, 'Custom Beta');
  assert.equal(multiSum.byCategory.custom_custom_beta.limits[0].kind, '5h');
  assert.equal(multiSum.byCategory.custom_custom_beta.limits[0].inferred, false);
});

test('buildModelCatalog outputs provider, pool, displayName, and zero-maxTokens entries dynamically', () => {
  const cat = buildModelCatalog(
    {
      response: {
        models: {
          'claude-opus-5-5-orchestrator': { displayName: 'Orchestrator (Claude Opus 5.5)', maxTokens: 1000000, modelProvider: 'MODEL_PROVIDER_ANTHROPIC' },
          'mystery-zero': { displayName: 'Mystery Zero', maxTokens: 0, modelProvider: 'MODEL_PROVIDER_DEEPSEEK' },
        },
      },
    },
    {
      userStatus: {
        cascadeModelConfigData: {
          clientModelConfigs: [
            { modelId: 'status-only', label: 'Status Only Model' },
          ],
        },
      },
    },
  );
  assert.deepEqual(cat['claude-opus-5-5-orchestrator'], {
    maxTokens: 1000000,
    displayName: 'Orchestrator (Claude Opus 5.5)',
    provider: 'MODEL_PROVIDER_ANTHROPIC',
    pool: 'claude_gpt',
  });
  assert.deepEqual(cat['mystery-zero'], {
    maxTokens: 0,
    displayName: 'Mystery Zero',
    provider: 'MODEL_PROVIDER_DEEPSEEK',
    pool: 'other',
  });
  assert.deepEqual(cat['status-only'], {
    maxTokens: 0,
    displayName: 'Status Only Model',
    provider: '',
    pool: 'other',
  });
});

test('parseQuota groups ungrouped parenthetical multi-variant models dynamically while leaving single variants intact', () => {
  const models = {
    response: {
      models: {
        'gemini-pro-orchestrator-neon': { displayName: 'Orchestrator (Neon)', quotaInfo: G, modelProvider: 'MODEL_PROVIDER_GOOGLE' },
        'gemini-pro-orchestrator': { displayName: 'Orchestrator (Carbon)', quotaInfo: G, modelProvider: 'MODEL_PROVIDER_GOOGLE' },
        'gemini-pro-orchestrator-argon': { displayName: 'Orchestrator (Argon)', quotaInfo: G, modelProvider: 'MODEL_PROVIDER_GOOGLE' },
        'future-model-high': { displayName: 'Future Model (High)', quotaInfo: G, modelProvider: 'MODEL_PROVIDER_GOOGLE' },
        'future-model-low': { displayName: 'Future Model (Low)', quotaInfo: G, modelProvider: 'MODEL_PROVIDER_GOOGLE' },
        'future-model-medium': { displayName: 'Future Model (Medium)', quotaInfo: G, modelProvider: 'MODEL_PROVIDER_GOOGLE' },
        'gpt-oss-120b-medium': { displayName: 'GPT-OSS 120B (Medium)', quotaInfo: C, modelProvider: 'MODEL_PROVIDER_OPENAI' },
      },
      agentModelSorts: [{
        groups: [{
          modelIds: [
            'gemini-pro-orchestrator-neon',
            'gemini-pro-orchestrator',
            'gemini-pro-orchestrator-argon',
            'future-model-high',
            'future-model-low',
            'future-model-medium',
            'gpt-oss-120b-medium',
          ],
        }],
      }],
    },
  };
  const r = parseQuota(null, models, NOW);
  const gem = r.pools.find((p) => p.category === 'gemini');
  const claude = r.pools.find((p) => p.category === 'claude_gpt');
  assert.deepEqual(gem.families, [
    { id: 'orchestrator', display_name: 'Orchestrator', levels: ['Neon', 'Carbon', 'Argon'] },
    { id: 'future-model', display_name: 'Future Model', levels: ['Low', 'Medium', 'High'] },
  ]);
  assert.deepEqual(claude.families, [
    { id: 'gpt-oss-120b-medium', display_name: 'GPT-OSS 120B (Medium)', levels: [] },
  ]);
});
