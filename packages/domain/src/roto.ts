import { contactSheetFrames, handoffShot, shotState, type LogEntry, type Project, type Result, type ShotState } from './project.js';
import { frameFileName, framePattern, versionTag } from './frames.js';
import {
  DEFAULT_REFINE,
  ROOT_PART_ID,
  ROTO_FORMAT_VERSION,
  ROTO_PART_ID,
  RotoExportSchema,
  type RotoCombine,
  type RotoDirection,
  type RotoDocument,
  type RotoEngineRef,
  type RotoExportInput,
  type RotoFrameRecord,
  type RotoKeyFrame,
  type RotoPart,
  type RotoPoint,
  type RotoRefine,
  type RotoStroke,
} from './roto-schema.js';

export * from './roto-schema.js';

/**
 * Paint-to-roto as a model (master spec §5, §5.1, §5.2, §15, §19; addendum 04).
 *
 * Every mutation is pure, returns a new project, and is logged with who and
 * when. The rules:
 *  - roto work is the shot's `roto` task: painting moves it into processing,
 *    a finished propagation or export puts it up for review, and nothing here
 *    approves it — approval is `approveTask`, a named human act;
 *  - approved mattes are never edited in place: every edit is refused until
 *    the task is reopened, which bumps its version (`setTaskState`), so the
 *    next export writes `v002` beside the approved `v001`;
 *  - strokes and settings are what the matte is reproduced from (§19); the
 *    masks themselves are files, never in the project.
 */

const MAX_RUNS = 500;
export const ROTO_PALETTE = ['#3ad07a', '#4aa3ff', '#ffb02e', '#e85dff', '#ff5f56', '#2ee6d6', '#c9e04a', '#ff8fb1'] as const;

/** Confidence below which a frame is counted as a problem. */
export const LOW_CONFIDENCE = 0.6;

// ---------------------------------------------------------------------------
// Small helpers shared by the mutations
// ---------------------------------------------------------------------------

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

export function newRotoDocument(): RotoDocument {
  return {
    formatVersion: ROTO_FORMAT_VERSION,
    parts: [
      {
        id: ROOT_PART_ID,
        name: 'Subject',
        parentId: null,
        combine: 'union',
        color: ROTO_PALETTE[0],
        visible: true,
        keyFrames: [],
        refine: { ...DEFAULT_REFINE },
        engine: { id: 'track', version: '', settings: {} },
        frames: [],
      },
    ],
    runs: [],
    exports: [],
    workingWidth: 1920,
    seq: 0,
  };
}

/** Why roto on this shot cannot be changed right now, or null. */
export function rotoLocked(s: ShotState): string | null {
  if (s.stage !== 'prep') return `${s.vfxShotId ?? s.shotId} is ${s.stage}; reopen it before changing its roto`;
  const task = s.tasks.find((t) => t.kind === 'roto');
  if (!task) return `${s.vfxShotId ?? s.shotId} has no Paint-to-roto task. Add it first.`;
  if (task.state === 'approved') return `Roto ${versionTag(task.version)} is approved. Reopen it (Needs correction) to make ${versionTag(task.version + 1)}; the approved mattes are kept.`;
  return null;
}

export function rotoTaskVersion(s: ShotState): number {
  return s.tasks.find((t) => t.kind === 'roto')?.version ?? 1;
}

export function rotoPart(doc: RotoDocument | null | undefined, partId: string): RotoPart | undefined {
  return doc?.parts.find((x) => x.id === partId);
}

/**
 * Change a shot's roto document. Starts one (with the overall subject part)
 * when the shot has none. `fn` returns the new document or a refusal; it also
 * says how the task should move. Refused while the roto is locked.
 */
function editRoto(
  p: Project,
  shotId: string,
  actor: string,
  now: Date,
  action: string,
  fn: (doc: RotoDocument, s: ShotState) => { doc: RotoDocument; detail: string; task?: 'painted' | 'review' } | string,
): Result {
  const at = now.toISOString();
  let detail = '';
  let started = false;
  let taskMove: string | null = null;
  const r = withShot(p, shotId, (s) => {
    const locked = rotoLocked(s);
    if (locked) return locked;
    started = s.roto === null;
    const out = fn(s.roto ?? newRotoDocument(), s);
    if (typeof out === 'string') return out;
    detail = out.detail;
    let tasks = s.tasks;
    if (out.task) {
      tasks = s.tasks.map((t) => {
        if (t.kind !== 'roto') return t;
        // Painting starts the work, or reopens a review for correction; processing finishing goes to review (§15.6).
        const next = out.task === 'review' ? 'needs_review' : t.state === 'pending' ? 'processing' : t.state === 'needs_review' ? 'needs_correction' : t.state;
        if (next !== t.state) taskMove = `roto → ${next}`;
        return next === t.state ? t : { ...t, state: next };
      });
    }
    return { ...s, tasks, roto: out.doc };
  });
  if (!r.ok) return r;
  let out = r.project;
  if (started) out = logged(out, { at, actor, shotId, action: 'roto.started', detail: 'Paint-to-roto document with the overall subject part' });
  out = logged(out, { at, actor, shotId, action, detail });
  if (taskMove) out = logged(out, { at, actor, shotId, action: 'task.state', detail: taskMove });
  return { ok: true, project: out };
}

const replacePart = (doc: RotoDocument, part: RotoPart): RotoDocument => ({ ...doc, parts: doc.parts.map((x) => (x.id === part.id ? part : x)) });

function needPart(doc: RotoDocument, partId: string): RotoPart | string {
  return rotoPart(doc, partId) ?? `No roto part “${partId}”`;
}

const validFrame = (frame: number) => Number.isInteger(frame) && frame >= 0;

// ---------------------------------------------------------------------------
// Parts (§5.1)
// ---------------------------------------------------------------------------

/** A file-name-safe id for a part name, unique in the document. */
export function partIdFor(doc: RotoDocument, name: string): string {
  const base =
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 24) || 'part';
  const stem = /^[a-z0-9]/.test(base) ? base : `p${base}`;
  let id = stem;
  for (let n = 2; doc.parts.some((x) => x.id === id); n += 1) id = `${stem}_${n}`;
  return id;
}

export function addPart(
  p: Project,
  shotId: string,
  input: { name: string; parentId?: string; combine?: RotoCombine; color?: string },
  actor: string,
  now: Date,
): Result {
  const name = input.name.trim();
  if (!name) return { ok: false, reason: 'A roto part needs a name' };
  if (name.length > 64) return { ok: false, reason: 'A part name is at most 64 characters' };
  return editRoto(p, shotId, actor, now, 'roto.part_added', (doc) => {
    const parentId = input.parentId ?? ROOT_PART_ID;
    if (!rotoPart(doc, parentId)) return `No roto part “${parentId}” to put it under`;
    if (doc.parts.some((x) => x.name.toLowerCase() === name.toLowerCase())) return `There is already a part called ${name}`;
    if (doc.parts.length >= 32) return 'A shot has at most 32 roto parts';
    const id = partIdFor(doc, name);
    const color = input.color && /^#[0-9a-fA-F]{6}$/.test(input.color) ? input.color : ROTO_PALETTE[doc.parts.length % ROTO_PALETTE.length]!;
    const part: RotoPart = {
      id,
      name,
      parentId,
      combine: input.combine ?? 'union',
      color,
      visible: true,
      keyFrames: [],
      refine: { ...DEFAULT_REFINE },
      engine: { ...(rotoPart(doc, ROOT_PART_ID)?.engine ?? { id: 'track', version: '', settings: {} }) },
      frames: [],
    };
    return { doc: { ...doc, parts: [...doc.parts, part] }, detail: `${name} (${id}) under ${rotoPart(doc, parentId)!.name}, ${part.combine}` };
  });
}

export function renamePart(p: Project, shotId: string, partId: string, name: string, actor: string, now: Date): Result {
  const next = name.trim();
  if (!next) return { ok: false, reason: 'A roto part needs a name' };
  return editRoto(p, shotId, actor, now, 'roto.part_renamed', (doc) => {
    const part = needPart(doc, partId);
    if (typeof part === 'string') return part;
    if (doc.parts.some((x) => x.id !== partId && x.name.toLowerCase() === next.toLowerCase())) return `There is already a part called ${next}`;
    // The id names the files and stays; only the label changes.
    return { doc: replacePart(doc, { ...part, name: next }), detail: `${part.name} → ${next} (${partId})` };
  });
}

export function removePart(p: Project, shotId: string, partId: string, actor: string, now: Date): Result {
  return editRoto(p, shotId, actor, now, 'roto.part_removed', (doc) => {
    const part = needPart(doc, partId);
    if (typeof part === 'string') return part;
    if (part.parentId === null) return 'The overall subject matte cannot be removed';
    const children = doc.parts.filter((x) => x.parentId === partId);
    if (children.length) return `Remove ${children.map((c) => c.name).join(', ')} first`;
    return { doc: { ...doc, parts: doc.parts.filter((x) => x.id !== partId) }, detail: `${part.name} (${partId}), ${part.keyFrames.length} key frames` };
  });
}

/** Combine mode, colour, visibility, refinement and engine of one part. */
export function setPartSettings(
  p: Project,
  shotId: string,
  partId: string,
  change: { combine?: RotoCombine; color?: string; visible?: boolean; refine?: Partial<RotoRefine>; engine?: Partial<RotoEngineRef> },
  actor: string,
  now: Date,
): Result {
  return editRoto(p, shotId, actor, now, 'roto.part_settings', (doc) => {
    const part = needPart(doc, partId);
    if (typeof part === 'string') return part;
    const details: string[] = [];
    let next = part;
    if (change.combine && change.combine !== part.combine) {
      if (part.parentId === null) return 'The overall subject matte is not combined into anything';
      next = { ...next, combine: change.combine };
      details.push(`combine ${change.combine}`);
    }
    if (change.color && change.color !== part.color) {
      if (!/^#[0-9a-fA-F]{6}$/.test(change.color)) return 'A colour is #rrggbb';
      next = { ...next, color: change.color };
      details.push(`colour ${change.color}`);
    }
    if (change.visible !== undefined && change.visible !== part.visible) {
      next = { ...next, visible: change.visible };
      details.push(change.visible ? 'shown' : 'hidden');
    }
    if (change.refine) {
      const refine = { ...part.refine, ...change.refine };
      if (refine.featherPx < 0 || refine.featherPx > 64) return 'Feather is 0 to 64 px';
      if (refine.shrinkGrowPx < -64 || refine.shrinkGrowPx > 64) return 'Shrink/grow is −64 to 64 px';
      if (refine.temporalSmoothing < 0 || refine.temporalSmoothing > 1) return 'Temporal smoothing is 0 to 1';
      for (const k of Object.keys(change.refine) as (keyof RotoRefine)[]) if (refine[k] !== part.refine[k]) details.push(`${k} ${String(refine[k])}`);
      next = { ...next, refine };
    }
    if (change.engine) {
      const engine = { ...part.engine, ...change.engine, settings: { ...part.engine.settings, ...(change.engine.settings ?? {}) } };
      if (engine.id !== part.engine.id) details.push(`engine ${engine.id}`);
      next = { ...next, engine };
    }
    if (next === part) return { doc, detail: `${part.name}: unchanged` };
    return { doc: replacePart(doc, next), detail: `${part.name}: ${details.join(', ') || 'engine settings'}` };
  });
}

// ---------------------------------------------------------------------------
// Strokes and key frames (§5, §5.2)
// ---------------------------------------------------------------------------

function perpendicular(p: RotoPoint, a: RotoPoint, b: RotoPoint): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  return Math.abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]) / len;
}

/** Ramer–Douglas–Peucker: the polyline with points closer than `tolerance` to it removed. */
export function simplifyPolyline(points: readonly RotoPoint[], tolerance: number): RotoPoint[] {
  if (points.length <= 2) return points.map((q) => [q[0], q[1]] as RotoPoint);
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let worst = -1;
    let at = -1;
    for (let i = a + 1; i < b; i += 1) {
      const d = perpendicular(points[i]!, points[a]!, points[b]!);
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
    if (at >= 0 && worst > tolerance) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  return points.filter((_, i) => keep[i]).map((q) => [q[0], q[1]] as RotoPoint);
}

const round2 = (v: number) => Math.round(v * 2) / 2;

/** A stroke as stored: simplified to a quarter of its radius (at most 1 px), rounded to half pixels. */
export function normaliseStrokePoints(points: readonly RotoPoint[], radius: number): RotoPoint[] {
  const finite = points.filter((q) => Number.isFinite(q[0]) && Number.isFinite(q[1]));
  const simplified = simplifyPolyline(finite, Math.min(1, radius / 4));
  const out: RotoPoint[] = [];
  for (const q of simplified) {
    const r: RotoPoint = [round2(q[0]), round2(q[1])];
    const last = out[out.length - 1];
    if (!last || last[0] !== r[0] || last[1] !== r[1]) out.push(r);
  }
  return out;
}

function upsertKeyFrame(part: RotoPart, frame: number, fn: (k: RotoKeyFrame | undefined) => RotoKeyFrame | null): RotoPart {
  const existing = part.keyFrames.find((k) => k.frame === frame);
  const next = fn(existing);
  const keyFrames = part.keyFrames.filter((k) => k.frame !== frame);
  if (next) keyFrames.push(next);
  keyFrames.sort((a, b) => a.frame - b.frame);
  // The frame's status follows: a key painted where propagation had already been is a correction.
  let frames = part.frames;
  if (next) {
    const rec = part.frames.find((f) => f.frame === frame);
    const status = next.correction ? 'corrected' : 'key';
    frames = rec ? part.frames.map((f) => (f.frame === frame ? { ...f, status, reviewed: null } : f)) : part.frames;
  } else if (existing) {
    frames = part.frames.map((f) => (f.frame === frame && (f.status === 'key' || f.status === 'corrected') ? { ...f, status: 'propagated' as const } : f));
  }
  return { ...part, keyFrames, frames };
}

export function addStroke(
  p: Project,
  shotId: string,
  partId: string,
  frame: number,
  stroke: { mode: 'include' | 'exclude'; radius: number; points: readonly RotoPoint[] },
  actor: string,
  now: Date,
): Result {
  if (!validFrame(frame)) return { ok: false, reason: 'Not a frame number' };
  if (!(stroke.radius > 0 && stroke.radius <= 2000)) return { ok: false, reason: 'Brush size is 1 to 2000 px' };
  const points = normaliseStrokePoints(stroke.points, stroke.radius);
  if (points.length === 0) return { ok: false, reason: 'An empty stroke' };
  if (points.length > 4000) return { ok: false, reason: 'That stroke is too long; paint it in pieces' };
  const at = now.toISOString();
  return editRoto(p, shotId, actor, now, 'roto.stroke', (doc) => {
    const part = needPart(doc, partId);
    if (typeof part === 'string') return part;
    const seq = doc.seq + 1;
    const record: RotoStroke = { id: `s${seq}`, mode: stroke.mode, radius: stroke.radius, points, by: actor, at };
    const covered = part.frames.some((f) => f.frame === frame && f.status !== 'key' && f.status !== 'corrected');
    if ((part.keyFrames.find((k) => k.frame === frame)?.strokes.length ?? 0) >= 500) return 'A key frame holds at most 500 strokes';
    const next = upsertKeyFrame(part, frame, (k) => (k ? { ...k, strokes: [...k.strokes, record] } : { frame, strokes: [record], correction: covered, by: actor, at }));
    return {
      doc: { ...replacePart(doc, next), seq },
      detail: `${part.name} frame ${frame}: ${stroke.mode} stroke, ${points.length} points, radius ${stroke.radius}px${covered ? ' (correction)' : ''}`,
      task: 'painted',
    };
  });
}

/** The strokes with every point within `radius` of the eraser path removed; strokes split where they are cut. */
export function eraseFromStrokes(strokes: readonly RotoStroke[], path: readonly RotoPoint[], radius: number, nextId: () => string): RotoStroke[] {
  const near = (q: RotoPoint) => path.some((e) => Math.hypot(e[0] - q[0], e[1] - q[1]) <= radius);
  const out: RotoStroke[] = [];
  for (const s of strokes) {
    let run: RotoPoint[] = [];
    const runs: RotoPoint[][] = [];
    for (const q of s.points) {
      if (near(q)) {
        if (run.length) runs.push(run);
        run = [];
      } else run.push(q);
    }
    if (run.length) runs.push(run);
    if (runs.length === 1 && runs[0]!.length === s.points.length) out.push(s);
    else runs.forEach((r, i) => out.push({ ...s, id: i === 0 ? s.id : nextId(), points: r }));
  }
  return out;
}

export function eraseStrokes(p: Project, shotId: string, partId: string, frame: number, path: readonly RotoPoint[], radius: number, actor: string, now: Date): Result {
  if (!validFrame(frame)) return { ok: false, reason: 'Not a frame number' };
  if (path.length === 0 || !(radius > 0)) return { ok: false, reason: 'Nothing to erase' };
  return editRoto(p, shotId, actor, now, 'roto.erase', (doc) => {
    const part = needPart(doc, partId);
    if (typeof part === 'string') return part;
    const key = part.keyFrames.find((k) => k.frame === frame);
    if (!key || key.strokes.length === 0) return `${part.name} has no strokes on frame ${frame}`;
    let seq = doc.seq;
    const strokes = eraseFromStrokes(key.strokes, path, radius, () => `s${(seq += 1)}`);
    const before = key.strokes.reduce((n, s) => n + s.points.length, 0);
    const after = strokes.reduce((n, s) => n + s.points.length, 0);
    if (before === after) return { doc, detail: `${part.name} frame ${frame}: nothing under the eraser` };
    return { doc: { ...replacePart(doc, upsertKeyFrame(part, frame, (k) => ({ ...k!, strokes }))), seq }, detail: `${part.name} frame ${frame}: erased ${before - after} points`, task: 'painted' };
  });
}

/** Remove every stroke on a key frame. The frame stays a key frame — its matte as it stands is the reference. */
export function clearStrokes(p: Project, shotId: string, partId: string, frame: number, actor: string, now: Date): Result {
  return editRoto(p, shotId, actor, now, 'roto.strokes_cleared', (doc) => {
    const part = needPart(doc, partId);
    if (typeof part === 'string') return part;
    const key = part.keyFrames.find((k) => k.frame === frame);
    if (!key) return `Frame ${frame} is not a key frame of ${part.name}`;
    return { doc: replacePart(doc, upsertKeyFrame(part, frame, (k) => ({ ...k!, strokes: [] }))), detail: `${part.name} frame ${frame}: ${key.strokes.length} strokes cleared`, task: 'painted' };
  });
}

/**
 * Mark a frame as a key (reference) frame (§5.2 "marks a new reference/key
 * frame"). With no strokes, propagation starts from the matte it has now.
 */
export function setKeyFrame(p: Project, shotId: string, partId: string, frame: number, actor: string, now: Date): Result {
  if (!validFrame(frame)) return { ok: false, reason: 'Not a frame number' };
  const at = now.toISOString();
  return editRoto(p, shotId, actor, now, 'roto.key_frame', (doc) => {
    const part = needPart(doc, partId);
    if (typeof part === 'string') return part;
    if (part.keyFrames.some((k) => k.frame === frame)) return { doc, detail: `${part.name} frame ${frame} is already a key frame` };
    const covered = part.frames.some((f) => f.frame === frame);
    if (!covered) return `Frame ${frame} of ${part.name} has no matte yet. Paint it to make it a key frame.`;
    return { doc: replacePart(doc, upsertKeyFrame(part, frame, () => ({ frame, strokes: [], correction: true, by: actor, at }))), detail: `${part.name} frame ${frame} accepted as a reference`, task: 'painted' };
  });
}

export function removeKeyFrame(p: Project, shotId: string, partId: string, frame: number, actor: string, now: Date): Result {
  return editRoto(p, shotId, actor, now, 'roto.key_frame_removed', (doc) => {
    const part = needPart(doc, partId);
    if (typeof part === 'string') return part;
    if (!part.keyFrames.some((k) => k.frame === frame)) return `Frame ${frame} is not a key frame of ${part.name}`;
    return { doc: replacePart(doc, upsertKeyFrame(part, frame, () => null)), detail: `${part.name} frame ${frame}`, task: 'painted' };
  });
}

// ---------------------------------------------------------------------------
// Propagation results, review and export (§5.2, §15)
// ---------------------------------------------------------------------------

export interface RotoPropagationResult {
  partId: string;
  engine: { id: RotoEngineRef['id']; version: string; settings?: Record<string, number | string | boolean> };
  direction: RotoDirection;
  /** The key frame it started from. */
  from: number;
  frames: { frame: number; confidence: number }[];
}

/**
 * Record what a propagation produced: per-frame confidence and which engine
 * made it. Key and corrected frames keep their status; flagged frames stay
 * flagged until someone looks again; reviews of re-made frames are cleared.
 * Processing finishing puts the task up for review — never approves it.
 */
export function recordPropagation(p: Project, shotId: string, result: RotoPropagationResult, actor: string, now: Date): Result {
  if (result.frames.length === 0) return { ok: false, reason: 'The propagation produced no frames' };
  if (result.frames.some((f) => !validFrame(f.frame) || !(f.confidence >= 0 && f.confidence <= 1))) return { ok: false, reason: 'The propagation result is not usable' };
  const at = now.toISOString();
  const engine = `${result.engine.id}@${result.engine.version || '?'}`;
  return editRoto(p, shotId, actor, now, 'roto.propagated', (doc, s) => {
    const part = needPart(doc, result.partId);
    if (typeof part === 'string') return part;
    const byFrame = new Map(part.frames.map((f) => [f.frame, f]));
    const keys = new Set(part.keyFrames.map((k) => k.frame));
    for (const f of result.frames) {
      const prev = byFrame.get(f.frame);
      const key = part.keyFrames.find((k) => k.frame === f.frame);
      const status: RotoFrameRecord['status'] = prev?.status === 'flagged' ? 'flagged' : keys.has(f.frame) ? (key?.correction ? 'corrected' : 'key') : 'propagated';
      byFrame.set(f.frame, { frame: f.frame, status, confidence: Math.round(f.confidence * 1000) / 1000, engine, from: result.from, reviewed: null, note: prev?.note ?? '' });
    }
    const frames = [...byFrame.values()].sort((a, b) => a.frame - b.frame);
    const values = result.frames.map((f) => f.confidence);
    const sorted = result.frames.map((f) => f.frame).sort((a, b) => a - b);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const min = Math.min(...values);
    const run = {
      partId: part.id,
      engine,
      settings: result.engine.settings ?? {},
      direction: result.direction,
      from: result.from,
      first: sorted[0]!,
      last: sorted[sorted.length - 1]!,
      frames: values.length,
      meanConfidence: Math.round(mean * 1000) / 1000,
      minConfidence: Math.round(min * 1000) / 1000,
      taskVersion: rotoTaskVersion(s),
      at,
      by: actor,
    };
    const low = result.frames.filter((f) => f.confidence < LOW_CONFIDENCE).length;
    return {
      doc: { ...replacePart(doc, { ...part, frames, engine: { ...part.engine, id: result.engine.id, version: result.engine.version, settings: { ...part.engine.settings, ...(result.engine.settings ?? {}) } } }), runs: [...doc.runs, run].slice(-MAX_RUNS) },
      detail: `${part.name} ${result.direction} from ${result.from}: ${values.length} frames ${run.first}–${run.last} with ${engine}, confidence mean ${run.meanConfidence.toFixed(2)} min ${run.minConfidence.toFixed(2)}${low ? `, ${low} below ${LOW_CONFIDENCE}` : ''}`,
      // Segmenting the key frame while painting is part of painting; a finished propagation goes to review.
      ...(result.direction === 'key' ? {} : { task: 'review' as const }),
    };
  });
}

/**
 * Confidence of the frames a propagation from `from` would compete with: those
 * whose matte came from another key frame. A correction replaces them only
 * where it does better (engine.ts `runRoto`), so re-propagating locally never
 * spoils good frames that belong to a neighbouring key.
 *
 * Only a matte that reached its frame without passing `from` competes. One
 * carried from a key on the far side of `from` was propagated through the
 * matte this key frame now replaces, and one from a key that is no longer a
 * key has no key behind it: both are stale and are replaced whatever their
 * confidence (on real footage a stale matte can be confidently wrong — a
 * runner's matte left on the wall behind him as he leaves frame).
 */
export function rivalFrames(part: Pick<RotoPart, 'frames' | 'keyFrames'>, from: number): Record<number, number> {
  const keys = new Set(part.keyFrames.map((k) => k.frame));
  const out: Record<number, number> = {};
  for (const f of part.frames) {
    if (f.from === null || f.from === from || f.frame === from || !keys.has(f.from)) continue;
    if ((f.from - from) * (f.frame - from) > 0) out[f.frame] = f.confidence;
  }
  return out;
}

/**
 * Whether painting on this key frame edits the matte the frame already has
 * (a correction of a usable matte) rather than segmenting from the paint
 * alone: a correction key whose matte had a confidence of at least 0.3. A
 * frame where propagation had failed outright starts again from the paint.
 */
export function editsMatte(part: Pick<RotoPart, 'keyFrames' | 'frames'>, frame: number): boolean {
  const key = part.keyFrames.find((k) => k.frame === frame);
  const rec = part.frames.find((f) => f.frame === frame);
  return Boolean(key?.correction && rec && rec.confidence >= 0.3);
}

export const ROTO_WORKING_WIDTHS = [960, 1280, 1920, 2560] as const;

/**
 * The longest edge the engines work at (never more than the plate). Mattes
 * already made stay as they are and are scaled when read; exports are always
 * at plate resolution.
 */
export function setRotoWorkingWidth(p: Project, shotId: string, width: number, actor: string, now: Date): Result {
  if (!Number.isInteger(width) || width < 256 || width > 8192) return { ok: false, reason: 'Working width is 256 to 8192 px' };
  return editRoto(p, shotId, actor, now, 'roto.working_width', (doc) => (doc.workingWidth === width ? { doc, detail: `unchanged (${width})` } : { doc: { ...doc, workingWidth: width }, detail: `${doc.workingWidth} → ${width} px` }));
}

/** Record that someone looked at a frame and accepts it (one part, or every part with a matte there). */
export function markFrameReviewed(p: Project, shotId: string, partId: string | null, frame: number, actor: string, now: Date): Result {
  const at = now.toISOString();
  return editRoto(p, shotId, actor, now, 'roto.reviewed', (doc) => {
    const ids = partId ? [partId] : doc.parts.map((x) => x.id);
    let touched = 0;
    const parts = doc.parts.map((part) => {
      if (!ids.includes(part.id)) return part;
      if (!part.frames.some((f) => f.frame === frame)) return part;
      touched += 1;
      return {
        ...part,
        frames: part.frames.map((f) => (f.frame === frame ? { ...f, reviewed: { by: actor, at }, status: f.status === 'flagged' ? (part.keyFrames.some((k) => k.frame === frame) ? ('key' as const) : ('propagated' as const)) : f.status } : f)),
      };
    });
    if (!touched) return `No matte on frame ${frame} to review`;
    return { doc: { ...doc, parts }, detail: `frame ${frame}${partId ? ` (${rotoPart(doc, partId)?.name ?? partId})` : ' (all parts)'}` };
  });
}

/** Flag a frame as needing correction, or clear the flag. */
export function flagFrame(p: Project, shotId: string, partId: string, frame: number, note: string, actor: string, now: Date): Result {
  let cleared = false;
  return editRoto(p, shotId, actor, now, 'roto.flagged', (doc) => {
    const part = needPart(doc, partId);
    if (typeof part === 'string') return part;
    const rec = part.frames.find((f) => f.frame === frame);
    if (!rec) return `${part.name} has no matte on frame ${frame}`;
    cleared = rec.status === 'flagged';
    const key = part.keyFrames.find((k) => k.frame === frame);
    const status: RotoFrameRecord['status'] = cleared ? (key ? (key.correction ? 'corrected' : 'key') : 'propagated') : 'flagged';
    const frames = part.frames.map((f) => (f.frame === frame ? { ...f, status, note: cleared ? f.note : note.trim(), reviewed: null } : f));
    return { doc: replacePart(doc, { ...part, frames }), detail: `${part.name} frame ${frame} ${cleared ? 'flag cleared' : `flagged${note.trim() ? `: ${note.trim()}` : ''}`}` };
  });
}

/** Record a written export and submit the roto for review (never approval). */
export function recordRotoExport(p: Project, shotId: string, record: RotoExportInput, actor: string, now: Date): Result {
  const at = now.toISOString();
  const parsed = RotoExportSchema.safeParse({ ...record, writtenAt: at, by: actor });
  if (!parsed.success) return { ok: false, reason: `The export record is not usable: ${parsed.error.issues[0]?.message ?? 'bad data'}` };
  const rec = parsed.data;
  return editRoto(p, shotId, actor, now, 'roto.exported', (doc, s) => {
    if (rec.version !== rotoTaskVersion(s)) return `Those mattes are ${versionTag(rec.version)}; the roto task is ${versionTag(rotoTaskVersion(s))}`;
    return {
      doc: { ...doc, exports: [...doc.exports.filter((e) => e.version !== rec.version), rec].sort((a, b) => a.version - b.version) },
      detail: `${versionTag(rec.version)}: ${rec.pattern}, ${rec.parts.length} part${rec.parts.length === 1 ? '' : 's'}, ${rec.frames} frames ${rec.first}–${rec.last} at ${rec.width}×${rec.height}, ${rec.bitDepth}-bit${rec.exr ? ' + EXR' : ''}; confidence mean ${rec.confidence.mean.toFixed(2)} min ${rec.confidence.min.toFixed(2)}; ${rec.engines.join(', ')}`,
      task: 'review',
    };
  });
}

// ---------------------------------------------------------------------------
// Pure queries
// ---------------------------------------------------------------------------

/** Parts parents-first, children in document order. */
export function partsInOrder(doc: RotoDocument): RotoPart[] {
  const out: RotoPart[] = [];
  const visit = (parentId: string | null, depth: number) => {
    for (const part of doc.parts.filter((x) => x.parentId === parentId)) {
      out.push(part);
      if (depth < 16) visit(part.id, depth + 1);
    }
  };
  visit(null, 0);
  return out;
}

export function partDepth(doc: RotoDocument, partId: string): number {
  let depth = 0;
  let part = rotoPart(doc, partId);
  while (part?.parentId && depth < 16) {
    depth += 1;
    part = rotoPart(doc, part.parentId);
  }
  return depth;
}

/**
 * The frames a propagation from key frame `from` covers (§5.2 "corrections
 * re-propagate locally"): forward up to the frame before the next key's half
 * of the gap, backward down to just past the previous key's. A frame halfway
 * between two keys goes to the earlier one.
 */
export function propagationRange(part: Pick<RotoPart, 'keyFrames'>, from: number, direction: RotoDirection, first: number, last: number): { first: number; last: number } | null {
  if (direction === 'key') return { first: from, last: from };
  const keys = [...new Set(part.keyFrames.map((k) => k.frame))].sort((a, b) => a - b);
  if (direction === 'forward') {
    const next = keys.find((k) => k > from);
    const end = next === undefined ? last : Math.floor((from + next) / 2);
    return end > from ? { first: from + 1, last: Math.min(last, end) } : null;
  }
  const prev = [...keys].reverse().find((k) => k < from);
  const start = prev === undefined ? first : Math.floor((prev + from) / 2) + 1;
  return start < from ? { first: Math.max(first, start), last: from - 1 } : null;
}

export interface ReviewFrames {
  /** Evenly spread over the shot, first and last included (§5.2 contact sheet). */
  representatives: number[];
  /** The lowest-confidence frames, worst first. */
  lowest: { frame: number; confidence: number }[];
  /**
   * Frames most likely to need correction, worst first: flagged ones, then
   * those below `threshold` or dropping sharply from their neighbours; frames
   * already reviewed, and key frames, are left out.
   */
  problems: { frame: number; confidence: number; reason: string }[];
  /** Representatives and lowest together, sorted: the contact sheet. */
  sheet: number[];
}

/** One confidence per frame for a set of parts: the worst part decides. */
export function frameConfidence(doc: RotoDocument, partId: string | null): Map<number, { confidence: number; flagged: boolean; reviewed: boolean; key: boolean; note: string }> {
  const out = new Map<number, { confidence: number; flagged: boolean; reviewed: boolean; key: boolean; note: string }>();
  for (const part of doc.parts) {
    if (partId && part.id !== partId) continue;
    for (const f of part.frames) {
      const prev = out.get(f.frame);
      const key = f.status === 'key' || f.status === 'corrected';
      if (!prev) out.set(f.frame, { confidence: f.confidence, flagged: f.status === 'flagged', reviewed: f.reviewed !== null, key, note: f.note });
      else
        out.set(f.frame, {
          confidence: Math.min(prev.confidence, f.confidence),
          flagged: prev.flagged || f.status === 'flagged',
          reviewed: prev.reviewed && f.reviewed !== null,
          key: prev.key && key,
          note: prev.note || f.note,
        });
    }
  }
  return out;
}

export function reviewFrames(doc: RotoDocument, partId: string | null, first: number, last: number, options: { sheetCount?: number; lowestCount?: number; threshold?: number } = {}): ReviewFrames {
  const threshold = options.threshold ?? LOW_CONFIDENCE;
  const conf = frameConfidence(doc, partId);
  const representatives = contactSheetFrames(first, last, options.sheetCount ?? 10);
  const entries = [...conf.entries()].filter(([f]) => f >= first && f <= last).sort((a, b) => a[0] - b[0]);
  const lowest = entries
    .filter(([, v]) => !v.key)
    .map(([frame, v]) => ({ frame, confidence: v.confidence }))
    .sort((a, b) => a.confidence - b.confidence || a.frame - b.frame)
    .slice(0, options.lowestCount ?? 6);
  const problems: ReviewFrames['problems'] = [];
  entries.forEach(([frame, v], i) => {
    if (v.reviewed && !v.flagged) return;
    if (v.flagged) return void problems.push({ frame, confidence: v.confidence, reason: v.note ? `flagged: ${v.note}` : 'flagged' });
    if (v.key) return;
    const before = entries[i - 1]?.[1].confidence;
    const after = entries[i + 1]?.[1].confidence;
    const neighbour = Math.max(before ?? 0, after ?? 0);
    if (v.confidence < threshold) problems.push({ frame, confidence: v.confidence, reason: `confidence ${v.confidence.toFixed(2)}` });
    else if (neighbour - v.confidence > 0.2) problems.push({ frame, confidence: v.confidence, reason: `drops ${(neighbour - v.confidence).toFixed(2)} from its neighbours` });
  });
  problems.sort((a, b) => Number(b.reason.startsWith('flagged')) - Number(a.reason.startsWith('flagged')) || a.confidence - b.confidence || a.frame - b.frame);
  const sheet = [...new Set([...representatives, ...lowest.map((l) => l.frame)])].sort((a, b) => a - b);
  return { representatives, lowest, problems, sheet };
}

/** The next problem frame after `current` (wrapping), or null when there are none. */
export function nextProblemFrame(review: ReviewFrames, current: number): number | null {
  const frames = review.problems.map((x) => x.frame).sort((a, b) => a - b);
  if (!frames.length) return null;
  return frames.find((f) => f > current) ?? frames[0]!;
}

/**
 * Combine part mattes into the subject matte (§5.1 "component mattes combined
 * into the final subject matte"). A part's matte is its own (when it has one)
 * united with its `union` children and with its `subtract` children cut out.
 * Alphas are 0…255, all the same size. Hidden parts still count: visibility is
 * for looking.
 */
export function combineAlpha(doc: RotoDocument, length: number, own: (partId: string) => Uint8Array | null, rootId: string = ROOT_PART_ID): Uint8Array {
  return combineInto(doc, own, () => new Uint8Array(length), 255, rootId);
}

/** The same, for 16-bit alphas (0…65535), as exported. */
export function combineAlpha16(doc: RotoDocument, length: number, own: (partId: string) => Uint16Array | null, rootId: string = ROOT_PART_ID): Uint16Array {
  return combineInto(doc, own, () => new Uint16Array(length), 65535, rootId);
}

function combineInto<T extends Uint8Array | Uint16Array>(doc: RotoDocument, own: (partId: string) => T | null, make: () => T, full: number, rootId: string): T {
  const memo = new Map<string, T>();
  const build = (partId: string, depth: number): T => {
    const hit = memo.get(partId);
    if (hit) return hit;
    const out = make();
    const length = out.length;
    const mine = own(partId);
    if (mine) out.set(mine.subarray(0, length));
    if (depth < 16) {
      const children = doc.parts.filter((x) => x.parentId === partId);
      for (const child of children.filter((c) => c.combine === 'union')) {
        const a = build(child.id, depth + 1);
        for (let i = 0; i < length; i += 1) if (a[i]! > out[i]!) out[i] = a[i]!;
      }
      for (const child of children.filter((c) => c.combine === 'subtract')) {
        const a = build(child.id, depth + 1);
        for (let i = 0; i < length; i += 1) out[i] = Math.round((out[i]! * (full - a[i]!)) / full);
      }
    }
    memo.set(partId, out);
    return out;
  };
  return build(rootId, 0);
}

export interface RotoConfidenceSummary {
  frames: number;
  mean: number;
  min: number;
  /** Frames below LOW_CONFIDENCE, sorted. */
  low: number[];
  flagged: number[];
  reviewed: number;
}

export function rotoConfidenceSummary(doc: RotoDocument | null | undefined, partId: string | null = null): RotoConfidenceSummary {
  if (!doc) return { frames: 0, mean: 0, min: 0, low: [], flagged: [], reviewed: 0 };
  const conf = [...frameConfidence(doc, partId).entries()].sort((a, b) => a[0] - b[0]);
  if (!conf.length) return { frames: 0, mean: 0, min: 0, low: [], flagged: [], reviewed: 0 };
  const values = conf.map(([, v]) => v.confidence);
  return {
    frames: conf.length,
    mean: Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 1000) / 1000,
    min: Math.min(...values),
    low: conf.filter(([, v]) => v.confidence < LOW_CONFIDENCE).map(([f]) => f),
    flagged: conf.filter(([, v]) => v.flagged).map(([f]) => f),
    reviewed: conf.filter(([, v]) => v.reviewed).length,
  };
}

// ---------------------------------------------------------------------------
// File names (§17) and the metadata written beside the mattes (§5.2)
// ---------------------------------------------------------------------------

export function rotoPartElement(partId: string): string {
  if (!ROTO_PART_ID.test(partId)) throw new Error(`Not a part id: ${partId}`);
  return `roto_${partId}`;
}

export const rotoNames = {
  /** `010_020_roto_arm_v001` */
  partFolder: (shot: string, partId: string, version: number) => `${shot}_${rotoPartElement(partId)}_${versionTag(version)}`,
  partFile: (shot: string, partId: string, version: number, frame: number) => frameFileName(shot, rotoPartElement(partId), version, frame, 'png'),
  partPattern: (shot: string, partId: string, version: number) => framePattern(shot, rotoPartElement(partId), version, 'png'),
  /** `010_020_matte_v001` — the combined subject matte. */
  matteFolder: (shot: string, version: number) => `${shot}_matte_${versionTag(version)}`,
  matteFile: (shot: string, version: number, frame: number) => frameFileName(shot, 'matte', version, frame, 'png'),
  mattePattern: (shot: string, version: number) => framePattern(shot, 'matte', version, 'png'),
  metadata: (shot: string, version: number) => `${shot}_roto_${versionTag(version)}.json`,
};

/** The project metadata written beside the mattes for downstream use (§5.2 final bullet). */
export function rotoMetadata(
  p: Project,
  shotId: string,
  info: { version: number; first: number; last: number; width: number; height: number; bitDepth: number; exr: boolean; workingWidth: number; generator: string; writtenAt: string; by: string },
) {
  const shot = handoffShot(p, shotId);
  const s = shotState(p, shotId);
  if (!shot || !s || !s.roto) throw new Error(`No roto for ${shotId}`);
  const doc = s.roto;
  const name = s.vfxShotId ?? shot.shotId;
  const summary = rotoConfidenceSummary(doc);
  return {
    format: 'vcvfx.roto/1',
    generator: info.generator,
    shot: name,
    handoffShotId: shot.shotId,
    version: versionTag(info.version),
    writtenAt: info.writtenAt,
    by: info.by,
    frames: { first: info.first, last: info.last, count: info.last - info.first + 1 },
    resolution: { width: info.width, height: info.height },
    workingWidth: info.workingWidth,
    alpha: { bitDepth: info.bitDepth, file: 'PNG greyscale, 0 = outside, full = subject; straight (not premultiplied)', exr: info.exr },
    combined: { folder: rotoNames.matteFolder(name, info.version), pattern: rotoNames.mattePattern(name, info.version), rule: 'each part = its own matte ∪ union children − subtract children; subject = the root' },
    parts: partsInOrder(doc).map((part) => ({
      id: part.id,
      name: part.name,
      parent: part.parentId,
      combine: part.combine,
      folder: rotoNames.partFolder(name, part.id, info.version),
      pattern: rotoNames.partPattern(name, part.id, info.version),
      engine: part.engine,
      refine: part.refine,
      keyFrames: part.keyFrames.map((k) => ({ frame: k.frame, correction: k.correction, strokes: k.strokes.length, by: k.by, at: k.at })),
      confidence: rotoConfidenceSummary(doc, part.id),
      frames: part.frames.map((f) => ({ frame: f.frame, status: f.status, confidence: f.confidence, engine: f.engine, reviewed: f.reviewed })),
    })),
    confidence: summary,
    runs: doc.runs.filter((r) => r.taskVersion === info.version),
    /** AI- or algorithm-derived mattes are suggestions until a person approves the task (§19). */
    approval: s.tasks.find((t) => t.kind === 'roto')?.approval ?? null,
  };
}
export type RotoMetadata = ReturnType<typeof rotoMetadata>;
