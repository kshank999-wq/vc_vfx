import { describe, expect, it } from 'vitest';
import { analyseLighting, type AnalysisInput } from '../lighting/analyse';
import { azDiff, plateCircleToAnalysis } from '../lighting/geometry';
import { STUDIO_SCENE, renderScene, type SyntheticScene } from '../lighting/synthetic';
import type { LinearImage } from '../key/linear';

/**
 * Lighting from a non-square plate (addendum 17). A scene rendered with known
 * lights is stored squeezed 2× (as an anamorphic plate is delivered). The
 * analysis reads the plate de-squeezed (the worker asks ffmpeg for the frame
 * at W × PAR); analysed as stored square pixels, the subject's silhouette and
 * shading are the wrong shape and the key's direction drifts.
 */

const LUMA: [number, number, number] = [0.2722, 0.6741, 0.0537];
const SCENE: SyntheticScene = { ...STUDIO_SCENE, width: 320, height: 180, samples: 14 };
const A = 2;

/** Horizontal box-average: the plate as stored (W / a wide). */
function squeeze(img: { width: number; height: number; data: Float32Array }, channels: number, a: number) {
  const w = Math.round(img.width / a);
  const out = new Float32Array(w * img.height * channels);
  for (let y = 0; y < img.height; y += 1)
    for (let x = 0; x < w; x += 1)
      for (let c = 0; c < channels; c += 1) {
        let s = 0;
        for (let k = 0; k < a; k += 1) s += img.data[(y * img.width + x * a + k) * channels + c]!;
        out[(y * w + x) * channels + c] = s / a;
      }
  return { width: w, height: img.height, data: out };
}

/** Linear resample to a width (what ffmpeg's scale does for the analysis). */
function stretch(img: { width: number; height: number; data: Float32Array }, channels: number, width: number) {
  const out = new Float32Array(width * img.height * channels);
  for (let y = 0; y < img.height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const u = Math.max(0, Math.min(img.width - 1, ((x + 0.5) * img.width) / width - 0.5));
      const x0 = Math.floor(u);
      const x1 = Math.min(img.width - 1, x0 + 1);
      const t = u - x0;
      for (let c = 0; c < channels; c += 1) out[(y * width + x) * channels + c] = img.data[(y * img.width + x0) * channels + c]! * (1 - t) + img.data[(y * img.width + x1) * channels + c]! * t;
    }
  return { width, height: img.height, data: out };
}

function inputOf(frame: LinearImage, matte: Float32Array, filmBackWidth: number): AnalysisInput {
  const s = SCENE;
  return {
    frame,
    frameNumber: 1001,
    frames: [1001],
    luma: LUMA,
    gamut: 'ap1',
    subject: { matte, source: 'sample' },
    sky: null,
    camera: { focalMm: s.focalMm, focalSource: 'metadata', filmBackMm: { width: filmBackWidth, height: (filmBackWidth * frame.height) / frame.width }, filmBackSource: 'handoff', pitchDeg: s.pitchDeg, rollDeg: s.rollDeg, k1: null, k1Source: null, iris: null, focusDistance: null, subjectDistanceM: s.subject.depthM, subjectDistanceSource: 'sample' },
    ground: { heightM: s.cameraHeightM, source: 'sample' },
    whiteBalance: { kelvin: null, source: 'assumed' },
    references: { chrome: [], grey: [], hdri: null },
    revision: 0,
  };
}

describe('lighting from a 2× squeezed plate', () => {
  it('reads the frame de-squeezed: the key is where the truth says, and not when the plate is taken as square', async () => {
    const shot = renderScene(SCENE);
    const plate = squeeze(shot.image, 3, A);
    const matte = squeeze({ width: SCENE.width, height: SCENE.height, data: shot.matte }, 1, A);
    // As the app now reads it: de-squeezed to the analysis size, on the de-squeezed picture's film back.
    const desq = stretch(plate, 3, plate.width * A);
    const desqMatte = stretch(matte, 1, matte.width * A).data;
    const right = await analyseLighting(inputOf(desq, desqMatte, SCENE.filmBackMm));
    // As before: the stored pixels taken for square ones (the same lens on the same film back).
    const wrong = await analyseLighting(inputOf(plate, matte.data, SCENE.filmBackMm));
    const key = (o: typeof right) => o.analysis.lights.find((l) => l.id === 'key')!;
    const truth = SCENE.lights.find((l) => l.id === 'key')!;
    const errR = Math.hypot(azDiff(key(right).azimuth.value, truth.az), key(right).elevation.value - truth.el);
    const errW = Math.hypot(azDiff(key(wrong).azimuth.value, truth.az), key(wrong).elevation.value - truth.el);
    console.log(`key from a 2× plate: de-squeezed az ${key(right).azimuth.value.toFixed(1)} el ${key(right).elevation.value.toFixed(1)} (error ${errR.toFixed(1)}°); as square pixels az ${key(wrong).azimuth.value.toFixed(1)} el ${key(wrong).elevation.value.toFixed(1)} (error ${errW.toFixed(1)}°); truth az ${truth.az} el ${truth.el}`);
    expect(errR).toBeLessThan(8);
    expect(errW).toBeGreaterThan(errR);
  }, 60_000);

  it('maps a ball circle marked on the stored plate to the de-squeezed analysis frame', () => {
    // A ball 40 px tall at (100, 90) on a 160 × 180 plate at 2: 20 stored px wide.
    expect(plateCircleToAnalysis({ cx: 100, cy: 90, r: 20 }, { width: 160, height: 180 }, { width: 320, height: 180 })).toEqual({ cx: 200, cy: 90, r: 20 });
    expect(plateCircleToAnalysis({ cx: 100, cy: 90, r: 20 }, { width: 1280, height: 1080 }, { width: 960, height: 540 })).toEqual({ cx: 75, cy: 45, r: 10 });
  });
});
