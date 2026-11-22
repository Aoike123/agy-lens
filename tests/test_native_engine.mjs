// Tests for the zero-Python pure-Node engine (lib/pb.mjs, lib/context.mjs,
// lib/history.mjs, lib/catalog.mjs, lib/pricing.mjs) and release ZIP builder.
// Run (Node >= 24): node --test tests/test_native_engine.mjs

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

import { RUNTIME_FILES, buildRelease, buildZipBuffer, collectRuntimeFiles } from '../scripts/build-release.mjs';
import { loadModelCatalog, modelLabel, modelPool } from '../sidecars/agy-lens/lib/catalog.mjs';
import {
  buildReport,
  collectSpeed,
  collectStats,
  load,
  parseGenerationSpeed,
  pbDurationSec,
} from '../sidecars/agy-lens/lib/context.mjs';
import {
  CACHE_VERSION,
  parseRoot,
  scan,
} from '../sidecars/agy-lens/lib/history.mjs';
import {
  Msg,
  encodeVarint,
  formatLocalIso,
  hasNodeSqlite,
  localDateKey,
  readVarint,
} from '../sidecars/agy-lens/lib/pb.mjs';
import { callCostInfo, loadPricingFile } from '../sidecars/agy-lens/lib/pricing.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const UTF8 = new TextEncoder();

// --- protobuf encoding helpers -----------------------------------------------

function pbVarint(n) {
  return encodeVarint(typeof n === 'bigint' ? n : BigInt.asUintN(64, BigInt(Math.trunc(n))));
}

function concat(...parts) {
  const bufs = parts.filter((p) => p && p.length);
  let len = 0;
  for (const b of bufs) len += b.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const b of bufs) {
    out.set(b, off);
    off += b.length;
  }
  return out;
}

function pbField(fn, val) {
  if (typeof val === 'number' || typeof val === 'bigint') {
    return concat(pbVarint(BigInt(fn) << 3n), pbVarint(val));
  }
  const bytes = typeof val === 'string' ? UTF8.encode(val) : val;
  return concat(pbVarint((BigInt(fn) << 3n) | 2n), pbVarint(bytes.length), bytes);
}

const pbMsg = (...parts) => concat(...parts);
const pbGroup = (tokenType, tokens, children = [], name = 'group') =>
  pbMsg(
    pbField(1, name),
    pbField(2, tokenType),
    pbField(4, tokens),
    ...children.map(([n, t]) => pbField(5, pbMsg(pbField(1, n), pbField(3, t)))),
  );
const pbUsage = ({ inp = 0, out = 0, cache = 0, think = 0, resp = 0 } = {}) =>
  pbMsg(
    inp ? pbField(2, inp) : null,
    out ? pbField(3, out) : null,
    cache ? pbField(5, cache) : null,
    think ? pbField(9, think) : null,
    resp ? pbField(10, resp) : null,
  );
const pbDuration = (sec, nanos = 0) => pbMsg(pbField(1, sec), nanos ? pbField(2, nanos) : null);
const pbTiming = (ttft, stream) =>
  pbMsg(
    ttft ? pbField(11, pbDuration(...ttft)) : null,
    stream ? pbField(12, pbDuration(...stream)) : null,
  );
const pbTs = (epochSec) => pbField(1, pbField(1, Math.trunc(epochSec)));

function createConvDb(dbPath, { genTable = true } = {}) {
  const db = new DatabaseSync(dbPath);
  db.exec(
    'CREATE TABLE steps (idx integer, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0, '
      + 'has_subtrajectory numeric NOT NULL DEFAULT false, metadata blob, error_details blob, permissions blob, '
      + 'task_details blob, render_info blob, step_payload blob, step_format integer NOT NULL DEFAULT 0, PRIMARY KEY (idx));',
  );
  if (genTable) {
    db.exec('CREATE TABLE gen_metadata (idx integer, data blob, size integer NOT NULL DEFAULT 0, PRIMARY KEY (idx));');
  }
  let idx = 0;
  let gIdx = 0;
  return {
    step(stepType, { metadata = new Uint8Array(0), payloadField = null, payload = new Uint8Array(0), status = 3 } = {}) {
      const pb = pbMsg(pbField(1, stepType), pbField(4, status), pbField(5, metadata), payloadField ? pbField(payloadField, payload) : null);
      db.prepare('INSERT INTO steps (idx, step_type, status, metadata, step_payload) VALUES (?, ?, ?, ?, ?)').run(
        idx++,
        stepType,
        status,
        metadata,
        pb,
      );
    },
    generation({
      groups = [],
      maxContext = 1_000_000,
      usage = new Uint8Array(0),
      checkpointIndex = -1,
      model = 'claude-opus-4-6',
      displayName = 'Claude Opus 4.6',
      responseModel = '',
      timing = new Uint8Array(0),
    } = {}) {
      const cwm = pbMsg(pbField(1, 0), pbField(3, pbMsg(...groups.map((g) => pbField(1, g)))), pbField(4, maxContext));
      const chat = pbMsg(
        pbField(4, usage),
        pbField(9, pbMsg(pbField(2, checkpointIndex), pbField(10, cwm))),
        responseModel ? pbField(19, responseModel) : null,
        displayName ? pbField(21, displayName) : null,
        timing,
      );
      const data = pbMsg(pbField(1, chat), model ? pbField(3, pbField(28, model)) : null);
      db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(gIdx++, data);
    },
    close() {
      db.close();
    },
  };
}

//Minimal ZIP central-directory parser to verify release archive structure & CRCs.
function parseZipEntries(zipBuf) {
  const view = new DataView(zipBuf.buffer, zipBuf.byteOffset, zipBuf.byteLength);
  let eocdOff = -1;
  for (let i = zipBuf.length - 22; i >= Math.max(0, zipBuf.length - 65558); i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) { eocdOff = i; break; }
  }
  assert.ok(eocdOff >= 0, 'EOCD signature not found');
  const count = view.getUint16(eocdOff + 10, true);
  let cdOff = view.getUint32(eocdOff + 16, true);
  const entries = new Map();
  for (let i = 0; i < count; i += 1) {
    assert.equal(view.getUint32(cdOff, true), 0x02014b50);
    const method = view.getUint16(cdOff + 10, true);
    const compSize = view.getUint32(cdOff + 20, true);
    const nameLen = view.getUint16(cdOff + 28, true);
    const extraLen = view.getUint16(cdOff + 30, true);
    const cmtLen = view.getUint16(cdOff + 32, true);
    const localOff = view.getUint32(cdOff + 42, true);
    const name = Buffer.from(zipBuf.subarray(cdOff + 46, cdOff + 46 + nameLen)).toString('utf8');
    assert.equal(view.getUint32(localOff, true), 0x04034b50);
    const lNameLen = view.getUint16(localOff + 26, true);
    const lExtraLen = view.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const compData = zipBuf.subarray(dataStart, dataStart + compSize);
    const raw = method === 0 ? Buffer.from(compData) : inflateRawSync(compData);
    entries.set(name, raw);
    cdOff += 46 + nameLen + extraLen + cmtLen;
  }
  return entries;
}

// --- tests -------------------------------------------------------------------

test('pb.mjs decodes 64-bit varints, signed32 negatives, timestamps and node:sqlite', async () => {
  assert.equal(await hasNodeSqlite(), true);
  const [v64] = readVarint(encodeVarint(1_763_650_000n), 0);
  assert.equal(v64, 1_763_650_000n);

  const raw = pbMsg(pbField(1, -1), pbField(2, 'hello · 世界'), pbField(3, pbField(1, 42)));
  const msg = new Msg(raw);
  assert.equal(msg.has(1), true);
  assert.equal(msg.int(1, true), -1);
  assert.equal(msg.str(2), 'hello · 世界');
  assert.equal(msg.msg(3).int(1), 42);
  assert.equal(msg.msg(99), null);

  // Field filter keeps only wanted tags.
  const filtered = new Msg(raw, new Set([3]));
  assert.equal(filtered.has(1), false);
  assert.equal(filtered.msg(3).int(1), 42);

  assert.match(formatLocalIso(1700000000), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  assert.equal(formatLocalIso(NaN), null);
});

test('lib/context.mjs handles breakdown, rehydration, checkpoints, speed outlier filtering & missing gen_metadata', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-lens-report-'));
  try {
    const dbPath = join(dir, 'conv-1.db');
    const db = createConvDb(dbPath);
    const t0 = 1795100000;
    db.step(14, { metadata: pbTs(t0), payloadField: 19, payload: pbField(2, 'Analyze the project') });
    // GENERIC step rehydrated as VIEW_FILE on SKILL.md via tool_call fallback
    const tc = pbMsg(pbField(2, 'view_file'), pbField(3, JSON.stringify({ AbsolutePath: '/tmp/skills/demo/SKILL.md' })));
    db.step(132, { metadata: pbMsg(pbField(4, tc)), payloadField: 140, payload: pbField(2, new Uint8Array(0)) });
    // Checkpoint + older summarized checkpoint
    const longIntent = 'Refactor payment module endpoints — '.repeat(4); // > 70 UTF-8 bytes
    db.step(23, { payloadField: 30, payload: pbMsg(pbField(1, 0), pbField(11, 0), pbField(12, 1), pbField(4, 'Old ck')) });
    db.step(23, { payloadField: 30, payload: pbMsg(pbField(1, 1), pbField(11, 2), pbField(12, 3), pbField(4, longIntent)) });
    db.step(15, { metadata: pbTs(t0 + 10), payloadField: 20, payload: pbField(1, 'Done!') });

    const groups = [
      pbGroup(1, 1500, [['skills', 200], ['flows', 300]]),
      pbGroup(2, 800),
      pbGroup(7, 600, [['14: USER_INPUT', 150], ['15: PLANNER_RESPONSE', 300], ['21: RUN_COMMAND', 150]]),
    ];
    // Calls: normal ~100 tok/s, outlier >3x median (~1600 tok/s at 0.55s), tiny burst (<0.5s)
    db.generation({ groups, usage: pbUsage({ inp: 1000, out: 100, cache: 500 }), checkpointIndex: 1, timing: pbTiming([2, 0], [1, 0]) });
    db.generation({ groups, usage: pbUsage({ inp: 1000, out: 200, cache: 500 }), checkpointIndex: 1, timing: pbTiming([2, 0], [2, 0]) });
    db.generation({ groups, usage: pbUsage({ inp: 1000, out: 300, cache: 500 }), checkpointIndex: 1, timing: pbTiming([2, 0], [3, 0]) });
    db.generation({ groups, usage: pbUsage({ inp: 1000, out: 880, cache: 500 }), checkpointIndex: 1, timing: pbTiming([3, 0], [0, 550_000_000]) }); // 1600 tok/s outlier
    db.generation({ groups, usage: pbUsage({ inp: 1000, out: 30, cache: 500 }), checkpointIndex: 1, timing: pbTiming([1, 0], [0, 100_000_000]) }); // <0.5s buffered
    db.close();

    const r = await buildReport({ dbPath, conversationId: 'conv-1', workspace: '' });
    assert.equal(r.model, 'Claude Opus 4.6');
    assert.equal(r.limit_tokens, 250_000);
    assert.equal(r.used_tokens, 2900); // 1000 + 200 + 300 + 800 + 150 + 300 + 150
    assert.equal(r.skill_files.length, 1);
    assert.equal(r.checkpoint_view.active_number, 2);
    assert.equal(r.checkpoint_view.historical, 1);
    assert.ok(UTF8.encode(r.checkpoint_view.active_text).length <= 70);
    assert.ok(r.checkpoint_view.active_text.endsWith('...'));

    // Speed: latest is buffered (<0.5s), outlier excluded from avg & recent streaming_tps.
    assert.equal(r.speed.calls, 5);
    assert.equal(r.speed.avg_streaming_tps, 100);
    assert.equal(r.speed.median_streaming_tps, 100);
    assert.equal(r.speed.latest.buffered, true);
    assert.equal(r.speed.latest.streaming_tps, null);
    assert.equal(r.speed.recent[3].buffered, true);
    assert.equal(r.speed.recent[3].streaming_tps, null);

    // Session totals across all 5 generations.
    assert.equal(r.session.calls, 5);
    assert.equal(r.session.input, 5000);
    assert.equal(r.session.output, 1510);
    assert.equal(r.session.total_tokens, 6510);
    assert.equal(r.session.cost_estimated, false);
    assert.equal(r.session.pricing_source, 'builtin');
    assert.equal(r.session.pool, 'claude_gpt');
    assert.equal(typeof r.session.d7_tokens, 'number');
    assert.ok('claude_gpt' in r.session.d7_by_pool && 'gemini' in r.session.d7_by_pool);

    // Missing gen_metadata table does not crash.
    const emptyDbPath = join(dir, 'no-gen.db');
    const edb = createConvDb(emptyDbPath, { genTable: false });
    edb.step(14, { payloadField: 19, payload: pbField(2, 'hi there') });
    edb.close();
    const r2 = await buildReport({ dbPath: emptyDbPath, conversationId: 'no-gen' });
    assert.equal(r2.speed, null);
    assert.equal(r2.session, null);
    assert.equal(r2.used_tokens, 2);

    assert.equal(modelLabel('claude-opus-5-5-medium'), 'Claude Opus 5.5 (Medium)');
    assert.equal(pbDurationSec(new Msg(pbDuration(1, 500_000_000))), 1.5);
    assert.equal(pbDurationSec(new Msg(pbDuration(-1, 0))), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lib/history.mjs scans windows, d7_by_pool, hourly_today, titles, cache v4 & pricing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-lens-hist-'));
  try {
    const deskDir = join(dir, 'antigravity', 'conversations');
    const cliDir = join(dir, 'antigravity-cli', 'conversations');
    mkdirSync(deskDir, { recursive: true });
    mkdirSync(cliDir, { recursive: true });

    const now = new Date(2026, 10, 20, 15, 30, 0); // 2026-11-20 15:30 local
    const todayTs = new Date(2026, 10, 20, 14, 10, 0).getTime() / 1000;
    const oldTs = new Date(2026, 10, 5, 10, 0, 0).getTime() / 1000; // 15d ago (in d30, outside d7)

    // Summary DB with official title & "self" subagent marker.
    const sumDb = new DatabaseSync(join(dir, 'antigravity', 'conversation_summaries.db'));
    sumDb.exec('CREATE TABLE conversation_summaries (conversation_id text, title text, preview text, agent_name text);');
    sumDb.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?)').run('conv-a', 'Official Title A', '', '');
    sumDb.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?)').run('conv-sub', '', '', 'self');
    sumDb.close();

    const dbA = createConvDb(join(deskDir, 'conv-a.db'));
    dbA.step(14, { metadata: pbTs(oldTs), payloadField: 19, payload: pbField(2, 'First user msg') });
    dbA.step(15, { metadata: pbTs(oldTs), payloadField: 20, payload: pbField(1, 'r1') });
    dbA.step(15, { metadata: pbTs(todayTs), payloadField: 20, payload: pbField(1, 'r2') });
    dbA.generation({ model: 'gemini-4-neon-high', displayName: 'Gemini 4 Neon (High)', usage: pbUsage({ inp: 1000, out: 500, cache: 2000 }) });
    dbA.generation({ model: 'claude-opus-4-6', displayName: 'Claude Opus 4.6', usage: pbUsage({ inp: 400, out: 100, cache: 500 }) });
    dbA.close();

    const dbSub = createConvDb(join(cliDir, 'conv-sub.db'));
    dbSub.step(15, { metadata: pbTs(todayTs), payloadField: 20, payload: pbField(1, 'sub') });
    dbSub.generation({ model: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', usage: pbUsage({ inp: 200, out: 50, cache: 100 }) });
    dbSub.close();

    // No gen_metadata DB + corrupt DB.
    const dbEmpty = createConvDb(join(deskDir, 'empty-conv.db'), { genTable: false });
    dbEmpty.close();
    writeFileSync(join(deskDir, 'corrupt.db'), 'not a sqlite file');

    const cachePath = join(dir, 'cache.json');
    const stats = {};
    const r = await scan(
      [[deskDir, 'desktop'], [cliDir, 'cli']],
      { cachePath, days: 30, now, stats },
    );
    assert.equal(r.errors, 1);
    assert.equal(r.sources.desktop, 2); // conv-a + empty-conv
    assert.equal(r.sources.cli, 1);
    assert.equal(stats.misses, 4); // 3 desktop (incl. corrupt) + 1 cli
    assert.equal(r.totals.today.calls, 2);
    assert.equal(r.totals.d7.calls, 2);
    assert.equal(r.totals.d30.calls, 3);
    assert.equal(r.d7_by_pool.claude_gpt, 500);
    assert.equal(r.d7_by_pool.gemini, 250);
    assert.equal(r.hourly_today[14].calls, 2);
    assert.equal(r.hourly_today[14].tokens, 1000 + 350);

    const convA = r.by_conversation.find((c) => c.id === 'conv-a');
    assert.equal(convA.title, 'Official Title A');
    assert.equal(convA.is_subagent, false);
    assert.equal(convA.d7_tokens, 500);
    assert.equal(convA.cost_estimated, false); // gemini-4-neon and claude-opus-4-6 both have published prices
    const convSub = r.by_conversation.find((c) => c.id === 'conv-sub');
    assert.equal(convSub.title, null);
    assert.equal(convSub.is_subagent, true);
    assert.equal(convSub.source, 'cli');

    // Second scan hits v4 cache.
    const cacheData = JSON.parse(readFileSync(cachePath, 'utf8'));
    assert.equal(cacheData.version, CACHE_VERSION);
    const stats2 = {};
    await scan([[deskDir, 'desktop'], [cliDir, 'cli']], { cachePath, days: 30, now, stats: stats2 });
    assert.equal(stats2.hits, 3);
    assert.equal(stats2.misses, 1); // corrupt.db was not cached

    // Custom pricing file overrides built-in list.
    const pFile = join(dir, 'pricing.json');
    writeFileSync(pFile, JSON.stringify({
      source: 'litellm',
      fetched_at: '2026-11-21T00:00:00Z',
      models: { 'gemini-4-neon-high': { input: 2, output: 10, cache_read: 0.2 } },
    }));
    const [prices, src] = loadPricingFile(pFile);
    assert.equal(src, 'litellm');
    const [cost, isEst] = callCostInfo('gemini-4-neon-high', 1_000_000, 0, 0, prices);
    assert.equal(cost, 2);
    assert.equal(isEst, false);
    assert.equal(modelPool('gemini-pro-orchestrator-neon'), 'gemini');
    assert.equal(modelPool('gpt-oss-120b-medium'), 'claude_gpt');
    assert.equal(modelPool('orchestrator-claude-opus-5-5'), 'claude_gpt');
    assert.deepEqual(callCostInfo('orchestrator-claude-opus-5-5', 1_000_000, 0, 0), [5, true]);
    const catPath = join(dir, 'catalog.json');
    writeFileSync(catPath, JSON.stringify({
      'mystery-orch-v9': { maxTokens: 500000, displayName: 'Mystery Claude Orch', provider: 'MODEL_PROVIDER_ANTHROPIC', pool: 'claude_gpt' },
    }));
    const cat = loadModelCatalog(catPath);
    assert.equal(modelPool('mystery-orch-v9', cat), 'claude_gpt');
    assert.deepEqual(parseRoot('C:/foo/bar=cli'), ['C:/foo/bar', 'cli']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildZipBuffer produces valid PKZIP entries (store + deflate, UTF-8 names)', () => {
  const small = Buffer.from('hi');
  const compressible = Buffer.from('agy-lens-'.repeat(200), 'utf8');
  const zipBuf = buildZipBuffer([
    { name: 'agy-lens/tiny.txt', data: small, mtime: new Date('2026-11-20T12:00:00Z') },
    { name: 'agy-lens/目录/large.json', data: compressible, mtime: new Date('2026-11-20T12:00:00Z') },
  ]);
  const entries = parseZipEntries(zipBuf);
  assert.deepEqual(Array.from(entries.keys()).sort(), ['agy-lens/tiny.txt', 'agy-lens/目录/large.json']);
  assert.deepEqual(entries.get('agy-lens/tiny.txt'), small);
  assert.deepEqual(entries.get('agy-lens/目录/large.json'), compressible);
});

test('release ZIP contains all runtime files, zero .py files, and valid SHA256SUMS', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'agy-lens-dist-'));
  try {
    const res = buildRelease(ROOT, outDir);
    const zipBuf = readFileSync(res.genericPath);
    const entries = parseZipEntries(zipBuf);
    const prefix = 'agy-lens';
    assert.ok(res.genericPath.endsWith('agy-lens.zip'));
    assert.ok(res.versionedPath.endsWith(`agy-lens-v${res.version}.zip`));
    const runtimeFiles = collectRuntimeFiles(ROOT);
    const expected = runtimeFiles.map((f) => `${prefix}/${f}`).sort();
    assert.deepEqual(Array.from(entries.keys()).sort(), expected);
    for (const req of [
      'agy-lens/plugin.json',
      'agy-lens/package.json',
      'agy-lens/bin/cli.mjs',
      'agy-lens/sidecars/agy-lens/main.mjs',
      'agy-lens/sidecars/agy-lens/lib/pb.mjs',
      'agy-lens/sidecars/agy-lens/web/index.html',
    ]) {
      assert.ok(entries.has(req), `Missing required entry: ${req}`);
    }
    for (const name of entries.keys()) {
      assert.equal(/\.(py|pyc|pyo)$/i.test(name), false, `ZIP must not contain Python file: ${name}`);
      for (const bad of ['/tests/', '/docs/img/', '/.data/', '/dist/']) {
        assert.equal(name.includes(bad), false, `ZIP must not contain ${bad}: ${name}`);
      }
    }
    for (const rel of runtimeFiles) {
      assert.deepEqual(entries.get(`${prefix}/${rel}`), readFileSync(join(ROOT, rel)));
    }
    const sha = createHash('sha256').update(zipBuf).digest('hex');
    const sums = readFileSync(join(outDir, 'SHA256SUMS.txt'), 'utf8');
    assert.ok(sums.includes(`${sha}  ${prefix}.zip`));
    assert.ok(sums.includes(`${sha}  ${prefix}-v${res.version}.zip`));
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
