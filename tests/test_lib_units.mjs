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
      'period_quota', 'pricing_fetched_at', 'pricing_source', 'quota_calibration', 'scanned_at', 'sources', 'totals', 'weekly_cycles', 'weekly_value_usd',
    ]);
    assert.deepEqual(Object.keys(r.d7_by_pool).sort(), ['claude_gpt', 'gemini', 'other']);
    assert.deepEqual(Object.keys(r.by_conversation[0]).sort(), [
      'agent', 'archived', 'by_model', 'cache_read', 'calls', 'children', 'cost_by_pool', 'cost_estimated', 'cost_partial', 'd7_by_pool', 'd7_tokens',
      'depth', 'display_name', 'est_cost_usd', 'first_at', 'id', 'input', 'is_subagent', 'last_at', 'model',
      'output', 'parent_id', 'pool', 'project_id', 'project_name', 'root_id', 'source', 'thinking', 'title', 'total',
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
    assert.deepEqual(Object.keys(r.by_model[0].periods.all).sort(), [
      'cache_read', 'calls', 'cost_estimated', 'cost_partial', 'est_cost_usd', 'input', 'output', 'thinking',
    ]);
    assert.equal(r.by_model[0].periods.all.input, r.by_model[0].input);
    assert.equal(r.by_model[0].periods.all.est_cost_usd, r.by_model[0].est_cost_usd);
    assert.ok(r.by_model[0].periods.today.est_cost_usd < r.by_model[0].periods.all.est_cost_usd);
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

    // 3. d7_tokens spanning window & CACHE_VERSION === 6
    assert.equal(CACHE_VERSION, 6);
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
  db.exec("CREATE TABLE conversation_summaries (conversation_id text PRIMARY KEY, title text NOT NULL DEFAULT '', preview text NOT NULL DEFAULT '', agent_name text NOT NULL DEFAULT '', parent_conversation_id text NOT NULL DEFAULT '', project_id text NOT NULL DEFAULT '', workspace_uris text NOT NULL DEFAULT '')");
  for (const r of rows) {
    db.prepare('INSERT INTO conversation_summaries (conversation_id, title, agent_name, parent_conversation_id, project_id, workspace_uris) VALUES (?, ?, ?, ?, ?, ?)')
      .run(r.id, r.title || '', r.agent || '', r.parent || '', r.project_id || '', r.workspace_uris || '');
  }
  db.close();
}

test('QuotaCycles: consecutive-reset cycle linking, plateau lock, saturation, offline gap guard, v1->v2 migration & bootstrap', async () => {
  const { loadQuotaCycles, mergeQuotaObservation, normalizeQuotaCycles, QUOTA_CYCLES_VERSION, recordQuotaCycles, WEEK_MS } = await import('../sidecars/agy-lens/lib/quota.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'agy-unit-cycles-'));
  try {
    const cyclesPath = join(dir, 'quota-cycles.json');
    const resetMs = Date.parse('2026-11-28T08:51:10.000Z');
    const resetIso = new Date(resetMs).toISOString();

    // 1. First 7d weekly cycle infers weekly_7d cycle_start when reset - 7d <= first_seen_at,
    // while a >7d first cycle stays cycle_start: null / unknown and uses monotonic delta tracking.
    let ledger = recordQuotaCycles(cyclesPath, {
      plan: 'Pro',
      tier: 'Pro',
      fetched_at: '2026-11-22T06:00:00.000Z',
      weekly: { gemini: { remaining_fraction: 0.6, reset_time: resetIso } },
    });
    assert.equal(ledger.version, QUOTA_CYCLES_VERSION);
    assert.equal(ledger.pools.gemini.length, 1);
    assert.equal(ledger.pools.gemini[0].cycle_start, new Date(resetMs - WEEK_MS).toISOString());
    assert.equal(ledger.pools.gemini[0].cycle_start_source, 'weekly_7d');
    assert.equal(ledger.pools.gemini[0].cycle_duration_ms, WEEK_MS);
    assert.equal(ledger.pools.gemini[0].used_fraction, 0.4);
    assert.equal(ledger.pools.gemini[0].saturated, false);
    assert.equal(ledger.pools.gemini[0].peak_unsaturated.used_fraction, 0.4);
    assert.equal(ledger.pools.gemini[0].observations.length, 1);

    const longFirst = mergeQuotaObservation(normalizeQuotaCycles(null), {
      fetched_at: '2026-11-22T06:00:00.000Z',
      weekly: { gemini: { remaining_fraction: 0.6, reset_time: new Date(Date.parse('2026-11-22T06:00:00.000Z') + 14 * 86400_000).toISOString() } },
    });
    assert.equal(longFirst.ledger.pools.gemini[0].cycle_start, null);
    assert.equal(longFirst.ledger.pools.gemini[0].cycle_start_source, 'unknown');
    assert.equal(longFirst.ledger.pools.gemini[0].cycle_duration_ms, null);

    // Repeating an unchanged fraction keeps the earliest timestamp of that plateau.
    const flatCheck = mergeQuotaObservation(ledger, {
      fetched_at: '2026-11-22T07:00:00.000Z',
      weekly: { gemini: { remaining_fraction: 0.6, reset_time: resetIso } },
    });
    assert.equal(flatCheck.changed, false);
    assert.equal(flatCheck.ledger.pools.gemini[0].observed_at, '2026-11-22T06:00:00.000Z');

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
    assert.equal(ledger.pools.gemini[0].observations.length, 2);

    // Downward jitter or flat repeated reading must not overwrite peak_unsaturated.
    ledger = recordQuotaCycles(cyclesPath, {
      fetched_at: '2026-11-22T09:15:00.000Z',
      weekly: { gemini: { remaining_fraction: 0.2, reset_time: resetIso } },
    });
    assert.equal(ledger.pools.gemini[0].peak_unsaturated.used_fraction, 0.95);
    assert.equal(ledger.pools.gemini[0].peak_unsaturated.observed_at, '2026-11-22T09:00:00.000Z');
    ledger = recordQuotaCycles(cyclesPath, {
      fetched_at: '2026-11-22T09:30:00.000Z',
      weekly: { gemini: { remaining_fraction: 0.05, reset_time: resetIso } },
    });
    assert.equal(ledger.pools.gemini[0].peak_unsaturated.used_fraction, 0.95);
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

    // 4. Next cycle links cycle_start from previous reset_time and measures actual non-7d duration (5d, then 10d).
    const fiveDaysMs = 5 * 86400_000;
    const tenDaysMs = 10 * 86400_000;
    const nextResetIso = new Date(resetMs + fiveDaysMs).toISOString();
    ledger = recordQuotaCycles(cyclesPath, {
      fetched_at: '2026-11-29T10:00:00.000Z',
      weekly: {
        gemini: { remaining_fraction: 0.8, reset_time: nextResetIso },
        claude_gpt: { remaining_fraction: 0.5, reset_time: '2026-11-20T00:00:00.000Z' }, // already expired
      },
    });
    assert.equal(ledger.pools.gemini.length, 2);
    assert.equal(ledger.pools.gemini[0].reset_time, nextResetIso);
    assert.equal(ledger.pools.gemini[0].cycle_start, resetIso);
    assert.equal(ledger.pools.gemini[0].cycle_start_source, 'prev_reset');
    assert.equal(ledger.pools.gemini[0].cycle_duration_ms, fiveDaysMs);
    assert.equal(ledger.pools.gemini[1].reset_time, resetIso);
    assert.equal(ledger.pools.claude_gpt, undefined);

    const thirdResetIso = new Date(resetMs + fiveDaysMs + tenDaysMs).toISOString();
    ledger = recordQuotaCycles(cyclesPath, {
      fetched_at: '2026-12-04T10:00:00.000Z',
      weekly: { gemini: { remaining_fraction: 0.7, reset_time: thirdResetIso } },
    });
    assert.equal(ledger.pools.gemini[0].cycle_start, nextResetIso);
    assert.equal(ledger.pools.gemini[0].cycle_duration_ms, tenDaysMs);

    // Offline multi-cycle gap guard: after a long offline gap (>1.5x cadence), do not link across missed cycles.
    const farResetIso = new Date(Date.parse(thirdResetIso) + 25 * 86400_000).toISOString();
    ledger = recordQuotaCycles(cyclesPath, {
      fetched_at: new Date(Date.parse(thirdResetIso) + 20 * 86400_000).toISOString(),
      weekly: { gemini: { remaining_fraction: 0.9, reset_time: farResetIso } },
    });
    assert.equal(ledger.pools.gemini[0].cycle_start, null);
    assert.equal(ledger.pools.gemini[0].cycle_start_source, 'unknown');

    // Early mid-cycle reset guard: if a new cycle was first seen before previous reset ended, do not link.
    const earlyShift = mergeQuotaObservation({
      version: 2,
      pools: {
        claude_gpt: [{
          cycle_start: null,
          cycle_start_source: 'unknown',
          reset_time: '2026-12-10T00:00:00.000Z',
          first_seen_at: '2026-12-01T00:00:00.000Z',
          observed_at: '2026-12-01T00:00:00.000Z',
          remaining_fraction: 0.5,
        }],
      },
    }, {
      fetched_at: '2026-12-05T00:00:00.000Z',
      weekly: { claude_gpt: { remaining_fraction: 0.9, reset_time: '2026-12-15T00:00:00.000Z' } },
    });
    assert.equal(earlyShift.ledger.pools.claude_gpt[0].cycle_start, null);
    assert.equal(earlyShift.ledger.pools.claude_gpt[0].cycle_start_source, 'unknown');

    // Early-refresh truncation: weekly_7d superseded by a replacement weekly_7d cycle gets ended_at = next.cycle_start
    // and truncated cycle_duration_ms while keeping reset_time intact.
    const earlyTrunc0 = mergeQuotaObservation(normalizeQuotaCycles(null), {
      fetched_at: '2026-11-20T13:44:22.579Z',
      weekly: { gemini: { remaining_fraction: 0.77, reset_time: '2026-11-26T09:48:21.000Z' } },
    });
    const earlyTrunc1 = mergeQuotaObservation(earlyTrunc0.ledger, {
      fetched_at: '2026-11-22T01:15:07.923Z',
      weekly: { gemini: { remaining_fraction: 0.87, reset_time: '2026-11-28T08:51:10.000Z' } },
    });
    assert.equal(earlyTrunc1.ledger.pools.gemini.length, 2);
    assert.equal(earlyTrunc1.ledger.pools.gemini[0].ended_at, null);
    assert.equal(earlyTrunc1.ledger.pools.gemini[0].cycle_duration_ms, WEEK_MS);
    assert.equal(earlyTrunc1.ledger.pools.gemini[1].reset_time, '2026-11-26T09:48:21.000Z');
    assert.equal(earlyTrunc1.ledger.pools.gemini[1].ended_at, '2026-11-21T08:51:10.000Z');
    assert.equal(earlyTrunc1.ledger.pools.gemini[1].cycle_duration_ms, Date.parse('2026-11-21T08:51:10.000Z') - Date.parse('2026-11-19T09:48:21.000Z'));

    // Accepts long cycles > 7d (e.g. 21d), rejects absurdly distant (>90d).
    const ok21d = mergeQuotaObservation(ledger, {
      fetched_at: '2026-11-29T10:00:00.000Z',
      weekly: { custom_21d: { remaining_fraction: 0.9, reset_time: new Date(Date.parse('2026-11-29T10:00:00.000Z') + 21 * 86400_000).toISOString() } },
    });
    assert.equal(ok21d.changed, true);
    const futureCheck = mergeQuotaObservation(ledger, {
      fetched_at: '2026-11-29T10:00:00.000Z',
      weekly: { gemini: { remaining_fraction: 0.9, reset_time: '2027-04-01T10:00:00.000Z' } },
    });
    assert.equal(futureCheck.changed, false);

    // v1 -> v2 migration clears guessed 7d cycle_start on lone cycle, and relinks consecutive cycles.
    const r1Iso = '2026-11-15T00:00:00.000Z';
    const r2Iso = '2026-11-25T00:00:00.000Z';
    const migrated = normalizeQuotaCycles({
      version: 1,
      pools: {
        gemini: [
          {
            cycle_start: new Date(Date.parse(r2Iso) - WEEK_MS).toISOString(),
            reset_time: r2Iso,
            first_seen_at: '2026-11-16T00:00:00.000Z',
            observed_at: '2026-11-20T00:00:00.000Z',
            remaining_fraction: 0.6,
          },
          {
            cycle_start: new Date(Date.parse(r1Iso) - WEEK_MS).toISOString(),
            reset_time: r1Iso,
            first_seen_at: '2026-11-10T00:00:00.000Z',
            observed_at: '2026-11-14T00:00:00.000Z',
            remaining_fraction: 0.2,
          },
        ],
      },
    });
    assert.equal(migrated.version, 2);
    assert.equal(migrated.pools.gemini[1].cycle_start, null);
    assert.equal(migrated.pools.gemini[1].cycle_start_source, 'unknown');
    assert.equal(migrated.pools.gemini[0].cycle_start, r1Iso);
    assert.equal(migrated.pools.gemini[0].cycle_start_source, 'prev_reset');
    assert.equal(migrated.pools.gemini[0].cycle_duration_ms, 10 * 86400_000);

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
    assert.equal(loaded.pools.gemini[0].cycle_start, '2026-11-21T08:51:10.000Z');
    assert.equal(loaded.pools.gemini[0].cycle_start_source, 'weekly_7d');
    assert.equal(loaded.pools.gemini[0].cycle_duration_ms, WEEK_MS);
    assert.equal(loaded.pools.gemini[0].used_fraction, 0.52);
    assert.equal(loaded.pools.gemini[0].plan, 'Pro');
    assert.equal(existsSync(bootCyclesPath), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('WeeklyValuation: exact cycle alignment, delta fallback before 2 resets, non-7d & partial cycles, guards & legacy import', async () => {
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
      version: 2,
      pools: {
        gemini: [
          {
            cycle_start: prevResetIso,
            cycle_start_source: 'prev_reset',
            cycle_duration_ms: 10 * 86400_000,
            reset_time: curResetIso,
            observed_at: curObsIso,
            remaining_fraction: 0.6, // 40% used
            used_fraction: 0.4,
            saturated: false,
          },
          {
            cycle_start: new Date((hTs(14) + 1) * 1000).toISOString(),
            cycle_start_source: 'explicit',
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
    assert.equal(gCycles[0].valuation_method, 'cycle');
    assert.equal(gCycles[0].cycle_duration_ms, 10 * 86400_000);
    assert.equal(gCycles[0].observed_cost_usd, roundN(cCur, 4));
    assert.equal(gCycles[0].cycle_cost_usd, roundN(cCur + cCurPost, 4));
    assert.equal(gCycles[0].weekly_value_usd, curVal);
    assert.equal(gCycles[0].prev_weekly_value_usd, prevVal);
    assert.equal(gCycles[0].change_pct, roundN(((curVal - prevVal) / prevVal) * 100, 1));
    assert.ok(gCycles[0].change_pct < 0); // quota shrank vs prev cycle!
    // Previous cycle also excludes tPrevPost from observed_cost_usd.
    assert.equal(gCycles[1].is_current, false);
    assert.equal(gCycles[1].observed_cost_usd, roundN(cPrev, 4));
    assert.equal(gCycles[1].cycle_cost_usd, roundN(cPrev + cPrevPost, 4));
    assert.equal(gCycles[1].weekly_value_usd, prevVal);
    assert.equal(gCycles[1].change_pct, null);
    assert.equal(r.weekly_value_usd.gemini, curVal);
    assert.equal(r.by_conversation[0].cost_by_pool.gemini, roundN(cPrev + cPrevPost + cCur + cCurPost, 6));

    // Fresh reset (<5% used in current cycle): current value null, pool benchmark falls back to last valid cycle!
    const resetCycles = {
      version: 2,
      pools: {
        gemini: [
          { ...quotaCycles.pools.gemini[0], remaining_fraction: 0.97, used_fraction: 0.03 },
          quotaCycles.pools.gemini[1],
        ],
      },
    };
    const rLow = await scan([[root, 'desktop']], { now: H_NOW, quotaCycles: resetCycles });
    assert.equal(rLow.weekly_cycles.gemini[0].weekly_value_usd, null);
    assert.equal(rLow.weekly_value_usd.gemini, prevVal);

    const floorCycles = {
      version: 2,
      pools: {
        gemini: [
          { ...quotaCycles.pools.gemini[0], remaining_fraction: 0.95, used_fraction: 0.05 },
          quotaCycles.pools.gemini[1],
        ],
      },
    };
    const rFloor = await scan([[root, 'desktop']], { now: H_NOW, quotaCycles: floorCycles });
    assert.equal(rFloor.weekly_cycles.gemini[0].weekly_value_usd, roundN(cCur / 0.05, 2));

    // Saturation guard: saturated cycle evaluates using peak_unsaturated (>=20% prior peak) instead of post-limit AI credit spend!
    const satCycles = {
      version: 2,
      pools: {
        gemini: [{
          cycle_start: prevResetIso,
          cycle_start_source: 'prev_reset',
          reset_time: curResetIso,
          observed_at: new Date((hTs(0) + 1) * 1000).toISOString(), // includes tCurPost AI-credit spend
          remaining_fraction: 0,
          used_fraction: 1,
          saturated: true,
          peak_unsaturated: { observed_at: curObsIso, remaining_fraction: 0.7, used_fraction: 0.3 },
        }],
      },
    };
    const rSat = await scan([[root, 'desktop']], { now: H_NOW, quotaCycles: satCycles });
    assert.equal(rSat.weekly_cycles.gemini[0].eval_used_fraction, 0.3);
    assert.equal(rSat.weekly_cycles.gemini[0].observed_cost_usd, roundN(cCur, 4));
    assert.equal(rSat.weekly_value_usd.gemini, roundN(cCur / 0.3, 2));

    // First-ever cycle with only 1 poll (cycle_start: null): NO fake 7d fallback!
    const singlePollCycles = {
      version: 2,
      pools: {
        gemini: [{
          cycle_start: null,
          cycle_start_source: 'unknown',
          reset_time: curResetIso,
          first_seen_at: curObsIso,
          observed_at: curObsIso,
          remaining_fraction: 0.6,
          used_fraction: 0.4,
          observations: [{ observed_at: curObsIso, remaining_fraction: 0.6, used_fraction: 0.4 }],
        }],
      },
    };
    const rSingle = await scan([[root, 'desktop']], { now: H_NOW, quotaCycles: singlePollCycles });
    assert.equal(rSingle.weekly_cycles.gemini[0].valuation_method, 'delta');
    assert.equal(rSingle.weekly_cycles.gemini[0].eval_used_fraction, 0);
    assert.equal(rSingle.weekly_cycles.gemini[0].weekly_value_usd, null);
    assert.equal(rSingle.weekly_value_usd.gemini, null);

    // First-ever cycle with 2 polls: in-cycle delta valuation excludes pre-sample spend (tCur1) and uses (obs1, obs2].
    const obs1Iso = new Date((hTs(3) + 1) * 1000).toISOString(); // strictly after tCur1 (4d ago)
    const obs2Iso = new Date((hTs(0, 12) + 1) * 1000).toISOString(); // after tCurPost (1d ago)
    const deltaCycles = {
      version: 2,
      pools: {
        gemini: [{
          cycle_start: null,
          cycle_start_source: 'unknown',
          reset_time: curResetIso,
          first_seen_at: obs1Iso,
          observed_at: obs2Iso,
          remaining_fraction: 0.6,
          used_fraction: 0.4,
          observations: [
            { observed_at: obs1Iso, remaining_fraction: 0.9, used_fraction: 0.1 },
            { observed_at: obs2Iso, remaining_fraction: 0.6, used_fraction: 0.4 },
          ],
        }],
      },
    };
    const rDelta = await scan([[root, 'desktop']], { now: H_NOW, quotaCycles: deltaCycles });
    assert.equal(rDelta.weekly_cycles.gemini[0].valuation_method, 'delta');
    assert.equal(rDelta.weekly_cycles.gemini[0].eval_used_fraction, 0.3);
    assert.equal(rDelta.weekly_cycles.gemini[0].observed_cost_usd, roundN(cCurPost, 4));
    assert.equal(rDelta.weekly_value_usd.gemini, roundN(cCurPost / 0.3, 2));

    // When first delta poll started at remaining=1.0 (0% used), calls at the exact sample timestamp ARE included.
    const zeroStartCycles = {
      version: 2,
      pools: {
        gemini: [{
          cycle_start: null,
          cycle_start_source: 'unknown',
          reset_time: curResetIso,
          first_seen_at: new Date(tCur1 * 1000).toISOString(),
          observed_at: curObsIso,
          remaining_fraction: 0.8,
          used_fraction: 0.2,
          observations: [
            { observed_at: new Date(tCur1 * 1000).toISOString(), remaining_fraction: 1.0, used_fraction: 0 },
            { observed_at: curObsIso, remaining_fraction: 0.8, used_fraction: 0.2 },
          ],
        }],
      },
    };
    const rZeroDelta = await scan([[root, 'desktop']], { now: H_NOW, quotaCycles: zeroStartCycles });
    assert.equal(rZeroDelta.weekly_cycles.gemini[0].observed_cost_usd, roundN(cCur, 4));
    assert.equal(rZeroDelta.weekly_value_usd.gemini, roundN(cCur / 0.2, 2));

    // Precision-aware delta thresholds: fine-precision fraction (0.8500 -> 0.8144, 3.56% >= 3%) computes cleanly,
    // tiny/noisy 1% delta (0.85 -> 0.8396, 1.04% < 3%) stays null, coarse 5% (0.85 -> 0.80) passes, 3% coarse stays null.
    const fineDeltaCycles = {
      version: 2,
      pools: {
        gemini: [{
          cycle_start: null,
          cycle_start_source: 'unknown',
          reset_time: curResetIso,
          first_seen_at: obs1Iso,
          observed_at: obs2Iso,
          remaining_fraction: 0.8144,
          used_fraction: 0.1856,
          observations: [
            { observed_at: obs1Iso, remaining_fraction: 0.85, used_fraction: 0.15 },
            { observed_at: obs2Iso, remaining_fraction: 0.8144, used_fraction: 0.1856 },
          ],
        }],
      },
    };
    const rFineDelta = await scan([[root, 'desktop']], { now: H_NOW, quotaCycles: fineDeltaCycles });
    assert.equal(rFineDelta.weekly_cycles.gemini[0].weekly_value_usd, roundN(cCurPost / 0.0356, 2));
    assert.equal(rFineDelta.weekly_value_usd.gemini, roundN(cCurPost / 0.0356, 2));

    const jitterDeltaCycles = {
      version: 2,
      pools: {
        gemini: [{
          cycle_start: null,
          cycle_start_source: 'unknown',
          reset_time: curResetIso,
          first_seen_at: obs1Iso,
          observed_at: obs2Iso,
          remaining_fraction: 0.8396,
          used_fraction: 0.1604,
          observations: [
            { observed_at: obs1Iso, remaining_fraction: 0.85, used_fraction: 0.15 },
            { observed_at: obs2Iso, remaining_fraction: 0.8396, used_fraction: 0.1604 },
          ],
        }],
      },
    };
    const rJitter = await scan([[root, 'desktop']], { now: H_NOW, quotaCycles: jitterDeltaCycles });
    assert.equal(rJitter.weekly_cycles.gemini[0].weekly_value_usd, null);
    assert.equal(rJitter.weekly_value_usd.gemini, null);

    const smallCoarseCycles = {
      version: 2,
      pools: {
        gemini: [{
          cycle_start: null,
          cycle_start_source: 'unknown',
          reset_time: curResetIso,
          first_seen_at: obs1Iso,
          observed_at: obs2Iso,
          remaining_fraction: 0.82,
          used_fraction: 0.18,
          observations: [
            { observed_at: obs1Iso, remaining_fraction: 0.85, used_fraction: 0.15 },
            { observed_at: obs2Iso, remaining_fraction: 0.82, used_fraction: 0.18 },
          ],
        }],
      },
    };
    const rSmallCoarse = await scan([[root, 'desktop']], { now: H_NOW, quotaCycles: smallCoarseCycles });
    assert.equal(rSmallCoarse.weekly_cycles.gemini[0].weekly_value_usd, null);

    const coarseDeltaCycles = {
      version: 2,
      pools: {
        gemini: [{
          cycle_start: null,
          cycle_start_source: 'unknown',
          reset_time: curResetIso,
          first_seen_at: obs1Iso,
          observed_at: obs2Iso,
          remaining_fraction: 0.8,
          used_fraction: 0.2,
          observations: [
            { observed_at: obs1Iso, remaining_fraction: 0.85, used_fraction: 0.15 },
            { observed_at: obs2Iso, remaining_fraction: 0.8, used_fraction: 0.2 },
          ],
        }],
      },
    };
    const rCoarseDelta = await scan([[root, 'desktop']], { now: H_NOW, quotaCycles: coarseDeltaCycles });
    assert.equal(rCoarseDelta.weekly_cycles.gemini[0].weekly_value_usd, roundN(cCurPost / 0.05, 2));
    assert.equal(rCoarseDelta.weekly_value_usd.gemini, roundN(cCurPost / 0.05, 2));

    // Early-refresh superseded cycle (still has future reset_time) must truncate at replacement cycle start (ended_at),
    // never double-counting replacement spend, and strictly keep one is_current per pool;
    // prepareQuotaCycles also coalesces micro-drops (<0.5%) and skips upward rebounds via monotonic high-water anchor.
    const { prepareQuotaCycles } = await import('../sidecars/agy-lens/lib/history.mjs');
    const { renderQuotaHtml } = await import('../sidecars/agy-lens/web/views/quota.js');
    const { fmtCycleSpan } = await import('../sidecars/agy-lens/web/format.js');
    const { createTranslator } = await import('../sidecars/agy-lens/web/i18n.js');
    const earlyReplStart = new Date(hTs(2) * 1000).toISOString();
    const earlyResetCycles = {
      version: 2,
      pools: {
        gemini: [
          {
            cycle_start: earlyReplStart,
            cycle_start_source: 'weekly_7d',
            reset_time: new Date(hTs(-5) * 1000).toISOString(),
            observed_at: obs2Iso,
            remaining_fraction: 0.7,
            used_fraction: 0.3,
          },
          {
            cycle_start: new Date(hTs(5) * 1000).toISOString(),
            cycle_start_source: 'weekly_7d',
            reset_time: new Date(hTs(-2) * 1000).toISOString(),
            observed_at: new Date((hTs(3) + 1) * 1000).toISOString(),
            remaining_fraction: 0.8,
            used_fraction: 0.2,
          },
        ],
      },
    };
    const rEarly = await scan([[root, 'desktop']], { now: H_NOW, quotaCycles: earlyResetCycles });
    assert.equal(rEarly.weekly_cycles.gemini[0].is_current, true);
    assert.equal(rEarly.weekly_cycles.gemini[0].ended_at, null);
    assert.equal(rEarly.weekly_cycles.gemini[1].is_current, false);
    assert.equal(rEarly.weekly_cycles.gemini[1].ended_at, earlyReplStart);
    assert.equal(rEarly.weekly_cycles.gemini[1].cycle_duration_ms, 3 * 86400_000);
    assert.equal(rEarly.weekly_cycles.gemini[1].cycle_cost_usd, roundN(cCur, 4));
    const earlyHtml = renderQuotaHtml({
      data: { plan: 'Pro', fetched_at: new Date().toISOString(), pools: [] },
      historyData: rEarly,
      openKeys: new Set(['weekly-cycles']),
      t: createTranslator('zh'),
      lang: 'zh',
    });
    assert.equal((earlyHtml.match(/class="wtag">当前</g) || []).length, 1);
    assert.ok(earlyHtml.includes(fmtCycleSpan(earlyResetCycles.pools.gemini[1].cycle_start, earlyReplStart, 'zh')));
    assert.ok(!earlyHtml.includes(fmtCycleSpan(earlyResetCycles.pools.gemini[1].cycle_start, earlyResetCycles.pools.gemini[1].reset_time, 'zh')));
    assert.ok(earlyHtml.includes('满额约'));
    assert.ok(!earlyHtml.includes('→') && !earlyHtml.includes('wcycles-note'));

    const prepRebound = prepareQuotaCycles({
      version: 2,
      pools: {
        gemini: [{
          cycle_start: new Date(tCur1 * 1000).toISOString(),
          cycle_start_source: 'explicit',
          reset_time: curResetIso,
          observed_at: new Date((tCur1 + 4000) * 1000).toISOString(),
          remaining_fraction: 0.85,
          used_fraction: 0.15,
          observations: [
            { observed_at: new Date((tCur1 + 1000) * 1000).toISOString(), remaining_fraction: 0.90, used_fraction: 0.10 },
            { observed_at: new Date((tCur1 + 2000) * 1000).toISOString(), remaining_fraction: 0.899, used_fraction: 0.101 },
            { observed_at: new Date((tCur1 + 3000) * 1000).toISOString(), remaining_fraction: 0.902, used_fraction: 0.098 },
            { observed_at: new Date((tCur1 + 4000) * 1000).toISOString(), remaining_fraction: 0.85, used_fraction: 0.15 },
          ],
        }],
      },
    });
    assert.deepEqual(
      prepRebound.get('gemini')[0]._segments.map((s) => s.delta),
      [0.1, 0.05],
    );

    // Completed partial-usage cycle (e.g. ended at 30% used vs 3% used without hitting 100%).
    const partialCompleted = {
      version: 2,
      pools: {
        gemini: [
          {
            cycle_start: new Date((hTs(6)) * 1000).toISOString(),
            cycle_start_source: 'prev_reset',
            cycle_duration_ms: 5 * 86400_000,
            reset_time: new Date((hTs(1)) * 1000).toISOString(),
            observed_at: new Date((hTs(2)) * 1000).toISOString(),
            remaining_fraction: 0.7,
            used_fraction: 0.3,
          },
          {
            cycle_start: new Date((hTs(11)) * 1000).toISOString(),
            cycle_start_source: 'prev_reset',
            cycle_duration_ms: 5 * 86400_000,
            reset_time: new Date((hTs(6)) * 1000).toISOString(),
            observed_at: new Date((hTs(8)) * 1000).toISOString(),
            remaining_fraction: 0.97,
            used_fraction: 0.03,
          },
        ],
      },
    };
    const rPartial = await scan([[root, 'desktop']], { now: H_NOW, quotaCycles: partialCompleted });
    assert.equal(rPartial.weekly_cycles.gemini[0].is_current, false);
    assert.equal(rPartial.weekly_cycles.gemini[0].cycle_duration_ms, 5 * 86400_000);
    assert.equal(rPartial.weekly_cycles.gemini[0].weekly_value_usd, roundN(cCur / 0.3, 2));
    assert.equal(rPartial.weekly_cycles.gemini[1].is_current, false);
    assert.equal(rPartial.weekly_cycles.gemini[1].weekly_value_usd, null);

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
  const { buildConversationTree, findSubagentDbs, findSubagentSources } = await import('../sidecars/agy-lens/lib/history.mjs');
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
    // Window totals count every call once, never per tree level; conversation count reflects top-level trees.
    assert.equal(r.totals.all.input, 1620);
    assert.equal(r.totals.all.conversations, 2);
    // The link survives in the cache once the subagent's database is deleted.
    unlinkSync(join(root, 'grand.db'));
    const ra = await scan([[root, 'desktop']], { now: H_NOW, cachePath });
    const byA = Object.fromEntries(ra.by_conversation.map((c) => [c.id, c]));
    assert.equal(byA.grand.archived, true);
    assert.equal(byA.grand.parent_id, 'sub1');
    assert.equal(byA.main.total.input, 1550);

    // Live session of `main` includes subagent databases still on disk AND archived subagent entries.
    const subs = await findSubagentDbs([[root, 'desktop']], 'main');
    assert.deepEqual(subs.map((p) => p.slice(root.length + 1)).sort(), ['sub1.db', 'sub2.db']);
    const sesLiveOnly = await collectSession(join(root, 'main.db'), { subagentDbPaths: subs });
    assert.equal(sesLiveOnly.input, 1500);
    assert.equal(sesLiveOnly.calls, 3);
    assert.equal(sesLiveOnly.subagents, 2);
    assert.equal(sesLiveOnly.self.input, 1000);
    assert.ok(sesLiveOnly.cost_by_pool.gemini > 0);
    assert.equal((await collectSession(join(root, 'main.db'))).self, undefined);

    const sources = await findSubagentSources([[root, 'desktop']], 'main', cachePath);
    assert.deepEqual(sources.dbPaths.map((p) => p.slice(root.length + 1)).sort(), ['sub1.db', 'sub2.db']);
    assert.equal(sources.archivedEntries.length, 1);
    const ses = await collectSession(join(root, 'main.db'), {
      subagentDbPaths: sources.dbPaths,
      archivedSubagents: sources.archivedEntries,
      enumMap: sources.enums,
    });
    assert.equal(ses.input, 1550);
    assert.equal(ses.calls, 4);
    assert.equal(ses.subagents, 3);
    assert.equal(ses.self.input, 1000);
    assert.equal(ses.est_cost_usd, mainTreeCost);

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

test('MultiPoolWeekly: mixed-pool conversations lead with highest quota-% impact and support dynamic pools', async () => {
  const f = await import('../sidecars/agy-lens/web/format.js');
  const { createTranslator } = await import('../sidecars/agy-lens/web/i18n.js');
  const { meterHtml, renderQuotaHtml } = await import('../sidecars/agy-lens/web/views/quota.js');
  const { renderOverviewHtml } = await import('../sidecars/agy-lens/web/views/overview.js');

  const tZh = createTranslator('zh');
  const tEn = createTranslator('en');
  const weeklyValueUsd = { gemini: 1272.15, claude_gpt: 45.63, claude_opus: 30 };

  // Mixed-pool session: Gemini spent more USD ($103.36 = 8.1%) than Claude ($19.08 = 41.8%).
  const mixed = {
    pool: 'gemini',
    cost_by_pool: { gemini: 103.36, claude_gpt: 19.08, other: 0 },
    est_cost_usd: 122.44,
  };
  assert.equal(f.convWeeklyLabel(mixed, { compact: true, weeklyValueUsd, t: tZh }), '≈ Claude/GPT 周额度 41.8%');
  assert.equal(f.convWeeklyLabel(mixed, { compact: true, weeklyValueUsd, t: tEn }), '≈ 41.8% Claude/GPT weekly');
  assert.equal(f.convWeeklyLabel(mixed, { compact: false, weeklyValueUsd, t: tEn }), 'Claude/GPT 41.8% · Gemini 8.1%');
  assert.deepEqual(f.sortActivePools(mixed, weeklyValueUsd), ['claude_gpt', 'gemini']);

  // Single-pool session retains concise phrasing.
  const single = { pool: 'claude_gpt', cost_by_pool: { gemini: 0, claude_gpt: 19.08 }, est_cost_usd: 19.08 };
  assert.equal(f.convWeeklyLabel(single, { compact: true, weeklyValueUsd, t: tZh }), '≈ 周额度 41.8%');
  assert.equal(f.convWeeklyLabel(single, { compact: true, weeklyValueUsd, t: tEn }), '≈ 41.8% weekly');

  // Dynamic 3rd pool (claude_opus) flows through scan(), quota.js, and overview.js without NaN.
  const dir = mkdtempSync(join(tmpdir(), 'agy-unit-dynpool-'));
  try {
    const root = join(dir, 'conversations');
    mkdirSync(root);
    const catalogPath = join(dir, 'model-catalog.json');
    writeFileSync(catalogPath, JSON.stringify({
      'claude-opus-5-5-medium': { maxTokens: 1000000, displayName: 'Claude Opus 5.5 (Medium)', provider: 'MODEL_PROVIDER_ANTHROPIC', pool: 'claude_opus' },
      'gemini-2.5-pro': { maxTokens: 1048576, displayName: 'Gemini 2.5 Pro', provider: 'MODEL_PROVIDER_GOOGLE', pool: 'gemini' },
    }));
    const tCur = hTs(1);
    makeHistoryDb(join(root, 'mix.db'), [
      hCall(1, { ts: tCur, model: 'claude-opus-5-5-medium', input: 1_000_000, output: 100_000, cache: 0 }),
      hCall(1, { ts: tCur + 60, model: 'gemini-2.5-pro', input: 4_000_000, output: 200_000, cache: 0 }),
    ]);
    const quotaCycles = {
      version: 2,
      pools: {
        claude_opus: [{
          cycle_start: new Date((hTs(4)) * 1000).toISOString(),
          cycle_start_source: 'explicit',
          cycle_duration_ms: 7 * 86400_000,
          reset_time: new Date((hTs(-3)) * 1000).toISOString(),
          observed_at: new Date((tCur + 120) * 1000).toISOString(),
          remaining_fraction: 0.6,
          used_fraction: 0.4,
          saturated: false,
        }],
        gemini: [{
          cycle_start: new Date((hTs(4)) * 1000).toISOString(),
          cycle_start_source: 'explicit',
          cycle_duration_ms: 7 * 86400_000,
          reset_time: new Date((hTs(-3)) * 1000).toISOString(),
          observed_at: new Date((tCur + 120) * 1000).toISOString(),
          remaining_fraction: 0.9,
          used_fraction: 0.1,
          saturated: false,
        }],
      },
    };
    const r = await scan([[root, 'desktop']], { now: H_NOW, modelCatalogPath: catalogPath, quotaCycles });
    assert.equal(Number.isFinite(r.d7_by_pool.claude_opus), true);
    assert.ok(r.d7_by_pool.claude_opus > 0);
    assert.equal(r.weekly_cycles.claude_opus.length, 1);
    assert.ok(r.weekly_value_usd.claude_opus > 0);
    assert.ok(r.by_conversation[0].cost_by_pool.claude_opus > 0);

    const quotaHtml = renderQuotaHtml({
      data: {
        plan: 'Pro',
        fetched_at: new Date().toISOString(),
        weekly: { claude_opus: { remaining_fraction: 0.6, reset_time: quotaCycles.pools.claude_opus[0].reset_time } },
        pools: [{
          id: 'claude_opus',
          category: 'claude_opus',
          limits: [{ kind: 'weekly', remaining_fraction: 0.6, reset_time: quotaCycles.pools.claude_opus[0].reset_time }],
          models: [{ id: 'claude-opus-5-5-medium', display_name: 'Claude Opus 5.5 (Medium)' }],
        }],
      },
      historyData: r,
      openKeys: new Set(['weekly-cycles']),
      t: tEn,
      lang: 'en',
    });
    assert.ok(quotaHtml.includes('Claude Opus models'));
    assert.ok(quotaHtml.includes('Claude Opus'));

    const overviewHtml = renderOverviewHtml({
      model: 'Claude Opus 5.5 (Medium)',
      used_tokens: 10000,
      limit_tokens: 1000000,
      used_pct: 1,
      free_tokens: 990000,
      heading: 'Token usage by category',
      grid_segments: [10000],
      categories: [],
      session: {
        calls: 2,
        input: 5_000_000,
        output: 300_000,
        cache_read: 0,
        est_cost_usd: r.by_conversation[0].est_cost_usd,
        cost_by_pool: r.by_conversation[0].cost_by_pool,
        pool: r.by_conversation[0].pool,
      },
      updatedAt: new Date().toISOString(),
    }, {
      historyData: r,
      openKeys: new Set(),
      t: tEn,
      lang: 'en',
    });
    assert.ok(overviewHtml.includes('Claude Opus'));
    assert.ok(overviewHtml.includes('40%'));
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

test('AccuracyFix: stepUsageTimestamps binds gen_metadata calls by response/message ID across retries', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-unit-idts-'));
  try {
    const dbPath = join(dir, 'retries.db');
    const conn = new DatabaseSync(dbPath);
    conn.exec('CREATE TABLE steps (idx integer PRIMARY KEY, step_type integer, metadata blob)');
    conn.exec('CREATE TABLE gen_metadata (idx integer PRIMARY KEY, data blob)');

    const tDay10 = Math.trunc(hTs(10, 12));
    const tDay0 = Math.trunc(hTs(0, 12));
    // Step 0 has retry usage at day 0 and primary usage at day 10; positional PLANNER_RESPONSE only has day 0!
    const uDay10 = pbMsg(pbField(1, 1530), pbField(2, 1000), pbField(3, 100), pbField(5, 0), pbField(11, 'resp-day10'));
    const uDay0 = pbMsg(pbField(1, 1530), pbField(2, 500), pbField(3, 50), pbField(5, 0), pbField(11, 'resp-day0'));
    conn.prepare('INSERT INTO steps VALUES (0, 15, ?)').run(pbMsg(pbField(1, pbField(1, tDay0)), pbField(9, uDay0)));
    conn.prepare('INSERT INTO steps VALUES (1, 15, ?)').run(pbMsg(pbField(1, pbField(1, tDay10)), pbField(9, uDay10)));

    // Put the day-10 generation at idx 0 (positional stamp would wrongly give it tDay0) and day-0 retry at idx 1.
    conn.prepare('INSERT INTO gen_metadata VALUES (0, ?)').run(
      pbMsg(pbField(1, pbMsg(pbField(4, uDay10), pbField(21, 'Gemini 2.5 Pro'))), pbField(3, pbField(28, 'gemini-2.5-pro'))),
    );
    conn.prepare('INSERT INTO gen_metadata VALUES (1, ?)').run(
      pbMsg(pbField(1, pbMsg(pbField(4, uDay0), pbField(21, 'Gemini 2.5 Pro'))), pbField(3, pbField(28, 'gemini-2.5-pro'))),
    );
    conn.close();

    const r = await scan([[dir, 'desktop']], { now: H_NOW });
    assert.equal(r.totals.today.calls, 1);
    assert.equal(r.totals.today.input, 500);
    assert.equal(r.totals.d7.calls, 1);
    assert.equal(r.totals.d30.calls, 2);
    assert.equal(r.totals.d30.input, 1500);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AccuracyFix: cross-DB compaction enum resolution avoids misbilling under mainModel', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-unit-enum-'));
  try {
    const dbB = join(dir, 'b-gemini.db');
    makeHistoryDb(dbB, [hCall(0, { model: 'gemini-2.5-pro', input: 100, output: 10, cache: 0 })]);
    const cB = new DatabaseSync(dbB);
    const uB = pbMsg(pbField(1, 1530), pbField(2, 100), pbField(3, 10), pbField(5, 0), pbField(11, 'resp-b'));
    cB.prepare('UPDATE gen_metadata SET data = ? WHERE idx = 0').run(
      pbMsg(pbField(1, pbMsg(pbField(4, uB), pbField(21, 'Gemini 2.5 Pro'))), pbField(3, pbField(28, 'gemini-2.5-pro'))),
    );
    cB.close();

    const dbA = join(dir, 'a-claude.db');
    makeHistoryDb(dbA, [hCall(0, { model: 'claude-opus-5-5-medium', input: 1000, output: 100, cache: 0 })]);
    const cA = new DatabaseSync(dbA);
    const uA = pbMsg(pbField(1, 2001), pbField(2, 1000), pbField(3, 100), pbField(5, 0), pbField(11, 'resp-a'));
    cA.prepare('UPDATE gen_metadata SET data = ? WHERE idx = 0').run(
      pbMsg(pbField(1, pbMsg(pbField(4, uA), pbField(21, 'Claude Opus 5.5'))), pbField(3, pbField(28, 'claude-opus-5-5-medium'))),
    );
    const ts = Math.trunc(hTs(0, 11));
    // Compaction step using enum 1530 (only defined in dbB) and another with unseen enum 9999.
    const uCompact = pbMsg(pbField(1, 1530), pbField(2, 4000), pbField(3, 400), pbField(5, 0), pbField(11, 'resp-comp-1530'));
    const uUnknown = pbMsg(pbField(1, 9999), pbField(2, 200), pbField(3, 20), pbField(5, 0), pbField(11, 'resp-comp-9999'));
    cA.prepare('INSERT INTO steps (idx, step_type, metadata) VALUES (100, 23, ?)').run(pbMsg(pbField(1, pbField(1, ts)), pbField(9, uCompact)));
    cA.prepare('INSERT INTO steps (idx, step_type, metadata) VALUES (101, 23, ?)').run(pbMsg(pbField(1, pbField(1, ts)), pbField(9, uUnknown)));
    cA.close();

    const cachePath = join(dir, 'cache.json');
    const r = await scan([[dir, 'desktop']], { now: H_NOW, cachePath });
    const bm = Object.fromEntries(r.by_model.map((m) => [m.model, m]));
    assert.equal(bm['gemini-2.5-pro'].input, 4100);
    assert.equal(bm['gemini-2.5-pro'].pool, 'gemini');
    assert.equal(bm['claude-opus-5-5-medium'].input, 1000);
    assert.equal(bm.unknown.input, 200);
    assert.equal(bm.unknown.est_cost_usd, null);
    const convA = r.by_conversation.find((c) => c.id === 'a-claude');
    assert.equal(convA.cost_partial, true);
    assert.equal(JSON.parse(readFileSync(cachePath, 'utf8')).enums['1530'], 'gemini-2.5-pro');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Updater: semver comparisons, release parsers, URL sanitization, fallback & 6h cache', async () => {
  const {
    checkForUpdate,
    compareSemver,
    GITHUB_LATEST_RELEASE_URL,
    GITHUB_MANIFEST_FALLBACK_URL,
    GITHUB_RELEASES_PAGE,
    parseGithubRelease,
    parseManifestRelease,
    readUpdateMeta,
  } = await import('../sidecars/agy-lens/lib/updater.mjs');
  const { fmtCycleDuration, fmtCycleSpan } = await import('../sidecars/agy-lens/web/format.js');
  const { meterHtml, quotaColor, renderQuotaHtml } = await import('../sidecars/agy-lens/web/views/quota.js');
  const { createTranslator } = await import('../sidecars/agy-lens/web/i18n.js');

  assert.equal(compareSemver('2.3.0', '2.2.0'), 1);
  assert.equal(compareSemver('2.10.0', '2.2.0'), 1);
  assert.equal(compareSemver('v2.2.0', '2.2.0'), 0);
  assert.equal(compareSemver('2.3.0', '2.3.0-beta.1'), 1);
  assert.equal(compareSemver('2.3.0-beta.2', '2.3.0-beta.1'), 1);
  assert.equal(compareSemver('2.1.9', '2.2.0'), -1);
  assert.equal(compareSemver('bad', '2.2.0'), 0);

  assert.equal(parseGithubRelease({ tag_name: 'v2.3.0', draft: true }), null);
  assert.equal(parseGithubRelease({ tag_name: 'v2.3.0-rc.1', prerelease: true }), null);
  const rel = parseGithubRelease({
    tag_name: 'v2.3.0',
    html_url: 'https://evil.example.com/phish',
    published_at: '2026-11-23T00:00:00Z',
    body: '## Highlights\n- Dynamic cycles & update checker',
  });
  assert.equal(rel.latest_version, '2.3.0');
  assert.equal(rel.release_url, GITHUB_RELEASES_PAGE);
  assert.equal(rel.notes_summary, 'Highlights');

  const mf = parseManifestRelease({ version: '2.4.0' });
  assert.equal(mf.latest_version, '2.4.0');
  assert.equal(mf.release_url, 'https://github.com/Aoike123/agy-lens/releases/tag/v2.4.0');

  // Quota format helpers for null cycle_start and measured duration + completed low-usage cycle.
  assert.equal(fmtCycleSpan(null, '2026-11-28T00:00:00Z', 'en').startsWith('→ '), true);
  assert.equal(fmtCycleSpan(null, '2026-11-28T00:00:00Z', 'zh').startsWith('至 '), true);
  assert.equal(fmtCycleDuration(5 * 86400_000, 'en'), '5d');
  assert.equal(fmtCycleDuration(5 * 86400_000, 'zh'), '5天');
  assert.equal(fmtCycleDuration(12 * 3600_000, 'en'), '12h');
  const qHtml = renderQuotaHtml({
    data: { plan: 'Pro', fetched_at: '2026-11-22T00:00:00Z', pools: [] },
    historyData: {
      weekly_cycles: {
        gemini: [{
          cycle_start: null,
          reset_time: '2026-11-20T00:00:00Z',
          observed_at: '2026-11-19T00:00:00Z',
          used_fraction: 0.03,
          remaining_fraction: 0.97,
          is_current: false,
          observed_cost_usd: 0.5,
          weekly_value_usd: null,
        }],
      },
      weekly_value_usd: {},
    },
    openKeys: new Set(['weekly-cycles']),
    t: createTranslator('en'),
    lang: 'en',
  });
  assert.ok(qHtml.includes('<section class="wcycles"'));
  assert.ok(!qHtml.includes('<details class="wcycles"'));
  assert.ok(qHtml.includes('<div class="pool-label">Cycle valuations</div>'));
  assert.ok(qHtml.includes('data-qperiod="month" aria-selected="true"'));
  assert.ok(qHtml.includes('data-qperiod="m3"') && qHtml.includes('data-qperiod="all"'));
  assert.ok(!qHtml.includes('data-qperiod="d30"') && !qHtml.includes('data-qperiod="d7"'));
  assert.ok(qHtml.includes('<div class="wcy-pool"'));
  assert.ok(qHtml.includes('<div class="cy-chart">'));
  const qGridHtml = qHtml.split('<div class="heat-foot">')[0];
  assert.ok(qGridHtml.includes('style="--cols:10;--rows:3"'));
  assert.ok(qGridHtml.indexOf('<div class="cy-x"') >= 0 && qGridHtml.indexOf('<div class="cy-x"') < qGridHtml.indexOf('<div class="cy-cols"'));
  assert.equal((qGridHtml.match(/<div class="cbar\b/g) || []).length, 10);
  assert.equal((qGridHtml.match(/<div class="cbar ghost"/g) || []).length, 9);
  assert.equal((qGridHtml.match(/<div class="cbar unvalued"/g) || []).length, 1);
  assert.equal((qGridHtml.match(/<span class="cell l0"/g) || []).length, 10 * 3);
  assert.ok(!/class="cell l[1-4](?:\s|")/.test(qGridHtml));
  assert.ok(!qGridHtml.includes('diff-shrink') && !qGridHtml.includes('diff-grow'));
  assert.ok(qHtml.includes('Low usage'));
  assert.ok(qHtml.includes('Spent $0.50'));
  assert.ok(qHtml.includes('1 reset this month'));
  assert.ok(qHtml.includes('Shrunk vs now') && qHtml.includes('Grown vs now'));
  assert.ok(!qHtml.includes('wcycles-note'));
  assert.ok(!qHtml.includes('(Δ'));

  const multiPoolHistory = {
    weekly_cycles: {
      gemini: [
        {
          cycle_start: '2026-11-21T08:51:10Z',
          reset_time: '2026-11-28T08:51:10Z',
          cycle_duration_ms: 7 * 86400_000,
          is_current: true,
          used_fraction: 0.61,
          remaining_fraction: 0.39,
          cycle_cost_usd: 826.23,
          weekly_value_usd: 1363.87,
          prev_weekly_value_usd: 2043.21,
          change_pct: -33.2,
        },
        {
          cycle_start: '2026-11-19T09:30:00Z',
          ended_at: '2026-11-21T08:51:10Z',
          reset_time: '2026-11-26T09:30:00Z',
          cycle_duration_ms: 47 * 3600_000,
          is_current: false,
          used_fraction: 0.23,
          remaining_fraction: 0.77,
          cycle_cost_usd: 469.89,
          weekly_value_usd: 2043.21,
        },
      ],
      claude_gpt: [
        {
          cycle_start: '2026-11-19T13:06:00Z',
          reset_time: '2026-11-26T13:06:00Z',
          cycle_duration_ms: 7 * 86400_000,
          is_current: true,
          used_fraction: 0.993,
          remaining_fraction: 0.007,
          cycle_cost_usd: 45.32,
          weekly_value_usd: 45.63,
        },
      ],
    },
    weekly_value_usd: { gemini: 1363.87, claude_gpt: 45.63 },
  };
  const multiZh = renderQuotaHtml({
    data: {
      plan: 'Google AI Ultra',
      fetched_at: '2026-11-23T08:22:00Z',
      pools: [
        { id: '3p', category: 'claude_gpt', limits: [] },
        { id: 'tab', category: 'tab', limits: [{ kind: 'none', remaining_fraction: 1, reset_time: null }] },
        { id: 'gem', category: 'gemini', limits: [{ kind: 'weekly', remaining_fraction: 0.39, reset_time: '2026-11-28T08:51:10Z' }] },
      ],
    },
    historyData: multiPoolHistory,
    openKeys: new Set(),
    t: createTranslator('zh'),
    lang: 'zh',
  });
  assert.ok(multiZh.includes('本周期已花 $826.23'));
  assert.ok(!multiZh.replace(/\s+title="[^"]*"/g, '').includes('· 7天'));
  const wcyStart = multiZh.indexOf('<section class="wcycles"');
  const wcyEnd = multiZh.indexOf('</section>', wcyStart);
  assert.ok(wcyStart >= 0 && wcyEnd > wcyStart);
  assert.ok(multiZh.indexOf('Claude / GPT-OSS 模型') < wcyStart);
  assert.ok(multiZh.indexOf('Gemini 模型') < wcyStart);
  assert.match(multiZh, /<div class="pool pool-free">\s*<div class="pool-label">Tab 补全<\/div>/);
  assert.ok(multiZh.indexOf('Tab 补全') > wcyEnd);
  assert.equal((multiZh.match(/<div class="wcy-pool"/g) || []).length, 2);
  assert.ok(!multiZh.includes('$1,409.50'));
  assert.ok(multiZh.includes('--heat-c:var(--c-tool)') && multiZh.includes('--heat-c:var(--c-agent)'));
  const wcySecZh = multiZh.slice(wcyStart, wcyEnd);
  assert.ok(wcySecZh.includes('>本月<') && wcySecZh.includes('>三个月<') && wcySecZh.includes('>全部<'));
  assert.ok(wcySecZh.indexOf('Claude / GPT') < wcySecZh.indexOf('Gemini'));
  assert.ok(wcySecZh.includes('峰值 $2,043.21'));
  assert.ok(wcySecZh.includes('$2k') && wcySecZh.includes('$1k'));
  assert.ok(wcySecZh.includes('较当前缩水') && wcySecZh.includes('较当前增长'));
  assert.ok(wcySecZh.includes('<div class="cy-chart">'));
  const [claudePoolHtml, geminiPoolHtml] = wcySecZh.split('<div class="wcy-pool"').slice(1);
  assert.ok(claudePoolHtml.includes('峰值 $45.63') && claudePoolHtml.includes('<span class="wcy-cur">$45.63</span>'));
  assert.ok(claudePoolHtml.includes('本月刷新 1 次') && !claudePoolHtml.includes('提前'));
  const claudeGridHtml = claudePoolHtml.split('<div class="heat-foot">')[0];
  assert.ok(claudeGridHtml.includes('style="--cols:10;--rows:3"'));
  assert.equal((claudeGridHtml.match(/<div class="cbar\b/g) || []).length, 10);
  assert.equal((claudeGridHtml.match(/<div class="cbar ghost"/g) || []).length, 9);
  assert.equal((claudeGridHtml.match(/class="cell l4"/g) || []).length, 3);
  assert.ok(!claudeGridHtml.includes('diff-shrink') && !claudeGridHtml.includes('diff-grow'));
  assert.ok(geminiPoolHtml.includes('<span class="wcy-cur">$1,363.87</span>'));
  assert.ok(geminiPoolHtml.includes('-33.2%'));
  assert.ok(geminiPoolHtml.includes('本月刷新 2 次 · 提前 1 次'));
  assert.ok(geminiPoolHtml.includes('累计满额估值 $3,407.08'));
  assert.ok(geminiPoolHtml.includes('提前刷新'));
  const geminiGridHtml = geminiPoolHtml.split('<div class="heat-foot">')[0];
  assert.ok(geminiGridHtml.includes('style="--cols:10;--rows:3"'));
  assert.ok(geminiGridHtml.indexOf('<div class="cy-x"') < geminiGridHtml.indexOf('<div class="cy-cols"'));
  const geminiXAxisHtml = geminiGridHtml.split('<div class="cy-y"')[0];
  assert.ok(geminiXAxisHtml.includes('>11/19<') && geminiXAxisHtml.includes('>11/21<'));
  const gemBars = geminiGridHtml.split(/<div class="cbar\b/).slice(1);
  assert.equal(gemBars.length, 10);
  assert.equal(gemBars.slice(0, 8).filter((b) => b.startsWith(' ghost"')).length, 8);
  assert.equal((gemBars[8].match(/class="cell l4"/g) || []).length, 2); // older peak $2,043.21 within current baseline (2/3)
  assert.equal((gemBars[8].match(/class="cell l4 diff-shrink"/g) || []).length, 1); // shrunk cap above current
  assert.equal((gemBars[8].match(/diff-grow/g) || []).length, 0);
  assert.ok(gemBars[9].startsWith(' cur"'));
  assert.equal((gemBars[9].match(/class="cell l3"/g) || []).length, 2); // current $1,363.87 -> 2/3 rows
  assert.equal((gemBars[9].match(/class="cell l0"/g) || []).length, 1);
  assert.ok(!gemBars[9].includes('diff-shrink') && !gemBars[9].includes('diff-grow'));
  const multiVisible = wcySecZh.replace(/\s+title="[^"]*"/g, '');
  assert.ok(!multiVisible.includes('本周期已花') && !multiVisible.includes('已花 ') && !multiVisible.includes('已用'));

  const multiEn = renderQuotaHtml({
    data: {
      plan: 'Google AI Ultra',
      fetched_at: '2026-11-23T08:22:00Z',
      pools: [{ id: 'gem', category: 'gemini', limits: [{ kind: 'weekly', remaining_fraction: 0.39, reset_time: '2026-11-28T08:51:10Z' }] }],
    },
    historyData: multiPoolHistory,
    openKeys: new Set(),
    t: createTranslator('en'),
    lang: 'en',
  });
  assert.ok(multiEn.includes('Spent $826.23') && !multiEn.replace(/\s+title="[^"]*"/g, '').includes('· 7d'));
  assert.ok(multiEn.includes('Peak $2,043.21') && multiEn.includes('<span class="wcy-cur">$1,363.87</span>'));
  assert.ok(multiEn.includes('2 resets this month · 1 early'));
  assert.ok(multiEn.includes('Total full value $3,407.08'));
  assert.ok(multiEn.includes('Early reset'));
  assert.ok(multiEn.includes('Full ≈ $2,043.21') && multiEn.includes('Full ≈ $1,363.87'));
  assert.ok(multiEn.includes('Shrunk vs now') && multiEn.includes('Grown vs now'));
  assert.ok(multiEn.includes('>This month<') && multiEn.includes('>3 months<') && multiEn.includes('>All<'));
  assert.ok(multiEn.includes('data-qperiod="month"') && multiEn.includes('data-qperiod="m3"') && multiEn.includes('data-qperiod="all"'));

  // 3-month & All-time refresh-cycle bar charts (9 cycles $400..$2000): steady height with m3 (14 cols) and all (24 cols).
  const scrollCycles = Array.from({ length: 9 }, (_, idx) => {
    const endMs = Date.UTC(2026, 10, 28 - idx * 7);
    const startMs = endMs - 7 * 86400_000;
    const val = 400 + ((8 - idx) * 200);
    return {
      cycle_start: new Date(startMs).toISOString(),
      ended_at: idx === 0 ? null : new Date(endMs).toISOString(),
      reset_time: new Date(endMs).toISOString(),
      cycle_duration_ms: 7 * 86400_000,
      is_current: idx === 0,
      used_fraction: 0.5,
      remaining_fraction: 0.5,
      cycle_cost_usd: val * 0.5,
      weekly_value_usd: val,
    };
  });
  const m3Zh = renderQuotaHtml({
    data: { plan: 'Google AI Ultra', fetched_at: '2026-11-23T08:22:00Z', pools: [] },
    historyData: { weekly_cycles: { gemini: scrollCycles }, weekly_value_usd: { gemini: 2000 } },
    openKeys: new Set(),
    cyclePeriod: 'm3',
    t: createTranslator('zh'),
    lang: 'zh',
  });
  assert.ok(m3Zh.includes('data-qperiod="m3" aria-selected="true"'));
  const m3GridHtml = m3Zh.split('<div class="heat-foot">')[0];
  assert.ok(m3GridHtml.includes('<div class="cy-x m3"') && m3GridHtml.includes('<div class="cy-cols m3"'));
  assert.ok(m3GridHtml.includes('style="--cols:14;--rows:4"'));
  assert.ok(m3GridHtml.indexOf('<div class="cy-x m3"') < m3GridHtml.indexOf('<div class="cy-cols m3"'));
  const m3Bars = m3GridHtml.split(/<div class="cbar\b/).slice(1);
  assert.equal(m3Bars.length, 14);
  assert.equal(m3Bars.slice(0, 5).filter((b) => b.startsWith(' ghost"')).length, 5);
  assert.equal((m3Bars[5].match(/class="cell l1"/g) || []).length, 1); // $400 -> 1/4 rows
  assert.equal((m3Bars[5].match(/class="cell diff-grow"/g) || []).length, 3); // lower than current $2000 -> 3 grow cells
  assert.equal((m3Bars[5].match(/class="cell l0"/g) || []).length, 0);
  assert.equal((m3Bars[13].match(/class="cell l4"/g) || []).length, 4); // $2000 -> 4/4 rows
  assert.ok(m3Bars[13].startsWith(' cur"'));
  assert.ok(!m3Bars[13].includes('diff-grow') && !m3Bars[13].includes('diff-shrink'));
  assert.ok(m3Zh.includes('近 3 个月刷新 9 次') && !m3Zh.includes('提前'));

  const scrollZh = renderQuotaHtml({
    data: { plan: 'Google AI Ultra', fetched_at: '2026-11-23T08:22:00Z', pools: [] },
    historyData: { weekly_cycles: { gemini: scrollCycles }, weekly_value_usd: { gemini: 2000 } },
    openKeys: new Set(),
    cyclePeriod: 'all',
    t: createTranslator('zh'),
    lang: 'zh',
  });
  assert.ok(scrollZh.includes('data-qperiod="all" aria-selected="true"'));
  const scrollGridHtml = scrollZh.split('<div class="heat-foot">')[0];
  assert.ok(scrollGridHtml.includes('<div class="cy-x all"') && scrollGridHtml.includes('<div class="cy-cols all"'));
  assert.ok(scrollGridHtml.includes('style="--cols:24;--rows:7"'));
  const scrollBars = scrollGridHtml.split(/<div class="cbar\b/).slice(1);
  assert.equal(scrollBars.length, 24);
  assert.equal(scrollBars.slice(0, 15).filter((b) => b.startsWith(' ghost"')).length, 15);
  assert.equal((scrollBars[15].match(/class="cell l1"/g) || []).length, 1); // $400 -> 1/7 rows
  assert.equal((scrollBars[15].match(/class="cell diff-grow"/g) || []).length, 6); // 6 grow cells up to $2000
  assert.equal((scrollBars[15].match(/class="cell l0"/g) || []).length, 0);
  assert.equal((scrollBars[23].match(/class="cell l4"/g) || []).length, 7); // $2000 -> 7/7 rows
  assert.ok(scrollBars[23].startsWith(' cur"'));
  for (const lvl of ['l1', 'l2', 'l3', 'l4']) {
    assert.ok(new RegExp(`class="cell ${lvl}(?:\\s|")`).test(scrollGridHtml), `missing level ${lvl}`);
  }
  assert.ok(scrollZh.includes('累计刷新 9 次') && !scrollZh.includes('提前'));

  // Edge cases: unvalued historical cycle is never painted green; unvalued current cycle falls back to plain depth without diff colors.
  const edgeHistUnvaluedPast = renderQuotaHtml({
    data: { plan: 'Google AI Ultra', fetched_at: '2026-11-23T08:22:00Z', pools: [] },
    historyData: {
      weekly_cycles: {
        gemini: [
          { cycle_start: '2026-11-21T00:00:00Z', is_current: true, weekly_value_usd: 1000 },
          { cycle_start: '2026-11-14T00:00:00Z', is_current: false, weekly_value_usd: null },
        ],
      },
    },
    openKeys: new Set(),
    t: createTranslator('zh'),
    lang: 'zh',
  });
  const unvalPastBars = edgeHistUnvaluedPast.split('<div class="heat-foot">')[0].split(/<div class="cbar\b/).slice(1);
  assert.ok(unvalPastBars[8].startsWith(' unvalued"'));
  assert.equal((unvalPastBars[8].match(/diff-grow|diff-shrink/g) || []).length, 0);

  const edgeHistUnvaluedCur = renderQuotaHtml({
    data: { plan: 'Google AI Ultra', fetched_at: '2026-11-23T08:22:00Z', pools: [] },
    historyData: {
      weekly_cycles: {
        gemini: [
          { cycle_start: '2026-11-21T00:00:00Z', is_current: true, weekly_value_usd: null },
          { cycle_start: '2026-11-14T00:00:00Z', is_current: false, weekly_value_usd: 2000 },
        ],
      },
    },
    openKeys: new Set(),
    t: createTranslator('zh'),
    lang: 'zh',
  });
  const unvalCurBars = edgeHistUnvaluedCur.split('<div class="heat-foot">')[0].split(/<div class="cbar\b/).slice(1);
  assert.ok(edgeHistUnvaluedCur.includes('估算中'));
  assert.equal((unvalCurBars[8].match(/class="cell l4"/g) || []).length, 3);
  assert.equal((unvalCurBars[8].match(/diff-grow|diff-shrink/g) || []).length, 0);

  // When current cycle is newly reset and estimating, fallback diff baseline uses the most recent valued cycle (11/21).
  const edgeHistFallbackRef = renderQuotaHtml({
    data: { plan: 'Google AI Ultra', fetched_at: '2026-11-24T01:10:00Z', pools: [] },
    historyData: {
      weekly_cycles: {
        gemini: [
          { cycle_start: '2026-11-24T00:10:00Z', is_current: true, weekly_value_usd: null },
          { cycle_start: '2026-11-21T08:51:10Z', ended_at: '2026-11-24T00:10:00Z', is_current: false, weekly_value_usd: 1363.87 },
          { cycle_start: '2026-11-19T09:30:00Z', ended_at: '2026-11-21T08:51:10Z', is_current: false, weekly_value_usd: 2043.21 },
          { cycle_start: '2026-11-12T09:30:00Z', ended_at: '2026-11-19T09:30:00Z', is_current: false, weekly_value_usd: 600 },
        ],
      },
    },
    openKeys: new Set(),
    t: createTranslator('zh'),
    lang: 'zh',
  });
  assert.ok(edgeHistFallbackRef.includes('<span class="wtag">当前</span><span>估算中</span>'));
  const fbBars = edgeHistFallbackRef.split('<div class="heat-foot">')[0].split(/<div class="cbar\b/).slice(1);
  assert.equal(fbBars.length, 10);
  assert.equal((fbBars[6].match(/class="cell l1"/g) || []).length, 1); // 11/12 $600 -> 1/3 rows
  assert.equal((fbBars[6].match(/class="cell diff-grow"/g) || []).length, 1); // vs 11/21 $1363.87 (2/3 rows)
  assert.equal((fbBars[6].match(/class="cell l0"/g) || []).length, 1);
  assert.equal((fbBars[7].match(/class="cell l4"/g) || []).length, 2); // 11/19 $2043.21 -> 2 base rows
  assert.equal((fbBars[7].match(/class="cell l4 diff-shrink"/g) || []).length, 1); // +1 red shrink row vs 11/21
  assert.equal((fbBars[8].match(/class="cell l3"/g) || []).length, 2); // 11/21 temp baseline -> 2/3 rows
  assert.equal((fbBars[8].match(/class="cell l0"/g) || []).length, 1);
  assert.equal((fbBars[8].match(/diff-grow|diff-shrink/g) || []).length, 0);
  assert.ok(fbBars[9].startsWith(' cur unvalued"'));
  assert.equal((fbBars[9].match(/class="cell l0"/g) || []).length, 3);
  assert.equal((fbBars[9].match(/diff-grow|diff-shrink/g) || []).length, 0);
  const parseHex = (h) => [
    parseInt(h.slice(1, 3), 16),
    parseInt(h.slice(3, 5), 16),
    parseInt(h.slice(5, 7), 16),
  ];
  const cFull = quotaColor(1);
  const cHigh = quotaColor(0.88);
  const cMid = quotaColor(0.41);
  const cCrit = quotaColor(0.007);
  for (const hex of [cFull, cHigh, cMid, cCrit]) assert.match(hex, /^#[0-9a-f]{6}$/);
  const [r1, g1, b1] = parseHex(cFull);
  const [r2, g2, b2] = parseHex(cHigh);
  assert.ok(g1 > r1 && g1 > b1);
  assert.ok(g2 > r2 && g2 > b2);
  assert.ok(Math.max(Math.abs(r1 - r2), Math.abs(g1 - g2), Math.abs(b1 - b2)) <= 12);
  const [rm, gm, bm] = parseHex(cMid);
  assert.ok(rm > gm && gm > bm);
  const [rc, gc, bc] = parseHex(cCrit);
  assert.ok(rc > gc && rc > bc && (rc - gc) >= 100);
  const meterCrit = meterHtml(0.007, 'Weekly');
  assert.equal((meterCrit.match(/class="on"/g) || []).length, 1);
  assert.ok(meterCrit.includes('style="--mc:'));
  assert.ok(!meterCrit.includes('<i class="on" style='));
  assert.equal((meterHtml(0, 'Weekly').match(/class="on"/g) || []).length, 0);
  assert.equal((meterHtml(1, 'Weekly').match(/class="on"/g) || []).length, 20);
  const stylesCss = readFileSync(new URL('../sidecars/agy-lens/web/styles.css', import.meta.url), 'utf8');
  assert.ok(stylesCss.includes('var(--mc'));

  const dir = mkdtempSync(join(tmpdir(), 'agy-unit-upd-'));
  const prevNoUpd = process.env.AGY_LENS_NO_UPDATE_CHECK;
  try {
    delete process.env.AGY_LENS_NO_UPDATE_CHECK;
    const cachePath = join(dir, 'update-cache.json');
    const now0 = Date.parse('2026-11-23T06:00:00Z');
    let hits = 0;

    // 1. Fetches release API and caches result.
    const r1 = await checkForUpdate({
      updateCachePath: cachePath,
      currentVersion: '2.2.0',
      now: now0,
      fetchJson: async (url) => {
        hits += 1;
        assert.equal(url, GITHUB_LATEST_RELEASE_URL);
        return {
          tag_name: 'v2.3.0',
          html_url: 'https://github.com/Aoike123/agy-lens/releases/tag/v2.3.0',
          published_at: '2026-11-23T05:00:00Z',
        };
      },
    });
    assert.equal(hits, 1);
    assert.equal(r1.update_available, true);
    assert.equal(r1.latest_version, '2.3.0');
    assert.equal(r1.stale, false);

    // 2. Cache hit skips network within 6h TTL.
    const r2 = await checkForUpdate({
      updateCachePath: cachePath,
      currentVersion: '2.2.0',
      now: now0 + 3600_000,
      fetchJson: async () => { throw new Error('should not fetch'); },
    });
    assert.equal(r2.update_available, true);
    assert.equal(r2.latest_version, '2.3.0');

    // 3. Local upgrade flips update_available to false without waiting on TTL.
    assert.equal(readUpdateMeta(cachePath, '2.3.0', now0 + 3600_000).update_available, false);

    // 4. Primary API failure falls back to raw plugin.json.
    const seenUrls = [];
    const r3 = await checkForUpdate({
      updateCachePath: cachePath,
      currentVersion: '2.2.0',
      force: true,
      now: now0 + 7200_000,
      fetchJson: async (url) => {
        seenUrls.push(url);
        if (url === GITHUB_LATEST_RELEASE_URL) throw new Error('HTTP 403');
        return { version: '2.4.0' };
      },
    });
    assert.deepEqual(seenUrls, [GITHUB_LATEST_RELEASE_URL, GITHUB_MANIFEST_FALLBACK_URL]);
    assert.equal(r3.latest_version, '2.4.0');
    assert.equal(r3.source, 'github_manifest');

    // 5. Offline failure returns cached state + error without throwing.
    const rErr = await checkForUpdate({
      updateCachePath: cachePath,
      currentVersion: '2.2.0',
      force: true,
      now: now0 + 7300_000,
      fetchJson: async () => { throw new Error('offline'); },
    });
    assert.equal(rErr.error, 'failed');
    assert.equal(rErr.latest_version, '2.4.0');

    // 6. AGY_LENS_NO_UPDATE_CHECK=1 disables network fetches.
    process.env.AGY_LENS_NO_UPDATE_CHECK = '1';
    const rDis = await checkForUpdate({
      updateCachePath: cachePath,
      currentVersion: '2.2.0',
      force: true,
      fetchJson: async () => { throw new Error('should not fetch when disabled'); },
    });
    assert.equal(rDis.disabled, true);
  } finally {
    if (prevNoUpd === undefined) delete process.env.AGY_LENS_NO_UPDATE_CHECK;
    else process.env.AGY_LENS_NO_UPDATE_CHECK = prevNoUpd;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SelfUpdater: URL allowlist, SHA-256 sums, PKZIP safety, install modes & atomic rollback', async () => {
  const { createHash } = await import('node:crypto');
  const {
    detectInstallMode,
    extractZipEntries,
    GITHUB_DOWNLOAD_BASE,
    installReleaseUpdate,
    isAllowedUpdateUrl,
    parseGithubRelease,
    parseSha256Sums,
    readCurrentVersion,
  } = await import('../sidecars/agy-lens/lib/updater.mjs');
  const { buildZipBuffer } = await import('../scripts/build-release.mjs');

  // 1. summarizeNotes skips leading markdown image banner lines
  const relImg = parseGithubRelease({
    tag_name: 'v2.3.1',
    name: 'v2.3.1',
    body: '![Agy Lens](https://raw.githubusercontent.com/Aoike123/agy-lens/main/docs/img/hero.png)\n\n## Highlights\n- In-panel update',
  });
  assert.equal(relImg.notes_summary, 'Highlights');

  // 2. HTTPS + GitHub repo allowlist
  assert.equal(isAllowedUpdateUrl('https://github.com/Aoike123/agy-lens/releases/download/v2.3.1/agy-lens-v2.3.1.zip'), true);
  assert.equal(isAllowedUpdateUrl('https://api.github.com/repos/Aoike123/agy-lens/releases/latest'), true);
  assert.equal(isAllowedUpdateUrl('https://raw.githubusercontent.com/Aoike123/agy-lens/main/plugin.json'), true);
  assert.equal(isAllowedUpdateUrl('https://objects.githubusercontent.com/github-production-release-asset/123'), true);
  assert.equal(isAllowedUpdateUrl('http://github.com/Aoike123/agy-lens/releases/download/v2.3.1/agy-lens.zip'), false);
  assert.equal(isAllowedUpdateUrl('https://evil.example.com/agy-lens-v2.3.1.zip'), false);
  assert.equal(isAllowedUpdateUrl('https://github.com/OtherOwner/agy-lens/releases/latest'), false);
  assert.equal(isAllowedUpdateUrl('https://raw.githubusercontent.com/OtherOwner/repo/main/plugin.json'), false);

  // 3. SHA256SUMS parser
  const parsedSums = parseSha256Sums(
    `# checksums\n${'A'.repeat(64)}  *agy-lens.zip\n${'b'.repeat(64)}  agy-lens-v2.3.1.zip\n`,
  );
  assert.equal(parsedSums.get('agy-lens.zip'), 'a'.repeat(64));
  assert.equal(parsedSums.get('agy-lens-v2.3.1.zip'), 'b'.repeat(64));

  // 4. ZIP extraction safety (round-trip, CRC check, zip-slip rejection, prefix check, symlink rejection)
  const goodZip = buildZipBuffer([
    { name: 'agy-lens/plugin.json', data: Buffer.from('{"name":"agy-lens","version":"2.3.1"}') },
    { name: 'agy-lens/sidecars/agy-lens/main.mjs', data: Buffer.from('console.log("hi");\n'.repeat(20)) },
  ]);
  const extracted = extractZipEntries(goodZip, { topDir: 'agy-lens' });
  assert.equal(extracted.size, 2);
  assert.ok(extracted.get('plugin.json').toString('utf8').includes('2.3.1'));

  const corruptedZip = Buffer.from(goodZip);
  const firstPayloadIdx = 30 + 'agy-lens/plugin.json'.length + 5;
  corruptedZip[firstPayloadIdx] ^= 0xff;
  assert.throws(() => extractZipEntries(corruptedZip, { topDir: 'agy-lens' }), /CRC|Invalid|Corrupt|truncated|inflate/i);

  const traversalZip = buildZipBuffer([
    { name: 'agy-lens/../escape.txt', data: Buffer.from('nope') },
  ]);
  assert.throws(() => extractZipEntries(traversalZip, { topDir: 'agy-lens' }), /Unsafe ZIP entry traversal/);

  const wrongPrefixZip = buildZipBuffer([
    { name: 'other-plugin/plugin.json', data: Buffer.from('{}') },
  ]);
  assert.throws(() => extractZipEntries(wrongPrefixZip, { topDir: 'agy-lens' }), /Unexpected ZIP root prefix/);

  const symlinkZip = Buffer.from(buildZipBuffer([
    { name: 'agy-lens/badlink', data: Buffer.from('/etc/passwd') },
  ]));
  const eocdOff = symlinkZip.length - 22;
  const cdOff = symlinkZip.readUInt32LE(eocdOff + 16);
  symlinkZip.writeUInt32LE((0o120777 << 16) >>> 0, cdOff + 38);
  assert.throws(() => extractZipEntries(symlinkZip, { topDir: 'agy-lens' }), /Symlink ZIP entries/);

  // 5. detectInstallMode & installReleaseUpdate lifecycle (refuse git, SHA mismatch, rollback, happy install)
  const { chmodSync } = await import('node:fs');
  const rootTmp = mkdtempSync(join(tmpdir(), 'agy-self-upd-'));
  const prevNoSelf = process.env.AGY_LENS_NO_SELF_UPDATE;
  try {
    delete process.env.AGY_LENS_NO_SELF_UPDATE;
    const pluginDir = join(rootTmp, 'plugin');
    const dataDir = join(rootTmp, 'data');
    const cachePath = join(dataDir, 'update-cache.json');

    const writeInstalledV230 = () => {
      rmSync(pluginDir, { recursive: true, force: true });
      mkdirSync(join(pluginDir, 'sidecars', 'agy-lens', 'lib'), { recursive: true });
      mkdirSync(join(pluginDir, 'sidecars', 'agy-lens', 'web'), { recursive: true });
      mkdirSync(join(pluginDir, 'sidecars', 'agy-lens', '.data'), { recursive: true });
      mkdirSync(join(pluginDir, 'sidecars', 'agy-lens', 'node_modules', 'keep'), { recursive: true });
      writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify({ name: 'agy-lens', version: '2.3.0' }));
      writeFileSync(join(pluginDir, 'package.json'), JSON.stringify({ name: 'agy-lens', version: '2.3.0' }));
      writeFileSync(join(pluginDir, 'sidecars', 'agy-lens', 'sidecar.json'), '{"command":"node","args":["main.mjs"]}');
      writeFileSync(join(pluginDir, 'sidecars', 'agy-lens', 'main.mjs'), '// v2.3.0\n');
      writeFileSync(join(pluginDir, 'sidecars', 'agy-lens', 'lib', 'old.mjs'), '// obsolete in 2.3.1\n');
      writeFileSync(join(pluginDir, 'sidecars', 'agy-lens', 'web', 'index.html'), '<html>v2.3.0</html>');
      writeFileSync(join(pluginDir, 'sidecars', 'agy-lens', 'web', 'app.js'), '// v2.3.0\n');
      writeFileSync(join(pluginDir, 'sidecars', 'agy-lens', '.data', 'keep.json'), '{"ok":true}');
      writeFileSync(join(pluginDir, 'sidecars', 'agy-lens', 'node_modules', 'keep', 'index.js'), 'module.exports=1;');
    };

    writeInstalledV230();
    assert.deepEqual(detectInstallMode(pluginDir), { install_mode: 'installed', can_self_update: true });

    if (process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() !== 0) {
      chmodSync(pluginDir, 0o555);
      try {
        assert.deepEqual(detectInstallMode(pluginDir), { install_mode: 'readonly', can_self_update: false });
      } finally {
        chmodSync(pluginDir, 0o755);
      }
    }

    // Refuses git checkout
    mkdirSync(join(pluginDir, '.git'), { recursive: true });
    assert.deepEqual(detectInstallMode(pluginDir), { install_mode: 'git', can_self_update: false });
    await assert.rejects(
      () => installReleaseUpdate({ rootDir: pluginDir, dataDir, updateCachePath: cachePath }),
      /install_mode="git"/,
    );
    rmSync(join(pluginDir, '.git'), { recursive: true, force: true });

    // Refuses when AGY_LENS_NO_SELF_UPDATE=1
    process.env.AGY_LENS_NO_SELF_UPDATE = '1';
    assert.deepEqual(detectInstallMode(pluginDir), { install_mode: 'disabled', can_self_update: false });
    delete process.env.AGY_LENS_NO_SELF_UPDATE;

    // Prepare v2.3.1 release ZIP + valid SHA256SUMS.txt
    const v231Zip = buildZipBuffer([
      { name: 'agy-lens/plugin.json', data: Buffer.from(JSON.stringify({ name: 'agy-lens', version: '2.3.1' })) },
      { name: 'agy-lens/package.json', data: Buffer.from(JSON.stringify({ name: 'agy-lens', version: '2.3.1' })) },
      { name: 'agy-lens/bin/cli.mjs', data: Buffer.from('#!/usr/bin/env node\nconsole.log("2.3.1");\n') },
      { name: 'agy-lens/sidecars/agy-lens/sidecar.json', data: Buffer.from('{"command":"node","args":["main.mjs"]}') },
      { name: 'agy-lens/sidecars/agy-lens/main.mjs', data: Buffer.from('// v2.3.1\n') },
      { name: 'agy-lens/sidecars/agy-lens/lib/updater.mjs', data: Buffer.from('// new updater\n') },
      { name: 'agy-lens/sidecars/agy-lens/web/index.html', data: Buffer.from('<html>v2.3.1</html>') },
      { name: 'agy-lens/sidecars/agy-lens/web/app.js', data: Buffer.from('// v2.3.1\n') },
    ]);
    const v231Sha = createHash('sha256').update(v231Zip).digest('hex');
    const sumsTxt = `${v231Sha}  agy-lens.zip\n${v231Sha}  agy-lens-v2.3.1.zip\n`;

    const expectedSumsUrl = `${GITHUB_DOWNLOAD_BASE}/v2.3.1/SHA256SUMS.txt`;
    const expectedZipUrl = `${GITHUB_DOWNLOAD_BASE}/v2.3.1/agy-lens-v2.3.1.zip`;

    // SHA-256 mismatch aborts untouched
    await assert.rejects(
      () => installReleaseUpdate({
        rootDir: pluginDir,
        dataDir,
        updateCachePath: cachePath,
        targetVersion: '2.3.1',
        fetchBuffer: async (url) => {
          if (url === expectedSumsUrl) return Buffer.from(`${'0'.repeat(64)}  agy-lens-v2.3.1.zip\n`);
          if (url === expectedZipUrl) return v231Zip;
          throw new Error(`Unexpected URL: ${url}`);
        },
      }),
      /SHA-256 checksum mismatch/,
    );
    assert.equal(readCurrentVersion(pluginDir), '2.3.0');
    assert.equal(readFileSync(join(pluginDir, 'sidecars', 'agy-lens', 'main.mjs'), 'utf8'), '// v2.3.0\n');
    assert.equal(existsSync(join(pluginDir, 'sidecars', 'agy-lens', 'lib', 'old.mjs')), true);

    // Mid-install write failure triggers full automatic rollback (including deleted old.mjs & new files)
    await assert.rejects(
      () => installReleaseUpdate({
        rootDir: pluginDir,
        dataDir,
        updateCachePath: cachePath,
        targetVersion: '2.3.1',
        fetchBuffer: async (url) => (url === expectedSumsUrl ? Buffer.from(sumsTxt) : v231Zip),
        writeFile: async (dest, data, _seq, rel) => {
          if (rel === 'plugin.json') throw new Error('disk full simulation');
          mkdirSync(join(dest, '..'), { recursive: true });
          writeFileSync(dest, data);
        },
      }),
      /disk full simulation/,
    );
    assert.equal(readCurrentVersion(pluginDir), '2.3.0');
    assert.equal(readFileSync(join(pluginDir, 'sidecars', 'agy-lens', 'main.mjs'), 'utf8'), '// v2.3.0\n');
    assert.equal(existsSync(join(pluginDir, 'sidecars', 'agy-lens', 'lib', 'old.mjs')), true);
    assert.equal(existsSync(join(pluginDir, 'sidecars', 'agy-lens', 'lib', 'updater.mjs')), false);

    // Happy path: upgrades 2.3.0 -> 2.3.1, prunes old.mjs, preserves .data & node_modules, updates cache
    const res = await installReleaseUpdate({
      rootDir: pluginDir,
      dataDir,
      updateCachePath: cachePath,
      fetchJson: async () => ({ tag_name: 'v2.3.1', published_at: '2026-11-24T01:30:32Z', body: '## Fixes' }),
      fetchBuffer: async (url) => {
        if (url === expectedSumsUrl) return Buffer.from(sumsTxt);
        if (url === expectedZipUrl) return v231Zip;
        throw new Error(`Unexpected URL: ${url}`);
      },
    });
    assert.equal(res.ok, true);
    assert.equal(res.updated, true);
    assert.equal(res.previous_version, '2.3.0');
    assert.equal(res.version, '2.3.1');
    assert.equal(res.restarting, true);
    assert.equal(res.files_removed, 1);
    assert.equal(readCurrentVersion(pluginDir), '2.3.1');
    assert.equal(readFileSync(join(pluginDir, 'sidecars', 'agy-lens', 'main.mjs'), 'utf8'), '// v2.3.1\n');
    assert.equal(existsSync(join(pluginDir, 'sidecars', 'agy-lens', 'lib', 'old.mjs')), false);
    assert.equal(existsSync(join(pluginDir, 'sidecars', 'agy-lens', '.data', 'keep.json')), true);
    assert.equal(existsSync(join(pluginDir, 'sidecars', 'agy-lens', 'node_modules', 'keep', 'index.js')), true);
    if (process.platform !== 'win32') {
      assert.ok((statSync(join(pluginDir, 'bin', 'cli.mjs')).mode & 0o111) !== 0, 'bin/cli.mjs should stay executable');
    }
    assert.equal(JSON.parse(readFileSync(cachePath, 'utf8')).latest_version, '2.3.1');
  } finally {
    if (prevNoSelf === undefined) delete process.env.AGY_LENS_NO_SELF_UPDATE;
    else process.env.AGY_LENS_NO_SELF_UPDATE = prevNoSelf;
    rmSync(rootTmp, { recursive: true, force: true });
  }
});

test('CycleDrilldown: observation boundary retention, settled segments with concurrency, and drill-down HTML', async () => {
  const { MAX_OBS_PER_CYCLE, normalizeObservations } = await import('../sidecars/agy-lens/lib/quota.mjs');
  const {
    renderQuotaHtml,
    renderCycleDrillHtml,
    renderSegmentFootHtml,
    renderDrillHeaderHtml,
    pickDefaultSegIndex,
  } = await import('../sidecars/agy-lens/web/views/quota.js');
  const { createTranslator } = await import('../sidecars/agy-lens/web/i18n.js');

  assert.equal(MAX_OBS_PER_CYCLE, 300);

  // 1. normalizeObservations preserves long-gap (>2h) boundary pairs when downsampling > 300 points.
  const resetMs = Date.UTC(2026, 10, 30, 0, 0, 0);
  const tStart = Date.UTC(2026, 10, 23, 0, 0, 0);
  const denseRaw = [];
  for (let i = 0; i < 180; i += 1) {
    const used = i * 0.001;
    denseRaw.push({ observed_at: new Date(tStart + i * 60_000).toISOString(), remaining_fraction: 1 - used, used_fraction: used });
  }
  const gapStartMs = tStart + 180 * 60_000;
  const gapEndMs = gapStartMs + 6 * 3600_000; // 6h gap with 0 intermediate points
  denseRaw.push({ observed_at: new Date(gapStartMs).toISOString(), remaining_fraction: 0.75, used_fraction: 0.25 });
  denseRaw.push({ observed_at: new Date(gapEndMs).toISOString(), remaining_fraction: 0.45, used_fraction: 0.55 });
  for (let i = 1; i <= 180; i += 1) {
    const used = 0.55 + i * 0.001;
    denseRaw.push({ observed_at: new Date(gapEndMs + i * 60_000).toISOString(), remaining_fraction: 1 - used, used_fraction: used });
  }
  const kept = normalizeObservations(denseRaw, resetMs);
  assert.equal(kept.length, 300);
  const keptTimes = new Set(kept.map((x) => Date.parse(x.observed_at)));
  assert.equal(keptTimes.has(gapStartMs), true, 'must preserve pre-gap boundary observation');
  assert.equal(keptTimes.has(gapEndMs), true, 'must preserve post-gap boundary observation');

  // 2. scan() computes settled display segments (dropping transient +1% reservation spike) + concurrency + surge tagging
  const dir = mkdtempSync(join(tmpdir(), 'agy-unit-seg-'));
  try {
    const convDir = join(dir, 'convs');
    mkdirSync(convDir);
    const cyStart = Date.UTC(2026, 10, 24, 1, 0, 0); // 09:00 UTC+8
    const tSpike = cyStart + 20 * 60_000;
    const tSettle1 = cyStart + 40 * 60_000;
    const tSurgeEnd = tSettle1 + 3 * 3600_000; // 3h gap with 0 mid obs
    const tExtEnd = tSurgeEnd + 10 * 60_000;
    const tTail = tExtEnd + 30 * 60_000;
    const resetIso = new Date(cyStart + 7 * 86400_000).toISOString();

    // Segment 1 (t0..tSettle1): 4 concurrent convs in same minute, 0.02 used for $40 => implied $2,000/100%
    for (let k = 0; k < 4; k += 1) {
      makeHistoryDb(join(convDir, `norm-${k}.db`), [
        hCall(0, { ts: Math.floor((tSpike - 60_000) / 1000), model: 'gemini-4-hydrogen-tiered-high', input: 3_000_000, output: 400_000, cache: 0 }),
        // Wait: make sure total cost across norm-0..norm-3 equals ~$40
      ]);
    }
    // Better control exact cost: 1M input ($1.5) + 0.2M output ($1.5) = $3.0 per conv -> Wait: give exact tokens on 4 convs at same ts
    rmSync(convDir, { recursive: true, force: true });
    mkdirSync(convDir);
    for (let k = 0; k < 4; k += 1) {
      makeHistoryDb(join(convDir, `norm-${k}.db`), [
        // 4M in ($6) + 0.5333M out ($4) = $10 each -> $40 across 4 convs in 1 minute => peak=4, $40 / 0.02 = $2,000
        hCall(0, { ts: Math.floor((tSettle1 - 120_000) / 1000), model: 'gemini-4-hydrogen-tiered-high', input: 4_000_000, output: 533_333, cache: 0 }),
      ]);
    }
    // Segment 2 (tSettle1..tSurgeEnd, 3h gap): 12 concurrent convs spending $240 for 0.24 used => $1,000/100% (2.0x surge vs $2,000)
    for (let k = 0; k < 12; k += 1) {
      makeHistoryDb(join(convDir, `surge-${k}.db`), [
        hCall(0, { ts: Math.floor((tSurgeEnd - 300_000) / 1000), model: 'gemini-4-hydrogen-tiered-high', input: 8_000_000, output: 1_066_667, cache: 0 }),
      ]);
    }
    // Segment 3 (tSurgeEnd..tExtEnd): 0 local calls, 0.02 external drop => external
    // Segment 4 (tExtEnd..tTail): 2 concurrent convs spending $40 for 0.02 used => $2,000/100%
    for (let k = 0; k < 2; k += 1) {
      makeHistoryDb(join(convDir, `tail-${k}.db`), [
        hCall(0, { ts: Math.floor((tTail - 120_000) / 1000), model: 'gemini-4-hydrogen-tiered-high', input: 8_000_000, output: 1_066_667, cache: 0 }),
      ]);
    }

    const quotaCycles = {
      version: 2,
      pools: {
        gemini: [{
          cycle_start: new Date(cyStart).toISOString(),
          cycle_start_source: 'weekly_7d',
          reset_time: resetIso,
          observed_at: new Date(tTail).toISOString(),
          remaining_fraction: 0.70,
          used_fraction: 0.30,
          observations: [
            { observed_at: new Date(cyStart).toISOString(), remaining_fraction: 1, used_fraction: 0 },
            // Transient in-flight spike: jumps to 4%, then settles back to 2% at tSettle1!
            { observed_at: new Date(tSpike).toISOString(), remaining_fraction: 0.96, used_fraction: 0.04 },
            { observed_at: new Date(tSettle1).toISOString(), remaining_fraction: 0.98, used_fraction: 0.02 },
            { observed_at: new Date(tSurgeEnd).toISOString(), remaining_fraction: 0.74, used_fraction: 0.26 },
            { observed_at: new Date(tExtEnd).toISOString(), remaining_fraction: 0.72, used_fraction: 0.28 },
            { observed_at: new Date(tTail).toISOString(), remaining_fraction: 0.70, used_fraction: 0.30 },
          ],
        }],
      },
    };
    const r = await scan([[convDir, 'desktop']], { now: new Date(tTail + 60_000), quotaCycles });
    const cyOut = r.weekly_cycles.gemini[0];
    assert.equal(cyOut.segments.length, 4, `expected 4 settled segments (spike pruned), got ${JSON.stringify(cyOut.segments)}`);
    assert.equal(cyOut.segment_baseline_usd, 2000);
    assert.equal(cyOut.segments[0].kind, 'normal');
    assert.equal(cyOut.segments[0].peak_concurrency, 4);
    assert.equal(cyOut.segments[0].implied_weekly_usd, 2000);
    assert.equal(cyOut.segments[0].low_confidence, true);
    assert.equal(cyOut.segments[1].kind, 'surge');
    assert.equal(cyOut.segments[1].low_confidence, false);
    assert.equal(cyOut.segments[1].is_gap, true);
    assert.equal(cyOut.segments[1].peak_concurrency, 12);
    assert.equal(cyOut.segments[1].p90_concurrency, 12);
    assert.equal(cyOut.segments[1].burn_ratio, 2);
    assert.equal(cyOut.segments[2].kind, 'external');
    assert.equal(cyOut.segments[2].calls, 0);
    assert.equal(cyOut.segments[3].kind, 'normal');
    assert.equal(cyOut.segments[3].low_confidence, true);
    assert.equal(cyOut.segments[3].peak_concurrency, 2);

    // 3. quota.js drill-down renderer keeps default collapsed view clean & renders drilled view accurately
    const tZh = createTranslator('zh');
    const tEn = createTranslator('en');
    const qProps = {
      data: { plan: 'Pro', fetched_at: new Date(tTail).toISOString(), pools: [{ id: 'gem', category: 'gemini', limits: [] }] },
      historyData: r,
      openKeys: new Set(),
    };
    const collapsedHtml = renderQuotaHtml({ ...qProps, t: tZh, lang: 'zh' });
    assert.ok(!collapsedHtml.includes('is-drill'));
    assert.ok(collapsedHtml.includes('data-cy-key='));
    assert.ok(collapsedHtml.includes('data-cy-ox='));

    assert.equal(pickDefaultSegIndex(cyOut.segments), 1); // highlights highest burn_ratio surge by default
    const drills = new Map([['gemini', { cycleKey: cyOut.cycle_start, ox: '95%', activeIdx: -1 }]]);
    const drilledZh = renderQuotaHtml({ ...qProps, activeDrills: drills, t: tZh, lang: 'zh' });
    assert.ok(drilledZh.includes('wcy-pool is-drill'));
    assert.ok(drilledZh.includes('style="--ox:95%"'));
    assert.ok(drilledZh.includes('sbar is-surge is-active'));
    assert.ok(drilledZh.includes('sbar is-ext'));
    assert.ok(drilledZh.includes('seg-ref-line'));
    assert.ok(drilledZh.includes('2×加速') && drilledZh.includes('最多同时 12 个对话') && drilledZh.includes('跨空闲时段'));

    const drilledEn = renderQuotaHtml({ ...qProps, activeDrills: drills, t: tEn, lang: 'en' });
    assert.ok(drilledEn.includes('2× faster') && drilledEn.includes('Up to 12 chats at once') && drilledEn.includes('With idle gap'));

    // Single-sample edge case still renders gracefully without NaN
    const oneSampleHtml = renderCycleDrillHtml({
      cycle_start: new Date(cyStart).toISOString(),
      weekly_value_usd: 2043,
      segments: [{
        start_at: new Date(cyStart).toISOString(),
        end_at: new Date(tTail).toISOString(),
        used_delta: 0.23,
        cost_usd: 469.89,
        calls: 700,
        implied_weekly_usd: 2043,
        burn_ratio: 1,
        kind: 'normal',
        is_gap: false,
        one_sample: true,
        peak_concurrency: 5,
        p90_concurrency: 4,
      }],
    }, 2043, 0, tZh, 'zh');
    assert.ok(oneSampleHtml.includes('仅 1 次记录') && !oneSampleHtml.includes('NaN'));

    // Invariant 5-slot segment inspector + structured drill header + responsive CSS rules
    for (const segHtml of [
      renderSegmentFootHtml(cyOut.segments[1], cyOut.segments.length, tZh, 'zh'), // surge + gap
      renderSegmentFootHtml(cyOut.segments[0], cyOut.segments.length, tZh, 'zh'), // normal (no tag)
      renderSegmentFootHtml(cyOut.segments[2], cyOut.segments.length, tZh, 'zh'), // external
    ]) {
      for (const cls of ['sf-val', 'sf-tag', 'sf-span', 'sf-spend', 'sf-conc']) {
        assert.ok(segHtml.includes(`class="${cls}`), `expected ${cls} slot in ${segHtml}`);
      }
    }
    const drillHeadHtml = renderDrillHeaderHtml(cyOut, cyOut.segment_baseline_usd, tZh);
    assert.ok(drillHeadHtml.includes('class="wcy-head-drill num"'));
    assert.ok(drillHeadHtml.includes('class="wcy-drill-nav"') && drillHeadHtml.includes('class="wcy-drill-stats"'));
    const cssText = readFileSync(resolve(import.meta.dirname, '../sidecars/agy-lens/web/styles.css'), 'utf8');
    assert.ok(cssText.includes('container-name: cy-stage'));
    assert.ok(cssText.includes('@container cy-stage'));
    assert.match(cssText, /\.seg-foot-gap\s*\{[^}]*white-space:\s*nowrap/);
    assert.match(cssText, /\.wcy-pool\.is-drill\s+\.cy-drill\s*\{[^}]*position:\s*relative/);

    // 4. Sawtooth ~1% in-flight reservation jitter does not trigger fake surge/slow alerts and snaps to settled valleys.
    const sawDir = join(dir, 'saw');
    mkdirSync(sawDir);
    const s0 = Date.UTC(2026, 10, 24, 1, 7, 0);
    const minMs = (m) => s0 + m * 60_000;
    const sawObs = [
      [0, 0],
      [34, 0.0237],
      [75, 0.0404],
      [99, 0.0267],
      [104, 0.0341],
      [147, 0.0428],
      [153, 0.0407],
      [189, 0.0564],
      [195, 0.054],
      [251, 0.0854],
      [256, 0.0781],
      [262, 0.0845],
    ].map(([m, u]) => ({
      observed_at: new Date(minMs(m)).toISOString(),
      remaining_fraction: roundN(1 - u, 8),
      used_fraction: u,
    }));
    // Real-rate calls (~$2,000/full cycle overall) distributed every 3 min matching each phase's quota delta
    const sawCalls = [];
    for (let m = 2; m <= 261; m += 3) {
      // First phase [0..153m] = 4.07% (~$81.40 across 51 calls -> ~$1.60/call); second [153..262m] = 4.38% (~$87.60 across 36 calls -> ~$2.43/call)
      const inp = m <= 153 ? 640_000 : 972_000;
      const out = m <= 153 ? 85_333 : 129_600;
      sawCalls.push(hCall(sawCalls.length, {
        ts: Math.floor(minMs(m) / 1000),
        model: 'gemini-4-hydrogen-tiered-high',
        input: inp,
        output: out,
        cache: 0,
      }));
    }
    makeHistoryDb(join(sawDir, 'saw-steady.db'), sawCalls);
    // Add an earlier settled cycle at $2,000 + test a small <3% early sliver cycle too
    const earlyCalls = [
      hCall(0, {
        ts: Math.floor((s0 - 7 * 86400_000 + 600_000) / 1000),
        model: 'gemini-4-hydrogen-tiered-high',
        input: 3_200_000,
        output: 426_667,
        cache: 0,
      }),
    ];
    makeHistoryDb(join(sawDir, 'early-small.db'), earlyCalls);
    const sawQc = {
      version: 2,
      pools: {
        gemini: [
          {
            cycle_start: new Date(s0 - 7 * 86400_000).toISOString(),
            cycle_start_source: 'weekly_7d',
            reset_time: new Date(s0).toISOString(),
            observed_at: new Date(s0 - 7 * 86400_000 + 1800_000).toISOString(),
            remaining_fraction: 0.985,
            used_fraction: 0.015,
            observations: [
              { observed_at: new Date(s0 - 7 * 86400_000).toISOString(), remaining_fraction: 1, used_fraction: 0 },
              { observed_at: new Date(s0 - 7 * 86400_000 + 1800_000).toISOString(), remaining_fraction: 0.985, used_fraction: 0.015 },
            ],
          },
          {
            cycle_start: new Date(s0).toISOString(),
            cycle_start_source: 'weekly_7d',
            reset_time: new Date(s0 + 7 * 86400_000).toISOString(),
            observed_at: new Date(minMs(262)).toISOString(),
            remaining_fraction: roundN(1 - 0.0845, 8),
            used_fraction: 0.0845,
            observations: sawObs,
          },
        ],
      },
    };
    const rSaw = await scan([[sawDir, 'desktop']], { now: new Date(minMs(263)), quotaCycles: sawQc });
    const sawCy = rSaw.weekly_cycles.gemini[0];
    assert.ok(sawCy.segments.length >= 1 && sawCy.segments.length <= 2, `sawtooth should merge into 1-2 clean segments, got ${sawCy.segments.length}`);
    assert.equal(sawCy.segments[0].used_delta, 0.0407, 'first cut should snap cleanly to the 4.07% settled valley');
    assert.ok(sawCy.segments.every((s) => s.kind === 'normal'), `expected no fake surge/slow alerts in ${JSON.stringify(sawCy.segments)}`);
    const earlyCy = rSaw.weekly_cycles.gemini[1];
    assert.equal(earlyCy.segments[0].low_confidence, true);
    assert.equal(earlyCy.segments[0].kind, 'normal');
    assert.ok(renderCycleDrillHtml(earlyCy, sawCy.segment_baseline_usd, 0, tZh, 'zh').includes('样本较少'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('HistoryTotalsWeekly: periodCostByPool, periodWeeklySummary & renderTotalsHeroHtml', async () => {
  const { periodCostByPool, periodWeeklySummary } = await import('../sidecars/agy-lens/web/format.js');
  const { renderTotalsHeroHtml } = await import('../sidecars/agy-lens/web/views/history.js');
  const { createTranslator } = await import('../sidecars/agy-lens/web/i18n.js');
  const tEn = createTranslator('en');
  const tZh = createTranslator('zh');

  const weeklyValueUsd = { gemini: 1316, claude_gpt: 100 };
  const sampleModels = [
    {
      model: 'gemini-4-hydrogen-tiered-xhigh',
      display_name: 'Gemini 4 Hydrogen (XHigh)',
      pool: 'gemini',
      periods: {
        today: { input: 5_000_000, output: 800_000, cache_read: 40_000_000, calls: 200, est_cost_usd: 14.33 },
        d7: { input: 20_000_000, output: 2_000_000, cache_read: 100_000_000, calls: 500, est_cost_usd: 45 },
        d30: { input: 60_000_000, output: 6_000_000, cache_read: 200_000_000, calls: 1200, est_cost_usd: 180 },
        all: { input: 60_000_000, output: 6_000_000, cache_read: 200_000_000, calls: 1200, est_cost_usd: 3200 },
      },
    },
    {
      model: 'gemini-4-neon-high',
      display_name: 'Gemini 4 Neon (High)',
      pool: 'gemini',
      periods: {
        today: { input: 6_000_000, output: 200_000, cache_read: 30_000_000, calls: 150, est_cost_usd: 26.83 },
        d7: { input: 10_000_000, output: 1_000_000, cache_read: 40_000_000, calls: 200, est_cost_usd: 55 },
        d30: { input: 10_000_000, output: 1_000_000, cache_read: 40_000_000, calls: 200, est_cost_usd: 55 },
        all: { input: 10_000_000, output: 1_000_000, cache_read: 40_000_000, calls: 200, est_cost_usd: 55 },
      },
    },
    {
      model: 'gemini-4-hydrogen-tiered-high',
      display_name: 'Gemini 4 Hydrogen (High)',
      pool: 'gemini',
      periods: {
        today: { input: 3_200_000, output: 100_000, cache_read: 27_386_669, calls: 300, est_cost_usd: 8.69 },
        d7: { input: 3_200_000, output: 100_000, cache_read: 27_386_669, calls: 300, est_cost_usd: 8.69 },
        d30: { input: 3_200_000, output: 100_000, cache_read: 27_386_669, calls: 300, est_cost_usd: 8.69 },
        all: { input: 3_200_000, output: 100_000, cache_read: 27_386_669, calls: 300, est_cost_usd: 8.69 },
      },
    },
    {
      model: 'gemini-4-neon-xhigh',
      display_name: 'Gemini 4 Neon (XHigh)',
      pool: 'gemini',
      periods: {
        today: { input: 10_000, output: 1_500, cache_read: 0, calls: 59, est_cost_usd: 0.18 },
        d7: { input: 10_000, output: 1_500, cache_read: 0, calls: 59, est_cost_usd: 0.18 },
        d30: { input: 10_000, output: 1_500, cache_read: 0, calls: 59, est_cost_usd: 0.18 },
        all: { input: 10_000, output: 1_500, cache_read: 0, calls: 59, est_cost_usd: 0.18 },
      },
    },
  ];

  // 1. Single-pool today sum ($50.03 / $1316 ≈ 3.8%).
  assert.ok(Math.abs(periodCostByPool(sampleModels, 'today').cost_by_pool.gemini - 50.03) < 1e-6);
  const todaySum = periodWeeklySummary(sampleModels, 'today', weeklyValueUsd);
  assert.equal(todaySum.length, 1);
  assert.equal(todaySum[0].pool, 'gemini');
  assert.ok(Math.abs(todaySum[0].pct - (50.03 / 1316) * 100) < 1e-6);

  // 2. All-time multi-week spend stays unclamped (>100%).
  const allSum = periodWeeklySummary(sampleModels, 'all', weeklyValueUsd);
  assert.ok(allSum[0].pct > 240);

  // 3. Empty or missing weekly_value_usd returns [].
  assert.deepEqual(periodWeeklySummary([], 'today', weeklyValueUsd), []);
  assert.deepEqual(periodWeeklySummary(sampleModels, 'today', null), []);

  // 4. Multi-pool active period ranks highest % impact pool first, never sums across pools.
  const multiModels = [
    ...sampleModels,
    {
      model: 'claude-sonnet-4-5',
      display_name: 'Claude Sonnet 4.5',
      pool: 'claude_gpt',
      periods: {
        today: { input: 0, output: 0, cache_read: 0, calls: 0, est_cost_usd: null },
        d30: { input: 2_000_000, output: 500_000, cache_read: 0, calls: 40, est_cost_usd: 41.8 },
      },
    },
  ];
  const d30Multi = periodWeeklySummary(multiModels, 'd30', weeklyValueUsd);
  assert.equal(d30Multi.length, 2);
  assert.equal(d30Multi[0].pool, 'claude_gpt');
  assert.ok(Math.abs(d30Multi[0].pct - 41.8) < 1e-6);

  const historyData = {
    totals: {
      today: { input: 14_400_000, output: 941_900, cache_read: 105_600_000, calls: 709, conversations: 3, est_cost_usd: 50.03, cost_estimated: false },
      d7: { input: 33_210_000, output: 3_101_500, cache_read: 167_386_669, calls: 1059, conversations: 5, est_cost_usd: 108.87, cost_estimated: false },
      d30: { input: 75_210_000, output: 7_601_500, cache_read: 267_386_669, calls: 1799, conversations: 12, est_cost_usd: 285.67, cost_estimated: false },
      all: { input: 75_210_000, output: 7_601_500, cache_read: 267_386_669, calls: 1799, conversations: 12, est_cost_usd: 3263.87, cost_estimated: false },
    },
    by_model: multiModels,
    weekly_value_usd: weeklyValueUsd,
    pricing_source: 'builtin',
  };
  const liveQuota = {
    weekly: {
      gemini: { remaining_fraction: 0.96, reset_time: '2026-11-28T00:00:00Z' },
      claude_gpt: { remaining_fraction: 0.1, reset_time: '2026-11-28T00:00:00Z' },
    },
  };

  // Single-pool today view (zh & en): shows ≈ 3.8%, neutral pool + status, no .hero-weekly-pools strip, no .wbar/.wcycles.
  const zhToday = renderTotalsHeroHtml(historyData, { period: 'today', quotaData: liveQuota, t: tZh, lang: 'zh' });
  assert.ok(zhToday.includes('≈ 3.8%'));
  assert.ok(zhToday.includes('Gemini · 官方同步'));
  assert.ok(!zhToday.includes('txt-warn') && !zhToday.includes('txt-crit'));
  assert.ok(!zhToday.includes('hero-weekly-pools'));
  assert.ok(!zhToday.includes('class="wbar') && !zhToday.includes('class="wcycles'));

  const enToday = renderTotalsHeroHtml(historyData, { period: 'today', quotaData: liveQuota, t: tEn, lang: 'en' });
  assert.ok(enToday.includes('≈ 3.8%'));
  assert.ok(enToday.includes('Gemini · Live'));

  // Multi-pool d30 view: headlines Claude/GPT ≈ 41.8% and renders compact .hero-weekly-pools strip.
  const zhMulti = renderTotalsHeroHtml(historyData, { period: 'd30', quotaData: liveQuota, t: tZh, lang: 'zh' });
  assert.ok(zhMulti.includes('≈ 41.8%'));
  assert.ok(zhMulti.includes('class="hero-weekly-pools'));
  assert.ok(zhMulti.includes('各池周额度'));
  assert.ok(zhMulti.includes('Claude/GPT <b>≈ 41.8%</b>'));
  assert.ok(zhMulti.includes('Gemini <b>≈ 18.5%</b>'));

  // Cached offline valuation still estimates %, labeled Recorded / 已记录.
  const zhOfflineEst = renderTotalsHeroHtml(historyData, { period: 'today', quotaData: null, t: tZh, lang: 'zh' });
  assert.ok(zhOfflineEst.includes('≈ 3.8%'));
  assert.ok(zhOfflineEst.includes('已记录'));

  // Zero-usage period and missing weekly_value_usd fall back cleanly without ≈ %.
  const emptyTodayData = {
    ...historyData,
    totals: { ...historyData.totals, today: { input: 0, output: 0, cache_read: 0, calls: 0, conversations: 0, est_cost_usd: null } },
  };
  const zeroTodayHtml = renderTotalsHeroHtml(emptyTodayData, { period: 'today', quotaData: liveQuota, t: tZh, lang: 'zh' });
  assert.ok(zeroTodayHtml.includes('官方同步'));
  assert.ok(!zeroTodayHtml.includes('≈ '));

  const noValHtml = renderTotalsHeroHtml({ ...historyData, weekly_value_usd: {} }, { period: 'today', quotaData: null, t: tEn, lang: 'en' });
  assert.ok(noValHtml.includes('Offline'));
  assert.ok(!noValHtml.includes('≈ '));

  // When a live pool has an active estimating cycle with weekly_value_usd: null, Totals shows clean estimating status.
  const samplingData = {
    ...historyData,
    weekly_value_usd: { gemini: null, claude_gpt: null },
    weekly_cycles: {
      gemini: [{ is_current: true, valuation_method: 'delta', weekly_value_usd: null }],
    },
  };
  const zhSampling = renderTotalsHeroHtml(samplingData, { period: 'today', quotaData: liveQuota, t: tZh, lang: 'zh' });
  assert.ok(zhSampling.includes('估算中'));
  assert.ok(zhSampling.includes('官方同步'));
  const enSampling = renderTotalsHeroHtml(samplingData, { period: 'today', quotaData: liveQuota, t: tEn, lang: 'en' });
  assert.ok(enSampling.includes('Estimating…'));
  assert.ok(enSampling.includes('Live'));

  // renderListBodyHtml: groups child subagents under parent conversations, badges orphans, and preserves search & hide-subagents.
  const { renderListBodyHtml } = await import('../sidecars/agy-lens/web/views/history.js');
  const nowIso = new Date().toISOString();
  const olderIso = new Date(Date.now() - 3600_000).toISOString();
  const oldestIso = new Date(Date.now() - 7200_000).toISOString();
  const listData = {
    sources: { desktop: 4, cli: 0 },
    by_conversation: [
      {
        id: 'parent-1',
        title: '下一步做什么',
        model: 'gemini-4-hydrogen-tiered-xhigh',
        display_name: 'Gemini 4 Hydrogen (XHigh)',
        input: 1_000_000,
        output: 100_000,
        cache_read: 0,
        calls: 10,
        est_cost_usd: 5,
        last_at: oldestIso,
        children: ['child-1'],
        total: { input: 5_000_000, output: 800_000, cache_read: 0, calls: 60, est_cost_usd: 35.41, subagents: 1, last_at: nowIso, model: 'gemini-4-hydrogen-tiered-xhigh' },
      },
      {
        id: 'child-1',
        title: '@teamwork_explorer',
        agent: 'teamwork_explorer',
        parent_id: 'parent-1',
        is_subagent: true,
        model: 'gemini-4-hydrogen-tiered-high',
        display_name: 'Gemini 4 Hydrogen (High)',
        input: 4_000_000,
        output: 700_000,
        cache_read: 0,
        calls: 50,
        est_cost_usd: 30.41,
        last_at: nowIso,
      },
      {
        id: 'orphan-sub',
        title: '@teamwork',
        agent: 'teamwork',
        is_subagent: true,
        model: 'gemini-4-hydrogen-tiered-high',
        display_name: 'Gemini 4 Hydrogen (High)',
        input: 150_000,
        output: 17_000,
        cache_read: 0,
        calls: 12,
        est_cost_usd: 0.42,
        last_at: olderIso,
      },
    ],
  };

  // Default: child-1 is nested inside parent-1 (not flat at top level), parent-1 sorts first using subtree last_at, orphan-sub gets .sub-badge.
  const listDefaultZh = renderListBodyHtml(listData, { t: tZh, lang: 'zh' });
  assert.ok(listDefaultZh.includes('2 个主对话（含 1 个子智能体）'));
  assert.ok(listDefaultZh.includes('data-children-of="parent-1"'));
  assert.ok(listDefaultZh.includes('含 1 个子智能体'));
  assert.ok(!listDefaultZh.includes('>@teamwork_explorer<'));
  assert.ok(listDefaultZh.includes('class="sub-badge">子智能体<'));
  assert.ok(listDefaultZh.indexOf('下一步做什么') < listDefaultZh.indexOf('@teamwork'));

  // Hide subagents: excludes orphan-sub and nested children.
  const listHideZh = renderListBodyHtml(listData, { hideSubagents: true, t: tZh, lang: 'zh' });
  assert.ok(listHideZh.includes('下一步做什么'));
  assert.ok(!listHideZh.includes('@teamwork'));
  assert.ok(!listHideZh.includes('data-children-of'));

  // Search matching child subagent surfaces child with .sub-badge and parent link ("隶属 下一步做什么" / "in ...").
  const listSearchZh = renderListBodyHtml(listData, { searchQuery: 'explorer', t: tZh, lang: 'zh' });
  assert.ok(listSearchZh.includes('@teamwork_explorer'));
  assert.ok(listSearchZh.includes('class="sub-badge">子智能体<'));
  assert.ok(listSearchZh.includes('隶属 下一步做什么'));
  const listSearchEn = renderListBodyHtml(listData, { searchQuery: 'explorer', t: tEn, lang: 'en' });
  assert.ok(listSearchEn.includes('in 下一步做什么'));
});

test('Calibration: Ridge WLS + LOOCV across model / io / model_io splits, external-usage filter & end-to-end scan/UI', async () => {
  const {
    calibratePoolWeights,
    calibratedCallCost,
    filterExternalSegments,
    invertMatrix,
    solveLinearSystem,
  } = await import('../sidecars/agy-lens/lib/calibration.mjs');
  const { costPartsOf, priceFor } = await import('../sidecars/agy-lens/lib/pricing.mjs');
  const { meterHtml, renderQuotaHtml } = await import('../sidecars/agy-lens/web/views/quota.js');
  const { renderTotalsHeroHtml } = await import('../sidecars/agy-lens/web/views/history.js');
  const { convWeeklyLabel, modelWeeklyLabel } = await import('../sidecars/agy-lens/web/format.js');
  const { createTranslator } = await import('../sidecars/agy-lens/web/i18n.js');
  const tEn = createTranslator('en');
  const tZh = createTranslator('zh');

  // 1. Linear algebra & matrix inversion
  const sol = solveLinearSystem([[2, 1], [1, 3]], [5, 10]);
  assert.ok(sol && Math.abs(sol[0] - 1) < 1e-9 && Math.abs(sol[1] - 3) < 1e-9);
  assert.equal(solveLinearSystem([[1, 2], [2, 4]], [3, 6]), null);
  const inv = invertMatrix([[2, 1], [1, 3]]);
  assert.ok(inv && Math.abs(inv[0][0] - 0.6) < 1e-9 && Math.abs(inv[0][1] + 0.2) < 1e-9 && Math.abs(inv[1][1] - 0.4) < 1e-9);
  assert.equal(invertMatrix([[1, 2], [2, 4]]), null);

  // 2. External segment filter: drops zero-call / zero-spend drops >= 0.5%
  const mkSeg = (delta, calls, modelsObj, fine = true) => {
    let costUsd = 0;
    const costByModel = new Map();
    for (const [m, p] of Object.entries(modelsObj)) {
      const cIn = p.in ?? p.total ?? 0;
      const cOut = p.out ?? 0;
      const cCache = p.cache ?? 0;
      const total = cIn + cOut + cCache;
      costUsd += total;
      costByModel.set(m, { in: cIn, out: cOut, cache: cCache, total });
    }
    return { delta, calls, costUsd, costPartial: false, fine, costByModel };
  };

  const extRes = filterExternalSegments([
    mkSeg(0.08, 0, {}),
    mkSeg(0.05, 5, { 'gemini-4-neon-high': { total: 5 } }),
  ]);
  assert.equal(extRes.external.length, 1);
  assert.equal(extRes.externalDelta, 0.08);
  assert.equal(extRes.clean.length, 1);

  const modelNames = new Map([
    ['gemini-4-neon-high', 'Gemini 4 Neon (High)'],
    ['gemini-4-hydrogen-tiered-high', 'Gemini 4 Hydrogen (High)'],
    ['gemini-4-hydrogen-tiered-xhigh', 'Gemini 4 Hydrogen (XHigh)'],
  ]);

  // 3. Candidate 1 (mode: 'model'): recovers hidden 2:1 Neon vs Hydrogen ratio across 5 varied segments
  const modelSegs = [
    mkSeg(0.01 * (2 * 10 + 0), 10, { 'gemini-4-neon-high': { total: 10 } }),
    mkSeg(0.01 * (2 * 0 + 10), 10, { 'gemini-4-hydrogen-tiered-high': { total: 10 } }),
    mkSeg(0.01 * (2 * 8 + 4), 10, { 'gemini-4-neon-high': { total: 8 }, 'gemini-4-hydrogen-tiered-high': { total: 4 } }),
    mkSeg(0.01 * (2 * 2 + 12), 10, { 'gemini-4-neon-high': { total: 2 }, 'gemini-4-hydrogen-tiered-high': { total: 12 } }),
    mkSeg(0.01 * (2 * 6 + 6), 10, { 'gemini-4-neon-high': { total: 6 }, 'gemini-4-hydrogen-tiered-high': { total: 6 } }),
  ];
  const calModel = calibratePoolWeights(modelSegs, { modelNames });
  assert.equal(calModel.calibrated, true);
  assert.equal(calModel.mode, 'model');
  const mRatio = calModel.models['gemini-4-neon-high'].multiplier / calModel.models['gemini-4-hydrogen-tiered-high'].multiplier;
  assert.ok(mRatio > 1.8 && mRatio < 2.2, `Expected Neon/Hydrogen ratio near 2.0, got ${mRatio}`);
  assert.ok(calModel.improvement_pct > 50 && calModel.loo_improvement_pct > 50);

  // 4. Candidate 2 (mode: 'io'): single model where server charges output 2x and cache_read 0x
  const ioSegs = [
    mkSeg(0.01 * (1 * 10 + 2 * 1 + 0 * 1), 10, { 'gemini-4-hydrogen-tiered-xhigh': { in: 10, out: 1, cache: 1 } }),
    mkSeg(0.01 * (1 * 1 + 2 * 8 + 0 * 1), 10, { 'gemini-4-hydrogen-tiered-xhigh': { in: 1, out: 8, cache: 1 } }),
    mkSeg(0.01 * (1 * 2 + 2 * 1 + 0 * 12), 10, { 'gemini-4-hydrogen-tiered-xhigh': { in: 2, out: 1, cache: 12 } }),
    mkSeg(0.01 * (1 * 6 + 2 * 6 + 0 * 2), 10, { 'gemini-4-hydrogen-tiered-xhigh': { in: 6, out: 6, cache: 2 } }),
    mkSeg(0.01 * (1 * 3 + 2 * 7 + 0 * 9), 10, { 'gemini-4-hydrogen-tiered-xhigh': { in: 3, out: 7, cache: 9 } }),
    mkSeg(0.01 * (1 * 9 + 2 * 2 + 0 * 8), 10, { 'gemini-4-hydrogen-tiered-xhigh': { in: 9, out: 2, cache: 8 } }),
  ];
  const calIo = calibratePoolWeights(ioSegs, { modelNames });
  assert.equal(calIo.calibrated, true);
  assert.equal(calIo.mode, 'io');
  assert.ok(calIo.components.cache_read < 0.35, `Expected near-0 cache weight, got ${calIo.components.cache_read}`);
  assert.ok(calIo.components.output > calIo.components.input * 1.4, `Expected output > 1.4x input, got ${JSON.stringify(calIo.components)}`);

  // 5. Candidate 3 (mode: 'model_io'): two models with distinct per-(input, output, cache_read) billing
  const mioSegs = [
    mkSeg(0.01 * (1 * 2 + 2.5 * 8 + 0 * 1 + 1 * 4 + 1 * 2 + 1 * 4), 10, { 'gemini-4-neon-high': { in: 2, out: 8, cache: 1 }, 'gemini-4-hydrogen-tiered-high': { in: 4, out: 2, cache: 4 } }),
    mkSeg(0.01 * (1 * 9 + 2.5 * 1 + 0 * 10 + 1 * 1 + 1 * 1 + 1 * 1), 10, { 'gemini-4-neon-high': { in: 9, out: 1, cache: 10 }, 'gemini-4-hydrogen-tiered-high': { in: 1, out: 1, cache: 1 } }),
    mkSeg(0.01 * (1 * 1 + 2.5 * 1 + 0 * 12), 10, { 'gemini-4-neon-high': { in: 1, out: 1, cache: 12 } }),
    mkSeg(0.01 * (1 * 8 + 2.5 * 2 + 0 * 1), 10, { 'gemini-4-neon-high': { in: 8, out: 2, cache: 1 } }),
    mkSeg(0.01 * (1 * 1 + 2.5 * 10 + 0 * 1), 10, { 'gemini-4-neon-high': { in: 1, out: 10, cache: 1 } }),
    mkSeg(0.01 * (1 * 2 + 1 * 2 + 1 * 10), 10, { 'gemini-4-hydrogen-tiered-high': { in: 2, out: 2, cache: 10 } }),
    mkSeg(0.01 * (1 * 10 + 1 * 2 + 1 * 2), 10, { 'gemini-4-hydrogen-tiered-high': { in: 10, out: 2, cache: 2 } }),
    mkSeg(0.01 * (1 * 2 + 1 * 10 + 1 * 2), 10, { 'gemini-4-hydrogen-tiered-high': { in: 2, out: 10, cache: 2 } }),
    mkSeg(0.01 * (1 * 3 + 2.5 * 6 + 0 * 6 + 1 * 5 + 1 * 5 + 1 * 2), 10, { 'gemini-4-neon-high': { in: 3, out: 6, cache: 6 }, 'gemini-4-hydrogen-tiered-high': { in: 5, out: 5, cache: 2 } }),
    mkSeg(0.01 * (1 * 6 + 2.5 * 5 + 0 * 2 + 1 * 2 + 1 * 2 + 1 * 8), 10, { 'gemini-4-neon-high': { in: 6, out: 5, cache: 2 }, 'gemini-4-hydrogen-tiered-high': { in: 2, out: 2, cache: 8 } }),
  ];
  const calMio = calibratePoolWeights(mioSegs, { modelNames });
  assert.equal(calMio.calibrated, true);
  assert.equal(calMio.mode, 'model_io');
  assert.ok(calMio.models['gemini-4-neon-high'].output > calMio.models['gemini-4-neon-high'].input * 1.4);
  assert.ok(calMio.models['gemini-4-neon-high'].cache_read < 0.35);
  assert.ok(calMio.models['gemini-4-hydrogen-tiered-high'].cache_read > 0.65);

  // 6. Anti-overfitting gate: 1:1 prior + small jitter and collinear mixtures must NOT trigger calibration
  const noiseSegs = [
    mkSeg(0.050 * 1.02, 5, { 'gemini-4-neon-high': { total: 4 }, 'gemini-4-hydrogen-tiered-high': { total: 1 } }),
    mkSeg(0.050 * 0.98, 5, { 'gemini-4-neon-high': { total: 1 }, 'gemini-4-hydrogen-tiered-high': { total: 4 } }),
    mkSeg(0.060 * 0.99, 5, { 'gemini-4-neon-high': { total: 5 }, 'gemini-4-hydrogen-tiered-high': { total: 1 } }),
    mkSeg(0.060 * 1.01, 5, { 'gemini-4-neon-high': { total: 1 }, 'gemini-4-hydrogen-tiered-high': { total: 5 } }),
    mkSeg(0.040 * 1.02, 5, { 'gemini-4-neon-high': { total: 2 }, 'gemini-4-hydrogen-tiered-high': { total: 2 } }),
    mkSeg(0.040 * 0.98, 5, { 'gemini-4-neon-high': { total: 3 }, 'gemini-4-hydrogen-tiered-high': { total: 1 } }),
  ];
  assert.equal(calibratePoolWeights(noiseSegs).calibrated, false);

  const colinearSegs = [
    mkSeg(0.04, 5, { 'gemini-4-neon-high': { total: 2 }, 'gemini-4-hydrogen-tiered-high': { total: 2 } }),
    mkSeg(0.08, 5, { 'gemini-4-neon-high': { total: 4 }, 'gemini-4-hydrogen-tiered-high': { total: 4 } }),
    mkSeg(0.06, 5, { 'gemini-4-neon-high': { total: 3 }, 'gemini-4-hydrogen-tiered-high': { total: 3 } }),
    mkSeg(0.10, 5, { 'gemini-4-neon-high': { total: 5 }, 'gemini-4-hydrogen-tiered-high': { total: 5 } }),
  ];
  assert.equal(calibratePoolWeights(colinearSegs).calibrated, false);

  // 7. End-to-end scan() + UI: off-machine drop excluded & calibrated model weights propagate consistently
  const dir = mkdtempSync(join(tmpdir(), 'agy-unit-cal-'));
  try {
    const root = join(dir, 'convs');
    mkdirSync(root);
    const t0 = hTs(4);
    const makeParts = (m, i, o) => {
      const pr = costPartsOf(priceFor(m), i, o, 0, false);
      return pr[0] + pr[1] + pr[2];
    };
    const segCosts = [
      { ts: t0 + 1800, model: 'gemini-4-neon-high', disp: 'Gemini 4 Neon (High)', i: 1_000_000, o: 100_000 },
      { ts: t0 + 5400, model: 'gemini-4-hydrogen-tiered-high', disp: 'Gemini 4 Hydrogen (High)', i: 2_000_000, o: 200_000 },
      { ts: t0 + 9000, model: 'gemini-4-neon-high', disp: 'Gemini 4 Neon (High)', i: 1_500_000, o: 150_000 },
      { ts: t0 + 12600, model: 'gemini-4-hydrogen-tiered-high', disp: 'Gemini 4 Hydrogen (High)', i: 3_000_000, o: 300_000 },
      { ts: t0 + 16200, model: 'gemini-4-neon-high', disp: 'Gemini 4 Neon (High)', i: 800_000, o: 80_000 },
    ];
    makeHistoryDb(join(root, 'cal.db'), segCosts.map((c) => hCall(4, {
      ts: c.ts, model: c.model, display: c.disp, input: c.i, output: c.o, cache: 0,
    })));
    // True 100% benchmark: $200 calibrated equivalent USD; Neon has true 2x prior vs Hydrogen 1x.
    let used = 0;
    const obs = [{ observed_at: new Date((t0) * 1000).toISOString(), remaining_fraction: 1, used_fraction: 0 }];
    const pushObs = (tsSec, du) => {
      used = roundN(used + du, 8);
      obs.push({
        observed_at: new Date(tsSec * 1000).toISOString(),
        remaining_fraction: roundN(1 - used, 8),
        used_fraction: used,
      });
    };
    pushObs(t0 + 3600, (2 * makeParts('gemini-4-neon-high', segCosts[0].i, segCosts[0].o)) / 200);
    pushObs(t0 + 7200, (1 * makeParts('gemini-4-hydrogen-tiered-high', segCosts[1].i, segCosts[1].o)) / 200);
    pushObs(t0 + 10800, (2 * makeParts('gemini-4-neon-high', segCosts[2].i, segCosts[2].o)) / 200);
    pushObs(t0 + 14400, (1 * makeParts('gemini-4-hydrogen-tiered-high', segCosts[3].i, segCosts[3].o)) / 200);
    pushObs(t0 + 18000, (2 * makeParts('gemini-4-neon-high', segCosts[4].i, segCosts[4].o)) / 200);
    // Add an off-machine 8% drop with 0 local calls inside the cycle
    pushObs(t0 + 21600, 0.08);

    const quotaCycles = {
      version: 2,
      pools: {
        gemini: [{
          cycle_start: new Date(t0 * 1000).toISOString(),
          cycle_start_source: 'explicit',
          reset_time: new Date((hTs(-3)) * 1000).toISOString(),
          observed_at: obs[obs.length - 1].observed_at,
          remaining_fraction: obs[obs.length - 1].remaining_fraction,
          used_fraction: obs[obs.length - 1].used_fraction,
          observations: obs,
        }],
      },
    };
    const r = await scan([[root, 'desktop']], { now: H_NOW, quotaCycles });
    assert.equal(r.quota_calibration.gemini.calibrated, true);
    assert.equal(r.quota_calibration.gemini.external_dropped, 1);
    assert.equal(r.weekly_cycles.gemini[0].external_used_fraction, 0.08);
    assert.ok(
      r.quota_calibration.gemini.models['gemini-4-neon-high'].multiplier
      > r.quota_calibration.gemini.models['gemini-4-hydrogen-tiered-high'].multiplier * 1.6,
    );
    // Sum of per-model calibrated period shares aligns with total observed cycle share (minus 8% external drop).
    const qHtml = renderQuotaHtml({
      data: {
        plan: 'Pro',
        fetched_at: new Date().toISOString(),
        weekly: { gemini: { remaining_fraction: obs[obs.length - 1].remaining_fraction, reset_time: quotaCycles.pools.gemini[0].reset_time } },
        pools: [{ id: 'gemini', category: 'gemini', limits: [{ kind: 'weekly', remaining_fraction: obs[obs.length - 1].remaining_fraction, reset_time: quotaCycles.pools.gemini[0].reset_time }], models: [] }],
      },
      historyData: r,
      openKeys: new Set(),
      t: tZh,
      lang: 'zh',
    });
    assert.ok(!qHtml.includes('权重已校准') && !qHtml.includes('class="wcal') && !qHtml.includes('wcycles-note'));
    assert.ok(!qHtml.includes('(Δ'));

    const heroEn = renderTotalsHeroHtml(r, { period: 'all', t: tEn, lang: 'en' });
    assert.ok(heroEn.includes(`$${r.totals.all.est_cost_usd.toFixed(2)}`));
    const calCostTest = calibratedCallCost(r.quota_calibration.gemini, 'gemini-4-neon-high', 10, 0, 0);
    assert.ok(calCostTest > 10);
    assert.ok(modelWeeklyLabel(r.by_model.find((m) => m.model === 'gemini-4-neon-high'), {
      weeklyValueUsd: r.weekly_value_usd,
      quotaCalibration: r.quota_calibration,
      t: tEn,
    }).includes('%'));
    assert.ok(convWeeklyLabel(r.by_conversation[0], {
      weeklyValueUsd: r.weekly_value_usd,
      quotaCalibration: r.quota_calibration,
      t: tEn,
    }).includes('%'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('TimeLockedQuotaAccounting: strict official-scale cycle summation, segment-level conversation lock, and untracked guard', async () => {
  const { renderTotalsHeroHtml } = await import('../sidecars/agy-lens/web/views/history.js');
  const { renderOverviewHtml } = await import('../sidecars/agy-lens/web/views/overview.js');
  const { convWeeklyLabel, modelWeeklyLabel, periodQuotaSummary, withSubtree } = await import('../sidecars/agy-lens/web/format.js');
  const { createTranslator } = await import('../sidecars/agy-lens/web/i18n.js');
  const tZh = createTranslator('zh');
  const tEn = createTranslator('en');

  const dir = mkdtempSync(join(tmpdir(), 'agy-unit-timelock-'));
  try {
    const convDir = join(dir, 'conversations');
    mkdirSync(convDir);
    // Anchor on local midnight so `today` and `d7` behave identically across all timezones.
    const day0Ms = new Date(2026, 10, 24, 0, 0, 0).getTime();
    const now = new Date(day0Ms + 15 * 3600_000);
    const cy3Start = day0Ms + 9 * 3600_000;          // today 09:00..15:00 (live)
    const cy2Start = day0Ms - 3 * 86400_000;         // 3d ago -> cy3Start (d7)
    const cy1Start = day0Ms - 5 * 86400_000;         // 5d ago -> cy2Start (d7)
    const preMs = day0Ms - 6 * 86400_000 + 3600_000; // 6d ago (d7, BEFORE any cycle)

    // Each call with inp=200k ($0.30) + out=360k ($2.70) costs $3.00 exactly.
    const mk3 = (startMs, count, stepSec = 60, model = 'gemini-4-hydrogen-tiered-high') => (
      Array.from({ length: count }, (_, i) => hCall(0, {
        ts: Math.floor(startMs / 1000) + i * stepSec,
        model,
        display: model === 'gemini-4-neon' ? 'Gemini 4 Neon' : 'Gemini 4 Hydrogen (High)',
        input: 200_000,
        output: 360_000,
        cache: 0,
      }))
    );

    // Pre-tracking conversation: 23 calls * $6 (neon = 2x hydrogen) = $138 before cy1Start (never converted using later cycle prices).
    makeHistoryDb(join(convDir, 'pre-conv.db'), mk3(preMs, 23, 30, 'gemini-4-neon'));

    // Cycle 1: 24% observed over 28h ($480 -> $2,000/cycle), followed by unpolled $360 tail (= 18% -> 42% total).
    makeHistoryDb(join(convDir, 'conv-c1-obs.db'), mk3(cy1Start + 3600_000, 160, 120));
    makeHistoryDb(join(convDir, 'conv-c1-tail.db'), mk3(cy1Start + 29 * 3600_000, 120, 120));

    // Cycle 2: 18% normal segment ($360 -> $2,000/cycle) + 48% 2x surge segment ($480 -> $1,000/cycle).
    makeHistoryDb(join(convDir, 'conv-c2-norm.db'), mk3(cy2Start + 3600_000, 120, 120));
    makeHistoryDb(join(convDir, 'conv-c2-surge.db'), mk3(cy2Start + 18 * 3600_000, 160, 120));

    // Cycle 3 (live today): parent + subagent spend $90 + $90 = $180 for 9% ($2,000/cycle).
    makeHistoryDb(join(convDir, 'conv-c3-main.db'), mk3(cy3Start + 3600_000, 30, 60));
    makeHistoryDb(join(convDir, 'conv-c3-sub.db'), mk3(cy3Start + 2 * 3600_000, 30, 60));
    makeSummariesDb(join(dir, 'conversation_summaries.db'), [
      { id: 'conv-c3-main', title: 'Main C3' },
      { id: 'conv-c3-sub', agent: 'worker', parent: 'conv-c3-main' },
    ]);

    const buildCycles = () => ({
      version: 2,
      pools: {
        gemini: [
          {
            cycle_start: new Date(cy1Start).toISOString(),
            cycle_start_source: 'explicit',
            reset_time: new Date(cy1Start + 7 * 86400_000).toISOString(),
            ended_at: new Date(cy2Start).toISOString(),
            first_seen_at: new Date(cy1Start + 28 * 3600_000).toISOString(),
            observed_at: new Date(cy1Start + 28 * 3600_000).toISOString(),
            remaining_fraction: 0.76,
            used_fraction: 0.24,
            observations: [{ observed_at: new Date(cy1Start + 28 * 3600_000).toISOString(), remaining_fraction: 0.76, used_fraction: 0.24 }],
          },
          {
            cycle_start: new Date(cy2Start).toISOString(),
            cycle_start_source: 'explicit',
            reset_time: new Date(cy2Start + 7 * 86400_000).toISOString(),
            ended_at: new Date(cy3Start).toISOString(),
            first_seen_at: new Date(cy2Start).toISOString(),
            observed_at: new Date(cy2Start + 30 * 3600_000).toISOString(),
            remaining_fraction: 0.34,
            used_fraction: 0.66,
            observations: [
              { observed_at: new Date(cy2Start).toISOString(), remaining_fraction: 1, used_fraction: 0 },
              { observed_at: new Date(cy2Start + 16 * 3600_000).toISOString(), remaining_fraction: 0.82, used_fraction: 0.18 },
              { observed_at: new Date(cy2Start + 30 * 3600_000).toISOString(), remaining_fraction: 0.34, used_fraction: 0.66 },
            ],
          },
          {
            cycle_start: new Date(cy3Start).toISOString(),
            cycle_start_source: 'weekly_7d',
            reset_time: new Date(cy3Start + 7 * 86400_000).toISOString(),
            first_seen_at: new Date(cy3Start).toISOString(),
            observed_at: new Date(cy3Start + 4 * 3600_000).toISOString(),
            remaining_fraction: 0.91,
            used_fraction: 0.09,
            observations: [
              { observed_at: new Date(cy3Start).toISOString(), remaining_fraction: 1, used_fraction: 0 },
              { observed_at: new Date(cy3Start + 4 * 3600_000).toISOString(), remaining_fraction: 0.91, used_fraction: 0.09 },
            ],
          },
        ],
      },
    });

    const r1 = await scan([[convDir, 'desktop']], { now, quotaCycles: buildCycles() });

    // 1. Today is purely official (exact: true, no ≈); d7 sums all 3 cycles on their own scales (24+18+18+48+9 = 117%)
    //    PLUS pre-tracking $138 anchored to earliest cycle cy1 ($2,000/cycle -> 6.9%) = 123.9% total.
    assert.equal(r1.period_quota.today.gemini.pct, 9);
    assert.equal(r1.period_quota.today.gemini.exact, true);
    assert.equal(r1.period_quota.d7.gemini.observed_pct, 99);
    assert.equal(r1.period_quota.d7.gemini.tail_est_pct, 18);
    assert.equal(r1.period_quota.d7.gemini.hist_est_pct, 6.9);
    assert.equal(r1.period_quota.d7.gemini.pct, 123.9);
    assert.equal(r1.period_quota.d7.gemini.untracked_cost_usd, 0);
    assert.equal(r1.period_quota.d7.gemini.exact, false);

    // 2. Hero UI drops ≈ on exact today numbers, keeps ≈ on estimated d7 (with hist part), and keeps Live/官方同步 neutral.
    const liveQ = { weekly: { gemini: { remaining_fraction: 0.05, reset_time: new Date(cy3Start + 7 * 86400_000).toISOString() } } };
    const todayHero = renderTotalsHeroHtml(r1, { period: 'today', quotaData: liveQ, t: tZh, lang: 'zh' });
    assert.ok(todayHero.includes('>9%<') && !todayHero.includes('≈ 9%'));
    assert.ok(todayHero.includes('Gemini · 官方同步') && !todayHero.includes('txt-crit') && !todayHero.includes('txt-warn'));
    const d7Hero = renderTotalsHeroHtml(r1, { period: 'd7', quotaData: liveQ, t: tZh, lang: 'zh' });
    assert.ok(d7Hero.includes('≈ 124%') && d7Hero.includes('早期无记录估算'));
    assert.equal(periodQuotaSummary(r1.period_quota, 'd7', r1.by_model, r1.weekly_value_usd)[0].pct, 123.9);

    // 3. Conversations & models lock to their period/segment price; pre-tracking conversations anchor to cy1 and keep labels;
    //    sum of per-model d7 quota_pct strictly conserves period_quota.d7.
    const byId = new Map(r1.by_conversation.map((c) => [c.id, c]));
    assert.equal(byId.get('pre-conv').quota_pct_by_pool.gemini, 6.9);
    assert.equal(convWeeklyLabel(byId.get('pre-conv'), { weeklyValueUsd: r1.weekly_value_usd, compact: true, t: tEn }), '≈ 6.9% weekly');
    assert.equal(byId.get('conv-c1-obs').quota_pct_by_pool.gemini, 24);
    assert.equal(byId.get('conv-c1-tail').quota_pct_by_pool.gemini, 18);
    assert.equal(byId.get('conv-c2-norm').quota_pct_by_pool.gemini, 18);  // at $2,000/100%
    assert.equal(byId.get('conv-c2-surge').quota_pct_by_pool.gemini, 48); // at $1,000/100% surge rate!
    assert.equal(byId.get('conv-c3-main').total.quota_pct_by_pool.gemini, 9);
    assert.equal(withSubtree(byId.get('conv-c3-main')).quota_pct_by_pool.gemini, 9);
    const neonModel = r1.by_model.find((m) => m.model === 'gemini-4-neon');
    assert.equal(neonModel.quota_pct, 6.9);
    assert.equal(modelWeeklyLabel(neonModel, { compact: true, weeklyValueUsd: r1.weekly_value_usd, t: tEn }), '≈ 6.9% weekly');
    const modelD7Sum = r1.by_model
      .filter((m) => m.pool === 'gemini')
      .reduce((s, m) => s + (m.periods.d7?.quota_pct || 0), 0);
    assert.ok(Math.abs(modelD7Sum - r1.period_quota.d7.gemini.pct) < 0.01, `Expected conservation ${modelD7Sum} === ${r1.period_quota.d7.gemini.pct}`);

    // 3b. Single-cycle / Dev / Fresh-install scenario (only Cycle 3 recorded):
    //     older usage before Cycle 3 ($1,818) is estimated at Cycle 3's price ($2,000/cycle -> 90.9%), never dropped to 0%,
    //     and older conversations preserve their constant weekly quota labels.
    const cyclesOnly3 = { version: 2, pools: { gemini: [buildCycles().pools.gemini[2]] } };
    const rSingle = await scan([[convDir, 'desktop']], { now, quotaCycles: cyclesOnly3 });
    assert.equal(rSingle.period_quota.d7.gemini.observed_pct, 9);
    assert.equal(rSingle.period_quota.d7.gemini.hist_est_pct, 90.9);
    assert.equal(rSingle.period_quota.d7.gemini.pct, 99.9);
    const bySingle = new Map(rSingle.by_conversation.map((c) => [c.id, c]));
    assert.equal(bySingle.get('pre-conv').quota_pct_by_pool.gemini, 6.9);
    assert.equal(bySingle.get('conv-c1-obs').quota_pct_by_pool.gemini, 24);
    assert.equal(bySingle.get('conv-c2-norm').quota_pct_by_pool.gemini, 18);
    assert.ok(convWeeklyLabel(bySingle.get('pre-conv'), { weeklyValueUsd: rSingle.weekly_value_usd, compact: true, t: tEn }).includes('%'));
    assert.ok(convWeeklyLabel(bySingle.get('conv-c1-obs'), { weeklyValueUsd: rSingle.weekly_value_usd, compact: true, t: tEn }).includes('%'));

    // Overview session card also receives subtree quota_pct_by_pool cleanly.
    const ovHtml = renderOverviewHtml({
      model: 'gemini-4-hydrogen-tiered-high',
      used_tokens: 1000,
      limit_tokens: 1000000,
      used_pct: 0.1,
      free_tokens: 999000,
      heading: 'Tokens',
      grid_segments: [1000],
      categories: [],
      session: { calls: 10, input: 1000, output: 100, cache_read: 0, est_cost_usd: 30, cost_by_pool: { gemini: 30 }, pool: 'gemini' },
      updatedAt: now.toISOString(),
    }, { historyData: r1, conversationId: 'conv-c3-main', openKeys: new Set(), t: tEn, lang: 'en' });
    assert.ok(ovHtml.includes('9% weekly'));

    // 4. Now inflate ONLY Cycle 3's cost by +$270 ($180 -> $450 for 9%, making latest weekly_value_usd jump to $5,000!):
    //    Historical cycles, pre-tracking history (anchored to cy1), conversations, and d7 past contributions must stay 100% invariant.
    makeHistoryDb(join(convDir, 'conv-c3-extra.db'), mk3(cy3Start + 3 * 3600_000, 90, 10));
    const r2 = await scan([[convDir, 'desktop']], { now, quotaCycles: buildCycles() });
    assert.equal(r2.weekly_value_usd.gemini, 5000);
    const byId2 = new Map(r2.by_conversation.map((c) => [c.id, c]));
    assert.equal(r2.period_quota.d7.gemini.pct, 123.9);
    assert.equal(byId2.get('pre-conv').quota_pct_by_pool.gemini, 6.9);
    assert.equal(byId2.get('conv-c1-obs').quota_pct_by_pool.gemini, 24);
    assert.equal(byId2.get('conv-c1-tail').quota_pct_by_pool.gemini, 18);
    assert.equal(byId2.get('conv-c2-norm').quota_pct_by_pool.gemini, 18);
    assert.equal(byId2.get('conv-c2-surge').quota_pct_by_pool.gemini, 48);

    // 5. Active cycle live unpolled tail: calls made after cy3.observed_at (cy3Start+5h < now) count immediately at cy3's rate ($5,000/cycle).
    makeHistoryDb(join(convDir, 'conv-c3-live.db'), mk3(cy3Start + 5 * 3600_000, 50, 10)); // 50 * $3 = $150 -> 3%
    const r3 = await scan([[convDir, 'desktop']], { now, quotaCycles: buildCycles() });
    assert.equal(r3.period_quota.today.gemini.observed_pct, 9);
    assert.equal(r3.period_quota.today.gemini.tail_est_pct, 3);
    assert.equal(r3.period_quota.today.gemini.pct, 12);
    assert.equal(r3.period_quota.today.gemini.exact, false);
    assert.equal(r3.period_quota.d7.gemini.pct, 126.9);
    const byId3 = new Map(r3.by_conversation.map((c) => [c.id, c]));
    assert.equal(byId3.get('conv-c3-live').quota_pct_by_pool.gemini, 3);

    // 6. Cross-cycle conversation: sums its locked slice from an older cheap cycle ($1,000/cycle -> 10%)
    //    and a newer expensive cycle ($3,000/cycle -> 5%) for an exact 15% total, invariant to future cost changes.
    const crossDir = join(dir, 'cross');
    mkdirSync(crossDir);
    const cAStart = day0Ms - 4 * 86400_000;
    const cBStart = day0Ms - 1 * 86400_000;
    // conv-cross: 50 calls ($150) in cA + 50 calls ($150) in cB; plus peer calls inside cA/cB establishing exact cycle prices.
    makeHistoryDb(join(crossDir, 'conv-cross.db'), [
      ...mk3(cAStart + 1 * 3600_000, 50, 10),
      ...mk3(cBStart + 1 * 3600_000, 50, 10),
    ]);
    makeHistoryDb(join(crossDir, 'peer-a.db'), mk3(cAStart + 2 * 3600_000, 50, 10)); // cA obs: $300 for 30% => $1,000/cycle
    makeHistoryDb(join(crossDir, 'peer-b.db'), mk3(cBStart + 2 * 3600_000, 150, 10)); // cB obs: $600 for 20% => $3,000/cycle
    const crossCycles = {
      version: 2,
      pools: {
        gemini: [
          {
            cycle_start: new Date(cAStart).toISOString(),
            cycle_start_source: 'explicit',
            reset_time: new Date(cAStart + 7 * 86400_000).toISOString(),
            ended_at: new Date(cBStart).toISOString(),
            first_seen_at: new Date(cAStart).toISOString(),
            observed_at: new Date(cAStart + 4 * 3600_000).toISOString(),
            remaining_fraction: 0.70,
            used_fraction: 0.30,
            observations: [
              { observed_at: new Date(cAStart).toISOString(), remaining_fraction: 1, used_fraction: 0 },
              { observed_at: new Date(cAStart + 4 * 3600_000).toISOString(), remaining_fraction: 0.70, used_fraction: 0.30 },
            ],
          },
          {
            cycle_start: new Date(cBStart).toISOString(),
            cycle_start_source: 'weekly_7d',
            reset_time: new Date(cBStart + 7 * 86400_000).toISOString(),
            first_seen_at: new Date(cBStart).toISOString(),
            observed_at: new Date(cBStart + 4 * 3600_000).toISOString(),
            remaining_fraction: 0.80,
            used_fraction: 0.20,
            observations: [
              { observed_at: new Date(cBStart).toISOString(), remaining_fraction: 1, used_fraction: 0 },
              { observed_at: new Date(cBStart + 4 * 3600_000).toISOString(), remaining_fraction: 0.80, used_fraction: 0.20 },
            ],
          },
        ],
      },
    };
    const rCross = await scan([[crossDir, 'desktop']], { now, quotaCycles: crossCycles });
    const convCross = rCross.by_conversation.find((c) => c.id === 'conv-cross');
    assert.equal(convCross.quota_pct_by_pool.gemini, 20); // $150/$1,000 (15%) + $150/$3,000 (5%) = 20%
    assert.equal(rCross.period_quota.d7.gemini.pct, 50); // 30% + 20%
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ProjectClassification: project_id/config/workspace resolution, cache retention, grouped sessions & list filters', async () => {
  const {
    convProjectKey,
    convProjectLabel,
    hasProjectMetadata,
    matchesQuery,
    renderListBodyHtml,
    renderSessionsBodyHtml,
  } = await import('../sidecars/agy-lens/web/views/history.js');
  const { createTranslator } = await import('../sidecars/agy-lens/web/i18n.js');
  const tZh = createTranslator('zh');
  const tEn = createTranslator('en');

  const dir = mkdtempSync(join(tmpdir(), 'agy-unit-proj-'));
  try {
    const geminiDir = join(dir, 'gemini');
    const appDir = join(geminiDir, 'antigravity');
    const convDir = join(appDir, 'conversations');
    const projCfgDir = join(geminiDir, 'config', 'projects');
    mkdirSync(convDir, { recursive: true });
    mkdirSync(projCfgDir, { recursive: true });

    const pidOfficial = '11111111-1111-4111-8111-111111111111';
    const pidFallback = '22222222-2222-4222-8222-222222222222';
    const pidSidecar = '33333333-3333-4333-8333-333333333333';

    writeFileSync(join(projCfgDir, `${pidOfficial}.json`), JSON.stringify({
      id: pidOfficial,
      name: 'agy-lens',
    }));
    // Internal sidecar project entries must be ignored even if they match a filename.
    writeFileSync(join(projCfgDir, `${pidSidecar}.json`), JSON.stringify({
      id: pidSidecar,
      name: 'agy-lens/agy-lens',
      sidecar: { sidecarId: 'agy-lens/agy-lens' },
    }));

    const day0Ms = new Date(2026, 10, 24, 10, 0, 0).getTime();
    const now = new Date(day0Ms + 6 * 3600_000);
    const cyStart = day0Ms;
    const mk = (startMs, count) => Array.from({ length: count }, (_, i) => hCall(0, {
      ts: Math.floor(startMs / 1000) + i * 20,
      model: 'gemini-4-hydrogen-tiered-high',
      display: 'Gemini 4 Hydrogen (High)',
      input: 200_000,
      output: 360_000, // $3/call
      cache: 0,
    }));

    // 1. Renamed old path & new path sharing pidOfficial -> both classify as "agy-lens".
    makeHistoryDb(join(convDir, 'conv-lens-old.db'), mk(day0Ms + 600_000, 10)); // $30 -> 3%
    makeHistoryDb(join(convDir, 'conv-lens-new.db'), mk(day0Ms + 1200_000, 20)); // $60 -> 6%
    makeHistoryDb(join(convDir, 'conv-lens-sub.db'), mk(day0Ms + 1500_000, 10)); // $30 -> 3% (subagent inheriting project)
    // 2. Fallback project without JSON config -> basename from decoded workspace_uris ("File-Parsing").
    makeHistoryDb(join(convDir, 'conv-ws-only.db'), mk(day0Ms + 2000_000, 20)); // $60 -> 6%
    // 3. Outside-of-project chat -> project_name: null ("未归属项目" / "No project").
    makeHistoryDb(join(convDir, 'conv-outside.db'), mk(day0Ms + 2600_000, 10)); // $30 -> 3%

    makeSummariesDb(join(appDir, 'conversation_summaries.db'), [
      { id: 'conv-lens-old', title: 'Old path task', project_id: pidOfficial, workspace_uris: '["file:///d%3A/Code/Plugin/desktop-context"]' },
      { id: 'conv-lens-new', title: 'New path task', project_id: pidOfficial, workspace_uris: '["file:///d%3A/Code/Plugin/agy-lens"]' },
      { id: 'conv-lens-sub', agent: 'research', parent: 'conv-lens-new', project_id: pidOfficial, workspace_uris: '["file:///d%3A/Code/Plugin/agy-lens"]' },
      { id: 'conv-ws-only', title: 'Parser task', project_id: pidFallback, workspace_uris: '["file:///d%3A/Code/eMaker/%E9%9B%B6%E4%BB%B6%E5%B0%8F%E6%98%93/workflow/File-Parsing"]' },
      { id: 'conv-outside', title: 'Quick question', project_id: 'outside-of-project', workspace_uris: '' },
    ]);

    const cycles = {
      version: 2,
      pools: {
        gemini: [{
          cycle_start: new Date(cyStart).toISOString(),
          cycle_start_source: 'weekly_7d',
          reset_time: new Date(cyStart + 7 * 86400_000).toISOString(),
          first_seen_at: new Date(cyStart).toISOString(),
          observed_at: new Date(day0Ms + 4 * 3600_000).toISOString(),
          remaining_fraction: 0.79,
          used_fraction: 0.21, // $210 total for 21% => $1,000/cycle
          observations: [
            { observed_at: new Date(cyStart).toISOString(), remaining_fraction: 1, used_fraction: 0 },
            { observed_at: new Date(day0Ms + 4 * 3600_000).toISOString(), remaining_fraction: 0.79, used_fraction: 0.21 },
          ],
        }],
      },
    };

    const cachePath = join(dir, 'history-cache.json');
    const r1 = await scan([[convDir, 'desktop']], { now, quotaCycles: cycles, cachePath });
    const byId = new Map(r1.by_conversation.map((c) => [c.id, c]));

    assert.equal(byId.get('conv-lens-old').project_id, pidOfficial);
    assert.equal(byId.get('conv-lens-old').project_name, 'agy-lens');
    assert.equal(byId.get('conv-lens-new').project_name, 'agy-lens');
    assert.equal(byId.get('conv-lens-sub').project_id, pidOfficial);
    assert.equal(byId.get('conv-lens-sub').project_name, 'agy-lens');
    assert.equal(byId.get('conv-ws-only').project_id, pidFallback);
    assert.equal(byId.get('conv-ws-only').project_name, 'File-Parsing');
    assert.equal(byId.get('conv-outside').project_id, 'outside-of-project');
    assert.equal(byId.get('conv-outside').project_name, null);
    assert.equal(convProjectKey(byId.get('conv-outside')), 'outside-of-project');
    assert.equal(convProjectLabel(byId.get('conv-outside'), tZh), '未归属项目');

    // Prune conv-lens-old & summaries DB -> cached archived entry retains project metadata.
    rmSync(join(convDir, 'conv-lens-old.db'));
    rmSync(join(appDir, 'conversation_summaries.db'));
    const rArchived = await scan([[convDir, 'desktop']], { now, quotaCycles: cycles, cachePath });
    const archOld = rArchived.by_conversation.find((c) => c.id === 'conv-lens-old');
    assert.equal(archOld.archived, true);
    assert.equal(archOld.project_id, pidOfficial);
    assert.equal(archOld.project_name, 'agy-lens');

    // Grouped sessions view combines conv-lens-old (3%) + conv-lens-new subtree (6%+3% = 9%) = 12% under "agy-lens".
    assert.equal(hasProjectMetadata(r1), true);
    const groupedZh = renderSessionsBodyHtml(r1, { sessionsGroup: 'project', t: tZh, lang: 'zh' });
    assert.ok(groupedZh.includes('3 个项目'));
    assert.ok(groupedZh.includes('proj-item'));
    assert.ok(groupedZh.includes('agy-lens') && groupedZh.includes('≈ 周额度 12%'));
    assert.ok(groupedZh.includes('File-Parsing') && groupedZh.includes('≈ 周额度 6%'));
    assert.ok(groupedZh.includes('未归属项目') && groupedZh.includes('≈ 周额度 3%'));
    // Expanding single selected project auto-opens its project details card.
    const singleProj = renderSessionsBodyHtml(r1, { sessionsGroup: 'project', sessionsProject: pidFallback, t: tEn, lang: 'en' });
    assert.ok(singleProj.includes(`data-key="proj:${pidFallback}" open`));
    assert.ok(!singleProj.includes('Old path task'));
    // Flat view filters & displays project tag in meta when all projects shown.
    const flatEn = renderSessionsBodyHtml(r1, { sessionsGroup: 'flat', sessionsProject: 'all', t: tEn, lang: 'en' });
    assert.ok(!flatEn.includes('proj-item'));
    assert.ok(flatEn.includes('agy-lens') && flatEn.includes('File-Parsing'));

    // Session list filters by project across default, hideSubagents, and search branches; matchesQuery matches project_name.
    assert.equal(matchesQuery(byId.get('conv-ws-only'), 'file-parsing'), true);
    const listFiltered = renderListBodyHtml(r1, { listProject: pidOfficial, hideSubagents: false, t: tEn, lang: 'en' });
    assert.ok(listFiltered.includes('New path task') && listFiltered.includes('Old path task'));
    assert.ok(!listFiltered.includes('Parser task') && !listFiltered.includes('Quick question'));
    const listSearch = renderListBodyHtml(r1, { listProject: 'all', searchQuery: 'file-parsing', t: tEn, lang: 'en' });
    assert.ok(listSearch.includes('Parser task') && !listSearch.includes('New path task'));

    // Legacy fixtures with no project metadata keep flat chrome cleanly.
    const noProj = {
      ...r1,
      by_conversation: r1.by_conversation.map(({ project_id: _pid, project_name: _pn, ...rest }) => rest),
    };
    assert.equal(hasProjectMetadata(noProj), false);
    const fallbackFlat = renderSessionsBodyHtml(noProj, { sessionsGroup: 'project', t: tEn, lang: 'en' });
    assert.ok(!fallbackFlat.includes('proj-item') && fallbackFlat.includes('top-level conversations'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Quota UI: freshly reset finite limits stay limited, omit no-reset/unlimited labels, and avoid stale prior-cycle spend', async () => {
  const { isUnlimited } = await import('../sidecars/agy-lens/web/format.js');
  const { isUnlimitedPool, poolWeeklyValuationHtml, renderQuotaHtml } = await import('../sidecars/agy-lens/web/views/quota.js');
  const { createTranslator } = await import('../sidecars/agy-lens/web/i18n.js');

  const tZh = createTranslator('zh');
  const tEn = createTranslator('en');

  // 1. isUnlimited & isUnlimitedPool distinguish explicit finite limits at 100% from kind=none / legacy unlimited.
  assert.equal(isUnlimited({ kind: 'weekly', f: 1, reset_time: null }), false);
  assert.equal(isUnlimited({ kind: '5h', f: 1, reset_time: null }), false);
  assert.equal(isUnlimited({ kind: 'none', f: 1, reset_time: null }), true);
  assert.equal(isUnlimited({ kind: '', f: 1, reset_time: null }), true);
  assert.equal(isUnlimited({ kind: 'unknown', f: 1, reset_time: null }), true);

  const resetPool = {
    id: 'claude_gpt',
    category: 'claude_gpt',
    limits: [
      { kind: 'weekly', inferred: false, remaining_fraction: 1, reset_time: null },
      { kind: '5h', inferred: false, remaining_fraction: 1, reset_time: null },
    ],
    models: [{ id: 'claude-opus-5-5-high', display_name: 'Claude Opus 5.5 (High)' }],
    families: [{ id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', levels: ['High'] }],
    hidden_models: [],
  };
  const tabPool = {
    id: 'tab',
    category: 'tab',
    limits: [{ kind: 'none', remaining_fraction: 1, reset_time: null }],
    models: [],
    families: [],
    hidden_models: [],
  };
  assert.equal(isUnlimitedPool(resetPool, 'zh'), false);
  assert.equal(isUnlimitedPool(tabPool, 'zh'), true);

  // 2. renderQuotaHtml places freshly reset pool in limited section, omits unlimited/no-reset, and shows ref value instead of old cycle spend.
  const historyData = {
    weekly_value_usd: { claude_gpt: 45.63 },
    weekly_cycles: {
      claude_gpt: [{
        cycle_start: '2026-11-19T14:00:00Z',
        reset_time: '2026-11-26T22:00:00Z',
        is_current: true,
        used_fraction: 0.993,
        remaining_fraction: 0.007,
        cycle_cost_usd: 45.32,
        weekly_value_usd: 45.63,
      }],
    },
  };
  const htmlZh = renderQuotaHtml({
    data: {
      tier: 'Google AI Ultra',
      fetched_at: '2026-11-26T14:15:00Z',
      pools: [resetPool, tabPool],
    },
    historyData,
    openKeys: new Set(),
    t: tZh,
    lang: 'zh',
  });
  const beforeCycles = htmlZh.split('<section class="wcycles"')[0];
  assert.ok(beforeCycles.includes('Claude / GPT-OSS 模型'));
  assert.ok(!beforeCycles.includes('pool-free'));
  assert.ok(beforeCycles.includes('每周限额 · 已用 0%'));
  assert.ok(beforeCycles.includes('5 小时限额 · 已用 0%'));
  assert.ok(beforeCycles.includes('100%<span class="lbl">剩余</span>'));
  assert.ok(!beforeCycles.includes('不限 · 无重置'));
  assert.ok(!beforeCycles.includes('无重置时间'));
  assert.ok(beforeCycles.includes('参考 ≈ $45.63'));
  assert.ok(!beforeCycles.includes('本周期已花 $45.32'));

  // 3. poolWeeklyValuationHtml with a new reset_time distinct from an older is_current cycle falls back to weeklyPrevRef.
  const valNewResetEn = poolWeeklyValuationHtml(
    'claude_gpt',
    { kind: 'weekly', f: 0.95, reset_time: '2026-12-03T14:00:00Z' },
    historyData,
    tEn,
    'en',
  );
  assert.ok(valNewResetEn.includes('Ref ≈ $45.63'));
  assert.ok(!valNewResetEn.includes('Spent $45.32'));

  // Matching reset_time still renders current cycle valuation.
  const valSameResetEn = poolWeeklyValuationHtml(
    'claude_gpt',
    { kind: 'weekly', f: 0.007, reset_time: '2026-11-26T22:00:00Z' },
    historyData,
    tEn,
    'en',
  );
  assert.ok(valSameResetEn.includes('Spent $45.32'));
  assert.ok(valSameResetEn.includes('Full ≈ $45.63'));
});

test('QuotaCycles: early reset to 100% without reset_time closes active cycle, avoids false prev_reset link, and updates history chart', async () => {
  const { mergeQuotaObservation, normalizeQuotaCycles, WEEK_MS } = await import('../sidecars/agy-lens/lib/quota.mjs');
  const { renderQuotaHtml } = await import('../sidecars/agy-lens/web/views/quota.js');
  const { createTranslator } = await import('../sidecars/agy-lens/web/i18n.js');

  const cycleStartIso = '2026-11-19T14:00:00.000Z';
  const origResetIso = '2026-11-26T14:00:00.000Z';
  const obsIso = '2026-11-24T10:00:00.000Z';
  const earlyResetAtIso = '2026-11-26T06:00:00.000Z';

  // 1. Active used cycle followed by 100% weekly quota with reset_time: null closes the cycle via ended_at.
  const m0 = mergeQuotaObservation(normalizeQuotaCycles(null), {
    fetched_at: obsIso,
    weekly: { claude_gpt: { remaining_fraction: 0.007, reset_time: origResetIso } },
  });
  const m1 = mergeQuotaObservation(m0.ledger, {
    fetched_at: earlyResetAtIso,
    weekly: { claude_gpt: { remaining_fraction: 1, reset_time: null } },
  });
  assert.equal(m1.changed, true);
  const closed = m1.ledger.pools.claude_gpt[0];
  assert.equal(closed.ended_at, earlyResetAtIso);
  assert.equal(closed.remaining_fraction, 0.007);
  assert.equal(closed.observed_at, obsIso);
  assert.equal(closed.cycle_duration_ms, Date.parse(earlyResetAtIso) - Date.parse(cycleStartIso));

  // 2. Repeated 100% + null reset_time polling is idempotent and preserves ended_at across normalizeQuotaCycles.
  const m2 = mergeQuotaObservation(m1.ledger, {
    fetched_at: '2026-11-26T06:05:00.000Z',
    weekly: { claude_gpt: { remaining_fraction: 1, reset_time: null } },
  });
  assert.equal(m2.changed, false);
  assert.equal(m2.ledger.pools.claude_gpt[0].ended_at, earlyResetAtIso);
  const rt = normalizeQuotaCycles(m2.ledger);
  assert.equal(rt.pools.claude_gpt[0].ended_at, earlyResetAtIso);

  // 3. Subsequent cycle starting after original reset_time must NOT link cycle_start to ended cycle's cancelled reset_time.
  const newFirstSeen = '2026-11-26T16:00:00.000Z';
  const newResetIso = '2026-12-03T16:00:00.000Z';
  const m3 = mergeQuotaObservation(rt, {
    fetched_at: newFirstSeen,
    weekly: { claude_gpt: { remaining_fraction: 0.9, reset_time: newResetIso } },
  });
  assert.equal(m3.ledger.pools.claude_gpt.length, 2);
  assert.equal(m3.ledger.pools.claude_gpt[0].cycle_start_source, 'weekly_7d');
  assert.equal(m3.ledger.pools.claude_gpt[0].cycle_duration_ms, WEEK_MS);
  assert.equal(m3.ledger.pools.claude_gpt[1].ended_at, earlyResetAtIso);

  // 4. End-to-end scan() + renderQuotaHtml marks the early-closed cycle as non-current and counts early reset.
  const dir = mkdtempSync(join(tmpdir(), 'agy-unit-early-null-'));
  try {
    const root = join(dir, 'conversations');
    mkdirSync(root);
    const callSec = Math.floor(Date.parse('2026-11-22T12:00:00.000Z') / 1000);
    const lateCallSec = Math.floor(Date.parse('2026-11-26T07:00:00.000Z') / 1000); // after earlyResetAtIso, before origResetIso!
    makeHistoryDb(join(root, 'c.db'), [
      { ts: callSec, model: 'claude-opus-4-6', input: 100_000, output: 100_000, cache: 0 },
      { ts: lateCallSec, model: 'claude-opus-4-6', input: 500_000, output: 500_000, cache: 0 },
    ]);
    const expectedCost = callCostInfo('claude-opus-4-6', 100_000, 100_000, 0)[0];
    const scanNow = new Date('2026-11-26T07:10:00.000Z'); // still before origResetIso!
    const scanned = await scan([[root, 'desktop']], { now: scanNow, quotaCycles: m1.ledger });
    const cyOut = scanned.weekly_cycles.claude_gpt[0];
    assert.equal(cyOut.is_current, false);
    assert.equal(cyOut.ended_at, earlyResetAtIso);
    assert.equal(cyOut.cycle_cost_usd, roundN(expectedCost, 4)); // lateCallSec excluded by ended_at
    assert.equal(cyOut.weekly_value_usd, roundN(expectedCost / 0.993, 2));

    const tZh = createTranslator('zh');
    const qHtml = renderQuotaHtml({
      data: {
        tier: 'Google AI Ultra',
        fetched_at: scanNow.toISOString(),
        pools: [{
          id: 'claude_gpt',
          category: 'claude_gpt',
          limits: [
            { kind: 'weekly', inferred: false, remaining_fraction: 1, reset_time: null },
            { kind: '5h', inferred: false, remaining_fraction: 1, reset_time: null },
          ],
          models: [],
          families: [],
          hidden_models: [],
        }],
      },
      historyData: scanned,
      openKeys: new Set(),
      t: tZh,
      lang: 'zh',
    });
    assert.ok(!qHtml.includes('<span class="wtag">当前</span>'));
    assert.ok(qHtml.includes('提前 1 次'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
