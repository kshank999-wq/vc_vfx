import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import {
  LOW_CONFIDENCE,
  ROOT_PART_ID,
  ROTO_WORKING_WIDTHS,
  addPart,
  addStroke,
  clearStrokes,
  eraseStrokes,
  flagFrame,
  markFrameReviewed,
  newRotoDocument,
  nextProblemFrame,
  partDepth,
  partsInOrder,
  recordPropagation,
  recordRotoExport,
  removeKeyFrame,
  removePart,
  renamePart,
  reviewFrames,
  rotoLocked,
  rotoTaskVersion,
  serializeProject,
  setKeyFrame,
  setPartSettings,
  setRotoWorkingWidth,
  shotState,
  versionTag,
  type Project,
  type Result,
  type RotoCombine,
  type RotoDirection,
  type RotoPart,
  type RotoPoint,
  type RotoRefine,
} from '@vcvfx/domain';
import type { RotoMaskData, RotoSession, VcvfxApi } from '../../shared/bridge';
import { ModuleLayout, Stat, StepList, Stats, TaskMissing, type StepDef } from './Layout';

/**
 * The Roto workspace (master spec §5, §5.1, §5.2; addendum 04): paint what
 * belongs in (Include) and what does not (Exclude) on a key frame, let the
 * engine find the matte and carry it through the shot, look at where it is
 * least sure, and correct by painting there — which makes that frame a key
 * frame and re-propagates only around it. Parts (torso, arm, prop…) each have
 * their own strokes, refinement and engine, and combine into the subject
 * matte. Mattes are exported as versioned sequences and approved through the
 * shot's task approval, never here.
 *
 * Strokes are stored in plate pixels; the engines work at a working size in
 * main (or, in the browser preview, in the page) and the overlay shows their
 * mattes as they come back.
 */

export type RotoMutation = (p: Project, actor: string, now: Date) => Result;

export interface RotoWorkspaceProps {
  api: VcvfxApi;
  project: Project;
  shotId: string;
  projectKey: string;
  canEdit: boolean;
  busy: boolean;
  actor: string;
  frame: number;
  onFrame(frame: number): void;
  onRoto(fn: RotoMutation): boolean;
  runJob<T>(label: string, fn: (jobId: string) => Promise<T>): Promise<T>;
  notify(kind: 'ok' | 'error' | 'info', text: string): void;
  onAddRotoTask(): void;
  /** The roto task's state, approval and the shot's log, for the Details panel. */
  taskInfo?: ReactNode;
}

type Tool = 'include' | 'exclude' | 'erase';
type Overlay = 'matte' | 'alpha' | 'outline' | 'source';
type Loaded<T> = { data: T } | { error: string };

const TILE = 240;
const sizeFor = (px: number) => [320, 640, 960, 1280, 1920].find((s) => s >= px) ?? 1920;

/** Confidence as a colour: red below the problem line, through amber, to green. */
export function confidenceColour(c: number): string {
  const t = Math.max(0, Math.min(1, c));
  const hue = t < LOW_CONFIDENCE ? (t / LOW_CONFIDENCE) * 38 : 38 + ((t - LOW_CONFIDENCE) / (1 - LOW_CONFIDENCE)) * 92;
  return `hsl(${hue.toFixed(0)} 70% ${t < LOW_CONFIDENCE ? 52 : 46}%)`;
}

function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Draw mattes onto a canvas: tinted, as alpha, or as outlines. */
function paintMattes(canvas: HTMLCanvasElement | null, layers: { mask: RotoMaskData; colour: string }[], mode: Overlay, opacity: number): void {
  const g = canvas?.getContext('2d');
  if (!canvas || !g) return;
  g.clearRect(0, 0, canvas.width, canvas.height);
  if (mode === 'source' || !layers.length) return;
  for (const { mask, colour } of layers) {
    const img = new ImageData(mask.width, mask.height);
    const [r, gg, b] = mode === 'alpha' ? [255, 255, 255] : hexRgb(colour);
    const { alpha } = mask;
    for (let i = 0; i < alpha.length; i += 1) {
      let a = alpha[i]!;
      if (mode === 'outline') {
        const x = i % mask.width;
        const inside = a >= 128;
        const edge =
          inside &&
          ((x > 0 && alpha[i - 1]! < 128) || (x < mask.width - 1 && alpha[i + 1]! < 128) || (i >= mask.width && alpha[i - mask.width]! < 128) || (i + mask.width < alpha.length && alpha[i + mask.width]! < 128));
        a = edge ? 255 : 0;
      } else if (mode === 'matte') a = Math.round(a * opacity);
      img.data[4 * i] = r;
      img.data[4 * i + 1] = gg;
      img.data[4 * i + 2] = b;
      img.data[4 * i + 3] = a;
    }
    const off = document.createElement('canvas');
    off.width = mask.width;
    off.height = mask.height;
    off.getContext('2d')?.putImageData(img, 0, 0);
    g.imageSmoothingEnabled = mode !== 'outline';
    g.drawImage(off, 0, 0, canvas.width, canvas.height);
  }
}

function SliderField({ label, value, min, max, step, unit, disabled, onCommit }: { label: string; value: number; min: number; max: number; step: number; unit?: string; disabled: boolean; onCommit(v: number): void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => draft !== value && onCommit(draft);
  return (
    <label className="roto-slider">
      <span>{label}</span>
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
      <span className="mono small">
        {draft}
        {unit ?? ''}
      </span>
    </label>
  );
}

export function RotoWorkspace(props: RotoWorkspaceProps) {
  const { api, project, shotId, projectKey, canEdit, busy, frame, onFrame, onRoto, runJob, notify } = props;
  const state = shotState(project, shotId);
  const doc = state?.roto ?? null;
  const shown = useMemo(() => doc ?? newRotoDocument(), [doc]);
  const parts = useMemo(() => partsInOrder(shown), [shown]);
  const text = useMemo(() => serializeProject(project), [project]);
  const textRef = useRef(text);
  textRef.current = text;

  const [session, setSession] = useState<RotoSession | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [partId, setPartId] = useState(ROOT_PART_ID);
  const [tool, setTool] = useState<Tool>('include');
  const [brush, setBrush] = useState<number | null>(null);
  const [overlay, setOverlay] = useState<Overlay>('matte');
  const [opacity, setOpacity] = useState(0.55);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [autoKey, setAutoKey] = useState(true);
  const [exr, setExr] = useState(false);
  const [newPart, setNewPart] = useState('');
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [flagNote, setFlagNote] = useState('');
  const [epoch, setEpoch] = useState(0);
  const [pendingKey, setPendingKey] = useState<number | null>(null);
  const [, setTick] = useState(0);
  const frames = useRef(new Map<string, Loaded<string> | 'pending'>());
  const masks = useRef(new Map<string, Loaded<RotoMaskData | null> | 'pending'>());
  const stageRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const paintRef = useRef<HTMLCanvasElement | null>(null);
  const [box, setBox] = useState({ left: 0, top: 0, width: 0, height: 0 });
  const stroke = useRef<RotoPoint[] | null>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);

  const part: RotoPart = parts.find((p) => p.id === partId) ?? parts[0]!;
  const locked = state ? rotoLocked(state) : 'No shot';
  const version = state ? rotoTaskVersion(state) : 1;
  const plate = session?.plate ?? null;
  const first = session?.first ?? frame;
  const last = session?.last ?? frame;
  const radius = brush ?? Math.max(4, Math.round((plate?.width ?? 1920) * 0.012));
  const canPaint = canEdit && !locked && Boolean(session?.available);
  const key = part.keyFrames.find((k) => k.frame === frame);
  const record = part.frames.find((f) => f.frame === frame);
  const review = useMemo(() => reviewFrames(shown, partId, first, last), [shown, partId, first, last]);
  const engine = session?.engines.find((e) => e.id === part.engine.id);

  // A new shot starts afresh.
  useEffect(() => {
    setSession(null);
    frames.current = new Map();
    masks.current = new Map();
  }, [shotId, projectKey]);
  // What there is to paint on. Refreshed (keeping what is on screen meanwhile) when the roto task,
  // the plates or the working size change.
  const workingWidth = doc?.workingWidth ?? null;
  useEffect(() => {
    let live = true;
    setSessionError(null);
    void api.rotoSession({ text: textRef.current, shotId, projectKey }).then((r) => {
      if (!live) return;
      if (!r.ok) return setSessionError(r.error);
      setSession(r.data);
    });
    return () => {
      live = false;
    };
  }, [api, shotId, projectKey, state?.tasks.some((t) => t.kind === 'roto'), state?.plates.length, workingWidth]);

  // A part removed elsewhere: fall back to the subject.
  useEffect(() => {
    if (!parts.some((p) => p.id === partId)) setPartId(ROOT_PART_ID);
  }, [parts, partId]);

  // The stage decides the frame's on-screen box (contained, centred).
  useEffect(() => {
    const el = stageRef.current;
    if (!el || !plate) return;
    const measure = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      const aspect = plate.width / plate.height;
      const width = Math.min(w, h * aspect);
      const height = width / aspect;
      setBox({ left: (w - width) / 2, top: (h - height) / 2, width, height });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [plate?.width, plate?.height]);
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  const mainWidth = sizeFor(box.width * dpr);

  const wantFrame = useCallback(
    (f: number, w: number): Loaded<string> | undefined => {
      const k = `${f}:${w}`;
      const have = frames.current.get(k);
      if (have === 'pending') return undefined;
      if (have || !session?.available) return have;
      frames.current.set(k, 'pending');
      void api.rotoFrame({ text: textRef.current, shotId, projectKey, frame: f, maxWidth: w }).then((r) => {
        frames.current.set(k, r.ok ? { data: r.data.url } : { error: r.error });
        setTick((t) => t + 1);
      });
      return undefined;
    },
    [api, projectKey, session?.available, shotId],
  );

  const wantMask = useCallback(
    (id: string | null, f: number, w: number): RotoMaskData | null | undefined => {
      const k = `${id ?? '*'}:${f}:${w}:${epoch}`;
      const have = masks.current.get(k);
      if (have === 'pending') return undefined;
      if (have) return 'data' in have ? have.data : null;
      masks.current.set(k, 'pending');
      void api.rotoMask({ text: textRef.current, shotId, projectKey, partId: id, frame: f, maxWidth: w }).then((r) => {
        masks.current.set(k, r.ok ? { data: r.data } : { error: r.error });
        setTick((t) => t + 1);
      });
      return undefined;
    },
    [api, epoch, projectKey, shotId],
  );

  // Refinement and visibility change what the overlay shows: ask again.
  const refineKey = JSON.stringify(shown.parts.map((p) => [p.id, p.refine, p.combine, p.frames.length]));
  useEffect(() => {
    setEpoch((e) => e + 1);
  }, [refineKey]);

  const current = wantFrame(frame, mainWidth);
  // Neighbours ahead.
  useEffect(() => {
    if (!session?.available) return;
    for (const d of [1, -1, 2]) {
      const f = frame + d;
      if (f >= first && f <= last) wantFrame(f, mainWidth);
    }
  });

  const visible = parts.filter((p) => p.visible && p.frames.some((f) => f.frame === frame));
  const layers: { mask: RotoMaskData; colour: string }[] = [];
  if (overlay === 'alpha') {
    const m = wantMask(null, frame, mainWidth);
    if (m) layers.push({ mask: m, colour: '#ffffff' });
  } else if (overlay !== 'source') {
    for (const p of visible) {
      const m = wantMask(p.id, frame, mainWidth);
      if (m) layers.push({ mask: m, colour: p.color });
    }
  }
  const layerKey = layers.map((l) => `${l.colour}:${l.mask.width}:${l.mask.alpha.length}:${l.mask.alpha[l.mask.alpha.length >> 1]}`).join('|');
  useEffect(() => {
    const c = overlayRef.current;
    if (!c) return;
    c.width = Math.max(1, Math.round(box.width * dpr));
    c.height = Math.max(1, Math.round(box.height * dpr));
    paintMattes(c, layers, overlay, opacity);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layerKey, overlay, opacity, box.width, box.height, frame, epoch]);

  // The paint layer: this part's strokes on this frame, the stroke in progress and the brush.
  const toScreen = useCallback((x: number, y: number) => (plate ? [(x / plate.width) * box.width * dpr, (y / plate.height) * box.height * dpr] : [0, 0]) as [number, number], [plate, box.width, box.height, dpr]);
  const drawPaint = useCallback(() => {
    const c = paintRef.current;
    const g = c?.getContext('2d');
    if (!c || !g || !plate) return;
    c.width = Math.max(1, Math.round(box.width * dpr));
    c.height = Math.max(1, Math.round(box.height * dpr));
    g.clearRect(0, 0, c.width, c.height);
    const k = (box.width * dpr) / plate.width;
    const line = (pts: readonly RotoPoint[], r: number, colour: string) => {
      if (!pts.length) return;
      g.strokeStyle = colour;
      g.fillStyle = colour;
      g.lineWidth = Math.max(1, 2 * r * k);
      g.lineCap = 'round';
      g.lineJoin = 'round';
      g.beginPath();
      const [x0, y0] = toScreen(pts[0]![0], pts[0]![1]);
      g.moveTo(x0, y0);
      if (pts.length === 1) g.lineTo(x0 + 0.01, y0);
      for (const p of pts.slice(1)) g.lineTo(...toScreen(p[0], p[1]));
      g.stroke();
    };
    for (const s of key?.strokes ?? []) line(s.points, s.radius, s.mode === 'include' ? 'rgba(58, 208, 122, 0.45)' : 'rgba(255, 95, 86, 0.45)');
    if (stroke.current) line(stroke.current, radius, tool === 'include' ? 'rgba(58, 208, 122, 0.6)' : tool === 'exclude' ? 'rgba(255, 95, 86, 0.6)' : 'rgba(230, 232, 236, 0.35)');
    if (cursor && canPaint) {
      const [cx, cy] = toScreen(cursor.x, cursor.y);
      g.lineWidth = 1.5 * dpr;
      g.strokeStyle = tool === 'include' ? '#3ad07a' : tool === 'exclude' ? '#ff5f56' : '#e6e8ec';
      g.setLineDash(tool === 'erase' ? [4 * dpr, 3 * dpr] : []);
      g.beginPath();
      g.arc(cx, cy, Math.max(2, radius * k), 0, Math.PI * 2);
      g.stroke();
      g.setLineDash([]);
    }
  }, [box.width, box.height, canPaint, cursor, dpr, key, plate, radius, tool, toScreen]);
  useEffect(drawPaint, [drawPaint]);

  const toPlate = (e: ReactPointerEvent<HTMLCanvasElement>): RotoPoint | null => {
    if (!plate) return null;
    const r = e.currentTarget.getBoundingClientRect();
    if (r.width <= 0) return null;
    return [((e.clientX - r.left) / r.width) * plate.width, ((e.clientY - r.top) / r.height) * plate.height];
  };

  // --- running the engine -----------------------------------------------
  const run = useCallback(
    async (directions: RotoDirection[], from = frame) => {
      if (!part.keyFrames.some((k) => k.frame === from)) return notify('info', `Frame ${from} is not a key frame of ${part.name}. Paint it (or mark it as a reference) first.`);
      const label = directions.length === 1 && directions[0] === 'key' ? `Segmenting ${part.name} on ${from}` : `Propagating ${part.name} from ${from}`;
      const r = await runJob(label, (jobId) => api.rotoRun({ jobId, text: textRef.current, shotId, projectKey, partId: part.id, from, directions }));
      if (!r.ok) return notify(r.error === 'Cancelled' ? 'info' : 'error', r.error === 'Cancelled' ? 'Stopped. The frames done so far are kept.' : r.error);
      for (const result of r.data.results) onRoto((p, a, now) => recordPropagation(p, shotId, result, a, now));
      setEpoch((e) => e + 1);
      const made = r.data.results.reduce((n, x) => n + x.frames.length, 0);
      const low = r.data.results.flatMap((x) => x.frames).filter((f) => f.confidence < LOW_CONFIDENCE).length;
      if (directions.some((d) => d !== 'key')) notify(low ? 'info' : 'ok', `${part.name}: ${made} frame${made === 1 ? '' : 's'} ${low ? `· ${low} below ${LOW_CONFIDENCE} — use Next problem` : 'done'}. Review, then export for approval.`);
    },
    [api, frame, notify, onRoto, part, projectKey, runJob, shotId],
  );

  // After painting, the key frame's matte follows (debounced, once the stroke is in the project). A
  // correction — paint on a frame propagation had made — also re-propagates locally: towards the
  // neighbouring key frames, stopping where the frames already there are better (§5.2).
  useEffect(() => {
    if (pendingKey === null || busy) return;
    const t = setTimeout(() => {
      setPendingKey(null);
      const k = part.keyFrames.find((x) => x.frame === pendingKey && x.strokes.length);
      if (k) void run(k.correction ? ['key', 'backward', 'forward'] : ['key'], pendingKey);
    }, 350);
    return () => clearTimeout(t);
  }, [pendingKey, busy, part, run]);

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!canPaint || e.button !== 0) return;
    const p = toPlate(e);
    if (!p) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    stroke.current = [p];
    drawPaint();
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const p = toPlate(e);
    if (p) setCursor({ x: p[0], y: p[1] });
    if (!stroke.current || !p) return;
    const lastPoint = stroke.current[stroke.current.length - 1]!;
    if (Math.hypot(p[0] - lastPoint[0], p[1] - lastPoint[1]) >= Math.max(0.5, radius / 6)) {
      stroke.current.push(p);
      drawPaint();
    }
  };
  const onPointerUp = () => {
    const pts = stroke.current;
    stroke.current = null;
    if (!pts || !pts.length) return;
    const ok =
      tool === 'erase'
        ? onRoto((p, a, now) => eraseStrokes(p, shotId, part.id, frame, pts, radius, a, now))
        : onRoto((p, a, now) => addStroke(p, shotId, part.id, frame, { mode: tool, radius, points: pts }, a, now));
    if (ok && autoKey && part.engine.id === 'track') setPendingKey(frame);
    drawPaint();
  };

  const nextProblem = () => {
    const f = nextProblemFrame(review, frame);
    if (f === null) notify('ok', 'No problem frames: nothing below the confidence line, nothing flagged.');
    else onFrame(f);
  };

  const exportMattes = async () => {
    const r = await runJob(`Exporting mattes for ${shotId}`, (jobId) => api.rotoExport({ jobId, text: textRef.current, shotId, projectKey, operator: props.actor, exr }));
    if (!r.ok) return notify('error', r.error);
    const rec = r.data.record;
    const where = r.data.folder.split(/[\\/]/).slice(-2).join('/');
    if (onRoto((p, a, now) => recordRotoExport(p, shotId, rec, a, now))) notify('ok', `Roto ${versionTag(rec.version)} exported: ${r.data.files} files into …/${where}. It is up for review; approve it in Details on the right.`);
  };

  // Keys: [ ] brush, I / E / X tools, N next problem, F flag.
  const keys = useRef<(e: KeyboardEvent) => void>(() => undefined);
  keys.current = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
    if (document.querySelector('.modal') || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (e.key === '[' || e.key === ']') {
      e.preventDefault();
      setBrush(Math.max(1, Math.min(2000, Math.round(radius * (e.key === ']' ? 1.25 : 0.8)))));
    } else if (k === 'i') setTool('include');
    else if (k === 'e') setTool('exclude');
    else if (k === 'x') setTool('erase');
    else if (k === 'n') nextProblem();
    else if (k === 'f' && record && canPaint) onRoto((p, a, now) => flagFrame(p, shotId, part.id, frame, flagNote, a, now));
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!state) return null;
  if (!state.tasks.some((t) => t.kind === 'roto')) {
    return (
      <main className="module module-missing" aria-label="Roto">
        <TaskMissing module="roto" shotName={state.vfxShotId ?? shotId} canEdit={canEdit} locked={state.stage !== 'prep' ? `The shot is ${state.stage}; reopen it first.` : null} onAdd={props.onAddRotoTask} />
      </main>
    );
  }

  const span = Math.max(1, last - first);
  const conf = new Map(part.frames.map((f) => [f.frame, f]));
  const timelineFrames = session?.available ? Array.from({ length: last - first + 1 }, (_, i) => first + i) : [];
  const problems = new Set(review.problems.map((p) => p.frame));
  const sheet = review.sheet;
  const exportedThis = shown.exports.find((x) => x.version === version);
  const message = sessionError ?? (session && !session.available ? session.reason : null);
  const painted = shown.parts.some((p) => p.keyFrames.some((k) => k.strokes.length > 0));
  const propagated = shown.parts.some((p) => p.frames.length > p.keyFrames.length);
  const total = Math.max(0, last - first + 1);
  const lowest = review.lowest[0];
  const nearestKey = part.keyFrames.length ? part.keyFrames.reduce((a, k) => (Math.abs(k.frame - frame) < Math.abs(a.frame - frame) ? k : a)).frame : null;
  const tools = (
    <div className="seg tool-seg" role="group" aria-label="Brush">
      {(
        [
          ['include', 'Include', 'I', 'Paint over what belongs in the matte'],
          ['exclude', 'Exclude', 'E', 'Paint over what does not'],
          ['erase', 'Eraser', 'X', 'Remove paint'],
        ] as const
      ).map(([t, label, hot, what]) => (
        <button key={t} type="button" className={tool === t ? `on tool-${t}` : `tool-${t}`} aria-pressed={tool === t} title={`${label} (${hot}): ${what}`} onClick={() => setTool(t)}>
          {label}
        </button>
      ))}
    </div>
  );

  const steps: StepDef[] = [
    {
      id: 'paint',
      title: 'Paint the subject',
      hint: 'Green over what you want, red over what you don’t.',
      done: painted,
      content: (
        <>
          <p className="step-text">
            Choose <b className="ink-include">Include</b> (I) above the picture and paint over the subject. Choose <b className="ink-exclude">Exclude</b> (E) and paint over the background next to it. The matte appears as you paint.
          </p>
          <p className="muted small hint">The brush size is next to the tools; [ and ] change it too.</p>
          <label className="check">
            <input type="checkbox" checked={autoKey} onChange={(e) => setAutoKey(e.target.checked)} /> Update as I paint (corrections re-propagate nearby)
          </label>
          <div className="row">
            {key ? (
              <>
                <button type="button" disabled={!canPaint || !key.strokes.length} onClick={() => onRoto((p, a, now) => clearStrokes(p, shotId, part.id, frame, a, now))}>
                  Clear strokes
                </button>
                <button type="button" disabled={!canPaint} onClick={() => onRoto((p, a, now) => removeKeyFrame(p, shotId, part.id, frame, a, now))}>
                  Remove key
                </button>
              </>
            ) : (
              <button type="button" disabled={!canPaint || !record} onClick={() => onRoto((p, a, now) => setKeyFrame(p, shotId, part.id, frame, a, now))} title="Accept this frame's matte as a reference to propagate from">
                Mark as key frame
              </button>
            )}
          </div>

          <details className="sub" open={parts.length > 1}>
            <summary>Parts (torso, arm, hair, prop…)</summary>
            <ul className="roto-parts" aria-label="Roto parts">
              {parts.map((p) => {
                const depth = partDepth(shown, p.id);
                return (
                  <li key={p.id} className={p.id === part.id ? 'selected' : undefined} style={{ paddingLeft: 6 + depth * 16 }}>
                    <input type="color" className="swatch" aria-label={`${p.name} colour`} value={p.color} disabled={!canPaint} onChange={(e) => onRoto((pr, a, now) => setPartSettings(pr, shotId, p.id, { color: e.target.value }, a, now))} />
                    <button type="button" className={`eye${p.visible ? '' : ' off'}`} aria-label={p.visible ? `Hide ${p.name}` : `Show ${p.name}`} aria-pressed={p.visible} disabled={!canPaint} onClick={() => onRoto((pr, a, now) => setPartSettings(pr, shotId, p.id, { visible: !p.visible }, a, now))}>
                      {p.visible ? '◉' : '○'}
                    </button>
                    {renaming?.id === p.id ? (
                      <form
                        className="rename"
                        onSubmit={(e) => {
                          e.preventDefault();
                          if (onRoto((pr, a, now) => renamePart(pr, shotId, p.id, renaming.name, a, now))) setRenaming(null);
                        }}
                      >
                        <input aria-label="Part name" autoFocus value={renaming.name} onChange={(e) => setRenaming({ id: p.id, name: e.target.value })} onBlur={() => setRenaming(null)} />
                      </form>
                    ) : (
                      <button type="button" className="part-name" onClick={() => setPartId(p.id)} onDoubleClick={() => canPaint && setRenaming({ id: p.id, name: p.name })} title="Select; double-click to rename">
                        {p.name}
                      </button>
                    )}
                    <span className="muted small part-meta">
                      {p.parentId ? (
                        <select aria-label={`${p.name} combines by`} value={p.combine} disabled={!canPaint} onChange={(e) => onRoto((pr, a, now) => setPartSettings(pr, shotId, p.id, { combine: e.target.value as RotoCombine }, a, now))}>
                          <option value="union">+ union</option>
                          <option value="subtract">− subtract</option>
                        </select>
                      ) : (
                        'subject'
                      )}
                      {` · ${p.keyFrames.length}◆`}
                    </span>
                    {p.parentId ? (
                      <button type="button" className="icon remove" aria-label={`Remove ${p.name}`} disabled={!canPaint} onClick={() => onRoto((pr, a, now) => removePart(pr, shotId, p.id, a, now))}>
                        ×
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            <form
              className="add-part"
              onSubmit={(e) => {
                e.preventDefault();
                const name = newPart.trim();
                if (!name) return;
                if (onRoto((p, a, now) => addPart(p, shotId, { name, parentId: part.id }, a, now))) setNewPart('');
              }}
            >
              <input aria-label="New part name" placeholder={`New part under ${part.name}`} value={newPart} disabled={!canPaint} onChange={(e) => setNewPart(e.target.value)} />
              <button type="submit" disabled={!canPaint || !newPart.trim()}>
                Add
              </button>
            </form>
          </details>

          <details className="sub">
            <summary>Engine and working size</summary>
            <div className="roto-engines" role="radiogroup" aria-label="Engine">
              {(session?.engines ?? []).map((e) => (
                <label key={e.id} className={`roto-engine${e.available ? '' : ' unavailable'}`} title={e.reason ?? `${e.label} ${e.version}`}>
                  <input type="radio" name="roto-engine" checked={part.engine.id === e.id} disabled={!canPaint || (!e.available && part.engine.id !== e.id)} onChange={() => onRoto((p, a, now) => setPartSettings(p, shotId, part.id, { engine: { id: e.id } }, a, now))} />
                  <span>
                    {e.label} <span className="muted mono small">{e.version}</span>
                  </span>
                  {e.model && !e.model.present ? (
                    <button
                      type="button"
                      className="small-button"
                      disabled={!e.model.downloadable || busy || !canEdit}
                      title={e.reason ?? undefined}
                      onClick={async () => {
                        const r = await runJob('Downloading the SAM 2 model', (jobId) => api.rotoModel({ jobId, action: 'download' }));
                        if (!r.ok) return notify('error', r.error);
                        notify('ok', 'The SAM 2 model is downloaded and checked.');
                        setSession((s) => (s ? { ...s, engines: s.engines.map((x) => (x.id === 'sam2' ? r.data : x)) } : s));
                      }}
                    >
                      Download model ({Math.round(e.model.approxBytes / 1e6)} MB)
                    </button>
                  ) : null}
                  {!e.available && e.reason ? <span className="muted small roto-reason">{e.reason}</span> : null}
                </label>
              ))}
            </div>
            <label className="roto-slider compact-select">
              <span>Working size</span>
              {session?.sample ? (
                <span title="The preview’s synthetic shot is analysed at 640 px">640 px (sample)</span>
              ) : (
                <select
                  aria-label="Working size"
                  value={plate ? Math.min(shown.workingWidth, plate.width) : shown.workingWidth}
                  disabled={!canPaint}
                  title="The engines work at this width; exports are always at plate resolution"
                  onChange={(e) => onRoto((p, a, now) => setRotoWorkingWidth(p, shotId, Number(e.target.value), a, now))}
                >
                  {[...ROTO_WORKING_WIDTHS.filter((w) => !plate || w < plate.width), ...(plate && plate.width <= 8192 ? [plate.width] : [])].map((w) => (
                    <option key={w} value={w}>
                      {w} px{plate && w === plate.width ? ' (plate)' : ''}
                    </option>
                  ))}
                </select>
              )}
              {session?.sample ? <span className="mono small muted">{session.working ? `${session.working.width}×${session.working.height}` : ''}</span> : null}
            </label>
          </details>
        </>
      ),
    },
    {
      id: 'propagate',
      title: 'Propagate',
      hint: 'Carry the matte from the key frame through the shot.',
      done: propagated,
      waiting: painted ? null : 'Paint a frame first (step 1).',
      content: (
        <>
          {key ? (
            <p className="step-text">Frame {frame} is a key frame of {part.name}. Carry its matte both ways, up to the next key frames.</p>
          ) : (
            <p className="step-text">
              Propagation runs from a key frame (◆ on the timeline).{' '}
              {nearestKey !== null ? (
                <button type="button" className="link" onClick={() => onFrame(nearestKey)}>
                  Go to key frame {nearestKey}
                </button>
              ) : null}
            </p>
          )}
          <button type="button" className="primary big" disabled={!canPaint || busy || !key} onClick={() => void run(['key', 'backward', 'forward'])} title="Propagate both ways, up to the neighbouring key frames">
            ◀ Propagate ▶
          </button>
          <div className="seg" role="group" aria-label="Propagate one way">
            <button type="button" disabled={!canPaint || busy || !key} onClick={() => void run(['key', 'backward'])} title="Propagate backward to the previous key frame">
              ◀ Back
            </button>
            <button type="button" disabled={!canPaint || busy || !key} onClick={() => void run(['key'])} title="Segment this key frame from its strokes">
              Segment
            </button>
            <button type="button" disabled={!canPaint || busy || !key} onClick={() => void run(['key', 'forward'])} title="Propagate forward to the next key frame">
              Forward ▶
            </button>
          </div>
        </>
      ),
    },
    {
      id: 'review',
      title: 'Review problem frames',
      hint: 'Look where it is least sure; paint there to fix it.',
      done: propagated && review.problems.length === 0,
      waiting: propagated ? null : 'Propagate first (step 2).',
      content: (
        <>
          <p className="step-text">The timeline under the picture is coloured by confidence: red needs a look. Painting on any frame makes it a correction and re-propagates around it.</p>
          <button type="button" className="primary big" onClick={nextProblem} title="Jump to the next frame most likely to need correction (N)" disabled={!session?.available}>
            Next problem ▸ ({review.problems.length})
          </button>
          <div className="row">
            <input className="mark-note" aria-label="Flag note" placeholder="Flag note (optional)" value={flagNote} disabled={!canPaint || !record} onChange={(e) => setFlagNote(e.target.value)} />
            <button
              type="button"
              className={record?.status === 'flagged' ? 'marked' : undefined}
              disabled={!canPaint || !record}
              onClick={() => {
                onRoto((p, a, now) => flagFrame(p, shotId, part.id, frame, flagNote, a, now));
                setFlagNote('');
              }}
              title="Flag this frame as needing correction (F)"
            >
              {record?.status === 'flagged' ? '⚑ Flagged — clear' : 'Flag'}
            </button>
          </div>
          <div className="row">
            <button type="button" disabled={!canPaint || !record} onClick={() => onRoto((p, a, now) => markFrameReviewed(p, shotId, null, frame, a, now))} title="Record that you looked at this frame and it is right">
              Mark reviewed
            </button>
            <button type="button" className={sheetOpen ? 'on' : undefined} aria-pressed={sheetOpen} onClick={() => setSheetOpen((o) => !o)} title="Mattes on representative and lowest-confidence frames">
              {sheetOpen ? 'Hide matte sheet' : 'Show matte sheet'}
            </button>
          </div>
        </>
      ),
    },
    {
      id: 'export',
      title: 'Export mattes',
      hint: 'Write the matte sequences into the shot package.',
      done: Boolean(exportedThis),
      waiting: propagated ? null : 'Propagate first (step 2).',
      content: (
        <>
          <details className="sub">
            <summary>Refine edges · {part.name}</summary>
            <SliderField label="Feather" value={part.refine.featherPx} min={0} max={20} step={0.5} unit="px" disabled={!canPaint} onCommit={(v) => onRoto((p, a, now) => setPartSettings(p, shotId, part.id, { refine: { featherPx: v } }, a, now))} />
            <SliderField label="Shrink / grow" value={part.refine.shrinkGrowPx} min={-20} max={20} step={1} unit="px" disabled={!canPaint} onCommit={(v) => onRoto((p, a, now) => setPartSettings(p, shotId, part.id, { refine: { shrinkGrowPx: v } }, a, now))} />
            <SliderField label="Smoothing" value={part.refine.temporalSmoothing} min={0} max={1} step={0.05} disabled={!canPaint} onCommit={(v) => onRoto((p, a, now) => setPartSettings(p, shotId, part.id, { refine: { temporalSmoothing: v } as Partial<RotoRefine> }, a, now))} />
            <label className="check">
              <input type="checkbox" checked={part.refine.edgeSnap} disabled={!canPaint} onChange={(e) => onRoto((p, a, now) => setPartSettings(p, shotId, part.id, { refine: { edgeSnap: e.target.checked } }, a, now))} /> Snap edges to the plate on export
            </label>
          </details>
          <label className="check">
            <input type="checkbox" checked={exr} onChange={(e) => setExr(e.target.checked)} /> Also write EXR (half float)
          </label>
          <button type="button" className="primary big" disabled={!canEdit || busy || !session?.exportable || !shown.parts.some((p) => p.frames.length)} title={session && !session.exportable ? 'Available in the desktop app: mattes are written into the shot package on disk.' : undefined} onClick={() => void exportMattes()}>
            Export mattes {versionTag(version)}
          </button>
          <p className="muted small hint">
            {exportedThis
              ? `${versionTag(version)} written ${exportedThis.writtenAt.replace('T', ' ').slice(0, 16)} by ${exportedThis.by}: ${exportedThis.pattern}. Approve roto in Details on the right.`
              : `16-bit PNG sequences per part and combined, at plate resolution, into 02_MATTES_ROTO. Exporting puts roto up for review.`}
            {session && !session.exportable ? ' Exporting is done in the desktop app.' : ''}
          </p>
          {locked && state.stage === 'prep' ? <p className="muted small hint">{locked}</p> : null}
        </>
      ),
    },
  ];

  const info = (
    <>
      <Stats>
        <Stat label="Frames with a matte" value={part.frames.length} unit={` / ${total}`} tone={total && part.frames.length >= total ? 'ok' : undefined} />
        <Stat label="Key frames" value={part.keyFrames.length} />
        <Stat label="Frames to check" value={review.problems.length} tone={review.problems.length ? 'warn' : propagated ? 'ok' : undefined} />
        <Stat label="Lowest confidence" value={lowest ? lowest.confidence.toFixed(2) : '—'} tone={lowest ? (lowest.confidence < LOW_CONFIDENCE ? 'bad' : 'ok') : undefined} title={lowest ? `Frame ${lowest.frame}` : undefined} />
        <Stat label="This frame" value={record ? record.confidence.toFixed(2) : '—'} tone={record ? (record.confidence < LOW_CONFIDENCE ? 'bad' : 'ok') : undefined} />
        <Stat label="Mattes exported" value={exportedThis ? versionTag(version) : 'not yet'} tone={exportedThis ? 'ok' : undefined} />
      </Stats>
      <p className="info-line">
        Working on <span className="part-chip" style={{ borderColor: part.color }}>{part.name}</span>
        {parts.length > 1 ? <span className="muted"> · {parts.length} parts</span> : null}
      </p>
      {props.taskInfo}
    </>
  );

  return (
    <ModuleLayout label="Roto" steps={<StepList steps={steps} resetKey={shotId} />} info={info}>
      <div className="viewer roto-view" aria-label={`Roto — ${state.vfxShotId ?? shotId}`}>
        <div className="viewer-toolbar roto-toolbar">
          {tools}
          <label className="roto-slider brush" title="Brush size ([ and ])">
            <span>Brush</span>
            <input type="range" aria-label="Brush size" min={1} max={Math.max(50, Math.round((plate?.width ?? 1920) / 12))} value={radius} onChange={(e) => setBrush(Number(e.target.value))} />
            <span className="mono">{radius}px</span>
          </label>
          <div className="spacer" />
          <label className="field-inline" title="What is drawn over the frame">
            <span>Show</span>
            <select aria-label="Overlay" value={overlay} onChange={(e) => setOverlay(e.target.value as Overlay)}>
              <option value="matte">Matte (tinted)</option>
              <option value="alpha">Alpha</option>
              <option value="outline">Outline</option>
              <option value="source">Frame only</option>
            </select>
          </label>
          <input className="opacity" type="range" aria-label="Overlay opacity" title="How strongly the matte is tinted" min={0.1} max={1} step={0.05} value={opacity} disabled={overlay !== 'matte'} onChange={(e) => setOpacity(Number(e.target.value))} />
        </div>

        <div className={`viewer-stage roto-stage${overlay === 'alpha' ? ' alpha' : ''}`} ref={stageRef} data-frame={frame}>
          {message ? <p className="viewer-message">{message}</p> : null}
          {!session && !sessionError ? <p className="viewer-message muted">Opening roto…</p> : null}
          {current && 'error' in current ? <p className="viewer-message error">{current.error}</p> : null}
          {session?.available ? (
            <div className="roto-frame" style={{ left: box.left, top: box.top, width: box.width, height: box.height }}>
              {current && 'data' in current && overlay !== 'alpha' ? <img className="frame" src={current.data} alt={`Frame ${frame}`} draggable={false} /> : null}
              <canvas ref={overlayRef} className="roto-overlay" aria-hidden="true" />
              <canvas
                ref={paintRef}
                className={`roto-paint${canPaint ? ' can-paint' : ''}`}
                aria-label="Paint on the frame"
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                onPointerLeave={() => setCursor(null)}
              />
            </div>
          ) : null}
          {session?.sample ? <span className="stage-tag">sample frames</span> : null}
        </div>

        {sheetOpen && session?.available ? (
          <section className="contact-sheet roto-sheet" aria-label="Matte contact sheet">
            <header>
              <strong>Mattes · representative and lowest-confidence frames</strong>
              <span className="muted small">
                {sheet.length} frames · {review.lowest.length ? `lowest ${review.lowest.map((l) => `${l.frame} (${l.confidence.toFixed(2)})`).slice(0, 3).join(', ')}` : 'nothing propagated yet'}
              </span>
            </header>
            <ol className="tiles">
              {sheet.map((f) => (
                <SheetTile key={f} aspect={plate ? plate.width / plate.height : 16 / 9} frame={f} current={f === frame} record={conf.get(f)} isKey={part.keyFrames.some((k) => k.frame === f)} lowest={review.lowest.some((l) => l.frame === f)} url={wantFrame(f, TILE)} mask={wantMask(part.id, f, TILE)} colour={part.color} onGo={onFrame} />
              ))}
            </ol>
          </section>
        ) : null}

        <div className="viewer-info roto-info">
          <span className="mono frame-no" aria-label="Frame">
            {frame}
          </span>
          {parts.length > 1 ? (
            <span className="part-chip" style={{ borderColor: part.color }}>
              {part.name}
            </span>
          ) : null}
          {key ? (
            <span className="tag">
              {key.correction ? '◆ correction key' : '◆ key frame'}
              {key.strokes.length ? ` · ${key.strokes.length} stroke${key.strokes.length === 1 ? '' : 's'}` : ' · reference'}
            </span>
          ) : null}
          {record ? (
            <span style={{ color: confidenceColour(record.confidence) }} title={record.engine}>
              {record.status === 'flagged' ? '⚑ flagged · ' : ''}confidence {record.confidence.toFixed(2)}
              {record.reviewed ? ` · reviewed by ${record.reviewed.by}` : ''}
            </span>
          ) : (
            <span className="muted">no matte on this frame</span>
          )}
          <div className="spacer" />
          <button type="button" onClick={nextProblem} title="Jump to the next frame most likely to need correction (N)" disabled={!session?.available}>
            Next problem ▸ <span className="muted">({review.problems.length})</span>
          </button>
          <button type="button" className={sheetOpen ? 'on' : undefined} aria-pressed={sheetOpen} onClick={() => setSheetOpen((o) => !o)}>
            Contact sheet
          </button>
        </div>

        <div className="roto-timeline" aria-label="Confidence timeline">
          <div className="roto-cells">
            {timelineFrames.map((f) => {
              const r = conf.get(f);
              const isKey = part.keyFrames.some((k) => k.frame === f);
              return (
                <button
                  key={f}
                  type="button"
                  className={['cell', f === frame ? 'current' : '', problems.has(f) ? 'problem' : '', r?.status === 'flagged' ? 'flagged' : ''].filter(Boolean).join(' ')}
                  style={{ background: r ? confidenceColour(r.confidence) : undefined }}
                  title={`${f}${r ? ` · ${r.status} · ${r.confidence.toFixed(2)}` : ' · no matte'}`}
                  aria-label={`Frame ${f}`}
                  onClick={() => onFrame(f)}
                >
                  {isKey ? (
                    <span className="key-mark" style={{ color: part.color }}>
                      ◆
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
          <div className="roto-scale mono muted">
            <span>{first}</span>
            <span>
              {part.name}: {part.frames.length} of {last - first + 1} frames · {part.keyFrames.length} key · {review.problems.length} to check
            </span>
            <span>{last}</span>
          </div>
          <div className="transport">
            <button type="button" aria-label="Back 10 frames" title="Back 10 frames (Shift+←)" onClick={() => onFrame(Math.max(first, frame - 10))}>
              −10
            </button>
            <button type="button" aria-label="Back 1 frame" title="Back 1 frame (←)" onClick={() => onFrame(Math.max(first, frame - 1))}>
              −1
            </button>
            <button type="button" aria-label="Forward 1 frame" title="Forward 1 frame (→)" onClick={() => onFrame(Math.min(last, frame + 1))}>
              +1
            </button>
            <button type="button" aria-label="Forward 10 frames" title="Forward 10 frames (Shift+→)" onClick={() => onFrame(Math.min(last, frame + 10))}>
              +10
            </button>
            <div className="scrub">
              <input type="range" aria-label="Scrub" min={first} max={last} value={frame} onChange={(e) => onFrame(Number(e.target.value))} />
            </div>
            <span className="mono muted range">
              {first}–{last} · {(((frame - first) / span) * 100).toFixed(0)}%
            </span>
          </div>
        </div>
      </div>
    </ModuleLayout>
  );
}

function SheetTile({
  aspect,
  frame,
  current,
  record,
  isKey,
  lowest,
  url,
  mask,
  colour,
  onGo,
}: {
  aspect: number;
  frame: number;
  current: boolean;
  record: RotoPart['frames'][number] | undefined;
  isKey: boolean;
  lowest: boolean;
  url: Loaded<string> | undefined;
  mask: RotoMaskData | null | undefined;
  colour: string;
  onGo(f: number): void;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c || !mask) return;
    c.width = mask.width;
    c.height = mask.height;
    paintMattes(c, [{ mask, colour }], 'matte', 0.55);
  }, [mask, colour]);
  const problem = record && (record.status === 'flagged' || record.confidence < LOW_CONFIDENCE);
  return (
    <li className={[current ? 'current' : '', problem ? 'marked' : ''].filter(Boolean).join(' ') || undefined}>
      <button type="button" onClick={() => onGo(frame)} aria-label={`Frame ${frame}`}>
        <span className="tile-img roto-tile" style={{ aspectRatio: String(aspect) }}>
          {url && 'data' in url ? <img src={url.data} alt="" draggable={false} /> : <span className="tile-wait">…</span>}
          <canvas ref={ref} aria-hidden="true" />
        </span>
        <span className="tile-label mono">
          {frame}
          {isKey ? <span style={{ color: colour }}> ◆</span> : null}
          {record ? <span style={{ color: confidenceColour(record.confidence), float: 'right' }}>{record.status === 'flagged' ? '⚑ ' : ''}{record.confidence.toFixed(2)}</span> : <span className="muted" style={{ float: 'right' }}>—</span>}
          {lowest ? <span className={record && record.confidence < LOW_CONFIDENCE ? 'tile-mark' : 'muted'} title="Among the lowest-confidence frames"> ▼</span> : null}
        </span>
      </button>
    </li>
  );
}
