import type { RotoRefine } from '@vcvfx/domain';
import { bbox, binarize, edgeBand, gaussianBlur, growBox, guidedFilter, maskToPlane, morph, planeToMask, resizeMask, type Mask } from './image';

/**
 * Matte refinement (master spec §5.1 "independent matte refinement,
 * feathering"; addendum 04): a chain of refiners applied to an engine's matte,
 * per part, both for display and on export. Each is independent and recorded
 * by id and version in the roto metadata, so adding one — a matting network
 * for hair, say — is one more entry in `REFINERS`.
 */

export interface RefineContext {
  /** Plate pixels per mask pixel: refine settings are in plate pixels. */
  pxScale: number;
  /** Grey guide image (0…1) at the mask's size, when there is one. */
  guide: Float32Array | null;
  /** The mask was just scaled up from working resolution: its edge needs snapping to the guide. */
  upscaled: boolean;
}

export interface MatteRefiner {
  readonly id: string;
  readonly version: string;
  applies(refine: RotoRefine, ctx: RefineContext): boolean;
  apply(mask: Mask, refine: RotoRefine, ctx: RefineContext): Mask;
}

/** Guided filter of the mask inside a band around its edge only. */
function snapEdge(mask: Mask, guide: Float32Array, r: number, eps: number): Mask {
  const { width: w, height: h } = mask;
  const bin = binarize(mask);
  const band = edgeBand(bin, w, h, r + 1);
  const box = bbox(band, w, h);
  if (!box) return mask;
  const b = growBox(box, r + 1, w, h);
  const bw = b.x1 - b.x0 + 1;
  const bh = b.y1 - b.y0 + 1;
  const g = new Float32Array(bw * bh);
  const p = new Float32Array(bw * bh);
  for (let y = 0; y < bh; y += 1) for (let x = 0; x < bw; x += 1) {
    const i = (y + b.y0) * w + x + b.x0;
    g[y * bw + x] = guide[i]!;
    p[y * bw + x] = mask.data[i]! / 255;
  }
  const f = guidedFilter(g, p, bw, bh, r, eps);
  const out = mask.data.slice();
  for (let y = 0; y < bh; y += 1) for (let x = 0; x < bw; x += 1) {
    const i = (y + b.y0) * w + x + b.x0;
    if (!band[i]) continue;
    const v = f[y * bw + x]!;
    out[i] = v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255);
  }
  return { width: w, height: h, data: out };
}

export const SHRINK_GROW: MatteRefiner = {
  id: 'shrink-grow',
  version: '1',
  applies: (r) => r.shrinkGrowPx !== 0,
  apply(mask, refine, ctx) {
    const r = refine.shrinkGrowPx / ctx.pxScale;
    const moved = morph(binarize(mask), mask.width, mask.height, r >= 0 ? Math.max(0.5, r) : Math.min(-0.5, r));
    const hard: Mask = { width: mask.width, height: mask.height, data: Uint8Array.from(moved, (v) => (v ? 255 : 0)) };
    return ctx.guide ? snapEdge(hard, ctx.guide, Math.max(1, Math.round(1 / ctx.pxScale) + 1), 1e-3) : planeToMask(gaussianBlur(maskToPlane(hard), mask.width, mask.height, 0.6), mask.width, mask.height);
  },
};

export const EDGE_SNAP: MatteRefiner = {
  id: 'edge-snap',
  version: '1',
  applies: (r, ctx) => r.edgeSnap && ctx.upscaled && ctx.guide !== null,
  apply(mask, _refine, ctx) {
    // Radius of about one working pixel, in this mask's pixels.
    const r = Math.max(2, Math.round(1.5 / ctx.pxScale));
    return snapEdge(mask, ctx.guide!, r, 1e-4);
  },
};

export const FEATHER: MatteRefiner = {
  id: 'feather',
  version: '1',
  applies: (r) => r.featherPx > 0.25,
  apply(mask, refine, ctx) {
    return planeToMask(gaussianBlur(maskToPlane(mask), mask.width, mask.height, refine.featherPx / ctx.pxScale / 2), mask.width, mask.height);
  },
};

export const REFINERS: readonly MatteRefiner[] = [SHRINK_GROW, EDGE_SNAP, FEATHER];

export function refineMatte(mask: Mask, refine: RotoRefine, ctx: RefineContext, refiners: readonly MatteRefiner[] = REFINERS): Mask {
  let out = mask;
  for (const r of refiners) if (r.applies(refine, ctx)) out = r.apply(out, refine, ctx);
  return out;
}

/** Which refiners ran, for the record. */
export function refinersUsed(refine: RotoRefine, ctx: RefineContext, refiners: readonly MatteRefiner[] = REFINERS): string[] {
  return refiners.filter((r) => r.applies(refine, ctx)).map((r) => `${r.id}@${r.version}`);
}

/**
 * A working-resolution matte at plate resolution: scaled up, the edge
 * snapped to the full-resolution picture (`guide`), then refined in plate
 * pixels.
 */
export function upscaleMatte(mask: Mask, width: number, height: number, guide: Float32Array | null, refine: RotoRefine): Mask {
  const up = resizeMask(mask, width, height);
  return refineMatte(up, refine, { pxScale: 1, guide, upscaled: up !== mask });
}
