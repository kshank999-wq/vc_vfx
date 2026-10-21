import { describe, expect, it } from 'vitest';
import {
  PREP_TASKS,
  PROJECT_VERSION,
  SAMPLE_HANDOFF,
  addKeyLink,
  addScreenSample,
  addStroke,
  addTask,
  approveShot,
  approveTask,
  backgroundReferences,
  buildManifest,
  clearScreenSamples,
  createProject,
  editsMatte,
  flagKeyFrame,
  keyConfidence,
  keyConfidenceSummary,
  keyMetadata,
  keyNames,
  keyProblemReasons,
  keyRepairPart,
  keyReview,
  markKeyFrameReviewed,
  nextKeyProblem,
  parseHandoff,
  parseProject,
  recordBgMatch,
  recordKeyExport,
  recordKeyRun,
  removeKeyLink,
  rotoPart,
  serializeProject,
  setDespill,
  setKeyBackground,
  setKeyParams,
  setKeyScreen,
  setLightWrap,
  setScreenKind,
  setTaskState,
  shotState,
  startKeyRepair,
  updateKeyLink,
  type KeyExportInput,
  type KeyMetrics,
  type Project,
  type Result,
} from '../index.js';

const NOW = new Date('2026-10-21T12:00:00Z');
const SHOT = '010_020'; // has key and roto tasks, and a background-plate reference
const ok = (r: Result): Project => {
  if (!r.ok) throw new Error(r.reason);
  return r.project;
};
const sample = (): Project => {
  const r = parseHandoff(JSON.stringify(SAMPLE_HANDOFF));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return createProject(r.handoff, '/Volumes/DRIVE/handoff.json', 'dit', NOW);
};
const key = (p: Project) => shotState(p, SHOT)!.key!;
const task = (p: Project, kind: 'key' | 'despill' | 'roto' = 'key') => shotState(p, SHOT)!.tasks.find((t) => t.kind === kind)!;
const good: KeyMetrics = { screenCoverage: 0.6, coreNoise: 0.002, edgeActivity: 0.04, holes: 0, residual: 0.01 };
const run = (p: Project, frames: number[], over: Partial<Record<number, Partial<KeyMetrics>>> = {}, despill = true) =>
  recordKeyRun(
    p,
    SHOT,
    { first: frames[0]!, last: frames[frames.length - 1]!, revision: key(p).revision, despill, frames: frames.map((f) => ({ frame: f, metrics: { ...good, ...over[f] }, confidence: keyConfidence({ ...good, ...over[f] }) })) },
    'ana',
    NOW,
  );
const exportRecord = (p: Project, despill = true): KeyExportInput => ({
  version: task(p).version,
  folder: `03_KEYS/${keyNames.folder(SHOT, task(p).version)}`,
  alpha: keyNames.alphaPattern(SHOT, task(p).version),
  foreground: keyNames.foregroundPattern(SHOT, task(p).version),
  core: null,
  edge: null,
  lightWrap: null,
  alphaExr: false,
  first: 1001,
  last: 1010,
  frames: 10,
  width: 4096,
  height: 2160,
  encoding: 'ACEScg (linear AP1)',
  despill,
  confidence: { mean: 0.9, min: 0.8, low: [] },
  algorithm: 'vcvfx-cdk@1.0.0',
  revision: key(p).revision,
  metadata: `03_KEYS/${keyNames.folder(SHOT, task(p).version)}/${keyNames.metadata(SHOT, task(p).version)}`,
  files: 22,
});
const withDespillTask = (p: Project) => ok(addTask(p, SHOT, 'despill', 'ana', NOW));

describe('key document and screen colour', () => {
  it('starts with the first change, moves the task into processing, and logs it', () => {
    const p = ok(setKeyScreen(sample(), SHOT, { kind: 'green', source: 'auto', rgb: [0.1, 0.5, 0.12], coverage: 0.62, frames: [1001, 1050] }, 'ana', NOW));
    expect(key(p).screen).toMatchObject({ kind: 'green', source: 'auto', coverage: 0.62, frames: [1001, 1050] });
    expect(key(p).revision).toBe(1);
    expect(task(p).state).toBe('processing');
    expect(p.log.map((l) => l.action).slice(-3)).toEqual(['key.started', 'key.screen', 'task.state']);
    expect(p.log.at(-2)!.detail).toMatch(/green screen detected \(0\.1000, 0\.5000, 0\.1200\), 62\.0 %/);
    expect(setKeyScreen(sample(), SHOT, { kind: 'green', source: 'auto', rgb: [0, 0, 0] }, 'ana', NOW).ok).toBe(false);
    expect(setKeyScreen(sample(), '010_030', { kind: 'green', source: 'auto', rgb: [0.1, 0.5, 0.1] }, 'ana', NOW)).toMatchObject({ ok: false, reason: expect.stringMatching(/no Green\/blue-screen key task/) });
  });

  it('builds a manual screen from eyedropper samples, and toggles green/blue', () => {
    let p = ok(addScreenSample(sample(), SHOT, { frame: 1001, x: 10, y: 20, radius: 4, rgb: [0.1, 0.4, 0.1] }, 'ana', NOW));
    p = ok(addScreenSample(p, SHOT, { frame: 1003, x: 50, y: 60, radius: 4, rgb: [0.1, 0.6, 0.2] }, 'ana', NOW));
    expect(key(p).screen).toMatchObject({ kind: 'green', source: 'manual', frames: [1001, 1003] });
    expect(key(p).screen!.rgb.map((v) => +v.toFixed(3))).toEqual([0.1, 0.5, 0.15]);
    expect(key(p).screen!.samples).toHaveLength(2);
    expect(addScreenSample(p, SHOT, { frame: 1001, x: 1, y: 1, radius: 2, rgb: [0, 0, 0] }, 'ana', NOW).ok).toBe(false);
    p = ok(setScreenKind(p, SHOT, { kind: 'blue' }, 'ana', NOW));
    expect(key(p).screen!.kind).toBe('blue');
    p = ok(clearScreenSamples(p, SHOT, 'ana', NOW));
    expect(key(p).screen).toBeNull();
    // A blue sample on a fresh key makes a blue screen.
    const q = ok(addScreenSample(sample(), SHOT, { frame: 1001, x: 1, y: 1, radius: 2, rgb: [0.05, 0.12, 0.6] }, 'ana', NOW));
    expect(key(q).screen!.kind).toBe('blue');
  });
});

describe('parameters, mattes and despill', () => {
  it('validates parameters and bumps the revision on every change', () => {
    let p = ok(setKeyParams(sample(), SHOT, { clipBlack: 0.08, edgeDetail: 0.5 }, 'ana', NOW));
    expect(key(p).params).toMatchObject({ clipBlack: 0.08, edgeDetail: 0.5, clipWhite: 0.9 });
    expect(key(p).revision).toBe(1);
    expect(p.log.at(-2)!.detail).toBe('clipBlack 0.04 → 0.08, edgeDetail 0.8 → 0.5');
    expect(setKeyParams(p, SHOT, { clipBlack: 0.6 }, 'ana', NOW).ok).toBe(false);
    expect(setKeyParams(p, SHOT, { clipBlack: 0.5, clipWhite: 0.52 }, 'ana', NOW)).toMatchObject({ ok: false, reason: expect.stringMatching(/white clip/) });
    p = ok(setKeyParams(p, SHOT, { clipBlack: 0.08 }, 'ana', NOW));
    expect(key(p).revision).toBe(1); // unchanged: no bump
  });

  it('links garbage, holdout and repair mattes from boxes and roto parts', () => {
    let p = ok(addKeyLink(sample(), SHOT, { kind: 'garbage', source: { type: 'rect', rect: { x0: 100, y0: 0, x1: 3900, y1: 2160 } } }, 'ana', NOW));
    expect(key(p).links[0]).toMatchObject({ id: 'l1', kind: 'garbage', invert: false, softnessPx: 2 });
    expect(addKeyLink(p, SHOT, { kind: 'holdout', source: { type: 'roto', partId: 'subject' } }, 'ana', NOW)).toMatchObject({ ok: false, reason: expect.stringMatching(/No roto part/) });
    p = ok(addStroke(p, SHOT, 'subject', 1001, { mode: 'include', radius: 12, points: [[10, 10], [20, 20]] }, 'ana', NOW));
    p = ok(addKeyLink(p, SHOT, { kind: 'holdout', source: { type: 'roto', partId: 'subject' } }, 'ana', NOW));
    p = ok(addKeyLink(p, SHOT, { kind: 'repair', source: { type: 'roto', partId: 'subject' }, mode: 'max' }, 'ana', NOW));
    expect(key(p).links.map((l) => [l.id, l.kind, l.mode, l.growPx])).toEqual([
      ['l1', 'garbage', 'replace', 0],
      ['l2', 'holdout', 'replace', 0],
      ['l3', 'repair', 'max', 12],
    ]);
    p = ok(updateKeyLink(p, SHOT, 'l1', { invert: true, frames: { first: 1001, last: 1020 } }, 'ana', NOW));
    expect(key(p).links[0]).toMatchObject({ invert: true, frames: { first: 1001, last: 1020 } });
    expect(updateKeyLink(p, SHOT, 'l1', { frames: { first: 1020, last: 1001 } }, 'ana', NOW).ok).toBe(true); // schema allows; engine treats inverted as none
    p = ok(removeKeyLink(p, SHOT, 'l2', 'ana', NOW));
    expect(key(p).links.map((l) => l.id)).toEqual(['l1', 'l3']);
    expect(removeKeyLink(p, SHOT, 'l2', 'ana', NOW).ok).toBe(false);
  });

  it('sets the despill and its background reference, and moves the despill task', () => {
    let p = withDespillTask(sample());
    expect(backgroundReferences(p, SHOT)).toEqual(['VFX/SCENE_12A/BG/city_night_plate.exr']);
    p = ok(setKeyBackground(p, SHOT, { kind: 'reference', path: 'VFX/SCENE_12A/BG/city_night_plate.exr', frame: null, label: '' }, 'ana', NOW));
    expect(key(p).despill.background).toMatchObject({ kind: 'reference', label: 'city_night_plate.exr' });
    expect(task(p, 'despill').state).toBe('processing');
    p = ok(setDespill(p, SHOT, { limit: 'max', protect: [{ label: 'jacket', rgb: [0.1, 0.3, 0.05], hueTolerance: 10 }] }, 'ana', NOW));
    expect(key(p).despill).toMatchObject({ limit: 'max', restore: 'background', protectSkin: true });
    expect(setKeyBackground(p, SHOT, { kind: 'frame', path: null, frame: null, label: '' }, 'ana', NOW).ok).toBe(false);
    expect(setDespill(p, SHOT, { strength: 2 }, 'ana', NOW).ok).toBe(false);
  });

  it('records a suggested background match as metadata only', () => {
    let p = ok(recordBgMatch(sample(), SHOT, { gain: [1.2, 1, 0.8], offset: [0.01, 0, -0.01], exposureStops: 0.1, samples: { foreground: 900, background: 1200 }, confidence: 0.8, frame: 1001 }, 'ana', NOW));
    expect(key(p).match.suggestion).toMatchObject({ gain: [1.2, 1, 0.8], strength: 0.5, by: 'ana' });
    expect(p.log.at(-1)!.detail).toMatch(/suggestion only; not applied to outputs/);
    p = ok(setLightWrap(p, SHOT, { preview: false }, 'ana', NOW));
    expect(key(p).revision).toBe(0); // preview-only changes do not change outputs
    p = ok(setLightWrap(p, SHOT, { output: true, widthPx: 24 }, 'ana', NOW));
    expect(key(p).revision).toBe(1);
  });
});

describe('runs, problem frames and review', () => {
  it('confidence falls with holes, an unsolid core, screen mismatch and a busy edge', () => {
    expect(keyConfidence(good)).toBeGreaterThan(0.98);
    expect(keyConfidence({ ...good, holes: 0.01 })).toBeLessThan(0.65);
    expect(keyConfidence({ ...good, coreNoise: 0.2 })).toBe(0.5);
    expect(keyConfidence({ ...good, residual: 0.2 })).toBeLessThan(0.45);
    expect(keyConfidence({ ...good, screenCoverage: 0.01 })).toBeLessThan(0.62);
  });

  it('flags an injected bad frame against the shot', () => {
    const frames = Array.from({ length: 20 }, (_, i) => 1001 + i);
    const records = frames.map((frame) => ({ frame, confidence: 0.95, metrics: { ...good, ...(frame === 1010 ? { residual: 0.25, screenCoverage: 0.3, edgeActivity: 0.15 } : {}) } }));
    const reasons = keyProblemReasons(records);
    expect([...reasons.entries()].filter(([, r]) => r).map(([f]) => f)).toEqual([1010]);
    expect(reasons.get(1010)).toMatch(/screen coverage 30 %.*edge .*busier.*differs from its model/);
  });

  it('a run puts key and despill up for review, never approves, and refuses stale settings', () => {
    let p = withDespillTask(ok(setKeyScreen(sample(), SHOT, { kind: 'green', source: 'auto', rgb: [0.1, 0.5, 0.1] }, 'ana', NOW)));
    const stale = key(p).revision - 1;
    expect(recordKeyRun(p, SHOT, { first: 1001, last: 1001, revision: stale, despill: true, frames: [{ frame: 1001, confidence: 0.9, metrics: good }] }, 'ana', NOW)).toMatchObject({ ok: false, reason: expect.stringMatching(/Process again/) });
    p = ok(run(p, Array.from({ length: 10 }, (_, i) => 1001 + i), { 1005: { holes: 0.02 } }));
    expect(task(p).state).toBe('needs_review');
    expect(task(p, 'despill').state).toBe('needs_review');
    expect(key(p).runs).toHaveLength(1);
    expect(key(p).runs[0]).toMatchObject({ frames: 10, problems: [1005], taskVersion: 1, despill: true });
    const review = keyReview(key(p), 1001, 1010);
    expect(review.problems.map((x) => x.frame)).toEqual([1005]);
    expect(nextKeyProblem(review, 1001)).toBe(1005);
    p = ok(markKeyFrameReviewed(p, SHOT, 1005, 'sup', NOW));
    expect(keyReview(key(p), 1001, 1010).problems).toEqual([]);
    p = ok(flagKeyFrame(p, SHOT, 1003, 'hair chatter', 'sup', NOW));
    expect(keyReview(key(p), 1001, 1010).problems[0]).toMatchObject({ frame: 1003, reason: 'flagged: hair chatter' });
    expect(keyConfidenceSummary(key(p))).toMatchObject({ frames: 10, flagged: [1003], reviewed: 1 });
    // A change of setting reopens the review for correction.
    p = ok(setKeyParams(p, SHOT, { clipWhite: 0.85 }, 'ana', NOW));
    expect(task(p).state).toBe('needs_correction');
  });

  it('approval needs the export of the version; approved keys are locked; reopening makes v002', () => {
    let p = withDespillTask(ok(setKeyScreen(sample(), SHOT, { kind: 'green', source: 'auto', rgb: [0.1, 0.5, 0.1] }, 'ana', NOW)));
    p = ok(run(p, [1001, 1002, 1003]));
    expect(approveTask(p, SHOT, 'key', 'Sup', NOW)).toMatchObject({ ok: false, reason: expect.stringMatching(/Export key v001 first/) });
    p = ok(recordKeyExport(p, SHOT, exportRecord(p, false), 'ana', NOW));
    expect(approveTask(p, SHOT, 'despill', 'Sup', NOW)).toMatchObject({ ok: false, reason: expect.stringMatching(/despilled foreground first/) });
    p = ok(recordKeyExport(p, SHOT, exportRecord(p, true), 'ana', NOW));
    expect(key(p).exports).toHaveLength(1);
    p = ok(approveTask(p, SHOT, 'key', 'Sup', NOW));
    p = ok(approveTask(p, SHOT, 'despill', 'Sup', NOW));
    expect(task(p).approval).toMatchObject({ by: 'Sup' });
    expect(setKeyParams(p, SHOT, { gamma: 1.2 }, 'ana', NOW)).toMatchObject({ ok: false, reason: expect.stringMatching(/Key v001 is approved\. Reopen it .* v002/) });
    expect(run(p, [1001]).ok).toBe(false);
    expect(recordKeyExport(p, SHOT, { ...exportRecord(p), version: 2 }, 'ana', NOW).ok).toBe(false);
    p = ok(setTaskState(p, SHOT, 'key', 'needs_correction', 'Sup', NOW));
    expect(task(p).version).toBe(2);
    p = ok(run(p, [1001, 1002]));
    expect(key(p).runs.at(-1)!.taskVersion).toBe(2);
    expect(approveTask(p, SHOT, 'key', 'Sup', NOW).ok).toBe(false);
    p = ok(recordKeyExport(p, SHOT, exportRecord(p), 'ana', NOW));
    expect(key(p).exports.map((e) => e.version)).toEqual([1, 2]);
  });
});

describe('repair with roto', () => {
  it('makes a roto part seeded from the key, accepted as a correction key frame, linked as a repair', () => {
    const p0 = sample();
    const { partId, name } = keyRepairPart(p0, SHOT);
    expect([partId, name]).toEqual(['key_repair_1', 'Key repair 1']);
    const p = ok(startKeyRepair(p0, SHOT, { partId, name, frame: 1010, confidence: 0.8 }, 'ana', NOW));
    const part = rotoPart(shotState(p, SHOT)!.roto, partId)!;
    expect(part.parentId).toBe('subject');
    expect(part.keyFrames).toEqual([expect.objectContaining({ frame: 1010, strokes: [], correction: true })]);
    expect(part.frames[0]).toMatchObject({ frame: 1010, status: 'corrected', confidence: 0.8 });
    // Painting there edits the seeded matte rather than starting again.
    expect(editsMatte(part, 1010)).toBe(true);
    expect(key(p).links).toEqual([expect.objectContaining({ kind: 'repair', mode: 'replace', source: { type: 'roto', partId }, label: 'Key repair 1' })]);
    expect(p.log.at(-1)).toMatchObject({ action: 'key.repair_started' });
    expect(keyRepairPart(p, SHOT).partId).toBe('key_repair_2');
    expect(startKeyRepair(p0, SHOT, { partId: 'wrong', name, frame: 1010, confidence: 0.8 }, 'ana', NOW).ok).toBe(false);
  });

  it('adds the roto task when the shot has none', () => {
    const r = parseHandoff(JSON.stringify({ ...SAMPLE_HANDOFF, shots: [{ ...SAMPLE_HANDOFF.shots[0], tasks: [{ kind: 'key' }] }] }));
    if (!r.ok) throw new Error('bad');
    const p0 = createProject(r.handoff, '/h.json', 'dit', NOW);
    const { partId, name } = keyRepairPart(p0, SHOT);
    const p = ok(startKeyRepair(p0, SHOT, { partId, name, frame: 1001, confidence: 0.5 }, 'ana', NOW));
    expect(shotState(p, SHOT)!.tasks.map((t) => t.kind)).toEqual(['roto', 'key']);
  });
});

describe('outputs, manifest and project format', () => {
  it('names files, writes metadata and a manifest section', () => {
    expect(keyNames.folder(SHOT, 1)).toBe('010_020_key_v001');
    expect(keyNames.alphaFile(SHOT, 1, 1001)).toBe('010_020_key_alpha_v001.1001.png');
    expect(keyNames.foregroundPattern(SHOT, 2)).toBe('010_020_key_fg_v002.%04d.exr');
    expect(keyNames.lightWrapFile(SHOT, 1, 1009)).toBe('010_020_key_lightwrap_v001.1009.exr');
    let p = ok(setKeyScreen(sample(), SHOT, { kind: 'green', source: 'auto', rgb: [0.1, 0.5, 0.1] }, 'ana', NOW));
    p = ok(run(p, [1001, 1002]));
    p = ok(recordKeyExport(p, SHOT, exportRecord(p), 'ana', NOW));
    const meta = keyMetadata(p, SHOT, { version: 1, first: 1001, last: 1002, width: 4096, height: 2160, encoding: 'ACEScg (linear AP1)', linear: true, source: 'plates v001', files: { alpha: keyNames.alphaPattern(SHOT, 1), foreground: keyNames.foregroundPattern(SHOT, 1), lightWrap: null }, alphaExr: false, generator: 'VC VFX test', writtenAt: NOW.toISOString(), by: 'ana', background: null });
    expect(meta).toMatchObject({ format: 'vcvfx.key/1', version: 'v001', frames: { count: 2 }, colour: { linear: true }, settings: { revision: 1, algorithm: { id: 'vcvfx-cdk' } }, suggestedMatch: null });
    expect(meta.perFrame).toHaveLength(2);
    expect(meta.lightWrap).toBeNull();
    const m = buildManifest(p, SHOT, { generatedAt: NOW, appVersion: '0.1.0', operator: 'ana', files: [] });
    expect(m.key).toMatchObject({ version: 'v001', state: 'needs_review', exported: true, alpha: '010_020_key_alpha_v001.%04d.png', encoding: 'ACEScg (linear AP1)', algorithm: 'vcvfx-cdk@1.0.0', confidence: { frames: 2 } });
    expect(buildManifest(sample(), SHOT, { generatedAt: NOW, appVersion: '0.1.0', operator: 'ana', files: [] }).key).toBeNull();
    // A shot can still be approved and packaged as before.
    p = ok(approveTask(p, SHOT, 'key', 'Sup', NOW));
    expect(approveShot(p, SHOT, 'Sup', NOW).ok).toBe(false); // other tasks still open
  });

  it('since project format 4: a version 3 project opens with no key, and keys survive a round trip', () => {
    expect(PROJECT_VERSION).toBe(6);
    expect(PREP_TASKS.key.available).toBe(true);
    expect(PREP_TASKS.despill.available).toBe(true);
    const v3 = JSON.parse(serializeProject(sample()));
    v3.version = 3;
    for (const s of v3.shots) delete s.key;
    const opened = parseProject(JSON.stringify(v3));
    if (!opened.ok) throw new Error(opened.reason);
    expect(opened.project.version).toBe(PROJECT_VERSION);
    expect(shotState(opened.project, SHOT)!.key).toBeNull();
    const p = ok(setKeyScreen(sample(), SHOT, { kind: 'blue', source: 'auto', rgb: [0.05, 0.1, 0.5] }, 'ana', NOW));
    const again = parseProject(serializeProject(p));
    if (!again.ok) throw new Error(again.reason);
    expect(shotState(again.project, SHOT)!.key).toEqual(key(p));
  });
});
