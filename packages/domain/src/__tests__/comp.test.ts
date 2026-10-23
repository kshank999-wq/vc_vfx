import { describe, expect, it } from 'vitest';
import {
  COMP_NODES,
  COMP_NODE_TYPES,
  PREP_TASKS,
  PROJECT_VERSION,
  SAMPLE_HANDOFF,
  addCompNode,
  addTask,
  approveTask,
  buildManifest,
  compAutoLayout,
  compDoc,
  compErrors,
  compGraphData,
  compLocked,
  compManifest,
  compNames,
  compNode,
  compNodeParams,
  compOutputKind,
  compRenderRange,
  compSourceProblems,
  connectComp,
  createProject,
  disconnectComp,
  layoutComp,
  moveCompNodes,
  parseHandoff,
  parseProject,
  recordCompExport,
  recordCompRender,
  recordKeyExport,
  removeCompNodes,
  renameCompNode,
  resetCompParams,
  resolveCompSource,
  restoreCompGraph,
  serializeProject,
  setCompDisabled,
  setCompParams,
  setCompRenderSettings,
  setCompViewer,
  setTaskState,
  shotState,
  startComp,
  suggestedCompGraph,
  validateCompGraph,
  type CompDocument,
  type CompExportInput,
  type CompRenderInput,
  type Project,
  type Result,
} from '../index.js';

const NOW = new Date('2026-10-22T12:00:00Z');
const SHOT = '010_020'; // key + roto, a background reference
const ok = (r: Result): Project => {
  if (!r.ok) throw new Error(r.reason);
  return r.project;
};
const sample = (): Project => {
  const r = parseHandoff(JSON.stringify(SAMPLE_HANDOFF));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return createProject(r.handoff, '/Volumes/DRIVE/handoff.json', 'dit', NOW);
};
const withComp = () => ok(addTask(sample(), SHOT, 'composite', 'ana', NOW));
const doc = (p: Project): CompDocument => compDoc(shotState(p, SHOT))!;
const task = (p: Project) => shotState(p, SHOT)!.tasks.find((t) => t.kind === 'composite')!;
const byName = (p: Project, name: string) => doc(p).nodes.find((n) => n.name === name)!;
const lastLog = (p: Project) => p.log[p.log.length - 1]!;

function renderRecord(p: Project): CompRenderInput {
  const d = doc(p);
  return {
    version: task(p).version,
    revision: d.revision,
    folder: `08_PREVIEWS/${compNames.folder(SHOT, task(p).version)}`,
    pattern: compNames.renderPattern(SHOT, task(p).version),
    review: compNames.reviewPattern(SHOT, task(p).version, 'jpeg'),
    first: 1001,
    last: 1128,
    frames: 128,
    width: 4096,
    height: 2160,
    encoding: 'ACEScg (linear AP1)',
    write: 'Write1',
    references: [{ node: 'n2', source: 'key_foreground', version: 1, path: '03_KEYS/010_020_key_v001/010_020_key_fg_v001.%04d.exr', label: 'Key v001 foreground' }],
    seconds: 64,
    files: 256,
    algorithm: 'vcvfx-comp@1.0.0',
  };
}
function exportRecord(p: Project): CompExportInput {
  const v = task(p).version;
  return {
    version: v,
    revision: doc(p).revision,
    folder: `09_PROJECT_DATA/${compNames.folder(SHOT, v)}`,
    graph: compNames.graph(SHOT, v),
    nuke: compNames.nuke(SHOT, v),
    manifest: compNames.manifest(SHOT, v),
    readme: 'README.txt',
    baked: [{ node: 'n5', name: 'LightWrap1', pattern: compNames.bakedPattern(SHOT, v, 'LightWrap1') }],
    untranslated: ['LightWrap1: baked'],
    render: `08_PREVIEWS/${compNames.folder(SHOT, v)}`,
    files: 6,
  };
}

describe('the comp task', () => {
  it('is available, files into 09_PROJECT_DATA, and every node type is described', () => {
    expect(PREP_TASKS.composite).toMatchObject({ available: true, folder: '09_PROJECT_DATA' });
    for (const t of COMP_NODE_TYPES) {
      const info = COMP_NODES[t];
      expect(info.label).toMatch(/^[A-Za-z]+$/);
      if (info.pass) expect(info.inputs.some((i) => i.name === info.pass)).toBe(true);
      for (const p of info.params) expect(compNodeParams({ type: t, params: {} })[p.key]).toEqual(p.default);
    }
  });

  it('is refused without the task, and locked once approved', () => {
    expect(startComp(sample(), SHOT, 'suggested', 'ana', NOW)).toMatchObject({ ok: false, reason: expect.stringContaining('no Prep composite task') });
    expect(compLocked(shotState(withComp(), SHOT)!)).toBeNull();
  });
});

describe('the suggested graph', () => {
  it('for a key shot: the key’s foreground light-wrapped and merged over the background reference, into a Write', () => {
    const p = ok(startComp(withComp(), SHOT, 'suggested', 'ana', NOW));
    const d = doc(p);
    expect(d.nodes.map((n) => `${n.name}:${n.type}`)).toEqual(['Read_plate:read', 'Keyer1:keyer', 'Read_background:read', 'LightWrap1:lightwrap', 'Merge1:merge', 'Write1:write']);
    const edge = (from: string, to: string, input: string) => d.edges.some((e) => e.from === byName(p, from).id && e.to === byName(p, to).id && e.input === input);
    expect(edge('Keyer1', 'LightWrap1', 'fg') && edge('Read_background', 'LightWrap1', 'bg')).toBe(true);
    expect(edge('Read_background', 'Merge1', 'B') && edge('LightWrap1', 'Merge1', 'A') && edge('Merge1', 'Write1', 'src')).toBe(true);
    expect(d.viewer).toEqual({ a: byName(p, 'Merge1').id, b: byName(p, 'Read_plate').id });
    expect(validateCompGraph(d).filter((x) => x.severity !== 'info')).toEqual([]);
    // The plate is not used by the render: said, not an error.
    expect(validateCompGraph(d).find((x) => x.severity === 'info')?.message).toContain('Read_plate is not used');
    expect(task(p).state).toBe('processing');
    expect(p.log.slice(-3).map((l) => l.action)).toEqual(['comp.started', 'comp.graph', 'task.state']);
    // The Write is at the bottom and B sits straight above its Merge.
    expect(byName(p, 'Write1').y).toBeGreaterThan(byName(p, 'Merge1').y);
    expect(byName(p, 'Read_background').y).toBeLessThan(byName(p, 'Merge1').y);
  });

  it('for other shots: roto, clean plate, isolation, or just the plate', () => {
    const roto = sample();
    roto.shots = roto.shots.map((s) => (s.shotId === SHOT ? { ...s, tasks: s.tasks.filter((t) => t.kind === 'roto') } : s));
    expect(suggestedCompGraph(roto, SHOT).nodes.map((n) => n.type)).toEqual(['read', 'roto', 'copy', 'premult', 'constant', 'merge', 'write']);
    expect(suggestedCompGraph(sample(), '020_010').nodes.map((n) => n.type)).toEqual(['read', 'cleanplate', 'write']);
    expect(suggestedCompGraph(sample(), '030_010').nodes.map((n) => `${n.type}:${String(n.params['output'] ?? '')}`)).toEqual(['read:', 'isolate:foreground', 'isolate:plate', 'merge:', 'write:']);
    expect(suggestedCompGraph(sample(), '010_030').nodes.map((n) => n.type)).toEqual(['read', 'write']);
  });

  it('starts empty as Read → Write, and does not replace a graph', () => {
    const p = ok(startComp(withComp(), SHOT, 'empty', 'ana', NOW));
    expect(doc(p).nodes.map((n) => n.type)).toEqual(['read', 'write']);
    expect(startComp(p, SHOT, 'suggested', 'ana', NOW).ok).toBe(false);
  });
});

describe('editing the graph', () => {
  const start = () => ok(startComp(withComp(), SHOT, 'suggested', 'ana', NOW));

  it('adds nodes with free names, inserting after the selected node as Nuke does', () => {
    let p = start();
    const merge = byName(p, 'Merge1');
    const writeY = byName(p, 'Write1').y;
    p = ok(addCompNode(p, SHOT, 'grade', { after: merge.id }, 'ana', NOW));
    // Under the Merge, and what was below it moved down a row to make room.
    expect(byName(p, 'Grade1')).toMatchObject({ x: merge.x, y: merge.y + 76 });
    expect(byName(p, 'Write1').y).toBe(writeY + 76);
    const grade = byName(p, 'Grade1');
    expect(grade).toBeTruthy();
    expect(doc(p).edges).toContainEqual({ from: merge.id, to: grade.id, input: 'src' });
    expect(doc(p).edges).toContainEqual({ from: grade.id, to: byName(p, 'Write1').id, input: 'src' });
    expect(lastLog(p)).toMatchObject({ action: 'comp.node_added', detail: 'Grade1 (Grade) after Merge1' });
    p = ok(addCompNode(p, SHOT, 'grade', { x: 10, y: 20 }, 'ana', NOW));
    expect(byName(p, 'Grade2')).toMatchObject({ x: 10, y: 20 });
    expect(addCompNode(p, SHOT, 'write', {}, 'ana', NOW).ok).toBe(false);
    expect(addCompNode(p, SHOT, 'grade', { name: 'Grade1' }, 'ana', NOW).ok).toBe(false);
    expect(addCompNode(p, SHOT, 'grade', { params: { gain: 99 } }, 'ana', NOW).ok).toBe(false);
  });

  it('connects, refusing loops and kinds that do not fit; replaces what an input had', () => {
    let p = start();
    const merge = byName(p, 'Merge1');
    const wrap = byName(p, 'LightWrap1');
    expect(connectComp(p, SHOT, { from: merge.id, to: wrap.id, input: 'bg' }, 'ana', NOW)).toMatchObject({ ok: false, reason: expect.stringContaining('loop') });
    p = ok(addCompNode(p, SHOT, 'roto', { x: 0, y: 0 }, 'ana', NOW));
    const roto = byName(p, 'Roto1');
    expect(connectComp(p, SHOT, { from: roto.id, to: wrap.id, input: 'bg' }, 'ana', NOW)).toMatchObject({ ok: false, reason: expect.stringContaining('a matte has no colour') });
    const plate = byName(p, 'Read_plate');
    expect(connectComp(p, SHOT, { from: plate.id, to: merge.id, input: 'mask' }, 'ana', NOW)).toMatchObject({ ok: false, reason: expect.stringContaining('has no matte') });
    p = ok(connectComp(p, SHOT, { from: roto.id, to: merge.id, input: 'mask' }, 'ana', NOW));
    p = ok(connectComp(p, SHOT, { from: plate.id, to: merge.id, input: 'B' }, 'ana', NOW));
    expect(lastLog(p).detail).toBe('Read_plate → Merge1.B (was Read_background)');
    expect(doc(p).edges.filter((e) => e.to === merge.id && e.input === 'B')).toHaveLength(1);
    const rev = doc(p).revision;
    p = ok(disconnectComp(p, SHOT, merge.id, 'mask', 'ana', NOW));
    expect(doc(p).revision).toBe(rev + 1);
    expect(disconnectComp(p, SHOT, merge.id, 'mask', 'ana', NOW).ok).toBe(false);
  });

  it('logs a parameter change compactly, keeps only what differs from the defaults, and resets', () => {
    let p = start();
    p = ok(addCompNode(p, SHOT, 'grade', { after: byName(p, 'Merge1').id }, 'ana', NOW));
    const g = byName(p, 'Grade1');
    const rev = doc(p).revision;
    p = ok(setCompParams(p, SHOT, g.id, { gain: 1.2, gamma: 1 }, 'ana', NOW));
    expect(lastLog(p)).toMatchObject({ action: 'comp.params', detail: 'Grade1.gain 1 → 1.2' });
    expect(byName(p, 'Grade1').params).toEqual({ gain: 1.2 });
    expect(doc(p).revision).toBe(rev + 1);
    const before = p.log.length;
    expect(ok(setCompParams(p, SHOT, g.id, { gain: 1.2 }, 'ana', NOW)).log.length).toBe(before);
    expect(setCompParams(p, SHOT, g.id, { gain: -1 }, 'ana', NOW).ok).toBe(false);
    expect(setCompParams(p, SHOT, g.id, { nonsense: 1 }, 'ana', NOW).ok).toBe(false);
    p = ok(setCompParams(p, SHOT, byName(p, 'Merge1').id, { operation: 'screen', mix: 0.5 }, 'ana', NOW));
    expect(lastLog(p).detail).toBe('Merge1.operation over → screen, Merge1.mix 1 → 0.5');
    p = ok(resetCompParams(p, SHOT, g.id, null, 'ana', NOW));
    expect(byName(p, 'Grade1').params).toEqual({});
    expect(lastLog(p).detail).toBe('Grade1 reset: gain 1.2 → 1');
  });

  it('bypasses with D, renames, moves (layout only), lays out', () => {
    let p = start();
    const wrap = byName(p, 'LightWrap1');
    const rev = doc(p).revision;
    p = ok(setCompDisabled(p, SHOT, [wrap.id], true, 'ana', NOW));
    expect(byName(p, 'LightWrap1').disabled).toBe(true);
    expect(lastLog(p).detail).toBe('LightWrap1 bypassed');
    expect(doc(p).revision).toBe(rev + 1);
    // A bypassed node passes its fg on: still a foreground with alpha.
    expect(compOutputKind(doc(p), wrap.id)).toBe('rgba');
    p = ok(renameCompNode(p, SHOT, wrap.id, 'Wrap_night', 'ana', NOW));
    expect(renameCompNode(p, SHOT, wrap.id, '1bad name', 'ana', NOW).ok).toBe(false);
    expect(renameCompNode(p, SHOT, wrap.id, 'Merge1', 'ana', NOW).ok).toBe(false);
    const r2 = doc(p).revision;
    p = ok(moveCompNodes(p, SHOT, [{ id: wrap.id, x: 500.4, y: -20 }], 'ana', NOW));
    expect(byName(p, 'Wrap_night')).toMatchObject({ x: 500, y: -20 });
    expect(doc(p).revision).toBe(r2);
    expect(lastLog(p)).toMatchObject({ action: 'comp.layout', detail: '1 node moved' });
    p = ok(layoutComp(p, SHOT, 'ana', NOW));
    expect(byName(p, 'Wrap_night').x).not.toBe(500);
    p = ok(setCompViewer(p, SHOT, { a: wrap.id }, 'ana', NOW));
    expect(doc(p).viewer.a).toBe(wrap.id);
    expect(doc(p).revision).toBe(r2);
  });

  it('deletes nodes, joining what went through them', () => {
    let p = start();
    const wrap = byName(p, 'LightWrap1');
    p = ok(removeCompNodes(p, SHOT, [wrap.id], 'ana', NOW));
    expect(compNode(doc(p), wrap.id)).toBeUndefined();
    // The Keyer now feeds the Merge's A directly.
    expect(doc(p).edges).toContainEqual({ from: byName(p, 'Keyer1').id, to: byName(p, 'Merge1').id, input: 'A' });
    expect(lastLog(p)).toMatchObject({ action: 'comp.node_removed', detail: 'LightWrap1' });
    expect(compErrors(validateCompGraph(doc(p)))).toEqual([]);
  });

  it('undoes a change by restoring the graph, logged', () => {
    let p = start();
    const before = doc(p);
    p = ok(setCompParams(p, SHOT, byName(p, 'Merge1').id, { operation: 'plus' }, 'ana', NOW));
    p = ok(restoreCompGraph(p, SHOT, before, 'Merge1.operation over → plus', 'ana', NOW));
    expect(compNodeParams(byName(p, 'Merge1'))['operation']).toBe('over');
    expect(lastLog(p)).toMatchObject({ action: 'comp.undo', detail: 'undid: Merge1.operation over → plus' });
    expect(doc(p).revision).toBe(before.revision + 2);
  });
});

describe('validation', () => {
  it('finds loops, missing inputs, unfit kinds, missing tracks, more than one Write', () => {
    const p = ok(startComp(withComp(), SHOT, 'suggested', 'ana', NOW));
    const d = doc(p);
    const merge = byName(p, 'Merge1').id;
    const wrap = byName(p, 'LightWrap1').id;
    const looped = { ...d, edges: [...d.edges, { from: merge, to: byName(p, 'Read_background').id, input: 'src' }] };
    expect(validateCompGraph(looped).some((x) => x.message.includes('has no input'))).toBe(true);
    const loop2 = { ...d, edges: d.edges.map((e) => (e.to === wrap && e.input === 'bg' ? { ...e, from: merge } : e)) };
    expect(validateCompGraph(loop2)[0]).toMatchObject({ severity: 'error', message: expect.stringContaining('loops back') });
    const missing = { ...d, edges: d.edges.filter((e) => !(e.to === wrap && e.input === 'fg')) };
    expect(compErrors(validateCompGraph(missing)).map((x) => x.message)).toEqual(['LightWrap1 needs its fg input connected']);
    const roto = { id: 'n90', type: 'roto' as const, name: 'Roto9', x: 0, y: 0, params: {}, disabled: false, note: '' };
    const unfit = { ...d, nodes: [...d.nodes, roto], edges: d.edges.map((e) => (e.to === wrap && e.input === 'bg' ? { ...e, from: 'n90' } : e)) };
    expect(compErrors(validateCompGraph(unfit))[0]!.message).toBe('Roto9 → LightWrap1.bg: a matte has no colour');
    const pin = { id: 'n91', type: 'cornerpin' as const, name: 'CornerPin1', x: 0, y: 0, params: { track: 'screen' }, disabled: false, note: '' };
    const withPin = { ...d, nodes: [...d.nodes, pin], edges: [...d.edges, { from: byName(p, 'Read_plate').id, to: 'n91', input: 'src' }] };
    expect(validateCompGraph(withPin, { tracks: new Map() }).some((x) => x.message.includes('no 2D track “screen”'))).toBe(true);
    expect(validateCompGraph(withPin, { tracks: new Map([['screen', 'point']]) }).some((x) => x.message.includes('is a point track'))).toBe(true);
    expect(compErrors(validateCompGraph(withPin, { tracks: new Map([['screen', 'planar']]) }))).toEqual([]);
    const twoWrites = { ...d, nodes: [...d.nodes, { ...d.nodes.find((n) => n.type === 'write')!, id: 'n92', name: 'Write2' }] };
    expect(compErrors(validateCompGraph(twoWrites)).some((x) => x.message.startsWith('One Write node'))).toBe(true);
    expect(compErrors(validateCompGraph({ ...d, nodes: d.nodes.filter((n) => n.type !== 'write'), edges: d.edges.filter((e) => e.to !== byName(p, 'Write1').id) }))[0]!.message).toContain('Add a Write node');
  });

  it('infers what each node puts out', () => {
    const p = ok(startComp(withComp(), SHOT, 'suggested', 'ana', NOW));
    const d = doc(p);
    expect(compOutputKind(d, byName(p, 'Read_plate').id)).toBe('rgb');
    expect(compOutputKind(d, byName(p, 'Keyer1').id)).toBe('rgba');
    expect(compOutputKind(d, byName(p, 'Merge1').id)).toBe('rgba');
    const q = ok(setCompParams(p, SHOT, byName(p, 'Keyer1').id, { output: 'alpha' }, 'ana', NOW));
    expect(compOutputKind(doc(q), byName(q, 'Keyer1').id)).toBe('alpha');
    // …which no longer fits the light wrap's fg.
    expect(compErrors(validateCompGraph(doc(q))).some((x) => x.message.includes('LightWrap1.fg'))).toBe(true);
  });

  it('lays out a tree with B under its Merge and the Write last', () => {
    const g = suggestedCompGraph(withComp(), SHOT);
    const pos = compAutoLayout(g.nodes, g.edges);
    const id = (name: string) => g.nodes.find((n) => n.name === name)!.id;
    expect(pos.get(id('Write1'))!.x).toBe(pos.get(id('Merge1'))!.x);
    expect(pos.get(id('Read_background'))!.x).toBe(pos.get(id('Merge1'))!.x);
    expect(pos.get(id('LightWrap1'))!.x).not.toBe(pos.get(id('Merge1'))!.x);
    expect(new Set([...pos.values()].map((v) => `${v.x},${v.y}`)).size).toBe(g.nodes.length);
  });
});

describe('module outputs by reference', () => {
  it('reads exports only, says which tab to export from, and notes an older version', () => {
    let p = ok(startComp(withComp(), SHOT, 'suggested', 'ana', NOW));
    expect(resolveCompSource(p, SHOT, 'key_foreground')).toMatchObject({ ok: false, reason: expect.stringContaining('Key tab › Export') });
    expect(resolveCompSource(p, SHOT, 'background')).toMatchObject({ ok: true, still: true, file: 'VFX/SCENE_12A/BG/city_night_plate.exr', format: 'exr' });
    expect(resolveCompSource(p, SHOT, 'plate')).toMatchObject({ ok: true, version: null, still: false });
    expect(compSourceProblems(p, SHOT, doc(p)).map((x) => x.message)).toEqual([expect.stringContaining('Keyer1: The key has not been exported')]);
    // A key export on record (the key's own rules are tested in key.test.ts; here only its record matters).
    p = ok(setTaskState(p, SHOT, 'key', 'processing', 'ana', NOW));
    const state = shotState(p, SHOT)!;
    const keyDoc = { formatVersion: 1, screen: null, frames: [], runs: [], exports: [] } as never;
    p = { ...p, shots: p.shots.map((s) => (s.shotId === SHOT ? { ...state, key: (state.key ?? (keyDoc as never)) } : s)) };
    const reparsed = parseProject(serializeProject(p));
    if (!reparsed.ok) throw new Error(reparsed.reason);
    p = reparsed.project;
    const rec = { version: 1, folder: '03_KEYS/010_020_key_v001', alpha: '010_020_key_alpha_v001.%04d.png', foreground: '010_020_key_fg_v001.%04d.exr', alphaExr: false, first: 1001, last: 1128, frames: 128, width: 4096, height: 2160, encoding: 'ACEScg (linear AP1)', despill: true, confidence: { mean: 0.9, min: 0.8, low: [] }, algorithm: 'vcvfx-cdk@1.1.0', revision: 0, metadata: '03_KEYS/010_020_key_v001/010_020_key_v001.json', files: 258 };
    const exported = recordKeyExport(p, SHOT, rec, 'ana', NOW);
    if (exported.ok) p = exported.project;
    else p = { ...p, shots: p.shots.map((s) => (s.shotId === SHOT ? { ...s, key: { ...s.key!, exports: [{ ...rec, core: null, edge: null, lightWrap: null, writtenAt: NOW.toISOString(), by: 'ana' }] } } : s)) };
    expect(resolveCompSource(p, SHOT, 'key_foreground')).toMatchObject({ ok: true, version: 1, folder: '03_KEYS/010_020_key_v001', file: '010_020_key_fg_v001.%04d.exr', kind: 'rgba', note: null });
    expect(resolveCompSource(p, SHOT, 'key_alpha')).toMatchObject({ ok: true, file: '010_020_key_alpha_v001.%04d.png', kind: 'alpha' });
    expect(compSourceProblems(p, SHOT, doc(p))).toEqual([]);
    // The key reopened as v002 with no export: v001 is read, and said so.
    p = { ...p, shots: p.shots.map((s) => (s.shotId === SHOT ? { ...s, tasks: s.tasks.map((t) => (t.kind === 'key' ? { ...t, version: 2 } : t)) } : s)) };
    expect(compSourceProblems(p, SHOT, doc(p))[0]).toMatchObject({ severity: 'warning', message: expect.stringContaining('now v002 and has no export: the comp reads v001') });
  });
});

describe('renders, exports and approval', () => {
  it('a render of the current graph puts the comp up for review; approval needs the export; approved is locked; reopening makes v002', () => {
    let p = ok(startComp(withComp(), SHOT, 'suggested', 'ana', NOW));
    expect(recordCompRender(p, SHOT, { ...renderRecord(p), revision: doc(p).revision - 1 }, 'ana', NOW)).toMatchObject({ ok: false, reason: expect.stringContaining('Render again') });
    expect(recordCompExport(p, SHOT, exportRecord(p), 'ana', NOW)).toMatchObject({ ok: false, reason: expect.stringContaining('Render comp v001') });
    p = ok(recordCompRender(p, SHOT, renderRecord(p), 'ana', NOW));
    expect(task(p).state).toBe('needs_review');
    expect(lastLog(p).action).toBe('task.state');
    expect(p.log.at(-2)!.detail).toContain('2.00 fps; reads Key v001 foreground');
    expect(approveTask(p, SHOT, 'composite', 'M. Delgado', NOW)).toMatchObject({ ok: false, reason: expect.stringContaining('export comp v001 first') });
    p = ok(recordCompExport(p, SHOT, exportRecord(p), 'ana', NOW));
    p = ok(approveTask(p, SHOT, 'composite', 'M. Delgado', NOW));
    expect(task(p)).toMatchObject({ state: 'approved', approval: { by: 'M. Delgado' } });
    expect(setCompParams(p, SHOT, byName(p, 'Merge1').id, { mix: 0.5 }, 'ana', NOW)).toMatchObject({ ok: false, reason: expect.stringContaining('Comp v001 is approved') });
    expect(moveCompNodes(p, SHOT, [{ id: byName(p, 'Merge1').id, x: 1, y: 1 }], 'ana', NOW).ok).toBe(false);
    p = ok(setTaskState(p, SHOT, 'composite', 'needs_correction', 'ana', NOW));
    expect(task(p).version).toBe(2);
    p = ok(setCompParams(p, SHOT, byName(p, 'Merge1').id, { mix: 0.5 }, 'ana', NOW));
    expect(recordCompRender(p, SHOT, { ...renderRecord(p), version: 1 }, 'ana', NOW).ok).toBe(false);
    p = ok(recordCompRender(p, SHOT, renderRecord(p), 'ana', NOW));
    expect(doc(p).renders.map((r) => r.version)).toEqual([1, 2]);
    expect(doc(p).exports.map((e) => e.version)).toEqual([1]);
  });

  it('render settings: a range inside the shot', () => {
    let p = ok(startComp(withComp(), SHOT, 'suggested', 'ana', NOW));
    p = ok(setCompRenderSettings(p, SHOT, { first: 1010, last: 1020, review: 'png' }, 'ana', NOW));
    expect(compRenderRange(doc(p), 1001, 1128)).toEqual({ first: 1010, last: 1020 });
    expect(compRenderRange(doc(p), 1015, 1018)).toEqual({ first: 1015, last: 1018 });
    expect(setCompRenderSettings(p, SHOT, { first: 1030 }, 'ana', NOW).ok).toBe(false);
    expect(lastLog(p).detail).toBe('first shot → 1010, last shot → 1020, review jpeg → png');
  });

  it('writes the comp section of the manifest and the graph data', () => {
    let p = ok(startComp(withComp(), SHOT, 'suggested', 'ana', NOW));
    expect(compManifest(shotState(sample(), SHOT)!)).toBeNull();
    p = ok(recordCompRender(p, SHOT, renderRecord(p), 'ana', NOW));
    p = ok(recordCompExport(p, SHOT, exportRecord(p), 'ana', NOW));
    const m = buildManifest(p, SHOT, { generatedAt: NOW, appVersion: '0.1.0', operator: 'ana', files: [] }).comp!;
    expect(m).toMatchObject({ task: 'composite', version: 'v001', rendered: true, exported: true, nodes: 6, render: { folder: '08_PREVIEWS/010_020_comp_v001', pattern: '010_020_comp_v001.%04d.exr', frames: { count: 128 } }, export: { folder: '09_PROJECT_DATA/010_020_comp_v001', nuke: '010_020_comp_v001.nk' } });
    const g = compGraphData(doc(p));
    expect(g.format).toBe('vcvfx.comp/1');
    expect(g.nodes.find((n) => n.name === 'Merge1')!.inputs).toEqual([
      { name: 'B', from: byName(p, 'Read_background').id },
      { name: 'A', from: byName(p, 'LightWrap1').id },
      { name: 'mask', from: null },
    ]);
    expect(g.nodes.find((n) => n.name === 'Merge1')!.params).toMatchObject({ operation: 'over', mix: 1 });
  });
});

describe('project format 8 (now 9)', () => {
  it('projects of formats 3 to 7 open with no comp, and a comp survives a round trip', () => {
    expect(PROJECT_VERSION).toBe(10);
    const v7 = JSON.parse(serializeProject(sample()));
    v7.version = 7;
    for (const s of v7.shots) delete s.comp;
    const v6 = JSON.parse(JSON.stringify(v7));
    v6.version = 6;
    for (const s of v6.shots) delete s.texture;
    const v5 = JSON.parse(JSON.stringify(v6));
    v5.version = 5;
    for (const s of v5.shots) delete s.isolate;
    const v4 = JSON.parse(JSON.stringify(v5));
    v4.version = 4;
    for (const s of v4.shots) delete s.cleanPlate;
    const v3 = JSON.parse(JSON.stringify(v4));
    v3.version = 3;
    for (const s of v3.shots) delete s.key;
    for (const old of [v7, v6, v5, v4, v3]) {
      const opened = parseProject(JSON.stringify(old));
      if (!opened.ok) throw new Error(opened.reason);
      expect(opened.project.version).toBe(10);
      expect(shotState(opened.project, SHOT)!.comp).toBeNull();
    }
    let p = ok(startComp(withComp(), SHOT, 'suggested', 'ana', NOW));
    p = ok(setCompParams(p, SHOT, byName(p, 'Merge1').id, { operation: 'screen' }, 'ana', NOW));
    const again = parseProject(serializeProject(p));
    if (!again.ok) throw new Error(again.reason);
    expect(shotState(again.project, SHOT)!.comp).toEqual(shotState(p, SHOT)!.comp);
    const newer = JSON.parse(serializeProject(p));
    newer.version = PROJECT_VERSION + 1;
    expect(parseProject(JSON.stringify(newer)).ok).toBe(false);
  });
});
