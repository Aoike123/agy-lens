#!/usr/bin/env node
// Share-card art tooling.
//
//   node scripts/share-art/build.mjs             check art-src/ against art-src/roster.json (default)
//   node scripts/share-art/build.mjs --shade     shade flat generator output in art-raw/inbox/ into art-out/
//   node scripts/share-art/build.mjs --shade --check   same, but do not write the web module
//
// Layout:
//   art-src/roster.json                       characters, stages, idle names, arenas, grid constants
//   art-src/characters/<id>/<stage>.png       100x100 sprites (starter-male, starter-female, mid, late)
//   art-src/characters/<id>/idle-<stage>.webp 192x128 transparent idle, 24 fps
//   art-src/characters/<id>/original-<stage>.webp  approved 512x512 source painting
//   art-src/arenas/<id>.webp                  1376x768 battle backgrounds
//   art-raw/   (gitignored) Flow MP4s, keyed clips, boards, obsolete files
//   art-review/(gitignored) review sheets and rejected candidates

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decodePng, encodePng } from './png.mjs';
import { PALETTE, shadeBackground, shadeLayer, shadeSprite, sliceGrid, spriteFitScale } from './shade.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Scenes are assembled in code from separately generated pieces, so every piece has a fixed
// native size. The battle scene and the town are both composed on a 400x210 canvas (x3 on export).
export const NAMED_SPECS = {
  // battle scene layers, back to front
  'layer-sky-day': { width: 400, height: 150, kind: 'background' },
  'layer-sky-sunset': { width: 400, height: 150, kind: 'background' },
  'layer-sky-night': { width: 400, height: 150, kind: 'background' },
  'layer-clouds': { width: 400, height: 60, kind: 'layer', anchor: 'top' },
  'layer-mountains': { width: 400, height: 70, kind: 'layer', anchor: 'bottom' },
  'layer-treeline': { width: 400, height: 36, kind: 'layer', anchor: 'bottom' },
  'layer-field': { width: 400, height: 120, kind: 'background', dither: false },
  'prop-platform-near': { width: 176, height: 44, kind: 'sprite', anchor: 'center', margin: 1 },
  'prop-platform-far': { width: 128, height: 32, kind: 'sprite', anchor: 'center', margin: 1 },
  // town props (tiles are 16x16, see prefix table)
  'prop-lab': { width: 144, height: 112, kind: 'sprite', anchor: 'bottom' },
  'prop-tree': { width: 40, height: 48, kind: 'sprite', anchor: 'bottom', margin: 1 },
  'prop-bush': { width: 32, height: 24, kind: 'sprite', anchor: 'bottom', margin: 1 },
  'prop-fence': { width: 48, height: 20, kind: 'sprite', anchor: 'bottom', margin: 1 },
  'prop-signboard': { width: 160, height: 96, kind: 'sprite', anchor: 'bottom' },
};

// Name prefix -> native size and treatment, for families of pieces. First match wins.
export const ASSET_SPECS = [
  [/^char-/, { width: 192, height: 128, kind: 'sprite', anchor: 'bottom' }],
  [/^walk-/, { width: 32, height: 48, kind: 'sprite', anchor: 'bottom' }],
  [/^portrait-/, { width: 128, height: 128, kind: 'sprite', anchor: 'bottom', margin: 1 }],
  [/^badge-/, { width: 24, height: 24, kind: 'sprite', anchor: 'center', margin: 1 }],
  [/^tile-/, { width: 16, height: 16, kind: 'background', dither: false }],
  [/^fx-vs-burst/, { width: 160, height: 160, kind: 'sprite', anchor: 'center', margin: 1, outline: false, lighting: false }],
  [/^fx-enter/, { width: 96, height: 96, kind: 'sprite', anchor: 'bottom', margin: 1, outline: false, lighting: false }],
  [/^fx-.+-skill/, { width: 96, height: 96, kind: 'sprite', anchor: 'center', margin: 1, outline: false, lighting: false }],
  [/^fx-/, { width: 48, height: 48, kind: 'sprite', anchor: 'center', margin: 1, outline: false, lighting: false }],
  [/^prop-/, { width: 160, height: 96, kind: 'sprite', anchor: 'bottom' }],
  [/^layer-/, { width: 400, height: 80, kind: 'layer', anchor: 'bottom' }],
  [/^bg-/, { width: 400, height: 210, kind: 'background' }],
];

// How the pieces are stitched together, on a 400x210 canvas. Back to front; x/y are top-left.
// `tile: true` repeats a piece horizontally; `drift` is the parallax speed (px/s) used by animation.
const TOWN_W = 25;
const TOWN_H = 14;
function townTiles() {
  const rows = [];
  for (let y = 0; y < TOWN_H; y += 1) {
    const row = [];
    for (let x = 0; x < TOWN_W; x += 1) {
      let t = (x * 7 + y * 13) % 5 === 0 ? 'tile-grass-alt' : 'tile-grass';
      if (x >= 4 && x <= 5 && y >= 8) t = 'tile-path';
      if (y >= 9 && y <= 10 && x >= 4) t = 'tile-path';
      if (x <= 2 && y >= 11) t = 'tile-tallgrass';
      if (x >= 8 && x <= 11 && y >= 12) t = 'tile-tallgrass';
      if ([[7, 6], [8, 7], [10, 6], [1, 7], [2, 8], [17, 12], [19, 13]].some(([fx, fy]) => fx === x && fy === y)) t = 'tile-flowers';
      row.push(t);
    }
    rows.push(row);
  }
  return rows;
}
export const SCENES = {
  battle: {
    width: 400,
    height: 210,
    layers: [
      { asset: 'layer-sky-day', x: 0, y: 0 },
      { asset: 'layer-clouds', x: 0, y: 6, tile: true, drift: 4 },
      { asset: 'layer-mountains', x: 0, y: 54, tile: true, drift: 0 },
      { asset: 'layer-treeline', x: 0, y: 90, tile: true, drift: 0 },
      { asset: 'layer-field', x: 0, y: 118 },
      { asset: 'prop-platform-far', x: 226, y: 80, slot: 'foe' },
      { asset: 'prop-platform-near', x: 18, y: 150, slot: 'me' },
    ],
  },
  town: {
    width: 400,
    height: 210,
    tileSize: 16,
    tiles: townTiles(),
    props: [
      ...Array.from({ length: 11 }, (_, i) => ({ asset: 'prop-tree', x: i * 38 - 8, y: -14 })),
      { asset: 'prop-tree', x: -14, y: 40 }, { asset: 'prop-tree', x: -14, y: 84 },
      { asset: 'prop-lab', x: 22, y: 20 },
      { asset: 'prop-fence', x: 128, y: 100 }, { asset: 'prop-fence', x: 176, y: 100 },
      { asset: 'prop-bush', x: 150, y: 70 }, { asset: 'prop-bush', x: 330, y: 176 },
      { asset: 'prop-signboard', x: 186, y: 40, only: 'challenge' },
    ],
    heroSlot: { x: 74, y: 104 },
  },
};

export function specFor(name) {
  if (NAMED_SPECS[name]) return NAMED_SPECS[name];
  const hit = ASSET_SPECS.find(([re]) => re.test(name));
  return hit ? hit[1] : null;
}

/** `char-alchemist-attack-3` -> `char-alchemist-attack`; single images map to themselves. */
export const sequenceOf = (name) => name.replace(/-\d+$/, '');

export function processImage(name, img, { scale = null } = {}) {
  const base = specFor(name);
  const spec = scale && base && base.kind === 'sprite' ? { ...base, scale } : base;
  if (!spec) throw new Error(`No spec for "${name}" (expected a char-, walk-, badge-, tile-, fx-, prop-, layer- or bg- prefix)`);
  if (spec.kind === 'background') return { spec, ...shadeBackground(img, spec) };
  if (spec.kind === 'layer') return { spec, ...shadeLayer(img, spec) };
  return { spec, ...shadeSprite(img, spec) };
}

export function renderAssetModule(assets) {
  const lines = [
    '// Generated by scripts/share-art/build.mjs from art-src/. Do not edit by hand.',
    '// Each entry is native-resolution pixel art; scale it with image-rendering: pixelated.',
    '',
    'export const SHARE_ASSETS = {',
  ];
  for (const a of assets) {
    lines.push(`  ${JSON.stringify(a.name)}: { w: ${a.width}, h: ${a.height}, src: 'data:image/png;base64,${a.base64}' },`);
  }
  const anims = {};
  for (const a of assets) if (/-\d+$/.test(a.name)) (anims[sequenceOf(a.name)] ||= []).push(a.name);
  for (const k of Object.keys(anims)) anims[k].sort((x, y) => Number(x.match(/(\d+)$/)[1]) - Number(y.match(/(\d+)$/)[1]));
  lines.push('};', '', `export const SHARE_ANIMS = ${JSON.stringify(anims)};`, '', `export const SHARE_SCENES = ${JSON.stringify(SCENES)};`, '');
  return lines.join('\n');
}

function compositeHtml(rows) {
  const have = new Set(rows.map((r) => r.name));
  const spec = Object.fromEntries(rows.map((r) => [r.name, r.spec]));
  const img = (name, x, y, extra = '') => (have.has(name)
    ? `<img src="${name}.png" style="position:absolute;left:${x * 3}px;top:${y * 3}px;width:${spec[name].width * 3}px;image-rendering:pixelated${extra}">`
    : '');
  const b = SCENES.battle;
  let battle = '';
  for (const L of b.layers) {
    if (!have.has(L.asset)) continue;
    const reps = L.tile ? Math.ceil(b.width / spec[L.asset].width) + 1 : 1;
    for (let i = 0; i < reps; i += 1) battle += img(L.asset, L.x + i * spec[L.asset].width, L.y);
  }
  for (const [slot, name, flip] of [['foe', 'char-berserker-idle', true], ['me', 'char-alchemist-idle', false]]) {
    const plat = b.layers.find((L) => L.slot === slot);
    if (!plat || !have.has(name) || !have.has(plat.asset)) continue;
    const ps = spec[plat.asset];
    battle += img(name, plat.x + ps.width / 2 - 48, plat.y + ps.height / 2 - 92, flip ? ';transform:scaleX(-1)' : '');
  }
  const t = SCENES.town;
  let town = '';
  t.tiles.forEach((row, y) => row.forEach((name, x) => { town += img(name, x * t.tileSize, y * t.tileSize); }));
  for (const p of t.props) town += img(p.asset, p.x, p.y);
  town += img('walk-alchemist', t.heroSlot.x, t.heroSlot.y);
  const frame = (title, body) => (body ? `<section><h2>${title}</h2><p>assembled from the pieces above, x3</p><div style="position:relative;width:1200px;height:630px;overflow:hidden;background:#222">${body}</div></section>` : '');
  return frame('Battle scene', battle) + frame('Town scene', town);
}

function previewHtml(rows, srcDir, outDir) {
  const swatches = PALETTE.map((c) => `<i style="background:rgb(${c.rgb.join(',')})" title="${c.rampId} ${c.step}"></i>`).join('');
  const items = rows.map((r) => {
    const zoom = r.spec.width >= 300 ? 2 : r.spec.width <= 32 ? 8 : 4;
    const srcRel = relative(outDir, join(srcDir, `${r.name}.png`)).split('\\').join('/');
    return `<section><h2>${r.name}</h2><p>${r.spec.width}×${r.spec.height} · ${r.colours} colours · ${(r.bytes / 1024).toFixed(1)} KB</p>
<div class="pair"><figure><img class="src" src="${srcRel}"><figcaption>generated</figcaption></figure>
<figure><img class="px" src="${r.name}.png" style="width:${r.spec.width * zoom}px"><figcaption>shaded ×${zoom}</figcaption></figure>
<figure class="${r.spec.kind === 'background' ? 'hide' : ''}"><img class="px dark" src="${r.name}.png" style="width:${r.spec.width * zoom}px"><figcaption>on dark</figcaption></figure></div></section>`;
  }).join('\n');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Share art preview</title><style>
body{margin:0;padding:24px;background:#eef0f3;font:14px system-ui,sans-serif;color:#1f2329}
h1{font-size:20px;margin:0 0 8px}h2{font-size:15px;margin:0}p{margin:2px 0 10px;color:#5f6368}
section{background:#fff;border-radius:10px;padding:16px;margin:0 0 16px}
.pair{display:flex;gap:16px;flex-wrap:wrap;align-items:flex-end}figure{margin:0}figcaption{font-size:12px;color:#80868b;margin-top:4px}
img.src{max-width:320px;max-height:320px;background:repeating-conic-gradient(#ddd 0 25%,#fff 0 50%) 0 0/16px 16px}
img.px{image-rendering:pixelated;background:repeating-conic-gradient(#ddd 0 25%,#fff 0 50%) 0 0/16px 16px;max-width:100%}
img.dark{background:#1d2340}.hide{display:none}
.pal{display:grid;grid-template-columns:repeat(${7},18px);grid-auto-flow:row;gap:2px;margin-bottom:16px}.pal i{width:18px;height:18px;border-radius:3px;display:block}
</style></head><body><h1>Share art preview</h1><p>Master palette (${PALETTE.length} colours, one ramp per row):</p><div class="pal">${swatches}</div>${compositeHtml(rows)}${items}</body></html>`;
}

export function run({ srcDir = join(ROOT, 'art-raw', 'inbox'), outDir = join(ROOT, 'art-out'), moduleOut = join(ROOT, 'sidecars', 'agy-lens', 'web', 'views', 'share-assets.js'), writeModule = true, log = console.log } = {}) {
  if (!existsSync(srcDir)) {
    log(`No ${relative(ROOT, srcDir) || srcDir}/ folder. Put flat generator PNGs there (see docs/share-art.md).`);
    return [];
  }
  const files = readdirSync(srcDir).filter((f) => extname(f).toLowerCase() === '.png').sort();
  if (!files.length) {
    log(`${relative(ROOT, srcDir) || srcDir}/ has no PNG files.`);
    return [];
  }
  mkdirSync(outDir, { recursive: true });
  // 1. Load, slicing sheets named `<sequence>@<N>.png` or `<sequence>@<C>x<R>.png` into `<sequence>-1 ... -N`.
  const entries = [];
  for (const f of files) {
    const stem = basename(f, extname(f));
    // `name@4` is a 4-frame strip, `name@2x2` a 2-column, 2-row grid (frames read row by row).
    const m = stem.match(/^(.+)@(\d+)(?:x(\d+))?$/);
    const name = m ? m[1] : stem;
    if (!specFor(m ? `${name}-1` : name)) {
      log(`skip  ${f}  (unknown prefix)`);
      continue;
    }
    try {
      const img = decodePng(readFileSync(join(srcDir, f)));
      if (m) sliceGrid(img, Number(m[2]), Number(m[3] || 1)).forEach((frame, i) => entries.push({ file: f, name: `${name}-${i + 1}`, img: frame }));
      else entries.push({ file: f, name, img });
    } catch (err) {
      log(`fail  ${f}  ${err.message}`);
    }
  }
  // 2. Frames of one sprite sequence share one scale, so the character keeps its size between poses.
  const groupScale = new Map();
  for (const e of entries) {
    const spec = specFor(e.name);
    if (spec.kind !== 'sprite' || !/-\d+$/.test(e.name)) continue;
    const s = spriteFitScale(e.img, spec);
    const key = sequenceOf(e.name);
    if (s && (!groupScale.has(key) || s < groupScale.get(key))) groupScale.set(key, s);
  }
  // 3. Shade.
  const rows = [];
  for (const e of entries) {
    try {
      const res = processImage(e.name, e.img, { scale: groupScale.get(sequenceOf(e.name)) || null });
      const png = encodePng(res.image);
      writeFileSync(join(outDir, `${e.name}.png`), png);
      rows.push({ name: e.name, spec: res.spec, colours: res.colours, bytes: png.length, width: res.image.width, height: res.image.height, base64: png.toString('base64') });
      const label = e.file === `${e.name}.png` ? e.file : `${e.file} [${e.name}]`;
      log(`ok    ${label}  ->  ${res.image.width}x${res.image.height}, ${res.colours} colours, ${(png.length / 1024).toFixed(1)} KB`);
    } catch (err) {
      log(`fail  ${e.file} [${e.name}]  ${err.message}`);
    }
  }
  writeFileSync(join(outDir, 'preview.html'), previewHtml(rows, srcDir, outDir));
  log(`preview: ${relative(ROOT, join(outDir, 'preview.html'))}`);
  if (writeModule && rows.length) {
    writeFileSync(moduleOut, renderAssetModule(rows));
    const total = rows.reduce((a, r) => a + r.bytes, 0);
    log(`module:  ${relative(ROOT, moduleOut)}  (${rows.length} assets, ${(total / 1024).toFixed(1)} KB of PNG)`);
  }
  return rows;
}

/* ---------------- catalog check (art-src/ vs roster.json) ---------------- */

/** Width, height and frame count of a PNG or WebP, read from the file header only. */
export function imageInfo(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { type: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), frames: 1 };
  }
  if (buf.length > 30 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    const kind = buf.toString('latin1', 12, 16);
    let width = 0;
    let height = 0;
    if (kind === 'VP8X') {
      width = buf.readUIntLE(24, 3) + 1;
      height = buf.readUIntLE(27, 3) + 1;
    } else if (kind === 'VP8 ') {
      width = buf.readUInt16LE(26) & 0x3fff;
      height = buf.readUInt16LE(28) & 0x3fff;
    } else if (kind === 'VP8L') {
      const bits = buf.readUInt32LE(21);
      width = (bits & 0x3fff) + 1;
      height = ((bits >> 14) & 0x3fff) + 1;
    }
    let frames = 0;
    for (let pos = 12; pos + 8 <= buf.length;) {
      const tag = buf.toString('latin1', pos, pos + 4);
      const len = buf.readUInt32LE(pos + 4);
      if (tag === 'ANMF') frames += 1;
      pos += 8 + len + (len & 1);
    }
    return { type: 'webp', width, height, frames: Math.max(1, frames) };
  }
  return null;
}

/** Check that every character stage, idle and arena named in roster.json exists with the agreed size. */
export function catalog({ srcDir = join(ROOT, 'art-src'), log = console.log } = {}) {
  const roster = JSON.parse(readFileSync(join(srcDir, 'roster.json'), 'utf8'));
  const [sw, sh] = roster.grid.sprite;
  const [iw, ih] = roster.grid.idleCell;
  const rows = [];
  const problems = [];
  const expect = (rel, want) => {
    const abs = join(srcDir, rel);
    if (!existsSync(abs)) { problems.push(`missing  ${rel}`); return; }
    const info = imageInfo(readFileSync(abs));
    if (!info) { problems.push(`unreadable ${rel}`); return; }
    const bad = Object.entries(want).filter(([k, v]) => info[k] !== v);
    if (bad.length) problems.push(`${rel}: ${bad.map(([k, v]) => `${k} ${info[k]} != ${v}`).join(', ')}`);
    rows.push({ rel, ...info });
  };
  for (const ch of roster.characters) {
    for (const [stage, meta] of Object.entries(ch.stages)) {
      expect(`characters/${ch.id}/${stage}.png`, { width: sw, height: sh });
      if (meta.idle) expect(`characters/${ch.id}/idle-${stage}.webp`, { width: iw, height: ih, frames: roster.grid.idleFrames });
    }
    const listed = new Set(Object.keys(ch.stages).flatMap((st) => [`${st}.png`, `idle-${st}.webp`, `original-${st}.webp`]));
    const folder = join(srcDir, 'characters', ch.id);
    if (existsSync(folder)) {
      for (const f of readdirSync(folder)) if (!listed.has(f)) problems.push(`unlisted characters/${ch.id}/${f}`);
    }
  }
  for (const id of roster.arenas) expect(`arenas/${id}.webp`, {});
  const known = new Set(roster.characters.map((c) => c.id));
  if (existsSync(join(srcDir, 'characters'))) {
    for (const d of readdirSync(join(srcDir, 'characters'))) if (!known.has(d)) problems.push(`characters/${d}/ is not in roster.json`);
  }
  const sprites = rows.filter((r) => r.type === 'png').length;
  const idles = rows.filter((r) => r.frames > 1).length;
  log(`${roster.characters.length} characters, ${sprites} sprites, ${idles} idles, ${roster.arenas.length} arenas checked`);
  for (const p of problems) log(`  ${p}`);
  log(problems.length ? `${problems.length} problem(s)` : 'ok');
  return { rows, problems };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes('--shade')) run({ writeModule: !process.argv.includes('--check') });
  else process.exitCode = catalog().problems.length ? 1 : 0;
}
