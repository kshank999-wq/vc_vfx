import { describe, expect, it } from 'vitest';
import {
  SAMPLE_HANDOFF,
  approveShot,
  approveTask,
  buildManifest,
  capabilityFrom,
  createProject,
  decideActivation,
  frameFileName,
  framesToTimecode,
  isWellFormedSerial,
  markDelivered,
  markPackaged,
  parseHandoff,
  parseProject,
  queueRows,
  serialFromBytes,
  sequencePlan,
  serializeProject,
  setTaskState,
  shotFolderSegments,
  shotListHtml,
  shotListRows,
  shotState,
  shotStatus,
  timecodeToFrames,
  type Project,
  type Result,
} from '../index.js';

const NOW = new Date('2026-10-19T12:00:00Z');
const ok = (r: Result): Project => {
  if (!r.ok) throw new Error(r.reason);
  return r.project;
};
const sample = (): Project => {
  const r = parseHandoff(JSON.stringify(SAMPLE_HANDOFF));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return createProject(r.handoff, '/Volumes/DRIVE/handoff.json', 'dit', NOW);
};

describe('handoff parsing', () => {
  it('reads the sample and fills defaults', () => {
    const r = parseHandoff(JSON.stringify(SAMPLE_HANDOFF));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.handoff.shots).toHaveLength(4);
    expect(r.handoff.shots[0]!.tasks.map((t) => t.kind)).toEqual(['sequence_conversion', 'key', 'roto']);
    expect(r.warnings.some((w) => w.message.includes('010_030'))).toBe(true);
  });

  it('reports every problem with a path', () => {
    const bad = { project: 'X', shots: [{ shotId: 'A', scene: '1', sourcePath: 'a', frameIn: 10, frameOut: 5, frameRate: 24, tasks: [{ kind: 'teleport' }] }, { shotId: 'A' }] };
    const r = parseHandoff(JSON.stringify(bad));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const paths = r.issues.map((i) => i.path);
    expect(paths).toContain('shots[0].tasks[0].kind');
    expect(paths).toContain('shots[1].scene');
  });

  it('refuses a range that ends before it starts', () => {
    const r = parseHandoff(JSON.stringify({ project: 'X', shots: [{ shotId: 'A', scene: '1', sourcePath: 'a', frameIn: 10, frameOut: 5, frameRate: 24 }] }));
    expect(!r.ok && r.issues.map((i) => i.path)).toEqual(['shots[0].frameOut']);
  });

  it('rejects duplicate shot IDs and bad JSON', () => {
    const dup = { project: 'X', shots: [0, 1].map(() => ({ shotId: 'A', scene: '1', sourcePath: 'a', frameIn: 0, frameOut: 5, frameRate: 24 })) };
    const r = parseHandoff(JSON.stringify(dup));
    expect(r.ok || r.issues[0]!.message).toMatch(/Duplicate shot ID A/);
    expect(parseHandoff('{').ok).toBe(false);
  });

  it('keeps fields it does not know', () => {
    const r = parseHandoff(JSON.stringify({ ...SAMPLE_HANDOFF, futureField: 7 }));
    expect(r.ok && (r.handoff as Record<string, unknown>)['futureField']).toBe(7);
  });
});

describe('frames', () => {
  it('renumbers from 1001 with handles', () => {
    const plan = sequencePlan({ frameIn: 86400, frameOut: 86511, handles: 8 }, { format: 'dpx', bitDepth: 10, startFrame: 1001 });
    expect(plan).toMatchObject({ sourceIn: 86392, sourceOut: 86519, deliveredIn: 1001, deliveredOut: 1128, editorialIn: 1009, editorialOut: 1120, frameCount: 128 });
  });

  it('clamps the head handle at source frame 0', () => {
    const plan = sequencePlan({ frameIn: 3, frameOut: 10, handles: 8 }, { format: 'exr', bitDepth: 16, startFrame: 1001 });
    expect(plan.sourceIn).toBe(0);
    expect(plan.editorialIn).toBe(1004);
  });

  it('names frames and converts timecode', () => {
    expect(frameFileName('010_020', 'plate', 1, 1001, 'exr')).toBe('010_020_plate_v001.1001.exr');
    expect(timecodeToFrames('01:00:00:00', 24)).toBe(86400);
    expect(framesToTimecode(86400 + 111, 24)).toBe('01:00:04:15');
    expect(timecodeToFrames('00:00:01:00', 23.976)).toBe(24);
  });
});

describe('approval model', () => {
  it('starts ready for prep and never approves because processing finished', () => {
    let p = sample();
    expect(shotStatus(shotState(p, '010_030')!)).toBe('ready_for_prep');
    p = ok(setTaskState(p, '010_030', 'track_2d', 'processing', 'op', NOW));
    expect(shotStatus(shotState(p, '010_030')!)).toBe('processing');
    p = ok(setTaskState(p, '010_030', 'track_2d', 'needs_review', 'op', NOW));
    expect(shotStatus(shotState(p, '010_030')!)).toBe('needs_review');
    p = ok(approveTask(p, '010_030', 'track_2d', 'M. Delgado', NOW));
    // every task approved, shot not yet signed off
    expect(shotStatus(shotState(p, '010_030')!)).toBe('needs_review');
    p = ok(approveShot(p, '010_030', 'M. Delgado', NOW));
    expect(shotStatus(shotState(p, '010_030')!)).toBe('prep_approved');
  });

  it('refuses to approve work that is not in review, or a shot with open tasks', () => {
    const p = sample();
    expect(approveTask(p, '010_020', 'key', 'sup', NOW)).toMatchObject({ ok: false });
    expect(approveShot(p, '010_020', 'sup', NOW)).toMatchObject({ ok: false });
    expect(approveTask(p, '010_020', 'key', '  ', NOW)).toMatchObject({ ok: false });
  });

  it('reopening approved work bumps the version and withdraws shot approval', () => {
    let p = sample();
    p = ok(setTaskState(p, '010_030', 'track_2d', 'needs_review', 'op', NOW));
    p = ok(approveTask(p, '010_030', 'track_2d', 'sup', NOW));
    p = ok(approveShot(p, '010_030', 'sup', NOW));
    p = ok(setTaskState(p, '010_030', 'track_2d', 'needs_correction', 'op', NOW));
    const s = shotState(p, '010_030')!;
    expect(s.approval).toBeNull();
    expect(s.tasks[0]!.version).toBe(2);
    expect(shotStatus(s)).toBe('needs_correction');
    expect(p.log.map((l) => l.action)).toContain('shot.approval_withdrawn');
  });

  it('packages only approved shots and delivers only packaged ones', () => {
    let p = sample();
    expect(markPackaged(p, '010_030', 'op', NOW)).toMatchObject({ ok: false });
    p = ok(setTaskState(p, '010_030', 'track_2d', 'needs_review', 'op', NOW));
    p = ok(approveTask(p, '010_030', 'track_2d', 'sup', NOW));
    p = ok(approveShot(p, '010_030', 'sup', NOW));
    expect(markDelivered(p, '010_030', 'op', NOW)).toMatchObject({ ok: false });
    p = ok(markPackaged(p, '010_030', 'op', NOW));
    expect(shotState(p, '010_030')!.packageVersion).toBe(1);
    p = ok(markDelivered(p, '010_030', 'op', NOW));
    expect(shotStatus(shotState(p, '010_030')!)).toBe('delivered');
    expect(setTaskState(p, '010_030', 'track_2d', 'processing', 'op', NOW)).toMatchObject({ ok: false });
  });

  it('round-trips through the project file', () => {
    const p = sample();
    const back = parseProject(serializeProject(p));
    expect(back.ok && back.project).toEqual(p);
  });
});

describe('queue and shot list', () => {
  it('sorts naturally and filters', () => {
    const p = sample();
    expect(queueRows(p).map((r) => r.shot.shotId)).toEqual(['010_020', '010_030', '020_010', '030_010']);
    expect(queueRows(p, { circledOnly: true })).toHaveLength(3);
    expect(queueRows(p, { task: 'sky_replacement' }).map((r) => r.shot.shotId)).toEqual(['030_010']);
    expect(queueRows(p, { task: 'camera_track' }).map((r) => r.shot.shotId)).toEqual(['020_010']);
    expect(queueRows(p, { search: 'monitor' }).map((r) => r.shot.shotId)).toEqual(['010_030']);
  });

  it('matches the spec §3 rows', () => {
    const rows = shotListRows(sample());
    expect(rows[0]).toMatchObject({ shot: '010_020', sceneSetup: '12A / Setup 3', frames: '1001–1128', requiredPrep: 'DPX + Roto + Key', status: 'Ready for Prep' });
    expect(rows[1]).toMatchObject({ requiredPrep: '2D Track', notes: 'Monitor replacement' });
  });

  it('escapes HTML in the printable list', () => {
    const p = sample();
    p.handoff.shots[0]!.supervisorNotes = '<script>x</script>';
    const html = shotListHtml(p, NOW);
    expect(html).not.toContain('<script>x');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('package', () => {
  it('lays out folders and writes a manifest', () => {
    expect(shotFolderSegments('Night Shift', '12A', '010_020')).toEqual(['NIGHT_SHIFT_VFX', 'SCENE_12A', 'SHOT_010_020']);
    const m = buildManifest(sample(), '010_020', { generatedAt: NOW, appVersion: '0.1.0', operator: 'op', files: [] });
    expect(m.plates).toMatchObject({ deliveredIn: 1001, format: 'dpx', colorBaked: false, pattern: '010_020_plate_v001.%04d.dpx' });
    expect(m.checksums.source).toHaveLength(1);
  });
});

describe('commerce', () => {
  const license = { id: 'L', status: 'active' as const, maxActivations: 2, expiresAt: '2026-11-19T00:00:00Z', entitledPlatforms: ['windows', 'macos'] as const };
  it('makes well-formed serials', () => {
    const s = serialFromBytes(new Uint8Array(20).map((_, i) => i * 13));
    expect(isWellFormedSerial(s)).toBe(true);
    expect(isWellFormedSerial('VCW-AAAAA-AAAAA-AAAAA-AAAAA')).toBe(false);
  });
  it('activates within the seat limit', () => {
    const act = (fp: string, off: string | null = null) => ({ id: fp, licenseId: 'L', deviceFingerprint: fp, deviceName: fp, platform: 'macos' as const, deactivatedAt: off });
    expect(decideActivation({ license, activations: [], deviceFingerprint: 'a', now: NOW })).toMatchObject({ reason: 'new_device' });
    expect(decideActivation({ license, activations: [act('a'), act('b')], deviceFingerprint: 'a', now: NOW })).toMatchObject({ reason: 'already_active' });
    expect(decideActivation({ license, activations: [act('a'), act('b')], deviceFingerprint: 'c', now: NOW })).toMatchObject({ reason: 'no_slots' });
    expect(decideActivation({ license, activations: [act('a', 'x'), act('b')], deviceFingerprint: 'a', now: NOW })).toMatchObject({ reason: 'reactivated' });
    expect(decideActivation({ license: { ...license, expiresAt: '2026-10-01T00:00:00Z' }, activations: [], deviceFingerprint: 'a', now: NOW })).toMatchObject({ reason: 'license_inactive' });
  });
  it('degrades to read-only, never to locked', () => {
    expect(capabilityFrom(null, NOW)).toBe('read_only');
    expect(capabilityFrom({ status: 'active', expiresAt: null, checkedAt: '2026-10-18T00:00:00Z' }, NOW)).toBe('full');
    expect(capabilityFrom({ status: 'active', expiresAt: null, checkedAt: '2026-08-01T00:00:00Z' }, NOW)).toBe('read_only');
  });
});
