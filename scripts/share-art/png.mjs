// Zero-dependency PNG decode/encode for the share-card art pipeline (Node.js 24+, node:zlib only).
// decodePng returns { width, height, data } with data as RGBA8 Uint8Array; encodePng takes the same shape.

import { deflateSync, inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

export function decodePng(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('Not a PNG file');
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 8;
  let colorType = 6;
  let interlace = 0;
  let palette = null;
  let trns = null;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      bitDepth = body[8];
      colorType = body[9];
      interlace = body[12];
    } else if (type === 'PLTE') {
      palette = body;
    } else if (type === 'tRNS') {
      trns = body;
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
  }
  if (!width || !height) throw new Error('PNG missing IHDR');
  if (interlace) throw new Error('Interlaced PNG is not supported; re-save without interlacing');
  if (!(colorType in CHANNELS)) throw new Error(`Unsupported PNG color type ${colorType}`);
  if (![1, 2, 4, 8, 16].includes(bitDepth)) throw new Error(`Unsupported PNG bit depth ${bitDepth}`);

  const channels = CHANNELS[colorType];
  const bitsPerPixel = channels * bitDepth;
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length < height * (stride + 1)) throw new Error('PNG data is truncated');

  const rows = new Uint8Array(height * stride);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = rows.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i += 1) {
      const a = i >= bpp ? out[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = src[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) v += paeth(a, b, c);
      else if (filter !== 0) throw new Error(`Bad PNG filter ${filter}`);
      out[i] = v & 0xff;
    }
    prev = out;
  }

  const data = new Uint8Array(width * height * 4);
  const sample = (row, x, ch) => {
    // Returns an 8-bit sample for channel `ch` of pixel `x` in `row`.
    if (bitDepth === 8) return row[x * channels + ch];
    if (bitDepth === 16) return row[(x * channels + ch) * 2];
    const bitPos = (x * channels + ch) * bitDepth;
    const byte = row[bitPos >> 3];
    const shift = 8 - bitDepth - (bitPos & 7);
    const v = (byte >> shift) & ((1 << bitDepth) - 1);
    return colorType === 3 ? v : Math.round((v * 255) / ((1 << bitDepth) - 1));
  };
  const trnsGray = trns && colorType === 0 ? trns.readUInt16BE(0) : null;
  const trnsRgb = trns && colorType === 2 ? [trns.readUInt16BE(0), trns.readUInt16BE(2), trns.readUInt16BE(4)] : null;
  for (let y = 0; y < height; y += 1) {
    const row = rows.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      if (colorType === 3) {
        const idx = sample(row, x, 0);
        if (!palette || idx * 3 + 2 >= palette.length) throw new Error('PNG palette index out of range');
        data[o] = palette[idx * 3];
        data[o + 1] = palette[idx * 3 + 1];
        data[o + 2] = palette[idx * 3 + 2];
        data[o + 3] = trns && idx < trns.length ? trns[idx] : 255;
      } else if (colorType === 0 || colorType === 4) {
        const g = sample(row, x, 0);
        data[o] = g;
        data[o + 1] = g;
        data[o + 2] = g;
        data[o + 3] = colorType === 4 ? sample(row, x, 1) : 255;
        if (trnsGray !== null && bitDepth <= 8 && Math.round((trnsGray * 255) / ((1 << bitDepth) - 1)) === g) data[o + 3] = 0;
      } else {
        data[o] = sample(row, x, 0);
        data[o + 1] = sample(row, x, 1);
        data[o + 2] = sample(row, x, 2);
        data[o + 3] = colorType === 6 ? sample(row, x, 3) : 255;
        if (trnsRgb && bitDepth === 8 && data[o] === trnsRgb[0] && data[o + 1] === trnsRgb[1] && data[o + 2] === trnsRgb[2]) data[o + 3] = 0;
      }
    }
  }
  return { width, height, data };
}

function chunk(type, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

export function encodePng({ width, height, data }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    // Sub filter compresses flat pixel-art rows far better than None.
    raw[y * (stride + 1)] = 1;
    for (let i = 0; i < stride; i += 1) {
      const v = data[y * stride + i];
      const left = i >= 4 ? data[y * stride + i - 4] : 0;
      raw[y * (stride + 1) + 1 + i] = (v - left) & 0xff;
    }
  }
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
