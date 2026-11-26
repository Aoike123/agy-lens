// Pure-JS pixel-art GIF89a encoder & Role Card frame compositor.
// Zero external dependencies; code above "// --- browser-only helpers" has zero DOM/browser globals.

import {
  FLOOR_Y, NATIVE_H, NATIVE_W, placeholderSpritePix, spriteBox,
} from './share-pixel.js';
import { SPRITE_CELL } from './share-game.js';
import {
  clearVfxFrame, compositeVfx, createAmbientFx, createVfxFrame,
} from './share-vfx.js';

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Encode Uint8Array into standard Base64 without stack overflow on large buffers. */
export function bytesToBase64(bytes) {
  const src = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || 0);
  const len = src.length;
  if (!len) return '';
  const chunks = [];
  for (let i = 0; i < len; i += 3072) {
    const end = Math.min(len, i + 3072);
    let s = '';
    for (let j = i; j < end; j += 3) {
      const a = src[j];
      const hasB = j + 1 < end;
      const hasC = j + 2 < end;
      const b = hasB ? src[j + 1] : 0;
      const c = hasC ? src[j + 2] : 0;
      const tri = (a << 16) | (b << 8) | c;
      s += B64_CHARS[(tri >> 18) & 63]
        + B64_CHARS[(tri >> 12) & 63]
        + (hasB ? B64_CHARS[(tri >> 6) & 63] : '=')
        + (hasC ? B64_CHARS[tri & 63] : '=');
    }
    chunks.push(s);
  }
  return chunks.join('');
}

/** Decode standard Base64 string into Uint8Array. */
export function base64ToBytes(b64) {
  const s = String(b64 || '').replace(/[^A-Za-z0-9+/=]/g, '');
  const len = s.length;
  if (!len) return new Uint8Array(0);
  const pad = s.endsWith('==') ? 2 : (s.endsWith('=') ? 1 : 0);
  const out = new Uint8Array(Math.max(0, Math.floor((len * 3) / 4) - pad));
  let p = 0;
  for (let i = 0; i + 3 < len; i += 4) {
    const a = B64_CHARS.indexOf(s[i]);
    const b = B64_CHARS.indexOf(s[i + 1]);
    const c = s[i + 2] === '=' ? 0 : B64_CHARS.indexOf(s[i + 2]);
    const d = s[i + 3] === '=' ? 0 : B64_CHARS.indexOf(s[i + 3]);
    const tri = (a << 18) | (b << 12) | (c << 6) | d;
    if (p < out.length) out[p++] = (tri >> 16) & 255;
    if (p < out.length) out[p++] = (tri >> 8) & 255;
    if (p < out.length) out[p++] = tri & 255;
  }
  return out;
}

function parseHexRgb(hex) {
  let s = String(hex || '#000000').replace('#', '');
  if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  const v = parseInt(s.slice(0, 6), 16) || 0;
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function pixToOverlay(pix, markPriority = false) {
  const len = pix.w * pix.h;
  const packed = new Uint32Array(len);
  const mask = markPriority ? new Uint8Array(len) : null;
  const cache = new Map();
  for (let i = 0; i < len; i += 1) {
    const col = pix.c[i];
    if (!col) continue;
    let rgb = cache.get(col);
    if (rgb === undefined) {
      const [r, g, b] = parseHexRgb(col);
      rgb = (255 << 24) | (b << 16) | (g << 8) | r;
      cache.set(col, rgb);
    }
    packed[i] = rgb >>> 0;
    if (mask) mask[i] = 1;
  }
  return { packed, mask };
}

function blendRgbaOver(dst, di, r, g, b, a) {
  if (a <= 0) return;
  if (a >= 255) {
    dst[di] = r;
    dst[di + 1] = g;
    dst[di + 2] = b;
    dst[di + 3] = 255;
    return;
  }
  const sa = a / 255;
  const inv = 1 - sa;
  dst[di] = Math.min(255, Math.round(r * sa + dst[di] * inv));
  dst[di + 1] = Math.min(255, Math.round(g * sa + dst[di + 1] * inv));
  dst[di + 2] = Math.min(255, Math.round(b * sa + dst[di + 2] * inv));
  dst[di + 3] = 255;
}

function drawPackedMask(dst, packed, w, h) {
  for (let i = 0; i < w * h; i += 1) {
    const v = packed[i];
    if (!v) continue;
    const di = i * 4;
    dst[di] = v & 255;
    dst[di + 1] = (v >>> 8) & 255;
    dst[di + 2] = (v >>> 16) & 255;
    dst[di + 3] = 255;
  }
}

function drawSpriteRgba(dst, spriteRgba, sw, sh, ox, oy) {
  for (let y = 0; y < sh; y += 1) {
    const dy = oy + y;
    if (dy < 0 || dy >= NATIVE_H) continue;
    for (let x = 0; x < sw; x += 1) {
      const dx = ox + x;
      if (dx < 0 || dx >= NATIVE_W) continue;
      const si = (y * sw + x) * 4;
      const a = spriteRgba[si + 3];
      if (a > 0) blendRgbaOver(dst, (dy * NATIVE_W + dx) * 4, spriteRgba[si], spriteRgba[si + 1], spriteRgba[si + 2], a);
    }
  }
}

/** Composite role card layers across frames on the 400x210 native grid. */
export function compositeRoleCardFrames({ layout, arenaRgba = null, spriteFrames = [], seed = 1, reducedMotion = false } = {}) {
  const nPix = NATIVE_W * NATIVE_H;
  const isLight = Boolean(layout && layout.theme === 'light');
  const bgR = isLight ? 0xd8 : 0x14;
  const bgG = isLight ? 0xe5 : 0x18;
  const bgB = isLight ? 0xf2 : 0x28;
  const base = new Uint8ClampedArray(nPix * 4);
  for (let i = 0; i < nPix; i += 1) {
    const di = i * 4;
    base[di] = bgR;
    base[di + 1] = bgG;
    base[di + 2] = bgB;
    base[di + 3] = 255;
    if (arenaRgba && arenaRgba[di + 3] > 0) {
      blendRgbaOver(base, di, arenaRgba[di], arenaRgba[di + 1], arenaRgba[di + 2], arenaRgba[di + 3]);
    }
    if (isLight && (i % NATIVE_W) < 186) {
      blendRgbaOver(base, di, 0xff, 0xf4, 0xcf, 41);
    }
  }

  const { packed: uiPacked, mask: priorityMask } = pixToOverlay(layout.ui, true);
  const shadowLayers = (layout.shadowSteps || []).map(({ pix, alpha }) => ({
    packed: pixToOverlay(pix, false).packed,
    alphaByte: Math.round(alpha * 255),
  }));

  const fallbackPix = placeholderSpritePix(layout.heroX);
  const fallbackPacked = pixToOverlay(fallbackPix, false).packed;
  const box = spriteBox(layout.heroX, FLOOR_Y);

  const hasMultiSprite = Array.isArray(spriteFrames) && spriteFrames.length >= 2;
  const stillSprite = Array.isArray(spriteFrames) && spriteFrames.length === 1 ? spriteFrames[0] : null;
  const count = hasMultiSprite ? spriteFrames.length : (reducedMotion ? 1 : 24);
  const defaultStillDelay = 12;

  const ambient = createAmbientFx(layout.arena, seed);
  for (let i = 0; i < 20; i += 1) ambient.update(0.06);
  const vfxFrame = createVfxFrame(NATIVE_W, NATIVE_H);
  const vfxRgba = new Uint8ClampedArray(nPix * 4);
  const clipW = 186;

  const frames = [];
  for (let f = 0; f < count; f += 1) {
    const delayCs = hasMultiSprite ? Math.max(2, spriteFrames[f].delayCs || 17) : defaultStillDelay;
    if (f > 0 && !reducedMotion) {
      let rem = Math.min(0.4, delayCs / 100);
      while (rem > 0.0005) {
        const step = Math.min(0.05, rem);
        ambient.update(step);
        rem -= step;
      }
    }

    const rgba = new Uint8ClampedArray(base);

    // 1. Ambient VFX clipped to open arena side (x < 186).
    clearVfxFrame(vfxFrame);
    ambient.draw(vfxFrame);
    compositeVfx(vfxFrame, vfxRgba);
    for (let y = 0; y < NATIVE_H; y += 1) {
      for (let x = 0; x < clipW; x += 1) {
        const idx = (y * NATIVE_W + x) * 4;
        const a = vfxRgba[idx + 3];
        if (a > 0) blendRgbaOver(rgba, idx, vfxRgba[idx], vfxRgba[idx + 1], vfxRgba[idx + 2], a);
      }
    }

    // 2. Stepped 3-layer translucent contact shadow.
    for (let s = 0; s < shadowLayers.length; s += 1) {
      const { packed, alphaByte } = shadowLayers[s];
      for (let i = 0; i < nPix; i += 1) {
        const c = packed[i];
        if (c) blendRgbaOver(rgba, i * 4, c & 255, (c >>> 8) & 255, (c >>> 16) & 255, alphaByte);
      }
    }

    // 3. Character sprite frame (idle loop, still PNG, or fallback silhouette).
    const sp = hasMultiSprite ? spriteFrames[f] : stillSprite;
    if (sp && sp.rgba) {
      drawSpriteRgba(rgba, sp.rgba, sp.w || SPRITE_CELL.w, sp.h || SPRITE_CELL.h, Math.round(box.x), Math.round(box.y));
    } else {
      drawPackedMask(rgba, fallbackPacked, NATIVE_W, NATIVE_H);
    }

    // 4. Pixel UI dossier, crests, gauges & badges.
    drawPackedMask(rgba, uiPacked, NATIVE_W, NATIVE_H);
    frames.push({ rgba, delayCs });
  }

  return { frames, priorityMask };
}

// --- Palette Quantizer (exact <=255 fast path + weighted Median-Cut fallback) ---

const TRANSPARENT_IDX = 255;
export const MAX_SHARE_GIF_BYTES = 12 * 1024 * 1024;
const BAYER_4X4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

function colorDistSq(r, g, b, p) {
  const dr = r - p[0];
  const dg = g - p[1];
  const db = b - p[2];
  return 2 * dr * dr + 4 * dg * dg + 3 * db * db;
}

function collectExactPalette(frames) {
  const unique = new Map();
  const palette = [];
  for (let f = 0; f < frames.length; f += 1) {
    const rgba = frames[f].rgba;
    for (let i = 0; i < rgba.length; i += 4) {
      if (rgba[i + 3] < 128) continue;
      const key = (rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2];
      if (!unique.has(key)) {
        if (palette.length >= 255) return null;
        unique.set(key, palette.length);
        palette.push([rgba[i], rgba[i + 1], rgba[i + 2]]);
      }
    }
  }
  while (palette.length < 256) palette.push([0, 0, 0]);
  return { palette, exactMap: unique };
}

function buildQuantizedPalette(frames, priorityMask) {
  const exact = collectExactPalette(frames);
  if (exact) return exact;

  // Weighted 15-bit RGB histogram (5-5-5 bits -> 32768 bins).
  const weights = new Float64Array(32768);
  const sumR = new Float64Array(32768);
  const sumG = new Float64Array(32768);
  const sumB = new Float64Array(32768);
  const frameStep = frames.length > 16 ? 2 : 1;

  for (let f = 0; f < frames.length; f += frameStep) {
    const rgba = frames[f].rgba;
    const pCount = rgba.length >> 2;
    for (let p = 0; p < pCount; p += 1) {
      const i = p * 4;
      if (rgba[i + 3] < 128) continue;
      const r = rgba[i];
      const g = rgba[i + 1];
      const b = rgba[i + 2];
      const bin = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      const w = priorityMask && priorityMask[p] ? 4 : 1;
      weights[bin] += w;
      sumR[bin] += r * w;
      sumG[bin] += g * w;
      sumB[bin] += b * w;
    }
  }

  const bins = [];
  for (let b = 0; b < 32768; b += 1) {
    const w = weights[b];
    if (w <= 0) continue;
    bins.push({
      w,
      r: sumR[b] / w,
      g: sumG[b] / w,
      b: sumB[b] / w,
    });
  }

  if (bins.length <= 255) {
    const palette = bins.map((x) => [Math.round(x.r), Math.round(x.g), Math.round(x.b)]);
    while (palette.length < 256) palette.push([0, 0, 0]);
    return { palette, exactMap: null };
  }

  const makeBox = (arr) => {
    let minR = 255; let maxR = 0;
    let minG = 255; let maxG = 0;
    let minB = 255; let maxB = 0;
    let totalW = 0;
    for (let i = 0; i < arr.length; i += 1) {
      const x = arr[i];
      if (x.r < minR) minR = x.r;
      if (x.r > maxR) maxR = x.r;
      if (x.g < minG) minG = x.g;
      if (x.g > maxG) maxG = x.g;
      if (x.b < minB) minB = x.b;
      if (x.b > maxB) maxB = x.b;
      totalW += x.w;
    }
    const spanR = maxR - minR;
    const spanG = maxG - minG;
    const spanB = maxB - minB;
    const axis = spanG >= spanR && spanG >= spanB ? 'g' : (spanR >= spanB ? 'r' : 'b');
    return { arr, totalW, maxSpan: Math.max(spanR, spanG, spanB), axis };
  };

  const boxes = [makeBox(bins)];
  while (boxes.length < 255) {
    let bestIdx = -1;
    let bestScore = -1;
    for (let i = 0; i < boxes.length; i += 1) {
      const bx = boxes[i];
      if (bx.arr.length < 2 || bx.maxSpan <= 0) continue;
      const score = bx.maxSpan * Math.sqrt(bx.totalW);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) break;
    const target = boxes.splice(bestIdx, 1)[0];
    const axis = target.axis;
    target.arr.sort((a, b) => a[axis] - b[axis]);
    const halfW = target.totalW * 0.5;
    let acc = 0;
    let split = 1;
    for (let i = 0; i < target.arr.length - 1; i += 1) {
      acc += target.arr[i].w;
      if (acc >= halfW) {
        split = i + 1;
        break;
      }
    }
    boxes.push(makeBox(target.arr.slice(0, split)), makeBox(target.arr.slice(split)));
  }

  const palette = boxes.map((bx) => {
    let tw = 0; let sr = 0; let sg = 0; let sb = 0;
    for (let i = 0; i < bx.arr.length; i += 1) {
      const x = bx.arr[i];
      tw += x.w;
      sr += x.r * x.w;
      sg += x.g * x.w;
      sb += x.b * x.w;
    }
    const d = tw || 1;
    return [Math.round(sr / d), Math.round(sg / d), Math.round(sb / d)];
  });
  while (palette.length < 256) palette.push([0, 0, 0]);
  return { palette, exactMap: null };
}

function createColorMapper(palette, exactMap) {
  const colorCount = 255; // index 255 reserved for transparency
  const lut15 = new Int16Array(32768).fill(-1);
  const rgbCache = exactMap ? new Map(exactMap) : new Map();

  return (r, g, b) => {
    const key24 = (r << 16) | (g << 8) | b;
    const cached = rgbCache.get(key24);
    if (cached !== undefined) return cached;

    const bin = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    let best = lut15[bin];
    if (best < 0 || rgbCache.size < 4096) {
      let bestDist = Infinity;
      let idx = 0;
      for (let i = 0; i < colorCount; i += 1) {
        const p = palette[i];
        const dr = r - p[0];
        const dg = g - p[1];
        const db = b - p[2];
        const dist = 2 * dr * dr + 4 * dg * dg + 3 * db * db;
        if (dist < bestDist) {
          bestDist = dist;
          idx = i;
          if (dist === 0) break;
        }
      }
      best = idx;
      lut15[bin] = best;
      if (rgbCache.size < 4096) rgbCache.set(key24, best);
    }
    return best;
  };
}

// --- GIF89a LZW encoder (minCodeSize = 8, open-addressed 5003 hash table) ---

const HASH_SIZE = 5003;
const lzwKeys = new Int32Array(HASH_SIZE);
const lzwCodes = new Int16Array(HASH_SIZE);

function encodeLzwRaster(indices) {
  const minCodeSize = 8;
  const clearCode = 1 << minCodeSize; // 256
  const eoiCode = clearCode + 1;      // 257

  let codeSize = minCodeSize + 1;     // 9
  let maxCode = 1 << codeSize;        // 512
  let nextCode = eoiCode + 1;         // 258
  lzwKeys.fill(-1);

  const chunks = [];
  let sub = new Uint8Array(256);
  let subLen = 0;
  let curAccum = 0;
  let curBits = 0;

  const pushByte = (byteVal) => {
    sub[subLen++] = byteVal & 255;
    if (subLen === 255) {
      chunks.push(255, ...sub.subarray(0, 255));
      subLen = 0;
    }
  };

  const emitCode = (code, bits) => {
    curAccum |= (code << curBits);
    curBits += bits;
    while (curBits >= 8) {
      pushByte(curAccum & 255);
      curAccum >>>= 8;
      curBits -= 8;
    }
  };

  emitCode(clearCode, codeSize);
  const len = indices.length;
  if (len > 0) {
    let ent = indices[0];
    for (let i = 1; i < len; i += 1) {
      const c = indices[i];
      const fcode = (c << 12) | ent;
      let h = (c << 4) ^ ent;
      if (h >= HASH_SIZE) h %= HASH_SIZE;
      const disp = h === 0 ? 1 : HASH_SIZE - h;

      let matched = false;
      while (lzwKeys[h] !== -1) {
        if (lzwKeys[h] === fcode) {
          ent = lzwCodes[h];
          matched = true;
          break;
        }
        h -= disp;
        if (h < 0) h += HASH_SIZE;
      }
      if (matched) continue;

      emitCode(ent, codeSize);
      ent = c;

      if (nextCode < 4096) {
        lzwKeys[h] = fcode;
        lzwCodes[h] = nextCode;
        nextCode += 1;
        // Decoder increases its bit width right when a new entry pushes code index to 2^codeSize.
        if (nextCode > maxCode && codeSize < 12) {
          codeSize += 1;
          maxCode = 1 << codeSize;
        }
      } else {
        emitCode(clearCode, codeSize);
        lzwKeys.fill(-1);
        nextCode = eoiCode + 1;
        codeSize = minCodeSize + 1;
        maxCode = 1 << codeSize;
      }
    }
    emitCode(ent, codeSize);
    // Keep exact bit-width sync with the GIF decoder before writing EOI at a power-of-2 boundary.
    if (nextCode === maxCode && codeSize < 12) {
      codeSize += 1;
    }
  }
  emitCode(eoiCode, codeSize);
  if (curBits > 0) pushByte(curAccum & 255);
  if (subLen > 0) {
    chunks.push(subLen);
    for (let i = 0; i < subLen; i += 1) chunks.push(sub[i]);
  }
  chunks.push(0); // block terminator
  return chunks;
}

function writeU16LE(arr, val) {
  arr.push(val & 255, (val >>> 8) & 255);
}

function makeAbortError() {
  const err = new Error('GIF encoding aborted');
  err.name = 'AbortError';
  err.code = 'ABORTED';
  return err;
}

function checkAborted(signal) {
  if (signal && signal.aborted) throw makeAbortError();
}

/**
 * Encode RGBA frames to an animated GIF89a Uint8Array with exact integer scaling
 * and delta-cropped transparent sub-frames.
 */
export function encodeGif({
  width,
  height,
  frames,
  scale = 2,
  defaultDelayCs = 17,
  loop = 0,
  priorityMask = null,
  dither = 'none',
  signal = null,
} = {}) {
  if (!Array.isArray(frames) || !frames.length) throw new Error('encodeGif requires at least 1 frame');
  checkAborted(signal);
  const s = Math.max(1, Math.round(scale));
  const outW = width * s;
  const outH = height * s;

  const { palette, exactMap } = buildQuantizedPalette(frames, priorityMask);
  const mapRgb = createColorMapper(palette, exactMap);
  const useBayer = dither === 'bayer' && exactMap === null;
  const useFloyd = dither === 'floyd' && exactMap === null;

  const out = [];
  // Header: GIF89a
  out.push(0x47, 0x49, 0x46, 0x38, 0x39, 0x61);
  // Logical Screen Descriptor
  writeU16LE(out, outW);
  writeU16LE(out, outH);
  out.push(0xf7, 0x00, 0x00); // GCT present, 8-bit color, 256 entries, bg=0, aspect=0
  // Global Color Table (256 * 3 bytes)
  for (let i = 0; i < 256; i += 1) {
    out.push(palette[i][0] & 255, palette[i][1] & 255, palette[i][2] & 255);
  }
  // NETSCAPE2.0 looping extension when animating
  if (frames.length > 1) {
    out.push(
      0x21, 0xff, 0x0b,
      0x4e, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2e, 0x30,
      0x03, 0x01, loop & 255, (loop >>> 8) & 255, 0x00,
    );
  }

  const nativePixels = width * height;
  const prevIdx = new Uint8Array(nativePixels);
  const curIdx = new Uint8Array(nativePixels);
  const errBuf = useFloyd ? new Float32Array((width + 2) * 6) : null;
  let lastDelayOffset = -1;

  const mapFrameToNative = (rgba, dst) => {
    if (useFloyd && errBuf) {
      errBuf.fill(0);
      const stride = (width + 2) * 3;
      const strength = 0.42;
      for (let y = 0; y < height; y += 1) {
        const curRow = (y & 1) * stride;
        const nxtRow = ((y + 1) & 1) * stride;
        for (let i = 0; i < stride; i += 1) errBuf[nxtRow + i] = 0;
        const serp = (y & 1) === 1;
        const xStart = serp ? width - 1 : 0;
        const xEnd = serp ? -1 : width;
        const xStep = serp ? -1 : 1;
        const rowOff = y * width;
        for (let x = xStart; x !== xEnd; x += xStep) {
          const p = rowOff + x;
          const i = p * 4;
          if (rgba[i + 3] < 128) {
            dst[p] = TRANSPARENT_IDX;
            continue;
          }
          const r0 = rgba[i];
          const g0 = rgba[i + 1];
          const b0 = rgba[i + 2];
          if (priorityMask && priorityMask[p]) {
            dst[p] = mapRgb(r0, g0, b0);
            continue;
          }
          const eo = curRow + (x + 1) * 3;
          const r = Math.max(0, Math.min(255, Math.round(r0 + Math.max(-10, Math.min(10, errBuf[eo])))));
          const g = Math.max(0, Math.min(255, Math.round(g0 + Math.max(-10, Math.min(10, errBuf[eo + 1])))));
          const b = Math.max(0, Math.min(255, Math.round(b0 + Math.max(-10, Math.min(10, errBuf[eo + 2])))));
          const idx = mapRgb(r, g, b);
          dst[p] = idx;
          const pal = palette[idx];
          const er = (r - pal[0]) * strength;
          const eg = (g - pal[1]) * strength;
          const eb = (b - pal[2]) * strength;
          const fwd = curRow + (x + 1 + xStep) * 3;
          const bwd = nxtRow + (x + 1 - xStep) * 3;
          const mid = nxtRow + (x + 1) * 3;
          const dia = nxtRow + (x + 1 + xStep) * 3;
          errBuf[fwd] += er * 0.4375; errBuf[fwd + 1] += eg * 0.4375; errBuf[fwd + 2] += eb * 0.4375;
          errBuf[bwd] += er * 0.1875; errBuf[bwd + 1] += eg * 0.1875; errBuf[bwd + 2] += eb * 0.1875;
          errBuf[mid] += er * 0.3125; errBuf[mid + 1] += eg * 0.3125; errBuf[mid + 2] += eb * 0.3125;
          errBuf[dia] += er * 0.0625; errBuf[dia + 1] += eg * 0.0625; errBuf[dia + 2] += eb * 0.0625;
        }
      }
      return;
    }
    const spread = 24; // max +-11.25 RGB offset; zero-mean across 4x4 tile
    for (let y = 0; y < height; y += 1) {
      const bayerRow = useBayer ? BAYER_4X4[y & 3] : null;
      const rowOff = y * width;
      for (let x = 0; x < width; x += 1) {
        const p = rowOff + x;
        const i = p * 4;
        if (rgba[i + 3] < 128) {
          dst[p] = TRANSPARENT_IDX;
          continue;
        }
        const r = rgba[i];
        const g = rgba[i + 1];
        const b = rgba[i + 2];
        if (!useBayer || (priorityMask && priorityMask[p])) {
          dst[p] = mapRgb(r, g, b);
          continue;
        }
        const baseIdx = mapRgb(r, g, b);
        if (colorDistSq(r, g, b, palette[baseIdx]) <= 36) {
          dst[p] = baseIdx;
          continue;
        }
        const delta = ((bayerRow[x & 3] + 0.5) / 16 - 0.5) * spread;
        const dr = Math.max(0, Math.min(255, Math.round(r + delta)));
        const dg = Math.max(0, Math.min(255, Math.round(g + delta)));
        const db = Math.max(0, Math.min(255, Math.round(b + delta)));
        dst[p] = mapRgb(dr, dg, db);
      }
    }
  };

  const emitScaledSubFrame = ({ subX, subY, subW, subH, nativeIndices, delayCs, useTransparent }) => {
    // Graphic Control Extension (disposal=1 keep canvas; transparent flag bit0)
    out.push(0x21, 0xf9, 0x04, useTransparent ? 0x05 : 0x04);
    lastDelayOffset = out.length;
    writeU16LE(out, Math.max(1, Math.min(65535, Math.round(delayCs))));
    out.push(useTransparent ? TRANSPARENT_IDX : 0x00, 0x00);

    const scaledW = subW * s;
    const scaledH = subH * s;
    // Image Descriptor
    out.push(0x2c);
    writeU16LE(out, subX * s);
    writeU16LE(out, subY * s);
    writeU16LE(out, scaledW);
    writeU16LE(out, scaledH);
    out.push(0x00); // local color table = 0, interlace = 0

    // Scale sub-rect indices by integer factor s x s
    const raster = new Uint8Array(scaledW * scaledH);
    for (let y = 0; y < subH; y += 1) {
      const srcRow = y * subW;
      const dstRowBase = (y * s) * scaledW;
      for (let x = 0; x < subW; x += 1) {
        const val = nativeIndices[srcRow + x];
        const dx = x * s;
        for (let sy = 0; sy < s; sy += 1) {
          const rowOff = dstRowBase + sy * scaledW + dx;
          for (let sx = 0; sx < s; sx += 1) raster[rowOff + sx] = val;
        }
      }
    }

    out.push(0x08); // LZW minimum code size
    const lzw = encodeLzwRaster(raster);
    for (let i = 0; i < lzw.length; i += 1) out.push(lzw[i]);
  };

  for (let f = 0; f < frames.length; f += 1) {
    checkAborted(signal);
    const delayCs = Math.max(2, Math.round(frames[f].delayCs ?? defaultDelayCs));
    mapFrameToNative(frames[f].rgba, curIdx);
    if (f === 0) {
      prevIdx.set(curIdx);
      emitScaledSubFrame({
        subX: 0, subY: 0, subW: width, subH: height,
        nativeIndices: curIdx, delayCs, useTransparent: false,
      });
      continue;
    }

    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < height; y += 1) {
      const rowOff = y * width;
      for (let x = 0; x < width; x += 1) {
        if (curIdx[rowOff + x] !== prevIdx[rowOff + x]) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }

    if (maxX < minX) {
      // Identical quantized frame: coalesce its delay into the previous frame's GCE.
      const prevDelay = out[lastDelayOffset] | (out[lastDelayOffset + 1] << 8);
      const merged = Math.min(65535, prevDelay + delayCs);
      out[lastDelayOffset] = merged & 255;
      out[lastDelayOffset + 1] = (merged >>> 8) & 255;
      continue;
    }

    const subW = maxX - minX + 1;
    const subH = maxY - minY + 1;
    const subNative = new Uint8Array(subW * subH);
    for (let y = 0; y < subH; y += 1) {
      const ny = minY + y;
      const srcOff = ny * width + minX;
      const dstOff = y * subW;
      for (let x = 0; x < subW; x += 1) {
        const p = srcOff + x;
        const c = curIdx[p];
        if (c === prevIdx[p]) {
          subNative[dstOff + x] = TRANSPARENT_IDX;
        } else {
          subNative[dstOff + x] = c;
          prevIdx[p] = c;
        }
      }
    }

    emitScaledSubFrame({
      subX: minX, subY: minY, subW, subH,
      nativeIndices: subNative, delayCs, useTransparent: true,
    });
  }

  out.push(0x3b); // GIF trailer
  return new Uint8Array(out);
}

// --- browser-only helpers (never called in pure Node tests) ---

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = (err) => reject(err || new Error('Image decode failed'));
    img.src = src;
  });
}

export async function decodeImageRgba(dataUri, targetW, targetH) {
  if (!dataUri) return null;
  const img = await loadImage(dataUri);
  const canvas = document.createElement('canvas');
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, 0, 0, targetW, targetH);
  return ctx.getImageData(0, 0, targetW, targetH).data;
}

export async function decodeAnimatedWebpFrames(dataUri, targetW, targetH, signal = null) {
  if (!dataUri) return [];
  checkAborted(signal);
  const match = String(dataUri).match(/^data:image\/([a-z0-9.+-]+);base64,(.+)$/i);
  if (match && match[1].toLowerCase() === 'webp' && typeof ImageDecoder === 'function') {
    let decoder = null;
    try {
      const bytes = base64ToBytes(match[2]);
      decoder = new ImageDecoder({ data: bytes, type: 'image/webp' });
      await decoder.tracks.ready;
      checkAborted(signal);
      const track = decoder.tracks.selectedTrack;
      const frameCount = Math.max(1, (track && track.frameCount) || 1);
      const canvas = document.createElement('canvas');
      canvas.width = targetW;
      canvas.height = targetH;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('2D canvas unavailable');
      ctx.imageSmoothingEnabled = false;

      const frames = [];
      for (let i = 0; i < frameCount; i += 1) {
        checkAborted(signal);
        const res = await decoder.decode({ frameIndex: i });
        const img = res && res.image;
        try {
          checkAborted(signal);
          ctx.clearRect(0, 0, targetW, targetH);
          ctx.drawImage(img, 0, 0, targetW, targetH);
          const rgba = ctx.getImageData(0, 0, targetW, targetH).data;
          const durUs = img && typeof img.duration === 'number' && img.duration > 0 ? img.duration : 167000;
          const delayCs = Math.max(2, Math.round(durUs / 10000));
          frames.push({ rgba, delayCs, w: targetW, h: targetH });
        } finally {
          if (img && typeof img.close === 'function') img.close();
        }
      }
      if (frames.length) return frames;
    } catch (err) {
      if (err && (err.name === 'AbortError' || err.code === 'ABORTED')) throw err;
      // Fall back to static single-frame decode below.
    } finally {
      if (decoder && typeof decoder.close === 'function') {
        try { decoder.close(); } catch { /* ignore */ }
      }
    }
  }
  checkAborted(signal);
  const rgba = await decodeImageRgba(dataUri, targetW, targetH);
  checkAborted(signal);
  return rgba ? [{ rgba, delayCs: 17, w: targetW, h: targetH }] : [];
}

/** Decode character & arena assets, composite native frames + ambient VFX, and encode GIF89a. */
export async function renderRoleCardGif({
  layout,
  profile,
  art = {},
  scale = 2,
  reducedMotion = false,
  signal = null,
} = {}) {
  checkAborted(signal);
  const [arenaRgba, spriteFrames] = await Promise.all([
    art.arena ? decodeImageRgba(art.arena, NATIVE_W, NATIVE_H).catch(() => null) : Promise.resolve(null),
    art.char ? decodeAnimatedWebpFrames(art.char, SPRITE_CELL.w, SPRITE_CELL.h, signal).catch((err) => {
      if (err && (err.name === 'AbortError' || err.code === 'ABORTED')) throw err;
      return [];
    }) : Promise.resolve([]),
  ]);
  checkAborted(signal);
  await new Promise((r) => setTimeout(r, 0));
  checkAborted(signal);
  const { frames, priorityMask } = compositeRoleCardFrames({
    layout,
    arenaRgba,
    spriteFrames,
    seed: ((profile && profile.level) || 1) * 31 + 7,
    reducedMotion,
  });
  checkAborted(signal);
  await new Promise((r) => setTimeout(r, 0));
  checkAborted(signal);
  const bytes = encodeGif({
    width: NATIVE_W,
    height: NATIVE_H,
    frames,
    scale,
    loop: 0,
    priorityMask,
    signal,
  });
  checkAborted(signal);
  const blob = typeof Blob !== 'undefined' ? new Blob([bytes], { type: 'image/gif' }) : null;
  const base64 = bytesToBase64(bytes);
  return {
    bytes,
    blob,
    base64,
    width: NATIVE_W * scale,
    height: NATIVE_H * scale,
    frameCount: frames.length,
  };
}

async function svgToImage(svgString, signal) {
  checkAborted(signal);
  const blob = typeof Blob !== 'undefined'
    ? new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' })
    : null;
  const blobUrl = blob && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function'
    ? URL.createObjectURL(blob)
    : null;
  try {
    if (blobUrl) {
      try {
        return await loadImage(blobUrl);
      } catch {
        checkAborted(signal);
        return await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgString)}`);
      }
    }
    return await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgString)}`);
  } finally {
    if (blobUrl && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
      URL.revokeObjectURL(blobUrl);
    }
  }
}

/** Rasterize animated SVG or hybrid WebGL+SVG frames on an offscreen canvas and encode GIF89a. */
export async function rasterizeSvgFramesToGif({
  renderSvgAtPhase,
  renderCanvasAtPhase,
  width,
  height,
  frameCount = 18,
  delayCs = 12,
  gifScale = 0.75,
  dither = 'none',
  signal = null,
} = {}) {
  const hasCanvasRenderer = typeof renderCanvasAtPhase === 'function';
  if (!hasCanvasRenderer && typeof renderSvgAtPhase !== 'function') {
    throw new Error('renderSvgAtPhase or renderCanvasAtPhase function required');
  }
  checkAborted(signal);
  const count = Math.max(1, Math.round(frameCount));
  const outW = Math.max(1, Math.round(width * gifScale));
  const outH = Math.max(1, Math.round(height * gifScale));
  const stepDelayCs = Math.max(2, Math.round(delayCs));

  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) || canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  const frames = [];
  for (let f = 0; f < count; f += 1) {
    checkAborted(signal);
    const phase = count > 1 ? f / count : 0;
    ctx.clearRect(0, 0, outW, outH);
    if (hasCanvasRenderer) {
      await renderCanvasAtPhase(ctx, phase, f, outW, outH);
    } else {
      const svg = String(renderSvgAtPhase(phase, f) || '');
      const img = await svgToImage(svg, signal);
      checkAborted(signal);
      ctx.drawImage(img, 0, 0, outW, outH);
    }
    const rgba = ctx.getImageData(0, 0, outW, outH).data;
    frames.push({ rgba, delayCs: stepDelayCs });
    if (f % 3 === 2) await new Promise((r) => setTimeout(r, 0));
  }

  checkAborted(signal);
  await new Promise((r) => setTimeout(r, 0));
  checkAborted(signal);

  const bytes = encodeGif({
    width: outW,
    height: outH,
    frames,
    scale: 1,
    defaultDelayCs: stepDelayCs,
    loop: 0,
    dither,
  });
  if (bytes.byteLength > MAX_SHARE_GIF_BYTES) {
    const err = new Error(`GIF size (${bytes.byteLength} bytes) exceeds 12 MB limit`);
    err.code = 'GIF_TOO_LARGE';
    throw err;
  }
  const blob = typeof Blob !== 'undefined' ? new Blob([bytes], { type: 'image/gif' }) : null;
  const base64 = bytesToBase64(bytes);
  return {
    bytes,
    blob,
    base64,
    width: outW,
    height: outH,
    frameCount: frames.length,
  };
}
