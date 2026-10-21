import { UNIT_METRES, type CoordSystem, type SceneUnit, type UpAxis } from '@vcvfx/domain';
import { add3, cross, median, mul3, mulv3, norm3, normalize3, scale3, sub3, t3 } from './linalg';
import { CV_TO_GL } from './geometry';
import { applySim, composeSim, IDENTITY_SIM, type Similarity } from './align';
import { centreOf } from './pose';
import type { SolveResult } from './solver';

/**
 * Coordinate systems (master spec §10.2 last bullet; addendum 06 §5).
 *
 * The scene is Y-up internally, in the chosen units. A solve's own world is
 * arbitrary (the first keyframe's camera, a unit baseline); the scene is
 * reached by:
 *   base   — the LiDAR alignment followed by the LiDAR file's units and up
 *            axis, or, without LiDAR, a default: the first solved camera at
 *            the origin looking down −Z, Y up, the scene's points a median
 *            10 units away;
 *   ground — a plane through three tracks made the Y = 0 plane (cameras above);
 *   scale  — two tracks set a known distance apart;
 *   origin — a track or point moved to (0, 0, 0).
 */

/** Z-up → Y-up: (x, y, z) ↦ (x, z, −y). */
export const ZUP_TO_YUP: number[] = [1, 0, 0, 0, 0, 1, 0, -1, 0];
export const YUP_TO_ZUP: number[] = t3(ZUP_TO_YUP);

export function unitScale(from: SceneUnit, to: SceneUnit): number {
  return UNIT_METRES[from] / UNIT_METRES[to];
}

/** A LiDAR file's coordinates → the scene (Y-up, scene units). */
export function lidarToScene(ref: { units: SceneUnit; up: UpAxis }, sceneUnits: SceneUnit): Similarity {
  return { s: unitScale(ref.units, sceneUnits), R: ref.up === 'z' ? [...ZUP_TO_YUP] : [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };
}

/** The default solve → scene transform (no LiDAR). */
export function defaultSceneTransform(solve: SolveResult): Similarity {
  const firstSolved = solve.frames.find((f) => f.solved);
  if (!firstSolved) return IDENTITY_SIM;
  const R0 = firstSolved.R;
  const C0 = centreOf(R0, firstSolved.t);
  // Scene axes from the first camera's: CV (x right, y down, z forward) → GL (x right, y up, z back).
  const R = mul3(CV_TO_GL, R0);
  const depths: number[] = [];
  for (const tr of solve.tracks) {
    if (!tr.X) continue;
    const z = R0[6]! * tr.X[0] + R0[7]! * tr.X[1] + R0[8]! * tr.X[2] + firstSolved.t[2]!;
    if (z > 0) depths.push(z);
  }
  const md = median(depths);
  const s = solve.stats.nodal || !(md > 0) ? 1 : 10 / md;
  const RC = mulv3(R, C0);
  return { s, R, t: [-s * RC[0]!, -s * RC[1]!, -s * RC[2]!] };
}

/** Minimal rotation taking unit vector a onto unit vector b. */
export function rotationBetween(a: ArrayLike<number>, b: ArrayLike<number>): number[] {
  const v = cross(a, b);
  const c = a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
  const s = norm3(v);
  if (s < 1e-12) {
    if (c > 0) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
    // Opposite: 180° about any axis perpendicular to a.
    const p = Math.abs(a[0]!) < 0.9 ? normalize3(cross(a, [1, 0, 0])) : normalize3(cross(a, [0, 1, 0]));
    return [2 * p[0]! * p[0]! - 1, 2 * p[0]! * p[1]!, 2 * p[0]! * p[2]!, 2 * p[1]! * p[0]!, 2 * p[1]! * p[1]! - 1, 2 * p[1]! * p[2]!, 2 * p[2]! * p[0]!, 2 * p[2]! * p[1]!, 2 * p[2]! * p[2]! - 1];
  }
  const vx = [0, -v[2]!, v[1]!, v[2]!, 0, -v[0]!, -v[1]!, v[0]!, 0];
  const vx2 = mul3(vx, vx);
  const k = (1 - c) / (s * s);
  return [1, 0, 0, 0, 1, 0, 0, 0, 1].map((x, i) => x + vx[i]! + k * vx2[i]!);
}

export interface SceneInputs {
  solve: SolveResult;
  /** Solve world → LiDAR file coordinates, and that file's units/up, when aligned. */
  alignment?: { transform: Similarity; lidar: { units: SceneUnit; up: UpAxis } } | null;
  coords: Pick<CoordSystem, 'units' | 'origin' | 'ground' | 'scale'>;
}

export interface SceneTransformResult {
  transform: Similarity;
  /** Base before ground / scale / origin. */
  base: Similarity;
  notes: string[];
  error: string | null;
}

/** The solve → scene transform from the coordinate-system settings. */
export function sceneTransform(input: SceneInputs): SceneTransformResult {
  const { solve, coords } = input;
  const notes: string[] = [];
  const base = input.alignment ? composeSim(lidarToScene(input.alignment.lidar, coords.units), input.alignment.transform) : defaultSceneTransform(solve);
  notes.push(input.alignment ? `LiDAR alignment, ${input.alignment.lidar.units} → ${coords.units}${input.alignment.lidar.up === 'z' ? ', Z-up → Y-up' : ''}` : 'Default: first camera at the origin looking down −Z, points a median 10 units away');
  const X = new Map<number, number[]>();
  for (const tr of solve.tracks) if (tr.X) X.set(tr.id, applySim(base, tr.X));
  const need = (id: number): number[] | string => X.get(id) ?? `Track ${id} has no solved 3D position`;
  let T: Similarity = base;
  const camCentre = (() => {
    const cs = solve.frames.filter((f) => f.solved).map((f) => applySim(base, centreOf(f.R, f.t)));
    return cs.length ? scale3(cs.reduce((a, c) => add3(a, c), [0, 0, 0]), 1 / cs.length) : [0, 0, 0];
  })();
  let current = (p: number[]) => p; // maps base-scene points to the current scene
  if (coords.ground) {
    const pts = coords.ground.trackIds.map(need);
    const bad = pts.find((p) => typeof p === 'string');
    if (bad) return { transform: base, base, notes, error: bad as string };
    const [a, b, c] = pts as number[][];
    let n = cross(sub3(b!, a!), sub3(c!, a!));
    if (norm3(n) < 1e-9) return { transform: base, base, notes, error: 'The three ground tracks are in a line' };
    n = normalize3(n);
    if ((camCentre[0]! - a![0]!) * n[0]! + (camCentre[1]! - a![1]!) * n[1]! + (camCentre[2]! - a![2]!) * n[2]! < 0) n = scale3(n, -1);
    const Rg = rotationBetween(n, [0, 1, 0]);
    const ra = mulv3(Rg, a!);
    const G: Similarity = { s: 1, R: Rg, t: [0, -ra[1]!, 0] };
    T = composeSim(G, T);
    const prev = current;
    current = (p) => applySim(G, prev(p));
    notes.push(`Ground plane through tracks ${coords.ground.trackIds.join(', ')}`);
  }
  if (coords.scale) {
    const pa = need(coords.scale.trackIds[0]);
    const pb = need(coords.scale.trackIds[1]);
    if (typeof pa === 'string') return { transform: base, base, notes, error: pa };
    if (typeof pb === 'string') return { transform: base, base, notes, error: pb };
    const d = norm3(sub3(current(pa), current(pb)));
    if (!(d > 1e-12)) return { transform: base, base, notes, error: 'The two scale tracks are at the same place' };
    const k = coords.scale.distance / d;
    const S: Similarity = { s: k, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };
    T = composeSim(S, T);
    const prev = current;
    current = (p) => applySim(S, prev(p));
    notes.push(`Scale: tracks ${coords.scale.trackIds.join(' and ')} are ${coords.scale.distance} ${coords.units} apart`);
    if (input.alignment) notes.push('A scale distance overrides the LiDAR scale');
  }
  if (coords.origin.kind !== 'none') {
    let o: number[];
    if (coords.origin.kind === 'track') {
      const p = need(coords.origin.trackId);
      if (typeof p === 'string') return { transform: base, base, notes, error: p };
      o = current(p);
    } else o = current([...coords.origin.point]);
    // With a ground plane, keep the origin on it (move in X and Z only).
    const shift = coords.ground ? [-o[0]!, 0, -o[2]!] : [-o[0]!, -o[1]!, -o[2]!];
    T = composeSim({ s: 1, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: shift }, T);
    notes.push(coords.origin.kind === 'track' ? `Origin at track ${coords.origin.trackId}` : 'Origin at a picked point');
  }
  return { transform: T, base, notes, error: null };
}

export interface SceneCamera {
  frame: number;
  /** Camera position in the scene (Y-up). */
  position: [number, number, number];
  /** Camera → scene rotation in graphics convention (camera looks down its −Z, +Y up). */
  rotation: number[];
}

/** Solved cameras in the scene. */
export function sceneCameras(solve: SolveResult, T: Similarity): SceneCamera[] {
  return solve.frames
    .filter((f) => f.solved)
    .map((f) => {
      const C = applySim(T, centreOf(f.R, f.t));
      const Rcw = mul3(mul3(T.R, t3(f.R)), CV_TO_GL);
      return { frame: f.frame, position: [C[0]!, C[1]!, C[2]!] as [number, number, number], rotation: Rcw };
    });
}

/** Y-up scene → Z-up: position and camera rotation. */
export function toZup(c: SceneCamera): SceneCamera {
  const p = mulv3(YUP_TO_ZUP, c.position);
  return { frame: c.frame, position: [p[0]!, p[1]!, p[2]!], rotation: mul3(YUP_TO_ZUP, c.rotation) };
}
