#!/usr/bin/env node
/**
 * Renders the README screenshots, Hero composites and the GitHub Social Preview
 * for Agy Lens from 100% synthetic, sanitized fixture data.
 *
 * Pipeline (zero npm dependencies; needs Node.js 24+ and a local Chrome/Edge):
 *   1. Seed a throwaway ~/.gemini tree with synthetic conversation databases.
 *   2. Run the real engines (lib/context.mjs, lib/history.mjs, lib/quota.mjs)
 *      on that tree, so every fixture has the exact production JSON schema.
 *   3. Load the real panel (classic /app.js bundle from lib/web-bundle.mjs +
 *      styles.css) in headless Chrome with a stubbed sidecar bridge and
 *      screenshot each tab in English and Chinese.
 *   4. Compose hero-en.png / hero-zh.png and social-preview.png (1280x640).
 *
 * Usage: node scripts/render-screenshots.mjs [--chrome PATH] [--keep]
 * Output: docs/img/{en,zh}/{overview,quota,history,share-card}.png, docs/img/hero-{en,zh}.png,
 *         docs/img/social-preview.png, tests/fixtures/panel-fixtures.json
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';

import {
  createConvDb,
  createSummariesDb,
  pbField,
  pbGroup,
  pbTiming,
  pbTs,
  pbUsage,
} from '../tests/e2e/lib/pb-db-builder.mjs';
import { writeModelCatalog } from '../sidecars/agy-lens/lib/catalog.mjs';
import { buildReport } from '../sidecars/agy-lens/lib/context.mjs';
import { defaultRoots, scan } from '../sidecars/agy-lens/lib/history.mjs';
import { parseQuota } from '../sidecars/agy-lens/lib/quota.mjs';
import { readShareAsset } from '../sidecars/agy-lens/lib/share-assets.mjs';
import { bundleWebApp } from '../sidecars/agy-lens/lib/web-bundle.mjs';
import {
  buildAbyssalCardSvg,
  buildBauhausCardSvg,
  buildEclipseCardSvg,
  buildPhosphorCardSvg,
  buildShareCardSvg,
} from '../sidecars/agy-lens/web/views/share-card.js';
import { CLASS_ARENA, arenaPath, buildProfile, charIdlePath, charStillPath, usageAchievements } from '../sidecars/agy-lens/web/views/share-game.js';
import { buildRoleCardSvg } from '../sidecars/agy-lens/web/views/share-pixel.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const WEB_DIR = join(ROOT, 'sidecars', 'agy-lens', 'web');
const SHARE_ART_DIR = join(ROOT, 'sidecars', 'agy-lens', 'share-art');
const IMG_DIR = join(ROOT, 'docs', 'img');
const PANEL_W = 420;
const PANEL_H = 1280;
const SCALE = 2;

const args = process.argv.slice(2);
const argVal = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const KEEP = args.includes('--keep');

function findChrome() {
  const explicit = argVal('--chrome') || process.env.CHROME_PATH;
  if (explicit) return explicit;
  const candidates = process.platform === 'win32'
    ? [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ]
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  return candidates.find((p) => existsSync(p)) || null;
}

// --- 1. synthetic data ---------------------------------------------------------

// Deterministic PRNG so re-renders are stable.
let seed = 20261122;
const rand = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 32;
};
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const uuid = (n) => {
  const h = n.toString(16).padStart(12, '0');
  return `5a1e${h.slice(0, 4)}-0000-4000-8000-${h}`;
};

const MODELS = [
  { id: 'claude-opus-4-6', name: 'Claude Opus 4.6 (Thinking)', w: 0.32, inp: 38000, out: 2600 },
  { id: 'gemini-3-pro', name: 'Gemini 3 Pro (High)', w: 0.26, inp: 42000, out: 3100 },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)', w: 0.18, inp: 30000, out: 2200 },
  { id: 'gemini-3-flash', name: 'Gemini 3 Flash', w: 0.16, inp: 26000, out: 1700 },
  { id: 'gpt-oss-120b', name: 'GPT-OSS 120B (Medium)', w: 0.08, inp: 18000, out: 1300 },
];

const TITLES = [
  'Refactor payment retry logic', 'Add dark mode to settings page', 'Fix flaky checkout e2e test',
  'Migrate auth middleware to v2', 'Write onboarding docs', 'Optimize image pipeline',
  'Design rate limiter', 'Upgrade build tooling', 'Investigate memory leak in worker',
  'Add CSV export to reports', 'Review API pagination', 'Prototype search ranking',
  'Clean up feature flags', 'Localize dashboard strings', 'Harden input validation',
];

function pickModel() {
  let r = rand();
  for (const m of MODELS) {
    if ((r -= m.w) <= 0) return m;
  }
  return MODELS[0];
}

function seedTree(geminiDir, nowSec) {
  const desktop = join(geminiDir, 'antigravity', 'conversations');
  const cli = join(geminiDir, 'antigravity-cli', 'conversations');
  mkdirSync(desktop, { recursive: true });
  mkdirSync(cli, { recursive: true });
  const summaries = [];

  // Activity profile over the last 35 days: weekdays busier, a few days off.
  let n = 1;
  for (let day = 34; day >= 1; day -= 1) {
    const date = new Date((nowSec - day * 86400) * 1000);
    const dow = date.getDay();
    const off = (dow === 0 && rand() < 0.7) || (dow === 6 && rand() < 0.5) || rand() < 0.08;
    if (off) continue;
    const convs = 1 + Math.floor(rand() * (dow === 0 || dow === 6 ? 2 : 4));
    for (let c = 0; c < convs; c += 1) {
      const id = uuid(n++);
      const isCli = rand() < 0.12;
      const dir = isCli ? cli : desktop;
      const model = pickModel();
      const db = createConvDb(join(dir, `${id}.db`));
      const start = nowSec - day * 86400 + Math.floor((9 + rand() * 9) * 3600);
      db.step(14, { metadata: pbTs(start), payloadField: 19, payload: pbField(2, pick(TITLES)) });
      const calls = 4 + Math.floor(rand() * 28);
      for (let i = 0; i < calls; i += 1) {
        const t = start + i * (40 + Math.floor(rand() * 200));
        db.step(15, { metadata: pbTs(t), payloadField: 20, payload: pbField(1, 'ok') });
        const inp = Math.floor(model.inp * (0.4 + rand()));
        db.generation({
          model: model.id,
          displayName: model.name,
          usage: pbUsage({ inp: Math.floor(inp * 0.08), out: Math.floor(model.out * (0.3 + rand())), cache: Math.floor(inp * 0.92), think: Math.floor(model.out * 0.3 * rand()) }),
        });
      }
      db.close();
      if (!isCli) summaries.push({ conversation_id: id, title: pick(TITLES) });
    }
  }

  // Today: the featured conversation (shown on Overview) plus a little background work.
  const featured = uuid(9001);
  {
    const db = createConvDb(join(desktop, `${featured}.db`));
    const start = nowSec - 2 * 3600;
    db.step(14, { metadata: pbTs(start), payloadField: 19, payload: pbField(2, 'Refactor payment retry logic') });
    const speedPlan = [
      // [model, ttft sec, stream sec, out tokens]
      ['claude-opus-4-6', 2.4, 3.6, 420], ['claude-opus-4-6', 2.1, 9.8, 1150], ['gemini-3-flash', 0.9, 1.6, 330],
      ['claude-opus-4-6', 2.9, 6.1, 690], ['claude-opus-4-6', 2.2, 12.4, 1380], ['gemini-3-flash', 1.1, 2.4, 470],
      ['claude-opus-4-6', 2.6, 4.2, 505], ['claude-opus-4-6', 2.0, 8.7, 1010], ['gemini-3-flash', 1.0, 1.9, 380],
      ['claude-opus-4-6', 2.5, 5.0, 560], ['claude-opus-4-6', 2.3, 7.3, 840], ['claude-opus-4-6', 2.7, 3.9, 455],
    ];
    let idx = 1;
    let chat = 0;
    speedPlan.forEach(([mid, ttft, stream, out], i) => {
      const m = MODELS.find((x) => x.id === mid);
      const t = start + i * 420;
      db.step(15, { metadata: pbTs(t), payloadField: 20, payload: pbField(1, 'Working on it') });
      chat += 9000 + Math.floor(rand() * 4000);
      const userTok = Math.floor(chat * 0.11);
      const agentTok = Math.floor(chat * 0.31);
      const toolTok = chat - userTok - agentTok;
      const children = [
        [`${idx++}: USER_INPUT`, userTok],
        [`${idx++}: PLANNER_RESPONSE`, agentTok],
        [`${idx++}: RUN_COMMAND`, Math.floor(toolTok * 0.45)],
        [`${idx++}: VIEW_FILE`, Math.floor(toolTok * 0.35)],
        [`${idx++}: CODE_ACTION`, toolTok - Math.floor(toolTok * 0.45) - Math.floor(toolTok * 0.35)],
      ];
      db.generation({
        model: m.id,
        displayName: m.name,
        maxContext: 256_000,
        groups: [
          pbGroup(1, 2400),
          pbGroup(2, 2800),
          pbGroup(3, 5100),
          pbGroup(5, 4100),
          pbGroup(7, chat, children),
        ],
        usage: pbUsage({ inp: 8000 + Math.floor(rand() * 6000), out, cache: 60000 + chat, think: Math.floor(out * 0.38), resp: Math.floor(out * 0.62) }),
        timing: pbTiming([Math.floor(ttft), Math.round((ttft % 1) * 1e9)], [Math.floor(stream), Math.round((stream % 1) * 1e9)]),
      });
    });
    db.close();
    summaries.push({ conversation_id: featured, title: 'Refactor payment retry logic' });
  }
  for (let c = 0; c < 3; c += 1) {
    const id = uuid(9100 + c);
    const db = createConvDb(join(desktop, `${id}.db`));
    const start = nowSec - (5 + c * 2) * 3600;
    db.step(14, { metadata: pbTs(start), payloadField: 19, payload: pbField(2, pick(TITLES)) });
    const m = pickModel();
    for (let i = 0; i < 6 + c * 3; i += 1) {
      db.step(15, { metadata: pbTs(start + i * 120), payloadField: 20, payload: pbField(1, 'ok') });
      db.generation({ model: m.id, displayName: m.name, usage: pbUsage({ inp: 3000, out: m.out, cache: m.inp }) });
    }
    db.close();
    summaries.push({ conversation_id: id, title: pick(TITLES) });
  }

  createSummariesDb(join(geminiDir, 'antigravity', 'conversation_summaries.db'), summaries);
  return featured;
}

function quotaFixture(nowMs) {
  const iso = (ms) => new Date(nowMs + ms).toISOString();
  const H = 3600e3;
  const D = 24 * H;
  const status = {
    userStatus: {
      planStatus: { planInfo: { teamsTier: 'TEAMS_TIER_PRO', planName: 'Pro' } },
      userTier: { id: 'g1-pro-tier', name: 'Pro' },
      cascadeModelConfigData: {
        clientModelConfigs: [
          { label: 'Claude Opus 4.6 (Thinking)', modelId: 'claude-opus-4-6', quotaInfo: { remainingFraction: 0.72, resetTime: iso(3 * H + 42 * 60e3) } },
          { label: 'Claude Sonnet 4.6 (Thinking)', modelId: 'claude-sonnet-4-6', quotaInfo: { remainingFraction: 0.72, resetTime: iso(3 * H + 42 * 60e3) } },
          { label: 'GPT-OSS 120B (Medium)', modelId: 'gpt-oss-120b', quotaInfo: { remainingFraction: 0.72, resetTime: iso(3 * H + 42 * 60e3) } },
          { label: 'Gemini 3 Pro (High)', modelId: 'gemini-3-pro-high', quotaInfo: { remainingFraction: 0.15, resetTime: iso(1 * H + 18 * 60e3) } },
          { label: 'Gemini 3 Pro (Low)', modelId: 'gemini-3-pro-low', quotaInfo: { remainingFraction: 0.15, resetTime: iso(1 * H + 18 * 60e3) } },
          { label: 'Gemini 3 Flash', modelId: 'gemini-3-flash', quotaInfo: { remainingFraction: 0.15, resetTime: iso(1 * H + 18 * 60e3) } },
        ],
      },
    },
  };
  const models = {
    response: {
      models: {
        'claude-opus-4-6': { displayName: 'Claude Opus 4.6 (Thinking)', maxTokens: 1000000, modelProvider: 'MODEL_PROVIDER_ANTHROPIC', quotaInfo: { remainingFraction: 0.72, resetTime: iso(3 * H + 42 * 60e3) } },
        'claude-sonnet-4-6': { displayName: 'Claude Sonnet 4.6 (Thinking)', maxTokens: 1000000, modelProvider: 'MODEL_PROVIDER_ANTHROPIC', quotaInfo: { remainingFraction: 0.72, resetTime: iso(3 * H + 42 * 60e3) } },
        'gpt-oss-120b': { displayName: 'GPT-OSS 120B (Medium)', maxTokens: 131072, modelProvider: 'MODEL_PROVIDER_OPENAI', quotaInfo: { remainingFraction: 0.72, resetTime: iso(3 * H + 42 * 60e3) } },
        'gemini-3-pro-high': { displayName: 'Gemini 3 Pro (High)', maxTokens: 1048576, modelProvider: 'MODEL_PROVIDER_GOOGLE', quotaInfo: { remainingFraction: 0.15, resetTime: iso(1 * H + 18 * 60e3) } },
        'gemini-3-pro-low': { displayName: 'Gemini 3 Pro (Low)', maxTokens: 1048576, modelProvider: 'MODEL_PROVIDER_GOOGLE', quotaInfo: { remainingFraction: 0.15, resetTime: iso(1 * H + 18 * 60e3) } },
        'gemini-3-flash': { displayName: 'Gemini 3 Flash', maxTokens: 1048576, modelProvider: 'MODEL_PROVIDER_GOOGLE', quotaInfo: { remainingFraction: 0.15, resetTime: iso(1 * H + 18 * 60e3) } },
        tab_flash_lite_preview: { quotaInfo: { remainingFraction: 1 }, modelProvider: 'MODEL_PROVIDER_GOOGLE' },
      },
      agentModelSorts: [
        { displayName: 'Recommended', groups: [{ modelIds: ['claude-opus-4-6', 'claude-sonnet-4-6', 'gpt-oss-120b', 'gemini-3-pro-high', 'gemini-3-pro-low', 'gemini-3-flash'] }] },
      ],
    },
  };
  const summary = {
    response: {
      groups: [
        {
          displayName: 'Third Party Limit Remaining',
          buckets: [
            { bucketId: '3p-weekly', displayName: 'Weekly Limit Remaining', remainingFraction: 0.41, resetTime: iso(4 * D + 12 * H) },
            { bucketId: '3p-5h', displayName: 'Five Hour Limit Remaining', remainingFraction: 0.72, resetTime: iso(3 * H + 42 * 60e3) },
          ],
        },
        {
          displayName: 'Gemini Limit Remaining',
          buckets: [
            { bucketId: 'gemini-weekly', displayName: 'Weekly Limit Remaining', remainingFraction: 0.8, resetTime: iso(5 * D + 4 * H) },
            { bucketId: 'gemini-5h', displayName: 'Five Hour Limit Remaining', remainingFraction: 0.15, resetTime: iso(1 * H + 18 * 60e3) },
          ],
        },
      ],
    },
  };
  const quota = parseQuota(status, models, nowMs, summary);
  return { quota, models, status };
}

// --- 2. panel page -------------------------------------------------------------

// Antigravity injects its theme variables into sidecar WebViews; emulate the dark theme.
const HOST_THEME = `
:root { --foreground: #e3e3e3; --muted-foreground: #9aa0a6; --border: #2e3033; --background: #131314; color-scheme: dark; }
html, body { background: #131314; overflow: hidden; scrollbar-gutter: auto; }
html { width: ${PANEL_W}px; }
`;

function panelHtml({ api, conversationId, lang, tab, historyView = 'totals' }) {
  const css = readFileSync(join(WEB_DIR, 'styles.css'), 'utf8');
  const appJs = bundleWebApp(WEB_DIR, 'app.js');
  let html = readFileSync(join(WEB_DIR, 'index.html'), 'utf8');
  const boot = `<script>
(function () {
  try {
    localStorage.clear();
    localStorage.setItem('ctx.lang', ${JSON.stringify(lang)});
    localStorage.setItem('ctx.tab', ${JSON.stringify(tab)});
    localStorage.setItem('ctx.historyView', ${JSON.stringify(historyView)});
    localStorage.setItem('ctx.period', 'd30');
  } catch (e) {}
  var api = ${JSON.stringify(api)};
  var respond = function (url) {
    var path = String(url).split('?')[0];
    var body = Object.prototype.hasOwnProperty.call(api, path) ? api[path] : { error: 'not-mocked' };
    return Promise.resolve(new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } }));
  };
  window.sidecar = {
    conversationId: ${JSON.stringify(conversationId)},
    getWorkspaceUris: function () { return Promise.resolve([]); },
    onWorkspaceChange: function () {},
    fetch: respond
  };
})();
</script>`;
  html = html.replace(/<script\s+src="\/preload\.js"><\/script>/, boot);
  html = html.replace(/<link[^>]*href="styles\.css[^"]*"[^>]*>/, () => `<style>${css.replace(/^\uFEFF/, '')}\n${HOST_THEME}</style>`);
  html = html.replace(/<script[^>]*src="app\.js[^"]*"[^>]*><\/script>/, () => `<script>${appJs.replace(/<\/script/gi, '<\\/script')}</script>`);
  if (html.includes('src="app.js')) throw new Error('app.js tag not replaced');
  return html;
}

// Chrome enforces a minimum window width (~500px), so narrow panels are rendered in a
// wider window and cropped afterwards with this tiny pure-Node PNG decoder/encoder.
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
export function cropPng(file, cropW, cropH) {
  const buf = readFileSync(file);
  if (!buf.subarray(0, 8).equals(PNG_SIG)) throw new Error('not a PNG');
  let off = 8;
  let ihdr = null;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') ihdr = data;
    else if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  const w = ihdr.readUInt32BE(0);
  const h = ihdr.readUInt32BE(4);
  const depth = ihdr[8];
  const colorType = ihdr[9];
  if (depth !== 8 || ihdr[12] !== 0 || ![2, 6].includes(colorType)) throw new Error('unsupported PNG format');
  const bpp = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const pixels = Buffer.alloc(h * stride);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y += 1) {
    const ft = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x += 1) {
      const a = x >= bpp ? out[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[x] = v & 0xff;
    }
    prev = out;
  }
  const cw = Math.min(cropW, w);
  const ch = Math.min(cropH, h);
  const outRaw = Buffer.alloc(ch * (cw * bpp + 1));
  for (let y = 0; y < ch; y += 1) {
    outRaw[y * (cw * bpp + 1)] = 0;
    pixels.copy(outRaw, y * (cw * bpp + 1) + 1, y * stride, y * stride + cw * bpp);
  }
  const hdr = Buffer.from(ihdr);
  hdr.writeUInt32BE(cw, 0);
  hdr.writeUInt32BE(ch, 4);
  writeFileSync(file, Buffer.concat([PNG_SIG, pngChunk('IHDR', hdr), pngChunk('IDAT', deflateSync(outRaw, { level: 9 })), pngChunk('IEND', Buffer.alloc(0))]));
}

function screenshot(chrome, htmlPath, outPng, width, height, budget = 4000) {
  const winW = Math.max(width, 640);
  const ud = mkdtempSync(join(tmpdir(), 'agy-shot-ud-'));
  try {
    const r = spawnSync(chrome, [
      '--headless=new', '--no-sandbox',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-scrollbars',
      '--allow-file-access-from-files',
      `--user-data-dir=${ud}`,
      `--window-size=${winW},${height}`,
      `--force-device-scale-factor=${SCALE}`,
      `--virtual-time-budget=${budget}`,
      `--screenshot=${outPng}`,
      pathToFileURL(htmlPath).href,
    ], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    if (r.status !== 0 || !existsSync(outPng)) {
      throw new Error(`Chrome screenshot failed (${r.status}): ${r.stderr || r.error}`);
    }
    if (winW !== width) cropPng(outPng, width * SCALE, height * SCALE);
  } finally {
    rmSync(ud, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

function dumpDom(chrome, htmlPath) {
  const ud = mkdtempSync(join(tmpdir(), 'agy-dom-ud-'));
  try {
    const r = spawnSync(chrome, [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--allow-file-access-from-files',
      `--user-data-dir=${ud}`, '--virtual-time-budget=4000', '--dump-dom', pathToFileURL(htmlPath).href,
    ], { encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
    return r.stdout || '';
  } finally {
    rmSync(ud, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

// --- 3. composites -------------------------------------------------------------

const COPY = {
  en: {
    title: 'Agy Lens',
    tagline: 'The all-in-one local cockpit for Antigravity 2.0',
    bullets: ['Context window & live tok/s', '5h & weekly quotas + cycle value', 'Subagent trees & project % share', '6-style WebGL & Pixel share cards'],
    foot: 'Zero dependencies \u00b7 100% local \u00b7 pure Node.js 24 \u00b7 Antigravity 2.0',
    labels: ['Overview', 'Quota', 'History'],
    galleryTitle: '6 Share Card Styles',
    gallerySub: 'Night & Day themes \u00b7 60fps WebGL preview \u00b7 Live Photo / MP4 / GIF / PNG / SVG \u00b7 Zero titles or paths',
    styleLabels: {
      mountain: 'Mountain \u00b7 Almanac (Night)',
      abyssal: 'Abyssal \u00b7 Trench (Night)',
      eclipse: 'Eclipse \u00b7 Astrolabe (Night)',
      bauhaus: 'Bauhaus \u00b7 Overprint (Day)',
      phosphor: 'Phosphor \u00b7 Ribbon (Night)',
      pixel: 'Pixel \u00b7 Hero (RPG Card \u00b7 13 Classes & 12 Achievements)',
      mountainDay: 'Mountain \u00b7 Almanac (Day)',
      eclipseDay: 'Eclipse \u00b7 Astrolabe (Day)',
    },
  },
  zh: {
    title: 'Agy Lens',
    tagline: 'Antigravity 2.0 一站式本地驾驶舱',
    bullets: ['上下文拆解与实时 tok/s', '5 小时 / 周额度与周期估值', '子智能体树与项目周额度占比', '6 种 WebGL 与像素风分享卡片'],
    foot: '零依赖 \u00b7 100% 本地 \u00b7 纯 Node.js 24 \u00b7 Antigravity 2.0',
    labels: ['概览', '额度', '历史'],
    galleryTitle: '6 种分享卡片风格',
    gallerySub: '深浅双主题 \u00b7 60fps WebGL 实时预览 \u00b7 实况 / MP4 / GIF / PNG / SVG \u00b7 绝不含标题与路径',
    styleLabels: {
      mountain: '高山·年鉴（深色）',
      abyssal: '深海·潜航（深色）',
      eclipse: '星穹·日晷（深色）',
      bauhaus: '瑞士·叠印（浅色）',
      phosphor: '磷光·丝带（深色）',
      pixel: '像素·角色卡（13 职业 · 12 成就 · 动态像素）',
      mountainDay: '高山·年鉴（浅色）',
      eclipseDay: '星穹·日晷（浅色）',
    },
  },
};

function artDataUri(relPath) {
  const res = readShareAsset(SHARE_ART_DIR, relPath);
  if (!res || res.error || !res.data) return '';
  return `data:${res.mime};base64,${res.data}`;
}

function scopeSvgIds(svg, prefix) {
  const ids = new Set();
  for (const m of svg.matchAll(/\bid="([^"]+)"/g)) ids.add(m[1]);
  if (!ids.size) return svg;
  let out = svg;
  for (const id of ids) {
    const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const next = `${prefix}_${id}`;
    out = out
      .replace(new RegExp(`\\bid="${esc}"`, 'g'), `id="${next}"`)
      .replace(new RegExp(`url\\(#${esc}\\)`, 'g'), `url(#${next})`)
      .replace(new RegExp(`(xlink:)?href="#${esc}"`, 'g'), `$1href="#${next}"`);
  }
  return out;
}

function shareGalleryHtml({ history, lang }) {
  const c = COPY[lang];
  const basePayload = {
    period: 'd30',
    totals: history.totals,
    byModel: history.by_model,
    daily: history.daily,
    hourlyToday: history.hourly_today,
    weeklyValueUsd: history.weekly_value_usd,
    lang,
  };
  const svgs = {
    mountain: scopeSvgIds(buildShareCardSvg({ ...basePayload, theme: 'dark' }), 'mtn_d'),
    abyssal: scopeSvgIds(buildAbyssalCardSvg({ ...basePayload, theme: 'dark' }), 'aby_d'),
    eclipse: scopeSvgIds(buildEclipseCardSvg({ ...basePayload, theme: 'dark' }), 'ecl_d'),
    bauhaus: scopeSvgIds(buildBauhausCardSvg({ ...basePayload, theme: 'light' }), 'bau_l'),
    phosphor: scopeSvgIds(buildPhosphorCardSvg({ ...basePayload, theme: 'dark' }), 'pho_d'),
    mountainDay: scopeSvgIds(buildShareCardSvg({ ...basePayload, theme: 'light' }), 'mtn_l'),
    eclipseDay: scopeSvgIds(buildEclipseCardSvg({ ...basePayload, theme: 'light' }), 'ecl_l'),
  };
  const prof = buildProfile(history, 'd30', { nickname: lang === 'zh' ? '星海旅人' : 'Nova', gender: 'male' });
  const ach = usageAchievements(history, 'd30');
  const arenaId = CLASS_ARENA[prof.classId] || 'observatory';
  const charUri = artDataUri(charStillPath(prof.classId, prof.stage)) || artDataUri(charIdlePath(prof.classId, prof.stage));
  const arenaUri = artDataUri(arenaPath(arenaId));
  const pixelSvg = buildRoleCardSvg({
    profile: prof,
    achievements: ach,
    art: { char: charUri, arena: arenaUri },
    lang,
    arena: arenaId,
    theme: 'dark',
  });
  const topRow = [
    ['mountain', svgs.mountain],
    ['abyssal', svgs.abyssal],
    ['eclipse', svgs.eclipse],
    ['bauhaus', svgs.bauhaus],
    ['phosphor', svgs.phosphor],
  ].map(([k, svg]) => `<figure class="poster"><div class="card">${svg}</div><figcaption>${c.styleLabels[k]}</figcaption></figure>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0}
html,body{width:1400px;height:884px;overflow:hidden}
body{background:#0b0d10;font-family:"Segoe UI","Microsoft YaHei UI","PingFang SC",system-ui,sans-serif;color:#e8eaed;padding:34px 40px 30px;display:flex;flex-direction:column}
header{display:flex;align-items:baseline;gap:14px;margin-bottom:20px}
h1{font-size:24px;font-weight:600;letter-spacing:-.01em}
header p{font-size:14px;color:#9aa0a6}
.row1{display:grid;grid-template-columns:repeat(5,251px);gap:16px;margin-bottom:22px}
.row2{display:grid;grid-template-columns:694px 291px 291px;gap:22px}
figure{display:flex;flex-direction:column;gap:8px;min-width:0}
.card{border-radius:10px;overflow:hidden;border:1px solid rgba(255,255,255,.10);box-shadow:0 12px 32px rgba(0,0,0,.5);background:#111317}
.card svg{display:block;width:100%;height:100%}
.row1 .card{width:251px;height:314px}
.row2 .pixel .card{width:694px;height:364px;border-radius:8px}
.row2 .pixel .card svg,.row2 .pixel .card image{image-rendering:pixelated}
.row2 .day .card{width:291px;height:364px}
figcaption{font-size:12.5px;color:#9aa0a6;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
</style></head><body>
<header><h1>${c.galleryTitle}</h1><p>${c.gallerySub}</p></header>
<div class="row1">${topRow}</div>
<div class="row2">
  <figure class="pixel"><div class="card">${pixelSvg}</div><figcaption>${c.styleLabels.pixel}</figcaption></figure>
  <figure class="day"><div class="card">${svgs.mountainDay}</div><figcaption>${c.styleLabels.mountainDay}</figcaption></figure>
  <figure class="day"><div class="card">${svgs.eclipseDay}</div><figcaption>${c.styleLabels.eclipseDay}</figcaption></figure>
</div>
</body></html>`;
}

const LOGO = readFileSync(join(ROOT, 'assets', 'logo.svg'), 'utf8');

function heroHtml(lang, shots) {
  const c = COPY[lang];
  const imgs = shots.map((p, i) => `<figure><img src="${pathToFileURL(p).href}"><figcaption>${c.labels[i]}</figcaption></figure>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0}
html,body{width:1400px;height:820px;overflow:hidden}
body{background:#0b0d10;font-family:"Segoe UI","Microsoft YaHei UI","PingFang SC",system-ui,sans-serif;color:#e8eaed;padding:44px 56px}
header{display:flex;align-items:center;gap:16px;margin-bottom:28px}
header svg{width:44px;height:44px}
h1{font-size:30px;font-weight:600;letter-spacing:-.01em}
h1 span{color:#9aa0a6;font-weight:400;margin-left:12px;font-size:20px}
.row{display:flex;gap:28px;justify-content:center}
figure{display:flex;flex-direction:column;align-items:center;gap:10px}
img{width:404px;height:620px;object-fit:cover;object-position:top;border-radius:12px;border:1px solid #2a2e33;box-shadow:0 10px 30px rgba(0,0,0,.45)}
figcaption{font-size:14px;color:#9aa0a6}
</style></head><body>
<header>${LOGO}<h1>${c.title}<span>${c.tagline}</span></h1></header>
<div class="row">${imgs}</div>
</body></html>`;
}

function socialHtml(lang, shots) {
  const c = COPY[lang];
  return `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0}
html,body{width:1280px;height:640px;overflow:hidden}
body{background:#0b0d10;font-family:"Segoe UI","Microsoft YaHei UI","PingFang SC",system-ui,sans-serif;color:#e8eaed;display:flex;padding:56px 0 0 64px;gap:40px}
.copy{width:520px;padding-top:30px}
.brand{display:flex;align-items:center;gap:16px;margin-bottom:26px}
.brand svg{width:56px;height:56px}
h1{font-size:52px;font-weight:600;letter-spacing:-.02em}
p.tag{font-size:24px;line-height:1.35;color:#c4c7c5;margin-bottom:30px}
ul{list-style:none;padding:0;display:grid;gap:13px;margin-bottom:34px}
li{font-size:19px;color:#e8eaed;display:flex;align-items:center;gap:12px}
li::before{content:"";width:8px;height:8px;border-radius:50%;background:#8ab4f8;flex:none}
li:nth-child(2)::before{background:#f9ab00}li:nth-child(3)::before{background:#81c995}li:nth-child(4)::before{background:#c58af9}
.foot{font-size:15px;color:#9aa0a6}
.shots{position:relative;flex:1}
.shots img{position:absolute;width:300px;border-radius:12px;border:1px solid #2a2e33;box-shadow:0 18px 40px rgba(0,0,0,.55)}
.shots img:nth-child(1){left:0;top:0}
.shots img:nth-child(2){left:236px;top:60px}
</style></head><body>
<div class="copy">
  <div class="brand">${LOGO}<h1>${c.title}</h1></div>
  <p class="tag">${c.tagline}</p>
  <ul>${c.bullets.map((b) => `<li>${b}</li>`).join('')}</ul>
  <div class="foot">${c.foot}</div>
</div>
<div class="shots"><img src="${pathToFileURL(shots[0]).href}"><img src="${pathToFileURL(shots[1]).href}"></div>
</body></html>`;
}

function pngSize(p) {
  const b = readFileSync(p);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

// --- main ----------------------------------------------------------------------

async function main() {
  const chrome = findChrome();
  if (!chrome) throw new Error('Chrome/Edge not found. Pass --chrome PATH or set CHROME_PATH.');

  const work = mkdtempSync(join(tmpdir(), 'agy-lens-shots-'));
  const geminiDir = join(work, 'gemini');
  const now = new Date();
  const nowSec = Math.floor(now.getTime() / 1000);
  try {
    const featured = seedTree(geminiDir, nowSec);
    const { quota, models, status } = quotaFixture(now.getTime());
    const catalogPath = join(work, 'model-catalog.json');
    writeModelCatalog(catalogPath, models, status);
    const dayMs = 24 * 3600 * 1000;
    const weekMs = 7 * dayMs;
    const earlyMs = 4 * dayMs;
    const quotaCycles = { version: 2, pools: {} };
    for (const [pk, w] of Object.entries(quota.weekly || {})) {
      const rMs = Date.parse(w.reset_time);
      if (!Number.isFinite(rMs)) continue;
      const t1 = rMs - weekMs;
      const t2 = t1 - weekMs;
      const t3 = t2 - earlyMs;
      const t4 = t3 - weekMs;
      const isGem = pk === 'gemini';
      quotaCycles.pools[pk] = [
        {
          cycle_start: new Date(t1).toISOString(),
          cycle_start_source: 'prev_reset',
          cycle_duration_ms: weekMs,
          reset_time: new Date(rMs).toISOString(),
          observed_at: now.toISOString(),
          remaining_fraction: w.remaining_fraction,
          used_fraction: 1 - w.remaining_fraction,
          saturated: false,
          plan: quota.plan,
          tier: quota.tier,
        },
        {
          cycle_start: new Date(t2).toISOString(),
          cycle_start_source: 'prev_reset',
          cycle_duration_ms: weekMs,
          reset_time: new Date(t1).toISOString(),
          ended_at: new Date(t1).toISOString(),
          observed_at: new Date(t1 - 3600e3).toISOString(),
          remaining_fraction: isGem ? 0.58 : 0.42,
          used_fraction: isGem ? 0.42 : 0.58,
          saturated: false,
          plan: quota.plan,
          tier: quota.tier,
        },
        {
          cycle_start: new Date(t3).toISOString(),
          cycle_start_source: 'prev_reset',
          cycle_duration_ms: earlyMs,
          reset_time: new Date(t3 + weekMs).toISOString(),
          ended_at: new Date(t2).toISOString(),
          observed_at: new Date(t2 - 3600e3).toISOString(),
          remaining_fraction: isGem ? 0.08 : 0.12,
          used_fraction: isGem ? 0.92 : 0.88,
          saturated: false,
          plan: quota.plan,
          tier: quota.tier,
        },
        {
          cycle_start: new Date(t4).toISOString(),
          cycle_start_source: 'prev_reset',
          cycle_duration_ms: weekMs,
          reset_time: new Date(t3).toISOString(),
          ended_at: new Date(t3).toISOString(),
          observed_at: new Date(t3 - 3600e3).toISOString(),
          remaining_fraction: isGem ? 0.28 : 0.25,
          used_fraction: isGem ? 0.72 : 0.75,
          saturated: false,
          plan: quota.plan,
          tier: quota.tier,
        },
      ];
    }
    const report = await buildReport({ dbPath: join(geminiDir, 'antigravity', 'conversations', `${featured}.db`), conversationId: featured, geminiDir, modelCatalogPath: catalogPath });
    report.updatedAt = now.toISOString();
    const history = await scan(defaultRoots(geminiDir), { now, modelCatalogPath: catalogPath, quotaCycles });
    const pricing = { source: 'builtin', fetched_at: null, count: 0, stale: false };
    const wake = {
      pools: {
        gemini: { auto: false, pending: false, latched: false, in_flight: false, model: { id: 'gemini-3-flash', display_name: 'Gemini 3 Flash' } },
        claude_gpt: { auto: false, pending: false, latched: false, in_flight: false, model: { id: 'gpt-oss-120b', display_name: 'GPT-OSS 120B (Medium)' } },
      },
    };
    const api = { '/api/report': report, '/api/quota': quota, '/api/quota/wake': wake, '/api/history': history, '/api/pricing': pricing };
    const fixtures = { report, quota, history, pricing };
    const fixturesJson = JSON.stringify(fixtures, null, 1);
    if (/[A-Za-z]:\\\\|\/Users\/|\/home\/|agy-lens-shots-/i.test(fixturesJson)) {
      throw new Error('fixtures contain a local path; refusing to write them');
    }
    mkdirSync(join(ROOT, 'tests', 'fixtures'), { recursive: true });
    writeFileSync(join(ROOT, 'tests', 'fixtures', 'panel-fixtures.json'), `${fixturesJson}\n`, 'utf8');

    const out = {};
    for (const lang of ['en', 'zh']) {
      const dir = join(IMG_DIR, lang);
      mkdirSync(dir, { recursive: true });
      out[lang] = [];
      for (const tab of ['overview', 'quota', 'history']) {
        const htmlPath = join(work, `${lang}-${tab}.html`);
        writeFileSync(htmlPath, panelHtml({ api, conversationId: featured, lang, tab }), 'utf8');
        const rawDom = dumpDom(chrome, htmlPath);
        writeFileSync(join(work, `${lang}-${tab}.dom.html`), rawDom, 'utf8');
        const dom = rawDom.replace(/<script\b[\s\S]*?<\/script>/gi, '').replace(/<style\b[\s\S]*?<\/style>/gi, '');
        const activeTab = new RegExp(`<button[^>]*data-tab="${tab}"[^>]*aria-selected="true"`).test(dom)
          || new RegExp(`<button[^>]*aria-selected="true"[^>]*data-tab="${tab}"`).test(dom);
        if (!activeTab) throw new Error(`${lang}/${tab}: app.js did not boot (tab not activated)`);
        if (/class="error"|data-boot-error/.test(dom)) throw new Error(`${lang}/${tab}: panel rendered an error state`);
        const png = join(dir, `${tab}.png`);
        screenshot(chrome, htmlPath, png, PANEL_W, PANEL_H);
        out[lang].push(png);
        console.log(`ok ${lang}/${tab}.png`, pngSize(png));
      }

      const cardHtml = join(work, `share-${lang}.html`);
      writeFileSync(cardHtml, shareGalleryHtml({ history, lang }), 'utf8');
      const cardPng = join(dir, 'share-card.png');
      screenshot(chrome, cardHtml, cardPng, 1400, 884, 1500);
      console.log(`ok ${lang}/share-card.png`, pngSize(cardPng));

      const heroPath = join(work, `hero-${lang}.html`);
      writeFileSync(heroPath, heroHtml(lang, out[lang]), 'utf8');
      const heroPng = join(IMG_DIR, `hero-${lang}.png`);
      screenshot(chrome, heroPath, heroPng, 1400, 820, 1500);
      console.log(`ok hero-${lang}.png`, pngSize(heroPng));
    }

    const socialPath = join(work, 'social.html');
    writeFileSync(socialPath, socialHtml('en', [out.en[0], out.en[1]]), 'utf8');
    const socialTmp = join(work, 'social@2x.png');
    // Rendered at 1x so the file is exactly 1280x640 as GitHub requires.
    const ud = mkdtempSync(join(tmpdir(), 'agy-shot-ud-'));
    const r = spawnSync(chrome, [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--hide-scrollbars', '--allow-file-access-from-files',
      `--user-data-dir=${ud}`, '--window-size=1280,640', '--force-device-scale-factor=1', '--virtual-time-budget=1500',
      `--screenshot=${socialTmp}`, pathToFileURL(socialPath).href,
    ], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    rmSync(ud, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    if (r.status !== 0) throw new Error(`social preview render failed: ${r.stderr}`);
    copyFileSync(socialTmp, join(IMG_DIR, 'social-preview.png'));
    const s = pngSize(join(IMG_DIR, 'social-preview.png'));
    if (s.width !== 1280 || s.height !== 640) throw new Error(`social-preview.png is ${s.width}x${s.height}, expected 1280x640`);
    console.log('ok social-preview.png', s);
  } finally {
    if (KEEP) console.log(`work dir kept: ${work}`);
    else rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
