import type { LinearImage } from '../key/linear';
import { inv3, mul3 } from '../cleanplate/synthetic';

/**
 * A synthetic sky shot with exact ground truth (addendum 11 §7), rendered in
 * scene-linear light, frame by frame, deterministically. The tests measure
 * the isolation against it; the browser preview, which has no media, builds
 * its sky and background isolation for real.
 *
 * A sky (a clear blue gradient, or an overcast grey one, with soft clouds)
 * over a city skyline (buildings with lit windows, antennas), a bare tree
 * whose branches thin to a third of a pixel, poles carrying a power line well
 * under a pixel wide, seen by a camera that pans and zooms a little — each
 * frame is the world through a known homography. A runner crosses a low roof
 * with the sky behind his head and shoulders (an occluder that moves in front
 * of the sky, and the subject of a background removal), and a bird flies
 * across the sky. The static layers are tabulated once at two samples per
 * world unit, with box-filtered coverage, and read bilinearly, so the frames
 * and the truth are made from the same numbers.
 */

export interface SkySceneOptions {
  width?: number;
  height?: number;
  frames?: number;
  /** Pixels the camera pans over the shot (at this size). */
  pan?: number;
  sky?: 'clear' | 'overcast';
  /** Lightens the foreground towards the sky (0 … 1): a hazy, low-contrast shot. */
  haze?: number;
  noise?: number;
  runner?: boolean;
  bird?: boolean;
  seed?: number;
}

export interface SkyScene {
  width: number;
  height: number;
  frames: number;
  render(n: number): LinearImage;
  /** Coverage of everything in front of the sky (0 … 1). */
  alpha(n: number): Float32Array;
  /** The sky alone (the truth of the sky plate). */
  sky(n: number): LinearImage;
  /** Coverage of the runner. */
  runner(n: number): Float32Array;
  /** The frame without the runner (the truth of a background plate). */
  background(n: number): LinearImage;
  /** Coverage of the power line alone, and of the tree's thin branches (radius < 1 px) alone. */
  wire(n: number): Float32Array;
  branches(n: number): Float32Array;
  /** Coverage of the bird. */
  bird(n: number): Float32Array;
  /** Ground truth: frame `a` pixel → frame `b` pixel (row-major 3×3). */
  homography(a: number, b: number): number[];
}

const hash = (x: number, y: number, s: number): number => {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

function valueNoise(x: number, y: number, scale: number, seed: number): number {
  const fx = x / scale;
  const fy = y / scale;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const a = hash(x0, y0, seed);
  const b = hash(x0 + 1, y0, seed);
  const c = hash(x0, y0 + 1, seed);
  const d = hash(x0 + 1, y0 + 1, seed);
  return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
}

/** Box-filtered coverage (1 world unit footprint) of a strip of `width` at distance d from its centre line. */
const strip = (d: number, width: number) => Math.max(0, Math.min(Math.abs(d) + width / 2, 0.5) - Math.max(Math.abs(d) - width / 2, -0.5));
/** Coverage of a solid shape at signed distance sd (negative inside). */
const solid = (sd: number) => (sd <= -0.5 ? 1 : sd >= 0.5 ? 0 : 0.5 - sd);

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  let t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(ax + t * dx - px, ay + t * dy - py);
}

interface Seg {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  r: number;
}

export function skyScene(options: SkySceneOptions = {}): SkyScene {
  const width = options.width ?? 320;
  const height = options.height ?? 180;
  const frames = options.frames ?? 24;
  const seed = options.seed ?? 5;
  const u = height / 180;
  const pan = options.pan ?? 0.25 * width;
  const overcast = options.sky === 'overcast';
  const haze = options.haze ?? 0;
  const noise = options.noise ?? 0;
  const withRunner = options.runner ?? true;
  const withBird = options.bird ?? true;

  /** Image pixel → world for frame n: a pan, a slow push-in and a slight tilt drift about the frame centre. */
  const toWorld = (n: number): number[] => {
    const t = frames > 1 ? n / (frames - 1) : 0;
    const s = 1 + 0.03 * (t - 0.5);
    const tx = pan * (t - 0.5);
    const ty = 0.04 * pan * Math.sin(Math.PI * t);
    const cx = width / 2;
    const cy = height / 2;
    return mul3([s, 0, cx + tx, 0, s, cy + ty, 0, 0, 1], [1, 0, -cx, 0, 1, -cy, 0, 0, 1]);
  };
  const worldOf = Array.from({ length: frames }, (_, n) => toWorld(n));

  // ---- The world (units ≈ pixels at this size). ----
  const X0 = -pan / 2 - 0.08 * width;
  const X1 = width + pan / 2 + 0.08 * width;
  const skyColour = (X: number, Y: number): [number, number, number] => {
    const t = Math.max(0, Math.min(1, (Y + 0.05 * height) / (0.85 * height)));
    const cloud = valueNoise(X + 3 * Y, Y * 2.2, 46 * u, seed + 21) * 0.6 + valueNoise(X, Y * 2, 17 * u, seed + 22) * 0.4;
    if (overcast) {
      const g = 0.38 + 0.22 * t + 0.06 * (cloud - 0.5);
      return [g * 0.98, g, g * 1.03];
    }
    const top: [number, number, number] = [0.07, 0.17, 0.52];
    const hor: [number, number, number] = [0.42, 0.52, 0.68];
    const c = Math.max(0, cloud - 0.55) * 1.6;
    return [0, 1, 2].map((k) => (top[k]! + (hor[k]! - top[k]!) * t) * (1 - c) + 0.62 * c) as [number, number, number];
  };

  // Buildings: [x0, x1, top] in world units; a long low roof in the middle for the runner.
  const B: [number, number, number][] = [];
  {
    let x = X0;
    let k = 0;
    while (x < X1) {
      const r = hash(k, 3, seed);
      let w = (22 + 40 * hash(k, 4, seed)) * u;
      let top = height * (0.5 + 0.22 * r);
      if (x > 0.36 * width && x < 0.62 * width) {
        // The runner's roof.
        w = Math.max(w, 0.7 * width - x);
        top = height * 0.74;
      }
      B.push([x, x + w, top]);
      x += w;
      k += 1;
    }
  }
  const antennas: Seg[] = B.filter((_, i) => hash(i, 9, seed) > 0.6 && _[2] < height * 0.7).map(([a, b, top], i) => {
    const x = a + (b - a) * (0.3 + 0.4 * hash(i, 10, seed));
    return { ax: x, ay: top, bx: x, by: top - (10 + 10 * hash(i, 11, seed)) * u, r: 0.45 * u };
  });
  const buildingAt = (X: number) => B.find((b) => X >= b[0] && X < b[1]) ?? B[0]!;
  const facade = (X: number, Y: number): [number, number, number] => {
    const b = buildingAt(X);
    const i = B.indexOf(b);
    const base = 0.045 + 0.05 * hash(i, 5, seed);
    const tint = hash(i, 6, seed);
    const n = valueNoise(X, Y, 5 * u, seed + 30 + i);
    // Windows: a grid, some lit.
    const wx = (X - b[0]) / (6 * u);
    const wy = (Y - b[2]) / (7 * u);
    const inWin = wx % 1 > 0.35 && wy % 1 > 0.4 && Y > b[2] + 3 * u;
    const lit = inWin && hash(Math.floor(wx) + 97 * i, Math.floor(wy), seed + 7) > 0.55;
    const l = base * (0.8 + 0.4 * n) + (lit ? 0.12 : inWin ? -0.015 : 0);
    return [l * (1 + 0.15 * tint), l * (1 + 0.05 * tint), l * (1.05 - 0.1 * tint)];
  };

  // The tree: a trunk on the left, branching six times; thin branches go under a pixel.
  const branches: Seg[] = [];
  {
    const grow = (x: number, y: number, ang: number, len: number, r: number, depth: number, k: number) => {
      const bx = x + Math.cos(ang) * len;
      const by = y - Math.sin(ang) * len;
      branches.push({ ax: x, ay: y, bx, by, r });
      if (depth === 0) return;
      const spread = 0.35 + 0.25 * hash(k, depth, seed + 40);
      grow(bx, by, ang + spread, len * (0.68 + 0.1 * hash(k, 1, seed + 41)), r * 0.62, depth - 1, 2 * k + 1);
      grow(bx, by, ang - spread * 0.9, len * (0.66 + 0.1 * hash(k, 2, seed + 41)), r * 0.6, depth - 1, 2 * k + 2);
    };
    grow(0.16 * width, height * 0.78, Math.PI / 2 + 0.08, 34 * u, 2.6 * u, 6, 0);
  }
  // Poles and the power line between them (well under a pixel wide).
  const poleA = 0.6 * width;
  const poleB = 0.92 * width;
  const poleTop = height * 0.4;
  const poles: Seg[] = [poleA, poleB].map((x) => ({ ax: x, ay: poleTop, bx: x, by: height * 0.8, r: 0.8 * u }));
  const wireWidth = 0.55 * u;
  const sag = 0.07 * height;
  const wireY = (X: number) => {
    const t = (X - poleA) / (poleB - poleA);
    return poleTop + 2 * u + sag * 4 * t * (1 - t);
  };

  const pad = 4;
  const corners: [number, number][] = [];
  for (const G of worldOf)
    for (const [x, y] of [
      [0, 0],
      [width, 0],
      [width, height],
      [0, height],
    ] as const) {
      const w = G[6]! * x + G[7]! * y + G[8]!;
      corners.push([(G[0]! * x + G[1]! * y + G[2]!) / w, (G[3]! * x + G[4]! * y + G[5]!) / w]);
    }
  const TX0 = Math.floor(Math.min(...corners.map((c) => c[0])) - pad);
  const TY0 = Math.floor(Math.min(...corners.map((c) => c[1])) - pad);
  const TS = 2;
  const TW = Math.ceil((Math.max(...corners.map((c) => c[0])) + pad - TX0) * TS) + 2;
  const TH = Math.ceil((Math.max(...corners.map((c) => c[1])) + pad - TY0) * TS) + 2;
  // Per sample: sky RGB, foreground premultiplied RGB, foreground coverage, wire coverage, thin-branch coverage.
  const tSky = new Float32Array(TW * TH * 3);
  const tFg = new Float32Array(TW * TH * 3);
  const tA = new Float32Array(TW * TH);
  const tWire = new Float32Array(TW * TH);
  const tThin = new Float32Array(TW * TH);
  const over = (j: number, a: number, rgb: readonly number[]) => {
    if (a <= 0) return;
    for (let k = 0; k < 3; k += 1) tFg[3 * j + k] = tFg[3 * j + k]! * (1 - a) + rgb[k]! * a;
    tA[j] = tA[j]! * (1 - a) + a;
  };
  const segCover = (s: Seg, X: number, Y: number) => strip(segDist(X, Y, s.ax, s.ay, s.bx, s.by), 2 * s.r);
  const bounds = (s: Seg) => ({ x0: Math.min(s.ax, s.bx) - s.r - 1, x1: Math.max(s.ax, s.bx) + s.r + 1, y0: Math.min(s.ay, s.by) - s.r - 1, y1: Math.max(s.ay, s.by) + s.r + 1 });
  const branchBounds = branches.map(bounds);
  const otherSegs = [...antennas, ...poles];
  const otherBounds = otherSegs.map(bounds);
  for (let j = 0; j < TH; j += 1)
    for (let i = 0; i < TW; i += 1) {
      const X = TX0 + i / TS;
      const Y = TY0 + j / TS;
      const q = j * TW + i;
      const s = skyColour(X, Y);
      tSky[3 * q] = s[0];
      tSky[3 * q + 1] = s[1];
      tSky[3 * q + 2] = s[2];
      // Buildings (the roofline is the only edge against the sky; walls between buildings are flush).
      const b = buildingAt(X);
      const ab = solid(b[2] - Y);
      if (ab > 0) over(q, ab, facade(X, Y));
      for (let k = 0; k < otherSegs.length; k += 1) {
        const bb = otherBounds[k]!;
        if (X < bb.x0 || X > bb.x1 || Y < bb.y0 || Y > bb.y1) continue;
        over(q, segCover(otherSegs[k]!, X, Y), [0.02, 0.02, 0.022]);
      }
      if (X > poleA && X < poleB) {
        const d = (Y - wireY(X)) / Math.hypot(1, (wireY(X + 0.5) - wireY(X - 0.5)));
        const a = strip(d, wireWidth);
        tWire[q] = a;
        over(q, a, [0.008, 0.008, 0.009]);
      }
      let thin = 0;
      for (let k = 0; k < branches.length; k += 1) {
        const bb = branchBounds[k]!;
        if (X < bb.x0 || X > bb.x1 || Y < bb.y0 || Y > bb.y1) continue;
        const a = segCover(branches[k]!, X, Y);
        if (a <= 0) continue;
        if (branches[k]!.r < 0.5) thin = 1 - (1 - thin) * (1 - a);
        over(q, a, [0.035, 0.026, 0.02]);
      }
      tThin[q] = thin;
      if (haze > 0 && tA[q]! > 0) for (let k = 0; k < 3; k += 1) tFg[3 * q + k] = tFg[3 * q + k]! + (s[k]! * 0.85 * tA[q]! - tFg[3 * q + k]!) * haze;
    }

  const lookup = (G: number[], x: number, y: number) => {
    const w = G[6]! * x + G[7]! * y + G[8]!;
    const X = (G[0]! * x + G[1]! * y + G[2]!) / w;
    const Y = (G[3]! * x + G[4]! * y + G[5]!) / w;
    const fx = Math.min(TW - 1.001, Math.max(0, (X - TX0) * TS));
    const fy = Math.min(TH - 1.001, Math.max(0, (Y - TY0) * TS));
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    return { X, Y, a: y0 * TW + x0, tx: fx - x0, ty: fy - y0 };
  };
  const bil = (t: Float32Array, ch: number, at: { a: number; tx: number; ty: number }, k: number) => {
    const a = at.a;
    const b = a + 1;
    const c = a + TW;
    const d = c + 1;
    const top = t[ch * a + k]! + (t[ch * b + k]! - t[ch * a + k]!) * at.tx;
    const bot = t[ch * c + k]! + (t[ch * d + k]! - t[ch * c + k]!) * at.tx;
    return top + (bot - top) * at.ty;
  };

  /** Runner and bird positions (world) at frame n. */
  const runnerAt = (n: number) => {
    const t = frames > 1 ? n / (frames - 1) : 0;
    // A stride every 16 frames (a brisk walk at 24 fps), whatever the shot's length.
    const phase = (2 * Math.PI * n) / 16;
    return { cx: width * (0.4 + 0.24 * t), foot: height * 0.74, bob: 1.2 * u * Math.abs(Math.sin(phase)), stride: Math.sin(phase) };
  };
  const birdAt = (n: number) => {
    const t = frames > 1 ? n / (frames - 1) : 0;
    return { cx: width * (0.15 + 0.7 * t), cy: height * (0.17 + 0.06 * t + 0.015 * Math.sin(9 * t)) };
  };

  interface Layers {
    sky: Float32Array;
    fg: Float32Array;
    a: Float32Array;
    wire: Float32Array;
    thin: Float32Array;
    runnerA: Float32Array;
    runnerRgb: Float32Array;
    birdA: Float32Array;
  }
  const cache = new Map<number, Layers>();
  const layers = (n0: number): Layers => {
    const n = Math.max(0, Math.min(frames - 1, n0));
    const hit = cache.get(n);
    if (hit) return hit;
    const G = worldOf[n]!;
    const N = width * height;
    const out: Layers = { sky: new Float32Array(N * 3), fg: new Float32Array(N * 3), a: new Float32Array(N), wire: new Float32Array(N), thin: new Float32Array(N), runnerA: new Float32Array(N), runnerRgb: new Float32Array(N * 3), birdA: new Float32Array(N) };
    const r = runnerAt(n);
    const bd = birdAt(n);
    const scale = Math.hypot(G[0]!, G[3]!);
    for (let y = 0; y < height; y += 1)
      for (let x = 0; x < width; x += 1) {
        const i = y * width + x;
        const at = lookup(G, x, y);
        for (let k = 0; k < 3; k += 1) {
          out.sky[3 * i + k] = bil(tSky, 3, at, k);
          out.fg[3 * i + k] = bil(tFg, 3, at, k);
        }
        out.a[i] = bil(tA, 1, at, 0);
        out.wire[i] = bil(tWire, 1, at, 0);
        out.thin[i] = bil(tThin, 1, at, 0);
        const { X, Y } = at;
        if (withRunner && Math.abs(X - r.cx) < 30 * u && Y > r.foot - 50 * u && Y < r.foot + 1) {
          const head = Math.hypot(X - r.cx, Y - (r.foot - 41 * u - r.bob)) - 4.2 * u;
          const torso = segDist(X, Y, r.cx, r.foot - 35 * u - r.bob, r.cx + 1.5 * u, r.foot - 19 * u - r.bob) - 5 * u;
          const legA = segDist(X, Y, r.cx + 1.5 * u, r.foot - 19 * u - r.bob, r.cx + 6 * u * r.stride, r.foot - 1.5 * u) - 2.2 * u;
          const legB = segDist(X, Y, r.cx + 1.5 * u, r.foot - 19 * u - r.bob, r.cx - 6 * u * r.stride, r.foot - 1.5 * u) - 2.2 * u;
          const arm = segDist(X, Y, r.cx, r.foot - 33 * u - r.bob, r.cx - 7 * u * r.stride, r.foot - 22 * u - r.bob) - 1.6 * u;
          const sd = Math.min(head, torso, legA, legB, arm) / scale;
          const a = solid(sd);
          if (a > 0) {
            out.runnerA[i] = a;
            const skin = head <= torso && head <= arm;
            const legs = Math.min(legA, legB) < Math.min(head, torso, arm);
            const tex = 0.85 + 0.3 * valueNoise(X - r.cx, Y, 2.5 * u, seed + 50);
            const c = skin ? [0.42, 0.26, 0.18] : legs ? [0.03, 0.035, 0.05] : [0.34, 0.045, 0.035];
            for (let k = 0; k < 3; k += 1) out.runnerRgb[3 * i + k] = c[k]! * tex;
          }
        }
        if (withBird && Math.abs(X - bd.cx) < 10 * u && Math.abs(Y - bd.cy) < 6 * u) {
          const e = Math.hypot((X - bd.cx) / (5 * u), (Y - bd.cy) / (2 * u)) - 1;
          const wing = segDist(X, Y, bd.cx - 7 * u, bd.cy - 2.5 * u, bd.cx + 7 * u, bd.cy - 2.5 * u) - 0.9 * u;
          out.birdA[i] = solid(Math.min(e * 2 * u, wing) / scale);
        }
      }
    cache.set(n, out);
    if (cache.size > 8) cache.delete(cache.keys().next().value!);
    return out;
  };

  const compose = (n: number, withSubject: boolean): Float32Array => {
    const L = layers(n);
    const N = width * height;
    const data = new Float32Array(N * 3);
    for (let i = 0; i < N; i += 1) {
      const ab = L.birdA[i]!;
      const ar = withSubject ? L.runnerA[i]! : 0;
      for (let k = 0; k < 3; k += 1) {
        let v = L.sky[3 * i + k]! * (1 - L.a[i]!) + L.fg[3 * i + k]!;
        v = v * (1 - ab) + 0.02 * ab;
        v = v * (1 - ar) + L.runnerRgb[3 * i + k]! * ar;
        if (noise) v += (hash(i, k, seed * 7919 + n) + hash(i, k + 3, seed * 31 + n) - 1) * noise * 2.45;
        data[3 * i + k] = v;
      }
    }
    return data;
  };

  return {
    width,
    height,
    frames,
    homography: (a, b) => mul3(inv3(worldOf[b]!), worldOf[a]!).map((v, _i, arr) => v / arr[8]!),
    render: (n) => ({ width, height, data: compose(n, true) }),
    background: (n) => ({ width, height, data: compose(n, false) }),
    sky: (n) => ({ width, height, data: layers(n).sky.slice() }),
    alpha(n) {
      const L = layers(n);
      const out = new Float32Array(width * height);
      for (let i = 0; i < out.length; i += 1) out[i] = 1 - (1 - L.a[i]!) * (1 - L.birdA[i]!) * (1 - L.runnerA[i]!);
      return out;
    },
    runner: (n) => layers(n).runnerA.slice(),
    wire: (n) => layers(n).wire.slice(),
    branches: (n) => layers(n).thin.slice(),
    bird: (n) => layers(n).birdA.slice(),
  };
}
