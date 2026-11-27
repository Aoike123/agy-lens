// Sanitized History Share Card SVG generator, modal preview, and SVG/PNG exporters.
// buildShareCardSvg, escapeXml, and scrubSensitiveText are pure Node-runnable with zero DOM/browser globals.

import { createTranslator, normalizeLang } from '../i18n.js';
import { dayKey, esc, fmtCost, fmtInt, fmtPctNum, fmtTok, getJson, isNum, makeHeatScale, parseDay, postJson } from '../format.js';
import {
  FONT_DISPLAY, FONT_MONO, FONT_SANS, FONT_SERIF, ISO_DAY_RE, SHARE_STYLE_SPECS, VALID_PERIODS,
  buildAbyssalCardSvg, buildBauhausCardSvg, buildEclipseCardSvg, buildPhosphorCardSvg,
  escapeXml, formatDayTick, formatMonthLabel, quipText, safeNum, sanitizeDaily, sanitizeHourly,
  sanitizeModels, sanitizeShareCardInput, scrubSensitiveText, textVisualUnits, truncateByWidth,
} from './share-styles.js';
import {
  CLASS_ARENA, SPRITE_CELL, arenaPath, buildProfile, buildQuips, charIdlePath, charStillPath,
  sanitizeNickname, usageAchievements,
} from './share-game.js';
import {
  FLOOR_Y, NATIVE_H, NATIVE_W, PIXEL_H, PIXEL_W, buildRoleCardLayout, buildRoleCardSvg,
  placeholderSpritePix, spriteBox,
} from './share-pixel.js';
import {
  decodeAnimatedWebpFrames, decodeImageRgba, rasterizeSvgFramesToGif, renderRoleCardGif,
} from './share-gif.js';
import { detectMotionCapabilities, rasterizeSvgFramesToMotion } from './share-motion.js';
import {
  VFX_H, VFX_W, clearVfxFrame, compositeVfx, createAmbientFx, createVfxFrame,
} from './share-vfx.js';
import {
  createPosterHybridCanvasRenderer, isPosterWebglSupported, startPosterWebglLoop,
} from './share-webgl.js';

export {
  SHARE_STYLE_SPECS,
  buildAbyssalCardSvg,
  buildBauhausCardSvg,
  buildEclipseCardSvg,
  buildPhosphorCardSvg,
  escapeXml,
  quipText,
  sanitizeShareCardInput,
  scrubSensitiveText,
};

export const SHARE_CARD_WIDTH = 760;
export const SHARE_CARD_HEIGHT = 950;

const THEMES = {
  // v10 Pure Procedural Case A+D Nocturnal Misty Alps + Crisp Editorial Typography
  dark: {
    isDark: true,
    paper: '#0f1318',
    paper2: '#181e25',
    ink: '#f6efe0',
    textBody: '#e4dccb',
    textSecondary: '#c5bdb0',
    muted: '#a49d90',
    accent: '#e6b963',
    accentInk: '#efc674',
    accentSoft: '#352815',
    lineStrong: '#696256',
    line: '#322f2a',
    lineSubtle: '#201e1b',
    skyTop: '#0f1318',
    skyMid: '#181e25',
    skyHorizon: '#2e2923',
    skyInk: '#f6efe0',
    skySub: '#e4dccb',
    skyMuted: '#dad2c2',
    skyAccent: '#e8bc69',
    skyRule: '#4a4d54',
    heroText: '#f3ebd7',
    waistInk: '#fcf6ea',
    waistSub: '#eee5d4',
    waistAccent: '#f1c770',
    waistRightSub: '#f3ebdc',
    pinInk: '#fbf4e5',
    pinInkLight: '#17120d',
    pinHalo: '#11151b',
    pinDot: '#f2c872',
    pinDotLight: '#b84b22',
    sunHi: '#fff6d8',
    sunMid: '#ecc16d',
    sunLow: '#b57b32',
    sunGlow: '#f2c97a',
    ridgeTops: ['#272c34', '#1d2229', '#1a1e24', '#15181d', '#0b0d10', '#060709'],
    ridgeBots: ['#1a1e25', '#101318', '#0f1216', '#0a0c0f', '#07080a', '#040507'],
    rightCragTop: '#161a20',
    rightCragBot: '#090b0e',
    mistWarm: '#e3b26a',
    mistDeep: '#b97e3c',
    fgInk: '#f6efe0',
    fgSub: '#e4dccb',
    fgMuted: '#c5bdb0',
    fgAccent: '#efc368',
    fgRule: '#35322d',
    fgRuleSubtle: '#22201d',
    fgEmpty: '#1c1b18',
    ridgeCrest: '#e6b868',
    contourInk: '#eadfc8',
    plateFg: '#f2ead9',
    plateMuted: '#c5bdb0',
    plateEmpty: '#1c1b18',
  },
  // v10 Pure Procedural Archival Paper Sky to Sumi-Ink Alps + Two-Zone Light Contrast
  light: {
    isDark: false,
    paper: '#e7dac2',
    paper2: '#dfd2b7',
    ink: '#1a1510',
    textBody: '#363028',
    textSecondary: '#544d42',
    muted: '#746a5b',
    accent: '#b87638',
    accentInk: '#8f5222',
    accentSoft: '#d8c5a5',
    lineStrong: '#7a7162',
    line: '#b4a996',
    lineSubtle: '#cec3af',
    skyTop: '#e7dac2',
    skyMid: '#f2e8d4',
    skyHorizon: '#f8f1e1',
    skyInk: '#1a1510',
    skySub: '#2d241b',
    skyMuted: '#3f362c',
    skyAccent: '#a9431e',
    skyRule: '#bfb29b',
    heroText: '#1a1510',
    waistInk: '#14100b',
    waistSub: '#2d241b',
    waistAccent: '#f2c972',
    waistRightSub: '#f4ecdd',
    pinInk: '#fbf4e5',
    pinInkLight: '#17120d',
    pinHalo: '#f5ecd9',
    pinDot: '#f0c56c',
    pinDotLight: '#b84b22',
    sunHi: '#eb8d52',
    sunMid: '#be4f26',
    sunLow: '#822e14',
    sunGlow: '#e59a5e',
    ridgeTops: ['#d8cbb2', '#c8baa2', '#4b3f33', '#322921', '#181410', '#0d0b09'],
    ridgeBots: ['#c7b89d', '#ad9e85', '#312820', '#1c1611', '#100d0a', '#090806'],
    rightCragTop: '#312820',
    rightCragBot: '#120e0a',
    mistWarm: '#fdf6e7',
    mistDeep: '#ecd9b7',
    fgInk: '#f6efe0',
    fgSub: '#e4dccb',
    fgMuted: '#c8bfb0',
    fgAccent: '#efc368',
    fgRule: '#3a3228',
    fgRuleSubtle: '#26201a',
    fgEmpty: '#241e18',
    ridgeCrest: '#cbb999',
    contourInk: '#f2e8d4',
    plateFg: '#f2ead9',
    plateMuted: '#c8bfb0',
    plateEmpty: '#26201a',
  },
};

function resolveCardHour(src) {
  if (src && typeof src.hour === 'number' && Number.isFinite(src.hour)) {
    return ((src.hour % 24) + 24) % 24;
  }
  const rawNow = src ? src.now : null;
  const d = rawNow instanceof Date ? rawNow : (rawNow !== undefined && rawNow !== null ? new Date(rawNow) : new Date());
  if (!Number.isNaN(d.getTime())) {
    return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
  }
  return 12;
}

function lerpHex(hexA, hexB, t) {
  const f = Math.max(0, Math.min(1, t));
  const a = parseInt(String(hexA).slice(1), 16);
  const b = parseInt(String(hexB).slice(1), 16);
  const ar = (a >> 16) & 255;
  const ag = (a >> 8) & 255;
  const ab = a & 255;
  const br = (b >> 16) & 255;
  const bg = (b >> 8) & 255;
  const bb = b & 255;
  const rr = Math.round(ar + (br - ar) * f);
  const rg = Math.round(ag + (bg - ag) * f);
  const rb = Math.round(ab + (bb - ab) * f);
  return `#${((1 << 24) | (rr << 16) | (rg << 8) | rb).toString(16).slice(1)}`;
}

const DARK_SKY_STOPS = [
  { h: 0.0, skyTop: '#090d16', skyMid: '#121a28', skyHorizon: '#232431', sunHi: '#fff9ea', sunMid: '#f3e0b8', sunLow: '#b5986e', sunGlow: '#e6ca96', cloudBody: '#1e273d', cloudShadow: '#111624', cloudRim: '#c9d4e8', cloudWarm: '#e3c796', mistWarm: '#cca774', mistDeep: '#7d6245', alpenglow: '#c9d4e8', starOp: 0.72 },
  { h: 5.75, skyTop: '#131326', skyMid: '#2a1f36', skyHorizon: '#703d40', sunHi: '#fff7e0', sunMid: '#fab87c', sunLow: '#df785a', sunGlow: '#f8aa82', cloudBody: '#4a2f4d', cloudShadow: '#23182e', cloudRim: '#ffc296', cloudWarm: '#f28788', mistWarm: '#eb9d78', mistDeep: '#a65752', alpenglow: '#ffaa85', starOp: 0.14 },
  { h: 9.0, skyTop: '#0f1c2e', skyMid: '#1c324a', skyHorizon: '#4e525c', sunHi: '#fffdf0', sunMid: '#fae096', sunLow: '#e5b368', sunGlow: '#f8df9c', cloudBody: '#344c69', cloudShadow: '#1b2b40', cloudRim: '#fae6ba', cloudWarm: '#ebc08f', mistWarm: '#e2bc84', mistDeep: '#9e7e56', alpenglow: '#f8dba0', starOp: 0.0 },
  { h: 12.5, skyTop: '#0d1a2c', skyMid: '#18334e', skyHorizon: '#3c5368', sunHi: '#ffffff', sunMid: '#fff0bd', sunLow: '#ebd08a', sunGlow: '#d8ebfa', cloudBody: '#345270', cloudShadow: '#1a2e45', cloudRim: '#eef6ff', cloudWarm: '#f7e2b8', mistWarm: '#d6c39c', mistDeep: '#8c7e64', alpenglow: '#e8f1fa', starOp: 0.0 },
  { h: 17.5, skyTop: '#131222', skyMid: '#311e33', skyHorizon: '#87422d', sunHi: '#fff8de', sunMid: '#ffb46b', sunLow: '#e06e48', sunGlow: '#f79d5e', cloudBody: '#592c46', cloudShadow: '#261426', cloudRim: '#ffc77d', cloudWarm: '#f47864', mistWarm: '#eb9e5c', mistDeep: '#a85230', alpenglow: '#ffae63', starOp: 0.0 },
  { h: 19.25, skyTop: '#0c1021', skyMid: '#211c38', skyHorizon: '#593448', sunHi: '#fff0d4', sunMid: '#eb9686', sunLow: '#b86274', sunGlow: '#e38b8a', cloudBody: '#38274d', cloudShadow: '#19142b', cloudRim: '#f29f94', cloudWarm: '#c282b0', mistWarm: '#cc8876', mistDeep: '#784856', alpenglow: '#e39698', starOp: 0.36 },
  { h: 24.0, skyTop: '#090d16', skyMid: '#121a28', skyHorizon: '#232431', sunHi: '#fff9ea', sunMid: '#f3e0b8', sunLow: '#b5986e', sunGlow: '#e6ca96', cloudBody: '#1e273d', cloudShadow: '#111624', cloudRim: '#c9d4e8', cloudWarm: '#e3c796', mistWarm: '#cca774', mistDeep: '#7d6245', alpenglow: '#c9d4e8', starOp: 0.72 },
];

const LIGHT_SKY_STOPS = [
  { h: 0.0, skyTop: '#d4dce6', skyMid: '#e3e8ee', skyHorizon: '#eee9df', sunHi: '#ffffff', sunMid: '#f7ead0', sunLow: '#d5c7a9', sunGlow: '#dcd0b8', cloudBody: '#95a5bd', cloudShadow: '#72829b', cloudRim: '#f9f7f0', cloudWarm: '#ddd0b4', mistWarm: '#f6f2e8', mistDeep: '#dce0e6', alpenglow: '#c2d0e3', starOp: 0.24 },
  { h: 5.75, skyTop: '#eddcd6', skyMid: '#f7e5d6', skyHorizon: '#fce0c4', sunHi: '#fffef5', sunMid: '#ffe2ad', sunLow: '#f5ad7c', sunGlow: '#fac093', cloudBody: '#c98e96', cloudShadow: '#9e6c7c', cloudRim: '#fff2d6', cloudWarm: '#f5a988', mistWarm: '#fdf4e7', mistDeep: '#f0d3be', alpenglow: '#f5b089', starOp: 0.0 },
  { h: 9.0, skyTop: '#dce5eb', skyMid: '#edf0ea', skyHorizon: '#f8f0dc', sunHi: '#ffffff', sunMid: '#fff0bd', sunLow: '#f5c77a', sunGlow: '#fae0a2', cloudBody: '#9fb6c9', cloudShadow: '#7b94ab', cloudRim: '#fffae8', cloudWarm: '#f5d29c', mistWarm: '#fcf6e8', mistDeep: '#e8ddc6', alpenglow: '#f5d293', starOp: 0.0 },
  { h: 12.5, skyTop: '#d2e1ed', skyMid: '#e7eef2', skyHorizon: '#f7f3e6', sunHi: '#ffffff', sunMid: '#fff6cc', sunLow: '#f7d888', sunGlow: '#fceab5', cloudBody: '#8daec9', cloudShadow: '#6d8eab', cloudRim: '#ffffff', cloudWarm: '#f7e8c4', mistWarm: '#fcf8ee', mistDeep: '#e3e4dc', alpenglow: '#f2e6c9', starOp: 0.0 },
  { h: 17.5, skyTop: '#e8d3c3', skyMid: '#f5d7bf', skyHorizon: '#f7c196', sunHi: '#fffef2', sunMid: '#ffd491', sunLow: '#f59c62', sunGlow: '#f5a462', cloudBody: '#ba7a88', cloudShadow: '#875469', cloudRim: '#ffe5a8', cloudWarm: '#f28c6c', mistWarm: '#fdf2e0', mistDeep: '#edc9a6', alpenglow: '#f5a162', starOp: 0.0 },
  { h: 19.25, skyTop: '#d6d2e3', skyMid: '#e8dae2', skyHorizon: '#f2d3c4', sunHi: '#fff9e6', sunMid: '#f7c19c', sunLow: '#e39085', sunGlow: '#eda69b', cloudBody: '#9580a6', cloudShadow: '#6d5c82', cloudRim: '#ffdcc2', cloudWarm: '#de95a3', mistWarm: '#f7eee5', mistDeep: '#dfd0d6', alpenglow: '#e09fa6', starOp: 0.12 },
  { h: 24.0, skyTop: '#d4dce6', skyMid: '#e3e8ee', skyHorizon: '#eee9df', sunHi: '#ffffff', sunMid: '#f7ead0', sunLow: '#d5c7a9', sunGlow: '#dcd0b8', cloudBody: '#95a5bd', cloudShadow: '#72829b', cloudRim: '#f9f7f0', cloudWarm: '#ddd0b4', mistWarm: '#f6f2e8', mistDeep: '#dce0e6', alpenglow: '#c2d0e3', starOp: 0.24 },
];

function computeSkyMood(hour, isDark) {
  const h = ((hour % 24) + 24) % 24;
  const stops = isDark ? DARK_SKY_STOPS : LIGHT_SKY_STOPS;
  let a = stops[0];
  let b = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i += 1) {
    if (h >= stops[i].h && h <= stops[i + 1].h) {
      a = stops[i];
      b = stops[i + 1];
      break;
    }
  }
  const span = Math.max(0.001, b.h - a.h);
  const rawT = Math.max(0, Math.min(1, (h - a.h) / span));
  const t = rawT * rawT * (3 - 2 * rawT);

  const smoothstep = (e0, e1, v) => {
    const u = Math.max(0, Math.min(1, (v - e0) / Math.max(0.0001, e1 - e0)));
    return u * u * (3 - 2 * u);
  };

  const isNight = h < 5.25 || h > 19.25;
  let sunCx;
  let sunCy;
  let sunR;
  let lowSun;
  if (!isNight) {
    const dayT = (h - 5.25) / 14.0;
    const arc = Math.sin(dayT * Math.PI);
    const lift = smoothstep(0.38, 0.57, arc);
    sunCx = 66 + dayT * 566;
    sunCy = 286 - lift * 180 - arc * 14;
    sunR = 22 + (1 - arc) * 3.8;
    lowSun = Math.pow(Math.max(0, 1 - arc), 1.5);
  } else {
    const nightElapsed = h >= 19.25 ? (h - 19.25) : (h + 4.75);
    const nightT = Math.max(0, Math.min(1, nightElapsed / 10.0));
    const arc = Math.sin(nightT * Math.PI);
    const nightLift = smoothstep(0.18, 0.52, arc);
    sunCx = 148 + nightT * 464;
    sunCy = 292 - nightLift * 182 - arc * 14;
    sunR = 22.5;
    lowSun = 0.25 + (1 - nightLift) * 0.25;
  }

  let phase = 'night';
  if (h >= 5.0 && h < 7.5) phase = 'dawn';
  else if (h >= 7.5 && h < 11.0) phase = 'morning';
  else if (h >= 11.0 && h < 15.5) phase = 'noon';
  else if (h >= 15.5 && h < 18.5) phase = 'sunset';
  else if (h >= 18.5 && h < 20.25) phase = 'dusk';

  return {
    phase,
    isNight,
    sunCx,
    sunCy,
    sunR,
    lowSun,
    skyTop: lerpHex(a.skyTop, b.skyTop, t),
    skyMid: lerpHex(a.skyMid, b.skyMid, t),
    skyHorizon: lerpHex(a.skyHorizon, b.skyHorizon, t),
    sunHi: lerpHex(a.sunHi, b.sunHi, t),
    sunMid: lerpHex(a.sunMid, b.sunMid, t),
    sunLow: lerpHex(a.sunLow, b.sunLow, t),
    sunGlow: lerpHex(a.sunGlow, b.sunGlow, t),
    cloudBody: lerpHex(a.cloudBody, b.cloudBody, t),
    cloudShadow: lerpHex(a.cloudShadow, b.cloudShadow, t),
    cloudRim: lerpHex(a.cloudRim, b.cloudRim, t),
    cloudWarm: lerpHex(a.cloudWarm, b.cloudWarm, t),
    mistWarm: lerpHex(a.mistWarm, b.mistWarm, t),
    mistDeep: lerpHex(a.mistDeep, b.mistDeep, t),
    alpenglow: lerpHex(a.alpenglow, b.alpenglow, t),
    starOp: a.starOp + (b.starOp - a.starOp) * t,
  };
}

/** Smooth interpolation and deterministic alpine micro-crags for Reference A full-bleed mountains. */
function resampleNormalized(values, count) {
  const n = Math.max(2, count);
  const src = Array.isArray(values) ? values.map(safeNum) : [];
  const maxVal = src.reduce((m, v) => Math.max(m, v), 0);
  if (!src.length || !(maxVal > 0)) {
    return Array.from({ length: n }, (_, i) => 0.14 + 0.08 * Math.sin(i * 0.42 + 0.6));
  }
  if (src.length === 1) {
    return Array.from({ length: n }, (_, i) => {
      const u = i / (n - 1);
      return Math.exp(-((u - 0.72) ** 2) / 0.036) * 0.86 + 0.08;
    });
  }
  return Array.from({ length: n }, (_, i) => {
    const pos = (i / (n - 1)) * (src.length - 1);
    const i0 = Math.floor(pos);
    const i1 = Math.min(src.length - 1, i0 + 1);
    const frac = pos - i0;
    const v = src[i0] * (1 - frac) + src[i1] * frac;
    return Math.max(0, Math.min(1, v / maxVal));
  });
}

function smoothSeries(arr, passes = 1) {
  let cur = [...arr];
  for (let p = 0; p < passes; p += 1) {
    cur = cur.map((v, i) => {
      const a = cur[Math.max(0, i - 1)];
      const b = cur[Math.min(cur.length - 1, i + 1)];
      return a * 0.22 + v * 0.56 + b * 0.22;
    });
  }
  return cur;
}

function shiftArr(arr, offset) {
  return arr.map((_, i) => arr[Math.max(0, Math.min(arr.length - 1, i - offset))]);
}

function fractalAlpinePoints(pts, { amp = 9, seed = 1.3, octaves = 3, lockIdx = -1, yMin = 170, yMax = 760, pineFringe = false } = {}) {
  if (!pts.length) return [];
  let cur = pts.map((p) => ({ x: p.x, y: Math.max(yMin, Math.min(yMax, p.y)) }));
  let lockedX = lockIdx >= 0 && lockIdx < cur.length ? cur[lockIdx].x : -1;
  let lockedY = lockIdx >= 0 && lockIdx < cur.length ? cur[lockIdx].y : -1;
  for (let oct = 0; oct < octaves; oct += 1) {
    const scaleAmp = amp * (0.55 ** oct);
    const next = [];
    for (let i = 0; i < cur.length - 1; i += 1) {
      const a = cur[i];
      const b = cur[i + 1];
      next.push(a);
      const midX = (a.x + b.x) * 0.5;
      const midBaseY = (a.y + b.y) * 0.5;
      const h = Math.sin(midX * 0.043 * (oct + 1) + seed * (1.7 + oct) + i * 0.9) * 0.62
        + Math.cos(midX * 0.11 * (oct + 1) - seed * 2.3) * 0.38;
      let midY = Math.max(yMin, Math.min(yMax, midBaseY + h * scaleAmp));
      if (lockedX >= 0 && Math.abs(midX - lockedX) < 28) {
        midY = Math.max(lockedY + 2, midY);
      }
      next.push({ x: midX, y: midY });
    }
    next.push(cur[cur.length - 1]);
    cur = next;
  }
  if (pineFringe) {
    // Etch subtle conifer silhouette spikes along sweeping foreground ridge shoulders
    const out = [];
    for (let i = 0; i < cur.length; i += 1) {
      const p = cur[i];
      out.push(p);
      if (i < cur.length - 1) {
        const b = cur[i + 1];
        const dx = b.x - p.x;
        if (dx >= 7) {
          const steps = Math.min(28, Math.floor(dx / 6.5));
          for (let k = 1; k <= steps; k += 1) {
            const frac = k / (steps + 1);
            const sx = p.x + dx * frac;
            const sy = p.y + (b.y - p.y) * frac;
            const spike = Math.abs(Math.sin(sx * 0.43 + seed) * Math.cos(sx * 0.19 - seed * 0.7));
            const cluster = 0.65 + 0.55 * Math.sin(sx * 0.058 + seed);
            const tooth = (k % 2 === 1 ? -1 : 0.15) * (1.4 + spike * 5.6) * cluster;
            out.push({ x: sx, y: Math.max(yMin, Math.min(yMax, sy + tooth)) });
          }
        }
      }
    }
    cur = out;
  }
  return cur;
}

function synthesizeDataMassif(heroVals, outCount = 32) {
  const n = Math.max(12, outCount);
  const src = Array.isArray(heroVals) ? heroVals.map(safeNum) : [];
  const maxVal = src.reduce((mx, v) => Math.max(mx, v), 0);
  if (!src.length || !(maxVal > 0)) {
    return {
      arr: Array.from({ length: n }, (_, i) => {
        const u = i / (n - 1);
        return 0.16 + 0.44 * Math.exp(-((u - 0.62) ** 2) / 0.03) + 0.18 * Math.exp(-((u - 0.26) ** 2) / 0.04);
      }),
      peakIdx: Math.round((n - 1) * 0.62),
    };
  }
  let pkSrcIdx = 0;
  src.forEach((v, i) => { if (v >= src[pkSrcIdx]) pkSrcIdx = i; });
  const pkU = src.length > 1 ? pkSrcIdx / (src.length - 1) : 0.6;
  const peakIdx = Math.round(pkU * (n - 1));
  const rawArr = Array.from({ length: n }, (_, i) => {
    const u = i / (n - 1);
    let weighted = 0;
    let normSum = 0;
    for (let j = 0; j < src.length; j += 1) {
      const uj = src.length > 1 ? j / (src.length - 1) : 0.5;
      const g = Math.exp(-((u - uj) ** 2) / 0.0042);
      weighted += (src[j] / maxVal) * g;
      normSum += g;
    }
    const base = normSum > 0 ? weighted / normSum : 0.15;
    const peakBoost = Math.exp(-((u - pkU) ** 2) / 0.0022) * (1 - base);
    return Math.max(0.08, Math.min(1, 0.09 + 0.91 * (base + peakBoost * 0.72)));
  });
  rawArr[peakIdx] = 1.0;
  return { arr: rawArr, peakIdx };
}

function openPolyPath(pts) {
  if (!pts.length) return '';
  return `M${pts.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join('L')}`;
}

function closedPolyArea(pts, bottomY) {
  if (!pts.length) return '';
  const first = pts[0];
  const last = pts[pts.length - 1];
  return `M${first.x.toFixed(1)} ${bottomY.toFixed(1)}L${pts.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join('L')}L${last.x.toFixed(1)} ${bottomY.toFixed(1)}Z`;
}

function ridgeYAtX(pts, targetX) {
  if (!pts.length) return 490;
  if (targetX <= pts[0].x) return pts[0].y;
  for (let i = 0; i < pts.length - 1; i += 1) {
    const a = pts[i];
    const b = pts[i + 1];
    if (targetX <= b.x) {
      const span = b.x - a.x;
      const frac = span > 0 ? (targetX - a.x) / span : 0;
      return a.y + (b.y - a.y) * frac;
    }
  }
  return pts[pts.length - 1].y;
}

function contourLinesSvg(pts, offsets, color, opacities) {
  if (!pts.length) return '';
  return offsets.map((dy, idx) => {
    const shifted = pts.map((p) => ({ x: p.x, y: p.y + dy }));
    const op = opacities[idx] ?? 0.06;
    return `<path d="${openPolyPath(shifted)}" fill="none" stroke="${color}" stroke-opacity="${op}" stroke-width="0.75"/>`;
  }).join('');
}

function buildAlpineRelief(pts, {
  clipId, sunCx, bottomY, lightCol, shadowCol,
  lightOp = 0.20, shadowOp = 0.30, rimCol, rimOp = 0.32,
  minProminence = 10, maxPeaks = 4, seed = 1.0,
}) {
  if (!pts || pts.length < 7) return '';
  const candidates = [];
  for (let i = 3; i < pts.length - 3; i += 1) {
    const curY = pts[i].y;
    let isPeak = true;
    for (let j = i - 4; j <= i + 4; j += 1) {
      if (j !== i && j >= 0 && j < pts.length && pts[j].y <= curY) {
        isPeak = false;
        break;
      }
    }
    if (!isPeak) continue;
    let maxDrop = 0;
    for (let j = Math.max(0, i - 6); j <= Math.min(pts.length - 1, i + 6); j += 1) {
      if (pts[j].y - curY > maxDrop) maxDrop = pts[j].y - curY;
    }
    if (maxDrop >= minProminence) candidates.push({ idx: i, prom: maxDrop });
  }
  candidates.sort((a, b) => b.prom - a.prom);
  const picked = [];
  for (const cand of candidates) {
    const cx = pts[cand.idx].x;
    if (picked.every((pi) => Math.abs(pts[pi].x - cx) >= 72)) {
      picked.push(cand.idx);
      if (picked.length >= maxPeaks) break;
    }
  }

  let facetsSvg = '';
  for (const pi of picked) {
    const px = pts[pi].x;
    const py = pts[pi].y;
    let leftIdx = Math.max(0, pi - 7);
    let rightIdx = Math.min(pts.length - 1, pi + 7);
    for (let j = pi - 1; j >= Math.max(0, pi - 8); j -= 1) {
      if (pts[j].y > pts[leftIdx].y) leftIdx = j;
    }
    for (let j = pi + 1; j <= Math.min(pts.length - 1, pi + 8); j += 1) {
      if (pts[j].y > pts[rightIdx].y) rightIdx = j;
    }
    const maxY = Math.min(bottomY, Math.max(pts[leftIdx].y, pts[rightIdx].y) + 48);
    const spanY = Math.max(24, maxY - py);
    const sunOnLeft = sunCx < px;
    const baseShift = sunOnLeft ? 28 : -28;
    const spine = [];
    for (let s = 0; s <= 5; s += 1) {
      const f = s / 5;
      const kink = (Math.sin(seed * 3.1 + s * 1.65 + pi * 0.7) * 9.5 + Math.cos(seed * 1.9 + s * 2.4) * 5.0) * f;
      spine.push({
        x: px + baseShift * f + kink,
        y: py + spanY * (f ** 0.90),
      });
    }
    const litPts = sunOnLeft
      ? [...pts.slice(leftIdx, pi + 1), ...spine.slice(1)]
      : [...spine, ...pts.slice(pi, rightIdx + 1).reverse()];
    const shdPts = sunOnLeft
      ? [...spine, ...pts.slice(pi, rightIdx + 1).reverse()]
      : [...pts.slice(leftIdx, pi + 1), ...spine.slice(1)];
    const spurShift = sunOnLeft ? -18 : 18;
    const spurBase = spine[spine.length - 1];
    const spurPts = [
      pts[pi],
      { x: px + baseShift * 0.48 + spurShift * 0.45, y: py + spanY * 0.42 },
      { x: px + baseShift * 0.85 + spurShift, y: spurBase.y },
      spurBase,
    ];
    const toD = (arr) => `M${arr.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join('L')}Z`;
    facetsSvg += `<path d="${toD(litPts)}" fill="${lightCol}" fill-opacity="${lightOp}"/>`
      + `<path d="${toD(shdPts)}" fill="${shadowCol}" fill-opacity="${shadowOp}"/>`
      + `<path d="${toD(spurPts)}" fill="${shadowCol}" fill-opacity="${(shadowOp * 0.55).toFixed(2)}"/>`;
  }

  let rimD = '';
  for (let i = 0; i < pts.length - 1; i += 1) {
    const a = pts[i];
    const b = pts[i + 1];
    const facingSun = (b.y < a.y && sunCx > b.x) || (b.y > a.y && sunCx < a.x) || Math.abs(b.y - a.y) < 0.8;
    if (facingSun) {
      rimD += `M${a.x.toFixed(1)} ${a.y.toFixed(1)}L${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
    }
  }
  const rimSvg = rimD
    ? `<path d="${rimD}" fill="none" stroke="${rimCol}" stroke-opacity="${rimOp}" stroke-width="1.2" stroke-linecap="round"/>`
    : '';
  return `${facetsSvg ? `<g clip-path="url(#${clipId})">${facetsSvg}</g>` : ''}${rimSvg}`;
}

function renderPaintedClouds({ W, hour, sky, isDark, phase = 0, phaseRad = 0 }) {
  const wrapSpan = W + 440;
  const wrapX = (x) => ((((x + 220) % wrapSpan) + wrapSpan) % wrapSpan) - 220;
  const driftA = ((hour / 24) * 320) % 760;
  const driftB = ((hour / 24) * 520) % 760;
  // Continuous one-way wrap-around drift across wrapSpan so phase=0 and phase=1 match seamlessly
  const dxCirrus = phase ? phase * wrapSpan : 0;
  const dyCirrus = phase ? (1 - Math.cos(phaseRad)) * 1.4 : 0;
  const dxDeck = phase ? phase * wrapSpan : 0;
  const dyDeck = phase ? Math.sin(phaseRad * 2) * 1.0 : 0;

  // Layer 1: Feathered high-altitude wind-swept silk cirrus ribbons
  const cirrusSpecs = [
    { x: wrapX(310 + driftA * 0.55 + dxCirrus), y: 68 + dyCirrus, w: 320, h: 14 },
    { x: wrapX(570 + driftA * 0.42 + dxCirrus), y: 106 + dyCirrus * 0.85, w: 360, h: 16 },
    { x: wrapX(140 + driftA * 0.65 + dxCirrus), y: 138 + dyCirrus * 1.1, w: 280, h: 13 },
    { x: wrapX(440 + driftA * 0.50 + dxCirrus), y: 164 + dyCirrus * 0.9, w: 340, h: 12 },
  ];
  const cirrusOp = isDark ? '0.34' : '0.46';
  const cirrusSvg = `<g data-mtn-anim="cirrus">${cirrusSpecs.map((c, idx) => {
    const tilt = idx % 2 === 0 ? -4 : 3;
    const d = `M${(c.x - c.w * 0.52).toFixed(1)} ${(c.y + tilt).toFixed(1)}C${(c.x - c.w * 0.24).toFixed(1)} ${(c.y - c.h).toFixed(1)} ${(c.x + c.w * 0.10).toFixed(1)} ${(c.y - c.h * 0.6).toFixed(1)} ${(c.x + c.w * 0.52).toFixed(1)} ${(c.y - tilt).toFixed(1)}C${(c.x + c.w * 0.18).toFixed(1)} ${(c.y + c.h * 0.35).toFixed(1)} ${(c.x - c.w * 0.16).toFixed(1)} ${(c.y + c.h * 0.22).toFixed(1)} ${(c.x - c.w * 0.52).toFixed(1)} ${(c.y + tilt).toFixed(1)}Z`;
    return `<path d="${d}" fill="url(#agy-ed-cloud-cirrus)" fill-opacity="${cirrusOp}" filter="url(#agy-ed-cloud-body)"/>`;
  }).join('')}</g>`;

  // Layer 2: Multi-lobed organic tapered cumulus/altocumulus banks
  const deckSpecs = [
    { x: wrapX(275 + driftB * 0.72 + dxDeck), y: 164 + dyDeck, w: 265, h: 24, seed: 1.2 },
    { x: wrapX(605 + driftB * 0.58 + dxDeck), y: 192 + dyDeck * 0.85, w: 300, h: 28, seed: 2.7 },
    { x: wrapX(135 + driftB * 0.80 + dxDeck), y: 218 + dyDeck * 1.1, w: 245, h: 22, seed: 3.9 },
    { x: wrapX(465 + driftB * 0.66 + dxDeck), y: 242 + dyDeck * 0.9, w: 290, h: 21, seed: 5.1 },
  ];
  const baseRimOp = isDark ? (0.28 + sky.lowSun * 0.24) : (0.42 + sky.lowSun * 0.24);
  const bodyOp = isDark ? '0.36' : '0.32';
  const decksSvg = `<g data-mtn-anim="deck">${deckSpecs.map((dk) => {
    const wispPath = (ox, oy, scaleY = 1) => {
      const h = dk.h * scaleY;
      const x0 = dk.x - dk.w * 0.54 + ox;
      const x1 = dk.x - dk.w * 0.34 + ox;
      const x2 = dk.x - dk.w * 0.14 + ox;
      const x3 = dk.x + dk.w * 0.06 + ox;
      const x4 = dk.x + dk.w * 0.26 + ox;
      const x5 = dk.x + dk.w * 0.54 + ox;
      const y = dk.y + oy;
      const p1 = h * (0.42 + 0.18 * Math.sin(dk.seed));
      const p2 = h * (0.94 + 0.18 * Math.cos(dk.seed * 1.7));
      const p3 = h * (0.64 + 0.22 * Math.sin(dk.seed * 2.3));
      const p4 = h * (0.36 + 0.14 * Math.cos(dk.seed * 0.9));
      return `M${x0.toFixed(1)} ${y.toFixed(1)}`
        + `Q${(x0 + dk.w * 0.08).toFixed(1)} ${(y - p1 * 0.9).toFixed(1)} ${x1.toFixed(1)} ${(y - p1).toFixed(1)}`
        + `Q${(x1 + dk.w * 0.10).toFixed(1)} ${(y - p2 * 1.15).toFixed(1)} ${x2.toFixed(1)} ${(y - p2).toFixed(1)}`
        + `Q${(x2 + dk.w * 0.11).toFixed(1)} ${(y - p3 * 1.18).toFixed(1)} ${x3.toFixed(1)} ${(y - p3).toFixed(1)}`
        + `Q${(x3 + dk.w * 0.10).toFixed(1)} ${(y - p4 * 1.12).toFixed(1)} ${x4.toFixed(1)} ${(y - p4).toFixed(1)}`
        + `Q${(x4 + dk.w * 0.14).toFixed(1)} ${(y - h * 0.16).toFixed(1)} ${x5.toFixed(1)} ${(y + 2).toFixed(1)}`
        + `Q${(dk.x + ox).toFixed(1)} ${(y + h * 0.16).toFixed(1)} ${x0.toFixed(1)} ${y.toFixed(1)}Z`;
    };
    const dist = Math.hypot(dk.x - sky.sunCx, dk.y - sky.sunCy);
    const prox = Math.max(0, 1 - dist / 340);
    const rimOp = Math.min(0.80, baseRimOp + prox * 0.28).toFixed(2);
    const warmOp = Math.min(0.74, baseRimOp * 0.50 + prox * 0.34).toFixed(2);
    const rimDx = Math.max(-9, Math.min(9, (sky.sunCx - dk.x) * 0.032));
    return `<path d="${wispPath(rimDx, -4.5, 1.05)}" fill="${sky.cloudRim}" fill-opacity="${rimOp}" filter="url(#agy-ed-cloud-body)"/>`
      + `<path d="${wispPath(0, 0, 1.0)}" fill="url(#agy-ed-cloud-grad)" fill-opacity="${bodyOp}" filter="url(#agy-ed-cloud-body)"/>`
      + `<path d="${wispPath(rimDx * 0.45, -2.0, 0.72)}" fill="${sky.cloudWarm}" fill-opacity="${warmOp}" filter="url(#agy-ed-cloud-soft)"/>`;
  }).join('')}</g>`;

  // Layer 3: Horizon twilight / alpenglow stratus haze (softly diffused near dawn & sunset)
  const bandOp = ((0.15 + sky.lowSun * 0.36) * (phase ? 1 + 0.14 * Math.sin(phaseRad) : 1)).toFixed(2);
  const stratusSvg = `<g data-mtn-anim="stratus"${phase ? ` transform="translate(${(Math.sin(phaseRad) * 8).toFixed(1)}, 0)"` : ''}>
    <path d="M-40 272Q190 250 385 268T800 258L800 296Q590 302 380 292T-40 300Z" fill="${sky.cloudWarm}" fill-opacity="${bandOp}" filter="url(#agy-ed-cloud-haze)"/>
    <path d="M-40 296Q230 280 470 295T800 286L800 324L-40 326Z" fill="${sky.cloudRim}" fill-opacity="${(Number(bandOp) * 0.68).toFixed(2)}" filter="url(#agy-ed-cloud-haze)"/></g>`;

  return `${cirrusSvg}${decksSvg}${stratusSvg}`;
}

function renderCelestialSvg({ sky, isDark, phase = 0, phaseRad = 0 }) {
  const starSeeds = [
    [282, 42, 1.15], [338, 68, 0.85], [412, 34, 1.3], [486, 58, 0.9], [548, 30, 1.2],
    [618, 46, 0.85], [688, 38, 1.35], [724, 88, 0.9], [78, 92, 0.95], [146, 118, 1.1],
    [232, 98, 0.8], [392, 92, 1.1], [462, 112, 0.75], [648, 108, 1.05], [708, 134, 0.85],
    [186, 152, 0.8], [326, 142, 0.95], [516, 148, 1.1],
  ];
  const starsSvg = sky.starOp > 0.02
    ? starSeeds.map(([sx, sy, sr], idx) => {
      const twinkle = phase ? Math.max(0.25, Math.min(1.15, 1 + 0.28 * (Math.sin(phaseRad + idx * 1.37) - Math.sin(idx * 1.37)))) : 1;
      return `<circle data-mtn-anim="star" data-star-idx="${idx % 3}" cx="${sx}" cy="${sy}" r="${sr}" fill="${isDark ? '#f8f5ea' : '#fffdf7'}" fill-opacity="${(sky.starOp * (idx % 3 === 0 ? 0.95 : 0.62) * twinkle).toFixed(2)}"/>`;
    }).join('')
    : '';

  let meteorSvg = '';
  if (sky.starOp > 0.25) {
    if (phase > 0 && phase >= 0.18 && phase <= 0.48) {
      const u = (phase - 0.18) / 0.30;
      const env = Math.sin(u * Math.PI);
      const mx = 610 - 140 * u;
      const my = 48 + 52 * u;
      meteorSvg = `<g data-mtn-anim="meteor" opacity="${(env * Math.min(1, sky.starOp)).toFixed(2)}"><line x1="${mx.toFixed(1)}" y1="${my.toFixed(1)}" x2="${(mx + 26 * env).toFixed(1)}" y2="${(my - 9.6 * env).toFixed(1)}" stroke="#fffdf5" stroke-width="1.3" stroke-linecap="round"/><circle cx="${mx.toFixed(1)}" cy="${my.toFixed(1)}" r="1.4" fill="#fffdf5"/></g>`;
    } else {
      meteorSvg = `<g data-mtn-anim="meteor" opacity="0"><line x1="610" y1="48" x2="634" y2="39" stroke="#fffdf5" stroke-width="1.3" stroke-linecap="round"/><circle cx="610" cy="48" r="1.4" fill="#fffdf5"/></g>`;
    }
  }

  const cxStr = sky.sunCx.toFixed(1);
  const cyStr = sky.sunCy.toFixed(1);
  const r = sky.sunR;
  const coronaScale = phase ? 1 + 0.07 * Math.sin(phaseRad) : 1;
  const coronaOpAttr = phase ? ` opacity="${(1 - 0.08 * (1 - Math.cos(phaseRad)) * 0.5).toFixed(2)}"` : '';

  if (!sky.isNight) {
    const horizonScatterSvg = sky.lowSun > 0.20
      ? `<ellipse cx="${cxStr}" cy="${(sky.sunCy + r * 0.14).toFixed(1)}" rx="${(r * 3.8).toFixed(1)}" ry="${(r * 0.72).toFixed(1)}" fill="${sky.sunGlow}" fill-opacity="${((sky.lowSun - 0.20) * 0.34).toFixed(2)}" filter="url(#agy-ed-celestial-bloom)"/>`
      : '';
    return `${starsSvg}${meteorSvg}
  <circle data-mtn-anim="corona" cx="${cxStr}" cy="${cyStr}" r="${(r * 3.8 * coronaScale).toFixed(1)}" fill="url(#agy-ed-sun-corona)"${coronaOpAttr}/>
  ${horizonScatterSvg}
  <circle cx="${cxStr}" cy="${cyStr}" r="${(r * 1.95).toFixed(1)}" fill="url(#agy-ed-sun-inner)" filter="url(#agy-ed-celestial-halation)"/>
  <circle cx="${cxStr}" cy="${cyStr}" r="${(r * 1.06).toFixed(1)}" fill="url(#agy-ed-sun)" filter="url(#agy-ed-celestial-feather)"/>`;
  }

  return `${starsSvg}${meteorSvg}
  <circle data-mtn-anim="corona" cx="${cxStr}" cy="${cyStr}" r="${(r * 4.0 * coronaScale).toFixed(1)}" fill="url(#agy-ed-moon-corona)"${coronaOpAttr}/>
  <circle cx="${cxStr}" cy="${cyStr}" r="${(r * 1.65).toFixed(1)}" fill="url(#agy-ed-moon-inner)" filter="url(#agy-ed-celestial-halation)"/>
  <g transform="translate(${cxStr}, ${cyStr})">
    <circle cx="0" cy="0" r="${r.toFixed(1)}" fill="url(#agy-ed-moon-disc)" filter="url(#agy-ed-moon-feather)"/>
    <g mask="url(#agy-ed-moon-limb-mask)">
      <circle cx="0" cy="0" r="${(r * 0.95).toFixed(1)}" fill="#ffffff" filter="url(#agy-ed-moon-maria)"/>
    </g>
  </g>`;
}

/** v11 Pure Procedural 8-Plane Chiaroscuro Alpine Print + Time-of-Day Sun/Clouds + Sculpted 3D Relief. */
function renderFullBleedLandscape({
  W, H, periodKey, dailySlice, hourly, pal, t, normLang, txt,
  heroText, heroY, heroSize, calls, convs, totalNew, hour, sky, phase = 0, phaseRad = 0,
  costLeft = 520, leftWaistRight = 260, webglCutout = false,
}) {
  const PAD = 36;
  const HORIZ_R = 688; // keeps clean gutter for far-right vertical colophon spine at x=740
  const HORIZ_W = HORIZ_R - PAD; // 652
  const activeDailyCount = dailySlice.filter((d) => d.tokens > 0 || d.calls > 0).length;

  let activeSummary;
  let heroVals = [];
  let maxTok = 0;
  let peakIdx = 0;
  let peakRatioX = 0.5;
  let peakTimeLbl = '';
  let horizonSvg = '';
  let allCalObj = null;

  if (periodKey === 'today') {
    if (hourly) {
      const activeHours = hourly.filter((h) => h.tokens > 0 || h.calls > 0).length;
      activeSummary = t('activeHours', activeHours);
      heroVals = hourly.map((h) => h.tokens);
      maxTok = heroVals.reduce((mx, v) => Math.max(mx, v), 0);
      heroVals.forEach((v, i) => { if (v >= heroVals[peakIdx]) peakIdx = i; });
      peakRatioX = peakIdx / 23;
      peakTimeLbl = `${String(peakIdx).padStart(2, '0')}:00`;
    } else {
      activeSummary = t('activeToday', activeDailyCount > 0);
      heroVals = new Array(24).fill(0);
    }
    const ticks = [0, 6, 12, 18, 23];
    const pkX = PAD + peakRatioX * HORIZ_W;
    horizonSvg = `<line x1="${PAD}" y1="604" x2="${HORIZ_R}" y2="604" stroke="${pal.fgRule}" stroke-opacity="0.48" stroke-width="0.75"/>`
      + (maxTok > 0 ? `<circle cx="${pkX.toFixed(1)}" cy="604" r="2.6" fill="${pal.fgAccent}"/>` : '')
      + ticks.map((hr) => {
        const tx = PAD + (hr / 23) * HORIZ_W;
        const anchor = hr === 0 ? 'start' : (hr === 23 ? 'end' : 'middle');
        return `<line x1="${tx.toFixed(1)}" y1="604" x2="${tx.toFixed(1)}" y2="608" stroke="${pal.fgMuted}" stroke-opacity="0.65" stroke-width="0.85"/>`
          + txt(tx.toFixed(1), 623, `${String(hr).padStart(2, '0')}:00`, { size: 11.5, fill: pal.fgMuted, weight: 500, font: 'sans', anchor, num: true, filter: 'agy-ed-shadow' });
      }).join('');
  } else if (periodKey === 'd7') {
    const bars = dailySlice.slice(-7);
    activeSummary = t('activeDaysOf', activeDailyCount, Math.max(1, bars.length));
    heroVals = bars.map((d) => d.tokens);
    maxTok = heroVals.reduce((mx, v) => Math.max(mx, v), 0);
    heroVals.forEach((v, i) => { if (v >= heroVals[peakIdx]) peakIdx = i; });
    peakRatioX = bars.length > 1 ? peakIdx / (bars.length - 1) : 0.5;
    if (bars[peakIdx]) peakTimeLbl = formatDayTick(bars[peakIdx].date, t, normLang);
    horizonSvg = `<line x1="${PAD}" y1="604" x2="${HORIZ_R}" y2="604" stroke="${pal.fgRule}" stroke-opacity="0.48" stroke-width="0.75"/>`
      + bars.map((d, i) => {
        const u = bars.length > 1 ? i / (bars.length - 1) : 1;
        const tx = PAD + 24 + u * (HORIZ_W - 48);
        const isLast = i === bars.length - 1;
        const lbl = formatDayTick(d.date, t, normLang);
        return (isLast ? `<circle cx="${tx.toFixed(1)}" cy="604" r="2.6" fill="${pal.fgAccent}"/>` : `<line x1="${tx.toFixed(1)}" y1="604" x2="${tx.toFixed(1)}" y2="608" stroke="${pal.fgMuted}" stroke-opacity="0.65" stroke-width="0.85"/>`)
          + txt(tx.toFixed(1), 623, lbl, { size: 11.5, fill: isLast ? pal.fgInk : pal.fgMuted, weight: isLast ? 600 : 500, font: 'sans', anchor: 'middle', num: true, filter: 'agy-ed-shadow' });
      }).join('');
  } else if (periodKey === 'all' && dailySlice.length >= 14) {
    const end = parseDay(dailySlice[dailySlice.length - 1].date);
    if (!Number.isNaN(end.getTime())) {
      const byDay = new Map(dailySlice.map((d) => [d.date, d]));
      const firstActive = dailySlice.find((d) => d.tokens > 0 || d.calls > 0);
      let need = 0;
      if (firstActive) {
        const fa = parseDay(firstActive.date);
        const endSun = new Date(end.getFullYear(), end.getMonth(), end.getDate() - end.getDay());
        const firstSun = new Date(fa.getFullYear(), fa.getMonth(), fa.getDate() - fa.getDay());
        need = Math.round((endSun - firstSun) / (7 * 86400000)) + 1;
      }
      const weeks = Math.min(52, Math.max(26, need));
      const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - end.getDay() - 7 * (weeks - 1));
      const days = [];
      const weekTotals = new Array(weeks).fill(0);
      for (let i = 0; i < weeks * 7; i += 1) {
        const dt = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
        days.push(dt);
        if (dt <= end) {
          const e = byDay.get(dayKey(dt));
          if (e) weekTotals[Math.floor(i / 7)] += safeNum(e.tokens);
        }
      }
      heroVals = weekTotals;
      maxTok = weekTotals.reduce((mx, v) => Math.max(mx, v), 0);
      weekTotals.forEach((v, i) => { if (v >= weekTotals[peakIdx]) peakIdx = i; });
      peakRatioX = weeks > 1 ? peakIdx / (weeks - 1) : 0.5;
      peakTimeLbl = normLang === 'zh' ? '周峰值' : 'PEAK WK';
      allCalObj = { days, end, weeks, byDay };
    }
  }

  if (allCalObj) {
    const { days, end, weeks, byDay } = allCalObj;
    const level = makeHeatScale(days.filter((d) => d <= end).map((d) => safeNum((byDay.get(dayKey(d)) || {}).tokens)));
    let cell = 8.8;
    let gap = 2;
    let gridTop = 532;
    if (weeks <= 30) {
      cell = 11.0;
      gap = 2.5;
      gridTop = 528;
    } else if (weeks <= 42) {
      cell = 10.0;
      gap = 2.3;
      gridTop = 530;
    }
    const gridH = 7 * cell + 6 * gap;
    const wdWidth = normLang === 'zh' ? 24 : 30;
    const calL = PAD;
    const calR = HORIZ_R + 12;
    const gridX0 = calL + wdWidth;
    const wd = t('weekdays');
    let activeDaysInGrid = 0;
    let calSvg = `<line x1="${calL}" y1="${gridTop - 7}" x2="${calR}" y2="${gridTop - 7}" stroke="${pal.fgRule}" stroke-width="0.75"/>`
      + `<line x1="${calL}" y1="${gridTop + gridH + 7}" x2="${calR}" y2="${gridTop + gridH + 7}" stroke="${pal.fgRule}" stroke-width="0.75"/>`;
    for (const r of [1, 3, 5]) {
      const cy = gridTop + r * (cell + gap) + cell * 0.8;
      calSvg += txt(calL, cy.toFixed(1), wd[r] || '', { size: 11, fill: pal.fgMuted, weight: 500, font: 'sans' });
    }
    const opacities = [0, 0.34, 0.56, 0.78, 1];
    days.forEach((d, i) => {
      if (d > end) return;
      const col = Math.floor(i / 7);
      const row = i % 7;
      const e = byDay.get(dayKey(d)) || { tokens: 0, calls: 0 };
      if (e.tokens > 0 || e.calls > 0) activeDaysInGrid += 1;
      const lv = level(e.tokens);
      const x = gridX0 + col * (cell + gap);
      const y = gridTop + row * (cell + gap);
      calSvg += lv === 0
        ? `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${cell}" height="${cell}" rx="1" fill="${pal.fgEmpty}"/>`
        : `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${cell}" height="${cell}" rx="1" fill="${pal.fgAccent}" fill-opacity="${opacities[lv]}"/>`;
    });

    const legCell = 8.5;
    const legGap = 3;
    const scaleW = 5 * legCell + 4 * legGap;
    const moreSpace = normLang === 'zh' ? 24 : 40;
    const scaleStartX = calR - moreSpace - scaleW;
    const legendLeftEdge = scaleStartX - (normLang === 'zh' ? 40 : 48);
    let lastLabelCol = -9;
    const minGap = weeks > 36 ? 5 : 3;
    const labelY = 640;
    for (let w = 0; w < weeks; w += 1) {
      const first = days[w * 7];
      const monthStart = days.slice(w * 7, w * 7 + 7).find((d) => d.getDate() === 1);
      const mx = gridX0 + w * (cell + gap);
      if ((w === 0 || monthStart) && w - lastLabelCol >= minGap && w <= weeks - 3 && mx + 28 < legendLeftEdge) {
        calSvg += txt(mx.toFixed(1), labelY, formatMonthLabel(monthStart || first, normLang), { size: 11, fill: pal.fgMuted, weight: 500, font: 'sans' });
        lastLabelCol = w;
      }
    }
    calSvg += txt(scaleStartX - 6, labelY, t('less'), { size: 11, fill: pal.fgMuted, weight: 500, font: 'sans', anchor: 'end' });
    for (let lv = 0; lv <= 4; lv += 1) {
      const lx = scaleStartX + lv * (legCell + legGap);
      calSvg += lv === 0
        ? `<rect x="${lx}" y="${labelY - 8}" width="${legCell}" height="${legCell}" rx="1" fill="${pal.fgEmpty}"/>`
        : `<rect x="${lx}" y="${labelY - 8}" width="${legCell}" height="${legCell}" rx="1" fill="${pal.fgAccent}" fill-opacity="${opacities[lv]}"/>`;
    }
    calSvg += txt(calR, labelY, t('more'), { size: 11, fill: pal.fgMuted, weight: 500, font: 'sans', anchor: 'end' });
    activeSummary = t('activeDays', activeDaysInGrid, weeks);
    horizonSvg = calSvg;
  } else if (periodKey !== 'today' && periodKey !== 'd7') {
    const bars = periodKey === 'd30' ? dailySlice.slice(-30) : dailySlice;
    activeSummary = t('activeDaysOf', activeDailyCount, Math.max(1, dailySlice.length));
    heroVals = bars.map((d) => d.tokens);
    maxTok = heroVals.reduce((mx, v) => Math.max(mx, v), 0);
    heroVals.forEach((v, i) => { if (v >= heroVals[peakIdx]) peakIdx = i; });
    peakRatioX = bars.length > 1 ? peakIdx / (bars.length - 1) : 0.72;
    if (bars[peakIdx]) peakTimeLbl = bars[peakIdx].date.slice(5);
    horizonSvg = `<line x1="${PAD}" y1="604" x2="${HORIZ_R}" y2="604" stroke="${pal.fgRule}" stroke-opacity="0.48" stroke-width="0.75"/>`;
    if (bars.length === 1) {
      horizonSvg += `<circle cx="${HORIZ_R}" cy="604" r="2.6" fill="${pal.fgAccent}"/>`
        + txt(HORIZ_R, 623, bars[0].date.slice(5), { size: 11.5, fill: pal.fgInk, weight: 600, font: 'sans', anchor: 'end', num: true, filter: 'agy-ed-shadow' });
    } else if (bars.length >= 2) {
      horizonSvg += `<circle cx="${(PAD + peakRatioX * HORIZ_W).toFixed(1)}" cy="604" r="2.6" fill="${pal.fgAccent}"/>`
        + txt(PAD, 623, bars[0].date.slice(5), { size: 11.5, fill: pal.fgMuted, weight: 500, font: 'sans', anchor: 'start', num: true, filter: 'agy-ed-shadow' });
      if (bars.length >= 7) {
        const mid = Math.floor((bars.length - 1) / 2);
        const midX = PAD + (mid / (bars.length - 1)) * HORIZ_W;
        horizonSvg += txt(midX.toFixed(1), 623, bars[mid].date.slice(5), { size: 11.5, fill: pal.fgMuted, weight: 500, font: 'sans', anchor: 'middle', num: true, filter: 'agy-ed-shadow' });
      }
      horizonSvg += txt(HORIZ_R, 623, bars[bars.length - 1].date.slice(5), { size: 11.5, fill: pal.fgInk, weight: 600, font: 'sans', anchor: 'end', num: true, filter: 'agy-ed-shadow' });
    }
  }

  // Time-of-day Celestial Arc (Sun rises east/left, arcs overhead, sets west/right; Moon traverses night sky)
  const isAll = Boolean(allCalObj);
  const sunCx = sky.sunCx;
  const sunCy = sky.sunCy;
  const sunR = sky.sunR;

  // Synthesize fractal alpine massifs directly from real user data
  const samples = 24;
  const { arr: massifNorm, peakIdx: massifPeakIdx } = synthesizeDataMassif(heroVals, samples);
  const fullPts = (arr, yBase, amp, marginX = 16) => {
    const x0 = -marginX;
    const spanX = W + 2 * marginX;
    return arr.map((v, i) => ({
      x: x0 + (i / (arr.length - 1)) * spanX,
      y: yBase - v * amp,
    }));
  };

  // Plane 1: Sculpted Matterhorn-inspired distant alpine spires behind numerals & celestial body
  const r0Arr = shiftArr(massifNorm, -3).map((v, i) => {
    const u = i / (samples - 1);
    const leftSpire = Math.exp(-((u - 0.14) ** 2) / 0.011) * 0.62;
    const centerTwin = Math.exp(-((u - 0.46) ** 2) / 0.010) * 0.46 + Math.exp(-((u - 0.56) ** 2) / 0.008) * 0.36;
    const eastHorn = Math.exp(-((u - 0.83) ** 2) / 0.012) * 0.48;
    return Math.min(1, v * 0.20 + 0.14 + leftSpire + centerTwin + eastHorn);
  });
  const p0 = fractalAlpinePoints(fullPts(r0Arr, 346, 72), { amp: 12, seed: 1.4, octaves: 4, yMin: 256, yMax: 356 });

  // Plane 2: Subtle alpine saddle resting cleanly beneath monumental hero digits without slicing right-hand letters
  const r1Raw = Array.from({ length: 18 }, (_, i) => {
    const u = i / 17;
    const x = -16 + u * (W + 32);
    if (u <= 0.90) {
      const mVal = massifNorm[Math.min(samples - 1, Math.round(u * (samples - 1)))];
      const saddle = 344 - mVal * 10 - Math.exp(-((u - 0.16) ** 2) / 0.009) * 14 - Math.exp(-((u - 0.47) ** 2) / 0.008) * 13;
      return { x, y: saddle };
    }
    const ru = (u - 0.90) / 0.10;
    const climbY = 340 - (ru ** 1.08) * 62;
    return { x, y: climbY };
  });
  const p1 = fractalAlpinePoints(r1Raw, { amp: 9, seed: 2.9, octaves: 3, yMin: 274, yMax: 356 });

  // Signature Steep Right Alpine Crag framing 4.8M & ≈$46.70 with multi-shoulder Matterhorn cliff profile
  const steepRightRaw = [
    { x: 366, y: 516 },
    { x: 428, y: 412 },
    { x: 472, y: 374 },
    { x: 526, y: 332 },
    { x: 578, y: 288 },
    { x: 638, y: 264 },
    { x: 694, y: 224 },
    { x: 742, y: 210 },
    { x: 776, y: 188 },
  ];
  const pRightCrag = fractalAlpinePoints(steepRightRaw, { amp: 11, seed: 4.1, octaves: 3, yMin: 182, yMax: 520 });

  // Plane 3: Mid-foreground craggy massif (left shoulder held strictly at y >= 458 so Light Left Waist floats cleanly)
  const r2Arr = shiftArr(massifNorm, 2).map((v, i) => {
    const u = i / (samples - 1);
    const midCrag = Math.exp(-((u - 0.50) ** 2) / 0.015) * 0.38 + Math.exp(-((u - 0.76) ** 2) / 0.014) * 0.44;
    const val = Math.min(1, v * 0.34 + 0.14 + Math.max(0, 0.22 - u * 0.48) + midCrag);
    return u < 0.46 ? Math.min(0.42, val) : val;
  });
  const p2 = fractalAlpinePoints(fullPts(r2Arr, isAll ? 464 : 484, isAll ? 48 : 66), { amp: 10, seed: 5.2, octaves: 3, yMin: 418, yMax: isAll ? 498 : 486 });

  const defs = `<defs>
    <filter id="agy-ed-grain" x="0" y="0" width="100%" height="100%">
      <feTurbulence type="fractalNoise" baseFrequency="0.72" numOctaves="2" stitchTiles="stitch"/>
      <feColorMatrix type="saturate" values="0"/>
    </filter>
    <filter id="agy-ed-fog-plume" x="-18%" y="-45%" width="136%" height="190%">
      <feGaussianBlur stdDeviation="30"/>
    </filter>
    <filter id="agy-ed-cloud-soft" x="-40%" y="-80%" width="180%" height="260%">
      <feGaussianBlur stdDeviation="6.0"/>
    </filter>
    <filter id="agy-ed-cloud-body" x="-40%" y="-80%" width="180%" height="260%">
      <feGaussianBlur stdDeviation="9.0"/>
    </filter>
    <filter id="agy-ed-cloud-haze" x="-30%" y="-100%" width="160%" height="300%">
      <feGaussianBlur stdDeviation="11.5"/>
    </filter>
    <filter id="agy-ed-cloud-rim" x="-30%" y="-70%" width="160%" height="240%">
      <feGaussianBlur stdDeviation="3.2"/>
    </filter>
    <filter id="agy-ed-celestial-bloom" x="-120%" y="-120%" width="340%" height="340%">
      <feGaussianBlur stdDeviation="9.5"/>
    </filter>
    <filter id="agy-ed-celestial-halation" x="-120%" y="-120%" width="340%" height="340%">
      <feGaussianBlur stdDeviation="3.2"/>
    </filter>
    <filter id="agy-ed-celestial-feather" x="-100%" y="-100%" width="300%" height="300%">
      <feGaussianBlur stdDeviation="1.4"/>
    </filter>
    <filter id="agy-ed-moon-feather" x="-80%" y="-80%" width="260%" height="260%">
      <feGaussianBlur stdDeviation="0.85"/>
    </filter>
    <filter id="agy-ed-moon-maria" x="-30%" y="-30%" width="160%" height="160%" color-interpolation-filters="sRGB">
      <feTurbulence type="fractalNoise" baseFrequency="${(1.25 / Math.max(12, sunR)).toFixed(4)}" numOctaves="4" seed="11" result="noise"/>
      <feColorMatrix type="matrix" values="0 0 0 0 0.56  0 0 0 0 0.43  0 0 0 0 0.27  0 0 0 ${pal.isDark ? '0.56 -0.16' : '0.42 -0.12'}" in="noise" result="maria"/>
      <feGaussianBlur stdDeviation="1.3" in="maria"/>
    </filter>
    <filter id="agy-ed-shadow" x="-20%" y="-60%" width="140%" height="220%">
      <feDropShadow dx="0" dy="1.4" stdDeviation="2.4" flood-color="#05070a" flood-opacity="0.88"/>
    </filter>
    <filter id="agy-ed-micro-shadow" x="-25%" y="-60%" width="150%" height="220%">
      <feDropShadow dx="0" dy="0.8" stdDeviation="1.2" flood-color="#05070a" flood-opacity="0.84"/>
    </filter>
    <filter id="agy-ed-light-glow" x="-20%" y="-60%" width="140%" height="220%">
      <feDropShadow dx="0" dy="0" stdDeviation="3.2" flood-color="#fdf7e9" flood-opacity="0.94"/>
    </filter>
    <linearGradient id="agy-ed-sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${sky.skyTop}"/>
      <stop offset="32%" stop-color="${sky.skyMid}"/>
      <stop offset="52%" stop-color="${sky.skyHorizon}"/>
      <stop offset="72%" stop-color="${pal.ridgeBots[5]}"/>
      <stop offset="100%" stop-color="${pal.ridgeBots[5]}"/>
    </linearGradient>
    <radialGradient id="agy-ed-sun-aura" cx="${sunCx.toFixed(1)}" cy="${sunCy.toFixed(1)}" r="${(260 + sky.lowSun * 140).toFixed(1)}" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="${sky.sunGlow}" stop-opacity="${pal.isDark ? '0.42' : '0.46'}"/>
      <stop offset="30%" stop-color="${sky.sunMid}" stop-opacity="${pal.isDark ? '0.20' : '0.24'}"/>
      <stop offset="65%" stop-color="${sky.sunGlow}" stop-opacity="${pal.isDark ? '0.06' : '0.07'}"/>
      <stop offset="100%" stop-color="${sky.skyTop}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="agy-ed-sun-corona" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="${sky.sunHi}" stop-opacity="${pal.isDark ? '0.48' : '0.52'}"/>
      <stop offset="24%" stop-color="${sky.sunGlow}" stop-opacity="${pal.isDark ? '0.30' : '0.32'}"/>
      <stop offset="55%" stop-color="${sky.sunMid}" stop-opacity="${pal.isDark ? '0.10' : '0.12'}"/>
      <stop offset="100%" stop-color="${sky.sunGlow}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="agy-ed-sun-inner" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="${pal.isDark ? '0.88' : '0.95'}"/>
      <stop offset="42%" stop-color="${sky.sunHi}" stop-opacity="${pal.isDark ? '0.54' : '0.62'}"/>
      <stop offset="76%" stop-color="${sky.sunGlow}" stop-opacity="${pal.isDark ? '0.16' : '0.20'}"/>
      <stop offset="100%" stop-color="${sky.sunGlow}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="agy-ed-sun" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="1"/>
      <stop offset="48%" stop-color="${sky.sunHi}" stop-opacity="0.98"/>
      <stop offset="80%" stop-color="${sky.sunMid}" stop-opacity="${pal.isDark ? '0.82' : '0.72'}"/>
      <stop offset="100%" stop-color="${sky.sunMid}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="agy-ed-moon-corona" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="${sky.sunHi}" stop-opacity="${pal.isDark ? '0.44' : '0.48'}"/>
      <stop offset="26%" stop-color="${sky.sunGlow}" stop-opacity="${pal.isDark ? '0.24' : '0.22'}"/>
      <stop offset="58%" stop-color="${sky.sunGlow}" stop-opacity="${pal.isDark ? '0.07' : '0.06'}"/>
      <stop offset="100%" stop-color="${sky.sunGlow}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="agy-ed-moon-inner" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="${sky.sunHi}" stop-opacity="${pal.isDark ? '0.66' : '0.72'}"/>
      <stop offset="54%" stop-color="${sky.sunMid}" stop-opacity="${pal.isDark ? '0.26' : '0.22'}"/>
      <stop offset="100%" stop-color="${sky.sunGlow}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="agy-ed-moon-disc" cx="46%" cy="44%" r="54%">
      <stop offset="0%" stop-color="#fffdf5" stop-opacity="1"/>
      <stop offset="60%" stop-color="${sky.sunHi}" stop-opacity="0.98"/>
      <stop offset="88%" stop-color="${sky.sunMid}" stop-opacity="0.90"/>
      <stop offset="100%" stop-color="${sky.sunMid}" stop-opacity="0.35"/>
    </radialGradient>
    <radialGradient id="agy-ed-moon-limb-grad" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="62%" stop-color="#e0e0e0"/>
      <stop offset="88%" stop-color="#606060"/>
      <stop offset="100%" stop-color="#000000"/>
    </radialGradient>
    <mask id="agy-ed-moon-limb-mask" maskUnits="userSpaceOnUse" x="${(-sunR).toFixed(1)}" y="${(-sunR).toFixed(1)}" width="${(sunR * 2).toFixed(1)}" height="${(sunR * 2).toFixed(1)}">
      <circle cx="0" cy="0" r="${(sunR * 0.95).toFixed(1)}" fill="url(#agy-ed-moon-limb-grad)"/>
    </mask>
    <linearGradient id="agy-ed-cloud-grad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${sky.cloudWarm}"/>
      <stop offset="52%" stop-color="${sky.cloudBody}"/>
      <stop offset="100%" stop-color="${sky.cloudShadow}"/>
    </linearGradient>
    <linearGradient id="agy-ed-cloud-cirrus" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="${sky.cloudBody}"/>
      <stop offset="${Math.max(8, Math.min(92, (sunCx / W) * 100)).toFixed(1)}%" stop-color="${sky.cloudRim}"/>
      <stop offset="100%" stop-color="${sky.cloudWarm}"/>
    </linearGradient>
    ${pal.ridgeTops.map((topC, idx) => `<linearGradient id="agy-ed-r${idx}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${topC}"/>
      <stop offset="100%" stop-color="${pal.ridgeBots[idx]}"/>
    </linearGradient>`).join('')}
    <linearGradient id="agy-ed-right-crag" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${pal.rightCragTop}"/>
      <stop offset="100%" stop-color="${pal.rightCragBot}"/>
    </linearGradient>
    <linearGradient id="agy-ed-mist-a" x1="0.1" y1="0" x2="0.85" y2="1">
      <stop offset="0%" stop-color="${sky.mistWarm}" stop-opacity="${pal.isDark ? '0.52' : '0.88'}"/>
      <stop offset="65%" stop-color="${sky.mistDeep}" stop-opacity="${pal.isDark ? '0.38' : '0.62'}"/>
      <stop offset="100%" stop-color="${sky.mistDeep}" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="agy-ed-mist-b" x1="0.15" y1="0" x2="0.8" y2="1">
      <stop offset="0%" stop-color="${sky.mistWarm}" stop-opacity="${pal.isDark ? '0.58' : '0.24'}"/>
      <stop offset="55%" stop-color="${sky.mistDeep}" stop-opacity="${pal.isDark ? '0.40' : '0.12'}"/>
      <stop offset="100%" stop-color="${sky.mistDeep}" stop-opacity="0"/>
    </linearGradient>
    <clipPath id="agy-ed-full-clip"><rect x="0" y="0" width="${W}" height="${H}"/></clipPath>
    <clipPath id="agy-ed-c0"><path d="${closedPolyArea(p0, 620)}"/></clipPath>
    <clipPath id="agy-ed-c1"><path d="${closedPolyArea(p1, 680)}"/></clipPath>
    <clipPath id="agy-ed-crc"><path d="${closedPolyArea(pRightCrag, 680)}"/></clipPath>
    <clipPath id="agy-ed-c2"><path d="${closedPolyArea(p2, 720)}"/></clipPath>
  </defs>`;

  const reliefR0 = buildAlpineRelief(p0, {
    clipId: 'agy-ed-c0', sunCx, bottomY: 620,
    lightCol: sky.alpenglow, shadowCol: pal.ridgeBots[0],
    lightOp: pal.isDark ? 0.16 : 0.22, shadowOp: pal.isDark ? 0.28 : 0.16,
    rimCol: sky.alpenglow, rimOp: pal.isDark ? 0.30 : 0.38, minProminence: 8, maxPeaks: 4, seed: 1.4,
  });
  const reliefR1 = buildAlpineRelief(p1, {
    clipId: 'agy-ed-c1', sunCx, bottomY: 680,
    lightCol: sky.alpenglow, shadowCol: '#07090d',
    lightOp: pal.isDark ? 0.14 : 0.20, shadowOp: pal.isDark ? 0.32 : 0.22,
    rimCol: sky.alpenglow, rimOp: pal.isDark ? 0.34 : 0.34, minProminence: 8, maxPeaks: 4, seed: 2.9,
  });
  const reliefRightCrag = buildAlpineRelief(pRightCrag, {
    clipId: 'agy-ed-crc', sunCx, bottomY: 680,
    lightCol: sky.alpenglow, shadowCol: '#050608',
    lightOp: pal.isDark ? 0.13 : 0.10, shadowOp: pal.isDark ? 0.34 : 0.30,
    rimCol: sky.sunHi, rimOp: pal.isDark ? 0.34 : 0.26, minProminence: 7, maxPeaks: 3, seed: 4.1,
  });
  const reliefR2 = buildAlpineRelief(p2, {
    clipId: 'agy-ed-c2', sunCx, bottomY: 720,
    lightCol: sky.alpenglow, shadowCol: '#06070a',
    lightOp: pal.isDark ? 0.12 : 0.10, shadowOp: pal.isDark ? 0.30 : 0.24,
    rimCol: sky.alpenglow, rimOp: pal.isDark ? 0.28 : 0.24, minProminence: 7, maxPeaks: 4, seed: 5.2,
  });
  const rightCragSvg = `<path d="${closedPolyArea(pRightCrag, 680)}" fill="url(#agy-ed-right-crag)"/>${reliefRightCrag}`;

  // Plane 4: Sovereign Real-Data Usage Massif (Ridge 3) positioned cleanly below waist captions (y >= 518 on today/d7/d30)
  const yBH = isAll ? 502 : 592;
  const ampH = isAll ? 80 : 72;
  const coreHeroPts = massifNorm.map((v, i) => ({
    x: PAD + (i / (samples - 1)) * HORIZ_W,
    y: yBH - v * ampH,
  }));
  const extHeroPts = [
    { x: -16, y: coreHeroPts[0].y + 8 },
    ...coreHeroPts,
    { x: W + 16, y: coreHeroPts[coreHeroPts.length - 1].y + 6 },
  ];
  const p3 = fractalAlpinePoints(extHeroPts, { amp: 5.0, seed: 6.7, octaves: 2, lockIdx: massifPeakIdx + 1, yMin: 422, yMax: yBH });

  // Diagonal luminous golden valley fog plumes (flowing along the chasm like painted watercolor clouds!)
  const mistPlumeA = `<path data-mtn-anim="mist-a" d="M-30 342C120 356 260 398 430 434C560 462 660 412 790 364L790 520L-30 500Z" fill="url(#agy-ed-mist-a)" filter="url(#agy-ed-fog-plume)"${phase ? ` transform="translate(${(Math.sin(phaseRad) * 16).toFixed(1)}, ${(Math.sin(phaseRad * 2) * 2.5).toFixed(1)})" opacity="${(1 - 0.06 * (1 - Math.cos(phaseRad)) * 0.5).toFixed(2)}"` : ''}/>`;
  const mistPlumeB = `<path data-mtn-anim="mist-b" d="M-30 438C140 466 320 518 475 512C595 508 690 472 790 448L790 618L-30 584Z" fill="url(#agy-ed-mist-b)" filter="url(#agy-ed-fog-plume)"${phase ? ` transform="translate(${(-Math.sin(phaseRad) * 13).toFixed(1)}, ${(-Math.sin(phaseRad * 2) * 2).toFixed(1)})" opacity="${(1 - 0.06 * (1 - Math.cos(phaseRad * 2)) * 0.5).toFixed(2)}"` : ''}/>`;
  const mistPlumeC = !isAll
    ? `<path data-mtn-anim="mist-c" d="M90 520Q340 586 580 546L640 652L110 644Z" fill="url(#agy-ed-mist-b)" fill-opacity="${phase ? (0.72 * (1 + 0.12 * Math.sin(phaseRad))).toFixed(2) : '0.72'}" filter="url(#agy-ed-fog-plume)"${phase ? ` transform="translate(${(Math.sin(phaseRad) * 10).toFixed(1)}, ${((1 - Math.cos(phaseRad)) * 2.2).toFixed(1)})"` : ''}/>`
    : '';

  // Plane 5: Bold pine-fringed foreground dark slopes descending into solid bottom ground
  const leftSlopePts = fractalAlpinePoints([
    { x: -16, y: 490 },
    { x: 160, y: 586 },
    { x: 372, y: 696 },
    { x: 635, y: 834 },
    { x: 776, y: 910 },
  ], { amp: 6, seed: 7.4, octaves: 2, yMin: 480, yMax: 920, pineFringe: true });
  const rightSlopePts = fractalAlpinePoints([
    { x: 112, y: 960 },
    { x: 288, y: 862 },
    { x: 540, y: 745 },
    { x: 776, y: 648 },
  ], { amp: 6, seed: 8.8, octaves: 2, yMin: 636, yMax: 960, pineFringe: true });

  const ridge4Svg = isAll
    ? `<path d="M-16 960L-16 468L108 504L214 516L580 516L682 486L776 452L776 960Z" fill="url(#agy-ed-r4)"/>`
    : `<path d="${closedPolyArea(leftSlopePts, 960)}" fill="url(#agy-ed-r4)"/>`;
  const ridge5Svg = isAll
    ? `<path d="M-16 960L-16 516L776 516L776 960Z" fill="${pal.ridgeBots[5]}"/>`
    : `<path d="${closedPolyArea(rightSlopePts, 960)}" fill="url(#agy-ed-r5)"/>`;

  const cloudsSvg = renderPaintedClouds({ W, hour, sky, isDark: pal.isDark, phase, phaseRad });
  const sunSvg = renderCelestialSvg({ sky, isDark: pal.isDark, phase, phaseRad });
  const horizonVeilSvg = sky.lowSun > 0.22 && sunCy > 210
    ? `<path d="M-40 288Q190 274 385 286T800 280L800 342L-40 344Z" fill="${sky.skyHorizon}" fill-opacity="${Math.min(0.24, (sky.lowSun - 0.22) * 0.26).toFixed(2)}" filter="url(#agy-ed-cloud-haze)"/>`
    : '';

  // Monumental hero text centered across sky, tucked cleanly behind Ridge 1 horizon & steep right crag!
  const giantHeroSvg = `<text x="380" y="${heroY}" font-family="${FONT_DISPLAY}" font-size="${heroSize}" font-weight="400" fill="${pal.heroText}" letter-spacing="-0.03em" text-anchor="middle" style="font-variant-numeric:tabular-nums lining-nums">${escapeXml(heroText)}</text>`;

  // Case D Topographic Contour Hairlines on Sovereign Range 3
  const contourR3 = contourLinesSvg(p3, [11, 23, 36, 50], pal.contourInk, [0.12, 0.085, 0.06, 0.04]);

  // Case D Spatial Elevation Pins anchored dynamically along real Ridge 3 terrain with strict clearance below Waist
  const useLightInk = !pal.isDark && isAll;
  const rightWaistLeft = Math.min(costLeft, 720 - textVisualUnits(activeSummary) * 13.5 * 0.58 - (totalNew > 0 ? 75 : 0));
  const renderPin = ({ x, y, stemH, label, isPeak = false }) => {
    const minLblTop = isAll ? 404 : 514;
    const anchor = x < 210 ? 'start' : (x > 520 ? 'end' : 'middle');
    const lblX = anchor === 'start' ? Math.max(PAD, x - 4) : (anchor === 'end' ? Math.min(HORIZ_R + 10, x + 4) : x);
    const estLblW = textVisualUnits(label) * 12.5 * 0.58;
    const lblLeft = anchor === 'start' ? lblX : (anchor === 'end' ? lblX - estLblW : lblX - estLblW / 2);
    const lblRight = anchor === 'start' ? lblX + estLblW : (anchor === 'end' ? lblX : lblX + estLblW / 2);
    const pinMinX = Math.min(x - 10, lblLeft - 6);
    const pinMaxX = Math.max(x + 10, lblRight + 6);
    const dropBelowWaist = isAll && isPeak && (
      (y <= 488 && pinMaxX >= rightWaistLeft - 10)
      || (y <= 448 && pinMinX <= leftWaistRight + 10)
    );
    const dotY = dropBelowWaist ? 512 : y;
    const pinTop = dropBelowWaist ? 502 : Math.max(minLblTop, Math.min(y - 6, y - stemH));
    const lblY = dropBelowWaist ? 499 : (pinTop - 5);
    const lblFontSize = dropBelowWaist ? 11.5 : 12.5;
    const useLight = useLightInk && !dropBelowWaist;
    const pinInkCol = useLight ? pal.pinInkLight : pal.pinInk;
    const pinDotCol = useLight ? pal.pinDotLight : pal.pinDot;
    const pinFilter = useLight ? 'agy-ed-light-glow' : 'agy-ed-shadow';
    const beaconMaxExpand = dropBelowWaist ? 4.5 : 5.2;
    const beaconRing = isPeak
      ? `\n    <circle data-mtn-anim="beacon" cx="${x.toFixed(1)}" cy="${dotY.toFixed(1)}" r="${phase ? (2.9 + beaconMaxExpand * phase).toFixed(1) : '2.9'}" fill="none" stroke="${pinDotCol}" stroke-opacity="${phase ? ((1 - phase) * 0.65).toFixed(2) : '0'}" stroke-width="1"/>`
      : '';
    return `<line x1="${x.toFixed(1)}" y1="${(dotY - 3.5).toFixed(1)}" x2="${x.toFixed(1)}" y2="${pinTop.toFixed(1)}" stroke="${pinDotCol}" stroke-opacity="0.90" stroke-width="1.05"/>
    <circle cx="${x.toFixed(1)}" cy="${dotY.toFixed(1)}" r="${isPeak ? '2.9' : '2.3'}" fill="${pinDotCol}" stroke="${pal.ridgeBots[3]}" stroke-width="1.1"/>${beaconRing}
    <text x="${lblX.toFixed(1)}" y="${lblY.toFixed(1)}" font-family="${FONT_SANS}" font-size="${lblFontSize}" font-weight="600" fill="${pinInkCol}" filter="url(#${pinFilter})" text-anchor="${anchor}" style="font-variant-numeric:tabular-nums lining-nums">${escapeXml(label)}</text>`;
  };

  let pinsSvg = '';
  const usedPinXs = [];
  if (maxTok > 0 && coreHeroPts.length) {
    const pk = coreHeroPts[massifPeakIdx];
    usedPinXs.push(pk.x);
    const lbl1 = peakTimeLbl ? `▲ ${fmtTok(maxTok)} · ${peakTimeLbl}` : `▲ ${fmtTok(maxTok)}`;
    pinsSvg += renderPin({ x: pk.x, y: pk.y, stemH: isAll ? 16 : 22, label: lbl1, isPeak: true });
  }
  const avgCallStr = calls > 0 ? fmtTok(Math.round(totalNew / calls)) : '—';
  const avgConvStr = convs > 0 ? fmtTok(Math.round(totalNew / convs)) : '—';
  const p2Candidates = [195, 495, 130, 585];
  let bestP2 = p2Candidates[0];
  let bestP2Dist = -1;
  for (const cx of p2Candidates) {
    const d = usedPinXs.length ? Math.min(...usedPinXs.map((ux) => Math.abs(cx - ux))) : 999;
    if (d > bestP2Dist) { bestP2Dist = d; bestP2 = cx; }
  }
  if (!isAll && bestP2Dist >= 205 && totalNew > 0) {
    const p2y = ridgeYAtX(p3, bestP2);
    const p2lbl = normLang === 'zh'
      ? `均次 ${avgCallStr} · 单对话 ${avgConvStr}`
      : `AVG ${avgCallStr}/CALL · ${avgConvStr}/CONV`;
    pinsSvg += renderPin({ x: bestP2, y: p2y, stemH: 20, label: p2lbl });
  }

  const canvasSvg = `<g clip-path="url(#agy-ed-full-clip)">
    ${!webglCutout ? `<rect x="0" y="0" width="${W}" height="${H}" fill="url(#agy-ed-sky)"/>` : ''}
    <rect x="0" y="0" width="${W}" height="${H}" fill="url(#agy-ed-sun-aura)" data-mtn-anim="aura"${phase ? ` opacity="${(1 - 0.08 * (1 - Math.cos(phaseRad)) * 0.5).toFixed(2)}"` : (webglCutout ? ' opacity="0.55"' : '')}/>
    ${webglCutout ? `<g opacity="0.28">${cloudsSvg}</g>` : cloudsSvg}
    ${sunSvg}
    ${horizonVeilSvg}
    <path d="${closedPolyArea(p0, 620)}" fill="url(#agy-ed-r0)"/>
    ${reliefR0}
    ${rightCragSvg}
    ${giantHeroSvg}
    <path d="${closedPolyArea(p1, 680)}" fill="url(#agy-ed-r1)"/>
    ${reliefR1}
    ${mistPlumeA}
    <path d="${closedPolyArea(p2, 720)}" fill="url(#agy-ed-r2)"/>
    ${reliefR2}
    ${mistPlumeB}
    <path d="${closedPolyArea(p3, 760)}" fill="url(#agy-ed-r3)"/>
    ${contourR3}
    <path d="${openPolyPath(p3)}" fill="none" stroke="${sky.alpenglow}" stroke-opacity="${pal.isDark ? '0.44' : '0.32'}" stroke-width="1.2"/>
    ${mistPlumeC}
    ${ridge4Svg}
    ${ridge5Svg}
    ${pinsSvg}
    <rect x="0" y="0" width="${W}" height="${H}" filter="url(#agy-ed-grain)" opacity="${pal.isDark ? '0.045' : '0.036'}"/>
    ${horizonSvg}
  </g>`;

  return { defs, activeSummary, activeDailyCount, isAll, canvasSvg };
}

export function buildShareCardSvg(input = {}, animPhase = 0) {
  const src = input && typeof input === 'object' ? input : {};
  const rawPhase = typeof animPhase === 'number' && Number.isFinite(animPhase) && animPhase !== 0
    ? animPhase
    : (typeof src.animPhase === 'number' && Number.isFinite(src.animPhase) && src.animPhase !== 0 ? src.animPhase : 0);
  const phase = rawPhase ? (((rawPhase % 1) + 1) % 1) : 0;
  const phaseRad = phase * Math.PI * 2;
  const periodKey = VALID_PERIODS.has(src.period) ? src.period : 'd30';
  const normLang = normalizeLang(src.lang);
  const t = createTranslator(normLang);
  const pal = src.theme === 'light' ? THEMES.light : THEMES.dark;
  const W = SHARE_CARD_WIDTH;
  const H = SHARE_CARD_HEIGHT;
  const PAD = 36;
  const RIGHT = 720;
  const fontFor = (kind) => (
    kind === 'display' ? FONT_DISPLAY
      : kind === 'sans' ? FONT_SANS
        : kind === 'mono' ? FONT_MONO
          : FONT_SERIF
  );
  const txt = (x, y, s, { size = 15, fill = pal.fgMuted, weight = 400, anchor = 'start', font = 'serif', num = false, ls = null, italic = false, filter = null } = {}) => (
    `<text x="${x}" y="${y}" font-family="${fontFor(font)}" font-size="${size}" font-weight="${weight}" fill="${fill}"${italic ? ' font-style="italic"' : ''}${anchor !== 'start' ? ` text-anchor="${anchor}"` : ''}${ls ? ` letter-spacing="${ls}"` : ''}${filter ? ` filter="url(#${filter})"` : ''}${num ? ' style="font-variant-numeric:tabular-nums lining-nums"' : ''}>${escapeXml(s)}</text>`
  );

  // Strict allowlist: extract only aggregate totals, byModel and daily.
  const rawTotals = src.totals && typeof src.totals === 'object' ? src.totals : {};
  const bucket = rawTotals[periodKey] && typeof rawTotals[periodKey] === 'object'
    ? rawTotals[periodKey]
    : (('input' in rawTotals || 'output' in rawTotals || 'calls' in rawTotals || 'conversations' in rawTotals) ? rawTotals : {});

  const inp = safeNum(bucket.input);
  const out = safeNum(bucket.output);
  const cache = safeNum(bucket.cache_read);
  const totalNew = inp + out;
  const calls = safeNum(bucket.calls);
  const convs = safeNum(bucket.conversations);

  const rawByModelInput = src.byModel !== undefined ? src.byModel : src.by_model;
  let rawByModel = [];
  if (Array.isArray(rawByModelInput)) {
    rawByModel = rawByModelInput;
  } else if (rawByModelInput && typeof rawByModelInput === 'object') {
    if (Array.isArray(rawByModelInput[periodKey])) rawByModel = rawByModelInput[periodKey];
    else if (Array.isArray(rawByModelInput.all)) rawByModel = rawByModelInput.all;
  }
  const models = sanitizeModels(rawByModel, t('unknown'), periodKey).filter((m) => m.input + m.output + m.cache_read > 0 || m.calls > 0);

  const costPartial = Boolean(bucket.cost_partial)
    || (periodKey === 'all' && rawByModel.some((m) => m && safeNum(m.calls) > 0 && !isNum(m.est_cost_usd)));
  const costVal = isNum(bucket.est_cost_usd) && bucket.est_cost_usd >= 0 ? bucket.est_cost_usd : null;
  const costStr = costVal !== null
    ? fmtCost(costVal, { estimated: Boolean(bucket.cost_estimated), partial: costPartial })
    : '—';

  const periodLabel = scrubSensitiveText(t('periods')[periodKey] || periodKey);
  const dailyAll = sanitizeDaily(src.daily);
  let dailySlice = dailyAll;
  if (periodKey === 'today') dailySlice = dailyAll.slice(-1);
  else if (periodKey === 'd7') dailySlice = dailyAll.slice(-7);
  else if (periodKey === 'd30') dailySlice = dailyAll.slice(-30);
  let spanStr = '';
  if (dailySlice.length === 1) spanStr = dailySlice[0].date;
  else if (dailySlice.length > 1) spanStr = `${dailySlice[0].date} – ${dailySlice[dailySlice.length - 1].date}`;

  // Monumental full-width Case A hero numerals with guaranteed full horizontal & right-edge legibility
  const heroStr = fmtTok(totalNew);
  const heroLen = heroStr.length;
  const rawHeroSize = heroLen <= 3 ? 304 : (heroLen === 4 ? 286 : (heroLen === 5 ? 226 : (heroLen === 6 ? 178 : 146)));
  const heroUnits = Math.max(1, textVisualUnits(heroStr));
  const heroSize = heroUnits * rawHeroSize * 0.58 > 644
    ? Math.max(116, Math.round(644 / (heroUnits * 0.58)))
    : rawHeroSize;
  const heroY = heroSize >= 260 ? 334 : (heroLen >= 6 ? 318 : 326);

  const costLen = costStr.length;
  const costSize = costLen <= 7 ? 74 : (costLen === 8 ? 62 : 52);
  const costLeft = RIGHT - Math.max(120, textVisualUnits(costStr) * costSize * 0.60);
  const availQuipW = Math.max(190, costLeft - PAD - 18);
  const quip = typeof src.quip === 'string' ? truncateByWidth(scrubSensitiveText(src.quip), 58) : '';
  const quipUnits = textVisualUnits(quip);
  const quipSize = quip && quipUnits * 21.5 * 0.56 > availQuipW
    ? Math.max(12.5, +(availQuipW / Math.max(1, quipUnits * 0.56)).toFixed(1))
    : 21.5;
  const waistSub = normLang === 'zh' ? '算力年鉴 · 不含缓存' : 'COMPUTE ALMANAC';
  const leftWaistRight = PAD + Math.max(
    textVisualUnits(waistSub) * 14 * 0.62,
    quip ? quipUnits * quipSize * 0.57 : 0,
  );

  const hour = resolveCardHour(src);
  const sky = computeSkyMood(hour, pal.isDark);
  const hourly = sanitizeHourly(src.hourlyToday ?? src.hourly_today);
  const webglCutout = Boolean(src.webglCutout);
  const { defs, activeSummary, activeDailyCount, isAll, canvasSvg } = renderFullBleedLandscape({
    W, H, periodKey, dailySlice, hourly, pal, t, normLang, txt,
    heroText: heroStr, heroY, heroSize, calls, convs, totalNew, hour, sky, phase, phaseRad,
    costLeft, leftWaistRight, webglCutout,
  });

  // Top-left whisper masthead (uncluttered calm sky matching target poster)
  const mastheadText = `AGY LENS  /  ${normLang === 'en' ? periodLabel.toUpperCase() : periodLabel}`;
  const topWhisper = txt(PAD, 42, mastheadText, { size: 13.5, fill: pal.skyMuted, weight: 600, font: 'sans', ls: '0.18em' });

  // Asymmetric Mid-Waist Floating Editorial Anchors
  let paceStr = '';
  if (periodKey !== 'today' && activeDailyCount > 0 && totalNew > 0) {
    const perDay = fmtTok(Math.round(totalNew / activeDailyCount));
    paceStr = normLang === 'zh' ? `日均 ${perDay}` : `${perDay}/DAY`;
  } else if (periodKey === 'today' && calls > 0 && totalNew > 0) {
    const perCall = fmtTok(Math.round(totalNew / calls));
    paceStr = normLang === 'zh' ? `均次 ${perCall}` : `${perCall}/CALL`;
  }
  const waistRightLine = paceStr ? `${activeSummary} · ${paceStr}` : activeSummary;
  const waistFilter = pal.isDark ? 'agy-ed-shadow' : 'agy-ed-light-glow';
  const waistAnchors = `
  ${txt(PAD, 398, waistSub, { size: 14, fill: pal.waistSub, weight: 600, font: 'sans', ls: normLang === 'zh' ? '0.14em' : '0.16em', filter: waistFilter })}
  ${quip ? txt(PAD, 430, quip, { size: quipSize, fill: pal.waistInk, weight: normLang === 'en' ? 400 : 600, font: normLang === 'en' ? 'display' : 'serif', italic: normLang === 'en', filter: waistFilter }) : ''}
  ${txt(RIGHT, 452, costStr, { size: costSize, fill: pal.waistAccent, weight: 400, font: 'display', anchor: 'end', ls: '-0.02em', num: true, filter: 'agy-ed-shadow' })}
  ${txt(RIGHT, 480, waistRightLine, { size: 13.5, fill: pal.waistRightSub, weight: 500, font: 'sans', anchor: 'end', ls: '0.04em', num: true, filter: 'agy-ed-shadow' })}`;

  // Staggered Lower-Left: Pure Luxury Serif Diagonal Stepped Model Cascade (zero UI progress bars!)
  const topModels = models.slice(0, 4);
  const extraModels = Math.max(0, models.length - topModels.length);
  const sumNew = models.reduce((acc, m) => acc + m.input + m.output, 0);
  const few = topModels.length <= 3;
  const cascadeBaseY = isAll ? (few ? 690 : 682) : (few ? 684 : 672);
  const cascadePitch = few ? 48 : 40;
  const cascadeStepX = few ? 36 : 28;
  const baseFontSize = few ? 29 : 24;
  let cascadeRows = '';
  if (!topModels.length) {
    cascadeRows = txt(PAD, 742, t('noModels'), { size: 20, fill: pal.fgMuted, font: 'serif' });
  } else {
    cascadeRows = topModels.map((m, i) => {
      const rx = PAD + i * cascadeStepX;
      const y = cascadeBaseY + i * cascadePitch;
      const mName = truncateByWidth(m.name, 29.5);
      const mNew = m.input + m.output;
      const share = sumNew > 0 ? fmtPctNum((mNew / sumNew) * 100) : '0%';
      const idxStr = String(i + 1).padStart(2, '0');
      const metricPart = `${fmtTok(mNew)} · ${share}`;
      const rowUnits = Math.max(1, textVisualUnits(`${idxStr} ${mName} — ${metricPart}`));
      const maxRowW = Math.max(360, (i >= 3 ? 520 : 668) - rx);
      const sz = rowUnits * baseFontSize * 0.53 > maxRowW
        ? Math.max(15, +(maxRowW / (rowUnits * 0.53)).toFixed(1))
        : baseFontSize;
      return `<text x="${rx}" y="${y}" font-family="${FONT_DISPLAY}" font-size="${sz}" font-weight="400" data-ledger-row="${i}" style="font-variant-numeric:tabular-nums lining-nums"><tspan fill="${pal.fgAccent}" font-size="${Math.round(sz * 0.78)}" letter-spacing="0.06em">${escapeXml(idxStr)} </tspan><tspan fill="${pal.fgInk}">${escapeXml(mName)} </tspan><tspan fill="${pal.fgMuted}">— </tspan><tspan fill="${pal.fgSub}">${escapeXml(metricPart)}</tspan></text>`;
    }).join('\n  ');
    const subX = PAD + topModels.length * cascadeStepX + 18;
    const subY = Math.min(838, cascadeBaseY + topModels.length * cascadePitch + 2);
    const ioLine = normLang === 'zh'
      ? `输入 ${fmtTok(inp)} · 输出 ${fmtTok(out)}${extraModels > 0 ? ` · ${t('shareMoreModels', extraModels)}` : ''}`
      : `IN ${fmtTok(inp)} · OUT ${fmtTok(out)}${extraModels > 0 ? ` · ${t('shareMoreModels', extraModels)}` : ''}`;
    const ioUnits = Math.max(1, textVisualUnits(ioLine));
    const ioSz = ioUnits * 13.5 * 0.56 > 420 ? Math.max(10.5, +(420 / (ioUnits * 0.56)).toFixed(1)) : 13.5;
    cascadeRows += `\n  ${txt(subX, subY, ioLine, { size: ioSz, fill: pal.fgSub, weight: 500, font: 'sans', ls: '0.04em', num: true })}`;
  }

  // Staggered Lower-Right Offset Oversized Cache Reuse Counterweight
  const cwRight = 708;
  const hasReuse = cache > 0 && inp > 0;
  const cwHero = hasReuse ? `×${(cache / inp).toFixed(1)}` : fmtInt(calls, normLang);
  const stackTop = hasReuse ? (normLang === 'zh' ? '缓存' : 'CACHE') : (normLang === 'zh' ? '总计' : 'TOTAL');
  const stackBot = hasReuse ? (normLang === 'zh' ? '复用倍率' : 'REUSE') : (normLang === 'zh' ? '调用' : 'CALLS');
  const cwMeta = normLang === 'zh'
    ? `${fmtTok(cache)} 缓存 · ${fmtInt(calls, normLang)} 次调用 · ${fmtInt(convs, normLang)} 对话`
    : `${fmtTok(cache)} CACHE · ${fmtInt(calls, normLang)} CALLS · ${fmtInt(convs, normLang)} CONVS`;
  const cwUnits = textVisualUnits(cwHero);
  const cwSize = cwHero.length <= 6
    ? 68
    : Math.max(28, Math.min(54, Math.round(196 / Math.max(3.6, cwUnits * 0.52))));
  const counterweight = `
  ${txt(624, 890, cwHero, { size: cwSize, fill: pal.fgAccent, weight: 400, font: 'display', anchor: 'end', ls: '-0.02em', num: true })}
  ${txt(634, 865, stackTop, { size: 14.5, fill: pal.fgInk, weight: 600, font: 'sans', ls: '0.10em' })}
  ${txt(634, 885, stackBot, { size: 14.5, fill: pal.fgInk, weight: 600, font: 'sans', ls: '0.10em' })}
  ${txt(cwRight, 918, cwMeta, { size: 13.5, fill: pal.fgSub, weight: 500, font: 'sans', anchor: 'end', ls: '0.03em', num: true })}`;

  // Edge colophon: quiet bottom-left repo stamp + far-right vertical rotated margin spine
  const spineStr = `${spanStr ? `${spanStr} · ` : ''}${t('shareFooter')}`;
  const spineUnits = Math.max(1, textVisualUnits(spineStr));
  const spineSz = spineUnits * 11 * 0.58 > 856 ? Math.max(8.5, +(856 / (spineUnits * 0.58)).toFixed(1)) : 11;
  const colophonEdges = `
  ${txt(PAD, 924, 'github.com/Aoike123/agy-lens', { size: 11, fill: pal.fgMuted, weight: 500, font: 'sans', ls: '0.05em' })}
  <text x="740" y="924" transform="rotate(-90 740 924)" font-family="${FONT_SANS}" font-size="${spineSz}" font-weight="500" fill="${pal.fgMuted}" letter-spacing="0.06em" filter="url(#agy-ed-micro-shadow)">${escapeXml(spineStr)}</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" data-editorial-poster="1" data-sky-phase="${sky.phase}" data-sky-hour="${hour.toFixed(2)}" role="img" aria-label="${escapeXml(t('shareAria'))}">
  ${defs}
  ${canvasSvg}
  ${topWhisper}
  ${waistAnchors}
  ${cascadeRows}
  ${counterweight}
  ${colophonEdges}
</svg>`;
}

/** Dispatch any vector share card style (`mountain`, `abyssal`, `eclipse`, `bauhaus`, `phosphor`). */
export function buildShareCardStyleSvg(style, input = {}, animPhase = 0) {
  if (style === 'minimal-dark') return buildShareCardSvg({ ...(input || {}), theme: 'dark' }, animPhase);
  if (style === 'minimal-light') return buildShareCardSvg({ ...(input || {}), theme: 'light' }, animPhase);
  if (style === 'abyssal') return buildAbyssalCardSvg(input, animPhase);
  if (style === 'eclipse') return buildEclipseCardSvg(input, animPhase);
  if (style === 'bauhaus') return buildBauhausCardSvg(input, animPhase);
  if (style === 'phosphor') return buildPhosphorCardSvg(input, animPhase);
  return buildShareCardSvg(input, animPhase);
}

// --- browser-only helpers (never called during pure Node import/SVG tests) ---

let modalState = {
  open: false,
  settingsOpen: false,
  style: 'mountain',
  styleChosen: false,
  theme: 'dark',
  themeChosen: false,
  motionFmt: 'live',
  motionFmtByStyle: Object.create(null),
  data: null,
  period: 'd30',
  lang: 'en',
  t: null,
  quipIdx: 0,
  assetError: false,
  ambient: null,
  webglLoop: null,
  liveRaf: 0,
  liveLastTs: 0,
  livePhase: 0,
  transitionTimer: 0,
  transitionSeq: 0,
  controlsSig: '',
  clockTimer: null,
  gifBusy: false,
  gifCache: null,
  motionBusy: false,
  motionAbort: null,
  motionSeq: 0,
  motionCache: null,
  caps: null,
  pk: null,
};

function parseRgbLuminance(bg) {
  const m = String(bg || '').match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*[,/]\s*([0-9.]+))?\s*\)/i);
  if (!m) return null;
  const alpha = m[4] !== undefined ? Number(m[4]) : 1;
  if (Number.isFinite(alpha) && alpha === 0) return null;
  const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

export function detectPreferredTheme() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return 'dark';
  try {
    const bodyBg = getComputedStyle(document.body).backgroundColor;
    const rootBg = getComputedStyle(document.documentElement).backgroundColor;
    const lum = parseRgbLuminance(bodyBg) ?? parseRgbLuminance(rootBg);
    if (lum !== null) return lum > 0.5 ? 'light' : 'dark';
  } catch { /* ignore style probe failure */ }
  try {
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) return 'light';
  } catch { /* ignore */ }
  return 'dark';
}

function triggerDownload(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function exportShareCardSvg(svgString, filename = 'agy-lens-usage.svg') {
  const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    triggerDownload(url, filename);
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

function loadSvgImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = (err) => reject(err || new Error('SVG image load failed'));
    img.src = src;
  });
}

function svgDimensions(svgString) {
  const m = String(svgString || '').match(/<svg[^>]*\bwidth="(\d+)"[^>]*\bheight="(\d+)"/i);
  const w = m ? Number(m[1]) : SHARE_CARD_WIDTH;
  const h = m ? Number(m[2]) : SHARE_CARD_HEIGHT;
  return {
    baseW: Number.isFinite(w) && w > 0 ? w : SHARE_CARD_WIDTH,
    baseH: Number.isFinite(h) && h > 0 ? h : SHARE_CARD_HEIGHT,
  };
}

export async function exportShareCardPng(svgString, filename = 'agy-lens-usage.png', { scale = 2, download = true } = {}) {
  const { baseW, baseH } = svgDimensions(svgString);
  const width = baseW * scale;
  const height = baseH * scale;
  const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
  const blobUrl = URL.createObjectURL(blob);
  let img;
  try {
    try {
      img = await loadSvgImage(blobUrl);
    } catch {
      const dataSrc = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgString)}`;
      img = await loadSvgImage(dataSrc);
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable');
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0, baseW, baseH);

    const dataUrl = canvas.toDataURL('image/png');
    let pngBlob = await new Promise((resolve) => {
      if (typeof canvas.toBlob === 'function') {
        canvas.toBlob((b) => resolve(b), 'image/png');
      } else {
        resolve(null);
      }
    });
    if (!pngBlob && dataUrl.startsWith('data:image/png;base64,')) {
      const bin = atob(dataUrl.slice('data:image/png;base64,'.length));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      pngBlob = new Blob([bytes], { type: 'image/png' });
    }
    if (download) {
      if (pngBlob) {
        const pngUrl = URL.createObjectURL(pngBlob);
        try {
          triggerDownload(pngUrl, filename);
        } finally {
          setTimeout(() => URL.revokeObjectURL(pngUrl), 1000);
        }
      } else {
        triggerDownload(dataUrl, filename);
      }
    }
    return { blob: pngBlob, dataUrl, width, height };
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

export function renderShareCardPng(svgString, { scale = 2 } = {}) {
  return exportShareCardPng(svgString, 'agy-lens-usage.png', { scale, download: false });
}

export async function copyShareCardSvg(svgString) {
  const text = String(svgString ?? '');
  let writeErr = null;
  if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text);
      return text;
    } catch (err) {
      writeErr = err;
    }
  }
  if (typeof document !== 'undefined' && document.body) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    ta.style.pointerEvents = 'none';
    document.body.appendChild(ta);
    try {
      ta.select();
      const ok = typeof document.execCommand === 'function' && document.execCommand('copy');
      if (ok) return text;
    } finally {
      ta.remove();
    }
  }
  throw writeErr || new Error('Clipboard copy unavailable');
}

function makeClipboardError(code, cause, png = null) {
  const err = new Error((cause && cause.message) || code);
  err.code = code;
  if (cause !== undefined) err.cause = cause;
  if (png !== null) err.png = png;
  return err;
}

export async function copyShareCardPng(svgString, { scale = 2 } = {}) {
  const renderPromise = renderShareCardPng(svgString, { scale });
  if (
    typeof navigator === 'undefined'
    || !navigator.clipboard
    || typeof navigator.clipboard.write !== 'function'
    || typeof ClipboardItem === 'undefined'
  ) {
    const png = await renderPromise;
    throw makeClipboardError('CLIPBOARD_UNAVAILABLE', new Error('Clipboard image API unavailable'), png);
  }
  let png = null;
  try {
    const blobPromise = renderPromise.then((res) => {
      png = res;
      if (!res || !res.blob) throw new Error('PNG blob unavailable');
      return res.blob;
    });
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blobPromise })]);
    if (!png) png = await renderPromise;
    return png;
  } catch (firstErr) {
    if (!png) {
      png = await renderPromise;
    }
    const isPermErr = firstErr && (firstErr.name === 'NotAllowedError' || firstErr.name === 'SecurityError');
    if (!isPermErr && png && png.blob) {
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': png.blob })]);
        return png;
      } catch (secondErr) {
        throw makeClipboardError('CLIPBOARD_DENIED', secondErr, png);
      }
    }
    throw makeClipboardError('CLIPBOARD_DENIED', firstErr, png);
  }
}

export const SHARE_STYLES = ['mountain', 'abyssal', 'eclipse', 'bauhaus', 'phosphor', 'pixel-role'];

const STYLE_ICONS = {
  mountain: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.4 11.4L5.1 4.2l2.5 4 1.6-2.4 3.4 5.6z"/><circle cx="10.3" cy="3.5" r="1.2"/></svg>',
  abyssal: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 2.5c1.8 1.2 3.2 1.2 5 0s3.2-1.2 5 0M4.2 5.2L2.6 11.5M7 5.2v6.3M9.8 5.2l1.6 6.3"/></svg>',
  eclipse: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="7" cy="7" r="3.1"/><ellipse cx="7" cy="7" rx="6" ry="2.2" transform="rotate(-32 7 7)"/></svg>',
  bauhaus: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.8 4.2a4.2 4.2 0 1 0 0 5.6"/><path d="M3 11.2L11.2 3"/></svg>',
  phosphor: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.5 8.6c2.2 2.4 3.8-5.8 6.4-5.8 1.8 0 2.7 3.8 4.6 4.4"/><path d="M1.5 10.6c2.6 1.4 4.2-4.2 6.8-4.2 1.5 0 2.5 2.4 4.2 2.8" opacity=".6"/></svg>',
  'pixel-role': '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 1.8l4.4 1.7v3.5c0 2.8-1.9 4.5-4.4 5.3-2.5-.8-4.4-2.5-4.4-5.3V3.5z"/></svg>',
};

function styleSpec(style = modalState.style) {
  return SHARE_STYLE_SPECS[style] || SHARE_STYLE_SPECS.mountain;
}

function tr() {
  return modalState.t || createTranslator(modalState.lang);
}

function hist() {
  return modalState.data || {};
}

function currentProfile() {
  const pk = modalState.pk;
  return buildProfile(hist(), modalState.period, { nickname: pk.nickname, gender: pk.gender });
}

function currentAchievements(profile) {
  return usageAchievements(hist(), modalState.period, profile.stats);
}

function defaultMotionFmtForStyle(style, caps) {
  if (style !== 'pixel-role') {
    if (!caps || caps.supportsLivePhoto) return 'live';
    if (caps.supportsMp4) return 'mp4';
    if (caps.supportsWebm) return 'webm';
    return 'gif';
  }
  if (caps && caps.supportsLivePhoto) return 'live';
  return 'gif';
}

function availableMotionFormats(caps) {
  const out = [];
  if (!caps || caps.supportsLivePhoto) out.push('live');
  if (!caps || caps.supportsMp4) out.push('mp4');
  else if (caps.supportsWebm) out.push('webm');
  out.push('gif');
  return out;
}

function activeMotionFmt() {
  const allowed = availableMotionFormats(modalState.caps);
  const chosen = modalState.motionFmtByStyle[modalState.style];
  if (chosen && allowed.includes(chosen)) return chosen;
  const def = defaultMotionFmtForStyle(modalState.style, modalState.caps);
  return allowed.includes(def) ? def : allowed[0];
}

// --- pixel art loading (base64 over /api/share-asset, cached as data URIs) ---------------

const assetCache = new Map();
const assetPending = new Map();
let assetList = null;
let assetListPromise = null;

function apiFetch() {
  return typeof fetch === 'function' ? fetch.bind(globalThis) : null;
}

function loadAssetList() {
  if (assetList) return Promise.resolve(assetList);
  if (!assetListPromise) {
    const f = apiFetch();
    assetListPromise = (f ? getJson('/api/share-asset', { list: '1' }, f) : Promise.reject(new Error('fetch unavailable')))
      .then((res) => {
        assetList = new Set(Array.isArray(res && res.files) ? res.files : []);
        return assetList;
      })
      .catch(() => {
        assetList = new Set();
        modalState.assetError = true;
        return assetList;
      });
  }
  return assetListPromise;
}

function loadAsset(path) {
  if (!path) return Promise.resolve(null);
  if (assetCache.has(path)) return Promise.resolve(assetCache.get(path));
  if (assetPending.has(path)) return assetPending.get(path);
  const f = apiFetch();
  const p = loadAssetList()
    .then((list) => {
      if (!list.has(path) || !f) return null;
      return getJson('/api/share-asset', { path }, f).then((res) => (res && res.data ? `data:${res.mime};base64,${res.data}` : null));
    })
    .catch(() => null)
    .then((uri) => {
      assetCache.set(path, uri);
      assetPending.delete(path);
      return uri;
    });
  assetPending.set(path, p);
  return p;
}

const assetUri = (path) => (path && assetCache.get(path)) || null;

/** Art paths needed for the pixel role card. */
function neededArt() {
  if (modalState.style !== 'pixel-role') return [];
  const prof = currentProfile();
  return [charStillPath(prof.classId, prof.stage), charIdlePath(prof.classId, prof.stage), arenaPath(CLASS_ARENA[prof.classId])];
}

function ensureArt() {
  const paths = neededArt().filter((p) => !assetCache.has(p));
  if (!paths.length) return;
  Promise.all(paths.map(loadAsset)).then(() => {
    if (modalState.open && modalState.style === 'pixel-role') renderPreview();
  });
}

const charArt = (classId, stage, live) => (live && assetUri(charIdlePath(classId, stage))) || assetUri(charStillPath(classId, stage));

// --- card for the current style ---------------------------------------------------------

function currentPosterPayload({ webglCutout = false } = {}) {
  const d = hist();
  const quips = buildQuips(d, modalState.period);
  const entry = quips[modalState.quipIdx % quips.length];
  return {
    period: modalState.period,
    totals: d.totals,
    byModel: d.by_model,
    daily: d.daily,
    hourlyToday: d.hourly_today,
    d7ByPool: d.d7_by_pool,
    lang: modalState.lang,
    theme: modalState.theme === 'light' ? 'light' : 'dark',
    quip: quipText(entry, modalState.lang),
    now: new Date(),
    webglCutout,
  };
}

/** `live` = panel preview (animated idles / WebGL cutout); export uses standalone SVG unless hybrid WebGL is active. */
function currentSvg({ live = false, animPhase = 0, webglCutout = false } = {}) {
  const style = modalState.style;
  if (style === 'pixel-role') {
    const prof = currentProfile();
    return buildRoleCardSvg({
      profile: prof,
      achievements: currentAchievements(prof),
      art: { char: charArt(prof.classId, prof.stage, live), arena: assetUri(arenaPath(CLASS_ARENA[prof.classId])) },
      lang: modalState.lang,
      arena: CLASS_ARENA[prof.classId],
      theme: modalState.theme === 'light' ? 'light' : 'dark',
    });
  }
  return buildShareCardStyleSvg(style, currentPosterPayload({ webglCutout }), animPhase);
}

function setShareStatus(text, isErr = false) {
  const modal = document.getElementById('share-modal');
  if (!modal) return;
  const el = modal.querySelector('.share-status');
  if (el) {
    el.textContent = text || '';
    el.classList.toggle('err', Boolean(isErr));
    el.hidden = !text;
  }
  const fmtBadge = modal.querySelector('.share-fmt-pill');
  if (fmtBadge) fmtBadge.hidden = Boolean(text);
}

function setSettingsOpen(nextOpen, modal = document.getElementById('share-modal')) {
  modalState.settingsOpen = Boolean(nextOpen);
  if (!modal) return;
  const pop = modal.querySelector('.share-settings-popover');
  if (pop) pop.hidden = !modalState.settingsOpen;
  modal.querySelectorAll('[data-share-settings-toggle]').forEach((btn) => {
    btn.setAttribute('aria-expanded', modalState.settingsOpen ? 'true' : 'false');
  });
}

function isReducedMotion() {
  try {
    return Boolean(typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch {
    return false;
  }
}

function startAmbientLoop(
  canvas,
  arenaId,
  { seed = 1, reducedMotion = false, clipW = 184, maskRects = [{ x: 6, y: 6, w: 108, h: 36 }] } = {},
) {
  if (!canvas || typeof canvas.getContext !== 'function') return { stop() {} };
  canvas.width = VFX_W;
  canvas.height = VFX_H;
  const ctx2d = canvas.getContext('2d');
  if (!ctx2d) return { stop() {} };
  const frame = createVfxFrame(VFX_W, VFX_H);
  const imgData = ctx2d.createImageData(VFX_W, VFX_H);
  const ambient = createAmbientFx(arenaId, seed);

  const drawFrame = () => {
    clearVfxFrame(frame);
    ambient.draw(frame);
    compositeVfx(frame, imgData.data);
    ctx2d.clearRect(0, 0, VFX_W, VFX_H);
    ctx2d.putImageData(imgData, 0, 0, 0, 0, clipW, VFX_H);
    for (const r of maskRects) ctx2d.clearRect(r.x, r.y, r.w, r.h);
  };

  if (reducedMotion) {
    for (let i = 0; i < 20; i += 1) ambient.update(0.06);
    drawFrame();
    return {
      stop() { ctx2d.clearRect(0, 0, VFX_W, VFX_H); },
    };
  }

  let raf = 0;
  let stopped = false;
  let last = performance.now();
  const loop = (ts) => {
    if (stopped) return;
    const dt = (ts - last) / 1000;
    if (dt >= 0.032) {
      last = ts;
      ambient.update(Math.min(0.06, dt));
      drawFrame();
    }
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);
  return {
    stop() {
      stopped = true;
      cancelAnimationFrame(raf);
      ctx2d.clearRect(0, 0, VFX_W, VFX_H);
    },
  };
}

function stopAmbient() {
  if (modalState.ambient) modalState.ambient.stop();
  modalState.ambient = null;
}

function stopLiveRaf() {
  if (modalState.webglLoop) {
    modalState.webglLoop.stop();
    modalState.webglLoop = null;
  }
  if (modalState.liveRaf) cancelAnimationFrame(modalState.liveRaf);
  modalState.liveRaf = 0;
  modalState.liveLastTs = 0;
}

function stopClockRefresh() {
  if (modalState.clockTimer) clearInterval(modalState.clockTimer);
  modalState.clockTimer = null;
}

function makeMotionAbortError() {
  const err = new Error('Motion export aborted');
  err.name = 'AbortError';
  err.code = 'ABORTED';
  return err;
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) throw makeMotionAbortError();
}

function abortActiveMotion() {
  modalState.motionSeq = (modalState.motionSeq || 0) + 1;
  if (modalState.motionAbort) {
    try { modalState.motionAbort.abort(); } catch { /* ignore */ }
    modalState.motionAbort = null;
  }
  if (modalState.gifBusy || modalState.motionBusy) {
    setMotionBusy(false);
  }
}

function startClockRefreshIfNeeded() {
  stopClockRefresh();
  if (!modalState.open || modalState.style !== 'mountain') return;
  modalState.clockTimer = setInterval(() => {
    if (!modalState.open || modalState.style !== 'mountain') {
      stopClockRefresh();
      return;
    }
    renderPreview();
  }, 60000);
}

function startAmbientIfNeeded() {
  stopAmbient();
  if (!modalState.open || modalState.style !== 'pixel-role') return;
  const canvas = document.querySelector('#share-modal .share-layer:not(.is-leaving) .share-vfx-canvas');
  if (!canvas) return;
  const prof = currentProfile();
  const arena = CLASS_ARENA[prof.classId] || 'observatory';
  modalState.ambient = startAmbientLoop(canvas, arena, { seed: prof.level * 17 + 5, reducedMotion: isReducedMotion() });
}

function startLivePreviewIfNeeded() {
  stopLiveRaf();
  const style = modalState.style;
  if (!modalState.open || (typeof document !== 'undefined' && document.hidden)) return;
  if (modalState.gifBusy || modalState.motionBusy) return;
  if (style === 'pixel-role') return;

  const stage = document.querySelector('#share-modal .share-layer:not(.is-leaving) .share-stage');
  if (!stage) return;
  const bgCanvas = stage.querySelector('.share-webgl-bg');
  const fgCanvas = stage.querySelector('.share-webgl-fg');
  const payload = currentPosterPayload({ webglCutout: true });
  const loop = startPosterWebglLoop({
    bgCanvas,
    fgCanvas,
    style,
    payload,
    reducedMotion: isReducedMotion(),
  });
  if (loop) {
    modalState.webglLoop = loop;
    stage.classList.add('has-webgl');
    return;
  }

  // Pure-SVG fallback if WebGL is disabled in browser
  if (isReducedMotion() || style === 'mountain') return;
  const spec = styleSpec(style);
  const loopMs = Math.max(2400, (spec.frameCount || 24) * (spec.delayCs || 10) * 10);
  modalState.liveLastTs = performance.now();

  const tick = (ts) => {
    modalState.liveRaf = 0;
    if (!modalState.open || modalState.style !== style || isReducedMotion() || document.hidden || modalState.gifBusy || modalState.motionBusy) {
      return;
    }
    const elapsed = ts - modalState.liveLastTs;
    if (elapsed >= 72) {
      modalState.liveLastTs = ts;
      modalState.livePhase = (modalState.livePhase + elapsed / loopMs) % 1;
      const curStage = document.querySelector('#share-modal .share-layer:not(.is-leaving) .share-stage');
      if (curStage) {
        curStage.innerHTML = currentSvg({ live: true, animPhase: modalState.livePhase, webglCutout: false });
      }
    }
    modalState.liveRaf = requestAnimationFrame(tick);
  };
  modalState.liveRaf = requestAnimationFrame(tick);
}

function stageHtml(svg, useWebgl = false) {
  if (modalState.style === 'pixel-role') {
    return `<div class="share-stage">${svg}<canvas class="share-vfx-canvas" width="400" height="210" aria-hidden="true"></canvas></div>`;
  }
  if (useWebgl) {
    return `<div class="share-stage has-webgl"><canvas class="share-webgl-canvas share-webgl-bg" width="760" height="950" aria-hidden="true"></canvas>${svg}<canvas class="share-webgl-canvas share-webgl-fg" width="760" height="950" aria-hidden="true"></canvas></div>`;
  }
  return `<div class="share-stage">${svg}</div>`;
}

function computeStageFit(modal) {
  const vp = modal && modal.querySelector('.share-viewport');
  const spec = styleSpec(modalState.style);
  let availW = 0;
  let availH = 0;
  if (vp) {
    const cs = typeof getComputedStyle === 'function' ? getComputedStyle(vp) : null;
    const padX = cs ? (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0) : 8;
    const padY = cs ? (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0) : 4;
    availW = Math.max(0, vp.clientWidth - padX);
    availH = Math.max(0, vp.clientHeight - padY);
  }
  if (availW <= 0 || availH <= 0) {
    const fallbackH = 340;
    const fallbackW = Math.min(600, Math.round((fallbackH * spec.width) / spec.height));
    return { width: fallbackW, height: Math.round((fallbackW * spec.height) / spec.width) };
  }
  const scale = Math.min(availW / spec.width, availH / spec.height);
  return {
    width: Math.max(120, Math.round(spec.width * scale)),
    height: Math.max(90, Math.round(spec.height * scale)),
  };
}

function fitStageFrame() {
  const modal = document.getElementById('share-modal');
  if (!modal || modal.hidden) return;
  const frame = modal.querySelector('.share-stage-frame');
  if (!frame) return;
  const { width, height } = computeStageFit(modal);
  frame.style.width = `${width}px`;
  frame.style.height = `${height}px`;
}

function renderPreview({ animate = false } = {}) {
  const modal = document.getElementById('share-modal');
  const frame = modal && modal.querySelector('.share-stage-frame');
  if (!frame) return;

  const { width: nextW, height: nextH } = computeStageFit(modal);
  const reduced = isReducedMotion();
  const existingLayer = frame.querySelector('.share-layer:not(.is-leaving)');
  const prevRect = animate && !reduced && existingLayer ? frame.getBoundingClientRect() : null;
  const useWebgl = modalState.style !== 'pixel-role' && isPosterWebglSupported();
  const html = stageHtml(currentSvg({ live: true, animPhase: 0, webglCutout: useWebgl }), useWebgl);

  clearTimeout(modalState.transitionTimer);
  modalState.transitionSeq += 1;
  const seq = modalState.transitionSeq;

  if (animate && !reduced && prevRect && prevRect.width > 0 && prevRect.height > 0 && existingLayer) {
    frame.querySelectorAll('.share-layer.is-leaving').forEach((el) => el.remove());
    existingLayer.classList.add('is-leaving');
    existingLayer.classList.remove('is-entering');

    const nextLayer = document.createElement('div');
    nextLayer.className = 'share-layer is-entering';
    nextLayer.innerHTML = html;
    frame.insertBefore(nextLayer, frame.firstChild);

    frame.dataset.style = modalState.style;
    frame.style.transition = 'none';
    frame.style.transform = '';
    frame.style.width = `${nextW}px`;
    frame.style.height = `${nextH}px`;
    const nextRect = frame.getBoundingClientRect();

    if (nextRect.width > 0 && nextRect.height > 0) {
      const sx = prevRect.width / nextRect.width;
      const sy = prevRect.height / nextRect.height;
      frame.style.transform = `scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`;
      void frame.offsetWidth;
      requestAnimationFrame(() => {
        if (modalState.transitionSeq !== seq) return;
        frame.style.transition = '';
        frame.style.transform = 'scale(1, 1)';
        nextLayer.classList.remove('is-entering');
      });
    } else {
      frame.style.transition = '';
      nextLayer.classList.remove('is-entering');
    }

    modalState.transitionTimer = setTimeout(() => {
      if (modalState.transitionSeq !== seq) return;
      frame.querySelectorAll('.share-layer.is-leaving').forEach((el) => el.remove());
      frame.style.transform = '';
    }, 260);
  } else {
    frame.dataset.style = modalState.style;
    frame.style.transition = 'none';
    frame.style.transform = '';
    frame.style.width = `${nextW}px`;
    frame.style.height = `${nextH}px`;
    frame.innerHTML = `<div class="share-layer">${html}</div>`;
    void frame.offsetWidth;
    frame.style.transition = '';
  }

  startAmbientIfNeeded();
  startLivePreviewIfNeeded();
}

function syncDialogMeta(modal = document.getElementById('share-modal')) {
  if (!modal) return;
  const t = tr();
  const dlg = modal.querySelector('.share-dialog');
  if (dlg) {
    dlg.dataset.style = modalState.style;
    dlg.dataset.theme = modalState.theme;
  }
  const frame = modal.querySelector('.share-stage-frame');
  if (frame) frame.dataset.style = modalState.style;
  const titleEl = modal.querySelector('#share-modal-title');
  if (titleEl) titleEl.textContent = t('shareCardTitle');
  const styles = t('shareStyles') || {};
  const styleName = styles[modalState.style] || modalState.style;
  const themeName = t(modalState.theme === 'light' ? 'shareThemeLight' : 'shareThemeDark');
  const curPill = modal.querySelector('.share-cur-pill');
  if (curPill) {
    curPill.textContent = `${styleName} · ${themeName}`;
    curPill.title = t('shareSettingsTip');
  }
  const privEl = modal.querySelector('.share-privacy');
  if (privEl) privEl.textContent = t('sharePrivacyShort');
  const setBtn = modal.querySelector('[data-share-settings-toggle]');
  if (setBtn) {
    setBtn.setAttribute('aria-label', t('shareSettingsTip'));
    setBtn.title = t('shareSettingsTip');
    setBtn.setAttribute('aria-expanded', modalState.settingsOpen ? 'true' : 'false');
  }
  const setLbl = modal.querySelector('[data-share-settings-lbl]');
  if (setLbl) setLbl.textContent = t('shareSettings');
  const secStyle = modal.querySelector('[data-share-sec-style]');
  if (secStyle) secStyle.textContent = t('shareStyleLabel');
  const secAppear = modal.querySelector('[data-share-sec-appear]');
  if (secAppear) secAppear.textContent = t('shareAppearanceLabel');
  const secExport = modal.querySelector('[data-share-sec-export]');
  if (secExport) secExport.textContent = t('shareExportLabel');
  const pop = modal.querySelector('.share-settings-popover');
  if (pop) pop.hidden = !modalState.settingsOpen;
  const closeEl = modal.querySelector('[data-share-close]');
  if (closeEl) {
    closeEl.setAttribute('aria-label', t('shareClose'));
    closeEl.title = t('shareClose');
  }
}

function syncStyleRail(modal = document.getElementById('share-modal')) {
  if (!modal) return;
  const t = tr();
  const rail = modal.querySelector('.share-style-rail');
  if (!rail) return;
  const styles = t('shareStyles') || {};
  rail.setAttribute('aria-label', t('shareStyleLabel'));
  rail.querySelectorAll('[data-share-style]').forEach((btn) => {
    const id = btn.dataset.shareStyle;
    const active = id === modalState.style;
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    btn.tabIndex = active ? 0 : -1;
    const lbl = btn.querySelector('.share-style-lbl');
    if (lbl) lbl.textContent = styles[id] || id;
  });
}

function syncControls(modal = document.getElementById('share-modal')) {
  if (!modal) return;
  const wrap = modal.querySelector('.share-controls');
  if (!wrap) return;
  const t = tr();
  const spec = styleSpec(modalState.style);
  const pk = modalState.pk;
  const prof = spec.supportsRole ? currentProfile() : null;
  const showGender = Boolean(prof && prof.classId === 'novice');
  const sig = `${modalState.style}|${modalState.lang}|${spec.supportsTheme}|${spec.supportsQuip}|${spec.supportsRole}|${showGender}`;

  if (modalState.controlsSig === sig) {
    if (spec.supportsTheme) {
      wrap.querySelectorAll('[data-share-theme]').forEach((btn) => {
        btn.setAttribute('aria-pressed', btn.dataset.shareTheme === modalState.theme ? 'true' : 'false');
      });
    }
    if (showGender) {
      wrap.querySelectorAll('[data-share-gender]').forEach((btn) => {
        btn.setAttribute('aria-pressed', btn.dataset.shareGender === pk.gender ? 'true' : 'false');
      });
    }
    const nickInput = wrap.querySelector('[data-share-nick]');
    if (nickInput && document.activeElement !== nickInput && nickInput.value !== pk.nickname) {
      nickInput.value = pk.nickname;
    }
    return;
  }

  modalState.controlsSig = sig;
  const topRow = [];
  if (spec.supportsTheme) {
    topRow.push(`<div class="share-theme" role="group" aria-label="${esc(t('shareThemeLabel'))}">${['dark', 'light'].map((th) => `<button type="button" class="fchip" data-share-theme="${th}" aria-pressed="${modalState.theme === th}">${esc(t(th === 'dark' ? 'shareThemeDark' : 'shareThemeLight'))}</button>`).join('')}</div>`);
  }
  if (spec.supportsQuip) {
    topRow.push(`<button type="button" class="fchip" data-share-quip>${esc(t('shareQuipNext'))}</button>`);
  }
  const roleRow = [];
  if (spec.supportsRole) {
    roleRow.push(`<label class="share-field"><span>${esc(t('shareNickLabel'))}</span><input type="text" data-share-nick maxlength="16" value="${esc(pk.nickname)}" placeholder="${esc(t('shareNickPlaceholder'))}" spellcheck="false" autocomplete="off"></label>`);
    if (showGender) {
      roleRow.push(`<div class="share-theme" role="group" aria-label="${esc(t('shareGenderLabel'))}">${['male', 'female'].map((g) => `<button type="button" class="fchip" data-share-gender="${g}" aria-pressed="${pk.gender === g}">${esc(t(g === 'male' ? 'shareGenderMale' : 'shareGenderFemale'))}</button>`).join('')}</div>`);
    }
  }
  wrap.innerHTML = `${topRow.length ? `<div class="share-ctrl-row">${topRow.join('')}</div>` : ''}${roleRow.length ? `<div class="share-ctrl-row">${roleRow.join('')}</div>` : ''}`;
}

function syncMotionFmtOptions(modal = document.getElementById('share-modal')) {
  if (!modal) return;
  const sel = modal.querySelector('[data-share-motion-fmt]');
  if (!sel) return;
  const t = tr();
  const fmtNames = t('shareMotionFmt') || {};
  const allowed = availableMotionFormats(modalState.caps);
  const current = activeMotionFmt();
  modalState.motionFmt = current;
  sel.setAttribute('aria-label', t('shareMotionLabel'));
  sel.innerHTML = allowed.map((f) => `<option value="${f}">${esc(fmtNames[f] || f.toUpperCase())}</option>`).join('');
  sel.value = current;
}

function syncActions(modal = document.getElementById('share-modal')) {
  if (!modal) return;
  const t = tr();
  const busy = Boolean(modalState.gifBusy || modalState.motionBusy);
  const svgBtn = modal.querySelector('[data-share-svg]');
  const pngBtn = modal.querySelector('[data-share-png]');
  const fmtSel = modal.querySelector('[data-share-motion-fmt]');
  const fmtBadge = modal.querySelector('.share-fmt-pill');
  const statusEl = modal.querySelector('.share-status');
  const saveBtn = modal.querySelector('[data-share-motion-save]');
  const copyBtn = modal.querySelector('[data-share-motion-copy]');
  const curFmt = activeMotionFmt();
  const isGif = curFmt === 'gif';
  const fmtNames = t('shareMotionFmt') || {};
  if (svgBtn) svgBtn.textContent = t('copySvg');
  if (pngBtn) pngBtn.textContent = t('copyPng');
  if (fmtSel) fmtSel.disabled = busy;
  if (fmtBadge) {
    fmtBadge.textContent = fmtNames[curFmt] || curFmt.toUpperCase();
    fmtBadge.title = t('shareSettingsTip');
    fmtBadge.disabled = busy;
    fmtBadge.hidden = Boolean(statusEl && !statusEl.hidden);
  }
  if (saveBtn) {
    saveBtn.textContent = isGif ? t('saveGif') : t('saveMotion');
    saveBtn.disabled = busy;
  }
  if (copyBtn) {
    copyBtn.textContent = isGif ? t('copyGif') : t('copyMotion');
    copyBtn.disabled = busy;
  }
}

function syncModalChrome({ animate = false } = {}) {
  const modal = ensureShareModal();
  syncDialogMeta(modal);
  syncStyleRail(modal);
  syncControls(modal);
  syncMotionFmtOptions(modal);
  syncActions(modal);
  renderPreview({ animate });
  if (modalState.style === 'pixel-role') {
    stopClockRefresh();
    loadAssetList().then(() => {
      if (modalState.assetError) setShareStatus(tr()('shareAssetsFail'), true);
    });
    ensureArt();
  } else {
    startClockRefreshIfNeeded();
  }
}

function setMotionBusy(busy) {
  modalState.gifBusy = Boolean(busy);
  modalState.motionBusy = Boolean(busy);
  syncActions();
  if (busy) stopLiveRaf();
  else startLivePreviewIfNeeded();
}

function roleGifCacheKey(prof, ach) {
  const arenaId = CLASS_ARENA[prof.classId];
  const idle = charIdlePath(prof.classId, prof.stage);
  const still = charStillPath(prof.classId, prof.stage);
  const arena = arenaPath(arenaId);
  return JSON.stringify({
    period: modalState.period,
    lang: modalState.lang,
    theme: modalState.theme === 'light' ? 'light' : 'dark',
    reducedMotion: isReducedMotion(),
    nick: prof.nickname,
    gender: prof.gender,
    classId: prof.classId,
    stage: prof.stage,
    level: prof.level,
    rarity: prof.rarity,
    exp: prof.exp && prof.exp.progress,
    stats: prof.stats && prof.stats.values,
    norm: prof.stats && prof.stats.norm,
    ach,
    hasIdle: Boolean(assetUri(idle)),
    hasStill: Boolean(assetUri(still)),
    hasArena: Boolean(assetUri(arena)),
  });
}

async function buildCurrentRoleGif({ signal = null } = {}) {
  throwIfAborted(signal);
  await withExportArt();
  throwIfAborted(signal);
  const prof = currentProfile();
  const ach = currentAchievements(prof);
  const key = roleGifCacheKey(prof, ach);
  if (modalState.gifCache && modalState.gifCache.key === key) {
    throwIfAborted(signal);
    return { gif: modalState.gifCache.result, prof };
  }
  const arenaId = CLASS_ARENA[prof.classId];
  const layout = buildRoleCardLayout({
    profile: prof,
    achievements: ach,
    lang: modalState.lang,
    arena: arenaId,
    theme: modalState.theme === 'light' ? 'light' : 'dark',
  });
  const charUri = assetUri(charIdlePath(prof.classId, prof.stage)) || assetUri(charStillPath(prof.classId, prof.stage));
  const arenaUri = assetUri(arenaPath(arenaId));
  const result = await renderRoleCardGif({
    layout,
    profile: prof,
    art: { char: charUri, arena: arenaUri },
    scale: 2,
    reducedMotion: isReducedMotion(),
    signal,
  });
  throwIfAborted(signal);
  modalState.gifCache = { key, result };
  return { gif: result, prof };
}

function parseHexRgbFast(hex) {
  let s = String(hex || '#000000').replace('#', '');
  if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  const v = parseInt(s.slice(0, 6), 16) || 0;
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function pixToPackedRgba(pix) {
  const len = pix.w * pix.h;
  const packed = new Uint32Array(len);
  const cache = new Map();
  for (let i = 0; i < len; i += 1) {
    const col = pix.c[i];
    if (!col) continue;
    let v = cache.get(col);
    if (v === undefined) {
      const [r, g, b] = parseHexRgbFast(col);
      v = ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
      cache.set(col, v);
    }
    packed[i] = v;
  }
  return packed;
}

function blendPixelOver(dst, di, r, g, b, a) {
  if (a <= 0) return;
  if (a >= 255) {
    dst[di] = r; dst[di + 1] = g; dst[di + 2] = b; dst[di + 3] = 255;
    return;
  }
  const sa = a / 255;
  const inv = 1 - sa;
  dst[di] = Math.min(255, Math.round(r * sa + dst[di] * inv));
  dst[di + 1] = Math.min(255, Math.round(g * sa + dst[di + 1] * inv));
  dst[di + 2] = Math.min(255, Math.round(b * sa + dst[di + 2] * inv));
  dst[di + 3] = 255;
}

async function createRoleCardCanvasRenderer({ layout, profile, art = {}, fps = 16, signal = null } = {}) {
  throwIfAborted(signal);
  const [arenaRgba, spriteFrames] = await Promise.all([
    art.arena ? decodeImageRgba(art.arena, NATIVE_W, NATIVE_H).catch(() => null) : Promise.resolve(null),
    art.char ? decodeAnimatedWebpFrames(art.char, SPRITE_CELL.w, SPRITE_CELL.h, signal).catch((err) => {
      if (err && (err.name === 'AbortError' || err.code === 'ABORTED')) throw err;
      return [];
    }) : Promise.resolve([]),
  ]);
  throwIfAborted(signal);

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
      blendPixelOver(base, di, arenaRgba[di], arenaRgba[di + 1], arenaRgba[di + 2], arenaRgba[di + 3]);
    }
    if (isLight && (i % NATIVE_W) < 186) {
      blendPixelOver(base, di, 0xff, 0xf4, 0xcf, 41);
    }
  }

  const uiPacked = pixToPackedRgba(layout.ui);
  const shadowLayers = (layout.shadowSteps || []).map(({ pix, alpha }) => ({
    packed: pixToPackedRgba(pix),
    alphaByte: Math.round(alpha * 255),
  }));
  const fallbackPacked = pixToPackedRgba(placeholderSpritePix(layout.heroX));
  const box = spriteBox(layout.heroX, FLOOR_Y);
  const ox = Math.round(box.x);
  const oy = Math.round(box.y);

  const spriteTimeline = [];
  let totalSpriteCs = 0;
  for (const sp of spriteFrames) {
    const dur = Math.max(2, sp.delayCs || 17);
    totalSpriteCs += dur;
    spriteTimeline.push({ sp, endCs: totalSpriteCs });
  }

  const ambient = createAmbientFx(layout.arena, ((profile && profile.level) || 1) * 31 + 7);
  for (let i = 0; i < 20; i += 1) ambient.update(0.06);
  const vfxFrame = createVfxFrame(NATIVE_W, NATIVE_H);
  const vfxRgba = new Uint8ClampedArray(nPix * 4);

  const scratch = document.createElement('canvas');
  scratch.width = NATIVE_W;
  scratch.height = NATIVE_H;
  const sctx = scratch.getContext('2d');
  if (!sctx) throw new Error('2D scratch canvas unavailable');
  const imgData = sctx.createImageData(NATIVE_W, NATIVE_H);
  const dt = 1 / Math.max(1, fps);

  return (targetCtx, _phase, frameIdx, outW, outH) => {
    if (frameIdx > 0) ambient.update(dt);
    const dst = imgData.data;
    dst.set(base);

    clearVfxFrame(vfxFrame);
    ambient.draw(vfxFrame);
    compositeVfx(vfxFrame, vfxRgba);
    for (let y = 0; y < NATIVE_H; y += 1) {
      for (let x = 0; x < 186; x += 1) {
        const idx = (y * NATIVE_W + x) * 4;
        const a = vfxRgba[idx + 3];
        if (a > 0) blendPixelOver(dst, idx, vfxRgba[idx], vfxRgba[idx + 1], vfxRgba[idx + 2], a);
      }
    }

    for (let s = 0; s < shadowLayers.length; s += 1) {
      const { packed, alphaByte } = shadowLayers[s];
      for (let i = 0; i < nPix; i += 1) {
        const c = packed[i];
        if (c) blendPixelOver(dst, i * 4, c & 255, (c >>> 8) & 255, (c >>> 16) & 255, alphaByte);
      }
    }

    let sp = null;
    if (spriteTimeline.length) {
      const tCs = (frameIdx * (100 / Math.max(1, fps))) % totalSpriteCs;
      sp = (spriteTimeline.find((item) => tCs < item.endCs) || spriteTimeline[0]).sp;
    }
    if (sp && sp.rgba) {
      const sw = sp.w || SPRITE_CELL.w;
      const sh = sp.h || SPRITE_CELL.h;
      for (let y = 0; y < sh; y += 1) {
        const dy = oy + y;
        if (dy < 0 || dy >= NATIVE_H) continue;
        for (let x = 0; x < sw; x += 1) {
          const dx = ox + x;
          if (dx < 0 || dx >= NATIVE_W) continue;
          const si = (y * sw + x) * 4;
          const a = sp.rgba[si + 3];
          if (a > 0) blendPixelOver(dst, (dy * NATIVE_W + dx) * 4, sp.rgba[si], sp.rgba[si + 1], sp.rgba[si + 2], a);
        }
      }
    } else {
      for (let i = 0; i < nPix; i += 1) {
        const c = fallbackPacked[i];
        if (!c) continue;
        const di = i * 4;
        dst[di] = c & 255; dst[di + 1] = (c >>> 8) & 255; dst[di + 2] = (c >>> 16) & 255; dst[di + 3] = 255;
      }
    }

    for (let i = 0; i < nPix; i += 1) {
      const c = uiPacked[i];
      if (!c) continue;
      const di = i * 4;
      dst[di] = c & 255; dst[di + 1] = (c >>> 8) & 255; dst[di + 2] = (c >>> 16) & 255; dst[di + 3] = 255;
    }

    sctx.putImageData(imgData, 0, 0);
    targetCtx.imageSmoothingEnabled = false;
    targetCtx.clearRect(0, 0, outW, outH);
    targetCtx.drawImage(scratch, 0, 0, outW, outH);
  };
}

function motionCacheKey(style, fmt) {
  const quips = buildQuips(hist(), modalState.period);
  const entry = quips[modalState.quipIdx % quips.length];
  if (style === 'pixel-role') {
    const prof = currentProfile();
    return JSON.stringify({
      style,
      fmt,
      role: roleGifCacheKey(prof, currentAchievements(prof)),
    });
  }
  return JSON.stringify({
    style,
    fmt,
    period: modalState.period,
    lang: modalState.lang,
    theme: modalState.theme,
    quip: quipText(entry, modalState.lang),
    totals: hist().totals && hist().totals[modalState.period],
  });
}

async function buildCurrentMotion(fmt, { onProgress, signal } = {}) {
  throwIfAborted(signal);
  const style = modalState.style;
  const spec = styleSpec(style);
  const key = motionCacheKey(style, fmt);
  if (modalState.motionCache && modalState.motionCache.key === key) {
    throwIfAborted(signal);
    return modalState.motionCache.result;
  }

  let result;
  if (fmt === 'gif') {
    if (style === 'pixel-role') {
      const { gif, prof } = await buildCurrentRoleGif({ signal });
      throwIfAborted(signal);
      result = {
        ...gif,
        ext: 'gif',
        kind: 'gif',
        stem: `agy-lens-${prof.classId || 'role'}`,
      };
    } else {
      const payload = currentPosterPayload({ webglCutout: false });
      const hybridCanvas = await createPosterHybridCanvasRenderer({
        style,
        payload,
        buildCutoutSvg: (opts) => buildShareCardStyleSvg(style, { ...payload, ...opts }, 0),
        width: spec.width,
        height: spec.height,
        signal,
      }).catch(() => null);
      throwIfAborted(signal);
      const gif = await rasterizeSvgFramesToGif({
        renderCanvasAtPhase: hybridCanvas,
        renderSvgAtPhase: (phase) => buildShareCardStyleSvg(style, payload, phase),
        width: spec.width,
        height: spec.height,
        frameCount: spec.frameCount || 24,
        delayCs: spec.delayCs || 10,
        gifScale: spec.gifScale || 0.75,
        dither: spec.dither || 'floyd',
        signal,
      });
      result = {
        ...gif,
        ext: 'gif',
        kind: 'gif',
        stem: `agy-lens-${style}`,
      };
    }
  } else if (style === 'pixel-role') {
    await withExportArt();
    throwIfAborted(signal);
    const prof = currentProfile();
    const ach = currentAchievements(prof);
    const arenaId = CLASS_ARENA[prof.classId];
    const layout = buildRoleCardLayout({
      profile: prof,
      achievements: ach,
      lang: modalState.lang,
      arena: arenaId,
      theme: modalState.theme === 'light' ? 'light' : 'dark',
    });
    const charUri = assetUri(charIdlePath(prof.classId, prof.stage)) || assetUri(charStillPath(prof.classId, prof.stage));
    const arenaUri = assetUri(arenaPath(arenaId));
    const renderCanvasAtPhase = await createRoleCardCanvasRenderer({
      layout,
      profile: prof,
      art: { char: charUri, arena: arenaUri },
      fps: 16,
      signal,
    });
    throwIfAborted(signal);
    const motion = await rasterizeSvgFramesToMotion({
      renderCanvasAtPhase,
      width: PIXEL_W,
      height: PIXEL_H,
      frameCount: 48,
      fps: 16,
      format: fmt,
      coverFrameIndex: 0,
      onProgress,
      signal,
    });
    result = {
      ...motion,
      stem: `agy-lens-${prof.classId || 'role'}`,
    };
  } else {
    const payload = currentPosterPayload({ webglCutout: false });
    const hybridCanvas = await createPosterHybridCanvasRenderer({
      style,
      payload,
      buildCutoutSvg: (opts) => buildShareCardStyleSvg(style, { ...payload, ...opts }, 0),
      width: spec.width,
      height: spec.height,
      signal,
    }).catch(() => null);
    throwIfAborted(signal);
    const motion = await rasterizeSvgFramesToMotion({
      renderCanvasAtPhase: hybridCanvas,
      renderSvgAtPhase: (phase) => buildShareCardStyleSvg(style, payload, phase),
      width: spec.width,
      height: spec.height,
      frameCount: 60,
      fps: 20,
      format: fmt,
      coverFrameIndex: 0,
      onProgress,
      signal,
    });
    result = {
      ...motion,
      stem: `agy-lens-${style}`,
    };
  }

  throwIfAborted(signal);
  modalState.motionCache = { key, result };
  return result;
}

function downloadBlob(blob, filename) {
  if (!blob) return;
  const url = URL.createObjectURL(blob);
  try {
    triggerDownload(url, filename);
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

function saveProfileSoon() {
  clearTimeout(modalState.pk.saveTimer);
  modalState.pk.saveTimer = setTimeout(() => {
    const f = apiFetch();
    if (!f) return;
    postJson('/api/share-profile', { nickname: modalState.pk.nickname, gender: modalState.pk.gender }, f).catch(() => {});
  }, 500);
}

function loadShareProfileState() {
  const f = apiFetch();
  if (!f) return;
  getJson('/api/share-profile', {}, f)
    .then((res) => {
      if (!res || res.error) return;
      const pk = modalState.pk;
      if (!pk.touched) {
        pk.nickname = res.nickname || '';
        pk.gender = res.gender === 'female' ? 'female' : 'male';
      }
      if (modalState.open) {
        syncControls();
        if (modalState.style === 'pixel-role') renderPreview();
      }
    })
    .catch(() => {});
}

function switchStyle(next, { focusButton = false } = {}) {
  if (!SHARE_STYLES.includes(next) || next === modalState.style) return;
  abortActiveMotion();
  modalState.style = next;
  modalState.styleChosen = true;
  modalState.livePhase = 0;
  modalState.motionCache = null;
  modalState.motionFmt = activeMotionFmt();
  setShareStatus('');
  syncModalChrome({ animate: true });
  const btn = document.querySelector(`#share-modal [data-share-style="${next}"]`);
  if (btn) {
    if (typeof btn.scrollIntoView === 'function') {
      btn.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    if (focusButton) btn.focus();
  }
}

function onShareModalClick(e) {
  const modal = e.currentTarget;
  if (e.target === modal || e.target.closest('[data-share-close]')) {
    closeShareCardModal();
    return;
  }
  if (e.target.closest('[data-share-settings-toggle], [data-share-settings-trigger]')) {
    setSettingsOpen(!modalState.settingsOpen, modal);
    return;
  }
  if (modalState.settingsOpen && !e.target.closest('.share-settings-popover')) {
    setSettingsOpen(false, modal);
    if (e.target.closest('.share-viewport')) return;
  }
  const t = tr();
  const styleBtn = e.target.closest('[data-share-style]');
  if (styleBtn) {
    switchStyle(styleBtn.dataset.shareStyle);
    return;
  }
  const themeBtn = e.target.closest('[data-share-theme]');
  if (themeBtn) {
    const nextTheme = themeBtn.dataset.shareTheme === 'light' ? 'light' : 'dark';
    if (nextTheme !== modalState.theme) {
      abortActiveMotion();
      modalState.theme = nextTheme;
      modalState.themeChosen = true;
      modalState.gifCache = null;
      modalState.motionCache = null;
      setShareStatus('');
      syncDialogMeta(modal);
      syncControls(modal);
      renderPreview({ animate: true });
    }
    return;
  }
  if (e.target.closest('[data-share-quip]')) {
    modalState.quipIdx += 1;
    modalState.motionCache = null;
    renderPreview();
    return;
  }
  const genderBtn = e.target.closest('[data-share-gender]');
  if (genderBtn) {
    modalState.pk.gender = genderBtn.dataset.shareGender === 'female' ? 'female' : 'male';
    modalState.pk.touched = true;
    modalState.gifCache = null;
    modalState.motionCache = null;
    saveProfileSoon();
    syncControls(modal);
    renderPreview();
    return;
  }
  if (e.target.closest('[data-share-svg]')) {
    setSettingsOpen(false, modal);
    withExportArt().then(() => copyShareCardSvg(currentSvg()))
      .then(() => setShareStatus(t('shareCopied', 'SVG')))
      .catch(() => setShareStatus(t('shareCopyFail'), true));
    return;
  }
  if (e.target.closest('[data-share-png]')) {
    const ready = neededArt().every((p) => assetCache.has(p));
    const run = () => copyShareCardPng(currentSvg())
      .then(() => setShareStatus(t('shareCopied', 'PNG')))
      .catch((err) => {
        const isClip = err && (err.code === 'CLIPBOARD_UNAVAILABLE' || err.code === 'CLIPBOARD_DENIED');
        setShareStatus(t(isClip ? 'shareCopyPngFail' : 'sharePngFail'), true);
      });
    if (ready) run();
    else withExportArt().then(run);
    return;
  }
  const wantMotionSave = Boolean(e.target.closest('[data-share-motion-save], [data-share-gif-save]'));
  const wantMotionCopy = Boolean(e.target.closest('[data-share-motion-copy], [data-share-gif]'));
  if (wantMotionSave || wantMotionCopy) {
    if (modalState.motionBusy || modalState.gifBusy) return;
    const fmt = activeMotionFmt();
    const fmtLabel = (t('shareMotionFmt') && t('shareMotionFmt')[fmt]) || fmt.toUpperCase();
    abortActiveMotion();
    const seq = modalState.motionSeq;
    const ac = typeof AbortController === 'function' ? new AbortController() : null;
    modalState.motionAbort = ac;
    const isCurrentExport = () => (
      modalState.open
      && modalState.motionSeq === seq
      && modalState.motionAbort === ac
      && (!ac || !ac.signal.aborted)
    );
    setMotionBusy(true);
    setShareStatus(fmt === 'gif' ? t('shareGifEncoding') : t('shareMotionEncoding', 0));
    buildCurrentMotion(fmt, {
      signal: ac ? ac.signal : null,
      onProgress: (pct) => {
        if (!isCurrentExport()) return;
        setShareStatus(fmt === 'gif' ? t('shareGifEncoding') : t('shareMotionEncoding', pct));
      },
    })
      .then(async (res) => {
        if (!isCurrentExport()) return;
        const fname = `${res.stem || 'agy-lens-share'}.${res.ext}`;
        if (wantMotionSave) {
          downloadBlob(res.blob, fname);
          setShareStatus(fmt === 'gif' ? t('shareGifSaved') : t('shareMotionSaved', fmtLabel));
          return;
        }
        const f = apiFetch();
        if (f) {
          try {
            const apiRes = await postJson('/api/share-copy-file', {
              data: res.base64,
              filename: res.stem || 'agy-lens-share',
              kind: res.kind,
            }, f);
            if (!isCurrentExport()) return;
            if (apiRes && apiRes.ok) {
              setShareStatus(fmt === 'gif' ? t('shareGifCopied') : t('shareMotionCopied', fmtLabel));
              return;
            }
          } catch {
            if (!isCurrentExport()) return;
            if (res.kind === 'gif') {
              try {
                const gifRes = await postJson('/api/share-copy-gif', { data: res.base64, filename: res.stem || 'agy-lens-role' }, f);
                if (!isCurrentExport()) return;
                if (gifRes && gifRes.ok) {
                  setShareStatus(t('shareGifCopied'));
                  return;
                }
              } catch { /* fall back to download below */ }
            }
          }
        }
        if (!isCurrentExport()) return;
        downloadBlob(res.blob, fname);
        setShareStatus(fmt === 'gif' ? t('shareGifFallbackSaved') : t('shareMotionFallbackSaved', fmtLabel));
      })
      .catch((err) => {
        if (!modalState.open || modalState.motionSeq !== seq || modalState.motionAbort !== ac) return;
        if (err && (err.name === 'AbortError' || err.code === 'ABORTED')) {
          setShareStatus(t('shareMotionCancelled'));
          return;
        }
        if (err && err.code === 'GIF_TOO_LARGE') {
          setShareStatus(t('shareGifTooLarge'), true);
          return;
        }
        if (err && err.code === 'MOTION_TOO_LARGE') {
          setShareStatus(t('shareMotionTooLarge'), true);
          return;
        }
        if (err && err.code === 'MOTION_UNSUPPORTED') {
          setShareStatus(t('shareMotionUnsupported'), true);
          return;
        }
        setShareStatus(fmt === 'gif' ? t('shareGifFail') : t('shareMotionFail'), true);
      })
      .finally(() => {
        if (modalState.motionSeq === seq && modalState.motionAbort === ac) {
          modalState.motionAbort = null;
          setMotionBusy(false);
        }
      });
  }
}

function withExportArt() {
  return Promise.all(neededArt().map(loadAsset));
}

function onShareModalInput(e) {
  const nick = e.target.closest('[data-share-nick]');
  if (nick) {
    modalState.pk.nickname = sanitizeNickname(nick.value);
    modalState.pk.touched = true;
    modalState.gifCache = null;
    modalState.motionCache = null;
    saveProfileSoon();
    renderPreview();
  }
}

function onShareModalChange(e) {
  const fmtSel = e.target.closest('[data-share-motion-fmt]');
  if (fmtSel) {
    const allowed = availableMotionFormats(modalState.caps);
    const nextFmt = allowed.includes(fmtSel.value) ? fmtSel.value : allowed[0];
    modalState.motionFmt = nextFmt;
    modalState.motionFmtByStyle[modalState.style] = nextFmt;
    modalState.motionCache = null;
    syncActions();
  }
}

function onShareRailKeydown(e) {
  const btn = e.target.closest('[data-share-style]');
  if (!btn) return;
  const idx = SHARE_STYLES.indexOf(btn.dataset.shareStyle);
  if (idx === -1) return;
  let nextIdx = -1;
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') nextIdx = (idx + 1) % SHARE_STYLES.length;
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') nextIdx = (idx - 1 + SHARE_STYLES.length) % SHARE_STYLES.length;
  else if (e.key === 'Home') nextIdx = 0;
  else if (e.key === 'End') nextIdx = SHARE_STYLES.length - 1;
  if (nextIdx >= 0) {
    e.preventDefault();
    switchStyle(SHARE_STYLES[nextIdx], { focusButton: true });
  }
}

function onShareKeydown(e) {
  if (e.key === 'Escape' && modalState.open) {
    e.preventDefault();
    if (modalState.settingsOpen) {
      setSettingsOpen(false);
      const toggleBtn = document.querySelector('#share-modal [data-share-settings-toggle]');
      if (toggleBtn) toggleBtn.focus();
      return;
    }
    closeShareCardModal();
  }
}

function onShareVisibilityChange() {
  if (!modalState.open) return;
  if (document.hidden) stopLiveRaf();
  else startLivePreviewIfNeeded();
}

function onShareResize() {
  if (!modalState.open) return;
  fitStageFrame();
}

function ensureShareModal() {
  let modal = document.getElementById('share-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'share-modal';
    modal.className = 'share-modal';
    modal.hidden = true;
    modal.innerHTML = `<div class="share-dialog" tabindex="-1" data-style="${esc(modalState.style)}" data-theme="${esc(modalState.theme)}" role="dialog" aria-modal="true" aria-labelledby="share-modal-title">
      <div class="share-head">
        <div class="share-head-copy">
          <div id="share-modal-title" class="share-title"></div>
          <div class="share-subline">
            <button type="button" class="share-cur-pill" data-share-settings-trigger></button>
            <span class="share-sub-dot" aria-hidden="true">·</span>
            <span class="share-privacy"></span>
          </div>
        </div>
        <div class="share-head-actions">
          <button type="button" class="share-settings-btn" data-share-settings-toggle aria-expanded="false" aria-haspopup="dialog">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11"/><circle cx="5.5" cy="4.5" r="1.5" fill="#111317"/><circle cx="10.5" cy="8" r="1.5" fill="#111317"/><circle cx="6.5" cy="11.5" r="1.5" fill="#111317"/></svg>
            <span data-share-settings-lbl></span>
          </button>
          <button type="button" class="share-close" data-share-close aria-label="Close" title="Close"><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button>
        </div>
      </div>
      <div class="share-settings-popover" hidden>
        <div class="share-pop-sec">
          <div class="share-pop-lbl" data-share-sec-style></div>
          <div class="share-style-rail" role="group" aria-label="Card style">
            ${SHARE_STYLES.map((s) => `<button type="button" class="fchip share-style-card" data-share-style="${s}" aria-pressed="${modalState.style === s}" tabindex="${modalState.style === s ? 0 : -1}"><span class="share-style-ico">${STYLE_ICONS[s] || ''}</span><span class="share-style-lbl"></span></button>`).join('')}
          </div>
        </div>
        <div class="share-pop-sec">
          <div class="share-pop-lbl" data-share-sec-appear></div>
          <div class="share-controls"></div>
        </div>
        <div class="share-pop-sec">
          <div class="share-pop-lbl" data-share-sec-export></div>
          <div class="share-export-opts">
            <select class="share-motion-fmt" data-share-motion-fmt></select>
            <button type="button" class="share-ghost-btn" data-share-svg></button>
          </div>
        </div>
      </div>
      <div class="share-preview share-viewport">
        <div class="share-stage-frame" data-style="${esc(modalState.style)}">
          <div class="share-layer"></div>
        </div>
      </div>
      <div class="share-foot">
        <div class="share-foot-meta">
          <button type="button" class="share-fmt-pill" data-share-settings-trigger></button>
          <span class="share-status" hidden></span>
        </div>
        <div class="share-actions">
          <button type="button" data-share-png></button>
          <button type="button" data-share-motion-save></button>
          <button type="button" class="share-primary" data-share-motion-copy></button>
        </div>
      </div>
    </div>`;
    modal.addEventListener('click', onShareModalClick);
    modal.addEventListener('input', onShareModalInput);
    modal.addEventListener('change', onShareModalChange);
    const rail = modal.querySelector('.share-style-rail');
    if (rail) rail.addEventListener('keydown', onShareRailKeydown);
    document.addEventListener('keydown', onShareKeydown);
    document.addEventListener('visibilitychange', onShareVisibilityChange);
    if (typeof window !== 'undefined') window.addEventListener('resize', onShareResize);
    if (typeof ResizeObserver === 'function') {
      const vp = modal.querySelector('.share-viewport');
      if (vp) {
        const ro = new ResizeObserver(() => {
          if (modalState.open) fitStageFrame();
        });
        ro.observe(vp);
      }
    }
    document.body.appendChild(modal);
  }
  return modal;
}

export function openShareCardModal({ data, period = 'd30', lang = 'en', t } = {}) {
  const prevPk = modalState.pk;
  const prevCaps = modalState.caps;
  const prevFmtByStyle = modalState.motionFmtByStyle || Object.create(null);
  const nextStyle = modalState.style && SHARE_STYLES.includes(modalState.style) && modalState.styleChosen
    ? modalState.style
    : 'mountain';
  const nextTheme = modalState.themeChosen ? modalState.theme : detectPreferredTheme();

  abortActiveMotion();
  stopAmbient();
  stopLiveRaf();
  stopClockRefresh();

  modalState = {
    open: true,
    settingsOpen: false,
    style: nextStyle,
    styleChosen: modalState.styleChosen,
    theme: nextTheme,
    themeChosen: modalState.themeChosen,
    motionFmt: prevFmtByStyle[nextStyle] || defaultMotionFmtForStyle(nextStyle, prevCaps),
    motionFmtByStyle: prevFmtByStyle,
    data: data || {},
    period: VALID_PERIODS.has(period) ? period : 'd30',
    lang: normalizeLang(lang),
    t: t || createTranslator(lang),
    quipIdx: 0,
    assetError: false,
    ambient: null,
    webglLoop: null,
    liveRaf: 0,
    liveLastTs: 0,
    livePhase: 0,
    transitionTimer: 0,
    transitionSeq: modalState.transitionSeq || 0,
    controlsSig: '',
    clockTimer: null,
    gifBusy: false,
    gifCache: null,
    motionBusy: false,
    motionAbort: null,
    motionSeq: (modalState.motionSeq || 0) + 1,
    motionCache: null,
    caps: prevCaps,
    pk: {
      nickname: prevPk ? prevPk.nickname : '',
      gender: prevPk ? prevPk.gender : 'male',
      touched: prevPk ? prevPk.touched : false,
      saveTimer: 0,
    },
  };
  const modal = ensureShareModal();
  setShareStatus('');
  modal.hidden = false;
  syncModalChrome({ animate: false });
  requestAnimationFrame(() => fitStageFrame());
  loadShareProfileState();
  if (!modalState.caps) {
    detectMotionCapabilities().then((caps) => {
      modalState.caps = caps;
      if (modalState.open) {
        syncMotionFmtOptions(modal);
        syncActions(modal);
      }
    }).catch(() => {});
  }
  const dlgEl = modal.querySelector('.share-dialog');
  if (dlgEl) dlgEl.focus({ preventScroll: true });
}

export function refreshShareCardModal({ data, period, lang, t } = {}) {
  if (!modalState.open) return;
  const langChanged = lang && normalizeLang(lang) !== modalState.lang;
  if (data !== undefined) {
    modalState.data = data;
    modalState.gifCache = null;
    modalState.motionCache = null;
  }
  if (period && VALID_PERIODS.has(period)) {
    modalState.period = period;
    modalState.gifCache = null;
    modalState.motionCache = null;
  }
  if (lang) modalState.lang = normalizeLang(lang);
  if (t) modalState.t = t;
  // Keep inputs (and their focus) intact on background data refreshes.
  if (langChanged) {
    syncModalChrome({ animate: false });
  } else {
    syncControls();
    renderPreview({ animate: false });
    ensureArt();
  }
}

export function closeShareCardModal() {
  modalState.open = false;
  modalState.settingsOpen = false;
  abortActiveMotion();
  stopAmbient();
  stopLiveRaf();
  stopClockRefresh();
  clearTimeout(modalState.transitionTimer);
  const modal = document.getElementById('share-modal');
  if (modal) modal.hidden = true;
}
