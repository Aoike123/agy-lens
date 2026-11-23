// Empirical per-model and (input, output, cache_read) quota-ratio calibration
// plus external off-machine usage segment filtering.
// Pure ESM, zero external dependencies or browser globals.

import { roundN } from './pb.mjs';

export const MIN_EXTERNAL_DELTA = 0.005;
export const MIN_CALIBRATION_SEGMENTS = 4;
export const MIN_IO_CALIBRATION_SEGMENTS = 5;
export const MIN_MODEL_IO_SEGMENTS = 6;
export const MIN_CALIBRATION_TOTAL_DELTA = 0.04;
export const MULTIPLIER_MIN = 0.2;
export const CACHE_MULTIPLIER_MIN = 0.0;
export const MULTIPLIER_MAX = 5.0;
export const MAX_CALIBRATION_MODELS = 12;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Solves a square dense linear system `matrix * x = rhs` via Gaussian elimination
 * with partial pivoting. Returns `null` if singular or non-finite.
 */
export function solveLinearSystem(matrix, rhs) {
  if (!Array.isArray(matrix) || !Array.isArray(rhs)) return null;
  const n = matrix.length;
  if (!n || rhs.length !== n) return null;
  const a = matrix.map((row) => (Array.isArray(row) && row.length === n ? row.map(Number) : null));
  if (a.some((row) => !row || row.some((v) => !Number.isFinite(v)))) return null;
  const b = rhs.map(Number);
  if (b.some((v) => !Number.isFinite(v))) return null;

  for (let col = 0; col < n; col += 1) {
    let pivRow = col;
    let pivAbs = Math.abs(a[col][col]);
    for (let r = col + 1; r < n; r += 1) {
      const v = Math.abs(a[r][col]);
      if (v > pivAbs) {
        pivAbs = v;
        pivRow = r;
      }
    }
    if (pivAbs < 1e-12 || !Number.isFinite(pivAbs)) return null;
    if (pivRow !== col) {
      [a[col], a[pivRow]] = [a[pivRow], a[col]];
      [b[col], b[pivRow]] = [b[pivRow], b[col]];
    }
    const piv = a[col][col];
    for (let r = col + 1; r < n; r += 1) {
      const factor = a[r][col] / piv;
      if (factor === 0) continue;
      a[r][col] = 0;
      for (let c = col + 1; c < n; c += 1) a[r][c] -= factor * a[col][c];
      b[r] -= factor * b[col];
    }
  }

  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r -= 1) {
    let sum = b[r];
    for (let c = r + 1; c < n; c += 1) sum -= a[r][c] * x[c];
    const v = sum / a[r][r];
    if (!Number.isFinite(v)) return null;
    x[r] = v;
  }
  return x;
}

/**
 * Inverts a dense square `n × n` matrix via Gauss-Jordan elimination with partial
 * pivoting. Returns `null` if singular or non-finite.
 */
export function invertMatrix(matrix) {
  if (!Array.isArray(matrix)) return null;
  const n = matrix.length;
  if (!n) return null;
  const aug = matrix.map((row, r) => {
    if (!Array.isArray(row) || row.length !== n) return null;
    const out = new Array(2 * n).fill(0);
    for (let c = 0; c < n; c += 1) {
      const v = Number(row[c]);
      if (!Number.isFinite(v)) return null;
      out[c] = v;
    }
    out[n + r] = 1;
    return out;
  });
  if (aug.some((r) => !r)) return null;

  for (let col = 0; col < n; col += 1) {
    let pivRow = col;
    let pivAbs = Math.abs(aug[col][col]);
    for (let r = col + 1; r < n; r += 1) {
      const v = Math.abs(aug[r][col]);
      if (v > pivAbs) {
        pivAbs = v;
        pivRow = r;
      }
    }
    if (pivAbs < 1e-12 || !Number.isFinite(pivAbs)) return null;
    if (pivRow !== col) [aug[col], aug[pivRow]] = [aug[pivRow], aug[col]];
    const piv = aug[col][col];
    for (let c = 0; c < 2 * n; c += 1) aug[col][c] /= piv;
    for (let r = 0; r < n; r += 1) {
      if (r === col) continue;
      const factor = aug[r][col];
      if (factor === 0) continue;
      for (let c = 0; c < 2 * n; c += 1) aug[r][c] -= factor * aug[col][c];
    }
  }

  return aug.map((row) => row.slice(n));
}

function modelCostParts(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return { in: raw, out: 0, cache: 0, total: raw };
  }
  if (raw && typeof raw === 'object') {
    const cIn = Number.isFinite(raw.in) ? raw.in : 0;
    const cOut = Number.isFinite(raw.out) ? raw.out : 0;
    const cCache = Number.isFinite(raw.cache) ? raw.cache : 0;
    const total = Number.isFinite(raw.total) ? raw.total : (cIn + cOut + cCache);
    return { in: cIn, out: cOut, cache: cCache, total };
  }
  return { in: 0, out: 0, cache: 0, total: 0 };
}

/**
 * Separates off-machine/external quota drops (delta >= 0.5% with zero local calls or
 * zero local spend) from clean local delta segments usable for valuation & fitting.
 */
export function filterExternalSegments(segments) {
  const clean = [];
  const external = [];
  let externalDelta = 0;
  for (const seg of Array.isArray(segments) ? segments : []) {
    if (!seg || typeof seg !== 'object') continue;
    const delta = Number(seg.delta);
    const calls = Number(seg.calls) || 0;
    const costUsd = Number(seg.costUsd) || 0;
    if (!Number.isFinite(delta) || delta <= 0) continue;
    if (delta >= MIN_EXTERNAL_DELTA && (calls <= 0 || costUsd <= 0)) {
      external.push(seg);
      externalDelta += delta;
      continue;
    }
    const minDelta = seg.fine ? 0.002 : 0.01;
    if (delta >= minDelta && costUsd > 0 && !seg.costPartial) {
      clean.push(seg);
    }
  }
  return { clean, external, externalDelta: roundN(externalDelta, 8) };
}

function emptyCalibration({ segments = 0, externalDropped = 0, externalDelta = 0, outliersDropped = 0, totalDelta = 0 } = {}) {
  return {
    calibrated: false,
    mode: 'prior',
    segments,
    external_dropped: externalDropped,
    external_delta: roundN(externalDelta, 8),
    outliers_dropped: outliersDropped,
    total_delta: roundN(totalDelta, 6),
    improvement_pct: 0,
    loo_improvement_pct: 0,
    components: { input: 1, output: 1, cache_read: 1 },
    models: {},
  };
}

function fitRidgeCandidate(usable, features, { beta0, sse0, totalCost }) {
  const p = features.length;
  const n = usable.length;
  if (!p || n < 3 || sse0 <= 1e-12 || totalCost <= 0) return null;

  const A = Array.from({ length: p }, () => new Array(p).fill(0));
  const b = new Array(p).fill(0);
  const segRows = new Array(n);

  for (let s = 0; s < n; s += 1) {
    const seg = usable[s];
    const w = 1 / (seg.delta + 0.005);
    const featCosts = new Array(p);
    const x = new Array(p);
    let covered = 0;
    for (let j = 0; j < p; j += 1) {
      const fc = features[j].extractCost(seg);
      featCosts[j] = fc;
      covered += fc;
      x[j] = beta0 * fc;
    }
    const unmodeled = Math.max(0, seg.costUsd - covered);
    const o = beta0 * unmodeled;
    const e0 = seg.delta - o - x.reduce((acc, v) => acc + v, 0);
    segRows[s] = { w, featCosts, unmodeled, x, o, delta: seg.delta };

    for (let i = 0; i < p; i += 1) {
      b[i] += w * x[i] * e0;
      for (let j = i; j < p; j += 1) {
        A[i][j] += w * x[i] * x[j];
      }
    }
  }
  for (let i = 0; i < p; i += 1) {
    for (let j = 0; j < i; j += 1) A[i][j] = A[j][i];
  }

  let trace = 0;
  for (let i = 0; i < p; i += 1) trace += A[i][i];
  if (!Number.isFinite(trace) || trace <= 1e-18) return null;

  const lambda = 0.05 * (trace / p);
  const aReg = A.map((row, r) => row.map((v, c) => (r === c ? v + lambda : v)));
  const aRegInv = invertMatrix(aReg);
  const d = solveLinearSystem(aReg, b);
  if (!aRegInv || !d) return null;

  let sseLoo = 0;
  for (let s = 0; s < n; s += 1) {
    const { w, x, o, delta } = segRows[s];
    let yHatRaw = o;
    for (let j = 0; j < p; j += 1) yHatRaw += x[j] * (1 + d[j]);
    const rRaw = delta - yHatRaw;

    let quad = 0;
    for (let i = 0; i < p; i += 1) {
      let rowDot = 0;
      for (let j = 0; j < p; j += 1) rowDot += aRegInv[i][j] * x[j];
      quad += x[i] * rowDot;
    }
    const h = w * quad;
    if (!Number.isFinite(h) || 1 - h <= 0.05) return null;
    const eLoo = rRaw / (1 - h);
    sseLoo += w * eLoo * eLoo;
  }

  const rawAlpha = d.map((dj, j) => clamp(1 + dj, features[j].minBound, features[j].maxBound));
  let calTotal = 0;
  for (let s = 0; s < n; s += 1) {
    const { featCosts, unmodeled } = segRows[s];
    calTotal += unmodeled;
    for (let j = 0; j < p; j += 1) calTotal += featCosts[j] * rawAlpha[j];
  }
  if (!Number.isFinite(calTotal) || calTotal <= 1e-9) return null;

  const meanAlpha = calTotal / totalCost;
  if (!Number.isFinite(meanAlpha) || meanAlpha <= 1e-6) return null;
  const alphas = rawAlpha.map((a, j) => clamp(a / meanAlpha, features[j].minBound, features[j].maxBound));

  let numG = 0;
  let denG = 0;
  for (let s = 0; s < n; s += 1) {
    const { w, featCosts, unmodeled, delta } = segRows[s];
    let u = unmodeled;
    for (let j = 0; j < p; j += 1) u += featCosts[j] * alphas[j];
    numG += w * u * delta;
    denG += w * u * u;
  }
  if (!Number.isFinite(denG) || denG <= 1e-18) return null;
  const gamma = numG / denG;
  if (!Number.isFinite(gamma) || gamma <= 0) return null;

  let sseFit = 0;
  for (let s = 0; s < n; s += 1) {
    const { w, featCosts, unmodeled, delta } = segRows[s];
    let u = unmodeled;
    for (let j = 0; j < p; j += 1) u += featCosts[j] * alphas[j];
    const err = delta - gamma * u;
    sseFit += w * err * err;
  }

  const maxDev = Math.max(...alphas.map((a) => Math.abs(a - 1)));
  return {
    alphas,
    sseFit,
    sseLoo,
    maxDev,
    improvementPct: roundN((1 - Math.sqrt(Math.max(0, sseFit) / sse0)) * 100, 1),
    looImprovementPct: roundN((1 - Math.sqrt(Math.max(0, sseLoo) / sse0)) * 100, 1),
  };
}

/**
 * Fits empirical per-model and/or per-token-type `(input, output, cache_read)`
 * internal quota multipliers from clean in-cycle delta segments using Ridge
 * weighted least squares and exact analytical Leave-One-Out CV gating.
 */
export function calibratePoolWeights(segments, { modelNames = null } = {}) {
  const { clean, external, externalDelta } = filterExternalSegments(segments);

  let usable = clean;
  let outliersDropped = 0;
  if (clean.length >= 3) {
    const rates = clean.map((s) => s.delta / s.costUsd).sort((a, b) => a - b);
    const mid = rates.length >> 1;
    const med = rates.length % 2 === 1 ? rates[mid] : (rates[mid - 1] + rates[mid]) / 2;
    if (Number.isFinite(med) && med > 0) {
      const next = [];
      for (const s of clean) {
        const r = s.delta / s.costUsd;
        if (r > med * 4 || r < med * 0.25) outliersDropped += 1;
        else next.push(s);
      }
      usable = next;
    }
  }

  let totalDelta = 0;
  let totalCost = 0;
  for (const s of usable) {
    totalDelta += s.delta;
    totalCost += s.costUsd;
  }

  if (usable.length < MIN_CALIBRATION_SEGMENTS || totalDelta < MIN_CALIBRATION_TOTAL_DELTA || totalCost <= 0) {
    return emptyCalibration({
      segments: usable.length,
      externalDropped: external.length,
      externalDelta,
      outliersDropped,
      totalDelta,
    });
  }

  // Optimal weighted prior scalar beta0 ensures relative-weight fitting cannot gain from scale-only tweaks.
  let num0 = 0;
  let den0 = 0;
  for (const s of usable) {
    const w = 1 / (s.delta + 0.005);
    num0 += w * s.costUsd * s.delta;
    den0 += w * s.costUsd * s.costUsd;
  }
  if (!Number.isFinite(den0) || den0 <= 1e-18 || num0 <= 0) {
    return emptyCalibration({
      segments: usable.length,
      externalDropped: external.length,
      externalDelta,
      outliersDropped,
      totalDelta,
    });
  }
  const beta0 = num0 / den0;
  let sse0 = 0;
  for (const s of usable) {
    const w = 1 / (s.delta + 0.005);
    const err0 = s.delta - beta0 * s.costUsd;
    sse0 += w * err0 * err0;
  }
  if (!Number.isFinite(sse0) || sse0 <= 1e-12) {
    return emptyCalibration({
      segments: usable.length,
      externalDropped: external.length,
      externalDelta,
      outliersDropped,
      totalDelta,
    });
  }

  const modelStats = new Map();
  const poolComp = { in: 0, out: 0, cache: 0 };
  for (const s of usable) {
    if (!(s.costByModel instanceof Map)) continue;
    for (const [m, raw] of s.costByModel) {
      const p = modelCostParts(raw);
      if (p.total <= 0) continue;
      let st = modelStats.get(m);
      if (!st) {
        st = { in: 0, out: 0, cache: 0, total: 0, samples: 0 };
        modelStats.set(m, st);
      }
      st.in += p.in;
      st.out += p.out;
      st.cache += p.cache;
      st.total += p.total;
      st.samples += 1;
      poolComp.in += p.in;
      poolComp.out += p.out;
      poolComp.cache += p.cache;
    }
  }

  const activeModels = [...modelStats.entries()]
    .filter(([, st]) => st.total >= 0.02 * totalCost && st.samples >= 1)
    .sort((a, b) => b[1].total - a[1].total || b[1].samples - a[1].samples || a[0].localeCompare(b[0]))
    .slice(0, MAX_CALIBRATION_MODELS)
    .map(([m]) => m);

  const compOf = (seg, field) => {
    let sum = 0;
    if (seg.costByModel instanceof Map) {
      for (const raw of seg.costByModel.values()) sum += modelCostParts(raw)[field];
    }
    return sum;
  };
  const modelPartOf = (seg, model, field) => {
    if (!(seg.costByModel instanceof Map)) return 0;
    return modelCostParts(seg.costByModel.get(model))[field];
  };

  let candModel = null;
  if (activeModels.length >= 2) {
    const features = activeModels.map((m) => ({
      model: m,
      minBound: MULTIPLIER_MIN,
      maxBound: MULTIPLIER_MAX,
      extractCost: (seg) => modelPartOf(seg, m, 'total'),
    }));
    const fit = fitRidgeCandidate(usable, features, { beta0, sse0, totalCost });
    if (fit && fit.sseFit <= sse0 * 0.85 && fit.sseLoo <= sse0 * 0.90 && fit.maxDev >= 0.08) {
      candModel = { mode: 'model', features, ...fit };
    }
  }

  let candIo = null;
  if (usable.length >= MIN_IO_CALIBRATION_SEGMENTS) {
    const compDefs = [
      { key: 'in', field: 'in', minBound: MULTIPLIER_MIN },
      { key: 'out', field: 'out', minBound: MULTIPLIER_MIN },
      { key: 'cache', field: 'cache', minBound: CACHE_MULTIPLIER_MIN },
    ].filter((c) => poolComp[c.field] >= 0.02 * totalCost);
    if (compDefs.length >= 2) {
      const features = compDefs.map((c) => ({
        comp: c.field,
        minBound: c.minBound,
        maxBound: MULTIPLIER_MAX,
        extractCost: (seg) => compOf(seg, c.field),
      }));
      const fit = fitRidgeCandidate(usable, features, { beta0, sse0, totalCost });
      if (fit && fit.sseFit <= sse0 * 0.85 && fit.sseLoo <= sse0 * 0.90 && fit.maxDev >= 0.08) {
        candIo = { mode: 'io', features, ...fit };
      }
    }
  }

  let candModelIo = null;
  if (usable.length >= MIN_MODEL_IO_SEGMENTS && activeModels.length >= 2 && totalDelta >= 0.06) {
    const features = [];
    for (const m of activeModels.slice(0, 6)) {
      const st = modelStats.get(m);
      if (!st) continue;
      for (const comp of [
        { field: 'in', minBound: MULTIPLIER_MIN },
        { field: 'out', minBound: MULTIPLIER_MIN },
        { field: 'cache', minBound: CACHE_MULTIPLIER_MIN },
      ]) {
        if (st[comp.field] >= 0.01 * totalCost) {
          features.push({
            model: m,
            comp: comp.field,
            minBound: comp.minBound,
            maxBound: MULTIPLIER_MAX,
            extractCost: (seg) => modelPartOf(seg, m, comp.field),
          });
        }
      }
    }
    if (features.length >= 3 && usable.length >= Math.min(features.length + 1, 6)) {
      const fit = fitRidgeCandidate(usable, features, { beta0, sse0, totalCost });
      if (fit && fit.sseFit <= sse0 * 0.80 && fit.sseLoo <= sse0 * 0.85 && fit.maxDev >= 0.08) {
        candModelIo = { mode: 'model_io', features, ...fit };
      }
    }
  }

  const simpleCands = [candModel, candIo].filter(Boolean).sort((a, b) => a.sseLoo - b.sseLoo);
  const bestSimple = simpleCands[0] || null;
  let winner = bestSimple;
  if (candModelIo && (!bestSimple || candModelIo.sseLoo <= bestSimple.sseLoo * 0.95)) {
    winner = candModelIo;
  }

  if (!winner) {
    return emptyCalibration({
      segments: usable.length,
      externalDropped: external.length,
      externalDelta,
      outliersDropped,
      totalDelta,
    });
  }

  const perModelW = new Map();
  for (const m of modelStats.keys()) perModelW.set(m, { in: 1, out: 1, cache: 1 });
  const compWeights = { in: 1, out: 1, cache: 1 };

  if (winner.mode === 'model') {
    winner.features.forEach((f, idx) => {
      const a = winner.alphas[idx];
      perModelW.set(f.model, { in: a, out: a, cache: a });
    });
  } else if (winner.mode === 'io') {
    winner.features.forEach((f, idx) => {
      compWeights[f.comp] = winner.alphas[idx];
    });
    for (const m of modelStats.keys()) {
      perModelW.set(m, { ...compWeights });
    }
  } else if (winner.mode === 'model_io') {
    winner.features.forEach((f, idx) => {
      const w = perModelW.get(f.model);
      if (w) w[f.comp] = winner.alphas[idx];
    });
  }

  // Compute spend-weighted average component weights across the pool for fallback models.
  const sumWComp = { in: 0, out: 0, cache: 0 };
  for (const [m, st] of modelStats) {
    const w = perModelW.get(m) || { in: 1, out: 1, cache: 1 };
    sumWComp.in += st.in * w.in;
    sumWComp.out += st.out * w.out;
    sumWComp.cache += st.cache * w.cache;
  }
  const components = {
    input: poolComp.in > 0 ? roundN(sumWComp.in / poolComp.in, 3) : roundN(compWeights.in, 3),
    output: poolComp.out > 0 ? roundN(sumWComp.out / poolComp.out, 3) : roundN(compWeights.out, 3),
    cache_read: poolComp.cache > 0 ? roundN(sumWComp.cache / poolComp.cache, 3) : roundN(compWeights.cache, 3),
  };

  const models = {};
  for (const [m, st] of modelStats) {
    const w = perModelW.get(m) || { in: 1, out: 1, cache: 1 };
    const eff = st.total > 0 ? (st.in * w.in + st.out * w.out + st.cache * w.cache) / st.total : 1;
    models[m] = {
      multiplier: roundN(eff, 3),
      input: roundN(w.in, 3),
      output: roundN(w.out, 3),
      cache_read: roundN(w.cache, 3),
      samples: st.samples,
      cost_usd: roundN(st.total, 4),
      display_name: (modelNames && modelNames.get(m)) || m,
    };
  }

  return {
    calibrated: true,
    mode: winner.mode,
    segments: usable.length,
    external_dropped: external.length,
    external_delta: externalDelta,
    outliers_dropped: outliersDropped,
    total_delta: roundN(totalDelta, 6),
    improvement_pct: winner.improvementPct,
    loo_improvement_pct: winner.looImprovementPct,
    components,
    models,
  };
}

/**
 * Evaluates calibrated quota-equivalent cost for one call/model tuple `[cIn, cOut, cCache]`.
 * Falls back transparently to raw sum when uncalibrated or unknown model uses pool defaults.
 */
export function calibratedCallCost(cal, modelId, cIn = 0, cOut = 0, cCache = 0) {
  const raw = cIn + cOut + cCache;
  if (!cal || !cal.calibrated) return raw;
  const mw = cal.models && modelId && Object.hasOwn(cal.models, modelId) ? cal.models[modelId] : null;
  if (mw) {
    return cIn * mw.input + cOut * mw.output + cCache * mw.cache_read;
  }
  const comp = cal.components || { input: 1, output: 1, cache_read: 1 };
  return cIn * comp.input + cOut * comp.output + cCache * comp.cache_read;
}
