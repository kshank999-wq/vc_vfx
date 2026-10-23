import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { AspectTag, FrameBox, overlayAspect, useShotAspect, useStageSize } from '../FrameBox';
import { fitFrame } from '../../frame-fit';
import {
  LIGHT_ROLES,
  LIGHT_ROLE_LABELS,
  LIGHT_TYPES,
  LIGHT_TYPE_LABELS,
  LIGHTING_LOW_CONFIDENCE,
  LIGHTING_LOW_MATCH,
  LIGHTING_REFERENCE_LABELS,
  TASK_STATE_LABELS,
  addLight,
  addLightingReference,
  addTask,
  decideLightingSuggestion,
  kelvinRgb,
  lightFieldText,
  lightingAnalysisCurrent,
  lightingDoc,
  lightingExportProblem,
  lightingLens,
  lightingLocked,
  lightingRig,
  lightingSummary,
  lightingTaskVersion,
  lockLightFields,
  pendingLightingSuggestions,
  rangeText,
  recordLightingAiReview,
  recordLightingAnalysis,
  recordLightingExport,
  removeLight,
  removeLightingReference,
  restoreLight,
  serializeProject,
  setLensOverride,
  setLightFields,
  setLightingFrames,
  setLightingSettings,
  shotState,
  updateLightingReference,
  versionTag,
  type LightField,
  type LightFields,
  type LightSpec,
  type LightingDocument,
  type LightingExportFormat,
  type LightingReferenceKind,
  type Project,
  type Range,
  type Result,
  type RigLight,
} from '@vcvfx/domain';
import type { VcvfxApi } from '../../../shared/bridge';
import type { LightingFrameView, LightingReferenceView, LightingSessionInfo } from '../../../shared/lighting/bridge-types';
import { ROLE_COLOURS, diagramRadius, frameArrow, radiusToDistance, sidePoint, topPoint, topToAzimuth, wedgePath } from '../../../shared/lighting/diagram';
import { Big, Check } from '../cleanplate/CleanPlateWorkspace';
import '../key/key.css';
import '../cleanplate/cleanplate.css';
import './lighting.css';

/**
 * The Lighting workspace (master spec §13; addendum 14): choose the frames
 * and the references (a chrome ball, a grey ball, an HDRI); analyse; review
 * the estimated lights — every one editable, add and remove, lock fields so
 * a new analysis leaves them — with their ranges; the lens and camera;
 * export the rig for Unreal and USD. The viewer shows the plate with each
 * light's direction inside its range's cone, the practicals and shadows
 * found, the rig from above or the side (drag a light to move it), and the
 * subject relit by the rig as it is, against the plate (A/B wipe), with a
 * grey ball and the match score.
 *
 * Built for the three-zone module screen (addendum 08), as the other modules
 * are: `useLightingController` holds the state and actions;
 * `lightingStepDefs` (left), `LightingViewer` (centre) and `LightingInfo`
 * (right) draw from it. Every change is a logged domain mutation applied
 * through `onLighting`. An analysis puts the task up for review; nothing
 * here approves.
 */

export type LightingMutation = (p: Project, actor: string, now: Date) => Result;

export interface LightingWorkspaceProps {
  api: VcvfxApi;
  project: Project;
  shotId: string;
  projectKey: string;
  canEdit: boolean;
  busy: boolean;
  actor: string;
  frame?: number;
  /** Apply a domain mutation; false when it was refused (the shell shows why). */
  onLighting(fn: LightingMutation): boolean;
  runJob<T>(label: string, fn: (jobId: string) => Promise<T>): Promise<T>;
  notify(kind: 'ok' | 'error' | 'info', text: string): void;
}

export const LIGHTING_VIEWS = ['plate', 'relit', 'wipe', 'reference'] as const;
export type LightingView = (typeof LIGHTING_VIEWS)[number];
export const LIGHTING_VIEW_LABELS: Record<LightingView, string> = { plate: 'Plate', relit: 'Relit', wipe: 'A/B wipe', reference: 'Reference' };

const unwrap = <T,>(r: { ok: true; data: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(r.error);
  return r.data;
};
const FRAME_WIDTH = 960;
const DEFAULT_FORMATS: LightingExportFormat[] = ['unreal', 'json', 'usd', 'blender', 'report'];

// ---------------------------------------------------------------------------
// The controller
// ---------------------------------------------------------------------------

export function useLightingController(props: LightingWorkspaceProps) {
  const { api, project, shotId, projectKey, canEdit, actor, onLighting, runJob, notify } = props;
  const state = shotState(project, shotId);
  const doc: LightingDocument | null = lightingDoc(state);
  const hasTask = Boolean(state?.tasks.some((t) => t.kind === 'lighting_analysis'));
  const task = state?.tasks.find((t) => t.kind === 'lighting_analysis') ?? null;
  const locked = state ? lightingLocked(state) : 'No shot';
  const version = state ? lightingTaskVersion(state) : 1;
  const text = useMemo(() => serializeProject(project), [project]);
  const textRef = useRef(text);
  textRef.current = text;
  const supported = Boolean(api.lightingSession && api.lightingFrame);

  const [session, setSession] = useState<LightingSessionInfo | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [view, setView] = useState<LightingView>('plate');
  const [wipe, setWipe] = useState(0.5);
  const [overlays, setOverlays] = useState(true);
  const [diagram, setDiagram] = useState<'top' | 'side'>('top');
  const [lightPick, setLightPick] = useState<string | null>(null);
  const [refPick, setRefPick] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [frameView, setFrameView] = useState<LightingFrameView | null>(null);
  const [refView, setRefView] = useState<LightingReferenceView | null>(null);
  const [viewError, setViewError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /** A light being dragged on the diagram: its figures before they are committed. */
  const [draft, setDraft] = useState<{ id: string; fields: LightFields } | null>(null);
  const [formats, setFormats] = useState<LightingExportFormat[]>(DEFAULT_FORMATS);

  const rig = useMemo(() => lightingRig(doc, { includeRemoved: true }), [doc]);
  const live = rig.filter((l) => !l.removed);
  const lightId = lightPick && rig.some((l) => l.id === lightPick) ? lightPick : (live[0]?.id ?? null);
  const light = rig.find((l) => l.id === lightId) ?? null;
  const refs = doc?.references ?? [];
  const refId = refPick && refs.some((r) => r.id === refPick) ? refPick : (refs[0]?.id ?? null);
  // A reference just added is the one selected: marking a second ball's circle must not move the first's.
  const refCount = useRef({ shotId, n: refs.length });
  useEffect(() => {
    if (refCount.current.shotId === shotId && refs.length > refCount.current.n) setRefPick(refs[refs.length - 1]!.id);
    refCount.current = { shotId, n: refs.length };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shotId, refs.length]);
  const ref = refs.find((r) => r.id === refId) ?? null;
  const canChange = canEdit && !locked && Boolean(session?.available);
  const specs = useMemo(() => live.map((l) => (draft && draft.id === l.id ? ({ ...l.spec, ...draft.fields } as LightSpec) : l.spec)), [live, draft]);

  const refsKey = JSON.stringify(refs.map((r) => [r.id, r.path, r.encoding]));
  useEffect(() => {
    if (!api.lightingSession) return;
    let alive = true;
    setSessionError(null);
    void api.lightingSession({ text: textRef.current, shotId, projectKey }).then((r) => {
      if (!alive) return;
      if (r.ok) setSession(r.data);
      else setSessionError(r.error);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, shotId, projectKey, hasTask, refsKey]);

  const frames = doc?.settings.frames ?? [];
  const first = session?.first ?? 0;
  const last = session?.last ?? 0;
  const analysedFrame = doc?.analysis?.frame ?? null;
  const frame = frames[0] ?? analysedFrame ?? (session?.available ? Math.round((first + last) / 2) : 0);
  const [viewFrame, setViewFrame] = useState<number | null>(null);
  const shownFrame = viewFrame ?? frame;

  // The frame (and the relit subject under the rig as it is), throttled: one request in flight, the newest after it.
  const specsKey = JSON.stringify(specs);
  const pending = useRef<{ busy: boolean; again: boolean }>({ busy: false, again: false });
  const analysisKey = `${doc?.analysis?.at ?? ''}|${doc?.analysis?.revision ?? ''}|${doc?.revision ?? 0}`;
  const request = useCallback(() => {
    if (!api.lightingFrame || !session?.available) return;
    if (pending.current.busy) {
      pending.current.again = true;
      return;
    }
    pending.current.busy = true;
    setLoading(true);
    const ask = specs.length ? specs : null;
    void api
      .lightingFrame({ text: textRef.current, shotId, projectKey, request: { frame: shownFrame, maxWidth: FRAME_WIDTH, rig: ask } })
      .then((r) => {
        if (r.ok) {
          setFrameView(r.data);
          setViewError(null);
        } else setViewError(r.error);
      })
      .finally(() => {
        pending.current.busy = false;
        setLoading(false);
        if (pending.current.again) {
          pending.current.again = false;
          request();
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, session?.available, shotId, projectKey, shownFrame, specsKey, analysisKey]);
  const requestRef = useRef(request);
  requestRef.current = request;
  useEffect(() => {
    requestRef.current();
  }, [request]);

  // The selected reference's picture.
  useEffect(() => {
    if (view !== 'reference') return;
    // Never another shot's or another reference's picture while this one loads (a 10K HDRI takes seconds).
    setRefView(null);
    if (!api.lightingImage || !session?.available || !ref) return;
    let alive = true;
    void api.lightingImage({ text: textRef.current, shotId, projectKey, id: ref.id, maxWidth: ref.kind === 'hdri' ? 1600 : 960 }).then((r) => {
      if (!alive) return;
      if (r.ok) setRefView(r.data);
      else setViewError(r.error);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, session?.available, ref?.id, ref?.encoding, view, shotId]);

  const apply = useCallback((fn: LightingMutation) => onLighting(fn), [onLighting]);
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

  const summary = useMemo(() => lightingSummary(doc), [doc]);
  const lens = useMemo(() => lightingLens(doc), [doc]);
  const exported = doc?.exports.find((e) => e.version === version) ?? null;
  const exportCurrent = Boolean(exported && exported.revision === doc?.revision && exported.editRevision === doc?.editRevision);
  const current = lightingAnalysisCurrent(doc);
  const pendingAi = pendingLightingSuggestions(doc);

  const ingest = async (kind: LightingReferenceKind, sources: { path: string; from: 'disk' | 'handoff' | 'texture' | 'sample' | 'plate' }[], frameNo: number | null = null) => {
    if (!api.lightingIngest) throw new Error('Adding references is not available here.');
    const got = await runJob(`Reading the ${LIGHTING_REFERENCE_LABELS[kind].toLowerCase()} for ${state?.vfxShotId ?? shotId}`, async (jobId) => unwrap(await api.lightingIngest!({ jobId, text: textRef.current, shotId, projectKey, kind, sources, frame: frameNo })));
    let added = 0;
    for (const r of got) if (apply((p, a, t) => addLightingReference(p, shotId, r, a, t))) added += 1;
    return added;
  };

  const actions = {
    useSample: () =>
      guard('Adding…', async () => {
        let n = 0;
        for (const r of session?.sample?.refs ?? []) if (!refs.some((x) => x.from === 'sample' && x.path === r.name)) n += await ingest(r.kind, [{ path: r.name, from: 'sample' }]);
        if (n) notify('ok', 'The sample references are in: a chrome ball, a grey ball and the HDRI from the subject’s place. Analyse next (step 2).');
      }),
    addFromDisk: (kind: LightingReferenceKind) =>
      guard('Adding…', async () => {
        if (!api.lightingChoose) throw new Error('Choosing files is the desktop app’s.');
        const paths = unwrap(await api.lightingChoose({ kind }));
        if (!paths?.length) return;
        if (await ingest(kind, paths.map((path) => ({ path, from: 'disk' as const })))) notify('ok', `${LIGHTING_REFERENCE_LABELS[kind]} added: read, checksummed, never changed.${kind !== 'hdri' ? ' Mark the ball’s circle in the viewer (Reference).' : ''}`);
      }),
    addFromHandoff: (item: LightingSessionInfo['handoff'][number]) =>
      guard('Adding…', async () => {
        if (await ingest(item.kind, [{ path: item.path, from: item.from }])) notify('ok', `${item.name} added.`);
      }),
    addPlateBall: (kind: 'chrome_ball' | 'grey_ball', frameNo: number) =>
      guard('Adding…', async () => {
        if (await ingest(kind, [{ path: '', from: 'plate' }], frameNo)) {
          setView('reference');
          notify('info', `Drag across the ball in the viewer to mark its circle (frame ${frameNo}).`);
        }
      }),
    removeReference: (id: string) => apply((p, a, t) => removeLightingReference(p, shotId, id, a, t)),
    setCircle: (id: string, circle: { cx: number; cy: number; r: number }) => apply((p, a, t) => updateLightingReference(p, shotId, id, { circle }, a, t)),
    setHeading: (id: string, headingDeg: number | null) => apply((p, a, t) => updateLightingReference(p, shotId, id, { headingDeg }, a, t)),
    useFrame: (f: number) => apply((p, a, t) => setLightingFrames(p, shotId, [f, ...frames.filter((x) => x !== f)].slice(0, 8), a, t)),
    removeFrame: (f: number) => apply((p, a, t) => setLightingFrames(p, shotId, frames.filter((x) => x !== f), a, t)),
    setSettings: (change: Parameters<typeof setLightingSettings>[2]) => apply((p, a, t) => setLightingSettings(p, shotId, change, a, t)),
    analyse: () =>
      guard('Analysing…', async () => {
        if (!api.lightingAnalyse) throw new Error('Analysing is not available here.');
        const { analysis } = await runJob(`Analysing the lighting of ${state?.vfxShotId ?? shotId}`, async (jobId) => unwrap(await api.lightingAnalyse!({ jobId, text: textRef.current, shotId, projectKey })));
        if (apply((p, a, t) => recordLightingAnalysis(p, shotId, analysis, a, t))) {
          const key = analysis.lights.find((l) => l.role === 'key' || l.role === 'sun');
          notify('ok', `${analysis.lights.length} light${analysis.lights.length === 1 ? '' : 's'} estimated${key ? `; key from ${rangeText(key.azimuth, '°')} azimuth, ${rangeText(key.elevation, '°')} elevation` : ''}. Review them (step 3).`);
          setView('relit');
        }
      }),
    select: (id: string) => setLightPick(id),
    setLight: (id: string, change: LightFields) => apply((p, a, t) => setLightFields(p, shotId, id, change, a, t)),
    lock: (id: string, fields: LightField[], on: boolean) => apply((p, a, t) => lockLightFields(p, shotId, id, fields, on, a, t)),
    addLight: (spec: Partial<LightSpec> = {}) => {
      const before = new Set((doc?.added ?? []).map((x) => x.id));
      let created: string | null = null;
      if (
        apply((p, a, t) => {
          const r = addLight(p, shotId, spec, a, t);
          if (r.ok) created = lightingDoc(shotState(r.project, shotId))?.added.find((x) => !before.has(x.id))?.id ?? null;
          return r;
        })
      )
        if (created) setLightPick(created);
    },
    removeLight: (id: string) => apply((p, a, t) => removeLight(p, shotId, id, a, t)),
    restoreLight: (id: string) => apply((p, a, t) => restoreLight(p, shotId, id, a, t)),
    setLens: (change: Parameters<typeof setLensOverride>[2]) => apply((p, a, t) => setLensOverride(p, shotId, change, a, t)),
    setDraft,
    commitDraft: () => {
      if (!draft) return;
      const d = draft;
      setDraft(null);
      apply((p, a, t) => setLightFields(p, shotId, d.id, d.fields, a, t));
    },
    exportRig: () =>
      guard('Exporting…', async () => {
        if (!api.lightingExport) throw new Error('Exporting is not available here.');
        const out = await runJob(`Exporting the light rig of ${state?.vfxShotId ?? shotId}`, async (jobId) => unwrap(await api.lightingExport!({ jobId, text: textRef.current, shotId, projectKey, operator: actor, formats })));
        if (apply((p, a, t) => recordLightingExport(p, shotId, out.record, a, t))) notify('ok', `Light rig ${versionTag(out.record.version)} written: ${out.files} files in ${out.folder}`);
      }),
    setFormats,
    aiReview: (note: string) =>
      guard('Asking…', async () => {
        if (!api.lightingAiReview) throw new Error('The AI review is the desktop app’s.');
        const { review } = await runJob(`Asking the AI assistant about ${state?.vfxShotId ?? shotId}`, async (jobId) => unwrap(await api.lightingAiReview!({ jobId, text: textRef.current, shotId, projectKey, ...(note.trim() ? { note: note.trim() } : {}) })));
        if (apply((p, a, t) => recordLightingAiReview(p, shotId, review, a, t))) notify('ok', `${review.suggestions.length} suggestion${review.suggestions.length === 1 ? '' : 's'} from ${review.model}: accept or reject each.`);
      }),
    decide: (reviewId: string, suggestionId: string, decision: 'accepted' | 'rejected') => apply((p, a, t) => decideLightingSuggestion(p, shotId, reviewId, suggestionId, decision, a, t)),
    addTask: () => apply((p, a, t) => addTask(p, shotId, 'lighting_analysis', a, t)),
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
    setView,
    wipe,
    setWipe,
    overlays,
    setOverlays,
    diagram,
    setDiagram,
    rig,
    live,
    light,
    lightId,
    refs,
    ref,
    refId,
    setRefPick,
    frameView,
    refView,
    viewError,
    loading,
    working,
    canChange,
    canEdit,
    busy: props.busy || working !== null,
    summary,
    lens,
    exported,
    exportCurrent,
    current,
    pendingAi,
    frames,
    frame,
    shownFrame,
    setViewFrame,
    first,
    last,
    draft,
    specs,
    formats,
    actions,
  };
}
export type LightingController = ReturnType<typeof useLightingController>;

// ---------------------------------------------------------------------------
// Steps (left)
// ---------------------------------------------------------------------------

export interface LightingStepDef {
  id: string;
  title: string;
  hint?: string;
  done: boolean;
  optional?: boolean;
  waiting?: string | null;
  content: ReactNode;
}

const fmt = (v: number, d = 1) => (Number.isFinite(v) ? (+v.toFixed(d)).toString() : '—');

function ReferenceList({ ctl }: { ctl: LightingController }) {
  const status = new Map((ctl.session?.references ?? []).map((s) => [s.id, s]));
  if (!ctl.refs.length) return <p className="muted key-note">No references: the analysis reads the plate alone.</p>;
  return (
    <ul className="key-links lt-refs">
      {ctl.refs.map((r) => {
        const st = status.get(r.id);
        const needsCircle = r.kind !== 'hdri' && !r.circle;
        return (
          <li key={r.id} className={`key-link lt-ref${r.id === ctl.refId ? ' on' : ''}`}>
            <span className={`key-link-dot lt-kind-${r.kind}`} aria-hidden="true" />
            <button
              type="button"
              className="link lt-ref-name"
              aria-pressed={r.id === ctl.refId}
              title={`${r.path || `plate frame ${r.frame}`}${r.checksum ? `\nsha256 ${r.checksum.value}` : ''}`}
              onClick={() => {
                ctl.setRefPick(r.id);
                ctl.setView('reference');
              }}
            >
              <strong>{LIGHTING_REFERENCE_LABELS[r.kind]}</strong>
              <span className="lt-file">{r.name}</span>
              <span className="lt-meta">
                {r.from === 'plate' ? `plate frame ${r.frame}` : r.width ? `${r.width}×${r.height}` : ''}
                {r.kind === 'hdri' ? ` · heading ${r.headingDeg === null ? 'aligned by the analysis' : `${r.headingDeg}°`}` : r.circle ? ` · circle r ${Math.round(r.circle.r)} px` : ''}
                {needsCircle ? <span className="warn-text"> · mark its circle</span> : null}
                {st && !st.onDisk ? <span className="warn-text"> · not on the drive</span> : st?.changed ? <span className="warn-text"> · changed since added</span> : null}
              </span>
            </button>
            <button type="button" className="small danger" aria-label={`Remove ${r.name}`} disabled={!ctl.canChange} onClick={() => ctl.actions.removeReference(r.id)}>
              ✕
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function NumberField({ label, value, unit, disabled, min, max, step, placeholder, onCommit, aria }: { label: string; value: number | null; unit?: string; disabled: boolean; min?: number; max?: number; step?: number; placeholder?: string; onCommit(v: number | null): void; aria?: string }) {
  const [draft, setDraft] = useState(value === null ? '' : String(value));
  useEffect(() => setDraft(value === null ? '' : String(value)), [value]);
  const commit = () => {
    if (draft.trim() === '') {
      if (value !== null) onCommit(null);
      return;
    }
    const v = Number(draft);
    if (Number.isFinite(v) && v !== value) onCommit(v);
  };
  return (
    <label className="key-field lt-num">
      <span>
        {label}
        {unit ? <span className="muted"> ({unit})</span> : null}
      </span>
      <input type="number" aria-label={aria ?? label} value={draft} min={min} max={max} step={step ?? 'any'} placeholder={placeholder} disabled={disabled} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />
    </label>
  );
}

export function lightingStepDefs(ctl: LightingController): LightingStepDef[] {
  const { doc, session, canChange, busy, actions, summary } = ctl;
  const sample = session?.sample ?? null;
  const sampleDone = Boolean(sample && sample.refs.every((r) => ctl.refs.some((x) => x.from === 'sample' && x.path === r.name)));
  const handoffItems = (session?.handoff ?? []).filter((h) => h.onDisk && !ctl.refs.some((r) => r.from === h.from && r.path === h.path));
  const missingCircle = ctl.refs.some((r) => r.kind !== 'hdri' && !r.circle);
  const exportProblem = lightingExportProblem(doc);
  const s = doc?.settings;
  const analysis = doc?.analysis ?? null;
  return [
    {
      id: 'frames',
      title: 'Frames and references',
      hint: 'The frame to read (it places the rig), and any chrome or grey ball and the HDRI. Read only.',
      done: Boolean(session?.available) && !missingCircle,
      content: (
        <>
          <div className="key-row lt-frames">
            <span className="key-slider-label">Frames</span>
            {ctl.frames.length ? (
              ctl.frames.map((f, i) => (
                <span key={f} className={`lt-chip${i === 0 ? ' on' : ''}`} title={i === 0 ? 'The rig is placed at this frame' : 'Also analysed (steadies the key)'}>
                  {f}
                  <button type="button" className="link" aria-label={`Stop analysing frame ${f}`} disabled={!canChange} onClick={() => actions.removeFrame(f)}>
                    ✕
                  </button>
                </span>
              ))
            ) : (
              <span className="muted">the middle frame ({ctl.frame})</span>
            )}
          </div>
          <div className="key-row">
            <button type="button" disabled={!canChange || ctl.frames[0] === ctl.shownFrame} onClick={() => actions.useFrame(ctl.shownFrame)} title="Analyse the frame the viewer shows (first: the rig is placed there)">
              Use frame {ctl.shownFrame}
            </button>
          </div>
          {sample && !sampleDone ? (
            <div className="action">
              <button type="button" className="primary big key-wrap" disabled={!canChange || busy} onClick={() => actions.useSample()} title="The sample shot comes with a chrome ball, a grey ball and an HDRI shot at the subject">
                Use the sample references (balls, HDRI)
              </button>
            </div>
          ) : null}
          {session?.fromDisk ? (
            <div className="key-row lt-add">
              <button type="button" disabled={!canChange || busy} onClick={() => actions.addFromDisk('chrome_ball')}>
                Chrome ball…
              </button>
              <button type="button" disabled={!canChange || busy} onClick={() => actions.addFromDisk('grey_ball')}>
                Grey ball…
              </button>
              <button type="button" disabled={!canChange || busy || ctl.refs.some((r) => r.kind === 'hdri')} onClick={() => actions.addFromDisk('hdri')}>
                HDRI…
              </button>
            </div>
          ) : null}
          {session?.fromDisk ? (
            <div className="key-row lt-add">
              <button type="button" disabled={!canChange || busy} onClick={() => actions.addPlateBall('chrome_ball', ctl.shownFrame)} title="The ball is held up in the take: use the frame the viewer shows">
                Chrome ball in frame {ctl.shownFrame}
              </button>
              <button type="button" disabled={!canChange || busy} onClick={() => actions.addPlateBall('grey_ball', ctl.shownFrame)}>
                Grey ball in frame {ctl.shownFrame}
              </button>
            </div>
          ) : null}
          {handoffItems.length ? (
            <div className="key-row lt-add">
              {handoffItems.map((h) => (
                <button key={`${h.from}:${h.path}`} type="button" disabled={!canChange || busy || (h.kind === 'hdri' && ctl.refs.some((r) => r.kind === 'hdri'))} onClick={() => actions.addFromHandoff(h)} title={h.path}>
                  {h.name} ({h.from === 'texture' ? 'Textures' : 'handoff'})
                </button>
              ))}
            </div>
          ) : null}
          <ReferenceList ctl={ctl} />
          {ctl.ref?.kind === 'hdri' ? (
            <div className="key-row tex-fields">
              <NumberField label="HDRI heading" unit="°" aria="HDRI heading" value={ctl.ref.headingDeg} placeholder="align to the plate" min={-360} max={360} disabled={!canChange} onCommit={(v) => actions.setHeading(ctl.ref!.id, v)} />
            </div>
          ) : null}
          {ctl.ref && ctl.ref.kind !== 'hdri' ? <p className="muted key-note">{ctl.ref.circle ? 'Drag across the ball in the viewer (Reference) to mark it again.' : 'Drag across the ball in the viewer (Reference): from one edge to the other.'}</p> : null}
        </>
      ),
    },
    {
      id: 'analyse',
      title: 'Analyse',
      hint: 'Shading on the subject, its shadows, practicals, the balls and the HDRI, the lens: each figure with its range.',
      done: ctl.current,
      waiting: !session?.available ? (session?.reason ?? null) : null,
      content: (
        <>
          <div className="key-row tex-fields">
            <label className="key-field">
              <span>Subject from</span>
              <select className="tex-select" aria-label="Subject matte" value={s?.subject ?? 'auto'} disabled={!canChange} onChange={(e) => actions.setSettings({ subject: e.target.value as 'auto' })}>
                <option value="auto">auto (the first exported)</option>
                <option value="roto">Roto</option>
                <option value="bg_matte">Background removal</option>
                <option value="key_alpha">Key alpha</option>
                <option value="none">none</option>
              </select>
            </label>
            <NumberField label="Subject distance" unit="m" value={s?.subjectDistanceM ?? 3} min={0.2} max={1000} disabled={!canChange} onCommit={(v) => v !== null && actions.setSettings({ subjectDistanceM: v })} />
          </div>
          <div className="key-row tex-fields">
            <NumberField label="White balance" unit="K" aria="Camera white balance" value={s?.whiteBalanceK ?? null} placeholder={session?.camera.whiteBalance ?? 'unknown'} min={1500} max={20000} disabled={!canChange} onCommit={(v) => actions.setSettings({ whiteBalanceK: v })} />
            <Check label="Use the sky" checked={s?.useSky ?? true} disabled={!canChange} onChange={(v) => actions.setSettings({ useSky: v })} />
          </div>
          <p className="muted key-note">
            Subject: {session?.subject.label ?? '—'} · Lens: {session?.camera.focal ?? 'unknown (vanishing points)'} · Camera track: {session?.camera.solve ?? 'none (level camera assumed)'}
          </p>
          <div className="action">
            <button type="button" className="primary big" disabled={!canChange || busy || missingCircle} title={missingCircle ? 'Mark every ball’s circle first (step 1)' : undefined} onClick={() => actions.analyse()}>
              {analysis ? (ctl.current ? 'Analyse again' : 'Analyse (settings changed)') : 'Analyse'}
            </button>
          </div>
          {analysis ? (
            <p className="muted key-note">
              Frame {analysis.frame}: {analysis.lights.length} lights in {(analysis.ms / 1000).toFixed(1)} s · {analysis.algorithm}
              {ctl.current ? '' : ' · settings changed since'}
            </p>
          ) : null}
          {summary.warnings.length ? (
            <ul className="lt-warnings">
              {summary.warnings.map((w, i) => (
                <li key={i} className="warn-text">
                  {w}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ),
    },
    {
      id: 'lights',
      title: 'Review the lights',
      hint: 'Select a light to tune it (right); drag it on the rig diagram. Your values are locked: a new analysis keeps them.',
      // Done once the artist has looked: a light touched, or the rig exported (a fresh analysis opens this step).
      done: Boolean(analysis) && summary.lights > 0 && ctl.pendingAi.length === 0 && Boolean(doc && (doc.edits.length || doc.added.length || doc.removed.length || doc.exports.length)),
      waiting: !analysis && !(doc?.added.length ?? 0) ? 'Analyse first (step 2), or add a light by hand.' : null,
      content: (
        <>
          <ul className="key-links lt-lights" aria-label="Lights">
            {ctl.rig.map((l) => (
              <li key={l.id} className={`key-link lt-light${l.id === ctl.lightId ? ' on' : ''}${l.removed ? ' removed' : ''}${l.spec.enabled ? '' : ' off'}`}>
                <span className="key-link-dot" style={{ background: ROLE_COLOURS[l.spec.role] }} aria-hidden="true" />
                <button type="button" className="link lt-light-name" aria-pressed={l.id === ctl.lightId} onClick={() => actions.select(l.id)}>
                  <strong>{l.spec.name}</strong>
                  <span className="lt-meta">
                    {LIGHT_ROLE_LABELS[l.spec.role]} · {LIGHT_TYPE_LABELS[l.spec.type]}
                    {l.spec.type !== 'dome' ? ` · ${fmt(l.spec.azimuthDeg, 0)}° / ${fmt(l.spec.elevationDeg, 0)}°` : ''} · {lightFieldText('intensityStops', l.spec.intensityStops)}
                    {l.origin === 'artist' ? ' · yours' : l.locked.length ? ` · ${l.locked.length} locked` : ''}
                    {l.removed ? ' · removed' : ''}
                  </span>
                </button>
                {l.removed ? (
                  <button type="button" className="small" disabled={!ctl.canChange} onClick={() => actions.restoreLight(l.id)}>
                    Restore
                  </button>
                ) : (
                  <>
                    <Check label="On" checked={l.spec.enabled} disabled={!ctl.canChange} onChange={(v) => actions.setLight(l.id, { enabled: v })} />
                    <button type="button" className="small danger" aria-label={`Remove ${l.spec.name}`} disabled={!ctl.canChange} onClick={() => actions.removeLight(l.id)}>
                      ✕
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
          <div className="key-row">
            <button type="button" disabled={!canChange} onClick={() => actions.addLight({})}>
              Add a light
            </button>
            <button type="button" disabled={!canChange} onClick={() => actions.addLight({ role: 'practical', type: 'point', name: 'Practical', azimuthDeg: 120, elevationDeg: 10, distanceM: 2, intensityStops: -3, sizeDeg: 4, temperatureK: 2700 })}>
              Add a practical
            </button>
          </div>
          {ctl.pendingAi.length ? <p className="warn-text">{ctl.pendingAi.length} AI suggestion{ctl.pendingAi.length === 1 ? '' : 's'} to decide (right).</p> : null}
        </>
      ),
    },
    {
      id: 'lens',
      title: 'Lens and camera',
      hint: 'Focal length, film back and field of view, with where each came from; the exposure reference for the engines.',
      done: ctl.lens.focalMm !== null,
      optional: true,
      content: <LensStep ctl={ctl} />,
    },
    {
      id: 'export',
      title: `Export to Unreal / USD ${versionTag(ctl.version)}`,
      hint: 'The Unreal 5 script and its rig file, USD with the camera, Blender, the printable report. Versioned; never overwrites.',
      done: ctl.exportCurrent,
      content: (
        <>
          <div className="key-row lt-formats">
            {(
              [
                ['unreal', 'Unreal 5 (.py)'],
                ['usd', 'USD (.usda)'],
                ['blender', 'Blender (.py)'],
                ['report', 'Report (.html)'],
              ] as const
            ).map(([f, label]) => (
              <Check key={f} label={label} checked={ctl.formats.includes(f)} onChange={(v) => actions.setFormats(v ? [...ctl.formats, f] : ctl.formats.filter((x) => x !== f))} />
            ))}
          </div>
          <p className="muted key-note">The rig file (JSON: every estimate, range, evidence and your edits) is always written.</p>
          <div className="action">
            <button type="button" className="primary big" disabled={!canChange || busy || Boolean(exportProblem) || !session?.exportable} title={exportProblem ?? (!session?.exportable ? 'Writing into the shot package is the desktop app’s' : undefined)} onClick={() => actions.exportRig()}>
              Export light rig {versionTag(ctl.version)}
            </button>
          </div>
          {!session?.exportable && session?.available ? <p className="muted key-note">Writing the files: the desktop app does it.</p> : null}
          {ctl.exported ? (
            <p className="muted key-note">
              Written {ctl.exported.folder}: {ctl.exported.formats.join(', ')}
              {ctl.exportCurrent ? '' : ' — the rig changed since: export again'}
            </p>
          ) : null}
        </>
      ),
    },
  ];
}

function LensStep({ ctl }: { ctl: LightingController }) {
  const est = ctl.doc?.analysis?.lens ?? null;
  const o = ctl.doc?.lens ?? { focalMm: null, filmBackMm: null, fStop: null };
  const L = ctl.lens;
  return (
    <div className="lt-lens">
      <dl className="key-kv">
        <dt>Focal length</dt>
        <dd>
          {L.focalMm !== null ? `${fmt(L.focalMm, 1)} mm` : 'unknown'}
          {L.focalRange ? <span className="muted"> · {rangeText(L.focalRange, ' mm', 1)}</span> : null} · {L.focalSource}
        </dd>
        {est?.checks.map((c, i) => (
          <div key={i} className="lt-kv-row">
            <dt>Check</dt>
            <dd className={c.agrees ? undefined : 'warn-text'}>{c.note}</dd>
          </div>
        ))}
        <dt>Film back</dt>
        <dd>{L.filmBackMm ? `${fmt(L.filmBackMm.width, 2)} × ${fmt(L.filmBackMm.height, 2)} mm · ${L.filmBackSource.replace('_', ' ')}` : '—'}</dd>
        <dt>Field of view</dt>
        <dd>{L.hfovDeg !== null ? `${fmt(L.hfovDeg, 1)}° × ${fmt(L.vfovDeg ?? 0, 1)}°${est?.hfovDeg && est.hfovDeg.high - est.hfovDeg.low >= 0.1 ? ` (across ${fmt(est.hfovDeg.low, 1)}–${fmt(est.hfovDeg.high, 1)}°)` : ''}` : '—'}</dd>
        <dt>Distortion</dt>
        <dd>{est ? `${est.distortion.k1 !== null ? `k1 ${fmt(est.distortion.k1, 4)} · ` : ''}${est.distortion.note}` : '—'}</dd>
        <dt>Aperture</dt>
        <dd>{est?.aperture.fStop ? `f/${rangeText(est.aperture.fStop, '', 1)} · ${est.aperture.note}` : (est?.aperture.note ?? '—')}</dd>
      </dl>
      <div className="key-row tex-fields">
        <NumberField label="Focal" unit="mm" aria="Focal length override" value={o.focalMm} placeholder="estimate" min={1} max={2000} disabled={!ctl.canChange} onCommit={(v) => ctl.actions.setLens({ focalMm: v })} />
        <NumberField label="f-stop" aria="f-stop override" value={o.fStop} placeholder="estimate" min={0.5} max={64} disabled={!ctl.canChange} onCommit={(v) => ctl.actions.setLens({ fStop: v })} />
      </div>
      <div className="key-row tex-fields">
        <NumberField label="Film back W" unit="mm" aria="Film back width" value={o.filmBackMm?.width ?? null} placeholder={L.filmBackMm ? fmt(L.filmBackMm.width, 2) : '—'} min={1} max={200} disabled={!ctl.canChange} onCommit={(v) => ctl.actions.setLens({ filmBackMm: v === null ? null : { width: v, height: o.filmBackMm?.height ?? L.filmBackMm?.height ?? v * 0.5625 } })} />
        <NumberField label="Key at subject" unit="lux" aria="Exposure reference (lux)" value={ctl.doc?.settings.keyLux ?? 1000} min={0.1} max={200000} disabled={!ctl.canChange} onCommit={(v) => v !== null && ctl.actions.setSettings({ keyLux: v })} />
      </div>
      <p className="muted key-note">Your figures override the estimate (empty: the estimate). The exposure reference sets Unreal’s units: a light of n stops gives that × 2ⁿ lux at the subject.</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The viewer (centre)
// ---------------------------------------------------------------------------

/** The RGBA of the viewer: the plate, the relit subject, or the wipe between them at x (0 … 1). */
export function composeLighting(view: LightingFrameView, mode: 'plate' | 'relit' | 'wipe', x: number): { width: number; height: number; data: Uint8ClampedArray<ArrayBuffer> } {
  const W = view.width;
  const H = view.height;
  const out = new Uint8ClampedArray(W * H * 4);
  const split = Math.round(x * W);
  for (let y = 0; y < H; y += 1)
    for (let i = 0; i < W; i += 1) {
      const p = y * W + i;
      const src = mode === 'plate' || !view.relit ? view.rgb : mode === 'relit' ? view.relit : i < split ? view.rgb : view.relit;
      out[4 * p] = src[3 * p]!;
      out[4 * p + 1] = src[3 * p + 1]!;
      out[4 * p + 2] = src[3 * p + 2]!;
      out[4 * p + 3] = 255;
    }
  return { width: W, height: H, data: out };
}

function drawRgb(canvas: HTMLCanvasElement | null, w: number, h: number, rgb: Uint8ClampedArray, alpha: Uint8Array | null = null) {
  if (!canvas) return;
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d');
  if (!g) return;
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i += 1) {
    d[4 * i] = rgb[3 * i]!;
    d[4 * i + 1] = rgb[3 * i + 1]!;
    d[4 * i + 2] = rgb[3 * i + 2]!;
    d[4 * i + 3] = alpha ? alpha[i]! : 255;
  }
  g.putImageData(new ImageData(d, w, h), 0, 0);
}

const rangesOf = (l: RigLight) => (l.estimate ? { azimuth: l.estimate.azimuth, elevation: l.estimate.elevation } : null);

function FrameOverlay({ ctl, w, h, fit = 'xMidYMid meet' }: { ctl: LightingController; w: number; h: number; fit?: 'none' | 'xMidYMid meet' }) {
  const a = ctl.doc?.analysis ?? null;
  const c = a?.subject.centre ?? { x: 0.5, y: 0.55 };
  const centre = { x: c.x * w, y: c.y * h };
  const len = 0.42 * Math.min(w, h);
  const tilt = { pitchDeg: a?.tilt.pitchDeg ?? 0, rollDeg: a?.tilt.rollDeg ?? 0 };
  const lights = ctl.live.filter((l) => l.spec.type !== 'dome');
  const stroke = Math.max(1.5, w / 360);
  // Arrow tips can land close together (a practical beside the key): labels near one another step apart.
  const font = Math.max(11, w / 62);
  const placed = lights
    .map((l) => {
      const spec = ctl.draft && ctl.draft.id === l.id ? ({ ...l.spec, ...ctl.draft.fields } as LightSpec) : l.spec;
      const arrow = frameArrow(spec, rangesOf(l), centre, len, tilt);
      return { l, arrow, labelY: arrow.tip.y + stroke * 2 };
    })
    .sort((p, q) => p.labelY - q.labelY);
  placed.forEach((p, i) => {
    for (let j = 0; j < i; j += 1) {
      const q = placed[j]!;
      if (Math.abs(q.arrow.tip.x - p.arrow.tip.x) < font * 6 && p.labelY - q.labelY < font * 1.35) p.labelY = q.labelY + font * 1.35;
    }
  });
  return (
    <svg className="key-overlay lt-overlay" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio={fit}>
      {(a?.marks ?? []).map((m, i) => {
        const x = m.x * w;
        const y = m.y * h;
        if (m.kind === 'shadow' && m.x2 !== null && m.y2 !== null) return <line key={i} className="lt-shadow" x1={x} y1={y} x2={m.x2 * w} y2={m.y2 * h} strokeWidth={stroke * 1.5} />;
        if (m.kind === 'practical' || m.kind === 'highlight' || m.kind === 'catchlight')
          return (
            <g key={i} className="lt-practical">
              <circle cx={x} cy={y} r={Math.max(w / 90, (m.r ?? 0) * w * 2)} strokeWidth={stroke} />
              <text x={x + w / 60} y={y - w / 90} style={{ fontSize: Math.max(11, w / 70) }}>
                {m.label}
              </text>
            </g>
          );
        if (m.kind === 'ball') return <circle key={i} className="lt-ball" cx={x} cy={y} r={(m.r ?? 0) * w} strokeWidth={stroke} />;
        if (m.kind === 'vanishing') return <path key={i} className="lt-vp" d={`M${x - 8} ${y}h16M${x} ${y - 8}v16`} strokeWidth={stroke} />;
        return null;
      })}
      {placed.map(({ l, arrow, labelY }) => {
        const on = l.id === ctl.lightId;
        const col = ROLE_COLOURS[l.spec.role];
        return (
          <g key={l.id} className={`lt-arrow${on ? ' on' : ''}${l.spec.enabled ? '' : ' off'}`} onPointerDown={(e) => (e.stopPropagation(), ctl.actions.select(l.id))}>
            {arrow.cone.length ? <polygon points={arrow.cone.map((p) => `${p.x},${p.y}`).join(' ')} fill={col} fillOpacity={on ? 0.22 : 0.08} stroke={col} strokeOpacity={on ? 0.7 : 0.3} strokeWidth={stroke * 0.7} /> : null}
            <line x1={centre.x} y1={centre.y} x2={arrow.tip.x} y2={arrow.tip.y} stroke={col} strokeWidth={stroke * (on ? 2.2 : 1.5)} strokeDasharray={arrow.behind ? `${stroke * 4} ${stroke * 3}` : undefined} />
            <circle cx={arrow.tip.x} cy={arrow.tip.y} r={stroke * (on ? 4 : 3)} fill={col} />
            <text x={arrow.tip.x + stroke * 5} y={labelY} className="lt-arrow-label" style={{ fontSize: font }}>
              {l.spec.name}
            </text>
          </g>
        );
      })}
      {a ? <circle cx={centre.x} cy={centre.y} r={stroke * 3} className="lt-centre" /> : null}
    </svg>
  );
}

const DIAGRAM = 240;
const INNER = 30;
const OUTER = 104;

/** The rig from above or the side, the lights draggable (azimuth and distance; elevation and distance). */
export function RigDiagram({ ctl }: { ctl: LightingController }) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [drag, setDrag] = useState<string | null>(null);
  const mode = ctl.diagram;
  const C = { x: DIAGRAM / 2, y: mode === 'top' ? DIAGRAM / 2 : DIAGRAM * 0.7 };
  const lights = ctl.live.filter((l) => l.spec.type !== 'dome');
  const toLocal = (e: ReactPointerEvent) => {
    const el = svgRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return { x: ((e.clientX - r.left) / r.width) * DIAGRAM, y: ((e.clientY - r.top) / r.height) * DIAGRAM };
  };
  const onMove = (e: ReactPointerEvent) => {
    if (!drag) return;
    const p = toLocal(e);
    const l = ctl.rig.find((x) => x.id === drag);
    if (!p || !l) return;
    const r = Math.hypot(p.x - C.x, p.y - C.y);
    const positional = l.spec.distanceM !== null;
    if (mode === 'top') {
      const az = Math.round(topToAzimuth(p, C) * 2) / 2;
      ctl.actions.setDraft({ id: l.id, fields: { azimuthDeg: Math.max(-180, Math.min(180, az)), ...(positional ? { distanceM: Math.round(radiusToDistance(r, INNER, OUTER) * 100) / 100 } : {}) } });
    } else {
      const behind = Math.abs(l.spec.azimuthDeg) > 90;
      const dx = (p.x - C.x) * (behind ? -1 : 1);
      const el = Math.round(Math.max(-90, Math.min(90, (Math.atan2(C.y - p.y, Math.max(1e-3, dx)) * 180) / Math.PI)) * 2) / 2;
      ctl.actions.setDraft({ id: l.id, fields: { elevationDeg: el, ...(positional ? { distanceM: Math.round(radiusToDistance(r, INNER, OUTER) * 100) / 100 } : {}) } });
    }
  };
  // Each light's point, and its label stepped clear of the labels before it.
  const items = lights
    .map((l) => {
      const spec = ctl.draft && ctl.draft.id === l.id ? ({ ...l.spec, ...ctl.draft.fields } as LightSpec) : l.spec;
      const rr = diagramRadius(spec.distanceM, INNER, OUTER);
      const p = mode === 'top' ? topPoint(spec.azimuthDeg, rr, C) : sidePoint(spec.azimuthDeg, spec.elevationDeg, rr, C);
      return { l, spec, p, label: { x: p.x + 10, y: p.y + 4 } };
    })
    .sort((a, b) => a.label.y - b.label.y);
  items.forEach((it, i) => {
    for (let j = 0; j < i; j += 1) {
      const q = items[j]!.label;
      if (Math.abs(q.x - it.label.x) < 64 && it.label.y - q.y < 12) it.label.y = q.y + 12;
    }
  });
  const onUp = () => {
    if (!drag) return;
    setDrag(null);
    ctl.actions.commitDraft();
  };
  return (
    <div className="lt-diagram" role="group" aria-label={`Rig from ${mode === 'top' ? 'above' : 'the side'}`}>
      <svg ref={svgRef} viewBox={`0 0 ${DIAGRAM} ${DIAGRAM}`} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={onUp}>
        {mode === 'top' ? (
          <>
            <circle cx={C.x} cy={C.y} r={OUTER} className="lt-ring" />
            <circle cx={C.x} cy={C.y} r={(INNER + OUTER) / 2} className="lt-ring faint" />
            <circle cx={C.x} cy={C.y} r={INNER} className="lt-ring" />
            <rect x={C.x - 8} y={DIAGRAM - 14} width={16} height={10} rx={2} className="lt-camera" />
            <text x={C.x + 12} y={DIAGRAM - 5} className="lt-tiny">
              camera
            </text>
            <text x={DIAGRAM - 30} y={C.y - 4} className="lt-tiny">
              right
            </text>
          </>
        ) : (
          <>
            <line x1={6} y1={C.y} x2={DIAGRAM - 6} y2={C.y} className="lt-ring" />
            <path d={`M${C.x - OUTER} ${C.y} A${OUTER} ${OUTER} 0 0 1 ${C.x + OUTER} ${C.y}`} className="lt-ring faint" />
            <text x={DIAGRAM - 34} y={C.y + 14} className="lt-tiny">
              front
            </text>
            <text x={8} y={C.y + 14} className="lt-tiny">
              behind
            </text>
          </>
        )}
        {items.map(({ l, spec, p }) => {
          const col = ROLE_COLOURS[l.spec.role];
          const on = l.id === ctl.lightId;
          const wedge = l.estimate && !l.locked.includes(mode === 'top' ? 'azimuthDeg' : 'elevationDeg') ? (mode === 'top' ? wedgePath(l.estimate.azimuth.low, l.estimate.azimuth.high, INNER, OUTER, C) : wedgePath(l.estimate.elevation.low, l.estimate.elevation.high, INNER, OUTER, C, (el, rad, c) => sidePoint(spec.azimuthDeg, el, rad, c))) : null;
          return (
            <g key={l.id} className={`lt-dlight${on ? ' on' : ''}${l.spec.enabled ? '' : ' off'}`}>
              {wedge ? <path d={wedge} fill={col} fillOpacity={on ? 0.24 : 0.08} stroke={col} strokeOpacity={on ? 0.6 : 0.25} /> : null}
              <line x1={C.x} y1={C.y} x2={p.x} y2={p.y} stroke={col} strokeWidth={on ? 2 : 1} />
              <circle
                cx={p.x}
                cy={p.y}
                r={on ? 8 : 6.5}
                fill={col}
                className="lt-handle"
                role="button"
                aria-label={`Drag ${l.spec.name}`}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  ctl.actions.select(l.id);
                  if (!ctl.canChange) return;
                  (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
                  setDrag(l.id);
                }}
              />
            </g>
          );
        })}
        {items.map(({ l, p, label }) => (
          <text key={l.id} x={label.x} y={label.y} className="lt-dlabel">
            {l.spec.name}
          </text>
        ))}
        <circle cx={C.x} cy={C.y} r={7} className="lt-subject" />
      </svg>
    </div>
  );
}

function BallPreview({ view }: { view: LightingFrameView | null }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    if (view?.ball) drawRgb(ref.current, view.ball.size, view.ball.size, view.ball.rgb, view.ball.alpha);
  }, [view]);
  if (!view?.ball) return null;
  return (
    <figure className="lt-ball-preview">
      <canvas ref={ref} aria-label="Grey ball under the rig" />
      <figcaption className="muted">Grey ball, the rig as it is</figcaption>
    </figure>
  );
}

export function LightingViewer({ ctl }: { ctl: LightingController }) {
  const { view, setView, frameView, refView, ref, overlays, wipe } = ctl;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const stageSize = useStageSize(stageRef);
  const aspect = useShotAspect(ctl.props.project, ctl.props.shotId);
  const [circleDrag, setCircleDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const showRef = view === 'reference';
  const shown = showRef ? refView : frameView;
  const mode = view === 'reference' ? 'plate' : view;

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    if (showRef && refView) drawRgb(c, refView.width, refView.height, refView.rgb);
    else if (!showRef && frameView) {
      const pic = composeLighting(frameView, mode, wipe);
      c.width = pic.width;
      c.height = pic.height;
      c.getContext('2d')?.putImageData(new ImageData(pic.data, pic.width, pic.height), 0, 0);
    }
  }, [showRef, refView, frameView, mode, wipe]);

  const vw = shown?.width ?? 1;
  const vh = shown?.height ?? 1;
  // Pixel aspect (addendum 17): the analysis frame comes de-squeezed already ("baked"); a plate reference comes as stored;
  // a still is square. The box is the stored shape × the display aspect, so both show alike.
  const plate = ctl.session?.plate ?? null;
  const baked = !showRef && plate ? vw / vh / (plate.width / plate.height) : 1;
  const display = showRef && ref?.from !== 'plate' ? 1 : aspect.display;
  const boxSize = { width: vw / baked, height: vh };
  const toView = (e: ReactPointerEvent) => {
    const el = stageRef.current;
    if (!el || !shown) return null;
    const rect = el.getBoundingClientRect();
    const b = fitFrame({ width: rect.width, height: rect.height }, boxSize, display);
    return { x: ((e.clientX - rect.left - b.left) / (b.scale * display)) * baked, y: (e.clientY - rect.top - b.top) / b.scale };
  };
  // View pixels are de-squeezed by this much on screen (circles drawn as ellipses of rx = r / squeeze).
  const shownSqueeze = display / baked;
  // Reference pixels per view pixel (balls are marked in their own picture's pixels).
  const refScale = ref && refView ? (ref.from === 'plate' ? (ctl.session?.plate?.width ?? refView.width) / refView.width : (ref.width ?? refView.width) / refView.width) : 1;
  const onDown = (e: ReactPointerEvent) => {
    const v = toView(e);
    if (!v) return;
    if (showRef && ref && ref.kind !== 'hdri' && ctl.canChange) {
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
      setCircleDrag({ x0: v.x, y0: v.y, x1: v.x, y1: v.y });
      return;
    }
    if (view === 'wipe') ctl.setWipe(Math.max(0, Math.min(1, v.x / vw)));
  };
  const onMove = (e: ReactPointerEvent) => {
    const v = toView(e);
    if (!v) return;
    if (circleDrag) setCircleDrag({ ...circleDrag, x1: v.x, y1: v.y });
    else if (view === 'wipe' && e.buttons === 1) ctl.setWipe(Math.max(0, Math.min(1, v.x / vw)));
  };
  const onUp = () => {
    if (!circleDrag || !ref) return;
    const d = circleDrag;
    setCircleDrag(null);
    // The radius measured on the picture as shown, in vertical pixels (a ball is round de-squeezed).
    const r = Math.hypot((d.x1 - d.x0) * shownSqueeze, d.y1 - d.y0) / 2;
    if (r < 4) return;
    ctl.actions.setCircle(ref.id, { cx: ((d.x0 + d.x1) / 2) * refScale, cy: ((d.y0 + d.y1) / 2) * refScale, r: r * refScale });
  };
  const message =
    ctl.sessionError ??
    (ctl.session && !ctl.session.available ? ctl.session.reason : null) ??
    (showRef && !ref ? 'Add a chrome ball, a grey ball or an HDRI (step 1) to see it here.' : null) ??
    ((view === 'relit' || view === 'wipe') && frameView && !frameView.relit ? (ctl.doc?.analysis ? 'The relight needs a subject matte (step 2).' : 'Analyse (step 2) to see the subject relit by the rig.') : null) ??
    (shown ? null : ctl.viewError);
  const stale = !showRef && frameView?.built === 'stale';
  const matchTone = frameView?.match === null || frameView?.match === undefined ? '' : frameView.match >= LIGHTING_LOW_MATCH ? 'ok' : 'warn';
  return (
    <div className="key-viewer lt-viewer" aria-label={`Lighting viewer — ${ctl.state?.vfxShotId ?? ctl.props.shotId}`} role="region">
      <div className="key-viewer-bar">
        <div className="seg key-modes" role="tablist" aria-label="View">
          {LIGHTING_VIEWS.map((m) => (
            <button key={m} type="button" role="tab" aria-selected={view === m} className={view === m ? 'on' : undefined} onClick={() => setView(m)}>
              {LIGHTING_VIEW_LABELS[m]}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <button type="button" className={overlays ? 'on' : undefined} aria-pressed={overlays} disabled={showRef} onClick={() => ctl.setOverlays(!overlays)} title="Each light’s direction from the subject in its range’s cone; practicals, shadows, vanishing points">
          Overlays
        </button>
      </div>
      <div className="lt-body">
        <div ref={stageRef} className={`key-stage lt-stage${showRef && ref?.kind !== 'hdri' ? ' tool-box' : view === 'wipe' ? ' tool-wipe' : ''}`} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}>
          <FrameBox stage={stageSize} size={shown ? boxSize : null} pixelAspect={display}>
          {shown ? <canvas ref={canvasRef} className="key-canvas" aria-label={showRef ? `Reference ${ref?.name ?? ''}` : `Frame ${frameView?.frame ?? ''} ${LIGHTING_VIEW_LABELS[view]}`} /> : null}
          {shown && !showRef && overlays ? <FrameOverlay ctl={ctl} w={vw} h={vh} fit={overlayAspect(stageSize)} /> : null}
          {shown && view === 'wipe' ? (
            <svg className="key-overlay" viewBox={`0 0 ${vw} ${vh}`} preserveAspectRatio={overlayAspect(stageSize)} aria-hidden="true">
              <line className="key-wipe" x1={wipe * vw} x2={wipe * vw} y1={0} y2={vh} />
              <text x={wipe * vw - 8} y={18} textAnchor="end" className="lt-wipe-label">
                plate
              </text>
              <text x={wipe * vw + 8} y={18} className="lt-wipe-label">
                relit
              </text>
            </svg>
          ) : null}
          {shown && showRef && ref && ref.kind !== 'hdri' ? (
            <svg className="key-overlay" viewBox={`0 0 ${vw} ${vh}`} preserveAspectRatio={overlayAspect(stageSize)} aria-hidden="true">
              {ref.circle && !circleDrag ? <ellipse className="lt-ball-mark" cx={ref.circle.cx / refScale} cy={ref.circle.cy / refScale} rx={ref.circle.r / refScale / shownSqueeze} ry={ref.circle.r / refScale} /> : null}
              {circleDrag ? (() => {
                const r = Math.hypot((circleDrag.x1 - circleDrag.x0) * shownSqueeze, circleDrag.y1 - circleDrag.y0) / 2;
                return <ellipse className="lt-ball-mark drawing" cx={(circleDrag.x0 + circleDrag.x1) / 2} cy={(circleDrag.y0 + circleDrag.y1) / 2} rx={r / shownSqueeze} ry={r} />;
              })() : null}
            </svg>
          ) : null}
          </FrameBox>
          {shown && (!showRef || ref?.from === 'plate') ? <AspectTag aspect={aspect} /> : null}
          {message ? <div className="key-message">{message}</div> : null}
          {ctl.loading && !message ? <div className="key-busy" aria-live="polite">Loading…</div> : null}
          {stale ? <div className="key-hint cp-stale">Settings changed since the analysis: analyse again (step 2).</div> : null}
        </div>
        <aside className="lt-side" aria-label="Rig">
          <div className="seg lt-diagram-mode" role="tablist" aria-label="Rig diagram">
            {(['top', 'side'] as const).map((m) => (
              <button key={m} type="button" role="tab" aria-selected={ctl.diagram === m} className={ctl.diagram === m ? 'on' : undefined} onClick={() => ctl.setDiagram(m)}>
                {m === 'top' ? 'From above' : 'From the side'}
              </button>
            ))}
          </div>
          <RigDiagram ctl={ctl} />
          <BallPreview view={frameView} />
          {frameView?.match !== null && frameView?.match !== undefined ? (
            <p className={`lt-match ${matchTone}`} title="How well the rig as it is explains the subject’s shading (R²)">
              Match {Math.round(frameView.match * 100)} %
            </p>
          ) : null}
        </aside>
      </div>
      {shown ? (
        <p className="key-view-label muted">
          {shown.label}
          {!showRef && frameView ? ` · frame ${frameView.frame} · ${frameView.width}×${frameView.height} shown` : ''}
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The numbers and the light's figures (right)
// ---------------------------------------------------------------------------

const FIELD_SPEC: { field: LightField; label: string; unit: string; min: number; max: number; step: number; range: (l: RigLight) => Range | null; digits: number }[] = [
  { field: 'azimuthDeg', label: 'Azimuth', unit: '°', min: -180, max: 180, step: 0.5, range: (l) => l.estimate?.azimuth ?? null, digits: 0 },
  { field: 'elevationDeg', label: 'Elevation', unit: '°', min: -90, max: 90, step: 0.5, range: (l) => l.estimate?.elevation ?? null, digits: 0 },
  { field: 'distanceM', label: 'Distance', unit: 'm', min: 0.1, max: 30, step: 0.05, range: (l) => l.estimate?.distance ?? null, digits: 1 },
  { field: 'intensityStops', label: 'Intensity', unit: 'stops', min: -10, max: 4, step: 0.05, range: (l) => l.estimate?.intensity ?? null, digits: 1 },
  { field: 'sizeDeg', label: 'Size', unit: '°', min: 0, max: 120, step: 0.5, range: (l) => l.estimate?.size ?? null, digits: 1 },
  { field: 'temperatureK', label: 'Temperature', unit: 'K', min: 1800, max: 12000, step: 50, range: (l) => l.estimate?.temperature ?? null, digits: 0 },
];

function FieldRow({ ctl, l, spec }: { ctl: LightingController; l: RigLight; spec: (typeof FIELD_SPEC)[number] }) {
  const value = l.spec[spec.field] as number | null;
  const [draft, setDraft] = useState(value ?? spec.min);
  useEffect(() => setDraft(value ?? spec.min), [value, spec.min]);
  const isLocked = l.locked.includes(spec.field);
  const range = spec.range(l);
  const disabled = !ctl.canChange || l.removed || (spec.field === 'distanceM' && (l.spec.type === 'directional' || l.spec.type === 'dome'));
  const commit = (v: number) => {
    if (v === value) return;
    const change: LightFields = { [spec.field]: v } as LightFields;
    if (spec.field === 'temperatureK') change.rgb = kelvinRgb(v);
    ctl.actions.setLight(l.id, change);
  };
  const unitText = spec.unit === '°' ? '°' : ` ${spec.unit}`;
  return (
    <div className={`lt-field${isLocked ? ' locked' : ''}`}>
      <div className="lt-field-head">
        <span className="key-slider-label">{spec.label}</span>
        <span className="lt-field-value mono">{value === null ? (spec.field === 'distanceM' ? 'infinite' : '—') : `${fmt(draft, spec.digits === 0 ? 1 : 2)}${unitText}`}</span>
        {l.origin === 'estimate' ? (
          <button type="button" className={`lt-lock${isLocked ? ' on' : ''}`} aria-pressed={isLocked} aria-label={`${isLocked ? 'Unlock' : 'Lock'} ${spec.label.toLowerCase()}`} disabled={!ctl.canChange || l.removed || value === null} onClick={() => ctl.actions.lock(l.id, [spec.field], !isLocked)} title={isLocked ? 'Yours: kept through a new analysis. Click to follow the estimate again.' : 'Following the estimate. Click to keep this value through a new analysis.'}>
            {isLocked ? 'Locked' : 'Lock'}
          </button>
        ) : null}
      </div>
      {value !== null ? (
        <input type="range" aria-label={spec.label} min={spec.min} max={spec.max} step={spec.step} value={Math.max(spec.min, Math.min(spec.max, draft))} disabled={disabled} onChange={(e) => setDraft(Number(e.target.value))} onPointerUp={() => commit(draft)} onKeyUp={() => commit(draft)} onBlur={() => commit(draft)} />
      ) : null}
      {range ? (
        <span className="lt-range muted">
          estimate {rangeText(range, unitText, spec.digits)}
          {isLocked ? ' · yours used' : ''}
        </span>
      ) : null}
    </div>
  );
}

function LightEditor({ ctl }: { ctl: LightingController }) {
  const l = ctl.light;
  if (!l) return <p className="muted key-note">No light selected.</p>;
  const s = l.spec;
  const swatch = `rgb(${s.rgb.map((c) => Math.round(255 * Math.pow(Math.min(1, c), 1 / 2.2))).join(',')})`;
  const disabled = !ctl.canChange || l.removed;
  return (
    <section className="info-section lt-editor" aria-label={`Light ${s.name}`}>
      <h4>
        <span className="lt-swatch" style={{ background: swatch }} aria-hidden="true" /> {s.name}
        <span className="muted lt-origin"> · {l.origin === 'artist' ? (l.from?.startsWith('ai:') ? 'from an AI suggestion' : l.from === 'kept' ? 'kept from an earlier analysis' : 'yours') : `estimated · confidence ${Math.round((l.estimate?.confidence ?? 0) * 100)} %`}</span>
      </h4>
      <div className="key-row tex-fields">
        <label className="key-field">
          <span>Role</span>
          <select className="tex-select" aria-label="Role" value={s.role} disabled={disabled} onChange={(e) => ctl.actions.setLight(l.id, { role: e.target.value as LightSpec['role'] })}>
            {LIGHT_ROLES.map((r) => (
              <option key={r} value={r}>
                {LIGHT_ROLE_LABELS[r]}
              </option>
            ))}
          </select>
        </label>
        <label className="key-field">
          <span>Type</span>
          <select className="tex-select" aria-label="Type" value={s.type} disabled={disabled} onChange={(e) => ctl.actions.setLight(l.id, { type: e.target.value as LightSpec['type'] })}>
            {LIGHT_TYPES.map((t) => (
              <option key={t} value={t}>
                {LIGHT_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </label>
      </div>
      {s.type !== 'dome' ? FIELD_SPEC.map((f) => <FieldRow key={f.field} ctl={ctl} l={l} spec={f} />) : FIELD_SPEC.filter((f) => f.field === 'intensityStops' || f.field === 'temperatureK').map((f) => <FieldRow key={f.field} ctl={ctl} l={l} spec={f} />)}
      {l.estimate ? (
        <>
          <p className="info-line">{l.estimate.motivation}</p>
          <p className="muted lt-evidence">From: {l.estimate.evidence.join(', ').replace(/_/g, ' ')}</p>
        </>
      ) : null}
    </section>
  );
}

function AiReviewPanel({ ctl }: { ctl: LightingController }) {
  const [note, setNote] = useState('');
  const ai = ctl.session?.ai;
  const reviews = ctl.doc?.reviews ?? [];
  return (
    <section className="info-section lt-ai" aria-label="AI review">
      <h4>Ask AI to review</h4>
      <p className="muted key-note">A second opinion on motivated sources and practicals, from one downscaled frame and the estimate. Suggestions only: you accept or reject each; the analysis works without it.</p>
      <div className="key-row">
        <input className="lt-ai-note" aria-label="Note for the AI review" placeholder="Optional: what to look at" value={note} disabled={!ai?.available || !ctl.canChange} onChange={(e) => setNote(e.target.value)} />
        <button type="button" disabled={!ai?.available || !ctl.canChange || ctl.busy || !ctl.doc?.analysis} title={ai?.reason ?? (!ctl.doc?.analysis ? 'Analyse first' : undefined)} onClick={() => ctl.actions.aiReview(note)}>
          Ask AI
        </button>
      </div>
      {!ai?.available && ai?.reason ? <p className="muted key-note">{ai.reason}</p> : null}
      {reviews
        .slice()
        .reverse()
        .slice(0, 3)
        .map((r) => (
          <div key={r.id} className="lt-review">
            <p className="info-line">
              <strong>{r.model}</strong> · {r.summary}
            </p>
            <ul className="lt-suggestions">
              {r.suggestions.map((s) => (
                <li key={s.id} className={`lt-suggestion ${s.decision}`}>
                  <span>
                    {s.kind === 'add' ? `Add ${s.light?.name ?? 'a light'}` : s.kind === 'remove' ? `Remove ${s.lightId}` : s.kind === 'adjust' ? `${s.lightId}: ${Object.entries(s.change ?? {}).filter(([k]) => k !== 'rgb').map(([k, v]) => lightFieldText(k as LightField, v)).join(', ')}` : 'Note'} — {s.reason}
                  </span>
                  {s.decision === 'pending' ? (
                    <span className="lt-decide">
                      <button type="button" className="small" disabled={!ctl.canChange} onClick={() => ctl.actions.decide(r.id, s.id, 'accepted')}>
                        Accept
                      </button>
                      <button type="button" className="small" disabled={!ctl.canChange} onClick={() => ctl.actions.decide(r.id, s.id, 'rejected')}>
                        Reject
                      </button>
                    </span>
                  ) : (
                    <span className="muted"> · {s.decision}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
    </section>
  );
}

export function LightingInfo({ ctl }: { ctl: LightingController }) {
  const { summary, task, version, doc } = ctl;
  const key = summary.key;
  const f = summary.focal;
  return (
    <div className="key-info lt-info">
      <div className="stats">
        <Big label="Lights found" value={summary.analysed ? `${summary.estimated}` : summary.lights ? `${summary.lights}` : '—'} unit={summary.added ? ` + ${summary.added}` : undefined} tone={summary.analysed ? (summary.current ? 'ok' : 'warn') : undefined} title={summary.current ? undefined : summary.analysed ? 'Settings changed since the analysis' : undefined} />
        <Big label="Key confidence" value={summary.keyConfidence !== null ? Math.round(summary.keyConfidence * 100) : '—'} unit={summary.keyConfidence !== null ? '%' : undefined} tone={summary.keyConfidence !== null ? (summary.keyConfidence >= LIGHTING_LOW_CONFIDENCE ? 'ok' : 'warn') : undefined} title={key ? `Key azimuth ${rangeText(key.azimuth, '°')}, elevation ${rangeText(key.elevation, '°')}` : undefined} />
        <Big label="Focal estimate" value={f ? `${fmt(f.low, 0)}–${fmt(f.high, 0)}` : '—'} unit={f ? ' mm' : undefined} title={f ? `${fmt(f.value, 1)} mm from ${summary.focalSource}` : undefined} />
        <Big label="Match" value={ctl.frameView?.match !== null && ctl.frameView?.match !== undefined ? Math.round(ctl.frameView.match * 100) : summary.matchScore !== null ? Math.round(summary.matchScore * 100) : '—'} unit={summary.matchScore !== null || ctl.frameView?.match ? '%' : undefined} tone={summary.matchScore !== null ? ((ctl.frameView?.match ?? summary.matchScore) >= LIGHTING_LOW_MATCH ? 'ok' : 'warn') : undefined} title="How well the rig as it is explains the subject’s shading" />
      </div>
      {key ? (
        <p className="info-line lt-keyline">
          Key from {rangeText(key.azimuth, '°')} azimuth, {rangeText(key.elevation, '°')} elevation.
        </p>
      ) : null}
      <LightEditor ctl={ctl} />
      <AiReviewPanel ctl={ctl} />
      <section className="info-section">
        <h4>Version</h4>
        <dl className="key-kv">
          <dt>Light rig</dt>
          <dd>
            {versionTag(version)} · {task ? TASK_STATE_LABELS[task.state] : 'no task'}
            {task?.approval ? ` · approved by ${task.approval.by}` : ''}
          </dd>
          <dt>Exported</dt>
          <dd>{ctl.exported ? `${ctl.exported.lights} lights · ${ctl.exported.formats.join(', ')}` : 'not yet'}</dd>
          <dt>Revisions</dt>
          <dd>
            settings r{doc?.revision ?? 0} · rig r{doc?.editRevision ?? 0}
          </dd>
        </dl>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The steps as a list (for tests and a standalone workspace)
// ---------------------------------------------------------------------------

export function LightingWorkspace(props: LightingWorkspaceProps) {
  const ctl = useLightingController(props);
  const steps = lightingStepDefs(ctl);
  const [open, setOpen] = useState<Set<string>>(() => new Set(steps.map((s) => s.id)));
  if (!ctl.supported) return <div className="key-missing">The lighting analysis is not available in this build.</div>;
  const current = steps.find((s) => !s.done && !s.optional)?.id ?? null;
  return (
    <div className="key-workspace">
      <aside className="key-zone key-zone-steps" aria-label="Steps">
        <ol className="steps key-steps" aria-label="Lighting steps">
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
        <LightingViewer ctl={ctl} />
      </section>
      <aside className="key-zone key-zone-info" aria-label="Details">
        <LightingInfo ctl={ctl} />
      </aside>
    </div>
  );
}
