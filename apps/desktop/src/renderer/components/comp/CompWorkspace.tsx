import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { AspectTag, FrameBox, overlayAspect, useShotAspect, useStageSize } from '../FrameBox';
import { clientToImage } from '../../frame-fit';
import {
  COMP_NODES,
  COMP_NODE_H,
  COMP_NODE_W,
  COMP_SOURCE_LABELS,
  TASK_STATE_LABELS,
  addCompNode,
  compContext,
  compDoc,
  compErrors,
  compLocked,
  compNode,
  compNodeParams,
  compRenderRange,
  compTaskVersion,
  connectComp,
  defaultCompParams,
  disconnectComp,
  layoutComp,
  moveCompNodes,
  recordCompExport,
  recordCompRender,
  removeCompNodes,
  renameCompNode,
  resetCompParams,
  restoreCompGraph,
  serializeProject,
  setCompDisabled,
  setCompParams,
  setCompRenderSettings,
  setCompViewer,
  shotState,
  startComp,
  suggestedCompGraph,
  validateCompGraph,
  versionTag,
  type CompDocument,
  type CompNode,
  type CompNodeType,
  type CompParamSpec,
  type CompParamValue,
  type CompProblem,
  type Project,
  type Result,
} from '@vcvfx/domain';
import type { VcvfxApi } from '../../../shared/bridge';
import type { CompFrameView, CompSessionInfo } from '../../../shared/comp/bridge-types';
import { Big, Check, Seg, Slider } from '../cleanplate/CleanPlateWorkspace';
import { GraphEditor } from './GraphEditor';
import '../key/key.css';
import '../cleanplate/cleanplate.css';
import './comp.css';

/**
 * The Comp workspace (master spec §14; addendum 13): start from the graph the
 * shot suggests (or an empty one), edit the graph, look at any two nodes with
 * an A/B wipe, render the Write node's versioned EXR sequence, and export the
 * graph, a Nuke script and the graph manifest for finishing.
 *
 * Built for the three-zone module screen (addendum 08): `useCompController`
 * holds the state and actions; `compStepDefs` (left), `CompViewer` (centre:
 * the viewer above the node graph) and `CompInfo` (right: the selected node's
 * parameters) draw from it. Every change is a logged domain mutation applied
 * through `onComp`; each one can be undone (⌘/Ctrl+Z), which is logged too. A
 * render or an export puts the task up for review; nothing here approves.
 */

export type CompMutation = (p: Project, actor: string, now: Date) => Result;

export interface CompWorkspaceProps {
  api: VcvfxApi;
  project: Project;
  shotId: string;
  projectKey: string;
  canEdit: boolean;
  busy: boolean;
  actor: string;
  frame: number;
  onFrame(frame: number): void;
  /** Apply a domain mutation; false when it was refused (the shell shows why). */
  onComp(fn: CompMutation): boolean;
  runJob<T>(label: string, fn: (jobId: string) => Promise<T>): Promise<T>;
  notify(kind: 'ok' | 'error' | 'info', text: string): void;
}

export type CompViewMode = 'a' | 'b' | 'wipe';
type Graph = Pick<CompDocument, 'nodes' | 'edges' | 'viewer' | 'render'>;

const unwrap = <T,>(r: { ok: true; data: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(r.error);
  return r.data;
};

// ---------------------------------------------------------------------------
// The controller
// ---------------------------------------------------------------------------

export function useCompController(props: CompWorkspaceProps) {
  const { api, project, shotId, projectKey, canEdit, frame, onFrame, onComp, runJob, notify, actor } = props;
  const state = shotState(project, shotId);
  const doc = compDoc(state);
  const task = state?.tasks.find((t) => t.kind === 'composite') ?? null;
  const locked = state ? compLocked(state) : 'No shot';
  const version = state ? compTaskVersion(state) : 1;
  const text = useMemo(() => serializeProject(project), [project]);
  const textRef = useRef(text);
  textRef.current = text;
  const supported = Boolean(api.compSession && api.compFrame);

  const [session, setSession] = useState<CompSessionInfo | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [view, setView] = useState<CompFrameView | null>(null);
  const [viewError, setViewError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [mode, setMode] = useState<CompViewMode>('a');
  const [wipe, setWipe] = useState(0.5);
  const [channel, setChannel] = useState<'rgb' | 'alpha'>('rgb');
  const [proxy, setProxy] = useState(true);
  const [working, setWorking] = useState<string | null>(null);
  // The viewer's nodes: the document's, and kept here when the comp is locked (looking is always allowed).
  const [localViewer, setLocalViewer] = useState<{ a: string | null; b: string | null }>(doc?.viewer ?? { a: null, b: null });
  const viewer = locked ? localViewer : (doc?.viewer ?? localViewer);
  // Undo: the graph before each change, with what the change was.
  const undo = useRef<Map<string, { graph: Graph; label: string }[]>>(new Map());
  const [undoCount, setUndoCount] = useState(0);
  useEffect(() => {
    setSelected([]);
    setUndoCount(undo.current.get(shotId)?.length ?? 0);
    setLocalViewer(compDoc(shotState(project, shotId))?.viewer ?? { a: null, b: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shotId]);

  const first = session?.first ?? frame;
  const last = session?.last ?? frame;
  const canChange = canEdit && !locked;
  const problems = useMemo<CompProblem[]>(() => {
    if (!doc) return [];
    const own = validateCompGraph(doc, compContext(state));
    const sources = (session?.sources ?? []).filter((s) => !s.ok).map((s) => ({ severity: 'error' as const, node: s.node, message: `${compNode(doc, s.node)?.name ?? s.node}: ${s.reason ?? 'not available'}` }));
    return [...own, ...sources].sort((a, b) => ({ error: 0, warning: 1, info: 2 })[a.severity] - ({ error: 0, warning: 1, info: 2 })[b.severity]);
  }, [doc, state, session]);
  const errors = compErrors(problems);

  const sessionKey = JSON.stringify([shotId, projectKey, Boolean(task), doc?.nodes.map((n) => [n.id, n.type, n.params['source'], n.params['output'], n.params['target'], n.params['part']]) ?? null, state?.plates.length ?? 0, JSON.stringify([state?.key?.exports.length, state?.roto?.exports.length, state?.cleanPlate?.exports.length, state?.isolate?.sky?.exports.length, state?.isolate?.background?.exports.length, state?.texture?.exports.length])]);
  useEffect(() => {
    if (!api.compSession) return;
    let live = true;
    setSessionError(null);
    void api.compSession({ text: textRef.current, shotId, projectKey }).then((r) => {
      if (!live) return;
      if (r.ok) setSession(r.data);
      else setSessionError(r.error);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, sessionKey]);

  // The preview: whenever the graph's pixels, the viewer's nodes, the frame or the proxy change (throttled).
  const scale = session?.plate ? Math.min(1, (session.previewWidth * (proxy ? 0.5 : 1)) / session.plate.width) : 0.25;
  const viewDeps = JSON.stringify([doc?.revision ?? -1, doc ? JSON.stringify([doc.nodes.map((n) => [n.id, n.params, n.disabled]), doc.edges]) : '', viewer.a, viewer.b, frame, scale, session?.available]);
  const request = useRef(0);
  useEffect(() => {
    if (!api.compFrame || !session?.available || !doc?.nodes.length || (!viewer.a && !viewer.b)) {
      setView(null);
      return;
    }
    const id = ++request.current;
    setLoading(true);
    const timer = setTimeout(() => {
      void api.compFrame!({ text: textRef.current, shotId, projectKey, frame, a: viewer.a, b: viewer.b, scale }).then((r) => {
        if (id !== request.current) return;
        setLoading(false);
        if (r.ok) {
          setView(r.data);
          setViewError(null);
        } else setViewError(r.error);
      });
    }, 40);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, viewDeps, shotId]);

  /** Apply a graph change, remembering the graph before it for Undo. */
  const edit = useCallback(
    (label: string, fn: CompMutation): boolean => {
      const before = compDoc(shotState(project, shotId));
      const okay = onComp(fn);
      if (okay && before) {
        const stack = undo.current.get(shotId) ?? [];
        stack.push({ graph: { nodes: before.nodes, edges: before.edges, viewer: before.viewer, render: before.render }, label });
        if (stack.length > 100) stack.shift();
        undo.current.set(shotId, stack);
        setUndoCount(stack.length);
      }
      return okay;
    },
    [onComp, project, shotId],
  );
  const guard = async (label: string, fn: () => Promise<void>) => {
    setWorking(label);
    try {
      await fn();
    } catch (error) {
      notify('error', (error as Error).message);
    } finally {
      setWorking(null);
    }
  };
  const name = (id: string) => compNode(doc, id)?.name ?? id;

  const actions = {
    start: (m: 'suggested' | 'empty') => {
      if (onComp((p, a, t) => startComp(p, shotId, m, a, t))) setSelected([]);
    },
    select: (ids: string[]) => setSelected(ids),
    move: (moves: { id: string; x: number; y: number }[]) => edit(`moved ${moves.map((m) => name(m.id)).join(', ')}`, (p, a, t) => moveCompNodes(p, shotId, moves, a, t)),
    connect: (e: { from: string; to: string; input: string }) => edit(`${name(e.from)} → ${name(e.to)}.${e.input}`, (p, a, t) => connectComp(p, shotId, e, a, t)),
    disconnect: (to: string, input: string) => edit(`disconnected ${name(to)}.${input}`, (p, a, t) => disconnectComp(p, shotId, to, input, a, t)),
    add: (type: CompNodeType, at: { x: number; y: number } | null) => {
      // As Nuke: with a node selected the new one is inserted after it (wherever the pointer is); otherwise it goes where the menu was opened.
      const after = selected.length ? selected[selected.length - 1]! : null;
      if (after) at = null;
      const before = new Set(doc?.nodes.map((n) => n.id) ?? []);
      const okay = edit(`added ${COMP_NODES[type].label}`, (p, a, t) => addCompNode(p, shotId, type, { ...(at ? { x: Math.round(at.x - COMP_NODE_W / 2), y: Math.round(at.y - COMP_NODE_H / 2) } : {}), ...(after ? { after } : !at ? { x: 0, y: (doc?.nodes.length ? Math.max(...doc.nodes.map((n) => n.y)) : 0) + 76 } : {}) }, a, t));
      return { okay, before };
    },
    remove: (ids: string[]) => {
      if (edit(`deleted ${ids.map(name).join(', ')}`, (p, a, t) => removeCompNodes(p, shotId, ids, a, t))) setSelected([]);
    },
    bypass: (ids: string[]) => {
      const nodes = ids.map((id) => compNode(doc, id)).filter((n): n is CompNode => Boolean(n));
      const to = !nodes.every((n) => n.disabled);
      edit(`${to ? 'bypassed' : 'enabled'} ${nodes.map((n) => n.name).join(', ')}`, (p, a, t) => setCompDisabled(p, shotId, ids, to, a, t));
    },
    viewer: (slot: 'a' | 'b', id: string) => {
      const next = { ...viewer, [slot]: id };
      setLocalViewer(next);
      if (!locked && canEdit) onComp((p, a, t) => setCompViewer(p, shotId, { [slot]: id }, a, t));
      setMode(slot === 'a' ? (mode === 'b' ? 'a' : mode) : mode === 'a' ? 'b' : mode);
    },
    layout: () => edit('auto layout', (p, a, t) => layoutComp(p, shotId, a, t)),
    params: (id: string, change: Record<string, CompParamValue>) => edit(`${name(id)} ${Object.keys(change).join(', ')}`, (p, a, t) => setCompParams(p, shotId, id, change, a, t)),
    reset: (id: string, keys: string[] | null) => edit(`${name(id)} reset`, (p, a, t) => resetCompParams(p, shotId, id, keys, a, t)),
    rename: (id: string, to: string) => edit(`renamed ${name(id)}`, (p, a, t) => renameCompNode(p, shotId, id, to, a, t)),
    renderSettings: (change: Parameters<typeof setCompRenderSettings>[2]) => edit('render settings', (p, a, t) => setCompRenderSettings(p, shotId, change, a, t)),
    undo: () => {
      const stack = undo.current.get(shotId) ?? [];
      const last = stack.pop();
      if (!last) return;
      if (onComp((p, a, t) => restoreCompGraph(p, shotId, last.graph, last.label, a, t))) notify('info', `Undone: ${last.label}`);
      else stack.push(last);
      setUndoCount(stack.length);
    },
    render: () =>
      guard('Rendering…', async () => {
        if (!api.compRender) throw new Error('Rendering is not available here.');
        const out = await runJob(`Rendering the comp of ${state?.vfxShotId ?? shotId}`, async (jobId) => unwrap(await api.compRender!({ jobId, text: textRef.current, shotId, projectKey, operator: actor })));
        if (onComp((p, a, t) => recordCompRender(p, shotId, out.record, a, t))) notify('ok', `Comp ${versionTag(out.record.version)} rendered: ${out.record.frames} frames in ${out.folder} (${(out.record.frames / Math.max(0.01, out.record.seconds)).toFixed(1)} fps).`);
      }),
    exportIt: () =>
      guard('Exporting…', async () => {
        if (!api.compExport) throw new Error('Exporting is not available here.');
        const out = await runJob(`Exporting the comp of ${state?.vfxShotId ?? shotId}`, async (jobId) => unwrap(await api.compExport!({ jobId, text: textRef.current, shotId, projectKey, operator: actor })));
        if (onComp((p, a, t) => recordCompExport(p, shotId, out.record, a, t))) notify('ok', `Comp ${versionTag(out.record.version)} exported for Nuke: ${out.files} files in ${out.folder}${out.record.untranslated.length ? ` — ${out.record.untranslated.length} thing${out.record.untranslated.length === 1 ? '' : 's'} not carried exactly (see the README)` : ''}.`);
      }),
  };

  const render = doc?.renders.find((r) => r.version === version) ?? null;
  const renderCurrent = Boolean(render && render.revision === doc?.revision);
  const exported = doc?.exports.find((e) => e.version === version) ?? null;
  const exportCurrent = Boolean(exported && exported.revision === doc?.revision);
  const primary = selected.length ? (compNode(doc, selected[selected.length - 1]) ?? null) : null;
  const range = compRenderRange(doc, first, last);

  return {
    props,
    state,
    doc,
    task,
    locked,
    version,
    supported,
    session,
    sessionError,
    view,
    viewError,
    loading,
    selected,
    primary,
    mode,
    setMode,
    wipe,
    setWipe,
    channel,
    setChannel,
    proxy,
    setProxy,
    working,
    viewer,
    first,
    last,
    range,
    canChange,
    canEdit,
    busy: props.busy || working !== null,
    problems,
    errors,
    render,
    renderCurrent,
    exported,
    exportCurrent,
    canUndo: undoCount > 0,
    frame,
    onFrame,
    actions,
  };
}
export type CompController = ReturnType<typeof useCompController>;

// ---------------------------------------------------------------------------
// Steps (left)
// ---------------------------------------------------------------------------

export interface CompStepDef {
  id: string;
  title: string;
  hint?: string;
  done: boolean;
  optional?: boolean;
  waiting?: string | null;
  content: ReactNode;
}

function ProblemList({ problems, ctl }: { problems: readonly CompProblem[]; ctl: CompController }) {
  if (!problems.length) return <p className="key-note comp-ok">The graph is complete: nothing is missing or mismatched.</p>;
  return (
    <ul className="comp-problems">
      {problems.slice(0, 8).map((x, i) => (
        <li key={i} className={`comp-problem ${x.severity}`}>
          <button type="button" className="link" disabled={!x.node} onClick={() => x.node && ctl.actions.select([x.node])}>
            {x.message}
          </button>
        </li>
      ))}
      {problems.length > 8 ? <li className="muted">and {problems.length - 8} more</li> : null}
    </ul>
  );
}

export function compStepDefs(ctl: CompController): CompStepDef[] {
  const { doc, canChange, actions, busy, session } = ctl;
  const has = Boolean(doc?.nodes.length);
  const suggestion = ctl.state && !has ? suggestedCompGraph(ctl.props.project, ctl.props.shotId) : null;
  const blocking = ctl.errors;
  const notes = ctl.problems.filter((x) => x.severity !== 'error');
  return [
    {
      id: 'start',
      title: 'Start the graph',
      hint: 'From what the shot already has, or empty.',
      done: has,
      content: has ? (
        <p className="key-note">
          {doc!.nodes.length} nodes, {doc!.edges.length} connections · graph revision {doc!.revision}
        </p>
      ) : (
        <>
          <div className="action">
            <button type="button" className="primary big" disabled={!canChange || busy} onClick={() => actions.start('suggested')}>
              Start from the suggested graph
            </button>
          </div>
          {suggestion ? <p className="key-note">{suggestion.nodes.map((n) => n.name).join(' · ')}</p> : null}
          <button type="button" disabled={!canChange || busy} onClick={() => actions.start('empty')}>
            Start empty (Read → Write)
          </button>
        </>
      ),
    },
    {
      id: 'edit',
      title: 'Edit the graph',
      hint: 'Add nodes (Tab), connect output → input, select a node for its parameters.',
      done: has && blocking.length === 0,
      waiting: has ? null : 'Start the graph first (step 1).',
      content: (
        <>
          <p className="key-note">
            <kbd>Tab</kbd> adds a node after the selected one · drag an output onto an input · <kbd>D</kbd> bypasses · <kbd>Delete</kbd> removes · <kbd>L</kbd> lays out · <kbd>⌘/Ctrl Z</kbd> undoes.
          </p>
          <ProblemList problems={[...blocking, ...notes]} ctl={ctl} />
        </>
      ),
    },
    {
      id: 'preview',
      title: 'Preview',
      hint: 'Any two nodes: 1 and 2 put the selected node in the viewer; wipe between them.',
      done: has && blocking.length === 0 && Boolean(ctl.view && (ctl.view.a || ctl.view.b) && !ctl.view.errors.a),
      waiting: has ? null : 'Start the graph first (step 1).',
      content: (
        <>
          <p className="key-note">
            1: <strong>{compNode(doc, ctl.viewer.a)?.name ?? '—'}</strong> · 2: <strong>{compNode(doc, ctl.viewer.b)?.name ?? '—'}</strong>
          </p>
          <Check label="Proxy (half resolution, faster)" checked={ctl.proxy} onChange={(v) => ctl.setProxy(v)} />
          {ctl.view ? (
            <p className="key-note">
              {ctl.view.width}×{ctl.view.height} · {ctl.view.ms} ms · {ctl.view.computed} node{ctl.view.computed === 1 ? '' : 's'} computed, {ctl.view.cached} from the cache
            </p>
          ) : null}
        </>
      ),
    },
    {
      id: 'render',
      title: `Render comp ${versionTag(ctl.version)}`,
      hint: 'The Write node at plate resolution: half-float EXR, linear, no look — and a review encode — into 08_PREVIEWS.',
      done: ctl.renderCurrent,
      waiting: !has ? 'Start the graph first (step 1).' : blocking.length ? `Fix the graph first (step 2): ${blocking[0]!.message}` : null,
      content: (
        <>
          <div className="key-row comp-range">
            <label className="key-field">
              <span>First</span>
              <input type="number" min={ctl.first} max={ctl.last} value={ctl.range.first} disabled={!canChange} onChange={(e) => actions.renderSettings({ first: Number(e.target.value) || null })} />
            </label>
            <label className="key-field">
              <span>Last</span>
              <input type="number" min={ctl.first} max={ctl.last} value={ctl.range.last} disabled={!canChange} onChange={(e) => actions.renderSettings({ last: Number(e.target.value) || null })} />
            </label>
            <button type="button" className="small" disabled={!canChange || (doc?.render.first === null && doc?.render.last === null)} onClick={() => actions.renderSettings({ first: null, last: null })}>
              Whole shot
            </button>
          </div>
          <span className="key-slider-label cp-label">Review encode (Rec.709 approx. view)</span>
          <Seg label="Review encode" value={doc?.render.review ?? 'jpeg'} options={[['jpeg', 'JPEG'], ['png', 'PNG'], ['none', 'None']] as const} disabled={!canChange} onChange={(v) => actions.renderSettings({ review: v })} />
          <div className="action">
            <button type="button" className="primary big" disabled={!canChange || busy || !session?.exportable} title={session && !session.exportable ? 'Rendering is the desktop app’s' : undefined} onClick={() => void actions.render()}>
              {ctl.render && !ctl.renderCurrent ? 'Render again (graph changed)' : `Render ${ctl.range.last - ctl.range.first + 1} frames`}
            </button>
          </div>
          {session && !session.exportable ? <p className="muted key-note">Rendering writes into the shot package on disk: the desktop app does it.</p> : null}
          {ctl.render ? (
            <p className="key-note">
              Rendered {ctl.render.frames} frames to {ctl.render.folder} ({(ctl.render.frames / Math.max(0.01, ctl.render.seconds)).toFixed(1)} fps){ctl.renderCurrent ? '' : ' — the graph changed since'}.
            </p>
          ) : null}
        </>
      ),
    },
    {
      id: 'export',
      title: 'Export for Nuke',
      hint: 'The graph, a Nuke script, the graph manifest with checksums, into 09_PROJECT_DATA. Approve it in Details.',
      done: ctl.exportCurrent,
      waiting: !ctl.renderCurrent ? 'Render with the current graph first (step 4).' : null,
      content: (
        <>
          <p className="key-note">Nodes Nuke has a class for become that class; module nodes read the modules’ exports; Despill and LightWrap are rendered by VC VFX and read back. What is not carried exactly is listed in the manifest and the README.</p>
          <div className="action">
            <button type="button" className="primary big" disabled={!canChange || busy || !session?.exportable} onClick={() => void actions.exportIt()}>
              Export comp {versionTag(ctl.version)}
            </button>
          </div>
          {ctl.exported ? (
            <p className="key-note">
              Written to {ctl.exported.folder}
              {ctl.exported.untranslated.length ? ` · ${ctl.exported.untranslated.length} not carried exactly` : ''}
              {ctl.exportCurrent ? '' : ' — the graph changed since; render and export again'}.
            </p>
          ) : null}
        </>
      ),
    },
  ];
}

// ---------------------------------------------------------------------------
// The viewer and the graph (centre)
// ---------------------------------------------------------------------------

/** The RGBA picture of a view: A, B, or the wipe (A left of the line, B right), in colour or alpha. */
export function composeComp(view: CompFrameView, mode: CompViewMode, wipe: number, channel: 'rgb' | 'alpha'): Uint8ClampedArray<ArrayBuffer> {
  const { width: w, height: h } = view;
  const out = new Uint8ClampedArray(w * h * 4);
  const split = Math.round(wipe * w);
  for (let y = 0; y < h; y += 1)
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      const pic = mode === 'a' ? view.a : mode === 'b' ? view.b : x < split ? view.a : view.b;
      const o = 4 * i;
      out[o + 3] = 255;
      if (!pic) {
        // Nothing to show on this side: a dark checker.
        const c = ((x >> 4) + (y >> 4)) & 1 ? 28 : 20;
        out[o] = c;
        out[o + 1] = c;
        out[o + 2] = c;
        continue;
      }
      if (channel === 'alpha') {
        const a = pic.alpha[i]!;
        out[o] = a;
        out[o + 1] = a;
        out[o + 2] = a;
      } else {
        out[o] = pic.rgb[3 * i]!;
        out[o + 1] = pic.rgb[3 * i + 1]!;
        out[o + 2] = pic.rgb[3 * i + 2]!;
      }
    }
  return out;
}

export function CompViewer({ ctl }: { ctl: CompController }) {
  const { view, mode, setMode, wipe, setWipe, channel, setChannel, first, last, frame, onFrame, doc, viewer } = ctl;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const stageSize = useStageSize(stageRef);
  const aspect = useShotAspect(ctl.props.project, ctl.props.shotId);
  const [split, setSplit] = useState(0.5);
  const centreRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c || !view) return;
    c.width = view.width;
    c.height = view.height;
    const g = c.getContext('2d');
    if (!g) return;
    g.putImageData(new ImageData(composeComp(view, mode, wipe, channel), view.width, view.height), 0, 0);
  }, [view, mode, wipe, channel]);

  const toView = (e: ReactPointerEvent): number | null => {
    const el = stageRef.current;
    if (!el || !view) return null;
    const p = clientToImage(el, view, aspect.display, e.clientX, e.clientY, true);
    return p ? Math.max(0, Math.min(1, p.x / view.width)) : null;
  };
  const nameA = compNode(doc, viewer.a)?.name ?? null;
  const nameB = compNode(doc, viewer.b)?.name ?? null;
  const shownError = mode === 'a' ? view?.errors.a : mode === 'b' ? view?.errors.b : (view?.errors.a ?? view?.errors.b);
  const message =
    ctl.sessionError ??
    (ctl.session && !ctl.session.available ? ctl.session.reason : null) ??
    (!doc?.nodes.length ? 'Start the graph (step 1): the viewer shows any node of it.' : null) ??
    (!viewer.a && !viewer.b ? 'Select a node in the graph and press 1 (or 2) to view it.' : null) ??
    (view ? null : ctl.viewError) ??
    shownError ??
    null;
  const count = Math.max(1, last - first + 1);
  const onSplitDown = (e: ReactPointerEvent) => {
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  };
  const onSplitMove = (e: ReactPointerEvent) => {
    if (e.buttons !== 1) return;
    const r = centreRef.current?.getBoundingClientRect();
    if (!r) return;
    setSplit(Math.max(0.25, Math.min(0.8, (e.clientY - r.top) / r.height)));
  };

  return (
    <div ref={centreRef} className="comp-centre" style={{ gridTemplateRows: `minmax(0, ${split}fr) 8px minmax(0, ${1 - split}fr)` }}>
      <div className="key-viewer comp-viewer" role="region" aria-label={`Comp viewer — ${ctl.state?.vfxShotId ?? ctl.props.shotId}`}>
        <div className="key-viewer-bar comp-viewer-bar">
          <div className="seg key-modes" role="tablist" aria-label="View">
            <button type="button" role="tab" aria-selected={mode === 'a'} className={mode === 'a' ? 'on' : undefined} onClick={() => setMode('a')} title="Node 1 (select a node, press 1)">
              1: {nameA ?? '—'}
            </button>
            <button type="button" role="tab" aria-selected={mode === 'b'} className={mode === 'b' ? 'on' : undefined} onClick={() => setMode('b')} title="Node 2 (select a node, press 2)">
              2: {nameB ?? '—'}
            </button>
            <button type="button" role="tab" aria-selected={mode === 'wipe'} className={mode === 'wipe' ? 'on' : undefined} onClick={() => setMode('wipe')} disabled={!nameA || !nameB} title="A/B wipe: 1 on the left, 2 on the right; drag to move the line">
              A/B wipe
            </button>
          </div>
          <span className="spacer" />
          <div className="seg" role="group" aria-label="Channels">
            <button type="button" aria-pressed={channel === 'rgb'} className={channel === 'rgb' ? 'on' : undefined} onClick={() => setChannel('rgb')}>
              RGB
            </button>
            <button type="button" aria-pressed={channel === 'alpha'} className={channel === 'alpha' ? 'on' : undefined} onClick={() => setChannel('alpha')}>
              A
            </button>
          </div>
        </div>
        <div
          ref={stageRef}
          className={`key-stage comp-stage${mode === 'wipe' ? ' tool-wipe' : ''}`}
          onPointerDown={(e) => {
            if (mode !== 'wipe') return;
            (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
            const x = toView(e);
            if (x !== null) setWipe(x);
          }}
          onPointerMove={(e) => {
            if (mode !== 'wipe' || e.buttons !== 1) return;
            const x = toView(e);
            if (x !== null) setWipe(x);
          }}
        >
          <FrameBox stage={stageSize} size={view} pixelAspect={aspect.display}>
          {view ? <canvas ref={canvasRef} className="key-canvas" aria-label={`${mode === 'wipe' ? `${nameA} | ${nameB}` : mode === 'a' ? nameA : nameB} on frame ${view.frame}${channel === 'alpha' ? ', alpha' : ''}`} /> : null}
          {view && mode === 'wipe' ? (
            <svg className="key-overlay" viewBox={`0 0 ${view.width} ${view.height}`} preserveAspectRatio={overlayAspect(stageSize)} aria-hidden="true">
              <line className="key-wipe" x1={wipe * view.width} x2={wipe * view.width} y1={0} y2={view.height} />
              <text x={wipe * view.width - 6} y={14} textAnchor="end" className="comp-wipe-label">
                1
              </text>
              <text x={wipe * view.width + 6} y={14} className="comp-wipe-label">
                2
              </text>
            </svg>
          ) : null}
          </FrameBox>
          {view ? <AspectTag aspect={aspect} /> : null}
          {message ? <div className="key-message">{message}</div> : null}
          {ctl.loading && view ? <div className="key-busy" aria-live="polite">Computing…</div> : null}
        </div>
        <div className="key-timeline-row comp-timeline">
          <button type="button" aria-label="Previous frame" onClick={() => onFrame(Math.max(first, frame - 1))}>
            ◀
          </button>
          <input className="comp-scrub" type="range" aria-label="Frame" min={first} max={last} step={1} value={Math.max(first, Math.min(last, frame))} onChange={(e) => onFrame(Number(e.target.value))} />
          <button type="button" aria-label="Next frame" onClick={() => onFrame(Math.min(last, frame + 1))}>
            ▶
          </button>
          <span className="key-frame mono">{frame}</span>
          <span className="muted comp-count">{count} frames</span>
        </div>
      </div>
      <div className="comp-split" role="separator" aria-orientation="horizontal" aria-label="Resize the viewer and the graph" onPointerDown={onSplitDown} onPointerMove={onSplitMove} />
      {doc?.nodes.length ? (
        <GraphEditor
          doc={doc}
          selected={ctl.selected}
          viewer={viewer}
          problems={ctl.problems}
          disabled={!ctl.canChange}
          onSelect={ctl.actions.select}
          onMove={ctl.actions.move}
          onConnect={ctl.actions.connect}
          onDisconnect={ctl.actions.disconnect}
          onAdd={(t, at) => ctl.actions.add(t, at)}
          onDelete={ctl.actions.remove}
          onBypass={ctl.actions.bypass}
          onViewer={ctl.actions.viewer}
          onLayout={ctl.actions.layout}
          onUndo={ctl.actions.undo}
          canUndo={ctl.canUndo}
        />
      ) : (
        <div className="comp-graph comp-graph-empty">
          <p>The node graph appears here once the comp is started (step 1).</p>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The selected node's parameters, and the numbers (right)
// ---------------------------------------------------------------------------

const fmtNum = (v: number, step: number) => (step >= 1 ? String(Math.round(v)) : String(+v.toFixed(step >= 0.01 ? 2 : 3)));

function NumberField({ label, value, step, min, max, disabled, onCommit }: { label: string; value: number; step: number; min: number; max: number; disabled: boolean; onCommit(v: number): void }) {
  const [draft, setDraft] = useState(fmtNum(value, step));
  useEffect(() => setDraft(fmtNum(value, step)), [value, step]);
  const commit = () => {
    const v = Number(draft);
    if (Number.isFinite(v) && v !== value) onCommit(Math.max(min, Math.min(max, v)));
    else setDraft(fmtNum(value, step));
  };
  return (
    <label className="key-field comp-num">
      <span>{label}</span>
      <input type="number" step={step} min={min} max={max} value={draft} disabled={disabled} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />
    </label>
  );
}

function ParamRow({ ctl, node, spec, value }: { ctl: CompController; node: CompNode; spec: CompParamSpec; value: CompParamValue }) {
  const disabled = !ctl.canChange;
  const set = (v: CompParamValue) => ctl.actions.params(node.id, { [spec.key]: v });
  const changed = JSON.stringify(value) !== JSON.stringify(defaultCompParams(node.type)[spec.key]);
  const reset = changed ? (
    <button type="button" className="icon comp-reset" title={`Reset ${spec.label} to its default`} aria-label={`Reset ${spec.label}`} disabled={disabled} onClick={() => ctl.actions.reset(node.id, [spec.key])}>
      ↺
    </button>
  ) : (
    <span className="comp-reset-space" />
  );
  const state = ctl.state;
  let field: ReactNode;
  switch (spec.kind) {
    case 'number':
      field =
        spec.max - spec.min <= 1000 ? (
          <Slider label={spec.label} value={Number(value)} min={Math.max(spec.min, spec.key === 'size' || spec.px ? spec.min : spec.min)} max={spec.max > 64 && spec.px ? Math.min(spec.max, 200) : spec.max} step={spec.step} unit={spec.unit} disabled={disabled} hint={spec.hint} onCommit={(v) => set(v)} />
        ) : (
          <NumberField label={spec.label} value={Number(value)} step={spec.step} min={spec.min} max={spec.max} disabled={disabled} onCommit={set} />
        );
      break;
    case 'int':
      field = <NumberField label={spec.label} value={Number(value)} step={1} min={spec.min} max={spec.max} disabled={disabled} onCommit={(v) => set(Math.round(v))} />;
      break;
    case 'bool':
      field = <Check label={spec.label} checked={Boolean(value)} disabled={disabled} hint={spec.hint} onChange={(v) => set(v)} />;
      break;
    case 'enum':
      field = (
        <label className="key-field comp-select">
          <span>{spec.label}</span>
          <select aria-label={spec.label} value={String(value)} disabled={disabled} onChange={(e) => set(e.target.value)}>
            {spec.options.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
      );
      break;
    case 'vec2': {
      const v = value as number[];
      field = (
        <div className="comp-vec" role="group" aria-label={spec.label}>
          <span className="key-slider-label">{spec.label}</span>
          <NumberField label="x" value={v[0]!} step={spec.step} min={spec.min} max={spec.max} disabled={disabled} onCommit={(x) => set([x, v[1]!])} />
          <NumberField label="y" value={v[1]!} step={spec.step} min={spec.min} max={spec.max} disabled={disabled} onCommit={(y) => set([v[0]!, y])} />
        </div>
      );
      break;
    }
    case 'color': {
      const v = value as number[];
      field = (
        <div className="comp-vec comp-color" role="group" aria-label={spec.label}>
          <span className="key-slider-label">{spec.label}</span>
          {(['r', 'g', 'b', 'a'] as const).map((c, i) => (
            <NumberField key={c} label={c} value={v[i]!} step={0.01} min={c === 'a' ? 0 : -64} max={c === 'a' ? 1 : 64} disabled={disabled} onCommit={(x) => set(v.map((y, k) => (k === i ? x : y)))} />
          ))}
        </div>
      );
      break;
    }
    case 'track': {
      const tracks = state?.track2d?.tracks ?? [];
      field = (
        <label className="key-field comp-select">
          <span>{spec.label}</span>
          <select aria-label={spec.label} value={String(value)} disabled={disabled} onChange={(e) => set(e.target.value)}>
            <option value="">{tracks.length ? 'Choose a track…' : 'No 2D tracks on this shot'}</option>
            {tracks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.kind}, {t.frames.length} frames)
              </option>
            ))}
          </select>
        </label>
      );
      break;
    }
    case 'part':
    case 'region': {
      const source = node.type === 'read' ? String(compNodeParams(node)['source']) : node.type;
      const roto = source === 'roto';
      const texture = source === 'texture';
      if (!roto && !texture) return null;
      const items = roto ? (state?.roto?.parts ?? []).map((x) => [x.id, x.name] as const) : (state?.texture?.regions ?? []).map((x) => [x.id, x.name] as const);
      field = (
        <label className="key-field comp-select">
          <span>{roto ? 'Roto part' : 'Texture region'}</span>
          <select aria-label={roto ? 'Roto part' : 'Texture region'} value={String(value)} disabled={disabled} onChange={(e) => set(e.target.value)}>
            <option value="">{roto ? 'All parts (the combined matte)' : 'The first region'}</option>
            {items.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
      );
      break;
    }
  }
  return (
    <div className={`comp-param${changed ? ' changed' : ''}`} data-param={spec.key}>
      <div className="comp-param-field">{field}</div>
      {reset}
    </div>
  );
}

/** Parameters a node shows: only what applies (a corner pin's typed corners when typed, a track when tracked). */
function visibleParams(node: CompNode): CompParamSpec[] {
  const p = compNodeParams(node);
  return COMP_NODES[node.type].params.filter((s) => {
    if (node.type === 'cornerpin') {
      if (s.key.startsWith('to')) return p['source'] === 'manual';
      if (s.key === 'track' || s.key === 'mode' || s.key === 'reference') return p['source'] === 'track';
    }
    if (node.type === 'despill' && s.key === 'weight') return p['limit'] === 'weighted';
    if (node.type === 'despill' && s.key === 'backgroundBlur') return p['restore'] === 'background';
    return true;
  });
}

export function CompParams({ ctl }: { ctl: CompController }) {
  const node = ctl.primary;
  const [nameDraft, setNameDraft] = useState(node?.name ?? '');
  useEffect(() => setNameDraft(node?.name ?? ''), [node?.id, node?.name]);
  if (!ctl.doc?.nodes.length) return null;
  if (!node)
    return (
      <section className="info-section comp-params">
        <h4>Parameters</h4>
        <p className="muted key-note">Select a node in the graph to see and change its parameters.</p>
      </section>
    );
  const info = COMP_NODES[node.type];
  const params = compNodeParams(node);
  const problems = ctl.problems.filter((x) => x.node === node.id);
  const source = ctl.session?.sources.find((s) => s.node === node.id);
  const anyChanged = Object.keys(node.params).length > 0;
  return (
    <section className="info-section comp-params" aria-label={`Parameters of ${node.name}`}>
      <h4>
        {node.name} <span className="muted">· {info.label}</span>
      </h4>
      <p className="muted key-note">{info.blurb}</p>
      <div className="key-row comp-name-row">
        <label className="key-field">
          <span>Name</span>
          <input
            value={nameDraft}
            aria-label="Node name"
            disabled={!ctl.canChange}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={() => nameDraft !== node.name && ctl.actions.rename(node.id, nameDraft)}
            onKeyDown={(e) => e.key === 'Enter' && nameDraft !== node.name && ctl.actions.rename(node.id, nameDraft)}
          />
        </label>
        <Check label="Bypass (D)" checked={node.disabled} disabled={!ctl.canChange} onChange={() => ctl.actions.bypass([node.id])} />
      </div>
      <div className="key-row">
        <button type="button" className="small" onClick={() => ctl.actions.viewer('a', node.id)} title="View this node as 1 (1)">
          View as 1
        </button>
        <button type="button" className="small" onClick={() => ctl.actions.viewer('b', node.id)} title="View this node as 2 (2)">
          View as 2
        </button>
        <span className="spacer" />
        <button type="button" className="small" disabled={!ctl.canChange || !anyChanged} onClick={() => ctl.actions.reset(node.id, null)}>
          Reset all
        </button>
      </div>
      {source ? <p className={`key-note${source.ok ? '' : ' warn-text'}`}>{source.ok ? `Reads: ${source.label}` : source.reason}</p> : null}
      {problems.map((x, i) => (
        <p key={i} className={x.severity === 'error' ? 'warn-text' : 'muted key-note'}>
          {x.message}
        </p>
      ))}
      {info.module ? <p className="muted key-note">This is the module’s own result: change it in its tab, and export it there for the desktop comp to read.</p> : null}
      <div className="comp-param-list">
        {visibleParams(node).map((spec) => (
          <ParamRow key={spec.key} ctl={ctl} node={node} spec={spec} value={params[spec.key]!} />
        ))}
        {!info.params.length ? <p className="muted key-note">No parameters.</p> : null}
      </div>
    </section>
  );
}

export function CompInfo({ ctl }: { ctl: CompController }) {
  const { doc, task, version, session, render } = ctl;
  return (
    <div className="key-info comp-info">
      <CompParams ctl={ctl} />
      <div className="stats">
        <Big label="Nodes" value={doc?.nodes.length ?? '—'} />
        <Big label="Problems" value={doc ? ctl.errors.length : '—'} tone={doc ? (ctl.errors.length ? 'bad' : 'ok') : undefined} />
        <Big label="Preview" value={ctl.view ? `${ctl.view.ms}` : '—'} unit={ctl.view ? ' ms' : undefined} title={ctl.view ? `${ctl.view.computed} computed, ${ctl.view.cached} from the cache` : undefined} />
        <Big label="Rendered" value={render ? versionTag(render.version) : 'no'} tone={render ? (ctl.renderCurrent ? 'ok' : 'warn') : undefined} title={render && !ctl.renderCurrent ? 'The graph changed since the render' : undefined} />
      </div>
      <section className="info-section">
        <h4>Version</h4>
        <dl className="key-kv">
          <dt>Comp</dt>
          <dd>
            {versionTag(version)} · {task ? TASK_STATE_LABELS[task.state] : 'no task'}
            {task?.approval ? ` · approved by ${task.approval.by}` : ''}
          </dd>
          <dt>Graph</dt>
          <dd>revision {doc?.revision ?? 0}</dd>
          <dt>Exported</dt>
          <dd>{ctl.exported ? `${ctl.exported.folder}${ctl.exportCurrent ? '' : ' (graph changed since)'}` : 'not yet'}</dd>
          <dt>Plate</dt>
          <dd>{session?.frames || '—'}</dd>
          <dt>Colour</dt>
          <dd>{session?.encoding.label || '—'}, premultiplied</dd>
        </dl>
        {session?.encoding.note ? <p className="warn-text">{session.encoding.note}</p> : null}
      </section>
      {session?.sources.length ? (
        <section className="info-section">
          <h4>Module outputs read</h4>
          <ul className="comp-sources">
            {session.sources.map((s) => (
              <li key={s.node} className={s.ok ? 'ok' : 'missing'} title={s.reason ?? undefined}>
                <strong>{compNode(doc, s.node)?.name ?? s.node}</strong> · {s.ok ? s.label : `${COMP_SOURCE_LABELS[s.source]} — not available`}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
