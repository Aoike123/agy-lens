// Minimal protobuf wire decoder, read-only SQLite loader (node:sqlite), and
// date/number/filesystem helpers shared across Agy Lens backend modules.
// Pure ESM, zero external dependencies.

import { mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EMPTY_BYTES = new Uint8Array(0);
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: false });
const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Decode one unsigned protobuf varint starting at `pos`.
 * Uses BigInt so 64-bit values and 10-byte negative int32 two's-complement
 * numbers never suffer 32-bit JS bitwise truncation.
 */
export function readVarint(buf, pos) {
  let val = 0n;
  let shift = 0n;
  const n = buf.length;
  while (pos < n) {
    const b = buf[pos++];
    val |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [val, pos];
    shift += 7n;
    if (shift > 70n) throw new Error('Malformed varint');
  }
  throw new Error('Truncated varint');
}

/**
 * Encode a non-negative integer as a protobuf varint Uint8Array.
 */
export function encodeVarint(n) {
  let v = typeof n === 'bigint' ? n : BigInt(Math.trunc(n));
  if (v < 0n) v = BigInt.asUintN(64, v);
  const out = [];
  while (true) {
    const b = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) out.push(b | 0x80);
    else {
      out.push(b);
      return Uint8Array.from(out);
    }
  }
}

/**
 * Lazily decoded protobuf message: field number -> list of raw values
 * (BigInt for varints, Uint8Array for wire types 1, 2, 5).
 */
export class Msg {
  constructor(buf, want = null) {
    this.fields = new Map();
    const bytes = buf instanceof Uint8Array ? buf : (buf ? Uint8Array.from(buf) : EMPTY_BYTES);
    let pos = 0;
    const n = bytes.length;
    while (pos < n) {
      let fn, wt, val;
      try {
        let tag;
        [tag, pos] = readVarint(bytes, pos);
        fn = Number(tag >> 3n);
        wt = Number(tag & 7n);
        if (wt === 0) {
          [val, pos] = readVarint(bytes, pos);
        } else if (wt === 2) {
          let lnBig;
          [lnBig, pos] = readVarint(bytes, pos);
          const ln = Number(lnBig);
          if (!Number.isSafeInteger(ln) || ln < 0) break;
          const end = Math.min(n, pos + ln);
          val = want === null || want.has(fn) ? bytes.subarray(pos, end) : null;
          pos += ln;
        } else if (wt === 1) {
          val = want === null || want.has(fn) ? bytes.subarray(pos, Math.min(n, pos + 8)) : null;
          pos += 8;
        } else if (wt === 5) {
          val = want === null || want.has(fn) ? bytes.subarray(pos, Math.min(n, pos + 4)) : null;
          pos += 4;
        } else {
          break;
        }
      } catch {
        break;
      }
      if (want === null || want.has(fn)) {
        let arr = this.fields.get(fn);
        if (!arr) {
          arr = [];
          this.fields.set(fn, arr);
        }
        arr.push(val);
      }
    }
  }

  has(fn) {
    return this.fields.has(fn);
  }

  int(fn, signed32 = false) {
    const arr = this.fields.get(fn);
    if (!arr || arr.length === 0) return 0;
    let v = arr[arr.length - 1];
    if (typeof v !== 'bigint') return 0;
    if (signed32 && v >= (1n << 63n)) v -= (1n << 64n);
    return Number(v);
  }

  bytes(fn) {
    const arr = this.fields.get(fn);
    if (!arr || arr.length === 0) return EMPTY_BYTES;
    const v = arr[arr.length - 1];
    return v instanceof Uint8Array ? v : EMPTY_BYTES;
  }

  str(fn) {
    return UTF8_DECODER.decode(this.bytes(fn));
  }

  msg(fn, want = null) {
    return this.has(fn) ? new Msg(this.bytes(fn), want) : null;
  }

  msgs(fn, want = null) {
    const arr = this.fields.get(fn);
    if (!arr || arr.length === 0) return [];
    const out = [];
    for (const v of arr) {
      if (v instanceof Uint8Array) out.push(new Msg(v, want));
    }
    return out;
  }
}

// --- node:sqlite loader ------------------------------------------------------

let sqliteModPromise = null;

async function loadSqlite() {
  if (!sqliteModPromise) {
    sqliteModPromise = import('node:sqlite').catch(() => null);
  }
  return sqliteModPromise;
}

/**
 * Returns true if the current Node runtime provides built-in `node:sqlite`.
 */
export async function hasNodeSqlite() {
  const mod = await loadSqlite();
  return Boolean(mod && typeof mod.DatabaseSync === 'function');
}

/**
 * Open a SQLite database strictly read-only via built-in `node:sqlite`.
 */
export async function openReadOnlyDb(dbPath) {
  const mod = await loadSqlite();
  if (!mod || typeof mod.DatabaseSync !== 'function') {
    throw new Error('node:sqlite is unavailable in this Node runtime');
  }
  return new mod.DatabaseSync(resolve(String(dbPath)), { readOnly: true, timeout: 500 });
}

// --- path, fs, formatting & math helpers ------------------------------------

export const cmpCode = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function expandHome(p) {
  const s = String(p || '');
  if (s === '~') return homedir();
  if (s.startsWith('~/') || s.startsWith('~\\')) return join(homedir(), s.slice(2));
  return s;
}

export function defaultGeminiDir() {
  const raw = (process.env.ANTIGRAVITY_GEMINI_DIR || '').trim();
  return raw ? resolve(expandHome(raw)) : join(homedir(), '.gemini');
}

export function defaultDataDir() {
  const raw = (process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR || '').trim();
  return raw ? resolve(expandHome(raw)) : join(HERE, '..', '.data');
}

export function writeJsonAtomic(filePath, data) {
  const target = expandHome(filePath);
  mkdirSync(dirname(target), { recursive: true });
  const text = JSON.stringify(data);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, target);
  } catch {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    writeFileSync(target, text, 'utf8');
  }
}

export function fileStamp(filePath) {
  try {
    const s = statSync(filePath);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return '-';
  }
}

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * Format an epoch timestamp (seconds) as local ISO-8601 with timezone offset.
 */
export function formatLocalIso(epochSec) {
  if (typeof epochSec !== 'number' || !Number.isFinite(epochSec)) return null;
  const d = new Date(epochSec * 1000);
  if (Number.isNaN(d.getTime())) return null;
  const offMin = -d.getTimezoneOffset();
  const sign = offMin >= 0 ? '+' : '-';
  const abs = Math.abs(offMin);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
    + `T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
    + `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

/**
 * Format a Date as local `YYYY-MM-DD`.
 */
export function localDateKey(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function roundN(v, digits) {
  if (!Number.isFinite(v)) return v;
  const sign = v < 0 ? -1 : 1;
  const p = 10 ** digits;
  const x = Math.abs(v) * p;
  const f = Math.floor(x);
  const diff = x - f;
  let r;
  if (diff > 0.5 + 1e-12) r = f + 1;
  else if (diff < 0.5 - 1e-12) r = f;
  else r = (f % 2 === 0) ? f : f + 1;
  const res = (sign * r) / p;
  return Object.is(res, -0) ? 0 : res;
}
