import { describe, expect, it } from 'vitest';
import {
  PREP_TASKS,
  PROJECT_VERSION,
  SAMPLE_HANDOFF,
  addLight,
  addLightingReference,
  addTask,
  approveTask,
  balancedRgb,
  buildManifest,
  cctOfXy,
  createProject,
  decideLightingSuggestion,
  kelvinRange,
  kelvinRgb,
  lightingDoc,
  lightingExportProblem,
  lightingFrames,
  lightingLens,
  lightingManifest,
  lightingNames,
  lightingRig,
  lightingRigData,
  lightingSummary,
  lockLightFields,
  parseHandoff,
  parseProject,
  planckianXy,
  recordLightingAiReview,
  recordLightingAnalysis,
  recordLightingExport,
  removeLight,
  removeLightingReference,
  restoreLight,
  serializeProject,
  setLensOverride,
  setLightFields,
  setLightingFrames,
  setLightingSettings,
  setTaskState,
  shotState,
  temperatureOf,
  updateLightingReference,
  wrapAzimuth,
  type LightEstimate,
  type LightingAnalysisInput,
  type LightingDocument,
  type LightingExportInput,
  type Project,
  type Result,
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
const withTask = () => ok(addTask(sample(), SHOT, 'lighting_analysis', 'ana', NOW));
const doc = (p: Project): LightingDocument => lightingDoc(shotState(p, SHOT))!;
const task = (p: Project) => shotState(p, SHOT)!.tasks.find((t) => t.kind === 'lighting_analysis')!;
const lastLog = (p: Project) => p.log[p.log.length - 1]!;
const R = (value: number, low: number, high: number) => ({ value, low, high });

function light(id: string, role: LightEstimate['role'], az: number, el: number, stops: number, extra: Partial<LightEstimate> = {}): LightEstimate {
  return {
    id,
    role,
    type: role === 'ambient' ? 'dome' : 'rect',
    name: role[0]!.toUpperCase() + role.slice(1),
    azimuth: R(az, az - 8, az + 8),
    elevation: R(el, el - 6, el + 6),
    distance: role === 'ambient' ? null : R(3, 2, 5),
    intensity: R(stops, stops - 0.4, stops + 0.4),
    size: R(20, 12, 30),
    temperature: R(4300, 3900, 4800),
    rgb: kelvinRgb(4300),
    practical: null,
    motivation: '',
    evidence: ['shading'],
    confidence: 0.8,
    ...extra,
  };
}

function analysis(p: Project, lights: LightEstimate[] = [light('key', 'key', 40, 30, 0), light('fill', 'fill', -40, 10, -2), light('rim', 'rim', 160, 25, -1)]): LightingAnalysisInput {
  return {
    algorithm: 'vcvfx-lighting@1.0.0',
    revision: doc(p)?.revision ?? 0,
    frame: 3035,
    frames: [3035],
    lights,
    lens: {
      focalMm: R(25, 25, 25),
      focalSource: 'metadata',
      checks: [{ source: 'vanishing', focalMm: R(26, 23, 29), agrees: true, note: '' }],
      filmBackMm: { width: 27.99, height: 19.22 },
      filmBackSource: 'database',
      hfovDeg: R(58.4, 58.4, 58.4),
      vfovDeg: R(42.1, 42.1, 42.1),
      distortion: { k1: null, source: 'none', note: '' },
      aperture: { fStop: null, source: 'unknown', note: '' },
      focusDistance: null,
      lines: 12,
      vanishingPoints: 2,
    },
    keyConfidence: 0.82,
    matchScore: 0.91,
    subject: { source: 'roto', coverage: 0.12, centre: { x: 0.45, y: 0.6 } },
    sky: { found: false, coverage: 0, source: 'none' },
    ground: { source: 'assumed', heightM: 1.5, pitchDeg: 0 },
    whiteBalance: { kelvin: 5600, source: 'assumed' },
    marks: [{ kind: 'practical', x: 0.8, y: 0.3, x2: null, y2: null, r: 0.01, lightId: null, label: 'lamp' }],
    warnings: [],
    ms: 420,
  };
}

function exportRecord(p: Project): LightingExportInput {
  const stem = lightingNames.stem(SHOT, task(p).version);
  return {
    version: task(p).version,
    folder: `09_PROJECT_DATA/${lightingNames.folder(SHOT, task(p).version)}`,
    files: [lightingNames.unreal(stem), lightingNames.rig(stem), lightingNames.usd(stem), lightingNames.report(stem), 'README.txt'],
    formats: ['unreal', 'json', 'usd', 'report'],
    lights: lightingRig(doc(p)).length,
    camera: 'estimate',
    revision: doc(p).revision,
    editRevision: doc(p).editRevision,
    algorithm: 'vcvfx-lighting@1.0.0',
  };
}

describe('the lighting task', () => {
  it('is available, files under 09_PROJECT_DATA, and needs the task on the shot', () => {
    expect(PREP_TASKS.lighting_analysis).toMatchObject({ available: true, folder: '09_PROJECT_DATA', short: 'Lighting' });
    expect(setLightingFrames(sample(), SHOT, [3035], 'ana', NOW)).toMatchObject({ ok: false, reason: expect.stringContaining('no Lighting and lens analysis task') });
  });

  it('frames and settings are logged and bump the analysis revision; the exposure reference only the rig', () => {
    let p = ok(setLightingFrames(withTask(), SHOT, [3040, 3035, 3040], 'ana', NOW));
    expect(doc(p).settings.frames).toEqual([3040, 3035]);
    expect(doc(p).revision).toBe(1);
    expect(task(p).state).toBe('processing');
    expect(p.log.some((e) => e.action === 'lighting.started')).toBe(true);
    expect(lightingFrames(doc(p), 3000, 3071)).toEqual([3040, 3035]);
    expect(lightingFrames(null, 3000, 3071)).toEqual([3036]);
    p = ok(setLightingSettings(p, SHOT, { subjectDistanceM: 4, subject: 'roto' }, 'ana', NOW));
    expect(doc(p).revision).toBe(2);
    expect(lastLog(p).detail).toContain('subjectDistanceM 3 → 4');
    p = ok(setLightingSettings(p, SHOT, { keyLux: 2000 }, 'ana', NOW));
    expect(doc(p).revision).toBe(2);
    expect(doc(p).editRevision).toBe(1);
    expect(setLightingSettings(p, SHOT, { subjectDistanceM: -1 }, 'ana', NOW).ok).toBe(false);
  });

  it('references: a ball in the plate needs its frame, an HDRI must be 2:1 and one per shot; circles and headings are logged', () => {
    let p = withTask();
    expect(addLightingReference(p, SHOT, { kind: 'chrome_ball', name: 'Chrome ball', from: 'plate', path: '', frame: null, circle: null, headingDeg: null, format: '', checksum: null, bytes: null, width: null, height: null, encoding: null }, 'ana', NOW).ok).toBe(false);
    p = ok(addLightingReference(p, SHOT, { kind: 'chrome_ball', name: 'Chrome ball', from: 'plate', path: '', frame: 3070, circle: { cx: 200, cy: 150, r: 40 }, headingDeg: null, format: '', checksum: null, bytes: null, width: null, height: null, encoding: null }, 'ana', NOW));
    expect(doc(p).references[0]!.id).toBe('chrome1');
    expect(addLightingReference(p, SHOT, { kind: 'hdri', name: 'set.exr', from: 'disk', path: '/refs/set.exr', frame: null, circle: null, headingDeg: null, format: 'exr', checksum: null, bytes: 10, width: 1000, height: 1000, encoding: 'linear_rec709' }, 'ana', NOW)).toMatchObject({ ok: false, reason: expect.stringContaining('twice as wide') });
    p = ok(addLightingReference(p, SHOT, { kind: 'hdri', name: 'set.exr', from: 'disk', path: '/refs/set.exr', frame: null, circle: null, headingDeg: null, format: 'exr', checksum: { algorithm: 'sha256', value: 'a'.repeat(64) }, bytes: 10, width: 2048, height: 1024, encoding: 'linear_rec709' }, 'ana', NOW));
    expect(addLightingReference(p, SHOT, { kind: 'hdri', name: 'b.exr', from: 'disk', path: '/refs/b.exr', frame: null, circle: null, headingDeg: null, format: 'exr', checksum: null, bytes: 10, width: 2048, height: 1024, encoding: null }, 'ana', NOW).ok).toBe(false);
    const hdri = doc(p).references[1]!.id;
    p = ok(updateLightingReference(p, SHOT, hdri, { headingDeg: 12.34 }, 'ana', NOW));
    expect(lastLog(p).detail).toBe(`${hdri}: heading 12.3°`);
    expect(updateLightingReference(p, SHOT, hdri, { circle: { cx: 1, cy: 1, r: 1 } }, 'ana', NOW).ok).toBe(false);
    p = ok(updateLightingReference(p, SHOT, 'chrome1', { circle: { cx: 210.04, cy: 150, r: 41 } }, 'ana', NOW));
    expect(doc(p).references[0]!.circle).toEqual({ cx: 210, cy: 150, r: 41 });
    const rev = doc(p).revision;
    p = ok(removeLightingReference(p, SHOT, 'chrome1', 'ana', NOW));
    expect(doc(p).references.map((r) => r.kind)).toEqual(['hdri']);
    expect(doc(p).revision).toBe(rev + 1);
  });
});

describe('the analysis and the artist’s edits', () => {
  it('an analysis puts the rig up for review, never approves; one of older settings is refused', () => {
    let p = ok(setLightingFrames(withTask(), SHOT, [3035], 'ana', NOW));
    expect(recordLightingAnalysis(p, SHOT, { ...analysis(p), revision: 0 }, 'ana', NOW)).toMatchObject({ ok: false, reason: expect.stringContaining('Analyse again') });
    p = ok(recordLightingAnalysis(p, SHOT, analysis(p), 'ana', NOW));
    expect(task(p)).toMatchObject({ state: 'needs_review', approval: null });
    const line = p.log.find((e) => e.action === 'lighting.analysed')!;
    expect(line.detail).toContain('3 lights (key, fill, rim)');
    expect(line.detail).toContain('key az 40° (32–48°)');
    expect(line.detail).toContain('lens 25.0 mm (25.0–25.0 mm) from metadata');
    const s = lightingSummary(doc(p));
    expect(s).toMatchObject({ analysed: true, current: true, lights: 3, estimated: 3, edited: 0, keyConfidence: 0.82, matchScore: 0.91 });
    expect(doc(p).runs).toHaveLength(1);
    // A range must hold its value.
    const bad = analysis(p);
    bad.lights[0]!.azimuth = R(40, 41, 50);
    expect(recordLightingAnalysis(p, SHOT, bad, 'ana', NOW).ok).toBe(false);
  });

  it('edits lock fields, survive a new analysis, and an edited light not found again is kept as the artist’s', () => {
    let p = withTask();
    p = ok(recordLightingAnalysis(p, SHOT, analysis(p), 'ana', NOW));
    p = ok(setLightFields(p, SHOT, 'key', { azimuthDeg: 50, intensityStops: 0.5 }, 'ana', NOW));
    expect(lastLog(p).action).toBe('task.state');
    expect(p.log.at(-2)!.detail).toBe('key (Key): azimuth 40° → 50°, intensity 0 stops → +0.5 stops');
    expect(task(p).state).toBe('needs_correction');
    let key = lightingRig(doc(p)).find((l) => l.id === 'key')!;
    expect(key.spec).toMatchObject({ azimuthDeg: 50, elevationDeg: 30, intensityStops: 0.5 });
    expect(key.locked.sort()).toEqual(['azimuthDeg', 'intensityStops']);
    p = ok(setLightFields(p, SHOT, 'rim', { name: 'Hair light' }, 'ana', NOW));
    // Wrap-around and type consistency.
    p = ok(setLightFields(p, SHOT, 'fill', { azimuthDeg: -170 - 30 + 360 }, 'ana', NOW));
    expect(wrapAzimuth(190)).toBe(-170);
    p = ok(setLightFields(p, SHOT, 'fill', { type: 'directional' }, 'ana', NOW));
    expect(lightingRig(doc(p)).find((l) => l.id === 'fill')!.spec.distanceM).toBeNull();
    expect(setLightFields(p, SHOT, 'key', { elevationDeg: 120 }, 'ana', NOW).ok).toBe(false);
    expect(setLightFields(p, SHOT, 'nope', { elevationDeg: 10 }, 'ana', NOW).ok).toBe(false);

    // A new analysis: the key moved and the rim was not found.
    p = ok(setLightingSettings(p, SHOT, { subjectDistanceM: 3.5 }, 'ana', NOW));
    p = ok(recordLightingAnalysis(p, SHOT, analysis(p, [light('key', 'key', 30, 45, 0), light('fill', 'fill', -45, 5, -2.5)]), 'ana', NOW));
    key = lightingRig(doc(p)).find((l) => l.id === 'key')!;
    expect(key.spec).toMatchObject({ azimuthDeg: 50, intensityStops: 0.5, elevationDeg: 45 });
    const kept = lightingRig(doc(p)).find((l) => l.id === 'rim')!;
    expect(kept).toMatchObject({ origin: 'artist', from: 'kept', spec: { name: 'Hair light', azimuthDeg: 160 } });
    expect(p.log.some((e) => e.action === 'lighting.light_kept' && e.detail.includes('rim (Hair light)'))).toBe(true);

    // Unlock: back to the estimate.
    p = ok(lockLightFields(p, SHOT, 'key', ['azimuthDeg'], false, 'ana', NOW));
    expect(lightingRig(doc(p)).find((l) => l.id === 'key')!.spec.azimuthDeg).toBe(30);
    expect(lastLog(p).action === 'lighting.unlocked' || p.log.at(-2)!.action === 'lighting.unlocked').toBe(true);
    // Lock: the current value is kept through the next analysis.
    p = ok(lockLightFields(p, SHOT, 'key', ['elevationDeg'], true, 'ana', NOW));
    p = ok(setLightingSettings(p, SHOT, { subjectDistanceM: 3 }, 'ana', NOW));
    p = ok(recordLightingAnalysis(p, SHOT, analysis(p, [light('key', 'key', 20, 60, 0), light('fill', 'fill', -45, 5, -2.5)]), 'ana', NOW));
    expect(lightingRig(doc(p)).find((l) => l.id === 'key')!.spec).toMatchObject({ azimuthDeg: 20, elevationDeg: 45 });
    expect(lockLightFields(p, SHOT, 'rim', ['azimuthDeg'], true, 'ana', NOW).ok).toBe(false);
  });

  it('adding, removing and restoring lights; the lens override', () => {
    let p = withTask();
    expect(lightingExportProblem(doc(p) ?? null)).toContain('Analyse');
    p = ok(addLight(p, SHOT, { role: 'practical', type: 'point', name: 'Desk lamp', temperatureK: 2700, azimuthDeg: 120, elevationDeg: 5, distanceM: 1.2, intensityStops: -1 }, 'ana', NOW));
    const a = lightingRig(doc(p))[0]!;
    expect(a).toMatchObject({ id: 'a1', origin: 'artist', spec: { name: 'Desk lamp', temperatureK: 2700 } });
    expect(a.spec.rgb[0]).toBe(1);
    expect(a.spec.rgb[2]).toBeLessThan(0.5);
    expect(lightingExportProblem(doc(p))).toBeNull();
    p = ok(recordLightingAnalysis(p, SHOT, analysis(p), 'ana', NOW));
    p = ok(removeLight(p, SHOT, 'rim', 'ana', NOW));
    expect(lightingRig(doc(p)).map((l) => l.id)).toEqual(['key', 'fill', 'a1']);
    expect(setLightFields(p, SHOT, 'rim', { azimuthDeg: 1 }, 'ana', NOW)).toMatchObject({ ok: false, reason: expect.stringContaining('restore it first') });
    p = ok(restoreLight(p, SHOT, 'rim', 'ana', NOW));
    p = ok(removeLight(p, SHOT, 'a1', 'ana', NOW));
    expect(lightingRig(doc(p)).map((l) => l.id)).toEqual(['key', 'fill', 'rim']);
    expect(lightingLens(doc(p))).toMatchObject({ focalMm: 25, focalSource: 'metadata', filmBackSource: 'database' });
    p = ok(setLensOverride(p, SHOT, { focalMm: 27, fStop: 2.8 }, 'ana', NOW));
    expect(lastLog(p).detail === 'focal 27 mm, f/2.8' || p.log.at(-2)!.detail === 'focal 27 mm, f/2.8').toBe(true);
    const lens = lightingLens(doc(p));
    expect(lens).toMatchObject({ focalMm: 27, focalSource: 'artist', fStop: 2.8, fStopSource: 'artist' });
    expect(lens.hfovDeg!).toBeCloseTo((2 * Math.atan(27.99 / 54) * 180) / Math.PI, 6);
  });
});

describe('the AI review', () => {
  it('suggestions are recorded with the model, not applied until accepted, and the decision is logged', () => {
    let p = withTask();
    p = ok(recordLightingAnalysis(p, SHOT, analysis(p), 'ana', NOW));
    const rev = doc(p).editRevision;
    p = ok(
      recordLightingAiReview(
        p,
        SHOT,
        {
          model: 'model-x',
          promptVersion: 'lighting-review/1',
          summary: 'A window motivates the key.',
          credits: 3,
          suggestions: [
            { kind: 'adjust', lightId: 'key', change: { temperatureK: 5200 }, light: null, reason: 'Daylight through the window', confidence: 0.7 },
            { kind: 'add', lightId: null, change: null, light: { role: 'practical', type: 'point', name: 'Lamp', enabled: true, azimuthDeg: 100, elevationDeg: 10, distanceM: 2, intensityStops: -2, sizeDeg: 5, temperatureK: 2800, rgb: kelvinRgb(2800) }, reason: 'A lamp on the shelf', confidence: 0.5 },
            { kind: 'adjust', lightId: 'nope', change: { azimuthDeg: 1 }, light: null, reason: '', confidence: 0.2 },
            { kind: 'adjust', lightId: 'fill', change: { elevationDeg: 200 }, light: null, reason: '', confidence: 0.2 },
          ],
        },
        'ana',
        NOW,
      ),
    );
    const review = doc(p).reviews[0]!;
    expect(review.suggestions.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(lastLog(p).detail).toContain('by model-x (prompt lighting-review/1, 3 credits): 2 suggestions, 2 not applicable and dropped');
    expect(doc(p).editRevision).toBe(rev);
    expect(lightingRig(doc(p)).find((l) => l.id === 'key')!.spec.temperatureK).toBe(4300);
    expect(lightingSummary(doc(p)).pendingSuggestions).toBe(2);
    p = ok(decideLightingSuggestion(p, SHOT, review.id, 's1', 'accepted', 'ana', NOW));
    const key = lightingRig(doc(p)).find((l) => l.id === 'key')!;
    expect(key).toMatchObject({ from: `ai:${review.id}/s1`, spec: { temperatureK: 5200 } });
    expect(p.log.find((e) => e.action === 'lighting.ai_decision')!.detail).toContain('from model-x accepted: key (Key): temperature 4300 K → 5200 K');
    expect(decideLightingSuggestion(p, SHOT, review.id, 's1', 'rejected', 'ana', NOW).ok).toBe(false);
    p = ok(decideLightingSuggestion(p, SHOT, review.id, 's2', 'rejected', 'ana', NOW));
    expect(lightingRig(doc(p)).some((l) => l.spec.name === 'Lamp')).toBe(false);
    expect(lightingSummary(doc(p)).pendingSuggestions).toBe(0);
  });
});

describe('exports, approval and the project format', () => {
  it('approval needs the export of the version; approved is locked; reopening makes v002', () => {
    let p = withTask();
    p = ok(recordLightingAnalysis(p, SHOT, analysis(p), 'ana', NOW));
    expect(approveTask(p, SHOT, 'lighting_analysis', 'M. Delgado', NOW)).toMatchObject({ ok: false, reason: expect.stringContaining('Export the light rig v001 first') });
    expect(recordLightingExport(p, SHOT, { ...exportRecord(p), version: 2 }, 'ana', NOW).ok).toBe(false);
    p = ok(recordLightingExport(p, SHOT, exportRecord(p), 'ana', NOW));
    expect(p.log.find((e) => e.action === 'lighting.exported')!.detail).toContain('3 lights, unreal + json + usd + report, camera from the lens estimate');
    p = ok(approveTask(p, SHOT, 'lighting_analysis', 'M. Delgado', NOW));
    expect(task(p)).toMatchObject({ state: 'approved', approval: { by: 'M. Delgado' } });
    expect(setLightFields(p, SHOT, 'key', { azimuthDeg: 10 }, 'ana', NOW)).toMatchObject({ ok: false, reason: expect.stringContaining('The light rig v001 is approved') });
    expect(addLight(p, SHOT, {}, 'ana', NOW).ok).toBe(false);
    p = ok(setTaskState(p, SHOT, 'lighting_analysis', 'needs_correction', 'ana', NOW));
    expect(task(p).version).toBe(2);
    p = ok(setLightFields(p, SHOT, 'key', { azimuthDeg: 10 }, 'ana', NOW));
    p = ok(recordLightingExport(p, SHOT, exportRecord(p), 'ana', NOW));
    expect(doc(p).exports.map((e) => e.version)).toEqual([1, 2]);
  });

  it('the manifest section and the rig data', () => {
    let p = withTask();
    expect(lightingManifest(shotState(p, SHOT)!)).toBeNull();
    p = ok(recordLightingAnalysis(p, SHOT, analysis(p), 'ana', NOW));
    p = ok(setLightFields(p, SHOT, 'key', { azimuthDeg: 45 }, 'ana', NOW));
    p = ok(recordLightingExport(p, SHOT, exportRecord(p), 'ana', NOW));
    const m = buildManifest(p, SHOT, { generatedAt: NOW, generator: 'test', operator: 'ana', outputRoot: '/out', files: [] } as never) as unknown as { lighting: ReturnType<typeof lightingManifest> };
    expect(m.lighting).toMatchObject({ task: 'lighting_analysis', version: 'v001', exported: true, formats: ['unreal', 'json', 'usd', 'report'], lens: { focalMm: 25, source: 'metadata' } });
    expect(m.lighting!.lights.map((l) => [l.id, l.locked])).toEqual([
      ['key', 1],
      ['fill', 0],
      ['rim', 0],
    ]);
    const data = lightingRigData(p, SHOT, {
      version: 1,
      generator: 'test',
      writtenAt: NOW.toISOString(),
      by: 'ana',
      units: 'm',
      camera: { source: 'estimate', position: [0, 0, 0], rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], focalMm: 25, filmBackMm: { width: 27.99, height: 19.22 }, frame: 3035, width: 4096, height: 2160 },
      subject: [0, 0, -3],
      placements: [{ id: 'key', position: [1, 2, 0], direction: [0, 0, -1] }],
      intensities: { key: { lux: 1000, candela: 9000, unreal: 9000, unrealUnit: 'cd' } },
      files: {},
    });
    expect(data.lights[0]).toMatchObject({ id: 'key', azimuthDeg: 45, locked: ['azimuthDeg'], ranges: { azimuthDeg: R(40, 32, 48) }, scene: { position: [1, 2, 0] }, intensity: { candela: 9000 } });
    expect(data.lights[1]!.scene).toBeNull();
    expect(data.exposure.ev100).toBeCloseTo(Math.log2(400), 9);
  });

  it('is project format 9: projects of formats 3 to 8 open with no lighting, and lighting survives a round trip', () => {
    expect(PROJECT_VERSION).toBe(10);
    const v8 = JSON.parse(serializeProject(sample()));
    v8.version = 8;
    for (const s of v8.shots) delete s.lighting;
    const v7 = JSON.parse(JSON.stringify(v8));
    v7.version = 7;
    for (const s of v7.shots) delete s.comp;
    const v6 = JSON.parse(JSON.stringify(v7));
    v6.version = 6;
    for (const s of v6.shots) delete s.texture;
    const v5 = JSON.parse(JSON.stringify(v6));
    v5.version = 5;
    for (const s of v5.shots) delete s.isolate;
    const v4 = JSON.parse(JSON.stringify(v5));
    v4.version = 4;
    for (const s of v4.shots) delete s.cleanPlate;
    const v3 = JSON.parse(JSON.stringify(v4));
    v3.version = 3;
    for (const s of v3.shots) delete s.key;
    for (const old of [v8, v7, v6, v5, v4, v3]) {
      const opened = parseProject(JSON.stringify(old));
      if (!opened.ok) throw new Error(opened.reason);
      expect(opened.project.version).toBe(10);
      expect(shotState(opened.project, SHOT)!.lighting).toBeNull();
    }
    let p = withTask();
    p = ok(recordLightingAnalysis(p, SHOT, analysis(p), 'ana', NOW));
    p = ok(setLightFields(p, SHOT, 'key', { azimuthDeg: 45 }, 'ana', NOW));
    const again = parseProject(serializeProject(p));
    if (!again.ok) throw new Error(again.reason);
    expect(shotState(again.project, SHOT)!.lighting).toEqual(shotState(p, SHOT)!.lighting);
    const newer = JSON.parse(serializeProject(p));
    newer.version = PROJECT_VERSION + 1;
    expect(parseProject(JSON.stringify(newer)).ok).toBe(false);
  });
});

describe('colour temperature', () => {
  it('the Planckian locus and its inverse round-trip; a white-balanced picture is undone', () => {
    for (const k of [1900, 2700, 3200, 4300, 5600, 6500, 9000, 15000]) {
      const [x, y] = planckianXy(k);
      expect(cctOfXy(x, y).kelvin).toBeCloseTo(k, -1);
      expect(Math.abs(cctOfXy(x, y).duv)).toBeLessThan(1e-4);
      expect(temperatureOf(kelvinRgb(k), null).kelvin).toBeCloseTo(k, -1);
      // In a picture balanced for 5600 K, a 5600 K light is neutral and a 3200 K one is warm; undoing the balance recovers both.
      const seen = balancedRgb(kelvinRgb(k), 5600);
      expect(temperatureOf(seen, 5600).kelvin).toBeCloseTo(k, -1);
    }
    expect(balancedRgb(kelvinRgb(5600), 5600).every((c) => Math.abs(c - 1) < 1e-9)).toBe(true);
    const r = kelvinRange(5600, 20);
    expect(r.low).toBeLessThan(5600);
    expect(r.high).toBeGreaterThan(5600);
    expect(1e6 / r.low - 1e6 / 5600).toBeCloseTo(20, 6);
  });
});
