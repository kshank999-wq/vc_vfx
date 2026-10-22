"""
Run VC VFX's generated Unreal Python (camera track and light rig) against a
stub `unreal` module that records every call (no Unreal Engine here;
addendum 15): the scripts run end to end, every `unreal.*` name and method
they use is checked against a list of UE 5.x Python names, the actors spawned
match the rig, and the keyed locations and rotators reproduce the JSON in
Unreal's frame (FRotationMatrix axes vs the camera's). Run by hand:

    python3 -I apps/desktop/scripts/verify-package-unreal.py <SHOT folder>
"""
import glob, json, math, os, sys, types

# UE 5.x Python names used with confidence (Epic's Python API reference and sequencer examples).
KNOWN = {
    'unreal': {'AssetToolsHelpers', 'LevelSequence', 'LevelSequenceFactoryNew', 'FrameRate', 'get_editor_subsystem', 'EditorActorSubsystem', 'CineCameraActor', 'Vector', 'Rotator',
               'CameraFocusMethod', 'MovieScene3DTransformTrack', 'FrameNumber', 'MovieSceneKeyInterpolation', 'MovieSceneFloatTrack', 'MovieSceneCameraCutTrack', 'EditorAssetLibrary',
               'StaticMeshActor', 'LevelSequenceEditorBlueprintLibrary', 'log', 'log_warning', 'log_error', 'DirectionalLight', 'PointLight', 'SpotLight', 'RectLight', 'SkyLight',
               'Color', 'LinearColor', 'EditorLevelLibrary', 'TextureCube', 'AssetImportTask', 'Paths', 'SystemLibrary', 'ExponentialHeightFog', 'PostProcessVolume', 'ComponentMobility',
               'LightUnits', 'EditorFilterLibrary', 'Name', 'Text', 'Transform', 'Quat', 'MathLibrary', 'TextureSourceCompressionSettings', 'TextureCompressionSettings',
               'SkyLightSourceType', 'EditorUtilityLibrary', 'Array', 'Map', 'StaticMesh', 'Actor', 'AutoExposureMethod',
               'DirectionalLightComponent', 'PointLightComponent', 'SpotLightComponent', 'RectLightComponent', 'SkyLightComponent'},
    'methods': {'get_asset_tools', 'create_asset', 'set_display_rate', 'set_playback_start', 'set_playback_end', 'spawn_actor_from_class', 'set_actor_label', 'get_cine_camera_component',
                'get_editor_property', 'set_editor_property', 'add_possessable', 'add_track', 'add_master_track', 'add_section', 'set_range', 'get_all_channels', 'get_channels', 'add_key',
                'set_property_name_and_path', 'set_camera_binding_id', 'get_binding_id', 'load_asset', 'set_static_mesh', 'set_actor_scale3d', 'set_folder_path', 'save_loaded_asset',
                'open_level_sequence', 'get_component_by_class', 'set_intensity', 'set_light_color', 'set_temperature', 'set_actor_location', 'set_actor_rotation', 'set_actor_location_and_rotation',
                'import_asset_tasks', 'get_all_level_actors', 'destroy_actor', 'does_asset_exist', 'get_actor_label', 'set_mobility', 'recapture_sky', 'set_cubemap', 'get_folder_path',
                'set_source_width', 'set_source_height', 'set_attenuation_radius', 'set_use_temperature', 'set_cast_shadows', 'set_source_radius', 'set_outer_cone_angle', 'set_inner_cone_angle',
                'get_editor_world', 'set_light_function_material', 'set_relative_rotation', 'set_relative_location',
                # enum members and properties read as attributes
                'CANDELAS', 'SLS_CAPTURED_SCENE', 'SLS_SPECIFIED_CUBEMAP', 'DISABLE', 'LINEAR', 'static_mesh_component', 'set_visibility'},
}

calls = []          # (path, args, kwargs)
used_unreal = set()
used_methods = set()

class Rec:
    def __init__(self, path, value=None):
        self._path = path
        self._props = {}
    def __getattr__(self, name):
        if name.startswith('__'):
            raise AttributeError(name)
        if self._path == 'unreal':
            used_unreal.add(name)
        else:
            used_methods.add(name)
        return Rec(f'{self._path}.{name}')
    def __call__(self, *args, **kw):
        calls.append((self._path, args, kw))
        leaf = self._path.split('.')[-1]
        if leaf == 'get_editor_property':
            key = args[0]
            if key not in self._props:
                self._props[key] = Rec(f'{self._path}({key})')
            return self._props[key]
        if leaf in ('get_all_channels', 'get_channels'):
            return [Rec(f'{self._path}[{i}]') for i in range(9)]
        if leaf == 'get_all_level_actors':
            return []
        if leaf in ('does_asset_exist',):
            return False
        return Rec(f'{self._path}()')
    def __iter__(self):
        return iter([])
    def __bool__(self):
        return True
    def __repr__(self):
        return f'<{self._path}>'

def run(script):
    calls.clear(); used_unreal.clear(); used_methods.clear()
    stub = Rec('unreal')
    mod = types.ModuleType('unreal')
    mod.__getattr__ = lambda name: getattr(stub, name)
    sys.modules['unreal'] = mod
    g = {'__name__': '__main__', '__file__': script}
    exec(compile(open(script).read(), script, 'exec'), g)
    return g

def rot_axes(pitch, yaw, roll):
    """Unreal's FRotationMatrix: forward X, right Y, up Z of a rotator (degrees)."""
    P, Y, R = (math.radians(a) for a in (pitch, yaw, roll))
    CP, SP, CY, SY, CR, SR = math.cos(P), math.sin(P), math.cos(Y), math.sin(Y), math.cos(R), math.sin(R)
    X = (CP * CY, CP * SY, SP)
    Yax = (SR * SP * CY - CR * SY, SR * SP * SY + CR * CY, -SR * CP)
    Z = (-(CR * SP * CY + SR * SY), CY * SR - CR * SP * SY, CR * CP)
    return X, Yax, Z

to_ue = lambda v, s=1.0: (-v[2] * s, v[0] * s, v[1] * s)   # scene Y-up RH -> Unreal Z-up LH (X fwd = -Z, Y = X, Z = Y)
dist = lambda a, b: math.sqrt(sum((x - y) ** 2 for x, y in zip(a, b)))

shot = sys.argv[1]
results = {}
fails = []

# --- camera -----------------------------------------------------------------------
cam_dir = sorted(glob.glob(os.path.join(shot, '06_CAMERA_TRACK', '*_camtrack_v*')))[-1]
stem = os.path.join(cam_dir, os.path.basename(cam_dir))
js = json.load(open(stem + '.json'))
g = run(stem + '_unreal.py')
spawned = [c[1][0]._path.split('.')[-1] for c in calls if c[0].endswith('spawn_actor_from_class')]
tracks = [c[1][0]._path.split('.')[-1] for c in calls if c[0].endswith('.add_track') or c[0].endswith('.add_master_track')]
keys = [c for c in calls if c[0].endswith('.add_key')]
worst_pos = worst_axes = 0.0
for i, c in enumerate(js['cameras']):
    loc = g['LOCATION_CM'][i]
    worst_pos = max(worst_pos, dist(loc, to_ue(c['position'], 100)))
    R = c['rotationMatrix']  # camera -> world, columns are the camera's axes
    right, up, back = [R[0], R[3], R[6]], [R[1], R[4], R[7]], [R[2], R[5], R[8]]
    fwd = [-x for x in back]
    p, y, r = g['ROTATION_PYR'][i]
    X, Yax, Z = rot_axes(p, y, r)
    worst_axes = max(worst_axes, dist(X, to_ue(fwd)), dist(Yax, to_ue(right)), dist(Z, to_ue(up)))
results['camera'] = {
    'unreal_names_used': sorted(used_unreal), 'unknown_unreal_names': sorted(used_unreal - KNOWN['unreal']), 'unknown_methods': sorted(used_methods - KNOWN['methods']),
    'spawned': sorted(set(spawned)), 'spawn_count': len(spawned), 'tracks': tracks, 'keys': len(keys),
    'max_location_err_cm': worst_pos, 'max_axis_err': worst_axes,
    'focal_keys': g['FOCAL_MM'][:1], 'sensor': g['SENSOR_MM'], 'fps': g['FPS'], 'range': [g['FIRST'], g['LAST']],
}
if worst_pos > 1e-3 or worst_axes > 1e-4: fails.append('camera keys do not reproduce the JSON in Unreal coordinates')
if abs(g['FOCAL_MM'][0] - js['lens']['focalMm']) > 1e-4: fails.append('camera focal')
if results['camera']['unknown_unreal_names'] or results['camera']['unknown_methods']: fails.append('camera: unrecognised API names')
# 48 frames x 6 transform channels + 48 focal keys
if len(keys) != len(js['cameras']) * 7: fails.append(f'camera: {len(keys)} keys')

# --- lighting -----------------------------------------------------------------------
light_dir = sorted(glob.glob(os.path.join(shot, '09_PROJECT_DATA', '*_light_v*')))[-1]
lstem = os.path.join(light_dir, os.path.basename(light_dir))
rig = json.load(open(lstem + '_rig.json'))
os.chdir(light_dir)
g = run(lstem + '_unreal.py')
spawned = [(c[1][0]._path.split('.')[-1], c[1][1:] if len(c[1]) > 1 else ()) for c in calls if c[0].endswith('spawn_actor_from_class')]
props = sorted({(c[1][0]) for c in calls if c[0].endswith('set_editor_property') and c[1] and isinstance(c[1][0], str)})
results['lighting'] = {
    'unreal_names_used': sorted(used_unreal), 'unknown_unreal_names': sorted(used_unreal - KNOWN['unreal']), 'unknown_methods': sorted(used_methods - KNOWN['methods']),
    'spawned': [s[0] for s in spawned], 'editor_properties_set': props,
}
want_cls = {'rect': 'RectLight', 'dome': 'SkyLight', 'directional': 'DirectionalLight', 'point': 'PointLight', 'spot': 'SpotLight'}
expect = sorted([want_cls[l['type']] for l in rig['lights'] if l.get('enabled', True)] + ['CineCameraActor'])
if sorted(s[0] for s in spawned) != expect and not set(expect) <= set(s[0] for s in spawned):
    fails.append(f"lighting: spawned {sorted(s[0] for s in spawned)} vs rig {expect}")
if results['lighting']['unknown_unreal_names'] or results['lighting']['unknown_methods']: fails.append('lighting: unrecognised API names')
# Light positions as spawned vs the rig's unreal section
ul = {l['id']: l for l in rig['unreal']['lights']}
for l in rig['lights']:
    if l['type'] == 'dome' or not l.get('enabled', True): continue
    want = to_ue(l['scene']['position'], 100)
    got = ul[l['id']]['location_cm']
    if dist(want, got) > 1e-3: fails.append(f"lighting {l['id']}: rig location_cm {got} vs scene {want}")
    pyr = ul[l['id']]['rotation_pyr']
    X, _, _ = rot_axes(*pyr)
    if dist(X, to_ue(l['scene']['direction'])) > 1e-3: fails.append(f"lighting {l['id']}: rotator does not aim along the rig direction")
results['fails'] = fails
print(json.dumps(results, indent=1, default=str))
print('PASS' if not fails else 'FAIL: ' + '; '.join(fails))
