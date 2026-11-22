// Pure Node.js 24+ zero-dependency classic-script bundler for modular ES modules under web/.
// Used by sidecars/agy-lens/main.mjs to serve /app.js as a single self-contained classic script
// that executes reliably inside Antigravity 2.0 sandboxed / opaque-origin WebViews.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { posix, resolve, sep } from 'node:path';

const REGEX_PREFIX_KEYWORDS = new Set([
  'return', 'throw', 'case', 'default', 'delete', 'void', 'typeof',
  'await', 'yield', 'in', 'instanceof', 'of', 'new', 'else', 'do', 'export',
]);

const STMT_HEADER_KEYWORDS = new Set(['if', 'while', 'for', 'with']);

const EXPR_CONT_TRAILING_PUNCT = new Set([
  '=', '+=', '-=', '*=', '/=', '%=', '**=', '<<=', '>>=', '>>>=', '&=', '|=', '^=',
  '&&=', '||=', '??=', '+', '-', '*', '/', '%', '**', '&', '|', '^', '&&', '||', '??',
  '==', '!=', '===', '!==', '<', '>', '<=', '>=', '<<', '>>', '>>>', '?', ':', ',',
  '.', '?.', '=>', '!', '~', '(', '[', '{',
]);

const EXPR_CONT_TRAILING_KW = new Set([
  'return', 'throw', 'case', 'delete', 'void', 'typeof', 'await', 'yield',
  'in', 'instanceof', 'new', 'else', 'do', 'of',
]);

const EXPR_CONT_LEADING_PUNCT = new Set([
  '.', '?.', '(', '[', '?', ':', '&&', '||', '??', '+', '-', '*', '/', '%', '**',
  '==', '!=', '===', '!==', '<', '>', '<=', '>=', '&', '|', '^', '<<', '>>', '>>>',
  '=', '+=', '-=', '*=', '/=', '%=', '**=', '<<=', '>>=', '>>>=', '&=', '|=', '^=',
  '&&=', '||=', '??=', ',',
]);

const EXPR_CONT_LEADING_KW = new Set(['in', 'instanceof']);

const MULTI_CHAR_PUNCT = [
  '>>>=', '===', '!==', '>>>', '<<=', '>>=', '**=', '&&=', '||=', '??=', '...',
  '?.', '=>', '++', '--', '**', '<<', '>>', '<=', '>=', '==', '!=', '&&', '||', '??',
  '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=',
];

function walkJsFiles(dir, prefix, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (ent.name.startsWith('.') || ent.name === 'node_modules') continue;
    const abs = resolve(dir, ent.name);
    const rel = prefix ? posix.join(prefix, ent.name) : ent.name;
    if (ent.isDirectory()) {
      walkJsFiles(abs, rel, out);
    } else if (ent.isFile() && ent.name.endsWith('.js')) {
      out.push({ rel, abs });
    }
  }
}

export function computeWebJsStamp(webDir) {
  if (!webDir || !existsSync(webDir)) return '-';
  const files = [];
  walkJsFiles(resolve(webDir), '', files);
  if (files.length === 0) return '-';
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const lines = [];
  for (const { rel, abs } of files) {
    try {
      const s = statSync(abs);
      if (s.isFile()) lines.push(`${rel}:${s.mtimeMs}:${s.size}`);
    } catch {
      // Ignore unreadable transient entry.
    }
  }
  if (lines.length === 0) return '-';
  return createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16);
}

export function resolveWebModule(fromRel, specifier, webDir) {
  if (typeof specifier !== 'string' || !specifier) {
    throw new Error(`Invalid module specifier: ${String(specifier)}`);
  }
  if (!webDir) {
    throw new Error('webDir is required to resolve web modules');
  }
  const qIdx = specifier.indexOf('?');
  const hIdx = specifier.indexOf('#');
  let cut = -1;
  if (qIdx >= 0 && hIdx >= 0) cut = Math.min(qIdx, hIdx);
  else if (qIdx >= 0) cut = qIdx;
  else if (hIdx >= 0) cut = hIdx;
  const cleanSpec = cut >= 0 ? specifier.slice(0, cut) : specifier;

  if (!cleanSpec.startsWith('./') && !cleanSpec.startsWith('../')) {
    throw new Error(`Unsupported non-relative module specifier "${specifier}" from "${fromRel}"`);
  }

  const fromPosix = String(fromRel || '').replace(/\\/g, '/');
  const fromDir = posix.dirname(fromPosix);
  const joined = posix.join(fromDir === '.' ? '' : fromDir, cleanSpec);
  const rel = posix.normalize(joined);

  if (!rel || rel === '.' || rel === '..' || rel.startsWith('../') || posix.isAbsolute(rel)) {
    throw new Error(`Module specifier escapes web root: "${specifier}" from "${fromRel}"`);
  }

  const rootAbs = resolve(webDir);
  const abs = resolve(rootAbs, ...rel.split('/'));
  const rootPrefix = rootAbs.endsWith(sep) ? rootAbs : rootAbs + sep;
  if (abs !== rootAbs && !abs.startsWith(rootPrefix)) {
    throw new Error(`Module path escapes web directory: "${specifier}" from "${fromRel}"`);
  }
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    throw new Error(`Cannot resolve module "${specifier}" from "${fromRel}" (${abs})`);
  }

  const realRoot = realpathSync(rootAbs);
  const realAbs = realpathSync(abs);
  const realRootPrefix = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
  if (realAbs !== realRoot && !realAbs.startsWith(realRootPrefix)) {
    throw new Error(`Module realpath escapes web directory: "${specifier}" from "${fromRel}"`);
  }

  return { id: rel, absPath: abs };
}

function isLineTerminator(ch) {
  return ch === '\n' || ch === '\r' || ch === '\u2028' || ch === '\u2029';
}

function isWhitespace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\v' || ch === '\f' || ch === '\u00a0' || ch === '\ufeff' || /\s/.test(ch);
}

function isAsciiDigit(ch) {
  return ch >= '0' && ch <= '9';
}

function isHexDigit(ch) {
  return (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F');
}

function isIdentStartChar(source, i) {
  const ch = source[i];
  if (!ch) return false;
  if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_' || ch === '$') return true;
  if (ch === '\\' && source[i + 1] === 'u') return true;
  const cp = source.codePointAt(i);
  if (cp > 0x7f) {
    return /\p{ID_Start}/u.test(String.fromCodePoint(cp));
  }
  return false;
}

function isIdentContinueChar(source, i) {
  const ch = source[i];
  if (!ch) return false;
  if (
    (ch >= 'a' && ch <= 'z')
    || (ch >= 'A' && ch <= 'Z')
    || (ch >= '0' && ch <= '9')
    || ch === '_'
    || ch === '$'
  ) {
    return true;
  }
  if (ch === '\\' && source[i + 1] === 'u') return true;
  const cp = source.codePointAt(i);
  if (cp > 0x7f) {
    return /[\p{ID_Continue}\u200c\u200d]/u.test(String.fromCodePoint(cp));
  }
  return false;
}

function readUnicodeEscape(source, i) {
  // Returns { ch, nextIndex } or null. Assumes source[i] === '\\' && source[i+1] === 'u'.
  if (source[i + 2] === '{') {
    let j = i + 3;
    let hex = '';
    while (j < source.length && source[j] !== '}') {
      if (!isHexDigit(source[j])) return null;
      hex += source[j];
      j += 1;
    }
    if (j >= source.length || !hex) return null;
    const cp = parseInt(hex, 16);
    if (!Number.isFinite(cp) || cp > 0x10ffff) return null;
    return { ch: String.fromCodePoint(cp), nextIndex: j + 1 };
  }
  const hex = source.slice(i + 2, i + 6);
  if (hex.length === 4 && /^[0-9a-fA-F]{4}$/.test(hex)) {
    return { ch: String.fromCodePoint(parseInt(hex, 16)), nextIndex: i + 6 };
  }
  return null;
}

function isMemberDot(tok) {
  return Boolean(tok && tok.type === 'PUNCT' && (tok.value === '.' || tok.value === '?.'));
}

function canStartRegex(prevTok, prevPrevTok, lastPoppedParenIsStmtHeader) {
  if (!prevTok) return true;
  if (prevTok.type === 'TEMPLATE_HEAD' || prevTok.type === 'TEMPLATE_MIDDLE') return true;
  if (prevTok.type === 'IDENT') {
    if (isMemberDot(prevPrevTok)) return false;
    return REGEX_PREFIX_KEYWORDS.has(prevTok.value);
  }
  if (prevTok.type === 'PUNCT') {
    const v = prevTok.value;
    if (v === '++' || v === '--' || v === ']') return false;
    if (v === ')') return Boolean(lastPoppedParenIsStmtHeader);
    return true;
  }
  return false;
}

export function tokenizeJs(rawSource) {
  const source = typeof rawSource === 'string' && rawSource.charCodeAt(0) === 0xfeff
    ? rawSource.slice(1)
    : String(rawSource ?? '');
  const n = source.length;
  const tokens = [];
  const braceStack = []; // 'brace' | 'template'
  const parenStack = []; // boolean (true if statement header paren)
  let lastPoppedParenIsStmtHeader = false;
  let newlineBefore = false;
  let i = 0;

  const pushToken = (type, value, start, end) => {
    tokens.push({ type, value, start, end, newlineBefore });
    newlineBefore = false;
  };

  const scanTemplate = (startPos, isHead) => {
    let j = startPos + 1;
    while (j < n) {
      const c = source[j];
      if (c === '\\') {
        if (source[j + 1] === '\r' && source[j + 2] === '\n') j += 3;
        else j += 2;
        continue;
      }
      if (c === '$' && source[j + 1] === '{') {
        j += 2;
        pushToken(isHead ? 'TEMPLATE_HEAD' : 'TEMPLATE_MIDDLE', source.slice(startPos, j), startPos, j);
        braceStack.push('template');
        return j;
      }
      if (c === '`') {
        j += 1;
        pushToken(isHead ? 'TEMPLATE_NO_SUB' : 'TEMPLATE_TAIL', source.slice(startPos, j), startPos, j);
        return j;
      }
      j += 1;
    }
    pushToken(isHead ? 'TEMPLATE_NO_SUB' : 'TEMPLATE_TAIL', source.slice(startPos, n), startPos, n);
    return n;
  };

  while (i < n) {
    const ch = source[i];

    // Whitespace
    if (isWhitespace(ch)) {
      if (isLineTerminator(ch)) newlineBefore = true;
      i += 1;
      continue;
    }

    // Comments
    if (ch === '/' && source[i + 1] === '/') {
      i += 2;
      while (i < n && !isLineTerminator(source[i])) i += 1;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        if (isLineTerminator(source[i])) newlineBefore = true;
        i += 1;
      }
      if (i < n) i += 2;
      continue;
    }

    // Strings
    if (ch === '\'' || ch === '"') {
      const start = i;
      const quote = ch;
      i += 1;
      while (i < n) {
        const c = source[i];
        if (c === '\\') {
          if (source[i + 1] === '\r' && source[i + 2] === '\n') i += 3;
          else i += 2;
          continue;
        }
        if (c === quote) {
          i += 1;
          break;
        }
        if (isLineTerminator(c)) break;
        i += 1;
      }
      pushToken('STRING', source.slice(start, i), start, i);
      continue;
    }

    // Template literal start
    if (ch === '`') {
      i = scanTemplate(i, true);
      continue;
    }

    // Closing brace (either normal block/object or template interpolation end)
    if (ch === '}') {
      if (braceStack.length > 0 && braceStack[braceStack.length - 1] === 'template') {
        braceStack.pop();
        i = scanTemplate(i, false);
        continue;
      }
      if (braceStack.length > 0 && braceStack[braceStack.length - 1] === 'brace') {
        braceStack.pop();
      }
      pushToken('PUNCT', '}', i, i + 1);
      i += 1;
      continue;
    }

    // Opening brace
    if (ch === '{') {
      braceStack.push('brace');
      pushToken('PUNCT', '{', i, i + 1);
      i += 1;
      continue;
    }

    // Regex literal vs Division
    if (ch === '/') {
      const len = tokens.length;
      const prevTok = len >= 1 ? tokens[len - 1] : null;
      const prevPrevTok = len >= 2 ? tokens[len - 2] : null;
      if (canStartRegex(prevTok, prevPrevTok, lastPoppedParenIsStmtHeader)) {
        const start = i;
        i += 1;
        let inCharClass = false;
        while (i < n) {
          const c = source[i];
          if (c === '\\') {
            i += 2;
            continue;
          }
          if (isLineTerminator(c)) break;
          if (inCharClass) {
            if (c === ']') inCharClass = false;
            i += 1;
            continue;
          }
          if (c === '[') {
            inCharClass = true;
            i += 1;
            continue;
          }
          if (c === '/') {
            i += 1;
            break;
          }
          i += 1;
        }
        while (i < n && isIdentContinueChar(source, i)) {
          if (source[i] === '\\' && source[i + 1] === 'u') {
            const esc = readUnicodeEscape(source, i);
            if (!esc) break;
            i = esc.nextIndex;
          } else {
            const cp = source.codePointAt(i);
            i += cp > 0xffff ? 2 : 1;
          }
        }
        pushToken('REGEX', source.slice(start, i), start, i);
        continue;
      }
    }

    // Numbers (including .123)
    if (isAsciiDigit(ch) || (ch === '.' && isAsciiDigit(source[i + 1] || ''))) {
      const start = i;
      if (ch === '0' && (source[i + 1] === 'x' || source[i + 1] === 'X')) {
        i += 2;
        while (i < n && (isHexDigit(source[i]) || source[i] === '_')) i += 1;
        if (source[i] === 'n') i += 1;
      } else if (ch === '0' && (source[i + 1] === 'b' || source[i + 1] === 'B')) {
        i += 2;
        while (i < n && (source[i] === '0' || source[i] === '1' || source[i] === '_')) i += 1;
        if (source[i] === 'n') i += 1;
      } else if (ch === '0' && (source[i + 1] === 'o' || source[i + 1] === 'O')) {
        i += 2;
        while (i < n && ((source[i] >= '0' && source[i] <= '7') || source[i] === '_')) i += 1;
        if (source[i] === 'n') i += 1;
      } else {
        let sawDot = false;
        let sawExp = false;
        if (ch === '.') {
          sawDot = true;
          i += 1;
        }
        while (i < n && (isAsciiDigit(source[i]) || source[i] === '_')) i += 1;
        if (!sawDot && source[i] === '.' && source[i + 1] !== '.') {
          sawDot = true;
          i += 1;
          while (i < n && (isAsciiDigit(source[i]) || source[i] === '_')) i += 1;
        }
        if (source[i] === 'e' || source[i] === 'E') {
          sawExp = true;
          i += 1;
          if (source[i] === '+' || source[i] === '-') i += 1;
          while (i < n && (isAsciiDigit(source[i]) || source[i] === '_')) i += 1;
        }
        if (!sawDot && !sawExp && source[i] === 'n') i += 1;
      }
      pushToken('NUMBER', source.slice(start, i), start, i);
      continue;
    }

    // Private identifier (#foo)
    if (ch === '#' && isIdentStartChar(source, i + 1)) {
      const start = i;
      i += 1;
      let decoded = '#';
      while (i < n && isIdentContinueChar(source, i)) {
        if (source[i] === '\\' && source[i + 1] === 'u') {
          const esc = readUnicodeEscape(source, i);
          if (!esc) break;
          decoded += esc.ch;
          i = esc.nextIndex;
        } else {
          const cp = source.codePointAt(i);
          decoded += String.fromCodePoint(cp);
          i += cp > 0xffff ? 2 : 1;
        }
      }
      pushToken('PRIVATE_IDENT', decoded, start, i);
      continue;
    }

    // Identifiers & keywords
    if (isIdentStartChar(source, i)) {
      const start = i;
      let decoded = '';
      if (source[i] === '\\' && source[i + 1] === 'u') {
        const esc = readUnicodeEscape(source, i);
        if (esc) {
          decoded += esc.ch;
          i = esc.nextIndex;
        }
      } else {
        const cp = source.codePointAt(i);
        decoded += String.fromCodePoint(cp);
        i += cp > 0xffff ? 2 : 1;
      }
      if (i > start) {
        while (i < n && isIdentContinueChar(source, i)) {
          if (source[i] === '\\' && source[i + 1] === 'u') {
            const esc = readUnicodeEscape(source, i);
            if (!esc) break;
            decoded += esc.ch;
            i = esc.nextIndex;
          } else {
            const cp = source.codePointAt(i);
            decoded += String.fromCodePoint(cp);
            i += cp > 0xffff ? 2 : 1;
          }
        }
        pushToken('IDENT', decoded, start, i);
        continue;
      }
    }

    // Paren tracking for regex disambiguation
    if (ch === '(') {
      const len = tokens.length;
      const prevTok = len >= 1 ? tokens[len - 1] : null;
      const prevPrevTok = len >= 2 ? tokens[len - 2] : null;
      const prev3Tok = len >= 3 ? tokens[len - 3] : null;
      let isStmtHeader = false;
      if (prevTok && prevTok.type === 'IDENT') {
        if (STMT_HEADER_KEYWORDS.has(prevTok.value) && !isMemberDot(prevPrevTok)) {
          isStmtHeader = true;
        } else if (
          prevTok.value === 'await'
          && prevPrevTok
          && prevPrevTok.type === 'IDENT'
          && prevPrevTok.value === 'for'
          && !isMemberDot(prev3Tok)
        ) {
          isStmtHeader = true;
        }
      }
      parenStack.push(isStmtHeader);
      pushToken('PUNCT', '(', i, i + 1);
      i += 1;
      continue;
    }

    if (ch === ')') {
      lastPoppedParenIsStmtHeader = parenStack.length ? parenStack.pop() : false;
      pushToken('PUNCT', ')', i, i + 1);
      i += 1;
      continue;
    }

    // Multi-character punctuators
    let matchedPunct = null;
    for (const p of MULTI_CHAR_PUNCT) {
      if (source.startsWith(p, i)) {
        if (p === '?.' && isAsciiDigit(source[i + 2] || '')) continue;
        matchedPunct = p;
        break;
      }
    }
    if (matchedPunct) {
      pushToken('PUNCT', matchedPunct, i, i + matchedPunct.length);
      i += matchedPunct.length;
      continue;
    }

    // Single-character punctuator / unknown symbol
    pushToken('PUNCT', ch, i, i + 1);
    i += 1;
  }

  return tokens;
}

function decodeStringLiteral(raw) {
  if (typeof raw !== 'string' || raw.length < 2) return '';
  const body = raw.slice(1, -1);
  let out = '';
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (c !== '\\') {
      out += c;
      continue;
    }
    i += 1;
    if (i >= body.length) break;
    const esc = body[i];
    if (esc === '\n' || esc === '\u2028' || esc === '\u2029') continue;
    if (esc === '\r') {
      if (body[i + 1] === '\n') i += 1;
      continue;
    }
    if (esc === 'n') out += '\n';
    else if (esc === 'r') out += '\r';
    else if (esc === 't') out += '\t';
    else if (esc === 'b') out += '\b';
    else if (esc === 'f') out += '\f';
    else if (esc === 'v') out += '\v';
    else if (esc === '0' && !isAsciiDigit(body[i + 1] || '')) out += '\0';
    else if (esc === 'x') {
      const hex = body.slice(i + 1, i + 3);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        out += String.fromCharCode(parseInt(hex, 16));
        i += 2;
      } else {
        out += 'x';
      }
    } else if (esc === 'u') {
      if (body[i + 1] === '{') {
        const end = body.indexOf('}', i + 2);
        if (end > i + 2) {
          const cp = parseInt(body.slice(i + 2, end), 16);
          if (Number.isFinite(cp)) out += String.fromCodePoint(cp);
          i = end;
        }
      } else {
        const hex = body.slice(i + 1, i + 5);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else {
          out += 'u';
        }
      }
    } else {
      out += esc;
    }
  }
  return out;
}

function isValidPropertyIdent(name) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
}

function formatDestructureEntry(imported, local) {
  if (imported === local && isValidPropertyIdent(imported)) return local;
  const key = isValidPropertyIdent(imported) ? imported : JSON.stringify(imported);
  return `${key}: ${local}`;
}

function skipBalanced(tokens, idx) {
  // Assumes tokens[idx] is (, [, {, or TEMPLATE_HEAD. Returns index right after matching closer.
  let depth = 0;
  let j = idx;
  while (j < tokens.length) {
    const t = tokens[j];
    if (t.type === 'PUNCT' && (t.value === '(' || t.value === '[' || t.value === '{')) depth += 1;
    else if (t.type === 'TEMPLATE_HEAD') depth += 1;
    else if (t.type === 'PUNCT' && (t.value === ')' || t.value === ']' || t.value === '}')) {
      depth -= 1;
      if (depth <= 0) return j + 1;
    } else if (t.type === 'TEMPLATE_TAIL') {
      depth -= 1;
      if (depth <= 0) return j + 1;
    }
    j += 1;
  }
  return j;
}

function skipPatternDefault(tokens, idx, stopCloser) {
  let depth = 0;
  let j = idx;
  while (j < tokens.length) {
    const t = tokens[j];
    if (depth === 0 && t.type === 'PUNCT' && (t.value === ',' || t.value === stopCloser)) {
      return j;
    }
    if (t.type === 'PUNCT' && (t.value === '(' || t.value === '[' || t.value === '{')) depth += 1;
    else if (t.type === 'TEMPLATE_HEAD') depth += 1;
    else if (t.type === 'PUNCT' && (t.value === ')' || t.value === ']' || t.value === '}')) depth -= 1;
    else if (t.type === 'TEMPLATE_TAIL') depth -= 1;
    j += 1;
  }
  return j;
}

function extractBindingNames(tokens, idx, outNames) {
  const tok = tokens[idx];
  if (!tok) return idx;
  if (tok.type === 'IDENT') {
    outNames.push(tok.value);
    return idx + 1;
  }
  if (tok.type === 'PUNCT' && tok.value === '{') {
    let j = idx + 1;
    while (j < tokens.length && !(tokens[j].type === 'PUNCT' && tokens[j].value === '}')) {
      if (tokens[j].type === 'PUNCT' && tokens[j].value === '...') {
        j = extractBindingNames(tokens, j + 1, outNames);
      } else {
        if (tokens[j].type === 'PUNCT' && tokens[j].value === '[') {
          j = skipBalanced(tokens, j);
          if (tokens[j]?.type === 'PUNCT' && tokens[j].value === ':') {
            j = extractBindingNames(tokens, j + 1, outNames);
          }
        } else {
          const keyTok = tokens[j];
          j += 1;
          if (tokens[j]?.type === 'PUNCT' && tokens[j].value === ':') {
            j = extractBindingNames(tokens, j + 1, outNames);
          } else if (keyTok && keyTok.type === 'IDENT') {
            outNames.push(keyTok.value);
          }
        }
      }
      if (tokens[j]?.type === 'PUNCT' && tokens[j].value === '=') {
        j = skipPatternDefault(tokens, j + 1, '}');
      }
      if (tokens[j]?.type === 'PUNCT' && tokens[j].value === ',') {
        j += 1;
      }
    }
    return j < tokens.length ? j + 1 : j;
  }
  if (tok.type === 'PUNCT' && tok.value === '[') {
    let j = idx + 1;
    while (j < tokens.length && !(tokens[j].type === 'PUNCT' && tokens[j].value === ']')) {
      if (tokens[j].type === 'PUNCT' && tokens[j].value === ',') {
        j += 1;
        continue;
      }
      if (tokens[j].type === 'PUNCT' && tokens[j].value === '...') {
        j += 1;
      }
      j = extractBindingNames(tokens, j, outNames);
      if (tokens[j]?.type === 'PUNCT' && tokens[j].value === '=') {
        j = skipPatternDefault(tokens, j + 1, ']');
      }
      if (tokens[j]?.type === 'PUNCT' && tokens[j].value === ',') {
        j += 1;
      }
    }
    return j < tokens.length ? j + 1 : j;
  }
  return idx + 1;
}

function canTokenContinueExpr(prevTok, nextTok) {
  if (!prevTok || !nextTok) return false;
  if (prevTok.type === 'PUNCT' && EXPR_CONT_TRAILING_PUNCT.has(prevTok.value)) {
    // Postfix ++ / -- can end an expression; prefix cannot, but newline after ++/-- in JS triggers ASI anyway.
    return prevTok.value !== '}' && prevTok.value !== ')' && prevTok.value !== ']';
  }
  if (prevTok.type === 'IDENT' && EXPR_CONT_TRAILING_KW.has(prevTok.value)) {
    return true;
  }
  if (nextTok.type === 'PUNCT' && EXPR_CONT_LEADING_PUNCT.has(nextTok.value)) {
    return true;
  }
  if (nextTok.type === 'IDENT' && EXPR_CONT_LEADING_KW.has(nextTok.value)) {
    return true;
  }
  if (nextTok.type === 'TEMPLATE_HEAD' || nextTok.type === 'TEMPLATE_NO_SUB') {
    return true;
  }
  return false;
}

function findAssignmentExprEnd(tokens, startIdx) {
  // Scans an AssignmentExpression starting at startIdx until ';' or ASI at depth 0.
  // Returns { endIdx, afterSemiIdx } where endIdx is the index of the token just after the expr,
  // and afterSemiIdx includes an immediate ';' if present.
  let depth = 0;
  let j = startIdx;
  while (j < tokens.length) {
    const tok = tokens[j];
    if (depth === 0) {
      if (tok.type === 'PUNCT' && tok.value === ';') {
        return { endIdx: j, afterSemiIdx: j + 1 };
      }
      if (j > startIdx && tok.newlineBefore) {
        const prev = tokens[j - 1];
        if (!canTokenContinueExpr(prev, tok)) {
          return { endIdx: j, afterSemiIdx: j };
        }
      }
    }
    if (tok.type === 'PUNCT' && (tok.value === '(' || tok.value === '[' || tok.value === '{')) {
      depth += 1;
    } else if (tok.type === 'TEMPLATE_HEAD') {
      depth += 1;
    } else if (tok.type === 'PUNCT' && (tok.value === ')' || tok.value === ']' || tok.value === '}')) {
      depth -= 1;
      if (depth < 0) return { endIdx: j, afterSemiIdx: j };
    } else if (tok.type === 'TEMPLATE_TAIL') {
      depth -= 1;
    }
    j += 1;
  }
  return { endIdx: j, afterSemiIdx: j };
}

function findVarDeclEnd(tokens, startIdx) {
  let depth = 0;
  let j = startIdx;
  while (j < tokens.length) {
    const tok = tokens[j];
    if (depth === 0) {
      if (tok.type === 'PUNCT' && tok.value === ';') {
        return j + 1;
      }
      if (j > startIdx && tok.newlineBefore) {
        const prev = tokens[j - 1];
        if (!canTokenContinueExpr(prev, tok)) {
          return j;
        }
      }
    }
    if (tok.type === 'PUNCT' && (tok.value === '(' || tok.value === '[' || tok.value === '{')) depth += 1;
    else if (tok.type === 'TEMPLATE_HEAD') depth += 1;
    else if (tok.type === 'PUNCT' && (tok.value === ')' || tok.value === ']' || tok.value === '}')) depth -= 1;
    else if (tok.type === 'TEMPLATE_TAIL') depth -= 1;
    j += 1;
  }
  return j;
}

function consumeOptionalSemicolon(tokens, idx) {
  if (idx < tokens.length && tokens[idx].type === 'PUNCT' && tokens[idx].value === ';') {
    return idx + 1;
  }
  return idx;
}

function applySpanEdits(source, edits) {
  if (edits.length === 0) return source;
  const sorted = [...edits].sort((a, b) => (a.start !== b.start ? a.start - b.start : a.end - b.end));
  let out = '';
  let cursor = 0;
  for (const ed of sorted) {
    if (ed.start < cursor) {
      throw new Error(`Overlapping bundler edit [${ed.start}, ${ed.end}] vs cursor ${cursor}`);
    }
    out += source.slice(cursor, ed.start) + ed.text;
    cursor = ed.end;
  }
  out += source.slice(cursor);
  return out;
}

export function transformEsModule(rawSource, moduleId = 'entry.js', resolveDep = (spec) => spec) {
  const source = typeof rawSource === 'string' && rawSource.charCodeAt(0) === 0xfeff
    ? rawSource.slice(1)
    : String(rawSource ?? '');
  const tokens = tokenizeJs(source);
  const edits = [];
  const hoistedExports = []; // { exported, local }
  const hoistedImports = [];
  const deps = [];
  const depSet = new Set();
  let uid = 0;

  const recordDep = (specifier) => {
    const resolved = resolveDep(specifier, moduleId);
    const id = typeof resolved === 'string' ? resolved : resolved.id;
    if (!depSet.has(id)) {
      depSet.add(id);
      deps.push(id);
    }
    return id;
  };

  const nextId = (prefix) => {
    const n = uid;
    uid += 1;
    return `${prefix}_${n}`;
  };

  const stmtSeparatorIfNeeded = (prevTok) => {
    if (!prevTok) return '';
    if (prevTok.type === 'PUNCT' && (prevTok.value === ';' || prevTok.value === '}')) return '';
    return ';';
  };

  let depth = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];
    const prevTok = i > 0 ? tokens[i - 1] : null;
    const nextTok = i + 1 < tokens.length ? tokens[i + 1] : null;

    // Rewrite import.meta at ANY depth
    if (
      tok.type === 'IDENT'
      && tok.value === 'import'
      && !isMemberDot(prevTok)
      && nextTok?.type === 'PUNCT'
      && nextTok.value === '.'
      && tokens[i + 2]?.type === 'IDENT'
      && tokens[i + 2].value === 'meta'
    ) {
      const metaEnd = tokens[i + 2].end;
      const fallbackUrl = JSON.stringify(`module:///${moduleId}`);
      edits.push({
        start: tok.start,
        end: metaEnd,
        text: `({ url: (typeof document !== 'undefined' && document.currentScript && document.currentScript.src) || (typeof location !== 'undefined' ? location.href : ${fallbackUrl}) })`,
      });
      i += 2;
      continue;
    }

    if (depth === 0 && !isMemberDot(prevTok) && tok.type === 'IDENT') {
      // Static import declaration (exclude dynamic import(...))
      if (tok.value === 'import' && !(nextTok?.type === 'PUNCT' && nextTok.value === '(')) {
        let j = i + 1;
        if (tokens[j]?.type === 'STRING') {
          const spec = decodeStringLiteral(tokens[j].value);
          const depId = recordDep(spec);
          j = consumeOptionalSemicolon(tokens, j + 1);
          const endPos = tokens[j - 1].end;
          hoistedImports.push(`__require(${JSON.stringify(depId)});`);
          edits.push({ start: tok.start, end: endPos, text: stmtSeparatorIfNeeded(prevTok) });
          i = j - 1;
          continue;
        }

        let defaultLocal = null;
        let nsLocal = null;
        const specifiers = [];

        if (tokens[j]?.type === 'IDENT') {
          defaultLocal = tokens[j].value;
          j += 1;
          if (tokens[j]?.type === 'PUNCT' && tokens[j].value === ',') {
            j += 1;
          }
        }
        if (tokens[j]?.type === 'PUNCT' && tokens[j].value === '*') {
          if (tokens[j + 1]?.type === 'IDENT' && tokens[j + 1].value === 'as' && tokens[j + 2]?.type === 'IDENT') {
            nsLocal = tokens[j + 2].value;
            j += 3;
          }
        } else if (tokens[j]?.type === 'PUNCT' && tokens[j].value === '{') {
          j += 1;
          while (j < tokens.length && !(tokens[j].type === 'PUNCT' && tokens[j].value === '}')) {
            const impTok = tokens[j];
            const imported = impTok.type === 'STRING' ? decodeStringLiteral(impTok.value) : impTok.value;
            j += 1;
            let local = imported;
            if (tokens[j]?.type === 'IDENT' && tokens[j].value === 'as' && tokens[j + 1]?.type === 'IDENT') {
              local = tokens[j + 1].value;
              j += 2;
            }
            specifiers.push({ imported, local });
            if (tokens[j]?.type === 'PUNCT' && tokens[j].value === ',') j += 1;
          }
          if (tokens[j]?.type === 'PUNCT' && tokens[j].value === '}') j += 1;
        }

        if (tokens[j]?.type === 'IDENT' && tokens[j].value === 'from' && tokens[j + 1]?.type === 'STRING') {
          const spec = decodeStringLiteral(tokens[j + 1].value);
          const depId = recordDep(spec);
          j = consumeOptionalSemicolon(tokens, j + 2);
          const endPos = tokens[j - 1].end;

          const reqCall = `__require(${JSON.stringify(depId)})`;
          if (defaultLocal && nsLocal) {
            hoistedImports.push(`const ${nsLocal} = ${reqCall}; const ${defaultLocal} = ${nsLocal}.default;`);
          } else if (nsLocal) {
            hoistedImports.push(`const ${nsLocal} = ${reqCall};`);
          } else if (defaultLocal && specifiers.length > 0) {
            const tmp = nextId('__agylens_imp');
            const namedList = specifiers.map((s) => formatDestructureEntry(s.imported, s.local)).join(', ');
            hoistedImports.push(`const ${tmp} = ${reqCall}; const ${defaultLocal} = ${tmp}.default; const { ${namedList} } = ${tmp};`);
          } else if (defaultLocal) {
            hoistedImports.push(`const { default: ${defaultLocal} } = ${reqCall};`);
          } else if (specifiers.length > 0) {
            const namedList = specifiers.map((s) => formatDestructureEntry(s.imported, s.local)).join(', ');
            hoistedImports.push(`const { ${namedList} } = ${reqCall};`);
          } else {
            hoistedImports.push(`${reqCall};`);
          }

          edits.push({ start: tok.start, end: endPos, text: stmtSeparatorIfNeeded(prevTok) });
          i = j - 1;
          continue;
        }
      }

      // Static export declaration
      if (tok.value === 'export') {
        let j = i + 1;

        // 1) export * [as ns] from './x.js'
        if (tokens[j]?.type === 'PUNCT' && tokens[j].value === '*') {
          if (
            tokens[j + 1]?.type === 'IDENT'
            && tokens[j + 1].value === 'as'
            && (tokens[j + 2]?.type === 'IDENT' || tokens[j + 2]?.type === 'STRING')
            && tokens[j + 3]?.type === 'IDENT'
            && tokens[j + 3].value === 'from'
            && tokens[j + 4]?.type === 'STRING'
          ) {
            const nsName = tokens[j + 2].type === 'STRING'
              ? decodeStringLiteral(tokens[j + 2].value)
              : tokens[j + 2].value;
            const depId = recordDep(decodeStringLiteral(tokens[j + 4].value));
            j = consumeOptionalSemicolon(tokens, j + 5);
            const tmp = nextId('__agylens_ns');
            edits.push({
              start: tok.start,
              end: tokens[j - 1].end,
              text: `${stmtSeparatorIfNeeded(prevTok)}const ${tmp} = __require(${JSON.stringify(depId)}); __exportValue(__exports, ${JSON.stringify(nsName)}, ${tmp});`,
            });
            i = j - 1;
            continue;
          }
          if (tokens[j + 1]?.type === 'IDENT' && tokens[j + 1].value === 'from' && tokens[j + 2]?.type === 'STRING') {
            const depId = recordDep(decodeStringLiteral(tokens[j + 2].value));
            j = consumeOptionalSemicolon(tokens, j + 3);
            edits.push({
              start: tok.start,
              end: tokens[j - 1].end,
              text: `${stmtSeparatorIfNeeded(prevTok)}__exportStar(__exports, __require(${JSON.stringify(depId)}));`,
            });
            i = j - 1;
            continue;
          }
        }

        // 2) export { ... } [from './x.js']
        if (tokens[j]?.type === 'PUNCT' && tokens[j].value === '{') {
          j += 1;
          const entries = [];
          while (j < tokens.length && !(tokens[j].type === 'PUNCT' && tokens[j].value === '}')) {
            const locTok = tokens[j];
            const local = locTok.type === 'STRING' ? decodeStringLiteral(locTok.value) : locTok.value;
            j += 1;
            let exported = local;
            if (tokens[j]?.type === 'IDENT' && tokens[j].value === 'as') {
              const expTok = tokens[j + 1];
              exported = expTok.type === 'STRING' ? decodeStringLiteral(expTok.value) : expTok.value;
              j += 2;
            }
            entries.push({ local, exported });
            if (tokens[j]?.type === 'PUNCT' && tokens[j].value === ',') j += 1;
          }
          if (tokens[j]?.type === 'PUNCT' && tokens[j].value === '}') j += 1;

          if (tokens[j]?.type === 'IDENT' && tokens[j].value === 'from' && tokens[j + 1]?.type === 'STRING') {
            const depId = recordDep(decodeStringLiteral(tokens[j + 1].value));
            j = consumeOptionalSemicolon(tokens, j + 2);
            const tmp = nextId('__agylens_re');
            const pairs = entries.map((e) => [e.local, e.exported]);
            edits.push({
              start: tok.start,
              end: tokens[j - 1].end,
              text: `${stmtSeparatorIfNeeded(prevTok)}const ${tmp} = __require(${JSON.stringify(depId)}); __reexport(__exports, ${tmp}, ${JSON.stringify(pairs)});`,
            });
            i = j - 1;
            continue;
          }

          j = consumeOptionalSemicolon(tokens, j);
          for (const e of entries) hoistedExports.push(e);
          edits.push({
            start: tok.start,
            end: tokens[j - 1].end,
            text: stmtSeparatorIfNeeded(prevTok),
          });
          i = j - 1;
          continue;
        }

        // 3) export default ...
        if (tokens[j]?.type === 'IDENT' && tokens[j].value === 'default') {
          const k = j + 1;
          const isDefaultAsyncFn = tokens[k]?.type === 'IDENT'
            && tokens[k].value === 'async'
            && tokens[k + 1]?.type === 'IDENT'
            && tokens[k + 1].value === 'function'
            && !tokens[k + 1].newlineBefore;
          const isDefaultFn = tokens[k]?.type === 'IDENT' && tokens[k].value === 'function';

          if (isDefaultAsyncFn || isDefaultFn) {
            const fnTokIdx = isDefaultAsyncFn ? k + 1 : k;
            let nameIdx = fnTokIdx + 1;
            if (tokens[nameIdx]?.type === 'PUNCT' && tokens[nameIdx].value === '*') nameIdx += 1;
            if (tokens[nameIdx]?.type === 'IDENT') {
              const fnName = tokens[nameIdx].value;
              hoistedExports.push({ exported: 'default', local: fnName });
              edits.push({ start: tok.start, end: tokens[k].start, text: '' });
            } else {
              const defName = nextId('__agylens_def');
              hoistedExports.push({ exported: 'default', local: defName });
              edits.push({ start: tok.start, end: tokens[k].start, text: '' });
              edits.push({ start: tokens[nameIdx].start, end: tokens[nameIdx].start, text: ` ${defName}` });
            }
            i = k - 1;
            continue;
          }

          if (tokens[k]?.type === 'IDENT' && tokens[k].value === 'class') {
            const afterClass = tokens[k + 1];
            if (afterClass?.type === 'IDENT' && afterClass.value !== 'extends') {
              hoistedExports.push({ exported: 'default', local: afterClass.value });
              edits.push({ start: tok.start, end: tokens[k].start, text: '' });
              i = k - 1;
              continue;
            }
            // Anonymous default class: assign to temp const and ensure trailing ';' after class body
            const defName = nextId('__agylens_def');
            hoistedExports.push({ exported: 'default', local: defName });
            let bodyIdx = k + 1;
            while (bodyIdx < tokens.length && !(tokens[bodyIdx].type === 'PUNCT' && tokens[bodyIdx].value === '{')) {
              bodyIdx += 1;
            }
            const afterBodyIdx = skipBalanced(tokens, bodyIdx);
            const bodyEndTok = tokens[afterBodyIdx - 1];
            edits.push({ start: tok.start, end: tokens[k].start, text: `${stmtSeparatorIfNeeded(prevTok)}const ${defName} = ` });
            if (bodyEndTok && tokens[afterBodyIdx]?.value !== ';') {
              edits.push({ start: bodyEndTok.end, end: bodyEndTok.end, text: ';' });
            }
            i = k - 1;
            continue;
          }

          // General expression: export default <AssignmentExpression>
          const { endIdx, afterSemiIdx } = findAssignmentExprEnd(tokens, k);
          const lastExprTok = tokens[endIdx - 1] || tokens[k];
          const afterEndPos = tokens[afterSemiIdx - 1].end;
          edits.push({
            start: tok.start,
            end: tokens[k].start,
            text: `${stmtSeparatorIfNeeded(prevTok)}__exportValue(__exports, "default", (`,
          });
          edits.push({
            start: lastExprTok.end,
            end: afterEndPos,
            text: '));',
          });
          i = k - 1;
          continue;
        }

        // 4) export [async] function [*] Name ...
        const isAsyncFn = tokens[j]?.type === 'IDENT'
          && tokens[j].value === 'async'
          && tokens[j + 1]?.type === 'IDENT'
          && tokens[j + 1].value === 'function'
          && !tokens[j + 1].newlineBefore;
        const isFn = tokens[j]?.type === 'IDENT' && tokens[j].value === 'function';
        if (isAsyncFn || isFn) {
          const fnTokIdx = isAsyncFn ? j + 1 : j;
          let nameIdx = fnTokIdx + 1;
          if (tokens[nameIdx]?.type === 'PUNCT' && tokens[nameIdx].value === '*') nameIdx += 1;
          if (tokens[nameIdx]?.type === 'IDENT') {
            const name = tokens[nameIdx].value;
            hoistedExports.push({ exported: name, local: name });
            edits.push({ start: tok.start, end: tokens[j].start, text: '' });
            i = j - 1;
            continue;
          }
        }

        // 5) export class Name ...
        if (tokens[j]?.type === 'IDENT' && tokens[j].value === 'class' && tokens[j + 1]?.type === 'IDENT') {
          const name = tokens[j + 1].value;
          hoistedExports.push({ exported: name, local: name });
          edits.push({ start: tok.start, end: tokens[j].start, text: '' });
          i = j - 1;
          continue;
        }

        // 6) export const / let / var ...
        if (
          tokens[j]?.type === 'IDENT'
          && (tokens[j].value === 'const' || tokens[j].value === 'let' || tokens[j].value === 'var')
        ) {
          const declEndIdx = findVarDeclEnd(tokens, j + 1);
          const names = [];
          let cur = j + 1;
          while (cur < declEndIdx) {
            cur = extractBindingNames(tokens, cur, names);
            if (cur < declEndIdx && tokens[cur]?.type === 'PUNCT' && tokens[cur].value === '=') {
              // Advance to next top-level comma or end of declaration
              let d = 0;
              cur += 1;
              while (cur < declEndIdx) {
                const t = tokens[cur];
                if (d === 0 && t.type === 'PUNCT' && (t.value === ',' || t.value === ';')) break;
                if (t.type === 'PUNCT' && (t.value === '(' || t.value === '[' || t.value === '{')) d += 1;
                else if (t.type === 'TEMPLATE_HEAD') d += 1;
                else if (t.type === 'PUNCT' && (t.value === ')' || t.value === ']' || t.value === '}')) d -= 1;
                else if (t.type === 'TEMPLATE_TAIL') d -= 1;
                cur += 1;
              }
            }
            if (cur < declEndIdx && tokens[cur]?.type === 'PUNCT' && tokens[cur].value === ',') {
              cur += 1;
            } else {
              break;
            }
          }
          for (const name of names) hoistedExports.push({ exported: name, local: name });
          edits.push({ start: tok.start, end: tokens[j].start, text: '' });
          i = j - 1;
          continue;
        }
      }
    }

    if (tok.type === 'PUNCT' && (tok.value === '(' || tok.value === '[' || tok.value === '{')) depth += 1;
    else if (tok.type === 'TEMPLATE_HEAD') depth += 1;
    else if (tok.type === 'PUNCT' && (tok.value === ')' || tok.value === ']' || tok.value === '}')) depth -= 1;
    else if (tok.type === 'TEMPLATE_TAIL') depth -= 1;
  }

  const transformedBody = applySpanEdits(source, edits);
  const preamble = [];
  if (hoistedExports.length > 0) {
    const defs = hoistedExports
      .map((e) => `${JSON.stringify(e.exported)}: function () { return ${e.local}; }`)
      .join(', ');
    preamble.push(`__export(__exports, { ${defs} });`);
  }
  if (hoistedImports.length > 0) {
    preamble.push(...hoistedImports);
  }
  const code = preamble.length > 0
    ? `${preamble.join('\n')}\n${transformedBody}`
    : transformedBody;

  return {
    code,
    deps,
    exports: hoistedExports.map((e) => e.exported),
  };
}

export function bundleWebApp(webDir, entryFile = 'app.js') {
  if (!webDir) throw new Error('webDir is required');
  const cleanEntry = String(entryFile || 'app.js').replace(/\\/g, '/').replace(/^\.\//, '');
  const entryMod = resolveWebModule('.', `./${cleanEntry}`, webDir);

  const visited = new Map(); // id -> transformed code
  const queue = [entryMod];

  while (queue.length > 0) {
    const mod = queue.shift();
    if (visited.has(mod.id)) continue;
    const raw = readFileSync(mod.absPath, 'utf8');
    const resolvedDeps = [];
    const { code } = transformEsModule(raw, mod.id, (specifier) => {
      const dep = resolveWebModule(mod.id, specifier, webDir);
      resolvedDeps.push(dep);
      return dep.id;
    });
    visited.set(mod.id, code);
    for (const dep of resolvedDeps) {
      if (!visited.has(dep.id)) queue.push(dep);
    }
  }

  const moduleEntries = [];
  for (const [id, code] of visited.entries()) {
    moduleEntries.push(
      `  __modules[${JSON.stringify(id)}] = function (__require, __exports, __module) {\n${code}\n  };`,
    );
  }

  return [
    '(function () {',
    "  'use strict';",
    '  var __modules = Object.create(null);',
    '  var __cache = Object.create(null);',
    '  function __export(exports, defs) {',
    '    var keys = Object.keys(defs);',
    '    for (var i = 0; i < keys.length; i++) {',
    '      var k = keys[i];',
    '      if (!Object.prototype.hasOwnProperty.call(exports, k)) {',
    '        Object.defineProperty(exports, k, { enumerable: true, configurable: true, get: defs[k] });',
    '      }',
    '    }',
    '  }',
    '  function __exportValue(exports, name, value) {',
    '    Object.defineProperty(exports, name, { enumerable: true, configurable: true, get: function () { return value; } });',
    '  }',
    '  function __reexport(exports, source, pairs) {',
    '    for (var i = 0; i < pairs.length; i++) {',
    '      (function (fromKey, toKey) {',
    '        Object.defineProperty(exports, toKey, {',
    '          enumerable: true,',
    '          configurable: true,',
    '          get: function () { return source[fromKey]; },',
    '        });',
    '      })(pairs[i][0], pairs[i][1]);',
    '    }',
    '  }',
    '  function __exportStar(exports, source) {',
    '    var keys = Object.keys(source);',
    '    for (var i = 0; i < keys.length; i++) {',
    '      var k = keys[i];',
    "      if (k === 'default') continue;",
    '      if (!Object.prototype.hasOwnProperty.call(exports, k)) {',
    '        (function (key) {',
    '          Object.defineProperty(exports, key, {',
    '            enumerable: true,',
    '            configurable: true,',
    '            get: function () { return source[key]; },',
    '          });',
    '        })(k);',
    '      }',
    '    }',
    '  }',
    '  function __require(id) {',
    '    if (Object.prototype.hasOwnProperty.call(__cache, id)) return __cache[id].exports;',
    '    var fn = __modules[id];',
    "    if (!fn) throw new Error('Cannot find module: ' + id);",
    '    var mod = { id: id, exports: {} };',
    '    __cache[id] = mod;',
    '    try {',
    '      fn(__require, mod.exports, mod);',
    '    } catch (err) {',
    '      delete __cache[id];',
    '      throw err;',
    '    }',
    '    return mod.exports;',
    '  }',
    ...moduleEntries,
    `  __require(${JSON.stringify(entryMod.id)});`,
    '})();',
    '',
  ].join('\n');
}
