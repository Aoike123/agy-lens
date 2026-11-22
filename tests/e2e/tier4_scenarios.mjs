// Tier 4 Real-World Application Scenarios (6 tests: T4-01 .. T4-06)

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ROOT,
  createSandbox,
  extractZipEntries,
  extractZipToDir,
  makePoisonedPythonBinDir,
  parsePngInfo,
  relPath,
  runBuildRelease,
  runChromeBrowserTest,
  runCli,
  runInstallPs1DryRun,
  runInstallShDryRun,
  startSidecar,
  walkFiles,
} from './lib/harness.mjs';
import { DEFAULT_MODELS_RESP, DEFAULT_SUMMARY_RESP, startMockLs } from './lib/mock-ls.mjs';
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

export const TESTS = [
  {
    id: 'T4-01',
    tier: 4,
    feature: 'F1,F7,F9',
    title: 'Scenario 1: Fresh Install & Upgrade from antigravity-pulse with live sidecar boot',
    async run() {
      const sb = createSandbox('t4-01-');
      try {
        await runBuildRelease(sb.root, ROOT);
        const zipPath = join(sb.root, 'agy-lens.zip');
        let installedRoot = null;
        const shPath = join(ROOT, 'scripts', 'install.sh');
        const shOldDir = join(sb.homeDir, '.gemini', 'config', 'plugins', 'antigravity-pulse');
        mkdirSync(shOldDir, { recursive: true });
        writeFileSync(join(shOldDir, 'plugin.json'), '{"name":"antigravity-pulse"}');

        const shRes = runInstallShDryRun({
          shPath,
          zipPath,
          homeDir: sb.homeDir,
        });
        if (!shRes.skippedExecution) {
          assert.equal(shRes.status, 0, `install.sh failed: ${shRes.stderr}`);
          assert.equal(existsSync(shOldDir), false, 'Legacy antigravity-pulse dir not removed by install.sh');
          installedRoot = join(sb.homeDir, '.gemini', 'config', 'plugins', 'agy-lens');
        }

        if (process.platform === 'win32') {
          const psHome = join(sb.root, 'home-ps1');
          const psOldDir = join(psHome, '.gemini', 'config', 'plugins', 'antigravity-pulse');
          mkdirSync(psOldDir, { recursive: true });
          writeFileSync(join(psOldDir, 'plugin.json'), '{"name":"antigravity-pulse"}');

          const ps1Res = runInstallPs1DryRun({
            ps1Path: join(ROOT, 'scripts', 'install.ps1'),
            zipPath,
            homeDir: psHome,
          });
          assert.equal(ps1Res.status, 0, `install.ps1 failed: ${ps1Res.stderr}`);
          assert.equal(existsSync(psOldDir), false, 'Legacy antigravity-pulse dir not removed by install.ps1');
          installedRoot = join(psHome, '.gemini', 'config', 'plugins', 'agy-lens');
        }

        assert.ok(installedRoot, 'Neither install.sh nor install.ps1 could execute on this host');
        assert.ok(existsSync(join(installedRoot, 'plugin.json')));
        assert.ok(existsSync(join(installedRoot, 'bin', 'cli.mjs')));
        const installedSidecar = join(installedRoot, 'sidecars', 'agy-lens');
        assert.ok(existsSync(join(installedSidecar, 'main.mjs')));

        const sidecar = await startSidecar({
          sidecarDir: installedSidecar,
          env: { ANTIGRAVITY_GEMINI_DIR: sb.geminiDir, ANTIGRAVITY_EXECUTABLE_DATA_DIR: sb.dataDir },
        });
        sb.track(() => sidecar.close());
        const home = await sidecar.request('/');
        assert.equal(home.status, 200);
        assert.match(home.text(), /Agy Lens/);
      } finally {
        await sb.cleanup();
      }
    },
  },
  {
    id: 'T4-02',
    tier: 4,
    feature: 'F2,F3,F4,F5,F6,F8',
    title: 'Scenario 2: Multi-Conversation Cockpit Session + CLI + Sanitized Share Card',
    async run() {
      assert.ok(existsSync(join(WEB_DIR, 'views', 'share-card.js')), 'web/views/share-card.js missing');
      const sb = createSandbox('t4-02-');
      try {
        const nowSec = Math.floor(Date.now() / 1000) - 90;
        const primaryUuid = 'aaaaaaaa-1111-4222-8333-444444444444';
        const secretTitle = 'Confidential Acquisition Roadmap';
        createSummariesDb(sb.desktopSummaryDbPath, [
          { conversation_id: primaryUuid, title: secretTitle },
          { conversation_id: 'bbbbbbbb-1111-4222-8333-444444444444', title: 'Backend Cleanup' },
          { conversation_id: 'cccccccc-1111-4222-8333-444444444444', title: 'UI Polish' },
        ]);

        for (const [dir, id, model, disp] of [
          [sb.desktopConvDir, primaryUuid, 'claude-opus-4-6', 'Claude Opus 4.6'],
          [sb.desktopConvDir, 'bbbbbbbb-1111-4222-8333-444444444444', 'gemini-4-neon-high', 'Gemini 4 Neon (High)'],
          [sb.desktopConvDir, 'cccccccc-1111-4222-8333-444444444444', 'claude-sonnet-4-6', 'Claude Sonnet 4.6'],
          [sb.cliConvDir, 'dddddddd-1111-4222-8333-444444444444', 'gemini-2.5-pro', 'Gemini 2.5 Pro'],
        ]) {
          const db = createConvDb(join(dir, `${id}.db`));
          db.step(14, { metadata: pbTs(nowSec), payloadField: 19, payload: pbField(2, `Work inside C:\\Users\\secret\\${id}`) });
          db.step(15, { metadata: pbTs(nowSec + 5), payloadField: 20, payload: pbField(1, 'Completed step') });
          db.generation({
            model,
            displayName: disp,
            groups: [pbGroup(1, 3000), pbGroup(7, 1200, [['14: USER_INPUT', 500], ['15: PLANNER_RESPONSE', 700]])],
            usage: pbUsage({ inp: 2500, out: 400, cache: 1000 }),
            timing: pbTiming([1, 0], [2, 0]),
          });
          db.close();
        }

        const ls = await startMockLs({
          statusResp: {
            userStatus: {
              name: 'Secret User',
              email: 'secret-user@example.com',
              planStatus: { planInfo: { planName: 'Pro' } },
              userTier: { name: 'Google AI Ultra' },
              cascadeModelConfigData: { clientModelConfigs: [] },
            },
          },
          modelsResp: DEFAULT_MODELS_RESP,
          summaryResp: DEFAULT_SUMMARY_RESP,
        });
        sb.track(() => ls.close());

        const poison = makePoisonedPythonBinDir(sb.root);
        const sidecar = await startSidecar({
          sidecarDir: SIDECAR_DIR,
          mockLs: ls,
          preloadConfig: { conversationId: primaryUuid },
          env: {
            PATH: poison.pathEnv,
            ANTIGRAVITY_GEMINI_DIR: sb.geminiDir,
            ANTIGRAVITY_EXECUTABLE_DATA_DIR: sb.dataDir,
            ANTIGRAVITY_LS_ADDRESS: ls.url,
            ANTIGRAVITY_CSRF_TOKEN: ls.csrfToken,
          },
        });
        sb.track(() => sidecar.close());

        const repJson = await sidecar.getJson(`/api/report?conversationId=${primaryUuid}`);
        const quotaJson = await sidecar.getJson('/api/quota?refresh=true');
        const histJson = await sidecar.getJson('/api/history?refresh=true');
        const pricingJson = await sidecar.getJson('/api/pricing');
        assert.equal(histJson.sources.desktop, 3);
        assert.equal(histJson.sources.cli, 1);

        const browserRes = await runChromeBrowserTest({
          webDir: WEB_DIR,
          liveUrl: `${sidecar.baseUrl}/`,
          mockApi: {
            '/api/report': repJson,
            '/api/quota': quotaJson,
            '/api/history': histJson,
            '/api/pricing': pricingJson,
          },
          preloadConfig: { conversationId: primaryUuid },
          lang: 'en-US',
          testScript: `
            import { buildShareCardSvg } from '@web/views/share-card.js';
            await new Promise(r => setTimeout(r, 350));
            const ovText = document.getElementById('overview')?.textContent || '';
            document.getElementById('tab-quota')?.click();
            await new Promise(r => setTimeout(r, 200));
            const qText = document.getElementById('quota')?.textContent || '';
            document.getElementById('tab-history')?.click();
            await new Promise(r => setTimeout(r, 200));
            document.querySelector('[data-hview="list"]')?.click();
            await new Promise(r => setTimeout(r, 150));
            const search = document.getElementById('history-search');
            if (search) {
              search.value = 'Backend Cleanup';
              search.dispatchEvent(new Event('input', { bubbles: true }));
            }
            await new Promise(r => setTimeout(r, 100));
            const filteredCount = document.querySelectorAll('.conv-item').length;

            const h = ${JSON.stringify(histJson)};
            const svg = buildShareCardSvg({
              period: 'd30',
              totals: h.totals.d30,
              byModel: h.by_model,
              daily: h.daily,
              d7ByPool: h.d7_by_pool,
              by_conversation: h.by_conversation,
              lang: 'en',
              theme: 'dark',
            });
            const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const img = new Image();
            await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
            const canvas = document.createElement('canvas');
            canvas.width = img.naturalWidth || 800;
            canvas.height = img.naturalHeight || 420;
            canvas.getContext('2d').drawImage(img, 0, 0);
            const pngDataUrl = canvas.toDataURL('image/png');
            URL.revokeObjectURL(url);

            const el = document.createElement('script');
            el.id = '__e2e_result';
            el.type = 'application/json';
            el.textContent = JSON.stringify({
              errors: window.__e2eErrors,
              ovHasModel: ovText.includes('Claude Opus 4.6'),
              qHasPools: qText.includes('Gemini') && qText.includes('Claude'),
              filteredCount,
              svg,
              pngDataUrl,
            });
            document.body.appendChild(el);
          `,
        });
        assert.deepEqual(browserRes.consoleErrors, []);
        assert.equal(browserRes.result.ovHasModel, true);
        assert.equal(browserRes.result.qHasPools, true);
        assert.equal(browserRes.result.filteredCount, 1);
        assert.equal(browserRes.result.svg.includes(secretTitle), false);
        assert.equal(browserRes.result.svg.includes('C:\\Users\\secret'), false);
        const pngBuf = Buffer.from(browserRes.result.pngDataUrl.split(',')[1], 'base64');
        const pngInfo = parsePngInfo(pngBuf);
        assert.ok(pngInfo.width > 0 && pngInfo.height > 0);

        const cliRes = runCli(['--json'], {
          env: {
            PATH: poison.pathEnv,
            ANTIGRAVITY_GEMINI_DIR: sb.geminiDir,
            ANTIGRAVITY_EXECUTABLE_DATA_DIR: sb.dataDir,
          },
        });
        assert.equal(cliRes.status, 0, `CLI failed: ${cliRes.stderr}`);
        const cliJson = JSON.parse(cliRes.stdout);
        const cliHist = cliJson.history || cliJson;
        assert.equal(cliHist.totals.all.calls, histJson.totals.all.calls);
        assert.equal(cliHist.sources.desktop, 3);
        assert.equal(cliHist.sources.cli, 1);
        assert.equal(existsSync(poison.sentinelPath), false);
      } finally {
        await sb.cleanup();
      }
    },
  },
  {
    id: 'T4-03',
    tier: 4,
    feature: 'F5,F10,F11',
    title: 'Scenario 3: zh-CN vs en-US onboarding & bilingual visual documentation audit',
    async run() {
      assert.ok(existsSync(join(WEB_DIR, 'i18n.js')), 'web/i18n.js missing');
      const zhRes = await runChromeBrowserTest({
        webDir: WEB_DIR,
        lang: 'zh-CN',
        mockApi: { '/api/report': { error: 'no-conversation' }, '/api/quota': { error: 'unavailable', pools: [] } },
        testScript: `
          await new Promise(r => setTimeout(r, 250));
          const el = document.createElement('script');
          el.id = '__e2e_result';
          el.type = 'application/json';
          el.textContent = JSON.stringify({
            errors: window.__e2eErrors,
            lang: document.documentElement.lang,
            tab: document.getElementById('tab-overview')?.textContent?.trim(),
          });
          document.body.appendChild(el);
        `,
      });
      assert.deepEqual(zhRes.consoleErrors, []);
      assert.equal(zhRes.result.lang, 'zh-CN');
      assert.equal(zhRes.result.tab, '概览');

      const enRes = await runChromeBrowserTest({
        webDir: WEB_DIR,
        lang: 'en-US',
        mockApi: { '/api/report': { error: 'no-conversation' } },
        testScript: `
          await new Promise(r => setTimeout(r, 250));
          const initial = document.getElementById('tab-overview')?.textContent?.trim();
          document.querySelector('#lang [data-lang="zh"]')?.click();
          await new Promise(r => setTimeout(r, 100));
          const stored = localStorage.getItem('ctx.lang');
          const el = document.createElement('script');
          el.id = '__e2e_result';
          el.type = 'application/json';
          el.textContent = JSON.stringify({ errors: window.__e2eErrors, initial, stored });
          document.body.appendChild(el);
        `,
      });
      assert.deepEqual(enRes.consoleErrors, []);
      assert.equal(enRes.result.initial, 'Overview');
      assert.equal(enRes.result.stored, 'zh');

      const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
      const zhReadme = readFileSync(join(ROOT, 'README.zh-CN.md'), 'utf8');
      assert.ok(readme.includes('docs/img/hero-en.png'));
      assert.ok(zhReadme.includes('docs/img/hero-zh.png'));
      for (const rel of ['docs/img/en/overview.png', 'docs/img/en/quota.png', 'docs/img/en/history.png', 'docs/img/zh/overview.png', 'docs/img/zh/quota.png', 'docs/img/zh/history.png']) {
        parsePngInfo(readFileSync(join(ROOT, rel)));
      }
      const sp = parsePngInfo(readFileSync(join(ROOT, 'docs', 'img', 'social-preview.png')));
      assert.equal(sp.width, 1280);
      assert.equal(sp.height, 640);
    },
  },
  {
    id: 'T4-04',
    tier: 4,
    feature: 'F2,F3,F4,F8',
    title: 'Scenario 4: Offline / No-Language-Server degraded mode across CLI, Sidecar, and Web UI',
    async run() {
      assert.ok(existsSync(join(WEB_DIR, 'views', 'quota.js')), 'web/views/quota.js missing');
      const sb = createSandbox('t4-04-');
      try {
        const uuid = 'eeeeeeee-1111-4222-8333-555555555555';
        const nowSec = Math.floor(Date.now() / 1000) - 60;
        const db = createConvDb(join(sb.desktopConvDir, `${uuid}.db`));
        db.step(14, { metadata: pbTs(nowSec), payloadField: 19, payload: pbField(2, 'Offline check') });
        db.generation({
          groups: [pbGroup(1, 1000), pbGroup(7, 250, [['14: USER_INPUT', 250]])],
          usage: pbUsage({ inp: 800, out: 120 }),
        });
        db.close();

        const cliText = runCli([], {
          env: {
            ANTIGRAVITY_GEMINI_DIR: sb.geminiDir,
            ANTIGRAVITY_EXECUTABLE_DATA_DIR: sb.dataDir,
            ANTIGRAVITY_LS_ADDRESS: '',
            ANTIGRAVITY_CSRF_TOKEN: '',
          },
        });
        assert.equal(cliText.status, 0);

        const cliJson = runCli(['--json'], {
          env: {
            ANTIGRAVITY_GEMINI_DIR: sb.geminiDir,
            ANTIGRAVITY_EXECUTABLE_DATA_DIR: sb.dataDir,
            ANTIGRAVITY_LS_ADDRESS: '',
            ANTIGRAVITY_CSRF_TOKEN: '',
          },
        });
        assert.equal(cliJson.status, 0);
        JSON.parse(cliJson.stdout);

        const sidecar = await startSidecar({
          sidecarDir: SIDECAR_DIR,
          env: {
            ANTIGRAVITY_GEMINI_DIR: sb.geminiDir,
            ANTIGRAVITY_EXECUTABLE_DATA_DIR: sb.dataDir,
            ANTIGRAVITY_LS_ADDRESS: '',
            ANTIGRAVITY_CSRF_TOKEN: '',
          },
        });
        sb.track(() => sidecar.close());

        const rep = await sidecar.getJson(`/api/report?conversationId=${uuid}`);
        const quota = await sidecar.getJson('/api/quota');
        const hist = await sidecar.getJson('/api/history');
        const pricing = await sidecar.getJson('/api/pricing');
        assert.equal(rep.used_tokens, 1250);
        assert.equal(quota.error, 'unavailable');
        assert.equal(pricing.source, 'builtin');

        const res = await runChromeBrowserTest({
          webDir: WEB_DIR,
          lang: 'en-US',
          preloadConfig: { conversationId: uuid },
          mockApi: { '/api/report': rep, '/api/quota': quota, '/api/history': hist, '/api/pricing': pricing },
          testScript: `
            await new Promise(r => setTimeout(r, 300));
            const ovOk = /1\.3k|1,250/.test(document.getElementById('overview')?.textContent || '');
            document.getElementById('tab-quota')?.click();
            await new Promise(r => setTimeout(r, 150));
            const hasRetry = Boolean(document.querySelector('[data-retry="quota"]'));
            document.getElementById('tab-history')?.click();
            await new Promise(r => setTimeout(r, 150));
            const histOk = (document.getElementById('history')?.textContent || '').trim().length > 10;
            const el = document.createElement('script');
            el.id = '__e2e_result';
            el.type = 'application/json';
            el.textContent = JSON.stringify({ errors: window.__e2eErrors, ovOk, hasRetry, histOk });
            document.body.appendChild(el);
          `,
        });
        assert.deepEqual(res.consoleErrors, []);
        assert.equal(res.result.ovOk, true);
        assert.equal(res.result.hasRetry, true);
        assert.equal(res.result.histOk, true);
      } finally {
        await sb.cleanup();
      }
    },
  },
  {
    id: 'T4-05',
    tier: 4,
    feature: 'F1,F2,F7,F9',
    title: 'Scenario 5: CI Release Packaging, SHA256SUMS, and agy plugin install Layout Audit',
    async run() {
      const sb = createSandbox('t4-05-');
      try {
        const res = await runBuildRelease(sb.root, ROOT);
        const zipBuf = readFileSync(join(sb.root, 'agy-lens.zip'));
        const verBuf = readFileSync(join(sb.root, `agy-lens-v${res.version}.zip`));
        const sha1 = createHash('sha256').update(zipBuf).digest('hex');
        const sha2 = createHash('sha256').update(verBuf).digest('hex');
        const sums = readFileSync(join(sb.root, 'SHA256SUMS.txt'), 'utf8');
        assert.ok(sums.includes(`${sha1}  agy-lens.zip`));
        assert.ok(sums.includes(`${sha2}  agy-lens-v${res.version}.zip`));

        const entries = extractZipEntries(zipBuf);
        for (const name of entries.keys()) {
          assert.ok(name.startsWith('agy-lens/'));
          assert.equal(/\.(py|pyc)$/i.test(name), false);
          assert.equal(name.includes('/tests/') || name.includes('/docs/img/'), false);
        }

        const extDir = join(sb.root, 'ext');
        extractZipToDir(zipBuf, extDir);
        const pluginDir = join(extDir, 'agy-lens');
        const pj = JSON.parse(readFileSync(join(pluginDir, 'plugin.json'), 'utf8'));
        assert.equal(pj.name, 'agy-lens');

        const sidecar = await startSidecar({
          sidecarDir: join(pluginDir, 'sidecars', 'agy-lens'),
          env: { ANTIGRAVITY_GEMINI_DIR: sb.geminiDir, ANTIGRAVITY_EXECUTABLE_DATA_DIR: sb.dataDir },
        });
        sb.track(() => sidecar.close());
        assert.equal((await sidecar.request('/')).status, 200);

        const cliRes = runCli(['--help'], { cliPath: join(pluginDir, 'bin', 'cli.mjs'), cwd: pluginDir });
        assert.equal(cliRes.status, 0);

        const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
        const rel = readFileSync(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
        assert.equal(/\bpython\b|setup-python/i.test(ci + rel), false);
      } finally {
        await sb.cleanup();
      }
    },
  },
  {
    id: 'T4-06',
    tier: 4,
    feature: 'F1,F2,F7,F10,F11,F12',
    title: 'Scenario 6: Launch-Day Open-Source Repository Audit (zero Python, zero leaks, full docs/launch)',
    async run() {
      const gitCheck = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
      assert.equal(gitCheck.status, 0, 'git status failed');

      const allFiles = walkFiles(ROOT, { excludeDirs: new Set(['.git', 'node_modules', 'dist']) });
      for (const f of allFiles) {
        const rel = relPath(f);
        assert.equal(/\.(py|pyc|pyo)$/i.test(rel) || rel.includes('__pycache__/'), false, `Python artifact in repo: ${rel}`);
        if (rel.startsWith('tests/e2e/') || rel === 'CHANGELOG.md') continue;
        if (/\.(mjs|js|json|yml|yaml|md|html|css)$/i.test(rel)) {
          const txt = readFileSync(f, 'utf8');
          assert.equal(/sidecars\/context|antigravity-pulse/i.test(txt), false, `Legacy reference in ${rel}`);
        }
      }

      for (const req of [
        'plugin.json',
        'package.json',
        'README.md',
        'README.zh-CN.md',
        'CONTRIBUTING.md',
        'CHANGELOG.md',
        'docs/architecture.md',
        'docs/img/hero-en.png',
        'docs/img/hero-zh.png',
        'docs/img/social-preview.png',
        'docs/launch/github-metadata.md',
        'docs/launch/reddit-google-antigravity.md',
        'docs/launch/linux-do.md',
        'docs/launch/v2ex.md',
        'docs/launch/x-twitter.md',
        'docs/launch/awesome-antigravity-pr.md',
      ]) {
        assert.ok(existsSync(join(ROOT, req)), `Missing launch-day required file: ${req}`);
      }
    },
  },
];
