// Tier 2 Boundary & Corner Case Tests: F1–F6 (30 tests: T2-F1-01 .. T2-F6-05)

import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ROOT,
  createSandbox,
  makePoisonedPythonBinDir,
  parsePngInfo,
  relPath,
  runChromeBrowserTest,
  startSidecar,
  walkFiles,
} from './lib/harness.mjs';
import { DEFAULT_MODELS_RESP, DEFAULT_SUMMARY_RESP, startMockLs } from './lib/mock-ls.mjs';
import { createConvDb } from './lib/pb-db-builder.mjs';

const SIDECAR_DIR = join(ROOT, 'sidecars', 'agy-lens');
const WEB_DIR = join(SIDECAR_DIR, 'web');

const REGEX_PRECEDING_KEYWORDS = new Set([
  'return', 'throw', 'case', 'in', 'of', 'instanceof', 'typeof',
  'void', 'delete', 'await', 'yield', 'new', 'else', 'do',
]);

function scanQuotedString(line, start) {
  const quote = line[start];
  let i = start + 1;
  while (i < line.length) {
    const ch = line[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    i += 1;
  }
  return -1;
}

function scanRegexLiteral(line, start) {
  let i = start + 1;
  let inClass = false;
  let closed = false;
  while (i < line.length) {
    const ch = line[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '[' && !inClass) {
      inClass = true;
      i += 1;
      continue;
    }
    if (ch === ']' && inClass) {
      inClass = false;
      i += 1;
      continue;
    }
    if (ch === '/' && !inClass) {
      closed = true;
      break;
    }
    i += 1;
  }
  if (!closed || i === start + 1) return null;
  const bodyEnd = i;
  let end = i + 1;
  while (end < line.length && /[a-z]/i.test(line[end])) end += 1;
  return { type: 'regex', start, bodyEnd, end };
}

function scanTemplateLiteral(line, start) {
  let i = start + 1;
  let hasInterp = false;
  const idents = [];
  while (i < line.length) {
    const ch = line[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '`') {
      return { type: hasInterp ? 'template' : 'static_template', start, end: i + 1, idents };
    }
    if (ch === '$' && line[i + 1] === '{') {
      hasInterp = true;
      i += 2;
      let depth = 1;
      let prevKind = 'op';
      let prevDot = false;
      while (i < line.length && depth > 0) {
        const c = line[i];
        if (/\s/.test(c)) { i += 1; continue; }
        if (c === '\'' || c === '"') {
          const end = scanQuotedString(line, i);
          if (end < 0) return null;
          i = end; prevKind = 'expr'; prevDot = false; continue;
        }
        if (c === '`') {
          const nested = scanTemplateLiteral(line, i);
          if (!nested) return null;
          idents.push(...nested.idents);
          i = nested.end; prevKind = 'expr'; prevDot = false; continue;
        }
        if (c === '/' && (line[i + 1] === '/' || line[i + 1] === '*')) return null;
        if (c === '/' && prevKind === 'op') {
          const re = scanRegexLiteral(line, i);
          if (!re) return null;
          i = re.end; prevKind = 'expr'; prevDot = false; continue;
        }
        if (c === '{') { depth += 1; i += 1; prevKind = 'op'; prevDot = false; continue; }
        if (c === '}') { depth -= 1; i += 1; prevKind = 'expr'; prevDot = false; continue; }
        if (/[A-Za-z_$]/.test(c)) {
          let j = i + 1;
          while (j < line.length && /[\w$]/.test(line[j])) j += 1;
          const word = line.slice(i, j);
          if (!prevDot) idents.push(word);
          prevKind = (!prevDot && REGEX_PRECEDING_KEYWORDS.has(word)) ? 'op' : 'expr';
          prevDot = false;
          i = j;
          continue;
        }
        if (/[0-9]/.test(c)) {
          let j = i + 1;
          while (j < line.length && /[\w.]/.test(line[j])) j += 1;
          i = j; prevKind = 'expr'; prevDot = false; continue;
        }
        prevDot = c === '.';
        prevKind = (c === ')' || c === ']') ? 'expr' : 'op';
        i += 1;
      }
      if (depth !== 0) return null;
      continue;
    }
    i += 1;
  }
  return null;
}

function scanJsLine(line) {
  const tokens = [];
  let i = 0;
  let prevKind = 'op';
  let commentStart = -1;
  while (i < line.length) {
    const ch = line[i];
    if (/\s/.test(ch)) { i += 1; continue; }
    if (ch === '/' && line[i + 1] === '/') { commentStart = i; break; }
    if (ch === '/' && line[i + 1] === '*') return null;
    if (ch === '\'' || ch === '"') {
      const end = scanQuotedString(line, i);
      if (end < 0) return null;
      tokens.push({ type: 'string', start: i, end });
      i = end;
      prevKind = 'expr';
      continue;
    }
    if (ch === '`') {
      const tpl = scanTemplateLiteral(line, i);
      if (!tpl) return null;
      tokens.push(tpl);
      i = tpl.end;
      prevKind = 'expr';
      continue;
    }
    if (ch === '/' && prevKind === 'op') {
      const re = scanRegexLiteral(line, i);
      if (!re) return null;
      tokens.push(re);
      i = re.end;
      prevKind = 'expr';
      continue;
    }
    if ((ch === '&' && line[i + 1] === '&') || (ch === '|' && line[i + 1] === '|')) {
      tokens.push({ type: 'op', value: line.slice(i, i + 2), start: i, end: i + 2 });
      i += 2;
      prevKind = 'op';
      continue;
    }
    if (/[()[\]{}.,;:=!&|~^+\-*%<>?]/.test(ch)) {
      tokens.push({ type: 'punct', value: ch, start: i, end: i + 1 });
      i += 1;
      prevKind = (ch === ')' || ch === ']' || ch === '}') ? 'expr' : 'op';
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i + 1;
      while (j < line.length && /[\w$]/.test(line[j])) j += 1;
      const word = line.slice(i, j);
      const prevTok = tokens[tokens.length - 1];
      const afterDot = prevTok?.type === 'punct' && prevTok.value === '.';
      tokens.push({ type: 'ident', value: word, start: i, end: j });
      i = j;
      prevKind = (!afterDot && REGEX_PRECEDING_KEYWORDS.has(word)) ? 'op' : 'expr';
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let j = i + 1;
      while (j < line.length && /[\w.]/.test(line[j])) j += 1;
      tokens.push({ type: 'number', value: line.slice(i, j), start: i, end: j });
      i = j;
      prevKind = 'expr';
      continue;
    }
    return null;
  }
  return {
    tokens,
    code: commentStart >= 0 ? line.slice(0, commentStart) : line,
    comment: commentStart >= 0 ? line.slice(commentStart) : '',
  };
}

function passesLineSafetyRules(tokens) {
  if (!tokens || tokens.length === 0) return false;
  if (tokens[0].type === 'ident' && (tokens[0].value === 'import' || tokens[0].value === 'export')) {
    return false;
  }
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t.type === 'op' && (t.value === '&&' || t.value === '||')) return false;
    if (t.type === 'punct' && t.value === ';' && i !== tokens.length - 1) return false;
    if (t.type === 'ident' && t.value === 'require') {
      const prev = tokens[i - 1];
      const next = tokens[i + 1];
      if (!(prev?.type === 'punct' && prev.value === '.') && next?.type === 'punct' && next.value === '(') {
        return false;
      }
    }
  }
  return true;
}

function matchBalanced(tokens, openIdx) {
  const open = tokens[openIdx]?.value;
  const close = open === '(' ? ')' : open === '[' ? ']' : open === '{' ? '}' : '';
  if (!close) return -1;
  let depth = 0;
  for (let i = openIdx; i < tokens.length; i += 1) {
    if (tokens[i].type === 'punct') {
      if (tokens[i].value === open) depth += 1;
      else if (tokens[i].value === close) {
        depth -= 1;
        if (depth === 0) return i;
      }
    }
  }
  return -1;
}

function splitTopLevelArgs(tokens) {
  if (tokens.length === 0) return [];
  const args = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t.type === 'punct') {
      if (t.value === '(' || t.value === '[' || t.value === '{') depth += 1;
      else if (t.value === ')' || t.value === ']' || t.value === '}') {
        depth -= 1;
        if (depth < 0) return null;
      } else if (t.value === ',' && depth === 0) {
        args.push(tokens.slice(start, i));
        start = i + 1;
      }
    }
  }
  if (depth !== 0) return null;
  args.push(tokens.slice(start));
  if (args.length > 1 && args[args.length - 1].length === 0) args.pop();
  if (args.some((a) => a.length === 0)) return null;
  return args;
}

function isStringLiteralToken(tok) {
  return tok && (tok.type === 'string' || tok.type === 'static_template');
}

function isValidReceiver(tokens) {
  if (!tokens || tokens.length === 0) return false;
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.type === 'punct') {
      if (t.value === '(' || t.value === '[') {
        const end = matchBalanced(tokens, i);
        if (end < 0) return false;
        i = end + 1;
        continue;
      }
      if (t.value === '.') {
        if (i === 0 || i === tokens.length - 1) return false;
        i += 1;
        continue;
      }
      if (t.value === '?' && tokens[i + 1]?.type === 'punct' && tokens[i + 1].value === '.') {
        if (i === 0 || i + 1 >= tokens.length - 1) return false;
        i += 2;
        continue;
      }
      return false;
    }
    if (t.type === 'op') return false;
    i += 1;
  }
  return true;
}

function parseAssertStatement(tokens) {
  const stmt = tokens[tokens.length - 1]?.type === 'punct' && tokens[tokens.length - 1].value === ';'
    ? tokens.slice(0, -1)
    : tokens;
  if (
    stmt.length < 5
    || stmt[0].type !== 'ident' || stmt[0].value !== 'assert'
    || stmt[1].type !== 'punct' || stmt[1].value !== '.'
    || stmt[2].type !== 'ident'
    || stmt[3].type !== 'punct' || stmt[3].value !== '('
  ) {
    return null;
  }
  const method = stmt[2].value;
  if (method !== 'ok' && method !== 'equal' && method !== 'strictEqual' && method !== 'doesNotMatch') {
    return null;
  }
  if (matchBalanced(stmt, 3) !== stmt.length - 1) return null;
  const args = splitTopLevelArgs(stmt.slice(4, -1));
  if (!args) return null;
  return { method, args };
}

function matchMethodOrExistsCall(tokens, allowedMethods) {
  if (!tokens || tokens.length < 4) return null;
  const last = tokens[tokens.length - 1];
  if (last.type !== 'punct' || last.value !== ')') return null;

  // Find matching '(' for the trailing ')'
  let openIdx = -1;
  let depth = 0;
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    if (tokens[i].type === 'punct') {
      if (tokens[i].value === ')') depth += 1;
      else if (tokens[i].value === '(') {
        depth -= 1;
        if (depth === 0) { openIdx = i; break; }
      }
    }
  }
  if (openIdx <= 0) return null;
  const callArgs = splitTopLevelArgs(tokens.slice(openIdx + 1, -1));
  if (!callArgs) return null;

  // existsSync(...) or fs.existsSync(...)
  if (
    allowedMethods.has('existsSync')
    && (
      (openIdx === 1 && tokens[0].type === 'ident' && tokens[0].value === 'existsSync')
      || (
        openIdx === 3 && tokens[0].type === 'ident' && tokens[0].value === 'fs'
        && tokens[1].type === 'punct' && tokens[1].value === '.'
        && tokens[2].type === 'ident' && tokens[2].value === 'existsSync'
      )
    )
  ) {
    return { method: 'existsSync', recvTokens: [], callArgs };
  }

  // <recv>.<method>(...)
  if (
    openIdx >= 3
    && tokens[openIdx - 2].type === 'punct' && tokens[openIdx - 2].value === '.'
    && tokens[openIdx - 1].type === 'ident' && allowedMethods.has(tokens[openIdx - 1].value)
  ) {
    const recvTokens = tokens.slice(0, openIdx - 2);
    if (!isValidReceiver(recvTokens)) return null;
    return { method: tokens[openIdx - 1].value, recvTokens, callArgs };
  }
  return null;
}

const NEGATED_STRING_METHODS = new Set(['includes', 'startsWith', 'endsWith', 'existsSync']);
const INDEX_OF_METHODS = new Set(['indexOf']);

function findNegatedPatternRedaction(inner) {
  if (!inner || inner.length === 0) return null;
  // /regex/[flags].test(<arg>)
  if (
    inner.length >= 6
    && inner[0].type === 'regex'
    && inner[1].type === 'punct' && inner[1].value === '.'
    && inner[2].type === 'ident' && inner[2].value === 'test'
    && inner[3].type === 'punct' && inner[3].value === '('
    && matchBalanced(inner, 3) === inner.length - 1
    && inner.length > 5
  ) {
    return { start: inner[0].start, end: inner[0].bodyEnd + 1, text: '/_REDACTED_/' };
  }
  const call = matchMethodOrExistsCall(inner, NEGATED_STRING_METHODS);
  if (!call) return null;
  if (call.method === 'existsSync' && call.callArgs.length !== 1) return null;
  if (call.method !== 'existsSync' && (call.callArgs.length < 1 || call.callArgs.length > 2)) return null;
  if (call.callArgs[0].length !== 1 || !isStringLiteralToken(call.callArgs[0][0])) return null;
  const lit = call.callArgs[0][0];
  return { start: lit.start, end: lit.end, text: "'_REDACTED_'" };
}

function tokensContainIdent(tokens, varName) {
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t.type === 'ident' && t.value === varName) {
      const prev = tokens[i - 1];
      if (!(prev?.type === 'punct' && prev.value === '.')) return true;
    }
    if (t.type === 'template' && t.idents.includes(varName)) return true;
  }
  return false;
}

function isRegExpOfVarTokens(tokens, varName) {
  if (!tokens || tokens.length < 4) return false;
  let startIdx = 0;
  if (tokens[0].type === 'ident' && tokens[0].value === 'new') startIdx = 1;
  if (
    tokens.length - startIdx < 4
    || tokens[startIdx].type !== 'ident' || tokens[startIdx].value !== 'RegExp'
    || tokens[startIdx + 1].type !== 'punct' || tokens[startIdx + 1].value !== '('
    || matchBalanced(tokens, startIdx + 1) !== tokens.length - 1
  ) {
    return false;
  }
  const args = splitTopLevelArgs(tokens.slice(startIdx + 2, -1));
  if (!args || args.length < 1 || args.length > 2) return false;
  if (args[0].length !== 1 || args[0][0].type !== 'ident' || args[0][0].value !== varName) return false;
  if (args.length === 2 && (args[1].length !== 1 || !isStringLiteralToken(args[1][0]))) return false;
  return true;
}

function isLoopExprNegativeOnVar(expr, varName) {
  if (!expr || expr.length === 0) return false;
  // (new )?RegExp(var[, flags]).test(arg)
  const last = expr[expr.length - 1];
  if (last.type === 'punct' && last.value === ')') {
    let openIdx = -1;
    let depth = 0;
    for (let i = expr.length - 1; i >= 0; i -= 1) {
      if (expr[i].type === 'punct') {
        if (expr[i].value === ')') depth += 1;
        else if (expr[i].value === '(') {
          depth -= 1;
          if (depth === 0) { openIdx = i; break; }
        }
      }
    }
    if (
      openIdx >= 6
      && expr[openIdx - 2].type === 'punct' && expr[openIdx - 2].value === '.'
      && expr[openIdx - 1].type === 'ident' && expr[openIdx - 1].value === 'test'
      && isRegExpOfVarTokens(expr.slice(0, openIdx - 2), varName)
    ) {
      const testArgs = splitTopLevelArgs(expr.slice(openIdx + 1, -1));
      if (testArgs && testArgs.length === 1 && !tokensContainIdent(testArgs[0], varName)) return true;
    }
  }

  const call = matchMethodOrExistsCall(expr, NEGATED_STRING_METHODS);
  if (!call) return false;
  if (call.method === 'existsSync' && call.callArgs.length !== 1) return false;
  if (call.method !== 'existsSync' && (call.callArgs.length < 1 || call.callArgs.length > 2)) return false;
  if (tokensContainIdent(call.recvTokens, varName)) return false;
  return call.callArgs[0].length === 1 && call.callArgs[0][0].type === 'ident' && call.callArgs[0][0].value === varName;
}

function isLoopBodyNegativeAssertion(bodyLine, varName) {
  const scan = scanJsLine(bodyLine);
  if (!scan || !passesLineSafetyRules(scan.tokens)) return false;
  for (const t of scan.tokens) {
    if (t.type === 'punct' && (t.value === '{' || t.value === '}')) return false;
  }
  const parsed = parseAssertStatement(scan.tokens);
  if (!parsed) return false;
  const { method, args } = parsed;

  if (method === 'ok') {
    if (args.length < 1 || args.length > 2) return false;
    if (args[0].length < 2 || args[0][0].type !== 'punct' || args[0][0].value !== '!') return false;
    return isLoopExprNegativeOnVar(args[0].slice(1), varName);
  }
  if (method === 'equal' || method === 'strictEqual') {
    if (args.length < 2 || args.length > 3) return false;
    if (args[1].length === 1 && args[1][0].type === 'ident' && args[1][0].value === 'false') {
      return isLoopExprNegativeOnVar(args[0], varName);
    }
    if (
      args[1].length === 2
      && args[1][0].type === 'punct' && args[1][0].value === '-'
      && args[1][1].type === 'number' && args[1][1].value === '1'
    ) {
      const call = matchMethodOrExistsCall(args[0], INDEX_OF_METHODS);
      if (!call || call.callArgs.length < 1 || call.callArgs.length > 2) return false;
      if (tokensContainIdent(call.recvTokens, varName)) return false;
      return call.callArgs[0].length === 1 && call.callArgs[0][0].type === 'ident' && call.callArgs[0][0].value === varName;
    }
    return false;
  }
  if (method === 'doesNotMatch') {
    if (args.length < 2 || args.length > 3 || args[0].length === 0) return false;
    if (tokensContainIdent(args[0], varName)) return false;
    return isRegExpOfVarTokens(args[1], varName);
  }
  return false;
}

function redactUnitTestNegativeAssertion(lines, idx) {
  const line = lines[idx];
  const scan = scanJsLine(line);
  if (!scan || !passesLineSafetyRules(scan.tokens)) return line;

  const { tokens } = scan;

  // 1-4. Direct assert.(ok|equal|strictEqual|doesNotMatch) negative assertions
  const parsed = parseAssertStatement(tokens);
  if (parsed) {
    const { method, args } = parsed;
    let replacement = null;

    if (method === 'doesNotMatch') {
      if ((args.length === 2 || args.length === 3) && args[0].length > 0 && args[1].length === 1 && args[1][0].type === 'regex') {
        replacement = { start: args[1][0].start, end: args[1][0].bodyEnd + 1, text: '/_REDACTED_/' };
      }
    } else if (method === 'ok') {
      if ((args.length === 1 || args.length === 2) && args[0].length >= 2 && args[0][0].type === 'punct' && args[0][0].value === '!') {
        replacement = findNegatedPatternRedaction(args[0].slice(1));
      }
    } else if (method === 'equal' || method === 'strictEqual') {
      if (args.length === 2 || args.length === 3) {
        if (args[1].length === 1 && args[1][0].type === 'ident' && args[1][0].value === 'false') {
          replacement = findNegatedPatternRedaction(args[0]);
        } else if (
          args[1].length === 2
          && args[1][0].type === 'punct' && args[1][0].value === '-'
          && args[1][1].type === 'number' && args[1][1].value === '1'
        ) {
          const call = matchMethodOrExistsCall(args[0], INDEX_OF_METHODS);
          if (
            call
            && (call.callArgs.length === 1 || call.callArgs.length === 2)
            && call.callArgs[0].length === 1
            && isStringLiteralToken(call.callArgs[0][0])
          ) {
            const lit = call.callArgs[0][0];
            replacement = { start: lit.start, end: lit.end, text: "'_REDACTED_'" };
          }
        }
      }
    }

    if (replacement) {
      return line.slice(0, replacement.start) + replacement.text + line.slice(replacement.end);
    }
    return line;
  }

  // 5. for (const|let <var> of [<string_literals>]) { ... }
  if (
    tokens.length >= 10
    && tokens[0].type === 'ident' && tokens[0].value === 'for'
    && tokens[1].type === 'punct' && tokens[1].value === '('
    && tokens[2].type === 'ident' && (tokens[2].value === 'const' || tokens[2].value === 'let')
    && tokens[3].type === 'ident'
    && tokens[4].type === 'ident' && tokens[4].value === 'of'
    && tokens[5].type === 'punct' && tokens[5].value === '['
    && tokens[tokens.length - 1].type === 'punct' && tokens[tokens.length - 1].value === '{'
    && matchBalanced(tokens, 1) === tokens.length - 2
    && matchBalanced(tokens, 5) === tokens.length - 3
  ) {
    const varName = tokens[3].value;
    const arrayOpen = tokens[5];
    const arrayClose = tokens[tokens.length - 3];
    const innerArr = tokens.slice(6, tokens.length - 3);
    const elements = splitTopLevelArgs(innerArr);
    if (!elements || elements.length === 0) return line;
    if (!elements.every((el) => el.length === 1 && isStringLiteralToken(el[0]))) return line;

    const maxLookahead = Math.min(lines.length - 1, idx + 6);
    let closeIdx = -1;
    for (let k = idx + 1; k <= maxLookahead; k += 1) {
      const bScan = scanJsLine(lines[k]);
      if (!bScan) return line;
      const bToks = bScan.tokens;
      if (
        (bToks.length === 1 && bToks[0].type === 'punct' && bToks[0].value === '}')
        || (
          bToks.length === 2
          && bToks[0].type === 'punct' && bToks[0].value === '}'
          && bToks[1].type === 'punct' && bToks[1].value === ';'
        )
      ) {
        closeIdx = k;
        break;
      }
    }
    if (closeIdx < 0) return line;
    const bodyCount = closeIdx - idx - 1;
    if (bodyCount < 1 || bodyCount > 5) return line;

    let nonEmptyCount = 0;
    for (let k = idx + 1; k < closeIdx; k += 1) {
      if (lines[k].trim() === '') continue;
      nonEmptyCount += 1;
      if (!isLoopBodyNegativeAssertion(lines[k], varName)) return line;
    }
    if (nonEmptyCount < 1) return line;

    return line.slice(0, arrayOpen.start) + "['_REDACTED_']" + line.slice(arrayClose.end);
  }

  return line;
}

function stripAllowedLegacyLines(rel, content, { allowInstallerCleanup = true } = {}) {
  if (allowInstallerCleanup && (rel === 'scripts/install.sh' || rel === 'scripts/install.ps1')) {
    const cleanupPattern = /Remove-Item|rm\s+-rf|Test-Path|\[\s*-[de]\s+|OLD_DIR|\$OldDir|\$LegacyDir|legacy|cleanup/i;
    return content
      .split(/\r?\n/)
      .filter((line) => {
        if (!/antigravity-pulse|desktop-context/i.test(line)) return true;
        return !cleanupPattern.test(line);
      })
      .join('\n');
  }
  if (/^tests\/test_[^/]+\.mjs$/i.test(rel)) {
    const lines = content.split(/\r?\n/);
    return lines.map((_, idx) => redactUnitTestNegativeAssertion(lines, idx)).join('\n');
  }
  return content;
}

export const TESTS = [
  // --- F1 Boundaries ---
  {
    id: 'T2-F1-01',
    tier: 2,
    feature: 'F1',
    title: 'sidecars/context is completely absent and unreferenced across code/config files',
    async run() {
      assert.equal(existsSync(join(ROOT, 'sidecars', 'context')), false, 'sidecars/context directory still exists');
      const files = walkFiles(ROOT, { excludeDirs: new Set(['.git', 'node_modules', 'dist']) });
      const hits = [];
      for (const abs of files) {
        const rel = relPath(abs);
        if (rel.startsWith('tests/e2e/')) continue;
        if (!/\.(mjs|js|json|yml|yaml|sh|ps1)$/i.test(rel)) continue;
        const txt = stripAllowedLegacyLines(rel, readFileSync(abs, 'utf8'), { allowInstallerCleanup: false });
        if (txt.includes('sidecars/context')) hits.push(rel);
      }
      assert.deepEqual(hits, [], `Stale sidecars/context references in: ${hits.join(', ')}`);
    },
  },
  {
    id: 'T2-F1-02',
    tier: 2,
    feature: 'F1',
    title: 'Zero stale antigravity-pulse or antigravity-pulse-panel functional references remain',
    async run() {
      const files = walkFiles(ROOT, { excludeDirs: new Set(['.git', 'node_modules', 'dist']) });
      const hits = [];
      for (const abs of files) {
        const rel = relPath(abs);
        if (rel.startsWith('tests/e2e/') || rel === 'CHANGELOG.md') continue;
        if (!/\.(mjs|js|json|yml|yaml|sh|ps1|md|html|css)$/i.test(rel)) continue;
        const txt = stripAllowedLegacyLines(rel, readFileSync(abs, 'utf8'));
        if (/antigravity-pulse(-panel)?/i.test(txt)) hits.push(rel);
      }
      assert.deepEqual(hits, [], `Stale antigravity-pulse references in: ${hits.join(', ')}`);
    },
  },
  {
    id: 'T2-F1-03',
    tier: 2,
    feature: 'F1',
    title: 'Unknown static routes and path traversal attempts return HTTP 404',
    async run() {
      const sb = createSandbox('t2-f1-03-');
      try {
        const sidecar = await startSidecar({
          sidecarDir: SIDECAR_DIR,
          env: { ANTIGRAVITY_GEMINI_DIR: sb.geminiDir, ANTIGRAVITY_EXECUTABLE_DATA_DIR: sb.dataDir },
        });
        sb.track(() => sidecar.close());
        for (const bad of ['/nonexistent.js', '/../plugin.json', '/../../package.json']) {
          const r = await sidecar.request(bad);
          assert.equal(r.status, 404, `Expected 404 on ${bad}, got ${r.status}`);
        }
      } finally {
        await sb.cleanup();
      }
    },
  },
  {
    id: 'T2-F1-04',
    tier: 2,
    feature: 'F1',
    title: 'Missing ANTIGRAVITY_GEMINI_DIR boots cleanly without crashing',
    async run() {
      const sb = createSandbox('t2-f1-04-');
      try {
        const missingDir = join(sb.root, 'does-not-exist');
        const sidecar = await startSidecar({
          sidecarDir: SIDECAR_DIR,
          env: { ANTIGRAVITY_GEMINI_DIR: missingDir, ANTIGRAVITY_EXECUTABLE_DATA_DIR: sb.dataDir },
        });
        sb.track(() => sidecar.close());
        const rep = await sidecar.getJson('/api/report');
        assert.equal(rep.error, 'no-conversation');
        const hist = await sidecar.getJson('/api/history?refresh=true');
        assert.equal(hist.totals.all.calls, 0);
      } finally {
        await sb.cleanup();
      }
    },
  },
  {
    id: 'T2-F1-05',
    tier: 2,
    feature: 'F1',
    title: 'Legacy Pulse user-facing branding purged from code, manifests, CLI, and scripts',
    async run() {
      const targets = [
        join(ROOT, 'plugin.json'),
        join(ROOT, 'package.json'),
        ...walkFiles(join(ROOT, 'sidecars', 'agy-lens'), { excludeDirs: new Set(['.data', 'node_modules']) }),
        ...walkFiles(join(ROOT, 'bin')),
        ...walkFiles(join(ROOT, 'scripts')),
      ];
      const hits = [];
      for (const abs of targets) {
        if (!existsSync(abs)) continue;
        const rel = relPath(abs);
        const raw = stripAllowedLegacyLines(rel, readFileSync(abs, 'utf8'));
        if (/\bPulse\b/.test(raw)) hits.push(rel);
      }
      assert.deepEqual(hits, [], `Legacy Pulse branding found in: ${hits.join(', ')}`);
    },
  },

  // --- F2 Boundaries ---
  {
    id: 'T2-F2-01',
    tier: 2,
    feature: 'F2',
    title: 'sidecars/agy-lens/main.mjs and lib/*.mjs contain zero Python fallback symbols',
    async run() {
      assert.ok(existsSync(join(SIDECAR_DIR, 'main.mjs')), 'main.mjs missing');
      const files = [join(SIDECAR_DIR, 'main.mjs'), ...walkFiles(join(SIDECAR_DIR, 'lib'))];
      for (const f of files) {
        const txt = readFileSync(f, 'utf8');
        for (const sym of ['findPython', 'PYTHON_CANDIDATES', 'execFile', 'context_report.py', 'history_scanner.py']) {
          assert.equal(txt.includes(sym), false, `${relPath(f)} still contains ${sym}`);
        }
      }
    },
  },
  {
    id: 'T2-F2-02',
    tier: 2,
    feature: 'F2',
    title: 'Poisoned python binary on PATH is never spawned even on invalid report & corrupt DB',
    async run() {
      const sb = createSandbox('t2-f2-02-');
      try {
        const uuid = '99999999-9999-4999-8999-999999999999';
        writeFileSync(join(sb.desktopConvDir, `${uuid}.db`), 'corrupt-sqlite-bytes');
        const poison = makePoisonedPythonBinDir(sb.root);
        const sidecar = await startSidecar({
          sidecarDir: SIDECAR_DIR,
          env: {
            PATH: poison.pathEnv,
            ANTIGRAVITY_GEMINI_DIR: sb.geminiDir,
            ANTIGRAVITY_EXECUTABLE_DATA_DIR: sb.dataDir,
          },
        });
        sb.track(() => sidecar.close());

        const r1 = await sidecar.getJson('/api/report?conversationId=invalid');
        assert.equal(r1.error, 'no-conversation');
        const r2 = await sidecar.getJson(`/api/report?conversationId=${uuid}`);
        assert.equal(r2.error, 'failed');
        const h = await sidecar.getJson('/api/history?refresh=true');
        assert.equal(h.errors, 1);
        assert.equal(existsSync(poison.sentinelPath), false, 'Dummy python binary was invoked!');
      } finally {
        await sb.cleanup();
      }
    },
  },
  {
    id: 'T2-F2-03',
    tier: 2,
    feature: 'F2',
    title: 'tests/ and dist/ contain zero test_*.py, .pyc, or Python-parity test skips',
    async run() {
      const testFiles = walkFiles(join(ROOT, 'tests'), { excludeDirs: new Set(['e2e']) });
      const bad = [];
      for (const f of testFiles) {
        const r = relPath(f);
        if (/\.py$|\.pyc$|__pycache__/i.test(r)) bad.push(r);
        if (r.endsWith('.mjs') && readFileSync(f, 'utf8').includes('Python 3.10+ not available')) {
          bad.push(`${r} (Python parity skip)`);
        }
      }
      assert.deepEqual(bad, [], `Python remnants in tests/: ${bad.join(', ')}`);
    },
  },
  {
    id: 'T2-F2-04',
    tier: 2,
    feature: 'F2',
    title: '.github/workflows/release.yml contains zero Python references',
    async run() {
      const rel = readFileSync(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
      assert.equal(/setup-python|\bpython\b|\.py\b/i.test(rel), false);
    },
  },
  {
    id: 'T2-F2-05',
    tier: 2,
    feature: 'F2',
    title: '0-byte or garbage conversation DB returns clean JSON error without crashing sidecar',
    async run() {
      const sb = createSandbox('t2-f2-05-');
      try {
        const uuid = '77777777-7777-4777-8777-777777777777';
        writeFileSync(join(sb.desktopConvDir, `${uuid}.db`), Buffer.alloc(0));
        const sidecar = await startSidecar({
          sidecarDir: SIDECAR_DIR,
          env: { ANTIGRAVITY_GEMINI_DIR: sb.geminiDir, ANTIGRAVITY_EXECUTABLE_DATA_DIR: sb.dataDir },
        });
        sb.track(() => sidecar.close());

        const res = await sidecar.getJson(`/api/report?conversationId=${uuid}`);
        assert.ok(res.error === 'failed' || res.error === 'no-database');
        // Sidecar still healthy afterward
        assert.equal((await sidecar.request('/')).status, 200);
      } finally {
        await sb.cleanup();
      }
    },
  },

  // --- F3 Boundaries ---
  {
    id: 'T2-F3-01',
    tier: 2,
    feature: 'F3',
    title: 'Missing, non-UUID, and path-traversal conversationId all return { error: "no-conversation" }',
    async run() {
      const sb = createSandbox('t2-f3-01-');
      try {
        const sidecar = await startSidecar({
          sidecarDir: SIDECAR_DIR,
          env: { ANTIGRAVITY_GEMINI_DIR: sb.geminiDir, ANTIGRAVITY_EXECUTABLE_DATA_DIR: sb.dataDir },
        });
        sb.track(() => sidecar.close());

        for (const q of ['', '?conversationId=not-a-uuid', '?conversationId=../../etc/passwd']) {
          const r = await sidecar.getJson(`/api/report${q}`);
          assert.equal(r.error, 'no-conversation', `Unexpected response for ${q}: ${JSON.stringify(r)}`);
          assert.equal(JSON.stringify(r).includes('at '), false, 'Stack trace leaked in error JSON');
        }
      } finally {
        await sb.cleanup();
      }
    },
  },
  {
    id: 'T2-F3-02',
    tier: 2,
    feature: 'F3',
    title: 'Valid UUID with missing DB file returns { error: "no-database" }',
    async run() {
      const sb = createSandbox('t2-f3-02-');
      try {
        const sidecar = await startSidecar({
          sidecarDir: SIDECAR_DIR,
          env: { ANTIGRAVITY_GEMINI_DIR: sb.geminiDir, ANTIGRAVITY_EXECUTABLE_DATA_DIR: sb.dataDir },
        });
        sb.track(() => sidecar.close());
        const r = await sidecar.getJson('/api/report?conversationId=00000000-0000-4000-8000-000000000001');
        assert.equal(r.error, 'no-database');
      } finally {
        await sb.cleanup();
      }
    },
  },
  {
    id: 'T2-F3-03',
    tier: 2,
    feature: 'F3',
    title: 'Missing LS env vars (NO_LS) degrades gracefully to error: "unavailable" on /api/quota',
    async run() {
      const sb = createSandbox('t2-f3-03-');
      try {
        const sidecar = await startSidecar({
          sidecarDir: SIDECAR_DIR,
          env: {
            ANTIGRAVITY_GEMINI_DIR: sb.geminiDir,
            ANTIGRAVITY_EXECUTABLE_DATA_DIR: sb.dataDir,
            ANTIGRAVITY_LS_ADDRESS: '',
            ANTIGRAVITY_CSRF_TOKEN: '',
          },
        });
        sb.track(() => sidecar.close());
        const q = await sidecar.getJson('/api/quota');
        assert.deepEqual(q.pools, []);
        assert.deepEqual(q.weekly, {});
        assert.equal(q.plan, null);
        assert.equal(q.tier, null);
        assert.equal(q.error, 'unavailable');
      } finally {
        await sb.cleanup();
      }
    },
  },
  {
    id: 'T2-F3-04',
    tier: 2,
    feature: 'F3',
    title: 'quota-raw.json redacts emails, apiKeys, Bearer tokens, JWTs, and profile avatars',
    async run() {
      const sb = createSandbox('t2-f3-04-');
      try {
        const jwt = 'eyJhbGciOiJIUzI1NiJ9xxxx.eyJzdWIiOiIxMjM0NTY3ODkwIn0yyyy.abcdefghijklmnop';
        const ls = await startMockLs({
          statusResp: {
            userStatus: {
              name: 'Alice Secret',
              email: 'alice@example.com',
              profilePictureUrl: 'https://example.com/alice.png',
              apiKey: 'secret123',
              note: `Bearer ya29.abcSecretToken123 and ${jwt}`,
              cascadeModelConfigData: { clientModelConfigs: [] },
            },
          },
          modelsResp: DEFAULT_MODELS_RESP,
          summaryResp: DEFAULT_SUMMARY_RESP,
        });
        sb.track(() => ls.close());

        const sidecar = await startSidecar({
          sidecarDir: SIDECAR_DIR,
          mockLs: ls,
          env: {
            ANTIGRAVITY_GEMINI_DIR: sb.geminiDir,
            ANTIGRAVITY_EXECUTABLE_DATA_DIR: sb.dataDir,
            ANTIGRAVITY_LS_ADDRESS: ls.url,
            ANTIGRAVITY_CSRF_TOKEN: ls.csrfToken,
          },
        });
        sb.track(() => sidecar.close());

        await sidecar.getJson('/api/quota?refresh=true');
        const raw = readFileSync(join(sb.dataDir, 'quota-raw.json'), 'utf8');
        for (const secret of ['alice@example.com', 'Alice Secret', 'secret123', 'ya29.abcSecretToken123', jwt, 'https://example.com/alice.png']) {
          assert.equal(raw.includes(secret), false, `Secret leaked into quota-raw.json: ${secret}`);
        }
        assert.ok(raw.includes('[redacted]'));
      } finally {
        await sb.cleanup();
      }
    },
  },
  {
    id: 'T2-F3-05',
    tier: 2,
    feature: 'F3',
    title: 'Corrupt history-cache.json and empty steps DB recover cleanly and rewrite valid v6 cache',
    async run() {
      const sb = createSandbox('t2-f3-05-');
      try {
        writeFileSync(join(sb.dataDir, 'history-cache.json'), '{corrupt json!!!');
        const db = createConvDb(join(sb.desktopConvDir, 'empty-steps.db'), { genTable: false });
        db.close();

        const sidecar = await startSidecar({
          sidecarDir: SIDECAR_DIR,
          env: { ANTIGRAVITY_GEMINI_DIR: sb.geminiDir, ANTIGRAVITY_EXECUTABLE_DATA_DIR: sb.dataDir },
        });
        sb.track(() => sidecar.close());

        const hist = await sidecar.getJson('/api/history?refresh=true');
        assert.equal(hist.errors, 0);
        assert.equal(hist.totals.all.calls, 0);
        const cache = JSON.parse(readFileSync(join(sb.dataDir, 'history-cache.json'), 'utf8'));
        assert.equal(cache.version, 6);
      } finally {
        await sb.cleanup();
      }
    },
  },

  // --- F4 Boundaries ---
  {
    id: 'T2-F4-01',
    tier: 2,
    feature: 'F4',
    title: 'Overview, Quota, and History render actionable empty/guide states without crashing',
    async run() {
      assert.ok(existsSync(join(WEB_DIR, 'views', 'overview.js')), 'web/views/overview.js missing');
      const res = await runChromeBrowserTest({
        webDir: WEB_DIR,
        lang: 'en-US',
        mockApi: {
          '/api/report': { error: 'no-conversation' },
          '/api/quota': { pools: [], weekly: {}, plan: null, tier: null, error: 'unavailable', message: 'LS offline' },
          '/api/history': {
            totals: {
              today: { input: 0, output: 0, cache_read: 0, calls: 0, conversations: 0 },
              d7: { input: 0, output: 0, cache_read: 0, calls: 0, conversations: 0 },
              d30: { input: 0, output: 0, cache_read: 0, calls: 0, conversations: 0 },
              all: { input: 0, output: 0, cache_read: 0, calls: 0, conversations: 0 },
            },
            by_model: [],
            by_conversation: [],
            daily: [],
            hourly_today: [],
            d7_by_pool: {},
            sources: { desktop: 0, cli: 0 },
            errors: 0,
          },
        },
        testScript: `
          await new Promise(r => setTimeout(r, 350));
          const hasGoQuota = Boolean(document.querySelector('[data-go-tab="quota"]'));
          const hasGoHistory = Boolean(document.querySelector('[data-go-tab="history"]'));
          document.getElementById('tab-quota')?.click();
          await new Promise(r => setTimeout(r, 200));
          const hasRetryQuota = Boolean(document.querySelector('[data-retry="quota"]'));
          document.getElementById('tab-history')?.click();
          await new Promise(r => setTimeout(r, 200));
          const historyText = document.getElementById('history')?.textContent || '';
          const el = document.createElement('script');
          el.id = '__e2e_result';
          el.type = 'application/json';
          el.textContent = JSON.stringify({
            errors: window.__e2eErrors,
            hasGoQuota,
            hasGoHistory,
            hasRetryQuota,
            historyNonEmpty: historyText.trim().length > 10,
          });
          document.body.appendChild(el);
        `,
      });
      assert.deepEqual(res.consoleErrors, []);
      assert.equal(res.result.hasGoQuota, true);
      assert.equal(res.result.hasGoHistory, true);
      assert.equal(res.result.hasRetryQuota, true);
      assert.equal(res.result.historyNonEmpty, true);
    },
  },
  {
    id: 'T2-F4-02',
    tier: 2,
    feature: 'F4',
    title: 'XSS payloads in conversation titles and model names are HTML-escaped',
    async run() {
      assert.ok(existsSync(join(WEB_DIR, 'views', 'history.js')), 'web/views/history.js missing');
      const xss = '<img src=x onerror="window.__xss=1">';
      const res = await runChromeBrowserTest({
        webDir: WEB_DIR,
        lang: 'en-US',
        mockApi: {
          '/api/report': { error: 'no-conversation' },
          '/api/quota': { pools: [], weekly: {}, plan: null, tier: null, error: 'unavailable' },
          '/api/history': {
            totals: {
              today: { input: 100, output: 20, cache_read: 0, calls: 1, conversations: 1 },
              d7: { input: 100, output: 20, cache_read: 0, calls: 1, conversations: 1 },
              d30: { input: 100, output: 20, cache_read: 0, calls: 1, conversations: 1 },
              all: { input: 100, output: 20, cache_read: 0, calls: 1, conversations: 1 },
            },
            by_model: [{ model: xss, display_name: xss, pool: 'other', input: 100, output: 20, cache_read: 0, calls: 1 }],
            by_conversation: [{
              id: 'xss-conv',
              title: xss,
              source: 'desktop',
              is_subagent: false,
              calls: 1,
              input: 100,
              output: 20,
              cache_read: 0,
              d7_tokens: 120,
              last_at: new Date().toISOString(),
              models: [xss],
            }],
            daily: [],
            hourly_today: [],
            d7_by_pool: {},
            sources: { desktop: 1, cli: 0 },
            errors: 0,
          },
        },
        testScript: `
          await new Promise(r => setTimeout(r, 300));
          document.getElementById('tab-history')?.click();
          await new Promise(r => setTimeout(r, 200));
          document.querySelector('[data-hview="list"]')?.click();
          await new Promise(r => setTimeout(r, 200));
          const listText = document.getElementById('history-list-body')?.textContent || '';
          const el = document.createElement('script');
          el.id = '__e2e_result';
          el.type = 'application/json';
          el.textContent = JSON.stringify({
            errors: window.__e2eErrors,
            xssFired: window.__xss === 1,
            hasLiteralTag: listText.includes('<img'),
          });
          document.body.appendChild(el);
        `,
      });
      assert.deepEqual(res.consoleErrors, []);
      assert.equal(res.result.xssFired, false, 'XSS payload executed!');
      assert.equal(res.result.hasLiteralTag, true);
    },
  },
  {
    id: 'T2-F4-03',
    tier: 2,
    feature: 'F4',
    title: 'Web UI contains zero external CDN or network asset dependencies',
    async run() {
      assert.ok(existsSync(join(WEB_DIR, 'i18n.js')), 'web/i18n.js missing');
      const webFiles = walkFiles(WEB_DIR);
      for (const f of webFiles) {
        const txt = readFileSync(f, 'utf8');
        assert.equal(/https?:\/\/(fonts\.|cdn\.|unpkg\.com|jsdelivr|cdnjs|ajax\.googleapis)/i.test(txt), false, `External CDN reference in ${relPath(f)}`);
      }
    },
  },
  {
    id: 'T2-F4-04',
    tier: 2,
    feature: 'F4',
    title: 'Web UI boots and switches tabs/language cleanly when localStorage throws SecurityError',
    async run() {
      assert.ok(existsSync(join(WEB_DIR, 'i18n.js')), 'web/i18n.js missing');
      const res = await runChromeBrowserTest({
        webDir: WEB_DIR,
        lang: 'en-US',
        poisonLocalStorage: true,
        mockApi: {
          '/api/report': { error: 'no-conversation' },
          '/api/quota': { pools: [], weekly: {}, plan: null, tier: null, error: 'unavailable' },
          '/api/history': { totals: { today: {}, d7: {}, d30: {}, all: { calls: 0 } }, by_model: [], by_conversation: [], daily: [], hourly_today: [], d7_by_pool: {}, sources: { desktop: 0, cli: 0 }, errors: 0 },
        },
        testScript: `
          await new Promise(r => setTimeout(r, 300));
          document.getElementById('tab-quota')?.click();
          document.querySelector('#lang [data-lang="zh"]')?.click();
          await new Promise(r => setTimeout(r, 150));
          const el = document.createElement('script');
          el.id = '__e2e_result';
          el.type = 'application/json';
          el.textContent = JSON.stringify({
            errors: window.__e2eErrors,
            tabQuotaText: document.getElementById('tab-quota')?.textContent?.trim(),
          });
          document.body.appendChild(el);
        `,
      });
      assert.deepEqual(res.consoleErrors, []);
      assert.equal(res.result.tabQuotaText, '额度');
    },
  },
  {
    id: 'T2-F4-05',
    tier: 2,
    feature: 'F4',
    title: 'Narrow 320px and 420px side-panel viewports render without horizontal overflow',
    async run() {
      assert.ok(existsSync(join(WEB_DIR, 'i18n.js')), 'web/i18n.js missing');
      for (const width of [320, 420]) {
        const res = await runChromeBrowserTest({
          webDir: WEB_DIR,
          lang: 'en-US',
          viewport: { width, height: 760 },
          mockApi: {
            '/api/report': { error: 'no-conversation' },
            '/api/quota': { pools: [], weekly: {}, plan: null, tier: null, error: 'unavailable' },
            '/api/history': { totals: { today: {}, d7: {}, d30: {}, all: { calls: 0 } }, by_model: [], by_conversation: [], daily: [], hourly_today: [], d7_by_pool: {}, sources: { desktop: 0, cli: 0 }, errors: 0 },
          },
          testScript: `
            await new Promise(r => setTimeout(r, 300));
            const checks = [];
            for (const id of ['tab-overview', 'tab-quota', 'tab-history']) {
              document.getElementById(id)?.click();
              await new Promise(r => setTimeout(r, 120));
              checks.push({ id, scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth });
            }
            const el = document.createElement('script');
            el.id = '__e2e_result';
            el.type = 'application/json';
            el.textContent = JSON.stringify({ errors: window.__e2eErrors, checks });
            document.body.appendChild(el);
          `,
        });
        assert.deepEqual(res.consoleErrors, []);
        for (const c of res.result.checks) {
          assert.ok(c.scrollWidth <= c.innerWidth, `Horizontal overflow at ${width}px on ${c.id}: scrollWidth=${c.scrollWidth} > innerWidth=${c.innerWidth}`);
        }
      }
    },
  },

  // --- F5 Boundaries ---
  {
    id: 'T2-F5-01',
    tier: 2,
    feature: 'F5',
    title: 'zh-TW, zh-HK, zh-Hans-CN, and zh all auto-detect to zh',
    async run() {
      const i18nPath = join(WEB_DIR, 'i18n.js');
      assert.ok(existsSync(i18nPath), 'web/i18n.js missing');
      const { detectDefaultLang } = await import(`${pathToFileURL(i18nPath).href}?t=${Date.now()}`);
      assert.equal(typeof detectDefaultLang, 'function');
      for (const loc of ['zh-TW', 'zh-HK', 'zh-Hans-CN', 'zh', 'ZH-cn']) {
        assert.equal(detectDefaultLang(loc, null), 'zh', `Expected zh for ${loc}`);
      }
      const res = await runChromeBrowserTest({
        webDir: WEB_DIR,
        lang: 'zh-TW',
        mockApi: { '/api/report': { error: 'no-conversation' } },
        testScript: `
          await new Promise(r => setTimeout(r, 250));
          const el = document.createElement('script');
          el.id = '__e2e_result';
          el.type = 'application/json';
          el.textContent = JSON.stringify({
            errors: window.__e2eErrors,
            htmlLang: document.documentElement.lang,
            tab: document.getElementById('tab-overview')?.textContent?.trim(),
          });
          document.body.appendChild(el);
        `,
      });
      assert.deepEqual(res.consoleErrors, []);
      assert.equal(res.result.htmlLang, 'zh-CN');
      assert.equal(res.result.tab, '概览');
    },
  },
  {
    id: 'T2-F5-02',
    tier: 2,
    feature: 'F5',
    title: 'Non-zh locales (ja-JP, fr-FR, de, empty, undefined) fall back to en',
    async run() {
      const i18nPath = join(WEB_DIR, 'i18n.js');
      assert.ok(existsSync(i18nPath), 'web/i18n.js missing');
      const { detectDefaultLang } = await import(`${pathToFileURL(i18nPath).href}?t=${Date.now()}`);
      for (const loc of ['ja-JP', 'fr-FR', 'de', '', undefined, null]) {
        assert.equal(detectDefaultLang(loc, null), 'en', `Expected en for ${String(loc)}`);
      }
    },
  },
  {
    id: 'T2-F5-03',
    tier: 2,
    feature: 'F5',
    title: 'Invalid stored ctx.lang value falls back cleanly to navigator.language detection',
    async run() {
      assert.ok(existsSync(join(WEB_DIR, 'i18n.js')), 'web/i18n.js missing');
      const res = await runChromeBrowserTest({
        webDir: WEB_DIR,
        lang: 'en-US',
        localStorageInit: { 'ctx.lang': 'klingon' },
        mockApi: { '/api/report': { error: 'no-conversation' } },
        testScript: `
          await new Promise(r => setTimeout(r, 250));
          const el = document.createElement('script');
          el.id = '__e2e_result';
          el.type = 'application/json';
          el.textContent = JSON.stringify({
            errors: window.__e2eErrors,
            htmlLang: document.documentElement.lang,
            tab: document.getElementById('tab-overview')?.textContent?.trim(),
          });
          document.body.appendChild(el);
        `,
      });
      assert.deepEqual(res.consoleErrors, []);
      assert.equal(res.result.htmlLang, 'en');
      assert.equal(res.result.tab, 'Overview');
    },
  },
  {
    id: 'T2-F5-04',
    tier: 2,
    feature: 'F5',
    title: 'I18N.en and I18N.zh share complete key parity with zero undefined values',
    async run() {
      const i18nPath = join(WEB_DIR, 'i18n.js');
      assert.ok(existsSync(i18nPath), 'web/i18n.js missing');
      const { I18N } = await import(`${pathToFileURL(i18nPath).href}?t=${Date.now()}`);
      const enKeys = Object.keys(I18N.en).sort();
      const zhKeys = Object.keys(I18N.zh).sort();
      assert.deepEqual(enKeys, zhKeys, 'Top-level I18N keys differ between en and zh');
      for (const k of enKeys) {
        assert.notEqual(I18N.en[k], undefined, `I18N.en.${k} is undefined`);
        assert.notEqual(I18N.zh[k], undefined, `I18N.zh.${k} is undefined`);
      }
    },
  },
  {
    id: 'T2-F5-05',
    tier: 2,
    feature: 'F5',
    title: 'Initial en-US DOM contains zero unintended Chinese characters across all 3 tabs',
    async run() {
      assert.ok(existsSync(join(WEB_DIR, 'i18n.js')), 'web/i18n.js missing');
      const res = await runChromeBrowserTest({
        webDir: WEB_DIR,
        lang: 'en-US',
        mockApi: {
          '/api/report': { error: 'no-conversation' },
          '/api/quota': { pools: [], weekly: {}, plan: 'Pro', tier: 'Ultra', fetched_at: new Date().toISOString() },
          '/api/history': {
            totals: {
              today: { input: 100, output: 50, cache_read: 0, calls: 1, conversations: 1 },
              d7: { input: 100, output: 50, cache_read: 0, calls: 1, conversations: 1 },
              d30: { input: 100, output: 50, cache_read: 0, calls: 1, conversations: 1 },
              all: { input: 100, output: 50, cache_read: 0, calls: 1, conversations: 1 },
            },
            by_model: [{ model: 'claude-opus-4-6', display_name: 'Claude Opus 4.6', pool: 'claude_gpt', input: 100, output: 50, cache_read: 0, calls: 1 }],
            by_conversation: [],
            daily: [],
            hourly_today: [],
            d7_by_pool: { claude_gpt: 150 },
            sources: { desktop: 1, cli: 0 },
            errors: 0,
          },
        },
        testScript: `
          await new Promise(r => setTimeout(r, 300));
          const texts = [];
          for (const id of ['overview', 'quota', 'history']) {
            document.getElementById('tab-' + id)?.click();
            await new Promise(r => setTimeout(r, 150));
            texts.push({ id, text: document.getElementById(id)?.textContent || '' });
          }
          const el = document.createElement('script');
          el.id = '__e2e_result';
          el.type = 'application/json';
          el.textContent = JSON.stringify({ errors: window.__e2eErrors, texts });
          document.body.appendChild(el);
        `,
      });
      assert.deepEqual(res.consoleErrors, []);
      for (const pane of res.result.texts) {
        assert.equal(/[\u4e00-\u9fff]/.test(pane.text), false, `Unexpected Chinese characters in English ${pane.id} pane: ${pane.text.slice(0, 120)}`);
      }
    },
  },

  // --- F6 Boundaries ---
  {
    id: 'T2-F6-01',
    tier: 2,
    feature: 'F6',
    title: 'Share Card SVG and PNG never leak conversation titles',
    async run() {
      const scPath = join(WEB_DIR, 'views', 'share-card.js');
      assert.ok(existsSync(scPath), 'web/views/share-card.js missing');
      const { buildShareCardSvg } = await import(`${pathToFileURL(scPath).href}?t=${Date.now()}`);
      const svg = buildShareCardSvg({
        period: 'd30',
        totals: { input: 10000, output: 2000, cache_read: 5000, calls: 4, conversations: 2, cost_usd: 0.3 },
        byModel: [{ model: 'claude-opus-4-6', display_name: 'Claude Opus 4.6', input: 10000, output: 2000, cache_read: 5000, calls: 4 }],
        daily: [],
        d7ByPool: { claude_gpt: 12000 },
        by_conversation: [
          { id: 'c1', title: 'SECRET_PROJECT_TITLE_XYZ' },
          { id: 'c2', title: 'Confidential Deal' },
        ],
        lang: 'en',
        theme: 'dark',
      });
      assert.equal(svg.includes('SECRET_PROJECT_TITLE_XYZ'), false);
      assert.equal(svg.includes('Confidential Deal'), false);
    },
  },
  {
    id: 'T2-F6-02',
    tier: 2,
    feature: 'F6',
    title: 'Share Card SVG never leaks filesystem paths or OS usernames',
    async run() {
      const scPath = join(WEB_DIR, 'views', 'share-card.js');
      assert.ok(existsSync(scPath), 'web/views/share-card.js missing');
      const { buildShareCardSvg } = await import(`${pathToFileURL(scPath).href}?t=${Date.now()}`);
      const svg = buildShareCardSvg({
        period: 'd30',
        totals: { input: 5000, output: 1000, cache_read: 0, calls: 2, conversations: 1, cost_usd: 0.1 },
        byModel: [{ model: 'gemini-4-neon-high', display_name: 'Gemini 4 Neon (High)', input: 5000, output: 1000, cache_read: 0, calls: 2 }],
        daily: [],
        d7ByPool: { gemini: 6000 },
        by_conversation: [
          { id: 'c1', title: 'C:\\Users\\alice\\secret-repo', workspace: '/home/bob/.ssh' },
        ],
        workspace: 'C:\\Users\\alice\\secret-repo',
        lang: 'en',
        theme: 'dark',
      });
      for (const leak of ['C:\\Users\\', '/home/', 'alice', 'bob', '.ssh', 'secret-repo']) {
        assert.equal(svg.includes(leak), false, `Share Card leaked path fragment: ${leak}`);
      }
    },
  },
  {
    id: 'T2-F6-03',
    tier: 2,
    feature: 'F6',
    title: 'Share Card handles zero/empty usage history cleanly without NaN or Infinity',
    async run() {
      const scPath = join(WEB_DIR, 'views', 'share-card.js');
      assert.ok(existsSync(scPath), 'web/views/share-card.js missing');
      const { buildShareCardSvg } = await import(`${pathToFileURL(scPath).href}?t=${Date.now()}`);
      const svg = buildShareCardSvg({
        period: 'd30',
        totals: { input: 0, output: 0, cache_read: 0, calls: 0, conversations: 0 },
        byModel: [],
        daily: [],
        d7ByPool: {},
        lang: 'en',
        theme: 'dark',
      });
      assert.match(svg, /^<svg\b/);
      assert.equal(/\bNaN\b|\bInfinity\b|\bundefined\b/.test(svg), false);
    },
  },
  {
    id: 'T2-F6-04',
    tier: 2,
    feature: 'F6',
    title: 'Share Card XML-escapes special characters in model names',
    async run() {
      const scPath = join(WEB_DIR, 'views', 'share-card.js');
      assert.ok(existsSync(scPath), 'web/views/share-card.js missing');
      const { buildShareCardSvg } = await import(`${pathToFileURL(scPath).href}?t=${Date.now()}`);
      const svg = buildShareCardSvg({
        period: 'd30',
        totals: { input: 100, output: 50, cache_read: 0, calls: 1, conversations: 1 },
        byModel: [{ model: 'special', display_name: 'Claude <Opus> & "Test"', input: 100, output: 50, cache_read: 0, calls: 1 }],
        daily: [],
        d7ByPool: {},
        lang: 'en',
        theme: 'dark',
      });
      assert.equal(svg.includes('<Opus>'), false, 'Unescaped XML tag <Opus> in SVG');
      assert.ok(svg.includes('&lt;Opus&gt;') && svg.includes('&amp;'));
    },
  },
  {
    id: 'T2-F6-05',
    tier: 2,
    feature: 'F6',
    title: 'Share Card bounds layout cleanly when given >12 models',
    async run() {
      const scPath = join(WEB_DIR, 'views', 'share-card.js');
      assert.ok(existsSync(scPath), 'web/views/share-card.js missing');
      const { buildShareCardSvg } = await import(`${pathToFileURL(scPath).href}?t=${Date.now()}`);
      const byModel = Array.from({ length: 12 }, (_, i) => ({
        model: `model-${i}`,
        display_name: `Model Number ${i}`,
        input: 1000 * (12 - i),
        output: 200,
        cache_read: 0,
        calls: 2,
      }));
      const svg = buildShareCardSvg({
        period: 'd30',
        totals: { input: 78000, output: 2400, cache_read: 0, calls: 24, conversations: 5 },
        byModel,
        daily: [],
        d7ByPool: {},
        lang: 'en',
        theme: 'dark',
      });
      const tagMatch = svg.match(/<svg\b((?:[^>"']|"[^"]*"|'[^']*')*)>/i);
      const attrsStr = tagMatch ? tagMatch[1] : '';
      const attrs = Object.create(null);
      for (const m of attrsStr.matchAll(/\s([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
        attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? '';
      }
      const hMatch = (attrs.height || '').trim().match(/^(\d+(?:\.\d+)?)$/);
      const vbMatch = (attrs.viewbox || '').trim().match(/[\s,](\d+(?:\.\d+)?)$/);
      const svgHeight = hMatch ? Number(hMatch[1]) : (vbMatch ? Number(vbMatch[1]) : null);
      assert.ok(svgHeight !== null && Number.isFinite(svgHeight) && svgHeight > 0, 'SVG missing numeric height attribute or viewBox height');
      assert.ok(svgHeight <= 900, `Share Card SVG grew unbounded: height=${svgHeight}`);
      // Should cap displayed models (e.g. <= 6 rows)
      assert.equal(svg.includes('Model Number 11'), false, 'Long model list was not truncated');
    },
  },
];
