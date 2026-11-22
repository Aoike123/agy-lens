// Pure Node 24 synthetic SQLite DB builder & protobuf wire encoder for E2E tests.
// Zero imports from sidecars/ (strictly opaque-box).

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const UTF8 = new TextEncoder();

export function pbVarint(n) {
  let v = typeof n === 'bigint' ? n : BigInt.asUintN(64, BigInt(Math.trunc(n)));
  const out = [];
  while (v >= 0x80n) {
    out.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  out.push(Number(v));
  return new Uint8Array(out);
}

export function pbSignedVarint(n) {
  return pbVarint(typeof n === 'bigint' ? BigInt.asUintN(64, n) : BigInt.asUintN(64, BigInt(Math.trunc(n))));
}

export function pbConcat(...parts) {
  const bufs = parts.filter((p) => p && p.length);
  let total = 0;
  for (const b of bufs) total += b.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const b of bufs) {
    out.set(b, off);
    off += b.length;
  }
  return out;
}

export function pbMsg(...parts) {
  return pbConcat(...parts);
}

export function pbField(fieldNum, val) {
  if (val === null || val === undefined) return new Uint8Array(0);
  if (typeof val === 'number' || typeof val === 'bigint') {
    return pbConcat(pbVarint(BigInt(fieldNum) << 3n), pbSignedVarint(val));
  }
  const bytes = typeof val === 'string' ? UTF8.encode(val) : val;
  return pbConcat(pbVarint((BigInt(fieldNum) << 3n) | 2n), pbVarint(bytes.length), bytes);
}

export function pbStr(fieldNum, str) {
  return pbField(fieldNum, String(str));
}

export function pbTs(epochSec) {
  return pbField(1, pbField(1, Math.trunc(epochSec)));
}

export function pbDuration(sec, nanos = 0) {
  return pbMsg(pbField(1, sec), nanos ? pbField(2, nanos) : null);
}

export function pbTiming(ttft = null, stream = null) {
  return pbMsg(
    ttft ? pbField(11, pbDuration(ttft[0], ttft[1] || 0)) : null,
    stream ? pbField(12, pbDuration(stream[0], stream[1] || 0)) : null,
  );
}

export function pbUsage({ inp = 0, out = 0, cache = 0, think = 0, resp = 0 } = {}) {
  return pbMsg(
    inp ? pbField(2, inp) : null,
    out ? pbField(3, out) : null,
    cache ? pbField(5, cache) : null,
    think ? pbField(9, think) : null,
    resp ? pbField(10, resp) : null,
  );
}

export function pbGroup(tokenType, tokens, children = [], name = 'group') {
  return pbMsg(
    pbField(1, name),
    pbField(2, tokenType),
    pbField(4, tokens),
    ...children.map(([n, t]) => pbField(5, pbMsg(pbField(1, n), pbField(3, t)))),
  );
}

export function pbCwm({ groups = [], maxContext = 1_000_000 } = {}) {
  return pbMsg(
    pbField(1, 0),
    pbField(3, pbMsg(...groups.map((g) => pbField(1, g)))),
    pbField(4, maxContext),
  );
}

export function pbChatStart({ checkpointIndex = -1, cwm = null } = {}) {
  return pbMsg(
    pbField(2, checkpointIndex),
    cwm ? pbField(10, cwm) : null,
  );
}

export function pbChatModel({
  usage = new Uint8Array(0),
  chatStart = null,
  responseModel = '',
  displayName = '',
  timing = new Uint8Array(0),
} = {}) {
  return pbMsg(
    usage && usage.length ? pbField(4, usage) : null,
    chatStart ? pbField(9, chatStart) : null,
    responseModel ? pbField(19, responseModel) : null,
    displayName ? pbField(21, displayName) : null,
    timing,
  );
}

export function pbGenMetadata({
  groups = [],
  maxContext = 1_000_000,
  usage = new Uint8Array(0),
  checkpointIndex = -1,
  model = 'claude-opus-4-6',
  displayName = 'Claude Opus 4.6',
  responseModel = '',
  timing = new Uint8Array(0),
  ttft = null,
  stream = null,
} = {}) {
  const cwm = pbCwm({ groups, maxContext });
  const chatStart = pbChatStart({ checkpointIndex, cwm });
  const combinedTiming = timing && timing.length ? timing : pbTiming(ttft, stream);
  const chat = pbChatModel({ usage, chatStart, responseModel, displayName, timing: combinedTiming });
  return pbMsg(
    pbField(1, chat),
    model ? pbField(3, pbField(28, model)) : null,
  );
}

export function pbStep(stepType, {
  metadata = new Uint8Array(0),
  payloadField = null,
  payload = new Uint8Array(0),
  status = 3,
} = {}) {
  return pbMsg(
    pbField(1, stepType),
    pbField(4, status),
    metadata && metadata.length ? pbField(5, metadata) : null,
    payloadField ? pbField(payloadField, payload) : null,
  );
}

export function pbGenericStep({
  metadata = new Uint8Array(0),
  toolName = '',
  toolArgs = null,
  innerTypeUrl = '',
  innerStepBytes = null,
  status = 3,
} = {}) {
  let md = metadata;
  if (toolName) {
    const tc = pbMsg(
      pbField(2, toolName),
      toolArgs !== null ? pbField(3, typeof toolArgs === 'string' ? toolArgs : JSON.stringify(toolArgs)) : null,
    );
    md = pbMsg(md, pbField(4, tc));
  }
  let genericResult = new Uint8Array(0);
  if (innerStepBytes) {
    const anyMsg = pbMsg(
      innerTypeUrl ? pbField(1, innerTypeUrl) : pbField(1, 'type.googleapis.com/gemini_coder.Step'),
      pbField(2, innerStepBytes),
    );
    genericResult = pbField(6, anyMsg);
  }
  return {
    metadata: md,
    payload: pbStep(132, {
      metadata: md,
      payloadField: 140,
      payload: pbField(2, genericResult),
      status,
    }),
  };
}

export function createConvDb(dbPath, { genTable = true, journalMode = null } = {}) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  if (journalMode) {
    db.exec(`PRAGMA journal_mode=${journalMode};`);
  }
  db.exec(
    'CREATE TABLE steps (idx integer, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0, '
    + 'has_subtrajectory numeric NOT NULL DEFAULT false, metadata blob, error_details blob, permissions blob, '
    + 'task_details blob, render_info blob, step_payload blob, step_format integer NOT NULL DEFAULT 0, PRIMARY KEY (idx));',
  );
  if (genTable) {
    db.exec('CREATE TABLE gen_metadata (idx integer, data blob, size integer NOT NULL DEFAULT 0, PRIMARY KEY (idx));');
  }
  let idx = 0;
  let gIdx = 0;
  return {
    db,
    step(stepType, opts = {}) {
      const { metadata = new Uint8Array(0), status = 3 } = opts;
      const pb = pbStep(stepType, opts);
      db.prepare('INSERT INTO steps (idx, step_type, status, metadata, step_payload) VALUES (?, ?, ?, ?, ?)').run(
        idx++,
        stepType,
        status,
        metadata,
        pb,
      );
    },
    genericStep(opts = {}) {
      const { metadata, payload } = pbGenericStep(opts);
      const status = opts.status ?? 3;
      db.prepare('INSERT INTO steps (idx, step_type, status, metadata, step_payload) VALUES (?, ?, ?, ?, ?)').run(
        idx++,
        132,
        status,
        metadata,
        payload,
      );
    },
    generation(opts = {}) {
      const data = pbGenMetadata(opts);
      db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(gIdx++, data);
    },
    exec(sql) {
      db.exec(sql);
    },
    close() {
      db.close();
    },
  };
}

export function createWalConvDb(dbPath, opts = {}) {
  const handle = createConvDb(dbPath, { ...opts, journalMode: 'WAL' });
  handle.exec('PRAGMA wal_autocheckpoint=0;');
  return {
    ...handle,
    walPath: `${dbPath}-wal`,
    shmPath: `${dbPath}-shm`,
  };
}

export function createSummariesDb(dbPath, rows = []) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE IF NOT EXISTS conversation_summaries (conversation_id text, title text, preview text, agent_name text);');
  const stmt = db.prepare('INSERT INTO conversation_summaries (conversation_id, title, preview, agent_name) VALUES (?, ?, ?, ?)');
  for (const r of rows) {
    stmt.run(
      r.conversation_id ?? r.id ?? '',
      r.title ?? '',
      r.preview ?? '',
      r.agent_name ?? '',
    );
  }
  db.close();
}
