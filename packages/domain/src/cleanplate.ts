import { contactSheetFrames, handoffShot, shotState, type LogEntry, type Project, type Result, type ShotState } from './project.js';
import { framePattern, frameFileName, versionTag } from './frames.js';
import { rotoPart } from './roto.js';
import {
  CLEANPLATE_ALGORITHM,
  CLEANPLATE_FORMAT_VERSION,
  CleanPlateExportSchema,
  CleanPlateParamsSchema,
  CleanPlatePatchSchema,
  CleanPlateRemoveSchema,
  CleanPlateSuggestionSchema,
  DEFAULT_CLEANPLATE_PARAMS,
  type CleanPlateAlignment,
  type CleanPlateDocument,
  type CleanPlateExportInput,
  type CleanPlateFrameRecord,
  type CleanPlateMetrics,
  type CleanPlateMode,
  type CleanPlateOutputMode,
  type CleanPlateParams,
  type CleanPlatePatch,
  type CleanPlateRemove,
  type CleanPlateSuggestion,
} from './cleanplate-schema.js';

export * from './cleanplate-schema.js';

/**
 * Clean-plate generation / object-removal prep as a model (master spec §8,
 * §15, §19; addendum 10).
 *
 * Every mutation is pure, returns a new project and is logged with who and
 * when. The rules are the key's:
 *  - the work is the shot's `clean_plate` task: changing a setting starts it
 *    or reopens a review for correction, a finished build or an export puts it
 *    up for review, and nothing here approves it — approval is `approveTask`,
 *    a named human act, and needs an export of the version being approved;
 *  - approved clean plates are never changed in place: every edit is refused
 *    until the task is reopened, which bumps its version, so the next export
 *    writes `v002` beside the approved `v001`;
 *  - the settings are what the plate is reproduced from (§19): every change
 *    bumps `revision`, and each build and export records the revision it used.
 */

const MAX_RUNS = 200;
/** Confidence below which a frame (or a pixel) is a problem. */
export const CLEANPLATE_LOW_CONFIDENCE = 0.6;
/** Alignment residual (plate pixels) above which a frame is a problem. */
export const CLEANPLATE_MAX_RESIDUAL = 1.5;

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

export function newCleanPlateDocument(): CleanPlateDocument {
  return {
    formatVersion: CLEANPLATE_FORMAT_VERSION,
    algorithm: { ...CLEANPLATE_ALGORITHM },
    remove: [],
    mode: 'auto',
    alignment: 'auto',
    referenceFrame: null,
    params: { ...DEFAULT_CLEANPLATE_PARAMS },
    guidance: { prefer: [], exclude: [], patches: [] },
    suggestion: null,
    frames: [],
    runs: [],
    exports: [],
    workingWidth: 960,
    revision: 0,
    seq: 0,
  };
}

const shotName = (s: ShotState) => s.vfxShotId ?? s.shotId;

/** Why the clean plate of this shot cannot be changed right now, or null. */
export function cleanPlateLocked(s: ShotState): string | null {
  if (s.stage !== 'prep') return `${shotName(s)} is ${s.stage}; reopen it before changing its clean plate`;
  const task = s.tasks.find((t) => t.kind === 'clean_plate');
  if (!task) return `${shotName(s)} has no Clean plate task. Add it first.`;
  if (task.state === 'approved') return `Clean plate ${versionTag(task.version)} is approved. Reopen it (Needs correction) to make ${versionTag(task.version + 1)}; the approved plate is kept.`;
  return null;
}

export function cleanPlateTaskVersion(s: ShotState): number {
  return s.tasks.find((t) => t.kind === 'clean_plate')?.version ?? 1;
}

type TaskMove = 'edited' | 'review';

function editCleanPlate(
  p: Project,
  shotId: string,
  actor: string,
  now: Date,
  action: string,
  fn: (doc: CleanPlateDocument, s: ShotState) => { doc: CleanPlateDocument; detail: string; task?: TaskMove; settings?: boolean } | string,
): Result {
  const at = now.toISOString();
  let detail = '';
  let started = false;
  const moves: string[] = [];
  const r = withShot(p, shotId, (s) => {
    const locked = cleanPlateLocked(s);
    if (locked) return locked;
    started = s.cleanPlate === null;
    const out = fn(s.cleanPlate ?? newCleanPlateDocument(), s);
    if (typeof out === 'string') return out;
    detail = out.detail;
    const doc = out.settings ? { ...out.doc, revision: out.doc.revision + 1 } : out.doc;
    const tasks = s.tasks.map((t) => {
      if (t.kind !== 'clean_plate' || !out.task || t.state === 'approved') return t;
      // A change starts the work or reopens a review for correction; a finished build goes to review (§15.6).
      const next: typeof t.state = out.task === 'review' ? 'needs_review' : t.state === 'pending' ? 'processing' : t.state === 'needs_review' ? 'needs_correction' : t.state;
      if (next === t.state) return t;
      moves.push(`clean_plate → ${next}`);
      return { ...t, state: next };
    });
    return { ...s, tasks, cleanPlate: doc };
  });
  if (!r.ok) return r;
  let out = r.project;
  if (started) out = logged(out, { at, actor, shotId, action: 'cleanplate.started', detail: `${CLEANPLATE_ALGORITHM.id}@${CLEANPLATE_ALGORITHM.version}` });
  out = logged(out, { at, actor, shotId, action, detail });
  for (const m of moves) out = logged(out, { at, actor, shotId, action: 'task.state', detail: m });
  return { ok: true, project: out };
}

const validFrame = (frame: number) => Number.isInteger(frame) && frame >= 0;
const rectText = (r: { x0: number; y0: number; x1: number; y1: number }) => `${Math.round(r.x0)},${Math.round(r.y0)}–${Math.round(r.x1)},${Math.round(r.y1)}`;

// ---------------------------------------------------------------------------
// What to remove (§8 "identifies the subject with the paint-to-roto tool")
// ---------------------------------------------------------------------------

export type CleanPlateRemoveInput = Omit<Partial<CleanPlateRemove>, 'id'> & Pick<CleanPlateRemove, 'source'>;

const removeLabel = (r: Pick<CleanPlateRemove, 'source' | 'label' | 'frames'>, rotoName?: string) =>
  `${r.source.type === 'roto' ? `roto part ${rotoName ?? r.source.partId}` : `box ${rectText(r.source.rect)}`}${r.frames ? ` on frames ${r.frames.first}–${r.frames.last}` : ''}${r.label ? ` “${r.label}”` : ''}`;

/** Remove a roto part's subject, or whatever a drawn box covers. */
export function addCleanPlateRemove(p: Project, shotId: string, input: CleanPlateRemoveInput, actor: string, now: Date): Result {
  return editCleanPlate(p, shotId, actor, now, 'cleanplate.remove_added', (doc, s) => {
    const seq = doc.seq + 1;
    const parsed = CleanPlateRemoveSchema.safeParse({ ...input, id: `r${seq}` });
    if (!parsed.success) return `That is not usable: ${parsed.error.issues[0]?.message ?? 'bad data'}`;
    const item = parsed.data;
    if (item.source.type === 'roto' && !rotoPart(s.roto, item.source.partId)) return `No roto part “${item.source.partId}”. Paint the subject in the Roto tab first.`;
    if (item.source.type === 'roto' && doc.remove.some((r) => r.source.type === 'roto' && r.source.partId === (item.source as { partId: string }).partId)) return 'That roto part is already being removed';
    if (item.frames && item.frames.last < item.frames.first) return 'The frame range is inverted';
    if (doc.remove.length >= 32) return 'At most 32 things to remove';
    const name = item.source.type === 'roto' ? rotoPart(s.roto, item.source.partId)?.name : undefined;
    return { doc: { ...doc, remove: [...doc.remove, item], seq }, detail: `${item.id}: ${removeLabel(item, name)}`, task: 'edited', settings: true };
  });
}

export function updateCleanPlateRemove(p: Project, shotId: string, id: string, change: Partial<Omit<CleanPlateRemove, 'id'>>, actor: string, now: Date): Result {
  return editCleanPlate(p, shotId, actor, now, 'cleanplate.remove_changed', (doc) => {
    const item = doc.remove.find((r) => r.id === id);
    if (!item) return `Nothing to remove called ${id}`;
    const parsed = CleanPlateRemoveSchema.safeParse({ ...item, ...change, id });
    if (!parsed.success) return `That change is not usable: ${parsed.error.issues[0]?.message ?? 'bad data'}`;
    const next = parsed.data;
    if (next.frames && next.frames.last < next.frames.first) return 'The frame range is inverted';
    const changed = (Object.keys(change) as (keyof CleanPlateRemove)[]).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(item[k]));
    if (!changed.length) return { doc, detail: 'unchanged' };
    return { doc: { ...doc, remove: doc.remove.map((r) => (r.id === id ? next : r)) }, detail: `${id}: ${changed.map((k) => `${k} ${JSON.stringify(next[k])}`).join(', ')}`, task: 'edited', settings: true };
  });
}

export function removeCleanPlateRemove(p: Project, shotId: string, id: string, actor: string, now: Date): Result {
  return editCleanPlate(p, shotId, actor, now, 'cleanplate.remove_removed', (doc) => {
    const item = doc.remove.find((r) => r.id === id);
    if (!item) return `Nothing to remove called ${id}`;
    return { doc: { ...doc, remove: doc.remove.filter((r) => r.id !== id) }, detail: `${id}: ${removeLabel(item)}`, task: 'edited', settings: true };
  });
}

// ---------------------------------------------------------------------------
// Mode, alignment, reference frame, parameters
// ---------------------------------------------------------------------------

export interface CleanPlateSettingsChange extends Partial<CleanPlateParams> {
  mode?: CleanPlateMode;
  alignment?: CleanPlateAlignment;
  /** null: the middle of the shot. */
  referenceFrame?: number | null;
}

export function setCleanPlateSettings(p: Project, shotId: string, change: CleanPlateSettingsChange, actor: string, now: Date): Result {
  return editCleanPlate(p, shotId, actor, now, 'cleanplate.settings', (doc) => {
    const { mode, alignment, referenceFrame, ...paramChange } = change;
    const parsed = CleanPlateParamsSchema.safeParse({ ...doc.params, ...paramChange });
    if (!parsed.success) return `${parsed.error.issues[0]?.path.join('.') ?? 'value'}: ${parsed.error.issues[0]?.message ?? 'out of range'}`;
    if (referenceFrame !== undefined && referenceFrame !== null && !validFrame(referenceFrame)) return 'Not a frame number';
    const next: CleanPlateDocument = {
      ...doc,
      params: parsed.data,
      ...(mode ? { mode } : {}),
      ...(alignment ? { alignment } : {}),
      ...(referenceFrame !== undefined ? { referenceFrame } : {}),
    };
    const details: string[] = [];
    if (next.mode !== doc.mode) details.push(`mode ${doc.mode} → ${next.mode}`);
    if (next.alignment !== doc.alignment) details.push(`alignment ${doc.alignment} → ${next.alignment}`);
    if (next.referenceFrame !== doc.referenceFrame) details.push(`reference frame ${doc.referenceFrame ?? 'middle'} → ${next.referenceFrame ?? 'middle'}`);
    for (const k of Object.keys(paramChange) as (keyof CleanPlateParams)[]) if (next.params[k] !== doc.params[k]) details.push(`${k} ${doc.params[k]} → ${next.params[k]}`);
    if (!details.length) return { doc, detail: 'unchanged' };
    return { doc: next, detail: details.join(', '), task: 'edited', settings: true };
  });
}

export const CLEANPLATE_WORKING_WIDTHS = [640, 960, 1280, 1920] as const;

export function setCleanPlateWorkingWidth(p: Project, shotId: string, width: number, actor: string, now: Date): Result {
  if (!Number.isInteger(width) || width < 256 || width > 4096) return { ok: false, reason: 'Working width is 256 to 4096 px' };
  return editCleanPlate(p, shotId, actor, now, 'cleanplate.working_width', (doc) => (doc.workingWidth === width ? { doc, detail: `unchanged (${width})` } : { doc: { ...doc, workingWidth: width }, detail: `${doc.workingWidth} → ${width} px` }));
}

/** The reference frame a build uses: the chosen one inside the shot, else the middle. */
export function cleanPlateReference(doc: Pick<CleanPlateDocument, 'referenceFrame'> | null | undefined, first: number, last: number): number {
  const r = doc?.referenceFrame;
  if (r !== null && r !== undefined && r >= first && r <= last) return r;
  return Math.round((first + last) / 2);
}

// ---------------------------------------------------------------------------
// Artist guidance (§8 "patch/reference-frame selection")
// ---------------------------------------------------------------------------

/** Prefer a frame's pixels, leave a frame out entirely, or neither. */
export function setCleanPlateFrameGuidance(p: Project, shotId: string, frame: number, use: 'prefer' | 'exclude' | 'none', actor: string, now: Date): Result {
  if (!validFrame(frame)) return { ok: false, reason: 'Not a frame number' };
  return editCleanPlate(p, shotId, actor, now, 'cleanplate.guidance', (doc) => {
    const g = doc.guidance;
    const prefer = g.prefer.filter((f) => f !== frame);
    const exclude = g.exclude.filter((f) => f !== frame);
    if (use === 'prefer') prefer.push(frame);
    if (use === 'exclude') exclude.push(frame);
    if (prefer.length > 64) return 'At most 64 preferred frames';
    if (exclude.length > 1024) return 'At most 1024 left-out frames';
    const before = g.prefer.includes(frame) ? 'prefer' : g.exclude.includes(frame) ? 'exclude' : 'none';
    if (before === use) return { doc, detail: 'unchanged' };
    return {
      doc: { ...doc, guidance: { ...g, prefer: prefer.sort((a, b) => a - b), exclude: exclude.sort((a, b) => a - b) } },
      detail: `frame ${frame}: ${use === 'prefer' ? 'preferred' : use === 'exclude' ? 'left out' : 'no preference'}`,
      task: 'edited',
      settings: true,
    };
  });
}

export type CleanPlatePatchInput = Omit<Partial<CleanPlatePatch>, 'id'> & Pick<CleanPlatePatch, 'rect' | 'sourceFrame'>;

/** "Take this region from that frame": a patch the reconstruction must use. */
export function addCleanPlatePatch(p: Project, shotId: string, input: CleanPlatePatchInput, actor: string, now: Date): Result {
  return editCleanPlate(p, shotId, actor, now, 'cleanplate.patch_added', (doc) => {
    const seq = doc.seq + 1;
    const parsed = CleanPlatePatchSchema.safeParse({ ...input, id: `p${seq}` });
    if (!parsed.success) return `That patch is not usable: ${parsed.error.issues[0]?.message ?? 'bad data'}`;
    const patch = parsed.data;
    if (patch.frames && patch.frames.last < patch.frames.first) return 'The frame range is inverted';
    if (doc.guidance.exclude.includes(patch.sourceFrame)) return `Frame ${patch.sourceFrame} is left out; prefer it or clear it first`;
    if (doc.guidance.patches.length >= 32) return 'At most 32 patches';
    return {
      doc: { ...doc, guidance: { ...doc.guidance, patches: [...doc.guidance.patches, patch] }, seq },
      detail: `${patch.id}: box ${rectText(patch.rect)} from frame ${patch.sourceFrame}${patch.frames ? ` on frames ${patch.frames.first}–${patch.frames.last}` : ''}`,
      task: 'edited',
      settings: true,
    };
  });
}

export function updateCleanPlatePatch(p: Project, shotId: string, id: string, change: Partial<Omit<CleanPlatePatch, 'id'>>, actor: string, now: Date): Result {
  return editCleanPlate(p, shotId, actor, now, 'cleanplate.patch_changed', (doc) => {
    const patch = doc.guidance.patches.find((x) => x.id === id);
    if (!patch) return `No patch ${id}`;
    const parsed = CleanPlatePatchSchema.safeParse({ ...patch, ...change, id });
    if (!parsed.success) return `That change is not usable: ${parsed.error.issues[0]?.message ?? 'bad data'}`;
    const next = parsed.data;
    const changed = (Object.keys(change) as (keyof CleanPlatePatch)[]).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(patch[k]));
    if (!changed.length) return { doc, detail: 'unchanged' };
    return { doc: { ...doc, guidance: { ...doc.guidance, patches: doc.guidance.patches.map((x) => (x.id === id ? next : x)) } }, detail: `${id}: ${changed.map((k) => `${k} ${JSON.stringify(next[k])}`).join(', ')}`, task: 'edited', settings: true };
  });
}

export function removeCleanPlatePatch(p: Project, shotId: string, id: string, actor: string, now: Date): Result {
  return editCleanPlate(p, shotId, actor, now, 'cleanplate.patch_removed', (doc) => {
    const patch = doc.guidance.patches.find((x) => x.id === id);
    if (!patch) return `No patch ${id}`;
    return { doc: { ...doc, guidance: { ...doc.guidance, patches: doc.guidance.patches.filter((x) => x.id !== id) } }, detail: `${id}: box ${rectText(patch.rect)} from frame ${patch.sourceFrame}`, task: 'edited', settings: true };
  });
}

// ---------------------------------------------------------------------------
// Builds, confidence and problem frames (§8 "show unresolved/low-confidence regions", §19)
// ---------------------------------------------------------------------------

/**
 * A frame's confidence from its measurements (addendum 10 §5): the mean
 * per-pixel confidence of what was removed, lowered when the frame aligned
 * badly to the others (parallax, a lens the homography cannot follow). A
 * frame with nothing removed is its own clean plate.
 */
export function cleanPlateConfidence(m: CleanPlateMetrics): number {
  if (m.hole <= 0) return 1;
  let c = m.meanHole;
  if (m.residualPx > 0.75) c *= 1 - 0.5 * Math.min(1, (m.residualPx - 0.75) / 2);
  return Math.round(Math.max(0, Math.min(1, c)) * 1000) / 1000;
}

/** Why each frame is a problem ('' when it is not). */
export function cleanPlateProblemReasons(records: readonly Pick<CleanPlateFrameRecord, 'frame' | 'confidence' | 'metrics'>[]): Map<number, string> {
  const out = new Map<number, string>();
  for (const r of records) {
    const reasons: string[] = [];
    if (r.confidence < CLEANPLATE_LOW_CONFIDENCE) reasons.push(`confidence ${r.confidence.toFixed(2)}`);
    if (r.metrics.hole > 0 && r.metrics.low > 0.02) reasons.push(`${(r.metrics.low * 100).toFixed(0)} % of the removed area unresolved (paint or patch it)`);
    if (r.metrics.residualPx > CLEANPLATE_MAX_RESIDUAL) reasons.push(`alignment residual ${r.metrics.residualPx.toFixed(1)} px (parallax?)`);
    if (Math.abs(r.metrics.exposureStops) > 0.5) reasons.push(`exposure ${r.metrics.exposureStops >= 0 ? '+' : ''}${r.metrics.exposureStops.toFixed(2)} stops against the reference`);
    out.set(r.frame, reasons.join('; '));
  }
  return out;
}

export interface CleanPlateRunResult {
  mode: CleanPlateOutputMode;
  alignment: 'static' | 'homography';
  reference: number;
  first: number;
  last: number;
  frames: { frame: number; confidence: number; metrics: CleanPlateMetrics }[];
  /** What the analysis found and suggests (recorded as the document's suggestion). */
  suggestion: Omit<CleanPlateSuggestion, 'at' | 'revision'>;
  /** The settings revision the build used. */
  revision: number;
  algorithm?: string;
}

/**
 * Record what a build produced: per-frame confidence and measurements, the
 * problem frames, and the analysis's suggestion. A finished build puts the
 * clean plate up for review — never approves it. A build made with an older
 * revision of the settings is refused.
 */
export function recordCleanPlateRun(p: Project, shotId: string, result: CleanPlateRunResult, actor: string, now: Date): Result {
  if (!result.frames.length) return { ok: false, reason: 'The build produced no frames' };
  if (result.frames.some((f) => !validFrame(f.frame) || !(f.confidence >= 0 && f.confidence <= 1))) return { ok: false, reason: 'The build result is not usable' };
  const at = now.toISOString();
  return editCleanPlate(p, shotId, actor, now, 'cleanplate.built', (doc, s) => {
    if (result.revision !== doc.revision) return `That plate was built with settings revision ${result.revision}; the settings are now revision ${doc.revision}. Build again.`;
    const parsed = CleanPlateSuggestionSchema.safeParse({ ...result.suggestion, revision: result.revision, at });
    if (!parsed.success) return `The analysis is not usable: ${parsed.error.issues[0]?.message ?? 'bad data'}`;
    // A new build replaces the records of the previous one (a still has one frame, a sequence every frame).
    const previous = new Map(doc.frames.map((f) => [f.frame, f]));
    const fresh = result.frames.map((f) => {
      const prev = previous.get(f.frame);
      return { frame: f.frame, confidence: Math.round(f.confidence * 1000) / 1000, metrics: f.metrics, status: prev?.status === 'flagged' ? ('flagged' as const) : ('processed' as const), reason: '', reviewed: null, note: prev?.note ?? '' };
    });
    const reasons = cleanPlateProblemReasons(fresh);
    const frames = fresh.map((f) => ({ ...f, reason: reasons.get(f.frame) ?? '' })).sort((a, b) => a.frame - b.frame);
    const values = frames.map((f) => f.confidence);
    const mean = Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 1000) / 1000;
    const min = Math.round(Math.min(...values) * 1000) / 1000;
    const holes = frames.filter((f) => f.metrics.hole > 0);
    const avg = (pick: (f: CleanPlateFrameRecord) => number) => (holes.length ? Math.round((holes.reduce((a, f) => a + pick(f), 0) / holes.length) * 1000) / 1000 : 0);
    const residuals = frames.map((f) => f.metrics.residualPx).sort((a, b) => a - b);
    const problems = frames.filter((f) => f.reason).map((f) => f.frame);
    const algorithm = result.algorithm ?? `${CLEANPLATE_ALGORITHM.id}@${CLEANPLATE_ALGORITHM.version}`;
    const run = {
      algorithm,
      revision: result.revision,
      mode: result.mode,
      alignment: result.alignment,
      reference: result.reference,
      first: result.first,
      last: result.last,
      frames: frames.length,
      meanConfidence: mean,
      minConfidence: min,
      coverage: avg((f) => f.metrics.coverage),
      low: avg((f) => f.metrics.low),
      residualPx: Math.round((residuals[residuals.length >> 1] ?? 0) * 1000) / 1000,
      problems,
      taskVersion: cleanPlateTaskVersion(s),
      at,
      by: actor,
    };
    return {
      doc: { ...doc, frames, suggestion: parsed.data, runs: [...doc.runs, run].slice(-MAX_RUNS) },
      detail: `${result.mode === 'still' ? `still in frame ${result.reference}` : `${frames.length} frames ${result.first}–${result.last}`} with ${algorithm} (settings r${result.revision}, ${result.alignment === 'static' ? 'static camera' : 'homography alignment'}): confidence mean ${mean.toFixed(2)} min ${min.toFixed(2)}, filled from other frames ${(run.coverage * 100).toFixed(0)} %, unresolved ${(run.low * 100).toFixed(1)} %${problems.length ? `, ${problems.length} problem frame${problems.length === 1 ? '' : 's'}` : ''}`,
      task: 'review',
    };
  });
}

/** Flag a frame as needing correction, or clear the flag. */
export function flagCleanPlateFrame(p: Project, shotId: string, frame: number, note: string, actor: string, now: Date): Result {
  return editCleanPlate(p, shotId, actor, now, 'cleanplate.flagged', (doc) => {
    const rec = doc.frames.find((f) => f.frame === frame);
    if (!rec) return `Frame ${frame} has not been built yet`;
    const cleared = rec.status === 'flagged';
    const frames = doc.frames.map((f) => (f.frame === frame ? { ...f, status: cleared ? ('processed' as const) : ('flagged' as const), note: cleared ? f.note : note.trim(), reviewed: null } : f));
    return { doc: { ...doc, frames }, detail: `frame ${frame} ${cleared ? 'flag cleared' : `flagged${note.trim() ? `: ${note.trim()}` : ''}`}` };
  });
}

/** Record that someone looked at a built frame and accepts it. */
export function markCleanPlateFrameReviewed(p: Project, shotId: string, frame: number, actor: string, now: Date): Result {
  const at = now.toISOString();
  return editCleanPlate(p, shotId, actor, now, 'cleanplate.reviewed', (doc) => {
    if (!doc.frames.some((f) => f.frame === frame)) return `Frame ${frame} has not been built yet`;
    return { doc: { ...doc, frames: doc.frames.map((f) => (f.frame === frame ? { ...f, reviewed: { by: actor, at }, status: 'processed' as const } : f)) }, detail: `frame ${frame}` };
  });
}

export interface CleanPlateReview {
  representatives: number[];
  /** Frames to look at, worst first: flagged, then problems not yet reviewed. */
  problems: { frame: number; confidence: number; reason: string }[];
}

export function cleanPlateReview(doc: CleanPlateDocument | null | undefined, first: number, last: number): CleanPlateReview {
  const representatives = contactSheetFrames(first, last, 10);
  if (!doc) return { representatives, problems: [] };
  const problems = doc.frames
    .filter((f) => f.frame >= first && f.frame <= last)
    .filter((f) => f.status === 'flagged' || (f.reason && !f.reviewed))
    .map((f) => ({ frame: f.frame, confidence: f.confidence, reason: f.status === 'flagged' ? `flagged${f.note ? `: ${f.note}` : ''}` : f.reason }))
    .sort((a, b) => Number(b.reason.startsWith('flagged')) - Number(a.reason.startsWith('flagged')) || a.confidence - b.confidence || a.frame - b.frame);
  return { representatives, problems };
}

export function nextCleanPlateProblem(review: CleanPlateReview, current: number): number | null {
  const frames = review.problems.map((x) => x.frame).sort((a, b) => a - b);
  if (!frames.length) return null;
  return frames.find((f) => f > current) ?? frames[0]!;
}

export interface CleanPlateConfidenceSummary {
  frames: number;
  mean: number;
  min: number;
  /** Mean share of the removed area filled from other frames (or a patch). */
  coverage: number;
  /** Mean share of the removed area left low-confidence. */
  low: number;
  /** Median alignment residual, plate pixels. */
  residualPx: number;
  lowFrames: number[];
  problems: number[];
  flagged: number[];
  reviewed: number;
}

export function cleanPlateConfidenceSummary(doc: CleanPlateDocument | null | undefined): CleanPlateConfidenceSummary {
  if (!doc || !doc.frames.length) return { frames: 0, mean: 0, min: 0, coverage: 0, low: 0, residualPx: 0, lowFrames: [], problems: [], flagged: [], reviewed: 0 };
  const values = doc.frames.map((f) => f.confidence);
  const holes = doc.frames.filter((f) => f.metrics.hole > 0);
  const avg = (pick: (f: CleanPlateFrameRecord) => number) => (holes.length ? Math.round((holes.reduce((a, f) => a + pick(f), 0) / holes.length) * 1000) / 1000 : 0);
  const residuals = doc.frames.map((f) => f.metrics.residualPx).sort((a, b) => a - b);
  return {
    frames: doc.frames.length,
    mean: Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 1000) / 1000,
    min: Math.min(...values),
    coverage: avg((f) => f.metrics.coverage),
    low: avg((f) => f.metrics.low),
    residualPx: Math.round((residuals[residuals.length >> 1] ?? 0) * 1000) / 1000,
    lowFrames: doc.frames.filter((f) => f.confidence < CLEANPLATE_LOW_CONFIDENCE).map((f) => f.frame),
    problems: doc.frames.filter((f) => f.reason && !f.reviewed).map((f) => f.frame),
    flagged: doc.frames.filter((f) => f.status === 'flagged').map((f) => f.frame),
    reviewed: doc.frames.filter((f) => f.reviewed).length,
  };
}

/** The mode a build makes: the chosen one, or (auto) the analysis's suggestion, or a sequence until analysed. */
export function cleanPlateModeFor(doc: CleanPlateDocument | null | undefined, analysed?: CleanPlateOutputMode): CleanPlateOutputMode {
  if (doc?.mode === 'still' || doc?.mode === 'sequence') return doc.mode;
  return analysed ?? doc?.suggestion?.mode ?? 'sequence';
}

/**
 * Still or sequence (§8): a still is enough when the camera did not move and
 * the light did not change; otherwise each frame needs its own plate.
 */
export function suggestCleanPlateMode(a: { static: boolean; motionPx: number; residualPx: number; exposureStops: number }): { mode: CleanPlateOutputMode; reason: string } {
  if (!a.static) return { mode: 'sequence', reason: `The camera moves (up to ${a.motionPx.toFixed(1)} px against the reference): each frame gets its own plate.` };
  if (a.exposureStops > 0.15) return { mode: 'sequence', reason: `The camera is still but the light changes (up to ${a.exposureStops.toFixed(2)} stops): each frame gets its own plate.` };
  return { mode: 'still', reason: 'The camera does not move and the light holds: one still plate serves the whole shot.' };
}

// ---------------------------------------------------------------------------
// Export (§8, §17)
// ---------------------------------------------------------------------------

/** Record a written export and submit the clean plate for review (never approval). */
export function recordCleanPlateExport(p: Project, shotId: string, record: CleanPlateExportInput, actor: string, now: Date): Result {
  const at = now.toISOString();
  const parsed = CleanPlateExportSchema.safeParse({ ...record, writtenAt: at, by: actor });
  if (!parsed.success) return { ok: false, reason: `The export record is not usable: ${parsed.error.issues[0]?.message ?? 'bad data'}` };
  const rec = parsed.data;
  return editCleanPlate(p, shotId, actor, now, 'cleanplate.exported', (doc, s) => {
    if (rec.version !== cleanPlateTaskVersion(s)) return `That clean plate is ${versionTag(rec.version)}; the task is ${versionTag(cleanPlateTaskVersion(s))}`;
    return {
      doc: { ...doc, exports: [...doc.exports.filter((e) => e.version !== rec.version), rec].sort((a, b) => a.version - b.version) },
      detail: `${versionTag(rec.version)}: ${rec.folder}, ${rec.mode === 'still' ? `still ${rec.plate} (frame ${rec.reference})` : `${rec.frames} frames ${rec.first}–${rec.last} as ${rec.plate}`} at ${rec.width}×${rec.height}, ${rec.encoding}; confidence ${rec.confidence}; ${rec.files} files; settings r${rec.revision}`,
      task: 'review',
    };
  });
}

export const cleanPlateNames = {
  /** `020_010_cleanplate_v001` inside 04_CLEAN_PLATES. */
  folder: (shot: string, version: number) => `${shot}_cleanplate_${versionTag(version)}`,
  plateFile: (shot: string, version: number, frame: number, format: 'exr' | 'png') => frameFileName(shot, 'cleanplate', version, frame, format),
  platePattern: (shot: string, version: number, format: 'exr' | 'png') => framePattern(shot, 'cleanplate', version, format),
  /** A still carries the reference frame's number. */
  stillFile: (shot: string, version: number, reference: number, format: 'exr' | 'png') => frameFileName(shot, 'cleanplate_still', version, reference, format),
  confidenceFile: (shot: string, version: number, frame: number) => frameFileName(shot, 'cleanplate_conf', version, frame, 'png'),
  confidencePattern: (shot: string, version: number) => framePattern(shot, 'cleanplate_conf', version, 'png'),
  unresolvedFile: (shot: string, version: number, frame: number) => frameFileName(shot, 'cleanplate_unresolved', version, frame, 'png'),
  unresolvedPattern: (shot: string, version: number) => framePattern(shot, 'cleanplate_unresolved', version, 'png'),
  metadata: (shot: string, version: number) => `${shot}_cleanplate_${versionTag(version)}.json`,
  readme: () => 'README.txt',
};

/** Everything that decides the pixels of a clean plate, for the metadata and for reproducing it (§19). */
export function cleanPlateSettings(doc: CleanPlateDocument) {
  return {
    algorithm: doc.algorithm,
    revision: doc.revision,
    remove: doc.remove,
    mode: doc.mode,
    alignment: doc.alignment,
    referenceFrame: doc.referenceFrame,
    params: doc.params,
    guidance: doc.guidance,
  };
}

/** The metadata written beside the clean plate (`<shot>_cleanplate_vNNN.json`). */
export function cleanPlateMetadata(
  p: Project,
  shotId: string,
  info: {
    version: number;
    mode: CleanPlateOutputMode;
    reference: number;
    first: number;
    last: number;
    width: number;
    height: number;
    encoding: string;
    linear: boolean;
    source: string;
    files: Record<string, string | null>;
    format: 'exr' | 'png';
    generator: string;
    writtenAt: string;
    by: string;
    alignment: { model: 'static' | 'homography'; frames: { frame: number; H: number[]; residualPx: number; motionPx: number; gain: number[] }[] };
  },
) {
  const shot = handoffShot(p, shotId);
  const s = shotState(p, shotId);
  if (!shot || !s || !s.cleanPlate) throw new Error(`No clean plate for ${shotId}`);
  const doc = s.cleanPlate;
  return {
    format: 'vcvfx.cleanplate/1',
    generator: info.generator,
    shot: shotName(s),
    handoffShotId: shot.shotId,
    version: versionTag(info.version),
    writtenAt: info.writtenAt,
    by: info.by,
    mode: info.mode,
    referenceFrame: info.reference,
    frames: { first: info.first, last: info.last, count: info.mode === 'still' ? 1 : info.last - info.first + 1 },
    resolution: { width: info.width, height: info.height },
    source: info.source,
    colour: {
      encoding: info.encoding,
      linear: info.linear,
      note: info.linear ? 'Scene-linear in this encoding; no display transform or look is applied.' : 'The source encoding is unknown: built on its code values, which are written as they are (not linear).',
    },
    files: info.files,
    plate:
      info.format === 'exr'
        ? 'RGB half-float EXR. Outside the removed area the pixels are the frame’s own; inside, borrowed from aligned frames (gain-matched) or filled spatially where never seen.'
        : 'RGB 16-bit PNG of the source code values. Outside the removed area the pixels are the frame’s own.',
    confidence: '16-bit PNG greyscale: full = seen clean in several agreeing frames; 0 = never seen (filled spatially). Outside the removed area: full.',
    unresolved: '16-bit PNG greyscale: full where the reconstruction is low-confidence and wants paint or a patch.',
    alignment: {
      model: info.alignment.model,
      note: 'H maps reference-frame plate pixels to each frame’s plate pixels (row-major 3×3). Gain is the per-channel exposure of the frame against the reference.',
      frames: info.alignment.frames,
    },
    settings: cleanPlateSettings(doc),
    suggestion: doc.suggestion,
    confidenceSummary: cleanPlateConfidenceSummary(doc),
    perFrame: doc.frames.map((f) => ({ frame: f.frame, confidence: f.confidence, metrics: f.metrics, status: f.status, problem: f.reason || null, reviewed: f.reviewed })),
    runs: doc.runs.filter((r) => r.taskVersion === info.version),
    approval: s.tasks.find((t) => t.kind === 'clean_plate')?.approval ?? null,
  };
}
export type CleanPlateMetadata = ReturnType<typeof cleanPlateMetadata>;

/** The clean-plate section of the package manifest (§18). Null when the shot has no clean-plate document. */
export function cleanPlateManifest(s: ShotState) {
  const doc = s.cleanPlate;
  if (!doc) return null;
  const task = s.tasks.find((t) => t.kind === 'clean_plate');
  const version = task?.version ?? 1;
  const exported = doc.exports.find((e) => e.version === version) ?? null;
  const summary = cleanPlateConfidenceSummary(doc);
  return {
    version: versionTag(version),
    state: task?.state ?? null,
    approval: task?.approval ?? null,
    exported: exported !== null,
    folder: exported?.folder ?? null,
    mode: exported?.mode ?? cleanPlateModeFor(doc),
    plate: exported?.plate ?? null,
    confidenceMaps: exported?.confidence ?? null,
    unresolvedMaps: exported?.unresolved ?? null,
    metadata: exported?.metadata ?? null,
    referenceFrame: exported?.reference ?? doc.referenceFrame,
    frames: exported ? { first: exported.first, last: exported.last, count: exported.frames } : null,
    resolution: exported ? { width: exported.width, height: exported.height } : null,
    format: exported?.format ?? null,
    encoding: exported?.encoding ?? null,
    algorithm: `${doc.algorithm.id}@${doc.algorithm.version}`,
    revision: exported?.revision ?? doc.revision,
    remove: doc.remove.map((r) => ({ id: r.id, source: r.source, frames: r.frames, enabled: r.enabled })),
    dilatePx: doc.params.dilatePx,
    guidance: { prefer: doc.guidance.prefer, exclude: doc.guidance.exclude, patches: doc.guidance.patches.map((x) => ({ id: x.id, rect: x.rect, sourceFrame: x.sourceFrame, frames: x.frames, enabled: x.enabled })) },
    suggestion: doc.suggestion ? { mode: doc.suggestion.mode, static: doc.suggestion.static, motionPx: doc.suggestion.motionPx, residualPx: doc.suggestion.residualPx } : null,
    confidence: { frames: summary.frames, mean: summary.mean, min: summary.min, coverage: summary.coverage, unresolved: summary.low, residualPx: summary.residualPx, low: summary.lowFrames, problems: summary.problems, flagged: summary.flagged, reviewed: summary.reviewed },
  };
}
