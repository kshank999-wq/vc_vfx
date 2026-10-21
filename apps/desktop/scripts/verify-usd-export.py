"""
Open a VC VFX USD camera export with Pixar's USD library (usd-core) and
compare the stage metadata, every time sample's camera-to-world matrix, the
focal length and apertures (read back in millimetres through GfCamera's
tenths-of-a-scene-unit convention and metersPerUnit) and the track points
with what was exported (addendum 06 §6.2). Not part of `pnpm test`; run by hand:

    python3 -m venv /tmp/usdenv && /tmp/usdenv/bin/pip install usd-core
    /tmp/usdenv/bin/python apps/desktop/scripts/verify-usd-export.py cam.usda expected.json
"""
import json, sys
from pxr import Usd, UsdGeom, Gf

path, expected = sys.argv[1], json.load(open(sys.argv[2]))
stage = Usd.Stage.Open(path)
assert stage, 'stage did not open'
errors = []
check = lambda ok, what: ok or errors.append(what)
check(UsdGeom.GetStageUpAxis(stage) == expected['upAxis'], 'upAxis')
mpu = UsdGeom.GetStageMetersPerUnit(stage)
check(abs(mpu - expected['metersPerUnit']) < 1e-9, 'metersPerUnit')
check(stage.GetTimeCodesPerSecond() == expected['fps'], 'timeCodesPerSecond')
check(stage.GetStartTimeCode() == expected['first'] and stage.GetEndTimeCode() == expected['last'], 'time range')
prim = stage.GetDefaultPrim().GetChild('camera')
check(prim.IsA(UsdGeom.Camera), 'camera prim type')
cam = UsdGeom.Camera(prim)
worst_t = worst_r = 0.0
for e in expected['cameras']:
    t = Usd.TimeCode(e['frame'])
    M = cam.ComputeLocalToWorldTransform(t)
    for i in range(3):
        worst_t = max(worst_t, abs(M[3][i] - e['position'][i]))
        for j in range(3):
            # Row j of a USD matrix is local axis j in the world; R's column j.
            worst_r = max(worst_r, abs(M[j][i] - e['rotation'][3 * i + j]))
    g = cam.GetCamera(t)
    # Tenths of a scene unit → mm.
    to_mm = mpu * 100
    check(abs(g.focalLength * to_mm - expected['focalMm']) < 1e-4, 'focal at %d' % e['frame'])
    check(abs(g.horizontalAperture * to_mm - expected['apertureMm'][0]) < 1e-4, 'h aperture')
    check(abs(g.verticalAperture * to_mm - expected['apertureMm'][1]) < 1e-4, 'v aperture')
pts = UsdGeom.Points(stage.GetDefaultPrim().GetChild('tracks'))
p = pts.GetPointsAttr().Get()
worst_p = max(abs(p[k][i] - expected['points'][k][i]) for k in range(len(p)) for i in range(3))
check(list(pts.GetIdsAttr().Get()) == expected['ids'], 'ids')
check(worst_t < 1e-4 and worst_r < 1e-6 and worst_p < 1e-4, 'transforms / points')
print('position %.2e  rotation %.2e  points %.2e  focal %.4f mm  aperture %.4f x %.4f mm  (%s, metersPerUnit %g)' % (
    worst_t, worst_r, worst_p, cam.GetCamera(Usd.TimeCode(expected['first'])).focalLength * mpu * 100,
    cam.GetCamera(Usd.TimeCode(expected['first'])).horizontalAperture * mpu * 100, cam.GetCamera(Usd.TimeCode(expected['first'])).verticalAperture * mpu * 100,
    expected['upAxis'], mpu))
print('FAIL ' + ', '.join(errors) if errors else 'PASS')
sys.exit(1 if errors else 0)
