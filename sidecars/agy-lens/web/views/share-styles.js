// Pure-Node multi-style SVG art poster builders, input sanitizer, and style metadata.
// Zero browser globals; imports only i18n.js and format.js so bundleWebApp stays acyclic.

import { createTranslator, normalizeLang } from '../i18n.js';
import { dayKey, fmtCost, fmtInt, fmtPctNum, fmtTok, isNum, makeHeatScale, parseDay } from '../format.js';

export const VALID_PERIODS = new Set(['today', 'd7', 'd30', 'all']);
export const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export const FONT_DISPLAY = "'Palatino Linotype', 'Palatino', 'Baskerville', 'Book Antiqua', 'Noto Serif SC', 'Source Han Serif SC', 'Songti SC', Georgia, serif";
export const FONT_SERIF = "'Noto Serif SC', 'Source Han Serif SC', 'Songti SC', 'STSong', 'Palatino Linotype', Georgia, serif";
export const FONT_SANS = "'PingFang SC', 'Noto Sans SC', 'Hiragino Sans GB', 'Segoe UI', 'Microsoft YaHei UI', 'Microsoft YaHei', system-ui, sans-serif";
export const FONT_MONO = "'IBM Plex Mono', 'Cascadia Mono', 'SF Mono', Consolas, 'Noto Sans SC', 'PingFang SC', 'Microsoft YaHei UI', monospace";

export const SHARE_STYLE_SPECS = {
  mountain: {
    id: 'mountain',
    width: 760,
    height: 950,
    aspectRatio: '760 / 950',
    supportsTheme: true,
    supportsQuip: true,
    supportsRole: false,
    animated: true,
    frameCount: 24,
    delayCs: 10,
    gifScale: 0.75,
    dither: 'floyd',
  },
  abyssal: {
    id: 'abyssal',
    width: 760,
    height: 950,
    aspectRatio: '760 / 950',
    supportsTheme: true,
    supportsQuip: true,
    supportsRole: false,
    animated: true,
    frameCount: 24,
    delayCs: 10,
    gifScale: 0.75,
    dither: 'floyd',
  },
  eclipse: {
    id: 'eclipse',
    width: 760,
    height: 950,
    aspectRatio: '760 / 950',
    supportsTheme: true,
    supportsQuip: true,
    supportsRole: false,
    animated: true,
    frameCount: 24,
    delayCs: 10,
    gifScale: 0.75,
    dither: 'floyd',
  },
  bauhaus: {
    id: 'bauhaus',
    width: 760,
    height: 950,
    aspectRatio: '760 / 950',
    supportsTheme: true,
    supportsQuip: true,
    supportsRole: false,
    animated: true,
    frameCount: 24,
    delayCs: 10,
    gifScale: 0.75,
    dither: 'floyd',
  },
  phosphor: {
    id: 'phosphor',
    width: 760,
    height: 950,
    aspectRatio: '760 / 950',
    supportsTheme: true,
    supportsQuip: true,
    supportsRole: false,
    animated: true,
    frameCount: 24,
    delayCs: 10,
    gifScale: 0.75,
    dither: 'floyd',
  },
  'pixel-role': {
    id: 'pixel-role',
    width: 1200,
    height: 630,
    aspectRatio: '1200 / 630',
    supportsTheme: true,
    supportsQuip: false,
    supportsRole: true,
    animated: true,
    frameCount: 24,
    delayCs: 12,
    gifScale: 2,
    dither: 'none',
  },
};

export function safeNum(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}

export function escapeXml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

const UNIX_ROOT_DIRS = 'Users|home|var|tmp|etc|opt|mnt|Volumes|private|root|srv|usr|lib|proc|sys|run|media';
const LOCAL_URI_SCHEME_SRC = `(?:(?:[a-zA-Z0-9+.-]+-)?file:\\/\\/|(?:vscode|cursor|agy|windsurf)(?:-[a-zA-Z0-9+.-]+)?:\\/\\/|(?!https?:|ftps?:|wss?:)[a-zA-Z][a-zA-Z0-9+.-]*:\\/\\/\\/)`;
const LOCAL_URI_SCHEME_RE = new RegExp(`^${LOCAL_URI_SCHEME_SRC}`, 'i');
const TOKEN_START_RE = new RegExp([
  `(?<![A-Za-z0-9+.-])${LOCAL_URI_SCHEME_SRC}(?=[^\\s\\r\\n"'<>,;|\\\`])`,
  `(?<![A-Za-z0-9+.-])[a-zA-Z][a-zA-Z0-9+.-]*:\\/\\/(?=[^\\s\\r\\n"'<>,;|\\\`?#])`,
  `[A-Za-z]:\\\\`,
  `(?<![A-Za-z])[A-Za-z]:\\/(?!\\/)`,
  `\\\\\\\\(?:[A-Za-z0-9._-]+|\\?)\\\\`,
  `(?<![:/])\\/\\/[A-Za-z0-9._-]+\\/`,
  `\\/(?:${UNIX_ROOT_DIRS})\\/`,
].join('|'), 'gi');

const PATH_HARD_STOP_RE = /[\r\n"'<>,;|`]/;
const URL_STOP_RE = /[\s\r\n"'<>,;|`?#]/;
const PATH_PAREN_STOP_FOLLOWER_RE = /[ \t\r\n"'<>,;|`).\]!,?]/;
const PATH_NEXT_TOKEN_RE = new RegExp([
  `[a-zA-Z][a-zA-Z0-9+.-]*:\\/\\/`,
  `[A-Za-z]:(?:\\\\|\\/(?!\\/))`,
  `\\\\\\\\`,
  `\\/\\/[A-Za-z0-9._-]+\\/`,
  `\\/(?:${UNIX_ROOT_DIRS})\\/`,
  `[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}(?![\\\\\\/A-Za-z0-9._-])`,
].join('|'), 'iy');

function consumeUrlEnd(s, start) {
  const n = s.length;
  let innerParen = 0;
  let innerBracket = 0;
  let i = start;
  while (i < n) {
    const ch = s[i];
    if (URL_STOP_RE.test(ch)) break;
    if (/[A-Za-z]/.test(ch) && s[i + 1] === ':' && s[i + 2] === '\\') break;
    if (ch === '\\' && s[i + 1] === '\\') break;
    if (ch === '(') {
      innerParen += 1;
      i += 1;
      continue;
    }
    if (ch === ')') {
      if (innerParen > 0) {
        innerParen -= 1;
        i += 1;
        continue;
      }
      break;
    }
    if (ch === '[') {
      innerBracket += 1;
      i += 1;
      continue;
    }
    if (ch === ']') {
      if (innerBracket > 0) {
        innerBracket -= 1;
        i += 1;
        continue;
      }
      break;
    }
    i += 1;
  }
  return { end: i, innerParen, innerBracket };
}

function consumePathEnd(s, start, outerParen, outerBracket) {
  const n = s.length;
  let innerParen = 0;
  let innerBracket = 0;
  let sepSeg = null;
  let parenSeg = null;
  let bracketSeg = null;

  const scanSegment = (from, openCh, closeCh, trackDelims) => {
    let k = from;
    const seps = [];
    let depth = 0;
    let lastUnmatchedClose = -1;
    while (k < n) {
      const c = s[k];
      if (PATH_HARD_STOP_RE.test(c)) break;
      if (c === '\\' || c === '/') {
        seps.push(k);
      } else if (trackDelims) {
        if (c === openCh) depth += 1;
        else if (c === closeCh) {
          if (depth > 0) depth -= 1;
          else lastUnmatchedClose = k;
        }
      }
      if (c === ' ' || c === '\t') {
        let j = k + 1;
        while (j < n && (s[j] === ' ' || s[j] === '\t')) j += 1;
        if (j >= n || PATH_HARD_STOP_RE.test(s[j])) break;
        let probe = j;
        while (probe < n && (s[probe] === '(' || s[probe] === '[')) probe += 1;
        PATH_NEXT_TOKEN_RE.lastIndex = probe;
        if (PATH_NEXT_TOKEN_RE.test(s)) break;
        k = j;
        continue;
      }
      k += 1;
    }
    return { start: from, end: k, seps, lastUnmatchedClose, sepCursor: 0 };
  };

  const hasSeparatorInSameSegment = (from) => {
    if (!sepSeg || from < sepSeg.start || from >= sepSeg.end) {
      sepSeg = scanSegment(from, '', '', false);
    }
    return sepSeg.seps.length > 0 && sepSeg.seps[sepSeg.seps.length - 1] >= from;
  };

  const hasOuterCloseAfterSep = (from, isParen) => {
    let seg = isParen ? parenSeg : bracketSeg;
    if (!seg || from < seg.start || from >= seg.end) {
      seg = scanSegment(from, isParen ? '(' : '[', isParen ? ')' : ']', true);
      if (isParen) parenSeg = seg;
      else bracketSeg = seg;
    }
    if (seg.lastUnmatchedClose === -1 || !seg.seps.length) return false;
    if (seg.sepCursor > 0 && seg.seps[seg.sepCursor - 1] >= from) seg.sepCursor = 0;
    while (seg.sepCursor < seg.seps.length && seg.seps[seg.sepCursor] < from) {
      seg.sepCursor += 1;
    }
    if (seg.sepCursor >= seg.seps.length) return false;
    return seg.lastUnmatchedClose > seg.seps[seg.sepCursor];
  };

  const shouldStopOnCloseDelim = (idx, outerCount, isParen) => {
    if (idx + 1 >= n) return true;
    const nextCh = s[idx + 1];
    if (PATH_HARD_STOP_RE.test(nextCh)) return true;
    if (outerCount > 0) {
      return !hasOuterCloseAfterSep(idx + 1, isParen);
    }
    if (!PATH_PAREN_STOP_FOLLOWER_RE.test(nextCh)) return false;
    return !hasSeparatorInSameSegment(idx + 1);
  };

  let i = start;
  while (i < n) {
    const ch = s[i];
    if (PATH_HARD_STOP_RE.test(ch)) break;
    if (ch === '(') {
      innerParen += 1;
      i += 1;
      continue;
    }
    if (ch === ')') {
      if (innerParen > 0) {
        innerParen -= 1;
        i += 1;
        continue;
      }
      if (shouldStopOnCloseDelim(i, outerParen, true)) break;
      i += 1;
      continue;
    }
    if (ch === '[') {
      innerBracket += 1;
      i += 1;
      continue;
    }
    if (ch === ']') {
      if (innerBracket > 0) {
        innerBracket -= 1;
        i += 1;
        continue;
      }
      if (shouldStopOnCloseDelim(i, outerBracket, false)) break;
      i += 1;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      let j = i + 1;
      while (j < n && (s[j] === ' ' || s[j] === '\t')) j += 1;
      if (j >= n || PATH_HARD_STOP_RE.test(s[j])) break;
      if (s[j] === ')' && innerParen === 0 && shouldStopOnCloseDelim(j, outerParen, true)) break;
      if (s[j] === ']' && innerBracket === 0 && shouldStopOnCloseDelim(j, outerBracket, false)) break;
      PATH_NEXT_TOKEN_RE.lastIndex = j;
      const nextTok = PATH_NEXT_TOKEN_RE.exec(s);
      if (nextTok) {
        if (!nextTok[0].includes('@') || !hasSeparatorInSameSegment(j + nextTok[0].length)) {
          break;
        }
      }
      i = j;
      continue;
    }
    i += 1;
  }
  return i;
}

export function scrubSensitiveText(raw) {
  const s = String(raw ?? '').replace(/[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F ]+/g, ' ');
  let out = '';
  let pos = 0;
  let parenDepth = 0;
  let bracketDepth = 0;

  const advanceDelims = (from, to) => {
    for (let k = from; k < to; k += 1) {
      const ch = s[k];
      if (PATH_HARD_STOP_RE.test(ch)) {
        parenDepth = 0;
        bracketDepth = 0;
      } else if (ch === '(') {
        parenDepth += 1;
      } else if (ch === ')') {
        if (parenDepth > 0) parenDepth -= 1;
      } else if (ch === '[') {
        bracketDepth += 1;
      } else if (ch === ']') {
        if (bracketDepth > 0) bracketDepth -= 1;
      }
    }
  };

  TOKEN_START_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_START_RE.exec(s)) !== null) {
    const matchStart = m.index;
    const matchText = m[0];
    advanceDelims(pos, matchStart);
    out += s.slice(pos, matchStart);

    if (!LOCAL_URI_SCHEME_RE.test(matchText) && /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(matchText)) {
      const { end, innerParen, innerBracket } = consumeUrlEnd(s, matchStart + matchText.length);
      out += s.slice(matchStart, end);
      parenDepth += innerParen;
      bracketDepth += innerBracket;
      pos = end;
      TOKEN_START_RE.lastIndex = end;
    } else {
      const end = consumePathEnd(s, matchStart + matchText.length, parenDepth, bracketDepth);
      out += '[path]';
      pos = end;
      TOKEN_START_RE.lastIndex = end;
    }
  }
  out += s.slice(pos);
  out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[redacted]');
  return out.replace(/\s+/g, ' ').trim();
}

export function truncateLabel(s, maxChars = 30) {
  const chars = Array.from(String(s || ''));
  if (chars.length <= maxChars) return chars.join('');
  return `${chars.slice(0, Math.max(1, maxChars - 1)).join('')}…`;
}

function charVisualUnits(ch) {
  if (/[\u2e80-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch)) return 1.85;
  if (/[MW]/.test(ch)) return 1.35;
  if (/[A-Z]/.test(ch)) return 1.15;
  return 1.0;
}

export function textVisualUnits(s) {
  let total = 0;
  for (const ch of String(s || '')) total += charVisualUnits(ch);
  return total;
}

export function truncateByWidth(s, maxUnits = 26) {
  const chars = Array.from(String(s || ''));
  let total = 0;
  for (let i = 0; i < chars.length; i += 1) total += charVisualUnits(chars[i]);
  if (total <= maxUnits) return chars.join('');
  let acc = 0;
  const out = [];
  const limit = Math.max(1, maxUnits - 1.1);
  for (let i = 0; i < chars.length; i += 1) {
    const w = charVisualUnits(chars[i]);
    if (acc + w > limit) break;
    out.push(chars[i]);
    acc += w;
  }
  return out.length ? `${out.join('')}…` : (chars[0] || '');
}

/** Resolve a buildQuips() entry to text. */
export function quipText(entry, lang) {
  if (!Array.isArray(entry) || !entry.length) return '';
  const t = createTranslator(normalizeLang(lang));
  return String(t(entry[0], ...entry.slice(1)));
}

export function sanitizeModels(rawList, fallbackName, periodKey = null) {
  const map = new Map();
  for (const m of Array.isArray(rawList) ? rawList : []) {
    if (!m || typeof m !== 'object') continue;
    const hasSlice = Boolean(periodKey && m.periods && typeof m.periods === 'object' && m.periods[periodKey] && typeof m.periods[periodKey] === 'object');
    const slice = hasSlice ? m.periods[periodKey] : m;
    const inp = safeNum(slice.input);
    const out = safeNum(slice.output);
    const cacheRead = safeNum(slice.cache_read);
    const calls = safeNum(slice.calls);
    if (hasSlice && calls <= 0 && inp + out + cacheRead <= 0) continue;

    const rawName = m.display_name || m.model || fallbackName;
    const cleaned = truncateLabel(scrubSensitiveText(rawName) || fallbackName, 38);
    let g = map.get(cleaned);
    if (!g) {
      g = {
        name: cleaned,
        input: 0,
        output: 0,
        cache_read: 0,
        calls: 0,
        est_cost_usd: null,
        cost_estimated: false,
        cost_partial: false,
      };
      map.set(cleaned, g);
    }
    g.input += inp;
    g.output += out;
    g.cache_read += cacheRead;
    g.calls += calls;
    const hasSliceCost = Object.prototype.hasOwnProperty.call(slice, 'est_cost_usd');
    const costVal = hasSliceCost ? slice.est_cost_usd : ((!hasSlice || periodKey === 'all') ? m.est_cost_usd : null);
    if (isNum(costVal) && costVal >= 0) {
      g.est_cost_usd = (g.est_cost_usd || 0) + costVal;
    } else if (calls > 0) {
      g.cost_partial = true;
    }
    const estFlag = Object.prototype.hasOwnProperty.call(slice, 'cost_estimated') ? slice.cost_estimated : m.cost_estimated;
    const partFlag = Object.prototype.hasOwnProperty.call(slice, 'cost_partial') ? slice.cost_partial : m.cost_partial;
    if (estFlag) g.cost_estimated = true;
    if (partFlag) g.cost_partial = true;
  }
  return [...map.values()].sort((a, b) => (
    (b.input + b.output) - (a.input + a.output)
    || (b.cache_read - a.cache_read)
    || (b.calls - a.calls)
  ));
}

export function sanitizeDaily(rawDaily) {
  const out = [];
  for (const d of Array.isArray(rawDaily) ? rawDaily : []) {
    if (!d || typeof d !== 'object') continue;
    const date = typeof d.date === 'string' && ISO_DAY_RE.test(d.date.trim()) ? d.date.trim() : '';
    if (!date) continue;
    out.push({
      date,
      tokens: safeNum(d.tokens),
      calls: safeNum(d.calls),
    });
  }
  return out;
}

export function sanitizeHourly(rawHourly) {
  if (!Array.isArray(rawHourly) || !rawHourly.length) return null;
  const slots = Array.from({ length: 24 }, (_, hour) => ({ hour, tokens: 0, calls: 0 }));
  let validCount = 0;
  for (const h of rawHourly) {
    if (!h || typeof h !== 'object') continue;
    const hr = Number(h.hour);
    if (!Number.isInteger(hr) || hr < 0 || hr > 23) continue;
    slots[hr].tokens += safeNum(h.tokens);
    slots[hr].calls += safeNum(h.calls);
    validCount += 1;
  }
  return validCount > 0 ? slots : null;
}

const MONTH_ABBR_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatMonthLabel(dateObj, lang) {
  const m = dateObj.getMonth();
  return lang === 'zh' ? `${m + 1}月` : MONTH_ABBR_EN[m];
}

export function formatDayTick(dateStr, t, lang) {
  const dt = parseDay(dateStr);
  if (Number.isNaN(dt.getTime())) return dateStr.slice(5);
  const wd = t('weekdays');
  const w = wd[dt.getDay()] || '';
  return lang === 'zh' ? `周${w} ${dt.getDate()}` : `${w} ${dt.getDate()}`;
}

function resolveHourFromInput(src) {
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

function normalizePhase(raw) {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw === 0) return 0;
  return ((raw % 1) + 1) % 1;
}

function sanitizeNumberMap(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    const cleanKey = truncateLabel(scrubSensitiveText(k), 24);
    if (!cleanKey) continue;
    if (isNum(v) && v >= 0) out[cleanKey] = v;
  }
  return out;
}

function sanitizePeriodQuota(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const pk of VALID_PERIODS) {
    const pObj = raw[pk];
    if (!pObj || typeof pObj !== 'object' || Array.isArray(pObj)) continue;
    const cleanPools = {};
    for (const [poolKey, entry] of Object.entries(pObj)) {
      const cleanPool = truncateLabel(scrubSensitiveText(poolKey), 24);
      if (!cleanPool || !entry || typeof entry !== 'object') continue;
      cleanPools[cleanPool] = {
        pct: safeNum(entry.pct),
        observed_pct: isNum(entry.observed_pct) ? safeNum(entry.observed_pct) : null,
      };
    }
    out[pk] = cleanPools;
  }
  return out;
}

function buildActivitySeries({ periodKey, dailySlice, hourlyToday, activeDailyCount, t, normLang }) {
  if (periodKey === 'today') {
    const slots = hourlyToday || Array.from({ length: 24 }, (_, hour) => ({ hour, tokens: 0, calls: 0 }));
    const values = slots.map((h) => safeNum(h.tokens));
    const activeHours = slots.filter((h) => h.tokens > 0 || h.calls > 0).length;
    const activeSummary = hourlyToday ? t('activeHours', activeHours) : t('activeToday', activeDailyCount > 0);
    let maxTok = 0;
    let peakIdx = 0;
    values.forEach((v, i) => { if (v >= maxTok && v > 0) { maxTok = v; peakIdx = i; } });
    return {
      values,
      labels: slots.map((h) => `${String(h.hour).padStart(2, '0')}:00`),
      axisTicks: [
        { pos: 0, label: '00:00' },
        { pos: 6 / 23, label: '06:00' },
        { pos: 12 / 23, label: '12:00' },
        { pos: 18 / 23, label: '18:00' },
        { pos: 1, label: '23:00' },
      ],
      maxTok,
      peakIdx,
      peakRatioX: maxTok > 0 ? peakIdx / 23 : 0.65,
      peakLabel: maxTok > 0 ? `${String(peakIdx).padStart(2, '0')}:00` : '',
      activeSummary,
      activeCount: activeHours,
      allCal: null,
    };
  }

  if (periodKey === 'd7') {
    const bars = dailySlice.slice(-7);
    const values = bars.map((d) => safeNum(d.tokens));
    let maxTok = 0;
    let peakIdx = 0;
    values.forEach((v, i) => { if (v >= maxTok && v > 0) { maxTok = v; peakIdx = i; } });
    const axisTicks = bars.map((d, i) => ({
      pos: bars.length > 1 ? i / (bars.length - 1) : 0.5,
      label: formatDayTick(d.date, t, normLang),
    }));
    return {
      values,
      labels: bars.map((d) => formatDayTick(d.date, t, normLang)),
      axisTicks,
      maxTok,
      peakIdx,
      peakRatioX: bars.length > 1 ? peakIdx / (bars.length - 1) : 0.65,
      peakLabel: bars[peakIdx] && maxTok > 0 ? formatDayTick(bars[peakIdx].date, t, normLang) : '',
      activeSummary: t('activeDaysOf', activeDailyCount, Math.max(1, bars.length)),
      activeCount: activeDailyCount,
      allCal: null,
    };
  }

  if (periodKey === 'all' && dailySlice.length >= 14) {
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
      const weekLabels = new Array(weeks).fill('');
      let activeDaysInRange = 0;
      for (let i = 0; i < weeks * 7; i += 1) {
        const dt = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
        days.push(dt);
        const w = Math.floor(i / 7);
        if (i % 7 === 0) weekLabels[w] = dayKey(dt).slice(5);
        if (dt <= end) {
          const e = byDay.get(dayKey(dt));
          if (e) {
            if (e.tokens > 0 || e.calls > 0) activeDaysInRange += 1;
            weekTotals[w] += safeNum(e.tokens);
          }
        }
      }
      let maxTok = 0;
      let peakIdx = 0;
      weekTotals.forEach((v, i) => { if (v >= maxTok && v > 0) { maxTok = v; peakIdx = i; } });
      const midIdx = Math.floor((weeks - 1) / 2);
      const axisTicks = weeks >= 3
        ? [
          { pos: 0, label: weekLabels[0] },
          { pos: midIdx / (weeks - 1), label: weekLabels[midIdx] },
          { pos: 1, label: dailySlice[dailySlice.length - 1].date.slice(5) },
        ]
        : [{ pos: 0.5, label: dailySlice[dailySlice.length - 1].date.slice(5) }];
      return {
        values: weekTotals,
        labels: weekLabels,
        axisTicks,
        maxTok,
        peakIdx,
        peakRatioX: weeks > 1 ? peakIdx / (weeks - 1) : 0.65,
        peakLabel: maxTok > 0 ? (weekLabels[peakIdx] || (normLang === 'zh' ? '周峰值' : 'PEAK WK')) : '',
        activeSummary: t('activeDays', activeDaysInRange, weeks),
        activeCount: activeDaysInRange,
        allCal: { days, end, weeks, byDay },
      };
    }
  }

  const bars = periodKey === 'd30' ? dailySlice.slice(-30) : dailySlice;
  const values = bars.map((d) => safeNum(d.tokens));
  let maxTok = 0;
  let peakIdx = 0;
  values.forEach((v, i) => { if (v >= maxTok && v > 0) { maxTok = v; peakIdx = i; } });
  const axisTicks = [];
  if (bars.length === 1) {
    axisTicks.push({ pos: 0.5, label: bars[0].date.slice(5) });
  } else if (bars.length >= 2) {
    axisTicks.push({ pos: 0, label: bars[0].date.slice(5) });
    if (bars.length >= 7) {
      const mid = Math.floor((bars.length - 1) / 2);
      axisTicks.push({ pos: mid / (bars.length - 1), label: bars[mid].date.slice(5) });
    }
    axisTicks.push({ pos: 1, label: bars[bars.length - 1].date.slice(5) });
  }
  return {
    values,
    labels: bars.map((d) => d.date.slice(5)),
    axisTicks,
    maxTok,
    peakIdx,
    peakRatioX: bars.length > 1 ? peakIdx / (bars.length - 1) : 0.68,
    peakLabel: bars[peakIdx] && maxTok > 0 ? bars[peakIdx].date.slice(5) : '',
    activeSummary: t('activeDaysOf', activeDailyCount, Math.max(1, dailySlice.length)),
    activeCount: activeDailyCount,
    allCal: null,
  };
}

/** Strict allowlist extractor & sanitizer for all vector share cards. */
export function sanitizeShareCardInput(input = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const periodKey = VALID_PERIODS.has(src.period) ? src.period : 'd30';
  const normLang = normalizeLang(src.lang);
  const t = createTranslator(normLang);
  const theme = src.theme === 'light' ? 'light' : 'dark';
  const hour = resolveHourFromInput(src);
  const webglCutout = Boolean(src.webglCutout);

  const rawTotals = src.totals && typeof src.totals === 'object' ? src.totals : {};
  const bucket = rawTotals[periodKey] && typeof rawTotals[periodKey] === 'object'
    ? rawTotals[periodKey]
    : (('input' in rawTotals || 'output' in rawTotals || 'calls' in rawTotals || 'conversations' in rawTotals) ? rawTotals : {});

  const inp = safeNum(bucket.input);
  const out = safeNum(bucket.output);
  const cache = safeNum(bucket.cache_read);
  const thinking = safeNum(bucket.thinking);
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

  const sanitizedModels = sanitizeModels(rawByModel, t('unknown'), periodKey)
    .filter((m) => m.input + m.output + m.cache_read > 0 || m.calls > 0);
  const sumNew = sanitizedModels.reduce((acc, m) => acc + m.input + m.output, 0);
  const models = sanitizedModels.map((m) => {
    const newTok = m.input + m.output;
    return {
      ...m,
      newTok,
      sharePct: sumNew > 0 ? (newTok / sumNew) * 100 : 0,
    };
  });

  const costPartial = Boolean(bucket.cost_partial)
    || (periodKey === 'all' && rawByModel.some((m) => m && safeNum(m.calls) > 0 && !isNum(m.est_cost_usd)));
  const costVal = isNum(bucket.est_cost_usd) && bucket.est_cost_usd >= 0 ? bucket.est_cost_usd : null;
  const costStr = costVal !== null
    ? fmtCost(costVal, { estimated: Boolean(bucket.cost_estimated), partial: costPartial })
    : '—';

  const dailyAll = sanitizeDaily(src.daily);
  let dailySlice = dailyAll;
  if (periodKey === 'today') dailySlice = dailyAll.slice(-1);
  else if (periodKey === 'd7') dailySlice = dailyAll.slice(-7);
  else if (periodKey === 'd30') dailySlice = dailyAll.slice(-30);

  let spanStr = '';
  if (dailySlice.length === 1) spanStr = dailySlice[0].date;
  else if (dailySlice.length > 1) spanStr = `${dailySlice[0].date} – ${dailySlice[dailySlice.length - 1].date}`;

  const hourlyToday = sanitizeHourly(src.hourlyToday ?? src.hourly_today);
  const activeDailyCount = dailySlice.filter((d) => d.tokens > 0 || d.calls > 0).length;

  const quipRaw = typeof src.quip === 'string' ? scrubSensitiveText(src.quip) : '';
  const quip = quipRaw ? truncateByWidth(quipRaw, 58) : '';

  const reuseRatio = cache > 0 && inp > 0 ? cache / inp : null;
  const reuseStr = reuseRatio !== null ? `×${reuseRatio.toFixed(1)}` : '—';

  let paceStr = '';
  if (periodKey !== 'today' && activeDailyCount > 0 && totalNew > 0) {
    const perDay = fmtTok(Math.round(totalNew / activeDailyCount));
    paceStr = normLang === 'zh' ? `日均 ${perDay}` : `${perDay}/DAY`;
  } else if (periodKey === 'today' && calls > 0 && totalNew > 0) {
    const perCall = fmtTok(Math.round(totalNew / calls));
    paceStr = normLang === 'zh' ? `均次 ${perCall}` : `${perCall}/CALL`;
  }

  const activity = buildActivitySeries({
    periodKey, dailySlice, hourlyToday, activeDailyCount, t, normLang,
  });

  return {
    periodKey,
    periodLabel: scrubSensitiveText(t('periods')[periodKey] || periodKey),
    normLang,
    t,
    theme,
    hour,
    webglCutout,
    quip,
    totals: {
      input: inp,
      output: out,
      cache_read: cache,
      thinking,
      calls,
      conversations: convs,
      totalNew,
      est_cost_usd: costVal,
      cost_estimated: Boolean(bucket.cost_estimated),
      cost_partial: costPartial,
      costStr,
      reuseRatio,
      reuseStr,
    },
    models,
    sumNew,
    dailyAll,
    dailySlice,
    hourlyToday,
    activeDailyCount,
    spanStr,
    paceStr,
    activity,
    d7ByPool: sanitizeNumberMap(src.d7ByPool ?? src.d7_by_pool),
    weeklyValueUsd: sanitizeNumberMap(src.weekly_value_usd),
    periodQuota: sanitizePeriodQuota(src.period_quota),
  };
}

// ============================================================================
// Shared Poster Geometry, Typography & Data-Curve Helpers (760 x 950)
// ============================================================================

function fitTextSize(str, baseSize, maxPx, minSize = 13, unitScale = 0.58) {
  const units = Math.max(1, textVisualUnits(str));
  const est = units * baseSize * unitScale;
  if (est <= maxPx) return baseSize;
  return Math.max(minSize, +((maxPx / (units * unitScale))).toFixed(1));
}

function posterHeroMetrics(totalNew, maxBase = 284) {
  const heroStr = fmtTok(totalNew);
  const len = heroStr.length;
  const scale = maxBase / 286;
  const raw = len <= 3 ? 302 : (len === 4 ? 286 : (len === 5 ? 226 : (len === 6 ? 178 : 146)));
  const maxPx = maxBase >= 260 ? 644 : 552;
  return {
    heroStr,
    heroSize: Math.round(fitTextSize(heroStr, Math.round(raw * scale), maxPx, 116, 0.58)),
  };
}

/** Extract a smooth normalized 24-sample usage curve + peak index from sanitized or raw input. */
export function extractNormalizedActivityCurve(inputOrSanitized = {}, sampleCount = 24) {
  const d = inputOrSanitized && inputOrSanitized.activity
    ? inputOrSanitized
    : sanitizeShareCardInput(inputOrSanitized);
  const vals = d.activity && Array.isArray(d.activity.values) ? d.activity.values : [];
  const n = Math.max(4, sampleCount);
  const maxVal = vals.reduce((m, v) => Math.max(m, safeNum(v)), 0);

  let raw;
  if (!vals.length || !(maxVal > 0)) {
    raw = Array.from({ length: n }, (_, i) => {
      const u = i / (n - 1);
      return 0.16 + Math.exp(-((u - 0.72) ** 2) / 0.032) * 0.72 + Math.sin(i * 0.65) * 0.06;
    });
  } else if (vals.length === 1) {
    raw = Array.from({ length: n }, (_, i) => {
      const u = i / (n - 1);
      return 0.14 + Math.exp(-((u - 0.68) ** 2) / 0.034) * 0.84;
    });
  } else {
    raw = Array.from({ length: n }, (_, i) => {
      const pos = (i / (n - 1)) * (vals.length - 1);
      const i0 = Math.floor(pos);
      const i1 = Math.min(vals.length - 1, i0 + 1);
      const f = pos - i0;
      const v = safeNum(vals[i0]) * (1 - f) + safeNum(vals[i1]) * f;
      return Math.pow(Math.max(0, Math.min(1, v / maxVal)), 0.78);
    });
  }

  const smoothed = raw.map((v, i) => {
    const a = raw[Math.max(0, i - 1)];
    const b = raw[Math.min(n - 1, i + 1)];
    return a * 0.22 + v * 0.56 + b * 0.22;
  });
  let hi = 0;
  let lo = 1;
  let peakSampleIdx = 0;
  smoothed.forEach((v, i) => {
    if (v >= hi) { hi = v; peakSampleIdx = i; }
    if (v < lo) lo = v;
  });
  const span = Math.max(0.08, hi - lo);
  const curve = smoothed.map((v, i) => {
    const base = (v - lo) / span;
    const arch = 0.10 * Math.sin((i / (n - 1)) * Math.PI);
    return Math.max(0.06, Math.min(1, base * 0.88 + arch + 0.04));
  });
  return { curve, peakSampleIdx, hasData: maxVal > 0 };
}

function cragSubdivide(pts, { amp = 9, seed = 1.7, octaves = 3, yMin = 150, yMax = 880, lockIdx = -1 } = {}) {
  if (!pts.length) return [];
  let cur = pts.map((p) => ({ x: p.x, y: Math.max(yMin, Math.min(yMax, p.y)) }));
  const lockX = lockIdx >= 0 && lockIdx < cur.length ? cur[lockIdx].x : -999;
  const lockY = lockIdx >= 0 && lockIdx < cur.length ? cur[lockIdx].y : 0;
  for (let oct = 0; oct < octaves; oct += 1) {
    const sAmp = amp * (0.54 ** oct);
    const next = [];
    for (let i = 0; i < cur.length - 1; i += 1) {
      const a = cur[i];
      const b = cur[i + 1];
      next.push(a);
      const mx = (a.x + b.x) * 0.5;
      const my0 = (a.y + b.y) * 0.5;
      const h = Math.sin(mx * 0.045 * (oct + 1) + seed * (1.6 + oct) + i * 0.85) * 0.62
        + Math.cos(mx * 0.105 * (oct + 1) - seed * 2.1) * 0.38;
      let my = Math.max(yMin, Math.min(yMax, my0 + h * sAmp));
      if (lockX > -900 && Math.abs(mx - lockX) < 26) my = Math.max(lockY + 2, my);
      next.push({ x: mx, y: my });
    }
    next.push(cur[cur.length - 1]);
    cur = next;
  }
  return cur;
}

function closedAreaPath(pts, bottomY) {
  if (!pts.length) return '';
  const body = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join('');
  return `${body}L${pts[pts.length - 1].x.toFixed(1)} ${bottomY}L${pts[0].x.toFixed(1)} ${bottomY}Z`;
}

function smoothPolyLine(pts, dy = 0) {
  if (pts.length < 2) return '';
  let d = `M${pts[0].x.toFixed(1)} ${(pts[0].y + dy).toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i += 1) {
    const a = pts[i];
    const b = pts[i + 1];
    const mx = ((a.x + b.x) * 0.5).toFixed(1);
    const my = (((a.y + b.y) * 0.5) + dy).toFixed(1);
    d += `Q${a.x.toFixed(1)} ${(a.y + dy).toFixed(1)} ${mx} ${my}`;
  }
  const last = pts[pts.length - 1];
  return `${d}L${last.x.toFixed(1)} ${(last.y + dy).toFixed(1)}`;
}

function svgTxt(x, y, text, {
  size = 14,
  fill = '#f5efe2',
  weight = 400,
  anchor = 'start',
  font = FONT_SANS,
  num = false,
  ls = null,
  italic = false,
  opacity = null,
  filter = null,
  extra = '',
} = {}) {
  return `<text x="${x}" y="${y}" font-family="${font}" font-size="${size}" font-weight="${weight}" fill="${fill}"${italic ? ' font-style="italic"' : ''}${anchor !== 'start' ? ` text-anchor="${anchor}"` : ''}${ls ? ` letter-spacing="${ls}"` : ''}${opacity != null ? ` fill-opacity="${opacity}"` : ''}${filter ? ` filter="url(#${filter})"` : ''}${num ? ' style="font-variant-numeric:tabular-nums lining-nums"' : ''}${extra}>${escapeXml(text)}</text>`;
}

function renderAllHeatmapSvg(allCal, {
  t,
  normLang,
  gridTop = 532,
  padL = 36,
  padR = 700,
  ruleCol = '#2a3d4f',
  mutedCol = '#8fa8bd',
  emptyCol = '#0c1c29',
  accentCol = '#4ee8f0',
  cellRx = 1.2,
} = {}) {
  if (!allCal) return '';
  const { days, end, weeks, byDay } = allCal;
  const level = makeHeatScale(days.filter((d) => d <= end).map((d) => safeNum((byDay.get(dayKey(d)) || {}).tokens)));
  let cell = 8.8;
  let gap = 2;
  let top = gridTop;
  if (weeks <= 30) {
    cell = 11.0;
    gap = 2.5;
    top = gridTop - 4;
  } else if (weeks <= 42) {
    cell = 10.0;
    gap = 2.3;
    top = gridTop - 2;
  }
  const gridH = 7 * cell + 6 * gap;
  const wdWidth = normLang === 'zh' ? 24 : 30;
  const gridX0 = padL + wdWidth;
  const wd = t('weekdays');
  let out = `<line x1="${padL}" y1="${(top - 7).toFixed(1)}" x2="${padR}" y2="${(top - 7).toFixed(1)}" stroke="${ruleCol}" stroke-opacity="0.65" stroke-width="0.75"/>`
    + `<line x1="${padL}" y1="${(top + gridH + 7).toFixed(1)}" x2="${padR}" y2="${(top + gridH + 7).toFixed(1)}" stroke="${ruleCol}" stroke-opacity="0.65" stroke-width="0.75"/>`;
  for (const r of [1, 3, 5]) {
    const cy = top + r * (cell + gap) + cell * 0.8;
    out += svgTxt(padL, cy.toFixed(1), wd[r] || '', { size: 11, fill: mutedCol, weight: 500, font: FONT_SANS });
  }
  const opacities = [0, 0.34, 0.56, 0.78, 1];
  days.forEach((d, i) => {
    if (d > end) return;
    const col = Math.floor(i / 7);
    const row = i % 7;
    const e = byDay.get(dayKey(d)) || { tokens: 0, calls: 0 };
    const lv = level(e.tokens);
    const x = gridX0 + col * (cell + gap);
    const y = top + row * (cell + gap);
    out += lv === 0
      ? `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${cell}" height="${cell}" rx="${cellRx}" fill="${emptyCol}"/>`
      : `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${cell}" height="${cell}" rx="${cellRx}" fill="${accentCol}" fill-opacity="${opacities[lv]}"/>`;
  });

  const legCell = 8.5;
  const legGap = 3;
  const scaleW = 5 * legCell + 4 * legGap;
  const moreSpace = normLang === 'zh' ? 24 : 40;
  const scaleStartX = padR - moreSpace - scaleW;
  const legendLeftEdge = scaleStartX - (normLang === 'zh' ? 40 : 48);
  let lastLabelCol = -9;
  const minGap = weeks > 36 ? 5 : 3;
  const labelY = top + gridH + 22;
  for (let w = 0; w < weeks; w += 1) {
    const first = days[w * 7];
    const monthStart = days.slice(w * 7, w * 7 + 7).find((d) => d.getDate() === 1);
    const mx = gridX0 + w * (cell + gap);
    if ((w === 0 || monthStart) && w - lastLabelCol >= minGap && w <= weeks - 3 && mx + 28 < legendLeftEdge) {
      out += svgTxt(mx.toFixed(1), labelY.toFixed(1), formatMonthLabel(monthStart || first, normLang), { size: 11, fill: mutedCol, weight: 500, font: FONT_SANS });
      lastLabelCol = w;
    }
  }
  out += svgTxt((scaleStartX - 6).toFixed(1), labelY.toFixed(1), t('less'), { size: 11, fill: mutedCol, weight: 500, font: FONT_SANS, anchor: 'end' });
  for (let lv = 0; lv <= 4; lv += 1) {
    const lx = scaleStartX + lv * (legCell + legGap);
    out += lv === 0
      ? `<rect x="${lx.toFixed(1)}" y="${(labelY - 8).toFixed(1)}" width="${legCell}" height="${legCell}" rx="${cellRx}" fill="${emptyCol}"/>`
      : `<rect x="${lx.toFixed(1)}" y="${(labelY - 8).toFixed(1)}" width="${legCell}" height="${legCell}" rx="${cellRx}" fill="${accentCol}" fill-opacity="${opacities[lv]}"/>`;
  }
  out += svgTxt(padR, labelY.toFixed(1), t('more'), { size: 11, fill: mutedCol, weight: 500, font: FONT_SANS, anchor: 'end' });
  return out;
}

function renderAxisTicksSvg(activity, {
  y = 626,
  x0 = 36,
  x1 = 688,
  ruleCol = '#2b4357',
  mutedCol = '#8fa9bf',
  inkCol = '#eef6fa',
  accentCol = '#58f0ec',
  filter = null,
} = {}) {
  const ticks = (activity && activity.axisTicks) || [];
  const w = x1 - x0;
  let svg = `<line x1="${x0}" y1="${y}" x2="${x1}" y2="${y}" stroke="${ruleCol}" stroke-opacity="0.52" stroke-width="0.75"/>`;
  if (!ticks.length) return svg;
  if (ticks.length === 1) {
    const cx = x0 + 0.5 * w;
    svg += `<circle cx="${cx.toFixed(1)}" cy="${y}" r="2.6" fill="${accentCol}"/>`
      + svgTxt(cx.toFixed(1), y + 18, ticks[0].label, { size: 11.5, fill: inkCol, weight: 600, font: FONT_SANS, anchor: 'middle', num: true, filter });
    return svg;
  }
  if (activity.maxTok > 0) {
    const pkX = x0 + activity.peakRatioX * w;
    svg += `<circle cx="${pkX.toFixed(1)}" cy="${y}" r="2.6" fill="${accentCol}"/>`;
  }
  ticks.forEach((tk, idx) => {
    const tx = ticks.length >= 6
      ? x0 + 22 + tk.pos * (w - 44)
      : x0 + tk.pos * w;
    const isLast = idx === ticks.length - 1;
    const anchor = ticks.length >= 6 ? 'middle' : (idx === 0 ? 'start' : (isLast ? 'end' : 'middle'));
    svg += `<line x1="${tx.toFixed(1)}" y1="${y}" x2="${tx.toFixed(1)}" y2="${y + 4}" stroke="${mutedCol}" stroke-opacity="0.65" stroke-width="0.85"/>`
      + svgTxt(tx.toFixed(1), y + 18, tk.label, {
        size: 11.5,
        fill: isLast ? inkCol : mutedCol,
        weight: isLast ? 600 : 500,
        font: FONT_SANS,
        anchor,
        num: true,
        filter,
      });
  });
  return svg;
}

function renderSteppedCascadeSvg(d, {
  baseX = 36,
  baseY = 690,
  stepX = 24,
  pitchY = 40,
  font = FONT_DISPLAY,
  weight = 400,
  accentCol = '#58ede8',
  inkCol = '#f4f0e4',
  mutedCol = '#859eb0',
  subCol = '#cde0ec',
  rotateDeg = 0,
  rotateCx = 56,
  rotateCy = 800,
  compactPctOnly = false,
  maxNameUnits = 29.5,
  maxSpanPx = 560,
} = {}) {
  const { models, totals, normLang, t } = d;
  const top = models.slice(0, 4);
  const extra = Math.max(0, models.length - top.length);
  const few = top.length <= 3;
  const pitch = few ? pitchY + 6 : pitchY;
  const baseSz = few ? 26 : 22;

  if (!top.length) {
    const empty = svgTxt(baseX, baseY + 46, t('noModels'), { size: 19, fill: mutedCol, font: FONT_SERIF });
    return rotateDeg ? `<g transform="rotate(${rotateDeg} ${rotateCx} ${rotateCy})">${empty}</g>` : empty;
  }

  let rows = top.map((m, i) => {
    const rx = baseX + i * stepX;
    const ry = baseY + i * pitch;
    const mName = truncateByWidth(m.name, maxNameUnits);
    const share = fmtPctNum(m.sharePct);
    const metricTxt = compactPctOnly ? share : `${fmtTok(m.newTok)} · ${share}`;
    const idxStr = String(i + 1).padStart(2, '0');
    const dash = compactPctOnly ? ' ' : ' — ';
    const fullLine = `${idxStr} ${mName}${dash}${metricTxt}`;
    const rowAvailPx = Math.max(320, maxSpanPx - i * stepX * (rotateDeg ? 0.55 : 0.85));
    const sz = fitTextSize(fullLine, baseSz, rowAvailPx, 14.5, 0.53);
    return `<text x="${rx.toFixed(1)}" y="${ry.toFixed(1)}" font-family="${font}" font-size="${sz}" font-weight="${weight}" data-ledger-row="${i}" style="font-variant-numeric:tabular-nums lining-nums"><tspan fill="${accentCol}" font-size="${Math.round(sz * 0.78)}" letter-spacing="0.06em">${escapeXml(idxStr)} </tspan><tspan fill="${inkCol}">${escapeXml(mName)}</tspan><tspan fill="${mutedCol}">${escapeXml(dash)}</tspan><tspan fill="${subCol}">${escapeXml(metricTxt)}</tspan></text>`;
  }).join('\n  ');

  const subX = baseX + top.length * stepX + (rotateDeg ? 4 : 12);
  const subY = baseY + top.length * pitch - (few ? 8 : 4);
  const ioLine = normLang === 'zh'
    ? `输入 ${fmtTok(totals.input)} · 输出 ${fmtTok(totals.output)}${extra > 0 ? ` · ${t('shareMoreModels', extra)}` : ''}`
    : `IN ${fmtTok(totals.input)} · OUT ${fmtTok(totals.output)}${extra > 0 ? ` · ${t('shareMoreModels', extra)}` : ''}`;
  const ioSz = fitTextSize(ioLine, 12.5, 420, 10, 0.56);
  rows += `\n  ${svgTxt(subX.toFixed(1), subY.toFixed(1), ioLine, { size: ioSz, fill: subCol, weight: 500, font: FONT_SANS, ls: '0.04em', num: true })}`;

  return rotateDeg ? `<g transform="rotate(${rotateDeg} ${rotateCx} ${rotateCy})">\n  ${rows}\n</g>` : rows;
}

function renderCounterweightSvg(d, {
  rightX = 710,
  heroX = 622,
  heroY = 890,
  font = FONT_DISPLAY,
  heroWeight = 400,
  accentCol = '#5ef2ec',
  inkCol = '#f4f0e4',
  subCol = '#bfd4e2',
  stackTopOverride = null,
  stackBotOverride = null,
  stackedFullWidth = false,
} = {}) {
  const { totals, normLang } = d;
  const hasReuse = totals.reuseRatio !== null;
  const cwHero = hasReuse ? totals.reuseStr : fmtInt(totals.calls, normLang);
  const stackTop = hasReuse
    ? (stackTopOverride || (normLang === 'zh' ? '缓存' : 'CACHE'))
    : (normLang === 'zh' ? '总计' : 'TOTAL');
  const stackBot = hasReuse
    ? (stackBotOverride || (normLang === 'zh' ? '复用倍率' : 'REUSE'))
    : (normLang === 'zh' ? '调用' : 'CALLS');
  const cwMeta = normLang === 'zh'
    ? `${fmtTok(totals.cache_read)} 缓存 · ${fmtInt(totals.calls, normLang)} 次调用 · ${fmtInt(totals.conversations, normLang)} 对话`
    : `${fmtTok(totals.cache_read)} CACHE · ${fmtInt(totals.calls, normLang)} CALLS · ${fmtInt(totals.conversations, normLang)} CONVS`;
  const metaSz = fitTextSize(cwMeta, 12.5, 310, 10.5, 0.56);

  if (stackedFullWidth) {
    const heroSz = fitTextSize(cwHero, 68, 250, 34, 0.58);
    const labelLine = `${stackTop} ${stackBot}`;
    const labelSz = fitTextSize(labelLine, 30, 270, 18, 0.62);
    return `
  ${svgTxt(rightX, heroY - 38, cwHero, { size: heroSz, fill: accentCol, weight: heroWeight, font, anchor: 'end', ls: '-0.02em', num: true })}
  ${svgTxt(rightX, heroY - 4, labelLine, { size: labelSz, fill: inkCol, weight: heroWeight >= 700 ? 800 : 400, font, anchor: 'end', ls: normLang === 'zh' ? '0.08em' : '0.03em' })}
  ${svgTxt(rightX, 918, cwMeta, { size: metaSz, fill: subCol, weight: 500, font: FONT_SANS, anchor: 'end', ls: '0.03em', num: true })}`;
  }

  const cwSize = fitTextSize(cwHero, 68, 210, 30, 0.56);
  return `
  ${svgTxt(heroX, heroY, cwHero, { size: cwSize, fill: accentCol, weight: heroWeight, font, anchor: 'end', ls: '-0.02em', num: true })}
  ${svgTxt(heroX + 10, heroY - 25, stackTop, { size: 14.5, fill: inkCol, weight: 600, font: FONT_SANS, ls: '0.10em' })}
  ${svgTxt(heroX + 10, heroY - 5, stackBot, { size: 14.5, fill: inkCol, weight: 600, font: FONT_SANS, ls: '0.10em' })}
  ${svgTxt(rightX, 918, cwMeta, { size: metaSz, fill: subCol, weight: 500, font: FONT_SANS, anchor: 'end', ls: '0.03em', num: true })}`;
}

function renderPosterColophon(d, spineLabel, {
  padL = 36,
  mutedCol = '#6f8799',
  filter = null,
} = {}) {
  const spine = `${d.spanStr ? `${d.spanStr} · ` : ''}${spineLabel} · ${d.t('shareFooter')}`;
  const spineSz = fitTextSize(spine, 10.5, 856, 8.5, 0.58);
  return `
  ${svgTxt(padL, 926, 'github.com/Aoike123/agy-lens', { size: 11, fill: mutedCol, weight: 500, font: FONT_SANS, ls: '0.05em' })}
  <text x="742" y="926" transform="rotate(-90 742 926)" font-family="${FONT_SANS}" font-size="${spineSz}" font-weight="500" fill="${mutedCol}" letter-spacing="0.05em"${filter ? ` filter="url(#${filter})"` : ''}>${escapeXml(spine)}</text>`;
}

// ============================================================================
// 1. ABYSSAL · TRENCH (760 x 950) — Volumetric Caustics & Bathymetric Canyon
// ============================================================================

export function buildAbyssalCardSvg(input = {}, animPhase = 0) {
  const d = sanitizeShareCardInput(input);
  const { t, normLang, theme, totals, activity, paceStr, quip, webglCutout } = d;
  const copy = t('shareAbyssal');
  const W = 760;
  const H = 950;
  const PAD = 36;
  const RIGHT = 716;
  const isDark = theme !== 'light';
  const isAll = Boolean(activity.allCal);
  const phase = normalizePhase(animPhase);
  const rad = phase * Math.PI * 2;

  const pal = isDark ? {
    zenith: '#7af7f3',
    upperWater: '#128a9e',
    midWater: '#074056',
    deepWater: '#031927',
    floor: '#020810',
    heroInk: '#f5efe0',
    r0Top: '#135f75', r0Bot: '#092c3c',
    r1Top: '#0d465c', r1Bot: '#061f2e',
    r2Top: '#093448', r2Bot: '#041420',
    r3Top: '#072638', r3Bot: '#030d16',
    r4Top: '#041623', r4Bot: '#02070d',
    rim: '#66f7f0',
    contour: '#4ce8f2',
    whisper: '#c7ebeef0',
    waistSub: '#bfeaf0',
    waistInk: '#f7f3e8',
    costInk: 'url(#agy-aby-cost)',
    ink: '#f4f0e4',
    sub: '#bfdce6',
    muted: '#7da2b5',
    accent: '#63f3ed',
    rule: '#1f4458',
    emptyCell: '#081b28',
  } : {
    zenith: '#f2fcfd',
    upperWater: '#bee9f0',
    midWater: '#6ab4c8',
    deepWater: '#1c5368',
    floor: '#081b28',
    heroInk: '#0a212e',
    r0Top: '#88c5d4', r0Bot: '#5798ab',
    r1Top: '#317287', r1Bot: '#194557',
    r2Top: '#1d5368', r2Bot: '#0f3040',
    r3Top: '#133a4c', r3Bot: '#091f2c',
    r4Top: '#0b2533', r4Bot: '#05121b',
    rim: '#9ef9f5',
    contour: '#7beaf2',
    whisper: '#153a4a',
    waistSub: '#e8f9fb',
    waistInk: '#ffffff',
    costInk: 'url(#agy-aby-cost)',
    ink: '#f2f7fa',
    sub: '#c5dfe8',
    muted: '#84a8b8',
    accent: '#6ff2ee',
    rule: '#264d61',
    emptyCell: '#0d2635',
  };

  const { curve, peakSampleIdx } = extractNormalizedActivityCurve(d, 24);
  const { heroStr, heroSize } = posterHeroMetrics(totals.totalNew, 286);
  const heroY = heroSize >= 256 ? 334 : (heroStr.length >= 6 ? 320 : 328);

  // Distant seamount ridge behind 4.8M
  const p0Raw = curve.map((v, i) => {
    const u = i / (curve.length - 1);
    const spire = Math.exp(-((u - 0.16) ** 2) / 0.012) * 0.48 + Math.exp(-((u - 0.52) ** 2) / 0.014) * 0.55;
    return { x: -16 + u * (W + 32), y: 368 - (v * 0.25 + spire) * 68 };
  });
  const p0 = cragSubdivide(p0Raw, { amp: 11, seed: 2.1, octaves: 3, yMin: 274, yMax: 376 });

  // Subtle abyssal saddle resting beneath hero numerals without occluding right-hand digits/M
  const p1Raw = Array.from({ length: 18 }, (_, i) => {
    const u = i / 17;
    const x = -16 + u * (W + 32);
    if (u <= 0.90) {
      const cv = curve[Math.min(23, Math.round(u * 23))];
      const crag = Math.exp(-((u - 0.12) ** 2) / 0.008) * 18 + Math.exp(-((u - 0.53) ** 2) / 0.009) * 20;
      return { x, y: 350 - cv * 10 - crag };
    }
    const ru = (u - 0.90) / 0.10;
    return { x, y: 342 - (ru ** 1.1) * 58 };
  });
  const p1 = cragSubdivide(p1Raw, { amp: 9, seed: 3.4, octaves: 3, yMin: 280, yMax: 364 });

  // Midground V-trench canyon walls framing bioluminescent cauldron
  const p2Raw = Array.from({ length: 16 }, (_, i) => {
    const u = i / 15;
    const x = -16 + u * (W + 32);
    const vDip = Math.exp(-((u - 0.33) ** 2) / 0.022) * 95;
    const rightWall = u > 0.45 ? ((u - 0.45) / 0.55) * 118 : (0.45 - u) * 52;
    return { x, y: (isAll ? 476 : 492) + vDip * 0.55 - rightWall };
  });
  const p2 = cragSubdivide(p2Raw, { amp: 10, seed: 4.8, octaves: 3, yMin: 368, yMax: 556 });

  // Sovereign real-data bathymetric ridge
  const yBase3 = isAll ? 506 : 598;
  const amp3 = isAll ? 58 : 84;
  const corePts3 = curve.map((v, i) => ({
    x: PAD + (i / 23) * (688 - PAD),
    y: yBase3 - v * amp3,
  }));
  const p3 = cragSubdivide(
    [{ x: -16, y: corePts3[0].y + 12 }, ...corePts3, { x: W + 16, y: corePts3[23].y - 18 }],
    { amp: 5.5, seed: 6.2, octaves: 2, yMin: 416, yMax: yBase3 + 14, lockIdx: peakSampleIdx + 1 },
  );

  // Foreground abyssal trench walls descending into crisp dark floor
  const p4Raw = isAll
    ? [{ x: -16, y: 516 }, { x: 776, y: 516 }]
    : [
      { x: -16, y: 582 },
      { x: 146, y: 654 },
      { x: 278, y: 742 },
      { x: 420, y: 696 },
      { x: 590, y: 658 },
      { x: 776, y: 620 },
    ];
  const p4 = isAll ? p4Raw : cragSubdivide(p4Raw, { amp: 7, seed: 7.9, octaves: 2, yMin: 575, yMax: 760 });

  // Volumetric sunbeam shafts & bioluminescent specks for standalone SVG (!webglCutout)
  const beamAngles = [-0.46, -0.31, -0.18, -0.07, 0.04, 0.16, 0.28, 0.41];
  const beamsSvg = !webglCutout ? `<g filter="url(#agy-aby-beam-blur)">
    ${beamAngles.map((ang, idx) => {
      const sway = phase ? Math.sin(rad + idx * 0.9) * 0.022 : 0;
      const a = ang + sway;
      const spread = 0.036 + (idx % 3) * 0.014;
      const xTopL = 380 + Math.tan(a - spread * 0.45) * 40;
      const xTopR = 380 + Math.tan(a + spread * 0.45) * 40;
      const xBotL = 380 + Math.tan(a - spread) * 620;
      const xBotR = 380 + Math.tan(a + spread) * 620;
      const op = ((isDark ? 0.16 : 0.22) * (idx % 2 === 0 ? 1.15 : 0.78) * (phase ? 1 + 0.18 * Math.cos(rad + idx * 1.3) : 1)).toFixed(3);
      return `<polygon points="${xTopL.toFixed(1)},-20 ${xTopR.toFixed(1)},-20 ${xBotR.toFixed(1)},600 ${xBotL.toFixed(1)},600" fill="url(#agy-aby-beam)" fill-opacity="${op}"/>`;
    }).join('')}
  </g>` : '';

  // Organic foreshortened sea-surface refraction aperture swells for standalone SVG (!webglCutout) — zero bullseye rings
  const surfaceRipplesSvg = !webglCutout ? `<g opacity="${isDark ? '0.52' : '0.66'}" filter="url(#agy-aby-beam-blur)">
    <ellipse cx="380" cy="-6" rx="230" ry="38" fill="${pal.zenith}" fill-opacity="${isDark ? '0.52' : '0.78'}"/>
    <path d="M120 14Q250 32 380 18T640 16L680 0L80 0Z" fill="${pal.zenith}" fill-opacity="0.34"/>
    <path d="M175 32Q305 16 415 30T595 24" fill="none" stroke="${isDark ? pal.zenith : '#ffffff'}" stroke-opacity="0.38" stroke-width="3.2" stroke-linecap="round"/>
    <path d="M235 46Q355 34 485 44" fill="none" stroke="${isDark ? pal.zenith : '#ffffff'}" stroke-opacity="0.24" stroke-width="2.2" stroke-linecap="round"/>
  </g>` : '';

  const planktonSeeds = [
    [96, 336, 1.8], [138, 362, 1.2], [188, 536, 2.1], [224, 558, 1.5], [262, 542, 2.3],
    [304, 524, 1.4], [434, 392, 1.7], [456, 418, 1.2], [442, 444, 1.9], [612, 338, 1.6],
    [648, 352, 1.3], [676, 332, 1.9], [214, 488, 1.5], [344, 498, 1.3], [528, 376, 1.4],
  ];
  const planktonSvg = !webglCutout ? planktonSeeds.map(([px, py, pr], idx) => {
    const lift = phase ? ((py - phase * 90 + idx * 13) % 280 + 280) % 280 + 290 : py;
    const op = (0.38 + 0.35 * Math.cos(rad + idx * 1.1)).toFixed(2);
    return `<circle cx="${px}" cy="${lift.toFixed(1)}" r="${pr}" fill="${pal.zenith}" fill-opacity="${op}"/>`;
  }).join('') : '';

  const contoursSvg = [12, 26, 42, 60, 80, 104].map((dy, idx) => (
    `<path d="${smoothPolyLine(p3, dy)}" fill="none" stroke="${pal.contour}" stroke-opacity="${(0.24 - idx * 0.032).toFixed(3)}" stroke-width="${idx === 0 ? '1.15' : '0.85'}"/>`
  )).join('');

  // Sculpted 3D canyon facets on p1 & p2 for dramatic underwater cliff relief
  const buildCliffFacets = (pts, clipBottom, lightCol, shdCol) => {
    let f = '';
    for (let i = 4; i < pts.length - 4; i += 7) {
      const p = pts[i];
      const l = pts[Math.max(0, i - 4)];
      const r = pts[Math.min(pts.length - 1, i + 4)];
      if (p.y < l.y - 4 && p.y < r.y - 4) {
        const midX = p.x + (p.x < 380 ? 18 : -18);
        const botY = Math.min(clipBottom, Math.max(l.y, r.y) + 56);
        f += `<polygon points="${l.x.toFixed(1)},${l.y.toFixed(1)} ${p.x.toFixed(1)},${p.y.toFixed(1)} ${midX.toFixed(1)},${botY.toFixed(1)}" fill="${lightCol}" fill-opacity="0.14"/>`
          + `<polygon points="${p.x.toFixed(1)},${p.y.toFixed(1)} ${r.x.toFixed(1)},${r.y.toFixed(1)} ${midX.toFixed(1)},${botY.toFixed(1)}" fill="${shdCol}" fill-opacity="0.28"/>`;
      }
    }
    return f;
  };
  const facets1 = buildCliffFacets(p1, 520, pal.rim, '#020912');
  const facets2 = buildCliffFacets(p2, 610, pal.rim, '#01060c');

  // Asymmetric waist & cost anchors (placed high in calm upper-mid canyon, clear of sonar pin)
  const costY = isAll ? 454 : 584;
  const costMaxW = isAll ? 270 : 310;
  const costSz = fitTextSize(totals.costStr, 74, costMaxW, 38, 0.58);
  const rightPace = paceStr ? `${activity.activeSummary} · ${paceStr}` : activity.activeSummary;
  const waistY = isAll ? 400 : 412;
  const quipMaxW = isAll ? Math.max(200, RIGHT - costMaxW - PAD - 20) : 410;
  const quipClean = quip ? truncateByWidth(quip, 58) : '';
  const quipSz = quipClean ? fitTextSize(quipClean, 21, quipMaxW, 12.5, 0.56) : 21;
  const waistBottomSafeY = quipClean ? waistY + 58 : waistY + 26;

  // Sonar depth pin at real usage peak — guaranteed clearance below left waist & left of $46.70
  let sonarPinSvg = '';
  if (!isAll && activity.maxTok > 0) {
    const pk = corePts3[peakSampleIdx];
    const onLeft = pk.x < 390;
    const minPinTop = onLeft ? Math.max(waistBottomSafeY + 14, 486) : 432;
    const pinTop = Math.max(minPinTop, Math.min(pk.y - 16, pk.y - 46));
    const anchor = pk.x < 180 ? 'start' : (pk.x > 520 ? 'end' : 'middle');
    const lblX = anchor === 'start' ? Math.max(PAD, pk.x - 2) : (anchor === 'end' ? Math.min(688, pk.x + 2) : pk.x);
    const lbl = `${copy.peakPrefix} ${fmtTok(activity.maxTok)}${activity.peakLabel ? ` · ${activity.peakLabel}` : ''}`;
    const ringR = phase ? (3.0 + phase * 8.5).toFixed(1) : '3.0';
    const ringOp = phase ? ((1 - phase) * 0.68).toFixed(2) : '0';
    sonarPinSvg = `
    <line x1="${pk.x.toFixed(1)}" y1="${(pinTop + 5).toFixed(1)}" x2="${pk.x.toFixed(1)}" y2="${(pk.y + 28).toFixed(1)}" stroke="${pal.accent}" stroke-opacity="0.78" stroke-width="1"/>
    <circle cx="${pk.x.toFixed(1)}" cy="${pk.y.toFixed(1)}" r="3.0" fill="${pal.accent}"/>
    <circle cx="${pk.x.toFixed(1)}" cy="${pk.y.toFixed(1)}" r="${ringR}" fill="none" stroke="${pal.accent}" stroke-opacity="${ringOp}" stroke-width="1"/>
    ${svgTxt(lblX.toFixed(1), (pinTop - 2).toFixed(1), lbl, { size: 12, fill: pal.ink, weight: 600, font: FONT_SANS, anchor, ls: '0.05em', num: true, filter: 'agy-aby-shadow' })}`;
  }

  const horizonOrHeatmap = isAll
    ? renderAllHeatmapSvg(activity.allCal, {
      t, normLang, gridTop: 534, padL: PAD, padR: 700,
      ruleCol: pal.rule, mutedCol: pal.muted, emptyCol: pal.emptyCell, accentCol: pal.accent,
    })
    : renderAxisTicksSvg(activity, {
      y: 634, x0: PAD, x1: 688,
      ruleCol: pal.rule, mutedCol: pal.muted, inkCol: pal.ink, accentCol: pal.accent, filter: 'agy-aby-shadow',
    });

  const masthead = `AGY LENS  /  ${normLang === 'en' ? d.periodLabel.toUpperCase() : d.periodLabel}`;

  const defs = `<defs>
    <linearGradient id="agy-aby-water" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${pal.upperWater}"/>
      <stop offset="34%" stop-color="${pal.midWater}"/>
      <stop offset="68%" stop-color="${pal.deepWater}"/>
      <stop offset="100%" stop-color="${pal.floor}"/>
    </linearGradient>
    <radialGradient id="agy-aby-zenith" cx="380" cy="-24" r="420" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="${pal.zenith}" stop-opacity="${isDark ? '0.82' : '0.92'}"/>
      <stop offset="36%" stop-color="${pal.upperWater}" stop-opacity="${isDark ? '0.45' : '0.52'}"/>
      <stop offset="100%" stop-color="${pal.deepWater}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="agy-aby-cauldron" cx="255" cy="528" r="195" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="${pal.zenith}" stop-opacity="${isDark ? '0.38' : '0.28'}"/>
      <stop offset="52%" stop-color="${pal.upperWater}" stop-opacity="0.14"/>
      <stop offset="100%" stop-color="${pal.deepWater}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="agy-aby-beam" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${pal.zenith}" stop-opacity="0.95"/>
      <stop offset="55%" stop-color="${pal.accent}" stop-opacity="0.35"/>
      <stop offset="100%" stop-color="${pal.deepWater}" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="agy-aby-cost" x1="0" y1="0" x2="1" y2="0.4">
      <stop offset="0%" stop-color="#f6e09d"/>
      <stop offset="100%" stop-color="#7ef5f0"/>
    </linearGradient>
    ${[0, 1, 2, 3, 4].map((i) => `<linearGradient id="agy-aby-r${i}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${pal[`r${i}Top`]}"/>
      <stop offset="100%" stop-color="${pal[`r${i}Bot`]}"/>
    </linearGradient>`).join('')}
    <filter id="agy-aby-beam-blur" x="-20%" y="-10%" width="140%" height="130%">
      <feGaussianBlur stdDeviation="8"/>
    </filter>
    <filter id="agy-aby-shadow" x="-20%" y="-60%" width="140%" height="220%">
      <feDropShadow dx="0" dy="1.4" stdDeviation="2.4" flood-color="#02070d" flood-opacity="0.88"/>
    </filter>
    <clipPath id="agy-aby-clip"><rect x="0" y="0" width="${W}" height="${H}"/></clipPath>
  </defs>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" data-editorial-poster="1" data-poster-style="abyssal" data-share-style="abyssal" role="img" aria-label="${escapeXml(t('shareAria'))}">
  ${defs}
  <g clip-path="url(#agy-aby-clip)">
    ${!webglCutout ? `<rect x="0" y="0" width="${W}" height="${H}" fill="url(#agy-aby-water)"/>
    <rect x="0" y="0" width="${W}" height="${H}" fill="url(#agy-aby-zenith)"/>` : ''}
    ${surfaceRipplesSvg}
    ${beamsSvg}
    <path d="${closedAreaPath(p0, 620)}" fill="url(#agy-aby-r0)" fill-opacity="${webglCutout ? '0.88' : '1'}"/>
    ${svgTxt(380, heroY, heroStr, { size: heroSize, fill: pal.heroInk, weight: 400, font: FONT_DISPLAY, anchor: 'middle', ls: '-0.03em', num: true })}
    <path d="${closedAreaPath(p1, 700)}" fill="url(#agy-aby-r1)"/>
    ${facets1}
    <path d="${smoothPolyLine(p1, 0)}" fill="none" stroke="${pal.rim}" stroke-opacity="0.48" stroke-width="1.25"/>
    <rect x="0" y="340" width="${W}" height="320" fill="url(#agy-aby-cauldron)"/>
    ${planktonSvg}
    <path d="${closedAreaPath(p2, 760)}" fill="url(#agy-aby-r2)"/>
    ${facets2}
    <path d="${closedAreaPath(p3, 840)}" fill="url(#agy-aby-r3)"/>
    <path d="${smoothPolyLine(p3, 0)}" fill="none" stroke="${pal.rim}" stroke-opacity="0.58" stroke-width="1.3"/>
    ${contoursSvg}
    <path d="${closedAreaPath(p4, 960)}" fill="url(#agy-aby-r4)"/>
    <rect x="0" y="730" width="${W}" height="220" fill="${pal.floor}" fill-opacity="0.72"/>
    ${sonarPinSvg}
    ${horizonOrHeatmap}
  </g>
  ${svgTxt(PAD, 42, masthead, { size: 13.5, fill: pal.whisper, weight: 600, font: FONT_SANS, ls: '0.18em' })}
  ${svgTxt(PAD, waistY, copy.waist, { size: 14, fill: pal.waistSub, weight: 600, font: FONT_SANS, ls: normLang === 'zh' ? '0.14em' : '0.16em', filter: 'agy-aby-shadow' })}
  ${quipClean ? svgTxt(PAD, waistY + 32, quipClean, { size: quipSz, fill: pal.waistInk, weight: normLang === 'en' ? 400 : 600, font: normLang === 'en' ? FONT_DISPLAY : FONT_SERIF, italic: normLang === 'en', filter: 'agy-aby-shadow' }) : ''}
  ${svgTxt(RIGHT, costY, totals.costStr, { size: costSz, fill: pal.costInk, weight: 400, font: FONT_DISPLAY, anchor: 'end', ls: '-0.02em', num: true, filter: 'agy-aby-shadow' })}
  ${svgTxt(RIGHT, costY + 27, rightPace, { size: 13, fill: pal.sub, weight: 500, font: FONT_SANS, anchor: 'end', ls: '0.04em', num: true, filter: 'agy-aby-shadow' })}
  ${renderSteppedCascadeSvg(d, {
    baseX: PAD, baseY: 688, stepX: 22, pitchY: 40,
    font: FONT_DISPLAY, accentCol: pal.accent, inkCol: pal.ink, mutedCol: pal.muted, subCol: pal.sub,
  })}
  ${renderCounterweightSvg(d, {
    rightX: RIGHT, heroX: 622, heroY: 890,
    font: FONT_DISPLAY, accentCol: pal.accent, inkCol: pal.ink, subCol: pal.sub,
  })}
  ${renderPosterColophon(d, copy.spine, { padL: PAD, mutedCol: pal.muted, filter: 'agy-aby-shadow' })}
</svg>`;
}

// ============================================================================
// 2. ECLIPSE · ASTROLABE (760 x 950) — Total Solar Corona & 3D Brass Rings
// ============================================================================

export function buildEclipseCardSvg(input = {}, animPhase = 0) {
  const d = sanitizeShareCardInput(input);
  const { t, normLang, theme, totals, models, activity, paceStr, quip, webglCutout } = d;
  const copy = t('shareEclipse');
  const W = 760;
  const H = 950;
  const PAD = 38;
  const RIGHT = 716;
  const isDark = theme !== 'light';
  const isAll = Boolean(activity.allCal);
  const phase = normalizePhase(animPhase);
  const rad = phase * Math.PI * 2;

  const pal = isDark ? {
    bgTop: '#04060d',
    bgMid: '#090d19',
    bgBot: '#121018',
    horizonGlow: '#d89b48',
    moonFill: '#05070e',
    coronaCore: '#fff9e6',
    coronaMid: '#f2bd68',
    coronaOuter: '#96531f',
    heroInk: '#f6efe0',
    ringHi: '#fff0c2',
    ringMid: '#d8a450',
    ringLo: '#7d561c',
    planetTop: '#162030',
    planetBot: '#05070e',
    planetRim: '#dfb36b',
    whisper: '#d6ccb8',
    waistInk: '#f5ede0',
    waistSub: '#dccba8',
    costInk: 'url(#agy-ecl-gold)',
    ink: '#f6efe0',
    sub: '#dfd4be',
    muted: '#9b917e',
    accent: '#eac070',
    rule: '#3a342a',
    emptyCell: '#151822',
  } : {
    bgTop: '#c4d8e8',
    bgMid: '#e2ebf0',
    bgBot: '#f5ebd6',
    horizonGlow: '#f6d89e',
    moonFill: '#fffdf7',
    coronaCore: '#ffffff',
    coronaMid: '#f6d58e',
    coronaOuter: '#df9c46',
    heroInk: '#151922',
    ringHi: '#d49d46',
    ringMid: '#96621c',
    ringLo: '#59370b',
    planetTop: '#f3ead6',
    planetBot: '#dfd0b2',
    planetRim: '#ffffff',
    graticule: '#b8a686',
    whisper: '#2d3b4a',
    waistInk: '#171b24',
    waistSub: '#5a4932',
    costInk: '#9c5b14',
    ink: '#161a22',
    sub: '#463f33',
    muted: '#786e5d',
    accent: '#9c5b14',
    rule: '#c9bba0',
    emptyCell: '#e4d8bf',
  };

  const { heroStr, heroSize } = posterHeroMetrics(totals.totalNew, 284);
  const heroY = heroSize >= 256 ? 344 : 336;

  // Eclipse corona & starfield for standalone SVG (!webglCutout)
  const ecx = 374;
  const ecy = 252;
  const er = 92;
  const starPts = [
    [64, 88, 1.1], [128, 54, 0.8], [216, 72, 1.2], [308, 44, 0.9], [468, 42, 1.1],
    [556, 66, 0.85], [684, 52, 1.25], [718, 118, 0.9], [78, 186, 0.95], [696, 214, 1.1],
    [52, 344, 0.85], [712, 396, 1.05], [156, 408, 0.8], [628, 456, 0.95], [336, 562, 0.85],
    [486, 528, 1.0], [248, 598, 0.8], [568, 592, 0.9],
  ];
  const starsSvg = !webglCutout && isDark ? starPts.map(([sx, sy, sr], idx) => {
    const op = (0.35 + 0.35 * Math.cos(rad + idx * 1.3)).toFixed(2);
    return `<circle cx="${sx}" cy="${sy}" r="${sr}" fill="#fffaf0" fill-opacity="${op}"/>`;
  }).join('') : '';

  const streamersSvg = !webglCutout ? Array.from({ length: 32 }, (_, i) => {
    const baseAng = (i / 32) * Math.PI * 2 + (phase ? Math.sin(rad + i * 0.5) * 0.025 : 0);
    const len = er * (1.42 + 0.52 * Math.abs(Math.cos(baseAng * 1.5 + 0.4)) + 0.16 * Math.sin(i * 2.7 + rad));
    const spread = 0.085;
    const x1 = ecx + Math.cos(baseAng - spread) * (er * 0.96);
    const y1 = ecy + Math.sin(baseAng - spread) * (er * 0.96);
    const x2 = ecx + Math.cos(baseAng + spread) * (er * 0.96);
    const y2 = ecy + Math.sin(baseAng + spread) * (er * 0.96);
    const xt = ecx + Math.cos(baseAng + 0.04 * Math.sin(i)) * len;
    const yt = ecy + Math.sin(baseAng + 0.04 * Math.sin(i)) * len;
    const op = ((isDark ? 0.22 : 0.28) * (0.65 + 0.35 * Math.sin(i * 1.9 + rad))).toFixed(3);
    return `<path d="M${x1.toFixed(1)} ${y1.toFixed(1)}Q${((x1 + xt) * 0.52).toFixed(1)} ${((y1 + yt) * 0.52).toFixed(1)} ${xt.toFixed(1)} ${yt.toFixed(1)}Q${((x2 + xt) * 0.52).toFixed(1)} ${((y2 + yt) * 0.52).toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}Z" fill="url(#agy-ecl-corona)" fill-opacity="${op}" filter="url(#agy-ecl-soft)"/>`;
  }).join('') : '';

  // 3D Split Astrolabe Rings (cx=386, cy=334, tilted -35 deg)
  const rcx = 386;
  const rcy = 334;
  const tilt = -35;
  const ringSpecs = [
    { rx: 432, ry: 132, sw: 2.2, op: 0.94, ticks: true },
    { rx: 406, ry: 118, sw: 1.15, op: 0.72, ticks: false },
    { rx: 468, ry: 152, sw: 1.1, op: 0.52, ticks: false },
  ];

  // In local unrotated ellipse coords: y < 0 is upper-left (BACK of 4.8M), y > 0 is lower-right (FRONT of 4.8M)
  const buildHalfRings = (isFront) => {
    let out = '';
    ringSpecs.forEach((rg) => {
      const sweepArc = isFront
        ? `M${rg.rx} 0A${rg.rx} ${rg.ry} 0 0 1 ${-rg.rx} 0`
        : `M${-rg.rx} 0A${rg.rx} ${rg.ry} 0 0 1 ${rg.rx} 0`;
      out += `<path d="${sweepArc}" fill="none" stroke="url(#agy-ecl-gold)" stroke-width="${rg.sw}" stroke-opacity="${rg.op}"/>`;
      if (rg.ticks) {
        for (let k = 1; k < 36; k += 1) {
          const theta = isFront ? (k / 36) * Math.PI : Math.PI + (k / 36) * Math.PI;
          const c = Math.cos(theta);
          const s = Math.sin(theta);
          const inner = k % 3 === 0 ? 0.942 : 0.968;
          const xA = rg.rx * c;
          const yA = rg.ry * s;
          const xB = rg.rx * inner * c;
          const yB = rg.ry * inner * s;
          out += `<line x1="${xA.toFixed(1)}" y1="${yA.toFixed(1)}" x2="${xB.toFixed(1)}" y2="${yB.toFixed(1)}" stroke="${pal.ringHi}" stroke-opacity="${k % 3 === 0 ? '0.78' : '0.42'}" stroke-width="${k % 3 === 0 ? '1.1' : '0.75'}"/>`;
        }
      }
    });

    // Place model planet nodes along the rings (front vs back)
    const nodeAngles = [0.28 * Math.PI, 0.64 * Math.PI, 1.24 * Math.PI, 1.72 * Math.PI];
    models.slice(0, 4).forEach((m, idx) => {
      const baseTheta = nodeAngles[idx] + phase * 0.22 * (idx % 2 === 0 ? 1 : -1);
      const normSin = Math.sin(baseTheta);
      if ((isFront && normSin < 0) || (!isFront && normSin >= 0)) return;
      const rg = ringSpecs[idx % 2];
      const nx = rg.rx * Math.cos(baseTheta);
      const ny = rg.ry * normSin;
      const pr = Math.max(4.5, Math.min(10.5, 4.2 + (m.sharePct / 100) * 8.0));
      out += `<circle cx="${nx.toFixed(1)}" cy="${ny.toFixed(1)}" r="${(pr * 1.9).toFixed(1)}" fill="${pal.coronaCore}" fill-opacity="0.24"/>`
        + `<circle cx="${nx.toFixed(1)}" cy="${ny.toFixed(1)}" r="${pr.toFixed(1)}" fill="url(#agy-ecl-planet-node)" stroke="${pal.ringHi}" stroke-width="1"/>`;
    });

    // Tangent ecliptic peak inscription on the front outer ring (clear of M serif)
    if (isFront && activity.maxTok > 0) {
      const peakStr = `${copy.peakPrefix} ${fmtTok(activity.maxTok)}${activity.peakLabel ? ` · ${activity.peakLabel}` : ''}`;
      out += `<text x="64" y="168" font-family="${FONT_SANS}" font-size="11.5" font-weight="600" fill="${pal.waistSub}" letter-spacing="0.08em" text-anchor="middle" style="font-variant-numeric:tabular-nums lining-nums">${escapeXml(peakStr)}</text>`;
    }
    return `<g transform="translate(${rcx} ${rcy}) rotate(${tilt})"${isFront ? ' filter="url(#agy-ecl-shadow)"' : ''}>${out}</g>`;
  };

  const costY = isAll ? 454 : 566;
  const costMaxW = isAll ? 265 : 300;
  const costSz = fitTextSize(totals.costStr, 72, costMaxW, 38, 0.58);
  const rightPace = paceStr ? `${activity.activeSummary} · ${paceStr}` : activity.activeSummary;
  const quipMaxW = 350;
  const quipClean = quip ? truncateByWidth(quip, 58) : '';
  const quipSz = quipClean ? fitTextSize(quipClean, 19.5, quipMaxW, 12, 0.56) : 19;

  const masthead = `AGY LENS  /  ${normLang === 'en' ? d.periodLabel.toUpperCase() : d.periodLabel}`;
  const limbCy = isAll ? 1245 : 1202;
  const limbR = 566;

  const horizonOrHeatmap = isAll
    ? renderAllHeatmapSvg(activity.allCal, {
      t, normLang, gridTop: 534, padL: PAD, padR: 700,
      ruleCol: pal.rule, mutedCol: pal.muted, emptyCol: pal.emptyCell, accentCol: pal.accent,
    })
    : '';

  const defs = `<defs>
    <linearGradient id="agy-ecl-bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${pal.bgTop}"/>
      <stop offset="56%" stop-color="${pal.bgMid}"/>
      <stop offset="100%" stop-color="${pal.bgBot}"/>
    </linearGradient>
    <radialGradient id="agy-ecl-corona" cx="${ecx}" cy="${ecy}" r="245" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="${pal.coronaCore}" stop-opacity="0.98"/>
      <stop offset="36%" stop-color="${pal.coronaCore}" stop-opacity="0.92"/>
      <stop offset="52%" stop-color="${pal.coronaMid}" stop-opacity="${isDark ? '0.62' : '0.54'}"/>
      <stop offset="78%" stop-color="${pal.coronaOuter}" stop-opacity="${isDark ? '0.20' : '0.16'}"/>
      <stop offset="100%" stop-color="${pal.bgTop}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="agy-ecl-horizon" cx="425" cy="675" r="320" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="${pal.horizonGlow}" stop-opacity="${isDark ? '0.42' : '0.32'}"/>
      <stop offset="55%" stop-color="${pal.horizonGlow}" stop-opacity="0.10"/>
      <stop offset="100%" stop-color="${pal.bgMid}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="agy-ecl-gold" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${pal.ringHi}"/>
      <stop offset="52%" stop-color="${pal.ringMid}"/>
      <stop offset="100%" stop-color="${pal.ringLo}"/>
    </linearGradient>
    <radialGradient id="agy-ecl-planet-node" cx="35%" cy="35%" r="68%">
      <stop offset="0%" stop-color="${pal.coronaCore}"/>
      <stop offset="55%" stop-color="${pal.ringMid}"/>
      <stop offset="100%" stop-color="#2b1c08"/>
    </radialGradient>
    <radialGradient id="agy-ecl-day-sun" cx="50%" cy="50%" r="52%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="64%" stop-color="#fffcf2"/>
      <stop offset="90%" stop-color="#f8e3b4"/>
      <stop offset="100%" stop-color="#f0c878" stop-opacity="0.85"/>
    </radialGradient>
    <linearGradient id="agy-ecl-limb" x1="0.35" y1="0" x2="0.6" y2="1">
      <stop offset="0%" stop-color="${pal.planetTop}"/>
      <stop offset="45%" stop-color="${pal.planetBot}"/>
      <stop offset="100%" stop-color="${isDark ? '#03050a' : '#cfc0a0'}"/>
    </linearGradient>
    <clipPath id="agy-ecl-limb-clip">
      <circle cx="430" cy="${limbCy}" r="${limbR}"/>
    </clipPath>
    <filter id="agy-ecl-soft" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="4.5"/>
    </filter>
    <filter id="agy-ecl-shadow" x="-20%" y="-40%" width="140%" height="180%">
      <feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="${isDark ? '#03050a' : '#8c7856'}" flood-opacity="${isDark ? '0.82' : '0.22'}"/>
    </filter>
    <clipPath id="agy-ecl-clip"><rect x="0" y="0" width="${W}" height="${H}"/></clipPath>
  </defs>`;

  const dayGraticuleSvg = !isDark ? `<g clip-path="url(#agy-ecl-limb-clip)" stroke="${pal.graticule}" fill="none" stroke-opacity="0.36" stroke-width="0.85">
    <circle cx="430" cy="${limbCy + 42}" r="${limbR - 12}"/>
    <circle cx="430" cy="${limbCy + 96}" r="${limbR - 24}" stroke-dasharray="3 4"/>
    <circle cx="430" cy="${limbCy + 162}" r="${limbR - 36}"/>
    <ellipse cx="430" cy="${limbCy}" rx="180" ry="${limbR}"/>
    <ellipse cx="430" cy="${limbCy}" rx="340" ry="${limbR}"/>
    <ellipse cx="430" cy="${limbCy}" rx="475" ry="${limbR}"/>
    <line x1="430" y1="${limbCy - limbR}" x2="430" y2="950"/>
  </g>` : '';

  const daySundogSvg = !isDark ? `<g stroke="#b07c2e" fill="none">
    <circle cx="${ecx}" cy="${ecy}" r="154" stroke-opacity="0.26" stroke-width="0.9"/>
    <circle cx="${ecx}" cy="${ecy}" r="148" stroke-opacity="0.18" stroke-width="0.75" stroke-dasharray="2 5"/>
    <line x1="${ecx - 168}" y1="${ecy}" x2="${ecx - 140}" y2="${ecy}" stroke-opacity="0.38" stroke-width="1"/>
    <line x1="${ecx + 140}" y1="${ecy}" x2="${ecx + 168}" y2="${ecy}" stroke-opacity="0.38" stroke-width="1"/>
    <line x1="${ecx}" y1="${ecy - 168}" x2="${ecx}" y2="${ecy - 140}" stroke-opacity="0.38" stroke-width="1"/>
  </g>` : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" data-editorial-poster="1" data-poster-style="eclipse" data-share-style="eclipse" role="img" aria-label="${escapeXml(t('shareAria'))}">
  ${defs}
  <g clip-path="url(#agy-ecl-clip)">
    ${!webglCutout ? `<rect x="0" y="0" width="${W}" height="${H}" fill="url(#agy-ecl-bg)"/>
    <rect x="0" y="380" width="${W}" height="570" fill="url(#agy-ecl-horizon)"/>
    ${starsSvg}
    <circle cx="${ecx}" cy="${ecy}" r="235" fill="url(#agy-ecl-corona)"/>
    ${streamersSvg}` : ''}
    ${isDark
      ? `<circle cx="${ecx}" cy="${ecy}" r="${(er + 3.5).toFixed(1)}" fill="none" stroke="${pal.coronaCore}" stroke-opacity="0.92" stroke-width="2.6" filter="url(#agy-ecl-soft)"/>
    <circle cx="${ecx}" cy="${ecy}" r="${er}" fill="${pal.moonFill}" stroke="${pal.coronaCore}" stroke-opacity="0.72" stroke-width="1.2"/>`
      : `${daySundogSvg}
    <circle cx="${ecx}" cy="${ecy}" r="${(er + 8).toFixed(1)}" fill="#ffffff" fill-opacity="0.55" filter="url(#agy-ecl-soft)"/>
    <circle cx="${ecx}" cy="${ecy}" r="${er}" fill="url(#agy-ecl-day-sun)" stroke="#e4b768" stroke-opacity="0.55" stroke-width="1.1"/>`}
    ${buildHalfRings(false)}
    ${svgTxt(380, heroY, heroStr, { size: heroSize, fill: pal.heroInk, weight: 400, font: FONT_DISPLAY, anchor: 'middle', ls: '-0.03em', num: true })}
    ${buildHalfRings(true)}
    <circle cx="430" cy="${limbCy - 3}" r="${limbR + 4}" fill="none" stroke="${pal.planetRim}" stroke-opacity="${isDark ? '0.45' : '0.85'}" stroke-width="${isDark ? '6' : '8'}" filter="url(#agy-ecl-soft)"/>
    <circle cx="430" cy="${limbCy}" r="${limbR}" fill="url(#agy-ecl-limb)" stroke="${isDark ? pal.planetRim : '#baa786'}" stroke-opacity="0.55" stroke-width="1.1"/>
    ${dayGraticuleSvg}
    ${horizonOrHeatmap}
  </g>
  ${svgTxt(PAD, 42, masthead, { size: 13.5, fill: pal.whisper, weight: 600, font: FONT_SANS, ls: '0.18em' })}
  ${svgTxt(PAD, isAll ? 412 : 462, copy.waistTop, { size: 28, fill: pal.waistInk, weight: 400, font: FONT_DISPLAY, ls: '0.06em' })}
  ${svgTxt(PAD, isAll ? 442 : 494, copy.waistBot, { size: 28, fill: pal.waistInk, weight: 400, font: FONT_DISPLAY, ls: '0.06em' })}
  ${quipClean ? svgTxt(PAD, isAll ? 470 : 524, quipClean, { size: quipSz, fill: pal.waistSub, weight: normLang === 'en' ? 400 : 500, font: normLang === 'en' ? FONT_DISPLAY : FONT_SERIF, italic: normLang === 'en' }) : ''}
  ${svgTxt(RIGHT, costY, totals.costStr, { size: costSz, fill: pal.costInk, weight: 400, font: FONT_DISPLAY, anchor: 'end', ls: '-0.02em', num: true })}
  ${svgTxt(RIGHT, costY + 27, rightPace, { size: 13, fill: isDark ? pal.sub : pal.waistSub, weight: 500, font: FONT_SANS, anchor: 'end', ls: '0.04em', num: true })}
  ${renderSteppedCascadeSvg(d, {
    baseX: 52, baseY: 800, stepX: 16, pitchY: 35,
    font: FONT_DISPLAY, accentCol: pal.accent, inkCol: pal.ink, mutedCol: pal.muted, subCol: pal.sub,
    rotateDeg: -20, rotateCx: 52, rotateCy: 800, maxNameUnits: 29.5, maxSpanPx: 495,
  })}
  ${renderCounterweightSvg(d, {
    rightX: RIGHT, heroX: 622, heroY: 890,
    font: FONT_DISPLAY, accentCol: pal.ink, inkCol: pal.accent, subCol: pal.sub,
    stackedFullWidth: true,
  })}
  ${renderPosterColophon(d, copy.spine, { padL: PAD, mutedCol: pal.muted })}
</svg>`;
}

// ============================================================================
// 3. BAUHAUS · OVERPRINT (760 x 950) — Zürich Constructivist Ink Print
// ============================================================================

export function buildBauhausCardSvg(input = {}, animPhase = 0) {
  const d = sanitizeShareCardInput(input);
  const { t, normLang, theme, totals, activity, paceStr, quip, webglCutout } = d;
  const copy = t('shareBauhaus');
  const W = 760;
  const H = 950;
  const PAD = 36;
  const RIGHT = 720;
  const isLight = theme === 'light';
  const isAll = Boolean(activity.allCal);
  const phase = normalizePhase(animPhase);
  const rad = phase * Math.PI * 2;

  const pal = isLight ? {
    paper: '#f2ede2',
    red: '#e03c1f',
    blue: '#2148c4',
    ochre: '#e09b24',
    blend: 'multiply',
    shapeOp: '0.74',
    heroInk: '#121316',
    heroStroke: '#f2ede2',
    ink: '#121316',
    sub: '#2e3138',
    muted: '#5c606b',
    costInk: '#d93518',
    rule: '#cfc7b6',
    emptyCell: '#e4ddd0',
  } : {
    paper: '#0c0e13',
    red: '#cf3418',
    blue: '#1c40b2',
    ochre: '#c98418',
    blend: 'normal',
    shapeOp: '0.72',
    heroInk: '#f8f3e8',
    heroStroke: '#0c0e13',
    ink: '#f5f0e5',
    sub: '#d5cfc2',
    muted: '#8d929e',
    costInk: '#f4573a',
    rule: '#262a34',
    emptyCell: '#1a1e26',
  };

  // Data-driven geometric proportions (Input / Output / Cache)
  const ioTotal = Math.max(1, totals.input + totals.output);
  const outShare = Math.max(0.18, Math.min(0.68, totals.output / ioTotal));
  const reuseNorm = totals.reuseRatio !== null ? Math.min(1, Math.log10(1 + totals.reuseRatio) / 1.4) : 0.45;
  const arcStroke = Math.round(98 + reuseNorm * 26);
  const ochreHalfW = Math.round(32 + outShare * 36);

  const glideX = phase ? Math.sin(rad) * 7 : 0;
  const glideY = phase ? Math.cos(rad) * 5 : 0;

  // Giant open vermilion C-arc (cx=364, cy=432, r=244, opening at lower-right -22deg..+36deg)
  const acx = 364;
  const acy = 432;
  const ar = 244;
  const aStart = (38 * Math.PI) / 180;
  const aEnd = (-22 * Math.PI) / 180;
  const xS = acx + ar * Math.cos(aStart);
  const yS = acy + ar * Math.sin(aStart);
  const xE = acx + ar * Math.cos(aEnd);
  const yE = acy + ar * Math.sin(aEnd);
  const cArcPath = `M${xS.toFixed(1)} ${yS.toFixed(1)}A${ar} ${ar} 0 1 1 ${xE.toFixed(1)} ${yE.toFixed(1)}`;

  const { heroStr, heroSize } = posterHeroMetrics(totals.totalNew, 244);

  const costY = isAll ? 496 : 548;
  const costMaxW = 245;
  const costSz = fitTextSize(totals.costStr, 68, costMaxW, 34, 0.60);
  const peakPart = activity.maxTok > 0
    ? (normLang === 'zh' ? ` · 峰值 ${fmtTok(activity.maxTok)}` : ` · PEAK ${fmtTok(activity.maxTok)}`)
    : '';
  const rightMeta = truncateByWidth(`${activity.activeSummary}${paceStr ? ` · ${paceStr}` : ''}${peakPart}`, 72);
  const rightMetaSz = fitTextSize(rightMeta, 12, 310, 9.5, 0.55);

  const masthead = `AGY LENS / ${normLang === 'en' ? d.periodLabel.toUpperCase() : d.periodLabel}`;
  const quipClean = quip ? truncateByWidth(quip, 58) : '';
  const quipSz = quipClean ? fitTextSize(quipClean, 15, 420, 11.5, 0.56) : 15;

  const heatmapSvg = isAll
    ? renderAllHeatmapSvg(activity.allCal, {
      t, normLang, gridTop: 552, padL: PAD, padR: 696,
      ruleCol: pal.rule, mutedCol: pal.muted, emptyCol: pal.emptyCell, accentCol: pal.red, cellRx: 0.6,
    })
    : '';

  const defs = `<defs>
    <filter id="agy-bau-grain" x="0" y="0" width="100%" height="100%">
      <feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="2" stitchTiles="stitch"/>
      <feColorMatrix type="saturate" values="0"/>
    </filter>
    <clipPath id="agy-bau-clip"><rect x="0" y="0" width="${W}" height="${H}"/></clipPath>
  </defs>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" data-editorial-poster="1" data-poster-style="bauhaus" data-share-style="bauhaus" role="img" aria-label="${escapeXml(t('shareAria'))}">
  ${defs}
  <g clip-path="url(#agy-bau-clip)">
    ${!webglCutout ? `<rect x="0" y="0" width="${W}" height="${H}" fill="${pal.paper}"/>
    <g style="mix-blend-mode:${pal.blend}">
      <path d="${cArcPath}" fill="none" stroke="${pal.red}" stroke-width="${arcStroke}" stroke-opacity="${isLight ? '0.74' : pal.shapeOp}" stroke-linecap="butt"/>
      <circle cx="${(526 + glideX).toFixed(1)}" cy="${(224 + glideY).toFixed(1)}" r="168" fill="${pal.red}" fill-opacity="${isLight ? '0.74' : pal.shapeOp}"/>
      <g transform="translate(365 478) rotate(-36)">
        <rect x="-430" y="${-ochreHalfW}" width="820" height="${ochreHalfW * 2}" fill="${pal.ochre}" fill-opacity="${isLight ? '0.74' : pal.shapeOp}"/>
      </g>
      <polygon points="78,844 356,642 672,34 316,246" fill="${pal.blue}" fill-opacity="${isLight ? '0.72' : pal.shapeOp}"/>
    </g>` : ''}
    <g transform="translate(352 428) rotate(-36)">
      <text x="0" y="0" font-family="${FONT_SANS}" font-size="${heroSize}" font-weight="800" fill="${pal.heroInk}" fill-opacity="0.98" letter-spacing="-0.04em" text-anchor="middle" style="font-variant-numeric:tabular-nums lining-nums">${escapeXml(heroStr)}</text>
    </g>
    ${heatmapSvg}
    ${!webglCutout ? `<rect x="0" y="0" width="${W}" height="${H}" filter="url(#agy-bau-grain)" opacity="${isLight ? '0.032' : '0.04'}"/>` : ''}
  </g>
  ${svgTxt(PAD, 52, masthead, { size: 22, fill: pal.ink, weight: 800, font: FONT_SANS, ls: '-0.01em' })}
  ${svgTxt(PAD, 74, copy.waist, { size: 11.5, fill: pal.muted, weight: 700, font: FONT_SANS, ls: '0.12em' })}
  ${quipClean ? svgTxt(PAD, 96, quipClean, { size: quipSz, fill: pal.sub, weight: 600, font: FONT_SANS }) : ''}
  ${svgTxt(RIGHT, costY, totals.costStr, { size: costSz, fill: pal.costInk, weight: 800, font: FONT_SANS, anchor: 'end', ls: '-0.03em', num: true })}
  ${svgTxt(RIGHT, costY + 24, rightMeta, { size: rightMetaSz, fill: pal.ink, weight: 700, font: FONT_SANS, anchor: 'end', ls: '0.02em', num: true })}
  ${renderSteppedCascadeSvg(d, {
    baseX: 68, baseY: 842, stepX: 26, pitchY: 33,
    font: FONT_SANS, weight: 800,
    accentCol: pal.muted, inkCol: pal.ink, mutedCol: pal.muted, subCol: pal.ink,
    rotateDeg: -36, rotateCx: 68, rotateCy: 842, compactPctOnly: true, maxNameUnits: 29.5, maxSpanPx: 525,
  })}
  ${renderCounterweightSvg(d, {
    rightX: RIGHT, heroX: 622, heroY: 888,
    font: FONT_SANS, heroWeight: 800,
    accentCol: pal.ink, inkCol: pal.ink, subCol: pal.muted,
    stackedFullWidth: true,
  })}
  ${renderPosterColophon(d, copy.spine, { padL: PAD, mutedCol: pal.muted })}
</svg>`;
}

// ============================================================================
// 4. PHOSPHOR · RIBBON (760 x 950) — 3D Harmonic Oscillograph & 35mm Film
// ============================================================================

export function buildPhosphorCardSvg(input = {}, animPhase = 0) {
  const d = sanitizeShareCardInput(input);
  const { t, normLang, theme, totals, activity, paceStr, quip, webglCutout } = d;
  const copy = t('sharePhosphor');
  const W = 760;
  const H = 950;
  const PAD = 44;
  const RIGHT = 710;
  const isDark = theme !== 'light';
  const isAll = Boolean(activity.allCal);
  const phase = normalizePhase(animPhase);
  const rad = phase * Math.PI * 2;

  const pal = isDark ? {
    bgTop: '#05080c',
    bgBot: '#081016',
    bezel: '#020305',
    filmInk: '#c79248',
    amberHi: '#ffe08a',
    amberMid: '#f6ad42',
    cyanHi: '#7cfbe0',
    cyanMid: '#24c49c',
    heroInk: '#fbf1da',
    whisper: '#d6e2df',
    waistInk: '#dbe8e4',
    costInk: '#f7ba54',
    ink: '#efe6d0',
    sub: '#c6d4cf',
    muted: '#7a8f8a',
    accent: '#f8c368',
    rule: '#1c302c',
    emptyCell: '#0d1b19',
  } : {
    bgTop: '#edf3f7',
    bgBot: '#dce7f0',
    bezel: '#cbd9e5',
    filmInk: '#5c748a',
    amberHi: '#e07a28',
    amberMid: '#b84f12',
    cyanHi: '#1c64d8',
    cyanMid: '#0f3f96',
    heroInk: '#0e1824',
    whisper: '#273c52',
    waistInk: '#1c3044',
    costInk: '#c45614',
    ink: '#0f1b29',
    sub: '#2e4459',
    muted: '#60788f',
    accent: '#1550ba',
    rule: '#b8cad9',
    emptyCell: '#cfdce8',
  };

  const { curve } = extractNormalizedActivityCurve(d, 24);
  const { heroStr, heroSize } = posterHeroMetrics(totals.totalNew, 268);
  const heroY = heroSize >= 244 ? 476 : 466;

  // Build harmonic multi-strand Bezier ribbons from real usage curve
  const buildStrandGroup = (startIdx, endIdx, opacityScale = 1) => {
    const totalStrands = 26;
    const xs = Array.from({ length: 28 }, (_, j) => -12 + (j / 27) * (W + 24));
    let paths = '';
    for (let s = startIdx; s < endIdx; s += 1) {
      const sn = s / (totalStrands - 1); // 0..1
      const isAmber = s % 2 === 0;
      const col = isAmber ? (s % 4 === 0 ? pal.amberHi : pal.amberMid) : (s % 4 === 1 ? pal.cyanHi : pal.cyanMid);
      const pts = xs.map((x) => {
        const u = (x + 12) / (W + 24);
        const ci = u * 23;
        const i0 = Math.min(23, Math.max(0, Math.floor(ci)));
        const i1 = Math.min(23, i0 + 1);
        const cv = curve[i0] * (1 - (ci - i0)) + curve[i1] * (ci - i0);
        // Sculpted harmonic envelope: lower-left trough around u=0.28, soaring crest around u=0.80
        const trough = Math.exp(-((u - 0.27) ** 2) / 0.032) * 195;
        const crest = Math.exp(-((u - 0.81) ** 2) / 0.018) * (270 + cv * 95);
        const baseWave = 455 + trough - crest - cv * 46 + (0.5 - u) * 34;
        const harmonic = Math.sin(u * Math.PI * 2.6 + sn * 3.1 + rad * (isAmber ? 1 : -1)) * (28 + sn * 42)
          + Math.cos(u * Math.PI * 4.2 - sn * 2.4 + rad) * 14;
        const spread = (sn - 0.5) * (68 - Math.exp(-((u - 0.81) ** 2) / 0.015) * 44);
        return { x, y: baseWave + harmonic + spread };
      });
      const sw = (s % 5 === 0 ? 1.55 : 0.95).toFixed(2);
      const op = ((0.22 + 0.46 * Math.sin(sn * Math.PI)) * opacityScale).toFixed(3);
      paths += `<path d="${smoothPolyLine(pts, 0)}" fill="none" stroke="${col}" stroke-width="${sw}" stroke-opacity="${op}"/>`;
    }
    return paths;
  };

  const backRibbons = webglCutout ? buildStrandGroup(0, 8, 0.42) : buildStrandGroup(0, 15, 1.0);
  const frontRibbons = webglCutout ? buildStrandGroup(18, 24, 0.36) : buildStrandGroup(15, 26, 0.82);

  // 35mm right-edge film perforations & frame numbers
  const filmTicks = [196, 348, 520, 712, 886].map((fy, idx) => {
    const lbl = idx === 0 ? '▼' : (idx === 1 ? '16' : (idx === 2 ? '16A' : (idx === 4 ? 'FRAME' : '3')));
    return `<text x="748" y="${fy}" transform="rotate(-90 748 ${fy})" font-family="${FONT_MONO}" font-size="9.5" fill="${pal.filmInk}" fill-opacity="0.72" letter-spacing="0.08em">${lbl}</text>`;
  }).join('');

  const costY = isAll ? 516 : 558;
  const costMaxW = 280;
  const costSz = fitTextSize(totals.costStr, 72, costMaxW, 36, 0.58);
  const peakPart = activity.maxTok > 0
    ? (normLang === 'zh' ? ` · 峰值 ${fmtTok(activity.maxTok)}` : ` · PEAK ${fmtTok(activity.maxTok)}`)
    : '';
  const rightMeta = truncateByWidth(`${activity.activeSummary}${paceStr ? ` · ${paceStr}` : ''}${peakPart}`, 72);
  const rightMetaSz = fitTextSize(rightMeta, 12.5, 320, 9.5, 0.55);

  const masthead = `AGY LENS  //  ${copy.header} · ${normLang === 'en' ? d.periodLabel.toUpperCase() : d.periodLabel}`;
  const waistLine = quip ? `${copy.waist} · ${truncateByWidth(quip, 58)}` : copy.waist;
  const waistSz = fitTextSize(waistLine, 17, 500, 11.5, 0.56);

  const heatmapSvg = isAll
    ? renderAllHeatmapSvg(activity.allCal, {
      t, normLang, gridTop: 556, padL: PAD, padR: 700,
      ruleCol: pal.rule, mutedCol: pal.muted, emptyCol: pal.emptyCell, accentCol: pal.amberMid,
    })
    : '';

  const defs = `<defs>
    <linearGradient id="agy-pho-bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${pal.bgTop}"/>
      <stop offset="100%" stop-color="${pal.bgBot}"/>
    </linearGradient>
    <filter id="agy-pho-glow" x="-15%" y="-20%" width="130%" height="140%">
      <feGaussianBlur stdDeviation="${isDark ? '2.6' : '1.2'}" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <clipPath id="agy-pho-clip"><rect x="0" y="0" width="${W}" height="${H}"/></clipPath>
  </defs>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" data-editorial-poster="1" data-poster-style="phosphor" data-share-style="phosphor" role="img" aria-label="${escapeXml(t('shareAria'))}">
  ${defs}
  <g clip-path="url(#agy-pho-clip)">
    ${!webglCutout ? `<rect x="0" y="0" width="${W}" height="${H}" fill="url(#agy-pho-bg)"/>` : ''}
    <rect x="10" y="10" width="${W - 20}" height="${H - 20}" rx="28" fill="none" stroke="${pal.bezel}" stroke-opacity="${isDark ? '0.68' : '0.42'}" stroke-width="16"/>
    <g filter="url(#agy-pho-glow)">${backRibbons}</g>
    ${svgTxt(380, heroY, heroStr, { size: heroSize, fill: pal.heroInk, weight: 400, font: FONT_DISPLAY, anchor: 'middle', ls: '-0.03em', num: true, filter: isDark ? 'agy-pho-glow' : null })}
    <g filter="url(#agy-pho-glow)">${frontRibbons}</g>
    ${heatmapSvg}
    ${filmTicks}
  </g>
  ${svgTxt(PAD, 58, masthead, { size: 13, fill: pal.whisper, weight: 500, font: FONT_MONO, ls: '0.10em' })}
  ${svgTxt(PAD, 278, waistLine, { size: waistSz, fill: pal.waistInk, weight: 400, font: FONT_SANS, ls: '0.03em' })}
  ${svgTxt(RIGHT, costY, totals.costStr, { size: costSz, fill: pal.costInk, weight: 500, font: FONT_SANS, anchor: 'end', ls: '-0.02em', num: true, filter: isDark ? 'agy-pho-glow' : null })}
  ${svgTxt(RIGHT, costY + 26, rightMeta, { size: rightMetaSz, fill: pal.sub, weight: 500, font: FONT_SANS, anchor: 'end', ls: '0.03em', num: true })}
  ${renderSteppedCascadeSvg(d, {
    baseX: 48, baseY: 804, stepX: 14, pitchY: 31,
    font: FONT_SANS, weight: 500,
    accentCol: pal.amberMid, inkCol: pal.ink, mutedCol: pal.muted, subCol: pal.sub,
    rotateDeg: -19, rotateCx: 48, rotateCy: 804, maxNameUnits: 29.5, maxSpanPx: 480,
  })}
  ${renderCounterweightSvg(d, {
    rightX: RIGHT, heroX: 622, heroY: 888,
    font: FONT_SANS, heroWeight: 600,
    accentCol: pal.heroInk, inkCol: pal.heroInk, subCol: pal.sub,
    stackTopOverride: copy.gainTop, stackBotOverride: copy.gainBot,
    stackedFullWidth: true,
  })}
  ${svgTxt(PAD, 928, 'github.com/Aoike123/agy-lens', { size: 11, fill: pal.muted, weight: 500, font: FONT_MONO, ls: '0.04em' })}
</svg>`;
}
