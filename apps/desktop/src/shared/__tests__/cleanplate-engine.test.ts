import { describe, expect, it } from 'vitest';
import { newCleanPlateDocument, type CleanPlateRemove } from '@vcvfx/domain';
import { alignShot, cornerMotion, scaleHomography } from '../cleanplate/align';
import { ShotCleaner, analysisFromJson, analysisToJson, removalHole, runCleanPlate, scaleAnalysis, type CleanPlateIO, type CleanPlateSettings } from '../cleanplate/engine';
import { unresolvedOf } from '../cleanplate/fill';
import { cleanPlateScene, mul3, inv3, type CleanPlateScene } from '../cleanplate/synthetic';
import { lumaWeights, type LinearImage } from '../key/linear';
import { applyH } from '../camera/two-view';
import { morph } from '../roto/image';

/**
 * The clean-plate engine (addendum 10) against synthetic shots with exact
 * ground truth: a textured wall seen through a known homography per frame, a
 * crew member walking across it, and a light stand that never moves (what it
 * hides is never seen). The numbers asserted here are the ones the addendum
 * reports.
 */

const LUMA = lumaWeights('ap1');
const FIRST = 1001;

function sceneIO(scene: CleanPlateScene): CleanPlateIO & { reads: number } {
  const cache = new Map<number, LinearImage>();
  const io = {
    reads: 0,
    frame: async (f: number) => {
      let img = cache.get(f);
      if (!img) {
        io.reads += 1;
        img = scene.render(f - FIRST);
        cache.set(f, img);
        if (cache.size > 64) cache.delete(cache.keys().next().value!);
      }
      return img;
    },
    roto: async (partId: string, f: number) => (partId === 'crew' ? scene.crew(f - FIRST) : partId === 'stand' ? scene.stand(f - FIRST) : null),
  };
  return io;
}

const remove = (ids: string[]): CleanPlateRemove[] => ids.map((partId, i) => ({ id: `r${i + 1}`, label: '', source: { type: 'roto', partId }, frames: null, enabled: true }));
function settings(over: Partial<CleanPlateSettings> = {}, parts = ['crew', 'stand']): CleanPlateSettings {
  const d = newCleanPlateDocument();
  return { remove: remove(parts), mode: d.mode, alignment: d.alignment, referenceFrame: d.referenceFrame, params: d.params, guidance: d.guidance, ...over };
}

/** Mean absolute error relative to the truth's luminance, over pixel indices. */
function relError(est: Float32Array, truth: Float32Array, idx: number[]): number {
  let s = 0;
  for (const i of idx) {
    const t = LUMA[0] * truth[3 * i]! + LUMA[1] * truth[3 * i + 1]! + LUMA[2] * truth[3 * i + 2]!;
    let e = 0;
    for (let c = 0; c < 3; c += 1) e += Math.abs(est[3 * i + c]! - truth[3 * i + c]!);
    s += e / 3 / Math.max(0.02, t);
  }
  return s / Math.max(1, idx.length);
}

/** Pixels of a frame: removed and revealed somewhere (the crew's, away from the stand), and never revealed (inside the stand). */
function regionsOf(scene: CleanPlateScene, n: number) {
  const w = scene.width;
  const h = scene.height;
  const crew = scene.crew(n);
  const standM = Uint8Array.from(scene.stand(n), (v) => (v > 0.02 ? 1 : 0));
  const nearStand = morph(standM, w, h, 10);
  const deepStand = morph(standM, w, h, -1);
  const revealed: number[] = [];
  const never: number[] = [];
  for (let i = 0; i < w * h; i += 1) {
    const x = i % w;
    const y = (i - x) / w;
    if (x < 6 || y < 6 || x >= w - 6 || y >= h - 6) continue;
    if (crew[i]! > 0.5 && !nearStand[i]) revealed.push(i);
    if (deepStand[i]) never.push(i);
  }
  return { revealed, never };
}

describe('alignment', () => {
  it('recovers the known homography of a panning, zooming, rolling camera with a subject crossing', async () => {
    const scene = cleanPlateScene({ frames: 24 });
    const io = sceneIO(scene);
    const s = settings();
    const frames = Array.from({ length: 24 }, (_, i) => FIRST + i);
    const ref = FIRST + 12;
    const a = await alignShot(frames, ref, async (f) => {
      const image = await io.frame(f);
      return { image, hole: await removalHole(s, io, f, image.width, image.height, 1) };
    }, { model: 'auto', luma: LUMA });
    expect(a.static).toBe(false);
    expect(a.model).toBe('homography');
    let worst = 0;
    for (const f of frames) {
      const truth = scene.homography(ref - FIRST, f - FIRST);
      const est = a.frames.get(f)!.H;
      for (const [x, y] of [[0, 0], [319, 0], [319, 179], [0, 179], [160, 90]] as const) {
        const [u0, v0] = applyH(truth, x, y);
        const [u1, v1] = applyH(est, x, y);
        worst = Math.max(worst, Math.hypot(u1 - u0, v1 - v0));
      }
    }
    console.log(`alignment: worst corner error ${worst.toFixed(3)} px; motion ${a.motion.toFixed(1)} px; median residual ${a.residual.toFixed(3)} px`);
    expect(worst).toBeLessThan(0.35);
    expect(a.motion).toBeGreaterThan(40);
    expect(a.residual).toBeLessThan(0.2);
  });

  it('detects a static camera, and scales homographies between pixel grids exactly', async () => {
    const scene = cleanPlateScene({ frames: 12, camera: 'static', noise: 0.002 });
    const io = sceneIO(scene);
    const cleaner = new ShotCleaner(settings(), { first: FIRST, last: FIRST + 11 }, { pxScale: 1, luma: LUMA });
    const a = await cleaner.analyse(io);
    expect(a.alignment.static).toBe(true);
    expect(a.alignment.model).toBe('static');
    expect(a.suggestion).toMatchObject({ mode: 'still', static: true });
    expect(a.mode).toBe('still');
    // A pure translation by 2 small pixels is 4 big pixels at twice the size.
    const H = scaleHomography([1, 0, 2, 0, 1, 0, 0, 0, 1], 2);
    expect(applyH(H, 10, 10).map((v) => +v.toFixed(6))).toEqual([14, 10]);
    expect(cornerMotion([1, 0, 0, 0, 1, 0, 0, 0, 1], 100, 100)).toBe(0);
    // The analysis survives a worker message.
    const back = analysisFromJson(JSON.parse(JSON.stringify(analysisToJson(a))));
    expect(back.alignment.frames.get(FIRST + 3)!.H).toEqual(a.alignment.frames.get(FIRST + 3)!.H);
    expect(scaleAnalysis(a, 2).alignment.static).toBe(true);
  });
});

describe('temporal reconstruction', () => {
  it('a moving camera: what the crew member hides is rebuilt from aligned frames; what the stand hides is flagged', async () => {
    const scene = cleanPlateScene({ frames: 32, noise: 0.002 });
    const io = sceneIO(scene);
    const cleaner = new ShotCleaner(settings({ mode: 'sequence' }), { first: FIRST, last: FIRST + 31 }, { pxScale: 1, luma: LUMA });
    const t0 = performance.now();
    const outs = new Map<number, Awaited<ReturnType<ShotCleaner['plate']>>>();
    const result = await runCleanPlate(io, cleaner, { revision: 3 }, (o) => void outs.set(o.frame, o));
    const ms = performance.now() - t0;
    expect(result).toMatchObject({ mode: 'sequence', alignment: 'homography', first: FIRST, last: FIRST + 31, revision: 3, reference: FIRST + 16 });
    expect(result.frames).toHaveLength(32);
    const errs: number[] = [];
    const flagged: number[] = [];
    const confRevealed: number[] = [];
    for (const n of [4, 10, 16, 22, 27]) {
      const out = outs.get(FIRST + n)!;
      const { revealed, never } = regionsOf(scene, n);
      errs.push(relError(out.plate, scene.clean(n).data, revealed));
      const un = unresolvedOf(out);
      flagged.push(never.filter((i) => un[i]).length / never.length);
      confRevealed.push(revealed.reduce((a, i) => a + out.confidence[i]!, 0) / revealed.length);
      // Outside what was removed, the plate is the frame itself.
      const img = scene.render(n).data;
      let same = true;
      for (let i = 0; i < out.hole.length && same; i += 7) if (!out.hole[i] && !out.inpainted[i] && out.confidence[i] === 1 && Math.abs(out.plate[3 * i]! - img[3 * i]!) > 0.02) same = false;
      expect(same).toBe(true);
    }
    const meanErr = errs.reduce((a, b) => a + b, 0) / errs.length;
    console.log(`sequence (pan, 320×180, 32 frames): revealed error ${(meanErr * 100).toFixed(2)} % (per frame ${errs.map((e) => (e * 100).toFixed(1)).join(', ')}), revealed confidence ${confRevealed.map((c) => c.toFixed(2)).join(', ')}, never-revealed flagged ${flagged.map((f) => (f * 100).toFixed(0)).join(', ')} %, ${(ms / 32).toFixed(0)} ms/frame, coverage ${result.frames.map((f) => f.metrics.coverage.toFixed(2)).slice(0, 4).join(',')}`);
    expect(meanErr).toBeLessThan(0.03);
    expect(Math.min(...flagged)).toBeGreaterThan(0.95);
    expect(Math.min(...confRevealed)).toBeGreaterThan(0.7);
    // Every frame reports what it could not rebuild; none of it hidden.
    expect(result.frames.every((f) => f.metrics.low > 0 && f.metrics.coverage < 1)).toBe(true);
  }, 60_000);
});

describe('a frame that does not belong (addendum 16)', () => {
  it('never borrows from a slate in the handles: it does not align, and what only it "sees" stays unresolved', async () => {
    const scene = cleanPlateScene({ frames: 24, noise: 0.002 });
    const base = sceneIO(scene);
    // The last frame of the range is a slate card: dark blue with a white logo, nothing like the wall.
    const slate: LinearImage = { width: scene.width, height: scene.height, data: new Float32Array(scene.width * scene.height * 3) };
    for (let i = 0; i < scene.width * scene.height; i += 1) {
      const x = i % scene.width;
      const logo = x > 100 && x < 220 && Math.floor(i / scene.width) > 70 && Math.floor(i / scene.width) < 110;
      slate.data.set(logo ? [0.9, 0.9, 0.9] : [0.01, 0.02, 0.04], 3 * i);
    }
    const last = FIRST + 23;
    const io: CleanPlateIO = { frame: async (f) => (f === last ? slate : base.frame(f)), roto: async (id, f, w, h) => (f === last ? new Float32Array(w * h) : base.roto(id, f, w, h)) };
    const cleaner = new ShotCleaner(settings({ mode: 'sequence' }), { first: FIRST, last }, { pxScale: 1, luma: LUMA });
    const outs = new Map<number, Awaited<ReturnType<ShotCleaner['plate']>>>();
    await runCleanPlate(io, cleaner, { revision: 1 }, (o) => void outs.set(o.frame, o));
    expect(cleaner.unaligned()).toEqual([last]);
    expect(cleaner.candidatesFor(FIRST + 20, false).some((c) => c.frame === last)).toBe(false);
    for (const n of [4, 12, 20]) {
      const out = outs.get(FIRST + n)!;
      const { revealed, never } = regionsOf(scene, n);
      expect(relError(out.plate, scene.clean(n).data, revealed)).toBeLessThan(0.03);
      const un = unresolvedOf(out);
      expect(never.filter((i) => un[i]).length / never.length).toBeGreaterThan(0.95);
      // No slate blue anywhere in what was rebuilt.
      let blue = 0;
      for (let i = 0; i < out.hole.length; i += 1) if (out.hole[i] && out.plate[3 * i + 2]! > 2.5 * out.plate[3 * i]! && out.plate[3 * i]! < 0.03) blue += 1;
      expect(blue).toBe(0);
    }
  }, 60_000);
});

describe('still plates, exposure, guidance', () => {
  it('a locked-off camera makes one still in the reference frame, pixel-exact where it borrows (no resampling)', async () => {
    const scene = cleanPlateScene({ frames: 24, camera: 'static' });
    const io = sceneIO(scene);
    const cleaner = new ShotCleaner(settings(), { first: FIRST, last: FIRST + 23 }, { pxScale: 1, luma: LUMA });
    const outs: Awaited<ReturnType<ShotCleaner['plate']>>[] = [];
    const t0 = performance.now();
    const result = await runCleanPlate(io, cleaner, { revision: 1 }, (o) => void outs.push(o));
    const ms = performance.now() - t0;
    expect(result).toMatchObject({ mode: 'still', alignment: 'static', reference: FIRST + 12 });
    expect(result.suggestion).toMatchObject({ mode: 'still', static: true });
    expect(outs).toHaveLength(1);
    const n = 12;
    const { revealed, never } = regionsOf(scene, n);
    const err = relError(outs[0]!.plate, scene.clean(n).data, revealed);
    const un = unresolvedOf(outs[0]!);
    console.log(`still (static, 320×180, 24 frames): revealed error ${(err * 100).toFixed(3)} %, never-revealed flagged ${((never.filter((i) => un[i]).length / never.length) * 100).toFixed(0)} %, ${ms.toFixed(0)} ms in all`);
    expect(err).toBeLessThan(0.002);
    expect(never.filter((i) => un[i]).length / never.length).toBeGreaterThan(0.95);
    expect(result.frames[0]!.metrics.coverage).toBeLessThan(1);
  }, 30_000);

  it('matches each frame’s exposure before borrowing (a light that drifts ±12 %)', async () => {
    const scene = cleanPlateScene({ frames: 24, drift: 0.12, noise: 0.002 });
    const io = sceneIO(scene);
    const cleaner = new ShotCleaner(settings({ mode: 'sequence' }), { first: FIRST, last: FIRST + 23 }, { pxScale: 1, luma: LUMA });
    const a = await cleaner.analyse(io);
    // The measured gains follow the true ones.
    let worst = 0;
    for (const f of [FIRST + 2, FIRST + 7, FIRST + 19]) worst = Math.max(worst, Math.abs(a.alignment.frames.get(f)!.gain[1] / (scene.gain(f - FIRST) / scene.gain(12)) - 1));
    expect(worst).toBeLessThan(0.01);
    expect(a.alignment.exposureStops).toBeGreaterThan(0.1);
    const out = await cleaner.plate(io, FIRST + 5);
    const { revealed } = regionsOf(scene, 5);
    const err = relError(out.plate, scene.clean(5).data, revealed);
    console.log(`exposure drift ±12 %: gain error ${(worst * 100).toFixed(2)} %, revealed error ${(err * 100).toFixed(2)} %`);
    expect(err).toBeLessThan(0.03);
    expect(Math.abs(out.metrics.exposureStops)).toBeGreaterThan(0.05);
  }, 30_000);

  it('leaves out excluded frames, weights preferred ones, and outvotes a frame where something else crosses', async () => {
    const scene = cleanPlateScene({ frames: 24, camera: 'static' });
    const base = sceneIO(scene);
    // Frame 1006: a bright thing crosses the wall where the crew member is on 1013 (not in any matte).
    const bad = FIRST + 5;
    const target = FIRST + 12;
    const crewAtTarget = scene.crew(12);
    const io: CleanPlateIO = {
      ...base,
      frame: async (f) => {
        const img = await base.frame(f);
        if (f !== bad) return img;
        const data = img.data.slice();
        for (let i = 0; i < crewAtTarget.length; i += 1) if (crewAtTarget[i]! > 0.5) for (let c = 0; c < 3; c += 1) data[3 * i + c] = 0.9;
        return { ...img, data };
      },
    };
    const s = settings({ mode: 'sequence', alignment: 'static', guidance: { prefer: [FIRST + 20], exclude: [FIRST + 3], patches: [] } });
    const cleaner = new ShotCleaner(s, { first: FIRST, last: FIRST + 23 }, { pxScale: 1, luma: LUMA });
    const cands = cleaner.candidatesFor(target, false);
    expect(cands.map((c) => c.frame)).not.toContain(FIRST + 3);
    expect(cands.map((c) => c.frame)).not.toContain(target);
    expect(cands.find((c) => c.frame === FIRST + 20)!.weight).toBeGreaterThan(3 * cands.find((c) => c.frame === FIRST + 4)!.weight);
    await cleaner.analyse(io);
    const out = await cleaner.plate(io, target);
    const { revealed } = regionsOf(scene, 12);
    const err = relError(out.plate, scene.clean(12).data, revealed);
    expect(err).toBeLessThan(0.005); // the bright frame is one voice among many, and outvoted
    // Left out entirely, it is not even a candidate; the plate is the same or better.
    const s2 = { ...s, guidance: { ...s.guidance, exclude: [FIRST + 3, bad] } };
    const c2 = new ShotCleaner(s2, { first: FIRST, last: FIRST + 23 }, { pxScale: 1, luma: LUMA });
    await c2.analyse(io);
    expect(c2.candidatesFor(target, false).map((c) => c.frame)).not.toContain(bad);
    expect(relError((await c2.plate(io, target)).plate, scene.clean(12).data, revealed)).toBeLessThanOrEqual(err + 1e-4);
  }, 30_000);

  it('a patch takes its region from the chosen frame; one from a frame that does not see the spot is not used', async () => {
    const scene = cleanPlateScene({ frames: 24, camera: 'static' });
    const io = sceneIO(scene);
    const target = FIRST + 12;
    // Where the light stand is on the target, and a region of it.
    const standM = scene.stand(12);
    let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    for (let i = 0; i < standM.length; i += 1) if (standM[i]! > 0.5) {
      const x = i % scene.width;
      const y = (i - x) / scene.width;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    const rect = { x0: x0 - 2, y0: y0 + 10, x1: x1 + 2, y1: y0 + 40 };
    // Without the stand in the matte on frame 1001 (a patch source where the artist knows the wall is clear: here we let 1001 see through it).
    const seeThrough: CleanPlateIO = { ...io, frame: async (f) => (f === FIRST ? scene.clean(0) : io.frame(f)), roto: async (p, f, w, h) => (p === 'stand' && f === FIRST ? null : io.roto(p, f, w, h)) };
    const s = settings({ mode: 'sequence', alignment: 'static', guidance: { prefer: [], exclude: [], patches: [{ id: 'p1', label: '', rect, sourceFrame: FIRST, frames: null, enabled: true }] } });
    const cleaner = new ShotCleaner(s, { first: FIRST, last: FIRST + 23 }, { pxScale: 1, luma: LUMA });
    await cleaner.analyse(seeThrough);
    const out = await cleaner.plate(seeThrough, target);
    const inside: number[] = [];
    for (let y = Math.ceil(rect.y0) + 2; y < rect.y1 - 2; y += 1) for (let x = x0 + 1; x < x1; x += 1) inside.push(y * scene.width + x);
    expect(inside.every((i) => out.patched[i] === 1)).toBe(true);
    expect(relError(out.plate, scene.clean(12).data, inside)).toBeLessThan(0.002);
    expect(Math.min(...inside.map((i) => out.confidence[i]!))).toBeGreaterThan(0.85);
    // The rest of the stand is still unresolved.
    expect(unresolvedOf(out)[(y0 + 60) * scene.width + ((x0 + x1) >> 1)]).toBe(1);
    // A patch from a frame whose own matte covers the spot gives nothing there.
    const s2 = { ...s, guidance: { ...s.guidance, patches: [{ ...s.guidance.patches[0]!, sourceFrame: FIRST + 4 }] } };
    const c2 = new ShotCleaner(s2, { first: FIRST, last: FIRST + 23 }, { pxScale: 1, luma: LUMA });
    await c2.analyse(io);
    const out2 = await c2.plate(io, target);
    expect(inside.some((i) => out2.patched[i] === 1)).toBe(false);
  }, 30_000);

  it('cuts a sequence’s window and anchors to fit the memory budget', async () => {
    const scene = cleanPlateScene({ frames: 12, camera: 'static' });
    const io = sceneIO(scene);
    const cleaner = new ShotCleaner(settings({ mode: 'sequence', alignment: 'static' }), { first: FIRST, last: FIRST + 11 }, { pxScale: 1, luma: LUMA, maxResidentBytes: 320 * 180 * 13 * 9 });
    await cleaner.analyse(io);
    const b = cleaner.budget(false);
    expect(2 * b.window + 1 + b.anchors).toBeLessThanOrEqual(9);
    expect(b.window).toBeGreaterThanOrEqual(1);
    expect(new ShotCleaner(settings(), { first: FIRST, last: FIRST + 11 }, { pxScale: 1, luma: LUMA }).budget(false)).toEqual({ window: 12, anchors: 16 });
    // Building every frame in order reads each frame a bounded number of times.
    const before = (io as { reads: number }).reads;
    for (let f = FIRST; f <= FIRST + 11; f += 1) await cleaner.plate(io, f, { keep: true });
    expect((io as { reads: number }).reads - before).toBeLessThanOrEqual(12);
  }, 30_000);
});
