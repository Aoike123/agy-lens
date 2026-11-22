// Tier 3 Cross-Feature Pairwise Tests (14 tests: T3-01 .. T3-14)

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ROOT,
  createSandbox,
  extractZipEntries,
  extractZipToDir,
  makePoisonedPythonBinDir,
  parsePngInfo,
  runBuildRelease,
  runChromeBrowserTest,
  runCli,
  startSidecar,
  walkFiles,
} from './lib/harness.mjs';
import { startMockLs } from './lib/mock-ls.mjs';
import {
  createConvDb,
  createSummariesDb,
  createWalConvDb,
  pbField,
  pbGroup,
  pbTiming,
  pbTs,
  pbUsage,
} from './lib/pb-db-builder.mjs';

const SIDECAR_DIR = join(ROOT, 'sidecars', 'agy-lens');
const WEB_DIR = join(SIDECAR_DIR, 'web');

export const TESTS = [
  {
    id: 'T3-01',
    tier: 3,
    feature: 'F1+F3',
    title: 'Sidecar directory layout + all 4 live backend HTTP API endpoints',
    async run() {
      const sb = createSandbox('t3-01-');
      try {
        const uuid = '11111111-2222-4333-8444-555555555555';
        const nowSec = Math.floor(Date.now() / 1000) - 60;
        const db = createConvDb(join(sb.desktopConvDir, `${uuid}.db`));
        db.step(14, { metadata: pbTs(nowSec), payloadField: 19, payload: pbField(2, 'Pairwise F1+F3') });
        db.generation({
          groups: [pbGroup(1, 1000), pbGroup(7, 400, [['14: USER_INPUT', 400]])],
          usage: pbUsage({ inp: 900, out: 150, cache: 300 }),
        });
        db.close();

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

        const rep = await sidecar.getJson(`/api/report?conversationId=${uuid}`);
        const quota = await sidecar.getJson('/api/quota?refresh=true');
        const hist = await sidecar.getJson('/api/history?refresh=true');
        const pricing = await sidecar.getJson('/api/pricing');
        assert.equal(rep.used_tokens, 1400);
        assert.ok(quota.pools.length >= 2);
        assert.equal(hist.totals.all.calls, 1);
        assert.equal(pricing.source, 'builtin');
      } finally {
        await sb.cleanup();
      }
    },
  },
  {
    id: 'T3-02',
    tier: 3,
    feature: 'F2+F3',
    title: 'Zero Python + WAL-mode SQLite DB read-only parsing preserves WAL/SHM',
    async run() {
      const sb = createSandbox('t3-02-');
      try {
        const uuid = '22222222-3333-4444-8555-666666666666';
        createSummariesDb(sb.desktopSummaryDbPath, [{ conversation_id: uuid, title: 'WAL Mode Chat' }]);
        const walDb = createWalConvDb(join(sb.desktopConvDir, `${uuid}.db`));
        sb.track(() => { try { walDb.close(); } catch { /* ignore */ } });

        const nowSec = Math.floor(Date.now() / 1000) - 45;
        walDb.step(14, { metadata: pbTs(nowSec), payloadField: 19, payload: pbField(2, 'WAL step') });
        walDb.generation({
          groups: [pbGroup(1, 1500), pbGroup(7, 500, [['14: USER_INPUT', 500]])],
          usage: pbUsage({ inp: 1200, out: 300 }),
          timing: pbTiming([1, 0], [2, 0]),
        });
        assert.ok(existsSync(walDb.walPath), 'Expected -wal file to exist on disk');

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
        assert.equal(rep.used_tokens, 2000);
        const hist = await sidecar.getJson('/api/history?refresh=true');
        assert.equal(hist.totals.all.calls, 1);
        assert.equal(hist.by_conversation[0].title, 'WAL Mode Chat');
        assert.equal(existsSync(walDb.walPath), true, 'Read-only scan must leave WAL file intact');
        assert.equal(existsSync(poison.sentinelPath), false);
      } finally {
        await sb.cleanup();
      }
    },
  },
  {
    id: 'T3-03',
    tier: 3,
    feature: 'F2+F9',
    title: 'Zero Python in Release ZIP and CI/Release workflows',
    async run() {
      const sb = createSandbox('t3-03-');
      try {
        await runBuildRelease(sb.root, ROOT);
        const entries = extractZipEntries(readFileSync(join(sb.root, 'agy-lens.zip')));
        const names = Array.from(entries.keys());
        assert.equal(names.some((n) => /\.py$/i.test(n)), false);
        assert.ok(names.includes('agy-lens/sidecars/agy-lens/lib/pb.mjs'));
        const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
        const rel = readFileSync(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
        assert.equal(/\bpython\b|setup-python/i.test(ci + rel), false);
      } finally {
        await sb.cleanup();
      }
    },
  },
  {
    id: 'T3-04',
    tier: 3,
    feature: 'F3+F4',
    title: 'Live backend /api/* payloads render end-to-end in modular web/ UI inside headless Chrome',
    async run() {
      assert.ok(existsSync(join(WEB_DIR, 'views', 'overview.js')), 'web/views/overview.js missing');
      const sb = createSandbox('t3-04-');
      try {
        const uuid = '33333333-4444-4555-8666-777777777777';
        const nowSec = Math.floor(Date.now() / 1000) - 60;
        const db = createConvDb(join(sb.desktopConvDir, `${uuid}.db`));
        db.step(14, { metadata: pbTs(nowSec), payloadField: 19, payload: pbField(2, 'Render live DB') });
        db.generation({
          model: 'claude-opus-4-6',
          displayName: 'Claude Opus 4.6',
          groups: [pbGroup(1, 25000), pbGroup(7, 10000, [['14: USER_INPUT', 10000]])],
          usage: pbUsage({ inp: 20000, out: 1500, cache: 5000 }),
          timing: pbTiming([1, 0], [3, 0]),
        });
        db.close();

        const ls = await startMockLs({ useHttps: false });
        sb.track(() => ls.close());

        const sidecar = await startSidecar({
          sidecarDir: SIDECAR_DIR,
          mockLs: ls,
          preloadConfig: { conversationId: uuid },
          env: {
            ANTIGRAVITY_GEMINI_DIR: sb.geminiDir,
            ANTIGRAVITY_EXECUTABLE_DATA_DIR: sb.dataDir,
            ANTIGRAVITY_LS_ADDRESS: ls.url,
            ANTIGRAVITY_CSRF_TOKEN: ls.csrfToken,
          },
        });
        sb.track(() => sidecar.close());

        const mockApi = {
          '/api/report': await sidecar.getJson(`/api/report?conversationId=${uuid}`),
          '/api/quota': await sidecar.getJson('/api/quota?refresh=true'),
          '/api/history': await sidecar.getJson('/api/history?refresh=true'),
          '/api/pricing': await sidecar.getJson('/api/pricing'),
        };

        const res = await runChromeBrowserTest({
          webDir: WEB_DIR,
          liveUrl: `${sidecar.baseUrl}/`,
          mockApi,
          preloadConfig: { conversationId: uuid },
          lang: 'en-US',
          testScript: `
            await new Promise(r => setTimeout(r, 400));
            const ov = document.getElementById('overview')?.textContent || '';
            document.getElementById('tab-quota')?.click();
            await new Promise(r => setTimeout(r, 200));
            const q = document.getElementById('quota')?.textContent || '';
            document.getElementById('tab-history')?.click();
            await new Promise(r => setTimeout(r, 200));
            const h = document.getElementById('history')?.textContent || '';
            const el = document.createElement('script');
            el.id = '__e2e_result';
            el.type = 'application/json';
            el.textContent = JSON.stringify({
              errors: window.__e2eErrors,
              ovHasModel: ov.includes('Claude Opus 4.6'),
              quotaHasPool: q.includes('Claude') || q.includes('Gemini'),
              historyHasModel: h.includes('Claude Opus 4.6'),
            });
            document.body.appendChild(el);
          `,
        });
        assert.deepEqual(res.consoleErrors, []);
        assert.equal(res.result.ovHasModel, true);
        assert.equal(res.result.quotaHasPool, true);
        assert.equal(res.result.historyHasModel, true);
      } finally {
        await sb.cleanup();
      }
    },
  },
  {
    id: 'T3-05',
    tier: 3,
    feature: 'F4+F5',
    title: 'Modular web/views/*.js synchronously re-render across tabs on language toggle',
    async run() {
      assert.ok(existsSync(join(WEB_DIR, 'i18n.js')), 'web/i18n.js missing');
      const res = await runChromeBrowserTest({
        webDir: WEB_DIR,
        lang: 'zh-CN',
        mockApi: {
          '/api/report': { error: 'no-conversation' },
          '/api/quota': { pools: [], weekly: {}, plan: null, tier: null, error: 'unavailable' },
          '/api/history': { totals: { today: {}, d7: {}, d30: {}, all: { calls: 0 } }, by_model: [], by_conversation: [], daily: [], hourly_today: [], d7_by_pool: {}, sources: { desktop: 0, cli: 0 }, errors: 0 },
        },
        testScript: `
          await new Promise(r => setTimeout(r, 300));
          const initialLang = document.documentElement.lang;
          const zhOv = document.getElementById('overview')?.textContent || '';
          document.querySelector('#lang [data-lang="en"]')?.click();
          await new Promise(r => setTimeout(r, 150));
          const afterLang = document.documentElement.lang;
          const enOv = document.getElementById('overview')?.textContent || '';
          document.getElementById('tab-quota')?.click();
          await new Promise(r => setTimeout(r, 150));
          const enQuota = document.getElementById('quota')?.textContent || '';
          const el = document.createElement('script');
          el.id = '__e2e_result';
          el.type = 'application/json';
          el.textContent = JSON.stringify({
            errors: window.__e2eErrors,
            initialLang,
            afterLang,
            zhHasChinese: /[\\u4e00-\\u9fff]/.test(zhOv),
            enHasChinese: /[\\u4e00-\\u9fff]/.test(enOv + enQuota),
          });
          document.body.appendChild(el);
        `,
      });
      assert.deepEqual(res.consoleErrors, []);
      assert.equal(res.result.initialLang, 'zh-CN');
      assert.equal(res.result.afterLang, 'en');
      assert.equal(res.result.zhHasChinese, true);
      assert.equal(res.result.enHasChinese, false);
    },
  },
  {
    id: 'T3-06',
    tier: 3,
    feature: 'F3+F5+F6',
    title: 'Live /api/history feeds localized en/zh Share Card SVG/PNG while stripping DB titles',
    async run() {
      const scPath = join(WEB_DIR, 'views', 'share-card.js');
      assert.ok(existsSync(scPath), 'web/views/share-card.js missing');
      const sb = createSandbox('t3-06-');
      try {
        const nowSec = Math.floor(Date.now() / 1000) - 60;
        const secretTitle = 'TOP_SECRET_CONTRACT_999';
        createSummariesDb(sb.desktopSummaryDbPath, [{ conversation_id: 'conv-secret', title: secretTitle }]);
        const db = createConvDb(join(sb.desktopConvDir, 'conv-secret.db'));
        db.step(14, { metadata: pbTs(nowSec), payloadField: 19, payload: pbField(2, 'C:\\Users\\alice\\private\\repo') });
        db.generation({
          model: 'claude-opus-4-6',
          displayName: 'Claude Opus 4.6',
          usage: pbUsage({ inp: 5000, out: 1200, cache: 3000 }),
        });
        db.close();

        const sidecar = await startSidecar({
          sidecarDir: SIDECAR_DIR,
          env: { ANTIGRAVITY_GEMINI_DIR: sb.geminiDir, ANTIGRAVITY_EXECUTABLE_DATA_DIR: sb.dataDir },
        });
        sb.track(() => sidecar.close());

        const hist = await sidecar.getJson('/api/history?refresh=true');
        assert.equal(hist.by_conversation[0].title, secretTitle);

        const { buildShareCardSvg } = await import(`${pathToFileURL(scPath).href}?t=${Date.now()}`);
        for (const lang of ['en', 'zh']) {
          const svg = buildShareCardSvg({
            period: 'd30',
            totals: hist.totals.d30,
            byModel: hist.by_model,
            daily: hist.daily,
            d7ByPool: hist.d7_by_pool,
            by_conversation: hist.by_conversation,
            lang,
            theme: 'dark',
          });
          assert.ok(svg.includes('Claude Opus 4.6'));
          assert.equal(svg.includes(secretTitle), false, `Secret title leaked into ${lang} Share Card`);
          assert.equal(svg.includes('C:\\Users\\alice'), false);
        }
      } finally {
        await sb.cleanup();
      }
    },
  },
  {
    id: 'T3-07',
    tier: 3,
    feature: 'F1+F7+F9',
    title: 'Extracted Release ZIP aligns plugin.json, sidecar.json, package.json, and main.mjs',
    async run() {
      const sb = createSandbox('t3-07-');
      try {
        const res = await runBuildRelease(sb.root, ROOT);
        const extractDir = join(sb.root, 'ext');
        extractZipToDir(readFileSync(join(sb.root, 'agy-lens.zip')), extractDir);

        const pluginRoot = join(extractDir, 'agy-lens');
        const pj = JSON.parse(readFileSync(join(pluginRoot, 'plugin.json'), 'utf8'));
        const sc = JSON.parse(readFileSync(join(pluginRoot, 'sidecars', 'agy-lens', 'sidecar.json'), 'utf8'));
        const spkg = JSON.parse(readFileSync(join(pluginRoot, 'sidecars', 'agy-lens', 'package.json'), 'utf8'));
        assert.equal(pj.name, 'agy-lens');
        assert.equal(pj.version, res.version);
        assert.equal(spkg.version, pj.version);
        assert.ok(existsSync(join(pluginRoot, 'sidecars', 'agy-lens', sc.args[0])));
      } finally {
        await sb.cleanup();
      }
    },
  },
  {
    id: 'T3-08',
    tier: 3,
    feature: 'F3+F8',
    title: 'Backend HTTP /api/report and bin/cli.mjs --json --db report identical core metrics',
    async run() {
      const sb = createSandbox('t3-08-');
      try {
        const uuid = '44444444-5555-4666-8777-888888888888';
        const dbPath = join(sb.desktopConvDir, `${uuid}.db`);
        const nowSec = Math.floor(Date.now() / 1000) - 90;
        const db = createConvDb(dbPath);
        db.step(14, { metadata: pbTs(nowSec), payloadField: 19, payload: pbField(2, 'Parity check') });
        db.generation({
          model: 'claude-opus-4-6',
          displayName: 'Claude Opus 4.6',
          groups: [pbGroup(1, 2000), pbGroup(7, 750, [['14: USER_INPUT', 750]])],
          usage: pbUsage({ inp: 2200, out: 450, cache: 800 }),
          timing: pbTiming([1, 0], [2, 0]),
        });
        db.close();

        const sidecar = await startSidecar({
          sidecarDir: SIDECAR_DIR,
          env: { ANTIGRAVITY_GEMINI_DIR: sb.geminiDir, ANTIGRAVITY_EXECUTABLE_DATA_DIR: sb.dataDir },
        });
        sb.track(() => sidecar.close());
        const httpRep = await sidecar.getJson(`/api/report?conversationId=${uuid}`);

        const cliRes = runCli(['--json', '--db', dbPath], {
          env: { ANTIGRAVITY_GEMINI_DIR: sb.geminiDir, ANTIGRAVITY_EXECUTABLE_DATA_DIR: sb.dataDir },
        });
        assert.equal(cliRes.status, 0, `CLI failed: ${cliRes.stderr}`);
        const cliJson = JSON.parse(cliRes.stdout);
        const cliRep = cliJson.report || cliJson;

        assert.equal(cliRep.used_tokens, httpRep.used_tokens);
        assert.equal(cliRep.limit_tokens, httpRep.limit_tokens);
        assert.equal(cliRep.session.input, httpRep.session.input);
        assert.equal(cliRep.session.output, httpRep.session.output);
        assert.equal(cliRep.session.calls, httpRep.session.calls);
      } finally {
        await sb.cleanup();
      }
    },
  },
  {
    id: 'T3-09',
    tier: 3,
    feature: 'F6+F10',
    title: 'Sanitized tests/fixtures/ JSON fed into Share Card SVG stays free of titles and paths',
    async run() {
      const scPath = join(WEB_DIR, 'views', 'share-card.js');
      const fixDir = join(ROOT, 'tests', 'fixtures');
      assert.ok(existsSync(scPath), 'web/views/share-card.js missing');
      assert.ok(existsSync(fixDir), 'tests/fixtures/ missing');
      const files = readdirSync(fixDir).filter((f) => f.endsWith('.json'));
      assert.ok(files.length >= 1, 'No fixture JSON files found');

      let histFixture = null;
      for (const f of files) {
        const raw = readFileSync(join(fixDir, f), 'utf8');
        assert.equal(/C:\\Users\\|D:\\Code\\|\/Users\/|\/home\//i.test(raw), false);
        const parsed = JSON.parse(raw);
        if (parsed.totals && parsed.by_model) histFixture = parsed;
        else if (parsed.history?.totals) histFixture = parsed.history;
      }
      assert.ok(histFixture, 'No history fixture found under tests/fixtures/');
      const { buildShareCardSvg } = await import(`${pathToFileURL(scPath).href}?t=${Date.now()}`);
      const svg = buildShareCardSvg({
        period: 'd30',
        totals: histFixture.totals.d30 || histFixture.totals.all,
        byModel: histFixture.by_model,
        daily: histFixture.daily || [],
        d7ByPool: histFixture.d7_by_pool || {},
        by_conversation: histFixture.by_conversation || [],
        lang: 'en',
        theme: 'dark',
      });
      assert.match(svg, /^<svg\b/);
      for (const c of histFixture.by_conversation || []) {
        if (c.title) assert.equal(svg.includes(c.title), false, `Fixture title leaked into Share Card: ${c.title}`);
      }
    },
  },
  {
    id: 'T3-10',
    tier: 3,
    feature: 'F8+F9',
    title: 'Extracted Release ZIP executes bin/cli.mjs --json standalone',
    async run() {
      const sb = createSandbox('t3-10-');
      try {
        await runBuildRelease(sb.root, ROOT);
        const extractDir = join(sb.root, 'ext');
        extractZipToDir(readFileSync(join(sb.root, 'agy-lens.zip')), extractDir);

        const nowSec = Math.floor(Date.now() / 1000) - 60;
        const db = createConvDb(join(sb.desktopConvDir, '55555555-6666-4777-8888-999999999999.db'));
        db.step(14, { metadata: pbTs(nowSec), payloadField: 19, payload: pbField(2, 'Extracted CLI') });
        db.generation({ usage: pbUsage({ inp: 700, out: 150 }) });
        db.close();

        const extCli = join(extractDir, 'agy-lens', 'bin', 'cli.mjs');
        const r = runCli(['--json'], {
          cliPath: extCli,
          cwd: join(extractDir, 'agy-lens'),
          env: { ANTIGRAVITY_GEMINI_DIR: sb.geminiDir, ANTIGRAVITY_EXECUTABLE_DATA_DIR: sb.dataDir },
        });
        assert.equal(r.status, 0, `Extracted CLI failed: ${r.stderr}`);
        const parsed = JSON.parse(r.stdout);
        const h = parsed.history || parsed;
        assert.equal(h.totals.all.calls, 1);
      } finally {
        await sb.cleanup();
      }
    },
  },
  {
    id: 'T3-11',
    tier: 3,
    feature: 'F10+F11',
    title: 'Bilingual screenshots and Hero composites referenced in README.md and README.zh-CN.md exist as valid PNGs',
    async run() {
      const enReadme = readFileSync(join(ROOT, 'README.md'), 'utf8');
      const zhPath = join(ROOT, 'README.zh-CN.md');
      assert.ok(existsSync(zhPath), 'README.zh-CN.md missing');
      const zhReadme = readFileSync(zhPath, 'utf8');

      assert.ok(enReadme.includes('docs/img/hero-en.png'));
      assert.ok(zhReadme.includes('docs/img/hero-zh.png'));

      for (const rel of [
        'docs/img/hero-en.png',
        'docs/img/hero-zh.png',
        'docs/img/en/overview.png',
        'docs/img/en/quota.png',
        'docs/img/en/history.png',
        'docs/img/zh/overview.png',
        'docs/img/zh/quota.png',
        'docs/img/zh/history.png',
      ]) {
        const p = join(ROOT, rel);
        assert.ok(existsSync(p), `Missing image asset: ${rel}`);
        parsePngInfo(readFileSync(p));
      }
    },
  },
  {
    id: 'T3-12',
    tier: 3,
    feature: 'F11+F12',
    title: 'README.md and docs/launch/*.md align repo URLs, display name, and CLI commands',
    async run() {
      const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
      const launchDir = join(ROOT, 'docs', 'launch');
      assert.ok(existsSync(launchDir), 'docs/launch/ missing');
      const files = walkFiles(launchDir).filter((f) => f.endsWith('.md'));
      assert.ok(files.length >= 6);
      assert.ok(readme.includes('Aoike123/agy-lens'));
      // agy-lens is not on npm yet, so the CLI is run straight from GitHub.
      assert.match(readme, /npx (github:Aoike123\/)?agy-lens/);
      const combined = files.map((f) => readFileSync(f, 'utf8')).join('\n');
      assert.ok(combined.includes('Aoike123/agy-lens'));
      assert.match(combined, /npx (github:Aoike123\/)?agy-lens/);
      assert.ok(combined.includes('Agy Lens'));
    },
  },
  {
    id: 'T3-13',
    tier: 3,
    feature: 'F10+F12',
    title: '1280x640 social-preview.png pairs with github-metadata.md and x-twitter.md launch assets',
    async run() {
      const spPath = join(ROOT, 'docs', 'img', 'social-preview.png');
      assert.ok(existsSync(spPath), 'docs/img/social-preview.png missing');
      const info = parsePngInfo(readFileSync(spPath));
      assert.equal(info.width, 1280);
      assert.equal(info.height, 640);
      assert.ok(existsSync(join(ROOT, 'docs', 'launch', 'github-metadata.md')));
      assert.ok(existsSync(join(ROOT, 'docs', 'launch', 'x-twitter.md')));
    },
  },
  {
    id: 'T3-14',
    tier: 3,
    feature: 'F7+F9',
    title: 'Root package.json bin and install.sh/install.ps1 target Aoike123/agy-lens consistently',
    async run() {
      const pkgPath = join(ROOT, 'package.json');
      assert.ok(existsSync(pkgPath), 'Root package.json missing');
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      assert.ok(pkg.bin?.['agy-lens']);
      const sh = readFileSync(join(ROOT, 'scripts', 'install.sh'), 'utf8');
      const ps1 = readFileSync(join(ROOT, 'scripts', 'install.ps1'), 'utf8');
      assert.match(sh, /Aoike123\/agy-lens/);
      assert.match(sh, /agy-lens/);
      assert.match(ps1, /Aoike123\/agy-lens/);
      assert.match(ps1, /agy-lens/);
    },
  },
];
