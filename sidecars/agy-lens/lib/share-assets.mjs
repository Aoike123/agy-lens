// Share-card profile persistence and share-art asset reading (sidecar side).
//
// share-profile.json in the data directory holds the optional nickname and novice gender
// look for the pixel role card.

import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { writeJsonAtomic } from './pb.mjs';
import { sanitizeNickname } from '../web/views/share-game.js';

export const SHARE_PROFILE_VERSION = 1;

function freshState() {
  return { version: SHARE_PROFILE_VERSION, nickname: '', gender: 'male' };
}

export function loadShareProfile(filePath) {
  let raw = null;
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    raw = null;
  }
  if (!raw || typeof raw !== 'object') {
    const st = freshState();
    writeJsonAtomic(filePath, st);
    return st;
  }
  return {
    version: SHARE_PROFILE_VERSION,
    nickname: sanitizeNickname(raw.nickname),
    gender: raw.gender === 'female' ? 'female' : 'male',
  };
}

export function shareProfilePayload(st) {
  return {
    nickname: sanitizeNickname(st && st.nickname),
    gender: st && st.gender === 'female' ? 'female' : 'male',
  };
}

export function updateShareProfile(filePath, { nickname, gender } = {}) {
  const st = loadShareProfile(filePath);
  if (nickname !== undefined) st.nickname = sanitizeNickname(nickname);
  if (gender !== undefined) st.gender = gender === 'female' ? 'female' : 'male';
  writeJsonAtomic(filePath, st);
  return { ok: true, ...shareProfilePayload(st) };
}

// --- share-art assets ---------------------------------------------------------------------

const ASSET_RE = /^(?:characters\/[a-z0-9-]+\/[a-z0-9-]+\.(?:png|webp)|arenas\/[a-z0-9-]+\.png)$/;
const MIME = { '.png': 'image/png', '.webp': 'image/webp' };

export function listShareAssets(artDir) {
  const out = [];
  const walk = (dir, rel) => {
    let ents = [];
    try {
      ents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(dir, e.name), r);
      else if (ASSET_RE.test(r)) out.push(r);
    }
  };
  walk(artDir, '');
  return out.sort();
}

/** One asset as base64 (the sidecar serves text only; the panel turns it into a data URI). */
export function readShareAsset(artDir, relPath) {
  const rel = String(relPath || '');
  if (!ASSET_RE.test(rel)) return { error: 'bad_path' };
  const root = resolve(artDir);
  const abs = resolve(root, ...rel.split('/'));
  if (!abs.startsWith(root + sep) || !existsSync(abs)) return { error: 'not_found' };
  const data = readFileSync(abs).toString('base64');
  return { path: rel, mime: MIME[extname(abs)] || 'application/octet-stream', data };
}

// --- animated GIF & motion file OS file-clipboard bridge ---------------------------------

export const MAX_SHARE_GIF_BYTES = 12 * 1024 * 1024;
export const MAX_SHARE_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_SAVED_GIFS = 5;

const SHARE_EXPORT_EXTS = new Set(['.gif', '.jpg', '.mp4', '.webm']);

export function clipboardCommandForPlatform(filePath, { platform = process.platform, env = process.env } = {}) {
  const target = String(filePath || '');
  if (!target) return null;
  if (platform === 'win32') {
    return {
      cmd: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-STA', '-Command', 'Set-Clipboard -LiteralPath $env:AGY_CLIP_PATH'],
      env: { ...env, AGY_CLIP_PATH: target },
      windowsHide: true,
    };
  }
  if (platform === 'darwin') {
    return {
      cmd: 'osascript',
      args: [
        '-e', 'on run argv',
        '-e', 'set the clipboard to (POSIX file (item 1 of argv))',
        '-e', 'end run',
        '--', target,
      ],
      env,
    };
  }
  if (platform === 'linux') {
    const uriList = `file://${encodeURI(target)}\r\n`;
    if (env && env.WAYLAND_DISPLAY) {
      return { cmd: 'wl-copy', args: ['--type', 'text/uri-list'], stdin: uriList, env };
    }
    if (env && env.DISPLAY) {
      return { cmd: 'xclip', args: ['-selection', 'clipboard', '-t', 'text/uri-list'], stdin: uriList, env };
    }
    return null;
  }
  return null;
}

function defaultExecClipboard(spec) {
  return new Promise((resolveRun, rejectRun) => {
    if (spec.stdin !== undefined) {
      const child = spawn(spec.cmd, spec.args, { env: spec.env, stdio: ['pipe', 'ignore', 'pipe'], windowsHide: Boolean(spec.windowsHide) });
      let errText = '';
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* ignore */ }
        rejectRun(new Error('Clipboard command timed out'));
      }, 8000);
      if (child.stderr) child.stderr.on('data', (c) => { errText += String(c); });
      child.on('error', (err) => { clearTimeout(timer); rejectRun(err); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolveRun();
        else rejectRun(new Error(errText.trim() || `Clipboard command exited with ${code}`));
      });
      child.stdin.end(spec.stdin);
      return;
    }
    execFile(spec.cmd, spec.args, { env: spec.env, timeout: 8000, windowsHide: Boolean(spec.windowsHide) }, (err, _stdout, stderr) => {
      if (err) {
        const msg = String(stderr || '').trim();
        rejectRun(msg ? new Error(msg) : err);
      } else {
        resolveRun();
      }
    });
  });
}

function pruneSavedGifs(dir, maxFiles = MAX_SAVED_GIFS, exts = null) {
  try {
    const allowed = exts || new Set(['.gif']);
    const files = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && allowed.has(extname(e.name).toLowerCase()))
      .map((e) => {
        const abs = join(dir, e.name);
        let mtimeMs = 0;
        try { mtimeMs = statSync(abs).mtimeMs; } catch { /* ignore */ }
        return { abs, mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (let i = maxFiles; i < files.length; i += 1) {
      try { unlinkSync(files[i].abs); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

function findJpegEoiEnd(buf) {
  if (!buf || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) return -1;
  let pos = 2;
  while (pos < buf.length) {
    if (buf[pos] !== 0xff) return -1;
    while (pos < buf.length && buf[pos] === 0xff) pos += 1;
    if (pos >= buf.length) return -1;
    const marker = buf[pos];
    pos += 1;
    if (marker === 0xd9) return pos;
    if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue;
    if (pos + 2 > buf.length) return -1;
    const segLen = (buf[pos] << 8) | buf[pos + 1];
    if (segLen < 2 || pos + segLen > buf.length) return -1;
    if (marker === 0xda) {
      let scan = pos + segLen;
      while (scan < buf.length - 1) {
        if (buf[scan] === 0xff) {
          const next = buf[scan + 1];
          if (next === 0x00 || (next >= 0xd0 && next <= 0xd7) || next === 0xff) {
            scan += next === 0xff ? 1 : 2;
            continue;
          }
          if (next === 0xd9) return scan + 2;
          pos = scan;
          break;
        }
        scan += 1;
      }
      if (pos !== scan) return -1;
      continue;
    }
    pos += segLen;
  }
  return -1;
}

function validateShareFileMagic(buf, kind) {
  if (kind === 'gif') {
    if (buf.length < 14) return false;
    const header = buf.subarray(0, 6).toString('ascii');
    return (header === 'GIF89a' || header === 'GIF87a') && buf[buf.length - 1] === 0x3b;
  }
  if (kind === 'jpg') {
    const eoiEnd = findJpegEoiEnd(buf);
    if (eoiEnd < 4) return false;
    // Allow plain JPEG (eoiEnd === buf.length) OR Motion Photo JPEG + trailing MP4 (`ftyp` box)
    if (eoiEnd < buf.length) {
      if (eoiEnd + 12 > buf.length) return false;
      return buf.subarray(eoiEnd + 4, eoiEnd + 8).toString('ascii') === 'ftyp';
    }
    return true;
  }
  if (kind === 'mp4') {
    return buf.length >= 12 && buf.subarray(4, 8).toString('ascii') === 'ftyp';
  }
  if (kind === 'webm') {
    return buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3;
  }
  return false;
}

/** Decode base64 GIF/JPG/MP4/WebM payload, validate magic bytes, save rolling file, and place onto OS file clipboard. */
export async function copyShareFileToClipboard(
  exportDir,
  { data, filename, kind } = {},
  { platform = process.platform, env = process.env, execFileFn = defaultExecClipboard } = {},
) {
  const normKind = String(kind || '').toLowerCase();
  if (!['gif', 'jpg', 'mp4', 'webm'].includes(normKind)) {
    return { ok: false, error: 'invalid_kind' };
  }
  const rawStr = String(data || '').replace(/^data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,/i, '').replace(/\s+/g, '');
  if (!rawStr || !/^[A-Za-z0-9+/]+={0,2}$/.test(rawStr) || rawStr.length % 4 !== 0) {
    return { ok: false, error: 'invalid_file' };
  }
  const approxBytes = Math.floor((rawStr.length * 3) / 4);
  if (approxBytes > MAX_SHARE_FILE_BYTES) {
    return { ok: false, error: 'too_large' };
  }
  const buf = Buffer.from(rawStr, 'base64');
  if (buf.length > MAX_SHARE_FILE_BYTES) {
    return { ok: false, error: 'too_large' };
  }
  if (!validateShareFileMagic(buf, normKind)) {
    return { ok: false, error: 'invalid_file' };
  }

  const root = resolve(exportDir);
  mkdirSync(root, { recursive: true });
  const stem = String(filename || '')
    .replace(/\.(?:gif|jpe?g|mp4|webm)$/i, '')
    .replace(/[^a-z0-9_-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'agy-lens-share';
  const name = `${stem}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.${normKind}`;
  const abs = resolve(root, name);
  if (!abs.startsWith(root + sep)) {
    return { ok: false, error: 'invalid_path' };
  }

  pruneSavedGifs(root, Math.max(0, MAX_SAVED_GIFS - 1), SHARE_EXPORT_EXTS);
  writeFileSync(abs, buf);

  const spec = clipboardCommandForPlatform(abs, { platform, env });
  if (!spec) {
    return { ok: false, error: 'clipboard_unsupported', path: abs, bytes: buf.length, kind: normKind };
  }
  try {
    await execFileFn(spec);
    return { ok: true, path: abs, bytes: buf.length, kind: normKind };
  } catch (err) {
    return {
      ok: false,
      error: 'clipboard_failed',
      message: err && err.message ? err.message : String(err),
      path: abs,
      bytes: buf.length,
      kind: normKind,
    };
  }
}

/** Decode base64 GIF payload, validate magic/trailer, save rolling file, and place onto OS file clipboard. */
export async function copyShareGifToClipboard(
  exportDir,
  { data, filename } = {},
  { platform = process.platform, env = process.env, execFileFn = defaultExecClipboard } = {},
) {
  const rawStr = String(data || '').replace(/^data:image\/gif;base64,/i, '').replace(/\s+/g, '');
  if (!rawStr || !/^[A-Za-z0-9+/]+={0,2}$/.test(rawStr) || rawStr.length % 4 !== 0) {
    return { ok: false, error: 'invalid_gif' };
  }
  const approxBytes = Math.floor((rawStr.length * 3) / 4);
  if (approxBytes > MAX_SHARE_GIF_BYTES) {
    return { ok: false, error: 'too_large' };
  }
  const buf = Buffer.from(rawStr, 'base64');
  if (buf.length > MAX_SHARE_GIF_BYTES) {
    return { ok: false, error: 'too_large' };
  }
  if (buf.length < 14) {
    return { ok: false, error: 'invalid_gif' };
  }
  const header = buf.subarray(0, 6).toString('ascii');
  if ((header !== 'GIF89a' && header !== 'GIF87a') || buf[buf.length - 1] !== 0x3b) {
    return { ok: false, error: 'invalid_gif' };
  }

  const root = resolve(exportDir);
  mkdirSync(root, { recursive: true });
  const stem = String(filename || '')
    .replace(/\.gif$/i, '')
    .replace(/[^a-z0-9_-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'agy-lens-role';
  const name = `${stem}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.gif`;
  const abs = resolve(root, name);
  if (!abs.startsWith(root + sep)) {
    return { ok: false, error: 'invalid_path' };
  }

  pruneSavedGifs(root, Math.max(0, MAX_SAVED_GIFS - 1));
  writeFileSync(abs, buf);

  const spec = clipboardCommandForPlatform(abs, { platform, env });
  if (!spec) {
    return { ok: false, error: 'clipboard_unsupported', path: abs, bytes: buf.length };
  }
  try {
    await execFileFn(spec);
    return { ok: true, path: abs, bytes: buf.length };
  } catch (err) {
    return {
      ok: false,
      error: 'clipboard_failed',
      message: err && err.message ? err.message : String(err),
      path: abs,
      bytes: buf.length,
    };
  }
}
