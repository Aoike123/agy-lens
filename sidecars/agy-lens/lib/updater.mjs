// Opt-out-safe GitHub Release update checker & verified self-updater for Agy Lens.
// Pure ESM, zero external dependencies, 6h local cache in update-cache.json.

import { createHash, timingSafeEqual } from 'node:crypto';
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import https from 'node:https';
import { dirname, join, posix, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { defaultDataDir, expandHome, writeJsonAtomic } from './pb.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');

export const UPDATE_TTL_MS = 6 * 60 * 60 * 1000;
export const UPDATE_TIMEOUT_MS = 8 * 1000;
export const UPDATE_DOWNLOAD_TIMEOUT_MS = 30 * 1000;
export const UPDATE_MAX_BYTES = 1024 * 1024;
export const UPDATE_ZIP_MAX_BYTES = 10 * 1024 * 1024;
export const GITHUB_LATEST_RELEASE_URL = 'https://api.github.com/repos/Aoike123/agy-lens/releases/latest';
export const GITHUB_MANIFEST_FALLBACK_URL = 'https://raw.githubusercontent.com/Aoike123/agy-lens/main/plugin.json';
export const GITHUB_RELEASES_PAGE = 'https://github.com/Aoike123/agy-lens/releases/latest';
export const GITHUB_DOWNLOAD_BASE = 'https://github.com/Aoike123/agy-lens/releases/download';

const MAX_ZIP_ENTRIES = 500;
const MAX_ZIP_ENTRY_BYTES = 5 * 1024 * 1024;
const MAX_ZIP_TOTAL_BYTES = 20 * 1024 * 1024;
const SENTINEL_FILES = [
  'plugin.json',
  'package.json',
  'sidecars/agy-lens/sidecar.json',
  'sidecars/agy-lens/main.mjs',
  'sidecars/agy-lens/web/index.html',
  'sidecars/agy-lens/web/app.js',
];
const MANAGED_SUBDIRS = ['sidecars/agy-lens/lib', 'sidecars/agy-lens/web'];
const IGNORED_MANAGED_DIRS = new Set(['__pycache__', '.data', 'node_modules']);

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const TRUTHY_ENV_RE = /^(1|true|yes)$/i;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let j = 0; j < 8; j += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function detectInstallMode(rootDir = REPO_ROOT) {
  const resolved = resolve(expandHome(rootDir));
  if (TRUTHY_ENV_RE.test(String(process.env.AGY_LENS_NO_SELF_UPDATE || '').trim())) {
    return { install_mode: 'disabled', can_self_update: false };
  }
  if (existsSync(join(resolved, '.git'))) {
    return { install_mode: 'git', can_self_update: false };
  }
  if (
    existsSync(join(resolved, 'plugin.json'))
    && existsSync(join(resolved, 'sidecars', 'agy-lens', 'main.mjs'))
  ) {
    try {
      accessSync(resolved, fsConstants.W_OK);
    } catch {
      return { install_mode: 'readonly', can_self_update: false };
    }
    return { install_mode: 'installed', can_self_update: true };
  }
  return { install_mode: 'unknown', can_self_update: false };
}

export function isAllowedUpdateUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || '').trim());
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    if (host === 'github.com') {
      return parsed.pathname === '/Aoike123/agy-lens' || parsed.pathname.startsWith('/Aoike123/agy-lens/');
    }
    if (host === 'api.github.com') {
      return parsed.pathname === '/repos/Aoike123/agy-lens' || parsed.pathname.startsWith('/repos/Aoike123/agy-lens/');
    }
    if (host === 'raw.githubusercontent.com') {
      return parsed.pathname.startsWith('/Aoike123/agy-lens/');
    }
    return host.endsWith('.githubusercontent.com');
  } catch {
    return false;
  }
}

export function readCurrentVersion(rootDir = REPO_ROOT) {
  for (const rel of ['plugin.json', 'package.json']) {
    const p = join(rootDir, rel);
    if (!existsSync(p)) continue;
    try {
      const data = JSON.parse(readFileSync(p, 'utf8'));
      const ver = typeof data?.version === 'string' ? data.version.trim().replace(/^v/i, '') : '';
      if (ver) return ver;
    } catch { /* try next manifest */ }
  }
  return '0.0.0';
}

export function parseSemver(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  const m = trimmed.match(SEMVER_RE);
  if (!m) return null;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) return null;
  const pre = m[4] ? m[4].split('.').filter(Boolean) : [];
  const base = `${major}.${minor}.${patch}`;
  return {
    major,
    minor,
    patch,
    pre,
    raw: pre.length ? `${base}-${pre.join('.')}` : base,
  };
}

export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  if (pa.major !== pb.major) return pa.major > pb.major ? 1 : -1;
  if (pa.minor !== pb.minor) return pa.minor > pb.minor ? 1 : -1;
  if (pa.patch !== pb.patch) return pa.patch > pb.patch ? 1 : -1;
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
  if (pa.pre.length === 0) return 1;
  if (pb.pre.length === 0) return -1;
  const len = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < len; i += 1) {
    if (i >= pa.pre.length) return -1;
    if (i >= pb.pre.length) return 1;
    const sa = pa.pre[i];
    const sb = pb.pre[i];
    const na = /^\d+$/.test(sa) ? Number(sa) : null;
    const nb = /^\d+$/.test(sb) ? Number(sb) : null;
    if (na !== null && nb !== null) {
      if (na !== nb) return na > nb ? 1 : -1;
    } else if (na !== null) {
      return -1;
    } else if (nb !== null) {
      return 1;
    } else if (sa !== sb) {
      return sa > sb ? 1 : -1;
    }
  }
  return 0;
}

export function sanitizeReleaseUrl(url) {
  try {
    const parsed = new URL(String(url || '').trim());
    if (
      parsed.protocol === 'https:'
      && parsed.hostname.toLowerCase() === 'github.com'
      && (parsed.pathname === '/Aoike123/agy-lens' || parsed.pathname.startsWith('/Aoike123/agy-lens/'))
    ) {
      return parsed.href;
    }
  } catch { /* fallback below */ }
  return GITHUB_RELEASES_PAGE;
}

function summarizeNotes(name, body) {
  const sources = [body, name];
  for (const src of sources) {
    if (typeof src !== 'string' || !src.trim()) continue;
    const lines = src.split(/\r?\n/);
    for (const line of lines) {
      if (/^\s*!\[[^\]]*\]\([^)]+\)\s*$/.test(line)) continue;
      const cleaned = line
        .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
        .replace(/^\s{0,3}#{1,6}\s+/, '')
        .replace(/^\s*[-*+]\s+/, '')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/[`*_~>]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!cleaned) continue;
      const chars = Array.from(cleaned);
      return chars.length <= 160 ? cleaned : `${chars.slice(0, 159).join('')}…`;
    }
  }
  return null;
}

export function parseGithubRelease(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  if (json.draft === true || json.prerelease === true) return null;
  const ver = parseSemver(String(json.tag_name || json.name || ''));
  if (!ver) return null;
  const published_at = typeof json.published_at === 'string' && !Number.isNaN(Date.parse(json.published_at))
    ? json.published_at
    : null;
  return {
    latest_version: ver.raw,
    release_url: sanitizeReleaseUrl(json.html_url),
    published_at,
    notes_summary: summarizeNotes(json.name, json.body),
    source: 'github_release',
  };
}

export function parseManifestRelease(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const ver = parseSemver(String(json.version || ''));
  if (!ver) return null;
  return {
    latest_version: ver.raw,
    release_url: `https://github.com/Aoike123/agy-lens/releases/tag/v${ver.raw}`,
    published_at: null,
    notes_summary: null,
    source: 'github_manifest',
  };
}

export function readUpdateMeta(updateCachePath, currentVersion = '0.0.0', now = Date.now()) {
  const normCurrent = parseSemver(String(currentVersion || ''))?.raw || String(currentVersion || '0.0.0').trim().replace(/^v/i, '') || '0.0.0';
  const empty = {
    current_version: normCurrent,
    latest_version: null,
    update_available: false,
    release_url: GITHUB_RELEASES_PAGE,
    published_at: null,
    notes_summary: null,
    checked_at: null,
    source: null,
    stale: true,
  };
  if (!updateCachePath) return empty;
  const resolvedPath = expandHome(updateCachePath);
  if (!existsSync(resolvedPath)) return empty;
  try {
    const raw = JSON.parse(readFileSync(resolvedPath, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return empty;
    const latestVer = parseSemver(String(raw.latest_version || ''))?.raw || null;
    const checked_at = typeof raw.checked_at === 'string' && !Number.isNaN(Date.parse(raw.checked_at))
      ? raw.checked_at
      : null;
    const age = checked_at ? now - Date.parse(checked_at) : Infinity;
    const stale = !latestVer || !checked_at || age < 0 || age >= UPDATE_TTL_MS;
    return {
      current_version: normCurrent,
      latest_version: latestVer,
      update_available: Boolean(latestVer && compareSemver(latestVer, normCurrent) > 0),
      release_url: sanitizeReleaseUrl(raw.release_url),
      published_at: typeof raw.published_at === 'string' && !Number.isNaN(Date.parse(raw.published_at)) ? raw.published_at : null,
      notes_summary: typeof raw.notes_summary === 'string' && raw.notes_summary.trim() ? raw.notes_summary.trim() : null,
      checked_at,
      source: typeof raw.source === 'string' && raw.source.trim() ? raw.source.trim() : null,
      stale,
    };
  } catch {
    return empty;
  }
}

export function fetchUpdateBuffer(
  url,
  { headers = {}, timeoutMs = UPDATE_DOWNLOAD_TIMEOUT_MS, maxBytes = UPDATE_ZIP_MAX_BYTES } = {},
  redirects = 5,
) {
  const deadline = Date.now() + timeoutMs;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return Promise.reject(new Error('invalid URL'));
  }
  if (parsed.protocol !== 'https:') return Promise.reject(new Error('non-https URL rejected'));
  if (!isAllowedUpdateUrl(parsed.href)) return Promise.reject(new Error(`URL host not allowed: ${parsed.hostname}`));
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) rejectPromise(err);
      else resolvePromise(val);
    };
    const req = https.get(parsed, { headers, timeout: timeoutMs }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        const remaining = Math.max(1000, deadline - Date.now());
        let next;
        try {
          next = new URL(res.headers.location, parsed).href;
        } catch {
          finish(new Error('invalid redirect URL'));
          return;
        }
        clearTimeout(timer);
        settled = true;
        fetchUpdateBuffer(next, { headers, timeoutMs: remaining, maxBytes }, redirects - 1)
          .then(resolvePromise, rejectPromise);
        return;
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        finish(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      let total = 0;
      res.on('data', (chunk) => {
        total += chunk.length;
        if (total > maxBytes) {
          req.destroy(new Error('response too large'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => finish(null, Buffer.concat(chunks)));
      res.on('error', (e) => finish(e));
    });
    const timer = setTimeout(() => req.destroy(new Error('timeout')), timeoutMs);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => finish(e));
  });
}

async function fetchUpdateJson(url, { headers = {}, timeoutMs = UPDATE_TIMEOUT_MS } = {}) {
  const buf = await fetchUpdateBuffer(url, { headers, timeoutMs, maxBytes: UPDATE_MAX_BYTES });
  return JSON.parse(buf.toString('utf8'));
}

export async function checkForUpdate({
  updateCachePath = join(defaultDataDir(), 'update-cache.json'),
  currentVersion = readCurrentVersion(),
  force = false,
  timeoutMs = UPDATE_TIMEOUT_MS,
  now = Date.now(),
  fetchJson = null,
  disabled = false,
} = {}) {
  const envDisabled = TRUTHY_ENV_RE.test(String(process.env.AGY_LENS_NO_UPDATE_CHECK || '').trim());
  const cached = readUpdateMeta(updateCachePath, currentVersion, now);
  if (disabled || envDisabled) {
    return { ...cached, disabled: true };
  }
  if (!force && !cached.stale) {
    return cached;
  }

  const doFetch = typeof fetchJson === 'function' ? fetchJson : fetchUpdateJson;
  const attempts = [
    [
      'github_release',
      GITHUB_LATEST_RELEASE_URL,
      { Accept: 'application/vnd.github+json', 'User-Agent': `agy-lens/${cached.current_version}` },
      parseGithubRelease,
    ],
    [
      'github_manifest',
      GITHUB_MANIFEST_FALLBACK_URL,
      { Accept: 'application/json', 'User-Agent': `agy-lens/${cached.current_version}` },
      parseManifestRelease,
    ],
  ];

  const errors = [];
  for (const [label, url, headers, parse] of attempts) {
    try {
      const raw = await doFetch(url, { headers, timeoutMs });
      const parsed = parse(raw);
      if (!parsed || !parsed.latest_version) throw new Error('missing release version');
      const checked_at = new Date(now).toISOString();
      const record = {
        ...parsed,
        checked_at,
      };
      if (updateCachePath) {
        try {
          writeJsonAtomic(updateCachePath, record);
        } catch { /* cache write is best-effort */ }
      }
      return {
        current_version: cached.current_version,
        latest_version: parsed.latest_version,
        update_available: compareSemver(parsed.latest_version, cached.current_version) > 0,
        release_url: parsed.release_url,
        published_at: parsed.published_at,
        notes_summary: parsed.notes_summary,
        checked_at,
        source: parsed.source,
        stale: false,
      };
    } catch (err) {
      errors.push(`${label}: ${err?.message || String(err)}`);
    }
  }

  return { ...cached, error: 'failed', message: errors.join('; ') };
}

export function parseSha256Sums(text) {
  const sums = new Map();
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (!m) continue;
    const hash = m[1].toLowerCase();
    const file = m[2].trim().replace(/^\.\//, '');
    if (file) sums.set(file, hash);
  }
  return sums;
}

function validateZipEntryName(rawName, topDir) {
  if (typeof rawName !== 'string' || !rawName) {
    throw new Error('Invalid ZIP entry: empty name');
  }
  if (/[\x00-\x1f\\]/.test(rawName) || rawName.startsWith('/') || /^[A-Za-z]:/.test(rawName)) {
    throw new Error(`Unsafe ZIP entry path: ${rawName}`);
  }
  const isDir = rawName.endsWith('/');
  const trimmed = isDir ? rawName.slice(0, -1) : rawName;
  if (!trimmed) throw new Error(`Unsafe ZIP entry path: ${rawName}`);
  const parts = trimmed.split('/');
  for (const part of parts) {
    if (!part || part === '.' || part === '..') {
      throw new Error(`Unsafe ZIP entry traversal: ${rawName}`);
    }
  }
  if (!topDir) return { isDir, rel: trimmed };
  if (isDir && trimmed === topDir) return { isDir: true, rel: '' };
  const prefix = `${topDir}/`;
  if (!trimmed.startsWith(prefix)) {
    throw new Error(`Unexpected ZIP root prefix for entry: ${rawName}`);
  }
  const rel = trimmed.slice(prefix.length);
  if (!rel) throw new Error(`Invalid ZIP entry path: ${rawName}`);
  return { isDir, rel };
}

export function extractZipEntries(zipBuffer, { topDir = 'agy-lens' } = {}) {
  const buf = Buffer.isBuffer(zipBuffer) ? zipBuffer : Buffer.from(zipBuffer);
  if (buf.length < 22) {
    throw new Error('Invalid ZIP: file too small');
  }
  let eocdOff = -1;
  const minScan = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= minScan; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      const cmtLen = buf.readUInt16LE(i + 20);
      if (i + 22 + cmtLen === buf.length) {
        eocdOff = i;
        break;
      }
    }
  }
  if (eocdOff < 0) {
    throw new Error('Invalid ZIP: EOCD header not found');
  }

  const diskNo = buf.readUInt16LE(eocdOff + 4);
  const cdDiskNo = buf.readUInt16LE(eocdOff + 6);
  const diskEntries = buf.readUInt16LE(eocdOff + 8);
  const totalEntries = buf.readUInt16LE(eocdOff + 10);
  const cdSize = buf.readUInt32LE(eocdOff + 12);
  const cdOff = buf.readUInt32LE(eocdOff + 16);

  if (diskNo !== 0 || cdDiskNo !== 0 || diskEntries !== totalEntries) {
    throw new Error('Unsupported multi-disk ZIP');
  }
  if (totalEntries === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) {
    throw new Error('Unsupported ZIP64 archive');
  }
  if (totalEntries <= 0 || totalEntries > MAX_ZIP_ENTRIES) {
    throw new Error(`Invalid ZIP entry count: ${totalEntries}`);
  }
  if (cdOff + cdSize > eocdOff) {
    throw new Error('Invalid ZIP: truncated central directory');
  }

  const entries = new Map();
  let cursor = cdOff;
  let totalUncomp = 0;

  for (let i = 0; i < totalEntries; i += 1) {
    if (cursor + 46 > cdOff + cdSize || buf.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error(`Invalid ZIP central directory header at index ${i}`);
    }
    const flags = buf.readUInt16LE(cursor + 8);
    if (flags & 0x0001) {
      throw new Error('Encrypted ZIP entries are not supported');
    }
    const method = buf.readUInt16LE(cursor + 10);
    const expectedCrc = buf.readUInt32LE(cursor + 16);
    const compSize = buf.readUInt32LE(cursor + 20);
    const uncompSize = buf.readUInt32LE(cursor + 24);
    const nameLen = buf.readUInt16LE(cursor + 28);
    const extraLen = buf.readUInt16LE(cursor + 30);
    const cmtLen = buf.readUInt16LE(cursor + 32);
    const extAttrs = buf.readUInt32LE(cursor + 38);
    const localOff = buf.readUInt32LE(cursor + 42);

    if (cursor + 46 + nameLen + extraLen + cmtLen > cdOff + cdSize) {
      throw new Error(`Truncated ZIP central directory record at index ${i}`);
    }
    const rawName = buf.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8');
    cursor += 46 + nameLen + extraLen + cmtLen;

    if (((extAttrs >>> 16) & 0o170000) === 0o120000) {
      throw new Error(`Symlink ZIP entries are rejected: ${rawName}`);
    }
    if (compSize === 0xffffffff || uncompSize === 0xffffffff) {
      throw new Error(`Unsupported ZIP64 entry size: ${rawName}`);
    }
    if (uncompSize > MAX_ZIP_ENTRY_BYTES || compSize > MAX_ZIP_TOTAL_BYTES) {
      throw new Error(`ZIP entry exceeds size limit: ${rawName}`);
    }

    const { isDir, rel } = validateZipEntryName(rawName, topDir);
    if (isDir) {
      if (compSize !== 0 || uncompSize !== 0) {
        throw new Error(`Invalid directory entry size: ${rawName}`);
      }
      continue;
    }
    if (entries.has(rel)) {
      throw new Error(`Duplicate ZIP entry: ${rel}`);
    }
    if (method !== 0 && method !== 8) {
      throw new Error(`Unsupported ZIP compression method ${method} for ${rel}`);
    }
    if (localOff + 30 > cdOff || buf.readUInt32LE(localOff) !== 0x04034b50) {
      throw new Error(`Invalid ZIP local file header for ${rel}`);
    }
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    if (localOff + 30 + lNameLen > cdOff) {
      throw new Error(`Truncated ZIP local file header for ${rel}`);
    }
    const localRawName = buf.subarray(localOff + 30, localOff + 30 + lNameLen).toString('utf8');
    if (localRawName !== rawName) {
      throw new Error(`ZIP local header filename mismatch for ${rel}`);
    }
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const dataEnd = dataStart + compSize;
    if (dataEnd > cdOff) {
      throw new Error(`Truncated ZIP entry payload: ${rel}`);
    }

    const compData = buf.subarray(dataStart, dataEnd);
    let raw;
    if (method === 0) {
      if (compSize !== uncompSize) {
        throw new Error(`Corrupt stored ZIP entry size: ${rel}`);
      }
      raw = Buffer.from(compData);
    } else {
      raw = inflateRawSync(compData, { maxOutputLength: MAX_ZIP_ENTRY_BYTES });
    }
    if (raw.length !== uncompSize) {
      throw new Error(`Decompressed size mismatch for ZIP entry: ${rel}`);
    }
    totalUncomp += raw.length;
    if (totalUncomp > MAX_ZIP_TOTAL_BYTES) {
      throw new Error('Total extracted ZIP size exceeds limit');
    }
    if (crc32(raw) !== expectedCrc) {
      throw new Error(`CRC-32 mismatch for ZIP entry: ${rel}`);
    }
    entries.set(rel, raw);
  }

  return entries;
}

function collectManagedFiles(rootDir) {
  const files = [];
  for (const relBase of MANAGED_SUBDIRS) {
    const absBase = join(rootDir, relBase);
    if (!existsSync(absBase)) continue;
    const walk = (absCur, relCur) => {
      for (const ent of readdirSync(absCur, { withFileTypes: true })) {
        if (ent.name.startsWith('.')) continue;
        if (ent.isDirectory()) {
          if (IGNORED_MANAGED_DIRS.has(ent.name)) continue;
          walk(join(absCur, ent.name), posix.join(relCur, ent.name));
        } else if (ent.isFile()) {
          files.push(posix.join(relCur, ent.name));
        }
      }
    };
    walk(absBase, relBase);
  }
  return files;
}

const SLEEP_ARRAY = new Int32Array(new SharedArrayBuffer(4));

function writeFileAtomicSameDir(destPath, data, seq = 0) {
  mkdirSync(dirname(destPath), { recursive: true });
  const tmp = `${destPath}.tmp.${process.pid}.${seq}`;
  writeFileSync(tmp, data);
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      renameSync(tmp, destPath);
      return;
    } catch (err) {
      lastErr = err;
      if ((err?.code === 'EPERM' || err?.code === 'EBUSY') && attempt < 2) {
        try { Atomics.wait(SLEEP_ARRAY, 0, 0, 25); } catch { /* ignore */ }
        continue;
      }
      break;
    }
  }
  try { unlinkSync(tmp); } catch { /* ignore */ }
  throw lastErr;
}

function rollbackUpdatedFiles(ops) {
  for (let i = ops.length - 1; i >= 0; i -= 1) {
    const { dest, backupPath } = ops[i];
    try {
      if (backupPath && existsSync(backupPath)) {
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(backupPath, dest);
      } else {
        try {
          unlinkSync(dest);
        } catch (err) {
          if (err?.code !== 'ENOENT') throw err;
        }
      }
    } catch { /* continue restoring remaining files */ }
  }
}

export async function installReleaseUpdate({
  rootDir = REPO_ROOT,
  dataDir = defaultDataDir(),
  updateCachePath = join(defaultDataDir(), 'update-cache.json'),
  currentVersion = readCurrentVersion(rootDir),
  targetVersion = null,
  fetchJson = null,
  fetchBuffer = null,
  writeFile = null,
  timeoutMs = UPDATE_DOWNLOAD_TIMEOUT_MS,
  now = Date.now(),
} = {}) {
  const resolvedRoot = resolve(expandHome(rootDir));
  const resolvedDataDir = resolve(expandHome(dataDir));
  const mode = detectInstallMode(resolvedRoot);
  if (!mode.can_self_update) {
    throw new Error(`Self-update is unavailable in install_mode="${mode.install_mode}"`);
  }

  const normCurrent = parseSemver(String(currentVersion || ''))?.raw
    || String(currentVersion || '0.0.0').trim().replace(/^v/i, '')
    || '0.0.0';

  let resolvedTarget = '';
  let releaseMeta = null;
  if (targetVersion !== null && targetVersion !== undefined && String(targetVersion).trim()) {
    const parsed = parseSemver(String(targetVersion));
    if (!parsed) throw new Error(`Invalid target version: ${targetVersion}`);
    resolvedTarget = parsed.raw;
  } else {
    const checkRes = await checkForUpdate({
      updateCachePath,
      currentVersion: normCurrent,
      force: true,
      timeoutMs: Math.min(timeoutMs, UPDATE_TIMEOUT_MS),
      now,
      fetchJson,
    });
    if (!checkRes.latest_version) {
      throw new Error(checkRes.message || 'Unable to determine latest release version');
    }
    resolvedTarget = checkRes.latest_version;
    releaseMeta = checkRes;
  }

  if (compareSemver(resolvedTarget, normCurrent) <= 0) {
    return {
      ok: true,
      updated: false,
      previous_version: normCurrent,
      version: normCurrent,
      restarting: false,
      install_mode: mode.install_mode,
    };
  }

  const doFetchBuffer = typeof fetchBuffer === 'function' ? fetchBuffer : fetchUpdateBuffer;
  const zipName = `agy-lens-v${resolvedTarget}.zip`;
  const sumsUrl = `${GITHUB_DOWNLOAD_BASE}/v${resolvedTarget}/SHA256SUMS.txt`;
  const zipUrl = `${GITHUB_DOWNLOAD_BASE}/v${resolvedTarget}/${zipName}`;
  const reqHeaders = { 'User-Agent': `agy-lens/${normCurrent}` };

  const sumsBuf = await doFetchBuffer(sumsUrl, {
    headers: { ...reqHeaders, Accept: 'text/plain' },
    timeoutMs: Math.min(timeoutMs, UPDATE_TIMEOUT_MS),
    maxBytes: UPDATE_MAX_BYTES,
  });
  const sums = parseSha256Sums(sumsBuf.toString('utf8'));
  const expectedHex = sums.get(zipName);
  if (!expectedHex) {
    throw new Error(`Release checksum missing for ${zipName}`);
  }

  const zipBuf = await doFetchBuffer(zipUrl, {
    headers: { ...reqHeaders, Accept: 'application/octet-stream' },
    timeoutMs,
    maxBytes: UPDATE_ZIP_MAX_BYTES,
  });
  const actualHex = createHash('sha256').update(zipBuf).digest('hex');
  if (!timingSafeEqual(Buffer.from(actualHex, 'hex'), Buffer.from(expectedHex, 'hex'))) {
    throw new Error(`SHA-256 checksum mismatch for ${zipName}`);
  }

  const entries = extractZipEntries(zipBuf, { topDir: 'agy-lens' });
  for (const requiredRel of SENTINEL_FILES) {
    if (!entries.has(requiredRel)) {
      throw new Error(`Release archive missing required file: ${requiredRel}`);
    }
  }
  let nextManifest;
  try {
    nextManifest = JSON.parse(entries.get('plugin.json').toString('utf8'));
  } catch (err) {
    throw new Error(`Invalid plugin.json in release archive: ${err?.message || String(err)}`);
  }
  if (!nextManifest || nextManifest.name !== 'agy-lens') {
    throw new Error('Invalid plugin.json name in release archive');
  }
  const archiveVer = parseSemver(String(nextManifest.version || ''))?.raw;
  if (archiveVer !== resolvedTarget) {
    throw new Error(`Archive version mismatch: expected ${resolvedTarget}, got ${archiveVer || 'invalid'}`);
  }

  const resolvedRootPrefix = resolvedRoot.endsWith(sep) ? resolvedRoot : resolvedRoot + sep;
  const plan = [];
  let manifestDest = null;
  let manifestBuf = null;
  for (const [rel, data] of entries.entries()) {
    const dest = resolve(resolvedRoot, rel);
    if (!dest.startsWith(resolvedRootPrefix)) {
      throw new Error(`Resolved path escapes plugin root: ${rel}`);
    }
    if (rel === 'plugin.json') {
      manifestDest = dest;
      manifestBuf = data;
    } else {
      plan.push({ rel, dest, data });
    }
  }

  const obsoleteFiles = collectManagedFiles(resolvedRoot).filter((rel) => !entries.has(rel));
  const backupDir = join(resolvedDataDir, `.update-backup-${process.pid}-${Date.now()}`);
  mkdirSync(backupDir, { recursive: true });

  const writeFn = typeof writeFile === 'function' ? writeFile : writeFileAtomicSameDir;
  const rollbackOps = [];
  let seq = 0;

  const backupTarget = (rel, dest) => {
    if (!existsSync(dest)) {
      rollbackOps.push({ dest, backupPath: null });
      return;
    }
    const bk = join(backupDir, rel);
    mkdirSync(dirname(bk), { recursive: true });
    copyFileSync(dest, bk);
    rollbackOps.push({ dest, backupPath: bk });
  };

  try {
    for (const { rel, dest, data } of plan) {
      backupTarget(rel, dest);
      seq += 1;
      await writeFn(dest, data, seq, rel);
      if (rel === 'bin/cli.mjs' && process.platform !== 'win32') {
        try { chmodSync(dest, 0o755); } catch { /* best-effort executable bit */ }
      }
    }

    for (const rel of obsoleteFiles) {
      const dest = resolve(resolvedRoot, rel);
      if (!dest.startsWith(resolvedRootPrefix) || !existsSync(dest)) continue;
      backupTarget(rel, dest);
      unlinkSync(dest);
    }

    backupTarget('plugin.json', manifestDest);
    seq += 1;
    await writeFn(manifestDest, manifestBuf, seq, 'plugin.json');
  } catch (err) {
    rollbackUpdatedFiles(rollbackOps);
    throw err;
  } finally {
    try {
      rmSync(backupDir, { recursive: true, force: true });
    } catch { /* best-effort backup cleanup */ }
  }

  if (updateCachePath) {
    try {
      const prevMeta = releaseMeta || readUpdateMeta(updateCachePath, resolvedTarget, now);
      const sameVer = prevMeta && prevMeta.latest_version === resolvedTarget;
      writeJsonAtomic(updateCachePath, {
        latest_version: resolvedTarget,
        release_url: `https://github.com/Aoike123/agy-lens/releases/tag/v${resolvedTarget}`,
        published_at: sameVer ? (prevMeta.published_at || null) : null,
        notes_summary: sameVer ? (prevMeta.notes_summary || null) : null,
        source: (sameVer && prevMeta.source) || 'github_release',
        checked_at: new Date(now).toISOString(),
      });
    } catch { /* best-effort cache refresh */ }
  }

  return {
    ok: true,
    updated: true,
    previous_version: normCurrent,
    version: resolvedTarget,
    restarting: true,
    install_mode: mode.install_mode,
    files_written: entries.size,
    files_removed: obsoleteFiles.length,
  };
}
