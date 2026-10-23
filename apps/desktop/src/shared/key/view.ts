import type { BgMatch } from '@vcvfx/domain';
import type { KeyFrameView } from './bridge-types';
import type { KeyFrameOutput } from './keyer';
import { resizeLinear, toDisplay, type LinearImage, type WorkingSpace } from './linear';
import { applyMatch, checker, over } from './look';
import type { ResolvedLink } from './mattes';

/**
 * A keyed frame as the viewer shows it (master spec §6 "matte review modes";
 * addendum 09 §8): the plate, the premultiplied foreground over a checker,
 * the foreground over the background (with the light wrap and the suggested
 * match only when asked — previews, never outputs), and the mattes as 8-bit
 * masks. Composites are made in linear light, then shown through the
 * viewer's display transform.
 */

const u8 = (a: Float32Array) => Uint8Array.from(a, (v) => (v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255)));

export function frameView(
  frame: number,
  img: LinearImage,
  out: KeyFrameOutput & { background: LinearImage | null; links: readonly ResolvedLink[]; screen: Float32Array },
  space: WorkingSpace,
  o: { wrap: boolean; match: BgMatch | null; viewLabel: string },
): KeyFrameView {
  const { width: w, height: h } = img;
  const n = w * h;
  const fg = out.fg ?? new Float32Array(n * 3);
  const premult = toDisplay(over(fg, out.alpha, checker(w, h, Math.max(8, Math.round(w / 60)))), n, space);
  let comp: Uint8ClampedArray | null = null;
  if (out.background) {
    const bg = out.background.width === w ? out.background : resizeLinear(out.background, w, h);
    const f = o.match ? applyMatch(fg, out.alpha, o.match, o.match.strength) : fg;
    // The shadow pass multiplies the background (as the compositor would with the written matte).
    let bgData = bg.data;
    if (out.shadow) {
      bgData = bg.data.slice();
      for (let i = 0; i < n; i += 1) {
        const k = 1 - out.shadow[i]!;
        bgData[3 * i]! *= k;
        bgData[3 * i + 1]! *= k;
        bgData[3 * i + 2]! *= k;
      }
    }
    comp = toDisplay(over(f, out.alpha, bgData, o.wrap ? out.wrap : null), n, space);
  }
  const union = (kind: ResolvedLink['kind'], pick: (l: ResolvedLink) => Float32Array | null) => {
    const ls = out.links.filter((l) => l.kind === kind);
    if (!ls.length) return null;
    const m = new Float32Array(n);
    for (const l of ls) {
      const a = pick(l);
      if (a) for (let i = 0; i < n; i += 1) m[i] = Math.max(m[i]!, a[i]!);
    }
    return u8(m);
  };
  const garbage = (() => {
    const ls = out.links.filter((l) => l.kind === 'garbage');
    if (!ls.length) return null;
    const keep = new Float32Array(n);
    const plain = ls.filter((l) => !l.invert);
    if (plain.length) for (const l of plain) for (let i = 0; i < n; i += 1) keep[i] = Math.max(keep[i]!, l.matte[i]!);
    else keep.fill(1);
    for (const l of ls.filter((g) => g.invert)) for (let i = 0; i < n; i += 1) keep[i] = keep[i]! * (1 - l.matte[i]!);
    return u8(keep);
  })();
  let spill: Uint8Array | null = null;
  if (out.spill) {
    let max = 1e-6;
    for (const v of out.spill) if (v > max) max = v;
    spill = Uint8Array.from(out.spill, (v) => Math.round(Math.min(1, v / max) * 255));
  }
  const c = 3 * ((h >> 1) * w + (w >> 1));
  return {
    frame,
    width: w,
    height: h,
    source: toDisplay(img.data, n, space),
    premult,
    comp,
    alpha: u8(out.alpha),
    core: Uint8Array.from(out.core, (v) => (v ? 255 : 0)),
    garbage,
    holdout: union('holdout', (l) => (l.invert ? l.matte.map((v) => 1 - v) : l.matte)),
    repair: union('repair', (l) => l.region ?? l.matte),
    spill,
    subject: out.prior && out.prior.area ? Uint8Array.from(out.prior.inside, (v) => (v ? 255 : 0)) : null,
    subjectConfidence: out.prior ? Math.round(out.prior.confidence * 1000) / 1000 : null,
    shadow: out.shadow ? u8(out.shadow) : null,
    confidence: out.confidence,
    metrics: out.metrics,
    screen: [out.screen[c]!, out.screen[c + 1]!, out.screen[c + 2]!],
    viewLabel: o.viewLabel,
  };
}
