import { describe, expect, it } from 'vitest';
import {
  PROJECT_VERSION,
  SAMPLE_HANDOFF,
  addStroke,
  createProject,
  keyConfidence,
  keyManifest,
  keyMetadata,
  keyNames,
  keyProblemReasons,
  keySettings,
  keySubjectStale,
  parseHandoff,
  parseProject,
  recordKeyExport,
  recordKeyRun,
  recordKeySubjectRun,
  resolveCompSource,
  serializeProject,
  setKeyParams,
  setKeyScreen,
  setKeySubject,
  shotState,
  suggestedCompGraph,
  type KeyMetrics,
  type KeySubjectRunInput,
  type Project,
  type Result,
} from '../index.js';

/**
 * The hybrid key in the model (addendum 18): the subject prior (none / roto
 * part / Auto with a seed and a run), the shadow pass switch, their effect on
 * revisions, logging, task state, confidence and problem frames, the project
 * format (11) and the outputs that name them.
 */

const NOW = new Date('2026-10-23T12:00:00Z');
const SHOT = '010_020';
const ok = (r: Result): Project => {
  if (!r.ok) throw new Error(r.reason);
  return r.project;
};
const sample = (): Project => {
  const r = parseHandoff(JSON.stringify(SAMPLE_HANDOFF));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return createProject(r.handoff, '/Volumes/DRIVE/handoff.json', 'dit', NOW);
};
const keyed = () => ok(setKeyScreen(sample(), SHOT, { kind: 'green', source: 'auto', rgb: [0.06, 0.4, 0.09] }, 'ana', NOW));
const key = (p: Project) => shotState(p, SHOT)!.key!;
const runInput = (p: Project, over: Partial<KeySubjectRunInput> = {}): KeySubjectRunInput => ({
  engine: 'sam2@sam2.1_hiera_tiny/onnx/2',
  revision: key(p).subject.revision,
  seedFrame: 1010,
  seededBy: 'key',
  first: 1001,
  last: 1004,
  frames: [1001, 1002, 1003, 1004].map((f) => ({ frame: f, confidence: 0.9 })),
  ...over,
});

describe('the subject prior in the key document', () => {
  it('a new key has no subject and the shadow pass off; choosing Auto is logged, bumps the revision and moves the task', () => {
    const p0 = keyed();
    expect(key(p0).subject).toMatchObject({ source: 'none', engine: 'auto', marginPx: 12, outside: true, run: null });
    expect(key(p0).params.shadowPass).toBe(false);
    const p = ok(setKeySubject(p0, SHOT, { source: 'auto' }, 'ana', NOW));
    expect(key(p).subject.source).toBe('auto');
    expect(key(p).revision).toBe(key(p0).revision + 1);
    const entry = p.log.filter((l) => l.action === 'key.subject').at(-1);
    expect(entry?.detail).toMatch(/source none → auto/);
    expect(entry?.actor).toBe('ana');
    expect(shotState(p, SHOT)!.tasks.find((t) => t.kind === 'key')!.state).toBe('processing');
    // Unchanged is unchanged.
    expect(key(ok(setKeySubject(p, SHOT, { source: 'auto' }, 'ana', NOW))).revision).toBe(key(p).revision);
  });

  it('a roto subject must name a part that exists', () => {
    const p = keyed();
    expect(setKeySubject(p, SHOT, { source: 'roto', partId: null }, 'ana', NOW)).toMatchObject({ ok: false, reason: /Choose the roto part/ });
    expect(setKeySubject(p, SHOT, { source: 'roto', partId: 'nope' }, 'ana', NOW)).toMatchObject({ ok: false, reason: /No roto part/ });
    const painted = ok(addStroke(p, SHOT, 'subject', 1001, { mode: 'include', radius: 5, points: [[10, 10]] }, 'ana', NOW));
    expect(key(ok(setKeySubject(painted, SHOT, { source: 'roto', partId: 'subject' }, 'ana', NOW))).subject.partId).toBe('subject');
  });

  it('records an Auto run; a new seed or engine makes it stale, and a run from an older seed is refused', () => {
    let p = ok(setKeySubject(keyed(), SHOT, { source: 'auto' }, 'ana', NOW));
    expect(keySubjectStale(key(p))).toBe(true);
    const r0 = key(p).revision;
    p = ok(recordKeySubjectRun(p, SHOT, runInput(p), 'ana', NOW));
    expect(key(p).subject.run).toMatchObject({ engine: 'sam2@sam2.1_hiera_tiny/onnx/2', meanConfidence: 0.9, seededBy: 'key', taskVersion: 1, by: 'ana' });
    expect(key(p).revision).toBe(r0 + 1);
    expect(keySubjectStale(key(p))).toBe(false);
    expect(p.log.at(-1)?.action === 'key.subject_run' || p.log.at(-2)?.action === 'key.subject_run').toBe(true);
    const old = runInput(p);
    p = ok(setKeySubject(p, SHOT, { seed: { frame: 1002, box: { x0: 10, y0: 10, x1: 200, y1: 300 } } }, 'ana', NOW));
    expect(key(p).subject.revision).toBe(old.revision + 1);
    expect(keySubjectStale(key(p))).toBe(true);
    expect(recordKeySubjectRun(p, SHOT, old, 'ana', NOW)).toMatchObject({ ok: false, reason: /seed changed/ });
    // The margin is not a new seed: the run stays current.
    p = ok(recordKeySubjectRun(p, SHOT, runInput(p, { seededBy: 'operator', fallback: 'SAM 2 not available; Track was used', engine: 'track@1.2.0' }), 'ana', NOW));
    p = ok(setKeySubject(p, SHOT, { marginPx: 20 }, 'ana', NOW));
    expect(keySubjectStale(key(p))).toBe(false);
    expect(key(p).subject.run?.fallback).toMatch(/Track/);
    expect(recordKeySubjectRun(ok(setKeySubject(p, SHOT, { source: 'none' }, 'ana', NOW)), SHOT, runInput(p), 'ana', NOW)).toMatchObject({ ok: false });
  });

  it('a processed key goes stale when the subject changes (the settings revision moved)', () => {
    let p = keyed();
    const good: KeyMetrics = { screenCoverage: 0.6, coreNoise: 0, edgeActivity: 0.04, holes: 0, residual: 0.01 };
    p = ok(recordKeyRun(p, SHOT, { first: 1001, last: 1001, revision: key(p).revision, despill: false, frames: [{ frame: 1001, metrics: good, confidence: 1 }] }, 'ana', NOW));
    const rev = key(p).revision;
    p = ok(setKeyParams(p, SHOT, { shadowPass: true }, 'ana', NOW));
    expect(key(p).revision).toBe(rev + 1);
    expect(recordKeyRun(p, SHOT, { first: 1001, last: 1001, revision: rev, despill: false, frames: [{ frame: 1001, metrics: good, confidence: 1 }] }, 'ana', NOW)).toMatchObject({ ok: false });
  });

  it('confidence follows the segmentation, and frames where it and the key disagree are problems', () => {
    const base: KeyMetrics = { screenCoverage: 0.6, coreNoise: 0, edgeActivity: 0.04, holes: 0, residual: 0.01 };
    expect(keyConfidence({ ...base, subjectConfidence: 1, subjectDisagree: 0 })).toBe(1);
    expect(keyConfidence({ ...base, subjectConfidence: 0.5, subjectDisagree: 0 })).toBeCloseTo(0.8, 3);
    expect(keyConfidence({ ...base, subjectConfidence: 1, subjectDisagree: 0.1 })).toBeCloseTo(0.7, 3);
    const recs = [1, 2, 3, 4, 5, 6, 7].map((f) => ({ frame: f, metrics: { ...base, subjectConfidence: 0.95, subjectDisagree: 0, subjectOutside: 0.05 }, confidence: 0.98 }));
    recs[2] = { ...recs[2]!, metrics: { ...recs[2]!.metrics, subjectDisagree: 0.2 } };
    recs[4] = { ...recs[4]!, metrics: { ...recs[4]!.metrics, subjectOutside: 0.5 } };
    recs[6] = { ...recs[6]!, metrics: { ...recs[6]!.metrics, subjectConfidence: 0.3 } };
    const why = keyProblemReasons(recs);
    expect(why.get(3)).toMatch(/covers clean screen/);
    expect(why.get(5)).toMatch(/disagree/);
    expect(why.get(7)).toMatch(/unsure/);
    expect(why.get(1)).toBe('');
  });

  it('the metadata, manifest and comp name the subject and the shadow pass', () => {
    let p = ok(setKeySubject(keyed(), SHOT, { source: 'auto' }, 'ana', NOW));
    p = ok(recordKeySubjectRun(p, SHOT, runInput(p), 'ana', NOW));
    p = ok(setKeyParams(p, SHOT, { shadowPass: true }, 'ana', NOW));
    expect(keySettings(key(p)).subject).toMatchObject({ source: 'auto', run: { engine: 'sam2@sam2.1_hiera_tiny/onnx/2', seededBy: 'key' } });
    expect(keySettings(key(p)).params.shadowPass).toBe(true);
    const good: KeyMetrics = { screenCoverage: 0.6, coreNoise: 0, edgeActivity: 0.04, holes: 0, residual: 0.01 };
    p = ok(recordKeyRun(p, SHOT, { first: 1001, last: 1002, revision: key(p).revision, despill: false, frames: [1001, 1002].map((f) => ({ frame: f, metrics: good, confidence: 1 })) }, 'ana', NOW));
    const v = 1;
    p = ok(
      recordKeyExport(
        p,
        SHOT,
        {
          version: v,
          folder: `03_KEYS/${keyNames.folder(SHOT, v)}`,
          alpha: keyNames.alphaPattern(SHOT, v),
          foreground: null,
          core: null,
          edge: null,
          lightWrap: null,
          shadow: keyNames.shadowPattern(SHOT, v),
          mattesExr: keyNames.mattesExrPattern(SHOT, v),
          alphaExr: true,
          first: 1001,
          last: 1002,
          frames: 2,
          width: 64,
          height: 32,
          encoding: 'ACEScg (linear AP1)',
          despill: false,
          confidence: { mean: 1, min: 1, low: [] },
          algorithm: 'vcvfx-cdk@1.2.0',
          revision: key(p).revision,
          metadata: `03_KEYS/${keyNames.folder(SHOT, v)}/${keyNames.metadata(SHOT, v)}`,
          files: 6,
        },
        'ana',
        NOW,
      ),
    );
    expect(keyNames.shadowPattern(SHOT, v)).toBe('010_020_key_shadow_v001.%04d.png');
    expect(keyNames.mattesExrFile(SHOT, v, 1001)).toBe('010_020_key_mattes_v001.1001.exr');
    const m = keyManifest(shotState(p, SHOT)!)!;
    expect(m).toMatchObject({ shadow: '010_020_key_shadow_v001.%04d.png', subject: { source: 'auto', engine: 'sam2@sam2.1_hiera_tiny/onnx/2', meanConfidence: 0.9 } });
    const meta = keyMetadata(p, SHOT, { version: v, first: 1001, last: 1002, width: 64, height: 32, encoding: 'ACEScg', linear: true, source: 'plates', files: { alpha: 'a', shadow: keyNames.shadowPattern(SHOT, v), mattesExr: keyNames.mattesExrPattern(SHOT, v) }, alphaExr: true, generator: 't', writtenAt: NOW.toISOString(), by: 'ana', background: null });
    expect(meta.shadow).toMatch(/density/);
    expect(meta.mattesExr).toMatch(/shadow\.A/);
    // The comp reads the shadow pass, and its suggested graph stencils it over the background.
    expect(resolveCompSource(p, SHOT, 'key_shadow')).toMatchObject({ ok: true, file: '010_020_key_shadow_v001.%04d.png', format: 'png', kind: 'alpha' });
    const g = suggestedCompGraph(p, SHOT);
    const shadowNode = g.nodes.find((n) => n.type === 'keyer' && n.params['output'] === 'shadow');
    expect(shadowNode).toBeTruthy();
    const stencil = g.nodes.find((n) => n.type === 'merge' && n.params['operation'] === 'stencil')!;
    expect(g.edges.some((e) => e.from === shadowNode!.id && e.to === stencil.id && e.input === 'A')).toBe(true);
    // Without the pass the comp says why it cannot read it.
    expect(resolveCompSource(keyed(), SHOT, 'key_shadow')).toMatchObject({ ok: false });
  });
});

describe('project format 11', () => {
  it('opens a format-10 project: keys get no subject and the shadow pass off; a subject survives a round trip', () => {
    expect(PROJECT_VERSION).toBe(11);
    const p = keyed();
    const v10 = JSON.parse(serializeProject(p));
    v10.version = 10;
    for (const s of v10.shots) if (s.key) {
      delete s.key.subject;
      delete s.key.params.shadowPass;
    }
    const opened = parseProject(JSON.stringify(v10));
    if (!opened.ok) throw new Error(opened.reason);
    expect(opened.project.version).toBe(11);
    expect(key(opened.project).subject.source).toBe('none');
    expect(key(opened.project).params.shadowPass).toBe(false);
    let q = ok(setKeySubject(opened.project, SHOT, { source: 'auto', seed: { frame: 1003, points: [{ x: 5, y: 6, label: 1 }] } }, 'ana', NOW));
    q = ok(recordKeySubjectRun(q, SHOT, runInput(q), 'ana', NOW));
    const again = parseProject(serializeProject(q));
    if (!again.ok) throw new Error(again.reason);
    expect(key(again.project).subject).toEqual(key(q).subject);
    // A newer project is refused by this version.
    const v12 = JSON.parse(serializeProject(q));
    v12.version = 12;
    expect(parseProject(JSON.stringify(v12)).ok).toBe(false);
  });
});
