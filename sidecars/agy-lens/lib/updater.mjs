// Opt-out-safe GitHub Release update checker for Agy Lens.
// Pure ESM, zero external dependencies, 6h local cache in update-cache.json.

import { existsSync, readFileSync } from 'node:fs';
import https from 'node:https';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultDataDir, expandHome, writeJsonAtomic } from './pb.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');

export const UPDATE_TTL_MS = 6 * 60 * 60 * 1000;
export const UPDATE_TIMEOUT_MS = 8 * 1000;
export const UPDATE_MAX_BYTES = 1024 * 1024;
export const GITHUB_LATEST_RELEASE_URL = 'https://api.github.com/repos/Aoike123/agy-lens/releases/latest';
export const GITHUB_MANIFEST_FALLBACK_URL = 'https://raw.githubusercontent.com/Aoike123/agy-lens/main/plugin.json';
export const GITHUB_RELEASES_PAGE = 'https://github.com/Aoike123/agy-lens/releases/latest';

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const TRUTHY_ENV_RE = /^(1|true|yes)$/i;

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
      const cleaned = line
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

function fetchUpdateJson(url, { headers = {}, timeoutMs = UPDATE_TIMEOUT_MS } = {}, redirects = 3) {
  const deadline = Date.now() + timeoutMs;
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') return Promise.reject(new Error('non-https URL rejected'));
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
        const next = new URL(res.headers.location, parsed).href;
        clearTimeout(timer);
        settled = true;
        fetchUpdateJson(next, { headers, timeoutMs: remaining }, redirects - 1).then(resolvePromise, rejectPromise);
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
        if (total > UPDATE_MAX_BYTES) {
          req.destroy(new Error('response too large'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        try {
          finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (e) {
          finish(e);
        }
      });
      res.on('error', (e) => finish(e));
    });
    const timer = setTimeout(() => req.destroy(new Error('timeout')), timeoutMs);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => finish(e));
  });
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
