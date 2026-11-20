// Tests for the pure helpers in sidecars/context/main.mjs.
// Run: node tests/test_main_helpers.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.CONTEXT_PANEL_NO_SERVER = '1';
const { parseQuota, redact, truthy } = await import('../sidecars/context/main.mjs');

test('truthy handles query strings and booleans', () => {
  for (const v of [true, 'true', 'TRUE', '1', 1, 'yes']) assert.equal(truthy(v), true, String(v));
  for (const v of [false, 'false', '0', '', undefined, null, 0]) assert.equal(truthy(v), false, String(v));
});

test('parseQuota groups GetAvailableModels models with identical quota', () => {
  const models = {
    response: {
      models: {
        'gemini-3-pro': { displayName: 'Gemini 3 Pro', maxTokens: 1048576, quotaInfo: { remainingFraction: 0.8, resetTime: '2026-11-20T12:00:00Z' } },
        'gemini-3-flash': { displayName: 'Gemini 3 Flash', quotaInfo: { remainingFraction: 0.8, resetTime: '2026-11-20T12:00:00Z' } },
        'claude-sonnet': { displayName: 'Claude Sonnet', quotaInfo: { remainingFraction: 0.1, resetTime: '2026-11-21T00:00:00Z' } },
        'no-quota': { displayName: 'No Quota' },
      },
    },
  };
  const r = parseQuota(null, models);
  assert.equal(r.pools.length, 2);
  assert.equal(r.pools[0].label, 'Claude Sonnet');
  assert.equal(r.pools[0].remaining_fraction, 0.1);
  assert.equal(r.pools[0].reset_time, '2026-11-21T00:00:00.000Z');
  assert.deepEqual(r.pools[1].models.map((m) => m.id), ['gemini-3-flash', 'gemini-3-pro']);
  assert.equal(r.pools[1].id, 'gemini-3-flash');
  assert.equal(r.pools[1].label, 'Gemini 3 Flash / Gemini 3 Pro');
  assert.equal(r.plan, null);
});

test('parseQuota reads GetUserStatus clientModelConfigs and plan', () => {
  const status = {
    userStatus: {
      email: 'someone@example.com',
      planStatus: { planInfo: { planName: 'Pro' } },
      cascadeModelConfigData: {
        clientModelConfigs: [
          { label: 'Model A', modelOrAlias: { model: 'MODEL_A' }, quotaInfo: { resetTime: '2026-11-20T10:00:00Z' } },
          { label: 'Model B', modelOrAlias: { model: 'MODEL_B' }, quotaInfo: { remainingFraction: 1 } },
          { label: 'Model C', modelOrAlias: { model: 'MODEL_C' }, quotaInfo: {} },
        ],
      },
    },
  };
  const r = parseQuota(status, null);
  assert.equal(r.plan, 'Pro');
  // A: fraction omitted (proto3 zero) with a reset time -> 0, sorted first.
  assert.equal(r.pools[0].models[0].id, 'MODEL_A');
  assert.equal(r.pools[0].remaining_fraction, 0);
  assert.equal(r.pools[1].remaining_fraction, 1);
  assert.equal(r.pools[1].reset_time, null);
  // C: no data at all -> null fraction, sorted last.
  assert.equal(r.pools[2].remaining_fraction, null);
});

test('parseQuota merges both sources and survives garbage', () => {
  const models = { models: { MODEL_A: { displayName: 'Nice A' } } };
  const status = { userStatus: { cascadeModelConfigData: { clientModelConfigs: [
    { label: 'A', modelOrAlias: { model: 'MODEL_A' }, quotaInfo: { remainingFraction: '0.5', resetTime: { seconds: 1700000000 } } },
  ] } } };
  const r = parseQuota(status, models);
  assert.equal(r.pools.length, 1);
  assert.equal(r.pools[0].models[0].display_name, 'Nice A');
  assert.equal(r.pools[0].remaining_fraction, 0.5);
  assert.equal(r.pools[0].reset_time, new Date(1700000000 * 1000).toISOString());

  for (const junk of [null, undefined, 42, 'x', [], {}, { models: 'nope' }, { userStatus: null }]) {
    assert.deepEqual(parseQuota(junk, junk), { pools: [], plan: null });
  }
});

test('redact removes emails, tokens and secret fields', () => {
  const r = redact({
    email: 'a@b.com',
    note: 'contact me at someone@example.org please',
    apiKey: 'abc',
    accessToken: 'xyz',
    maxTokens: 100,
    nested: [{ idToken: 'eyJhbGciOiJIUzI1NiJ9xxxx.eyJzdWIiOiIxMjM0NTY3ODkwIn0yyyy.abcdefghijklmnop' }],
    header: 'Bearer abc.def',
    plain: 'Gemini 3 Pro',
  });
  assert.equal(r.email, '[redacted]');
  assert.equal(r.note, 'contact me at [email] please');
  assert.equal(r.apiKey, '[redacted]');
  assert.equal(r.accessToken, '[redacted]');
  assert.equal(r.maxTokens, 100);
  assert.equal(r.nested[0].idToken, '[redacted]');
  assert.equal(r.header, '[redacted]');
  assert.equal(r.plain, 'Gemini 3 Pro');
});
