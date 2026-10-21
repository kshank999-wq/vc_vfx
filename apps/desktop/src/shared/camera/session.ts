import type { TrackViewData } from '../bridge';
import { decodeCloud, decodeSolve, decodeTracks } from './codec';
import { Track2dDocumentSchema, camtrackLocked, camtrackTaskVersion, handoffShot, newCamTrackDocument, shotState, track2dLocked, track2dTaskVersion, type CamTrackDocument, type Project } from '@vcvfx/domain';
import type { CameraSession, CameraStore } from './commands';

/**
 * Building a `CameraSession` from a project (addendum 06 §8): the shot's
 * documents (or fresh ones), its lock state and versions, and the sizes the
 * work happens at. The IO, the store and the solver are the caller's: the
 * desktop's worker (files, ffmpeg frames) or the browser preview (memory,
 * bundled frames).
 */

export type SessionBase = Omit<CameraSession, 'io' | 'store' | 'solver' | 'actor' | 'now' | 'generator' | 'signal' | 'progress' | 'yieldNow'>;

/** The working size for a plate at a longest-edge setting (even numbers, never above the plate). */
export function trackWorkingSize(plate: { width: number; height: number }, workingWidth: number): { width: number; height: number } {
  const width = Math.min(plate.width, Math.max(256, Math.round(workingWidth)));
  const height = Math.max(16, Math.round((plate.height * width) / plate.width));
  return { width: width - (width % 2), height: height - (height % 2) };
}

export function sessionBase(p: Project, shotId: string, timing: { first: number; last: number; fps: number }, plate: { width: number; height: number }, working?: { width: number; height: number }): SessionBase {
  const s = shotState(p, shotId);
  const shot = handoffShot(p, shotId);
  if (!s || !shot) throw new Error(`No shot ${shotId}`);
  const camtrack = s.camtrack ?? newCamTrackDocument(p, shotId);
  return {
    shotId,
    name: s.vfxShotId ?? shot.shotId,
    first: timing.first,
    last: timing.last,
    fps: timing.fps,
    plate,
    working: working ?? trackWorkingSize(plate, camtrack.trackSettings.workingWidth),
    camtrack,
    track2d: s.track2d ?? Track2dDocumentSchema.parse({}),
    camtrackVersion: camtrackTaskVersion(s),
    track2dVersion: track2dTaskVersion(s),
    camtrackLocked: camtrackLocked(s),
    track2dLocked: track2dLocked(s),
    lensProfiles: p.lensProfiles,
    customCameras: p.customCameras,
  };
}

/** The track cache in memory (the browser preview, tests). */
export class MemoryStore implements CameraStore {
  private readonly map = new Map<string, Uint8Array>();

  async get(id: string): Promise<Uint8Array | null> {
    return this.map.get(id) ?? null;
  }

  async put(id: string, bytes: Uint8Array): Promise<void> {
    this.map.set(id, bytes);
    // Keep memory bounded: drop the oldest track and solve files beyond 64.
    if (this.map.size > 64) {
      const old = [...this.map.keys()].find((k) => !k.startsWith('cloud-'));
      if (old && old !== id) this.map.delete(old);
    }
  }

  get size(): number {
    return this.map.size;
  }
}

/** The track cache's data for the Track workspace to draw: feature tracks, the active solve, LiDAR clouds. */
export async function viewData(doc: CamTrackDocument | null | undefined, store: CameraStore, clouds: boolean): Promise<TrackViewData> {
  const out: TrackViewData = { tracks: null, solve: null, clouds: [] };
  if (!doc) return out;
  if (doc.trackSet) {
    const bytes = await store.get(doc.trackSet.file);
    if (bytes) {
      const t = decodeTracks(bytes);
      out.tracks = { first: t.first, last: t.last, ids: t.ids, start: t.start, length: t.length, offset: t.offset, xy: t.xy };
    }
  }
  const rec = doc.solves.find((x) => x.number === doc.activeSolve);
  if (rec) {
    const bytes = await store.get(rec.file);
    if (bytes) out.solve = solveView(rec.number, decodeSolve(bytes));
  }
  if (clouds)
    for (const l of doc.lidar) {
      const bytes = await store.get(l.cache);
      if (!bytes) continue;
      const c = decodeCloud(bytes);
      out.clouds.push({ id: l.id, origin: c.origin, positions: c.positions, colors: c.colors });
    }
  return out;
}

export function solveView(number: number, s: ReturnType<typeof decodeSolve>): NonNullable<TrackViewData['solve']> {
  const F = s.frames.length;
  const R = new Float64Array(F * 9);
  const t = new Float64Array(F * 3);
  s.frames.forEach((f, i) => {
    R.set(f.R, 9 * i);
    t.set(f.t, 3 * i);
  });
  const X = new Float64Array(s.tracks.length * 3).fill(NaN);
  s.tracks.forEach((tr, i) => tr.X && X.set(tr.X, 3 * i));
  return {
    number,
    frames: s.frames.map((f) => ({ frame: f.frame, solved: f.solved, rms: f.rms, tracks: f.tracks, keyframe: f.keyframe })),
    R,
    t,
    trackIds: Int32Array.from(s.tracks.map((x) => x.id)),
    X,
    trackRms: Float32Array.from(s.tracks.map((x) => x.rms)),
    intrinsics: { ...s.intrinsics },
  };
}
