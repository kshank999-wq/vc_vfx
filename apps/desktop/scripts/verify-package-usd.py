"""
Open a written shot package's USD exports with Pixar's USD library and compare
them with VC VFX's JSON (addendum 15): the camera `.usda` (stage metadata,
every time sample, focal and apertures) and the lighting `.usda` (one UsdLux
prim per light of the rig's type, position, -Z aim, relative intensity, colour
temperature, the DomeLight texture resolving), each also run through every
validator usd-core registers (UsdValidation; 26.x has no ComplianceChecker).
Not part of `pnpm test`; run by hand:

    python3 -m venv /tmp/usdenv && /tmp/usdenv/bin/pip install usd-core
    /tmp/usdenv/bin/python -I apps/desktop/scripts/verify-package-usd.py <SHOT folder>
"""
import glob, json, os, sys
from pxr import Usd, UsdGeom, UsdLux, Gf, Sdf, UsdUtils

shot = sys.argv[1]
checks = []
def check(name, ok, detail=None):
    checks.append((bool(ok), name, detail))

def compliance(path):
    """usd-core 26.x replaced UsdUtils.ComplianceChecker with UsdValidation: run every registered validator."""
    from pxr import UsdValidation
    reg = UsdValidation.ValidationRegistry()
    vs = [v for v in reg.GetOrLoadAllValidators() if 'Usdz' not in v.GetMetadata().name and 'RootPackage' not in v.GetMetadata().name]
    errs = UsdValidation.ValidationContext(vs).Validate(Usd.Stage.Open(path))
    bad = [f"{e.GetName()}: {e.GetMessage()}" for e in errs if e.GetType() == UsdValidation.ValidationErrorType.Error]
    warn = [f"{e.GetName()}: {e.GetMessage()}" for e in errs if e.GetType() != UsdValidation.ValidationErrorType.Error]
    return bad, [], warn + [f'{len(vs)} validators']

# --- camera -----------------------------------------------------------------
cam_dir = sorted(glob.glob(os.path.join(shot, '06_CAMERA_TRACK', '*_camtrack_v*')))[-1]
stem = os.path.join(cam_dir, os.path.basename(cam_dir))
js = json.load(open(stem + '.json'))
stage = Usd.Stage.Open(stem + '.usda')
check('camera .usda opens', stage)
errs, failed, warns = compliance(stem + '.usda')
check('camera .usda: UsdValidation (all validators) no errors', not errs and not failed, {'errors': errs, 'failed': failed, 'warnings': warns})
mpu = UsdGeom.GetStageMetersPerUnit(stage)
check('camera: upAxis Y / metersPerUnit as the JSON (m)', UsdGeom.GetStageUpAxis(stage) == 'Y' and abs(mpu - 1.0) < 1e-12, [UsdGeom.GetStageUpAxis(stage), mpu])
check('camera: timeCodesPerSecond and range', stage.GetTimeCodesPerSecond() == js['frameRange']['fps'] and stage.GetStartTimeCode() == js['frameRange']['first'] and stage.GetEndTimeCode() == js['frameRange']['last'])
cams = [p for p in stage.Traverse() if p.IsA(UsdGeom.Camera)]
check('camera: one UsdGeom.Camera', len(cams) == 1, len(cams))
cam = UsdGeom.Camera(cams[0])
xf = UsdGeom.Xformable(cams[0])
samples = []
for op in xf.GetOrderedXformOps():
    samples = op.GetTimeSamples() or samples
check('camera: one transform time sample per solved frame', len(samples) == len(js['cameras']), len(samples))
wt = wr = 0.0
for c in js['cameras']:
    M = cam.ComputeLocalToWorldTransform(Usd.TimeCode(c['frame']))
    R = c['rotationMatrix']
    for i in range(3):
        wt = max(wt, abs(M[3][i] - c['position'][i]))
        for j in range(3):
            wr = max(wr, abs(M[j][i] - R[3 * i + j]))
g = cam.GetCamera(Usd.TimeCode(js['frameRange']['first']))
to_mm = mpu * 100
check('camera: pose per frame = JSON', wt < 1e-5 and wr < 1e-6, [wt, wr])
check('camera: focal and apertures in tenths of a unit = JSON mm', abs(g.focalLength * to_mm - js['lens']['focalMm']) < 1e-4 and abs(g.horizontalAperture * to_mm - js['filmBackMm']['width']) < 1e-4, [g.focalLength, g.horizontalAperture, g.verticalAperture])

# --- lighting ---------------------------------------------------------------
light_dir = sorted(glob.glob(os.path.join(shot, '09_PROJECT_DATA', '*_light_v*')))[-1]
lstem = os.path.join(light_dir, os.path.basename(light_dir))
rig = json.load(open(lstem + '_rig.json'))
st = Usd.Stage.Open(lstem + '.usda')
check('lighting .usda opens', st)
errs, failed, warns = compliance(lstem + '.usda')
check('lighting .usda: UsdValidation (all validators) no errors', not errs and not failed, {'errors': errs, 'failed': failed, 'warnings': warns})
lmpu = UsdGeom.GetStageMetersPerUnit(st)
check('lighting: upAxis/metersPerUnit', UsdGeom.GetStageUpAxis(st) in ('Y', 'Z'), [UsdGeom.GetStageUpAxis(st), lmpu])
kinds = {'rect': UsdLux.RectLight, 'dome': UsdLux.DomeLight, 'directional': UsdLux.DistantLight, 'point': UsdLux.SphereLight, 'spot': UsdLux.SphereLight}
key_cd = next(l for l in rig['lights'] if l['role'] == 'key')['intensity']['lux']
out = []
for l in rig['lights']:
    prims = [p for p in st.Traverse() if p.GetName() == l['id']]
    if not prims:
        check(f"light {l['id']}: a prim", False); continue
    p = prims[0]
    check(f"light {l['id']}: is {kinds[l['type']].__name__}", p.IsA(kinds[l['type']]), p.GetTypeName())
    lapi = UsdLux.LightAPI(p)
    temp = lapi.GetColorTemperatureAttr().Get()
    rec = {'id': l['id'], 'type': p.GetTypeName(), 'intensity': lapi.GetIntensityAttr().Get(), 'temperature': temp, 'tempOn': lapi.GetEnableColorTemperatureAttr().Get()}
    if l.get('temperatureK'):
        check(f"light {l['id']}: colorTemperature = rig", abs(temp - l['temperatureK']) < 0.6, [temp, l['temperatureK']])
    if l['type'] != 'dome':
        M = UsdGeom.Xformable(p).ComputeLocalToWorldTransform(Usd.TimeCode.Default())
        pos = M.ExtractTranslation()
        fwd = -Gf.Vec3d(M[2][0], M[2][1], M[2][2]).GetNormalized()
        want = Gf.Vec3d(*l['scene']['position'])
        d = Gf.Vec3d(*l['scene']['direction']).GetNormalized()
        rec.update({'pos_err': (pos - want).GetLength(), 'dir_err': (fwd - d).GetLength()})
        check(f"light {l['id']}: position = rig", rec['pos_err'] < 1e-4, rec['pos_err'])
        check(f"light {l['id']}: emits along -Z = rig direction", rec['dir_err'] < 1e-4, rec['dir_err'])
        rel = l['intensity']['lux'] / key_cd
        check(f"light {l['id']}: intensity relative to the key (lux ratio)", abs(rec['intensity'] - rel) < 1e-3 * max(1, rel), [rec['intensity'], rel])
    else:
        tex = UsdLux.DomeLight(p).GetTextureFileAttr().Get()
        rec['texture'] = str(tex) if tex else None
        if tex:
            resolved = tex.resolvedPath
            rec['texture_resolved'] = resolved
            check(f"light {l['id']}: DomeLight texture resolves to a file", resolved and os.path.isfile(resolved), resolved)
    out.append(rec)
camp = [p for p in st.Traverse() if p.IsA(UsdGeom.Camera)]
check('lighting: the camera', len(camp) == 1)
if camp:
    g = UsdGeom.Camera(camp[0]).GetCamera(Usd.TimeCode.Default())
    check('lighting camera focal = rig (mm)', abs(g.focalLength * lmpu * 100 - rig['camera']['focalMm']) < 1e-3, [g.focalLength, rig['camera'].get('focalMm')])

print(json.dumps({'usd': Usd.GetVersion(), 'lights': out}, indent=1, default=str))
for ok, name, detail in checks:
    print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else f'  {detail}'))
print('PASS' if all(c[0] for c in checks) else 'FAIL')
