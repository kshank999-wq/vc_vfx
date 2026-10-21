import { describe, expect, it } from 'vitest';
import {
  PROJECT_VERSION,
  SAMPLE_HANDOFF,
  addPart,
  addStroke,
  approveShot,
  approveTask,
  buildManifest,
  clearStrokes,
  combineAlpha,
  editsMatte,
  createProject,
  eraseFromStrokes,
  eraseStrokes,
  flagFrame,
  markFrameReviewed,
  newRotoDocument,
  nextProblemFrame,
  parseHandoff,
  parseProject,
  partsInOrder,
  propagationRange,
  recordPropagation,
  recordRotoExport,
  removeKeyFrame,
  removePart,
  renamePart,
  rivalFrames,
  setRotoWorkingWidth,
  reviewFrames,
  rotoMetadata,
  rotoNames,
  serializeProject,
  setKeyFrame,
  setPartSettings,
  setTaskState,
  shotState,
  simplifyPolyline,
  type Project,
  type Result,
  type RotoDocument,
  type RotoExportInput,
} from '../index.js';

const NOW = new Date('2026-10-20T12:00:00Z');
const SHOT = '010_020'; // has a roto task
const ok = (r: Result): Project => {
  if (!r.ok) throw new Error(r.reason);
  return r.project;
};
const sample = (): Project => {
  const r = parseHandoff(JSON.stringify(SAMPLE_HANDOFF));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return createProject(r.handoff, '/Volumes/DRIVE/handoff.json', 'dit', NOW);
};
const roto = (p: Project) => shotState(p, SHOT)!.roto!;
const task = (p: Project) => shotState(p, SHOT)!.tasks.find((t) => t.kind === 'roto')!;
const stroke = { mode: 'include' as const, radius: 12, points: [[100, 100], [110, 102], [120, 104], [130, 106]] as [number, number][] };
const frames = (from: number, to: number, c = 0.9) => Array.from({ length: to - from + 1 }, (_, i) => ({ frame: from + i, confidence: c }));
const exportRecord = (version: number): RotoExportInput => ({
  version,
  folder: `02_MATTES_ROTO/${SHOT}_matte_v00${version}`,
  pattern: `${SHOT}_matte_v00${version}.%04d.png`,
  parts: [{ partId: 'subject', name: 'Subject', folder: `02_MATTES_ROTO/${SHOT}_roto_subject_v00${version}`, pattern: `${SHOT}_roto_subject_v00${version}.%04d.png` }],
  first: 1001,
  last: 1128,
  frames: 128,
  width: 4096,
  height: 2160,
  bitDepth: 16,
  exr: false,
  confidence: { mean: 0.9, min: 0.8, low: [] },
  engines: ['track@1.0.0'],
  metadata: `02_MATTES_ROTO/${SHOT}_roto_v00${version}.json`,
});

describe('roto document in the project file', () => {
  it('opens a version 1 project without roto and saves it as the current version', () => {
    const p = sample();
    const v1 = JSON.parse(serializeProject(p));
    v1.version = 1;
    for (const s of v1.shots) delete s.roto;
    const parsed = parseProject(JSON.stringify(v1));
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.project.version).toBe(PROJECT_VERSION);
    expect(PROJECT_VERSION).toBe(5);
    expect(parsed.project.shots.every((s) => s.roto === null)).toBe(true);
  });

  it('round-trips strokes, parts and frame records, and refuses a newer project', () => {
    let p = sample();
    p = ok(addStroke(p, SHOT, 'subject', 1010, stroke, 'Ana', NOW));
    p = ok(addPart(p, SHOT, { name: 'Right arm' }, 'Ana', NOW));
    const back = parseProject(serializeProject(p));
    if (!back.ok) throw new Error(back.reason);
    expect(roto(back.project)).toEqual(roto(p));
    const newer = JSON.parse(serializeProject(p));
    newer.version = PROJECT_VERSION + 1;
    expect(parseProject(JSON.stringify(newer))).toEqual({ ok: false, reason: 'This project was saved by a newer VC VFX. Update to open it.' });
  });

  it('keeps the project small: strokes are simplified and rounded', () => {
    let p = sample();
    const dense = Array.from({ length: 2000 }, (_, i) => [100 + i * 0.25, 200 + Math.sin(i / 400) * 0.1] as [number, number]);
    p = ok(addStroke(p, SHOT, 'subject', 1010, { mode: 'include', radius: 20, points: dense }, 'Ana', NOW));
    const s = roto(p).parts[0]!.keyFrames[0]!.strokes[0]!;
    expect(s.points.length).toBeLessThan(10);
    expect(s.points.every(([x, y]) => x * 2 === Math.round(x * 2) && y * 2 === Math.round(y * 2))).toBe(true);
  });
});

describe('roto mutations', () => {
  it('starts the document on the first stroke, logs it, and moves the task into processing', () => {
    let p = sample();
    expect(shotState(p, SHOT)!.roto).toBeNull();
    p = ok(addStroke(p, SHOT, 'subject', 1010, stroke, 'Ana', NOW));
    const doc = roto(p);
    expect(doc.parts.map((x) => x.id)).toEqual(['subject']);
    expect(doc.parts[0]!.keyFrames).toHaveLength(1);
    expect(doc.parts[0]!.keyFrames[0]!.strokes[0]).toMatchObject({ id: 's1', mode: 'include', radius: 12, by: 'Ana' });
    expect(task(p).state).toBe('processing');
    expect(p.log.slice(-3).map((l) => l.action)).toEqual(['roto.started', 'roto.stroke', 'task.state']);
    expect(p.log.at(-2)!.detail).toMatch(/^Subject frame 1010: include stroke/);
  });

  it('refuses roto on a shot without the task, and on a packaged shot', () => {
    const p = sample();
    expect(addStroke(p, '010_030', 'subject', 1001, stroke, 'Ana', NOW)).toEqual({ ok: false, reason: '010_030 has no Paint-to-roto task. Add it first.' });
  });

  it('adds, renames and removes parts in a hierarchy, with unique file-safe ids', () => {
    let p = sample();
    p = ok(addPart(p, SHOT, { name: 'Torso' }, 'Ana', NOW));
    p = ok(addPart(p, SHOT, { name: 'Right arm' }, 'Ana', NOW));
    p = ok(addPart(p, SHOT, { name: 'Hand', parentId: 'right_arm' }, 'Ana', NOW));
    p = ok(addPart(p, SHOT, { name: 'Prop / mug', combine: 'subtract' }, 'Ana', NOW));
    expect(addPart(p, SHOT, { name: 'torso' }, 'Ana', NOW)).toEqual({ ok: false, reason: 'There is already a part called torso' });
    expect(partsInOrder(roto(p)).map((x) => x.id)).toEqual(['subject', 'torso', 'right_arm', 'hand', 'prop_mug']);
    p = ok(renamePart(p, SHOT, 'right_arm', 'Left arm', 'Ana', NOW));
    expect(roto(p).parts.find((x) => x.id === 'right_arm')!.name).toBe('Left arm');
    expect(removePart(p, SHOT, 'right_arm', 'Ana', NOW)).toEqual({ ok: false, reason: 'Remove Hand first' });
    expect(removePart(p, SHOT, 'subject', 'Ana', NOW)).toEqual({ ok: false, reason: 'The overall subject matte cannot be removed' });
    p = ok(removePart(p, SHOT, 'hand', 'Ana', NOW));
    p = ok(setPartSettings(p, SHOT, 'torso', { refine: { featherPx: 3, shrinkGrowPx: -2 }, combine: 'subtract', color: '#112233', visible: false }, 'Ana', NOW));
    expect(roto(p).parts.find((x) => x.id === 'torso')).toMatchObject({ combine: 'subtract', color: '#112233', visible: false, refine: { featherPx: 3, shrinkGrowPx: -2, temporalSmoothing: 0, edgeSnap: true } });
    expect(p.log.at(-1)).toMatchObject({ action: 'roto.part_settings', actor: 'Ana' });
    expect(setPartSettings(p, SHOT, 'torso', { refine: { featherPx: 99 } }, 'Ana', NOW)).toEqual({ ok: false, reason: 'Feather is 0 to 64 px' });
  });

  it('erases parts of strokes, splitting them where they are cut', () => {
    let n = 10;
    const s = { id: 's1', mode: 'include' as const, radius: 4, points: [[0, 0], [10, 0], [20, 0], [30, 0], [40, 0]] as [number, number][], by: 'a', at: '' };
    const out = eraseFromStrokes([s], [[20, 1]], 3, () => `s${(n += 1)}`);
    expect(out.map((x) => [x.id, x.points])).toEqual([
      ['s1', [[0, 0], [10, 0]]],
      ['s11', [[30, 0], [40, 0]]],
    ]);
    let p = sample();
    p = ok(addStroke(p, SHOT, 'subject', 1010, { mode: 'include', radius: 5, points: [[0, 0], [50, 20], [100, 0]] }, 'Ana', NOW));
    p = ok(eraseStrokes(p, SHOT, 'subject', 1010, [[0, 0]], 4, 'Ana', NOW));
    expect(roto(p).parts[0]!.keyFrames[0]!.strokes[0]!.points).toEqual([[50, 20], [100, 0]]);
    p = ok(clearStrokes(p, SHOT, 'subject', 1010, 'Ana', NOW));
    expect(roto(p).parts[0]!.keyFrames[0]!.strokes).toEqual([]);
    p = ok(removeKeyFrame(p, SHOT, 'subject', 1010, 'Ana', NOW));
    expect(roto(p).parts[0]!.keyFrames).toEqual([]);
  });

  it('simplifies polylines with Ramer–Douglas–Peucker', () => {
    expect(simplifyPolyline([[0, 0], [1, 0.01], [2, 0], [3, 5]], 0.1)).toEqual([[0, 0], [2, 0], [3, 5]]);
  });

  it('records propagation per frame, puts the task up for review and never approves it', () => {
    let p = sample();
    p = ok(addStroke(p, SHOT, 'subject', 1010, stroke, 'Ana', NOW));
    p = ok(recordPropagation(p, SHOT, { partId: 'subject', engine: { id: 'track', version: '1.0.0', settings: { band: 12 } }, direction: 'key', from: 1010, frames: [{ frame: 1010, confidence: 0.97 }] }, 'Ana', NOW));
    // Segmenting the key frame alone is part of painting: the task stays in processing.
    expect(task(p).state).toBe('processing');
    p = ok(recordPropagation(p, SHOT, { partId: 'subject', engine: { id: 'track', version: '1.0.0' }, direction: 'forward', from: 1010, frames: [...frames(1011, 1019), { frame: 1020, confidence: 0.3 }] }, 'Ana', NOW));
    const part = roto(p).parts[0]!;
    expect(part.frames.find((f) => f.frame === 1010)).toMatchObject({ status: 'key', confidence: 0.97, engine: 'track@1.0.0', from: 1010 });
    expect(part.frames.find((f) => f.frame === 1015)).toMatchObject({ status: 'propagated', confidence: 0.9 });
    expect(task(p).state).toBe('needs_review');
    expect(task(p).approval).toBeNull();
    expect(roto(p).runs.map((r) => [r.direction, r.first, r.last, r.minConfidence])).toEqual([
      ['key', 1010, 1010, 0.97],
      ['forward', 1011, 1020, 0.3],
    ]);
    expect(rivalFrames(roto(p).parts[0]!, 1020)).toMatchObject({ 1011: 0.9, 1019: 0.9 });
    expect(rivalFrames(roto(p).parts[0]!, 1010)).toEqual({});
    expect(p.log.filter((l) => l.action === 'roto.propagated').at(-1)!.detail).toMatch(/forward from 1010: 10 frames 1011–1020 with track@1.0.0, confidence mean 0.84 min 0.30, 1 below 0.6/);

    // A correction painted on a propagated frame is a correction; the task goes back to needs correction.
    p = ok(addStroke(p, SHOT, 'subject', 1020, { ...stroke, mode: 'exclude' }, 'Ana', NOW));
    expect(roto(p).parts[0]!.keyFrames.find((k) => k.frame === 1020)!.correction).toBe(true);
    // A usable matte (0.3 here) is edited by the correction; one that had failed outright (0.1) starts again from the paint.
    expect(editsMatte(roto(p).parts[0]!, 1020)).toBe(true);
    expect(editsMatte({ ...roto(p).parts[0]!, frames: roto(p).parts[0]!.frames.map((f) => (f.frame === 1020 ? { ...f, confidence: 0.1 } : f)) }, 1020)).toBe(false);
    expect(editsMatte(roto(p).parts[0]!, 1010)).toBe(false);
    expect(roto(p).parts[0]!.frames.find((f) => f.frame === 1020)!.status).toBe('corrected');
    expect(task(p).state).toBe('needs_correction');
  });

  it('sets the working width the engines use', () => {
    let p = sample();
    p = ok(setRotoWorkingWidth(p, SHOT, 1280, 'Ana', NOW));
    expect(roto(p).workingWidth).toBe(1280);
    expect(setRotoWorkingWidth(p, SHOT, 100, 'Ana', NOW).ok).toBe(false);
  });

  it('flags and reviews frames', () => {
    let p = sample();
    p = ok(addStroke(p, SHOT, 'subject', 1010, stroke, 'Ana', NOW));
    p = ok(recordPropagation(p, SHOT, { partId: 'subject', engine: { id: 'track', version: '1' }, direction: 'forward', from: 1010, frames: frames(1011, 1015) }, 'Ana', NOW));
    p = ok(flagFrame(p, SHOT, 'subject', 1013, 'hair edge chatters', 'Sup', NOW));
    expect(roto(p).parts[0]!.frames.find((f) => f.frame === 1013)).toMatchObject({ status: 'flagged', note: 'hair edge chatters' });
    // Re-propagation keeps a flag until someone looks again.
    p = ok(recordPropagation(p, SHOT, { partId: 'subject', engine: { id: 'track', version: '1' }, direction: 'forward', from: 1010, frames: frames(1011, 1015) }, 'Ana', NOW));
    expect(roto(p).parts[0]!.frames.find((f) => f.frame === 1013)!.status).toBe('flagged');
    p = ok(markFrameReviewed(p, SHOT, null, 1013, 'Sup', NOW));
    expect(roto(p).parts[0]!.frames.find((f) => f.frame === 1013)).toMatchObject({ status: 'propagated', reviewed: { by: 'Sup' } });
    expect(markFrameReviewed(p, SHOT, null, 1100, 'Sup', NOW)).toEqual({ ok: false, reason: 'No matte on frame 1100 to review' });
    expect(setKeyFrame(p, SHOT, 'subject', 1100, 'Sup', NOW).ok).toBe(false);
    p = ok(setKeyFrame(p, SHOT, 'subject', 1014, 'Sup', NOW));
    expect(roto(p).parts[0]!.frames.find((f) => f.frame === 1014)!.status).toBe('corrected');
  });

  it('versions roto: approval needs an export, approved mattes are locked, reopening makes the next version', () => {
    let p = sample();
    p = ok(addStroke(p, SHOT, 'subject', 1010, stroke, 'Ana', NOW));
    p = ok(recordPropagation(p, SHOT, { partId: 'subject', engine: { id: 'track', version: '1' }, direction: 'forward', from: 1010, frames: frames(1011, 1020) }, 'Ana', NOW));
    expect(approveTask(p, SHOT, 'roto', 'Sup', NOW)).toEqual({ ok: false, reason: 'Export the mattes of roto v001 first; approval approves the files a vendor receives' });
    p = ok(recordRotoExport(p, SHOT, exportRecord(1), 'Ana', NOW));
    expect(task(p).state).toBe('needs_review');
    expect(recordRotoExport(p, SHOT, exportRecord(2), 'Ana', NOW)).toEqual({ ok: false, reason: 'Those mattes are v002; the roto task is v001' });
    p = ok(approveTask(p, SHOT, 'roto', 'Sup', NOW));
    expect(task(p)).toMatchObject({ state: 'approved', version: 1, approval: { by: 'Sup' } });
    // Approved: every edit is refused, so v001 cannot change under the approval.
    const locked = 'Roto v001 is approved. Reopen it (Needs correction) to make v002; the approved mattes are kept.';
    expect(addStroke(p, SHOT, 'subject', 1012, stroke, 'Ana', NOW)).toEqual({ ok: false, reason: locked });
    expect(recordPropagation(p, SHOT, { partId: 'subject', engine: { id: 'track', version: '1' }, direction: 'forward', from: 1010, frames: frames(1011, 1012) }, 'Ana', NOW)).toEqual({ ok: false, reason: locked });
    // Reopening bumps the version (the existing task rules); re-running writes v002.
    p = ok(setTaskState(p, SHOT, 'roto', 'needs_correction', 'Ana', NOW));
    expect(task(p).version).toBe(2);
    p = ok(recordPropagation(p, SHOT, { partId: 'subject', engine: { id: 'track', version: '1' }, direction: 'forward', from: 1010, frames: frames(1011, 1020) }, 'Ana', NOW));
    expect(roto(p).runs.at(-1)!.taskVersion).toBe(2);
    expect(approveTask(p, SHOT, 'roto', 'Sup', NOW).ok).toBe(false);
    p = ok(recordRotoExport(p, SHOT, exportRecord(2), 'Ana', NOW));
    expect(roto(p).exports.map((e) => e.version)).toEqual([1, 2]);
  });

  it('puts roto in the manifest: version, engines and confidence', () => {
    let p = sample();
    p = ok(addStroke(p, SHOT, 'subject', 1010, stroke, 'Ana', NOW));
    p = ok(recordPropagation(p, SHOT, { partId: 'subject', engine: { id: 'track', version: '1.0.0' }, direction: 'forward', from: 1010, frames: [...frames(1011, 1014), { frame: 1015, confidence: 0.4 }] }, 'Ana', NOW));
    p = ok(recordRotoExport(p, SHOT, exportRecord(1), 'Ana', NOW));
    for (const k of ['sequence_conversion', 'key'] as const) p = ok(setTaskState(p, SHOT, k, 'needs_review', 'Ana', NOW));
    for (const k of ['sequence_conversion', 'key', 'roto'] as const) p = ok(approveTask(p, SHOT, k, 'Sup', NOW));
    p = ok(approveShot(p, SHOT, 'Sup', NOW));
    const m = buildManifest(p, SHOT, { generatedAt: NOW, appVersion: '0.1.0', operator: 'Ana', files: [] });
    expect(m.roto).toMatchObject({
      version: 'v001',
      state: 'approved',
      exported: true,
      combined: '010_020_matte_v001.%04d.png',
      engines: ['track@1.0.0'],
      confidence: { frames: 5, low: [1015] },
    });
    expect(m.roto!.parts[0]).toMatchObject({ id: 'subject', keyFrames: [1010] });
  });
});

describe('roto queries', () => {
  const doc = (): RotoDocument => {
    const d = newRotoDocument();
    const part = d.parts[0]!;
    part.keyFrames = [{ frame: 1010, strokes: [], correction: false, by: 'a', at: '' }];
    part.frames = Array.from({ length: 41 }, (_, i) => ({ frame: 1000 + i, status: i === 10 ? ('key' as const) : ('propagated' as const), confidence: 0.9, engine: 'track@1', from: 1010, reviewed: null, note: '' }));
    part.frames[25]!.confidence = 0.35;
    part.frames[30]!.confidence = 0.65; // a sharp drop from 0.9 either side
    part.frames[33]!.status = 'flagged';
    part.frames[33]!.note = 'arm';
    return d;
  };

  it('chooses review frames: lowest confidence, evenly spread representatives, likely problems', () => {
    const r = reviewFrames(doc(), null, 1000, 1040, { sheetCount: 8, lowestCount: 3 });
    expect(r.representatives[0]).toBe(1000);
    expect(r.representatives.at(-1)).toBe(1040);
    expect(r.representatives).toHaveLength(10);
    expect(r.lowest.map((l) => l.frame)).toEqual([1025, 1030, 1000]);
    expect(r.problems.map((x) => [x.frame, x.reason])).toEqual([
      [1033, 'flagged: arm'],
      [1025, 'confidence 0.35'],
      [1030, 'drops 0.25 from its neighbours'],
    ]);
    expect(r.sheet).toEqual([...new Set([...r.representatives, 1025, 1030])].sort((a, b) => a - b));
    expect(nextProblemFrame(r, 1026)).toBe(1030);
    expect(nextProblemFrame(r, 1040)).toBe(1025);
  });

  it('leaves reviewed frames out of the problems', () => {
    const d = doc();
    d.parts[0]!.frames[25]!.reviewed = { by: 'Sup', at: '' };
    expect(reviewFrames(d, null, 1000, 1040).problems.map((x) => x.frame)).toEqual([1033, 1030]);
  });

  it('propagates locally between key frames', () => {
    const part = { keyFrames: [10, 20, 40].map((frame) => ({ frame, strokes: [], correction: false, by: '', at: '' })) };
    expect(propagationRange(part, 20, 'forward', 0, 99)).toEqual({ first: 21, last: 30 });
    expect(propagationRange(part, 20, 'backward', 0, 99)).toEqual({ first: 16, last: 19 });
    expect(propagationRange(part, 10, 'forward', 0, 99)).toEqual({ first: 11, last: 15 });
    expect(propagationRange(part, 10, 'backward', 0, 99)).toEqual({ first: 0, last: 9 });
    expect(propagationRange(part, 40, 'forward', 0, 99)).toEqual({ first: 41, last: 99 });
    expect(propagationRange(part, 40, 'backward', 0, 99)).toEqual({ first: 31, last: 39 });
    expect(propagationRange(part, 99, 'forward', 0, 99)).toBeNull();
    expect(propagationRange(part, 20, 'key', 0, 99)).toEqual({ first: 20, last: 20 });
  });

  it('combines parts into the subject matte: union children, subtract children, nested', () => {
    const d = newRotoDocument();
    const mk = (id: string, parentId: string, combine: 'union' | 'subtract') => ({ ...d.parts[0]!, id, name: id, parentId, combine });
    d.parts.push(mk('torso', 'subject', 'union'), mk('arm', 'subject', 'union'), mk('hole', 'arm', 'subtract'), mk('prop', 'subject', 'subtract'));
    const own: Record<string, number[]> = {
      subject: [0, 0, 0, 0, 0, 0],
      torso: [255, 255, 0, 0, 0, 0],
      arm: [0, 0, 255, 255, 255, 0],
      hole: [0, 0, 0, 255, 0, 0],
      prop: [0, 255, 0, 0, 128, 0],
    };
    const out = combineAlpha(d, 6, (id) => Uint8Array.from(own[id]!));
    expect([...out]).toEqual([255, 0, 255, 0, 127, 0]);
  });

  it('names the files and writes the metadata for downstream use', () => {
    expect(rotoNames.partFile('010_020', 'right_arm', 1, 1001)).toBe('010_020_roto_right_arm_v001.1001.png');
    expect(rotoNames.partFolder('010_020', 'right_arm', 3)).toBe('010_020_roto_right_arm_v003');
    expect(rotoNames.matteFile('010_020', 1, 1128)).toBe('010_020_matte_v001.1128.png');
    expect(rotoNames.metadata('010_020', 1)).toBe('010_020_roto_v001.json');
    let p = sample();
    p = ok(addStroke(p, SHOT, 'subject', 1010, stroke, 'Ana', NOW));
    p = ok(recordPropagation(p, SHOT, { partId: 'subject', engine: { id: 'track', version: '1.0.0' }, direction: 'forward', from: 1010, frames: frames(1011, 1012) }, 'Ana', NOW));
    const m = rotoMetadata(p, SHOT, { version: 1, first: 1010, last: 1012, width: 4096, height: 2160, bitDepth: 16, exr: false, workingWidth: 1920, generator: 'VC VFX test', writtenAt: NOW.toISOString(), by: 'Ana' });
    expect(m).toMatchObject({ format: 'vcvfx.roto/1', version: 'v001', frames: { first: 1010, last: 1012, count: 3 }, combined: { pattern: '010_020_matte_v001.%04d.png' } });
    expect(m.parts[0]).toMatchObject({ id: 'subject', pattern: '010_020_roto_subject_v001.%04d.png', keyFrames: [{ frame: 1010, strokes: 1 }] });
    expect(m.parts[0]!.frames.map((f) => f.frame)).toEqual([1011, 1012]);
    expect(m.runs).toHaveLength(1);
  });
});
