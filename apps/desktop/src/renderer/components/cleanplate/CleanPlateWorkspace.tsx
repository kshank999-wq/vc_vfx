import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { AspectTag, FrameBox, overlayAspect, useShotAspect, useStageSize } from '../FrameBox';
import { clientToImage } from '../../frame-fit';
import {
  CLEANPLATE_LOW_CONFIDENCE,
  DEFAULT_CLEANPLATE_PARAMS,
  TASK_STATE_LABELS,
  addCleanPlatePatch,
  addCleanPlateRemove,
  addPart,
  addTask,
  cleanPlateConfidenceSummary,
  cleanPlateLocked,
  cleanPlateModeFor,
  cleanPlateReference,
  cleanPlateReview,
  cleanPlateTaskVersion,
  flagCleanPlateFrame,
  markCleanPlateFrameReviewed,
  nextCleanPlateProblem,
  recordCleanPlateExport,
  recordCleanPlateRun,
  recordPropagation,
  removeCleanPlatePatch,
  removeCleanPlateRemove,
  rotoPart,
  serializeProject,
  setCleanPlateFrameGuidance,
  setCleanPlateSettings,
  shotState,
  updateCleanPlateRemove,
  versionTag,
  type CleanPlateDocument,
  type CleanPlateRect,
  type CleanPlateSettingsChange,
  type Project,
  type Result,
} from '@vcvfx/domain';
import type { VcvfxApi } from '../../../shared/bridge';
import type { CleanPlateFrameView, CleanPlateSessionInfo } from '../../../shared/cleanplate/bridge-types';
import '../key/key.css';
import './cleanplate.css';

/**
 * The Clean Plate workspace (master spec §8; addendum 10): choose what to
 * remove (roto parts or boxes), pick still or sequence and how frames are
 * aligned, build, review the plate against the source with what could not be
 * resolved in red, guide it (frames to prefer or leave out, patches "take this
 * region from that frame"), and export a versioned clean plate.
 *
 * Built for the three-zone module screen (addendum 08), as the Key is:
 * `useCleanPlateController` holds the state and actions; `cleanPlateStepDefs`
 * (left), `CleanPlateViewer` (centre) and `CleanPlateInfo` (right) draw from
 * it. Every change is a logged domain mutation applied through
 * `onCleanPlate`. A build puts the task up for review; nothing here approves.
 */

export type CleanPlateMutation = (p: Project, actor: string, now: Date) => Result;

export interface CleanPlateWorkspaceProps {
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
  onCleanPlate(fn: CleanPlateMutation): boolean;
  runJob<T>(label: string, fn: (jobId: string) => Promise<T>): Promise<T>;
  notify(kind: 'ok' | 'error' | 'info', text: string): void;
  /** Open the Roto tab (to paint the subject). */
  onOpenRoto?(frame: number): void;
}

export const CLEANPLATE_VIEWS = ['source', 'plate', 'unresolved', 'confidence', 'removed'] as const;
export type CleanPlateViewMode = (typeof CLEANPLATE_VIEWS)[number];
export const CLEANPLATE_VIEW_LABELS: Record<CleanPlateViewMode, string> = {
  source: 'Source',
  plate: 'Clean plate',
  unresolved: 'Unresolved (red)',
  confidence: 'Confidence',
  removed: 'What is removed',
};
export type CleanPlateTool = 'remove-box' | 'patch' | null;

const unwrap = <T,>(r: { ok: true; data: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(r.error);
  return r.data;
};

/** Confidence as a colour (the timeline strip), as the key shows it. */
export function confidenceColour(c: number): string {
  const t = Math.max(0, Math.min(1, c));
  const hue = t < CLEANPLATE_LOW_CONFIDENCE ? (t / CLEANPLATE_LOW_CONFIDENCE) * 38 : 38 + ((t - CLEANPLATE_LOW_CONFIDENCE) / (1 - CLEANPLATE_LOW_CONFIDENCE)) * 92;
  return `hsl(${hue.toFixed(0)} 70% ${t < CLEANPLATE_LOW_CONFIDENCE ? 52 : 46}%)`;
}

/**
 * The sample's subjects as roto parts (browser preview only): the parts, their
 * mattes over the shot, and their removal — one logged mutation chain.
 */
function adoptSampleSubjects(p: Project, shotId: string, names: readonly string[], range: { first: number; last: number }, actor: string, now: Date): Result {
  let project = p;
  const step = (r: Result) => {
    if (r.ok) project = r.project;
    return r;
  };
  if (!shotState(project, shotId)?.tasks.some((t) => t.kind === 'roto')) {
    const r = step(addTask(project, shotId, 'roto', actor, now));
    if (!r.ok) return r;
  }
  for (const name of names) {
    const existing = shotState(project, shotId)?.roto?.parts.find((x) => x.name === name);
    let partId = existing?.id ?? '';
    if (!existing) {
      const r = step(addPart(project, shotId, { name }, actor, now));
      if (!r.ok) return r;
      partId = shotState(project, shotId)!.roto!.parts.find((x) => x.name === name)!.id;
      const frames = Array.from({ length: range.last - range.first + 1 }, (_, i) => ({ frame: range.first + i, confidence: 0.95 }));
      const r2 = step(recordPropagation(project, shotId, { partId, engine: { id: 'track', version: 'sample roto' }, direction: 'forward', from: range.first, frames }, actor, now));
      if (!r2.ok) return r2;
    }
    if (!shotState(project, shotId)?.cleanPlate?.remove.some((x) => x.source.type === 'roto' && x.source.partId === partId)) {
      const r3 = step(addCleanPlateRemove(project, shotId, { source: { type: 'roto', partId }, label: name }, actor, now));
      if (!r3.ok) return r3;
    }
  }
  return { ok: true, project };
}

// ---------------------------------------------------------------------------
// The controller
// ---------------------------------------------------------------------------

export function useCleanPlateController(props: CleanPlateWorkspaceProps) {
  const { api, project, shotId, projectKey, canEdit, actor, frame, onFrame, onCleanPlate, runJob, notify } = props;
  const state = shotState(project, shotId);
  const doc: CleanPlateDocument | null = state?.cleanPlate ?? null;
  const hasTask = Boolean(state?.tasks.some((t) => t.kind === 'clean_plate'));
  const task = state?.tasks.find((t) => t.kind === 'clean_plate') ?? null;
  const locked = state ? cleanPlateLocked(state) : 'No shot';
  const version = state ? cleanPlateTaskVersion(state) : 1;
  const text = useMemo(() => serializeProject(project), [project]);
  const textRef = useRef(text);
  textRef.current = text;
  const supported = Boolean(api.cleanPlateSession && api.cleanPlateFrame);

  const [session, setSession] = useState<CleanPlateSessionInfo | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [view, setView] = useState<CleanPlateFrameView | null>(null);
  const [viewError, setViewError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<CleanPlateViewMode>('source');
  const [wipe, setWipe] = useState<{ on: boolean; x: number }>({ on: false, x: 0.5 });
  const [tool, setTool] = useState<CleanPlateTool>(null);
  const [patchFrom, setPatchFrom] = useState<number | null>(null);
  const [working, setWorking] = useState<string | null>(null);

  const first = session?.first ?? frame;
  const last = session?.last ?? frame;
  const plate = session?.plate ?? null;
  const canChange = canEdit && !locked && Boolean(session?.available);

  const sessionKey = JSON.stringify([shotId, projectKey, hasTask, doc?.workingWidth ?? null, state?.plates.length ?? 0]);
  useEffect(() => {
    if (!api.cleanPlateSession) return;
    let live = true;
    setSessionError(null);
    void api.cleanPlateSession({ text: textRef.current, shotId, projectKey }).then((r) => {
      if (!live) return;
      if (r.ok) setSession(r.data);
      else setSessionError(r.error);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, sessionKey]);

  // The frame view: whenever the frame, what is removed, or the built plate changes.
  const viewDeps = JSON.stringify([doc ? { r: doc.remove, d: doc.params.dilatePx, rev: doc.revision, runs: doc.runs.length } : null, state?.roto?.parts.map((p) => [p.id, p.frames.length]) ?? null]);
  const request = useRef(0);
  useEffect(() => {
    if (!api.cleanPlateFrame || !session?.available) {
      setView(null);
      return;
    }
    const id = ++request.current;
    setLoading(true);
    const timer = setTimeout(() => {
      void api.cleanPlateFrame!({ text: textRef.current, shotId, projectKey, frame, maxWidth: 960 }).then((r) => {
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

  const apply = useCallback((fn: CleanPlateMutation) => onCleanPlate(fn), [onCleanPlate]);
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

  const review = useMemo(() => cleanPlateReview(doc, first, last), [doc, first, last]);
  const summary = useMemo(() => cleanPlateConfidenceSummary(doc), [doc]);
  const record = doc?.frames.find((f) => f.frame === frame) ?? (doc?.frames.length === 1 ? doc.frames[0]! : null);
  const lastRun = doc?.runs.filter((r) => r.taskVersion === version).at(-1) ?? null;
  const built = Boolean(lastRun && lastRun.revision === doc?.revision);
  const exported = doc?.exports.find((e) => e.version === version) ?? null;
  const exportCurrent = Boolean(exported && exported.revision === doc?.revision);
  const reference = cleanPlateReference(doc, first, last);
  const outputMode = cleanPlateModeFor(doc);
  const rotoParts = state?.roto?.parts.filter((p) => p.frames.length > 0) ?? [];

  const actions = {
    addRoto: (partId: string) => apply((p, a, t) => addCleanPlateRemove(p, shotId, { source: { type: 'roto', partId }, label: rotoPart(state?.roto, partId)?.name ?? '' }, a, t)),
    addBox: (rect: CleanPlateRect) => apply((p, a, t) => addCleanPlateRemove(p, shotId, { source: { type: 'rect', rect } }, a, t)),
    toggleRemove: (id: string, enabled: boolean) => apply((p, a, t) => updateCleanPlateRemove(p, shotId, id, { enabled }, a, t)),
    dropRemove: (id: string) => apply((p, a, t) => removeCleanPlateRemove(p, shotId, id, a, t)),
    useSampleSubjects: () => {
      const names = session?.sampleSubjects?.map((s) => s.name) ?? [];
      if (apply((p, a, t) => adoptSampleSubjects(p, shotId, names, { first, last }, a, t))) notify('ok', `The ${names.map((n) => n.toLowerCase()).join(' and the ')} will be removed (the sample’s roto). Build the clean plate next (step 3).`);
    },
    settings: (change: CleanPlateSettingsChange) => apply((p, a, t) => setCleanPlateSettings(p, shotId, change, a, t)),
    useThisFrameAsReference: () => apply((p, a, t) => setCleanPlateSettings(p, shotId, { referenceFrame: frame }, a, t)),
    build: () =>
      guard('Building…', async () => {
        if (!api.cleanPlateBuild) throw new Error('Building is not available here.');
        const { result } = await runJob(`Building the clean plate of ${state?.vfxShotId ?? shotId}`, async (jobId) => unwrap(await api.cleanPlateBuild!({ jobId, text: textRef.current, shotId, projectKey })));
        if (apply((p, a, t) => recordCleanPlateRun(p, shotId, result, a, t))) {
          const lows = result.frames.filter((f) => f.metrics.low > 0.02).length;
          notify('ok', `${result.mode === 'still' ? `Still built in frame ${result.reference}` : `${result.frames.length} frames built`}. ${lows ? `${lows} frame${lows === 1 ? ' has' : 's have'} areas no frame sees: shown in red.` : 'Every removed pixel was seen in other frames.'}`);
          setMode(result.frames.some((f) => f.metrics.low > 0) ? 'unresolved' : 'plate');
        }
      }),
    nextProblem: () => {
      const next = nextCleanPlateProblem(review, frame);
      if (next !== null) onFrame(next);
    },
    flag: (note: string) => apply((p, a, t) => flagCleanPlateFrame(p, shotId, record?.frame ?? frame, note, a, t)),
    markReviewed: () => apply((p, a, t) => markCleanPlateFrameReviewed(p, shotId, record?.frame ?? frame, a, t)),
    guidance: (use: 'prefer' | 'exclude' | 'none') => apply((p, a, t) => setCleanPlateFrameGuidance(p, shotId, frame, use, a, t)),
    addPatch: (rect: CleanPlateRect, sourceFrame: number) =>
      apply((p, a, t) => addCleanPlatePatch(p, shotId, { rect, sourceFrame, ...(outputMode === 'sequence' ? { frames: { first: frame, last: frame } } : {}) }, a, t)),
    dropPatch: (id: string) => apply((p, a, t) => removeCleanPlatePatch(p, shotId, id, a, t)),
    exportPlate: () =>
      guard('Exporting…', async () => {
        if (!api.cleanPlateExport) throw new Error('Exporting is not available here.');
        const out = await runJob(`Exporting the clean plate of ${state?.vfxShotId ?? shotId}`, async (jobId) => unwrap(await api.cleanPlateExport!({ jobId, text: textRef.current, shotId, projectKey, operator: actor })));
        if (apply((p, a, t) => recordCleanPlateExport(p, shotId, out.record, a, t))) notify('ok', `Clean plate ${versionTag(out.record.version)} written: ${out.files} files in ${out.folder}`);
      }),
  };

  return {
    props,
    state,
    doc,
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
    patchFrom,
    setPatchFrom,
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
    reference,
    outputMode,
    rotoParts,
    frame,
    onFrame,
    actions,
  };
}
export type CleanPlateController = ReturnType<typeof useCleanPlateController>;

// ---------------------------------------------------------------------------
// Small controls (as the Key's)
// ---------------------------------------------------------------------------

export function Slider({ label, value, min, max, step, unit, disabled, hint, onCommit }: { label: string; value: number; min: number; max: number; step: number; unit?: string; disabled: boolean; hint?: string; onCommit(v: number): void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => draft !== value && onCommit(draft);
  return (
    <label className="key-slider" title={hint}>
      <span className="key-slider-label">{label}</span>
      <input type="range" aria-label={label} min={min} max={max} step={step} value={draft} disabled={disabled} onChange={(e) => setDraft(Number(e.target.value))} onPointerUp={commit} onKeyUp={commit} onBlur={commit} />
      <span className="key-slider-value mono">
        {Number.isInteger(step) ? draft : draft.toFixed(2)}
        {unit ?? ''}
      </span>
    </label>
  );
}

/** A segmented choice; an option's third element turns that option off. */
export function Seg<T extends string>({ value, options, onChange, disabled, label }: { value: T; options: readonly (readonly [T, string] | readonly [T, string, boolean])[]; onChange(v: T): void; disabled?: boolean; label: string }) {
  return (
    <div className="seg cp-seg" role="group" aria-label={label}>
      {options.map(([v, l, off]) => (
        <button key={v} type="button" className={v === value ? 'on' : undefined} aria-pressed={v === value} disabled={disabled || Boolean(off)} onClick={() => onChange(v)}>
          {l}
        </button>
      ))}
    </div>
  );
}

export function Check({ label, checked, disabled, onChange, hint }: { label: string; checked: boolean; disabled?: boolean; onChange(v: boolean): void; hint?: string }) {
  return (
    <label className="key-check" title={hint}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

// ---------------------------------------------------------------------------
// Steps (left)
// ---------------------------------------------------------------------------

export interface CleanPlateStepDef {
  id: string;
  title: string;
  hint?: string;
  done: boolean;
  optional?: boolean;
  waiting?: string | null;
  content: ReactNode;
}

const rectText = (r: CleanPlateRect) => `${Math.round(r.x0)},${Math.round(r.y0)} – ${Math.round(r.x1)},${Math.round(r.y1)}`;

function RemoveList({ ctl }: { ctl: CleanPlateController }) {
  const items = ctl.doc?.remove ?? [];
  if (!items.length) return <p className="muted key-note">Nothing chosen yet.</p>;
  return (
    <ul className="key-links">
      {items.map((r) => (
        <li key={r.id} className={`key-link${r.enabled ? '' : ' off'}`}>
          <span className="key-link-dot cp-remove" aria-hidden="true" />
          <span className="key-link-name" title={r.id}>
            {r.source.type === 'roto' ? <strong>Roto: {r.label || rotoPart(ctl.state?.roto, r.source.partId)?.name || r.source.partId}</strong> : <strong>Box {rectText(r.source.rect)}</strong>}
            {r.frames ? ` · frames ${r.frames.first}–${r.frames.last}` : ''}
          </span>
          <Check label="On" checked={r.enabled} disabled={!ctl.canChange} onChange={(v) => ctl.actions.toggleRemove(r.id, v)} />
          <button type="button" className="small danger" aria-label={`Stop removing ${r.label || r.id}`} disabled={!ctl.canChange} onClick={() => ctl.actions.dropRemove(r.id)}>
            ✕
          </button>
        </li>
      ))}
    </ul>
  );
}

function RotoAdd({ ctl }: { ctl: CleanPlateController }) {
  const used = new Set((ctl.doc?.remove ?? []).flatMap((r) => (r.source.type === 'roto' ? [r.source.partId] : [])));
  const parts = ctl.rotoParts.filter((p) => !used.has(p.id));
  const [partId, setPartId] = useState('');
  if (!parts.length)
    return (
      <p className="muted key-note">
        {ctl.rotoParts.length ? 'Every roto part with a matte is already being removed.' : 'No roto parts with mattes yet.'}{' '}
        {ctl.props.onOpenRoto ? (
          <button type="button" className="link" onClick={() => ctl.props.onOpenRoto!(ctl.frame)}>
            Paint the subject in Roto
          </button>
        ) : null}
      </p>
    );
  return (
    <div className="key-row">
      <select aria-label="Roto part to remove" value={partId} onChange={(e) => setPartId(e.target.value)} disabled={!ctl.canChange}>
        <option value="">Roto part…</option>
        {parts.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <button type="button" disabled={!ctl.canChange || !partId} onClick={() => (ctl.actions.addRoto(partId), setPartId(''))}>
        Remove it
      </button>
    </div>
  );
}

export function cleanPlateStepDefs(ctl: CleanPlateController): CleanPlateStepDef[] {
  const { doc, canChange, actions, tool, setTool, busy } = ctl;
  const p = doc?.params ?? DEFAULT_CLEANPLATE_PARAMS;
  const hasRemove = Boolean(doc?.remove.some((r) => r.enabled));
  const noRemove = hasRemove ? null : 'Choose what to remove first (step 1).';
  const g = doc?.guidance ?? { prefer: [], exclude: [], patches: [] };
  const sample = ctl.session?.sampleSubjects ?? [];
  const sampleUsed = sample.length > 0 && sample.every((s) => (doc?.remove ?? []).some((r) => r.label === s.name));
  const toolButton = (t: Exclude<CleanPlateTool, null>, label: string, title: string, disabled = false) => (
    <button type="button" className={tool === t ? 'on key-tool' : 'key-tool'} aria-pressed={tool === t} disabled={!canChange || disabled} title={title} onClick={() => setTool(tool === t ? null : t)}>
      {label}
    </button>
  );
  const frameUse = g.prefer.includes(ctl.frame) ? 'prefer' : g.exclude.includes(ctl.frame) ? 'exclude' : 'none';
  const suggestion = doc?.suggestion ?? null;
  const patchSource = ctl.patchFrom ?? defaultPatchSource(ctl);
  return [
    {
      id: 'remove',
      title: 'Choose what to remove',
      hint: 'A roto part (a person crossing, a boom), or a box round something that never moves.',
      done: hasRemove,
      content: (
        <>
          {sample.length && !sampleUsed ? (
            <div className="action">
              <button type="button" className="primary big key-wrap" disabled={!canChange || busy} onClick={() => actions.useSampleSubjects()} title="The sample shot comes with its subjects already rotoscoped">
                Remove the {sample.map((s) => s.name.toLowerCase()).join(' and the ')} (sample roto)
              </button>
            </div>
          ) : null}
          <RotoAdd ctl={ctl} />
          <div className="key-row">{toolButton('remove-box', 'Draw a box to remove', 'Drag a box in the picture round something that stays put (a stand, a mark)')}</div>
          <RemoveList ctl={ctl} />
          <Slider label="Grow the matte by" value={p.dilatePx} min={0} max={48} step={1} unit=" px" disabled={!canChange} hint="So the subject’s soft edge, motion blur and contact shadow go too (plate pixels)" onCommit={(v) => actions.settings({ dilatePx: v })} />
        </>
      ),
    },
    {
      id: 'mode',
      title: 'Still or sequence, and alignment',
      hint: 'Auto picks a still for a locked-off camera, a plate per frame when it moves.',
      // The defaults (auto, detect, the middle frame) are a good start: nothing to do here unless the artist wants to.
      done: hasRemove,
      waiting: noRemove,
      content: (
        <>
          <Seg label="Clean plate" value={doc?.mode ?? 'auto'} options={[['auto', 'Auto'], ['still', 'Still'], ['sequence', 'Per frame']] as const} disabled={!canChange} onChange={(m) => actions.settings({ mode: m })} />
          {suggestion ? <p className="key-note">{suggestion.reason}</p> : <p className="muted key-note">The build looks at the camera’s motion and says which it needs.</p>}
          <Seg label="Camera" value={doc?.alignment ?? 'auto'} options={[['auto', 'Detect'], ['static', 'Locked off'], ['homography', 'Moving']] as const} disabled={!canChange} onChange={(a) => actions.settings({ alignment: a })} />
          <div className="key-row cp-ref">
            <span className="key-note">
              Reference frame <strong className="mono">{ctl.reference}</strong>
              {doc?.referenceFrame === null || doc?.referenceFrame === undefined ? ' (the middle)' : ''}
            </span>
            <button type="button" className="small" disabled={!canChange || ctl.reference === ctl.frame} onClick={() => actions.useThisFrameAsReference()}>
              Use frame {ctl.frame}
            </button>
          </div>
          <details className="sub">
            <summary>More</summary>
            <Slider label="Frames either side to borrow from" value={p.window} min={1} max={48} step={1} disabled={!canChange} onCommit={(v) => actions.settings({ window: v })} />
            <Slider label="Anchor frames across the shot" value={p.anchors} min={2} max={48} step={1} disabled={!canChange} onCommit={(v) => actions.settings({ anchors: v })} />
            <Slider label="Agreement tolerance" value={p.tolerance} min={0.01} max={0.3} step={0.01} disabled={!canChange} hint="How close borrowed pixels must be to count as agreeing (relative brightness)" onCommit={(v) => actions.settings({ tolerance: v })} />
          </details>
        </>
      ),
    },
    {
      id: 'build',
      title: 'Build',
      hint: 'Aligns every frame and rebuilds the background from the frames that see it.',
      done: ctl.built,
      waiting: noRemove,
      content: (
        <>
          <div className="action">
            <button type="button" className="primary big" disabled={!canChange || busy || !ctl.props.api.cleanPlateBuild} onClick={() => void actions.build()}>
              {ctl.built ? 'Build again' : ctl.lastRun ? 'Build again (settings changed)' : 'Build clean plate'}
            </button>
          </div>
          {ctl.lastRun ? (
            <p className="key-note">
              {ctl.lastRun.mode === 'still' ? `Still in frame ${ctl.lastRun.reference}` : `${ctl.lastRun.frames} frames`} · {ctl.lastRun.alignment === 'static' ? 'locked-off camera' : 'aligned by homography'} · from other frames {Math.round(ctl.lastRun.coverage * 100)} % · unresolved{' '}
              {(ctl.lastRun.low * 100).toFixed(1)} %{ctl.built ? '' : ' · settings changed since: build again'}
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
      hint: 'Red is what no frame sees. Prefer or leave out frames, or patch a region from a frame you choose.',
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
            <button type="button" disabled={!canChange || !ctl.record} onClick={() => actions.flag(ctl.record?.status === 'flagged' ? '' : 'needs paint')}>
              {ctl.record?.status === 'flagged' ? 'Unflag' : 'Flag'}
            </button>
          </div>
          <span className="key-slider-label cp-label">Frame {ctl.frame} as a source</span>
          <Seg
            label={`Frame ${ctl.frame} as a source`}
            value={frameUse}
            options={[['none', 'Normal'], ['prefer', 'Prefer it'], ['exclude', 'Leave it out']] as const}
            disabled={!canChange}
            onChange={(v) => actions.guidance(v)}
          />
          {g.prefer.length || g.exclude.length ? (
            <p className="mono small key-note">
              {g.prefer.length ? `preferred ${g.prefer.join(', ')}` : ''}
              {g.prefer.length && g.exclude.length ? ' · ' : ''}
              {g.exclude.length ? `left out ${g.exclude.slice(0, 12).join(', ')}${g.exclude.length > 12 ? '…' : ''}` : ''}
            </p>
          ) : null}
          <div className="key-row cp-patch">
            <label className="key-field cp-patch-from">
              <span>Patch from frame</span>
              <input type="number" aria-label="Patch from frame" min={ctl.first} max={ctl.last} value={patchSource} disabled={!canChange} onChange={(e) => ctl.setPatchFrom(Math.max(ctl.first, Math.min(ctl.last, Math.round(Number(e.target.value) || ctl.first))))} />
            </label>
            {toolButton('patch', 'Draw the region', `Drag a box in the picture: that region is taken from frame ${patchSource}`)}
          </div>
          {g.patches.length ? (
            <ul className="key-links">
              {g.patches.map((x) => (
                <li key={x.id} className="key-link">
                  <span className="key-link-dot cp-patch-dot" aria-hidden="true" />
                  <span className="key-link-name">
                    <strong>Patch</strong> {rectText(x.rect)} from {x.sourceFrame}
                    {x.frames ? ` on ${x.frames.first === x.frames.last ? x.frames.first : `${x.frames.first}–${x.frames.last}`}` : ''}
                  </span>
                  <button type="button" className="small" onClick={() => ctl.onFrame(x.sourceFrame)}>
                    Go to {x.sourceFrame}
                  </button>
                  <button type="button" className="small danger" aria-label={`Remove patch ${x.id}`} disabled={!canChange} onClick={() => actions.dropPatch(x.id)}>
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {g.patches.length || g.prefer.length || g.exclude.length ? <p className="muted key-note">Guidance changes the settings: build again to see it.</p> : null}
        </>
      ),
    },
    {
      id: 'export',
      title: `Export clean plate ${versionTag(ctl.version)}`,
      hint: 'The plate, its confidence and unresolved masks and the metadata, into 04_CLEAN_PLATES. Approve it in Details.',
      done: ctl.exportCurrent,
      waiting: !ctl.built ? 'Build with the current settings first (step 3).' : null,
      content: (
        <>
          <p className="key-note">
            {ctl.outputMode === 'still' ? `One still (frame ${ctl.reference})` : `${ctl.last - ctl.first + 1} frames`}, made again at plate resolution{ctl.plate ? ` (${ctl.plate.width}×${ctl.plate.height})` : ''} as {ctl.session?.encoding.linear === false ? '16-bit PNG' : 'half-float EXR'}.
          </p>
          <div className="action">
            <button type="button" className="primary big" disabled={!canChange || busy || !ctl.session?.exportable} title={ctl.session && !ctl.session.exportable ? 'Exporting is the desktop app’s' : undefined} onClick={() => void actions.exportPlate()}>
              Export clean plate {versionTag(ctl.version)}
            </button>
          </div>
          {ctl.session && !ctl.session.exportable ? <p className="muted key-note">Exporting writes into the shot package on disk: the desktop app does it.</p> : null}
          {ctl.exported ? (
            <p className="key-note">
              Written {ctl.exported.mode === 'still' ? 'a still' : `${ctl.exported.frames} frames`} to {ctl.exported.folder}
              {ctl.exportCurrent ? '' : ' — settings changed since; export again'}.
            </p>
          ) : null}
        </>
      ),
    },
  ];
}

/** A sensible frame to patch from: a preferred one, else one half a window away. */
function defaultPatchSource(ctl: CleanPlateController): number {
  const prefer = ctl.doc?.guidance.prefer.find((f) => f !== ctl.frame);
  if (prefer !== undefined) return prefer;
  const d = Math.max(4, Math.round((ctl.doc?.params.window ?? 12) / 2));
  return ctl.frame + d <= ctl.last ? ctl.frame + d : Math.max(ctl.first, ctl.frame - d);
}

// ---------------------------------------------------------------------------
// The viewer (centre)
// ---------------------------------------------------------------------------

/** The RGBA picture of a view mode, at the view's size; the A/B wipe shows the source on the left. */
export function composeCleanPlate(view: CleanPlateFrameView, mode: CleanPlateViewMode, wipe: { on: boolean; x: number }): Uint8ClampedArray<ArrayBuffer> {
  const { width: w, height: h } = view;
  const n = w * h;
  const out = new Uint8ClampedArray(n * 4);
  const src = view.source;
  const plate = view.plate;
  const split = wipe.on ? Math.round(wipe.x * w) : -1;
  for (let i = 0; i < n; i += 1) {
    const o = 4 * i;
    out[o + 3] = 255;
    let r = src[3 * i]!;
    let g = src[3 * i + 1]!;
    let b = src[3 * i + 2]!;
    const x = i % w;
    if (!(split >= 0 && x < split)) {
      switch (mode) {
        case 'source':
          break;
        case 'removed':
          if (view.hole && view.hole[i]) {
            r = r * 0.45 + 120;
            g = g * 0.45 + 40;
            b = b * 0.45 + 160;
          }
          break;
        case 'plate':
        case 'unresolved':
          if (plate) {
            r = plate[3 * i]!;
            g = plate[3 * i + 1]!;
            b = plate[3 * i + 2]!;
          }
          if (mode === 'unresolved' && view.unresolved?.[i]) {
            r = r * 0.35 + 0.65 * 240;
            g = g * 0.35 + 0.65 * 50;
            b = b * 0.35 + 0.65 * 45;
          }
          break;
        case 'confidence': {
          const c = view.confidence ? view.confidence[i]! : 255;
          const base = plate ? (0.3 * plate[3 * i]! + 0.59 * plate[3 * i + 1]! + 0.11 * plate[3 * i + 2]!) * 0.35 : 0;
          // Confident: the picture dimmed; less so: amber; unseen: red.
          const t = c / 255;
          r = base + (1 - t) * (230 - base) * (t < 0.5 ? 1 : 0.8);
          g = base + (1 - t) * ((t < 0.5 ? 60 : 170) - base);
          b = base * t;
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

export function CleanPlateViewer({ ctl }: { ctl: CleanPlateController }) {
  const { view, mode, setMode, wipe, setWipe, tool, setTool, plate, first, last, frame, onFrame, doc, review } = ctl;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const stageSize = useStageSize(stageRef);
  const aspect = useShotAspect(ctl.props.project, ctl.props.shotId);
  const [drag, setDrag] = useState<Drag>(null);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c || !view) return;
    c.width = view.width;
    c.height = view.height;
    const g = c.getContext('2d');
    if (!g) return;
    g.putImageData(new ImageData(composeCleanPlate(view, mode, wipe), view.width, view.height), 0, 0);
  }, [view, mode, wipe]);

  /** Pointer → view pixels (the frame is shown de-squeezed, "contain", in its stage). */
  const toView = (e: ReactPointerEvent): { x: number; y: number } | null => {
    const el = stageRef.current;
    if (!el || !view) return null;
    return clientToImage(el, view, aspect.display, e.clientX, e.clientY);
  };
  const toPlate = (v: { x: number; y: number }) => {
    const k = plate && view ? plate.width / view.width : 1;
    return { x: v.x * k, y: v.y * k };
  };
  const onDown = (e: ReactPointerEvent) => {
    const v = toView(e);
    if (!v) return;
    if (tool) {
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
      setDrag({ x0: v.x, y0: v.y, x1: v.x, y1: v.y });
      return;
    }
    if (wipe.on && view) setWipe({ on: true, x: Math.max(0, Math.min(1, v.x / view.width)) });
  };
  const onMove = (e: ReactPointerEvent) => {
    const v = toView(e);
    if (drag && v) setDrag({ ...drag, x1: v.x, y1: v.y });
    else if (wipe.on && view && v && e.buttons === 1 && !tool) setWipe({ on: true, x: Math.max(0, Math.min(1, v.x / view.width)) });
  };
  const onUp = () => {
    if (!drag) return;
    const a = toPlate({ x: Math.min(drag.x0, drag.x1), y: Math.min(drag.y0, drag.y1) });
    const b = toPlate({ x: Math.max(drag.x0, drag.x1), y: Math.max(drag.y0, drag.y1) });
    setDrag(null);
    if (b.x - a.x < 2 || b.y - a.y < 2) return;
    const rect = { x0: Math.round(a.x), y0: Math.round(a.y), x1: Math.round(b.x), y1: Math.round(b.y) };
    if (tool === 'remove-box') ctl.actions.addBox(rect);
    else if (tool === 'patch') ctl.actions.addPatch(rect, ctl.patchFrom ?? defaultPatchSource(ctl));
    setTool(null);
  };

  const k = plate && view ? view.width / plate.width : 1;
  const boxes = (doc?.remove ?? []).filter((r) => r.enabled && r.source.type === 'rect');
  const patches = (doc?.guidance.patches ?? []).filter((x) => x.enabled && (!x.frames || (frame >= x.frames.first && frame <= x.frames.last) || ctl.outputMode === 'still'));
  const records = useMemo(() => new Map((doc?.frames ?? []).map((f) => [f.frame, f])), [doc?.frames]);
  const problems = useMemo(() => new Set(review.problems.map((p) => p.frame)), [review.problems]);
  const guidance = doc?.guidance ?? { prefer: [], exclude: [], patches: [] };
  const count = Math.max(1, last - first + 1);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const scrub = (e: ReactPointerEvent) => {
    const el = timelineRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const t = Math.max(0, Math.min(1, (e.clientX - r.left) / Math.max(1, r.width)));
    onFrame(Math.round(first + t * (count - 1)));
  };
  const stillRecord = doc?.frames.length === 1 && ctl.outputMode === 'still' ? doc.frames[0]! : null;

  const needsBuild = mode !== 'source' && mode !== 'removed' && view && !view.plate;
  const message =
    ctl.sessionError ??
    (ctl.session && !ctl.session.available ? ctl.session.reason : null) ??
    (view ? null : ctl.viewError) ??
    (needsBuild ? 'Build the clean plate (step 3) to see it here.' : null);
  const cursorClass = tool ? 'tool-box' : wipe.on ? 'tool-wipe' : '';

  return (
    <div className="key-viewer cp-viewer" aria-label={`Clean plate viewer — ${ctl.state?.vfxShotId ?? ctl.props.shotId}`} role="region">
      <div className="key-viewer-bar">
        <div className="seg key-modes" role="tablist" aria-label="View">
          {CLEANPLATE_VIEWS.map((m) => (
            <button key={m} type="button" role="tab" aria-selected={mode === m} className={mode === m ? 'on' : undefined} onClick={() => setMode(m)} disabled={!view && m !== 'source'}>
              {CLEANPLATE_VIEW_LABELS[m]}
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
        {view ? <canvas ref={canvasRef} className="key-canvas" aria-label={`${CLEANPLATE_VIEW_LABELS[mode]} of frame ${view.frame}`} /> : null}
        {view ? (
          <svg className="key-overlay" viewBox={`0 0 ${view.width} ${view.height}`} preserveAspectRatio={overlayAspect(stageSize)} aria-hidden="true">
            {boxes.map((r) => {
              const b = (r.source as { rect: CleanPlateRect }).rect;
              return <rect key={r.id} className="key-box cp-box-remove" x={b.x0 * k} y={b.y0 * k} width={(b.x1 - b.x0) * k} height={(b.y1 - b.y0) * k} />;
            })}
            {patches.map((x) => (
              <rect key={x.id} className="key-box cp-box-patch" x={x.rect.x0 * k} y={x.rect.y0 * k} width={(x.rect.x1 - x.rect.x0) * k} height={(x.rect.y1 - x.rect.y0) * k} />
            ))}
            {drag ? <rect className="key-box drawing" x={Math.min(drag.x0, drag.x1)} y={Math.min(drag.y0, drag.y1)} width={Math.abs(drag.x1 - drag.x0)} height={Math.abs(drag.y1 - drag.y0)} /> : null}
            {wipe.on ? <line className="key-wipe" x1={wipe.x * view.width} x2={wipe.x * view.width} y1={0} y2={view.height} /> : null}
          </svg>
        ) : null}
        </FrameBox>
        {view ? <AspectTag aspect={aspect} /> : null}
        {message ? <div className="key-message">{message}</div> : null}
        {ctl.loading && view ? <div className="key-busy" aria-live="polite">Loading…</div> : null}
        {view?.plate && view.stillFrame !== null && (mode === 'plate' || mode === 'unresolved' || mode === 'confidence') ? <div className="key-hint">A still: one plate in frame {view.stillFrame}’s coordinates for the whole shot.</div> : null}
        {view?.plate && view.built === 'stale' && mode !== 'source' && mode !== 'removed' ? <div className="key-hint cp-stale">Settings changed since this was built: build again (step 3).</div> : null}
        {tool === 'patch' ? <div className="key-hint">Drag the region to take from frame {ctl.patchFrom ?? defaultPatchSource(ctl)}.</div> : tool === 'remove-box' ? <div className="key-hint">Drag a box round what to remove.</div> : null}
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
          title="Each tick is a frame, coloured by its confidence; red underline: a problem frame"
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
            const rec = records.get(f) ?? stillRecord;
            const cls = `key-tick${problems.has(f) ? ' problem' : ''}${guidance.exclude.includes(f) ? ' cp-excluded' : ''}${guidance.prefer.includes(f) ? ' cp-preferred' : ''}`;
            return <span key={i} className={cls} style={{ background: rec ? confidenceColour(rec.confidence) : undefined }} />;
          })}
          {ctl.outputMode === 'still' || doc?.referenceFrame !== null ? <span className="cp-ref-mark" style={{ left: `${((ctl.reference - first) / Math.max(1, count - 1)) * 100}%` }} title={`Reference frame ${ctl.reference}`} /> : null}
          <span className="key-playhead" style={{ left: `${((frame - first) / Math.max(1, count - 1)) * 100}%` }} />
        </div>
        <button type="button" aria-label="Next frame" onClick={() => onFrame(Math.min(last, frame + 1))}>
          ▶
        </button>
        <span className="key-frame mono">{frame}</span>
        <button type="button" disabled={!review.problems.length} onClick={() => ctl.actions.nextProblem()} title="Jump to the next frame with unresolved areas or a bad alignment">
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

export function Big({ label, value, unit, tone, title }: { label: string; value: ReactNode; unit?: string; tone?: 'ok' | 'warn' | 'bad' | undefined; title?: string }) {
  return (
    <div className={`stat${tone ? ` ${tone}` : ''}${typeof value === 'string' && value.length > 6 ? ' long' : ''}`} title={title}>
      <span className="stat-value">
        {value}
        {unit ? <span className="stat-unit">{unit}</span> : null}
      </span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

export function CleanPlateInfo({ ctl }: { ctl: CleanPlateController }) {
  const { doc, summary, review, task, version, session, record, lastRun, view } = ctl;
  const total = ctl.last - ctl.first + 1;
  const m = view?.metrics ?? record?.metrics ?? null;
  const suggestion = doc?.suggestion ?? null;
  const has = summary.frames > 0;
  return (
    <div className="key-info cp-info">
      <div className="stats">
        <Big label="Frames built" value={has ? (lastRun?.mode === 'still' ? 'still' : `${summary.frames}`) : '—'} unit={has && lastRun?.mode !== 'still' ? ` / ${total}` : undefined} tone={has ? (ctl.built ? 'ok' : 'warn') : undefined} title={ctl.built ? undefined : has ? 'Settings changed since the build' : undefined} />
        <Big label={doc?.mode === 'auto' ? 'Mode (auto)' : 'Mode'} value={ctl.outputMode === 'still' ? 'Still' : 'Per frame'} />
        <Big label="Seen in other frames" value={has ? Math.round(summary.coverage * 100) : '—'} unit={has ? '%' : undefined} tone={has ? (summary.coverage > 0.98 ? 'ok' : 'warn') : undefined} title="Share of the removed area rebuilt from frames that see it (the rest is filled in and unresolved)" />
        <Big label="Low confidence" value={has ? (summary.low * 100).toFixed(1) : '—'} unit={has ? '%' : undefined} tone={has ? (summary.low < 0.01 ? 'ok' : summary.low < 0.1 ? 'warn' : 'bad') : undefined} title="Share of the removed area that wants paint or a patch" />
        <Big label="Alignment residual" value={suggestion ? suggestion.residualPx.toFixed(2) : '—'} unit={suggestion ? ' px' : undefined} tone={suggestion ? (suggestion.residualPx < 0.75 ? 'ok' : suggestion.residualPx < 1.5 ? 'warn' : 'bad') : undefined} title="Median leftover motion after aligning frames (parallax, lens distortion)" />
        <Big label="Problem frames" value={has ? review.problems.length : '—'} tone={has ? (review.problems.length ? 'warn' : 'ok') : undefined} />
      </div>
      {suggestion ? (
        <section className="info-section">
          <h4>Camera</h4>
          <dl className="key-kv">
            <dt>Motion</dt>
            <dd>{suggestion.static ? 'locked off' : `moves up to ${suggestion.motionPx.toFixed(0)} px`}</dd>
            <dt>Exposure</dt>
            <dd>{suggestion.exposureStops < 0.02 ? 'steady' : `changes up to ${suggestion.exposureStops.toFixed(2)} stops (matched)`}</dd>
            <dt>Suggests</dt>
            <dd>{suggestion.mode === 'still' ? 'a still' : 'a plate per frame'}</dd>
          </dl>
        </section>
      ) : null}
      {m ? (
        <section className="info-section">
          <h4>{lastRun?.mode === 'still' ? `The still (frame ${record?.frame ?? ctl.reference})` : `Frame ${ctl.frame}`}</h4>
          <dl className="key-kv">
            <dt>Removed</dt>
            <dd>{(m.hole * 100).toFixed(1)} % of the frame</dd>
            <dt>Seen elsewhere</dt>
            <dd>{(m.coverage * 100).toFixed(1)} %</dd>
            <dt>Unresolved</dt>
            <dd>{(m.low * 100).toFixed(1)} % of what was removed</dd>
            <dt>Residual</dt>
            <dd>{m.residualPx.toFixed(2)} px</dd>
          </dl>
          {record?.reason ? <p className="warn-text">Problem: {record.reason}</p> : null}
        </section>
      ) : null}
      <section className="info-section">
        <h4>Version</h4>
        <dl className="key-kv">
          <dt>Clean plate</dt>
          <dd>
            {versionTag(version)} · {task ? TASK_STATE_LABELS[task.state] : 'no task'}
            {task?.approval ? ` · approved by ${task.approval.by}` : ''}
          </dd>
          <dt>Exported</dt>
          <dd>{ctl.exported ? `${ctl.exported.mode === 'still' ? 'still' : `${ctl.exported.frames} frames`}, ${ctl.exported.format.toUpperCase()}` : 'not yet'}</dd>
          <dt>Settings</dt>
          <dd>
            revision {doc?.revision ?? 0}
            {lastRun && !ctl.built ? ' (changed since the build)' : ''}
          </dd>
          <dt>Frames</dt>
          <dd>{session?.frames || '—'}</dd>
          <dt>Built in</dt>
          <dd>{session?.encoding.label || '—'}</dd>
        </dl>
        {session?.encoding.note ? <p className="warn-text">{session.encoding.note}</p> : null}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The steps as a list (for tests and a standalone workspace)
// ---------------------------------------------------------------------------

export function CleanPlateWorkspace(props: CleanPlateWorkspaceProps) {
  const ctl = useCleanPlateController(props);
  const steps = cleanPlateStepDefs(ctl);
  const current = steps.find((s) => !s.done && !s.optional)?.id ?? null;
  const [open, setOpen] = useState<Set<string>>(() => new Set(steps.map((s) => s.id)));
  if (!ctl.supported) return <div className="key-missing">Clean plates are not available in this build.</div>;
  return (
    <div className="key-workspace">
      <aside className="key-zone key-zone-steps" aria-label="Steps">
        <ol className="steps key-steps" aria-label="Clean plate steps">
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
        <CleanPlateViewer ctl={ctl} />
      </section>
      <aside className="key-zone key-zone-info" aria-label="Details">
        <CleanPlateInfo ctl={ctl} />
      </aside>
    </div>
  );
}
