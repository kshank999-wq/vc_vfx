import { describe, expect, it } from 'vitest';
import {
  PREP_TASKS,
  PROJECT_VERSION,
  SAMPLE_HANDOFF,
  addIsolateStroke,
  addPart,
  addTask,
  approveTask,
  buildManifest,
  clearIsolateStrokes,
  createProject,
  flagIsolateFrame,
  isolateConfidence,
  isolateConfidenceSummary,
  isolateCorrectionRange,
  isolateDoc,
  isolateManifest,
  isolateMetadata,
  isolateNames,
  isolateProblemReasons,
  isolateReview,
  isolateSeedFrame,
  isolateSeedProblem,
  isolateTargetOf,
  markIsolateFrameReviewed,
  nextIsolateProblem,
  parseHandoff,
  parseProject,
  recordIsolateExport,
  recordIsolateRun,
  recordPropagation,
  serializeProject,
  setIsolateSeed,
  setIsolateSettings,
  setTaskState,
  shotState,
  type IsolateExportInput,
  type IsolateMetrics,
  type IsolateRunResult,
  type IsolateTarget,
  type Project,
  type Result,
} from '../index.js';

const NOW = new Date('2026-10-21T12:00:00Z');
const SHOT = '030_010'; // has both sky_replacement and background_removal
const ok = (r: Result): Project => {
  if (!r.ok) throw new Error(r.reason);
  return r.project;
};
const sample = (): Project => {
  const r = parseHandoff(JSON.stringify(SAMPLE_HANDOFF));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return createProject(r.handoff, '/Volumes/DRIVE/handoff.json', 'dit', NOW);
};
const doc = (p: Project, t: IsolateTarget = 'sky') => isolateDoc(shotState(p, SHOT), t)!;
const task = (p: Project, t: IsolateTarget = 'sky') => shotState(p, SHOT)!.tasks.find((x) => x.kind === (t === 'sky' ? 'sky_replacement' : 'background_removal'))!;
const good: IsolateMetrics = { foreground: 0.4, edge: 0.02, separation: 0.95, contrast: 0.4, flicker: 0.005, unresolved: 0, motionPx: 20, residualPx: 0.2 };
const result = (p: Project, frames: number[], over: Partial<Record<number, Partial<IsolateMetrics>>> = {}, t: IsolateTarget = 'sky'): IsolateRunResult => ({
  first: frames[0]!,
  last: frames[frames.length - 1]!,
  alignment: 'homography',
  engine: t === 'sky' ? 'sky-cues' : 'track',
  revision: doc(p, t).revision,
  frames: frames.map((f) => ({ frame: f, metrics: { ...good, ...over[f] }, confidence: isolateConfidence({ ...good, ...over[f] }) })),
});
const exportRecord = (p: Project, t: IsolateTarget = 'sky'): IsolateExportInput => {
  const v = task(p, t).version;
  const n = isolateNames(t);
  return {
    version: v,
    target: t,
    folder: `02_MATTES_ROTO/${n.folder(SHOT, v)}`,
    matte: n.mattePattern(SHOT, v),
    matteExr: null,
    foreground: n.foregroundPattern(SHOT, v, 'exr'),
    plate: n.platePattern(SHOT, v, 'exr'),
    confidence: n.confidencePattern(SHOT, v),
    plateConfidence: n.plateConfidencePattern(SHOT, v),
    format: 'exr',
    first: 1001,
    last: 1056,
    frames: 56,
    width: 3840,
    height: 2160,
    encoding: 'ACEScg (linear AP1)',
    summary: { mean: 0.9, min: 0.8, low: [], flicker: 0.005, unresolved: 0 },
    algorithm: 'vcvfx-isolate@1.1.0',
    engine: 'sky-cues',
    revision: doc(p, t).revision,
    metadata: `02_MATTES_ROTO/${n.folder(SHOT, v)}/${n.metadata(SHOT, v)}`,
    files: 282,
  };
};
const stroke = (mode: 'include' | 'exclude', x = 100, y = 100) => ({ mode, radius: 20, points: [[x, y] as [number, number], [x + 40, y + 10] as [number, number]] });

describe('the isolation documents', () => {
  it('sky and background removal are available tasks in 02_MATTES_ROTO', () => {
    expect(PREP_TASKS.sky_replacement).toMatchObject({ available: true, folder: '02_MATTES_ROTO' });
    expect(PREP_TASKS.background_removal).toMatchObject({ available: true, folder: '02_MATTES_ROTO' });
    expect(isolateTargetOf('sky_replacement')).toBe('sky');
    expect(isolateTargetOf('background_removal')).toBe('background');
    expect(isolateTargetOf('roto')).toBeNull();
    expect(shotState(sample(), SHOT)!.isolate).toEqual({ sky: null, background: null });
  });

  it('starts on the first change, logs who/when/what, and moves the task pending → processing', () => {
    const p = ok(setIsolateSettings(sample(), SHOT, 'sky', { edgeSoftnessPx: 2 }, 'ana', NOW));
    expect(doc(p)).toMatchObject({ target: 'sky', seed: { mode: 'auto' }, params: { edgeSoftnessPx: 2 }, revision: 1 });
    expect(task(p).state).toBe('processing');
    expect(isolateDoc(shotState(p, SHOT), 'background')).toBeNull();
    const log = p.log.slice(-3);
    expect(log.map((l) => l.action)).toEqual(['isolate.started', 'isolate.settings', 'task.state']);
    expect(log[1]).toMatchObject({ actor: 'ana', at: NOW.toISOString(), shotId: SHOT, detail: 'sky: edgeSoftnessPx 1 → 2' });
    expect(log[2]!.detail).toBe('sky_replacement → processing');
    // No change: no revision bump, logged as unchanged.
    const again = ok(setIsolateSettings(p, SHOT, 'sky', { edgeSoftnessPx: 2 }, 'ana', NOW));
    expect(doc(again).revision).toBe(1);
    expect(again.log.at(-1)!.detail).toBe('sky: unchanged');
  });

  it('refuses what it cannot do', () => {
    const p = sample();
    expect(setIsolateSettings(p, '010_020', 'sky', { edgeSoftnessPx: 2 }, 'ana', NOW)).toMatchObject({ ok: false, reason: expect.stringContaining('no Sky isolation task') });
    expect(setIsolateSettings(p, SHOT, 'sky', { edgeSoftnessPx: 99 }, 'ana', NOW)).toMatchObject({ ok: false, reason: expect.stringContaining('edgeSoftnessPx') });
    expect(setIsolateSettings(p, SHOT, 'sky', { engine: 'sam2' }, 'ana', NOW)).toMatchObject({ ok: false });
    expect(setIsolateSettings(p, SHOT, 'sky', { spill: { mode: 'colour' } }, 'ana', NOW)).toMatchObject({ ok: false, reason: expect.stringContaining('sky colour') });
    expect(setIsolateSeed(p, SHOT, 'background', { mode: 'auto' }, 'ana', NOW)).toMatchObject({ ok: false });
    expect(setIsolateSeed(p, SHOT, 'background', { mode: 'roto', partId: 'nobody' }, 'ana', NOW)).toMatchObject({ ok: false, reason: expect.stringContaining('No roto part') });
    expect(setIsolateSeed(p, SHOT, 'background', { mode: 'box', rect: { x0: 10, y0: 10, x1: 5, y1: 20 } }, 'ana', NOW)).toMatchObject({ ok: false });
    expect(addIsolateStroke(p, SHOT, 'sky', -1, stroke('include'), 'ana', NOW).ok).toBe(false);
    expect(clearIsolateStrokes(p, SHOT, 'sky', 1010, 'last', 'ana', NOW).ok).toBe(false);
    expect(recordIsolateRun(p, SHOT, 'sky', { ...result(ok(setIsolateSettings(p, SHOT, 'sky', { growPx: 1 }, 'a', NOW)), [1001]), frames: [] }, 'ana', NOW).ok).toBe(false);
  });

  it('seeds a subject by box, paint or a roto part, and says what is missing', () => {
    let p = sample();
    expect(isolateSeedProblem(null, 'sky')).toBeNull();
    expect(isolateSeedProblem(null, 'background')).toMatch(/Draw a box/);
    p = ok(setIsolateSeed(p, SHOT, 'background', { mode: 'box' }, 'ana', NOW));
    expect(isolateSeedProblem(doc(p, 'background'), 'background')).toMatch(/Draw a box/);
    p = ok(setIsolateSeed(p, SHOT, 'background', { rect: { x0: 1000, y0: 600, x1: 1600, y1: 2100 }, frame: 1030 }, 'ana', NOW));
    expect(isolateSeedProblem(doc(p, 'background'), 'background')).toBeNull();
    expect(doc(p, 'background').seed).toEqual({ mode: 'box', frame: 1030, rect: { x0: 1000, y0: 600, x1: 1600, y1: 2100 }, partId: null });
    expect(p.log.map((l) => l.detail)).toContain('background: seed frame middle → 1030, box 1000,600–1600,2100');
    expect(isolateSeedFrame(doc(p, 'background'), 1001, 1056)).toBe(1030);
    expect(isolateSeedFrame(null, 1001, 1056)).toBe(1029);
    p = ok(setIsolateSeed(p, SHOT, 'background', { mode: 'paint' }, 'ana', NOW));
    expect(isolateSeedProblem(doc(p, 'background'), 'background')).toMatch(/Paint/);
    p = ok(addIsolateStroke(p, SHOT, 'background', 1030, stroke('include'), 'ana', NOW));
    expect(isolateSeedProblem(doc(p, 'background'), 'background')).toBeNull();
    // A roto part.
    p = ok(addTask(p, SHOT, 'roto', 'ana', NOW));
    p = ok(addPart(p, SHOT, { name: 'Runner' }, 'ana', NOW));
    const partId = shotState(p, SHOT)!.roto!.parts.find((x) => x.name === 'Runner')!.id;
    p = ok(recordPropagation(p, SHOT, { partId, engine: { id: 'track', version: 't' }, direction: 'forward', from: 1001, frames: [{ frame: 1001, confidence: 0.9 }] }, 'ana', NOW));
    p = ok(setIsolateSeed(p, SHOT, 'background', { mode: 'roto', partId }, 'ana', NOW));
    expect(isolateSeedProblem(doc(p, 'background'), 'background')).toBeNull();
    expect(p.log.at(-1)!.detail).toContain('roto part Runner');
  });

  it('paints seeds and corrections on key frames; a correction reaches halfway to the neighbouring key frames', () => {
    let p = ok(addIsolateStroke(sample(), SHOT, 'sky', 1010, stroke('include'), 'ana', NOW));
    expect(doc(p).keyFrames).toHaveLength(1);
    expect(doc(p).keyFrames[0]).toMatchObject({ frame: 1010, correction: false, strokes: [{ id: 's1', mode: 'include', by: 'ana' }] });
    expect(p.log.at(-2)!.detail).toContain('frame 1010: s1 kept in front of the sky');
    p = ok(recordIsolateRun(p, SHOT, 'sky', result(p, [1001, 1002, 1030, 1040]), 'ana', NOW));
    // Paint on a built frame is a correction.
    p = ok(addIsolateStroke(p, SHOT, 'sky', 1030, stroke('exclude'), 'ana', NOW));
    expect(doc(p).keyFrames.map((k) => [k.frame, k.correction])).toEqual([
      [1010, false],
      [1030, true],
    ]);
    expect(task(p).state).toBe('needs_correction');
    expect(isolateCorrectionRange(doc(p), 1030, 1001, 1056)).toEqual({ first: 1021, last: 1056 });
    expect(isolateCorrectionRange(doc(p), 1010, 1001, 1056)).toEqual({ first: 1001, last: 1020 });
    p = ok(clearIsolateStrokes(p, SHOT, 'sky', 1030, 'last', 'ana', NOW));
    expect(doc(p).keyFrames.map((k) => k.frame)).toEqual([1010]);
    expect(doc(p).revision).toBe(3);
  });

  it('records a build for review (never approval), refuses a stale one, and finds the problem frames', () => {
    let p = ok(setIsolateSettings(sample(), SHOT, 'sky', { temporalSmoothing: 0.3 }, 'ana', NOW));
    const stale = result(p, [1001]);
    p = ok(setIsolateSettings(p, SHOT, 'sky', { temporalSmoothing: 0.4 }, 'ana', NOW));
    expect(recordIsolateRun(p, SHOT, 'sky', stale, 'ana', NOW)).toMatchObject({ ok: false, reason: expect.stringContaining('Build again') });
    p = ok(recordIsolateRun(p, SHOT, 'sky', result(p, [1001, 1002, 1003, 1004, 1005], { 1002: { flicker: 0.09 }, 1003: { contrast: 0.02 }, 1004: { edge: 0.2 }, 1005: { unresolved: 0.2 } }), 'ana', NOW));
    expect(task(p).state).toBe('needs_review');
    expect(task(p).approval).toBeNull();
    const reasons = isolateProblemReasons(doc(p).frames, 'sky');
    expect(reasons.get(1001)).toBe('');
    expect(reasons.get(1002)).toContain('flickers');
    expect(reasons.get(1003)).toContain('low contrast between the sky and the foreground');
    expect(reasons.get(1004)).toContain('large uncertain edge');
    expect(reasons.get(1005)).toContain('never seen');
    expect(isolateProblemReasons([{ frame: 1, confidence: 0.9, metrics: { ...good, foreground: 0 } }], 'sky').get(1)).toContain('almost nothing found in front of the sky');
    expect(isolateProblemReasons([{ frame: 1, confidence: 0.9, metrics: { ...good, foreground: 0 } }], 'background').get(1)).toContain('subject was lost');
    expect(doc(p).runs[0]).toMatchObject({ frames: 5, problems: [1002, 1003, 1004, 1005], taskVersion: 1, engine: 'sky-cues', alignment: 'homography' });
    const review = isolateReview(doc(p), 1001, 1056);
    expect(review.problems.map((x) => x.frame)).toContain(1002);
    expect(nextIsolateProblem(review, 1002)).toBe(1003);
    expect(nextIsolateProblem(review, 1005)).toBe(1002);
    p = ok(markIsolateFrameReviewed(p, SHOT, 'sky', 1002, 'sup', NOW));
    p = ok(flagIsolateFrame(p, SHOT, 'sky', 1001, 'branch lost', 'sup', NOW));
    const summary = isolateConfidenceSummary(doc(p));
    expect(summary).toMatchObject({ frames: 5, flagged: [1001], reviewed: 1 });
    expect(summary.problems).toEqual([1003, 1004, 1005]);
    expect(isolateReview(doc(p), 1001, 1056).problems[0]).toMatchObject({ frame: 1001, reason: 'flagged: branch lost' });
    // Confidence: flicker, contrast and a big edge lower it.
    expect(isolateConfidence(good)).toBeGreaterThan(0.9);
    expect(isolateConfidence({ ...good, flicker: 0.1 })).toBeLessThan(0.5);
    expect(isolateConfidence({ ...good, contrast: 0 })).toBeCloseTo(0.57, 1);
  });

  it('approval needs an export of the version; approved work is locked until reopened, and the next export is v002', () => {
    let p = ok(setIsolateSettings(sample(), SHOT, 'sky', { growPx: 1 }, 'ana', NOW));
    p = ok(recordIsolateRun(p, SHOT, 'sky', result(p, [1001, 1002]), 'ana', NOW));
    expect(approveTask(p, SHOT, 'sky_replacement', 'Sup', NOW)).toMatchObject({ ok: false, reason: expect.stringContaining('Export the sky isolation v001 first') });
    expect(recordIsolateExport(p, SHOT, 'background', exportRecord(p), 'ana', NOW).ok).toBe(false);
    p = ok(recordIsolateExport(p, SHOT, 'sky', exportRecord(p), 'ana', NOW));
    expect(task(p).state).toBe('needs_review');
    p = ok(approveTask(p, SHOT, 'sky_replacement', 'Sup', NOW));
    expect(task(p)).toMatchObject({ state: 'approved', approval: { by: 'Sup' } });
    expect(setIsolateSettings(p, SHOT, 'sky', { growPx: 2 }, 'ana', NOW)).toMatchObject({ ok: false, reason: expect.stringContaining('Sky isolation v001 is approved') });
    expect(addIsolateStroke(p, SHOT, 'sky', 1001, stroke('include'), 'ana', NOW).ok).toBe(false);
    // The other target is its own task.
    expect(setIsolateSeed(p, SHOT, 'background', { mode: 'box', rect: { x0: 1, y0: 1, x1: 9, y1: 9 } }, 'ana', NOW).ok).toBe(true);
    p = ok(setTaskState(p, SHOT, 'sky_replacement', 'needs_correction', 'Sup', NOW));
    expect(task(p).version).toBe(2);
    p = ok(setIsolateSettings(p, SHOT, 'sky', { growPx: 2 }, 'ana', NOW));
    expect(recordIsolateExport(p, SHOT, 'sky', { ...exportRecord(p), version: 1 }, 'ana', NOW).ok).toBe(false);
    p = ok(recordIsolateExport(p, SHOT, 'sky', exportRecord(p), 'ana', NOW));
    expect(doc(p).exports.map((e) => [e.version, e.folder])).toEqual([
      [1, '02_MATTES_ROTO/030_010_sky_v001'],
      [2, '02_MATTES_ROTO/030_010_sky_v002'],
    ]);
  });

  it('names its files per target, writes the sequence manifest and the package manifest section', () => {
    expect(isolateNames('sky').folder('030_010', 1)).toBe('030_010_sky_v001');
    expect(isolateNames('sky').mattePattern('030_010', 1)).toBe('030_010_sky_matte_v001.%04d.png');
    expect(isolateNames('background').foregroundFile('030_010', 2, 1001, 'exr')).toBe('030_010_bg_fg_v002.1001.exr');
    expect(isolateNames('background').platePattern('030_010', 1, 'exr')).toBe('030_010_bg_plate_v001.%04d.exr');
    expect(isolateNames('sky').plateConfidencePattern('030_010', 1)).toBe('030_010_sky_plateconf_v001.%04d.png');
    expect(isolateNames('sky').metadata('030_010', 1)).toBe('030_010_sky_v001.json');
    let p = ok(addIsolateStroke(sample(), SHOT, 'sky', 1010, stroke('include'), 'ana', NOW));
    p = ok(recordIsolateRun(p, SHOT, 'sky', result(p, [1001, 1002]), 'ana', NOW));
    const meta = isolateMetadata(p, SHOT, 'sky', {
      version: 1,
      first: 1001,
      last: 1002,
      width: 3840,
      height: 2160,
      encoding: 'ACEScg (linear AP1)',
      linear: true,
      source: 'source',
      files: { matte: 'm' },
      format: 'exr',
      engine: 'sky-cues',
      generator: 'VC VFX test',
      writtenAt: NOW.toISOString(),
      by: 'ana',
      perFrame: result(p, [1001, 1002]).frames,
      alignment: { model: 'homography', reference: 1001, frames: [] },
    });
    expect(meta).toMatchObject({ format: 'vcvfx.isolate/1', target: 'sky', task: 'sky_replacement', version: 'v001', frames: { count: 2 }, settings: { seed: { mode: 'auto' }, keyFrames: [{ frame: 1010, strokes: [{ mode: 'include' }] }] } });
    expect(meta.perFrame).toHaveLength(2);
    expect(meta.matte).toContain('inverse');
    expect(isolateManifest(shotState(sample(), SHOT)!)).toBeNull();
    p = ok(recordIsolateExport(p, SHOT, 'sky', exportRecord(p), 'ana', NOW));
    const m = buildManifest(p, SHOT, { generatedAt: NOW, appVersion: '0.1.0', operator: 'ana', files: [] }).isolate!;
    expect(m.background).toBeNull();
    expect(m.sky).toMatchObject({ task: 'sky_replacement', version: 'v001', exported: true, folder: '02_MATTES_ROTO/030_010_sky_v001', matte: '030_010_sky_matte_v001.%04d.png', plate: '030_010_sky_plate_v001.%04d.exr', format: 'exr', seed: { mode: 'auto' }, corrections: [{ frame: 1010, strokes: 1 }] });
    expect(m.sky!.confidence.frames).toBe(2);
  });

  it('since project format 6: projects of formats 3, 4 and 5 open with no isolation, and isolations survive a round trip', () => {
    expect(PROJECT_VERSION).toBe(13);
    const v5 = JSON.parse(serializeProject(sample()));
    v5.version = 5;
    for (const s of v5.shots) delete s.isolate;
    const opened5 = parseProject(JSON.stringify(v5));
    if (!opened5.ok) throw new Error(opened5.reason);
    expect(opened5.project.version).toBe(PROJECT_VERSION);
    expect(shotState(opened5.project, SHOT)!.isolate).toEqual({ sky: null, background: null });
    const v4 = JSON.parse(JSON.stringify(v5));
    v4.version = 4;
    for (const s of v4.shots) delete s.cleanPlate;
    const opened4 = parseProject(JSON.stringify(v4));
    expect(opened4.ok && opened4.project.version).toBe(PROJECT_VERSION);
    expect(opened4.ok && shotState(opened4.project, SHOT)!.isolate).toEqual({ sky: null, background: null });
    const v3 = JSON.parse(JSON.stringify(v4));
    v3.version = 3;
    for (const s of v3.shots) delete s.key;
    const opened3 = parseProject(JSON.stringify(v3));
    expect(opened3.ok && opened3.project.version).toBe(PROJECT_VERSION);
    let p = ok(addIsolateStroke(sample(), SHOT, 'sky', 1010, stroke('exclude'), 'ana', NOW));
    p = ok(setIsolateSeed(p, SHOT, 'background', { mode: 'box', rect: { x0: 1, y0: 2, x1: 30, y1: 40 } }, 'ana', NOW));
    p = ok(recordIsolateRun(p, SHOT, 'sky', result(p, [1001, 1002]), 'ana', NOW));
    const again = parseProject(serializeProject(p));
    if (!again.ok) throw new Error(again.reason);
    expect(shotState(again.project, SHOT)!.isolate).toEqual(shotState(p, SHOT)!.isolate);
    const newer = JSON.parse(serializeProject(p));
    newer.version = PROJECT_VERSION + 1;
    expect(parseProject(JSON.stringify(newer)).ok).toBe(false);
  });
});
