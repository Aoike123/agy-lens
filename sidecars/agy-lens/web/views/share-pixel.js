// Pixel share cards: role card, PK challenge and battle scene / result.
//
// Pixel-art rules this module enforces:
//  - one native canvas of 400x210, written out at exactly 3x (1200x630); every image and every
//    UI pixel lands on that grid, so there are no mixed pixel sizes;
//  - UI is drawn into an indexed framebuffer with solid palette colours: no anti-aliasing, no
//    alpha, no vector strokes; translucency is a checkerboard dither;
//  - text uses the bundled 12px bitmap font (Fusion Pixel, OFL) and a 5x7 digit face; large
//    titles are the 12px glyphs upscaled with Scale2x (EPX) + metallic bevel shading at native resolution;
//  - images are embedded as data URIs (arena 400x210, sprites 192x128 cells) and rendered with
//    nearest-neighbour sampling.
// Pure string builders: no DOM, safe in Node.

import { createTranslator, normalizeLang } from '../i18n.js';
import { ACHIEVEMENTS, SPRITE_CELL, STAT_KEYS, USAGE_ACHIEVEMENTS } from './share-game.js';
import { PIXEL_FONT_ASCENT, PIXEL_FONT_DATA } from './share-font.js';
import { BADGE_SIZE, badgePixel } from './share-badges.js';
import {
  DEFAULT_MATERIAL, MATERIALS, drawFiligreeDivider, drawFrame, drawPixelSprite, drawPlaque,
  drawRelicSocket, drawRibbonPlate, inkFor, materialFor,
} from './share-frames.js';
import { renderStaticAmbientSvg } from './share-vfx.js';

export const NATIVE_W = 400;
export const NATIVE_H = 210;
export const SCALE = 3;
export const PIXEL_W = NATIVE_W * SCALE;
export const PIXEL_H = NATIVE_H * SCALE;
export const FLOOR_Y = 188;

const PAL = {
  ink: '#120f1f',
  panel: '#1c2340',
  panelHi: '#27305a',
  rimLight: '#e9dfc0',
  rimMid: '#a39cba',
  rimDark: '#4b4f73',
  text: '#f6efd9',
  sub: '#aab3cf',
  dim: '#6f789a',
  gold: '#f6c453',
  goldHi: '#fff6c4',
  goldDark: '#b5791f',
  track: '#0b0e1c',
  paper: '#ecdcb4',
  paperLight: '#f8eed2',
  paperDark: '#cbb486',
  paperInk: '#3b2414',
  paperSub: '#7a5a34',
  wood: '#7a4a26',
  woodDark: '#3e2412',
  woodLight: '#a8703c',
  blue: '#4aa3ff',
  red: '#ff6a5a',
};

export const STAT_RAMPS = {
  POW: ['#8a2418', '#e8553c', '#ffa286'],
  INT: ['#1a5a96', '#3a9ff0', '#a6dcff'],
  STA: ['#8a4a06', '#f08a00', '#ffc878'],
  WIS: ['#47309a', '#8a6cf0', '#cdbcff'],
  CMB: ['#11603f', '#22b07a', '#86ecbf'],
  ELO: ['#8a2454', '#e85a9a', '#ffb3d4'],
};

const RARITY_RAMPS = {
  N: ['#4a5268', '#8a93ab', '#d0d8e8'],
  R: ['#1a5488', '#4fa3e0', '#a8e0ff'],
  SR: ['#4e268c', '#a46cf0', '#dec4ff'],
  SSR: ['#8c540a', '#e0a020', '#ffe88a'],
  UR: ['#8c1c3c', '#e84870', '#ffb8ca'],
};

// Hand-placed 7x7 pixel stat icons.
const STAT_ICONS = {
  POW: [
    '....ooo',
    '...oHMo',
    '..oHMo.',
    '.oDMo..',
    'oGGo...',
    'oKo....',
    'ooo....',
  ],
  INT: [
    '..ooo..',
    '..oGo..',
    '.oHMo..',
    'oHMMDo.',
    'oMMMDo.',
    'oDDDDo.',
    '.oooo..',
  ],
  STA: [
    '.ooooo.',
    'oHHMMMo',
    'oHMMGDo',
    'oMMGGDo',
    '.oMDDo.',
    '..oDo..',
    '...o...',
  ],
  WIS: [
    '...o...',
    '..oHo..',
    '.oHMo..',
    'oHMMMDo',
    '.oMDo..',
    '..oDo..',
    '...o...',
  ],
  CMB: [
    '...ooo.',
    '..oHHo.',
    '.oHMoo.',
    'oHMMDo.',
    '.ooMDo.',
    '..oDo..',
    '..oo...',
  ],
  ELO: [
    '....ooo',
    '...oHHo',
    '..oHMo.',
    '.oHMDo.',
    '.oGGo..',
    'oGo....',
    'oo.....',
  ],
};

const CROWN_SPRITE = [
  'o..o..o',
  'G.oGo.G',
  'GHGGGHG',
  'ooooooo',
];

function escapeXml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// --- framebuffer ---------------------------------------------------------------------------

export class Pix {
  constructor(w = NATIVE_W, h = NATIVE_H) {
    this.w = w;
    this.h = h;
    this.c = new Array(w * h).fill(null);
  }

  set(x, y, col) {
    const X = Math.round(x);
    const Y = Math.round(y);
    if (col && X >= 0 && Y >= 0 && X < this.w && Y < this.h) this.c[Y * this.w + X] = col;
  }

  get(x, y) {
    return x >= 0 && y >= 0 && x < this.w && y < this.h ? this.c[y * this.w + x] : null;
  }

  rect(x, y, w, h, col) {
    for (let j = 0; j < h; j += 1) for (let i = 0; i < w; i += 1) this.set(x + i, y + j, col);
  }

  hline(x, y, w, col) { this.rect(x, y, w, 1, col); }

  vline(x, y, h, col) { this.rect(x, y, 1, h, col); }

  /** Bresenham line. */
  line(ax, ay, bx, by, col) {
    let x0 = Math.round(ax);
    let y0 = Math.round(ay);
    const x1 = Math.round(bx);
    const y1 = Math.round(by);
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      this.set(x0, y0, col);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }

  /** SVG paths, one per colour, horizontal runs, scaled to the output grid. */
  toSvg(scale = SCALE, extraAttrs = '') {
    const byCol = new Map();
    for (let y = 0; y < this.h; y += 1) {
      let x = 0;
      while (x < this.w) {
        const col = this.c[y * this.w + x];
        if (!col) { x += 1; continue; }
        let end = x + 1;
        while (end < this.w && this.c[y * this.w + end] === col) end += 1;
        const prev = byCol.get(col) || '';
        byCol.set(col, `${prev}M${x * scale} ${y * scale}h${(end - x) * scale}v${scale}h-${(end - x) * scale}z`);
        x = end;
      }
    }
    return [...byCol.entries()].map(([col, d]) => `<path d="${d}" fill="${col}"${extraAttrs}/>`).join('');
  }
}

// --- bitmap font ---------------------------------------------------------------------------

let FONT = null;
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function b64bytes(s) {
  const out = [];
  let acc = 0;
  let bits = 0;
  for (const ch of s) {
    const v = B64.indexOf(ch);
    if (v < 0) continue;
    acc = ((acc << 6) | v) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 255);
    }
  }
  return out;
}

function font() {
  if (FONT) return FONT;
  const bytes = b64bytes(PIXEL_FONT_DATA);
  const map = new Map();
  let i = 0;
  while (i + 8 <= bytes.length) {
    const cp = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    const adv = bytes[i + 3];
    const w = bytes[i + 4];
    const h = bytes[i + 5];
    const x = bytes[i + 6] - 8;
    const y = bytes[i + 7] - 8;
    i += 8;
    const rb = Math.ceil(w / 8);
    const rows = [];
    for (let r = 0; r < h; r += 1) {
      let v = 0;
      for (let k = 0; k < rb; k += 1) v = (v * 256) + bytes[i + k];
      rows.push(v);
      i += rb;
    }
    map.set(cp, { adv, w, h, x, y, rb, rows });
  }
  if (!map.has(0x2248)) map.set(0x2248, { adv: 8, w: 7, h: 5, x: 0, y: 2, rb: 1, rows: [0x64, 0x98, 0x00, 0x64, 0x98] });
  FONT = map;
  return FONT;
}

const GLYPH_FALLBACK = { 0x2248: 0x7e, 0x2192: 0x3e, 0x2190: 0x3c, 0x2265: 0x3e, 0x2264: 0x3c };

function glyph(cp) {
  const f = font();
  return f.get(cp) || f.get(GLYPH_FALLBACK[cp]) || f.get(0x3f);
}

export function hasGlyph(ch) {
  return font().has(String(ch).codePointAt(0));
}

export function textWidth(str) {
  let w = 0;
  for (const ch of String(str)) w += glyph(ch.codePointAt(0)).adv;
  return w;
}

/** Draw 12px text with its baseline at `by`; returns the advance. */
export function drawText(pix, str, x, by, col, { shadow = null, outline = null } = {}) {
  const s = String(str);
  if (outline) {
    for (const [ox, oy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]]) drawText(pix, s, x + ox, by + oy, outline);
  } else if (shadow) {
    drawText(pix, s, x + 1, by + 1, shadow);
  }
  let cx = x;
  for (const ch of s) {
    const g = glyph(ch.codePointAt(0));
    const top = by - g.y - g.h;
    for (let r = 0; r < g.h; r += 1) {
      const row = g.rows[r];
      for (let c = 0; c < g.w; c += 1) {
        if (Math.floor(row / 2 ** (g.rb * 8 - 1 - c)) % 2 === 1) pix.set(cx + g.x + c, top + r, col);
      }
    }
    cx += g.adv;
  }
  return cx - x;
}

export function drawTextRight(pix, str, right, by, col, opts) {
  return drawText(pix, str, right - textWidth(str), by, col, opts);
}

/** Horizontal ink bounds of `str`, excluding leading/trailing advance whitespace. */
export function textInkX(str) {
  let cx = 0;
  let minX = Infinity;
  let maxX = -Infinity;
  for (const ch of String(str)) {
    const g = glyph(ch.codePointAt(0));
    let gMin = Infinity;
    let gMax = -Infinity;
    for (let r = 0; r < g.h; r += 1) {
      const row = g.rows[r];
      if (!row) continue;
      for (let c = 0; c < g.w; c += 1) {
        if (Math.floor(row / 2 ** (g.rb * 8 - 1 - c)) % 2 === 1) {
          if (c < gMin) gMin = c;
          if (c > gMax) gMax = c;
        }
      }
    }
    if (gMax >= gMin) {
      if (cx + g.x + gMin < minX) minX = cx + g.x + gMin;
      if (cx + g.x + gMax > maxX) maxX = cx + g.x + gMax;
    }
    cx += g.adv;
  }
  if (maxX < minX) return { minX: 0, maxX: -1, inkW: 0 };
  return { minX, maxX, inkW: maxX - minX + 1 };
}

/** Baseline Y that centers 12px Fusion Pixel text (optical center `by - 5`) inside `[boxY..boxY+boxH-1]`. */
export function centerBaseline(boxY, boxH) {
  return boxY + Math.floor((boxH - 1) / 2) + 5;
}

export function drawTextCenter(pix, str, cx, by, col, opts) {
  const { minX, maxX, inkW } = textInkX(str);
  const x = inkW ? Math.round(cx - (minX + maxX + 1) / 2) : Math.round(cx);
  return drawText(pix, str, x, by, col, opts);
}

/** Greedy wrap: CJK breaks anywhere, Latin at spaces. */
export function wrapText(str, maxW) {
  if (String(str).includes('\n')) return String(str).split('\n').flatMap((part) => wrapText(part, maxW));
  const lines = [];
  let cur = '';
  const tokens = String(str).match(/[⺀-鿿＀-￯]|[^\s⺀-鿿＀-￯]+|\s+/g) || [];
  for (const tok of tokens) {
    const next = cur + tok;
    if (textWidth(next.trimEnd()) <= maxW || !cur.trim()) cur = next;
    else { lines.push(cur.trimEnd()); cur = tok.trimStart(); }
  }
  if (cur.trim()) lines.push(cur.trimEnd());
  return lines;
}

/** Clip a string to `maxW` pixels with an ellipsis. */
export function fitText(str, maxW) {
  const s = String(str);
  if (textWidth(s) <= maxW) return s;
  const chars = [...s];
  while (chars.length && textWidth(`${chars.join('')}…`) > maxW) chars.pop();
  return `${chars.join('')}…`;
}

function rasterizeBigText(str, bold = true) {
  const w = textWidth(str);
  const m = new Pix(w + 2, 16);
  drawText(m, str, 1, PIXEL_FONT_ASCENT, '#000');
  const at = (X, Y) => (m.get(X, Y) ? 1 : 0);
  const W2 = m.w * 2 + (bold ? 1 : 0);
  const H2 = m.h * 2;
  const raw = new Uint8Array(W2 * H2);
  for (let Y = 0; Y < m.h; Y += 1) {
    for (let X = 0; X < m.w; X += 1) {
      const P = at(X, Y);
      const A = at(X, Y - 1);
      const B = at(X + 1, Y);
      const C = at(X - 1, Y);
      const D = at(X, Y + 1);
      let p1 = P;
      let p2 = P;
      let p3 = P;
      let p4 = P;
      if (C === A && C !== D && A !== B) p1 = A;
      if (A === B && A !== C && B !== D) p2 = B;
      if (D === C && D !== B && C !== A) p3 = C;
      if (B === D && B !== A && D !== C) p4 = D;
      raw[(Y * 2) * W2 + X * 2] = p1;
      raw[(Y * 2) * W2 + X * 2 + 1] = p2;
      raw[(Y * 2 + 1) * W2 + X * 2] = p3;
      raw[(Y * 2 + 1) * W2 + X * 2 + 1] = p4;
    }
  }
  const big = new Uint8Array(W2 * H2);
  let minY = H2;
  let maxY = -1;
  let minX = W2;
  let maxX = -1;
  for (let Y = 0; Y < H2; Y += 1) {
    for (let X = 0; X < W2; X += 1) {
      const v = raw[Y * W2 + X] || (bold && X > 0 ? raw[Y * W2 + X - 1] : 0);
      big[Y * W2 + X] = v;
      if (v) {
        if (Y < minY) minY = Y;
        if (Y > maxY) maxY = Y;
        if (X < minX) minX = X;
        if (X > maxX) maxX = X;
      }
    }
  }
  return { w, W2, H2, big, minX, maxX, minY, maxY };
}

function paintBigText(pix, rast, ox, top, col, { hi = null, low = null, outline = PAL.ink, shadow = null } = {}) {
  const { W2, H2, big, minY, maxY } = rast;
  if (minY > maxY) return { x: ox, w: 0, h: 0 };
  const oy = top - minY;
  const on = (X, Y) => X >= 0 && Y >= 0 && X < W2 && Y < H2 && big[Y * W2 + X] === 1;
  if (shadow) {
    for (let Y = 0; Y < H2; Y += 1) {
      for (let X = 0; X < W2; X += 1) if (on(X, Y)) pix.set(ox + X + 2, oy + Y + 2, shadow);
    }
  }
  if (outline) {
    for (let Y = -1; Y <= H2; Y += 1) {
      for (let X = -1; X <= W2; X += 1) {
        if (on(X, Y)) continue;
        let near = false;
        for (let j = -1; j <= 1 && !near; j += 1) for (let i = -1; i <= 1; i += 1) if (on(X + i, Y + j)) { near = true; break; }
        if (near) pix.set(ox + X, oy + Y, outline);
      }
    }
  }
  const span = Math.max(1, maxY - minY + 1);
  const topBand = minY + Math.round(span * 0.25);
  const botBand = minY + Math.round(span * 0.62);
  for (let Y = 0; Y < H2; Y += 1) {
    for (let X = 0; X < W2; X += 1) {
      if (!big[Y * W2 + X]) continue;
      const c = (hi && Y < topBand) ? hi : (low && Y >= botBand) ? low : col;
      pix.set(ox + X, oy + Y, c);
    }
  }
  return { x: ox + rast.minX, w: rast.maxX - rast.minX + 1, h: span };
}

/**
 * Sculpted arcade display text: 12px glyphs upscaled with Scale2x (EPX), horizontally thickened
 * (`bold`), 3-band metallic shading (`hi` / `col` / `low`), crisp 1px outline and optional drop shadow.
 */
export function drawBigText(pix, str, x, top, col, opts = {}) {
  const bold = opts.bold !== undefined ? opts.bold : true;
  const rast = rasterizeBigText(str, bold);
  if (rast.minY > rast.maxY) return { w: 0, h: 0 };
  const res = paintBigText(pix, rast, x - 2, top, col, opts);
  return { w: rast.w * 2 + (bold ? 1 : 0), h: res.h };
}

/** Center EPX-upscaled display text cleanly around `cx` using its actual inked horizontal bounds. */
export function drawBigTextCenter(pix, str, cx, top, col, opts = {}) {
  const bold = opts.bold !== undefined ? opts.bold : true;
  const rast = rasterizeBigText(str, bold);
  if (rast.minY > rast.maxY) return { x: Math.round(cx), w: 0, h: 0 };
  const ox = Math.round(cx - (rast.minX + rast.maxX + 1) / 2);
  return paintBigText(pix, rast, ox, top, col, opts);
}

export function bigTextWidth(str) {
  return textWidth(str) * 2;
}

// 5x7 face for compact digits / tags.
const TINY = {
  0: '.###.|#...#|#..##|#.#.#|##..#|#...#|.###.', 1: '..#..|.##..|..#..|..#..|..#..|..#..|.###.',
  2: '.###.|#...#|....#|...#.|..#..|.#...|#####', 3: '#####|...#.|..#..|...#.|....#|#...#|.###.',
  4: '...#.|..##.|.#.#.|#..#.|#####|...#.|...#.', 5: '#####|#....|####.|....#|....#|#...#|.###.',
  6: '..##.|.#...|#....|####.|#...#|#...#|.###.', 7: '#####|....#|...#.|..#..|.#...|.#...|.#...',
  8: '.###.|#...#|#...#|.###.|#...#|#...#|.###.', 9: '.###.|#...#|#...#|.####|....#|...#.|.##..',
  A: '.###.|#...#|#...#|#####|#...#|#...#|#...#', B: '####.|#...#|#...#|####.|#...#|#...#|####.',
  C: '.###.|#...#|#....|#....|#....|#...#|.###.', E: '#####|#....|#....|####.|#....|#....|#####',
  G: '.###.|#...#|#....|#.###|#...#|#...#|.####', I: '.###.|..#..|..#..|..#..|..#..|..#..|.###.',
  K: '#...#|#..#.|#.#..|##...|#.#..|#..#.|#...#', L: '#....|#....|#....|#....|#....|#....|#####',
  M: '#...#|##.##|#.#.#|#.#.#|#...#|#...#|#...#', N: '#...#|#...#|##..#|#.#.#|#..##|#...#|#...#',
  O: '.###.|#...#|#...#|#...#|#...#|#...#|.###.', P: '####.|#...#|#...#|####.|#....|#....|#....',
  R: '####.|#...#|#...#|####.|#.#..|#..#.|#...#', S: '.####|#....|#....|.###.|....#|....#|####.',
  T: '#####|..#..|..#..|..#..|..#..|..#..|..#..', V: '#...#|#...#|#...#|#...#|#...#|.#.#.|..#..',
  W: '#...#|#...#|#...#|#.#.#|#.#.#|#.#.#|.#.#.', X: '#...#|#...#|.#.#.|..#..|.#.#.|#...#|#...#',
  Y: '#...#|#...#|.#.#.|..#..|..#..|..#..|..#..', ' ': '.....|.....|.....|.....|.....|.....|.....',
  '/': '.....|....#|...#.|..#..|.#...|#....|.....', ':': '.....|.##..|.##..|.....|.##..|.##..|.....',
  '<': '...#.|..#..|.#...|#....|.#...|..#..|...#.', '>': '.#...|..#..|...#.|....#|...#.|..#..|.#...',
  '=': '.....|.....|#####|.....|#####|.....|.....', '-': '.....|.....|.....|#####|.....|.....|.....',
  '%': '##..#|##..#|...#.|..#..|.#...|#..##|#..##',
  D: '####.|#...#|#...#|#...#|#...#|#...#|####.', F: '#####|#....|#....|####.|#....|#....|#....',
  H: '#...#|#...#|#...#|#####|#...#|#...#|#...#', U: '#...#|#...#|#...#|#...#|#...#|#...#|.###.',
  '+': '.....|..#..|..#..|#####|..#..|..#..|.....', '.': '.....|.....|.....|.....|.....|.##..|.##..',
};

export function tinyWidth(str) {
  const n = [...String(str)].length;
  return n ? n * 6 - 1 : 0;
}

export function drawTiny(pix, str, x, top, col, { outline = null } = {}) {
  const s = String(str).toUpperCase();
  if (outline) for (const [ox, oy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) drawTiny(pix, s, x + ox, top + oy, outline);
  [...s].forEach((ch, i) => {
    const g = TINY[ch];
    if (!g) return;
    g.split('|').forEach((row, r) => {
      for (let c = 0; c < 5; c += 1) if (row[c] === '#') pix.set(x + i * 6 + c, top + r, col);
    });
  });
  return tinyWidth(s);
}

// --- UI parts ------------------------------------------------------------------------------

/** Window: ink outline with cut corners, light rim top-left, mid rim bottom-right, dark inner rim. */
export function drawWindow(pix, x, y, w, h, { fill = PAL.panel } = {}) {
  pix.hline(x + 1, y, w - 2, PAL.ink);
  pix.hline(x + 1, y + h - 1, w - 2, PAL.ink);
  pix.vline(x, y + 1, h - 2, PAL.ink);
  pix.vline(x + w - 1, y + 1, h - 2, PAL.ink);
  pix.hline(x + 1, y + 1, w - 2, PAL.rimLight);
  pix.vline(x + 1, y + 1, h - 2, PAL.rimLight);
  pix.hline(x + 2, y + h - 2, w - 3, PAL.rimMid);
  pix.vline(x + w - 2, y + 2, h - 3, PAL.rimMid);
  pix.rect(x + 2, y + 2, w - 4, h - 4, PAL.rimDark);
  pix.rect(x + 3, y + 3, w - 6, h - 6, fill);
  pix.hline(x + 3, y + 3, w - 6, PAL.panelHi);
}

/** Tactile pixel glass-tube gauge with metallic end caps, specular top row, and white-hot leading tip. */
export function drawGauge(pix, x, y, w, h, frac, ramp, frameCol = PAL.ink) {
  pix.rect(x, y, w, h, frameCol);
  pix.rect(x + 1, y + 1, w - 2, h - 2, PAL.track);
  pix.hline(x + 1, y + 1, w - 2, '#171c34'); // subtle glass top reflection on empty track
  const inner = w - 2;
  const on = Math.round(Math.max(0, Math.min(1, frac)) * inner);
  if (on > 0) {
    pix.rect(x + 1, y + 1, on, h - 2, ramp[1]);
    pix.hline(x + 1, y + 1, on, ramp[2]);
    if (h > 4) pix.hline(x + 1, y + h - 2, on, ramp[0]);
    pix.vline(x + on, y + 1, h - 2, '#ffffff');
    pix.set(x + 1, y + 1, '#ffffff');
  }
  for (let i = 6; i < inner; i += 6) pix.vline(x + 1 + i, y + 1, h - 2, PAL.ink);
  // Metallic cap dots
  pix.vline(x, y + 1, h - 2, '#4b4f73');
  pix.vline(x + w - 1, y + 1, h - 2, '#4b4f73');
}

function drawTag(pix, x, y, text, ramp) {
  const [dark, fill, hi] = ramp;
  const { minX, inkW } = textInkX(text);
  const w = Math.max(12, inkW + 8);
  pix.rect(x, y, w, 16, PAL.ink);
  pix.rect(x + 1, y + 1, w - 2, 14, fill);
  pix.hline(x + 1, y + 1, w - 2, hi);
  pix.hline(x + 1, y + 14, w - 2, dark);
  drawText(pix, text, x + 5 - minX, y + 13, dark);
  drawText(pix, text, x + 4 - minX, y + 12, '#ffffff');
  return w;
}

function drawRarityMedallion(pix, x, y, rarity) {
  const ramp = RARITY_RAMPS[rarity] || RARITY_RAMPS.N;
  const [dark, fill, hi] = ramp;
  const { minX, maxX, inkW } = textInkX(rarity);
  const w = Math.max(22, inkW + 10);
  if (rarity === 'UR' || rarity === 'SSR') {
    drawPixelSprite(pix, CROWN_SPRITE, { o: PAL.ink, G: PAL.gold, H: PAL.goldHi }, Math.round(x + (w - 7) / 2), y - 3);
  }
  pix.hline(x + 1, y, w - 2, PAL.ink);
  pix.hline(x + 1, y + 14, w - 2, PAL.ink);
  pix.vline(x, y + 1, 13, PAL.ink);
  pix.vline(x + w - 1, y + 1, 13, PAL.ink);
  pix.rect(x + 1, y + 1, w - 2, 13, fill);
  pix.hline(x + 1, y + 1, w - 2, hi);
  pix.vline(x + 1, y + 1, 12, hi);
  pix.hline(x + 2, y + 13, w - 3, dark);
  pix.set(x + 2, y + 2, '#ffffff');
  const tx = Math.round(x + w / 2 - (minX + maxX + 1) / 2);
  drawText(pix, rarity, tx + 1, y + 13, dark);
  drawText(pix, rarity, tx, y + 12, '#ffffff');
  return w;
}

export function drawBadge(pix, id, x, y, locked = false) {
  for (let j = 0; j < BADGE_SIZE; j += 1) {
    for (let i = 0; i < BADGE_SIZE; i += 1) {
      const col = badgePixel(id, i, j, locked);
      if (col) pix.set(x + i, y + j, col);
    }
  }
}

const FIGHTER_FOOT = {
  alchemist: { dx: -6, rx: 25 },
  bard: { dx: 0, rx: 24 },
  berserker: { dx: -11, rx: 29 },
  clockmaker: { dx: -4, rx: 26 },
  dancer: { dx: -3, rx: 20, mid: { dx: -2, rx: 13 } },
  diver: { dx: -1, rx: 22 },
  glassblower: { dx: -6, rx: 23 },
  kite: { dx: -5, rx: 25 },
  knight: { dx: -6, rx: 26 },
  mage: { dx: -6, rx: 29 },
  monk: { dx: -16, rx: 38 },
  novice: { dx: -5, rx: 28 },
  surveyor: { dx: -3, rx: 22 },
};

/** Resolve ground shadow center and half-width aligned to each sprite's actual boot span. */
export function footShadowAnchor(fighter, cx, mirror = false) {
  const entry = FIGHTER_FOOT[fighter && fighter.classId] || { dx: -5, rx: 24 };
  const spec = fighter && fighter.stage === 'mid' && entry.mid ? entry.mid : entry;
  return { cx: Math.round(cx + (mirror ? -spec.dx : spec.dx)), rx: spec.rx };
}

/** Smooth 3-step pixel-art contact ellipse layers on the native grid. */
export function footShadowSteps(cx, floor = FLOOR_Y, rx = 24) {
  const fillEllipse = (p, rxVal, maxDy, col) => {
    const rad = Math.max(4, Math.round(rxVal));
    for (let j = -maxDy; j <= maxDy; j += 1) {
      const half = Math.round(rad * Math.sqrt(1 - (j / (maxDy + 1)) ** 2));
      for (let i = -half; i <= half; i += 1) p.set(cx + i, floor + j, col);
    }
  };
  const outer = new Pix();
  fillEllipse(outer, rx, 2, '#090714');
  const core = new Pix();
  fillEllipse(core, rx * 0.74, 1, '#090714');
  const contact = new Pix();
  fillEllipse(contact, rx * 0.54, 0, '#090714');
  return [
    { pix: outer, alpha: 0.26 },
    { pix: core, alpha: 0.34 },
    { pix: contact, alpha: 0.24 },
  ];
}

function footShadowSvg(cx, floor, rx = 24) {
  const body = footShadowSteps(cx, floor, rx)
    .map(({ pix, alpha }) => pix.toSvg(SCALE, ` fill-opacity="${alpha}"`))
    .join('');
  return `<g>${body}</g>`;
}

function brand(pix) {
  drawTiny(pix, 'AGY LENS', 5, NATIVE_H - 10, PAL.text, { outline: PAL.ink });
}

// --- SVG assembly --------------------------------------------------------------------------

const PIX_ATTR = 'image-rendering="pixelated" style="image-rendering:pixelated"';

function imageTag(uri, x, y, w, h, { attrs = '' } = {}) {
  if (!uri) return '';
  return `<image${attrs} href="${escapeXml(uri)}" x="${x * SCALE}" y="${y * SCALE}" width="${w * SCALE}" height="${h * SCALE}" preserveAspectRatio="none" ${PIX_ATTR}/>`;
}

/** Native placement of a fighter cell so its feet land on `floor` at body centre `cx`. */
export function spriteBox(cx, floor = FLOOR_Y) {
  return { x: cx - SPRITE_CELL.w / 2, y: floor - SPRITE_CELL.baseline, w: SPRITE_CELL.w, h: SPRITE_CELL.h };
}

export function placeholderSpritePix(cx) {
  const p = new Pix();
  p.rect(cx - 10, FLOOR_Y - 76, 20, 76, '#2a3050');
  p.rect(cx - 6, FLOOR_Y - 90, 12, 12, '#2a3050');
  return p;
}

function spriteLayer(uri, cx) {
  const b = spriteBox(cx);
  const img = uri ? imageTag(uri, b.x, b.y, b.w, b.h, { attrs: ' data-sprite="1"' }) : `<g data-sprite="1">${placeholderSpritePix(cx).toSvg()}</g>`;
  return img;
}

function svgDoc(aria, parts, isLight = false) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${PIXEL_W}" height="${PIXEL_H}" viewBox="0 0 ${PIXEL_W} ${PIXEL_H}" shape-rendering="crispEdges" role="img" aria-label="${escapeXml(aria)}"><rect width="${PIXEL_W}" height="${PIXEL_H}" fill="${isLight ? '#d8e5f2' : '#141828'}"/>${parts.join('')}</svg>`;
}

const nickOf = (p, t) => (p && p.nickname ? p.nickname : t('shareDefaultNick'));
const className = (p, t) => t('shareClassNames')[p.classId] || p.classId;

function metaLine(p, t) {
  const periodName = (t('periods') || {})[p.period] || p.period;
  return [p.tier ? t('shareTierPlan', p.tier) : '', periodName].filter(Boolean).join(' · ');
}

/** Featured achievements: unlocked usage achievements (hardest first), padded with locked. */
export function featuredAchievements(achievements, n = 4) {
  const order = [...USAGE_ACHIEVEMENTS].reverse();
  const on = order.filter((id) => achievements[id]);
  const off = ACHIEVEMENTS.filter((id) => !achievements[id]);
  return [...on.slice(0, n).map((id) => ({ id, on: true })), ...off.slice(0, Math.max(0, n - on.length)).map((id) => ({ id, on: false }))];
}

// --- role card -----------------------------------------------------------------------------

/** Shared native-grid role card UI & shadow layout used by both static SVG and animated GIF export. */
export function buildRoleCardLayout({ profile, achievements = {}, lang = 'en', arena = DEFAULT_MATERIAL, theme = 'dark' } = {}) {
  const t = createTranslator(normalizeLang(lang));
  const p = profile;
  const isLight = theme === 'light';
  const mat = materialFor(arena, isLight ? 'light' : 'dark');
  const ink = inkFor(mat);
  const ui = new Pix();
  const heroX = 94;
  const foot = footShadowAnchor(p, heroX, false);
  const shadowSteps = footShadowSteps(foot.cx, FLOOR_Y, foot.rx);

  const rarityRamp = RARITY_RAMPS[p.rarity] || RARITY_RAMPS.N;

  // Compact top-left Level & Sculpted Rarity Crest with glass EXP tube.
  const lv = drawRibbonPlate(ui, mat, 6, 6, 108, 36, { accent: rarityRamp[1] });
  drawTiny(ui, 'LV', lv.x + 5, lv.y + 14, ink.sub);
  drawBigText(ui, String(p.level), lv.x + 19, lv.y + 3, PAL.gold, { hi: PAL.goldHi, low: PAL.goldDark, outline: mat.ramp[0] });
  const medW = Math.max(22, textInkX(p.rarity).inkW + 10);
  drawRarityMedallion(ui, lv.x + lv.w - medW - 4, lv.y + 4, p.rarity);
  drawGauge(ui, lv.x + 5, lv.y + lv.h - 6, lv.w - 10, 5, p.exp.progress, ['#1a5a96', '#3a9ff0', '#a6dcff'], mat.ramp[0]);

  // Right Guild Dossier panel (narrowed so the arena & hero breathe).
  const box = drawFrame(ui, mat, 184, 6, 210, 198);
  const L = box.x + 4;
  const R = box.x + box.w - 4;
  const clsLabel = className(p, t);
  const tagW = Math.max(12, textInkX(clsLabel).inkW + 8);
  const maxNickW = Math.max(40, (R - L) - 4 - tagW);
  const nick = fitText(nickOf(p, t), maxNickW);
  const nw = drawText(ui, nick, L, box.y + 13, ink.text, { shadow: isLight ? '#fbf4e2' : mat.ramp[0] });
  const ramp = STAT_RAMPS[p.topStat] || STAT_RAMPS.POW;
  drawTag(ui, L + nw + 4, box.y + 1, clsLabel, ramp);
  if (p.classId === 'novice') {
    const dest = t('shareClassNames')[p.destinedClass] || '';
    const dx = L + nw + 4 + tagW + 3;
    if (R - dx > 18) drawText(ui, fitText(`→ ${dest}`, R - dx), dx, box.y + 13, ink.sub);
  }
  drawText(ui, fitText(metaLine(p, t), R - L), L, box.y + 29, ink.sub);

  drawFiligreeDivider(ui, mat, L, box.y + 34, R - L);

  // Six-stat ledger with hand-placed 7x7 pixel stat icons + glass-tube gauges.
  const names = t('shareStatNames');
  const colW = Math.floor((R - L - 6) / 2);
  STAT_KEYS.forEach((k, i) => {
    const cx = L + (i % 2) * (colW + 6);
    const cy = box.y + 39 + Math.floor(i / 2) * 23;
    const v = p.stats.values[k];
    const sr = STAT_RAMPS[k];
    const isTop = k === p.topStat;
    drawPixelSprite(ui, STAT_ICONS[k], {
      o: PAL.ink, D: sr[0], M: sr[1], H: sr[2], G: PAL.gold, K: '#8a5a34',
    }, cx, cy + 3);
    drawText(ui, names[k], cx + 9, cy + 11, isTop ? (ink.topHi || PAL.goldHi) : ink.text);
    const codeX = cx + 11 + textWidth(names[k]);
    if (codeX + tinyWidth(k) < cx + colW - 22) drawTiny(ui, k, codeX, cy + 3, ink.dim);
    drawTextRight(ui, String(v), cx + colW, cy + 11, isTop ? ink.gold : ink.text);
    drawGauge(ui, cx, cy + 14, colW, 5, v / 100, sr, mat.ramp[0]);
  });

  drawFiligreeDivider(ui, mat, L, box.y + 111, R - L);

  // Achievements Relic Shelf (28x28 bevelled sockets).
  const unlocked = ACHIEVEMENTS.filter((id) => achievements[id]).length;
  drawText(ui, t('shareAchTitle'), L, box.y + 123, ink.text);
  drawTextRight(ui, `${unlocked} / ${ACHIEVEMENTS.length}`, R, box.y + 123, ink.gold);
  featuredAchievements(achievements, 4).forEach(({ id, on }, i) => {
    const bx = L + (i % 2) * (colW + 6);
    const by = box.y + 127 + Math.floor(i / 2) * 29;
    drawRelicSocket(ui, mat, bx, by, 28, on);
    drawBadge(ui, id, bx + 2, by + 2, !on);
    drawText(ui, fitText(t('shareAch')[id][0], colW - 30), bx + 30, by + 18, on ? ink.text : ink.dim);
  });
  brand(ui);

  return { ui, heroX, foot, shadowSteps, arena, theme: isLight ? 'light' : 'dark', aria: t('shareAria') };
}

export function buildRoleCardSvg({ profile, achievements = {}, art = {}, lang = 'en', arena = DEFAULT_MATERIAL, theme = 'dark' } = {}) {
  const isLight = theme === 'light';
  const layout = buildRoleCardLayout({ profile, achievements, lang, arena, theme });
  const shadowSvg = `<g>${layout.shadowSteps.map(({ pix, alpha }) => pix.toSvg(SCALE, ` fill-opacity="${alpha}"`)).join('')}</g>`;
  const ambientSvg = renderStaticAmbientSvg(arena, { seed: profile.level * 31 + 7, clipX: 0, clipW: 186 });
  const dayWash = isLight ? `<rect x="0" y="0" width="${186 * SCALE}" height="${PIXEL_H}" fill="#fff4cf" fill-opacity="0.16"/>` : '';

  return svgDoc(layout.aria, [
    imageTag(art.arena, 0, 0, NATIVE_W, NATIVE_H),
    dayWash,
    ambientSvg,
    shadowSvg,
    spriteLayer(art.char, layout.heroX),
    layout.ui.toSvg(),
  ], isLight);
}

export function buildBadgeSheetSvg() {
  const p = new Pix(6 * 30 + 6, 4 * 30 + 10);
  const mat = materialFor(DEFAULT_MATERIAL);
  ACHIEVEMENTS.forEach((id, i) => {
    const sx = 4 + (i % 6) * 30;
    const sy1 = 4 + Math.floor(i / 6) * 30;
    const sy2 = 66 + Math.floor(i / 6) * 30;
    drawRelicSocket(p, mat, sx, sy1, 28, true);
    drawBadge(p, id, sx + 2, sy1 + 2);
    drawRelicSocket(p, mat, sx, sy2, 28, false);
    drawBadge(p, id, sx + 2, sy2 + 2, true);
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${p.w * SCALE}" height="${p.h * SCALE}" viewBox="0 0 ${p.w * SCALE} ${p.h * SCALE}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="${PAL.panel}"/>${p.toSvg()}</svg>`;
}

/** Frame material sheet for review: one framed panel per arena over its own backdrop. */
export function buildMaterialSheetSvg(arenaUris = {}) {
  const ids = Object.keys(MATERIALS);
  const parts = [];
  ids.forEach((id, i) => {
    const ox = (i % 2) * NATIVE_W;
    const oy = Math.floor(i / 2) * NATIVE_H;
    const p = new Pix();
    const mat = materialFor(id);
    const box = drawFrame(p, mat, 150, 20, 230, 120);
    drawText(p, id, box.x + 6, box.y + 16, inkFor(mat).text);
    drawPlaque(p, mat, 20, 150, 160, 22);
    drawFrame(p, mat, 20, 20, 38, 38);
    parts.push(`<g transform="translate(${ox * SCALE} ${oy * SCALE})">${imageTag(arenaUris[id], 0, 0, NATIVE_W, NATIVE_H)}${p.toSvg()}</g>`);
  });
  const W = NATIVE_W * 2 * SCALE;
  const H = NATIVE_H * 5 * SCALE;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" shape-rendering="crispEdges">${parts.join('')}</svg>`;
}
