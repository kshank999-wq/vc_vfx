import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { AspectTag, FrameBox, overlayAspect, useShotAspect, useStageSize } from '../FrameBox';
import { clientToImage } from '../../frame-fit';
import {
  DEFAULT_ISOLATE_PARAMS,
  ISOLATE_LOW_CONFIDENCE,
  ISOLATE_MAX_UNSEEN_SKY,
  ISOLATE_TASK,
  PREP_TASKS,
  TASK_STATE_LABELS,
  addIsolateStroke,
  addPart,
  addTask,
  clearIsolateStrokes,
  flagIsolateFrame,
  isolateConfidenceSummary,
  isolateCorrectionRange,
  isolateDoc,
  isolateLocked,
  isolateProblemReasons,
  isolateReview,
  isolateSeedFrame,
  isolateSeedProblem,
  isolateTaskVersion,
  markIsolateFrameReviewed,
  nextIsolateProblem,
  recordIsolateExport,
  recordIsolateRun,
  recordPropagation,
  rotoPart,
  serializeProject,
  setIsolateSeed,
  setIsolateSettings,
  shotState,
  versionTag,
  type IsolateDocument,
  type IsolateRect,
  type IsolateSeedMode,
  type IsolateSettingsChange,
  type IsolateTarget,
  type PrepTaskKind,
  type Project,
  type Result,
} from '@vcvfx/domain';
import type { VcvfxApi } from '../../../shared/bridge';
import type { IsolateFrameView, IsolateSessionInfo } from '../../../shared/isolate/bridge-types';
import { Big, Check, Seg, Slider, confidenceColour } from '../cleanplate/CleanPlateWorkspace';
import '../key/key.css';
import '../cleanplate/cleanplate.css';
import './isolate.css';

/**
 * The Sky & BG workspace (master spec §11; addendum 11): choose what to
 * isolate (the sky, or a subject from its background), show it how to start
 * (automatic for the sky; a box, paint or a roto part for a subject), build
 * the matte, foreground and plate through the shot, review them against the
 * source with the uncertain edge and the unseen plate shown, paint
 * corrections on any frame (carried to the neighbouring frames), and export
 * versioned mattes, foregrounds, plates and the sequence manifest.
 *
 * Built for the three-zone module screen (addendum 08), as the Clean Plate
 * is: `useIsolateController` holds the state and actions; `isolateStepDefs`
 * (left), `IsolateViewer` (centre) and `IsolateInfo` (right) draw from it.
 * Every change is a logged domain mutation applied through `onIsolate`. A
 * build puts the task up for review; nothing here approves.
 */

export type IsolateMutation = (p: Project, actor: string, now: Date) => Result;

export interface IsolateWorkspaceProps {
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
  onIsolate(fn: IsolateMutation): boolean;
  runJob<T>(label: string, fn: (jobId: string) => Promise<T>): Promise<T>;
  notify(kind: 'ok' | 'error' | 'info', text: string): void;
  /** Open the Roto tab (to paint the subject). */
  onOpenRoto?(frame: number): void;
  /** Add the other target's task to the shot. */
  onAddTask?(kind: PrepTaskKind): void;
}

export const ISOLATE_VIEWS = ['source', 'matte', 'foreground', 'plate', 'overlay'] as const;
export type IsolateViewMode = (typeof ISOLATE_VIEWS)[number];
export const isolateViewLabel = (m: IsolateViewMode, target: IsolateTarget): string =>
  ({ source: 'Source', matte: 'Matte', foreground: 'Foreground', plate: target === 'sky' ? 'Sky plate' : 'Background plate', overlay: 'Overlay' })[m];
export type IsolateTool = 'box' | 'paint' | null;

const TARGET_WORD: Record<IsolateTarget, { other: string; keep: string }> = {
  sky: { other: 'sky', keep: 'Keep in front' },
  background: { other: 'background', keep: 'Keep as subject' },
};

const unwrap = <T,>(r: { ok: true; data: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(r.error);
  return r.data;
};

/** The target a shot opens on: the sky when it has that task, else the background. */
export function defaultTarget(project: Project, shotId: string): IsolateTarget {
  const kinds = shotState(project, shotId)?.tasks.map((t) => t.kind) ?? [];
  return kinds.includes('sky_replacement') || !kinds.includes('background_removal') ? 'sky' : 'background';
}

/**
 * The sample's subject as a roto part (browser preview only): the part, its
 * mattes over the shot, and the subject seeded from it — one logged mutation
 * chain.
 */
function adoptSampleSubject(p: Project, shotId: string, name: string, range: { first: number; last: number }, actor: string, now: Date): Result {
  let project = p;
  const step = (r: Result) => {
    if (r.ok) project = r.project;
    return r;
  };
  if (!shotState(project, shotId)?.tasks.some((t) => t.kind === 'roto')) {
    const r = step(addTask(project, shotId, 'roto', actor, now));
    if (!r.ok) return r;
  }
  let partId = shotState(project, shotId)?.roto?.parts.find((x) => x.name === name)?.id ?? '';
  if (!partId) {
    const r = step(addPart(project, shotId, { name }, actor, now));
    if (!r.ok) return r;
    partId = shotState(project, shotId)!.roto!.parts.find((x) => x.name === name)!.id;
    const frames = Array.from({ length: range.last - range.first + 1 }, (_, i) => ({ frame: range.first + i, confidence: 0.95 }));
    const r2 = step(recordPropagation(project, shotId, { partId, engine: { id: 'track', version: 'sample roto' }, direction: 'forward', from: range.first, frames }, actor, now));
    if (!r2.ok) return r2;
  }
  const r3 = step(setIsolateSeed(project, shotId, 'background', { mode: 'roto', partId }, actor, now));
  if (!r3.ok) return r3;
  return { ok: true, project };
}

// ---------------------------------------------------------------------------
// The controller
// ---------------------------------------------------------------------------

export function useIsolateController(props: IsolateWorkspaceProps) {
  const { api, project, shotId, projectKey, canEdit, actor, frame, onFrame, onIsolate, runJob, notify } = props;
  const state = shotState(project, shotId);
  const [target, setTarget] = useState<IsolateTarget>(() => defaultTarget(project, shotId));
  useEffect(() => setTarget(defaultTarget(project, shotId)), [shotId]); // eslint-disable-line react-hooks/exhaustive-deps
  const doc: IsolateDocument | null = isolateDoc(state, target);
  const kind = ISOLATE_TASK[target];
  const task = state?.tasks.find((t) => t.kind === kind) ?? null;
  const hasTask = Boolean(task);
  const has = { sky: Boolean(state?.tasks.some((t) => t.kind === 'sky_replacement')), background: Boolean(state?.tasks.some((t) => t.kind === 'background_removal')) };
  const locked = state ? isolateLocked(state, target) : 'No shot';
  const version = state ? isolateTaskVersion(state, target) : 1;
  const text = useMemo(() => serializeProject(project), [project]);
  const textRef = useRef(text);
  textRef.current = text;
  const supported = Boolean(api.isolateSession && api.isolateFrame);

  // The session of the target it was asked for: kept while the same target's is asked again (a setting changed).
  const [sessionOf, setSessionOf] = useState<{ target: IsolateTarget; info: IsolateSessionInfo } | null>(null);
  const session = sessionOf?.target === target ? sessionOf.info : null;
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [view, setView] = useState<IsolateFrameView | null>(null);
  const [viewError, setViewError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<IsolateViewMode>('source');
  const [wipe, setWipe] = useState<{ on: boolean; x: number }>({ on: false, x: 0.5 });
  const [tool, setTool] = useState<IsolateTool>(null);
  const [paint, setPaint] = useState<'include' | 'exclude'>('include');
  const [brush, setBrush] = useState<number | null>(null);
  const [working, setWorking] = useState<string | null>(null);

  const first = session?.first ?? frame;
  const last = session?.last ?? frame;
  const plate = session?.plate ?? null;
  const canChange = canEdit && !locked && Boolean(session?.available);
  const brushPx = brush ?? Math.max(4, Math.round((plate?.width ?? 1920) * 0.012));

  const sessionKey = JSON.stringify([shotId, projectKey, target, hasTask, doc?.workingWidth ?? null, state?.plates.length ?? 0]);
  useEffect(() => {
    if (!api.isolateSession) return;
    let live = true;
    setSessionError(null);
    void api.isolateSession({ text: textRef.current, shotId, projectKey, target }).then((r) => {
      if (!live) return;
      if (r.ok) setSessionOf({ target, info: r.data });
      else setSessionError(r.error);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, sessionKey]);

  // The frame view: whenever the frame, the target, or the build changes.
  const viewDeps = JSON.stringify([target, doc ? { rev: doc.revision, runs: doc.runs.length } : null]);
  const request = useRef(0);
  useEffect(() => {
    if (!api.isolateFrame || !session?.available) {
      setView(null);
      return;
    }
    const id = ++request.current;
    setLoading(true);
    const timer = setTimeout(() => {
      void api.isolateFrame!({ text: textRef.current, shotId, projectKey, target, frame, maxWidth: 960 }).then((r) => {
        if (id !== request.current) return;
        setLoading(false);
        if (r.ok) {
          setView(r.data);
          setViewError(null);
        } else setViewError(r.error);
      });
    }, 30);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, session?.available, viewDeps, frame, shotId]);

  const apply = useCallback((fn: IsolateMutation) => onIsolate(fn), [onIsolate]);
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

  const review = useMemo(() => isolateReview(doc, first, last), [doc, first, last]);
  const summary = useMemo(() => isolateConfidenceSummary(doc), [doc]);
  const record = doc?.frames.find((f) => f.frame === frame) ?? null;
  const lastRun = doc?.runs.filter((r) => r.taskVersion === version).at(-1) ?? null;
  const built = Boolean(lastRun && lastRun.revision === (doc?.revision ?? 0));
  const exported = doc?.exports.find((e) => e.version === version) ?? null;
  const exportCurrent = Boolean(exported && exported.revision === doc?.revision);
  const seedFrame = isolateSeedFrame(doc, first, last);
  const seedProblem = isolateSeedProblem(doc, target);
  const rotoParts = state?.roto?.parts.filter((p) => p.frames.length > 0) ?? [];
  const keyFrame = doc?.keyFrames.find((k) => k.frame === frame) ?? null;
  const what = target === 'sky' ? 'the sky' : 'the subject';

  const actions = {
    target: (t: IsolateTarget) => {
      setTarget(t);
      setTool(null);
      setMode('source');
    },
    seedMode: (m: IsolateSeedMode) => apply((p, a, t) => setIsolateSeed(p, shotId, target, { mode: m }, a, t)),
    seedHere: () => apply((p, a, t) => setIsolateSeed(p, shotId, target, { frame }, a, t)),
    box: (rect: IsolateRect) => apply((p, a, t) => setIsolateSeed(p, shotId, target, { mode: 'box', rect, frame }, a, t)),
    roto: (partId: string) => apply((p, a, t) => setIsolateSeed(p, shotId, target, { mode: 'roto', partId }, a, t)),
    useSampleSubject: () => {
      const name = session?.sampleSubjects?.[0]?.name;
      if (!name) return;
      if (apply((p, a, t) => adoptSampleSubject(p, shotId, name, { first, last }, a, t))) notify('ok', `The ${name.toLowerCase()} (the sample’s roto) is the subject. Build next (step 3).`);
    },
    settings: (change: IsolateSettingsChange) => apply((p, a, t) => setIsolateSettings(p, shotId, target, change, a, t)),
    stroke: (points: [number, number][]) => apply((p, a, t) => addIsolateStroke(p, shotId, target, frame, { mode: paint, radius: brushPx, points }, a, t)),
    undoStroke: () => apply((p, a, t) => clearIsolateStrokes(p, shotId, target, frame, 'last', a, t)),
    build: () =>
      guard('Building…', async () => {
        if (!api.isolateBuild) throw new Error('Building is not available here.');
        const { result } = await runJob(`Isolating ${what} of ${state?.vfxShotId ?? shotId}`, async (jobId) => unwrap(await api.isolateBuild!({ jobId, text: textRef.current, shotId, projectKey, target })));
        if (apply((p, a, t) => recordIsolateRun(p, shotId, target, result, a, t))) {
          const problems = [...isolateProblemReasons(result.frames, target).values()].filter(Boolean).length;
          notify('ok', `${result.frames.length} frames built. ${problems ? `${problems} frame${problems === 1 ? ' wants' : 's want'} a look: Next problem shows ${problems === 1 ? 'it' : 'them'}.` : 'No frame stands out as a problem.'}`);
          setMode('overlay');
        }
      }),
    nextProblem: () => {
      const next = nextIsolateProblem(review, frame);
      if (next !== null) onFrame(next);
    },
    flag: (note: string) => apply((p, a, t) => flagIsolateFrame(p, shotId, target, frame, note, a, t)),
    markReviewed: () => apply((p, a, t) => markIsolateFrameReviewed(p, shotId, target, frame, a, t)),
    exportIt: () =>
      guard('Exporting…', async () => {
        if (!api.isolateExport) throw new Error('Exporting is not available here.');
        const out = await runJob(`Exporting ${what} of ${state?.vfxShotId ?? shotId}`, async (jobId) => unwrap(await api.isolateExport!({ jobId, text: textRef.current, shotId, projectKey, target, operator: actor })));
        if (apply((p, a, t) => recordIsolateExport(p, shotId, target, out.record, a, t))) notify('ok', `${target === 'sky' ? 'Sky' : 'Background removal'} ${versionTag(out.record.version)} written: ${out.files} files in ${out.folder}`);
      }),
  };

  return {
    props,
    state,
    target,
    kind,
    doc,
    has,
    hasTask,
    task,
    locked,
    version,
    supported,
    session,
    sessionError,
    view,
    viewError,
    loading,
    mode,
    setMode,
    wipe,
    setWipe,
    tool,
    setTool,
    paint,
    setPaint,
    brushPx,
    setBrush,
    working,
    first,
    last,
    plate,
    canChange,
    canEdit,
    busy: props.busy || working !== null,
    review,
    summary,
    record,
    lastRun,
    built,
    exported,
    exportCurrent,
    seedFrame,
    seedProblem,
    rotoParts,
    keyFrame,
    frame,
    onFrame,
    actions,
  };
}
export type IsolateController = ReturnType<typeof useIsolateController>;

// ---------------------------------------------------------------------------
// Steps (left)
// ---------------------------------------------------------------------------

export interface IsolateStepDef {
  id: string;
  title: string;
  hint?: string;
  done: boolean;
  optional?: boolean;
  waiting?: string | null;
  content: ReactNode;
}

const rectText = (r: IsolateRect) => `${Math.round(r.x0)},${Math.round(r.y0)} – ${Math.round(r.x1)},${Math.round(r.y1)}`;

function PaintTools({ ctl, label }: { ctl: IsolateController; label: string }) {
  const { canChange, tool, setTool, paint, setPaint, target } = ctl;
  const words = TARGET_WORD[target];
  const strokes = ctl.keyFrame?.strokes.length ?? 0;
  const pick = (m: 'include' | 'exclude') => {
    setPaint(m);
    setTool(tool === 'paint' && paint === m ? null : 'paint');
  };
  return (
    <>
      <span className="key-slider-label cp-label">{label}</span>
      <div className="key-row iso-paint">
        <button type="button" className={tool === 'paint' && paint === 'include' ? 'on key-tool' : 'key-tool'} aria-pressed={tool === 'paint' && paint === 'include'} disabled={!canChange} onClick={() => pick('include')} title={`Paint over what belongs in front of the ${words.other}`}>
          <span className="iso-swatch include" aria-hidden="true" /> {words.keep}
        </button>
        <button type="button" className={tool === 'paint' && paint === 'exclude' ? 'on key-tool' : 'key-tool'} aria-pressed={tool === 'paint' && paint === 'exclude'} disabled={!canChange} onClick={() => pick('exclude')} title={`Paint over what is ${words.other}`}>
          <span className="iso-swatch exclude" aria-hidden="true" /> Make {words.other}
        </button>
      </div>
      <Slider label="Brush" value={ctl.brushPx} min={2} max={Math.max(40, Math.round((ctl.plate?.width ?? 1920) * 0.05))} step={1} unit=" px" disabled={!canChange} onCommit={(v) => ctl.setBrush(v)} />
      {strokes ? (
        <div className="key-row">
          <span className="key-note">
            {strokes} stroke{strokes === 1 ? '' : 's'} on frame {ctl.frame}
          </span>
          <button type="button" className="small" disabled={!canChange} onClick={() => ctl.actions.undoStroke()}>
            Undo last
          </button>
        </div>
      ) : null}
    </>
  );
}

export function isolateStepDefs(ctl: IsolateController): IsolateStepDef[] {
  const { doc, canChange, actions, tool, setTool, busy, target, session } = ctl;
  const p = doc?.params ?? DEFAULT_ISOLATE_PARAMS;
  const sky = target === 'sky';
  const seed = doc?.seed ?? { mode: sky ? 'auto' : 'box', frame: null, rect: null, partId: null };
  const sample = session?.sampleSubjects ?? [];
  const sampleUsed = sample.length > 0 && seed.mode === 'roto' && Boolean(seed.partId && ctl.rotoParts.some((x) => x.id === seed.partId && x.name === sample[0]!.name));
  const engines = session?.engines ?? [];
  const painted = (doc?.keyFrames ?? []).filter((k) => k.strokes.length);
  const words = TARGET_WORD[target];
  const toolButton = (t: Exclude<IsolateTool, null>, label: string, title: string) => (
    <button type="button" className={tool === t ? 'on key-tool' : 'key-tool'} aria-pressed={tool === t} disabled={!canChange} title={title} onClick={() => setTool(tool === t ? null : t)}>
      {label}
    </button>
  );
  const taskState = (k: 'sky' | 'background') => {
    const t = ctl.state?.tasks.find((x) => x.kind === ISOLATE_TASK[k]);
    return t ? `${versionTag(t.version)} · ${TASK_STATE_LABELS[t.state]}` : 'not on this shot';
  };
  return [
    {
      id: 'target',
      title: `What to isolate: ${sky ? 'the sky' : 'a subject'}`,
      hint: ctl.has.sky && ctl.has.background ? `This shot also wants ${sky ? 'its subject isolated' : 'its sky'}: open to switch.` : 'The sky against everything in front of it, or a subject against everything behind it.',
      done: ctl.hasTask,
      content: (
        <>
          <Seg
            label="What to isolate"
            value={target}
            options={[
              ['sky', 'Sky', !ctl.has.sky],
              ['background', 'Subject from background', !ctl.has.background],
            ] as const}
            onChange={(t) => actions.target(t)}
          />
          <p className="key-note">
            {PREP_TASKS[ctl.kind].label}: {taskState(target)}
          </p>
          {(['sky', 'background'] as const)
            .filter((k) => !ctl.has[k])
            .map((k) =>
              ctl.props.onAddTask ? (
                <button key={k} type="button" className="small" disabled={!ctl.canEdit} onClick={() => ctl.props.onAddTask!(ISOLATE_TASK[k])}>
                  Add {PREP_TASKS[ISOLATE_TASK[k]].label}
                </button>
              ) : null,
            )}
        </>
      ),
    },
    {
      id: 'seed',
      title: sky ? 'Find the sky' : 'Show the subject',
      hint: sky ? 'Found automatically; paint what it gets wrong.' : 'A box round it, paint, or a roto part — on one frame; the build carries it through the shot.',
      done: ctl.seedProblem === null,
      content: sky ? (
        <>
          <p className="key-note">Automatic: brightness, colour, smoothness and position, made consistent through the shot.</p>
          <Slider label="Less / more sky" value={p.skyBias} min={-1} max={1} step={0.05} disabled={!canChange} hint="Where the cues are unsure, call more (right) or less (left) of the picture sky" onCommit={(v) => actions.settings({ skyBias: v })} />
          <Check label="Keep what moves in front of the sky" checked={p.protectOccluders} disabled={!canChange} hint="Birds, planes, a head rising into the sky stay foreground" onChange={(v) => actions.settings({ protectOccluders: v })} />
          <PaintTools ctl={ctl} label={`Paint on frame ${ctl.frame} (optional)`} />
        </>
      ) : (
        <>
          {sample.length && !sampleUsed ? (
            <div className="action">
              <button type="button" className="primary big key-wrap" disabled={!canChange || busy} onClick={() => actions.useSampleSubject()} title="The sample shot comes with its subject already rotoscoped">
                Use the {sample[0]!.name.toLowerCase()} (sample roto)
              </button>
            </div>
          ) : null}
          <Seg
            label="Seed"
            value={seed.mode === 'auto' ? 'box' : seed.mode}
            options={[
              ['box', 'Box'],
              ['paint', 'Paint'],
              ['roto', 'Roto part'],
            ] as const}
            disabled={!canChange}
            onChange={(m) => actions.seedMode(m)}
          />
          {seed.mode === 'box' || seed.mode === 'auto' ? (
            <>
              <div className="key-row">{toolButton('box', 'Draw a box round the subject', 'Drag a box in the picture round the subject on this frame')}</div>
              <p className="key-note">{seed.rect ? `Box ${rectText(seed.rect)} on frame ${ctl.seedFrame}` : 'No box yet.'}</p>
            </>
          ) : seed.mode === 'paint' ? (
            <PaintTools ctl={ctl} label={`Paint the subject on frame ${ctl.frame}`} />
          ) : (
            <RotoSeed ctl={ctl} />
          )}
          <div className="key-row cp-ref">
            <span className="key-note">
              Seed frame <strong className="mono">{ctl.seedFrame}</strong>
              {seed.frame === null ? ' (the middle)' : ''}
            </span>
            <button type="button" className="small" disabled={!canChange || ctl.seedFrame === ctl.frame} onClick={() => actions.seedHere()}>
              Use frame {ctl.frame}
            </button>
          </div>
          {engines.length > 1 ? (
            <>
              <span className="key-slider-label cp-label">Engine</span>
              <Seg label="Engine" value={doc?.engine ?? 'track'} options={engines.map((e) => [e.id, e.label, !e.available] as const)} disabled={!canChange} onChange={(e) => actions.settings({ engine: e })} />
              {engines.find((e) => !e.available)?.reason ? <p className="muted key-note">{engines.find((e) => !e.available)!.reason}</p> : null}
            </>
          ) : null}
        </>
      ),
    },
    {
      id: 'build',
      title: 'Build',
      hint: 'The matte, the foreground and the plate, through the whole shot.',
      done: ctl.built,
      waiting: ctl.seedProblem,
      content: (
        <>
          <div className="action">
            <button type="button" className="primary big" disabled={!canChange || busy || !ctl.props.api.isolateBuild} onClick={() => void actions.build()}>
              {ctl.built ? 'Build again' : ctl.lastRun ? 'Build again (changed)' : `Build ${sky ? 'sky' : 'subject'} matte`}
            </button>
          </div>
          {ctl.lastRun ? (
            <p className="key-note">
              {ctl.lastRun.frames} frames · confidence {ctl.lastRun.meanConfidence.toFixed(2)} · flicker {(ctl.lastRun.flicker * 100).toFixed(1)} %{ctl.built ? '' : ' · changed since: build again'}
            </p>
          ) : (
            <p className="muted key-note">{ctl.last - ctl.first + 1} frames. Nothing is written until you export.</p>
          )}
        </>
      ),
    },
    {
      id: 'review',
      title: 'Review & fix',
      hint: `Paint what is wrong on any frame; it is carried to the frames around it.`,
      done: Boolean(doc?.frames.length) && ctl.review.problems.length === 0,
      waiting: ctl.lastRun ? null : 'Build first (step 3).',
      content: (
        <>
          <div className="key-row">
            <button type="button" disabled={!ctl.review.problems.length} onClick={() => actions.nextProblem()}>
              Next problem ▸
            </button>
            <button type="button" disabled={!canChange || !ctl.record} onClick={() => actions.markReviewed()}>
              Looks right
            </button>
            <button type="button" disabled={!canChange || !ctl.record} onClick={() => actions.flag(ctl.record?.status === 'flagged' ? '' : 'needs correction')}>
              {ctl.record?.status === 'flagged' ? 'Unflag' : 'Flag'}
            </button>
          </div>
          <PaintTools ctl={ctl} label={`Correct frame ${ctl.frame}`} />
          {painted.length ? (
            <ul className="key-links">
              {painted.map((k) => {
                const r = isolateCorrectionRange(doc!, k.frame, ctl.first, ctl.last);
                return (
                  <li key={k.frame} className="key-link">
                    <span className={`key-link-dot iso-dot${k.correction ? ' correction' : ''}`} aria-hidden="true" />
                    <span className="key-link-name">
                      <strong>Frame {k.frame}</strong> · {k.strokes.length} stroke{k.strokes.length === 1 ? '' : 's'} · reaches {r.first}–{r.last}
                    </span>
                    <button type="button" className="small" onClick={() => ctl.onFrame(k.frame)}>
                      Go
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}
          {painted.length && !ctl.built ? <p className="muted key-note">Paint changes the settings: build again to carry it through the shot.</p> : null}
          <details className="sub">
            <summary>Edge and time</summary>
            <Slider label="Edge softness" value={p.edgeSoftnessPx} min={0} max={8} step={0.5} unit=" px" disabled={!canChange} onCommit={(v) => actions.settings({ edgeSoftnessPx: v })} />
            <Slider label="Edge detail" value={p.edgeDetail} min={0} max={1} step={0.05} disabled={!canChange} hint="How much of the edge is unmixed from the colours (branches, hair, wires) rather than the cut" onCommit={(v) => actions.settings({ edgeDetail: v })} />
            <Slider label="Grow / shrink" value={p.growPx} min={-8} max={8} step={0.5} unit=" px" disabled={!canChange} onCommit={(v) => actions.settings({ growPx: v })} />
            <Slider label="Temporal smoothing" value={p.temporalSmoothing} min={0} max={1} step={0.05} disabled={!canChange} hint="Blend in the neighbouring frames’ matte where the picture did not change (aligned for the camera)" onCommit={(v) => actions.settings({ temporalSmoothing: v })} />
            <span className="key-slider-label cp-label">{sky ? 'Sky spill on the edge' : 'Background spill on the edge'}</span>
            <Seg
              label="Spill"
              value={p.spill.mode === 'colour' ? 'auto' : p.spill.mode}
              options={[
                ['auto', 'Unmix it'],
                ['off', 'Leave it'],
              ] as const}
              disabled={!canChange}
              onChange={(m) => actions.settings({ spill: { mode: m } })}
            />
          </details>
        </>
      ),
    },
    {
      id: 'export',
      title: `Export ${sky ? 'sky' : 'subject'} ${versionTag(ctl.version)}`,
      hint: `Matte, foreground, ${sky ? 'sky' : 'background'} plate, confidence and the sequence manifest, into 02_MATTES_ROTO. Approve it in Details.`,
      done: ctl.exportCurrent,
      waiting: !ctl.built ? 'Build with the current settings first (step 3).' : null,
      content: (
        <>
          <p className="key-note">
            {ctl.last - ctl.first + 1} frames, refined again at plate resolution{ctl.plate ? ` (${ctl.plate.width}×${ctl.plate.height})` : ''} as {ctl.session?.encoding.linear === false ? '16-bit PNG' : 'half-float EXR'} with 16-bit matte PNGs.
          </p>
          <div className="action">
            <button type="button" className="primary big" disabled={!canChange || busy || !ctl.session?.exportable} title={ctl.session && !ctl.session.exportable ? 'Exporting is the desktop app’s' : undefined} onClick={() => void actions.exportIt()}>
              Export {sky ? 'sky' : 'subject'} {versionTag(ctl.version)}
            </button>
          </div>
          {ctl.session && !ctl.session.exportable ? <p className="muted key-note">Exporting writes into the shot package on disk: the desktop app does it.</p> : null}
          {ctl.exported ? (
            <p className="key-note">
              Written {ctl.exported.frames} frames to {ctl.exported.folder}
              {ctl.exportCurrent ? '' : ' — settings changed since; export again'}.
            </p>
          ) : null}
        </>
      ),
    },
  ];
}

function RotoSeed({ ctl }: { ctl: IsolateController }) {
  const current = ctl.doc?.seed.partId ?? '';
  if (!ctl.rotoParts.length)
    return (
      <p className="muted key-note">
        No roto parts with mattes yet.{' '}
        {ctl.props.onOpenRoto ? (
          <button type="button" className="link" onClick={() => ctl.props.onOpenRoto!(ctl.frame)}>
            Paint the subject in Roto
          </button>
        ) : null}
      </p>
    );
  return (
    <div className="key-row">
      <select aria-label="Roto part of the subject" value={current} onChange={(e) => e.target.value && ctl.actions.roto(e.target.value)} disabled={!ctl.canChange}>
        <option value="">Roto part…</option>
        {ctl.rotoParts.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      {current ? <span className="key-note">{rotoPart(ctl.state?.roto, current)?.name ?? current}</span> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The viewer (centre)
// ---------------------------------------------------------------------------

/** The RGBA picture of a view mode, at the view's size; the A/B wipe shows the source on the left. */
export function composeIsolate(view: IsolateFrameView, mode: IsolateViewMode, wipe: { on: boolean; x: number }): Uint8ClampedArray<ArrayBuffer> {
  const { width: w, height: h } = view;
  const n = w * h;
  const out = new Uint8ClampedArray(n * 4);
  const src = view.source;
  const split = wipe.on ? Math.round(wipe.x * w) : -1;
  for (let i = 0; i < n; i += 1) {
    const o = 4 * i;
    out[o + 3] = 255;
    let r = src[3 * i]!;
    let g = src[3 * i + 1]!;
    let b = src[3 * i + 2]!;
    const x = i % w;
    const y = (i - x) / w;
    if (!(split >= 0 && x < split)) {
      const a = view.matte ? view.matte[i]! / 255 : 1;
      switch (mode) {
        case 'source':
          break;
        case 'matte':
          if (view.matte) r = g = b = view.matte[i]!;
          break;
        case 'foreground': {
          if (!view.matte || !view.foreground) break;
          const c = ((x >> 3) + (y >> 3)) & 1 ? 104 : 72;
          r = view.foreground[3 * i]! * a + c * (1 - a);
          g = view.foreground[3 * i + 1]! * a + c * (1 - a);
          b = view.foreground[3 * i + 2]! * a + c * (1 - a);
          break;
        }
        case 'plate':
          if (view.plate) {
            r = view.plate[3 * i]!;
            g = view.plate[3 * i + 1]!;
            b = view.plate[3 * i + 2]!;
          }
          if (view.unresolved?.[i]) {
            r = r * 0.35 + 0.65 * 240;
            g = g * 0.35 + 0.65 * 50;
            b = b * 0.35 + 0.65 * 45;
          }
          break;
        case 'overlay': {
          if (!view.matte) break;
          // The sky / background side tinted magenta; the uncertain edge amber; a doubtful matte red.
          const t = 1 - a;
          r = r * (1 - 0.5 * t) + 225 * t * 0.5;
          g = g * (1 - 0.5 * t) + 40 * t * 0.5;
          b = b * (1 - 0.5 * t) + 200 * t * 0.5;
          if (view.band?.[i] && a > 0.02 && a < 0.98) {
            r = r * 0.4 + 0.6 * 255;
            g = g * 0.4 + 0.6 * 176;
            b = b * 0.4;
          }
          if (view.confidence && view.confidence[i]! < 110) {
            r = r * 0.35 + 0.65 * 240;
            g = g * 0.35 + 0.65 * 50;
            b = b * 0.35 + 0.65 * 45;
          }
          break;
        }
      }
    }
    out[o] = r;
    out[o + 1] = g;
    out[o + 2] = b;
  }
  return out;
}

type Drag = { x0: number; y0: number; x1: number; y1: number } | null;

export function IsolateViewer({ ctl }: { ctl: IsolateController }) {
  const { view, mode, setMode, wipe, setWipe, tool, setTool, plate, first, last, frame, onFrame, doc, review, target } = ctl;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const stageSize = useStageSize(stageRef);
  const aspect = useShotAspect(ctl.props.project, ctl.props.shotId);
  const [drag, setDrag] = useState<Drag>(null);
  const [stroke, setStroke] = useState<[number, number][] | null>(null);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c || !view) return;
    c.width = view.width;
    c.height = view.height;
    const g = c.getContext('2d');
    if (!g) return;
    g.putImageData(new ImageData(composeIsolate(view, mode, wipe), view.width, view.height), 0, 0);
  }, [view, mode, wipe]);

  /** Pointer → view pixels (the frame is shown de-squeezed, "contain", in its stage). */
  const toView = (e: ReactPointerEvent): { x: number; y: number } | null => {
    const el = stageRef.current;
    if (!el || !view) return null;
    return clientToImage(el, view, aspect.display, e.clientX, e.clientY);
  };
  const kPlate = plate && view ? plate.width / view.width : 1;
  const onDown = (e: ReactPointerEvent) => {
    const v = toView(e);
    if (!v) return;
    if (tool) {
      // Drawing, not selecting the page's text.
      e.preventDefault();
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
      if (tool === 'box') setDrag({ x0: v.x, y0: v.y, x1: v.x, y1: v.y });
      else setStroke([[v.x, v.y]]);
      return;
    }
    if (wipe.on && view) setWipe({ on: true, x: Math.max(0, Math.min(1, v.x / view.width)) });
  };
  const onMove = (e: ReactPointerEvent) => {
    const v = toView(e);
    if (drag && v) setDrag({ ...drag, x1: v.x, y1: v.y });
    else if (stroke && v) {
      const lastPt = stroke[stroke.length - 1]!;
      if (Math.hypot(v.x - lastPt[0], v.y - lastPt[1]) >= 1.5 && stroke.length < 3900) setStroke([...stroke, [v.x, v.y]]);
    } else if (wipe.on && view && v && e.buttons === 1 && !tool) setWipe({ on: true, x: Math.max(0, Math.min(1, v.x / view.width)) });
  };
  const onUp = () => {
    if (stroke) {
      const pts = stroke.map(([x, y]) => [Math.round(x * kPlate * 10) / 10, Math.round(y * kPlate * 10) / 10] as [number, number]);
      setStroke(null);
      ctl.actions.stroke(pts);
      return;
    }
    if (!drag) return;
    const rect = { x0: Math.round(Math.min(drag.x0, drag.x1) * kPlate), y0: Math.round(Math.min(drag.y0, drag.y1) * kPlate), x1: Math.round(Math.max(drag.x0, drag.x1) * kPlate), y1: Math.round(Math.max(drag.y0, drag.y1) * kPlate) };
    setDrag(null);
    if (rect.x1 - rect.x0 < 2 || rect.y1 - rect.y0 < 2) return;
    ctl.actions.box(rect);
    setTool(null);
  };

  const k = plate && view ? view.width / plate.width : 1;
  const seedRect = target === 'background' && doc?.seed.mode === 'box' && doc.seed.rect && ctl.seedFrame === frame ? doc.seed.rect : null;
  const strokes = ctl.keyFrame?.strokes ?? [];
  const records = useMemo(() => new Map((doc?.frames ?? []).map((f) => [f.frame, f])), [doc?.frames]);
  const problems = useMemo(() => new Set(review.problems.map((p) => p.frame)), [review.problems]);
  const painted = useMemo(() => new Set((doc?.keyFrames ?? []).filter((x) => x.strokes.length).map((x) => x.frame)), [doc?.keyFrames]);
  const count = Math.max(1, last - first + 1);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const scrub = (e: ReactPointerEvent) => {
    const el = timelineRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const t = Math.max(0, Math.min(1, (e.clientX - r.left) / Math.max(1, r.width)));
    onFrame(Math.round(first + t * (count - 1)));
  };
  const needsBuild = mode !== 'source' && view && !view.matte;
  const message =
    ctl.sessionError ??
    (ctl.session && !ctl.session.available ? ctl.session.reason : null) ??
    (view ? null : ctl.viewError) ??
    (needsBuild ? `Build (step 3) to see the ${isolateViewLabel(mode, target).toLowerCase()} here.` : null);
  const cursorClass = tool ? (tool === 'box' ? 'tool-box' : 'tool-paint') : wipe.on ? 'tool-wipe' : '';
  const radius = (ctl.brushPx / kPlate) as number;

  return (
    <div className="key-viewer cp-viewer iso-viewer" aria-label={`Sky and background viewer — ${ctl.state?.vfxShotId ?? ctl.props.shotId}`} role="region">
      <div className="key-viewer-bar">
        <div className="seg key-modes" role="tablist" aria-label="View">
          {ISOLATE_VIEWS.map((m) => (
            <button key={m} type="button" role="tab" aria-selected={mode === m} className={mode === m ? 'on' : undefined} onClick={() => setMode(m)} disabled={!view && m !== 'source'}>
              {isolateViewLabel(m, target)}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <button type="button" className={wipe.on ? 'on' : undefined} aria-pressed={wipe.on} onClick={() => setWipe({ ...wipe, on: !wipe.on })} title="A/B wipe: the source on the left, this view on the right; drag to move">
          A/B wipe
        </button>
      </div>
      <div ref={stageRef} className={`key-stage ${cursorClass}`} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}>
        <FrameBox stage={stageSize} size={view} pixelAspect={aspect.display}>
        {view ? <canvas ref={canvasRef} className="key-canvas" aria-label={`${isolateViewLabel(mode, target)} of frame ${view.frame}`} /> : null}
        {view ? (
          <svg className="key-overlay" viewBox={`0 0 ${view.width} ${view.height}`} preserveAspectRatio={overlayAspect(stageSize)} aria-hidden="true">
            {seedRect ? <rect className="key-box iso-box" x={seedRect.x0 * k} y={seedRect.y0 * k} width={(seedRect.x1 - seedRect.x0) * k} height={(seedRect.y1 - seedRect.y0) * k} /> : null}
            {strokes.map((s) => (
              <polyline key={s.id} className={`iso-stroke ${s.mode}`} points={s.points.map(([x, y]) => `${x * k},${y * k}`).join(' ')} strokeWidth={Math.max(1, 2 * s.radius * k)} />
            ))}
            {stroke ? <polyline className={`iso-stroke ${ctl.paint} drawing`} points={stroke.map(([x, y]) => `${x},${y}`).join(' ')} strokeWidth={Math.max(1, 2 * radius)} /> : null}
            {drag ? <rect className="key-box drawing" x={Math.min(drag.x0, drag.x1)} y={Math.min(drag.y0, drag.y1)} width={Math.abs(drag.x1 - drag.x0)} height={Math.abs(drag.y1 - drag.y0)} /> : null}
            {wipe.on ? <line className="key-wipe" x1={wipe.x * view.width} x2={wipe.x * view.width} y1={0} y2={view.height} /> : null}
          </svg>
        ) : null}
        </FrameBox>
        {view ? <AspectTag aspect={aspect} /> : null}
        {message ? <div className="key-message">{message}</div> : null}
        {ctl.loading && view ? <div className="key-busy" aria-live="polite">Loading…</div> : null}
        {view?.matte && view.built === 'stale' && mode !== 'source' && !tool ? <div className="key-hint cp-stale">Settings changed since this was built: build again (step 3).</div> : null}
        {tool === 'box' ? <div className="key-hint">Drag a box round the subject.</div> : tool === 'paint' ? <div className="key-hint">Paint on frame {frame}: {ctl.paint === 'include' ? TARGET_WORD[target].keep.toLowerCase() : `make it ${TARGET_WORD[target].other}`}.</div> : null}
      </div>
      <div className="key-timeline-row">
        <button type="button" aria-label="Previous frame" onClick={() => onFrame(Math.max(first, frame - 1))}>
          ◀
        </button>
        <div
          ref={timelineRef}
          className="key-timeline cp-timeline"
          role="slider"
          aria-label="Frame"
          aria-valuemin={first}
          aria-valuemax={last}
          aria-valuenow={frame}
          tabIndex={0}
          title="Each tick is a frame, coloured by its confidence; red underline: a problem frame; green top: painted"
          onPointerDown={(e) => {
            (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
            scrub(e);
          }}
          onPointerMove={(e) => e.buttons === 1 && scrub(e)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') onFrame(Math.max(first, frame - 1));
            if (e.key === 'ArrowRight') onFrame(Math.min(last, frame + 1));
          }}
        >
          {Array.from({ length: Math.min(count, 600) }, (_, i) => {
            const f = first + Math.round((i * (count - 1)) / Math.max(1, Math.min(count, 600) - 1));
            const rec = records.get(f);
            const cls = `key-tick${problems.has(f) ? ' problem' : ''}${painted.has(f) ? ' cp-preferred' : ''}`;
            return <span key={i} className={cls} style={{ background: rec ? confidenceColour(rec.confidence) : undefined }} />;
          })}
          <span className="cp-ref-mark" style={{ left: `${((ctl.seedFrame - first) / Math.max(1, count - 1)) * 100}%` }} title={`Seed frame ${ctl.seedFrame}`} />
          <span className="key-playhead" style={{ left: `${((frame - first) / Math.max(1, count - 1)) * 100}%` }} />
        </div>
        <button type="button" aria-label="Next frame" onClick={() => onFrame(Math.min(last, frame + 1))}>
          ▶
        </button>
        <span className="key-frame mono">{frame}</span>
        <button type="button" disabled={!review.problems.length} onClick={() => ctl.actions.nextProblem()} title="Jump to the next frame that flickers, has a large uncertain edge or low contrast">
          Next problem ▸
        </button>
      </div>
      {view ? (
        <p className="key-view-label muted">
          {view.viewLabel} · {ctl.session?.frames}
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The numbers (right)
// ---------------------------------------------------------------------------

export function IsolateInfo({ ctl }: { ctl: IsolateController }) {
  const { doc, summary, review, task, version, session, record, lastRun, view, target } = ctl;
  const total = ctl.last - ctl.first + 1;
  const m = view?.metrics ?? record?.metrics ?? null;
  const has = summary.frames > 0;
  const other = target === 'sky' ? 'sky' : 'background';
  return (
    <div className="key-info cp-info">
      <div className="stats">
        <Big label="Frames built" value={has ? `${summary.frames}` : '—'} unit={has ? ` / ${total}` : undefined} tone={has ? (ctl.built ? 'ok' : 'warn') : undefined} title={ctl.built ? undefined : has ? 'Settings changed since the build' : undefined} />
        <Big label="Confidence" value={has ? summary.mean.toFixed(2) : '—'} tone={has ? (summary.mean >= 0.8 ? 'ok' : summary.mean >= ISOLATE_LOW_CONFIDENCE ? 'warn' : 'bad') : undefined} title="Mean over the frames: separation, flicker, contrast and the uncertain edge" />
        <Big label="Flicker" value={has ? (summary.flicker * 100).toFixed(1) : '—'} unit={has ? '%' : undefined} tone={has ? (summary.flicker < 0.02 ? 'ok' : summary.flicker < 0.04 ? 'warn' : 'bad') : undefined} title="Mean change of the matte against the previous frame (aligned) on the static edge" />
        <Big label="Uncertain edge" value={has ? (summary.edge * 100).toFixed(1) : '—'} unit={has ? '%' : undefined} tone={has ? (summary.edge < 0.04 ? 'ok' : summary.edge < 0.08 ? 'warn' : 'bad') : undefined} title="Share of the frame with a partial matte" />
        <Big label={`${target === 'sky' ? 'Sky' : 'Background'} unseen`} value={has ? (summary.unresolved * 100).toFixed(1) : '—'} unit={has ? '%' : undefined} tone={has ? (summary.unresolved < (target === 'sky' ? ISOLATE_MAX_UNSEEN_SKY : 0.02) ? 'ok' : 'warn') : undefined} title={`Share of the ${other} plate behind the ${target === 'sky' ? 'edge' : 'subject'} that no frame showed (filled)`} />
        <Big label="Problem frames" value={has ? review.problems.length : '—'} tone={has ? (review.problems.length ? 'warn' : 'ok') : undefined} />
      </div>
      {m ? (
        <section className="info-section">
          <h4>Frame {ctl.frame}</h4>
          <dl className="key-kv">
            <dt>Foreground</dt>
            <dd>{(m.foreground * 100).toFixed(1)} % of the frame</dd>
            <dt>Uncertain edge</dt>
            <dd>{(m.edge * 100).toFixed(1)} %</dd>
            <dt>Contrast</dt>
            <dd>{(m.contrast * 100).toFixed(0)} % across the edge</dd>
            <dt>Flicker</dt>
            <dd>{(m.flicker * 100).toFixed(2)} %</dd>
            <dt>Unseen {other}</dt>
            <dd>{(m.unresolved * 100).toFixed(1)} %</dd>
          </dl>
          {record?.reason ? <p className="warn-text">Problem: {record.reason}</p> : null}
        </section>
      ) : null}
      <section className="info-section">
        <h4>Version</h4>
        <dl className="key-kv">
          <dt>{target === 'sky' ? 'Sky' : 'Background removal'}</dt>
          <dd>
            {versionTag(version)} · {task ? TASK_STATE_LABELS[task.state] : 'no task'}
            {task?.approval ? ` · approved by ${task.approval.by}` : ''}
          </dd>
          <dt>Exported</dt>
          <dd>{ctl.exported ? `${ctl.exported.frames} frames, ${ctl.exported.format.toUpperCase()}` : 'not yet'}</dd>
          <dt>Engine</dt>
          <dd>{lastRun?.engine ?? (target === 'sky' ? 'sky cues' : doc?.engine ?? 'track')}</dd>
          <dt>Settings</dt>
          <dd>
            revision {doc?.revision ?? 0}
            {lastRun && !ctl.built ? ' (changed since the build)' : ''}
          </dd>
          <dt>Frames</dt>
          <dd>{session?.frames || '—'}</dd>
        </dl>
        {session?.encoding.note ? <p className="warn-text">{session.encoding.note}</p> : null}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The steps as a list (for tests and a standalone workspace)
// ---------------------------------------------------------------------------

export function IsolateWorkspace(props: IsolateWorkspaceProps) {
  const ctl = useIsolateController(props);
  const steps = isolateStepDefs(ctl);
  const current = steps.find((s) => !s.done && !s.optional)?.id ?? null;
  const [open, setOpen] = useState<Set<string>>(() => new Set(steps.map((s) => s.id)));
  if (!ctl.supported) return <div className="key-missing">Sky and background isolation are not available in this build.</div>;
  return (
    <div className="key-workspace">
      <aside className="key-zone key-zone-steps" aria-label="Steps">
        <ol className="steps key-steps" aria-label="Isolation steps">
          {steps.map((s, i) => (
            <li key={s.id} className={`step step-${s.done ? 'done' : s.id === current ? 'current' : 'todo'}${open.has(s.id) ? ' open' : ''}`} data-step={s.id}>
              <button type="button" className="step-head" aria-expanded={open.has(s.id)} onClick={() => setOpen((o) => (o.has(s.id) ? new Set([...o].filter((x) => x !== s.id)) : new Set([...o, s.id])))}>
                <span className="step-num" aria-hidden="true">
                  {s.done ? '✓' : i + 1}
                </span>
                <span className="step-title">
                  <span>{s.title}</span>
                  {s.hint ? <span className="step-hint">{s.hint}</span> : null}
                </span>
              </button>
              {open.has(s.id) ? <div className="step-body">{s.waiting ? <p className="step-waiting">{s.waiting}</p> : s.content}</div> : null}
            </li>
          ))}
        </ol>
      </aside>
      <section className="key-zone key-zone-centre" aria-label="Viewer">
        <IsolateViewer ctl={ctl} />
      </section>
      <aside className="key-zone key-zone-info" aria-label="Details">
        <IsolateInfo ctl={ctl} />
      </aside>
    </div>
  );
}
