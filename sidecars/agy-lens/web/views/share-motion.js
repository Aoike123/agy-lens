// Pure-JS progressive MP4 (ISO BMFF) muxer, Google/Android Motion Photo XMP injector,
// and browser motion exporter.
// Zero external dependencies; code above "// --- browser-only helpers" has zero DOM/browser globals.

import { bytesToBase64 } from './share-gif.js';

export const MAX_SHARE_MOTION_BYTES = 16 * 1024 * 1024;

function writeU32BE(buf, off, val) {
  const v = val >>> 0;
  buf[off] = (v >>> 24) & 0xff;
  buf[off + 1] = (v >>> 16) & 0xff;
  buf[off + 2] = (v >>> 8) & 0xff;
  buf[off + 3] = v & 0xff;
}

function writeU16BE(buf, off, val) {
  const v = val & 0xffff;
  buf[off] = (v >>> 8) & 0xff;
  buf[off + 1] = v & 0xff;
}

function asciiBytes(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i += 1) out[i] = str.charCodeAt(i) & 0x7f;
  return out;
}

function concatBytes(parts) {
  let total = 0;
  for (const p of parts) total += p.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

function mp4Box(type, ...payloads) {
  let size = 8;
  for (const p of payloads) size += p.byteLength;
  const out = new Uint8Array(size);
  writeU32BE(out, 0, size);
  out.set(asciiBytes(type.slice(0, 4).padEnd(4, ' ')), 4);
  let off = 8;
  for (const p of payloads) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

function mp4FullBox(type, version, flags, ...payloads) {
  const hdr = new Uint8Array(4);
  hdr[0] = version & 0xff;
  hdr[1] = (flags >>> 16) & 0xff;
  hdr[2] = (flags >>> 8) & 0xff;
  hdr[3] = flags & 0xff;
  return mp4Box(type, hdr, ...payloads);
}

function toUint8Array(data, label = 'buffer') {
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new TypeError(`Invalid ${label}: expected binary buffer`);
}

function writeMatrix(buf, off) {
  const vals = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];
  for (let i = 0; i < vals.length; i += 1) writeU32BE(buf, off + i * 4, vals[i]);
}

/**
 * Mux AVCC length-prefixed H.264 frames + AVCDecoderConfigurationRecord (`avcC`)
 * into a progressive, non-fragmented ISO BMFF `.mp4` buffer.
 */
export function muxAvcToMp4({ width, height, timescale = 90000, frames, avcC } = {}) {
  if (!Number.isInteger(width) || width < 2 || width % 2 !== 0) {
    throw new RangeError(`MP4 width must be an even integer >= 2 (got ${width})`);
  }
  if (!Number.isInteger(height) || height < 2 || height % 2 !== 0) {
    throw new RangeError(`MP4 height must be an even integer >= 2 (got ${height})`);
  }
  if (!Number.isInteger(timescale) || timescale <= 0) {
    throw new RangeError(`MP4 timescale must be a positive integer (got ${timescale})`);
  }
  if (!Array.isArray(frames) || frames.length === 0) {
    throw new Error('MP4 muxer requires at least one frame');
  }

  const avcCBytes = toUint8Array(avcC, 'avcC');
  if (avcCBytes.byteLength < 7 || avcCBytes[0] !== 1) {
    throw new Error('Invalid avcC decoder configuration record');
  }

  const defaultTicks = Math.max(1, Math.round(timescale / 16));
  const normFrames = [];
  const syncSamples = [];
  let totalDuration = 0;
  let totalSampleBytes = 0;

  for (let i = 0; i < frames.length; i += 1) {
    const f = frames[i];
    const data = toUint8Array(f && f.data, `frame[${i}].data`);
    if (data.byteLength === 0) throw new Error(`Frame ${i} has empty data`);
    let ticks = defaultTicks;
    if (f && typeof f.durationTicks === 'number' && Number.isFinite(f.durationTicks) && f.durationTicks > 0) {
      ticks = Math.max(1, Math.round(f.durationTicks));
    } else if (f && typeof f.durationUs === 'number' && Number.isFinite(f.durationUs) && f.durationUs > 0) {
      ticks = Math.max(1, Math.round((f.durationUs * timescale) / 1_000_000));
    }
    normFrames.push({ data, ticks });
    totalDuration += ticks;
    totalSampleBytes += data.byteLength;
    if (i === 0 || (f && f.isKey)) syncSamples.push(i + 1);
  }

  // 1. ftyp (32 bytes)
  const ftypPayload = new Uint8Array(24);
  ftypPayload.set(asciiBytes('isom'), 0);
  writeU32BE(ftypPayload, 4, 0x00000200);
  ftypPayload.set(asciiBytes('isom'), 8);
  ftypPayload.set(asciiBytes('iso2'), 12);
  ftypPayload.set(asciiBytes('avc1'), 16);
  ftypPayload.set(asciiBytes('mp41'), 20);
  const ftyp = mp4Box('ftyp', ftypPayload);

  // 2. mvhd (version 0, 108 bytes total -> 96-byte payload)
  const mvhdBody = new Uint8Array(96);
  writeU32BE(mvhdBody, 8, timescale);
  writeU32BE(mvhdBody, 12, totalDuration);
  writeU32BE(mvhdBody, 16, 0x00010000); // rate 1.0
  writeU16BE(mvhdBody, 20, 0x0100); // volume 1.0
  writeMatrix(mvhdBody, 32);
  writeU32BE(mvhdBody, 92, 2); // next_track_ID
  const mvhd = mp4FullBox('mvhd', 0, 0, mvhdBody);

  // 3. tkhd (version 0, flags=3 enabled+in_movie, 92 bytes total -> 80-byte payload)
  const tkhdBody = new Uint8Array(80);
  writeU32BE(tkhdBody, 8, 1); // track_ID
  writeU32BE(tkhdBody, 16, totalDuration);
  // volume = 0 at offset 32..34 for video track
  writeMatrix(tkhdBody, 36);
  writeU32BE(tkhdBody, 72, (width << 16) >>> 0);
  writeU32BE(tkhdBody, 76, (height << 16) >>> 0);
  const tkhd = mp4FullBox('tkhd', 0, 0x000003, tkhdBody);

  // 4. mdhd (version 0, 32 bytes total -> 20-byte payload)
  const mdhdBody = new Uint8Array(20);
  writeU32BE(mdhdBody, 8, timescale);
  writeU32BE(mdhdBody, 12, totalDuration);
  writeU16BE(mdhdBody, 16, 0x55c4); // 'und'
  const mdhd = mp4FullBox('mdhd', 0, 0, mdhdBody);

  // 5. hdlr (vide)
  const hdlrName = asciiBytes('VideoHandler\0');
  const hdlrBody = new Uint8Array(20 + hdlrName.byteLength);
  hdlrBody.set(asciiBytes('vide'), 4);
  hdlrBody.set(hdlrName, 20);
  const hdlr = mp4FullBox('hdlr', 0, 0, hdlrBody);

  // 6. vmhd (flags=1, 20 bytes total)
  const vmhd = mp4FullBox('vmhd', 0, 0x000001, new Uint8Array(8));

  // 7. dinf -> dref -> url (flags=1 self-contained)
  const urlBox = mp4FullBox('url ', 0, 0x000001);
  const drefCount = new Uint8Array(4);
  writeU32BE(drefCount, 0, 1);
  const dref = mp4FullBox('dref', 0, 0, drefCount, urlBox);
  const dinf = mp4Box('dinf', dref);

  // 8. stsd -> avc1 -> avcC + pasp
  const avcCBox = mp4Box('avcC', avcCBytes);
  const paspBody = new Uint8Array(8);
  writeU32BE(paspBody, 0, 1);
  writeU32BE(paspBody, 4, 1);
  const paspBox = mp4Box('pasp', paspBody);

  const avc1Entry = new Uint8Array(78);
  writeU16BE(avc1Entry, 6, 1); // data_reference_index
  writeU16BE(avc1Entry, 24, width);
  writeU16BE(avc1Entry, 26, height);
  writeU32BE(avc1Entry, 28, 0x00480000); // 72 dpi horiz
  writeU32BE(avc1Entry, 32, 0x00480000); // 72 dpi vert
  writeU16BE(avc1Entry, 40, 1); // frame_count
  writeU16BE(avc1Entry, 74, 0x0018); // depth = 24
  writeU16BE(avc1Entry, 76, 0xffff); // pre_defined = -1
  const avc1 = mp4Box('avc1', avc1Entry, avcCBox, paspBox);

  const stsdCount = new Uint8Array(4);
  writeU32BE(stsdCount, 0, 1);
  const stsd = mp4FullBox('stsd', 0, 0, stsdCount, avc1);

  // 9. stts (run-length encoded sample deltas)
  const sttsRuns = [];
  for (const f of normFrames) {
    if (sttsRuns.length && sttsRuns[sttsRuns.length - 1].delta === f.ticks) {
      sttsRuns[sttsRuns.length - 1].count += 1;
    } else {
      sttsRuns.push({ count: 1, delta: f.ticks });
    }
  }
  const sttsBody = new Uint8Array(4 + sttsRuns.length * 8);
  writeU32BE(sttsBody, 0, sttsRuns.length);
  for (let i = 0; i < sttsRuns.length; i += 1) {
    writeU32BE(sttsBody, 4 + i * 8, sttsRuns[i].count);
    writeU32BE(sttsBody, 8 + i * 8, sttsRuns[i].delta);
  }
  const stts = mp4FullBox('stts', 0, 0, sttsBody);

  // 10. stss (1-based sync sample numbers)
  const stssBody = new Uint8Array(4 + syncSamples.length * 4);
  writeU32BE(stssBody, 0, syncSamples.length);
  for (let i = 0; i < syncSamples.length; i += 1) {
    writeU32BE(stssBody, 4 + i * 4, syncSamples[i]);
  }
  const stss = mp4FullBox('stss', 0, 0, stssBody);

  // 11. stsc (single chunk containing all samples)
  const stscBody = new Uint8Array(16);
  writeU32BE(stscBody, 0, 1);
  writeU32BE(stscBody, 4, 1); // first_chunk
  writeU32BE(stscBody, 8, normFrames.length); // samples_per_chunk
  writeU32BE(stscBody, 12, 1); // sample_description_index
  const stsc = mp4FullBox('stsc', 0, 0, stscBody);

  // 12. stsz
  const stszBody = new Uint8Array(8 + normFrames.length * 4);
  writeU32BE(stszBody, 0, 0); // variable sample size
  writeU32BE(stszBody, 4, normFrames.length);
  for (let i = 0; i < normFrames.length; i += 1) {
    writeU32BE(stszBody, 8 + i * 4, normFrames[i].data.byteLength);
  }
  const stsz = mp4FullBox('stsz', 0, 0, stszBody);

  // 13. stco (placeholder offset patched after moov size is known)
  const stcoBody = new Uint8Array(8);
  writeU32BE(stcoBody, 0, 1);
  writeU32BE(stcoBody, 4, 0);
  const stco = mp4FullBox('stco', 0, 0, stcoBody);

  const stbl = mp4Box('stbl', stsd, stts, stss, stsc, stsz, stco);
  const minf = mp4Box('minf', vmhd, dinf, stbl);
  const mdia = mp4Box('mdia', mdhd, hdlr, minf);
  const trak = mp4Box('trak', tkhd, mdia);
  const moov = mp4Box('moov', mvhd, trak);

  // Exact offset of first sample byte inside mdat (+8 for mdat box header)
  const chunkOffset = ftyp.byteLength + moov.byteLength + 8;
  // stco is the last child of stbl -> minf -> mdia -> trak -> moov; its single 32-bit offset is the last 4 bytes of moov
  writeU32BE(moov, moov.byteLength - 4, chunkOffset);

  const mdatHeader = new Uint8Array(8);
  writeU32BE(mdatHeader, 0, 8 + totalSampleBytes);
  mdatHeader.set(asciiBytes('mdat'), 4);

  const parts = [ftyp, moov, mdatHeader];
  for (const f of normFrames) parts.push(f.data);
  return concatBytes(parts);
}

const XMP_HEADER = 'http://ns.adobe.com/xap/1.0/\0';

function encodeUtf8(str) {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
  const s = unescape(encodeURIComponent(str));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i);
  return out;
}

function bytesMatchAscii(buf, off, str) {
  if (off + str.length > buf.byteLength) return false;
  for (let i = 0; i < str.length; i += 1) {
    if (buf[off + i] !== str.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * Inject Google/Android Motion Photo (`GCamera:MotionPhoto` + `Container:Directory`) XMP APP1
 * into a JPEG and append the progressive MP4 container directly after EOI (`FF D9`).
 */
export function injectMotionPhotoXmp(jpegBytes, mp4Bytes, opts = {}) {
  const { presentationTimestampUs = 0 } = opts || {};
  const jpeg = toUint8Array(jpegBytes, 'jpegBytes');
  const mp4 = toUint8Array(mp4Bytes, 'mp4Bytes');
  if (jpeg.byteLength < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
    throw new Error('Invalid JPEG: missing SOI (FF D8)');
  }
  if (mp4.byteLength < 12 || !bytesMatchAscii(mp4, 4, 'ftyp')) {
    throw new Error('Invalid MP4: missing ftyp box');
  }

  const rawTs = Number(presentationTimestampUs);
  const tsUs = Number.isFinite(rawTs) ? Math.max(0, Math.round(rawTs)) : 0;
  const xmpXml = [
    '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>',
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
    '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    '<rdf:Description rdf:about=""',
    ' xmlns:GCamera="http://ns.google.com/photos/1.0/camera/"',
    ' xmlns:Container="http://ns.google.com/photos/1.0/container/"',
    ' xmlns:Item="http://ns.google.com/photos/1.0/container/item/"',
    ' GCamera:MotionPhoto="1"',
    ' GCamera:MotionPhotoVersion="1"',
    ` GCamera:MotionPhotoPresentationTimestampUs="${tsUs}">`,
    '<Container:Directory><rdf:Seq>',
    '<rdf:li rdf:parseType="Resource"><Container:Item Item:Mime="image/jpeg" Item:Semantic="Primary" Item:Length="0" Item:Padding="0"/></rdf:li>',
    `<rdf:li rdf:parseType="Resource"><Container:Item Item:Mime="video/mp4" Item:Semantic="MotionPhoto" Item:Length="${mp4.byteLength}" Item:Padding="0"/></rdf:li>`,
    '</rdf:Seq></Container:Directory>',
    '</rdf:Description>',
    '</rdf:RDF>',
    '</x:xmpmeta>',
    '<?xpacket end="w"?>',
  ].join('');

  const xmpPayload = concatBytes([encodeUtf8(XMP_HEADER), encodeUtf8(xmpXml)]);
  if (xmpPayload.byteLength > 65533) {
    throw new Error(`XMP APP1 payload (${xmpPayload.byteLength}) exceeds JPEG segment limit`);
  }
  const app1Len = xmpPayload.byteLength + 2;
  const app1Seg = new Uint8Array(4 + xmpPayload.byteLength);
  app1Seg[0] = 0xff;
  app1Seg[1] = 0xe1;
  writeU16BE(app1Seg, 2, app1Len);
  app1Seg.set(xmpPayload, 4);

  // Walk JPEG markers cleanly: preserve APP0 before APP1, strip existing XMP APP1, scan SOS entropy up to EOI
  const headChunks = [jpeg.subarray(0, 2)];
  const bodyChunks = [];
  let inHead = true;
  let pos = 2;
  let foundEoi = false;

  while (pos < jpeg.byteLength) {
    if (jpeg[pos] !== 0xff) {
      throw new Error(`Corrupt JPEG marker alignment at offset ${pos}`);
    }
    while (pos < jpeg.byteLength && jpeg[pos] === 0xff) pos += 1;
    if (pos >= jpeg.byteLength) break;
    const marker = jpeg[pos];
    const segStart = pos - 1;
    pos += 1;

    if (marker === 0xd9) {
      // EOI
      bodyChunks.push(jpeg.subarray(segStart, pos));
      foundEoi = true;
      break;
    }
    if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      (inHead ? headChunks : bodyChunks).push(jpeg.subarray(segStart, pos));
      continue;
    }
    if (pos + 2 > jpeg.byteLength) {
      throw new Error(`Truncated JPEG segment at offset ${segStart}`);
    }
    const segLen = (jpeg[pos] << 8) | jpeg[pos + 1];
    const segEnd = pos + segLen;
    if (segLen < 2 || segEnd > jpeg.byteLength) {
      throw new Error(`Invalid JPEG segment length ${segLen} at offset ${segStart}`);
    }

    // Strip any pre-existing Adobe XMP APP1
    if (marker === 0xe1 && bytesMatchAscii(jpeg, pos + 2, XMP_HEADER)) {
      pos = segEnd;
      continue;
    }

    if (marker === 0xda) {
      // SOS: keep header, then scan entropy-coded data skipping FF 00 and RSTn (D0..D7)
      inHead = false;
      let scan = segEnd;
      let nextMarkerPos = -1;
      while (scan < jpeg.byteLength - 1) {
        if (jpeg[scan] === 0xff) {
          const next = jpeg[scan + 1];
          if (next === 0x00 || (next >= 0xd0 && next <= 0xd7) || next === 0xff) {
            scan += next === 0xff ? 1 : 2;
            continue;
          }
          nextMarkerPos = scan;
          break;
        }
        scan += 1;
      }
      if (nextMarkerPos === -1) {
        throw new Error('Invalid JPEG: missing EOI (FF D9) after SOS');
      }
      if (jpeg[nextMarkerPos + 1] === 0xd9) {
        bodyChunks.push(jpeg.subarray(segStart, nextMarkerPos + 2));
        foundEoi = true;
        break;
      }
      // Progressive JPEG with additional SOS/DHT/DQT after this scan
      bodyChunks.push(jpeg.subarray(segStart, nextMarkerPos));
      pos = nextMarkerPos;
      continue;
    }

    const segSlice = jpeg.subarray(segStart, segEnd);
    if (inHead && marker === 0xe0) {
      headChunks.push(segSlice);
    } else {
      inHead = false;
      bodyChunks.push(segSlice);
    }
    pos = segEnd;
  }

  if (!foundEoi) {
    throw new Error('Invalid JPEG: missing EOI (FF D9)');
  }

  return concatBytes([...headChunks, app1Seg, ...bodyChunks, mp4]);
}

// --- browser-only helpers (never called in pure Node tests) ---

let cachedCapsPromise = null;

function makeAbortError(msg = 'Motion export aborted') {
  const err = new Error(msg);
  err.name = 'AbortError';
  err.code = 'ABORTED';
  return err;
}

function checkAborted(signal) {
  if (signal && signal.aborted) throw makeAbortError();
}

function loadMotionImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = (err) => reject(err || new Error('SVG image load failed'));
    img.src = src;
  });
}

async function svgToMotionImage(svgString, signal) {
  checkAborted(signal);
  const blob = typeof Blob !== 'undefined'
    ? new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' })
    : null;
  const blobUrl = blob && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function'
    ? URL.createObjectURL(blob)
    : null;
  try {
    if (blobUrl) {
      try {
        return await loadMotionImage(blobUrl);
      } catch {
        checkAborted(signal);
        return await loadMotionImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgString)}`);
      }
    }
    return await loadMotionImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgString)}`);
  } finally {
    if (blobUrl && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
      URL.revokeObjectURL(blobUrl);
    }
  }
}

function canvasToJpegBytes(canvas, quality = 0.92) {
  return new Promise((resolve, reject) => {
    const fallbackDataUrl = () => {
      try {
        const dataUrl = canvas.toDataURL('image/jpeg', quality);
        const prefix = 'data:image/jpeg;base64,';
        if (!dataUrl.startsWith(prefix)) throw new Error('JPEG encoding unsupported');
        const bin = atob(dataUrl.slice(prefix.length));
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
        resolve(bytes);
      } catch (err) {
        reject(err);
      }
    };
    if (typeof canvas.toBlob === 'function') {
      canvas.toBlob((blob) => {
        if (!blob) {
          fallbackDataUrl();
          return;
        }
        blob.arrayBuffer().then((buf) => resolve(new Uint8Array(buf)), reject);
      }, 'image/jpeg', quality);
    } else {
      fallbackDataUrl();
    }
  });
}

/** Probe browser H.264 WebCodecs & MediaRecorder codec capabilities once and cache. */
export async function detectMotionCapabilities() {
  if (cachedCapsPromise) return cachedCapsPromise;
  cachedCapsPromise = (async () => {
    let videoEncoderAvc = false;
    let avcCodec = null;
    if (typeof VideoEncoder === 'function' && typeof VideoFrame === 'function' && typeof VideoEncoder.isConfigSupported === 'function') {
      for (const codec of ['avc1.4d002a', 'avc1.42001f', 'avc1.42E01E']) {
        try {
          const res = await VideoEncoder.isConfigSupported({
            codec,
            width: 760,
            height: 950,
            bitrate: 3_000_000,
            framerate: 16,
            avc: { format: 'avc' },
          });
          if (res && res.supported) {
            videoEncoderAvc = true;
            avcCodec = codec;
            break;
          }
        } catch { /* probe next profile */ }
      }
    }

    let recorderMp4Mime = null;
    let recorderWebmMime = null;
    if (typeof MediaRecorder === 'function' && typeof MediaRecorder.isTypeSupported === 'function') {
      for (const mime of ['video/mp4;codecs=avc1.42E01E', 'video/mp4;codecs=avc1.42001f', 'video/mp4;codecs=avc1.4d002a']) {
        try {
          if (MediaRecorder.isTypeSupported(mime)) {
            recorderMp4Mime = mime;
            break;
          }
        } catch { /* ignore */ }
      }
      for (const mime of ['video/webm;codecs=vp9', 'video/webm;codecs=vp8']) {
        try {
          if (MediaRecorder.isTypeSupported(mime)) {
            recorderWebmMime = mime;
            break;
          }
        } catch { /* ignore */ }
      }
    }

    return {
      videoEncoderAvc,
      avcCodec,
      recorderMp4: Boolean(recorderMp4Mime),
      recorderMp4Mime,
      recorderWebm: Boolean(recorderWebmMime),
      recorderWebmMime,
      supportsLivePhoto: videoEncoderAvc,
      supportsMp4: videoEncoderAvc || Boolean(recorderMp4Mime),
      supportsWebm: Boolean(recorderWebmMime),
    };
  })();
  return cachedCapsPromise;
}

async function encodeViaVideoEncoder({
  canvas,
  ctx,
  outW,
  outH,
  count,
  safeFps,
  avcCodec,
  bitrate,
  wantMotionPhoto,
  coverFrameIndex,
  jpegQuality,
  drawFrameAt,
  onProgress,
  signal,
}) {
  const timescale = 90000;
  const frameDurationUs = Math.round(1_000_000 / safeFps);
  const frameDurationTicks = Math.max(1, Math.round(timescale / safeFps));
  const encodedFrames = [];
  let avcC = null;
  let encoderError = null;

  const encoder = new VideoEncoder({
    output(chunk, meta) {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      if (!avcC && meta && meta.decoderConfig && meta.decoderConfig.description) {
        avcC = toUint8Array(meta.decoderConfig.description, 'decoderConfig.description');
      }
      encodedFrames.push({
        data,
        isKey: chunk.type === 'key',
        durationTicks: frameDurationTicks,
      });
    },
    error(err) {
      encoderError = err || new Error('VideoEncoder failed');
    },
  });

  let coverJpeg = null;
  try {
    encoder.configure({
      codec: avcCodec,
      width: outW,
      height: outH,
      bitrate,
      framerate: safeFps,
      avc: { format: 'avc' },
    });

    const clampedCover = Math.max(0, Math.min(count - 1, Math.round(coverFrameIndex)));
    for (let f = 0; f < count; f += 1) {
      checkAborted(signal);
      if (encoderError) throw encoderError;
      const phase = count > 1 ? f / count : 0;
      await drawFrameAt(ctx, phase, f);
      checkAborted(signal);

      if (wantMotionPhoto && f === clampedCover) {
        coverJpeg = await canvasToJpegBytes(canvas, jpegQuality);
        checkAborted(signal);
      }

      const vf = new VideoFrame(canvas, {
        timestamp: f * frameDurationUs,
        duration: frameDurationUs,
      });
      try {
        encoder.encode(vf, { keyFrame: f === 0 || f % safeFps === 0 });
      } finally {
        vf.close();
      }

      if (typeof onProgress === 'function') {
        onProgress(Math.min(90, Math.round(((f + 1) / count) * 85)), 'encode');
      }
      if (f % 3 === 2) await new Promise((r) => setTimeout(r, 0));
    }

    await encoder.flush();
    if (encoderError) throw encoderError;
  } finally {
    try {
      if (encoder.state !== 'closed') encoder.close();
    } catch { /* ignore */ }
  }

  checkAborted(signal);
  if (!avcC || !encodedFrames.length) {
    throw new Error('H.264 encoder produced no avcC or frames');
  }
  const mp4Bytes = muxAvcToMp4({
    width: outW,
    height: outH,
    timescale,
    frames: encodedFrames,
    avcC,
  });

  if (typeof onProgress === 'function') onProgress(95, 'mux');
  if (wantMotionPhoto) {
    if (!coverJpeg) throw new Error('Motion Photo cover JPEG missing');
    const presentationTimestampUs = Math.max(0, Math.min(count - 1, Math.round(coverFrameIndex))) * frameDurationUs;
    return {
      bytes: injectMotionPhotoXmp(coverJpeg, mp4Bytes, { presentationTimestampUs }),
      mime: 'image/jpeg',
      ext: 'jpg',
      kind: 'jpg',
    };
  }
  return {
    bytes: mp4Bytes,
    mime: 'video/mp4',
    ext: 'mp4',
    kind: 'mp4',
  };
}

async function encodeViaMediaRecorder({
  canvas,
  ctx,
  outW,
  outH,
  count,
  safeFps,
  mimeType,
  ext,
  kind,
  bitrate,
  drawFrameAt,
  onProgress,
  signal,
}) {
  if (typeof MediaRecorder !== 'function' || typeof canvas.captureStream !== 'function') {
    throw new Error('MediaRecorder capture unavailable');
  }
  const bitmaps = [];
  const canBitmap = typeof createImageBitmap === 'function';
  try {
    for (let f = 0; f < count; f += 1) {
      checkAborted(signal);
      const phase = count > 1 ? f / count : 0;
      await drawFrameAt(ctx, phase, f);
      checkAborted(signal);
      if (canBitmap) {
        bitmaps.push(await createImageBitmap(canvas));
      } else {
        const snap = document.createElement('canvas');
        snap.width = outW;
        snap.height = outH;
        const sctx = snap.getContext('2d');
        if (sctx) sctx.drawImage(canvas, 0, 0);
        bitmaps.push(snap);
      }
      if (typeof onProgress === 'function') {
        onProgress(Math.min(50, Math.round(((f + 1) / count) * 50)), 'rasterize');
      }
      if (f % 3 === 2) await new Promise((r) => setTimeout(r, 0));
    }

    const stream = canvas.captureStream(0);
    const track = stream.getVideoTracks()[0];
    const chunks = [];
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: bitrate });

    const donePromise = new Promise((resolve, reject) => {
      recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) chunks.push(ev.data);
      };
      recorder.onerror = (ev) => reject(ev.error || new Error('MediaRecorder error'));
      recorder.onstop = () => resolve();
    });

    try {
      recorder.start();
      const stepMs = Math.max(16, Math.round(1000 / safeFps));
      for (let f = 0; f < bitmaps.length; f += 1) {
        checkAborted(signal);
        ctx.clearRect(0, 0, outW, outH);
        ctx.drawImage(bitmaps[f], 0, 0, outW, outH);
        if (track && typeof track.requestFrame === 'function') track.requestFrame();
        if (typeof onProgress === 'function') {
          onProgress(50 + Math.round(((f + 1) / bitmaps.length) * 45), 'record');
        }
        await new Promise((r) => setTimeout(r, stepMs));
      }
      recorder.stop();
      await donePromise;
    } finally {
      try {
        if (recorder.state !== 'inactive') recorder.stop();
      } catch { /* ignore */ }
      for (const trk of stream.getTracks()) {
        try { trk.stop(); } catch { /* ignore */ }
      }
    }

    const blob = new Blob(chunks, { type: mimeType.split(';')[0] });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return {
      bytes,
      mime: mimeType.split(';')[0],
      ext,
      kind,
    };
  } finally {
    for (const bm of bitmaps) {
      if (bm && typeof bm.close === 'function') {
        try { bm.close(); } catch { /* ignore */ }
      }
    }
  }
}

/**
 * Rasterize animated SVG or canvas frames into Motion Photo (.jpg), MP4 (.mp4), or WebM (.webm).
 */
export async function rasterizeSvgFramesToMotion({
  renderSvgAtPhase = null,
  renderCanvasAtPhase = null,
  width,
  height,
  frameCount = 48,
  fps = 16,
  format = 'live',
  coverFrameIndex = 0,
  jpegQuality = 0.92,
  bitrate = 3_000_000,
  onProgress = null,
  signal = null,
} = {}) {
  if (typeof renderSvgAtPhase !== 'function' && typeof renderCanvasAtPhase !== 'function') {
    throw new Error('renderSvgAtPhase or renderCanvasAtPhase function required');
  }
  checkAborted(signal);

  const reqFmt = format === 'motion-photo' ? 'live' : String(format || 'live');
  if (!['live', 'mp4', 'webm'].includes(reqFmt)) {
    throw new Error(`Unsupported motion format: ${format}`);
  }

  const caps = await detectMotionCapabilities();
  checkAborted(signal);

  const count = Math.max(1, Math.round(frameCount));
  const safeFps = Math.max(1, Math.round(fps));
  const outW = Math.max(2, Math.round(width) & ~1);
  const outH = Math.max(2, Math.round(height) & ~1);

  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) || canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  ctx.imageSmoothingEnabled = typeof renderCanvasAtPhase !== 'function';
  if (ctx.imageSmoothingEnabled) ctx.imageSmoothingQuality = 'high';

  const drawFrameAt = async (targetCtx, phase, frameIndex) => {
    if (typeof renderCanvasAtPhase === 'function') {
      await renderCanvasAtPhase(targetCtx, phase, frameIndex, outW, outH);
      return;
    }
    const svg = String(renderSvgAtPhase(phase, frameIndex) || '');
    const img = await svgToMotionImage(svg, signal);
    targetCtx.clearRect(0, 0, outW, outH);
    targetCtx.drawImage(img, 0, 0, outW, outH);
  };

  let encoded;
  if ((reqFmt === 'live' || reqFmt === 'mp4') && caps.videoEncoderAvc && caps.avcCodec) {
    encoded = await encodeViaVideoEncoder({
      canvas,
      ctx,
      outW,
      outH,
      count,
      safeFps,
      avcCodec: caps.avcCodec,
      bitrate,
      wantMotionPhoto: reqFmt === 'live',
      coverFrameIndex,
      jpegQuality,
      drawFrameAt,
      onProgress,
      signal,
    });
  } else if (reqFmt === 'mp4' && caps.recorderMp4 && caps.recorderMp4Mime) {
    encoded = await encodeViaMediaRecorder({
      canvas,
      ctx,
      outW,
      outH,
      count,
      safeFps,
      mimeType: caps.recorderMp4Mime,
      ext: 'mp4',
      kind: 'mp4',
      bitrate,
      drawFrameAt,
      onProgress,
      signal,
    });
  } else if (reqFmt === 'webm' && caps.recorderWebm && caps.recorderWebmMime) {
    encoded = await encodeViaMediaRecorder({
      canvas,
      ctx,
      outW,
      outH,
      count,
      safeFps,
      mimeType: caps.recorderWebmMime,
      ext: 'webm',
      kind: 'webm',
      bitrate,
      drawFrameAt,
      onProgress,
      signal,
    });
  } else {
    const err = new Error(`Motion format ${reqFmt} unsupported in this browser`);
    err.code = 'MOTION_UNSUPPORTED';
    throw err;
  }

  checkAborted(signal);
  if (encoded.bytes.byteLength > MAX_SHARE_MOTION_BYTES) {
    const err = new Error(`Motion export (${encoded.bytes.byteLength} bytes) exceeds 16 MB limit`);
    err.code = 'MOTION_TOO_LARGE';
    throw err;
  }

  if (typeof onProgress === 'function') onProgress(100, 'done');
  const blob = typeof Blob !== 'undefined' ? new Blob([encoded.bytes], { type: encoded.mime }) : null;
  const base64 = bytesToBase64(encoded.bytes);
  return {
    bytes: encoded.bytes,
    blob,
    base64,
    mime: encoded.mime,
    ext: encoded.ext,
    kind: encoded.kind,
    width: outW,
    height: outH,
    frameCount: count,
    fps: safeFps,
  };
}
