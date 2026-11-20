// Tests for the pure helpers in sidecars/context/main.mjs.
// Run (Node >= 18): node --test tests/test_main_helpers.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

process.env.CONTEXT_PANEL_NO_SERVER = '1';
const { NO_CACHE_HEADERS, inferLimit, parseQuota, redact, stampAssetUrls, truthy } = await import('../sidecars/context/main.mjs');

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
    assert.deepEqual(parseQuota(junk, junk, NOW), { pools: [], plan: null, tier: null });
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
