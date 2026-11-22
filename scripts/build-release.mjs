#!/usr/bin/env node
/**
 * Builds the pure Node.js direct-install release ZIP for Agy Lens (agy-lens)
 * using only built-in Node.js modules (zero external dependencies).
 *
 * Outputs:
 *   dist/agy-lens.zip
 *   dist/agy-lens-v<version>.zip
 *   dist/SHA256SUMS.txt
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const DIST = join(ROOT, 'dist');
export const TOP_DIR = 'agy-lens';

export const RUNTIME_FILES = [
  'plugin.json',
  'package.json',
  'LICENSE',
  'README.md',
  'assets/logo.svg',
  'bin/cli.mjs',
  'sidecars/agy-lens/package.json',
  'sidecars/agy-lens/sidecar.json',
  'sidecars/agy-lens/main.mjs',
];

const IGNORED_DIRS = new Set(['__pycache__', '.data', 'node_modules']);

function collectFiles(rootDir, relDir, exts) {
  const absDir = join(rootDir, relDir);
  if (!existsSync(absDir)) return [];
  const results = [];
  const walk = (absCur, relCur) => {
    const entries = readdirSync(absCur, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      if (ent.isDirectory()) {
        if (IGNORED_DIRS.has(ent.name)) continue;
        walk(join(absCur, ent.name), posix.join(relCur, ent.name));
      } else if (ent.isFile()) {
        if (exts.some((ext) => ent.name.endsWith(ext))) {
          results.push(posix.join(relCur, ent.name));
        }
      }
    }
  };
  walk(absDir, relDir.replace(/\\/g, '/'));
  return results.sort();
}

export function collectRuntimeFiles(rootDir = ROOT) {
  const files = [...RUNTIME_FILES];
  if (existsSync(join(rootDir, 'README.zh-CN.md'))) {
    files.push('README.zh-CN.md');
  }
  files.push(...collectFiles(rootDir, 'sidecars/agy-lens/lib', ['.mjs']));
  files.push(...collectFiles(rootDir, 'sidecars/agy-lens/web', ['.html', '.css', '.js']));
  return Array.from(new Set(files)).sort();
}

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

function dosDateTime(date) {
  const yr = Math.max(1980, date.getFullYear());
  const dosDate = ((yr - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  return { dosDate, dosTime };
}

/**
 * Minimal standard PKZIP writer using store or raw deflate + UTF-8 filenames.
 */
export function buildZipBuffer(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const { name, data, mtime = new Date() } of entries) {
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const nameBuf = Buffer.from(name.replace(/\\/g, '/'), 'utf8');
    const crc = crc32(raw);
    const deflated = deflateRawSync(raw, { level: 9 });
    const useDeflate = deflated.length < raw.length;
    const payload = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const { dosDate, dosTime } = dosDateTime(mtime);
    const flags = 0x0800; // UTF-8 filename/comment encoding

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed: 2.0
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra len
    localParts.push(local, nameBuf, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // Unix creator, 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra len
    central.writeUInt16LE(0, 32); // comment len
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // regular file 0644
    central.writeUInt32LE(offset >>> 0, 42);
    centralParts.push(central, nameBuf);

    offset += local.length + nameBuf.length + payload.length;
  }

  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length >>> 0, 12);
  eocd.writeUInt32LE(offset >>> 0, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralBuf, eocd]);
}

export function buildRelease(rootDir = ROOT, outDir = DIST) {
  const manifest = JSON.parse(readFileSync(join(rootDir, 'plugin.json'), 'utf8'));
  const version = String(manifest.version || '0.0.0').replace(/^v/, '');
  const entries = collectRuntimeFiles(rootDir).map((rel) => {
    const abs = join(rootDir, rel);
    return {
      name: `${TOP_DIR}/${rel}`,
      data: readFileSync(abs),
      mtime: statSync(abs).mtime,
    };
  });

  const zipBuf = buildZipBuffer(entries);
  mkdirSync(outDir, { recursive: true });
  const genericName = `${TOP_DIR}.zip`;
  const versionedName = `${TOP_DIR}-v${version}.zip`;
  const genericPath = join(outDir, genericName);
  const versionedPath = join(outDir, versionedName);
  writeFileSync(genericPath, zipBuf);
  writeFileSync(versionedPath, zipBuf);

  const hash = createHash('sha256').update(zipBuf).digest('hex');
  const sums = `${hash}  ${genericName}\n${hash}  ${versionedName}\n`;
  writeFileSync(join(outDir, 'SHA256SUMS.txt'), sums, 'utf8');
  return { version, size: zipBuf.length, hash, genericPath, versionedPath, files: entries.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const res = buildRelease();
  console.log(`Built ${res.files} files -> ${res.genericPath} (${res.size} bytes, sha256=${res.hash.slice(0, 12)}…)`);
  console.log(`Built versioned -> ${res.versionedPath}`);
}
