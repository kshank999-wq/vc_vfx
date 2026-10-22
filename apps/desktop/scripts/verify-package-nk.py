"""
Offline structural check of VC VFX's .nk scripts (no Nuke here; addendum 15):
balanced braces, node classes Nuke has and their input counts, the script's
TCL stack (inputs / set / push; the top of the stack is input 0), curve knob
syntax, and every file a Read or ReadGeo2 names. This is not Nuke opening the
script. Run by hand:

    python3 -I apps/desktop/scripts/verify-package-nk.py <output root>
"""
import glob, os, re, sys

# Node classes and their maximum inputs in Nuke 13+ (from Nuke's node reference).
MAX_INPUTS = {'Root': 0, 'Read': 0, 'ReadGeo2': 0, 'Camera2': 1, 'Camera3': 1, 'Axis2': 1, 'Scene': 1000, 'StickyNote': 0, 'BackdropNode': 0,
              'Write': 1, 'Merge2': 1000, 'Reformat': 1, 'Grade': 2, 'ColorCorrect': 2, 'Blur': 2, 'FilterErode': 2, 'Transform': 2,
              'CornerPin2D': 2, 'Keymix': 3, 'STMap': 2, 'Dot': 1, 'Tracker4': 2, 'Shuffle2': 2, 'Copy': 3, 'Premult': 1, 'Unpremult': 1,
              'Constant': 0, 'Viewer': 10, 'NoOp': 1, 'Switch': 1000, 'Multiply': 2, 'Clamp': 2, 'Expression': 2, 'TimeOffset': 1,
              'ScanlineRender': 3, 'Card2': 1, 'LensDistortion2': 2, 'Saturation': 2, 'Exposure': 2, 'HueCorrect': 2, 'EdgeBlur': 2, 'Erode': 2, 'Dilate': 2}
TOP = re.compile(r'^([A-Za-z][A-Za-z0-9_]*) \{$')

def strip_strings(text):
    # Remove "..." strings (with \" escapes) so braces inside labels/files do not count.
    return re.sub(r'"(?:\\.|[^"\\])*"', '""', text)

def check(path):
    text = open(path).read()
    problems, notes = [], []
    body = strip_strings(text)
    depth = 0
    for ch in body:
        depth += ch == '{'
        depth -= ch == '}'
        if depth < 0:
            problems.append('closing brace without opening'); break
    if depth != 0:
        problems.append(f'unbalanced braces ({depth})')
    lines = text.split('\n')
    stack, saved, nodes = [], {}, []
    i = 0
    script_dir = os.path.dirname(path)
    while i < len(lines):
        line = lines[i]
        m = TOP.match(line)
        if line.startswith('set ') and '[stack 0]' in line:
            name = line.split()[1]
            if not stack: problems.append(f'set {name} on an empty stack')
            else: saved[name] = stack[-1]
        elif line.startswith('push '):
            arg = line.split()[1]
            if arg == '0': stack.append(None)
            elif arg.startswith('$') and arg[1:] in saved: stack.append(saved[arg[1:]])
            else: problems.append(f'push of unknown {arg}')
        elif m:
            cls = m.group(1)
            # Gather the node's block (balanced).
            block, d = [line], 1
            j = i + 1
            while j < len(lines) and d > 0:
                s = strip_strings(lines[j])
                d += s.count('{') - s.count('}')
                block.append(lines[j]); j += 1
            knobs = '\n'.join(block)
            name = (re.search(r'^ name (\S+)$', knobs, re.M) or [None, f'<{cls}>'])[1]
            explicit = re.search(r'^ inputs (\d+)', knobs, re.M)
            n_in = int(explicit[1]) if explicit else (0 if cls == 'Root' else 1)
            if not explicit and not stack and cls not in ('Root', 'StickyNote', 'BackdropNode'):
                # A snippet's first node: pasted, it takes the selected node as its input (Nuke's default).
                notes.append(f'{name}: {cls} takes the selected node when pasted')
                n_in = 0
            if cls not in MAX_INPUTS:
                problems.append(f'unknown node class {cls}')
            elif n_in > MAX_INPUTS[cls]:
                problems.append(f'{name}: {cls} with {n_in} inputs (max {MAX_INPUTS[cls]})')
            if cls not in ('Root', 'StickyNote', 'BackdropNode'):
                if n_in > len(stack):
                    problems.append(f'{name}: needs {n_in} inputs, stack has {len(stack)}')
                ins = [stack.pop() for _ in range(min(n_in, len(stack)))]  # top of stack = input 0
                nodes.append((cls, name, ins))
                stack.append(name)
            # Curves: {curve x<frame> v v ...} well formed.
            for c in re.findall(r'\{curve ([^{}]*)\}', knobs):
                toks = c.split()
                if not toks or not re.match(r'^x-?\d+$', toks[0]) or any(not re.match(r'^(x-?\d+|-?\d+(\.\d+)?(e-?\d+)?)$', t) for t in toks):
                    problems.append(f'{name}: malformed curve "{c[:40]}"'); break
            for f in re.findall(r'^ file "([^"]+)"', knobs, re.M):
                p = f.replace('[file dirname [value root.name]]', script_dir)
                if cls == 'Write':
                    continue
                if '%' in p:
                    d_, b = os.path.split(p)
                    pat = re.escape(b).replace('%04d', r'\d{4}')
                    ok = os.path.isdir(d_) and any(re.fullmatch(pat, x) for x in os.listdir(d_))
                else:
                    ok = os.path.isfile(p)
                if not ok: problems.append(f'{name}: file not found {f}')
                else: notes.append(f'{name}: {os.path.relpath(os.path.normpath(p), script_dir)}')
            i = j
            continue
        i += 1
    return problems, nodes, notes

if __name__ == '__main__':
    files = sorted(glob.glob(os.path.join(sys.argv[1], '**', '*.nk'), recursive=True))
    allok = True
    for f in files:
        problems, nodes, notes = check(f)
        allok &= not problems
        print(('OK   ' if not problems else 'FAIL ') + os.path.relpath(f, sys.argv[1]), f'{len(nodes)} nodes')
        for cls, name, ins in nodes:
            if ins: print(f'       {name} ({cls}) <- ' + ', '.join(f'{k}:{v}' for k, v in enumerate(ins)))
        for n in notes: print('       reads ' + n)
        for p in problems: print('       !! ' + p)
    print('PASS' if allok else 'FAIL')
