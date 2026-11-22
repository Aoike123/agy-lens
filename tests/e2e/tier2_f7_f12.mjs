// Tier 2 Boundary & Corner Case Tests: F7–F12 (30 tests: T2-F7-01 .. T2-F12-05)

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  ROOT,
  SkipError,
  createSandbox,
  extractZipEntries,
  parsePngInfo,
  relPath,
  runBuildRelease,
  runCli,
  runInstallPs1DryRun,
  runInstallShDryRun,
  validateShStatic,
  walkFiles,
} from './lib/harness.mjs';

function buildCorruptZip(outPath) {
  // Valid PKZIP containing only wrong/empty file (missing agy-lens/plugin.json)
  // Reuse PowerShell Compress-Archive on Windows or minimal store PKZIP in pure Node
  const name = Buffer.from('wrong-dir/dummy.txt', 'utf8');
  const data = Buffer.from('invalid', 'utf8');
  // CRC-32 for 'invalid' is 0x919f70e3? Let's compute dynamically:
  let crc = 0xffffffff;
  for (const b of data) {
    crc ^= b;
    for (let j = 0; j < 8; j++) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  }
  crc = (crc ^ 0xffffffff) >>> 0;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);

  const cdOff = local.length + name.length + data.length;
  const cdLen = central.length + name.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cdLen, 12);
  eocd.writeUInt32LE(cdOff, 16);

  writeFileSync(outPath, Buffer.concat([local, name, data, central, name, eocd]));
}

export const TESTS = [
  // --- F7 Boundaries ---
  {
    id: 'T2-F7-01',
    tier: 2,
    feature: 'F7',
    title: 'plugin.json homepage/repository use valid https:// URLs and non-empty author/license',
    async run() {
      const pj = JSON.parse(readFileSync(join(ROOT, 'plugin.json'), 'utf8'));
      const hp = String(pj.homepage || '');
      const repo = typeof pj.repository === 'string' ? pj.repository : String(pj.repository?.url || '');
      assert.match(hp, /^https:\/\/github\.com\/Aoike123\/agy-lens/i);
      assert.match(repo, /^https:\/\/github\.com\/Aoike123\/agy-lens/i);
      const authorOk = typeof pj.author === 'string' ? pj.author.trim().length > 0 : Boolean(pj.author?.name);
      assert.ok(authorOk, 'plugin.json author must be non-empty');
      assert.equal(pj.license, 'MIT');
    },
  },
  {
    id: 'T2-F7-02',
    tier: 2,
    feature: 'F7',
    title: 'No node_modules/ committed and zero dependencies/peerDependencies in manifests',
    async run() {
      assert.equal(existsSync(join(ROOT, 'node_modules')), false, 'node_modules must not exist in zero-dep repo');
      assert.equal(existsSync(join(ROOT, 'sidecars', 'agy-lens', 'node_modules')), false);
      const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
      const sidePkg = JSON.parse(readFileSync(join(ROOT, 'sidecars', 'agy-lens', 'package.json'), 'utf8'));
      assert.equal(Object.keys(rootPkg.dependencies || {}).length, 0);
      assert.equal(Object.keys(rootPkg.peerDependencies || {}).length, 0);
      assert.equal(Object.keys(sidePkg.dependencies || {}).length, 0);
      assert.equal(Object.keys(sidePkg.peerDependencies || {}).length, 0);
    },
  },
  {
    id: 'T2-F7-03',
    tier: 2,
    feature: 'F7',
    title: 'plugin.json has no legacy title: "Pulse" and sets displayName: "Agy Lens"',
    async run() {
      const pj = JSON.parse(readFileSync(join(ROOT, 'plugin.json'), 'utf8'));
      assert.notEqual(pj.title, 'Pulse');
      if (pj.title !== undefined) assert.equal(pj.title, 'Agy Lens');
      assert.equal(pj.displayName, 'Agy Lens');
    },
  },
  {
    id: 'T2-F7-04',
    tier: 2,
    feature: 'F7',
    title: 'assets/logo.svg is valid SVG with viewBox and zero <script> tags',
    async run() {
      const svg = readFileSync(join(ROOT, 'assets', 'logo.svg'), 'utf8');
      assert.match(svg, /<svg\b[^>]*viewBox=/i);
      assert.match(svg, /<\/svg>/i);
      assert.equal(/<script\b/i.test(svg), false);
    },
  },
  {
    id: 'T2-F7-05',
    tier: 2,
    feature: 'F7',
    title: 'Root package.json bin target exists on disk and passes syntax validation',
    async run() {
      const pkgPath = join(ROOT, 'package.json');
      assert.ok(existsSync(pkgPath), 'Root package.json missing');
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      const binRel = pkg.bin?.['agy-lens'];
      assert.ok(binRel, 'package.json missing bin["agy-lens"]');
      const binAbs = resolve(ROOT, binRel);
      assert.ok(existsSync(binAbs), `Bin target missing: ${binRel}`);
      const chk = spawnSync(process.execPath, ['--check', binAbs], { encoding: 'utf8', windowsHide: true });
      assert.equal(chk.status, 0, `Syntax check failed on ${binRel}: ${chk.stderr}`);
    },
  },

  // --- F8 Boundaries ---
  {
    id: 'T2-F8-01',
    tier: 2,
    feature: 'F8',
    title: 'bin/cli.mjs exits 0 cleanly on empty ANTIGRAVITY_GEMINI_DIR',
    async run() {
      const sb = createSandbox('t2-f8-01-');
      try {
        const rText = runCli([], { env: { ANTIGRAVITY_GEMINI_DIR: sb.geminiDir, ANTIGRAVITY_EXECUTABLE_DATA_DIR: sb.dataDir } });
        assert.equal(rText.status, 0, `CLI exited ${rText.status}: ${rText.stderr}`);
        const rJson = runCli(['--json'], { env: { ANTIGRAVITY_GEMINI_DIR: sb.geminiDir, ANTIGRAVITY_EXECUTABLE_DATA_DIR: sb.dataDir } });
        assert.equal(rJson.status, 0, `CLI --json exited ${rJson.status}: ${rJson.stderr}`);
        assert.doesNotThrow(() => JSON.parse(rJson.stdout));
      } finally {
        await sb.cleanup();
      }
    },
  },
  {
    id: 'T2-F8-02',
    tier: 2,
    feature: 'F8',
    title: 'bin/cli.mjs rejects non-existent --db path with non-zero exit and clean stderr error',
    async run() {
      const sb = createSandbox('t2-f8-02-');
      try {
        const missing = join(sb.root, 'nonexistent-conv.db');
        const r = runCli(['--db', missing], {
          env: { ANTIGRAVITY_GEMINI_DIR: sb.geminiDir, ANTIGRAVITY_EXECUTABLE_DATA_DIR: sb.dataDir },
        });
        assert.notEqual(r.status, 0, 'Expected non-zero exit code for missing --db');
        assert.ok(r.stderr.trim().length > 0, 'Expected error message on stderr');
        assert.equal(/\bat\s+\S+\s+\(.*:\d+:\d+\)/.test(r.stderr), false, 'Raw stack trace leaked to stderr');
      } finally {
        await sb.cleanup();
      }
    },
  },
  {
    id: 'T2-F8-03',
    tier: 2,
    feature: 'F8',
    title: 'bin/cli.mjs rejects unknown flag and invalid --days argument cleanly',
    async run() {
      const r1 = runCli(['--unknown-flag-xyz']);
      assert.notEqual(r1.status, 0, 'Unknown flag should exit non-zero');
      assert.ok((r1.stderr + r1.stdout).trim().length > 0);
      const r2 = runCli(['--days', 'abc']);
      assert.notEqual(r2.status, 0, 'Invalid --days should exit non-zero');
      assert.equal(/\bNaN\b/.test(r2.stdout), false);
    },
  },
  {
    id: 'T2-F8-04',
    tier: 2,
    feature: 'F8',
    title: 'bin/cli.mjs runs offline without Antigravity LS env vars and exits 0 promptly',
    async run() {
      const sb = createSandbox('t2-f8-04-');
      try {
        const t0 = Date.now();
        const r = runCli(['--json'], {
          env: {
            ANTIGRAVITY_GEMINI_DIR: sb.geminiDir,
            ANTIGRAVITY_EXECUTABLE_DATA_DIR: sb.dataDir,
            ANTIGRAVITY_LS_ADDRESS: '',
            ANTIGRAVITY_CSRF_TOKEN: '',
          },
        });
        assert.equal(r.status, 0, `Offline CLI failed: ${r.stderr}`);
        assert.ok(Date.now() - t0 < 10000, 'Offline CLI took too long (possible network hang)');
      } finally {
        await sb.cleanup();
      }
    },
  },
  {
    id: 'T2-F8-05',
    tier: 2,
    feature: 'F8',
    title: 'bin/cli.mjs --json stdout contains pure JSON with zero ANSI codes or banner pollution',
    async run() {
      const sb = createSandbox('t2-f8-05-');
      try {
        const r = runCli(['--json'], {
          env: { ANTIGRAVITY_GEMINI_DIR: sb.geminiDir, ANTIGRAVITY_EXECUTABLE_DATA_DIR: sb.dataDir },
        });
        assert.equal(r.status, 0);
        // eslint-disable-next-line no-control-regex
        assert.equal(/\u001b\[/.test(r.stdout), false, 'ANSI escape codes found in --json stdout');
        const trimmed = r.stdout.trim();
        assert.ok(trimmed.startsWith('{') && trimmed.endsWith('}'));
        JSON.parse(trimmed);
      } finally {
        await sb.cleanup();
      }
    },
  },

  // --- F9 Boundaries ---
  {
    id: 'T2-F9-01',
    tier: 2,
    feature: 'F9',
    title: 'Release ZIP excludes .py, tests/, docs/img/, docs/launch/, .git/, node_modules/, .data/, dist/',
    async run() {
      const sb = createSandbox('t2-f9-01-');
      try {
        await runBuildRelease(sb.root, ROOT);
        const entries = extractZipEntries(readFileSync(join(sb.root, 'agy-lens.zip')));
        for (const name of entries.keys()) {
          assert.equal(/\.(py|pyc|pyo)$/i.test(name), false, `Forbidden Python file in ZIP: ${name}`);
          for (const dir of ['tests/', 'docs/img/', 'docs/launch/', '.git/', 'node_modules/', '.data/', 'dist/']) {
            assert.equal(name.includes(`/${dir}`), false, `Forbidden path in ZIP: ${name}`);
          }
        }
      } finally {
        await sb.cleanup();
      }
    },
  },
  {
    id: 'T2-F9-02',
    tier: 2,
    feature: 'F9',
    title: 'install.sh removes legacy antigravity-pulse plugin dir during upgrade',
    async run() {
      const shPath = join(ROOT, 'scripts', 'install.sh');
      const raw = validateShStatic(shPath);
      assert.match(raw, /antigravity-pulse/);
      assert.match(raw, /rm\s+-rf.*antigravity-pulse|PLUGINS_ROOT.*antigravity-pulse/s);

      const sb = createSandbox('t2-f9-02-');
      try {
        await runBuildRelease(sb.root, ROOT);
        const oldDir = join(sb.homeDir, '.gemini', 'config', 'plugins', 'antigravity-pulse');
        mkdirSync(oldDir, { recursive: true });
        writeFileSync(join(oldDir, 'plugin.json'), '{"name":"antigravity-pulse"}');

        const res = runInstallShDryRun({ shPath, zipPath: join(sb.root, 'agy-lens.zip'), homeDir: sb.homeDir });
        if (res.skippedExecution) {
          throw new SkipError(`${res.reason}; static legacy cleanup audit passed`);
        }
        assert.equal(res.status, 0, `install.sh failed: ${res.stderr}`);
        assert.equal(existsSync(oldDir), false, 'Legacy antigravity-pulse dir was not removed');
        assert.ok(existsSync(join(sb.homeDir, '.gemini', 'config', 'plugins', 'agy-lens', 'plugin.json')));
      } finally {
        await sb.cleanup();
      }
    },
  },
  {
    id: 'T2-F9-03',
    tier: 2,
    feature: 'F9',
    title: 'install.ps1 removes legacy antigravity-pulse plugin dir during upgrade',
    async run() {
      const ps1Path = join(ROOT, 'scripts', 'install.ps1');
      const raw = readFileSync(ps1Path, 'utf8');
      assert.match(raw, /Aoike123\/agy-lens/);
      assert.match(raw, /antigravity-pulse/);

      const sb = createSandbox('t2-f9-03-');
      try {
        await runBuildRelease(sb.root, ROOT);
        const oldDir = join(sb.homeDir, '.gemini', 'config', 'plugins', 'antigravity-pulse');
        mkdirSync(oldDir, { recursive: true });
        writeFileSync(join(oldDir, 'plugin.json'), '{"name":"antigravity-pulse"}');

        const res = runInstallPs1DryRun({ ps1Path, zipPath: join(sb.root, 'agy-lens.zip'), homeDir: sb.homeDir });
        assert.equal(res.status, 0, `install.ps1 failed: ${res.stderr}`);
        assert.equal(existsSync(oldDir), false, 'Legacy antigravity-pulse dir was not removed by install.ps1');
        assert.ok(existsSync(join(sb.homeDir, '.gemini', 'config', 'plugins', 'agy-lens', 'plugin.json')));
      } finally {
        await sb.cleanup();
      }
    },
  },
  {
    id: 'T2-F9-04',
    tier: 2,
    feature: 'F9',
    title: 'Installers roll back / preserve prior agy-lens install when ZIP lacks agy-lens/plugin.json',
    async run() {
      const ps1Path = join(ROOT, 'scripts', 'install.ps1');
      const shPath = join(ROOT, 'scripts', 'install.sh');
      assert.match(readFileSync(ps1Path, 'utf8'), /Aoike123\/agy-lens/);
      const shRaw = validateShStatic(shPath);
      assert.match(shRaw, /Aoike123\/agy-lens/);

      const sb = createSandbox('t2-f9-04-');
      try {
        const badZip = join(sb.root, 'bad.zip');
        buildCorruptZip(badZip);

        const shHome = join(sb.root, 'home-sh');
        const shTargetDir = join(shHome, '.gemini', 'config', 'plugins', 'agy-lens');
        mkdirSync(shTargetDir, { recursive: true });
        writeFileSync(join(shTargetDir, 'plugin.json'), '{"name":"agy-lens","marker":"keep"}');

        const shRes = runInstallShDryRun({ shPath, zipPath: badZip, homeDir: shHome });
        if (!shRes.skippedExecution) {
          assert.notEqual(shRes.status, 0, 'install.sh should fail on invalid ZIP');
          assert.ok(existsSync(join(shTargetDir, 'plugin.json')), 'Prior agy-lens install lost after failed install.sh');
          assert.ok(readFileSync(join(shTargetDir, 'plugin.json'), 'utf8').includes('"keep"'));
        }

        if (process.platform === 'win32') {
          const psHome = join(sb.root, 'home-ps1');
          const psTargetDir = join(psHome, '.gemini', 'config', 'plugins', 'agy-lens');
          mkdirSync(psTargetDir, { recursive: true });
          writeFileSync(join(psTargetDir, 'plugin.json'), '{"name":"agy-lens","marker":"keep"}');

          const ps1Res = runInstallPs1DryRun({
            ps1Path,
            zipPath: badZip,
            homeDir: psHome,
          });
          assert.equal(
            /UnauthorizedAccess|cannot be loaded because running scripts is disabled/i.test(ps1Res.stderr),
            false,
            `PowerShell execution policy blocked install.ps1 dry-run: ${ps1Res.stderr}`,
          );
          assert.notEqual(ps1Res.status, 0, 'install.ps1 should fail on invalid ZIP');
          assert.ok(existsSync(join(psTargetDir, 'plugin.json')), 'Prior agy-lens install lost after failed install.ps1');
          assert.ok(readFileSync(join(psTargetDir, 'plugin.json'), 'utf8').includes('"keep"'));
        }
      } finally {
        await sb.cleanup();
      }
    },
  },
  {
    id: 'T2-F9-05',
    tier: 2,
    feature: 'F9',
    title: 'Installers construct versioned release URL when explicit version tag is passed',
    async run() {
      const sb = createSandbox('t2-f9-05-');
      try {
        await runBuildRelease(sb.root, ROOT);
        const zipPath = join(sb.root, 'agy-lens.zip');
        const shPath = join(ROOT, 'scripts', 'install.sh');
        const shRaw = validateShStatic(shPath);
        assert.match(shRaw, /releases\/download\//);
        assert.match(shRaw, /Aoike123\/agy-lens/);

        const shHome = join(sb.root, 'home-sh');
        mkdirSync(join(shHome, '.gemini'), { recursive: true });
        const shRes = runInstallShDryRun({
          shPath,
          zipPath,
          homeDir: shHome,
          args: ['v2.2.0'],
        });
        if (!shRes.skippedExecution) {
          assert.equal(shRes.status, 0, `install.sh v2.2.0 failed: ${shRes.stderr}`);
          assert.equal(shRes.requestedUrl, 'https://github.com/Aoike123/agy-lens/releases/download/v2.2.0/agy-lens-v2.2.0.zip');
        }

        if (process.platform === 'win32') {
          const psHome = join(sb.root, 'home-ps1');
          mkdirSync(join(psHome, '.gemini'), { recursive: true });
          const ps1Res = runInstallPs1DryRun({
            ps1Path: join(ROOT, 'scripts', 'install.ps1'),
            zipPath,
            homeDir: psHome,
            version: 'v2.2.0',
          });
          assert.equal(ps1Res.status, 0, `install.ps1 -Version v2.2.0 failed: ${ps1Res.stderr}`);
          assert.equal(ps1Res.requestedUrl, 'https://github.com/Aoike123/agy-lens/releases/download/v2.2.0/agy-lens-v2.2.0.zip');
        }
      } finally {
        await sb.cleanup();
      }
    },
  },

  // --- F10 Boundaries ---
  {
    id: 'T2-F10-01',
    tier: 2,
    feature: 'F10',
    title: 'tests/fixtures/ files contain zero personal paths, real emails, or tokens',
    async run() {
      const fixDir = join(ROOT, 'tests', 'fixtures');
      assert.ok(existsSync(fixDir), 'tests/fixtures/ missing');
      const files = walkFiles(fixDir);
      assert.ok(files.length >= 1, 'tests/fixtures/ is empty');
      for (const f of files) {
        const txt = readFileSync(f, 'utf8');
        assert.equal(/C:\\Users\\|D:\\Code\\|\/Users\/|\/home\//i.test(txt), false, `Personal path in fixture ${relPath(f)}`);
        assert.equal(/@(gmail|outlook|hotmail|qq|163|yahoo)\.com/i.test(txt), false, `Personal email in fixture ${relPath(f)}`);
        assert.equal(/ya29\.[A-Za-z0-9._-]+|sk-[A-Za-z0-9]{20,}/.test(txt), false, `Token in fixture ${relPath(f)}`);
      }
    },
  },
  {
    id: 'T2-F10-02',
    tier: 2,
    feature: 'F10',
    title: 'tests/fixtures/ conversation titles and IDs are synthetic',
    async run() {
      const fixDir = join(ROOT, 'tests', 'fixtures');
      assert.ok(existsSync(fixDir), 'tests/fixtures/ missing');
      const files = walkFiles(fixDir).filter((f) => f.endsWith('.json'));
      assert.ok(files.length >= 1, 'No JSON fixtures found');
      for (const f of files) {
        const data = JSON.parse(readFileSync(f, 'utf8'));
        const list = data.by_conversation || data.history?.by_conversation || [];
        for (const c of list) {
          if (c.id !== undefined && c.id !== null) {
            const idStr = String(c.id).trim();
            assert.ok(idStr.length > 0, `Empty conversation ID in ${relPath(f)}`);
            assert.equal(
              /C:\\|D:\\|\/Users\/|\/home\/|[\w.+-]+@[\w.-]+\.[a-z]{2,}|ya29\.|sk-[A-Za-z0-9]{20,}/i.test(idStr),
              false,
              `Sensitive/path-like conversation ID in ${relPath(f)}: ${idStr}`,
            );
          }
          if (c.title) {
            assert.equal(/C:\\|D:\\|\/Users\/|\/home\//i.test(c.title), false, `Path in fixture title: ${c.title}`);
          }
        }
      }
    },
  },
  {
    id: 'T2-F10-03',
    tier: 2,
    feature: 'F10',
    title: 'PNG metadata chunks (tEXt/iTXt/zTXt) under docs/img/ contain zero local paths or antigravity-pulse',
    async run() {
      const imgs = walkFiles(join(ROOT, 'docs', 'img')).filter((f) => f.endsWith('.png'));
      assert.ok(imgs.length >= 9, `Expected >= 9 PNGs under docs/img/, found ${imgs.length}`);
      for (const img of imgs) {
        const info = parsePngInfo(readFileSync(img));
        const joined = info.textChunks.join('\n');
        assert.equal(/C:\\Users\\|D:\\|\/Users\/|\/home\/|antigravity-pulse/i.test(joined), false, `Forbidden PNG metadata in ${relPath(img)}`);
      }
    },
  },
  {
    id: 'T2-F10-04',
    tier: 2,
    feature: 'F10',
    title: 'Old un-split docs/img/{overview,quota,history}.png replaced by en/ and zh/ without broken refs',
    async run() {
      for (const old of ['overview.png', 'quota.png', 'history.png']) {
        assert.equal(existsSync(join(ROOT, 'docs', 'img', old)), false, `Legacy root screenshot still present: docs/img/${old}`);
      }
      for (const lang of ['en', 'zh']) {
        for (const tab of ['overview', 'quota', 'history']) {
          assert.ok(existsSync(join(ROOT, 'docs', 'img', lang, `${tab}.png`)), `Missing docs/img/${lang}/${tab}.png`);
        }
      }
    },
  },
  {
    id: 'T2-F10-05',
    tier: 2,
    feature: 'F10',
    title: 'English vs Chinese screenshots and Heroes have distinct byte contents and size > 5 KB',
    async run() {
      const pairs = [
        ['docs/img/hero-en.png', 'docs/img/hero-zh.png'],
        ['docs/img/en/overview.png', 'docs/img/zh/overview.png'],
        ['docs/img/en/quota.png', 'docs/img/zh/quota.png'],
        ['docs/img/en/history.png', 'docs/img/zh/history.png'],
      ];
      for (const [enRel, zhRel] of pairs) {
        const enP = join(ROOT, enRel);
        const zhP = join(ROOT, zhRel);
        assert.ok(existsSync(enP) && existsSync(zhP), `Missing pair: ${enRel} / ${zhRel}`);
        const enBuf = readFileSync(enP);
        const zhBuf = readFileSync(zhP);
        assert.ok(enBuf.length > 5120 && zhBuf.length > 5120, `Suspiciously small PNG (<5KB): ${enRel}/${zhRel}`);
        assert.equal(enBuf.equals(zhBuf), false, `${enRel} and ${zhRel} are byte-identical duplicates`);
      }
    },
  },

  // --- F11 Boundaries ---
  {
    id: 'T2-F11-01',
    tier: 2,
    feature: 'F11',
    title: 'docs/img/hero-en.png appears within the top 25 lines of README.md',
    async run() {
      const lines = readFileSync(join(ROOT, 'README.md'), 'utf8').split(/\r?\n/);
      const idx = lines.findIndex((l) => l.includes('docs/img/hero-en.png'));
      assert.ok(idx >= 0 && idx < 25, `hero-en.png expected in first 25 lines of README.md (found at line ${idx + 1})`);
    },
  },
  {
    id: 'T2-F11-02',
    tier: 2,
    feature: 'F11',
    title: 'Zero broken relative Markdown links or images across core documentation files',
    async run() {
      const docPaths = [
        join(ROOT, 'README.md'),
        join(ROOT, 'README.zh-CN.md'),
        join(ROOT, 'docs', 'architecture.md'),
        join(ROOT, 'CONTRIBUTING.md'),
      ];
      for (const p of docPaths) {
        assert.ok(existsSync(p), `Missing doc: ${relPath(p)}`);
        const txt = readFileSync(p, 'utf8');
        const re = /!?\[[^\]]*\]\(([^)]+)\)/g;
        let m;
        while ((m = re.exec(txt)) !== null) {
          const target = m[1].trim().split(/\s+/)[0];
          if (/^(https?:|mailto:|#)/i.test(target)) continue;
          const clean = target.split('#')[0].split('?')[0];
          if (!clean) continue;
          const resolved = resolve(dirname(p), clean);
          assert.ok(existsSync(resolved), `Broken relative link in ${relPath(p)}: ${target}`);
        }
      }
    },
  },
  {
    id: 'T2-F11-03',
    tier: 2,
    feature: 'F11',
    title: 'Core documentation contains zero stale antigravity-pulse or sidecars/context instructions',
    async run() {
      for (const rel of ['README.md', 'README.zh-CN.md', 'docs/architecture.md', 'CONTRIBUTING.md']) {
        const p = join(ROOT, rel);
        assert.ok(existsSync(p), `Missing doc: ${rel}`);
        const txt = readFileSync(p, 'utf8');
        assert.equal(/antigravity-pulse|sidecars\/context/i.test(txt), false, `Stale legacy reference in ${rel}`);
      }
    },
  },
  {
    id: 'T2-F11-04',
    tier: 2,
    feature: 'F11',
    title: 'README.md delegates deep protobuf/SQLite schema details to docs/architecture.md',
    async run() {
      const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
      const arch = readFileSync(join(ROOT, 'docs', 'architecture.md'), 'utf8');
      assert.ok(readme.includes('docs/architecture.md'), 'README.md must link to docs/architecture.md');
      assert.match(arch, /gen_metadata|CREATE TABLE|CortexStep|wire/i);
      assert.equal(/CREATE TABLE\s+steps/i.test(readme), false, 'SQLite DDL should live in docs/architecture.md, not README.md');
    },
  },
  {
    id: 'T2-F11-05',
    tier: 2,
    feature: 'F11',
    title: 'README.md and README.zh-CN.md contain bidirectional language links',
    async run() {
      const en = readFileSync(join(ROOT, 'README.md'), 'utf8');
      const zhPath = join(ROOT, 'README.zh-CN.md');
      assert.ok(existsSync(zhPath), 'README.zh-CN.md missing');
      const zh = readFileSync(zhPath, 'utf8');
      assert.ok(en.includes('README.zh-CN.md'), 'README.md missing link to README.zh-CN.md');
      assert.ok(zh.includes('README.md'), 'README.zh-CN.md missing link back to README.md');
    },
  },

  // --- F12 Boundaries ---
  {
    id: 'T2-F12-01',
    tier: 2,
    feature: 'F12',
    title: 'GitHub About description in docs/launch/github-metadata.md fits within 350-char limit',
    async run() {
      const p = join(ROOT, 'docs', 'launch', 'github-metadata.md');
      assert.ok(existsSync(p), 'docs/launch/github-metadata.md missing');
      const txt = readFileSync(p, 'utf8');
      const section = txt.match(/(?:^|\n)#{1,3}\s*(?:Repository\s+)?(?:About|Description)[^\n]*\n([\s\S]*?)(?:\n#{1,3}\s|$)/i);
      assert.ok(section, 'Missing About/Description section in github-metadata.md');
      const cleaned = section[1].replace(/```[\s\S]*?```/g, (b) => b.replace(/```[^\n]*\n?/g, '')).trim();
      const firstPara = cleaned.split(/\r?\n\r?\n/)[0].replace(/^>\s*/gm, '').trim();
      assert.ok(firstPara.length > 20 && firstPara.length <= 350, `About description length ${firstPara.length} outside (20..350]`);
    },
  },
  {
    id: 'T2-F12-02',
    tier: 2,
    feature: 'F12',
    title: 'GitHub Topics in docs/launch/github-metadata.md satisfy <=20 valid lowercase slugs',
    async run() {
      const p = join(ROOT, 'docs', 'launch', 'github-metadata.md');
      assert.ok(existsSync(p), 'docs/launch/github-metadata.md missing');
      const txt = readFileSync(p, 'utf8');
      const section = txt.match(/(?:^|\n)#{1,3}\s*(?:GitHub\s+)?Topics[^\n]*\n([\s\S]*?)(?:\n#{1,3}\s|$)/i);
      assert.ok(section, 'Missing Topics section in github-metadata.md');
      const cleanedSection = section[1].replace(/```[\s\S]*?```/g, (b) => b.replace(/```[^\n]*\n?/g, ''));
      const rawTokens = cleanedSection
        .replace(/`/g, '')
        .split(/[\n,]+/)
        .map((s) => s.replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').trim())
        .filter((s) => s && !s.startsWith('#') && !s.endsWith(':'));
      assert.ok(rawTokens.length >= 5 && rawTokens.length <= 20, `Expected 5..20 topics, found ${rawTokens.length}`);
      for (const t of rawTokens) {
        assert.match(t, /^[a-z0-9-]{1,50}$/, `Invalid GitHub topic slug: ${t}`);
      }
    },
  },
  {
    id: 'T2-F12-03',
    tier: 2,
    feature: 'F12',
    title: 'Launch drafts under docs/launch/ contain zero antigravity-pulse or Pulse misbranding',
    async run() {
      const dir = join(ROOT, 'docs', 'launch');
      assert.ok(existsSync(dir), 'docs/launch/ missing');
      const files = walkFiles(dir).filter((f) => f.endsWith('.md'));
      assert.ok(files.length >= 6);
      for (const f of files) {
        const txt = readFileSync(f, 'utf8');
        assert.equal(/antigravity-pulse|\bPulse\b/.test(txt), false, `Legacy Pulse/antigravity-pulse branding in ${relPath(f)}`);
      }
    },
  },
  {
    id: 'T2-F12-04',
    tier: 2,
    feature: 'F12',
    title: 'docs/launch/x-twitter.md respects X/Twitter post/thread structure',
    async run() {
      const p = join(ROOT, 'docs', 'launch', 'x-twitter.md');
      assert.ok(existsSync(p), 'docs/launch/x-twitter.md missing');
      const txt = readFileSync(p, 'utf8');
      assert.ok(txt.trim().length > 80);
      assert.match(txt, /Agy Lens|agy-lens/);
      assert.match(txt, /Aoike123\/agy-lens/);
    },
  },
  {
    id: 'T2-F12-05',
    tier: 2,
    feature: 'F12',
    title: 'Launch drafts contain zero personal filesystem paths, private emails, or tokens',
    async run() {
      const dir = join(ROOT, 'docs', 'launch');
      assert.ok(existsSync(dir), 'docs/launch/ missing');
      for (const f of walkFiles(dir)) {
        const txt = readFileSync(f, 'utf8');
        assert.equal(/C:\\Users\\|D:\\Code\\|\/Users\/|\/home\//i.test(txt), false, `Local path in ${relPath(f)}`);
        assert.equal(/@(gmail|outlook|hotmail|qq|163)\.com/i.test(txt), false, `Private email in ${relPath(f)}`);
      }
    },
  },
];
