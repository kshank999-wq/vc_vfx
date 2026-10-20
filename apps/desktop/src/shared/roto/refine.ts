import type { RotoRefine } from '@vcvfx/domain';
import { bbox, edgeBand, gaussianBlur, growBox, guidedFilter, maskToPlane, morph, planeToMask, resizePlane, type Mask } from './image';

/**
 * Matte refinement (master spec §5.1 "independent matte refinement,
 * feathering"; addendum 04): a chain of refiners applied to an engine's matte,
 * per part, both for display and on export. They work on float alpha planes
 * (0…1), so an export keeps full 16-bit precision on soft edges. Each is
 * independent and recorded by id and version in the roto metadata, so adding
 * one — a matting network for hair, say — is one more entry in `REFINERS`.
 */

export interface RefineContext {
  /** Plate pixels per alpha pixel: refine settings are in plate pixels. */
  pxScale: number;
  /** Grey guide image (0…1) at the alpha's size, when there is one. */
  guide: Float32Array | null;
  /** The alpha was just scaled up from working resolution: its edge needs snapping to the guide. */
  upscaled: boolean;
}

export interface Alpha {
  width: number;
  height: number;
  /** 0 … 1. */
  data: Float32Array;
}

export interface MatteRefiner {
  readonly id: string;
  readonly version: string;
  applies(refine: RotoRefine, ctx: RefineContext): boolean;
  apply(alpha: Alpha, refine: RotoRefine, ctx: RefineContext): Alpha;
}

const binary = (a: Alpha): Uint8Array => {
  const out = new Uint8Array(a.data.length);
  for (let i = 0; i < out.length; i += 1) out[i] = a.data[i]! >= 0.5 ? 1 : 0;
  return out;
};

/** Guided filter of the alpha inside a band around its edge only. */
function snapEdge(alpha: Alpha, guide: Float32Array, r: number, eps: number): Alpha {
  const { width: w, height: h } = alpha;
  const band = edgeBand(binary(alpha), w, h, r + 1);
  const box = bbox(band, w, h);
  if (!box) return alpha;
  const b = growBox(box, r + 1, w, h);
  const bw = b.x1 - b.x0 + 1;
  const bh = b.y1 - b.y0 + 1;
  const g = new Float32Array(bw * bh);
  const p = new Float32Array(bw * bh);
  for (let y = 0; y < bh; y += 1) for (let x = 0; x < bw; x += 1) {
    const i = (y + b.y0) * w + x + b.x0;
    g[y * bw + x] = guide[i]!;
    p[y * bw + x] = alpha.data[i]!;
  }
  const f = guidedFilter(g, p, bw, bh, r, eps);
  const out = alpha.data.slice();
  for (let y = 0; y < bh; y += 1) for (let x = 0; x < bw; x += 1) {
    const i = (y + b.y0) * w + x + b.x0;
    if (band[i]) out[i] = Math.min(1, Math.max(0, f[y * bw + x]!));
  }
  return { width: w, height: h, data: out };
}

export const SHRINK_GROW: MatteRefiner = {
  id: 'shrink-grow',
  version: '1',
  applies: (r) => r.shrinkGrowPx !== 0,
  apply(alpha, refine, ctx) {
    const r = refine.shrinkGrowPx / ctx.pxScale;
    const moved = morph(binary(alpha), alpha.width, alpha.height, r >= 0 ? Math.max(0.5, r) : Math.min(-0.5, r));
    const hard: Alpha = { width: alpha.width, height: alpha.height, data: Float32Array.from(moved) };
    return ctx.guide ? snapEdge(hard, ctx.guide, Math.max(1, Math.round(1 / ctx.pxScale) + 1), 1e-3) : { ...hard, data: gaussianBlur(hard.data, alpha.width, alpha.height, 0.6) };
  },
};

export const EDGE_SNAP: MatteRefiner = {
  id: 'edge-snap',
  version: '1',
  applies: (r, ctx) => r.edgeSnap && ctx.upscaled && ctx.guide !== null,
  apply(alpha, _refine, ctx) {
    // Radius of about one and a half working pixels, in this alpha's pixels.
    const r = Math.max(2, Math.round(1.5 / ctx.pxScale));
    return snapEdge(alpha, ctx.guide!, r, 1e-4);
  },
};

export const FEATHER: MatteRefiner = {
  id: 'feather',
  version: '1',
  applies: (r) => r.featherPx > 0.25,
  apply(alpha, refine, ctx) {
    return { ...alpha, data: gaussianBlur(alpha.data, alpha.width, alpha.height, refine.featherPx / ctx.pxScale / 2) };
  },
};

export const REFINERS: readonly MatteRefiner[] = [SHRINK_GROW, EDGE_SNAP, FEATHER];

export function refineAlpha(alpha: Alpha, refine: RotoRefine, ctx: RefineContext, refiners: readonly MatteRefiner[] = REFINERS): Alpha {
  let out = alpha;
  for (const r of refiners) if (r.applies(refine, ctx)) out = r.apply(out, refine, ctx);
  return out;
}

/** The refined matte as 8 bits, for display. */
export function refineMatte(mask: Mask, refine: RotoRefine, ctx: RefineContext, refiners: readonly MatteRefiner[] = REFINERS): Mask {
  const out = refineAlpha({ width: mask.width, height: mask.height, data: maskToPlane(mask) }, refine, ctx, refiners);
  return planeToMask(out.data, out.width, out.height);
}

/** Which refiners ran, for the record. */
export function refinersUsed(refine: RotoRefine, ctx: RefineContext, refiners: readonly MatteRefiner[] = REFINERS): string[] {
  return refiners.filter((r) => r.applies(refine, ctx)).map((r) => `${r.id}@${r.version}`);
}

/**
 * A working-resolution matte at plate resolution, as a float alpha: scaled
 * up, the edge snapped to the full-resolution picture (`guide`), then refined
 * in plate pixels.
 */
export function upscaleAlpha(mask: Mask, width: number, height: number, guide: Float32Array | null, refine: RotoRefine): Alpha {
  const same = mask.width === width && mask.height === height;
  const plane = maskToPlane(mask);
  const up: Alpha = { width, height, data: same ? plane : resizePlane(plane, mask.width, mask.height, width, height) };
  return refineAlpha(up, refine, { pxScale: 1, guide, upscaled: !same });
}

export function upscaleMatte(mask: Mask, width: number, height: number, guide: Float32Array | null, refine: RotoRefine): Mask {
  const a = upscaleAlpha(mask, width, height, guide, refine);
  return planeToMask(a.data, width, height);
}

/** Float alpha → 16-bit. */
export function to16(a: Alpha): Uint16Array {
  const out = new Uint16Array(a.data.length);
  for (let i = 0; i < out.length; i += 1) {
    const v = a.data[i]!;
    out[i] = v <= 0 ? 0 : v >= 1 ? 65535 : Math.round(v * 65535);
  }
  return out;
}
