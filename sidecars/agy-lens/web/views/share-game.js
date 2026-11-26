// Share-card mini game: six stats, class / level / rarity, achievements, quip library,
// PK code codec, deterministic battle and the pluggable animation timeline.
// Pure ES module: no DOM or browser globals, so it runs in Node (tests, sidecar) and in the panel.

import { fmtTok, inferPool, isNum, num, periodWeeklySummary, sliceModelsForPeriod } from '../format.js';

// --- art manifest --------------------------------------------------------------------------
// Mirrors art-src/roster.json (tests keep the two in sync). Files live in sidecars/agy-lens/share-art/.

export const STAT_KEYS = ['POW', 'INT', 'STA', 'WIS', 'CMB', 'ELO'];

/** Twelve classes, two per stat; the novice is the shared starting form below Lv 10. */
export const CLASS_BY_STAT = {
  POW: ['berserker', 'glassblower'],
  INT: ['alchemist', 'clockmaker'],
  STA: ['knight', 'monk'],
  WIS: ['mage', 'surveyor'],
  CMB: ['dancer', 'diver'],
  ELO: ['bard', 'kite'],
};

/** Order is part of the PK code format: append only. */
export const CLASS_IDS = [
  'novice', 'alchemist', 'berserker', 'bard', 'knight', 'mage', 'monk',
  'diver', 'kite', 'surveyor', 'clockmaker', 'dancer', 'glassblower',
];
/** Order is part of the PK code format: append only. */
export const STAGE_IDS = ['starter-male', 'starter-female', 'mid', 'late'];

export const CLASS_STAGES = Object.fromEntries(CLASS_IDS.map((id) => [
  id, id === 'novice' ? ['starter-male', 'starter-female', 'late'] : ['mid', 'late'],
]));

/** Stages that ship an idle loop (novice `late` is a growth plate without one). */
export function hasIdle(classId, stage) {
  return CLASS_STAGES[classId]?.includes(stage) && !(classId === 'novice' && stage === 'late');
}

export const ARENA_IDS = [
  'archive-garden', 'caravan', 'foundry', 'lantern-academy', 'observatory',
  'pearl-quay', 'salt-canyon', 'thunderrail', 'vault', 'windmill',
];

/** Default arena per class, used as the role-card backdrop. */
export const CLASS_ARENA = {
  novice: 'lantern-academy', alchemist: 'vault', berserker: 'foundry', bard: 'caravan',
  knight: 'observatory', mage: 'archive-garden', monk: 'salt-canyon', diver: 'pearl-quay',
  kite: 'windmill', surveyor: 'observatory', clockmaker: 'thunderrail', dancer: 'salt-canyon',
  glassblower: 'foundry',
};

/** Idle cell geometry from roster.json `grid`. Every action strip uses the same cell and baseline. */
export const SPRITE_CELL = { w: 192, h: 128, baseline: 114, bodyHeight: 90 };
export const ARENA_SIZE = { w: 1376, h: 768, floor: 0.87 };

export const charStillPath = (classId, stage) => `characters/${classId}/still-${stage}.png`;
export const charIdlePath = (classId, stage) => `characters/${classId}/idle-${stage}.webp`;
export const arenaPath = (arenaId) => `arenas/${arenaId}.png`;

// --- six stats ----------------------------------------------------------------------------

const PERIOD_DAYS = { today: 1, d7: 7, d30: 30 };
const clamp100 = (v) => Math.max(0, Math.min(100, Math.round(num(v))));
const safe = (v) => (isNum(v) && v > 0 ? v : 0);
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function cleanDaily(daily) {
  return (Array.isArray(daily) ? daily : [])
    .filter((d) => d && typeof d.date === 'string' && ISO_DAY.test(d.date))
    .map((d) => ({ date: d.date, tokens: safe(d.tokens), calls: safe(d.calls) }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

function dayIndex(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
}

function periodSlice(daily, period) {
  if (period === 'today') return daily.slice(-1);
  if (period === 'd7') return daily.slice(-7);
  if (period === 'd30') return daily.slice(-30);
  return daily;
}

function periodDays(daily, period) {
  if (PERIOD_DAYS[period]) return PERIOD_DAYS[period];
  const active = daily.filter((d) => d.tokens > 0 || d.calls > 0);
  if (!active.length) return 1;
  return Math.max(1, dayIndex(daily[daily.length - 1].date) - dayIndex(active[0].date) + 1);
}

function bucketOf(totals, period) {
  const b = totals && typeof totals === 'object' ? totals[period] : null;
  return b && typeof b === 'object' ? b : {};
}

/** Gemini weekly-quota use in a period: official cycles first, then cost / weekly value. */
function geminiQuota(hist, period) {
  const pq = hist.period_quota && hist.period_quota[period] && hist.period_quota[period].gemini;
  if (pq && isNum(pq.pct) && pq.pct > 0) return { pct: pq.pct, norm: 'quota' };
  const summary = periodWeeklySummary(hist.by_model, period, hist.weekly_value_usd, hist.quota_calibration);
  const g = summary.find((x) => x.pool === 'gemini');
  if (g) return { pct: g.pct, norm: 'approx' };
  const hasCycles = Boolean(hist.period_quota && Object.values(hist.period_quota).some((w) => w && Object.keys(w).length))
    || safe(hist.weekly_value_usd && hist.weekly_value_usd.gemini) > 0;
  return { pct: 0, norm: hasCycles ? 'quota' : 'raw' };
}

function geminiNewTokens(byModel, period) {
  let tok = 0;
  for (const m of sliceModelsForPeriod(byModel, period)) {
    const pool = m.pool || inferPool(m.model || m.display_name || '');
    if (pool === 'gemini') tok += safe(m.input) + safe(m.output);
  }
  return tok;
}

/** Effective number of models (exp of Shannon entropy over input+output tokens). */
function effectiveModels(byModel, period) {
  const by = new Map();
  for (const m of sliceModelsForPeriod(byModel, period)) {
    const name = String(m.display_name || m.model || '?');
    by.set(name, (by.get(name) || 0) + safe(m.input) + safe(m.output));
  }
  const vals = [...by.values()].filter((v) => v > 0);
  const total = vals.reduce((a, b) => a + b, 0);
  if (!total) return { eff: 0, count: 0, topShare: 0 };
  let h = 0;
  for (const v of vals) { const p = v / total; h -= p * Math.log(p); }
  return { eff: Math.exp(h), count: vals.length, topShare: Math.max(...vals) / total };
}

/**
 * Six plan-independent stats (0-100) for a history payload and period.
 *  POW  Gemini weekly quota used per week (official cycles; ≈ cost/weekly value; raw tokens otherwise)
 *  INT  cache hit rate: cache_read / (input + cache_read)
 *  STA  active days / days in period (today: active hours / 8)
 *  WIS  effective number of models, 1 -> 0, 4+ -> 100
 *  CMB  calls per conversation, saturating (25 calls -> 63)
 *  ELO  output share of new tokens, 50% -> 100
 */
export function computeStats(hist = {}, period = 'd30') {
  const h = hist && typeof hist === 'object' ? hist : {};
  const b = bucketOf(h.totals, period);
  const inp = safe(b.input);
  const out = safe(b.output);
  const cache = safe(b.cache_read);
  const calls = safe(b.calls);
  const convs = safe(b.conversations);
  const daily = cleanDaily(h.daily);
  const slice = periodSlice(daily, period);
  const days = periodDays(daily, period);
  const activeDays = slice.filter((d) => d.tokens > 0 || d.calls > 0).length;
  const hourly = Array.isArray(h.hourly_today) ? h.hourly_today : [];
  const activeHours = hourly.filter((x) => x && (safe(x.tokens) > 0 || safe(x.calls) > 0)).length;

  const q = geminiQuota(h, period);
  let powRaw;
  let pow;
  if (q.norm === 'raw') {
    const perDay = geminiNewTokens(h.by_model, period) / Math.max(1, activeDays || days);
    powRaw = perDay;
    pow = 100 * (1 - Math.exp(-perDay / 1.5e6));
  } else {
    powRaw = (q.pct * 7) / days;
    pow = powRaw;
  }
  const models = effectiveModels(h.by_model, period);
  const intRaw = inp + cache > 0 ? cache / (inp + cache) : 0;
  const staRaw = period === 'today' ? (hourly.length ? activeHours / 8 : (activeDays ? 0.5 : 0)) : activeDays / days;
  const cmbRaw = convs > 0 ? calls / convs : 0;
  const eloRaw = inp + out > 0 ? out / (inp + out) : 0;

  const values = {
    POW: clamp100(pow),
    INT: clamp100(intRaw * 100),
    STA: clamp100(staRaw * 100),
    WIS: clamp100(((models.eff - 1) / 3) * 100),
    CMB: clamp100(100 * (1 - Math.exp(-cmbRaw / 25))),
    ELO: clamp100((eloRaw / 0.5) * 100),
  };
  return {
    period,
    norm: q.norm,
    values,
    raw: {
      powPctPerWeek: q.norm === 'raw' ? null : powRaw,
      powTokPerDay: q.norm === 'raw' ? powRaw : null,
      cacheRate: intRaw,
      activeDays,
      activeHours,
      days,
      models: models.count,
      effModels: models.eff,
      topModelShare: models.topShare,
      callsPerConv: cmbRaw,
      outputShare: eloRaw,
    },
    totals: { input: inp, output: out, cache_read: cache, calls, conversations: convs, est_cost_usd: isNum(b.est_cost_usd) ? b.est_cost_usd : null },
  };
}

/** Level from all-time Gemini quota weeks and active days: plan size never buys levels. */
export function computeLevel(hist = {}) {
  const h = hist && typeof hist === 'object' ? hist : {};
  const daily = cleanDaily(h.daily);
  const activeDaysAll = daily.filter((d) => d.tokens > 0 || d.calls > 0).length;
  const q = geminiQuota(h, 'all');
  let quotaExp;
  if (q.norm === 'raw') {
    const b = bucketOf(h.totals, 'all');
    quotaExp = (safe(b.input) + safe(b.output)) / 200000;
  } else {
    quotaExp = q.pct;
  }
  const exp = Math.round(quotaExp + activeDaysAll * 20);
  const level = Math.min(99, Math.floor(Math.sqrt(exp / 6)) + 1);
  const floorExp = 6 * (level - 1) ** 2;
  const nextExp = 6 * level ** 2;
  const progress = level >= 99 ? 1 : Math.max(0, Math.min(1, (exp - floorExp) / (nextExp - floorExp)));
  return { level, exp, nextExp, progress, activeDaysAll };
}

export const RARITIES = ['N', 'R', 'SR', 'SSR', 'UR'];
export function rarityOf(values) {
  const sum = STAT_KEYS.reduce((a, k) => a + num(values && values[k]), 0);
  if (sum >= 450) return 'UR';
  if (sum >= 360) return 'SSR';
  if (sum >= 270) return 'SR';
  if (sum >= 180) return 'R';
  return 'N';
}

/** Highest stat picks the class pair; the second-highest stat's slot picks which one. */
export function pickClass(values) {
  const ranked = STAT_KEYS.map((k, i) => [k, num(values && values[k]), i])
    .sort((a, b) => (b[1] - a[1]) || (a[2] - b[2]));
  const top = ranked[0][0];
  const second = ranked[1][2];
  return { classId: CLASS_BY_STAT[top][second % 2], topStat: top };
}

export function stageForLevel(level, gender = 'male') {
  if (level < 10) return gender === 'female' ? 'starter-female' : 'starter-male';
  return level < 30 ? 'mid' : 'late';
}

/** Full character profile for the role card and the PK code. */
export function buildProfile(hist = {}, period = 'd30', { nickname = '', gender = 'male' } = {}) {
  const stats = computeStats(hist, period);
  const lv = computeLevel(hist);
  const { classId: destined, topStat } = pickClass(stats.values);
  const stage = stageForLevel(lv.level, gender);
  const classId = lv.level < 10 ? 'novice' : destined;
  return {
    nickname: sanitizeNickname(nickname),
    gender: gender === 'female' ? 'female' : 'male',
    classId,
    destinedClass: destined,
    topStat,
    stage,
    level: lv.level,
    exp: lv,
    rarity: rarityOf(stats.values),
    stats,
    tier: latestTier(hist),
    period,
    endDay: lastDay(hist),
  };
}

function latestTier(hist) {
  const cycles = hist && hist.weekly_cycles && hist.weekly_cycles.gemini;
  if (Array.isArray(cycles)) {
    for (const c of cycles) if (c && typeof c.tier === 'string' && c.tier) return c.tier;
  }
  if (hist && typeof hist.tier === 'string') return hist.tier;
  return '';
}

function lastDay(hist) {
  const daily = cleanDaily(hist && hist.daily);
  return daily.length ? daily[daily.length - 1].date : '';
}

// --- achievements -------------------------------------------------------------------------

export const USAGE_ACHIEVEMENTS = [
  'firstCall', 'millionaire', 'billionaire', 'grinder', 'nightOwl', 'earlyBird',
  'freeloader', 'wordy', 'perpetual', 'whale', 'modelHopper', 'loyal',
];
export const ACHIEVEMENTS = [...USAGE_ACHIEVEMENTS];

function longestStreak(daily) {
  let best = 0;
  let cur = 0;
  let prev = null;
  for (const d of daily) {
    const active = d.tokens > 0 || d.calls > 0;
    const idx = dayIndex(d.date);
    if (active) {
      cur = prev !== null && idx === prev + 1 && cur > 0 ? cur + 1 : 1;
      best = Math.max(best, cur);
    } else {
      cur = 0;
    }
    prev = idx;
  }
  return best;
}

/** Usage achievements for the chosen period (hour-based ones read today's clock). */
export function usageAchievements(hist = {}, period = 'd30', stats = computeStats(hist, period)) {
  const h = hist && typeof hist === 'object' ? hist : {};
  const all = bucketOf(h.totals, 'all');
  const t = stats.totals;
  const newTok = t.input + t.output;
  const daily = periodSlice(cleanDaily(h.daily), period);
  const hourly = Array.isArray(h.hourly_today) ? h.hourly_today : [];
  const todayTok = hourly.reduce((a, x) => a + safe(x && x.tokens), 0);
  const tokIn = (from, to) => hourly.filter((x) => x && x.hour >= from && x.hour < to).reduce((a, x) => a + safe(x.tokens), 0);
  return {
    firstCall: safe(all.calls) > 0 || t.calls > 0,
    millionaire: newTok >= 1e6,
    billionaire: newTok >= 1e8,
    grinder: longestStreak(daily) >= 7,
    nightOwl: todayTok > 0 && tokIn(0, 5) / todayTok >= 0.2,
    earlyBird: todayTok > 0 && tokIn(5, 9) / todayTok >= 0.3,
    freeloader: t.input + t.cache_read > 0 && stats.raw.cacheRate >= 0.9,
    wordy: newTok > 0 && stats.raw.outputShare >= 0.4,
    perpetual: t.calls >= 1000,
    whale: stats.norm !== 'raw' && stats.values.POW >= 90,
    modelHopper: stats.raw.models >= 5,
    loyal: t.calls >= 10 && stats.raw.models >= 1 && stats.raw.topModelShare >= 0.95,
  };
}

// --- quip library ---------------------------------------------------------------------------

/**
 * Conversion lines for the minimal card, built from real period numbers. Each entry is
 * [i18n key, ...args]; the panel rotates through them ("换一句") and export uses the current one.
 */
export function buildQuips(hist = {}, period = 'd30') {
  const stats = computeStats(hist, period);
  const t = stats.totals;
  const newTok = t.input + t.output;
  const out = [];
  const fmt1 = (v) => (v >= 10 ? String(Math.round(v)) : v.toFixed(1));
  if (newTok >= 300000) out.push(['quipNovels', fmt1(newTok / 300000)]);
  if (t.output >= 1000) out.push(['quipPages', String(Math.round(t.output / 500))]);
  if (t.output >= 2400) out.push(['quipTyping', fmt1(t.output / 40 / 60)]);
  if (t.input + t.cache_read >= 20000) out.push(['quipReading', fmt1((t.input + t.cache_read) / 330 / 60)]);
  if (t.input + t.cache_read > 0 && stats.raw.cacheRate >= 0.3) out.push(['quipCache', String(Math.round(stats.raw.cacheRate * 100))]);
  if (stats.raw.callsPerConv >= 2) out.push(['quipCombo', fmt1(stats.raw.callsPerConv)]);
  const daily = periodSlice(cleanDaily(hist && hist.daily), period);
  if (daily.length > 1) {
    const top = daily.reduce((m, d) => (d.tokens > m.tokens ? d : m), daily[0]);
    if (top.tokens > 0) out.push(['quipBusiest', top.date.slice(5), fmtTok(top.tokens)]);
  }
  if (isNum(t.est_cost_usd) && t.est_cost_usd >= 4) out.push(['quipCoffee', String(Math.round(t.est_cost_usd / 4))]);
  if (stats.raw.powPctPerWeek !== null && stats.raw.powPctPerWeek >= 1) out.push(['quipQuota', String(Math.round(stats.raw.powPctPerWeek))]);
  if (stats.raw.models >= 2) out.push(['quipModels', String(stats.raw.models)]);
  if (period !== 'today' && stats.raw.activeDays > 0) out.push(['quipDays', String(stats.raw.days), String(stats.raw.activeDays)]);
  if (!out.length) out.push(['quipFallback']);
  return out;
}

// --- nickname -----------------------------------------------------------------------------

export const NICK_MAX = 8;

/** Letters, digits, CJK, space, `_` and `-` only, max 8 characters: paths, emails and markup cannot survive. */
export function sanitizeNickname(raw) {
  const s = String(raw ?? '').normalize('NFKC');
  if (/@|:\/\/|[\\/]/.test(s)) return '';
  const kept = [...s].filter((ch) => /[\p{L}\p{N} _-]/u.test(ch)).join('').replace(/\s+/g, ' ').trim();
  return [...kept].slice(0, NICK_MAX).join('');
}
