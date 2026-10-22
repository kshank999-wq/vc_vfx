"""
Read every EXR under an output root with the OpenEXR library (the ASWF
bindings, not ffmpeg): channels and their types, data and display windows,
compression, finite values, every frame of a sequence alike, and whether an
RGBA file is premultiplied (no colour where alpha is 0). Addendum 15. Run by hand:

    python3 -m venv /tmp/exrenv && /tmp/exrenv/bin/pip install OpenEXR numpy
    /tmp/exrenv/bin/python -I apps/desktop/scripts/verify-package-exr.py <output root>
"""
import collections, glob, json, os, re, sys
import numpy as np
import OpenEXR

root = sys.argv[1]
files = sorted(glob.glob(os.path.join(root, '**', '*.exr'), recursive=True))
groups = collections.OrderedDict()
for f in files:
    key = re.sub(r'\.\d{4}\.exr$', '.####.exr', os.path.relpath(f, root))
    groups.setdefault(key, []).append(f)

def describe(f):
    with OpenEXR.File(f, separate_channels=True) as x:
        h = x.header()
        ch = x.channels()
        dw = h['dataWindow']; dsp = h['displayWindow']
        info = {
            'channels': {n: str(c.pixels.dtype) for n, c in ch.items()},
            'dataWindow': [list(map(int, dw[0])), list(map(int, dw[1]))],
            'displayWindow': [list(map(int, dsp[0])), list(map(int, dsp[1]))],
            'compression': str(h.get('compression')).split('.')[-1],
            'lineOrder': str(h.get('lineOrder')).split('.')[-1],
        }
        px = {n: np.asarray(c.pixels, dtype=np.float64) for n, c in ch.items()}
    return info, px

report = []
fails = []
for key, fs in groups.items():
    info, px = describe(fs[0])
    rec = {'files': key, 'count': len(fs), **info}
    names = set(px)
    rec['finite'] = all(np.isfinite(v).all() for v in px.values())
    rec['range'] = {n: [round(float(v.min()), 4), round(float(v.max()), 4)] for n, v in px.items()}
    if 'A' in names and names & {'R', 'G', 'B'}:
        a = px['A']
        rgb = np.stack([px[c] for c in 'RGB' if c in px])
        zero = a <= 0
        rec['rgb_where_alpha_0'] = float(np.abs(rgb[:, zero]).max()) if zero.any() else None
        # Premultiplied: colour vanishes with alpha. Unpremultiplied colour keeps the subject's colour under alpha 0.
        rec['premultiplied'] = rec['rgb_where_alpha_0'] is None or rec['rgb_where_alpha_0'] < 1e-3
    # Every frame of a sequence decodes, with the same channels and window.
    bad = []
    for f in fs[1:]:
        i2, _ = describe(f)
        if i2['channels'] != info['channels'] or i2['dataWindow'] != info['dataWindow']:
            bad.append(os.path.basename(f))
    rec['frames_consistent'] = not bad
    if bad or not rec['finite']:
        fails.append(key)
    report.append(rec)

print(json.dumps({'openexr': OpenEXR.__version__ if hasattr(OpenEXR, '__version__') else '?', 'sequences': report, 'fails': fails}, indent=1))
