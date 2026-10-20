import { describe, expect, it } from 'vitest';
import { runRoto } from '../roto/engine';
import { iou, type Mask } from '../roto/image';
import {
  SAM2_INPUT,
  SAM2_LOWRES,
  SAM2_MEAN,
  SAM2_STD,
  Sam2Engine,
  fromModelCoords,
  logitsToMask,
  maskToLogits,
  pickBest,
  promptFromMask,
  promptFromStrokes,
  sam2Confidence,
  sam2Preprocess,
  toModelCoords,
  upsampleLogits,
  type Sam2Embedding,
  type Sam2Prompt,
  type Sam2Runtime,
} from '../roto/sam2';
import { discScene } from '../roto/synthetic';

describe('SAM 2 pre-processing', () => {
  it('resizes to 1024² and normalises with ImageNet mean/std, planar RGB', () => {
    const w = 64;
    const h = 32;
    const data = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i += 1) {
      data[3 * i] = 255;
      data[3 * i + 1] = 128;
      data[3 * i + 2] = 0;
    }
    const t = sam2Preprocess({ width: w, height: h, data });
    expect(t.length).toBe(3 * SAM2_INPUT * SAM2_INPUT);
    const plane = SAM2_INPUT * SAM2_INPUT;
    expect(t[0]).toBeCloseTo((1 - SAM2_MEAN[0]) / SAM2_STD[0], 5);
    expect(t[plane + 5000]).toBeCloseTo((128 / 255 - SAM2_MEAN[1]) / SAM2_STD[1], 5);
    expect(t[2 * plane + plane - 1]).toBeCloseTo((0 - SAM2_MEAN[2]) / SAM2_STD[2], 5);
  });

  it('resizes without keeping aspect, bilinear at pixel centres', () => {
    // A left/right split image: the boundary lands in the middle of the 1024 columns.
    const w = 8;
    const h = 2;
    const data = new Uint8Array(w * h * 3);
    for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) data[(y * w + x) * 3] = x < 4 ? 0 : 255;
    const t = sam2Preprocess({ width: w, height: h, data });
    const red = (x: number, y: number) => t[y * SAM2_INPUT + x]! * SAM2_STD[0] + SAM2_MEAN[0];
    expect(red(0, 0)).toBeCloseTo(0, 5);
    expect(red(1023, 1023)).toBeCloseTo(1, 5);
    expect(red(511, 300)).toBeLessThan(0.5);
    expect(red(512, 300)).toBeGreaterThan(0.5);
    expect(red(511, 300) + red(512, 300)).toBeCloseTo(1, 5);
  });

  it('maps points into the model’s 1024² input and back, x and y scaled apart', () => {
    const c = toModelCoords(
      [
        [0, 0],
        [1920, 1080],
        [960, 270],
      ],
      1920,
      1080,
    );
    expect([...c]).toEqual([0, 0, 1024, 1024, 512, 256]);
    expect(fromModelCoords(c, 1920, 1080)).toEqual([
      [0, 0],
      [1920, 1080],
      [960, 270],
    ]);
  });

  it('samples prompts from strokes: include positive, exclude negative', () => {
    const p = promptFromStrokes(
      [
        { mode: 'include', radius: 4, points: [[100, 100], [300, 100]] },
        { mode: 'exclude', radius: 4, points: [[10, 10], [10, 300]] },
      ],
      400,
      400,
      { positives: 3, negatives: 2 },
    );
    expect([...p.labels]).toEqual([1, 1, 1, 0, 0]);
    expect(p.maskInput).toBeNull();
    const pts = fromModelCoords(p.coords, 400, 400);
    for (const [x, y] of pts.slice(0, 3)) {
      expect(y).toBeCloseTo(100, 5);
      expect(x).toBeGreaterThanOrEqual(100);
      expect(x).toBeLessThanOrEqual(300);
    }
  });

  it('prompts from a previous matte: deepest interior points, box corners labelled 2 and 3, previous logits', () => {
    const scene = discScene();
    const mask: Mask = { width: 320, height: 240, data: Uint8Array.from(scene.truth(0), (v) => v * 255) };
    const p = promptFromMask(mask, null, { interior: 2 })!;
    expect([...p.labels]).toEqual([1, 1, 2, 3]);
    const pts = fromModelCoords(p.coords, 320, 240);
    // The first point is the disc's centre.
    expect(Math.hypot(pts[0]![0] - 80, pts[0]![1] - 108)).toBeLessThan(2);
    // Box: the disc's bounds.
    expect(pts[2]![0]).toBeCloseTo(80 - 36, -0.5);
    expect(pts[3]![1]).toBeCloseTo(108 + 36, -0.5);
    expect(p.maskInput!.length).toBe(SAM2_LOWRES * SAM2_LOWRES);
    expect(promptFromMask({ width: 4, height: 4, data: new Uint8Array(16) }, null)).toBeNull();
  });
});

describe('SAM 2 post-processing', () => {
  it('upsamples 256² logits to the image and thresholds at 0 (sigmoid)', () => {
    const logits = new Float32Array(SAM2_LOWRES * SAM2_LOWRES).fill(-20);
    // Right half positive.
    for (let y = 0; y < SAM2_LOWRES; y += 1) for (let x = 128; x < SAM2_LOWRES; x += 1) logits[y * SAM2_LOWRES + x] = 20;
    const up = upsampleLogits(logits, 1920, 1080);
    const m = logitsToMask(up, 1920, 1080);
    expect(m.data[500 * 1920 + 100]).toBe(0);
    expect(m.data[500 * 1920 + 1800]).toBe(255);
    // The 0-crossing sits at the middle column.
    expect(m.data[500 * 1920 + 959]! < 128 && m.data[500 * 1920 + 960]! >= 128).toBe(true);
    expect(logitsToMask(Float32Array.from([0]), 1, 1).data[0]).toBe(128);
  });

  it('round-trips a matte through mask logits', () => {
    const scene = discScene();
    const mask: Mask = { width: 320, height: 240, data: Uint8Array.from(scene.truth(0), (v) => v * 255) };
    const back = logitsToMask(upsampleLogits(maskToLogits(mask), 320, 240), 320, 240);
    expect(iou(back, mask)).toBeGreaterThan(0.97);
  });

  it('picks the mask with the best predicted IoU and blends confidence with the temporal IoU', () => {
    expect(pickBest(Float32Array.from([0.2, 0.9, 0.5]))).toBe(1);
    expect(sam2Confidence(0.9, null)).toBeCloseTo(0.9);
    expect(sam2Confidence(0.9, 0.5)).toBeCloseTo(0.74);
    expect(sam2Confidence(1.3, 2)).toBe(1);
  });
});

/**
 * A stand-in runtime with the real tensors' shapes: the "encoder" keeps the
 * normalised red channel at 256² as its embedding and the "decoder" marks
 * as foreground what is nearly as red as the first positive point. Enough to prove
 * the engine's plumbing end to end without the model.
 */
class FakeRuntime implements Sam2Runtime {
  prompts: Sam2Prompt[] = [];
  async encode(pixels: Float32Array): Promise<Sam2Embedding> {
    expect(pixels.length).toBe(3 * 1024 * 1024);
    const red = new Float32Array(256 * 256);
    for (let y = 0; y < 256; y += 1) for (let x = 0; x < 256; x += 1) red[y * 256 + x] = pixels[(y * 4 + 2) * 1024 + x * 4 + 2]!;
    return { imageEmbed: red, highRes0: new Float32Array(32 * 256 * 256), highRes1: new Float32Array(64 * 128 * 128) };
  }
  async decode(e: Sam2Embedding, prompt: Sam2Prompt) {
    this.prompts.push(prompt);
    const k = [...prompt.labels].indexOf(1);
    const px = Math.min(255, Math.max(0, Math.floor(prompt.coords[2 * k]! / 4)));
    const py = Math.min(255, Math.max(0, Math.floor(prompt.coords[2 * k + 1]! / 4)));
    const target = e.imageEmbed[py * 256 + px]!;
    const masks = new Float32Array(3 * 256 * 256).fill(-10);
    // Red above 160 / 255 counts, when the prompt is that red.
    const floor = Math.min(target, (160 / 255 - SAM2_MEAN[0]) / SAM2_STD[0]);
    for (let i = 0; i < 256 * 256; i += 1) masks[256 * 256 + i] = e.imageEmbed[i]! >= floor ? 10 : -10;
    return { masks, ious: Float32Array.from([0.3, 0.92, 0.5]), count: 3 };
  }
}

describe('SAM 2 engine (stand-in runtime)', () => {
  it('segments the key frame from stroke prompts and propagates by prompting from the previous matte', async () => {
    const scene = discScene({ frames: 8 });
    const runtime = new FakeRuntime();
    const masks = new Map<number, Mask>();
    const confidence = new Map<number, number>();
    await runRoto(
      new Sam2Engine(runtime),
      {
        partId: 'subject',
        from: 0,
        directions: ['key', 'forward'],
        first: 0,
        last: 7,
        keyFrames: [{ frame: 0, strokes: [{ id: 's', mode: 'include', radius: 5, points: [[75, 108], [85, 108]], by: '', at: '' }] }],
        scale: 1,
        smoothing: 0,
        settings: {},
      },
      { frame: async (f) => scene.render(f), getMask: async (f) => masks.get(f) ?? null, putMask: async (f, m, c) => void (masks.set(f, m), confidence.set(f, c)) },
    );
    for (let f = 0; f < 8; f += 1) expect(iou(masks.get(f)!, scene.truth(f))).toBeGreaterThan(0.85);
    expect(confidence.get(0)).toBeCloseTo(0.92, 5);
    expect(confidence.get(3)!).toBeGreaterThan(0.85);
    // Propagation prompts carry the previous low-resolution logits and the box.
    expect(runtime.prompts[1]!.maskInput).not.toBeNull();
    expect([...runtime.prompts[1]!.labels].slice(-2)).toEqual([2, 3]);
  });
});
