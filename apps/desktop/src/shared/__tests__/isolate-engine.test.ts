import { describe, expect, it } from 'vitest';
import { DEFAULT_ISOLATE_PARAMS, isolateProblemReasons, type IsolateKeyFrame, type IsolateSeed, type IsolateTarget } from '@vcvfx/domain';
import { cleanPlateScene } from '../cleanplate/synthetic';
import { ShotIsolator, boxStrokes, runIsolate, type IsolateIO, type MatteOutput, type PlateOutput } from '../isolate/engine';
import { skyScene, type SkyScene } from '../isolate/synthetic';
import { lumaWeights, workingSpace, type LinearImage } from '../key/linear';
import { TrackEngine } from '../roto/track';
import type { SegmentationEngine } from '../roto/engine';

/**
 * Sky isolation and background removal (addendum 11) against synthetic shots
 * with exact ground truth: a sky (clear or overcast) over a skyline with a
 * bare tree whose branches thin to a third of a pixel, a power line about
 * half a pixel wide, a bird flying across the sky and a runner crossing a
 * roof with the sky behind him, seen by a panning camera; and the clean
 * plate's textured wall with a crew member walking across. The numbers
 * asserted here are the ones the addendum reports.
 */

const SPACE = workingSpace('acescg');
const LUMA = lumaWeights('ap1');
const FIRST = 1001;

function ioOf(render: (k: number) => LinearImage, roto: (partId: string, k: number) => Float32Array | null = () => null): IsolateIO {
  const cache = new Map<number, LinearImage>();
  return {
    frame: async (f) => {
      let img = cache.get(f);
      if (!img) {
        img = render(f - FIRST);
        cache.set(f, img);
      }
      return img;
    },
    roto: async (partId, f) => roto(partId, f - FIRST),
  };
}

const settings = (target: IsolateTarget, seed: Partial<IsolateSeed> = {}, keyFrames: IsolateKeyFrame[] = [], params = {}) => ({
  target,
  seed: { mode: target === 'sky' ? ('auto' as const) : ('box' as const), frame: null, rect: null, partId: null, ...seed },
  engine: 'track' as const,
  keyFrames,
  params: { ...DEFAULT_ISOLATE_PARAMS, ...params },
});

async function build(io: IsolateIO, frames: number, s: ReturnType<typeof settings>, o: { engine?: () => Promise<SegmentationEngine> } = {}) {
  const isolator = new ShotIsolator(s, { first: FIRST, last: FIRST + frames - 1 }, { pxScale: 1, space: SPACE, ...(o.engine ? { engine: o.engine } : {}) });
  const mattes = new Map<number, MatteOutput>();
  const plates = new Map<number, PlateOutput>();
  const t0 = performance.now();
  const result = await runIsolate(io, isolator, { revision: 0 }, (m) => void mattes.set(m.frame, m), (p) => void plates.set(p.frame, p));
  return { result, mattes, plates, isolator, ms: (performance.now() - t0) / frames };
}

const iou = (a: Float32Array, t: Float32Array) => {
  let i = 0;
  let u = 0;
  for (let k = 0; k < a.length; k += 1) {
    const A = a[k]! >= 0.5;
    const T = t[k]! >= 0.5;
    if (A && T) i += 1;
    if (A || T) u += 1;
  }
  return u ? i / u : 1;
};

/** Mean |α − truth| over the truth's partial pixels (the edge). */
const edgeError = (a: Float32Array, t: Float32Array) => {
  let s = 0;
  let n = 0;
  for (let k = 0; k < a.length; k += 1)
    if (t[k]! > 0.02 && t[k]! < 0.98) {
      s += Math.abs(a[k]! - t[k]!);
      n += 1;
    }
  return n ? s / n : 0;
};

/** Σα / Σtruth over the pixels of a thin structure (where nothing else is in front of the sky). */
function thin(a: Float32Array, part: Float32Array, all: Float32Array) {
  let est = 0;
  let truth = 0;
  let max = 0;
  for (let k = 0; k < a.length; k += 1)
    if (part[k]! > 0.05 && Math.abs(all[k]! - part[k]!) < 0.01) {
      est += a[k]!;
      truth += part[k]!;
      max = Math.max(max, a[k]!);
    }
  return { ratio: est / truth, max, truth };
}

/** Mean relative error of a plate against the truth over pixel indices. */
function plateError(plate: Float32Array, truth: Float32Array, idx: number[]) {
  let s = 0;
  for (const i of idx) {
    const t = LUMA[0] * truth[3 * i]! + LUMA[1] * truth[3 * i + 1]! + LUMA[2] * truth[3 * i + 2]!;
    s += (Math.abs(plate[3 * i]! - truth[3 * i]!) + Math.abs(plate[3 * i + 1]! - truth[3 * i + 1]!) + Math.abs(plate[3 * i + 2]! - truth[3 * i + 2]!)) / 3 / Math.max(0.02, t);
  }
  return s / Math.max(1, idx.length);
}

const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / Math.max(1, v.length);

describe('sky isolation', () => {
  const N = 24;
  let clear: { scene: SkyScene; out: Awaited<ReturnType<typeof build>> } | null = null;
  const clearShot = async () => {
    if (!clear) {
      const scene = skyScene({ width: 320, height: 180, frames: N, sky: 'clear', noise: 0.002 });
      clear = { scene, out: await build(ioOf((k) => scene.render(k)), N, settings('sky')) };
    }
    return clear;
  };

  it('finds a clear sky through a pan: the skyline, the tree, the power line and what moves in front stay foreground', async () => {
    const { scene, out } = await clearShot();
    const ious: number[] = [];
    const edges: number[] = [];
    const wire: number[] = [];
    const wireMax: number[] = [];
    const branches: number[] = [];
    let bird = 0;
    let birdN = 0;
    let runner = 0;
    let runnerN = 0;
    for (let k = 0; k < N; k += 1) {
      const a = out.mattes.get(FIRST + k)!.alpha;
      const truth = scene.alpha(k);
      ious.push(iou(a, truth));
      edges.push(edgeError(a, truth));
      const w = thin(a, scene.wire(k), truth);
      wire.push(w.ratio);
      wireMax.push(w.max);
      branches.push(thin(a, scene.branches(k), truth).ratio);
      const b = scene.bird(k);
      const r = scene.runner(k);
      for (let i = 0; i < a.length; i += 1) {
        if (b[i]! > 0.9) (birdN += 1), (bird += a[i]! > 0.5 ? 1 : 0);
        if (r[i]! > 0.9) (runnerN += 1), (runner += a[i]! > 0.5 ? 1 : 0);
      }
    }
    const flicker = mean(out.result.frames.map((f) => f.metrics.flicker));
    console.log(
      `sky, clear, pan, 320×180, ${N} frames: IoU min ${Math.min(...ious).toFixed(4)} mean ${mean(ious).toFixed(4)}, edge error ${mean(edges).toFixed(3)}, power line Σα/Σtruth ${mean(wire).toFixed(2)} (max α ${Math.max(...wireMax).toFixed(2)}), thin branches ${mean(branches).toFixed(2)}, bird kept ${((bird / birdN) * 100).toFixed(1)} %, runner kept ${((runner / runnerN) * 100).toFixed(1)} %, flicker ${(flicker * 100).toFixed(2)} %, confidence ${mean(out.result.frames.map((f) => f.confidence)).toFixed(3)}, ${out.ms.toFixed(0)} ms/frame`,
    );
    expect(Math.min(...ious)).toBeGreaterThan(0.98);
    expect(mean(edges)).toBeLessThan(0.08);
    // Thin structures keep fractional alpha: neither dropped nor made solid.
    expect(mean(wire)).toBeGreaterThan(0.7);
    expect(mean(wire)).toBeLessThan(1.4);
    expect(Math.max(...wireMax)).toBeLessThan(0.95);
    expect(Math.max(...wireMax)).toBeGreaterThan(0.3);
    expect(mean(branches)).toBeGreaterThan(0.7);
    expect(mean(branches)).toBeLessThan(1.4);
    // Occluders in front of the sky are not cut into.
    expect(bird / birdN).toBeGreaterThan(0.97);
    expect(runner / runnerN).toBeGreaterThan(0.97);
    // Steady in time; confident; nothing to flag on a clean shot.
    expect(flicker).toBeLessThan(0.01);
    expect(out.result.alignment).toBe('homography');
    expect(mean(out.result.frames.map((f) => f.confidence))).toBeGreaterThan(0.85);
    expect([...isolateProblemReasons(out.result.frames, 'sky').values()].filter(Boolean)).toHaveLength(0);
  }, 120_000);

  it('rebuilds the sky behind what moves from other frames, and fills (and flags) the sky no frame saw', async () => {
    const { scene, out } = await clearShot();
    const behindBird: number[] = [];
    const nearRoof: number[] = [];
    let deepFlagged = 0;
    let deepN = 0;
    for (const k of [6, 12, 18]) {
      const p = out.plates.get(FIRST + k)!;
      const truth = scene.sky(k).data;
      const bird = scene.bird(k);
      const all = scene.alpha(k);
      const idx: number[] = [];
      const near: number[] = [];
      const w = scene.width;
      for (let i = 0; i < bird.length; i += 1) {
        if (bird[i]! > 0.99) idx.push(i);
        if (all[i]! < 0.99) continue;
        // Rows up to the sky above this solid pixel (a roofline): two or three is just under it, twelve or more (and away from a side wall) is deep.
        let up = 0;
        while (up < 16 && i - (up + 1) * w >= 0 && all[i - (up + 1) * w]! > 0.05) up += 1;
        if (up >= 16 || i - (up + 1) * w < 0) continue;
        if (up === 2 || up === 3) near.push(i);
        if (up >= 12 && all[i - 8]! > 0.99 && all[i + 8]! > 0.99) {
          deepN += 1;
          if (p.confidence[i]! < 0.5) deepFlagged += 1;
        }
      }
      behindBird.push(plateError(p.plate, truth, idx));
      expect(near.length).toBeGreaterThan(20);
      nearRoof.push(plateError(p.plate, truth, near));
      // Behind the bird the sky was seen in other frames: confident.
      expect(mean(idx.map((i) => p.confidence[i]!))).toBeGreaterThan(0.8);
    }
    console.log(`sky plate: behind the bird ${(mean(behindBird) * 100).toFixed(2)} % error, two pixels under the roofline (never seen, filled) ${(mean(nearRoof) * 100).toFixed(1)} %, twelve pixels under it flagged ${((deepFlagged / deepN) * 100).toFixed(0)} %`);
    expect(mean(behindBird)).toBeLessThan(0.03);
    expect(mean(nearRoof)).toBeLessThan(0.12);
    expect(deepFlagged / deepN).toBeGreaterThan(0.95);
  }, 120_000);

  it('finds an overcast sky as well', async () => {
    const scene = skyScene({ width: 320, height: 180, frames: 12, sky: 'overcast', noise: 0.002, seed: 9 });
    const out = await build(ioOf((k) => scene.render(k)), 12, settings('sky'));
    const ious = Array.from({ length: 12 }, (_, k) => iou(out.mattes.get(FIRST + k)!.alpha, scene.alpha(k)));
    const edges = Array.from({ length: 12 }, (_, k) => edgeError(out.mattes.get(FIRST + k)!.alpha, scene.alpha(k)));
    console.log(`sky, overcast, 320×180, 12 frames: IoU min ${Math.min(...ious).toFixed(4)}, edge error ${mean(edges).toFixed(3)}`);
    expect(Math.min(...ious)).toBeGreaterThan(0.985);
    expect(mean(edges)).toBeLessThan(0.08);
  }, 60_000);

  it('never takes a sky with nothing in front of it as an answer: a hazy skyline the cues call sky is flagged', async () => {
    const scene = skyScene({ width: 320, height: 180, frames: 6, sky: 'overcast', noise: 0.002, haze: 0.5, runner: false, bird: false });
    const out = await build(ioOf((k) => scene.render(k)), 6, settings('sky'));
    const reasons = [...isolateProblemReasons(out.result.frames, 'sky').values()];
    console.log(`hazy overcast (the skyline half a stop under the sky, the same grey): foreground found ${(mean(out.result.frames.map((f) => f.metrics.foreground)) * 100).toFixed(1)} % (truth ${((mean(Array.from({ length: 6 }, (_, k) => mean(Array.from(scene.alpha(k))))) * 100).toFixed(0))} %), every frame flagged: ${reasons.every((r) => r.length > 0)}`);
    expect(reasons.every((r) => r.includes('almost nothing found in front of the sky'))).toBe(true);
  }, 60_000);

  it('carries a painted correction to the frames around it (aligned for the camera), and no further', async () => {
    const scene = skyScene({ width: 320, height: 180, frames: 16, noise: 0.002, runner: false, bird: false });
    const io = ioOf((k) => scene.render(k));
    // A patch of open sky (no cloud edge, nothing in front) on frame 1012, painted "keep in front".
    const H = scene.homography(11, 0);
    void H;
    const patch = { mode: 'include' as const, radius: 6, points: [[250, 30] as [number, number], [262, 32] as [number, number]] };
    const far = { mode: 'include' as const, radius: 3, points: [[40, 170] as [number, number]] }; // on a building: changes nothing
    const k = (frame: number, strokes: (typeof patch)[]): IsolateKeyFrame => ({ frame, strokes: strokes.map((s, i) => ({ ...s, id: `s${frame}${i}`, by: 't', at: '' })), correction: true, by: 't', at: '' });
    const base = await build(io, 16, settings('sky', {}, [k(1004, [far])]));
    const fixed = await build(io, 16, settings('sky', {}, [k(1004, [far]), k(1012, [patch])]));
    // The painted world patch, followed into each frame by the true camera motion.
    const inPatch = (f: number) => {
      const Hf = scene.homography(11, f - FIRST);
      const [x, y] = [256, 31];
      const d = Hf[6]! * x + Hf[7]! * y + Hf[8]!;
      return Math.round((Hf[3]! * x + Hf[4]! * y + Hf[5]!) / d) * scene.width + Math.round((Hf[0]! * x + Hf[1]! * y + Hf[2]!) / d);
    };
    // The correction reaches from halfway to the previous painted frame (1004) to the end of the shot.
    for (const f of [1009, 1012, 1016]) expect(fixed.mattes.get(f)!.alpha[inPatch(f)]!).toBeGreaterThan(0.5);
    for (const f of [1001, 1004, 1007, 1008]) {
      expect(base.mattes.get(f)!.alpha[inPatch(f)]!).toBeLessThan(0.5);
      // Frames the correction does not reach are untouched, bit for bit.
      expect(fixed.mattes.get(f)!.alpha).toEqual(base.mattes.get(f)!.alpha);
    }
  }, 120_000);
});

describe('background removal', () => {
  it('isolates a subject crossing a textured wall from a box on one frame, through a pan, with its background rebuilt', async () => {
    const N = 24;
    const scene = cleanPlateScene({ width: 320, height: 180, frames: N, noise: 0.002, stand: false });
    const seedK = 12;
    const t = scene.crew(seedK);
    let x0 = 1e9;
    let y0 = 1e9;
    let x1 = -1;
    let y1 = -1;
    for (let i = 0; i < t.length; i += 1)
      if (t[i]! > 0.5) {
        const x = i % 320;
        const y = (i - x) / 320;
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
    const rect = { x0: x0 - 4, y0: y0 - 4, x1: x1 + 5, y1: Math.min(179, y1 + 5) };
    let keys = 0;
    let steps = 0;
    const counting = async (): Promise<SegmentationEngine> => {
      const e = new TrackEngine();
      return { id: e.id, version: e.version, label: e.label, key: (r) => ((keys += 1), e.key(r)), step: (r) => ((steps += 1), e.step(r)), dispose: () => e.dispose() };
    };
    const out = await build(ioOf((k) => scene.render(k)), N, settings('background', { mode: 'box', rect, frame: FIRST + seedK }), { engine: counting });
    const ious = Array.from({ length: N }, (_, k) => iou(out.mattes.get(FIRST + k)!.alpha, scene.crew(k)));
    const plateErr: number[] = [];
    for (let k = 0; k < N; k += 3) {
      const crew = scene.crew(k);
      const idx: number[] = [];
      for (let i = 0; i < crew.length; i += 1) if (crew[i]! > 0.5) idx.push(i);
      plateErr.push(plateError(out.plates.get(FIRST + k)!.plate, scene.clean(k).data, idx));
    }
    console.log(`subject on a wall, box seed, 320×180, ${N} frames: IoU min ${Math.min(...ious).toFixed(3)} mean ${mean(ious).toFixed(4)}, background behind it ${(mean(plateErr) * 100).toFixed(2)} % error, flicker ${(mean(out.result.frames.map((f) => f.metrics.flicker)) * 100).toFixed(2)} %, ${out.ms.toFixed(0)} ms/frame`);
    expect(Math.min(...ious)).toBeGreaterThan(0.95);
    expect(mean(plateErr)).toBeLessThan(0.03);
    // The engine it was given did the work: one key, every other frame stepped.
    expect(keys).toBeGreaterThanOrEqual(1);
    expect(steps).toBe(N - 1);
    expect(out.result.engine).toBe('track@1.0.0');
    expect(out.result.alignment).toBe('homography');
  }, 120_000);

  it('takes a roto part as the subject and refines its edge against the rebuilt background', async () => {
    const N = 16;
    const scene = skyScene({ width: 320, height: 180, frames: N, noise: 0.002, bird: false });
    const io = ioOf((k) => scene.render(k), (id, k) => (id === 'runner' ? scene.runner(k) : null));
    const out = await build(io, N, settings('background', { mode: 'roto', partId: 'runner' }));
    const ious = Array.from({ length: N }, (_, k) => iou(out.mattes.get(FIRST + k)!.alpha, scene.runner(k)));
    const edges = Array.from({ length: N }, (_, k) => edgeError(out.mattes.get(FIRST + k)!.alpha, scene.runner(k)));
    console.log(`runner from a roto part, 320×180, ${N} frames: IoU min ${Math.min(...ious).toFixed(3)}, edge error ${mean(edges).toFixed(3)}`);
    expect(Math.min(...ious)).toBeGreaterThan(0.95);
    expect(mean(edges)).toBeLessThan(0.06);
  }, 120_000);

  it('re-segments a corrected frame and carries the correction locally', async () => {
    const N = 16;
    const scene = skyScene({ width: 320, height: 180, frames: N, noise: 0.002, bird: false });
    const io = ioOf((k) => scene.render(k));
    const seedK = 8;
    const truth = scene.runner(seedK);
    let x0 = 1e9;
    let y0 = 1e9;
    let x1 = -1;
    let y1 = -1;
    for (let i = 0; i < truth.length; i += 1)
      if (truth[i]! > 0.5) {
        const x = i % 320;
        const y = (i - x) / 320;
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
    const seed = { mode: 'box' as const, rect: { x0: x0 - 3, y0: y0 - 3, x1: x1 + 4, y1: y1 + 4 }, frame: FIRST + seedK };
    const base = await build(io, N, settings('background', seed));
    const ious = Array.from({ length: N }, (_, k) => iou(base.mattes.get(FIRST + k)!.alpha, scene.runner(k)));
    // The worst frame away from the seed, corrected with paint where the matte is wrong.
    const worst = ious.map((v, k) => ({ v, k })).filter((x) => Math.abs(x.k - seedK) >= 3).sort((a, b) => a.v - b.v)[0]!.k;
    const a = base.mattes.get(FIRST + worst)!.alpha;
    const t = scene.runner(worst);
    const missed: [number, number][] = [];
    const extra: [number, number][] = [];
    for (let i = 0; i < a.length; i += 1) {
      const p: [number, number] = [(i % 320) + 0.5, Math.floor(i / 320) + 0.5];
      if (t[i]! > 0.95 && a[i]! < 0.5) missed.push(p);
      if (t[i]! < 0.05 && a[i]! > 0.5) extra.push(p);
    }
    const strokes = [
      ...missed.filter((_, i) => i % 3 === 0).map((p, i) => ({ id: `i${i}`, mode: 'include' as const, radius: 1, points: [p], by: 't', at: '' })),
      ...extra.filter((_, i) => i % 3 === 0).map((p, i) => ({ id: `e${i}`, mode: 'exclude' as const, radius: 1, points: [p], by: 't', at: '' })),
    ];
    const fixed = await build(io, N, settings('background', seed, [{ frame: FIRST + worst, strokes, correction: true, by: 't', at: '' }]));
    const after = Array.from({ length: N }, (_, k) => iou(fixed.mattes.get(FIRST + k)!.alpha, scene.runner(k)));
    console.log(`correction on frame ${FIRST + worst}: IoU ${ious[worst]!.toFixed(3)} → ${after[worst]!.toFixed(3)} (${missed.length} pixels missed, ${extra.length} extra)`);
    expect(after[worst]!).toBeGreaterThan(ious[worst]!);
    expect(after[worst]!).toBeGreaterThan(0.95);
    // Frames on the seed's side of the halfway point keep their segmentation; only the camera alignment, which
    // leaves the subject out and so moves by a hair, touches them.
    const half = Math.floor((seedK + worst) / 2);
    for (let k = 0; k < N; k += 1) {
      const outside = worst > seedK ? k <= half : k > half;
      if (!outside) continue;
      const a0 = base.mattes.get(FIRST + k)!.alpha;
      const a1 = fixed.mattes.get(FIRST + k)!.alpha;
      expect(Math.abs(after[k]! - ious[k]!)).toBeLessThan(0.005);
      let d = 0;
      for (let i = 0; i < a0.length; i += 1) d += Math.abs(a1[i]! - a0[i]!);
      expect(d / a0.length).toBeLessThan(2e-4);
    }
  }, 180_000);

  it('builds the box prompt as paint: the middle in, a frame round it out', () => {
    const s = boxStrokes({ x0: 100, y0: 50, x1: 140, y1: 150 });
    expect(s.map((x) => x.mode)).toEqual(['include', 'exclude']);
    expect(s[1]!.points[0]![0]).toBeLessThan(100);
    expect(s[0]!.points.every(([x, y]) => x === 120 && y > 50 && y < 150)).toBe(true);
  });
});
