import { describe, expect, it } from 'vitest';
import {
  PREP_TASKS,
  PROJECT_VERSION,
  SAMPLE_HANDOFF,
  addTextureReference,
  addTextureRegion,
  approveTask,
  buildManifest,
  createProject,
  decideTexturePlacement,
  flagTextureRegion,
  markTextureRegionReviewed,
  nextTextureProblem,
  parseHandoff,
  parseProject,
  recordTextureExport,
  recordTextureRun,
  removeTextureReference,
  removeTextureRegion,
  serializeProject,
  setTaskState,
  setTextureReference,
  shotState,
  textureBuildProblem,
  textureConfidence,
  textureDoc,
  textureLocked,
  textureManifest,
  textureMetadata,
  textureNames,
  texturePlacementOf,
  textureProblemReason,
  textureRegionPlane,
  textureReview,
  textureSizeMetres,
  textureSummary,
  updateTextureRegion,
  type Project,
  type Result,
  type TextureExportInput,
  type TextureMetrics,
  type TexturePlane,
  type TextureReferenceInput,
  type TextureRunResult,
} from '../index.js';

const NOW = new Date('2026-10-22T12:00:00Z');
const SHOT = '040_010';
const ok = (r: Result): Project => {
  if (!r.ok) throw new Error(r.reason);
  return r.project;
};
const sample = (): Project => {
  const r = parseHandoff(JSON.stringify(SAMPLE_HANDOFF));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return createProject(r.handoff, '/Volumes/DRIVE/handoff.json', 'dit', NOW);
};
const doc = (p: Project) => textureDoc(shotState(p, SHOT))!;
const task = (p: Project) => shotState(p, SHOT)!.tasks.find((t) => t.kind === 'texture_extraction')!;
const photo = (name: string, over: Partial<TextureReferenceInput> = {}): TextureReferenceInput => ({
  kind: 'photo',
  name,
  path: `/Volumes/DRIVE/REF/${name}`,
  from: 'disk',
  format: 'jpg',
  checksum: { algorithm: 'sha256', value: 'a'.repeat(64) },
  bytes: 1000,
  width: 4000,
  height: 3000,
  points: null,
  encoding: 'srgb',
  ...over,
});
const quad: [[number, number], [number, number], [number, number], [number, number]] = [
  [1000, 800],
  [3000, 900],
  [2900, 2300],
  [1100, 2200],
];
const good: TextureMetrics = {
  width: 1024,
  height: 512,
  texelDensity: 512,
  nativeDensity: 900,
  residualBefore: 1.1,
  residualAfter: 0.05,
  detailKept: 0.97,
  seamScore: 1.05,
  sharpness: 0.8,
  clipped: 0,
  specular: 0,
  exposureGain: 1,
  coverage: 1,
  aspect: 2,
  aspectFrom: 'size',
  planeId: 'p1',
  planeConfidence: 0.9,
};
const plane = (id: string, label: string): TexturePlane => ({ id, label, normal: [0, 0, -1], d: -3, centroid: [0, 1.5, 3], axisU: [1, 0, 0], axisV: [0, -1, 0], extent: { u0: -3, u1: 3, v0: -1.5, v1: 1.5 }, inliers: 4000, rms: 0.004 });
const suggestion = (planeId: string | null, confidence = 0.85) => ({ direction: { yawDeg: 12, pitchDeg: -5, rollDeg: 0, fovDeg: 60 }, planeId, hit: [0.4, 1.2, 3] as [number, number, number], confidence, score: 0.8, method: 'panorama' as const, note: '' });

function withRegion(): Project {
  let p = ok(addTextureReference(sample(), SHOT, photo('wall_A.jpg'), 'ana', NOW));
  p = ok(addTextureReference(p, SHOT, { kind: 'panorama', name: 'room_360.exr', path: '/Volumes/DRIVE/REF/room_360.exr', from: 'disk', format: 'exr', checksum: null, bytes: 10, width: 4096, height: 2048, points: null, encoding: 'acescg' }, 'ana', NOW));
  p = ok(addTextureReference(p, SHOT, { kind: 'scan', name: 'room.e57', path: '/Volumes/DRIVE/LIDAR/room.e57', from: 'disk', format: 'e57', checksum: null, bytes: 10, width: null, height: null, points: 120000, encoding: null, scan: { units: 'm', up: 'y' } }, 'ana', NOW));
  return ok(addTextureRegion(p, SHOT, { photoId: 'ph1', corners: quad, name: 'Brick wall', size: { width: 2, height: 1, units: 'm' } }, 'ana', NOW));
}
const run = (p: Project, over: Partial<TextureMetrics> = {}, placements = [{ photoId: 'ph1', suggested: suggestion('p1') }]): TextureRunResult => ({
  revision: doc(p).revision,
  regions: doc(p).regions.map((r) => ({ regionId: r.id, confidence: textureConfidence({ ...good, ...over }, r.settings.tile !== 'none'), metrics: { ...good, ...over } })),
  planes: [plane('p1', 'wall facing −Z'), plane('p2', 'floor')],
  placements,
});
const exportRecord = (p: Project): TextureExportInput => ({
  version: task(p).version,
  folder: `07_TEXTURES_REFERENCES/${textureNames.folder(SHOT, task(p).version)}`,
  regions: doc(p).regions.map((r) => {
    const stem = textureNames.stem(SHOT, r, task(p).version);
    return { id: r.id, name: r.name, map: textureNames.map(stem), mapExr: textureNames.mapExr(stem), original: textureNames.original(stem), tilePreview: null, mask: textureNames.mask(stem), width: 1024, height: 512, planeId: 'p1' };
  }),
  mapping: textureNames.mapping(SHOT, task(p).version),
  obj: textureNames.obj(SHOT, task(p).version),
  mtl: textureNames.mtl(SHOT, task(p).version),
  format: 'exr',
  encoding: 'ACEScg (linear AP1)',
  summary: { regions: 1, mean: 0.9, min: 0.9, low: [] },
  algorithm: 'vcvfx-texture@1.0.0',
  revision: doc(p).revision,
  files: 7,
});

describe('the texture document', () => {
  it('texture extraction is an available task in 07_TEXTURES_REFERENCES, and the sample has a set to texture', () => {
    expect(PREP_TASKS.texture_extraction).toMatchObject({ available: true, folder: '07_TEXTURES_REFERENCES', short: 'Textures' });
    const s = shotState(sample(), SHOT)!;
    expect(s.tasks.map((t) => t.kind)).toEqual(['texture_extraction']);
    expect(s.texture).toBeNull();
    expect(textureLocked(s)).toBeNull();
    expect(textureLocked(shotState(sample(), '010_020')!)).toContain('no Texture extraction task');
  });

  it('ingests references: logs who/when/what with the checksum, moves the task pending → processing, and refuses what it cannot use', () => {
    let p = ok(addTextureReference(sample(), SHOT, photo('wall_A.jpg', { camera: { focalMm: 24, filmBackWidthMm: 36, distortion: { k1: -0.08, k2: 0.01, k3: 0, p1: 0, p2: 0 } } }), 'ana', NOW));
    expect(doc(p).references[0]).toMatchObject({ id: 'ph1', kind: 'photo', width: 4000, camera: { focalMm: 24, distortion: { k1: -0.08 } }, addedBy: 'ana' });
    expect(task(p).state).toBe('processing');
    const actions = p.log.slice(-3).map((e) => e.action);
    expect(actions).toEqual(['texture.started', 'texture.reference_added', 'task.state']);
    expect(p.log.at(-2)!.detail).toContain('sha256 aaaaaaaaaaaa');
    expect(p.log.at(-2)!.detail).toContain('lens distortion known');
    expect(addTextureReference(p, SHOT, photo('wall_A.jpg'), 'ana', NOW)).toMatchObject({ ok: false });
    expect(addTextureReference(p, SHOT, photo('no_size.jpg', { width: null, height: null }), 'ana', NOW)).toMatchObject({ ok: false, reason: expect.stringContaining('picture size') });
    expect(addTextureReference(sample(), '010_020', photo('x.jpg'), 'ana', NOW)).toMatchObject({ ok: false, reason: expect.stringContaining('no Texture extraction task') });
    // The scan's units and up axis; the panorama's heading and position.
    p = withRegion();
    const rev = doc(p).revision;
    p = ok(setTextureReference(p, SHOT, 'scan3', { scan: { units: 'cm' } }, 'ana', NOW));
    p = ok(setTextureReference(p, SHOT, 'pano2', { panorama: { headingDeg: 30, position: [0, 1.5, 0] } }, 'ana', NOW));
    expect(doc(p).revision).toBe(rev + 2);
    expect(doc(p).references.find((r) => r.id === 'pano2')!.panorama).toEqual({ headingDeg: 30, position: [0, 1.5, 0] });
    expect(setTextureReference(p, SHOT, 'ph1', { scan: { units: 'm' } }, 'ana', NOW).ok).toBe(false);
    expect(setTextureReference(p, SHOT, 'scan3', { camera: { focalMm: 20 } }, 'ana', NOW).ok).toBe(false);
  });

  it('marks regions by four corners, checks them, and takes real size, settings and a surface', () => {
    let p = withRegion();
    const r = doc(p).regions[0]!;
    expect(r).toMatchObject({ id: 'r4', name: 'Brick wall', photoId: 'ph1', size: { width: 2, height: 1, units: 'm' }, settings: { tile: 'none', delight: 1, undistort: true, rectify: true } });
    expect(textureSizeMetres({ width: 200, height: 100, units: 'cm' })).toEqual({ width: 2, height: 1 });
    // An unnamed region is numbered by the regions, not by the ids the references share (r5 is "Region 2").
    const unnamed = ok(addTextureRegion(p, SHOT, { photoId: 'ph1', corners: quad }, 'ana', NOW));
    expect(doc(unnamed).regions.map((x) => [x.id, x.name])).toEqual([['r4', 'Brick wall'], ['r5', 'Region 2']]);
    const crossed: typeof quad = [quad[0], quad[2], quad[1], quad[3]];
    expect(addTextureRegion(p, SHOT, { photoId: 'ph1', corners: crossed }, 'ana', NOW)).toMatchObject({ ok: false, reason: expect.stringContaining('cross') });
    expect(addTextureRegion(p, SHOT, { photoId: 'ph1', corners: [[0, 0], [4, 0], [4, 4], [0, 4]] }, 'ana', NOW)).toMatchObject({ ok: false, reason: expect.stringContaining('too small') });
    expect(addTextureRegion(p, SHOT, { photoId: 'pano2', corners: quad }, 'ana', NOW)).toMatchObject({ ok: false, reason: expect.stringContaining('photographs') });
    expect(addTextureRegion(p, SHOT, { photoId: 'ph1', corners: [[-5000, 0], [3000, 900], [2900, 2300], [1100, 2200]] }, 'ana', NOW)).toMatchObject({ ok: false, reason: expect.stringContaining('outside') });
    p = ok(updateTextureRegion(p, SHOT, 'r4', { settings: { tile: 'xy', output: { mode: 'density', density: 400 } } }, 'ana', NOW));
    expect(doc(p).regions[0]!.settings).toMatchObject({ tile: 'xy', output: { mode: 'density', density: 400, resolution: 1024 } });
    expect(p.log.at(-1)!.detail).toContain('tile "none" → "xy"');
    expect(updateTextureRegion(p, SHOT, 'r4', { size: null }, 'ana', NOW)).toMatchObject({ ok: false, reason: expect.stringContaining('real size') });
    expect(updateTextureRegion(p, SHOT, 'r4', { planeId: 'p9' }, 'ana', NOW)).toMatchObject({ ok: false, reason: 'No scan plane p9' });
    expect(updateTextureRegion(p, SHOT, 'r4', { settings: { delight: 2 } }, 'ana', NOW).ok).toBe(false);
    const rev = doc(p).revision;
    expect(doc(ok(updateTextureRegion(p, SHOT, 'r4', { name: 'Brick wall' }, 'ana', NOW))).revision).toBe(rev);
    p = ok(addTextureRegion(p, SHOT, { photoId: 'ph1', corners: [[100, 100], [600, 100], [600, 500], [100, 500]] }, 'ana', NOW));
    expect(doc(p).regions.map((x) => x.id)).toEqual(['r4', 'r5']);
    p = ok(removeTextureRegion(p, SHOT, 'r5', 'ana', NOW));
    expect(doc(p).regions.map((x) => x.id)).toEqual(['r4']);
    // Removing the photo takes its regions with it; the file is untouched (only its record goes).
    const q = ok(removeTextureReference(p, SHOT, 'ph1', 'ana', NOW));
    expect(doc(q).regions).toEqual([]);
    expect(q.log.at(-1)!.detail).toContain('with its region r4');
    expect(textureBuildProblem(doc(q))).toContain('photos');
    expect(textureBuildProblem(doc(p))).toBeNull();
  });

  it('records a build for review (never approval), refuses a stale one, finds the problems and keeps the artist’s decisions', () => {
    let p = withRegion();
    expect(recordTextureRun(p, SHOT, { ...run(p), revision: doc(p).revision - 1 }, 'ana', NOW)).toMatchObject({ ok: false, reason: expect.stringContaining('Build again') });
    p = ok(recordTextureRun(p, SHOT, run(p, { sharpness: 0.1, clipped: 0.03 }), 'ana', NOW));
    expect(task(p).state).toBe('needs_review');
    expect(task(p).approval).toBeNull();
    const rec = doc(p).records[0]!;
    expect(rec.confidence).toBeLessThan(0.6);
    expect(rec.reason).toContain('blurred');
    expect(rec.reason).toContain('clipped');
    expect(doc(p).planes.map((x) => x.id)).toEqual(['p1', 'p2']);
    expect(doc(p).placements[0]).toMatchObject({ photoId: 'ph1', decision: 'pending', suggested: { planeId: 'p1' } });
    const review = textureReview(doc(p));
    expect(review.problems.map((x) => x.regionId)).toEqual(['r4']);
    expect(review.pendingPlacements).toEqual(['ph1']);
    expect(nextTextureProblem(review, doc(p), null)).toBe('r4');
    expect(p.log.at(-2)!.detail).toContain('problems in r4');
    // Look and decide.
    p = ok(markTextureRegionReviewed(p, SHOT, 'r4', 'ana', NOW));
    expect(textureReview(doc(p)).problems).toEqual([]);
    p = ok(flagTextureRegion(p, SHOT, 'r4', 'reshoot', 'ana', NOW));
    expect(textureReview(doc(p)).problems[0]!.reason).toBe('flagged: reshoot');
    p = ok(decideTexturePlacement(p, SHOT, 'ph1', { decision: 'accepted' }, 'ana', NOW));
    expect(texturePlacementOf(doc(p), 'ph1')).toMatchObject({ planeId: 'p1', decided: true });
    expect(textureRegionPlane(doc(p), doc(p).regions[0]!)!.id).toBe('p1');
    // A new build suggesting the same surface keeps the acceptance; another surface puts it back to pending.
    p = ok(recordTextureRun(p, SHOT, run(p), 'ana', NOW));
    expect(doc(p).placements[0]!.decision).toBe('accepted');
    expect(doc(p).records[0]!.status).toBe('flagged');
    p = ok(recordTextureRun(p, SHOT, run(p, {}, [{ photoId: 'ph1', suggested: suggestion('p2') }]), 'ana', NOW));
    expect(doc(p).placements[0]!.decision).toBe('pending');
    // Reject: the region keeps no suggested surface; edit: the artist's own.
    p = ok(decideTexturePlacement(p, SHOT, 'ph1', { decision: 'rejected' }, 'ana', NOW));
    expect(texturePlacementOf(doc(p), 'ph1')).toBeNull();
    expect(textureRegionPlane(doc(p), doc(p).regions[0]!)).toBeNull();
    p = ok(decideTexturePlacement(p, SHOT, 'ph1', { decision: 'edited', direction: { yawDeg: 90, pitchDeg: -10, rollDeg: 0, fovDeg: 50 }, planeId: 'p2' }, 'ana', NOW));
    expect(texturePlacementOf(doc(p), 'ph1')).toMatchObject({ planeId: 'p2', confidence: 1, decided: true, direction: { yawDeg: 90 } });
    expect(textureRegionPlane(doc(p), doc(p).regions[0]!)!.id).toBe('p2');
    p = ok(updateTextureRegion(p, SHOT, 'r4', { planeId: 'p1' }, 'ana', NOW));
    expect(textureRegionPlane(doc(p), doc(p).regions[0]!)!.label).toBe('wall facing −Z');
    expect(decideTexturePlacement(withRegion(), SHOT, 'ph1', { decision: 'accepted' }, 'ana', NOW)).toMatchObject({ ok: false, reason: expect.stringContaining('build first') });
    expect(decideTexturePlacement(p, SHOT, 'ph1', { decision: 'edited', direction: { yawDeg: 0, pitchDeg: 0, rollDeg: 0, fovDeg: 50 }, planeId: 'nope' }, 'ana', NOW).ok).toBe(false);
  });

  it('flags each problem a region can have, and scores confidence from them', () => {
    const reason = (m: Partial<TextureMetrics>, tile = 'none' as 'none' | 'xy') => textureProblemReason({ confidence: textureConfidence({ ...good, ...m }, tile !== 'none'), metrics: { ...good, ...m } }, { settings: { tile } as never }, true);
    expect(reason({})).toBe('');
    expect(textureConfidence(good, true)).toBeGreaterThan(0.95);
    expect(reason({ sharpness: 0.1 })).toContain('blurred');
    expect(reason({ clipped: 0.02 })).toContain('clipped');
    expect(reason({ specular: 0.05 })).toContain('specular');
    expect(reason({ nativeDensity: 200 })).toContain('too low a texel density');
    expect(reason({ residualAfter: 0.6 })).toContain('light still varies');
    expect(reason({ seamScore: 2.4 }, 'xy')).toContain('seams show');
    expect(reason({ seamScore: 2.4 }, 'none')).not.toContain('seams');
    expect(reason({ coverage: 0.8 })).toContain('outside the photo');
    expect(reason({ planeId: null })).toContain('no surface');
    expect(textureConfidence({ ...good, sharpness: 0.05, clipped: 0.05 }, false)).toBeLessThan(0.4);
  });

  it('approval needs an export of the version; approved textures are locked until reopened, and the next export is v002', () => {
    let p = withRegion();
    p = ok(recordTextureRun(p, SHOT, run(p), 'ana', NOW));
    expect(approveTask(p, SHOT, 'texture_extraction', 'Sup', NOW)).toMatchObject({ ok: false, reason: expect.stringContaining('Export textures v001 first') });
    p = ok(recordTextureExport(p, SHOT, exportRecord(p), 'ana', NOW));
    expect(task(p).state).toBe('needs_review');
    expect(recordTextureExport(p, SHOT, { ...exportRecord(p), version: 2 }, 'ana', NOW)).toMatchObject({ ok: false });
    p = ok(approveTask(p, SHOT, 'texture_extraction', 'Sup', NOW));
    expect(task(p)).toMatchObject({ state: 'approved', approval: { by: 'Sup' } });
    expect(updateTextureRegion(p, SHOT, 'r4', { settings: { delight: 0.5 } }, 'ana', NOW)).toMatchObject({ ok: false, reason: expect.stringContaining('Textures v001 are approved') });
    expect(addTextureReference(p, SHOT, photo('more.jpg'), 'ana', NOW).ok).toBe(false);
    p = ok(setTaskState(p, SHOT, 'texture_extraction', 'needs_correction', 'Sup', NOW));
    expect(task(p).version).toBe(2);
    p = ok(updateTextureRegion(p, SHOT, 'r4', { settings: { delight: 0.5 } }, 'ana', NOW));
    p = ok(recordTextureRun(p, SHOT, run(p), 'ana', NOW));
    expect(approveTask(p, SHOT, 'texture_extraction', 'Sup', NOW)).toMatchObject({ ok: false, reason: expect.stringContaining('v002') });
    p = ok(recordTextureExport(p, SHOT, exportRecord(p), 'ana', NOW));
    expect(doc(p).exports.map((e) => e.folder)).toEqual(['07_TEXTURES_REFERENCES/040_010_tex_v001', '07_TEXTURES_REFERENCES/040_010_tex_v002']);
    expect(doc(p).runs.map((r) => r.taskVersion)).toEqual([1, 2]);
  });

  it('names its files, writes the mapping file, the summary and the package manifest section', () => {
    let p = withRegion();
    p = ok(updateTextureRegion(p, SHOT, 'r4', { settings: { tile: 'xy' } }, 'ana', NOW));
    p = ok(recordTextureRun(p, SHOT, run(p), 'ana', NOW));
    const r = doc(p).regions[0]!;
    const stem = textureNames.stem('040_010', r, 1);
    expect(stem).toBe('040_010_tex_r4_Brick_wall_v001');
    expect([textureNames.map(stem), textureNames.mapExr(stem), textureNames.mask(stem), textureNames.tilePreview(stem)]).toEqual(['040_010_tex_r4_Brick_wall_v001.png', '040_010_tex_r4_Brick_wall_v001.exr', '040_010_tex_r4_Brick_wall_v001_mask.png', '040_010_tex_r4_Brick_wall_v001_tile3x3.png']);
    const summary = textureSummary(doc(p));
    expect(summary).toMatchObject({ regions: 1, built: 1, texelDensity: 512, seamScore: 1.05, placement: 0.85, problems: [] });
    const meta = textureMetadata(p, SHOT, {
      version: 1,
      encoding: 'ACEScg (linear AP1)',
      linear: true,
      format: 'exr',
      generator: 'VC VFX test',
      writtenAt: NOW.toISOString(),
      by: 'ana',
      regions: [{ id: 'r4', homography: [1, 0, 0, 0, 1, 0, 0, 0, 1], undistorted: false, width: 1024, height: 512, texelDensity: 512, patch: [[0, 0, 3], [2, 0, 3], [2, 1, 3], [0, 1, 3]], files: { map: 'a.png' }, metrics: good, confidence: 0.95 }],
      obj: 'x.obj',
      mtl: 'x.mtl',
      scanFrame: { units: 'm', up: 'y' },
    });
    expect(meta).toMatchObject({ format: 'vcvfx.texture/1', task: 'texture_extraction', version: 'v001', mesh: { obj: 'x.obj' }, planes: [{ id: 'p1' }, { id: 'p2' }] });
    expect(meta.regions[0]).toMatchObject({ id: 'r4', sourcePhoto: { id: 'ph1', name: 'wall_A.jpg' }, realSize: { width: 2 }, surface: { planeId: 'p1', chosenBy: 'suggestion' }, panoramaDirection: { yawDeg: 12 } });
    expect(meta.references.map((x) => x.kind)).toEqual(['photo', 'panorama', 'scan']);
    expect(textureManifest(shotState(sample(), SHOT)!)).toBeNull();
    p = ok(recordTextureExport(p, SHOT, exportRecord(p), 'ana', NOW));
    const m = buildManifest(p, SHOT, { generatedAt: NOW, appVersion: '0.1.0', operator: 'ana', files: [] }).texture!;
    expect(m).toMatchObject({ task: 'texture_extraction', version: 'v001', exported: true, folder: '07_TEXTURES_REFERENCES/040_010_tex_v001', mapping: '07_TEXTURES_REFERENCES/040_010_tex_v001/040_010_tex_v001.json', obj: '07_TEXTURES_REFERENCES/040_010_tex_v001/040_010_tex_v001.obj', format: 'exr', planes: 2 });
    expect(m.textures[0]).toMatchObject({ id: 'r4', map: '07_TEXTURES_REFERENCES/040_010_tex_v001/040_010_tex_r4_Brick_wall_v001.png' });
    expect(m.references.map((x) => x.checksum)).toEqual(['a'.repeat(64), null, null]);
  });

  it('is project format 7 (now 9): projects of formats 3 to 6 open with no textures, and textures survive a round trip', () => {
    expect(PROJECT_VERSION).toBe(12);
    const v6 = JSON.parse(serializeProject(sample()));
    v6.version = 6;
    for (const s of v6.shots) delete s.texture;
    const opened6 = parseProject(JSON.stringify(v6));
    if (!opened6.ok) throw new Error(opened6.reason);
    expect(opened6.project.version).toBe(12);
    expect(shotState(opened6.project, SHOT)!.texture).toBeNull();
    const v5 = JSON.parse(JSON.stringify(v6));
    v5.version = 5;
    for (const s of v5.shots) delete s.isolate;
    const v4 = JSON.parse(JSON.stringify(v5));
    v4.version = 4;
    for (const s of v4.shots) delete s.cleanPlate;
    const v3 = JSON.parse(JSON.stringify(v4));
    v3.version = 3;
    for (const s of v3.shots) delete s.key;
    for (const old of [v5, v4, v3]) {
      const opened = parseProject(JSON.stringify(old));
      if (!opened.ok) throw new Error(opened.reason);
      expect(opened.project.version).toBe(12);
      expect(shotState(opened.project, SHOT)!.texture).toBeNull();
    }
    let p = withRegion();
    p = ok(recordTextureRun(p, SHOT, run(p), 'ana', NOW));
    p = ok(decideTexturePlacement(p, SHOT, 'ph1', { decision: 'accepted' }, 'ana', NOW));
    const again = parseProject(serializeProject(p));
    if (!again.ok) throw new Error(again.reason);
    expect(shotState(again.project, SHOT)!.texture).toEqual(shotState(p, SHOT)!.texture);
    const newer = JSON.parse(serializeProject(p));
    newer.version = PROJECT_VERSION + 1;
    expect(parseProject(JSON.stringify(newer)).ok).toBe(false);
  });
});
