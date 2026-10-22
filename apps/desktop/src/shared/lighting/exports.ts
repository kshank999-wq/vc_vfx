import { LIGHT_ROLE_LABELS, LIGHT_TYPE_LABELS, gamutMatrix, kelvinRgb, lightFieldText, rangeText, versionTag, type GamutId, type LightingDocument, type RigLight, type SceneUnit } from '@vcvfx/domain';
import { SCENE_TO_UNREAL, unrealRotator, usdLensValue } from '../camera/export-formats';
import { YUP_TO_ZUP } from '../camera/coords';
import { escapeHtml } from '../html';
import { cross, mulv, norm, scale, type V3 } from './geometry';
import { ROLE_COLOURS, diagramRadius, frameArrow, sidePoint, topPoint, wedgePath } from './diagram';
import { unrealAim, unrealLight, unrealPoint, type PlacedLight, type PlacedRig } from './place';

/**
 * The light-rig exports (master spec §13 "an editable scene/light rig that
 * can be exported or translated for Unreal Engine"; addendum 14 §5): the
 * Unreal 5 editor script and the data it reads, USD (UsdLux) with the camera,
 * a Blender script, the printable report and the README. Every writer takes
 * the same `PlacedRig`, in the camera track's scene and conventions.
 */

const num = (v: number, digits = 6) => {
  if (!Number.isFinite(v)) return '0';
  const s = v.toFixed(digits);
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') || '0' : s;
};
const UNIT_M: Record<SceneUnit, number> = { m: 1, cm: 0.01, mm: 0.001, ft: 0.3048, in: 0.0254 };
const safeId = (s: string) => s.replace(/[^A-Za-z0-9_]/g, '_');

export interface ExportNames {
  shot: string;
  version: number;
  generator: string;
  writtenAt: string;
  /** File names in the folder. */
  rigFile: string;
  hdriFile: string | null;
  frameFile: string | null;
}

/** The Unreal section of the rig file: what the script spawns, already in Unreal's axes and units. */
export function unrealSection(rig: PlacedRig, names: ExportNames) {
  const cam = rig.camera;
  const col = (j: number) => [cam.rotation[j]!, cam.rotation[3 + j]!, cam.rotation[6 + j]!];
  const camRot = unrealRotator(
    mulv(SCENE_TO_UNREAL, scale(col(2), -1)),
    mulv(SCENE_TO_UNREAL, col(0)),
    mulv(SCENE_TO_UNREAL, col(1)),
  );
  return {
    name: `${names.shot}_light_${versionTag(names.version)}`,
    exposure: { keyLux: rig.keyLux, ev100: rig.ev100 },
    camera: { location_cm: unrealPoint(cam.position, rig.units), rotation_pyr: [camRot.pitch, camRot.yaw, camRot.roll], focal_mm: cam.focalMm, sensor_mm: [cam.filmBackMm.width, cam.filmBackMm.height], source: cam.source, frame: cam.frame },
    subject_cm: unrealPoint(rig.subject, rig.units),
    hdri: names.hdriFile,
    lights: rig.lights.map((p) => {
      const u = unrealLight(p, rig.units);
      const at = p.position ?? rig.subject;
      const rot = unrealAim(p.direction);
      return {
        id: p.id,
        name: p.spec.name,
        role: p.spec.role,
        cls: u.cls,
        enabled: p.spec.enabled,
        location_cm: unrealPoint(at, rig.units),
        rotation_pyr: [rot.pitch, rot.yaw, rot.roll],
        intensity: u.intensity,
        unit: u.unit,
        temperature: p.spec.temperatureK,
        color: p.spec.temperatureK ? [1, 1, 1] : p.spec.rgb,
        source_radius_cm: u.sourceRadiusCm,
        source_width_cm: u.sourceWidthCm,
        source_height_cm: u.sourceHeightCm,
        source_angle_deg: u.sourceAngleDeg,
        cone_deg: u.coneDeg,
        attenuation_cm: p.position ? Math.max(1000, 4 * Math.hypot(...unrealPoint([p.position[0] - rig.subject[0], p.position[1] - rig.subject[1], p.position[2] - rig.subject[2]], rig.units))) : null,
      };
    }),
  };
}
export type UnrealSection = ReturnType<typeof unrealSection>;

const py = (v: unknown): string => {
  if (v === null || v === undefined) return 'None';
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (typeof v === 'number') return Number.isFinite(v) ? num(v, 6) : 'None';
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(py).join(', ')}]`;
  return `{${Object.entries(v as Record<string, unknown>)
    .map(([k, x]) => `${JSON.stringify(k)}: ${py(x)}`)
    .join(', ')}}`;
};

/** The Unreal 5 editor script: spawns the lights and the CineCameraActor from the rig file beside it (or its own copy). */
export function writeLightingUnreal(rig: PlacedRig, names: ExportNames): string {
  const u = unrealSection(rig, names);
  const cm = UNIT_M[rig.units] * 100;
  return `# ${u.name}: light rig for Unreal Engine 5.x, written by ${names.generator} at ${names.writtenAt}
# Run inside the Unreal Editor: Tools > Execute Python Script... (the Python Editor Script Plugin must be on).
# Spawns, in the outliner folder ${u.name}: ${u.lights.length} light${u.lights.length === 1 ? '' : 's'} (${u.lights.map((l) => `${l.id} ${l.cls}`).join(', ')}),
# and a CineCameraActor at the analysed frame ${u.camera.frame} (${u.camera.source === 'solve' ? 'from the camera track’s solve' : 'from the lens estimate, at the origin'}): focal ${num(u.camera.focal_mm, 3)} mm,
# filmback ${num(u.camera.sensor_mm[0]!, 3)} x ${num(u.camera.sensor_mm[1]!, 3)} mm.
#
# Coordinates: as the camera-track export. The scene is Y-up, right-handed, in ${rig.units}; Unreal is Z-up,
# left-handed, centimetres: Unreal X = scene -Z, Unreal Y = scene X, Unreal Z = scene Y, x ${num(cm, 4)} cm per ${rig.units}.
# Run the camera-track script for the same shot too: its camera and this rig line up.
#
# Units (addendum 14 §5): the exposure reference is the key's illuminance at the subject, KEY_LUX = ${num(rig.keyLux, 3)} lux
# (EV100 ${num(rig.ev100, 2)}). A light of "stops" gives KEY_LUX * 2^stops lux at the subject: a DirectionalLight gets that
# in lux; a Point, Spot or Rect light the candela I = lux * d^2 (d = its distance in metres); the SkyLight a scale relative
# to the key (x SKY_SCALE: Unreal's sky light has no absolute unit without a calibrated cubemap). Set the camera's
# exposure to EV100 ${num(rig.ev100, 2)} (manual) to see the plate's exposure; or change KEY_LUX and run again.
# Every figure is an estimate with a range: see ${names.rigFile}. Reposition and tune freely.
import json
import os
import unreal

NAME = ${JSON.stringify(u.name)}
RIG_FILE = ${JSON.stringify(names.rigFile)}
HDRI_FILE = ${py(names.hdriFile)}
PACKAGE = '/Game/VCVFX'
KEY_LUX = ${num(rig.keyLux, 4)}
SKY_SCALE = 1.0
SPAWN_CAMERA = True

# The same data as the rig file's "unreal" section, for when the script runs away from it.
EMBEDDED = ${py(u)}


def load():
    try:
        here = os.path.dirname(os.path.abspath(__file__))
        with open(os.path.join(here, RIG_FILE), 'r') as f:
            return json.load(f)['unreal'], here
    except Exception as error:
        unreal.log_warning('VC VFX: {} not read ({}); using the copy in this script'.format(RIG_FILE, error))
        return EMBEDDED, None


def _set(obj, prop, value):
    try:
        obj.set_editor_property(prop, value)
        return True
    except Exception as error:
        unreal.log_warning('VC VFX: {} not set ({})'.format(prop, error))
        return False


ACTORS = {
    'DirectionalLight': (unreal.DirectionalLight, unreal.DirectionalLightComponent),
    'PointLight': (unreal.PointLight, unreal.PointLightComponent),
    'SpotLight': (unreal.SpotLight, unreal.SpotLightComponent),
    'RectLight': (unreal.RectLight, unreal.RectLightComponent),
    'SkyLight': (unreal.SkyLight, unreal.SkyLightComponent),
}


def spawn_light(actors, light, scale_lux, hdri_cube):
    actor_class, component_class = ACTORS[light['cls']]
    pitch, yaw, roll = light['rotation_pyr']
    actor = actors.spawn_actor_from_class(actor_class, unreal.Vector(*light['location_cm']), unreal.Rotator(roll, pitch, yaw))
    actor.set_actor_label('{}_{}'.format(NAME, light['id']))
    actor.set_folder_path(NAME)
    comp = actor.get_component_by_class(component_class)
    if light['cls'] == 'SkyLight':
        comp.set_intensity(light['intensity'] * SKY_SCALE)
        if hdri_cube is not None:
            _set(comp, 'source_type', unreal.SkyLightSourceType.SLS_SPECIFIED_CUBEMAP)
            _set(comp, 'cubemap', hdri_cube)
        else:
            _set(comp, 'source_type', unreal.SkyLightSourceType.SLS_CAPTURED_SCENE)
    else:
        if light['unit'] == 'cd':
            _set(comp, 'intensity_units', unreal.LightUnits.CANDELAS)
        comp.set_intensity(light['intensity'] * scale_lux)
        r, g, b = light['color']
        comp.set_light_color(unreal.LinearColor(r, g, b, 1.0), False)
        if light['temperature']:
            _set(comp, 'use_temperature', True)
            comp.set_temperature(light['temperature'])
        if light['source_radius_cm'] is not None:
            _set(comp, 'source_radius', light['source_radius_cm'])
            _set(comp, 'soft_source_radius', light['source_radius_cm'])
        if light['source_width_cm'] is not None:
            _set(comp, 'source_width', light['source_width_cm'])
            _set(comp, 'source_height', light['source_height_cm'])
        if light['source_angle_deg'] is not None:
            _set(comp, 'light_source_angle', light['source_angle_deg'])
        if light['cone_deg'] is not None:
            _set(comp, 'outer_cone_angle', light['cone_deg'])
            _set(comp, 'inner_cone_angle', light['cone_deg'] * 0.7)
        if light['attenuation_cm'] is not None:
            _set(comp, 'attenuation_radius', light['attenuation_cm'])
    if not light['enabled']:
        comp.set_visibility(False)
    return actor


def import_hdri(folder):
    if not HDRI_FILE or folder is None:
        return None
    try:
        task = unreal.AssetImportTask()
        task.filename = os.path.join(folder, HDRI_FILE)
        task.destination_path = PACKAGE
        task.automated = True
        task.save = True
        unreal.AssetToolsHelpers.get_asset_tools().import_asset_tasks([task])
        paths = task.get_editor_property('imported_object_paths')
        asset = unreal.EditorAssetLibrary.load_asset(paths[0]) if paths else None
        if asset is not None and not isinstance(asset, unreal.TextureCube):
            unreal.log_warning('VC VFX: {} imported as a 2D texture; set it to a LongLat cubemap and assign it to the sky light'.format(HDRI_FILE))
            return None
        return asset
    except Exception as error:
        unreal.log_warning('VC VFX: the HDRI was not imported ({})'.format(error))
        return None


def spawn_camera(actors, cam):
    pitch, yaw, roll = cam['rotation_pyr']
    actor = actors.spawn_actor_from_class(unreal.CineCameraActor, unreal.Vector(*cam['location_cm']), unreal.Rotator(roll, pitch, yaw))
    actor.set_actor_label('{}_camera'.format(NAME))
    actor.set_folder_path(NAME)
    comp = actor.get_cine_camera_component()
    filmback = comp.get_editor_property('filmback')
    filmback.set_editor_property('sensor_width', cam['sensor_mm'][0])
    filmback.set_editor_property('sensor_height', cam['sensor_mm'][1])
    comp.set_editor_property('filmback', filmback)
    lens = comp.get_editor_property('lens_settings')
    lens.set_editor_property('min_focal_length', min(4.0, cam['focal_mm']))
    lens.set_editor_property('max_focal_length', max(1000.0, cam['focal_mm']))
    comp.set_editor_property('lens_settings', lens)
    comp.set_editor_property('current_focal_length', cam['focal_mm'])
    return actor


def main():
    rig, folder = load()
    actors = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
    scale_lux = KEY_LUX / rig['exposure']['keyLux']
    cube = import_hdri(folder)
    for light in rig['lights']:
        spawn_light(actors, light, scale_lux, cube)
    if SPAWN_CAMERA:
        spawn_camera(actors, rig['camera'])
    unreal.log('VC VFX: {} - {} lights, key {} lux (EV100 {:.2f})'.format(NAME, len(rig['lights']), KEY_LUX, rig['exposure']['ev100']))


main()
`;
}

/** A light's frame for USD: rows are its axes in the stage, the light emitting along its −Z. */
function lightMatrix(p: PlacedLight, at: V3, zup: boolean): string {
  const z = norm(scale(p.direction, -1));
  const up: V3 = Math.abs(z[1]) > 0.99 ? [1, 0, 0] : [0, 1, 0];
  const x = norm(cross(up, z));
  const y = cross(z, x);
  const t = (v: V3): V3 => (zup ? (mulv(YUP_TO_ZUP, v) as V3) : v);
  const row = (v: V3, w: number) => `(${t(v)
    .map((c) => num(c, 8))
    .join(', ')}, ${w})`;
  return `( ${row(x, 0)}, ${row(y, 0)}, ${row(z, 0)}, ${row(at, 1)} )`;
}

/** USD (.usda): UsdLux lights and the camera, in the camera track's stage conventions. */
export function writeLightingUsda(rig: PlacedRig, names: ExportNames): string {
  const name = `${names.shot}_light_${versionTag(names.version)}`;
  const id = `VCVFX_${safeId(name)}`;
  const mpu = UNIT_M[rig.units];
  const zup = rig.upAxis === 'z';
  const cam = rig.camera;
  const lens = (mm: number) => num(usdLensValue(mm, mpu), 6);
  const R = zup ? mulv3x3(YUP_TO_ZUP, cam.rotation) : cam.rotation;
  const cp = zup ? (mulv(YUP_TO_ZUP, cam.position) as V3) : cam.position;
  const crow = (j: number) => `(${num(R[j]!, 8)}, ${num(R[3 + j]!, 8)}, ${num(R[6 + j]!, 8)}, 0)`;
  const prim = (p: PlacedLight) => {
    const s = p.spec;
    const at = p.position ?? scale(p.direction, -10 / mpu);
    const kind = s.type === 'dome' ? 'DomeLight' : s.type === 'directional' ? 'DistantLight' : s.type === 'rect' ? 'RectLight' : 'SphereLight';
    const lines = [
      `float inputs:intensity = ${num(2 ** s.intensityStops, 6)}`,
      'float inputs:exposure = 0',
      s.temperatureK ? 'color3f inputs:color = (1, 1, 1)' : `color3f inputs:color = (${s.rgb.map((c) => num(c, 5)).join(', ')})`,
      `bool inputs:enableColorTemperature = ${s.temperatureK ? 1 : 0}`,
      `float inputs:colorTemperature = ${num(s.temperatureK ?? 6500, 1)}`,
    ];
    if (kind === 'RectLight') lines.push(`float inputs:width = ${num(p.sourceSize ?? 0.1, 6)}`, `float inputs:height = ${num(p.sourceSize ?? 0.1, 6)}`);
    if (kind === 'SphereLight') lines.push(`float inputs:radius = ${num(Math.max(1e-4, p.sourceSize ?? 0), 6)}`, ...(s.type === 'spot' && p.coneDeg ? [`float inputs:shaping:cone:angle = ${num(p.coneDeg, 3)}`, 'float inputs:shaping:cone:softness = 0.3'] : []));
    if (kind === 'DistantLight') lines.push(`float inputs:angle = ${num(p.sourceSize ?? 0.53, 4)}`);
    if (kind === 'DomeLight' && names.hdriFile) lines.push(`asset inputs:texture:file = @${names.hdriFile}@`, 'token inputs:texture:format = "latlong"');
    const custom = [`string role = "${s.role}"`, `double stops = ${num(s.intensityStops, 4)}`, `double lux = ${num(p.lux, 3)}`, ...(p.candela !== null ? [`double candela = ${num(p.candela, 3)}`] : []), `bool enabled = ${s.enabled ? 1 : 0}`];
    return `        def ${kind} "${safeId(p.id)}" (
            customData = {
                ${custom.join('\n                ')}
            }
            doc = "${s.name.replace(/"/g, "'")}: ${LIGHT_ROLE_LABELS[s.role]} ${LIGHT_TYPE_LABELS[s.type]}"
        )
        {
            ${lines.join('\n            ')}
            ${s.enabled ? '' : 'token visibility = "invisible"\n            '}matrix4d xformOp:transform = ${lightMatrix(p, at as V3, zup)}
            uniform token[] xformOpOrder = ["xformOp:transform"]
        }`;
  };
  const sub = zup ? mulv(YUP_TO_ZUP, rig.subject) : rig.subject;
  return `#usda 1.0
(
    defaultPrim = "${id}"
    doc = """${name}: light rig written by ${names.generator} at ${names.writtenAt}. Lights estimated from the plate (ranges in ${names.rigFile}) and tuned by the artist; the camera at the analysed frame ${cam.frame} (${cam.source === 'solve' ? 'camera track' : 'lens estimate'}). UsdLux intensity is relative: the key is 1; customData carries lux and candela at the exposure reference ${num(rig.keyLux, 2)} lux."""
    upAxis = "${zup ? 'Z' : 'Y'}"
    metersPerUnit = ${num(mpu, 6)}
)

def Xform "${id}" (
    kind = "assembly"
)
{
    def Camera "camera" (
        customData = {
            string generator = "${names.generator}"
            int frame = ${cam.frame}
            string source = "${cam.source}"
        }
    )
    {
        token projection = "perspective"
        float focalLength = ${lens(cam.focalMm)}
        float horizontalAperture = ${lens(cam.filmBackMm.width)}
        float verticalAperture = ${lens(cam.filmBackMm.height)}
        float2 clippingRange = (${num(0.01 / mpu, 6)}, ${num(100000 / mpu, 3)})
        matrix4d xformOp:transform = ( ${crow(0)}, ${crow(1)}, ${crow(2)}, (${cp.map((v) => num(v, 6)).join(', ')}, 1) )
        uniform token[] xformOpOrder = ["xformOp:transform"]
    }

    def Sphere "subject" (
        doc = "Where the lights were estimated around: the subject's centre."
    )
    {
        double radius = ${num(0.05 / mpu, 6)}
        double3 xformOp:translate = (${sub.map((v) => num(v, 6)).join(', ')})
        uniform token[] xformOpOrder = ["xformOp:translate"]
        color3f[] primvars:displayColor = [(1, 0.7, 0.3)]
    }

    def Xform "lights"
    {
${rig.lights.map(prim).join('\n\n')}
    }
}
`;
}

function mulv3x3(a: readonly number[], b: readonly number[]): number[] {
  const o = new Array<number>(9);
  for (let i = 0; i < 3; i += 1) for (let j = 0; j < 3; j += 1) o[3 * i + j] = a[3 * i]! * b[j]! + a[3 * i + 1]! * b[3 + j]! + a[3 * i + 2]! * b[6 + j]!;
  return o;
}

/** Blender (bpy): the lights with physical units and the camera, Z-up metres (as the camera-track export). */
export function writeLightingBlender(rig: PlacedRig, names: ExportNames, gamut: GamutId): string {
  const name = `${names.shot}_light_${versionTag(names.version)}`;
  const toM = UNIT_M[rig.units];
  const z = (v: readonly number[]) => mulv(YUP_TO_ZUP, v).map((c) => c * toM);
  const toRec709 = gamutMatrix(gamut, 'rec709');
  const colour = (l: PlacedLight) => {
    if (l.spec.temperatureK) return kelvinRgb(l.spec.temperatureK, 'rec709');
    const c = mulv(toRec709 as unknown as number[], l.spec.rgb);
    const k = Math.max(c[0], c[1], c[2], 1e-9);
    return c.map((v) => Math.max(0, v / k));
  };
  const lights = rig.lights
    .filter((l) => l.spec.type !== 'dome')
    .map((l) => {
      const s = l.spec;
      // Blender's units: sun strength in W/m² (683 lm/W), point/spot power in W radiated all round, area power one-sided.
      const kind = s.type === 'directional' ? 'SUN' : s.type === 'rect' ? 'AREA' : s.type === 'spot' ? 'SPOT' : 'POINT';
      const energy = kind === 'SUN' ? l.lux / 683 : kind === 'AREA' ? ((l.candela ?? 0) * Math.PI) / 683 : ((l.candela ?? 0) * 4 * Math.PI) / 683;
      const at = l.position ?? [rig.subject[0] - l.direction[0] * 10 / toM, rig.subject[1] - l.direction[1] * 10 / toM, rig.subject[2] - l.direction[2] * 10 / toM];
      return { id: l.id, name: `${name}_${l.id}`, kind, energy, color: colour(l), location: z(at), direction: mulv(YUP_TO_ZUP, l.direction), size: kind === 'SUN' ? ((l.sourceSize ?? 0.5) * Math.PI) / 180 : (l.sourceSize ?? 0.05) * toM, spot: l.coneDeg ? (2 * l.coneDeg * Math.PI) / 180 : null, enabled: s.enabled };
    });
  const dome = rig.lights.find((l) => l.spec.type === 'dome');
  const cam = rig.camera;
  const R = mulv3x3(YUP_TO_ZUP, cam.rotation);
  const cp = z(cam.position);
  const matrix = `((${num(R[0]!, 8)}, ${num(R[1]!, 8)}, ${num(R[2]!, 8)}, ${num(cp[0]!, 6)}), (${num(R[3]!, 8)}, ${num(R[4]!, 8)}, ${num(R[5]!, 8)}, ${num(cp[1]!, 6)}), (${num(R[6]!, 8)}, ${num(R[7]!, 8)}, ${num(R[8]!, 8)}, ${num(cp[2]!, 6)}), (0, 0, 0, 1))`;
  return `# ${name}: light rig for Blender, written by ${names.generator} at ${names.writtenAt}
# Run in Blender (Scripting workspace, or blender --python this.py). Blender is Z-up, metres; the camera
# matches the camera-track export's. Units: a sun's strength is the illuminance in W/m2 (lux / 683); a point or
# spot light's power the candela x 4pi / 683 W; an area light's the candela x pi / 683 W (exposure reference
# ${num(rig.keyLux, 2)} lux at the subject: set the view's exposure to taste). Colours are Rec.709 linear.
import bpy
from mathutils import Matrix, Vector

LIGHTS = ${py(lights)}
WORLD = ${dome ? py({ strength: dome.lux / (683 * Math.PI), color: colour(dome), hdri: names.hdriFile }) : 'None'}

scene = bpy.context.scene
collection = bpy.data.collections.new(${JSON.stringify(name)})
scene.collection.children.link(collection)
for L in LIGHTS:
    data = bpy.data.lights.new(L['name'], L['kind'])
    data.energy = L['energy']
    data.color = L['color']
    if L['kind'] == 'SUN':
        data.angle = L['size']
    elif L['kind'] == 'AREA':
        data.shape = 'SQUARE'
        data.size = max(0.001, L['size'])
    else:
        data.shadow_soft_size = max(0.0, L['size'])
    if L['kind'] == 'SPOT' and L['spot']:
        data.spot_size = L['spot']
        data.spot_blend = 0.3
    obj = bpy.data.objects.new(L['name'], data)
    collection.objects.link(obj)
    obj.location = L['location']
    obj.rotation_mode = 'QUATERNION'
    obj.rotation_quaternion = Vector(L['direction']).to_track_quat('-Z', 'Y')
    obj.hide_render = not L['enabled']
    obj.hide_viewport = not L['enabled']

cam_data = bpy.data.cameras.new(${JSON.stringify(`${name}_camera`)})
cam_data.lens = ${num(cam.focalMm, 5)}
cam_data.sensor_fit = 'HORIZONTAL'
cam_data.sensor_width = ${num(cam.filmBackMm.width, 5)}
cam_data.sensor_height = ${num(cam.filmBackMm.height, 5)}
cam = bpy.data.objects.new(${JSON.stringify(`${name}_camera`)}, cam_data)
collection.objects.link(cam)
cam.matrix_world = Matrix(${matrix})
scene.camera = cam
scene.render.resolution_x = ${cam.width}
scene.render.resolution_y = ${cam.height}

if WORLD is not None:
    world = scene.world or bpy.data.worlds.new('World')
    scene.world = world
    world.use_nodes = True
    background = world.node_tree.nodes.get('Background')
    if background is not None:
        background.inputs[0].default_value = (WORLD['color'][0], WORLD['color'][1], WORLD['color'][2], 1.0)
        background.inputs[1].default_value = WORLD['strength']
`;
}

export interface ReportInput {
  doc: LightingDocument;
  rig: PlacedRig;
  lights: RigLight[];
  names: ExportNames;
  approval: { by: string; at: string } | null;
  state: string;
  /** The analysed frame as a PNG data URL (8-bit sRGB view) and its size, or null. */
  frame: { dataUrl: string; width: number; height: number } | null;
  tilt: { pitchDeg: number; rollDeg: number };
}

/** The printable lighting report: the frame with the lights' directions and cones, the rig from above and the side, the lens. */
export function writeLightingReport(r: ReportInput): string {
  const { doc, lights, names } = r;
  const a = doc.analysis;
  const title = `${names.shot} light rig ${versionTag(names.version)}`;
  const e = escapeHtml;
  const frame = (() => {
    if (!r.frame) return '<p class="muted">No frame was analysed (the rig was placed by hand).</p>';
    const W = r.frame.width;
    const H = r.frame.height;
    const c = a?.subject.centre ?? { x: 0.5, y: 0.5 };
    const centre = { x: c.x * W, y: c.y * H };
    const len = 0.28 * Math.min(W, H) * 1.6;
    const svg = lights
      .filter((l) => l.spec.type !== 'dome')
      .map((l) => {
        const arrow = frameArrow(l.spec, l.estimate ? { azimuth: l.estimate.azimuth, elevation: l.estimate.elevation } : null, centre, len, r.tilt);
        const col = ROLE_COLOURS[l.spec.role];
        const cone = arrow.cone.length ? `<polygon points="${arrow.cone.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}" fill="${col}" fill-opacity="0.16" stroke="${col}" stroke-opacity="0.5" stroke-width="1"/>` : '';
        return `${cone}<line x1="${centre.x.toFixed(1)}" y1="${centre.y.toFixed(1)}" x2="${arrow.tip.x.toFixed(1)}" y2="${arrow.tip.y.toFixed(1)}" stroke="${col}" stroke-width="3" ${arrow.behind ? 'stroke-dasharray="7 5"' : ''}/><circle cx="${arrow.tip.x.toFixed(1)}" cy="${arrow.tip.y.toFixed(1)}" r="6" fill="${col}"/><text x="${(arrow.tip.x + 9).toFixed(1)}" y="${(arrow.tip.y + 4).toFixed(1)}" fill="#fff" stroke="#000" stroke-width="3" paint-order="stroke" font-size="15">${e(l.spec.name)}</text>`;
      })
      .join('');
    const marks = (a?.marks ?? [])
      .map((m) => {
        const x = m.x * W;
        const y = m.y * H;
        if (m.kind === 'shadow' && m.x2 !== null && m.y2 !== null) return `<line x1="${x.toFixed(1)}" y1="${y.toFixed(1)}" x2="${(m.x2 * W).toFixed(1)}" y2="${(m.y2 * H).toFixed(1)}" stroke="#222" stroke-width="3" stroke-dasharray="4 4"/>`;
        if (m.kind === 'practical' || m.kind === 'highlight' || m.kind === 'catchlight') return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${Math.max(7, (m.r ?? 0) * W * 1.8).toFixed(1)}" fill="none" stroke="#ff7a45" stroke-width="2.5"/>`;
        if (m.kind === 'ball') return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${((m.r ?? 0) * W).toFixed(1)}" fill="none" stroke="#fff" stroke-width="2"/>`;
        return '';
      })
      .join('');
    return `<figure class="frame"><div class="frame-box"><img src="${r.frame.dataUrl}" alt="The analysed frame"/><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${marks}${svg}</svg></div><figcaption>Frame ${a?.frame ?? '—'}: each light’s direction from the subject (dashed: behind it), inside the cone of its range; practicals ringed, shadows dashed. View: ${e('sRGB, for viewing')}.</figcaption></figure>`;
  })();
  const S = 300;
  const C = { x: S / 2, y: S / 2 };
  const inner = 34;
  const outer = 128;
  const top = lights
    .map((l) => {
      const col = ROLE_COLOURS[l.spec.role];
      if (l.spec.type === 'dome') return '';
      const rr = diagramRadius(l.spec.distanceM, inner, outer);
      const p = topPoint(l.spec.azimuthDeg, rr, C);
      const w = l.estimate ? `<path d="${wedgePath(l.estimate.azimuth.low, l.estimate.azimuth.high, inner, outer, C)}" fill="${col}" fill-opacity="0.13" stroke="${col}" stroke-opacity="0.45"/>` : '';
      return `${w}<line x1="${C.x}" y1="${C.y}" x2="${p.x.toFixed(1)}" y2="${p.y.toFixed(1)}" stroke="${col}" stroke-width="1.5"/><circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="7" fill="${col}"/><text x="${(p.x + 9).toFixed(1)}" y="${(p.y + 4).toFixed(1)}" font-size="11">${e(l.spec.name)}</text>`;
    })
    .join('');
  const side = lights
    .map((l) => {
      const col = ROLE_COLOURS[l.spec.role];
      if (l.spec.type === 'dome') return '';
      const rr = diagramRadius(l.spec.distanceM, inner, outer);
      const p = sidePoint(l.spec.azimuthDeg, l.spec.elevationDeg, rr, { x: C.x, y: S * 0.72 });
      const arc = l.estimate ? `<path d="${wedgePath(l.estimate.elevation.low, l.estimate.elevation.high, inner, outer, { x: C.x, y: S * 0.72 }, (el, rad, c) => sidePoint(l.spec.azimuthDeg, el, rad, c))}" fill="${col}" fill-opacity="0.13" stroke="${col}" stroke-opacity="0.45"/>` : '';
      return `${arc}<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="7" fill="${col}"/><text x="${(p.x + 9).toFixed(1)}" y="${(p.y + 4).toFixed(1)}" font-size="11">${e(l.spec.name)}</text>`;
    })
    .join('');
  const diagrams = `<div class="diagrams"><figure><svg viewBox="0 0 ${S} ${S}" class="diagram"><circle cx="${C.x}" cy="${C.y}" r="${outer}" class="ring"/><circle cx="${C.x}" cy="${C.y}" r="${inner}" class="ring"/>${top}<circle cx="${C.x}" cy="${C.y}" r="10" class="subject"/><rect x="${C.x - 9}" y="${S - 22}" width="18" height="12" class="camera"/><text x="${C.x + 14}" y="${S - 12}" font-size="11">camera</text></svg><figcaption>From above: the camera below, frame right to the right; wedges are the azimuth ranges; distance on a log scale (the outer ring: far or unknown).</figcaption></figure><figure><svg viewBox="0 0 ${S} ${S}" class="diagram"><line x1="10" y1="${S * 0.72}" x2="${S - 10}" y2="${S * 0.72}" class="ring"/>${side}<circle cx="${C.x}" cy="${S * 0.72}" r="10" class="subject"/><text x="${S - 70}" y="${S * 0.72 + 16}" font-size="11">front</text><text x="12" y="${S * 0.72 + 16}" font-size="11">behind</text></svg><figcaption>From the side: elevation from the subject’s horizon; arcs are the elevation ranges.</figcaption></figure></div>`;
  const row = (l: RigLight) => {
    const s = l.spec;
    const est = l.estimate;
    const lock = (f: string) => (l.locked.includes(f as never) ? ' <span class="lock" title="The artist’s value">●</span>' : '');
    const val = (f: Parameters<typeof lightFieldText>[0], range: string) => `${lightFieldText(f, s[f])}${lock(f)}${est && !l.locked.includes(f) ? `<br><span class="muted">${range}</span>` : ''}`;
    const placed = r.rig.lights.find((p) => p.id === l.id);
    return `<tr><td><span class="swatch" style="background:${ROLE_COLOURS[s.role]}"></span>${e(s.name)}<br><span class="muted">${LIGHT_ROLE_LABELS[s.role]} · ${LIGHT_TYPE_LABELS[s.type]}${s.enabled ? '' : ' · off'}</span></td><td>${val('azimuthDeg', est ? rangeText(est.azimuth, '°') : '')}</td><td>${val('elevationDeg', est ? rangeText(est.elevation, '°') : '')}</td><td>${val('distanceM', est?.distance ? rangeText(est.distance, ' m', 1) : '')}</td><td>${val('intensityStops', est ? rangeText(est.intensity, ' st', 1) : '')}${placed ? `<br><span class="muted">${num(placed.lux, 0)} lux${placed.candela !== null ? ` · ${num(placed.candela, 0)} cd` : ''}</span>` : ''}</td><td>${val('sizeDeg', est?.size ? rangeText(est.size, '°', 1) : '')}</td><td>${val('temperatureK', est?.temperature ? rangeText(est.temperature, ' K') : '')}</td><td>${e((est?.evidence ?? ['artist']).join(', '))}${est ? `<br><span class="muted">confidence ${Math.round(est.confidence * 100)} %</span>` : ''}</td></tr>`;
  };
  const lensRows = (() => {
    const L = a?.lens;
    if (!L) return '<p class="muted">No analysis: the lens is the artist’s.</p>';
    return `<table class="kv"><tr><th>Focal length</th><td>${L.focalMm ? rangeText(L.focalMm, ' mm', 1) : 'unknown'} · from ${e(L.focalSource)}${doc.lens.focalMm ? ` · <strong>the artist’s ${num(doc.lens.focalMm, 2)} mm used</strong>` : ''}</td></tr>${L.checks.map((c) => `<tr><th>Cross-check</th><td>${e(c.note)}</td></tr>`).join('')}<tr><th>Film back</th><td>${L.filmBackMm ? `${num(L.filmBackMm.width, 2)} × ${num(L.filmBackMm.height, 2)} mm` : '—'} · ${e(L.filmBackSource)}</td></tr><tr><th>Field of view</th><td>${L.hfovDeg ? `${rangeText(L.hfovDeg, '°', 1)} horizontal` : '—'}${L.vfovDeg ? ` · ${rangeText(L.vfovDeg, '°', 1)} vertical` : ''}</td></tr><tr><th>Distortion</th><td>${L.distortion.k1 !== null ? `k1 ${num(L.distortion.k1, 4)} · ` : ''}${e(L.distortion.note)}</td></tr><tr><th>Aperture</th><td>${L.aperture.fStop ? `f/${rangeText(L.aperture.fStop, '', 1)} · ` : ''}${e(L.aperture.note)}</td></tr><tr><th>Lines / vanishing points</th><td>${L.lines} / ${L.vanishingPoints}</td></tr></table>`;
  })();
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${e(title)}</title>
<style>
body{font:14px/1.45 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1c1f24;margin:28px;max-width:1100px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:26px 0 8px;border-bottom:1px solid #ddd;padding-bottom:4px}
.muted{color:#6b7280;font-size:12px}.frame-box{position:relative;display:inline-block;max-width:100%}.frame-box img{display:block;max-width:100%}
.frame-box svg{position:absolute;inset:0;width:100%;height:100%}figure{margin:0}figcaption{font-size:12px;color:#555;margin-top:4px;max-width:700px}
.diagrams{display:flex;gap:24px;flex-wrap:wrap}.diagram{width:300px;height:300px;background:#fafafa;border:1px solid #e5e7eb;border-radius:6px}
.ring{fill:none;stroke:#cbd5e1;stroke-dasharray:3 4}.subject{fill:#f59e0b}.camera{fill:#475569}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{border-bottom:1px solid #e5e7eb;padding:6px 8px;text-align:left;vertical-align:top}
.swatch{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px}.kv th{width:190px;color:#374151}.lock{color:#b45309}
.warn{background:#fff7ed;border:1px solid #fed7aa;padding:8px 10px;border-radius:6px;margin:4px 0}
@media print{body{margin:12mm}h2{break-after:avoid}.diagrams,figure,table{break-inside:avoid}}
</style></head><body>
<h1>${e(title)}</h1>
<p class="muted">${e(names.generator)} · written ${e(names.writtenAt)} · ${e(r.state)}${r.approval ? ` · approved by ${e(r.approval.by)}` : ' · not approved yet: a prep deliverable for review'}${a ? ` · ${e(a.algorithm)}, settings r${a.revision}` : ''} · rig r${doc.editRevision}</p>
<p>Estimates from the plate${doc.references.length ? ` and ${doc.references.map((x) => e(x.name)).join(', ')}` : ''}: every figure with the range it is believed to lie in. Fields marked <span class="lock">●</span> are the artist’s. Not measured on set.</p>
<h2>The frame</h2>${frame}
<h2>The rig</h2>${diagrams}
<table><thead><tr><th>Light</th><th>Azimuth</th><th>Elevation</th><th>Distance</th><th>Intensity</th><th>Size</th><th>Colour</th><th>Evidence</th></tr></thead><tbody>${lights.map(row).join('')}</tbody></table>
<p class="muted">Exposure reference: the key gives ${num(r.rig.keyLux, 1)} lux at the subject (EV100 ${num(r.rig.ev100, 2)}). Camera: ${r.rig.camera.source === 'solve' ? 'the camera track’s solve at the analysed frame' : 'the lens estimate, level at the origin'}; scene ${e(r.rig.units)}, ${r.rig.upAxis.toUpperCase()}-up.</p>
<h2>Lens and camera</h2>${lensRows}
${a?.warnings.length ? `<h2>Notes</h2>${a.warnings.map((w) => `<div class="warn">${e(w)}</div>`).join('')}` : ''}
${doc.reviews.length ? `<h2>AI reviews</h2>${doc.reviews.map((rv) => `<p><strong>${e(rv.model)}</strong> (${e(rv.promptVersion)}, ${e(rv.at)}): ${e(rv.summary)}</p><ul>${rv.suggestions.map((s) => `<li>${e(s.kind)} ${e(s.lightId ?? '')}: ${e(s.reason)} — <em>${e(s.decision)}${s.by ? ` by ${e(s.by)}` : ''}</em></li>`).join('')}</ul>`).join('')}` : ''}
</body></html>
`;
}

/** The folder's README. */
export function writeLightingReadme(r: { names: ExportNames; files: string[]; rig: PlacedRig; approved: boolean; lights: number }): string {
  const v = versionTag(r.names.version);
  const has = (suffix: string) => r.files.find((f) => f.endsWith(suffix));
  return [
    `${r.names.shot} light rig ${v} — ${r.names.generator}`,
    '',
    'What is here',
    has('_unreal.py') ? `  ${has('_unreal.py')}   Unreal Engine 5: run it in the editor (Tools > Execute Python Script). It reads ${r.names.rigFile}` : null,
    has('_unreal.py') ? '      beside it and spawns the lights (Directional / Point / Spot / Rect / Sky) and a CineCameraActor.' : null,
    `  ${r.names.rigFile}   the rig: every light with its estimate, range and evidence, the artist's values, the scene`,
    '      placement, physical intensities, the lens estimate, the analysis notes; and the Unreal section the script reads.',
    has('.usda') ? `  ${has('.usda')}   USD (UsdLux): the lights and the camera; open in usdview, Houdini Solaris, Maya, Omniverse.` : null,
    has('_blender.py') ? `  ${has('_blender.py')}   Blender: run it (Scripting workspace) for the lights and the camera.` : null,
    has('_report.html') ? `  ${has('_report.html')}   the report to read and print: the frame with the lights, the rig from above and the side, the lens.` : null,
    has('_frame.png') ? `  ${has('_frame.png')}   the analysed frame (sRGB, for viewing).` : null,
    r.names.hdriFile ? `  ${r.names.hdriFile}   the HDRI (a copy of the reference, read only at the source).` : null,
    '',
    'Coordinates and units',
    `  The camera track's scene: ${r.rig.upAxis.toUpperCase()}-up, ${r.rig.units}; the camera at the analysed frame ${r.rig.camera.frame} (${r.rig.camera.source === 'solve' ? 'the camera track' : 'the lens estimate, level, at the origin'}).`,
    `  Intensities: the key gives ${num(r.rig.keyLux, 1)} lux at the subject (EV100 ${num(r.rig.ev100, 2)}); a light of n stops gives that x 2^n lux there;`,
    '  positional lights carry candela = lux x distance^2 (metres). Directions: azimuth from the camera side (+90 = frame right),',
    '  elevation from the horizon; ranges are what each estimate is believed to lie in.',
    '',
    'How it was made',
    '  From the plate: the subject\'s shading on normals inflated from its matte (contour exact), fitted with soft sources',
    '  (a convex decomposition, then refined, ranges by bootstrap); cast shadows on the ground (direction, length, penumbra);',
    '  practicals as bright blobs; chrome / grey balls and an HDRI where given (the strongest evidence); the lens from the',
    '  camera track or the metadata, cross-checked against vanishing points. The source media were only read.',
    '',
    `${r.lights} light${r.lights === 1 ? '' : 's'}.`,
    r.approved ? `This rig (${v}) is approved.` : `This rig (${v}) is not approved yet: a prep deliverable for review.`,
    '',
  ]
    .filter((l) => l !== null)
    .join('\n');
}
