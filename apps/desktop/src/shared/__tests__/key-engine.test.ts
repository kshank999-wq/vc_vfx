import { describe, expect, it } from 'vitest';
import { keyProblemReasons, type KeyLink } from '@vcvfx/domain';
import { CancelledError } from '../roto/engine';
import { buildScreenModel, evalScreenModel, flatScreenModel, localScreen, modelSeen, pullPush, screenGain } from '../key/cleanplate';
import { despill, hueSat, type DespillOptions } from '../key/despill';
import { analysisFrames, detectShotScreen, runKey, shotScreenModel, ShotKeyer, type KeyIO } from '../key/engine';
import { keyFrame, keyerSettings } from '../key/keyer';
import { decodeInterleaved, toDisplay, workingSpace, type LinearImage } from '../key/linear';
import { applyMatch, backgroundNear, estimateMatch, lightWrap, matchSamples } from '../key/look';
import { combineMattes, rectMatte, resolveLinks, type ResolvedLink } from '../key/mattes';
import { detectScreen, sampleColour } from '../key/screen';
import { greenScreenScene } from '../key/synthetic';
import { accuracy, LUMA_AP1, regions, sceneIO, settingsFor } from './key-helpers';

const chroma = (c: readonly number[]) => {
  const s = c[0]! + c[1]! + c[2]!;
  return [c[0]! / s, c[1]! / s, c[2]! / s];
};

describe('screen colour', () => {
  for (const kind of ['green', 'blue'] as const) {
    it(`detects a ${kind} screen under uneven lighting, and which screen it is`, () => {
      const scene = greenScreenScene({ kind, frames: 8 });
      const est = detectScreen([scene.render(0), scene.render(4)], null);
      expect(est.kind).toBe(kind);
      const want = chroma(scene.colours.screen);
      const got = chroma(est.rgb);
      for (let c = 0; c < 3; c += 1) expect(Math.abs(got[c]! - want[c]!)).toBeLessThan(0.01);
      // The screen is lit from 0.57× to 1.3×: still one cluster, most of the frame.
      expect(est.coverage).toBeGreaterThan(0.75);
    });
  }

  it('samples the mean colour under the eyedropper', () => {
    const scene = greenScreenScene({ frames: 2, noise: 0 });
    const img = scene.render(0);
    const s = sampleColour(img, 20, 20, 3);
    const truth = scene.screen(0);
    const i = 3 * (20 * scene.width + 20);
    expect(s[1]).toBeCloseTo(truth[i + 1]!, 2);
  });
});

describe('clean plate', () => {
  it('models an unevenly lit screen to within 1 %, though the subject hides part of it', () => {
    const scene = greenScreenScene({ frames: 12 });
    const frames = analysisFrames(0, 11, 5).map((f) => scene.render(f));
    const model = buildScreenModel(frames, { kind: 'green', rgb: scene.colours.screen }, 32);
    const at = evalScreenModel(model, scene.width, scene.height);
    const truth = scene.screen(3);
    let err = 0;
    for (let i = 0; i < scene.width * scene.height; i += 1) err += Math.abs(at[3 * i + 1]! - truth[3 * i + 1]!) / truth[3 * i + 1]!;
    expect(err / (scene.width * scene.height)).toBeLessThan(0.01);
    expect(model.observed).toBeGreaterThan(0.8);
  });

  it('fills gaps by pull–push', () => {
    const v = Float32Array.from([1, 0, 0, 3]);
    const out = pullPush(v, Float32Array.from([1, 0, 0, 1]), 2, 2, 1);
    expect(out[0]).toBe(1);
    expect(out[3]).toBe(3);
    expect(out[1]).toBeCloseTo(2, 5);
  });
});

describe('key accuracy against ground truth', () => {
  for (const kind of ['green', 'blue'] as const) {
    it(`keys a ${kind} screen: background < 0.01, core > 0.99, edge MAE < 0.08`, async () => {
      const scene = greenScreenScene({ kind, frames: 12 });
      const io = sceneIO(scene);
      const det = await detectShotScreen(io, analysisFrames(0, 11, 3), null);
      const s = settingsFor(det.kind, det.rgb);
      const keyer = new ShotKeyer(s, await shotScreenModel(io, s, 0, 11));
      for (const f of [1, 5, 9]) {
        const out = await keyer.keyAt(io, f, await io.frame(f), { pxScale: 1, luma: LUMA_AP1, foreground: false });
        const acc = accuracy(out.alpha, scene.alpha(f), scene.width, scene.height);
        expect(acc.bg).toBeLessThan(0.01);
        expect(acc.core).toBeGreaterThan(0.99);
        expect(acc.edgeMae).toBeLessThan(0.08);
        expect(acc.counts.edge).toBeGreaterThan(1500); // hair, halo, motion blur and edges are really measured
      }
    }, 30_000);
  }

  it('the clean plate is what keeps an unevenly lit screen clean', async () => {
    const scene = greenScreenScene({ frames: 12 });
    const io = sceneIO(scene);
    // The screen's own detail on each frame would mend the flat key too: this is about the model.
    const flat = settingsFor('green', [0.063, 0.457, 0.097]);
    flat.params = { ...flat.params, cleanPlate: false, screenDetail: false };
    const plate = settingsFor('green', [0.063, 0.457, 0.097]);
    plate.params = { ...plate.params, screenDetail: false };
    const a = await new ShotKeyer(flat, await shotScreenModel(io, flat, 0, 11)).keyAt(io, 4, await io.frame(4), { pxScale: 1, luma: LUMA_AP1, foreground: false });
    const b = await new ShotKeyer(plate, await shotScreenModel(io, plate, 0, 11)).keyAt(io, 4, await io.frame(4), { pxScale: 1, luma: LUMA_AP1, foreground: false });
    const accA = accuracy(a.alpha, scene.alpha(4), scene.width, scene.height);
    const accB = accuracy(b.alpha, scene.alpha(4), scene.width, scene.height);
    expect(accA.bg).toBeGreaterThan(0.02);
    expect(accB.bg).toBeLessThan(accA.bg / 10);
    expect(b.metrics.residual).toBeLessThan(a.metrics.residual);
  });

  it('edge refinement is what recovers hair and motion blur', async () => {
    const scene = greenScreenScene({ frames: 12, spill: 0 });
    const io = sceneIO(scene);
    const s = settingsFor('green', [0.063, 0.457, 0.097]);
    const model = await shotScreenModel(io, s, 0, 11);
    const without = { ...s, params: { ...s.params, edgeDetail: 0 } };
    const r1 = await new ShotKeyer(without, model).keyAt(io, 2, await io.frame(2), { pxScale: 1, luma: LUMA_AP1, foreground: false });
    const r2 = await new ShotKeyer(s, model).keyAt(io, 2, await io.frame(2), { pxScale: 1, luma: LUMA_AP1, foreground: false });
    const e1 = accuracy(r1.alpha, scene.alpha(2), scene.width, scene.height).edgeMae;
    const e2 = accuracy(r2.alpha, scene.alpha(2), scene.width, scene.height).edgeMae;
    expect(e2).toBeLessThan(e1 * 0.5);
  });

  it('is deterministic: the same frame and settings give the same matte and foreground, bit for bit', async () => {
    const scene = greenScreenScene({ frames: 6 });
    const io = sceneIO(scene);
    const s = settingsFor('green', [0.063, 0.457, 0.097]);
    const run = async () => (await new ShotKeyer(s, await shotScreenModel(io, s, 0, 5)).keyAt(io, 3, scene.render(3), { pxScale: 1, luma: LUMA_AP1, foreground: true }));
    const a = await run();
    const b = await run();
    expect(Buffer.from(a.alpha.buffer).equals(Buffer.from(b.alpha.buffer))).toBe(true);
    expect(Buffer.from(a.fg!.buffer).equals(Buffer.from(b.fg!.buffer))).toBe(true);
    expect(a.metrics).toEqual(b.metrics);
  });
});

describe('the screen in detail on each frame (addendum 16)', () => {
  // A real screen: cloth folds finer than the clean-plate grid (a 16 px period at 640 px, 25 % deep),
  // a subject crossing it — a red disc, or a costume the screen's bounce has made screen-coloured
  // (35 % of the screen's brightness, the screen's chromaticity).
  const W = 640;
  const H = 360;
  const S = [0.063, 0.457, 0.097] as const;
  const fold = (x: number) => 1 - 0.25 * Math.max(0, Math.sin((2 * Math.PI * x) / 16)) ** 3;
  const scene = (subject: readonly [number, number, number]) => {
    const alpha = (n: number) => {
      const a = new Float32Array(W * H);
      const cx = 120 + 40 * n;
      for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) a[y * W + x] = Math.max(0, Math.min(1, 70.5 - Math.hypot(x - cx, y - 180)));
      return a;
    };
    const render = (n: number): LinearImage => {
      const a = alpha(n);
      const data = new Float32Array(W * H * 3);
      for (let i = 0; i < W * H; i += 1) {
        const f = fold(i % W);
        for (let c = 0; c < 3; c += 1) data[3 * i + c] = a[i]! * subject[c]! + (1 - a[i]!) * S[c]! * f;
      }
      return { width: W, height: H, data };
    };
    const io: KeyIO = { frame: async (n) => render(n), roto: async () => null, background: async () => null };
    return { alpha, io };
  };
  const key = async (subject: readonly [number, number, number], screenDetail: boolean) => {
    const { alpha, io } = scene(subject);
    const s = settingsFor('green', [...S]);
    s.params = { ...s.params, screenDetail };
    const out = await new ShotKeyer(s, await shotScreenModel(io, s, 0, 10)).keyAt(io, 5, await io.frame(5), { pxScale: 1, luma: LUMA_AP1, foreground: false });
    return { out, acc: accuracy(out.alpha, alpha(5), W, H) };
  };

  it('keys the folds of the cloth out, which the clean-plate model is too coarse to hold', async () => {
    const without = await key([0.4, 0.06, 0.05], false);
    const detail = await key([0.4, 0.06, 0.05], true);
    expect(without.acc.bg).toBeGreaterThan(0.03);
    expect(detail.acc.bg).toBeLessThan(0.01);
    expect(detail.acc.bg).toBeLessThan(without.acc.bg / 4);
    expect(detail.acc.core).toBeGreaterThan(0.99);
    // A light going out is still told from the shot's screen, not from the frame's own detail.
    expect(detail.out.metrics.residual).toBeGreaterThan(0.02);
  }, 30_000);

  it('never takes a costume the bounce has made screen-coloured for the screen', async () => {
    const dim: [number, number, number] = [S[0] * 0.35, S[1] * 0.35, S[2] * 0.35];
    const without = await key(dim, false);
    const detail = await key(dim, true);
    expect(detail.acc.core).toBeGreaterThanOrEqual(without.acc.core - 0.01);
    expect(detail.acc.core).toBeGreaterThan(0.95);
    // Unguarded, the same pixels would have been the screen: the key there falls to nothing.
    const img = await scene(dim).io.frame(5);
    const loose = localScreen(img, evalScreenModel(flatScreenModel([...S]), W, H), 'green', { maxKey: 1 });
    const c = 3 * (180 * W + 320);
    expect(loose[c + 1]! / img.data[c + 1]!).toBeCloseTo(1, 1);
  }, 30_000);

  it('measures the gain only where the model saw the screen', () => {
    // A green card in the middle of the frame; outside it, grass of the same chromaticity, twice as bright.
    const card = (x: number, y: number) => x > 240 && x < 400 && y > 100 && y < 260;
    const img: LinearImage = { width: W, height: H, data: new Float32Array(W * H * 3) };
    for (let y = 0; y < H; y += 1)
      for (let x = 0; x < W; x += 1) for (let c = 0; c < 3; c += 1) img.data[3 * (y * W + x) + c] = S[c]! * (card(x, y) ? 1 : 2);
    const model = buildScreenModel([img], { kind: 'green', rgb: [...S] }, 64);
    // The model saw the card (and the grass, which it was told is not screen by brightness only after the first pass).
    const seen = modelSeen({ ...model, support: model.support!.map((v, i) => (card(((i % 64) + 0.5) * 10, (Math.floor(i / 64) + 0.5) * (H / model.gh)) ? v : 0)) }, W, H);
    const flatModel = evalScreenModel(flatScreenModel([...S]), W, H);
    expect(screenGain(img, flatModel, { kind: 'green', rgb: [...S] })[1]).toBeGreaterThan(1.5);
    expect(screenGain(img, flatModel, { kind: 'green', rgb: [...S] }, seen)[1]).toBeCloseTo(1, 2);
  });
});

describe('garbage, holdout and repair', () => {
  const w = 4;
  const h = 1;
  const link = (kind: ResolvedLink['kind'], matte: number[], o: Partial<ResolvedLink> = {}): ResolvedLink => ({ kind, mode: 'replace', invert: false, matte: Float32Array.from(matte), region: null, ...o });
  const key = Float32Array.from([0.2, 0.9, 0.5, 0]);

  it('garbage: outside is transparent; inverted: inside is', () => {
    expect([...combineMattes(key, [link('garbage', [1, 1, 0, 0])])].map((v) => +v.toFixed(3))).toEqual([0.2, 0.9, 0, 0]);
    expect([...combineMattes(key, [link('garbage', [1, 0, 0, 0], { invert: true })])].map((v) => +v.toFixed(3))).toEqual([0, 0.9, 0.5, 0]);
    // Two garbage mattes keep their union.
    expect([...combineMattes(key, [link('garbage', [1, 0, 0, 0]), link('garbage', [0, 0, 1, 0])])].map((v) => +v.toFixed(3))).toEqual([0.2, 0, 0.5, 0]);
  });

  it('holdout: inside is solid, even outside the garbage', () => {
    expect([...combineMattes(key, [link('garbage', [1, 1, 0, 0]), link('holdout', [0, 0, 1, 0.5])])].map((v) => +v.toFixed(3))).toEqual([0.2, 0.9, 1, 0.5]);
  });

  it('repair: replace, max and min inside the region only', () => {
    const roto = [1, 0.3, 0.8, 1];
    const region = Float32Array.from([1, 1, 0, 0.5]);
    expect([...combineMattes(key, [link('repair', roto, { region })])].map((v) => +v.toFixed(3))).toEqual([1, 0.3, 0.5, 0.5]);
    expect([...combineMattes(key, [link('repair', roto, { region, mode: 'max' })])].map((v) => +v.toFixed(3))).toEqual([1, 0.9, 0.5, 0.5]);
    expect([...combineMattes(key, [link('repair', roto, { region, mode: 'min' })])].map((v) => +v.toFixed(3))).toEqual([0.2, 0.3, 0.5, 0]);
    // Repairs come first, then garbage, then holdout.
    expect([...combineMattes(key, [link('holdout', [0, 0, 0, 1]), link('garbage', [0, 1, 1, 1]), link('repair', roto, { region })])].map((v) => +v.toFixed(3))).toEqual([0, 0.3, 0.5, 1]);
  });

  it('resolves boxes (plate pixels, scaled) and roto parts, on their frames only', () => {
    const links: KeyLink[] = [
      { id: 'l1', kind: 'garbage', label: '', source: { type: 'rect', rect: { x0: 0, y0: 0, x1: 40, y1: 40 } }, invert: false, mode: 'replace', growPx: 0, softnessPx: 0, region: null, frames: null, enabled: true },
      { id: 'l2', kind: 'holdout', label: '', source: { type: 'roto', partId: 'arm' }, invert: false, mode: 'replace', growPx: 0, softnessPx: 0, region: null, frames: { first: 10, last: 20 }, enabled: true },
      { id: 'l3', kind: 'repair', label: '', source: { type: 'roto', partId: 'arm' }, invert: false, mode: 'max', growPx: 4, softnessPx: 0, region: null, frames: null, enabled: false },
    ];
    const arm = new Float32Array(10 * 10).fill(0);
    arm[55] = 1;
    const r = resolveLinks(links, 12, { width: 10, height: 10, pxScale: 4, roto: () => arm });
    expect(r.map((l) => l.kind)).toEqual(['garbage', 'holdout']);
    // The 40 × 40 plate box is 10 × 10 key pixels: all inside.
    expect(Math.min(...r[0]!.matte)).toBe(1);
    expect(r[1]!.matte[55]).toBe(1);
    expect(resolveLinks(links, 30, { width: 10, height: 10, pxScale: 4, roto: () => arm }).map((l) => l.kind)).toEqual(['garbage']);
    // A roto garbage matte with no matte on the frame keeps nothing.
    const g: KeyLink = { ...links[1]!, kind: 'garbage', frames: null };
    expect(Math.max(...resolveLinks([g], 1, { width: 10, height: 10, pxScale: 1, roto: () => null })[0]!.matte)).toBe(0);
    expect(rectMatte({ x0: 2, y0: 2, x1: 4, y1: 4 }, 6, 6, 1)[3 * 6 + 3]).toBe(1);
  });

  it('a holdout from roto rescues a green prop the key made transparent; a repair restores it', async () => {
    const scene = greenScreenScene({ frames: 4 });
    const io = sceneIO(scene);
    const s = settingsFor('green', [0.063, 0.457, 0.097]);
    const model = await shotScreenModel(io, s, 0, 3);
    // A screen-green prop painted over the torso: the key goes transparent there.
    const img = await io.frame(1);
    const truth = scene.alpha(1);
    const prop = new Float32Array(scene.width * scene.height);
    const { core } = regions(truth, scene.width, scene.height);
    const centre = core[Math.floor(core.length * 0.7)]!;
    const cx = centre % scene.width;
    const cy = Math.floor(centre / scene.width);
    for (let y = cy - 6; y <= cy + 6; y += 1) for (let x = cx - 6; x <= cx + 6; x += 1) {
      const i = y * scene.width + x;
      if (truth[i]! < 1) continue;
      prop[i] = 1;
      img.data[3 * i] = 0.06;
      img.data[3 * i + 1] = 0.45;
      img.data[3 * i + 2] = 0.1;
    }
    const plain = await new ShotKeyer(s, model).keyAt(io, 1, img, { pxScale: 1, luma: LUMA_AP1, foreground: false });
    const holeBefore = [...prop.keys()].filter((i) => prop[i]).reduce((a, i) => a + plain.alpha[i]!, 0) / prop.reduce((a, v) => a + v, 0);
    expect(holeBefore).toBeLessThan(0.5);
    expect(plain.metrics.holes).toBe(0); // a screen-coloured hole cannot be told from screen by itself…
    const roto = { subject: () => truth.map((v) => (v >= 0.5 ? 1 : 0)) };
    const repaired = { ...s, links: [{ id: 'l1', kind: 'repair' as const, label: '', source: { type: 'roto' as const, partId: 'subject' }, invert: false, mode: 'max' as const, growPx: 0, softnessPx: 0, region: null, frames: null, enabled: true }] };
    const out = await new ShotKeyer(repaired, model).keyAt(sceneIO(scene, roto), 1, img, { pxScale: 1, luma: LUMA_AP1, foreground: false });
    const holeAfter = [...prop.keys()].filter((i) => prop[i]).reduce((a, i) => a + out.alpha[i]!, 0) / prop.reduce((a, v) => a + v, 0);
    expect(holeAfter).toBeGreaterThan(0.99); // …which is why the repair is painted with roto
  });
});

describe('despill', () => {
  const base: DespillOptions = { kind: 'green', limit: 'average', weight: 0.5, strength: 1, restore: 'neutral', restoreAmount: 1, protectSkin: true, protect: [], luma: LUMA_AP1 };
  const one = (rgb: [number, number, number], o: Partial<DespillOptions> = {}, bg: [number, number, number] | null = null) => [...despill(Float32Array.from(rgb), Float32Array.from([1]), { ...base, ...o }, bg ? Float32Array.from(bg) : null).out];

  it('removes spill on the pixels it was added to (scene), and keeps luminance', async () => {
    const scene = greenScreenScene({ frames: 4 });
    const io = sceneIO(scene, {}, false);
    const s = settingsFor('green', [0.063, 0.457, 0.097]);
    s.despill = { ...s.despill, restore: 'neutral' };
    const out = await new ShotKeyer(s, await shotScreenModel(io, s, 0, 3)).keyAt(io, 2, await io.frame(2), { pxScale: 1, luma: LUMA_AP1, foreground: true });
    const truthA = scene.alpha(2);
    const truthFg = scene.foreground(2);
    const added = scene.spillAdded(2);
    const { core } = regions(truthA, scene.width, scene.height);
    // The most-spilled core pixels.
    const spilled = core.filter((i) => added[3 * i + 1]! > 0.03);
    expect(spilled.length).toBeGreaterThan(100);
    const excess = (r: number, g: number, b: number) => g - 0.5 * (r + b);
    let before = 0;
    let after = 0;
    for (const i of spilled) {
      const P = (c: number) => truthFg[3 * i + c]! + added[3 * i + c]!;
      before += Math.max(0, excess(P(0), P(1), P(2)) - Math.max(0, excess(truthFg[3 * i]!, truthFg[3 * i + 1]!, truthFg[3 * i + 2]!)));
      after += Math.max(0, excess(out.fg![3 * i]!, out.fg![3 * i + 1]!, out.fg![3 * i + 2]!) - Math.max(0, excess(truthFg[3 * i]!, truthFg[3 * i + 1]!, truthFg[3 * i + 2]!)));
    }
    expect(after).toBeLessThan(before * 0.1);
    // Neutral restore puts the removed luminance back.
    const [r, g, b] = one([0.2, 0.4, 0.2]);
    expect(LUMA_AP1[0] * r! + LUMA_AP1[1] * g! + LUMA_AP1[2] * b!).toBeCloseTo(LUMA_AP1[0] * 0.2 + LUMA_AP1[1] * 0.4 + LUMA_AP1[2] * 0.2, 6);
    expect(g! - 0.5 * (r! + b!)).toBeCloseTo(0, 6);
  });

  it('limits: average, max, min, weighted; blue screens limit blue', () => {
    expect(one([0.2, 0.5, 0.4], { restore: 'none' }).map((v) => +v.toFixed(3))).toEqual([0.2, 0.3, 0.4]);
    expect(one([0.2, 0.5, 0.4], { restore: 'none', limit: 'max' })[1]).toBeCloseTo(0.4, 6);
    expect(one([0.2, 0.5, 0.4], { restore: 'none', limit: 'min', protectSkin: false })[1]).toBeCloseTo(0.2, 6);
    expect(one([0.2, 0.5, 0.4], { restore: 'none', limit: 'weighted', weight: 1 })[1]).toBeCloseTo(0.2, 6);
    expect(one([0.2, 0.3, 0.6], { restore: 'none', kind: 'blue' })[2]).toBeCloseTo(0.25, 6);
    // No spill: untouched.
    expect(one([0.5, 0.3, 0.2]).map((v) => +v.toFixed(3))).toEqual([0.5, 0.3, 0.2]);
  });

  it('leaves protected colours unchanged, and never limits skin harder than the average', () => {
    const jacket: [number, number, number] = [0.1, 0.32, 0.06];
    const plain = one(jacket);
    expect(Math.abs(plain[1]! - jacket[1])).toBeGreaterThan(0.05);
    const kept = one(jacket, { protect: [{ rgb: [0.12, 0.33, 0.08], hueTolerance: 12 }] });
    kept.forEach((v, c) => expect(Math.abs(v - jacket[c]!)).toBeLessThan(1e-6));
    // Skin with a little spill, under the hard "min" limit.
    const skin: [number, number, number] = [0.55, 0.38, 0.27];
    const hard = one(skin, { limit: 'min', protectSkin: false, restore: 'none' });
    const safe = one(skin, { limit: 'min', protectSkin: true, restore: 'none' });
    expect(hard[1]).toBeCloseTo(0.27, 5);
    expect(safe[1]).toBeCloseTo(0.38, 5); // average limit (0.41) leaves it as it was
    expect(hueSat(...(safe as [number, number, number]))[0]).toBeCloseTo(hueSat(...skin)[0], 3);
  });

  it('with a background reference, the edge takes the background’s colour instead of grey', async () => {
    const scene = greenScreenScene({ frames: 4 });
    const io = sceneIO(scene);
    const run = async (restore: 'neutral' | 'background') => {
      const s = settingsFor('green', [0.063, 0.457, 0.097]);
      s.despill = { ...s.despill, restore };
      return new ShotKeyer(s, await shotScreenModel(io, s, 0, 3)).keyAt(io, 2, await io.frame(2), { pxScale: 1, luma: LUMA_AP1, foreground: true });
    };
    const neutral = await run('neutral');
    const withBg = await run('background');
    const near = backgroundNear(scene.background, 20);
    let dN = 0;
    let dB = 0;
    let count = 0;
    for (let i = 0; i < neutral.alpha.length; i += 1) {
      if (!(neutral.spill![i]! > 0.01)) continue;
      const a = neutral.alpha[i]!;
      const bgC = chroma([near[3 * i]!, near[3 * i + 1]!, near[3 * i + 2]!]);
      const cN = chroma([neutral.fg![3 * i]! / a, neutral.fg![3 * i + 1]! / a, neutral.fg![3 * i + 2]! / a]);
      const cB = chroma([withBg.fg![3 * i]! / a, withBg.fg![3 * i + 1]! / a, withBg.fg![3 * i + 2]! / a]);
      dN += Math.hypot(cN[0]! - bgC[0]!, cN[2]! - bgC[2]!);
      dB += Math.hypot(cB[0]! - bgC[0]!, cB[2]! - bgC[2]!);
      count += 1;
    }
    expect(count).toBeGreaterThan(200);
    expect(dB / count).toBeLessThan(dN / count);
    // The matte is the same either way: despill never touches alpha.
    expect(Buffer.from(neutral.alpha.buffer).equals(Buffer.from(withBg.alpha.buffer))).toBe(true);
  });
});

describe('background match and light wrap', () => {
  it('recovers a known per-channel gain and offset', () => {
    const fg: number[] = [];
    const bg: number[] = [];
    let s = 1;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const gain = [1.3, 0.9, 0.7];
    const offset = [0.02, -0.01, 0.03];
    for (let i = 0; i < 2000; i += 1) {
      const v = [0.05 + 0.6 * rnd(), 0.05 + 0.4 * rnd(), 0.05 + 0.3 * rnd()];
      fg.push(...v);
      // A different sample of the same distribution, transformed: the match is of statistics, not pixel pairs.
      const u = [0.05 + 0.6 * rnd(), 0.05 + 0.4 * rnd(), 0.05 + 0.3 * rnd()];
      bg.push(...u.map((x, c) => gain[c]! * x + offset[c]!));
    }
    const m = estimateMatch(fg, bg, LUMA_AP1);
    // Different samples of the distribution: within sampling error.
    m.gain.forEach((g, c) => expect(Math.abs(g - gain[c]!) / gain[c]!).toBeLessThan(0.1));
    m.offset.forEach((o, c) => expect(Math.abs(o - offset[c]!)).toBeLessThan(0.03));
    expect(m.confidence).toBe(1);
    // Exactly, when the background samples are the transformed foreground samples.
    const exact = estimateMatch(fg, fg.map((x, i) => gain[i % 3]! * x + offset[i % 3]!), LUMA_AP1);
    exact.gain.forEach((g, c) => expect(g).toBeCloseTo(gain[c]!, 9));
    exact.offset.forEach((o, c) => expect(o).toBeCloseTo(offset[c]!, 9));
    // Applied at strength 0 it changes nothing (a suggestion, previewed).
    const f = Float32Array.from([0.1, 0.2, 0.3]);
    expect([...applyMatch(f, Float32Array.from([1]), exact, 0)]).toEqual([...f]);
  });

  it('estimates a match on the scene from the edge bands', async () => {
    const scene = greenScreenScene({ frames: 4 });
    const io = sceneIO(scene);
    const s = settingsFor('green', [0.063, 0.457, 0.097]);
    const out = await new ShotKeyer(s, await shotScreenModel(io, s, 0, 3)).keyAt(io, 1, await io.frame(1), { pxScale: 1, luma: LUMA_AP1, foreground: true });
    const sm = matchSamples(out.fg!, out.alpha, scene.background, 12);
    const m = estimateMatch(sm.fg, sm.bg, LUMA_AP1);
    expect(m.samples.foreground).toBeGreaterThan(200);
    expect(m.samples.background).toBeGreaterThan(200);
    // The night street is darker than the lit subject.
    expect(m.exposureStops).toBeLessThan(0);
  });

  it('light wrap is bounded and edge-local', async () => {
    const scene = greenScreenScene({ frames: 4 });
    const alpha = scene.alpha(1);
    const o = { width: 8, intensity: 0.6, lumaWeight: 0.5, luma: LUMA_AP1 };
    const wrap = lightWrap(alpha, scene.background, o);
    let maxBg = 0;
    for (const v of scene.background.data) maxBg = Math.max(maxBg, v);
    const { bg } = regions(alpha, scene.width, scene.height);
    const bin = Uint8Array.from(alpha, (v) => (v >= 0.999 ? 1 : 0));
    const { signedDistance } = await import('../roto/image');
    const sd = signedDistance(bin, scene.width, scene.height, 40);
    let inside = 0;
    let deep = 0;
    let maxWrap = 0;
    for (let i = 0; i < alpha.length; i += 1) {
      const v = Math.max(wrap[3 * i]!, wrap[3 * i + 1]!, wrap[3 * i + 2]!);
      maxWrap = Math.max(maxWrap, v);
      if (alpha[i] === 0) expect(v).toBe(0);
      if (sd[i]! < -1 && sd[i]! > -4) inside = Math.max(inside, v);
      if (sd[i]! < -30) deep = Math.max(deep, v);
    }
    expect(bg.length).toBeGreaterThan(0);
    expect(maxWrap).toBeLessThanOrEqual(o.intensity * (1 + o.lumaWeight) * maxBg + 1e-6);
    expect(inside).toBeGreaterThan(0.005);
    expect(deep).toBeLessThan(inside * 0.02);
  });
});

describe('processing a shot', () => {
  it('flags an injected bad frame (half the screen light goes out)', async () => {
    const scene = greenScreenScene({ frames: 16, badFrame: 9, width: 320, height: 180 });
    const io = sceneIO(scene);
    const s = settingsFor('green', [0.063, 0.457, 0.097]);
    const keyer = new ShotKeyer(s, await shotScreenModel(io, s, 0, 15));
    const result = await runKey(io, keyer, { first: 0, last: 15 }, { pxScale: 1, luma: LUMA_AP1, revision: 3 }, () => undefined);
    expect(result.frames).toHaveLength(16);
    expect(result.revision).toBe(3);
    const reasons = keyProblemReasons(result.frames);
    expect([...reasons.entries()].filter(([, r]) => r).map(([f]) => f)).toEqual([9]);
    expect(result.frames.find((f) => f.frame === 9)!.confidence).toBeLessThan(0.6);
    expect(Math.min(...result.frames.filter((f) => f.frame !== 9).map((f) => f.confidence))).toBeGreaterThan(0.9);
  }, 30_000);

  it('stops between frames when cancelled', async () => {
    const scene = greenScreenScene({ frames: 10, width: 160, height: 90 });
    const controller = new AbortController();
    const io = { ...sceneIO(scene), signal: controller.signal, progress: (done: number) => (done === 2 ? controller.abort() : undefined) };
    const s = settingsFor('green', [0.063, 0.457, 0.097]);
    const keyer = new ShotKeyer(s, flatScreenModel(s.screen!.rgb));
    const seen: number[] = [];
    await expect(runKey(io, keyer, { first: 0, last: 9 }, { pxScale: 1, luma: LUMA_AP1, revision: 0 }, (f) => void seen.push(f))).rejects.toBeInstanceOf(CancelledError);
    expect(seen).toEqual([0, 1]);
  });
});

describe('linear light', () => {
  it('decodes log code values to ACEScg and keeps linear plates as they are', () => {
    const ws = workingSpace('arri_logc4_awg4');
    expect(ws).toMatchObject({ encoding: 'acescg', linear: true });
    expect(workingSpace('acescg')).toMatchObject({ encoding: 'acescg', toRec709: expect.any(Array) });
    expect(workingSpace(null)).toMatchObject({ encoding: null, linear: false });
    // LogC4 18 % grey code value decodes to ≈ 0.18 on every channel.
    const grey = 0.27811260;
    const img = decodeInterleaved(Float32Array.from([grey, grey, grey]), 1, 1, 'arri_logc4_awg4');
    for (const v of img.data) expect(v).toBeCloseTo(0.18, 2);
    const disp = toDisplay(img.data, 1, ws);
    expect(disp[0]).toBeGreaterThan(80);
    expect(disp[0]).toBeLessThan(160);
  });

  it('keys with the settings in plate pixels at any working size', () => {
    const k = keyerSettings('green', { ...settingsFor('green', [0.06, 0.45, 0.1]).params, coreErodePx: 8 }, 4);
    expect(k.coreErode).toBe(2);
    const scene = greenScreenScene({ frames: 2, width: 160, height: 90 });
    const img = scene.render(0);
    const out = keyFrame({ image: img, screen: evalScreenModel(flatScreenModel([0.063, 0.457, 0.097]), 160, 90), settings: k, matteOnly: true });
    expect(out.fg).toBeNull();
    expect(out.alpha.length).toBe(160 * 90);
  });
});
