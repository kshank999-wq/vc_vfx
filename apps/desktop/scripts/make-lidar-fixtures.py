"""
Make the LiDAR import test fixtures (addendum 06 §5) with independent writers:
pye57 (libE57Format) for E57, laspy for LAS, and plain Python per each format's
spec for PLY/OBJ/CSV/XYZ/PTS. Run once; the files are committed.

    python3 -m venv /tmp/lidarenv && /tmp/lidarenv/bin/pip install pye57 laspy numpy
    /tmp/lidarenv/bin/python apps/desktop/scripts/make-lidar-fixtures.py

Writes src/shared/__tests__/fixtures/lidar/: the same 600 points (survey-sized
coordinates, Z-up, metres) in every format, and truth.json.
"""
import json, struct, os
import numpy as np
import pye57, laspy
from pye57 import libe57
import pye57.e57 as e57mod

out = os.path.join(os.path.dirname(__file__), '..', 'src', 'shared', '__tests__', 'fixtures', 'lidar')
os.makedirs(out, exist_ok=True)
rng = np.random.default_rng(57)
N = 600
# A floor, a wall and a box face, offset to survey-like coordinates.
a = rng.random(N); b = rng.random(N); which = rng.integers(0, 3, N)
X = np.where(which == 0, a * 8, np.where(which == 1, a * 8, 2 + a * 1.5))
Y = np.where(which == 0, b * 6, np.where(which == 1, 6.0, 3.0))
Z = np.where(which == 0, 0.0, np.where(which == 1, b * 3, b * 1.2))
OFF = np.array([512345.0, 6789012.0, 120.0])
P = np.stack([X, Y, Z], 1) + OFF
P = np.round(P * 1000) / 1000  # millimetre grid: exact in every format
C = (np.stack([40 + which * 90, 200 - which * 60, 90 + (a * 120)], 1)).astype(np.uint8)
json.dump({'points': P.tolist(), 'colors': C.tolist()}, open(os.path.join(out, 'truth.json'), 'w'))

# PLY ascii and binary (both endians), with a face element after the vertices.
def ply_header(fmt):
    return (f"ply\nformat {fmt} 1.0\ncomment VC VFX test fixture\nelement vertex {N}\n"
            "property double x\nproperty double y\nproperty double z\n"
            "property uchar red\nproperty uchar green\nproperty uchar blue\n"
            "element face 1\nproperty list uchar int vertex_indices\nend_header\n")
with open(os.path.join(out, 'scan_ascii.ply'), 'w') as f:
    f.write(ply_header('ascii'))
    for p, c in zip(P, C): f.write(f"{p[0]:.3f} {p[1]:.3f} {p[2]:.3f} {c[0]} {c[1]} {c[2]}\n")
    f.write("3 0 1 2\n")
for name, fmt, e in (('scan_le.ply', 'binary_little_endian', '<'), ('scan_be.ply', 'binary_big_endian', '>')):
    with open(os.path.join(out, name), 'wb') as f:
        f.write(ply_header(fmt).encode())
        for p, c in zip(P, C): f.write(struct.pack(e + 'dddBBB', p[0], p[1], p[2], c[0], c[1], c[2]))
        f.write(struct.pack(e + 'Biii', 3, 0, 1, 2))
with open(os.path.join(out, 'mesh.obj'), 'w') as f:
    f.write("# fixture\n")
    for p in P: f.write(f"v {p[0]:.3f} {p[1]:.3f} {p[2]:.3f}\n")
    f.write("f 1 2 3\n")
with open(os.path.join(out, 'survey.csv'), 'w') as f:
    f.write("name,x,y,z\n")
    for i in range(12): f.write(f"CP{i+1:02d},{P[i,0]:.3f},{P[i,1]:.3f},{P[i,2]:.3f}\n")
with open(os.path.join(out, 'scan.xyz'), 'w') as f:
    for p, c in zip(P, C): f.write(f"{p[0]:.3f} {p[1]:.3f} {p[2]:.3f} {c[0]} {c[1]} {c[2]}\n")
with open(os.path.join(out, 'scan.pts'), 'w') as f:
    f.write(f"{N}\n")
    for p, c in zip(P, C): f.write(f"{p[0]:.3f} {p[1]:.3f} {p[2]:.3f} 77 {c[0]} {c[1]} {c[2]}\n")

# LAS 1.2 point format 2 (RGB) and LAS 1.4 point format 0.
for name, version, fmt in (('scan_12_f2.las', '1.2', 2), ('scan_14_f0.las', '1.4', 0)):
    hdr = laspy.LasHeader(point_format=fmt, version=version)
    hdr.offsets = OFF; hdr.scales = np.array([0.001, 0.001, 0.001])
    las = laspy.LasData(hdr)
    las.x = P[:, 0]; las.y = P[:, 1]; las.z = P[:, 2]
    if fmt == 2:
        las.red = C[:, 0].astype(np.uint16) * 257; las.green = C[:, 1].astype(np.uint16) * 257; las.blue = C[:, 2].astype(np.uint16) * 257
    las.write(os.path.join(out, name))

# E57 with float coordinates in a scanner frame and a pose (rotation about Z by 30°, translation OFF).
ang = np.deg2rad(30)
q = np.array([np.cos(ang / 2), 0, 0, np.sin(ang / 2)])
Rz = np.array([[np.cos(ang), -np.sin(ang), 0], [np.sin(ang), np.cos(ang), 0], [0, 0, 1]])
local = (P - OFF) @ Rz  # world = Rz·local + OFF
e = pye57.E57(os.path.join(out, 'scan_pose.e57'), mode='w')
e.write_scan_raw({'cartesianX': local[:, 0], 'cartesianY': local[:, 1], 'cartesianZ': local[:, 2], 'colorRed': C[:, 0], 'colorGreen': C[:, 1], 'colorBlue': C[:, 2]}, rotation=q, translation=OFF, name='posed scan')
e.close()

# E57 with ScaledInteger coordinates (millimetre steps), no pose, no colour.
real_float = libe57.FloatNode
def scaled_for_coords(imf, value=0.0, precision=None, minimum=None, maximum=None):
    if precision is None:
        return real_float(imf, value)
    lo = int(np.floor(minimum / 0.001)) - 1; hi = int(np.ceil(maximum / 0.001)) + 1
    return libe57.ScaledIntegerNode(imf, lo, lo, hi, 0.001, 0.0)
e57mod.libe57.FloatNode = scaled_for_coords
try:
    e = pye57.E57(os.path.join(out, 'scan_scaled.e57'), mode='w')
    e.write_scan_raw({'cartesianX': P[:, 0] - OFF[0], 'cartesianY': P[:, 1] - OFF[1], 'cartesianZ': P[:, 2] - OFF[2]}, name='scaled scan')
    e.close()
finally:
    e57mod.libe57.FloatNode = real_float
# Read the scaled one back with pye57 to prove it is valid.
back = pye57.E57(os.path.join(out, 'scan_scaled.e57')).read_scan_raw(0)
assert np.allclose(back['cartesianX'], P[:, 0] - OFF[0], atol=1e-6)
print('fixtures written to', os.path.abspath(out))
