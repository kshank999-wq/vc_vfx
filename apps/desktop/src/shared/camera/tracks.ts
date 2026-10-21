/**
 * Feature tracks (addendum 06): where each tracked feature is on each frame,
 * in plate pixels (pixel-index coordinates: the centre of pixel (i, j) is at
 * (i, j)). A track is contiguous — a feature lost by the tracker is not
 * revived; a later detection starts a new track — so a track is its first
 * frame, its length and a run of positions.
 *
 * This is the big data of a camera track: thousands of tracks over hundreds
 * of frames. It lives in a file beside the project (`store`), never in the
 * project JSON, which records a summary and the file's id.
 */

export interface TrackData {
  /** Plate size the positions are in. */
  width: number;
  height: number;
  /** Delivered frame range the tracking covered. */
  first: number;
  last: number;
  /** Stable ids (unique within the data's lineage). */
  ids: Int32Array;
  /** First frame (delivered number) of each track. */
  start: Int32Array;
  length: Int32Array;
  /** Index of each track's first position in `xy` (pairs). */
  offset: Int32Array;
  xy: Float32Array;
  /** Next free id. */
  nextId: number;
  /** 1 = placed by hand (a correspondence feature), 0 = automatic. */
  manual?: Uint8Array;
}

export const trackCount = (t: TrackData): number => t.ids.length;

export function emptyTracks(width: number, height: number, first: number, last: number): TrackData {
  return { width, height, first, last, ids: new Int32Array(0), start: new Int32Array(0), length: new Int32Array(0), offset: new Int32Array(0), xy: new Float32Array(0), nextId: 1, manual: new Uint8Array(0) };
}

/** Position of track i on frame f, or null. */
export function trackAt(t: TrackData, i: number, frame: number): [number, number] | null {
  const s = t.start[i]!;
  if (frame < s || frame >= s + t.length[i]!) return null;
  const o = (t.offset[i]! + frame - s) * 2;
  return [t.xy[o]!, t.xy[o + 1]!];
}

export function indexOfId(t: TrackData, id: number): number {
  // ids are ascending when built by the builders here; fall back to a scan.
  let lo = 0;
  let hi = t.ids.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = t.ids[mid]!;
    if (v === id) return mid;
    if (v < id) lo = mid + 1;
    else hi = mid - 1;
  }
  for (let i = 0; i < t.ids.length; i += 1) if (t.ids[i] === id) return i;
  return -1;
}

/** Tracks visible on a frame: indices. */
export function tracksOnFrame(t: TrackData, frame: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < t.ids.length; i += 1) if (frame >= t.start[i]! && frame < t.start[i]! + t.length[i]!) out.push(i);
  return out;
}

/** Accumulates tracks; used by the tracker and the synthetic generators. */
export class TrackBuilder {
  private tracks: { id: number; start: number; xy: number[]; manual: boolean }[] = [];
  nextId: number;

  constructor(
    readonly width: number,
    readonly height: number,
    readonly first: number,
    readonly last: number,
    nextId = 1,
  ) {
    this.nextId = nextId;
  }

  /** Start a track at frame `start`; returns its handle. */
  begin(start: number, x: number, y: number, manual = false, id?: number): number {
    const tid = id ?? this.nextId++;
    if (id !== undefined && id >= this.nextId) this.nextId = id + 1;
    this.tracks.push({ id: tid, start, xy: [x, y], manual });
    return this.tracks.length - 1;
  }

  extend(handle: number, x: number, y: number): void {
    this.tracks[handle]!.xy.push(x, y);
  }

  /** Remove the last `n` positions of a track (e.g. a failed forward-backward check). */
  trim(handle: number, n: number): void {
    const t = this.tracks[handle]!;
    t.xy.length = Math.max(0, t.xy.length - 2 * n);
  }

  lengthOf(handle: number): number {
    return this.tracks[handle]!.xy.length / 2;
  }

  build(minLength = 1): TrackData {
    const kept = this.tracks.filter((t) => t.xy.length / 2 >= minLength).sort((a, b) => a.id - b.id);
    const n = kept.length;
    const ids = new Int32Array(n);
    const start = new Int32Array(n);
    const length = new Int32Array(n);
    const offset = new Int32Array(n);
    const manual = new Uint8Array(n);
    let total = 0;
    kept.forEach((t, i) => {
      ids[i] = t.id;
      start[i] = t.start;
      length[i] = t.xy.length / 2;
      offset[i] = total;
      manual[i] = t.manual ? 1 : 0;
      total += t.xy.length / 2;
    });
    const xy = new Float32Array(total * 2);
    kept.forEach((t, i) => xy.set(t.xy, offset[i]! * 2));
    return { width: this.width, height: this.height, first: this.first, last: this.last, ids, start, length, offset, xy, nextId: this.nextId, manual };
  }
}

/** A copy keeping only tracks for which `keep(i)` is true. */
export function filterTracks(t: TrackData, keep: (i: number) => boolean): TrackData {
  const b = new TrackBuilder(t.width, t.height, t.first, t.last, t.nextId);
  for (let i = 0; i < t.ids.length; i += 1) {
    if (!keep(i)) continue;
    const o = t.offset[i]! * 2;
    const h = b.begin(t.start[i]!, t.xy[o]!, t.xy[o + 1]!, Boolean(t.manual?.[i]), t.ids[i]!);
    for (let k = 1; k < t.length[i]!; k += 1) b.extend(h, t.xy[o + 2 * k]!, t.xy[o + 2 * k + 1]!);
  }
  return b.build();
}

/** Merge two track sets over the union of their ranges (ids kept; `b`'s ids must not collide). */
export function mergeTracks(a: TrackData, b: TrackData): TrackData {
  const out = new TrackBuilder(a.width, a.height, Math.min(a.first, b.first), Math.max(a.last, b.last), Math.max(a.nextId, b.nextId));
  for (const t of [a, b]) {
    for (let i = 0; i < t.ids.length; i += 1) {
      const o = t.offset[i]! * 2;
      const h = out.begin(t.start[i]!, t.xy[o]!, t.xy[o + 1]!, Boolean(t.manual?.[i]), t.ids[i]!);
      for (let k = 1; k < t.length[i]!; k += 1) out.extend(h, t.xy[o + 2 * k]!, t.xy[o + 2 * k + 1]!);
    }
  }
  return out.build();
}

export interface TrackSummary {
  tracks: number;
  observations: number;
  meanLength: number;
  /** Fewest tracks on any frame of the range. */
  minPerFrame: number;
  medianPerFrame: number;
}

export function summariseTracks(t: TrackData): TrackSummary {
  const n = t.ids.length;
  const frames = t.last - t.first + 1;
  const per = new Int32Array(Math.max(0, frames));
  let obs = 0;
  for (let i = 0; i < n; i += 1) {
    obs += t.length[i]!;
    for (let k = 0; k < t.length[i]!; k += 1) {
      const f = t.start[i]! + k - t.first;
      if (f >= 0 && f < frames) per[f]! += 1;
    }
  }
  const sorted = Array.from(per).sort((a, b) => a - b);
  return { tracks: n, observations: obs, meanLength: n ? obs / n : 0, minPerFrame: sorted[0] ?? 0, medianPerFrame: sorted[sorted.length >> 1] ?? 0 };
}
