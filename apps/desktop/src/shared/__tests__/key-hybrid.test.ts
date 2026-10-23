import { describe, expect, it } from 'vitest';
import { analysisFrames, detectShotScreen, shotScreenModel, ShotKeyer, type KeyIO, type KeySettings } from '../key/engine';
import { keyTexture, shadowPass, subjectPrior } from '../key/subject';
import { greenScreenScene, type GreenScreenScene } from '../key/synthetic';
import { morph } from '../roto/image';
import { accuracy, LUMA_AP1, sceneIO, settingsFor } from './key-helpers';

/**
 * The hybrid key (addendum 18): a subject segmentation as the core prior, and
 * the shadow pass — against a synthetic reproduction of the real-footage
 * failure (addendum 16): a white suit lit by the green floor's bounce to the
 * screen's own chromaticity at 40 % of its brightness, a deep cast shadow on
 * the floor beside it (also 40 %), hair strands and a motion-blurred arm.
 */

type Sloppy = 'truth' | 'dilated' | 'eroded' | 'shifted';

function segmentation(scene: GreenScreenScene, f: number, how: Sloppy): Float32Array {
  const { width: w, height: h } = scene;
  const a = scene.alpha(f);
  const b = new Uint8Array(w * h);
  for (let i = 0; i < b.length; i += 1) b[i] = a[i]! >= 0.5 ? 1 : 0;
  let m: Uint8Array = b;
  if (how === 'dilated') m = morph(b, w, h, 6);
  if (how === 'eroded') m = morph(b, w, h, -6);
  if (how === 'shifted') {
    m = new Uint8Array(w * h);
    for (let y = 0; y < h; y += 1) for (let x = 6; x < w; x += 1) m[y * w + x] = b[y * w + x - 6]!;
  }
  return Float32Array.from(m);
}

async function keyWith(scene: GreenScreenScene, frames: number[], o: { subject: Sloppy | null; shadow: boolean; confidence?: number }) {
  const io: KeyIO = { ...sceneIO(scene), subject: async (f) => (o.subject ? { matte: segmentation(scene, f, o.subject), confidence: o.confidence ?? 0.95 } : null) };
  const det = await detectShotScreen(io, analysisFrames(0, scene.frames - 1, 3), null);
  const s: KeySettings = settingsFor(det.kind, det.rgb);
  s.params = { ...s.params, shadowPass: o.shadow };
  s.subject = { source: o.subject ? 'auto' : 'none', partId: null, marginPx: 4, outside: true };
  const keyer = new ShotKeyer(s, await shotScreenModel(io, s, 0, scene.frames - 1));
  const out = [];
  for (const f of frames) out.push({ f, r: await keyer.keyAt(io, f, await io.frame(f), { pxScale: 1, luma: LUMA_AP1, foreground: true }) });
  return out;
}

/** Mean alpha over the suit, over the cast shadow (where there is no subject), and the shadow matte's error there. */
function measure(scene: GreenScreenScene, f: number, alpha: Float32Array, shadow: Float32Array | null) {
  const suit = scene.suit(f);
  const truth = scene.alpha(f);
  const sh = scene.shadow(f);
  let sn = 0;
  let sa = 0;
  let hn = 0;
  let ha = 0;
  let he = 0;
  for (let i = 0; i < suit.length; i += 1) {
    if (suit[i] === 1) {
      sn += 1;
      sa += alpha[i]!;
    }
    if (sh[i]! > 0.3 && truth[i] === 0) {
      hn += 1;
      ha += alpha[i]!;
      he += Math.abs((shadow?.[i] ?? 0) - sh[i]!);
    }
  }
  return { suit: sa / sn, shadowAlpha: ha / hn, shadowError: he / hn, acc: accuracy(alpha, truth, scene.width, scene.height) };
}

describe('the hybrid key: a subject segmentation as the core prior', () => {
  const astronaut = greenScreenScene({ frames: 12, screenLitSuit: 0.4, castShadow: 0.6, travel: 0.25 });

  it('reproduces the failure: without a prior the screen-lit suit keys part-transparent and the deep shadow stays in', async () => {
    const [a] = await keyWith(astronaut, [5], { subject: null, shadow: false });
    const m = measure(astronaut, 5, a!.r.alpha, null);
    expect(m.suit).toBeLessThan(0.6);
    expect(m.shadowAlpha).toBeGreaterThan(0.1);
  }, 60_000);

  it('with the segmentation the suit is solid, the shadow leaves the alpha and is recovered as its own matte', async () => {
    for (const { f, r } of await keyWith(astronaut, [1, 5], { subject: 'truth', shadow: true })) {
      const m = measure(astronaut, f, r.alpha, r.shadow);
      expect(m.acc.core).toBeGreaterThan(0.98);
      expect(m.suit).toBeGreaterThan(0.9);
      expect(m.acc.bg).toBeLessThan(0.005);
      expect(m.shadowAlpha).toBeLessThan(0.01);
      // Density 0.6 (the screen at 40 %) recovered within 0.05 on average.
      expect(m.shadowError).toBeLessThan(0.05);
      expect(r.metrics.shadow).toBeGreaterThan(0.01);
      expect(r.metrics.subjectConfidence).toBeGreaterThan(0.9);
      // No colour in the shadow: the foreground is zero where the alpha is.
      const sh = astronaut.shadow(f);
      for (let i = 0; i < sh.length; i += 1) if (sh[i]! > 0.3 && r.alpha[i] === 0) expect(r.fg![3 * i]! + r.fg![3 * i + 1]! + r.fg![3 * i + 2]!).toBe(0);
    }
  }, 120_000);

  it('is robust to a sloppy segmentation: dilated, eroded or shifted by 6 px it is never worse than no prior', async () => {
    const [none] = await keyWith(astronaut, [5], { subject: null, shadow: true });
    const base = measure(astronaut, 5, none!.r.alpha, none!.r.shadow);
    for (const how of ['dilated', 'eroded', 'shifted'] as const) {
      const [r] = await keyWith(astronaut, [5], { subject: how, shadow: true });
      const m = measure(astronaut, 5, r!.r.alpha, r!.r.shadow);
      expect(m.suit).toBeGreaterThan(base.suit + 0.2);
      expect(m.acc.core).toBeGreaterThan(base.acc.core);
      expect(m.acc.edgeMae).toBeLessThan(Math.max(base.acc.edgeMae * 1.2, base.acc.edgeMae + 0.012));
      expect(m.acc.bg).toBeLessThan(0.005);
      expect(m.shadowAlpha).toBeLessThan(0.05);
    }
  }, 240_000);

  it('does not cost the hair: on the hair shot the edge error with a segmentation (exact or sloppy) is within 5 % of the plain key', async () => {
    const scene = greenScreenScene({ frames: 12, spill: 0 });
    const frames = [1, 5, 9];
    const mean = (rs: { f: number; r: { alpha: Float32Array } }[]) => rs.reduce((s, { f, r }) => s + accuracy(r.alpha, scene.alpha(f), scene.width, scene.height).edgeMae, 0) / rs.length;
    const plain = mean(await keyWith(scene, frames, { subject: null, shadow: false }));
    expect(plain).toBeLessThan(0.035);
    for (const how of ['truth', 'eroded', 'shifted'] as const) {
      const e = mean(await keyWith(scene, frames, { subject: how, shadow: true }));
      expect(e).toBeLessThan(plain * 1.05 + 0.001);
    }
    // Dilated by 6 px over the hair, the hardest case for a prior.
    const dil = mean(await keyWith(scene, frames, { subject: 'dilated', shadow: true }));
    expect(dil).toBeLessThan(plain * 1.05 + 0.001);
  }, 240_000);

  it('a segmentation over clean screen is not trusted: it does not make the screen solid and the frame says why', async () => {
    const scene = greenScreenScene({ frames: 6, spill: 0 });
    const { width: w, height: h } = scene;
    const box = new Float32Array(w * h);
    for (let y = 10; y < 120; y += 1) for (let x = 330; x < 470; x += 1) box[y * w + x] = 1;
    const io: KeyIO = { ...sceneIO(scene), subject: async () => ({ matte: box, confidence: 0.9 }) };
    const s = settingsFor('green', [0.063, 0.457, 0.097]);
    s.subject = { source: 'auto', partId: null, marginPx: 4, outside: false };
    const keyer = new ShotKeyer(s, await shotScreenModel(io, s, 0, 5));
    const r = await keyer.keyAt(io, 2, await io.frame(2), { pxScale: 1, luma: LUMA_AP1, foreground: false });
    let mean = 0;
    let c = 0;
    for (let y = 30; y < 100; y += 1) for (let x = 350; x < 450; x += 1) if (scene.alpha(2)[y * w + x] === 0) {
      mean += r.alpha[y * w + x]!;
      c += 1;
    }
    expect(mean / c).toBeLessThan(0.02);
    expect(r.metrics.subjectDisagree).toBeGreaterThan(0.15);
    expect(r.metrics.subjectConfidence).toBeLessThan(0.1);
  }, 60_000);

  it('the artist’s holdout still wins outside the segmentation (garbage/holdout semantics kept)', async () => {
    const scene = astronaut;
    const { width: w } = scene;
    const io: KeyIO = { ...sceneIO(scene), subject: async (f) => ({ matte: segmentation(scene, f, 'truth'), confidence: 0.95 }) };
    const s = settingsFor('green', [0.063, 0.457, 0.097], {}, [{ id: 'l1', kind: 'holdout', label: '', source: { type: 'rect', rect: { x0: 5, y0: 5, x1: 25, y1: 25 } }, invert: false, mode: 'replace', growPx: 0, softnessPx: 0, region: null, frames: null, enabled: true }]);
    s.subject = { source: 'auto', partId: null, marginPx: 4, outside: true };
    const r = await new ShotKeyer(s, await shotScreenModel(io, s, 0, 11)).keyAt(io, 5, await io.frame(5), { pxScale: 1, luma: LUMA_AP1, foreground: false });
    expect(r.alpha[15 * w + 15]).toBe(1);
  }, 60_000);
});

describe('the subject prior and the shadow pass, unit by unit', () => {
  it('the core erodes further where the key shows hair, and confidence scales it', () => {
    const w = 64;
    const h = 64;
    const matte = new Float32Array(w * h);
    for (let y = 8; y < 56; y += 1) for (let x = 8; x < 56; x += 1) matte[y * w + x] = 1;
    // A flat costume inside (0.6), clean screen outside, hair-like alternation on the left.
    const raw = new Float32Array(w * h);
    for (let i = 0; i < raw.length; i += 1) raw[i] = matte[i] ? 0.6 : 0;
    for (let y = 0; y < h; y += 1) for (let x = 0; x < 24; x += 1) raw[y * w + x] = (x + y) % 2 ? 0.9 : 0.2;
    const t = keyTexture(raw, w, h, 3);
    expect(t[32 * w + 10]).toBeGreaterThan(0.5);
    expect(t[32 * w + 40]).toBeLessThan(0.1);
    const p = subjectPrior({ matte, confidence: 1, margin: 3, outside: true }, raw, w, h, 0.04);
    // 6 px inside: solid on the flat side, not yet on the hairy side.
    expect(p.core[32 * w + 49]).toBeGreaterThan(0.9);
    expect(p.core[32 * w + 14]).toBeLessThan(0.5);
    const half = subjectPrior({ matte, confidence: 0.5, margin: 3, outside: true }, raw, w, h, 0.04);
    expect(half.core[32 * w + 32]).toBeCloseTo(0.5, 5);
    // Outside: a soft garbage well away, full keep next to it.
    expect(p.keep[32 * w + 57]).toBe(1);
    expect(p.keep[0 * w + 40]).toBeLessThan(0.9);
  });

  it('shadow density is 1 − the luminance ratio to the clean screen, only on the screen’s chromaticity, and specks are dropped', () => {
    const w = 80;
    const h = 40;
    const clean = new Float32Array(w * h * 3);
    const P = new Float32Array(w * h * 3);
    for (let i = 0; i < w * h; i += 1) {
      clean.set([0.06, 0.4, 0.09], 3 * i);
      P.set([0.06, 0.4, 0.09], 3 * i);
    }
    // A shadow at 40 %; a red patch as dark (not the screen's chromaticity); a 1-pixel dark speck.
    for (let y = 10; y < 30; y += 1) for (let x = 10; x < 40; x += 1) P.set([0.024, 0.16, 0.036], 3 * (y * w + x));
    for (let y = 10; y < 30; y += 1) for (let x = 50; x < 70; x += 1) P.set([0.16, 0.05, 0.04], 3 * (y * w + x));
    P.set([0.02, 0.1, 0.03], 3 * (35 * w + 75));
    const d = shadowPass(P, clean, w, h, { kind: 'green', allowed: null, minArea: 20 });
    expect(d[20 * w + 25]).toBeCloseTo(0.6, 2);
    expect(d[20 * w + 60]).toBe(0);
    expect(d[35 * w + 75]).toBeLessThan(0.05);
    expect(d[2 * w + 2]).toBe(0);
  });
});
