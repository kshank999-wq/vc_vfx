import { handoffShot, shotState, type LogEntry, type Project, type Result, type ShotState } from './project.js';
import { framePattern, versionTag } from './frames.js';
import { backgroundReferences } from './key.js';
import type { PrepTaskKind } from './tasks.js';
import {
  COMP_ALGORITHM,
  COMP_FORMAT_VERSION,
  COMP_NAME,
  COMP_NODES,
  COMP_NODE_TYPES,
  COMP_SOURCE_KIND,
  COMP_SOURCE_LABELS,
  CompExportSchema,
  CompRenderSchema,
  CompRenderSettingsSchema,
  compNodeParams,
  compParamsSchema,
  defaultCompParams,
  type CompDocument,
  type CompEdge,
  type CompExportInput,
  type CompKind,
  type CompNode,
  type CompNodeType,
  type CompParamValue,
  type CompParams,
  type CompRenderInput,
  type CompRenderSettings,
  type CompSource,
} from './comp-schema.js';

export * from './comp-schema.js';

/**
 * The prep compositor as a model (master spec §14, §15, §19; addendum 13).
 *
 * Every mutation is pure, returns a new project and is logged with who, when
 * and what — one log line per change, compact enough that a parameter drag
 * is one line (`Grade1.gain 1 → 1.2`), and each one a step the workspace can
 * undo (`restoreCompGraph`, itself logged). The rules are the other modules':
 *  - the work is the shot's `composite` task: a change starts it or reopens a
 *    review for correction, a render or an export puts it up for review, and
 *    nothing here approves it — approval is `approveTask`, a named human act,
 *    and needs an export of the version;
 *  - an approved comp is never changed in place: every edit is refused until
 *    the task is reopened, which bumps its version, so the next render and
 *    export write `v002` beside the approved `v001`;
 *  - the graph is what the outputs are reproduced from (§19): every change
 *    that changes pixels bumps `revision`, and each render and export records
 *    the revision and the module versions it read.
 */

export const COMP_TASK: PrepTaskKind = 'composite';
/** Graph-editor geometry (graph units). */
export const COMP_NODE_W = 128;
export const COMP_NODE_H = 34;
const GAP_X = 168;
const GAP_Y = 76;

function logged(p: Project, entry: Omit<LogEntry, 'detail'> & { detail?: string }): Project {
  return { ...p, updatedAt: entry.at, log: [...p.log, { detail: '', ...entry }] };
}

function withShot(p: Project, shotId: string, fn: (s: ShotState) => ShotState | string): Result {
  const current = shotState(p, shotId);
  if (!current) return { ok: false, reason: `No shot ${shotId}` };
  const next = fn(current);
  if (typeof next === 'string') return { ok: false, reason: next };
  return { ok: true, project: { ...p, shots: p.shots.map((s) => (s.shotId === shotId ? next : s)) } };
}

export function newCompDocument(): CompDocument {
  return {
    formatVersion: COMP_FORMAT_VERSION,
    algorithm: { ...COMP_ALGORITHM },
    nodes: [],
    edges: [],
    viewer: { a: null, b: null },
    render: { first: null, last: null, review: 'jpeg' },
    renders: [],
    exports: [],
    revision: 0,
    seq: 0,
  };
}

const shotName = (s: ShotState) => s.vfxShotId ?? s.shotId;

export function compDoc(s: ShotState | null | undefined): CompDocument | null {
  return s?.comp ?? null;
}

export function compTaskVersion(s: ShotState): number {
  return s.tasks.find((t) => t.kind === COMP_TASK)?.version ?? 1;
}

/** Why the comp of this shot cannot be changed right now, or null. */
export function compLocked(s: ShotState): string | null {
  if (s.stage !== 'prep') return `${shotName(s)} is ${s.stage}; reopen it before changing its comp`;
  const task = s.tasks.find((t) => t.kind === COMP_TASK);
  if (!task) return `${shotName(s)} has no Prep composite task. Add it first.`;
  if (task.state === 'approved') return `Comp ${versionTag(task.version)} is approved. Reopen it (Needs correction) to make ${versionTag(task.version + 1)}; the approved files are kept.`;
  return null;
}

type TaskMove = 'edited' | 'review';

function editComp(
  p: Project,
  shotId: string,
  actor: string,
  now: Date,
  action: string,
  fn: (doc: CompDocument, s: ShotState) => { doc: CompDocument; detail: string; task?: TaskMove; pixels?: boolean } | string,
): Result {
  const at = now.toISOString();
  let detail = '';
  let started = false;
  let unchanged = false;
  const moves: string[] = [];
  const r = withShot(p, shotId, (s) => {
    const locked = compLocked(s);
    if (locked) return locked;
    const current = compDoc(s);
    started = current === null;
    const out = fn(current ?? newCompDocument(), s);
    if (typeof out === 'string') return out;
    detail = out.detail;
    unchanged = out.doc === current;
    const doc = out.pixels ? { ...out.doc, revision: out.doc.revision + 1 } : out.doc;
    const tasks = s.tasks.map((t) => {
      if (t.kind !== COMP_TASK || !out.task || t.state === 'approved') return t;
      const next: typeof t.state = out.task === 'review' ? 'needs_review' : t.state === 'pending' ? 'processing' : t.state === 'needs_review' ? 'needs_correction' : t.state;
      if (next === t.state) return t;
      moves.push(`${COMP_TASK} → ${next}`);
      return { ...t, state: next };
    });
    return { ...s, tasks, comp: doc };
  });
  if (!r.ok) return r;
  if (unchanged) return { ok: true, project: p };
  let out = r.project;
  if (started) out = logged(out, { at, actor, shotId, action: 'comp.started', detail: `${COMP_ALGORITHM.id}@${COMP_ALGORITHM.version}` });
  out = logged(out, { at, actor, shotId, action, detail });
  for (const m of moves) out = logged(out, { at, actor, shotId, action: 'task.state', detail: m });
  return { ok: true, project: out };
}

// ---------------------------------------------------------------------------
// Graph queries
// ---------------------------------------------------------------------------

export const compNode = (doc: Pick<CompDocument, 'nodes'> | null | undefined, id: string | null | undefined): CompNode | undefined => (id ? doc?.nodes.find((n) => n.id === id) : undefined);

/** The node feeding `input` of `id`, or undefined. */
export function compInput(doc: Pick<CompDocument, 'nodes' | 'edges'>, id: string, input: string): CompNode | undefined {
  const e = doc.edges.find((x) => x.to === id && x.input === input);
  return e ? compNode(doc, e.from) : undefined;
}

/** Every node `id` depends on (not including itself). */
export function compUpstream(doc: Pick<CompDocument, 'edges'>, id: string): Set<string> {
  const out = new Set<string>();
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const e of doc.edges) if (e.to === cur && !out.has(e.from)) {
      out.add(e.from);
      stack.push(e.from);
    }
  }
  return out;
}

/** Every node that depends on `id` (not including itself). */
export function compDownstream(doc: Pick<CompDocument, 'edges'>, id: string): Set<string> {
  const out = new Set<string>();
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const e of doc.edges) if (e.from === cur && !out.has(e.to)) {
      out.add(e.to);
      stack.push(e.to);
    }
  }
  return out;
}

/** Would `from → to` close a loop? */
export function compWouldCycle(doc: Pick<CompDocument, 'edges'>, from: string, to: string): boolean {
  return from === to || compUpstream(doc, from).has(to);
}

/** The source a node reads (Read and the module nodes), or null. */
export function compSourceOf(node: Pick<CompNode, 'type' | 'params'>): CompSource | null {
  const p = compNodeParams(node as CompNode);
  switch (node.type) {
    case 'read':
      return p['source'] as CompSource;
    case 'roto':
      return 'roto';
    case 'keyer':
      return p['output'] === 'alpha' ? 'key_alpha' : 'key_foreground';
    case 'cleanplate':
      return 'cleanplate';
    case 'isolate': {
      const t = p['target'] === 'background' ? 'bg' : 'sky';
      return `${t}_${p['output'] === 'matte' ? 'matte' : p['output'] === 'plate' ? 'plate' : 'foreground'}` as CompSource;
    }
    default:
      return null;
  }
}

/** The input a bypassed node passes on (Nuke: input 0). */
export const compPassInput = (type: CompNodeType): string | null => COMP_NODES[type].pass;

/**
 * What a node puts out: rgb (opaque colour), alpha (a matte) or rgba (colour
 * with a meaningful alpha), from its type, parameters and inputs; null when
 * it puts out nothing (an unconnected input it needs).
 */
export function compOutputKind(doc: Pick<CompDocument, 'nodes' | 'edges'>, id: string, seen: Set<string> = new Set()): CompKind | null {
  const node = compNode(doc, id);
  if (!node || seen.has(id)) return null;
  seen.add(id);
  const kindIn = (input: string) => {
    const src = compInput(doc, id, input);
    return src ? compOutputKind(doc, src.id, new Set(seen)) : null;
  };
  const p = compNodeParams(node);
  if (node.disabled) {
    const pass = compPassInput(node.type);
    return pass ? kindIn(pass) : null;
  }
  const union = (...ks: (CompKind | null)[]): CompKind | null => {
    const got = ks.filter((k): k is CompKind => k !== null);
    if (!got.length) return null;
    if (got.every((k) => k === 'alpha')) return 'alpha';
    if (got.every((k) => k === 'rgb')) return 'rgb';
    return 'rgba';
  };
  switch (node.type) {
    case 'read':
    case 'roto':
    case 'keyer':
    case 'cleanplate':
    case 'isolate':
      return COMP_SOURCE_KIND[compSourceOf(node)!];
    case 'constant':
      return ((p['color'] as number[])[3] ?? 1) >= 1 ? 'rgb' : 'rgba';
    case 'merge': {
      const b = kindIn('B');
      const a = kindIn('A');
      if (!b && !a) return null;
      if (p['operation'] === 'copy') return a ?? b;
      return union(a, b);
    }
    case 'copy': {
      const b = kindIn('B');
      if (!b) return null;
      return p['to'] === 'a' ? (b === 'alpha' ? 'alpha' : 'rgba') : b;
    }
    case 'shuffle': {
      const k = kindIn('src');
      if (!k) return null;
      return p['a'] === '1' ? 'rgb' : 'rgba';
    }
    case 'switch': {
      const which = Math.round(Number(p['which']));
      return kindIn(`in${which}`);
    }
    case 'transform':
    case 'cornerpin':
    case 'track':
    case 'crop': {
      // Moving or cropping an opaque picture exposes transparent black.
      const k = kindIn('src');
      return k === 'rgb' ? 'rgba' : k;
    }
    case 'lightwrap':
      return kindIn('fg');
    default:
      return kindIn(COMP_NODES[node.type].inputs[0]?.name ?? 'src');
  }
}

export interface CompProblem {
  severity: 'error' | 'warning' | 'info';
  node: string | null;
  message: string;
}

/** Whether an output of `kind` fits an input that asks for `want`; the reason when it does not. */
export function compKindFits(want: 'rgb' | 'alpha' | 'both' | 'any', kind: CompKind): string | null {
  if (want === 'any') return null;
  if (want === 'rgb' && kind === 'alpha') return 'a matte has no colour';
  if (want === 'alpha' && kind === 'rgb') return 'a plate has no matte (its alpha is 1 everywhere)';
  if (want === 'both' && kind !== 'rgba') return kind === 'rgb' ? 'it needs a foreground with an alpha, and this has none' : 'it needs a foreground with colour, and a matte has none';
  return null;
}

export interface CompContext {
  /** 2D track ids on the shot, with their kind. */
  tracks?: ReadonlyMap<string, 'point' | 'planar'>;
  /** Roto part ids. */
  parts?: ReadonlySet<string>;
}

/** The project's tracks and roto parts, for validation. */
export function compContext(s: ShotState | null | undefined): CompContext {
  return {
    tracks: new Map((s?.track2d?.tracks ?? []).map((t) => [t.id, t.kind] as const)),
    parts: new Set((s?.roto?.parts ?? []).map((x) => x.id)),
  };
}

/** The Write node a render writes (the only one). */
export function compWriteNode(doc: Pick<CompDocument, 'nodes'> | null | undefined): CompNode | null {
  const writes = doc?.nodes.filter((n) => n.type === 'write') ?? [];
  return writes.length === 1 ? writes[0]! : null;
}

/**
 * Everything wrong with a graph, worst first: loops, inputs a node needs
 * that are not connected, connections whose kind does not fit (a matte where
 * colour is needed, a plate where a matte is), parameters out of range,
 * missing tracks or parts, and the Write node.
 */
export function validateCompGraph(doc: Pick<CompDocument, 'nodes' | 'edges'>, ctx: CompContext = {}): CompProblem[] {
  const out: CompProblem[] = [];
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const names = new Map<string, number>();
  for (const n of doc.nodes) names.set(n.name, (names.get(n.name) ?? 0) + 1);
  for (const [name, count] of names) if (count > 1) out.push({ severity: 'error', node: null, message: `Two nodes are called ${name}; names must be unique (Nuke needs them so).` });
  for (const e of doc.edges) {
    const to = byId.get(e.to);
    if (!byId.has(e.from) || !to) out.push({ severity: 'error', node: e.to, message: `A connection to a node that is not there (${e.from} → ${e.to})` });
    else if (!COMP_NODES[to.type].inputs.some((i) => i.name === e.input)) out.push({ severity: 'error', node: to.id, message: `${to.name} has no input “${e.input}”` });
  }
  // Loops: depth-first with colours.
  const colour = new Map<string, 0 | 1 | 2>();
  const loop = (id: string): boolean => {
    colour.set(id, 1);
    for (const e of doc.edges)
      if (e.to === id && byId.has(e.from)) {
        const c = colour.get(e.from) ?? 0;
        if (c === 1 || (c === 0 && loop(e.from))) return true;
      }
    colour.set(id, 2);
    return false;
  };
  for (const n of doc.nodes) if ((colour.get(n.id) ?? 0) === 0 && loop(n.id)) {
    out.push({ severity: 'error', node: n.id, message: `The graph loops back on itself at ${n.name}` });
    break;
  }
  const looped = out.some((x) => x.message.startsWith('The graph loops'));
  for (const n of doc.nodes) {
    const info = COMP_NODES[n.type];
    const parsed = compParamsSchema(n.type).partial().safeParse(n.params);
    if (!parsed.success) out.push({ severity: 'error', node: n.id, message: `${n.name}: ${parsed.error.issues[0]?.path.join('.') ?? 'a parameter'} — ${parsed.error.issues[0]?.message ?? 'not usable'}` });
    const p = compNodeParams(n);
    for (const input of info.inputs) {
      const src = compInput(doc, n.id, input.name);
      if (!src) {
        if (!input.optional && !(n.disabled && input.name !== info.pass)) out.push({ severity: 'error', node: n.id, message: `${n.name} needs its ${input.label} input connected` });
        continue;
      }
      if (looped) continue;
      const k = compOutputKind(doc, src.id);
      const why = k ? compKindFits(input.kind, k) : null;
      if (why) out.push({ severity: 'error', node: n.id, message: `${src.name} → ${n.name}.${input.label}: ${why}` });
    }
    if ((n.type === 'cornerpin' && p['source'] === 'track') || n.type === 'track') {
      const id = String(p['track'] ?? '');
      if (!id) out.push({ severity: 'error', node: n.id, message: `${n.name}: choose a 2D track` });
      else if (ctx.tracks && !ctx.tracks.has(id)) out.push({ severity: 'error', node: n.id, message: `${n.name}: there is no 2D track “${id}” on this shot` });
      else if (n.type === 'cornerpin' && ctx.tracks?.get(id) === 'point') out.push({ severity: 'error', node: n.id, message: `${n.name}: “${id}” is a point track; a corner pin needs a planar (four-corner) track — use a Track node` });
    }
    const source = compSourceOf(n);
    if ((source === 'roto' || n.type === 'roto') && p['part'] && ctx.parts && !ctx.parts.has(String(p['part']))) out.push({ severity: 'error', node: n.id, message: `${n.name}: there is no roto part “${String(p['part'])}”` });
    if (n.type === 'switch') {
      const which = Math.round(Number(p['which']));
      if (!compInput(doc, n.id, `in${which}`)) out.push({ severity: 'warning', node: n.id, message: `${n.name} passes input ${which}, which is not connected` });
    }
    if (n.type === 'despill' && p['restore'] === 'background' && !compInput(doc, n.id, 'bg')) out.push({ severity: 'warning', node: n.id, message: `${n.name} puts the spill back as the background’s colour, but nothing is connected to bg: grey is used` });
  }
  const writes = doc.nodes.filter((n) => n.type === 'write');
  if (!writes.length && doc.nodes.length) out.push({ severity: 'error', node: null, message: 'Add a Write node: it is what the render writes.' });
  if (writes.length > 1) out.push({ severity: 'error', node: writes[1]!.id, message: `One Write node per comp: ${writes.map((w) => w.name).join(', ')}` });
  if (writes.length === 1 && !looped) {
    const used = compUpstream(doc, writes[0]!.id);
    for (const n of doc.nodes) if (n.id !== writes[0]!.id && !used.has(n.id) && n.type !== 'dot') out.push({ severity: 'info', node: n.id, message: `${n.name} is not used by the render (not connected to ${writes[0]!.name})` });
  }
  const rank = { error: 0, warning: 1, info: 2 } as const;
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

export const compErrors = (problems: readonly CompProblem[]) => problems.filter((p) => p.severity === 'error');

// ---------------------------------------------------------------------------
// Module outputs by reference
// ---------------------------------------------------------------------------

export type CompSourceResolution =
  | {
      ok: true;
      source: CompSource;
      /** The module task version read; null for the plate and the background reference. */
      version: number | null;
      /** Package-relative folder of the files (null: not in the package — the plate is found at read time; a reference is on the drive). */
      folder: string | null;
      /** printf pattern (or a still's file name) relative to `folder`; a handoff-relative path for a reference. */
      file: string;
      format: 'exr' | 'png' | 'other';
      /** A single picture used on every frame (a still clean plate, a texture, a reference image). */
      still: boolean;
      /** How the pixels are read: colour, a one-channel matte (alpha), premultiplied RGBA. */
      kind: CompKind;
      first: number | null;
      last: number | null;
      label: string;
      /** A newer task version exists with no export: the comp reads this older one. */
      note: string | null;
    }
  | { ok: false; source: CompSource; reason: string };

/** The newest export at or below the task version (the current one preferred). */
function newest<T extends { version: number }>(exports: readonly T[], task: number): T | null {
  const fit = exports.filter((e) => e.version <= task).sort((a, b) => b.version - a.version);
  return fit[0] ?? null;
}

/**
 * Where a module output is: the module's newest export (at or below its task
 * version). The comp reads exports — the files a vendor receives — so a
 * module that has not been exported cannot be read, and the reason says
 * which tab to export from.
 */
export function resolveCompSource(p: Project, shotId: string, source: CompSource, part = ''): CompSourceResolution {
  const s = shotState(p, shotId);
  const shot = handoffShot(p, shotId);
  if (!s || !shot) return { ok: false, source, reason: `No shot ${shotId}` };
  const label = COMP_SOURCE_LABELS[source];
  const kind = COMP_SOURCE_KIND[source];
  const v = (k: PrepTaskKind) => s.tasks.find((t) => t.kind === k)?.version ?? 1;
  const note = (task: number, got: number, tab: string) => (got < task ? `${tab} is now ${versionTag(task)} and has no export: the comp reads ${versionTag(got)}.` : null);
  switch (source) {
    case 'plate':
      return { ok: true, source, version: null, folder: null, file: shot.sourcePath, format: 'other', still: false, kind, first: null, last: null, label, note: null };
    case 'background': {
      const bg = s.key?.despill.background;
      const path = bg && (bg.kind === 'reference' || bg.kind === 'file') && bg.path ? bg.path : (backgroundReferences(p, shotId)[0] ?? null);
      if (!path) return { ok: false, source, reason: 'This shot has no background reference (none in the handoff, none chosen in the Key tab).' };
      return { ok: true, source, version: null, folder: null, file: path, format: /\.exr$/i.test(path) ? 'exr' : 'other', still: true, kind, first: null, last: null, label: `Background ${path.split('/').pop()}`, note: null };
    }
    case 'key_foreground':
    case 'key_alpha': {
      const e = newest(s.key?.exports ?? [], v('key'));
      if (!e) return { ok: false, source, reason: 'The key has not been exported: Key tab › Export, then the comp can read it.' };
      if (source === 'key_foreground' && !e.foreground) return { ok: false, source, reason: `Key ${versionTag(e.version)} was exported without its foreground (the source encoding is unknown). Set it in Plates and export the key again.` };
      return { ok: true, source, version: e.version, folder: e.folder, file: source === 'key_alpha' ? e.alpha : e.foreground!, format: source === 'key_alpha' ? 'png' : 'exr', still: false, kind, first: e.first, last: e.last, label: `Key ${versionTag(e.version)} ${source === 'key_alpha' ? 'alpha' : 'foreground'}`, note: note(v('key'), e.version, 'The key') };
    }
    case 'roto': {
      const e = newest(s.roto?.exports ?? [], v('roto'));
      if (!e) return { ok: false, source, reason: 'The roto has not been exported: Roto tab › Export mattes, then the comp can read it.' };
      if (part) {
        const one = e.parts.find((x) => x.partId === part);
        if (!one) return { ok: false, source, reason: `Roto ${versionTag(e.version)} has no exported part “${part}”.` };
        return { ok: true, source, version: e.version, folder: one.folder, file: one.pattern, format: 'png', still: false, kind, first: e.first, last: e.last, label: `Roto ${versionTag(e.version)} ${one.name}`, note: note(v('roto'), e.version, 'The roto') };
      }
      return { ok: true, source, version: e.version, folder: e.folder, file: e.pattern, format: 'png', still: false, kind, first: e.first, last: e.last, label: `Roto ${versionTag(e.version)} matte`, note: note(v('roto'), e.version, 'The roto') };
    }
    case 'cleanplate': {
      const e = newest(s.cleanPlate?.exports ?? [], v('clean_plate'));
      if (!e) return { ok: false, source, reason: 'The clean plate has not been exported: Clean Plate tab › Export, then the comp can read it.' };
      return { ok: true, source, version: e.version, folder: e.folder, file: e.plate, format: e.format, still: e.mode === 'still', kind, first: e.first, last: e.last, label: `Clean plate ${versionTag(e.version)}${e.mode === 'still' ? ' (still)' : ''}`, note: note(v('clean_plate'), e.version, 'The clean plate') };
    }
    case 'sky_matte':
    case 'sky_foreground':
    case 'sky_plate':
    case 'bg_matte':
    case 'bg_foreground':
    case 'bg_plate': {
      const target = source.startsWith('sky') ? 'sky' : 'background';
      const task: PrepTaskKind = target === 'sky' ? 'sky_replacement' : 'background_removal';
      const e = newest(s.isolate?.[target]?.exports ?? [], v(task));
      const what = target === 'sky' ? 'The sky isolation' : 'The background removal';
      if (!e) return { ok: false, source, reason: `${what} has not been exported: Sky & BG tab › Export, then the comp can read it.` };
      const out = source.endsWith('matte') ? 'matte' : source.endsWith('plate') ? 'plate' : 'foreground';
      return { ok: true, source, version: e.version, folder: e.folder, file: out === 'matte' ? e.matte : out === 'plate' ? e.plate : e.foreground, format: out === 'matte' ? 'png' : e.format, still: false, kind, first: e.first, last: e.last, label: `${target === 'sky' ? 'Sky' : 'Background removal'} ${versionTag(e.version)} ${out}`, note: note(v(task), e.version, what) };
    }
    case 'texture': {
      const e = newest(s.texture?.exports ?? [], v('texture_extraction'));
      if (!e) return { ok: false, source, reason: 'No textures have been exported: Textures tab › Export, then the comp can read one.' };
      const region = (part ? e.regions.find((r) => r.id === part) : e.regions[0]) ?? null;
      if (!region) return { ok: false, source, reason: part ? `Textures ${versionTag(e.version)} have no region “${part}”.` : `Textures ${versionTag(e.version)} have no region.` };
      return { ok: true, source, version: e.version, folder: e.folder, file: region.mapExr ?? region.map, format: region.mapExr ? 'exr' : 'png', still: true, kind, first: null, last: null, label: `Texture ${region.name} ${versionTag(e.version)}`, note: note(v('texture_extraction'), e.version, 'The textures') };
    }
  }
}

/** Every node's module reference that cannot be read, as problems (the desktop reads exports). */
export function compSourceProblems(p: Project, shotId: string, doc: Pick<CompDocument, 'nodes' | 'edges'>, only?: ReadonlySet<string>): CompProblem[] {
  const out: CompProblem[] = [];
  for (const n of doc.nodes) {
    if (only && !only.has(n.id)) continue;
    const source = compSourceOf(n);
    if (!source || n.disabled) continue;
    const r = resolveCompSource(p, shotId, source, String(compNodeParams(n)['part'] ?? ''));
    if (!r.ok) out.push({ severity: 'error', node: n.id, message: `${n.name}: ${r.reason}` });
    else if (r.note) out.push({ severity: 'warning', node: n.id, message: `${n.name}: ${r.note}` });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Building graphs
// ---------------------------------------------------------------------------

/** A free Nuke-style name: `Grade1`, `Grade2`, … */
export function compFreeName(doc: Pick<CompDocument, 'nodes'>, type: CompNodeType, base?: string): string {
  const stem = (base ?? COMP_NODES[type].label).replace(/[^A-Za-z0-9_]/g, '_').replace(/^[^A-Za-z]+/, '') || 'Node';
  const used = new Set(doc.nodes.map((n) => n.name));
  for (let i = 1; ; i += 1) if (!used.has(`${stem}${i}`)) return `${stem}${i}`;
}

/**
 * Positions for every node, as Nuke's autoplace would put a tree: the Write
 * at the bottom, each node one row above the deepest node it feeds, inputs
 * side by side (B under its consumer, A to the left, as Nuke draws a Merge).
 */
export function compAutoLayout(nodes: readonly CompNode[], edges: readonly CompEdge[]): Map<string, { x: number; y: number }> {
  const ids = nodes.map((n) => n.id);
  const consumers = new Map<string, string[]>();
  for (const e of edges) consumers.set(e.from, [...(consumers.get(e.from) ?? []), e.to]);
  // Row = longest path down to a sink (sinks are row 0), so a node sits above everything it feeds.
  const row = new Map<string, number>();
  const rowOf = (id: string, guard: Set<string>): number => {
    if (row.has(id)) return row.get(id)!;
    if (guard.has(id)) return 0;
    guard.add(id);
    const cs = consumers.get(id) ?? [];
    const r = cs.length ? Math.max(...cs.map((c) => rowOf(c, guard) + 1)) : 0;
    row.set(id, r);
    return r;
  };
  for (const id of ids) rowOf(id, new Set());
  const depth = Math.max(0, ...row.values());
  // Columns: walk from the sinks, inputs in Nuke's order reversed so input 0 (B) stays in its consumer's column.
  const col = new Map<string, number>();
  let next = 0;
  const place = (id: string, c: number | null) => {
    if (col.has(id)) return;
    const mine = c ?? next++;
    col.set(id, mine);
    if (mine >= next) next = mine + 1;
    const node = nodes.find((n) => n.id === id);
    if (!node) return;
    const ins = COMP_NODES[node.type].inputs.map((i) => edges.find((e) => e.to === id && e.input === i.name)?.from).filter((x): x is string => Boolean(x));
    ins.forEach((src, k) => {
      if (col.has(src)) return;
      place(src, k === 0 ? mine : next++);
    });
  };
  const sinks = ids.filter((id) => !(consumers.get(id) ?? []).length).sort((a, b) => (nodes.find((n) => n.id === a)?.type === 'write' ? -1 : 0) - (nodes.find((n) => n.id === b)?.type === 'write' ? -1 : 0));
  for (const s of sinks) place(s, null);
  for (const id of ids) place(id, null);
  const out = new Map<string, { x: number; y: number }>();
  for (const id of ids) out.set(id, { x: (col.get(id) ?? 0) * GAP_X, y: (depth - (row.get(id) ?? 0)) * GAP_Y });
  return out;
}

interface Draft {
  nodes: CompNode[];
  edges: CompEdge[];
  seq: number;
}
function draftAdd(d: Draft, type: CompNodeType, params: CompParams = {}, name?: string): string {
  d.seq += 1;
  const id = `n${d.seq}`;
  d.nodes.push({ id, type, name: name ?? compFreeName(d, type), x: 0, y: 0, params, disabled: false, note: '' });
  return id;
}
const link = (d: Draft, from: string, to: string, input: string) => d.edges.push({ from, to, input });

/**
 * A starting graph from what the shot already has (addendum 13 §2):
 *  - a key: the key's foreground, light-wrapped by the background, over the
 *    clean plate, the background reference, or a grey card;
 *  - a subject removed from its background, or the sky: the foreground over
 *    the plate behind it (a placeholder for the replacement);
 *  - roto: the plate with the roto matte in its alpha, premultiplied, over grey;
 *  - a clean plate alone: the clean plate;
 *  - otherwise the plate.
 * Always a Write at the end, and the viewer on the result (1) and the plate (2).
 */
export function suggestedCompGraph(p: Project, shotId: string): Pick<CompDocument, 'nodes' | 'edges' | 'viewer' | 'seq'> {
  const s = shotState(p, shotId);
  const kinds = new Set(s?.tasks.map((t) => t.kind) ?? []);
  const d: Draft = { nodes: [], edges: [], seq: 0 };
  const plate = draftAdd(d, 'read', { source: 'plate' }, 'Read_plate');
  let result = plate;
  const hasBg = Boolean((s?.key?.despill.background && s.key.despill.background.kind !== 'none' && s.key.despill.background.kind !== 'frame') || backgroundReferences(p, shotId).length);
  const background = (): string => {
    if (kinds.has('clean_plate')) return draftAdd(d, 'cleanplate', {});
    if (hasBg) return draftAdd(d, 'read', { source: 'background' }, 'Read_background');
    return draftAdd(d, 'constant', { color: [0.18, 0.18, 0.18, 1] }, 'Grey');
  };
  if (kinds.has('key') || kinds.has('despill')) {
    const key = draftAdd(d, 'keyer', { output: 'foreground' });
    let fg = key;
    if (s?.key && s.key.despill.enabled === false) {
      const dsp = draftAdd(d, 'despill', { screen: s.key.screen?.kind === 'blue' ? 'blue' : 'green' });
      link(d, fg, dsp, 'src');
      fg = dsp;
    }
    const bg = background();
    const wrap = draftAdd(d, 'lightwrap', s?.key ? { width: s.key.lightWrap.widthPx, intensity: s.key.lightWrap.intensity, lumaWeight: s.key.lightWrap.lumaWeight } : {});
    link(d, fg, wrap, 'fg');
    link(d, bg, wrap, 'bg');
    const merge = draftAdd(d, 'merge', { operation: 'over' });
    link(d, bg, merge, 'B');
    link(d, wrap, merge, 'A');
    result = merge;
  } else if (kinds.has('background_removal') || kinds.has('sky_replacement')) {
    const target = kinds.has('background_removal') ? 'background' : 'sky';
    const fg = draftAdd(d, 'isolate', { target, output: 'foreground' });
    const behind = draftAdd(d, 'isolate', { target, output: 'plate' }, target === 'sky' ? 'Sky_plate' : 'BG_plate');
    const merge = draftAdd(d, 'merge', { operation: 'over' });
    link(d, behind, merge, 'B');
    link(d, fg, merge, 'A');
    result = merge;
  } else if (kinds.has('roto')) {
    const roto = draftAdd(d, 'roto', {});
    const copy = draftAdd(d, 'copy', { from: 'a', to: 'a' });
    link(d, plate, copy, 'B');
    link(d, roto, copy, 'A');
    const pre = draftAdd(d, 'premult');
    link(d, copy, pre, 'src');
    const grey = draftAdd(d, 'constant', { color: [0.18, 0.18, 0.18, 1] }, 'Grey');
    const merge = draftAdd(d, 'merge', { operation: 'over' });
    link(d, grey, merge, 'B');
    link(d, pre, merge, 'A');
    result = merge;
  } else if (kinds.has('clean_plate')) {
    result = draftAdd(d, 'cleanplate', {});
  }
  const write = draftAdd(d, 'write', {});
  link(d, result, write, 'src');
  const pos = compAutoLayout(d.nodes, d.edges);
  const nodes = d.nodes.map((n) => ({ ...n, ...(pos.get(n.id) ?? { x: 0, y: 0 }) }));
  return { nodes, edges: d.edges, viewer: { a: result, b: plate }, seq: d.seq };
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

const fmt = (v: CompParamValue | undefined): string => (Array.isArray(v) ? `(${v.map((x) => +x.toFixed(4)).join(', ')})` : typeof v === 'number' ? String(+v.toFixed(4)) : String(v));

/** Start the comp: from the suggested graph or empty. Replaces nothing that is there. */
export function startComp(p: Project, shotId: string, mode: 'suggested' | 'empty', actor: string, now: Date): Result {
  return editComp(p, shotId, actor, now, 'comp.graph', (doc) => {
    if (doc.nodes.length) return 'The comp already has a graph. Delete its nodes first to start again.';
    if (mode === 'empty') {
      const d: Draft = { nodes: [], edges: [], seq: doc.seq };
      const read = draftAdd(d, 'read', { source: 'plate' }, 'Read_plate');
      const write = draftAdd(d, 'write', {});
      link(d, read, write, 'src');
      const pos = compAutoLayout(d.nodes, d.edges);
      return { doc: { ...doc, nodes: d.nodes.map((n) => ({ ...n, ...pos.get(n.id)! })), edges: d.edges, viewer: { a: read, b: null }, seq: d.seq }, detail: 'started empty (Read → Write)', task: 'edited', pixels: true };
    }
    const g = suggestedCompGraph(p, shotId);
    return { doc: { ...doc, ...g }, detail: `started from the suggested graph: ${g.nodes.map((n) => n.name).join(', ')}`, task: 'edited', pixels: true };
  });
}

export interface CompAddOptions {
  x?: number;
  y?: number;
  name?: string;
  params?: CompParams;
  /** Insert after this node: its output goes into the new node's first input, and what it fed is fed by the new node (Nuke's insert). */
  after?: string | null;
}

/** Add a node (inserted after `after` when given, as Nuke inserts below the selected node). */
export function addCompNode(p: Project, shotId: string, type: CompNodeType, o: CompAddOptions, actor: string, now: Date): Result {
  if (!COMP_NODE_TYPES.includes(type)) return { ok: false, reason: `No node type “${type}”` };
  return editComp(p, shotId, actor, now, 'comp.node_added', (doc) => {
    if (doc.nodes.length >= 300) return 'At most 300 nodes in a comp';
    if (type === 'write' && doc.nodes.some((n) => n.type === 'write')) return 'This comp already has its Write node (one per comp).';
    const params = { ...(o.params ?? {}) };
    const parsed = compParamsSchema(type).partial().safeParse(params);
    if (!parsed.success) return `${parsed.error.issues[0]?.path.join('.') ?? 'value'}: ${parsed.error.issues[0]?.message ?? 'out of range'}`;
    const name = o.name ?? compFreeName(doc, type);
    if (!COMP_NAME.test(name)) return `“${name}” is not a usable node name (a letter, then letters, digits or _)`;
    if (doc.nodes.some((n) => n.name === name)) return `A node is already called ${name}`;
    const seq = doc.seq + 1;
    const id = `n${seq}`;
    const after = o.after ? compNode(doc, o.after) : undefined;
    const x = o.x ?? (after ? after.x : 0);
    const y = o.y ?? (after ? after.y + GAP_Y : 0);
    const node: CompNode = { id, type, name, x, y, params: parsed.data as CompParams, disabled: false, note: '' };
    let edges = doc.edges;
    const first = COMP_NODES[type].inputs[0];
    let detail = `${name} (${COMP_NODES[type].label})`;
    if (after && first && after.type !== 'write') {
      // Whatever `after` fed is now fed by the new node, then `after` feeds the new node.
      edges = [...edges.map((e) => (e.from === after.id ? { ...e, from: id } : e)), { from: after.id, to: id, input: first.name }];
      detail += ` after ${after.name}`;
    }
    // Inserted where nothing was asked for: what is below it moves down a row to make room, as Nuke does.
    let nodes = doc.nodes;
    if (after && o.y === undefined) {
      const below = compDownstream(doc, after.id);
      nodes = nodes.map((n) => (below.has(n.id) && n.y > after.y ? { ...n, y: n.y + GAP_Y } : n));
    }
    return { doc: { ...doc, nodes: [...nodes, node], edges, seq }, detail, task: 'edited', pixels: true };
  });
}

/** Delete nodes; what went through a deleted node's main input is joined up again, as Nuke does. */
export function removeCompNodes(p: Project, shotId: string, ids: readonly string[], actor: string, now: Date): Result {
  return editComp(p, shotId, actor, now, 'comp.node_removed', (doc) => {
    const gone = doc.nodes.filter((n) => ids.includes(n.id));
    if (!gone.length) return 'Nothing to delete';
    let edges = doc.edges;
    for (const n of gone) {
      const pass = COMP_NODES[n.type].pass;
      const upstream = pass ? edges.find((e) => e.to === n.id && e.input === pass)?.from : undefined;
      edges = edges.filter((e) => e.to !== n.id).map((e) => (e.from === n.id ? (upstream ? { ...e, from: upstream } : null) : e)).filter((e): e is CompEdge => e !== null);
    }
    const keep = new Set(doc.nodes.filter((n) => !ids.includes(n.id)).map((n) => n.id));
    edges = edges.filter((e) => keep.has(e.from) && keep.has(e.to));
    const viewer = { a: doc.viewer.a && keep.has(doc.viewer.a) ? doc.viewer.a : null, b: doc.viewer.b && keep.has(doc.viewer.b) ? doc.viewer.b : null };
    return { doc: { ...doc, nodes: doc.nodes.filter((n) => keep.has(n.id)), edges, viewer }, detail: gone.map((n) => n.name).join(', '), task: 'edited', pixels: true };
  });
}

/** Move nodes in the graph editor (layout only: no pixels change). */
export function moveCompNodes(p: Project, shotId: string, moves: readonly { id: string; x: number; y: number }[], actor: string, now: Date): Result {
  return editComp(p, shotId, actor, now, 'comp.layout', (doc) => {
    const by = new Map(moves.map((m) => [m.id, m]));
    let moved = 0;
    const nodes = doc.nodes.map((n) => {
      const m = by.get(n.id);
      if (!m || !Number.isFinite(m.x) || !Number.isFinite(m.y)) return n;
      const x = Math.round(Math.max(-100_000, Math.min(100_000, m.x)));
      const y = Math.round(Math.max(-100_000, Math.min(100_000, m.y)));
      if (x === n.x && y === n.y) return n;
      moved += 1;
      return { ...n, x, y };
    });
    if (!moved) return { doc, detail: 'unchanged' };
    return { doc: { ...doc, nodes }, detail: `${moved} node${moved === 1 ? '' : 's'} moved` };
  });
}

/** Lay the whole graph out again as a tree. */
export function layoutComp(p: Project, shotId: string, actor: string, now: Date): Result {
  return editComp(p, shotId, actor, now, 'comp.layout', (doc) => {
    if (!doc.nodes.length) return 'Nothing to lay out';
    const pos = compAutoLayout(doc.nodes, doc.edges);
    return { doc: { ...doc, nodes: doc.nodes.map((n) => ({ ...n, ...(pos.get(n.id) ?? { x: n.x, y: n.y }) })) }, detail: `auto layout, ${doc.nodes.length} nodes` };
  });
}

/** Connect `from`'s output to `to`'s named input (replacing what was there). Loops and unfit kinds are refused. */
export function connectComp(p: Project, shotId: string, edge: CompEdge, actor: string, now: Date): Result {
  return editComp(p, shotId, actor, now, 'comp.connected', (doc) => {
    const from = compNode(doc, edge.from);
    const to = compNode(doc, edge.to);
    if (!from || !to) return 'Both nodes must be in the graph';
    const input = COMP_NODES[to.type].inputs.find((i) => i.name === edge.input);
    if (!input) return `${to.name} has no input “${edge.input}”`;
    if (compWouldCycle(doc, from.id, to.id)) return `${from.name} → ${to.name} would loop the graph back on itself`;
    const kind = compOutputKind(doc, from.id);
    const why = kind ? compKindFits(input.kind, kind) : null;
    if (why) return `${from.name} cannot go into ${to.name}.${input.label}: ${why}`;
    const existing = doc.edges.find((e) => e.to === to.id && e.input === input.name);
    if (existing?.from === from.id) return { doc, detail: 'unchanged' };
    const edges = [...doc.edges.filter((e) => !(e.to === to.id && e.input === input.name)), { from: from.id, to: to.id, input: input.name }];
    return { doc: { ...doc, edges }, detail: `${from.name} → ${to.name}.${input.label}${existing ? ` (was ${compNode(doc, existing.from)?.name ?? existing.from})` : ''}`, task: 'edited', pixels: true };
  });
}

export function disconnectComp(p: Project, shotId: string, to: string, input: string, actor: string, now: Date): Result {
  return editComp(p, shotId, actor, now, 'comp.disconnected', (doc) => {
    const e = doc.edges.find((x) => x.to === to && x.input === input);
    if (!e) return 'That input is not connected';
    return { doc: { ...doc, edges: doc.edges.filter((x) => x !== e) }, detail: `${compNode(doc, e.from)?.name ?? e.from} ✕ ${compNode(doc, to)?.name ?? to}.${input}`, task: 'edited', pixels: true };
  });
}

/** Change a node's parameters (non-destructive: nothing upstream is touched). One log line, every changed value. */
export function setCompParams(p: Project, shotId: string, nodeId: string, change: CompParams, actor: string, now: Date): Result {
  return editComp(p, shotId, actor, now, 'comp.params', (doc) => {
    const node = compNode(doc, nodeId);
    if (!node) return `No node ${nodeId}`;
    const before = compNodeParams(node);
    const merged = { ...node.params, ...change };
    const parsed = compParamsSchema(node.type).partial().safeParse(merged);
    if (!parsed.success) return `${node.name}.${parsed.error.issues[0]?.path.join('.') ?? 'value'}: ${parsed.error.issues[0]?.message ?? 'out of range'}`;
    // Store only what differs from the defaults (the file stays small and readable).
    const defaults = defaultCompParams(node.type);
    const params: CompParams = {};
    for (const [k, v] of Object.entries(parsed.data)) if (v !== undefined && JSON.stringify(v) !== JSON.stringify(defaults[k])) params[k] = v as CompParamValue;
    const after = compNodeParams({ ...node, params });
    const details = Object.keys(change).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k])).map((k) => `${node.name}.${k} ${fmt(before[k])} → ${fmt(after[k])}`);
    if (!details.length) return { doc, detail: 'unchanged' };
    return { doc: { ...doc, nodes: doc.nodes.map((n) => (n.id === nodeId ? { ...n, params } : n)) }, detail: details.join(', '), task: 'edited', pixels: true };
  });
}

/** Put parameters back to their defaults (all of the node's, or the named ones). */
export function resetCompParams(p: Project, shotId: string, nodeId: string, keys: readonly string[] | null, actor: string, now: Date): Result {
  return editComp(p, shotId, actor, now, 'comp.params', (doc) => {
    const node = compNode(doc, nodeId);
    if (!node) return `No node ${nodeId}`;
    const before = compNodeParams(node);
    const params: CompParams = {};
    if (keys) for (const [k, v] of Object.entries(node.params)) if (!keys.includes(k)) params[k] = v;
    const after = compNodeParams({ ...node, params });
    const changed = Object.keys(before).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
    if (!changed.length) return { doc, detail: 'unchanged' };
    return { doc: { ...doc, nodes: doc.nodes.map((n) => (n.id === nodeId ? { ...n, params } : n)) }, detail: `${node.name} reset: ${changed.map((k) => `${k} ${fmt(before[k])} → ${fmt(after[k])}`).join(', ')}`, task: 'edited', pixels: true };
  });
}

/** Bypass (disable) or enable nodes — Nuke's D. */
export function setCompDisabled(p: Project, shotId: string, ids: readonly string[], disabled: boolean, actor: string, now: Date): Result {
  return editComp(p, shotId, actor, now, 'comp.bypass', (doc) => {
    const hit = doc.nodes.filter((n) => ids.includes(n.id) && n.disabled !== disabled);
    if (!hit.length) return { doc, detail: 'unchanged' };
    return { doc: { ...doc, nodes: doc.nodes.map((n) => (ids.includes(n.id) ? { ...n, disabled } : n)) }, detail: `${hit.map((n) => n.name).join(', ')} ${disabled ? 'bypassed' : 'enabled'}`, task: 'edited', pixels: true };
  });
}

export function renameCompNode(p: Project, shotId: string, nodeId: string, name: string, actor: string, now: Date): Result {
  return editComp(p, shotId, actor, now, 'comp.renamed', (doc) => {
    const node = compNode(doc, nodeId);
    if (!node) return `No node ${nodeId}`;
    const clean = name.trim();
    if (!COMP_NAME.test(clean)) return `“${clean}” is not a usable node name (a letter, then letters, digits or _)`;
    if (clean === node.name) return { doc, detail: 'unchanged' };
    if (doc.nodes.some((n) => n.name === clean)) return `A node is already called ${clean}`;
    return { doc: { ...doc, nodes: doc.nodes.map((n) => (n.id === nodeId ? { ...n, name: clean } : n)) }, detail: `${node.name} → ${clean}`, task: 'edited', pixels: true };
  });
}

export function setCompNote(p: Project, shotId: string, nodeId: string, note: string, actor: string, now: Date): Result {
  return editComp(p, shotId, actor, now, 'comp.note', (doc) => {
    const node = compNode(doc, nodeId);
    if (!node) return `No node ${nodeId}`;
    const clean = note.trim().slice(0, 500);
    if (clean === node.note) return { doc, detail: 'unchanged' };
    return { doc: { ...doc, nodes: doc.nodes.map((n) => (n.id === nodeId ? { ...n, note: clean } : n)) }, detail: `${node.name}: “${clean}”` };
  });
}

/** The viewer's two nodes (1 and 2). Not a pixel change. */
export function setCompViewer(p: Project, shotId: string, viewer: { a?: string | null; b?: string | null }, actor: string, now: Date): Result {
  return editComp(p, shotId, actor, now, 'comp.viewer', (doc) => {
    const next = { ...doc.viewer, ...viewer };
    for (const id of [next.a, next.b]) if (id && !compNode(doc, id)) return `No node ${id}`;
    if (next.a === doc.viewer.a && next.b === doc.viewer.b) return { doc, detail: 'unchanged' };
    return { doc: { ...doc, viewer: next }, detail: `1: ${compNode(doc, next.a)?.name ?? '—'}, 2: ${compNode(doc, next.b)?.name ?? '—'}` };
  });
}

export function setCompRenderSettings(p: Project, shotId: string, change: Partial<CompRenderSettings>, actor: string, now: Date): Result {
  return editComp(p, shotId, actor, now, 'comp.render_settings', (doc) => {
    const parsed = CompRenderSettingsSchema.safeParse({ ...doc.render, ...change });
    if (!parsed.success) return `${parsed.error.issues[0]?.path.join('.') ?? 'value'}: ${parsed.error.issues[0]?.message ?? 'out of range'}`;
    const next = parsed.data;
    if (next.first !== null && next.last !== null && next.last < next.first) return 'The last frame comes before the first';
    const details = (Object.keys(change) as (keyof CompRenderSettings)[]).filter((k) => next[k] !== doc.render[k]).map((k) => `${k} ${String(doc.render[k] ?? 'shot')} → ${String(next[k] ?? 'shot')}`);
    if (!details.length) return { doc, detail: 'unchanged' };
    return { doc: { ...doc, render: next }, detail: details.join(', '), task: 'edited', pixels: true };
  });
}

/**
 * Undo: put the graph (nodes, connections, viewer, render settings) back as
 * it was before a change. Logged, with what was undone; renders and exports
 * are kept (they are files).
 */
export function restoreCompGraph(p: Project, shotId: string, graph: Pick<CompDocument, 'nodes' | 'edges' | 'viewer' | 'render'>, undone: string, actor: string, now: Date): Result {
  return editComp(p, shotId, actor, now, 'comp.undo', (doc) => {
    const ids = new Set(graph.nodes.map((n) => n.id));
    if (graph.edges.some((e) => !ids.has(e.from) || !ids.has(e.to))) return 'That earlier graph is not usable';
    const maxId = Math.max(0, ...graph.nodes.map((n) => Number(n.id.slice(1))));
    return { doc: { ...doc, nodes: graph.nodes, edges: graph.edges, viewer: graph.viewer, render: graph.render, seq: Math.max(doc.seq, maxId) }, detail: `undid: ${undone || 'the last change'}`, task: 'edited', pixels: true };
  });
}

/** The render range: the settings', inside the shot. */
export function compRenderRange(doc: Pick<CompDocument, 'render'> | null | undefined, first: number, last: number): { first: number; last: number } {
  const f = Math.max(first, Math.min(last, doc?.render.first ?? first));
  const l = Math.max(f, Math.min(last, doc?.render.last ?? last));
  return { first: f, last: l };
}

/** Record a written render: puts the comp up for review (never approval). A render of an older revision is refused. */
export function recordCompRender(p: Project, shotId: string, record: CompRenderInput, actor: string, now: Date): Result {
  const parsed = CompRenderSchema.safeParse({ ...record, writtenAt: now.toISOString(), by: actor });
  if (!parsed.success) return { ok: false, reason: `The render record is not usable: ${parsed.error.issues[0]?.message ?? 'bad data'}` };
  const rec = parsed.data;
  return editComp(p, shotId, actor, now, 'comp.rendered', (doc, s) => {
    const v = compTaskVersion(s);
    if (rec.version !== v) return `That render is ${versionTag(rec.version)}; the comp is ${versionTag(v)}`;
    if (rec.revision !== doc.revision) return `That render was made from graph revision ${rec.revision}; the graph is now revision ${doc.revision}. Render again.`;
    const fps = rec.seconds > 0 ? rec.frames / rec.seconds : 0;
    return {
      doc: { ...doc, renders: [...doc.renders.filter((r) => r.version !== rec.version), rec].sort((a, b) => a.version - b.version) },
      detail: `${versionTag(rec.version)}: ${rec.folder}/${rec.pattern}, ${rec.frames} frames ${rec.first}–${rec.last} at ${rec.width}×${rec.height}, ${rec.encoding}${rec.review ? `, review ${rec.review}` : ''}; ${rec.write}; graph r${rec.revision}; ${fps.toFixed(2)} fps; reads ${rec.references.map((r) => r.label).join(', ') || 'nothing'}`,
      task: 'review',
    };
  });
}

/** Record a written export for finishing: needs the render of this version and revision. Submits for review (never approval). */
export function recordCompExport(p: Project, shotId: string, record: CompExportInput, actor: string, now: Date): Result {
  const parsed = CompExportSchema.safeParse({ ...record, writtenAt: now.toISOString(), by: actor });
  if (!parsed.success) return { ok: false, reason: `The export record is not usable: ${parsed.error.issues[0]?.message ?? 'bad data'}` };
  const rec = parsed.data;
  return editComp(p, shotId, actor, now, 'comp.exported', (doc, s) => {
    const v = compTaskVersion(s);
    if (rec.version !== v) return `That export is ${versionTag(rec.version)}; the comp is ${versionTag(v)}`;
    if (rec.revision !== doc.revision) return `That export was made from graph revision ${rec.revision}; the graph is now revision ${doc.revision}.`;
    if (!doc.renders.some((r) => r.version === v && r.revision === rec.revision)) return `Render comp ${versionTag(v)} with the current graph first (step 4).`;
    return {
      doc: { ...doc, exports: [...doc.exports.filter((e) => e.version !== rec.version), rec].sort((a, b) => a.version - b.version) },
      detail: `${versionTag(rec.version)}: ${rec.folder} — ${rec.graph}, ${rec.nuke}, ${rec.manifest}; ${rec.baked.length} baked node${rec.baked.length === 1 ? '' : 's'}; ${rec.untranslated.length} untranslated feature${rec.untranslated.length === 1 ? '' : 's'}; ${rec.files} files; graph r${rec.revision}`,
      task: 'review',
    };
  });
}

// ---------------------------------------------------------------------------
// Files, manifest
// ---------------------------------------------------------------------------

/**
 * File names (§17). The rendered comp is a preview of how the prep fits
 * together, so it goes to 08_PREVIEWS; the graph, the Nuke script, the graph
 * manifest and any baked node renders go with the task to 09_PROJECT_DATA.
 *
 *   08_PREVIEWS/<shot>_comp_vNNN/<shot>_comp_vNNN.%04d.exr        (and _comp_review_vNNN.%04d.jpg)
 *   09_PROJECT_DATA/<shot>_comp_vNNN/<shot>_comp_vNNN.vcvfxcomp.json, .nk, _manifest.json, README.txt, baked/
 */
export const compNames = {
  folder: (shot: string, version: number) => `${shot}_comp_${versionTag(version)}`,
  renderPattern: (shot: string, version: number) => framePattern(shot, 'comp', version, 'exr'),
  reviewPattern: (shot: string, version: number, format: 'jpeg' | 'png') => framePattern(shot, 'comp_review', version, format),
  graph: (shot: string, version: number) => `${shot}_comp_${versionTag(version)}.vcvfxcomp.json`,
  nuke: (shot: string, version: number) => `${shot}_comp_${versionTag(version)}.nk`,
  manifest: (shot: string, version: number) => `${shot}_comp_${versionTag(version)}_manifest.json`,
  bakedPattern: (shot: string, version: number, node: string) => `baked/${framePattern(shot, `comp_${node}`, version, 'exr')}`,
  readme: () => 'README.txt',
  /** Every file of a version starts with this (the baked folder aside). */
  prefix: (shot: string) => `${shot}_comp_`,
};

/** The graph as written into the package: what reproduces the comp with source + settings (§19). */
export function compGraphData(doc: CompDocument) {
  return {
    format: 'vcvfx.comp/1',
    algorithm: doc.algorithm,
    revision: doc.revision,
    colour: { working: 'scene-linear, the plates’ encoding (ACEScg for converted plates)', images: 'premultiplied RGBA' },
    nodes: doc.nodes.map((n) => ({ id: n.id, name: n.name, type: n.type, class: COMP_NODES[n.type].label, position: { x: n.x, y: n.y }, disabled: n.disabled, note: n.note, params: compNodeParams(n), inputs: COMP_NODES[n.type].inputs.map((i) => ({ name: i.name, from: doc.edges.find((e) => e.to === n.id && e.input === i.name)?.from ?? null })) })),
    edges: doc.edges,
    viewer: doc.viewer,
    render: doc.render,
  };
}

/** The comp section of the package manifest (§18): null when not started. */
export function compManifest(s: ShotState) {
  const doc = compDoc(s);
  if (!doc) return null;
  const task = s.tasks.find((t) => t.kind === COMP_TASK);
  const version = task?.version ?? 1;
  const render = doc.renders.find((r) => r.version === version) ?? null;
  const exported = doc.exports.find((e) => e.version === version) ?? null;
  return {
    task: COMP_TASK,
    version: versionTag(version),
    state: task?.state ?? null,
    approval: task?.approval ?? null,
    algorithm: `${doc.algorithm.id}@${doc.algorithm.version}`,
    revision: doc.revision,
    nodes: doc.nodes.length,
    graph: { nodes: doc.nodes.map((n) => ({ name: n.name, type: n.type, disabled: n.disabled })), edges: doc.edges.length },
    rendered: render !== null,
    render: render ? { folder: render.folder, pattern: render.pattern, review: render.review, frames: { first: render.first, last: render.last, count: render.frames }, resolution: { width: render.width, height: render.height }, encoding: render.encoding, revision: render.revision, references: render.references } : null,
    exported: exported !== null,
    export: exported ? { folder: exported.folder, graph: exported.graph, nuke: exported.nuke, manifest: exported.manifest, baked: exported.baked, untranslated: exported.untranslated, revision: exported.revision } : null,
  };
}

