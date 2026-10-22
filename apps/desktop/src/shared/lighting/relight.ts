import { balancedRgb, type LightSpec } from '@vcvfx/domain';
import type { LinearImage } from '../key/linear';
import { DEG, cameraToLevel, dirOf, levelRotation, mulv } from './geometry';
import { softShade } from './shading';

/**
 * The relight preview (addendum 14 §4): the subject's albedo is the plate
 * divided by the estimated rig's shading on its silhouette normals; the
 * preview is that albedo under the rig as edited. So the unedited rig gives
 * back the plate, and every edit shows on the subject at once. A grey ball
 * (albedo 0.5) under the rig shows it on its own. The match score is how well
 * a rig's shading explains the plate's (R² of the plate's luminance against a
 * single albedo times the rig's shading, over the subject).
 */

export interface RelightModel {
  width: number;
  height: number;
  /** The analysed frame (linear). */
  frame: LinearImage;
  /** Camera-frame normals (NaN off the subject) and the subject mask. */
  normals: Float32Array;
  mask: Uint8Array;
  /** The camera's tilt (the rig is in the level frame). */
  pitchDeg: number;
  rollDeg: number;
  /** Albedo per pixel (rgb), from the estimated rig; NaN off the subject. */
  albedo: Float32Array;
  whiteBalanceK: number | null;
  luma: [number, number, number];
}

/** A rig's irradiance (rgb, relative to the key) on a level-frame normal. */
export function rigIrradiance(specs: readonly LightSpec[], n: readonly number[], whiteBalanceK: number | null, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
  out[0] = 0;
  out[1] = 0;
  out[2] = 0;
  for (const s of specs) {
    if (!s.enabled) continue;
    const E = 2 ** s.intensityStops;
    let k: number;
    if (s.type === 'dome') k = s.role === 'sky' ? 0.5 * (1 + n[1]!) : 1;
    else {
      const L = dirOf(s.azimuthDeg, s.elevationDeg);
      const sinA = Math.sin(((s.sizeDeg ?? 0) / 2) * DEG);
      k = softShade(n[0]! * L[0] + n[1]! * L[1] + n[2]! * L[2], Math.min(0.95, sinA));
    }
    if (k <= 0) continue;
    const c = balancedRgb(s.rgb, whiteBalanceK);
    out[0] += E * k * c[0];
    out[1] += E * k * c[1];
    out[2] += E * k * c[2];
  }
  return out;
}

/** Build the relight model from the estimated rig. */
export function relightModel(frame: LinearImage, normals: Float32Array, mask: Uint8Array, cam: { pitchDeg: number; rollDeg: number }, estimated: readonly LightSpec[], whiteBalanceK: number | null, luma: [number, number, number]): RelightModel {
  const n = frame.width * frame.height;
  const albedo = new Float32Array(n * 3).fill(NaN);
  const e: [number, number, number] = [0, 0, 0];
  let peak = 0;
  const shade = new Float32Array(n * 3);
  for (let i = 0; i < n; i += 1) {
    if (!mask[i]) continue;
    const nl = cameraToLevel(cam, [normals[3 * i]!, normals[3 * i + 1]!, normals[3 * i + 2]!]);
    rigIrradiance(estimated, nl, whiteBalanceK, e);
    shade.set(e, 3 * i);
    peak = Math.max(peak, e[0], e[1], e[2]);
  }
  const floor = Math.max(1e-6, 0.03 * peak);
  for (let i = 0; i < n; i += 1) {
    if (!mask[i]) continue;
    for (let c = 0; c < 3; c += 1) albedo[3 * i + c] = frame.data[3 * i + c]! / Math.max(floor, shade[3 * i + c]!);
  }
  return { width: frame.width, height: frame.height, frame, normals, mask, pitchDeg: cam.pitchDeg, rollDeg: cam.rollDeg, albedo, whiteBalanceK, luma };
}

/** The frame with the subject relit by `specs` (linear). */
export function relight(model: RelightModel, specs: readonly LightSpec[]): LinearImage {
  const n = model.width * model.height;
  const data = new Float32Array(model.frame.data);
  const e: [number, number, number] = [0, 0, 0];
  const cam = { pitchDeg: model.pitchDeg, rollDeg: model.rollDeg };
  for (let i = 0; i < n; i += 1) {
    if (!model.mask[i]) continue;
    const nl = cameraToLevel(cam, [model.normals[3 * i]!, model.normals[3 * i + 1]!, model.normals[3 * i + 2]!]);
    rigIrradiance(specs, nl, model.whiteBalanceK, e);
    for (let c = 0; c < 3; c += 1) data[3 * i + c] = model.albedo[3 * i + c]! * e[c]!;
  }
  return { width: model.width, height: model.height, data };
}

/** How well a rig's shading explains the plate's on the subject (R², 0 … 1), or null without a subject. */
export function matchScore(model: RelightModel, specs: readonly LightSpec[]): number | null {
  const e: [number, number, number] = [0, 0, 0];
  const cam = { pitchDeg: model.pitchDeg, rollDeg: model.rollDeg };
  const lum = model.luma;
  let sxy = 0;
  let sxx = 0;
  let sy = 0;
  let syy = 0;
  let count = 0;
  const pairs: [number, number][] = [];
  for (let i = 0; i < model.width * model.height; i += 1) {
    if (!model.mask[i]) continue;
    const nl = cameraToLevel(cam, [model.normals[3 * i]!, model.normals[3 * i + 1]!, model.normals[3 * i + 2]!]);
    rigIrradiance(specs, nl, model.whiteBalanceK, e);
    const x = lum[0] * e[0] + lum[1] * e[1] + lum[2] * e[2];
    const y = lum[0] * model.frame.data[3 * i]! + lum[1] * model.frame.data[3 * i + 1]! + lum[2] * model.frame.data[3 * i + 2]!;
    pairs.push([x, y]);
    sxy += x * y;
    sxx += x * x;
    sy += y;
    syy += y * y;
    count += 1;
  }
  if (count < 50 || sxx <= 0) return null;
  const k = sxy / sxx;
  const sst = syy - (sy * sy) / count;
  let sse = 0;
  for (const [x, y] of pairs) sse += (y - k * x) ** 2;
  return Math.max(0, Math.min(1, 1 - sse / Math.max(1e-12, sst)));
}

/** A grey ball (albedo 0.5) under the rig, as the camera sees it: size × size, linear, with an alpha. */
export function rigBall(specs: readonly LightSpec[], cam: { pitchDeg: number; rollDeg: number }, whiteBalanceK: number | null, size = 160): { image: LinearImage; alpha: Float32Array } {
  const data = new Float32Array(size * size * 3);
  const alpha = new Float32Array(size * size);
  const r = size * 0.46;
  const R = levelRotation(cam);
  const e: [number, number, number] = [0, 0, 0];
  for (let y = 0; y < size; y += 1)
    for (let x = 0; x < size; x += 1) {
      const nx = (x + 0.5 - size / 2) / r;
      const ny = -(y + 0.5 - size / 2) / r;
      const q = nx * nx + ny * ny;
      const i = y * size + x;
      if (q > 1) continue;
      alpha[i] = Math.min(1, (1 - Math.sqrt(q)) * r);
      rigIrradiance(specs, mulv(R, [nx, ny, Math.sqrt(1 - q)]), whiteBalanceK, e);
      data[3 * i] = 0.5 * e[0];
      data[3 * i + 1] = 0.5 * e[1];
      data[3 * i + 2] = 0.5 * e[2];
    }
  return { image: { width: size, height: size, data }, alpha };
}
