import { keyConfidence, type KeyMetrics, type KeyParams, type ScreenKind } from '@vcvfx/domain';
import { components, gaussianBlur, morph } from '../roto/image';
import { pullPush } from './cleanplate';
import { despill, type DespillOptions } from './despill';
import type { LinearImage } from './linear';
import { lightWrap, type LightWrapOptions } from './look';
import { combineMattes, type ResolvedLink } from './mattes';

/**
 * The keyer (master spec §6; addendum 09 §3.3–3.5). Pure TypeScript on
 * typed arrays, deterministic: the same frame and settings give the same
 * matte, bit for bit (§19).
 *
 *  1. Raw key — colour difference against the screen model S (the clean plate
 *     at this pixel): with d(X) = X_screen − (b·X_a + (1 − b)·X_c), the
 *     screen channel minus a balance of the other two,
 *        raw = 1 − d(P) / d(S).
 *     In linear light a soft-edge pixel is P = α·F + (1 − α)·S, so for a
 *     foreground with no screen-colour lead (d(F) ≈ 0: hair, skin, most
 *     clothes) raw = α exactly; normalising by S per pixel makes an unevenly
 *     lit screen key as evenly as a flat one.
 *  2. Edge matte — raw clipped between black and white points, then gamma.
 *  3. Core matte — raw above a threshold, closed (bridging spill holes),
 *     enclosed holes that are not screen-coloured filled, then eroded so it
 *     stays inside the soft edge; solid.
 *  4. Edge refinement (hair, motion blur, semi-transparency) — where raw is
 *     soft, α is solved by unmixing: with the foreground colour F estimated
 *     by spreading the solid foreground's colours outward (pull–push) and
 *     the screen S known, α = ((P − S)·(F − S)) / |F − S|², the projection of
 *     the pixel onto the line between screen and foreground. This is exact
 *     for any F, including foregrounds the colour difference misjudges (a red
 *     sleeve's motion blur). Blended with the colour-difference edge by the
 *     detail amount, and trusted only where F and S differ clearly.
 *  5. α = max(edge, core); then repair, garbage and holdout mattes (mattes.ts).
 *  6. Foreground — the screen subtracted, P − (1 − α)·S: the premultiplied
 *     foreground, exact for the compositing model; then despilled.
 */

export interface KeyerSettings {
  kind: ScreenKind;
  balance: number;
  clipBlack: number;
  clipWhite: number;
  gamma: number;
  coreThreshold: number;
  /** In this image's pixels. */
  coreErode: number;
  coreClose: number;
  edgeDetail: number;
  edgeSoftness: number;
}

/** The keyer's settings from the document's (plate pixels) at `pxScale` plate pixels per key pixel. */
export function keyerSettings(kind: ScreenKind, p: KeyParams, pxScale: number): KeyerSettings {
  return {
    kind,
    balance: p.balance,
    clipBlack: p.clipBlack,
    clipWhite: p.clipWhite,
    gamma: p.gamma,
    coreThreshold: p.coreThreshold,
    coreErode: p.coreErodePx / pxScale,
    coreClose: p.coreClosePx / pxScale,
    edgeDetail: p.edgeDetail,
    edgeSoftness: p.edgeSoftnessPx / pxScale,
  };
}

export interface KeyFrameInput {
  image: LinearImage;
  /** The screen at every pixel (interleaved RGB): the clean-plate model, with this frame's gain. */
  screen: Float32Array;
  settings: KeyerSettings;
  links?: readonly ResolvedLink[];
  /** Despill the foreground (null: the foreground is the screen-subtracted pixels as they are). */
  despill?: (DespillOptions & { bgNear: Float32Array | null }) | null;
  /** The background plate at this size, for the light wrap. */
  background?: LinearImage | null;
  lightWrap?: LightWrapOptions | null;
  /** Skip the foreground (matte only: faster, e.g. for analysis). */
  matteOnly?: boolean;
}

export interface KeyFrameOutput {
  width: number;
  height: number;
  /** The final matte, 0…1. */
  alpha: Float32Array;
  /** The raw colour-difference key (unclipped). */
  raw: Float32Array;
  /** The edge matte after refinement, before the core and the mattes. */
  edge: Float32Array;
  /** The core matte (1 = solid). */
  core: Uint8Array;
  /** Premultiplied, despilled foreground (interleaved RGB), or null for matte only. */
  fg: Float32Array | null;
  /** Spill removed per pixel (premultiplied units), or null. */
  spill: Float32Array | null;
  /** The light-wrap layer, or null. */
  wrap: Float32Array | null;
  metrics: KeyMetrics;
  confidence: number;
}

const clamp01 = (v: number) => (v <= 0 ? 0 : v >= 1 ? 1 : v);

/** Indices of the screen channel and the two others (a = red, c = the remaining one). */
function channels(kind: ScreenKind): [number, number, number] {
  return kind === 'green' ? [1, 0, 2] : [2, 0, 1];
}

/** The raw colour-difference key against the per-pixel screen. */
export function rawKey(img: LinearImage, screen: Float32Array, kind: ScreenKind, balance: number): Float32Array {
  const [s, a, c] = channels(kind);
  const n = img.width * img.height;
  const out = new Float32Array(n);
  const d = img.data;
  for (let i = 0; i < n; i += 1) {
    const k = 3 * i;
    const dS = screen[k + s]! - (balance * screen[k + a]! + (1 - balance) * screen[k + c]!);
    const dP = d[k + s]! - (balance * d[k + a]! + (1 - balance) * d[k + c]!);
    out[i] = dS > 1e-6 ? 1 - dP / dS : 1;
  }
  return out;
}

/** Fill enclosed holes of a binary mask that are small or not screen-like (their raw key is high). */
function fillHoles(mask: Uint8Array, raw: Float32Array, w: number, h: number): Uint8Array {
  const out = mask.slice();
  const bg = components(mask, w, h, 0);
  const touches = new Uint8Array(bg.sizes.length);
  for (let x = 0; x < w; x += 1) {
    touches[bg.labels[x]!] = 1;
    touches[bg.labels[(h - 1) * w + x]!] = 1;
  }
  for (let y = 0; y < h; y += 1) {
    touches[bg.labels[y * w]!] = 1;
    touches[bg.labels[y * w + w - 1]!] = 1;
  }
  const sum = new Float64Array(bg.sizes.length);
  for (let i = 0; i < mask.length; i += 1) if (bg.labels[i]) sum[bg.labels[i]!]! += raw[i]!;
  for (let i = 0; i < mask.length; i += 1) {
    const l = bg.labels[i]!;
    if (!l || touches[l]) continue;
    const size = bg.sizes[l]!;
    if (size <= 4 || sum[l]! / size > 0.25) out[i] = 1;
  }
  return out;
}

export function keyFrame(input: KeyFrameInput): KeyFrameOutput {
  const { image: img, screen, settings: k } = input;
  const { width: w, height: h } = img;
  const n = w * h;
  const P = img.data;
  const raw = rawKey(img, screen, k.kind, k.balance);

  // 2. Edge matte.
  const span = Math.max(0.02, k.clipWhite - k.clipBlack);
  const edge = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    let e = clamp01((raw[i]! - k.clipBlack) / span);
    if (k.gamma !== 1 && e > 0 && e < 1) e = Math.pow(e, k.gamma);
    edge[i] = e;
  }

  // 3. Core matte.
  let solid = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) solid[i] = raw[i]! >= k.coreThreshold ? 1 : 0;
  if (k.coreClose >= 0.5) solid = morph(morph(solid, w, h, k.coreClose), w, h, -k.coreClose);
  const filled = fillHoles(solid, raw, w, h);
  const core = k.coreErode >= 0.5 ? morph(filled, w, h, -k.coreErode) : filled;

  // 4. Edge refinement by unmixing.
  const refined = edge.slice();
  if (k.edgeDetail > 0) {
    // The foreground's colours come from the core only: a nearly-solid edge pixel still holds some screen.
    const weights = new Float32Array(n);
    let anySolid = false;
    for (let i = 0; i < n; i += 1)
      if (core[i]) {
        weights[i] = 1;
        anySolid = true;
      }
    if (!anySolid)
      for (let i = 0; i < n; i += 1)
        if (raw[i]! >= 0.98) {
          weights[i] = 1;
          anySolid = true;
        }
    if (anySolid) {
      const F = pullPush(P, weights, w, h, 3);
      // The band: soft pixels and their neighbours.
      let band = new Uint8Array(n);
      for (let i = 0; i < n; i += 1) band[i] = edge[i]! > 0 && edge[i]! < 1 && !core[i] ? 1 : 0;
      band = morph(band, w, h, 1);
      for (let i = 0; i < n; i += 1) {
        if (!band[i] || core[i]) continue;
        const q = 3 * i;
        const d0 = F[q]! - screen[q]!;
        const d1 = F[q + 1]! - screen[q + 1]!;
        const d2 = F[q + 2]! - screen[q + 2]!;
        const dd = d0 * d0 + d1 * d1 + d2 * d2;
        if (!(dd > 1e-10)) continue;
        const sn = Math.sqrt(screen[q]! ** 2 + screen[q + 1]! ** 2 + screen[q + 2]! ** 2) + 1e-6;
        // Trust the unmixing where foreground and screen are clearly apart.
        const trust = clamp01((Math.sqrt(dd) / sn - 0.15) / 0.35);
        const au = clamp01(((P[q]! - screen[q]!) * d0 + (P[q + 1]! - screen[q + 1]!) * d1 + (P[q + 2]! - screen[q + 2]!) * d2) / dd);
        const t = k.edgeDetail * trust;
        let v = edge[i]! + t * (au - edge[i]!);
        if (v < 0.003) v = 0;
        refined[i] = v;
      }
    }
  }
  if (k.edgeSoftness >= 0.5) {
    const soft = gaussianBlur(refined, w, h, k.edgeSoftness / 2);
    for (let i = 0; i < n; i += 1) if (refined[i]! > 0 && refined[i]! < 1) refined[i] = soft[i]!;
  }

  // 5. Combine with the core, then the mattes.
  let alpha = new Float32Array(n);
  for (let i = 0; i < n; i += 1) alpha[i] = core[i] ? 1 : refined[i]!;
  if (input.links?.length) alpha = combineMattes(alpha, input.links);

  // 6. Foreground: screen subtracted, then despilled.
  let fg: Float32Array | null = null;
  let spill: Float32Array | null = null;
  if (!input.matteOnly) {
    fg = new Float32Array(n * 3);
    for (let i = 0; i < n; i += 1) {
      const a = alpha[i]!;
      if (!(a > 0)) continue;
      const q = 3 * i;
      const kk = 1 - a;
      fg[q] = Math.max(0, P[q]! - kk * screen[q]!);
      fg[q + 1] = Math.max(0, P[q + 1]! - kk * screen[q + 1]!);
      fg[q + 2] = Math.max(0, P[q + 2]! - kk * screen[q + 2]!);
    }
    if (input.despill) {
      const d = despill(fg, alpha, input.despill, input.despill.bgNear);
      fg = d.out;
      spill = d.spill;
    }
  }
  const wrap = !input.matteOnly && input.background && input.lightWrap && input.lightWrap.intensity > 0 ? lightWrap(alpha, input.background, input.lightWrap) : null;

  const metrics = keyMetrics(img, screen, raw, edge, core, alpha, k.kind);
  return { width: w, height: h, alpha, raw, edge: refined, core, fg, spill, wrap, metrics, confidence: keyConfidence(metrics) };
}

/**
 * What the frame says about how well it keyed (addendum 09 §5): how much is
 * clean screen, how much of the core had to be rescued (spill, noise), how
 * busy the soft edge is, holes in the subject that are not screen-coloured
 * (the keyer made something transparent that does not look like screen), and
 * how far the clean screen is from its model (a lighting change).
 */
export function keyMetrics(img: LinearImage, screen: Float32Array, raw: Float32Array, edge: Float32Array, core: Uint8Array, alpha: Float32Array, kind: ScreenKind): KeyMetrics {
  const { width: w, height: h } = img;
  const n = w * h;
  const P = img.data;
  let clean = 0;
  let soft = 0;
  let coreN = 0;
  let coreBad = 0;
  let resid = 0;
  let residN = 0;
  let subject = 0;
  for (let i = 0; i < n; i += 1) {
    const a = alpha[i]!;
    if (a < 0.02) {
      clean += 1;
      if ((i & 3) === 0) {
        const q = 3 * i;
        const ss = screen[q]! + screen[q + 1]! + screen[q + 2]!;
        if (ss > 1e-5) {
          resid += (Math.abs(P[q]! - screen[q]!) + Math.abs(P[q + 1]! - screen[q + 1]!) + Math.abs(P[q + 2]! - screen[q + 2]!)) / ss;
          residN += 1;
        }
      }
    } else if (a < 0.98) soft += 1;
    if (a >= 0.5) subject += 1;
    if (core[i]) {
      coreN += 1;
      if (edge[i]! < 0.9) coreBad += 1;
    }
  }
  // Holes: enclosed transparent regions whose pixels do not look like screen.
  const lowMask = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) lowMask[i] = alpha[i]! < 0.5 ? 1 : 0;
  const lab = components(lowMask, w, h, 1);
  const touches = new Uint8Array(lab.sizes.length);
  for (let x = 0; x < w; x += 1) {
    touches[lab.labels[x]!] = 1;
    touches[lab.labels[(h - 1) * w + x]!] = 1;
  }
  for (let y = 0; y < h; y += 1) {
    touches[lab.labels[y * w]!] = 1;
    touches[lab.labels[y * w + w - 1]!] = 1;
  }
  const s = kind === 'green' ? 1 : 2;
  let holes = 0;
  for (let i = 0; i < n; i += 1) {
    const l = lab.labels[i]!;
    if (!l || touches[l]) continue;
    const q = 3 * i;
    const ss = screen[q]! + screen[q + 1]! + screen[q + 2]!;
    const ps = P[q]! + P[q + 1]! + P[q + 2]!;
    // Screen-like: the screen channel's share close to the screen's, whatever the brightness.
    const screenLike = ss > 1e-6 && ps > 1e-6 && Math.abs(P[q + s]! / ps - screen[q + s]! / ss) < 0.12 && raw[i]! < 0.5;
    if (!screenLike) holes += 1;
  }
  return {
    screenCoverage: clean / n,
    coreNoise: coreN ? coreBad / coreN : 0,
    edgeActivity: soft / n,
    holes: subject ? Math.min(1, holes / subject) : 0,
    residual: residN ? resid / residN : 0,
  };
}
