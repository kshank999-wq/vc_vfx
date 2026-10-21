import { deflateSync, inflateSync } from 'node:zlib';

/**
 * PNG for mattes (addendum 04): greyscale, 8- or 16-bit, written with
 * node:zlib — the format every compositor reads for an alpha sequence. The
 * reader handles what this writer and ffmpeg produce: greyscale or RGB(A),
 * 8 or 16 bits, all five row filters, no interlace.
 */

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

export interface GreyImage {
  width: number;
  height: number;
  bitDepth: 8 | 16;
  /** One value per pixel: 0…255 for 8-bit, 0…65535 for 16-bit. */
  data: Uint8Array | Uint16Array;
}

/** Greyscale PNG. Rows are filtered with Up, which suits mattes (long flat runs). */
export function encodePng(img: GreyImage, options: { level?: number; text?: Record<string, string> } = {}): Buffer {
  const { width: w, height: h, bitDepth } = img;
  const bpp = bitDepth === 16 ? 2 : 1;
  const stride = w * bpp;
  const raw = Buffer.alloc((stride + 1) * h);
  const row = Buffer.alloc(stride);
  const prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y += 1) {
    if (bitDepth === 16) for (let x = 0; x < w; x += 1) row.writeUInt16BE(img.data[y * w + x]!, x * 2);
    else for (let x = 0; x < w; x += 1) row[x] = img.data[y * w + x]!;
    const at = y * (stride + 1);
    raw[at] = 2; // Up
    for (let i = 0; i < stride; i += 1) raw[at + 1 + i] = (row[i]! - prev[i]!) & 0xff;
    row.copy(prev);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = 0; // greyscale
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const texts = Object.entries(options.text ?? {}).map(([k, v]) => chunk('tEXt', Buffer.concat([Buffer.from(k, 'latin1'), Buffer.from([0]), Buffer.from(v, 'latin1')])));
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), ...texts, chunk('IDAT', deflateSync(raw, { level: options.level ?? 6 })), chunk('IEND', Buffer.alloc(0))]);
}

/** RGB (8-bit) PNG, for previews and debugging. */
export function encodePngRgb(width: number, height: number, rgb: Uint8Array | Uint8ClampedArray): Buffer {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** RGB 16-bit PNG (values 0…65535, interleaved), for plates kept in code values (clean plates of an unknown encoding). */
export function encodePngRgb16(width: number, height: number, rgb: Uint16Array, options: { text?: Record<string, string> } = {}): Buffer {
  const stride = width * 6;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const at = y * (stride + 1);
    raw[at] = 0;
    for (let i = 0; i < width * 3; i += 1) raw.writeUInt16BE(rgb[y * width * 3 + i]!, at + 1 + 2 * i);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 16;
  ihdr[9] = 2;
  const texts = Object.entries(options.text ?? {}).map(([k, v]) => chunk('tEXt', Buffer.concat([Buffer.from(k, 'latin1'), Buffer.from([0]), Buffer.from(v, 'latin1')])));
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), ...texts, chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const paeth = (a: number, b: number, c: number) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/** Decode a PNG to greyscale (the first channel of RGB/RGBA). */
export function decodePng(buf: Uint8Array): GreyImage {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (!b.subarray(0, 8).equals(SIGNATURE)) throw new Error('Not a PNG');
  let at = 8;
  let w = 0;
  let h = 0;
  let depth = 8;
  let colour = 0;
  const idat: Buffer[] = [];
  while (at < b.length) {
    const len = b.readUInt32BE(at);
    const type = b.toString('ascii', at + 4, at + 8);
    const data = b.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      depth = data[8]!;
      colour = data[9]!;
      if (data[12] !== 0) throw new Error('Interlaced PNGs are not read');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    at += 12 + len;
  }
  if (depth !== 8 && depth !== 16) throw new Error(`PNG bit depth ${depth} is not read`);
  const channels = colour === 0 ? 1 : colour === 2 ? 3 : colour === 4 ? 2 : colour === 6 ? 4 : 0;
  if (!channels) throw new Error('Palette PNGs are not read');
  const bpp = channels * (depth / 8);
  const stride = w * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  const out = depth === 16 ? new Uint16Array(w * h) : new Uint8Array(w * h);
  let prev = Buffer.alloc(stride);
  const cur = Buffer.alloc(stride);
  for (let y = 0; y < h; y += 1) {
    const f = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i += 1) {
      const a = i >= bpp ? cur[i - bpp]! : 0;
      const up = prev[i]!;
      const c = i >= bpp ? prev[i - bpp]! : 0;
      const x = line[i]!;
      cur[i] = (f === 0 ? x : f === 1 ? x + a : f === 2 ? x + up : f === 3 ? x + ((a + up) >> 1) : paeth(a, up, c) + x) & 0xff;
    }
    for (let x = 0; x < w; x += 1) out[y * w + x] = depth === 16 ? cur.readUInt16BE(x * bpp) : cur[x * bpp]!;
    prev = Buffer.from(cur);
  }
  return { width: w, height: h, bitDepth: depth as 8 | 16, data: out };
}
