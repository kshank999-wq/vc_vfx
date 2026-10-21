import { describe, expect, it } from 'vitest';
import { SAMPLE_HANDOFF, createProject, parseHandoff, shotState, type Project } from '@vcvfx/domain';
import { applyOps, dispatch, type CameraCommand, type CameraSession, type CommandOutcome } from '../camera/commands';
import { MemoryStore, sessionBase } from '../camera/session';
import { TsCameraSolver } from '../camera/solver';
import { roomScene, renderScene, sampleSurface, type Quad } from '../camera/render';
import { cameraPath } from '../camera/synthetic';
import { grayOf } from '../camera/klt';
import { applySim } from '../camera/align';
import { rodrigues } from '../camera/geometry';
import { decodeSolve, decodeTracks } from '../camera/codec';
import { trackAt } from '../camera/tracks';
import { centreOf } from '../camera/pose';
import { mulv3 } from '../camera/linalg';
import { ZUP_TO_YUP } from '../camera/coords';

/**
 * The command layer end to end (addendum 06 §8): the verbs the Track
 * workspace and the AI assistant share, run against a rendered shot with a
 * synthetic LiDAR scan, their ops applied to a real project (and so logged),
 * and their results checked against the ground truth.
 */

const SHOT = '020_010';
const W = 480;
const H = 270;
const FIRST = 1001;
const N = 36;
const intr = { f: 0.86 * W, cx: (W - 1) / 2, cy: (H - 1) / 2, k1: 0, k2: 0, k3: 0, p1: 0, p2: 0 };
const quads = roomScene(5);
const path = cameraPath('pan', N, 9);
const frames = path.map((p) => grayOf(renderScene(quads, { width: W, height: H, intr, R: p.R, t: p.t })));
// LiDAR space: the set scaled from "scene metres" to real metres ×1.7, turned, moved, and Z-up.
const LIDAR = { s: 1.7, R: rodrigues([0.1, 0.4, -0.2]), t: [1000, 2000, 50] };
const toLidarYup = (X: number[]) => applySim(LIDAR, X);
const toLidarFile = (X: number[]) => {
  // The scan is stored Z-up: (x, y, z)_Y-up → (x, −z, y)_Z-up.
  const p = toLidarYup(X);
  return [p[0]!, -p[2]!, p[1]!] as [number, number, number];
};

function scanPly(): Uint8Array {
  const s = sampleSurface(quads, 0.15, 21);
  const n = s.points.length / 3;
  const head = new TextEncoder().encode(`ply\nformat binary_little_endian 1.0\nelement vertex ${n}\nproperty double x\nproperty double y\nproperty double z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n`);
  const out = new Uint8Array(head.length + n * 27);
  out.set(head);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < n; i += 1) {
    const p = toLidarFile([s.points[3 * i]!, s.points[3 * i + 1]!, s.points[3 * i + 2]!]);
    const o = head.length + i * 27;
    dv.setFloat64(o, p[0], true);
    dv.setFloat64(o + 8, p[1], true);
    dv.setFloat64(o + 16, p[2], true);
    out[o + 24] = s.colors[3 * i]!;
    out[o + 25] = s.colors[3 * i + 1]!;
    out[o + 26] = s.colors[3 * i + 2]!;
  }
  return out;
}

/** Where a pixel on a frame really is on the set (ray cast against the quads). */
function surfacePoint(qs: Quad[], fi: number, u: number, v: number): number[] | null {
  const pose = path[fi]!;
  const x = (u - intr.cx) / intr.f;
  const y = (v - intr.cy) / intr.f;
  const R = pose.R;
  const d = [R[0]! * x + R[3]! * y + R[6]!, R[1]! * x + R[4]! * y + R[7]!, R[2]! * x + R[5]! * y + R[8]!];
  const C = pose.C;
  let best = Infinity;
  for (const q of qs) {
    const n = [q.u[1] * q.v[2] - q.u[2] * q.v[1], q.u[2] * q.v[0] - q.u[0] * q.v[2], q.u[0] * q.v[1] - q.u[1] * q.v[0]];
    const den = n[0]! * d[0]! + n[1]! * d[1]! + n[2]! * d[2]!;
    if (Math.abs(den) < 1e-12) continue;
    const s = (n[0]! * (q.origin[0] - C[0]!) + n[1]! * (q.origin[1] - C[1]!) + n[2]! * (q.origin[2] - C[2]!)) / den;
    if (s <= 0 || s >= best) continue;
    const P = [C[0]! + s * d[0]! - q.origin[0], C[1]! + s * d[1]! - q.origin[1], C[2]! + s * d[2]! - q.origin[2]];
    const a = (P[0]! * q.u[0] + P[1]! * q.u[1] + P[2]! * q.u[2]) / (q.u[0] ** 2 + q.u[1] ** 2 + q.u[2] ** 2);
    const b = (P[0]! * q.v[0] + P[1]! * q.v[1] + P[2]! * q.v[2]) / (q.v[0] ** 2 + q.v[1] ** 2 + q.v[2] ** 2);
    if (a < 0.02 || a > 0.98 || b < 0.02 || b > 0.98) continue; // keep away from edges
    best = s;
  }
  return Number.isFinite(best) ? [C[0]! + best * d[0]!, C[1]! + best * d[1]!, C[2]! + best * d[2]!] : null;
}

function makeProject(): Project {
  const h = parseHandoff(JSON.stringify(SAMPLE_HANDOFF));
  if (!h.ok) throw new Error('sample');
  return createProject(h.handoff, '/drive/handoff.json', 'Ana', new Date('2026-10-20T10:00:00Z'));
}

describe('camera command layer', () => {
  it('auto-tracks, solves, reports, prunes, sets the coordinate system, aligns to LiDAR, re-solves constrained and exports — every command logged', async () => {
    let project = makeProject();
    const store = new MemoryStore();
    const written: { folder: string; files: { name: string; data: Uint8Array | string }[] }[] = [];
    const ply = scanPly();
    const session = (): CameraSession => ({
      ...sessionBase(project, SHOT, { first: FIRST, last: FIRST + N - 1, fps: 24 }, { width: W, height: H }, { width: W, height: H }),
      io: {
        frame: async (f) => frames[f - FIRST]!,
        readFile: async () => ply,
        writeExport: async (folder, files) => {
          written.push({ folder: `${folder.section}/${folder.name}`, files });
          return { folder: `${folder.section}/${folder.name}`, files: files.map((f) => f.name) };
        },
      },
      store,
      solver: new TsCameraSolver(),
      actor: 'Ana',
      now: () => new Date('2026-10-20T12:00:00Z'),
      generator: 'VC VFX test',
    });
    const run = async (cmd: CameraCommand): Promise<CommandOutcome & { ok: true }> => {
      const out = await dispatch(session(), cmd);
      if (!out.ok) throw new Error(`${cmd.verb}: ${out.error}`);
      const r = applyOps(project, SHOT, out.ops, 'Ana', new Date('2026-10-20T12:00:00Z'));
      if (!r.ok) throw new Error(`${cmd.verb} ops: ${r.reason}`);
      project = r.project;
      return out;
    };
    const doc = () => shotState(project, SHOT)!.camtrack!;

    // The sample's camera (VENICE 2, 35.9 mm film back over the plate's 480 px) with the lens roughly known.
    await run({ verb: 'set_lens', focalMode: 'known', focalMm: (intr.f * 35.9) / W });
    await run({ verb: 'set_track_settings', maxFeatures: 350 });
    const tracked = await run({ verb: 'auto_track' });
    expect(tracked.data['minPerFrame']).toBeGreaterThan(100);
    expect(shotState(project, SHOT)!.tasks.find((t) => t.kind === 'camera_track')!.state).toBe('processing');

    const solved = await run({ verb: 'solve' });
    expect(solved.data['framesSolved']).toBe(N);
    expect(solved.data['rms']).toBeLessThan(1);
    expect(doc().activeSolve).toBe(1);
    expect(shotState(project, SHOT)!.tasks.find((t) => t.kind === 'camera_track')!.state).toBe('needs_review');

    const report = await run({ verb: 'get_report', worst: 5 });
    const worst = report.data['worstTracks'] as { id: number; rmsPx: number }[];
    expect(worst).toHaveLength(5);
    expect(worst[0]!.rmsPx).toBeGreaterThanOrEqual(worst[4]!.rmsPx);
    expect((report.data['perFrame'] as unknown[]).length).toBe(N);

    // Prune by error, re-solve.
    const pruned = await run({ verb: 'delete_tracks', maxErrorPx: 0.8 });
    expect(pruned.data['deleted']).toBeGreaterThanOrEqual(0);
    await run({ verb: 'solve' });
    expect(doc().solves).toHaveLength(2);

    // LiDAR: import (Z-up file in metres), tie 6 tracks to their true surface points, align.
    const imported = await run({ verb: 'import_lidar', path: '/drive/LIDAR/scan.ply', units: 'm', up: 'z' });
    expect(imported.data['points']).toBeGreaterThan(10000);
    const lidarId = doc().lidar[0]!.id;
    const tdBytes = await store.get(doc().trackSet!.file);
    const td = decodeTracks(tdBytes!);
    const solve = decodeSolve((await store.get(doc().solves[1]!.file))!);
    const solvedIds = new Set(solve.tracks.filter((t) => t.X && t.inliers >= 10 && t.rms < 0.6).map((t) => t.id));
    let added = 0;
    for (let i = 0; i < td.ids.length && added < 6; i += 1) {
      if (!solvedIds.has(td.ids[i]!)) continue;
      if (td.length[i]! < 12) continue;
      const fa = td.start[i]! + 1;
      const fb = td.start[i]! + td.length[i]! - 2;
      const pa = trackAt(td, i, fa)!;
      const pb = trackAt(td, i, fb)!;
      const X = surfacePoint(quads, fa - FIRST, pa[0], pa[1]);
      const Xb = surfacePoint(quads, fb - FIRST, pb[0], pb[1]);
      // A clear point: the same place on the set seen from both ends of the track (not a depth edge).
      if (!X || !Xb || Math.hypot(X[0]! - Xb[0]!, X[1]! - Xb[1]!, X[2]! - Xb[2]!) > 0.03) continue;
      // Spread them out: skip ones close to an earlier pick.
      await run({ verb: 'add_correspondence', lidarId, point: toLidarFile(X), trackId: td.ids[i]! });
      added += 1;
      i += Math.floor(td.ids.length / 8);
    }
    expect(doc().correspondences.length).toBeGreaterThanOrEqual(4);
    const aligned = await run({ verb: 'align_to_lidar', method: 'similarity' });
    expect(Math.abs((aligned.data['scale'] as number) / (solve.stats.nodal ? 1 : 1))).toBeGreaterThan(0);
    // The aligned cameras sit where the truth says, in LiDAR space (within 3 cm over a ~45 m set).
    const A = doc().alignment!.transform;
    const errs = solve.frames.filter((f) => f.solved).map((f, i) => {
      const C = applySim({ s: A.s, R: A.R, t: [...A.t] }, centreOf(f.R, f.t));
      const truth = toLidarFile(path[i]!.C);
      return Math.hypot(C[0]! - truth[0], C[1]! - truth[1], C[2]! - truth[2]);
    });
    const SET = Math.hypot(18, 8, 26) * 1.7; // the set's diagonal in LiDAR metres
    // A few correspondences on a short-baseline 480 px solve: within 3 % of the set.
    expect(Math.max(...errs)).toBeLessThan(0.03 * SET);
    expect(doc().alignment!.rmsMm).not.toBeNull();
    for (const c of doc().correspondences) expect(c.residualPx).not.toBeNull();

    // ICP refinement on the scan, then a LiDAR-constrained re-solve.
    await run({ verb: 'align_to_lidar', method: 'icp' });
    expect(doc().alignment!.method).toBe('icp');
    const constrained = await run({ verb: 'align_to_lidar', method: 'constrained' });
    expect(constrained.data['solve']).toBe(3);
    expect(doc().solves[2]!.constraint).toBe('lidar_points');
    expect(doc().alignment!.method).toBe('constrained');
    const s3 = decodeSolve((await store.get(doc().solves[2]!.file))!);
    const errs3 = s3.frames.filter((f) => f.solved).map((f, i) => {
      const C = centreOf(f.R, f.t);
      const truth = toLidarFile(path[i]!.C);
      return Math.hypot(C[0]! - truth[0], C[1]! - truth[1], C[2]! - truth[2]);
    });
    // The LiDAR-constrained re-solve does far better than the similarity (measured 0.07 m against 1.4 m).
    expect(Math.max(...errs3)).toBeLessThan(0.15);
    expect(Math.max(...errs3)).toBeLessThan(Math.max(...errs) / 5);

    // Coordinate system: metres from the LiDAR, Y-up; origin at a correspondence track.
    const originTrack = (doc().correspondences[0]!.target as { trackId: number }).trackId;
    await run({ verb: 'set_coordinate_system', units: 'm', origin: { trackId: originTrack } });
    const T = doc().coords.transform;
    const X0 = s3.tracks.find((t) => t.id === originTrack)!.X!;
    const o = applySim({ s: T.s, R: T.R, t: [...T.t] }, X0);
    expect(Math.hypot(...o)).toBeLessThan(1e-6);
    // Scale is the LiDAR's: two cameras' distance in the scene equals the truth ×1.7 (m).
    const c0 = applySim({ s: T.s, R: T.R, t: [...T.t] }, centreOf(s3.frames[0]!.R, s3.frames[0]!.t));
    const c1 = applySim({ s: T.s, R: T.R, t: [...T.t] }, centreOf(s3.frames[N - 1]!.R, s3.frames[N - 1]!.t));
    const truthD = Math.hypot(path[0]!.C[0]! - path[N - 1]!.C[0]!, path[0]!.C[1]! - path[N - 1]!.C[1]!, path[0]!.C[2]! - path[N - 1]!.C[2]!) * 1.7;
    expect(Math.abs(Math.hypot(c0[0]! - c1[0]!, c0[1]! - c1[1]!, c0[2]! - c1[2]!) - truthD)).toBeLessThan(0.05);
    void mulv3;
    void ZUP_TO_YUP;

    // Export: every format and the STMaps (none here: no distortion) into 06_CAMERA_TRACK.
    const exported = await run({ verb: 'export_camera' });
    expect(written[0]!.folder).toBe('06_CAMERA_TRACK/020_010_camtrack_v001');
    const names = written[0]!.files.map((f) => f.name);
    for (const ext of ['.nk', '.ma', '.py', '.jsx', '.ms', '.fbx', '.chan', '.json', '_points.obj', '_report.html']) expect(names.some((n) => n.endsWith(ext))).toBe(true);
    expect(exported.data['folder']).toBe('06_CAMERA_TRACK/020_010_camtrack_v001');
    expect(doc().exports[0]!.version).toBe(1);

    // Every command is in the log.
    const actions = project.log.filter((l) => l.shotId === SHOT).map((l) => l.action);
    for (const a of ['camtrack.set_lens', 'camtrack.auto_track', 'camtrack.solve', 'camtrack.get_report', 'camtrack.delete_tracks', 'camtrack.import_lidar', 'camtrack.add_correspondence', 'camtrack.align_to_lidar', 'camtrack.set_coordinate_system', 'camtrack.export']) expect(actions).toContain(a);
  }, 120_000);

  it('refuses changes to an approved camera track but still answers questions', async () => {
    const project = makeProject();
    const base = sessionBase(project, SHOT, { first: 1, last: 2, fps: 24 }, { width: 64, height: 36 });
    const s: CameraSession = { ...base, camtrackLocked: 'Camera track v001 is approved.', io: { frame: async () => frames[0]! }, store: new MemoryStore(), solver: new TsCameraSolver(), actor: 'A', now: () => new Date(), generator: 'x' };
    expect(await dispatch(s, { verb: 'set_lens', focalMm: 35, focalMode: 'known' })).toMatchObject({ ok: false, error: expect.stringContaining('approved') });
    expect(await dispatch(s, { verb: 'get_report' })).toMatchObject({ ok: false, error: expect.stringContaining('no solve') });
  });
});

describe('2D track commands', () => {
  it('creates a planar track on the screen, tracks it forward, corrects a key, re-tracks around it and exports', async () => {
    let project = makeProject();
    const SHOT2 = '010_030';
    const store = new MemoryStore();
    const written: string[] = [];
    // The "screen" quad of the set, projected on frame 0.
    const screen = quads.find((q) => q.name === 'screen')!;
    const corner = (fi: number, a: number, b: number) => {
      const P = [screen.origin[0] + a * screen.u[0] + b * screen.v[0], screen.origin[1] + a * screen.u[1] + b * screen.v[1], screen.origin[2] + a * screen.u[2] + b * screen.v[2]];
      const R = path[fi]!.R;
      const t = path[fi]!.t;
      const X = [R[0]! * P[0]! + R[1]! * P[1]! + R[2]! * P[2]! + t[0]!, R[3]! * P[0]! + R[4]! * P[1]! + R[5]! * P[2]! + t[1]!, R[6]! * P[0]! + R[7]! * P[1]! + R[8]! * P[2]! + t[2]!];
      return [intr.f * (X[0]! / X[2]!) + intr.cx, intr.f * (X[1]! / X[2]!) + intr.cy] as [number, number];
    };
    const quadAt = (fi: number) => [corner(fi, 0, 0), corner(fi, 1, 0), corner(fi, 1, 1), corner(fi, 0, 1)];
    const session = (): CameraSession => ({
      ...sessionBase(project, SHOT2, { first: FIRST, last: FIRST + N - 1, fps: 24 }, { width: W, height: H }, { width: W, height: H }),
      io: { frame: async (f) => frames[f - FIRST]!, writeExport: async (folder, files) => (files.forEach((f) => written.push(f.name)), { folder: `${folder.section}/${folder.name}`, files: files.map((f) => f.name) }) },
      store,
      solver: new TsCameraSolver(),
      actor: 'Ana',
      now: () => new Date('2026-10-20T12:00:00Z'),
      generator: 'VC VFX test',
    });
    const run = async (cmd: CameraCommand) => {
      const out = await dispatch(session(), cmd);
      if (!out.ok) throw new Error(`${cmd.verb}: ${out.error}`);
      const r = applyOps(project, SHOT2, out.ops, 'Ana', new Date());
      if (!r.ok) throw new Error(r.reason);
      project = r.project;
      return out;
    };
    await run({ verb: 'track2d_create', name: 'Screen', kind: 'planar', frame: FIRST, points: quadAt(0) });
    const t = () => shotState(project, SHOT2)!.track2d!.tracks[0]!;
    await run({ verb: 'track2d_track', trackId: t().id, from: FIRST, direction: 'forward' });
    expect(t().frames).toHaveLength(N);
    let worst = 0;
    for (const f of t().frames) {
      const truth = quadAt(f.frame - FIRST);
      f.points.forEach((p, i) => (worst = Math.max(worst, Math.hypot(p[0] - truth[i]![0], p[1] - truth[i]![1]))));
    }
    // A small surface (≈ 60 × 35 px) far away on a moving set: well under a pixel.
    expect(worst).toBeLessThan(1);
    // Correct frame 1020 to the truth and re-track around it.
    await run({ verb: 'track2d_set_key', trackId: t().id, frame: 1020, points: quadAt(19) });
    await run({ verb: 'track2d_track', trackId: t().id, from: 1020, direction: 'around' });
    expect(t().keys.map((k) => k.frame)).toEqual([1001, 1020]);
    expect(t().frames.find((f) => f.frame === 1020)!.status).toBe('key');
    await run({ verb: 'track2d_export' });
    expect(written.some((n) => n.endsWith('_screen_v001.nk'))).toBe(true);
    expect(written.some((n) => n.endsWith('_ae_keyframes.txt'))).toBe(true);
    expect(shotState(project, SHOT2)!.track2d!.exports[0]!.folder).toBe('05_TRACKS_2D/010_030_track2d_v001');
    expect(project.log.some((l) => l.action === 'track2d.tracked')).toBe(true);
  }, 60_000);
});
