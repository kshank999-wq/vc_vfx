import { eulerFromRotation, fovDegrees, type EulerOrder } from './geometry';
import { mul3, mulv3 } from './linalg';
import { YUP_TO_ZUP, toZup, type SceneCamera } from './coords';
import type { Distortion, SceneUnit, UpAxis } from '@vcvfx/domain';

/**
 * Camera-track exports (master spec §10.3; addendum 06 §6). Every writer
 * takes the same `CameraExportData` — the solved cameras and track points in
 * the Y-up scene, the lens and the plate — and returns file text. Each
 * application gets its own axes, units and rotation order:
 *
 *  | Writer      | Up | Units            | Rotation                         |
 *  | Nuke .nk    | Y  | scene units      | Camera2 rot_order ZXY, degrees   |
 *  | Maya .ma    | Y  | currentUnit = scene units | rotateOrder xyz, degrees |
 *  | Blender .py | Z  | metres           | rotation_mode XYZ, radians       |
 *  | AE .jsx     | −Y | pixels (100/unit)| Orientation (ZYX applied), degrees |
 *  | 3ds Max .ms | Z  | system units     | matrix3 per key                  |
 *  | FBX 7.4     | Y  | cm (UnitScaleFactor) | XYZ, degrees; camera along +X |
 *  | .chan       | Y/Z per coords | scene units | ZXY, degrees, + vertical FOV |
 *  | Unreal .py  | Z (left-handed) | cm             | FRotator pitch/yaw/roll, degrees |
 *  | Unity .cs   | Y (left-handed) | m              | quaternion curves                |
 *  | USD .usda   | Y/Z per coords | scene units (metersPerUnit) | matrix4d per time sample |
 *  | Houdini .py | Y  | metres           | rOrd xyz, degrees                |
 *  | Fusion      | Y  | scene units      | RotOrder XYZ, degrees; aperture inches |
 *
 * The Euler angles are unwrapped frame to frame so curves never jump 360°.
 *
 * Non-square pixels (addendum 17): the plate keeps its stored pixels and each
 * application is told its pixel aspect in its own terms. `filmBackMm.width`
 * is the aperture of the DE-SQUEEZED picture (sensor area × squeeze for an
 * anamorphic lens) and the vertical aperture is width × H / (W × PAR):
 *
 *  | Writer   | Pixel aspect declared as                                      |
 *  | Nuke     | Root and Read formats with pixel_aspect; Camera haperture de-squeezed |
 *  | Maya     | cameraAperture = sensor (squeezed) + lensSqueezeRatio; defaultResolution pixelAspect |
 *  | Blender  | render pixel_aspect_x; sensor_width de-squeezed, fit HORIZONTAL |
 *  | AE       | comp pixelAspect; zoom = the vertical focal in comp pixels    |
 *  | 3ds Max  | renderPixelAspect; fov across the de-squeezed width           |
 *  | FBX      | FilmWidth (squeezed) + FilmSqueezeRatio, PixelAspectRatio     |
 *  | Houdini  | cam aspect; aperture de-squeezed                              |
 *  | Fusion   | frame format AspectX; aperture de-squeezed                    |
 *  | Unreal / Unity | filmback / sensor of the de-squeezed picture (engines render square pixels) |
 *  | USD      | horizontalAperture de-squeezed (aperture aspect = W·PAR / H); customData pixelAspect; a RenderSettings pixelAspectRatio |
 *  | .chan    | vertical FOV (unaffected by the squeeze)                      |
 */

export interface CameraExportData {
  shot: string;
  version: number;
  generator: string;
  writtenAt: string;
  fps: number;
  /** Plate pixels. */
  width: number;
  height: number;
  /**
   * Horizontal aperture (mm) of the de-squeezed picture; the vertical follows
   * the plate's shape: width × H / (W × pixelAspect).
   */
  filmBackMm: { width: number; height: number };
  /** The film back as chosen (an anamorphic sensor area before the squeeze), when known. */
  sensorFilmBackMm?: { width: number; height: number };
  /** Plate pixel aspect (stored pixel width / height); absent = 1. */
  pixelAspect?: number;
  /** True when the film back was not known and a nominal 36 mm one is used. */
  nominalFilmBack: boolean;
  focalMm: number;
  /** Vertical focal in plate pixels (= focal in de-squeezed pixels); the horizontal is focalPx / pixelAspect. */
  focalPx: number;
  /** Principal point offset from the centre, in plate pixels. */
  principalOffsetPx: { x: number; y: number };
  distortion: Distortion;
  units: SceneUnit;
  /** The up axis for the generic exports (.chan, OBJ, JSON). */
  upAxis: UpAxis;
  cameras: SceneCamera[];
  points: { id: number; position: [number, number, number]; error: number }[];
  solve: { number: number; rms: number; frames: number; engine: string; nodal: boolean; confidence: number; warnings: string[] };
  /** Package-relative names of companion files (OBJ, STMaps), for references inside the scripts. */
  files: { obj: string; undistort?: string; redistort?: string };
}

const deg = (r: number) => (r * 180) / Math.PI;
const num = (v: number, digits = 6) => {
  if (!Number.isFinite(v)) return '0';
  const s = v.toFixed(digits);
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') || '0' : s;
};
const safeId = (s: string) => s.replace(/[^A-Za-z0-9_]/g, '_');
const MM_PER_INCH = 25.4;

/** Euler angles (degrees) per camera, unwrapped. */
export function eulerTrack(rotations: readonly number[][], order: EulerOrder): { x: number; y: number; z: number }[] {
  let prev: { x: number; y: number; z: number } | undefined;
  return rotations.map((R) => {
    const e = eulerFromRotation(R, order, prev);
    prev = e;
    return { x: deg(e.x), y: deg(e.y), z: deg(e.z) };
  });
}

/** The plate's pixel aspect (1 when not given). */
export const pixelAspectOfData = (d: Pick<CameraExportData, 'pixelAspect'>): number => d.pixelAspect ?? 1;

/** The vertical film back for the plate's de-squeezed shape. */
export function verticalAperture(d: CameraExportData): number {
  return d.filmBackMm.width * (d.height / (d.width * pixelAspectOfData(d)));
}

/** The de-squeezed picture width in square pixels. */
const shownWidth = (d: CameraExportData): number => d.width * pixelAspectOfData(d);

/** Runs of consecutive frames (for curves with gaps). */
function runs(frames: readonly number[]): [number, number][] {
  const out: [number, number][] = [];
  let i = 0;
  while (i < frames.length) {
    let j = i;
    while (j + 1 < frames.length && frames[j + 1] === frames[j]! + 1) j += 1;
    out.push([i, j]);
    i = j + 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Nuke
// ---------------------------------------------------------------------------

function nukeCurve(frames: readonly number[], values: readonly number[]): string {
  const parts = runs(frames).map(([a, b]) => `x${frames[a]} ${values.slice(a, b + 1).map((v) => num(v)).join(' ')}`);
  return `{curve ${parts.join(' ')}}`;
}

export function writeNuke(d: CameraExportData): string {
  const par = pixelAspectOfData(d);
  const fmt = `"${d.width} ${d.height} 0 0 ${d.width} ${d.height} ${num(par, 6)} ${safeId(d.shot)}_plate"`;
  const frames = d.cameras.map((c) => c.frame);
  const eu = eulerTrack(d.cameras.map((c) => c.rotation), 'ZXY');
  const name = `Camera_${safeId(d.shot)}_v${String(d.version).padStart(3, '0')}`;
  const first = frames[0] ?? 1;
  const last = frames[frames.length - 1] ?? first;
  const k = d.distortion;
  const note = [
    `VC VFX camera track ${d.shot} v${String(d.version).padStart(3, '0')}, solve ${d.solve.number}`,
    `RMS ${num(d.solve.rms, 3)} px over ${d.solve.frames} frames${d.solve.nodal ? ' (nodal)' : ''}`,
    `Lens (OpenCV Brown-Conrady, normalised by focal ${num(d.focalPx, 2)} px):`,
    `k1 ${num(k.k1, 6)} k2 ${num(k.k2, 6)} k3 ${num(k.k3, 6)} p1 ${num(k.p1, 6)} p2 ${num(k.p2, 6)}`,
    `This camera is the UNDISTORTED pinhole. Undistort the plate with the STMap ${d.files.undistort ?? '(not written)'},`,
    `render CG through this camera, then redistort with ${d.files.redistort ?? '(not written)'} (STMap node, UV channels rgb).`,
    `NukeX LensDistortion uses a different model: enter these as a note, not as its values.`,
    ...(par !== 1 ? [`Pixel aspect ${num(par, 4)}: the format declares it; haperture is the de-squeezed picture's; the STMaps are in squeezed plate pixels.`] : []),
  ].join('\\n');
  const lines = [
    `#! nuke file written by ${d.generator}`,
    'version 13.0 v1',
    'Root {',
    ' inputs 0',
    ` first_frame ${first}`,
    ` last_frame ${last}`,
    ` fps ${num(d.fps, 3)}`,
    ` format ${fmt}`,
    '}',
    'Camera2 {',
    ' inputs 0',
    ' rot_order ZXY',
    ` translate {${nukeCurve(frames, d.cameras.map((c) => c.position[0]))} ${nukeCurve(frames, d.cameras.map((c) => c.position[1]))} ${nukeCurve(frames, d.cameras.map((c) => c.position[2]))}}`,
    ` rotate {${nukeCurve(frames, eu.map((e) => e.x))} ${nukeCurve(frames, eu.map((e) => e.y))} ${nukeCurve(frames, eu.map((e) => e.z))}}`,
    ` focal ${num(d.focalMm, 4)}`,
    ` haperture ${num(d.filmBackMm.width, 4)}`,
    ` vaperture ${num(verticalAperture(d), 4)}`,
    ` win_translate {${num((2 * d.principalOffsetPx.x) / d.width, 6)} ${num((-2 * d.principalOffsetPx.y) / shownWidth(d), 6)}}`,
    ' near 0.01',
    ' far 100000',
    ` name ${name}`,
    ` label "solve ${d.solve.number} · RMS ${num(d.solve.rms, 3)} px"`,
    ' xpos 0',
    ' ypos 0',
    '}',
    'ReadGeo2 {',
    ' inputs 0',
    ` file "[file dirname [value root.name]]/${d.files.obj}"`,
    ` name ReadGeo_${safeId(d.shot)}_tracks`,
    ' xpos 150',
    ' ypos 0',
    '}',
    'Scene {',
    ' inputs 2',
    ` name Scene_${safeId(d.shot)}`,
    ' xpos 75',
    ' ypos 100',
    '}',
    'StickyNote {',
    ' inputs 0',
    ` label "${note.replace(/"/g, "'")}"`,
    ' name LensNote',
    ' xpos 0',
    ' ypos -150',
    '}',
  ];
  if (d.files.redistort) {
    lines.push('Read {', ' inputs 0', ` file "[file dirname [value root.name]]/${d.files.redistort}"`, ` format ${fmt}`, ' raw true', ' name Read_redistort_STMap', ' xpos 300', ' ypos 0', '}');
  }
  if (d.files.undistort) {
    lines.push('Read {', ' inputs 0', ` file "[file dirname [value root.name]]/${d.files.undistort}"`, ` format ${fmt}`, ' raw true', ' name Read_undistort_STMap', ' xpos 450', ' ypos 0', '}');
  }
  return `${lines.join('\n')}\n`;
}

/** Nuke/Maya .chan: frame tx ty tz rx ry rz vfov (degrees, ZXY), in the generic up axis. */
export function writeChan(d: CameraExportData): string {
  const cams = d.upAxis === 'z' ? d.cameras.map(toZup) : d.cameras;
  const eu = eulerTrack(cams.map((c) => c.rotation), 'ZXY');
  const vfov = fovDegrees(d.focalMm, verticalAperture(d));
  return `${cams.map((c, i) => [c.frame, ...c.position.map((v) => num(v)), num(eu[i]!.x), num(eu[i]!.y), num(eu[i]!.z), num(vfov)].join('\t')).join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Maya
// ---------------------------------------------------------------------------

const MAYA_UNIT: Record<SceneUnit, string> = { m: 'meter', cm: 'centimeter', mm: 'millimeter', ft: 'foot', in: 'inch' };

export function mayaTimeUnit(fps: number): string {
  const named: [number, string][] = [
    [15, 'game'],
    [24, 'film'],
    [25, 'pal'],
    [30, 'ntsc'],
    [48, 'show'],
    [50, 'palf'],
    [60, 'ntscf'],
  ];
  for (const [f, n] of named) if (Math.abs(fps - f) < 1e-3) return n;
  for (const f of [23.976, 29.97, 47.952, 59.94]) if (Math.abs(fps - f) < 0.01) return `${f}fps`;
  return `${Math.round(fps)}fps`;
}

export function writeMaya(d: CameraExportData): string {
  const par = pixelAspectOfData(d);
  // Maya: the camera aperture is the film as exposed (squeezed); lensSqueezeRatio widens it to the picture.
  const capW = d.filmBackMm.width / par;
  const frames = d.cameras.map((c) => c.frame);
  const eu = eulerTrack(d.cameras.map((c) => c.rotation), 'XYZ');
  const cam = `cam_${safeId(d.shot)}_v${String(d.version).padStart(3, '0')}`;
  const out: string[] = [
    '//Maya ASCII 2018 scene',
    `//Name: ${d.shot}_camtrack_v${String(d.version).padStart(3, '0')}.ma`,
    `//Written by ${d.generator} at ${d.writtenAt}`,
    'requires maya "2018";',
    `currentUnit -l ${MAYA_UNIT[d.units]} -a degree -t ${mayaTimeUnit(d.fps)};`,
    `fileInfo "application" "maya";`,
    `createNode transform -n "${cam}";`,
    '\tsetAttr ".ro" 0;',
    `createNode camera -n "${cam}Shape" -p "${cam}";`,
    '\tsetAttr -k off ".v";',
    '\tsetAttr ".rnd" yes;',
    `\tsetAttr ".cap" -type "double2" ${num(capW / MM_PER_INCH, 6)} ${num(verticalAperture(d) / MM_PER_INCH, 6)} ;`,
    ...(par !== 1 ? [`\tsetAttr ".lsr" ${num(par, 6)};`] : []),
    `\tsetAttr ".fl" ${num(d.focalMm, 5)};`,
    '\tsetAttr ".ff" 1;',
    `\tsetAttr ".hfo" ${num((d.principalOffsetPx.x / d.width) * (capW / MM_PER_INCH), 6)};`,
    `\tsetAttr ".vfo" ${num((-d.principalOffsetPx.y / d.height) * (verticalAperture(d) / MM_PER_INCH), 6)};`,
    '\tsetAttr ".ncp" 0.01;',
    '\tsetAttr ".fcp" 100000;',
    `\tsetAttr ".imn" -type "string" "${cam}";`,
    `\tsetAttr ".den" -type "string" "${cam}_depth";`,
    `\tsetAttr ".man" -type "string" "${cam}_mask";`,
  ];
  const curve = (attr: string, type: 'animCurveTL' | 'animCurveTA', values: number[]) => {
    const node = `${cam}_${attr}`;
    out.push(`createNode ${type} -n "${node}";`, '\tsetAttr ".wgt" no;');
    const pairs = frames.map((f, i) => `${f} ${num(values[i]!)}`);
    out.push(`\tsetAttr -s ${frames.length} ".ktv[0:${frames.length - 1}]"  ${pairs.join(' ')};`);
    return node;
  };
  const conn: [string, string][] = [];
  conn.push([curve('translateX', 'animCurveTL', d.cameras.map((c) => c.position[0])), 'tx']);
  conn.push([curve('translateY', 'animCurveTL', d.cameras.map((c) => c.position[1])), 'ty']);
  conn.push([curve('translateZ', 'animCurveTL', d.cameras.map((c) => c.position[2])), 'tz']);
  conn.push([curve('rotateX', 'animCurveTA', eu.map((e) => e.x)), 'rx']);
  conn.push([curve('rotateY', 'animCurveTA', eu.map((e) => e.y)), 'ry']);
  conn.push([curve('rotateZ', 'animCurveTA', eu.map((e) => e.z)), 'rz']);
  const group = `tracks_${safeId(d.shot)}`;
  out.push(`createNode transform -n "${group}";`);
  for (const p of d.points) {
    const n = `track_${p.id}`;
    out.push(`createNode transform -n "${n}" -p "${group}";`, `\tsetAttr ".t" -type "double3" ${num(p.position[0])} ${num(p.position[1])} ${num(p.position[2])} ;`, `createNode locator -n "${n}Shape" -p "${n}";`, '\tsetAttr -k off ".v";');
  }
  for (const [node, attr] of conn) out.push(`connectAttr "${node}.o" "${cam}.${attr}";`);
  if (par !== 1) {
    // Render the plate's own raster with its pixel aspect (device aspect = the de-squeezed picture).
    out.push('select -ne :defaultResolution;', `\tsetAttr ".w" ${d.width};`, `\tsetAttr ".h" ${d.height};`, `\tsetAttr ".pa" ${num(par, 6)};`, '\tsetAttr ".al" yes;', `\tsetAttr ".dar" ${num(shownWidth(d) / d.height, 6)};`);
  }
  out.push(`// End of ${d.shot}_camtrack_v${String(d.version).padStart(3, '0')}.ma`);
  return `${out.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Blender
// ---------------------------------------------------------------------------

export function writeBlender(d: CameraExportData): string {
  const toM = { m: 1, cm: 0.01, mm: 0.001, ft: 0.3048, in: 0.0254 }[d.units];
  const cams = d.cameras.map(toZup).map((c) => ({ ...c, position: c.position.map((v) => v * toM) as [number, number, number] }));
  const eu = eulerTrack(cams.map((c) => c.rotation), 'XYZ').map((e) => [(e.x * Math.PI) / 180, (e.y * Math.PI) / 180, (e.z * Math.PI) / 180]);
  const flat = (rows: number[][]) => rows.map((r) => r.map((v) => num(v, 7)).join(',')).join(',');
  const pts = d.points.map((p) => {
    const z = mulv3(YUP_TO_ZUP, p.position);
    return [p.id, z[0]! * toM, z[1]! * toM, z[2]! * toM];
  });
  const name = `${d.shot}_camtrack_v${String(d.version).padStart(3, '0')}`;
  const fpsInt = Math.round(d.fps);
  const fpsBase = d.fps > 0 ? fpsInt / d.fps : 1;
  return `# ${name}: camera track written by ${d.generator} at ${d.writtenAt}
# Run in Blender (Scripting workspace, or blender --python this.py). Builds the camera,
# its animation and an empty per solved track point. Blender is Z-up, metres.
# Lens (OpenCV Brown-Conrady, normalised by focal ${num(d.focalPx, 2)} px): k1 ${num(d.distortion.k1)} k2 ${num(d.distortion.k2)} k3 ${num(d.distortion.k3)} p1 ${num(d.distortion.p1)} p2 ${num(d.distortion.p2)}.
# This camera is the undistorted pinhole; use the STMaps beside this file for the plate.${pixelAspectOfData(d) !== 1 ? `
# Pixel aspect ${num(pixelAspectOfData(d), 4)}: the render is the plate's ${d.width} x ${d.height} raster with pixel_aspect_x set;
# sensor_width is the de-squeezed picture's (${num(d.filmBackMm.width, 3)} mm), fit HORIZONTAL.` : ''}
import bpy

FRAMES = [${d.cameras.map((c) => c.frame).join(',')}]
LOCATIONS = [${flat(cams.map((c) => c.position))}]
ROTATIONS = [${flat(eu)}]
POINTS = [${pts.map((p) => `(${p[0]},${num(p[1]!, 7)},${num(p[2]!, 7)},${num(p[3]!, 7)})`).join(',')}]

scene = bpy.context.scene
scene.render.resolution_x = ${d.width}
scene.render.resolution_y = ${d.height}
scene.render.pixel_aspect_x = ${num(pixelAspectOfData(d), 6)}
scene.render.pixel_aspect_y = 1.0
scene.render.fps = ${fpsInt}
scene.render.fps_base = ${num(fpsBase, 9)}
scene.frame_start = FRAMES[0]
scene.frame_end = FRAMES[-1]

data = bpy.data.cameras.new("${name}")
data.lens = ${num(d.focalMm, 5)}
data.sensor_fit = 'HORIZONTAL'
data.sensor_width = ${num(d.filmBackMm.width, 5)}
data.sensor_height = ${num(verticalAperture(d), 5)}
data.shift_x = ${num(d.principalOffsetPx.x / d.width, 7)}
data.shift_y = ${num(-d.principalOffsetPx.y / shownWidth(d), 7)}
data.clip_start = 0.01
data.clip_end = 10000.0
cam = bpy.data.objects.new("${name}", data)
scene.collection.objects.link(cam)
cam.rotation_mode = 'XYZ'

# keyframe_insert works with every Blender since 2.8, including 4.4+'s slotted actions.
for i, f in enumerate(FRAMES):
    cam.location = LOCATIONS[3 * i:3 * i + 3]
    cam.rotation_euler = ROTATIONS[3 * i:3 * i + 3]
    cam.keyframe_insert(data_path="location", frame=f)
    cam.keyframe_insert(data_path="rotation_euler", frame=f)
try:
    for fc in cam.animation_data.action.fcurves:
        for kp in fc.keyframe_points:
            kp.interpolation = 'LINEAR'
except Exception:
    pass  # newer layered actions keep their curves elsewhere; the keys are exact on every frame either way

tracks = bpy.data.collections.new("${name}_tracks")
scene.collection.children.link(tracks)
for (tid, x, y, z) in POINTS:
    e = bpy.data.objects.new("track_%d" % tid, None)
    e.empty_display_type = 'PLAIN_AXES'
    e.empty_display_size = ${num(0.05 * (toM === 1 ? 1 : 1), 3)}
    e.location = (x, y, z)
    tracks.objects.link(e)

scene.camera = cam
scene.frame_set(FRAMES[0])
`;
}

// ---------------------------------------------------------------------------
// After Effects
// ---------------------------------------------------------------------------

/** AE pixels per scene unit. */
export const AE_SCALE = 100;
/** Y-up scene axes → AE axes (x right, y down, z into the screen). */
const AE_FLIP = [1, 0, 0, 0, -1, 0, 0, 0, -1];

export function aeCamera(d: CameraExportData, c: SceneCamera): { position: number[]; rotation: number[] } {
  const p = c.position;
  const position = [p[0] * AE_SCALE + d.width / 2, -p[1] * AE_SCALE + d.height / 2, -p[2] * AE_SCALE];
  // Camera axes in AE: x right, y down, z forward = the CV camera; in AE world axes.
  const rotation = mul3(mul3(AE_FLIP, c.rotation), AE_FLIP);
  return { position, rotation };
}

export function writeAfterEffects(d: CameraExportData): string {
  const name = `${d.shot}_camtrack_v${String(d.version).padStart(3, '0')}`;
  const ae = d.cameras.map((c) => aeCamera(d, c));
  const eu = eulerTrack(ae.map((a) => a.rotation), 'ZYX');
  const first = d.cameras[0]?.frame ?? 0;
  const last = d.cameras[d.cameras.length - 1]?.frame ?? first;
  // Zoom: distance to the image plane in comp pixels, measured vertically for a non-square comp — the vertical focal.
  const par = pixelAspectOfData(d);
  const zoom = (d.focalMm * shownWidth(d)) / d.filmBackMm.width;
  const times = d.cameras.map((c) => num((c.frame - first) / d.fps, 6));
  const nulls = d.points.slice(0, 400).map((p) => `[${p.id},${num(p.position[0] * AE_SCALE + d.width / 2, 3)},${num(-p.position[1] * AE_SCALE + d.height / 2, 3)},${num(-p.position[2] * AE_SCALE, 3)}]`);
  return `// ${name}: camera track for After Effects, written by ${d.generator} at ${d.writtenAt}
// File > Scripts > Run Script File… With a composition open it adds the camera to it;
// otherwise it makes a ${d.width}×${d.height} composition at ${num(d.fps, 3)} fps starting at frame ${first}.
// Zoom ${num(zoom, 3)} px = focal ${num(d.focalMm, 3)} mm on a ${num(d.filmBackMm.width, 3)} mm film back across ${par !== 1 ? `${num(shownWidth(d), 2)} de-squeezed px (${d.width} px at pixel aspect ${num(par, 4)}; the new comp declares it)` : `${d.width} px`}.
// Scene units are ${AE_SCALE} px each; Y is down in After Effects. Undistorted pinhole camera:
// lens distortion is not applied (use the STMaps).
(function () {
  app.beginUndoGroup("VC VFX camera ${name}");
  var W = ${d.width}, H = ${d.height}, FPS = ${num(d.fps, 6)};
  var comp = app.project.activeItem;
  if (!(comp && comp instanceof CompItem)) {
    comp = app.project.items.addComp("${name}", W, H, ${num(par, 6)}, ${num((last - first + 1) / d.fps, 6)}, FPS);
    comp.displayStartTime = ${num(first / d.fps, 6)};
    comp.openInViewer();
  }
  var cam = comp.layers.addCamera("${name}", [W / 2, H / 2]);
  cam.autoOrient = AutoOrientType.NO_AUTO_ORIENT;
  var opts = cam.property("ADBE Camera Options Group");
  opts.property("ADBE Camera Zoom").setValue(${num(zoom, 4)} * comp.width / W);
  var tr = cam.property("ADBE Transform Group");
  var times = [${times.join(',')}];
  var pos = [${ae.map((a) => `[${a.position.map((v) => num(v, 4)).join(',')}]`).join(',')}];
  var ori = [${eu.map((e) => `[${num(e.x, 5)},${num(e.y, 5)},${num(e.z, 5)}]`).join(',')}];
  var k = comp.width / W;
  for (var i = 0; i < pos.length; i++) pos[i] = [pos[i][0] * k, pos[i][1] * k, pos[i][2] * k];
  tr.property("ADBE Position").setValuesAtTimes(times, pos);
  tr.property("ADBE Orientation").setValuesAtTimes(times, ori);
  var nulls = [${nulls.join(',')}];
  for (var j = 0; j < nulls.length; j++) {
    var n = comp.layers.addNull();
    n.threeDLayer = true;
    n.name = "track_" + nulls[j][0];
    n.property("ADBE Transform Group").property("ADBE Position").setValue([nulls[j][1] * k, nulls[j][2] * k, nulls[j][3] * k]);
    n.shy = true;
  }
  app.endUndoGroup();
})();
`;
}

// ---------------------------------------------------------------------------
// 3ds Max
// ---------------------------------------------------------------------------

export function writeMax(d: CameraExportData): string {
  const name = `${d.shot}_camtrack_v${String(d.version).padStart(3, '0')}`;
  const cams = d.cameras.map(toZup);
  const first = cams[0]?.frame ?? 0;
  const last = cams[cams.length - 1]?.frame ?? first;
  const hfov = fovDegrees(d.focalMm, d.filmBackMm.width);
  const par = pixelAspectOfData(d);
  const m3 = (c: SceneCamera) => {
    const R = c.rotation; // columns = camera axes in world
    const col = (j: number) => `[${num(R[j]!, 7)},${num(R[3 + j]!, 7)},${num(R[6 + j]!, 7)}]`;
    return `(matrix3 ${col(0)} ${col(1)} ${col(2)} [${c.position.map((v) => num(v, 6)).join(',')}])`;
  };
  const pts = d.points.map((p) => {
    const z = mulv3(YUP_TO_ZUP, p.position);
    return `Point name:"track_${p.id}" pos:[${num(z[0]!, 6)},${num(z[1]!, 6)},${num(z[2]!, 6)}] size:${num(0.05, 3)} cross:true box:false parent:grp`;
  });
  return `-- ${name}: camera track written by ${d.generator} at ${d.writtenAt}
-- Run with Scripting > Run Script. 3ds Max is Z-up; positions are in scene units (${d.units}) taken as system units.
-- Horizontal FOV ${num(hfov, 4)}° = focal ${num(d.focalMm, 3)} mm on a ${num(d.filmBackMm.width, 3)} mm film back${par !== 1 ? ` (the de-squeezed picture; pixel aspect ${num(par, 4)})` : ''}. Undistorted pinhole camera.
(
  frameRate = ${Math.round(d.fps)}
  animationRange = interval ${first} ${last}
  renderWidth = ${d.width}
  renderHeight = ${d.height}
  renderPixelAspect = ${num(par, 6)}
  local cam = Freecamera name:"${name}"
  cam.fovType = 1
  cam.fov = ${num(hfov, 6)}
  cam.nearclip = 0.01
  cam.farclip = 100000
  animate on
  (
${cams.map((c) => `    at time ${c.frame} cam.transform = ${m3(c)}`).join('\n')}
  )
  local grp = Dummy name:"${name}_tracks"
${pts.map((p) => `  ${p}`).join('\n')}
  sliderTime = ${first}
)
`;
}

// ---------------------------------------------------------------------------
// FBX ASCII 7.4
// ---------------------------------------------------------------------------

export const FBX_KTIME_PER_SECOND = 46186158000;

export function fbxTimeMode(fps: number): number {
  const table: [number, number][] = [
    [120, 1],
    [100, 2],
    [60, 3],
    [50, 4],
    [48, 5],
    [30, 6],
    [25, 10],
    [24, 11],
    [23.976, 13],
    [96, 15],
    [72, 16],
    [59.94, 17],
    [29.97, 9],
  ];
  for (const [f, m] of table) if (Math.abs(fps - f) < 0.005) return m;
  return 14; // custom
}

/** Node local axes (FBX camera looks along +X, +Y up) → graphics camera axes. */
const FBX_CAM_AXES = [0, 0, 1, 0, 1, 0, -1, 0, 0];

export function writeFbx(d: CameraExportData): string {
  const cmPerUnit = { m: 100, cm: 1, mm: 0.1, ft: 30.48, in: 2.54 }[d.units];
  const frames = d.cameras.map((c) => c.frame);
  const nodeRot = d.cameras.map((c) => mul3(c.rotation, FBX_CAM_AXES));
  const eu = eulerTrack(nodeRot, 'XYZ');
  const kt = (f: number) => Math.round((f / d.fps) * FBX_KTIME_PER_SECOND);
  const times = frames.map(kt);
  const start = times[0] ?? 0;
  const stop = times[times.length - 1] ?? start;
  const name = `${d.shot}_camtrack_v${String(d.version).padStart(3, '0')}`;
  const ID = { doc: 1000000000, model: 1000001, attr: 1000002, stack: 1000003, layer: 1000004, cnT: 1000005, cnR: 1000006 };
  const curveId = (i: number) => 1000100 + i;
  const date = new Date(d.writtenAt);
  const channels: { cn: 'T' | 'R'; axis: 'X' | 'Y' | 'Z'; values: number[] }[] = [
    { cn: 'T', axis: 'X', values: d.cameras.map((c) => c.position[0]) },
    { cn: 'T', axis: 'Y', values: d.cameras.map((c) => c.position[1]) },
    { cn: 'T', axis: 'Z', values: d.cameras.map((c) => c.position[2]) },
    { cn: 'R', axis: 'X', values: eu.map((e) => e.x) },
    { cn: 'R', axis: 'Y', values: eu.map((e) => e.y) },
    { cn: 'R', axis: 'Z', values: eu.map((e) => e.z) },
  ];
  const c0 = d.cameras[0];
  const e0 = eu[0] ?? { x: 0, y: 0, z: 0 };
  const curves = channels
    .map(
      (ch, i) => `\tAnimationCurve: ${curveId(i)}, "AnimCurve::", "" {
\t\tDefault: ${num(ch.values[0] ?? 0)}
\t\tKeyVer: 4008
\t\tKeyTime: *${times.length} {
\t\t\ta: ${times.join(',')}
\t\t}
\t\tKeyValueFloat: *${ch.values.length} {
\t\t\ta: ${ch.values.map((v) => num(v, 6)).join(',')}
\t\t}
\t\tKeyAttrFlags: *1 {
\t\t\ta: 260
\t\t}
\t\tKeyAttrDataFloat: *4 {
\t\t\ta: 0,0,218434821,0
\t\t}
\t\tKeyAttrRefCount: *1 {
\t\t\ta: ${times.length}
\t\t}
\t}`,
    )
    .join('\n');
  const connections = [
    `\tC: "OO",${ID.model},0`,
    `\tC: "OO",${ID.attr},${ID.model}`,
    `\tC: "OO",${ID.layer},${ID.stack}`,
    `\tC: "OO",${ID.cnT},${ID.layer}`,
    `\tC: "OO",${ID.cnR},${ID.layer}`,
    `\tC: "OP",${ID.cnT},${ID.model}, "Lcl Translation"`,
    `\tC: "OP",${ID.cnR},${ID.model}, "Lcl Rotation"`,
    ...channels.map((ch, i) => `\tC: "OP",${curveId(i)},${ch.cn === 'T' ? ID.cnT : ID.cnR}, "d|${ch.axis}"`),
  ];
  return `; FBX 7.4.0 project file
; ${name}: camera track written by ${d.generator}
; ----------------------------------------------------

FBXHeaderExtension:  {
\tFBXHeaderVersion: 1003
\tFBXVersion: 7400
\tCreationTimeStamp:  {
\t\tVersion: 1000
\t\tYear: ${date.getUTCFullYear()}
\t\tMonth: ${date.getUTCMonth() + 1}
\t\tDay: ${date.getUTCDate()}
\t\tHour: ${date.getUTCHours()}
\t\tMinute: ${date.getUTCMinutes()}
\t\tSecond: ${date.getUTCSeconds()}
\t\tMillisecond: 0
\t}
\tCreator: "${d.generator}"
}
GlobalSettings:  {
\tVersion: 1000
\tProperties70:  {
\t\tP: "UpAxis", "int", "Integer", "",1
\t\tP: "UpAxisSign", "int", "Integer", "",1
\t\tP: "FrontAxis", "int", "Integer", "",2
\t\tP: "FrontAxisSign", "int", "Integer", "",1
\t\tP: "CoordAxis", "int", "Integer", "",0
\t\tP: "CoordAxisSign", "int", "Integer", "",1
\t\tP: "OriginalUpAxis", "int", "Integer", "",1
\t\tP: "OriginalUpAxisSign", "int", "Integer", "",1
\t\tP: "UnitScaleFactor", "double", "Number", "",${num(cmPerUnit)}
\t\tP: "OriginalUnitScaleFactor", "double", "Number", "",${num(cmPerUnit)}
\t\tP: "TimeMode", "enum", "", "",${fbxTimeMode(d.fps)}
\t\tP: "TimeSpanStart", "KTime", "Time", "",${start}
\t\tP: "TimeSpanStop", "KTime", "Time", "",${stop}
\t\tP: "CustomFrameRate", "double", "Number", "",${num(d.fps, 6)}
\t}
}
Documents:  {
\tCount: 1
\tDocument: ${ID.doc}, "", "Scene" {
\t\tProperties70:  {
\t\t\tP: "SourceObject", "object", "", ""
\t\t\tP: "ActiveAnimStackName", "KString", "", "", "Take 001"
\t\t}
\t\tRootNode: 0
\t}
}
References:  {
}
Definitions:  {
\tVersion: 100
\tCount: 8
\tObjectType: "GlobalSettings" {
\t\tCount: 1
\t}
\tObjectType: "Model" {
\t\tCount: 1
\t}
\tObjectType: "NodeAttribute" {
\t\tCount: 1
\t}
\tObjectType: "AnimationStack" {
\t\tCount: 1
\t}
\tObjectType: "AnimationLayer" {
\t\tCount: 1
\t}
\tObjectType: "AnimationCurveNode" {
\t\tCount: 2
\t}
\tObjectType: "AnimationCurve" {
\t\tCount: 6
\t}
}
Objects:  {
\tNodeAttribute: ${ID.attr}, "NodeAttribute::${name}", "Camera" {
\t\tProperties70:  {
\t\t\tP: "FilmWidth", "double", "Number", "",${num(d.filmBackMm.width / pixelAspectOfData(d) / MM_PER_INCH, 6)}
\t\t\tP: "FilmHeight", "double", "Number", "",${num(verticalAperture(d) / MM_PER_INCH, 6)}
\t\t\tP: "FilmAspectRatio", "double", "Number", "",${num(d.width / d.height, 6)}
\t\t\tP: "FilmSqueezeRatio", "double", "Number", "",${num(pixelAspectOfData(d), 6)}
\t\t\tP: "ApertureMode", "enum", "", "",3
\t\t\tP: "GateFit", "enum", "", "",2
\t\t\tP: "FocalLength", "Number", "", "A",${num(d.focalMm, 6)}
\t\t\tP: "AspectWidth", "double", "Number", "",${d.width}
\t\t\tP: "AspectHeight", "double", "Number", "",${d.height}
\t\t\tP: "PixelAspectRatio", "double", "Number", "",${num(pixelAspectOfData(d), 6)}
\t\t\tP: "NearPlane", "double", "Number", "",1
\t\t\tP: "FarPlane", "double", "Number", "",1000000
\t\t}
\t\tTypeFlags: "Camera"
\t\tGeometryVersion: 124
\t\tPosition: 0,0,0
\t\tUp: 0,1,0
\t\tLookAt: 1,0,0
\t\tShowInfoOnMoving: 1
\t\tShowAudio: 0
\t\tAudioColor: 0,1,0
\t\tCameraOrthoZoom: 1
\t}
\tModel: ${ID.model}, "Model::${name}", "Camera" {
\t\tVersion: 232
\t\tProperties70:  {
\t\t\tP: "RotationOrder", "enum", "", "",0
\t\t\tP: "RotationActive", "bool", "", "",1
\t\t\tP: "InheritType", "enum", "", "",1
\t\t\tP: "DefaultAttributeIndex", "int", "Integer", "",0
\t\t\tP: "Lcl Translation", "Lcl Translation", "", "A",${c0 ? c0.position.map((v) => num(v)).join(',') : '0,0,0'}
\t\t\tP: "Lcl Rotation", "Lcl Rotation", "", "A",${num(e0.x)},${num(e0.y)},${num(e0.z)}
\t\t}
\t\tShading: Y
\t\tCulling: "CullingOff"
\t}
\tAnimationStack: ${ID.stack}, "AnimStack::Take 001", "" {
\t\tProperties70:  {
\t\t\tP: "LocalStart", "KTime", "Time", "",${start}
\t\t\tP: "LocalStop", "KTime", "Time", "",${stop}
\t\t\tP: "ReferenceStart", "KTime", "Time", "",${start}
\t\t\tP: "ReferenceStop", "KTime", "Time", "",${stop}
\t\t}
\t}
\tAnimationLayer: ${ID.layer}, "AnimLayer::BaseLayer", "" {
\t}
\tAnimationCurveNode: ${ID.cnT}, "AnimCurveNode::T", "" {
\t\tProperties70:  {
\t\t\tP: "d|X", "Number", "", "A",${num(channels[0]!.values[0] ?? 0)}
\t\t\tP: "d|Y", "Number", "", "A",${num(channels[1]!.values[0] ?? 0)}
\t\t\tP: "d|Z", "Number", "", "A",${num(channels[2]!.values[0] ?? 0)}
\t\t}
\t}
\tAnimationCurveNode: ${ID.cnR}, "AnimCurveNode::R", "" {
\t\tProperties70:  {
\t\t\tP: "d|X", "Number", "", "A",${num(channels[3]!.values[0] ?? 0)}
\t\t\tP: "d|Y", "Number", "", "A",${num(channels[4]!.values[0] ?? 0)}
\t\t\tP: "d|Z", "Number", "", "A",${num(channels[5]!.values[0] ?? 0)}
\t\t}
\t}
${curves}
}
Connections:  {
${connections.join('\n')}
}
Takes:  {
\tCurrent: "Take 001"
\tTake: "Take 001" {
\t\tFileName: "Take_001.tak"
\t\tLocalTime: ${start},${stop}
\t\tReferenceTime: ${start},${stop}
\t}
}
`;
}

// ---------------------------------------------------------------------------
// OBJ of track points, JSON camera
// ---------------------------------------------------------------------------

export function writePointsObj(d: CameraExportData): string {
  const conv = d.upAxis === 'z' ? (p: number[]) => mulv3(YUP_TO_ZUP, p) : (p: number[]) => p;
  // Nuke and Maya read this OBJ in their own (Y-up) scene: always write Y-up here; .json carries both.
  void conv;
  return `# ${d.shot} solved track points (Y-up, ${d.units}), written by ${d.generator}\n# one vertex per track; the comment after each gives the track id and its RMS error (px)\n${d.points.map((p) => `v ${num(p.position[0])} ${num(p.position[1])} ${num(p.position[2])} # track ${p.id} ${num(p.error, 3)}px`).join('\n')}\n`;
}

export function writeCameraJson(d: CameraExportData, extra: Record<string, unknown> = {}): string {
  const generic = d.upAxis === 'z' ? d.cameras.map(toZup) : d.cameras;
  const doc = {
    format: 'vcvfx.camera/1',
    generator: d.generator,
    writtenAt: d.writtenAt,
    shot: d.shot,
    version: `v${String(d.version).padStart(3, '0')}`,
    coordinateSystem: { up: d.upAxis, handedness: 'right', units: d.units, camera: 'looks down its local −Z with +Y up (graphics convention)' },
    frameRange: { first: d.cameras[0]?.frame ?? null, last: d.cameras[d.cameras.length - 1]?.frame ?? null, solved: d.cameras.length, fps: d.fps },
    plate: { width: d.width, height: d.height, pixelAspect: pixelAspectOfData(d), displayWidth: shownWidth(d) },
    filmBackMm: { width: d.filmBackMm.width, height: verticalAperture(d), nominal: d.nominalFilmBack, desqueezed: pixelAspectOfData(d) !== 1, sensor: d.sensorFilmBackMm ?? null },
    lens: {
      focalMm: d.focalMm,
      focalPx: d.focalPx,
      /** Plate pixels: fx across the stored (squeezed) width, fy vertical. */
      fxPx: d.focalPx / pixelAspectOfData(d),
      fyPx: d.focalPx,
      principalOffsetPx: d.principalOffsetPx,
      distortion: { model: 'brown-conrady (OpenCV)', normalisedBy: 'focal length in pixels, about the principal point, on de-squeezed coordinates: x = (u − cx) · pixelAspect / focalPx, y = (v − cy) / focalPx', ...d.distortion },
      undistortStmap: d.files.undistort ?? null,
      redistortStmap: d.files.redistort ?? null,
    },
    solve: d.solve,
    cameras: generic.map((c) => ({ frame: c.frame, position: c.position, rotationMatrix: c.rotation, eulerZXYDegrees: undefined as unknown })),
    points: d.points.map((p) => ({ id: p.id, position: d.upAxis === 'z' ? mulv3(YUP_TO_ZUP, p.position) : p.position, errorPx: p.error })),
    ...extra,
  };
  const eu = eulerTrack(generic.map((c) => c.rotation), 'ZXY');
  doc.cameras.forEach((c, i) => (c.eulerZXYDegrees = [eu[i]!.x, eu[i]!.y, eu[i]!.z]));
  return `${JSON.stringify(doc, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Real-time engines and USD (addendum 06 §6.2)
// ---------------------------------------------------------------------------

const UNIT_M: Record<SceneUnit, number> = { m: 1, cm: 0.01, mm: 0.001, ft: 0.3048, in: 0.0254 };

/** A frame rate as a rational: NTSC rates exactly (24000/1001), others to 1/1000. */
export function frameRateRational(fps: number): [number, number] {
  for (const base of [24, 30, 48, 60, 120]) if (Math.abs(fps - (base * 1000) / 1001) < 0.005) return [base * 1000, 1001];
  if (Math.abs(fps - Math.round(fps)) < 1e-6) return [Math.round(fps), 1];
  return [Math.round(fps * 1000), 1000];
}

/** Nearest equivalent angle (degrees) to `prev`, so curves never jump 360°. */
const unwrapDeg = (a: number, prev: number | undefined) => (prev === undefined ? a : a + 360 * Math.round((prev - a) / 360));

/**
 * Scene (Y-up, right-handed, camera looking down −Z) → Unreal (Z-up,
 * left-handed: X forward, Y right, Z up). The scene's forward (−Z) becomes
 * Unreal's X, its right (X) Unreal's Y, its up (Y) Unreal's Z. Determinant −1:
 * the handedness flip.
 */
export const SCENE_TO_UNREAL = [0, 0, -1, 1, 0, 0, 0, 1, 0];

/**
 * Unreal's FRotator from an actor's axes (forward, right, up) in Unreal's
 * world, following FRotationTranslationMatrix: forward = (cP·cY, cP·sY, sP),
 * right.z = −sR·cP, up.z = cR·cP.
 */
export function unrealRotator(fwd: ArrayLike<number>, right: ArrayLike<number>, up: ArrayLike<number>): { pitch: number; yaw: number; roll: number } {
  const pitch = deg(Math.asin(Math.max(-1, Math.min(1, fwd[2]!))));
  const yaw = deg(Math.atan2(fwd[1]!, fwd[0]!));
  const roll = deg(Math.atan2(-right[2]!, up[2]!));
  return { pitch, yaw, roll };
}

/** Axes of an Unreal FRotator (forward, right, up), for checking. */
export function unrealAxes(r: { pitch: number; yaw: number; roll: number }): { fwd: number[]; right: number[]; up: number[] } {
  const [P, Y, R] = [r.pitch, r.yaw, r.roll].map((v) => (v * Math.PI) / 180) as [number, number, number];
  const [cP, sP, cY, sY, cR, sR] = [Math.cos(P), Math.sin(P), Math.cos(Y), Math.sin(Y), Math.cos(R), Math.sin(R)];
  return {
    fwd: [cP * cY, cP * sY, sP],
    right: [sR * sP * cY - cR * sY, sR * sP * sY + cR * cY, -sR * cP],
    up: [-(cR * sP * cY + sR * sY), cY * sR - cR * sP * sY, cR * cP],
  };
}

/** Camera keys for Unreal: location in cm, rotator in degrees (unwrapped). */
export function unrealKeys(d: CameraExportData): { frame: number; location: number[]; rotation: { pitch: number; yaw: number; roll: number } }[] {
  const cm = UNIT_M[d.units] * 100;
  let prev: { pitch: number; yaw: number; roll: number } | undefined;
  return d.cameras.map((c) => {
    const col = (j: number) => [c.rotation[j]!, c.rotation[3 + j]!, c.rotation[6 + j]!];
    const fwd = mulv3(SCENE_TO_UNREAL, col(2).map((v) => -v));
    const right = mulv3(SCENE_TO_UNREAL, col(0));
    const up = mulv3(SCENE_TO_UNREAL, col(1));
    const r = unrealRotator(fwd, right, up);
    const rot = { pitch: r.pitch, yaw: unwrapDeg(r.yaw, prev?.yaw), roll: unwrapDeg(r.roll, prev?.roll) };
    prev = rot;
    return { frame: c.frame, location: mulv3(SCENE_TO_UNREAL, c.position).map((v) => v * cm), rotation: rot };
  });
}

const pyList = (values: readonly number[], digits = 6) => `[${values.map((v) => num(v, digits)).join(', ')}]`;

export function writeUnreal(d: CameraExportData): string {
  const name = `${d.shot}_camtrack_v${String(d.version).padStart(3, '0')}`;
  const keys = unrealKeys(d);
  const first = keys[0]?.frame ?? 1001;
  const last = keys[keys.length - 1]?.frame ?? first;
  const [fn, fd] = frameRateRational(d.fps);
  const cm = UNIT_M[d.units] * 100;
  const pts = d.points.map((p) => mulv3(SCENE_TO_UNREAL, p.position).map((v) => v * cm));
  // Marker size: half a percent of the track points' spread, in cm (the engine sphere is 100 cm across).
  const spread = pts.length ? Math.max(...[0, 1, 2].map((k) => Math.max(...pts.map((p) => p[k]!)) - Math.min(...pts.map((p) => p[k]!)))) : 100;
  const marker = Math.max(0.5, spread * 0.005) / 100;
  return `# ${name}: camera track for Unreal Engine 5.x, written by ${d.generator} at ${d.writtenAt}
# Run inside the Unreal Editor: Tools > Execute Python Script... (the Python Editor Script Plugin must be on).
# Creates /Game/VCVFX/${name} (a Level Sequence at ${num(d.fps, 3)} fps, frames ${first}-${last}) with a
# CineCameraActor bound to it: transform keyed per frame, filmback ${num(d.filmBackMm.width, 3)} x ${num(verticalAperture(d), 3)} mm${pixelAspectOfData(d) !== 1 ? ` (the de-squeezed picture:
# the plate is ${d.width} x ${d.height} at pixel aspect ${num(pixelAspectOfData(d), 4)}; Unreal renders square pixels, so render ${Math.round(shownWidth(d))} x ${d.height}
# and squeeze in comp, or compare with the plate desqueezed)` : ''},
# focal length ${num(d.focalMm, 3)} mm keyed per frame, a camera cut, and (SPAWN_MARKERS) a small sphere per solved track.
#
# Coordinates: the scene is Y-up, right-handed, in ${d.units}. Unreal is Z-up, left-handed, centimetres:
# Unreal X = scene -Z (forward), Unreal Y = scene X (right), Unreal Z = scene Y (up), x ${num(cm, 4)} cm per ${d.units}.
# The camera is the UNDISTORTED pinhole: undistort the plate (STMaps in this folder) before comparing CG with it.
# Solve ${d.solve.number}: RMS ${num(d.solve.rms, 3)} px over ${d.solve.frames} frames.
import unreal

NAME = ${JSON.stringify(name)}
PACKAGE = '/Game/VCVFX'
SPAWN_MARKERS = True
MAX_MARKERS = 500
FPS = (${fn}, ${fd})
FIRST, LAST = ${first}, ${last}
SENSOR_MM = (${num(d.filmBackMm.width, 6)}, ${num(verticalAperture(d), 6)})
FRAMES = [${keys.map((k) => k.frame).join(', ')}]
LOCATION_CM = [${keys.map((k) => pyList(k.location, 5)).join(', ')}]
ROTATION_PYR = [${keys.map((k) => pyList([k.rotation.pitch, k.rotation.yaw, k.rotation.roll], 6)).join(', ')}]
FOCAL_MM = ${pyList(keys.map(() => d.focalMm))}
TRACKS = [${d.points.map((p, i) => `(${p.id}, ${pyList(pts[i]!, 4)})`).join(', ')}]
MARKER_SCALE = ${num(marker, 5)}


def _channels(section):
    get = getattr(section, 'get_all_channels', None) or getattr(section, 'get_channels')
    return get()


def _add_track(owner, track_class):
    add = getattr(owner, 'add_track', None) or getattr(owner, 'add_master_track')
    return add(track_class)


def main():
    tools = unreal.AssetToolsHelpers.get_asset_tools()
    seq = tools.create_asset(NAME, PACKAGE, unreal.LevelSequence, unreal.LevelSequenceFactoryNew())
    seq.set_display_rate(unreal.FrameRate(FPS[0], FPS[1]))
    seq.set_playback_start(FIRST)
    seq.set_playback_end(LAST + 1)

    actors = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
    cam_actor = actors.spawn_actor_from_class(unreal.CineCameraActor, unreal.Vector(*LOCATION_CM[0]), unreal.Rotator(ROTATION_PYR[0][2], ROTATION_PYR[0][0], ROTATION_PYR[0][1]))
    cam_actor.set_actor_label(NAME)
    cam = cam_actor.get_cine_camera_component()
    filmback = cam.get_editor_property('filmback')
    filmback.set_editor_property('sensor_width', SENSOR_MM[0])
    filmback.set_editor_property('sensor_height', SENSOR_MM[1])
    cam.set_editor_property('filmback', filmback)
    lens = cam.get_editor_property('lens_settings')
    lens.set_editor_property('min_focal_length', min(4.0, min(FOCAL_MM)))
    lens.set_editor_property('max_focal_length', max(1000.0, max(FOCAL_MM)))
    cam.set_editor_property('lens_settings', lens)
    focus = cam.get_editor_property('focus_settings')
    focus.set_editor_property('focus_method', unreal.CameraFocusMethod.DISABLE)
    cam.set_editor_property('focus_settings', focus)
    cam.set_editor_property('current_focal_length', FOCAL_MM[0])

    binding = seq.add_possessable(cam_actor)
    transform = _add_track(binding, unreal.MovieScene3DTransformTrack)
    section = transform.add_section()
    section.set_range(FIRST, LAST + 1)
    ch = _channels(section)  # location x y z, rotation x (roll) y (pitch) z (yaw), scale x y z
    for i, f in enumerate(FRAMES):
        frame = unreal.FrameNumber(f)
        x, y, z = LOCATION_CM[i]
        pitch, yaw, roll = ROTATION_PYR[i]
        for c, v in zip(ch[:6], (x, y, z, roll, pitch, yaw)):
            c.add_key(frame, v, interpolation=unreal.MovieSceneKeyInterpolation.LINEAR)

    cam_binding = seq.add_possessable(cam)
    focal = _add_track(cam_binding, unreal.MovieSceneFloatTrack)
    focal.set_property_name_and_path('Current Focal Length', 'CurrentFocalLength')
    fsec = focal.add_section()
    fsec.set_range(FIRST, LAST + 1)
    fch = _channels(fsec)[0]
    for i, f in enumerate(FRAMES):
        fch.add_key(unreal.FrameNumber(f), FOCAL_MM[i], interpolation=unreal.MovieSceneKeyInterpolation.LINEAR)

    try:
        cuts = _add_track(seq, unreal.MovieSceneCameraCutTrack)
        cut = cuts.add_section()
        cut.set_range(FIRST, LAST + 1)
        cut.set_camera_binding_id(seq.get_binding_id(binding))
    except Exception as error:  # older or newer API: the camera is still bound and keyed
        unreal.log_warning('VC VFX: no camera cut track ({})'.format(error))

    if SPAWN_MARKERS and TRACKS:
        mesh = unreal.EditorAssetLibrary.load_asset('/Engine/BasicShapes/Sphere')
        step = max(1, len(TRACKS) // MAX_MARKERS)
        for track_id, p in TRACKS[::step]:
            m = actors.spawn_actor_from_class(unreal.StaticMeshActor, unreal.Vector(*p))
            m.static_mesh_component.set_static_mesh(mesh)
            m.set_actor_scale3d(unreal.Vector(MARKER_SCALE, MARKER_SCALE, MARKER_SCALE))
            m.set_actor_label('{}_track_{}'.format(NAME, track_id))
            m.set_folder_path('{}_tracks'.format(NAME))

    unreal.EditorAssetLibrary.save_loaded_asset(seq)
    unreal.LevelSequenceEditorBlueprintLibrary.open_level_sequence(seq)
    unreal.log('VC VFX: {} - {} keys, frames {}-{}'.format(NAME, len(FRAMES), FIRST, LAST))


main()
`;
}

/**
 * Scene (Y-up, right-handed) → Unity (Y-up, left-handed, metres; a camera
 * looks down its +Z): z flips. A camera's Unity axes are right = N·x,
 * up = N·y, forward = N·(−z).
 */
const SCENE_TO_UNITY = [1, 0, 0, 0, 1, 0, 0, 0, -1];

/** Quaternion (x, y, z, w) of a rotation matrix whose columns are the rotated axes. */
export function quatOfMatrix(m: ArrayLike<number>): [number, number, number, number] {
  const [a, b, c, d, e, f, g, h, i] = Array.from(m) as [number, number, number, number, number, number, number, number, number];
  const tr = a + e + i;
  let x: number, y: number, z: number, w: number;
  if (tr > 0) {
    const s = 2 * Math.sqrt(tr + 1);
    w = s / 4;
    x = (h - f) / s;
    y = (c - g) / s;
    z = (d - b) / s;
  } else if (a > e && a > i) {
    const s = 2 * Math.sqrt(1 + a - e - i);
    w = (h - f) / s;
    x = s / 4;
    y = (b + d) / s;
    z = (c + g) / s;
  } else if (e > i) {
    const s = 2 * Math.sqrt(1 + e - a - i);
    w = (c - g) / s;
    x = (b + d) / s;
    y = s / 4;
    z = (f + h) / s;
  } else {
    const s = 2 * Math.sqrt(1 + i - a - e);
    w = (d - b) / s;
    x = (c + g) / s;
    y = (f + h) / s;
    z = s / 4;
  }
  return [x, y, z, w];
}

/** Camera keys for Unity: position in metres, rotation quaternion (sign-continuous). */
export function unityKeys(d: CameraExportData): { frame: number; position: number[]; rotation: [number, number, number, number] }[] {
  const m = UNIT_M[d.units];
  let prev: number[] | undefined;
  return d.cameras.map((c) => {
    const col = (j: number) => [c.rotation[j]!, c.rotation[3 + j]!, c.rotation[6 + j]!];
    const r = mulv3(SCENE_TO_UNITY, col(0));
    const u = mulv3(SCENE_TO_UNITY, col(1));
    const f = mulv3(SCENE_TO_UNITY, col(2).map((v) => -v));
    let q = quatOfMatrix([r[0]!, u[0]!, f[0]!, r[1]!, u[1]!, f[1]!, r[2]!, u[2]!, f[2]!]);
    if (prev && q[0] * prev[0]! + q[1] * prev[1]! + q[2] * prev[2]! + q[3] * prev[3]! < 0) q = [-q[0], -q[1], -q[2], -q[3]];
    prev = q;
    return { frame: c.frame, position: mulv3(SCENE_TO_UNITY, c.position).map((v) => v * m), rotation: q };
  });
}

const csFloats = (values: readonly number[], digits = 6) => values.map((v) => `${num(v, digits)}f`).join(', ');

export function writeUnity(d: CameraExportData): string {
  const name = `${d.shot}_camtrack_v${String(d.version).padStart(3, '0')}`;
  const cls = `VCVFX_${safeId(name)}`;
  const keys = unityKeys(d);
  const first = keys[0]?.frame ?? 1001;
  const last = keys[keys.length - 1]?.frame ?? first;
  const vAp = verticalAperture(d);
  const shift = { x: d.principalOffsetPx.x / d.width, y: -d.principalOffsetPx.y / d.height };
  return `// ${name}: camera track for Unity 2022 LTS / Unity 6, written by ${d.generator} at ${d.writtenAt}
// Put this file in Assets/Editor, then use the menu VC VFX > Import Camera Track > ${name}.
// Creates a GameObject with a Physical Camera (sensor ${num(d.filmBackMm.width, 3)} x ${num(vAp, 3)} mm${pixelAspectOfData(d) !== 1 ? ` = the de-squeezed picture of the ${d.width} x ${d.height} plate at pixel aspect ${num(pixelAspectOfData(d), 4)}; Unity renders square pixels` : ''}, focal ${num(d.focalMm, 3)} mm,
// gate fit Horizontal), an AnimationClip (position, rotation, focal length; ${num(d.fps, 3)} fps; one key per frame),
// and a Timeline (Assets/VCVFX/${name}.playable) whose clip starts at frame ${first}, so Timeline frames match the plate.
// Needs the Timeline package (com.unity.timeline; installed with the default templates).
//
// Coordinates: the scene is Y-up, right-handed, in ${d.units}. Unity is Y-up, left-handed, metres: z is flipped and
// positions are x ${num(UNIT_M[d.units], 6)} m per ${d.units}. The camera is the UNDISTORTED pinhole.
// Solve ${d.solve.number}: RMS ${num(d.solve.rms, 3)} px over ${d.solve.frames} frames. Frames ${first}-${last}.
#if UNITY_EDITOR
using UnityEditor;
using UnityEngine;
using UnityEngine.Playables;
using UnityEngine.Timeline;

public static class ${cls}
{
    const string Name = "${name}";
    const float Fps = ${num(d.fps, 6)}f;
    const int FirstFrame = ${first};
    static readonly Vector2 SensorMm = new Vector2(${num(d.filmBackMm.width, 6)}f, ${num(vAp, 6)}f);
    static readonly Vector2 LensShift = new Vector2(${num(shift.x, 7)}f, ${num(shift.y, 7)}f);
    static readonly int[] Frames = { ${keys.map((k) => k.frame).join(', ')} };
    static readonly float[] PosX = { ${csFloats(keys.map((k) => k.position[0]!))} };
    static readonly float[] PosY = { ${csFloats(keys.map((k) => k.position[1]!))} };
    static readonly float[] PosZ = { ${csFloats(keys.map((k) => k.position[2]!))} };
    static readonly float[] RotX = { ${csFloats(keys.map((k) => k.rotation[0]), 7)} };
    static readonly float[] RotY = { ${csFloats(keys.map((k) => k.rotation[1]), 7)} };
    static readonly float[] RotZ = { ${csFloats(keys.map((k) => k.rotation[2]), 7)} };
    static readonly float[] RotW = { ${csFloats(keys.map((k) => k.rotation[3]), 7)} };
    static readonly float[] FocalMm = { ${csFloats(keys.map(() => d.focalMm))} };

    static AnimationCurve Curve(float[] values)
    {
        var curve = new AnimationCurve();
        for (int i = 0; i < values.Length; i++) curve.AddKey(new Keyframe((Frames[i] - FirstFrame) / Fps, values[i]));
        for (int i = 0; i < values.Length; i++)
        {
            AnimationUtility.SetKeyLeftTangentMode(curve, i, AnimationUtility.TangentMode.Linear);
            AnimationUtility.SetKeyRightTangentMode(curve, i, AnimationUtility.TangentMode.Linear);
        }
        return curve;
    }

    static void Set(AnimationClip clip, System.Type type, string property, float[] values)
    {
        AnimationUtility.SetEditorCurve(clip, EditorCurveBinding.FloatCurve("", type, property), Curve(values));
    }

    [MenuItem("VC VFX/Import Camera Track/${name}")]
    static void Import()
    {
        var go = new GameObject(Name);
        go.transform.SetPositionAndRotation(new Vector3(PosX[0], PosY[0], PosZ[0]), new Quaternion(RotX[0], RotY[0], RotZ[0], RotW[0]));
        var cam = go.AddComponent<Camera>();
        cam.usePhysicalProperties = true;
        cam.sensorSize = SensorMm;
        cam.focalLength = FocalMm[0];
        cam.gateFit = Camera.GateFitMode.Horizontal;
        cam.lensShift = LensShift;
        cam.nearClipPlane = 0.01f;
        cam.farClipPlane = 100000f;
        var animator = go.AddComponent<Animator>();

        var clip = new AnimationClip { name = Name, frameRate = Fps };
        Set(clip, typeof(Transform), "m_LocalPosition.x", PosX);
        Set(clip, typeof(Transform), "m_LocalPosition.y", PosY);
        Set(clip, typeof(Transform), "m_LocalPosition.z", PosZ);
        Set(clip, typeof(Transform), "m_LocalRotation.x", RotX);
        Set(clip, typeof(Transform), "m_LocalRotation.y", RotY);
        Set(clip, typeof(Transform), "m_LocalRotation.z", RotZ);
        Set(clip, typeof(Transform), "m_LocalRotation.w", RotW);
        Set(clip, typeof(Camera), "m_FocalLength", FocalMm);
        clip.EnsureQuaternionContinuity();

        if (!AssetDatabase.IsValidFolder("Assets/VCVFX")) AssetDatabase.CreateFolder("Assets", "VCVFX");
        AssetDatabase.CreateAsset(clip, "Assets/VCVFX/" + Name + ".anim");
        var timeline = ScriptableObject.CreateInstance<TimelineAsset>();
        AssetDatabase.CreateAsset(timeline, "Assets/VCVFX/" + Name + ".playable");
        timeline.editorSettings.frameRate = Fps;
        var track = timeline.CreateTrack<AnimationTrack>(null, Name);
        var timelineClip = track.CreateClip(clip);
        timelineClip.start = FirstFrame / (double)Fps;
        timelineClip.displayName = Name;

        var directorObject = new GameObject(Name + "_Timeline");
        var director = directorObject.AddComponent<PlayableDirector>();
        director.playableAsset = timeline;
        director.SetGenericBinding(track, animator);
        director.time = timelineClip.start;

        AssetDatabase.SaveAssets();
        Selection.activeGameObject = go;
        Debug.Log("VC VFX: " + Name + " - " + Frames.Length + " keys, frames ${first}-${last}");
    }
}
#endif
`;
}

/**
 * USD (USDA text). Camera prims are always Y-up locally, looking down −Z
 * (UsdGeomCamera); the stage's upAxis and metersPerUnit follow the project.
 * Lens and filmback attributes are in tenths of a scene unit (UsdGeomCamera,
 * "Units of Measure for Camera Properties", pxr/usd/usdGeom/schema.usda):
 * millimetres only when metersPerUnit is 0.01.
 */
export function usdLensValue(mm: number, metersPerUnit: number): number {
  // One tenth of a scene unit = metersPerUnit / 10 m = metersPerUnit × 100 mm.
  return mm / (metersPerUnit * 100);
}

export function writeUsda(d: CameraExportData): string {
  const name = `${d.shot}_camtrack_v${String(d.version).padStart(3, '0')}`;
  const mpu = UNIT_M[d.units];
  const zup = d.upAxis === 'z';
  const cams = zup ? d.cameras.map(toZup) : d.cameras;
  const first = cams[0]?.frame ?? 1001;
  const last = cams[cams.length - 1]?.frame ?? first;
  const lens = (mm: number) => num(usdLensValue(mm, mpu), 6);
  const hAp = d.filmBackMm.width;
  const vAp = verticalAperture(d);
  // Rows are the camera's axes in the world, translation in the last row (USD's row-vector matrices).
  const matrix = (c: SceneCamera) => {
    const R = c.rotation;
    const row = (j: number) => `(${num(R[j]!, 8)}, ${num(R[3 + j]!, 8)}, ${num(R[6 + j]!, 8)}, 0)`;
    return `( ${row(0)}, ${row(1)}, ${row(2)}, (${c.position.map((v) => num(v, 6)).join(', ')}, 1) )`;
  };
  const pts = d.points.map((p) => (zup ? mulv3(YUP_TO_ZUP, p.position) : p.position));
  const spread = pts.length ? Math.max(...[0, 1, 2].map((k) => Math.max(...pts.map((p) => p[k]!)) - Math.min(...pts.map((p) => p[k]!)))) : 1;
  const width = num(Math.max(1e-4, spread * 0.004), 6);
  // USD prim names cannot start with a digit (shot names often do).
  const id = `VCVFX_${safeId(name)}`;
  return `#usda 1.0
(
    defaultPrim = "${id}"
    doc = """${name}: camera track written by ${d.generator} at ${d.writtenAt}. Solve ${d.solve.number}: RMS ${num(d.solve.rms, 3)} px over ${d.solve.frames} frames. Undistorted pinhole camera; the lens distortion (OpenCV Brown-Conrady) is in customData and the STMaps beside this file."""
    upAxis = "${zup ? 'Z' : 'Y'}"
    metersPerUnit = ${num(mpu, 6)}
    timeCodesPerSecond = ${num(d.fps, 6)}
    framesPerSecond = ${num(d.fps, 6)}
    startTimeCode = ${first}
    endTimeCode = ${last}
)

def Xform "${id}" (
    kind = "assembly"
)
{
    def Camera "camera" (
        customData = {
            string generator = "${d.generator}"
            string lensModel = "brown-conrady (OpenCV), normalised by the focal length in pixels, on de-squeezed coordinates"
            double k1 = ${num(d.distortion.k1, 8)}
            double k2 = ${num(d.distortion.k2, 8)}
            double k3 = ${num(d.distortion.k3, 8)}
            double p1 = ${num(d.distortion.p1, 8)}
            double p2 = ${num(d.distortion.p2, 8)}
            int plateWidth = ${d.width}
            int plateHeight = ${d.height}
            double pixelAspect = ${num(pixelAspectOfData(d), 8)}
            double focalPx = ${num(d.focalPx, 6)}
        }
    )
    {
        token projection = "perspective"
        float focalLength = ${lens(d.focalMm)}
        float focalLength.timeSamples = {
${cams.map((c) => `            ${c.frame}: ${lens(d.focalMm)},`).join('\n')}
        }
        float horizontalAperture = ${lens(hAp)}
        float verticalAperture = ${lens(vAp)}
        float horizontalApertureOffset = ${lens((d.principalOffsetPx.x / d.width) * hAp)}
        float verticalApertureOffset = ${lens((-d.principalOffsetPx.y / d.height) * vAp)}
        float2 clippingRange = (${num(0.01 / mpu, 6)}, ${num(100000 / mpu, 3)})
        matrix4d xformOp:transform.timeSamples = {
${cams.map((c) => `            ${c.frame}: ${matrix(c)},`).join('\n')}
        }
        uniform token[] xformOpOrder = ["xformOp:transform"]
    }

    def Points "tracks" (
        doc = "Solved track points, one per track; ids are the track ids."
    )
    {
        point3f[] points = [${pts.map((p) => `(${p.map((v) => num(v, 6)).join(', ')})`).join(', ')}]
        int64[] ids = [${d.points.map((p) => p.id).join(', ')}]
        float[] widths = [${d.points.map(() => width).join(', ')}]
        float[] primvars:errorPx = [${d.points.map((p) => num(p.error, 4)).join(', ')}] (
            interpolation = "vertex"
        )
        color3f[] primvars:displayColor = [(0.3, 0.9, 0.4)]
    }
}
${
  pixelAspectOfData(d) !== 1
    ? `
def Scope "Render"
{
    def RenderSettings "PlateSettings" (
        doc = "The plate's raster: ${d.width} x ${d.height} stored pixels at pixel aspect ${num(pixelAspectOfData(d), 6)}. The camera's apertures describe the de-squeezed picture (aspect ${num(shownWidth(d) / d.height, 6)})."
    )
    {
        rel camera = </${id}/camera>
        uniform int2 resolution = (${d.width}, ${d.height})
        uniform float pixelAspectRatio = ${num(pixelAspectOfData(d), 6)}
        uniform token aspectRatioConformPolicy = "expandAperture"
    }
}
`
    : ''
}`;
}

/** The folder's README: what each file is and how to bring it into each application. */
export function writeExportReadme(d: CameraExportData, files: readonly string[]): string {
  const name = `${d.shot}_camtrack_v${String(d.version).padStart(3, '0')}`;
  const has = (suffix: string) => files.find((f) => f.endsWith(suffix) && !(suffix === '.py' && /_(unreal|houdini)\.py$/.test(f)));
  const first = d.cameras[0]?.frame ?? 0;
  const last = d.cameras[d.cameras.length - 1]?.frame ?? first;
  const sections: string[] = [];
  const add = (suffix: string, title: string, body: string) => {
    const f = has(suffix);
    if (f) sections.push(`${title} — ${f}\n${body}`);
  };
  add('.nk', 'Nuke', '  File > Import Script (or paste). Camera2 with keyed translate/rotate (rot_order ZXY), ReadGeo2 of the track points, and STMap Read nodes when the lens has distortion.');
  add('.ma', 'Maya', '  File > Open or Import. Animated camera (rotateOrder xyz), film back in inches, and a locator per track.');
  add('.py', 'Blender', '  Scripting workspace > Open > Run Script. Camera keyed per frame (Z-up, metres), sensor fit horizontal.');
  add('.jsx', 'After Effects', '  File > Scripts > Run Script File. A comp at the plate size with a 3D camera and nulls.');
  add('.ms', '3ds Max', '  Scripting > Run Script. Free camera keyed per frame, Z-up.');
  add('.fbx', 'FBX 7.4 (ASCII)', `  Maya, Max, Houdini, Unreal, Unity. The camera is named ${name}; the frame rate is set in the file.\n  Unreal: in the Level Sequence, right-click the camera track (or the sequence) > Import... and pick this FBX; or drag it into Sequencer.\n  Unity: drop it into Assets; on the model's Animation tab the take holds the camera's curves.`);
  add('_unreal.py', 'Unreal Engine 5.x', `  Enable the Python Editor Script Plugin, then Tools > Execute Python Script... and pick this file.\n  It makes /Game/VCVFX/${name}: a Level Sequence at ${num(d.fps, 3)} fps, frames ${first}-${last}, with a CineCameraActor\n  (filmback from the camera, focal keyed per frame) and a camera cut; set SPAWN_MARKERS = False at the top to skip the track spheres.\n  Unreal is Z-up, left-handed, centimetres: X = scene forward (-Z), Y = scene right (X), Z = scene up (Y).`);
  add('_Unity.cs', 'Unity 2022 LTS / 6', `  Copy into Assets/Editor; when it compiles use VC VFX > Import Camera Track > ${name}.\n  It makes a Physical Camera, an AnimationClip and a Timeline in Assets/VCVFX (Timeline clip starts at frame ${first}).\n  Unity is Y-up, left-handed, metres: z is flipped.`);
  add('.usda', 'USD', `  Open or reference it in any USD application (usdview, Houdini Solaris, Maya, Blender, Nuke 14+, Unreal and Unity with their USD plug-ins).\n  upAxis = ${d.upAxis.toUpperCase()}, metersPerUnit = ${num(UNIT_M[d.units], 6)}, ${num(d.fps, 3)} timecodes per second, ${first}-${last}.\n  Focal length and apertures are in tenths of a scene unit, as UsdGeomCamera specifies (millimetres when metersPerUnit is 0.01).`);
  add('_houdini.py', 'Houdini', `  Windows > Python Source Editor: paste or open, then Apply (or make it a shelf tool).\n  It makes /obj/${safeId(d.shot)}_cam (keyed, rotate order xyz, focal and aperture in mm, resolution from the plate) and\n  /obj/${safeId(d.shot)}_cam_tracks, and sets ${num(d.fps, 3)} fps and frames ${first}-${last}. Houdini is Y-up, metres.\n  In Solaris, the .usda loads directly (Sublayer or Reference LOP); the .chan works in a File CHOP.`);
  add('_fusion.setting', 'DaVinci Resolve / Fusion', `  Fusion page: drag the .setting onto the Nodes view (or copy its text and paste there). Fusion Studio can open the .comp,\n  which also sets the frame range (${first}-${last}), ${num(d.fps, 3)} fps and the ${d.width} x ${d.height} frame format.\n  Camera3D with keyed Translate/Rotate (RotOrder XYZ), focal length per frame, aperture in inches, gate fit Width.\n  Track points: import the _points.obj with an FBXMesh3D tool.`);
  add('.chan', '.chan', '  Nuke Camera > Import chan file, Houdini, etc.: frame tx ty tz rx ry rz vfov (ZXY degrees).');
  add('_points.obj', 'Track points (OBJ)', '  One vertex per solved track (Y-up), track id and error as comments.');
  add('_undistort.exr', 'Lens STMaps', '  Nuke STMap node (UV = rgb): _undistort.exr flattens the plate for the pinhole camera, _redistort.exr puts the lens back on CG.');
  add('.json', 'JSON', '  Everything: cameras (matrices and Euler), lens with distortion, solve statistics, alignment and correspondences.');
  return `${name}
Camera track written by ${d.generator} at ${d.writtenAt}.
Solve ${d.solve.number}: RMS ${num(d.solve.rms, 3)} px over ${d.solve.frames} frames, confidence ${Math.round(d.solve.confidence * 100)} %.
Plate ${d.width} x ${d.height}, ${num(d.fps, 3)} fps, frames ${first}-${last}. Focal ${num(d.focalMm, 3)} mm on a ${num(d.filmBackMm.width, 3)} mm film back${d.nominalFilmBack ? ' (nominal: the camera was not known)' : ''}.${
    pixelAspectOfData(d) !== 1
      ? `
PIXEL ASPECT ${num(pixelAspectOfData(d), 4)}: the plate is kept squeezed (${d.width} x ${d.height} stored, ${Math.round(shownWidth(d))} x ${d.height} shown). The film back above is the
de-squeezed picture's${d.sensorFilmBackMm && Math.abs(d.sensorFilmBackMm.width - d.filmBackMm.width) > 1e-6 ? ` (the ${d.sensorFilmBackMm.width} mm sensor area x the squeeze)` : ''}; each file declares the pixel aspect in its application's terms:
Nuke format pixel_aspect, Maya lensSqueezeRatio + render pixel aspect, Blender pixel_aspect_x, After Effects comp pixel aspect, 3ds Max
renderPixelAspect, FBX FilmSqueezeRatio / PixelAspectRatio, Houdini aspect, Fusion AspectX, USD RenderSettings pixelAspectRatio.
Unreal and Unity render square pixels: their filmback is the de-squeezed picture. The STMaps are in squeezed plate pixels.`
      : ''
  }
Every camera here is the UNDISTORTED pinhole. Scene units: ${d.units}.

${[...new Set(sections)].join('\n\n')}

The report (${has('_report.html') ?? 'report.html'}) has the error graph, the worst tracks and the warnings.
`;
}

// ---------------------------------------------------------------------------
// Houdini and Fusion (addendum 06 §6.3)
// ---------------------------------------------------------------------------

/** Houdini: Y-up, right-handed, metres by default. Rotate order xyz = X then Y then Z (our 'XYZ'). */
export function houdiniKeys(d: CameraExportData): { frame: number; t: number[]; r: { x: number; y: number; z: number } }[] {
  const m = UNIT_M[d.units];
  const eu = eulerTrack(d.cameras.map((c) => c.rotation), 'XYZ');
  return d.cameras.map((c, i) => ({ frame: c.frame, t: c.position.map((v) => v * m), r: eu[i]! }));
}

export function writeHoudini(d: CameraExportData): string {
  const name = `${d.shot}_camtrack_v${String(d.version).padStart(3, '0')}`;
  const node = `${safeId(d.shot)}_cam`;
  const keys = houdiniKeys(d);
  const first = keys[0]?.frame ?? 1001;
  const last = keys[keys.length - 1]?.frame ?? first;
  const m = UNIT_M[d.units];
  const pts = d.points.map((p) => p.position.map((v) => v * m));
  const ch = (pick: (k: (typeof keys)[number]) => number, digits = 6) => pyList(keys.map(pick), digits);
  return `# ${name}: camera track for Houdini, written by ${d.generator} at ${d.writtenAt}
# Run from Windows > Python Source Editor (paste and Apply), or put it on a shelf tool.
# Creates /obj/${node} (cam: tx ty tz rx ry rz keyed per frame, rotate order xyz, transform order srt; focal ${num(d.focalMm, 3)} mm
# keyed per frame; aperture ${num(d.filmBackMm.width, 3)} mm; ${d.width} x ${d.height}) and /obj/${node}_tracks (the solved track points),
# and sets the scene to ${num(d.fps, 3)} fps, frames ${first}-${last} ($FSTART/$FEND).
# Coordinates: Houdini is Y-up, right-handed, metres (the default unit length): scene ${d.units} x ${num(m, 6)}.
# The camera is the UNDISTORTED pinhole. The .usda beside this file also loads in Solaris (LOPs > Sublayer / Reference).
import hou

NAME = ${JSON.stringify(node)}
FPS = ${num(d.fps, 6)}
FIRST, LAST = ${first}, ${last}
FRAMES = [${keys.map((k) => k.frame).join(', ')}]
TX = ${ch((k) => k.t[0]!)}
TY = ${ch((k) => k.t[1]!)}
TZ = ${ch((k) => k.t[2]!)}
RX = ${ch((k) => k.r.x)}
RY = ${ch((k) => k.r.y)}
RZ = ${ch((k) => k.r.z)}
FOCAL_MM = ${pyList(keys.map(() => d.focalMm))}
APERTURE_MM = ${num(d.filmBackMm.width, 6)}
RES = (${d.width}, ${d.height})
PIXEL_ASPECT = ${num(pixelAspectOfData(d), 6)}
WINDOW = (${num(d.principalOffsetPx.x / d.width, 7)}, ${num(-d.principalOffsetPx.y / d.height, 7)})
TRACKS = [${d.points.map((p, i) => `(${p.id}, ${pyList(pts[i]!, 6)}, ${num(p.error, 4)})`).join(', ')}]


def key(parm, values):
    for f, v in zip(FRAMES, values):
        k = hou.Keyframe()
        k.setFrame(f)
        k.setValue(v)
        k.setExpression('linear()', hou.exprLanguage.Hscript)
        parm.setKeyframe(k)


def main():
    hou.setFps(FPS)
    hou.playbar.setFrameRange(FIRST, LAST)
    hou.playbar.setPlaybackRange(FIRST, LAST)
    hou.setFrame(FIRST)
    obj = hou.node('/obj')
    old = obj.node(NAME)
    if old:
        old.destroy()
    cam = obj.createNode('cam', NAME)
    cam.parm('xOrd').set('srt')
    cam.parm('rOrd').set('xyz')
    for parm, values in (('tx', TX), ('ty', TY), ('tz', TZ), ('rx', RX), ('ry', RY), ('rz', RZ), ('focal', FOCAL_MM)):
        key(cam.parm(parm), values)
    cam.parm('focalunits').set('mm')
    cam.parm('aperture').set(APERTURE_MM)
    cam.parm('resx').set(RES[0])
    cam.parm('resy').set(RES[1])
    cam.parm('aspect').set(PIXEL_ASPECT)
    cam.parm('winx').set(WINDOW[0])
    cam.parm('winy').set(WINDOW[1])
    cam.parm('near').set(0.01)

    geo = obj.node(NAME + '_tracks')
    if geo:
        geo.destroy()
    geo = obj.createNode('geo', NAME + '_tracks')
    for child in geo.children():
        child.destroy()
    sop = geo.createNode('python', 'tracks')
    sop.parm('python').set('''node = hou.pwd()
g = node.geometry()
g.addAttrib(hou.attribType.Point, "id", 0)
g.addAttrib(hou.attribType.Point, "error_px", 0.0)
for track_id, p, err in %r:
    pt = g.createPoint()
    pt.setPosition(p)
    pt.setAttribValue("id", track_id)
    pt.setAttribValue("error_px", err)
''' % (TRACKS,))
    sop.setDisplayFlag(True)
    sop.setRenderFlag(True)
    cam.setCurrent(True, clear_all_selected=True)
    print('VC VFX: {} - {} keys, frames {}-{}'.format(NAME, len(FRAMES), FIRST, LAST))


main()
`;
}

/** Fusion: Y-up, right-handed, scene units; Transform3DOp.RotOrder XYZ = X then Y then Z (our 'XYZ'); aperture in inches. */
export function fusionKeys(d: CameraExportData): { frame: number; t: number[]; r: { x: number; y: number; z: number } }[] {
  const eu = eulerTrack(d.cameras.map((c) => c.rotation), 'XYZ');
  return d.cameras.map((c, i) => ({ frame: c.frame, t: [...c.position], r: eu[i]! }));
}

function fusionTools(d: CameraExportData): string {
  const tool = `${safeId(d.shot)}_camtrack_v${String(d.version).padStart(3, '0')}`.replace(/^(\d)/, 'Cam_$1');
  const keys = fusionKeys(d);
  const spline = (id: string, values: number[], color: [number, number, number]) => `\t\t${tool}${id} = BezierSpline {
\t\t\tSplineColor = { Red = ${color[0]}, Green = ${color[1]}, Blue = ${color[2]} },
\t\t\tNameSet = true,
\t\t\tKeyFrames = {
${keys.map((k, i) => `\t\t\t\t[${k.frame}] = { ${num(values[i]!, 6)}, Flags = { Linear = true } },`).join('\n')}
\t\t\t}
\t\t},`;
  const channels: [string, string, number[], [number, number, number]][] = [
    ['Transform3DOp.Translate.X', 'XOffset', keys.map((k) => k.t[0]!), [250, 59, 49]],
    ['Transform3DOp.Translate.Y', 'YOffset', keys.map((k) => k.t[1]!), [252, 206, 47]],
    ['Transform3DOp.Translate.Z', 'ZOffset', keys.map((k) => k.t[2]!), [254, 56, 46]],
    ['Transform3DOp.Rotate.X', 'XRotation', keys.map((k) => k.r.x), [255, 128, 128]],
    ['Transform3DOp.Rotate.Y', 'YRotation', keys.map((k) => k.r.y), [128, 255, 128]],
    ['Transform3DOp.Rotate.Z', 'ZRotation', keys.map((k) => k.r.z), [128, 128, 255]],
    ['PerspFocalLength', 'FocalLength', keys.map(() => d.focalMm), [234, 166, 64]],
  ];
  return `\t\t${tool} = Camera3D {
\t\t\tCtrlWZoom = false,
\t\t\tNameSet = true,
\t\t\tInputs = {
${channels.map(([input, id]) => `\t\t\t\t["${input}"] = Input { SourceOp = "${tool}${id}", Source = "Value", },`).join('\n')}
\t\t\t\t["Transform3DOp.RotOrder"] = Input { Value = FuID { "XYZ" }, },
\t\t\t\tFilmGate = Input { Value = FuID { "User" }, },
\t\t\t\tApertureW = Input { Value = ${num(d.filmBackMm.width / MM_PER_INCH, 6)}, },
\t\t\t\tApertureH = Input { Value = ${num(verticalAperture(d) / MM_PER_INCH, 6)}, },
\t\t\t\tResolutionGateFit = Input { Value = FuID { "Width" }, },
\t\t\t},
\t\t\tViewInfo = OperatorInfo { Pos = { 0, 0 } },
\t\t},
${channels.map(([, id, values, color]) => spline(id, values, color)).join('\n')}`;
}

/** A .setting: paste into the Fusion page (Ctrl+V in the Nodes view) or File > Import > Setting. */
export function writeFusionSetting(d: CameraExportData): string {
  const name = `${d.shot}_camtrack_v${String(d.version).padStart(3, '0')}`;
  const first = d.cameras[0]?.frame ?? 1001;
  const last = d.cameras[d.cameras.length - 1]?.frame ?? first;
  return `-- ${name}: Camera3D for Fusion / DaVinci Resolve (Fusion page), written by ${d.generator} at ${d.writtenAt}
-- Paste into the Nodes view, or drag this file onto it. Keys on frames ${first}-${last} at ${num(d.fps, 3)} fps: set the comp's
-- frame range and rate to match (or open the .comp beside this file in Fusion Studio, which sets them).
-- Fusion is Y-up, right-handed; positions in scene units (${d.units}); Transform3DOp.RotOrder XYZ (X, then Y, then Z);
-- aperture in inches (${num(d.filmBackMm.width, 3)} mm film back). Undistorted pinhole camera.
{
\tTools = ordered() {
${fusionTools(d)}
\t},
\tActiveTool = "${name.replace(/^(\d)/, 'Cam_$1')}"
}
`;
}

/** A Fusion Studio .comp: the same tools, with the comp's frame range, rate and frame size. */
export function writeFusionComp(d: CameraExportData): string {
  const name = `${d.shot}_camtrack_v${String(d.version).padStart(3, '0')}`;
  const first = d.cameras[0]?.frame ?? 1001;
  const last = d.cameras[d.cameras.length - 1]?.frame ?? first;
  return `-- ${name}: Fusion Studio composition written by ${d.generator} at ${d.writtenAt}
Composition {
\tCurrentTime = ${first},
\tRenderRange = { ${first}, ${last} },
\tGlobalRange = { ${first}, ${last} },
\tCurrentID = 1,
\tVersion = "Fusion Studio 18.0 build 0",
\tTools = ordered() {
${fusionTools(d)}
\t},
\tPrefs = {
\t\tComp = {
\t\t\tFrameFormat = {
\t\t\t\tName = "${name}",
\t\t\t\tWidth = ${d.width},
\t\t\t\tHeight = ${d.height},
\t\t\t\tAspectX = ${num(pixelAspectOfData(d), 6)},
\t\t\t\tAspectY = 1,
\t\t\t\tRate = ${num(d.fps, 6)},
\t\t\t},
\t\t},
\t},
}
`;
}
