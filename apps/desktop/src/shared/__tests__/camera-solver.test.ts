import { describe, expect, it } from 'vitest';
import { bundleAdjust, type BAProblem } from '../camera/bundle';
import { rodrigues, project, type Intrinsics } from '../camera/geometry';
import { mul3 } from '../camera/linalg';
import { solveTracks, type SolveResult } from '../camera/solver';
import { comparePath, sceneScaleOf } from '../camera/evaluate';
import { cameraPath, observe, scenePoints, syntheticShot, type SyntheticShot } from '../camera/synthetic';
import { umeyama, applySim } from '../camera/align';
import { ransacFundamental, ransacHomography, gric, decomposeEssential, essentialFromPose, poseFromEssential } from '../camera/two-view';

/**
 * The camera solver's accuracy bar (addendum 06 §3): synthetic scenes with a
 * known camera path, observations with 0.5 px RMS Gaussian noise (σ = 0.354 px
 * per axis) and 10 % outlier tracks (half moving with their own motion, half
 * jumping to another feature part-way). After the best similarity, the solved
 * path must be within 0.5 % of the scene's size in position and 0.2° in
 * rotation; the focal length within 1 % when solved; the RMS reprojection
 * error (2D, inliers) under 0.7 px.
 */

const SECONDS = 1000;

function check(shot: SyntheticShot, res: SolveResult, options: { nodal?: boolean } = {}) {
  expect(res.ok).toBe(true);
  expect(res.stats.framesSolved).toBe(res.stats.framesTotal);
  const err = comparePath(res, shot.path, sceneScaleOf(shot.points), { nodal: options.nodal ?? false, points: { truth: shot.truth, X: shot.points } });
  return err;
}

describe('camera solver: synthetic ground truth', () => {
  it('dolly with a known lens', async () => {
    const shot = syntheticShot('dolly', { frames: 90, points: 650, seed: 1 });
    const res = await solveTracks(shot.tracks, { focal: { mode: 'known', px: shot.intr.f } });
    const err = check(shot, res);
    expect(res.stats.nodal).toBe(false);
    expect(res.stats.rms).toBeLessThan(0.7);
    expect(err.maxPosition).toBeLessThan(0.005);
    expect(err.maxRotationDeg).toBeLessThan(0.2);
  }, 30 * SECONDS);

  it('pan and truck with the focal length self-calibrated', async () => {
    const shot = syntheticShot('pan', { frames: 90, points: 650, seed: 2 });
    const res = await solveTracks(shot.tracks, { focal: { mode: 'unknown' } });
    const err = check(shot, res);
    expect(Math.abs(res.intrinsics.f - shot.intr.f) / shot.intr.f).toBeLessThan(0.01);
    expect(res.stats.rms).toBeLessThan(0.7);
    expect(err.maxPosition).toBeLessThan(0.005);
    expect(err.maxRotationDeg).toBeLessThan(0.2);
    // The outlier tracks were found: most of their observations are not inliers.
    const outlierInliers = res.tracks.filter((t) => shot.outliers.has(t.id) && t.X).reduce((n, t) => n + t.inliers, 0);
    const outlierObs = res.tracks.filter((t) => shot.outliers.has(t.id)).reduce((n, t) => n + t.observations, 0);
    expect(outlierInliers / outlierObs).toBeLessThan(0.5);
  }, 30 * SECONDS);

  it('handheld jitter with the focal length self-calibrated', async () => {
    const shot = syntheticShot('handheld', { frames: 90, points: 650, seed: 3 });
    const res = await solveTracks(shot.tracks, { focal: { mode: 'approx', px: 1400 } });
    const err = check(shot, res);
    expect(Math.abs(res.intrinsics.f - shot.intr.f) / shot.intr.f).toBeLessThan(0.01);
    expect(res.stats.rms).toBeLessThan(0.7);
    expect(err.maxPosition).toBeLessThan(0.005);
    expect(err.maxRotationDeg).toBeLessThan(0.2);
  }, 30 * SECONDS);

  it('detects a rotation-only pan, solves it as nodal with a warning, and finds the focal length', async () => {
    const shot = syntheticShot('nodal', { frames: 90, points: 650, seed: 4 });
    const res = await solveTracks(shot.tracks, { focal: { mode: 'unknown' } });
    const err = check(shot, res, { nodal: true });
    expect(res.stats.nodal).toBe(true);
    expect(res.stats.warnings.some((w) => /nodal/i.test(w))).toBe(true);
    expect(Math.abs(res.intrinsics.f - shot.intr.f) / shot.intr.f).toBeLessThan(0.01);
    expect(res.stats.rms).toBeLessThan(0.7);
    expect(err.maxRotationDeg).toBeLessThan(0.2);
    // Every camera at the same place.
    for (const f of res.frames) expect(Math.hypot(...f.t)).toBeLessThan(1e-9);
  }, 30 * SECONDS);

  it('recovers radial distortion (k1, k2) with the focal length', async () => {
    const intr: Intrinsics = { f: 1500, cx: 959.5, cy: 539.5, k1: -0.09, k2: 0.025, k3: 0, p1: 0, p2: 0 };
    const path = cameraPath('pan', 80, 105);
    const shot = observe(path, scenePoints(650, 205), { intr, seed: 5 });
    const res = await solveTracks(shot.tracks, { focal: { mode: 'approx', px: 1400 }, refine: { k1k2: true } });
    const err = check(shot, res);
    expect(Math.abs(res.intrinsics.f - 1500) / 1500).toBeLessThan(0.01);
    expect(Math.abs(res.intrinsics.k1 - intr.k1)).toBeLessThan(0.01);
    // Compare the distortion where it matters: at the frame corner (normalised radius ≈ 0.73).
    const rc = Math.hypot(960, 540) / 1500;
    const radial = (k: Intrinsics) => 1 + k.k1 * rc ** 2 + k.k2 * rc ** 4;
    expect(Math.abs(radial(res.intrinsics) - radial(intr)) * rc * 1500).toBeLessThan(1); // < 1 px at the corner
    expect(res.stats.rms).toBeLessThan(0.7);
    expect(err.maxPosition).toBeLessThan(0.005);
    expect(err.maxRotationDeg).toBeLessThan(0.2);
  }, 30 * SECONDS);

  it('warns that a pure dolly cannot determine the focal length', async () => {
    const shot = syntheticShot('dolly', { frames: 60, points: 500, seed: 6 });
    const res = await solveTracks(shot.tracks, { focal: { mode: 'unknown' } });
    expect(res.stats.warnings.some((w) => /focal length is poorly determined/.test(w))).toBe(true);
    // The reprojection is still fine: the ambiguity is depth against focal, not the fit.
    expect(res.stats.rms).toBeLessThan(0.7);
  }, 30 * SECONDS);
});

describe('two-view geometry', () => {
  it('fundamental and homography by RANSAC, model selection by GRIC', () => {
    const shot = syntheticShot('pan', { frames: 30, points: 400, seed: 7, outliers: 0.1 });
    const nodal = syntheticShot('nodal', { frames: 30, points: 400, seed: 8, outliers: 0.1 });
    const pairOf = (s: SyntheticShot, a: number, b: number) => {
      const td = s.tracks;
      const x1: number[] = [];
      const x2: number[] = [];
      for (let i = 0; i < td.ids.length; i += 1) {
        const st = td.start[i]!;
        const fa = td.first + a;
        const fb = td.first + b;
        if (fa < st || fb >= st + td.length[i]!) continue;
        const oa = (td.offset[i]! + fa - st) * 2;
        const ob = (td.offset[i]! + fb - st) * 2;
        x1.push(td.xy[oa]!, td.xy[oa + 1]!);
        x2.push(td.xy[ob]!, td.xy[ob + 1]!);
      }
      return { x1: Float64Array.from(x1), x2: Float64Array.from(x2) };
    };
    const p = pairOf(shot, 0, 20);
    const F = ransacFundamental(p.x1, p.x2, { threshold: 1.5 })!;
    const H = ransacHomography(p.x1, p.x2, { threshold: 2 })!;
    expect(F.count / (p.x1.length / 2)).toBeGreaterThan(0.75);
    expect(gric(F.errors, 1, 3, 7)).toBeLessThan(gric(H.errors, 1, 2, 8));
    const q = pairOf(nodal, 0, 20);
    const Fn = ransacFundamental(q.x1, q.x2, { threshold: 1.5 })!;
    const Hn = ransacHomography(q.x1, q.x2, { threshold: 2 })!;
    expect(gric(Hn.errors, 1, 2, 8)).toBeLessThan(gric(Fn.errors, 1, 3, 7));
  });

  it('decomposes an essential matrix and picks the pose by cheirality', () => {
    const R = rodrigues([0.05, -0.2, 0.03]);
    const t = [0.8, 0.1, 0.2];
    const n = Math.hypot(...t);
    const E = essentialFromPose(R, t);
    expect(decomposeEssential(E).length).toBe(4);
    const pts = scenePoints(80, 9);
    const x1: number[] = [];
    const x2: number[] = [];
    for (let i = 0; i < 80; i += 1) {
      const X = [pts[3 * i]!, pts[3 * i + 1]!, pts[3 * i + 2]!];
      x1.push(X[0]! / X[2]!, X[1]! / X[2]!);
      const Xc = [R[0]! * X[0]! + R[1]! * X[1]! + R[2]! * X[2]! + t[0]!, R[3]! * X[0]! + R[4]! * X[1]! + R[5]! * X[2]! + t[1]!, R[6]! * X[0]! + R[7]! * X[1]! + R[8]! * X[2]! + t[2]!];
      x2.push(Xc[0]! / Xc[2]!, Xc[1]! / Xc[2]!);
    }
    const pose = poseFromEssential(E, Float64Array.from(x1), Float64Array.from(x2));
    expect(pose.front).toBe(80);
    for (let k = 0; k < 9; k += 1) expect(pose.R[k]!).toBeCloseTo(R[k]!, 8);
    for (let k = 0; k < 3; k += 1) expect(pose.t[k]!).toBeCloseTo(t[k]! / n, 8);
  });
});

describe('bundle adjustment', () => {
  function problemFrom(shot: SyntheticShot, perturb: number): BAProblem {
    const td = shot.tracks;
    const F = td.last - td.first + 1;
    const obsCam: number[] = [];
    const obsPt: number[] = [];
    const uv: number[] = [];
    const X: number[] = [];
    for (let k = 0; k < td.ids.length; k += 1) {
      const pi = shot.truth.get(td.ids[k]!)!;
      if (pi < 0) continue;
      const idx = X.length / 3;
      X.push(shot.points[3 * pi]! + perturb * Math.sin(k), shot.points[3 * pi + 1]! + perturb * Math.cos(k), shot.points[3 * pi + 2]! + perturb);
      for (let j = 0; j < td.length[k]!; j += 1) {
        obsCam.push(td.start[k]! + j - td.first);
        obsPt.push(idx);
        uv.push(td.xy[2 * (td.offset[k]! + j)]!, td.xy[2 * (td.offset[k]! + j) + 1]!);
      }
    }
    const R = new Float64Array(F * 9);
    const t = new Float64Array(F * 3);
    shot.path.forEach((p, i) => {
      R.set(mul3(rodrigues([perturb * 0.04 * Math.sin(i), perturb * 0.02, perturb * 0.04]), p.R), 9 * i);
      t.set([p.t[0]! + perturb * 0.4, p.t[1]!, p.t[2]! - perturb * 0.2], 3 * i);
    });
    const camFixed = new Uint8Array(F * 6);
    camFixed.fill(1, 0, 6);
    camFixed[6 + 3] = 1; // the scale
    return { intr: { ...shot.intr }, refine: {}, R, t, camFixed, X: Float64Array.from(X), pointFixed: new Uint8Array(X.length / 3), obsCam: Int32Array.from(obsCam), obsPt: Int32Array.from(obsPt), obsUV: Float64Array.from(uv) };
  }

  it('converges from a perturbed start to the noise floor, refining the focal length', () => {
    const shot = syntheticShot('pan', { frames: 40, points: 300, seed: 10, outliers: 0 });
    const p = problemFrom(shot, 0.05);
    p.intr.f *= 1.02;
    p.refine = { f: true };
    const r = bundleAdjust(p, { loss: 'none', maxIterations: 30 });
    expect(r.finalCost).toBeLessThan(r.initialCost / 100);
    // 0.5 px RMS noise, less the parameters' share of it.
    expect(r.rms).toBeGreaterThan(0.4);
    expect(r.rms).toBeLessThan(0.52);
    expect(Math.abs(p.intr.f - shot.intr.f) / shot.intr.f).toBeLessThan(0.003);
  });

  it('holds fixed points (control points) and pulls points towards priors', () => {
    const shot = syntheticShot('pan', { frames: 20, points: 120, seed: 11, outliers: 0 });
    const p = problemFrom(shot, 0.0);
    // Fix point 0 at a wrong place: the cameras must move to explain it a little, but it never moves.
    p.pointFixed[0] = 1;
    const fixed = [p.X[0]!, p.X[1]!, p.X[2]!];
    const target: [number, number, number] = [p.X[3]! + 0.05, p.X[4]! - 0.03, p.X[5]!];
    const before = Math.hypot(p.X[3]! - target[0], p.X[4]! - target[1], p.X[5]! - target[2]);
    p.priors = [{ point: 1, X: target, sigma: 1e-4 }];
    bundleAdjust(p, { loss: 'huber', maxIterations: 10 });
    expect([p.X[0], p.X[1], p.X[2]]).toEqual(fixed);
    const after = Math.hypot(p.X[3]! - target[0], p.X[4]! - target[1], p.X[5]! - target[2]);
    expect(after).toBeLessThan(before / 20);
  });

  it('robust losses keep outliers from moving a camera', () => {
    const shot = syntheticShot('dolly', { frames: 12, points: 200, seed: 12, outliers: 0 });
    for (const loss of ['huber', 'cauchy'] as const) {
      const p = problemFrom(shot, 0);
      // Corrupt 10 % of observations by 30 px.
      for (let o = 0; o < p.obsCam.length; o += 10) p.obsUV[2 * o]! += 30;
      bundleAdjust(p, { loss, delta: 1, maxIterations: 20 });
      const res = { frames: shot.path.map((_, i) => ({ frame: i, solved: true, R: Array.from(p.R.subarray(9 * i, 9 * i + 9)), t: Array.from(p.t.subarray(3 * i, 3 * i + 3)), keyframe: false, rms: 0, tracks: 0 })), tracks: [] } as unknown as SolveResult;
      const err = comparePath(res, shot.path, sceneScaleOf(shot.points));
      expect(err.maxPosition).toBeLessThan(0.003);
    }
  });
});

describe('similarity alignment', () => {
  it('Umeyama recovers a similarity exactly and its residual is zero', () => {
    const pts = scenePoints(30, 13);
    const T = { s: 2.5, R: rodrigues([0.3, -0.2, 0.9]), t: [1, -2, 3] };
    const dst = new Float64Array(90);
    for (let i = 0; i < 30; i += 1) dst.set(applySim(T, [pts[3 * i]!, pts[3 * i + 1]!, pts[3 * i + 2]!]), 3 * i);
    const u = umeyama(pts, dst);
    expect(u.s).toBeCloseTo(2.5, 9);
    for (let k = 0; k < 9; k += 1) expect(u.R[k]!).toBeCloseTo(T.R[k]!, 9);
    for (let k = 0; k < 3; k += 1) expect(u.t[k]!).toBeCloseTo(T.t[k]!, 9);
    expect(u.rms).toBeLessThan(1e-9);
    expect(project).toBeTypeOf('function');
  });
});
