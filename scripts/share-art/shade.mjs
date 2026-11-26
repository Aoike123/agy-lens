// Shading layer for the share-card pixel art: turns a generated image into palette-locked pixel art.
// Pure functions over RGBA8 images ({ width, height, data }); no I/O here.
//
// Stages (sprites):  key background -> fit to native grid by per-block colour vote -> palette lock
//                    -> merge rare colours -> remove orphan pixels -> selective outline
//                    -> top-left key light, right rim light, bottom shade, contact occlusion.
// Stages (backgrounds): cover-fit -> per-block OKLab mean -> palette lock with ordered dithering
//                    between neighbouring ramp steps.

/* ---------------- colour math (sRGB <-> OKLab) ---------------- */

const toLin = (c) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const toSrgb8 = (v) => {
  const s = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, s)) * 255);
};

export function rgbToOklab(r, g, b) {
  const lr = toLin(r);
  const lg = toLin(g);
  const lb = toLin(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}

function oklabToLinear(L, a, b) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
}

function oklchToRgb(L, C, hDeg) {
  // Reduce chroma until the colour fits in sRGB, so ramps never clip into a different hue.
  let c = C;
  for (let i = 0; i < 40; i += 1) {
    const h = (hDeg * Math.PI) / 180;
    const lin = oklabToLinear(L, c * Math.cos(h), c * Math.sin(h));
    if (lin.every((v) => v >= -1e-4 && v <= 1 + 1e-4)) return lin.map(toSrgb8);
    c *= 0.92;
  }
  const lin = oklabToLinear(L, 0, 0);
  return lin.map(toSrgb8);
}

const lerpHue = (h, target, t) => {
  let d = ((target - h + 540) % 360) - 180;
  return (h + d * Math.max(0, Math.min(1, t)) + 360) % 360;
};

/* ---------------- master palette: hue-shifted ramps ---------------- */

// Each ramp runs dark -> light. Shadows drift toward blue-violet, highlights toward warm yellow,
// which is what keeps shading from looking like plain black/white mixing ("pillow shading").
export const RAMP_DEFS = [
  { id: 'red', h: 27, c: 0.19 },
  { id: 'orange', h: 52, c: 0.17 },
  { id: 'yellow', h: 92, c: 0.16 },
  { id: 'lime', h: 125, c: 0.16 },
  { id: 'green', h: 150, c: 0.15 },
  { id: 'teal', h: 182, c: 0.11 },
  { id: 'cyan', h: 215, c: 0.13 },
  { id: 'blue', h: 255, c: 0.16 },
  { id: 'violet', h: 295, c: 0.16 },
  { id: 'pink', h: 345, c: 0.16 },
  { id: 'sky', h: 235, c: 0.1 },
  { id: 'leaf', h: 138, c: 0.11 },
  { id: 'skin', h: 55, c: 0.075 },
  { id: 'brown', h: 48, c: 0.1 },
  { id: 'sand', h: 85, c: 0.07 },
  { id: 'slate', h: 260, c: 0.035 },
  { id: 'gray', h: 270, c: 0.012 },
];
export const RAMP_STEPS = [0.17, 0.27, 0.37, 0.47, 0.57, 0.67, 0.77, 0.86, 0.94];

export function buildPalette(defs = RAMP_DEFS, steps = RAMP_STEPS) {
  const colors = [];
  defs.forEach((def, ri) => {
    steps.forEach((L, si) => {
      const mid = 0.6;
      const h = L >= mid
        ? lerpHue(def.h, 92, ((L - mid) / (1 - mid)) * 0.35)
        : lerpHue(def.h, 275, ((mid - L) / mid) * 0.4);
      const chromaShape = L >= 0.62 ? Math.max(0.45, 1 - (L - 0.62) * 1.4) : Math.max(0.3, 1 - (0.62 - L) * 1.1);
      const rgb = oklchToRgb(L, def.c * chromaShape, h);
      colors.push({ ramp: ri, step: si, rampId: def.id, rgb, lab: rgbToOklab(...rgb) });
    });
  });
  return colors;
}

export const PALETTE = buildPalette();
const STEPS = RAMP_STEPS.length;
const idxOf = (ramp, step) => ramp * STEPS + Math.max(0, Math.min(STEPS - 1, step));
export const lighter = (i, n = 1) => idxOf(PALETTE[i].ramp, PALETTE[i].step + n);
export const darker = (i, n = 1) => idxOf(PALETTE[i].ramp, PALETTE[i].step - n);

function labDist2(a, b) {
  const dL = a[0] - b[0];
  const da = a[1] - b[1];
  const db = a[2] - b[2];
  return dL * dL * 1.2 + da * da + db * db;
}

function makeNearest(palette) {
  const cache = new Int16Array(64 * 64 * 64).fill(-1);
  return (r, g, b) => {
    const key = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
    const hit = cache[key];
    if (hit >= 0) return hit;
    const lab = rgbToOklab(r, g, b);
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < palette.length; i += 1) {
      const d = labDist2(lab, palette[i].lab);
      if (d < bestD) { bestD = d; best = i; }
    }
    cache[key] = best;
    return best;
  };
}
const nearestIndex = makeNearest(PALETTE);

/* ---------------- background keying ---------------- */

function hasRealAlpha(img) {
  const { data } = img;
  let clear = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 200) clear += 1;
  return clear > (data.length / 4) * 0.01;
}

/** Returns a Uint8Array mask (1 = keep) at source resolution. */
export function keyBackground(img, { tolerance = 0.09 } = {}) {
  const { width: W, height: H, data } = img;
  const mask = new Uint8Array(W * H);
  if (hasRealAlpha(img)) {
    for (let i = 0; i < W * H; i += 1) mask[i] = data[i * 4 + 3] >= 128 ? 1 : 0;
    return mask;
  }
  // Key colour = most common (coarsely quantised) colour along the border.
  const counts = new Map();
  const border = [];
  for (let x = 0; x < W; x += 1) border.push(x, (H - 1) * W + x);
  for (let y = 0; y < H; y += 1) border.push(y * W, y * W + W - 1);
  for (const p of border) {
    const k = ((data[p * 4] >> 4) << 8) | ((data[p * 4 + 1] >> 4) << 4) | (data[p * 4 + 2] >> 4);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const keyBin = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  let sr = 0; let sg = 0; let sb = 0; let n = 0;
  for (const p of border) {
    const k = ((data[p * 4] >> 4) << 8) | ((data[p * 4 + 1] >> 4) << 4) | (data[p * 4 + 2] >> 4);
    if (k === keyBin) { sr += data[p * 4]; sg += data[p * 4 + 1]; sb += data[p * 4 + 2]; n += 1; }
  }
  const keyLab = rgbToOklab(sr / n, sg / n, sb / n);
  const tol2 = tolerance * tolerance;
  const near = (p) => labDist2(rgbToOklab(data[p * 4], data[p * 4 + 1], data[p * 4 + 2]), keyLab) <= tol2;
  // Flood fill from the border so interior areas that happen to match the key survive.
  mask.fill(1);
  const stack = border.filter(near);
  for (const p of stack) mask[p] = 0;
  while (stack.length) {
    const p = stack.pop();
    const x = p % W;
    const y = (p - x) / W;
    const nb = [];
    if (x > 0) nb.push(p - 1);
    if (x < W - 1) nb.push(p + 1);
    if (y > 0) nb.push(p - W);
    if (y < H - 1) nb.push(p + W);
    for (const q of nb) {
      if (mask[q] && near(q)) { mask[q] = 0; stack.push(q); }
    }
  }
  // Despill: one ring of key-tinted fringe pixels next to the cut-out goes too.
  const loose = (tolerance * 1.8) ** 2;
  const fringe = [];
  for (let p = 0; p < W * H; p += 1) {
    if (!mask[p]) continue;
    const x = p % W;
    const touches = (x > 0 && !mask[p - 1]) || (x < W - 1 && !mask[p + 1]) || (p >= W && !mask[p - W]) || (p < W * (H - 1) && !mask[p + W]);
    if (touches && labDist2(rgbToOklab(data[p * 4], data[p * 4 + 1], data[p * 4 + 2]), keyLab) <= loose) fringe.push(p);
  }
  for (const p of fringe) mask[p] = 0;
  mask.keyRgb = [sr / n, sg / n, sb / n];
  return mask;
}

/**
 * Colour spill suppression. Generators (and JPEG) bleed the key colour into the subject near the
 * cut-out, which turns edges, sleeves and faces purple on a magenta key. Inside a band next to the
 * removed background, pull the key's excess channels back toward the subject's own colour.
 * Returns a new image; the input is untouched.
 */
export function suppressSpill(img, mask, { band = null } = {}) {
  const key = mask.keyRgb;
  if (!key) return img;
  const { width: W, height: H } = img;
  const data = new Uint8Array(img.data);
  const R = band ?? Math.max(3, Math.round(Math.max(W, H) * 0.012));
  // Distance (in pixels, 4-neighbour) from the removed background, capped at R.
  const dist = new Uint16Array(W * H).fill(65535);
  const queue = [];
  for (let p = 0; p < W * H; p += 1) if (!mask[p]) { dist[p] = 0; queue.push(p); }
  for (let qi = 0; qi < queue.length; qi += 1) {
    const p = queue[qi];
    const d = dist[p] + 1;
    if (d > R) continue;
    const x = p % W;
    for (const q of [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, p >= W ? p - W : -1, p < W * (H - 1) ? p + W : -1]) {
      if (q >= 0 && dist[q] > d) { dist[q] = d; queue.push(q); }
    }
  }
  // Which channels does the key push up? For magenta that is red and blue over green.
  const lo = Math.min(...key);
  const hot = key.map((v) => v - lo > 90);
  const cold = key.map((v) => v - lo <= 90);
  for (let p = 0; p < W * H; p += 1) {
    if (!mask[p] || dist[p] > R) continue;
    const o = p * 4;
    const c = [data[o], data[o + 1], data[o + 2]];
    const coldMax = Math.max(...c.filter((_, i) => cold[i]));
    const hotMin = Math.min(...c.filter((_, i) => hot[i]));
    const excess = hotMin - coldMax;
    if (excess <= 8) continue;
    const w = 1 - (dist[p] - 1) / R; // strongest right at the edge
    for (let i = 0; i < 3; i += 1) if (hot[i]) data[o + i] = Math.round(c[i] - excess * 0.85 * w);
  }
  return { width: W, height: H, data };
}

function maskBBox(mask, W, H) {
  let x0 = W; let y0 = H; let x1 = -1; let y1 = -1;
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      if (mask[y * W + x]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/* ---------------- indexed working image ---------------- */
// A working image is { w, h, px: Int16Array } where -1 is transparent, otherwise a PALETTE index.

const newIndexed = (w, h) => ({ w, h, px: new Int16Array(w * h).fill(-1) });

/** Colour vote for one source block: returns a PALETTE index, or -1 when the block is mostly empty. */
function voteBlock(img, mask, sx0, sx1, sy0, sy1) {
  const { width: W, data } = img;
  let total = 0;
  let opaque = 0;
  const votes = new Map();
  // Inner 70% of the block votes; block borders are where generators smear colours together.
  const iy0 = sy0 + Math.floor((sy1 - sy0) * 0.15);
  const iy1 = Math.max(iy0 + 1, sy1 - Math.floor((sy1 - sy0) * 0.15));
  const ix0 = sx0 + Math.floor((sx1 - sx0) * 0.15);
  const ix1 = Math.max(ix0 + 1, sx1 - Math.floor((sx1 - sx0) * 0.15));
  for (let y = sy0; y < sy1; y += 1) {
    for (let x = sx0; x < sx1; x += 1) {
      const p = y * W + x;
      total += 1;
      if (!mask[p]) continue;
      opaque += 1;
      if (y >= iy0 && y < iy1 && x >= ix0 && x < ix1) {
        const k = nearestIndex(data[p * 4], data[p * 4 + 1], data[p * 4 + 2]);
        votes.set(k, (votes.get(k) || 0) + 1);
      }
    }
  }
  if (opaque * 2 < total) return -1;
  if (!votes.size) {
    for (let y = sy0; y < sy1; y += 1) {
      for (let x = sx0; x < sx1; x += 1) {
        const p = y * W + x;
        if (mask[p]) {
          const k = nearestIndex(data[p * 4], data[p * 4 + 1], data[p * 4 + 2]);
          votes.set(k, (votes.get(k) || 0) + 1);
        }
      }
    }
  }
  let best = -1;
  let bestN = -1;
  for (const [k, c] of votes) if (c > bestN) { bestN = c; best = k; }
  return best;
}

function sampleSprite(img, mask, box, w, h, anchor, margin, fixedScale = null) {
  const out = newIndexed(w, h);
  const fit = Math.min((w - margin * 2) / box.w, (h - margin * 2) / box.h);
  const s = fixedScale ? Math.min(fixedScale, fit) : fit;
  const ow = Math.max(1, Math.round(box.w * s));
  const oh = Math.max(1, Math.round(box.h * s));
  const ox = Math.floor((w - ow) / 2);
  const oy = anchor === 'bottom' ? h - margin - oh : Math.floor((h - oh) / 2);
  for (let v = 0; v < oh; v += 1) {
    const sy0 = box.y0 + Math.floor((v * box.h) / oh);
    const sy1 = Math.max(sy0 + 1, box.y0 + Math.floor(((v + 1) * box.h) / oh));
    for (let u = 0; u < ow; u += 1) {
      const sx0 = box.x0 + Math.floor((u * box.w) / ow);
      const sx1 = Math.max(sx0 + 1, box.x0 + Math.floor(((u + 1) * box.w) / ow));
      out.px[(oy + v) * w + ox + u] = voteBlock(img, mask, sx0, sx1, sy0, sy1);
    }
  }
  return out;
}

/**
 * Scene layer: keeps the full image width (so a horizontally tileable layer stays tileable),
 * scales it to the native width and crops vertically toward the anchor edge.
 */
function sampleLayer(img, mask, w, h, anchor) {
  const out = newIndexed(w, h);
  const { width: W, height: H } = img;
  const srcPerPx = W / w;
  const needH = Math.min(H, Math.round(h * srcPerPx));
  const y0 = anchor === 'top' ? 0 : anchor === 'center' ? Math.floor((H - needH) / 2) : H - needH;
  const rows = Math.min(h, Math.round(needH / srcPerPx));
  const oy = anchor === 'top' ? 0 : anchor === 'center' ? Math.floor((h - rows) / 2) : h - rows;
  for (let v = 0; v < rows; v += 1) {
    const sy0 = y0 + Math.floor((v * needH) / rows);
    const sy1 = Math.max(sy0 + 1, y0 + Math.floor(((v + 1) * needH) / rows));
    for (let u = 0; u < w; u += 1) {
      const sx0 = Math.floor(u * srcPerPx);
      const sx1 = Math.max(sx0 + 1, Math.floor((u + 1) * srcPerPx));
      out.px[(oy + v) * w + u] = voteBlock(img, mask, sx0, sx1, sy0, sy1);
    }
  }
  return out;
}

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);

function sampleBackground(img, w, h, { dither = true } = {}) {
  const out = newIndexed(w, h);
  const { width: W, height: H, data } = img;
  // Cover-fit: crop the source to the target aspect ratio around its centre.
  const targetAR = w / h;
  let cw = W;
  let ch = Math.round(W / targetAR);
  if (ch > H) { ch = H; cw = Math.round(H * targetAR); }
  const cx = Math.floor((W - cw) / 2);
  const cy = Math.floor((H - ch) / 2);
  for (let v = 0; v < h; v += 1) {
    const sy0 = cy + Math.floor((v * ch) / h);
    const sy1 = Math.max(sy0 + 1, cy + Math.floor(((v + 1) * ch) / h));
    for (let u = 0; u < w; u += 1) {
      const sx0 = cx + Math.floor((u * cw) / w);
      const sx1 = Math.max(sx0 + 1, cx + Math.floor(((u + 1) * cw) / w));
      let L = 0; let A = 0; let B = 0; let n = 0;
      for (let y = sy0; y < sy1; y += 1) {
        for (let x = sx0; x < sx1; x += 1) {
          const p = (y * W + x) * 4;
          const lab = rgbToOklab(data[p], data[p + 1], data[p + 2]);
          L += lab[0]; A += lab[1]; B += lab[2]; n += 1;
        }
      }
      const mean = [L / n, A / n, B / n];
      let p1 = 0;
      let d1 = Infinity;
      for (let i = 0; i < PALETTE.length; i += 1) {
        const d = labDist2(mean, PALETTE[i].lab);
        if (d < d1) { d1 = d; p1 = i; }
      }
      let pick = p1;
      if (dither) {
        // Dither only between neighbouring steps of the same ramp: clean, readable gradients.
        const up = lighter(p1);
        const dn = darker(p1);
        const p2 = labDist2(mean, PALETTE[up].lab) < labDist2(mean, PALETTE[dn].lab) ? up : dn;
        if (p2 !== p1) {
          const a = PALETTE[p1].lab;
          const b = PALETTE[p2].lab;
          const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
          const len2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2 || 1;
          const t = ((mean[0] - a[0]) * ab[0] + (mean[1] - a[1]) * ab[1] + (mean[2] - a[2]) * ab[2]) / len2;
          if (t > 0.2 && t > BAYER4[(v % 4) * 4 + (u % 4)]) pick = p2;
        }
      }
      out.px[v * w + u] = pick;
    }
  }
  return out;
}

/* ---------------- cleanup ---------------- */

const N4 = [[0, -1], [-1, 0], [1, 0], [0, 1]];

function neighbours(im, x, y) {
  return N4.map(([dx, dy]) => {
    const nx = x + dx;
    const ny = y + dy;
    return nx < 0 || ny < 0 || nx >= im.w || ny >= im.h ? -1 : im.px[ny * im.w + nx];
  });
}

/** Merge colours used by very few pixels into their nearest frequent colour. */
export function mergeRareColours(im, { minShare = 0.004, minCount = 3 } = {}) {
  const counts = new Map();
  let total = 0;
  for (const k of im.px) if (k >= 0) { counts.set(k, (counts.get(k) || 0) + 1); total += 1; }
  const limit = Math.max(minCount, total * minShare);
  const keep = [...counts.keys()].filter((k) => counts.get(k) >= limit);
  if (!keep.length) return im;
  const remap = new Map();
  for (const k of counts.keys()) {
    if (counts.get(k) >= limit) continue;
    let best = keep[0];
    let bd = Infinity;
    for (const c of keep) {
      const d = labDist2(PALETTE[k].lab, PALETTE[c].lab);
      if (d < bd) { bd = d; best = c; }
    }
    remap.set(k, best);
  }
  for (let i = 0; i < im.px.length; i += 1) if (remap.has(im.px[i])) im.px[i] = remap.get(im.px[i]);
  return im;
}

/** Remove lone pixels, fill pin-holes, and drop single-pixel alpha islands. */
export function removeOrphans(im) {
  const next = im.px.slice();
  for (let y = 0; y < im.h; y += 1) {
    for (let x = 0; x < im.w; x += 1) {
      const i = y * im.w + x;
      const k = im.px[i];
      const nb = neighbours(im, x, y);
      const opaqueNb = nb.filter((v) => v >= 0);
      if (k >= 0 && opaqueNb.length === 0) { next[i] = -1; continue; }
      if (k < 0 && opaqueNb.length === 4) {
        next[i] = mode(opaqueNb);
        continue;
      }
      if (k >= 0 && !nb.includes(k) && opaqueNb.length >= 3) {
        const m = mode(opaqueNb);
        if (opaqueNb.filter((v) => v === m).length >= 3) next[i] = m;
      }
    }
  }
  im.px = next;
  return im;
}

/**
 * Silhouette fringe: a pixel on the edge whose colour family appears in none of its neighbours is
 * almost always background bleed (e.g. magenta mixed into a dark outline). Replace it with the
 * dominant neighbouring colour, or drop it when it barely touches the shape.
 */
export function cleanFringe(im) {
  const next = im.px.slice();
  for (let y = 0; y < im.h; y += 1) {
    for (let x = 0; x < im.w; x += 1) {
      const i = y * im.w + x;
      const k = im.px[i];
      if (k < 0) continue;
      const nb = neighbours(im, x, y);
      if (!nb.includes(-1)) continue;
      const opaque = nb.filter((v) => v >= 0);
      if (opaque.some((v) => PALETTE[v].ramp === PALETTE[k].ramp)) continue;
      next[i] = opaque.length >= 2 ? mode(opaque) : -1;
    }
  }
  im.px = next;
  return im;
}

function mode(list) {
  const c = new Map();
  let best = list[0];
  let bn = 0;
  for (const v of list) {
    const n = (c.get(v) || 0) + 1;
    c.set(v, n);
    if (n > bn) { bn = n; best = v; }
  }
  return best;
}

/* ---------------- shading layers ---------------- */

const isDark = (k) => PALETTE[k].lab[0] < 0.34;

/**
 * Selective outline ("sel-out"): the silhouette edge takes the darkest step of the ramp it borders,
 * near-black only on the shadow side (bottom/right), one step lighter on the lit side (top/left).
 * If the art already has a dark outline it is recoloured in place; otherwise a 1px ring is added.
 */
export function selectiveOutline(im) {
  const { w, h } = im;
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? -1 : im.px[y * w + x]);
  const edges = [];
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const k = at(x, y);
      if (k < 0) continue;
      if (at(x, y - 1) < 0 || at(x - 1, y) < 0 || at(x + 1, y) < 0 || at(x, y + 1) < 0) edges.push([x, y]);
    }
  }
  const darkShare = edges.length ? edges.filter(([x, y]) => isDark(at(x, y))).length / edges.length : 0;
  const next = im.px.slice();
  const outlineColour = (inner, shadowSide) => {
    const ramp = PALETTE[inner].ramp;
    return idxOf(ramp, shadowSide ? 0 : 1);
  };
  if (darkShare >= 0.55) {
    for (const [x, y] of edges) {
      const k = at(x, y);
      if (!isDark(k)) continue;
      // Look inward (away from the open side) for the material this outline wraps.
      const dirs = [[0, 1, at(x, y - 1) < 0], [1, 0, at(x - 1, y) < 0], [-1, 0, at(x + 1, y) < 0], [0, -1, at(x, y + 1) < 0]];
      let inner = -1;
      let shadowSide = false;
      for (const [dx, dy, open] of dirs) {
        if (!open) continue;
        for (let s = 1; s <= 3; s += 1) {
          const q = at(x + dx * s, y + dy * s);
          if (q >= 0 && !isDark(q)) { inner = q; break; }
        }
        shadowSide = shadowSide || dx === -1 || dy === -1;
        if (inner >= 0) break;
      }
      if (inner >= 0) next[y * w + x] = outlineColour(inner, shadowSide);
    }
  } else {
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        if (at(x, y) >= 0) continue;
        const below = at(x, y + 1);
        const right = at(x + 1, y);
        const above = at(x, y - 1);
        const left = at(x - 1, y);
        const inner = [above, left, right, below].find((v) => v >= 0);
        if (inner === undefined) continue;
        const shadowSide = above >= 0 || left >= 0; // outline sits below/right of the shape
        next[y * w + x] = outlineColour(inner, shadowSide);
      }
    }
  }
  im.px = next;
  im.outline = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const k = im.px[y * w + x];
      if (k < 0) continue;
      if (at(x, y - 1) < 0 || at(x - 1, y) < 0 || at(x + 1, y) < 0 || at(x, y + 1) < 0) im.outline[y * w + x] = 1;
    }
  }
  return im;
}

/** Key light from the top-left, rim light on the upper right, shade and contact occlusion at the bottom. */
export function applyLighting(im) {
  const { w, h } = im;
  const ol = im.outline || new Uint8Array(w * h);
  const isOl = (x, y) => x >= 0 && y >= 0 && x < w && y < h && (ol[y * w + x] === 1 || im.px[y * w + x] < 0);
  let top = h;
  let bottom = -1;
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) if (im.px[y * w + x] >= 0) { if (y < top) top = y; if (y > bottom) bottom = y; }
  const span = Math.max(1, bottom - top);
  const next = im.px.slice();
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      const k = im.px[i];
      if (k < 0 || ol[i]) continue;
      if (isDark(k)) continue; // leave interior line-art alone
      const rel = (y - top) / span;
      let shift = 0;
      if (isOl(x, y - 1) || isOl(x - 1, y)) shift += 1;
      if (isOl(x + 1, y) && rel < 0.6) shift += 1;
      if (isOl(x, y + 1)) shift -= 1;
      if (bottom - y <= 1) shift -= 1;
      if (shift > 0) next[i] = lighter(k, Math.min(1, shift));
      else if (shift < 0) next[i] = darker(k, 1);
    }
  }
  im.px = next;
  return im;
}

/* ---------------- entry points ---------------- */

export function indexedToRgba(im) {
  const data = new Uint8Array(im.w * im.h * 4);
  for (let i = 0; i < im.px.length; i += 1) {
    const k = im.px[i];
    if (k < 0) continue;
    const [r, g, b] = PALETTE[k].rgb;
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  }
  return { width: im.w, height: im.h, data };
}

/** Process a generated sprite image into native-resolution, palette-locked, shaded pixel art. */
/** Natural fit scale (native px per source px) of a sprite image; frames of one sequence share the smallest. */
export function spriteFitScale(img, { width, height, margin = 2 } = {}) {
  const mask = keyBackground(img);
  const box = maskBBox(mask, img.width, img.height);
  if (!box) return null;
  return Math.min((width - margin * 2) / box.w, (height - margin * 2) / box.h);
}

/** Cut a horizontal strip of `frames` equally wide frames into separate images. */
function cutPositions(profile, parts) {
  // Cut at the emptiest line near each expected boundary rather than at exact equal steps.
  const len = profile.length;
  const cuts = [0];
  const cell = len / parts;
  for (let k = 1; k < parts; k += 1) {
    const centre = Math.round(k * cell);
    const reach = Math.floor(cell * 0.35);
    let best = centre;
    for (let x = Math.max(cuts[k - 1] + 1, centre - reach); x <= Math.min(len - 1, centre + reach); x += 1) {
      if (profile[x] < profile[best] || (profile[x] === profile[best] && Math.abs(x - centre) < Math.abs(best - centre))) best = x;
    }
    cuts.push(best);
  }
  cuts.push(len);
  return cuts;
}

/** Cut a sprite sheet of `cols` x `rows` frames (row-major order) into separate images. */
export function sliceGrid(img, cols, rows = 1) {
  const { width: W, height: H } = img;
  const mask = keyBackground(img);
  const rowProfile = new Uint32Array(H);
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) rowProfile[y] += mask[y * W + x];
  const ys = cutPositions(rowProfile, rows);
  const frames = [];
  for (let r = 0; r < rows; r += 1) {
    // Column cuts are found per row, so a raised arm in one row cannot drag the cut of another.
    const colProfile = new Uint32Array(W);
    for (let y = ys[r]; y < ys[r + 1]; y += 1) for (let x = 0; x < W; x += 1) colProfile[x] += mask[y * W + x];
    const xs = cutPositions(colProfile, cols);
    for (let c = 0; c < cols; c += 1) {
      const x0 = xs[c];
      const y0 = ys[r];
      const fw = xs[c + 1] - x0;
      const fh = ys[r + 1] - y0;
      const data = new Uint8Array(fw * fh * 4);
      for (let y = 0; y < fh; y += 1) data.set(img.data.subarray(((y0 + y) * W + x0) * 4, ((y0 + y) * W + x0 + fw) * 4), y * fw * 4);
      frames.push({ width: fw, height: fh, data });
    }
  }
  return frames;
}

/** Cut a horizontal strip of `frames` frames into separate images. */
export const sliceStrip = (img, frames) => sliceGrid(img, frames, 1);

export function shadeSprite(img, { width, height, anchor = 'bottom', margin = 2, outline = true, lighting = false, scale = null } = {}) {
  const mask = keyBackground(img);
  const box = maskBBox(mask, img.width, img.height);
  if (!box) throw new Error('Image is empty after removing the background');
  let im = sampleSprite(suppressSpill(img, mask), mask, box, width, height, anchor, margin, scale);
  im = mergeRareColours(im);
  im = removeOrphans(im);
  im = cleanFringe(im);
  if (outline) im = selectiveOutline(im);
  if (lighting) im = applyLighting(im);
  return { image: indexedToRgba(im), colours: new Set([...im.px].filter((k) => k >= 0)).size };
}

/** Process a generated background into native-resolution, palette-locked, dithered pixel art. */
/** Process a transparent scene layer (clouds, mountains, tree line...) without outlines or relighting. */
export function shadeLayer(img, { width, height, anchor = 'bottom' } = {}) {
  const mask = keyBackground(img);
  let im = sampleLayer(suppressSpill(img, mask), mask, width, height, anchor);
  im = mergeRareColours(im, { minShare: 0.001, minCount: 4 });
  im = removeOrphans(im);
  im = cleanFringe(im);
  return { image: indexedToRgba(im), colours: new Set([...im.px].filter((k) => k >= 0)).size };
}

export function shadeBackground(img, { width, height, dither = true } = {}) {
  let im = sampleBackground(img, width, height, { dither });
  im = mergeRareColours(im, { minShare: 0.0008, minCount: 4 });
  return { image: indexedToRgba(im), colours: new Set([...im.px]).size };
}
