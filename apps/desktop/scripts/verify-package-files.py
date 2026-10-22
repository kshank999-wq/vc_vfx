"""
Inspect a written shot package on disk (master spec §17, §18; addendum 15):
the eleven folders, manifest.json's sections, every file on disk listed in the
manifest and every listed file present with its size and SHA-256, every
package-relative path the manifest names, and the prep report. Run by hand:

    python3 -I apps/desktop/scripts/verify-package-files.py <SHOT folder>
"""
import hashlib, json, os, sys, re
from html.parser import HTMLParser

FOLDERS = ['00_SOURCE_REFERENCE', '01_PLATES', '02_MATTES_ROTO', '03_KEYS', '04_CLEAN_PLATES', '05_TRACKS_2D', '06_CAMERA_TRACK', '07_TEXTURES_REFERENCES', '08_PREVIEWS', '09_PROJECT_DATA', '10_DELIVERY']
REQUIRED = ['manifestSchemaVersion', 'generator', 'generatedAt', 'operator', 'project', 'packageVersion', 'shot', 'plates', 'roto', 'cameraTrack', 'tracks2d', 'key', 'cleanPlate', 'isolate', 'texture', 'comp', 'lighting', 'status', 'tasks', 'approval', 'sourceVerification', 'checksums', 'log']

def sha(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''):
            h.update(b)
    return h.hexdigest()

def main(folder):
    problems = []
    for f in FOLDERS:
        if not os.path.isdir(os.path.join(folder, f)):
            problems.append(f'missing folder {f}')
    m = json.load(open(os.path.join(folder, 'manifest.json')))
    for k in REQUIRED:
        if k not in m:
            problems.append(f'manifest lacks {k}')
    listed = {d['path']: d for d in m['checksums']['delivered']}
    on_disk = []
    for root, _, files in os.walk(folder):
        for n in files:
            rel = os.path.relpath(os.path.join(root, n), folder).replace(os.sep, '/')
            if n.startswith('.'):
                continue
            on_disk.append(rel)
    skip = lambda r: re.fullmatch(r'manifest(_v\d{3})?\.json', r) or r == 'prep_report.html'
    for rel in on_disk:
        if skip(rel):
            continue
        if rel not in listed:
            problems.append(f'on disk, not in manifest: {rel}')
    for rel, d in listed.items():
        p = os.path.join(folder, rel)
        if not os.path.isfile(p):
            problems.append(f'in manifest, missing: {rel}')
            continue
        if os.path.getsize(p) != d['bytes'] or sha(p) != d['value']:
            problems.append(f'checksum mismatch: {rel}')
    # Every relative path the manifest names (folders, files) exists.
    names = set()
    def walk(o, key=''):
        if isinstance(o, dict):
            for k, v in o.items():
                walk(v, k)
        elif isinstance(o, list):
            for v in o:
                walk(v, key)
        elif isinstance(o, str) and re.match(r'^(0\d|10)_[A-Z_]+/', o):
            names.add(o)
    walk({k: v for k, v in m.items() if k != 'checksums'})
    for n in sorted(names):
        p = os.path.join(folder, n)
        if '%' in n:
            d = os.path.dirname(p); pat = re.escape(os.path.basename(n))
            pat = re.sub(r'%0(\d)d', lambda mm: r'\d{' + mm.group(1) + '}', pat.replace('\\%', '%'))
            if not os.path.isdir(d) or not any(re.fullmatch(pat, x) for x in os.listdir(d)):
                problems.append(f'manifest names {n}: no such files')
        elif not os.path.exists(p):
            problems.append(f'manifest names {n}: not on disk')
    class P(HTMLParser):
        pass
    html = open(os.path.join(folder, 'prep_report.html'), encoding='utf8').read()
    P().feed(html)
    per_folder = {f: sum(1 for r in listed if r.startswith(f + '/')) for f in FOLDERS}
    print(json.dumps({
        'folder': folder,
        'packageVersion': m['packageVersion'],
        'status': m['status'],
        'approval': m['approval'],
        'tasks': [(t['kind'], t['state'], t['version'], (t['approval'] or {}).get('by')) for t in m['tasks']],
        'files': len(listed), 'per_folder': per_folder,
        'paths_named': len(names),
        'report_bytes': len(html), 'report_title': re.search(r'<title>(.*?)</title>', html).group(1),
        'problems': problems,
    }, indent=1))

if __name__ == '__main__':
    main(sys.argv[1])
