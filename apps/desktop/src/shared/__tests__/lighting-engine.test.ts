import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SAMPLE_HANDOFF, addTask, createProject, estimateSpec, kelvinRgb, lightingDoc, lightingRig, parseHandoff, recordLightingAnalysis, setLightFields, setLightingSettings, shotState, type LightEstimate, type Project, type Result } from '@vcvfx/domain';
import { analyseLighting, type AnalysisInput } from '../lighting/analyse';
import { angleBetween, azDiff, dirOf, inAzRange, inRange } from '../lighting/geometry';
import { curvatureK1, detectLines, focalFromLines } from '../lighting/lens';
import { chromeBall, hdriSources } from '../lighting/probes';
import { matchScore, relight, relightModel } from '../lighting/relight';
import { fitShading, silhouetteNormals } from '../lighting/shading';
import { STUDIO_SCENE, renderChromeBall, renderEquirect, renderGreyBall, renderLineRoom, renderScene, trueNormals, type SyntheticScene } from '../lighting/synthetic';
import { placeRig, unrealAim, unrealPoint } from '../lighting/place';
import { writeLightingBlender, writeLightingReport, writeLightingUnreal, writeLightingUsda, unrealSection } from '../lighting/exports';
import { unrealAxes, unrealKeys, SCENE_TO_UNREAL, type CameraExportData } from '../camera/export-formats';
import { LIGHTING_REVIEW_TOOL_DEF, reviewRequest, runLightingReview } from '../lighting/ai-review';
import type { ModelClient } from '../ai/protocol';

/**
 * The lighting engine against ground truth (addendum 14 §8): synthetic shots
 * rendered with known lights — a soft key, a fill, a rim, a practical, an
 * ambient — on a grey subject with its matte, standing on a floor it
 * shadows, and the chrome ball, grey ball and HDRI one would shoot there.
 * Each estimate must be near the truth and — the point of ranges — the truth
 * must lie inside the range it reports. The numbers quoted in addendum 14 §7
 * come from these runs (printed).
 */

const LUMA: [number, number, number] = [0.2722, 0.6741, 0.0537];
const SMALL: SyntheticScene = { ...STUDIO_SCENE, width: 320, height: 180, samples: 14 };
const hasPython = spawnSync('python3', ['--version']).status === 0;

function input(scene: SyntheticScene, extra: Partial<AnalysisInput> = {}): AnalysisInput {
  const shot = renderScene(scene);
  return {
    frame: shot.image,
    frameNumber: 1001,
    frames: [1001],
    luma: LUMA,
    gamut: 'ap1',
    subject: { matte: shot.matte, source: 'sample' },
    sky: null,
    camera: { focalMm: scene.focalMm, focalSource: 'metadata', filmBackMm: { width: scene.filmBackMm, height: (scene.filmBackMm * scene.height) / scene.width }, filmBackSource: 'handoff', pitchDeg: scene.pitchDeg, rollDeg: scene.rollDeg, k1: null, k1Source: null, iris: null, focusDistance: null, subjectDistanceM: scene.subject.depthM, subjectDistanceSource: 'sample' },
    ground: { heightM: scene.cameraHeightM, source: 'sample' },
    whiteBalance: scene.whiteBalanceK ? { kelvin: scene.whiteBalanceK, source: 'metadata' } : { kelvin: null, source: 'assumed' },
    references: { chrome: [], grey: [], hdri: null },
    revision: 0,
    ...extra,
  };
}
const truthOf = (scene: SyntheticScene, id: string) => scene.lights.find((l) => l.id === id)!;
const lightOf = (lights: LightEstimate[], id: string) => lights.find((l) => l.id === id)!;
const report = (label: string, l: LightEstimate, t: { az: number; el: number; stops?: number; kelvin?: number }) =>
  console.log(
    `${label}: az ${l.azimuth.value.toFixed(1)} [${l.azimuth.low.toFixed(1)}, ${l.azimuth.high.toFixed(1)}] (truth ${t.az}, err ${azDiff(l.azimuth.value, t.az).toFixed(1)}) · el ${l.elevation.value.toFixed(1)} [${l.elevation.low.toFixed(1)}, ${l.elevation.high.toFixed(1)}] (truth ${t.el}) · stops ${l.intensity.value.toFixed(2)} [${l.intensity.low.toFixed(2)}, ${l.intensity.high.toFixed(2)}]${t.stops !== undefined ? ` (truth ${t.stops})` : ''}${l.temperature ? ` · ${Math.round(l.temperature.value)} K [${Math.round(l.temperature.low)}, ${Math.round(l.temperature.high)}]${t.kelvin ? ` (truth ${t.kelvin})` : ''}` : ''}${l.size ? ` · size ${l.size.value.toFixed(1)}° [${l.size.low.toFixed(1)}, ${l.size.high.toFixed(1)}]` : ''}`,
  );
const covers = (l: LightEstimate, t: { az: number; el: number }) => {
  expect(inAzRange(l.azimuth, t.az), `azimuth ${t.az} in [${l.azimuth.low}, ${l.azimuth.high}]`).toBe(true);
  expect(inRange(l.elevation, t.el), `elevation ${t.el} in [${l.elevation.low}, ${l.elevation.high}]`).toBe(true);
};

describe('silhouette normals', () => {
  it('are a sphere’s own under perspective (median error under 3°)', () => {
    const scene: SyntheticScene = { ...SMALL, samples: 2, noise: 0 };
    const shot = renderScene(scene);
    const field = silhouetteNormals(shot.matte, scene.width, scene.height, 0.5, shot.camera)!;
    const truth = trueNormals(scene);
    const errs: number[] = [];
    for (let i = 0; i < scene.width * scene.height; i += 1) {
      if (!field.mask[i] || Number.isNaN(truth[3 * i]!) || field.cover[i]! < 0.98) continue;
      errs.push(angleBetween([field.normals[3 * i]!, field.normals[3 * i + 1]!, field.normals[3 * i + 2]!], [truth[3 * i]!, truth[3 * i + 1]!, truth[3 * i + 2]!]));
    }
    errs.sort((a, b) => a - b);
    const med = errs[errs.length >> 1]!;
    const p90 = errs[Math.floor(errs.length * 0.9)]!;
    console.log(`silhouette normals: median ${med.toFixed(2)}°, 90th percentile ${p90.toFixed(2)}° over ${errs.length} pixels`);
    expect(med).toBeLessThan(3);
    expect(p90).toBeLessThan(7);
  });
});

describe('the shading alone (a subject matte, no probe)', () => {
  it('finds the key within a few degrees — and its range holds the truth — with the fill, the rim and the ambient in their ranges', async () => {
    const t0 = Date.now();
    const out = await analyseLighting(input(SMALL));
    console.log(`analysis (shading, shadows, practicals, lens) at 320×180: ${Date.now() - t0} ms`);
    const L = out.analysis.lights;
    const key = lightOf(L, 'key');
    report('shading key', key, { ...truthOf(SMALL, 'key'), kelvin: 4300 });
    expect(Math.abs(azDiff(key.azimuth.value, 48))).toBeLessThan(6);
    expect(Math.abs(key.elevation.value - 32)).toBeLessThan(5);
    covers(key, truthOf(SMALL, 'key'));
    expect(key.evidence).toEqual(expect.arrayContaining(['shading', 'contour', 'shadow']));
    expect(key.size!.low).toBeLessThanOrEqual(12.5);
    expect(key.size!.high).toBeGreaterThanOrEqual(12.5);
    expect(key.temperature!.low).toBeLessThanOrEqual(4300);
    expect(key.temperature!.high).toBeGreaterThanOrEqual(4300);
    const fill = lightOf(L, 'fill');
    report('shading fill', fill, { ...truthOf(SMALL, 'fill'), kelvin: 6500 });
    covers(fill, truthOf(SMALL, 'fill'));
    expect(inRange(fill.intensity, -2.2)).toBe(true);
    const rim = lightOf(L, 'rim');
    report('shading rim', rim, truthOf(SMALL, 'rim'));
    covers(rim, truthOf(SMALL, 'rim'));
    expect(inRange(rim.intensity, -0.6)).toBe(true);
    const amb = lightOf(L, 'ambient');
    report('shading ambient', amb, { az: 0, el: 90, stops: -4.5 });
    expect(inRange(amb.intensity, -4.5)).toBe(true);
    // The practical on the wall: found where it is, warm.
    const prac = L.find((l) => l.role === 'practical')!;
    const truthPx = renderScene({ ...SMALL, samples: 1, supersample: 1 }).truth.practicals[0]!;
    expect(Math.abs(prac.practical!.x * SMALL.width - truthPx.x)).toBeLessThan(3);
    expect(Math.abs(prac.practical!.y * SMALL.height - truthPx.y)).toBeLessThan(3);
    expect(inRange(prac.temperature!, 2700)).toBe(true);
    expect(inRange(prac.intensity, -5)).toBe(true);
    console.log(`practical at ${(prac.practical!.x * SMALL.width).toFixed(1)}, ${(prac.practical!.y * SMALL.height).toFixed(1)} px (truth ${truthPx.x.toFixed(1)}, ${truthPx.y.toFixed(1)}); ${Math.round(prac.temperature!.value)} K; ${prac.intensity.value.toFixed(2)} stops [${prac.intensity.low.toFixed(2)}, ${prac.intensity.high.toFixed(2)}] (truth −5)`);
    expect(out.analysis.matchScore!).toBeGreaterThan(0.85);
    expect(out.analysis.keyConfidence).toBeGreaterThan(0.5);
    expect(out.analysis.marks.some((m) => m.kind === 'shadow')).toBe(true);
  });

  it('on a subject that is not a sphere (an ellipsoid), the key’s range still holds the truth', async () => {
    const scene: SyntheticScene = { ...SMALL, subject: { ...SMALL.subject, kind: 'ellipsoid', axes: [0.75, 1.5, 0.8] } };
    const out = await analyseLighting(input(scene));
    const key = lightOf(out.analysis.lights, 'key');
    report('ellipsoid key', key, truthOf(scene, 'key'));
    covers(key, truthOf(scene, 'key'));
    expect(Math.abs(azDiff(key.azimuth.value, 48))).toBeLessThan(15);
  });

  it('a hard key from the other side, a different white balance: still found, colour in range', async () => {
    const scene: SyntheticScene = {
      ...SMALL,
      whiteBalanceK: 3200,
      lights: [
        { id: 'key', role: 'key', az: -60, el: 45, distanceM: 4, radiusM: 0.1, stops: 0, kelvin: 5600 },
        { id: 'fill', role: 'fill', az: 50, el: 5, distanceM: 4, radiusM: 1.2, stops: -3, kelvin: 3200 },
      ],
    };
    const out = await analyseLighting(input(scene));
    const key = lightOf(out.analysis.lights, 'key');
    report('hard key, 3200 K balance', key, { ...truthOf(scene, 'key'), kelvin: 5600 });
    covers(key, truthOf(scene, 'key'));
    expect(inRange(key.temperature!, 5600)).toBe(true);
    expect(key.size!.low).toBeLessThanOrEqual(2.9);
  });
});

describe('probes', () => {
  it('a chrome ball: every source’s direction, size and share of the light', () => {
    const ball = renderChromeBall(SMALL, 200);
    const r = chromeBall(ball.image, ball.circle, LUMA, { pitchDeg: SMALL.pitchDeg, rollDeg: 0 });
    const key = r.sources[0]!;
    const fill = r.sources.find((s) => Math.abs(azDiff(s.az, -42)) < 15)!;
    const rim = r.sources.find((s) => Math.abs(azDiff(s.az, -150)) < 15)!;
    console.log(`chrome ball: key ${key.az.toFixed(1)}/${key.el.toFixed(1)} size ${key.sizeDeg.toFixed(1)}° · fill ${fill.az.toFixed(1)}/${fill.el.toFixed(1)} ${Math.log2(fill.E / key.E).toFixed(2)} stops · rim ${rim.az.toFixed(1)}/${rim.el.toFixed(1)} ${Math.log2(rim.E / key.E).toFixed(2)} stops`);
    expect(angleBetween(dirOf(key.az, key.el), dirOf(48, 32))).toBeLessThan(key.dirHalf + 1);
    expect(angleBetween(dirOf(fill.az, fill.el), dirOf(-42, 12))).toBeLessThan(fill.dirHalf + 3);
    expect(Math.abs(Math.log2(fill.E / key.E) + 2.2)).toBeLessThan(0.5);
    expect(Math.abs(Math.log2(rim.E / key.E) + 0.6)).toBeLessThan(0.5);
    expect(Math.abs(key.sizeDeg - 12.5)).toBeLessThan(4);
  });

  it('an HDRI: sources found with their direction, size and colour; the heading aligned to the plate when not given', () => {
    const pano = renderEquirect(SMALL, 512, 30);
    const r = hdriSources(pano, 30, LUMA);
    const key = r.sources[0]!;
    console.log(`HDRI: key ${key.az.toFixed(2)}/${key.el.toFixed(2)} size ${key.sizeDeg.toFixed(1)}°; ${r.sources.length} sources; dome ${Math.log2(r.dome.E / key.E).toFixed(2)} stops`);
    expect(angleBetween(dirOf(key.az, key.el), dirOf(48, 32))).toBeLessThan(1.5);
    expect(Math.abs(key.sizeDeg - 12.5)).toBeLessThan(2);
    expect(Math.abs(Math.log2(r.dome.E / key.E) + 4.5)).toBeLessThan(0.6);
    expect(r.sources.some((s) => angleBetween(dirOf(s.az, s.el), dirOf(-42, 12)) < 4)).toBe(true);
  });

  it('with references, the rig follows the probes: HDRI (heading given) is exact; a null heading is aligned to the plate', async () => {
    const pano = renderEquirect(SMALL, 512, 30);
    const given = await analyseLighting(input(SMALL, { references: { chrome: [], grey: [], hdri: { id: 'h', image: pano, headingDeg: 30 } } }));
    for (const id of ['key', 'fill', 'rim'] as const) {
      const l = lightOf(given.analysis.lights, id);
      report(`HDRI ${id}`, l, { ...truthOf(SMALL, id), kelvin: truthOf(SMALL, id).kelvin });
      covers(l, truthOf(SMALL, id));
      expect(angleBetween(dirOf(l.azimuth.value, l.elevation.value), dirOf(truthOf(SMALL, id).az, truthOf(SMALL, id).el))).toBeLessThan(2.5);
      expect(inRange(l.intensity, truthOf(SMALL, id).stops)).toBe(true);
      expect(inRange(l.temperature!, truthOf(SMALL, id).kelvin)).toBe(true);
    }
    const amb = lightOf(given.analysis.lights, 'ambient');
    expect(inRange(amb.intensity, -4.5)).toBe(true);
    const aligned = await analyseLighting(input(SMALL, { references: { chrome: [], grey: [], hdri: { id: 'h', image: pano, headingDeg: null } } }));
    const key = lightOf(aligned.analysis.lights, 'key');
    report('HDRI aligned key', key, truthOf(SMALL, 'key'));
    covers(key, truthOf(SMALL, 'key'));
    expect(lightOf(aligned.analysis.lights, 'fill').azimuth.value).toBeCloseTo(lightOf(given.analysis.lights, 'fill').azimuth.value, -1);
  });

  it('a chrome and a grey ball: the key, the fill and the rim measured; the practical placed', async () => {
    const out = await analyseLighting(
      input(SMALL, {
        references: { chrome: [{ id: 'c', ...renderChromeBall(SMALL, 200), inPlate: false }], grey: [{ id: 'g', ...renderGreyBall(SMALL, 200), inPlate: false }], hdri: null },
      }),
    );
    for (const id of ['key', 'fill', 'rim'] as const) {
      const l = lightOf(out.analysis.lights, id);
      report(`balls ${id}`, l, { ...truthOf(SMALL, id), kelvin: truthOf(SMALL, id).kelvin });
      covers(l, truthOf(SMALL, id));
      if (id !== 'key') expect(inRange(l.intensity, truthOf(SMALL, id).stops)).toBe(true);
      expect(inRange(l.temperature!, truthOf(SMALL, id).kelvin)).toBe(true);
    }
    const prac = out.analysis.lights.find((l) => l.role === 'practical')!;
    expect(prac.evidence).toContain('chrome_ball');
    // The truth: the lamp from the subject's centre.
    expect(Math.abs(azDiff(prac.azimuth.value, 147.5))).toBeLessThan(5);
  });
});

describe('the lens', () => {
  it('the focal length from vanishing points, against the known one', () => {
    const cases = [
      { focalPx: 400, yawDeg: 30, pitchDeg: -10 },
      { focalPx: 700, yawDeg: 25, pitchDeg: -5 },
      { focalPx: 300, yawDeg: 35, pitchDeg: 8, k1: -0.15, spacing: 1.5 },
    ];
    for (const c of cases) {
      const img = renderLineRoom({ width: 480, height: 270, ...c });
      const lines = detectLines(img, LUMA);
      const f = focalFromLines(lines, 480, 270);
      console.log(`vanishing points: f ${f.focalPx!.toFixed(1)} px [${f.low.toFixed(1)}, ${f.high.toFixed(1)}] (truth ${c.focalPx}), ${f.vps.length} vanishing points from ${lines.length} lines`);
      expect(Math.abs(f.focalPx! / c.focalPx - 1)).toBeLessThan(0.05);
      expect(f.low).toBeLessThanOrEqual(c.focalPx);
      expect(f.high).toBeGreaterThanOrEqual(c.focalPx);
      if (!c.k1) expect(curvatureK1(lines, 480, 270)?.k1 ?? 0).toBe(0);
    }
  });

  it('the metadata and the camera track come before the picture; the vanishing points check them', async () => {
    const meta = await analyseLighting(input(SMALL));
    expect(meta.analysis.lens).toMatchObject({ focalSource: 'metadata', focalMm: { value: 35 }, filmBackSource: 'handoff' });
    const solve = await analyseLighting(input(SMALL, { camera: { ...input(SMALL).camera, focalMm: 34.2, focalSource: 'solve', iris: 'T2.8' } }));
    expect(solve.analysis.lens).toMatchObject({ focalSource: 'solve', focalMm: { value: 34.2 }, aperture: { source: 'metadata', fStop: { value: 2.8 } } });
    const none = await analyseLighting(input(SMALL, { camera: { ...input(SMALL).camera, focalMm: null, focalSource: null } }));
    expect(none.analysis.lens.focalSource === 'vanishing' || none.analysis.lens.focalSource === 'unknown').toBe(true);
    expect(none.analysis.lens.hfovDeg === null || none.analysis.lens.hfovDeg.low <= none.analysis.lens.hfovDeg.high).toBe(true);
  });
});

describe('the relight and the artist’s edits', () => {
  const ok = (r: Result): Project => {
    if (!r.ok) throw new Error(r.reason);
    return r.project;
  };
  it('the unedited rig gives back the plate on the subject; moving the key changes the match; edits survive a new analysis', async () => {
    const inp = input(SMALL);
    const out = await analyseLighting(inp);
    const model = out.model!;
    const specs = out.analysis.lights.map(estimateSpec);
    const back = relight(model, specs);
    let err = 0;
    let n = 0;
    for (let i = 0; i < model.width * model.height; i += 1) {
      if (!model.mask[i]) continue;
      err += Math.abs(back.data[3 * i + 1]! - inp.frame.data[3 * i + 1]!) / Math.max(1e-3, inp.frame.data[3 * i + 1]!);
      n += 1;
    }
    expect(err / n).toBeLessThan(0.02);
    const m0 = matchScore(model, specs)!;
    const m1 = matchScore(model, specs.map((s) => (s.role === 'key' ? { ...s, azimuthDeg: -60 } : s)))!;
    console.log(`match: estimated rig ${m0.toFixed(3)}, key moved to −60° ${m1.toFixed(3)}`);
    expect(m1).toBeLessThan(m0 - 0.2);
    // Through the domain: an edit, then a new analysis of new settings — the edit stays.
    const h = parseHandoff(JSON.stringify(SAMPLE_HANDOFF));
    if (!h.ok) throw new Error('sample');
    let p = ok(addTask(createProject(h.handoff, 'sample', 'dit', new Date()), '040_010', 'lighting_analysis', 'dit', new Date()));
    p = ok(recordLightingAnalysis(p, '040_010', out.analysis, 'Ana', new Date()));
    p = ok(setLightFields(p, '040_010', 'key', { azimuthDeg: 55, temperatureK: 3800, rgb: kelvinRgb(3800) }, 'Ana', new Date()));
    p = ok(setLightingSettings(p, '040_010', { subjectDistanceM: 3.5 }, 'Ana', new Date()));
    const again = await analyseLighting({ ...inp, revision: lightingDoc(shotState(p, '040_010'))!.revision, camera: { ...inp.camera, subjectDistanceM: 3.5 } });
    p = ok(recordLightingAnalysis(p, '040_010', again.analysis, 'Ana', new Date()));
    const key = lightingRig(lightingDoc(shotState(p, '040_010'))).find((l) => l.id === 'key')!;
    expect(key.spec).toMatchObject({ azimuthDeg: 55, temperatureK: 3800 });
    expect(key.spec.elevationDeg).toBe(again.analysis.lights.find((l) => l.id === 'key')!.elevation.value);
  });
});

describe('exports', () => {
  async function placed() {
    const h = parseHandoff(JSON.stringify(SAMPLE_HANDOFF));
    if (!h.ok) throw new Error('sample');
    let p = addTask(createProject(h.handoff, 'sample', 'dit', new Date()), '040_010', 'lighting_analysis', 'dit', new Date());
    if (!p.ok) throw new Error(p.reason);
    const out = await analyseLighting(input(SMALL));
    const r = recordLightingAnalysis(p.project, '040_010', out.analysis, 'Ana', new Date());
    if (!r.ok) throw new Error(r.reason);
    p = r;
    const doc = lightingDoc(shotState(p.project, '040_010'))!;
    return { doc, project: p.project, out };
  }
  const names = { shot: '040_010', version: 1, generator: 'VC VFX test', writtenAt: '2026-10-22T12:00:00Z', rigFile: '040_010_light_v001_rig.json', hdriFile: null, frameFile: null };

  it('Unreal: the script compiles, carries every light with its unit, and the camera lines up with the camera-track export’s conventions', async () => {
    const { doc } = await placed();
    // A solved camera, pitched and turned, in centimetres.
    const R = [Math.cos(0.4), 0, Math.sin(0.4), 0, 1, 0, -Math.sin(0.4), 0, Math.cos(0.4)];
    const rig = placeRig(doc, { solve: { position: [100, 150, 400], rotation: R, units: 'cm', upAxis: 'y' }, width: 320, height: 180, pitchDeg: 0, rollDeg: 0, subjectCentre: doc.analysis!.subject.centre });
    const py = writeLightingUnreal(rig, names);
    expect(py).toContain('import unreal');
    expect(py).toContain("'RectLight': (unreal.RectLight, unreal.RectLightComponent)");
    expect(py).toContain('unreal.CineCameraActor');
    expect(py).toContain('KEY_LUX = 1000');
    const u = unrealSection(rig, names);
    // The camera: the same location and rotator the camera-track writer gives for that pose.
    const camData = { cameras: [{ frame: 1, position: [100, 150, 400], rotation: R }], units: 'cm' } as unknown as CameraExportData;
    const k = unrealKeys(camData)[0]!;
    expect(u.camera.location_cm).toEqual(k.location);
    expect(u.camera.rotation_pyr[1]).toBeCloseTo(k.rotation.yaw, 6);
    // A light's actor points (+X) from its position at the subject, in Unreal's axes.
    const key = u.lights.find((l) => l.id === 'key')!;
    const placedKey = rig.lights.find((l) => l.id === 'key')!;
    const axes = unrealAxes({ pitch: key.rotation_pyr[0]!, yaw: key.rotation_pyr[1]!, roll: key.rotation_pyr[2]! });
    const want = [SCENE_TO_UNREAL[0]! * placedKey.direction[0] + SCENE_TO_UNREAL[1]! * placedKey.direction[1] + SCENE_TO_UNREAL[2]! * placedKey.direction[2], SCENE_TO_UNREAL[3]! * placedKey.direction[0] + SCENE_TO_UNREAL[4]! * placedKey.direction[1] + SCENE_TO_UNREAL[5]! * placedKey.direction[2], SCENE_TO_UNREAL[6]! * placedKey.direction[0] + SCENE_TO_UNREAL[7]! * placedKey.direction[1] + SCENE_TO_UNREAL[8]! * placedKey.direction[2]];
    expect(angleBetween(axes.fwd, want)).toBeLessThan(0.01);
    expect(unrealAim([0, 0, -1])).toMatchObject({ pitch: expect.closeTo(0, 6), yaw: expect.closeTo(0, 6) });
    expect(key.unit).toBe('cd');
    expect(key.intensity).toBeCloseTo(1000 * placedKey.spec.distanceM! ** 2, 3);
    expect(unrealPoint(placedKey.position!, 'cm')).toEqual(key.location_cm);
    if (hasPython) {
      const dir = mkdtempSync(join(tmpdir(), 'vcvfx-light-py-'));
      for (const [name, text] of [
        ['u.py', py],
        ['b.py', writeLightingBlender(rig, names, 'ap1')],
      ] as const) {
        writeFileSync(join(dir, name), text);
        const r = spawnSync('python3', ['-c', 'import sys, py_compile; py_compile.compile(sys.argv[1], doraise=True)', join(dir, name)]);
        expect(r.status, r.stderr.toString()).toBe(0);
      }
    }
  });

  it('USD: UsdLux lights with the camera, Y- or Z-up as the camera track says; the report draws the cones', async () => {
    const { doc } = await placed();
    const rig = placeRig(doc, { solve: null, width: 320, height: 180, pitchDeg: -6, rollDeg: 0, subjectCentre: doc.analysis!.subject.centre });
    const usd = writeLightingUsda(rig, names);
    expect(usd.split('\n')[0]).toBe('#usda 1.0');
    expect(usd).toContain('upAxis = "Y"');
    expect(usd).toContain('metersPerUnit = 1');
    expect((usd.match(/def (RectLight|SphereLight|DistantLight|DomeLight) "/g) ?? []).length).toBe(rig.lights.length);
    expect(usd).toContain('bool inputs:enableColorTemperature = 1');
    expect(usd).toMatch(/def Camera "camera"[\s\S]*float focalLength = 0\.35\n/);
    // Braces balance (a cheap structural check).
    expect((usd.match(/{/g) ?? []).length).toBe((usd.match(/}/g) ?? []).length);
    const zup = writeLightingUsda({ ...rig, upAxis: 'z' }, names);
    expect(zup).toContain('upAxis = "Z"');
    const html = writeLightingReport({ doc, rig, lights: lightingRig(doc), names, approval: null, state: 'needs_review', frame: { dataUrl: 'data:image/png;base64,AAAA', width: 320, height: 180 }, tilt: { pitchDeg: -6, rollDeg: 0 } });
    expect(html).toContain('<polygon');
    expect(html).toContain('From above');
    expect(html).toContain('not approved yet');
  });
});

describe('the AI review (a stubbed model)', () => {
  it('sends one frame and the estimate with one strict tool, and reads its suggestions back', async () => {
    const h = parseHandoff(JSON.stringify(SAMPLE_HANDOFF));
    if (!h.ok) throw new Error('sample');
    const p0 = addTask(createProject(h.handoff, 'sample', 'dit', new Date()), '040_010', 'lighting_analysis', 'dit', new Date());
    if (!p0.ok) throw new Error(p0.reason);
    const out = await analyseLighting(input(SMALL));
    const r = recordLightingAnalysis(p0.project, '040_010', out.analysis, 'Ana', new Date());
    if (!r.ok) throw new Error(r.reason);
    const doc = lightingDoc(shotState(r.project, '040_010'))!;
    const req = reviewRequest(doc, { mediaType: 'image/jpeg', data: 'AAAA' }, '040_010', 'sess');
    expect(req.tools).toEqual([LIGHTING_REVIEW_TOOL_DEF]);
    expect(JSON.stringify(LIGHTING_REVIEW_TOOL_DEF.input_schema)).toContain('"additionalProperties":false');
    const content = req.messages[0]!.content as { type: string; text?: string }[];
    expect(content.map((c) => c.type)).toEqual(['image', 'text']);
    expect(content[1]!.text).toContain('"id":"key"');
    const model: ModelClient = {
      call: async () => ({
        message: { model: 'stub', content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 't', name: 'suggest_light_changes', input: { summary: 'A lamp on the wall.', suggestions: [{ kind: 'add', light_id: null, reason: 'The lamp', confidence: 0.8, changes: null, new_light: { role: 'practical', type: 'point', name: 'Wall lamp', azimuth_deg: 150, elevation_deg: 18, distance_m: 4.5, intensity_stops: -5, size_deg: 2, temperature_k: 2700 } }, { kind: 'bogus', light_id: 'key', reason: '?', confidence: 9, changes: null, new_light: null }] } }] } as never,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, credits: 1 },
        allowance: null,
      }),
    };
    const review = await runLightingReview(model, req);
    expect(review.model).toBe('stub');
    expect(review.suggestions[0]).toMatchObject({ kind: 'add', light: { role: 'practical', name: 'Wall lamp', temperatureK: 2700 } });
    expect(review.suggestions[1]).toMatchObject({ kind: 'note', confidence: 1 });
  });
});
