// Tests for the pure helpers in sidecars/agy-lens/main.mjs and lib/web-bundle.mjs.
// Run (Node >= 24): node --test tests/test_main_helpers.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { collectRuntimeFiles } from '../scripts/build-release.mjs';
import {
  bundleWebApp,
  computeWebJsStamp,
  resolveWebModule,
  tokenizeJs,
  transformEsModule,
} from '../sidecars/agy-lens/lib/web-bundle.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const WEB_DIR = join(ROOT, 'sidecars', 'agy-lens', 'web');

process.env.CONTEXT_PANEL_NO_SERVER = '1';
const {
  NO_CACHE_HEADERS,
  STATIC_HEADERS,
  buildModelCatalog,
  getBundledAppJs,
  inferLimit,
  parseLiteLLMPricing,
  parseOpenRouterPricing,
  parseQuota,
  parseQuotaSummary,
  redact,
  renderIndexHtml,
  stampAssetUrls,
  truthy,
} = await import('../sidecars/agy-lens/main.mjs');

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
  assert.equal(inferLimit(0.5, iso(336), NOW).kind, 'weekly');
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
  const indexPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'sidecars', 'agy-lens', 'web', 'index.html');
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

// --- M2B Test Group 1: Real web/ classic bundle & packaging ------------------

function findTopLevelEsmTokens(code) {
  const tokens = tokenizeJs(code);
  const hits = [];
  let depth = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];
    const prev = i > 0 ? tokens[i - 1] : null;
    const isMember = Boolean(prev && prev.type === 'PUNCT' && (prev.value === '.' || prev.value === '?.'));
    if (depth === 0 && !isMember && tok.type === 'IDENT' && (tok.value === 'import' || tok.value === 'export')) {
      const next = tokens[i + 1];
      if (!(tok.value === 'import' && next && next.type === 'PUNCT' && next.value === '(')) {
        hits.push(tok);
      }
    }
    if (tok.type === 'PUNCT' && (tok.value === '(' || tok.value === '[' || tok.value === '{')) depth += 1;
    else if (tok.type === 'TEMPLATE_HEAD') depth += 1;
    else if (tok.type === 'PUNCT' && (tok.value === ')' || tok.value === ']' || tok.value === '}')) depth -= 1;
    else if (tok.type === 'TEMPLATE_TAIL') depth -= 1;
  }
  return hits;
}

test('bundleWebApp(WEB_DIR) emits valid classic script with zero top-level import/export and is packaged', () => {
  const code = bundleWebApp(WEB_DIR, 'app.js');
  assert.equal(typeof code, 'string');
  assert.ok(code.length > 5000);

  // Compiles cleanly as a classic non-module script in V8.
  assert.doesNotThrow(() => new vm.Script(code, { filename: 'app.bundle.js' }));

  // Zero top-level ESM import/export tokens remain.
  assert.deepEqual(findTopLevelEsmTokens(code), []);

  // All reachable modules under web/ are included in the bundle.
  for (const modId of [
    'app.js',
    'i18n.js',
    'format.js',
    'views/overview.js',
    'views/quota.js',
    'views/history.js',
    'views/share-card.js',
  ]) {
    assert.ok(code.includes(`__modules[${JSON.stringify(modId)}]`), `Missing module in bundle: ${modId}`);
  }

  // Executing in a headless global context (no window/document) must not leak internal symbols.
  const sandbox = {};
  vm.runInNewContext(code, sandbox, { filename: 'app.bundle.js' });
  assert.deepEqual(Object.keys(sandbox), []);

  // Packaging script collects sidecars/agy-lens/lib/web-bundle.mjs and updater.mjs automatically.
  const runtime = collectRuntimeFiles(ROOT);
  assert.ok(runtime.includes('sidecars/agy-lens/lib/web-bundle.mjs'));
  assert.ok(runtime.includes('sidecars/agy-lens/lib/updater.mjs'));
});

// --- M2B Test Group 2: Synthetic ESM edge-case & symbol collision matrix -----

test('web-bundle handles all static ESM forms, lexical traps, collisions, circular deps, and containment', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'agy-bundle-matrix-'));
  try {
    mkdirSync(join(tmpDir, 'sub'), { recursive: true });

    writeFileSync(join(tmpDir, 'shared.js'), [
      'globalThis.__initCount = (globalThis.__initCount || 0) + 1;',
      'export const helper = "shared-helper";',
      'export function render() { return "shared-render"; }',
    ].join('\n'), 'utf8');

    writeFileSync(join(tmpDir, 'side-effect.js'), [
      'globalThis.__sideEffects = (globalThis.__sideEffects || 0) + 1;',
    ].join('\n'), 'utf8');

    writeFileSync(join(tmpDir, 'def-fn.js'), [
      'export default function greet(name) { return "hi:" + name; }',
    ].join('\n'), 'utf8');

    writeFileSync(join(tmpDir, 'def-async.js'), [
      'export default async function (v) { return v + 1; }',
    ].join('\n'), 'utf8');

    writeFileSync(join(tmpDir, 'def-class.js'), [
      'export default class Box { constructor(v) { this.v = v; } }',
    ].join('\n'), 'utf8');

    writeFileSync(join(tmpDir, 'def-expr.js'), [
      'export default { k: 42, url: import.meta.url };',
    ].join('\n'), 'utf8');

    writeFileSync(join(tmpDir, 'named.js'), [
      'export const A = 10;',
      'export let B = 20;',
      'export var V = 30;',
      'export function fn() { return "fn"; }',
      'export async function afn() { return "afn"; }',
      'export class Cls { id() { return 7; } }',
      'const obj = { p: 1, q: 2, nested: [3, 4, 5, 6] };',
      'export const { p, q: q2 = 9, nested: [n1, , ...nRest] } = obj;',
      'export { A as A2, B as B2 };',
      'export default "named-default";',
    ].join('\n'), 'utf8');

    writeFileSync(join(tmpDir, 'sub', 'star-src.js'), [
      'import { helper } from "../shared.js";',
      'export const starVal = helper + ":star";',
      'export const shadowed = "from-star";',
      'export default "ignored-by-star";',
    ].join('\n'), 'utf8');

    writeFileSync(join(tmpDir, 'reexporter.js'), [
      'export * from "./sub/star-src.js";',
      'export * as starNs from "./sub/star-src.js";',
      'export { A, B as renamedB } from "./named.js";',
      'export { default as reDef } from "./def-fn.js";',
      'export const shadowed = "local-override";',
    ].join('\n'), 'utf8');

    // Circular dependency between circ-a.js and circ-b.js exporting functions
    writeFileSync(join(tmpDir, 'circ-a.js'), [
      'import { getB } from "./circ-b.js";',
      'export function getA() { return "A"; }',
      'export function callBoth() { return getA() + "+" + getB(); }',
    ].join('\n'), 'utf8');

    writeFileSync(join(tmpDir, 'circ-b.js'), [
      'import { getA } from "./circ-a.js";',
      'export function getB() { return "B(" + getA() + ")"; }',
    ].join('\n'), 'utf8');

    // Symbol collisions + lexical traps (comments, strings, nested templates, regexes with backticks/quotes/[,/], division after paren)
    writeFileSync(join(tmpDir, 'traps.js'), [
      'const helper = "traps-helper";',
      'function render() { return helper; }',
      'let counter = 1;',
      '// import fake1 from "./missing.js"; export const fake2 = 1;',
      '/* import fake3 from "./missing.js";\n export default 0; */',
      'const s1 = "import x from \'./missing.js\'; export const y = 1;";',
      'const s2 = \'export { nope } from "./missing.js";\';',
      'const t1 = `line1\\nimport x from "./missing.js";\\n${`nested ${1 + 2} export default 1`}\\${notInterp}`;',
      'const re1 = /[\\r\\n"\'<>,;|`]/;',
      'const re2 = /rgba?\\(\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)(?:\\s*[,/]\\s*([0-9.]+))?\\s*\\)/i;',
      'const re3 = /import x from \'\\.\\/missing\\.js\'; export default 1/g;',
      'const divAfterParen = (20 + 10) / 3 / 2;',
      'const stmtHeaderRegex = (function (x) { if (x) return /ok/.test(x); return false; })("ok");',
      'export { helper, render, counter, s1, s2, t1, re1, re2, re3, divAfterParen, stmtHeaderRegex };',
    ].join('\n'), 'utf8');

    writeFileSync(join(tmpDir, 'entry.js'), [
      'import "./side-effect.js"',
      'import "./side-effect.js"',
      'import greet from "./def-fn.js"',
      'import defAsync from "./def-async.js"',
      'import Box from "./def-class.js"',
      'import defExpr from "./def-expr.js"',
      'import {',
      '  A2,',
      '  B2 as B_alias,',
      '  fn,',
      '  afn,',
      '  Cls,',
      '  p,',
      '  q2,',
      '  n1,',
      '  nRest,',
      '} from "./named.js"',
      'import * as namedNs from "./named.js"',
      'import def2, * as fnNs from "./def-fn.js"',
      'import def3, { V } from "./named.js"',
      'import { starVal, starNs, renamedB, reDef, shadowed } from "./reexporter.js"',
      'import { callBoth } from "./circ-a.js"',
      'import * as traps from "./traps.js"',
      'import { helper as sharedHelper } from "./shared.js"',
      'const helper = "entry-helper";',
      'function render() { return helper; }',
      'let counter = 99;',
      'globalThis.__resultPromise = (async () => ({',
      '  initCount: globalThis.__initCount,',
      '  sideEffects: globalThis.__sideEffects,',
      '  greet: greet("world"),',
      '  defAsyncVal: await defAsync(9),',
      '  boxVal: new Box(55).v,',
      '  defExpr,',
      '  named: [A2, B_alias, fn(), await afn(), new Cls().id(), p, q2, n1, nRest, namedNs.A, def2("x"), typeof fnNs.default, def3, V],',
      '  reexp: { starVal, starNsVal: starNs.starVal, starNsHasDef: starNs.default, renamedB, reDef: reDef("re"), shadowed },',
      '  circ: callBoth(),',
      '  collisions: [sharedHelper, traps.helper, traps.render(), render(), counter, traps.counter],',
      '  traps: {',
      '    s1: traps.s1,',
      '    s2: traps.s2,',
      '    t1: traps.t1,',
      '    re1Match: traps.re1.test("`"),',
      '    re2Match: traps.re2.test("rgba(1,2,3/0.5)"),',
      '    re3Src: traps.re3.source,',
      '    divAfterParen: traps.divAfterParen,',
      '    stmtHeaderRegex: traps.stmtHeaderRegex,',
      '  },',
      '  metaUrl: import.meta.url,',
      '}))();',
    ].join('\n'), 'utf8');

    const bundled = bundleWebApp(tmpDir, 'entry.js');
    assert.doesNotThrow(() => new vm.Script(bundled, { filename: 'matrix.bundle.js' }));
    assert.deepEqual(findTopLevelEsmTokens(bundled), []);

    const sandbox = {};
    vm.runInNewContext(bundled, sandbox, { filename: 'matrix.bundle.js' });
    const res = JSON.parse(JSON.stringify(await sandbox.__resultPromise));

    assert.equal(res.initCount, 1);
    assert.equal(res.sideEffects, 1);
    assert.equal(res.greet, 'hi:world');
    assert.equal(res.defAsyncVal, 10);
    assert.equal(res.boxVal, 55);
    assert.equal(res.defExpr.k, 42);
    assert.ok(typeof res.defExpr.url === 'string' && res.defExpr.url.includes('def-expr.js'));
    assert.deepEqual(res.named, [10, 20, 'fn', 'afn', 7, 1, 2, 3, [5, 6], 10, 'hi:x', 'function', 'named-default', 30]);
    assert.equal(res.reexp.starVal, 'shared-helper:star');
    assert.equal(res.reexp.starNsVal, 'shared-helper:star');
    assert.equal(res.reexp.starNsHasDef, 'ignored-by-star');
    assert.equal(res.reexp.renamedB, 20);
    assert.equal(res.reexp.reDef, 'hi:re');
    assert.equal(res.reexp.shadowed, 'local-override');
    assert.equal(res.circ, 'A+B(A)');
    assert.deepEqual(res.collisions, ['shared-helper', 'traps-helper', 'traps-helper', 'entry-helper', 99, 1]);
    assert.ok(res.traps.s1.includes('missing.js'));
    assert.ok(res.traps.s2.includes('missing.js'));
    assert.ok(res.traps.t1.includes('nested 3 export default 1') && res.traps.t1.includes('${notInterp}'));
    assert.equal(res.traps.re1Match, true);
    assert.equal(res.traps.re2Match, true);
    assert.ok(res.traps.re3Src.includes('missing'));
    assert.equal(res.traps.divAfterParen, 5);
    assert.equal(res.traps.stmtHeaderRegex, true);
    assert.ok(typeof res.metaUrl === 'string' && res.metaUrl.includes('entry.js'));

    // Direct transformEsModule check on export default class & ASI
    const clsTx = transformEsModule('export default class {\n  v() { return 1 }\n}\n(function(){})()', 'cls.js', (s) => s);
    assert.doesNotThrow(() => new vm.Script(`(function(__require,__exports,__module){\n${clsTx.code}\n})`));

    // Path traversal & bare specifier rejection
    assert.throws(() => resolveWebModule('app.js', '../outside.js', tmpDir), /escapes/i);
    assert.throws(() => resolveWebModule('sub/star-src.js', '../../outside.js', tmpDir), /escapes/i);
    assert.throws(() => resolveWebModule('app.js', 'lodash', tmpDir), /non-relative/i);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// --- M2B Test Group 3: Mocked Browser VM Execution of Bundled /app.js -------

function createMockDomSandbox({ navigatorLanguage = 'en-US', brokenStorage = false, fetchFixtures }) {
  const intervals = new Set();
  const timeouts = new Set();
  const fetchedUrls = [];
  const docListeners = new Map();
  const winListeners = new Map();

  const parseTagAttrs = (attrText) => {
    const attrs = new Map();
    const re = /([A-Za-z0-9_:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    let m;
    while ((m = re.exec(attrText)) !== null) {
      const k = m[1];
      const v = m[2] ?? m[3] ?? m[4] ?? '';
      attrs.set(k, v);
    }
    return attrs;
  };

  class MockElement {
    constructor(tagName = 'div', attrs = {}) {
      this.tagName = tagName.toUpperCase();
      this._attrs = new Map();
      this._listeners = new Map();
      this._children = [];
      this._parent = null;
      this._innerHTML = '';
      this._textContent = '';
      this.hidden = false;
      this.tabIndex = 0;
      this.title = '';
      this.value = '';
      this.open = false;
      this.dataset = {};
      this.style = {
        setProperty: (k, v) => {
          const cur = this._attrs.get('style') || '';
          this._attrs.set('style', `${cur ? `${cur};` : ''}${k}:${v}`);
        },
      };
      for (const [k, v] of Object.entries(attrs)) this.setAttribute(k, v);
      this.classList = {
        toggle: (cls, force) => {
          const cur = new Set(String(this._attrs.get('class') || '').split(/\s+/).filter(Boolean));
          const add = force === undefined ? !cur.has(cls) : Boolean(force);
          if (add) cur.add(cls); else cur.delete(cls);
          this._attrs.set('class', [...cur].join(' '));
          return add;
        },
        add: (...clss) => clss.forEach((c) => this.classList.toggle(c, true)),
        remove: (...clss) => clss.forEach((c) => this.classList.toggle(c, false)),
        contains: (cls) => String(this._attrs.get('class') || '').split(/\s+/).includes(cls),
      };
    }

    get id() { return this._attrs.get('id') || ''; }
    set id(v) { this._attrs.set('id', String(v)); }

    setAttribute(k, v) {
      const val = String(v);
      this._attrs.set(k, val);
      if (k === 'hidden') this.hidden = true;
      if (k === 'open') this.open = true;
      if (k.startsWith('data-')) {
        const camel = k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        this.dataset[camel] = val;
      }
    }

    getAttribute(k) {
      return this._attrs.has(k) ? this._attrs.get(k) : null;
    }

    appendChild(child) {
      child._parent = this;
      this._children.push(child);
      return child;
    }

    get innerHTML() { return this._innerHTML; }
    set innerHTML(val) {
      this._innerHTML = String(val ?? '');
      this._children = [];
      this._textContent = '';
      const VOID_TAGS = new Set([
        'br', 'hr', 'img', 'input', 'meta', 'link', 'path', 'rect', 'circle', 'line', 'polygon', 'polyline', 'use',
      ]);
      const tokenRe = /<(\/)?([A-Za-z][A-Za-z0-9-]*)(\s+[^>]*)?>/g;
      const stack = [this];
      let lastIdx = 0;
      let m;
      while ((m = tokenRe.exec(this._innerHTML)) !== null) {
        if (m.index > lastIdx && stack.length > 1) {
          stack[stack.length - 1]._textContent += ` ${this._innerHTML.slice(lastIdx, m.index)}`;
        }
        lastIdx = tokenRe.lastIndex;
        const isClose = Boolean(m[1]);
        const tag = m[2];
        const attrRaw = m[3] || '';
        if (isClose) {
          for (let i = stack.length - 1; i >= 1; i -= 1) {
            if (stack[i].tagName === tag.toUpperCase()) {
              stack.length = i;
              break;
            }
          }
          continue;
        }
        const parsed = parseTagAttrs(attrRaw);
        const child = new MockElement(tag);
        for (const [k, v] of parsed.entries()) child.setAttribute(k, v);
        const curParent = stack[stack.length - 1];
        child._parent = curParent;
        curParent._children.push(child);
        if (!VOID_TAGS.has(tag.toLowerCase()) && !/\/\s*$/.test(attrRaw)) {
          stack.push(child);
        }
      }
    }

    get textContent() {
      if (this._innerHTML) return this._innerHTML.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      const own = this._textContent || '';
      if (this._children.length) {
        return `${own} ${this._children.map((c) => c.textContent).join(' ')}`.replace(/\s+/g, ' ').trim();
      }
      return own.replace(/\s+/g, ' ').trim();
    }

    contains(node) {
      let cur = node;
      while (cur) {
        if (cur === this) return true;
        cur = cur._parent;
      }
      return false;
    }

    dispatch(type, extra = {}) {
      const ev = { type, target: this, currentTarget: this, preventDefault() {}, ...extra };
      let cur = this;
      while (cur) {
        for (const fn of cur._listeners.get(type) || []) fn(ev);
        cur = cur._parent;
      }
      for (const fn of docListeners.get(type) || []) fn(ev);
    }

    set textContent(v) {
      this._textContent = String(v ?? '');
      this._innerHTML = '';
    }

    addEventListener(type, fn) {
      if (!this._listeners.has(type)) this._listeners.set(type, []);
      this._listeners.get(type).push(fn);
    }

    focus() {}

    matches(selector) {
      return selector.split(',').some((part) => {
        const s = part.trim();
        if (!s) return false;
        const idM = s.match(/#([A-Za-z0-9_-]+)/);
        if (idM && this.id !== idM[1]) return false;
        const clsMatches = [...s.matchAll(/\.([A-Za-z0-9_-]+)/g)];
        for (const cm of clsMatches) {
          if (!this.classList.contains(cm[1])) return false;
        }
        const attrMatches = [...s.matchAll(/\[([^\]=]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/g)];
        for (const am of attrMatches) {
          const attrVal = this.getAttribute(am[1]);
          if (attrVal === null) return false;
          const expected = am[2] ?? am[3] ?? am[4];
          if (expected !== undefined && attrVal !== expected) return false;
        }
        const tagM = s.match(/^([A-Za-z][A-Za-z0-9-]*)/);
        if (tagM && this.tagName !== tagM[1].toUpperCase()) return false;
        return Boolean(idM || clsMatches.length || attrMatches.length || tagM);
      });
    }

    closest(selector) {
      let cur = this;
      while (cur) {
        if (cur.matches(selector)) return cur;
        cur = cur._parent;
      }
      return null;
    }

    querySelectorAll(selector) {
      const out = [];
      const walk = (node) => {
        for (const ch of node._children) {
          if (ch.matches(selector)) out.push(ch);
          walk(ch);
        }
      };
      walk(this);
      return out;
    }

    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    }

    click() {
      const ev = { target: this, currentTarget: this, preventDefault() {} };
      let cur = this;
      while (cur) {
        for (const fn of cur._listeners.get('click') || []) fn(ev);
        cur = cur._parent;
      }
      for (const fn of docListeners.get('click') || []) fn(ev);
    }
  }

  const root = new MockElement('html');
  const body = new MockElement('body');
  root.appendChild(body);
  const tabsNav = new MockElement('nav', { class: 'tabs', role: 'tablist' });
  const tabOverview = new MockElement('button', { class: 'tab', id: 'tab-overview', 'data-tab': 'overview', 'data-i18n': 'tab.overview' });
  tabOverview.textContent = 'Overview';
  const tabQuota = new MockElement('button', { class: 'tab', id: 'tab-quota', 'data-tab': 'quota', 'data-i18n': 'tab.quota' });
  tabQuota.textContent = 'Quota';
  const tabHistory = new MockElement('button', { class: 'tab', id: 'tab-history', 'data-tab': 'history', 'data-i18n': 'tab.history' });
  tabHistory.textContent = 'History';
  tabsNav.appendChild(tabOverview);
  tabsNav.appendChild(tabQuota);
  tabsNav.appendChild(tabHistory);

  const refreshBtn = new MockElement('button', { class: 'icon-btn', id: 'refresh' });
  const langPill = new MockElement('div', { class: 'lang-pill', id: 'lang' });
  const langEn = new MockElement('button', { 'data-lang': 'en', 'aria-pressed': 'true' });
  const langZh = new MockElement('button', { 'data-lang': 'zh', 'aria-pressed': 'false' });
  langPill.appendChild(langEn);
  langPill.appendChild(langZh);

  const updateBanner = new MockElement('div', { class: 'update-banner', id: 'update-banner', hidden: '' });
  const paneOverview = new MockElement('main', { class: 'pane', id: 'overview' });
  paneOverview.innerHTML = '<p class="empty" data-i18n="loading">Loading…</p>';
  const paneQuota = new MockElement('main', { class: 'pane', id: 'quota', hidden: '' });
  const paneHistory = new MockElement('main', { class: 'pane', id: 'history', hidden: '' });

  body.appendChild(tabsNav);
  body.appendChild(refreshBtn);
  body.appendChild(langPill);
  body.appendChild(updateBanner);
  body.appendChild(paneOverview);
  body.appendChild(paneQuota);
  body.appendChild(paneHistory);

  const documentMock = {
    documentElement: { lang: 'en' },
    body,
    hidden: false,
    currentScript: { src: 'http://127.0.0.1/app.js' },
    createElement: (tag) => new MockElement(tag),
    getElementById: (id) => root.querySelector(`#${id}`),
    querySelector: (sel) => root.querySelector(sel),
    querySelectorAll: (sel) => root.querySelectorAll(sel),
    addEventListener: (type, fn) => {
      if (!docListeners.has(type)) docListeners.set(type, []);
      docListeners.get(type).push(fn);
    },
  };

  const storageMap = new Map();
  const localStorageMock = brokenStorage
    ? {
        getItem() { throw new DOMException('Access is denied for this document.', 'SecurityError'); },
        setItem() { throw new DOMException('Access is denied for this document.', 'SecurityError'); },
        removeItem() { throw new DOMException('Access is denied for this document.', 'SecurityError'); },
      }
    : {
        getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
        setItem: (k, v) => { storageMap.set(k, String(v)); },
        removeItem: (k) => { storageMap.delete(k); },
      };

  let reloadCalls = 0;

  const fetchMock = async (rawUrl, opts = {}) => {
    const u = String(rawUrl);
    fetchedUrls.push(u);
    if (/\.(m?js)(\?|$)/i.test(u) || u.includes('/views/') || u.includes('/i18n') || u.includes('/format')) {
      throw new Error(`Unexpected sub-module network fetch: ${u}`);
    }
    const pathname = u.split('?')[0];
    const fixture = fetchFixtures[pathname];
    const bodyObj = typeof fixture === 'function' ? await fixture(u, opts) : (fixture || {});
    return {
      ok: true,
      status: 200,
      async json() { return structuredClone(bodyObj); },
    };
  };

  const sandbox = {
    console,
    navigator: { language: navigatorLanguage },
    location: { search: '', href: 'http://127.0.0.1/', reload: () => { reloadCalls += 1; } },
    URL,
    URLSearchParams,
    DOMException,
    document: documentMock,
    localStorage: localStorageMock,
    fetch: fetchMock,
    scrollY: 0,
    scrollTo: () => {},
    addEventListener: (type, fn) => {
      if (!winListeners.has(type)) winListeners.set(type, []);
      winListeners.get(type).push(fn);
    },
    sidecar: {
      conversationId: '11111111-1111-4111-8111-111111111111',
      fetch: fetchMock,
      getWorkspaceUris: async () => [],
      onWorkspaceChange: () => {},
    },
    setInterval: (fn, ms) => {
      const id = setInterval(fn, ms);
      intervals.add(id);
      return id;
    },
    clearInterval: (id) => {
      intervals.delete(id);
      clearInterval(id);
    },
    setTimeout: (fn, ms) => {
      const id = setTimeout(fn, ms);
      timeouts.add(id);
      return id;
    },
    clearTimeout: (id) => {
      timeouts.delete(id);
      clearTimeout(id);
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  const cleanup = () => {
    for (const id of intervals) clearInterval(id);
    for (const id of timeouts) clearTimeout(id);
    intervals.clear();
    timeouts.clear();
  };

  return {
    sandbox,
    documentMock,
    fetchedUrls,
    getReloadCalls: () => reloadCalls,
    elements: { tabOverview, tabQuota, tabHistory, refreshBtn, langEn, langZh, updateBanner, paneOverview, paneQuota, paneHistory },
    cleanup,
  };
}

test('bundled /app.js executes in mocked browser VM (en-US & opaque zh-CN) without sub-module fetches', async () => {
  const bundled = bundleWebApp(WEB_DIR, 'app.js');
  const fetchFixtures = {
    '/api/report': {
      model: 'Gemini 2.5 Pro',
      used_tokens: 42000,
      limit_tokens: 1000000,
      used_pct: 4.2,
      free_tokens: 958000,
      heading: 'Token usage by category',
      grid_segments: [5000, 12000, 18000, 5000, 2000],
      categories: [{ key: 'user', name: 'User messages', tokens: 12000, pct: 1.2 }],
      speed: {
        calls: 2,
        avg_streaming_tps: 78.4,
        avg_e2e_tps: 55.2,
        avg_ttft_sec: 0.65,
        latest: { streaming_tps: 82.1, e2e_tps: 61.0, ttft_sec: 0.52, cache_hit_pct: 68, output_tokens: 420 },
        recent: [{ streaming_tps: 82.1, e2e_tps: 61.0, ttft_sec: 0.52, output_tokens: 420 }],
        by_model: [],
      },
      session: { calls: 2, input: 18000, output: 4200, cache_read: 30000, total_tokens: 22200, est_cost_usd: 0.08, d7_tokens: 22200 },
      updatedAt: '2026-11-22T04:00:00Z',
    },
    '/api/quota': {
      plan: 'Pro',
      fetched_at: '2026-11-22T04:00:00Z',
      weekly: { gemini: { remaining_fraction: 0.85, reset_time: '2026-11-28T00:00:00Z' } },
      pools: [
        {
          id: 'gemini',
          category: 'gemini',
          limits: [{ kind: '5h', remaining_fraction: 0.9, reset_time: '2026-11-22T09:00:00Z' }],
          models: [{ id: 'gemini-2.5-pro', display_name: 'Gemini 2.5 Pro' }],
        },
      ],
    },
    '/api/history': {
      totals: {
        today: { input: 10000, output: 3000, cache_read: 20000, calls: 5, conversations: 1, est_cost_usd: 0.09 },
        d7: { input: 80000, output: 20000, cache_read: 150000, calls: 24, conversations: 4, est_cost_usd: 0.95 },
        d30: { input: 320000, output: 95000, cache_read: 640000, calls: 96, conversations: 14, est_cost_usd: 4.25 },
        all: { input: 500000, output: 140000, cache_read: 900000, calls: 150, conversations: 21, est_cost_usd: 7.4 },
      },
      by_model: [
        { model: 'gemini-2.5-pro', display_name: 'Gemini 2.5 Pro', pool: 'gemini', input: 200000, output: 60000, cache_read: 400000, d7_tokens: 60000, calls: 60, est_cost_usd: 2.5 },
      ],
      by_conversation: [],
      daily: [{ date: '2026-11-22', tokens: 33000, calls: 5 }],
      hourly_today: [{ hour: 11, tokens: 33000, calls: 5 }],
      d7_by_pool: { gemini: 60000, claude_gpt: 0, other: 0 },
      pricing_source: 'builtin',
      sources: { desktop: 14, cli: 0 },
      errors: 0,
      scanned_at: '2026-11-22T04:00:00Z',
    },
    '/api/pricing': { source: 'builtin', count: 10 },
    '/api/update': { current_version: '2.2.0', latest_version: '2.2.0', update_available: false },
  };

  const flush = () => new Promise((r) => setTimeout(r, 40));

  // Scenario A: en-US with normal localStorage
  const vmEn = createMockDomSandbox({ navigatorLanguage: 'en-US', brokenStorage: false, fetchFixtures });
  try {
    vm.runInNewContext(bundled, vmEn.sandbox, { filename: 'app.bundle.js' });
    await flush();

    assert.equal(vmEn.documentMock.documentElement.lang, 'en');
    assert.equal(vmEn.elements.paneOverview.hidden, false);
    assert.equal(vmEn.elements.paneQuota.hidden, true);
    assert.equal(vmEn.elements.paneHistory.hidden, true);
    assert.equal(vmEn.elements.tabOverview.getAttribute('aria-selected'), 'true');
    assert.ok(vmEn.elements.paneOverview.innerHTML.includes('Gemini 2.5 Pro'));
    assert.ok(vmEn.elements.paneOverview.innerHTML.includes('42.0k'));
    assert.ok(!vmEn.elements.paneOverview.innerHTML.includes('Loading…'));

    // Switch to Quota tab
    vmEn.elements.tabQuota.click();
    await flush();
    assert.equal(vmEn.elements.paneQuota.hidden, false);
    assert.equal(vmEn.elements.paneOverview.hidden, true);
    assert.ok(vmEn.elements.paneQuota.innerHTML.includes('Gemini 2.5 Pro'));
    assert.ok(vmEn.elements.paneQuota.innerHTML.includes('90%'));

    // Switch to History tab
    vmEn.elements.tabHistory.click();
    await flush();
    assert.equal(vmEn.elements.paneHistory.hidden, false);
    assert.ok(vmEn.elements.paneHistory.innerHTML.includes('By model'));

    // Toggle EN -> 中 -> EN
    vmEn.elements.langZh.click();
    await flush();
    assert.equal(vmEn.documentMock.documentElement.lang, 'zh-CN');
    assert.equal(vmEn.elements.tabOverview.textContent, '概览');
    assert.equal(vmEn.elements.langZh.getAttribute('aria-pressed'), 'true');
    assert.ok(vmEn.elements.paneHistory.innerHTML.includes('按模型'));

    vmEn.elements.langEn.click();
    await flush();
    assert.equal(vmEn.documentMock.documentElement.lang, 'en');
    assert.equal(vmEn.elements.tabOverview.textContent, 'Overview');

    // Zero network requests to sub-modules
    assert.equal(
      vmEn.fetchedUrls.some((u) => /\.(m?js)(\?|$)/i.test(u) || u.includes('/views/') || u.includes('/i18n') || u.includes('/format')),
      false,
    );
  } finally {
    vmEn.cleanup();
  }

  // Scenario B: opaque-origin zh-CN where localStorage throws SecurityError
  const vmZh = createMockDomSandbox({ navigatorLanguage: 'zh-CN', brokenStorage: true, fetchFixtures });
  try {
    vm.runInNewContext(bundled, vmZh.sandbox, { filename: 'app.bundle.js' });
    await flush();

    assert.equal(vmZh.documentMock.documentElement.lang, 'zh-CN');
    assert.equal(vmZh.elements.tabOverview.textContent, '概览');
    assert.ok(vmZh.elements.paneOverview.innerHTML.includes('Gemini 2.5 Pro'));
    assert.ok(!vmZh.elements.paneOverview.innerHTML.includes('data-boot-error'));
    assert.equal(
      vmZh.fetchedUrls.some((u) => /\.(m?js)(\?|$)/i.test(u) || u.includes('/views/') || u.includes('/i18n') || u.includes('/format')),
      false,
    );
  } finally {
    vmZh.cleanup();
  }

  // Scenario C: one-click self-update, error fallback to Copy cmd, git mode, dismiss persistence & Refresh push check.
  // C1. Installed mode renders "Update now", hides Copy cmd initially, installs on click & reloads after restart poll.
  let pollUpdCount = 0;
  let installedCalledWith = null;
  const selfUpdateFixtures = {
    ...fetchFixtures,
    '/api/update': () => {
      pollUpdCount += 1;
      if (installedCalledWith && pollUpdCount >= 2) {
        return {
          current_version: '2.3.1',
          latest_version: '2.3.1',
          update_available: false,
          can_self_update: true,
          install_mode: 'installed',
          release_url: 'https://github.com/Aoike123/agy-lens/releases/tag/v2.3.1',
        };
      }
      return {
        current_version: '2.3.0',
        latest_version: '2.3.1',
        update_available: true,
        can_self_update: true,
        install_mode: 'installed',
        release_url: 'https://github.com/Aoike123/agy-lens/releases/tag/v2.3.1',
      };
    },
    '/api/update/install': (_url, opts) => {
      assert.equal(opts.method, 'POST');
      installedCalledWith = JSON.parse(opts.body || '{}');
      pollUpdCount = 0;
      return { ok: true, updated: true, previous_version: '2.3.0', version: '2.3.1', restarting: true };
    },
  };
  const vmSelf = createMockDomSandbox({ navigatorLanguage: 'en-US', brokenStorage: false, fetchFixtures: selfUpdateFixtures });
  try {
    vm.runInNewContext(bundled, vmSelf.sandbox, { filename: 'app.bundle.js' });
    await flush();
    assert.equal(vmSelf.elements.updateBanner.hidden, false);
    assert.ok(vmSelf.elements.updateBanner.textContent.includes('2.3.1'));
    assert.ok(vmSelf.elements.updateBanner.textContent.includes('Update now'));
    const installBtn = vmSelf.elements.updateBanner.querySelector('[data-install-update]');
    assert.ok(installBtn);
    assert.equal(vmSelf.elements.updateBanner.querySelector('[data-copy-update]'), null);

    installBtn.click();
    assert.ok(vmSelf.elements.updateBanner.textContent.includes('Updating to v2.3.1'));
    await new Promise((r) => setTimeout(r, 1500));
    assert.deepEqual(installedCalledWith, { version: '2.3.1' });
    assert.equal(vmSelf.getReloadCalls(), 1);
  } finally {
    vmSelf.cleanup();
  }

  // C2. Self-update failure shows Retry + fallback Copy cmd + dismiss persistence.
  const errFixtures = {
    ...fetchFixtures,
    '/api/update': {
      current_version: '2.3.0',
      latest_version: '2.3.1',
      update_available: true,
      can_self_update: true,
      install_mode: 'installed',
      release_url: 'https://github.com/Aoike123/agy-lens/releases/tag/v2.3.1',
    },
    '/api/update/install': () => ({ ok: false, error: 'install_failed', message: 'checksum mismatch' }),
  };
  const vmErr = createMockDomSandbox({ navigatorLanguage: 'en-US', brokenStorage: false, fetchFixtures: errFixtures });
  try {
    vm.runInNewContext(bundled, vmErr.sandbox, { filename: 'app.bundle.js' });
    await flush();
    vmErr.elements.updateBanner.querySelector('[data-install-update]').click();
    await flush();
    assert.equal(vmErr.elements.updateBanner.classList.contains('is-err'), true);
    assert.ok(vmErr.elements.updateBanner.textContent.includes('checksum mismatch'));
    assert.ok(vmErr.elements.updateBanner.textContent.includes('Retry'));
    assert.ok(vmErr.elements.updateBanner.textContent.includes('Copy cmd'));
    const retryBtn = vmErr.elements.updateBanner.querySelector('[data-install-update]');
    const copyFallback = vmErr.elements.updateBanner.querySelector('[data-copy-update]');
    assert.ok(retryBtn && copyFallback);

    vmErr.elements.updateBanner.querySelector('[data-dismiss-update]').click();
    assert.equal(vmErr.elements.updateBanner.hidden, true);
    assert.equal(vmErr.sandbox.localStorage.getItem('ctx.dismissedUpdate'), '2.3.1');
  } finally {
    vmErr.cleanup();
  }

  // C3. Git checkout mode shows Copy cmd, and clicking Refresh detects newly released update live.
  let latestAvailable = false;
  const gitRefreshFixtures = {
    ...fetchFixtures,
    '/api/update': (url) => (latestAvailable
      ? {
          current_version: '2.3.0',
          latest_version: '2.3.1',
          update_available: true,
          can_self_update: false,
          install_mode: 'git',
          release_url: 'https://github.com/Aoike123/agy-lens/releases/tag/v2.3.1',
        }
      : {
          current_version: '2.3.0',
          latest_version: '2.3.0',
          update_available: false,
          can_self_update: false,
          install_mode: 'git',
          saw_url: url,
        }),
  };
  const vmGit = createMockDomSandbox({ navigatorLanguage: 'en-US', brokenStorage: false, fetchFixtures: gitRefreshFixtures });
  try {
    vm.runInNewContext(bundled, vmGit.sandbox, { filename: 'app.bundle.js' });
    await flush();
    assert.equal(vmGit.elements.updateBanner.hidden, true);
    latestAvailable = true;
    vmGit.elements.refreshBtn.click();
    await flush();
    assert.ok(vmGit.fetchedUrls.some((u) => u.startsWith('/api/update?refresh=true')));
    assert.equal(vmGit.elements.updateBanner.hidden, false);
    assert.equal(vmGit.elements.updateBanner.querySelector('[data-install-update]'), null);
    assert.ok(vmGit.elements.updateBanner.querySelector('[data-copy-update]'));
  } finally {
    vmGit.cleanup();
  }

  // Scenario D: Cycle drill-down opens on bar click with --ox, updates on sbar hover, and closes on back/Escape/mouseout.
  const cyBase = Date.UTC(2026, 10, 21, 8, 51, 0);
  const drillFixtures = {
    ...fetchFixtures,
    '/api/history': {
      ...fetchFixtures['/api/history'],
      weekly_value_usd: { gemini: 2200 },
      weekly_cycles: {
        gemini: [{
          cycle_start: new Date(cyBase).toISOString(),
          reset_time: new Date(cyBase + 7 * 86400_000).toISOString(),
          is_current: true,
          used_fraction: 0.60,
          weekly_value_usd: 1419,
          segment_baseline_usd: 2200,
          segments: [
            {
              start_at: new Date(cyBase).toISOString(),
              end_at: new Date(cyBase + 16 * 3600_000).toISOString(),
              used_delta: 0.14,
              cost_usd: 308,
              calls: 500,
              implied_weekly_usd: 2200,
              burn_ratio: 1,
              kind: 'normal',
              is_gap: false,
              peak_concurrency: 4,
              p90_concurrency: 3,
            },
            {
              start_at: new Date(cyBase + 16 * 3600_000).toISOString(),
              end_at: new Date(cyBase + 40 * 3600_000).toISOString(),
              used_delta: 0.46,
              cost_usd: 506,
              calls: 2000,
              implied_weekly_usd: 1100,
              burn_ratio: 2,
              kind: 'surge',
              is_gap: true,
              peak_concurrency: 33,
              p90_concurrency: 14,
            },
          ],
        }],
      },
    },
  };
  const vmDrill = createMockDomSandbox({ navigatorLanguage: 'en-US', brokenStorage: false, fetchFixtures: drillFixtures });
  try {
    vm.runInNewContext(bundled, vmDrill.sandbox, { filename: 'app.bundle.js' });
    await flush();
    vmDrill.elements.tabQuota.click();
    await flush();

    const poolEl = vmDrill.elements.paneQuota.querySelector('.wcy-pool');
    assert.ok(poolEl && !poolEl.classList.contains('is-drill'));
    const barEl = vmDrill.elements.paneQuota.querySelector('.cbar[data-cy-key]');
    assert.ok(barEl);

    // Click cycle column -> opens drill-down, defaults to surge segment #1 (33 peak)
    barEl.click();
    assert.equal(poolEl.classList.contains('is-drill'), true);
    assert.ok((poolEl.querySelector('.cy-stage').getAttribute('style') || '').includes('--ox:'));
    const sbars = poolEl.querySelectorAll('.sbar');
    assert.equal(sbars.length, 2);
    assert.equal(sbars[1].classList.contains('is-active'), true);
    assert.ok(poolEl.querySelector('.seg-foot').textContent.includes('Up to 33 chats at once'));

    // Hover first segment -> switches footer to Up to 4 chats at once without full re-render
    sbars[0].dispatch('mouseover');
    assert.equal(sbars[0].classList.contains('is-active'), true);
    assert.equal(sbars[1].classList.contains('is-active'), false);
    assert.ok(poolEl.querySelector('.seg-foot').textContent.includes('Up to 4 chats at once'));

    // Click back closes drill-down cleanly
    poolEl.querySelector('[data-cy-back]').click();
    assert.equal(poolEl.classList.contains('is-drill'), false);

    // Re-open then trigger mouseout outside pool -> closes after 320ms grace timer
    barEl.click();
    assert.equal(poolEl.classList.contains('is-drill'), true);
    poolEl.dispatch('mouseout', { relatedTarget: vmDrill.elements.tabQuota });
    assert.equal(poolEl.classList.contains('is-drill'), true); // still open during grace period
    await new Promise((r) => setTimeout(r, 380));
    assert.equal(poolEl.classList.contains('is-drill'), false);

    // Re-open then press Escape -> closes immediately
    barEl.click();
    assert.equal(poolEl.classList.contains('is-drill'), true);
    vmDrill.elements.paneQuota.dispatch('keydown', { key: 'Escape' });
    assert.equal(poolEl.classList.contains('is-drill'), false);
  } finally {
    vmDrill.cleanup();
  }
});

// --- M2B Test Group 4: computeWebJsStamp + renderIndexHtml cache-busting ----

test('computeWebJsStamp and renderIndexHtml bust app.js?v= on sub-module edits and strip type=module', () => {
  const tmpWeb = mkdtempSync(join(tmpdir(), 'agy-web-stamp-'));
  try {
    cpSync(WEB_DIR, tmpWeb, { recursive: true });
    // Even if index.html has type="module", renderIndexHtml strips it on app.js.
    const indexPath = join(tmpWeb, 'index.html');
    writeFileSync(
      indexPath,
      readFileSync(indexPath, 'utf8').replace('<script src="app.js"></script>', '<script type="module" src="app.js"></script>'),
      'utf8',
    );

    const s1 = computeWebJsStamp(tmpWeb);
    assert.notEqual(s1, '-');
    const html1 = renderIndexHtml(tmpWeb);
    assert.ok(html1.includes(`src="app.js?v=${encodeURIComponent(s1)}"`));
    assert.ok(!/<script[^>]*type=["']module["'][^>]*app\.js/i.test(html1));

    const overviewPath = join(tmpWeb, 'views', 'overview.js');
    writeFileSync(overviewPath, `${readFileSync(overviewPath, 'utf8')}\n// stamp-bump-1\n`, 'utf8');
    utimesSync(overviewPath, new Date(Date.now() + 2000), new Date(Date.now() + 2000));
    const s2 = computeWebJsStamp(tmpWeb);
    assert.notEqual(s2, s1);
    const html2 = renderIndexHtml(tmpWeb);
    assert.ok(html2.includes(`src="app.js?v=${encodeURIComponent(s2)}"`));

    const i18nPath = join(tmpWeb, 'i18n.js');
    writeFileSync(i18nPath, `${readFileSync(i18nPath, 'utf8')}\n// stamp-bump-2\n`, 'utf8');
    utimesSync(i18nPath, new Date(Date.now() + 4000), new Date(Date.now() + 4000));
    const s3 = computeWebJsStamp(tmpWeb);
    assert.notEqual(s3, s2);
    const html3 = renderIndexHtml(tmpWeb);
    assert.ok(html3.includes(`src="app.js?v=${encodeURIComponent(s3)}"`));

    // getBundledAppJs returns valid classic JS and invalidates cache when stamp changes
    const b2 = getBundledAppJs(tmpWeb);
    assert.doesNotThrow(() => new vm.Script(b2));
    assert.ok(b2.includes('// stamp-bump-2'));
  } finally {
    rmSync(tmpWeb, { recursive: true, force: true });
  }
});

// --- M2B Test Group 5: Live HTTP Server Integration (with IPC fallback) ------

test('main.mjs serves classic /app.js bundle, stamped /, CORS headers, and OPTIONS', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'agy-main-srv-'));
  const geminiDir = join(tmpDir, 'gemini');
  const dataDir = join(tmpDir, 'data');
  mkdirSync(geminiDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });

  const mockSdkPath = join(tmpDir, 'mock-sdk.mjs');
  const loaderPath = join(tmpDir, 'loader.mjs');

  writeFileSync(mockSdkPath, [
    "import http from 'node:http';",
    'export class Response {',
    '  constructor(body, { status = 200, contentType = "text/plain", headers = {} } = {}) {',
    '    this.body = body; this.status = status; this.contentType = contentType; this.headers = headers;',
    '  }',
    '}',
    'export class SidecarApp {',
    '  constructor() { this._pages = new Map(); this._apis = new Map(); }',
    '  page(path, fn) { this._pages.set(path, fn); }',
    '  api(path, fn) { this._apis.set(path, fn); }',
    '  async _dispatch(method, rawUrl) {',
    '    const u = new URL(rawUrl, "http://127.0.0.1");',
    '    const page = this._pages.get(u.pathname);',
    '    if (page) {',
    '      const res = await page({ method, url: u.toString(), pathname: u.pathname });',
    '      const headers = {};',
    '      for (const [k, v] of Object.entries(res.headers || {})) headers[k.toLowerCase()] = String(v);',
    '      if (res.contentType) headers["content-type"] = res.contentType;',
    '      return { status: res.status || 200, headers, body: String(res.body ?? "") };',
    '    }',
    '    return { status: 404, headers: { "content-type": "text/plain" }, body: "Not found" };',
    '  }',
    '  run() {',
    '    const server = http.createServer(async (req, res) => {',
    '      const r = await this._dispatch(req.method || "GET", req.url || "/");',
    '      res.writeHead(r.status, r.headers);',
    '      res.end(r.body);',
    '    });',
    '    server.listen(0, "127.0.0.1", () => {',
    '      const addr = server.address();',
    '      process.send?.({ type: "ready", port: addr.port });',
    '    });',
    '    process.on("message", async (msg) => {',
    '      if (msg?.type === "http-request") {',
    '        const r = await this._dispatch(msg.method || "GET", msg.url || "/");',
    '        process.send?.({ type: "http-response", id: msg.id, ...r });',
    '      }',
    '    });',
    '  }',
    '}',
  ].join('\n'), 'utf8');

  writeFileSync(loaderPath, [
    "import { register } from 'node:module';",
    `const sdkUrl = ${JSON.stringify(pathToFileURL(mockSdkPath).href)};`,
    'const hook = [',
    '  "export function resolve(specifier, context, nextResolve) {",',
    '  "  if (specifier === \\"sidecar_sdk\\") return { shortCircuit: true, url: " + JSON.stringify(sdkUrl) + " };",',
    '  "  return nextResolve(specifier, context);",',
    '  "}",',
    '].join("\\n");',
    "register('data:text/javascript,' + encodeURIComponent(hook), import.meta.url);",
  ].join('\n'), 'utf8');

  const child = spawn(
    process.execPath,
    ['--import', pathToFileURL(loaderPath).href, join(ROOT, 'sidecars', 'agy-lens', 'main.mjs')],
    {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        CONTEXT_PANEL_NO_SERVER: '0',
        ANTIGRAVITY_GEMINI_DIR: geminiDir,
        ANTIGRAVITY_EXECUTABLE_DATA_DIR: dataDir,
      },
    },
  );

  let stderr = '';
  child.stderr.on('data', (d) => { stderr += String(d); });

  const pendingIpc = new Map();
  let nextIpcId = 1;
  let port = null;
  let useIpc = false;

  try {
    port = await new Promise((resolveReady, rejectReady) => {
      const timer = setTimeout(() => rejectReady(new Error(`Server start timeout. stderr=${stderr}`)), 8000);
      child.on('exit', (code) => {
        clearTimeout(timer);
        rejectReady(new Error(`Server exited early (${code}). stderr=${stderr}`));
      });
      child.on('message', (msg) => {
        if (msg?.type === 'ready') {
          clearTimeout(timer);
          resolveReady(msg.port);
        } else if (msg?.type === 'http-response') {
          const p = pendingIpc.get(msg.id);
          if (p) {
            pendingIpc.delete(msg.id);
            p.resolve(msg);
          }
        }
      });
    });

    const request = async (method, path) => {
      if (!useIpc) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}${path}`, { method });
          const headers = {};
          res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
          return { status: res.status, headers, body: await res.text() };
        } catch (err) {
          if (err?.cause?.code === 'EACCES') {
            useIpc = true;
          } else {
            throw err;
          }
        }
      }
      const id = nextIpcId++;
      return new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error(`IPC timeout for ${method} ${path}`)), 5000);
        pendingIpc.set(id, {
          resolve: (v) => { clearTimeout(t); res(v); },
          reject: (e) => { clearTimeout(t); rej(e); },
        });
        child.send({ type: 'http-request', id, method, url: path });
      });
    };

    const expectedAppStamp = encodeURIComponent(computeWebJsStamp(WEB_DIR));

    const rootRes = await request('GET', '/');
    assert.equal(rootRes.status, 200);
    assert.match(rootRes.headers['content-type'] || '', /text\/html/i);
    assert.equal(rootRes.headers['access-control-allow-origin'], '*');
    assert.equal(rootRes.headers['cache-control'], NO_CACHE_HEADERS['Cache-Control']);
    assert.equal(rootRes.headers.pragma, NO_CACHE_HEADERS.Pragma);
    assert.ok(rootRes.body.includes(`app.js?v=${expectedAppStamp}`));
    assert.ok(!/<script[^>]*type=["']module["'][^>]*app\.js/i.test(rootRes.body));

    const appRes = await request('GET', `/app.js?v=${expectedAppStamp}`);
    assert.equal(appRes.status, 200);
    assert.match(appRes.headers['content-type'] || '', /javascript/i);
    assert.equal(appRes.headers['access-control-allow-origin'], '*');
    assert.equal(appRes.headers['cache-control'], NO_CACHE_HEADERS['Cache-Control']);
    assert.doesNotThrow(() => new vm.Script(appRes.body, { filename: 'served-app.js' }));
    assert.deepEqual(findTopLevelEsmTokens(appRes.body), []);

    const cssRes = await request('GET', '/styles.css');
    assert.equal(cssRes.status, 200);
    assert.match(cssRes.headers['content-type'] || '', /text\/css/i);
    assert.equal(cssRes.headers['access-control-allow-origin'], '*');
    assert.equal(cssRes.headers['cache-control'], NO_CACHE_HEADERS['Cache-Control']);

    const optRes = await request('OPTIONS', '/app.js');
    assert.ok(optRes.status === 200 || optRes.status === 204, `Unexpected OPTIONS status: ${optRes.status}`);
    assert.equal(optRes.headers['access-control-allow-origin'], '*');
    assert.equal(optRes.headers['cache-control'], NO_CACHE_HEADERS['Cache-Control']);
    assert.equal(STATIC_HEADERS['Access-Control-Allow-Origin'], '*');
  } finally {
    if (child.exitCode === null) {
      const exited = new Promise((res) => child.once('exit', res));
      child.kill();
      await Promise.race([exited, new Promise((r) => setTimeout(r, 1000))]);
    }
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('parseLiteLLMPricing keeps the above-200k long-context tier', () => {
  const out = parseLiteLLMPricing({
    'gemini/gemini-3.1-pro-preview': {
      litellm_provider: 'gemini',
      mode: 'chat',
      input_cost_per_token: 0.000002,
      output_cost_per_token: 0.000012,
      cache_read_input_token_cost: 2e-7,
      input_cost_per_token_above_200k_tokens: 0.000004,
      output_cost_per_token_above_200k_tokens: 0.000018,
      cache_read_input_token_cost_above_200k_tokens: 4e-7,
    },
    'gemini/gemini-4-hydrogen': {
      litellm_provider: 'gemini',
      mode: 'chat',
      input_cost_per_token: 0.0000015,
      output_cost_per_token: 0.0000075,
      cache_read_input_token_cost: 7.5e-8,
    },
  });
  assert.deepEqual(out['gemini/gemini-3.1-pro-preview'], {
    input: 2, output: 12, cache_read: 0.2,
    above_200k: { threshold: 200000, input: 4, output: 18, cache_read: 0.4 },
  });
  assert.deepEqual(out['gemini/gemini-4-hydrogen'], { input: 1.5, output: 7.5, cache_read: 0.075 });
});

test('parseQuota keeps shared 3p pool unified when grouped and splits dynamic Opus/Sonnet pools when server separates them', async () => {
  const { modelPool } = await import('../sidecars/agy-lens/lib/catalog.mjs');

  // 1. Unified 3p shape (Claude Opus + Sonnet + GPT-OSS sharing 3p-weekly / 3p-5h).
  const sharedModels = {
    response: {
      models: {
        'claude-opus-5-5-high': { displayName: 'Claude Opus 5.5 (High)', maxTokens: 1000000, quotaInfo: C, modelProvider: 'MODEL_PROVIDER_ANTHROPIC' },
        'claude-sonnet-5-5-high': { displayName: 'Claude Sonnet 5.5 (High)', maxTokens: 1000000, quotaInfo: C, modelProvider: 'MODEL_PROVIDER_ANTHROPIC' },
        'gpt-oss-120b-medium': { displayName: 'GPT-OSS 120B (Medium)', maxTokens: 131072, quotaInfo: C, modelProvider: 'MODEL_PROVIDER_OPENAI' },
      },
      agentModelSorts: [{ groups: [{ modelIds: ['claude-opus-5-5-high', 'claude-sonnet-5-5-high', 'gpt-oss-120b-medium'] }] }],
    },
  };
  const sharedSummary = {
    response: {
      groups: [
        {
          displayName: 'Claude and GPT models',
          description: 'Models within this group: Claude Opus 5.5, Claude Sonnet 5.5, GPT-OSS 120B',
          buckets: [
            { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 0.0068, resetTime: '2026-11-26T13:59:24Z' },
            { bucketId: '3p-5h', window: '5h', remainingFraction: 1, resetTime: '2026-11-22T16:36:30Z' },
          ],
        },
      ],
    },
  };
  const unified = parseQuota(null, sharedModels, NOW, sharedSummary);
  assert.deepEqual(unified.pools.map((p) => p.category), ['claude_gpt']);
  assert.equal(unified.pools[0].limits.length, 2);

  // 2. Server-split shape (Claude Opus separated from Claude Sonnet / GPT-OSS with distinct quotaInfo & summary groups).
  const C_OPUS = { remainingFraction: 0.25, resetTime: '2026-11-25T10:00:00Z' };
  const C_SONNET = { remainingFraction: 0.80, resetTime: '2026-11-26T10:00:00Z' };
  const splitModels = {
    response: {
      models: {
        'claude-opus-5-5-high': { displayName: 'Claude Opus 5.5 (High)', maxTokens: 1000000, quotaInfo: C_OPUS, modelProvider: 'MODEL_PROVIDER_ANTHROPIC' },
        'claude-sonnet-5-5-high': { displayName: 'Claude Sonnet 5.5 (High)', maxTokens: 1000000, quotaInfo: C_SONNET, modelProvider: 'MODEL_PROVIDER_ANTHROPIC' },
        'gpt-oss-120b-medium': { displayName: 'GPT-OSS 120B (Medium)', maxTokens: 131072, quotaInfo: C_SONNET, modelProvider: 'MODEL_PROVIDER_OPENAI' },
      },
      agentModelSorts: [{ groups: [{ modelIds: ['claude-opus-5-5-high', 'claude-sonnet-5-5-high', 'gpt-oss-120b-medium'] }] }],
    },
  };
  const splitSummary = {
    response: {
      groups: [
        {
          displayName: 'Claude Opus models',
          buckets: [
            { bucketId: '3p-opus-weekly', window: 'weekly', remainingFraction: 0.25, resetTime: '2026-11-25T10:00:00Z' },
            { bucketId: 'opus-5h', window: '5h', remainingFraction: 0.5, resetTime: '2026-11-20T14:00:00Z' },
          ],
        },
        {
          displayName: 'Claude Sonnet and GPT models',
          buckets: [
            { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 0.80, resetTime: '2026-11-26T10:00:00Z' },
            { bucketId: '3p-5h', window: '5h', remainingFraction: 0.95, resetTime: '2026-11-20T13:00:00Z' },
          ],
        },
      ],
    },
  };
  const split = parseQuota(null, splitModels, NOW, splitSummary);
  assert.deepEqual(split.pools.map((p) => p.category), ['claude_opus', 'claude_gpt']);
  assert.deepEqual(split.weekly, {
    claude_opus: { remaining_fraction: 0.25, reset_time: '2026-11-25T10:00:00.000Z' },
    claude_gpt: { remaining_fraction: 0.8, reset_time: '2026-11-26T10:00:00.000Z' },
  });
  assert.deepEqual(split.pools[0].limits.map((l) => [l.kind, l.remaining_fraction]), [['weekly', 0.25], ['5h', 0.5]]);
  assert.deepEqual(split.pools[1].limits.map((l) => [l.kind, l.remaining_fraction]), [['weekly', 0.8], ['5h', 0.95]]);

  // 3. Disambiguates two colliding generic Claude summary groups without dropping either group's limits.
  const collidingSummary = parseQuotaSummary({
    groups: [
      { displayName: 'Claude Tier A', buckets: [{ bucketId: 'a-weekly', window: 'weekly', remainingFraction: 0.2, resetTime: '2026-11-27T00:00:00Z' }] },
      { displayName: 'Claude Tier B', buckets: [{ bucketId: 'b-weekly', window: 'weekly', remainingFraction: 0.9, resetTime: '2026-11-28T00:00:00Z' }] },
    ],
  }, NOW);
  assert.equal(Object.keys(collidingSummary.byCategory).length, 2);
  assert.equal(collidingSummary.weekly.claude_gpt.remaining_fraction, 0.2);
  assert.equal(collidingSummary.weekly.claude_tier_b.remaining_fraction, 0.9);

  // 4. buildModelCatalog & modelPool preserve dynamic pool slugs via poolOverrides.
  const cat = buildModelCatalog(splitModels, null, {
    'claude-opus-5-5-high': 'claude_opus',
    'claude-sonnet-5-5-high': 'claude_gpt',
    'gpt-oss-120b-medium': 'claude_gpt',
  });
  assert.equal(cat['claude-opus-5-5-high'].pool, 'claude_opus');
  assert.equal(modelPool('claude-opus-5-5-high', cat), 'claude_opus');
  assert.equal(modelPool('claude-sonnet-5-5-high', cat), 'claude_gpt');
});
