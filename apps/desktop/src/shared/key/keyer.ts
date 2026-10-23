import { keyConfidence, type KeyMetrics, type KeyParams, type ScreenKind } from '@vcvfx/domain';
import { bbox, components, gaussianBlur, growBox, morph, squaredDistance } from '../roto/image';
import { pullPush } from './cleanplate';
import { despill, type DespillOptions } from './despill';
import type { LinearImage } from './linear';
import { blurRgb, lightWrap, type LightWrapOptions } from './look';
import { combineMattes, type ResolvedLink } from './mattes';
import { shadowPass, subjectPrior, type SubjectInput, type SubjectPrior } from './subject';

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
 *  4. Edge refinement (hair, motion blur, semi-transparency) — where the key
 *     is soft, α is solved from the compositing equation along the colour-
 *     difference axis: d(P) = α·d(F) + (1 − α)·d(S), so
 *        α = (d(S) − d(P)) / (d(S) − d(F)),
 *     with the foreground colour F estimated by spreading the core's colours
 *     outward (pull–push). This removes the colour difference's error for
 *     foregrounds that lead the screen channel negatively (a red sleeve's
 *     motion blur keys too solid without it), and — because it uses only F's
 *     colour difference, not all of F — a wrong guess of F matters little
 *     where it would matter most (a hair strand whose nearest core is skin).
 *     Blended with the clipped edge by the detail amount.
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
  /** The screen at every pixel (interleaved RGB): the clean-plate model, with this frame's gain (and detail). */
  screen: Float32Array;
  /**
   * The model with this frame's gain only, without the frame's own detail,
   * for measuring how far the frame's screen is from the shot's (a light
   * going out). Absent: `screen`.
   */
  model?: Float32Array;
  settings: KeyerSettings;
  links?: readonly ResolvedLink[];
  /** Despill the foreground (null: the foreground is the screen-subtracted pixels as they are). */
  despill?: (DespillOptions & { bgNear: Float32Array | null }) | null;
  /** The background plate at this size, for the light wrap. */
  background?: LinearImage | null;
  lightWrap?: LightWrapOptions | null;
  /** Skip the foreground (matte only: faster, e.g. for analysis). */
  matteOnly?: boolean;
  /** The subject segmentation as a prior (hybrid key, addendum 18), or null. */
  subject?: SubjectInput | null;
  /** Compute the shadow pass (and take it out of the alpha). */
  shadow?: boolean;
  /** The clean screen the shadow pass measures against (the static fine screen); absent: the model. */
  clean?: Float32Array | null;
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
  /** Shadow density 0…1 (the shadow pass), or null when off. */
  shadow: Float32Array | null;
  /** The subject prior as used on this frame, or null without one. */
  prior: SubjectPrior | null;
  metrics: KeyMetrics;
  confidence: number;
}

const clamp01 = (v: number) => (v <= 0 ? 0 : v >= 1 ? 1 : v);
/** Foreground-colour samples: this far (key pixels) inside the core's undilated edge, … */
const F_ERODE = 2;
/** … gathered over this σ (key pixels) before falling back to the whole core, … */
const F_SIGMA = 3;
/** … and only where the key is flat (|∇raw| below this per pixel). */
const F_FLAT = 0.03;

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

/**
 * Fill enclosed holes of a binary mask that are tiny, or whose raw key says
 * mostly foreground (spill holes); a hole of soft hair or clean screen stays.
 */
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
    if (size <= 4 || sum[l]! / size > 0.5) out[i] = 1;
  }
  return out;
}

/** A binary mask grown by one pixel (8-connected). */
export function dilate1(m: Uint8Array, w: number, h: number): Uint8Array {
  const out = m.slice();
  for (let y = 0; y < h; y += 1)
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      if (!m[i]) continue;
      const x0 = Math.max(0, x - 1);
      const x1 = Math.min(w - 1, x + 1);
      for (let yy = Math.max(0, y - 1); yy <= Math.min(h - 1, y + 1); yy += 1) out.fill(1, yy * w + x0, yy * w + x1 + 1);
    }
  return out;
}

/**
 * The foreground colour at each band pixel: a weighted average of the
 * foreground samples nearby (normalised convolution, σ = F_SIGMA, worked on
 * the band's bounding box only), falling back to a smooth fill of all the
 * samples (pull–push on a 4× smaller grid) where there are none near.
 */
export function estimateForeground(P: Float32Array, weights: Float32Array, band: Uint8Array, keyed: Uint8Array, w: number, h: number, sigma = F_SIGMA): Float32Array {
  const n = w * h;
  const F = new Float32Array(n * 3);
  const box = bbox(keyed, w, h) ?? bbox(band, w, h);
  if (!box) return F;
  // Far: pull–push on a coarse grid.
  const f = 4;
  const gw = Math.max(1, Math.ceil(w / f));
  const gh = Math.max(1, Math.ceil(h / f));
  const gv = new Float32Array(gw * gh * 3);
  const gwt = new Float32Array(gw * gh);
  for (let y = 0; y < h; y += 1)
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      const wv = weights[i]!;
      if (!wv) continue;
      const g = ((y / f) | 0) * gw + ((x / f) | 0);
      gwt[g]! += wv;
      gv[3 * g]! += P[3 * i]! * wv;
      gv[3 * g + 1]! += P[3 * i + 1]! * wv;
      gv[3 * g + 2]! += P[3 * i + 2]! * wv;
    }
  for (let g = 0; g < gw * gh; g += 1)
    if (gwt[g]! > 0) {
      gv[3 * g]! /= gwt[g]!;
      gv[3 * g + 1]! /= gwt[g]!;
      gv[3 * g + 2]! /= gwt[g]!;
      gwt[g] = Math.min(1, gwt[g]! / (f * f * 0.25));
    }
  const far = pullPush(gv, gwt, gw, gh, 3);
  // Near: normalised convolution on the band's box.
  const r = Math.ceil(3 * sigma) + 1;
  const b = growBox(box, r, w, h);
  const bw = b.x1 - b.x0 + 1;
  const bh = b.y1 - b.y0 + 1;
  const pw = new Float32Array(bw * bh * 3);
  const wt = new Float32Array(bw * bh);
  for (let y = 0; y < bh; y += 1)
    for (let x = 0; x < bw; x += 1) {
      const i = (y + b.y0) * w + x + b.x0;
      const wv = weights[i]!;
      if (!wv) continue;
      const j = y * bw + x;
      wt[j] = wv;
      pw[3 * j] = P[3 * i]! * wv;
      pw[3 * j + 1] = P[3 * i + 1]! * wv;
      pw[3 * j + 2] = P[3 * i + 2]! * wv;
    }
  const num = blurRgb(pw, bw, bh, sigma);
  const den = gaussianBlur(wt, bw, bh, sigma);
  for (let i = 0; i < n; i += 1) {
    if (!band[i]) continue;
    const x = i % w;
    const y = (i - x) / w;
    const gx = Math.min(gw - 1, Math.max(0, (x + 0.5) / f - 0.5));
    const gy = Math.min(gh - 1, Math.max(0, (y + 0.5) / f - 0.5));
    const x0 = gx | 0;
    const y0 = gy | 0;
    const x1 = Math.min(gw - 1, x0 + 1);
    const y1 = Math.min(gh - 1, y0 + 1);
    const tx = gx - x0;
    const ty = gy - y0;
    const inBox = x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1;
    const j = inBox ? (y - b.y0) * bw + (x - b.x0) : -1;
    const d = inBox ? den[j]! : 0;
    const a = clamp01(d / 0.08);
    for (let c = 0; c < 3; c += 1) {
      const fv = (far[3 * (y0 * gw + x0) + c]! * (1 - tx) + far[3 * (y0 * gw + x1) + c]! * tx) * (1 - ty) + (far[3 * (y1 * gw + x0) + c]! * (1 - tx) + far[3 * (y1 * gw + x1) + c]! * tx) * ty;
      F[3 * i + c] = d > 1e-6 ? a * (num[3 * j + c]! / d) + (1 - a) * fv : fv;
    }
  }
  return F;
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
  let solid: Uint8Array = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) solid[i] = raw[i]! >= k.coreThreshold ? 1 : 0;
  if (k.coreClose >= 0.5) solid = morph(morph(solid, w, h, k.coreClose), w, h, -k.coreClose);
  let filled = fillHoles(solid, raw, w, h);
  const keyCore = k.coreErode >= 0.5 ? morph(filled, w, h, -k.coreErode) : filled;
  // The subject prior (hybrid key): inside the eroded segmentation the core is solid whatever the
  // colour — except where the key calls the pixel clean screen (a segmentation over the screen).
  const prior = input.subject ? subjectPrior(input.subject, raw, w, h, k.clipBlack) : null;
  const notScreen = (i: number) => clamp01((raw[i]! - k.clipBlack) / 0.1);
  let core = keyCore;
  if (prior && prior.confidence > 0) {
    core = keyCore.slice();
    filled = filled.slice();
    for (let i = 0; i < n; i += 1)
      if (prior.core[i]! >= 0.5 && (notScreen(i) >= 0.5 || prior.deep[i])) {
        core[i] = 1;
        filled[i] = 1;
      }
  }

  // 4. Edge refinement by unmixing.
  const refined = edge.slice();
  if (k.edgeDetail > 0) {
    // The foreground's colours: solid pixels just inside the core's edge (a nearly-solid edge pixel
    // still holds some screen), weighted by how solid they key; nearby ones first (normalised
    // convolution), the rest of the core filled in from further away (pull–push).
    const sampleMask = morph(filled, w, h, -F_ERODE);
    const weights = new Float32Array(n);
    let anySolid = false;
    // Flatness: a motion-blur ramp keys "solid" for a foreground that over-keys (a red sleeve), but its key is not flat.
    const grad = new Float32Array(n);
    for (let y = 1; y < h - 1; y += 1)
      for (let x = 1; x < w - 1; x += 1) {
        const i = y * w + x;
        grad[i] = Math.max(Math.abs(raw[i + 1]! - raw[i - 1]!), Math.abs(raw[i + w]! - raw[i - w]!)) / 2;
      }
    for (let i = 0; i < n; i += 1) {
      // Solid by colour, or (with a prior) solid by the segmentation: the suit's own colour is the foreground's.
      const solidness = prior && prior.core[i]! >= 0.5 ? Math.max(prior.core[i]!, clamp01((raw[i]! - 0.85) / 0.15)) : clamp01((raw[i]! - 0.85) / 0.15);
      const wv = sampleMask[i] ? solidness * clamp01(1 - grad[i]! / F_FLAT) : 0;
      if (wv > 0) {
        weights[i] = wv;
        anySolid = true;
      }
    }
    if (!anySolid)
      for (let i = 0; i < n; i += 1)
        if (raw[i]! >= 0.98) {
          weights[i] = 1;
          anySolid = true;
        }
    if (anySolid) {
      const [sc, ac, cc] = channels(k.kind);
      const b = k.balance;
      // Everything outside the core that keyed at all, and its neighbours: a pixel that over-keys
      // to "solid" (a red sleeve's motion blur) is exactly one that needs it.
      const floor = 0.5 * k.clipBlack;
      const seed = new Uint8Array(n);
      const keyed = new Uint8Array(n);
      for (let i = 0; i < n; i += 1) {
        if (core[i]) continue;
        if (raw[i]! > floor) seed[i] = 1;
        // Clearly keyed (not a noise speck on the screen): where the work is.
        if (raw[i]! > 0.1) keyed[i] = 1;
      }
      const band = dilate1(seed, w, h);
      // With a prior the nearest solid samples of a costume sit the margin away from its edge: look that far.
      const F = estimateForeground(P, weights, band, keyed, w, h);
      // Inside the segmentation, the costume's own colour: the prior's solid core spread outward
      // (normalised convolution over about the margin), so a screen-lit suit's band unmixes against the suit.
      if (prior && prior.confidence > 0 && input.subject) {
        // Only from well inside (three margins deep): a segmentation a few pixels too wide must not
        // lend the costume colour of a screen-mixed fringe of hair.
        const sig = Math.max(F_SIGMA, 2 * input.subject.margin);
        const deepAt = 3 * input.subject.margin;
        const wc = new Float32Array(n);
        const pc = new Float32Array(n * 3);
        for (let i = 0; i < n; i += 1)
          if (prior.core[i]! >= 0.5 * prior.confidence && prior.depth[i]! >= deepAt) {
            wc[i] = 1;
            pc[3 * i] = P[3 * i]!;
            pc[3 * i + 1] = P[3 * i + 1]!;
            pc[3 * i + 2] = P[3 * i + 2]!;
          }
        const den = gaussianBlur(wc, w, h, sig);
        const num = blurRgb(pc, w, h, sig);
        for (let i = 0; i < n; i += 1) {
          if (!band[i] || !prior.inside[i] || !(den[i]! > 1e-3)) continue;
          // Not in hair (the nearest solid colour is right there), and only for a costume that leads the
          // screen channel more than the colour found near it — the case it is for.
          const q = 3 * i;
          const leadIn = (num[q + sc]! - (b * num[q + ac]! + (1 - b) * num[q + cc]!)) / den[i]!;
          const leadF = F[q + sc]! - (b * F[q + ac]! + (1 - b) * F[q + cc]!);
          if (!(leadIn > leadF)) continue;
          const t = clamp01(den[i]! / 0.05) * (1 - prior.texture[i]!);
          for (let c = 0; c < 3; c += 1) F[3 * i + c] = t * (num[3 * i + c]! / den[i]!) + (1 - t) * F[3 * i + c]!;
        }
      }
      for (let i = 0; i < n; i += 1) {
        if (!band[i] || core[i]) continue;
        const q = 3 * i;
        const dS = screen[q + sc]! - (b * screen[q + ac]! + (1 - b) * screen[q + cc]!);
        if (!(dS > 1e-6)) continue;
        const dP = P[q + sc]! - (b * P[q + ac]! + (1 - b) * P[q + cc]!);
        // The foreground's own lead of the screen channel, kept well below the screen's — less far
        // below inside the segmentation, where a screen-lit costume really does lead (addendum 18).
        const lim = prior && prior.inside[i] ? 0.5 + 0.4 * prior.confidence : 0.5;
        const dF = Math.min(lim * dS, F[q + sc]! - (b * F[q + ac]! + (1 - b) * F[q + cc]!));
        let au = (dS - dP) / (dS - dF);
        au = au < 0.01 ? 0 : au > 0.99 ? 1 : au;
        // Inside the segmentation, where the unmixing (its foreground colour now the costume's own) calls
        // the pixel solid, it is: the colour-difference edge there is exactly what failed.
        // (Within the costume's own shading and noise of solid: above 0.85 fading to solid at 0.95.)
        const blend = edge[i]! + k.edgeDetail * (au - edge[i]!);
        refined[i] = prior && prior.depth[i]! >= 2 && au > 0.85 ? blend + (1 - blend) * clamp01((au - 0.85) / 0.1) * prior.confidence : blend;
      }
    }
  }
  if (k.edgeSoftness >= 0.5) {
    const soft = gaussianBlur(refined, w, h, k.edgeSoftness / 2);
    for (let i = 0; i < n; i += 1) if (refined[i]! > 0 && refined[i]! < 1) refined[i] = soft[i]!;
  }

  // 5. Combine with the core, then the mattes.
  let alpha: Float32Array = new Float32Array(n);
  for (let i = 0; i < n; i += 1) alpha[i] = core[i] ? 1 : refined[i]!;
  if (prior && prior.confidence > 0)
    for (let i = 0; i < n; i += 1) {
      // The soft rim of the prior's core, then the soft garbage outside the segmentation.
      const c = prior.core[i]!;
      if (c > 0 && c < 0.5) alpha[i] = Math.max(alpha[i]!, c * 2 * (prior.deep[i] ? 1 : notScreen(i)));
      alpha[i] = alpha[i]! * prior.keep[i]!;
    }
  // The shadow pass: shadows cast on the screen, outside the subject, leave the alpha for a matte of their own.
  let shadow: Float32Array | null = null;
  if (input.shadow) {
    const margin = input.subject ? Math.max(1, input.subject.margin) : Math.max(2, w / 200);
    const allowed = new Float32Array(n);
    const anchor = new Uint8Array(n);
    let touch: Uint8Array | null = null;
    if (prior && prior.area) {
      touch = new Uint8Array(n);
      for (let i = 0; i < n; i += 1) if (!prior.inside[i] && prior.outsideDistance[i]! <= 4 * margin) touch[i] = 1;
    }
    if (prior && prior.area)
      for (let i = 0; i < n; i += 1) {
        if (prior.inside[i]) continue;
        const d = prior.outsideDistance[i]!;
        allowed[i] = clamp01(d / Math.max(1, 0.5 * margin));
        // Beyond the band (as wide as the outside garbage's margin, wider by hair).
        anchor[i] = d > 2 * margin * (1 + 2 * prior.texture[i]!) ? 1 : 0;
      }
    else {
      // No segmentation: away from anything the key calls solid.
      const dCore = keyCore.some((v) => v) ? squaredDistance(keyCore, w, h) : null;
      for (let i = 0; i < n; i += 1) {
        const d = dCore ? Math.sqrt(dCore[i]!) : 1e6;
        allowed[i] = clamp01((d - margin) / margin);
        anchor[i] = d > 6 * margin ? 1 : 0;
      }
    }
    shadow = shadowPass(P, input.clean ?? input.model ?? screen, w, h, { kind: k.kind, allowed, anchor, touch });
    // Taken out of the alpha only beside a segmented subject: without one, a screen-lit costume away
    // from the key's core reads exactly as a shadow, and the matte keeps it (the pass is still written).
    if (prior && prior.area && prior.outsideWeight > 0) for (let i = 0; i < n; i += 1) if (shadow[i]! > 0) alpha[i] = alpha[i]! * (1 - prior.outsideWeight * clamp01(shadow[i]! / 0.12));
  }
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

  const metrics: KeyMetrics = keyMetrics(img, screen, raw, edge, keyCore, alpha, k.kind, input.model, { priorCore: prior && prior.confidence > 0 ? Float32Array.from(prior.inside) : null, keep: prior && prior.confidence > 0 ? prior.keep : null, shadow });
  if (prior) {
    // How much the key, without the prior, would have called solid outside the segmentation (stands, a
    // second actor, or a segmentation that lost a limb), and how much of its core is clean screen.
    let outsideSolid = 0;
    for (let i = 0; i < n; i += 1) if (!prior.inside[i] && prior.keep[i]! < 0.5 && refined[i]! >= 0.5) outsideSolid += 1;
    metrics.subjectDisagree = Math.round(prior.disagree * 10_000) / 10_000;
    metrics.subjectOutside = prior.area ? Math.round(Math.min(1, outsideSolid / prior.area) * 10_000) / 10_000 : 0;
    metrics.subjectConfidence = Math.round(prior.confidence * 1000) / 1000;
  }
  if (shadow) {
    let sa = 0;
    for (let i = 0; i < n; i += 1) if (shadow[i]! > 0.1) sa += 1;
    metrics.shadow = Math.round((sa / n) * 10_000) / 10_000;
  }
  return { width: w, height: h, alpha, raw, edge: refined, core, fg, spill, wrap, shadow, prior, metrics, confidence: keyConfidence(metrics) };
}

/**
 * What the frame says about how well it keyed (addendum 09 §5): how much is
 * clean screen, how much of the core had to be rescued (spill, noise), how
 * busy the soft edge is, holes in the subject that are not screen-coloured
 * (the keyer made something transparent that does not look like screen), and
 * how far the clean screen is from its model (a lighting change).
 */
export function keyMetrics(
  img: LinearImage,
  screen: Float32Array,
  raw: Float32Array,
  edge: Float32Array,
  core: Uint8Array,
  alpha: Float32Array,
  kind: ScreenKind,
  model: Float32Array = screen,
  hybrid: { priorCore?: Float32Array | null; keep?: Float32Array | null; shadow?: Float32Array | null } = {},
): KeyMetrics {
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
      // Screen vs its model, over what the key itself reads as screen: not what a subject prior
      // cleared (a light stand), not a shadow (it is darker on purpose).
      const counted = (!hybrid.shadow || hybrid.shadow[i]! < 0.05) && (!hybrid.priorCore || raw[i]! < 0.25);
      if ((i & 3) === 0 && counted) {
        const q = 3 * i;
        const ss = model[q]! + model[q + 1]! + model[q + 2]!;
        if (ss > 1e-5) {
          resid += (Math.abs(P[q]! - model[q]!) + Math.abs(P[q + 1]! - model[q + 1]!) + Math.abs(P[q + 2]! - model[q + 2]!)) / ss;
          residN += 1;
        }
      }
    } else if (a < 0.98) soft += 1;
    if (a >= 0.5) subject += 1;
    // What the core rescued — but not what the segmentation vouches for (a screen-lit costume).
    if (core[i]) {
      coreN += 1;
      if (edge[i]! < 0.9 && !(hybrid.priorCore && hybrid.priorCore[i]! >= 0.5) && !(hybrid.keep && hybrid.keep[i]! < 0.5)) coreBad += 1;
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
