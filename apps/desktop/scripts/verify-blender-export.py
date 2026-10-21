"""
Run a VC VFX Blender camera export inside real Blender (the bpy module) and
compare every frame's camera world matrix, the lens and the film back with
what was exported (addendum 06 §6). Not part of `pnpm test` (bpy is a 350 MB
download); run by hand:

    uv venv -p 3.11 /tmp/bpyenv && VIRTUAL_ENV=/tmp/bpyenv uv pip install bpy==4.5.3
    /tmp/bpyenv/bin/python apps/desktop/scripts/verify-blender-export.py cam.py expected.json
"""
import json, sys, math
import bpy

script, expected = sys.argv[1], json.load(open(sys.argv[2]))
bpy.ops.wm.read_factory_settings(use_empty=True)
exec(compile(open(script).read(), script, 'exec'), {'__name__': '__main__'})
scene = bpy.context.scene
cam = scene.camera
worst_t = worst_r = 0.0
for e in expected:
    if e['frame'] < 0:
        continue
    scene.frame_set(e['frame'])
    M = cam.matrix_world
    for i in range(3):
        worst_t = max(worst_t, abs(M[i][3] - e['t'][i]))
        for j in range(3):
            worst_r = max(worst_r, abs(M[i][j] - e['R'][3 * i + j]))
tracks = [o for o in bpy.data.objects if o.name.startswith('track_')]
pt = [e for e in expected if e['frame'] < 0][0]['t']
point_err = max(abs(tracks[0].location[i] - pt[i]) for i in range(3))
fps = scene.render.fps / scene.render.fps_base
print(json.dumps({
    'blender': bpy.app.version_string,
    'frames': len([e for e in expected if e['frame'] >= 0]),
    'frame_range': [scene.frame_start, scene.frame_end],
    'fps': fps,
    'lens_mm': cam.data.lens,
    'sensor_mm': [cam.data.sensor_width, cam.data.sensor_height, cam.data.sensor_fit],
    'resolution': [scene.render.resolution_x, scene.render.resolution_y],
    'max_position_error_m': worst_t,
    'max_rotation_matrix_error': worst_r,
    'track_point_error_m': point_err,
}, indent=1))
ok = worst_t < 1e-5 and worst_r < 1e-5 and point_err < 1e-6 and abs(cam.data.lens - 32) < 1e-6 and abs(fps - 23.976) < 1e-4
print('PASS' if ok else 'FAIL')
sys.exit(0 if ok else 1)
