import { describe, expect, it } from 'vitest';
import {
  SAMPLE_HANDOFF,
  addTask,
  addTaskToShots,
  buildManifest,
  cameraRollOf,
  checksumAlgorithmOf,
  createProject,
  deriveShotIds,
  displayShotId,
  fromVcditHandoff,
  joinRelative,
  parseFrameRate,
  parseHandoff,
  parseProject,
  planFor,
  primaryMediaFile,
  queueRows,
  serializeProject,
  setProbedMedia,
  setTaskState,
  setVfxShotId,
  shotListHtml,
  shotListRows,
  shotState,
  shotTiming,
  type Project,
  type Result,
} from '../index.js';
import { VCDIT_FIXTURE } from './vcdit-fixture.js';

const NOW = new Date('2026-10-20T09:00:00Z');
const ok = (r: Result): Project => {
  if (!r.ok) throw new Error(r.reason);
  return r.project;
};
const vcditProject = (doc: unknown = VCDIT_FIXTURE): Project => {
  const r = parseHandoff(JSON.stringify(doc));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return createProject(r.handoff, '/Volumes/RAID/HALCYON/SHOOT_DAY_001_2026-10-07/VFX/VC_VFX_PREP_HLC_D001_20261007_201500Z.json', 'prep', NOW);
};

describe('reading a vcdit.vfx-handoff/1', () => {
  it('is recognised by its schema field and converted', () => {
    const r = parseHandoff(JSON.stringify(VCDIT_FIXTURE));
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    const h = r.handoff;
    expect(h.project).toBe('HALCYON');
    expect(h.generator).toBe('VC DIT 1.4.0');
    expect(h.origin).toEqual({ format: 'vcdit.vfx-handoff/1', tool: 'VC DIT 1.4.0', productionCode: 'HLC', day: { number: 1, date: '2026-10-07' }, createdAt: '2026-10-07T20:15:00.000Z' });
    expect(h.shots.map((s) => s.shotId)).toEqual(['14_B_03_A015C002', '14_B_03_B007C002', '14_01', '22A_C_05']);
    expect(h.shots[0]).toMatchObject({
      scene: '14',
      setup: 'B',
      take: '03',
      clip: 'A015C002',
      cameraRoll: 'A015',
      shootDay: 'Day 001 · 2026-10-07',
      flaggedBy: 'Script sup.',
      supervisorNotes: 'Sky replacement',
      circled: false,
      frameRate: 23.976,
      handles: 0,
      tasks: [],
      sourcePath: 'SCENE_014/SETUP_B/T03_A015C002/A015R1AB/A015C002_261007_R1AB.mxf',
      sourceFiles: ['SCENE_014/SETUP_B/T03_A015C002/A015R1AB/A015C002_261007_R1AB.xml'],
    });
    expect(h.shots[0]!.frameIn).toBeUndefined();
    expect(h.shots[0]!.checksums).toEqual([
      { path: 'SCENE_014/SETUP_B/T03_A015C002/A015R1AB/A015C002_261007_R1AB.mxf', algorithm: 'xxh64', value: '8d1c3a7e5b2f0c94', bytes: 200000 },
      { path: 'SCENE_014/SETUP_B/T03_A015C002/A015R1AB/A015C002_261007_R1AB.xml', algorithm: 'xxh64', value: '0f3e6a2b9c1d4e57', bytes: 7 },
    ]);
  });

  it('takes a referenced shot’s media from the editorial copy, and maps MD5', () => {
    const r = parseHandoff(JSON.stringify(VCDIT_FIXTURE));
    if (!r.ok) throw new Error('did not parse');
    const [, , tagged, braw] = r.handoff.shots;
    expect(tagged!.setup).toBeUndefined();
    expect(tagged).toMatchObject({ flaggedBy: 'DIT tag', sourcePath: '../CAMERA_ORIGINALS/A015/A015R1AB/A015C001_261007_R1AB.mxf', checksums: [] });
    expect(braw!.cameraRoll).toBeUndefined();
    expect(braw).toMatchObject({ checksums: [{ algorithm: 'md5', value: '9e107d9d372bb6826bd81d3542a419d6' }] });
    expect(braw!.supervisorNotes).toBeUndefined();
  });

  it('says what VCDIT did not send', () => {
    const r = parseHandoff(JSON.stringify(VCDIT_FIXTURE));
    if (!r.ok) throw new Error('did not parse');
    const text = r.warnings.map((w) => w.message).join('\n');
    expect(text).toMatch(/no VFX shot numbers/);
    expect(text).toMatch(/assign prep tasks in VC VFX/);
    expect(text).toMatch(/no frame range/);
    expect(text).toMatch(/camera, lens or colour/);
    expect(text).toMatch(/14_01 is referenced/);
    expect(text).toMatch(/14_01: 1 file was not checksummed/);
    expect(text).toMatch(/22A_C_05: ffmpeg cannot decode \.braw/);
    // One warning about tasks, not one per shot.
    expect(r.warnings.filter((w) => /prep tasks/.test(w.message))).toHaveLength(1);
  });

  it('tolerates nulls and unknown fields, and reads a newer version with a warning', () => {
    const doc = {
      ...VCDIT_FIXTURE,
      schema: 'vcdit.vfx-handoff/2',
      futureTop: true,
      production: { name: '', code: 'HLC', frameRate: '25p' },
      shots: [{ ...VCDIT_FIXTURE.shots[0]!, setup: null, take: null, note: null, checksumMethod: 'xxHash128', files: [{ path: 'a.mov', checksum: 'ff' }], lens: '35mm' }],
    };
    const r = parseHandoff(JSON.stringify(doc));
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    expect(r.handoff.project).toBe('HLC');
    expect(r.handoff.shots[0]).toMatchObject({ shotId: '14', frameRate: 25, checksums: [{ algorithm: 'xxh128' }] });
    expect(r.warnings.some((w) => /newer VCDIT/.test(w.message))).toBe(true);
  });

  it('refuses a broken VCDIT handoff with paths, and points away from a reference file', () => {
    const bad = parseHandoff(JSON.stringify({ schema: 'vcdit.vfx-handoff/1', production: {}, shots: [{ scene: '1', mirror: {} }] }));
    expect(!bad.ok && bad.issues.map((i) => i.path)).toEqual(expect.arrayContaining(['shots[0].clip', 'shots[0].mirror.method', 'shots[0].mirror.folder']));
    const ref = parseHandoff(JSON.stringify({ schema: 'vcdit.vfx-reference/1', clip: 'A015C001' }));
    expect(!ref.ok && ref.issues[0]!.message).toMatch(/VC_VFX_PREP_/);
    expect(parseHandoff(JSON.stringify({ ...VCDIT_FIXTURE, shots: [] })).ok).toBe(false);
  });

  it('assumes 24 fps when the production rate is unreadable', () => {
    const r = fromVcditHandoff({ ...VCDIT_FIXTURE, production: { name: 'X', code: 'X', frameRate: 'tbd' } });
    expect(r.ok && r.handoff.shots[0]!.frameRate).toBe(24);
    expect(r.ok && r.warnings.some((w) => w.path === 'production.frameRate')).toBe(true);
  });
});

describe('VCDIT helpers', () => {
  it('parses frame rates as VCDIT writes them', () => {
    expect(parseFrameRate('23.976 fps')).toBe(23.976);
    expect(parseFrameRate('23.98')).toBe(23.976);
    expect(parseFrameRate('24')).toBe(24);
    expect(parseFrameRate('29.97 DF')).toBe(29.97);
    expect(parseFrameRate('59,94')).toBe(59.94);
    expect(parseFrameRate('24000/1001')).toBe(23.976);
    expect(parseFrameRate(25)).toBe(25);
    expect(parseFrameRate('fast')).toBeNull();
    expect(parseFrameRate(undefined)).toBeNull();
  });

  it('derives stable, readable shot IDs and disambiguates cameras', () => {
    const t = (scene: string, setup: string, take: string, clip: string) => ({ scene, setup, take, clip });
    expect(deriveShotIds([t('14', 'B', '03', 'A015C002'), t('14', 'B', '03', 'B007C002'), t('12 A', '—', '1', 'X'), t('', '', '', 'A001_C002')])).toEqual([
      '14_B_03_A015C002',
      '14_B_03_B007C002',
      '12A_1',
      'A001_C002',
    ]);
    expect(deriveShotIds([t('1', 'A', '1', 'C'), t('1', 'A', '1', 'C')])).toEqual(['1_A_1_C', '1_A_1_C_2']);
  });

  it('picks the primary media file', () => {
    expect(primaryMediaFile([{ path: 'a.xml', size: 9e9 }, { path: 'a.mxf', size: 10 }, { path: 'b.mov', size: 20 }])!.primary.path).toBe('b.mov');
    expect(primaryMediaFile([{ path: 'C_002.R3D', size: 9 }, { path: 'C_001.R3D', size: 5 }, { path: 'C.RMD', size: 1 }])!.primary.path).toBe('C_001.R3D');
    expect(primaryMediaFile([{ path: 'f.0002.dng' }, { path: 'f.0001.dng' }, { path: 'f.0010.dng' }])).toMatchObject({ primary: { path: 'f.0001.dng' }, sequenceFrames: 3 });
    expect(primaryMediaFile([{ path: 'x.bin', size: 1 }, { path: 'y.bin', size: 2 }])!.primary.path).toBe('y.bin');
    expect(primaryMediaFile([])).toBeNull();
  });

  it('maps checksum methods, rolls and paths', () => {
    expect(['xxHash64', 'MD5', 'SHA-1', 'sha256', 'crc32'].map(checksumAlgorithmOf)).toEqual(['xxh64', 'md5', 'sha1', 'sha256', null]);
    expect(cameraRollOf('A015C002')).toBe('A015');
    expect(cameraRollOf('A001_C002_0712AB')).toBe('A001');
    expect(cameraRollOf('C003_10071422_C012')).toBeUndefined();
    expect(joinRelative('./SCENE_014/', 'A015\\x.mxf')).toBe('SCENE_014/A015/x.mxf');
    expect(joinRelative('../CAMERA_ORIGINALS/A015', 'a.mxf')).toBe('../CAMERA_ORIGINALS/A015/a.mxf');
  });

  it('gives an image sequence its range from the file list', () => {
    const files = [1, 2, 3, 4].map((n) => ({ path: `SEQ/clip.000${n}.dng`, size: 100, checksum: null }));
    const r = fromVcditHandoff({ ...VCDIT_FIXTURE, shots: [{ ...VCDIT_FIXTURE.shots[0]!, files }] });
    expect(r.ok && r.handoff.shots[0]).toMatchObject({ frameIn: 0, frameOut: 3, sourcePath: 'SCENE_014/SETUP_B/T03_A015C002/SEQ/clip.0001.dng' });
  });
});

describe('a project from VCDIT', () => {
  it('has unknown ranges until probed, shown as —', () => {
    const p = vcditProject();
    const shot = p.handoff.shots[0]!;
    expect(shotTiming(p, shot)).toBeNull();
    expect(planFor(p, shot)).toBeNull();
    expect(shotListRows(p).find((r) => r.shot === shot.shotId)).toMatchObject({ frames: '—', requiredPrep: '—', notes: 'Sky replacement' });
    expect(shotListHtml(p, NOW)).toContain('Shoot day 1 (2026-10-07)');
    const m = buildManifest(p, shot.shotId, { generatedAt: NOW, appVersion: 't', operator: 'op', files: [] });
    expect(m.plates).toMatchObject({ deliveredIn: null, frameCount: null, colorBaked: false });
    expect(m.shot).toMatchObject({ rangeFrom: null, flaggedBy: 'Script sup.', sourceFiles: [expect.stringMatching(/\.xml$/)] });
    expect(m.origin).toMatchObject({ format: 'vcdit.vfx-handoff/1' });
  });

  it('takes the whole clip as probed, clip-relative, with no handles', () => {
    let p = vcditProject();
    const id = '14_B_03_A015C002';
    p = ok(setProbedMedia(p, id, { file: 'x.mxf', frameCount: 240, timecodeIn: '14:22:10:05', frameRate: 23.976, resolution: { width: 4608, height: 3164 }, codec: 'arri_raw' }, 'prep', NOW));
    const shot = p.handoff.shots[0]!;
    expect(shotTiming(p, shot)).toEqual({ frameIn: 0, frameOut: 239, handles: 0, frameRate: 23.976, timecodeIn: '14:22:10:05', resolution: { width: 4608, height: 3164 }, from: 'probe' });
    expect(planFor(p, shot)).toMatchObject({ sourceIn: 0, sourceOut: 239, deliveredIn: 1001, deliveredOut: 1240, frameCount: 240 });
    expect(shotListRows(p).find((r) => r.shot === id)!.frames).toBe('1001–1240');
    expect(p.log.at(-1)).toMatchObject({ action: 'source.probed', shotId: id, detail: 'x.mxf: 240 frames, 23.976 fps, TC 14:22:10:05, 4608×3164, arri_raw' });
    // The handoff itself stays as received.
    expect(p.handoff.shots[0]!.frameIn).toBeUndefined();
    expect(setProbedMedia(p, id, { file: 'x', frameCount: -1 }, 'prep', NOW)).toMatchObject({ ok: false });
    expect(parseProject(serializeProject(p))).toEqual({ ok: true, project: p });
  });

  it('lets the VFX editor’s shot numbers be assigned, uniquely, before work starts', () => {
    let p = vcditProject();
    const id = '14_B_03_A015C002';
    p = ok(setVfxShotId(p, id, ' HLC_014_010 ', 'prep', NOW));
    expect(displayShotId(p, id)).toBe('HLC_014_010');
    expect(shotListRows(p).map((r) => r.shot)).toContain('HLC_014_010');
    expect(queueRows(p, { search: 'hlc_014' }).map((r) => r.shot.shotId)).toEqual([id]);
    expect(setVfxShotId(p, '14_01', 'HLC_014_010', 'prep', NOW)).toMatchObject({ ok: false, reason: /already HLC_014_010/ });
    expect(setVfxShotId(p, '14_01', '14_B_03_A015C002', 'prep', NOW)).toMatchObject({ ok: true });
    expect(setVfxShotId(p, '14_01', 'bad name!', 'prep', NOW)).toMatchObject({ ok: false });
    expect(p.log.at(-1)).toMatchObject({ action: 'shot.vfx_id', detail: '(none) → HLC_014_010' });
    // Unchanged: nothing logged.
    expect(ok(setVfxShotId(p, id, 'HLC_014_010', 'prep', NOW)).log).toHaveLength(p.log.length);
    const m = buildManifest(p, id, { generatedAt: NOW, appVersion: 't', operator: 'op', files: [] });
    expect(m.shot).toMatchObject({ shotId: 'HLC_014_010', handoffShotId: id });
    expect(m.plates.pattern).toBe('HLC_014_010_plate_v001.%04d.exr');

    p = ok(addTask(p, id, 'roto', 'prep', NOW));
    p = ok(setTaskState(p, id, 'roto', 'processing', 'prep', NOW));
    expect(setVfxShotId(p, id, 'HLC_014_020', 'prep', NOW)).toMatchObject({ ok: false, reason: /Work on .* has started/ });
    expect(ok(setVfxShotId(p, '14_01', '', 'prep', NOW)).shots.find((s) => s.shotId === '14_01')!.vfxShotId).toBeNull();
  });

  it('adds one task to several shots, reporting the ones it skipped', () => {
    let p = vcditProject();
    p = ok(addTask(p, '14_01', 'sequence_conversion', 'prep', NOW));
    const r = addTaskToShots(p, ['14_B_03_A015C002', '14_01', '22A_C_05', 'NOPE'], 'sequence_conversion', 'prep', NOW);
    expect(r.added).toEqual(['14_B_03_A015C002', '22A_C_05']);
    expect(r.skipped.map((s) => s.shotId)).toEqual(['14_01', 'NOPE']);
    expect(shotState(r.project, '22A_C_05')!.tasks.map((t) => t.kind)).toEqual(['sequence_conversion']);
    expect(r.project.log.filter((l) => l.action === 'task.added')).toHaveLength(3);
  });
});

describe('the native format is unchanged', () => {
  it('still reads the sample with its ranges, and probing does not override them', () => {
    const r = parseHandoff(JSON.stringify(SAMPLE_HANDOFF));
    if (!r.ok) throw new Error('sample did not parse');
    expect(r.handoff.origin).toBeUndefined();
    let p = createProject(r.handoff, 'sample', 'dit', NOW);
    p = ok(setProbedMedia(p, '010_020', { file: 'a.mxf', frameCount: 5 }, 'dit', NOW));
    expect(shotTiming(p, p.handoff.shots[0]!)).toMatchObject({ frameIn: 86400, frameOut: 86511, handles: 8, timecodeIn: '01:00:00:00', from: 'handoff' });
  });

  it('accepts a native shot without a range, with a warning, but not half a range', () => {
    const shot = { shotId: 'A', scene: '1', sourcePath: 'a.mov', frameRate: 24 };
    const r = parseHandoff(JSON.stringify({ project: 'X', shots: [shot] }));
    expect(r.ok && r.warnings.some((w) => /no frame range/.test(w.message))).toBe(true);
    const half = parseHandoff(JSON.stringify({ project: 'X', shots: [{ ...shot, frameIn: 3 }] }));
    expect(!half.ok && half.issues.map((i) => i.path)).toEqual(['shots[0].frameOut']);
  });

  it('opens an older project file, filling the new shot fields', () => {
    const r = parseHandoff(JSON.stringify(SAMPLE_HANDOFF));
    if (!r.ok) throw new Error('sample did not parse');
    const p = createProject(r.handoff, 'sample', 'dit', NOW);
    const old = JSON.parse(serializeProject(p));
    for (const s of old.shots) {
      delete s.vfxShotId;
      delete s.probe;
    }
    const back = parseProject(JSON.stringify(old));
    expect(back.ok && back.project.shots[0]).toMatchObject({ vfxShotId: null, probe: null });
  });
});
