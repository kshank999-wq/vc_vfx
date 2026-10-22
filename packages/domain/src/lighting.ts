import { handoffShot, shotState, type LogEntry, type Project, type Result, type ShotState } from './project.js';
import { versionTag } from './frames.js';
import {
  ArtistLightSchema,
  DEFAULT_LIGHTING_SETTINGS,
  LIGHTING_ALGORITHM,
  LIGHTING_FORMAT_VERSION,
  LIGHT_FIELDS,
  LensOverrideSchema,
  LightFieldsSchema,
  LightSpecSchema,
  LightingAiReviewSchema,
  LightingAnalysisSchema,
  LightingCircleSchema,
  LightingExportSchema,
  LightingReferenceSchema,
  LightingSettingsSchema,
  type ArtistLight,
  type LensEstimate,
  type LensOverride,
  type LightEdit,
  type LightEstimate,
  type LightField,
  type LightFields,
  type LightSpec,
  type LightingAiReview,
  type LightingAnalysis,
  type LightingCircle,
  type LightingDocument,
  type LightingExportInput,
  type LightingReference,
  type LightingReferenceKind,
  type LightingSettings,
  type LightingSuggestion,
  type Range,
} from './lighting-schema.js';
import { kelvinRgb } from './lighting-colour.js';

export * from './lighting-schema.js';
export * from './lighting-colour.js';

/**
 * Lighting and lens analysis as a model (master spec §13, §15, §19;
 * addendum 14).
 *
 * Every mutation is pure, returns a new project and is logged with who and
 * when. The rules are the other modules':
 *  - the work is the shot's `lighting_analysis` task: changing anything starts
 *    it or reopens a review for correction, a finished analysis or an export
 *    puts it up for review, and nothing here approves it — approval is
 *    `approveTask`, a named human act, and needs an export of the version;
 *  - approved work is never changed in place: every edit is refused until the
 *    task is reopened, which bumps its version, so the next export writes
 *    `v002` beside the approved `v001`;
 *  - the estimate and the artist's edits are kept apart (§19 "AI suggestions
 *    editable"): an edited field is the artist's ("locked") and survives every
 *    new analysis; a field not edited follows the newest estimate;
 *  - the frames, references and settings are what the analysis is reproduced
 *    from: each change bumps `revision`, and the analysis records it; the rig
 *    edits bump `editRevision`, and each export records both.
 */

const MAX_RUNS = 200;
export const LIGHTING_TASK = 'lighting_analysis' as const;
/** Key-direction confidence below which the estimate needs a look. */
export const LIGHTING_LOW_CONFIDENCE = 0.5;
/** Match score below which the rig's shading does not explain the plate well. */
export const LIGHTING_LOW_MATCH = 0.6;

export const LIGHT_ROLE_LABELS: Record<LightSpec['role'], string> = {
  key: 'Key',
  fill: 'Fill',
  rim: 'Rim',
  back: 'Back',
  practical: 'Practical',
  background: 'Background',
  ambient: 'Ambient',
  sun: 'Sun',
  sky: 'Sky',
};
export const LIGHT_TYPE_LABELS: Record<LightSpec['type'], string> = { point: 'Point', spot: 'Spot', rect: 'Rect (area)', directional: 'Directional', dome: 'Dome' };
export const LIGHTING_REFERENCE_LABELS: Record<LightingReferenceKind, string> = { chrome_ball: 'Chrome ball', grey_ball: 'Grey ball', hdri: 'HDRI (equirect)' };
export const LIGHT_FIELD_LABELS: Record<LightField, string> = {
  role: 'role',
  type: 'type',
  name: 'name',
  enabled: 'on',
  azimuthDeg: 'azimuth',
  elevationDeg: 'elevation',
  distanceM: 'distance',
  intensityStops: 'intensity',
  sizeDeg: 'size',
  temperatureK: 'temperature',
  rgb: 'colour',
};

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

export function newLightingDocument(): LightingDocument {
  return {
    formatVersion: LIGHTING_FORMAT_VERSION,
    algorithm: { ...LIGHTING_ALGORITHM },
    settings: { ...DEFAULT_LIGHTING_SETTINGS, frames: [] },
    references: [],
    analysis: null,
    edits: [],
    added: [],
    removed: [],
    lens: { focalMm: null, filmBackMm: null, fStop: null },
    reviews: [],
    runs: [],
    exports: [],
    revision: 0,
    editRevision: 0,
    seq: 0,
  };
}

const shotName = (s: ShotState) => s.vfxShotId ?? s.shotId;

export function lightingDoc(s: ShotState | null | undefined): LightingDocument | null {
  return s?.lighting ?? null;
}

/** Why the lighting of this shot cannot be changed right now, or null. */
export function lightingLocked(s: ShotState): string | null {
  if (s.stage !== 'prep') return `${shotName(s)} is ${s.stage}; reopen it before changing its lighting analysis`;
  const task = s.tasks.find((t) => t.kind === LIGHTING_TASK);
  if (!task) return `${shotName(s)} has no Lighting and lens analysis task. Add it first.`;
  if (task.state === 'approved') return `The light rig ${versionTag(task.version)} is approved. Reopen it (Needs correction) to make ${versionTag(task.version + 1)}; the approved files are kept.`;
  return null;
}

export function lightingTaskVersion(s: ShotState): number {
  return s.tasks.find((t) => t.kind === LIGHTING_TASK)?.version ?? 1;
}

type TaskMove = 'edited' | 'review';

function editLighting(
  p: Project,
  shotId: string,
  actor: string,
  now: Date,
  action: string,
  fn: (doc: LightingDocument, s: ShotState) => { doc: LightingDocument; detail: string; task?: TaskMove; settings?: boolean; rig?: boolean; extra?: { action: string; detail: string }[] } | string,
): Result {
  const at = now.toISOString();
  let detail = '';
  let started = false;
  let extra: { action: string; detail: string }[] = [];
  const moves: string[] = [];
  const r = withShot(p, shotId, (s) => {
    const locked = lightingLocked(s);
    if (locked) return locked;
    const current = lightingDoc(s);
    started = current === null;
    const out = fn(current ?? newLightingDocument(), s);
    if (typeof out === 'string') return out;
    detail = out.detail;
    extra = out.extra ?? [];
    let doc = out.doc;
    if (out.settings) doc = { ...doc, revision: doc.revision + 1 };
    if (out.rig) doc = { ...doc, editRevision: doc.editRevision + 1 };
    const tasks = s.tasks.map((t) => {
      if (t.kind !== LIGHTING_TASK || !out.task || t.state === 'approved') return t;
      // A change starts the work or reopens a review for correction; a finished analysis goes to review (§15.6).
      const next: typeof t.state = out.task === 'review' ? 'needs_review' : t.state === 'pending' ? 'processing' : t.state === 'needs_review' ? 'needs_correction' : t.state;
      if (next === t.state) return t;
      moves.push(`${LIGHTING_TASK} → ${next}`);
      return { ...t, state: next };
    });
    return { ...s, tasks, lighting: doc };
  });
  if (!r.ok) return r;
  let out = r.project;
  if (started) out = logged(out, { at, actor, shotId, action: 'lighting.started', detail: `${LIGHTING_ALGORITHM.id}@${LIGHTING_ALGORITHM.version}` });
  out = logged(out, { at, actor, shotId, action, detail });
  for (const e of extra) out = logged(out, { at, actor, shotId, action: e.action, detail: e.detail });
  for (const m of moves) out = logged(out, { at, actor, shotId, action: 'task.state', detail: m });
  return { ok: true, project: out };
}

const issue = (e: { issues: { path: PropertyKey[]; message: string }[] }) => `${e.issues[0]?.path.map(String).join('.') || 'value'}: ${e.issues[0]?.message ?? 'not usable'}`;

// ---------------------------------------------------------------------------
// Formatting (one compact log line per change; the UI's figures)
// ---------------------------------------------------------------------------

const trim = (v: number, d: number) => String(+v.toFixed(d));

/** A field's value as the log and the panel show it. */
export function lightFieldText(field: LightField, value: unknown): string {
  if (value === null || value === undefined) return field === 'distanceM' ? 'at infinity' : 'none';
  switch (field) {
    case 'azimuthDeg':
    case 'elevationDeg':
    case 'sizeDeg':
      return `${trim(value as number, 1)}°`;
    case 'distanceM':
      return `${trim(value as number, 2)} m`;
    case 'intensityStops': {
      const v = value as number;
      return `${v > 0 ? '+' : ''}${trim(v, 2)} stops`;
    }
    case 'temperatureK':
      return `${Math.round(value as number)} K`;
    case 'rgb':
      return `rgb(${(value as number[]).map((c) => trim(c, 3)).join(', ')})`;
    case 'enabled':
      return value ? 'on' : 'off';
    default:
      return String(value);
  }
}

/** A range as text: "32° (24–41°)". */
export function rangeText(r: Range | null | undefined, unit: string, digits = 0): string {
  if (!r) return '—';
  const f = (v: number) => (unit === ' K' ? String(Math.round(v / 10) * 10) : v.toFixed(digits));
  return `${f(r.value)}${unit} (${f(r.low)}–${f(r.high)}${unit})`;
}

const diffText = (before: LightSpec, after: LightSpec, fields: readonly LightField[]) =>
  fields
    .filter((f) => JSON.stringify(before[f]) !== JSON.stringify(after[f]))
    .map((f) => `${LIGHT_FIELD_LABELS[f]} ${lightFieldText(f, before[f])} → ${lightFieldText(f, after[f])}`)
    .join(', ');

// ---------------------------------------------------------------------------
// The rig: the estimate with the artist's edits laid over it
// ---------------------------------------------------------------------------

/** The estimate's middle values as an editable spec. */
export function estimateSpec(e: LightEstimate): LightSpec {
  return {
    role: e.role,
    type: e.type,
    name: e.name,
    enabled: true,
    azimuthDeg: e.azimuth.value,
    elevationDeg: e.elevation.value,
    distanceM: e.distance?.value ?? null,
    intensityStops: e.intensity.value,
    sizeDeg: e.size?.value ?? null,
    temperatureK: e.temperature?.value ?? null,
    rgb: e.rgb,
  };
}

export interface RigLight {
  id: string;
  /** estimate: found by the analysis (edited or not); artist: added by the artist (or an accepted AI suggestion). */
  origin: 'estimate' | 'artist';
  spec: LightSpec;
  estimate: LightEstimate | null;
  /** The fields that are the artist's (they survive a new analysis). All of an artist's light. */
  locked: LightField[];
  removed: boolean;
  /** Who set it: "artist", or "ai:<review>/<suggestion>". */
  from: string | null;
}

/** Wrap an azimuth into −180 … 180. */
export const wrapAzimuth = (a: number) => {
  if (a >= -180 && a <= 180) return a;
  const w = ((((a + 180) % 360) + 360) % 360) - 180;
  return w === -180 && a > 0 ? 180 : w;
};

function applyFields(spec: LightSpec, fields: LightFields): LightSpec {
  const next = { ...spec, ...fields } as LightSpec;
  return next;
}

/** The effective rig: every estimated light (with the artist's values over it) and every artist's light. Removed ones only with `includeRemoved`. */
export function lightingRig(doc: LightingDocument | null | undefined, o: { includeRemoved?: boolean } = {}): RigLight[] {
  if (!doc) return [];
  const out: RigLight[] = [];
  for (const e of doc.analysis?.lights ?? []) {
    const removed = doc.removed.includes(e.id);
    if (removed && !o.includeRemoved) continue;
    const edit = doc.edits.find((x) => x.lightId === e.id);
    out.push({ id: e.id, origin: 'estimate', spec: edit ? applyFields(estimateSpec(e), edit.fields) : estimateSpec(e), estimate: e, locked: edit ? (Object.keys(edit.fields) as LightField[]) : [], removed, from: edit?.from ?? null });
  }
  for (const a of doc.added) out.push({ id: a.id, origin: 'artist', spec: a.spec, estimate: null, locked: [...LIGHT_FIELDS], removed: false, from: a.from });
  return out;
}

export function rigLight(doc: LightingDocument | null | undefined, id: string): RigLight | null {
  return lightingRig(doc, { includeRemoved: true }).find((l) => l.id === id) ?? null;
}

/** A light's spec made consistent: a directional or dome light is at infinity; a positional one has a distance. */
function consistent(spec: LightSpec, fallbackDistance: number): LightSpec {
  const s = { ...spec, azimuthDeg: wrapAzimuth(spec.azimuthDeg) };
  if (s.type === 'directional' || s.type === 'dome') return { ...s, distanceM: null };
  if (s.distanceM === null) return { ...s, distanceM: fallbackDistance };
  return s;
}

// ---------------------------------------------------------------------------
// Frames, settings and references (§13 "reference-image analysis")
// ---------------------------------------------------------------------------

/** The frames to analyse (the first places the rig). */
export function setLightingFrames(p: Project, shotId: string, frames: number[], actor: string, now: Date): Result {
  const clean = [...new Set(frames.map((f) => Math.round(f)))].filter((f) => Number.isFinite(f) && f >= 0);
  if (clean.length > 8) return { ok: false, reason: 'At most 8 frames are analysed' };
  return editLighting(p, shotId, actor, now, 'lighting.frames', (doc) => {
    if (JSON.stringify(clean) === JSON.stringify(doc.settings.frames)) return { doc, detail: 'unchanged' };
    return { doc: { ...doc, settings: { ...doc.settings, frames: clean } }, detail: clean.length ? `frames ${clean.join(', ')}${clean.length > 1 ? ` (the rig at ${clean[0]})` : ''}` : 'the shot’s middle frame', task: 'edited', settings: true };
  });
}

export function setLightingSettings(p: Project, shotId: string, change: Partial<Omit<LightingSettings, 'frames'>>, actor: string, now: Date): Result {
  return editLighting(p, shotId, actor, now, 'lighting.settings', (doc) => {
    const parsed = LightingSettingsSchema.safeParse({ ...doc.settings, ...change });
    if (!parsed.success) return `settings.${issue(parsed.error)}`;
    const next = parsed.data;
    const details = (Object.keys(change) as (keyof LightingSettings)[]).filter((k) => JSON.stringify(doc.settings[k]) !== JSON.stringify(next[k])).map((k) => `${k} ${JSON.stringify(doc.settings[k])} → ${JSON.stringify(next[k])}`);
    if (!details.length) return { doc, detail: 'unchanged' };
    // The exposure reference changes only the exports, not the analysis.
    const analysisInput = details.some((d) => !d.startsWith('keyLux'));
    return { doc: { ...doc, settings: next }, detail: details.join(', '), task: 'edited', settings: analysisInput, rig: !analysisInput };
  });
}

export type LightingReferenceInput = Omit<LightingReference, 'id' | 'addedBy' | 'addedAt'>;

const REF_PREFIX: Record<LightingReferenceKind, string> = { chrome_ball: 'chrome', grey_ball: 'grey', hdri: 'hdri' };

/** Record a reference: a chrome or grey ball (in a plate frame, or a still) or an equirect HDRI. The file is only read. */
export function addLightingReference(p: Project, shotId: string, input: LightingReferenceInput, actor: string, now: Date): Result {
  const at = now.toISOString();
  return editLighting(p, shotId, actor, now, 'lighting.reference_added', (doc) => {
    if (doc.references.length >= 16) return 'At most 16 references on a shot';
    if (input.kind === 'hdri' && doc.references.some((r) => r.kind === 'hdri')) return 'One HDRI per shot: remove the other first';
    if (input.from !== 'plate' && doc.references.some((r) => r.path === input.path && r.from === input.from && r.kind === input.kind)) return `${input.name} is already here`;
    const seq = doc.seq + 1;
    const parsed = LightingReferenceSchema.safeParse({ ...input, id: `${REF_PREFIX[input.kind]}${seq}`, addedBy: actor, addedAt: at });
    if (!parsed.success) return `That reference is not usable: ${issue(parsed.error)}`;
    const r = parsed.data;
    if (r.kind !== 'hdri' && r.from === 'plate' && r.frame === null) return 'A ball in the plate needs the frame it is held up in';
    if (r.kind === 'hdri' && r.width && r.height && Math.abs(r.width / r.height - 2) > 0.05) return `${r.name} is ${r.width}×${r.height}: an equirectangular panorama is twice as wide as it is high`;
    const where = r.from === 'plate' ? `plate frame ${r.frame}` : `${r.from}: ${r.path}`;
    return {
      doc: { ...doc, references: [...doc.references, r], seq },
      detail: `${r.id} ${LIGHTING_REFERENCE_LABELS[r.kind]} ${r.name} (${where}${r.width ? `; ${r.width}×${r.height}` : ''}${r.circle ? `; circle ${Math.round(r.circle.cx)},${Math.round(r.circle.cy)} r ${Math.round(r.circle.r)}` : ''}${r.checksum ? `; sha256 ${r.checksum.value.slice(0, 12)}…` : ''})`,
      task: 'edited',
      settings: true,
    };
  });
}

export interface LightingReferenceChange {
  name?: string;
  frame?: number | null;
  circle?: LightingCircle | null;
  headingDeg?: number | null;
  encoding?: LightingReference['encoding'];
}

/** A ball's circle or frame, an HDRI's heading, how a picture is read. */
export function updateLightingReference(p: Project, shotId: string, id: string, change: LightingReferenceChange, actor: string, now: Date): Result {
  return editLighting(p, shotId, actor, now, 'lighting.reference', (doc) => {
    const ref = doc.references.find((r) => r.id === id);
    if (!ref) return `No reference ${id}`;
    const next: LightingReference = { ...ref };
    const details: string[] = [];
    if (change.name !== undefined && change.name.trim() && change.name.trim() !== ref.name) {
      next.name = change.name.trim().slice(0, 200);
      details.push(`renamed ${next.name}`);
    }
    if (change.frame !== undefined && change.frame !== ref.frame) {
      if (ref.from !== 'plate') return 'Only a ball in the plate has a frame';
      if (change.frame === null || !(change.frame >= 0)) return 'A ball in the plate needs its frame';
      next.frame = Math.round(change.frame);
      details.push(`frame ${next.frame}`);
    }
    if (change.circle !== undefined) {
      if (ref.kind === 'hdri') return 'An HDRI has no circle';
      if (change.circle === null) next.circle = null;
      else {
        const parsed = LightingCircleSchema.safeParse(change.circle);
        if (!parsed.success) return `circle.${issue(parsed.error)}`;
        next.circle = { cx: Math.round(parsed.data.cx * 10) / 10, cy: Math.round(parsed.data.cy * 10) / 10, r: Math.round(parsed.data.r * 10) / 10 };
      }
      if (JSON.stringify(next.circle) !== JSON.stringify(ref.circle)) details.push(next.circle ? `circle ${next.circle.cx},${next.circle.cy} r ${next.circle.r}` : 'circle cleared');
    }
    if (change.headingDeg !== undefined && change.headingDeg !== ref.headingDeg) {
      if (ref.kind !== 'hdri') return 'Only an HDRI has a heading';
      if (change.headingDeg !== null && !(Math.abs(change.headingDeg) <= 360)) return 'The heading is −360 … 360°';
      next.headingDeg = change.headingDeg === null ? null : Math.round(change.headingDeg * 10) / 10;
      details.push(next.headingDeg === null ? 'heading: aligned to the plate by the analysis' : `heading ${next.headingDeg}°`);
    }
    if (change.encoding !== undefined && change.encoding !== ref.encoding) {
      next.encoding = change.encoding;
      details.push(`read as ${change.encoding ?? 'unknown'}`);
    }
    if (!details.length) return { doc, detail: `${id} unchanged` };
    return { doc: { ...doc, references: doc.references.map((r) => (r.id === id ? next : r)) }, detail: `${id}: ${details.join(', ')}`, task: 'edited', settings: true };
  });
}

export function removeLightingReference(p: Project, shotId: string, id: string, actor: string, now: Date): Result {
  return editLighting(p, shotId, actor, now, 'lighting.reference_removed', (doc) => {
    const ref = doc.references.find((r) => r.id === id);
    if (!ref) return `No reference ${id}`;
    return { doc: { ...doc, references: doc.references.filter((r) => r.id !== id) }, detail: `${id} ${ref.name}`, task: 'edited', settings: true };
  });
}

/** The frames the analysis reads: the chosen ones, else the middle of the range. */
export function lightingFrames(doc: LightingDocument | null | undefined, first: number, last: number): number[] {
  const chosen = (doc?.settings.frames ?? []).filter((f) => f >= first && f <= last);
  return chosen.length ? chosen : [Math.round((first + last) / 2)];
}

// ---------------------------------------------------------------------------
// The analysis (§13; §19 "show confidence")
// ---------------------------------------------------------------------------

export type LightingAnalysisInput = Omit<LightingAnalysis, 'taskVersion' | 'at' | 'by'>;

/**
 * Record what an analysis estimated. The artist's edits are kept: a field
 * they set stays theirs; a light they edited that this analysis did not find
 * again becomes their own light (nothing of theirs is lost); lights they
 * removed and that are gone are forgotten. A finished analysis puts the task
 * up for review — never approves it. An analysis of older settings is refused.
 */
export function recordLightingAnalysis(p: Project, shotId: string, input: LightingAnalysisInput, actor: string, now: Date): Result {
  const at = now.toISOString();
  return editLighting(p, shotId, actor, now, 'lighting.analysed', (doc, s) => {
    if (input.revision !== doc.revision) return `That analysis used settings revision ${input.revision}; the settings are now revision ${doc.revision}. Analyse again.`;
    const parsed = LightingAnalysisSchema.safeParse({ ...input, taskVersion: lightingTaskVersion(s), at, by: actor });
    if (!parsed.success) return `The analysis is not usable: ${issue(parsed.error)}`;
    const a = parsed.data;
    const ids = new Set(a.lights.map((l) => l.id));
    if (ids.size !== a.lights.length) return 'The analysis names a light twice';
    // Edited lights not found again become the artist's own.
    const before = lightingRig(doc, { includeRemoved: true });
    const kept: ArtistLight[] = [];
    const extra: { action: string; detail: string }[] = [];
    for (const l of before) {
      if (l.origin !== 'estimate' || ids.has(l.id) || !l.locked.length || l.removed) continue;
      if (doc.added.some((x) => x.id === l.id)) continue;
      kept.push({ id: l.id, spec: l.spec, from: 'kept', by: actor, at });
      extra.push({ action: 'lighting.light_kept', detail: `${l.id} (${l.spec.name}) was not found this time; kept as your light, with your edits` });
    }
    const edits = doc.edits.filter((e) => ids.has(e.lightId));
    const removed = doc.removed.filter((id) => ids.has(id));
    const key = a.lights.find((l) => l.role === 'key' || l.role === 'sun') ?? null;
    const run = { algorithm: a.algorithm, revision: a.revision, frame: a.frame, lights: a.lights.length, keyConfidence: a.keyConfidence, matchScore: a.matchScore, focalMm: a.lens.focalMm, focalSource: a.lens.focalSource, taskVersion: a.taskVersion, ms: a.ms, at, by: actor };
    return {
      doc: { ...doc, analysis: a, edits, removed, added: [...doc.added, ...kept], runs: [...doc.runs, run].slice(-MAX_RUNS) },
      detail: `frame ${a.frame} with ${a.algorithm} (settings r${a.revision}): ${a.lights.length} light${a.lights.length === 1 ? '' : 's'} (${a.lights.map((l) => l.id).join(', ')})${key ? `; key az ${rangeText(key.azimuth, '°')}, el ${rangeText(key.elevation, '°')}, confidence ${a.keyConfidence.toFixed(2)}` : ''}; lens ${a.lens.focalMm ? `${rangeText(a.lens.focalMm, ' mm', 1)} from ${a.lens.focalSource}` : 'focal unknown'}${a.matchScore !== null ? `; match ${a.matchScore.toFixed(2)}` : ''}${edits.length ? `; ${edits.length} light${edits.length === 1 ? '' : 's'} keep your edits` : ''}`,
      task: 'review',
      rig: true,
      extra,
    };
  });
}

/** Is the newest analysis of the settings as they are now? */
export function lightingAnalysisCurrent(doc: LightingDocument | null | undefined): boolean {
  return Boolean(doc?.analysis && doc.analysis.revision === doc.revision);
}

// ---------------------------------------------------------------------------
// Editing the rig (§13 "let the artist reposition and tune all inferred lights before export")
// ---------------------------------------------------------------------------

function applyLightChange(doc: LightingDocument, lightId: string, change: LightFields, from: string, actor: string, at: string): { doc: LightingDocument; detail: string } | string {
  const parsedChange = LightFieldsSchema.safeParse(change);
  if (!parsedChange.success) return `${lightId}.${issue(parsedChange.error)}`;
  const fields = parsedChange.data;
  const light = rigLight(doc, lightId);
  if (!light) return `No light ${lightId}`;
  if (light.removed) return `${light.spec.name} was removed: restore it first`;
  const merged = consistent(applyFields(light.spec, fields), light.spec.distanceM ?? doc.settings.subjectDistanceM);
  const parsed = LightSpecSchema.safeParse(merged);
  if (!parsed.success) return `${lightId}.${issue(parsed.error)}`;
  const next = parsed.data;
  const changed = LIGHT_FIELDS.filter((f) => JSON.stringify(light.spec[f]) !== JSON.stringify(next[f]));
  if (!changed.length) return { doc, detail: `${lightId} unchanged` };
  const text = `${lightId} (${light.spec.name}): ${diffText(light.spec, next, changed)}`;
  if (light.origin === 'artist') return { doc: { ...doc, added: doc.added.map((a) => (a.id === lightId ? { ...a, spec: next } : a)) }, detail: text };
  const prev = doc.edits.find((e) => e.lightId === lightId);
  const newFields: LightFields = { ...(prev?.fields ?? {}) };
  for (const f of changed) (newFields as Record<string, unknown>)[f] = next[f];
  // Fields asked for but equal to the estimate are kept too: asking for them locks them.
  for (const f of Object.keys(fields) as LightField[]) (newFields as Record<string, unknown>)[f] = next[f];
  const edit: LightEdit = { lightId, fields: newFields, from, by: actor, at };
  return { doc: { ...doc, edits: [...doc.edits.filter((e) => e.lightId !== lightId), edit] }, detail: text };
}

/** Set a light's figures (an estimated light's set fields become the artist's and survive a new analysis). */
export function setLightFields(p: Project, shotId: string, lightId: string, change: LightFields, actor: string, now: Date): Result {
  const at = now.toISOString();
  return editLighting(p, shotId, actor, now, 'lighting.light', (doc) => {
    const out = applyLightChange(doc, lightId, change, 'artist', actor, at);
    if (typeof out === 'string') return out;
    return out.doc === doc ? { doc, detail: out.detail } : { ...out, task: 'edited', rig: true };
  });
}

/**
 * Lock fields (they keep their current value through every new analysis) or
 * unlock them (they follow the estimate again — the artist's value is
 * dropped). An artist's own light has no estimate to follow.
 */
export function lockLightFields(p: Project, shotId: string, lightId: string, fields: readonly LightField[], lock: boolean, actor: string, now: Date): Result {
  const at = now.toISOString();
  return editLighting(p, shotId, actor, now, lock ? 'lighting.locked' : 'lighting.unlocked', (doc) => {
    const light = rigLight(doc, lightId);
    if (!light) return `No light ${lightId}`;
    if (light.origin === 'artist') return `${light.spec.name} is your own light: every field is yours`;
    if (!fields.length) return { doc, detail: 'nothing' };
    const prev = doc.edits.find((e) => e.lightId === lightId);
    const current: LightFields = { ...(prev?.fields ?? {}) };
    const touched: string[] = [];
    for (const f of fields) {
      const has = f in current;
      if (lock && !has) {
        (current as Record<string, unknown>)[f] = light.spec[f];
        touched.push(`${LIGHT_FIELD_LABELS[f]} ${lightFieldText(f, light.spec[f])}`);
      } else if (!lock && has) {
        delete (current as Record<string, unknown>)[f];
        touched.push(`${LIGHT_FIELD_LABELS[f]} back to the estimate (${lightFieldText(f, light.estimate ? estimateSpec(light.estimate)[f] : null)})`);
      }
    }
    if (!touched.length) return { doc, detail: `${lightId} unchanged` };
    const edits = doc.edits.filter((e) => e.lightId !== lightId);
    if (Object.keys(current).length) edits.push({ lightId, fields: current, from: prev?.from ?? 'artist', by: actor, at });
    return { doc: { ...doc, edits }, detail: `${lightId} (${light.spec.name}): ${touched.join(', ')}`, task: 'edited', rig: true };
  });
}

export const DEFAULT_ARTIST_LIGHT: LightSpec = { role: 'fill', type: 'rect', name: 'Fill', enabled: true, azimuthDeg: -35, elevationDeg: 15, distanceM: 2.5, intensityStops: -1.5, sizeDeg: 25, temperatureK: 5600, rgb: kelvinRgb(5600) };

function addLightTo(doc: LightingDocument, spec: Partial<LightSpec>, from: string, actor: string, at: string): { doc: LightingDocument; detail: string; id: string } | string {
  if (lightingRig(doc).length >= 24) return 'At most 24 lights in a rig';
  const base = { ...DEFAULT_ARTIST_LIGHT, ...spec };
  if (spec.temperatureK !== undefined && spec.temperatureK !== null && !spec.rgb) base.rgb = kelvinRgb(spec.temperatureK);
  const merged = consistent(base, doc.settings.subjectDistanceM);
  const parsed = LightSpecSchema.safeParse(merged);
  if (!parsed.success) return `light.${issue(parsed.error)}`;
  const seq = doc.seq + 1;
  const light = ArtistLightSchema.parse({ id: `a${seq}`, spec: parsed.data, from, by: actor, at });
  const s = light.spec;
  return { doc: { ...doc, added: [...doc.added, light], seq }, id: light.id, detail: `${light.id} ${s.name}: ${LIGHT_ROLE_LABELS[s.role].toLowerCase()} ${s.type}, az ${lightFieldText('azimuthDeg', s.azimuthDeg)}, el ${lightFieldText('elevationDeg', s.elevationDeg)}, ${lightFieldText('intensityStops', s.intensityStops)}${s.temperatureK ? `, ${Math.round(s.temperatureK)} K` : ''}` };
}

/** Add a light of the artist's own (a fill rect by default). */
export function addLight(p: Project, shotId: string, spec: Partial<LightSpec>, actor: string, now: Date): Result {
  const at = now.toISOString();
  return editLighting(p, shotId, actor, now, 'lighting.light_added', (doc) => {
    const out = addLightTo(doc, spec, 'artist', actor, at);
    if (typeof out === 'string') return out;
    return { doc: out.doc, detail: out.detail, task: 'edited', rig: true };
  });
}

function removeLightFrom(doc: LightingDocument, lightId: string): { doc: LightingDocument; detail: string } | string {
  const light = rigLight(doc, lightId);
  if (!light) return `No light ${lightId}`;
  if (light.origin === 'artist') return { doc: { ...doc, added: doc.added.filter((a) => a.id !== lightId) }, detail: `${lightId} (${light.spec.name}), your light` };
  if (light.removed) return `${light.spec.name} is already removed`;
  return { doc: { ...doc, removed: [...doc.removed, lightId] }, detail: `${lightId} (${light.spec.name}), estimated — restore it to bring it back` };
}

/** Take a light out of the rig: an estimated one can be restored; an artist's own is gone. */
export function removeLight(p: Project, shotId: string, lightId: string, actor: string, now: Date): Result {
  return editLighting(p, shotId, actor, now, 'lighting.light_removed', (doc) => {
    const out = removeLightFrom(doc, lightId);
    if (typeof out === 'string') return out;
    return { ...out, task: 'edited', rig: true };
  });
}

export function restoreLight(p: Project, shotId: string, lightId: string, actor: string, now: Date): Result {
  return editLighting(p, shotId, actor, now, 'lighting.light_restored', (doc) => {
    if (!doc.removed.includes(lightId)) return `${lightId} is not removed`;
    return { doc: { ...doc, removed: doc.removed.filter((x) => x !== lightId) }, detail: lightId, task: 'edited', rig: true };
  });
}

/** The artist's lens figures over the estimate (focal length, film back, f-stop); null clears one. */
export function setLensOverride(p: Project, shotId: string, change: Partial<LensOverride>, actor: string, now: Date): Result {
  return editLighting(p, shotId, actor, now, 'lighting.lens', (doc) => {
    const parsed = LensOverrideSchema.safeParse({ ...doc.lens, ...change });
    if (!parsed.success) return `lens.${issue(parsed.error)}`;
    const next = parsed.data;
    const details: string[] = [];
    if (next.focalMm !== doc.lens.focalMm) details.push(next.focalMm === null ? 'focal: the estimate' : `focal ${trim(next.focalMm, 2)} mm`);
    if (JSON.stringify(next.filmBackMm) !== JSON.stringify(doc.lens.filmBackMm)) details.push(next.filmBackMm ? `film back ${trim(next.filmBackMm.width, 2)} × ${trim(next.filmBackMm.height, 2)} mm` : 'film back: the estimate');
    if (next.fStop !== doc.lens.fStop) details.push(next.fStop === null ? 'f-stop: the estimate' : `f/${trim(next.fStop, 1)}`);
    if (!details.length) return { doc, detail: 'unchanged' };
    return { doc: { ...doc, lens: next }, detail: details.join(', '), task: 'edited', rig: true };
  });
}

export interface EffectiveLens {
  focalMm: number | null;
  focalSource: LensEstimate['focalSource'];
  focalRange: Range | null;
  filmBackMm: { width: number; height: number } | null;
  filmBackSource: LensEstimate['filmBackSource'];
  fStop: number | null;
  fStopSource: LensEstimate['aperture']['source'];
  hfovDeg: number | null;
  vfovDeg: number | null;
}

const fov = (mm: number, focal: number) => (2 * Math.atan(mm / (2 * focal)) * 180) / Math.PI;

/** The lens the exports use: the artist's figures, else the estimate's middle. */
export function lightingLens(doc: LightingDocument | null | undefined): EffectiveLens {
  const est = doc?.analysis?.lens ?? null;
  const o = doc?.lens ?? { focalMm: null, filmBackMm: null, fStop: null };
  const focalMm = o.focalMm ?? est?.focalMm?.value ?? null;
  const filmBackMm = o.filmBackMm ?? est?.filmBackMm ?? null;
  const fStop = o.fStop ?? est?.aperture.fStop?.value ?? null;
  return {
    focalMm,
    focalSource: o.focalMm !== null ? 'artist' : (est?.focalSource ?? 'unknown'),
    focalRange: o.focalMm !== null ? null : (est?.focalMm ?? null),
    filmBackMm,
    filmBackSource: o.filmBackMm ? 'artist' : (est?.filmBackSource ?? 'nominal'),
    fStop,
    fStopSource: o.fStop !== null ? 'artist' : (est?.aperture.source ?? 'unknown'),
    hfovDeg: focalMm && filmBackMm ? fov(filmBackMm.width, focalMm) : null,
    vfovDeg: focalMm && filmBackMm ? fov(filmBackMm.height, focalMm) : null,
  };
}

// ---------------------------------------------------------------------------
// The AI review (addendum 14 §7): suggestions the artist accepts or rejects
// ---------------------------------------------------------------------------

export interface LightingAiReviewInput {
  model: string;
  promptVersion: string;
  summary: string;
  credits: number;
  suggestions: Omit<LightingSuggestion, 'id' | 'decision' | 'by' | 'at'>[];
}

/** Record a second opinion from the AI assistant: suggestions only, each pending until the artist decides. */
export function recordLightingAiReview(p: Project, shotId: string, input: LightingAiReviewInput, actor: string, now: Date): Result {
  const at = now.toISOString();
  return editLighting(p, shotId, actor, now, 'lighting.ai_review', (doc) => {
    const seq = doc.seq + 1;
    const usable: LightingSuggestion[] = [];
    let dropped = 0;
    for (const [i, s] of input.suggestions.slice(0, 20).entries()) {
      const id = `s${i + 1}`;
      const light = s.lightId ? rigLight(doc, s.lightId) : null;
      if ((s.kind === 'adjust' || s.kind === 'remove') && (!light || light.removed)) {
        dropped += 1;
        continue;
      }
      if (s.kind === 'adjust') {
        if (!s.change || !Object.keys(s.change).length || !LightSpecSchema.safeParse(consistent(applyFields(light!.spec, s.change), light!.spec.distanceM ?? doc.settings.subjectDistanceM)).success) {
          dropped += 1;
          continue;
        }
      }
      if (s.kind === 'add' && (!s.light || !LightSpecSchema.safeParse(consistent(s.light, doc.settings.subjectDistanceM)).success)) {
        dropped += 1;
        continue;
      }
      usable.push({ id, kind: s.kind, lightId: s.lightId ?? null, change: s.change ?? null, light: s.light ? consistent(s.light, doc.settings.subjectDistanceM) : null, reason: s.reason.slice(0, 600), confidence: Math.max(0, Math.min(1, s.confidence)), decision: 'pending', by: null, at: null });
    }
    const parsed = LightingAiReviewSchema.safeParse({ id: `r${seq}`, model: input.model, promptVersion: input.promptVersion, summary: input.summary.slice(0, 1200), credits: input.credits, suggestions: usable, editRevision: doc.editRevision, at, by: actor });
    if (!parsed.success) return `The review is not usable: ${issue(parsed.error)}`;
    const review = parsed.data;
    return {
      doc: { ...doc, reviews: [...doc.reviews, review].slice(-20), seq },
      detail: `${review.id} by ${review.model} (prompt ${review.promptVersion}, ${review.credits} credits): ${usable.length} suggestion${usable.length === 1 ? '' : 's'}${dropped ? `, ${dropped} not applicable and dropped` : ''}${review.summary ? ` — ${review.summary.slice(0, 160)}` : ''}`,
    };
  });
}

/** Accept (it is applied as an edit, logged with the model) or reject an AI suggestion. */
export function decideLightingSuggestion(p: Project, shotId: string, reviewId: string, suggestionId: string, decision: 'accepted' | 'rejected', actor: string, now: Date): Result {
  const at = now.toISOString();
  return editLighting(p, shotId, actor, now, 'lighting.ai_decision', (doc) => {
    const review = doc.reviews.find((r) => r.id === reviewId);
    const s = review?.suggestions.find((x) => x.id === suggestionId);
    if (!review || !s) return `No suggestion ${reviewId}/${suggestionId}`;
    if (s.decision !== 'pending') return `That suggestion was already ${s.decision}`;
    const from = `ai:${reviewId}/${suggestionId}`;
    let next = doc;
    let what = '';
    if (decision === 'accepted') {
      if (s.kind === 'adjust') {
        const out = applyLightChange(doc, s.lightId!, s.change ?? {}, from, actor, at);
        if (typeof out === 'string') return out;
        next = out.doc;
        what = out.detail;
      } else if (s.kind === 'add') {
        const out = addLightTo(doc, s.light!, from, actor, at);
        if (typeof out === 'string') return out;
        next = out.doc;
        what = `added ${out.detail}`;
      } else if (s.kind === 'remove') {
        const out = removeLightFrom(doc, s.lightId!);
        if (typeof out === 'string') return out;
        next = out.doc;
        what = `removed ${out.detail}`;
      } else what = 'noted';
    }
    const reviews = next.reviews.map((r) => (r.id === reviewId ? { ...r, suggestions: r.suggestions.map((x) => (x.id === suggestionId ? { ...x, decision, by: actor, at } : x)) } : r));
    const changes = decision === 'accepted' && s.kind !== 'note';
    return {
      doc: { ...next, reviews },
      detail: `${reviewId}/${suggestionId} from ${review.model} ${decision}${what ? `: ${what}` : ''}${s.reason ? ` (“${s.reason.slice(0, 120)}”)` : ''}`,
      ...(changes ? { task: 'edited' as const, rig: true } : {}),
    };
  });
}

export const pendingLightingSuggestions = (doc: LightingDocument | null | undefined) => (doc?.reviews ?? []).flatMap((r) => r.suggestions.filter((s) => s.decision === 'pending').map((s) => ({ review: r, suggestion: s })));

// ---------------------------------------------------------------------------
// Summary, export and the manifest (§13, §17, §18)
// ---------------------------------------------------------------------------

export interface LightingSummary {
  analysed: boolean;
  current: boolean;
  lights: number;
  estimated: number;
  added: number;
  edited: number;
  removed: number;
  key: { id: string; azimuth: Range; elevation: Range } | null;
  keyConfidence: number | null;
  matchScore: number | null;
  focal: Range | null;
  focalSource: LensEstimate['focalSource'] | null;
  pendingSuggestions: number;
  warnings: string[];
}

export function lightingSummary(doc: LightingDocument | null | undefined): LightingSummary {
  const rig = lightingRig(doc);
  const a = doc?.analysis ?? null;
  const key = a?.lights.find((l) => (l.role === 'key' || l.role === 'sun') && !doc!.removed.includes(l.id)) ?? null;
  return {
    analysed: Boolean(a),
    current: lightingAnalysisCurrent(doc),
    lights: rig.filter((l) => l.spec.enabled).length,
    estimated: rig.filter((l) => l.origin === 'estimate').length,
    added: doc?.added.length ?? 0,
    edited: rig.filter((l) => l.origin === 'estimate' && l.locked.length).length,
    removed: doc?.removed.length ?? 0,
    key: key ? { id: key.id, azimuth: key.azimuth, elevation: key.elevation } : null,
    keyConfidence: a?.keyConfidence ?? null,
    matchScore: a?.matchScore ?? null,
    focal: a?.lens.focalMm ?? null,
    focalSource: a?.lens.focalSource ?? null,
    pendingSuggestions: pendingLightingSuggestions(doc).length,
    warnings: a?.warnings ?? [],
  };
}

/** Is there a rig to export? (null when there is, else what is missing.) */
export function lightingExportProblem(doc: LightingDocument | null | undefined): string | null {
  if (!doc || (!doc.analysis && !doc.added.length)) return 'Analyse the frame first (step 2), or add a light by hand (step 3).';
  if (!lightingRig(doc).some((l) => l.spec.enabled)) return 'Every light is off: turn one on (step 3).';
  return null;
}

/** Record a written export and submit the rig for review (never approval). */
export function recordLightingExport(p: Project, shotId: string, record: LightingExportInput, actor: string, now: Date): Result {
  const at = now.toISOString();
  const parsed = LightingExportSchema.safeParse({ ...record, writtenAt: at, by: actor });
  if (!parsed.success) return { ok: false, reason: `The export record is not usable: ${parsed.error.issues[0]?.message ?? 'bad data'}` };
  const rec = parsed.data;
  return editLighting(p, shotId, actor, now, 'lighting.exported', (doc, s) => {
    const v = lightingTaskVersion(s);
    if (rec.version !== v) return `That export is ${versionTag(rec.version)}; the task is ${versionTag(v)}`;
    return {
      doc: { ...doc, exports: [...doc.exports.filter((e) => e.version !== rec.version), rec].sort((a, b) => a.version - b.version) },
      detail: `${versionTag(rec.version)}: ${rec.folder}, ${rec.lights} light${rec.lights === 1 ? '' : 's'}, ${rec.formats.join(' + ')}, camera from the ${rec.camera === 'solve' ? 'camera track' : 'lens estimate'}; ${rec.files.length} files; settings r${rec.revision}, rig r${rec.editRevision}`,
      task: 'review',
    };
  });
}

/** File names (§17): `<shot>_light_v001/` with `<shot>_light_v001_unreal.py` … */
export const lightingNames = {
  folder: (shot: string, version: number) => `${shot}_light_${versionTag(version)}`,
  stem: (shot: string, version: number) => `${shot}_light_${versionTag(version)}`,
  unreal: (stem: string) => `${stem}_unreal.py`,
  rig: (stem: string) => `${stem}_rig.json`,
  usd: (stem: string) => `${stem}.usda`,
  blender: (stem: string) => `${stem}_blender.py`,
  report: (stem: string) => `${stem}_report.html`,
  frame: (stem: string) => `${stem}_frame.png`,
  readme: () => 'README.txt',
  /** Every file of a version starts with this. */
  prefix: (shot: string) => `${shot}_light_`,
};

/** Everything that decides the estimate and the rig, for the JSON and for reproducing it (§19). */
export function lightingSettingsRecord(doc: LightingDocument) {
  return {
    algorithm: doc.algorithm,
    revision: doc.revision,
    editRevision: doc.editRevision,
    settings: doc.settings,
    references: doc.references.map((r) => ({ id: r.id, kind: r.kind, name: r.name, from: r.from, path: r.path, frame: r.frame, circle: r.circle, headingDeg: r.headingDeg, checksum: r.checksum, width: r.width, height: r.height, encoding: r.encoding })),
    edits: doc.edits,
    added: doc.added,
    removed: doc.removed,
    lens: doc.lens,
  };
}

export interface LightingPlacement {
  id: string;
  /** In the export's scene (Y-up, the camera track's units): where the light is and the way it shines. */
  position: [number, number, number] | null;
  direction: [number, number, number];
}

/** The rig file written beside the scripts (`<shot>_light_vNNN_rig.json`); the Unreal script reads it. */
export function lightingRigData(
  p: Project,
  shotId: string,
  info: {
    version: number;
    generator: string;
    writtenAt: string;
    by: string;
    units: string;
    camera: { source: 'solve' | 'estimate'; position: [number, number, number]; rotation: number[]; focalMm: number; filmBackMm: { width: number; height: number }; frame: number; width: number; height: number };
    subject: [number, number, number];
    placements: LightingPlacement[];
    intensities: Record<string, { lux: number; candela: number | null; unreal: number; unrealUnit: string }>;
    files: Record<string, string>;
  },
) {
  const shot = handoffShot(p, shotId);
  const s = shotState(p, shotId);
  const doc = lightingDoc(s);
  if (!shot || !s || !doc) throw new Error(`No lighting analysis for ${shotId}`);
  const rig = lightingRig(doc);
  const a = doc.analysis;
  return {
    format: 'vcvfx.lighting/1',
    generator: info.generator,
    shot: shotName(s),
    handoffShotId: shot.shotId,
    task: LIGHTING_TASK,
    version: versionTag(info.version),
    writtenAt: info.writtenAt,
    by: info.by,
    conventions: {
      direction: 'Azimuth and elevation are relative to the camera at the analysed frame, seen from the subject: azimuth 0° = from the camera’s side, +90° = from frame right, ±180° = from behind the subject; elevation 0° = level with the camera’s horizon, +90° = from straight above.',
      scene: `Positions and directions are in the camera track’s scene (Y-up, right-handed, ${info.units}); without a camera track the camera is at the origin looking down −Z, level. The Unreal script converts to Z-up, left-handed centimetres exactly as the camera-track export does.`,
      intensity: 'intensityStops is relative to the key’s illuminance at the subject (the key is 0). With the exposure reference keyLux: illuminance = keyLux × 2^stops lux; a positional light’s candela = illuminance × distance² (m).',
      ranges: 'Every estimate carries a range [low, high] it is believed to lie in, with the evidence it rests on; the artist’s values (locked fields) carry none.',
    },
    camera: { ...info.camera, lens: lightingLens(doc), estimate: a?.lens ?? null },
    subject: { position: info.subject, distanceM: doc.settings.subjectDistanceM },
    exposure: { keyLux: doc.settings.keyLux, ev100: Math.log2(doc.settings.keyLux / 2.5) },
    lights: rig.map((l) => {
      const placed = info.placements.find((x) => x.id === l.id);
      return {
        id: l.id,
        origin: l.origin,
        from: l.from,
        ...l.spec,
        locked: l.locked,
        ranges: l.estimate
          ? { azimuthDeg: l.estimate.azimuth, elevationDeg: l.estimate.elevation, distanceM: l.estimate.distance, intensityStops: l.estimate.intensity, sizeDeg: l.estimate.size, temperatureK: l.estimate.temperature }
          : null,
        evidence: l.estimate?.evidence ?? ['artist'],
        motivation: l.estimate?.motivation ?? '',
        confidence: l.estimate?.confidence ?? null,
        practical: l.estimate?.practical ?? null,
        scene: placed ? { position: placed.position, direction: placed.direction } : null,
        intensity: info.intensities[l.id] ?? null,
      };
    }),
    analysis: a
      ? { algorithm: a.algorithm, frame: a.frame, frames: a.frames, keyConfidence: a.keyConfidence, matchScore: a.matchScore, subject: a.subject, sky: a.sky, ground: a.ground, whiteBalance: a.whiteBalance, marks: a.marks, warnings: a.warnings, at: a.at, by: a.by }
      : null,
    reviews: doc.reviews.map((r) => ({ id: r.id, model: r.model, promptVersion: r.promptVersion, summary: r.summary, at: r.at, by: r.by, suggestions: r.suggestions.map((x) => ({ id: x.id, kind: x.kind, lightId: x.lightId, reason: x.reason, decision: x.decision, by: x.by })) })),
    settings: lightingSettingsRecord(doc),
    summary: lightingSummary(doc),
    files: info.files,
    approval: s.tasks.find((t) => t.kind === LIGHTING_TASK)?.approval ?? null,
  };
}
export type LightingRigData = ReturnType<typeof lightingRigData>;

/** The lighting section of the package manifest (§18), or null when not started. */
export function lightingManifest(s: ShotState) {
  const doc = lightingDoc(s);
  if (!doc) return null;
  const task = s.tasks.find((t) => t.kind === LIGHTING_TASK);
  const version = task?.version ?? 1;
  const exported = doc.exports.find((e) => e.version === version) ?? null;
  const summary = lightingSummary(doc);
  const lens = lightingLens(doc);
  return {
    task: LIGHTING_TASK,
    version: versionTag(version),
    state: task?.state ?? null,
    approval: task?.approval ?? null,
    exported: exported !== null,
    folder: exported?.folder ?? null,
    files: exported ? exported.files.map((f) => `${exported.folder}/${f}`) : [],
    formats: exported?.formats ?? [],
    camera: exported?.camera ?? null,
    algorithm: `${doc.algorithm.id}@${doc.algorithm.version}`,
    revision: exported?.revision ?? doc.revision,
    editRevision: exported?.editRevision ?? doc.editRevision,
    frame: doc.analysis?.frame ?? null,
    lights: lightingRig(doc).map((l) => ({ id: l.id, role: l.spec.role, type: l.spec.type, name: l.spec.name, enabled: l.spec.enabled, origin: l.origin, locked: l.locked.length })),
    lens: { focalMm: lens.focalMm, source: lens.focalSource, range: lens.focalRange, filmBackMm: lens.filmBackMm },
    references: doc.references.map((r) => ({ id: r.id, kind: r.kind, name: r.name, from: r.from, path: r.path, checksum: r.checksum?.value ?? null })),
    confidence: { key: summary.keyConfidence, match: summary.matchScore },
    aiReviews: doc.reviews.map((r) => ({ id: r.id, model: r.model, suggestions: r.suggestions.length, accepted: r.suggestions.filter((x) => x.decision === 'accepted').length })),
  };
}
