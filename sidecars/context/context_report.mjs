#!/usr/bin/env node
/**
 * Context window usage report for Antigravity 2.0 conversations.
 *
 * Pure Node.js ESM port of context_report.py (itself a port of the agy CLI
 * `/context` command, cli/model.ContextModel in agy 1.4.4) using built-in
 * `node:sqlite` (zero Python or external dependencies).
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DISPLAY_PREFIX,
  POOLS,
  callCostInfo,
  loadModelCatalog,
  loadPricingFile,
  modelPool,
  parseDb as parseHistoryDb,
} from './history_scanner.mjs';
import { Msg, encodeVarint, formatLocalIso, localDateKey, openReadOnlyDb, roundN } from './pb.mjs';

const UTF8_ENC = new TextEncoder();
const cmpCode = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// CortexStep oneof payload field numbers.
export const STEP_VIEW_FILE = 14;
export const STEP_USER_INPUT = 19;
export const STEP_PLANNER_RESPONSE = 20;
export const STEP_CHECKPOINT = 30;
export const STEP_CODE_ACTION = 10;

export const STATUS_DONE = 3;

// TokenType values of TopLevelTokenGroup.type.
export const TOKEN_SYSTEM_PROMPT = 1;
export const TOKEN_TOOLS = 2;
export const TOKEN_RULES = 3;
export const TOKEN_MCP_TOOLS = 4;
export const TOKEN_SKILLS = 5;
export const TOKEN_SUBAGENTS = 6;
export const TOKEN_CHAT_MESSAGES = 7;
export const TOKEN_WORKFLOWS = 8;
export const TOKEN_PLUGINS = 9;
export const TOKEN_FLOWS = 10;

// CortexStepType names (exa.cortex_pb), used to parse "N: TYPE" chat item names.
export const STEP_TYPES = {
  UNSPECIFIED: 0, DUMMY: 1, FINISH: 2, PLAN_INPUT: 3, MQUERY: 4, CODE_ACTION: 5,
  GIT_COMMIT: 6, GREP_SEARCH: 7, VIEW_FILE: 8, LIST_DIRECTORY: 9, COMPILE: 10,
  VIEW_CODE_ITEM: 13, USER_INPUT: 14, PLANNER_RESPONSE: 15, ERROR_MESSAGE: 17,
  RUN_COMMAND: 21, CHECKPOINT: 23, PROPOSE_CODE: 24, FIND: 25, SUGGESTED_RESPONSES: 27,
  COMMAND_STATUS: 28, MEMORY: 29, READ_URL_CONTENT: 31, VIEW_CONTENT_CHUNK: 32,
  SEARCH_WEB: 33, RETRIEVE_MEMORY: 34, MCP_TOOL: 38, MANAGER_FEEDBACK: 39,
  TOOL_CALL_PROPOSAL: 40, TOOL_CALL_CHOICE: 41, TRAJECTORY_CHOICE: 42, CLIPBOARD: 45,
  VIEW_FILE_OUTLINE: 47, POST_PR_REVIEW: 49, LIST_RESOURCES: 51, READ_RESOURCE: 52,
  LINT_DIFF: 53, FIND_ALL_REFERENCES: 54, BRAIN_UPDATE: 55, OPEN_BROWSER_URL: 56,
  RUN_EXTENSION_CODE: 57, PROPOSAL_FEEDBACK: 59, TRAJECTORY_SEARCH: 60,
  EXECUTE_BROWSER_JAVASCRIPT: 61, LIST_BROWSER_PAGES: 62, CAPTURE_BROWSER_SCREENSHOT: 63,
  CLICK_BROWSER_PIXEL: 64, READ_TERMINAL: 65, CAPTURE_BROWSER_CONSOLE_LOGS: 66,
  READ_BROWSER_PAGE: 67, BROWSER_GET_DOM: 68, CODE_SEARCH: 73, BROWSER_INPUT: 74,
  BROWSER_MOVE_MOUSE: 75, BROWSER_SELECT_OPTION: 76, BROWSER_SCROLL_UP: 77,
  BROWSER_SCROLL_DOWN: 78, BROWSER_CLICK_ELEMENT: 79, BROWSER_PRESS_KEY: 80,
  TASK_BOUNDARY: 81, NOTIFY_USER: 82, CODE_ACKNOWLEDGEMENT: 83, INTERNAL_SEARCH: 84,
  BROWSER_SUBAGENT: 85, FILE_CHANGE: 86, MOVE: 87, BROWSER_SCROLL: 88,
  KNOWLEDGE_GENERATION: 89, EPHEMERAL_MESSAGE: 90, GENERATE_IMAGE: 91,
  DELETE_DIRECTORY: 92, COMPILE_APPLET: 93, INSTALL_APPLET_DEPENDENCIES: 94,
  INSTALL_APPLET_PACKAGE: 95, BROWSER_RESIZE_WINDOW: 96, BROWSER_DRAG_PIXEL_TO_PIXEL: 97,
  CONVERSATION_HISTORY: 98, KNOWLEDGE_ARTIFACTS: 99, SEND_COMMAND_INPUT: 100,
  SYSTEM_MESSAGE: 101, WAIT: 102, AGENCY_TOOL_CALL: 103, CIDER_AGENT_DUMMY: 104,
  BUILD_CLEANER: 105, BLAZE_BUILD_TARGETS: 106, BLAZE_TEST_TARGETS: 107,
  SET_UP_FIREBASE: 108, MOMA: 109, RESTART_DEV_SERVER: 110, DEPLOY_FIREBASE: 111,
  SHELL_EXEC: 112, BROWSER_MOUSE_WHEEL: 113, LINT_APPLET: 114, KI_INSERTION: 116,
  RETRIEVE_CONTENT: 117, CRITIQUE: 118, FINDINGS: 119, BROWSER_MOUSE_UP: 120,
  BROWSER_MOUSE_DOWN: 121, WORKSPACE_API: 122, BROWSER_LIST_NETWORK_REQUESTS: 123,
  BROWSER_GET_NETWORK_REQUEST: 124, BROWSER_REFRESH_PAGE: 125, EDIT_NOTEBOOK: 126,
  INVOKE_SUBAGENT: 127, WRITE_BLOB: 128, READ_NOTEBOOK: 129, PROPOSE_AI_COMMENTS: 130,
  START_CODE_REVIEW: 131, GENERIC: 132, SET_UP_CLOUD_SQL: 133, EXECUTE_NOTEBOOK: 134,
  CLOUD_SQL_UPDATE_SCHEMA: 135, RPC_ACTION: 136, CLOUD_SQL_EXECUTE_SQL: 137,
  ASK_QUESTION: 138, DIRECTORY_RULES: 139, TOOL_SEARCH: 140,
};

export const CAT_USER = 0;
export const CAT_AGENT = 1;
export const CAT_TOOL = 2;
export const CAT_CHECKPOINT = 3;
export const CAT_SYSTEM = 4;

// --- formatting --------------------------------------------------------------

export function fmtTok(n) {
  if (n >= 1_000_000) {
    const v = n / 1_000_000;
    return Number.isInteger(v) ? `${v}M` : `${roundN(v, 1).toFixed(1)}M`;
  }
  if (n >= 1_000) return `${roundN(n / 1_000, 1).toFixed(1)}k`;
  return String(n);
}

export function fmtCtxLimit(n) {
  return fmtTok(n);
}

export function goDiv4(n) {
  return Math.trunc(n / 4);
}

export function shortenPath(uri) {
  let p = String(uri || '');
  if (p.startsWith('file:')) {
    try {
      const u = new URL(p);
      p = decodeURIComponent(u.pathname);
      if (p.length > 2 && p[0] === '/' && p[2] === ':') p = p.slice(1);
    } catch { /* keep p */ }
  }
  const home = homedir().replace(/\\/g, '/');
  p = p.replace(/\\/g, '/');
  if (p.startsWith(home)) return `~${p.slice(home.length)}`;
  return p;
}

// --- stats (model.ContextModel.collectStats) ---------------------------------

export function stepCategory(stepType) {
  if (stepType === 14) return CAT_USER;
  if (stepType === 15) return CAT_AGENT;
  if (stepType === 23) return CAT_CHECKPOINT;
  if (stepType === 0 || stepType === 2 || stepType === 101) return CAT_SYSTEM;
  return CAT_TOOL;
}

export const STEP_GENERIC = 140;
export const GENERIC_TYPE = 132;
export const ORIGINAL_STEP_TYPE_URL = '/gemini_coder.Step';

export function packedOriginalStep(generic) {
  const result = generic.msg(2);
  if (!result) return null;
  const payload = result.msg(6);
  if (payload && payload.str(1).endsWith(ORIGINAL_STEP_TYPE_URL)) return payload.bytes(2);
  for (const entry of result.msgs(5)) {
    if (entry.str(1) === '__original_cortex_step') {
      const value = entry.msg(2);
      if (value && value.str(1).endsWith(ORIGINAL_STEP_TYPE_URL)) return value.bytes(2);
    }
  }
  return null;
}

export function isSkillFile(filePath) {
  return String(filePath || '').replace(/\\/g, '/').endsWith('/SKILL.md');
}

function concatBytes(...chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

export class Step {
  constructor(pos, payload, stepType, status, metadata) {
    this.pos = pos;
    this.pb = new Msg(payload);
    this.type = this.pb.has(1) ? this.pb.int(1) : stepType;
    this.status = this.pb.has(4) ? this.pb.int(4) : status;
    this.md = this.pb.msg(5) || new Msg(metadata);
    this.view_file_override = null;
    if (this.type === GENERIC_TYPE) this.rehydrate();
  }

  rehydrate() {
    const generic = this.pb.msg(STEP_GENERIC);
    if (!generic) return;
    const original = packedOriginalStep(generic);
    if (original !== null) {
      this.pb = new Msg(original);
      this.type = this.pb.int(1);
      this.md = this.pb.msg(5) || new Msg(null);
      return;
    }
    const tc = this.md.msg(4);
    if (!tc) return;
    const toolName = tc.str(2);
    if (toolName !== 'view_file' && toolName !== 'read_file') return;
    let args;
    try {
      args = JSON.parse(tc.str(3) || '{}');
    } catch {
      return;
    }
    let filePath = '';
    for (const k of ['AbsolutePath', 'Path', 'FilePath']) {
      if (typeof args[k] === 'string' && args[k]) {
        filePath = args[k];
        break;
      }
    }
    if (filePath) {
      this.type = 8; // VIEW_FILE
      const pathBytes = UTF8_ENC.encode(filePath);
      const tail = isSkillFile(filePath) ? Uint8Array.from([0x88, 0x01, 0x01]) : new Uint8Array(0);
      this.view_file_override = new Msg(concatBytes(Uint8Array.from([0x0a]), encodeVarint(pathBytes.length), pathBytes, tail));
    }
  }

  payload(fn) {
    if (fn === STEP_VIEW_FILE && this.view_file_override !== null) return this.view_file_override;
    return this.pb.msg(fn);
  }
}

export function estimateStepTokens(step) {
  const ui = step.payload(STEP_USER_INPUT);
  const pr = step.payload(STEP_PLANNER_RESPONSE);
  let n;
  if (ui !== null) {
    n = ui.bytes(2).length;
  } else if (pr !== null) {
    n = pr.bytes(1).length;
  } else {
    const tc = step.md.msg(4);
    n = tc ? tc.bytes(3).length : 0;
    const out = step.md.int(23, true);
    if (out > 0) return out;
  }
  if (n === 0) return 0;
  return Math.max(1, goDiv4(n));
}

export function stepTokens(step) {
  const usage = step.md.msg(9);
  if (usage !== null) return usage.int(3);
  return estimateStepTokens(step);
}

export function compactionTokens(step) {
  const retries = step.md.msgs(28);
  for (let i = retries.length - 1; i >= 0; i -= 1) {
    const usage = retries[i].msg(2);
    if (!usage) continue;
    const resp = usage.int(10);
    if (resp) return resp;
    const out = usage.int(3);
    const thinking = usage.int(9);
    return thinking < out ? out - thinking : 0;
  }
  return 0;
}

export function checkpointSummaryTokens(step) {
  const t = compactionTokens(step);
  if (t) return t;
  const ck = step.payload(STEP_CHECKPOINT) || new Msg(null);
  return goDiv4(ck.bytes(4).length + ck.bytes(5).length + ck.bytes(6).length);
}

export function checkpointNewerThanGeneration(steps, chatStart) {
  let i = steps.length - 1;
  while (i >= 0) {
    const s = steps[i];
    if (s.payload(STEP_CHECKPOINT) !== null && s.status === STATUS_DONE) break;
    i -= 1;
  }
  if (i < 0) return [-1, null];
  for (let j = i + 1; j < steps.length; j += 1) {
    const s = steps[j];
    if (s.payload(STEP_PLANNER_RESPONSE) !== null && s.status === STATUS_DONE) return [-1, null];
  }
  const genCk = chatStart !== null ? chatStart.int(2, true) : -1;
  const ckIdx = steps[i].payload(STEP_CHECKPOINT).int(1);
  if (genCk >= ckIdx) return [-1, null];
  return [i, steps[i]];
}

export function chatTokensByCategory(items) {
  const out = [0, 0, 0, 0]; // user, agent, tool, system
  if (!items.length) return [false, out];
  for (const it of items) {
    const s = it.str(1);
    const idx = s.indexOf(': ');
    if (idx < 0) return [false, [0, 0, 0, 0]];
    const left = s.slice(0, idx);
    const right = s.slice(idx + 2);
    if (!/^[+-]?[0-9]+$/.test(left) || !Object.prototype.hasOwnProperty.call(STEP_TYPES, right)) {
      return [false, [0, 0, 0, 0]];
    }
    const cat = stepCategory(STEP_TYPES[right]);
    const tok = it.int(3, true);
    if (cat === CAT_USER) out[0] += tok;
    else if (cat === CAT_AGENT || cat === CAT_CHECKPOINT) out[1] += tok;
    else if (cat === CAT_TOOL) out[2] += tok;
    else out[3] += tok;
  }
  return [true, out];
}

function isDir(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

function isRegularFile(p) {
  try { return existsSync(p) && !statSync(p).isDirectory(); } catch { return false; }
}

export function detectSystemFiles(home, workspace, appDir) {
  if (!home) return [];
  const gemini = join(home, '.gemini');
  const disp = '~/.' + 'gemini';
  const found = [];
  if (isRegularFile(join(gemini, 'GEMINI.md'))) found.push(`${disp}/GEMINI.md`);
  for (const sub of ['skills', 'rules', 'agents', 'global_workflows']) {
    if (isDir(join(gemini, sub))) found.push(`${disp}/${sub}/`);
  }
  if (appDir) {
    for (const sub of ['rules', 'skills', 'agents', 'global_workflows']) {
      if (isDir(join(gemini, appDir, sub))) found.push(`${disp}/${appDir}/${sub}/`);
    }
  }
  if (workspace) {
    for (const root of ['.agents', '_agents']) {
      for (const sub of ['rules', 'skills', 'agents', 'workflows']) {
        if (isDir(join(workspace, root, sub))) found.push(`${root}/${sub}/`);
      }
      if (isRegularFile(join(workspace, root, 'hooks.json'))) found.push(`${root}/hooks.json`);
    }
  }
  return found.map((p) => [p, 0]);
}

export function collectStats(steps, gen, limit) {
  const st = {
    user: 0, agent: 0, tool: 0, checkpoint: 0, system_messages: 0,
    system_prompt: 0, system_tools: 0, system_overhead: 0, rules: 0,
    skills: 0, subagents: 0, legacy_workflows: 0, workflows: 0,
    plugins: 0, mcp_tools: 0,
    has_breakdown: false,
    active_checkpoint: -1,
  };
  const checkpoints = [];
  const knowledge = [];
  const artifacts = [];
  const skillFiles = [];
  const seenK = new Set();
  const seenA = new Set();
  const seenS = new Set();

  const chat = gen !== null ? gen.msg(1) : null;
  const chatStart = chat !== null ? chat.msg(9) : null;
  const [newerPos, newerStep] = checkpointNewerThanGeneration(steps, chatStart);
  const hasNewer = newerStep !== null;
  st.compacted = hasNewer;

  for (let pos = 0; pos < steps.length; pos += 1) {
    const step = steps[pos];
    const cat = stepCategory(step.type);
    const tok = stepTokens(step);
    const counted = hasNewer && newerPos > pos ? 0 : tok;
    if (cat === CAT_USER) st.user += counted;
    else if (cat === CAT_AGENT) st.agent += counted;
    else if (cat === CAT_TOOL) st.tool += counted;
    else if (cat === CAT_CHECKPOINT) {
      st.checkpoint += tok;
      const ck = step.payload(STEP_CHECKPOINT);
      if (ck !== null) {
        checkpoints.push({
          index: ck.int(1),
          start: ck.int(11),
          end: ck.int(12),
          intent: ck.str(4),
        });
      }
    } else {
      st.system_messages += counted;
    }

    const ca = step.payload(STEP_CODE_ACTION);
    const result = ca !== null ? ca.msg(2) : null;
    const edit = result !== null ? result.msg(1) : null;
    if (edit !== null) {
      const uri = edit.str(8);
      const short = shortenPath(uri);
      if (ca.int(21) && !seenA.has(uri)) {
        seenA.add(uri);
        artifacts.push([short, tok]);
      }
      if (ca.int(24) && !seenK.has(uri)) {
        seenK.add(uri);
        knowledge.push([short, tok]);
      }
    }

    const vf = step.payload(STEP_VIEW_FILE);
    if (vf !== null && vf.int(17)) {
      const uri = vf.str(1);
      if (!seenS.has(uri)) {
        seenS.add(uri);
        skillFiles.push([shortenPath(uri), tok]);
      }
    }
  }

  const cwm = chatStart !== null ? chatStart.msg(10) : null;
  const breakdown = cwm !== null ? cwm.msg(3) : null;
  if (breakdown !== null) {
    st.has_breakdown = true;
    let seenPrompt = false;
    let seenTools = false;
    let chatTok = 0;
    let chatItems = [];
    for (const g of breakdown.msgs(1)) {
      const gtype = g.int(2);
      const gtok = g.int(4, true);
      if (gtype === TOKEN_SYSTEM_PROMPT) {
        let extracted = 0;
        for (const child of g.msgs(5)) {
          const cname = child.str(1);
          const ctok = child.int(3, true);
          if (cname === 'flows') st.workflows += ctok;
          else if (cname === 'skills') st.skills += ctok;
          else if (cname === 'subagents') st.subagents += ctok;
          else continue;
          extracted += ctok;
        }
        st.system_prompt = gtok - extracted;
        seenPrompt = true;
      } else if (gtype === TOKEN_TOOLS) {
        st.system_tools = gtok;
        seenTools = true;
      } else if (gtype === TOKEN_RULES) st.rules += gtok;
      else if (gtype === TOKEN_MCP_TOOLS) st.mcp_tools += gtok;
      else if (gtype === TOKEN_SKILLS) st.skills += gtok;
      else if (gtype === TOKEN_SUBAGENTS) st.subagents += gtok;
      else if (gtype === TOKEN_CHAT_MESSAGES) {
        chatTok = gtok;
        chatItems = g.msgs(5);
      } else if (gtype === TOKEN_WORKFLOWS) st.legacy_workflows += gtok;
      else if (gtype === TOKEN_PLUGINS) st.plugins += gtok;
      else if (gtype === TOKEN_FLOWS) st.workflows += gtok;
    }

    if (!seenPrompt && !seenTools && chatTok) {
      const usage = chat.msg(4);
      const apiInput = usage !== null ? usage.int(2) + usage.int(5) : 0;
      if (chatTok < apiInput) st.system_overhead = apiInput - chatTok;
    }

    if (chatTok && !hasNewer) {
      const [ok, cats] = chatTokensByCategory(chatItems);
      if (ok) {
        [st.user, st.agent, st.tool, st.system_messages] = cats;
      } else {
        const est = st.user + st.agent + st.tool;
        if (est === 0) {
          st.agent = chatTok;
        } else {
          const f = chatTok / est;
          st.user = Math.trunc(st.user * f);
          st.agent = Math.trunc(st.agent * f);
          st.tool = Math.trunc(st.tool * f);
        }
      }
    }
  }

  if (chatStart !== null) st.active_checkpoint = chatStart.int(2, true);
  if (hasNewer) {
    st.agent += checkpointSummaryTokens(newerStep);
    st.active_checkpoint = newerStep.payload(STEP_CHECKPOINT).int(1);
  }

  st.total = st.user + st.agent + st.tool + st.system_messages + st.system_prompt
    + st.system_tools + st.system_overhead + st.rules + st.skills + st.subagents
    + st.legacy_workflows + st.workflows + st.plugins + st.mcp_tools;
  st.limit = limit;
  st.checkpoints = checkpoints;
  st.knowledge_files = knowledge;
  st.artifact_files = artifacts;
  st.skill_files = skillFiles;
  return st;
}

// --- rendering ---------------------------------------------------------------

export const CATEGORIES = [
  ['◉', 'User messages', 'user', true],
  ['◉', 'Agent responses', 'agent', true],
  ['◉', 'Tool calls', 'tool', true],
  ['⛁', 'System prompt', 'system_prompt', false],
  ['⛁', 'System tools', 'system_tools', false],
  ['⛁', 'System overhead', 'system_overhead', false],
  ['⛁', 'Rules', 'rules', false],
  ['⛁', 'Skills', 'skills', false],
  ['⛁', 'Subagents', 'subagents', false],
  ['⛁', 'Legacy workflows', 'legacy_workflows', false],
  ['⛁', 'Workflows', 'workflows', false],
  ['⛁', 'Plugins', 'plugins', false],
  ['⛁', 'MCP tools', 'mcp_tools', false],
  ['◉', 'System messages', 'system_messages', false],
];

const GRID_COLORS = ['\x1b[90m', '\x1b[36m', '\x1b[35m', '\x1b[33m', '\x1b[34m', '\x1b[2m'];

export function pct(n, limit) {
  return limit ? (n / limit) * 100 : 0;
}

export function statsHeading(st) {
  if (st.compacted) return 'Estimated after compaction · updates next turn';
  if (st.has_breakdown) return 'Token usage by category';
  return 'Estimated usage (awaiting generation)';
}

export function renderStats(st, model) {
  const used = st.total;
  const limit = st.limit;
  const out = [];
  if (limit) {
    out.push(`${model} · ${fmtTok(used)}/${fmtCtxLimit(limit)} tokens\n (${roundN(Math.min(100, pct(used, limit)), 1).toFixed(1)}%)\n`);
  } else {
    out.push(`${model} · ${fmtTok(used)}/Unknown tokens\n`);
  }
  out.push(`${statsHeading(st)}\n`);
  for (const [icon, cname, key, always] of CATEGORIES) {
    const tok = st[key];
    if (always || tok) {
      out.push(`${icon} ${cname}: ${fmtTok(tok)} tokens (${roundN(pct(tok, limit), 1).toFixed(1)}%)\n`);
    }
  }
  const free = used < limit ? limit - used : 0;
  out.push(`□ Free space: ${fmtTok(free)} (${roundN(pct(free, limit), 1).toFixed(1)}%)\n`);
  if (st.checkpoint) {
    out.push(`⊠ Checkpoint buffer: ${fmtTok(st.checkpoint)} tokens (not counted in usage)\n`);
  }
  return out.join('');
}

export function gridSegments(st) {
  return [
    st.system_prompt + st.system_tools + st.system_overhead,
    st.user,
    st.agent,
    st.tool,
    st.rules + st.skills + st.subagents + st.legacy_workflows + st.workflows + st.plugins + st.mcp_tools,
  ];
}

export function renderGrid(st, width, rows, color) {
  const cols = Math.max(10, Math.trunc(width / 2));
  const totalCells = Math.max(1, rows) * cols;
  const limit = st.limit;
  let counts = gridSegments(st).map((tok) => (!tok || !limit ? 0 : Math.max(1, Math.trunc((tok / limit) * totalCells))));
  const used = counts.reduce((a, b) => a + b, 0);
  if (used > totalCells) {
    const f = totalCells / used;
    counts = counts.map((c) => Math.trunc(c * f));
  }
  counts.push(totalCells - counts.reduce((a, b) => a + b, 0));

  const cells = [];
  counts.forEach((n, i) => {
    const glyph = i === 5 ? '□' : '◉';
    const token = color ? `${GRID_COLORS[i]}${glyph}\x1b[0m` : glyph;
    for (let k = 0; k < n; k += 1) cells.push(token);
  });
  const lines = [];
  const rowCount = Math.trunc(cells.length / cols);
  for (let r = 0; r < rowCount; r += 1) {
    lines.push(cells.slice(r * cols, (r + 1) * cols).join(' '));
  }
  return lines;
}

export function checkpointView(st) {
  const cks = st.checkpoints;
  if (!cks || !cks.length) return null;
  let active = null;
  let historical = 0;
  for (const ck of cks) {
    if (st.active_checkpoint >= 0 && ck.index === st.active_checkpoint) active = ck;
    else historical += 1;
  }
  if (active === null) {
    active = cks[cks.length - 1];
    historical = cks.length - 1;
  }
  let text = active.intent || '';
  if (UTF8_ENC.encode(text).length > 70) {
    let acc = '';
    let blen = 0;
    for (const ch of text) {
      const cl = UTF8_ENC.encode(ch).length;
      if (blen + cl > 67) break;
      acc += ch;
      blen += cl;
    }
    text = `${acc}...`;
  }
  if (!text) text = `steps ${active.start}–${active.end}`;
  return { count: cks.length, active_number: active.index + 1, active_text: text, historical };
}

export function renderCheckpoints(st) {
  const view = checkpointView(st);
  if (view === null) return '';
  const out = [
    `Checkpoints (${view.count}) · /rewind\n`,
    `└ Checkpoint ${view.active_number} (active, in context): ${view.active_text}\n`,
  ];
  if (view.historical) {
    out.push(`  ${view.historical} historical checkpoint(s) (summarized, not in context)\n`);
  }
  return out.join('');
}

export function renderFileSection(title, subtitle, items) {
  if (!items || !items.length) return '';
  const out = [`\n${title} · ${subtitle}\n`];
  for (const [p, tok] of items) {
    out.push(tok > 0 ? ` └ ${p}: ${fmtTok(tok)} tokens\n` : ` └ ${p}\n`);
  }
  return out.join('');
}

export function render(st, model, systemFiles, termWidth, color) {
  const stats = renderStats(st, model);
  const gridWidth = Math.max(20, Math.trunc((2 * termWidth) / 5));
  let body;
  if (termWidth >= 70 && termWidth - gridWidth - 6 >= 40) {
    const statCount = stats.split('\n').length - 1;
    const grid = renderGrid(st, gridWidth, Math.max(3, statCount), color);
    const statLines = stats.replace(/\n+$/, '').split('\n');
    const pad = Math.max(10, Math.trunc(gridWidth / 2)) * 2 - 1;
    const lines = [];
    const total = Math.max(grid.length, statLines.length);
    for (let i = 0; i < total; i += 1) {
      const g = i < grid.length ? grid[i] : ' '.repeat(pad);
      const s = i < statLines.length ? statLines[i] : '';
      lines.push(`${g}   ${s}`.replace(/\s+$/, ''));
    }
    body = `${lines.join('\n')}\n`;
  } else {
    const grid = renderGrid(st, termWidth >= 20 ? termWidth : 40, 3, color);
    body = `${stats}\n${grid.join('\n')}\n`;
  }

  const parts = ['└ Context Usage\n', '\n', body];
  const ck = renderCheckpoints(st);
  if (ck) parts.push('\n', ck);
  parts.push(renderFileSection('Knowledge files', '/rules', st.knowledge_files));
  parts.push(renderFileSection('Artifact files', '/artifact', st.artifact_files));
  parts.push(renderFileSection('Skill files', '/skill', st.skill_files));
  parts.push(renderFileSection('System files', 'auto-loaded', systemFiles));
  parts.push('\nRelated: /artifact · /skill · /rewind');
  return parts.join('');
}

// --- DB loading, speed, & session -------------------------------------------

function genRows(conn, limit) {
  try {
    return conn.prepare('SELECT data FROM gen_metadata ORDER BY idx DESC LIMIT ?').all(limit);
  } catch (err) {
    if (String(err?.message || '').includes('no such table')) return [];
    throw err;
  }
}

export async function load(dbPath) {
  const conn = await openReadOnlyDb(dbPath);
  let rows;
  let gRows;
  try {
    rows = conn.prepare('SELECT idx, step_type, status, metadata, step_payload FROM steps ORDER BY idx').all();
    gRows = genRows(conn, 1);
  } finally {
    conn.close();
  }
  const steps = rows.map((r, pos) => new Step(pos, r.step_payload, r.step_type, r.status, r.metadata));
  const gen = gRows.length && gRows[0].data ? new Msg(gRows[0].data) : null;
  return [steps, gen];
}

export async function loadGenerations(dbPath, limit = 50) {
  const conn = await openReadOnlyDb(dbPath);
  let rows;
  try {
    rows = genRows(conn, limit);
  } finally {
    conn.close();
  }
  const out = [];
  for (const r of rows) {
    if (r.data) out.push(new Msg(r.data));
  }
  return out;
}

export function pbDurationSec(msg) {
  if (!msg || (!msg.has(1) && !msg.has(2))) return null;
  const sec = msg.has(1) ? msg.int(1) : 0;
  const nanos = msg.has(2) ? msg.int(2) : 0;
  if (sec < 0 || nanos < 0 || sec > 86400 || nanos >= 1_000_000_000) return null;
  return sec + nanos / 1_000_000_000;
}

export const MIN_STREAM_TOKENS = 20;
export const MIN_STREAM_SEC = 0.5;
export const STREAM_OUTLIER_MULT = 3.0;

export function parseGenerationSpeed(gen) {
  const chat = gen !== null ? gen.msg(1) : null;
  if (chat === null) return null;
  const usage = chat.msg(4);
  const inputTok = usage !== null ? usage.int(2) : 0;
  const outputTok = usage !== null ? usage.int(3) : 0;
  const cacheReadTok = usage !== null ? usage.int(5) : 0;
  const thinkingTok = usage !== null ? usage.int(9) : 0;
  let responseTok = usage !== null ? usage.int(10) : 0;
  if (responseTok === 0 && outputTok > 0) responseTok = Math.max(0, outputTok - thinkingTok);

  const ttft = pbDurationSec(chat.msg(11));
  const streaming = pbDurationSec(chat.msg(12));
  if (ttft === null && streaming === null) return null;

  const total = ttft !== null && streaming !== null ? ttft + streaming : (ttft !== null ? ttft : streaming);
  const streamingTps = outputTok >= MIN_STREAM_TOKENS && streaming !== null && streaming >= MIN_STREAM_SEC
    ? roundN(outputTok / streaming, 1)
    : null;
  const e2eTps = outputTok > 0 && total !== null && total > 0 ? roundN(outputTok / total, 1) : null;
  const totalInput = inputTok + cacheReadTok;
  const cacheHitPct = totalInput > 0 ? roundN((cacheReadTok / totalInput) * 100, 1) : null;

  return {
    output_tokens: outputTok,
    thinking_tokens: thinkingTok,
    response_tokens: responseTok,
    ttft_sec: ttft !== null ? roundN(ttft, 2) : null,
    streaming_sec: streaming !== null ? roundN(streaming, 2) : null,
    total_sec: total !== null ? roundN(total, 2) : null,
    streaming_tps: streamingTps,
    e2e_tps: e2eTps,
    cache_hit_pct: cacheHitPct,
    _ttft_sec: ttft,
    _streaming_sec: streaming,
    _total_sec: total,
  };
}

export const SPEED_RECENT = 8;
const SPEED_RECENT_KEYS = ['streaming_tps', 'e2e_tps', 'ttft_sec', 'streaming_sec', 'total_sec', 'output_tokens'];

function medianOf(nums) {
  const arr = [...nums].sort((a, b) => a - b);
  const mid = arr.length >> 1;
  return arr.length % 2 === 1 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

function speedAggregate(entries) {
  const validIdx = [];
  for (let i = 0; i < entries.length; i += 1) {
    if (entries[i].streaming_tps !== null) validIdx.push(i);
  }
  const outliers = new Set();
  if (validIdx.length >= 3) {
    const rawMed = medianOf(validIdx.map((i) => entries[i].streaming_tps));
    for (const i of validIdx) {
      if (entries[i].streaming_tps > STREAM_OUTLIER_MULT * rawMed) outliers.add(i);
    }
    if (outliers.size === validIdx.length) outliers.clear();
  }
  const cleanIdx = validIdx.filter((i) => !outliers.has(i));

  let avgStreamingTps = null;
  let medianStreamingTps = null;
  if (cleanIdx.length) {
    let tokSum = 0;
    let secSum = 0;
    for (const i of cleanIdx) {
      tokSum += entries[i].output_tokens;
      secSum += entries[i]._streaming_sec;
    }
    avgStreamingTps = roundN(tokSum / secSum, 1);
    medianStreamingTps = roundN(medianOf(cleanIdx.map((i) => entries[i].streaming_tps)), 1);
  }

  const e2eEntries = entries.filter((e) => e.output_tokens > 0 && e._total_sec !== null && e._total_sec > 0);
  let avgE2eTps = null;
  if (e2eEntries.length) {
    let tokSum = 0;
    let secSum = 0;
    for (const e of e2eEntries) {
      tokSum += e.output_tokens;
      secSum += e._total_sec;
    }
    avgE2eTps = roundN(tokSum / secSum, 1);
  }

  const ttftVals = entries.map((e) => e._ttft_sec).filter((v) => v !== null);
  const avgTtftSec = ttftVals.length
    ? roundN(ttftVals.reduce((a, b) => a + b, 0) / ttftVals.length, 2)
    : null;

  const latest = {};
  for (const [k, v] of Object.entries(entries[0])) {
    if (!k.startsWith('_')) latest[k] = v;
  }
  if (outliers.has(0)) latest.streaming_tps = null;
  latest.buffered = latest.streaming_tps === null;

  const recent = [];
  for (let i = Math.min(entries.length, SPEED_RECENT) - 1; i >= 0; i -= 1) {
    const e = entries[i];
    const row = {};
    for (const k of SPEED_RECENT_KEYS) row[k] = e[k];
    if (outliers.has(i)) row.streaming_tps = null;
    row.buffered = row.streaming_tps === null;
    recent.push(row);
  }

  return {
    latest,
    calls: entries.length,
    avg_streaming_tps: avgStreamingTps,
    median_streaming_tps: medianStreamingTps,
    avg_e2e_tps: avgE2eTps,
    avg_ttft_sec: avgTtftSec,
    output_tokens: entries.reduce((a, e) => a + e.output_tokens, 0),
    recent,
  };
}

export function genModel(gen) {
  const chat = gen !== null ? gen.msg(1) : null;
  const display = chat !== null ? chat.str(21) : '';
  let model = modelId(gen) || (chat !== null ? chat.str(19) : '');
  if (!model) model = display ? DISPLAY_PREFIX + display : 'unknown';
  return [model, display];
}

export function collectSpeed(gens) {
  const names = new Map();
  const entries = [];
  for (const g of gens) {
    const e = parseGenerationSpeed(g);
    if (e === null) continue;
    const [model, display] = genModel(g);
    if (display && !model.startsWith(DISPLAY_PREFIX) && !names.has(model)) {
      names.set(model, display);
    }
    e._model = model;
    e._display = display;
    entries.push(e);
  }
  if (!entries.length) return null;

  const byDisplay = new Map();
  for (const mid of Array.from(names.keys()).sort(cmpCode)) {
    const disp = names.get(mid);
    if (!byDisplay.has(disp)) byDisplay.set(disp, mid);
  }

  const groups = new Map();
  for (const e of entries) {
    let model = e._model;
    if (model.startsWith(DISPLAY_PREFIX)) {
      model = byDisplay.has(e._display) ? byDisplay.get(e._display) : e._display;
    }
    let arr = groups.get(model);
    if (!arr) {
      arr = [];
      groups.set(model, arr);
    }
    arr.push(e);
  }

  const agg = speedAggregate(entries);
  const out = {
    latest: agg.latest,
    calls: agg.calls,
    avg_streaming_tps: agg.avg_streaming_tps,
    median_streaming_tps: agg.median_streaming_tps,
    avg_e2e_tps: agg.avg_e2e_tps,
    avg_ttft_sec: agg.avg_ttft_sec,
    total_output_tokens: agg.output_tokens,
    recent: agg.recent,
    by_model: [],
  };

  for (const [model, es] of groups.entries()) {
    const a = speedAggregate(es);
    const disp = names.get(model) || es.find((e) => e._display)?._display || null;
    out.by_model.push({ model, display_name: disp, ...a });
  }
  return out;
}

function catalogDisplayFor(modelId, catalog) {
  if (!catalog || typeof catalog !== 'object') return null;
  const raw = String(modelId || '').trim();
  if (!raw) return null;
  const direct = Object.prototype.hasOwnProperty.call(catalog, raw)
    ? catalog[raw]
    : (Object.prototype.hasOwnProperty.call(catalog, raw.toLowerCase()) ? catalog[raw.toLowerCase()] : null);
  if (direct && typeof direct.displayName === 'string' && direct.displayName.trim()) {
    return direct.displayName.trim();
  }
  const low = raw.toLowerCase();
  for (const [k, v] of Object.entries(catalog)) {
    if (k.toLowerCase() === low && v && typeof v.displayName === 'string' && v.displayName.trim()) {
      return v.displayName.trim();
    }
  }
  return null;
}

export async function collectSession(dbPath, { pricingFile = null, modelCatalogPath = null } = {}) {
  let parsed;
  try {
    parsed = await parseHistoryDb(dbPath);
  } catch {
    return null;
  }
  const calls = parsed.calls || [];
  const names = parsed.names || {};
  if (!calls.length) return null;

  const [customPrices, pricingSource] = loadPricingFile(pricingFile);
  const catalog = loadModelCatalog(modelCatalogPath);
  const poolsList = Array.isArray(POOLS) && POOLS.length ? POOLS : ['gemini', 'claude_gpt', 'other'];
  const now = new Date();
  const todayKey = localDateKey(now);
  const d7Key = localDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6));

  const byDisplay = new Map();
  for (const mid of Object.keys(names).sort(cmpCode)) {
    const disp = names[mid];
    if (!byDisplay.has(disp)) byDisplay.set(disp, mid);
  }

  let inputSum = 0;
  let outputSum = 0;
  let cacheSum = 0;
  let thinkingSum = 0;
  let d7Tokens = 0;
  const d7ByPool = {};
  for (const pk of poolsList) d7ByPool[pk] = 0;
  let costSum = null;
  let partial = false;
  let estimated = false;
  let minTs = Infinity;
  let maxTs = -Infinity;
  const byModel = new Map();

  for (const [ts, rawModel, inp, out, cache, think] of calls) {
    let model = rawModel;
    let display = Object.prototype.hasOwnProperty.call(names, model) ? names[model] : null;
    if (model.startsWith(DISPLAY_PREFIX)) {
      display = model.slice(DISPLAY_PREFIX.length);
      model = byDisplay.has(display) ? byDisplay.get(display) : display;
    }
    const [cost, isEst] = callCostInfo(model, inp, out, cache, customPrices);
    inputSum += inp;
    outputSum += out;
    cacheSum += cache;
    thinkingSum += think;
    if (ts < minTs) minTs = ts;
    if (ts > maxTs) maxTs = ts;

    let dk = null;
    if (Number.isFinite(ts) && ts > 0) {
      const dt = new Date(ts * 1000);
      const yr = dt.getFullYear();
      if (!Number.isNaN(dt.getTime()) && yr >= 1970 && yr <= 2100) {
        dk = localDateKey(dt);
      }
    }
    if (dk !== null && dk >= d7Key && dk <= todayKey) {
      const billTok = inp + out;
      d7Tokens += billTok;
      const pk = modelPool(model, catalog);
      d7ByPool[pk] = (d7ByPool[pk] ?? 0) + billTok;
    }

    if (cost === null) {
      partial = true;
    } else {
      costSum = (costSum ?? 0) + cost;
      if (isEst) estimated = true;
    }

    let bm = byModel.get(model);
    if (!bm) {
      bm = {
        model,
        display_name: (Object.prototype.hasOwnProperty.call(names, model) ? names[model] : null) || display || catalogDisplayFor(model, catalog) || null,
        input: 0,
        output: 0,
        cache_read: 0,
        calls: 0,
        est_cost_usd: null,
        cost_estimated: false,
      };
      byModel.set(model, bm);
    }
    bm.input += inp;
    bm.output += out;
    bm.cache_read += cache;
    bm.calls += 1;
    if (cost !== null) {
      bm.est_cost_usd = (bm.est_cost_usd ?? 0) + cost;
      if (isEst) bm.cost_estimated = true;
    }
  }

  const models = Array.from(byModel.values()).sort((a, b) => {
    const ta = a.input + a.output + a.cache_read;
    const tb = b.input + b.output + b.cache_read;
    if (tb !== ta) return tb - ta;
    return cmpCode(a.model, b.model);
  });
  for (const bm of models) {
    if (bm.est_cost_usd !== null) bm.est_cost_usd = roundN(bm.est_cost_usd, 4);
  }

  let primaryModel = null;
  for (const bm of models) {
    if (!primaryModel) {
      primaryModel = bm;
      continue;
    }
    const bt = primaryModel.input + primaryModel.output + primaryModel.cache_read;
    const mt = bm.input + bm.output + bm.cache_read;
    if (mt > bt || (mt === bt && cmpCode(bm.model, primaryModel.model) > 0)) {
      primaryModel = bm;
    }
  }
  const primaryPool = primaryModel ? modelPool(primaryModel.model, catalog) : 'other';
  let pool = primaryPool;
  let bestPoolVal = 0;
  let bestPoolIsPrimary = -1;
  let bestPoolRank = -Infinity;
  poolsList.forEach((pk, idx) => {
    const val = d7ByPool[pk] ?? 0;
    if (val <= 0) return;
    const isPrim = pk === primaryPool ? 1 : 0;
    const rank = -idx;
    if (
      val > bestPoolVal ||
      (val === bestPoolVal && (isPrim > bestPoolIsPrimary || (isPrim === bestPoolIsPrimary && rank > bestPoolRank)))
    ) {
      bestPoolVal = val;
      bestPoolIsPrimary = isPrim;
      bestPoolRank = rank;
      pool = pk;
    }
  });

  const prompt = inputSum + cacheSum;
  return {
    input: inputSum,
    output: outputSum,
    cache_read: cacheSum,
    thinking: thinkingSum,
    calls: calls.length,
    total_tokens: inputSum + outputSum,
    cache_hit_pct: prompt > 0 ? roundN((cacheSum / prompt) * 100, 1) : null,
    est_cost_usd: costSum !== null ? roundN(costSum, 4) : null,
    cost_partial: partial,
    cost_estimated: estimated,
    pricing_source: pricingSource,
    pool,
    d7_tokens: d7Tokens,
    d7_by_pool: d7ByPool,
    first_at: formatLocalIso(minTs),
    last_at: formatLocalIso(maxTs),
    by_model: models,
  };
}

// --- model catalog & limits --------------------------------------------------

export const NATIVE_CONTEXT_WINDOWS = [
  ['claude-opus-4-6', 250_000],
  ['claude-sonnet-4-6', 250_000],
  ['claude-', 1_000_000],
  ['gpt-oss-', 131_072],
  ['gemini-', 1_048_576],
];

export const EFFORT_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export const WORD_LABELS = { gpt: 'GPT', oss: 'OSS' };

export function modelId(gen) {
  const planner = gen !== null ? gen.msg(3) : null;
  return planner !== null ? planner.str(28) : '';
}

export function modelLabel(slug) {
  const parts = String(slug || '').split('-');
  let effort = '';
  if (parts.length > 1 && EFFORT_LEVELS.includes(parts[parts.length - 1])) {
    const last = parts.pop();
    effort = last.charAt(0).toUpperCase() + last.slice(1);
  }
  const words = [];
  for (const p of parts) {
    if (/^\d+$/.test(p) && words.length && /\d$/.test(words[words.length - 1])) {
      words[words.length - 1] += `.${p}`;
    } else if (Object.prototype.hasOwnProperty.call(WORD_LABELS, p)) {
      words.push(WORD_LABELS[p]);
    } else if (p.length > 0 && p[0] >= '0' && p[0] <= '9') {
      words.push(p.toUpperCase());
    } else {
      words.push(p.charAt(0).toUpperCase() + p.slice(1));
    }
  }
  const label = words.join(' ').replace('GPT OSS', 'GPT-OSS');
  return effort ? `${label} (${effort})` : label;
}

export function modelName(gen) {
  const chat = gen !== null ? gen.msg(1) : null;
  if (chat !== null && chat.str(21)) return chat.str(21);
  const mid = modelId(gen);
  if (mid) return modelLabel(mid);
  if (chat !== null && chat.str(19)) return chat.str(19);
  return 'Unknown Model';
}

export function requestBudget(gen) {
  const chat = gen !== null ? gen.msg(1) : null;
  const start = chat !== null ? chat.msg(9) : null;
  const cwm = start !== null ? start.msg(10) : null;
  return cwm !== null ? cwm.int(4, true) : 0;
}

export function contextLimit(gen) {
  const slug = modelId(gen);
  for (const [prefix, tokens] of NATIVE_CONTEXT_WINDOWS) {
    if (slug.startsWith(prefix)) return tokens;
  }
  return requestBudget(gen);
}

// --- high-level report builder (in-process API for main.mjs & CLI) -----------

export async function buildReport({
  dbPath,
  conversationId = null,
  workspace = null,
  limitOverride = 0,
  appDir = 'antigravity',
  width = 100,
  modelCatalogPath = null,
  pricingFile = null,
}) {
  const p = String(dbPath);
  const convId = conversationId || basename(p, '.db');
  const [steps, gen] = await load(p);

  let catalogEntry = {};
  if (modelCatalogPath && existsSync(modelCatalogPath)) {
    try {
      const cat = JSON.parse(readFileSync(modelCatalogPath, 'utf8'));
      const mid = modelId(gen);
      if (cat && mid && cat[mid]) catalogEntry = cat[mid];
    } catch { /* ignore */ }
  }

  const limit = limitOverride > 0
    ? limitOverride
    : (Number(catalogEntry.maxTokens) || 0) || contextLimit(gen);
  const st = collectStats(steps, gen, limit);
  const model = catalogEntry.displayName || modelName(gen);
  const systemFiles = detectSystemFiles(homedir(), workspace || null, appDir);
  const speed = collectSpeed(await loadGenerations(p));
  const session = await collectSession(p, { pricingFile, modelCatalogPath });

  const categories = [];
  for (const [icon, cname, key, always] of CATEGORIES) {
    if (always || st[key]) {
      categories.push({
        icon,
        name: cname,
        key,
        tokens: st[key],
        pct: roundN(pct(st[key], limit), 1),
      });
    }
  }

  return {
    conversation_id: convId,
    model,
    heading: statsHeading(st),
    grid_segments: gridSegments(st),
    checkpoint_view: checkpointView(st),
    text: render(st, model, systemFiles, width, false),
    model_id: modelId(gen),
    request_budget_tokens: requestBudget(gen),
    used_tokens: st.total,
    limit_tokens: limit,
    used_pct: roundN(Math.min(100, pct(st.total, limit)), 1),
    free_tokens: st.total < limit ? limit - st.total : 0,
    has_breakdown: st.has_breakdown,
    compacted: st.compacted,
    checkpoint_buffer: st.checkpoint,
    categories,
    active_checkpoint: st.active_checkpoint,
    checkpoints: st.checkpoints,
    knowledge_files: st.knowledge_files.map(([fp, tokens]) => ({ path: fp, tokens })),
    artifact_files: st.artifact_files.map(([fp, tokens]) => ({ path: fp, tokens })),
    skill_files: st.skill_files.map(([fp, tokens]) => ({ path: fp, tokens })),
    system_files: systemFiles.map(([fp]) => ({ path: fp })),
    speed,
    session,
  };
}

// --- CLI ---------------------------------------------------------------------

function expandHome(p) {
  const s = String(p || '');
  if (s === '~') return homedir();
  if (s.startsWith('~/') || s.startsWith('~\\')) return join(homedir(), s.slice(2));
  return s;
}

async function cliMain(argv) {
  let dbArg = null;
  let convIdArg = null;
  let workspace = null;
  let limitOverride = 0;
  let appDir = 'antigravity';
  let width = 100;
  let color = false;
  let jsonOut = false;
  let modelCatalog = null;
  let pricingFile = null;

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--db' && i + 1 < argv.length) dbArg = argv[++i];
    else if (a === '--conversation-id' && i + 1 < argv.length) convIdArg = argv[++i];
    else if (a === '--workspace' && i + 1 < argv.length) workspace = argv[++i];
    else if (a === '--limit' && i + 1 < argv.length) limitOverride = parseInt(argv[++i], 10) || 0;
    else if (a === '--app-dir' && i + 1 < argv.length) appDir = argv[++i];
    else if (a === '--width' && i + 1 < argv.length) width = parseInt(argv[++i], 10) || 100;
    else if (a === '--color') color = true;
    else if (a === '--json') jsonOut = true;
    else if (a === '--model-catalog' && i + 1 < argv.length) modelCatalog = argv[++i];
    else if (a === '--pricing-file' && i + 1 < argv.length) pricingFile = argv[++i];
  }

  let dbPath;
  let convId;
  if (dbArg) {
    dbPath = resolve(expandHome(dbArg));
    convId = basename(dbPath, '.db');
  } else {
    const convDir = join(homedir(), '.gemini', 'antigravity', 'conversations');
    convId = convIdArg;
    if (!convId) {
      let dbs = [];
      try {
        dbs = readdirSync(convDir)
          .filter((f) => f.endsWith('.db'))
          .map((f) => {
            const fp = join(convDir, f);
            return { fp, mtime: statSync(fp).mtimeMs };
          })
          .sort((a, b) => b.mtime - a.mtime);
      } catch { dbs = []; }
      if (!dbs.length) {
        process.stderr.write('No conversation databases found.\n');
        return 1;
      }
      convId = basename(dbs[0].fp, '.db');
    }
    dbPath = join(convDir, `${convId}.db`);
  }

  if (!existsSync(dbPath) || !statSync(dbPath).isFile()) {
    process.stderr.write(`Conversation database not found: ${dbPath}\n`);
    return 1;
  }

  if (jsonOut) {
    const data = await buildReport({
      dbPath,
      conversationId: convId,
      workspace,
      limitOverride,
      appDir,
      width,
      modelCatalogPath: modelCatalog,
      pricingFile,
    });
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    return 0;
  }

  const [steps, gen] = await load(dbPath);
  let catalogEntry = {};
  if (modelCatalog && existsSync(modelCatalog)) {
    try {
      const cat = JSON.parse(readFileSync(modelCatalog, 'utf8'));
      const mid = modelId(gen);
      if (cat && mid && cat[mid]) catalogEntry = cat[mid];
    } catch { /* ignore */ }
  }
  const limit = limitOverride > 0
    ? limitOverride
    : (Number(catalogEntry.maxTokens) || 0) || contextLimit(gen);
  const st = collectStats(steps, gen, limit);
  const model = catalogEntry.displayName || modelName(gen);
  const systemFiles = detectSystemFiles(homedir(), workspace, appDir);
  process.stdout.write(`${render(st, model, systemFiles, width, color)}\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cliMain(process.argv.slice(2)).then((code) => process.exit(code));
}
