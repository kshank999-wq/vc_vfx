import { describe, expect, it } from 'vitest';
import { pixelToRay, project, rayToPixel, type Intrinsics } from '../camera/geometry';
import { solveTracks, type SolveResult } from '../camera/solver';
import { comparePath, sceneScaleOf } from '../camera/evaluate';
import { cameraPath, observe, scenePoints, type SyntheticShot } from '../camera/synthetic';
import { redistortMap, sampleSTMap, undistortMap } from '../camera/stmap';

/**
 * Non-square pixels in the camera solver (addendum 17): a scene shot through
 * an anamorphic camera and kept squeezed — 2× (a 2.39:1 picture stored
 * 1224 × 1024) and 1.5× (DVCPRO HD 1080, 1280 × 1080 shown 1920 × 1080) —
 * with and without anamorphic distortion. The plate's pixels are what is
 * tracked; the solve must recover the de-squeezed focal, the distortion on
 * physical coordinates and the path, with residuals in plate pixels.
 */

const SECONDS = 1000;

function check(shot: SyntheticShot, res: SolveResult, nodal = false) {
  expect(res.ok).toBe(true);
  expect(res.stats.framesSolved).toBe(res.stats.framesTotal);
  return comparePath(res, shot.path, sceneScaleOf(shot.points), { nodal, points: { truth: shot.truth, X: shot.points } });
}

describe('pixel aspect in the lens model', () => {
  it('maps rays to squeezed pixels and back: fx = f / a, fy = f', () => {
    const k: Intrinsics = { f: 1600, cx: 611.5, cy: 511.5, k1: -0.05, k2: 0.01, k3: 0, p1: 0, p2: 0, a: 2 };
    const [u, v] = rayToPixel(k, 0.2, 0.1);
    const r2 = 0.2 ** 2 + 0.1 ** 2;
    const radial = 1 + k.k1 * r2 + k.k2 * r2 * r2;
    expect(u).toBeCloseTo((1600 / 2) * 0.2 * radial + 611.5, 9);
    expect(v).toBeCloseTo(1600 * 0.1 * radial + 511.5, 9);
    const back = pixelToRay(k, u, v);
    expect(back[0]).toBeCloseTo(0.2, 9);
    expect(back[1]).toBeCloseTo(0.1, 9);
    // A point 1 m right and 1 m up at 10 m lands 80 px right (squeezed) and 160 px up.
    const p = project({ ...k, k1: 0, k2: 0 }, [1, 0, 0, 0, 1, 0, 0, 0, 1], [0, 0, 0], [1, -1, 10])!;
    expect(p[0] - k.cx).toBeCloseTo(80, 9);
    expect(k.cy - p[1]).toBeCloseTo(160, 9);
  });

  it('STMaps in squeezed plate space, distortion on physical coordinates', () => {
    const k: Intrinsics = { f: 1000, cx: 319.5, cy: 239.5, k1: -0.08, k2: 0, k3: 0, p1: 0, p2: 0, a: 2 };
    const W = 640;
    const H = 480;
    const und = undistortMap(k, W, H);
    const red = redistortMap(k, W, H);
    // A corner pixel of the undistorted output samples the plate where the forward model puts it.
    const [sx, sy] = sampleSTMap(und, 10, 10);
    const ray = pixelToRay({ ...k, k1: 0 }, 10, 10);
    const expected = rayToPixel(k, ray[0], ray[1]);
    expect(sx).toBeCloseTo(expected[0], 3);
    expect(sy).toBeCloseTo(expected[1], 3);
    // Barrel distortion pulls more in x than a square-pixel model would think from the squeezed width.
    const round = sampleSTMap(red, Math.round(sx), Math.round(sy));
    expect(Math.abs(round[0] - Math.round(sx)) + Math.abs(round[1] - Math.round(sy))).toBeGreaterThan(0);
  });
});

describe('camera solver: anamorphic plates kept squeezed', () => {
  for (const { a, W, H, f } of [
    { a: 2, W: 1224, H: 1024, f: 2400 },
    { a: 1.5, W: 1280, H: 1080, f: 1900 },
  ]) {
    it(`${a}× squeeze, focal self-calibrated, path and focal recovered`, async () => {
      const intr: Intrinsics = { f, cx: (W - 1) / 2, cy: (H - 1) / 2, k1: 0, k2: 0, k3: 0, p1: 0, p2: 0, a };
      const shot = observe(cameraPath('pan', 90, 102 + a), scenePoints(650, 202), { intr, width: W, height: H, seed: 11 });
      const res = await solveTracks(shot.tracks, { focal: { mode: 'unknown' }, pixelAspect: a });
      const err = check(shot, res);
      expect(res.intrinsics.a).toBe(a);
      expect(Math.abs(res.intrinsics.f - f) / f).toBeLessThan(0.01);
      expect(res.stats.rms).toBeLessThan(0.7);
      expect(err.maxPosition).toBeLessThan(0.005);
      expect(err.maxRotationDeg).toBeLessThan(0.2);
      // Treating the same plate as square pixels cannot fit it as well.
      const square = await solveTracks(shot.tracks, { focal: { mode: 'unknown' } });
      const sqErr = square.ok ? comparePath(square, shot.path, sceneScaleOf(shot.points), { nodal: false, points: { truth: shot.truth, X: shot.points } }) : null;
      expect(!square.ok || square.stats.rms > 1.5 * res.stats.rms || (sqErr?.maxRotationDeg ?? 99) > 1).toBe(true);
    }, 60 * SECONDS);
  }

  it('2× squeeze with anamorphic barrel distortion on physical coordinates', async () => {
    const W = 1224;
    const H = 1024;
    const intr: Intrinsics = { f: 2200, cx: (W - 1) / 2, cy: (H - 1) / 2, k1: -0.12, k2: 0.03, k3: 0, p1: 0, p2: 0, a: 2 };
    const shot = observe(cameraPath('pan', 80, 105), scenePoints(650, 205), { intr, width: W, height: H, seed: 5 });
    const res = await solveTracks(shot.tracks, { focal: { mode: 'approx', px: 2000 }, refine: { k1k2: true }, pixelAspect: 2 });
    const err = check(shot, res);
    expect(Math.abs(res.intrinsics.f - intr.f) / intr.f).toBeLessThan(0.01);
    expect(Math.abs(res.intrinsics.k1 - intr.k1)).toBeLessThan(0.015);
    // At the frame corner (physical radius from the de-squeezed half diagonal), under 1 plate pixel.
    const rc = Math.hypot((W / 2) * 2, H / 2) / intr.f;
    const radial = (k: Intrinsics) => 1 + k.k1 * rc ** 2 + k.k2 * rc ** 4;
    expect(Math.abs(radial(res.intrinsics) - radial(intr)) * rc * intr.f).toBeLessThan(1.5);
    expect(res.stats.rms).toBeLessThan(0.7);
    expect(err.maxPosition).toBeLessThan(0.005);
    expect(err.maxRotationDeg).toBeLessThan(0.2);
  }, 60 * SECONDS);

  it('a nodal pan on a 1.5× plate: focal from the homographies', async () => {
    const W = 1280;
    const H = 1080;
    const intr: Intrinsics = { f: 1800, cx: (W - 1) / 2, cy: (H - 1) / 2, k1: 0, k2: 0, k3: 0, p1: 0, p2: 0, a: 1.5 };
    const shot = observe(cameraPath('nodal', 90, 104), scenePoints(650, 204), { intr, width: W, height: H, seed: 4 });
    const res = await solveTracks(shot.tracks, { focal: { mode: 'unknown' }, pixelAspect: 1.5 });
    const err = check(shot, res, true);
    expect(res.stats.nodal).toBe(true);
    expect(Math.abs(res.intrinsics.f - intr.f) / intr.f).toBeLessThan(0.01);
    expect(err.maxRotationDeg).toBeLessThan(0.2);
  }, 60 * SECONDS);
});
