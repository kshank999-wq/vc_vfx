/**
 * Paint strokes as the engines see them (addendum 04): capsules of the
 * brush radius along each polyline, rasterised into a seed map — 1 painted
 * in (include), 2 painted out (exclude). A later stroke paints over an
 * earlier one, as on screen.
 */

export interface EngineStroke {
  mode: 'include' | 'exclude';
  /** Radius in the same pixels as the points. */
  radius: number;
  points: readonly (readonly [number, number])[];
}

export const SEED_NONE = 0;
export const SEED_INCLUDE = 1;
export const SEED_EXCLUDE = 2;

/** Scale strokes from plate pixels to another resolution. */
export function scaleStrokes(strokes: readonly EngineStroke[], sx: number, sy = sx): EngineStroke[] {
  return strokes.map((s) => ({ mode: s.mode, radius: s.radius * Math.sqrt(sx * sy), points: s.points.map(([x, y]) => [x * sx, y * sy] as const) }));
}

export function rasterizeStrokes(strokes: readonly EngineStroke[], w: number, h: number, out = new Uint8Array(w * h)): Uint8Array {
  for (const s of strokes) {
    const value = s.mode === 'include' ? SEED_INCLUDE : SEED_EXCLUDE;
    const r = Math.max(0.75, s.radius);
    const r2 = r * r;
    const pts = s.points.length === 1 ? [s.points[0]!, s.points[0]!] : s.points;
    for (let k = 0; k + 1 < pts.length; k += 1) {
      const [ax, ay] = pts[k]!;
      const [bx, by] = pts[k + 1]!;
      const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - r));
      const x1 = Math.min(w - 1, Math.ceil(Math.max(ax, bx) + r));
      const y0 = Math.max(0, Math.floor(Math.min(ay, by) - r));
      const y1 = Math.min(h - 1, Math.ceil(Math.max(ay, by) + r));
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy;
      for (let y = y0; y <= y1; y += 1) {
        const py = y + 0.5;
        for (let x = x0; x <= x1; x += 1) {
          const px = x + 0.5;
          let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const ex = ax + t * dx - px;
          const ey = ay + t * dy - py;
          if (ex * ex + ey * ey <= r2) out[y * w + x] = value;
        }
      }
    }
  }
  return out;
}

/** Points along the strokes of one mode, at most `max`, spread by farthest-point sampling (deterministic). */
export function samplePoints(strokes: readonly EngineStroke[], mode: EngineStroke['mode'], max: number): [number, number][] {
  const all: [number, number][] = [];
  for (const s of strokes) {
    if (s.mode !== mode) continue;
    const pts = s.points;
    for (let k = 0; k < pts.length; k += 1) {
      all.push([pts[k]![0], pts[k]![1]]);
      const next = pts[k + 1];
      if (!next) continue;
      // Densify long segments so sampling sees the whole stroke.
      const steps = Math.floor(Math.hypot(next[0] - pts[k]![0], next[1] - pts[k]![1]) / Math.max(1, s.radius));
      for (let i = 1; i < steps; i += 1) all.push([pts[k]![0] + ((next[0] - pts[k]![0]) * i) / steps, pts[k]![1] + ((next[1] - pts[k]![1]) * i) / steps]);
    }
  }
  if (all.length <= max) return all;
  // Start at the point nearest the centroid, then always take the farthest from those chosen.
  const cx = all.reduce((a, p) => a + p[0], 0) / all.length;
  const cy = all.reduce((a, p) => a + p[1], 0) / all.length;
  let first = 0;
  let best = Infinity;
  all.forEach((p, i) => {
    const d = (p[0] - cx) ** 2 + (p[1] - cy) ** 2;
    if (d < best) {
      best = d;
      first = i;
    }
  });
  const chosen = [all[first]!];
  const dist = all.map((p) => (p[0] - all[first]![0]) ** 2 + (p[1] - all[first]![1]) ** 2);
  while (chosen.length < max) {
    let far = 0;
    for (let i = 1; i < all.length; i += 1) if (dist[i]! > dist[far]!) far = i;
    const p = all[far]!;
    chosen.push(p);
    for (let i = 0; i < all.length; i += 1) dist[i] = Math.min(dist[i]!, (all[i]![0] - p[0]) ** 2 + (all[i]![1] - p[1]) ** 2);
  }
  return chosen;
}
