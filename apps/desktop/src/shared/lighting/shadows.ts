import { DEG, groundPoint, median, projectLevel, sample1, solve, type Ground, type PinholeCamera, type V3 } from './geometry';

/**
 * Cast shadows on the ground (addendum 14 §3.2).
 *
 * The ground is a horizontal plane below the camera (its height and the
 * camera's tilt from the camera track, or assumed). Each ground pixel near
 * the subject's contact point is mapped onto it; its brightness is compared
 * with the lit ground at the same distance (a high percentile per ring), so
 * a shadow is a share of the light missing. Shadow pixels connected to the
 * contact point are gathered by direction: the darkest direction is the
 * key's shadow, others belong to weaker lights. The light's azimuth is the
 * shadow's direction turned round; its elevation follows from the shadow's
 * centroid and the subject's height (tan el ≈ (H/2) / centroid distance, for
 * a sphere resting on the ground and for an upright pole alike); its
 * angular size from the penumbra across the shadow's sides divided by the
 * distance from the occluder to the ground.
 */

export interface ShadowEstimate {
  /** Level-frame azimuth of the light (towards it), degrees, and the uncertainty's half-width. */
  az: number;
  azHalf: number;
  /** Elevation (degrees) and its half-width; null when the shadow's extent cannot be read. */
  el: number | null;
  elHalf: number;
  /** How dark the shadow is: the share of the ground's light missing in it (0 … 1). */
  depth: number;
  /** The light's angular diameter from the penumbra (degrees), with a range; null when not measured. */
  sizeDeg: number | null;
  sizeLow: number;
  sizeHigh: number;
  /** Image points: the contact point and the shadow's centroid (for the overlay). */
  from: { x: number; y: number };
  to: { x: number; y: number };
  /** Shadow pixels used. */
  pixels: number;
  /** Part of it runs behind the subject (hidden): its direction and length are less sure. */
  occluded: boolean;
}

export interface ShadowAnalysis {
  shadows: ShadowEstimate[];
  /** The subject's height and contact point on the ground, metres (level frame). */
  subjectHeightM: number;
  contact: V3;
  /** The ratio map (pixel brightness / lit ground at that distance; NaN off the ground region), for the overlay. */
  ratio: Float32Array;
}

/** The 10 %–90 % width of the shadow edge of a uniform disk source, as a share of its diameter. */
const DISK_10_90 = (() => {
  // Fraction of a unit disk beyond a chord at offset u (−1 … 1).
  const frac = (u: number) => (Math.acos(u) - u * Math.sqrt(1 - u * u)) / Math.PI;
  const solve = (target: number) => {
    let lo = -1;
    let hi = 1;
    for (let i = 0; i < 60; i += 1) {
      const mid = (lo + hi) / 2;
      if (frac(mid) > target) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  };
  return Math.abs(solve(0.1) - solve(0.9)) / 2;
})();

export function analyseShadows(lum: Float32Array, w: number, h: number, subject: Uint8Array, cam: PinholeCamera, ground: Ground, o: { sky?: Uint8Array | null; exclude?: Uint8Array | null } = {}): ShadowAnalysis | null {
  // The contact point: the bottom of the subject.
  let bottom = -1;
  let top = h;
  let count = 0;
  for (let i = 0; i < w * h; i += 1)
    if (subject[i]) {
      const y = (i - (i % w)) / w;
      if (y > bottom) bottom = y;
      if (y < top) top = y;
      count += 1;
    }
  if (count < 100 || bottom >= h - 1) return null;
  let sx = 0;
  let n = 0;
  let minX = w;
  let maxX = -1;
  for (let y = Math.max(0, bottom - 2); y <= bottom; y += 1)
    for (let x = 0; x < w; x += 1)
      if (subject[y * w + x]) {
        sx += x + 0.5;
        n += 1;
      }
  for (let i = 0; i < w * h; i += 1)
    if (subject[i]) {
      const x = i % w;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
    }
  const cx = sx / Math.max(1, n);
  // Pixels hugging the subject mix its edge in: keep two pixels clear of it.
  const near = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i += 1) {
    if (!subject[i]) continue;
    const x = i % w;
    const y = (i - x) / w;
    for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) if (x + dx >= 0 && x + dx < w && y + dy >= 0 && y + dy < h) near[(y + dy) * w + x + dx] = 1;
  }
  const contact = groundPoint(cam, ground, cx, bottom + 1);
  if (!contact) return null;
  // The subject's height: the point above the contact point that lands on its top row.
  let lo = 0;
  let hi = 50;
  for (let i = 0; i < 50; i += 1) {
    const mid = (lo + hi) / 2;
    const p = projectLevel(cam, [contact[0], contact[1] + mid, contact[2]]);
    if (p && p.y > top) lo = mid;
    else hi = mid;
  }
  const H = (lo + hi) / 2;
  const depth = Math.hypot(contact[0], contact[2]);
  const widthM = ((maxX - minX + 1) * depth) / cam.focalPx;
  const reach = 3 * Math.max(H, widthM);
  // Ground pixels near the contact point, in polar rings around it.
  const RINGS = 24;
  const ring = new Int16Array(w * h).fill(-1);
  const gx = new Float32Array(w * h);
  const gz = new Float32Array(w * h);
  const area = new Float32Array(w * h);
  const ringValues: number[][] = Array.from({ length: RINGS }, () => []);
  for (let y = 0; y < h; y += 1)
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      if (near[i] || o.sky?.[i] || o.exclude?.[i]) continue;
      const g = groundPoint(cam, ground, x + 0.5, y + 0.5);
      if (!g) continue;
      const dx = g[0] - contact[0];
      const dz = g[2] - contact[2];
      const r = Math.hypot(dx, dz);
      if (r > reach) continue;
      const k = Math.min(RINGS - 1, Math.floor((r / reach) * RINGS));
      ring[i] = k;
      gx[i] = dx;
      gz[i] = dz;
      const t = Math.hypot(g[0], g[1], g[2]);
      area[i] = (t * t) / (cam.focalPx * cam.focalPx * Math.max(0.02, ground.heightM / t));
      ringValues[k]!.push(lum[i]!);
    }
  // The unshadowed ground: a smooth quadratic over the floor (a light's falloff across it), fitted from above —
  // pixels much darker than the fit (shadows) are left out and the fit repeated.
  const ids: number[] = [];
  for (let i = 0; i < w * h; i += 1) if (ring[i]! >= 0) ids.push(i);
  if (ids.length < 50) return null;
  const basis = (i: number) => {
    const x = gx[i]! / reach;
    const z = gz[i]! / reach;
    return [1, x, z, x * x, x * z, z * z];
  };
  let coef = [median(ids.map((i) => lum[i]!)), 0, 0, 0, 0, 0];
  let use = ids;
  for (let iter = 0; iter < 8; iter += 1) {
    const A = Array.from({ length: 6 }, () => new Array<number>(6).fill(0));
    const b = new Array<number>(6).fill(0);
    for (const i of use) {
      const f = basis(i);
      for (let r = 0; r < 6; r += 1) {
        b[r]! += f[r]! * lum[i]!;
        for (let c = 0; c < 6; c += 1) A[r]![c]! += f[r]! * f[c]!;
      }
    }
    const x = solve(A, b);
    if (!x) break;
    coef = x;
    const evalAt = (i: number) => basis(i).reduce((a, v, k) => a + v * coef[k]!, 0);
    // Keep pixels within 8 % below the fit or anything above it (iteratively tightening from 25 %).
    const tol = Math.max(0.08, 0.25 - 0.03 * iter);
    use = ids.filter((i) => lum[i]! >= (1 - tol) * evalAt(i));
    if (use.length < 30) break;
  }
  const litAt = (i: number) => Math.max(1e-6, basis(i).reduce((a, v, k) => a + v * coef[k]!, 0));
  const litXZ = (dx: number, dz: number) => {
    const x = dx / reach;
    const z = dz / reach;
    return Math.max(1e-6, coef[0]! + coef[1]! * x + coef[2]! * z + coef[3]! * x * x + coef[4]! * x * z + coef[5]! * z * z);
  };
  void ringValues;
  const ratio = new Float32Array(w * h).fill(NaN);
  for (let i = 0; i < w * h; i += 1) if (ring[i]! >= 0) ratio[i] = lum[i]! / litAt(i);
  // Shadow pixels connected to the contact point (seeded within a third of the subject's width of it).
  const inShadow = new Uint8Array(w * h);
  const stack: number[] = [];
  const seed = Math.max(0.3 * widthM, 0.05);
  for (let i = 0; i < w * h; i += 1) if (ratio[i]! < 0.75 && Math.hypot(gx[i]!, gz[i]!) < seed) (inShadow[i] = 1), stack.push(i);
  // Pixels next to the subject's bottom also seed (the shadow often starts under it).
  for (let y = Math.max(0, bottom - 1); y < Math.min(h, bottom + 3); y += 1)
    for (let x = minX; x <= maxX; x += 1) {
      const i = y * w + x;
      if (!inShadow[i] && ratio[i]! < 0.75) (inShadow[i] = 1), stack.push(i);
    }
  while (stack.length) {
    const j = stack.pop()!;
    const x = j % w;
    const y = (j - x) / w;
    for (const k of [x > 0 ? j - 1 : -1, x < w - 1 ? j + 1 : -1, y > 0 ? j - w : -1, y < h - 1 ? j + w : -1]) {
      if (k < 0 || inShadow[k]) continue;
      if (ratio[k]! < 0.75) (inShadow[k] = 1), stack.push(k);
      // Shadows continue behind the subject: step over it (and note it: the shadow is partly hidden).
      else if (near[k]) {
        inShadow[k] = 2;
        stack.push(k);
      }
    }
  }
  // Darkness by direction around the contact point.
  const BINS = 72;
  const hist = new Float64Array(BINS);
  for (let i = 0; i < w * h; i += 1) {
    if (inShadow[i] !== 1) continue;
    const r = Math.hypot(gx[i]!, gz[i]!);
    if (r < 0.15 * widthM) continue;
    const a = Math.atan2(gx[i]!, gz[i]!) / DEG;
    const b = Math.floor(((a + 360) % 360) / (360 / BINS)) % BINS;
    hist[b] = hist[b]! + (1 - ratio[i]!) * area[i]! * Math.min(1, r / widthM);
  }
  const sm = Array.from(hist, (_, i) => {
    let v = 0;
    for (let d = -2; d <= 2; d += 1) v += hist[(i + d + BINS) % BINS]! * (3 - Math.abs(d));
    return v / 9;
  });
  const peaks: number[] = [];
  const top1 = Math.max(...sm);
  if (!(top1 > 0)) return { shadows: [], subjectHeightM: H, contact, ratio };
  for (let i = 0; i < BINS; i += 1) if (sm[i]! >= 0.25 * top1 && sm[i]! >= sm[(i + 1) % BINS]! && sm[i]! > sm[(i + BINS - 1) % BINS]!) peaks.push(i);
  peaks.sort((a, b) => sm[b]! - sm[a]!);
  const shadows: ShadowEstimate[] = [];
  for (const p of peaks.slice(0, 4)) {
    const centre = ((p + 0.5) * 360) / BINS;
    // The sector's pixels: within 30° of the peak.
    let wx = 0;
    let wz = 0;
    let ws = 0;
    const dark: number[] = [];
    let hidden = 0;
    let px = 0;
    let m2 = 0;
    const dirs: { a: number; w: number }[] = [];
    for (let i = 0; i < w * h; i += 1) {
      if (inShadow[i] !== 1) continue;
      const a = Math.atan2(gx[i]!, gz[i]!) / DEG;
      const d = Math.abs(((a - centre + 540) % 360) - 180);
      if (d > 25 || ratio[i]! > 0.72 || Math.hypot(gx[i]!, gz[i]!) > 0.85 * reach) continue;
      // Darkness squared: the umbra counts, the faint skirt of other lights' shadows hardly.
      const weight = (1 - ratio[i]!) ** 2;
      wx += weight * gx[i]!;
      wz += weight * gz[i]!;
      ws += weight;
      dark.push(ratio[i]!);
      px += 1;
      dirs.push({ a, w: weight });
    }
    if (!ws || px < 12) continue;
    for (let i = 0; i < w * h; i += 1) {
      if (inShadow[i] !== 2) continue;
      const a = Math.atan2(gx[i]!, gz[i]!) / DEG;
      if (Math.abs(((a - centre + 540) % 360) - 180) <= 25) hidden += 1;
    }
    dark.sort((a, b) => a - b);
    const darkest = dark[Math.floor(dark.length * 0.1)]!;
    // A shadow running behind the subject is partly hidden: its centroid is biased towards the visible side.
    // Or simply running away from the camera: the subject then hides its middle from view.
    const occluded = hidden > 0.05 * px;
    const c = [wx / ws, wz / ws];
    const dist = Math.hypot(c[0]!, c[1]!);
    const shadowAz = Math.atan2(c[0]!, c[1]!) / DEG;
    for (const q of dirs) m2 += q.w * (((q.a - shadowAz + 540) % 360) - 180) ** 2;
    const spread = Math.sqrt(m2 / ws);
    const az = ((shadowAz + 180 + 540) % 360) - 180;
    const away = c[1]! < 0;
    // Elevation from the centroid: tan el = (H/2) / distance, ± 35 % in tan (shape, the part hidden by the subject).
    let el: number | null = null;
    let elHalf = 90;
    if (dist > 0.05 * widthM) {
      const t = H / 2 / dist;
      el = Math.atan(t) / DEG;
      const k = occluded || away ? 2 : 1.6;
      elHalf = Math.max(6, (Math.atan(t * k) - Math.atan(t / k)) / DEG / 2 + 3);
    }
    // Penumbra across the shadow's sides at its centroid: the 10–90 % width along the perpendicular.
    let sizeDeg: number | null = null;
    let sizeLow = 0;
    let sizeHigh = 60;
    if (el !== null && el > 3) {
      const ux = c[0]! / dist;
      const uz = c[1]! / dist;
      const perp = [-uz, ux];
      const widths: number[] = [];
      for (const side of [1, -1]) {
        const profile: { s: number; r: number }[] = [];
        const steps = 80;
        const span = 1.2 * Math.max(H, widthM);
        for (let k = 0; k <= steps; k += 1) {
          const s = (k / steps) * span;
          const gpt: V3 = [contact[0] + c[0]! + side * perp[0]! * s, contact[1], contact[2] + c[1]! + side * perp[1]! * s];
          const ip = projectLevel(cam, gpt);
          if (!ip || ip.x < 1 || ip.y < 1 || ip.x > w - 1 || ip.y > h - 1) break;
          const ii = Math.floor(ip.y) * w + Math.floor(ip.x);
          if (subject[ii]) break;
          const L = sample1(lum, w, h, ip.x, ip.y);
          profile.push({ s, r: L / litXZ(gpt[0] - contact[0], gpt[2] - contact[2]) });
        }
        if (profile.length < 10) continue;
        const rmin = Math.min(...profile.slice(0, Math.ceil(profile.length / 3)).map((q) => q.r));
        const rmax = Math.max(...profile.map((q) => q.r));
        if (rmax - rmin < 0.15) continue;
        const at = (f: number) => {
          const target = rmin + f * (rmax - rmin);
          for (let k = 1; k < profile.length; k += 1) if (profile[k - 1]!.r < target && profile[k]!.r >= target) return profile[k - 1]!.s + ((target - profile[k - 1]!.r) / (profile[k]!.r - profile[k - 1]!.r)) * (profile[k]!.s - profile[k - 1]!.s);
          return NaN;
        };
        const wd = at(0.9) - at(0.1);
        if (Number.isFinite(wd) && wd > 0) widths.push(wd);
      }
      if (widths.length) {
        const wd = widths.reduce((a, b) => a + b, 0) / widths.length;
        // The occluder (the subject's side at mid-height) to the ground along the light.
        const ell = H / 2 / Math.sin(el * DEG);
        // A pixel's footprint there: the narrowest edge the picture can show.
        const t = Math.hypot(contact[0] + c[0]!, contact[1], contact[2] + c[1]!);
        const pixelM = t / cam.focalPx;
        // The full penumbra is the source's diameter projected from the occluder: P = 2ℓ·tan(α/2).
        const alpha = (2 * Math.atan(wd / DISK_10_90 / 2 / ell)) / DEG;
        const floor = (2 * Math.atan((2.2 * pixelM) / DISK_10_90 / 2 / ell)) / DEG;
        if (alpha <= floor) {
          sizeDeg = floor / 2;
          sizeLow = 0;
          sizeHigh = floor * 1.3;
        } else {
          sizeDeg = alpha;
          sizeLow = alpha / 1.6;
          sizeHigh = alpha * 1.6;
        }
      }
    }
    const fromPt = projectLevel(cam, contact) ?? { x: cx, y: bottom };
    const toPt = projectLevel(cam, [contact[0] + c[0]!, contact[1], contact[2] + c[1]!]) ?? fromPt;
    shadows.push({ az, azHalf: Math.max(occluded || away ? 25 : 15, Math.min(45, 0.5 * spread + 4)), el, elHalf, depth: 1 - darkest, sizeDeg, sizeLow, sizeHigh, from: fromPt, to: toPt, pixels: px, occluded: occluded || away });
  }
  // The darkest shadow first: it belongs to the strongest light (a long faint shadow covers more ground).
  shadows.sort((a, b) => b.depth - a.depth);
  return { shadows, subjectHeightM: H, contact, ratio };
}
