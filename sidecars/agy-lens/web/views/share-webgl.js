// Real-time 60fps WebGL1 atmospheric shader engine & hybrid SVG compositor for share posters.
// Pure-Node uniform helpers live above "// --- browser-only helpers" with zero DOM/WebGL globals.

import { extractNormalizedActivityCurve, sanitizeShareCardInput } from './share-styles.js';

function hexToRgb01(hex) {
  let s = String(hex || '#000000').replace('#', '');
  if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  const n = parseInt(s.slice(0, 6), 16) || 0;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function lerp3(a, b, t) {
  const f = Math.max(0, Math.min(1, t));
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

const MTN_DARK_STOPS = [
  { h: 0.0, top: '#090d16', mid: '#121a28', hor: '#232431', rim: '#c9d4e8', warm: '#e3c796', star: 0.72 },
  { h: 5.75, top: '#131326', mid: '#2a1f36', hor: '#703d40', rim: '#ffc296', warm: '#f28788', star: 0.14 },
  { h: 9.0, top: '#0f1c2e', mid: '#1c324a', hor: '#4e525c', rim: '#fae6ba', warm: '#ebc08f', star: 0.0 },
  { h: 12.5, top: '#0d1a2c', mid: '#18334e', hor: '#3c5368', rim: '#eef6ff', warm: '#f7e2b8', star: 0.0 },
  { h: 17.5, top: '#131222', mid: '#311e33', hor: '#87422d', rim: '#ffc77d', warm: '#f47864', star: 0.0 },
  { h: 19.25, top: '#0c1021', mid: '#211c38', hor: '#593448', rim: '#f29f94', warm: '#c282b0', star: 0.36 },
  { h: 24.0, top: '#090d16', mid: '#121a28', hor: '#232431', rim: '#c9d4e8', warm: '#e3c796', star: 0.72 },
];

const MTN_LIGHT_STOPS = [
  { h: 0.0, top: '#d4dce6', mid: '#e3e8ee', hor: '#eee9df', rim: '#f9f7f0', warm: '#ddd0b4', star: 0.24 },
  { h: 5.75, top: '#eddcd6', mid: '#f7e5d6', hor: '#fce0c4', rim: '#fff2d6', warm: '#f5a988', star: 0.0 },
  { h: 9.0, top: '#dce5eb', mid: '#edf0ea', hor: '#f8f0dc', rim: '#fffae8', warm: '#f5d29c', star: 0.0 },
  { h: 12.5, top: '#d2e1ed', mid: '#e7eef2', hor: '#f7f3e6', rim: '#ffffff', warm: '#f7e8c4', star: 0.0 },
  { h: 17.5, top: '#e8d3c3', mid: '#f5d7bf', hor: '#f7c196', rim: '#ffe5a8', warm: '#f28c6c', star: 0.0 },
  { h: 19.25, top: '#d6d2e3', mid: '#e8dae2', hor: '#f2d3c4', rim: '#ffdcc2', warm: '#de95a3', star: 0.12 },
  { h: 24.0, top: '#d4dce6', mid: '#e3e8ee', hor: '#eee9df', rim: '#f9f7f0', warm: '#ddd0b4', star: 0.24 },
];

function sampleMountainSky(hour, isDark) {
  const h = ((hour % 24) + 24) % 24;
  const stops = isDark ? MTN_DARK_STOPS : MTN_LIGHT_STOPS;
  let a = stops[0];
  let b = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i += 1) {
    if (h >= stops[i].h && h <= stops[i + 1].h) {
      a = stops[i];
      b = stops[i + 1];
      break;
    }
  }
  const rawT = Math.max(0, Math.min(1, (h - a.h) / Math.max(0.001, b.h - a.h)));
  const t = rawT * rawT * (3 - 2 * rawT);
  const isNight = h < 5.25 || h > 19.25;
  let sunX;
  let sunY;
  if (!isNight) {
    const dayT = (h - 5.25) / 14.0;
    const arc = Math.sin(dayT * Math.PI);
    const u = Math.max(0, Math.min(1, (arc - 0.38) / 0.19));
    const lift = u * u * (3 - 2 * u);
    sunX = (66 + dayT * 566) / 760;
    sunY = (286 - lift * 180 - arc * 14) / 950;
  } else {
    const nightElapsed = h >= 19.25 ? (h - 19.25) : (h + 4.75);
    const nightT = Math.max(0, Math.min(1, nightElapsed / 10.0));
    const arc = Math.sin(nightT * Math.PI);
    const u = Math.max(0, Math.min(1, (arc - 0.18) / 0.34));
    const lift = u * u * (3 - 2 * u);
    sunX = (148 + nightT * 464) / 760;
    sunY = (292 - lift * 182 - arc * 14) / 950;
  }
  return {
    colA: lerp3(hexToRgb01(a.top), hexToRgb01(b.top), t),
    colB: lerp3(hexToRgb01(a.mid), hexToRgb01(b.mid), t),
    colC: lerp3(hexToRgb01(a.hor), hexToRgb01(b.hor), t),
    accentA: lerp3(hexToRgb01(a.rim), hexToRgb01(b.rim), t),
    accentB: lerp3(hexToRgb01(a.warm), hexToRgb01(b.warm), t),
    sun: [sunX, sunY, isNight ? 1 : 0, a.star + (b.star - a.star) * t],
  };
}

export const POSTER_STYLE_INDEX = {
  mountain: 0,
  abyssal: 1,
  eclipse: 2,
  bauhaus: 3,
  phosphor: 4,
};

/** Pure-Node uniform descriptor for all 5 WebGL poster styles. */
export function computePosterShaderUniforms(style, input = {}) {
  const d = sanitizeShareCardInput(input);
  const isDark = d.theme !== 'light';
  const styleIdx = POSTER_STYLE_INDEX[style] ?? 0;
  const { curve } = extractNormalizedActivityCurve(d, 24);

  if (styleIdx === 0) {
    const m = sampleMountainSky(d.hour, isDark);
    return {
      styleIdx,
      isDark: isDark ? 1 : 0,
      colA: m.colA,
      colB: m.colB,
      colC: m.colC,
      accentA: m.accentA,
      accentB: m.accentB,
      sun: m.sun,
      curve,
    };
  }
  if (styleIdx === 1) {
    return {
      styleIdx,
      isDark: isDark ? 1 : 0,
      colA: hexToRgb01(isDark ? '#128a9e' : '#c6edf3'),
      colB: hexToRgb01(isDark ? '#06384c' : '#5aa8be'),
      colC: hexToRgb01(isDark ? '#020810' : '#081b28'),
      accentA: hexToRgb01(isDark ? '#7efaf5' : '#ffffff'),
      accentB: hexToRgb01('#f5df9c'),
      sun: [0.5, -0.04, 0, isDark ? 1 : 0.7],
      curve,
    };
  }
  if (styleIdx === 2) {
    return {
      styleIdx,
      isDark: isDark ? 1 : 0,
      colA: hexToRgb01(isDark ? '#04060d' : '#c4d8e8'),
      colB: hexToRgb01(isDark ? '#090d19' : '#e2ebf0'),
      colC: hexToRgb01(isDark ? '#181310' : '#f5ebd6'),
      accentA: hexToRgb01(isDark ? '#fff7e0' : '#ffffff'),
      accentB: hexToRgb01(isDark ? '#eab663' : '#f2c874'),
      sun: [374 / 760, 252 / 950, 92 / 950, isDark ? 0.85 : 0.0],
      curve,
    };
  }
  if (styleIdx === 3) {
    const ioTotal = Math.max(1, d.totals.input + d.totals.output);
    const outShare = Math.max(0.18, Math.min(0.68, d.totals.output / ioTotal));
    const reuseNorm = d.totals.reuseRatio !== null ? Math.min(1, Math.log10(1 + d.totals.reuseRatio) / 1.4) : 0.45;
    const arcStroke = 98 + reuseNorm * 26;
    const ochreHalfW = 32 + outShare * 36;
    return {
      styleIdx,
      isDark: isDark ? 1 : 0,
      colA: hexToRgb01(isDark ? '#0c0e13' : '#f2ede2'),
      colB: hexToRgb01(isDark ? '#cf3418' : '#e03c1f'),
      colC: hexToRgb01(isDark ? '#1c40b2' : '#2148c4'),
      accentA: hexToRgb01(isDark ? '#c98418' : '#e09b24'),
      accentB: hexToRgb01(isDark ? '#f8f3e8' : '#121316'),
      sun: [arcStroke, ochreHalfW, 0, 0],
      curve,
    };
  }
  return {
    styleIdx: 4,
    isDark: isDark ? 1 : 0,
    colA: hexToRgb01(isDark ? '#05080c' : '#edf3f7'),
    colB: hexToRgb01(isDark ? '#081016' : '#dce7f0'),
    colC: hexToRgb01(isDark ? '#030508' : '#cfdde8'),
    accentA: hexToRgb01(isDark ? '#ffc766' : '#cf6018'),
    accentB: hexToRgb01(isDark ? '#4ef2c8' : '#1652c4'),
    sun: [0.81, 0.20, 0, 0],
    curve,
  };
}

// --- browser-only helpers (never called during pure Node import/SVG tests) ---

const VERT_SRC = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

const FRAG_SRC = `
precision highp float;
varying vec2 v_uv;

uniform vec2 u_res;
uniform float u_phase;
uniform float u_style;
uniform float u_pass;
uniform float u_isDark;
uniform vec3 u_colA;
uniform vec3 u_colB;
uniform vec3 u_colC;
uniform vec3 u_accentA;
uniform vec3 u_accentB;
uniform vec4 u_sun;
uniform float u_curve[24];

const float TAU = 6.28318530718;

float hash21(vec2 p) {
  vec2 q = fract(p * vec2(127.1, 311.7));
  q += dot(q, q + 34.23);
  return fract(q.x * q.y);
}

float pnoise(vec2 p, vec2 per) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  vec2 i00 = mod(i, per);
  vec2 i10 = mod(i + vec2(1.0, 0.0), per);
  vec2 i01 = mod(i + vec2(0.0, 1.0), per);
  vec2 i11 = mod(i + vec2(1.0, 1.0), per);
  return mix(
    mix(hash21(i00), hash21(i10), u.x),
    mix(hash21(i01), hash21(i11), u.x),
    u.y
  );
}

float pfbm(vec2 p, vec2 per) {
  float v = 0.0;
  float a = 0.5;
  vec2 freq = vec2(1.0);
  for (int i = 0; i < 4; i++) {
    v += a * pnoise(p * freq, per * freq);
    freq *= 2.0;
    a *= 0.5;
  }
  return v;
}

float sampleCurve(float u) {
  float x = clamp(u, 0.0, 1.0) * 23.0;
  int idx = int(floor(x));
  float f = fract(x);
  float v0 = 0.2;
  float v1 = 0.2;
  for (int k = 0; k < 24; k++) {
    if (k == idx) v0 = u_curve[k];
    if (k == idx + 1 || (idx == 23 && k == 23)) v1 = u_curve[k];
  }
  return mix(v0, v1, f);
}

vec4 renderMountain(vec2 uv, float ang) {
  if (u_pass > 0.5) {
    // Foreground drifting valley mist across mountain chasms
    float bandA = exp(-pow((uv.y - 0.44 - 0.02 * sin(uv.x * 5.0 + ang)), 2.0) / 0.0045);
    float bandB = exp(-pow((uv.y - 0.55 + 0.018 * cos(uv.x * 4.0 - ang)), 2.0) / 0.0052);
    float mistN = pfbm(vec2(uv.x * 3.0 - u_phase * 3.0, uv.y * 6.0), vec2(3.0, 12.0));
    float mask = smoothstep(0.34, 0.42, uv.y) * smoothstep(0.66, 0.55, uv.y);
    float a = clamp((bandA * 0.62 + bandB * 0.48) * smoothstep(0.28, 0.82, mistN) * mask * (u_isDark > 0.5 ? 0.22 : 0.26), 0.0, 0.28);
    vec3 col = mix(u_accentB, u_accentA, 0.55);
    return vec4(col * a, a);
  }

  // Sky gradient + volumetric crepuscular rays + continuous FBM painted clouds
  vec3 sky = uv.y < 0.34
    ? mix(u_colA, u_colB, uv.y / 0.34)
    : mix(u_colB, u_colC, clamp((uv.y - 0.34) / 0.26, 0.0, 1.0));

  vec2 dSun = vec2((uv.x - u_sun.x) * (u_res.x / u_res.y), uv.y - u_sun.y);
  float dist = length(dSun);
  float rayAng = atan(dSun.y, dSun.x);
  float rays = 0.5 + 0.5 * sin(rayAng * 9.0 + sin(ang + rayAng * 3.0) * 0.8);
  float aura = exp(-dist * 3.4) * (0.34 + 0.16 * rays * exp(-dist * 1.8));
  sky += mix(u_accentB, u_accentA, 0.5) * aura * (u_isDark > 0.5 ? 0.52 : 0.42);

  if (u_sun.w > 0.04 && uv.y < 0.32) {
    vec2 sg = floor(uv * vec2(52.0, 64.0));
    vec2 sf = fract(uv * vec2(52.0, 64.0)) - 0.5;
    float sh = hash21(sg);
    if (sh > 0.945) {
      float tw = 0.55 + 0.45 * sin(ang + sh * 40.0);
      float starDot = smoothstep(0.18, 0.02, length(sf)) * tw * u_sun.w * (1.0 - uv.y * 2.8);
      sky += vec3(1.0, 0.98, 0.92) * max(0.0, starDot);
    }
  }

  // Two continuous east-drifting cloud decks
  float cMask = smoothstep(0.03, 0.11, uv.y) * smoothstep(0.39, 0.26, uv.y);
  if (cMask > 0.001) {
    float n1 = pfbm(vec2(uv.x * 3.0 - u_phase * 3.0, uv.y * 8.0 + 0.4), vec2(3.0, 16.0));
    float n2 = pfbm(vec2(uv.x * 5.0 - u_phase * 5.0 + 1.7, uv.y * 11.0), vec2(5.0, 22.0));
    float cloud = smoothstep(0.44, 0.78, n1 * 0.68 + n2 * 0.32) * cMask;
    float sunProx = exp(-dist * 2.6);
    vec3 cCol = mix(mix(u_colB, u_accentB, 0.38), u_accentA, clamp(0.35 + sunProx * 0.65 + (0.5 - uv.y) * 0.3, 0.0, 1.0));
    sky = mix(sky, cCol, cloud * (u_isDark > 0.5 ? 0.56 : 0.62));
  }
  return vec4(clamp(sky, 0.0, 1.0), 1.0);
}

vec4 renderAbyssal(vec2 uv, float ang) {
  if (u_pass > 0.5) {
    // Rising bioluminescent marine snow & gentle abyssal bokeh motes
    float aSum = 0.0;
    vec3 pCol = vec3(0.0);
    for (int layer = 0; layer < 2; layer++) {
      float fl = float(layer);
      vec2 gridScale = vec2(15.0 + fl * 9.0, 18.0 + fl * 10.0);
      vec2 p = vec2(uv.x * gridScale.x + sin(uv.y * 5.0 + ang + fl) * 0.28, (uv.y + u_phase * (1.0 + fl)) * gridScale.y);
      vec2 cell = mod(floor(p), gridScale);
      vec2 f = fract(p) - 0.5;
      float h = hash21(cell + fl * 37.0);
      if (h > 0.85) {
        vec2 jitter = vec2(fract(h * 13.7) - 0.5, fract(h * 29.3) - 0.5) * 0.46;
        float d = length(f - jitter);
        float glow = smoothstep(0.15, 0.015, d) * (0.55 + 0.45 * sin(ang + h * 25.0));
        vec3 c = h > 0.94 ? u_accentB : u_accentA;
        pCol += c * glow;
        aSum += glow * 0.36;
      }
    }
    float zone = smoothstep(0.16, 0.28, uv.y) * smoothstep(0.74, 0.56, uv.y);
    float a = clamp(aSum * zone, 0.0, 0.30);
    return vec4(clamp(pCol * zone, 0.0, 1.0) * a * 2.0, a);
  }

  // Deep pelagic water gradient
  vec3 water = uv.y < 0.40
    ? mix(u_colA, u_colB, uv.y / 0.40)
    : mix(u_colB, u_colC, clamp((uv.y - 0.40) / 0.54, 0.0, 1.0));

  // 1. Perspective foreshortened Snell's Window sea-surface swells at top (zero concentric target rings!)
  float ceilMask = smoothstep(0.22, 0.0, uv.y);
  float snellWin = exp(-pow((uv.x - 0.5) * 2.35, 2.0) - pow(uv.y * 7.2, 2.0));
  if (ceilMask > 0.002) {
    float perspZ = 1.0 / (uv.y * 5.5 + 0.22);
    vec2 seaUv = vec2((uv.x - 0.5) * perspZ * 1.35, perspZ * 0.65);
    float swellA = pfbm(vec2(seaUv.x * 1.5 + u_phase * 2.0, seaUv.y * 2.0 - u_phase * 1.0), vec2(6.0, 6.0));
    float swellB = pfbm(vec2(seaUv.x * 2.2 - u_phase * 2.0 + 1.3, seaUv.y * 2.6 + u_phase * 1.0), vec2(8.0, 8.0));
    // Dual-interference ocean caustic ridges (organic liquid facets)
    float ridge = 1.0 - abs(swellA - swellB) * 2.6;
    float causticFacet = pow(clamp(ridge, 0.0, 1.0), 3.2);
    float broadSwell = smoothstep(0.36, 0.78, swellA * 0.55 + swellB * 0.45);
    float horizFade = exp(-pow((uv.x - 0.5) * 2.1, 2.0));
    vec3 surfGlow = mix(u_colA, u_accentA, 0.78);
    water += surfGlow * (broadSwell * 0.36 + causticFacet * 0.62) * ceilMask * horizFade * (u_isDark > 0.5 ? 0.85 : 0.72);
  }
  water += u_accentA * snellWin * (u_isDark > 0.5 ? 0.46 : 0.62);

  // 2. Non-spinning volumetric curtain god-rays (standing/crossing wave interference — shafts breathe & shimmer in place!)
  vec2 rayOrigin = vec2(0.5, -0.22);
  vec2 delta = vec2((uv.x - rayOrigin.x) * (u_res.x / u_res.y), uv.y - rayOrigin.y);
  float theta = atan(delta.x, delta.y);
  float rayDist = length(delta);

  // Equal-and-opposite phase pairs prevent pinwheel rotation while creating fluid living shimmer
  float curtain1 = sin(theta * 11.0 + sin(ang) * 0.55) * cos(ang + theta * 2.5);
  float curtain2 = cos(theta * 19.0 - cos(ang) * 0.45) * sin(ang - theta * 3.2);
  float curtain3 = sin(theta * 29.0 + sin(ang * 2.0) * 0.35) * 0.35;
  float beamProfile = pow(clamp(0.52 + 0.26 * curtain1 + 0.24 * curtain2 + 0.14 * curtain3, 0.0, 1.0), 2.5);

  // Downward-streaming refractive caustic light modulation along the rays
  float stream = pfbm(vec2(theta * 12.0, rayDist * 4.0 - u_phase * 2.0), vec2(24.0, 4.0));
  float depthAtten = exp(-uv.y * 2.35) * smoothstep(0.78, 0.12, abs(theta)) * smoothstep(0.0, 0.06, uv.y + 0.02);
  vec3 beamCol = mix(u_colA, u_accentA, 0.70);
  water += beamCol * beamProfile * (0.45 + 0.75 * stream) * depthAtten * (u_isDark > 0.5 ? 0.88 : 0.64);

  return vec4(clamp(water, 0.0, 1.0), 1.0);
}

vec4 renderEclipse(vec2 uv, float ang) {
  vec2 center = u_sun.xy;
  float aspect = u_res.x / u_res.y;

  if (u_pass > 0.5) {
    // Orbiting golden stardust gliding along tilted -35deg astrolabe plane
    vec2 rel = vec2((uv.x - 0.508) * aspect, uv.y - 0.352);
    float cs = cos(0.610865);
    float sn = sin(0.610865);
    vec2 rot = vec2(rel.x * cs - rel.y * sn, rel.x * sn + rel.y * cs);
    if (rot.y > 0.0) {
      float ell = length(vec2(rot.x / 0.455, rot.y / 0.139));
      float band = exp(-pow(ell - 1.0, 2.0) / 0.0008);
      float theta = atan(rot.y / 0.139, rot.x / 0.455);
      float glint = pow(0.5 + 0.5 * cos(theta * 5.0 - ang * 2.0), 8.0);
      float a = clamp(band * glint * 0.36, 0.0, 0.34);
      return vec4(u_accentA * a, a);
    }
    return vec4(0.0);
  }

  vec3 bg = uv.y < 0.38
    ? mix(u_colA, u_colB, uv.y / 0.38)
    : mix(u_colB, u_colC, clamp((uv.y - 0.38) / 0.42, 0.0, 1.0));
  float horGlow = exp(-length(vec2((uv.x - 0.52) * 1.05, (uv.y - 0.68) * 2.2)) * 3.0);
  bg += u_accentB * horGlow * (u_isDark > 0.5 ? 0.32 : 0.26);

  if (u_sun.w > 0.1) {
    vec2 sg = floor(uv * vec2(58.0, 72.0));
    vec2 sf = fract(uv * vec2(58.0, 72.0)) - 0.5;
    float sh = hash21(sg + 9.1);
    if (sh > 0.952) {
      float tw = 0.5 + 0.5 * cos(ang + sh * 37.0);
      bg += vec3(1.0, 0.97, 0.90) * smoothstep(0.17, 0.02, length(sf)) * tw * 0.75;
    }
  }

  // Swirling Total Solar Eclipse Plasma Corona (Night) or Clear-Sky Daylight Parhelion & Solar Aureole (Day)
  vec2 d = vec2((uv.x - center.x) * aspect, uv.y - center.y);
  float dist = length(d);
  float rMoon = u_sun.z;
  if (u_isDark > 0.5) {
    if (dist > rMoon * 0.92) {
      float pa = atan(d.y, d.x) / TAU + 0.5;
      float radial = max(0.0, dist - rMoon);
      float plasma = pfbm(vec2(pa * 12.0 + sin(radial * 10.0 - ang) * 0.15, radial * 14.0 - u_phase * 2.0), vec2(12.0, 2.0));
      float tongues = exp(-radial * (12.8 - plasma * 4.8));
      float outerWarm = exp(-radial * 6.2) * 0.24;
      float innerRim = exp(-abs(dist - rMoon) * 105.0);
      vec3 corCol = mix(u_accentB, u_accentA, clamp(tongues * 1.15 + innerRim, 0.0, 1.0));
      float strength = clamp(tongues * (0.48 + 0.72 * plasma) + outerWarm + innerRim * 1.15, 0.0, 1.25);
      bg += corCol * strength;
    }
  } else {
    float pa = atan(d.y, d.x);
    // Soft high-altitude crepuscular rays + subtle 22-deg parhelion sundog shimmer
    float rays = 0.5 + 0.5 * (sin(pa * 8.0 + sin(ang) * 0.5) * 0.6 + cos(pa * 14.0 - cos(ang) * 0.5) * 0.4);
    float aureole = exp(-max(0.0, dist - rMoon * 0.85) * 5.6) * (0.68 + 0.24 * rays);
    float sundogRing = exp(-pow(dist - rMoon * 1.72, 2.0) / 0.00045) * (0.28 + 0.22 * pow(abs(cos(pa)), 4.0) * (0.7 + 0.3 * sin(ang)));
    vec3 warmHalo = mix(u_accentB, vec3(1.0, 0.99, 0.95), clamp(aureole, 0.0, 1.0));
    bg = mix(bg, warmHalo, clamp(aureole * 0.82 + sundogRing * 0.42, 0.0, 0.92));
    // Gentle sunlit cirrus wisps in upper sky
    float wispMask = smoothstep(0.02, 0.12, uv.y) * smoothstep(0.42, 0.24, uv.y);
    float wisp = pfbm(vec2(uv.x * 3.0 - u_phase * 3.0, uv.y * 7.0), vec2(3.0, 14.0));
    bg = mix(bg, vec3(0.99, 0.97, 0.93), smoothstep(0.48, 0.82, wisp) * wispMask * 0.34);
  }
  return vec4(clamp(bg, 0.0, 1.0), 1.0);
}

float cross2d(vec2 a, vec2 b) {
  return a.x * b.y - a.y * b.x;
}

float sdQuad4(vec2 p, vec2 v0, vec2 v1, vec2 v2, vec2 v3) {
  vec2 e0 = v1 - v0; vec2 w0 = p - v0;
  vec2 e1 = v2 - v1; vec2 w1 = p - v1;
  vec2 e2 = v3 - v2; vec2 w2 = p - v2;
  vec2 e3 = v0 - v3; vec2 w3 = p - v3;
  float d0 = length(w0 - e0 * clamp(dot(w0, e0) / dot(e0, e0), 0.0, 1.0));
  float d1 = length(w1 - e1 * clamp(dot(w1, e1) / dot(e1, e1), 0.0, 1.0));
  float d2 = length(w2 - e2 * clamp(dot(w2, e2) / dot(e2, e2), 0.0, 1.0));
  float d3 = length(w3 - e3 * clamp(dot(w3, e3) / dot(e3, e3), 0.0, 1.0));
  float minD = min(min(d0, d1), min(d2, d3));
  bool s0 = cross2d(e0, w0) >= 0.0;
  bool s1 = cross2d(e1, w1) >= 0.0;
  bool s2 = cross2d(e2, w2) >= 0.0;
  bool s3 = cross2d(e3, w3) >= 0.0;
  bool inside = (s0 && s1 && s2 && s3) || (!s0 && !s1 && !s2 && !s3);
  return inside ? -minD : minD;
}

vec2 rot2d(vec2 v, float a) {
  float c = cos(a);
  float s = sin(a);
  return vec2(v.x * c - v.y * s, v.x * s + v.y * c);
}

vec4 renderBauhaus(vec2 uv, float ang) {
  vec2 p = uv * u_res;
  vec2 axisDir = vec2(0.809017, -0.587785); // -36 deg unit vector

  if (u_pass > 0.5) {
    // Crisp kinetic Vernier registration ticks gliding subtly along a -36deg datum hairline (no muddy white wipe!)
    vec2 rel = rot2d(p - vec2(365.0, 478.0), 0.6283185);
    float rail = smoothstep(1.2, 0.2, abs(rel.y + 54.0));
    float tickCell = mod(rel.x - u_phase * 240.0, 40.0) - 20.0;
    float tick = smoothstep(1.1, 0.2, abs(tickCell)) * smoothstep(7.0, 1.0, abs(rel.y + 54.0));
    float clipZone = smoothstep(90.0, 180.0, p.y) * smoothstep(820.0, 700.0, p.y);
    float a = clamp((rail * 0.08 + tick * 0.16) * clipZone, 0.0, 0.16);
    return vec4(u_accentB * a, a);
  }

  // Stationary archival cotton paper / matte obsidian gallery stock (never scrolls!)
  vec3 col = u_colA;
  vec3 redCol = u_colB;
  vec3 blueCol = u_colC;
  vec3 ochreCol = u_accentA;

  // 1. Kinetic Vermilion Open C-Arc: poised angular rocking + breathing radius
  vec2 cCenter = vec2(364.0, 432.0) + vec2(cos(ang) * 5.0, sin(ang) * 4.0);
  float arcR = 244.0 + 5.0 * sin(ang);
  float halfSw = u_sun.x * 0.5;
  vec2 dArc = p - cCenter;
  float rDist = abs(length(dArc) - arcR) - halfSw;
  // Opening centered at +8 deg, half-gap 30 deg, gently rocking +-12 deg
  float gapCenter = 0.1396 + 0.21 * sin(ang);
  vec2 gapDir = vec2(cos(gapCenter), sin(gapCenter));
  float angCos = dot(normalize(dArc + vec2(0.0001)), gapDir);
  // Cut angular wedge cleanly with anti-aliased butt caps
  float gapSdf = angCos - cos(0.5236); // > 0 inside the open gap
  float arcMask = smoothstep(1.1, -1.1, rDist) * smoothstep(0.012, -0.012, gapSdf);

  // Delicate architectural compass hairline outside C-arc
  float ringHair = smoothstep(1.3, 0.1, abs(length(dArc) - (arcR + halfSw + 12.0))) * smoothstep(-0.15, 0.35, -angCos);

  // 2. Kinetic Vermilion Satellite Disc: glides smoothly along the -36deg Constructivist axis
  vec2 discCenter = vec2(526.0, 224.0) + axisDir * (28.0 * sin(ang + 1.05));
  float discMask = smoothstep(1.1, -1.1, length(p - discCenter) - 168.0);

  // 3. Kinetic Ochre-Gold Beam: counter-glides along -36deg rail with subtle angular torsion
  float ochreTilt = 0.6283185 + 0.036 * cos(ang);
  vec2 ochreRel = rot2d(p - (vec2(365.0, 478.0) - axisDir * (24.0 * sin(ang))), ochreTilt);
  vec2 ochreD = abs(ochreRel - vec2(-20.0, 0.0)) - vec2(410.0, u_sun.y);
  float ochreSdf = length(max(ochreD, 0.0)) + min(max(ochreD.x, ochreD.y), 0.0);
  float ochreMask = smoothstep(1.1, -1.1, ochreSdf);

  // 4. Kinetic Klein-Blue Architectural Wedge: tectonic counter-glide + pivot
  vec2 wPivot = vec2(375.0, 440.0);
  vec2 wp = wPivot + rot2d(p - wPivot - axisDir * (18.0 * cos(ang)), -0.032 * sin(ang));
  float blueSdf = sdQuad4(wp, vec2(78.0, 844.0), vec2(356.0, 642.0), vec2(672.0, 34.0), vec2(316.0, 246.0));
  float blueMask = smoothstep(1.1, -1.1, blueSdf);

  if (u_isDark < 0.5) {
    // Authentic Zürich Kunsthalle subtractive pigment multiply overprint on cotton paper
    col *= mix(vec3(1.0), redCol, arcMask * 0.74);
    col *= mix(vec3(1.0), redCol, discMask * 0.74);
    col *= mix(vec3(1.0), ochreCol, ochreMask * 0.74);
    col *= mix(vec3(1.0), blueCol, blueMask * 0.72);
    col = mix(col, u_accentB, ringHair * 0.16);
  } else {
    // Matte obsidian gallery stock with rich translucent nocturnal architectural glazes
    col = mix(col, redCol, arcMask * 0.72);
    col = mix(col, redCol * 1.06, discMask * 0.68);
    col = mix(col, ochreCol, ochreMask * 0.70);
    col = mix(col, blueCol, blueMask * 0.74);
    // Subtle jewel overprint luminance where primary plates intersect
    float overlap = (arcMask + discMask) * blueMask + ochreMask * blueMask;
    col += vec3(0.10, 0.06, 0.14) * clamp(overlap, 0.0, 1.0);
    col = mix(col, u_accentB, ringHair * 0.20);
  }

  // Stationary tactile cotton-paper / gallery grain
  float fiber = hash21(floor(p * 0.75)) - 0.5;
  col += fiber * (u_isDark > 0.5 ? 0.016 : 0.020);
  return vec4(clamp(col, 0.0, 1.0), 1.0);
}

vec4 renderPhosphor(vec2 uv, float ang) {
  float cv = sampleCurve(uv.x);
  float trough = exp(-pow(uv.x - 0.27, 2.0) / 0.032) * 0.205;
  float crest = exp(-pow(uv.x - 0.81, 2.0) / 0.018) * (0.285 + cv * 0.10);
  float centerWave = 0.48 + trough - crest - cv * 0.048 + (0.5 - uv.x) * 0.036;

  if (u_pass > 0.5) {
    // Foreground 8 harmonic phosphor/ink strands weaving IN FRONT OF 4.8M
    vec3 colSum = vec3(0.0);
    float wSum = 0.0;
    for (int i = 0; i < 8; i++) {
      float fi = float(i) / 7.0;
      float dir = mod(float(i), 2.0) < 0.5 ? 1.0 : -1.0;
      float harm = sin(uv.x * 8.2 + fi * 3.4 + ang * dir) * (0.030 + fi * 0.036)
        + cos(uv.x * 13.0 - fi * 2.1 + ang) * 0.014;
      float spread = (fi - 0.5) * (0.068 - exp(-pow(uv.x - 0.81, 2.0) / 0.015) * 0.044);
      float sy = centerWave + harm + spread;
      float d = abs(uv.y - sy);
      float line = 0.0012 / (0.0012 + d * d * 125.0);
      vec3 sc = dir > 0.0 ? u_accentB : u_accentA;
      colSum += sc * line;
      wSum += line;
    }
    float mask = smoothstep(0.06, 0.14, uv.y) * smoothstep(0.74, 0.64, uv.y);
    vec3 avgCol = wSum > 0.0001 ? clamp(colSum / wSum, 0.0, 1.0) : u_accentA;
    if (u_isDark > 0.5) {
      float a = clamp(wSum * 0.30 * mask, 0.0, 0.46);
      return vec4(clamp(colSum * 0.42 * mask, 0.0, 1.0), a);
    }
    float aL = clamp(wSum * 0.24 * mask, 0.0, 0.42);
    return vec4(avgCol * aL, aL);
  }

  // CRT darkroom / cyanotype stock + 14 background harmonic strands
  vec3 bg = mix(u_colA, u_colB, uv.y);
  vec3 glowSum = vec3(0.0);
  float wBg = 0.0;
  for (int i = 0; i < 14; i++) {
    float fi = float(i) / 13.0;
    float dir = mod(float(i), 2.0) < 0.5 ? 1.0 : -1.0;
    float harm = sin(uv.x * 8.0 + fi * 3.1 + ang * dir) * (0.028 + fi * 0.042)
      + cos(uv.x * 13.2 - fi * 2.4 + ang) * 0.015;
    float spread = (fi - 0.5) * (0.074 - exp(-pow(uv.x - 0.81, 2.0) / 0.015) * 0.048);
    float sy = centerWave + harm + spread;
    float d = abs(uv.y - sy);
    float core = 0.0011 / (0.0011 + d * d * 130.0);
    float halo = exp(-d * 28.0) * 0.065;
    vec3 sc = dir > 0.0 ? u_accentA : u_accentB;
    glowSum += sc * (core * 0.62 + halo);
    wBg += core * 0.55 + halo * 0.7;
  }
  if (u_isDark > 0.5) {
    bg += glowSum * 0.82;
    float scan = 0.985 + 0.015 * sin(uv.y * u_res.y * 1.4);
    vec2 vigUv = uv * (1.0 - uv.yx);
    float vig = pow(clamp(vigUv.x * vigUv.y * 18.0, 0.0, 1.0), 0.22);
    bg *= scan * vig;
  } else {
    vec3 inkCol = wBg > 0.0001 ? clamp(glowSum / wBg, 0.0, 1.0) : u_accentB;
    bg = mix(bg, inkCol, clamp(wBg * 0.42, 0.0, 0.76));
  }
  return vec4(clamp(bg, 0.0, 1.0), 1.0);
}

void main() {
  float ang = u_phase * TAU;
  if (u_style < 0.5) {
    gl_FragColor = renderMountain(v_uv, ang);
  } else if (u_style < 1.5) {
    gl_FragColor = renderAbyssal(v_uv, ang);
  } else if (u_style < 2.5) {
    gl_FragColor = renderEclipse(v_uv, ang);
  } else if (u_style < 3.5) {
    gl_FragColor = renderBauhaus(v_uv, ang);
  } else {
    gl_FragColor = renderPhosphor(v_uv, ang);
  }
}
`;

let sharedEngine = null;
let webglBlocked = false;

function compileShader(gl, type, src) {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

function createGlContextOnCanvas(canvas) {
  const attrs = {
    alpha: true,
    premultipliedAlpha: true,
    antialias: true,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: true,
  };
  let gl = null;
  try {
    gl = canvas.getContext('webgl', attrs) || canvas.getContext('experimental-webgl', attrs);
  } catch {
    return null;
  }
  if (!gl) return null;

  const vs = compileShader(gl, gl.VERTEX_SHADER, VERT_SRC);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
  if (!vs || !fs) return null;

  const prog = gl.createProgram();
  if (!prog) return null;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    gl.deleteProgram(prog);
    return null;
  }

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

  const aPos = gl.getAttribLocation(prog, 'a_pos');
  gl.useProgram(prog);
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  return {
    canvas,
    gl,
    prog,
    locs: {
      res: gl.getUniformLocation(prog, 'u_res'),
      phase: gl.getUniformLocation(prog, 'u_phase'),
      style: gl.getUniformLocation(prog, 'u_style'),
      pass: gl.getUniformLocation(prog, 'u_pass'),
      isDark: gl.getUniformLocation(prog, 'u_isDark'),
      colA: gl.getUniformLocation(prog, 'u_colA'),
      colB: gl.getUniformLocation(prog, 'u_colB'),
      colC: gl.getUniformLocation(prog, 'u_colC'),
      accentA: gl.getUniformLocation(prog, 'u_accentA'),
      accentB: gl.getUniformLocation(prog, 'u_accentB'),
      sun: gl.getUniformLocation(prog, 'u_sun'),
      curve: gl.getUniformLocation(prog, 'u_curve[0]') || gl.getUniformLocation(prog, 'u_curve'),
    },
  };
}

function getSharedEngine() {
  if (webglBlocked || typeof document === 'undefined') return null;
  if (sharedEngine && sharedEngine.gl && !sharedEngine.gl.isContextLost()) return sharedEngine;
  const canvas = document.createElement('canvas');
  canvas.width = 760;
  canvas.height = 950;
  sharedEngine = createGlContextOnCanvas(canvas);
  if (!sharedEngine) webglBlocked = true;
  return sharedEngine;
}

export function isPosterWebglSupported() {
  return Boolean(getSharedEngine());
}

function drawPosterPass(engine, uniforms, phase, passVal, width, height) {
  const { canvas, gl, prog, locs } = engine;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  gl.viewport(0, 0, width, height);
  gl.useProgram(prog);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);

  gl.uniform2f(locs.res, width, height);
  gl.uniform1f(locs.phase, ((phase % 1) + 1) % 1);
  gl.uniform1f(locs.style, uniforms.styleIdx);
  gl.uniform1f(locs.pass, passVal);
  gl.uniform1f(locs.isDark, uniforms.isDark);
  gl.uniform3fv(locs.colA, uniforms.colA);
  gl.uniform3fv(locs.colB, uniforms.colB);
  gl.uniform3fv(locs.colC, uniforms.colC);
  gl.uniform3fv(locs.accentA, uniforms.accentA);
  gl.uniform3fv(locs.accentB, uniforms.accentB);
  gl.uniform4fv(locs.sun, uniforms.sun);
  if (locs.curve) gl.uniform1fv(locs.curve, new Float32Array(uniforms.curve));

  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

/** Drive real-time 60fps WebGL background + foreground layers inside #share-modal. */
export function startPosterWebglLoop({
  bgCanvas,
  fgCanvas,
  style,
  payload,
  reducedMotion = false,
  onPhase,
} = {}) {
  const engine = getSharedEngine();
  if (!engine || !bgCanvas) return null;
  const bgCtx = bgCanvas.getContext('2d');
  const fgCtx = fgCanvas ? fgCanvas.getContext('2d') : null;
  if (!bgCtx) return null;

  const w = bgCanvas.width || 760;
  const h = bgCanvas.height || 950;
  const uniforms = computePosterShaderUniforms(style, payload);

  const renderAt = (phase) => {
    drawPosterPass(engine, uniforms, phase, 0.0, w, h);
    bgCtx.clearRect(0, 0, w, h);
    bgCtx.drawImage(engine.canvas, 0, 0, w, h);
    if (fgCtx && fgCanvas) {
      drawPosterPass(engine, uniforms, phase, 1.0, w, h);
      fgCtx.clearRect(0, 0, fgCanvas.width, fgCanvas.height);
      fgCtx.drawImage(engine.canvas, 0, 0, fgCanvas.width, fgCanvas.height);
    }
    if (typeof onPhase === 'function') onPhase(phase);
  };

  renderAt(0);
  if (reducedMotion) {
    return { stop() {} };
  }

  let raf = 0;
  let stopped = false;
  let phase = 0;
  let lastTs = performance.now();
  const loopMs = 6400;

  const tick = (ts) => {
    if (stopped) return;
    const dt = Math.min(80, Math.max(0, ts - lastTs));
    lastTs = ts;
    phase = (phase + dt / loopMs) % 1;
    renderAt(phase);
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  return {
    stop() {
      stopped = true;
      if (raf) cancelAnimationFrame(raf);
    },
  };
}

function loadSvgOverlayImage(svgString) {
  return new Promise((resolve, reject) => {
    const blob = typeof Blob !== 'undefined' ? new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' }) : null;
    const url = blob && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function'
      ? URL.createObjectURL(blob)
      : null;
    const finish = (img, err) => {
      if (url) URL.revokeObjectURL(url);
      if (err) reject(err);
      else resolve(img);
    };
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => finish(img, null);
    img.onerror = () => {
      const fallback = new Image();
      fallback.decoding = 'async';
      fallback.onload = () => finish(fallback, null);
      fallback.onerror = (e) => finish(null, e || new Error('SVG decode failed'));
      fallback.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgString)}`;
    };
    img.src = url || `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgString)}`;
  });
}

/**
 * Create a fast GPU-accelerated hybrid frame renderer (WebGL bg + pre-decoded crisp cutout SVG + WebGL fg)
 * for H.264 Live Photo (.jpg), MP4, WebM, and smooth GIF export.
 */
export async function createPosterHybridCanvasRenderer({
  style,
  payload,
  buildCutoutSvg,
  width = 760,
  height = 950,
  signal = null,
} = {}) {
  const engine = getSharedEngine();
  if (!engine || typeof buildCutoutSvg !== 'function') return null;
  if (signal && signal.aborted) {
    const err = new Error('Aborted');
    err.name = 'AbortError';
    err.code = 'ABORTED';
    throw err;
  }

  const cutoutSvg = buildCutoutSvg({ webglCutout: true });
  const svgImg = await loadSvgOverlayImage(cutoutSvg);
  const uniforms = computePosterShaderUniforms(style, payload);

  return (targetCtx, phase, _frameIdx, outW, outH) => {
    const rw = outW || width;
    const rh = outH || height;
    targetCtx.imageSmoothingEnabled = true;
    targetCtx.imageSmoothingQuality = 'high';
    drawPosterPass(engine, uniforms, phase, 0.0, rw, rh);
    targetCtx.drawImage(engine.canvas, 0, 0, rw, rh);
    targetCtx.drawImage(svgImg, 0, 0, rw, rh);
    drawPosterPass(engine, uniforms, phase, 1.0, rw, rh);
    targetCtx.drawImage(engine.canvas, 0, 0, rw, rh);
  };
}
