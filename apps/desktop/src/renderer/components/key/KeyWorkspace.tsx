import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { AspectTag, FrameBox, overlayAspect, useShotAspect, useStageSize } from '../FrameBox';
import { clientToImage } from '../../frame-fit';
import {
  DEFAULT_KEY_PARAMS,
  KEY_LOW_CONFIDENCE,
  TASK_STATE_LABELS,
  addKeyLink,
  addScreenSample,
  backgroundReferences,
  clearScreenSamples,
  flagKeyFrame,
  keyConfidenceSummary,
  keyLocked,
  keyRepairPart,
  keyReview,
  keyTaskVersion,
  markKeyFrameReviewed,
  nextKeyProblem,
  recordBgMatch,
  recordKeyExport,
  recordKeyRun,
  removeKeyLink,
  resetKeyParams,
  serializeProject,
  setDespill,
  setKeyBackground,
  setKeyParams,
  setKeyScreen,
  setLightWrap,
  setMatchPreview,
  setScreenKind,
  shotState,
  startKeyRepair,
  updateKeyLink,
  versionTag,
  type DespillSettings,
  type KeyBackground,
  type KeyDocument,
  type KeyLink,
  type KeyParams,
  type KeyRect,
  type LightWrapSettings,
  type Project,
  type Result,
  type ScreenKind,
} from '@vcvfx/domain';
import type { VcvfxApi } from '../../../shared/bridge';
import type { KeyExportOptions, KeyFrameView, KeySessionInfo } from '../../../shared/key/bridge-types';
import { toDisplay, workingSpace } from '../../../shared/key/linear';
import { components } from '../../../shared/roto/image';
import './key.css';

/**
 * The Key workspace (master spec §6, §7; addendum 09): pick the screen, key,
 * add garbage/holdout mattes, repair with roto where the key fails, despill
 * against the background, preview light wrap and a suggested match, process
 * the shot and review its problem frames, export a versioned key.
 *
 * Built for the three-zone module screen (addendum 08): `useKeyController`
 * holds the state and actions; `KeySteps` (left), `KeyViewer` (centre) and
 * `KeyInfo` (right) draw from it, so a shell places them in its own zones.
 * `KeyWorkspace` puts the three together on its own.
 *
 * The review key is computed by main (or, in the browser preview, in the
 * page) with the project's current settings; every change of a setting is a
 * logged domain mutation, applied through `onKey`. Nothing here approves.
 */

export type KeyMutation = (p: Project, actor: string, now: Date) => Result;

export interface KeyWorkspaceProps {
  api: VcvfxApi;
  project: Project;
  shotId: string;
  projectKey: string;
  canEdit: boolean;
  busy: boolean;
  actor: string;
  /** The shared current frame (delivered numbering). */
  frame: number;
  onFrame(frame: number): void;
  /** Apply a domain mutation; false when it was refused (the shell shows why). */
  onKey(fn: KeyMutation): boolean;
  runJob<T>(label: string, fn: (jobId: string) => Promise<T>): Promise<T>;
  notify(kind: 'ok' | 'error' | 'info', text: string): void;
  onAddKeyTask(): void;
  /** Open the Roto tab on a part and frame (Repair with roto). */
  onOpenRoto?(partId: string, frame: number): void;
  /** The key task's state, approval and log, for the right panel. */
  taskInfo?: ReactNode;
}

export const KEY_MODES = ['source', 'alpha', 'premult', 'over', 'edge', 'mattes', 'problems'] as const;
export type KeyMode = (typeof KEY_MODES)[number];
export const KEY_MODE_LABELS: Record<KeyMode, string> = {
  source: 'Source',
  alpha: 'Alpha',
  premult: 'Premultiplied',
  over: 'Over background',
  edge: 'Edge',
  mattes: 'Core / edge / garbage',
  problems: 'Problem frames',
};
export type KeyTool = 'eyedropper' | 'protect' | 'garbage' | 'holdout' | 'repair-box' | null;

const unwrap = <T,>(r: { ok: true; data: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(r.error);
  return r.data;
};

/** Confidence as a colour, as roto shows it. */
export function keyConfidenceColour(c: number): string {
  const t = Math.max(0, Math.min(1, c));
  const hue = t < KEY_LOW_CONFIDENCE ? (t / KEY_LOW_CONFIDENCE) * 38 : 38 + ((t - KEY_LOW_CONFIDENCE) / (1 - KEY_LOW_CONFIDENCE)) * 92;
  return `hsl(${hue.toFixed(0)} 70% ${t < KEY_LOW_CONFIDENCE ? 52 : 46}%)`;
}

/** A linear colour as CSS, through the viewer's display transform. */
export function swatchCss(rgb: readonly number[] | null | undefined, linear = true): string {
  if (!rgb) return 'transparent';
  const d = toDisplay(Float32Array.from(rgb), 1, linear ? workingSpace('acescg') : workingSpace(null));
  return `rgb(${d[0]}, ${d[1]}, ${d[2]})`;
}

// ---------------------------------------------------------------------------
// The controller
// ---------------------------------------------------------------------------

export function useKeyController(props: KeyWorkspaceProps) {
  const { api, project, shotId, projectKey, canEdit, actor, frame, onFrame, onKey, runJob, notify } = props;
  const state = shotState(project, shotId);
  const doc: KeyDocument | null = state?.key ?? null;
  const hasTask = Boolean(state?.tasks.some((t) => t.kind === 'key'));
  const keyTask = state?.tasks.find((t) => t.kind === 'key') ?? null;
  const despillTask = state?.tasks.find((t) => t.kind === 'despill') ?? null;
  const locked = state ? keyLocked(state) : 'No shot';
  const version = state ? keyTaskVersion(state) : 1;
  const text = useMemo(() => serializeProject(project), [project]);
  const textRef = useRef(text);
  textRef.current = text;
  const supported = Boolean(api.keySession && api.keyFrame);

  const [session, setSession] = useState<KeySessionInfo | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [view, setView] = useState<KeyFrameView | null>(null);
  const [viewError, setViewError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [mode, setModeState] = useState<KeyMode>('source');
  const [wipe, setWipe] = useState<{ on: boolean; x: number }>({ on: false, x: 0.5 });
  const [tool, setTool] = useState<KeyTool>(null);
  const [exportOptions, setExportOptions] = useState<KeyExportOptions>({ foreground: true, core: false, edge: false, alphaExr: false });
  const [working, setWorking] = useState<string | null>(null);

  const first = session?.first ?? frame;
  const last = session?.last ?? frame;
  const plate = session?.plate ?? null;
  const canChange = canEdit && !locked && Boolean(session?.available);
  const references = useMemo(() => backgroundReferences(project, shotId), [project, shotId]);

  // The session: when the shot, its plates or the background change.
  const sessionKey = JSON.stringify([shotId, projectKey, hasTask, doc?.despill.background ?? null, doc?.workingWidth ?? null, state?.plates.length ?? 0]);
  useEffect(() => {
    if (!api.keySession) return;
    let live = true;
    setSessionError(null);
    void api.keySession({ text: textRef.current, shotId, projectKey }).then((r) => {
      if (!live) return;
      if (r.ok) setSession(r.data);
      else setSessionError(r.error);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, sessionKey]);

  // The review key of the current frame: whenever the settings (or the roto mattes they use) change.
  const keyDeps = JSON.stringify([doc ? { s: doc.screen, p: doc.params, l: doc.links, d: doc.despill, w: doc.lightWrap, m: doc.match } : null, state?.roto?.parts.map((p) => [p.id, p.frames.length]) ?? null]);
  const request = useRef(0);
  useEffect(() => {
    if (!api.keyFrame || !session?.available || !doc?.screen) {
      setView(null);
      return;
    }
    const id = ++request.current;
    setLoading(true);
    const timer = setTimeout(() => {
      void api.keyFrame!({ text: textRef.current, shotId, projectKey, frame, maxWidth: 960, wrap: doc.lightWrap.preview, match: doc.match.preview }).then((r) => {
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
  }, [api, session?.available, keyDeps, frame, shotId]);

  const apply = useCallback((fn: KeyMutation) => onKey(fn), [onKey]);
  const now = () => new Date();
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

  const review = useMemo(() => keyReview(doc, first, last), [doc, first, last]);
  const summary = useMemo(() => keyConfidenceSummary(doc), [doc]);
  const record = doc?.frames.find((f) => f.frame === frame) ?? null;
  const processed = Boolean(doc && doc.runs.length && doc.runs[doc.runs.length - 1]!.revision === doc.revision && doc.frames.length >= last - first + 1);
  const exported = doc?.exports.find((e) => e.version === version) ?? null;
  const exportCurrent = Boolean(exported && exported.revision === doc?.revision);

  const setMode = (m: KeyMode) => setModeState(m);

  const actions = {
    /** Auto key: detect the screen, use the handoff's background plate when there is one, and show the result. */
    autoKey: () =>
      guard('Detecting the screen…', async () => {
        if (!api.keyDetect) throw new Error('Keying is not available here.');
        const d = await runJob('Detecting the screen colour', async (jobId) => unwrap(await api.keyDetect!({ jobId, text: textRef.current, shotId, projectKey, kind: null })));
        if (!apply((p, a, t) => setKeyScreen(p, shotId, { kind: d.kind, source: 'auto', rgb: d.rgb, coverage: d.coverage, frames: d.frames }, a, t))) return;
        const bgKind = shotState(project, shotId)?.key?.despill.background.kind ?? 'none';
        if (bgKind === 'none' && references[0]) apply((p, a, t) => setKeyBackground(p, shotId, { kind: 'reference', path: references[0]!, frame: null, label: '' }, a, t));
        setModeState(references[0] || bgKind !== 'none' ? 'over' : 'premult');
        notify('ok', `${d.kind === 'green' ? 'Green' : 'Blue'} screen found on ${(d.coverage * 100).toFixed(0)} % of the frame.`);
      }),
    setKind: (kind: ScreenKind) => apply((p, a, t) => setScreenKind(p, shotId, { kind }, a, t)),
    setTrack: (track: boolean) => apply((p, a, t) => setScreenKind(p, shotId, { track }, a, t)),
    clearSamples: () => apply((p, a, t) => clearScreenSamples(p, shotId, a, t)),
    /** A click with the eyedropper (screen) or the protect picker (despill), in plate pixels. */
    pick: (x: number, y: number) =>
      guard('Sampling…', async () => {
        if (!api.keySample || !plate) return;
        const radius = Math.max(2, Math.round(plate.width / 400));
        const { rgb } = unwrap(await api.keySample({ text: textRef.current, shotId, projectKey, frame, x, y, radius }));
        if (tool === 'protect') {
          const protect = [...(doc?.despill.protect ?? []), { label: `sampled on ${frame}`, rgb, hueTolerance: 12 }];
          apply((p, a, t) => setDespill(p, shotId, { protect }, a, t));
        } else apply((p, a, t) => addScreenSample(p, shotId, { frame, x, y, radius, rgb }, a, t));
      }),
    params: (change: Partial<KeyParams>) => apply((p, a, t) => setKeyParams(p, shotId, change, a, t)),
    resetParams: () => apply((p, a, t) => resetKeyParams(p, shotId, a, t)),
    addBox: (kind: KeyLink['kind'], rect: KeyRect) => apply((p, a, t) => addKeyLink(p, shotId, { kind, source: { type: 'rect', rect }, mode: kind === 'repair' ? 'min' : 'replace' }, a, t)),
    addRotoLink: (kind: KeyLink['kind'], partId: string) => apply((p, a, t) => addKeyLink(p, shotId, { kind, source: { type: 'roto', partId }, mode: 'replace' }, a, t)),
    updateLink: (id: string, change: Partial<Omit<KeyLink, 'id'>>) => apply((p, a, t) => updateKeyLink(p, shotId, id, change, a, t)),
    removeLink: (id: string) => apply((p, a, t) => removeKeyLink(p, shotId, id, a, t)),
    /** Repair with roto: a roto part seeded from this frame's key, linked as a repair. */
    repairHere: () =>
      guard('Making a roto repair…', async () => {
        if (!api.keySeedRoto) throw new Error('Repair with roto is not available here.');
        const { partId, name } = keyRepairPart(project, shotId);
        const seeded = unwrap(await api.keySeedRoto({ text: textRef.current, shotId, projectKey, partId, frame }));
        if (apply((p, a, t) => startKeyRepair(p, shotId, { partId, name, frame, confidence: seeded.confidence }, a, t))) {
          notify('ok', `${name} made from the key on frame ${frame}. Paint the corrections in Roto, then propagate them over the problem frames.`);
        }
      }),
    despill: (change: Partial<DespillSettings>) => apply((p, a, t) => setDespill(p, shotId, change, a, t)),
    background: (bg: KeyBackground) => apply((p, a, t) => setKeyBackground(p, shotId, bg, a, t)),
    chooseBackgroundFile: () =>
      guard('Choosing a background…', async () => {
        if (!api.keyChooseBackground) return;
        const path = unwrap(await api.keyChooseBackground());
        if (path) apply((p, a, t) => setKeyBackground(p, shotId, { kind: 'file', path, frame: null, label: '' }, a, t));
      }),
    lightWrap: (change: Partial<LightWrapSettings>) => apply((p, a, t) => setLightWrap(p, shotId, change, a, t)),
    suggestMatch: () =>
      guard('Estimating a match…', async () => {
        if (!api.keyMatch) return;
        const m = unwrap(await api.keyMatch({ text: textRef.current, shotId, projectKey, frame }));
        apply((p, a, t) => recordBgMatch(p, shotId, m, a, t));
      }),
    matchPreview: (change: { preview?: boolean; strength?: number }) => apply((p, a, t) => setMatchPreview(p, shotId, change, a, t)),
    process: () =>
      guard('Processing…', async () => {
        if (!api.keyProcess) throw new Error('Processing is not available here.');
        const { result } = await runJob(`Keying ${state?.vfxShotId ?? shotId}`, async (jobId) => unwrap(await api.keyProcess!({ jobId, text: textRef.current, shotId, projectKey })));
        if (apply((p, a, t) => recordKeyRun(p, shotId, result, a, t))) {
          notify('ok', `${result.frames.length} frames keyed. Look at the problem frames, then export.`);
          setModeState('problems');
        }
      }),
    nextProblem: () => {
      const next = nextKeyProblem(review, frame);
      if (next !== null) onFrame(next);
    },
    flag: (note: string) => apply((p, a, t) => flagKeyFrame(p, shotId, frame, note, a, t)),
    markReviewed: () => apply((p, a, t) => markKeyFrameReviewed(p, shotId, frame, a, t)),
    exportKey: () =>
      guard('Exporting…', async () => {
        if (!api.keyExport) throw new Error('Exporting is not available here.');
        const out = await runJob(`Exporting the key of ${state?.vfxShotId ?? shotId}`, async (jobId) => unwrap(await api.keyExport!({ jobId, text: textRef.current, shotId, projectKey, operator: actor, options: exportOptions })));
        if (apply((p, a, t) => recordKeyExport(p, shotId, out.record, a, t))) notify('ok', `Key ${versionTag(out.record.version)} written: ${out.files} files in ${out.folder}`);
      }),
  };

  return {
    props,
    state,
    doc,
    hasTask,
    keyTask,
    despillTask,
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
    exportOptions,
    setExportOptions,
    working,
    first,
    last,
    plate,
    canChange,
    canEdit,
    busy: props.busy || working !== null,
    references,
    review,
    summary,
    record,
    processed,
    exported,
    exportCurrent,
    frame,
    onFrame,
    actions,
    now,
  };
}
export type KeyController = ReturnType<typeof useKeyController>;

// ---------------------------------------------------------------------------
// Small controls
// ---------------------------------------------------------------------------

function Slider({ label, value, min, max, step, unit, disabled, hint, onCommit }: { label: string; value: number; min: number; max: number; step: number; unit?: string; disabled: boolean; hint?: string; onCommit(v: number): void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => draft !== value && onCommit(draft);
  return (
    <label className="key-slider" title={hint}>
      <span className="key-slider-label">{label}</span>
      <input type="range" aria-label={label} min={min} max={max} step={step} value={draft} disabled={disabled} onChange={(e) => setDraft(Number(e.target.value))} onPointerUp={commit} onKeyUp={commit} onBlur={commit} />
      <span className="key-slider-value mono">
        {Number.isInteger(step) ? draft : draft.toFixed(step < 0.01 ? 3 : 2)}
        {unit ?? ''}
      </span>
    </label>
  );
}

function Seg<T extends string>({ value, options, onChange, disabled, label }: { value: T; options: readonly (readonly [T, string])[]; onChange(v: T): void; disabled?: boolean; label: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map(([v, l]) => (
        <button key={v} type="button" className={v === value ? 'on' : undefined} aria-pressed={v === value} disabled={disabled} onClick={() => onChange(v)}>
          {l}
        </button>
      ))}
    </div>
  );
}

function Check({ label, checked, disabled, onChange, hint }: { label: string; checked: boolean; disabled?: boolean; onChange(v: boolean): void; hint?: string }) {
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

export interface KeyStepDef {
  id: string;
  title: string;
  hint?: string;
  done: boolean;
  optional?: boolean;
  waiting?: string | null;
  content: ReactNode;
}

const linkName = (l: KeyLink, ctl: KeyController) =>
  l.label ||
  (l.source.type === 'roto' ? `Roto: ${ctl.state?.roto?.parts.find((p) => p.id === (l.source as { partId: string }).partId)?.name ?? (l.source as { partId: string }).partId}` : `Box ${Math.round(l.source.rect.x0)},${Math.round(l.source.rect.y0)} – ${Math.round(l.source.rect.x1)},${Math.round(l.source.rect.y1)}`);

function LinkList({ ctl, kinds }: { ctl: KeyController; kinds: KeyLink['kind'][] }) {
  const links = (ctl.doc?.links ?? []).filter((l) => kinds.includes(l.kind));
  if (!links.length) return <p className="muted key-note">None yet.</p>;
  return (
    <ul className="key-links">
      {links.map((l) => (
        <li key={l.id} className={`key-link key-link-${l.kind}${l.enabled ? '' : ' off'}`}>
          <span className={`key-link-dot ${l.kind}`} aria-hidden="true" />
          <span className="key-link-name" title={l.id}>
            <strong>{l.kind === 'garbage' ? 'Garbage' : l.kind === 'holdout' ? 'Holdout' : 'Repair'}</strong> {linkName(l, ctl)}
          </span>
          {l.kind === 'repair' ? (
            <select aria-label={`How ${l.id} repairs`} value={l.mode} disabled={!ctl.canChange} onChange={(e) => ctl.actions.updateLink(l.id, { mode: e.target.value as KeyLink['mode'] })}>
              <option value="replace">Replace</option>
              <option value="max">More solid</option>
              <option value="min">Less solid</option>
            </select>
          ) : (
            <Check label="Invert" checked={l.invert} disabled={!ctl.canChange} onChange={(v) => ctl.actions.updateLink(l.id, { invert: v })} />
          )}
          <Check label="On" checked={l.enabled} disabled={!ctl.canChange} onChange={(v) => ctl.actions.updateLink(l.id, { enabled: v })} />
          {l.kind === 'repair' && l.source.type === 'roto' && ctl.props.onOpenRoto ? (
            <button type="button" className="small" onClick={() => ctl.props.onOpenRoto!((l.source as { partId: string }).partId, ctl.frame)}>
              Paint in Roto
            </button>
          ) : null}
          <button type="button" className="small danger" aria-label={`Remove ${l.id}`} disabled={!ctl.canChange} onClick={() => ctl.actions.removeLink(l.id)}>
            ✕
          </button>
        </li>
      ))}
    </ul>
  );
}

function RotoLinkAdd({ ctl, kinds }: { ctl: KeyController; kinds: KeyLink['kind'][] }) {
  const parts = ctl.state?.roto?.parts.filter((p) => p.frames.length > 0) ?? [];
  const [partId, setPartId] = useState('');
  const [kind, setKind] = useState<KeyLink['kind']>(kinds[0]!);
  if (!parts.length) return <p className="muted key-note">No roto parts with mattes yet. Paint one in the Roto tab to use it here.</p>;
  return (
    <div className="key-row">
      <select aria-label="Roto part" value={partId} onChange={(e) => setPartId(e.target.value)} disabled={!ctl.canChange}>
        <option value="">Roto part…</option>
        {parts.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      {kinds.length > 1 ? (
        <select aria-label="Use as" value={kind} onChange={(e) => setKind(e.target.value as KeyLink['kind'])} disabled={!ctl.canChange}>
          {kinds.map((k) => (
            <option key={k} value={k}>
              as {k}
            </option>
          ))}
        </select>
      ) : null}
      <button type="button" disabled={!ctl.canChange || !partId} onClick={() => ctl.actions.addRotoLink(kind, partId)}>
        Add
      </button>
    </div>
  );
}

export function keyStepDefs(ctl: KeyController): KeyStepDef[] {
  const { doc, canChange, actions, tool, setTool, busy } = ctl;
  const screen = doc?.screen ?? null;
  const p = doc?.params ?? DEFAULT_KEY_PARAMS;
  const d = doc?.despill;
  const lw = doc?.lightWrap;
  const noScreen = screen ? null : 'Pick the screen first (step 1).';
  const bg = d?.background ?? { kind: 'none' as const, path: null, frame: null, label: '' };
  const toolButton = (t: Exclude<KeyTool, null>, label: string, title: string) => (
    <button type="button" className={tool === t ? 'on key-tool' : 'key-tool'} aria-pressed={tool === t} disabled={!canChange} title={title} onClick={() => setTool(tool === t ? null : t)}>
      {label}
    </button>
  );
  return [
    {
      id: 'screen',
      title: 'Pick the screen',
      hint: 'Auto key finds the green or blue screen and keys with good defaults, in one click.',
      done: Boolean(screen),
      content: (
        <>
          <div className="action">
            <button type="button" className="primary big" disabled={!canChange || busy} onClick={() => void actions.autoKey()}>
              {screen ? 'Auto key again' : 'Auto key'}
            </button>
          </div>
          <Seg label="Screen colour" value={screen?.kind ?? 'green'} options={[['green', 'Green screen'], ['blue', 'Blue screen']] as const} disabled={!canChange} onChange={(k) => actions.setKind(k)} />
          <div className="key-row">
            {toolButton('eyedropper', 'Eyedropper', 'Click the screen in the picture to sample it; each click adds a sample')}
            <button type="button" disabled={!canChange || screen?.source !== 'manual'} onClick={() => actions.clearSamples()}>
              Clear samples
            </button>
          </div>
          {screen ? (
            <div className="key-swatch-row">
              <span className="key-swatch" style={{ background: swatchCss(screen.rgb, ctl.session?.encoding.linear ?? true) }} aria-hidden="true" />
              <span className="mono small">
                {screen.source === 'auto' ? 'detected' : `${screen.samples.length} sample${screen.samples.length === 1 ? '' : 's'}`} · {screen.rgb.map((v) => v.toFixed(3)).join(' ')}
              </span>
            </div>
          ) : null}
          <Check label="Follow light changes frame to frame" checked={screen?.track ?? true} disabled={!canChange || !screen} onChange={(v) => actions.setTrack(v)} hint="A per-frame gain on the screen model (flicker, clouds)" />
        </>
      ),
    },
    {
      id: 'key',
      title: 'Key',
      hint: 'Clean up the background and solidify the subject. The defaults are a good start.',
      done: Boolean(screen && ctl.view),
      waiting: noScreen,
      content: (
        <>
          <Slider label="Screen clip (black)" value={p.clipBlack} min={0} max={0.3} step={0.005} disabled={!canChange} hint="Raw key at or below this is clean background" onCommit={(v) => actions.params({ clipBlack: v })} />
          <Slider label="Subject clip (white)" value={p.clipWhite} min={0.5} max={1} step={0.01} disabled={!canChange} hint="Raw key at or above this is solid" onCommit={(v) => actions.params({ clipWhite: v })} />
          <Slider label="Edge detail" value={p.edgeDetail} min={0} max={1} step={0.05} disabled={!canChange} hint="Hair, motion blur and see-through detail, solved from the foreground's colour" onCommit={(v) => actions.params({ edgeDetail: v })} />
          <Slider label="Core shrink" value={p.coreErodePx} min={0} max={40} step={1} unit=" px" disabled={!canChange} hint="How far inside the edge the solid core stops (plate pixels)" onCommit={(v) => actions.params({ coreErodePx: v })} />
          <details className="sub">
            <summary>More</summary>
            <Slider label="Core threshold" value={p.coreThreshold} min={0.2} max={0.99} step={0.01} disabled={!canChange} onCommit={(v) => actions.params({ coreThreshold: v })} />
            <Slider label="Edge softness" value={p.edgeSoftnessPx} min={0} max={16} step={0.5} unit=" px" disabled={!canChange} onCommit={(v) => actions.params({ edgeSoftnessPx: v })} />
            <Slider label="Gamma" value={p.gamma} min={0.4} max={2.5} step={0.05} disabled={!canChange} onCommit={(v) => actions.params({ gamma: v })} />
            <Slider label={screen?.kind === 'blue' ? 'Balance (red ↔ green)' : 'Balance (red ↔ blue)'} value={p.balance} min={0} max={1} step={0.05} disabled={!canChange} onCommit={(v) => actions.params({ balance: v })} />
            <Check label="Clean plate (uneven screen)" checked={p.cleanPlate} disabled={!canChange} onChange={(v) => actions.params({ cleanPlate: v })} hint="Key against a model of the screen alone, built from several frames" />
            <Check label="Screen detail (folds, shadows on the screen)" checked={p.screenDetail} disabled={!canChange} onChange={(v) => actions.params({ screenDetail: v })} hint="Follow the screen on each frame from its own screen pixels round the subject. Light shadows on the screen key out (a deep one stays); turn off to key against the model alone" />
            <button type="button" disabled={!canChange} onClick={() => actions.resetParams()}>
              Back to the defaults
            </button>
          </details>
        </>
      ),
    },
    {
      id: 'mattes',
      title: 'Garbage & holdout',
      hint: 'Garbage: everything outside is thrown away. Holdout: everything inside is kept solid.',
      done: (doc?.links ?? []).some((l) => l.kind !== 'repair'),
      optional: true,
      waiting: noScreen,
      content: (
        <>
          <div className="key-row">
            {toolButton('garbage', 'Draw garbage box', 'Drag a box around what to keep')}
            {toolButton('holdout', 'Draw holdout box', 'Drag a box over what must stay solid')}
          </div>
          <RotoLinkAdd ctl={ctl} kinds={['garbage', 'holdout']} />
          <LinkList ctl={ctl} kinds={['garbage', 'holdout']} />
        </>
      ),
    },
    {
      id: 'repair',
      title: 'Repair with roto',
      hint: 'Where the key fails (off the screen, a green prop, an occlusion), paint it right with roto.',
      done: (doc?.links ?? []).some((l) => l.kind === 'repair'),
      optional: true,
      waiting: noScreen,
      content: (
        <>
          <div className="action">
            <button type="button" className="big key-wrap" disabled={!canChange || busy || !bridgeOf(ctl).keySeedRoto} onClick={() => void actions.repairHere()} title="Makes a roto part from this frame's key; paint the corrections in Roto">
              Repair frame {ctl.frame} with roto
            </button>
          </div>
          <div className="key-row">{toolButton('repair-box', 'Cut out a box', 'Drag a box: everything inside becomes background')}</div>
          <RotoLinkAdd ctl={ctl} kinds={['repair']} />
          <LinkList ctl={ctl} kinds={['repair']} />
        </>
      ),
    },
    {
      id: 'despill',
      title: 'Despill',
      hint: 'Take the screen colour out of the subject — replaced with the background’s light, not grey.',
      done: Boolean(screen && d && (!d.enabled || d.restore !== 'background' || bg.kind !== 'none')),
      waiting: noScreen,
      content: d ? (
        <>
          <Check label="Despill the foreground" checked={d.enabled} disabled={!canChange} onChange={(v) => actions.despill({ enabled: v })} />
          <label className="key-field">
            <span>Background reference</span>
            <select
              aria-label="Background reference"
              value={bg.kind === 'reference' ? `ref:${bg.path}` : bg.kind === 'file' ? 'file' : bg.kind === 'frame' ? 'frame' : 'none'}
              disabled={!canChange}
              onChange={(e) => {
                const v = e.target.value;
                if (v === 'none') actions.background({ kind: 'none', path: null, frame: null, label: '' });
                else if (v === 'frame') actions.background({ kind: 'frame', path: null, frame: ctl.frame, label: '' });
                else if (v === 'choose') void actions.chooseBackgroundFile();
                else if (v.startsWith('ref:')) actions.background({ kind: 'reference', path: v.slice(4), frame: null, label: '' });
              }}
            >
              <option value="none">None (neutral despill)</option>
              {ctl.references.map((r) => (
                <option key={r} value={`ref:${r}`}>
                  {r.split('/').pop()} (from the handoff)
                </option>
              ))}
              {bg.kind === 'file' ? <option value="file">{bg.label}</option> : null}
              <option value="frame">{bg.kind === 'frame' ? `Frame ${bg.frame} of this shot` : `This frame (${ctl.frame}) of the shot`}</option>
              {ctl.session?.fileBackground ? <option value="choose">Choose a file…</option> : null}
            </select>
          </label>
          {ctl.session && !ctl.session.background.available && ctl.session.background.reason ? <p className="warn-text">{ctl.session.background.reason}</p> : null}
          <Seg
            label="Replace the spill with"
            value={d.restore}
            options={[['background', 'Background light'], ['neutral', 'Grey'], ['none', 'Nothing']] as const}
            disabled={!canChange || !d.enabled}
            onChange={(v) => actions.despill({ restore: v })}
          />
          <Slider label="Strength" value={d.strength} min={0} max={1} step={0.05} disabled={!canChange || !d.enabled} onCommit={(v) => actions.despill({ strength: v })} />
          <details className="sub">
            <summary>Limit and protected colours</summary>
            <label className="key-field">
              <span>Limit {ctl.doc?.screen?.kind === 'blue' ? 'blue' : 'green'} to</span>
              <select aria-label="Despill limit" value={d.limit} disabled={!canChange || !d.enabled} onChange={(e) => actions.despill({ limit: e.target.value as DespillSettings['limit'] })}>
                <option value="average">the average of the others (gentle)</option>
                <option value="max">the larger of the others (gentlest)</option>
                <option value="min">the smaller of the others (strong)</option>
                <option value="weighted">a weighted mix</option>
              </select>
            </label>
            <Check label="Protect skin tones" checked={d.protectSkin} disabled={!canChange || !d.enabled} onChange={(v) => actions.despill({ protectSkin: v })} />
            <div className="key-row">{toolButton('protect', 'Protect a colour', 'Click a colour in the picture that must not be despilled (a green prop)')}</div>
            {d.protect.length ? (
              <ul className="key-links">
                {d.protect.map((c, i) => (
                  <li key={i} className="key-link">
                    <span className="key-swatch small" style={{ background: swatchCss(c.rgb) }} aria-hidden="true" />
                    <span className="key-link-name">
                      {c.label || 'colour'} ±{c.hueTolerance}°
                    </span>
                    <button type="button" className="small danger" aria-label={`Stop protecting colour ${i + 1}`} disabled={!canChange} onClick={() => actions.despill({ protect: d.protect.filter((_, j) => j !== i) })}>
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </details>
        </>
      ) : null,
    },
    {
      id: 'look',
      title: 'Light wrap & match',
      hint: 'Preview only: they are never baked into the foreground.',
      done: Boolean(doc?.match.suggestion),
      optional: true,
      waiting: noScreen ?? (bg.kind === 'none' ? 'Choose a background reference in step 5 first.' : null),
      content: lw ? (
        <>
          <Check label="Show light wrap in the preview" checked={lw.preview} disabled={!canChange} onChange={(v) => actions.lightWrap({ preview: v })} />
          <Slider label="Wrap width" value={lw.widthPx} min={1} max={120} step={1} unit=" px" disabled={!canChange} onCommit={(v) => actions.lightWrap({ widthPx: v })} />
          <Slider label="Wrap intensity" value={lw.intensity} min={0} max={2} step={0.05} disabled={!canChange} onCommit={(v) => actions.lightWrap({ intensity: v })} />
          <Slider label="Bright areas wrap more" value={lw.lumaWeight} min={0} max={1} step={0.05} disabled={!canChange} onCommit={(v) => actions.lightWrap({ lumaWeight: v })} />
          <Check label="Also write a light-wrap layer on export" checked={lw.output} disabled={!canChange} onChange={(v) => actions.lightWrap({ output: v })} />
          <div className="action">
            <button type="button" className="key-wrap" disabled={!canChange || busy} onClick={() => void actions.suggestMatch()} title={`Estimated on frame ${ctl.frame}`}>
              Suggest a colour match
            </button>
          </div>
          {doc?.match.suggestion ? (
            <>
              <p className="mono small key-note">
                gain {doc.match.suggestion.gain.map((v) => v.toFixed(2)).join(' ')} · offset {doc.match.suggestion.offset.map((v) => v.toFixed(3)).join(' ')} · {doc.match.suggestion.exposureStops >= 0 ? '+' : ''}
                {doc.match.suggestion.exposureStops.toFixed(2)} stops
              </p>
              <Check label="Preview the match" checked={doc.match.preview} disabled={!canChange} onChange={(v) => actions.matchPreview({ preview: v })} />
              <Slider label="Match strength" value={doc.match.suggestion.strength} min={0} max={1} step={0.05} disabled={!canChange} onCommit={(v) => actions.matchPreview({ strength: v })} />
            </>
          ) : null}
        </>
      ) : null,
    },
    {
      id: 'process',
      title: 'Process shot & review',
      hint: 'Keys every frame and finds the frames most likely to need a look.',
      done: ctl.processed,
      waiting: noScreen,
      content: (
        <>
          <div className="action">
            <button type="button" className="primary big" disabled={!canChange || busy || !bridgeOf(ctl).keyProcess} onClick={() => void actions.process()}>
              {ctl.processed ? 'Process again' : `Process ${ctl.last - ctl.first + 1} frames`}
            </button>
          </div>
          {doc?.frames.length ? (
            <>
              <p className="key-note">
                {ctl.summary.frames} keyed · mean confidence {ctl.summary.mean.toFixed(2)} · {ctl.review.problems.length} to look at
                {!ctl.processed ? ' · settings changed since: process again' : ''}
              </p>
              <div className="key-row">
                <button type="button" disabled={!ctl.review.problems.length} onClick={() => actions.nextProblem()}>
                  Next problem ▸
                </button>
                <button type="button" disabled={!canChange || !ctl.record} onClick={() => actions.markReviewed()}>
                  Looks right
                </button>
                <button type="button" disabled={!canChange || !ctl.record} onClick={() => actions.flag(ctl.record?.status === 'flagged' ? '' : 'needs a look')}>
                  {ctl.record?.status === 'flagged' ? 'Unflag' : 'Flag'}
                </button>
              </div>
            </>
          ) : null}
        </>
      ),
    },
    {
      id: 'export',
      title: `Export key ${versionTag(ctl.version)}`,
      hint: 'Alpha, despilled foreground and the metadata, into 03_KEYS. Approve it in the shot’s tasks.',
      done: ctl.exportCurrent,
      waiting: !ctl.processed ? 'Process the shot first (step 7).' : null,
      content: (
        <>
          <Check label="Despilled foreground (EXR, premultiplied)" checked={ctl.exportOptions.foreground} onChange={(v) => ctl.setExportOptions({ ...ctl.exportOptions, foreground: v })} />
          <Check label="Alpha as EXR too" checked={ctl.exportOptions.alphaExr} onChange={(v) => ctl.setExportOptions({ ...ctl.exportOptions, alphaExr: v })} />
          <Check label="Core and edge mattes" checked={ctl.exportOptions.core} onChange={(v) => ctl.setExportOptions({ ...ctl.exportOptions, core: v, edge: v })} />
          <div className="action">
            <button type="button" className="primary big" disabled={!canChange || busy || !ctl.session?.exportable} title={ctl.session && !ctl.session.exportable ? 'Exporting is the desktop app’s' : undefined} onClick={() => void actions.exportKey()}>
              Export key {versionTag(ctl.version)}
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

const bridgeOf = (ctl: KeyController) => ctl.props.api;

/** The numbered steps, in the module screen's step style. */
export function KeySteps({ ctl }: { ctl: KeyController }) {
  const steps = keyStepDefs(ctl);
  const current = steps.find((s) => !s.done && !s.optional)?.id ?? null;
  const [open, setOpen] = useState<Set<string>>(() => new Set(current ? [current] : ['screen']));
  const [lastCurrent, setLastCurrent] = useState(current);
  if (current !== lastCurrent) {
    setLastCurrent(current);
    if (current) setOpen((o) => new Set([...o, current]));
  }
  if (!ctl.hasTask) return <p className="muted">This shot has no key task.</p>;
  return (
    <ol className="steps key-steps" aria-label="Key steps">
      {steps.map((s, i) => {
        const isOpen = open.has(s.id);
        const st = s.done ? 'done' : s.id === current ? 'current' : s.optional ? 'optional' : 'todo';
        return (
          <li key={s.id} className={`step step-${st}${isOpen ? ' open' : ''}`} data-step={s.id}>
            <button
              type="button"
              className="step-head"
              aria-expanded={isOpen}
              onClick={() =>
                setOpen((o) => {
                  const n = new Set(o);
                  if (n.has(s.id)) n.delete(s.id);
                  else n.add(s.id);
                  return n;
                })
              }
            >
              <span className="step-num" aria-hidden="true">
                {s.done ? '✓' : i + 1}
              </span>
              <span className="step-title">
                <span>
                  {s.title}
                  {s.optional ? <span className="step-tag">optional</span> : null}
                  {st === 'current' ? <span className="step-tag next">next</span> : null}
                </span>
                {s.hint ? <span className="step-hint">{s.hint}</span> : null}
              </span>
              <span className="sr-only">{s.done ? '(done)' : ''}</span>
            </button>
            {isOpen ? <div className="step-body">{s.waiting ? <p className="step-waiting">{s.waiting}</p> : s.content}</div> : null}
          </li>
        );
      })}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// The viewer (centre)
// ---------------------------------------------------------------------------

/** The RGBA picture of a review mode, at the view's size. */
export function composeMode(view: KeyFrameView, mode: KeyMode, wipe: { on: boolean; x: number }): Uint8ClampedArray<ArrayBuffer> {
  const { width: w, height: h } = view;
  const n = w * h;
  const out = new Uint8ClampedArray(n * 4);
  const src = view.source;
  const a = view.alpha;
  let holes: Uint8Array | null = null;
  if (mode === 'problems') {
    // Enclosed transparent regions (holes in the subject) in red.
    const low = Uint8Array.from(a, (v) => (v < 128 ? 1 : 0));
    const lab = components(low, w, h, 1);
    const touches = new Uint8Array(lab.sizes.length);
    for (let x = 0; x < w; x += 1) (touches[lab.labels[x]!] = 1), (touches[lab.labels[(h - 1) * w + x]!] = 1);
    for (let y = 0; y < h; y += 1) (touches[lab.labels[y * w]!] = 1), (touches[lab.labels[y * w + w - 1]!] = 1);
    holes = new Uint8Array(n);
    // Gaps of a few pixels (between hair strands) are left out.
    const minHole = Math.max(6, Math.round(n * 0.0002));
    for (let i = 0; i < n; i += 1) if (lab.labels[i] && !touches[lab.labels[i]!] && lab.sizes[lab.labels[i]!]! >= minHole) holes[i] = 1;
  }
  const split = wipe.on ? Math.round(wipe.x * w) : -1;
  for (let i = 0; i < n; i += 1) {
    const o = 4 * i;
    out[o + 3] = 255;
    const x = i % w;
    if (split >= 0 && x < split) {
      out[o] = src[3 * i]!;
      out[o + 1] = src[3 * i + 1]!;
      out[o + 2] = src[3 * i + 2]!;
      continue;
    }
    const av = a[i]!;
    let r = 0;
    let g = 0;
    let b = 0;
    switch (mode) {
      case 'source':
        r = src[3 * i]!;
        g = src[3 * i + 1]!;
        b = src[3 * i + 2]!;
        break;
      case 'alpha':
        r = g = b = av;
        break;
      case 'premult':
        r = view.premult[3 * i]!;
        g = view.premult[3 * i + 1]!;
        b = view.premult[3 * i + 2]!;
        break;
      case 'over': {
        const c = view.comp ?? view.premult;
        r = c[3 * i]!;
        g = c[3 * i + 1]!;
        b = c[3 * i + 2]!;
        break;
      }
      case 'edge': {
        const soft = av > 5 && av < 250 ? 1 - Math.abs(av / 127.5 - 1) : 0;
        const base = av * 0.3;
        r = base + soft * (255 - base);
        g = base + soft * (210 - base);
        b = base * (1 - soft) + soft * 40;
        break;
      }
      case 'mattes': {
        // The picture in dimmed grey, so the mattes' colours read (and a green screen is not mistaken for the core).
        r = g = b = (0.3 * src[3 * i]! + 0.59 * src[3 * i + 1]! + 0.11 * src[3 * i + 2]!) * 0.45;
        const tint = (cr: number, cg: number, cb: number, k: number) => {
          r += (cr - r) * k;
          g += (cg - g) * k;
          b += (cb - b) * k;
        };
        if (view.core[i]) tint(60, 200, 110, 0.45);
        else if (av > 5 && av < 250) tint(255, 210, 60, 0.6);
        if (view.garbage && view.garbage[i]! < 128) tint(220, 70, 60, 0.5);
        if (view.holdout && view.holdout[i]! > 128) tint(80, 150, 255, 0.45);
        if (view.repair && view.repair[i]! > 128) tint(200, 110, 255, 0.35);
        break;
      }
      case 'problems': {
        r = g = b = av * 0.85;
        if (holes![i]) {
          r = 240;
          g = 60;
          b = 50;
        }
        break;
      }
    }
    out[o] = r;
    out[o + 1] = g;
    out[o + 2] = b;
  }
  return out;
}

type Drag = { x0: number; y0: number; x1: number; y1: number } | null;

export function KeyViewer({ ctl }: { ctl: KeyController }) {
  const { view, mode, setMode, wipe, setWipe, tool, setTool, plate, first, last, frame, onFrame, doc, review } = ctl;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const stageSize = useStageSize(stageRef);
  const aspect = useShotAspect(ctl.props.project, ctl.props.shotId);
  const [drag, setDrag] = useState<Drag>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c || !view) return;
    c.width = view.width;
    c.height = view.height;
    const g = c.getContext('2d');
    if (!g) return;
    g.putImageData(new ImageData(composeMode(view, mode, wipe), view.width, view.height), 0, 0);
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
    if (tool === 'eyedropper' || tool === 'protect') {
      const p = toPlate(v);
      void ctl.actions.pick(p.x, p.y);
      return;
    }
    if (tool === 'garbage' || tool === 'holdout' || tool === 'repair-box') {
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
      setDrag({ x0: v.x, y0: v.y, x1: v.x, y1: v.y });
      return;
    }
    if (wipe.on && view) setWipe({ on: true, x: Math.max(0, Math.min(1, v.x / view.width)) });
  };
  const onMove = (e: ReactPointerEvent) => {
    const v = toView(e);
    setCursor(v);
    if (drag && v) setDrag({ ...drag, x1: v.x, y1: v.y });
    else if (wipe.on && view && v && e.buttons === 1 && !tool) setWipe({ on: true, x: Math.max(0, Math.min(1, v.x / view.width)) });
  };
  const onUp = () => {
    if (!drag) return;
    const a = toPlate({ x: Math.min(drag.x0, drag.x1), y: Math.min(drag.y0, drag.y1) });
    const b = toPlate({ x: Math.max(drag.x0, drag.x1), y: Math.max(drag.y0, drag.y1) });
    setDrag(null);
    if (b.x - a.x < 2 || b.y - a.y < 2) return;
    const kind = tool === 'garbage' ? 'garbage' : tool === 'holdout' ? 'holdout' : 'repair';
    ctl.actions.addBox(kind, { x0: Math.round(a.x), y0: Math.round(a.y), x1: Math.round(b.x), y1: Math.round(b.y) });
    setTool(null);
  };

  const k = plate && view ? view.width / plate.width : 1;
  const rects = (doc?.links ?? []).filter((l) => l.source.type === 'rect' && l.enabled);
  const confidence = useMemo(() => new Map((doc?.frames ?? []).map((f) => [f.frame, f])), [doc?.frames]);
  const problems = useMemo(() => new Set(review.problems.map((p) => p.frame)), [review.problems]);
  const count = Math.max(1, last - first + 1);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const scrub = (e: ReactPointerEvent) => {
    const el = timelineRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const t = Math.max(0, Math.min(1, (e.clientX - r.left) / Math.max(1, r.width)));
    onFrame(Math.round(first + t * (count - 1)));
  };

  const message = ctl.sessionError ?? (ctl.session && !ctl.session.available ? ctl.session.reason : null) ?? (!doc?.screen ? 'Press Auto key (step 1) to key this shot.' : null) ?? (view ? null : ctl.viewError);
  const cursorClass = tool === 'eyedropper' || tool === 'protect' ? 'tool-pick' : tool ? 'tool-box' : wipe.on ? 'tool-wipe' : '';

  return (
    <div className="key-viewer" aria-label={`Key viewer — ${ctl.state?.vfxShotId ?? ctl.props.shotId}`} role="region">
      <div className="key-viewer-bar">
        <div className="seg key-modes" role="tablist" aria-label="Review mode">
          {KEY_MODES.map((m) => (
            <button key={m} type="button" role="tab" aria-selected={mode === m} className={mode === m ? 'on' : undefined} onClick={() => setMode(m)} disabled={!view && m !== 'source'}>
              {KEY_MODE_LABELS[m]}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <button type="button" className={wipe.on ? 'on' : undefined} aria-pressed={wipe.on} onClick={() => setWipe({ ...wipe, on: !wipe.on })} title="A/B wipe: source on the left, this mode on the right; drag to move">
          A/B wipe
        </button>
        <button type="button" className={tool === 'eyedropper' ? 'on' : undefined} aria-pressed={tool === 'eyedropper'} disabled={!ctl.canChange} onClick={() => setTool(tool === 'eyedropper' ? null : 'eyedropper')} title="Sample the screen colour">
          Eyedropper
        </button>
      </div>
      <div ref={stageRef} className={`key-stage ${cursorClass}`} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={() => setCursor(null)}>
        <FrameBox stage={stageSize} size={view} pixelAspect={aspect.display}>
        {view ? <canvas ref={canvasRef} className="key-canvas" aria-label={`${KEY_MODE_LABELS[mode]} of frame ${view.frame}`} /> : null}
        {view ? (
          <svg className="key-overlay" viewBox={`0 0 ${view.width} ${view.height}`} preserveAspectRatio={overlayAspect(stageSize)} aria-hidden="true">
            {rects.map((l) => {
              const r = (l.source as { rect: KeyRect }).rect;
              return <rect key={l.id} className={`key-box ${l.kind}`} x={r.x0 * k} y={r.y0 * k} width={(r.x1 - r.x0) * k} height={(r.y1 - r.y0) * k} />;
            })}
            {drag ? <rect className={`key-box drawing ${tool}`} x={Math.min(drag.x0, drag.x1)} y={Math.min(drag.y0, drag.y1)} width={Math.abs(drag.x1 - drag.x0)} height={Math.abs(drag.y1 - drag.y0)} /> : null}
            {wipe.on ? <line className="key-wipe" x1={wipe.x * view.width} x2={wipe.x * view.width} y1={0} y2={view.height} /> : null}
            {cursor && (tool === 'eyedropper' || tool === 'protect') ? <ellipse className="key-picker" cx={cursor.x} cy={cursor.y} rx={Math.max(3, view.width / 160) / aspect.display} ry={Math.max(3, view.width / 160)} /> : null}
            {(doc?.screen?.samples ?? []).filter((s) => s.frame === frame).map((s, i) => <ellipse key={i} className="key-sample" cx={s.x * k} cy={s.y * k} rx={Math.max(2.5, view.width / 220) / aspect.display} ry={Math.max(2.5, view.width / 220)} />)}
          </svg>
        ) : null}
        </FrameBox>
        {view ? <AspectTag aspect={aspect} /> : null}
        {message ? <div className="key-message">{message}</div> : null}
        {ctl.loading && view ? <div className="key-busy" aria-live="polite">Keying…</div> : null}
        {mode === 'over' && view && !view.comp ? <div className="key-hint">No background reference yet: shown over the checker. Choose one in step 5.</div> : null}
        {mode === 'problems' && review.problems.length ? (
          <ol className="key-problems" aria-label="Problem frames">
            {review.problems.slice(0, 12).map((p) => (
              <li key={p.frame}>
                <button type="button" className={p.frame === frame ? 'on' : undefined} onClick={() => onFrame(p.frame)}>
                  <span className="mono">{p.frame}</span> <span>{p.reason}</span>
                </button>
              </li>
            ))}
          </ol>
        ) : null}
      </div>
      <div className="key-timeline-row">
        <button type="button" aria-label="Previous frame" onClick={() => onFrame(Math.max(first, frame - 1))}>
          ◀
        </button>
        <div
          ref={timelineRef}
          className="key-timeline"
          role="slider"
          aria-label="Frame"
          aria-valuemin={first}
          aria-valuemax={last}
          aria-valuenow={frame}
          tabIndex={0}
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
            const rec = confidence.get(f);
            return <span key={i} className={`key-tick${problems.has(f) ? ' problem' : ''}`} style={{ background: rec ? keyConfidenceColour(rec.confidence) : undefined }} />;
          })}
          <span className="key-playhead" style={{ left: `${((frame - first) / Math.max(1, count - 1)) * 100}%` }} />
        </div>
        <button type="button" aria-label="Next frame" onClick={() => onFrame(Math.min(last, frame + 1))}>
          ▶
        </button>
        <span className="key-frame mono">{frame}</span>
        <button type="button" disabled={!review.problems.length} onClick={() => ctl.actions.nextProblem()} title="Jump to the next frame most likely to need a look">
          Next problem ▸
        </button>
      </div>
      {view ? <p className="key-view-label muted">{view.viewLabel} · {ctl.session?.frames}</p> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The numbers (right)
// ---------------------------------------------------------------------------

function Big({ label, value, unit, tone, title }: { label: string; value: ReactNode; unit?: string; tone?: 'ok' | 'warn' | 'bad' | undefined; title?: string }) {
  return (
    <div className={`stat${tone ? ` ${tone}` : ''}`} title={title}>
      <span className="stat-value">
        {value}
        {unit ? <span className="stat-unit">{unit}</span> : null}
      </span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

const tone = (c: number | null | undefined) => (c === null || c === undefined ? undefined : c >= 0.8 ? 'ok' : c >= KEY_LOW_CONFIDENCE ? 'warn' : 'bad');

export function KeyInfo({ ctl }: { ctl: KeyController }) {
  const { doc, view, summary, review, keyTask, despillTask, version, session, record } = ctl;
  const screen = doc?.screen ?? null;
  const frameConf = view?.confidence ?? record?.confidence ?? null;
  const total = ctl.last - ctl.first + 1;
  const m = view?.metrics ?? record?.metrics ?? null;
  return (
    <div className="key-info">
      <div className="key-screen-card">
        <span className="key-swatch big" style={{ background: swatchCss(screen?.rgb ?? null, session?.encoding.linear ?? true) }} aria-label={screen ? `${screen.kind} screen colour` : 'No screen colour yet'} />
        <div>
          <strong>{screen ? `${screen.kind === 'green' ? 'Green' : 'Blue'} screen` : 'No screen yet'}</strong>
          <span className="muted small">{screen ? (screen.source === 'auto' ? `detected${screen.coverage !== null ? `, ${(screen.coverage * 100).toFixed(0)} % of the frame` : ''}` : `${screen.samples.length} eyedropper samples`) : 'Auto key finds it'}</span>
        </div>
      </div>
      <div className="stats">
        <Big label={`Matte quality, frame ${ctl.frame}`} value={frameConf === null ? '—' : Math.round(frameConf * 100)} unit={frameConf === null ? undefined : '%'} tone={tone(frameConf)} />
        <Big label="Shot average" value={summary.frames ? Math.round(summary.mean * 100) : '—'} unit={summary.frames ? '%' : undefined} tone={summary.frames ? tone(summary.mean) : undefined} />
        <Big label="Frames keyed" value={`${summary.frames}`} unit={` / ${total}`} tone={summary.frames >= total ? 'ok' : undefined} />
        <Big label="Problem frames" value={doc?.frames.length ? review.problems.length : '—'} tone={doc?.frames.length ? (review.problems.length ? 'warn' : 'ok') : undefined} />
      </div>
      <section className="info-section">
        <h4>Version and approval</h4>
        <dl className="key-kv">
          <dt>Key</dt>
          <dd>
            {versionTag(version)} · {keyTask ? TASK_STATE_LABELS[keyTask.state] : 'no task'}
            {keyTask?.approval ? ` · approved by ${keyTask.approval.by}` : ''}
          </dd>
          {despillTask ? (
            <>
              <dt>Despill</dt>
              <dd>
                {versionTag(despillTask.version)} · {TASK_STATE_LABELS[despillTask.state]}
                {despillTask.approval ? ` · approved by ${despillTask.approval.by}` : ''}
              </dd>
            </>
          ) : null}
          <dt>Exported</dt>
          <dd>{ctl.exported ? `${ctl.exported.frames} frames, ${ctl.exported.encoding}` : 'not yet'}</dd>
          <dt>Settings</dt>
          <dd>
            revision {doc?.revision ?? 0}
            {doc?.frames.length && !ctl.processed ? ' (changed since processing)' : ''}
          </dd>
        </dl>
      </section>
      <section className="info-section">
        <h4>Picture</h4>
        <dl className="key-kv">
          <dt>Frames</dt>
          <dd>{session?.frames || '—'}</dd>
          <dt>Keyed in</dt>
          <dd>{session?.encoding.label || '—'}</dd>
          <dt>Background</dt>
          <dd>{session?.background.available ? session.background.label : doc?.despill.background.kind !== 'none' ? (session?.background.reason ?? '…') : 'none'}</dd>
        </dl>
        {session?.encoding.note ? <p className="warn-text">{session.encoding.note}</p> : null}
      </section>
      {m ? (
        <section className="info-section">
          <h4>This frame</h4>
          <dl className="key-kv">
            <dt>Clean screen</dt>
            <dd>{(m.screenCoverage * 100).toFixed(1)} %</dd>
            <dt>Soft edge</dt>
            <dd>{(m.edgeActivity * 100).toFixed(2)} %</dd>
            <dt>Core rescued</dt>
            <dd>{(m.coreNoise * 100).toFixed(2)} %</dd>
            <dt>Holes</dt>
            <dd>{(m.holes * 100).toFixed(2)} %</dd>
            <dt>Screen vs model</dt>
            <dd>{(m.residual * 100).toFixed(1)} %</dd>
          </dl>
          {record?.reason ? <p className="warn-text">Problem: {record.reason}</p> : null}
        </section>
      ) : null}
      {doc?.match.suggestion ? (
        <section className="info-section">
          <h4>Suggested match (metadata only)</h4>
          <p className="mono small">
            gain {doc.match.suggestion.gain.map((v) => v.toFixed(2)).join(' ')}
            <br />
            offset {doc.match.suggestion.offset.map((v) => v.toFixed(3)).join(' ')}
            <br />
            {doc.match.suggestion.exposureStops >= 0 ? '+' : ''}
            {doc.match.suggestion.exposureStops.toFixed(2)} stops · confidence {doc.match.suggestion.confidence.toFixed(2)}
          </p>
        </section>
      ) : null}
      {ctl.props.taskInfo}
    </div>
  );
}

// ---------------------------------------------------------------------------
// All three together
// ---------------------------------------------------------------------------

export function KeyWorkspace(props: KeyWorkspaceProps) {
  const ctl = useKeyController(props);
  const name = ctl.state?.vfxShotId ?? props.shotId;
  if (!ctl.supported) return <div className="key-missing">Keying is not available in this build.</div>;
  if (!ctl.hasTask)
    return (
      <div className="key-missing" role="status">
        <h2>{name} has no key task</h2>
        <p>Green/blue-screen keying, despill and background match prep for this shot.</p>
        <button type="button" className="primary big" disabled={!props.canEdit} onClick={props.onAddKeyTask}>
          Add Key to this shot
        </button>
      </div>
    );
  return (
    <div className="key-workspace">
      <aside className="key-zone key-zone-steps" aria-label="Steps">
        <KeySteps ctl={ctl} />
      </aside>
      <section className="key-zone key-zone-centre" aria-label="Viewer">
        <KeyViewer ctl={ctl} />
      </section>
      <aside className="key-zone key-zone-info" aria-label="Details">
        <KeyInfo ctl={ctl} />
      </aside>
    </div>
  );
}
