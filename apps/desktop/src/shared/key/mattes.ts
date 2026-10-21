import type { KeyLink, KeyLinkKind, KeyRect, KeyRepairMode } from '@vcvfx/domain';
import { gaussianBlur, morph } from '../roto/image';

/**
 * Garbage, holdout and repair mattes (master spec §6 bullets 2–3; addendum 09
 * §3.4), from roto parts or drawn boxes, and how they combine with the key:
 *
 *   1. repair regions, in order: inside the region the roto matte replaces
 *      the key (replace), or the more solid (max) or less solid (min) of the
 *      two is kept — the roto matte rescues a key that failed (a subject off
 *      the screen, an occlusion, a green prop);
 *   2. garbage: everything outside the garbage mattes (or inside an inverted
 *      one) is transparent;
 *   3. holdout: everything inside a holdout is solid — a holdout is the
 *      subject, so it wins even outside the garbage.
 *
 * All mattes are float 0…1 at the key's resolution; region edges are soft by
 * the link's softness so no hard step is introduced.
 */

export interface ResolvedLink {
  kind: KeyLinkKind;
  mode: KeyRepairMode;
  invert: boolean;
  /** The shape (garbage/holdout), or the roto matte (repair). */
  matte: Float32Array;
  /** Repair only: where the repair acts (soft), or null for everywhere the matte reaches after growing. */
  region: Float32Array | null;
}

/** A box as a soft matte: 1 inside, falling to 0 over `softness` pixels across its edge. */
export function rectMatte(rect: KeyRect, w: number, h: number, softness: number): Float32Array {
  const out = new Float32Array(w * h);
  const s = Math.max(1, softness);
  for (let y = 0; y < h; y += 1) {
    const py = y + 0.5;
    const dy = Math.max(rect.y0 - py, py - rect.y1);
    for (let x = 0; x < w; x += 1) {
      const px = x + 0.5;
      const sd = Math.max(rect.x0 - px, px - rect.x1, dy);
      const v = 0.5 - sd / s;
      out[y * w + x] = v <= 0 ? 0 : v >= 1 ? 1 : v;
    }
  }
  return out;
}

/** A soft matte grown (or shrunk) by `grow` pixels and softened by `softness` pixels. */
export function shapeMatte(matte: Float32Array, w: number, h: number, grow: number, softness: number): Float32Array {
  let out = matte;
  if (Math.abs(grow) >= 0.5) {
    const bin = new Uint8Array(w * h);
    for (let i = 0; i < bin.length; i += 1) bin[i] = matte[i]! >= 0.5 ? 1 : 0;
    out = Float32Array.from(morph(bin, w, h, grow));
  }
  if (softness >= 0.5) out = gaussianBlur(out, w, h, softness / 2);
  return out === matte ? matte.slice() : out;
}

/** The region a roto repair acts in when no box is given: where its matte reaches, grown. */
export function repairRegion(matte: Float32Array, w: number, h: number, grow: number, softness: number): Float32Array {
  const bin = new Uint8Array(w * h);
  for (let i = 0; i < bin.length; i += 1) bin[i] = matte[i]! > 0.02 ? 1 : 0;
  const grown = Float32Array.from(Math.abs(grow) >= 0.5 ? morph(bin, w, h, grow) : bin);
  return softness >= 0.5 ? gaussianBlur(grown, w, h, softness / 2) : grown;
}

export function combineMattes(alpha: Float32Array, links: readonly ResolvedLink[]): Float32Array {
  const n = alpha.length;
  const out = alpha.slice();
  for (const l of links) {
    if (l.kind !== 'repair') continue;
    const m = l.invert ? l.matte.map((v) => 1 - v) : l.matte;
    for (let i = 0; i < n; i += 1) {
      const r = l.region ? l.region[i]! : 1;
      if (r <= 0) continue;
      const a = out[i]!;
      const target = l.mode === 'replace' ? m[i]! : l.mode === 'max' ? Math.max(a, m[i]!) : Math.min(a, m[i]!);
      out[i] = a + r * (target - a);
    }
  }
  const garbage = links.filter((l) => l.kind === 'garbage');
  if (garbage.length) {
    const keep = new Float32Array(n);
    const plain = garbage.filter((l) => !l.invert);
    if (plain.length) for (const l of plain) for (let i = 0; i < n; i += 1) keep[i] = Math.max(keep[i]!, l.matte[i]!);
    else keep.fill(1);
    for (const l of garbage.filter((g) => g.invert)) for (let i = 0; i < n; i += 1) keep[i] = keep[i]! * (1 - l.matte[i]!);
    for (let i = 0; i < n; i += 1) out[i] = out[i]! * keep[i]!;
  }
  for (const l of links) {
    if (l.kind !== 'holdout') continue;
    for (let i = 0; i < n; i += 1) {
      const hv = l.invert ? 1 - l.matte[i]! : l.matte[i]!;
      if (hv > out[i]!) out[i] = hv;
    }
  }
  return out;
}

/** Whether a link applies on a frame. */
export function linkActive(link: Pick<KeyLink, 'enabled' | 'frames'>, frame: number): boolean {
  if (!link.enabled) return false;
  if (!link.frames) return true;
  return link.frames.first <= link.frames.last && frame >= link.frames.first && frame <= link.frames.last;
}

/**
 * The links that apply on a frame, as mattes at w × h. Settings are in plate
 * pixels; `pxScale` is plate pixels per key pixel. `roto(partId)` gives the
 * part's matte at w × h (null where it has none on this frame, which makes a
 * roto garbage matte keep nothing, and a roto holdout or repair do nothing).
 */
export function resolveLinks(
  links: readonly KeyLink[],
  frame: number,
  ctx: { width: number; height: number; pxScale: number; roto: (partId: string) => Float32Array | null },
): ResolvedLink[] {
  const { width: w, height: h, pxScale } = ctx;
  const out: ResolvedLink[] = [];
  const scaleRect = (r: KeyRect): KeyRect => ({ x0: r.x0 / pxScale, y0: r.y0 / pxScale, x1: r.x1 / pxScale, y1: r.y1 / pxScale });
  for (const l of links) {
    if (!linkActive(l, frame)) continue;
    const grow = l.growPx / pxScale;
    const soft = l.softnessPx / pxScale;
    if (l.source.type === 'rect') {
      const r = scaleRect(l.source.rect);
      const grown = { x0: r.x0 - grow, y0: r.y0 - grow, x1: r.x1 + grow, y1: r.y1 + grow };
      const m = rectMatte(grown, w, h, soft);
      // A box repair has no roto matte to bring: it is a solid region (replace → solid, min → cut out).
      out.push({ kind: l.kind, mode: l.mode, invert: l.invert, matte: m, region: l.kind === 'repair' ? (l.region ? rectMatte(scaleRect(l.region), w, h, soft) : m) : null });
      continue;
    }
    const roto = ctx.roto(l.source.partId);
    if (!roto) {
      if (l.kind === 'garbage' && !l.invert) out.push({ kind: 'garbage', mode: l.mode, invert: false, matte: new Float32Array(w * h), region: null });
      continue;
    }
    if (l.kind === 'repair') {
      const region = l.region ? rectMatte(scaleRect(l.region), w, h, soft) : repairRegion(roto, w, h, grow, soft);
      out.push({ kind: 'repair', mode: l.mode, invert: l.invert, matte: roto, region });
    } else out.push({ kind: l.kind, mode: l.mode, invert: l.invert, matte: shapeMatte(roto, w, h, grow, soft), region: null });
  }
  return out;
}
