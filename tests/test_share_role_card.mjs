import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import vm from 'node:vm';

import {
  ARENA_IDS, ACHIEVEMENTS, CLASS_IDS, USAGE_ACHIEVEMENTS, buildProfile, buildQuips, computeLevel, computeStats,
  sanitizeNickname, usageAchievements,
} from '../sidecars/agy-lens/web/views/share-game.js';
import {
  MAX_SAVED_GIFS, MAX_SHARE_FILE_BYTES, MAX_SHARE_GIF_BYTES, clipboardCommandForPlatform,
  copyShareFileToClipboard, copyShareGifToClipboard, listShareAssets, loadShareProfile,
  readShareAsset, shareProfilePayload, updateShareProfile,
} from '../sidecars/agy-lens/lib/share-assets.mjs';
import {
  ARENA_AMBIENT_IDS, VFX_H, VFX_W, compositeVfx, createAmbientFx, createVfxFrame, renderStaticAmbientSvg,
} from '../sidecars/agy-lens/web/views/share-vfx.js';
import {
  PIXEL_H, PIXEL_W, buildBadgeSheetSvg, buildRoleCardLayout, buildRoleCardSvg,
  centerBaseline, footShadowAnchor, textInkX, textWidth,
} from '../sidecars/agy-lens/web/views/share-pixel.js';
import {
  MAX_SHARE_GIF_BYTES as WEB_MAX_GIF_BYTES,
  base64ToBytes, bytesToBase64, compositeRoleCardFrames, encodeGif,
} from '../sidecars/agy-lens/web/views/share-gif.js';
import {
  MAX_SHARE_MOTION_BYTES, injectMotionPhotoXmp, muxAvcToMp4,
} from '../sidecars/agy-lens/web/views/share-motion.js';
import {
  SHARE_CARD_HEIGHT, SHARE_CARD_WIDTH, SHARE_STYLES, SHARE_STYLE_SPECS,
  buildShareCardStyleSvg, buildShareCardSvg, quipText, sanitizeShareCardInput,
} from '../sidecars/agy-lens/web/views/share-card.js';
import { computePosterShaderUniforms } from '../sidecars/agy-lens/web/views/share-webgl.js';
import { I18N } from '../sidecars/agy-lens/web/i18n.js';
import { drawRelicSocket, drawRibbonPlate, materialFor } from '../sidecars/agy-lens/web/views/share-frames.js';
import { bundleWebApp } from '../sidecars/agy-lens/lib/web-bundle.mjs';

function sampleHist(mult = 1) {
  return {
    tier: 'Pro',
    weekly_value_usd: { gemini: 25 },
    period_quota: { d30: { gemini: { pct: 180 * mult } }, all: { gemini: { pct: 600 * mult } } },
    totals: {
      d30: { input: 2.4e6 * mult, output: 1.6e6 * mult, cache_read: 28e6 * mult, calls: 920 * mult, conversations: 42, est_cost_usd: 38 * mult },
      all: { input: 6e6 * mult, output: 4e6 * mult, cache_read: 60e6 * mult, calls: 2100 * mult, conversations: 95, est_cost_usd: 92 * mult },
    },
    by_model: {
      d30: [
        { model: 'gemini-3-pro', pool: 'gemini', input: 1.2e6 * mult, output: 0.9e6 * mult },
        { model: 'claude-opus-4-6', pool: 'claude', input: 0.7e6 * mult, output: 0.4e6 * mult },
        { model: 'gemini-3-flash', pool: 'gemini', input: 0.5e6 * mult, output: 0.3e6 * mult },
      ],
    },
    daily: Array.from({ length: 14 }, (_, i) => ({
      date: `2026-11-${String(i + 10).padStart(2, '0')}`,
      tokens: (220000 + i * 15000) * mult,
      calls: 40 + i,
    })),
    hourly_today: [
      { hour: 2, tokens: 180000, calls: 12 },
      { hour: 10, tokens: 320000, calls: 22 },
    ],
  };
}

test('share-game: stats, level, 12 usage achievements, quips, and nickname sanitization', () => {
  assert.deepEqual(ACHIEVEMENTS, USAGE_ACHIEVEMENTS);
  assert.equal(ACHIEVEMENTS.length, 12);

  const hist = sampleHist(1);
  const stats = computeStats(hist, 'd30');
  assert.equal(stats.norm, 'quota');
  for (const v of Object.values(stats.values)) assert.ok(v >= 0 && v <= 100);

  const lv = computeLevel(hist);
  assert.ok(lv.level >= 1 && lv.level <= 99);
  assert.ok(lv.progress >= 0 && lv.progress <= 1);

  assert.equal(sanitizeNickname('  小 A <script>  '), '小 A scri');
  assert.equal(sanitizeNickname('alice@secret.com'), '');
  assert.equal(sanitizeNickname('C:\\Users\\bob'), '');

  const prof = buildProfile(hist, 'd30', { nickname: '小 A', gender: 'male' });
  assert.equal(prof.nickname, '小 A');
  assert.ok(prof.level >= 1);

  const ach = usageAchievements(hist, 'd30', stats);
  assert.equal(ach.firstCall, true);
  assert.equal(ach.millionaire, true);
  assert.equal(ach.grinder, true);

  const quips = buildQuips(hist, 'd30');
  assert.ok(quips.length >= 3);
  assert.ok(quipText(quips[0], 'zh').length > 0);
});

test('share-assets: profile persistence and safe asset reading', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-share-'));
  try {
    const profPath = join(dir, 'share-profile.json');
    const st = loadShareProfile(profPath);
    assert.equal(st.nickname, '');
    assert.equal(st.gender, 'male');

    const up = updateShareProfile(profPath, { nickname: 'Tester <1>', gender: 'female' });
    assert.equal(up.ok, true);
    assert.equal(up.nickname, 'Tester 1');
    assert.equal(up.gender, 'female');
    assert.deepEqual(shareProfilePayload(loadShareProfile(profPath)), { nickname: 'Tester 1', gender: 'female' });

    const artDir = join(dir, 'art');
    mkdirSync(join(artDir, 'arenas'), { recursive: true });
    mkdirSync(join(artDir, 'fx'), { recursive: true });
    writeFileSync(join(artDir, 'arenas', 'foundry.png'), Buffer.from([137, 80, 78, 71]));
    writeFileSync(join(artDir, 'fx', 'hit.png'), Buffer.from([137, 80, 78, 71]));
    assert.deepEqual(listShareAssets(artDir), ['arenas/foundry.png']);
    assert.equal(readShareAsset(artDir, '../share-profile.json').error, 'bad_path');
    assert.equal(readShareAsset(artDir, 'fx/hit.png').error, 'bad_path');
    assert.equal(readShareAsset(artDir, 'arenas/foundry.png').mime, 'image/png');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('share-vfx: all 10 arena ambient loops render deterministically', () => {
  assert.deepEqual(ARENA_AMBIENT_IDS, ARENA_IDS);

  for (const arenaId of ARENA_IDS) {
    const svg = renderStaticAmbientSvg(arenaId, { seed: 7 });
    assert.ok(typeof svg === 'string');
    const f1 = createVfxFrame();
    const f2 = createVfxFrame();
    const a1 = createAmbientFx(arenaId, 7);
    const a2 = createAmbientFx(arenaId, 7);
    for (let i = 0; i < 15; i += 1) {
      a1.update(0.05);
      a2.update(0.05);
    }
    a1.draw(f1);
    a2.draw(f2);
    assert.deepEqual(f1.color, f2.color, `deterministic color mismatch for ${arenaId}`);
    const rgba = new Uint8ClampedArray(VFX_W * VFX_H * 4);
    compositeVfx(f1, rgba);
    let nonZero = 0;
    for (let i = 3; i < rgba.length; i += 4) if (rgba[i] > 0) nonZero += 1;
    assert.ok(nonZero > 0, `expected ambient pixels for ${arenaId}`);
  }
});

test('share-pixel & share-card: optical usage plates, pixel role card, alignment, and bundle integrity', () => {
  assert.deepEqual(SHARE_STYLES, ['mountain', 'abyssal', 'eclipse', 'bauhaus', 'phosphor', 'pixel-role']);

  const hist = sampleHist(1);
  for (const period of ['today', 'd7', 'd30', 'all']) {
    for (const lang of ['zh', 'en']) {
      for (const theme of ['dark', 'light']) {
        const usageSvg = buildShareCardSvg({
          period,
          totals: hist.totals,
          byModel: hist.by_model.d30,
          daily: hist.daily,
          hourlyToday: hist.hourly_today,
          lang,
          theme,
          quip: quipText(buildQuips(hist, period)[0], lang),
        });
        assert.ok(usageSvg.startsWith(`<svg xmlns="http://www.w3.org/2000/svg" width="${SHARE_CARD_WIDTH}" height="${SHARE_CARD_HEIGHT}"`));
        assert.ok(usageSvg.includes('data-editorial-poster="1"'), 'usage card should render Guizang Editorial poster');
        assert.ok((usageSvg.match(/data-ledger-row="/g) || []).length >= 1, 'usage card should render editorial ledger rows');
        assert.equal((usageSvg.match(/<circle [^>]*r="8.5"/g) || []).length, 0, 'legacy 100-dot matrix must be removed');
      }
    }
  }

  const prof = buildProfile(hist, 'd30', { nickname: '<bad>', gender: 'male' });
  const ach = usageAchievements(hist, 'd30', prof.stats);
  const roleSvg = buildRoleCardSvg({ profile: prof, achievements: ach, lang: 'zh', arena: 'foundry' });
  assert.ok(roleSvg.startsWith(`<svg xmlns="http://www.w3.org/2000/svg" width="${PIXEL_W}" height="${PIXEL_H}"`));
  assert.ok(!roleSvg.includes('<script'));
  assert.ok(roleSvg.includes('data-sprite="1"'), 'role card SVG must use XML-valid data-sprite="1" attribute');
  const roleShadowMatch = roleSvg.match(/<g><path[^>]*fill="#090714" fill-opacity="0\.26"\/>.*?<\/g>/);
  assert.ok(roleShadowMatch, 'role card should emit 3-step translucent foot shadow');
  assert.ok(!roleShadowMatch[0].includes('#c8401a'), 'role card shadow should not draw orange checkerboard mat');

  // Foot shadow anchors mirror cleanly and differentiate dancer mid vs late
  const aAnchor = footShadowAnchor({ classId: 'glassblower', stage: 'late' }, 108, false);
  const bAnchor = footShadowAnchor({ classId: 'glassblower', stage: 'late' }, 292, true);
  assert.equal(aAnchor.cx, 102);
  assert.equal(bAnchor.cx, 298);
  const dMid = footShadowAnchor({ classId: 'dancer', stage: 'mid' }, 100, false);
  const dLate = footShadowAnchor({ classId: 'dancer', stage: 'late' }, 100, false);
  assert.ok(dMid.rx < dLate.rx);

  // Font ink centering strips trailing advance whitespace and centers vertically cleanly
  assert.ok(textInkX('VS').inkW < textWidth('VS'));
  assert.equal(centerBaseline(10, 13), 21);
  assert.ok(buildBadgeSheetSvg().includes('<svg'));

  // Frame helpers smoke check
  const mat = materialFor('observatory');
  const px = { sets: 0, set() { this.sets += 1; }, rect() { this.sets += 1; }, hline() { this.sets += 1; }, vline() { this.sets += 1; } };
  drawRelicSocket(px, mat, 10, 10, 28, true);
  drawRibbonPlate(px, mat, 6, 6, 100, 32, { accent: '#f6c453', accentBoth: true });
  assert.ok(px.sets > 0);

  // Classic web bundler compiles share-vfx.js + share-gif.js cleanly
  const webDir = resolve(import.meta.dirname, '../sidecars/agy-lens/web');
  const bundled = bundleWebApp(webDir, 'app.js');
  assert.ok(bundled.includes('share-vfx.js'));
  assert.ok(bundled.includes('share-gif.js'));
  assert.ok(!bundled.includes('/api/pk'));
  new vm.Script(bundled, { filename: 'app.js' });
});

test('share-gif: pure Node GIF89a encoder, delay coalescing, LZW overflow, and compositor', () => {
  // 1. Base64 round-trip on multi-chunk binary
  const rawBytes = new Uint8Array(4099);
  for (let i = 0; i < rawBytes.length; i += 1) rawBytes[i] = (i * 37) & 255;
  assert.deepEqual(base64ToBytes(bytesToBase64(rawBytes)), rawBytes);

  // 2. Delay coalescing + exact 2x scaling + GIF89a header/NETSCAPE2.0/trailer
  const w = 8;
  const h = 6;
  const fA = new Uint8ClampedArray(w * h * 4);
  const fB = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i += 1) {
    fA[i * 4] = 20; fA[i * 4 + 1] = 40; fA[i * 4 + 2] = 80; fA[i * 4 + 3] = 255;
    fB[i * 4] = 20; fB[i * 4 + 1] = 40; fB[i * 4 + 2] = 80; fB[i * 4 + 3] = 255;
  }
  fB[4] = 240; fB[5] = 200; fB[6] = 40;
  const coalesced = encodeGif({
    width: w,
    height: h,
    frames: [
      { rgba: fA, delayCs: 10 },
      { rgba: new Uint8ClampedArray(fA), delayCs: 15 },
      { rgba: fB, delayCs: 12 },
    ],
    scale: 2,
  });
  assert.equal(Buffer.from(coalesced.subarray(0, 6)).toString('ascii'), 'GIF89a');
  assert.equal(coalesced[6] | (coalesced[7] << 8), w * 2);
  assert.equal(coalesced[8] | (coalesced[9] << 8), h * 2);
  assert.ok(Buffer.from(coalesced).includes(Buffer.from('NETSCAPE2.0')), 'animated GIF must include NETSCAPE2.0 loop extension');
  assert.equal(coalesced[coalesced.length - 1], 0x3b);
  // Count GCE markers (0x21 0xF9 0x04): 2 emitted frames (frame 0 coalesced with frame 1 -> delay 25)
  let gceCount = 0;
  for (let i = 0; i < coalesced.length - 4; i += 1) {
    if (coalesced[i] === 0x21 && coalesced[i + 1] === 0xf9 && coalesced[i + 2] === 0x04) {
      gceCount += 1;
      if (gceCount === 1) assert.equal(coalesced[i + 4] | (coalesced[i + 5] << 8), 25);
    }
  }
  assert.equal(gceCount, 2, 'identical adjacent frames should coalesce into 1 GCE');

  // 3. LZW dictionary overflow & code-table reset (>4096 codes on noisy large frame)
  const sw = 120;
  const sh = 90;
  const noisy = new Uint8ClampedArray(sw * sh * 4);
  for (let p = 0; p < sw * sh; p += 1) {
    noisy[p * 4] = (p * 53) & 255;
    noisy[p * 4 + 1] = (p * 97 + 13) & 255;
    noisy[p * 4 + 2] = (p * 193 + 71) & 255;
    noisy[p * 4 + 3] = 255;
  }
  const stressGif = encodeGif({ width: sw, height: sh, frames: [{ rgba: noisy, delayCs: 10 }], scale: 1 });
  assert.equal(Buffer.from(stressGif.subarray(0, 6)).toString('ascii'), 'GIF89a');
  assert.equal(stressGif[stressGif.length - 1], 0x3b);

  // 4. Composite & encode a real Role Card layout (fallback + animated ambient)
  const hist = sampleHist(1);
  const prof = buildProfile(hist, 'd30', { nickname: 'GifTester', gender: 'male' });
  const ach = usageAchievements(hist, 'd30', prof.stats);
  const layout = buildRoleCardLayout({ profile: prof, achievements: ach, lang: 'zh', arena: 'foundry' });
  const sp1 = new Uint8ClampedArray(192 * 128 * 4);
  const sp2 = new Uint8ClampedArray(192 * 128 * 4);
  for (let y = 70; y < 110; y += 1) {
    for (let x = 80; x < 105; x += 1) {
      const i = (y * 192 + x) * 4;
      sp1[i] = 240; sp1[i + 1] = 180; sp1[i + 2] = 60; sp1[i + 3] = 255;
      if (y > 72) { sp2[i] = 240; sp2[i + 1] = 120; sp2[i + 2] = 40; sp2[i + 3] = 255; }
    }
  }
  const { frames, priorityMask } = compositeRoleCardFrames({
    layout,
    spriteFrames: [
      { rgba: sp1, delayCs: 16, w: 192, h: 128 },
      { rgba: sp2, delayCs: 16, w: 192, h: 128 },
    ],
    seed: 19,
  });
  assert.equal(frames.length, 2);
  const cardGif = encodeGif({ width: 400, height: 210, frames, scale: 2, priorityMask });
  assert.equal(cardGif[6] | (cardGif[7] << 8), 800);
  assert.equal(cardGif[8] | (cardGif[9] << 8), 420);
  assert.equal(cardGif[cardGif.length - 1], 0x3b);
});

test('share-assets: copyShareGifToClipboard validates GIF, rotates saved files, and builds OS clipboard commands', async () => {
  assert.equal(MAX_SHARE_GIF_BYTES, 12 * 1024 * 1024);

  const winCmd = clipboardCommandForPlatform('C:\\tmp\\a.gif', { platform: 'win32', env: {} });
  assert.equal(winCmd.cmd, 'powershell.exe');
  assert.equal(winCmd.env.AGY_CLIP_PATH, 'C:\\tmp\\a.gif');

  const macCmd = clipboardCommandForPlatform('/tmp/a.gif', { platform: 'darwin', env: {} });
  assert.equal(macCmd.cmd, 'osascript');
  assert.ok(macCmd.args.includes('/tmp/a.gif'));

  const wayCmd = clipboardCommandForPlatform('/tmp/my card.gif', { platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' } });
  assert.equal(wayCmd.cmd, 'wl-copy');
  assert.equal(wayCmd.stdin, 'file:///tmp/my%20card.gif\r\n');

  const xCmd = clipboardCommandForPlatform('/tmp/a.gif', { platform: 'linux', env: { DISPLAY: ':0' } });
  assert.equal(xCmd.cmd, 'xclip');
  assert.equal(clipboardCommandForPlatform('/tmp/a.gif', { platform: 'linux', env: {} }), null);

  const dir = mkdtempSync(join(tmpdir(), 'agy-gif-clip-'));
  try {
    const validGif = Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.alloc(16), Buffer.from([0x3b])]);
    const calls = [];
    const mockExec = async (spec) => { calls.push(spec); };

    const badMagic = await copyShareGifToClipboard(dir, { data: Buffer.from('not-a-gif-payload!!').toString('base64') }, { execFileFn: mockExec });
    assert.equal(badMagic.ok, false);
    assert.equal(badMagic.error, 'invalid_gif');

    const badTrailer = await copyShareGifToClipboard(dir, { data: Buffer.from('GIF89a1234567890').toString('base64') }, { execFileFn: mockExec });
    assert.equal(badTrailer.ok, false);
    assert.equal(badTrailer.error, 'invalid_gif');

    const hugeB64 = 'A'.repeat(Math.ceil((MAX_SHARE_GIF_BYTES + 1024) / 3) * 4);
    const tooBig = await copyShareGifToClipboard(dir, { data: hugeB64 }, { execFileFn: mockExec });
    assert.equal(tooBig.ok, false);
    assert.equal(tooBig.error, 'too_large');

    // Write MAX_SAVED_GIFS + 2 exports and ensure old files prune to MAX_SAVED_GIFS
    for (let i = 0; i < MAX_SAVED_GIFS + 2; i += 1) {
      const okRes = await copyShareGifToClipboard(
        dir,
        { data: `data:image/gif;base64,${validGif.toString('base64')}`, filename: `../../evil/role_${i}` },
        { platform: 'win32', execFileFn: mockExec },
      );
      assert.equal(okRes.ok, true);
      assert.ok(okRes.path.startsWith(resolve(dir)));
      assert.ok(!okRes.path.includes('..'));
    }
    assert.equal(calls.length, MAX_SAVED_GIFS + 2);
    const { readdirSync } = await import('node:fs');
    assert.equal(readdirSync(dir).filter((f) => f.endsWith('.gif')).length, MAX_SAVED_GIFS);

    const unsup = await copyShareGifToClipboard(
      dir,
      { data: validGif.toString('base64') },
      { platform: 'linux', env: {}, execFileFn: mockExec },
    );
    assert.equal(unsup.ok, false);
    assert.equal(unsup.error, 'clipboard_unsupported');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildShareCardSvg adapts sun/moon trajectory, phase, and painted cloud colors across time of day', () => {
  const hist = sampleHist(1);
  const extractAura = (svg) => {
    const m = svg.match(/id="agy-ed-sun-aura" cx="([^"]+)" cy="([^"]+)"/);
    return m ? { cx: m[1], cy: m[2] } : null;
  };
  for (const theme of ['dark', 'light']) {
    const checks = [
      [6.0, 'dawn'],
      [12.5, 'noon'],
      [17.6, 'sunset'],
      [23.0, 'night'],
    ].map(([hour, expectedPhase]) => {
      const svg = buildShareCardSvg({
        period: 'd30',
        totals: hist.totals,
        byModel: hist.by_model.d30,
        daily: hist.daily,
        lang: 'zh',
        theme,
        hour,
      });
      assert.ok(svg.includes(`data-sky-phase="${expectedPhase}"`), `expected phase ${expectedPhase} in ${theme}`);
      assert.ok(!/\bNaN\b|\bInfinity\b|\bundefined\b/.test(svg), `unexpected NaN/Infinity/undefined at hour ${hour} (${theme})`);
      return { expectedPhase, aura: extractAura(svg), cloud: svg.match(/id="agy-ed-cloud-grad"[\s\S]*?<\/linearGradient>/)?.[0] || '' };
    });

    assert.notDeepEqual(checks[0].aura, checks[1].aura, `${theme}: dawn vs noon sun position should move`);
    assert.notDeepEqual(checks[1].aura, checks[2].aura, `${theme}: noon vs sunset sun position should move`);
    assert.notEqual(checks[1].cloud, checks[2].cloud, `${theme}: noon vs sunset cloud palette should shift`);
    assert.notEqual(checks[2].cloud, checks[3].cloud, `${theme}: sunset vs night cloud palette should shift`);
  }
});

test('multi-style share cards, Day/Night themes across all 6 styles, pure-Node WebGL uniforms, and GIF89a dithering', () => {
  assert.equal(WEB_MAX_GIF_BYTES, MAX_SHARE_GIF_BYTES);
  assert.deepEqual(Object.keys(SHARE_STYLE_SPECS), ['mountain', 'abyssal', 'eclipse', 'bauhaus', 'phosphor', 'pixel-role']);
  for (const s of SHARE_STYLES) {
    assert.equal(SHARE_STYLE_SPECS[s].supportsTheme, true, `${s} must support both Dark (Night) and Light (Day) themes`);
  }

  const webDir = resolve(import.meta.dirname, '../sidecars/agy-lens/web');
  const bundled = bundleWebApp(webDir, 'app.js');
  assert.ok(bundled.includes('views/share-styles.js'), 'bundle must include views/share-styles.js');
  assert.ok(bundled.includes('views/share-webgl.js'), 'bundle must include views/share-webgl.js');
  const forbiddenGlobalsRe = /\b(window|document|localStorage|navigator|location|Image|Blob|URL)\b/;
  const shareStylesSrc = readFileSync(join(webDir, 'views', 'share-styles.js'), 'utf8');
  const shareGifPure = readFileSync(join(webDir, 'views', 'share-gif.js'), 'utf8').split('// --- browser-only helpers')[0];
  const shareWebglPure = readFileSync(join(webDir, 'views', 'share-webgl.js'), 'utf8').split('// --- browser-only helpers')[0];
  assert.ok(!forbiddenGlobalsRe.test(shareStylesSrc), 'share-styles.js must contain zero browser globals');
  assert.ok(!forbiddenGlobalsRe.test(shareGifPure), 'share-gif.js pure-Node section must contain zero browser globals');
  assert.ok(!forbiddenGlobalsRe.test(shareWebglPure), 'share-webgl.js pure-Node section must contain zero browser globals');

  const hist = {
    ...sampleHist(1),
    by_conversation: [{ title: 'SECRET_CONV_CANARY', workspace: 'C:\\Users\\alice\\secret' }],
    title: 'CANARY_TITLE',
    workspace: '/Users/alice/canary_ws',
    quip: 'Read /Users/alice/secret.txt or ping alice@secret.org',
    hour: 17.6,
  };

  // Mountain animPhase = 0 must be byte-identical to omitted animPhase, and phase=1 wraps to phase=0
  assert.equal(buildShareCardSvg(hist), buildShareCardSvg(hist, 0));
  assert.equal(buildShareCardSvg(hist, 0), buildShareCardSvg(hist, 1));
  assert.equal(buildShareCardStyleSvg('minimal-light', hist, 0), buildShareCardSvg({ ...hist, theme: 'light' }, 0));

  for (const style of ['mountain', 'abyssal', 'eclipse', 'bauhaus', 'phosphor']) {
    const spec = SHARE_STYLE_SPECS[style];
    assert.equal(spec.width, 760);
    assert.equal(spec.height, 950);
    const uDark = computePosterShaderUniforms(style, { ...hist, theme: 'dark' });
    const uLight = computePosterShaderUniforms(style, { ...hist, theme: 'light' });
    assert.equal(uDark.curve.length, 24);
    assert.notDeepEqual(uDark.colA, uLight.colA, `${style} WebGL shader uniforms must differentiate dark vs light`);

    for (const theme of ['dark', 'light']) {
      for (const lang of ['en', 'zh']) {
        for (const period of ['today', 'd7', 'd30', 'all']) {
          const s0 = buildShareCardStyleSvg(style, { ...hist, lang, period, theme }, 0);
          const s5 = buildShareCardStyleSvg(style, { ...hist, lang, period, theme }, 0.5);
          const sCut = buildShareCardStyleSvg(style, { ...hist, lang, period, theme, webglCutout: true }, 0);
          assert.ok(s0.startsWith(`<svg xmlns="http://www.w3.org/2000/svg" width="${spec.width}" height="${spec.height}"`), `${style}/${theme}/${lang}/${period} dimensions`);
          assert.ok(s0.endsWith('</svg>'));
          assert.ok(s0.includes('data-editorial-poster="1"'), `${style} must carry data-editorial-poster="1"`);
          assert.ok(!/\bNaN\b|\bInfinity\b|\bundefined\b/.test(s0));
          assert.ok(!/\bNaN\b|\bInfinity\b|\bundefined\b/.test(s5));
          assert.ok(!/\bNaN\b|\bInfinity\b|\bundefined\b/.test(sCut));
          assert.notEqual(s0, s5, `${style}/${theme}/${lang}/${period} animPhase 0 vs 0.5 should animate`);
          assert.notEqual(s0, sCut, `${style}/${theme}/${lang}/${period} webglCutout should omit solid backdrop`);
          for (const canary of ['SECRET_CONV_CANARY', 'CANARY_TITLE', 'canary_ws', 'alice@secret.org', '/Users/alice']) {
            assert.ok(!s0.includes(canary), `${style} leaked ${canary}`);
          }
        }
      }
      const otherTheme = theme === 'dark' ? 'light' : 'dark';
      assert.notEqual(
        buildShareCardStyleSvg(style, { ...hist, theme }, 0),
        buildShareCardStyleSvg(style, { ...hist, theme: otherTheme }, 0),
        `${style} must render distinct dark and light posters`,
      );
    }
  }

  // Pixel-role also supports Night (dark) and Day (light) themes while default equals dark
  const roleProf = buildProfile(hist, 'd30', { nickname: 'NightDay', gender: 'male' });
  const roleAch = usageAchievements(hist, 'd30', roleProf.stats);
  const roleDefault = buildRoleCardSvg({ profile: roleProf, achievements: roleAch, lang: 'zh', arena: 'observatory' });
  const roleDark = buildRoleCardSvg({ profile: roleProf, achievements: roleAch, lang: 'zh', arena: 'observatory', theme: 'dark' });
  const roleLight = buildRoleCardSvg({ profile: roleProf, achievements: roleAch, lang: 'zh', arena: 'observatory', theme: 'light' });
  assert.equal(roleDefault, roleDark, 'pixel-role default theme must match dark');
  assert.notEqual(roleDark, roleLight, 'pixel-role light theme must render sunlit parchment dossier');

  // Sanitizer guards empty/degenerate inputs without throwing
  const emptySan = sanitizeShareCardInput({ totals: null, by_model: null, daily: null });
  assert.equal(emptySan.totals.totalNew, 0);
  assert.equal(emptySan.models.length, 0);

  // Pixel Role nickname fit across all 13 classes in en and zh for GlassCraft and 8-char CJK
  const profBase = buildProfile(hist, 'd30', { nickname: 'GlassCra', gender: 'male' });
  const ach = usageAchievements(hist, 'd30', profBase.stats);
  for (const lang of ['en', 'zh']) {
    for (const classId of CLASS_IDS) {
      for (const nick of ['GlassCraft', '中文测试昵称八字']) {
        const clsLabel = I18N[lang].shareClassNames[classId];
        const tagW = Math.max(12, textInkX(clsLabel).inkW + 8);
        const maxNickW = Math.max(40, (384 - 194) - 4 - tagW);
        assert.ok(textWidth(nick) <= maxNickW, `${lang}/${classId}: ${nick} exceeds ${maxNickW}px`);
        const layout = buildRoleCardLayout({ profile: { ...profBase, classId, nickname: nick }, achievements: ach, lang, arena: 'foundry' });
        assert.ok(layout && layout.ui);
      }
    }
  }

  // Bayer dithering on >256 color gradient with alpha=0 pixel and identical-frame coalescing
  const gw = 32;
  const gh = 32;
  const makeFrame = (shift) => {
    const rgba = new Uint8ClampedArray(gw * gh * 4);
    for (let y = 0; y < gh; y += 1) {
      for (let x = 0; x < gw; x += 1) {
        const i = (y * gw + x) * 4;
        if (x === 0 && y === 0) {
          rgba[i + 3] = 0;
        } else {
          rgba[i] = Math.min(255, x * 8 + shift);
          rgba[i + 1] = Math.min(255, y * 8);
          rgba[i + 2] = Math.min(255, ((x + y) * 4) & 255);
          rgba[i + 3] = 255;
        }
      }
    }
    return rgba;
  };
  const f0 = makeFrame(0);
  const f1 = makeFrame(10);
  const bayerGif = encodeGif({
    width: gw,
    height: gh,
    frames: [{ rgba: f0, delayCs: 10 }, { rgba: new Uint8ClampedArray(f0), delayCs: 10 }, { rgba: f1, delayCs: 10 }],
    scale: 1,
    dither: 'bayer',
  });
  assert.equal(Buffer.from(bayerGif.subarray(0, 6)).toString('ascii'), 'GIF89a');
  assert.equal(bayerGif[bayerGif.length - 1], 0x3b);
  let gce = 0;
  for (let i = 0; i < bayerGif.length - 4; i += 1) {
    if (bayerGif[i] === 0x21 && bayerGif[i + 1] === 0xf9 && bayerGif[i + 2] === 0x04) {
      gce += 1;
      if (gce === 1) assert.equal(bayerGif[i + 4] | (bayerGif[i + 5] << 8), 20);
    }
  }
  assert.equal(gce, 2, 'identical Bayer frames should still coalesce');
});

test('v13 poster resilience: visual-width truncation, wide cost scaling, centered single tick, period byModel parity, and Floyd-Steinberg GIF dithering', () => {
  const hist = sampleHist(1);
  const singleDayDaily = [
    { date: '2026-11-18', tokens: 1000, calls: 2 },
    { date: '2026-11-19', tokens: 5000, calls: 5 },
    { date: '2026-11-20', tokens: 2000, calls: 3 },
  ];

  // 1. Mountain & new posters visual-width truncation (CJK quip under lang='en', 40x'W' model name) & period-keyed byModel parity
  const longCjkQuip = '一二三四五六七八九十'.repeat(4);
  const wideModel = 'W'.repeat(40);
  for (const style of ['mountain', 'abyssal', 'eclipse', 'bauhaus', 'phosphor']) {
    const svg = buildShareCardStyleSvg(style, {
      period: 'd7',
      lang: 'en',
      theme: 'dark',
      quip: longCjkQuip,
      totals: { d7: { input: 10000, output: 5000, cache_read: 0, calls: 5, conversations: 1, est_cost_usd: 1234567.89, cost_partial: true } },
      byModel: {
        d7: [{ model: wideModel, display_name: wideModel, input: 10000, output: 5000, calls: 5 }],
      },
      daily: singleDayDaily,
    }, 0);
    assert.ok(!svg.includes('W'.repeat(22)), `${style} 40xW model name must truncate by visual width`);
    assert.ok(svg.includes('W…'), `${style} truncated wide model name should still render`);
    assert.ok(!svg.includes(longCjkQuip), `${style} long CJK quip must truncate cleanly`);
  }

  const mtnPeriodObj = buildShareCardSvg({
    period: 'd7',
    lang: 'en',
    totals: { d7: { input: 5000, output: 2000, cache_read: 0, calls: 3, conversations: 1 } },
    byModel: { d7: [{ model: 'm-d7', display_name: 'Period D7 Model', input: 5000, output: 2000, calls: 3 }] },
    daily: singleDayDaily,
  });
  assert.ok(mtnPeriodObj.includes('Period D7 Model'), 'buildShareCardSvg must support period-keyed byModel objects');

  // 1b. Real multi-word model names (e.g. Gemini 4 Hydrogen (XHigh)) & vertical spine must render in full without ellipsis
  for (const style of ['mountain', 'abyssal', 'eclipse', 'bauhaus', 'phosphor']) {
    const fullTxtSvg = buildShareCardStyleSvg(style, {
      period: 'd30',
      lang: 'zh',
      theme: 'dark',
      quip: '≈ 2605 本 30 万字的长篇小说',
      totals: { d30: { input: 706100000, output: 75500000, cache_read: 9700000000, calls: 64867, conversations: 46, est_cost_usd: 2697.77, cost_estimated: true } },
      byModel: [
        { model: 'g4-h', display_name: 'Gemini 4 Hydrogen (High)', input: 460000000, output: 58000000, calls: 30000 },
        { model: 'g4-xh', display_name: 'Gemini 4 Hydrogen (XHigh)', input: 75000000, output: 10300000, calls: 12000 },
        { model: 'opus', display_name: 'Claude Opus 4.6 (Thinking)', input: 60000000, output: 7100000, calls: 10000 },
      ],
      daily: singleDayDaily,
    }, 0);
    assert.ok(fullTxtSvg.includes('781.6M'), `${style} must display full 781.6M hero total`);
    assert.ok(fullTxtSvg.includes('Gemini 4 Hydrogen (High)'), `${style} must not truncate Gemini 4 Hydrogen (High)`);
    assert.ok(fullTxtSvg.includes('Gemini 4 Hydrogen (XHigh)'), `${style} must not truncate Gemini 4 Hydrogen (XHigh)`);
    assert.ok(fullTxtSvg.includes('Claude Opus 4.6 (Thinking)'), `${style} must not truncate Claude Opus 4.6 (Thinking)`);
    assert.ok(!fullTxtSvg.includes('…'), `${style} must have zero truncated text ellipses on standard model/spine/quip strings`);
  }

  // 2. Single-day axisTicks center with text-anchor="middle" on abyssal
  const singleDay = {
    period: 'd7',
    lang: 'en',
    totals: { d7: { input: 4000, output: 1000, cache_read: 0, calls: 3, conversations: 1 } },
    byModel: [{ model: 'm1', display_name: 'Model One', input: 4000, output: 1000, calls: 3 }],
    daily: [{ date: '2026-11-20', tokens: 5000, calls: 3 }],
  };
  const abySingle = buildShareCardStyleSvg('abyssal', singleDay, 0);
  assert.match(abySingle, /text-anchor="middle"[^>]*>Fri 20<\/text>/, 'abyssal single-day tick must use text-anchor="middle"');

  // 3. Gentle serpentine Floyd-Steinberg dithering produces valid grain-free GIF89a
  const gw = 24;
  const gh = 24;
  const grad = new Uint8ClampedArray(gw * gh * 4);
  for (let y = 0; y < gh; y += 1) {
    for (let x = 0; x < gw; x += 1) {
      const i = (y * gw + x) * 4;
      grad[i] = x * 10;
      grad[i + 1] = y * 10;
      grad[i + 2] = 120;
      grad[i + 3] = 255;
    }
  }
  const floydGif = encodeGif({
    width: gw,
    height: gh,
    frames: [{ rgba: grad, delayCs: 10 }],
    scale: 1,
    dither: 'floyd',
  });
  assert.equal(Buffer.from(floydGif.subarray(0, 6)).toString('ascii'), 'GIF89a');
  assert.equal(floydGif[floydGif.length - 1], 0x3b);
});

test('share-motion: pure-Node MP4 muxer, Motion Photo XMP injector, Mountain data-mtn-anim, and copyShareFileToClipboard', async () => {
  assert.equal(MAX_SHARE_MOTION_BYTES, 16 * 1024 * 1024);
  assert.equal(MAX_SHARE_FILE_BYTES, 16 * 1024 * 1024);

  const webDir = resolve(import.meta.dirname, '../sidecars/agy-lens/web');
  const bundled = bundleWebApp(webDir, 'app.js');
  assert.ok(bundled.includes('views/share-motion.js'), 'bundle must include views/share-motion.js');
  const motionPure = readFileSync(join(webDir, 'views', 'share-motion.js'), 'utf8').split('// --- browser-only helpers')[0];
  const forbiddenMotionRe = /\b(window|document|localStorage|navigator|location|Image|Blob|URL|VideoEncoder|MediaRecorder|VideoFrame)\b/;
  assert.ok(!forbiddenMotionRe.test(motionPure), 'share-motion.js pure-Node section must contain zero browser globals');

  // 1. muxAvcToMp4 validation
  const validAvcC = new Uint8Array([1, 0x42, 0xe0, 0x1e, 0xff, 0xe1, 0x00, 0x04, 0x67, 0x42, 0xe0, 0x1e, 0x01, 0x00, 0x02, 0x68, 0xce]);
  const sampleFrames = [
    { data: new Uint8Array([0, 0, 0, 5, 0x65, 0x88, 0x84, 0x21, 0xa0]), isKey: true, durationUs: 62500 },
    { data: new Uint8Array([0, 0, 0, 4, 0x41, 0x9a, 0x22, 0x10]), isKey: false, durationUs: 62500 },
  ];
  assert.throws(() => muxAvcToMp4({ width: 761, height: 950, frames: sampleFrames, avcC: validAvcC }));
  assert.throws(() => muxAvcToMp4({ width: 760, height: 951, frames: sampleFrames, avcC: validAvcC }));
  assert.throws(() => muxAvcToMp4({ width: 0, height: 950, frames: sampleFrames, avcC: validAvcC }));
  assert.throws(() => muxAvcToMp4({ width: 760, height: 950, frames: [], avcC: validAvcC }));
  assert.throws(() => muxAvcToMp4({ width: 760, height: 950, frames: sampleFrames, avcC: new Uint8Array([0, 1, 2, 3, 4, 5, 6]) }));

  const mp4 = muxAvcToMp4({ width: 760, height: 950, frames: sampleFrames, avcC: validAvcC });
  const mp4Buf = Buffer.from(mp4);
  assert.equal(mp4Buf.subarray(4, 8).toString('ascii'), 'ftyp');
  const ftypSize = mp4Buf.readUInt32BE(0);
  assert.equal(mp4Buf.subarray(ftypSize + 4, ftypSize + 8).toString('ascii'), 'moov');
  const moovSize = mp4Buf.readUInt32BE(ftypSize);
  assert.equal(mp4Buf.subarray(ftypSize + moovSize + 4, ftypSize + moovSize + 8).toString('ascii'), 'mdat');
  for (const tag of ['mvhd', 'trak', 'tkhd', 'mdia', 'mdhd', 'hdlr', 'minf', 'vmhd', 'dinf', 'stbl', 'stsd', 'avc1', 'avcC', 'pasp', 'stts', 'stss', 'stsc', 'stsz', 'stco']) {
    assert.ok(mp4Buf.includes(Buffer.from(tag, 'ascii')), `MP4 missing ${tag} box`);
  }
  const stcoIdx = mp4Buf.lastIndexOf(Buffer.from('stco', 'ascii'));
  const chunkOffset = mp4Buf.readUInt32BE(stcoIdx + 12);
  assert.equal(chunkOffset, ftypSize + moovSize + 8, 'stco chunk offset must point directly to first mdat sample');

  // 2. injectMotionPhotoXmp: APP0 ordering, SOS FF 00 & RST0 safety, trailing trim, exact Item:Length
  const fakeJpeg = Buffer.from([
    0xff, 0xd8, // SOI
    0xff, 0xe0, 0x00, 0x06, 0x4a, 0x46, 0x49, 0x46, // APP0
    0xff, 0xda, 0x00, 0x04, 0x01, 0x02, // SOS
    0xaa, 0xff, 0x00, 0xbb, 0xff, 0xd0, 0xcc, // entropy with FF 00 + RST0
    0xff, 0xd9, // EOI
    0xde, 0xad, 0xbe, 0xef, // trailing garbage after EOI must be trimmed
  ]);
  const motionJpg = Buffer.from(injectMotionPhotoXmp(fakeJpeg, mp4, { presentationTimestampUs: 125000 }));
  assert.equal(motionJpg[0], 0xff);
  assert.equal(motionJpg[1], 0xd8);
  assert.equal(motionJpg[2], 0xff);
  assert.equal(motionJpg[3], 0xe0, 'APP0 must stay immediately after SOI before APP1 XMP');
  const motionStr = motionJpg.toString('latin1');
  assert.ok(motionStr.includes('GCamera:MotionPhoto="1"'));
  assert.ok(motionStr.includes('GCamera:MotionPhotoVersion="1"'));
  assert.ok(motionStr.includes('GCamera:MotionPhotoPresentationTimestampUs="125000"'));
  assert.ok(motionStr.includes(`Item:Length="${mp4.byteLength}"`));
  assert.ok(!motionJpg.subarray(0, motionJpg.length - mp4.byteLength).includes(Buffer.from([0xde, 0xad, 0xbe, 0xef])), 'trailing bytes after EOI must be trimmed');
  assert.deepEqual(motionJpg.subarray(motionJpg.length - mp4.byteLength), mp4Buf);

  // Adversarial presentationTimestampUs inputs (Infinity, -Infinity, NaN, -500, 'abc', null opts)
  for (const badOpts of [
    null,
    { presentationTimestampUs: Infinity },
    { presentationTimestampUs: -Infinity },
    { presentationTimestampUs: NaN },
    { presentationTimestampUs: -500 },
    { presentationTimestampUs: 'abc' },
  ]) {
    const out = Buffer.from(injectMotionPhotoXmp(fakeJpeg, mp4, badOpts)).toString('latin1');
    assert.ok(out.includes('GCamera:MotionPhotoPresentationTimestampUs="0"'), `Unexpected timestamp for ${JSON.stringify(badOpts)}`);
    assert.ok(!out.includes('Infinity') && !out.includes('NaN'), `Non-finite timestamp leaked for ${JSON.stringify(badOpts)}`);
  }

  // 3. Mountain data-mtn-anim enrichment, phase=0->0.02 continuity, & wrapped wide-number scaling
  const hist = { ...sampleHist(1), hour: 23.0 };
  const m0 = buildShareCardSvg({ ...hist, theme: 'dark' }, 0);
  const m02 = buildShareCardSvg({ ...hist, theme: 'dark' }, 0.02);
  const m3 = buildShareCardSvg({ ...hist, theme: 'dark' }, 0.3);
  assert.equal(buildShareCardSvg({ ...hist, theme: 'dark' }), m0);
  for (const attr of ['cirrus', 'deck', 'stratus', 'mist-a', 'mist-b', 'mist-c', 'corona', 'aura', 'star', 'beacon', 'meteor']) {
    assert.ok(m0.includes(`data-mtn-anim="${attr}"`), `Mountain phase=0 missing data-mtn-anim="${attr}"`);
    assert.ok(m3.includes(`data-mtn-anim="${attr}"`), `Mountain phase=0.3 missing data-mtn-anim="${attr}"`);
  }
  const auraOp02 = m02.match(/data-mtn-anim="aura"[^>]*opacity="([^"]+)"/);
  assert.ok(auraOp02 && Number(auraOp02[1]) >= 0.99, `Mountain aura phase=0.02 opacity step too large: ${auraOp02?.[1]}`);
  assert.equal((m3.match(/<circle [^>]*r="8\.5"/g) || []).length, 0);
  assert.ok(/id="agy-ed-sun-aura" cx="[^"]+" cy="[^"]+"/.test(m0));

  const bauhausExtreme = buildShareCardStyleSvg('bauhaus', {
    period: 'all',
    lang: 'en',
    theme: 'light',
    totals: { all: { input: 5e7, output: 2e7, cache_read: 1e8, calls: 1234567, conversations: 123456, est_cost_usd: 1234567.89, cost_partial: true } },
    byModel: hist.by_model.d30,
    daily: hist.daily,
  }, 0);
  const bauhausCostMatch = bauhausExtreme.match(/<text x="720" y="496"[^>]*font-size="(\d+(?:\.\d+)?)"[^>]*>([^<]+)<\/text>/);
  assert.ok(bauhausCostMatch && Number(bauhausCostMatch[1]) <= 45, `bauhaus wide cost must scale down cleanly, got ${bauhausCostMatch?.[1]}`);

  // 4. copyShareFileToClipboard across jpg (Motion Photo), mp4, webm, gif + mtime-tie pruning safety
  const dir = mkdtempSync(join(tmpdir(), 'agy-share-file-'));
  try {
    const calls = [];
    const mockExec = async (spec) => { calls.push(spec); };

    const badKind = await copyShareFileToClipboard(dir, { data: motionJpg.toString('base64'), kind: 'exe' }, { execFileFn: mockExec });
    assert.equal(badKind.ok, false);
    assert.equal(badKind.error, 'invalid_kind');

    const badJpg = await copyShareFileToClipboard(dir, { data: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02]).toString('base64'), kind: 'jpg' }, { execFileFn: mockExec });
    assert.equal(badJpg.ok, false);
    assert.equal(badJpg.error, 'invalid_file');

    const okMotionJpg = await copyShareFileToClipboard(
      dir,
      { data: `data:image/jpeg;base64,${motionJpg.toString('base64')}`, filename: 'mountain-live', kind: 'jpg' },
      { platform: 'win32', execFileFn: mockExec },
    );
    assert.equal(okMotionJpg.ok, true);
    assert.ok(okMotionJpg.path.endsWith('.jpg'));

    const okMp4 = await copyShareFileToClipboard(
      dir,
      { data: mp4Buf.toString('base64'), filename: 'mountain-clip', kind: 'mp4' },
      { platform: 'win32', execFileFn: mockExec },
    );
    assert.equal(okMp4.ok, true);
    assert.ok(okMp4.path.endsWith('.mp4'));

    const fakeWebm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]);
    const okWebm = await copyShareFileToClipboard(
      dir,
      { data: fakeWebm.toString('base64'), filename: 'clip', kind: 'webm' },
      { platform: 'win32', execFileFn: mockExec },
    );
    assert.equal(okWebm.ok, true);
    assert.ok(okWebm.path.endsWith('.webm'));
    assert.equal(calls.length, 3);

    // Mtime-tie / future-mtime pruning safety: seed MAX_SAVED_GIFS files with future mtime; new file must survive
    const tieDir = join(dir, 'tie');
    mkdirSync(tieDir, { recursive: true });
    const futureTime = new Date(Date.now() + 60000);
    const tinyGif = Buffer.from([
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x3b,
    ]);
    for (let i = 0; i < MAX_SAVED_GIFS; i += 1) {
      const p = join(tieDir, `zzz-seed-${i}.gif`);
      writeFileSync(p, tinyGif);
      utimesSync(p, futureTime, futureTime);
    }
    const newFileRes = await copyShareFileToClipboard(
      tieDir,
      { data: mp4Buf.toString('base64'), filename: 'aaa-newest', kind: 'mp4' },
      { platform: 'win32', execFileFn: mockExec },
    );
    assert.equal(newFileRes.ok, true);
    assert.equal(existsSync(newFileRes.path), true, 'copyShareFileToClipboard must never prune newly written file on mtime tie');
    assert.ok(readdirSync(tieDir).length <= MAX_SAVED_GIFS);

    const newGifRes = await copyShareGifToClipboard(
      tieDir,
      { data: tinyGif.toString('base64'), filename: 'aaa-newest-gif' },
      { platform: 'win32', execFileFn: mockExec },
    );
    assert.equal(newGifRes.ok, true);
    assert.equal(existsSync(newGifRes.path), true, 'copyShareGifToClipboard must never prune newly written file on mtime tie');
    assert.ok(readdirSync(tieDir).filter((n) => n.endsWith('.gif')).length <= MAX_SAVED_GIFS);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
