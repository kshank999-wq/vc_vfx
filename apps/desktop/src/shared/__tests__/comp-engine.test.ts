import { describe, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { MERGE_OPERATIONS, type CompDocument, type CompEdge, type CompNode, type CompNodeType, type CompSource, type MergeOperation, type Track2d } from '@vcvfx/domain';
import { CompEvaluator, type CompIO } from '../comp/evaluate';
import { blank, blurRGBA, erodeRGBA, type RGBA } from '../comp/image';
import { apply3, cornerPinMatrix, gradeValue, merge, trackCornerPin, transformMatrix, warpMatrix } from '../comp/ops';
import { parseNukeTopology, writeCompNuke, type NukeSource } from '../comp/nuke';

/**
 * The compositor's engine (addendum 13 §3, §6): each Merge operation against
 * the reference formulas, premultiplication, Nuke's Grade, transforms and
 * corner pins with known matrices, blur and erode on test patterns, the
 * cache (a parameter change recomputes only downstream), and the Nuke
 * script: a golden file and its topology read back.
 */

const W = 32;
const H = 24;

function node(id: string, type: CompNodeType, name: string, params: Record<string, unknown> = {}, extra: Partial<CompNode> = {}): CompNode {
  return { id, type, name, x: 0, y: 0, params: params as CompNode['params'], disabled: false, note: '', ...extra };
}
const doc = (nodes: CompNode[], edges: CompEdge[]): Pick<CompDocument, 'nodes' | 'edges'> => ({ nodes, edges });

function solid(r: number, g: number, b: number, a: number, w = W, h = H): RGBA {
  const img = blank(w, h);
  for (let i = 0; i < w * h; i += 1) img.data.set([r, g, b, a], 4 * i);
  return img;
}
function dot(x: number, y: number, w = W, h = H): RGBA {
  const img = blank(w, h);
  img.data.set([1, 1, 1, 1], 4 * (y * w + x));
  return img;
}
/** Centroid of alpha, continuous coordinates (pixel centres at +½). */
function centroid(img: RGBA): [number, number] {
  let s = 0;
  let sx = 0;
  let sy = 0;
  for (let y = 0; y < img.height; y += 1)
    for (let x = 0; x < img.width; x += 1) {
      const a = img.data[4 * (y * img.width + x) + 3]!;
      s += a;
      sx += a * (x + 0.5);
      sy += a * (y + 0.5);
    }
  return [sx / s, sy / s];
}

/** An in-memory IO: sources are fixed pictures; counts reads. */
function memIO(sources: Partial<Record<CompSource, (frame: number) => RGBA>>, tracks: Track2d[] = []): CompIO & { reads: number } {
  const io = {
    reads: 0,
    plate: { width: W, height: H },
    tracks: new Map(tracks.map((t) => [t.id, t])),
    source: async (s: CompSource, _part: string, frame: number) => {
      io.reads += 1;
      const f = sources[s];
      if (!f) throw new Error(`no ${s}`);
      return f(frame);
    },
  };
  return io;
}

// The reference formulas (Nuke's Merge2 documentation, Porter & Duff 1984), written out independently.
const REF: Record<MergeOperation, (A: number, B: number, a: number, b: number) => number> = {
  over: (A, B, a) => A + B * (1 - a),
  under: (A, B, _a, b) => A * (1 - b) + B,
  plus: (A, B) => A + B,
  minus: (A, B) => A - B,
  multiply: (A, B) => A * B,
  screen: (A, B) => (A <= 1 && B <= 1 && A >= 0 && B >= 0 ? 1 - (1 - A) * (1 - B) : Math.max(A, B)),
  stencil: (_A, B, a) => B * (1 - a),
  mask: (_A, B, a) => B * a,
  in: (A, _B, _a, b) => A * b,
  out: (A, _B, _a, b) => A * (1 - b),
  atop: (A, B, a, b) => A * b + B * (1 - a),
  difference: (A, B) => Math.abs(A - B),
  max: (A, B) => Math.max(A, B),
  min: (A, B) => Math.min(A, B),
  average: (A, B) => 0.5 * (A + B),
  copy: (A) => A,
};

describe('Merge', () => {
  it('every operation matches its reference formula on every channel, alpha included', () => {
    // Premultiplied A = 0.6·(0.5, 0.2, 0.9), B = 0.8·(0.3, 0.7, 0.1).
    const A = solid(0.3, 0.12, 0.54, 0.6, 2, 1);
    const B = solid(0.24, 0.56, 0.08, 0.8, 2, 1);
    for (const op of MERGE_OPERATIONS) {
      const out = merge(op, A, B, null, 1, 2, 1).data;
      const want = [0, 1, 2, 3].map((c) => REF[op](A.data[c]!, B.data[c]!, 0.6, 0.8));
      expect([...out.slice(0, 4)].map((v) => +v.toFixed(6)), op).toEqual(want.map((v) => +v.toFixed(6)));
    }
  });

  it('over premultiplied equals the unpremultiplied blend, and a half mask / mix blends back to B', () => {
    const fg = [0.9, 0.4, 0.1];
    const alpha = 0.25;
    const bg = [0.1, 0.2, 0.3];
    const A = solid(fg[0]! * alpha, fg[1]! * alpha, fg[2]! * alpha, alpha, 1, 1);
    const B = solid(bg[0]!, bg[1]!, bg[2]!, 1, 1, 1);
    const out = merge('over', A, B, null, 1, 1, 1).data;
    for (let c = 0; c < 3; c += 1) expect(out[c]).toBeCloseTo(alpha * fg[c]! + (1 - alpha) * bg[c]!, 6);
    expect(out[3]).toBeCloseTo(1, 6);
    const half = merge('over', A, B, solid(0, 0, 0, 0.5, 1, 1), 1, 1, 1).data;
    const mix = merge('over', A, B, null, 0.5, 1, 1).data;
    for (let c = 0; c < 4; c += 1) {
      expect(half[c]).toBeCloseTo(B.data[c]! + 0.5 * (out[c]! - B.data[c]!), 6);
      expect(mix[c]).toBeCloseTo(half[c]!, 6);
    }
    // No A: over gives B.
    expect([...merge('over', null, B, null, 1, 1, 1).data]).toEqual([...B.data]);
  });
});

describe('Grade', () => {
  it('is Nuke’s formula: black/white point, lift, gain, multiply, offset, gamma, exposure', () => {
    const g = { blackpoint: 0, whitepoint: 1, lift: 0, gain: 1, multiply: 1, offset: 0, gamma: 1, exposure: 0, blackClamp: true, whiteClamp: false, unpremult: false };
    for (const x of [-0.5, 0, 0.18, 1, 4]) expect(gradeValue(x, g)).toBeCloseTo(Math.max(0, x), 9);
    expect(gradeValue(0.18, { ...g, gain: 2 })).toBeCloseTo(0.36, 9);
    expect(gradeValue(0.18, { ...g, exposure: 1 })).toBeCloseTo(0.36, 9);
    expect(gradeValue(0.5, { ...g, gamma: 2 })).toBeCloseTo(Math.sqrt(0.5), 9);
    // Black point → lift, white point → gain.
    const bw = { ...g, blackpoint: 0.1, whitepoint: 0.9, lift: 0.05, gain: 1.5 };
    expect(gradeValue(0.1, bw)).toBeCloseTo(0.05, 9);
    expect(gradeValue(0.9, bw)).toBeCloseTo(1.5, 9);
    expect(gradeValue(0.5, { ...g, offset: 0.1, multiply: 2 })).toBeCloseTo(1.1, 9);
    expect(gradeValue(0.5, { ...g, offset: -1 })).toBe(0);
    expect(gradeValue(0.5, { ...g, offset: -1, blackClamp: false })).toBeCloseTo(-0.5, 9);
    expect(gradeValue(3, { ...g, whiteClamp: true })).toBe(1);
  });
});

describe('Transform and CornerPin', () => {
  it('translate moves exactly; a 90° turn about the centre is counter-clockwise on screen', async () => {
    const m = transformMatrix({ translate: [3, -2], rotate: 0, scale: [1, 1], center: [16, 12], invert: false });
    const moved = warpMatrix(dot(10, 10), m, 'impulse');
    expect(centroid(moved)).toEqual([13.5, 8.5]);
    const r = transformMatrix({ translate: [0, 0], rotate: 90, scale: [1, 1], center: [16, 12], invert: false });
    // A point right of the centre goes above it (y down: smaller y).
    const [x, y] = apply3(r, 20, 12);
    expect(x).toBeCloseTo(16, 9);
    expect(y).toBeCloseTo(8, 9);
    const turned = warpMatrix(dot(19, 11), r, 'bilinear');
    const c = centroid(turned);
    expect(c[0]).toBeCloseTo(16 - 0.5 + 0.5 + (11.5 - 12), 1);
    expect(c[1]).toBeCloseTo(12 - (19.5 - 16), 1);
  });

  it('a corner pin is the homography of its four corners; with a planar track it match-moves and stabilises', () => {
    const from: [number, number][] = [
      [0, 0],
      [32, 0],
      [32, 24],
      [0, 24],
    ];
    const to: [number, number][] = [
      [4, 2],
      [30, 5],
      [28, 22],
      [2, 20],
    ];
    const Hm = cornerPinMatrix(from, to)!;
    from.forEach((p, i) => {
      const q = apply3(Hm, p[0], p[1]);
      expect(q[0]).toBeCloseTo(to[i]![0], 6);
      expect(q[1]).toBeCloseTo(to[i]![1], 6);
    });
    // A dot under the pin lands where the homography says.
    const pinned = warpMatrix(dot(16, 12), Hm, 'bilinear');
    const want = apply3(Hm, 16.5, 12.5);
    const got = centroid(pinned);
    expect(got[0]).toBeCloseTo(want[0], 0);
    expect(got[1]).toBeCloseTo(want[1], 0);
    const track: Track2d = {
      id: 'screen',
      name: 'Screen',
      kind: 'planar',
      color: '#ff0000',
      keys: [{ frame: 1001, points: [[4, 4], [12, 4], [12, 10], [4, 10]], by: 't', at: 'x' }],
      frames: [
        { frame: 1001, points: [[4, 4], [12, 4], [12, 10], [4, 10]], confidence: 1, status: 'key' },
        { frame: 1002, points: [[7, 5], [15, 5], [15, 11], [7, 11]], confidence: 1, status: 'tracked' },
      ],
      occluders: [],
      pattern: 12,
      search: 48,
      engine: '',
    };
    const mm = trackCornerPin(track, 1002, 0, 'matchmove', 1)!;
    const [mx, my] = apply3(mm, 8.5, 7.5);
    expect(mx).toBeCloseTo(11.5, 6);
    expect(my).toBeCloseTo(8.5, 6);
    const st = trackCornerPin(track, 1002, 0, 'stabilise', 1)!;
    const back = apply3(st, mx, my);
    expect(back[0]).toBeCloseTo(8.5, 6);
    expect(back[1]).toBeCloseTo(7.5, 6);
    // At half-size proxy, the same pin in half-size pixels.
    const half = trackCornerPin(track, 1002, 0, 'matchmove', 0.5)!;
    expect(apply3(half, 4.25, 3.75)[0]).toBeCloseTo(5.75, 6);
  });
});

describe('Blur and Erode', () => {
  it('blur keeps the total and spreads a dot by about σ', () => {
    const img = dot(16, 12);
    const out = blurRGBA(img, 3, false);
    let sum = 0;
    let vx = 0;
    for (let y = 0; y < H; y += 1)
      for (let x = 0; x < W; x += 1) {
        const a = out.data[4 * (y * W + x) + 3]!;
        sum += a;
        vx += a * (x - 16) ** 2;
      }
    expect(sum).toBeCloseTo(1, 4);
    expect(Math.sqrt(vx / sum)).toBeGreaterThan(2.6);
    expect(Math.sqrt(vx / sum)).toBeLessThan(3.4);
    // Alpha only: colour untouched.
    const a = blurRGBA(img, 3, true);
    expect(a.data[4 * (12 * W + 16)]).toBe(1);
    expect(a.data[4 * (12 * W + 16) + 3]).toBeLessThan(0.2);
  });

  it('erode shrinks a square matte by its size, a negative size grows it, a fraction blends', () => {
    const sq = blank(W, H);
    for (let y = 6; y < 18; y += 1) for (let x = 10; x < 22; x += 1) sq.data.set([1, 1, 1, 1], 4 * (y * W + x));
    const area = (img: RGBA) => {
      let s = 0;
      for (let i = 0; i < W * H; i += 1) s += img.data[4 * i + 3]!;
      return s;
    };
    expect(area(sq)).toBe(144);
    expect(area(erodeRGBA(sq, 2, true))).toBeCloseTo(64, 6); // 12 − 4 = 8 on a side
    expect(area(erodeRGBA(sq, -1, true))).toBeCloseTo(196, 6); // 14 on a side
    expect(area(erodeRGBA(sq, 1.5, true))).toBeCloseTo((100 + 64) / 2, 6);
    // Alpha only: colour untouched.
    expect(erodeRGBA(sq, 2, true).data[4 * (6 * W + 10)]).toBe(1);
  });
});

describe('the evaluator and its cache', () => {
  const graph = () =>
    doc(
      [node('n1', 'read', 'Plate', { source: 'plate' }), node('n2', 'grade', 'Grade1'), node('n3', 'constant', 'Grey'), node('n4', 'read', 'Fg', { source: 'key_foreground' }), node('n5', 'merge', 'Merge1'), node('n6', 'write', 'Write1')],
      [
        { from: 'n1', to: 'n2', input: 'src' },
        { from: 'n2', to: 'n5', input: 'B' },
        { from: 'n4', to: 'n5', input: 'A' },
        { from: 'n5', to: 'n6', input: 'src' },
      ],
    );
  const io = () => memIO({ plate: (f) => solid(0.1 * (f - 1000), 0.2, 0.3, 1), key_foreground: () => solid(0.25, 0, 0, 0.5) });

  it('computes the composite, and a parameter change recomputes only what is downstream', async () => {
    const d = graph();
    const ev = new CompEvaluator(io());
    const out = await ev.evaluate(d, 'n6', 1001, { scale: 1 });
    expect(out.data[0]).toBeCloseTo(0.25 + 0.1 * 0.5, 6);
    expect(Object.fromEntries(ev.stats.evaluations)).toEqual({ n6: 1, n5: 1, n2: 1, n1: 1, n4: 1 });
    // Gain on the grade: the plate and the foreground are not read again.
    const changed = doc(
      d.nodes.map((n) => (n.id === 'n2' ? { ...n, params: { gain: 2 } } : n)),
      d.edges,
    );
    ev.resetStats();
    const out2 = await ev.evaluate(changed, 'n6', 1001, { scale: 1 });
    expect(out2.data[0]).toBeCloseTo(0.25 + 0.2 * 0.5, 6);
    expect(Object.fromEntries(ev.stats.evaluations)).toEqual({ n6: 1, n5: 1, n2: 1 });
    expect(ev.stats.hits).toBe(2);
    // Back to the first settings: all from the cache.
    ev.resetStats();
    await ev.evaluate(d, 'n6', 1001, { scale: 1 });
    expect(ev.stats.misses).toBe(0);
    // Another frame: the moving plate is read again; the still foreground… is also per frame (a sequence), the constant is not.
    ev.resetStats();
    const c = doc([...d.nodes], [...d.edges, { from: 'n3', to: 'n5', input: 'mask' }]);
    await ev.evaluate(c, 'n6', 1002, { scale: 1 });
    await ev.evaluate(c, 'n6', 1003, { scale: 1 });
    expect(ev.stats.evaluations.get('n3')).toBe(1);
    expect(ev.stats.evaluations.get('n1')).toBe(2);
  });

  it('a bypassed node passes its input from the cache; a proxy is its own size', async () => {
    const d = graph();
    const ev = new CompEvaluator(io());
    await ev.evaluate(d, 'n1', 1001, { scale: 1 });
    ev.resetStats();
    const bypassed = doc(
      d.nodes.map((n) => (n.id === 'n2' ? { ...n, disabled: true, params: { gain: 3 } } : n)),
      d.edges,
    );
    const pass = await ev.evaluate(bypassed, 'n2', 1001, { scale: 1 });
    expect(pass.data[0]).toBeCloseTo(0.1, 6);
    expect(ev.stats.misses).toBe(0);
    const proxy = await ev.evaluate(d, 'n6', 1001, { scale: 0.5 });
    expect([proxy.width, proxy.height]).toEqual([16, 12]);
    expect(proxy.data[0]).toBeCloseTo(0.3, 5);
  });

  it('says which node fails and why', async () => {
    const d = doc([node('n1', 'read', 'Bg', { source: 'cleanplate' }), node('n2', 'write', 'Write1')], [{ from: 'n1', to: 'n2', input: 'src' }]);
    await expect(new CompEvaluator(memIO({})).evaluate(d, 'n2', 1001, { scale: 1 })).rejects.toThrow('Bg: no cleanplate');
    const open = doc([node('n1', 'grade', 'Grade1')], []);
    await expect(new CompEvaluator(memIO({})).evaluate(open, 'n1', 1001, { scale: 1 })).rejects.toThrow('Grade1: needs its src input connected');
  });
});

describe('the Nuke script', () => {
  const tracks: Track2d[] = [
    {
      id: 'screen',
      name: 'Screen',
      kind: 'planar',
      color: '#ff0000',
      keys: [{ frame: 1001, points: [[4, 4], [12, 4], [12, 10], [4, 10]], by: 't', at: 'x' }],
      frames: [
        { frame: 1001, points: [[4, 4], [12, 4], [12, 10], [4, 10]], confidence: 1, status: 'key' },
        { frame: 1002, points: [[5, 4], [13, 4], [13, 10], [5, 10]], confidence: 1, status: 'tracked' },
      ],
      occluders: [],
      pattern: 12,
      search: 48,
      engine: '',
    },
  ];
  const graph = doc(
    [
      node('n1', 'read', 'Read_plate', { source: 'plate' }, { x: 0, y: 0 }),
      node('n2', 'keyer', 'Keyer1', {}, { x: 200, y: 0 }),
      node('n3', 'read', 'Read_background', { source: 'background' }, { x: 400, y: 0 }),
      node('n4', 'lightwrap', 'LightWrap1', {}, { x: 200, y: 100 }),
      node('n5', 'merge', 'Merge1', { operation: 'over', mix: 0.8 }, { x: 400, y: 200 }),
      node('n6', 'grade', 'Grade1', { gain: 1.2, exposure: 1 }, { x: 400, y: 300 }),
      node('n7', 'roto', 'Roto1', {}, { x: 600, y: 200 }),
      node('n8', 'constant', 'Insert', { color: [1, 0.5, 0, 1] }, { x: 800, y: 0 }),
      node('n9', 'cornerpin', 'CornerPin1', { track: 'screen' }, { x: 800, y: 100 }),
      node('n10', 'merge', 'Merge2', { operation: 'over' }, { x: 400, y: 400 }),
      node('n11', 'write', 'Write1', {}, { x: 400, y: 500 }),
      node('n12', 'transform', 'Transform1', { translate: [10, 5], rotate: 15 }, { x: 0, y: 200 }),
    ],
    [
      { from: 'n2', to: 'n4', input: 'fg' },
      { from: 'n3', to: 'n4', input: 'bg' },
      { from: 'n3', to: 'n5', input: 'B' },
      { from: 'n4', to: 'n5', input: 'A' },
      { from: 'n7', to: 'n6', input: 'mask' },
      { from: 'n5', to: 'n6', input: 'src' },
      { from: 'n8', to: 'n9', input: 'src' },
      { from: 'n6', to: 'n10', input: 'B' },
      { from: 'n9', to: 'n10', input: 'A' },
      { from: 'n10', to: 'n11', input: 'src' },
      { from: 'n1', to: 'n12', input: 'src' },
    ],
  );
  const src = (path: string, kind: NukeSource['kind'], encoding: NukeSource['encoding'], label: string, still = false): NukeSource => ({ path, relative: true, first: 1001, last: 1002, still, kind, encoding, label });
  const info = {
    shot: '010_020',
    version: 1,
    generator: 'VC VFX test',
    writtenAt: '2026-10-22T12:00:00.000Z',
    fps: 24,
    first: 1001,
    last: 1002,
    width: 4096,
    height: 2160,
    working: 'acescg' as const,
    sources: new Map([
      ['n1', src('../../01_PLATES/010_020_plate_v001.%04d.exr', 'rgb', 'acescg', 'plates v001')],
      ['n2', src('../../03_KEYS/010_020_key_v001/010_020_key_fg_v001.%04d.exr', 'rgba', 'acescg', 'Key v001 foreground')],
      ['n3', { ...src('VFX/SCENE_12A/BG/city_night_plate.exr', 'rgb', 'acescg', 'Background city_night_plate.exr', true), relative: false }],
      ['n7', src('../../02_MATTES_ROTO/010_020_matte_v001/010_020_matte_v001.%04d.png', 'alpha', null, 'Roto v001 matte')],
    ]),
    baked: new Map([['n4', src('baked/010_020_comp_LightWrap1_v001.%04d.exr', 'rgba', 'acescg', 'LightWrap1 (baked)')]]),
    writePath: 'nuke_render/010_020_comp_nk_v001.%04d.exr',
    tracks: new Map(tracks.map((t) => [t.id, t])),
    moduleNotes: new Map([['n2', 'screen green, despill average']]),
  };

  it('matches the golden file', async () => {
    const nk = writeCompNuke(graph, info);
    const golden = join(__dirname, 'fixtures', 'comp-golden.nk');
    if (!existsSync(golden) || process.env['UPDATE_GOLDEN']) await writeFile(golden, nk.text);
    expect(nk.text).toBe(await readFile(golden, 'utf8'));
    expect(nk.untranslated.some((u) => u.startsWith('LightWrap1 (LightWrap): no Nuke node; baked'))).toBe(true);
  });

  it('read back, its topology is the graph’s: Merge2 B is input 0 and A input 1, masks, module Reads, the baked Read', () => {
    const nodes = parseNukeTopology(writeCompNuke(graph, info).text);
    const n = (name: string) => nodes.find((x) => x.name === name)!;
    expect(n('Merge1')).toMatchObject({ cls: 'Merge2', inputs: ['Read_background', 'LightWrap1'] });
    expect(n('Merge1').knobs['operation']).toBe('over');
    expect(n('Merge1').knobs['mix']).toBe('0.8');
    expect(n('Grade1')).toMatchObject({ cls: 'Grade', inputs: ['Merge1', 'Roto1'] });
    expect(n('Grade1').knobs['multiply']).toBe('2');
    expect(n('Grade1').knobs['white']).toBe('1.2');
    expect(n('Grade1').knobs['maskChannelInput']).toBe('rgba.alpha');
    expect(n('Merge2')).toMatchObject({ cls: 'Merge2', inputs: ['Grade1', 'CornerPin1'] });
    expect(n('Write1')).toMatchObject({ cls: 'Write', inputs: ['Merge2'] });
    expect(n('Write1').knobs['colorspace']).toBe('"ACES - ACEScg"');
    expect(n('CornerPin1')).toMatchObject({ cls: 'CornerPin2D', inputs: ['Insert'] });
    expect(n('CornerPin1').knobs['to1']).toBe('{{curve x1001 4.5 x1002 5.5} {curve x1001 2149.5 x1002 2149.5}}');
    expect(n('CornerPin1').knobs['from1']).toBe('{4.5 2149.5}');
    // The roto matte: a raw Read shuffled to alpha.
    expect(n('Roto1_read')).toMatchObject({ cls: 'Read', inputs: [] });
    expect(n('Roto1_read').knobs['raw']).toBe('true');
    expect(n('Roto1')).toMatchObject({ cls: 'Shuffle', inputs: ['Roto1_read'] });
    expect(n('Keyer1')).toMatchObject({ cls: 'Read' });
    expect(n('Keyer1').knobs['file']).toBe('"[file dirname [value root.name]]/../../03_KEYS/010_020_key_v001/010_020_key_fg_v001.%04d.exr"');
    expect(n('LightWrap1')).toMatchObject({ cls: 'Read', inputs: [] });
    expect(n('Read_background')).toMatchObject({ cls: 'Reformat', inputs: ['Read_background_read'] });
    // Translate y flips for Nuke's y-up.
    expect(n('Transform1').knobs['translate']).toBe('{10 -5}');
    expect(n('Transform1').knobs['center']).toBe('{2048 1080}');
    expect(n('Transform1').inputs).toEqual(['Read_plate']);
    // Sticky notes name the module nodes.
    expect(nodes.filter((x) => x.cls === 'StickyNote').map((x) => x.name).sort()).toEqual(['Keyer1_note', 'LightWrap1_note', 'Roto1_note']);
  });

  it('a mask on a transform becomes a Keymix; a shared node is pushed again; a missing A is push 0', () => {
    const g = doc(
      [node('n1', 'read', 'Plate', { source: 'plate' }), node('n2', 'transform', 'T1', { translate: [4, 0] }), node('n3', 'roto', 'Roto1'), node('n4', 'merge', 'M1'), node('n5', 'write', 'W1'), node('n6', 'merge', 'M2', { operation: 'plus' })],
      [
        { from: 'n1', to: 'n2', input: 'src' },
        { from: 'n3', to: 'n2', input: 'mask' },
        { from: 'n2', to: 'n4', input: 'B' },
        { from: 'n3', to: 'n4', input: 'mask' },
        { from: 'n4', to: 'n6', input: 'B' },
        { from: 'n1', to: 'n6', input: 'A' },
        { from: 'n6', to: 'n5', input: 'src' },
      ],
    );
    const nodes = parseNukeTopology(writeCompNuke(g, { ...info, sources: new Map([['n1', info.sources.get('n1')!], ['n3', info.sources.get('n7')!]]), baked: new Map() }).text);
    const n = (name: string) => nodes.find((x) => x.name === name)!;
    expect(n('T1_moved')).toMatchObject({ cls: 'Transform', inputs: ['Plate'] });
    expect(n('T1')).toMatchObject({ cls: 'Keymix', inputs: ['Plate', 'T1_moved', 'Roto1'] });
    expect(n('M1')).toMatchObject({ cls: 'Merge2', inputs: ['T1', null, 'Roto1'] });
    expect(n('M2')).toMatchObject({ cls: 'Merge2', inputs: ['M1', 'Plate'] });
    expect(n('W1').inputs).toEqual(['M2']);
    expect(nodes.filter((x) => x.cls === 'Read' && x.name === 'Plate')).toHaveLength(1);
  });
});
