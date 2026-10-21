import { describe, expect, it } from 'vitest';
import { roomScene, renderScene } from '../camera/render';
import { cameraPath } from '../camera/synthetic';
import { grayOf, trackFrames } from '../camera/klt';
import { detectCorners } from '../camera/features';
import { solveTracks } from '../camera/solver';
import { comparePath } from '../camera/evaluate';
import { summariseTracks, trackAt } from '../camera/tracks';
import { project } from '../camera/geometry';

/**
 * End to end on rendered images (addendum 06 §3): a textured set rendered by
 * the software renderer with a known camera move, then corner detection →
 * KLT tracking → solve, with no ground truth handed to the pipeline. The bar
 * is looser than on synthetic tracks: RMS < 1 px, path within 2 % of the set.
 */

const W = 640;
const H = 360;
const intr = { f: 0.86 * W, cx: (W - 1) / 2, cy: (H - 1) / 2, k1: 0, k2: 0, k3: 0, p1: 0, p2: 0 };
const SET_SIZE = Math.hypot(18, 8, 26);

describe('camera tracking end to end on rendered frames', () => {
  it('detects, tracks and solves a pan-and-truck with the focal length self-calibrated', async () => {
    const quads = roomScene(1);
    const path = cameraPath('pan', 48, 7);
    const frames = path.map((p) => renderScene(quads, { width: W, height: H, intr, R: p.R, t: p.t, supersample: 2 }));
    const tracks = await trackFrames(
      { frame: async (f) => grayOf(frames[f - 1001]!) },
      { first: 1001, last: 1048, from: 1001, to: 1048, working: { width: W, height: H }, plate: { width: W, height: H }, options: { maxFeatures: 400 } },
    );
    const summary = summariseTracks(tracks);
    expect(summary.minPerFrame).toBeGreaterThan(150);
    expect(summary.meanLength).toBeGreaterThan(15);
    const res = await solveTracks(tracks, { focal: { mode: 'unknown' } });
    expect(res.ok).toBe(true);
    expect(res.stats.framesSolved).toBe(48);
    expect(res.stats.nodal).toBe(false);
    expect(res.stats.rms).toBeLessThan(1);
    expect(Math.abs(res.intrinsics.f - intr.f) / intr.f).toBeLessThan(0.02);
    const err = comparePath(res, path, SET_SIZE);
    expect(err.maxPosition).toBeLessThan(0.02);
    expect(err.maxRotationDeg).toBeLessThan(1);
  }, 40_000);
});

describe('features and KLT', () => {
  it('spreads corners over the frame and keeps their distance', () => {
    const quads = roomScene(2);
    const p = cameraPath('dolly', 1, 3)[0]!;
    const img = renderScene(quads, { width: W, height: H, intr, R: p.R, t: p.t });
    const g = grayOf(img);
    const corners = detectCorners(g.data, W, H, { maxFeatures: 300, minDistance: 8 });
    expect(corners.length).toBeGreaterThan(200);
    for (let i = 0; i < corners.length; i += 1)
      for (let j = i + 1; j < corners.length; j += 1) expect(Math.hypot(corners[i]!.x - corners[j]!.x, corners[i]!.y - corners[j]!.y)).toBeGreaterThanOrEqual(7.99);
    // Every quarter of the frame has some.
    for (const [qx, qy] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ])
      expect(corners.filter((c) => Math.floor((c.x / W) * 2) === qx && Math.floor((c.y / H) * 2) === qy).length).toBeGreaterThan(20);
  });

  it('tracks features to a fraction of a pixel of where the scene points really went', async () => {
    const quads = roomScene(3);
    const path = cameraPath('handheld', 12, 4);
    const frames = path.map((p) => renderScene(quads, { width: W, height: H, intr, R: p.R, t: p.t, supersample: 3 }));
    const tracks = await trackFrames({ frame: async (f) => grayOf(frames[f - 1]!) }, { first: 1, last: 12, from: 1, to: 12, working: { width: W, height: H }, plate: { width: W, height: H }, options: { maxFeatures: 250 } });
    // Back-project each track's first position onto the set (depth by ray casting against the quads) and
    // compare its projection on the last frame with the track.
    const errors: number[] = [];
    for (let i = 0; i < tracks.ids.length; i += 1) {
      if (tracks.start[i] !== 1 || tracks.length[i]! < 12) continue;
      const a = trackAt(tracks, i, 1)!;
      const X = backProject(quads, path[0]!, a[0], a[1]);
      if (!X) continue;
      const b = trackAt(tracks, i, 12)!;
      const pr = project(intr, path[11]!.R, path[11]!.t, X);
      if (pr) errors.push(Math.hypot(pr[0] - b[0], pr[1] - b[1]));
    }
    errors.sort((x, y) => x - y);
    expect(errors.length).toBeGreaterThan(80);
    expect(errors[Math.floor(errors.length / 2)]!).toBeLessThan(0.3);
    expect(errors[Math.floor(errors.length * 0.9)]!).toBeLessThan(1);
  }, 30_000);

  it('tracks backward as well as forward', async () => {
    const quads = roomScene(4);
    const path = cameraPath('pan', 30, 5);
    const frames = path.map((p) => renderScene(quads, { width: W, height: H, intr, R: p.R, t: p.t }));
    const io = { frame: async (f: number) => grayOf(frames[f - 1]!) };
    const fwd = await trackFrames(io, { first: 1, last: 30, from: 1, to: 30, working: { width: W, height: H }, plate: { width: W, height: H }, options: { maxFeatures: 150 } });
    const bwd = await trackFrames(io, { first: 1, last: 30, from: 30, to: 1, working: { width: W, height: H }, plate: { width: W, height: H }, options: { maxFeatures: 150 } });
    expect(summariseTracks(fwd).minPerFrame).toBeGreaterThan(80);
    expect(summariseTracks(bwd).minPerFrame).toBeGreaterThan(80);
    // Backward tracks that began on frame 30 and reached frame 1 are stored in forward order.
    const full = [...bwd.ids.keys()].filter((i) => bwd.start[i] === 1 && bwd.length[i] === 30);
    expect(full.length).toBeGreaterThan(30);
  }, 30_000);
});

function backProject(quads: ReturnType<typeof roomScene>, pose: { R: number[]; t: number[]; C: number[] }, u: number, v: number): [number, number, number] | null {
  const x = (u - intr.cx) / intr.f;
  const y = (v - intr.cy) / intr.f;
  const R = pose.R;
  const d = [R[0]! * x + R[3]! * y + R[6]!, R[1]! * x + R[4]! * y + R[7]!, R[2]! * x + R[5]! * y + R[8]!];
  const C = pose.C;
  let best = Infinity;
  for (const q of quads) {
    const n = [q.u[1] * q.v[2] - q.u[2] * q.v[1], q.u[2] * q.v[0] - q.u[0] * q.v[2], q.u[0] * q.v[1] - q.u[1] * q.v[0]];
    const den = n[0]! * d[0]! + n[1]! * d[1]! + n[2]! * d[2]!;
    if (Math.abs(den) < 1e-12) continue;
    const s = (n[0]! * (q.origin[0] - C[0]!) + n[1]! * (q.origin[1] - C[1]!) + n[2]! * (q.origin[2] - C[2]!)) / den;
    if (s <= 0 || s >= best) continue;
    const P = [C[0]! + s * d[0]! - q.origin[0], C[1]! + s * d[1]! - q.origin[1], C[2]! + s * d[2]! - q.origin[2]];
    const a = (P[0]! * q.u[0] + P[1]! * q.u[1] + P[2]! * q.u[2]) / (q.u[0] ** 2 + q.u[1] ** 2 + q.u[2] ** 2);
    const b = (P[0]! * q.v[0] + P[1]! * q.v[1] + P[2]! * q.v[2]) / (q.v[0] ** 2 + q.v[1] ** 2 + q.v[2] ** 2);
    if (a < 0 || a > 1 || b < 0 || b > 1) continue;
    best = s;
  }
  if (!Number.isFinite(best)) return null;
  return [C[0]! + best * d[0]!, C[1]! + best * d[1]!, C[2]! + best * d[2]!];
}
