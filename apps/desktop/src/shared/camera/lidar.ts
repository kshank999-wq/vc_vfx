import type { LidarFormat } from '@vcvfx/domain';

/**
 * LiDAR, mesh and survey import (master spec §10.2; addendum 06 §5). Pure
 * TypeScript over bytes, so the desktop (from disk) and the browser preview
 * (a bundled sample) read the same way.
 *
 *  - PLY: ascii, binary_little_endian, binary_big_endian; vertex x/y/z (float,
 *    double or integer types) and optional red/green/blue; faces ignored.
 *  - OBJ: `v x y z [r g b]` lines; faces ignored (the vertices are the cloud).
 *  - CSV survey points: `name,x,y,z` (a header row is skipped).
 *  - XYZ / PTS: `x y z [intensity] [r g b]` per line; PTS starts with a count.
 *  - LAS 1.2–1.4, point data formats 0–3 (X/Y/Z scaled integers, RGB in 2/3).
 *    Compressed LAZ is not read.
 *  - E57 (ASTM E2807): the paged physical layout with a CRC-32C per 1024-byte
 *    page (checked), the XML section, and each data3D scan's CompressedVector
 *    binary section — Float (single/double) and Integer/ScaledInteger
 *    (bit-packed) cartesian and colour fields — with the scan's pose applied.
 *    Spherical-only scans and E57 images are not read.
 *
 * Positions are kept relative to an `origin` (Float64) so survey-sized
 * coordinates (hundreds of km) keep millimetre precision in Float32.
 */

export interface PointCloud {
  /** Relative to `origin`. */
  positions: Float32Array;
  colors: Uint8Array | null;
  origin: [number, number, number];
  count: number;
  /** Named survey points (CSV), absolute. */
  named: { name: string; X: [number, number, number] }[];
  bbox: { min: [number, number, number]; max: [number, number, number] };
  notes: string[];
}

export class LidarError extends Error {}

export function formatFromName(name: string): LidarFormat | null {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  return (['ply', 'obj', 'e57', 'las', 'xyz', 'pts', 'csv'] as const).find((f) => f === ext) ?? (ext === 'txt' ? 'xyz' : null);
}

/** Build a cloud from absolute coordinates (Float64), choosing the origin. */
function cloudFrom(abs: Float64Array, colors: Uint8Array | null, notes: string[], named: PointCloud['named'] = []): PointCloud {
  const n = abs.length / 3;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i += 1)
    for (let k = 0; k < 3; k += 1) {
      const v = abs[3 * i + k]!;
      if (v < min[k]!) min[k] = v;
      if (v > max[k]!) max[k] = v;
    }
  for (const p of named)
    for (let k = 0; k < 3; k += 1) {
      min[k] = Math.min(min[k]!, p.X[k]!);
      max[k] = Math.max(max[k]!, p.X[k]!);
    }
  if (!Number.isFinite(min[0])) throw new LidarError('The file has no points');
  const origin: [number, number, number] = [Math.round((min[0] + max[0]) / 2), Math.round((min[1] + max[1]) / 2), Math.round((min[2] + max[2]) / 2)];
  const positions = new Float32Array(abs.length);
  for (let i = 0; i < n; i += 1) for (let k = 0; k < 3; k += 1) positions[3 * i + k] = abs[3 * i + k]! - origin[k]!;
  return { positions, colors, origin, count: n, named, bbox: { min, max }, notes };
}

const decoder = new TextDecoder('utf-8');

function lines(bytes: Uint8Array): string[] {
  return decoder.decode(bytes).split(/\r?\n/);
}

// ---------------------------------------------------------------------------
// PLY
// ---------------------------------------------------------------------------

const PLY_TYPES: Record<string, { size: number; get: (dv: DataView, o: number, le: boolean) => number }> = {
  char: { size: 1, get: (dv, o) => dv.getInt8(o) },
  int8: { size: 1, get: (dv, o) => dv.getInt8(o) },
  uchar: { size: 1, get: (dv, o) => dv.getUint8(o) },
  uint8: { size: 1, get: (dv, o) => dv.getUint8(o) },
  short: { size: 2, get: (dv, o, le) => dv.getInt16(o, le) },
  int16: { size: 2, get: (dv, o, le) => dv.getInt16(o, le) },
  ushort: { size: 2, get: (dv, o, le) => dv.getUint16(o, le) },
  uint16: { size: 2, get: (dv, o, le) => dv.getUint16(o, le) },
  int: { size: 4, get: (dv, o, le) => dv.getInt32(o, le) },
  int32: { size: 4, get: (dv, o, le) => dv.getInt32(o, le) },
  uint: { size: 4, get: (dv, o, le) => dv.getUint32(o, le) },
  uint32: { size: 4, get: (dv, o, le) => dv.getUint32(o, le) },
  float: { size: 4, get: (dv, o, le) => dv.getFloat32(o, le) },
  float32: { size: 4, get: (dv, o, le) => dv.getFloat32(o, le) },
  double: { size: 8, get: (dv, o, le) => dv.getFloat64(o, le) },
  float64: { size: 8, get: (dv, o, le) => dv.getFloat64(o, le) },
};

export function parsePly(bytes: Uint8Array): PointCloud {
  // Header: ASCII up to "end_header\n".
  const head = decoder.decode(bytes.subarray(0, Math.min(bytes.length, 65536)));
  const endIdx = head.indexOf('end_header');
  if (!head.startsWith('ply') || endIdx < 0) throw new LidarError('Not a PLY file (no "ply" … "end_header")');
  const headerEnd = head.indexOf('\n', endIdx) + 1;
  const headerLines = head.slice(0, headerEnd).split(/\r?\n/);
  let format = '';
  interface Prop {
    name: string;
    type: string;
    list?: { count: string; item: string };
  }
  const elements: { name: string; count: number; props: Prop[] }[] = [];
  for (const l of headerLines) {
    const t = l.trim().split(/\s+/);
    if (t[0] === 'format') format = t[1] ?? '';
    else if (t[0] === 'element') elements.push({ name: t[1]!, count: Number(t[2]), props: [] });
    else if (t[0] === 'property') {
      const el = elements[elements.length - 1];
      if (!el) throw new LidarError('PLY property before any element');
      if (t[1] === 'list') el.props.push({ name: t[4]!, type: 'list', list: { count: t[2]!, item: t[3]! } });
      else el.props.push({ name: t[2]!, type: t[1]! });
    }
  }
  const vertex = elements.find((e) => e.name === 'vertex');
  if (!vertex) throw new LidarError('The PLY file has no vertex element');
  const ix = vertex.props.findIndex((p) => p.name === 'x');
  const iy = vertex.props.findIndex((p) => p.name === 'y');
  const iz = vertex.props.findIndex((p) => p.name === 'z');
  if (ix < 0 || iy < 0 || iz < 0) throw new LidarError('The PLY vertices have no x, y, z');
  const ir = vertex.props.findIndex((p) => p.name === 'red' || p.name === 'r' || p.name === 'diffuse_red');
  const ig = vertex.props.findIndex((p) => p.name === 'green' || p.name === 'g' || p.name === 'diffuse_green');
  const ib = vertex.props.findIndex((p) => p.name === 'blue' || p.name === 'b' || p.name === 'diffuse_blue');
  const hasColor = ir >= 0 && ig >= 0 && ib >= 0;
  const colorScale = hasColor && /float|double/.test(vertex.props[ir]!.type) ? 255 : hasColor && /short|16/.test(vertex.props[ir]!.type) ? 1 / 257 : 1;
  const n = vertex.count;
  const abs = new Float64Array(3 * n);
  const colors = hasColor ? new Uint8Array(3 * n) : null;
  const notes: string[] = [];
  if (format === 'ascii') {
    const body = decoder.decode(bytes.subarray(headerEnd)).split(/\r?\n/);
    // Elements come in header order; skip those before the vertices.
    let lineNo = 0;
    for (const el of elements) {
      if (el === vertex) break;
      lineNo += el.count;
    }
    for (let i = 0; i < n; i += 1) {
      const t = (body[lineNo + i] ?? '').trim().split(/\s+/).map(Number);
      abs[3 * i] = t[ix]!;
      abs[3 * i + 1] = t[iy]!;
      abs[3 * i + 2] = t[iz]!;
      if (colors) {
        colors[3 * i] = Math.max(0, Math.min(255, Math.round(t[ir]! * colorScale)));
        colors[3 * i + 1] = Math.max(0, Math.min(255, Math.round(t[ig]! * colorScale)));
        colors[3 * i + 2] = Math.max(0, Math.min(255, Math.round(t[ib]! * colorScale)));
      }
    }
  } else if (format === 'binary_little_endian' || format === 'binary_big_endian') {
    const le = format === 'binary_little_endian';
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let o = headerEnd;
    const skipElement = (el: (typeof elements)[number]) => {
      for (let i = 0; i < el.count; i += 1)
        for (const p of el.props) {
          if (p.list) {
            const c = PLY_TYPES[p.list.count]!;
            const cnt = c.get(dv, o, le);
            o += c.size + cnt * PLY_TYPES[p.list.item]!.size;
          } else o += PLY_TYPES[p.type]!.size;
        }
    };
    for (const el of elements) {
      if (el === vertex) break;
      skipElement(el);
    }
    const offs: number[] = [];
    let stride = 0;
    for (const p of vertex.props) {
      if (p.list) throw new LidarError('List properties on PLY vertices are not supported');
      const t = PLY_TYPES[p.type];
      if (!t) throw new LidarError(`Unknown PLY type ${p.type}`);
      offs.push(stride);
      stride += t.size;
    }
    if (o + stride * n > bytes.length) throw new LidarError('The PLY file is shorter than its header says');
    const get = (i: number, pi: number) => PLY_TYPES[vertex.props[pi]!.type]!.get(dv, o + i * stride + offs[pi]!, le);
    for (let i = 0; i < n; i += 1) {
      abs[3 * i] = get(i, ix);
      abs[3 * i + 1] = get(i, iy);
      abs[3 * i + 2] = get(i, iz);
      if (colors) {
        colors[3 * i] = Math.max(0, Math.min(255, Math.round(get(i, ir) * colorScale)));
        colors[3 * i + 1] = Math.max(0, Math.min(255, Math.round(get(i, ig) * colorScale)));
        colors[3 * i + 2] = Math.max(0, Math.min(255, Math.round(get(i, ib) * colorScale)));
      }
    }
  } else throw new LidarError(`Unknown PLY format ${format}`);
  if (elements.some((e) => e.name === 'face' && e.count > 0)) notes.push('Mesh faces ignored: the vertices are used as the cloud');
  return cloudFrom(abs, colors, notes);
}

// ---------------------------------------------------------------------------
// OBJ, CSV, XYZ/PTS
// ---------------------------------------------------------------------------

export function parseObj(bytes: Uint8Array): PointCloud {
  const xyz: number[] = [];
  const rgb: number[] = [];
  let colored = true;
  let faces = 0;
  for (const l of lines(bytes)) {
    if (l.startsWith('v ')) {
      const t = l.slice(2).trim().split(/\s+/).map(Number);
      xyz.push(t[0]!, t[1]!, t[2]!);
      if (t.length >= 6) rgb.push(...[t[3]!, t[4]!, t[5]!].map((c) => Math.round((c <= 1 ? c * 255 : c))));
      else colored = false;
    } else if (l.startsWith('f ')) faces += 1;
  }
  return cloudFrom(Float64Array.from(xyz), colored && rgb.length === xyz.length ? Uint8Array.from(rgb) : null, faces ? [`${faces} faces ignored: the vertices are used as the cloud`] : []);
}

export function parseSurveyCsv(bytes: Uint8Array): PointCloud {
  const named: PointCloud['named'] = [];
  for (const l of lines(bytes)) {
    const t = l.split(/[,;\t]/).map((s) => s.trim());
    if (t.length < 4) continue;
    const [name, x, y, z] = t as [string, string, string, string];
    const X = [Number(x), Number(y), Number(z)];
    if (X.some((v) => !Number.isFinite(v))) continue; // header or comment
    named.push({ name: name.replace(/^"|"$/g, ''), X: X as [number, number, number] });
  }
  if (!named.length) throw new LidarError('No survey points found: expected name,x,y,z rows');
  const abs = Float64Array.from(named.flatMap((p) => p.X));
  return cloudFrom(abs, null, [`${named.length} survey points`], named);
}

export function parseXyz(bytes: Uint8Array, pts = false): PointCloud {
  const ls = lines(bytes);
  const xyz: number[] = [];
  const rgb: number[] = [];
  let colored = true;
  let start = 0;
  if (pts && /^\s*\d+\s*$/.test(ls[0] ?? '')) start = 1;
  for (let i = start; i < ls.length; i += 1) {
    const t = ls[i]!.trim().split(/[\s,;]+/).map(Number);
    if (t.length < 3 || t.slice(0, 3).some((v) => !Number.isFinite(v))) continue;
    xyz.push(t[0]!, t[1]!, t[2]!);
    // x y z r g b, or x y z i r g b (PTS).
    const c = t.length >= 7 ? t.slice(4, 7) : t.length === 6 ? t.slice(3, 6) : null;
    if (c) rgb.push(...c.map((v) => Math.max(0, Math.min(255, Math.round(v)))));
    else colored = false;
  }
  return cloudFrom(Float64Array.from(xyz), colored && rgb.length === xyz.length ? Uint8Array.from(rgb) : null, []);
}

// ---------------------------------------------------------------------------
// LAS 1.2 – 1.4, point formats 0 – 3
// ---------------------------------------------------------------------------

const LAS_RECORD_MIN = [20, 28, 26, 34];

export function parseLas(bytes: Uint8Array): PointCloud {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (decoder.decode(bytes.subarray(0, 4)) !== 'LASF') throw new LidarError('Not a LAS file (no LASF signature)');
  const major = dv.getUint8(24);
  const minor = dv.getUint8(25);
  if (major !== 1 || minor < 0 || minor > 4) throw new LidarError(`LAS ${major}.${minor} is not supported (1.0 – 1.4)`);
  const offsetToPoints = dv.getUint32(96, true);
  const formatByte = dv.getUint8(104);
  if (formatByte & 0xc0) throw new LidarError('Compressed (LAZ) point data is not read; decompress it to LAS first');
  const format = formatByte & 0x3f;
  if (format > 3) throw new LidarError(`LAS point data format ${format} is not supported (0 – 3)`);
  const recordLength = dv.getUint16(105, true);
  if (recordLength < LAS_RECORD_MIN[format]!) throw new LidarError('LAS point records are shorter than their format');
  let count = dv.getUint32(107, true);
  if (minor >= 4 && count === 0) count = Number(dv.getBigUint64(247, true));
  const sx = dv.getFloat64(131, true);
  const sy = dv.getFloat64(139, true);
  const sz = dv.getFloat64(147, true);
  const ox = dv.getFloat64(155, true);
  const oy = dv.getFloat64(163, true);
  const oz = dv.getFloat64(171, true);
  if (offsetToPoints + count * recordLength > bytes.length) throw new LidarError('The LAS file is shorter than its header says');
  const abs = new Float64Array(3 * count);
  const hasRgb = format === 2 || format === 3;
  const colors = hasRgb ? new Uint8Array(3 * count) : null;
  const rgbAt = format === 2 ? 20 : 28;
  let maxC = 0;
  for (let i = 0; i < count; i += 1) {
    const o = offsetToPoints + i * recordLength;
    abs[3 * i] = dv.getInt32(o, true) * sx + ox;
    abs[3 * i + 1] = dv.getInt32(o + 4, true) * sy + oy;
    abs[3 * i + 2] = dv.getInt32(o + 8, true) * sz + oz;
    if (colors) for (let k = 0; k < 3; k += 1) maxC = Math.max(maxC, dv.getUint16(o + rgbAt + 2 * k, true));
  }
  if (colors) {
    // LAS stores 16-bit colour; some writers put 8-bit values in it.
    const shift = maxC > 255 ? 8 : 0;
    for (let i = 0; i < count; i += 1) {
      const o = offsetToPoints + i * recordLength + rgbAt;
      for (let k = 0; k < 3; k += 1) colors[3 * i + k] = dv.getUint16(o + 2 * k, true) >> shift;
    }
  }
  return cloudFrom(abs, colors, [`LAS ${major}.${minor}, point format ${format}`]);
}

// ---------------------------------------------------------------------------
// E57
// ---------------------------------------------------------------------------

const CRC32C_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32c(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i += 1) c = CRC32C_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface E57Field {
  name: string;
  type: 'Float' | 'Integer' | 'ScaledInteger';
  precision: 'single' | 'double';
  min: number;
  max: number;
  scale: number;
  offset: number;
  bits: number;
}

/** Logical reading over E57's paged physical layout. */
class E57Pages {
  readonly page: number;
  readonly payload: number;
  constructor(
    readonly bytes: Uint8Array,
    page: number,
  ) {
    this.page = page;
    this.payload = page - 4;
  }
  logicalOf(physical: number): number {
    return Math.floor(physical / this.page) * this.payload + (physical % this.page);
  }
  read(logical: number, length: number): Uint8Array {
    const out = new Uint8Array(length);
    let done = 0;
    let l = logical;
    while (done < length) {
      const page = Math.floor(l / this.payload);
      const within = l % this.payload;
      const take = Math.min(this.payload - within, length - done);
      const p = page * this.page + within;
      if (p + take > this.bytes.length) throw new LidarError('The E57 file ends early');
      out.set(this.bytes.subarray(p, p + take), done);
      done += take;
      l += take;
    }
    return out;
  }
  /** Check every page's CRC-32C (stored big-endian in its last 4 bytes). Returns pages that fail. */
  check(): number {
    let bad = 0;
    const pages = Math.floor(this.bytes.length / this.page);
    for (let i = 0; i < pages; i += 1) {
      const o = i * this.page;
      const want = ((this.bytes[o + this.payload]! << 24) | (this.bytes[o + this.payload + 1]! << 16) | (this.bytes[o + this.payload + 2]! << 8) | this.bytes[o + this.payload + 3]!) >>> 0;
      if (crc32c(this.bytes, o, o + this.payload) !== want) bad += 1;
    }
    return bad;
  }
}

/** A tiny XML reader: enough for E57's element tree (attributes and text). */
interface XNode {
  name: string;
  attrs: Record<string, string>;
  children: XNode[];
  text: string;
}

export function parseXml(xml: string): XNode {
  const root: XNode = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const top = stack[stack.length - 1]!;
    if (m[1] !== undefined) top.text += m[1];
    else if (m[3]) {
      if (m[2] === '/') {
        if (stack.length > 1) stack.pop();
        continue;
      }
      const attrs: Record<string, string> = {};
      for (const a of (m[4] ?? '').matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]!] = (a[2] ?? a[3] ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
      const node: XNode = { name: m[3], attrs, children: [], text: '' };
      top.children.push(node);
      if (m[5] !== '/') stack.push(node);
    } else if (m[6]) top.text += m[6];
  }
  return root;
}

const child = (n: XNode | undefined, name: string) => n?.children.find((c) => c.name === name);
const numText = (n: XNode | undefined, fallback: number) => (n && n.text.trim() !== '' ? Number(n.text.trim()) : fallback);

export function parseE57(bytes: Uint8Array, options: { maxPoints?: number } = {}): PointCloud {
  if (decoder.decode(bytes.subarray(0, 8)) !== 'ASTM-E57') throw new LidarError('Not an E57 file (no ASTM-E57 signature)');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const major = dv.getUint32(8, true);
  const xmlPhysical = Number(dv.getBigUint64(24, true));
  const xmlLength = Number(dv.getBigUint64(32, true));
  const pageSize = Number(dv.getBigUint64(40, true)) || 1024;
  if (major !== 1) throw new LidarError(`E57 version ${major} is not supported`);
  const pages = new E57Pages(bytes, pageSize);
  const notes: string[] = [];
  const bad = pages.check();
  if (bad) throw new LidarError(`${bad} page${bad === 1 ? '' : 's'} of the E57 file fail the CRC-32C check: the file is damaged`);
  const xml = parseXml(decoder.decode(pages.read(pages.logicalOf(xmlPhysical), xmlLength)));
  const e57Root = child(xml, 'e57Root');
  const data3D = child(e57Root, 'data3D');
  const scans = data3D?.children.filter((c) => c.name === 'vectorChild') ?? [];
  if (!scans.length) throw new LidarError('The E57 file has no 3D scans (data3D)');
  const absAll: number[] = [];
  const colAll: number[] = [];
  let anyColor = false;
  let allColor = true;
  const maxPoints = options.maxPoints ?? 20_000_000;
  for (const scan of scans) {
    const points = child(scan, 'points');
    const proto = child(points, 'prototype');
    if (!points || !proto) continue;
    const fields: E57Field[] = proto.children.map((f) => {
      const type = (f.attrs['type'] ?? 'Float') as E57Field['type'];
      const min = Number(f.attrs['minimum'] ?? (type === 'Float' ? -Infinity : 0));
      const max = Number(f.attrs['maximum'] ?? (type === 'Float' ? Infinity : 0));
      const bits = type === 'Float' ? 0 : Math.ceil(Math.log2(max - min + 1));
      return { name: f.name, type, precision: (f.attrs['precision'] ?? 'double') as 'single' | 'double', min, max, scale: Number(f.attrs['scale'] ?? 1), offset: Number(f.attrs['offset'] ?? 0), bits };
    });
    const fx = fields.findIndex((f) => f.name === 'cartesianX');
    const fy = fields.findIndex((f) => f.name === 'cartesianY');
    const fz = fields.findIndex((f) => f.name === 'cartesianZ');
    if (fx < 0 || fy < 0 || fz < 0) {
      notes.push(`Scan ${child(scan, 'name')?.text ?? ''} has no cartesian coordinates (spherical only): skipped`);
      continue;
    }
    const fr = fields.findIndex((f) => f.name === 'colorRed');
    const fg = fields.findIndex((f) => f.name === 'colorGreen');
    const fb = fields.findIndex((f) => f.name === 'colorBlue');
    const fInvalid = fields.findIndex((f) => f.name === 'cartesianInvalidState');
    const hasColor = fr >= 0 && fg >= 0 && fb >= 0;
    anyColor ||= hasColor;
    allColor &&= hasColor;
    const records = Number(points.attrs['recordCount'] ?? 0);
    const sectionPhysical = Number(points.attrs['fileOffset'] ?? 0);
    // CompressedVector section header (32 bytes, logical).
    const hdr = pages.read(pages.logicalOf(sectionPhysical), 32);
    const hv = new DataView(hdr.buffer);
    if (hv.getUint8(0) !== 1) throw new LidarError('Unexpected E57 binary section (not a CompressedVector)');
    const dataPhysical = Number(hv.getBigUint64(16, true));
    // Decode the streams packet by packet.
    const values: Float64Array[] = fields.map(() => new Float64Array(records));
    const got = new Int32Array(fields.length);
    const pending: { buf: number[]; bitPos: number }[] = fields.map(() => ({ buf: [], bitPos: 0 }));
    let logical = pages.logicalOf(dataPhysical);
    let guard = 0;
    while (Math.min(...got) < records) {
      if (guard++ > 50_000_000) throw new LidarError('The E57 data packets do not add up');
      const ph = pages.read(logical, 6);
      const type = ph[0]!;
      const length = ((ph[2]! | (ph[3]! << 8)) >>> 0) + 1;
      if (type === 1) {
        const pkt = pages.read(logical, length);
        const pv = new DataView(pkt.buffer);
        const streams = pv.getUint16(4, true);
        if (streams !== fields.length) throw new LidarError('An E57 data packet has a different number of streams than the prototype');
        let o = 6 + 2 * streams;
        for (let s = 0; s < streams; s += 1) {
          const len = pv.getUint16(6 + 2 * s, true);
          const st = pending[s]!;
          for (let k = 0; k < len; k += 1) st.buf.push(pkt[o + k]!);
          o += len;
          decodeStream(fields[s]!, st, values[s]!, got, s, records);
        }
      } else if (type !== 0 && type !== 2) throw new LidarError(`Unknown E57 packet type ${type}`);
      logical += length;
    }
    // Pose: a rotation quaternion (w, x, y, z) and a translation.
    const pose = child(scan, 'pose');
    const q = child(pose, 'rotation');
    const tr = child(pose, 'translation');
    const w = numText(child(q, 'w'), 1);
    const qx = numText(child(q, 'x'), 0);
    const qy = numText(child(q, 'y'), 0);
    const qz = numText(child(q, 'z'), 0);
    const tx = numText(child(tr, 'x'), 0);
    const ty = numText(child(tr, 'y'), 0);
    const tz = numText(child(tr, 'z'), 0);
    const R = [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - w * qz), 2 * (qx * qz + w * qy), 2 * (qx * qy + w * qz), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - w * qx), 2 * (qx * qz - w * qy), 2 * (qy * qz + w * qx), 1 - 2 * (qx * qx + qy * qy)];
    const colorField = hasColor ? fields[fr]! : null;
    const cmin = colorField?.min ?? 0;
    const cmax = colorField?.max ?? 255;
    for (let i = 0; i < records && absAll.length / 3 < maxPoints; i += 1) {
      if (fInvalid >= 0 && values[fInvalid]![i] !== 0) continue;
      const x = values[fx]![i]!;
      const y = values[fy]![i]!;
      const z = values[fz]![i]!;
      absAll.push(R[0]! * x + R[1]! * y + R[2]! * z + tx, R[3]! * x + R[4]! * y + R[5]! * z + ty, R[6]! * x + R[7]! * y + R[8]! * z + tz);
      if (hasColor) for (const f of [fr, fg, fb]) colAll.push(Math.round(((values[f]![i]! - cmin) / Math.max(1e-9, cmax - cmin)) * 255));
    }
  }
  if (!absAll.length) throw new LidarError('No cartesian points in the E57 file');
  notes.push(`E57: ${scans.length} scan${scans.length === 1 ? '' : 's'}`);
  if (anyColor && !allColor) notes.push('Some scans have no colour: shown grey');
  return cloudFrom(Float64Array.from(absAll), anyColor && allColor ? Uint8Array.from(colAll) : null, notes);
}

function decodeStream(f: E57Field, st: { buf: number[]; bitPos: number }, out: Float64Array, got: Int32Array, s: number, records: number): void {
  if (f.type === 'Float') {
    const size = f.precision === 'single' ? 4 : 8;
    const n = Math.floor(st.buf.length / size);
    if (!n) return;
    const b = Uint8Array.from(st.buf.slice(0, n * size));
    const dv = new DataView(b.buffer);
    for (let i = 0; i < n && got[s]! < records; i += 1) out[got[s]!++] = size === 4 ? dv.getFloat32(i * size, true) : dv.getFloat64(i * size, true);
    st.buf = st.buf.slice(n * size);
    return;
  }
  const bits = f.bits;
  const value = (raw: number) => (f.type === 'ScaledInteger' ? (raw + f.min) * f.scale + f.offset : raw + f.min);
  if (bits === 0) {
    // A constant field still has one value per record but no bytes.
    while (got[s]! < records) out[got[s]!++] = value(0);
    return;
  }
  // Little-endian bit packing, least significant bits first.
  const totalBits = st.buf.length * 8;
  let pos = st.bitPos;
  while (pos + bits <= totalBits && got[s]! < records) {
    let raw = 0;
    let mul = 1;
    for (let k = 0; k < bits; ) {
      const byte = st.buf[(pos + k) >> 3]!;
      const bit = (pos + k) & 7;
      const take = Math.min(8 - bit, bits - k);
      raw += ((byte >> bit) & ((1 << take) - 1)) * mul;
      mul *= 2 ** take;
      k += take;
    }
    out[got[s]!++] = value(raw);
    pos += bits;
  }
  const consumed = pos >> 3;
  st.buf = st.buf.slice(consumed);
  st.bitPos = pos - consumed * 8;
}

// ---------------------------------------------------------------------------
// Entry point, downsampling
// ---------------------------------------------------------------------------

export function parsePointFile(bytes: Uint8Array, format: LidarFormat): PointCloud {
  switch (format) {
    case 'ply':
      return parsePly(bytes);
    case 'obj':
      return parseObj(bytes);
    case 'csv':
      return parseSurveyCsv(bytes);
    case 'xyz':
      return parseXyz(bytes, false);
    case 'pts':
      return parseXyz(bytes, true);
    case 'las':
      return parseLas(bytes);
    case 'e57':
      return parseE57(bytes);
  }
}

/** Voxel-grid downsample: one point per occupied voxel (its centroid and mean colour). */
export function voxelDownsample(c: PointCloud, voxel: number): PointCloud {
  if (!(voxel > 0)) return c;
  const map = new Map<string, number>();
  const sum: number[] = [];
  const col: number[] = [];
  const cnt: number[] = [];
  for (let i = 0; i < c.count; i += 1) {
    const x = c.positions[3 * i]!;
    const y = c.positions[3 * i + 1]!;
    const z = c.positions[3 * i + 2]!;
    const key = `${Math.floor(x / voxel)},${Math.floor(y / voxel)},${Math.floor(z / voxel)}`;
    let k = map.get(key);
    if (k === undefined) {
      k = cnt.length;
      map.set(key, k);
      sum.push(0, 0, 0);
      col.push(0, 0, 0);
      cnt.push(0);
    }
    sum[3 * k]! += x;
    sum[3 * k + 1]! += y;
    sum[3 * k + 2]! += z;
    if (c.colors) for (let j = 0; j < 3; j += 1) col[3 * k + j]! += c.colors[3 * i + j]!;
    cnt[k]! += 1;
  }
  const n = cnt.length;
  const positions = new Float32Array(3 * n);
  const colors = c.colors ? new Uint8Array(3 * n) : null;
  for (let k = 0; k < n; k += 1) {
    for (let j = 0; j < 3; j += 1) {
      positions[3 * k + j] = sum[3 * k + j]! / cnt[k]!;
      if (colors) colors[3 * k + j] = Math.round(col[3 * k + j]! / cnt[k]!);
    }
  }
  return { ...c, positions, colors, count: n };
}

/** A voxel size giving about `target` points for the cloud's extent (two passes when needed). */
export function downsampleTo(c: PointCloud, target: number): { cloud: PointCloud; voxel: number } {
  if (c.count <= target) return { cloud: c, voxel: 0 };
  const ext = [0, 1, 2].map((k) => c.bbox.max[k]! - c.bbox.min[k]!);
  const area = ext[0]! * ext[1]! + ext[1]! * ext[2]! + ext[0]! * ext[2]!; // scans are surfaces
  let voxel = Math.sqrt(Math.max(1e-12, area) / target);
  let out = voxelDownsample(c, voxel);
  for (let i = 0; i < 4 && (out.count > target * 1.5 || out.count < target / 3); i += 1) {
    voxel *= Math.sqrt(out.count / target);
    out = voxelDownsample(c, voxel);
  }
  return { cloud: out, voxel };
}
