// Comprehensive unit tests for sidecars/agy-lens/lib/*.mjs
// Migrated from the former Python unit test suites plus ANTIGRAVITY_GEMINI_DIR,
// pb.mjs filesystem helpers, pricing meta, and catalog/quota coverage.
// Run (Node >= 24): node --test tests/test_lib_units.mjs

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  NATIVE_CONTEXT_WINDOWS,
  POOLS,
  buildModelCatalog,
  contextLimit,
  loadModelCatalog,
  modelLabel,
  modelPool,
  writeModelCatalog,
} from '../sidecars/agy-lens/lib/catalog.mjs';
import {
  buildReport,
  checkpointNewerThanGeneration,
  collectSession,
  collectSpeed,
  collectStats,
  compactionTokens,
  cliMain as contextCliMain,
  defaultConversationsDir,
  detectSystemFiles,
  findLatestDb,
  fmtTok,
  loadGenerations,
  parseGenerationSpeed,
  pbDurationSec,
  render,
  renderGrid,
  renderStats,
  shortenPath,
} from '../sidecars/agy-lens/lib/context.mjs';
import {
  CACHE_VERSION,
  MAX_CONVERSATIONS,
  TITLE_MAX,
  defaultRoots,
  generationTime,
  generationTimestamps,
  cliMain as historyCliMain,
  parseGeneration,
  parseRoot,
  scan,
} from '../sidecars/agy-lens/lib/history.mjs';
import {
  Msg,
  defaultGeminiDir,
  encodeVarint,
  expandHome,
  fileStamp,
  openReadOnlyDb,
  roundN,
  writeJsonAtomic,
} from '../sidecars/agy-lens/lib/pb.mjs';
import {
  callCost,
  callCostInfo,
  costOf,
  loadPricingFile,
  priceFor,
  priceInfo,
  readPricingMeta,
} from '../sidecars/agy-lens/lib/pricing.mjs';
import { fetchQuota, lsRequest, parseQuota, redact } from '../sidecars/agy-lens/lib/quota.mjs';

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
const pbUserInput = (text) => pbField(2, text);
const pbPlanner = (text) => pbField(1, text);
const pbUsage = ({ inp = 0, out = 0, cache = 0, think = 0, resp = 0 } = {}) =>
  pbMsg(
    inp ? pbField(2, inp) : null,
    out ? pbField(3, out) : null,
    cache ? pbField(5, cache) : null,
    think ? pbField(9, think) : null,
    resp ? pbField(10, resp) : null,
  );
const pbDuration = (sec = null, nanos = null) =>
  pbMsg(sec !== null ? pbField(1, sec) : null, nanos !== null ? pbField(2, nanos) : null);
const pbTiming = (ttft = null, streaming = null) =>
  pbMsg(ttft !== null ? pbField(11, ttft) : null, streaming !== null ? pbField(12, streaming) : null);
const pbToolCall = (args, name = 'tool') => pbField(4, pbMsg(pbField(2, name), pbField(3, args)));
const pbTs = (epochSec) => pbField(1, pbField(1, Math.trunc(epochSec)));

function speedGen({
  output = 0,
  thinking = 0,
  inputTokens = 0,
  cacheRead = 0,
  response = 0,
  ttft = null,
  streaming = null,
  responseModel = '',
  display = '',
  plannerModel = '',
} = {}) {
  const u = pbUsage({ inp: inputTokens, out: output, cache: cacheRead, think: thinking, resp: response });
  const chat = pbMsg(
    pbField(4, u),
    pbTiming(ttft, streaming),
    responseModel ? pbField(19, responseModel) : null,
    display ? pbField(21, display) : null,
  );
  return new Msg(pbMsg(pbField(1, chat), plannerModel ? pbField(3, pbField(28, plannerModel)) : null));
}

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
      model = 'test-model',
      displayName = 'Test Model',
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

function makeHistoryDb(dbPath, calls, { plannerSteps = true, firstInput = 'hello' } = {}) {
  const conn = new DatabaseSync(dbPath);
  conn.exec(
    'CREATE TABLE steps (idx integer, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0, '
      + 'has_subtrajectory numeric NOT NULL DEFAULT false, metadata blob, error_details blob, permissions blob, '
      + 'task_details blob, render_info blob, step_payload blob, step_format integer NOT NULL DEFAULT 0, PRIMARY KEY (idx));',
  );
  conn.exec('CREATE TABLE gen_metadata (idx integer, data blob, size integer NOT NULL DEFAULT 0, PRIMARY KEY (idx));');
  let step = 0;
  for (let i = 0; i < calls.length; i += 1) {
    const c = calls[i];
    const u = pbMsg(
      pbField(2, c.input ?? 0),
      pbField(3, c.output ?? 0),
      pbField(5, c.cache ?? 0),
      pbField(9, c.thinking ?? 0),
    );
    const where = c.model_field ?? 'planner';
    const chat = pbMsg(
      pbField(4, u),
      where === 'response' && c.model ? pbField(19, c.model) : null,
      c.display ? pbField(21, c.display) : null,
    );
    const data = pbMsg(
      pbField(1, chat),
      where === 'planner' && c.model ? pbField(3, pbField(28, c.model)) : null,
    );
    conn.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(i, data);
    conn.prepare('INSERT INTO steps (idx, step_type, metadata, step_payload) VALUES (?, 14, ?, ?)').run(
      step++,
      pbTs(c.ts),
      pbMsg(pbField(1, 14), pbField(19, pbField(2, i === 0 ? firstInput : 'more'))),
    );
    if (plannerSteps) {
      conn.prepare('INSERT INTO steps (idx, step_type, metadata) VALUES (?, 15, ?)').run(
        step++,
        pbField(1, pbMsg(pbField(1, Math.trunc(c.ts)), pbField(2, 5))),
      );
    }
  }
  conn.close();
}

const byCategoryName = (report) => Object.fromEntries(report.categories.map((c) => [c.name, c.tokens]));

function addBasicSteps(db) {
  db.step(14, { payloadField: 19, payload: pbUserInput('hello world!!') }); // 13 bytes -> 3
  db.step(15, { metadata: pbField(9, pbUsage({ inp: 900, out: 50 })), payloadField: 20, payload: pbPlanner('r'.repeat(400)) });
  db.step(132, { metadata: pbToolCall('a'.repeat(40)) }); // 40 bytes -> 10
}

// --- Report tests (migrated from ReportTest) ---------------------------------

test('ReportTest: exact breakdown from all 10 token groups, user_rules, FINISH & CHECKPOINT', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-unit-rep-'));
  try {
    const dbPath = join(dir, 'conv.db');
    const db = createConvDb(dbPath);
    addBasicSteps(db);
    db.generation({
      groups: [
        pbGroup(1, 1000, [['skills', 200], ['user_rules', 50], ['subagents', 30], ['flows', 20]]),
        pbGroup(2, 500),
        pbGroup(3, 30),
        pbGroup(4, 40),
        pbGroup(7, 370, [['0: USER_INPUT', 20], ['1: PLANNER_RESPONSE', 200], ['2: GENERIC', 80], ['3: FINISH', 30], ['4: CHECKPOINT', 40]]),
        pbGroup(8, 11),
        pbGroup(9, 12),
        pbGroup(10, 13),
      ],
    });
    db.close();

    const r = await buildReport({ dbPath, conversationId: 'conv' });
    const c = byCategoryName(r);
    assert.equal(c['User messages'], 20);
    assert.equal(c['Agent responses'], 240); // planner + checkpoint
    assert.equal(c['Tool calls'], 80);
    assert.equal(c['System messages'], 30); // FINISH
    assert.equal(c['System prompt'], 750); // user_rules stays in system_prompt
    assert.equal(c['Skills'], 200);
    assert.equal(c['Subagents'], 30);
    assert.equal(c['Workflows'], 33); // flows item + FLOWS group
    assert.equal(c['Legacy workflows'], 11);
    assert.equal(c['Plugins'], 12);
    assert.equal(c['Rules'], 30);
    assert.equal(c['MCP tools'], 40);
    assert.equal('System overhead' in c, false);
    assert.equal(r.used_tokens, Object.values(c).reduce((a, b) => a + b, 0));
    assert.equal(r.limit_tokens, 1_000_000);
    assert.equal(r.has_breakdown, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ReportTest: latest generation wins, unknown item scaling, overhead rules, awaiting gen, tool output override', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-unit-rep2-'));
  try {
    // 1. Latest generation wins over larger earlier one
    const p1 = join(dir, 'latest.db');
    const db1 = createConvDb(p1);
    addBasicSteps(db1);
    db1.generation({ groups: [pbGroup(1, 90000), pbGroup(7, 10, [['0: USER_INPUT', 10]])] });
    db1.generation({ groups: [pbGroup(1, 100), pbGroup(7, 10, [['0: USER_INPUT', 10]])] });
    db1.close();
    assert.equal(byCategoryName(await buildReport({ dbPath: p1 }))['System prompt'], 100);

    // 2. Unknown chat item scales step estimates (3, 50, 10) * 5 = (15, 250, 50)
    const p2 = join(dir, 'scale.db');
    const db2 = createConvDb(p2);
    addBasicSteps(db2);
    db2.generation({ groups: [pbGroup(7, 315, [['0: USER_INPUT', 20], ['1: NOT_A_STEP_TYPE', 1]])] });
    db2.close();
    const c2 = byCategoryName(await buildReport({ dbPath: p2 }));
    assert.deepEqual([c2['User messages'], c2['Agent responses'], c2['Tool calls']], [15, 250, 50]);

    // 2b. When step estimates are 0 and chatTok > 0, est===0 assigns chatTok to agent
    const p2b = join(dir, 'zeroest.db');
    const db2b = createConvDb(p2b);
    db2b.generation({ groups: [pbGroup(7, 123, [['0: NOT_A_STEP_TYPE', 1]])] });
    db2b.close();
    assert.equal(byCategoryName(await buildReport({ dbPath: p2b }))['Agent responses'], 123);

    // 3. System overhead only when neither prompt nor tools seen
    const p3 = join(dir, 'overhead.db');
    const db3 = createConvDb(p3);
    addBasicSteps(db3);
    db3.generation({ groups: [pbGroup(7, 300, [['0: USER_INPUT', 300]])], usage: pbUsage({ inp: 1000, cache: 500 }) });
    db3.close();
    assert.equal(byCategoryName(await buildReport({ dbPath: p3 }))['System overhead'], 1200);

    const p4 = join(dir, 'no-overhead.db');
    const db4 = createConvDb(p4);
    addBasicSteps(db4);
    db4.generation({ groups: [pbGroup(1, 100), pbGroup(7, 300, [['0: USER_INPUT', 300]])], usage: pbUsage({ inp: 1000, cache: 500 }) });
    db4.close();
    assert.equal('System overhead' in byCategoryName(await buildReport({ dbPath: p4 })), false);

    // 4. Awaiting generation uses step estimates + FINISH step
    const p5 = join(dir, 'await.db');
    const db5 = createConvDb(p5);
    addBasicSteps(db5);
    db5.step(2, { metadata: pbToolCall('b'.repeat(8)) }); // FINISH
    db5.close();
    const r5 = await buildReport({ dbPath: p5 });
    const c5 = byCategoryName(r5);
    assert.equal(r5.has_breakdown, false);
    assert.deepEqual([c5['User messages'], c5['Agent responses'], c5['Tool calls'], c5['System messages']], [3, 50, 10, 2]);
    assert.equal(r5.limit_tokens, 0);
    assert.ok(r5.text.includes('Estimated usage (awaiting generation)'));

    // 5. md.int(23, true) tool_call output tokens take precedence over byte estimate
    const p6 = join(dir, 'tc-out.db');
    const db6 = createConvDb(p6);
    db6.step(132, { metadata: pbMsg(pbToolCall('a'.repeat(400)), pbField(23, 7)) });
    db6.close();
    assert.equal(byCategoryName(await buildReport({ dbPath: p6 }))['Tool calls'], 7);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ReportTest: compaction zeroes prior steps, compactionTokens retries, checkpoint not newer, checkpoint buffer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-unit-ck-'));
  try {
    // Active newer checkpoint zeroes prior steps
    const p1 = join(dir, 'compact.db');
    const db1 = createConvDb(p1);
    addBasicSteps(db1);
    db1.step(23, {
      payloadField: 30,
      payload: pbMsg(pbField(1, 0), pbField(11, 0), pbField(12, 2), pbField(4, 'Fix the login bug'), pbField(5, 's'.repeat(383))),
    });
    db1.step(14, { payloadField: 19, payload: pbUserInput('next question please') }); // 20 -> 5
    db1.generation({ groups: [pbGroup(1, 800), pbGroup(7, 370, [['0: USER_INPUT', 370]])] });
    db1.close();
    const r1 = await buildReport({ dbPath: p1 });
    const c1 = byCategoryName(r1);
    assert.equal(r1.compacted, true);
    assert.equal(c1['User messages'], 5);
    assert.equal(c1['Agent responses'], 100); // (17 + 383) / 4
    assert.equal(c1['Tool calls'], 0);
    assert.equal(c1['System prompt'], 800);
    assert.equal(r1.active_checkpoint, 0);
    assert.ok(r1.text.includes('Estimated after compaction · updates next turn'));
    assert.ok(r1.text.includes('Checkpoints (1) · /rewind'));
    assert.ok(r1.text.includes('└ Checkpoint 1 (active, in context): Fix the login bug'));

    // Direct compactionTokens() tests (resp field 10 vs out - thinking)
    const stepResp = { md: new Msg(pbField(28, pbField(2, pbUsage({ out: 500, think: 100, resp: 222 })))) };
    assert.equal(compactionTokens(stepResp), 222);
    const stepDiff = { md: new Msg(pbField(28, pbField(2, pbUsage({ out: 500, think: 120 })))) };
    assert.equal(compactionTokens(stepDiff), 380);
    assert.equal(compactionTokens({ md: new Msg(null) }), 0);

    // Checkpoint already in generation is not newer; empty intent falls back to "steps 0–2"
    const p2 = join(dir, 'not-newer.db');
    const db2 = createConvDb(p2);
    addBasicSteps(db2);
    db2.step(23, { payloadField: 30, payload: pbMsg(pbField(1, 0), pbField(11, 0), pbField(12, 2)) });
    db2.generation({ groups: [pbGroup(7, 10, [['0: USER_INPUT', 10]])], checkpointIndex: 0 });
    db2.close();
    const r2 = await buildReport({ dbPath: p2 });
    assert.equal(r2.compacted, false);
    assert.ok(r2.text.includes('steps 0–2'));
    assert.deepEqual(checkpointNewerThanGeneration([], null), [-1, null]);

    // Checkpoint buffer excluded from categories and used_tokens
    const p3 = join(dir, 'buf.db');
    const db3 = createConvDb(p3);
    db3.step(23, { metadata: pbToolCall('c'.repeat(80)), payloadField: 30, payload: pbField(1, 0) });
    db3.step(15, { metadata: pbField(9, pbUsage({ inp: 0, out: 5 })), payloadField: 20, payload: pbPlanner('x') });
    db3.close();
    const r3 = await buildReport({ dbPath: p3 });
    assert.equal(r3.checkpoint_buffer, 20);
    assert.equal(r3.used_tokens, 5);
    assert.equal(Object.values(byCategoryName(r3)).includes(20), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ReportTest: file sections, packed GENERIC rehydration, detectSystemFiles & ANTIGRAVITY_GEMINI_DIR', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-unit-files-'));
  const prevGemini = process.env.ANTIGRAVITY_GEMINI_DIR;
  try {
    const fakeHome = join(dir, 'home');
    const gemDir = join(fakeHome, '.gemini');
    const wsDir = join(dir, 'ws');
    mkdirSync(join(gemDir, 'skills'), { recursive: true });
    writeFileSync(join(gemDir, 'GEMINI.md'), 'x');
    mkdirSync(join(gemDir, 'antigravity', 'skills'), { recursive: true });
    mkdirSync(join(gemDir, 'config', 'skills'), { recursive: true }); // excluded
    mkdirSync(join(wsDir, '.agents', 'rules'), { recursive: true });
    writeFileSync(join(wsDir, '.agents', 'hooks.json'), '{}');

    // Direct detectSystemFiles check
    assert.deepEqual(
      detectSystemFiles(fakeHome, wsDir, 'antigravity').map(([p]) => p),
      ['~/.gemini/GEMINI.md', '~/.gemini/skills/', '~/.gemini/antigravity/skills/', '.agents/rules/', '.agents/hooks.json'],
    );

    // ANTIGRAVITY_GEMINI_DIR respected by defaultConversationsDir, findLatestDb, buildReport, cliMain
    const customGemini = join(dir, 'custom-gem');
    const convsDir = join(customGemini, 'antigravity', 'conversations');
    mkdirSync(join(customGemini, 'skills'), { recursive: true });
    writeFileSync(join(customGemini, 'GEMINI.md'), 'custom');
    mkdirSync(convsDir, { recursive: true });
    process.env.ANTIGRAVITY_GEMINI_DIR = customGemini;
    assert.equal(defaultGeminiDir(), resolve(customGemini));
    assert.equal(defaultConversationsDir('antigravity'), resolve(convsDir));

    const homeUri = 'file:///' + homedir().replace(/\\/g, '/').replace(/^\/+/, '');
    const dbPath = join(convsDir, '11111111-1111-1111-1111-111111111111.db');
    const db = createConvDb(dbPath);
    db.step(8, { metadata: pbToolCall('v'.repeat(40)), payloadField: 14, payload: pbMsg(pbField(1, `${homeUri}/.gemini/skills/foo/SKILL.md`), pbField(17, 1)) });
    const edit = (p) => pbField(2, pbField(1, pbField(8, `${homeUri}${p}`)));
    db.step(5, { metadata: pbToolCall('w'.repeat(80)), payloadField: 10, payload: pbMsg(edit('/brain/task.md'), pbField(21, 1)) });
    db.step(5, { metadata: pbToolCall('w'.repeat(80)), payloadField: 10, payload: pbMsg(edit('/brain/task.md'), pbField(21, 1)) }); // deduped
    db.step(5, { metadata: pbToolCall('k'.repeat(40)), payloadField: 10, payload: pbMsg(edit('/knowledge/a.md'), pbField(24, 1)) });

    // Packed original step via msg(6) and via __original_cortex_step msgs(5)
    const orig6 = pbMsg(pbField(1, 5), pbField(4, 3), pbField(5, pbToolCall('w'.repeat(80))), pbField(10, pbMsg(edit('/brain/plan.md'), pbField(21, 1))));
    const packed6 = pbMsg(pbField(1, 'type.googleapis.com/gemini_coder.Step'), pbField(2, orig6));
    db.step(132, { metadata: pbToolCall('ignored'), payloadField: 140, payload: pbField(2, pbField(6, packed6)) });

    const orig5 = pbMsg(pbField(1, 5), pbField(4, 3), pbField(5, pbToolCall('w'.repeat(40))), pbField(10, pbMsg(edit('/knowledge/b.md'), pbField(24, 1))));
    const packed5 = pbMsg(pbField(1, 'type.googleapis.com/gemini_coder.Step'), pbField(2, orig5));
    db.step(132, { metadata: pbToolCall('ignored'), payloadField: 140, payload: pbField(2, pbField(5, pbMsg(pbField(1, '__original_cortex_step'), pbField(2, packed5)))) });
    db.close();

    assert.equal(findLatestDb(), resolve(dbPath));
    const r = await buildReport({ dbPath: null, workspace: wsDir });
    assert.deepEqual(r.skill_files, [{ path: '~/.gemini/skills/foo/SKILL.md', tokens: 10 }]);
    assert.deepEqual(r.artifact_files, [
      { path: '~/brain/task.md', tokens: 20 },
      { path: '~/brain/plan.md', tokens: 20 },
    ]);
    assert.deepEqual(r.knowledge_files, [
      { path: '~/knowledge/a.md', tokens: 10 },
      { path: '~/knowledge/b.md', tokens: 10 },
    ]);
    assert.ok(r.system_files.some((s) => s.path.endsWith('/GEMINI.md')));
    assert.ok(r.system_files.some((s) => s.path.endsWith('/skills/')));
    assert.ok(r.system_files.some((s) => s.path === '.agents/rules/'));
    assert.ok(r.system_files.some((s) => s.path === '.agents/hooks.json'));
    assert.ok(r.text.includes('Knowledge files · /rules\n └ ~/knowledge/a.md: 10 tokens'));
    assert.ok(r.text.includes('System files · auto-loaded\n'));

    // cliMain honors ANTIGRAVITY_GEMINI_DIR when --db is omitted
    let captured = '';
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => { captured += String(chunk); return true; };
    let code;
    try {
      code = await contextCliMain(['--json', '--workspace', wsDir]);
    } finally {
      process.stdout.write = origWrite;
    }
    assert.equal(code, 0);
    const cliJson = JSON.parse(captured);
    assert.equal(cliJson.conversation_id, '11111111-1111-1111-1111-111111111111');
    assert.ok(cliJson.system_files.some((s) => s.path.endsWith('/GEMINI.md')));
  } finally {
    if (prevGemini === undefined) delete process.env.ANTIGRAVITY_GEMINI_DIR;
    else process.env.ANTIGRAVITY_GEMINI_DIR = prevGemini;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ReportTest & FormatTest: model catalog override, unknown request budget, render/grid/stats, modelLabel, windows, fmtTok', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-unit-fmt-'));
  try {
    // Native window & label from model_id
    const p1 = join(dir, 'native.db');
    const db1 = createConvDb(p1);
    addBasicSteps(db1);
    db1.generation({ groups: [pbGroup(7, 300, [['0: USER_INPUT', 300]])], maxContext: 256_000, model: 'gemini-3.8-flash-medium', displayName: '' });
    db1.close();
    const r1 = await buildReport({ dbPath: p1 });
    assert.equal(r1.model, 'Gemini 3.8 Flash (Medium)');
    assert.equal(r1.limit_tokens, 1_048_576);
    assert.equal(r1.request_budget_tokens, 256_000);
    assert.ok(r1.text.includes('Gemini 3.8 Flash (Medium) · 300/1.0M tokens'));

    // Model catalog overrides table
    const p2 = join(dir, 'cat.db');
    const db2 = createConvDb(p2);
    addBasicSteps(db2);
    db2.generation({ groups: [pbGroup(1, 100), pbGroup(7, 300, [['0: USER_INPUT', 300]])], model: 'gemini-9-test-high', displayName: '' });
    db2.close();
    const catPath = join(dir, 'catalog.json');
    writeFileSync(catPath, JSON.stringify({ 'gemini-9-test-high': { maxTokens: 2_000_000, displayName: 'Gemini 9 Test (High)' } }));
    const r2 = await buildReport({ dbPath: p2, modelCatalogPath: catPath });
    assert.deepEqual([r2.model, r2.limit_tokens], ['Gemini 9 Test (High)', 2_000_000]);
    assert.equal(r2.heading, 'Token usage by category');
    assert.deepEqual(r2.grid_segments, [100, 300, 0, 0, 0]);
    assert.ok(r2.text.startsWith('└ Context Usage'));
    assert.ok(r2.text.includes('Gemini 9 Test (High) · 400/2M tokens'));

    // Unknown model falls back to request_budget
    const p3 = join(dir, 'unk.db');
    const db3 = createConvDb(p3);
    addBasicSteps(db3);
    db3.generation({ groups: [pbGroup(7, 300, [['0: USER_INPUT', 300]])], maxContext: 256_000, model: 'new-model-x', displayName: '' });
    db3.close();
    const r3 = await buildReport({ dbPath: p3 });
    assert.deepEqual([r3.model, r3.limit_tokens], ['New Model X', 256_000]);

    // Text layout wide (20 grid cols) and narrow stacked (width 60, limitOverride 200k)
    const p4 = join(dir, 'layout.db');
    const db4 = createConvDb(p4);
    addBasicSteps(db4);
    db4.generation({ groups: [pbGroup(1, 1000), pbGroup(7, 300, [['0: USER_INPUT', 300]])], maxContext: 256_000 });
    db4.close();
    const rWide = await buildReport({ dbPath: p4, width: 100 });
    const linesWide = rWide.text.split('\n');
    assert.equal(linesWide[0], '└ Context Usage');
    assert.ok(linesWide[2].endsWith('Test Model · 1.3k/256.0k tokens'));
    assert.ok(rWide.text.includes('◉ Agent responses: 0 tokens (0.0%)'));
    assert.equal(rWide.text.includes('Plugins'), false);
    assert.ok(rWide.text.trimEnd().endsWith('Related: /artifact · /skill · /rewind'));
    const gridRows = linesWide.filter((l) => l.startsWith('◉') || l.startsWith('□'));
    assert.equal(gridRows[0].split('   ')[0].split(' ').length, 20);

    const rNarrow = await buildReport({ dbPath: p4, limitOverride: 200_000, width: 60 });
    const linesNarrow = rNarrow.text.split('\n');
    assert.equal(linesNarrow[2], 'Test Model · 1.3k/200.0k tokens');
    assert.ok(linesNarrow.at(-3).startsWith('□'));

    // Direct renderGrid (color & plain), renderStats, render
    const stSample = collectStats([], null, 1000);
    stSample.user = 200;
    stSample.total = 200;
    const plainGrid = renderGrid(stSample, 20, 2, false);
    assert.equal(plainGrid.length, 2);
    assert.equal(plainGrid[0].includes('\x1b['), false);
    const ansiGrid = renderGrid(stSample, 20, 2, true);
    assert.equal(ansiGrid[0].includes('\x1b['), true);
    assert.ok(renderStats(stSample, 'Test').includes('Test · 200/1.0k tokens'));
    assert.ok(render(stSample, 'Test', [], 100, false).startsWith('└ Context Usage\n'));

    // FormatTest
    assert.equal(modelLabel('gemini-4-argon-medium'), 'Gemini 4 Argon (Medium)');
    assert.equal(modelLabel('gemini-3.8-flash-low'), 'Gemini 3.8 Flash (Low)');
    assert.equal(modelLabel('claude-opus-5-5-high'), 'Claude Opus 5.5 (High)');
    assert.equal(modelLabel('gpt-oss-120b-medium'), 'GPT-OSS 120B (Medium)');

    assert.equal(NATIVE_CONTEXT_WINDOWS.length >= 5, true);
    for (const [slug, tokens] of [
      ['claude-sonnet-5-5-low', 1_000_000],
      ['claude-opus-4-6-thinking', 250_000],
      ['gpt-oss-120b-medium', 131_072],
      ['gemini-4-argon-high', 1_048_576],
    ]) {
      const gen = new Msg(pbField(3, pbField(28, slug)));
      assert.equal(contextLimit(gen), tokens);
    }

    assert.equal(fmtTok(999), '999');
    assert.equal(fmtTok(1500), '1.5k');
    assert.equal(fmtTok(1_000_000), '1M');
    assert.equal(fmtTok(1_250_000), '1.2M');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Speed & Session tests (migrated from ReportTest & SpeedTest) ------------

test('ReportTest: speed aggregation, null speed, >50 gen session, mtime fallback, pricing file & collectSession', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-unit-spd-'));
  try {
    // 1. Speed from generations
    const p1 = join(dir, 'spd.db');
    const db1 = createConvDb(p1);
    addBasicSteps(db1);
    db1.generation({ groups: [pbGroup(7, 10, [['0: USER_INPUT', 10]])], usage: pbUsage({ inp: 100, out: 200, cache: 300 }), timing: pbTiming(pbDuration(1), pbDuration(4)) });
    db1.generation({ groups: [pbGroup(7, 10, [['0: USER_INPUT', 10]])], usage: pbUsage({ inp: 0, out: 100 }), timing: pbTiming(pbDuration(0, 500_000_000), pbDuration(2)) });
    db1.close();
    const s1 = (await buildReport({ dbPath: p1 })).speed;
    assert.deepEqual(
      Object.keys(s1).sort(),
      ['avg_e2e_tps', 'avg_streaming_tps', 'avg_ttft_sec', 'by_model', 'calls', 'latest', 'median_streaming_tps', 'recent', 'total_output_tokens'],
    );
    assert.equal(s1.calls, 2);
    assert.equal(s1.latest.output_tokens, 100);
    assert.equal(s1.latest.streaming_tps, 50.0);
    assert.equal(s1.latest.buffered, false);
    assert.equal(s1.avg_streaming_tps, 50.0);
    assert.equal(s1.median_streaming_tps, 50.0);
    assert.equal(s1.avg_e2e_tps, 40.0);
    assert.equal(s1.avg_ttft_sec, 0.75);
    assert.equal(s1.total_output_tokens, 300);
    assert.deepEqual(s1.recent.map((r) => r.output_tokens), [200, 100]);
    assert.equal(s1.recent.every((r) => r.buffered === false), true);
    assert.equal(Object.keys(s1.latest).some((k) => k.startsWith('_')), false);
    assert.equal(s1.by_model.length, 1);
    const bm0 = s1.by_model[0];
    assert.deepEqual([bm0.model, bm0.display_name, bm0.calls, bm0.output_tokens], ['test-model', 'Test Model', 2, 300]);
    assert.deepEqual([bm0.avg_streaming_tps, bm0.median_streaming_tps, bm0.avg_e2e_tps, bm0.avg_ttft_sec], [50.0, 50.0, 40.0, 0.75]);
    assert.deepEqual(bm0.latest, s1.latest);
    assert.deepEqual(bm0.recent, s1.recent);

    // 2. Null speed without timing or gen rows
    const p2 = join(dir, 'notiming.db');
    const db2 = createConvDb(p2);
    addBasicSteps(db2);
    db2.generation({ groups: [pbGroup(7, 10, [['0: USER_INPUT', 10]])], usage: pbUsage({ inp: 100, out: 200 }) });
    db2.close();
    assert.equal((await buildReport({ dbPath: p2 })).speed, null);

    const p3 = join(dir, 'nogens.db');
    const db3 = createConvDb(p3);
    addBasicSteps(db3);
    db3.close();
    assert.equal((await buildReport({ dbPath: p3 })).speed, null);

    // 3. Session sums >50 generations, aborted skipped, timestamp clamping, display-only
    const p4 = join(dir, 'sess.db');
    const db4 = createConvDb(p4);
    for (const sec of [1_700_000_000, 1_700_000_100, 1_700_000_200, 1_700_000_300]) {
      db4.step(15, { metadata: pbTs(sec), payloadField: 20, payload: pbPlanner('x') });
    }
    const g = [pbGroup(7, 10, [['0: USER_INPUT', 10]])];
    db4.generation({ groups: g, usage: pbUsage({ inp: 1000, out: 200, cache: 3000 }), model: 'claude-opus-4-6-thinking', displayName: 'Opus' });
    db4.generation({ groups: g, usage: pbUsage({ inp: 500, out: 100, cache: 500 }), model: 'test-model', displayName: 'Test Model' });
    db4.generation({ groups: g, usage: new Uint8Array(0), model: 'test-model' }); // aborted
    db4.generation({ groups: g, usage: pbUsage({ inp: 500, out: 100, cache: 500 }), model: '', displayName: 'Test Model' });
    for (let i = 0; i < 60; i += 1) {
      db4.generation({ groups: g, usage: pbUsage({ inp: 1, out: 1 }), model: 'test-model' });
    }
    db4.close();
    const sess = (await buildReport({ dbPath: p4 })).session;
    assert.equal(sess.calls, 63);
    assert.deepEqual([sess.input, sess.output, sess.cache_read, sess.thinking], [2060, 460, 4000, 0]);
    assert.equal(sess.total_tokens, 2520);
    assert.equal(sess.cache_hit_pct, roundN((4000 / 6060) * 100, 1));
    assert.equal(sess.est_cost_usd, 0.0115);
    assert.equal(sess.cost_partial, true);
    assert.equal(sess.cost_estimated, false);
    assert.equal(sess.pricing_source, 'builtin');
    assert.equal(Date.parse(sess.first_at), 1_700_000_000 * 1000);
    assert.equal(Date.parse(sess.last_at), 1_700_000_300 * 1000);
    assert.deepEqual(sess.by_model.map((b) => b.model), ['claude-opus-4-6-thinking', 'test-model']);
    assert.deepEqual(sess.by_model[0], {
      model: 'claude-opus-4-6-thinking',
      display_name: 'Opus',
      input: 1000,
      output: 200,
      cache_read: 3000,
      calls: 1,
      est_cost_usd: 0.0115,
      cost_estimated: false,
    });
    assert.deepEqual([sess.by_model[1].display_name, sess.by_model[1].calls, sess.by_model[1].input, sess.by_model[1].est_cost_usd, sess.by_model[1].cost_estimated], ['Test Model', 62, 1060, null, false]);

    // 4. Fully priced & mtime fallback
    const p5 = join(dir, 'fullprice.db');
    const db5 = createConvDb(p5);
    db5.generation({ groups: [], usage: pbUsage({ inp: 1_000_000 }), model: 'gemini-2.5-pro-x', displayName: '' });
    db5.close();
    const s5 = (await buildReport({ dbPath: p5 })).session;
    // A 1M-token prompt is above 200k, so the long-context tier ($2.50 / 1M) applies.
    assert.deepEqual([s5.est_cost_usd, s5.cost_partial, s5.cost_estimated, s5.pricing_source, s5.cache_hit_pct], [2.5, false, false, 'builtin', 0.0]);
    assert.ok(s5.first_at);
    assert.deepEqual([s5.by_model[0].display_name, s5.by_model[0].cost_estimated], [null, false]);

    // 5. Pricing file & preview estimate & missing pricing file fallback
    const p6 = join(dir, 'prev.db');
    const db6 = createConvDb(p6);
    db6.generation({ groups: g, usage: pbUsage({ inp: 100_000, out: 10_000 }), model: 'claude-opus-4-6-thinking', displayName: 'Opus 4.6' });
    db6.generation({ groups: g, usage: pbUsage({ inp: 200_000, out: 20_000 }), model: 'claude-opus-9-medium', displayName: 'Opus 9' });
    db6.close();
    const rBuilt = (await buildReport({ dbPath: p6 })).session;
    assert.deepEqual([rBuilt.pricing_source, rBuilt.cost_partial, rBuilt.cost_estimated, rBuilt.est_cost_usd], ['builtin', false, true, 2.25]);
    const bmBuilt = Object.fromEntries(rBuilt.by_model.map((b) => [b.model, b]));
    assert.deepEqual([bmBuilt['claude-opus-4-6-thinking'].est_cost_usd, bmBuilt['claude-opus-4-6-thinking'].cost_estimated], [0.75, false]);
    assert.deepEqual([bmBuilt['claude-opus-9-medium'].est_cost_usd, bmBuilt['claude-opus-9-medium'].cost_estimated], [1.5, true]);

    const pricingPath = join(dir, 'pricing-cache.json');
    writeFileSync(pricingPath, JSON.stringify({
      source: 'litellm',
      fetched_at: '2026-11-20T12:00:00Z',
      models: { 'anthropic/claude-opus-4-6': { input: 10.0, output: 50.0, cache_read: 1.0 } },
    }));
    const rCustom = (await buildReport({ dbPath: p6, pricingFile: pricingPath })).session;
    assert.deepEqual([rCustom.pricing_source, rCustom.cost_partial, rCustom.cost_estimated, rCustom.est_cost_usd], ['litellm', false, true, 4.5]);
    const bmCustom = Object.fromEntries(rCustom.by_model.map((b) => [b.model, b]));
    assert.deepEqual([bmCustom['claude-opus-4-6-thinking'].est_cost_usd, bmCustom['claude-opus-4-6-thinking'].cost_estimated], [1.5, false]);
    assert.deepEqual([bmCustom['claude-opus-9-medium'].est_cost_usd, bmCustom['claude-opus-9-medium'].cost_estimated], [3.0, true]);

    const rMiss = (await buildReport({ dbPath: p6, pricingFile: join(dir, 'nope.json') })).session;
    assert.deepEqual([rMiss.pricing_source, rMiss.est_cost_usd], ['builtin', 2.25]);

    // 6. Session null without usage & collectSession error handling
    const p7 = join(dir, 'zerou.db');
    const db7 = createConvDb(p7);
    addBasicSteps(db7);
    db7.generation({ groups: g });
    db7.close();
    assert.equal((await buildReport({ dbPath: p7 })).session, null);

    const corruptPath = join(dir, 'bad.db');
    writeFileSync(corruptPath, 'not sqlite');
    assert.equal(await collectSession(corruptPath), null);
    assert.equal((await collectSession(p5)).calls, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SpeedTest: duration decoding, invalid boundaries, parseGenerationSpeed, collectSpeed & loadGenerations', async () => {
  // Duration decoding & boundaries
  assert.equal(pbDurationSec(new Msg(pbDuration(3, 250_000_000))), 3.25);
  assert.equal(pbDurationSec(new Msg(pbDuration(null, 400_000_000))), 0.4);
  assert.equal(pbDurationSec(new Msg(pbDuration(12, null))), 12.0);
  assert.equal(pbDurationSec(new Msg(pbDuration(0, 0))), 0.0);
  assert.equal(pbDurationSec(null), null);
  assert.equal(pbDurationSec(new Msg(new Uint8Array(0))), null);
  assert.equal(pbDurationSec(new Msg(pbDuration(-1, null))), null);
  assert.equal(pbDurationSec(new Msg(pbDuration(1, -5))), null);
  assert.equal(pbDurationSec(new Msg(pbDuration(null, 1_000_000_000))), null);
  assert.equal(pbDurationSec(new Msg(pbDuration(86_401, null))), null);
  assert.equal(pbDurationSec(new Msg(pbDuration(86_400, null))), 86_400.0);

  // parseGenerationSpeed
  assert.equal(parseGenerationSpeed(null), null);
  assert.equal(parseGenerationSpeed(new Msg(new Uint8Array(0))), null);
  assert.equal(parseGenerationSpeed(speedGen({ output: 100 })), null);
  assert.equal(parseGenerationSpeed(speedGen({ output: 100, ttft: new Uint8Array(0), streaming: pbDuration(-3, null) })), null);

  const eFull = parseGenerationSpeed(speedGen({
    output: 300, thinking: 100, inputTokens: 250, cacheRead: 750,
    ttft: pbDuration(1, 500_000_000), streaming: pbDuration(3, null),
  }));
  assert.equal(eFull.output_tokens, 300);
  assert.equal(eFull.thinking_tokens, 100);
  assert.equal(eFull.response_tokens, 200);
  assert.equal(eFull.ttft_sec, 1.5);
  assert.equal(eFull.streaming_sec, 3.0);
  assert.equal(eFull.total_sec, 4.5);
  assert.equal(eFull.streaming_tps, 100.0);
  assert.equal(eFull.e2e_tps, 66.7);
  assert.equal(eFull.cache_hit_pct, 75.0);

  const eExp = parseGenerationSpeed(speedGen({ output: 300, thinking: 100, response: 150, ttft: pbDuration(1, null) }));
  assert.equal(eExp.response_tokens, 150);
  assert.equal(eExp.cache_hit_pct, null);
  assert.equal(eExp.streaming_sec, null);
  assert.equal(eExp.streaming_tps, null);
  assert.deepEqual([eExp.total_sec, eExp.e2e_tps], [1.0, 300.0]);

  const eShort1 = parseGenerationSpeed(speedGen({ output: 300, ttft: pbDuration(1, null), streaming: pbDuration(0, 490_000_000) }));
  assert.equal(eShort1.streaming_tps, null);
  assert.equal(eShort1.streaming_sec, 0.49);
  assert.equal(eShort1.total_sec, 1.49);
  assert.equal(eShort1.e2e_tps, roundN(300 / 1.49, 1));

  const eShort2 = parseGenerationSpeed(speedGen({ output: 19, ttft: pbDuration(1, null), streaming: pbDuration(1, null) }));
  assert.equal(eShort2.streaming_tps, null);
  assert.equal(eShort2.e2e_tps, 9.5);

  const eExact = parseGenerationSpeed(speedGen({ output: 20, ttft: pbDuration(1, null), streaming: pbDuration(0, 500_000_000) }));
  assert.equal(eExact.streaming_tps, 40.0);

  const eZero = parseGenerationSpeed(speedGen({ output: 0, streaming: pbDuration(2, null) }));
  assert.equal(eZero.streaming_tps, null);
  assert.equal(eZero.e2e_tps, null);

  // collectSpeed empty
  assert.equal(collectSpeed([]), null);
  assert.equal(collectSpeed([speedGen({ output: 5 }), new Msg(new Uint8Array(0))]), null);

  // Weighted & oldest-first
  const sW = collectSpeed([
    speedGen({ output: 100, ttft: pbDuration(1, null), streaming: pbDuration(1, null) }),
    speedGen({ output: 5 }),
    speedGen({ output: 900, ttft: pbDuration(3, null), streaming: pbDuration(9, null) }),
    speedGen({ output: 50, ttft: pbDuration(2, null), streaming: pbDuration(0, 200_000_000) }),
  ]);
  assert.equal(sW.calls, 3);
  assert.equal(sW.latest.output_tokens, 100);
  assert.equal(sW.latest.buffered, false);
  assert.equal(sW.avg_streaming_tps, 100.0);
  assert.equal(sW.median_streaming_tps, 100.0);
  assert.equal(sW.avg_e2e_tps, roundN(1050 / 16.2, 1));
  assert.equal(sW.avg_ttft_sec, 2.0);
  assert.equal(sW.total_output_tokens, 1050);
  assert.deepEqual(sW.recent.map((r) => r.output_tokens), [50, 900, 100]);
  assert.deepEqual(sW.recent.map((r) => r.buffered), [true, false, false]);
  assert.deepEqual(Object.keys(sW.recent[0]).sort(), ['buffered', 'e2e_tps', 'output_tokens', 'streaming_sec', 'streaming_tps', 'total_sec', 'ttft_sec']);

  // Outlier 3x boundary & <3 valid entries
  const sOut = collectSpeed([
    speedGen({ output: 855, ttft: pbDuration(30, null), streaming: pbDuration(0, 510_000_000) }), // >3x filtered
    speedGen({ output: 300, ttft: pbDuration(2, null), streaming: pbDuration(1, null) }), // 300 === 3*100 kept
    speedGen({ output: 100, ttft: pbDuration(2, null), streaming: pbDuration(1, null) }),
    speedGen({ output: 100, ttft: pbDuration(2, null), streaming: pbDuration(1, null) }),
    speedGen({ output: 100, ttft: pbDuration(2, null), streaming: pbDuration(1, null) }),
    speedGen({ output: 295, ttft: pbDuration(10, null), streaming: pbDuration(0, 190_000_000) }), // buffered
  ]);
  assert.equal(sOut.avg_streaming_tps, 150.0);
  assert.equal(sOut.latest.buffered, true);
  assert.equal(sOut.latest.streaming_tps, null);
  assert.equal(sOut.latest.e2e_tps, roundN(855 / 30.51, 1));
  assert.deepEqual(sOut.recent.map((r) => r.buffered), [true, false, false, false, false, true]);
  assert.deepEqual(sOut.recent.map((r) => r.streaming_tps), [null, 100.0, 100.0, 100.0, 300.0, null]);

  const sSmall = collectSpeed([
    speedGen({ output: 1000, ttft: pbDuration(1, null), streaming: pbDuration(1, null) }),
    speedGen({ output: 100, ttft: pbDuration(1, null), streaming: pbDuration(1, null) }),
  ]);
  assert.equal(sSmall.latest.streaming_tps, 1000.0);
  assert.equal(sSmall.latest.buffered, false);
  assert.equal(sSmall.median_streaming_tps, 550.0);

  // Cross-model outlier isolation (both cases)
  const sIso1 = collectSpeed([
    speedGen({ output: 400, ttft: pbDuration(1, null), streaming: pbDuration(1, null), responseModel: 'gemini-fast', display: 'Gemini' }),
    speedGen({ output: 400, ttft: pbDuration(1, null), streaming: pbDuration(1, null), responseModel: 'gemini-fast', display: 'Gemini' }),
    speedGen({ output: 400, ttft: pbDuration(1, null), streaming: pbDuration(1, null), responseModel: 'gemini-fast', display: 'Gemini' }),
    ...Array.from({ length: 5 }, () => speedGen({ output: 100, ttft: pbDuration(1, null), streaming: pbDuration(1, null), responseModel: 'claude-std', display: 'Claude' })),
  ]);
  assert.equal(sIso1.avg_streaming_tps, 100.0);
  assert.equal(sIso1.latest.buffered, true);
  const byId1 = Object.fromEntries(sIso1.by_model.map((b) => [b.model, b]));
  assert.equal(byId1['gemini-fast'].avg_streaming_tps, 400.0);
  assert.equal(byId1['gemini-fast'].latest.buffered, false);
  assert.equal(byId1['claude-std'].avg_streaming_tps, 100.0);

  const sIso2 = collectSpeed([
    speedGen({ output: 350, ttft: pbDuration(5, null), streaming: pbDuration(1, null), responseModel: 'claude-std', display: 'Claude' }),
    ...Array.from({ length: 3 }, () => speedGen({ output: 80, ttft: pbDuration(1, null), streaming: pbDuration(1, null), responseModel: 'claude-std', display: 'Claude' })),
    ...Array.from({ length: 5 }, () => speedGen({ output: 400, ttft: pbDuration(1, null), streaming: pbDuration(1, null), responseModel: 'gemini-fast', display: 'Gemini' })),
  ]);
  assert.equal(sIso2.latest.buffered, false);
  assert.equal(sIso2.latest.streaming_tps, 350.0);
  const cla2 = sIso2.by_model.find((b) => b.model === 'claude-std');
  assert.equal(cla2.latest.buffered, true);
  assert.equal(cla2.avg_streaming_tps, 80.0);
  assert.deepEqual(cla2.recent.map((r) => r.buffered), [false, false, false, true]);

  // collect_by_model precedence + recent caps
  const sBm = collectSpeed([
    speedGen({ output: 200, streaming: pbDuration(1, null), ttft: pbDuration(1, null), responseModel: 'gemini-flash', display: 'Flash' }),
    speedGen({ output: 300, streaming: pbDuration(3, null), ttft: pbDuration(2, null), responseModel: 'claude-opus', display: 'Opus' }),
    speedGen({ output: 100, streaming: pbDuration(1, null), ttft: pbDuration(3, null), plannerModel: 'gemini-flash', responseModel: 'ignored' }),
    speedGen({ output: 100, streaming: pbDuration(2, null), ttft: pbDuration(4, null), display: 'Opus' }),
    speedGen({ output: 50, streaming: pbDuration(1, null) }),
    speedGen({ output: 10, streaming: pbDuration(1, null), display: 'Mystery' }),
    speedGen({ output: 999, responseModel: 'claude-opus' }),
  ]);
  assert.equal(sBm.calls, 6);
  assert.equal(sBm.total_output_tokens, 760);
  assert.deepEqual(sBm.by_model.map((b) => b.model), ['gemini-flash', 'claude-opus', 'unknown', 'Mystery']);
  assert.equal(sBm.by_model[2].display_name, null);
  assert.equal(sBm.by_model[3].latest.buffered, true);
  assert.deepEqual(
    Object.keys(sBm.by_model[0]).sort(),
    ['avg_e2e_tps', 'avg_streaming_tps', 'avg_ttft_sec', 'calls', 'display_name', 'latest', 'median_streaming_tps', 'model', 'output_tokens', 'recent'],
  );

  const sCapBm = collectSpeed(Array.from({ length: 12 }, (_, i) => speedGen({ output: 12 - i, streaming: pbDuration(1, null), responseModel: 'm' })));
  assert.deepEqual(sCapBm.by_model[0].recent.map((r) => r.output_tokens), [5, 6, 7, 8, 9, 10, 11, 12]);
  assert.equal(sCapBm.by_model[0].display_name, null);

  const sCap = collectSpeed(Array.from({ length: 20 }, (_, i) => speedGen({ output: 20 - i, streaming: pbDuration(1, null) })));
  assert.deepEqual(sCap.recent.map((r) => r.output_tokens), [13, 14, 15, 16, 17, 18, 19, 20]);

  // loadGenerations newest-first & missing table
  const dir = mkdtempSync(join(tmpdir(), 'agy-unit-lg-'));
  try {
    const pA = join(dir, 'a.db');
    const dbA = createConvDb(pA);
    dbA.generation({ model: 'old' });
    dbA.generation({ model: 'new' });
    dbA.close();
    const gens = await loadGenerations(pA);
    assert.deepEqual(gens.map((g) => g.msg(3).str(28)), ['new', 'old']);
    assert.equal((await loadGenerations(pA, 1)).length, 1);

    const pB = join(dir, 'b.db');
    createConvDb(pB, { genTable: false }).close();
    assert.deepEqual(await loadGenerations(pB), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- History Scanner & Pricing tests (migrated from ScannerTest) -------------

const H_NOW = new Date(2026, 5, 15, 12, 0, 0); // 2026-06-15 12:00 local
function hTs(daysAgo, hour = 10) {
  return new Date(H_NOW.getFullYear(), H_NOW.getMonth(), H_NOW.getDate() - daysAgo, hour, 0, 0).getTime() / 1000;
}
function hCall(daysAgo, { model = 'gemini-2.5-pro', input = 100, output = 10, cache = 1000, thinking = 5, display = 'Gemini 2.5 Pro', model_field = 'planner', ts = null } = {}) {
  return { ts: ts ?? hTs(daysAgo), model, display, input, output, cache, thinking, model_field };
}

test('ScannerTest: windows/totals, contract shape, by_model, display-only resolution & by_conversation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-unit-hist1-'));
  try {
    const desk = join(dir, 'desk');
    const cli = join(dir, 'cli');
    mkdirSync(desk, { recursive: true });
    mkdirSync(cli, { recursive: true });
    const cache = join(dir, 'cache', 'history.json');

    // 1. Windows & totals (including 'all' with 100d call)
    makeHistoryDb(join(desk, 'a.db'), [hCall(0), hCall(3), hCall(10), hCall(100)]);
    makeHistoryDb(join(desk, 'b.db'), [hCall(0, { input: 1, output: 2, cache: 3, thinking: 1 })]);
    const r = await scan([[desk, 'desktop'], [cli, 'cli']], { cachePath: cache, days: 30, now: H_NOW });
    assert.equal(r.totals.today.calls, 2);
    assert.equal(r.totals.today.conversations, 2);
    assert.equal(r.totals.today.input, 101);
    assert.equal(r.totals.today.output, 12);
    assert.equal(r.totals.today.cache_read, 1003);
    assert.equal(r.totals.today.thinking, 6);
    assert.equal(r.totals.d7.calls, 3);
    assert.equal(r.totals.d30.calls, 4);
    assert.equal(r.totals.all.calls, 5);
    assert.equal(r.totals.all.conversations, 2);
    assert.equal(r.totals.d30.conversations, 2);
    assert.deepEqual(r.sources, { desktop: 2, cli: 0 });
    assert.equal(r.errors, 0);
    const unitCost = (100 * 1.25 + 10 * 10 + 1000 * 0.125) / 1e6;
    const expectedD30 = roundN(unitCost * 3 + (1.25 + 20 + 3 * 0.125) / 1e6, 4);
    assert.equal(r.totals.d30.est_cost_usd, expectedD30);
    assert.equal(r.totals.d30.cost_estimated, false);
    assert.equal(r.pricing_source, 'builtin');
    assert.equal(r.pricing_fetched_at, null);
    assert.deepEqual(r.d7_by_pool, { gemini: 223, claude_gpt: 0, other: 0 });

    // 2. Contract shape
    assert.deepEqual(Object.keys(r).sort(), [
      'archived_conversations', 'by_conversation', 'by_model', 'd7_by_pool', 'daily', 'elapsed_ms', 'errors', 'hourly_today',
      'pricing_fetched_at', 'pricing_source', 'scanned_at', 'sources', 'totals', 'weekly_cycles', 'weekly_value_usd',
    ]);
    assert.deepEqual(Object.keys(r.d7_by_pool).sort(), ['claude_gpt', 'gemini', 'other']);
    assert.deepEqual(Object.keys(r.by_conversation[0]).sort(), [
      'agent', 'archived', 'by_model', 'cache_read', 'calls', 'children', 'cost_by_pool', 'cost_estimated', 'cost_partial', 'd7_by_pool', 'd7_tokens',
      'depth', 'display_name', 'est_cost_usd', 'first_at', 'id', 'input', 'is_subagent', 'last_at', 'model',
      'output', 'parent_id', 'pool', 'root_id', 'source', 'thinking', 'title', 'total',
    ]);
    assert.deepEqual(Object.keys(r.by_conversation[0].by_model[0]).sort(), [
      'cache_read', 'calls', 'cost_estimated', 'display_name', 'est_cost_usd', 'input', 'model', 'output', 'thinking',
    ]);
    assert.deepEqual(Object.keys(r.totals).sort(), ['all', 'd30', 'd7', 'today']);
    for (const t of Object.values(r.totals)) {
      assert.deepEqual(Object.keys(t).sort(), [
        'cache_read', 'calls', 'conversations', 'cost_estimated', 'est_cost_usd', 'input', 'output', 'thinking',
      ]);
    }
    assert.deepEqual(Object.keys(r.by_model[0]).sort(), [
      'cache_read', 'calls', 'cost_estimated', 'd7_tokens', 'display_name', 'est_cost_usd', 'input', 'model', 'output', 'periods', 'pool', 'thinking',
    ]);
    assert.deepEqual(Object.keys(r.by_model[0].periods).sort(), ['all', 'd30', 'd7', 'today']);
    assert.deepEqual(Object.keys(r.by_model[0].periods.all).sort(), ['cache_read', 'calls', 'input', 'output']);
    assert.equal(r.by_model[0].periods.all.input, r.by_model[0].input);
    assert.deepEqual(Object.keys(r.daily[0]).sort(), ['calls', 'date', 'tokens']);
    assert.equal(r.hourly_today.length, 24);
    assert.deepEqual(Object.keys(r.hourly_today[0]).sort(), ['calls', 'hour', 'tokens']);
    assert.equal(Number.isNaN(Date.parse(r.scanned_at)), false);
    assert.equal(Number.isInteger(r.elapsed_ms), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ScannerTest: by_model, display-only resolution, by_conversation details, d7_tokens, tie-break & cap', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-unit-hist2-'));
  try {
    // 1. by_model + display-only resolution
    const d1 = join(dir, 'd1');
    mkdirSync(d1);
    makeHistoryDb(join(d1, 'a.db'), [
      hCall(0, { model: 'claude-sonnet-4-5', display: 'Claude Sonnet 4.5', input: 10, output: 10, cache: 10 }),
      hCall(1, { model: 'internal-x', display: 'Internal X', input: 5000, model_field: 'response' }),
      hCall(2, { model: 'gemini-2.5-pro' }),
    ]);
    makeHistoryDb(join(d1, 'b.db'), [
      hCall(0, { model: 'claude-sonnet-4-5', display: 'Claude Sonnet 4.5', input: 10, output: 10, cache: 10 }),
    ]);
    const rBm = await scan([[d1, 'desktop']], { now: H_NOW });
    assert.deepEqual(rBm.by_model.map((m) => m.model), ['internal-x', 'gemini-2.5-pro', 'claude-sonnet-4-5']);
    const bmMap = Object.fromEntries(rBm.by_model.map((m) => [m.model, m]));
    assert.equal(bmMap['claude-sonnet-4-5'].calls, 2);
    assert.equal(bmMap['internal-x'].est_cost_usd, null);
    assert.equal(bmMap['claude-sonnet-4-5'].est_cost_usd, roundN(2 * (10 * 3 + 10 * 15 + 10 * 0.3) / 1e6, 4));

    const dDisp = join(dir, 'disp');
    mkdirSync(dDisp);
    makeHistoryDb(join(dDisp, 'a.db'), [
      hCall(0, { model: 'gemini-2.5-pro', display: 'Gemini 2.5 Pro' }),
      hCall(0, { model: '', display: 'Gemini 2.5 Pro', model_field: 'none' }),
      hCall(0, { model: '', display: 'Mystery', model_field: 'none' }),
    ]);
    const rDisp = await scan([[dDisp, 'desktop']], { now: H_NOW });
    const bmDisp = Object.fromEntries(rDisp.by_model.map((m) => [m.model, m]));
    assert.equal(bmDisp['gemini-2.5-pro'].calls, 2);
    assert.equal(bmDisp.Mystery.display_name, 'Mystery');

    // 2. by_conversation (@verifier, truncation, primary model vs by_model sort, cache hit equality)
    const convBase = join(dir, 'convbase');
    const desk = join(convBase, 'desk');
    const cli = join(convBase, 'cli');
    mkdirSync(desk, { recursive: true });
    mkdirSync(cli, { recursive: true });
    makeHistoryDb(join(desk, 'old.db'), [hCall(5), hCall(4)], { firstInput: '  Fix   the\nlogin bug please  ' });
    makeHistoryDb(join(desk, 'new.db'), [
      hCall(1, { model: 'claude-sonnet-4-5', display: 'Claude Sonnet 4.5', input: 10, output: 10, cache: 50000, thinking: 2 }),
      hCall(0, { model: 'internal-x', display: 'Internal X', input: 9000, output: 10, cache: 100, thinking: 3, model_field: 'response' }),
    ], { firstInput: 'x'.repeat(200) });
    makeHistoryDb(join(cli, 'titled.db'), [hCall(2, { model: 'mystery' })], { firstInput: 'ignored' });
    makeHistoryDb(join(desk, 'empty.db'), []);
    makeHistoryDb(join(desk, 'worker.db'), [hCall(10)], { firstInput: '' });
    makeHistoryDb(join(desk, 'sub.db'), [hCall(11)], { firstInput: '' });
    const sdb = new DatabaseSync(join(convBase, 'conversation_summaries.db'));
    sdb.exec('CREATE TABLE conversation_summaries (conversation_id text, title text, preview text, agent_name text);');
    sdb.prepare("INSERT INTO conversation_summaries VALUES ('titled', 'Official Title', '', ''), ('new', '', '', ''), ('worker', '', '', 'verifier'), ('sub', '', '', 'self');").run();
    sdb.close();

    const cachePath = join(dir, 'conv-cache.json');
    const stats = {};
    const rC1 = await scan([[desk, 'desktop'], [cli, 'cli']], { cachePath, days: 30, now: H_NOW, stats });
    const convs = rC1.by_conversation;
    assert.deepEqual(convs.map((c) => c.id), ['new', 'titled', 'old', 'worker', 'sub']);
    const [cNew, cTitled, cOld, cWorker, cSub] = convs;
    assert.equal(cWorker.title, '@verifier');
    assert.equal(cWorker.is_subagent, true);
    assert.equal(cSub.title, null);
    assert.equal(cSub.is_subagent, true);
    assert.equal(cTitled.title, 'Official Title');
    assert.equal(cOld.title, 'Fix the login bug please');
    assert.equal(Array.from(cNew.title).length, TITLE_MAX);
    assert.ok(cNew.title.endsWith('…'));
    assert.equal(cNew.model, 'claude-sonnet-4-5'); // highest total incl. cache
    assert.deepEqual(cNew.by_model.map((m) => m.model), ['internal-x', 'claude-sonnet-4-5']); // sorted by input+output
    assert.equal(cNew.cost_partial, true);
    assert.equal(cTitled.est_cost_usd, null);
    assert.equal(cOld.cost_partial, false);
    assert.equal(Date.parse(cNew.first_at), hTs(1) * 1000);
    assert.equal(Date.parse(cNew.last_at), hTs(0) * 1000);
    assert.equal(cTitled.first_at, cTitled.last_at);

    const rC2 = await scan([[desk, 'desktop'], [cli, 'cli']], { cachePath, days: 30, now: H_NOW, stats });
    assert.deepEqual([stats.hits, stats.misses], [6, 0]);
    assert.deepEqual(rC2.by_conversation, convs);

    // 3. d7_tokens spanning window & CACHE_VERSION === 5
    assert.equal(CACHE_VERSION, 5);
    const dSpan = join(dir, 'span');
    mkdirSync(dSpan);
    makeHistoryDb(join(dSpan, 'span.db'), [
      hCall(10, { model: 'model-a', input: 5000, output: 500, cache: 90000 }),
      hCall(7, { model: 'model-a', input: 4000, output: 400, cache: 80000 }),
      hCall(6, { model: 'model-a', input: 300, output: 30, cache: 50000 }),
      hCall(0, { model: 'model-b', input: 200, output: 20, cache: 40000 }),
      hCall(-1, { model: 'model-b', input: 900, output: 90, cache: 10000 }),
    ]);
    makeHistoryDb(join(dSpan, 'ancient.db'), [hCall(20, { model: 'model-a', input: 8000, output: 800, cache: 70000 })]);
    const spanCache = join(dir, 'span-cache.json');
    const spanStats = {};
    const rSp1 = await scan([[dSpan, 'desktop']], { cachePath: spanCache, now: H_NOW, stats: spanStats });
    const d7Total = rSp1.totals.d7.input + rSp1.totals.d7.output;
    assert.equal(d7Total, 550);
    const bcSp = Object.fromEntries(rSp1.by_conversation.map((c) => [c.id, c]));
    assert.equal(bcSp.span.d7_tokens, 550);
    assert.equal(bcSp.ancient.d7_tokens, 0);
    const bmSp = Object.fromEntries(rSp1.by_model.map((m) => [m.model, m]));
    assert.equal(bmSp['model-a'].d7_tokens, 330);
    assert.equal(bmSp['model-b'].d7_tokens, 220);
    const rSp2 = await scan([[dSpan, 'desktop']], { cachePath: spanCache, now: H_NOW, stats: spanStats });
    assert.deepEqual([spanStats.hits, spanStats.misses], [2, 0]);
    assert.deepEqual(rSp2.by_model, rSp1.by_model);
    assert.deepEqual(rSp2.by_conversation, rSp1.by_conversation);

    // 4. Tie-break and MAX_CONVERSATIONS cap
    const dTie = join(dir, 'tie');
    mkdirSync(dTie);
    makeHistoryDb(join(dTie, 'tie.db'), [
      hCall(0, { model: 'model-b', display: 'B', input: 50, output: 50, cache: 10 }),
      hCall(0, { model: 'model-a', display: 'A', input: 60, output: 40, cache: 10 }),
    ]);
    const rTie = await scan([[dTie, 'desktop']], { now: H_NOW });
    assert.deepEqual(rTie.by_conversation[0].by_model.map((m) => m.model), ['model-a', 'model-b']);

    assert.equal(MAX_CONVERSATIONS, 500);
    const dCap = join(dir, 'cap');
    mkdirSync(dCap);
    for (let i = 0; i < 15; i += 1) {
      makeHistoryDb(join(dCap, `c${String(i).padStart(3, '0')}.db`), [hCall(0, { ts: hTs(0) - i })]);
    }
    const rCap = await scan([[dCap, 'desktop']], { now: H_NOW, maxConversations: 10 });
    assert.equal(rCap.by_conversation.length, 10);
    assert.equal(rCap.by_conversation[0].id, 'c000');
    assert.equal(rCap.by_conversation.at(-1).id, 'c009');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ScannerTest: exported helpers, zero usage, unknown cost, daily zero-fill, hourly_today, mtime, cache invalidation & read-only', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-unit-hist3-'));
  try {
    // 1. Exported helpers
    const pExp = join(dir, 'exp.db');
    makeHistoryDb(pExp, [hCall(3), hCall(1)]);
    const conn = await openReadOnlyDb(pExp);
    try {
      assert.deepEqual(generationTimestamps(conn, 3, 123.0), [hTs(3), hTs(1), hTs(1)]);
    } finally {
      conn.close();
    }
    assert.equal(generationTime([], 0, 5.0), 5.0);
    assert.deepEqual(
      parseGeneration(pbMsg(pbField(1, pbMsg(pbField(4, pbMsg(pbField(2, 7), pbField(9, 2))), pbField(19, 'resp-model'), pbField(21, 'Resp'))))),
      ['resp-model', 'Resp', 7, 0, 0, 2],
    );
    assert.equal(parseGeneration(new Uint8Array(0)), null);

    // 2. Zero usage & unknown-only cost
    const dZ = join(dir, 'zero');
    mkdirSync(dZ);
    makeHistoryDb(join(dZ, 'a.db'), [
      hCall(0, { model: 'mystery-model' }),
      hCall(0, { model: 'mystery-model', input: 0, output: 0, cache: 0, thinking: 0 }),
    ]);
    const rZ = await scan([[dZ, 'desktop']], { now: H_NOW });
    assert.equal(rZ.totals.all.calls, 1);
    assert.equal(rZ.totals.all.est_cost_usd, null);

    // 3. Daily zero-fill
    const dDaily = join(dir, 'daily');
    mkdirSync(dDaily);
    makeHistoryDb(join(dDaily, 'a.db'), [
      hCall(0, { input: 1, output: 2, cache: 3 }),
      hCall(2),
      hCall(2),
      hCall(40),
    ]);
    const rDay = await scan([[dDaily, 'desktop']], { days: 7, now: H_NOW });
    assert.equal(rDay.daily.length, 7);
    assert.equal(rDay.daily.at(-1).date, '2026-06-15');
    assert.equal(rDay.daily[0].date, '2026-06-09');
    assert.deepEqual(rDay.daily.at(-1), { date: '2026-06-15', tokens: 6, calls: 1 });
    assert.equal(rDay.daily.at(-3).calls, 2);
    assert.equal(rDay.daily.at(-3).tokens, 2220);
    assert.equal(rDay.daily.reduce((a, d) => a + d.calls, 0), 3);
    assert.equal(rDay.daily[1].tokens, 0);

    // 4. Hourly today boundaries (0, 14, 23, yesterday, tomorrow) + cache preservation
    const dH = join(dir, 'hourly');
    mkdirSync(dH);
    makeHistoryDb(join(dH, 'a.db'), [
      hCall(0, { input: 10, output: 5, cache: 100, ts: new Date(2026, 5, 15, 0, 5, 0).getTime() / 1000 }),
      hCall(0, { input: 20, output: 10, cache: 200, ts: new Date(2026, 5, 15, 14, 10, 0).getTime() / 1000 }),
      hCall(1, { input: 999, output: 999, cache: 9999, ts: new Date(2026, 5, 14, 14, 0, 0).getTime() / 1000 }),
      hCall(-1, { input: 888, output: 888, cache: 8888, ts: new Date(2026, 5, 16, 14, 0, 0).getTime() / 1000 }),
    ]);
    makeHistoryDb(join(dH, 'b.db'), [
      hCall(0, { input: 30, output: 15, cache: 300, ts: new Date(2026, 5, 15, 14, 55, 0).getTime() / 1000 }),
      hCall(0, { input: 40, output: 20, cache: 400, ts: new Date(2026, 5, 15, 23, 59, 30).getTime() / 1000 }),
    ]);
    const hCache = join(dir, 'h-cache.json');
    const hStats = {};
    const rH1 = await scan([[dH, 'desktop']], { cachePath: hCache, days: 7, now: H_NOW, stats: hStats });
    assert.deepEqual(rH1.hourly_today[0], { hour: 0, tokens: 115, calls: 1 });
    assert.deepEqual(rH1.hourly_today[14], { hour: 14, tokens: 575, calls: 2 });
    assert.deepEqual(rH1.hourly_today[23], { hour: 23, tokens: 460, calls: 1 });
    for (let h = 0; h < 24; h += 1) {
      if (h !== 0 && h !== 14 && h !== 23) assert.deepEqual(rH1.hourly_today[h], { hour: h, tokens: 0, calls: 0 });
    }
    const hSumTok = rH1.hourly_today.reduce((a, x) => a + x.tokens, 0);
    assert.equal(hSumTok, rH1.daily.at(-1).tokens);
    assert.equal(hSumTok, rH1.totals.today.input + rH1.totals.today.output + rH1.totals.today.cache_read);
    const rH2 = await scan([[dH, 'desktop']], { cachePath: hCache, days: 7, now: H_NOW, stats: hStats });
    assert.deepEqual([hStats.hits, hStats.misses], [2, 0]);
    assert.deepEqual(rH2.hourly_today, rH1.hourly_today);

    // 5. Mtime fallback without planner steps
    const dMt = join(dir, 'mtime');
    mkdirSync(dMt);
    const pMt = join(dMt, 'a.db');
    makeHistoryDb(pMt, [hCall(50)], { plannerSteps: false });
    const oldSec = hTs(20);
    utimesSync(pMt, oldSec, oldSec);
    const rMt = await scan([[dMt, 'desktop']], { now: H_NOW });
    assert.equal(rMt.totals.d30.calls, 1);
    assert.equal(rMt.totals.d7.calls, 0);

    // 6. Cache invalidation (mtime bump, -wal, deleted DB) & corrupt cache & 0-byte DB & read-only
    const dInv = join(dir, 'inv');
    mkdirSync(dInv);
    const pA = join(dInv, 'a.db');
    const pB = join(dInv, 'b.db');
    makeHistoryDb(pA, [hCall(0)]);
    makeHistoryDb(pB, [hCall(0)]);
    const invCache = join(dir, 'inv-cache.json');
    const invSt = {};
    const ri1 = await scan([[dInv, 'desktop']], { cachePath: invCache, now: H_NOW, stats: invSt });
    assert.deepEqual([invSt.hits, invSt.misses], [0, 2]);
    const ri2 = await scan([[dInv, 'desktop']], { cachePath: invCache, now: H_NOW, stats: invSt });
    assert.deepEqual([invSt.hits, invSt.misses], [2, 0]);
    assert.deepEqual(ri1.totals, ri2.totals);

    // Mutate b.db and bump mtime
    const dbMut = new DatabaseSync(pB);
    dbMut.prepare('INSERT INTO gen_metadata (idx, data) VALUES (99, ?)').run(
      pbMsg(pbField(1, pbField(4, pbField(2, 7))), pbField(3, pbField(28, 'gemini-2.5-pro'))),
    );
    dbMut.close();
    const stB = statSync(pB);
    utimesSync(pB, stB.atimeMs / 1000, stB.mtimeMs / 1000 + 5);
    const ri3 = await scan([[dInv, 'desktop']], { cachePath: invCache, now: H_NOW, stats: invSt });
    assert.deepEqual([invSt.hits, invSt.misses], [1, 1]);
    assert.equal(ri3.totals.all.calls, 3);

    // Add -wal file
    writeFileSync(`${pA}-wal`, new Uint8Array(0));
    await scan([[dInv, 'desktop']], { cachePath: invCache, now: H_NOW, stats: invSt });
    assert.deepEqual([invSt.hits, invSt.misses], [1, 1]);

    // Delete a.db + a.db-wal: Antigravity prunes old conversations, but their usage stays counted
    unlinkSync(pA);
    unlinkSync(`${pA}-wal`);
    const ri4 = await scan([[dInv, 'desktop']], { cachePath: invCache, now: H_NOW, stats: invSt });
    assert.equal(ri4.sources.desktop, 1);
    assert.equal(ri4.archived_conversations, 1);
    assert.deepEqual(ri4.totals, ri3.totals);
    const archivedDbs = JSON.parse(readFileSync(invCache, 'utf8')).dbs;
    assert.equal(Object.keys(archivedDbs).length, 2);
    assert.equal(archivedDbs[resolve(pA)].archived, true);
    assert.equal(ri4.by_conversation.find((c) => c.id === 'a').archived, true);

    // Corrupt cache ignored cleanly
    writeFileSync(invCache, '{not json');
    const ri5 = await scan([[dInv, 'desktop']], { cachePath: invCache, now: H_NOW, stats: invSt });
    assert.equal(invSt.misses, 1);
    assert.equal(ri5.totals.all.calls, 2);

    // Missing roots & custom 3rd label & 0-byte DB & read-only
    const rMiss = await scan([[join(dir, 'nope1'), 'desktop'], [join(dir, 'nope2'), 'cli']], { days: 5, now: H_NOW });
    assert.deepEqual(rMiss.sources, { desktop: 0, cli: 0 });
    assert.equal(rMiss.errors, 0);
    assert.equal(rMiss.daily.length, 5);

    const dLab = join(dir, 'lab');
    mkdirSync(dLab);
    makeHistoryDb(join(dLab, 'o.db'), [hCall(0)]);
    const rLab = await scan([[dInv, 'desktop'], [dLab, 'lab']], { now: H_NOW });
    assert.deepEqual(rLab.sources, { desktop: 1, cli: 0, lab: 1 });

    // 0-byte DB is empty & cached cleanly
    writeFileSync(join(dLab, 'zero.db'), new Uint8Array(0));
    const zSt = {};
    const rZero1 = await scan([[dLab, 'desktop']], { cachePath: join(dir, 'z-cache.json'), now: H_NOW, stats: zSt });
    assert.equal(rZero1.errors, 0);
    assert.equal(rZero1.sources.desktop, 2);
    await scan([[dLab, 'desktop']], { cachePath: join(dir, 'z-cache.json'), now: H_NOW, stats: zSt });
    assert.deepEqual([zSt.hits, zSt.misses], [2, 0]);

    // Read-only DB access preserves bytes, mtimeNs, and creates no -wal
    const roPath = join(dLab, 'o.db');
    const beforeBytes = readFileSync(roPath);
    const beforeMtime = statSync(roPath, { bigint: true }).mtimeNs;
    await scan([[dLab, 'desktop']], { now: H_NOW });
    assert.deepEqual(readFileSync(roPath), beforeBytes);
    assert.equal(statSync(roPath, { bigint: true }).mtimeNs, beforeMtime);
    assert.equal(existsSync(`${roPath}-wal`), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ScannerTest: parseRoot, priceLookup, custom pricing file, modelPool, d7_by_pool & 200-DB perf', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-unit-hist4-'));
  try {
    // 1. parseRoot
    assert.deepEqual(parseRoot('C:\\x\\conv=cli'), ['C:\\x\\conv', 'cli']);
    assert.deepEqual(parseRoot('/tmp/conv'), ['/tmp/conv', 'desktop']);
    assert.deepEqual(parseRoot('a=b/c'), ['a=b/c', 'desktop']);

    // 2. priceInfo / priceFor / callCost / 12 preview fallbacks / unpriced
    const flat = (slug) => { const [p, est] = priceInfo(slug); return [p ? p.slice(0, 3) : p, est]; };
    assert.deepEqual(flat('gemini-2.5-pro'), [[1.25, 10.0, 0.125], false]);
    assert.deepEqual(priceInfo('gemini-2.5-pro')[0][3], { threshold: 200000, input: 2.5, output: 15.0, cache_read: 0.25 });
    assert.deepEqual(priceInfo('gemini-2.5-flash'), [[0.3, 2.5, 0.03], false]);
    assert.deepEqual(priceInfo('gemini-3-flash'), [[0.5, 3.0, 0.05], false]);
    assert.deepEqual(priceInfo('claude-opus-4-6-thinking'), [[5.0, 25.0, 0.5], false]);
    assert.deepEqual(priceInfo('claude-opus-4-1'), [[15.0, 75.0, 1.5], false]);
    assert.deepEqual(priceInfo('claude-sonnet-4-6'), [[3.0, 15.0, 0.3], false]);
    assert.deepEqual(priceInfo('claude-haiku-4-5'), [[1.0, 5.0, 0.1], false]);
    assert.deepEqual(priceInfo('gpt-oss-120b-medium'), [[0.15, 0.6, 0.075], false]);
    assert.deepEqual(priceFor('gemini-2.5-flash'), [0.3, 2.5, 0.03]);
    assert.equal(callCost('claude-opus-4-6-thinking', 1_000_000, 0, 0), 5.0);

    // Published current families price directly (tier suffixes like -high / -tiered-high are prefixes).
    for (const [slug, expected] of [
      ['gemini-4-hydrogen-tiered-high', [1.5, 7.5, 0.075]],
      ['gemini-4-neon-xhigh', [3.0, 15.0, 0.15]],
      ['claude-opus-5-5-medium', [4.0, 20.0, 0.2]],
      ['claude-sonnet-5-0', [2.0, 10.0, 0.2]],
      ['gemini-3.8-flash-n', [0.75, 3.75, 0.075]],
      ['gemini-3.5-flash-lite', [0.3, 2.5, 0.03]],
      ['gemini-2.5-flash-lite-preview', [0.1, 0.4, 0.01]],
    ]) {
      assert.deepEqual(flat(slug), [expected, false], slug);
    }
    // Unreleased / internal ids are estimated from the closest published family.
    for (const [slug, expected] of [
      ['claude-opus-9-medium', [5.0, 25.0, 0.5]],
      ['claude-sonnet-9-0', [3.0, 15.0, 0.3]],
      ['gemini-pro-orchestrator-neon', [3.0, 15.0, 0.15]],
      ['gemini-flash-worker-agy', [0.75, 3.75, 0.075]],
      ['orchestrator-claude-opus-9', [5.0, 25.0, 0.5]],
      ['gemini-5-flash', [0.75, 3.75, 0.075]],
      ['gemini-5-ultra', [2.0, 12.0, 0.2]],
    ]) {
      assert.deepEqual(flat(slug), [expected, true], slug);
    }

    // Long-context tier: the prompt (input + cache read) decides the rate.
    const pro = priceFor('gemini-2.5-pro');
    assert.equal(costOf(pro, 100_000, 1_000, 50_000), (100_000 * 1.25 + 1_000 * 10 + 50_000 * 0.125) / 1e6);
    assert.equal(costOf(pro, 150_000, 1_000, 100_000), (150_000 * 2.5 + 1_000 * 15 + 100_000 * 0.25) / 1e6);
    assert.equal(costOf(priceFor('gemini-4-hydrogen'), 900_000, 0, 0), 900_000 * 1.5 / 1e6, 'flat models have no tier');
    for (const unpriced of ['gemini-embedding-001', 'tab_flash_lite_preview', 'unknown', 'internal-x']) {
      assert.deepEqual(callCostInfo(unpriced, 1000, 100, 0), [null, false], unpriced);
    }

    // 3. loadPricingFile fallbacks + custom override + -lite guard + scan({ pricingFile })
    assert.deepEqual(loadPricingFile(null), [{}, 'builtin', null]);
    assert.deepEqual(loadPricingFile(join(dir, 'missing.json')), [{}, 'builtin', null]);
    const badP = join(dir, 'bad.json');
    writeFileSync(badP, '{not json');
    assert.deepEqual(loadPricingFile(badP), [{}, 'builtin', null]);
    const empP = join(dir, 'empty.json');
    writeFileSync(empP, JSON.stringify({ source: 'litellm', models: {} }));
    assert.deepEqual(loadPricingFile(empP), [{}, 'builtin', null]);

    const pf = join(dir, 'pricing-cache.json');
    writeFileSync(pf, JSON.stringify({
      source: 'openrouter',
      fetched_at: '2026-06-15T10:00:00Z',
      models: {
        'anthropic/claude-opus-4.6': { input: 5.0, output: 25.0, cache_read: 0.5 },
        'google/gemini-2.5-pro': { input: 2.0, output: 12.0, cache_read: 0.4 },
        'google/gemini-2.5-flash': { input: 0.3, output: 2.5, cache_read: 0.075 },
        'google/gemini-2.5-flash-lite': { input: 0.1, output: 0.4, cache_read: 0.02 },
      },
    }));
    const [models, src, fetched] = loadPricingFile(pf);
    assert.deepEqual([src, fetched], ['openrouter', '2026-06-15T10:00:00Z']);
    assert.deepEqual(callCostInfo('claude-opus-4-6-thinking', 1_000_000, 0, 0, models), [5.0, false]);
    assert.deepEqual(callCostInfo('gemini-2.5-flash-lite', 1_000_000, 0, 0, models), [0.1, false]);
    // Unreleased ids fall back to the closest family (synced price first, then built-in).
    assert.deepEqual(callCostInfo('claude-opus-9-medium', 1_000_000, 0, 0, models), [5.0, true]);
    assert.deepEqual(callCostInfo('gemini-9-hydrogen-x', 1_000_000, 0, 0, models), [1.5, true]);

    const dMix = join(dir, 'mix');
    mkdirSync(dMix);
    makeHistoryDb(join(dMix, 'mix.db'), [
      hCall(0, { model: 'claude-opus-4-6-thinking', input: 1_000_000, output: 0, cache: 0 }),
      hCall(2, { model: 'gemini-9-hydrogen-x', input: 1_000_000, output: 0, cache: 0 }),
    ]);
    const rMix = await scan([[dMix, 'desktop']], { pricingFile: pf, now: H_NOW });
    assert.equal(rMix.pricing_source, 'openrouter');
    assert.equal(rMix.totals.today.est_cost_usd, 5.0);
    assert.equal(rMix.totals.today.cost_estimated, false);
    assert.equal(rMix.totals.d7.est_cost_usd, 6.5);
    assert.equal(rMix.totals.d7.cost_estimated, true);

    // 4. modelPool (all 10 strings) + d7_by_pool + scan({ modelCatalogPath })
    for (const [m, pool] of [
      ['gemini-4-hydrogen-tiered-high', 'gemini'],
      ['gemini-pro-orchestrator-neon', 'gemini'],
      ['Orchestrator (Neon)', 'gemini'],
      ['Orchestrator (Claude Opus 5.5)', 'claude_gpt'],
      ['claude-opus-5-5-medium', 'claude_gpt'],
      ['gpt-oss-120b-medium', 'claude_gpt'],
      ['openai/gpt-4o', 'claude_gpt'],
      ['tab_flash_lite_preview', 'other'],
      ['unknown', 'other'],
      ['internal-x', 'other'],
    ]) {
      assert.equal(modelPool(m), pool, m);
    }

    const dPool = join(dir, 'pool');
    mkdirSync(dPool);
    makeHistoryDb(join(dPool, 'multi.db'), [
      hCall(0, { model: 'gemini-4-hydrogen-tiered-high', input: 1000, output: 200, cache: 9000 }),
      hCall(1, { model: 'claude-opus-5-5-medium', input: 400, output: 100, cache: 5000 }),
      hCall(10, { model: 'claude-opus-5-5-medium', input: 9000, output: 900, cache: 5000 }),
    ]);
    makeHistoryDb(join(dPool, 'other.db'), [
      hCall(2, { model: 'internal-x', input: 300, output: 50, cache: 1000 }),
      hCall(3, { model: 'gpt-oss-120b-medium', input: 200, output: 50, cache: 1000 }),
    ]);
    const rPool = await scan([[dPool, 'desktop']], { now: H_NOW });
    assert.deepEqual(rPool.d7_by_pool, { gemini: 1200, claude_gpt: 750, other: 350 });
    const bcP = Object.fromEntries(rPool.by_conversation.map((c) => [c.id, c]));
    // Dominant conversation pool follows cost_by_pool (falling back to d7_by_pool/primaryPool when unpriced).
    assert.equal(bcP.multi.pool, 'claude_gpt');
    assert.ok(bcP.multi.cost_by_pool.claude_gpt > bcP.multi.cost_by_pool.gemini);
    assert.deepEqual(bcP.multi.d7_by_pool, { gemini: 1200, claude_gpt: 500, other: 0 });
    assert.equal(bcP.other.pool, 'claude_gpt');
    assert.ok(bcP.other.cost_by_pool.claude_gpt > 0 && bcP.other.cost_by_pool.other === 0);
    assert.deepEqual(bcP.other.d7_by_pool, { gemini: 0, claude_gpt: 250, other: 350 });
    for (const p of POOLS) {
      assert.equal(rPool.by_conversation.reduce((a, c) => a + c.d7_by_pool[p], 0), rPool.d7_by_pool[p]);
      assert.equal(rPool.by_model.filter((m) => m.pool === p).reduce((a, m) => a + m.d7_tokens, 0), rPool.d7_by_pool[p]);
    }
    const dUnpriced = join(dir, 'unpriced_pool');
    mkdirSync(dUnpriced);
    makeHistoryDb(join(dUnpriced, 'only-other.db'), [
      hCall(2, { model: 'internal-x', input: 300, output: 50, cache: 1000 }),
    ]);
    const rUnpriced = await scan([[dUnpriced, 'desktop']], { now: H_NOW });
    assert.equal(rUnpriced.by_conversation[0].pool, 'other');

    // 4b. End-to-end scan({ modelCatalogPath }) overrides pool & display_name
    const dCat = join(dir, 'cat_scan');
    mkdirSync(dCat);
    const catFile = join(dir, 'scan-model-catalog.json');
    writeJsonAtomic(catFile, {
      'custom-vendor-model-x': {
        displayName: 'Custom Catalog Model',
        pool: 'claude_gpt',
        maxTokens: 200000,
      },
    });
    makeHistoryDb(join(dCat, 'cat.db'), [
      hCall(0, { model: 'custom-vendor-model-x', display: null, input: 300, output: 150, cache: 0 }),
    ]);
    const rCat = await scan([[dCat, 'desktop']], { modelCatalogPath: catFile, now: H_NOW });
    assert.deepEqual(rCat.d7_by_pool, { gemini: 0, claude_gpt: 450, other: 0 });
    assert.equal(rCat.by_model[0].pool, 'claude_gpt');
    assert.equal(rCat.by_model[0].display_name, 'Custom Catalog Model');
    assert.equal(rCat.by_conversation[0].pool, 'claude_gpt');

    // 5. Perf 200 DBs (<5s cold, <2s warm)
    const dPerf = join(dir, 'perf');
    mkdirSync(dPerf);
    for (let i = 0; i < 200; i += 1) {
      makeHistoryDb(join(dPerf, `c${String(i).padStart(3, '0')}.db`), [hCall(i % 40, { input: i }), hCall(i % 7)]);
    }
    const perfCache = join(dir, 'perf-cache.json');
    const perfSt = {};
    const t0 = performance.now();
    const rP1 = await scan([[dPerf, 'desktop']], { cachePath: perfCache, days: 365, now: H_NOW, stats: perfSt });
    const coldMs = performance.now() - t0;
    assert.equal(rP1.totals.all.calls, 400);
    assert.equal(rP1.by_conversation.length, 200);
    assert.equal(rP1.daily.length, 365);
    const t1 = performance.now();
    await scan([[dPerf, 'desktop']], { cachePath: perfCache, days: 365, now: H_NOW, stats: perfSt });
    const warmMs = performance.now() - t1;
    assert.equal(perfSt.hits, 200);
    assert.ok(coldMs < 5000, `cold scan took ${coldMs}ms`);
    assert.ok(warmMs < 2000, `warm scan took ${warmMs}ms`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Additional M1 unit coverage (pb, pricing, catalog, quota, env) ---------

test('M1 unit coverage: pb helpers, pricing meta, catalog, quota NO_LS, ANTIGRAVITY_GEMINI_DIR in history', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-unit-m1-'));
  const prevGemini = process.env.ANTIGRAVITY_GEMINI_DIR;
  const prevLs = process.env.ANTIGRAVITY_LS_ADDRESS;
  const prevCsrf = process.env.ANTIGRAVITY_CSRF_TOKEN;
  try {
    // expandHome
    assert.equal(expandHome('~'), homedir());
    assert.equal(expandHome('~/sub/file'), join(homedir(), 'sub/file'));
    assert.equal(expandHome('/abs/path'), '/abs/path');

    // writeJsonAtomic & fileStamp
    const jsonPath = join(dir, 'nested', 'test.json');
    writeJsonAtomic(jsonPath, { hello: 'world', n: 42 });
    assert.deepEqual(JSON.parse(readFileSync(jsonPath, 'utf8')), { hello: 'world', n: 42 });
    assert.match(fileStamp(jsonPath), /^\d+(?:\.\d+)?:\d+$/);
    assert.equal(fileStamp(join(dir, 'missing.json')), '-');

    // readPricingMeta (missing, fresh, stale)
    const pMissing = readPricingMeta(join(dir, 'nope-pricing.json'));
    assert.deepEqual(pMissing, { source: 'builtin', fetched_at: null, count: 0, stale: true });
    const pFile = join(dir, 'pricing.json');
    const nowMs = Date.parse('2026-11-20T12:00:00Z');
    writeJsonAtomic(pFile, { source: 'litellm', fetched_at: '2026-11-20T10:00:00Z', models: { 'gemini-2.5-pro': { input: 1.25, output: 10, cache_read: 0.3125 } } });
    assert.deepEqual(readPricingMeta(pFile, nowMs), { source: 'litellm', fetched_at: '2026-11-20T10:00:00Z', count: 1, stale: false });
    assert.deepEqual(readPricingMeta(pFile, nowMs + 25 * 3600 * 1000), { source: 'litellm', fetched_at: '2026-11-20T10:00:00Z', count: 1, stale: true });

    // writeModelCatalog & loadModelCatalog
    const catPath = join(dir, 'cat.json');
    const written = writeModelCatalog(catPath, {
      models: { 'gemini-4-test': { displayName: 'Gemini 4 Test', maxTokens: 1_048_576, modelProvider: 'MODEL_PROVIDER_GOOGLE' } },
    });
    assert.ok(written['gemini-4-test']);
    assert.deepEqual(loadModelCatalog(catPath)['gemini-4-test'], written['gemini-4-test']);
    assert.deepEqual(buildModelCatalog(null), {});

    // fetchQuota fails cleanly when LS env vars are unset
    delete process.env.ANTIGRAVITY_LS_ADDRESS;
    delete process.env.ANTIGRAVITY_CSRF_TOKEN;
    const qRes = await fetchQuota({ catalogPath: null, quotaRawPath: null });
    assert.equal(qRes.error, 'unavailable');
    assert.deepEqual(qRes.pools, []);

    // defaultRoots + historyCliMain honor ANTIGRAVITY_GEMINI_DIR
    const customGem = join(dir, 'gem');
    const deskDir = join(customGem, 'antigravity', 'conversations');
    mkdirSync(deskDir, { recursive: true });
    makeHistoryDb(join(deskDir, 'c1.db'), [hCall(0)]);
    process.env.ANTIGRAVITY_GEMINI_DIR = customGem;
    assert.deepEqual(defaultRoots(), [
      [join(resolve(customGem), 'antigravity', 'conversations'), 'desktop'],
      [join(resolve(customGem), 'antigravity-cli', 'conversations'), 'cli'],
    ]);

    let out = '';
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => { out += String(chunk); return true; };
    let code;
    try {
      code = await historyCliMain(['--json', '--days', '5']);
    } finally {
      process.stdout.write = origWrite;
    }
    assert.equal(code, 0);
    const parsed = JSON.parse(out);
    assert.equal(parsed.sources.desktop, 1);
    assert.equal(parsed.daily.length, 5);
    assert.equal(parsed.totals.all.calls, 1);
  } finally {
    if (prevGemini === undefined) delete process.env.ANTIGRAVITY_GEMINI_DIR;
    else process.env.ANTIGRAVITY_GEMINI_DIR = prevGemini;
    if (prevLs === undefined) delete process.env.ANTIGRAVITY_LS_ADDRESS;
    else process.env.ANTIGRAVITY_LS_ADDRESS = prevLs;
    if (prevCsrf === undefined) delete process.env.ANTIGRAVITY_CSRF_TOKEN;
    else process.env.ANTIGRAVITY_CSRF_TOKEN = prevCsrf;
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Iteration 2 regression & edge-case tests --------------------------------

test('M1 Iteration 2: quota lsRequest malformed URL, redact bypasses, and duplicate-category parseQuota', async () => {
  const prevLs = process.env.ANTIGRAVITY_LS_ADDRESS;
  const prevCsrf = process.env.ANTIGRAVITY_CSRF_TOKEN;
  try {
    // 1. lsRequest / fetchQuota handle malformed ANTIGRAVITY_LS_ADDRESS asynchronously
    process.env.ANTIGRAVITY_LS_ADDRESS = 'http://[invalid-url';
    process.env.ANTIGRAVITY_CSRF_TOKEN = 'test-csrf-token';
    const p = lsRequest('GetUserStatus', { metadata: {} });
    assert.ok(p && typeof p.then === 'function');
    await assert.rejects(p, /Invalid URL/);
    const qRes = await fetchQuota({ catalogPath: null, quotaRawPath: null });
    assert.equal(qRes.error, 'failed');
    assert.deepEqual(qRes.pools, []);
    assert.match(qRes.message, /Invalid URL/);

    // 2. redact covers short JWTs, case-insensitive bearer, nested person & secret objects
    const redacted = redact({
      shortJwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnop',
      noneJwt: 'eyJhbGciOiJub25lIn0.eyJzdWIiOiIxIn0.sig1234567890',
      lowerBearer: 'bearer my_secret_token_xyz',
      upperBearer: 'BEARER Upper.Token_123',
      userStatus: {
        info: { name: 'Leak Name', displayName: 'Leak Display' },
        accounts: [{ name: 'Arr Name' }],
        userTier: { name: 'Google AI Ultra' },
      },
      accounts: [{ display_name: 'Top Account' }],
      credentials: { raw: 'super-secret-value', items: ['s1', { deep: 's2' }], count: 2 },
    });
    assert.equal(redacted.shortJwt, '[redacted]');
    assert.equal(redacted.noneJwt, '[redacted]');
    assert.equal(redacted.lowerBearer, '[redacted]');
    assert.equal(redacted.upperBearer, '[redacted]');
    assert.equal(redacted.userStatus.info.name, '[redacted]');
    assert.equal(redacted.userStatus.info.displayName, '[redacted]');
    assert.equal(redacted.userStatus.accounts[0].name, '[redacted]');
    assert.equal(redacted.userStatus.userTier.name, 'Google AI Ultra');
    assert.equal(redacted.accounts[0].display_name, '[redacted]');
    assert.equal(redacted.credentials.raw, '[redacted]');
    assert.equal(redacted.credentials.items[0], '[redacted]');
    assert.equal(redacted.credentials.items[1].deep, '[redacted]');
    assert.equal(redacted.credentials.count, 2);

    // 3. parseQuota does not overwrite secondary unlimited pool with summary of limited pool
    const now = Date.parse('2026-11-20T10:00:00Z');
    const summary = {
      response: {
        groups: [{
          displayName: 'Gemini Limit Remaining',
          buckets: [
            { bucketId: 'gemini-5h', displayName: 'Five Hour Limit Remaining', remainingFraction: 0.72, resetTime: '2026-11-20T12:00:00Z' },
            { bucketId: 'gemini-weekly', displayName: 'Weekly Limit Remaining', remainingFraction: 0.85, resetTime: '2026-11-27T00:00:00Z' },
          ],
        }],
      },
    };
    const mkModels = (unlimitedFirst) => {
      const entries = [
        ['gemini-pro', { displayName: 'Gemini Pro', quotaInfo: { remainingFraction: 0.72, resetTime: '2026-11-20T12:00:00Z' }, modelProvider: 'MODEL_PROVIDER_GOOGLE' }],
        ['gemini-flash-free', { displayName: 'Gemini Flash Free', quotaInfo: { remainingFraction: 1 }, modelProvider: 'MODEL_PROVIDER_GOOGLE' }],
      ];
      if (unlimitedFirst) entries.reverse();
      return {
        response: {
          models: Object.fromEntries(entries),
          agentModelSorts: [{ groups: [{ modelIds: entries.map(([id]) => id) }] }],
        },
      };
    };
    for (const unlimitedFirst of [false, true]) {
      const r = parseQuota(null, mkModels(unlimitedFirst), now, summary);
      assert.equal(r.pools.length, 2);
      const limited = r.pools.find((pool) => pool.models.some((m) => m.id === 'gemini-pro'));
      const unlimited = r.pools.find((pool) => pool.models.some((m) => m.id === 'gemini-flash-free'));
      assert.equal(limited.remaining_fraction, 0.72);
      assert.deepEqual(limited.limits.map((l) => [l.kind, l.remaining_fraction]), [['weekly', 0.85], ['5h', 0.72]]);
      assert.equal(unlimited.remaining_fraction, 1);
      assert.equal(unlimited.reset_time, null);
      assert.equal(unlimited.limits.length, 1);
      assert.equal(unlimited.limits[0].kind, 'none');
    }
  } finally {
    if (prevLs === undefined) delete process.env.ANTIGRAVITY_LS_ADDRESS;
    else process.env.ANTIGRAVITY_LS_ADDRESS = prevLs;
    if (prevCsrf === undefined) delete process.env.ANTIGRAVITY_CSRF_TOKEN;
    else process.env.ANTIGRAVITY_CSRF_TOKEN = prevCsrf;
  }
});

test('M1 Iteration 2: pricing callCostInfo defaults, custom prefix vs builtin exact, and readPricingMeta custom source', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-unit-m1r2-price-'));
  try {
    // 1. callCostInfo defaults omitted/non-finite/negative tokens to 0
    assert.deepEqual(callCostInfo('gemini-2.5-pro', 1000, 1000), [0.01125, false]);
    assert.deepEqual(callCostInfo('gemini-2.5-pro', -100, -50, -10), [0, false]);
    assert.deepEqual(callCostInfo('gemini-2.5-pro', Number.NaN, undefined, Number.POSITIVE_INFINITY), [0, false]);
    assert.deepEqual(callCostInfo('gemini-2.5-pro'), [0, false]);
    assert.deepEqual(callCostInfo('unknown-model', 1000, 1000), [null, false]);

    // 2. lookupDirect precedence: custom exact > builtin exact > custom prefix > builtin prefix
    const customPrefix = { 'claude-sonnet-4': [99, 99, 99] };
    assert.deepEqual(priceInfo('claude-sonnet-4-6', customPrefix), [[3.0, 15.0, 0.3], false]);
    assert.deepEqual(priceInfo('claude-sonnet-4-custom', customPrefix), [[99, 99, 99], false]);
    assert.deepEqual(priceInfo('claude-sonnet-4-6', { 'claude-sonnet-4-6': [7, 8, 1] }), [[7, 8, 1], false]);

    // 3. readPricingMeta preserves non-empty custom source
    const pCustom = join(dir, 'custom-pricing.json');
    const nowMs = Date.parse('2026-11-22T00:00:00Z');
    writeJsonAtomic(pCustom, {
      source: 'custom',
      fetched_at: '2026-11-22T00:00:00Z',
      models: { 'my-model': [1, 2, 0.1] },
    });
    assert.deepEqual(readPricingMeta(pCustom, nowMs), {
      source: 'custom',
      fetched_at: '2026-11-22T00:00:00Z',
      count: 1,
      stale: false,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('M1 Iteration 2: main.mjs honors truthy(CONTEXT_PANEL_NO_SERVER) for 0 vs 1', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-unit-m1r2-main-'));
  try {
    const mainUrl = pathToFileURL(resolve('sidecars', 'agy-lens', 'main.mjs')).href;
    const probeScript = `
      import { register } from 'node:module';
      const hooks = \`
        export function resolve(specifier, context, next) {
          if (specifier === 'sidecar_sdk') return { shortCircuit: true, url: 'mock:sidecar_sdk' };
          return next(specifier, context);
        }
        export function load(url, context, next) {
          if (url === 'mock:sidecar_sdk') {
            return {
              shortCircuit: true,
              format: 'module',
              source: 'globalThis.__sidecarRan = false; export class Response { constructor(b, o) { this.body = b; this.opts = o; } } export class SidecarApp { page() {} api() {} run() { globalThis.__sidecarRan = true; } }'
            };
          }
          return next(url, context);
        }
      \`;
      register('data:text/javascript;base64,' + Buffer.from(hooks).toString('base64'));
      const mod = await import(${JSON.stringify(mainUrl)});
      process.stdout.write(JSON.stringify({ ran: Boolean(globalThis.__sidecarRan), t0: mod.truthy('0'), t1: mod.truthy('1') }));
    `;
    const runCase = (val) => {
      const res = spawnSync(process.execPath, ['--input-type=module', '-e', probeScript], {
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          CONTEXT_PANEL_NO_SERVER: val,
          ANTIGRAVITY_EXECUTABLE_DATA_DIR: dir,
          ANTIGRAVITY_LS_ADDRESS: '',
          ANTIGRAVITY_CSRF_TOKEN: '',
        },
        encoding: 'utf8',
      });
      assert.equal(res.status, 0, res.stderr);
      return JSON.parse(res.stdout);
    };
    const r0 = runCase('0');
    assert.equal(r0.ran, true);
    assert.equal(r0.t0, false);
    assert.equal(r0.t1, true);
    const r1 = runCase('1');
    assert.equal(r1.ran, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Cost accounting fixes: compaction calls & pruned conversations ----------

test('CostFix: costOf longContext override keeps tier pricing exact for aggregated rows', () => {
  const p = priceFor('gemini-2.5-pro');
  // Two small calls summed past 200k must still use base prices when flagged short.
  assert.equal(costOf(p, 150000, 0, 150000, false), (150000 * p[0] + 150000 * p[2]) / 1e6);
  assert.equal(costOf(p, 150000, 0, 150000), (150000 * p[3].input + 150000 * p[3].cache_read) / 1e6);
  assert.equal(costOf(p, 1000, 10, 0, true), (1000 * p[3].input + 10 * p[3].output) / 1e6);
});

test('CostFix: checkpoint/compaction usage stored only in step metadata is counted once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-unit-costfix-'));
  try {
    const dbPath = join(dir, 'c.db');
    makeHistoryDb(dbPath, [hCall(0, { model: 'gemini-2.5-pro', input: 100, output: 10, cache: 1000, thinking: 5 })]);
    const conn = new DatabaseSync(dbPath);
    // Give the generation a model enum + response id, mirror it on a planner step (duplicate).
    const genUsage = pbMsg(pbField(1, 1530), pbField(2, 100), pbField(3, 10), pbField(5, 1000), pbField(9, 5), pbField(11, 'resp-gen'));
    conn.prepare('UPDATE gen_metadata SET data = ? WHERE idx = 0').run(
      pbMsg(pbField(1, pbMsg(pbField(4, genUsage), pbField(21, 'Gemini 2.5 Pro'))), pbField(3, pbField(28, 'gemini-2.5-pro'))),
    );
    conn.prepare('INSERT INTO steps (idx, step_type, metadata) VALUES (100, 15, ?)').run(pbField(9, genUsage));
    // Compaction call: md.9 and the same call again under md.28[].2 (retry record) -> counted once.
    const compact = pbMsg(pbField(1, 1530), pbField(2, 2000), pbField(3, 300), pbField(5, 40000), pbField(9, 20), pbField(11, 'resp-compact'));
    const ts = Math.trunc(hTs(0, 11));
    conn.prepare('INSERT INTO steps (idx, step_type, metadata) VALUES (101, 23, ?)').run(
      pbMsg(pbField(1, pbField(1, ts)), pbField(9, compact), pbField(28, pbField(2, compact))),
    );
    // Usage without any id cannot be de-duplicated and is ignored.
    conn.prepare('INSERT INTO steps (idx, step_type, metadata) VALUES (102, 23, ?)').run(
      pbField(9, pbMsg(pbField(2, 999), pbField(3, 9))),
    );
    conn.close();

    const r = await scan([[dir, 'desktop']], { now: H_NOW });
    assert.equal(r.totals.all.calls, 2);
    assert.equal(r.totals.all.input, 2100);
    assert.equal(r.totals.all.output, 310);
    assert.equal(r.totals.all.cache_read, 41000);
    assert.equal(r.totals.all.thinking, 25);
    assert.deepEqual(r.by_model.map((m) => m.model), ['gemini-2.5-pro']); // enum 1530 -> gemini-2.5-pro
    const expected = callCost('gemini-2.5-pro', 100, 10, 1000) + callCost('gemini-2.5-pro', 2000, 300, 40000);
    assert.equal(r.totals.all.est_cost_usd, roundN(expected, 4));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CostFix: usage of conversations deleted by Antigravity survives, compacted, across versions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-unit-archive-'));
  try {
    const root = join(dir, 'conv');
    mkdirSync(root);
    const pOld = join(root, 'old.db');
    const pKeep = join(root, 'keep.db');
    // Many short calls in one 15-minute bucket plus one long-context call.
    const calls = [];
    for (let i = 0; i < 20; i += 1) calls.push(hCall(3, { input: 15000, output: 100, cache: 0, ts: hTs(3) + i * 10 }));
    calls.push(hCall(3, { input: 150000, output: 100, cache: 100000, ts: hTs(3) + 300 }));
    makeHistoryDb(pOld, calls);
    makeHistoryDb(pKeep, [hCall(0)]);
    const cachePath = join(dir, 'cache.json');
    const before = await scan([[root, 'desktop']], { cachePath, now: H_NOW });

    unlinkSync(pOld);
    const after = await scan([[root, 'desktop']], { cachePath, now: H_NOW });
    assert.equal(after.archived_conversations, 1);
    assert.deepEqual(after.totals, before.totals); // same calls, tokens and cost
    assert.deepEqual(after.daily, before.daily);
    const archived = JSON.parse(readFileSync(cachePath, 'utf8')).dbs[resolve(pOld)];
    assert.equal(archived.archived, true);
    assert.equal(archived.calls.length, 2); // 20 short calls -> 1 bucket, long call -> its own bucket
    const old = after.by_conversation.find((c) => c.id === 'old');
    assert.equal(old.archived, true);
    assert.equal(old.calls, 21);

    // Stays archived on later scans, and scans of other roots do not adopt it.
    const again = await scan([[root, 'desktop']], { cachePath, now: H_NOW });
    assert.deepEqual(again.totals, before.totals);
    const otherRoot = join(dir, 'other');
    mkdirSync(otherRoot);
    const other = await scan([[otherRoot, 'desktop']], { cachePath: join(dir, 'cache.json'), now: H_NOW });
    assert.equal(other.archived_conversations, 0);

    // A v4 cache (pre-fix) is upgraded: live DBs re-parsed, vanished ones kept.
    const v4Path = join(dir, 'v4.json');
    const ghost = resolve(join(root, 'ghost.db'));
    writeFileSync(v4Path, JSON.stringify({
      version: 4,
      dbs: {
        [ghost]: { fp: ['1', '1', '0', '0'], calls: [[hTs(1), 'gemini-2.5-pro', 100, 10, 1000, 5]], names: {}, first_input: 'gone' },
        [resolve(pKeep)]: { fp: ['1', '1', '0', '0'], calls: [], names: {}, first_input: null },
      },
    }));
    const st = {};
    const up = await scan([[root, 'desktop']], { cachePath: v4Path, now: H_NOW, stats: st });
    assert.equal(st.misses, 1); // keep.db re-parsed, not trusted from v4
    assert.equal(up.archived_conversations, 1);
    assert.equal(up.totals.all.calls, 2);
    assert.equal(JSON.parse(readFileSync(v4Path, 'utf8')).version, CACHE_VERSION);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Official weekly cycle ledger, weekly valuation, legacy import, subagent trees ---

function makeSummariesDb(path, rows) {
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE conversation_summaries (conversation_id text PRIMARY KEY, title text NOT NULL DEFAULT '', preview text NOT NULL DEFAULT '', agent_name text NOT NULL DEFAULT '', parent_conversation_id text NOT NULL DEFAULT '')");
  for (const r of rows) {
    db.prepare('INSERT INTO conversation_summaries (conversation_id, title, agent_name, parent_conversation_id) VALUES (?, ?, ?, ?)')
      .run(r.id, r.title || '', r.agent || '', r.parent || '');
  }
  db.close();
}

test('QuotaCycles: cycle ledger persists, deduplicates jitter, locks saturation & bootstraps from quota-raw', async () => {
  const { loadQuotaCycles, mergeQuotaObservation, recordQuotaCycles, WEEK_MS } = await import('../sidecars/agy-lens/lib/quota.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'agy-unit-cycles-'));
  try {
    const cyclesPath = join(dir, 'quota-cycles.json');
    const resetMs = Date.parse('2026-11-28T08:51:10.000Z');
    const resetIso = new Date(resetMs).toISOString();

    // 1. Progresses within same cycle and tracks peak_unsaturated.
    let ledger = recordQuotaCycles(cyclesPath, {
      plan: 'Pro',
      tier: 'Pro',
      fetched_at: '2026-11-22T06:00:00.000Z',
      weekly: { gemini: { remaining_fraction: 0.6, reset_time: resetIso } },
    });
    assert.equal(ledger.pools.gemini.length, 1);
    assert.equal(ledger.pools.gemini[0].cycle_start, new Date(resetMs - WEEK_MS).toISOString());
    assert.equal(ledger.pools.gemini[0].used_fraction, 0.4);
    assert.equal(ledger.pools.gemini[0].saturated, false);
    assert.equal(ledger.pools.gemini[0].peak_unsaturated.used_fraction, 0.4);

    // 2. Small jitter on reset_time (±30s) merges into same cycle instead of duplicating.
    ledger = recordQuotaCycles(cyclesPath, {
      plan: 'Pro',
      tier: 'Pro',
      fetched_at: '2026-11-22T09:00:00.000Z',
      weekly: { gemini: { remaining_fraction: 0.05, reset_time: new Date(resetMs + 30_000).toISOString() } },
    });
    assert.equal(ledger.pools.gemini.length, 1);
    assert.equal(ledger.pools.gemini[0].used_fraction, 0.95);
    assert.equal(ledger.pools.gemini[0].peak_unsaturated.observed_at, '2026-11-22T09:00:00.000Z');

    // 3. Saturation (0% left) locks observed_at on first saturation and keeps peak_unsaturated.
    ledger = recordQuotaCycles(cyclesPath, {
      fetched_at: '2026-11-22T10:00:00.000Z',
      weekly: { gemini: { remaining_fraction: 0, reset_time: resetIso } },
    });
    assert.equal(ledger.pools.gemini[0].saturated, true);
    assert.equal(ledger.pools.gemini[0].observed_at, '2026-11-22T10:00:00.000Z');
    // Subsequent saturated polls do NOT advance observed_at or overwrite peak_unsaturated.
    ledger = recordQuotaCycles(cyclesPath, {
      fetched_at: '2026-11-23T12:00:00.000Z',
      weekly: { gemini: { remaining_fraction: 0, reset_time: resetIso } },
    });
    assert.equal(ledger.pools.gemini[0].observed_at, '2026-11-22T10:00:00.000Z');
    assert.equal(ledger.pools.gemini[0].peak_unsaturated.used_fraction, 0.95);

    // 4. Next week's reset starts a second cycle, sorted newest-first; expired/malformed resets ignored.
    const nextResetIso = new Date(resetMs + WEEK_MS).toISOString();
    ledger = recordQuotaCycles(cyclesPath, {
      fetched_at: '2026-11-29T10:00:00.000Z',
      weekly: {
        gemini: { remaining_fraction: 0.8, reset_time: nextResetIso },
        claude_gpt: { remaining_fraction: 0.5, reset_time: '2026-11-20T00:00:00.000Z' }, // already expired
      },
    });
    assert.equal(ledger.pools.gemini.length, 2);
    assert.equal(ledger.pools.gemini[0].reset_time, nextResetIso);
    assert.equal(ledger.pools.gemini[1].reset_time, resetIso);
    assert.equal(ledger.pools.claude_gpt, undefined);

    // Malformed cycle not yet started is rejected by mergeQuotaObservation.
    const futureCheck = mergeQuotaObservation(ledger, {
      fetched_at: '2026-11-29T10:00:00.000Z',
      weekly: { gemini: { remaining_fraction: 0.9, reset_time: '2026-12-20T10:00:00.000Z' } },
    });
    assert.equal(futureCheck.changed, false);

    // 5. Bootstrap from quota-raw.json when quota-cycles.json does not exist yet.
    const bootDir = join(dir, 'boot');
    mkdirSync(bootDir);
    const rawPath = join(bootDir, 'quota-raw.json');
    const bootCyclesPath = join(bootDir, 'quota-cycles.json');
    writeFileSync(rawPath, JSON.stringify({
      written_at: '2026-11-22T08:48:34.569Z',
      GetUserStatus: { userStatus: { planStatus: { planInfo: { planName: 'Pro' } }, userTier: { name: 'Pro' } } },
      RetrieveUserQuotaSummary: {
        response: {
          groups: [{
            displayName: 'Gemini Models',
            buckets: [{ bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.48, resetTime: '2026-11-28T08:51:10Z' }],
          }],
        },
      },
    }));
    const loaded = loadQuotaCycles(bootCyclesPath, rawPath);
    assert.equal(loaded.pools.gemini.length, 1);
    assert.equal(loaded.pools.gemini[0].used_fraction, 0.52);
    assert.equal(loaded.pools.gemini[0].plan, 'Pro');
    assert.equal(existsSync(bootCyclesPath), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('WeeklyValuation: exact cycle alignment, shrinkage change_pct, <1% & saturation guards, no 7d fallback, legacy import', async () => {
  const { readLegacyCache } = await import('../sidecars/agy-lens/lib/history.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'agy-unit-wk-'));
  try {
    const root = join(dir, 'conversations');
    mkdirSync(root);
    // Anchor times using H_NOW.
    const tPrev1 = hTs(10); // inside prev cycle [t=-14d, -7d)
    const tPrevPost = hTs(8, 18); // inside prev cycle AFTER prev observed_at -> excluded from observed_cost_usd
    const tCur1 = hTs(4); // inside current cycle [-7d, 0d+3d)
    const tCurPost = hTs(1); // inside current cycle AFTER cur observed_at -> excluded from valuation!

    makeHistoryDb(join(root, 'a.db'), [
      hCall(10, { ts: tPrev1, input: 100000, output: 10000, cache: 0 }),
      hCall(8, { ts: tPrevPost, input: 50000, output: 5000, cache: 0 }),
      hCall(4, { ts: tCur1, input: 80000, output: 8000, cache: 0 }),
      hCall(1, { ts: tCurPost, input: 90000, output: 9000, cache: 0 }),
    ]);

    const prevResetIso = new Date((hTs(7) + 1) * 1000).toISOString();
    const prevObsIso = new Date((hTs(9) + 1) * 1000).toISOString(); // between tPrev1 (10d ago) and tPrevPost (8d ago)
    const curResetIso = new Date((hTs(-3) + 1) * 1000).toISOString();
    const curObsIso = new Date((hTs(2) + 1) * 1000).toISOString(); // between tCur1 (4d ago) and tCurPost (1d ago)

    const quotaCycles = {
      version: 1,
      pools: {
        gemini: [
          {
            cycle_start: new Date((hTs(4) - 3 * 86400) * 1000).toISOString(),
            reset_time: curResetIso,
            observed_at: curObsIso,
            remaining_fraction: 0.6, // 40% used
            used_fraction: 0.4,
            saturated: false,
          },
          {
            cycle_start: new Date((hTs(14) + 1) * 1000).toISOString(),
            reset_time: prevResetIso,
            observed_at: prevObsIso,
            remaining_fraction: 0.8, // 20% used
            used_fraction: 0.2,
            saturated: false,
          },
        ],
      },
    };

    const r = await scan([[root, 'desktop']], { now: H_NOW, quotaCycles });
    const cPrev = callCost('gemini-2.5-pro', 100000, 10000, 0);
    const cPrevPost = callCost('gemini-2.5-pro', 50000, 5000, 0);
    const cCur = callCost('gemini-2.5-pro', 80000, 8000, 0);
    const cCurPost = callCost('gemini-2.5-pro', 90000, 9000, 0);

    const gCycles = r.weekly_cycles.gemini;
    assert.equal(gCycles.length, 2);
    // Current cycle: evaluated at curObsIso (before tCurPost!) -> weekly_value_usd = cCur / 0.4
    const curVal = roundN(cCur / 0.4, 2);
    const prevVal = roundN(cPrev / 0.2, 2);
    assert.equal(gCycles[0].is_current, true);
    assert.equal(gCycles[0].observed_cost_usd, roundN(cCur, 4));
    assert.equal(gCycles[0].cycle_cost_usd, roundN(cCur + cCurPost, 4));
    assert.equal(gCycles[0].weekly_value_usd, curVal);
    assert.equal(gCycles[0].prev_weekly_value_usd, prevVal);
    assert.equal(gCycles[0].change_pct, roundN(((curVal - prevVal) / prevVal) * 100, 1));
    assert.ok(gCycles[0].change_pct < 0); // quota shrank vs prev week!
    // Previous cycle also excludes tPrevPost from observed_cost_usd.
    assert.equal(gCycles[1].is_current, false);
    assert.equal(gCycles[1].observed_cost_usd, roundN(cPrev, 4));
    assert.equal(gCycles[1].cycle_cost_usd, roundN(cPrev + cPrevPost, 4));
    assert.equal(gCycles[1].weekly_value_usd, prevVal);
    assert.equal(gCycles[1].change_pct, null);
    assert.equal(r.weekly_value_usd.gemini, curVal);
    assert.equal(r.by_conversation[0].cost_by_pool.gemini, roundN(cPrev + cPrevPost + cCur + cCurPost, 6));

    // Fresh reset (<1% used in current cycle): current value null, pool benchmark falls back to last valid week!
    const resetCycles = {
      version: 1,
      pools: {
        gemini: [
          { ...quotaCycles.pools.gemini[0], remaining_fraction: 0.995, used_fraction: 0.005 },
          quotaCycles.pools.gemini[1],
        ],
      },
    };
    const rLow = await scan([[root, 'desktop']], { now: H_NOW, quotaCycles: resetCycles });
    assert.equal(rLow.weekly_cycles.gemini[0].weekly_value_usd, null);
    assert.equal(rLow.weekly_value_usd.gemini, prevVal);

    // Saturation guard: saturated cycle evaluates using peak_unsaturated instead of post-limit AI credit spend!
    const satCycles = {
      version: 1,
      pools: {
        gemini: [{
          cycle_start: new Date((hTs(4) - 3 * 86400) * 1000).toISOString(),
          reset_time: curResetIso,
          observed_at: new Date((hTs(0) + 1) * 1000).toISOString(), // includes tCurPost AI-credit spend
          remaining_fraction: 0,
          used_fraction: 1,
          saturated: true,
          peak_unsaturated: { observed_at: curObsIso, remaining_fraction: 0.2, used_fraction: 0.8 },
        }],
      },
    };
    const rSat = await scan([[root, 'desktop']], { now: H_NOW, quotaCycles: satCycles });
    assert.equal(rSat.weekly_cycles.gemini[0].eval_used_fraction, 0.8);
    assert.equal(rSat.weekly_cycles.gemini[0].observed_cost_usd, roundN(cCur, 4));
    assert.equal(rSat.weekly_value_usd.gemini, roundN(cCur / 0.8, 2));

    // Without quotaCycles: NO rolling 7-day fallback!
    const rNoCycles = await scan([[root, 'desktop']], { now: H_NOW });
    assert.deepEqual(rNoCycles.weekly_cycles, { gemini: [], claude_gpt: [], other: [] });
    assert.deepEqual(rNoCycles.weekly_value_usd, { gemini: null, claude_gpt: null, other: null });

    // Legacy cache from another build: deleted conversation imported, live/foreign ones not.
    mkdirSync(join(dir, 'old'));
    const legacyPath = join(dir, 'old', 'history-cache.json');
    writeFileSync(legacyPath, JSON.stringify({
      version: 3,
      dbs: {
        [join(root, 'gone.db')]: { fp: [], calls: [[hTs(2), 'gemini-2.5-pro', 100, 10, 1000, 5], ['bad']], names: {}, first_input: 'old one' },
        [join(root, 'a.db')]: { fp: [], calls: [[hTs(2), 'gemini-2.5-pro', 9, 9, 9, 9]], names: {} },
        [join(dir, 'elsewhere', 'x.db')]: { fp: [], calls: [[hTs(2), 'gemini-2.5-pro', 9, 9, 9, 9]], names: {} },
      },
    }));
    assert.equal(Object.keys(readLegacyCache(legacyPath)).length, 2); // a.db exists -> skipped
    const cachePath = join(dir, 'cache.json');
    const st = {};
    const ri = await scan([[root, 'desktop']], { now: H_NOW, cachePath, legacyCachePaths: [legacyPath], stats: st });
    assert.equal(st.imported, 1);
    assert.equal(ri.archived_conversations, 1);
    assert.equal(ri.totals.all.calls, 5);
    const gone = ri.by_conversation.find((c) => c.id === 'gone');
    assert.equal(gone.archived, true);
    assert.equal(gone.title, 'old one');
    const st2 = {};
    const ri2 = await scan([[root, 'desktop']], { now: H_NOW, cachePath, legacyCachePaths: [legacyPath], stats: st2 });
    assert.equal(st2.imported, 0); // same legacy file is not re-read
    assert.deepEqual(ri2.totals, ri.totals);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('TreeFix: subagent usage rolls up to parents (multi-level, placeholders, cycles, cap)', async () => {
  const { buildConversationTree, findSubagentDbs } = await import('../sidecars/agy-lens/lib/history.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'agy-unit-tree-'));
  try {
    const root = join(dir, 'conversations');
    mkdirSync(root);
    makeHistoryDb(join(root, 'main.db'), [hCall(0, { input: 1000, output: 100, cache: 0 })]);
    makeHistoryDb(join(root, 'sub1.db'), [hCall(0, { input: 200, output: 20, cache: 0 })]);
    makeHistoryDb(join(root, 'sub2.db'), [hCall(0, { input: 300, output: 30, cache: 0 })]);
    makeHistoryDb(join(root, 'grand.db'), [hCall(0, { input: 50, output: 5, cache: 0 })]);
    // 'orphan' belongs to a parent that has no usage of its own (no db).
    makeHistoryDb(join(root, 'orphan.db'), [hCall(1, { input: 70, output: 7, cache: 0 })]);
    makeSummariesDb(join(dir, 'conversation_summaries.db'), [
      { id: 'main', title: 'Main task' },
      { id: 'sub1', agent: 'teamwork_worker', parent: 'main' },
      { id: 'sub2', agent: 'teamwork_reviewer', parent: 'main' },
      { id: 'grand', agent: 'teamwork_explorer', parent: 'sub1' },
      { id: 'orphan', agent: 'browser', parent: 'ghost' },
      { id: 'ghost', title: 'Parent without calls' },
    ]);
    const cachePath = join(dir, 'cache.json');
    const r = await scan([[root, 'desktop']], { now: H_NOW, cachePath });
    const by = Object.fromEntries(r.by_conversation.map((c) => [c.id, c]));
    assert.deepEqual(r.by_conversation.map((c) => c.id), ['main', 'sub1', 'grand', 'sub2', 'ghost', 'orphan']);
    assert.equal(by.main.depth, 0);
    assert.equal(by.grand.depth, 2);
    assert.equal(by.grand.root_id, 'main');
    assert.equal(by.sub1.parent_id, 'main');
    assert.deepEqual(by.main.children, ['sub1', 'sub2']); // same activity time -> by id
    assert.equal(by.main.input, 1000); // own usage unchanged
    assert.equal(by.main.total.input, 1550); // itself + every level below
    assert.equal(by.main.total.output, 155);
    assert.equal(by.main.total.calls, 4);
    assert.equal(by.main.total.subagents, 3);
    assert.equal(by.sub1.total.input, 250);
    assert.equal(by.sub1.total.subagents, 1);
    const mainTreeCost = roundN(callCost('gemini-2.5-pro', 1000, 100, 0) + callCost('gemini-2.5-pro', 200, 20, 0) + callCost('gemini-2.5-pro', 300, 30, 0) + callCost('gemini-2.5-pro', 50, 5, 0), 4);
    assert.equal(by.main.total.est_cost_usd, mainTreeCost);
    assert.equal(by.main.total.cost_by_pool.gemini > by.main.cost_by_pool.gemini, true);
    assert.equal(by.sub1.is_subagent, true);
    assert.equal(by.sub1.agent, 'teamwork_worker');
    assert.equal(by.ghost.placeholder, true);
    assert.equal(by.ghost.title, 'Parent without calls');
    assert.equal(by.ghost.calls, 0);
    assert.equal(by.ghost.total.input, 70);
    assert.equal(by.ghost.model, 'gemini-2.5-pro'); // taken from its subtree
    // Window totals count every call once, never per tree level.
    assert.equal(r.totals.all.input, 1620);
    // The link survives in the cache once the subagent's database is deleted.
    unlinkSync(join(root, 'grand.db'));
    const ra = await scan([[root, 'desktop']], { now: H_NOW, cachePath });
    const byA = Object.fromEntries(ra.by_conversation.map((c) => [c.id, c]));
    assert.equal(byA.grand.archived, true);
    assert.equal(byA.grand.parent_id, 'sub1');
    assert.equal(byA.main.total.input, 1550);

    // Live session of `main` includes subagent databases still on disk.
    const subs = await findSubagentDbs([[root, 'desktop']], 'main');
    assert.deepEqual(subs.map((p) => p.slice(root.length + 1)).sort(), ['sub1.db', 'sub2.db']);
    const ses = await collectSession(join(root, 'main.db'), { subagentDbPaths: subs });
    assert.equal(ses.input, 1500);
    assert.equal(ses.calls, 3);
    assert.equal(ses.subagents, 2);
    assert.equal(ses.self.input, 1000);
    assert.ok(ses.cost_by_pool.gemini > 0);
    assert.equal((await collectSession(join(root, 'main.db'))).self, undefined);

    // Cycles are broken; the cap keeps every top-level conversation first.
    const mk = (id, last) => ({ id, input: 1, output: 0, cache_read: 0, thinking: 0, calls: 1, d7_tokens: 0, est_cost_usd: 1, d7_by_pool: {}, cost_by_pool: {}, _last: last, _models: new Map() });
    const cyc = buildConversationTree([mk('a', 1), mk('b', 2)], new Map([['a', 'b'], ['b', 'a']]), 10, () => null);
    assert.equal(cyc.length, 2);
    assert.equal(cyc.filter((c) => c.depth === 0).length, 1);
    const many = [mk('r1', 10), mk('r2', 1)];
    const links = new Map();
    for (let i = 0; i < 5; i += 1) { many.push(mk(`c${i}`, 9 - i)); links.set(`c${i}`, 'r1'); }
    const capped = buildConversationTree(many, links, 3, () => null);
    assert.deepEqual(capped.map((c) => c.id), ['r1', 'c0', 'r2']);
    assert.equal(capped[0].total.calls, 6);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FrontendWeekly: weekly_value_usd sizing (incl. >100% & historical items), no d7 fallback, delta helpers & subtree swap', async () => {
  const f = await import('../sidecars/agy-lens/web/format.js');
  const weeklyValueUsd = { gemini: 200, claude_gpt: 100 };
  const t = (k, v) => (k === 'ofPoolQuota' ? `~${v}` : k);

  // Item sizing is cost / pool weekly value — historical items and >100% projects work directly.
  const c = { pool: 'gemini', d7_tokens: 0, cost_by_pool: { gemini: 50, claude_gpt: 25 }, est_cost_usd: 75 };
  assert.equal(f.convWeeklyLabel(c, { weeklyValueUsd, t }), '~25%');
  assert.equal(f.poolRowLabel(c, 'claude_gpt', { weeklyValueUsd, t }), '~25%');
  const huge = { pool: 'gemini', cost_by_pool: { gemini: 284 } };
  assert.equal(f.convWeeklyLabel(huge, { weeklyValueUsd, t }), '~142%'); // never clamped to 100%
  assert.equal(f.costWeeklyPct(284, 'gemini', weeklyValueUsd), 142);
  assert.equal(f.modelWeeklyLabel({ pool: 'claude_gpt', est_cost_usd: 15.5 }, { weeklyValueUsd, t }), '~15.5%');

  // Without official weekly_value_usd: never falls back to 7d token share!
  assert.equal(f.convWeeklyLabel(c, { weeklyValueUsd: null, compact: true, t }), '');
  assert.equal(f.convWeeklyLabel(c, { weeklyValueUsd: null, compact: false, t }), 'weeklyPending');
  assert.equal(f.modelWeeklyLabel({ pool: 'gemini', est_cost_usd: 20, d7_tokens: 9999 }, { weeklyValueUsd: null, compact: true, t }), '');
  assert.equal(f.poolRowLabel(c, 'gemini', { weeklyValueUsd: null, t }), '');
  assert.equal(f.hasAnyWeeklyValue(weeklyValueUsd), true);
  assert.equal(f.hasAnyWeeklyValue({ gemini: null, claude_gpt: 0 }), false);

  // Delta & cycle span formatting helpers for shrinkage detection.
  assert.equal(f.fmtDeltaPct(-18.4), '-18.4%');
  assert.equal(f.fmtDeltaPct(12.0), '+12%');
  assert.equal(f.fmtDeltaPct(142.3), '+142%');
  assert.equal(f.fmtDeltaPct(0), '0%');
  assert.equal(f.deltaLevel(-15), 'crit');
  assert.equal(f.deltaLevel(-3), 'warn');
  assert.equal(f.deltaLevel(5), 'ok');
  assert.equal(f.deltaLevel(0), '');
  assert.match(f.fmtCycleSpan('2026-11-19T12:00:00Z', '2026-11-26T12:00:00Z', 'en'), /.+ – .+/);

  const raw = {
    id: 'm', pool: 'gemini', input: 10, output: 1, calls: 1, est_cost_usd: 1, cost_by_pool: { gemini: 1 },
    total: { input: 30, output: 3, cache_read: 0, thinking: 0, calls: 4, est_cost_usd: 21, subagents: 2, d7_by_pool: {}, cost_by_pool: { gemini: 1, claude_gpt: 20 }, last_at: '2026-06-15T12:00:00+00:00' },
  };
  const v = f.withSubtree(raw);
  assert.equal(v.input, 30);
  assert.equal(v.est_cost_usd, 21);
  assert.equal(v.pool, 'claude_gpt');
  assert.equal(v.self, raw);
  assert.equal(f.withSubtree({ id: 'x', total: { subagents: 0 } }).self, undefined);
});
