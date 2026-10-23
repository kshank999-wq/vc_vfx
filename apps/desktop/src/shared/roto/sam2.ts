import type { EngineResult, KeyRequest, SegmentationEngine, StepRequest, SubjectPrompt } from './engine';
import { buildPyramid, maskedTranslation } from './flow';
import { areaDownscale, bbox, binarize, iou, maskArea, resizeMask, resizePlane, squaredDistance, toGray, type Mask, type RGBImage } from './image';
import { samplePoints, type EngineStroke } from './strokes';

/**
 * The SAM 2 engine (addendum 04): Segment Anything 2.1 image encoder and
 * prompt decoder, exported to ONNX in the layout of vietanhdev/samexporter
 * (`export_sam2.py`):
 *
 *   encoder  in:  image             float32 [1, 3, 1024, 1024]  RGB resized to 1024² (aspect not kept),
 *                                                                (x / 255 − mean) / std, ImageNet mean/std
 *            out: high_res_feats_0  [1, 32, 256, 256]
 *                 high_res_feats_1  [1, 64, 128, 128]
 *                 image_embed       [1, 256, 64, 64]
 *   decoder  in:  image_embed, high_res_feats_0, high_res_feats_1,
 *                 point_coords      float32 [L, N, 2]  in 1024² input pixels
 *                 point_labels      float32 [L, N]     1 positive, 0 negative, 2/3 box corners, −1 padding
 *                 mask_input        float32 [L, 1, 256, 256]  low-resolution logits of a previous mask
 *                 has_mask_input    float32 [L]
 *            out: masks             float32 [L, 3, 256, 256]  logits (multimask)
 *                 iou_predictions   float32 [L, 3]
 *
 * Propagation prompts each frame from the previous frame's matte (its box,
 * interior points and the previous low-resolution logits) — not SAM 2's
 * memory-attention video predictor, which is a later upgrade. Confidence is
 * the decoder's own IoU prediction blended with the temporal IoU against the
 * previous matte.
 *
 * Everything here is pure; inference is behind `Sam2Runtime`, which the
 * desktop implements with onnxruntime-node (main/roto/sam2-ort.ts). The
 * pre- and post-processing are unit-tested; inference on real weights runs
 * in an integration test when the model is on disk (addendum 18).
 */

/** The engine's version; the model it runs is appended (`sam2.1_hiera_tiny`). /2: box and point prompts (addendum 18). */
export const SAM2_VERSION = 'onnx/2';
export const sam2EngineVersion = (model: string) => `${model}/${SAM2_VERSION}`;
export const SAM2_INPUT = 1024;
export const SAM2_LOWRES = 256;
export const SAM2_MEAN = [0.485, 0.456, 0.406] as const;
export const SAM2_STD = [0.229, 0.224, 0.225] as const;

export interface Sam2Embedding {
  imageEmbed: Float32Array;
  highRes0: Float32Array;
  highRes1: Float32Array;
  /** Tensor shapes as the encoder gave them. */
  dims?: { imageEmbed: number[]; highRes0: number[]; highRes1: number[] };
}

export interface Sam2Prompt {
  /** N × 2, in 1024² model input pixels. */
  coords: Float32Array;
  /** N labels: 1 positive, 0 negative, 2 / 3 box corners. */
  labels: Float32Array;
  /** 256 × 256 logits of a previous mask, or null. */
  maskInput: Float32Array | null;
}

export interface Sam2Decoded {
  /** count × 256 × 256 logits. */
  masks: Float32Array;
  ious: Float32Array;
  count: number;
}

export interface Sam2Runtime {
  encode(pixels: Float32Array): Promise<Sam2Embedding>;
  decode(embedding: Sam2Embedding, prompt: Sam2Prompt): Promise<Sam2Decoded>;
  dispose?(): void;
}

/** The encoder's input: bilinear resize to 1024², normalised, planar RGB. */
export function sam2Preprocess(img: RGBImage): Float32Array {
  const S = SAM2_INPUT;
  const out = new Float32Array(3 * S * S);
  const sx = img.width / S;
  const sy = img.height / S;
  const d = img.data;
  for (let y = 0; y < S; y += 1) {
    const fy = Math.min(img.height - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(img.height - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < S; x += 1) {
      const fx = Math.min(img.width - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(img.width - 1, x0 + 1);
      const wx = fx - x0;
      for (let c = 0; c < 3; c += 1) {
        const a = d[(y0 * img.width + x0) * 3 + c]!;
        const b = d[(y0 * img.width + x1) * 3 + c]!;
        const e = d[(y1 * img.width + x0) * 3 + c]!;
        const f = d[(y1 * img.width + x1) * 3 + c]!;
        const v = (a + (b - a) * wx + (e - a + (f - b - e + a) * wx) * wy) / 255;
        out[c * S * S + y * S + x] = (v - SAM2_MEAN[c]!) / SAM2_STD[c]!;
      }
    }
  }
  return out;
}

/** Image pixels → model input pixels (the resize does not keep aspect, so x and y scale apart). */
export function toModelCoords(points: readonly (readonly [number, number])[], w: number, h: number): Float32Array {
  const out = new Float32Array(points.length * 2);
  points.forEach(([x, y], i) => {
    out[2 * i] = (x / w) * SAM2_INPUT;
    out[2 * i + 1] = (y / h) * SAM2_INPUT;
  });
  return out;
}

/** Model input pixels → image pixels. */
export function fromModelCoords(coords: Float32Array, w: number, h: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < coords.length; i += 2) out.push([(coords[i]! / SAM2_INPUT) * w, (coords[i + 1]! / SAM2_INPUT) * h]);
  return out;
}

/** Points sampled from the paint: include strokes positive, exclude negative. */
export function promptFromStrokes(strokes: readonly EngineStroke[], w: number, h: number, options: { positives?: number; negatives?: number } = {}): Sam2Prompt {
  const pos = samplePoints(strokes, 'include', options.positives ?? 6);
  const neg = samplePoints(strokes, 'exclude', options.negatives ?? 4);
  const pts = [...pos, ...neg];
  return { coords: toModelCoords(pts, w, h), labels: Float32Array.from([...pos.map(() => 1), ...neg.map(() => 0)]), maskInput: null };
}

/** A subject prompt (box corners labelled 2 / 3, points 1 / 0) in image pixels → model input. */
export function promptFromSubject(p: SubjectPrompt, w: number, h: number): Sam2Prompt | null {
  const pts: [number, number][] = [];
  const labels: number[] = [];
  for (const q of p.points ?? []) {
    pts.push([q.x, q.y]);
    labels.push(q.label);
  }
  if (p.box && p.box.x1 > p.box.x0 && p.box.y1 > p.box.y0) {
    pts.push([p.box.x0, p.box.y0], [p.box.x1, p.box.y1]);
    labels.push(2, 3);
  }
  if (!pts.length) return null;
  return { coords: toModelCoords(pts, w, h), labels: Float32Array.from(labels), maskInput: null };
}

/**
 * Prompts from the previous frame's matte: its box (corners labelled 2 and 3),
 * up to `interior` positive points at the deepest interior pixels (spread
 * apart), and the previous low-resolution logits as mask input.
 */
export function promptFromMask(mask: Mask, previousLogits: Float32Array | null, options: { interior?: number } = {}): Sam2Prompt | null {
  const { width: w, height: h } = mask;
  const bin = binarize(mask);
  const box = bbox(bin, w, h);
  if (!box) return null;
  const inv = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) inv[i] = bin[i] ? 0 : 1;
  const depth = squaredDistance(inv, w, h);
  const want = options.interior ?? 3;
  const chosen: [number, number][] = [];
  const minApart = 0.25 * Math.max(box.x1 - box.x0, box.y1 - box.y0);
  // The deepest pixel, then the deepest one far enough from those chosen; one pass each.
  for (let k = 0; k < want; k += 1) {
    let best = -1;
    for (let i = 0; i < bin.length; i += 1) {
      if (!bin[i] || (best >= 0 && depth[i]! <= depth[best]!)) continue;
      const x = (i % w) + 0.5;
      const y = Math.floor(i / w) + 0.5;
      if (chosen.every(([cx, cy]) => Math.hypot(cx - x, cy - y) >= minApart)) best = i;
    }
    if (best < 0) break;
    chosen.push([(best % w) + 0.5, Math.floor(best / w) + 0.5]);
  }
  const corners: [number, number][] = [
    [box.x0, box.y0],
    [box.x1 + 1, box.y1 + 1],
  ];
  const pts = [...chosen, ...corners];
  return {
    coords: toModelCoords(pts, w, h),
    labels: Float32Array.from([...chosen.map(() => 1), 2, 3]),
    maskInput: previousLogits ?? maskToLogits(mask),
  };
}

/** A matte as decoder mask input: resized to 256² (aspect not kept, like the image), ±10 logits. */
export function maskToLogits(mask: Mask): Float32Array {
  const plane = new Float32Array(mask.data.length);
  for (let i = 0; i < plane.length; i += 1) plane[i] = mask.data[i]! / 255;
  const small = resizePlane(plane, mask.width, mask.height, SAM2_LOWRES, SAM2_LOWRES);
  for (let i = 0; i < small.length; i += 1) small[i] = small[i]! >= 0.5 ? 10 : -10;
  return small;
}

/** Low-resolution logits (256²) at image size, bilinear with pixel centres aligned (align_corners = false). */
export function upsampleLogits(logits: Float32Array, w: number, h: number, size = SAM2_LOWRES): Float32Array {
  return resizePlane(logits, size, size, w, h);
}

/** Logits → matte: sigmoid, so the edge keeps the decoder's own softness; 0 logit is ½. */
export function logitsToMask(up: Float32Array, w: number, h: number): Mask {
  const data = new Uint8Array(w * h);
  for (let i = 0; i < data.length; i += 1) {
    const v = up[i]!;
    data[i] = v > 8 ? 255 : v < -8 ? 0 : Math.round(255 / (1 + Math.exp(-v)));
  }
  return { width: w, height: h, data };
}

export function pickBest(ious: Float32Array): number {
  let best = 0;
  for (let i = 1; i < ious.length; i += 1) if (ious[i]! > ious[best]!) best = i;
  return best;
}

/** A matte moved by (dx, dy) pixels (whole pixels; what leaves the frame is lost). */
export function shiftMask(m: Mask, dx: number, dy: number): Mask {
  const { width: w, height: h } = m;
  const ix = Math.round(dx);
  const iy = Math.round(dy);
  if (!ix && !iy) return m;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1) {
    const sy = y - iy;
    if (sy < 0 || sy >= h) continue;
    for (let x = 0; x < w; x += 1) {
      const sx = x - ix;
      if (sx >= 0 && sx < w) out[y * w + x] = m.data[sy * w + sx]!;
    }
  }
  return { width: w, height: h, data: out };
}

/**
 * How far the subject moved between two frames: masked block matching on the
 * previous matte's pixels (flow.ts), on a copy at most 480 px wide. Per-frame
 * prompting from where the subject *was* fails on fast movers (a runner
 * moves a quarter of his width a frame): the box and interior points must be
 * where it *is*.
 */
export function subjectShift(prev: RGBImage, next: RGBImage, prevMask: Mask): [number, number] {
  const f = Math.min(1, 480 / prev.width);
  const fw = Math.max(16, Math.round(prev.width * f));
  const fh = Math.max(16, Math.round(prev.height * f));
  const gray = (img: RGBImage) => {
    const g = toGray(img);
    return fw === img.width ? g : areaDownscale(g, img.width, img.height, fw, fh);
  };
  const m = fw === prevMask.width ? prevMask : resizeMask(prevMask, fw, fh);
  const bin = binarize(m);
  if (!maskArea(bin)) return [0, 0];
  const t = maskedTranslation(buildPyramid(gray(prev), fw, fh, 4), buildPyramid(gray(next), fw, fh, 4), bin, Math.max(8, Math.round(fw / 6)));
  return [t.dx / f, t.dy / f];
}

/** Decoder IoU blended with temporal IoU against the previous matte (when there is one). */
export function sam2Confidence(predictedIou: number, temporalIou: number | null): number {
  const p = Math.min(1, Math.max(0, predictedIou));
  const c = temporalIou === null ? p : 0.6 * p + 0.4 * Math.min(1, Math.max(0, temporalIou));
  return Math.min(1, Math.max(0, c));
}

export class Sam2Engine implements SegmentationEngine {
  readonly id = 'sam2' as const;
  readonly version: string;
  readonly label: string;
  private lastLogits: Float32Array | null = null;

  constructor(
    private readonly runtime: Sam2Runtime,
    readonly model = 'sam2.1_hiera_tiny',
  ) {
    this.version = sam2EngineVersion(model);
    this.label = model.startsWith('sam2.1') ? 'SAM 2.1 (AI)' : 'SAM 2 (AI)';
  }

  private async run(image: RGBImage, prompt: Sam2Prompt): Promise<{ mask: Mask; iou: number; logits: Float32Array }> {
    const embedding = await this.runtime.encode(sam2Preprocess(image));
    const out = await this.runtime.decode(embedding, prompt);
    const plane = SAM2_LOWRES * SAM2_LOWRES;
    const best = pickBest(out.ious.subarray(0, out.count));
    const logits = out.masks.slice(best * plane, (best + 1) * plane);
    return { mask: logitsToMask(upsampleLogits(logits, image.width, image.height), image.width, image.height), iou: out.ious[best]!, logits };
  }

  async key(req: KeyRequest): Promise<EngineResult> {
    const seeded = req.prompt ? promptFromSubject(req.prompt, req.image.width, req.image.height) : null;
    if (seeded) {
      // A box / clicks on the subject (the key's subject seed): with paint as well, both prompt.
      const paint = req.strokes.length ? promptFromStrokes(req.strokes, req.image.width, req.image.height) : null;
      const prompt = paint ? { coords: Float32Array.from([...paint.coords, ...seeded.coords]), labels: Float32Array.from([...paint.labels, ...seeded.labels]), maskInput: null } : seeded;
      const r = await this.run(req.image, prompt);
      this.lastLogits = r.logits;
      return { mask: r.mask, confidence: sam2Confidence(r.iou, null), detail: { predictedIou: r.iou } };
    }
    if (!req.strokes.length) {
      if (!req.reference) throw new Error('Nothing to segment: no strokes and no reference matte');
      this.lastLogits = maskToLogits(req.reference);
      return { mask: req.reference, confidence: 1, detail: { reference: 1 } };
    }
    const fromPaint = promptFromStrokes(req.strokes, req.image.width, req.image.height);
    // A correction: the frame's matte goes in as mask input, the paint as points.
    const editing = req.reference && maskArea(req.reference) ? maskToLogits(req.reference) : null;
    if (!editing && !req.strokes.some((s) => s.mode === 'include')) throw new Error('Paint some of the subject in (Include) on the key frame.');
    const r = await this.run(req.image, editing ? { ...fromPaint, maskInput: editing } : fromPaint);
    this.lastLogits = r.logits;
    return { mask: r.mask, confidence: sam2Confidence(r.iou, null), detail: { predictedIou: r.iou } };
  }

  async step(req: StepRequest): Promise<EngineResult> {
    // Prompt where the subject is now: the previous matte moved by the subject's own motion.
    const [dx, dy] = subjectShift(req.prev, req.next, req.prevMask);
    const moved = Math.hypot(dx, dy) >= 1;
    const expected = moved ? shiftMask(req.prevMask, dx, dy) : req.prevMask;
    const prompt = promptFromMask(expected, moved ? null : this.lastLogits);
    const { width: w, height: h } = req.next;
    if (!prompt) return { mask: { width: w, height: h, data: new Uint8Array(w * h) }, confidence: 0, detail: { area: 0 } };
    const r = await this.run(req.next, prompt);
    this.lastLogits = r.logits;
    const temporal = iou(binarize(expected), binarize(r.mask));
    const area = maskArea(r.mask);
    return { mask: r.mask, confidence: area ? sam2Confidence(r.iou, temporal) : 0, detail: { predictedIou: r.iou, temporal, dx, dy } };
  }

  dispose(): void {
    this.runtime.dispose?.();
    this.lastLogits = null;
  }
}
