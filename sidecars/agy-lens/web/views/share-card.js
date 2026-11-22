// Sanitized History Share Card SVG generator, modal preview, and SVG/PNG exporters.
// buildShareCardSvg, escapeXml, and scrubSensitiveText are pure Node-runnable with zero DOM/browser globals.

import { createTranslator, normalizeLang } from '../i18n.js';
import { esc, fmtCost, fmtInt, fmtPctNum, fmtTok, isNum } from '../format.js';

export const SHARE_CARD_WIDTH = 1200;
export const SHARE_CARD_HEIGHT = 630;

const VALID_PERIODS = new Set(['today', 'd7', 'd30', 'all']);
const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const FONT_SANS = "system-ui, -apple-system, 'Segoe UI', Roboto, 'PingFang SC', 'Microsoft YaHei', sans-serif";
const FONT_MONO = "ui-monospace, 'Cascadia Mono', 'SF Mono', Menlo, Consolas, monospace";

const THEMES = {
  // Graphite neutrals; colour is reserved for the model series and the latest day.
  dark: {
    bg: '#131314',
    logoBg: '#1f2023',
    fg: '#e3e3e3',
    secondary: '#c4c7c5',
    muted: '#8e918f',
    dim: '#6f7271',
    line: '#2a2b2d',
    empty: '#26272a',
    bar: '#4a4d51',
    rest: '#5f6368',
    accent: '#4c8df6',
    series: ['#4c8df6', '#f9ab00', '#a8c7fa', '#c58af9'],
  },
  light: {
    bg: '#fbfbfa',
    logoBg: '#1f2937',
    fg: '#1f1f1f',
    secondary: '#444746',
    muted: '#5e6261',
    dim: '#80868b',
    line: '#e3e3e3',
    empty: '#ebecec',
    bar: '#bdc1c6',
    rest: '#9aa0a6',
    accent: '#1a73e8',
    series: ['#1a73e8', '#e37400', '#7baaf7', '#9334e6'],
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
    (b.input + b.output + b.cache_read) - (a.input + a.output + a.cache_read)
    || (b.input + b.output) - (a.input + a.output)
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

function downsampleBars(items, maxBars = 30) {
  if (items.length <= maxBars) return items;
  const bucketSize = Math.ceil(items.length / maxBars);
  const out = [];
  for (let i = 0; i < items.length; i += bucketSize) {
    const slice = items.slice(i, i + bucketSize);
    let tokens = 0;
    let calls = 0;
    for (const s of slice) {
      tokens += s.tokens;
      calls += s.calls;
    }
    out.push({ date: slice[slice.length - 1].date, tokens, calls });
  }
  return out;
}

export function buildShareCardSvg(input = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const periodKey = VALID_PERIODS.has(src.period) ? src.period : 'd30';
  const normLang = normalizeLang(src.lang);
  const t = createTranslator(normLang);
  const pal = src.theme === 'light' ? THEMES.light : THEMES.dark;
  const W = SHARE_CARD_WIDTH;
  const H = SHARE_CARD_HEIGHT;
  const PAD = 56;
  const COL2 = 648;
  const RIGHT = W - PAD;
  const sans = `font-family="${FONT_SANS}"`;
  const nums = `${sans} style="font-variant-numeric:tabular-nums"`;
  const txt = (x, y, s, { size = 15, fill = pal.muted, weight = 400, anchor = 'start', num = false } = {}) => (
    `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}"${anchor !== 'start' ? ` text-anchor="${anchor}"` : ''} ${num ? nums : sans}>${escapeXml(s)}</text>`
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

  // Header: brand on the left, period and date span on the right.
  const periodLabel = scrubSensitiveText(t('periods')[periodKey] || periodKey);
  const dailyAll = sanitizeDaily(src.daily);
  let dailySlice = dailyAll;
  if (periodKey === 'today') dailySlice = dailyAll.slice(-1);
  else if (periodKey === 'd7') dailySlice = dailyAll.slice(-7);
  else if (periodKey === 'd30') dailySlice = dailyAll.slice(-30);
  let spanStr = '';
  if (dailySlice.length === 1) spanStr = dailySlice[0].date;
  else if (dailySlice.length > 1) spanStr = `${dailySlice[0].date} – ${dailySlice[dailySlice.length - 1].date}`;

  const logo = `<g transform="translate(${PAD},${PAD - 4}) scale(0.5)">
    <rect width="64" height="64" rx="14" fill="${pal.logoBg}"/>
    <g fill="${pal.series[0]}"><circle cx="16" cy="16" r="5"/><circle cx="32" cy="16" r="5"/><circle cx="48" cy="16" r="5"/><circle cx="16" cy="32" r="5"/><circle cx="32" cy="32" r="5" fill="${pal.series[1]}"/></g>
    <g fill="none" stroke="${pal.muted}" stroke-width="2.5"><rect x="43" y="27" width="10" height="10" rx="1.5"/><rect x="11" y="43" width="10" height="10" rx="1.5"/><rect x="27" y="43" width="10" height="10" rx="1.5"/><rect x="43" y="43" width="10" height="10" rx="1.5"/></g>
  </g>`;
  const header = `${logo}
  ${txt(PAD + 44, PAD + 18, 'Agy Lens', { size: 20, fill: pal.fg, weight: 500 })}
  ${txt(RIGHT, PAD + 18, spanStr ? `${periodLabel} · ${spanStr}` : periodLabel, { size: 15, anchor: 'end', num: true })}`;

  // Left column: the total, then the supporting figures.
  const stats = [
    [t('colCost'), costStr],
    [t('colCalls'), fmtInt(calls, normLang)],
    [t('colConvs'), fmtInt(convs, normLang)],
  ];
  const statW = 176;
  const left = `
  ${txt(PAD, 212, fmtTok(totalNew), { size: 96, fill: pal.fg, weight: 500, num: true })}
  ${txt(PAD, 248, `${t('tokens')} · ${t('exclCache')}`, { size: 17, fill: pal.secondary })}
  ${stats.map(([label, value], i) => `
  ${txt(PAD + i * statW, 312, label, { size: 15 })}
  ${txt(PAD + i * statW, 346, value, { size: 28, fill: pal.fg, weight: 500, num: true })}`).join('')}
  ${txt(PAD, 392, `${t('legInput')} ${fmtTok(inp)}  ·  ${t('legOutput')} ${fmtTok(out)}  ·  ${t('legCache')} ${fmtTok(cache)}`, { size: 15, num: true })}`;

  // Right column, the moment: 100 dots, one per percent of tokens, coloured by model.
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
  const PITCH = 25;
  const R = 8.5;
  const gridTop = 120;
  const dotsSvg = dots.map((fill, i) => {
    const cx = COL2 + R + (i % 20) * PITCH;
    const cy = gridTop + R + Math.floor(i / 20) * PITCH;
    return `<circle cx="${cx}" cy="${cy}" r="${R}" fill="${fill}"/>`;
  }).join('');

  let legend;
  if (!topModels.length) {
    legend = txt(COL2, 296, t('noModels'), { size: 15 });
  } else {
    legend = topModels.map((m, i) => {
      const y = 296 + i * 28;
      const mNew = m.input + m.output;
      const share = sumNew > 0 ? fmtPctNum((mNew / sumNew) * 100) : '0%';
      return `<circle cx="${COL2 + 5}" cy="${y - 5}" r="5" fill="${pal.series[i]}"/>
  ${txt(COL2 + 20, y, truncateLabel(m.name, 28), { size: 15, fill: pal.fg })}
  ${txt(RIGHT, y, `${fmtTok(mNew)} · ${share}`, { size: 15, anchor: 'end', num: true })}`;
    }).join('\n  ');
    if (extraModels > 0) {
      legend += `\n  <circle cx="${COL2 + 5}" cy="${296 + topModels.length * 28 - 5}" r="5" fill="${pal.rest}"/>
  ${txt(COL2 + 20, 296 + topModels.length * 28, t('shareMoreModels', extraModels), { size: 15 })}`;
    }
  }
  const right = `${dotsSvg}
  ${txt(RIGHT, 264, t('shareDotNote'), { size: 13, fill: pal.dim, anchor: 'end' })}
  ${legend}`;

  // Bottom: daily activity, neutral bars with the latest day in the accent.
  const bars = periodKey === 'all' ? downsampleBars(dailySlice, 60) : dailySlice;
  const activeCount = dailySlice.filter((d) => d.tokens > 0 || d.calls > 0).length;
  const activeSummary = periodKey === 'today'
    ? t('activeToday', activeCount > 0)
    : t('activeDaysOf', activeCount, Math.max(1, dailySlice.length));
  const chartTop = 470;
  const chartH = 60;
  const chartW = RIGHT - PAD;
  let barsSvg = `<line x1="${PAD}" y1="${chartTop + chartH + 0.5}" x2="${RIGHT}" y2="${chartTop + chartH + 0.5}" stroke="${pal.line}" stroke-width="1"/>`;
  if (bars.length) {
    const maxDay = bars.reduce((mx, d) => Math.max(mx, d.tokens), 0);
    const gap = bars.length > 40 ? 3 : 8;
    const bw = Math.min((chartW - gap * 6) / 7, (chartW - gap * (bars.length - 1)) / bars.length);
    const total = bars.length * bw + (bars.length - 1) * gap;
    const x0 = RIGHT - total;
    barsSvg += bars.map((d, i) => {
      const ratio = maxDay > 0 ? d.tokens / maxDay : 0;
      const bh = d.tokens > 0 ? Math.max(4, ratio * chartH) : 2;
      const fill = i === bars.length - 1 && d.tokens > 0 ? pal.accent : (d.tokens > 0 ? pal.bar : pal.empty);
      return `<rect x="${(x0 + i * (bw + gap)).toFixed(1)}" y="${(chartTop + chartH - bh).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="2" fill="${fill}"/>`;
    }).join('');
  }
  const activity = `
  ${txt(PAD, 452, t('activity'), { size: 15, fill: pal.secondary })}
  ${txt(RIGHT, 452, activeSummary, { size: 15, anchor: 'end', num: true })}
  ${barsSvg}`;

  const footer = `<line x1="${PAD}" y1="566.5" x2="${RIGHT}" y2="566.5" stroke="${pal.line}" stroke-width="1"/>
  ${txt(PAD, 598, t('shareFooter'), { size: 13, fill: pal.dim })}
  ${txt(RIGHT, 598, 'github.com/Aoike123/agy-lens', { size: 13, fill: pal.dim, anchor: 'end' })}`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeXml(t('shareAria'))}">
  <rect x="0" y="0" width="${W}" height="${H}" fill="${pal.bg}"/>
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
  theme: 'dark',
  data: null,
  period: 'd30',
  lang: 'en',
  t: null,
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
    const pngBlob = await new Promise((resolve) => {
      if (typeof canvas.toBlob === 'function') {
        canvas.toBlob((b) => resolve(b), 'image/png');
      } else {
        resolve(null);
      }
    });
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

function shareFilename(ext) {
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `agy-lens-${modalState.period || 'd30'}-${stamp}.${ext}`;
}

function currentSvg() {
  const d = modalState.data || {};
  return buildShareCardSvg({
    period: modalState.period,
    totals: d.totals,
    byModel: d.by_model,
    daily: d.daily,
    d7ByPool: d.d7_by_pool,
    lang: modalState.lang,
    theme: modalState.theme,
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

function renderShareModal() {
  const modal = ensureShareModal();
  const t = modalState.t || createTranslator(modalState.lang);
  const svg = currentSvg();
  modal.innerHTML = `<div class="share-dialog" role="dialog" aria-modal="true" aria-labelledby="share-modal-title">
    <div class="share-head">
      <div>
        <div id="share-modal-title" class="share-title">${esc(t('shareCardTitle'))}</div>
        <div class="share-privacy">${esc(t('sharePrivacy'))}</div>
      </div>
      <button type="button" class="share-close" data-share-close aria-label="${esc(t('shareClose'))}" title="${esc(t('shareClose'))}">&times;</button>
    </div>
    <div class="share-preview">${svg}</div>
    <div class="share-foot">
      <div class="share-theme" role="group" aria-label="${esc(t('shareThemeLabel'))}">
        <button type="button" class="fchip" data-share-theme="dark" aria-pressed="${modalState.theme === 'dark'}">${esc(t('shareThemeDark'))}</button>
        <button type="button" class="fchip" data-share-theme="light" aria-pressed="${modalState.theme === 'light'}">${esc(t('shareThemeLight'))}</button>
      </div>
      <div class="share-actions">
        <span class="share-status" hidden></span>
        <button type="button" data-share-svg>${esc(t('downloadSvg'))}</button>
        <button type="button" class="share-primary" data-share-png>${esc(t('downloadPng'))}</button>
      </div>
    </div>
  </div>`;
}

function onShareModalClick(e) {
  const modal = e.currentTarget;
  if (e.target === modal || e.target.closest('[data-share-close]')) {
    closeShareCardModal();
    return;
  }
  const themeBtn = e.target.closest('[data-share-theme]');
  if (themeBtn) {
    const next = themeBtn.dataset.shareTheme === 'light' ? 'light' : 'dark';
    if (next !== modalState.theme) {
      modalState.theme = next;
      renderShareModal();
    }
    return;
  }
  if (e.target.closest('[data-share-svg]')) {
    const t = modalState.t || createTranslator(modalState.lang);
    exportShareCardSvg(currentSvg(), shareFilename('svg'));
    setShareStatus(t('shareDownloaded', 'SVG'));
    return;
  }
  if (e.target.closest('[data-share-png]')) {
    const t = modalState.t || createTranslator(modalState.lang);
    exportShareCardPng(currentSvg(), shareFilename('png'))
      .then(() => setShareStatus(t('shareDownloaded', 'PNG')))
      .catch(() => setShareStatus(t('sharePngFail'), true));
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
    document.addEventListener('keydown', onShareKeydown);
    document.body.appendChild(modal);
  }
  return modal;
}

export function openShareCardModal({ data, period = 'd30', lang = 'en', t } = {}) {
  modalState = {
    open: true,
    theme: detectPreferredTheme(),
    data: data || {},
    period: VALID_PERIODS.has(period) ? period : 'd30',
    lang: normalizeLang(lang),
    t: t || createTranslator(lang),
  };
  const modal = ensureShareModal();
  renderShareModal();
  modal.hidden = false;
  const closeBtn = modal.querySelector('[data-share-close]');
  if (closeBtn) closeBtn.focus();
}

export function refreshShareCardModal({ data, period, lang, t } = {}) {
  if (!modalState.open) return;
  if (data !== undefined) modalState.data = data;
  if (period && VALID_PERIODS.has(period)) modalState.period = period;
  if (lang) modalState.lang = normalizeLang(lang);
  if (t) modalState.t = t;
  renderShareModal();
}

export function closeShareCardModal() {
  modalState.open = false;
  const modal = document.getElementById('share-modal');
  if (modal) modal.hidden = true;
}
