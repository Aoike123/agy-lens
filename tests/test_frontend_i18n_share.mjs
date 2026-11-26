import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import {
  I18N,
  createTranslator,
  detectDefaultLang,
  localeFor,
  normalizeLang,
} from '../sidecars/agy-lens/web/i18n.js';
import * as formatMod from '../sidecars/agy-lens/web/format.js';
import {
  SHARE_CARD_HEIGHT,
  SHARE_CARD_WIDTH,
  buildShareCardSvg,
  escapeXml,
  scrubSensitiveText,
} from '../sidecars/agy-lens/web/views/share-card.js';
import { renderOverviewHtml, splitPath } from '../sidecars/agy-lens/web/views/overview.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(HERE, '..', 'sidecars', 'agy-lens', 'web');
const WEB_BUNDLE_PATH = join(HERE, '..', 'sidecars', 'agy-lens', 'lib', 'web-bundle.mjs');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function findChromeBinary() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) || null;
}

function collectWebFiles(dir) {
  const files = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, ent.name);
    if (ent.isDirectory()) files.push(...collectWebFiles(abs));
    else if (ent.isFile()) files.push(abs);
  }
  return files;
}

// --- 1. detectDefaultLang ----------------------------------------------------

test('detectDefaultLang resolves zh* locales, non-zh fallback to en, and valid stored overrides', () => {
  const zhLocales = ['zh', 'zh-CN', 'zh-TW', 'zh-Hans', 'zh-HK', 'ZH-cn', 'zh_CN', '  zh-Hans-CN  '];
  for (const loc of zhLocales) {
    assert.equal(detectDefaultLang(loc, ''), 'zh', `expected zh for ${loc}`);
    assert.equal(detectDefaultLang(loc, null), 'zh', `expected zh for ${loc} with null stored`);
    assert.equal(detectDefaultLang(loc, undefined), 'zh', `expected zh for ${loc} with undefined stored`);
    assert.equal(detectDefaultLang(loc, 'fr'), 'zh', `expected zh for ${loc} with invalid stored 'fr'`);
    assert.equal(detectDefaultLang(loc, 'zh-CN'), 'zh', `expected zh for ${loc} with invalid stored 'zh-CN'`);
    assert.equal(detectDefaultLang(loc, 'EN'), 'zh', `expected zh for ${loc} with invalid stored 'EN'`);
  }

  const enLocales = ['en', 'en-US', 'ja', 'fr', 'de', '', null, undefined, 'zhx'];
  for (const loc of enLocales) {
    assert.equal(detectDefaultLang(loc, ''), 'en', `expected en for ${String(loc)}`);
    assert.equal(detectDefaultLang(loc, null), 'en', `expected en for ${String(loc)} with null stored`);
    assert.equal(detectDefaultLang(loc, undefined), 'en', `expected en for ${String(loc)} with undefined stored`);
    assert.equal(detectDefaultLang(loc, 'invalid'), 'en', `expected en for ${String(loc)} with invalid stored`);
  }

  // Explicit stored overrides win regardless of navigator.language
  assert.equal(detectDefaultLang('zh-CN', 'en'), 'en');
  assert.equal(detectDefaultLang('en-US', 'zh'), 'zh');
  assert.equal(normalizeLang('zh'), 'zh');
  assert.equal(normalizeLang('fr'), 'en');
  assert.equal(localeFor('zh'), 'zh-CN');
  assert.equal(localeFor('en'), 'en');
});

// --- 2. I18N parity, translator, and zero Pulse leftovers --------------------

test('I18N.en and I18N.zh have 100% key, array, and callable arity parity with zero Pulse branding', () => {
  function assertParity(a, b, path = '') {
    assert.equal(typeof a, typeof b, `type mismatch at ${path}`);
    if (Array.isArray(a)) {
      assert.ok(Array.isArray(b), `expected array at ${path}`);
      assert.equal(a.length, b.length, `array length mismatch at ${path}`);
      for (let i = 0; i < a.length; i += 1) assertParity(a[i], b[i], `${path}[${i}]`);
      return;
    }
    if (typeof a === 'function') {
      assert.equal(a.length, b.length, `function arity mismatch at ${path}`);
      const args = Array.from({ length: a.length }, (_, i) => (i === 0 ? '10' : '2'));
      const outA = a(...args);
      const outB = b(...args);
      assert.equal(typeof outA, 'string', `non-string output in en at ${path}`);
      assert.equal(typeof outB, 'string', `non-string output in zh at ${path}`);
      assert.ok(!/pulse/i.test(outA), `legacy branding in en at ${path}: ${outA}`);
      assert.ok(!/pulse/i.test(outB), `legacy branding in zh at ${path}: ${outB}`);
      return;
    }
    if (a && typeof a === 'object') {
      const keysA = Object.keys(a).sort();
      const keysB = Object.keys(b).sort();
      assert.deepEqual(keysA, keysB, `object keys mismatch at ${path}`);
      for (const k of keysA) assertParity(a[k], b[k], path ? `${path}.${k}` : k);
      return;
    }
    if (typeof a === 'string') {
      assert.ok(!/pulse/i.test(a), `legacy branding in en at ${path}: ${a}`);
      assert.ok(!/pulse/i.test(b), `legacy branding in zh at ${path}: ${b}`);
    }
  }

  assertParity(I18N.en, I18N.zh);
  assert.equal(Object.keys(I18N.en.headings).length, 3);
  assert.equal(Object.keys(I18N.en.categories).length, 14);

  const tEn = createTranslator('en');
  const tZh = createTranslator('zh');
  assert.equal(tEn('tab.overview'), 'Overview');
  assert.equal(tZh('tab.overview'), '概览');
  assert.equal(tEn.locale, 'en');
  assert.equal(tZh.locale, 'zh-CN');
  assert.ok(tEn('quotaTrouble')[1].includes('Agy Lens'));
  assert.ok(tZh('quotaTrouble')[1].includes('Agy Lens'));

  for (const protoKey of ['valueOf', 'hasOwnProperty', 'toString', 'constructor', '__proto__']) {
    assert.equal(tEn(protoKey), protoKey, `tEn('${protoKey}') must return key safely`);
    assert.equal(tZh(protoKey), protoKey, `tZh('${protoKey}') must return key safely`);
  }

  for (const file of collectWebFiles(WEB_DIR)) {
    const content = readFileSync(file, 'utf8');
    assert.ok(!/\bpulse\b/i.test(content), `stale Pulse reference in ${file}`);
  }
});

// --- 3. index.html English-first defaults & pure-Node safety -----------------

test('web/index.html has English-first defaults, classic app.js tag, and web JS modules omit import()/import.meta', () => {
  const html = readFileSync(join(WEB_DIR, 'index.html'), 'utf8');
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<script src="\/preload\.js"><\/script>/);
  assert.match(html, /<link rel="stylesheet" href="styles\.css">/);
  assert.match(html, /<script src="app\.js"><\/script>/);
  assert.ok(!/<script[^>]*\btype\s*=\s*["']module["'][^>]*>/i.test(html), 'index.html must not use type="module"');
  assert.match(html, /data-i18n="tab\.overview">Overview<\/button>/);
  assert.match(html, /data-i18n="tab\.quota">Quota<\/button>/);
  assert.match(html, /data-i18n="tab\.history">History<\/button>/);
  assert.match(html, /id="refresh"[^>]*aria-label="Refresh"/);
  assert.match(html, /id="lang"[^>]*aria-label="Language"/);
  assert.match(html, /data-lang="en"[^>]*aria-pressed="true"/);
  assert.match(html, /data-lang="zh"[^>]*aria-pressed="false"/);
  assert.match(html, /data-i18n="loading">Loading…<\/p>/);

  for (const file of collectWebFiles(WEB_DIR)) {
    if (!file.endsWith('.js')) continue;
    const stripped = stripCommentsAndStringLiterals(readFileSync(file, 'utf8'));
    assert.ok(!/\bimport\s*\(/.test(stripped), `dynamic import() not allowed in ${file}`);
    assert.ok(!/\bimport\s*\.\s*meta\b/.test(stripped), `import.meta not allowed in ${file}`);
  }
});

const REGEX_PRECEDING_KEYWORDS = new Set([
  'return', 'throw', 'case', 'delete', 'void', 'typeof',
  'in', 'instanceof', 'new', 'else', 'do', 'await', 'yield', 'of',
  'export', 'default',
]);
const CONTROL_PAREN_KEYWORDS = new Set(['if', 'while', 'for', 'with']);

function stripCommentsAndStringLiterals(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  const tplStack = [];
  const parenStack = [];
  let canStartRegex = true;
  let prevCharIsDot = false;
  let prevControlKeyword = false;

  const consumeTemplateText = () => {
    out += ' "" ';
    while (i < n) {
      if (src[i] === '\\') { i += 2; continue; }
      if (src[i] === '$' && src[i + 1] === '{') {
        i += 2;
        tplStack[tplStack.length - 1] += 1;
        canStartRegex = true;
        prevCharIsDot = false;
        prevControlKeyword = false;
        return;
      }
      if (src[i] === '`') {
        i += 1;
        tplStack.pop();
        canStartRegex = false;
        prevCharIsDot = false;
        prevControlKeyword = false;
        return;
      }
      i += 1;
    }
  };

  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];

    if (/\s/.test(ch)) {
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      i += 2;
      while (i < n && src[i] !== '\n') i += 1;
      out += ' ';
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      out += ' ';
      continue;
    }
    if (ch === '\'' || ch === '"') {
      const q = ch;
      i += 1;
      while (i < n && src[i] !== q) {
        if (src[i] === '\\') i += 2;
        else i += 1;
      }
      i += 1;
      out += ' "" ';
      canStartRegex = false;
      prevCharIsDot = false;
      prevControlKeyword = false;
      continue;
    }
    if (ch === '`') {
      i += 1;
      tplStack.push(0);
      consumeTemplateText();
      continue;
    }
    if (tplStack.length > 0) {
      if (ch === '{') {
        tplStack[tplStack.length - 1] += 1;
        out += '{';
        i += 1;
        canStartRegex = true;
        prevCharIsDot = false;
        prevControlKeyword = false;
        continue;
      }
      if (ch === '}') {
        tplStack[tplStack.length - 1] -= 1;
        if (tplStack[tplStack.length - 1] === 0) {
          i += 1;
          consumeTemplateText();
          continue;
        }
        out += '}';
        i += 1;
        canStartRegex = true;
        prevCharIsDot = false;
        prevControlKeyword = false;
        continue;
      }
    }
    if (ch === '/' && canStartRegex) {
      i += 1;
      let inClass = false;
      while (i < n) {
        const rc = src[i];
        if (rc === '\\') { i += 2; continue; }
        if (rc === '[' && !inClass) { inClass = true; i += 1; continue; }
        if (rc === ']' && inClass) { inClass = false; i += 1; continue; }
        if (rc === '/' && !inClass) { i += 1; break; }
        if (rc === '\n' || rc === '\r') break;
        i += 1;
      }
      while (i < n && /[a-zA-Z]/.test(src[i])) i += 1;
      out += ' /regex/ ';
      canStartRegex = false;
      prevCharIsDot = false;
      prevControlKeyword = false;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let end = i + 1;
      while (end < n && /[A-Za-z0-9_$]/.test(src[end])) end += 1;
      const ident = src.slice(i, end);
      out += ident;
      i = end;
      canStartRegex = !prevCharIsDot && REGEX_PRECEDING_KEYWORDS.has(ident);
      prevControlKeyword = !prevCharIsDot && (CONTROL_PAREN_KEYWORDS.has(ident) || (ident === 'await' && prevControlKeyword));
      prevCharIsDot = false;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(next || ''))) {
      let end = i + 1;
      while (end < n && /[0-9A-Za-z_.]/.test(src[end])) end += 1;
      out += src.slice(i, end);
      i = end;
      canStartRegex = false;
      prevCharIsDot = false;
      prevControlKeyword = false;
      continue;
    }
    if ((ch === '+' && next === '+') || (ch === '-' && next === '-')) {
      out += src.slice(i, i + 2);
      i += 2;
      canStartRegex = false;
      prevCharIsDot = false;
      prevControlKeyword = false;
      continue;
    }
    if (ch === '=' && next === '>') {
      out += '=>';
      i += 2;
      canStartRegex = true;
      prevCharIsDot = false;
      prevControlKeyword = false;
      continue;
    }
    if (ch === '.' && next === '.' && src[i + 2] === '.') {
      out += '...';
      i += 3;
      canStartRegex = true;
      prevCharIsDot = false;
      prevControlKeyword = false;
      continue;
    }
    if (ch === '.') {
      out += '.';
      i += 1;
      canStartRegex = false;
      prevCharIsDot = true;
      prevControlKeyword = false;
      continue;
    }
    if (ch === '(') {
      out += '(';
      i += 1;
      parenStack.push(prevControlKeyword);
      canStartRegex = true;
      prevCharIsDot = false;
      prevControlKeyword = false;
      continue;
    }
    if (ch === ')') {
      out += ')';
      i += 1;
      canStartRegex = parenStack.length > 0 ? parenStack.pop() : false;
      prevCharIsDot = false;
      prevControlKeyword = false;
      continue;
    }
    out += ch;
    i += 1;
    prevCharIsDot = false;
    prevControlKeyword = false;
    canStartRegex = ch !== ']';
  }
  return out;
}

test('i18n.js, format.js, and buildShareCardSvg have zero browser global references and run in pure Node', () => {
  const forbiddenGlobalsRe = /\b(window|document|localStorage|navigator|location|Image|Blob|URL)\b/;
  const i18nSrc = stripCommentsAndStringLiterals(readFileSync(join(WEB_DIR, 'i18n.js'), 'utf8'));
  const formatSrc = stripCommentsAndStringLiterals(readFileSync(join(WEB_DIR, 'format.js'), 'utf8'));
  const shareSrc = readFileSync(join(WEB_DIR, 'views', 'share-card.js'), 'utf8');
  const shareNodePart = stripCommentsAndStringLiterals(shareSrc.split('// --- browser-only helpers')[0]);
  const motionSrc = readFileSync(join(WEB_DIR, 'views', 'share-motion.js'), 'utf8');
  const motionNodePart = stripCommentsAndStringLiterals(motionSrc.split('// --- browser-only helpers')[0]);
  const webglSrc = readFileSync(join(WEB_DIR, 'views', 'share-webgl.js'), 'utf8');
  const webglNodePart = stripCommentsAndStringLiterals(webglSrc.split('// --- browser-only helpers')[0]);
  const forbiddenMotionRe = /\b(window|document|localStorage|navigator|location|Image|Blob|URL|VideoEncoder|MediaRecorder|VideoFrame)\b/;

  for (const sym of ['detectDefaultLang', 'createTranslator']) {
    assert.match(i18nSrc, new RegExp(`\\b${sym}\\b`), `stripped i18n.js must retain exported symbol ${sym}`);
  }
  for (const sym of ['makeLoader', 'fmtAgo', 'fmtDuration', 'esc', 'fmtTok', 'getJson']) {
    assert.match(formatSrc, new RegExp(`\\b${sym}\\b`), `stripped format.js must retain exported symbol ${sym}`);
  }
  for (const sym of ['scrubSensitiveText', 'buildShareCardSvg', 'escapeXml']) {
    assert.match(shareNodePart, new RegExp(`\\b${sym}\\b`), `stripped share-card.js must retain exported symbol ${sym}`);
  }

  // Verify regex-with-quotes tokenizer catches globals after /[&<>"']/g and division
  assert.match(stripCommentsAndStringLiterals('const esc = (s) => s.replace(/[&<>"\']/g, ""); window.x = 1;'), forbiddenGlobalsRe);
  assert.match(stripCommentsAndStringLiterals('const x = a / b / c; document.title = "window";'), forbiddenGlobalsRe);
  assert.ok(!forbiddenGlobalsRe.test(stripCommentsAndStringLiterals('// window\nconst r = /document["\']/g; const s = `navigator ${1 + 2}`;')));
  assert.match(stripCommentsAndStringLiterals('if (cond) /"/.test(s); window.x = 1;'), forbiddenGlobalsRe);
  assert.match(stripCommentsAndStringLiterals('while (cond) /"/.test(s); window.x = 1;'), forbiddenGlobalsRe);
  assert.match(stripCommentsAndStringLiterals('for (;;) /"/.test(s); window.x = 1;'), forbiddenGlobalsRe);
  assert.match(stripCommentsAndStringLiterals('if (fn(a)) /"/.test(s); window.x = 1;'), forbiddenGlobalsRe);
  assert.match(stripCommentsAndStringLiterals('const y = fn() / 2; "a"; window.x = 1;'), forbiddenGlobalsRe);
  assert.ok(!forbiddenGlobalsRe.test(stripCommentsAndStringLiterals('const z = fn() / "window".length;')));
  assert.match(stripCommentsAndStringLiterals('const w = obj.if(cond) / 2; window.x = 1;'), forbiddenGlobalsRe);
  assert.match(stripCommentsAndStringLiterals('for await (const x of y) /"/.test(s); window.x = 1;'), forbiddenGlobalsRe);
  assert.match(stripCommentsAndStringLiterals('const v = obj.await(x) / 2; window.x = 1;'), forbiddenGlobalsRe);

  assert.ok(!forbiddenGlobalsRe.test(i18nSrc), 'i18n.js must not reference browser globals');
  assert.ok(!forbiddenGlobalsRe.test(formatSrc), 'format.js must not reference browser globals');
  assert.ok(!forbiddenGlobalsRe.test(shareNodePart), 'pure Node section of share-card.js must not reference browser globals');
  assert.ok(!forbiddenMotionRe.test(motionNodePart), 'pure Node section of share-motion.js must not reference browser/media globals');
  assert.ok(!forbiddenGlobalsRe.test(webglNodePart), 'pure Node section of share-webgl.js must not reference browser globals');

  assert.equal(formatMod.fmtTok(1500), '1.5k');
  assert.equal(formatMod.fmtUsd(12.345), '$12.35');
  assert.equal(formatMod.fmtCost(0.002, { estimated: true }), '≈<$0.01');
  assert.equal(formatMod.esc('<a&"b\'>'), '&lt;a&amp;&quot;b&#39;&gt;');
  assert.equal(formatMod.pctText(0.045), '4.5%');
  assert.equal(formatMod.inferPool('claude-sonnet-4-6'), 'claude_gpt');
  assert.equal(formatMod.inferPool('gemini-2.5-pro'), 'gemini');
  assert.equal(formatMod.fmtDuration(NaN), '—');
  assert.equal(formatMod.fmtDuration(Infinity), '—');
  assert.equal(formatMod.fmtDuration(-Infinity), '—');
  assert.equal(formatMod.fmtDuration(undefined), '—');
  assert.equal(formatMod.fmtDuration(-5), '0s');
  assert.equal(formatMod.fmtDuration(0), '0s');
  assert.equal(formatMod.fmtDuration(65000), '1m 5s');
});

// --- 4. buildShareCardSvg pure Node tests & adversarial sanitization ---------

test('buildShareCardSvg generates valid SVG across periods, langs, themes, empty data, and model overflow', () => {
  const sample = {
    totals: {
      today: { input: 1200, output: 800, cache_read: 4000, calls: 3, conversations: 1, est_cost_usd: 0.05 },
      d7: { input: 50000, output: 15000, cache_read: 120000, calls: 42, conversations: 6, est_cost_usd: 1.45, cost_estimated: true },
      d30: { input: 240000, output: 80000, cache_read: 900000, calls: 180, conversations: 22, est_cost_usd: 6.75, cost_estimated: true },
      all: { input: 500000, output: 140000, cache_read: 1600000, calls: 310, conversations: 35, est_cost_usd: 12.1 },
    },
    byModel: Array.from({ length: 15 }, (_, i) => ({
      model: `model-${i + 1}`,
      display_name: `Model ${i + 1}`,
      pool: i % 2 === 0 ? 'gemini' : 'claude_gpt',
      input: 10000 * (15 - i),
      output: 3000 * (15 - i),
      cache_read: 20000 * (15 - i),
      calls: 10 + i,
      est_cost_usd: 0.4,
    })),
    daily: [
      { date: '2026-11-18', tokens: 25000, calls: 5 },
      { date: '2026-11-19', tokens: 0, calls: 0 },
      { date: '2026-11-20', tokens: 82000, calls: 12 },
    ],
    d7ByPool: { gemini: 40000, claude_gpt: 25000, other: 0 },
  };

  for (const period of ['today', 'd7', 'd30', 'all']) {
    for (const lang of ['en', 'zh']) {
      for (const theme of ['dark', 'light']) {
        const svg = buildShareCardSvg({ ...sample, period, lang, theme });
        assert.ok(svg.startsWith(`<svg xmlns="http://www.w3.org/2000/svg" width="${SHARE_CARD_WIDTH}" height="${SHARE_CARD_HEIGHT}" viewBox="0 0 ${SHARE_CARD_WIDTH} ${SHARE_CARD_HEIGHT}"`));
        assert.ok(svg.endsWith('</svg>'));
        assert.ok(!/\bNaN\b|\bInfinity\b|\bundefined\b/.test(svg), `unexpected NaN/Infinity/undefined in ${period}/${lang}/${theme}`);
        assert.ok(svg.includes(lang === 'zh' ? '其余 11 个模型' : '+11 more'));
      }
    }
  }

  // Empty / zero data safety
  const emptySvg = buildShareCardSvg({ period: 'd30', totals: {}, byModel: [], daily: [], d7ByPool: {}, lang: 'en', theme: 'dark' });
  assert.ok(emptySvg.includes('No model usage yet'));
  assert.ok(!/\bNaN\b|\bInfinity\b|\bundefined\b/.test(emptySvg));
});

test('buildShareCardSvg uses per-period model slices and renders editorial model ledger rows', () => {
  const byModel = [
    { model: 'a', display_name: 'Alpha', input: 900000, output: 100000, cache_read: 0, calls: 90, est_cost_usd: 9.9,
      periods: { d7: { input: 9000, output: 1000, cache_read: 0, calls: 9, est_cost_usd: 0.12 }, today: { input: 0, output: 0, cache_read: 0, calls: 0, est_cost_usd: null } } },
    { model: 'b', display_name: 'Beta', input: 10000, output: 0, cache_read: 0, calls: 5, est_cost_usd: 0.05,
      periods: { d7: { input: 30000, output: 0, cache_read: 0, calls: 5, est_cost_usd: 0.35 }, today: { input: 0, output: 0, cache_read: 0, calls: 0, est_cost_usd: null } } },
  ];
  const totals = { d7: { input: 39000, output: 1000, cache_read: 0, calls: 14, conversations: 2 } };
  const svg = buildShareCardSvg({ period: 'd7', totals, byModel, daily: [], lang: 'en', theme: 'dark' });
  assert.ok(svg.includes('10.0k · 25%'), 'Alpha must use its d7 slice');
  assert.ok(svg.includes('30.0k · 75%'), 'Beta must use its d7 slice');
  assert.ok(svg.indexOf('Beta') < svg.indexOf('Alpha'), 'models are ranked by the period slice');
  assert.ok(svg.includes('data-editorial-poster="1"'));
  assert.equal((svg.match(/data-ledger-row="/g) || []).length, 2);
  const todaySvg = buildShareCardSvg({ period: 'today', totals, byModel, daily: [], lang: 'en', theme: 'dark' });
  assert.ok(todaySvg.includes('No model usage yet'), 'models with no usage in the period are dropped');
  assert.ok(todaySvg.includes('00:00') && todaySvg.includes('23:00'), 'today card without hourly_today still renders 24h axis');

  // sliceModelsForPeriod filters unused models, projects period est_cost_usd, and falls back gracefully on legacy rows.
  const slicedD7 = formatMod.sliceModelsForPeriod(byModel, 'd7');
  assert.equal(slicedD7.length, 2);
  assert.equal(slicedD7[0].est_cost_usd, 0.12);
  assert.equal(slicedD7[1].est_cost_usd, 0.35);
  assert.equal(formatMod.sliceModelsForPeriod(byModel, 'today').length, 0);
  const legacy = [{ model: 'leg', input: 10, output: 5, cache_read: 0, calls: 1, est_cost_usd: 0.02 }];
  assert.equal(formatMod.sliceModelsForPeriod(legacy, 'today')[0].est_cost_usd, 0.02);
});

test('buildShareCardSvg enforces strict allowlist, path/email scrubbing, and XML escaping', () => {
  assert.equal(escapeXml(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
  assert.equal(scrubSensitiveText('open file:///Users/alice/secret/repo'), 'open [path]');
  assert.equal(scrubSensitiveText('err at C:\\Users\\bob\\doc.txt'), 'err at [path]');
  assert.equal(scrubSensitiveText('unc \\\\fileserver\\share\\secret.txt'), 'unc [path]');
  assert.equal(scrubSensitiveText('unix /Users/bob/app /home/bob/work /tmp/a /var/b'), 'unix [path] [path] [path] [path]');
  assert.equal(scrubSensitiveText('mail alice@example.com'), 'mail [redacted]');
  // 6 adversarial path-redaction cases
  assert.equal(scrubSensitiveText('C:\\Users\\Alice Smith\\my secret\\repo'), '[path]');
  assert.equal(scrubSensitiveText('err at C:\\Users\\Alice Smith\\my secret\\repo'), 'err at [path]');
  assert.equal(scrubSensitiveText('C:\\Users\\Alice Smith\\my secret\\repo <script>'), '[path] <script>');
  assert.equal(scrubSensitiveText('//server/share/dir'), '[path]');
  assert.equal(scrubSensitiveText('/users/alice/proj'), '[path]');
  assert.equal(scrubSensitiveText('model/Users/alice/proj'), 'model[path]');
  assert.equal(scrubSensitiveText('model-/Users/alice/proj'), 'model-[path]');
  assert.equal(scrubSensitiveText('/srv/secret/repo'), '[path]');
  assert.equal(scrubSensitiveText('/usr/local/bin /lib/x86 /proc/1/env /sys/net /run/sock /media/usb'), '[path] [path] [path] [path] [path] [path]');
  assert.equal(scrubSensitiveText('https://example.com/models/gemini'), 'https://example.com/models/gemini');
  // Iteration 2 challenger regression cases: file:// spaces, https?:// URL preservation, UNC/POSIX spaces, attached drives, parens, newlines
  assert.equal(scrubSensitiveText('file:///C:/Users/Alice Smith/proj'), '[path]');
  assert.equal(scrubSensitiveText('file:///Users/Alice Smith/proj'), '[path]');
  assert.equal(scrubSensitiveText('https://example.com/Users/alice'), 'https://example.com/Users/alice');
  assert.equal(scrubSensitiveText('https://example.com/lib/v1/model'), 'https://example.com/lib/v1/model');
  assert.equal(scrubSensitiveText('https://example.com/media/docs'), 'https://example.com/media/docs');
  assert.equal(scrubSensitiveText('http://example.com/Users/alice'), 'http://example.com/Users/alice');
  assert.equal(scrubSensitiveText('//server/Alice Smith/dir'), '[path]');
  assert.equal(scrubSensitiveText('\\\\fileserver\\Alice Smith\\secret.txt'), '[path]');
  assert.equal(scrubSensitiveText('/Users/Alice Smith/my secret/repo'), '[path]');
  assert.equal(scrubSensitiveText('modelC:\\Users\\alice\\proj'), 'model[path]');
  assert.equal(scrubSensitiveText('pathC:\\Users\\alice\\proj'), 'path[path]');
  assert.equal(scrubSensitiveText('foo:bar'), 'foo:bar');
  assert.equal(scrubSensitiveText('(C:\\Users\\alice\\proj)'), '([path])');
  assert.equal(scrubSensitiveText('[C:\\Users\\alice\\proj]'), '[[path]]');
  assert.equal(scrubSensitiveText('Claude 3.7 Sonnet (Thinking)'), 'Claude 3.7 Sonnet (Thinking)');
  assert.equal(scrubSensitiveText('C:\\Users\\Program Files (x86)\\App'), '[path]');
  assert.equal(scrubSensitiveText('C:\\Users\\alice\\proj\nGemini 2.5 Pro'), '[path] Gemini 2.5 Pro');
  // Iteration 3 challenger regression cases: paren+space inside paths, URL query/boundary leaks, ReDoS linear time, non-HTTP schemes, single-slash schemes
  assert.equal(scrubSensitiveText('C:\\Users\\Alice (1) 2\\proj'), '[path]');
  assert.equal(scrubSensitiveText('C:\\Users\\Alice (Team Lead) 2\\proj'), '[path]');
  assert.equal(scrubSensitiveText('/Users/Alice (1) 2/proj'), '[path]');
  assert.equal(scrubSensitiveText('file:///C:/Users/Alice (1) 2/proj'), '[path]');
  assert.equal(scrubSensitiveText('C:\\Program Files (x86)'), '[path]');
  assert.equal(scrubSensitiveText('C:\\Program Files (x86)\\App'), '[path]');
  assert.equal(scrubSensitiveText('(file:///C:/Users/Alice Smith/proj)'), '([path])');
  assert.equal(scrubSensitiveText('[repo](/Users/Alice Smith/proj)'), '[repo]([path])');
  assert.equal(scrubSensitiveText('(see C:\\Users\\alice\\proj).'), '(see [path]).');
  assert.equal(scrubSensitiveText('https://x.co/?p=C:\\Users\\bob'), 'https://x.co/?p=[path]');
  assert.equal(scrubSensitiveText('https://example.com/?path=C:\\Users\\Alice Smith\\proj'), 'https://example.com/?path=[path]');
  assert.equal(scrubSensitiveText('https://example.com/?file=file:///Users/alice/secret'), 'https://example.com/?file=[path]');
  assert.equal(scrubSensitiveText('https://example.com,C:\\Users\\alice\\secret'), 'https://example.com,[path]');
  assert.equal(scrubSensitiveText('https://example.com;C:\\Users\\alice\\secret'), 'https://example.com;[path]');
  assert.equal(scrubSensitiveText('(https://example.com/lib/v1/model)'), '(https://example.com/lib/v1/model)');
  assert.equal(scrubSensitiveText('https://example.com/models/gemini-2.5-pro?v=1&x=2'), 'https://example.com/models/gemini-2.5-pro?v=1&x=2');
  assert.equal(scrubSensitiveText('https://example.com/Users/alice?a=1#f'), 'https://example.com/Users/alice?a=1#f');
  assert.equal(scrubSensitiveText('ftp://example.com/Users/alice/file'), 'ftp://example.com/Users/alice/file');
  assert.equal(scrubSensitiveText('ws://localhost:8080/lib/v1'), 'ws://localhost:8080/lib/v1');
  assert.equal(scrubSensitiveText('wss://example.com/media/stream'), 'wss://example.com/media/stream');
  assert.equal(scrubSensitiveText('custom+scheme://host/var/data'), 'custom+scheme://host/var/data');
  assert.equal(scrubSensitiveText('http:/broken/path'), 'http:/broken/path');
  assert.equal(scrubSensitiveText('gs:/bucket/model'), 'gs:/bucket/model');
  // Iteration 4 challenger regression cases: IDE/local URI schemes, unbalanced )/] in paths, space+user@host in paths, balanced URLs, and ReDoS
  assert.equal(scrubSensitiveText('vscode-file:///C:/Users/alice/secret'), '[path]');
  assert.equal(scrubSensitiveText('vscode-file://vscode-app/Users/alice/secret'), '[path]');
  assert.equal(scrubSensitiveText('vscode-file:///C:/Users/Alice Smith/secret'), '[path]');
  assert.equal(scrubSensitiveText('(vscode-file:///C:/Users/alice/secret)'), '([path])');
  assert.equal(scrubSensitiveText('vscode-userdata:///Users/alice/settings.json'), '[path]');
  assert.equal(scrubSensitiveText('vscode-remote://ssh-remote+host/home/alice/secret'), '[path]');
  assert.equal(scrubSensitiveText('vscode-vfs://github/alice/secret'), '[path]');
  assert.equal(scrubSensitiveText('local-file:///Users/alice/secret'), '[path]');
  assert.equal(scrubSensitiveText('app-file:///C:/Users/alice/secret'), '[path]');
  assert.equal(scrubSensitiveText('custom-local:///Users/alice/secret'), '[path]');
  assert.equal(scrubSensitiveText('C:\\Users\\1) Project\\secret'), '[path]');
  assert.equal(scrubSensitiveText('C:\\Users\\1] Project\\secret'), '[path]');
  assert.equal(scrubSensitiveText('C:\\Users\\1).txt\\secret'), '[path]');
  assert.equal(scrubSensitiveText('/Users/1) Project/secret'), '[path]');
  assert.equal(scrubSensitiveText('file:///Users/1) Project/secret'), '[path]');
  assert.equal(scrubSensitiveText('(C:\\Users\\alice\\proj) (D:\\Users\\bob\\proj)'), '([path]) ([path])');
  assert.equal(scrubSensitiveText('C:\\Users\\alice\\proj (backup)'), '[path]');
  assert.equal(scrubSensitiveText('C:\\Users\\alice\\proj). C:\\Users\\bob\\secret'), '[path]). [path]');
  assert.equal(scrubSensitiveText('C:\\Users\\Alice foo@bar\\secret'), '[path]');
  assert.equal(scrubSensitiveText('C:\\Users\\Alice foo@bar.com\\secret'), '[path]');
  assert.equal(scrubSensitiveText('/Users/Alice foo@bar/secret'), '[path]');
  assert.equal(scrubSensitiveText('C:\\Users\\Alice Smith\\repo alice@example.com'), '[path] [redacted]');
  assert.equal(scrubSensitiveText('https://en.wikipedia.org/wiki/Foo_(bar)/Users/alice'), 'https://en.wikipedia.org/wiki/Foo_(bar)/Users/alice');
  assert.equal(scrubSensitiveText('https://[::1]:8080/lib/v1'), 'https://[::1]:8080/lib/v1');
  assert.equal(scrubSensitiveText('(https://en.wikipedia.org/wiki/Foo_(bar)/Users/alice)'), '(https://en.wikipedia.org/wiki/Foo_(bar)/Users/alice)');
  assert.equal(scrubSensitiveText('[https://[::1]:8080/lib/v1]'), '[https://[::1]:8080/lib/v1]');
  // Iteration 5 challenger regression cases: 2-slash IDE URIs, user@domain + space in dir, outer-wrapped unbalanced )/] in paths, URL-embedded backslash paths
  assert.equal(scrubSensitiveText('vscode://file/Users/alice/secret'), '[path]');
  assert.equal(scrubSensitiveText('vscode://file/C:/Users/alice/secret'), '[path]');
  assert.equal(scrubSensitiveText('vscode-insiders://file/Users/alice/secret'), '[path]');
  assert.equal(scrubSensitiveText('cursor://file/Users/alice/secret'), '[path]');
  assert.equal(scrubSensitiveText('agy://file/Users/alice/secret'), '[path]');
  assert.equal(scrubSensitiveText('windsurf://file/Users/alice/secret'), '[path]');
  assert.equal(scrubSensitiveText('vscode-resource://file-root/Users/alice/secret'), '[path]');
  assert.equal(scrubSensitiveText('vscode-webview://1234/Users/alice/secret'), '[path]');
  assert.equal(scrubSensitiveText('cursor-remote://host/Users/alice/secret'), '[path]');
  assert.equal(scrubSensitiveText('ftps://example.com/Users/alice/file'), 'ftps://example.com/Users/alice/file');
  assert.equal(scrubSensitiveText('C:\\Users\\Alice foo@bar.com (backup)\\secret'), '[path]');
  assert.equal(scrubSensitiveText('C:\\Users\\Alice foo@bar.com 2\\secret'), '[path]');
  assert.equal(scrubSensitiveText('/Users/Alice foo@bar.com 2/secret'), '[path]');
  assert.equal(scrubSensitiveText('C:\\Users\\Alice foo@bar.com C:\\Users\\bob\\secret'), '[path] [redacted] [path]');
  assert.equal(scrubSensitiveText('(C:\\Users\\1) Project\\secret)'), '([path])');
  assert.equal(scrubSensitiveText('[C:\\Users\\1] Project\\secret]'), '[[path]]');
  assert.equal(scrubSensitiveText('((C:\\Users\\1) Project\\secret))'), '(([path]))');
  assert.equal(scrubSensitiveText('(see C:\\Users\\1) Project\\secret)'), '(see [path])');
  assert.equal(scrubSensitiveText('(C:\\Users\\alice\\proj) foo/bar'), '([path]) foo/bar');
  assert.equal(scrubSensitiveText('(C:\\Users\\alice\\proj) (D:\\Users\\bob\\proj)'), '([path]) ([path])');
  assert.equal(scrubSensitiveText('(C:\\Users\\1) (a) \\secret)'), '([path])');
  assert.equal(scrubSensitiveText('https://example.com/(C:\\Users\\alice)'), 'https://example.com/([path])');
  assert.equal(scrubSensitiveText('https://example.com/C:\\Users\\alice'), 'https://example.com/[path]');
  assert.equal(scrubSensitiveText('https://example.com/?p=C:\\Users\\alice'), 'https://example.com/?p=[path]');
  assert.equal(scrubSensitiveText('https://example.com/(C:\\Users\\alice) foo/bar'), 'https://example.com/([path]) foo/bar');
  for (const redosInput of [
    'C:\\' + ']'.repeat(8000) + 'x',
    '/Users/a/' + ']'.repeat(8000) + 'x',
    'file:///C:/' + ']'.repeat(8000) + 'x',
    'C:\\' + ')'.repeat(8000) + 'x',
    'C:\\' + '['.repeat(8000) + 'x',
    'C:\\' + '('.repeat(8000) + 'x',
    'C:\\' + ') '.repeat(4000) + '\\secret',
    'C:\\' + ') '.repeat(4000) + 'x',
    '(' + 'C:\\' + ') '.repeat(4000) + '\\secret)',
    '(' + 'C:\\' + ') '.repeat(8000) + 'x',
    '[' + 'C:\\' + '] '.repeat(4000) + '\\secret]',
    'C:\\Users\\Alice ' + 'a@' + 'b.'.repeat(3990) + 'com\\secret',
  ]) {
    const t0 = performance.now();
    const out = scrubSensitiveText(redosInput);
    const elapsedMs = performance.now() - t0;
    assert.ok(out.startsWith('[path]') || out.startsWith('([path]') || out.startsWith('[[path]'), `expected [path] prefix for ${redosInput.slice(0, 16)}`);
    assert.ok(elapsedMs < 50, `ReDoS regression: ${elapsedMs.toFixed(2)}ms on ${redosInput.slice(0, 16)}`);
  }

  const adversarial = {
    period: 'd30',
    totals: {
      d30: { input: 1000, output: 500, cache_read: 200, calls: 4, conversations: 2, est_cost_usd: 0.12 },
    },
    by_conversation: [
      { id: 'conv-secret-123', title: 'CANARY_CONV_TITLE C:\\Users\\Alice\\proj' },
    ],
    conversations: [{ id: 'conv-secret-456', title: 'CANARY_SECOND_TITLE' }],
    title: 'CANARY_TOP_TITLE',
    workspace: 'file:///Users/alice/secret-workspace',
    conversationId: 'conv-secret-789',
    first_input: 'CANARY_FIRST_INPUT',
    hourly_today: [{ hour: 10, tokens: 999, calls: 1 }],
    by_model: [
      {
        model: 'C:\\Users\\bob\\doc.txt <script>alert(1)</script>',
        display_name: 'Foo & "Bar" <Baz> \'Q\'',
        input: 600,
        output: 300,
        cache_read: 100,
        calls: 2,
      },
      {
        model: '/Users/bob/app /home/bob/work file:///D:/priv alice@example.com',
        display_name: '/Users/bob/app file:///D:/priv',
        input: 400,
        output: 200,
        cache_read: 100,
        calls: 2,
      },
      {
        model: 'C:\\Users\\bob\\script.txt',
        display_name: '<script>evil()</script>',
        input: 300,
        output: 150,
        cache_read: 50,
        calls: 1,
      },
    ],
    daily: [
      { date: '2026-11-20', tokens: 1500, calls: 4 },
      { date: '<script>bad</script>', tokens: 99, calls: 1 },
    ],
    d7_by_pool: { gemini: 1000, claude_gpt: 500, other: 0 },
    lang: 'en',
    theme: 'dark',
  };

  const svg = buildShareCardSvg(adversarial);
  const forbidden = [
    'conv-secret-123',
    'conv-secret-456',
    'conv-secret-789',
    'CANARY_CONV_TITLE',
    'CANARY_SECOND_TITLE',
    'CANARY_TOP_TITLE',
    'CANARY_FIRST_INPUT',
    'secret-workspace',
    'C:\\Users\\bob',
    '/Users/bob',
    '/home/bob',
    'file://',
    'alice@example.com',
    '<script>',
  ];
  for (const needle of forbidden) {
    assert.ok(!svg.includes(needle), `SVG leaked forbidden string: ${needle}`);
  }
  assert.ok(svg.includes('Foo &amp; &quot;Bar&quot; &lt;Baz&gt; &#39;Q&#39;'));
  assert.ok(svg.includes('&lt;script&gt;evil()&lt;/script&gt;'));

  // Hostile model names for path-redaction bypasses inside buildShareCardSvg
  const hostileModelsSvg = buildShareCardSvg({
    period: 'd30',
    totals: { d30: { input: 900, output: 450, cache_read: 0, calls: 9, conversations: 1 } },
    byModel: [
      { model: 'C:\\Users\\Alice Smith\\my secret\\repo', input: 100, output: 50, calls: 1 },
      { model: 'file:///C:/Users/Alice Smith/proj', input: 100, output: 50, calls: 1 },
      { model: 'file:///Users/Alice Smith/proj', input: 100, output: 50, calls: 1 },
      { model: '//server/Alice Smith/dir', input: 100, output: 50, calls: 1 },
      { model: '\\\\fileserver\\Alice Smith\\secret.txt', input: 100, output: 50, calls: 1 },
      { model: '/Users/Alice Smith/my secret/repo', input: 100, output: 50, calls: 1 },
      { model: 'modelC:\\Users\\alice\\proj', input: 100, output: 50, calls: 1 },
      { model: 'model/Users/alice/proj', input: 100, output: 50, calls: 1 },
      { model: '/srv/secret/repo', input: 100, output: 50, calls: 1 },
      { model: 'https://x.co/?p=C:\\Users\\bob', input: 100, output: 50, calls: 1 },
      { model: 'C:\\Users\\Alice (1) 2\\proj', input: 100, output: 50, calls: 1 },
      { model: 'vscode-file:///C:/Users/alice/secret', input: 100, output: 50, calls: 1 },
      { model: 'vscode-file://vscode-app/Users/alice/secret', input: 100, output: 50, calls: 1 },
      { model: 'vscode-userdata:///Users/alice/settings.json', input: 100, output: 50, calls: 1 },
      { model: 'vscode-remote://ssh-remote+host/home/alice/secret', input: 100, output: 50, calls: 1 },
      { model: 'local-file:///Users/alice/secret', input: 100, output: 50, calls: 1 },
      { model: 'app-file:///C:/Users/alice/secret', input: 100, output: 50, calls: 1 },
      { model: 'C:\\Users\\1) Project\\secret', input: 100, output: 50, calls: 1 },
      { model: 'C:\\Users\\1] Project\\secret', input: 100, output: 50, calls: 1 },
      { model: 'C:\\Users\\1).txt\\secret', input: 100, output: 50, calls: 1 },
      { model: 'C:\\Users\\Alice foo@bar\\secret', input: 100, output: 50, calls: 1 },
      { model: 'C:\\Users\\Alice foo@bar.com\\secret', input: 100, output: 50, calls: 1 },
      { model: 'vscode://file/Users/alice/secret', input: 100, output: 50, calls: 1 },
      { model: 'vscode-resource://file-root/Users/alice/secret', input: 100, output: 50, calls: 1 },
      { model: 'C:\\Users\\Alice foo@bar.com (backup)\\secret', input: 100, output: 50, calls: 1 },
      { model: '(C:\\Users\\1) Project\\secret)', input: 100, output: 50, calls: 1 },
      { model: 'https://example.com/(C:\\Users\\alice)', input: 100, output: 50, calls: 1 },
    ],
    daily: [],
    d7ByPool: {},
    lang: 'en',
    theme: 'dark',
  });
  for (const leaked of ['Smith', 'secret', 'repo', 'server', 'fileserver', 'share', 'dir', 'alice', 'Alice', 'bob', 'proj', 'vscode', 'settings.json', 'ssh-remote', 'local-file', 'app-file', 'Project', 'foo@bar', 'backup', 'file-root']) {
    assert.ok(!hostileModelsSvg.includes(leaked), `hostileModelsSvg leaked ${leaked}`);
  }
});

test('buildShareCardSvg adapts activity chart per period (today hourly, 7d labeled, 30d ticks, all heatmap) and ranks models by newTok', () => {
  // 1. Model ranking uses non-cache input+output even when another model has larger cache_read.
  const sortedSvg = buildShareCardSvg({
    period: 'today',
    totals: { today: { input: 10800, output: 1200, cache_read: 50_000_000, calls: 10, conversations: 2 } },
    byModel: [
      { model: 'high-cache', display_name: 'High Cache Model', input: 1500, output: 500, cache_read: 50_000_000, calls: 5 },
      { model: 'high-new', display_name: 'High New Model', input: 8000, output: 2000, cache_read: 1000, calls: 5 },
    ],
    daily: [{ date: '2026-11-23', tokens: 50012000, calls: 10 }],
    hourlyToday: [
      { hour: 9, tokens: 12000, calls: 2 },
      { hour: 14, tokens: 45000, calls: 5 },
      { hour: 21, tokens: 8000, calls: 1 },
    ],
    lang: 'zh',
    theme: 'dark',
  });
  assert.ok(sortedSvg.indexOf('High New Model') < sortedSvg.indexOf('High Cache Model'), 'models must sort by displayed input+output');
  assert.ok(sortedSvg.includes('今日活跃 3 小时'), 'today card with hourlyToday uses activeHours summary');
  assert.ok(sortedSvg.includes('00:00') && sortedSvg.includes('06:00') && sortedSvg.includes('12:00') && sortedSvg.includes('18:00') && sortedSvg.includes('23:00'));

  // 2. d7 renders 7 labeled columns with weekday + day number.
  const d7Daily = Array.from({ length: 7 }, (_, i) => ({
    date: `2026-11-${String(17 + i).padStart(2, '0')}`,
    tokens: (i + 1) * 1000,
    calls: i + 1,
  }));
  const d7Svg = buildShareCardSvg({
    period: 'd7',
    totals: { d7: { input: 20000, output: 8000, cache_read: 0, calls: 28, conversations: 3 } },
    byModel: [{ model: 'm1', display_name: 'Model One', input: 20000, output: 8000, calls: 28 }],
    daily: d7Daily,
    lang: 'en',
    theme: 'dark',
  });
  assert.ok(d7Svg.includes('Tue 17') && d7Svg.includes('Mon 23'), 'd7 card must show weekday + day ticks');
  assert.ok(d7Svg.includes('Active 7 / 7 days'));

  // 3. d30 renders start/mid/end MM-DD date ticks.
  const d30Daily = Array.from({ length: 30 }, (_, i) => {
    const dt = new Date(2026, 9, 25 + i);
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, '0');
    const d = String(dt.getDate()).padStart(2, '0');
    return { date: `${y}-${m}-${d}`, tokens: i % 2 === 0 ? 2000 : 0, calls: i % 2 === 0 ? 2 : 0 };
  });
  const d30Svg = buildShareCardSvg({
    period: 'd30',
    totals: { d30: { input: 25000, output: 5000, cache_read: 0, calls: 30, conversations: 4 } },
    byModel: [{ model: 'm1', display_name: 'Model One', input: 25000, output: 5000, calls: 30 }],
    daily: d30Daily,
    lang: 'en',
    theme: 'light',
  });
  assert.ok(d30Svg.includes('10-25') && d30Svg.includes('11-23'), 'd30 card must include MM-DD boundary ticks');

  // 4. all with >= 14 days renders a 7-row multi-week calendar heatmap grid.
  const allDaily = Array.from({ length: 120 }, (_, i) => {
    const dt = new Date(2026, 6, 27 + i);
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, '0');
    const d = String(dt.getDate()).padStart(2, '0');
    return { date: `${y}-${m}-${d}`, tokens: i % 3 === 0 ? 5000 : 0, calls: i % 3 === 0 ? 3 : 0 };
  });
  const allSvg = buildShareCardSvg({
    period: 'all',
    totals: { all: { input: 160000, output: 40000, cache_read: 0, calls: 120, conversations: 12 } },
    byModel: [{ model: 'm1', display_name: 'Model One', input: 160000, output: 40000, calls: 120 }],
    daily: allDaily,
    lang: 'en',
    theme: 'dark',
  });
  assert.match(allSvg, /Active \d+ days in 26w/);
  assert.ok(allSvg.includes('>Less<') && allSvg.includes('>More<'));
  assert.ok(!/\bNaN\b|\bInfinity\b|\bundefined\b/.test(allSvg));
});

test('splitPath escapes regex metacharacters in conversationId safely', () => {
  const t = createTranslator('en');
  assert.deepEqual(splitPath('/a/b/c.txt', 'abc[def', t), { name: 'c.txt', dir: '/a/b' });
  assert.deepEqual(
    splitPath('/home/u/.gemini/antigravity/brain/abc[def/notes.md', 'abc[def', t),
    { name: 'notes.md', dir: 'conversation folder' },
  );
  assert.deepEqual(
    splitPath('/home/u/.gemini/antigravity/brain/abc.*def/notes.md', 'abc.*def', t),
    { name: 'notes.md', dir: 'conversation folder' },
  );
  assert.deepEqual(
    splitPath('/home/u/.gemini/antigravity/brain/abcXYZdef/notes.md', 'abc.*def', t),
    { name: 'notes.md', dir: '/home/u/.gemini/antigravity/brain/abcXYZdef' },
  );
});

test('renderOverviewHtml assigns distinct spd data-key values for main vs subagent on the same model', () => {
  const html = renderOverviewHtml({
    model: 'Gemini 2.5 Pro',
    used_tokens: 1000,
    limit_tokens: 100000,
    used_pct: 1.0,
    free_tokens: 99000,
    heading: 'Token usage by category',
    grid_segments: [1000],
    categories: [],
    speed: {
      calls: 4,
      avg_streaming_tps: 50,
      avg_e2e_tps: 40,
      avg_ttft_sec: 0.5,
      latest: { streaming_tps: 50, e2e_tps: 40, ttft_sec: 0.5, output_tokens: 100 },
      recent: [
        { streaming_tps: 45, e2e_tps: 35, ttft_sec: 0.5, output_tokens: 50 },
        { streaming_tps: 50, e2e_tps: 40, ttft_sec: 0.5, output_tokens: 100 },
      ],
      by_model: [
        {
          model: 'gemini-2.5-pro',
          display_name: 'Gemini 2.5 Pro',
          agent: 'main',
          avg_streaming_tps: 55,
          avg_ttft_sec: 0.4,
          calls: 2,
          recent: [
            { streaming_tps: 50, e2e_tps: 40, ttft_sec: 0.4, output_tokens: 50 },
            { streaming_tps: 60, e2e_tps: 45, ttft_sec: 0.4, output_tokens: 50 },
          ],
        },
        {
          model: 'gemini-2.5-pro',
          display_name: 'Gemini 2.5 Pro',
          agent: 'subagent',
          avg_streaming_tps: 45,
          avg_ttft_sec: 0.6,
          calls: 2,
          recent: [
            { streaming_tps: 40, e2e_tps: 30, ttft_sec: 0.6, output_tokens: 50 },
            { streaming_tps: 50, e2e_tps: 35, ttft_sec: 0.6, output_tokens: 50 },
          ],
        },
      ],
    },
    updatedAt: '2026-11-22T04:00:00Z',
  }, {
    openKeys: new Set(['spd:gemini-2.5-pro:subagent']),
    t: createTranslator('en'),
    lang: 'en',
  });
  assert.ok(html.includes('data-key="spd:gemini-2.5-pro:main"'), 'missing main data-key');
  assert.ok(html.includes('data-key="spd:gemini-2.5-pro:subagent" open'), 'subagent open state must not collide with main');
  assert.ok(!html.includes('data-key="spd:gemini-2.5-pro:main" open'), 'main must remain closed when only subagent is open');
});

// --- 5. Headless Chrome CDP Verification -------------------------------------

function buildClassicAppBundleFallback(webDir) {
  const modules = new Map();

  const resolveRel = (fromRel, spec) => {
    const dir = posix.dirname(fromRel);
    return posix.normalize(posix.join(dir === '.' ? '' : dir, spec));
  };

  const visit = (relPosix) => {
    if (modules.has(relPosix)) return;
    const abs = join(webDir, ...relPosix.split('/'));
    let src = readFileSync(abs, 'utf8');
    const deps = [];

    src = src.replace(
      /^[ \t]*import\s*\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"]\s*;?/gm,
      (_, names, spec) => {
        const dep = resolveRel(relPosix, spec);
        deps.push(dep);
        const bindings = names
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
          .map((item) => {
            const m = item.match(/^(\w+)\s+as\s+(\w+)$/);
            return m ? `${m[1]}: ${m[2]}` : item;
          })
          .join(', ');
        return `const { ${bindings} } = __require(${JSON.stringify(dep)});`;
      },
    );

    const exportedNames = [];
    src = src.replace(
      /^[ \t]*export\s+(?=(?:async\s+)?function\b|const\b|let\b|var\b|class\b)/gm,
      '',
    );

    const orig = readFileSync(abs, 'utf8');
    for (const m of orig.matchAll(/^[ \t]*export\s+(?:async\s+function|function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) {
      exportedNames.push(m[1]);
    }
    src = src.replace(/^[ \t]*export\s*\{([^}]+)\}\s*;?/gm, (_, list) => {
      for (const item of list.split(',').map((s) => s.trim()).filter(Boolean)) {
        const m = item.match(/^(\w+)\s+as\s+(\w+)$/);
        exportedNames.push(m ? `${m[2]}: ${m[1]}` : item);
      }
      return '';
    });

    for (const dep of deps) visit(dep);
    const exportsTail = exportedNames.length
      ? `\nObject.assign(__exports, { ${exportedNames.join(', ')} });`
      : '';
    modules.set(relPosix, `function(__exports, __require) {\n${src}${exportsTail}\n}`);
  };

  visit('app.js');
  const entries = [...modules.entries()]
    .map(([id, fn]) => `${JSON.stringify(`/${id}`)}: ${fn}`)
    .join(',\n');
  return `(function() {\n'use strict';\nconst __modules = {\n${entries}\n};\nconst __cache = {};\nfunction __require(id) {\n  const key = id.startsWith('/') ? id : '/' + id;\n  if (__cache[key]) return __cache[key];\n  const exports = {};\n  __cache[key] = exports;\n  __modules[key](exports, (dep) => __require(dep));\n  return exports;\n}\n__require('/app.js');\n})();\n`;
}

async function buildClassicAppBundle() {
  if (existsSync(WEB_BUNDLE_PATH)) {
    const mod = await import(`file:///${WEB_BUNDLE_PATH.replace(/\\/g, '/')}`);
    const fn = mod.bundleWebApp || mod.buildWebBundle || mod.bundleWeb || mod.default;
    if (typeof fn === 'function') {
      const out = await fn(WEB_DIR);
      if (typeof out === 'string') return out;
      if (out && typeof out.code === 'string') return out.code;
    }
  }
  return buildClassicAppBundleFallback(WEB_DIR);
}

function createMockResponseHandler(bundledAppJs) {
  const routes = new Map();
  for (const abs of collectWebFiles(WEB_DIR)) {
    const rel = abs.slice(WEB_DIR.length).replace(/\\/g, '/');
    const mime = MIME_TYPES[extname(abs).toLowerCase()] || 'application/octet-stream';
    routes.set(rel, { abs, mime });
  }
  const requestedPaths = [];

  const mockReport = {
    model: 'Gemini 2.5 Pro',
    used_tokens: 42000,
    limit_tokens: 1000000,
    used_pct: 4.2,
    free_tokens: 958000,
    heading: 'Token usage by category',
    grid_segments: [5000, 12000, 18000, 5000, 2000],
    categories: [
      { key: 'user', name: 'User messages', tokens: 12000, pct: 1.2 },
      { key: 'agent', name: 'Agent responses', tokens: 18000, pct: 1.8 },
      { key: 'tool', name: 'Tool calls', tokens: 5000, pct: 0.5 },
      { key: 'system_prompt', name: 'System prompt', tokens: 5000, pct: 0.5 },
    ],
    speed: {
      calls: 4,
      avg_streaming_tps: 78.4,
      avg_e2e_tps: 55.2,
      avg_ttft_sec: 0.65,
      latest: {
        streaming_tps: 82.1,
        e2e_tps: 61.0,
        ttft_sec: 0.52,
        cache_hit_pct: 68,
        output_tokens: 420,
        thinking_tokens: 120,
        response_tokens: 300,
        streaming_sec: 5.1,
      },
      recent: [
        { streaming_tps: 74, e2e_tps: 52, ttft_sec: 0.7, output_tokens: 210 },
        { streaming_tps: 82.1, e2e_tps: 61, ttft_sec: 0.52, output_tokens: 420 },
      ],
      by_model: [],
    },
    session: {
      calls: 4,
      input: 18000,
      output: 4200,
      cache_read: 30000,
      total_tokens: 22200,
      cache_hit_pct: 62,
      est_cost_usd: 0.08,
      cost_estimated: false,
      pricing_source: 'builtin',
      pool: 'gemini',
      d7_tokens: 22200,
      d7_by_pool: { gemini: 22200 },
      cost_by_pool: { gemini: 0.08, claude_gpt: 0, other: 0 },
    },
    updatedAt: '2026-11-22T04:00:00Z',
    text: 'Gemini 2.5 Pro · 42k/1M tokens (4.2%)',
  };

  const mockQuota = {
    plan: 'Pro',
    fetched_at: '2026-11-22T04:00:00Z',
    weekly: {
      gemini: { remaining_fraction: 0.85, reset_time: '2026-11-28T00:00:00.000Z' },
      claude_gpt: { remaining_fraction: 0.7, reset_time: '2026-11-28T00:00:00.000Z' },
    },
    pools: [
      {
        id: 'gemini',
        category: 'gemini',
        limits: [
          { kind: 'weekly', remaining_fraction: 0.85, reset_time: '2026-11-28T00:00:00.000Z' },
          { kind: '5h', remaining_fraction: 0.9, reset_time: '2026-11-22T09:00:00Z' },
        ],
        models: [{ id: 'gemini-2.5-pro', display_name: 'Gemini 2.5 Pro', levels: ['Thinking'] }],
      },
    ],
  };

  const mockHistory = {
    totals: {
      today: { input: 10000, output: 3000, cache_read: 20000, calls: 5, conversations: 1, est_cost_usd: 0.09 },
      d7: { input: 80000, output: 20000, cache_read: 150000, calls: 24, conversations: 4, est_cost_usd: 0.95 },
      d30: { input: 320000, output: 95000, cache_read: 640000, calls: 96, conversations: 14, est_cost_usd: 4.25, cost_estimated: true },
      all: { input: 500000, output: 140000, cache_read: 900000, calls: 150, conversations: 21, est_cost_usd: 7.4 },
    },
    by_model: [
      { model: 'gemini-2.5-pro', display_name: 'Gemini 2.5 Pro', pool: 'gemini', input: 200000, output: 60000, cache_read: 400000, d7_tokens: 60000, calls: 60, est_cost_usd: 2.5 },
      { model: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6', pool: 'claude_gpt', input: 120000, output: 35000, cache_read: 240000, d7_tokens: 40000, calls: 36, est_cost_usd: 1.75 },
    ],
    by_conversation: [
      {
        id: 'canary-conv-001',
        title: 'CANARY_SECRET_TITLE C:\\Users\\canary\\secret /Users/canary/app canary@secret.example',
        model: 'gemini-2.5-pro',
        display_name: 'Gemini 2.5 Pro',
        pool: 'gemini',
        input: 10000,
        output: 3000,
        cache_read: 20000,
        calls: 5,
        est_cost_usd: 0.09,
        cost_by_pool: { gemini: 0.09, claude_gpt: 0, other: 0 },
        last_at: '2026-11-22T03:50:00Z',
        first_input: 'CANARY_FIRST_INPUT',
        workspace: 'file:///Users/canary/workspace',
      },
    ],
    daily: [
      { date: '2026-11-20', tokens: 45000, calls: 12 },
      { date: '2026-11-21', tokens: 62000, calls: 15 },
      { date: '2026-11-22', tokens: 33000, calls: 5 },
    ],
    hourly_today: [{ hour: 11, tokens: 33000, calls: 5 }],
    d7_by_pool: { gemini: 60000, claude_gpt: 40000, other: 0 },
    weekly_value_usd: { gemini: 16.67, claude_gpt: 5.83, other: null },
    weekly_cycles: {
      gemini: [
        {
          cycle_start: '2026-11-21T00:00:00.000Z',
          reset_time: '2026-11-28T00:00:00.000Z',
          observed_at: '2026-11-22T04:00:00.000Z',
          eval_obs_at: '2026-11-22T04:00:00.000Z',
          remaining_fraction: 0.85,
          used_fraction: 0.15,
          eval_used_fraction: 0.15,
          saturated: false,
          is_current: true,
          observed_cost_usd: 2.5,
          cycle_cost_usd: 2.5,
          weekly_value_usd: 16.67,
          prev_weekly_value_usd: 20,
          change_pct: -16.7,
        },
        {
          cycle_start: '2026-11-14T00:00:00.000Z',
          reset_time: '2026-11-21T00:00:00.000Z',
          observed_at: '2026-11-20T22:00:00.000Z',
          eval_obs_at: '2026-11-20T22:00:00.000Z',
          remaining_fraction: 0.2,
          used_fraction: 0.8,
          eval_used_fraction: 0.8,
          saturated: false,
          is_current: false,
          observed_cost_usd: 16,
          cycle_cost_usd: 16,
          weekly_value_usd: 20,
          prev_weekly_value_usd: null,
          change_pct: null,
        },
      ],
      claude_gpt: [
        {
          cycle_start: '2026-11-21T00:00:00.000Z',
          reset_time: '2026-11-28T00:00:00.000Z',
          observed_at: '2026-11-22T04:00:00.000Z',
          eval_obs_at: '2026-11-22T04:00:00.000Z',
          remaining_fraction: 0.7,
          used_fraction: 0.3,
          eval_used_fraction: 0.3,
          saturated: false,
          is_current: true,
          observed_cost_usd: 1.75,
          cycle_cost_usd: 1.75,
          weekly_value_usd: 5.83,
          prev_weekly_value_usd: null,
          change_pct: null,
        },
      ],
      other: [],
    },
    pricing_source: 'builtin',
    pricing_fetched_at: null,
    sources: { desktop: 14, cli: 0 },
    errors: 0,
    scanned_at: '2026-11-22T04:00:00Z',
    elapsed_ms: 18,
  };

  const handler = (urlStr) => {
    const url = new URL(urlStr);
    const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
    requestedPaths.push(pathname);
    if (pathname === '/preload.js') {
      return {
        status: 200,
        contentType: 'application/javascript; charset=utf-8',
        body: 'window.sidecar = { conversationId: "11111111-1111-1111-1111-111111111111" };',
      };
    }
    if (pathname === '/app.js') {
      return {
        status: 200,
        contentType: 'application/javascript; charset=utf-8',
        body: bundledAppJs,
      };
    }
    if (pathname === '/sandbox-host') {
      return {
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: '<!doctype html><html><body></body></html>',
      };
    }
    if (pathname === '/favicon.ico') {
      return { status: 204, contentType: 'image/x-icon', body: '' };
    }
    if (pathname === '/api/report') {
      return { status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify(mockReport) };
    }
    if (pathname === '/api/quota') {
      return { status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify(mockQuota) };
    }
    if (pathname === '/api/history') {
      return { status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify(mockHistory) };
    }
    if (pathname === '/api/pricing') {
      return { status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify({ source: 'builtin', count: 10 }) };
    }
    if (pathname === '/api/update') {
      return { status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify({ current_version: '2.2.0', latest_version: '2.2.0', update_available: false }) };
    }
    if (pathname === '/api/share-asset') {
      return { status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify({ files: [] }) };
    }
    if (pathname === '/api/share-profile') {
      return { status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify({ ok: true, nickname: '', gender: 'male' }) };
    }
    if (pathname === '/api/share-copy-gif' || pathname === '/api/share-copy-file') {
      return { status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify({ ok: true, bytes: 128 }) };
    }
    const route = routes.get(pathname);
    if (route) {
      return { status: 200, contentType: route.mime, body: readFileSync(route.abs, 'utf8') };
    }
    return { status: 404, contentType: 'text/plain; charset=utf-8', body: 'Not found' };
  };
  handler.requestedPaths = requestedPaths;
  return handler;
}

const CHROME_BASE_FLAGS = [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--password-store=basic',
  '--use-mock-keychain',
  '--mute-audio',
  '--no-first-run',
  '--no-default-browser-check',
];
const CDP_HANDSHAKE_TIMEOUT_MS = 25000;

function createCdpDispatcher({ sendRaw, isClosed, onFetchRequest }) {
  let nextId = 1;
  const pending = new Map();
  const events = [];
  let autoAttachFetchPattern = null;
  let onChildFetchReady = null;

  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    if (isClosed()) {
      reject(new Error('Chrome CDP is closed'));
      return;
    }
    const id = nextId++;
    pending.set(id, { resolve, reject });
    const payload = sessionId ? { id, method, params, sessionId } : { id, method, params };
    try {
      sendRaw(JSON.stringify(payload));
    } catch (err) {
      pending.delete(id);
      reject(err);
    }
  });

  const handleMessage = (raw) => {
    if (!raw) return;
    const msg = JSON.parse(raw);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
      else resolve(msg.result);
    } else if (msg.method === 'Target.attachedToTarget' && autoAttachFetchPattern && msg.params && msg.params.sessionId) {
      const childSid = msg.params.sessionId;
      events.push(msg);
      Promise.all([
        send('Runtime.enable', {}, childSid).catch(() => {}),
        send('Fetch.enable', { patterns: [{ urlPattern: autoAttachFetchPattern }] }, childSid).catch(() => {}),
      ]).finally(() => {
        if (msg.params.waitingForDebugger) {
          send('Runtime.runIfWaitingForDebugger', {}, childSid).catch(() => {});
        }
        if (onChildFetchReady) {
          const cb = onChildFetchReady;
          onChildFetchReady = null;
          cb(childSid);
        }
      });
    } else if (msg.method === 'Fetch.requestPaused' && onFetchRequest) {
      const { requestId, request } = msg.params;
      const resp = onFetchRequest(request.url);
      const fulfill = {
        requestId,
        responseCode: resp.status,
        responseHeaders: [
          { name: 'Content-Type', value: resp.contentType },
          { name: 'Cache-Control', value: 'no-store' },
          { name: 'Access-Control-Allow-Origin', value: '*' },
        ],
      };
      if (resp.body) fulfill.body = Buffer.from(resp.body, 'utf8').toString('base64');
      send('Fetch.fulfillRequest', fulfill, msg.sessionId).catch(() => {});
    } else if (msg.method) {
      events.push(msg);
    }
  };

  const rejectAll = (err) => {
    for (const { reject } of pending.values()) reject(err);
    pending.clear();
  };

  return {
    send,
    events,
    handleMessage,
    rejectAll,
    setAutoAttachFetchPattern(pattern, onReady = null) {
      autoAttachFetchPattern = pattern;
      onChildFetchReady = onReady;
    },
  };
}

function makeChromeKiller(proc, userDataDir, extraDestroy = []) {
  return () => {
    for (const s of extraDestroy) {
      try { s?.destroy(); } catch { /* ignore */ }
    }
    if (process.platform === 'win32' && proc.pid) {
      try {
        execFileSync('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { stdio: 'ignore' });
      } catch { /* process may have already exited */ }
    } else {
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    }
    try { proc.unref(); } catch { /* ignore */ }
    try {
      rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 });
    } catch { /* ignore transient Windows lock */ }
  };
}

async function launchChromeCdpWs(chromePath, onFetchRequest) {
  const userDataDir = mkdtempSync(join(tmpdir(), 'agy-lens-cdp-'));
  const proc = spawn(chromePath, [
    ...CHROME_BASE_FLAGS,
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

  let stderrTail = '';
  const appendStderr = (chunk) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-8192);
  };
  proc.stdout?.resume();

  const killChromeTree = makeChromeKiller(proc, userDataDir, [proc.stdout, proc.stderr]);

  let ws = null;
  let closed = false;
  let dispatcher = null;

  const onExit = (code) => {
    if (closed) return;
    dispatcher?.rejectAll(new Error(`Chrome exited prematurely (${code}). stderr:\n${stderrTail}`));
  };
  proc.once('exit', onExit);

  try {
    const browserWsUrl = await new Promise((resolveWs, rejectWs) => {
      const timer = setTimeout(() => {
        proc.stderr?.off('data', onStderr);
        proc.off('exit', onEarlyExit);
        rejectWs(new Error(`Chrome CDP WebSocket startup timeout (${CDP_HANDSHAKE_TIMEOUT_MS}ms).\nstderr:\n${stderrTail}`));
      }, CDP_HANDSHAKE_TIMEOUT_MS);
      timer.unref?.();

      const onStderr = (chunk) => {
        appendStderr(chunk);
        const m = stderrTail.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (m) {
          clearTimeout(timer);
          proc.stderr?.off('data', onStderr);
          proc.off('exit', onEarlyExit);
          resolveWs(m[1]);
        }
      };
      const onEarlyExit = (code) => {
        clearTimeout(timer);
        proc.stderr?.off('data', onStderr);
        rejectWs(new Error(`Chrome exited before DevTools ready (code=${code}).\nstderr:\n${stderrTail}`));
      };
      proc.stderr?.on('data', onStderr);
      proc.once('exit', onEarlyExit);
    });

    // Keep draining stderr after startup so Chrome never stalls on full pipe buffers.
    proc.stderr?.on('data', appendStderr);

    ws = new WebSocket(browserWsUrl);
    await new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error(`Chrome CDP WebSocket open timeout.\nstderr:\n${stderrTail}`)), 10000);
      timer.unref?.();
      ws.addEventListener('open', () => { clearTimeout(timer); res(); }, { once: true });
      ws.addEventListener('error', (ev) => {
        clearTimeout(timer);
        rej(new Error(`Chrome CDP WebSocket error: ${ev?.message || 'connection failed'}.\nstderr:\n${stderrTail}`));
      }, { once: true });
    });

    dispatcher = createCdpDispatcher({
      sendRaw: (text) => ws.send(text),
      isClosed: () => closed || proc.exitCode !== null || ws.readyState !== WebSocket.OPEN,
      onFetchRequest,
    });
    ws.addEventListener('message', (ev) => dispatcher.handleMessage(String(ev.data)));
    ws.addEventListener('close', () => {
      if (!closed) dispatcher.rejectAll(new Error('Chrome CDP WebSocket closed'));
    });

    await Promise.race([
      dispatcher.send('Browser.getVersion'),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error(`Chrome CDP WebSocket handshake timeout.\nstderr:\n${stderrTail}`)),
        10000,
      ).unref?.()),
    ]);
  } catch (err) {
    closed = true;
    proc.off('exit', onExit);
    proc.stderr?.off('data', appendStderr);
    try { ws?.close(); } catch { /* ignore */ }
    killChromeTree();
    throw err;
  }

  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      await Promise.race([
        dispatcher.send('Browser.close').catch(() => {}),
        new Promise((r) => setTimeout(r, 600).unref?.()),
      ]);
    } catch { /* ignore */ }
    proc.off('exit', onExit);
    proc.stderr?.off('data', appendStderr);
    dispatcher.rejectAll(new Error('CDP closed'));
    try { ws?.close(); } catch { /* ignore */ }
    killChromeTree();
  };

  return {
    send: dispatcher.send,
    events: dispatcher.events,
    close,
    setAutoAttachFetchPattern: dispatcher.setAutoAttachFetchPattern,
  };
}

async function launchChromeCdpPipe(chromePath, onFetchRequest) {
  const userDataDir = mkdtempSync(join(tmpdir(), 'agy-lens-cdp-'));
  const proc = spawn(chromePath, [
    ...CHROME_BASE_FLAGS,
    '--remote-debugging-pipe',
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], windowsHide: true });

  const writePipe = proc.stdio[3];
  const readPipe = proc.stdio[4];
  let stderrTail = '';
  const appendStderr = (chunk) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-8192);
  };
  proc.stderr?.on('data', appendStderr);

  const killChromeTree = makeChromeKiller(proc, userDataDir, [writePipe, readPipe, proc.stderr]);

  let rxBuf = Buffer.alloc(0);
  let closed = false;
  const dispatcher = createCdpDispatcher({
    sendRaw: (text) => writePipe.write(`${text}\0`),
    isClosed: () => closed || proc.exitCode !== null,
    onFetchRequest,
  });

  const onData = (chunk) => {
    rxBuf = Buffer.concat([rxBuf, chunk]);
    let idx;
    while ((idx = rxBuf.indexOf(0)) !== -1) {
      const raw = rxBuf.subarray(0, idx).toString('utf8');
      rxBuf = rxBuf.subarray(idx + 1);
      dispatcher.handleMessage(raw);
    }
  };
  readPipe.on('data', onData);

  const onExit = (code) => {
    if (closed) return;
    dispatcher.rejectAll(new Error(`Chrome exited prematurely (${code}).\nstderr:\n${stderrTail}`));
  };
  proc.once('exit', onExit);

  try {
    await Promise.race([
      dispatcher.send('Browser.getVersion'),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error(`Chrome CDP pipe handshake timeout (${CDP_HANDSHAKE_TIMEOUT_MS}ms).\nstderr:\n${stderrTail}`)),
        CDP_HANDSHAKE_TIMEOUT_MS,
      ).unref?.()),
    ]);
  } catch (err) {
    closed = true;
    readPipe.off('data', onData);
    proc.off('exit', onExit);
    proc.stderr?.off('data', appendStderr);
    killChromeTree();
    throw err;
  }

  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      await Promise.race([
        dispatcher.send('Browser.close').catch(() => {}),
        new Promise((r) => setTimeout(r, 600).unref?.()),
      ]);
    } catch { /* ignore */ }
    readPipe.off('data', onData);
    proc.off('exit', onExit);
    proc.stderr?.off('data', appendStderr);
    dispatcher.rejectAll(new Error('CDP closed'));
    killChromeTree();
  };

  return {
    send: dispatcher.send,
    events: dispatcher.events,
    close,
    setAutoAttachFetchPattern: dispatcher.setAutoAttachFetchPattern,
  };
}

async function launchChromeCdp(chromePath, onFetchRequest) {
  try {
    return await launchChromeCdpWs(chromePath, onFetchRequest);
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    const isSocketBlocked = /EACCES|EPERM|ECONNREFUSED|Cannot start http server|Operation not permitted/i.test(msg);
    if (!isSocketBlocked) throw err;
    return launchChromeCdpPipe(chromePath, onFetchRequest);
  }
}

test('Headless Chrome CDP: classic /app.js bundle, auto-detected locales, opaque sandboxed iframe, boot error fallback, and Canvas PNG bytes', async (t) => {
  const bundledAppJs = await buildClassicAppBundle();
  // Confirm classic non-module parse and zero remaining ESM import/export statements
  assert.doesNotThrow(() => new vm.Script(bundledAppJs, { filename: 'app.js' }));
  const strippedBundle = stripCommentsAndStringLiterals(bundledAppJs);
  assert.ok(!/(?:^|[;\n}])\s*(?:import|export)\b/.test(strippedBundle), 'Classic /app.js bundle must not contain top-level import/export');

  const chromePath = findChromeBinary();
  if (!chromePath) {
    t.skip('Google Chrome / Chromium binary not found');
    return;
  }

  const baseUrl = 'http://127.0.0.1';
  const handleFetch = createMockResponseHandler(bundledAppJs);
  let cdp;

  try {
    cdp = await launchChromeCdp(chromePath, handleFetch);
    for (const { navLang, expectedHtmlLang, expectedOverviewTab, expectedHistoryTitle } of [
      { navLang: 'en-US', expectedHtmlLang: 'en', expectedOverviewTab: 'Overview', expectedHistoryTitle: 'By model' },
      { navLang: 'zh-CN', expectedHtmlLang: 'zh-CN', expectedOverviewTab: '概览', expectedHistoryTitle: '按模型' },
    ]) {
      const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      await cdp.send('Page.enable', {}, sessionId);
      await cdp.send('Runtime.enable', {}, sessionId);
      await cdp.send('Fetch.enable', { patterns: [{ urlPattern: `${baseUrl}/*` }] }, sessionId);

      const errStartIdx = cdp.events.length;
      const reqStartIdx = handleFetch.requestedPaths.length;
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `
          Object.defineProperty(Navigator.prototype, 'language', { get: () => ${JSON.stringify(navLang)}, configurable: true });
          try { localStorage.clear(); } catch {}
        `,
      }, sessionId);

      await cdp.send('Page.navigate', { url: `${baseUrl}/` }, sessionId);

      const evalExpr = async (expression) => {
        const res = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
        if (res.exceptionDetails) throw new Error(res.exceptionDetails.text || 'Runtime evaluation error');
        return res.result ? res.result.value : undefined;
      };

      // Wait for Overview to render
      const overviewOk = await evalExpr(`new Promise((resolve) => {
        const deadline = Date.now() + 8000;
        const tick = () => {
          const text = document.getElementById('overview')?.textContent || '';
          if (text.includes('Gemini 2.5 Pro') && text.includes('42.0k')) return resolve(true);
          if (Date.now() > deadline) return resolve(false);
          setTimeout(tick, 40);
        };
        tick();
      })`);
      assert.ok(overviewOk, `Overview failed to render for ${navLang}`);

      const htmlLang = await evalExpr('document.documentElement.lang');
      const tabText = await evalExpr('document.getElementById("tab-overview").textContent.trim()');
      assert.equal(htmlLang, expectedHtmlLang);
      assert.equal(tabText, expectedOverviewTab);

      // Verify classic bundle made zero network requests to /views/*.js, /i18n.js, or /format.js
      const sessionPaths = handleFetch.requestedPaths.slice(reqStartIdx);
      assert.ok(sessionPaths.includes('/app.js'), 'Expected /app.js request');
      for (const p of sessionPaths) {
        assert.ok(!p.startsWith('/views/') && p !== '/i18n.js' && p !== '/format.js', `Unexpected sub-module request: ${p}`);
      }

      // Click Quota tab and wait for render (including weekly dollar valuation & cycle history from /api/history)
      await evalExpr('document.getElementById("tab-quota").click()');
      const quotaOk = await evalExpr(`new Promise((resolve) => {
        const deadline = Date.now() + 8000;
        const tick = () => {
          const el = document.getElementById('quota');
          const text = el?.textContent || '';
          if (text.includes('Gemini 2.5 Pro') && text.includes('90%') && el.querySelector('.wbudget-val') && el.querySelector('.wcycles')) return resolve(true);
          if (Date.now() > deadline) return resolve(false);
          setTimeout(tick, 40);
        };
        tick();
      })`);
      assert.ok(quotaOk, `Quota tab failed to render for ${navLang}`);

      // Click History tab and wait for render (no duplicate weekly bars/cycle history in History Totals)
      await evalExpr('document.getElementById("tab-history").click()');
      const historyOk = await evalExpr(`new Promise((resolve) => {
        const deadline = Date.now() + 8000;
        const tick = () => {
          const el = document.getElementById('history');
          const text = el?.textContent || '';
          if (text.includes(${JSON.stringify(expectedHistoryTitle)}) && el.querySelector('[data-share-card]') && el.querySelector('#history-models')) {
            return resolve({
              ok: true,
              hasDupBar: Boolean(el.querySelector('.wbar')),
              hasDupCycles: Boolean(el.querySelector('.wcycles')),
            });
          }
          if (Date.now() > deadline) return resolve({ ok: false });
          setTimeout(tick, 40);
        };
        tick();
      })`);
      assert.ok(historyOk && historyOk.ok, `History tab failed to render for ${navLang}`);
      assert.equal(historyOk.hasDupBar, false, 'History Totals must not duplicate Quota bars');
      assert.equal(historyOk.hasDupCycles, false, 'History Totals must not duplicate Quota cycle history');

      // Open Share Card modal
      await evalExpr('document.querySelector("[data-share-card]").click()');
      const modalCheck = await evalExpr(`(() => {
        const modal = document.getElementById('share-modal');
        const svg = modal?.querySelector('.share-preview svg');
        return {
          exists: Boolean(modal),
          hidden: modal ? modal.hidden : true,
          svgHtml: svg ? svg.outerHTML : '',
          modalHtml: modal ? modal.innerHTML : '',
        };
      })()`);
      assert.ok(modalCheck.exists && !modalCheck.hidden, 'Share modal did not open');
      assert.ok(modalCheck.svgHtml.includes('<svg'), 'Share modal missing SVG');
      assert.ok(modalCheck.svgHtml.includes('415.0k') || modalCheck.svgHtml.includes('415k'), 'Share modal missing formatted token total');
      assert.ok(!modalCheck.modalHtml.includes('CANARY_SECRET_TITLE'), 'Share modal leaked canary title');
      assert.ok(!modalCheck.modalHtml.includes('CANARY_FIRST_INPUT'), 'Share modal leaked canary first_input');
      assert.ok(!modalCheck.modalHtml.includes('C:\\Users\\canary'), 'Share modal leaked canary Windows path');
      assert.ok(!modalCheck.modalHtml.includes('/Users/canary'), 'Share modal leaked canary POSIX path');
      assert.ok(!modalCheck.modalHtml.includes('canary@secret.example'), 'Share modal leaked canary email');

      // Toggle light theme on unified mountain style and verify Copy SVG & Copy image (PNG) clipboard actions inside Chrome
      await evalExpr('document.querySelector("[data-share-style=\\"mountain\\"]").click()');
      await evalExpr('document.querySelector("[data-share-theme=\\"light\\"]").click()');
      const themePressed = await evalExpr('document.querySelector("[data-share-theme=\\"light\\"]")?.getAttribute("aria-pressed")');
      assert.equal(themePressed, 'true', 'Mountain light theme button should be pressed');

      // Persistent DOM shell & zero outer width/height jump across all 6 styles + narrow viewport layout check
      const styleSwitchCheck = await evalExpr(`(async () => {
        const dlg = document.querySelector('#share-modal .share-dialog');
        const styles = [...document.querySelectorAll('#share-modal [data-share-style]')].map((b) => b.dataset.shareStyle);
        const widths = [];
        const heights = [];
        const svgsOk = [];
        let sameDlg = true;
        for (const s of styles) {
          document.querySelector('#share-modal [data-share-style="' + s + '"]').click();
          await new Promise((r) => setTimeout(r, 40));
          if (document.querySelector('#share-modal .share-dialog') !== dlg) sameDlg = false;
          const r = dlg.getBoundingClientRect();
          widths.push(Math.round(r.width));
          heights.push(Math.round(r.height));
          const svg = document.querySelector('#share-modal .share-preview svg');
          svgsOk.push(Boolean(svg && svg.getAttribute('viewBox')));
        }
        document.querySelector('#share-modal [data-share-style="mountain"]').click();
        await new Promise((r) => setTimeout(r, 30));
        return {
          styles,
          sameDlg,
          widths,
          heights,
          svgsOk,
          overflowX: dlg.scrollWidth > dlg.clientWidth + 1,
        };
      })()`);
      assert.deepEqual(styleSwitchCheck.styles, ['mountain', 'abyssal', 'eclipse', 'bauhaus', 'phosphor', 'pixel-role']);
      assert.equal(styleSwitchCheck.sameDlg, true, 'Switching styles must preserve persistent .share-dialog DOM');
      assert.ok(styleSwitchCheck.svgsOk.every(Boolean), `All 6 styles must render SVG: ${JSON.stringify(styleSwitchCheck.svgsOk)}`);
      assert.equal(new Set(styleSwitchCheck.widths).size, 1, `Outer .share-dialog width must remain constant across styles: ${JSON.stringify(styleSwitchCheck.widths)}`);
      assert.equal(new Set(styleSwitchCheck.heights).size, 1, `Outer .share-dialog height must remain constant across styles: ${JSON.stringify(styleSwitchCheck.heights)}`);
      assert.equal(styleSwitchCheck.overflowX, false, 'Share dialog must not overflow horizontally on desktop');

      // Narrow 420px viewport overflow & zero-jump check across all 6 styles
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 420, height: 780, deviceScaleFactor: 1, mobile: true }, sessionId);
      const narrowCheck = await evalExpr(`(async () => {
        window.dispatchEvent(new Event('resize'));
        await new Promise((r) => setTimeout(r, 40));
        const dlg = document.querySelector('#share-modal .share-dialog');
        const foot = document.querySelector('#share-modal .share-foot');
        const styles = [...document.querySelectorAll('#share-modal [data-share-style]')].map((b) => b.dataset.shareStyle);
        const widths = [];
        const heights = [];
        let dlgOverflowX = false;
        let docOverflowX = false;
        let footInside = true;
        for (const s of styles) {
          document.querySelector('#share-modal [data-share-style="' + s + '"]').click();
          await new Promise((r) => setTimeout(r, 40));
          const dr = dlg.getBoundingClientRect();
          const fr = foot.getBoundingClientRect();
          widths.push(Math.round(dr.width));
          heights.push(Math.round(dr.height));
          if (dlg.scrollWidth > dlg.clientWidth + 1) dlgOverflowX = true;
          if (document.documentElement.scrollWidth > window.innerWidth + 1) docOverflowX = true;
          if (!(fr.right <= dr.right + 1 && fr.left >= dr.left - 1)) footInside = false;
        }
        document.querySelector('#share-modal [data-share-style="mountain"]').click();
        await new Promise((r) => setTimeout(r, 30));
        return { widths, heights, dlgOverflowX, docOverflowX, footInside };
      })()`);
      assert.equal(new Set(narrowCheck.widths).size, 1, `Narrow outer .share-dialog width must remain constant: ${JSON.stringify(narrowCheck.widths)}`);
      assert.equal(new Set(narrowCheck.heights).size, 1, `Narrow outer .share-dialog height must remain constant: ${JSON.stringify(narrowCheck.heights)}`);
      assert.equal(narrowCheck.dlgOverflowX, false, 'Share dialog must not overflow horizontally at 420px');
      assert.equal(narrowCheck.docOverflowX, false, 'Document must not overflow horizontally at 420px');
      assert.equal(narrowCheck.footInside, true, 'Share footer must fit inside dialog at 420px');
      await cdp.send('Emulation.clearDeviceMetricsOverride', {}, sessionId);

      // Motion export verification (GIF89a on cockpit + Motion Photo .jpg when H.264 VideoEncoder is supported)
      const motionExportCheck = await evalExpr(`(async () => {
        const captured = [];
        const origCreateObj = URL.createObjectURL.bind(URL);
        const origAnchorClick = HTMLAnchorElement.prototype.click;
        const blobMap = new Map();
        URL.createObjectURL = (blob) => {
          const u = origCreateObj(blob);
          blobMap.set(u, blob);
          return u;
        };
        HTMLAnchorElement.prototype.click = function () {
          if (this.download && this.href && blobMap.has(this.href)) {
            captured.push({ filename: this.download, blob: blobMap.get(this.href) });
          }
        };
        try {
          // 1. Export GIF89a on abyssal
          document.querySelector('#share-modal [data-share-style="abyssal"]').click();
          await new Promise((r) => setTimeout(r, 30));
          const sel = document.querySelector('#share-modal [data-share-motion-fmt]');
          sel.value = 'gif';
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          document.querySelector('#share-modal [data-share-motion-save]').click();
          const gifDeadline = Date.now() + 12000;
          while (!captured.some((c) => c.filename.endsWith('.gif')) && Date.now() < gifDeadline) {
            await new Promise((r) => setTimeout(r, 40));
          }
          const gifCap = captured.find((c) => c.filename.endsWith('.gif'));
          const gifBytes = gifCap ? new Uint8Array(await gifCap.blob.arrayBuffer()) : null;
          const gifHeader = gifBytes ? String.fromCharCode(...gifBytes.subarray(0, 6)) : '';
          const gifTrailer = gifBytes ? gifBytes[gifBytes.length - 1] : 0;

          // 2. Probe live Motion Photo (.jpg) on mountain if live format is available
          let liveRes = { supported: false };
          document.querySelector('#share-modal [data-share-style="mountain"]').click();
          await new Promise((r) => setTimeout(r, 30));
          const hasLiveOpt = [...sel.options].some((o) => o.value === 'live');
          if (hasLiveOpt) {
            sel.value = 'live';
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            document.querySelector('#share-modal [data-share-motion-save]').click();
            const liveDeadline = Date.now() + 25000;
            while (!captured.some((c) => c.filename.endsWith('.jpg')) && !document.querySelector('#share-modal .share-status.err') && Date.now() < liveDeadline) {
              await new Promise((r) => setTimeout(r, 60));
            }
            const jpgCap = captured.find((c) => c.filename.endsWith('.jpg'));
            if (jpgCap) {
              const jpgBytes = new Uint8Array(await jpgCap.blob.arrayBuffer());
              const jpgLatin1 = new TextDecoder('latin1').decode(jpgBytes.subarray(0, Math.min(jpgBytes.length, 65536)));
              const lenMatch = jpgLatin1.match(/Item:Semantic="MotionPhoto"[^>]*Item:Length="(\\d+)"/);
              const mp4Len = lenMatch ? Number(lenMatch[1]) : 0;
              let videoCheck = null;
              if (mp4Len > 0 && mp4Len < jpgBytes.length) {
                const mp4Slice = jpgBytes.subarray(jpgBytes.length - mp4Len);
                const mp4Url = origCreateObj(new Blob([mp4Slice], { type: 'video/mp4' }));
                const vid = document.createElement('video');
                vid.muted = true;
                vid.playsInline = true;
                vid.src = mp4Url;
                await new Promise((res, rej) => {
                  vid.onloadeddata = () => res();
                  vid.onerror = () => rej(new Error('Embedded MP4 failed to load'));
                  setTimeout(() => rej(new Error('Embedded MP4 load timeout')), 6000);
                });
                const c = document.createElement('canvas');
                c.width = 64; c.height = 64;
                const ctx = c.getContext('2d');
                const sampleAt = async (t) => {
                  vid.currentTime = t;
                  await new Promise((r) => { vid.onseeked = () => r(); setTimeout(r, 600); });
                  ctx.drawImage(vid, 0, 0, 64, 64);
                  return ctx.getImageData(0, 0, 64, 64).data;
                };
                const d1 = await sampleAt(0.1);
                const d2 = await sampleAt(1.5);
                let diff = 0;
                for (let i = 0; i < d1.length; i += 4) {
                  diff += Math.abs(d1[i] - d2[i]) + Math.abs(d1[i + 1] - d2[i + 1]) + Math.abs(d1[i + 2] - d2[i + 2]);
                }
                videoCheck = { videoWidth: vid.videoWidth, videoHeight: vid.videoHeight, duration: vid.duration, diff };
                URL.revokeObjectURL(mp4Url);
              }
              liveRes = {
                supported: true,
                soi: jpgBytes[0] === 0xff && jpgBytes[1] === 0xd8 && jpgBytes[2] === 0xff,
                hasXmp: jpgLatin1.includes('GCamera:MotionPhoto="1"') && jpgLatin1.includes('Container:Directory'),
                mp4Len,
                videoCheck,
              };
            }
          }
          return { gifHeader, gifTrailer, gifLen: gifBytes ? gifBytes.length : 0, liveRes };
        } finally {
          URL.createObjectURL = origCreateObj;
          HTMLAnchorElement.prototype.click = origAnchorClick;
        }
      })()`);
      assert.equal(motionExportCheck.gifHeader, 'GIF89a', 'Exported vector GIF must have GIF89a header');
      assert.equal(motionExportCheck.gifTrailer, 0x3b, 'Exported vector GIF must end with 0x3b');
      assert.ok(motionExportCheck.gifLen > 1000, 'Exported vector GIF unexpectedly small');
      if (motionExportCheck.liveRes && motionExportCheck.liveRes.supported) {
        assert.equal(motionExportCheck.liveRes.soi, true, 'Motion Photo JPEG missing SOI');
        assert.equal(motionExportCheck.liveRes.hasXmp, true, 'Motion Photo JPEG missing GCamera XMP');
        assert.ok(motionExportCheck.liveRes.videoCheck, 'Motion Photo embedded MP4 failed decode');
        assert.equal(motionExportCheck.liveRes.videoCheck.videoWidth, 760);
        assert.equal(motionExportCheck.liveRes.videoCheck.videoHeight, 950);
        assert.ok(motionExportCheck.liveRes.videoCheck.duration > 2.5, `Expected duration > 2.5s, got ${motionExportCheck.liveRes.videoCheck.duration}`);
        assert.ok(motionExportCheck.liveRes.videoCheck.diff > 0, 'Embedded MP4 frames showed zero motion delta');
      }

      // Ensure mountain light theme is selected before Copy SVG / Copy PNG checks
      await evalExpr('document.querySelector("[data-share-style=\\"mountain\\"]").click()');
      await evalExpr('document.querySelector("[data-share-theme=\\"light\\"]").click()');
      const copyRes = await evalExpr(`(async () => {
        const svgBtn = document.querySelector('[data-share-svg]');
        const pngBtn = document.querySelector('[data-share-png]');
        const svgLabel = svgBtn ? svgBtn.textContent.trim() : '';
        const pngLabel = pngBtn ? pngBtn.textContent.trim() : '';

        let copiedSvg = null;
        let capturedBlob = null;
        let rejectNextWrite = false;
        const fakeClip = {
          writeText: async (text) => { copiedSvg = text; },
          write: async (items) => {
            if (rejectNextWrite) throw new DOMException('Denied', 'NotAllowedError');
            const item = items && items[0];
            if (!item || typeof item.getType !== 'function') throw new Error('Missing ClipboardItem');
            capturedBlob = await item.getType('image/png');
          },
        };
        const clipDesc = Object.getOwnPropertyDescriptor(Navigator.prototype, 'clipboard');
        Object.defineProperty(navigator, 'clipboard', { configurable: true, get: () => fakeClip });
        const OrigClipboardItem = window.ClipboardItem;
        if (typeof window.ClipboardItem === 'undefined') {
          window.ClipboardItem = class {
            constructor(data) { this._data = data; }
            async getType(type) { return await this._data[type]; }
          };
        }
        try {
          svgBtn.click();
          const deadlineSvg = Date.now() + 4000;
          while ((!copiedSvg || document.querySelector('.share-status')?.hidden) && Date.now() < deadlineSvg) {
            await new Promise((r) => setTimeout(r, 20));
          }
          const svgStatus = document.querySelector('.share-status')?.textContent?.trim() || '';

          pngBtn.click();
          const deadlinePng = Date.now() + 8000;
          while ((!capturedBlob || !document.querySelector('.share-status')?.textContent?.includes('PNG')) && Date.now() < deadlinePng) {
            await new Promise((r) => setTimeout(r, 30));
          }
          const pngStatus = document.querySelector('.share-status')?.textContent?.trim() || '';
          if (!capturedBlob) throw new Error('PNG clipboard blob was not created');
          const buf = new Uint8Array(await capturedBlob.arrayBuffer());
          let bin = '';
          for (let i = 0; i < buf.length; i += 1) bin += String.fromCharCode(buf[i]);

          rejectNextWrite = true;
          pngBtn.click();
          const deadlineErr = Date.now() + 4000;
          while (!document.querySelector('.share-status.err') && Date.now() < deadlineErr) {
            await new Promise((r) => setTimeout(r, 20));
          }
          const errEl = document.querySelector('.share-status.err');
          const errStatus = errEl && !errEl.hidden ? errEl.textContent.trim() : '';

          return {
            svgLabel,
            pngLabel,
            copiedSvg,
            svgStatus,
            pngStatus,
            errStatus,
            pngBase64: btoa(bin),
          };
        } finally {
          if (clipDesc) Object.defineProperty(Navigator.prototype, 'clipboard', clipDesc);
          delete navigator.clipboard;
          if (OrigClipboardItem === undefined) delete window.ClipboardItem;
          else window.ClipboardItem = OrigClipboardItem;
        }
      })()`);
      assert.equal(copyRes.svgLabel, navLang === 'zh-CN' ? '复制 SVG' : 'Copy SVG');
      assert.equal(copyRes.pngLabel, navLang === 'zh-CN' ? '复制图片' : 'Copy image');
      assert.ok(copyRes.copiedSvg && copyRes.copiedSvg.trim().startsWith('<svg') && copyRes.copiedSvg.trim().endsWith('</svg>'), 'Copied SVG invalid');
      assert.equal(copyRes.svgStatus, navLang === 'zh-CN' ? '已复制 SVG' : 'Copied SVG');
      assert.equal(copyRes.pngStatus, navLang === 'zh-CN' ? '已复制 PNG' : 'Copied PNG');
      assert.ok(copyRes.errStatus.includes(navLang === 'zh-CN' ? '复制 SVG' : 'Copy SVG'), `Expected clipboard fallback hint, got: ${copyRes.errStatus}`);
      const pngBytes = Buffer.from(copyRes.pngBase64, 'base64');
      assert.ok(pngBytes.length > 1000, `PNG unexpectedly small: ${pngBytes.length} bytes`);
      assert.deepEqual([...pngBytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'Invalid PNG magic signature');

      // Verify zero console errors and zero uncaught exceptions in this session
      const sessionEvents = cdp.events.slice(errStartIdx).filter((ev) => ev.sessionId === sessionId);
      const consoleErrors = sessionEvents.filter((ev) => ev.method === 'Runtime.consoleAPICalled' && ev.params.type === 'error');
      const exceptions = sessionEvents.filter((ev) => ev.method === 'Runtime.exceptionThrown');
      assert.equal(consoleErrors.length, 0, `Console errors in ${navLang}: ${JSON.stringify(consoleErrors)}`);
      assert.equal(exceptions.length, 0, `Uncaught exceptions in ${navLang}: ${JSON.stringify(exceptions)}`);

      await cdp.send('Target.closeTarget', { targetId });
    }

    // Boot error fallback check: preload throwing during app.js startup renders visible error in #overview
    {
      const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      await cdp.send('Page.enable', {}, sessionId);
      await cdp.send('Runtime.enable', {}, sessionId);
      await cdp.send('Fetch.enable', { patterns: [{ urlPattern: `${baseUrl}/*` }] }, sessionId);
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `
          Object.defineProperty(window, 'sidecar', {
            configurable: true,
            get() { throw new Error('Simulated preload failure <xss>'); },
          });
        `,
      }, sessionId);
      await cdp.send('Page.navigate', { url: `${baseUrl}/` }, sessionId);
      const bootErr = await (async () => {
        const res = await cdp.send('Runtime.evaluate', {
          expression: `new Promise((resolve) => {
            const deadline = Date.now() + 6000;
            const tick = () => {
              const el = document.querySelector('#overview [data-boot-error]');
              if (el) return resolve({ text: el.textContent, html: el.innerHTML });
              if (Date.now() > deadline) return resolve(null);
              setTimeout(tick, 30);
            };
            tick();
          })`,
          awaitPromise: true,
          returnByValue: true,
        }, sessionId);
        return res.result ? res.result.value : null;
      })();
      assert.ok(bootErr, 'Boot error fallback did not render in #overview');
      assert.ok(bootErr.text.includes('Simulated preload failure <xss>'), 'Boot error text missing message');
      assert.ok(!bootErr.html.includes('<xss>'), 'Boot error HTML must escape error message');
      await cdp.send('Target.closeTarget', { targetId });
    }

    // Opaque-origin <iframe sandbox="allow-scripts"> check
    {
      const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      await cdp.send('Page.enable', {}, sessionId);
      await cdp.send('Runtime.enable', {}, sessionId);
      await cdp.send('Fetch.enable', { patterns: [{ urlPattern: `${baseUrl}/*` }] }, sessionId);
      let resolveChildReady;
      const childReadyPromise = new Promise((r) => { resolveChildReady = r; });
      cdp.setAutoAttachFetchPattern(`${baseUrl}/*`, () => resolveChildReady());
      await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);
      const errStartIdx = cdp.events.length;
      await cdp.send('Page.navigate', { url: `${baseUrl}/sandbox-host` }, sessionId);

      // Step 1: append opaque-origin sandboxed iframe and wait for Fetch.enable on its OOPIF target
      await cdp.send('Runtime.evaluate', {
        expression: `(() => {
          const frame = document.createElement('iframe');
          frame.id = 'opaque-frame';
          frame.setAttribute('sandbox', 'allow-scripts');
          frame.srcdoc = '<!doctype html><html><body><script>window.addEventListener("message", (e) => { if (e.data && e.data.boot) { document.open(); document.write(e.data.html); document.close(); } }); parent.postMessage({ ready: true }, "*");<\\/script></body></html>';
          document.body.appendChild(frame);
        })()`,
      }, sessionId);
      await Promise.race([
        childReadyPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Child OOPIF attach timeout')), 5000)),
      ]);

      // Step 2: once child Fetch.enable is active, boot index.html inside the opaque-origin iframe
      const indexHtml = readFileSync(join(WEB_DIR, 'index.html'), 'utf8')
        .replace('<head>', `<head>\n<base href="${baseUrl}/">`)
        + '<script>(function check() { const ov = document.getElementById("overview"); const text = ov ? ov.textContent : ""; if (text.includes("Gemini 2.5 Pro")) { parent.postMessage({ ok: true, origin: window.origin, text }, "*"); return; } if (ov && ov.querySelector("[data-boot-error]")) { parent.postMessage({ ok: false, origin: window.origin, text, bootError: true }, "*"); return; } setTimeout(check, 40); })();</script>';
      const sandboxRes = await cdp.send('Runtime.evaluate', {
        expression: `new Promise((resolve) => {
          const timer = setTimeout(() => resolve({ ok: false, timeout: true }), 6000);
          window.addEventListener('message', (ev) => {
            if (ev.data && ev.data.ready) return;
            clearTimeout(timer);
            resolve(ev.data);
          });
          document.getElementById('opaque-frame').contentWindow.postMessage({ boot: true, html: ${JSON.stringify(indexHtml)} }, '*');
        })`,
        awaitPromise: true,
        returnByValue: true,
      }, sessionId);
      cdp.setAutoAttachFetchPattern(null);
      if (sandboxRes.exceptionDetails) throw new Error(sandboxRes.exceptionDetails.text || 'Sandbox iframe error');
      const val = sandboxRes.result && sandboxRes.result.value;
      const sessionEvents = cdp.events.slice(errStartIdx);
      assert.ok(val && val.ok, `Sandboxed opaque-origin iframe failed: ${JSON.stringify(val)} events=${JSON.stringify(sessionEvents)}`);
      assert.equal(val.origin, 'null', 'Expected opaque origin inside sandbox="allow-scripts" iframe');
      assert.ok(val.text.includes('42.0k'), 'Sandboxed iframe overview missing rendered tokens');
      await cdp.send('Target.closeTarget', { targetId });
    }
  } finally {
    if (cdp) await cdp.close();
  }
});
