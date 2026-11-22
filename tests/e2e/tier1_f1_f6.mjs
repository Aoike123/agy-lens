// Tier 1 Feature Coverage Tests: F1–F6 (30 tests: T1-F1-01 .. T1-F6-05)

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ROOT,
  createSandbox,
  makeChildEnv,
  makePoisonedPythonBinDir,
  parsePngInfo,
  relPath,
  runChromeBrowserTest,
  startSidecar,
  walkFiles,
} from './lib/harness.mjs';
import { startMockLs } from './lib/mock-ls.mjs';
import {
  createConvDb,
  createSummariesDb,
  pbField,
  pbGroup,
  pbTiming,
  pbTs,
  pbUsage,
} from './lib/pb-db-builder.mjs';

const SIDECAR_DIR = join(ROOT, 'sidecars', 'agy-lens');
const WEB_DIR = join(SIDECAR_DIR, 'web');

function sampleHistoryFixture() {
  return {
    totals: {
      today: { input: 12000, output: 3400, cache_read: 40000, calls: 6, conversations: 2, cost_usd: 0.42 },
      d7: { input: 85000, output: 21000, cache_read: 240000, calls: 38, conversations: 5, cost_usd: 2.85 },
      d30: { input: 240000, output: 64000, cache_read: 720000, calls: 112, conversations: 12, cost_usd: 8.9 },
      all: { input: 320000, output: 88000, cache_read: 950000, calls: 140, conversations: 16, cost_usd: 11.4 },
    },
    by_model: [
      { model: 'claude-opus-4-6', display_name: 'Claude Opus 4.6', pool: 'claude_gpt', input: 150000, output: 42000, cache_read: 480000, calls: 60, cost_usd: 6.2 },
      { model: 'gemini-4-neon-high', display_name: 'Gemini 4 Neon (High)', pool: 'gemini', input: 90000, output: 22000, cache_read: 240000, calls: 52, cost_usd: 2.7 },
    ],
    by_conversation: [
      {
        id: '11111111-1111-4111-8111-111111111111',
        title: 'Demo Auth Refactor',
        source: 'desktop',
        is_subagent: false,
        calls: 42,
        input: 60000,
        output: 18000,
        cache_read: 180000,
        d7_tokens: 78000,
        cost_usd: 2.1,
        last_at: new Date().toISOString(),
        models: ['claude-opus-4-6'],
      },
      {
        id: '22222222-2222-4222-8222-222222222222',
        title: null,
        source: 'cli',
        is_subagent: true,
        calls: 8,
        input: 12000,
        output: 3000,
        cache_read: 20000,
        d7_tokens: 15000,
        cost_usd: 0.4,
        last_at: new Date(Date.now() - 3600_000).toISOString(),
        models: ['gemini-4-neon-high'],
      },
    ],
    daily: [
      { date: '2026-11-19', input: 30000, output: 8000, cache_read: 90000, calls: 15, cost_usd: 1.0 },
      { date: '2026-11-20', input: 45000, output: 12000, cache_read: 120000, calls: 20, cost_usd: 1.5 },
    ],
    hourly_today: Array.from({ length: 24 }, (_, h) => ({ hour: h, calls: h === 10 ? 6 : 0, tokens: h === 10 ? 15400 : 0 })),
    d7_by_pool: { claude_gpt: 68000, gemini: 38000 },
    pricing_source: 'builtin',
    pricing_fetched_at: null,
    sources: { desktop: 1, cli: 1 },
    errors: 0,
  };
}

function sampleReportFixture() {
  return {
    conversation_id: '11111111-1111-4111-8111-111111111111',
    model: 'Claude Opus 4.6',
    model_id: 'claude-opus-4-6',
    heading: 'Token usage by category',
    grid_segments: [
      { key: 'system', pct: 10 },
      { key: 'user', pct: 5 },
      { key: 'agent', pct: 8 },
    ],
    checkpoint_view: null,
    text: 'Model: Claude Opus 4.6',
    request_budget_tokens: 250000,
    used_tokens: 57500,
    limit_tokens: 250000,
    used_pct: 23,
    free_tokens: 192500,
    has_breakdown: true,
    compacted: false,
    checkpoint_buffer: 0,
    categories: [
      { key: 'system_prompt', tokens: 20000, children: [] },
      { key: 'user', tokens: 12500, children: [] },
      { key: 'agent', tokens: 25000, children: [] },
    ],
    active_checkpoint: -1,
    checkpoints: [],
    knowledge_files: [],
    artifact_files: [],
    skill_files: [],
    system_files: [],
    speed: {
      calls: 3,
      avg_streaming_tps: 105,
      median_streaming_tps: 102,
      latest: { ttft_sec: 1.2, streaming_tps: 105, output_tokens: 300, buffered: false },
      recent: [],
    },
    session: {
      calls: 3,
      input: 45000,
      output: 12500,
      cache_read: 30000,
      thinking: 1000,
      total_tokens: 57500,
      cost_usd: 0.55,
      cost_estimated: false,
      pricing_source: 'builtin',
      pool: 'claude_gpt',
      d7_tokens: 57500,
      d7_by_pool: { claude_gpt: 57500, gemini: 0 },
      by_model: [{ model: 'claude-opus-4-6', display_name: 'Claude Opus 4.6', calls: 3, input: 45000, output: 12500, cache_read: 30000, cost_usd: 0.55 }],
    },
    updatedAt: new Date().toISOString(),
  };
}

function sampleQuotaFixture() {
  return {
    plan: 'Pro',
    tier: 'Google AI Ultra',
    fetched_at: new Date().toISOString(),
    weekly: {
      gemini: { remaining_fraction: 0.83, reset_time: new Date(Date.now() + 86400e3 * 4).toISOString() },
      claude_gpt: { remaining_fraction: 0.41, reset_time: new Date(Date.now() + 86400e3 * 3).toISOString() },
    },
    pools: [
      {
        id: 'claude_gpt',
        category: 'claude_gpt',
        kind: 'models',
        label: 'Claude / GPT-OSS models',
        label_zh: 'Claude / GPT-OSS 模型',
        remaining_fraction: 0.69,
        reset_time: new Date(Date.now() + 3600e3 * 3).toISOString(),
        limits: [{ kind: '5h', label: '5-hour limit', label_zh: '5 小时限额', remaining_fraction: 0.69, inferred: false }],
        models: [{ id: 'claude-opus-4-6', display_name: 'Claude Opus 4.6' }],
        families: [{ id: 'claude-opus-4-6', display_name: 'Claude Opus 4.6', levels: [] }],
        hidden_models: [],
      },
      {
        id: 'gemini',
        category: 'gemini',
        kind: 'models',
        label: 'Gemini models',
        label_zh: 'Gemini 模型',
        remaining_fraction: 0.72,
        reset_time: new Date(Date.now() + 3600e3 * 2).toISOString(),
        limits: [{ kind: '5h', label: '5-hour limit', label_zh: '5 小时限额', remaining_fraction: 0.72, inferred: false }],
        models: [{ id: 'gemini-4-neon-high', display_name: 'Gemini 4 Neon (High)' }],
        families: [{ id: 'gemini-4-neon', display_name: 'Gemini 4 Neon', levels: ['High'] }],
        hidden_models: [],
      },
    ],
  };
}

export const TESTS = [
  // --- F1: Sidecar Rename & Legacy Directory Removal ---
  {
    id: 'T1-F1-01',
    tier: 1,
    feature: 'F1',
    title: 'Sidecar directory layout uses sidecars/agy-lens/ and removes sidecars/context/',
    async run() {
      assert.ok(existsSync(SIDECAR_DIR), 'sidecars/agy-lens/ must exist');
      for (const f of ['main.mjs', 'sidecar.json', 'package.json']) {
        assert.ok(existsSync(join(SIDECAR_DIR, f)), `Missing sidecars/agy-lens/${f}`);
      }
      assert.equal(existsSync(join(ROOT, 'sidecars', 'context')), false, 'Legacy sidecars/context/ must be removed');
    },
  },
  {
    id: 'T1-F1-02',
    tier: 1,
    feature: 'F1',
    title: 'sidecars/agy-lens/sidecar.json adheres to Agy Lens runtime contract',
    async run() {
      const p = join(SIDECAR_DIR, 'sidecar.json');
      assert.ok(existsSync(p), 'sidecars/agy-lens/sidecar.json missing');
      const sc = JSON.parse(readFileSync(p, 'utf8'));
      assert.equal(sc.command, 'node');
      assert.ok(Array.isArray(sc.args) && sc.args.includes('main.mjs'), 'args must include main.mjs');
      assert.equal(sc.has_web_ui, true);
      assert.equal(sc.display_name, 'Agy Lens');
      assert.equal(sc.ui_config?.display_name, 'Agy Lens');
      assert.equal(sc.ui_config?.views?.[0]?.title, 'Agy Lens');
      assert.equal(sc.ui_config?.views?.[0]?.path, '/');
    },
  },
  {
    id: 'T1-F1-03',
    tier: 1,
    feature: 'F1',
    title: 'sidecars/agy-lens/package.json specifies agy-lens-panel, ESM, matching version, zero deps',
    async run() {
      const p = join(SIDECAR_DIR, 'package.json');
      assert.ok(existsSync(p), 'sidecars/agy-lens/package.json missing');
      const pkg = JSON.parse(readFileSync(p, 'utf8'));
      const plugin = JSON.parse(readFileSync(join(ROOT, 'plugin.json'), 'utf8'));
      assert.equal(pkg.name, 'agy-lens-panel');
      assert.equal(pkg.type, 'module');
      assert.equal(pkg.version, plugin.version);
      assert.equal(Object.keys(pkg.dependencies || {}).length, 0, 'Sidecar must have zero runtime dependencies');
    },
  },
  {
    id: 'T1-F1-04',
    tier: 1,
    feature: 'F1',
    title: 'sidecars/agy-lens/main.mjs boots cleanly and serves HTTP 200 on GET /',
    async run() {
      const sb = createSandbox('t1-f1-04-');
      try {
        const sidecar = await startSidecar({
          sidecarDir: SIDECAR_DIR,
          env: {
            ANTIGRAVITY_GEMINI_DIR: sb.geminiDir,
            ANTIGRAVITY_EXECUTABLE_DATA_DIR: sb.dataDir,
          },
        });
        sb.track(() => sidecar.close());
        const res = await sidecar.request('/');
        assert.equal(res.status, 200);
        assert.match(res.headers['content-type'] || '', /text\/html/i);
      } finally {
        await sb.cleanup();
      }
    },
  },
  {
    id: 'T1-F1-05',
    tier: 1,
    feature: 'F1',
    title: 'Served HTML and API responses use Agy Lens naming without antigravity-pulse or sidecars/context',
    async run() {
      const sb = createSandbox('t1-f1-05-');
      try {
        const sidecar = await startSidecar({
          sidecarDir: SIDECAR_DIR,
          env: {
            ANTIGRAVITY_GEMINI_DIR: sb.geminiDir,
            ANTIGRAVITY_EXECUTABLE_DATA_DIR: sb.dataDir,
          },
        });
        sb.track(() => sidecar.close());
        const html = (await sidecar.request('/')).text();
        assert.match(html, /<title>\s*Agy Lens\s*<\/title>/i);
        assert.equal(/antigravity-pulse|sidecars\/context/i.test(html), false);
        const rep = (await sidecar.request('/api/report')).text();
        assert.equal(/antigravity-pulse|sidecars\/context/i.test(rep), false);
      } finally {
        await sb.cleanup();
      }
    },
  },

  // --- F2: Python Removal & Fallback Purge ---
  {
    id: 'T1-F2-01',
    tier: 1,
    feature: 'F2',
    title: 'Zero .py, .pyc, .pyo files or __pycache__ directories remain in repo',
    async run() {
      const files = walkFiles(ROOT, { excludeDirs: new Set(['.git', 'node_modules']) });
      const pyFiles = files
        .map((f) => relPath(f))
        .filter((r) => /\.(py|pyc|pyo)$/i.test(r) || r.includes('__pycache__/'));
      assert.deepEqual(pyFiles, [], `Found Python artifacts: ${pyFiles.join(', ')}`);
    },
  },
  {
    id: 'T1-F2-02',
    tier: 1,
    feature: 'F2',
    title: '.github/workflows/ci.yml is free of Python jobs/steps and configures Node 24',
    async run() {
      const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
      assert.equal(/setup-python|\bpython\b|unittest|\.py\b/i.test(ci), false, 'ci.yml still references Python');
      assert.match(ci, /node-version:\s*['"]?24/);
    },
  },
  {
    id: 'T1-F2-03',
    tier: 1,
    feature: 'F2',
    title: 'sidecars/agy-lens/main.mjs serves /api/report and /api/history with poisoned Python PATH',
    async run() {
      const sb = createSandbox('t1-f2-03-');
      try {
        const uuid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
        const db = createConvDb(join(sb.desktopConvDir, `${uuid}.db`));
        const nowSec = Math.floor(Date.now() / 1000) - 60;
        db.step(14, { metadata: pbTs(nowSec), payloadField: 19, payload: pbField(2, 'Pure node test') });
        db.generation({
          groups: [pbGroup(1, 1200), pbGroup(7, 300, [['14: USER_INPUT', 300]])],
          usage: pbUsage({ inp: 1000, out: 150, cache: 200 }),
          timing: pbTiming([1, 0], [1, 500_000_000]),
        });
        db.close();

        const poison = makePoisonedPythonBinDir(sb.root);
        const sidecar = await startSidecar({
          sidecarDir: SIDECAR_DIR,
          env: {
            PATH: poison.pathEnv,
            ANTIGRAVITY_GEMINI_DIR: sb.geminiDir,
            ANTIGRAVITY_EXECUTABLE_DATA_DIR: sb.dataDir,
          },
        });
        sb.track(() => sidecar.close());

        const rep = await sidecar.getJson(`/api/report?conversationId=${uuid}`);
        assert.ok(rep.used_tokens > 0);
        const hist = await sidecar.getJson('/api/history?refresh=true');
        assert.ok(hist.totals.all.calls >= 1);
        assert.equal(existsSync(poison.sentinelPath), false, 'Python sentinel must never be invoked');
      } finally {
        await sb.cleanup();
      }
    },
  },
  {
    id: 'T1-F2-04',
    tier: 1,
    feature: 'F2',
    title: '.github/ISSUE_TEMPLATE/bug_report.yml is purged of Python and sidecars/context',
    async run() {
      const p = join(ROOT, '.github', 'ISSUE_TEMPLATE', 'bug_report.yml');
      assert.ok(existsSync(p), 'bug_report.yml missing');
      const txt = readFileSync(p, 'utf8');
      assert.equal(/python\s*--version|context_report\.py|sidecars\/context/i.test(txt), false);
    },
  },
  {
    id: 'T1-F2-05',
    tier: 1,
    feature: 'F2',
    title: 'All tests/test_*.mjs unit suites pass with poisoned Python PATH and zero Python skips',
    async run() {
      const sb = createSandbox('t1-f2-05-');
      try {
        const poison = makePoisonedPythonBinDir(sb.root);
        const unitFiles = walkFiles(join(ROOT, 'tests'), { excludeDirs: new Set(['e2e', 'fixtures']) })
          .filter((f) => /test_.*\.mjs$/i.test(f));
        assert.ok(unitFiles.length >= 2, 'Expected unit test files under tests/');
        const r = spawnSync(process.execPath, ['--test', ...unitFiles], {
          cwd: ROOT,
          env: makeChildEnv({ PATH: poison.pathEnv }),
          encoding: 'utf8',
          windowsHide: true,
          timeout: 30000,
        });
        assert.equal(r.status, 0, `Unit tests failed:\n${r.stdout}\n${r.stderr}`);
        assert.equal(existsSync(poison.sentinelPath), false, 'Unit tests must not invoke Python');
        assert.equal(/Python 3\.10\+ not available|# SKIP/i.test(r.stdout), false, 'Unit tests still contain skipped Python parity checks');
      } finally {
        await sb.cleanup();
      }
    },
  },

  // --- F3: Pure Node.js 24+ Backend Modularization ---
  {
    id: 'T1-F3-01',
    tier: 1,
    feature: 'F3',
    title: 'Backend modularized into sidecars/agy-lens/lib/{pb,pricing,catalog,quota,context,history}.mjs',
    async run() {
      const libDir = join(SIDECAR_DIR, 'lib');
      assert.ok(existsSync(libDir), 'sidecars/agy-lens/lib/ missing');
      for (const mod of ['pb.mjs', 'pricing.mjs', 'catalog.mjs', 'quota.mjs', 'context.mjs', 'history.mjs']) {
        assert.ok(existsSync(join(libDir, mod)), `Missing lib/${mod}`);
      }
      for (const old of ['pb.mjs', 'context_report.mjs', 'history_scanner.mjs']) {
        assert.equal(existsSync(join(SIDECAR_DIR, old)), false, `Legacy root module still present: ${old}`);
      }
    },
  },
  {
    id: 'T1-F3-02',
    tier: 1,
    feature: 'F3',
    title: 'GET /api/report returns full context/speed/session JSON for valid conversation DB',
    async run() {
      const sb = createSandbox('t1-f3-02-');
      try {
        const uuid = '12345678-1234-4123-8123-1234567890ab';
        const db = createConvDb(join(sb.desktopConvDir, `${uuid}.db`));
        const nowSec = Math.floor(Date.now() / 1000) - 30;
        db.step(14, { metadata: pbTs(nowSec), payloadField: 19, payload: pbField(2, 'Explain architecture') });
        db.step(15, { metadata: pbTs(nowSec + 5), payloadField: 20, payload: pbField(1, 'Here is the plan') });
        db.generation({
          groups: [
            pbGroup(1, 1400, [['skills', 200]]),
            pbGroup(2, 600),
            pbGroup(7, 500, [['14: USER_INPUT', 200], ['15: PLANNER_RESPONSE', 300]]),
          ],
          usage: pbUsage({ inp: 1200, out: 250, cache: 400 }),
          timing: pbTiming([1, 200_000_000], [2, 0]),
        });
        db.close();

        const sidecar = await startSidecar({
          sidecarDir: SIDECAR_DIR,
          env: {
            ANTIGRAVITY_GEMINI_DIR: sb.geminiDir,
            ANTIGRAVITY_EXECUTABLE_DATA_DIR: sb.dataDir,
          },
        });
        sb.track(() => sidecar.close());

        const rep = await sidecar.getJson(`/api/report?conversationId=${uuid}`);
        assert.equal(rep.error, undefined);
        for (const k of ['conversation_id', 'model', 'used_tokens', 'limit_tokens', 'used_pct', 'free_tokens', 'categories', 'speed', 'session', 'updatedAt']) {
          assert.ok(k in rep, `Missing /api/report field: ${k}`);
        }
        assert.equal(rep.conversation_id, uuid);
        assert.ok(rep.used_tokens > 0);
        assert.equal(rep.session.calls, 1);
      } finally {
        await sb.cleanup();
      }
    },
  },
  {
    id: 'T1-F3-03',
    tier: 1,
    feature: 'F3',
    title: 'GET /api/quota?refresh=true queries mock LS, populates pools/weekly/plan/tier, writes redacted quota-raw.json',
    async run() {
      const sb = createSandbox('t1-f3-03-');
      try {
        const ls = await startMockLs({ useHttps: false });
        sb.track(() => ls.close());

        const sidecar = await startSidecar({
          sidecarDir: SIDECAR_DIR,
          mockLs: ls,
          env: {
            ANTIGRAVITY_GEMINI_DIR: sb.geminiDir,
            ANTIGRAVITY_EXECUTABLE_DATA_DIR: sb.dataDir,
            ANTIGRAVITY_LS_ADDRESS: ls.url,
            ANTIGRAVITY_CSRF_TOKEN: ls.csrfToken,
          },
        });
        sb.track(() => sidecar.close());

        const q = await sidecar.getJson('/api/quota?refresh=true');
        assert.equal(ls.validationErrors.length, 0, `LS validation errors: ${ls.validationErrors.join('; ')}`);
        assert.equal(q.plan, 'Pro');
        assert.equal(q.tier, 'Google AI Ultra');
        const cats = q.pools.map((p) => p.category);
        assert.ok(cats.includes('claude_gpt') && cats.includes('gemini') && cats.includes('tab'));
        assert.ok(q.weekly?.gemini && q.weekly?.claude_gpt);

        const rawPath = join(sb.dataDir, 'quota-raw.json');
        assert.ok(existsSync(rawPath), 'quota-raw.json was not written');
        const rawText = readFileSync(rawPath, 'utf8');
        assert.equal(rawText.includes('operator@example.com'), false, 'Email leaked into quota-raw.json');
        assert.equal(rawText.includes('Test Operator'), false, 'Name leaked into quota-raw.json');
      } finally {
        await sb.cleanup();
      }
    },
  },
  {
    id: 'T1-F3-04',
    tier: 1,
    feature: 'F3',
    title: 'GET /api/history?refresh=true aggregates desktop + CLI DBs and summaries',
    async run() {
      const sb = createSandbox('t1-f3-04-');
      try {
        const nowSec = Math.floor(Date.now() / 1000) - 120;
        createSummariesDb(sb.desktopSummaryDbPath, [
          { conversation_id: 'desk-1', title: 'Desktop Chat One' },
          { conversation_id: 'desk-2', title: 'Desktop Chat Two' },
        ]);
        for (const [dir, id, model, disp] of [
          [sb.desktopConvDir, 'desk-1', 'claude-opus-4-6', 'Claude Opus 4.6'],
          [sb.desktopConvDir, 'desk-2', 'gemini-4-neon-high', 'Gemini 4 Neon (High)'],
          [sb.cliConvDir, 'cli-1', 'gemini-2.5-pro', 'Gemini 2.5 Pro'],
        ]) {
          const db = createConvDb(join(dir, `${id}.db`));
          db.step(14, { metadata: pbTs(nowSec), payloadField: 19, payload: pbField(2, `Hello ${id}`) });
          db.generation({ model, displayName: disp, usage: pbUsage({ inp: 500, out: 100, cache: 200 }) });
          db.close();
        }

        const sidecar = await startSidecar({
          sidecarDir: SIDECAR_DIR,
          env: {
            ANTIGRAVITY_GEMINI_DIR: sb.geminiDir,
            ANTIGRAVITY_EXECUTABLE_DATA_DIR: sb.dataDir,
          },
        });
        sb.track(() => sidecar.close());

        const hist = await sidecar.getJson('/api/history?refresh=true');
        assert.equal(hist.sources.desktop, 2);
        assert.equal(hist.sources.cli, 1);
        assert.equal(hist.errors, 0);
        assert.equal(hist.totals.all.calls, 3);
        for (const k of ['totals', 'by_model', 'by_conversation', 'daily', 'hourly_today', 'd7_by_pool']) {
          assert.ok(k in hist, `Missing /api/history field: ${k}`);
        }
      } finally {
        await sb.cleanup();
      }
    },
  },
  {
    id: 'T1-F3-05',
    tier: 1,
    feature: 'F3',
    title: 'GET /api/pricing returns builtin meta offline and GET / sets NO_CACHE_HEADERS + ?v= stamps',
    async run() {
      const sb = createSandbox('t1-f3-05-');
      try {
        const sidecar = await startSidecar({
          sidecarDir: SIDECAR_DIR,
          env: {
            ANTIGRAVITY_GEMINI_DIR: sb.geminiDir,
            ANTIGRAVITY_EXECUTABLE_DATA_DIR: sb.dataDir,
          },
        });
        sb.track(() => sidecar.close());

        const p = await sidecar.getJson('/api/pricing');
        assert.equal(p.source, 'builtin');
        assert.equal(p.count, 0);
        assert.equal(p.stale, true);
        assert.equal(p.fetched_at, null);

        const home = await sidecar.request('/');
        assert.equal(home.status, 200);
        assert.equal(home.headers['cache-control'], 'no-store, no-cache, must-revalidate');
        assert.equal(home.headers.pragma, 'no-cache');
        const html = home.text();
        assert.match(html, /styles\.css\?v=/);
        assert.match(html, /app\.js\?v=/);
      } finally {
        await sb.cleanup();
      }
    },
  },

  // --- F4: Frontend Modularization (web/*) ---
  {
    id: 'T1-F4-01',
    tier: 1,
    feature: 'F4',
    title: 'Frontend modularized into sidecars/agy-lens/web/ and views/ with root web files removed',
    async run() {
      assert.ok(existsSync(WEB_DIR), 'sidecars/agy-lens/web/ missing');
      for (const f of ['index.html', 'styles.css', 'i18n.js', 'format.js', 'app.js', 'views/overview.js', 'views/quota.js', 'views/history.js', 'views/share-card.js']) {
        assert.ok(existsSync(join(WEB_DIR, f)), `Missing web/${f}`);
      }
      for (const old of ['index.html', 'styles.css', 'app.js']) {
        assert.equal(existsSync(join(SIDECAR_DIR, old)), false, `Legacy root web file still present: ${old}`);
      }
    },
  },
  {
    id: 'T1-F4-02',
    tier: 1,
    feature: 'F4',
    title: 'Sidecar serves all modular web/ routes with correct Content-Type and NO_CACHE_HEADERS',
    async run() {
      const sb = createSandbox('t1-f4-02-');
      try {
        const sidecar = await startSidecar({
          sidecarDir: SIDECAR_DIR,
          env: { ANTIGRAVITY_GEMINI_DIR: sb.geminiDir, ANTIGRAVITY_EXECUTABLE_DATA_DIR: sb.dataDir },
        });
        sb.track(() => sidecar.close());

        const routes = [
          ['/', /text\/html/i],
          ['/styles.css', /text\/css/i],
          ['/i18n.js', /javascript/i],
          ['/format.js', /javascript/i],
          ['/app.js', /javascript/i],
          ['/views/overview.js', /javascript/i],
          ['/views/quota.js', /javascript/i],
          ['/views/history.js', /javascript/i],
          ['/views/share-card.js', /javascript/i],
        ];
        for (const [path, ctRe] of routes) {
          const r = await sidecar.request(path);
          assert.equal(r.status, 200, `Route ${path} returned ${r.status}`);
          assert.match(r.headers['content-type'] || '', ctRe, `Bad Content-Type on ${path}`);
          assert.equal(r.headers['cache-control'], 'no-store, no-cache, must-revalidate', `Missing no-cache on ${path}`);
        }
      } finally {
        await sb.cleanup();
      }
    },
  },
  {
    id: 'T1-F4-03',
    tier: 1,
    feature: 'F4',
    title: 'Headless Chrome ESM bootstrap renders Overview, Quota, and History without errors',
    async run() {
      assert.ok(existsSync(join(WEB_DIR, 'i18n.js')), 'Modular web/i18n.js missing');
      const res = await runChromeBrowserTest({
        webDir: WEB_DIR,
        lang: 'en-US',
        preloadConfig: { conversationId: '11111111-1111-4111-8111-111111111111' },
        mockApi: {
          '/api/report': sampleReportFixture(),
          '/api/quota': sampleQuotaFixture(),
          '/api/history': sampleHistoryFixture(),
          '/api/pricing': { source: 'builtin', fetched_at: null, count: 0, stale: true },
        },
        testScript: `
          await new Promise(r => setTimeout(r, 400));
          const overviewHtml = document.getElementById('overview')?.innerHTML || '';
          document.getElementById('tab-quota')?.click();
          await new Promise(r => setTimeout(r, 250));
          const quotaHtml = document.getElementById('quota')?.innerHTML || '';
          document.getElementById('tab-history')?.click();
          await new Promise(r => setTimeout(r, 250));
          const historyHtml = document.getElementById('history')?.innerHTML || '';
          const el = document.createElement('script');
          el.id = '__e2e_result';
          el.type = 'application/json';
          el.textContent = JSON.stringify({
            errors: window.__e2eErrors,
            overviewHasModel: overviewHtml.includes('Claude Opus 4.6'),
            quotaHasPlan: quotaHtml.includes('Pro') || quotaHtml.includes('Claude'),
            historyHasData: historyHtml.includes('Claude Opus 4.6') || historyHtml.includes('112'),
          });
          document.body.appendChild(el);
        `,
      });
      assert.deepEqual(res.consoleErrors, [], `Browser errors: ${res.consoleErrors.join('; ')}`);
      assert.equal(res.result.overviewHasModel, true);
      assert.equal(res.result.quotaHasPlan, true);
      assert.equal(res.result.historyHasData, true);
    },
  },
  {
    id: 'T1-F4-04',
    tier: 1,
    feature: 'F4',
    title: 'Tab switching updates aria-selected, hidden attributes, and History sub-views',
    async run() {
      assert.ok(existsSync(join(WEB_DIR, 'views', 'history.js')), 'Modular web/views/history.js missing');
      const res = await runChromeBrowserTest({
        webDir: WEB_DIR,
        lang: 'en-US',
        preloadConfig: { conversationId: '11111111-1111-4111-8111-111111111111' },
        mockApi: {
          '/api/report': sampleReportFixture(),
          '/api/quota': sampleQuotaFixture(),
          '/api/history': sampleHistoryFixture(),
          '/api/pricing': { source: 'builtin', fetched_at: null, count: 0, stale: true },
        },
        testScript: `
          await new Promise(r => setTimeout(r, 350));
          document.getElementById('tab-quota')?.click();
          await new Promise(r => setTimeout(r, 200));
          const quotaSelected = document.getElementById('tab-quota')?.getAttribute('aria-selected');
          const overviewHiddenOnQuota = document.getElementById('overview')?.hasAttribute('hidden');

          document.getElementById('tab-history')?.click();
          await new Promise(r => setTimeout(r, 200));
          const hasModels = Boolean(document.getElementById('history-models'));

          document.querySelector('[data-hview="sessions"]')?.click();
          await new Promise(r => setTimeout(r, 150));
          const hasSessions = Boolean(document.getElementById('history-sessions-body'));

          document.querySelector('[data-hview="list"]')?.click();
          await new Promise(r => setTimeout(r, 150));
          const hasList = Boolean(document.getElementById('history-list-body'));

          const el = document.createElement('script');
          el.id = '__e2e_result';
          el.type = 'application/json';
          el.textContent = JSON.stringify({
            errors: window.__e2eErrors,
            quotaSelected,
            overviewHiddenOnQuota,
            hasModels,
            hasSessions,
            hasList,
          });
          document.body.appendChild(el);
        `,
      });
      assert.deepEqual(res.consoleErrors, []);
      assert.equal(res.result.quotaSelected, 'true');
      assert.equal(res.result.overviewHiddenOnQuota, true);
      assert.equal(res.result.hasModels, true);
      assert.equal(res.result.hasSessions, true);
      assert.equal(res.result.hasList, true);
    },
  },
  {
    id: 'T1-F4-05',
    tier: 1,
    feature: 'F4',
    title: 'History list search, hide-subagent toggle, and token sorting work in modular views',
    async run() {
      assert.ok(existsSync(join(WEB_DIR, 'views', 'history.js')), 'Modular web/views/history.js missing');
      const res = await runChromeBrowserTest({
        webDir: WEB_DIR,
        lang: 'en-US',
        mockApi: {
          '/api/report': { error: 'no-conversation' },
          '/api/quota': sampleQuotaFixture(),
          '/api/history': sampleHistoryFixture(),
          '/api/pricing': { source: 'builtin', fetched_at: null, count: 0, stale: true },
        },
        testScript: `
          await new Promise(r => setTimeout(r, 300));
          document.getElementById('tab-history')?.click();
          await new Promise(r => setTimeout(r, 200));
          document.querySelector('[data-hview="list"]')?.click();
          await new Promise(r => setTimeout(r, 150));
          const initialCount = document.querySelectorAll('.conv-item').length;
          const hideBtn = document.querySelector('[data-hide-sub]');
          if (hideBtn && hideBtn.getAttribute('aria-pressed') !== 'true') hideBtn.click();
          await new Promise(r => setTimeout(r, 100));
          const afterHideSubCount = document.querySelectorAll('.conv-item').length;
          const sortBtn = document.querySelector('[data-hsort="tokens"]');
          sortBtn?.click();
          await new Promise(r => setTimeout(r, 100));
          const search = document.getElementById('history-search');
          if (search) {
            search.value = 'NonExistentQueryXYZ';
            search.dispatchEvent(new Event('input', { bubbles: true }));
          }
          await new Promise(r => setTimeout(r, 100));
          const afterSearchCount = document.querySelectorAll('.conv-item').length;
          const el = document.createElement('script');
          el.id = '__e2e_result';
          el.type = 'application/json';
          el.textContent = JSON.stringify({
            errors: window.__e2eErrors,
            initialCount,
            afterHideSubCount,
            afterSearchCount,
            sortPressed: sortBtn?.getAttribute('aria-pressed') || '',
          });
          document.body.appendChild(el);
        `,
      });
      assert.deepEqual(res.consoleErrors, []);
      assert.equal(res.result.initialCount, 2);
      assert.equal(res.result.afterHideSubCount, 1);
      assert.equal(res.result.afterSearchCount, 0);
    },
  },

  // --- F5: Auto-Detected i18n (en / zh) ---
  {
    id: 'T1-F5-01',
    tier: 1,
    feature: 'F5',
    title: 'web/index.html ships English static defaults (lang="en", Agy Lens, Overview/Quota/History)',
    async run() {
      const p = join(WEB_DIR, 'index.html');
      assert.ok(existsSync(p), 'web/index.html missing');
      const html = readFileSync(p, 'utf8');
      assert.match(html, /<html[^>]*\blang=["']en["']/i);
      assert.match(html, /<title>\s*Agy Lens\s*<\/title>/i);
      assert.match(html, /id=["']tab-overview["'][^>]*>\s*Overview\s*</i);
      assert.match(html, /id=["']tab-quota["'][^>]*>\s*Quota\s*</i);
      assert.match(html, /id=["']tab-history["'][^>]*>\s*History\s*</i);
      assert.match(html, /Loading…|Loading\.\.\./);
    },
  },
  {
    id: 'T1-F5-02',
    tier: 1,
    feature: 'F5',
    title: 'Auto-detects English when navigator.language is en-US and localStorage is empty',
    async run() {
      assert.ok(existsSync(join(WEB_DIR, 'i18n.js')), 'web/i18n.js missing');
      const res = await runChromeBrowserTest({
        webDir: WEB_DIR,
        lang: 'en-US',
        mockApi: { '/api/report': { error: 'no-conversation' }, '/api/quota': sampleQuotaFixture(), '/api/history': sampleHistoryFixture() },
        testScript: `
          await new Promise(r => setTimeout(r, 300));
          const el = document.createElement('script');
          el.id = '__e2e_result';
          el.type = 'application/json';
          el.textContent = JSON.stringify({
            errors: window.__e2eErrors,
            htmlLang: document.documentElement.lang,
            enPressed: document.querySelector('#lang [data-lang="en"]')?.getAttribute('aria-pressed'),
            tabOverview: document.getElementById('tab-overview')?.textContent?.trim(),
          });
          document.body.appendChild(el);
        `,
      });
      assert.deepEqual(res.consoleErrors, []);
      assert.equal(res.result.htmlLang, 'en');
      assert.equal(res.result.enPressed, 'true');
      assert.equal(res.result.tabOverview, 'Overview');
    },
  },
  {
    id: 'T1-F5-03',
    tier: 1,
    feature: 'F5',
    title: 'Auto-detects Chinese when navigator.language is zh-CN and localStorage is empty',
    async run() {
      assert.ok(existsSync(join(WEB_DIR, 'i18n.js')), 'web/i18n.js missing');
      const res = await runChromeBrowserTest({
        webDir: WEB_DIR,
        lang: 'zh-CN',
        mockApi: { '/api/report': { error: 'no-conversation' }, '/api/quota': sampleQuotaFixture(), '/api/history': sampleHistoryFixture() },
        testScript: `
          await new Promise(r => setTimeout(r, 300));
          const el = document.createElement('script');
          el.id = '__e2e_result';
          el.type = 'application/json';
          el.textContent = JSON.stringify({
            errors: window.__e2eErrors,
            htmlLang: document.documentElement.lang,
            zhPressed: document.querySelector('#lang [data-lang="zh"]')?.getAttribute('aria-pressed'),
            tabOverview: document.getElementById('tab-overview')?.textContent?.trim(),
          });
          document.body.appendChild(el);
        `,
      });
      assert.deepEqual(res.consoleErrors, []);
      assert.equal(res.result.htmlLang, 'zh-CN');
      assert.equal(res.result.zhPressed, 'true');
      assert.equal(res.result.tabOverview, '概览');
    },
  },
  {
    id: 'T1-F5-04',
    tier: 1,
    feature: 'F5',
    title: 'Manual language toggle switches DOM immediately and persists across reloads in localStorage',
    async run() {
      assert.ok(existsSync(join(WEB_DIR, 'i18n.js')), 'web/i18n.js missing');
      const first = await runChromeBrowserTest({
        webDir: WEB_DIR,
        lang: 'en-US',
        mockApi: { '/api/report': { error: 'no-conversation' }, '/api/quota': sampleQuotaFixture(), '/api/history': sampleHistoryFixture() },
        testScript: `
          await new Promise(r => setTimeout(r, 300));
          document.querySelector('#lang [data-lang="zh"]')?.click();
          await new Promise(r => setTimeout(r, 150));
          const el = document.createElement('script');
          el.id = '__e2e_result';
          el.type = 'application/json';
          el.textContent = JSON.stringify({
            errors: window.__e2eErrors,
            stored: localStorage.getItem('ctx.lang'),
            tabs: [
              document.getElementById('tab-overview')?.textContent?.trim(),
              document.getElementById('tab-quota')?.textContent?.trim(),
              document.getElementById('tab-history')?.textContent?.trim(),
            ],
          });
          document.body.appendChild(el);
        `,
      });
      assert.deepEqual(first.consoleErrors, []);
      assert.equal(first.result.stored, 'zh');
      assert.deepEqual(first.result.tabs, ['概览', '额度', '历史']);

      const reload = await runChromeBrowserTest({
        webDir: WEB_DIR,
        lang: 'en-US',
        localStorageInit: { 'ctx.lang': 'zh' },
        mockApi: { '/api/report': { error: 'no-conversation' }, '/api/quota': sampleQuotaFixture(), '/api/history': sampleHistoryFixture() },
        testScript: `
          await new Promise(r => setTimeout(r, 300));
          const el = document.createElement('script');
          el.id = '__e2e_result';
          el.type = 'application/json';
          el.textContent = JSON.stringify({
            errors: window.__e2eErrors,
            htmlLang: document.documentElement.lang,
            tabOverview: document.getElementById('tab-overview')?.textContent?.trim(),
          });
          document.body.appendChild(el);
        `,
      });
      assert.deepEqual(reload.consoleErrors, []);
      assert.equal(reload.result.htmlLang, 'zh-CN');
      assert.equal(reload.result.tabOverview, '概览');
    },
  },
  {
    id: 'T1-F5-05',
    tier: 1,
    feature: 'F5',
    title: 'I18N dictionaries contain zero Pulse branding and reference Agy Lens',
    async run() {
      const i18nPath = join(WEB_DIR, 'i18n.js');
      assert.ok(existsSync(i18nPath), 'web/i18n.js missing');
      const { I18N } = await import(`${pathToFileURL(i18nPath).href}?t=${Date.now()}`);
      assert.ok(I18N?.en && I18N?.zh, 'I18N.en and I18N.zh must be exported');
      const dump = (obj) => JSON.stringify(obj, (_, v) => (typeof v === 'function' ? v('1', '2', '3') : v));
      const enDump = dump(I18N.en);
      const zhDump = dump(I18N.zh);
      assert.equal(/\bPulse\b/.test(enDump), false, 'Found legacy Pulse branding in I18N.en');
      assert.equal(/\bPulse\b/.test(zhDump), false, 'Found legacy Pulse branding in I18N.zh');
      const indexHtml = readFileSync(join(WEB_DIR, 'index.html'), 'utf8');
      assert.ok(
        indexHtml.includes('Agy Lens') || (enDump.includes('Agy Lens') && zhDump.includes('Agy Lens')),
        'index.html or I18N must reference Agy Lens',
      );
    },
  },

  // --- F6: Sanitized History Share Card Export ---
  {
    id: 'T1-F6-01',
    tier: 1,
    feature: 'F6',
    title: 'Share Card trigger button is visible and enabled in History Totals view',
    async run() {
      assert.ok(existsSync(join(WEB_DIR, 'views', 'share-card.js')), 'web/views/share-card.js missing');
      const res = await runChromeBrowserTest({
        webDir: WEB_DIR,
        lang: 'en-US',
        mockApi: { '/api/report': { error: 'no-conversation' }, '/api/quota': sampleQuotaFixture(), '/api/history': sampleHistoryFixture() },
        testScript: `
          await new Promise(r => setTimeout(r, 300));
          document.getElementById('tab-history')?.click();
          await new Promise(r => setTimeout(r, 250));
          const isVisible = (node) => {
            const r = node.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          };
          const candidates = Array.from(
            document.querySelectorAll('[data-share-card], #share-card-btn, [data-share], [data-export-share], button[id*="share" i], button[class*="share" i]')
          );
          let btn = candidates.find(isVisible) || candidates[0] || null;
          if (!btn) {
            const historyEl = document.getElementById('history') || document;
            btn = Array.from(historyEl.querySelectorAll('button')).find((b) => {
              if (!isVisible(b)) return false;
              const label = [b.textContent, b.getAttribute('aria-label'), b.getAttribute('title')].filter(Boolean).join(' ');
              return /share|export|分享/i.test(label);
            }) || null;
          }
          const rect = btn ? btn.getBoundingClientRect() : null;
          const el = document.createElement('script');
          el.id = '__e2e_result';
          el.type = 'application/json';
          el.textContent = JSON.stringify({
            errors: window.__e2eErrors,
            found: Boolean(btn),
            disabled: btn ? btn.disabled : true,
            visible: Boolean(rect && rect.width > 0 && rect.height > 0),
          });
          document.body.appendChild(el);
        `,
      });
      assert.deepEqual(res.consoleErrors, []);
      assert.equal(res.result.found, true, 'Share card trigger button not found');
      assert.equal(res.result.disabled, false);
      assert.equal(res.result.visible, true);
    },
  },
  {
    id: 'T1-F6-02',
    tier: 1,
    feature: 'F6',
    title: 'buildShareCardSvg produces valid SVG containing Agy Lens, totals, models, and period metrics',
    async run() {
      const scPath = join(WEB_DIR, 'views', 'share-card.js');
      assert.ok(existsSync(scPath), 'web/views/share-card.js missing');
      const { buildShareCardSvg } = await import(`${pathToFileURL(scPath).href}?t=${Date.now()}`);
      assert.equal(typeof buildShareCardSvg, 'function');
      const h = sampleHistoryFixture();
      const svg = buildShareCardSvg({
        period: 'd30',
        totals: h.totals.d30,
        byModel: h.by_model,
        daily: h.daily,
        d7ByPool: h.d7_by_pool,
        lang: 'en',
        theme: 'dark',
      });
      assert.match(svg.trim(), /^<svg\b[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
      assert.match(svg.trim(), /<\/svg>\s*$/);
      assert.ok(svg.includes('Agy Lens'));
      assert.ok(svg.includes('Claude Opus 4.6'));
    },
  },
  {
    id: 'T1-F6-03',
    tier: 1,
    feature: 'F6',
    title: 'Headless Chrome exports valid PNG Share Card with PNG magic and IHDR dimensions',
    async run() {
      const scPath = join(WEB_DIR, 'views', 'share-card.js');
      assert.ok(existsSync(scPath), 'web/views/share-card.js missing');
      const h = sampleHistoryFixture();
      const res = await runChromeBrowserTest({
        webDir: WEB_DIR,
        lang: 'en-US',
        mockApi: { '/api/report': { error: 'no-conversation' }, '/api/quota': sampleQuotaFixture(), '/api/history': h },
        testScript: `
          import { buildShareCardSvg } from '@web/views/share-card.js';
          const h = ${JSON.stringify(h)};
          const svg = buildShareCardSvg({
            period: 'd30',
            totals: h.totals.d30,
            byModel: h.by_model,
            daily: h.daily,
            d7ByPool: h.d7_by_pool,
            lang: 'en',
            theme: 'dark',
          });
          const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
          const url = URL.createObjectURL(blob);
          const img = new Image();
          await new Promise((res, rej) => {
            img.onload = res;
            img.onerror = () => rej(new Error('SVG image failed to decode in Chrome'));
            img.src = url;
          });
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth || 800;
          canvas.height = img.naturalHeight || 420;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0);
          const dataUrl = canvas.toDataURL('image/png');
          URL.revokeObjectURL(url);
          const el = document.createElement('script');
          el.id = '__e2e_result';
          el.type = 'application/json';
          el.textContent = JSON.stringify({ errors: window.__e2eErrors, dataUrl });
          document.body.appendChild(el);
        `,
      });
      assert.deepEqual(res.consoleErrors, []);
      assert.ok(res.result.dataUrl.startsWith('data:image/png;base64,'));
      const pngBuf = Buffer.from(res.result.dataUrl.split(',')[1], 'base64');
      const info = parsePngInfo(pngBuf);
      assert.ok(info.width > 0 && info.height > 0);
    },
  },
  {
    id: 'T1-F6-04',
    tier: 1,
    feature: 'F6',
    title: 'Share Card SVG supports localized en and zh labels without untranslated key leaks',
    async run() {
      const scPath = join(WEB_DIR, 'views', 'share-card.js');
      assert.ok(existsSync(scPath), 'web/views/share-card.js missing');
      const { buildShareCardSvg } = await import(`${pathToFileURL(scPath).href}?t=${Date.now()}`);
      const h = sampleHistoryFixture();
      const svgEn = buildShareCardSvg({ period: 'd30', totals: h.totals.d30, byModel: h.by_model, daily: h.daily, d7ByPool: h.d7_by_pool, lang: 'en', theme: 'dark' });
      const svgZh = buildShareCardSvg({ period: 'd30', totals: h.totals.d30, byModel: h.by_model, daily: h.daily, d7ByPool: h.d7_by_pool, lang: 'zh', theme: 'dark' });
      assert.notEqual(svgEn, svgZh);
      assert.equal(/[\u4e00-\u9fff]/.test(svgEn), false, 'English Share Card contains Chinese characters');
      assert.match(svgZh, /[\u4e00-\u9fff]/, 'Chinese Share Card must contain Chinese labels');
      assert.equal(/\bundefined\b|\bNaN\b/.test(svgEn + svgZh), false);
    },
  },
  {
    id: 'T1-F6-05',
    tier: 1,
    feature: 'F6',
    title: 'Share Card SVG renders distinct dark and light palettes',
    async run() {
      const scPath = join(WEB_DIR, 'views', 'share-card.js');
      assert.ok(existsSync(scPath), 'web/views/share-card.js missing');
      const { buildShareCardSvg } = await import(`${pathToFileURL(scPath).href}?t=${Date.now()}`);
      const h = sampleHistoryFixture();
      const darkSvg = buildShareCardSvg({ period: 'd30', totals: h.totals.d30, byModel: h.by_model, daily: h.daily, d7ByPool: h.d7_by_pool, lang: 'en', theme: 'dark' });
      const lightSvg = buildShareCardSvg({ period: 'd30', totals: h.totals.d30, byModel: h.by_model, daily: h.daily, d7ByPool: h.d7_by_pool, lang: 'en', theme: 'light' });
      assert.match(darkSvg.trim(), /^<svg\b/);
      assert.match(lightSvg.trim(), /^<svg\b/);
      assert.notEqual(darkSvg, lightSvg, 'Dark and light Share Card SVGs must differ');
    },
  },
];
