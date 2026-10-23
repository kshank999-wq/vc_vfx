import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runRoto } from '../../shared/roto/engine';
import { binarize, iou, type Mask } from '../../shared/roto/image';
import { Sam2Engine } from '../../shared/roto/sam2';
import { figureScene } from '../../shared/roto/synthetic';
import { SAM2_MODEL, sha256OfFile } from '../roto/models';
import { loadOrt, ortCandidates, OrtSam2Runtime } from '../roto/sam2-ort';

/**
 * SAM 2.1 on its real, pinned weights (addendum 18). Runs only when the model
 * files are on disk — set VCVFX_SAM2_DIR to a folder holding
 * sam2.1_hiera_tiny.encoder.onnx / .decoder.onnx (as downloaded by the app) —
 * and onnxruntime-node has been fetched; skipped otherwise, since neither is in
 * the repository.
 */

const dir = process.env['VCVFX_SAM2_DIR'] ?? '';
const enc = join(dir, SAM2_MODEL.files[0]!.name);
const dec = join(dir, SAM2_MODEL.files[1]!.name);
const ort = loadOrt(ortCandidates({ resourcesPath: '', appPath: resolve(__dirname, '../../..'), packaged: false }));
const present = Boolean(dir) && existsSync(enc) && existsSync(dec) && ort.ok;

describe.skipIf(!present)('SAM 2.1 Tiny on its real weights', () => {
  it('the files on disk are the pinned ones', async () => {
    expect(await sha256OfFile(enc)).toBe(SAM2_MODEL.files[0]!.sha256);
    expect(await sha256OfFile(dec)).toBe(SAM2_MODEL.files[1]!.sha256);
  });

  it('segments the walking figure from a box and follows it frame by frame', async () => {
    if (!ort.ok) throw new Error(ort.reason);
    const scene = figureScene({ frames: 12 });
    const { width: w, height: h } = scene;
    const truth0 = scene.truth(0);
    let x0 = w, y0 = h, x1 = 0, y1 = 0;
    for (let i = 0; i < truth0.length; i += 1)
      if (truth0[i]) {
        const x = i % w;
        const y = (i - x) / w;
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
    const engine = new Sam2Engine(await OrtSam2Runtime.create(ort.ort, enc, dec), SAM2_MODEL.id);
    const key = await engine.key({ frame: 0, image: scene.render(0), strokes: [], reference: null, settings: {}, prompt: { box: { x0: x0 - 4, y0: y0 - 4, x1: x1 + 4, y1: y1 + 4 } } });
    expect(iou(binarize(key.mask), truth0)).toBeGreaterThan(0.85);
    expect(key.confidence).toBeGreaterThan(0.6);
    const masks = new Map<number, Mask>([[0, key.mask]]);
    await runRoto(
      engine,
      { partId: 'subject', from: 0, directions: ['forward'], first: 0, last: 11, keyFrames: [{ frame: 0, strokes: [] }], scale: 1, smoothing: 0, settings: {} },
      { frame: async (f) => scene.render(f), getMask: async (f) => masks.get(f) ?? null, putMask: async (f, m) => void masks.set(f, m) },
    );
    for (const f of [4, 8, 11]) expect(iou(binarize(masks.get(f)!), scene.truth(f))).toBeGreaterThan(0.8);
    engine.dispose();
  }, 120_000);
});
