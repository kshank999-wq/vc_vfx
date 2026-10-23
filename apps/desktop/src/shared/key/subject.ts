import type { ScreenKind } from '@vcvfx/domain';
import { areaDownscale, components, gaussianBlur, morph, resizePlane, squaredDistance } from '../roto/image';

/**
 * The subject prior and the shadow pass of the hybrid key (master spec §6
 * "green/blue key + hybrid roto"; addendum 18).
 *
 * A colour-difference key cannot tell a costume lit to the screen's
 * chromaticity by its bounce (the astronaut's suit) from a shadow on the
 * screen: both are the screen's colour at a fraction of its brightness, so both
 * key part-transparent. A subject segmentation (a roto part, or SAM 2 / Track
 * run on the shot) says which is which. It is used as a *prior*, never as the
 * matte:
 *
 *  - inside the segmentation, eroded by a margin, the core is solid whatever
 *    the colour (unless the key calls the pixel clean screen: a sloppy
 *    segmentation spilling over the screen does not make screen solid);
 *  - in the band round its edge the key decides, as without a prior (hair,
 *    motion blur stay soft) — the band widens where the key shows fine
 *    structure (hair), so a segmentation edge cutting through hair never
 *    chops it;
 *  - outside the segmentation, grown by a wider margin, it is a soft garbage
 *    matte (the off-screen light stands go), weighted by the segmentation's
 *    confidence. The artist's own garbage / holdout / repair mattes still
 *    apply after it, unchanged.
 *
 * The shadow pass: pixels of the screen's chromaticity darker than the clean
 * screen, outside the subject, are a cast shadow. Its density (1 − luminance
 * ratio to the clean screen) is a matte of its own; it is taken out of the
 * subject's alpha and handed to the compositor to multiply over the new
 * background.
 */

export interface SubjectInput {
  /** The segmentation, 0…1 at the key's size (≥ 0.5 is subject). */
  matte: Float32Array;
  /** 0…1: how far the segmentation is trusted on this frame (the engine's own confidence). */
  confidence: number;
  /** Erosion margin for the solid core, key pixels; the outside garbage starts at twice it. */
  margin: number;
  /** Whether outside the segmentation acts as a garbage matte. */
  outside: boolean;
  /**
   * Whether the segmentation may take things away (the outside garbage, the
   * shadow's removal). False for one made by Track: its colour models cannot
   * separate a costume the colour of the screen from the screen, so what it
   * leaves out may be the subject; it then only makes the core solid.
   */
  removes?: boolean;
}

export interface SubjectPrior {
  /** Binary segmentation. */
  inside: Uint8Array;
  /** 0…1: weight of the solid core (the eroded segmentation, adaptive, times confidence). */
  core: Float32Array;
  /** 1 where the core is deep enough inside that even a key reading of clean screen does not open it. */
  deep: Uint8Array;
  /** The key's fine structure (keyTexture), 0…1. */
  texture: Float32Array;
  /** 0…1: multiplier outside (1 inside and in the band; falls off beyond the outside margin). */
  keep: Float32Array;
  /** Distance inside the segmentation to its edge, key pixels (0 outside). */
  depth: Float32Array;
  /** Distance outside the segmentation, key pixels (0 inside). */
  outsideDistance: Float32Array;
  /** Confidence actually used (the input's, lowered when the segmentation covers clean screen). */
  confidence: number;
  /** 0…1: how far the outside garbage and the shadow's removal act (confidence 0.5 → 0, 0.8 → 1). */
  outsideWeight: number;
  /** Share of the solid core the key calls clean screen: segmentation over the screen. */
  disagree: number;
  /** Pixels of the segmentation. */
  area: number;
}

const clamp01 = (v: number) => (v <= 0 ? 0 : v >= 1 ? 1 : v);

/**
 * A wide Gaussian blur worked on a smaller copy (area-averaged by `f`, blurred
 * by σ/f, scaled back up bilinearly) — for smooth fields (how hairy the key is
 * nearby, a costume's colour) where a full-resolution wide blur would cost
 * seconds a frame at 2K for nothing visible.
 */
export function blurCoarse(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  const f = Math.max(1, Math.min(8, Math.floor(sigma / 2)));
  if (f <= 1) return gaussianBlur(src, w, h, sigma);
  const sw = Math.max(1, Math.round(w / f));
  const sh = Math.max(1, Math.round(h / f));
  const small = gaussianBlur(areaDownscale(src, w, h, sw, sh), sw, sh, sigma / f);
  return resizePlane(small, sw, sh, w, h);
}

/**
 * How much fine structure the key has near each pixel (0 flat … 1 hair): the
 * high-frequency part of the raw key, averaged over about the margin. Hair and
 * fly-aways are a fine alternation of key values; a suit, a shadow or a smooth
 * edge are not.
 */
export function keyTexture(raw: Float32Array, w: number, h: number, margin: number): Float32Array {
  const n = w * h;
  const clipped = new Float32Array(n);
  for (let i = 0; i < n; i += 1) clipped[i] = clamp01(raw[i]!);
  const low = gaussianBlur(clipped, w, h, 1.2);
  const hf = new Float32Array(n);
  for (let i = 0; i < n; i += 1) hf[i] = Math.abs(clipped[i]! - low[i]!);
  const t = blurCoarse(hf, w, h, Math.max(1.5, margin));
  for (let i = 0; i < n; i += 1) t[i] = clamp01(t[i]! / 0.04);
  return t;
}

/**
 * The prior on one frame. `raw` is the colour-difference key; `clipBlack` its
 * black point (below it the key calls the pixel clean screen).
 */
export function subjectPrior(input: SubjectInput, raw: Float32Array, w: number, h: number, clipBlack: number): SubjectPrior {
  const n = w * h;
  const inside = new Uint8Array(n);
  const outsideMask = new Uint8Array(n);
  let area = 0;
  for (let i = 0; i < n; i += 1) {
    if (input.matte[i]! >= 0.5) {
      inside[i] = 1;
      area += 1;
    } else outsideMask[i] = 1;
  }
  const m = Math.max(1, input.margin);
  const core = new Float32Array(n);
  const deep = new Uint8Array(n);
  const keep = new Float32Array(n).fill(1);
  const outsideDistance = new Float32Array(n);
  const depth = new Float32Array(n);
  if (!area) return { inside, core, deep, texture: new Float32Array(n), keep, depth, outsideDistance, confidence: 0, outsideWeight: 0, disagree: 0, area };
  const dIn = squaredDistance(outsideMask, w, h);
  const dOut = squaredDistance(inside, w, h);
  const tex = keyTexture(raw, w, h, m);
  // Ramps: a motion-blurred limb or a soft edge is a slope of the key, a screen-lit costume is flat.
  // A segmentation a few pixels too wide must not make a blur ramp solid.
  const sm = gaussianBlur(Float32Array.from(raw, (v) => clamp01(v)), w, h, 1);
  const slope = new Float32Array(n);
  for (let y = 1; y < h - 1; y += 1)
    for (let x = 1; x < w - 1; x += 1) {
      const i = y * w + x;
      slope[i] = Math.hypot(sm[i + 1]! - sm[i - 1]!, sm[i + w]! - sm[i - w]!) / 2;
    }
  // The core: deeper than the margin, more where the key shows hair.
  let coreN = 0;
  let coreClean = 0;
  for (let i = 0; i < n; i += 1) {
    if (!inside[i]) {
      outsideDistance[i] = Math.sqrt(dOut[i]!);
      continue;
    }
    const d = Math.sqrt(dIn[i]!);
    depth[i] = d;
    const need = m * (1 + 2 * tex[i]!);
    const wv = clamp01((d - need) / (0.5 * m) + 0.5) * (1 - clamp01((slope[i]! - 0.02) / 0.03));
    core[i] = wv;
    // Deep inside, a segmentation is not wrong by a few pixels: a clean-screen reading there is the
    // clean plate mistaking the costume for a shadowed screen, not the segmentation spilling over it.
    if (d > 3 * need) deep[i] = 1;
    if (wv >= 0.5) {
      coreN += 1;
      if (raw[i]! <= clipBlack && !deep[i]) coreClean += 1;
    }
  }
  const disagree = coreN ? coreClean / coreN : 0;
  // Segmentation over clean screen is a segmentation error: trust it less.
  const confidence = clamp01(input.confidence) * (1 - clamp01((disagree - 0.01) / 0.09));
  // Throwing things away on the segmentation's word needs a surer one than keeping them solid does:
  // the outside garbage (and the shadow's removal) fade in between confidence 0.5 and 0.8.
  const outsideWeight = input.removes === false ? 0 : clamp01((confidence - 0.5) / 0.3);
  for (let i = 0; i < n; i += 1) core[i] = core[i]! * confidence;
  if (input.outside) {
    // What the key itself joins to the subject — hair, a motion-blur tail, beyond a segmentation that
    // stops short — is kept up to `reach` from it: walked outward from the segmentation through pixels
    // the key calls at all (not clean screen). Things the key keys but that do not touch the subject
    // (an off-screen light stand) are not reached.
    // (Hair reaches further: the reach widens with the key's fine structure, and with the subject's size.)
    const reach = Math.max(6 * m, 0.2 * Math.sqrt(area));
    const solidReach = Math.max(reach, 0.75 * Math.sqrt(area));
    const joined = new Uint8Array(n);
    const queue = new Int32Array(n);
    let head = 0;
    let tail = 0;
    for (let i = 0; i < n; i += 1) if (inside[i]) {
      joined[i] = 1;
      queue[tail++] = i;
    }
    const floor = 0.5 * clipBlack;
    // Solid things a little apart from the subject (a gap of up to the margin: a head over a thin neck,
    // a hand past a gap of screen) are reached across that gap.
    const solid = new Uint8Array(n);
    for (let i = 0; i < n; i += 1) solid[i] = raw[i]! >= 0.8 ? 1 : 0;
    const bridge = morph(solid, w, h, Math.max(1, Math.round(m)));
    // Solid parts close to the subject (within a third of its size) are taken as its own even across
    // a wider gap — a hand or a head the segmentation left out — and what the key joins to them too.
    const near = Math.max(2 * m, 0.35 * Math.sqrt(area));
    for (let i = 0; i < n; i += 1)
      if (!joined[i] && solid[i] && outsideDistance[i]! <= near) {
        joined[i] = 1;
        queue[tail++] = i;
      }
    while (head < tail) {
      const i = queue[head++]!;
      const x = i % w;
      const y = (i - x) / w;
      for (let dy = -1; dy <= 1; dy += 1)
        for (let dx = -1; dx <= 1; dx += 1) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const j = yy * w + xx;
          if (joined[j] || (raw[j]! <= floor && !bridge[j])) continue;
          // What the key calls solid and touches the subject is the subject (a limb, a head the
          // segmentation missed), as far as a subject reaches; what it keys only softly, within `reach`.
          if (outsideDistance[j]! > (bridge[j] ? solidReach : reach * (1 + 2 * tex[j]!))) continue;
          joined[j] = 1;
          queue[tail++] = j;
        }
    }
    const joinedNear = morph(joined, w, h, 1);
    for (let i = 0; i < n; i += 1) {
      if (inside[i] || joinedNear[i]) continue;
      const need = 2 * m * (1 + 2 * tex[i]!);
      const fall = clamp01((outsideDistance[i]! - need) / m);
      keep[i] = 1 - outsideWeight * fall;
    }
  }
  return { inside, core, deep, texture: tex, keep, depth, outsideDistance, confidence, outsideWeight, disagree, area };
}

/** Chromaticity and luminance helpers. */
const lum = (r: number, g: number, b: number) => 0.2722 * r + 0.6741 * g + 0.0537 * b;

export interface ShadowOptions {
  kind: ScreenKind;
  /** Pixels where a shadow may be (outside the subject): 0…1; null: everywhere. */
  allowed: Float32Array | null;
  /**
   * Pixels well away from the subject (beyond its band). A shadow must reach
   * there with at least `minArea` pixels — a cast shadow lies on the floor
   * beside the subject; dark hair and its fringe, which also read as a
   * darker screen, stay inside the band. Null: no such test.
   */
  anchor?: Uint8Array | null;
  /**
   * Pixels next to the subject. With it, only shadows that reach the subject
   * are kept — the subject's own cast shadow, not the folds of the cloth or a
   * light stand's shadow far off (which the garbage takes anyway). Null: no
   * such test.
   */
  touch?: Uint8Array | null;
  /**
   * The frame's own detailed screen (the clean plate refined by the frame's
   * screen pixels, which follows the cloth's folds and the cove's fall-off but
   * not a deep shadow). A shadow must have a deep core against it too (at
   * least `minArea` pixels darker than 0.7 of it): shading of the screen that
   * the coarse clean plate does not follow is not a shadow. Null: no test.
   */
  detail?: Float32Array | null;
  /** How far (pixels) a shadow's soft edge may reach from its deep core (default 1 % of the width). */
  penumbra?: number;
  /** Ignore density below this (folds of the cloth, the clean plate's own error). */
  floor?: number;
  /** Chromaticity distance still counted as the screen's. */
  chroma?: number;
  /** Smallest shadow, pixels (noise and dark hair strands are smaller). */
  minArea?: number;
}

/**
 * The shadow pass: per pixel, the density of a shadow cast on the screen —
 * 1 − L(P) / L(clean screen) where the pixel has the screen's chromaticity
 * (within `chroma`) and is darker than the clean screen, outside the subject.
 * `clean` is the clean-plate model with the frame's gain but *not* the
 * frame's own detail (which follows light shadows so that they key out).
 */
export function shadowPass(P: Float32Array, clean: Float32Array, w: number, h: number, o: ShadowOptions): Float32Array {
  const n = w * h;
  const floor = o.floor ?? 0.08;
  const tol = o.chroma ?? 0.05;
  const dens = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const al = o.allowed ? o.allowed[i]! : 1;
    if (!(al > 0)) continue;
    const q = 3 * i;
    const r = P[q]!;
    const g = P[q + 1]!;
    const b = P[q + 2]!;
    const cr = clean[q]!;
    const cg = clean[q + 1]!;
    const cb = clean[q + 2]!;
    const cs = cr + cg + cb;
    const s = r + g + b;
    if (!(cs > 1e-6) || !(s > 1e-6)) continue;
    const dc = Math.hypot(r / s - cr / cs, b / s - cb / cs);
    const cw = clamp01(1 - (dc - 0.6 * tol) / (0.4 * tol));
    if (!(cw > 0)) continue;
    const ratio = lum(r, g, b) / Math.max(1e-6, lum(cr, cg, cb));
    const d = 1 - ratio;
    if (!(d > floor * 0.5)) continue;
    // Below the floor fades in: the clean plate's own error is not a shadow.
    dens[i] = clamp01(d) * clamp01((d - 0.5 * floor) / floor) * cw * al;
  }
  // Shading the coarse clean plate does not follow (the cove's fall-off, folds) is not a shadow: keep
  // density only within reach of a deep core — darker than 0.7 of the frame's own detailed screen.
  if (o.detail) {
    const coreMask = new Uint8Array(n);
    for (let i = 0; i < n; i += 1) {
      if (!(dens[i]! > 0)) continue;
      const q = 3 * i;
      const ld = lum(o.detail[q]!, o.detail[q + 1]!, o.detail[q + 2]!);
      if (ld > 1e-6 && lum(P[q]!, P[q + 1]!, P[q + 2]!) < 0.7 * ld) coreMask[i] = 1;
    }
    const reach = o.penumbra ?? Math.max(3, w / 100);
    const opened0 = morph(morph(coreMask, w, h, -1), w, h, 1);
    const near0 = gaussianBlur(Float32Array.from(morph(opened0, w, h, reach)), w, h, reach / 3);
    for (let i = 0; i < n; i += 1) dens[i] = dens[i]! * clamp01(near0[i]! * 2);
  }
  const minArea = o.minArea ?? Math.max(16, Math.round((w * h) / 20000));
  // The clean-up is morphology over the whole shadow: at 2K it is worked at half size (a shadow is soft).
  if (w > 1100 && !o.minArea) {
    const sw = Math.round(w / 2);
    const sh = Math.round(h / 2);
    const half = (m: Uint8Array | null | undefined) => {
      if (!m) return null;
      const d = areaDownscale(Float32Array.from(m), w, h, sw, sh);
      return Uint8Array.from(d, (v) => (v > 0.25 ? 1 : 0));
    };
    const small = cleanShadow(areaDownscale(dens, w, h, sw, sh), sw, sh, floor, Math.max(4, Math.round(minArea / 4)), half(o.anchor), half(o.touch));
    const up = resizePlane(small, sw, sh, w, h);
    for (let i = 0; i < n; i += 1) up[i] = clamp01(up[i]!);
    return up;
  }
  return cleanShadow(dens, w, h, floor, minArea, o.anchor ?? null, o.touch ?? null);
}

/** Specks dropped, the shadow's own components kept (anchored, touching), holes filled, smoothed. */
function cleanShadow(dens: Float32Array, w: number, h: number, floor: number, minArea: number, anchor: Uint8Array | null, touch: Uint8Array | null): Float32Array {
  const n = w * h;
  // Drop specks: a shadow is an area, not a strand or a noise speck.
  const bin = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) bin[i] = dens[i]! > floor ? 1 : 0;
  const opened = morph(morph(bin, w, h, -1), w, h, 1);
  const lab = components(opened, w, h, 1);
  const grown = morph(opened, w, h, 2);
  const anchored = new Float64Array(lab.sizes.length);
  const touching = new Uint8Array(lab.sizes.length);
  if (anchor) for (let i = 0; i < n; i += 1) if (lab.labels[i] && anchor[i]) anchored[lab.labels[i]!]! += 1;
  if (touch) for (let i = 0; i < n; i += 1) if (lab.labels[i] && touch[i]) touching[lab.labels[i]!] = 1;
  const keepLabel = lab.sizes.map((s, l) => s >= minArea && (!anchor || anchored[l]! >= minArea) && (!touch || touching[l] === 1));
  const big = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) if (lab.labels[i] && keepLabel[lab.labels[i]!]) big[i] = 1;
  const near = morph(big, w, h, 2);
  for (let i = 0; i < n; i += 1) if (!near[i] || !grown[i]) dens[i] = 0;
  // Specks inside a shadow (marks on the floor, noise that left the screen's chromaticity) are filled
  // from the shadow round them; then a light smoothing — the density is a soft matte, not grain.
  const closed = morph(morph(big, w, h, 2), w, h, -2);
  const local = gaussianBlur(dens, w, h, 2);
  const support = gaussianBlur(Float32Array.from(big), w, h, 2);
  for (let i = 0; i < n; i += 1) if (closed[i] && support[i]! > 0.05) dens[i] = Math.max(dens[i]!, Math.min(1, local[i]! / support[i]!));
  const out = gaussianBlur(dens, w, h, 0.8);
  for (let i = 0; i < n; i += 1) out[i] = clamp01(out[i]!);
  return out;
}
