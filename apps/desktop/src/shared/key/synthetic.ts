import type { ScreenKind } from '@vcvfx/domain';
import { gaussianBlur } from '../roto/image';
import type { LinearImage } from './linear';

/**
 * A synthetic green- (or blue-) screen shot with exact ground truth
 * (addendum 09 §6): rendered in scene-linear light, frame by frame,
 * deterministically. The tests measure the keyer against it; the browser
 * preview, which has no media, keys it for real.
 *
 * A figure — skin, a brown hair cap with fine strands (0.3–0.9 px wide, some
 * part-transparent) and a soft fly-away halo, a red shirt, dark trousers, and
 * an arm swinging fast enough to motion-blur (eight samples over a 180°
 * shutter) — in front of a screen lit unevenly (a hot spot, a dim corner, a
 * darker seam), with spill from the screen on the subject (strongest at its
 * edges), sensor noise, and a background plate (a night street: dark sky,
 * warm street light, bokeh) for despill and light wrap. Optionally one frame
 * where half the screen's light goes out — a frame the problem detection
 * must find.
 */

export interface GreenScreenOptions {
  width?: number;
  height?: number;
  frames?: number;
  kind?: ScreenKind;
  /** 0: flat screen; 1: the default unevenness. */
  unevenness?: number;
  /** Spill strength (0: none). */
  spill?: number;
  /** Noise σ in linear units. */
  noise?: number;
  /** A frame whose screen loses half its light. */
  badFrame?: number;
  seed?: number;
}

export interface GreenScreenScene {
  width: number;
  height: number;
  frames: number;
  kind: ScreenKind;
  /** The plate as shot: linear RGB. */
  render(n: number): LinearImage;
  /** Ground-truth alpha. */
  alpha(n: number): Float32Array;
  /** Ground-truth premultiplied foreground without spill. */
  foreground(n: number): Float32Array;
  /** The spill that was added (premultiplied, linear RGB). */
  spillAdded(n: number): Float32Array;
  /** The screen alone (the true clean plate) on frame n. */
  screen(n: number): Float32Array;
  /** The background plate (same size). */
  background: LinearImage;
  /** Representative linear colours of the scene. */
  colours: { screen: [number, number, number]; skin: [number, number, number]; shirt: [number, number, number]; hair: [number, number, number] };
}

const hash = (x: number, y: number, s: number): number => {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

/** Signed distance to a capsule (segment a–b, radius r). */
function sdCapsule(px: number, py: number, ax: number, ay: number, bx: number, by: number, r: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy || 1;
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(ax + t * dx - px, ay + t * dy - py) - r;
}

/** Approximate signed distance to an ellipse. */
function sdEllipse(px: number, py: number, cx: number, cy: number, rx: number, ry: number): number {
  const x = (px - cx) / rx;
  const y = (py - cy) / ry;
  const k = Math.hypot(x, y);
  return (k - 1) * Math.min(rx, ry);
}

const cover = (sd: number) => (sd <= -0.5 ? 1 : sd >= 0.5 ? 0 : 0.5 - sd);

export function greenScreenScene(options: GreenScreenOptions = {}): GreenScreenScene {
  const width = options.width ?? 480;
  const height = options.height ?? 270;
  const frames = options.frames ?? 24;
  const kind = options.kind ?? 'green';
  const uneven = options.unevenness ?? 1;
  const spillK = options.spill ?? 1;
  const noise = options.noise ?? 0.003;
  const seed = options.seed ?? 11;
  const u = height / 270;
  const base: [number, number, number] = kind === 'green' ? [0.055, 0.4, 0.085] : [0.035, 0.1, 0.42];
  const skin: [number, number, number] = [0.55, 0.32, 0.23];
  const shirt: [number, number, number] = [0.42, 0.07, 0.06];
  const trousers: [number, number, number] = [0.05, 0.05, 0.065];
  const hair: [number, number, number] = [0.1, 0.06, 0.035];

  // Screen lighting, fixed over the shot.
  const light = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const hot = Math.exp(-(((x - 0.42 * width) ** 2 + (y - 0.38 * height) ** 2) / (2 * (0.42 * width) ** 2)));
      const corner = 1 - 0.35 * Math.max(0, (x / width - 0.6) / 0.4) * Math.max(0, (y / height - 0.5) / 0.5);
      const seam = 1 - 0.12 * Math.exp(-(((x - 0.72 * width) / (6 * u)) ** 2));
      light[y * width + x] = 1 + uneven * (0.55 * hot + corner + seam - 2 - 0.25);
    }
  const screenAt = (n: number): Float32Array => {
    const out = new Float32Array(width * height * 3);
    for (let i = 0; i < width * height; i += 1) {
      let l = light[i]!;
      if (options.badFrame === n && i % width > width / 2) l *= 0.5;
      out[3 * i] = base[0] * l;
      out[3 * i + 1] = base[1] * l;
      out[3 * i + 2] = base[2] * l;
    }
    return out;
  };

  // Hair strands, fixed per scene: a root angle and length each.
  const strands = Array.from({ length: 70 }, (_, k) => ({
    angle: Math.PI * (1.05 + 0.9 * hash(k, 1, seed)),
    length: (8 + 18 * hash(k, 2, seed)) * u,
    curl: (hash(k, 3, seed) - 0.5) * 0.9,
    width: (0.3 + 0.6 * hash(k, 4, seed)) * u,
    opacity: 0.55 + 0.45 * hash(k, 5, seed),
  }));

  interface Frame {
    alpha: Float32Array;
    fg: Float32Array;
  }
  const cache = new Map<number, Frame>();
  const layers = (n: number): Frame => {
    const hit = cache.get(n);
    if (hit) return hit;
    const t = n / Math.max(1, frames);
    const cx = width * (0.42 + 0.1 * Math.sin(2 * Math.PI * t));
    const top = height * 0.14;
    const headY = top + 34 * u;
    const headR = 22 * u;
    const shoulderY = headY + 46 * u;
    const alpha = new Float32Array(width * height);
    const fg = new Float32Array(width * height * 3);
    const paint = (i: number, a: number, c: readonly number[]) => {
      if (a <= 0) return;
      const k = 1 - a;
      alpha[i] = alpha[i]! * k + a;
      fg[3 * i] = fg[3 * i]! * k + a * c[0]!;
      fg[3 * i + 1] = fg[3 * i + 1]! * k + a * c[1]!;
      fg[3 * i + 2] = fg[3 * i + 2]! * k + a * c[2]!;
    };
    // The arm swings fast: its angle over the shutter (half the frame interval).
    const swing = (s: number) => 0.9 * Math.sin(2 * Math.PI * (t * 3 + s / frames));
    const armLen = 70 * u;
    const ax = cx + 26 * u;
    const ay = shoulderY + 6 * u;
    const strandPaths = strands.map((s) => {
      const pts: [number, number][] = [];
      const wobble = 0.15 * Math.sin(2 * Math.PI * t * 2 + s.angle * 3);
      for (let j = 0; j <= 6; j += 1) {
        const f = j / 6;
        const ang = s.angle + (s.curl + wobble) * f;
        const r = headR * 0.92 + s.length * f;
        pts.push([cx + Math.cos(ang) * r, headY - 4 * u + Math.sin(ang) * r]);
      }
      return { ...s, pts };
    });
    const x0 = Math.max(0, Math.floor(cx - 110 * u));
    const x1 = Math.min(width - 1, Math.ceil(cx + 120 * u));
    const y0 = Math.max(0, Math.floor(top - 30 * u));
    for (let y = y0; y < height; y += 1)
      for (let x = x0; x <= x1; x += 1) {
        const px = x + 0.5;
        const py = y + 0.5;
        const i = y * width + x;
        // Trousers (to the bottom of the frame), torso.
        paint(i, cover(Math.max(Math.abs(px - cx) - 24 * u, shoulderY + 84 * u - py)), trousers);
        paint(i, cover(sdCapsule(px, py, cx, shoulderY + 14 * u, cx, shoulderY + 80 * u, 28 * u)), shirt);
        // The arm, motion-blurred: coverage averaged over eight positions within the shutter.
        let arm = 0;
        for (let s = 0; s < 8; s += 1) {
          const a = swing((s / 7 - 0.5) * 0.5);
          arm += cover(sdCapsule(px, py, ax, ay, ax + Math.sin(a) * armLen, ay + Math.cos(a) * armLen, 8 * u));
        }
        paint(i, arm / 8, shirt);
        // Head, then the hair cap over its top.
        const dHead = sdEllipse(px, py, cx, headY, headR * 0.86, headR);
        paint(i, cover(dHead), skin);
        paint(i, cover(Math.max(dHead - 1.5 * u, py - (headY - 6 * u))), hair);
        // Fly-away halo: a soft, part-transparent fringe around the top of the head.
        if (py < headY + 4 * u) {
          const d = sdEllipse(px, py, cx, headY - 3 * u, headR * 1.0, headR * 1.12);
          if (d > -1 && d < 7 * u) paint(i, 0.35 * Math.exp(-Math.max(0, d) / (2.2 * u)) * Math.min(1, (d + 1) / 1.5), hair);
        }
        // Strands.
        if (Math.abs(px - cx) < headR + 30 * u && py < headY + 20 * u) {
          for (const s of strandPaths) {
            let best = 1e9;
            for (let j = 0; j < s.pts.length - 1; j += 1) {
              const [ax2, ay2] = s.pts[j]!;
              const [bx2, by2] = s.pts[j + 1]!;
              const d = sdCapsule(px, py, ax2, ay2, bx2, by2, 0);
              if (d < best) best = d;
            }
            // Coverage of a strand narrower than a pixel: its width, spread over a pixel.
            if (best < 1.2) paint(i, s.opacity * Math.min(1, s.width) * Math.max(0, 1 - Math.max(0, best - s.width / 2) / 0.7), hair);
          }
        }
      }
    const f = { alpha, fg };
    cache.set(n, f);
    if (cache.size > 8) cache.delete(cache.keys().next().value!);
    return f;
  };

  const spillFor = (n: number): Float32Array => {
    const { alpha } = layers(n);
    const near = gaussianBlur(alpha, width, height, 4 * u);
    const scr = screenAt(n);
    const out = new Float32Array(width * height * 3);
    for (let i = 0; i < width * height; i += 1) {
      const a = alpha[i]!;
      if (!(a > 0)) continue;
      // Bounce from the screen: strongest where the subject is close to its edge.
      const k = spillK * a * (0.03 + 0.2 * Math.max(0, 1 - near[i]!));
      out[3 * i] = k * scr[3 * i]!;
      out[3 * i + 1] = k * scr[3 * i + 1]!;
      out[3 * i + 2] = k * scr[3 * i + 2]!;
    }
    return out;
  };

  // The background plate: a night street.
  const bgData = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const v = y / height;
      const i = 3 * (y * width + x);
      bgData[i] = 0.02 + 0.32 * v * v;
      bgData[i + 1] = 0.025 + 0.16 * v * v;
      bgData[i + 2] = 0.06 + 0.03 * v;
    }
  for (let k = 0; k < 26; k += 1) {
    const bx = hash(k, 7, seed) * width;
    const by = (0.35 + 0.5 * hash(k, 8, seed)) * height;
    const r = (3 + 9 * hash(k, 9, seed)) * u;
    const warm = hash(k, 10, seed) > 0.25;
    const col = warm ? [1.6, 0.8, 0.25] : [0.3, 0.5, 1.2];
    for (let y = Math.max(0, Math.floor(by - r - 2)); y <= Math.min(height - 1, by + r + 2); y += 1)
      for (let x = Math.max(0, Math.floor(bx - r - 2)); x <= Math.min(width - 1, bx + r + 2); x += 1) {
        const a = 0.6 * cover(Math.hypot(x + 0.5 - bx, y + 0.5 - by) - r);
        const i = 3 * (y * width + x);
        for (let c = 0; c < 3; c += 1) bgData[i + c] = bgData[i + c]! + a * col[c]!;
      }
  }

  return {
    width,
    height,
    frames,
    kind,
    alpha: (n) => layers(n).alpha.slice(),
    foreground: (n) => layers(n).fg.slice(),
    spillAdded: spillFor,
    screen: screenAt,
    background: { width, height, data: bgData },
    colours: { screen: base, skin, shirt, hair },
    render(n) {
      const { alpha, fg } = layers(n);
      const scr = screenAt(n);
      const sp = spillK > 0 ? spillFor(n) : null;
      const data = new Float32Array(width * height * 3);
      for (let i = 0; i < width * height; i += 1) {
        const k = 1 - alpha[i]!;
        for (let c = 0; c < 3; c += 1) {
          const nz = noise ? (hash(i, c, seed * 7919 + n) + hash(i, c + 3, seed * 31 + n) - 1) * noise * 2.45 : 0;
          data[3 * i + c] = fg[3 * i + c]! + (sp ? sp[3 * i + c]! : 0) + k * scr[3 * i + c]! + nz;
        }
      }
      return { width, height, data };
    },
  };
}
