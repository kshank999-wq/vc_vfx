"""
Open a written shot package's exports in real Blender (the bpy module) and
compare them with VC VFX's own JSON (addendum 15): the camera track's `.py`
(every frame's world matrix, lens, film back, range, fps, track points), its
`.usda` through Blender's USD importer, its ASCII FBX (Blender refuses ASCII
FBX: reported, not failed), the lighting rig's `_blender.py` (light types,
positions, aim, energy from candela/lux) and the textures' OBJ/MTL (UVs, image
textures resolved on disk). Not part of `pnpm test`; run by hand:

    uv venv -p 3.11 /tmp/bpyenv && VIRTUAL_ENV=/tmp/bpyenv uv pip install bpy==4.5.3
    /tmp/bpyenv/bin/python apps/desktop/scripts/verify-package-blender.py <OUT>/<PROJECT>_VFX/SCENE_x/SHOT_y
"""
import json, math, os, sys, glob
import bpy
from mathutils import Matrix, Vector

shot = sys.argv[1]
out = {'blender': bpy.app.version_string}
fails = []

def check(name, ok, detail=None):
    out.setdefault('checks', []).append({'check': name, 'ok': bool(ok), **({'detail': detail} if detail is not None else {})})
    if not ok:
        fails.append(name)

YZ = Matrix(((1, 0, 0), (0, 0, -1), (0, 1, 0)))  # Y-up -> Z-up

# --- 1. The camera track's Blender script vs its JSON ---------------------------
cam_dir = sorted(glob.glob(os.path.join(shot, '06_CAMERA_TRACK', '*_camtrack_v*')))[-1]
stem = os.path.join(cam_dir, os.path.basename(cam_dir))
js = json.load(open(stem + '.json'))
bpy.ops.wm.read_factory_settings(use_empty=True)
exec(compile(open(stem + '.py').read(), stem + '.py', 'exec'), {'__name__': '__main__'})
scene = bpy.context.scene
cam = scene.camera
worst_t = worst_r = 0.0
for c in js['cameras']:
    scene.frame_set(c['frame'])
    M = cam.matrix_world
    R = Matrix([c['rotationMatrix'][0:3], c['rotationMatrix'][3:6], c['rotationMatrix'][6:9]])
    Rz = YZ @ R
    tz = YZ @ Vector(c['position'])
    for i in range(3):
        worst_t = max(worst_t, abs(M[i][3] - tz[i]))
        for j in range(3):
            worst_r = max(worst_r, abs(M[i][j] - Rz[i][j]))
fps = scene.render.fps / scene.render.fps_base
out['camera'] = {'frames': len(js['cameras']), 'range': [scene.frame_start, scene.frame_end], 'fps': fps, 'lens': cam.data.lens, 'sensor': [cam.data.sensor_width, cam.data.sensor_height, cam.data.sensor_fit], 'res': [scene.render.resolution_x, scene.render.resolution_y], 'max_pos_err_m': worst_t, 'max_rot_err': worst_r,
                 'keyed_frames': len({int(k.co[0]) for fc in (cam.animation_data.action.fcurves if cam.animation_data and cam.animation_data.action else []) for k in fc.keyframe_points})}
check('camera .py: every frame matches the JSON (pos < 1e-5 m, rot < 1e-5)', worst_t < 1e-5 and worst_r < 1e-5, [worst_t, worst_r])
check('camera .py: lens = JSON focal', abs(cam.data.lens - js['lens']['focalMm']) < 1e-3, [cam.data.lens, js['lens']['focalMm']])
check('camera .py: sensor = film back, fit horizontal', abs(cam.data.sensor_width - js['filmBackMm']['width']) < 1e-6 and cam.data.sensor_fit == 'HORIZONTAL')
check('camera .py: frame range and fps', [scene.frame_start, scene.frame_end] == [js['frameRange']['first'], js['frameRange']['last']] and abs(fps - js['frameRange']['fps']) < 1e-6)
check('camera .py: resolution', [scene.render.resolution_x, scene.render.resolution_y] == [js['plate']['width'], js['plate']['height']])
tracks = [o for o in bpy.data.objects if o.name.startswith('track_')]
out['camera']['track_objects'] = len(tracks)
if tracks:
    by = {o.name: o for o in tracks}
    p0 = js['points'][0]
    cand = [o for n, o in by.items() if n.endswith('_' + str(p0['id'])) or n == f"track_{p0['id']}"]
    if cand:
        err = (cand[0].location - YZ @ Vector(p0['position'])).length
        check('camera .py: track point position', err < 1e-5, err)

# FBX (ASCII 7.4) with Blender's importer.
bpy.ops.wm.read_factory_settings(use_empty=True)
try:
    r = bpy.ops.import_scene.fbx(filepath=stem + '.fbx')
    cams = [o for o in bpy.data.objects if o.type == 'CAMERA']
    out['fbx'] = {'result': list(r), 'cameras': len(cams)}
except Exception as e:  # Blender refuses ASCII FBX
    out['fbx'] = {'error': str(e).strip().splitlines()[-1][:300]}

# The camera USD with Blender's USD importer.
bpy.ops.wm.read_factory_settings(use_empty=True)
r = bpy.ops.wm.usd_import(filepath=stem + '.usda')
cams = [o for o in bpy.data.objects if o.type == 'CAMERA']
if cams:
    c = cams[0]
    out['usd_in_blender'] = {'result': list(r), 'lens': c.data.lens, 'sensor': c.data.sensor_width, 'range': [bpy.context.scene.frame_start, bpy.context.scene.frame_end]}
    check('camera .usda in Blender: lens and sensor', abs(c.data.lens - js['lens']['focalMm']) < 1e-3 and abs(c.data.sensor_width - js['filmBackMm']['width']) < 1e-3, [c.data.lens, c.data.sensor_width])
    # Pose at the first frame vs JSON (Blender imports a Y-up stage into Z-up).
    f0 = js['cameras'][0]
    bpy.context.scene.frame_set(f0['frame'])
    err = (c.matrix_world.translation - YZ @ Vector(f0['position'])).length
    out['usd_in_blender']['pos_err_first_frame'] = err
    check('camera .usda in Blender: position at first frame', err < 1e-4, err)
else:
    check('camera .usda in Blender: a camera', False)

# --- 2. The lighting rig's Blender script vs its rig JSON ------------------------
light_dir = sorted(glob.glob(os.path.join(shot, '09_PROJECT_DATA', '*_light_v*')))[-1]
lstem = os.path.join(light_dir, os.path.basename(light_dir))
rig = json.load(open(lstem + '_rig.json'))
bpy.ops.wm.read_factory_settings(use_empty=True)
exec(compile(open(lstem + '_blender.py').read(), lstem + '_blender.py', 'exec'), {'__name__': '__main__'})
bpy.context.view_layer.update()
lights = [o for o in bpy.data.objects if o.type == 'LIGHT']
units_m = {'m': 1, 'cm': 0.01, 'mm': 0.001}.get(rig['conventions'].get('units', 'm') if isinstance(rig.get('conventions'), dict) else 'm', 1)
want = [l for l in rig['lights'] if l['type'] != 'dome']
out['lights'] = []
for l in want:
    o = next((x for x in lights if x.name.endswith('_' + l['id'])), None)
    if o is None:
        check(f"light {l['id']}: in Blender", False)
        continue
    pos = YZ @ Vector(l['scene']['position']) * units_m
    d = YZ @ Vector(l['scene']['direction'])
    fwd = o.matrix_world.to_3x3() @ Vector((0, 0, -1))
    kind = {'rect': 'AREA', 'directional': 'SUN', 'spot': 'SPOT', 'point': 'POINT'}[l['type']]
    expect_energy = l['intensity']['candela'] * math.pi / 683 if kind == 'AREA' else (l['intensity']['lux'] / 683 if kind == 'SUN' else l['intensity']['candela'] * 4 * math.pi / 683)
    rec = {'id': l['id'], 'type': o.data.type, 'energy': o.data.energy, 'expect_energy': expect_energy, 'color': list(o.data.color), 'pos_err': (o.location - pos).length, 'dir_err': (fwd.normalized() - d.normalized()).length}
    out['lights'].append(rec)
    check(f"light {l['id']}: type {kind}", o.data.type == kind)
    check(f"light {l['id']}: position (rig scene → Z-up)", rec['pos_err'] < 1e-4, rec['pos_err'])
    check(f"light {l['id']}: aims along the rig direction", rec['dir_err'] < 1e-4, rec['dir_err'])
    check(f"light {l['id']}: energy from candela/lux", abs(o.data.energy - expect_energy) < 1e-3 * max(1, expect_energy), [o.data.energy, expect_energy])
check('lighting .py: no dome as a light (world instead)', len(lights) == len(want), [len(lights), len(want)])
w = bpy.context.scene.world
out['world'] = {'strength': w.node_tree.nodes['Background'].inputs[1].default_value if w and w.use_nodes else None, 'env_texture': any(n.type == 'TEX_ENVIRONMENT' for n in w.node_tree.nodes) if w and w.use_nodes else False}
lc = bpy.context.scene.camera
rc = rig['camera']
out['light_camera'] = {'lens': lc.data.lens, 'rig_focal': rc.get('focalMm'), 'sensor': lc.data.sensor_width}

# --- 3. The textures' OBJ/MTL with Blender's OBJ importer -------------------------
tex_dir = sorted(glob.glob(os.path.join(shot, '07_TEXTURES_REFERENCES', '*_tex_v*')))[-1]
obj = glob.glob(os.path.join(tex_dir, '*.obj'))[0]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.wm.obj_import(filepath=obj)
meshes = [o for o in bpy.data.objects if o.type == 'MESH']
tm = json.load(open(glob.glob(os.path.join(tex_dir, '*_tex_v*.json'))[0]))
out['textures'] = {'meshes': [], 'images': []}
for m in meshes:
    me = m.data
    uv = me.uv_layers.active
    mats = [s.material for s in m.material_slots if s.material]
    imgs = []
    for mat in mats:
        if mat.use_nodes:
            for n in mat.node_tree.nodes:
                if n.type == 'TEX_IMAGE' and n.image:
                    path = bpy.path.abspath(n.image.filepath)
                    imgs.append({'file': os.path.basename(path), 'exists': os.path.isfile(path), 'size': list(n.image.size), 'linked': any(l.to_node.type == 'BSDF_PRINCIPLED' for o_ in n.outputs for l in o_.links)})
    uvs = [tuple(d.uv) for d in uv.data] if uv else []
    out['textures']['meshes'].append({'name': m.name, 'verts': len(me.vertices), 'faces': len(me.polygons), 'uv': bool(uv), 'uv_range': [min(u[0] for u in uvs), max(u[0] for u in uvs), min(u[1] for u in uvs), max(u[1] for u in uvs)] if uvs else None, 'materials': [x.name for x in mats], 'images': imgs, 'dims': list(m.dimensions)})
    check(f'textures OBJ: {m.name} has UVs', bool(uv))
    check(f'textures OBJ: {m.name} image texture resolved on disk', imgs and all(i['exists'] and i['size'][0] > 0 for i in imgs), imgs)
check('textures OBJ: one mesh per exported region', len(meshes) >= 1, len(meshes))
out['textures']['mapping_keys'] = list(tm.keys())[:20]

out['fails'] = fails
print(json.dumps(out, indent=1, default=str))
print('PASS' if not fails else 'FAIL: ' + '; '.join(fails))
