// Share-card profile persistence and share-art asset reading (sidecar side).
//
// share-profile.json in the data directory holds the optional nickname and novice gender
// look for the pixel role card.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
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
