import { describe, expect, it } from 'vitest';
import { DEFAULT_REFINE, newRotoDocument, nextProblemFrame, reviewFrames, type RotoPropagationResult } from '@vcvfx/domain';
import { CancelledError, runRoto, type RotoRunIO } from '../roto/engine';
import { buildPyramid, estimateFlow, estimateObjectMotion, fitAffine, maskedTranslation } from '../roto/flow';
import { binarize, gaussianBlur, iou, maskArea, rng, sampleBilinear, signedDistance, squaredDistance, toGray, type Mask, type RGBImage } from '../roto/image';
import { refineMatte, upscaleMatte } from '../roto/refine';
import { rasterizeStrokes, samplePoints, SEED_EXCLUDE, SEED_INCLUDE } from '../roto/strokes';
import { discScene, figureScene, type SyntheticScene } from '../roto/synthetic';
import { TrackEngine } from '../roto/track';

const ioFor = (scene: SyntheticScene, masks = new Map<number, Mask>(), confidence = new Map<number, number>()): RotoRunIO => ({
  frame: async (f) => scene.render(f),
  getMask: async (f) => masks.get(f) ?? null,
  putMask: async (f, m, c) => {
    masks.set(f, m);
    confidence.set(f, c);
  },
});

/** A textured test image (blurred random noise, not periodic), shifted by (dx, dy). */
const FIELD = (() => {
  const rand = rng(9);
  const W = 240;
  const H = 200;
  const raw = new Float32Array(W * H).map(() => rand());
  return { W, H, data: gaussianBlur(raw, W, H, 2.2) };
})();
function texture(w: number, h: number, dx: number, dy: number): Float32Array {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) out[y * w + x] = 4 * (sampleBilinear(FIELD.data, FIELD.W, FIELD.H, x - dx + 30, y - dy + 30) - 0.5) + 0.5;
  return out;
}

const discStrokes = (cx: number, cy: number) => [
  { id: 's1', mode: 'include' as const, radius: 6, points: [[cx - 10, cy - 2], [cx + 10, cy]] as [number, number][], by: 't', at: '' },
  { id: 's2', mode: 'exclude' as const, radius: 6, points: [[10, 20], [300, 30], [300, 220]] as [number, number][], by: 't', at: '' },
];

describe('optical flow', () => {
  it('recovers known sub-pixel translations with pyramidal Lucas–Kanade', () => {
    const w = 160;
    const h = 120;
    for (const [dx, dy] of [
      [0, 0],
      [2.5, -1.25],
      [-7.3, 4.6],
      [14, 9],
    ] as const) {
      // later = earlier moved by (dx, dy): the backward flow is (−dx, −dy).
      const flow = estimateFlow(texture(w, h, dx, dy), texture(w, h, 0, 0), w, h, { x0: 30, y0: 30, x1: 130, y1: 90 }, { step: 10, levels: 4 });
      expect(flow.median.u).toBeCloseTo(-dx, 1);
      expect(flow.median.v).toBeCloseTo(-dy, 1);
      expect(flow.consistency).toBeGreaterThan(0.6);
      expect(Math.abs(flow.u[60 * w + 80]! + dx)).toBeLessThan(0.15);
    }
  });

  it('fits an affine robustly through outliers', () => {
    const rand = rng(1);
    const n = 60;
    const src = new Float32Array(2 * n);
    const dst = new Float32Array(2 * n);
    const A = [1.05, 0.02, 3, -0.03, 0.98, -2];
    for (let i = 0; i < n; i += 1) {
      const x = rand() * 100;
      const y = rand() * 100;
      src[2 * i] = x;
      src[2 * i + 1] = y;
      const outlier = i % 7 === 0;
      dst[2 * i] = A[0]! * x + A[1]! * y + A[2]! + (outlier ? 25 : 0);
      dst[2 * i + 1] = A[3]! * x + A[4]! * y + A[5]! + (outlier ? -30 : 0);
    }
    const fit = fitAffine(src, dst, n);
    fit.a.forEach((v, i) => expect(v).toBeCloseTo(A[i]!, 3));
  });

  it('finds a flat-coloured subject’s shift by masked block matching, and its motion ignores the background', () => {
    const scene = discScene({ speed: [5, -2] });
    const a = buildPyramid(toGray(scene.render(3)), scene.width, scene.height, 4);
    const b = buildPyramid(toGray(scene.render(4)), scene.width, scene.height, 4);
    const t = maskedTranslation(a, b, scene.truth(3), 24);
    expect(t.dx).toBeCloseTo(5, 0);
    expect(t.dy).toBeCloseTo(-2, 0);
    const m = estimateObjectMotion(a, b, scene.truth(3), { step: 4 });
    const [fx, fy] = m.forward(scene.width * 0.25 + 15, scene.height * 0.45 - 6);
    expect(Math.hypot(fx - 5, fy + 2)).toBeLessThan(0.6);
    const [bx, by] = m.backward(scene.width * 0.25 + 20, scene.height * 0.45 - 8);
    expect(Math.hypot(bx + 5, by - 2)).toBeLessThan(0.6);
  });
});

describe('image primitives', () => {
  it('computes exact Euclidean distance transforms', () => {
    const w = 9;
    const h = 7;
    const on = new Uint8Array(w * h);
    on[3 * w + 4] = 1;
    const d = squaredDistance(on, w, h);
    expect(d[3 * w + 4]).toBe(0);
    expect(d[0]).toBe(16 + 9);
    expect(d[6 * w + 8]).toBe(16 + 9);
    // Cropped and full signed distances agree inside the limit.
    const disc = discScene().truth(0);
    const full = signedDistance(disc, 320, 240);
    const cropped = signedDistance(disc, 320, 240, 10);
    for (let i = 0; i < disc.length; i += 1) if (Math.abs(full[i]!) <= 10) expect(cropped[i]).toBeCloseTo(full[i]!, 5);
  });

  it('rasterises strokes as capsules, later strokes painting over earlier ones', () => {
    const seeds = rasterizeStrokes(
      [
        { mode: 'include', radius: 3, points: [[5, 5], [25, 5]] },
        { mode: 'exclude', radius: 2, points: [[15, 0], [15, 10]] },
      ],
      30,
      12,
    );
    expect(seeds[5 * 30 + 6]).toBe(SEED_INCLUDE);
    expect(seeds[5 * 30 + 15]).toBe(SEED_EXCLUDE);
    expect(seeds[11 * 30 + 6]).toBe(0);
    const pts = samplePoints([{ mode: 'include', radius: 2, points: [[0, 0], [100, 0]] }], 'include', 3);
    expect(pts).toHaveLength(3);
    expect(Math.max(...pts.map((p) => p[0])) - Math.min(...pts.map((p) => p[0]))).toBeGreaterThan(80);
  });
});

describe('Track engine', () => {
  it('propagates a moving disc from one painted key frame with IoU ≥ 0.9 on every frame', async () => {
    const scene = discScene({ width: 320, height: 240, frames: 24 });
    const masks = new Map<number, Mask>();
    const conf = new Map<number, number>();
    const keyFrames = [{ frame: 0, strokes: discStrokes(80, 108) }];
    const results = await runRoto(new TrackEngine(), { partId: 'subject', from: 0, directions: ['key', 'forward'], first: 0, last: 23, keyFrames, scale: 1, smoothing: 0, settings: {} }, ioFor(scene, masks, conf));
    expect(results.map((r) => [r.direction, r.frames.length])).toEqual([
      ['key', 1],
      ['forward', 23],
    ]);
    for (let f = 0; f < 24; f += 1) expect(iou(masks.get(f)!, scene.truth(f))).toBeGreaterThanOrEqual(0.9);
    // Good frames read as confident.
    for (const [f, c] of conf) if (f > 0) expect(c).toBeGreaterThan(0.8);
  });

  it('propagates backward too, from a key frame in the middle', async () => {
    const scene = discScene({ frames: 16 });
    const masks = new Map<number, Mask>();
    const cx = scene.width * 0.25 + 4 * 8;
    const cy = scene.height * 0.45 + 1.5 * 8;
    await runRoto(new TrackEngine(), { partId: 'subject', from: 8, directions: ['key', 'forward', 'backward'], first: 0, last: 15, keyFrames: [{ frame: 8, strokes: discStrokes(cx, cy) }], scale: 1, smoothing: 0.3, settings: {} }, ioFor(scene, masks));
    for (let f = 0; f < 16; f += 1) expect(iou(masks.get(f)!, scene.truth(f))).toBeGreaterThanOrEqual(0.9);
  });

  it('flags an injected failure as the lowest-confidence frame, and a correction key frame there fixes it locally', async () => {
    const scene = discScene({ frames: 24, teleportAt: 14 });
    const masks = new Map<number, Mask>();
    const conf = new Map<number, number>();
    const io = ioFor(scene, masks, conf);
    const first = await runRoto(new TrackEngine(), { partId: 'subject', from: 0, directions: ['key', 'forward'], first: 0, last: 23, keyFrames: [{ frame: 0, strokes: discStrokes(80, 108) }], scale: 1, smoothing: 0, settings: {} }, io);
    expect(iou(masks.get(13)!, scene.truth(13))).toBeGreaterThan(0.9);
    expect(iou(masks.get(14)!, scene.truth(14))).toBeLessThan(0.5);
    // The review surfaces the failure first.
    const doc = newRotoDocument();
    const part = doc.parts[0]!;
    part.keyFrames = [{ frame: 0, strokes: [], correction: false, by: 't', at: '' }];
    const record = (results: RotoPropagationResult[]) => {
      for (const r of results) for (const f of r.frames) {
        part.frames = [...part.frames.filter((x) => x.frame !== f.frame), { frame: f.frame, status: r.direction === 'key' ? ('key' as const) : ('propagated' as const), confidence: f.confidence, engine: 'track', from: r.from, reviewed: null, note: '' }].sort((a, b) => a.frame - b.frame);
      }
    };
    record(first);
    const review = reviewFrames(doc, null, 0, 23);
    // Every frame from the failure on is a problem; "next problem" from the start lands on the first of them.
    expect(review.problems.map((p) => p.frame).sort((a, b) => a - b)).toEqual([14, 15, 16, 17, 18, 19, 20, 21, 22, 23]);
    expect(nextProblemFrame(review, 0)).toBe(14);
    for (let f = 1; f < 14; f += 1) expect(conf.get(f)!).toBeGreaterThan(conf.get(14)! + 0.4);

    // Paint the disc where it now is, on frame 14, and re-propagate from there only.
    const cx = scene.width * 0.25 + 4 * 14 + scene.width * 0.38;
    const cy = scene.height * 0.45 + 1.5 * 14 - scene.height * 0.05;
    const keys = [
      { frame: 0, strokes: discStrokes(80, 108) },
      { frame: 14, strokes: [{ ...discStrokes(cx, cy)[0]!, id: 's3' }, { id: 's4', mode: 'exclude' as const, radius: 6, points: [[20, 200], [60, 230]] as [number, number][], by: 't', at: '' }] },
    ];
    const before = new Map(masks);
    const rivals = Object.fromEntries([...conf.entries()].filter(([f]) => f !== 0 && f !== 14));
    const fix = await runRoto(new TrackEngine(), { partId: 'subject', from: 14, directions: ['key', 'forward', 'backward'], first: 0, last: 23, keyFrames: keys, scale: 1, smoothing: 0, settings: {}, rivals }, io);
    // Forward it replaces every failed frame; backward it cannot follow the jump, so it stops at once and the good frames from key 0 stay.
    expect(fix.find((r) => r.direction === 'forward')!.frames.map((f) => f.frame)).toEqual([15, 16, 17, 18, 19, 20, 21, 22, 23]);
    expect(fix.find((r) => r.direction === 'backward')).toBeUndefined();
    for (let f = 1; f < 14; f += 1) expect(masks.get(f)).toBe(before.get(f));
    for (let f = 0; f < 24; f += 1) expect(iou(masks.get(f)!, scene.truth(f))).toBeGreaterThanOrEqual(0.9);
  });

  it('segments one component part of a figure (the arm) from its own strokes and tracks it', async () => {
    const scene = figureScene({ width: 480, height: 254, frames: 40 });
    const start = 6; // the arm swung clear of the torso
    const truth = scene.truth(start, 'arm');
    // Paint along the arm, out on the torso beside it and on the wall beyond the hand.
    const on: [number, number][] = [];
    for (let i = 0; i < truth.length; i += 1) if (truth[i]) on.push([i % scene.width, Math.floor(i / scene.width)]);
    const top = on.reduce((a, p) => (p[1] < a[1] ? p : a));
    const bottom = on.reduce((a, p) => (p[1] > a[1] ? p : a));
    const torso = scene.truth(start, 'torso');
    let tx = 0, ty = 0, tn = 0;
    for (let i = 0; i < torso.length; i += 1) if (torso[i]) {
      tx += i % scene.width;
      ty += Math.floor(i / scene.width);
      tn += 1;
    }
    const lerp = (t: number): [number, number] => [top[0] + (bottom[0] - top[0]) * t, top[1] + (bottom[1] - top[1]) * t];
    const strokes = [
      { id: 'a', mode: 'include' as const, radius: 2, points: [lerp(0.25), lerp(0.85)], by: 't', at: '' },
      { id: 'b', mode: 'exclude' as const, radius: 3, points: [[tx / tn - 14, ty / tn - 20], [tx / tn - 14, ty / tn + 30]] as [number, number][], by: 't', at: '' },
      { id: 'c', mode: 'exclude' as const, radius: 3, points: [[bottom[0] + 25, top[1]], [bottom[0] + 25, bottom[1] + 15]] as [number, number][], by: 't', at: '' },
    ];
    const masks = new Map<number, Mask>();
    await runRoto(new TrackEngine(), { partId: 'arm', from: start, directions: ['key', 'forward'], first: 0, last: start + 4, keyFrames: [{ frame: start, strokes }], scale: 1, smoothing: 0, settings: {} }, ioFor(scene, masks));
    for (let f = start; f <= start + 4; f += 1) expect(iou(masks.get(f)!, scene.truth(f, 'arm'))).toBeGreaterThanOrEqual(0.75);
  });

  it('edits the matte a frame already has when a correction is painted: far parts kept, a missing limb added', async () => {
    const scene = figureScene({ width: 480, height: 254, frames: 40 });
    const f = 20;
    const truth = scene.truth(f);
    const arm = scene.truth(f, 'arm');
    // The matte propagation left: the whole figure but the arm.
    const withoutArm: Mask = { width: 480, height: 254, data: Uint8Array.from(truth, (v, i) => (v && !arm[i] ? 255 : 0)) };
    expect(iou(withoutArm, truth)).toBeLessThan(0.93);
    const on: [number, number][] = [];
    for (let i = 0; i < arm.length; i += 1) if (arm[i]) on.push([i % 480, Math.floor(i / 480)]);
    const far = on.reduce((a, p) => (Math.abs(p[0] - 240) > Math.abs(a[0] - 240) ? p : a));
    const near = on.reduce((a, p) => (Math.hypot(p[0] - far[0], p[1] - far[1]) > Math.hypot(a[0] - far[0], a[1] - far[1]) ? p : a));
    const masks = new Map<number, Mask>([[f, withoutArm]]);
    // A single include stroke along the arm, on a correction key frame.
    await runRoto(
      new TrackEngine(),
      { partId: 'subject', from: f, directions: ['key'], first: 0, last: 39, keyFrames: [{ frame: f, correction: true, strokes: [{ id: 'c', mode: 'include', radius: 2, points: [[(far[0] * 3 + near[0]) / 4, (far[1] * 3 + near[1]) / 4], [(far[0] + near[0] * 3) / 4, (far[1] + near[1] * 3) / 4]], by: '', at: '' }] }], scale: 1, smoothing: 0, settings: {} },
      ioFor(scene, masks),
    );
    const edited = masks.get(f)!;
    expect(iou(edited, truth)).toBeGreaterThan(0.95);
    // The head and legs, far from the paint, are exactly as they were.
    const head = scene.truth(f, 'head');
    let kept = 0;
    let all = 0;
    for (let i = 0; i < head.length; i += 1) if (head[i]) {
      all += 1;
      if (edited.data[i]! >= 128) kept += 1;
    }
    expect(kept / all).toBeGreaterThan(0.98);
  });

  it('stops between frames when cancelled', async () => {
    const scene = discScene({ frames: 24 });
    const controller = new AbortController();
    const masks = new Map<number, Mask>();
    const io = { ...ioFor(scene, masks), signal: controller.signal, progress: (done: number) => done >= 4 && controller.abort() };
    await expect(runRoto(new TrackEngine(), { partId: 'subject', from: 0, directions: ['key', 'forward'], first: 0, last: 23, keyFrames: [{ frame: 0, strokes: discStrokes(80, 108) }], scale: 1, smoothing: 0, settings: {} }, io)).rejects.toBeInstanceOf(CancelledError);
    expect(masks.size).toBe(4);
  });

  it('refuses a key frame with nothing painted in', async () => {
    const scene = discScene();
    await expect(
      runRoto(new TrackEngine(), { partId: 'subject', from: 0, directions: ['key'], first: 0, last: 1, keyFrames: [{ frame: 0, strokes: [discStrokes(0, 0)[1]!] }], scale: 1, smoothing: 0, settings: {} }, ioFor(scene)),
    ).rejects.toThrow(/Paint some of the subject in/);
    await expect(runRoto(new TrackEngine(), { partId: 'subject', from: 3, directions: ['key'], first: 0, last: 5, keyFrames: [], scale: 1, smoothing: 0, settings: {} }, ioFor(scene))).rejects.toThrow(/not a key frame/);
  });
});

describe('matte refinement', () => {
  const disc = (): Mask => {
    const t = discScene().truth(0);
    return { width: 320, height: 240, data: Uint8Array.from(t, (v) => v * 255) };
  };

  it('grows, shrinks and feathers in plate pixels', () => {
    const m = disc();
    const area = maskArea(m);
    const grown = refineMatte(m, { ...DEFAULT_REFINE, featherPx: 0, shrinkGrowPx: 4 }, { pxScale: 1, guide: null, upscaled: false });
    const shrunk = refineMatte(m, { ...DEFAULT_REFINE, featherPx: 0, shrinkGrowPx: -4 }, { pxScale: 1, guide: null, upscaled: false });
    const r = Math.sqrt(area / Math.PI);
    expect(Math.sqrt(maskArea(grown) / Math.PI) - r).toBeCloseTo(4, 0);
    expect(r - Math.sqrt(maskArea(shrunk) / Math.PI)).toBeCloseTo(4, 0);
    // pxScale 2: the same 4 plate pixels are 2 mask pixels.
    const grown2 = refineMatte(m, { ...DEFAULT_REFINE, featherPx: 0, shrinkGrowPx: 4 }, { pxScale: 2, guide: null, upscaled: false });
    expect(Math.sqrt(maskArea(grown2) / Math.PI) - r).toBeCloseTo(2, 0);
    const feathered = refineMatte(m, { ...DEFAULT_REFINE, featherPx: 6 }, { pxScale: 1, guide: null, upscaled: false });
    const soft = [...feathered.data].filter((v) => v > 10 && v < 245).length;
    const hard = [...m.data].filter((v) => v > 10 && v < 245).length;
    expect(soft).toBeGreaterThan(hard + 500);
  });

  it('scales a working matte to plate resolution with the edge snapped to the picture', () => {
    const scene = discScene({ width: 640, height: 480, radius: 72 });
    const full = scene.render(0);
    const truth = scene.truth(0);
    // A coarse, blocky working matte at a quarter of the size.
    const small = discScene({ width: 160, height: 120, radius: 18 }).truth(0);
    const working: Mask = { width: 160, height: 120, data: Uint8Array.from(small, (v) => v * 255) };
    const plain = upscaleMatte(working, 640, 480, null, { ...DEFAULT_REFINE, featherPx: 0, edgeSnap: false });
    const snapped = upscaleMatte(working, 640, 480, toGray(full), { ...DEFAULT_REFINE, featherPx: 0 });
    expect(plain.width).toBe(640);
    expect(iou(snapped, truth)).toBeGreaterThanOrEqual(iou(plain, truth) - 0.002);
    expect(iou(snapped, truth)).toBeGreaterThan(0.97);
  });
});

describe('synthetic scenes', () => {
  it('are deterministic and their truth matches what is drawn', () => {
    const a = discScene().render(5);
    const b = discScene().render(5);
    expect(Buffer.from(a.data).equals(Buffer.from(b.data))).toBe(true);
    const fig: RGBImage = figureScene({ width: 320, height: 169, frames: 10 }).render(3);
    expect(fig.data.length).toBe(320 * 169 * 3);
    const t = figureScene({ width: 320, height: 169, frames: 10 }).truth(3);
    expect(maskArea(t)).toBeGreaterThan(2000);
    expect(maskArea(binarize({ width: 320, height: 169, data: Uint8Array.from(t, (v) => v * 255) }))).toBe(maskArea(t));
  });
});
