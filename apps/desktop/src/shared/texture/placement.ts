import type { TexturePlane } from '@vcvfx/domain';
import type { LinearImage } from '../key/linear';
import { add, dirOf, dot3, equirectPixel, scale, sub, toCanonical, unit, type V3 } from './geometry';
import { sampleLinear } from './image';
import { canonicalToPanorama } from './panorama';
import { hitPlane } from './planes';

/**
 * Where a region belongs on the scan (master spec §12 "use panorama/spatial
 * context to suggest where source photographs belong on scanned geometry";
 * addendum 12 §3.4).
 *
 * A photo and the panorama see the same surfaces from different places, so
 * their pictures differ by parallax — but a planar surface, mapped onto its
 * own plane, looks the same from anywhere. So:
 *  1. each scan plane gets a *plane map*: the panorama projected onto it
 *     (for every point of the plane, the panorama pixel in its direction from
 *     where the panorama was taken, where that ray meets this plane first);
 *  2. the region, rectified from its photo at the same texels per metre, is
 *     found in those maps by normalised cross-correlation (perceptual
 *     luminance, so exposure does not matter): coarse over every plane,
 *     every quarter turn on a floor or ceiling, and a range of sizes when the
 *     real size is unknown; then texel by texel round the best;
 *  3. the best match is the plane, the place on it (a planar patch in scan
 *     coordinates) and the panorama direction of that place; its correlation,
 *     and how far it stands above the best match on another plane or
 *     elsewhere, the confidence.
 */

export interface PlaneMap {
  plane: TexturePlane;
  /** Texels per scan unit. */
  density: number;
  width: number;
  height: number;
  /** Perceptual luminance. */
  grey: Float32Array;
  /** 1 where the panorama sees this plane there. */
  valid: Uint8Array;
  /** Plane coordinates of texel (0, 0)'s centre: u along axisU, w down (−axisV). */
  u0: number;
  w0: number;
}

/** The point of a plane map texel (x, y), scan coordinates. */
export function mapPoint(m: PlaneMap, x: number, y: number): V3 {
  const u = m.u0 + x / m.density;
  const w = m.w0 + y / m.density;
  return add(add(m.plane.centroid, scale(m.plane.axisU, u)), scale(m.plane.axisV, -w));
}

export function planeMap(pano: LinearImage, plane: TexturePlane, planes: readonly TexturePlane[], o: { position: V3; heading: number; up: 'y' | 'z'; density: number; luma: readonly [number, number, number]; maxTexels?: number }): PlaneMap {
  const e = plane.extent;
  const mu = 0.03 * (e.u1 - e.u0);
  const mv = 0.03 * (e.v1 - e.v0);
  let density = o.density;
  const area = (e.u1 - e.u0 + 2 * mu) * (e.v1 - e.v0 + 2 * mv);
  const cap = o.maxTexels ?? 600_000;
  if (area * density * density > cap) density = Math.sqrt(cap / area);
  const width = Math.max(4, Math.ceil((e.u1 - e.u0 + 2 * mu) * density));
  const height = Math.max(4, Math.ceil((e.v1 - e.v0 + 2 * mv) * density));
  const m: PlaneMap = { plane, density, width, height, grey: new Float32Array(width * height), valid: new Uint8Array(width * height), u0: e.u0 - mu + 0.5 / density, w0: -(e.v1 + mv) + 0.5 / density };
  const tmp = new Float32Array(3);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const P = mapPoint(m, x, y);
      const d = sub(P, o.position);
      const r = Math.hypot(...d);
      if (r < 1e-6) continue;
      // Grazing views carry no texture; another plane in front hides this one.
      if (Math.abs(dot3(plane.normal, d)) / r < 0.12) continue;
      let hidden = false;
      for (const q of planes) {
        if (q.id === plane.id) continue;
        const h = hitPlane(q, o.position, d, 0);
        if (h && h.inside && h.t < 0.98) {
          hidden = true;
          break;
        }
      }
      if (hidden) continue;
      const { yaw, pitch } = canonicalToPanorama(toCanonical(d, o.up), o.heading);
      const [u, v] = equirectPixel(dirOf(yaw, pitch), pano.width, pano.height);
      sampleLinear(pano, u, v, tmp, 0, true);
      const i = y * width + x;
      m.grey[i] = Math.sqrt(Math.max(0, o.luma[0] * tmp[0]! + o.luma[1] * tmp[1]! + o.luma[2] * tmp[2]!));
      m.valid[i] = 1;
    }
  return m;
}

/**
 * Structure for matching: the grey minus its local mean (over valid texels),
 * blended with a little of the grey itself — the light across a surface is
 * the same for the photo and the panorama and places a region roughly; the
 * detail places it exactly.
 */
function structure(src: Float32Array, valid: Uint8Array | null, w: number, h: number, r: number, light = 0.25): Float32Array {
  const n = w * h;
  // A little smoothing first (3 × 3 binomial over valid texels): resampling leaves different aliasing in each.
  const grey = new Float32Array(n);
  for (let y = 0; y < h; y += 1)
    for (let x = 0; x < w; x += 1) {
      let s = 0;
      let k = 0;
      for (let j = -1; j <= 1; j += 1)
        for (let i = -1; i <= 1; i += 1) {
          const xx = x + i;
          const yy = y + j;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const q = yy * w + xx;
          if (valid && !valid[q]) continue;
          const wt = (i ? 1 : 2) * (j ? 1 : 2);
          s += src[q]! * wt;
          k += wt;
        }
      grey[y * w + x] = k ? s / k : src[y * w + x]!;
    }
  const sum = new Float64Array((w + 1) * (h + 1));
  const cnt = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y += 1) {
    let rs = 0;
    let rc = 0;
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      if (!valid || valid[i]) {
        rs += grey[i]!;
        rc += 1;
      }
      sum[(y + 1) * (w + 1) + x + 1] = sum[y * (w + 1) + x + 1]! + rs;
      cnt[(y + 1) * (w + 1) + x + 1] = cnt[y * (w + 1) + x + 1]! + rc;
    }
  }
  const out = new Float32Array(n);
  for (let y = 0; y < h; y += 1)
    for (let x = 0; x < w; x += 1) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w, x + r + 1);
      const y0 = Math.max(0, y - r);
      const y1 = Math.min(h, y + r + 1);
      const a = (y1 * (w + 1) + x1);
      const b = (y0 * (w + 1) + x1);
      const c = (y1 * (w + 1) + x0);
      const d = (y0 * (w + 1) + x0);
      const s = sum[a]! - sum[b]! - sum[c]! + sum[d]!;
      const k = cnt[a]! - cnt[b]! - cnt[c]! + cnt[d]!;
      const m = k > 0 ? s / k : 0;
      out[y * w + x] = grey[y * w + x]! - m + light * m;
    }
  return out;
}

/** Halve a map (2 × 2 means of valid texels). */
function shrink(grey: Float32Array, valid: Uint8Array, w: number, h: number, k: number): { grey: Float32Array; valid: Uint8Array; w: number; h: number } {
  if (k <= 1) return { grey, valid, w, h };
  const nw = Math.max(1, Math.floor(w / k));
  const nh = Math.max(1, Math.floor(h / k));
  const g = new Float32Array(nw * nh);
  const v = new Uint8Array(nw * nh);
  for (let y = 0; y < nh; y += 1)
    for (let x = 0; x < nw; x += 1) {
      let s = 0;
      let n = 0;
      for (let j = 0; j < k; j += 1)
        for (let i = 0; i < k; i += 1) {
          const q = (y * k + j) * w + x * k + i;
          if (valid[q]) {
            s += grey[q]!;
            n += 1;
          }
        }
      if (n >= (k * k) / 2) {
        g[y * nw + x] = s / n;
        v[y * nw + x] = 1;
      }
    }
  return { grey: g, valid: v, w: nw, h: nh };
}

const dims = (t: RegionTemplate): [number, number] => [t.width, t.height];

/** Rotate a template a quarter turn clockwise, `turns` times. */
function rotateTemplate(t: Float32Array, w: number, h: number, turns: number): { t: Float32Array; w: number; h: number } {
  let cur = t;
  let cw = w;
  let ch = h;
  for (let r = 0; r < ((turns % 4) + 4) % 4; r += 1) {
    const out = new Float32Array(cw * ch);
    // (x, y) → (ch − 1 − y, x) in a ch × cw picture.
    for (let y = 0; y < ch; y += 1) for (let x = 0; x < cw; x += 1) out[x * ch + (ch - 1 - y)] = cur[y * cw + x]!;
    cur = out;
    [cw, ch] = [ch, cw];
  }
  return { t: cur, w: cw, h: ch };
}

/** NCC of a template against a map at offset (ox, oy), over texels valid in the map (null when too few are). */
function nccAt(t: Float32Array, tw: number, th: number, g: Float32Array, valid: Uint8Array, w: number, ox: number, oy: number): number | null {
  let n = 0;
  let st = 0;
  let sg = 0;
  let stt = 0;
  let sgg = 0;
  let stg = 0;
  for (let y = 0; y < th; y += 1) {
    const row = (oy + y) * w + ox;
    const trow = y * tw;
    for (let x = 0; x < tw; x += 1) {
      if (!valid[row + x]) continue;
      const a = t[trow + x]!;
      const b = g[row + x]!;
      n += 1;
      st += a;
      sg += b;
      stt += a * a;
      sgg += b * b;
      stg += a * b;
    }
  }
  if (n < 0.7 * tw * th) return null;
  const vt = stt - (st * st) / n;
  const vg = sgg - (sg * sg) / n;
  if (vt <= 1e-12 || vg <= 1e-12) return null;
  return (stg - (st * sg) / n) / Math.sqrt(vt * vg);
}

export interface RegionTemplate {
  /** Perceptual luminance of the rectified region at the template density. */
  grey: Float32Array;
  width: number;
  height: number;
  /** Width and height of the region on the surface, scan units. */
  surfaceWidth: number;
  surfaceHeight: number;
}

export interface RegionPlacement {
  plane: TexturePlane;
  /** TL, TR, BR, BL, scan coordinates. */
  patch: V3[];
  centre: V3;
  /** Quarter turns of the texture on the plane (0 on a wall). */
  turns: number;
  /** Width of the matched region on the surface, scan units (the real size when it was given). */
  surfaceWidth: number;
  score: number;
  runnerUp: number;
  confidence: number;
}

/**
 * Find a region in the plane maps. `makeTemplate(widthUnits)` gives the region
 * rectified at a surface width (scan units) and the map density; with a real
 * size, one width is tried; without, a range.
 */
export function placeRegion(
  allMaps: readonly PlaneMap[],
  makeTemplate: (surfaceWidth: number, density: number) => RegionTemplate,
  o: { knownWidth: number | null; aspect: number; guess?: { planeId: string; width: number } | null; signal?: { aborted: boolean } },
): RegionPlacement | null {
  // Without a real size, the photo's direction from the panorama says roughly which plane and how big: search round that.
  const guessed = !o.knownWidth && o.guess ? allMaps.filter((m) => m.plane.id === o.guess!.planeId) : [];
  const maps = guessed.length ? guessed : allMaps;
  if (!maps.length) return null;
  // The light across a surface looks alike at every size: without the real size, match on detail alone.
  const light = o.knownWidth ? 0.25 : 0;
  type Cand = { map: PlaneMap; turns: number; width: number; x: number; y: number; score: number };
  const cands: Cand[] = [];
  for (const map of maps) {
    const pw = (map.plane.extent.u1 - map.plane.extent.u0) * 1.06;
    const ph = (map.plane.extent.v1 - map.plane.extent.v0) * 1.06;
    const horizontal = map.plane.label === 'floor' || map.plane.label === 'ceiling' || map.plane.label.startsWith('floor') || map.plane.label.startsWith('ceiling');
    const widths = (o.knownWidth ? [o.knownWidth] : guessed.length ? [0.6, 0.75, 0.9, 1.1, 1.3, 1.6].map((f) => f * o.guess!.width) : Array.from({ length: 7 }, (_, i) => 0.4 * Math.pow(1.4, i))).filter((w) => o.knownWidth || (w <= pw && w / o.aspect <= ph));
    for (const width of widths) {
      const height = width / o.aspect;
      // Coarse: about 28 texels across the template.
      const k = Math.max(1, Math.floor((width * map.density) / 28));
      const shrunk = shrink(map.grey, map.valid, map.width, map.height, k);
      const small = { ...shrunk, grey: structure(shrunk.grey, shrunk.valid, shrunk.w, shrunk.h, 3, light) };
      const raw = makeTemplate(width, map.density / k);
      const tpl = { ...raw, grey: structure(raw.grey, null, raw.width, raw.height, 3, light) };
      // Too few texels to say anything.
      if (tpl.width < 12 || tpl.height < 8) continue;
      for (const turns of horizontal ? [0, 1, 2, 3] : [0]) {
        if (o.signal?.aborted) throw new Error('Cancelled');
        const r = rotateTemplate(tpl.grey, tpl.width, tpl.height, turns);
        if (r.w > small.w || r.h > small.h) continue;
        const sideW = turns % 2 ? height : width;
        const sideH = turns % 2 ? width : height;
        if (sideW > pw || sideH > ph) continue;
        for (let y = 0; y <= small.h - r.h; y += 1)
          for (let x = 0; x <= small.w - r.w; x += 1) {
            const s = nccAt(r.t, r.w, r.h, small.grey, small.valid, small.w, x, y);
            if (s !== null) cands.push({ map, turns, width, x: x * k, y: y * k, score: s });
          }
      }
    }
  }
  if (!cands.length) return null;
  cands.sort((a, b) => b.score - a.score);
  // Refine the best few at full density: position (±k texels), and size when unknown.
  // Seeds: the best few overall, and the best two on every plane — a coarse score is only a guide
  // (smooth light on a plain wall can outscore the right place before the detail is seen).
  const seeds: Cand[] = [];
  const distinct = (c: Cand) => seeds.every((s) => s.map !== c.map || s.turns !== c.turns || Math.hypot(s.x - c.x, s.y - c.y) > 0.3 * c.width * c.map.density);
  for (const c of cands) {
    if (seeds.length >= 5) break;
    if (distinct(c)) seeds.push(c);
  }
  for (const map of maps) {
    let n = 0;
    for (const c of cands) {
      if (n >= 2) break;
      if (c.map !== map) continue;
      if (distinct(c)) seeds.push(c);
      n += 1;
    }
  }
  const fine = new Map<string, Float32Array>();
  const refined = seeds.map((c) => {
    let best = { ...c, score: -2 };
    const kc = Math.max(1, Math.floor((c.width * c.map.density) / 28));
    const k = kc + 1;
    const key = `${c.map.plane.id}|${kc}`;
    let fineMap = fine.get(key);
    if (!fineMap) {
      fineMap = structure(c.map.grey, c.map.valid, c.map.width, c.map.height, 3 * kc, light);
      fine.set(key, fineMap);
    }
    const first = rotateTemplate(makeTemplate(c.width, c.map.density).grey, ...dims(makeTemplate(c.width, c.map.density)), c.turns);
    const centreX = c.x + first.w / 2;
    const centreY = c.y + first.h / 2;
    for (const width of o.knownWidth ? [c.width] : [c.width / 1.12, c.width, c.width * 1.12]) {
      const raw = makeTemplate(width, c.map.density);
      const r = rotateTemplate(structure(raw.grey, null, raw.width, raw.height, 3 * kc, light), raw.width, raw.height, c.turns);
      for (let dy = -k; dy <= k; dy += 1)
        for (let dx = -k; dx <= k; dx += 1) {
          const x = Math.round(centreX - r.w / 2) + dx;
          const y = Math.round(centreY - r.h / 2) + dy;
          if (x < 0 || y < 0 || x + r.w > c.map.width || y + r.h > c.map.height) continue;
          const s = nccAt(r.t, r.w, r.h, fineMap, c.map.valid, c.map.width, x, y);
          if (s !== null && s > best.score) best = { ...c, width, x, y, score: s };
        }
    }
    return best;
  });
  refined.sort((a, b) => b.score - a.score);
  const best = refined[0]!;
  if (best.score <= -1) return null;
  // The best elsewhere: another plane, turn, or more than half the region away.
  // The best elsewhere: on another plane (or turn), and on this plane more than half the region away.
  let otherPlane = -1;
  let samePlane = -1;
  // Refined scores only: coarse ones are on another scale.
  for (const c of refined.slice(1)) {
    if (c.map !== best.map || c.turns !== best.turns) otherPlane = Math.max(otherPlane, c.score);
    else if (Math.hypot(c.x - best.x, c.y - best.y) > 0.5 * best.width * best.map.density) samePlane = Math.max(samePlane, c.score);
  }
  const runnerUp = Math.max(otherPlane, samePlane);
  const map = best.map;
  const width = best.width;
  const height = width / o.aspect;
  const tw = (best.turns % 2 ? height : width) * map.density;
  const th = (best.turns % 2 ? width : height) * map.density;
  // The template's corners on the map, in the template's own order (TL, TR, BR, BL) after its turns.
  const rect: [number, number][] = [
    [best.x - 0.5, best.y - 0.5],
    [best.x - 0.5 + tw, best.y - 0.5],
    [best.x - 0.5 + tw, best.y - 0.5 + th],
    [best.x - 0.5, best.y - 0.5 + th],
  ];
  // A quarter turn clockwise moves the texture's TL to the map's TR …
  const order = [0, 1, 2, 3].map((i) => rect[(i + best.turns) % 4]!);
  const patch = order.map(([x, y]) => mapPoint(map, x, y));
  const centre = mapPoint(map, best.x - 0.5 + tw / 2, best.y - 0.5 + th / 2);
  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
  // Sure of the plane when nothing on another plane comes close; of the place on it when nothing else on it does
  // (a brick wall half a region along looks much like itself).
  const confidence = clamp01((best.score - 0.25) / 0.45) * clamp01((best.score - otherPlane) / 0.12) * (0.5 + 0.5 * clamp01((best.score - samePlane) / 0.08));
  return { plane: map.plane, patch, centre, turns: best.turns, surfaceWidth: width, score: best.score, runnerUp, confidence: Math.round(confidence * 1000) / 1000 };
}

/** The panorama direction (yaw, pitch) of a scan point. */
export function directionTo(point: ArrayLike<number>, o: { position: V3; heading: number; up: 'y' | 'z' }): { yaw: number; pitch: number } {
  return canonicalToPanorama(toCanonical(unit(sub(point, o.position)), o.up), o.heading);
}
