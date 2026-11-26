// Sanitized History Share Card SVG generator, modal preview, and SVG/PNG exporters.
// buildShareCardSvg, escapeXml, and scrubSensitiveText are pure Node-runnable with zero DOM/browser globals.

import { createTranslator, normalizeLang } from '../i18n.js';
import { dayKey, esc, fmtCost, fmtInt, fmtPctNum, fmtTok, getJson, isNum, makeHeatScale, parseDay, postJson } from '../format.js';
import {
  CLASS_ARENA, arenaPath, buildProfile, buildQuips, charIdlePath, charStillPath,
  sanitizeNickname, usageAchievements,
} from './share-game.js';
import { buildRoleCardSvg } from './share-pixel.js';
import {
  VFX_H, VFX_W, clearVfxFrame, compositeVfx, createAmbientFx, createVfxFrame,
} from './share-vfx.js';

export const SHARE_CARD_WIDTH = 1200;
export const SHARE_CARD_HEIGHT = 630;

const VALID_PERIODS = new Set(['today', 'd7', 'd30', 'all']);
const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const FONT_SANS = "system-ui, -apple-system, 'Segoe UI', Roboto, 'PingFang SC', 'Microsoft YaHei', sans-serif";
const FONT_MONO = "ui-monospace, 'Cascadia Mono', 'SF Mono', Menlo, Consolas, monospace";

const THEMES = {
  // Obsidian optical telemetry plate.
  dark: {
    bg: '#0d0f13',
    plate: '#12151b',
    recess: '#0e1117',
    fg: '#f2ede4',
    secondary: '#a5aebd',
    muted: '#6d7686',
    dim: '#525b6c',
    line: '#232833',
    lineStrong: '#333b4c',
    empty: '#1c212c',
    bar: '#3e475a',
    rest: '#5a6478',
    accent: '#6ea8fe',
    series: ['#6ea8fe', '#e5a454', '#5ec2a6', '#d67d96'],
  },
  // Swiss archival cotton & fountain ink plate.
  light: {
    bg: '#f2f4f8',
    plate: '#ffffff',
    recess: '#f7f8fb',
    fg: '#14171f',
    secondary: '#475061',
    muted: '#6c768a',
    dim: '#8a94a8',
    line: '#e3e7ef',
    lineStrong: '#cbd2df',
    empty: '#ebeef5',
    bar: '#b9c2d3',
    rest: '#98a3b8',
    accent: '#2463d8',
    series: ['#2463d8', '#c8731a', '#1d8a72', '#b84b70'],
  },
};

function safeNum(v) {
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

function truncateLabel(s, maxChars = 30) {
  const chars = Array.from(String(s || ''));
  if (chars.length <= maxChars) return chars.join('');
  return `${chars.slice(0, Math.max(1, maxChars - 1)).join('')}…`;
}

function sanitizeModels(rawList, fallbackName, periodKey = null) {
  const map = new Map();
  for (const m of Array.isArray(rawList) ? rawList : []) {
    if (!m || typeof m !== 'object') continue;
    // Prefer the per-period slice when the scanner provides one, so the card matches its period.
    const hasSlice = Boolean(periodKey && m.periods && typeof m.periods === 'object' && m.periods[periodKey] && typeof m.periods[periodKey] === 'object');
    const slice = hasSlice ? m.periods[periodKey] : m;
    const inp = safeNum(slice.input);
    const out = safeNum(slice.output);
    const cacheRead = safeNum(slice.cache_read);
    const calls = safeNum(slice.calls);
    if (hasSlice && calls <= 0 && inp + out + cacheRead <= 0) continue;

    const rawName = m.display_name || m.model || fallbackName;
    const cleaned = truncateLabel(scrubSensitiveText(rawName) || fallbackName, 30);
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

function sanitizeDaily(rawDaily) {
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

function sanitizeHourly(rawHourly) {
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

function formatMonthLabel(dateObj, lang) {
  const m = dateObj.getMonth();
  return lang === 'zh' ? `${m + 1}月` : MONTH_ABBR_EN[m];
}

function formatDayTick(dateStr, t, lang) {
  const dt = parseDay(dateStr);
  if (Number.isNaN(dt.getTime())) return dateStr.slice(5);
  const wd = t('weekdays');
  const w = wd[dt.getDay()] || '';
  return lang === 'zh' ? `周${w} ${dt.getDate()}` : `${w} ${dt.getDate()}`;
}

/** Dashed daily-average line and a label over the busiest bar (bar charts with >= 3 days). */
function avgAndPeak(bars, maxTok, chartH, baseY, x0, bw, gap, pal, txt, t) {
  const active = bars.filter((d) => d.tokens > 0);
  if (bars.length < 3 || !active.length || !(maxTok > 0)) return '';
  const avg = active.reduce((a, d) => a + d.tokens, 0) / active.length;
  const y = baseY - Math.max(4, (avg / maxTok) * chartH);
  let peakI = 0;
  bars.forEach((d, i) => { if (d.tokens >= bars[peakI].tokens) peakI = i; });
  const px = x0 + peakI * (bw + gap) + bw / 2;
  const right = x0 + bars.length * (bw + gap) - gap;
  return `<line x1="${x0.toFixed(1)}" y1="${y.toFixed(1)}" x2="${right.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${pal.lineStrong}" stroke-width="1" stroke-dasharray="3 4"/>`
    + txt(px.toFixed(1), (baseY - chartH - 8).toFixed(1), fmtTok(bars[peakI].tokens), { size: 11.5, fill: pal.secondary, anchor: 'middle', num: true, weight: 500 });
}

/** Resolve a buildQuips() entry to text. */
export function quipText(entry, lang) {
  if (!Array.isArray(entry) || !entry.length) return '';
  const t = createTranslator(normalizeLang(lang));
  return String(t(entry[0], ...entry.slice(1)));
}

function renderActivitySection({ periodKey, dailySlice, hourly, pal, PAD, RIGHT, t, normLang, txt }) {
  const chartW = RIGHT - PAD;
  const activeDailyCount = dailySlice.filter((d) => d.tokens > 0 || d.calls > 0).length;

  // 1. Today: 24-hour time-of-day activity bar chart (00:00 -> 23:00).
  if (periodKey === 'today') {
    const chartTop = 468;
    const chartH = 54;
    const baseY = chartTop + chartH;
    const gap = 8;
    const bw = (chartW - gap * 23) / 24;
    let svg = `<line x1="${PAD}" y1="${baseY + 0.5}" x2="${RIGHT}" y2="${baseY + 0.5}" stroke="${pal.lineStrong}" stroke-width="1"/>`;
    let activeSummary;
    if (hourly) {
      const activeHours = hourly.filter((h) => h.tokens > 0 || h.calls > 0).length;
      activeSummary = t('activeHours', activeHours);
      const maxTok = hourly.reduce((mx, h) => Math.max(mx, h.tokens), 0);
      let peakHour = -1;
      if (maxTok > 0) {
        for (const h of hourly) {
          if (h.tokens >= maxTok) peakHour = h.hour;
        }
      }
      svg += hourly.map((h, i) => {
        const x = PAD + i * (bw + gap);
        let bh = 2.5;
        let fill = pal.empty;
        let rx = 1;
        if (h.tokens > 0 && maxTok > 0) {
          bh = Math.max(5, (h.tokens / maxTok) * chartH);
          fill = h.hour === peakHour ? pal.accent : pal.bar;
          rx = 2;
        } else if (h.calls > 0) {
          bh = 4;
          fill = pal.bar;
          rx = 1.5;
        }
        return `<rect x="${x.toFixed(1)}" y="${(baseY - bh).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="${rx}" fill="${fill}"/>`;
      }).join('');
    } else {
      activeSummary = t('activeToday', activeDailyCount > 0);
      svg += Array.from({ length: 24 }, (_, i) => {
        const x = PAD + i * (bw + gap);
        return `<rect x="${x.toFixed(1)}" y="${(baseY - 2.5).toFixed(1)}" width="${bw.toFixed(1)}" height="2.5" rx="1" fill="${pal.empty}"/>`;
      }).join('');
    }
    for (const hr of [0, 6, 12, 18, 23]) {
      const bx = PAD + hr * (bw + gap);
      const tickX = hr === 0 ? bx : (hr === 23 ? bx + bw : bx + bw / 2);
      const anchor = hr === 0 ? 'start' : (hr === 23 ? 'end' : 'middle');
      const lbl = `${String(hr).padStart(2, '0')}:00`;
      svg += `<line x1="${(bx + bw / 2).toFixed(1)}" y1="${baseY + 1}" x2="${(bx + bw / 2).toFixed(1)}" y2="${baseY + 5}" stroke="${pal.lineStrong}" stroke-width="1"/>`;
      svg += txt(tickX.toFixed(1), 544, lbl, { size: 11.5, fill: pal.muted, anchor, num: true });
    }
    return `
  ${txt(PAD, 432, t('activity'), { size: 14, fill: pal.secondary, weight: 500 })}
  ${txt(RIGHT, 432, activeSummary, { size: 14, fill: pal.secondary, anchor: 'end', num: true })}
  ${svg}`;
  }

  // 2. Last 7 days: 7 wide columns with weekday + day-of-month labels.
  if (periodKey === 'd7') {
    const bars = dailySlice.slice(-7);
    const activeSummary = t('activeDaysOf', activeDailyCount, Math.max(1, bars.length));
    const chartTop = 468;
    const chartH = 54;
    const baseY = chartTop + chartH;
    let svg = `<line x1="${PAD}" y1="${baseY + 0.5}" x2="${RIGHT}" y2="${baseY + 0.5}" stroke="${pal.lineStrong}" stroke-width="1"/>`;
    let peakSvg = '';
    if (bars.length) {
      const maxTok = bars.reduce((mx, d) => Math.max(mx, d.tokens), 0);
      const gap = 14;
      const bw = Math.min(148, (chartW - gap * Math.max(0, bars.length - 1)) / bars.length);
      const total = bars.length * bw + Math.max(0, bars.length - 1) * gap;
      const x0 = RIGHT - total;
      svg += bars.map((d, i) => {
        const x = x0 + i * (bw + gap);
        const isLast = i === bars.length - 1;
        let bh = 2.5;
        let fill = pal.empty;
        let rx = 1;
        if (d.tokens > 0 && maxTok > 0) {
          bh = Math.max(5, (d.tokens / maxTok) * chartH);
          fill = isLast ? pal.accent : pal.bar;
          rx = 2;
        } else if (d.calls > 0) {
          bh = 4;
          fill = isLast ? pal.accent : pal.bar;
          rx = 1.5;
        }
        const lbl = formatDayTick(d.date, t, normLang);
        if (i === bars.length - 1) peakSvg = avgAndPeak(bars, maxTok, chartH, baseY, x0, bw, gap, pal, txt, t);
        const lblFill = isLast ? pal.fg : pal.muted;
        const lblWeight = isLast ? 500 : 400;
        return `<rect x="${x.toFixed(1)}" y="${(baseY - bh).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="${rx}" fill="${fill}"/>`
          + txt((x + bw / 2).toFixed(1), 544, lbl, { size: 12, fill: lblFill, weight: lblWeight, anchor: 'middle', num: true });
      }).join('');
      svg += peakSvg;
    }
    return `
  ${txt(PAD, 432, t('activity'), { size: 14, fill: pal.secondary, weight: 500 })}
  ${txt(RIGHT, 432, activeSummary, { size: 14, fill: pal.secondary, anchor: 'end', num: true })}
  ${svg}`;
  }

  // 3. All time (with >= 14 days): multi-week 7-row GitHub-style calendar heatmap.
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
      for (let i = 0; i < weeks * 7; i += 1) {
        days.push(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
      }
      const level = makeHeatScale(days.filter((d) => d <= end).map((d) => safeNum((byDay.get(dayKey(d)) || {}).tokens)));
      const cell = 9;
      const gap = 2;
      const gridTop = 452;
      const gridX0 = PAD + 28;
      const wd = t('weekdays');
      let svg = '';
      for (const r of [1, 3, 5]) {
        const cy = gridTop + r * (cell + gap) + cell - 1;
        svg += txt(PAD, cy, wd[r] || '', { size: 10.5, fill: pal.muted });
      }
      const opacities = [0, 0.30, 0.52, 0.76, 1];
      let activeDaysInGrid = 0;
      days.forEach((d, i) => {
        if (d > end) return;
        const col = Math.floor(i / 7);
        const row = i % 7;
        const e = byDay.get(dayKey(d)) || { tokens: 0, calls: 0 };
        if (e.tokens > 0 || e.calls > 0) activeDaysInGrid += 1;
        const lv = level(e.tokens);
        const x = gridX0 + col * (cell + gap);
        const y = gridTop + row * (cell + gap);
        if (lv === 0) {
          svg += `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="2" fill="${pal.empty}"/>`;
        } else {
          svg += `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="2" fill="${pal.accent}" fill-opacity="${opacities[lv]}"/>`;
        }
      });
      let lastLabelCol = -9;
      const minGap = weeks > 36 ? 5 : 3;
      for (let w = 0; w < weeks; w += 1) {
        const first = days[w * 7];
        const monthStart = days.slice(w * 7, w * 7 + 7).find((d) => d.getDate() === 1);
        if ((w === 0 || monthStart) && w - lastLabelCol >= minGap && w <= weeks - 3) {
          const mLbl = formatMonthLabel(monthStart || first, normLang);
          svg += txt(gridX0 + w * (cell + gap), 546, mLbl, { size: 11, fill: pal.muted });
          lastLabelCol = w;
        }
      }
      // Compact Less -> More legend anchored cleanly at the bottom-right.
      const legY = 538;
      const legCell = 9;
      const legGap = 3;
      const moreTxt = t('more');
      const lessTxt = t('less');
      const scaleW = 5 * legCell + 4 * legGap;
      const moreSpace = normLang === 'zh' ? 18 : 34;
      const scaleStartX = RIGHT - moreSpace - scaleW;
      svg += txt(scaleStartX - 6, 546, lessTxt, { size: 11, fill: pal.muted, anchor: 'end' });
      for (let lv = 0; lv <= 4; lv += 1) {
        const lx = scaleStartX + lv * (legCell + legGap);
        if (lv === 0) svg += `<rect x="${lx}" y="${legY}" width="${legCell}" height="${legCell}" rx="2" fill="${pal.empty}"/>`;
        else svg += `<rect x="${lx}" y="${legY}" width="${legCell}" height="${legCell}" rx="2" fill="${pal.accent}" fill-opacity="${opacities[lv]}"/>`;
      }
      svg += txt(RIGHT, 546, moreTxt, { size: 11, fill: pal.muted, anchor: 'end' });
      return `
  ${txt(PAD, 432, t('activity'), { size: 14, fill: pal.secondary, weight: 500 })}
  ${txt(RIGHT, 432, t('activeDays', activeDaysInGrid, weeks), { size: 14, fill: pal.secondary, anchor: 'end', num: true })}
  ${svg}`;
    }
  }

  // 4. Last 30 days (and sparse All-time fallback): full-width bar timeline with MM-DD ticks.
  const bars = periodKey === 'd30' ? dailySlice.slice(-30) : dailySlice;
  const activeSummary = t('activeDaysOf', activeDailyCount, Math.max(1, dailySlice.length));
  const chartTop = 468;
  const chartH = 54;
  const baseY = chartTop + chartH;
  let barsSvg = `<line x1="${PAD}" y1="${baseY + 0.5}" x2="${RIGHT}" y2="${baseY + 0.5}" stroke="${pal.lineStrong}" stroke-width="1"/>`;
  if (bars.length) {
    const maxDay = bars.reduce((mx, d) => Math.max(mx, d.tokens), 0);
    const gap = bars.length > 40 ? 3 : 6;
    const bw = Math.min(80, (chartW - gap * Math.max(0, bars.length - 1)) / bars.length);
    const total = bars.length * bw + Math.max(0, bars.length - 1) * gap;
    const x0 = RIGHT - total;
    barsSvg += bars.map((d, i) => {
      const ratio = maxDay > 0 ? d.tokens / maxDay : 0;
      const bh = d.tokens > 0 ? Math.max(4, ratio * chartH) : 2.5;
      const fill = i === bars.length - 1 && d.tokens > 0 ? pal.accent : (d.tokens > 0 ? pal.bar : pal.empty);
      return `<rect x="${(x0 + i * (bw + gap)).toFixed(1)}" y="${(baseY - bh).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="2" fill="${fill}"/>`;
    }).join('');
    barsSvg += avgAndPeak(bars, maxDay, chartH, baseY, x0, bw, gap, pal, txt, t);
    if (bars.length === 1) {
      barsSvg += txt(RIGHT, 544, bars[0].date.slice(5), { size: 11.5, fill: pal.muted, anchor: 'end', num: true });
    } else {
      barsSvg += txt(x0.toFixed(1), 544, bars[0].date.slice(5), { size: 11.5, fill: pal.muted, anchor: 'start', num: true });
      if (bars.length >= 7) {
        const mid = Math.floor((bars.length - 1) / 2);
        const midX = x0 + mid * (bw + gap) + bw / 2;
        barsSvg += txt(midX.toFixed(1), 544, bars[mid].date.slice(5), { size: 11.5, fill: pal.muted, anchor: 'middle', num: true });
      }
      barsSvg += txt(RIGHT, 544, bars[bars.length - 1].date.slice(5), { size: 11.5, fill: pal.muted, anchor: 'end', num: true });
    }
  }
  return `
  ${txt(PAD, 432, t('activity'), { size: 14, fill: pal.secondary, weight: 500 })}
  ${txt(RIGHT, 432, activeSummary, { size: 14, fill: pal.secondary, anchor: 'end', num: true })}
  ${barsSvg}`;
}

function estimateLabelWidth(s) {
  let w = 0;
  for (const ch of String(s || '')) w += ch.codePointAt(0) > 127 ? 12.2 : 7.4;
  return Math.max(36, Math.round(w));
}

export function buildShareCardSvg(input = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const periodKey = VALID_PERIODS.has(src.period) ? src.period : 'd30';
  const normLang = normalizeLang(src.lang);
  const t = createTranslator(normLang);
  const pal = src.theme === 'light' ? THEMES.light : THEMES.dark;
  const quip = typeof src.quip === 'string' ? truncateLabel(scrubSensitiveText(src.quip), 40) : '';
  const W = SHARE_CARD_WIDTH;
  const H = SHARE_CARD_HEIGHT;
  const PLATE_X = 24;
  const PLATE_Y = 24;
  const PLATE_W = W - 48;
  const PLATE_H = H - 48;
  const PLATE_R = PLATE_X + PLATE_W;
  const PLATE_B = PLATE_Y + PLATE_H;
  const PAD = 56;
  const MID_X = 616;
  const COL2 = 640;
  const RIGHT = W - PAD;
  const sans = `font-family="${FONT_SANS}"`;
  const nums = `${sans} style="font-variant-numeric:tabular-nums"`;
  const txt = (x, y, s, { size = 15, fill = pal.muted, weight = 400, anchor = 'start', num = false, ls = null } = {}) => (
    `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}"${anchor !== 'start' ? ` text-anchor="${anchor}"` : ''}${ls ? ` letter-spacing="${ls}"` : ''} ${num ? nums : sans}>${escapeXml(s)}</text>`
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

  const rawByModel = Array.isArray(src.byModel) ? src.byModel : (Array.isArray(src.by_model) ? src.by_model : []);
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

  const defs = `<defs>
    <linearGradient id="agy-sc-bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#1c212a"/><stop offset="100%" stop-color="#11141a"/></linearGradient>
    <linearGradient id="agy-sc-rim" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="${pal.series[2]}"/><stop offset="100%" stop-color="${pal.series[0]}"/></linearGradient>
    <clipPath id="agy-sc-left-clip"><rect x="${PLATE_X + 1}" y="89" width="${MID_X - PLATE_X - 2}" height="316"/></clipPath>
    <clipPath id="agy-sc-mix-clip"><rect x="${PAD}" y="372" width="532" height="4" rx="2"/></clipPath>
  </defs>`;

  // Architectural exhibition frame + optical viewfinder brackets + reticle crosshairs.
  const brackets = [
    `M${PLATE_X} ${PLATE_Y + 10}V${PLATE_Y}H${PLATE_X + 10}`,
    `M${PLATE_R - 10} ${PLATE_Y}H${PLATE_R}V${PLATE_Y + 10}`,
    `M${PLATE_X} ${PLATE_B - 10}V${PLATE_B}H${PLATE_X + 10}`,
    `M${PLATE_R - 10} ${PLATE_B}H${PLATE_R}V${PLATE_B - 10}`,
  ].join(' ');
  const frame = `<rect x="0" y="0" width="${W}" height="${H}" fill="${pal.bg}"/>
  <rect x="${PLATE_X}" y="${PLATE_Y}" width="${PLATE_W}" height="${PLATE_H}" rx="4" fill="${pal.plate}" stroke="${pal.line}" stroke-width="1"/>
  <path d="${brackets}" fill="none" stroke="${pal.lineStrong}" stroke-width="1.5" stroke-linecap="square"/>
  <line x1="${PLATE_X}" y1="88" x2="${PLATE_R}" y2="88" stroke="${pal.line}" stroke-width="1"/>
  <line x1="${MID_X}" y1="88" x2="${MID_X}" y2="406" stroke="${pal.line}" stroke-width="1"/>
  <line x1="${PLATE_X}" y1="406" x2="${PLATE_R}" y2="406" stroke="${pal.line}" stroke-width="1"/>
  <line x1="${PLATE_X}" y1="564" x2="${PLATE_R}" y2="564" stroke="${pal.line}" stroke-width="1"/>
  <path d="M${MID_X - 3} 88h6M${MID_X} 85v6M${MID_X - 3} 406h6M${MID_X} 403v6" stroke="${pal.lineStrong}" stroke-width="1"/>`;

  const logo = `<g transform="translate(${PAD},${41}) scale(0.5)">
    <rect x="1" y="1" width="62" height="62" rx="15" fill="url(#agy-sc-bg)" stroke="#303846" stroke-width="1.25"/>
    <g fill="#2b3341"><circle cx="15" cy="49" r="2"/><circle cx="26" cy="49" r="2"/><circle cx="49" cy="15" r="2"/><circle cx="49" cy="26" r="2"/><circle cx="49" cy="37" r="2"/></g>
    <line x1="40.6" y1="40.6" x2="51.2" y2="51.2" stroke="url(#agy-sc-rim)" stroke-width="5.2" stroke-linecap="round"/>
    <circle cx="28.5" cy="28.5" r="16.5" fill="#141e30" stroke="url(#agy-sc-rim)" stroke-width="3.2"/>
    <g>
      <circle cx="21.7" cy="21.7" r="2.35" fill="${pal.series[0]}"/><circle cx="28.5" cy="21.7" r="2.35" fill="${pal.series[0]}"/><circle cx="35.3" cy="21.7" r="2.35" fill="${pal.series[2]}"/>
      <circle cx="21.7" cy="28.5" r="2.35" fill="${pal.series[0]}"/><circle cx="28.5" cy="28.5" r="2.35" fill="${pal.series[1]}"/><circle cx="35.3" cy="28.5" r="2.35" fill="${pal.series[3]}"/>
      <circle cx="21.7" cy="35.3" r="2.35" fill="#81c995"/><circle cx="28.5" cy="35.3" r="2.35" fill="${pal.series[0]}"/><circle cx="35.3" cy="35.3" r="2.35" fill="#334155"/>
    </g>
    <path d="M17.5 22.8 A12.5 12.5 0 0 1 25.5 16.4" fill="none" stroke="#ffffff" stroke-opacity="0.28" stroke-width="1.6" stroke-linecap="round"/>
  </g>`;
  const stampW = estimateLabelWidth(periodLabel) + 18;
  const header = `${logo}
  ${txt(PAD + 42, 63, 'Agy Lens', { size: 19, fill: pal.fg, weight: 600 })}
  <line x1="${PAD + 138}" y1="47" x2="${PAD + 138}" y2="67" stroke="${pal.lineStrong}" stroke-width="1"/>
  <rect x="${PAD + 150}" y="45" width="${stampW}" height="24" rx="4" fill="${pal.recess}" stroke="${pal.line}"/>
  ${txt(PAD + 150 + stampW / 2, 61.5, periodLabel, { size: 12, fill: pal.secondary, weight: 500, anchor: 'middle' })}
  ${txt(RIGHT, 62, spanStr ? `${periodLabel} · ${spanStr}` : periodLabel, { size: 14, fill: pal.secondary, anchor: 'end', num: true })}`;

  // Left Specimen Chamber: quiet aperture reticle + hero tokens + quip plate + 3-col instrument ledger + token mix bar.
  const aperture = `<g clip-path="url(#agy-sc-left-clip)" fill="none" stroke="${pal.lineStrong}">
    <circle cx="515" cy="168" r="78" stroke-width="1" stroke-opacity="0.32" stroke-dasharray="3 5"/>
    <circle cx="515" cy="168" r="106" stroke-width="1" stroke-opacity="0.24"/>
    <path d="M505 168h20M515 158v20" stroke-width="1" stroke-opacity="0.35"/>
  </g>`;

  const stats = [
    [t('colCost'), costStr],
    [t('colCalls'), fmtInt(calls, normLang)],
    [t('colConvs'), fmtInt(convs, normLang)],
  ];
  const statW = 178;
  const mixTotal = inp + out + cache;
  let mixBarSvg = `<rect x="${PAD}" y="372" width="532" height="4" rx="2" fill="${pal.empty}"/>`;
  if (mixTotal > 0) {
    const wIn = Math.max(inp > 0 ? 4 : 0, (inp / mixTotal) * 532);
    const wOut = Math.max(out > 0 ? 4 : 0, (out / mixTotal) * 532);
    const wCache = Math.max(0, 532 - wIn - wOut);
    mixBarSvg += `<g clip-path="url(#agy-sc-mix-clip)">
      ${wIn > 0 ? `<rect x="${PAD}" y="372" width="${wIn.toFixed(1)}" height="4" fill="${pal.series[0]}"/>` : ''}
      ${wOut > 0 ? `<rect x="${(PAD + wIn).toFixed(1)}" y="372" width="${wOut.toFixed(1)}" height="4" fill="${pal.series[1]}"/>` : ''}
      ${wCache > 0 ? `<rect x="${(PAD + wIn + wOut).toFixed(1)}" y="372" width="${wCache.toFixed(1)}" height="4" fill="${pal.bar}"/>` : ''}
    </g>`;
  }

  const left = `${aperture}
  ${txt(PAD, 196, fmtTok(totalNew), { size: 98, fill: pal.fg, weight: 600, num: true, ls: '-0.03em' })}
  ${txt(PAD, 228, `${t('tokens')} · ${t('exclCache')}`, { size: 15, fill: pal.secondary })}
  ${quip ? `<rect x="${PAD}" y="246" width="532" height="36" rx="4" fill="${pal.recess}" stroke="${pal.line}"/><rect x="${PAD}" y="246" width="3" height="36" rx="1.5" fill="${pal.accent}"/>${txt(PAD + 16, 269, quip, { size: 15, fill: pal.fg, weight: 500 })}` : ''}
  ${stats.map(([label, value], i) => {
    const colX = PAD + i * statW;
    const textX = colX + (i > 0 ? 18 : 0);
    const sep = i > 0 ? `<line x1="${colX}" y1="304" x2="${colX}" y2="356" stroke="${pal.line}" stroke-width="1"/>` : '';
    return `${sep}
  ${txt(textX, 316, label, { size: 13, fill: pal.muted })}
  ${txt(textX, 348, value, { size: 26, fill: pal.fg, weight: 600, num: true })}`;
  }).join('')}
  ${mixBarSvg}
  ${txt(PAD, 392, `${t('legInput')} ${fmtTok(inp)}  ·  ${t('legOutput')} ${fmtTok(out)}  ·  ${t('legCache')} ${fmtTok(cache)}`, { size: 13, fill: pal.secondary, num: true })}`;

  // Right Optical Matrix Chamber: recessed 100-dot well + quarter-scale ticks + ranked model ledger.
  const topModels = models.slice(0, 4);
  const extraModels = Math.max(0, models.length - topModels.length);
  const sumNew = models.reduce((acc, m) => acc + m.input + m.output, 0);
  const groups = topModels.map((m, i) => ({ name: m.name, tok: m.input + m.output, color: pal.series[i] }));
  const restTok = Math.max(0, sumNew - groups.reduce((a, g) => a + g.tok, 0));
  if (restTok > 0) groups.push({ name: '', tok: restTok, color: pal.rest });
  const dots = new Array(100).fill(pal.empty);
  if (sumNew > 0) {
    const exact = groups.map((g) => (g.tok / sumNew) * 100);
    const counts = exact.map(Math.floor);
    let left100 = 100 - counts.reduce((a, b) => a + b, 0);
    exact.map((v, i) => [v - Math.floor(v), i]).sort((a, b) => b[0] - a[0]).forEach(([, i]) => {
      if (left100 > 0) { counts[i] += 1; left100 -= 1; }
    });
    let k = 0;
    groups.forEach((g, i) => { for (let c = 0; c < counts[i] && k < 100; c += 1) dots[k++] = g.color; });
  }
  const PITCH = 24;
  const R = 8.5;
  const gridX0 = 655.5;
  const gridTop = 121.5;
  const matrixTicks = [5, 10, 15].map((c) => {
    const tx = gridX0 + R + (c - 0.5) * PITCH;
    return `<line x1="${tx.toFixed(1)}" y1="104" x2="${tx.toFixed(1)}" y2="110" stroke="${pal.lineStrong}" stroke-width="1"/>`;
  }).join('');
  const dotsSvg = `<rect x="${COL2}" y="104" width="504" height="148" rx="6" fill="${pal.recess}" stroke="${pal.line}"/>${matrixTicks}` + dots.map((fill, i) => {
    const cx = gridX0 + R + (i % 20) * PITCH;
    const cy = gridTop + R + Math.floor(i / 20) * PITCH;
    return `<circle cx="${cx}" cy="${cy}" r="${R}" fill="${fill}"/>`;
  }).join('');

  let legend;
  if (!topModels.length) {
    legend = txt(COL2, 298, t('noModels'), { size: 14, fill: pal.muted });
  } else {
    const trackW = RIGHT - COL2 - 18;
    legend = topModels.map((m, i) => {
      const y = 294 + i * 25;
      const mNew = m.input + m.output;
      const share = sumNew > 0 ? fmtPctNum((mNew / sumNew) * 100) : '0%';
      const barW = sumNew > 0 ? Math.max(2, (trackW * mNew) / sumNew) : 0;
      return `<rect x="${COL2}" y="${y - 9}" width="8" height="8" rx="2" fill="${pal.series[i]}"/>
  <rect x="${COL2 + 18}" y="${y + 5}" width="${trackW.toFixed(1)}" height="2" rx="1" fill="${pal.empty}"/><rect x="${COL2 + 18}" y="${y + 5}" width="${barW.toFixed(1)}" height="2" rx="1" fill="${pal.series[i]}"/>
  ${txt(COL2 + 18, y, truncateLabel(m.name, 28), { size: 14, fill: pal.fg, weight: 500 })}
  ${txt(RIGHT, y, `${fmtTok(mNew)} · ${share}`, { size: 14, fill: pal.secondary, anchor: 'end', num: true })}`;
    }).join('\n  ');
    if (extraModels > 0) {
      const my = 294 + topModels.length * 25;
      legend += `\n  <rect x="${COL2}" y="${my - 9}" width="8" height="8" rx="2" fill="${pal.rest}"/>
  ${txt(COL2 + 18, my, t('shareMoreModels', extraModels), { size: 13.5, fill: pal.muted })}`;
    }
  }
  const right = `${dotsSvg}
  ${txt(RIGHT, 269, t('shareDotNote'), { size: 12.5, fill: pal.muted, anchor: 'end' })}
  ${legend}`;

  const hourly = sanitizeHourly(src.hourlyToday ?? src.hourly_today);
  const activity = renderActivitySection({ periodKey, dailySlice, hourly, pal, PAD, RIGHT, t, normLang, txt });

  const footer = `
  ${txt(PAD, 589, t('shareFooter'), { size: 12.5, fill: pal.dim })}
  ${txt(RIGHT, 589, 'github.com/Aoike123/agy-lens', { size: 12.5, fill: pal.dim, anchor: 'end' })}`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeXml(t('shareAria'))}">
  ${defs}
  ${frame}
  ${header}
  ${left}
  ${right}
  ${activity}
  ${footer}
</svg>`;
}

// --- browser-only helpers (never called during pure Node import/SVG tests) ---

let modalState = {
  open: false,
  style: 'minimal-dark',
  styleChosen: false,
  data: null,
  period: 'd30',
  lang: 'en',
  t: null,
  quipIdx: 0,
  assetError: false,
  ambient: null,
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

export async function exportShareCardPng(svgString, filename = 'agy-lens-usage.png', { scale = 2, download = true } = {}) {
  const width = SHARE_CARD_WIDTH * scale;
  const height = SHARE_CARD_HEIGHT * scale;
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
    ctx.drawImage(img, 0, 0, SHARE_CARD_WIDTH, SHARE_CARD_HEIGHT);

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

export const SHARE_STYLES = ['minimal-dark', 'minimal-light', 'pixel-role'];

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
    if (modalState.open) renderPreview();
  });
}

const charArt = (classId, stage, live) => (live && assetUri(charIdlePath(classId, stage))) || assetUri(charStillPath(classId, stage));

// --- card for the current style ---------------------------------------------------------

/** `live` = panel preview (animated idles); export always uses still frames. */
function currentSvg({ live = false } = {}) {
  const d = hist();
  const style = modalState.style;
  if (style === 'pixel-role') {
    const prof = currentProfile();
    return buildRoleCardSvg({
      profile: prof,
      achievements: currentAchievements(prof),
      art: { char: charArt(prof.classId, prof.stage, live), arena: assetUri(arenaPath(CLASS_ARENA[prof.classId])) },
      lang: modalState.lang,
      arena: CLASS_ARENA[prof.classId],
    });
  }
  const quips = buildQuips(d, modalState.period);
  const entry = quips[modalState.quipIdx % quips.length];
  return buildShareCardSvg({
    period: modalState.period,
    totals: d.totals,
    byModel: d.by_model,
    daily: d.daily,
    hourlyToday: d.hourly_today,
    d7ByPool: d.d7_by_pool,
    lang: modalState.lang,
    theme: style === 'minimal-light' ? 'light' : 'dark',
    quip: quipText(entry, modalState.lang),
  });
}

function setShareStatus(text, isErr = false) {
  const modal = document.getElementById('share-modal');
  if (!modal) return;
  const el = modal.querySelector('.share-status');
  if (!el) return;
  el.textContent = text || '';
  el.classList.toggle('err', Boolean(isErr));
  el.hidden = !text;
}

function isReducedMotion() {
  try {
    return Boolean(typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch {
    return false;
  }
}

function startAmbientLoop(canvas, arenaId, { seed = 1, reducedMotion = false } = {}) {
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
    ctx2d.putImageData(imgData, 0, 0);
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

function startAmbientIfNeeded() {
  stopAmbient();
  if (!modalState.open || modalState.style !== 'pixel-role') return;
  const canvas = document.querySelector('#share-modal .share-vfx-canvas');
  if (!canvas) return;
  const prof = currentProfile();
  const arena = CLASS_ARENA[prof.classId] || 'observatory';
  modalState.ambient = startAmbientLoop(canvas, arena, { seed: prof.level * 17 + 5, reducedMotion: isReducedMotion() });
}

function stageHtml(svg) {
  const overlay = modalState.style === 'pixel-role'
    ? '<canvas class="share-vfx-canvas" width="400" height="210" aria-hidden="true"></canvas>'
    : '';
  return `<div class="share-stage">${svg}${overlay}</div>`;
}

function renderPreview() {
  const modal = document.getElementById('share-modal');
  const box = modal && modal.querySelector('.share-preview');
  if (!box) return;
  box.innerHTML = stageHtml(currentSvg({ live: true }));
  startAmbientIfNeeded();
}

function controlsHtml(t) {
  const style = modalState.style;
  const pk = modalState.pk;
  if (style === 'minimal-dark' || style === 'minimal-light') {
    return `<div class="share-ctrl-row"><button type="button" class="fchip" data-share-quip>${esc(t('shareQuipNext'))}</button></div>`;
  }
  const prof = currentProfile();
  const nick = `<label class="share-field"><span>${esc(t('shareNickLabel'))}</span><input type="text" data-share-nick maxlength="16" value="${esc(pk.nickname)}" placeholder="${esc(t('shareNickPlaceholder'))}" spellcheck="false" autocomplete="off"></label>`;
  const gender = prof.classId === 'novice'
    ? `<div class="share-theme" role="group" aria-label="${esc(t('shareGenderLabel'))}">${['male', 'female'].map((g) => `<button type="button" class="fchip" data-share-gender="${g}" aria-pressed="${pk.gender === g}">${esc(t(g === 'male' ? 'shareGenderMale' : 'shareGenderFemale'))}</button>`).join('')}</div>`
    : '';
  return `<div class="share-ctrl-row">${nick}${gender}</div>`;
}

function renderShareModal() {
  const modal = ensureShareModal();
  const t = tr();
  const styles = t('shareStyles');
  stopAmbient();
  modal.innerHTML = `<div class="share-dialog" data-style="${esc(modalState.style)}" role="dialog" aria-modal="true" aria-labelledby="share-modal-title">
    <div class="share-head">
      <div class="share-head-copy">
        <div id="share-modal-title" class="share-title">${esc(t('shareCardTitle'))}</div>
        <div class="share-privacy">${esc(t('sharePrivacy'))}</div>
      </div>
      <button type="button" class="share-close" data-share-close aria-label="${esc(t('shareClose'))}" title="${esc(t('shareClose'))}">&times;</button>
    </div>
    <div class="share-styles" role="group" aria-label="${esc(t('shareStyleLabel'))}">
      ${SHARE_STYLES.map((s) => `<button type="button" class="fchip" data-share-style="${s}" aria-pressed="${modalState.style === s}">${esc(styles[s])}</button>`).join('')}
    </div>
    <div class="share-preview">${stageHtml(currentSvg({ live: true }))}</div>
    <div class="share-controls">${controlsHtml(t)}</div>
    <div class="share-foot">
      <span class="share-status" hidden></span>
      <div class="share-actions">
        <button type="button" data-share-svg>${esc(t('copySvg'))}</button>
        <button type="button" class="share-primary" data-share-png>${esc(t('copyPng'))}</button>
      </div>
    </div>
  </div>`;
  if (modalState.style === 'pixel-role') {
    loadAssetList().then(() => {
      if (modalState.assetError) setShareStatus(tr()('shareAssetsFail'), true);
    });
    ensureArt();
    startAmbientIfNeeded();
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
      if (modalState.open) renderShareModal();
    })
    .catch(() => {});
}

function onShareModalClick(e) {
  const modal = e.currentTarget;
  if (e.target === modal || e.target.closest('[data-share-close]')) {
    closeShareCardModal();
    return;
  }
  const t = tr();
  const styleBtn = e.target.closest('[data-share-style]');
  if (styleBtn) {
    const next = styleBtn.dataset.shareStyle;
    if (SHARE_STYLES.includes(next) && next !== modalState.style) {
      modalState.style = next;
      modalState.styleChosen = true;
      renderShareModal();
    }
    return;
  }
  if (e.target.closest('[data-share-quip]')) {
    modalState.quipIdx += 1;
    renderPreview();
    return;
  }
  const genderBtn = e.target.closest('[data-share-gender]');
  if (genderBtn) {
    modalState.pk.gender = genderBtn.dataset.shareGender === 'female' ? 'female' : 'male';
    modalState.pk.touched = true;
    saveProfileSoon();
    renderShareModal();
    return;
  }
  if (e.target.closest('[data-share-svg]')) {
    withExportArt().then(() => copyShareCardSvg(currentSvg()))
      .then(() => setShareStatus(t('shareCopied', 'SVG')))
      .catch(() => setShareStatus(t('shareCopyFail'), true));
    return;
  }
  if (e.target.closest('[data-share-png]')) {
    // Build the SVG synchronously when art is cached so the clipboard write keeps the user gesture.
    const ready = neededArt().every((p) => assetCache.has(p));
    const run = () => copyShareCardPng(currentSvg())
      .then(() => setShareStatus(t('shareCopied', 'PNG')))
      .catch((err) => {
        const isClip = err && (err.code === 'CLIPBOARD_UNAVAILABLE' || err.code === 'CLIPBOARD_DENIED');
        setShareStatus(t(isClip ? 'shareCopyPngFail' : 'sharePngFail'), true);
      });
    if (ready) run();
    else withExportArt().then(run);
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
    saveProfileSoon();
    renderPreview();
  }
}

function onShareKeydown(e) {
  if (e.key === 'Escape' && modalState.open) {
    e.preventDefault();
    closeShareCardModal();
  }
}

function ensureShareModal() {
  let modal = document.getElementById('share-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'share-modal';
    modal.className = 'share-modal';
    modal.hidden = true;
    modal.addEventListener('click', onShareModalClick);
    modal.addEventListener('input', onShareModalInput);
    document.addEventListener('keydown', onShareKeydown);
    document.body.appendChild(modal);
  }
  return modal;
}

export function openShareCardModal({ data, period = 'd30', lang = 'en', t } = {}) {
  const prevPk = modalState.pk;
  modalState = {
    open: true,
    style: modalState.style && SHARE_STYLES.includes(modalState.style) && modalState.styleChosen
      ? modalState.style
      : (detectPreferredTheme() === 'light' ? 'minimal-light' : 'minimal-dark'),
    styleChosen: modalState.styleChosen,
    data: data || {},
    period: VALID_PERIODS.has(period) ? period : 'd30',
    lang: normalizeLang(lang),
    t: t || createTranslator(lang),
    quipIdx: 0,
    assetError: false,
    ambient: null,
    pk: {
      nickname: prevPk ? prevPk.nickname : '',
      gender: prevPk ? prevPk.gender : 'male',
      touched: prevPk ? prevPk.touched : false,
      saveTimer: 0,
    },
  };
  const modal = ensureShareModal();
  renderShareModal();
  modal.hidden = false;
  loadShareProfileState();
  const closeBtn = modal.querySelector('[data-share-close]');
  if (closeBtn) closeBtn.focus();
}

export function refreshShareCardModal({ data, period, lang, t } = {}) {
  if (!modalState.open) return;
  const langChanged = lang && normalizeLang(lang) !== modalState.lang;
  if (data !== undefined) modalState.data = data;
  if (period && VALID_PERIODS.has(period)) modalState.period = period;
  if (lang) modalState.lang = normalizeLang(lang);
  if (t) modalState.t = t;
  // Keep inputs (and their focus) intact on background data refreshes.
  if (langChanged) renderShareModal();
  else {
    renderPreview();
    ensureArt();
  }
}

export function closeShareCardModal() {
  modalState.open = false;
  stopAmbient();
  const modal = document.getElementById('share-modal');
  if (modal) modal.hidden = true;
}
