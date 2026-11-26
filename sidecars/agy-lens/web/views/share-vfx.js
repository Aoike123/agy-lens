// Procedural pixel-art ambient atmosphere engine on the 400x210 native grid.
// Dual-buffer architecture (opaque/dithered `color` + stepped additive `light`).
// Pure ES module: zero DOM globals, runs in Node (static role card SVG) and Browser (live canvas).

export const VFX_W = 400;
export const VFX_H = 210;

const TAU = Math.PI * 2;
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
const CROSS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

const lerp = (a, b, t) => a + (b - a) * t;

class Rng {
  constructor(seed = 1) {
    this.s = (seed >>> 0) || 1;
  }
  next() {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a, b) { return a + (b - a) * this.next(); }
}

const rgb = (r, g, b) => (255 << 24) | ((b & 255) << 16) | ((g & 255) << 8) | (r & 255);
const red = (c) => c & 255;
const green = (c) => (c >>> 8) & 255;
const blue = (c) => (c >>> 16) & 255;

function hex(h) {
  if (typeof h === 'number') return h;
  let s = String(h || '#ffffff').replace('#', '');
  if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  const v = parseInt(s.slice(0, 6), 16) || 0;
  return rgb((v >> 16) & 255, (v >> 8) & 255, v & 255);
}

const toHex = (c) => `#${[red(c), green(c), blue(c)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
const WHITE = hex('#ffffff');

export function createVfxFrame(w = VFX_W, h = VFX_H, ox = 0, oy = 0) {
  return { w, h, ox, oy, color: new Uint32Array(w * h), light: new Uint32Array(w * h) };
}

export function clearVfxFrame(f) {
  f.color.fill(0);
  f.light.fill(0);
  return f;
}

/** Quantize light falloff into 3 crisp pixel-art steps with Bayer dither on the outer halo. */
function pixelLightStep(f, sx, sy) {
  if (f > 0.72) return 1.0;
  if (f > 0.42) return 0.52;
  return BAYER[((sy & 3) << 2) | (sx & 3)] < 0.5 ? 0.24 : 0;
}

class AmbientPainter {
  constructor(frame) {
    this.w = frame.w;
    this.h = frame.h;
    this.ox = frame.ox | 0;
    this.oy = frame.oy | 0;
    this.C = frame.color;
    this.L = frame.light;
  }
  put(sx, sy, c, a = 1) {
    if (!c) return;
    if (a < 1 && a <= BAYER[((sy & 3) << 2) | (sx & 3)]) return;
    const x = sx - this.ox;
    const y = sy - this.oy;
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    this.C[y * this.w + x] = c;
  }
  add(sx, sy, c, k = 1) {
    if (k <= 0.01) return;
    const x = sx - this.ox;
    const y = sy - this.oy;
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = y * this.w + x;
    const d = this.L[i];
    const r = Math.min(255, (d & 255) + (c & 255) * k) | 0;
    const g = Math.min(255, ((d >>> 8) & 255) + ((c >>> 8) & 255) * k) | 0;
    const b = Math.min(255, ((d >>> 16) & 255) + ((c >>> 16) & 255) * k) | 0;
    this.L[i] = (255 << 24) | (b << 16) | (g << 8) | r;
  }
  px(x, y, c) { this.put(Math.floor(x), Math.floor(y), c, 1); }
  dot(x, y, c, a = 1) { if (a > 0) this.put(Math.floor(x), Math.floor(y), c, a); }
  line(x0, y0, x1, y1, c, a = 1) {
    let sx = Math.floor(x0);
    let sy = Math.floor(y0);
    const ex = Math.floor(x1);
    const ey = Math.floor(y1);
    const dx = Math.abs(ex - sx);
    const dy = -Math.abs(ey - sy);
    const stepx = sx < ex ? 1 : -1;
    const stepy = sy < ey ? 1 : -1;
    const n = Math.max(dx, -dy) || 1;
    const fc = typeof c === 'function';
    const fa = typeof a === 'function';
    let err = dx + dy;
    let i = 0;
    for (;;) {
      const u = i++ / n;
      this.put(sx, sy, fc ? c(u) : c, fa ? a(u) : a);
      if (sx === ex && sy === ey) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; sx += stepx; }
      if (e2 <= dx) { err += dx; sy += stepy; }
    }
  }
  polyline(pts, c, a = 1) {
    for (let i = 1; i < pts.length; i += 1) this.line(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1], c, a);
  }
  glow(cx, cy, r, c, k = 0.5) {
    const rr = r * 0.72;
    if (rr < 1 || k <= 0.01) return;
    const x0 = Math.floor(cx - rr);
    const x1 = Math.ceil(cx + rr);
    const y0 = Math.floor(cy - rr);
    const y1 = Math.ceil(cy + rr);
    for (let sy = y0; sy <= y1; sy += 1) {
      const dy = (sy + 0.5 - cy) / rr;
      for (let sx = x0; sx <= x1; sx += 1) {
        const dx = (sx + 0.5 - cx) / rr;
        const d = dx * dx + dy * dy;
        if (d >= 1) continue;
        const step = pixelLightStep(1 - Math.sqrt(d), sx, sy);
        if (step > 0) this.add(sx, sy, c, step * k);
      }
    }
  }
}

export function compositeVfx(f, out, lightK = 1) {
  const n = f.w * f.h;
  const C = f.color;
  const L = f.light;
  for (let i = 0; i < n; i += 1) {
    const c = C[i];
    const l = L[i] & 0xffffff;
    let r = c & 255;
    let g = (c >>> 8) & 255;
    let b = (c >>> 16) & 255;
    let a = c >>> 24;
    if (l) {
      const lr = (l & 255) * lightK;
      const lg = ((l >>> 8) & 255) * lightK;
      const lb = ((l >>> 16) & 255) * lightK;
      if (a < 255) {
        const pa = a / 255;
        const pr = r * pa + lr;
        const pg = g * pa + lg;
        const pb = b * pa + lb;
        const na = Math.min(1, Math.max(pa, Math.max(lr, lg, lb) / 255));
        if (na > 0) { r = Math.min(255, pr / na); g = Math.min(255, pg / na); b = Math.min(255, pb / na); a = na * 255; }
      } else {
        r = Math.min(255, r + lr);
        g = Math.min(255, g + lg);
        b = Math.min(255, b + lb);
      }
    }
    const j = i * 4;
    out[j] = r;
    out[j + 1] = g;
    out[j + 2] = b;
    out[j + 3] = a;
  }
  return out;
}

/** Sparse native-pixel SVG conversion for static exported role cards. */
export function vfxFrameToSvg(frame, scale = 3, { clipX = 0, clipW = frame.w } = {}) {
  const x0 = Math.max(0, Math.floor(clipX));
  const x1 = Math.min(frame.w, Math.ceil(clipX + clipW));
  const byCol = new Map();
  const pushRun = (key, rx, ry, rw) => {
    const prev = byCol.get(key) || '';
    byCol.set(key, `${prev}M${rx * scale} ${ry * scale}h${rw * scale}v${scale}h-${rw * scale}z`);
  };
  for (let y = 0; y < frame.h; y += 1) {
    let x = x0;
    while (x < x1) {
      const idx = y * frame.w + x;
      const c = frame.color[idx];
      const l = frame.light[idx] & 0xffffff;
      let key = '';
      if ((c >>> 24) >= 140) {
        key = `${toHex(c)}|1`;
      } else if (l) {
        const mx = Math.max(l & 255, (l >>> 8) & 255, (l >>> 16) & 255);
        if (mx >= 110) key = `${toHex(l)}|${mx >= 190 ? '0.65' : '0.35'}`;
      }
      if (!key) { x += 1; continue; }
      let end = x + 1;
      while (end < x1) {
        const ni = y * frame.w + end;
        const nc = frame.color[ni];
        const nl = frame.light[ni] & 0xffffff;
        let nkey = '';
        if ((nc >>> 24) >= 140) nkey = `${toHex(nc)}|1`;
        else if (nl) {
          const nmx = Math.max(nl & 255, (nl >>> 8) & 255, (nl >>> 16) & 255);
          if (nmx >= 110) nkey = `${toHex(nl)}|${nmx >= 190 ? '0.65' : '0.35'}`;
        }
        if (nkey !== key) break;
        end += 1;
      }
      pushRun(key, x, y, end - x);
      x = end;
    }
  }
  return [...byCol.entries()].map(([k, d]) => {
    const [col, op] = k.split('|');
    return op === '1' ? `<path d="${d}" fill="${col}"/>` : `<path d="${d}" fill="${col}" opacity="${op}"/>`;
  }).join('');
}

function bolt(r, x0, y0, x1, y1, { jag = 0.22, depth = 3 } = {}) {
  let pts = [[x0, y0], [x1, y1]];
  for (let d = 0; d < depth; d += 1) {
    const next = [pts[0]];
    for (let i = 1; i < pts.length; i += 1) {
      const [ax, ay] = pts[i - 1];
      const [bx, by] = pts[i];
      const dx = bx - ax;
      const dy = by - ay;
      const L = Math.hypot(dx, dy);
      const off = (r.next() * 2 - 1) * jag * L;
      next.push([(ax + bx) / 2 + (-dy / (L || 1)) * off, (ay + by) / 2 + (dx / (L || 1)) * off], pts[i]);
    }
    pts = next;
  }
  return pts;
}

function sparkle(p, x, y, arm, c, tip = c, k = 0.6) {
  const n = Math.round(arm);
  if (n < 1) return;
  const X = Math.floor(x);
  const Y = Math.floor(y);
  for (let d = 1; d <= n; d += 1) {
    const cc = d > n * 0.6 ? tip : c;
    for (const [dx, dy] of CROSS) p.px(X + dx * d, Y + dy * d, cc);
  }
  if (n >= 3) for (const [dx, dy] of DIAG) p.px(X + dx, Y + dy, c);
  p.px(X, Y, WHITE);
  p.glow(x, y, 4 + n * 2, c, k);
}

export const ARENA_AMBIENT_IDS = [
  'archive-garden', 'caravan', 'foundry', 'lantern-academy', 'observatory',
  'pearl-quay', 'salt-canyon', 'thunderrail', 'vault', 'windmill',
];

export function createAmbientFx(arenaId = 'observatory', seed = 1) {
  const R = new Rng(seed + [...String(arenaId)].reduce((a, c) => a + c.charCodeAt(0), 0) * 17);
  let t = 0;
  const count = arenaId === 'thunderrail' ? 28 : 16;
  const motes = Array.from({ length: count }, (_, i) => ({
    x: R.range(6, VFX_W - 6),
    y: R.range(12, VFX_H - 18),
    phase: R.range(0, TAU),
    speed: R.range(1.2, 3.2),
    size: R.range(0.6, 1.8),
    i,
  }));

  return {
    update(dt) {
      t += dt;
      for (const m of motes) {
        if (arenaId === 'thunderrail') {
          m.x -= 48 * dt;
          m.y += 145 * dt;
          if (m.y > VFX_H - 14 || m.x < 0) { m.x = R.range(20, VFX_W + 40); m.y = R.range(-10, 20); }
        } else if (arenaId === 'salt-canyon') {
          m.x += (28 + m.size * 10) * dt;
          m.y += Math.sin(t * 2 + m.phase) * 4 * dt;
          if (m.x > VFX_W) { m.x = -4; m.y = R.range(70, VFX_H - 18); }
        } else if (arenaId === 'foundry' || arenaId === 'lantern-academy') {
          m.y -= (10 + m.size * 6) * dt;
          m.x += Math.sin(t * m.speed + m.phase) * 9 * dt;
          if (m.y < 14) { m.y = VFX_H - 20; m.x = R.range(14, VFX_W - 14); }
        } else if (arenaId === 'observatory') {
          m.x += Math.sin(t * 0.4 + m.phase) * 1.5 * dt;
        } else if (arenaId === 'vault' || arenaId === 'pearl-quay') {
          m.y += Math.sin(t * m.speed + m.phase) * 4 * dt;
          m.x += Math.cos(t * 0.8 + m.phase) * 5 * dt;
        } else {
          m.x += Math.cos(t * 0.9 + m.phase) * 7 * dt + (arenaId === 'windmill' ? 10 * dt : 0);
          m.y += Math.sin(t * 1.3 + m.phase) * 5 * dt;
          if (m.x > VFX_W) m.x = 2;
          if (m.x < 0) m.x = VFX_W - 2;
        }
      }
    },
    draw(frame) {
      const p = new AmbientPainter(frame);
      for (const m of motes) {
        const throb = 0.5 + 0.5 * Math.sin(t * m.speed * 1.4 + m.phase);
        if (arenaId === 'foundry') {
          const c = throb > 0.6 ? hex('#ffe08a') : hex('#ff7a2a');
          p.px(m.x, m.y, c);
          if (m.size > 1.2) p.px(m.x, m.y + 1, hex('#a8301a'));
          p.glow(m.x, m.y, 3.5, c, 0.25 * throb);
        } else if (arenaId === 'observatory') {
          if (throb > 0.72) sparkle(p, m.x, Math.min(m.y, 130), m.size > 1.4 ? 2 : 1, hex('#cfe0ff'), hex('#7cc8ff'), 0.28 * throb);
          else if (throb > 0.35) p.dot(m.x, Math.min(m.y, 130), hex('#fff0a0'), 0.65);
        } else if (arenaId === 'vault') {
          const c = throb > 0.5 ? hex('#d8f4ff') : hex('#78bcee');
          p.dot(m.x, m.y, c, 0.6 + 0.35 * throb);
          if (m.i % 4 === 0 && throb > 0.68) sparkle(p, m.x, m.y, 1, c, hex('#3574aa'), 0.24 * throb);
        } else if (arenaId === 'archive-garden') {
          const c = m.i % 3 === 0 ? hex('#ffe066') : hex('#86ecbf');
          if (throb > 0.3) { p.px(m.x, m.y, c); p.glow(m.x, m.y, 3.5, c, 0.32 * throb); }
        } else if (arenaId === 'lantern-academy') {
          const c = throb > 0.5 ? hex('#ffbe55') : hex('#ff6a3a');
          p.dot(m.x, m.y, c, 0.65 + 0.35 * throb);
          p.glow(m.x, m.y, 4, c, 0.26 * throb);
        } else if (arenaId === 'pearl-quay') {
          const y = Math.min(m.y, 168);
          if (m.i % 3 === 0 && throb > 0.55) sparkle(p, m.x, Math.max(118, y), 1, hex('#c4ecff'), hex('#36a2e0'), 0.25 * throb);
          else p.dot(m.x, y, hex('#e6f8ff'), 0.45 * throb);
        } else if (arenaId === 'thunderrail') {
          p.line(m.x, m.y, m.x - 2, m.y + 5, hex('#7cc8ff'), 0.48);
          if (m.i === 0 && Math.sin(t * 7) > 0.92) {
            const b = bolt(R, 76, 36, 92, 64, { jag: 0.3, depth: 3 });
            p.polyline(b, hex('#c8f0ff'), 0.9);
            p.glow(84, 50, 10, hex('#3f8cff'), 0.35);
          }
        } else if (arenaId === 'salt-canyon') {
          p.line(m.x, m.y, m.x - 3, m.y, hex('#ffd2a8'), 0.45 * throb);
        } else if (arenaId === 'windmill') {
          if (m.i % 4 === 0) {
            p.px(m.x, m.y, hex('#d88a32'));
            p.px(m.x + 1, m.y + 1, hex('#f4dc8a'));
          } else {
            p.dot(m.x, m.y, hex('#fff0a0'), 0.5 + 0.4 * throb);
          }
        } else {
          const c = throb > 0.5 ? hex('#fff0a0') : hex('#e8b85a');
          p.dot(m.x, m.y, c, 0.5 + 0.4 * throb);
          if (m.size > 1.4 && throb > 0.6) p.glow(m.x, m.y, 3.5, c, 0.2 * throb);
        }
      }
      if (arenaId === 'observatory') {
        const cyc = t % 4.5;
        if (cyc < 0.7) {
          const u = cyc / 0.7;
          const sx = lerp(290, 200, u);
          const sy = lerp(22, 64, u);
          p.line(sx, sy, sx + 10, sy - 5, hex('#fff6c4'), 1 - u);
          p.px(sx, sy, WHITE);
          p.glow(sx, sy, 4, hex('#cfe0ff'), 0.45 * (1 - u));
        }
      }
    },
  };
}

export function renderStaticAmbientSvg(arenaId = 'observatory', { seed = 1, t = 1.35, clipX = 0, clipW = VFX_W } = {}) {
  const frame = createVfxFrame();
  const fx = createAmbientFx(arenaId, seed);
  const steps = Math.max(1, Math.round(t * 20));
  for (let i = 0; i < steps; i += 1) fx.update(t / steps);
  fx.draw(frame);
  return vfxFrameToSvg(frame, 3, { clipX, clipW });
}
