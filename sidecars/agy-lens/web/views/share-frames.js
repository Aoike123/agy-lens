// Frame materials for the pixel cards: each duel arena gets a frame made from its own world
// material, all built with one grammar so the cards read as one set:
//   1px outline (ramp[0]) with cut corners
//   4px bevel band lit from the upper left: highlight, two body rows, inner shadow
//   a material texture on the band (rivets, planks, facets, stitches...)
//   an 8x8 corner boss with the material's motif
//   1px inner outline, then the panel fill
// Ramps are picked from each arena painting so frame and scene share colours.

export const MATERIALS = {
  'archive-garden': { // carved jade-green stone with moss
    ramp: ['#0d1a12', '#1f3a2a', '#3f6b4a', '#6f9e62', '#c3dc8a'], accent: ['#2f8f7a', '#5fd0b4'],
    fill: ['#111c16', '#17261d'], texture: 'moss', motif: 'leaf',
  },
  caravan: { // sun-bleached awning canvas with rope stitching
    ramp: ['#2a160a', '#6b3e1f', '#b0743a', '#dcae6c', '#f8e2ac'], accent: ['#8a6a3a', '#e8d4a0'],
    fill: ['#2c1c10', '#382414'], texture: 'stitch', motif: 'knot',
  },
  foundry: { // scorched riveted iron with ember edges
    ramp: ['#0e0a0a', '#2c2222', '#4c3e3c', '#786660', '#b0988a'], accent: ['#c8401a', '#ffa040'],
    fill: ['#150f0f', '#1d1515'], texture: 'rivet', motif: 'rivet',
  },
  'lantern-academy': { // red lacquered timber with gold trim
    ramp: ['#1a0606', '#6a1212', '#b02820', '#de5a3a', '#ffb070'], accent: ['#b07a20', '#f4cc60'],
    fill: ['#1c1216', '#24161c'], texture: 'trim', motif: 'lantern',
  },
  observatory: { // polished brass against the night sky
    ramp: ['#140e06', '#5a3a12', '#a06a1e', '#d8a040', '#fff0a0'], accent: ['#4a64c8', '#cfe0ff'],
    fill: ['#0c1230', '#121a3e'], texture: 'rivet', motif: 'star',
  },
  'pearl-quay': { // weathered quay planks, sea-teal paint and pearls
    ramp: ['#16120e', '#463c32', '#76695a', '#ab9e88', '#e6dece'], accent: ['#1f9e9a', '#f8f2e6'],
    fill: ['#12222a', '#182c34'], texture: 'plank', motif: 'pearl',
  },
  'salt-canyon': { // layered rust rock with a salt crust
    ramp: ['#1e0a08', '#682214', '#ae4826', '#de7a44', '#f6e6ee'], accent: ['#c890b8', '#fff4fa'],
    fill: ['#26121a', '#30161e'], texture: 'salt', motif: 'crystal',
  },
  thunderrail: { // riveted steel girder, signal lamps
    ramp: ['#08080e', '#22202c', '#403c50', '#6c6880', '#aaa4c4'], accent: ['#7ab020', '#c8f050'],
    fill: ['#12101c', '#181626'], texture: 'girder', motif: 'rivet',
  },
  vault: { // frozen crystal with an amber memory core
    ramp: ['#081220', '#173656', '#3574aa', '#78bcee', '#e2f8ff'], accent: ['#c07a18', '#ffc050'],
    fill: ['#0a141e', '#0e1a28'], texture: 'facet', motif: 'crystal',
  },
  windmill: { // timber, straw and barn red
    ramp: ['#1c1208', '#58381a', '#8c6030', '#c69856', '#f4dc8a'], accent: ['#a02e22', '#e0583e'],
    fill: ['#261c12', '#30241a'], texture: 'grain', motif: 'nail',
  },
};

export const DEFAULT_MATERIAL = 'observatory';

export function materialFor(arenaId, theme = 'dark') {
  const base = MATERIALS[arenaId] || MATERIALS[DEFAULT_MATERIAL];
  if (theme !== 'light') return base;
  return {
    ...base,
    fill: ['#efe1be', '#e4d2a6'],
    isLight: true,
  };
}

/** Text colours that read on each material's fill. */
export function inkFor(mat) {
  if (mat && mat.isLight) {
    return {
      text: '#2c1b0e',
      sub: '#694a2d',
      dim: '#9a7e5c',
      gold: '#9c560c',
      goldDark: '#633404',
      topHi: '#8c2c0e',
    };
  }
  return {
    text: '#f6efd9',
    sub: mixHex(mat.ramp[3], '#f6efd9', 0.35),
    dim: mixHex(mat.ramp[2], mat.fill[1], 0.2),
    gold: '#f6c453',
    goldDark: '#b5791f',
    topHi: '#fff6c4',
  };
}

function mixHex(a, b, t) {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  return `#${pa.map((v, i) => Math.round(v + (pb[i] - v) * t).toString(16).padStart(2, '0')).join('')}`;
}

// 4x4 motifs placed in the centre of the corner boss (letters index the ramp / accent).
const MOTIFS = {
  rivet: ['.hl.', 'hlmd', 'lmdd', '.dd.'],
  star: ['.A..', 'AaA.', '.A..', '...a'],
  pearl: ['.PP.', 'PPPa', 'PPa.', '.a..'],
  crystal: ['..A.', '.Aa.', '.aa.', '..a.'],
  knot: ['.aa.', 'aAAa', 'aAAa', '.aa.'],
  lantern: ['.dd.', 'aAAa', 'aAAa', '.dd.'],
  leaf: ['..aA', '.aA.', 'aA..', 'd...'],
  nail: ['....', '.hl.', '.ld.', '....'],
};

const BOSS = ['.oooooo.', 'ohhllllo', 'olmmmmdo', 'olmmmmdo', 'olmmmmdo', 'olmmmmdo', 'omddddmo', '.oooooo.'];

function tone(mat, ch) {
  switch (ch) {
    case 'o': return mat.ramp[0];
    case 'd': return mat.ramp[1];
    case 'm': return mat.ramp[2];
    case 'l': return mat.ramp[3];
    case 'h': return mat.ramp[4];
    case 'a': return mat.accent[0];
    case 'A': return mat.accent[1];
    case 'P': return '#f8f4ec';
    default: return null;
  }
}

function drawBoss(pix, mat, x, y) {
  const motif = MOTIFS[mat.motif] || MOTIFS.rivet;
  for (let j = 0; j < 8; j += 1) {
    for (let i = 0; i < 8; i += 1) {
      let ch = BOSS[j][i];
      if (i >= 2 && i < 6 && j >= 2 && j < 6) {
        const m = motif[j - 2][i - 2];
        if (m !== '.') ch = m;
      }
      const c = tone(mat, ch);
      if (c) pix.set(x + i, y + j, c);
    }
  }
}

const hash2 = (x, y) => (((x * 73856093) ^ (y * 19349663)) >>> 0) % 997;

/** Texture tone for a band pixel at position `u` along the edge, depth `d` (0..3), or null. */
function textureAt(mat, kind, u, d, horizontal) {
  switch (kind) {
    case 'rivet': {
      const k = (u + 4) % 12;
      if ((k === 0 || k === 1) && (d === 1 || d === 2)) return k === 0 && d === 1 ? mat.ramp[4] : mat.ramp[1];
      return null;
    }
    case 'plank':
      if (u % 14 === 0 && d > 0) return mat.ramp[1];
      if (u % 14 === 1 && d > 0) return mat.ramp[3];
      if (d === 2 && hash2(u, 7) % 9 === 0) return mat.ramp[1];
      return null;
    case 'moss':
      if (d <= 1 && hash2(u, d) % 5 === 0) return hash2(u, 3) % 2 ? mat.accent[0] : mat.accent[1];
      return null;
    case 'salt':
      if (horizontal && d <= 1 && hash2(u, d) % 3 === 0) return mat.ramp[4];
      if (d === 2 && hash2(u, 5) % 11 === 0) return mat.ramp[1];
      return null;
    case 'facet': {
      const k = u % 8;
      if (k === d) return mat.ramp[4];
      if (k === d + 1) return mat.ramp[3];
      if (u % 23 === 0 && d === 2) return mat.accent[1];
      return null;
    }
    case 'stitch':
      if (d === 2 && u % 4 < 2) return mat.accent[1];
      return null;
    case 'grain':
      if (d === 1 && hash2(u, 1) % 4 === 0) return mat.ramp[1];
      if (d === 2 && hash2(u, 2) % 6 === 0) return mat.ramp[3];
      return null;
    case 'girder': {
      const k = u % 8;
      if ((d === 1 && (k === 1 || k === 6)) || (d === 2 && (k === 2 || k === 5))) return mat.ramp[1];
      if ((u + 4) % 16 === 0 && d === 1) return mat.accent[1];
      return null;
    }
    case 'trim':
      if (d === 1) return mat.accent[1];
      if (d === 2 && u % 10 === 0) return mat.accent[0];
      return null;
    default:
      return null;
  }
}

/**
 * Material frame. `fill: false` leaves the inside transparent (frames around artwork).
 * `band` is the bevel width (4 default, 3 for small plaques); `bosses` draws corner bosses.
 */
export function drawFrame(pix, mat, x, y, w, h, { fill = true, band = 4, bosses = true } = {}) {
  const O = mat.ramp[0];
  // Outline with cut corners.
  pix.hline(x + 1, y, w - 2, O);
  pix.hline(x + 1, y + h - 1, w - 2, O);
  pix.vline(x, y + 1, h - 2, O);
  pix.vline(x + w - 1, y + 1, h - 2, O);
  // Bevel band.
  const bevel = (d, lit) => {
    if (d === 0) return lit ? mat.ramp[4] : mat.ramp[1];
    if (d === band - 1) return lit ? mat.ramp[1] : mat.ramp[3];
    return d === 1 ? mat.ramp[3] : mat.ramp[2];
  };
  for (let d = 0; d < band; d += 1) {
    const x0 = x + 1 + d;
    const y0 = y + 1 + d;
    const x1 = x + w - 2 - d;
    const y1 = y + h - 2 - d;
    for (let u = x0; u <= x1; u += 1) {
      pix.set(u, y0, textureAt(mat, mat.texture, u - x, d, true) || bevel(d, true));
      pix.set(u, y1, textureAt(mat, mat.texture, u - x, d, true) || bevel(d, false));
    }
    for (let v = y0 + 1; v < y1; v += 1) {
      pix.set(x0, v, textureAt(mat, mat.texture, v - y, d, false) || bevel(d, true));
      pix.set(x1, v, textureAt(mat, mat.texture, v - y, d, false) || bevel(d, false));
    }
  }
  // Inner outline and fill.
  const ix = x + 1 + band;
  const iy = y + 1 + band;
  const iw = w - 2 - 2 * band;
  const ih = h - 2 - 2 * band;
  pix.hline(ix, iy, iw, O);
  pix.hline(ix, iy + ih - 1, iw, O);
  pix.vline(ix, iy, ih, O);
  pix.vline(ix + iw - 1, iy, ih, O);
  if (fill) {
    pix.rect(ix + 1, iy + 1, iw - 2, ih - 2, mat.fill[0]);
    // Lit inner lip: one row of the lighter fill, dithered into the second.
    pix.hline(ix + 1, iy + 1, iw - 2, mat.fill[1]);
    for (let i = 0; i < iw - 2; i += 2) pix.set(ix + 1 + i, iy + 2, mat.fill[1]);
  }
  if (bosses && w >= 24 && h >= 24) {
    drawBoss(pix, mat, x - 2, y - 2);
    drawBoss(pix, mat, x + w - 6, y - 2);
    drawBoss(pix, mat, x - 2, y + h - 6);
    drawBoss(pix, mat, x + w - 6, y + h - 6);
  }
  return { x: ix + 1, y: iy + 1, w: iw - 2, h: ih - 2 };
}

/** Small plaque (banner / tag) in the same material: 3px band, no bosses. */
export function drawPlaque(pix, mat, x, y, w, h) {
  return drawFrame(pix, mat, x, y, w, h, { band: 3, bosses: false });
}

/**
 * Recessed bevelled relic socket for 24x24 achievement badges so they never float on flat black.
 */
export function drawRelicSocket(pix, mat, x, y, size = 28, unlocked = true) {
  const O = mat.ramp[0];
  const hi = unlocked ? mat.ramp[3] : mat.ramp[1];
  const lo = unlocked ? mat.ramp[1] : O;
  const well = unlocked ? '#101428' : '#131622';
  pix.hline(x + 1, y, size - 2, O);
  pix.hline(x + 1, y + size - 1, size - 2, O);
  pix.vline(x, y + 1, size - 2, O);
  pix.vline(x + size - 1, y + 1, size - 2, O);
  pix.hline(x + 1, y + 1, size - 2, hi);
  pix.vline(x + 1, y + 1, size - 2, hi);
  pix.hline(x + 2, y + size - 2, size - 3, lo);
  pix.vline(x + size - 2, y + 2, size - 3, lo);
  pix.rect(x + 2, y + 2, size - 4, size - 4, well);
  if (unlocked) {
    pix.hline(x + 2, y + 2, size - 4, mat.fill[1]);
    pix.set(x + 1, y + 1, mat.ramp[4]);
    pix.set(x + size - 2, y + 1, mat.accent[1]);
    pix.set(x + 1, y + size - 2, mat.accent[0]);
  }
  return { x: x + 2, y: y + 2, w: size - 4, h: size - 4 };
}

/**
 * Compact 2px-bevelled ribbon plaque with optional accent stripes (left or symmetric left+right).
 */
export function drawRibbonPlate(pix, mat, x, y, w, h, { accent = null, accentBoth = false, fill = null, band = 2 } = {}) {
  const inner = drawFrame(pix, mat, x, y, w, h, { band, bosses: false, fill: !fill });
  if (fill) {
    pix.rect(inner.x, inner.y, inner.w, inner.h, fill);
    pix.hline(inner.x, inner.y, inner.w, mat.fill[1]);
  }
  if (accent && inner.h >= 4) {
    pix.rect(inner.x, inner.y, 2, inner.h, accent);
    pix.set(inner.x, inner.y, '#fff6d6');
    if (accentBoth && inner.w >= 6) {
      pix.rect(inner.x + inner.w - 2, inner.y, 2, inner.h, accent);
      pix.set(inner.x + inner.w - 1, inner.y, '#fff6d6');
    }
  }
  return inner;
}

/** Draw a compact 1:1 pixel sprite from ASCII rows and a hex palette map. */
export function drawPixelSprite(pix, rows, pal, x, y, { flip = false } = {}) {
  const h = rows.length;
  const w = h ? rows[0].length : 0;
  for (let r = 0; r < h; r += 1) {
    for (let q = 0; q < w; q += 1) {
      const ch = rows[r][q];
      if (ch === '.' || ch === ' ') continue;
      const col = pal[ch];
      if (col) pix.set(x + (flip ? w - 1 - q : q), y + r, col);
    }
  }
}

/** Sculpted horizontal filigree divider with tapered metal wings and a faceted center gem. */
export function drawFiligreeDivider(pix, mat, x, y, w) {
  const mid = Math.round(x + w / 2);
  pix.hline(x + 2, y, w - 4, mat.ramp[1]);
  pix.hline(x + 8, y + 1, w - 16, mat.ramp[0]);
  pix.hline(x + 1, y, 5, mat.ramp[2]);
  pix.hline(x + w - 6, y, 5, mat.ramp[2]);
  pix.set(x, y, mat.ramp[3]);
  pix.set(x + w - 1, y, mat.ramp[3]);
  // Center diamond gem
  pix.rect(mid - 2, y - 1, 5, 3, mat.ramp[0]);
  pix.hline(mid - 1, y, 3, mat.accent[0]);
  pix.vline(mid, y - 1, 3, mat.accent[1]);
  pix.set(mid, y, '#ffffff');
}
