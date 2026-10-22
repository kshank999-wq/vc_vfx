import { describe, expect, it } from 'vitest';
import {
  CAMERA_DB,
  PREP_TASKS,
  PROJECT_VERSION,
  SAMPLE_HANDOFF,
  activeSolve,
  addCustomCamera,
  addTask,
  applyCamTrack,
  approveTask,
  buildManifest,
  camNextId,
  camtrackLocked,
  camtrackNames,
  createProject,
  createTrack2d,
  findLensProfile,
  focalMillimetres,
  focalPixels,
  lensProfileId,
  matchCamera,
  newCamTrackDocument,
  parseHandoff,
  parseProject,
  recordCamExport,
  recordTrack2dExport,
  recordTrack2dRun,
  removeTrack2d,
  removeTrack2dKey,
  saveLensProfile,
  serializeProject,
  setTaskState,
  setTrack2dKey,
  shotState,
  track2dSpan,
  type CamTrackDocument,
  type Project,
  type SolveRecord,
} from '../index.js';

const now = new Date('2026-10-20T10:00:00Z');
const later = new Date('2026-10-20T11:00:00Z');

function project(): Project {
  const h = parseHandoff(JSON.stringify(SAMPLE_HANDOFF));
  if (!h.ok) throw new Error('sample');
  return createProject(h.handoff, '/drive/handoff.json', 'Test', now);
}

const CAM_SHOT = '020_010';
const TRACK_SHOT = '010_030';

const solve = (n: number, taskVersion = 1): SolveRecord => ({
  number: n,
  taskVersion,
  file: `solve-${n}`,
  tracks: 'tracks-0001',
  engine: { id: 'vcvfx-ts', version: '1.0.0' },
  settings: { focal: 'unknown' },
  intrinsics: { focalPx: 1600, focalMm: 30.1, cx: 959.5, cy: 539.5, k1: 0, k2: 0, k3: 0, p1: 0, p2: 0 },
  stats: { rms: 0.48, medianError: 0.4, framesSolved: 264, framesTotal: 264, tracksUsed: 900, tracksTotal: 1200, keyframes: 20, nodal: false, confidence: 0.97, minTracksPerFrame: 120, warnings: [], ms: 4000 },
  constraint: 'none',
  at: now.toISOString(),
  by: 'Test',
});

describe('camera database', () => {
  it('has every family the spec names, with plausible film backs and honest verification flags', () => {
    const makes = new Set(CAMERA_DB.map((c) => c.make));
    for (const m of ['ARRI', 'RED', 'Sony', 'Canon', 'Blackmagic Design', 'Panasonic', 'Apple']) expect(makes.has(m)).toBe(true);
    for (const c of CAMERA_DB)
      for (const mode of c.modes) {
        // From a 1/3"-class phone telephoto to ALEXA 65.
        expect(mode.filmBackMm.width).toBeGreaterThan(4);
        expect(mode.filmBackMm.width).toBeLessThan(60);
      }
    const a35 = CAMERA_DB.find((c) => c.id === 'arri-alexa-35')!;
    const og = a35.modes.find((m) => m.id === '4.6k-3x2-og')!;
    expect(og.filmBackMm).toEqual({ width: 27.99, height: 19.22 });
    expect(og.verified).toBe(true);
    expect(CAMERA_DB.some((c) => c.modes.some((m) => !m.verified))).toBe(true);
  });

  it('matches handoff camera text fuzzily, preferring a film back or resolution that agrees', () => {
    const a = matchCamera({ body: 'ARRI ALEXA 35', sensorMode: '4.6K 3:2 Open Gate' })!;
    expect(a.camera.id).toBe('arri-alexa-35');
    expect(a.mode.id).toBe('4.6k-3x2-og');
    const b = matchCamera({ body: 'Alexa35', filmBackMm: { width: 24.88, height: 14.0 } })!;
    expect(b.mode.id).toBe('4k-16x9');
    const c = matchCamera({ body: 'Sony VENICE 2', resolution: { width: 8640, height: 5760 } })!;
    expect(c.camera.id).toBe('sony-venice-2-8k');
    expect(c.mode.id).toBe('8.6k-3x2');
    expect(matchCamera({ body: 'Bolex H16' })).toBeNull();
    expect(matchCamera({ body: 'RED Komodo' })!.camera.id).toBe('red-komodo-6k');
  });

  it('converts focal lengths between millimetres and pixels', () => {
    expect(focalPixels(35, 27.99, 4608)).toBeCloseTo(5762.06, 1);
    expect(focalMillimetres(focalPixels(35, 27.99, 4608), 27.99, 4608)).toBeCloseTo(35, 9);
  });
});

describe('camera track document', () => {
  it('starts from the handoff: camera matched, lens focal as a start, logged', () => {
    const p = project();
    const doc = newCamTrackDocument(p, CAM_SHOT);
    expect(doc.camera?.cameraId).toBe('sony-venice-2-8k');
    expect(doc.lens.focalMm).toBe(25);
    expect(doc.lens.focalMode).toBe('approx');
    const r = applyCamTrack(p, CAM_SHOT, { command: 'set_camera', summary: 'from handoff', doc, task: 'work' }, 'Ana', now);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s = shotState(r.project, CAM_SHOT)!;
    expect(s.camtrack?.camera?.cameraId).toBe('sony-venice-2-8k');
    expect(s.tasks.find((t) => t.kind === 'camera_track')!.state).toBe('processing');
    const actions = r.project.log.filter((l) => l.shotId === CAM_SHOT).map((l) => l.action);
    expect(actions).toEqual(['camtrack.started', 'camtrack.set_camera', 'task.state']);
  });

  it('refuses shots without the task, bad documents and bad command names', () => {
    const p = project();
    const doc = newCamTrackDocument(p, '010_020');
    expect(applyCamTrack(p, '010_020', { command: 'solve', summary: '', doc }, 'Ana', now)).toMatchObject({ ok: false, reason: expect.stringContaining('no Camera track task') });
    const bad = { ...newCamTrackDocument(p, CAM_SHOT), activeSolve: -3 } as unknown as CamTrackDocument;
    expect(applyCamTrack(p, CAM_SHOT, { command: 'solve', summary: '', doc: bad }, 'Ana', now).ok).toBe(false);
    expect(applyCamTrack(p, CAM_SHOT, { command: 'Solve!', summary: '', doc: newCamTrackDocument(p, CAM_SHOT) }, 'Ana', now).ok).toBe(false);
  });

  it('a solve goes to review; approval needs the export; approved work is locked; reopening makes v002', () => {
    let p = project();
    let doc = newCamTrackDocument(p, CAM_SHOT);
    const id = camNextId(doc, 'tracks');
    doc = { ...id.doc, solves: [solve(1)], activeSolve: 1 };
    let r = applyCamTrack(p, CAM_SHOT, { command: 'solve', summary: 'solve 1: 0.48 px', doc, task: 'review' }, 'Ana', now);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    p = r.project;
    expect(shotState(p, CAM_SHOT)!.tasks.find((t) => t.kind === 'camera_track')!.state).toBe('needs_review');
    expect(activeSolve(shotState(p, CAM_SHOT)!.camtrack)?.number).toBe(1);
    // Processing finishing never approves; approval needs the files.
    expect(approveTask(p, CAM_SHOT, 'camera_track', 'Sup', now)).toMatchObject({ ok: false, reason: expect.stringContaining('Export camera track v001') });
    r = recordCamExport(p, CAM_SHOT, { version: 1, solve: 1, folder: '06_CAMERA_TRACK/020_010_camtrack_v001', files: ['020_010_camtrack_v001.nk'], formats: ['nuke'], stmaps: false }, 'Ana', now);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    p = r.project;
    r = approveTask(p, CAM_SHOT, 'camera_track', 'Sup', later);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    p = r.project;
    const s = shotState(p, CAM_SHOT)!;
    expect(camtrackLocked(s)).toMatch(/approved/);
    expect(applyCamTrack(p, CAM_SHOT, { command: 'set_lens', summary: '', doc: s.camtrack! }, 'Ana', later).ok).toBe(false);
    r = setTaskState(p, CAM_SHOT, 'camera_track', 'needs_correction', 'Ana', later);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const reopened = shotState(r.project, CAM_SHOT)!;
    expect(reopened.tasks.find((t) => t.kind === 'camera_track')!.version).toBe(2);
    expect(camtrackLocked(reopened)).toBeNull();
    // The v001 export record is kept; a v002 export is needed for the next approval.
    expect(reopened.camtrack!.exports.map((e) => e.version)).toEqual([1]);
    expect(camtrackNames.folder('020_010', 2)).toBe('020_010_camtrack_v002');
  });

  it('writes a manifest section with the camera, lens and the exported solve', () => {
    let p = project();
    const doc = { ...newCamTrackDocument(p, CAM_SHOT), solves: [solve(1)], activeSolve: 1 };
    const r = applyCamTrack(p, CAM_SHOT, { command: 'solve', summary: '', doc, task: 'review' }, 'Ana', now);
    if (!r.ok) throw new Error(r.reason);
    p = r.project;
    const m = buildManifest(p, CAM_SHOT, { generatedAt: now, appVersion: '1.0.0', operator: 'Ana', files: [] });
    expect(m.cameraTrack?.solve?.rmsPx).toBe(0.48);
    expect(m.cameraTrack?.camera?.cameraId).toBe('sony-venice-2-8k');
    expect(m.cameraTrack?.exported).toBe(false);
    expect(m.tracks2d).toBeNull();
  });
});

describe('project format 3', () => {
  it('opens a version 2 project (no camera tracks, no lens profiles) and saves it as 3', () => {
    const p = project();
    const old = JSON.parse(serializeProject(p));
    old.version = 2;
    delete old.lensProfiles;
    delete old.customCameras;
    for (const s of old.shots) {
      delete s.camtrack;
      delete s.track2d;
    }
    const parsed = parseProject(JSON.stringify(old));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.project.version).toBe(PROJECT_VERSION);
    expect(PROJECT_VERSION).toBe(7);
    expect(parsed.project.lensProfiles).toEqual([]);
    expect(parsed.project.shots.every((s) => s.camtrack === null && s.track2d === null)).toBe(true);
    const newer = JSON.parse(serializeProject(p));
    newer.version = PROJECT_VERSION + 1;
    expect(parseProject(JSON.stringify(newer))).toMatchObject({ ok: false });
  });

  it('marks tracking as performed by this release', () => {
    expect(PREP_TASKS.track_2d.available).toBe(true);
    expect(PREP_TASKS.camera_track.available).toBe(true);
  });
});

describe('lens profiles and custom cameras', () => {
  it('saves, finds by camera + lens + focal, replaces, and logs', () => {
    let p = project();
    const id = lensProfileId(p, 'Sony VENICE', 'Cooke S7/i', 25);
    const r = saveLensProfile(p, { id, camera: 'Sony VENICE · 6K 3:2', cameraId: 'sony-venice-2-8k', modeId: '8.6k-3x2', lens: 'Cooke S7/i', focalMm: 25, distortion: { k1: -0.08, k2: 0.02, k3: 0, p1: 0, p2: 0 }, squeeze: 1, measuredWidthPx: 6048, source: 'calibration', rms: 0.21, notes: '' }, 'Ana', now);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    p = r.project;
    expect(findLensProfile(p.lensProfiles, { cameraId: 'sony-venice-2-8k', lens: 'Cooke S7/i', focalMm: 25 })?.id).toBe(id);
    expect(findLensProfile(p.lensProfiles, { cameraId: 'sony-venice-2-8k', lens: 'Cooke S7/i', focalMm: 50 })).toBeNull();
    expect(p.log.at(-1)!.action).toBe('lens.profile_added');
    // A new camera-track document picks it up.
    const doc = newCamTrackDocument(p, CAM_SHOT);
    expect(doc.lens.profileId).toBe(id);
    expect(doc.lens.distortion.k1).toBe(-0.08);
    const c = addCustomCamera(p, { id: 'studio-cam', make: 'Studio', model: 'Cam', aliases: [], source: '', modes: [{ id: 'full', name: 'Full', filmBackMm: { width: 20, height: 10 }, px: { width: 2000, height: 1000 }, verified: false, aliases: [] }] }, 'Ana', now);
    expect(c.ok).toBe(true);
    if (c.ok) expect(matchCamera({ body: 'Studio Cam' }, c.project.customCameras)?.camera.id).toBe('studio-cam');
  });
});

describe('2D tracks', () => {
  it('creates, keys, records runs (never over keys), corrects, exports and needs the export to approve', () => {
    let p = project();
    const corners: [number, number][] = [
      [100, 100],
      [300, 110],
      [310, 260],
      [95, 250],
    ];
    let r = createTrack2d(p, TRACK_SHOT, { name: 'Laptop screen', kind: 'planar', frame: 90000, points: corners }, 'Ana', now);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    p = r.project;
    const t = shotState(p, TRACK_SHOT)!.track2d!.tracks[0]!;
    expect(t.id).toBe('laptop_screen');
    expect(shotState(p, TRACK_SHOT)!.tasks[0]!.state).toBe('processing');
    r = recordTrack2dRun(p, TRACK_SHOT, t.id, { frames: [90000, 90001, 90002].map((f) => ({ frame: f, points: corners.map(([x, y]) => [x + (f - 90000), y] as [number, number]), confidence: 0.9, status: 'tracked' as const })), engine: 'planar@1.0.0', from: 90000, direction: 'forward' }, 'Ana', now);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    p = r.project;
    const t2 = shotState(p, TRACK_SHOT)!.track2d!.tracks[0]!;
    expect(t2.frames.find((f) => f.frame === 90000)!.status).toBe('key');
    expect(t2.frames).toHaveLength(3);
    expect(shotState(p, TRACK_SHOT)!.tasks[0]!.state).toBe('needs_review');
    r = setTrack2dKey(p, TRACK_SHOT, t.id, 90002, corners, 'Ana', now);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    p = r.project;
    expect(p.log.at(-2)!.detail).toMatch(/corrected on 90002/);
    expect(track2dSpan(shotState(p, TRACK_SHOT)!.track2d!.tracks[0]!, 90001, 89992, 90073)).toEqual({ previous: 90000, next: 90002 });
    expect(removeTrack2dKey(p, TRACK_SHOT, t.id, 90002, 'Ana', now).ok).toBe(true);
    expect(approveTask({ ...p, shots: p.shots.map((s) => (s.shotId === TRACK_SHOT ? { ...s, tasks: s.tasks.map((k) => ({ ...k, state: 'needs_review' as const })) } : s)) }, TRACK_SHOT, 'track_2d', 'Sup', now)).toMatchObject({ ok: false, reason: expect.stringContaining('Export the 2D tracks') });
    r = recordTrack2dExport(p, TRACK_SHOT, { version: 1, folder: '05_TRACKS_2D/010_030_track2d_v001', files: ['a.nk'], tracks: [t.id], formats: ['nuke'] }, 'Ana', now);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    p = r.project;
    expect(approveTask(p, TRACK_SHOT, 'track_2d', 'Sup', now).ok).toBe(true);
    const m = buildManifest(p, TRACK_SHOT, { generatedAt: now, appVersion: '1', operator: 'Ana', files: [] });
    expect(m.tracks2d?.tracks[0]?.name).toBe('Laptop screen');
    expect(removeTrack2d(p, TRACK_SHOT, t.id, 'Ana', now).ok).toBe(true);
  });

  it('refuses a shot without the task until it is added', () => {
    const p = project();
    const pts: [number, number][] = [[1, 1]];
    expect(createTrack2d(p, CAM_SHOT, { name: 'P', kind: 'point', frame: 1000, points: pts }, 'Ana', now).ok).toBe(false);
    const r = addTask(p, CAM_SHOT, 'track_2d', 'Ana', now);
    expect(r.ok && createTrack2d(r.project, CAM_SHOT, { name: 'P', kind: 'point', frame: 1000, points: pts }, 'Ana', now).ok).toBe(true);
  });
});
