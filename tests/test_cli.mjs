// Tests for bin/cli.mjs (`agy-lens` terminal CLI).
// Run (Node >= 24): node --test tests/test_cli.mjs

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parseArgs, readVersion, runCliMain } from '../bin/cli.mjs';
import { encodeVarint } from '../sidecars/agy-lens/lib/pb.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CLI_PATH = join(ROOT, 'bin', 'cli.mjs');
const UTF8 = new TextEncoder();

function runCli(args = [], envOverrides = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('ANTIGRAVITY_') || key === 'NO_COLOR') {
      delete env[key];
    }
  }
  for (const [k, v] of Object.entries(envOverrides || {})) {
    if (v === undefined || v === null) delete env[k];
    else env[k] = String(v);
  }
  if (process.versions.electron || process.env.ELECTRON_RUN_AS_NODE === '1') {
    env.ELECTRON_RUN_AS_NODE = '1';
  }
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
  });
}

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

function createConvDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(
    'CREATE TABLE steps (idx integer, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0, '
      + 'has_subtrajectory numeric NOT NULL DEFAULT false, metadata blob, error_details blob, permissions blob, '
      + 'task_details blob, render_info blob, step_payload blob, step_format integer NOT NULL DEFAULT 0, PRIMARY KEY (idx));',
  );
  db.exec('CREATE TABLE gen_metadata (idx integer, data blob, size integer NOT NULL DEFAULT 0, PRIMARY KEY (idx));');
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
      timing = new Uint8Array(0),
    } = {}) {
      const cwm = pbMsg(pbField(1, 0), pbField(3, pbMsg(...groups.map((g) => pbField(1, g)))), pbField(4, maxContext));
      const chat = pbMsg(
        pbField(4, usage),
        pbField(9, pbMsg(pbField(2, checkpointIndex), pbField(10, cwm))),
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

test('CLI --help / -h exits 0 and documents supported flags', () => {
  for (const flag of ['--help', '-h']) {
    const r = runCli([flag]);
    assert.equal(r.status, 0, `${flag} exited ${r.status}: ${r.stderr}`);
    for (const tok of ['agy-lens', '--json', '--days', '--db', '--workspace', '--no-color', '--version']) {
      assert.ok(r.stdout.includes(tok), `${flag} output missing ${tok}`);
    }
  }
});

test('CLI --version / -v exits 0 and matches package.json / plugin.json version', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const pj = JSON.parse(readFileSync(join(ROOT, 'plugin.json'), 'utf8'));
  assert.equal(readVersion(), pkg.version);
  for (const flag of ['--version', '-v']) {
    const r = runCli([flag]);
    assert.equal(r.status, 0, `${flag} exited ${r.status}: ${r.stderr}`);
    assert.equal(r.stdout.trim(), pkg.version);
    assert.equal(r.stdout.trim(), pj.version);
  }
});

test('CLI exits 0 cleanly on empty ANTIGRAVITY_GEMINI_DIR in text and --json modes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-cli-empty-'));
  try {
    const geminiDir = join(dir, 'gemini');
    const dataDir = join(dir, 'data');
    mkdirSync(geminiDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });

    const rText = runCli([], {
      ANTIGRAVITY_GEMINI_DIR: geminiDir,
      ANTIGRAVITY_EXECUTABLE_DATA_DIR: dataDir,
    });
    assert.equal(rText.status, 0, `empty text mode exited ${rText.status}: ${rText.stderr}`);
    assert.match(rText.stdout, /Agy Lens/i);
    assert.match(rText.stdout, /No Antigravity conversations found/i);

    const rJson = runCli(['--json'], {
      ANTIGRAVITY_GEMINI_DIR: geminiDir,
      ANTIGRAVITY_EXECUTABLE_DATA_DIR: dataDir,
    });
    assert.equal(rJson.status, 0, `empty --json exited ${rJson.status}: ${rJson.stderr}`);
    assert.equal(rJson.stdout.includes('\x1b['), false);
    const parsed = JSON.parse(rJson.stdout);
    assert.equal(parsed.history.totals.all.calls, 0);
    assert.equal(parsed.report, null);
    assert.equal(parsed.quota.error, 'unavailable');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI summarizes populated desktop + cli DBs and honors --no-color / NO_COLOR', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-cli-pop-'));
  try {
    const geminiDir = join(dir, 'gemini');
    const dataDir = join(dir, 'data');
    const deskDir = join(geminiDir, 'antigravity', 'conversations');
    const cliDir = join(geminiDir, 'antigravity-cli', 'conversations');
    mkdirSync(deskDir, { recursive: true });
    mkdirSync(cliDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });

    const sumDb = new DatabaseSync(join(geminiDir, 'antigravity', 'conversation_summaries.db'));
    sumDb.exec('CREATE TABLE conversation_summaries (conversation_id text, title text, preview text, agent_name text);');
    sumDb.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?)').run('conv-desk', 'Desktop Summary', '', '');
    sumDb.close();

    const nowSec = Math.floor(Date.now() / 1000) - 60;
    const db1 = createConvDb(join(deskDir, 'conv-desk.db'));
    db1.step(14, { metadata: pbTs(nowSec), payloadField: 19, payload: pbField(2, 'Analyze usage') });
    db1.step(15, { metadata: pbTs(nowSec + 2), payloadField: 20, payload: pbField(1, 'Done') });
    db1.generation({
      groups: [pbGroup(1, 1200), pbGroup(7, 300, [['14: USER_INPUT', 300]])],
      usage: pbUsage({ inp: 2000, out: 500, cache: 1000 }),
      model: 'claude-opus-4-6',
      displayName: 'Claude Opus 4.6',
      timing: pbTiming([1, 500_000_000], [2, 0]),
    });
    db1.close();

    const db2 = createConvDb(join(cliDir, 'conv-cli.db'));
    db2.step(15, { metadata: pbTs(nowSec + 1), payloadField: 20, payload: pbField(1, 'CLI reply') });
    db2.generation({
      usage: pbUsage({ inp: 800, out: 200, cache: 100 }),
      model: 'gemini-2.5-pro',
      displayName: 'Gemini 2.5 Pro',
    });
    db2.close();

    const baseEnv = {
      ANTIGRAVITY_GEMINI_DIR: geminiDir,
      ANTIGRAVITY_EXECUTABLE_DATA_DIR: dataDir,
    };

    const rText = runCli(['--no-color'], baseEnv);
    assert.equal(rText.status, 0, `text mode failed: ${rText.stderr}`);
    assert.equal(rText.stdout.includes('\x1b['), false);
    assert.match(rText.stdout, /Claude Opus 4\.6/);
    assert.match(rText.stdout, /Gemini 2\.5 Pro/);
    assert.match(rText.stdout, /offline/i);

    const rNoColorEnv = runCli([], { ...baseEnv, NO_COLOR: '1' });
    assert.equal(rNoColorEnv.status, 0);
    assert.equal(rNoColorEnv.stdout.includes('\x1b['), false);

    const rJson = runCli(['--json'], baseEnv);
    assert.equal(rJson.status, 0, `--json failed: ${rJson.stderr}`);
    assert.equal(rJson.stdout.includes('\x1b['), false);
    const parsed = JSON.parse(rJson.stdout);
    assert.equal(parsed.history.totals.all.calls, 2);
    assert.equal(parsed.history.sources.desktop, 1);
    assert.equal(parsed.history.sources.cli, 1);
    assert.ok(parsed.history.by_model.length >= 2);
    assert.ok(parsed.report && typeof parsed.report.used_tokens === 'number');
    assert.equal(parsed.quota.error, 'unavailable');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI --days <N> filters daily series and period totals', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-cli-days-'));
  try {
    const geminiDir = join(dir, 'gemini');
    const dataDir = join(dir, 'data');
    const deskDir = join(geminiDir, 'antigravity', 'conversations');
    mkdirSync(deskDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });

    const nowSec = Math.floor(Date.now() / 1000) - 60;
    const oldSec = nowSec - 15 * 86400;

    const dbNew = createConvDb(join(deskDir, 'recent.db'));
    dbNew.step(14, { metadata: pbTs(nowSec), payloadField: 19, payload: pbField(2, 'Recent') });
    dbNew.step(15, { metadata: pbTs(nowSec), payloadField: 20, payload: pbField(1, 'Recent reply') });
    dbNew.generation({ usage: pbUsage({ inp: 1000, out: 200 }) });
    dbNew.close();

    const dbOld = createConvDb(join(deskDir, 'old.db'));
    dbOld.step(14, { metadata: pbTs(oldSec), payloadField: 19, payload: pbField(2, 'Old') });
    dbOld.step(15, { metadata: pbTs(oldSec), payloadField: 20, payload: pbField(1, 'Old reply') });
    dbOld.generation({ usage: pbUsage({ inp: 5000, out: 500 }) });
    dbOld.close();

    const r = runCli(['--json', '--days=7'], {
      ANTIGRAVITY_GEMINI_DIR: geminiDir,
      ANTIGRAVITY_EXECUTABLE_DATA_DIR: dataDir,
    });
    assert.equal(r.status, 0, `--days=7 failed: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.history.daily.length, 7);
    assert.equal(parsed.history.totals.d7.calls, 1);
    assert.equal(parsed.history.totals.all.calls, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI --db <path> --workspace <uri> inspects a specific DB in JSON and text modes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-cli-db-'));
  try {
    const geminiDir = join(dir, 'gemini');
    const dataDir = join(dir, 'data');
    const wsDir = join(dir, 'workspace');
    mkdirSync(geminiDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(join(wsDir, '.agents', 'rules'), { recursive: true });
    writeFileSync(join(wsDir, '.agents', 'rules', 'guide.md'), '# rule\n', 'utf8');

    const dbPath = join(dir, 'single-conv.db');
    const db = createConvDb(dbPath);
    db.step(14, { payloadField: 19, payload: pbField(2, 'Check context') });
    db.generation({
      groups: [pbGroup(1, 1000), pbGroup(7, 400, [['14: USER_INPUT', 400]])],
      usage: pbUsage({ inp: 1000, out: 250, cache: 500 }),
    });
    db.close();

    const wsUri = pathToFileURL(wsDir).href;
    const baseEnv = {
      ANTIGRAVITY_GEMINI_DIR: geminiDir,
      ANTIGRAVITY_EXECUTABLE_DATA_DIR: dataDir,
    };

    const rJson = runCli(['--json', '--db', dbPath, '--workspace', wsUri], baseEnv);
    assert.equal(rJson.status, 0, `--db --json failed: ${rJson.stderr}`);
    assert.equal(rJson.stdout.includes('\x1b['), false);
    const rep = JSON.parse(rJson.stdout);
    assert.equal(rep.used_tokens, 1400);
    assert.equal(rep.limit_tokens, 250_000);
    assert.equal(rep.session.calls, 1);
    assert.ok(rep.system_files.some((f) => f.path === '.agents/rules/'));

    const rText = runCli(['--db', dbPath, '--workspace', wsUri, '--no-color'], baseEnv);
    assert.equal(rText.status, 0, `--db text failed: ${rText.stderr}`);
    assert.match(rText.stdout, /Claude Opus 4\.6/);
    assert.match(rText.stdout, /Session:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI rejects invalid arguments and missing --db cleanly without stack traces', () => {
  const missingDb = join(tmpdir(), 'agy-lens-does-not-exist-99999.db');
  const rMissing = runCli(['--db', missingDb]);
  assert.notEqual(rMissing.status, 0);
  assert.ok(rMissing.stderr.trim().length > 0);
  assert.equal(/\bat\s+\S+\s+\(.*:\d+:\d+\)/.test(rMissing.stderr), false);

  for (const badArgs of [
    ['--unknown-flag'],
    ['positional-arg'],
    ['--days', 'abc'],
    ['--days', '0'],
    ['--days=-5'],
    ['--days'],
    ['--db'],
    ['--workspace'],
  ]) {
    const r = runCli(badArgs);
    assert.notEqual(r.status, 0, `Expected non-zero for ${badArgs.join(' ')}`);
    assert.ok(r.stderr.trim().length > 0);
    assert.equal(/\bNaN\b/.test(r.stdout), false);
    assert.equal(/\bat\s+\S+\s+\(.*:\d+:\d+\)/.test(r.stderr), false);
  }

  assert.throws(() => parseArgs(['--days', 'abc']), /Invalid value for --days/);
  assert.deepEqual(parseArgs(['--json', '--days', '14', '--no-color']).days, 14);
});

test('bin/cli.mjs starts with Node shebang and matches package.json bin', () => {
  const firstLine = readFileSync(CLI_PATH, 'utf8').split(/\r?\n/)[0];
  assert.equal(firstLine, '#!/usr/bin/env node');
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.bin['agy-lens'], 'bin/cli.mjs');
});

test('CLI renders quota reset_time, loads quota-cycles weekly_value_usd, and rolls up subagents', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-cli-quota-sub-'));
  const origReq = http.request;
  const origWrite = process.stdout.write.bind(process.stdout);
  const prevEnv = {
    ANTIGRAVITY_GEMINI_DIR: process.env.ANTIGRAVITY_GEMINI_DIR,
    ANTIGRAVITY_EXECUTABLE_DATA_DIR: process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR,
    ANTIGRAVITY_LS_ADDRESS: process.env.ANTIGRAVITY_LS_ADDRESS,
    ANTIGRAVITY_CSRF_TOKEN: process.env.ANTIGRAVITY_CSRF_TOKEN,
    NO_COLOR: process.env.NO_COLOR,
  };
  try {
    const geminiDir = join(dir, 'gemini');
    const dataDir = join(dir, 'data');
    const deskDir = join(geminiDir, 'antigravity', 'conversations');
    mkdirSync(deskDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });

    const nowMs = Date.now();
    const nowSec = Math.floor(nowMs / 1000) - 120;
    const weeklyReset = new Date(nowMs + 4 * 86400_000).toISOString();
    const sumDb = new DatabaseSync(join(geminiDir, 'antigravity', 'conversation_summaries.db'));
    sumDb.exec("CREATE TABLE conversation_summaries (conversation_id text PRIMARY KEY, title text NOT NULL DEFAULT '', preview text NOT NULL DEFAULT '', agent_name text NOT NULL DEFAULT '', parent_conversation_id text NOT NULL DEFAULT '')");
    sumDb.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?)').run('parent-conv', 'Parent Task', '', '', '');
    sumDb.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?)').run('child-conv', '', '', 'research', 'parent-conv');
    sumDb.close();

    const pDb = join(deskDir, 'parent-conv.db');
    const dbP = createConvDb(pDb);
    dbP.step(14, { metadata: pbTs(nowSec), payloadField: 19, payload: pbField(2, 'Build feature') });
    dbP.step(15, { metadata: pbTs(nowSec + 1), payloadField: 20, payload: pbField(1, 'Done') });
    dbP.generation({ usage: pbUsage({ inp: 100000, out: 10000 }), model: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro' });
    dbP.close();

    const cDb = join(deskDir, 'child-conv.db');
    const dbC = createConvDb(cDb);
    dbC.step(15, { metadata: pbTs(nowSec + 2), payloadField: 20, payload: pbField(1, 'Sub reply') });
    dbC.generation({ usage: pbUsage({ inp: 50000, out: 5000 }), model: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro' });
    dbC.close();

    // Stub http.request in-process so Windows sandbox TCP restrictions do not block mock LS RPCs.
    http.request = (opts, cb) => {
      const req = new EventEmitter();
      req.end = () => {
        const res = new EventEmitter();
        res.statusCode = 200;
        let payload;
        if (String(opts.path).endsWith('/GetAvailableModels')) {
          payload = {
            models: {
              'gemini-2.5-pro': {
                displayName: 'Gemini 2.5 Pro',
                maxTokens: 1048576,
                modelProvider: 'MODEL_PROVIDER_GOOGLE',
                quotaInfo: { remainingFraction: 0.75, resetTime: weeklyReset },
              },
            },
            agentModelSorts: [{ groups: [{ modelIds: ['gemini-2.5-pro'] }] }],
          };
        } else if (String(opts.path).endsWith('/RetrieveUserQuotaSummary')) {
          payload = {
            groups: [{
              displayName: 'Gemini Models',
              buckets: [
                { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.75, resetTime: weeklyReset },
                { bucketId: 'gemini-5h', window: '5h', remainingFraction: 1, resetTime: new Date(nowMs + 5 * 3600_000).toISOString() },
              ],
            }],
          };
        } else {
          payload = { userStatus: { planStatus: { planInfo: { planName: 'Pro' } } } };
        }
        queueMicrotask(() => {
          cb(res);
          res.emit('data', JSON.stringify(payload));
          res.emit('end');
        });
      };
      req.destroy = () => {};
      return req;
    };

    process.env.ANTIGRAVITY_GEMINI_DIR = geminiDir;
    process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR = dataDir;
    process.env.ANTIGRAVITY_LS_ADDRESS = 'http://127.0.0.1:19999';
    process.env.ANTIGRAVITY_CSRF_TOKEN = 'test-csrf';
    process.env.NO_COLOR = '1';

    let textOut = '';
    process.stdout.write = (chunk) => { textOut += String(chunk); return true; };
    const codeText = await runCliMain(['--no-color']);
    process.stdout.write = origWrite;
    assert.equal(codeText, 0);
    assert.ok(textOut.includes(`resets ${weeklyReset}`), `Expected reset_time in CLI output:\n${textOut}`);
    assert.ok(textOut.includes('weekly 75.0%') && textOut.includes('5h 100.0%'), `Expected both weekly and 5h limits in CLI output:\n${textOut}`);

    // First single <=7d poll infers weekly_7d cycle_start and populates weekly_value_usd immediately.
    const env = {
      ANTIGRAVITY_GEMINI_DIR: geminiDir,
      ANTIGRAVITY_EXECUTABLE_DATA_DIR: dataDir,
    };
    const rFirst = runCli(['--json'], env);
    assert.equal(rFirst.status, 0, rFirst.stderr);
    const parsedFirst = JSON.parse(rFirst.stdout);
    assert.equal(parsedFirst.history.weekly_cycles.gemini[0].cycle_start_source, 'weekly_7d');
    assert.ok(parsedFirst.history.weekly_value_usd.gemini > 0);

    // Seed a prior reset cycle (so consecutive reset timestamps take precedence with prev_reset) + cached update notice.
    const cyclesPath = join(dataDir, 'quota-cycles.json');
    const cyclesJson = JSON.parse(readFileSync(cyclesPath, 'utf8'));
    const prevResetIso = new Date(nowMs - 3 * 86400_000).toISOString();
    cyclesJson.pools.gemini.push({
      cycle_start: null,
      cycle_start_source: 'unknown',
      reset_time: prevResetIso,
      first_seen_at: new Date(nowMs - 6 * 86400_000).toISOString(),
      observed_at: new Date(nowMs - 4 * 86400_000).toISOString(),
      remaining_fraction: 0.5,
      used_fraction: 0.5,
      saturated: false,
      obs_count: 1,
    });
    writeFileSync(cyclesPath, JSON.stringify(cyclesJson));
    writeFileSync(join(dataDir, 'update-cache.json'), JSON.stringify({
      latest_version: '9.9.9',
      release_url: 'https://github.com/Aoike123/agy-lens/releases/tag/v9.9.9',
      checked_at: new Date().toISOString(),
      source: 'github_release',
    }));

    const rJson = runCli(['--json'], env);
    assert.equal(rJson.status, 0, rJson.stderr);
    const parsed = JSON.parse(rJson.stdout);
    assert.equal(parsed.history.weekly_cycles.gemini[0].cycle_start_source, 'prev_reset');
    assert.ok(parsed.history.weekly_value_usd.gemini > 0, 'Expected CLI history to populate weekly_value_usd from consecutive reset cycle');
    assert.equal(parsed.history.totals.all.conversations, 1, 'Expected top-level conversation tree count = 1');
    assert.deepEqual(Object.keys(parsed).sort(), ['history', 'quota', 'report']);

    const rUpdText = runCli(['--no-color'], env);
    assert.equal(rUpdText.status, 0, rUpdText.stderr);
    assert.ok(rUpdText.stdout.includes('Update available:') && rUpdText.stdout.includes('v9.9.9'));

    const rDb = runCli(['--json', '--db', pDb], env);
    assert.equal(rDb.status, 0, rDb.stderr);
    const dbRep = JSON.parse(rDb.stdout);
    assert.equal(dbRep.session.input, 150000);
    assert.equal(dbRep.session.subagents, 1);
    assert.equal(dbRep.session.self.input, 100000);
  } finally {
    http.request = origReq;
    process.stdout.write = origWrite;
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
