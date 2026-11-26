import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { decodePng, encodePng } from '../scripts/share-art/png.mjs';
import {
  PALETTE,
  RAMP_DEFS,
  RAMP_STEPS,
  darker,
  keyBackground,
  lighter,
  shadeBackground,
  shadeLayer,
  shadeSprite,
} from '../scripts/share-art/shade.mjs';
import { SCENES, catalog, imageInfo, processImage, renderAssetModule, run, specFor } from '../scripts/share-art/build.mjs';

// A tiny "character": red body, skin head, black outline, drawn on a 16x16 grid.
const ART = [
  '................',
  '.....oooooo.....',
  '....ossssssO....',
  '....osesseso....',
  '....ossssssO....',
  '.....oooooo.....',
  '....orrrrrro....',
  '...orrrrrrrro...',
  '...orrrrrrrro...',
  '...orrrrrrrro...',
  '...orrrrrrrro...',
  '....orrrrrro....',
  '....oddooddoo...',
  '....oddoodd.....',
  '....ooo..ooo....',
  '................',
];
const COLOURS = { o: [20, 21, 31], O: [20, 21, 31], s: [255, 210, 173], e: [29, 31, 58], r: [214, 58, 52], d: [74, 51, 38] };

/** Simulate an image-generator render: upscale, add noise, soften edges, magenta backdrop. */
function generatorLike({ scale = 24, size = 448, seed = 3, backdrop = [255, 0, 255] } = {}) {
  const W = size;
  const H = size;
  const data = new Uint8Array(W * H * 4);
  const ox = Math.floor((W - 16 * scale) / 2);
  const oy = Math.floor((H - 16 * scale) / 2);
  let r = seed;
  const rnd = () => ((r = (r * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const gx = Math.floor((x - ox) / scale);
      const gy = Math.floor((y - oy) / scale);
      const ch = gx >= 0 && gy >= 0 && gx < 16 && gy < 16 ? ART[gy][gx] : '.';
      const c = COLOURS[ch] || backdrop;
      const n = (rnd() - 0.5) * 20;
      const o = (y * W + x) * 4;
      for (let k = 0; k < 3; k += 1) data[o + k] = Math.max(0, Math.min(255, c[k] + n));
      data[o + 3] = 255;
    }
  }
  const out = new Uint8Array(data);
  for (let y = 1; y < H - 1; y += 1) {
    for (let x = 1; x < W - 1; x += 1) {
      for (let k = 0; k < 3; k += 1) {
        let s = 0;
        for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) s += data[((y + dy) * W + x + dx) * 4 + k];
        out[(y * W + x) * 4 + k] = s / 9;
      }
    }
  }
  return { width: W, height: H, data: out };
}

const paletteKeys = new Set(PALETTE.map((c) => c.rgb.join(',')));

test('PNG encode/decode round-trips RGBA and rejects non-PNG input', () => {
  const img = { width: 5, height: 3, data: new Uint8Array(5 * 3 * 4) };
  for (let i = 0; i < img.data.length; i += 1) img.data[i] = (i * 37) & 0xff;
  const back = decodePng(encodePng(img));
  assert.equal(back.width, 5);
  assert.equal(back.height, 3);
  assert.deepEqual([...back.data], [...img.data]);
  assert.throws(() => decodePng(Buffer.from('not a png at all')), /Not a PNG/);
});

test('master palette: every ramp gets lighter step by step and shading moves stay inside the ramp', () => {
  assert.equal(PALETTE.length, RAMP_DEFS.length * RAMP_STEPS.length);
  for (let r = 0; r < RAMP_DEFS.length; r += 1) {
    for (let s = 1; s < RAMP_STEPS.length; s += 1) {
      const prev = PALETTE[r * RAMP_STEPS.length + s - 1];
      const cur = PALETTE[r * RAMP_STEPS.length + s];
      assert.ok(cur.lab[0] > prev.lab[0], `${cur.rampId} step ${s} should be lighter`);
    }
  }
  const mid = 3 * RAMP_STEPS.length + 4;
  assert.equal(PALETTE[lighter(mid)].ramp, PALETTE[mid].ramp);
  assert.equal(PALETTE[lighter(mid)].step, PALETTE[mid].step + 1);
  assert.equal(PALETTE[darker(mid)].step, PALETTE[mid].step - 1);
  const top = 3 * RAMP_STEPS.length + RAMP_STEPS.length - 1;
  assert.equal(lighter(top), top, 'lighter() clamps at the brightest step');
});

test('keyBackground floods from the border and keeps enclosed areas that match the key colour', () => {
  const W = 30;
  const H = 30;
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const o = (y * W + x) * 4;
      const ring = x >= 8 && x < 22 && y >= 8 && y < 22 && !(x >= 12 && x < 18 && y >= 12 && y < 18);
      const c = ring ? [40, 120, 200] : [255, 0, 255];
      data.set([...c, 255], o);
    }
  }
  const mask = keyBackground({ width: W, height: H, data });
  assert.equal(mask[0], 0, 'border backdrop removed');
  assert.equal(mask[10 * W + 10], 1, 'shape kept');
  assert.equal(mask[15 * W + 15], 1, 'enclosed key-coloured hole is not flooded');
});

test('shadeSprite turns a noisy generator render into palette-locked pixel art on the native grid', () => {
  const { image, colours } = shadeSprite(generatorLike(), { width: 48, height: 48, anchor: 'bottom', margin: 2 });
  assert.equal(image.width, 48);
  assert.equal(image.height, 48);
  assert.ok(colours <= 24, `expected a tight palette, got ${colours}`);
  let opaque = 0;
  let lowest = -1;
  for (let y = 0; y < 48; y += 1) {
    for (let x = 0; x < 48; x += 1) {
      const o = (y * 48 + x) * 4;
      const a = image.data[o + 3];
      assert.ok(a === 0 || a === 255, 'no partial alpha');
      if (!a) continue;
      opaque += 1;
      lowest = Math.max(lowest, y);
      const rgb = [image.data[o], image.data[o + 1], image.data[o + 2]];
      assert.ok(paletteKeys.has(rgb.join(',')), `pixel ${rgb} is not from the master palette`);
      const magentaish = rgb[0] > 150 && rgb[2] > 150 && rgb[1] < 90;
      assert.ok(!magentaish, `background bleed left at ${x},${y}`);
    }
  }
  assert.ok(opaque > 400, 'sprite keeps its body');
  assert.ok(lowest >= 44, 'bottom anchor puts the feet near the bottom edge');
  for (const [x, y] of [[0, 0], [47, 0], [0, 47], [47, 47]]) assert.equal(image.data[(y * 48 + x) * 4 + 3], 0, 'corners are transparent');
});

test('shadeBackground keeps the frame size and only uses palette colours', () => {
  const W = 120;
  const H = 70;
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) data.set([100 + y, 170 + (y >> 1), 255 - y, 255], (y * W + x) * 4);
  const { image } = shadeBackground({ width: W, height: H, data }, { width: 40, height: 21 });
  assert.equal(image.width, 40);
  assert.equal(image.height, 21);
  for (let i = 0; i < image.data.length; i += 4) {
    assert.equal(image.data[i + 3], 255);
    assert.ok(paletteKeys.has(`${image.data[i]},${image.data[i + 1]},${image.data[i + 2]}`));
  }
});

test('shadeLayer keeps the full width, stays transparent above the ridge, and anchors to the bottom', () => {
  const W = 800;
  const H = 240;
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const ridge = 120 + 50 * Math.sin(x / 60);
      data.set(y > ridge ? [90, 120, 170, 255] : [255, 0, 255, 255], (y * W + x) * 4);
    }
  }
  const { image } = shadeLayer({ width: W, height: H, data }, { width: 400, height: 70, anchor: 'bottom' });
  assert.equal(image.width, 400);
  assert.equal(image.height, 70);
  for (let x = 0; x < 400; x += 1) assert.equal(image.data[(69 * 400 + x) * 4 + 3], 255, 'bottom row is solid ground');
  assert.equal(image.data[3], 0, 'sky above the ridge is transparent');
});

test('scene layouts only reference assets that have a spec', () => {
  for (const L of SCENES.battle.layers) assert.ok(specFor(L.asset), L.asset);
  for (const row of SCENES.town.tiles) for (const t of row) assert.equal(specFor(t).width, 16, t);
  assert.equal(SCENES.town.tiles.length * SCENES.town.tileSize >= SCENES.town.height, true);
  for (const p of SCENES.town.props) assert.ok(specFor(p.asset), p.asset);
});

test('asset specs map name prefixes to native sizes', () => {
  assert.equal(specFor('layer-clouds').kind, 'layer');
  assert.deepEqual([specFor('prop-lab').width, specFor('prop-lab').height], [144, 112]);
  assert.equal(specFor('fx-hit').outline, false);
  assert.deepEqual([specFor('char-alchemist-idle').width, specFor('char-alchemist-idle').height], [192, 128]);
  assert.equal(specFor('bg-battle-day').kind, 'background');
  assert.equal(specFor('badge-juanwang').width, 24);
  assert.equal(specFor('random-file'), null);
  assert.throws(() => processImage('random-file', generatorLike({ size: 64, scale: 4 })), /No spec/);
});

test('build run writes previews and an importable data-URI module', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-art-'));
  try {
    const src = join(dir, 'art-src');
    const out = join(dir, 'art-out');
    mkdirSync(src);
    writeFileSync(join(src, 'char-test-idle.png'), encodePng(generatorLike({ size: 448 })));
    writeFileSync(join(src, 'notes.txt'), 'ignored');
    // a 3-frame strip: the same shape drawn at three sizes; one shared scale must keep them different
    const frames = [generatorLike({ size: 448, scale: 24 }), generatorLike({ size: 448, scale: 20 }), generatorLike({ size: 448, scale: 16 })];
    const strip = { width: 448 * 3, height: 448, data: new Uint8Array(448 * 3 * 448 * 4) };
    for (let y = 0; y < 448; y += 1) frames.forEach((fr, i) => strip.data.set(fr.data.subarray(y * 448 * 4, (y + 1) * 448 * 4), (y * 448 * 3 + i * 448) * 4));
    writeFileSync(join(src, 'fx-test-hit@3.png'), encodePng(strip));
    // a 2x2 grid sheet of the same shape
    const g = generatorLike({ size: 224, scale: 12 });
    const grid = { width: 448, height: 448, data: new Uint8Array(448 * 448 * 4) };
    for (let y = 0; y < 448; y += 1) for (let x = 0; x < 448; x += 1) grid.data.set(g.data.subarray(((y % 224) * 224 + (x % 224)) * 4, ((y % 224) * 224 + (x % 224)) * 4 + 4), (y * 448 + x) * 4);
    writeFileSync(join(src, 'char-grid-idle@2x2.png'), encodePng(grid));
    writeFileSync(join(src, 'mystery.png'), encodePng(generatorLike({ size: 64, scale: 4 })));
    const moduleOut = join(dir, 'share-assets.js');
    const logs = [];
    const rows = run({ srcDir: src, outDir: out, moduleOut, log: (m) => logs.push(m) });
    assert.equal(rows.length, 8);
    assert.ok(logs.some((l) => l.startsWith('skip  mystery.png')));
    assert.ok(readFileSync(join(out, 'preview.html'), 'utf8').includes('char-test-idle'));
    const mod = await import(pathToFileURL(moduleOut).href);
    const a = mod.SHARE_ASSETS['char-test-idle'];
    assert.equal(a.w, 192);
    assert.equal(a.h, 128);
    assert.ok(a.src.startsWith('data:image/png;base64,'));
    assert.deepEqual(Object.keys(mod.SHARE_SCENES), ['battle', 'town']);
    assert.deepEqual(mod.SHARE_ANIMS['fx-test-hit'], ['fx-test-hit-1', 'fx-test-hit-2', 'fx-test-hit-3']);
    assert.deepEqual(mod.SHARE_ANIMS['char-grid-idle'], ['char-grid-idle-1', 'char-grid-idle-2', 'char-grid-idle-3', 'char-grid-idle-4']);
    const heights = [1, 2, 3].map((i) => {
      const f = decodePng(Buffer.from(mod.SHARE_ASSETS[`fx-test-hit-${i}`].src.split(',')[1], 'base64'));
      let top = f.height;
      let bottom = -1;
      for (let y = 0; y < f.height; y += 1) for (let x = 0; x < f.width; x += 1) if (f.data[(y * f.width + x) * 4 + 3]) { top = Math.min(top, y); bottom = Math.max(bottom, y); }
      return bottom - top + 1;
    });
    assert.ok(heights[0] > heights[1] && heights[1] > heights[2], `shared scale keeps relative sizes, got ${heights}`);
    const png = decodePng(Buffer.from(a.src.split(',')[1], 'base64'));
    assert.equal(png.width, 192);
    const text = renderAssetModule(rows);
    assert.ok(!/\b(window|document|navigator)\b/.test(text), 'generated module stays free of browser globals');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('imageInfo reads PNG and animated WebP headers', () => {
  const png = encodePng({ width: 7, height: 5, data: new Uint8Array(7 * 5 * 4) });
  assert.deepEqual(imageInfo(png), { type: 'png', width: 7, height: 5, frames: 1 });
  const chunk = (tag, body) => {
    const head = Buffer.alloc(8);
    head.write(tag, 0, 'latin1');
    head.writeUInt32LE(body.length, 4);
    return Buffer.concat([head, body, Buffer.alloc(body.length & 1)]);
  };
  const vp8x = Buffer.alloc(10);
  vp8x[0] = 0x12;
  vp8x.writeUIntLE(191, 4, 3);
  vp8x.writeUIntLE(127, 7, 3);
  const body = Buffer.concat([chunk('VP8X', vp8x), chunk('ANIM', Buffer.alloc(6)), chunk('ANMF', Buffer.alloc(17)), chunk('ANMF', Buffer.alloc(16))]);
  const riff = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), body]);
  assert.deepEqual(imageInfo(riff), { type: 'webp', width: 192, height: 128, frames: 2 });
  assert.equal(imageInfo(Buffer.from('nope')), null);
});

test('catalog checks art-src against roster.json and reports gaps', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-cat-'));
  try {
    const roster = {
      grid: { sprite: [100, 100], idleCell: [192, 128], idleFrames: 1 },
      characters: [{ id: 'bard', name: '吟游诗人', stages: { mid: { idle: '试音' }, late: {} } }],
      arenas: ['windmill'],
    };
    writeFileSync(join(dir, 'roster.json'), JSON.stringify(roster));
    mkdirSync(join(dir, 'characters', 'bard'), { recursive: true });
    mkdirSync(join(dir, 'arenas'));
    const sprite = encodePng({ width: 100, height: 100, data: new Uint8Array(100 * 100 * 4) });
    writeFileSync(join(dir, 'characters', 'bard', 'mid.png'), sprite);
    writeFileSync(join(dir, 'characters', 'bard', 'late.png'), encodePng({ width: 90, height: 100, data: new Uint8Array(90 * 100 * 4) }));
    writeFileSync(join(dir, 'characters', 'bard', 'idle-mid.png'), sprite);
    writeFileSync(join(dir, 'arenas', 'windmill.webp'), Buffer.from('RIFF\0\0\0\0WEBPVP8 '));
    const { problems } = catalog({ srcDir: dir, log: () => {} });
    assert.ok(problems.includes('missing  characters/bard/idle-mid.webp'));
    assert.ok(problems.some((p) => p.startsWith('characters/bard/late.png: width 90 != 100')));
    assert.ok(problems.includes('unlisted characters/bard/idle-mid.png'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
