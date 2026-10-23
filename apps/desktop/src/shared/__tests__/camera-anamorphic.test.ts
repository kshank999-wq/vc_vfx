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

describe('camera commands on a 2× plate: solve and export through the session', () => {
  it('tracks the squeezed frames, solves at the shot’s pixel aspect, records focal mm on the de-squeezed back, exports it', async () => {
    const { SAMPLE_HANDOFF, createProject, parseHandoff, setShotPixelAspect, shotState } = await import('@vcvfx/domain');
    const { applyOps, dispatch } = await import('../camera/commands');
    const { MemoryStore, sessionBase } = await import('../camera/session');
    const { TsCameraSolver } = await import('../camera/solver');
    const { roomScene, renderScene } = await import('../camera/render');
    const { grayOf } = await import('../camera/klt');
    const SHOT = '020_010';
    const W = 360; // stored
    const H = 300;
    const A = 2; // shown 720 × 300
    const N = 30;
    const intr: Intrinsics = { f: 0.86 * W * A, cx: (W - 1) / 2, cy: (H - 1) / 2, k1: 0, k2: 0, k3: 0, p1: 0, p2: 0, a: A };
    const quads = roomScene(5);
    const path = cameraPath('pan', N, 9);
    const frames = path.map((p) => grayOf(renderScene(quads, { width: W, height: H, intr, R: p.R, t: p.t })));
    const h = parseHandoff(JSON.stringify(SAMPLE_HANDOFF));
    if (!h.ok) throw new Error('sample');
    let project = createProject(h.handoff, '/drive/handoff.json', 'Ana', new Date('2026-10-22T10:00:00Z'));
    const par = setShotPixelAspect(project, SHOT, { value: A, note: '2× anamorphic' }, 'Ana', new Date('2026-10-22T10:00:00Z'));
    if (!par.ok) throw new Error(par.reason);
    project = par.project;
    const store = new MemoryStore();
    const written: { name: string; data: Uint8Array | string }[] = [];
    const run = async (cmd: Parameters<typeof dispatch>[1]) => {
      const out = await dispatch(
        {
          ...sessionBase(project, SHOT, { first: 1001, last: 1000 + N, fps: 24 }, { width: W, height: H }, { width: W, height: H }),
          io: { frame: async (f) => frames[f - 1001]!, writeExport: async (folder, files) => (written.push(...files), { folder: folder.name, files: files.map((f) => f.name) }) },
          store,
          solver: new TsCameraSolver(),
          actor: 'Ana',
          now: () => new Date('2026-10-22T12:00:00Z'),
          generator: 'VC VFX test',
        },
        cmd,
      );
      if (!out.ok) throw new Error(`${cmd.verb}: ${out.error}`);
      const r = applyOps(project, SHOT, out.ops, 'Ana', new Date('2026-10-22T12:00:00Z'));
      if (!r.ok) throw new Error(r.reason);
      project = r.project;
      return out;
    };
    // A 12 × 10 mm sensor area behind a 2× lens: the picture is 24 mm wide.
    await run({ verb: 'set_camera', filmBackMm: { width: 12, height: 10 } });
    const trueMm = (intr.f * 24) / (W * A);
    await run({ verb: 'set_lens', focalMode: 'approx', focalMm: trueMm * 1.1 });
    await run({ verb: 'set_track_settings', maxFeatures: 300 });
    await run({ verb: 'auto_track' });
    await run({ verb: 'solve' });
    const rec = shotState(project, SHOT)!.camtrack!.solves.at(-1)!;
    expect(rec.intrinsics.pixelAspect).toBe(2);
    expect(rec.stats.framesSolved).toBe(N);
    expect(rec.stats.rms).toBeLessThan(1);
    expect(Math.abs(rec.intrinsics.focalMm! - trueMm) / trueMm).toBeLessThan(0.02);
    await run({ verb: 'export_camera', formats: ['nuke', 'blender', 'json'], stmaps: false });
    const nk = written.find((f) => f.name.endsWith('.nk'))!.data as string;
    expect(nk).toContain(`format "${W} ${H} 0 0 ${W} ${H} 2 `);
    expect(Number(/haperture ([\d.]+)/.exec(nk)![1])).toBeCloseTo(24, 3);
    const json = JSON.parse(written.find((f) => f.name.endsWith('.json'))!.data as string);
    expect(json.plate.pixelAspect).toBe(2);
    expect(json.filmBackMm.sensor).toEqual({ width: 12, height: 10 });
    const report = written.find((f) => f.name.endsWith('_report.html'))!.data as string;
    expect(report).toMatch(/pixel aspect 2<\/b>/);
  }, 120 * SECONDS);
});

describe('checkerboard calibration of an anamorphic lens', () => {
  it('measures fx ≠ fy (the pixel aspect) and gives the solver f and physical distortion', async () => {
    const { boardPoints, calibrateZhang, calibrationIntrinsics, measuredPixelAspect } = await import('../camera/calibration');
    const { rodrigues } = await import('../camera/geometry');
    const lens: Intrinsics = { f: 1800, cx: 640, cy: 538, k1: -0.15, k2: 0.04, k3: 0, p1: 0, p2: 0, a: 1.5 };
    const board = boardPoints({ cols: 10, rows: 7, squareMm: 30 });
    const poses: [number, number, number, number, number][] = [
      [0, 0, 0, 0, 0], [0.35, 0, 0, 0, 0], [-0.3, 0.2, 0.1, 0, 0], [0, 0.4, -0.05, 0, 0],
      [0.2, 0.25, 0.05, -150, -85], [-0.2, 0.25, -0.05, 150, -85], [0.2, -0.25, 0.05, -150, 85], [-0.2, -0.25, -0.05, 150, 85],
    ];
    const views = poses.map(([rx, ry, rz, tx, ty]) => {
      const R = rodrigues([rx, ry, rz]);
      const t = [tx - 135, ty - 90, 800];
      return board.map(([X, Y]) => project(lens, R, t, [X, Y, 0])!);
    });
    const c = calibrateZhang(board, views, {});
    expect(measuredPixelAspect(c)).toBeCloseTo(1.5, 3);
    const k = calibrationIntrinsics(c, 1.5);
    expect(Math.abs(k.f - lens.f) / lens.f).toBeLessThan(0.002);
    expect(k.k1).toBeCloseTo(lens.k1, 3);
    expect(k.a).toBe(1.5);
  });
});
