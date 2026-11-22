// Shared E2E test harness: sandbox FS, child env, sidecar launcher (HTTP + IPC),
// Chrome headless driver (CDP + file:// importmap fallback), PKZIP & PNG parsers,
// PowerShell & bash installer dry-runners, and repo scanners.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateRawSync, inflateSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '..', '..', '..');
const MOCK_SDK_LOADER_URL = pathToFileURL(join(HERE, 'mock-sdk-loader.mjs')).href;

export class SkipError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SkipError';
  }
}

export function makeChildEnv(overrides = {}, { stripAntigravity = false } = {}) {
  const env = { ...process.env };
  if (stripAntigravity) {
    for (const key of Object.keys(env)) {
      if (key.startsWith('ANTIGRAVITY_') || key === 'CONTEXT_PANEL_NO_SERVER') {
        delete env[key];
      }
    }
  }
  for (const [k, v] of Object.entries(overrides || {})) {
    if (v === undefined || v === null) {
      delete env[k];
    } else {
      env[k] = String(v);
    }
  }
  if (process.versions.electron || process.env.ELECTRON_RUN_AS_NODE === '1') {
    env.ELECTRON_RUN_AS_NODE = '1';
  }
  return env;
}

let loopbackPromise = null;
export function canLoopback() {
  if (!loopbackPromise) {
    loopbackPromise = (async () => {
      let srv = null;
      try {
        srv = http.createServer((_req, res) => {
          res.writeHead(200);
          res.end('ok');
        });
        await new Promise((resolveListen, rejectListen) => {
          srv.once('error', rejectListen);
          srv.listen(0, '127.0.0.1', resolveListen);
        });
        const port = srv.address().port;
        const resp = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) });
        await resp.text();
        return resp.ok;
      } catch {
        return false;
      } finally {
        if (srv) await new Promise((r) => srv.close(() => r()));
      }
    })();
  }
  return loopbackPromise;
}

export function createSandbox(prefix = 'agy-e2e-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const geminiDir = join(root, 'gemini');
  const desktopConvDir = join(geminiDir, 'antigravity', 'conversations');
  const cliConvDir = join(geminiDir, 'antigravity-cli', 'conversations');
  const desktopSummaryDbPath = join(geminiDir, 'antigravity', 'conversation_summaries.db');
  const cliSummaryDbPath = join(geminiDir, 'antigravity-cli', 'conversation_summaries.db');
  const dataDir = join(root, 'data');
  const homeDir = join(root, 'home');
  const workspaceDir = join(root, 'workspace');

  mkdirSync(desktopConvDir, { recursive: true });
  mkdirSync(cliConvDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(homeDir, '.gemini'), { recursive: true });
  mkdirSync(join(workspaceDir, '.agents', 'rules'), { recursive: true });

  const cleanups = [];
  return {
    root,
    geminiDir,
    desktopConvDir,
    cliConvDir,
    desktopSummaryDbPath,
    cliSummaryDbPath,
    dataDir,
    homeDir,
    workspaceDir,
    track(fn) {
      cleanups.push(fn);
      return fn;
    },
    async cleanup() {
      while (cleanups.length) {
        const fn = cleanups.pop();
        try {
          await fn();
        } catch { /* ignore cleanup error */ }
      }
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      } catch { /* ignore cleanup error */ }
    },
  };
}

export async function startSidecar({
  sidecarDir = join(ROOT, 'sidecars', 'agy-lens'),
  env = {},
  preloadConfig = {},
  mockLs = null,
  stripAntigravity = true,
  waitTimeoutMs = 10000,
} = {}) {
  const mainPath = join(sidecarDir, 'main.mjs');
  assert.ok(existsSync(mainPath), `Sidecar entrypoint missing: ${mainPath}`);

  const loopbackOk = await canLoopback();
  const extraEnv = {
    E2E_SIDECAR_PRELOAD_JSON: JSON.stringify(preloadConfig || {}),
    ...env,
  };
  if (mockLs && !loopbackOk) {
    extraEnv.E2E_LS_IPC_BRIDGE = '1';
    extraEnv.E2E_LS_PORT = String(mockLs.port);
  }

  const childEnv = makeChildEnv(extraEnv, { stripAntigravity });
  const child = spawn(process.execPath, ['--import', MOCK_SDK_LOADER_URL, mainPath], {
    cwd: sidecarDir,
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });

  let stdout = '';
  let stderr = '';
  let ipcSeq = 0;
  const pendingHttp = new Map();

  child.stdout?.on('data', (d) => { stdout += d.toString('utf8'); });
  child.stderr?.on('data', (d) => { stderr += d.toString('utf8'); });

  const readyPort = await new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => {
      rejectReady(new Error(`Sidecar failed to become ready within ${waitTimeoutMs}ms.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, waitTimeoutMs);

    child.on('exit', (code, signal) => {
      for (const [, entry] of pendingHttp) {
        entry.reject(new Error(`Sidecar exited early (${code ?? signal})`));
      }
      pendingHttp.clear();
      clearTimeout(timer);
      rejectReady(new Error(`Sidecar exited before ready (code=${code}, signal=${signal}).\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      rejectReady(err);
    });

    child.on('message', async (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'sidecar-ready') {
        clearTimeout(timer);
        resolveReady(msg.port);
        return;
      }
      if (msg.type === 'http-response') {
        const entry = pendingHttp.get(msg.id);
        if (!entry) return;
        pendingHttp.delete(msg.id);
        entry.resolve(msg);
        return;
      }
      if (msg.type === 'ls-request' && mockLs) {
        try {
          const resp = await mockLs.handleIpcRequest(msg);
          child.send({ type: 'ls-response', id: msg.id, ...resp });
        } catch (err) {
          child.send({ type: 'ls-response', id: msg.id, error: err.message });
        }
      }
    });
  });

  async function request(path, { method = 'GET' } = {}) {
    if (loopbackOk) {
      const resp = await fetch(`http://127.0.0.1:${readyPort}${path}`, {
        method,
        signal: AbortSignal.timeout(10000),
      });
      const buf = Buffer.from(await resp.arrayBuffer());
      const headers = {};
      resp.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
      return {
        status: resp.status,
        headers,
        body: buf,
        text() { return buf.toString('utf8'); },
        json() { return JSON.parse(buf.toString('utf8')); },
      };
    }

    return new Promise((resolveReq, rejectReq) => {
      const id = ++ipcSeq;
      const timer = setTimeout(() => {
        pendingHttp.delete(id);
        rejectReq(new Error(`IPC HTTP timeout for ${method} ${path}`));
      }, 15000);
      pendingHttp.set(id, {
        resolve(msg) {
          clearTimeout(timer);
          const buf = msg.isBase64 ? Buffer.from(msg.body || '', 'base64') : Buffer.from(msg.body || '', 'utf8');
          const headers = {};
          for (const [k, v] of Object.entries(msg.headers || {})) {
            headers[k.toLowerCase()] = v;
          }
          resolveReq({
            status: msg.status || 200,
            headers,
            body: buf,
            text() { return buf.toString('utf8'); },
            json() { return JSON.parse(buf.toString('utf8')); },
          });
        },
        reject(err) {
          clearTimeout(timer);
          rejectReq(err);
        },
      });
      child.send({ type: 'http-request', id, method, url: path });
    });
  }

  async function getJson(path) {
    const r = await request(path);
    assert.equal(r.status, 200, `Expected HTTP 200 for ${path}, got ${r.status}: ${r.text()}`);
    return r.json();
  }

  async function close() {
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise((resolveClose) => {
        const timer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* ignore */ }
          resolveClose();
        }, 2000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolveClose();
        });
        try {
          child.kill('SIGTERM');
        } catch {
          clearTimeout(timer);
          resolveClose();
        }
      });
    }
  }

  return {
    port: readyPort,
    baseUrl: `http://127.0.0.1:${readyPort}`,
    get stdout() { return stdout; },
    get stderr() { return stderr; },
    request,
    getJson,
    close,
  };
}

export function runCli(args = [], {
  env = {},
  cwd = ROOT,
  cliPath = join(ROOT, 'bin', 'cli.mjs'),
  timeoutMs = 15000,
} = {}) {
  assert.ok(existsSync(cliPath), `CLI entrypoint missing: ${cliPath}`);
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    env: makeChildEnv(env, { stripAntigravity: true }),
    encoding: 'utf8',
    windowsHide: true,
    timeout: timeoutMs,
  });
}

export async function runBuildRelease(outDir, rootDir = ROOT) {
  const scriptPath = join(rootDir, 'scripts', 'build-release.mjs');
  assert.ok(existsSync(scriptPath), `build-release.mjs missing: ${scriptPath}`);
  const src = readFileSync(scriptPath, 'utf8');
  const mod = await import(`${pathToFileURL(scriptPath).href}?t=${Date.now()}`);
  assert.equal(typeof mod.buildRelease, 'function', 'build-release.mjs must export buildRelease');
  const sig = mod.buildRelease.toString().slice(0, 120);
  if (
    /^[^(]*\(\s*\{/.test(sig) ||
    (mod.buildRelease.length <= 1 && !/^[^(]*\(\s*rootDir\b/.test(sig)) ||
    (src.includes('buildRelease({') && !src.includes('buildRelease(rootDir'))
  ) {
    return mod.buildRelease({ rootDir, outDir });
  }
  return mod.buildRelease(rootDir, outDir);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let j = 0; j < 8; j += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function extractZipEntries(zipBuf) {
  const buf = Buffer.isBuffer(zipBuf) ? zipBuf : Buffer.from(zipBuf);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocdOff = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOff = i;
      break;
    }
  }
  assert.ok(eocdOff >= 0, 'PKZIP EOCD signature (0x06054b50) not found');
  const count = view.getUint16(eocdOff + 10, true);
  let cdOff = view.getUint32(eocdOff + 16, true);
  const entries = new Map();

  for (let i = 0; i < count; i += 1) {
    assert.equal(view.getUint32(cdOff, true), 0x02014b50, `Invalid Central Directory signature at ${cdOff}`);
    const method = view.getUint16(cdOff + 10, true);
    const expectedCrc = view.getUint32(cdOff + 16, true);
    const compSize = view.getUint32(cdOff + 20, true);
    const nameLen = view.getUint16(cdOff + 28, true);
    const extraLen = view.getUint16(cdOff + 30, true);
    const cmtLen = view.getUint16(cdOff + 32, true);
    const localOff = view.getUint32(cdOff + 42, true);
    const name = Buffer.from(buf.subarray(cdOff + 46, cdOff + 46 + nameLen)).toString('utf8');

    assert.equal(view.getUint32(localOff, true), 0x04034b50, `Invalid Local Header signature for ${name}`);
    const lNameLen = view.getUint16(localOff + 26, true);
    const lExtraLen = view.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const compData = buf.subarray(dataStart, dataStart + compSize);
    const raw = method === 0 ? Buffer.from(compData) : inflateRawSync(compData);
    assert.equal(crc32(raw), expectedCrc, `CRC-32 mismatch for ZIP entry: ${name}`);
    entries.set(name, raw);
    cdOff += 46 + nameLen + extraLen + cmtLen;
  }
  return entries;
}

export function extractZipToDir(zipBuf, destDir) {
  const entries = extractZipEntries(zipBuf);
  const destRoot = resolve(destDir);
  const destPrefix = destRoot.endsWith(sep) ? destRoot : destRoot + sep;
  for (const [name, data] of entries.entries()) {
    if (name.endsWith('/')) {
      const dirPath = resolve(destRoot, name);
      assert.ok(dirPath === destRoot || dirPath.startsWith(destPrefix), `Unsafe ZIP path traversal: ${name}`);
      mkdirSync(dirPath, { recursive: true });
      continue;
    }
    const outPath = resolve(destRoot, name);
    assert.ok(outPath.startsWith(destPrefix), `Unsafe ZIP path traversal: ${name}`);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, data);
  }
  return entries;
}

export function parsePngInfo(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.ok(b.length >= 24 && b.subarray(0, 8).equals(magic), 'Invalid PNG magic signature');

  let width = 0;
  let height = 0;
  const textChunks = [];
  let off = 8;

  while (off + 8 <= b.length) {
    const len = b.readUInt32BE(off);
    const type = b.subarray(off + 4, off + 8).toString('ascii');
    const dataStart = off + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > b.length) break;
    const data = b.subarray(dataStart, dataEnd);

    if (type === 'IHDR' && len >= 8) {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
    } else if (type === 'tEXt') {
      textChunks.push(data.toString('latin1'));
    } else if (type === 'iTXt') {
      const kwEnd = data.indexOf(0);
      if (kwEnd >= 0 && kwEnd + 3 <= data.length) {
        const keyword = data.subarray(0, kwEnd).toString('latin1');
        const compressionFlag = data[kwEnd + 1];
        const langEnd = data.indexOf(0, kwEnd + 3);
        const transEnd = langEnd >= 0 ? data.indexOf(0, langEnd + 1) : -1;
        if (transEnd >= 0) {
          const rawText = data.subarray(transEnd + 1);
          if (compressionFlag === 1) {
            try {
              textChunks.push(`${keyword}\0${inflateSync(rawText).toString('utf8')}`);
            } catch {
              textChunks.push(data.toString('utf8'));
            }
          } else {
            textChunks.push(`${keyword}\0${rawText.toString('utf8')}`);
          }
        } else {
          textChunks.push(data.toString('utf8'));
        }
      } else {
        textChunks.push(data.toString('utf8'));
      }
    } else if (type === 'zTXt') {
      const nul = data.indexOf(0);
      if (nul >= 0 && nul + 2 <= data.length) {
        try {
          const key = data.subarray(0, nul).toString('latin1');
          const txt = inflateSync(data.subarray(nul + 2)).toString('utf8');
          textChunks.push(`${key}\0${txt}`);
        } catch { /* ignore malformed zTXt */ }
      }
    } else if (type === 'IEND') {
      break;
    }
    off = dataEnd + 4;
  }

  assert.ok(width > 0 && height > 0, 'Missing or invalid PNG IHDR dimensions');
  return { width, height, textChunks };
}

export function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

function collectWebFiles(webDir) {
  const files = new Map();
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(abs);
      } else {
        const rel = relative(webDir, abs).replace(/\\/g, '/');
        files.set(rel, readFileSync(abs, 'utf8'));
      }
    }
  };
  walk(webDir);
  return files;
}

function rewriteRelativeImportsForImportMap(code, currentRel) {
  const baseDir = dirname(currentRel) === '.' ? '' : `${dirname(currentRel).replace(/\\/g, '/')}/`;
  return code.replace(
    /(\b(?:import|export)\b[^;'"]*\bfrom\s*|import\s*\(\s*|import\s+)(['"])(\.\.?\/[^'"]+)\2/g,
    (_, prefix, quote, relSpec) => {
      const resolved = posix.resolve('/', baseDir + relSpec).slice(1);
      return `${prefix}${quote}@web/${resolved}${quote}`;
    },
  );
}

export function buildSingleFileWebHarness({
  webDir,
  mockApi = null,
  preloadConfig = {},
  localStorageInit = null,
  poisonLocalStorage = false,
  testScript = '',
} = {}) {
  const files = collectWebFiles(webDir);
  const indexHtml = files.get('index.html');
  assert.ok(indexHtml, `web/index.html missing in ${webDir}`);
  const css = files.get('styles.css') || '';

  const imports = {};
  for (const [rel, content] of files.entries()) {
    if (!rel.endsWith('.js')) continue;
    const rewritten = rewriteRelativeImportsForImportMap(content, rel);
    const b64 = Buffer.from(rewritten, 'utf8').toString('base64');
    imports[`@web/${rel}`] = `data:text/javascript;base64,${b64}`;
  }

  let html = indexHtml;
  html = html.replace(/<link\s+[^>]*href=["'](?:\.?\/)?styles\.css(?:\?[^"']*)?["'][^>]*>/i, () => `<style>\n${css}\n</style>`);
  html = html.replace(/<script\s+[^>]*src=["']\/?preload\.js["'][^>]*>\s*<\/script>/i, '');
  html = html.replace(/<script\s+[^>]*src=["'](?:\.?\/)?app\.js(?:\?[^"']*)?["'][^>]*>\s*<\/script>/i, '');

  const bootstrap = `
<script>
(function () {
  window.__e2eErrors = [];
  window.__e2eFetchCalls = [];
  var origConsoleError = console.error;
  console.error = function () {
    try { window.__e2eErrors.push(Array.from(arguments).map(String).join(' ')); } catch (e) {}
    return origConsoleError.apply(console, arguments);
  };
  window.addEventListener('error', function (e) {
    window.__e2eErrors.push('window.error: ' + (e && e.message ? e.message : String(e)));
  });
  window.addEventListener('unhandledrejection', function (e) {
    window.__e2eErrors.push('unhandledrejection: ' + (e && e.reason ? (e.reason.message || String(e.reason)) : String(e)));
  });

  ${poisonLocalStorage ? `
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    get: function () { throw new DOMException('Blocked', 'SecurityError'); }
  });
  ` : `
  try {
    localStorage.clear();
    var initLs = ${JSON.stringify(localStorageInit || {})};
    for (var k in initLs) {
      if (Object.prototype.hasOwnProperty.call(initLs, k)) {
        localStorage.setItem(k, initLs[k]);
      }
    }
  } catch (e) {}
  `}

  var preload = ${JSON.stringify(preloadConfig || {})};
  var mockApi = ${JSON.stringify(mockApi || null)};
  if (mockApi) {
    var origFetch = window.fetch ? window.fetch.bind(window) : null;
    window.fetch = async function (url, opts) {
      var u = String(url || '');
      window.__e2eFetchCalls.push(u);
      var path = u.split('?')[0];
      if (Object.prototype.hasOwnProperty.call(mockApi, path)) {
        var payload = mockApi[path];
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'Content-Type': 'application/json; charset=utf-8' }
        });
      }
      if (origFetch && !u.startsWith('/api/')) return origFetch(url, opts);
      return new Response(JSON.stringify({ error: 'not-mocked', path: path }), {
        status: 404,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });
    };
  }
  window.sidecar = {
    conversationId: preload.conversationId || '',
    getWorkspaceUris: async function () { return Array.isArray(preload.workspaceUris) ? preload.workspaceUris : []; },
    onWorkspaceChange: function (cb) { window.__e2eWorkspaceCb = cb; },
    fetch: function (url, opts) { return window.fetch(url, opts); }
  };
})();
</script>
<script type="importmap">${JSON.stringify({ imports })}</script>
<script type="module">
import '@web/app.js';
</script>
<script type="module">
${testScript || `
await new Promise(r => setTimeout(r, 400));
const el = document.createElement('script');
el.id = '__e2e_result';
el.type = 'application/json';
el.textContent = JSON.stringify({ errors: window.__e2eErrors, lang: document.documentElement.lang });
document.body.appendChild(el);
`}
</script>
`;

  if (html.includes('</body>')) {
    return html.replace('</body>', () => `${bootstrap}\n</body>`);
  }
  return `${html}\n${bootstrap}`;
}

async function runChromeCdp({
  chromePath,
  liveUrl,
  lang,
  viewport,
  localStorageInit,
  poisonLocalStorage,
  testScript,
  timeoutMs,
}) {
  const udDir = mkdtempSync(join(tmpdir(), 'agy-cdp-'));
  const args = [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--no-first-run',
    '--remote-debugging-port=0',
    `--user-data-dir=${udDir}`,
    `--lang=${lang}`,
    ...(viewport ? [`--window-size=${viewport.width},${viewport.height}`] : []),
    'about:blank',
  ];

  const child = spawn(chromePath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let ws = null;
  try {
    const browserWsUrl = await new Promise((resolveWs, rejectWs) => {
      let stderr = '';
      const timer = setTimeout(() => rejectWs(new Error(`Chrome CDP startup timeout.\nstderr:\n${stderr}`)), timeoutMs);
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
        const m = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (m) {
          clearTimeout(timer);
          resolveWs(m[1]);
        }
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        rejectWs(new Error(`Chrome exited before DevTools ready (code=${code}): ${stderr}`));
      });
    });

    const u = new URL(browserWsUrl);
    const listResp = await fetch(`http://${u.host}/json/list`);
    const targets = await listResp.json();
    const pageTarget = targets.find((t) => t.type === 'page') || targets[0];
    assert.ok(pageTarget?.webSocketDebuggerUrl, 'No Chrome page target available');

    ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });

    let msgId = 0;
    const pending = new Map();
    const events = [];
    const networkRequests = [];
    const consoleErrors = [];

    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id) {
        const entry = pending.get(msg.id);
        if (entry) {
          pending.delete(msg.id);
          if (msg.error) entry.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          else entry.resolve(msg.result);
        }
      } else if (msg.method) {
        if (msg.method === 'Network.requestWillBeSent') {
          networkRequests.push(msg.params?.request?.url || '');
        } else if (msg.method === 'Runtime.exceptionThrown') {
          consoleErrors.push(msg.params?.exceptionDetails?.text || 'exception');
        } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
          consoleErrors.push((msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
        }
        events.push(msg);
      }
    });

    const cdp = (method, params = {}) => new Promise((res, rej) => {
      const id = ++msgId;
      pending.set(id, { resolve: res, reject: rej });
      ws.send(JSON.stringify({ id, method, params }));
    });

    await cdp('Page.enable');
    await cdp('Runtime.enable');
    await cdp('Network.enable');

    if (viewport) {
      await cdp('Emulation.setDeviceMetricsOverride', {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: 1,
        mobile: false,
      });
    }

    const initScript = `
      window.__e2eErrors = [];
      window.addEventListener('error', (e) => window.__e2eErrors.push(e.message || String(e)));
      window.addEventListener('unhandledrejection', (e) => window.__e2eErrors.push(String(e.reason)));
      ${poisonLocalStorage ? `
        Object.defineProperty(window, 'localStorage', {
          configurable: true,
          get() { throw new DOMException('Blocked', 'SecurityError'); }
        });
      ` : `
        try {
          localStorage.clear();
          const initLs = ${JSON.stringify(localStorageInit || {})};
          for (const [k, v] of Object.entries(initLs)) localStorage.setItem(k, v);
        } catch {}
      `}
    `;
    await cdp('Page.addScriptToEvaluateOnNewDocument', { source: initScript });

    const loadDone = new Promise((res) => {
      const t = setInterval(() => {
        if (events.some((e) => e.method === 'Page.loadEventFired')) {
          clearInterval(t);
          res();
        }
      }, 30);
    });
    await cdp('Page.navigate', { url: liveUrl });
    await loadDone;
    await new Promise((r) => setTimeout(r, 350));

    let result = null;
    if (testScript) {
      const wrapped = `(async () => {
        ${testScript}
        const el = document.getElementById('__e2e_result');
        return el ? JSON.parse(el.textContent) : null;
      })()`;
      const evalRes = await cdp('Runtime.evaluate', {
        expression: wrapped,
        awaitPromise: true,
        returnByValue: true,
      });
      if (evalRes.exceptionDetails) {
        throw new Error(`Browser script exception: ${JSON.stringify(evalRes.exceptionDetails)}`);
      }
      result = evalRes.result?.value ?? null;
    }

    return {
      mode: 'http-cdp',
      result,
      networkRequests,
      consoleErrors: [...consoleErrors, ...((result && result.errors) || [])],
      dom: '',
    };
  } finally {
    try { ws?.close(); } catch { /* ignore */ }
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise((resolveExit) => {
        const timer = setTimeout(resolveExit, 2000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolveExit();
        });
        try { child.kill('SIGKILL'); } catch { clearTimeout(timer); resolveExit(); }
      });
    }
    try { rmSync(udDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* ignore */ }
  }
}

export async function runChromeBrowserTest({
  webDir = join(ROOT, 'sidecars', 'agy-lens', 'web'),
  liveUrl = null,
  mockApi = null,
  preloadConfig = {},
  lang = 'en-US',
  viewport = null,
  localStorageInit = null,
  poisonLocalStorage = false,
  testScript = '',
  timeoutMs = 20000,
} = {}) {
  const chromePath = findChrome();
  if (!chromePath) {
    throw new SkipError('Google Chrome binary not found on host');
  }

  if (liveUrl && !mockApi && await canLoopback()) {
    try {
      return await runChromeCdp({
        chromePath,
        liveUrl,
        lang,
        viewport,
        localStorageInit,
        poisonLocalStorage,
        testScript,
        timeoutMs,
      });
    } catch (err) {
      if (!String(err.message).includes('ERR_NETWORK_ACCESS_DENIED') && !String(err.message).includes('EACCES')) {
        throw err;
      }
    }
  }

  const tmpDir = mkdtempSync(join(tmpdir(), 'agy-chrome-'));
  const udDir = join(tmpDir, 'ud');
  mkdirSync(udDir, { recursive: true });
  const htmlPath = join(tmpDir, 'harness.html');
  const html = buildSingleFileWebHarness({
    webDir,
    mockApi,
    preloadConfig,
    localStorageInit,
    poisonLocalStorage,
    testScript,
  });
  writeFileSync(htmlPath, html, 'utf8');

  try {
    const args = [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--no-first-run',
      '--virtual-time-budget=3500',
      `--user-data-dir=${udDir}`,
      `--lang=${lang}`,
      ...(viewport ? [`--window-size=${viewport.width},${viewport.height}`] : []),
      '--dump-dom',
      pathToFileURL(htmlPath).href,
    ];
    const r = spawnSync(chromePath, args, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(r.status, 0, `Chrome exited with status ${r.status}: ${r.stderr}`);
    const dom = r.stdout || '';
    const m = dom.match(/<script\s+id="__e2e_result"\s+type="application\/json">([\s\S]*?)<\/script>/i);
    assert.ok(m, `Browser test script did not emit #__e2e_result.\nDOM snippet: ${dom.slice(0, 600)}`);
    const result = JSON.parse(m[1]);
    return {
      mode: 'file-importmap',
      result,
      networkRequests: [],
      consoleErrors: result.errors || [],
      dom,
    };
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* ignore */ }
  }
}

export function validatePs1Syntax(ps1Path) {
  assert.ok(existsSync(ps1Path), `PowerShell script missing: ${ps1Path}`);
  if (process.platform !== 'win32') {
    throw new SkipError('PowerShell 5.1 syntax parser requires Windows');
  }
  const cmd = `
$c = Get-Content -Raw -Encoding UTF8 -LiteralPath '${ps1Path.replace(/'/g, "''")}'
$tokErrors = $null
[void][System.Management.Automation.PSParser]::Tokenize($c, [ref]$tokErrors)
$astTokens = $null; $astErrors = $null
[void][System.Management.Automation.Language.Parser]::ParseInput($c, [ref]$astTokens, [ref]$astErrors)
Write-Output ("ERR=" + ($tokErrors.Count + $astErrors.Count))
if ($tokErrors.Count -gt 0 -or $astErrors.Count -gt 0) { exit 1 }
`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
  });
  assert.equal(r.status, 0, `PowerShell syntax error in ${ps1Path}: ${r.stdout} ${r.stderr}`);
}

export function runInstallPs1DryRun({
  ps1Path = join(ROOT, 'scripts', 'install.ps1'),
  zipPath,
  homeDir,
  version = '',
} = {}) {
  validatePs1Syntax(ps1Path);
  const urlLog = join(homeDir, '_ps_url.log');
  const escapedPs1 = ps1Path.replace(/'/g, "''");
  const escapedZip = (zipPath || '').replace(/'/g, "''");
  const escapedLog = urlLog.replace(/'/g, "''");
  const escapedVer = (version || '').replace(/'/g, "''");

  const wrapper = `
$ErrorActionPreference = 'Stop'
function Invoke-WebRequest {
  param([string]$Uri, [string]$OutFile, [switch]$UseBasicParsing)
  Set-Content -LiteralPath '${escapedLog}' -Value $Uri -Encoding UTF8
  if (-not '${escapedZip}' -or -not (Test-Path -LiteralPath '${escapedZip}')) {
    throw "Mock download failed: no ZIP"
  }
  Copy-Item -LiteralPath '${escapedZip}' -Destination $OutFile -Force
}
${version ? `& '${escapedPs1}' -Version '${escapedVer}'` : `& '${escapedPs1}'`}
`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', wrapper], {
    env: makeChildEnv({ USERPROFILE: homeDir, HOME: homeDir }),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20000,
  });
  const requestedUrl = existsSync(urlLog) ? readFileSync(urlLog, 'utf8').trim() : '';
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', requestedUrl };
}

let cachedBash = null;
export function hasWorkingBash() {
  if (cachedBash !== null) return cachedBash;
  const candidates = process.platform === 'win32'
    ? ['bash', 'D:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\bin\\bash.exe']
    : ['bash'];
  for (const cand of candidates) {
    try {
      const r = spawnSync(cand, ['-c', 'exit 0'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 4000,
      });
      if (r.status === 0) {
        cachedBash = { available: true, bashPath: cand };
        return cachedBash;
      }
    } catch { /* try next */ }
  }
  cachedBash = { available: false, bashPath: null };
  return cachedBash;
}

export function validateShStatic(shPath) {
  assert.ok(existsSync(shPath), `Shell script missing: ${shPath}`);
  const raw = readFileSync(shPath, 'utf8');
  assert.equal(raw.includes('\r\n'), false, `${shPath} must use LF line endings (not CRLF)`);
  assert.ok(raw.startsWith('#!/usr/bin/env bash') || raw.startsWith('#!/bin/bash'), `${shPath} missing bash shebang`);
  assert.ok(raw.includes('set -euo pipefail'), `${shPath} missing strict 'set -euo pipefail'`);
  return raw;
}

export function runInstallShDryRun({
  shPath = join(ROOT, 'scripts', 'install.sh'),
  zipPath,
  homeDir,
  args = [],
} = {}) {
  validateShStatic(shPath);
  const bash = hasWorkingBash();
  if (!bash.available) {
    return { skippedExecution: true, reason: 'Working bash unavailable on host/sandbox' };
  }

  const syntax = spawnSync(bash.bashPath, ['-n', shPath], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10000,
  });
  assert.equal(syntax.status, 0, `bash -n failed on ${shPath}: ${syntax.stderr}`);

  const mockBin = join(homeDir, '_mock_bin');
  mkdirSync(mockBin, { recursive: true });
  const urlLog = join(homeDir, '_sh_url.log');

  const curlScript = `#!/usr/bin/env bash
set -e
URL=""
OUT=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) OUT="$2"; shift 2 ;;
    -*) shift ;;
    *) URL="$1"; shift ;;
  esac
done
printf '%s' "$URL" > "${urlLog.replace(/\\/g, '/')}"
cp "${String(zipPath || '').replace(/\\/g, '/')}" "$OUT"
`;
  writeFileSync(join(mockBin, 'curl'), curlScript, { mode: 0o755 });

  // Provide pure-Node unzip shim in case unzip binary is absent
  const unzipCheck = spawnSync(bash.bashPath, ['-c', 'command -v unzip'], { encoding: 'utf8', windowsHide: true });
  if (unzipCheck.status !== 0) {
    const helperPath = join(mockBin, '_unzip.mjs');
    writeFileSync(helperPath, `
import { readFileSync } from 'node:fs';
import { extractZipToDir } from '${pathToFileURL(fileURLToPath(import.meta.url)).href}';
const args = process.argv.slice(2);
let zip = '', dest = '.';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '-d') { dest = args[++i]; }
  else if (!args[i].startsWith('-')) { zip = args[i]; }
}
extractZipToDir(readFileSync(zip), dest);
`);
    const unzipShim = `#!/usr/bin/env bash
ELECTRON_RUN_AS_NODE=1 "${process.execPath.replace(/\\/g, '/')}" "${helperPath.replace(/\\/g, '/')}" "$@"
`;
    writeFileSync(join(mockBin, 'unzip'), unzipShim, { mode: 0o755 });
  }

  const launchCmd = 'M="$(cygpath -u "$1" 2>/dev/null || printf "%s" "$1")"; shift; export PATH="$M:$PATH"; exec "$BASH" "$@"';
  const r = spawnSync(bash.bashPath, ['-c', launchCmd, '--', mockBin, shPath, ...args], {
    env: makeChildEnv({
      HOME: homeDir,
      PATH: `${mockBin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH || ''}`,
    }),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20000,
  });
  const requestedUrl = existsSync(urlLog) ? readFileSync(urlLog, 'utf8').trim() : '';
  return {
    skippedExecution: false,
    status: r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    requestedUrl,
  };
}

export function walkFiles(dir, { excludeDirs = new Set(['.git', 'node_modules']) } = {}) {
  const results = [];
  if (!existsSync(dir)) return results;
  const walk = (cur) => {
    for (const ent of readdirSync(cur, { withFileTypes: true })) {
      const abs = join(cur, ent.name);
      if (ent.isDirectory()) {
        if (!excludeDirs.has(ent.name)) walk(abs);
      } else {
        results.push(abs);
      }
    }
  };
  walk(dir);
  return results;
}

export function relPath(abs) {
  return relative(ROOT, abs).replace(/\\/g, '/');
}

export function makePoisonedPythonBinDir(dir) {
  const binDir = join(dir, 'poison-bin');
  mkdirSync(binDir, { recursive: true });
  const sentinelPath = join(dir, 'python-was-invoked.flag');
  if (process.platform === 'win32') {
    const cmd = `@echo invoked > "${sentinelPath}"\r\n@exit /b 99\r\n`;
    writeFileSync(join(binDir, 'python.cmd'), cmd);
    writeFileSync(join(binDir, 'python3.cmd'), cmd);
    writeFileSync(join(binDir, 'py.cmd'), cmd);
    const sys32 = join(process.env.SystemRoot || 'C:\\Windows', 'System32');
    return { binDir, sentinelPath, pathEnv: `${binDir};${sys32}` };
  }
  const sh = `#!/bin/sh\necho invoked > "${sentinelPath}"\nexit 99\n`;
  for (const name of ['python', 'python3']) {
    const p = join(binDir, name);
    writeFileSync(p, sh, { mode: 0o755 });
  }
  return { binDir, sentinelPath, pathEnv: binDir };
}

export function fileSize(p) {
  return statSync(p).size;
}
