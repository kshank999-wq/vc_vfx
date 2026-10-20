import { fitColorModel, binOf, type ColorModel } from './color-model';
import type { EngineResult, EngineSettings, KeyRequest, SegmentationEngine, StepRequest } from './engine';
import { buildPyramid, estimateObjectMotion, type PyramidLevel } from './flow';
import {
  areaDownscale,
  bbox,
  binarize,
  cropRGB,
  cropU8,
  pasteU8,
  sampleBilinear,
  sampleU8,
  cleanSegmentation,
  edgeBand,
  growBox,
  guidedFilter,
  iou,
  maskArea,
  morph,
  resizePlane,
  resizeRGB,
  signedDistance,
  squaredDistance,
  toGray,
  type Box,
  type Mask,
  type RGBImage,
} from './image';
import { GridGraph } from './maxflow';
import { rasterizeStrokes, scaleStrokes, SEED_EXCLUDE, SEED_INCLUDE } from './strokes';

/**
 * The Track engine (addendum 04): classical, no model to download, always
 * available.
 *
 * Key frame — GrabCut-style energy minimisation: colour models (Gaussian
 * mixtures in Lab) of what was painted in and out, a spatial prior that fades
 * with distance from the include paint, a contrast-sensitive smoothness term,
 * and the painted pixels as hard constraints; solved exactly by min-cut
 * (maxflow.ts), the models refitted to the result and solved again. Solved
 * coarse first, then at working resolution in a band around the edge.
 *
 * Propagation — the previous matte is warped by optical flow (flow.ts), and
 * only a band around the warped edge is re-segmented, with the warped matte
 * as prior and everything outside the band held. The edge is softened by a
 * guided filter. Confidence is how well the colours separate along the edge,
 * how consistent the flow was, and how much the shape had to change.
 */

export const TRACK_VERSION = '1.0.0';

export const TRACK_DEFAULTS = {
  /** Longest edge of the key frame's first, whole-frame solve. */
  coarseWidth: 480,
  /** Longest edge the flow is measured at. */
  flowWidth: 960,
  /** Band re-segmented around the warped edge, working pixels; 0 = automatic (≈ width / 240). */
  band: 0,
  /** Smoothness weight (GrabCut's γ). */
  gamma: 50,
  /** Weight of the spatial prior against the colour models. */
  prior: 1.5,
  /** Gaussians per colour model. */
  components: 5,
  grabcutIterations: 3,
} as const;

type TrackSettings = { -readonly [K in keyof typeof TRACK_DEFAULTS]: number };

export function trackSettings(s: EngineSettings): TrackSettings {
  const out = { ...TRACK_DEFAULTS } as TrackSettings;
  for (const k of Object.keys(TRACK_DEFAULTS) as (keyof TrackSettings)[]) {
    const v = s[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}


/** β of the contrast term: 1 / (2 ⟨‖Ip − Iq‖²⟩) over neighbouring pixels. */
function contrastBeta(img: RGBImage, box: Box | null): number {
  const { width: w, data: d } = img;
  const b = box ?? { x0: 0, y0: 0, x1: img.width - 1, y1: img.height - 1 };
  let sum = 0;
  let count = 0;
  for (let y = b.y0; y <= b.y1; y += 1) for (let x = b.x0; x <= b.x1; x += 1) {
    const i = (y * w + x) * 3;
    if (x < b.x1) {
      const j = i + 3;
      sum += (d[i]! - d[j]!) ** 2 + (d[i + 1]! - d[j + 1]!) ** 2 + (d[i + 2]! - d[j + 2]!) ** 2;
      count += 1;
    }
    if (y < b.y1) {
      const j = i + w * 3;
      sum += (d[i]! - d[j]!) ** 2 + (d[i + 1]! - d[j + 1]!) ** 2 + (d[i + 2]! - d[j + 2]!) ** 2;
      count += 1;
    }
  }
  return count && sum > 0 ? count / (2 * sum) : 0;
}

/**
 * Minimise the energy over `box` (inclusive). `hard`: 1 foreground, 2
 * background, 0 free. `prior`: P(foreground) per pixel or null. Writes the
 * labels of the box into `out` (1 = foreground) and leaves the rest alone.
 *
 * Held pixels (hard ≠ 0) are not part of the graph: each edge from a free
 * pixel to a held one becomes a terminal capacity on the free pixel (cutting
 * it costs the same), so the max-flow only works where the label is open —
 * the band — however large the box.
 */
function cut(img: RGBImage, model: ColorModel, hard: Uint8Array, prior: Float32Array | null, priorWeight: number, gamma: number, box: Box, out: Uint8Array): void {
  const w = img.width;
  const bw = box.x1 - box.x0 + 1;
  const bh = box.y1 - box.y0 + 1;
  const g = new GridGraph(bw, bh);
  const beta = contrastBeta(img, box);
  const d = img.data;
  const weight = (k: number, j: number) => gamma * Math.exp(-beta * ((d[k]! - d[j]!) ** 2 + (d[k + 1]! - d[j + 1]!) ** 2 + (d[k + 2]! - d[j + 2]!) ** 2));
  for (let y = 0; y < bh; y += 1) {
    for (let x = 0; x < bw; x += 1) {
      const p = y * bw + x;
      const i = (y + box.y0) * w + (x + box.x0);
      const h = hard[i]!;
      if (h === 0) {
        const bin = binOf(d[3 * i]!, d[3 * i + 1]!, d[3 * i + 2]!);
        let costFg = model.fg[bin]!;
        let costBg = model.bg[bin]!;
        if (prior) {
          const pf = Math.min(0.999, Math.max(0.001, prior[i]!));
          costFg -= priorWeight * Math.log(pf);
          costBg -= priorWeight * Math.log(1 - pf);
        }
        // Only the difference matters; keep both non-negative.
        const m = Math.min(costFg, costBg);
        g.addTerminal(p, costBg - m, costFg - m);
      }
      // Right and down neighbours: free–free is an edge; free–held a terminal on the free one.
      const k = 3 * i;
      for (const [dir, ok, j, q] of [
        [0, x < bw - 1, i + 1, p + 1],
        [2, y < bh - 1, i + w, p + bw],
      ] as const) {
        if (!ok) continue;
        const hq = hard[j]!;
        if (h === 0 && hq === 0) g.setEdge(p, dir, weight(k, 3 * j));
        else if (h === 0) g.addTerminal(p, hq === SEED_INCLUDE ? weight(k, 3 * j) : 0, hq === SEED_EXCLUDE ? weight(k, 3 * j) : 0);
        else if (hq === 0) g.addTerminal(q, h === SEED_INCLUDE ? weight(k, 3 * j) : 0, h === SEED_EXCLUDE ? weight(k, 3 * j) : 0);
      }
    }
  }
  g.solve();
  for (let y = 0; y < bh; y += 1) for (let x = 0; x < bw; x += 1) {
    const i = (y + box.y0) * w + (x + box.x0);
    const h = hard[i]!;
    out[i] = h === SEED_INCLUDE ? 1 : h === SEED_EXCLUDE ? 0 : g.isSource(y * bw + x) ? 1 : 0;
  }
}

function bandFrom(sd: Float32Array, r: number): Uint8Array {
  const out = new Uint8Array(sd.length);
  for (let i = 0; i < sd.length; i += 1) out[i] = sd[i]! <= r && sd[i]! >= -r ? 1 : 0;
  return out;
}

/** Soft edge: a guided filter of the hard labels within `r` of the edge, hard elsewhere. */
function softEdge(img: RGBImage, labels: Uint8Array, r: number, sd?: Float32Array): Mask {
  const w = img.width;
  const h = img.height;
  const out = new Uint8Array(w * h);
  const band = sd ? bandFrom(sd, r + 1) : edgeBand(labels, w, h, r + 1);
  const box = bbox(band, w, h);
  for (let i = 0; i < out.length; i += 1) out[i] = labels[i] ? 255 : 0;
  if (!box) return { width: w, height: h, data: out };
  const b = growBox(box, r + 1, w, h);
  const bw = b.x1 - b.x0 + 1;
  const bh = b.y1 - b.y0 + 1;
  const gray = new Float32Array(bw * bh);
  const src = new Float32Array(bw * bh);
  const d = img.data;
  for (let y = 0; y < bh; y += 1) for (let x = 0; x < bw; x += 1) {
    const i = (y + b.y0) * w + (x + b.x0);
    gray[y * bw + x] = (0.2126 * d[3 * i]! + 0.7152 * d[3 * i + 1]! + 0.0722 * d[3 * i + 2]!) / 255;
    src[y * bw + x] = labels[i]!;
  }
  const f = guidedFilter(gray, src, bw, bh, r, 1e-3);
  for (let y = 0; y < bh; y += 1) for (let x = 0; x < bw; x += 1) {
    const i = (y + b.y0) * w + (x + b.x0);
    if (!band[i]) continue;
    const v = f[y * bw + x]!;
    // The edge may soften but not flip: keep each side on its side of ½.
    const clamped = labels[i] ? Math.max(0.5, v) : Math.min(0.5, v);
    out[i] = Math.round(Math.min(1, Math.max(0, clamped)) * 255);
  }
  return { width: w, height: h, data: out };
}

/**
 * How well the colour models agree with the labels along the edge: 1 when
 * every edge pixel's colour says the side it is on, 0 when colour is no help.
 */
export function separation(img: RGBImage, model: ColorModel, labels: Uint8Array, r: number, sd?: Float32Array): number {
  const w = img.width;
  const h = img.height;
  const band = sd ? bandFrom(sd, r) : edgeBand(labels, w, h, r);
  const d = img.data;
  let agree = 0;
  let n = 0;
  for (let i = 0; i < labels.length; i += 1) {
    if (!band[i]) continue;
    const bin = binOf(d[3 * i]!, d[3 * i + 1]!, d[3 * i + 2]!);
    const post = 1 / (1 + Math.exp(Math.max(-50, Math.min(50, model.fg[bin]! - model.bg[bin]!))));
    agree += labels[i] ? post : 1 - post;
    n += 1;
  }
  if (!n) return 0;
  return Math.min(1, Math.max(0, (agree / n - 0.5) / 0.45));
}

/**
 * The share of the ring just outside the matte (r … 3r beyond its edge) whose
 * colour says subject: high when a piece of the subject was left out (a limb
 * cut off), near zero when the matte holds all of it.
 */
export function leakage(img: RGBImage, model: ColorModel, sd: Float32Array, r: number): number {
  const d = img.data;
  let ring = 0;
  let subject = 0;
  for (let i = 0; i < sd.length; i += 1) {
    const v = sd[i]!;
    if (v <= r || v > 3 * r) continue;
    ring += 1;
    const bin = binOf(d[3 * i]!, d[3 * i + 1]!, d[3 * i + 2]!);
    if (model.bg[bin]! - model.fg[bin]! > 1.4) subject += 1;
  }
  return ring ? subject / ring : 0;
}

function fitFromLabels(img: RGBImage, labels: Uint8Array, seeds: Uint8Array | null, k: number): ColorModel | null {
  const w = img.width;
  const h = img.height;
  const fg = morph(labels, w, h, -1);
  const bg = morph(labels, w, h, 1);
  for (let i = 0; i < bg.length; i += 1) bg[i] = bg[i] ? 0 : 1;
  if (seeds) for (let i = 0; i < seeds.length; i += 1) {
    if (seeds[i] === SEED_INCLUDE) fg[i] = 1;
    if (seeds[i] === SEED_EXCLUDE) bg[i] = 1;
  }
  return fitColorModel(img, fg, bg, { k });
}

interface FramePyramid {
  frame: number;
  levels: PyramidLevel[];
}

export class TrackEngine implements SegmentationEngine {
  readonly id = 'track' as const;
  readonly version = TRACK_VERSION;
  readonly label = 'Track (classical)';
  private model: ColorModel | null = null;
  private pyramids: FramePyramid[] = [];

  async key(req: KeyRequest): Promise<EngineResult> {
    const s = trackSettings(req.settings);
    const img = req.image;
    const w = img.width;
    const h = img.height;
    if (req.strokes.length === 0) {
      if (!req.reference) throw new Error('Nothing to segment: no strokes and no reference matte');
      const labels = binarize(req.reference);
      this.model = fitFromLabels(img, labels, null, s.components);
      const conf = this.model ? separation(img, this.model, labels, this.edgeRadius(w)) : 0;
      return { mask: req.reference, confidence: conf, detail: { separation: conf } };
    }
    const seeds = rasterizeStrokes(req.strokes, w, h);
    if (req.reference && maskArea(req.reference)) return this.edit(img, req.reference, seeds, req.strokes, s);
    let include = 0;
    for (let i = 0; i < seeds.length; i += 1) if (seeds[i] === SEED_INCLUDE) include += 1;
    if (!include) throw new Error('Paint some of the subject in (Include) on the key frame.');

    // 1. Coarse, whole-frame GrabCut.
    const cw = Math.min(w, Math.max(64, Math.round(s.coarseWidth)));
    const ch = Math.max(1, Math.round((h * cw) / w));
    const small = resizeRGB(img, cw, ch);
    const cs = cw / w;
    const coarseStrokes = scaleStrokes(req.strokes, cs, ch / h);
    const cseeds = rasterizeStrokes(coarseStrokes, cw, ch);
    const inc = new Uint8Array(cw * ch);
    for (let i = 0; i < inc.length; i += 1) inc[i] = cseeds[i] === SEED_INCLUDE ? 1 : 0;
    const incBox = bbox(inc, cw, ch)!;
    const maxRadius = Math.max(...coarseStrokes.map((x) => x.radius));
    const reach = Math.max(12, 3 * maxRadius, 0.35 * Math.hypot(incBox.x1 - incBox.x0, incBox.y1 - incBox.y0));
    const d2 = squaredDistance(inc, cw, ch);
    const prior = new Float32Array(cw * ch);
    const bgInit = new Uint8Array(cw * ch);
    for (let i = 0; i < prior.length; i += 1) {
      const dist = Math.sqrt(d2[i]!);
      prior[i] = 0.5 * Math.exp(-dist / reach) + 0.02;
      bgInit[i] = cseeds[i] === SEED_EXCLUDE || dist > reach ? 1 : 0;
    }
    let model = fitColorModel(small, inc, bgInit, { k: s.components });
    if (!model) throw new Error('Too little was painted to learn the subject’s colours. Paint a larger area.');
    let labels: Uint8Array = new Uint8Array(cw * ch);
    const whole: Box = { x0: 0, y0: 0, x1: cw - 1, y1: ch - 1 };
    const iterations = Math.max(1, Math.round(s.grabcutIterations));
    for (let it = 0; it < iterations; it += 1) {
      cut(small, model, cseeds, prior, s.prior * 0.5, s.gamma, whole, labels);
      labels = cleanSegmentation(labels, cw, ch, inc, { maxHole: Math.round(0.002 * cw * ch), protect: excludeOf(cseeds) });
      if (it < iterations - 1) model = fitFromLabels(small, labels, cseeds, s.components) ?? model;
    }

    // 2. Working resolution, in a band around the coarse edge.
    const up = resizePlane(Float32Array.from(labels), cw, ch, w, h);
    const coarseLabels = new Uint8Array(w * h);
    for (let i = 0; i < up.length; i += 1) coarseLabels[i] = up[i]! >= 0.5 ? 1 : 0;
    this.model = fitFromLabels(img, coarseLabels, seeds, s.components) ?? model;
    const r = Math.ceil(2 * (w / cw)) + 2;
    const fineBox = bbox(coarseLabels, w, h);
    if (!fineBox) throw new Error('Nothing was found where you painted. Paint more of the subject in, or some of the background out.');
    const R = growBox(fineBox, 4 * r + 4, w, h);
    const rw = R.x1 - R.x0 + 1;
    const rh = R.y1 - R.y0 + 1;
    const sub = cropRGB(img, R);
    const subSeeds = cropU8(seeds, w, R);
    const fine = this.refineBand(sub, cropU8(coarseLabels, w, R), subSeeds, r, s, null);
    const cleaned = cleanSegmentation(fine, rw, rh, includeOf(subSeeds), { maxHole: Math.round(0.002 * w * h), protect: excludeOf(subSeeds) });
    const full = pasteU8(cleaned, R, w, h);
    this.model = fitFromLabels(img, full, seeds, s.components) ?? this.model;
    this.pyramids = [];
    const er = this.edgeRadius(w);
    const sep = separation(sub, this.model, cleaned, er);
    return { mask: { width: w, height: h, data: pasteU8(softEdge(sub, cleaned, er).data, R, w, h) }, confidence: sep, detail: { separation: sep } };
  }

  async step(req: StepRequest): Promise<EngineResult> {
    const s = trackSettings(req.settings);
    const img = req.next;
    const w = img.width;
    const h = img.height;
    if (!this.model) {
      this.model = fitFromLabels(req.prev, binarize(req.prevMask), null, s.components);
      if (!this.model) throw new Error('The previous matte is too small to learn colours from');
    }
    const prevBin = binarize(req.prevMask);
    const prevArea = maskArea(prevBin);
    const empty = { mask: { width: w, height: h, data: new Uint8Array(w * h) }, confidence: 0, detail: { area: 0 } };
    if (!prevArea) return empty;

    // Flow, measured at ≤ flowWidth around where the subject was.
    const fw = Math.min(w, Math.max(64, Math.round(s.flowWidth)));
    const fh = Math.max(1, Math.round((h * fw) / w));
    const k = fw / w;
    const prevPyr = this.pyramid(req.prevFrame, req.prev, fw, fh);
    const nextPyr = this.pyramid(req.nextFrame, img, fw, fh);
    const box = bbox(prevBin, w, h)!;
    const margin = 0.08 * fw + 16;
    const smallMask = new Uint8Array(fw * fh);
    for (let y = 0; y < fh; y += 1) for (let x = 0; x < fw; x += 1) smallMask[y * fw + x] = sampleU8(req.prevMask.data, w, h, (x + 0.5) / k - 0.5, (y + 0.5) / k - 0.5) >= 0.5 ? 1 : 0;
    const motion = estimateObjectMotion(prevPyr, nextPyr, smallMask, { step: Math.max(4, Math.round(fw / 160)), levels: 4, win: 4 });

    // Everything after the motion happens in a region around the subject (working pixels).
    const moved = motion.forward(((box.x0 + box.x1) / 2) * k, ((box.y0 + box.y1) / 2) * k);
    const R = growBox(
      { x0: Math.min(box.x0, box.x0 + moved[0] / k), y0: Math.min(box.y0, box.y0 + moved[1] / k), x1: Math.max(box.x1, box.x1 + moved[0] / k), y1: Math.max(box.y1, box.y1 + moved[1] / k) },
      margin / k,
      w,
      h,
    );
    const rw = R.x1 - R.x0 + 1;
    const rh = R.y1 - R.y0 + 1;
    const sub = cropRGB(img, R);
    const warped = new Float32Array(rw * rh);
    const warpedBin = new Uint8Array(rw * rh);
    // The backward map is smooth: evaluate it every 4 px and interpolate.
    const G = 4;
    const gw = Math.ceil(rw / G) + 1;
    const gh = Math.ceil(rh / G) + 1;
    const mapU = new Float32Array(gw * gh);
    const mapV = new Float32Array(gw * gh);
    for (let j = 0; j < gh; j += 1) for (let i = 0; i < gw; i += 1) {
      const [bu, bv] = motion.backward((R.x0 + i * G) * k, (R.y0 + j * G) * k);
      mapU[j * gw + i] = bu / k;
      mapV[j * gw + i] = bv / k;
    }
    for (let y = 0; y < rh; y += 1) for (let x = 0; x < rw; x += 1) {
      const bu = sampleBilinear(mapU, gw, gh, x / G, y / G);
      const bv = sampleBilinear(mapV, gw, gh, x / G, y / G);
      const a = sampleU8(req.prevMask.data, w, h, x + R.x0 + bu, y + R.y0 + bv);
      warped[y * rw + x] = a;
      warpedBin[y * rw + x] = a >= 0.5 ? 1 : 0;
    }
    const flow = { consistency: motion.consistency, trackable: motion.trackable, fbError: motion.fitError };
    // Few tracks: the shift alone carried the matte; give the re-cut more room.
    const uncertain = motion.tracks < 12 || motion.consistency < 0.3;
    if (!maskArea(warpedBin)) return { ...empty, detail: { area: 0, flow: flow.consistency } };

    const base = s.band > 0 ? s.band : Math.max(4, Math.round(w / 240));
    const r = Math.round(base + Math.min(2 * base, flow.fbError / k) + (uncertain ? base : 0));
    const warpedSd = signedDistance(warpedBin, rw, rh, 4 * r);
    let fine = this.refineBand(sub, warpedBin, null, r, s, warpedSd);
    // A part moving faster than the band (a swinging leg) pushes the cut against the band's rim:
    // re-centre the band on the cut and solve again, a few times at most.
    let sd = warpedSd;
    let grown = 0;
    for (let it = 0; it < 4; it += 1) {
      let rim = 0;
      let push = 0;
      for (let i = 0; i < fine.length; i += 1) {
        const d = sd[i]!;
        if (d > r - 1.5 && d <= r) {
          rim += 1;
          if (fine[i]) push += 1;
        } else if (d < -(r - 1.5) && d >= -r) {
          rim += 1;
          if (!fine[i]) push += 1;
        }
      }
      // A few pixels pushing is enough: a limb is a small part of a long rim.
      if (!rim || push < Math.max(6, 0.004 * rim)) break;
      sd = signedDistance(fine, rw, rh, 4 * r);
      fine = this.refineBand(sub, fine, null, r, s, sd);
      grown += 1;
    }
    const core = new Uint8Array(rw * rh);
    for (let i = 0; i < core.length; i += 1) core[i] = warpedSd[i]! <= -r ? 1 : 0;
    const labels = cleanSegmentation(fine, rw, rh, maskArea(core) ? core : warpedBin, { maxHole: Math.round(0.002 * w * h) });
    const area = maskArea(labels);
    const er = this.edgeRadius(w);
    const labelSd = signedDistance(labels, rw, rh, 3 * r + 2);
    const soft = softEdge(sub, labels, er, labelSd);
    if (req.smoothing > 0) {
      const out = soft.data;
      for (let i = 0; i < out.length; i += 1) if (Math.abs(labelSd[i]!) <= r) out[i] = Math.round((1 - req.smoothing) * out[i]! + req.smoothing * 255 * Math.min(1, Math.max(0, warped[i]!)));
    }
    const mask: Mask = { width: w, height: h, data: pasteU8(soft.data, R, w, h) };

    const sep = separation(sub, this.model, labels, er, labelSd);
    const leak = leakage(sub, this.model, labelSd, r);
    // How well the subject's appearance matched after the move (sensor noise alone costs ≈ 0.001), and how many tracks agreed.
    const match = Math.exp(-motion.matchCost / 0.004);
    const flowScore = uncertain ? match : 0.5 * match + 0.5 * Math.min(1, flow.consistency / 0.6);
    const shape = iou(warpedBin, labels);
    const change = Math.abs(Math.log(Math.max(1, area) / prevArea));
    let confidence = 0.4 * sep + 0.2 * flowScore + 0.25 * shape + 0.15 * (1 - Math.min(1, 4 * leak));
    confidence *= Math.exp(-3 * Math.max(0, change - 0.15));
    if (!area) confidence = 0;
    return { mask, confidence: Math.min(1, Math.max(0, confidence)), detail: { separation: sep, flow: flowScore, match, tracks: motion.tracks, shape, leak, regrown: grown, areaChange: change, band: r } };
  }

  dispose(): void {
    this.model = null;
    this.pyramids = [];
  }

  /**
   * A correction: the frame's matte, edited around the new paint. Only pixels
   * near a stroke are re-solved (growing outward while the cut pushes against
   * the edge of that region, e.g. to take in a missing limb); everything else
   * keeps the matte it had.
   */
  private edit(img: RGBImage, reference: Mask, seeds: Uint8Array, strokes: KeyRequest['strokes'], s: TrackSettings): EngineResult {
    const w = img.width;
    const h = img.height;
    const ref = binarize(reference.width === w && reference.height === h ? reference : { width: w, height: h, data: new Uint8Array(w * h) });
    const start = ref.slice();
    let painted = 0;
    for (let i = 0; i < seeds.length; i += 1) {
      if (seeds[i] === SEED_INCLUDE) start[i] = 1;
      if (seeds[i] === SEED_EXCLUDE) start[i] = 0;
      if (seeds[i]) painted = 1;
    }
    if (!painted) return { mask: reference, confidence: 0, detail: {} };
    this.model = fitFromLabels(img, start, seeds, s.components) ?? this.model;
    if (!this.model) throw new Error('The matte is too small to learn colours from');
    const maxRadius = Math.max(...strokes.map((x) => x.radius));
    const reach = Math.max(4 * maxRadius, 4 * Math.max(4, Math.round(w / 240)));
    const strokeMask = new Uint8Array(w * h);
    for (let i = 0; i < seeds.length; i += 1) strokeMask[i] = seeds[i] ? 1 : 0;
    const d2 = squaredDistance(strokeMask, w, h);
    let free: Uint8Array = new Uint8Array(w * h);
    for (let i = 0; i < free.length; i += 1) free[i] = d2[i]! <= reach * reach ? 1 : 0;
    let labels = start;
    for (let it = 0; it < 4; it += 1) {
      const hard = new Uint8Array(w * h);
      for (let i = 0; i < hard.length; i += 1) hard[i] = seeds[i] ? seeds[i]! : free[i] ? 0 : start[i] ? SEED_INCLUDE : SEED_EXCLUDE;
      const sd = signedDistance(start, w, h, reach + 2);
      const prior = new Float32Array(w * h);
      const tau = Math.max(2, reach / 4);
      for (let i = 0; i < prior.length; i += 1) prior[i] = 1 / (1 + Math.exp(sd[i]! / tau));
      const open = new Uint8Array(w * h);
      for (let i = 0; i < open.length; i += 1) open[i] = hard[i] ? 0 : 1;
      const box = bbox(open, w, h);
      if (!box) break;
      labels = start.slice();
      cut(img, this.model, hard, prior, s.prior * 0.5, s.gamma, growBox(box, 1, w, h), labels);
      // Pushing outward: on the free region's rim, the cut disagrees with the matte held beyond it.
      let rim = 0;
      let push = 0;
      for (let i = 0; i < labels.length; i += 1) {
        if (!free[i] || seeds[i]) continue;
        const x = i % w;
        const edge = !free[i - 1] || !free[i + 1] || (i >= w && !free[i - w]) || (i + w < free.length && !free[i + w]) || x === 0 || x === w - 1;
        if (!edge) continue;
        rim += 1;
        if (labels[i] !== start[i]) push += 1;
      }
      if (push < Math.max(6, 0.004 * rim)) break;
      free = morph(free, w, h, reach);
    }
    const include = new Uint8Array(w * h);
    for (let i = 0; i < include.length; i += 1) include[i] = seeds[i] === SEED_INCLUDE || (ref[i] && !seeds[i]) ? 1 : 0;
    const exclude = new Uint8Array(w * h);
    for (let i = 0; i < exclude.length; i += 1) exclude[i] = seeds[i] === SEED_EXCLUDE ? 1 : 0;
    const cleaned = cleanSegmentation(labels, w, h, include, { maxHole: Math.round(0.002 * w * h), protect: exclude });
    this.pyramids = [];
    const er = this.edgeRadius(w);
    const sep = separation(img, this.model, cleaned, er);
    return { mask: softEdge(img, cleaned, er), confidence: sep, detail: { separation: sep, edited: 1 } };
  }

  private edgeRadius(w: number): number {
    return Math.max(1, Math.round(w / 640));
  }

  private pyramid(frame: number, img: RGBImage, fw: number, fh: number): PyramidLevel[] {
    const hit = this.pyramids.find((p) => p.frame === frame && p.levels[0]!.w === fw);
    if (hit) return hit.levels;
    const full = toGray(img);
    const gray = fw === img.width ? full : areaDownscale(full, img.width, img.height, fw, fh);
    const levels = buildPyramid(gray, fw, fh, 4);
    this.pyramids = [...this.pyramids.slice(-1), { frame, levels }];
    return levels;
  }

  /** Re-segment a band of radius r around the edge of `labels`; everything else is held. */
  private refineBand(img: RGBImage, labels: Uint8Array, seeds: Uint8Array | null, r: number, s: TrackSettings, sd: Float32Array | null): Uint8Array {
    const w = img.width;
    const h = img.height;
    const dist = sd ?? signedDistance(labels, w, h, 4 * r);
    const hard = new Uint8Array(w * h);
    const prior = new Float32Array(w * h);
    const tau = Math.max(1, r / 2);
    let any = false;
    for (let i = 0; i < hard.length; i += 1) {
      const inBand = Math.abs(dist[i]!) <= r;
      if (!inBand) hard[i] = labels[i] ? SEED_INCLUDE : SEED_EXCLUDE;
      else any = true;
      if (seeds && seeds[i]) hard[i] = seeds[i]!;
      prior[i] = 1 / (1 + Math.exp(dist[i]! / tau));
    }
    const out = labels.slice();
    if (!any) return out;
    const band = new Uint8Array(w * h);
    for (let i = 0; i < band.length; i += 1) band[i] = hard[i] ? 0 : 1;
    const b = bbox(band, w, h);
    if (!b) return out;
    cut(img, this.model!, hard, prior, s.prior, s.gamma, growBox(b, 1, w, h), out);
    return out;
  }
}

function includeOf(seeds: Uint8Array): Uint8Array {
  const out = new Uint8Array(seeds.length);
  for (let i = 0; i < seeds.length; i += 1) out[i] = seeds[i] === SEED_INCLUDE ? 1 : 0;
  return out;
}

function excludeOf(seeds: Uint8Array): Uint8Array {
  const out = new Uint8Array(seeds.length);
  for (let i = 0; i < seeds.length; i += 1) out[i] = seeds[i] === SEED_EXCLUDE ? 1 : 0;
  return out;
}
