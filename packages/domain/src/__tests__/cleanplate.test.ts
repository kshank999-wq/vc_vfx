import { describe, expect, it } from 'vitest';
import {
  PREP_TASKS,
  PROJECT_VERSION,
  SAMPLE_HANDOFF,
  addCleanPlatePatch,
  addCleanPlateRemove,
  addStroke,
  addTask,
  approveTask,
  buildManifest,
  cleanPlateConfidence,
  cleanPlateConfidenceSummary,
  cleanPlateManifest,
  cleanPlateMetadata,
  cleanPlateModeFor,
  cleanPlateNames,
  cleanPlateProblemReasons,
  cleanPlateReference,
  cleanPlateReview,
  createProject,
  flagCleanPlateFrame,
  markCleanPlateFrameReviewed,
  nextCleanPlateProblem,
  parseHandoff,
  parseProject,
  recordCleanPlateExport,
  recordCleanPlateRun,
  removeCleanPlatePatch,
  removeCleanPlateRemove,
  serializeProject,
  setCleanPlateFrameGuidance,
  setCleanPlateSettings,
  setTaskState,
  shotState,
  suggestCleanPlateMode,
  updateCleanPlateRemove,
  type CleanPlateExportInput,
  type CleanPlateMetrics,
  type CleanPlateRunResult,
  type Project,
  type Result,
} from '../index.js';

const NOW = new Date('2026-10-21T12:00:00Z');
const SHOT = '020_010'; // has a clean_plate task (remove the crew member)
const ok = (r: Result): Project => {
  if (!r.ok) throw new Error(r.reason);
  return r.project;
};
const sample = (): Project => {
  const r = parseHandoff(JSON.stringify(SAMPLE_HANDOFF));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return createProject(r.handoff, '/Volumes/DRIVE/handoff.json', 'dit', NOW);
};
const doc = (p: Project) => shotState(p, SHOT)!.cleanPlate!;
const task = (p: Project) => shotState(p, SHOT)!.tasks.find((t) => t.kind === 'clean_plate')!;
const good: CleanPlateMetrics = { hole: 0.08, coverage: 1, low: 0, meanHole: 0.95, residualPx: 0.2, motionPx: 12, exposureStops: 0 };
const box = { x0: 100, y0: 200, x1: 400, y1: 900 };
const withBox = () => ok(addCleanPlateRemove(sample(), SHOT, { source: { type: 'rect', rect: box }, label: 'crew' }, 'ana', NOW));
const result = (p: Project, frames: number[], over: Partial<Record<number, Partial<CleanPlateMetrics>>> = {}, mode: 'still' | 'sequence' = 'sequence'): CleanPlateRunResult => ({
  mode,
  alignment: 'homography',
  reference: frames[frames.length >> 1]!,
  first: frames[0]!,
  last: frames[frames.length - 1]!,
  revision: doc(p).revision,
  suggestion: { mode: 'sequence', static: false, motionPx: 14, residualPx: 0.3, exposureStops: 0.02, reason: 'The camera moves' },
  frames: frames.map((f) => ({ frame: f, metrics: { ...good, ...over[f] }, confidence: cleanPlateConfidence({ ...good, ...over[f] }) })),
});
const exportRecord = (p: Project, mode: 'still' | 'sequence' = 'sequence'): CleanPlateExportInput => {
  const v = task(p).version;
  return {
    version: v,
    folder: `04_CLEAN_PLATES/${cleanPlateNames.folder(SHOT, v)}`,
    mode,
    plate: mode === 'still' ? cleanPlateNames.stillFile(SHOT, v, 1120, 'exr') : cleanPlateNames.platePattern(SHOT, v, 'exr'),
    confidence: cleanPlateNames.confidencePattern(SHOT, v),
    unresolved: cleanPlateNames.unresolvedPattern(SHOT, v),
    format: 'exr',
    reference: 1120,
    first: 1001,
    last: 1010,
    frames: 10,
    width: 3840,
    height: 2160,
    encoding: 'ACEScg (linear AP1)',
    summary: { mean: 0.9, min: 0.8, low: [], coverage: 0.98, unresolved: 0.01 },
    algorithm: 'vcvfx-cleanplate@1.0.0',
    revision: doc(p).revision,
    metadata: `04_CLEAN_PLATES/${cleanPlateNames.folder(SHOT, v)}/${cleanPlateNames.metadata(SHOT, v)}`,
    files: 32,
  };
};

describe('what to remove', () => {
  it('starts the document with the first change, moves the task into processing, and logs who and what', () => {
    const p = withBox();
    expect(doc(p).remove).toEqual([expect.objectContaining({ id: 'r1', label: 'crew', source: { type: 'rect', rect: box }, enabled: true })]);
    expect(doc(p).revision).toBe(1);
    expect(task(p).state).toBe('processing');
    expect(p.log.map((l) => l.action).slice(-3)).toEqual(['cleanplate.started', 'cleanplate.remove_added', 'task.state']);
    expect(p.log.at(-2)).toMatchObject({ actor: 'ana', at: NOW.toISOString(), detail: 'r1: box 100,200–400,900 “crew”' });
    // A shot without the task is refused with the reason.
    expect(addCleanPlateRemove(sample(), '010_030', { source: { type: 'rect', rect: box } }, 'ana', NOW)).toMatchObject({ ok: false, reason: expect.stringMatching(/no Clean plate task/) });
  });

  it('takes the subject from a roto part, once, and edits and removes items', () => {
    let p = withBox();
    expect(addCleanPlateRemove(p, SHOT, { source: { type: 'roto', partId: 'subject' } }, 'ana', NOW)).toMatchObject({ ok: false, reason: expect.stringMatching(/Paint the subject in the Roto tab/) });
    p = ok(addTask(p, SHOT, 'roto', 'ana', NOW));
    p = ok(addStroke(p, SHOT, 'subject', 1120, { mode: 'include', radius: 20, points: [[300, 500], [320, 700]] }, 'ana', NOW));
    p = ok(addCleanPlateRemove(p, SHOT, { source: { type: 'roto', partId: 'subject' } }, 'ana', NOW));
    expect(doc(p).remove.map((r) => r.id)).toEqual(['r1', 'r2']);
    expect(addCleanPlateRemove(p, SHOT, { source: { type: 'roto', partId: 'subject' } }, 'ana', NOW).ok).toBe(false);
    p = ok(updateCleanPlateRemove(p, SHOT, 'r1', { frames: { first: 1100, last: 1140 } }, 'ana', NOW));
    expect(doc(p).remove[0]!.frames).toEqual({ first: 1100, last: 1140 });
    expect(updateCleanPlateRemove(p, SHOT, 'r1', { frames: { first: 1140, last: 1100 } }, 'ana', NOW).ok).toBe(false);
    p = ok(removeCleanPlateRemove(p, SHOT, 'r1', 'ana', NOW));
    expect(doc(p).remove.map((r) => r.id)).toEqual(['r2']);
    expect(removeCleanPlateRemove(p, SHOT, 'r1', 'ana', NOW).ok).toBe(false);
  });
});

describe('settings and guidance', () => {
  it('sets mode, alignment, reference frame and parameters, bumping the revision only on a real change', () => {
    let p = ok(setCleanPlateSettings(withBox(), SHOT, { mode: 'still', alignment: 'static', referenceFrame: 1120, dilatePx: 12 }, 'ana', NOW));
    expect(doc(p)).toMatchObject({ mode: 'still', alignment: 'static', referenceFrame: 1120, params: { dilatePx: 12, window: 12 } });
    expect(doc(p).revision).toBe(2);
    expect(p.log.at(-1)!.detail).toBe('mode auto → still, alignment auto → static, reference frame middle → 1120, dilatePx 6 → 12');
    p = ok(setCleanPlateSettings(p, SHOT, { dilatePx: 12 }, 'ana', NOW));
    expect(doc(p).revision).toBe(2);
    expect(setCleanPlateSettings(p, SHOT, { dilatePx: 500 }, 'ana', NOW).ok).toBe(false);
    expect(setCleanPlateSettings(p, SHOT, { referenceFrame: -3 }, 'ana', NOW).ok).toBe(false);
    expect(cleanPlateReference(doc(p), 1001, 1264)).toBe(1120);
    expect(cleanPlateReference(doc(p), 1200, 1264)).toBe(1232); // outside the range: the middle
    expect(cleanPlateReference(null, 1001, 1011)).toBe(1006);
  });

  it('prefers and leaves out frames, and adds patches (not from a left-out frame)', () => {
    let p = ok(setCleanPlateFrameGuidance(withBox(), SHOT, 1050, 'prefer', 'ana', NOW));
    p = ok(setCleanPlateFrameGuidance(p, SHOT, 1060, 'exclude', 'ana', NOW));
    p = ok(setCleanPlateFrameGuidance(p, SHOT, 1040, 'exclude', 'ana', NOW));
    expect(doc(p).guidance).toMatchObject({ prefer: [1050], exclude: [1040, 1060] });
    // Switching a frame moves it between the lists.
    p = ok(setCleanPlateFrameGuidance(p, SHOT, 1050, 'exclude', 'ana', NOW));
    expect(doc(p).guidance).toMatchObject({ prefer: [], exclude: [1040, 1050, 1060] });
    expect(p.log.at(-1)!.detail).toBe('frame 1050: left out');
    expect(addCleanPlatePatch(p, SHOT, { rect: box, sourceFrame: 1060 }, 'ana', NOW)).toMatchObject({ ok: false, reason: expect.stringMatching(/left out/) });
    p = ok(addCleanPlatePatch(p, SHOT, { rect: box, sourceFrame: 1200, frames: { first: 1100, last: 1130 } }, 'ana', NOW));
    expect(doc(p).guidance.patches).toEqual([expect.objectContaining({ id: 'p2', sourceFrame: 1200, frames: { first: 1100, last: 1130 } })]);
    p = ok(removeCleanPlatePatch(p, SHOT, 'p2', 'ana', NOW));
    expect(doc(p).guidance.patches).toEqual([]);
  });
});

describe('builds, confidence and review', () => {
  it('confidence is the removed area’s, lowered by a bad alignment; a frame with nothing removed is clean', () => {
    expect(cleanPlateConfidence(good)).toBe(0.95);
    expect(cleanPlateConfidence({ ...good, hole: 0 })).toBe(1);
    expect(cleanPlateConfidence({ ...good, residualPx: 2.75 })).toBeCloseTo(0.475, 3);
    const reasons = cleanPlateProblemReasons([
      { frame: 1, confidence: 0.95, metrics: good },
      { frame: 2, confidence: 0.5, metrics: { ...good, low: 0.2, meanHole: 0.5 } },
      { frame: 3, confidence: 0.9, metrics: { ...good, residualPx: 2.2 } },
    ]);
    expect(reasons.get(1)).toBe('');
    expect(reasons.get(2)).toMatch(/confidence 0\.50; 20 % of the removed area unresolved/);
    expect(reasons.get(3)).toMatch(/alignment residual 2\.2 px/);
  });

  it('suggests a still only for a locked-off camera in steady light', () => {
    expect(suggestCleanPlateMode({ static: true, motionPx: 0.1, residualPx: 0.1, exposureStops: 0.01 }).mode).toBe('still');
    expect(suggestCleanPlateMode({ static: false, motionPx: 30, residualPx: 0.4, exposureStops: 0 })).toMatchObject({ mode: 'sequence', reason: expect.stringMatching(/camera moves/) });
    expect(suggestCleanPlateMode({ static: true, motionPx: 0.1, residualPx: 0.1, exposureStops: 0.4 })).toMatchObject({ mode: 'sequence', reason: expect.stringMatching(/light changes/) });
  });

  it('a build puts the task up for review, never approves, records the suggestion, and refuses stale settings', () => {
    let p = withBox();
    const stale = { ...result(p, [1001]), revision: doc(p).revision - 1 };
    expect(recordCleanPlateRun(p, SHOT, stale, 'ana', NOW)).toMatchObject({ ok: false, reason: expect.stringMatching(/Build again/) });
    const frames = Array.from({ length: 10 }, (_, i) => 1001 + i);
    p = ok(recordCleanPlateRun(p, SHOT, result(p, frames, { 1004: { meanHole: 0.3, low: 0.4, coverage: 0.6 } }), 'ana', NOW));
    expect(task(p).state).toBe('needs_review');
    expect(task(p).approval).toBeNull();
    expect(doc(p).suggestion).toMatchObject({ mode: 'sequence', static: false, revision: 1 });
    expect(cleanPlateModeFor(doc(p))).toBe('sequence');
    expect(doc(p).runs[0]).toMatchObject({ frames: 10, problems: [1004], taskVersion: 1, mode: 'sequence', alignment: 'homography' });
    expect(p.log.at(-2)!.detail).toMatch(/10 frames 1001–1010 .* unresolved 4\.0 %, 1 problem frame/);
    const review = cleanPlateReview(doc(p), 1001, 1010);
    expect(review.problems.map((x) => x.frame)).toEqual([1004]);
    expect(nextCleanPlateProblem(review, 1001)).toBe(1004);
    expect(nextCleanPlateProblem(review, 1005)).toBe(1004);
    p = ok(markCleanPlateFrameReviewed(p, SHOT, 1004, 'sup', NOW));
    expect(cleanPlateReview(doc(p), 1001, 1010).problems).toEqual([]);
    p = ok(flagCleanPlateFrame(p, SHOT, 1007, 'crew shadow left', 'sup', NOW));
    expect(cleanPlateReview(doc(p), 1001, 1010).problems[0]).toMatchObject({ frame: 1007, reason: 'flagged: crew shadow left' });
    expect(cleanPlateConfidenceSummary(doc(p))).toMatchObject({ frames: 10, flagged: [1007], reviewed: 1, lowFrames: [1004], coverage: 0.96 });
    // A change of a setting reopens the review for correction.
    p = ok(setCleanPlateSettings(p, SHOT, { window: 6 }, 'ana', NOW));
    expect(task(p).state).toBe('needs_correction');
  });

  it('a still build replaces the sequence’s records with the reference frame’s', () => {
    let p = withBox();
    p = ok(recordCleanPlateRun(p, SHOT, result(p, [1001, 1002, 1003]), 'ana', NOW));
    p = ok(setCleanPlateSettings(p, SHOT, { mode: 'still' }, 'ana', NOW));
    p = ok(recordCleanPlateRun(p, SHOT, { ...result(p, [1120], {}, 'still'), suggestion: { mode: 'still', static: true, motionPx: 0.1, residualPx: 0.05, exposureStops: 0, reason: 'still' } }, 'ana', NOW));
    expect(doc(p).frames.map((f) => f.frame)).toEqual([1120]);
    expect(doc(p).runs.map((r) => r.mode)).toEqual(['sequence', 'still']);
  });
});

describe('approval, versions and outputs', () => {
  it('approval needs the export of the version; approved plates are locked; reopening makes v002 beside v001', () => {
    let p = withBox();
    p = ok(recordCleanPlateRun(p, SHOT, result(p, [1001, 1002, 1003]), 'ana', NOW));
    expect(approveTask(p, SHOT, 'clean_plate', 'Sup', NOW)).toMatchObject({ ok: false, reason: expect.stringMatching(/Export clean plate v001 first/) });
    p = ok(recordCleanPlateExport(p, SHOT, exportRecord(p), 'ana', NOW));
    expect(task(p).state).toBe('needs_review');
    p = ok(approveTask(p, SHOT, 'clean_plate', 'Sup', NOW));
    expect(task(p).approval).toMatchObject({ by: 'Sup' });
    expect(p.log.at(-1)).toMatchObject({ action: 'task.approved', actor: 'Sup', detail: 'clean_plate' });
    expect(setCleanPlateSettings(p, SHOT, { dilatePx: 2 }, 'ana', NOW)).toMatchObject({ ok: false, reason: expect.stringMatching(/Clean plate v001 is approved\. Reopen it .* v002/) });
    expect(addCleanPlatePatch(p, SHOT, { rect: box, sourceFrame: 1001 }, 'ana', NOW).ok).toBe(false);
    expect(recordCleanPlateExport(p, SHOT, { ...exportRecord(p), version: 2 }, 'ana', NOW).ok).toBe(false);
    p = ok(setTaskState(p, SHOT, 'clean_plate', 'needs_correction', 'Sup', NOW));
    expect(task(p).version).toBe(2);
    p = ok(recordCleanPlateRun(p, SHOT, result(p, [1001, 1002]), 'ana', NOW));
    expect(doc(p).runs.at(-1)!.taskVersion).toBe(2);
    expect(approveTask(p, SHOT, 'clean_plate', 'Sup', NOW).ok).toBe(false);
    p = ok(recordCleanPlateExport(p, SHOT, exportRecord(p, 'still'), 'ana', NOW));
    expect(doc(p).exports.map((e) => [e.version, e.mode])).toEqual([
      [1, 'sequence'],
      [2, 'still'],
    ]);
  });

  it('names files, writes metadata and a manifest section', () => {
    expect(cleanPlateNames.folder(SHOT, 1)).toBe('020_010_cleanplate_v001');
    expect(cleanPlateNames.plateFile(SHOT, 1, 1001, 'exr')).toBe('020_010_cleanplate_v001.1001.exr');
    expect(cleanPlateNames.stillFile(SHOT, 2, 1120, 'exr')).toBe('020_010_cleanplate_still_v002.1120.exr');
    expect(cleanPlateNames.confidencePattern(SHOT, 1)).toBe('020_010_cleanplate_conf_v001.%04d.png');
    expect(cleanPlateNames.unresolvedFile(SHOT, 1, 1009)).toBe('020_010_cleanplate_unresolved_v001.1009.png');
    let p = withBox();
    p = ok(recordCleanPlateRun(p, SHOT, result(p, [1001, 1002]), 'ana', NOW));
    p = ok(recordCleanPlateExport(p, SHOT, exportRecord(p), 'ana', NOW));
    const meta = cleanPlateMetadata(p, SHOT, {
      version: 1,
      mode: 'sequence',
      reference: 1002,
      first: 1001,
      last: 1002,
      width: 3840,
      height: 2160,
      encoding: 'ACEScg (linear AP1)',
      linear: true,
      source: 'plates v001',
      files: { plate: cleanPlateNames.platePattern(SHOT, 1, 'exr') },
      format: 'exr',
      generator: 'VC VFX test',
      writtenAt: NOW.toISOString(),
      by: 'ana',
      alignment: { model: 'homography', frames: [{ frame: 1001, H: [1, 0, 2, 0, 1, 0, 0, 0, 1], residualPx: 0.2, motionPx: 2, gain: [1, 1, 1] }] },
    });
    expect(meta).toMatchObject({ format: 'vcvfx.cleanplate/1', version: 'v001', mode: 'sequence', frames: { count: 2 }, colour: { linear: true }, settings: { revision: 1, remove: [expect.objectContaining({ id: 'r1' })] }, alignment: { model: 'homography' } });
    expect(meta.perFrame).toHaveLength(2);
    const m = buildManifest(p, SHOT, { generatedAt: NOW, appVersion: '0.1.0', operator: 'ana', files: [] });
    expect(m.cleanPlate).toMatchObject({ version: 'v001', state: 'needs_review', exported: true, mode: 'sequence', plate: '020_010_cleanplate_v001.%04d.exr', format: 'exr', encoding: 'ACEScg (linear AP1)', algorithm: 'vcvfx-cleanplate@1.0.0', dilatePx: 6, confidence: { frames: 2 } });
    expect(m.cleanPlate!.remove).toEqual([{ id: 'r1', source: { type: 'rect', rect: box }, frames: null, enabled: true }]);
    expect(buildManifest(sample(), SHOT, { generatedAt: NOW, appVersion: '0.1.0', operator: 'ana', files: [] }).cleanPlate).toBeNull();
    expect(cleanPlateManifest(shotState(sample(), SHOT)!)).toBeNull();
  });

  it('since project format 5: a version 4 project opens with no clean plate, and plates survive a round trip', () => {
    expect(PROJECT_VERSION).toBe(9);
    expect(PREP_TASKS.clean_plate.available).toBe(true);
    expect(PREP_TASKS.clean_plate.folder).toBe('04_CLEAN_PLATES');
    const v4 = JSON.parse(serializeProject(sample()));
    v4.version = 4;
    for (const s of v4.shots) delete s.cleanPlate;
    const opened = parseProject(JSON.stringify(v4));
    if (!opened.ok) throw new Error(opened.reason);
    expect(opened.project.version).toBe(PROJECT_VERSION);
    expect(shotState(opened.project, SHOT)!.cleanPlate).toBeNull();
    // Older still: a version 3 project (no key either) opens too.
    const v3 = JSON.parse(JSON.stringify(v4));
    v3.version = 3;
    for (const s of v3.shots) delete s.key;
    const opened3 = parseProject(JSON.stringify(v3));
    expect(opened3.ok && opened3.project.version).toBe(PROJECT_VERSION);
    let p = withBox();
    p = ok(addCleanPlatePatch(p, SHOT, { rect: box, sourceFrame: 1200 }, 'ana', NOW));
    p = ok(recordCleanPlateRun(p, SHOT, result(p, [1001, 1002]), 'ana', NOW));
    const again = parseProject(serializeProject(p));
    if (!again.ok) throw new Error(again.reason);
    expect(shotState(again.project, SHOT)!.cleanPlate).toEqual(doc(p));
    // A newer project is refused rather than silently losing what it holds.
    const newer = JSON.parse(serializeProject(p));
    newer.version = PROJECT_VERSION + 1;
    expect(parseProject(JSON.stringify(newer))).toMatchObject({ ok: false, reason: expect.stringMatching(/newer VC VFX/) });
  });
});
