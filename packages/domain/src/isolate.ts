import { contactSheetFrames, handoffShot, shotState, type LogEntry, type Project, type Result, type ShotState } from './project.js';
import { framePattern, frameFileName, versionTag } from './frames.js';
import { rotoPart } from './roto.js';
import { RotoStrokeSchema, type RotoStroke } from './roto-schema.js';
import type { PrepTaskKind } from './tasks.js';
import {
  ISOLATE_ALGORITHM,
  ISOLATE_FORMAT_VERSION,
  IsolateExportSchema,
  IsolateParamsSchema,
  IsolateRectSchema,
  IsolateSpillSchema,
  DEFAULT_ISOLATE_PARAMS,
  type IsolateDocument,
  type IsolateEngine,
  type IsolateExportInput,
  type IsolateFrameRecord,
  type IsolateMetrics,
  type IsolateParams,
  type IsolateRect,
  type IsolateSeedMode,
  type IsolateSpill,
  type IsolateTarget,
} from './isolate-schema.js';

export * from './isolate-schema.js';

/**
 * Sky isolation / replacement prep and background removal as a model (master
 * spec §11, §15, §19; addendum 11).
 *
 * Every mutation is pure, returns a new project and is logged with who and
 * when. The rules are the clean plate's:
 *  - the work is the shot's `sky_replacement` (target sky) or
 *    `background_removal` (target background) task: changing a setting starts
 *    it or reopens a review for correction, a finished build or an export puts
 *    it up for review, and nothing here approves it — approval is
 *    `approveTask`, a named human act, and needs an export of the version;
 *  - approved isolations are never changed in place: every edit is refused
 *    until the task is reopened, which bumps its version, so the next export
 *    writes `v002` beside the approved `v001`;
 *  - the settings are what the outputs are reproduced from (§19): every
 *    change bumps `revision`, and each build and export records the revision.
 */

const MAX_RUNS = 200;
/** Confidence below which a frame is a problem. */
export const ISOLATE_LOW_CONFIDENCE = 0.6;
/** Mean |Δα| over the static edge above which a frame flickers. */
export const ISOLATE_MAX_FLICKER = 0.04;
/** Share of the frame on the uncertain edge above which it is a problem. */
export const ISOLATE_MAX_EDGE = 0.08;
/** Share of the sky behind the edge never seen (filled) above which a frame is a problem. */
export const ISOLATE_MAX_UNSEEN_SKY = 0.1;
/** Relative contrast across the edge below which sky and foreground are hard to tell apart. */
export const ISOLATE_MIN_CONTRAST = 0.06;

/** The task each target is. */
export const ISOLATE_TASK: Record<IsolateTarget, PrepTaskKind> = { sky: 'sky_replacement', background: 'background_removal' };
export const ISOLATE_TARGET_LABELS: Record<IsolateTarget, string> = { sky: 'Sky', background: 'Background' };
/** The file-name element of each target (`<shot>_sky_v001`, `<shot>_bg_v001`). */
export const ISOLATE_ELEMENT: Record<IsolateTarget, string> = { sky: 'sky', background: 'bg' };

export function isolateTargetOf(kind: PrepTaskKind): IsolateTarget | null {
  return kind === 'sky_replacement' ? 'sky' : kind === 'background_removal' ? 'background' : null;
}

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

export function newIsolateDocument(target: IsolateTarget): IsolateDocument {
  return {
    formatVersion: ISOLATE_FORMAT_VERSION,
    target,
    algorithm: { ...ISOLATE_ALGORITHM },
    seed: { mode: target === 'sky' ? 'auto' : 'box', frame: null, rect: null, partId: null },
    engine: 'track',
    keyFrames: [],
    params: { ...DEFAULT_ISOLATE_PARAMS, spill: { ...DEFAULT_ISOLATE_PARAMS.spill } },
    frames: [],
    runs: [],
    exports: [],
    workingWidth: 960,
    revision: 0,
    seq: 0,
  };
}

const shotName = (s: ShotState) => s.vfxShotId ?? s.shotId;
const taskLabel = (t: IsolateTarget) => (t === 'sky' ? 'Sky isolation' : 'Background removal');

/** The document of a target, or null. */
export function isolateDoc(s: ShotState | null | undefined, target: IsolateTarget): IsolateDocument | null {
  return s?.isolate?.[target] ?? null;
}

/** Why the isolation of this shot cannot be changed right now, or null. */
export function isolateLocked(s: ShotState, target: IsolateTarget): string | null {
  if (s.stage !== 'prep') return `${shotName(s)} is ${s.stage}; reopen it before changing its ${target === 'sky' ? 'sky isolation' : 'background removal'}`;
  const task = s.tasks.find((t) => t.kind === ISOLATE_TASK[target]);
  if (!task) return `${shotName(s)} has no ${taskLabel(target)} task. Add it first.`;
  if (task.state === 'approved') return `${taskLabel(target)} ${versionTag(task.version)} is approved. Reopen it (Needs correction) to make ${versionTag(task.version + 1)}; the approved files are kept.`;
  return null;
}

export function isolateTaskVersion(s: ShotState, target: IsolateTarget): number {
  return s.tasks.find((t) => t.kind === ISOLATE_TASK[target])?.version ?? 1;
}

type TaskMove = 'edited' | 'review';

function editIsolate(
  p: Project,
  shotId: string,
  target: IsolateTarget,
  actor: string,
  now: Date,
  action: string,
  fn: (doc: IsolateDocument, s: ShotState) => { doc: IsolateDocument; detail: string; task?: TaskMove; settings?: boolean } | string,
): Result {
  const at = now.toISOString();
  let detail = '';
  let started = false;
  const moves: string[] = [];
  const kind = ISOLATE_TASK[target];
  const r = withShot(p, shotId, (s) => {
    const locked = isolateLocked(s, target);
    if (locked) return locked;
    const current = isolateDoc(s, target);
    started = current === null;
    const out = fn(current ?? newIsolateDocument(target), s);
    if (typeof out === 'string') return out;
    detail = out.detail;
    const doc = out.settings ? { ...out.doc, revision: out.doc.revision + 1 } : out.doc;
    const tasks = s.tasks.map((t) => {
      if (t.kind !== kind || !out.task || t.state === 'approved') return t;
      // A change starts the work or reopens a review for correction; a finished build goes to review (§15.6).
      const next: typeof t.state = out.task === 'review' ? 'needs_review' : t.state === 'pending' ? 'processing' : t.state === 'needs_review' ? 'needs_correction' : t.state;
      if (next === t.state) return t;
      moves.push(`${kind} → ${next}`);
      return { ...t, state: next };
    });
    return { ...s, tasks, isolate: { ...(s.isolate ?? { sky: null, background: null }), [target]: doc } };
  });
  if (!r.ok) return r;
  let out = r.project;
  if (started) out = logged(out, { at, actor, shotId, action: 'isolate.started', detail: `${target}: ${ISOLATE_ALGORITHM.id}@${ISOLATE_ALGORITHM.version}` });
  out = logged(out, { at, actor, shotId, action, detail: `${target}: ${detail}` });
  for (const m of moves) out = logged(out, { at, actor, shotId, action: 'task.state', detail: m });
  return { ok: true, project: out };
}

const validFrame = (frame: number) => Number.isInteger(frame) && frame >= 0;
const rectText = (r: IsolateRect) => `${Math.round(r.x0)},${Math.round(r.y0)}–${Math.round(r.x1)},${Math.round(r.y1)}`;

// ---------------------------------------------------------------------------
// The seed (§11 "prompt/paint/reference-assisted")
// ---------------------------------------------------------------------------

export interface IsolateSeedChange {
  mode?: IsolateSeedMode;
  /** null: the middle of the shot. */
  frame?: number | null;
  rect?: IsolateRect | null;
  partId?: string | null;
}

/** How the isolation starts: automatic, a box, paint on the seed frame, or a roto part; and the seed frame. */
export function setIsolateSeed(p: Project, shotId: string, target: IsolateTarget, change: IsolateSeedChange, actor: string, now: Date): Result {
  return editIsolate(p, shotId, target, actor, now, 'isolate.seed', (doc, s) => {
    const next = { ...doc.seed, ...change };
    if (next.frame !== null && !validFrame(next.frame)) return 'Not a frame number';
    if (change.rect) {
      const parsed = IsolateRectSchema.safeParse(change.rect);
      if (!parsed.success) return `That box is not usable: ${parsed.error.issues[0]?.message ?? 'bad data'}`;
      next.rect = parsed.data;
    }
    if (next.mode === 'auto' && target === 'background') return 'A subject has no automatic seed: draw a box round it, paint it, or use a roto part.';
    if (change.partId && !rotoPart(s.roto, change.partId)) return `No roto part “${change.partId}”. Paint the subject in the Roto tab first.`;
    const details: string[] = [];
    if (next.mode !== doc.seed.mode) details.push(`seed ${doc.seed.mode} → ${next.mode}`);
    if (next.frame !== doc.seed.frame) details.push(`seed frame ${doc.seed.frame ?? 'middle'} → ${next.frame ?? 'middle'}`);
    if (JSON.stringify(next.rect) !== JSON.stringify(doc.seed.rect)) details.push(next.rect ? `box ${rectText(next.rect)}` : 'box cleared');
    if (next.partId !== doc.seed.partId) details.push(next.partId ? `roto part ${rotoPart(s.roto, next.partId)?.name ?? next.partId}` : 'roto part cleared');
    if (!details.length) return { doc, detail: 'unchanged' };
    return { doc: { ...doc, seed: next }, detail: details.join(', '), task: 'edited', settings: true };
  });
}

/** The seed frame a build uses: the chosen one inside the shot, else the middle. */
export function isolateSeedFrame(doc: Pick<IsolateDocument, 'seed'> | null | undefined, first: number, last: number): number {
  const f = doc?.seed.frame;
  if (f !== null && f !== undefined && f >= first && f <= last) return f;
  return Math.round((first + last) / 2);
}

/** Is the document seeded enough to build? (null when it is, else what is missing.) */
export function isolateSeedProblem(doc: IsolateDocument | null | undefined, target: IsolateTarget): string | null {
  const seed = doc?.seed ?? { mode: target === 'sky' ? 'auto' : 'box', rect: null, partId: null, frame: null };
  if (seed.mode === 'auto') return target === 'sky' ? null : 'Show the subject first (step 2): a box, paint, or a roto part.';
  if (seed.mode === 'box' && !seed.rect) return 'Draw a box round the subject first (step 2).';
  if (seed.mode === 'roto' && !seed.partId) return 'Choose the roto part first (step 2).';
  if (seed.mode === 'paint' && !(doc?.keyFrames ?? []).some((k) => k.strokes.some((s) => s.mode === 'include'))) return 'Paint some of the foreground in first (step 2).';
  return null;
}

// ---------------------------------------------------------------------------
// Paint (seed on the seed frame, corrections on any frame)
// ---------------------------------------------------------------------------

export type IsolateStrokeInput = Omit<RotoStroke, 'id' | 'by' | 'at'>;

/** Paint a stroke on a frame: the seed on the seed frame, a correction carried to its neighbours elsewhere. */
export function addIsolateStroke(p: Project, shotId: string, target: IsolateTarget, frame: number, stroke: IsolateStrokeInput, actor: string, now: Date): Result {
  if (!validFrame(frame)) return { ok: false, reason: 'Not a frame number' };
  const at = now.toISOString();
  return editIsolate(p, shotId, target, actor, now, 'isolate.stroke', (doc) => {
    const seq = doc.seq + 1;
    const parsed = RotoStrokeSchema.safeParse({ ...stroke, id: `s${seq}`, by: actor, at });
    if (!parsed.success) return `That stroke is not usable: ${parsed.error.issues[0]?.message ?? 'bad data'}`;
    const existing = doc.keyFrames.find((k) => k.frame === frame);
    // Paint on a frame the build already made is a correction (§11 "correction when the automated mask is wrong").
    const correction = existing?.correction ?? doc.frames.some((f) => f.frame === frame);
    if (existing && existing.strokes.length >= 500) return 'At most 500 strokes on a frame';
    if (!existing && doc.keyFrames.length >= 1000) return 'At most 1000 painted frames';
    const keyFrames = existing
      ? doc.keyFrames.map((k) => (k.frame === frame ? { ...k, strokes: [...k.strokes, parsed.data], by: actor, at } : k))
      : [...doc.keyFrames, { frame, strokes: [parsed.data], correction, by: actor, at }].sort((a, b) => a.frame - b.frame);
    const what = parsed.data.mode === 'include' ? (target === 'sky' ? 'kept in front of the sky' : 'kept as subject') : target === 'sky' ? 'made sky' : 'made background';
    return { doc: { ...doc, keyFrames, seq }, detail: `frame ${frame}: ${parsed.data.id} ${what} (${parsed.data.points.length} points, radius ${parsed.data.radius} px)${correction ? ', a correction' : ''}`, task: 'edited', settings: true };
  });
}

/** Take back the last stroke on a frame, or all of them. */
export function clearIsolateStrokes(p: Project, shotId: string, target: IsolateTarget, frame: number, which: 'last' | 'all', actor: string, now: Date): Result {
  return editIsolate(p, shotId, target, actor, now, 'isolate.strokes_cleared', (doc) => {
    const k = doc.keyFrames.find((x) => x.frame === frame);
    if (!k || !k.strokes.length) return `Nothing is painted on frame ${frame}`;
    const strokes = which === 'all' ? [] : k.strokes.slice(0, -1);
    const keyFrames = strokes.length ? doc.keyFrames.map((x) => (x.frame === frame ? { ...x, strokes } : x)) : doc.keyFrames.filter((x) => x.frame !== frame);
    return { doc: { ...doc, keyFrames }, detail: `frame ${frame}: ${which === 'all' ? `${k.strokes.length} strokes` : k.strokes.at(-1)!.id} removed`, task: 'edited', settings: true };
  });
}

/**
 * The frames a key frame's paint reaches (§11 corrections "re-propagate
 * locally", as roto): from halfway to the previous key frame to halfway to
 * the next, inside the shot.
 */
export function isolateCorrectionRange(doc: Pick<IsolateDocument, 'keyFrames'>, frame: number, first: number, last: number): { first: number; last: number } {
  const keys = [...new Set(doc.keyFrames.map((k) => k.frame))].sort((a, b) => a - b);
  const prev = [...keys].reverse().find((k) => k < frame);
  const next = keys.find((k) => k > frame);
  return { first: prev === undefined ? first : Math.max(first, Math.floor((prev + frame) / 2) + 1), last: next === undefined ? last : Math.min(last, Math.floor((frame + next) / 2)) };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface IsolateSettingsChange extends Partial<Omit<IsolateParams, 'spill'>> {
  spill?: Partial<IsolateSpill>;
  engine?: IsolateEngine;
}

export function setIsolateSettings(p: Project, shotId: string, target: IsolateTarget, change: IsolateSettingsChange, actor: string, now: Date): Result {
  return editIsolate(p, shotId, target, actor, now, 'isolate.settings', (doc) => {
    const { engine, spill, ...paramChange } = change;
    const spillParsed = IsolateSpillSchema.safeParse({ ...doc.params.spill, ...(spill ?? {}) });
    if (!spillParsed.success) return `spill.${spillParsed.error.issues[0]?.path.join('.') ?? 'value'}: ${spillParsed.error.issues[0]?.message ?? 'out of range'}`;
    if (spillParsed.data.mode === 'colour' && !spillParsed.data.rgb) return 'Choose the sky colour to unmix first';
    const parsed = IsolateParamsSchema.safeParse({ ...doc.params, ...paramChange, spill: spillParsed.data });
    if (!parsed.success) return `${parsed.error.issues[0]?.path.join('.') ?? 'value'}: ${parsed.error.issues[0]?.message ?? 'out of range'}`;
    if (engine && target === 'sky' && engine !== 'track') return 'The sky is found by its cues; the AI engine is for a subject (background removal).';
    const next: IsolateDocument = { ...doc, params: parsed.data, ...(engine ? { engine } : {}) };
    const details: string[] = [];
    if (next.engine !== doc.engine) details.push(`engine ${doc.engine} → ${next.engine}`);
    for (const k of Object.keys(paramChange) as (keyof Omit<IsolateParams, 'spill'>)[]) if (next.params[k] !== doc.params[k]) details.push(`${k} ${String(doc.params[k])} → ${String(next.params[k])}`);
    if (JSON.stringify(next.params.spill) !== JSON.stringify(doc.params.spill)) details.push(`spill ${JSON.stringify(next.params.spill)}`);
    if (!details.length) return { doc, detail: 'unchanged' };
    return { doc: next, detail: details.join(', '), task: 'edited', settings: true };
  });
}

export const ISOLATE_WORKING_WIDTHS = [640, 960, 1280, 1920] as const;

export function setIsolateWorkingWidth(p: Project, shotId: string, target: IsolateTarget, width: number, actor: string, now: Date): Result {
  if (!Number.isInteger(width) || width < 256 || width > 4096) return { ok: false, reason: 'Working width is 256 to 4096 px' };
  return editIsolate(p, shotId, target, actor, now, 'isolate.working_width', (doc) => (doc.workingWidth === width ? { doc, detail: `unchanged (${width})` } : { doc: { ...doc, workingWidth: width }, detail: `${doc.workingWidth} → ${width} px` }));
}

// ---------------------------------------------------------------------------
// Builds, confidence and problem frames (§19 "show confidence/problem areas")
// ---------------------------------------------------------------------------

const clamp01 = (v: number) => (v <= 0 ? 0 : v >= 1 ? 1 : v);

/**
 * A frame's confidence from its measurements (addendum 11 §5): how clearly
 * the two sides separate, lowered where the matte flickers against its
 * neighbours, where foreground and sky/background are close in colour, and
 * where much of the frame is uncertain edge.
 */
export function isolateConfidence(m: IsolateMetrics): number {
  let c = m.separation;
  if (m.foreground > 0.001 && m.foreground < 0.999) {
    c *= 1 - 0.5 * clamp01((m.flicker - 0.01) / 0.06);
    c *= 0.6 + 0.4 * clamp01(m.contrast / 0.15);
    c *= 1 - 0.3 * clamp01((m.edge - 0.04) / 0.1);
  }
  if (m.residualPx > 1) c *= 1 - 0.3 * clamp01((m.residualPx - 1) / 2);
  return Math.round(clamp01(c) * 1000) / 1000;
}

/** Why each frame is a problem ('' when it is not). */
export function isolateProblemReasons(records: readonly Pick<IsolateFrameRecord, 'frame' | 'confidence' | 'metrics'>[], target: IsolateTarget): Map<number, string> {
  const out = new Map<number, string>();
  const other = target === 'sky' ? 'sky' : 'background';
  for (const r of records) {
    const m = r.metrics;
    const reasons: string[] = [];
    if (r.confidence < ISOLATE_LOW_CONFIDENCE) reasons.push(`confidence ${r.confidence.toFixed(2)}`);
    // Nothing found is never taken as an answer: a foreground the cues took for sky (haze, low contrast), or a lost subject.
    if (target === 'sky' && m.foreground < 0.01) reasons.push('almost nothing found in front of the sky: check it (haze or low contrast?)');
    if (target === 'background' && m.foreground < 0.0005) reasons.push('the subject was lost on this frame: correct it with paint');
    if (m.flicker > ISOLATE_MAX_FLICKER) reasons.push(`the matte flickers against the next frame (${(m.flicker * 100).toFixed(1)} %)`);
    if (m.edge > ISOLATE_MAX_EDGE) reasons.push(`a large uncertain edge (${(m.edge * 100).toFixed(0)} % of the frame)`);
    if (m.foreground > 0.001 && m.foreground < 0.999 && m.contrast < ISOLATE_MIN_CONTRAST) reasons.push(`low contrast between the ${other} and the foreground`);
    // The sky behind an edge is filled from the sky beside it (smooth, and reliable): only a lot of it is a problem.
    if (m.unresolved > (target === 'sky' ? ISOLATE_MAX_UNSEEN_SKY : 0.02)) reasons.push(`${(m.unresolved * 100).toFixed(0)} % of the ${other} behind the ${target === 'sky' ? 'edge' : 'subject'} never seen (filled)`);
    if (m.residualPx > 1.5) reasons.push(`alignment residual ${m.residualPx.toFixed(1)} px`);
    out.set(r.frame, reasons.join('; '));
  }
  return out;
}

export interface IsolateRunResult {
  first: number;
  last: number;
  frames: { frame: number; confidence: number; metrics: IsolateMetrics }[];
  alignment: 'static' | 'homography';
  /** The settings revision the build used. */
  revision: number;
  engine: string;
  algorithm?: string;
}

/**
 * Record what a build produced: per-frame confidence and measurements and the
 * problem frames. A finished build puts the isolation up for review — never
 * approves it. A build made with an older revision of the settings is refused.
 */
export function recordIsolateRun(p: Project, shotId: string, target: IsolateTarget, result: IsolateRunResult, actor: string, now: Date): Result {
  if (!result.frames.length) return { ok: false, reason: 'The build produced no frames' };
  if (result.frames.some((f) => !validFrame(f.frame) || !(f.confidence >= 0 && f.confidence <= 1))) return { ok: false, reason: 'The build result is not usable' };
  const at = now.toISOString();
  return editIsolate(p, shotId, target, actor, now, 'isolate.built', (doc, s) => {
    if (result.revision !== doc.revision) return `That matte was built with settings revision ${result.revision}; the settings are now revision ${doc.revision}. Build again.`;
    const previous = new Map(doc.frames.map((f) => [f.frame, f]));
    const fresh = result.frames.map((f) => {
      const prev = previous.get(f.frame);
      return { frame: f.frame, confidence: Math.round(f.confidence * 1000) / 1000, metrics: f.metrics, status: prev?.status === 'flagged' ? ('flagged' as const) : ('processed' as const), reason: '', reviewed: null, note: prev?.note ?? '' };
    });
    const reasons = isolateProblemReasons(fresh, target);
    const frames = fresh.map((f) => ({ ...f, reason: reasons.get(f.frame) ?? '' })).sort((a, b) => a.frame - b.frame);
    const values = frames.map((f) => f.confidence);
    const mean = Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 1000) / 1000;
    const min = Math.round(Math.min(...values) * 1000) / 1000;
    const avg = (pick: (f: IsolateFrameRecord) => number) => Math.round((frames.reduce((a, f) => a + pick(f), 0) / frames.length) * 10_000) / 10_000;
    const problems = frames.filter((f) => f.reason).map((f) => f.frame);
    const algorithm = result.algorithm ?? `${ISOLATE_ALGORITHM.id}@${ISOLATE_ALGORITHM.version}`;
    const run = {
      algorithm,
      engine: result.engine,
      revision: result.revision,
      first: result.first,
      last: result.last,
      frames: frames.length,
      meanConfidence: mean,
      minConfidence: min,
      flicker: avg((f) => f.metrics.flicker),
      unresolved: avg((f) => f.metrics.unresolved),
      alignment: result.alignment,
      problems,
      taskVersion: isolateTaskVersion(s, target),
      at,
      by: actor,
    };
    return {
      doc: { ...doc, frames, runs: [...doc.runs, run].slice(-MAX_RUNS) },
      detail: `${frames.length} frames ${result.first}–${result.last} with ${algorithm} (${result.engine}, settings r${result.revision}): confidence mean ${mean.toFixed(2)} min ${min.toFixed(2)}, flicker ${(run.flicker * 100).toFixed(2)} %${problems.length ? `, ${problems.length} problem frame${problems.length === 1 ? '' : 's'}` : ''}`,
      task: 'review',
    };
  });
}

/** Flag a frame as needing correction, or clear the flag. */
export function flagIsolateFrame(p: Project, shotId: string, target: IsolateTarget, frame: number, note: string, actor: string, now: Date): Result {
  return editIsolate(p, shotId, target, actor, now, 'isolate.flagged', (doc) => {
    const rec = doc.frames.find((f) => f.frame === frame);
    if (!rec) return `Frame ${frame} has not been built yet`;
    const cleared = rec.status === 'flagged';
    const frames = doc.frames.map((f) => (f.frame === frame ? { ...f, status: cleared ? ('processed' as const) : ('flagged' as const), note: cleared ? f.note : note.trim(), reviewed: null } : f));
    return { doc: { ...doc, frames }, detail: `frame ${frame} ${cleared ? 'flag cleared' : `flagged${note.trim() ? `: ${note.trim()}` : ''}`}` };
  });
}

/** Record that someone looked at a built frame and accepts it. */
export function markIsolateFrameReviewed(p: Project, shotId: string, target: IsolateTarget, frame: number, actor: string, now: Date): Result {
  const at = now.toISOString();
  return editIsolate(p, shotId, target, actor, now, 'isolate.reviewed', (doc) => {
    if (!doc.frames.some((f) => f.frame === frame)) return `Frame ${frame} has not been built yet`;
    return { doc: { ...doc, frames: doc.frames.map((f) => (f.frame === frame ? { ...f, reviewed: { by: actor, at }, status: 'processed' as const } : f)) }, detail: `frame ${frame}` };
  });
}

export interface IsolateReview {
  representatives: number[];
  /** Frames to look at, worst first: flagged, then problems not yet reviewed. */
  problems: { frame: number; confidence: number; reason: string }[];
}

export function isolateReview(doc: IsolateDocument | null | undefined, first: number, last: number): IsolateReview {
  const representatives = contactSheetFrames(first, last, 10);
  if (!doc) return { representatives, problems: [] };
  const problems = doc.frames
    .filter((f) => f.frame >= first && f.frame <= last)
    .filter((f) => f.status === 'flagged' || (f.reason && !f.reviewed))
    .map((f) => ({ frame: f.frame, confidence: f.confidence, reason: f.status === 'flagged' ? `flagged${f.note ? `: ${f.note}` : ''}` : f.reason }))
    .sort((a, b) => Number(b.reason.startsWith('flagged')) - Number(a.reason.startsWith('flagged')) || a.confidence - b.confidence || a.frame - b.frame);
  return { representatives, problems };
}

export function nextIsolateProblem(review: IsolateReview, current: number): number | null {
  const frames = review.problems.map((x) => x.frame).sort((a, b) => a - b);
  if (!frames.length) return null;
  return frames.find((f) => f > current) ?? frames[0]!;
}

export interface IsolateConfidenceSummary {
  frames: number;
  mean: number;
  min: number;
  flicker: number;
  edge: number;
  unresolved: number;
  lowFrames: number[];
  problems: number[];
  flagged: number[];
  reviewed: number;
}

export function isolateConfidenceSummary(doc: IsolateDocument | null | undefined): IsolateConfidenceSummary {
  if (!doc || !doc.frames.length) return { frames: 0, mean: 0, min: 0, flicker: 0, edge: 0, unresolved: 0, lowFrames: [], problems: [], flagged: [], reviewed: 0 };
  const values = doc.frames.map((f) => f.confidence);
  const avg = (pick: (f: IsolateFrameRecord) => number) => Math.round((doc.frames.reduce((a, f) => a + pick(f), 0) / doc.frames.length) * 10_000) / 10_000;
  return {
    frames: doc.frames.length,
    mean: Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 1000) / 1000,
    min: Math.min(...values),
    flicker: avg((f) => f.metrics.flicker),
    edge: avg((f) => f.metrics.edge),
    unresolved: avg((f) => f.metrics.unresolved),
    lowFrames: doc.frames.filter((f) => f.confidence < ISOLATE_LOW_CONFIDENCE).map((f) => f.frame),
    problems: doc.frames.filter((f) => f.reason && !f.reviewed).map((f) => f.frame),
    flagged: doc.frames.filter((f) => f.status === 'flagged').map((f) => f.frame),
    reviewed: doc.frames.filter((f) => f.reviewed).length,
  };
}

// ---------------------------------------------------------------------------
// Export (§11 "export matte, isolated foreground, background/sky plate and sequence manifests separately", §17)
// ---------------------------------------------------------------------------

/** Record a written export and submit the isolation for review (never approval). */
export function recordIsolateExport(p: Project, shotId: string, target: IsolateTarget, record: IsolateExportInput, actor: string, now: Date): Result {
  const at = now.toISOString();
  const parsed = IsolateExportSchema.safeParse({ ...record, writtenAt: at, by: actor });
  if (!parsed.success) return { ok: false, reason: `The export record is not usable: ${parsed.error.issues[0]?.message ?? 'bad data'}` };
  const rec = parsed.data;
  if (rec.target !== target) return { ok: false, reason: `That export is the ${rec.target}'s, not the ${target}'s` };
  return editIsolate(p, shotId, target, actor, now, 'isolate.exported', (doc, s) => {
    const v = isolateTaskVersion(s, target);
    if (rec.version !== v) return `That export is ${versionTag(rec.version)}; the task is ${versionTag(v)}`;
    return {
      doc: { ...doc, exports: [...doc.exports.filter((e) => e.version !== rec.version), rec].sort((a, b) => a.version - b.version) },
      detail: `${versionTag(rec.version)}: ${rec.folder}, ${rec.frames} frames ${rec.first}–${rec.last} at ${rec.width}×${rec.height}, ${rec.encoding}; matte ${rec.matte}, foreground ${rec.foreground}, plate ${rec.plate}; ${rec.files} files; settings r${rec.revision}`,
      task: 'review',
    };
  });
}

/** File names (§17): `<shot>_sky_v001/` with `<shot>_sky_matte_v001.%04d.png` …; `bg` for background removal. */
export function isolateNames(target: IsolateTarget) {
  const e = ISOLATE_ELEMENT[target];
  return {
    folder: (shot: string, version: number) => `${shot}_${e}_${versionTag(version)}`,
    matteFile: (shot: string, version: number, frame: number) => frameFileName(shot, `${e}_matte`, version, frame, 'png'),
    mattePattern: (shot: string, version: number) => framePattern(shot, `${e}_matte`, version, 'png'),
    matteExrPattern: (shot: string, version: number) => framePattern(shot, `${e}_matte`, version, 'exr'),
    foregroundFile: (shot: string, version: number, frame: number, format: 'exr' | 'png') => frameFileName(shot, `${e}_fg`, version, frame, format),
    foregroundPattern: (shot: string, version: number, format: 'exr' | 'png') => framePattern(shot, `${e}_fg`, version, format),
    plateFile: (shot: string, version: number, frame: number, format: 'exr' | 'png') => frameFileName(shot, `${e}_plate`, version, frame, format),
    platePattern: (shot: string, version: number, format: 'exr' | 'png') => framePattern(shot, `${e}_plate`, version, format),
    confidenceFile: (shot: string, version: number, frame: number) => frameFileName(shot, `${e}_conf`, version, frame, 'png'),
    confidencePattern: (shot: string, version: number) => framePattern(shot, `${e}_conf`, version, 'png'),
    plateConfidenceFile: (shot: string, version: number, frame: number) => frameFileName(shot, `${e}_plateconf`, version, frame, 'png'),
    plateConfidencePattern: (shot: string, version: number) => framePattern(shot, `${e}_plateconf`, version, 'png'),
    metadata: (shot: string, version: number) => `${shot}_${e}_${versionTag(version)}.json`,
    readme: () => 'README.txt',
    /** Every file of this target's version starts with this. */
    prefix: (shot: string) => `${shot}_${e}_`,
  };
}

/** Everything that decides the pixels, for the metadata and for reproducing it (§19). */
export function isolateSettings(doc: IsolateDocument) {
  return {
    algorithm: doc.algorithm,
    revision: doc.revision,
    target: doc.target,
    seed: doc.seed,
    engine: doc.engine,
    params: doc.params,
    keyFrames: doc.keyFrames.map((k) => ({ frame: k.frame, correction: k.correction, strokes: k.strokes.map((s) => ({ id: s.id, mode: s.mode, radius: s.radius, points: s.points })) })),
  };
}

/** The sequence manifest written beside the mattes (`<shot>_sky_vNNN.json`). */
export function isolateMetadata(
  p: Project,
  shotId: string,
  target: IsolateTarget,
  info: {
    version: number;
    first: number;
    last: number;
    width: number;
    height: number;
    encoding: string;
    linear: boolean;
    source: string;
    files: Record<string, string | null>;
    format: 'exr' | 'png';
    engine: string;
    generator: string;
    writtenAt: string;
    by: string;
    perFrame: { frame: number; confidence: number; metrics: IsolateMetrics }[];
    alignment: { model: 'static' | 'homography'; reference: number; frames: { frame: number; H: number[]; residualPx: number; motionPx: number }[] };
  },
) {
  const shot = handoffShot(p, shotId);
  const s = shotState(p, shotId);
  const doc = isolateDoc(s, target);
  if (!shot || !s || !doc) throw new Error(`No ${target} isolation for ${shotId}`);
  const sky = target === 'sky';
  return {
    format: 'vcvfx.isolate/1',
    generator: info.generator,
    shot: shotName(s),
    handoffShotId: shot.shotId,
    target,
    task: ISOLATE_TASK[target],
    version: versionTag(info.version),
    writtenAt: info.writtenAt,
    by: info.by,
    engine: info.engine,
    frames: { first: info.first, last: info.last, count: info.last - info.first + 1 },
    resolution: { width: info.width, height: info.height },
    source: info.source,
    colour: {
      encoding: info.encoding,
      linear: info.linear,
      note: info.linear ? 'Scene-linear in this encoding; no display transform or look is applied.' : 'The source encoding is unknown: built on its code values, which are written as they are (not linear).',
    },
    files: info.files,
    matte: sky
      ? '16-bit PNG straight alpha of everything in front of the sky (1 = foreground: skyline, trees, wires, people; 0 = sky). The sky matte is its inverse.'
      : '16-bit PNG straight alpha of the subject (1 = subject, 0 = background).',
    foreground: info.format === 'exr' ? `RGBA half-float EXR, premultiplied by the matte, with the ${sky ? 'sky' : 'background'} unmixed out of its edge.` : 'RGBA 16-bit PNG of code values, premultiplied.',
    plate: sky
      ? 'The sky alone: where something stood in front of it, rebuilt from the frames that saw the sky there (aligned), else filled from the sky around it — see the plate confidence.'
      : 'The background alone: behind the subject, rebuilt from the frames that saw it (aligned), else filled spatially — see the plate confidence.',
    confidence: '16-bit PNG greyscale of the matte: full = sure; dark = an uncertain edge (low contrast, flicker, unmixing unsure).',
    plateConfidence: `16-bit PNG greyscale of the plate: full = seen in agreeing frames; black = never seen (filled), to paint or leave to the comp.`,
    alignment: { model: info.alignment.model, reference: info.alignment.reference, note: 'H maps reference-frame plate pixels to each frame’s plate pixels (row-major 3×3).', frames: info.alignment.frames },
    settings: isolateSettings(doc),
    confidenceSummary: isolateConfidenceSummary(doc),
    perFrame: info.perFrame.map((f) => {
      const rec = doc.frames.find((r) => r.frame === f.frame);
      return { frame: f.frame, confidence: f.confidence, metrics: f.metrics, status: rec?.status ?? 'processed', problem: rec?.reason || null, reviewed: rec?.reviewed ?? null };
    }),
    runs: doc.runs.filter((r) => r.taskVersion === info.version),
    approval: s.tasks.find((t) => t.kind === ISOLATE_TASK[target])?.approval ?? null,
  };
}
export type IsolateMetadata = ReturnType<typeof isolateMetadata>;

function manifestOf(s: ShotState, target: IsolateTarget) {
  const doc = isolateDoc(s, target);
  if (!doc) return null;
  const task = s.tasks.find((t) => t.kind === ISOLATE_TASK[target]);
  const version = task?.version ?? 1;
  const exported = doc.exports.find((e) => e.version === version) ?? null;
  const summary = isolateConfidenceSummary(doc);
  return {
    task: ISOLATE_TASK[target],
    version: versionTag(version),
    state: task?.state ?? null,
    approval: task?.approval ?? null,
    exported: exported !== null,
    folder: exported?.folder ?? null,
    matte: exported?.matte ?? null,
    matteExr: exported?.matteExr ?? null,
    foreground: exported?.foreground ?? null,
    plate: exported?.plate ?? null,
    confidenceMaps: exported?.confidence ?? null,
    plateConfidenceMaps: exported?.plateConfidence ?? null,
    metadata: exported?.metadata ?? null,
    frames: exported ? { first: exported.first, last: exported.last, count: exported.frames } : null,
    resolution: exported ? { width: exported.width, height: exported.height } : null,
    format: exported?.format ?? null,
    encoding: exported?.encoding ?? null,
    algorithm: `${doc.algorithm.id}@${doc.algorithm.version}`,
    engine: exported?.engine ?? doc.engine,
    revision: exported?.revision ?? doc.revision,
    seed: { mode: doc.seed.mode, frame: doc.seed.frame, rect: doc.seed.rect, partId: doc.seed.partId },
    corrections: doc.keyFrames.map((k) => ({ frame: k.frame, strokes: k.strokes.length, correction: k.correction })),
    params: doc.params,
    confidence: { frames: summary.frames, mean: summary.mean, min: summary.min, flicker: summary.flicker, unresolved: summary.unresolved, low: summary.lowFrames, problems: summary.problems, flagged: summary.flagged, reviewed: summary.reviewed },
  };
}

/** The isolation section of the package manifest (§18): sky and background, each null when not started. */
export function isolateManifest(s: ShotState) {
  const sky = manifestOf(s, 'sky');
  const background = manifestOf(s, 'background');
  if (!sky && !background) return null;
  return { sky, background };
}

export { rectText as isolateRectText };
