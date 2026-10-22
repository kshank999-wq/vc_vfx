import { UNIT_METRES, lightingLens, lightingRig, type LightSpec, type LightingDocument, type RigLight, type SceneUnit, type UpAxis } from '@vcvfx/domain';
import { SCENE_TO_UNREAL, unrealRotator } from '../camera/export-formats';
import { DEG, add, cross, dirOf, dot, levelRotation, mulv, norm, scale, sub, type V3 } from './geometry';

/**
 * The rig placed in a scene (addendum 14 §5): the camera at the analysed
 * frame and every light where its direction and distance put it, in the
 * camera track's scene (Y-up, right-handed, the track's units) when there is
 * a solve, else around a level camera at the origin looking down −Z. The
 * Unreal and USD writers take this, so the camera and the lights line up
 * exactly as the camera-track exports do.
 *
 * Intensities: the key's illuminance at the subject is the exposure
 * reference `keyLux`; a light of `stops` gives keyLux · 2^stops lux there. A
 * directional light is that illuminance; a positional one has the luminous
 * intensity I = E · d² (candela, d in metres); a rect light the same
 * candela; a dome or sky a scale relative to the key (Unreal's sky light has
 * no absolute unit without a calibrated cubemap).
 */

export interface PlacedCamera {
  source: 'solve' | 'estimate';
  /** Scene position (scene units) and camera → scene rotation (graphics convention: looks down its −Z, +Y up). */
  position: V3;
  rotation: number[];
  focalMm: number;
  filmBackMm: { width: number; height: number };
  frame: number;
  width: number;
  height: number;
}

export interface PlacedLight {
  id: string;
  spec: LightSpec;
  /** Scene position (scene units); null for a directional light or a dome. */
  position: V3 | null;
  /** The way the light travels (unit, scene): from the light towards what it lights. */
  direction: V3;
  /** Physical figures: illuminance at the subject (lux), candela for a positional light. */
  lux: number;
  candela: number | null;
  /** Size in scene units: a rect's side, a sphere's radius; a directional light's angular diameter (degrees). */
  sourceSize: number | null;
  /** A spot's outer cone half-angle (degrees). */
  coneDeg: number | null;
  /** What it is aimed at (scene): the subject, or the background spot for a background light. */
  target: V3;
}

export interface PlacedRig {
  units: SceneUnit;
  upAxis: UpAxis;
  camera: PlacedCamera;
  /** The subject's centre (scene units). */
  subject: V3;
  /** Level-frame basis in scene coordinates (x right, y up, z towards the camera, horizontally). */
  basis: { x: V3; y: V3; z: V3 };
  lights: PlacedLight[];
  keyLux: number;
  ev100: number;
}

export interface SceneCameraInput {
  /** From the camera track's solve at the analysed frame, in the Y-up scene: position (scene units) and camera → scene rotation. */
  solve: { position: [number, number, number]; rotation: number[]; units: SceneUnit; upAxis: UpAxis } | null;
  /** The plate's size, the analysis' camera tilt and the subject's place in the frame. */
  width: number;
  height: number;
  pitchDeg: number;
  rollDeg: number;
  subjectCentre: { x: number; y: number } | null;
}

/** Place the effective rig (estimate + edits) in the scene. */
export function placeRig(doc: LightingDocument, input: SceneCameraInput): PlacedRig {
  const lens = lightingLens(doc);
  const filmBackMm = lens.filmBackMm ?? { width: 36, height: (36 * input.height) / input.width };
  const focalMm = lens.focalMm ?? (filmBackMm.width / input.width) * 0.9 * input.width;
  const units: SceneUnit = input.solve?.units ?? 'm';
  const upAxis: UpAxis = input.solve?.upAxis ?? 'y';
  const perM = 1 / UNIT_METRES[units];
  let position: V3;
  let rotation: number[];
  if (input.solve) {
    position = [...input.solve.position] as V3;
    rotation = [...input.solve.rotation];
  } else {
    position = [0, 0, 0];
    rotation = levelRotation({ pitchDeg: input.pitchDeg, rollDeg: input.rollDeg });
  }
  // The level frame in the scene: up is the scene's Y; z the camera's view direction reversed, made horizontal.
  const yAxis: V3 = [0, 1, 0];
  const fwd: V3 = [-rotation[2]!, -rotation[5]!, -rotation[8]!];
  let zAxis = norm(sub(scale(fwd, -1), scale(yAxis, dot(scale(fwd, -1), yAxis))));
  if (!Number.isFinite(zAxis[0]) || Math.hypot(...zAxis) < 0.5) zAxis = [0, 0, 1];
  const xAxis = cross(yAxis, zAxis);
  const toScene = (d: readonly number[]): V3 => add(add(scale(xAxis, d[0]!), scale(yAxis, d[1]!)), scale(zAxis, d[2]!));
  // The subject: along the ray through its centre in the frame, at the subject distance.
  const fpx = (focalMm / filmBackMm.width) * input.width;
  const c = input.subjectCentre ?? { x: 0.5, y: 0.5 };
  const rayCam = norm([(c.x * input.width - input.width / 2) / fpx, -(c.y * input.height - input.height / 2) / fpx, -1]);
  const subject = add(position, scale(mulv(rotation, rayCam), doc.settings.subjectDistanceM * perM));
  const keyLux = doc.settings.keyLux;
  const lights: PlacedLight[] = lightingRig(doc).map((l: RigLight) => {
    const s = l.spec;
    const L = toScene(dirOf(s.azimuthDeg, s.elevationDeg));
    const lux = keyLux * 2 ** s.intensityStops;
    if (s.type === 'directional' || s.type === 'dome' || s.distanceM === null) {
      return { id: l.id, spec: s, position: null, direction: scale(L, -1), lux, candela: null, sourceSize: s.type === 'directional' ? (s.sizeDeg ?? 0.5) : null, coneDeg: null, target: subject };
    }
    const d = s.distanceM;
    const pos = add(subject, scale(L, d * perM));
    // A background light lights the set behind the subject: aim it at the spot seen on the background.
    let target = subject;
    const spot = l.estimate?.practical;
    if (s.role === 'background' && spot) {
      const r = norm([(spot.x * input.width - input.width / 2) / fpx, -(spot.y * input.height - input.height / 2) / fpx, -1]);
      target = add(position, scale(mulv(rotation, r), 2 * doc.settings.subjectDistanceM * perM));
    }
    const dir = norm(sub(target, pos));
    const half = ((s.sizeDeg ?? 0) / 2) * DEG;
    const side = 2 * d * Math.tan(half);
    return {
      id: l.id,
      spec: s,
      position: pos,
      direction: dir,
      lux,
      candela: lux * d * d,
      sourceSize: s.type === 'rect' ? Math.max(0.01, side) * perM : Math.max(0, d * Math.tan(half)) * perM,
      coneDeg: s.type === 'spot' ? Math.max(15, Math.min(80, (Math.atan(1.5 / Math.max(0.5, d)) / DEG) * 2)) : null,
      target,
    };
  });
  return {
    units,
    upAxis,
    camera: { source: input.solve ? 'solve' : 'estimate', position, rotation, focalMm, filmBackMm, frame: doc.analysis?.frame ?? 0, width: input.width, height: input.height },
    subject,
    basis: { x: xAxis, y: yAxis, z: zAxis },
    lights,
    keyLux,
    ev100: Math.log2(keyLux / 2.5),
  };
}

/** Scene (Y-up) → Unreal (Z-up, left-handed, cm): a point. */
export function unrealPoint(p: readonly number[], units: SceneUnit): number[] {
  const cm = UNIT_METRES[units] * 100;
  return mulv(SCENE_TO_UNREAL, p).map((v) => v * cm);
}

/** An Unreal rotator that points an actor's +X along a scene direction (no roll). */
export function unrealAim(direction: readonly number[]): { pitch: number; yaw: number; roll: number } {
  const f = norm(mulv(SCENE_TO_UNREAL, direction));
  const upW: V3 = Math.abs(f[2]) > 0.999 ? [1, 0, 0] : [0, 0, 1];
  // Unreal is left-handed: right = up × forward.
  const right = norm(cross(upW, f));
  const up = cross(f, right);
  return unrealRotator(f, right, up);
}

/** What an Unreal light actor gets (addendum 14 §5): class, intensity and unit, size. */
export function unrealLight(p: PlacedLight, units: SceneUnit): { cls: string; intensity: number; unit: 'lux' | 'cd' | 'scale'; sourceRadiusCm: number | null; sourceWidthCm: number | null; sourceHeightCm: number | null; sourceAngleDeg: number | null; coneDeg: number | null } {
  const cm = UNIT_METRES[units] * 100;
  const s = p.spec;
  if (s.type === 'dome') return { cls: 'SkyLight', intensity: 2 ** s.intensityStops, unit: 'scale', sourceRadiusCm: null, sourceWidthCm: null, sourceHeightCm: null, sourceAngleDeg: null, coneDeg: null };
  if (s.type === 'directional' || p.position === null) return { cls: 'DirectionalLight', intensity: p.lux, unit: 'lux', sourceRadiusCm: null, sourceWidthCm: null, sourceHeightCm: null, sourceAngleDeg: Math.max(0.05, p.sourceSize ?? 0.5), coneDeg: null };
  if (s.type === 'rect') return { cls: 'RectLight', intensity: p.candela!, unit: 'cd', sourceRadiusCm: null, sourceWidthCm: (p.sourceSize ?? 0.1) * cm, sourceHeightCm: (p.sourceSize ?? 0.1) * cm, sourceAngleDeg: null, coneDeg: null };
  if (s.type === 'spot') return { cls: 'SpotLight', intensity: p.candela!, unit: 'cd', sourceRadiusCm: (p.sourceSize ?? 0) * cm, sourceWidthCm: null, sourceHeightCm: null, sourceAngleDeg: null, coneDeg: p.coneDeg };
  return { cls: 'PointLight', intensity: p.candela!, unit: 'cd', sourceRadiusCm: (p.sourceSize ?? 0) * cm, sourceWidthCm: null, sourceHeightCm: null, sourceAngleDeg: null, coneDeg: null };
}
