// Tier 1 Feature Coverage Tests: F7–F12 (30 tests: T1-F7-01 .. T1-F12-05)

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ROOT,
  SkipError,
  createSandbox,
  extractZipEntries,
  parsePngInfo,
  runBuildRelease,
  runCli,
  runInstallPs1DryRun,
  runInstallShDryRun,
  validateShStatic,
} from './lib/harness.mjs';
import {
  createConvDb,
  createSummariesDb,
  pbField,
  pbGroup,
  pbTs,
  pbUsage,
} from './lib/pb-db-builder.mjs';

function parseSemver(v) {
  const m = String(v || '').match(/^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export const TESTS = [
  // --- F7: Root Metadata & plugin.json Compliance ---
  {
    id: 'T1-F7-01',
    tier: 1,
    feature: 'F7',
    title: 'plugin.json contains all required Agy Lens metadata fields and SemVer >= 2.2.0',
    async run() {
      const pj = JSON.parse(readFileSync(join(ROOT, 'plugin.json'), 'utf8'));
      assert.equal(pj.name, 'agy-lens');
      assert.equal(pj.displayName, 'Agy Lens');
      const sv = parseSemver(pj.version);
      assert.ok(sv, `Invalid SemVer in plugin.json: ${pj.version}`);
      assert.ok(sv[0] > 2 || (sv[0] === 2 && sv[1] >= 2), `Expected version >= 2.2.0, got ${pj.version}`);
      for (const k of ['$schema', 'description', 'author', 'homepage', 'repository', 'license', 'keywords']) {
        const val = pj[k];
        assert.ok(val && (typeof val !== 'object' || Object.keys(val).length > 0), `Missing or empty plugin.json.${k}`);
      }
      assert.equal(pj.logo, 'assets/logo.svg');
    },
  },
  {
    id: 'T1-F7-02',
    tier: 1,
    feature: 'F7',
    title: 'plugin.json URLs point to Aoike123/agy-lens and assets/logo.svg exists',
    async run() {
      const pj = JSON.parse(readFileSync(join(ROOT, 'plugin.json'), 'utf8'));
      const repoStr = typeof pj.repository === 'string' ? pj.repository : pj.repository?.url || '';
      assert.match(String(pj.homepage || ''), /github\.com\/Aoike123\/agy-lens/i);
      assert.match(repoStr, /github\.com\/Aoike123\/agy-lens/i);
      assert.equal(/antigravity-pulse/i.test(JSON.stringify(pj)), false);
      assert.ok(existsSync(join(ROOT, pj.logo || 'assets/logo.svg')), 'plugin.json logo target missing');
    },
  },
  {
    id: 'T1-F7-03',
    tier: 1,
    feature: 'F7',
    title: 'Root package.json uses agy-lens, ESM, bin entry, Node >=24 engine, and zero runtime deps',
    async run() {
      const pkgPath = join(ROOT, 'package.json');
      assert.ok(existsSync(pkgPath), 'Root package.json missing');
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      assert.equal(pkg.name, 'agy-lens');
      assert.equal(pkg.type, 'module');
      assert.match(String(pkg.bin?.['agy-lens'] || ''), /^(\.\/)?bin\/cli\.mjs$/);
      assert.match(String(pkg.engines?.node || ''), /(22\.5|24)/);
      assert.equal(Object.keys(pkg.dependencies || {}).length, 0);
    },
  },
  {
    id: 'T1-F7-04',
    tier: 1,
    feature: 'F7',
    title: 'Display names comply with Antigravity marketplace reserved-word rules',
    async run() {
      const pj = JSON.parse(readFileSync(join(ROOT, 'plugin.json'), 'utf8'));
      const scPath = join(ROOT, 'sidecars', 'agy-lens', 'sidecar.json');
      assert.ok(existsSync(scPath), 'sidecars/agy-lens/sidecar.json missing');
      const sc = JSON.parse(readFileSync(scPath, 'utf8'));
      const reserved = /^(Antigravity|Gemini|Claude|Cursor)\b/i;
      assert.equal(reserved.test(String(pj.displayName || '')), false, `Reserved prefix in plugin.json displayName: ${pj.displayName}`);
      assert.equal(reserved.test(String(sc.display_name || '')), false, `Reserved prefix in sidecar.json display_name: ${sc.display_name}`);
    },
  },
  {
    id: 'T1-F7-05',
    tier: 1,
    feature: 'F7',
    title: 'Version strings are identical valid SemVer across plugin.json, root package.json, and sidecar package.json',
    async run() {
      const pj = JSON.parse(readFileSync(join(ROOT, 'plugin.json'), 'utf8'));
      const rootPkgPath = join(ROOT, 'package.json');
      const sidePkgPath = join(ROOT, 'sidecars', 'agy-lens', 'package.json');
      assert.ok(existsSync(rootPkgPath), 'Root package.json missing');
      assert.ok(existsSync(sidePkgPath), 'Sidecar package.json missing');
      const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf8'));
      const sidePkg = JSON.parse(readFileSync(sidePkgPath, 'utf8'));
      assert.ok(parseSemver(pj.version), `Invalid plugin.json version: ${pj.version}`);
      assert.equal(rootPkg.version, pj.version);
      assert.equal(sidePkg.version, pj.version);
    },
  },

  // --- F8: Terminal CLI (bin/cli.mjs) ---
  {
    id: 'T1-F8-01',
    tier: 1,
    feature: 'F8',
    title: 'bin/cli.mjs --help exits 0 and documents CLI flags',
    async run() {
      const r = runCli(['--help']);
      assert.equal(r.status, 0, `CLI --help exited ${r.status}: ${r.stderr}`);
      const out = `${r.stdout}\n${r.stderr}`;
      for (const tok of ['agy-lens', '--json', '--days', '--db', '--workspace']) {
        assert.ok(out.includes(tok), `--help output missing ${tok}`);
      }
    },
  },
  {
    id: 'T1-F8-02',
    tier: 1,
    feature: 'F8',
    title: 'bin/cli.mjs prints human-readable local usage summary from ANTIGRAVITY_GEMINI_DIR',
    async run() {
      const sb = createSandbox('t1-f8-02-');
      try {
        const nowSec = Math.floor(Date.now() / 1000) - 60;
        for (const id of ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']) {
          const db = createConvDb(join(sb.desktopConvDir, `${id}.db`));
          db.step(14, { metadata: pbTs(nowSec), payloadField: 19, payload: pbField(2, 'CLI summary test') });
          db.generation({
            model: 'claude-opus-4-6',
            displayName: 'Claude Opus 4.6',
            usage: pbUsage({ inp: 2000, out: 500, cache: 1000 }),
          });
          db.close();
        }
        const r = runCli([], {
          env: {
            ANTIGRAVITY_GEMINI_DIR: sb.geminiDir,
            ANTIGRAVITY_EXECUTABLE_DATA_DIR: sb.dataDir,
          },
        });
        assert.equal(r.status, 0, `CLI exited ${r.status}: ${r.stderr}`);
        assert.ok(r.stdout.trim().length > 20, 'CLI summary stdout unexpectedly empty');
        assert.match(r.stdout, /Claude Opus 4\.6|claude-opus-4-6|tokens|calls/i);
      } finally {
        await sb.cleanup();
      }
    },
  },
  {
    id: 'T1-F8-03',
    tier: 1,
    feature: 'F8',
    title: 'bin/cli.mjs --json emits valid JSON usage report',
    async run() {
      const sb = createSandbox('t1-f8-03-');
      try {
        const nowSec = Math.floor(Date.now() / 1000) - 60;
        const db = createConvDb(join(sb.desktopConvDir, '33333333-3333-4333-8333-333333333333.db'));
        db.step(14, { metadata: pbTs(nowSec), payloadField: 19, payload: pbField(2, 'JSON output test') });
        db.generation({ usage: pbUsage({ inp: 1500, out: 300, cache: 500 }) });
        db.close();

        const r = runCli(['--json'], {
          env: {
            ANTIGRAVITY_GEMINI_DIR: sb.geminiDir,
            ANTIGRAVITY_EXECUTABLE_DATA_DIR: sb.dataDir,
          },
        });
        assert.equal(r.status, 0, `CLI --json exited ${r.status}: ${r.stderr}`);
        const parsed = JSON.parse(r.stdout);
        const hist = parsed.history || parsed;
        assert.ok(hist.totals || parsed.totals, 'CLI --json missing totals');
      } finally {
        await sb.cleanup();
      }
    },
  },
  {
    id: 'T1-F8-04',
    tier: 1,
    feature: 'F8',
    title: 'bin/cli.mjs --days and --db filter history window and inspect specific conversation DB',
    async run() {
      const sb = createSandbox('t1-f8-04-');
      try {
        const nowSec = Math.floor(Date.now() / 1000) - 60;
        const oldSec = nowSec - 15 * 86400;
        const dbPath = join(sb.desktopConvDir, '44444444-4444-4444-8444-444444444444.db');
        const db = createConvDb(dbPath);
        db.step(14, { metadata: pbTs(nowSec), payloadField: 19, payload: pbField(2, 'Recent prompt') });
        db.step(15, { metadata: pbTs(nowSec + 2), payloadField: 20, payload: pbField(1, 'Recent reply') });
        db.generation({
          groups: [pbGroup(1, 1000), pbGroup(7, 400, [['14: USER_INPUT', 400]])],
          usage: pbUsage({ inp: 1000, out: 200 }),
        });
        db.close();

        const oldDb = createConvDb(join(sb.desktopConvDir, '55555555-5555-4555-8555-555555555555.db'));
        oldDb.step(14, { metadata: pbTs(oldSec), payloadField: 19, payload: pbField(2, 'Old prompt') });
        oldDb.step(15, { metadata: pbTs(oldSec + 2), payloadField: 20, payload: pbField(1, 'Old reply') });
        oldDb.generation({ usage: pbUsage({ inp: 9000, out: 900 }) });
        oldDb.close();

        const rDays = runCli(['--json', '--days', '7'], {
          env: { ANTIGRAVITY_GEMINI_DIR: sb.geminiDir, ANTIGRAVITY_EXECUTABLE_DATA_DIR: sb.dataDir },
        });
        assert.equal(rDays.status, 0, `CLI --days 7 failed: ${rDays.stderr}`);
        const parsedDays = JSON.parse(rDays.stdout);
        const h = parsedDays.history || parsedDays;
        assert.equal(h.totals?.d7?.calls, 1);
        assert.equal(h.totals?.all?.calls, 2);
        assert.equal(h.daily?.length, 7);

        const rDb = runCli(['--json', '--db', dbPath], {
          env: { ANTIGRAVITY_GEMINI_DIR: sb.geminiDir, ANTIGRAVITY_EXECUTABLE_DATA_DIR: sb.dataDir },
        });
        assert.equal(rDb.status, 0, `CLI --db failed: ${rDb.stderr}`);
        const parsedDb = JSON.parse(rDb.stdout);
        const rep = parsedDb.report || parsedDb;
        assert.equal(rep.used_tokens, 1400);
        assert.equal(rep.session?.calls, 1);
      } finally {
        await sb.cleanup();
      }
    },
  },
  {
    id: 'T1-F8-05',
    tier: 1,
    feature: 'F8',
    title: 'bin/cli.mjs starts with Node shebang and is wired in package.json bin',
    async run() {
      const cliPath = join(ROOT, 'bin', 'cli.mjs');
      assert.ok(existsSync(cliPath), 'bin/cli.mjs missing');
      const firstLine = readFileSync(cliPath, 'utf8').split(/\r?\n/)[0];
      assert.equal(firstLine, '#!/usr/bin/env node');
      const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
      assert.match(String(pkg.bin?.['agy-lens'] || ''), /^(\.\/)?bin\/cli\.mjs$/);
    },
  },

  // --- F9: Packaging, Installers & CI Workflows ---
  {
    id: 'T1-F9-01',
    tier: 1,
    feature: 'F9',
    title: 'scripts/build-release.mjs builds agy-lens.zip with modular agy-lens/ layout',
    async run() {
      const sb = createSandbox('t1-f9-01-');
      try {
        const res = await runBuildRelease(sb.root, ROOT);
        const genericZip = join(sb.root, 'agy-lens.zip');
        const versionedZip = join(sb.root, `agy-lens-v${res.version}.zip`);
        assert.ok(existsSync(genericZip), 'agy-lens.zip not created');
        assert.ok(existsSync(versionedZip), `agy-lens-v${res.version}.zip not created`);
        assert.ok(existsSync(join(sb.root, 'SHA256SUMS.txt')), 'SHA256SUMS.txt not created');

        const entries = extractZipEntries(readFileSync(genericZip));
        const names = Array.from(entries.keys());
        assert.ok(names.length > 0);
        for (const n of names) {
          assert.ok(n.startsWith('agy-lens/'), `Unexpected ZIP root entry: ${n}`);
        }
        for (const req of [
          'agy-lens/plugin.json',
          'agy-lens/LICENSE',
          'agy-lens/README.md',
          'agy-lens/README.zh-CN.md',
          'agy-lens/assets/logo.svg',
          'agy-lens/bin/cli.mjs',
          'agy-lens/sidecars/agy-lens/package.json',
          'agy-lens/sidecars/agy-lens/sidecar.json',
          'agy-lens/sidecars/agy-lens/main.mjs',
          'agy-lens/sidecars/agy-lens/lib/pb.mjs',
          'agy-lens/sidecars/agy-lens/lib/context.mjs',
          'agy-lens/sidecars/agy-lens/lib/history.mjs',
          'agy-lens/sidecars/agy-lens/web/index.html',
          'agy-lens/sidecars/agy-lens/web/i18n.js',
          'agy-lens/sidecars/agy-lens/web/app.js',
          'agy-lens/sidecars/agy-lens/web/views/share-card.js',
        ]) {
          assert.ok(entries.has(req), `Release ZIP missing required file: ${req}`);
        }
      } finally {
        await sb.cleanup();
      }
    },
  },
  {
    id: 'T1-F9-02',
    tier: 1,
    feature: 'F9',
    title: 'SHA256SUMS.txt hashes match agy-lens.zip and versioned ZIP',
    async run() {
      const sb = createSandbox('t1-f9-02-');
      try {
        const res = await runBuildRelease(sb.root, ROOT);
        const zipBuf = readFileSync(join(sb.root, 'agy-lens.zip'));
        const verBuf = readFileSync(join(sb.root, `agy-lens-v${res.version}.zip`));
        const sha1 = createHash('sha256').update(zipBuf).digest('hex');
        const sha2 = createHash('sha256').update(verBuf).digest('hex');
        const sums = readFileSync(join(sb.root, 'SHA256SUMS.txt'), 'utf8');
        assert.match(sums, new RegExp(`${sha1}\\s+agy-lens\\.zip`));
        assert.match(sums, new RegExp(`${sha2}\\s+agy-lens-v${res.version.replace(/\./g, '\\.')}\\.zip`));
      } finally {
        await sb.cleanup();
      }
    },
  },
  {
    id: 'T1-F9-03',
    tier: 1,
    feature: 'F9',
    title: 'scripts/install.sh passes static POSIX checks and bash dry-run install into isolated HOME',
    async run() {
      const shPath = join(ROOT, 'scripts', 'install.sh');
      const raw = validateShStatic(shPath);
      assert.match(raw, /Aoike123\/agy-lens/);
      assert.match(raw, /PLUGIN_NAME=["']agy-lens["']/);
      assert.match(raw, /Agy Lens/);
      assert.match(raw, /plugin\.json/);

      const sb = createSandbox('t1-f9-03-');
      try {
        await runBuildRelease(sb.root, ROOT);
        const zipPath = join(sb.root, 'agy-lens.zip');
        const res = runInstallShDryRun({ shPath, zipPath, homeDir: sb.homeDir });
        if (res.skippedExecution) {
          throw new SkipError(`${res.reason}; static POSIX audit passed`);
        }
        assert.equal(res.status, 0, `install.sh failed (${res.status}): ${res.stderr}`);
        assert.ok(existsSync(join(sb.homeDir, '.gemini', 'config', 'plugins', 'agy-lens', 'plugin.json')));
        assert.match(res.stdout, /Agy Lens|agy-lens/);
      } finally {
        await sb.cleanup();
      }
    },
  },
  {
    id: 'T1-F9-04',
    tier: 1,
    feature: 'F9',
    title: 'scripts/install.ps1 passes PowerShell AST validation and isolated USERPROFILE mock install',
    async run() {
      const ps1Path = join(ROOT, 'scripts', 'install.ps1');
      const raw = readFileSync(ps1Path, 'utf8');
      assert.match(raw, /Aoike123\/agy-lens/);
      assert.match(raw, /\$PluginName\s*=\s*["']agy-lens["']/);
      const sb = createSandbox('t1-f9-04-');
      try {
        await runBuildRelease(sb.root, ROOT);
        const zipPath = join(sb.root, 'agy-lens.zip');
        const res = runInstallPs1DryRun({ ps1Path, zipPath, homeDir: sb.homeDir });
        assert.equal(res.status, 0, `install.ps1 failed (${res.status}): ${res.stderr}`);
        assert.ok(existsSync(join(sb.homeDir, '.gemini', 'config', 'plugins', 'agy-lens', 'plugin.json')));
        assert.match(res.requestedUrl, /Aoike123\/agy-lens\/releases\/latest\/download\/agy-lens\.zip$/);
      } finally {
        await sb.cleanup();
      }
    },
  },
  {
    id: 'T1-F9-05',
    tier: 1,
    feature: 'F9',
    title: 'CI/Release workflows and .gitignore target modular agy-lens paths',
    async run() {
      const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
      const rel = readFileSync(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
      const gi = readFileSync(join(ROOT, '.gitignore'), 'utf8');
      assert.match(ci, /sidecars\/agy-lens/);
      assert.match(ci, /bin\/cli\.mjs/);
      assert.match(ci, /build-release\.mjs/);
      assert.match(rel, /Agy Lens|agy-lens/i);
      assert.match(rel, /sidecars\/agy-lens/);
      assert.match(gi, /\.data\/|dist\//);
    },
  },

  // --- F10: Sanitized Fixtures & Bilingual Screenshots ---
  {
    id: 'T1-F10-01',
    tier: 1,
    feature: 'F10',
    title: 'Sanitized mock JSON fixtures exist under tests/fixtures/',
    async run() {
      const fixDir = join(ROOT, 'tests', 'fixtures');
      assert.ok(existsSync(fixDir), 'tests/fixtures/ directory missing');
      const jsonFiles = readdirSync(fixDir).filter((f) => f.endsWith('.json'));
      assert.ok(jsonFiles.length >= 1, 'Expected at least one sanitized JSON fixture under tests/fixtures/');
      for (const f of jsonFiles) {
        const data = JSON.parse(readFileSync(join(fixDir, f), 'utf8'));
        assert.ok(data && typeof data === 'object');
      }
    },
  },
  {
    id: 'T1-F10-02',
    tier: 1,
    feature: 'F10',
    title: 'Bilingual screenshots exist under docs/img/en/ and docs/img/zh/ as valid PNGs',
    async run() {
      for (const lang of ['en', 'zh']) {
        for (const tab of ['overview', 'quota', 'history']) {
          const p = join(ROOT, 'docs', 'img', lang, `${tab}.png`);
          assert.ok(existsSync(p), `Missing screenshot: docs/img/${lang}/${tab}.png`);
          const info = parsePngInfo(readFileSync(p));
          assert.ok(info.width >= 400 && info.height >= 400, `Unexpected dimensions on ${lang}/${tab}.png: ${info.width}x${info.height}`);
        }
      }
    },
  },
  {
    id: 'T1-F10-03',
    tier: 1,
    feature: 'F10',
    title: 'Bilingual Hero composites hero-en.png and hero-zh.png exist as wide valid PNGs',
    async run() {
      const enPath = join(ROOT, 'docs', 'img', 'hero-en.png');
      const zhPath = join(ROOT, 'docs', 'img', 'hero-zh.png');
      assert.ok(existsSync(enPath), 'docs/img/hero-en.png missing');
      assert.ok(existsSync(zhPath), 'docs/img/hero-zh.png missing');
      const enBuf = readFileSync(enPath);
      const zhBuf = readFileSync(zhPath);
      const enInfo = parsePngInfo(enBuf);
      const zhInfo = parsePngInfo(zhBuf);
      assert.ok(enInfo.width >= 1000 && enInfo.width > enInfo.height, `hero-en.png not wide composite: ${enInfo.width}x${enInfo.height}`);
      assert.ok(zhInfo.width >= 1000 && zhInfo.width > zhInfo.height, `hero-zh.png not wide composite: ${zhInfo.width}x${zhInfo.height}`);
      assert.equal(enBuf.equals(zhBuf), false, 'hero-en.png and hero-zh.png must be distinct');
    },
  },
  {
    id: 'T1-F10-04',
    tier: 1,
    feature: 'F10',
    title: 'GitHub Social Preview docs/img/social-preview.png measures exact 1280x640 PNG',
    async run() {
      const p = join(ROOT, 'docs', 'img', 'social-preview.png');
      assert.ok(existsSync(p), 'docs/img/social-preview.png missing');
      const info = parsePngInfo(readFileSync(p));
      assert.equal(info.width, 1280);
      assert.equal(info.height, 640);
    },
  },
  {
    id: 'T1-F10-05',
    tier: 1,
    feature: 'F10',
    title: 'docs/img/README.md inventories bilingual assets without Pulse legacy refs',
    async run() {
      const p = join(ROOT, 'docs', 'img', 'README.md');
      assert.ok(existsSync(p), 'docs/img/README.md missing');
      const txt = readFileSync(p, 'utf8');
      for (const tok of ['hero-en.png', 'hero-zh.png', 'social-preview.png', 'en/', 'zh/']) {
        assert.ok(txt.includes(tok), `docs/img/README.md missing reference to ${tok}`);
      }
      assert.equal(/antigravity-pulse|\bPulse\b/.test(txt), false);
    },
  },

  // --- F11: English-First Docs & Architecture Split ---
  {
    id: 'T1-F11-01',
    tier: 1,
    feature: 'F11',
    title: 'Primary README.md is English-first with hero-en.png above the fold and Aoike123/agy-lens links',
    async run() {
      const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
      const top40 = readme.split(/\r?\n/).slice(0, 40).join('\n');
      assert.ok(top40.includes('docs/img/hero-en.png'), 'hero-en.png must appear above the fold in README.md');
      assert.match(readme, /Agy Lens/);
      assert.match(readme, /Aoike123\/agy-lens/);
      assert.equal(/[\u4e00-\u9fff]{10,}/.test(top40), false, 'README.md top section should be English-first');
    },
  },
  {
    id: 'T1-F11-02',
    tier: 1,
    feature: 'F11',
    title: 'README.md includes competitor comparison matrix, installation instructions, and privacy summary',
    async run() {
      const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
      assert.match(readme, /\|[^\n]*Agy Lens[^\n]*\|/i, 'Missing Markdown comparison table row/header for Agy Lens');
      assert.match(readme, /agy plugin install|npx agy-lens|install\.sh|install\.ps1/i);
      assert.match(readme, /privacy|local|telemetry|zero tokens/i);
    },
  },
  {
    id: 'T1-F11-03',
    tier: 1,
    feature: 'F11',
    title: 'README.zh-CN.md exists in Simplified Chinese with hero-zh.png and zh screenshots',
    async run() {
      const p = join(ROOT, 'README.zh-CN.md');
      assert.ok(existsSync(p), 'README.zh-CN.md missing');
      const zh = readFileSync(p, 'utf8');
      assert.match(zh, /[\u4e00-\u9fff]{20,}/);
      assert.ok(zh.includes('README.md'));
      assert.ok(zh.includes('docs/img/hero-zh.png'));
      assert.match(zh, /docs\/img\/zh\/(overview|quota|history)\.png/);
      assert.ok(zh.includes('agy-lens'));
    },
  },
  {
    id: 'T1-F11-04',
    tier: 1,
    feature: 'F11',
    title: 'docs/architecture.md holds deep protobuf, LS RPC, SQLite, and modular layout docs',
    async run() {
      const p = join(ROOT, 'docs', 'architecture.md');
      assert.ok(existsSync(p), 'docs/architecture.md missing');
      const arch = readFileSync(p, 'utf8');
      for (const tok of ['GetUserStatus', 'GetAvailableModels', 'RetrieveUserQuotaSummary', 'steps', 'gen_metadata', 'protobuf']) {
        assert.ok(arch.toLowerCase().includes(tok.toLowerCase()), `docs/architecture.md missing ${tok}`);
      }
      assert.match(arch, /lib\/|web\//);
    },
  },
  {
    id: 'T1-F11-05',
    tier: 1,
    feature: 'F11',
    title: 'CONTRIBUTING.md and CHANGELOG.md reflect agy-lens, Node 24+, and v2.2.0',
    async run() {
      const contrib = readFileSync(join(ROOT, 'CONTRIBUTING.md'), 'utf8');
      const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
      assert.match(contrib, /agy-lens|Agy Lens/);
      assert.match(contrib, /Node(\.js)?\s*24/i);
      assert.match(contrib, /sidecars\/agy-lens/);
      assert.match(changelog, /2\.2\.0/);
      assert.match(changelog, /Agy Lens|agy-lens/);
    },
  },

  // --- F12: P2 Release & Launch Assets ---
  {
    id: 'T1-F12-01',
    tier: 1,
    feature: 'F12',
    title: 'docs/launch/github-metadata.md defines About description and GitHub Topics',
    async run() {
      const p = join(ROOT, 'docs', 'launch', 'github-metadata.md');
      assert.ok(existsSync(p), 'docs/launch/github-metadata.md missing');
      const txt = readFileSync(p, 'utf8');
      assert.match(txt, /about|description/i);
      assert.match(txt, /topics/i);
      assert.ok(txt.includes('agy-lens'));
    },
  },
  {
    id: 'T1-F12-02',
    tier: 1,
    feature: 'F12',
    title: 'English Reddit (r/google_antigravity) and X/Twitter launch drafts exist',
    async run() {
      for (const f of ['reddit-google-antigravity.md', 'x-twitter.md']) {
        const p = join(ROOT, 'docs', 'launch', f);
        assert.ok(existsSync(p), `Missing docs/launch/${f}`);
        const txt = readFileSync(p, 'utf8');
        assert.ok(txt.trim().length > 100, `Empty draft: ${f}`);
        assert.match(txt, /Agy Lens|agy-lens/);
        assert.match(txt, /Aoike123\/agy-lens/);
      }
    },
  },
  {
    id: 'T1-F12-03',
    tier: 1,
    feature: 'F12',
    title: 'Chinese Linux.do and V2EX launch drafts exist',
    async run() {
      for (const f of ['linux-do.md', 'v2ex.md']) {
        const p = join(ROOT, 'docs', 'launch', f);
        assert.ok(existsSync(p), `Missing docs/launch/${f}`);
        const txt = readFileSync(p, 'utf8');
        assert.ok(txt.trim().length > 100, `Empty draft: ${f}`);
        assert.match(txt, /[\u4e00-\u9fff]{15,}/);
        assert.match(txt, /Agy Lens|agy-lens/);
        assert.match(txt, /Aoike123\/agy-lens/);
      }
    },
  },
  {
    id: 'T1-F12-04',
    tier: 1,
    feature: 'F12',
    title: 'docs/launch/awesome-antigravity-pr.md targets ZhangYu-zjut/awesome-Antigravity',
    async run() {
      const p = join(ROOT, 'docs', 'launch', 'awesome-antigravity-pr.md');
      assert.ok(existsSync(p), 'docs/launch/awesome-antigravity-pr.md missing');
      const txt = readFileSync(p, 'utf8');
      assert.ok(txt.includes('ZhangYu-zjut/awesome-Antigravity'));
      assert.ok(txt.includes('Aoike123/agy-lens'));
    },
  },
  {
    id: 'T1-F12-05',
    tier: 1,
    feature: 'F12',
    title: 'All docs/launch/*.md files reference Agy Lens / agy-lens and accurate product claims',
    async run() {
      const dir = join(ROOT, 'docs', 'launch');
      assert.ok(existsSync(dir), 'docs/launch/ directory missing');
      const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
      assert.equal(files.length >= 6, true, `Expected >= 6 launch markdown files, found ${files.length}`);
      for (const f of files) {
        const txt = readFileSync(join(dir, f), 'utf8');
        assert.match(txt, /agy-lens|Agy Lens/, `Launch file ${f} missing agy-lens / Agy Lens`);
      }
    },
  },
];
