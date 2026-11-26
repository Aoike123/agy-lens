import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import vm from 'node:vm';

import {
  ARENA_IDS, ACHIEVEMENTS, USAGE_ACHIEVEMENTS, buildProfile, buildQuips, computeLevel, computeStats,
  sanitizeNickname, usageAchievements,
} from '../sidecars/agy-lens/web/views/share-game.js';
import {
  listShareAssets, loadShareProfile, readShareAsset, shareProfilePayload, updateShareProfile,
} from '../sidecars/agy-lens/lib/share-assets.mjs';
import {
  ARENA_AMBIENT_IDS, VFX_H, VFX_W, compositeVfx, createAmbientFx, createVfxFrame, renderStaticAmbientSvg,
} from '../sidecars/agy-lens/web/views/share-vfx.js';
import {
  PIXEL_H, PIXEL_W, buildBadgeSheetSvg, buildRoleCardSvg,
  centerBaseline, footShadowAnchor, textInkX, textWidth,
} from '../sidecars/agy-lens/web/views/share-pixel.js';
import {
  SHARE_CARD_HEIGHT, SHARE_CARD_WIDTH, SHARE_STYLES, buildShareCardSvg, quipText,
} from '../sidecars/agy-lens/web/views/share-card.js';
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
  assert.deepEqual(SHARE_STYLES, ['minimal-dark', 'minimal-light', 'pixel-role']);

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
        assert.equal((usageSvg.match(/<circle [^>]*r="8.5"/g) || []).length, 100);
        assert.ok(usageSvg.includes('agy-sc-left-clip'), 'usage card should include optical reticle chamber');
      }
    }
  }

  const prof = buildProfile(hist, 'd30', { nickname: '<bad>', gender: 'male' });
  const ach = usageAchievements(hist, 'd30', prof.stats);
  const roleSvg = buildRoleCardSvg({ profile: prof, achievements: ach, lang: 'zh', arena: 'foundry' });
  assert.ok(roleSvg.startsWith(`<svg xmlns="http://www.w3.org/2000/svg" width="${PIXEL_W}" height="${PIXEL_H}"`));
  assert.ok(!roleSvg.includes('<script'));
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

  // Classic web bundler compiles share-vfx.js + Batch 1 share modules cleanly
  const webDir = resolve(import.meta.dirname, '../sidecars/agy-lens/web');
  const bundled = bundleWebApp(webDir, 'app.js');
  assert.ok(bundled.includes('share-vfx.js'));
  assert.ok(!bundled.includes('/api/pk'));
  new vm.Script(bundled, { filename: 'app.js' });
});
