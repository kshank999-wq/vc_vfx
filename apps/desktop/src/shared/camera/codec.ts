import type { TrackData } from './tracks';
import type { SolveResult } from './solver';
import type { PointCloud } from './lidar';

/**
 * The track cache's file format (addendum 06 §2): a JSON header and raw
 * little-endian typed arrays, 8-byte aligned.
 *
 *   "VCVX" u32 version u32 headerLength  header(JSON, UTF-8)  pad  arrays…
 *
 * Used for feature tracks, solves (per-frame cameras and per-track points)
 * and downsampled point clouds. Pure, so the browser preview's in-memory
 * store and the desktop's files hold the same bytes.
 */

type Typed = Float32Array | Float64Array | Int32Array | Uint8Array;
const TYPES = { f32: Float32Array, f64: Float64Array, i32: Int32Array, u8: Uint8Array } as const;
type TypeName = keyof typeof TYPES;
const typeName = (a: Typed): TypeName => (a instanceof Float32Array ? 'f32' : a instanceof Float64Array ? 'f64' : a instanceof Int32Array ? 'i32' : 'u8');

export const CODEC_VERSION = 1;

export function encodeContainer(kind: string, meta: Record<string, unknown>, arrays: Record<string, Typed>): Uint8Array {
  const desc: { name: string; type: TypeName; length: number; offset: number }[] = [];
  let offset = 0;
  for (const [name, a] of Object.entries(arrays)) {
    desc.push({ name, type: typeName(a), length: a.length, offset });
    offset += Math.ceil(a.byteLength / 8) * 8;
  }
  const header = new TextEncoder().encode(JSON.stringify({ kind, meta, arrays: desc }));
  const headStart = 12;
  const dataStart = Math.ceil((headStart + header.length) / 8) * 8;
  const out = new Uint8Array(dataStart + offset);
  out.set([0x56, 0x43, 0x56, 0x58], 0); // VCVX
  const dv = new DataView(out.buffer);
  dv.setUint32(4, CODEC_VERSION, true);
  dv.setUint32(8, header.length, true);
  out.set(header, headStart);
  desc.forEach((d, i) => {
    const a = Object.values(arrays)[i]!;
    out.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), dataStart + d.offset);
  });
  return out;
}

export function decodeContainer(bytes: Uint8Array): { kind: string; meta: Record<string, unknown>; arrays: Record<string, Typed> } {
  if (bytes.length < 12 || bytes[0] !== 0x56 || bytes[1] !== 0x43 || bytes[2] !== 0x56 || bytes[3] !== 0x58) throw new Error('Not a VC VFX track cache file');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = dv.getUint32(4, true);
  if (version > CODEC_VERSION) throw new Error('This track cache file was written by a newer VC VFX');
  const hl = dv.getUint32(8, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + hl))) as { kind: string; meta: Record<string, unknown>; arrays: { name: string; type: TypeName; length: number; offset: number }[] };
  const dataStart = Math.ceil((12 + hl) / 8) * 8;
  const arrays: Record<string, Typed> = {};
  for (const d of header.arrays) {
    const C = TYPES[d.type];
    const byteLen = d.length * C.BYTES_PER_ELEMENT;
    // Copy into an aligned buffer.
    const copy = new Uint8Array(byteLen);
    copy.set(bytes.subarray(dataStart + d.offset, dataStart + d.offset + byteLen));
    arrays[d.name] = new C(copy.buffer);
  }
  return { kind: header.kind, meta: header.meta, arrays };
}

export function encodeTracks(t: TrackData): Uint8Array {
  return encodeContainer('tracks', { width: t.width, height: t.height, first: t.first, last: t.last, nextId: t.nextId }, { ids: t.ids, start: t.start, length: t.length, offset: t.offset, xy: t.xy, manual: t.manual ?? new Uint8Array(t.ids.length) });
}

export function decodeTracks(bytes: Uint8Array): TrackData {
  const c = decodeContainer(bytes);
  if (c.kind !== 'tracks') throw new Error(`Expected tracks, found ${c.kind}`);
  const m = c.meta as { width: number; height: number; first: number; last: number; nextId: number };
  return { ...m, ids: c.arrays['ids'] as Int32Array, start: c.arrays['start'] as Int32Array, length: c.arrays['length'] as Int32Array, offset: c.arrays['offset'] as Int32Array, xy: c.arrays['xy'] as Float32Array, manual: c.arrays['manual'] as Uint8Array };
}

export function encodeSolve(s: SolveResult): Uint8Array {
  const F = s.frames.length;
  const R = new Float64Array(F * 9);
  const t = new Float64Array(F * 3);
  const fr = new Int32Array(F);
  const flags = new Uint8Array(F);
  const frms = new Float32Array(F);
  const ftr = new Int32Array(F);
  s.frames.forEach((f, i) => {
    R.set(f.R, 9 * i);
    t.set(f.t, 3 * i);
    fr[i] = f.frame;
    flags[i] = (f.solved ? 1 : 0) | (f.keyframe ? 2 : 0);
    frms[i] = f.rms;
    ftr[i] = f.tracks;
  });
  const T = s.tracks.length;
  const ids = new Int32Array(T);
  const X = new Float64Array(T * 3).fill(NaN);
  const trms = new Float32Array(T);
  const tin = new Int32Array(T);
  const tobs = new Int32Array(T);
  s.tracks.forEach((k, i) => {
    ids[i] = k.id;
    if (k.X) X.set(k.X, 3 * i);
    trms[i] = k.rms;
    tin[i] = k.inliers;
    tobs[i] = k.observations;
  });
  return encodeContainer('solve', { ok: s.ok, reason: s.reason, engine: s.engine, width: s.width, height: s.height, intrinsics: s.intrinsics, stats: s.stats }, { R, t, frame: fr, flags, frameRms: frms, frameTracks: ftr, ids, X, trackRms: trms, inliers: tin, observations: tobs });
}

export function decodeSolve(bytes: Uint8Array): SolveResult {
  const c = decodeContainer(bytes);
  if (c.kind !== 'solve') throw new Error(`Expected a solve, found ${c.kind}`);
  const m = c.meta as Pick<SolveResult, 'ok' | 'reason' | 'engine' | 'width' | 'height' | 'intrinsics' | 'stats'>;
  const a = c.arrays;
  const frame = a['frame'] as Int32Array;
  const R = a['R'] as Float64Array;
  const t = a['t'] as Float64Array;
  const flags = a['flags'] as Uint8Array;
  const frames = Array.from(frame, (f, i) => ({ frame: f, solved: (flags[i]! & 1) === 1, keyframe: (flags[i]! & 2) === 2, R: Array.from(R.subarray(9 * i, 9 * i + 9)), t: Array.from(t.subarray(3 * i, 3 * i + 3)), rms: (a['frameRms'] as Float32Array)[i]!, tracks: (a['frameTracks'] as Int32Array)[i]! }));
  const X = a['X'] as Float64Array;
  const tracks = Array.from(a['ids'] as Int32Array, (id, i) => ({
    id,
    X: Number.isNaN(X[3 * i]) ? null : ([X[3 * i]!, X[3 * i + 1]!, X[3 * i + 2]!] as [number, number, number]),
    rms: (a['trackRms'] as Float32Array)[i]!,
    inliers: (a['inliers'] as Int32Array)[i]!,
    observations: (a['observations'] as Int32Array)[i]!,
  }));
  return { ...m, frames, tracks };
}

export function encodeCloud(c: PointCloud, extra: { normals?: Float32Array; voxel?: number } = {}): Uint8Array {
  const arrays: Record<string, Typed> = { positions: c.positions };
  if (c.colors) arrays['colors'] = c.colors;
  if (extra.normals) arrays['normals'] = extra.normals;
  return encodeContainer('cloud', { origin: c.origin, count: c.count, named: c.named, bbox: c.bbox, notes: c.notes, voxel: extra.voxel ?? 0 }, arrays);
}

export function decodeCloud(bytes: Uint8Array): PointCloud & { normals: Float32Array | null; voxel: number } {
  const c = decodeContainer(bytes);
  if (c.kind !== 'cloud') throw new Error(`Expected a cloud, found ${c.kind}`);
  const m = c.meta as { origin: [number, number, number]; count: number; named: PointCloud['named']; bbox: PointCloud['bbox']; notes: string[]; voxel: number };
  return { ...m, positions: c.arrays['positions'] as Float32Array, colors: (c.arrays['colors'] as Uint8Array | undefined) ?? null, normals: (c.arrays['normals'] as Float32Array | undefined) ?? null };
}
