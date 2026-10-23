import type { KeySubjectPoint, KeyRect } from '@vcvfx/domain';
import { CancelledError, type SegmentationEngine, type SubjectPrompt } from '../roto/engine';
import { bbox, components, maskArea, morph, squaredDistance, type Mask, type RGBImage } from '../roto/image';
import type { EngineStroke } from '../roto/strokes';

/**
 * The Auto subject segmentation of the hybrid key (addendum 18): a roto engine
 * (SAM 2, or Track when SAM 2 is not installed) run over the shot from one
 * seed frame. The seed is the operator's box / clicks, or — by default — the
 * key's own confident foreground on that frame: the largest solid, compact
 * region the key finds (thin things like light stands are opened away),
 * preferring the centre of the frame.
 */

export interface SubjectSeed {
  /** For SAM 2: a box and/or clicks (working pixels). */
  prompt: SubjectPrompt;
  /** For Track: paint (working pixels) — include on the subject, exclude on clean screen round it. */
  strokes: EngineStroke[];
  /** Where it came from. */
  seededBy: 'operator' | 'key';
}

/** The operator's box / clicks (plate pixels) as a seed at working size. */
export function seedFromOperator(box: KeyRect | null, points: readonly KeySubjectPoint[], pxScale: number, w: number, h: number): SubjectSeed | null {
  if (!box && !points.length) return null;
  const s = (v: number) => v / pxScale;
  const prompt: SubjectPrompt = {
    ...(box ? { box: { x0: s(box.x0), y0: s(box.y0), x1: s(box.x1), y1: s(box.y1) } } : {}),
    points: points.map((p) => ({ x: s(p.x), y: s(p.y), label: p.label })),
  };
  const r = Math.max(2, w / 160);
  const strokes: EngineStroke[] = [];
  const inc = points.filter((p) => p.label === 1).map((p) => [s(p.x), s(p.y)] as const);
  const exc = points.filter((p) => p.label === 0).map((p) => [s(p.x), s(p.y)] as const);
  if (inc.length) strokes.push({ mode: 'include', radius: r, points: inc });
  if (exc.length) strokes.push({ mode: 'exclude', radius: r, points: exc });
  if (box) {
    // Track: the box's centre line is the subject, its outside is not.
    const b = prompt.box!;
    const cx = (b.x0 + b.x1) / 2;
    if (!inc.length) strokes.push({ mode: 'include', radius: r, points: [[cx, b.y0 + 0.3 * (b.y1 - b.y0)], [cx, b.y0 + 0.7 * (b.y1 - b.y0)]] });
    const m = 2 * r;
    const ring: [number, number][] = [
      [Math.max(0, b.x0 - m), Math.max(0, b.y0 - m)],
      [Math.min(w - 1, b.x1 + m), Math.max(0, b.y0 - m)],
      [Math.min(w - 1, b.x1 + m), Math.min(h - 1, b.y1 + m)],
      [Math.max(0, b.x0 - m), Math.min(h - 1, b.y1 + m)],
      [Math.max(0, b.x0 - m), Math.max(0, b.y0 - m)],
    ];
    strokes.push({ mode: 'exclude', radius: r, points: ring });
  }
  return { prompt, strokes, seededBy: 'operator' };
}

/**
 * A seed from the key's confident foreground: alpha ≥ 0.9, opened (light
 * stands, cables and hair go), the largest component weighted towards the
 * centre; up to three clicks at its deepest points, spread apart. Track gets
 * those as include paint and clean screen round the subject as exclude paint.
 * Null when the key has nothing solid.
 */
export function seedFromKey(alpha: Float32Array, w: number, h: number): SubjectSeed | null {
  const n = w * h;
  const solid = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) solid[i] = alpha[i]! >= 0.9 ? 1 : 0;
  const open = Math.max(2, Math.round(w / 150));
  const opened = morph(morph(solid, w, h, -open), w, h, open);
  const lab = components(opened, w, h, 1);
  if (lab.sizes.length < 2) return null;
  const cx = new Float64Array(lab.sizes.length);
  const cy = new Float64Array(lab.sizes.length);
  for (let i = 0; i < n; i += 1) {
    const l = lab.labels[i]!;
    if (!l) continue;
    cx[l]! += i % w;
    cy[l]! += Math.floor(i / w);
  }
  let best = 0;
  let score = -1;
  const diag = Math.hypot(w, h);
  for (let l = 1; l < lab.sizes.length; l += 1) {
    const s = lab.sizes[l]!;
    if (s < Math.max(16, n / 5000)) continue;
    const d = Math.hypot(cx[l]! / s - w / 2, cy[l]! / s - h / 2) / diag;
    const sc = s * (1 - d);
    if (sc > score) {
      score = sc;
      best = l;
    }
  }
  if (!best) return null;
  const mine = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) mine[i] = lab.labels[i] === best ? 1 : 0;
  const inv = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) inv[i] = mine[i] ? 0 : 1;
  const depth = squaredDistance(inv, w, h);
  const box = bbox(mine, w, h)!;
  const apart = 0.3 * Math.max(box.x1 - box.x0, box.y1 - box.y0);
  const pts: [number, number, number][] = [];
  for (let k = 0; k < 3; k += 1) {
    let bi = -1;
    for (let i = 0; i < n; i += 1) {
      if (!mine[i] || (bi >= 0 && depth[i]! <= depth[bi]!)) continue;
      const x = i % w;
      const y = (i - x) / w;
      if (pts.every(([px, py]) => Math.hypot(px - x, py - y) >= apart)) bi = i;
    }
    if (bi < 0) break;
    pts.push([(bi % w) + 0.5, Math.floor(bi / w) + 0.5, Math.sqrt(depth[bi]!)]);
  }
  // Clean screen round it, for Track's exclude paint: a ring of points well outside the solid region's box.
  const all = bbox(solid, w, h)!;
  const m = Math.max(4, w / 40);
  const ring: [number, number][] = [];
  const x0 = Math.max(1, all.x0 - m);
  const x1 = Math.min(w - 2, all.x1 + m);
  const y0 = Math.max(1, box.y0 - m);
  const y1 = Math.min(h - 2, box.y1 + m);
  for (const [x, y] of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] as const) if (alpha[Math.round(y) * w + Math.round(x)]! < 0.05) ring.push([x, y]);
  const r = Math.max(2, w / 160);
  const strokes: EngineStroke[] = pts.map(([x, y, d]) => ({ mode: 'include' as const, radius: Math.max(r, 0.6 * d), points: [[x, y] as const] }));
  if (ring.length) strokes.push({ mode: 'exclude', radius: r, points: ring });
  return { prompt: { points: pts.map(([x, y]) => ({ x, y, label: 1 as const })) }, strokes, seededBy: 'key' };
}

export interface SubjectRunIO {
  frame(frame: number): Promise<RGBImage>;
  put(frame: number, mask: Mask, confidence: number): Promise<void>;
  signal?: AbortSignal;
  progress?(done: number, total: number, frame: number): void;
}

/** Segment the seed frame, then propagate forward to `last` and backward to `first`. */
export async function runSubject(engine: SegmentationEngine, seed: SubjectSeed, from: number, range: { first: number; last: number }, io: SubjectRunIO): Promise<{ frame: number; confidence: number }[]> {
  const check = () => {
    if (io.signal?.aborted) throw new CancelledError();
  };
  const total = range.last - range.first + 1;
  const out: { frame: number; confidence: number }[] = [];
  const key = async () => {
    const image = await io.frame(from);
    const r = await engine.key({ frame: from, image, strokes: engine.id === 'track' ? seed.strokes : [], reference: null, settings: {}, prompt: seed.prompt });
    return { image, r };
  };
  check();
  const first = await key();
  await io.put(from, first.r.mask, first.r.confidence);
  out.push({ frame: from, confidence: first.r.confidence });
  io.progress?.(out.length, total, from);
  for (const dir of [1, -1] as const) {
    let prev = first.image;
    let prevMask = first.r.mask;
    if (dir === -1 && from > range.first && engine.id === 'sam2') {
      // SAM keeps the last prediction as its next mask input: start the backward run from the seed again.
      const again = await key();
      prev = again.image;
      prevMask = again.r.mask;
    }
    for (let f = from + dir; dir === 1 ? f <= range.last : f >= range.first; f += dir) {
      check();
      const next = await io.frame(f);
      const r = maskArea(prevMask) === 0 ? { mask: { width: next.width, height: next.height, data: new Uint8Array(next.width * next.height) }, confidence: 0 } : await engine.step({ prevFrame: f - dir, nextFrame: f, prev, next, prevMask, smoothing: 0, settings: {} });
      await io.put(f, r.mask, r.confidence);
      out.push({ frame: f, confidence: Math.round(r.confidence * 1000) / 1000 });
      io.progress?.(out.length, total, f);
      prev = next;
      prevMask = r.mask;
    }
  }
  out[0] = { frame: from, confidence: Math.round(first.r.confidence * 1000) / 1000 };
  return out.sort((a, b) => a.frame - b.frame);
}
