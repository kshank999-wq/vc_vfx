import { addTask, contactSheetFrames, handoffShot, shotState, type LogEntry, type Project, type Result, type ShotState } from './project.js';
import { framePattern, frameFileName, versionTag } from './frames.js';
import { addPart, newRotoDocument, partIdFor, recordPropagation, rotoPart, setKeyFrame } from './roto.js';
import {
  BgMatchSchema,
  DEFAULT_KEY_PARAMS,
  DEFAULT_KEY_SUBJECT,
  KeySubjectRunSchema,
  KeySubjectSchema,
  DespillSchema,
  KEY_ALGORITHM,
  KEY_FORMAT_VERSION,
  KeyExportSchema,
  KeyLinkSchema,
  KeyParamsSchema,
  LightWrapSchema,
  ScreenSampleSchema,
  ScreenSchema,
  type BgMatchInput,
  type DespillSettings,
  type KeyBackground,
  type KeyDocument,
  type KeyExportInput,
  type KeyFrameRecord,
  type KeyLink,
  type KeyMetrics,
  type KeyParams,
  type KeyRgb,
  type KeyScreen,
  type KeySubject,
  type KeySubjectRun,
  type LightWrapSettings,
  type ScreenKind,
  type ScreenSample,
} from './key-schema.js';

export * from './key-schema.js';

/**
 * Green/blue-screen keying as a model (master spec §6, §7, §15, §19;
 * addendum 09).
 *
 * Every mutation is pure, returns a new project, and is logged with who and
 * when. The rules are roto's:
 *  - keying is the shot's `key` task (and its `despill` task when it has one):
 *    changing a setting starts the work or reopens a review for correction, a
 *    finished run or an export puts it up for review, and nothing here
 *    approves it — approval is `approveTask`, a named human act, and needs an
 *    export of the version being approved;
 *  - approved keys are never changed in place: every edit is refused until the
 *    task is reopened, which bumps its version, so the next export writes
 *    `v002` beside the approved `v001`;
 *  - the settings are what the key is reproduced from (§19): every change bumps
 *    `revision`, and each run and export records the revision it keyed with.
 *    Mattes, clean plates and foregrounds are files, never in the project.
 */

const MAX_RUNS = 200;
/** Confidence below which a frame is a problem (as roto). */
export const KEY_LOW_CONFIDENCE = 0.6;

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

export function newKeyDocument(kind: ScreenKind | null = null): KeyDocument {
  return {
    formatVersion: KEY_FORMAT_VERSION,
    algorithm: { ...KEY_ALGORITHM },
    screen: kind ? { kind, source: 'auto', rgb: kind === 'green' ? [0.08, 0.45, 0.1] : [0.06, 0.12, 0.5], samples: [], coverage: null, frames: [], track: true } : null,
    params: { ...DEFAULT_KEY_PARAMS },
    links: [],
    subject: { ...DEFAULT_KEY_SUBJECT, seed: { frame: null, box: null, points: [] } },
    despill: DespillSchema.parse({}),
    lightWrap: LightWrapSchema.parse({}),
    match: { suggestion: null, preview: false },
    frames: [],
    runs: [],
    exports: [],
    workingWidth: 1920,
    revision: 0,
    seq: 0,
  };
}

const shotName = (s: ShotState) => s.vfxShotId ?? s.shotId;

/** Why the key on this shot cannot be changed right now, or null. */
export function keyLocked(s: ShotState): string | null {
  if (s.stage !== 'prep') return `${shotName(s)} is ${s.stage}; reopen it before changing its key`;
  const task = s.tasks.find((t) => t.kind === 'key');
  if (!task) return `${shotName(s)} has no Green/blue-screen key task. Add it first.`;
  if (task.state === 'approved') return `Key ${versionTag(task.version)} is approved. Reopen it (Needs correction) to make ${versionTag(task.version + 1)}; the approved key is kept.`;
  return null;
}

/** Why the despill settings cannot change: the key's lock, or an approved despill task. */
export function despillLocked(s: ShotState): string | null {
  const locked = keyLocked(s);
  if (locked) return locked;
  const task = s.tasks.find((t) => t.kind === 'despill');
  if (task?.state === 'approved') return `Despill ${versionTag(task.version)} is approved. Reopen it to change the despill.`;
  return null;
}

export function keyTaskVersion(s: ShotState): number {
  return s.tasks.find((t) => t.kind === 'key')?.version ?? 1;
}

type TaskMove = 'edited' | 'review';

/**
 * Change a shot's key document. Starts one when the shot has none. `fn`
 * returns the new document (or a refusal) and how the tasks move. A change of
 * settings bumps the revision.
 */
function editKey(
  p: Project,
  shotId: string,
  actor: string,
  now: Date,
  action: string,
  fn: (doc: KeyDocument, s: ShotState) => { doc: KeyDocument; detail: string; task?: TaskMove; despill?: TaskMove | null; settings?: boolean } | string,
  options: { despill?: boolean } = {},
): Result {
  const at = now.toISOString();
  let detail = '';
  let started = false;
  const moves: string[] = [];
  const r = withShot(p, shotId, (s) => {
    const locked = options.despill ? despillLocked(s) : keyLocked(s);
    if (locked) return locked;
    started = s.key === null;
    const out = fn(s.key ?? newKeyDocument(), s);
    if (typeof out === 'string') return out;
    detail = out.detail;
    const doc = out.settings ? { ...out.doc, revision: out.doc.revision + 1 } : out.doc;
    type Task = ShotState['tasks'][number];
    const move = (kind: 'key' | 'despill', how: TaskMove | null | undefined) => (t: Task): Task => {
      if (t.kind !== kind || !how || t.state === 'approved') return t;
      // A change starts the work, or reopens a review for correction; a finished run goes to review (§15.6).
      const next: Task['state'] = how === 'review' ? 'needs_review' : t.state === 'pending' ? 'processing' : t.state === 'needs_review' ? 'needs_correction' : t.state;
      if (next === t.state) return t;
      moves.push(`${kind} → ${next}`);
      return { ...t, state: next };
    };
    const tasks = s.tasks.map(move('key', out.task)).map(move('despill', out.despill));
    return { ...s, tasks, key: doc };
  });
  if (!r.ok) return r;
  let out = r.project;
  if (started) out = logged(out, { at, actor, shotId, action: 'key.started', detail: `${KEY_ALGORITHM.id}@${KEY_ALGORITHM.version}` });
  out = logged(out, { at, actor, shotId, action, detail });
  for (const m of moves) out = logged(out, { at, actor, shotId, action: 'task.state', detail: m });
  return { ok: true, project: out };
}

const fmt = (v: readonly number[]) => `(${v.map((x) => x.toFixed(4)).join(', ')})`;
const validFrame = (frame: number) => Number.isInteger(frame) && frame >= 0;

// ---------------------------------------------------------------------------
// Screen colour (§6 bullet 1)
// ---------------------------------------------------------------------------

/** Record a detected screen colour (or adopt one): kind, linear colour, coverage, the frames looked at. */
export function setKeyScreen(
  p: Project,
  shotId: string,
  input: { kind: ScreenKind; source: 'auto' | 'manual'; rgb: KeyRgb; coverage?: number | null; frames?: number[]; samples?: ScreenSample[]; track?: boolean },
  actor: string,
  now: Date,
): Result {
  return editKey(p, shotId, actor, now, 'key.screen', (doc) => {
    const parsed = ScreenSchema.safeParse({ ...input, samples: input.samples ?? (input.source === 'manual' ? doc.screen?.samples ?? [] : []), track: input.track ?? doc.screen?.track ?? true });
    if (!parsed.success) return `The screen colour is not usable: ${parsed.error.issues[0]?.message ?? 'bad data'}`;
    const screen = parsed.data;
    if (screen.rgb.some((v) => v < 0) || Math.max(...screen.rgb) <= 0) return 'A screen colour is a positive linear colour';
    return {
      doc: { ...doc, screen },
      detail: `${screen.kind} screen ${screen.source === 'auto' ? 'detected' : 'sampled'} ${fmt(screen.rgb)}${screen.coverage !== null ? `, ${(screen.coverage * 100).toFixed(1)} % of the frame` : ''}${screen.frames.length ? ` on frames ${screen.frames.join(', ')}` : ''}`,
      task: 'edited',
      settings: true,
    };
  });
}

/** The mean of the eyedropper samples (null when there are none). */
export function meanSample(samples: readonly ScreenSample[]): KeyRgb | null {
  if (!samples.length) return null;
  const s = samples.reduce((a, x) => [a[0] + x.rgb[0], a[1] + x.rgb[1], a[2] + x.rgb[2]] as KeyRgb, [0, 0, 0] as KeyRgb);
  return [s[0] / samples.length, s[1] / samples.length, s[2] / samples.length];
}

/** Which screen a colour is: the stronger of green and blue against the other channels. */
export function screenKindOf(rgb: KeyRgb): ScreenKind {
  const [r, g, b] = rgb;
  return g - Math.max(r, b) >= b - Math.max(r, g) ? 'green' : 'blue';
}

/** Add an eyedropper sample: the screen becomes the mean of the samples (manual). */
export function addScreenSample(p: Project, shotId: string, sample: ScreenSample, actor: string, now: Date): Result {
  const parsed = ScreenSampleSchema.safeParse(sample);
  if (!parsed.success) return { ok: false, reason: `That sample is not usable: ${parsed.error.issues[0]?.message ?? 'bad data'}` };
  const s = parsed.data;
  if (!validFrame(s.frame)) return { ok: false, reason: 'Not a frame number' };
  if (s.rgb.some((v) => !(v >= 0)) || Math.max(...s.rgb) <= 0) return { ok: false, reason: 'That sample is black; sample the screen' };
  return editKey(p, shotId, actor, now, 'key.screen_sample', (doc) => {
    const samples = [...(doc.screen?.source === 'manual' ? doc.screen.samples : []), s];
    if (samples.length > 64) return 'At most 64 samples; clear them and sample again';
    const rgb = meanSample(samples)!;
    const kind = doc.screen?.source === 'manual' ? doc.screen.kind : screenKindOf(rgb);
    return {
      doc: { ...doc, screen: { kind, source: 'manual', rgb, samples, coverage: null, frames: [...new Set(samples.map((x) => x.frame))].sort((a, b) => a - b), track: doc.screen?.track ?? true } },
      detail: `frame ${s.frame} at (${s.x.toFixed(0)}, ${s.y.toFixed(0)}) r ${s.radius}: ${fmt(s.rgb)}; screen now ${fmt(rgb)} from ${samples.length} sample${samples.length === 1 ? '' : 's'}`,
      task: 'edited',
      settings: true,
    };
  });
}

export function clearScreenSamples(p: Project, shotId: string, actor: string, now: Date): Result {
  return editKey(p, shotId, actor, now, 'key.screen_samples_cleared', (doc) => {
    if (!doc.screen || doc.screen.source !== 'manual') return 'There are no samples to clear';
    return { doc: { ...doc, screen: null }, detail: `${doc.screen.samples.length} samples cleared; run Auto key to detect the screen again`, task: 'edited', settings: true };
  });
}

/** The green/blue toggle (and per-frame screen tracking). */
export function setScreenKind(p: Project, shotId: string, change: { kind?: ScreenKind; track?: boolean }, actor: string, now: Date): Result {
  return editKey(p, shotId, actor, now, 'key.screen_kind', (doc) => {
    const screen: KeyScreen = doc.screen ?? newKeyDocument(change.kind ?? 'green').screen!;
    const next = { ...screen, ...(change.kind ? { kind: change.kind } : {}), ...(change.track !== undefined ? { track: change.track } : {}) };
    if (change.kind && change.kind !== screen.kind && screen.source === 'auto') {
      // The detected colour was of the other screen: a starting colour until detection runs again.
      next.rgb = newKeyDocument(change.kind).screen!.rgb;
      next.coverage = null;
    }
    if (next.kind === screen.kind && next.track === screen.track && doc.screen) return { doc, detail: 'unchanged' };
    return { doc: { ...doc, screen: next }, detail: `${next.kind} screen${change.track !== undefined ? `, screen tracking ${next.track ? 'on' : 'off'}` : ''}`, task: 'edited', settings: true };
  });
}

// ---------------------------------------------------------------------------
// Parameters, links, despill, light wrap, match
// ---------------------------------------------------------------------------

export function setKeyParams(p: Project, shotId: string, change: Partial<KeyParams>, actor: string, now: Date): Result {
  return editKey(p, shotId, actor, now, 'key.params', (doc) => {
    const parsed = KeyParamsSchema.safeParse({ ...doc.params, ...change });
    if (!parsed.success) return `${parsed.error.issues[0]?.path.join('.') ?? 'value'}: ${parsed.error.issues[0]?.message ?? 'out of range'}`;
    const params = parsed.data;
    if (params.clipWhite - params.clipBlack < 0.05) return 'The white clip must be above the black clip';
    const changed = (Object.keys(change) as (keyof KeyParams)[]).filter((k) => params[k] !== doc.params[k]);
    if (!changed.length) return { doc, detail: 'unchanged' };
    return { doc: { ...doc, params }, detail: changed.map((k) => `${k} ${String(doc.params[k])} → ${String(params[k])}`).join(', '), task: 'edited', settings: true };
  });
}

export function resetKeyParams(p: Project, shotId: string, actor: string, now: Date): Result {
  return editKey(p, shotId, actor, now, 'key.params_reset', (doc) => ({ doc: { ...doc, params: { ...DEFAULT_KEY_PARAMS } }, detail: 'defaults', task: 'edited', settings: true }));
}

export type KeyLinkInput = Omit<Partial<KeyLink>, 'id'> & Pick<KeyLink, 'kind' | 'source'>;

const linkLabel = (l: Pick<KeyLink, 'kind' | 'source' | 'invert' | 'mode' | 'label'>, doc?: { rotoName?: string }) =>
  `${l.kind}${l.kind === 'repair' ? ` (${l.mode})` : ''}${l.invert ? ' inverted' : ''} from ${l.source.type === 'roto' ? `roto part ${doc?.rotoName ?? l.source.partId}` : `box ${Math.round(l.source.rect.x0)},${Math.round(l.source.rect.y0)}–${Math.round(l.source.rect.x1)},${Math.round(l.source.rect.y1)}`}${l.label ? ` “${l.label}”` : ''}`;

/** Use a roto part or a drawn box as a garbage matte, holdout or repair region. */
export function addKeyLink(p: Project, shotId: string, input: KeyLinkInput, actor: string, now: Date): Result {
  return editKey(p, shotId, actor, now, 'key.link_added', (doc, s) => {
    const seq = doc.seq + 1;
    const parsed = KeyLinkSchema.safeParse({ softnessPx: input.kind === 'repair' ? 1 : 2, growPx: input.kind === 'repair' && input.source.type === 'roto' ? 12 : 0, ...input, id: `l${seq}` });
    if (!parsed.success) return `That ${input.kind} is not usable: ${parsed.error.issues[0]?.message ?? 'bad data'}`;
    const link = parsed.data;
    if (link.source.type === 'roto' && !rotoPart(s.roto, link.source.partId)) return `No roto part “${link.source.partId}”. Paint it in the Roto tab first.`;
    if (link.frames && link.frames.last < link.frames.first) return 'The frame range is inverted';
    if (doc.links.length >= 32) return 'At most 32 garbage, holdout and repair mattes';
    const rotoName = link.source.type === 'roto' ? rotoPart(s.roto, link.source.partId)?.name : undefined;
    return { doc: { ...doc, links: [...doc.links, link], seq }, detail: `${link.id}: ${linkLabel(link, { ...(rotoName ? { rotoName } : {}) })}`, task: 'edited', settings: true };
  });
}

export function updateKeyLink(p: Project, shotId: string, id: string, change: Partial<Omit<KeyLink, 'id'>>, actor: string, now: Date): Result {
  return editKey(p, shotId, actor, now, 'key.link_changed', (doc) => {
    const link = doc.links.find((l) => l.id === id);
    if (!link) return `No key matte ${id}`;
    const parsed = KeyLinkSchema.safeParse({ ...link, ...change, id });
    if (!parsed.success) return `That change is not usable: ${parsed.error.issues[0]?.message ?? 'bad data'}`;
    const next = parsed.data;
    const changed = (Object.keys(change) as (keyof KeyLink)[]).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(link[k]));
    if (!changed.length) return { doc, detail: 'unchanged' };
    return { doc: { ...doc, links: doc.links.map((l) => (l.id === id ? next : l)) }, detail: `${id}: ${changed.map((k) => `${k} ${JSON.stringify(next[k])}`).join(', ')}`, task: 'edited', settings: true };
  });
}

export function removeKeyLink(p: Project, shotId: string, id: string, actor: string, now: Date): Result {
  return editKey(p, shotId, actor, now, 'key.link_removed', (doc) => {
    const link = doc.links.find((l) => l.id === id);
    if (!link) return `No key matte ${id}`;
    return { doc: { ...doc, links: doc.links.filter((l) => l.id !== id) }, detail: `${id}: ${linkLabel(link)}`, task: 'edited', settings: true };
  });
}

export function setDespill(p: Project, shotId: string, change: Partial<DespillSettings>, actor: string, now: Date): Result {
  return editKey(
    p,
    shotId,
    actor,
    now,
    'key.despill',
    (doc) => {
      const parsed = DespillSchema.safeParse({ ...doc.despill, ...change });
      if (!parsed.success) return `${parsed.error.issues[0]?.path.join('.') ?? 'value'}: ${parsed.error.issues[0]?.message ?? 'out of range'}`;
      const despill = parsed.data;
      const changed = (Object.keys(change) as (keyof DespillSettings)[]).filter((k) => JSON.stringify(despill[k]) !== JSON.stringify(doc.despill[k]));
      if (!changed.length) return { doc, detail: 'unchanged' };
      return { doc: { ...doc, despill }, detail: changed.map((k) => `${k} ${JSON.stringify(despill[k])}`).join(', '), task: 'edited', despill: 'edited', settings: true };
    },
    { despill: true },
  );
}

/** The background the despill and light wrap draw on: none, the handoff's background plate, a file, or a frame of the shot. */
export function setKeyBackground(p: Project, shotId: string, background: KeyBackground, actor: string, now: Date): Result {
  if (background.kind === 'frame' && (background.frame === null || !validFrame(background.frame))) return { ok: false, reason: 'Choose the frame to use as the background' };
  if ((background.kind === 'reference' || background.kind === 'file') && !background.path) return { ok: false, reason: 'Choose the background file' };
  return setDespill(p, shotId, { background: { ...background, label: background.label || (background.kind === 'frame' ? `frame ${background.frame}` : background.kind === 'none' ? '' : (background.path ?? '').split(/[\\/]/).pop() ?? '') } }, actor, now);
}

/** Background plates the handoff names for this shot (§18 "background-plate relationships"). */
export function backgroundReferences(p: Project, shotId: string): string[] {
  return (handoffShot(p, shotId)?.references ?? []).filter((r) => r.kind === 'background_plate').map((r) => r.path);
}

export function setLightWrap(p: Project, shotId: string, change: Partial<LightWrapSettings>, actor: string, now: Date): Result {
  return editKey(p, shotId, actor, now, 'key.light_wrap', (doc) => {
    const parsed = LightWrapSchema.safeParse({ ...doc.lightWrap, ...change });
    if (!parsed.success) return `${parsed.error.issues[0]?.path.join('.') ?? 'value'}: ${parsed.error.issues[0]?.message ?? 'out of range'}`;
    const lightWrap = parsed.data;
    const changed = (Object.keys(change) as (keyof LightWrapSettings)[]).filter((k) => lightWrap[k] !== doc.lightWrap[k]);
    if (!changed.length) return { doc, detail: 'unchanged' };
    // Preview-only changes do not change what a run or an export writes, except `output`.
    const settings = changed.some((k) => k !== 'preview');
    return { doc: { ...doc, lightWrap }, detail: changed.map((k) => `${k} ${String(lightWrap[k])}`).join(', '), ...(settings ? { task: 'edited' as const, settings: true } : {}) };
  });
}

/** Record a suggested foreground → background match (§7 bullet 3). Metadata; never applied to the prep output. */
export function recordBgMatch(p: Project, shotId: string, input: BgMatchInput, actor: string, now: Date): Result {
  const at = now.toISOString();
  return editKey(p, shotId, actor, now, 'key.match_suggested', (doc) => {
    const parsed = BgMatchSchema.safeParse({ strength: doc.match.suggestion?.strength ?? 0.5, ...input, at, by: actor });
    if (!parsed.success) return `The match is not usable: ${parsed.error.issues[0]?.message ?? 'bad data'}`;
    const m = parsed.data;
    return {
      doc: { ...doc, match: { ...doc.match, suggestion: m } },
      detail: `frame ${m.frame}: gain ${fmt(m.gain)}, offset ${fmt(m.offset)}, ${m.exposureStops >= 0 ? '+' : ''}${m.exposureStops.toFixed(2)} stops, confidence ${m.confidence.toFixed(2)} from ${m.samples.foreground}/${m.samples.background} samples (suggestion only; not applied to outputs)`,
    };
  });
}

export function setMatchPreview(p: Project, shotId: string, change: { preview?: boolean; strength?: number }, actor: string, now: Date): Result {
  return editKey(p, shotId, actor, now, 'key.match_preview', (doc) => {
    if (change.strength !== undefined && !(change.strength >= 0 && change.strength <= 1)) return 'Match strength is 0 to 1';
    const suggestion = doc.match.suggestion && change.strength !== undefined ? { ...doc.match.suggestion, strength: change.strength } : doc.match.suggestion;
    return { doc: { ...doc, match: { preview: change.preview ?? doc.match.preview, suggestion } }, detail: `preview ${(change.preview ?? doc.match.preview) ? 'on' : 'off'}${change.strength !== undefined ? `, strength ${change.strength}` : ''}` };
  });
}

export const KEY_WORKING_WIDTHS = [960, 1280, 1920, 2560] as const;

export function setKeyWorkingWidth(p: Project, shotId: string, width: number, actor: string, now: Date): Result {
  if (!Number.isInteger(width) || width < 256 || width > 8192) return { ok: false, reason: 'Working width is 256 to 8192 px' };
  return editKey(p, shotId, actor, now, 'key.working_width', (doc) => (doc.workingWidth === width ? { doc, detail: `unchanged (${width})` } : { doc: { ...doc, workingWidth: width }, detail: `${doc.workingWidth} → ${width} px` }));
}

// ---------------------------------------------------------------------------
// Confidence and problem frames (§6 "problem-frame review", §15.4, §19)
// ---------------------------------------------------------------------------

/**
 * A frame's confidence from its own measurements (addendum 09 §5): holes in
 * the subject and an unsolid core weigh most, then a screen that no longer
 * matches its model (a lighting change), then an unusually busy soft edge,
 * and a frame with almost no screen in it cannot be judged well.
 */
// ---------------------------------------------------------------------------
// The subject prior (hybrid key, addendum 18)
// ---------------------------------------------------------------------------

export type KeySubjectChange = Partial<Pick<KeySubject, 'source' | 'partId' | 'engine' | 'marginPx' | 'outside'>> & { seed?: Partial<KeySubject['seed']> };

/**
 * Choose the subject segmentation the key uses as its core prior, and how.
 * Every change affects pixels (revision bump); a change of what an Auto
 * segmentation is made from (engine, seed) also makes its run stale.
 */
export function setKeySubject(p: Project, shotId: string, change: KeySubjectChange, actor: string, now: Date): Result {
  return editKey(p, shotId, actor, now, 'key.subject', (doc, s) => {
    const cur = doc.subject;
    const seed = change.seed ? { ...cur.seed, ...change.seed } : cur.seed;
    const parsed = KeySubjectSchema.safeParse({ ...cur, ...change, seed });
    if (!parsed.success) return `${parsed.error.issues[0]?.path.join('.') ?? 'value'}: ${parsed.error.issues[0]?.message ?? 'out of range'}`;
    let next = parsed.data;
    if (next.source === 'roto') {
      if (!next.partId) return 'Choose the roto part that is the subject.';
      if (!rotoPart(s.roto, next.partId)) return `No roto part “${next.partId}”. Paint it in the Roto tab first.`;
    }
    const madeFrom = (k: KeySubject) => JSON.stringify([k.engine, k.seed]);
    const restarted = madeFrom(next) !== madeFrom(cur);
    if (restarted) next = { ...next, revision: cur.revision + 1 };
    const fields: string[] = [];
    if (next.source !== cur.source) fields.push(`source ${cur.source} → ${next.source}`);
    if (next.partId !== cur.partId && next.source === 'roto') fields.push(`part ${next.partId}`);
    if (next.engine !== cur.engine) fields.push(`engine ${cur.engine} → ${next.engine}`);
    if (JSON.stringify(next.seed) !== JSON.stringify(cur.seed)) {
      const b = next.seed.box;
      fields.push(`seed ${next.seed.frame ?? 'middle frame'}${b ? `, box ${Math.round(b.x0)},${Math.round(b.y0)}–${Math.round(b.x1)},${Math.round(b.y1)}` : ''}${next.seed.points.length ? `, ${next.seed.points.length} clicks` : ''}${!b && !next.seed.points.length ? ', from the key' : ''}`);
    }
    if (next.marginPx !== cur.marginPx) fields.push(`margin ${cur.marginPx} → ${next.marginPx} px`);
    if (next.outside !== cur.outside) fields.push(next.outside ? 'outside is garbage' : 'outside kept');
    if (!fields.length) return { doc, detail: 'unchanged' };
    return { doc: { ...doc, subject: next }, detail: fields.join(', '), task: 'edited', settings: true };
  });
}

/** Whether the Auto segmentation needs (re)running: none yet, or made from an older seed or engine. */
export function keySubjectStale(doc: KeyDocument | null | undefined): boolean {
  if (!doc || doc.subject.source !== 'auto') return false;
  return !doc.subject.run || doc.subject.run.revision !== doc.subject.revision;
}

export type KeySubjectRunInput = Omit<KeySubjectRun, 'at' | 'by' | 'taskVersion' | 'meanConfidence' | 'fallback'> & { fallback?: string | null };

/**
 * Record an Auto segmentation run (the masks are in the key cache). A run made
 * from an older seed is refused. It changes the key's pixels, so the settings
 * revision is bumped and processed frames go stale like any setting change.
 */
export function recordKeySubjectRun(p: Project, shotId: string, input: KeySubjectRunInput, actor: string, now: Date): Result {
  return editKey(p, shotId, actor, now, 'key.subject_run', (doc, s) => {
    if (doc.subject.source !== 'auto') return 'The subject is not set to Auto.';
    if (input.revision !== doc.subject.revision) return 'The subject seed changed while it ran; run it again.';
    if (!input.frames.length) return 'The segmentation produced no frames';
    const frames = [...input.frames].sort((a, b) => a.frame - b.frame);
    const mean = Math.round((frames.reduce((a, f) => a + f.confidence, 0) / frames.length) * 1000) / 1000;
    const parsed = KeySubjectRunSchema.safeParse({ ...input, frames, meanConfidence: mean, fallback: input.fallback ?? null, taskVersion: keyTaskVersion(s), at: now.toISOString(), by: actor });
    if (!parsed.success) return `The segmentation run is not usable: ${parsed.error.issues[0]?.message ?? 'bad data'}`;
    const run = parsed.data;
    return {
      doc: { ...doc, subject: { ...doc.subject, run } },
      detail: `${run.engine} from frame ${run.seedFrame} (${run.seededBy === 'key' ? "seeded from the key's foreground" : 'operator seed'}), ${frames.length} frames ${run.first}–${run.last}, mean confidence ${mean.toFixed(2)}${run.fallback ? `; ${run.fallback}` : ''}`,
      task: 'edited',
      settings: true,
    };
  });
}

export function keyConfidence(m: KeyMetrics): number {
  let c = 1 - 2.5 * m.coreNoise - 40 * m.holes - 4 * Math.max(0, m.residual - 0.04) - 2 * Math.max(0, m.edgeActivity - 0.12);
  if (m.screenCoverage < 0.05) c *= 0.5 + 10 * m.screenCoverage;
  // With a subject prior the matte is only as sure as the segmentation (addendum 18), and less where they disagree.
  if (m.subjectConfidence !== undefined) c = c * (0.6 + 0.4 * m.subjectConfidence) - 3 * (m.subjectDisagree ?? 0);
  return Math.round(Math.max(0, Math.min(1, c)) * 1000) / 1000;
}

const median = (v: number[]) => {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/**
 * Why each frame is a problem ('' when it is not): low confidence, or a
 * measurement that jumps against the shot — screen coverage changing sharply
 * from its neighbours (a subject leaving, a light going), the edge suddenly
 * much busier, or the screen no longer matching its model.
 */
export function keyProblemReasons(records: readonly Pick<KeyFrameRecord, 'frame' | 'confidence' | 'metrics'>[]): Map<number, string> {
  const out = new Map<number, string>();
  const sorted = [...records].sort((a, b) => a.frame - b.frame);
  const edge = median(sorted.map((r) => r.metrics.edgeActivity));
  const residual = median(sorted.map((r) => r.metrics.residual));
  sorted.forEach((r, i) => {
    const reasons: string[] = [];
    if (r.confidence < KEY_LOW_CONFIDENCE) reasons.push(`confidence ${r.confidence.toFixed(2)}`);
    const near = sorted.slice(Math.max(0, i - 3), i).concat(sorted.slice(i + 1, i + 4));
    if (near.length) {
      const cov = median(near.map((n) => n.metrics.screenCoverage));
      if (Math.abs(r.metrics.screenCoverage - cov) > 0.12) reasons.push(`screen coverage ${(r.metrics.screenCoverage * 100).toFixed(0)} % against ${(cov * 100).toFixed(0)} % around it`);
    }
    if (sorted.length >= 3 && r.metrics.edgeActivity > Math.max(2.5 * edge, edge + 0.03)) reasons.push(`edge ${(r.metrics.edgeActivity / Math.max(edge, 1e-6)).toFixed(1)}× busier than the shot`);
    if (sorted.length >= 3 && r.metrics.residual > Math.max(3 * residual, residual + 0.05)) reasons.push('screen differs from its model (lighting change?)');
    if (r.metrics.holes > 0.002) reasons.push(`holes in the subject (${(r.metrics.holes * 100).toFixed(1)} %)`);
    if ((r.metrics.subjectDisagree ?? 0) > 0.03) reasons.push(`the subject segmentation covers clean screen (${((r.metrics.subjectDisagree ?? 0) * 100).toFixed(0)} % of its core)`);
    if (r.metrics.subjectConfidence !== undefined && r.metrics.subjectConfidence < 0.5) reasons.push(`subject segmentation unsure (${r.metrics.subjectConfidence.toFixed(2)})`);
    if (near.length && r.metrics.subjectOutside !== undefined) {
      const out = median(near.map((n) => n.metrics.subjectOutside ?? 0));
      if (r.metrics.subjectOutside > Math.max(2 * out, out + 0.15)) reasons.push(`the key and the segmentation disagree (solid outside the subject ${(r.metrics.subjectOutside * 100).toFixed(0)} % of its area)`);
    }
    out.set(r.frame, reasons.join('; '));
  });
  return out;
}

export interface KeyRunResult {
  first: number;
  last: number;
  frames: { frame: number; confidence: number; metrics: KeyMetrics }[];
  /** The settings revision the run keyed with. */
  revision: number;
  despill: boolean;
  algorithm?: string;
}

/**
 * Record what processing produced: per-frame confidence and measurements, and
 * the problem frames among them. Processing finishing puts the key (and the
 * despill, when it ran and the shot has that task) up for review — never
 * approves it. A run keyed with an older revision of the settings is refused.
 */
export function recordKeyRun(p: Project, shotId: string, result: KeyRunResult, actor: string, now: Date): Result {
  if (!result.frames.length) return { ok: false, reason: 'The key produced no frames' };
  if (result.frames.some((f) => !validFrame(f.frame) || !(f.confidence >= 0 && f.confidence <= 1))) return { ok: false, reason: 'The key result is not usable' };
  const at = now.toISOString();
  return editKey(p, shotId, actor, now, 'key.processed', (doc, s) => {
    if (result.revision !== doc.revision) return `Those frames were keyed with settings revision ${result.revision}; the settings are now revision ${doc.revision}. Process again.`;
    const byFrame = new Map(doc.frames.map((f) => [f.frame, f]));
    for (const f of result.frames) {
      const prev = byFrame.get(f.frame);
      byFrame.set(f.frame, { frame: f.frame, confidence: Math.round(f.confidence * 1000) / 1000, metrics: f.metrics, status: prev?.status === 'flagged' ? 'flagged' : 'processed', reason: '', reviewed: null, note: prev?.note ?? '' });
    }
    const reasons = keyProblemReasons([...byFrame.values()]);
    const frames = [...byFrame.values()].map((f) => ({ ...f, reason: reasons.get(f.frame) ?? '' })).sort((a, b) => a.frame - b.frame);
    const values = result.frames.map((f) => f.confidence);
    const mean = Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 1000) / 1000;
    const min = Math.round(Math.min(...values) * 1000) / 1000;
    const problems = frames.filter((f) => f.reason && f.frame >= result.first && f.frame <= result.last).map((f) => f.frame);
    const algorithm = result.algorithm ?? `${KEY_ALGORITHM.id}@${KEY_ALGORITHM.version}`;
    const run = { algorithm, revision: result.revision, first: result.first, last: result.last, frames: values.length, meanConfidence: mean, minConfidence: min, problems, taskVersion: keyTaskVersion(s), despill: result.despill, at, by: actor };
    const hasDespill = s.tasks.some((t) => t.kind === 'despill');
    return {
      doc: { ...doc, frames, runs: [...doc.runs, run].slice(-MAX_RUNS) },
      detail: `${values.length} frames ${result.first}–${result.last} with ${algorithm} (settings r${result.revision})${result.despill ? ', despilled' : ''}: confidence mean ${mean.toFixed(2)} min ${min.toFixed(2)}${problems.length ? `, ${problems.length} problem frame${problems.length === 1 ? '' : 's'}` : ''}`,
      task: 'review',
      despill: result.despill && hasDespill ? 'review' : null,
    };
  });
}

/** Flag a frame as needing correction, or clear the flag. */
export function flagKeyFrame(p: Project, shotId: string, frame: number, note: string, actor: string, now: Date): Result {
  return editKey(p, shotId, actor, now, 'key.flagged', (doc) => {
    const rec = doc.frames.find((f) => f.frame === frame);
    if (!rec) return `Frame ${frame} has not been keyed yet`;
    const cleared = rec.status === 'flagged';
    const frames = doc.frames.map((f) => (f.frame === frame ? { ...f, status: cleared ? ('processed' as const) : ('flagged' as const), note: cleared ? f.note : note.trim(), reviewed: null } : f));
    return { doc: { ...doc, frames }, detail: `frame ${frame} ${cleared ? 'flag cleared' : `flagged${note.trim() ? `: ${note.trim()}` : ''}`}` };
  });
}

/** Record that someone looked at a keyed frame and accepts it. */
export function markKeyFrameReviewed(p: Project, shotId: string, frame: number, actor: string, now: Date): Result {
  const at = now.toISOString();
  return editKey(p, shotId, actor, now, 'key.reviewed', (doc) => {
    if (!doc.frames.some((f) => f.frame === frame)) return `Frame ${frame} has not been keyed yet`;
    return { doc: { ...doc, frames: doc.frames.map((f) => (f.frame === frame ? { ...f, reviewed: { by: actor, at }, status: 'processed' as const } : f)) }, detail: `frame ${frame}` };
  });
}

export interface KeyReview {
  representatives: number[];
  /** Frames to look at, worst first: flagged, then problems not yet reviewed. */
  problems: { frame: number; confidence: number; reason: string }[];
  lowest: { frame: number; confidence: number }[];
}

export function keyReview(doc: KeyDocument | null | undefined, first: number, last: number): KeyReview {
  const representatives = contactSheetFrames(first, last, 10);
  if (!doc) return { representatives, problems: [], lowest: [] };
  const inRange = doc.frames.filter((f) => f.frame >= first && f.frame <= last);
  const problems = inRange
    .filter((f) => f.status === 'flagged' || (f.reason && !f.reviewed))
    .map((f) => ({ frame: f.frame, confidence: f.confidence, reason: f.status === 'flagged' ? `flagged${f.note ? `: ${f.note}` : ''}` : f.reason }))
    .sort((a, b) => Number(b.reason.startsWith('flagged')) - Number(a.reason.startsWith('flagged')) || a.confidence - b.confidence || a.frame - b.frame);
  const lowest = [...inRange].sort((a, b) => a.confidence - b.confidence || a.frame - b.frame).slice(0, 6).map((f) => ({ frame: f.frame, confidence: f.confidence }));
  return { representatives, problems, lowest };
}

export function nextKeyProblem(review: KeyReview, current: number): number | null {
  const frames = review.problems.map((x) => x.frame).sort((a, b) => a - b);
  if (!frames.length) return null;
  return frames.find((f) => f > current) ?? frames[0]!;
}

export interface KeyConfidenceSummary {
  frames: number;
  mean: number;
  min: number;
  low: number[];
  problems: number[];
  flagged: number[];
  reviewed: number;
}

export function keyConfidenceSummary(doc: KeyDocument | null | undefined): KeyConfidenceSummary {
  if (!doc || !doc.frames.length) return { frames: 0, mean: 0, min: 0, low: [], problems: [], flagged: [], reviewed: 0 };
  const values = doc.frames.map((f) => f.confidence);
  return {
    frames: doc.frames.length,
    mean: Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 1000) / 1000,
    min: Math.min(...values),
    low: doc.frames.filter((f) => f.confidence < KEY_LOW_CONFIDENCE).map((f) => f.frame),
    problems: doc.frames.filter((f) => f.reason && !f.reviewed).map((f) => f.frame),
    flagged: doc.frames.filter((f) => f.status === 'flagged').map((f) => f.frame),
    reviewed: doc.frames.filter((f) => f.reviewed).length,
  };
}

// ---------------------------------------------------------------------------
// Hybrid key + roto (§6 bullet 3)
// ---------------------------------------------------------------------------

/** The roto part a "Repair with roto" would create, so the seed matte can be written under its id first. */
export function keyRepairPart(p: Project, shotId: string, name?: string): { partId: string; name: string } {
  const s = shotState(p, shotId);
  const doc = s?.roto ?? newRotoDocument();
  const existing = s?.key?.links.filter((l) => l.kind === 'repair').length ?? 0;
  let label = name?.trim() || `Key repair ${existing + 1}`;
  for (let n = existing + 2; doc.parts.some((x) => x.name.toLowerCase() === label.toLowerCase()); n += 1) label = `Key repair ${n}`;
  return { partId: partIdFor(doc, label), name: label };
}

/**
 * "Repair with roto": make a roto part whose matte on `frame` is the current
 * key (already written to the roto cache under `partId` by the caller), accept
 * it as that part's key frame so painting there corrects it rather than
 * starting again, and link it to the key as a repair region (replace). Adds
 * the Paint-to-roto task when the shot has none. The operator then paints the
 * corrections with the roto tools and propagates them over the problem frames.
 */
export function startKeyRepair(
  p: Project,
  shotId: string,
  input: { partId: string; name: string; frame: number; confidence: number; mode?: KeyLink['mode']; region?: KeyLink['region'] },
  actor: string,
  now: Date,
): Result {
  const s = shotState(p, shotId);
  if (!s) return { ok: false, reason: `No shot ${shotId}` };
  const locked = keyLocked(s);
  if (locked) return { ok: false, reason: locked };
  let project = p;
  if (!s.tasks.some((t) => t.kind === 'roto')) {
    const r = addTask(project, shotId, 'roto', actor, now);
    if (!r.ok) return r;
    project = r.project;
  }
  const expected = keyRepairPart(project, shotId, input.name);
  if (expected.partId !== input.partId) return { ok: false, reason: `The roto part would be ${expected.partId}, not ${input.partId}; try again` };
  const steps: ((q: Project) => Result)[] = [
    (q) => addPart(q, shotId, { name: expected.name }, actor, now),
    (q) =>
      recordPropagation(
        q,
        shotId,
        { partId: input.partId, engine: { id: 'track', version: `key-seed ${KEY_ALGORITHM.version}` }, direction: 'key', from: input.frame, frames: [{ frame: input.frame, confidence: Math.max(0.3, Math.min(1, input.confidence)) }] },
        actor,
        now,
      ),
    (q) => setKeyFrame(q, shotId, input.partId, input.frame, actor, now),
    (q) => addKeyLink(q, shotId, { kind: 'repair', source: { type: 'roto', partId: input.partId }, mode: input.mode ?? 'replace', region: input.region ?? null, label: expected.name }, actor, now),
  ];
  for (const step of steps) {
    const r = step(project);
    if (!r.ok) return r;
    project = r.project;
  }
  return { ok: true, project: logged(project, { at: now.toISOString(), actor, shotId, action: 'key.repair_started', detail: `${expected.name} (${input.partId}) seeded from the key on frame ${input.frame}; paint corrections in Roto` }) };
}

// ---------------------------------------------------------------------------
// Export (§6 review, §7 prep-only output, §17)
// ---------------------------------------------------------------------------

/** Record a written export and submit the key for review (never approval). */
export function recordKeyExport(p: Project, shotId: string, record: KeyExportInput, actor: string, now: Date): Result {
  const at = now.toISOString();
  const parsed = KeyExportSchema.safeParse({ ...record, writtenAt: at, by: actor });
  if (!parsed.success) return { ok: false, reason: `The export record is not usable: ${parsed.error.issues[0]?.message ?? 'bad data'}` };
  const rec = parsed.data;
  return editKey(p, shotId, actor, now, 'key.exported', (doc, s) => {
    if (rec.version !== keyTaskVersion(s)) return `That key is ${versionTag(rec.version)}; the key task is ${versionTag(keyTaskVersion(s))}`;
    const hasDespill = s.tasks.some((t) => t.kind === 'despill');
    return {
      doc: { ...doc, exports: [...doc.exports.filter((e) => e.version !== rec.version), rec].sort((a, b) => a.version - b.version) },
      detail: `${versionTag(rec.version)}: ${rec.folder}, ${rec.frames} frames ${rec.first}–${rec.last} at ${rec.width}×${rec.height}; alpha ${rec.alpha}${rec.foreground ? `, foreground ${rec.foreground} (${rec.encoding}${rec.despill ? ', despilled' : ''})` : ''}${rec.lightWrap ? ', light wrap layer' : ''}; ${rec.files} files; settings r${rec.revision}`,
      task: 'review',
      despill: rec.despill && hasDespill ? 'review' : null,
    };
  });
}

export const keyNames = {
  /** `010_020_key_v001` inside 03_KEYS. */
  folder: (shot: string, version: number) => `${shot}_key_${versionTag(version)}`,
  alphaFile: (shot: string, version: number, frame: number) => frameFileName(shot, 'key_alpha', version, frame, 'png'),
  alphaPattern: (shot: string, version: number) => framePattern(shot, 'key_alpha', version, 'png'),
  alphaExrPattern: (shot: string, version: number) => framePattern(shot, 'key_alpha', version, 'exr'),
  foregroundFile: (shot: string, version: number, frame: number) => frameFileName(shot, 'key_fg', version, frame, 'exr'),
  foregroundPattern: (shot: string, version: number) => framePattern(shot, 'key_fg', version, 'exr'),
  coreFile: (shot: string, version: number, frame: number) => frameFileName(shot, 'key_core', version, frame, 'png'),
  corePattern: (shot: string, version: number) => framePattern(shot, 'key_core', version, 'png'),
  edgeFile: (shot: string, version: number, frame: number) => frameFileName(shot, 'key_edge', version, frame, 'png'),
  edgePattern: (shot: string, version: number) => framePattern(shot, 'key_edge', version, 'png'),
  lightWrapFile: (shot: string, version: number, frame: number) => frameFileName(shot, 'key_lightwrap', version, frame, 'exr'),
  lightWrapPattern: (shot: string, version: number) => framePattern(shot, 'key_lightwrap', version, 'exr'),
  shadowFile: (shot: string, version: number, frame: number) => frameFileName(shot, 'key_shadow', version, frame, 'png'),
  shadowPattern: (shot: string, version: number) => framePattern(shot, 'key_shadow', version, 'png'),
  mattesExrFile: (shot: string, version: number, frame: number) => frameFileName(shot, 'key_mattes', version, frame, 'exr'),
  mattesExrPattern: (shot: string, version: number) => framePattern(shot, 'key_mattes', version, 'exr'),
  metadata: (shot: string, version: number) => `${shot}_key_${versionTag(version)}.json`,
  readme: () => 'README.txt',
};

/** Everything that decides the pixels of a key, for the metadata and for reproducing it (§19). */
export function keySettings(doc: KeyDocument) {
  return {
    algorithm: doc.algorithm,
    revision: doc.revision,
    screen: doc.screen,
    params: doc.params,
    links: doc.links,
    subject: doc.subject.source === 'none' ? { source: 'none' as const } : { source: doc.subject.source, partId: doc.subject.partId, engine: doc.subject.engine, seed: doc.subject.seed, marginPx: doc.subject.marginPx, outside: doc.subject.outside, run: doc.subject.run ? { engine: doc.subject.run.engine, seedFrame: doc.subject.run.seedFrame, seededBy: doc.subject.run.seededBy, revision: doc.subject.run.revision, at: doc.subject.run.at } : null },
    despill: doc.despill,
    lightWrap: { output: doc.lightWrap.output, widthPx: doc.lightWrap.widthPx, intensity: doc.lightWrap.intensity, lumaWeight: doc.lightWrap.lumaWeight },
  };
}

/** The metadata written beside the key (`<shot>_key_vNNN.json`). */
export function keyMetadata(
  p: Project,
  shotId: string,
  info: { version: number; first: number; last: number; width: number; height: number; encoding: string; linear: boolean; source: string; files: Record<string, string | null>; alphaExr: boolean; generator: string; writtenAt: string; by: string; background: string | null },
) {
  const shot = handoffShot(p, shotId);
  const s = shotState(p, shotId);
  if (!shot || !s || !s.key) throw new Error(`No key for ${shotId}`);
  const doc = s.key;
  return {
    format: 'vcvfx.key/1',
    generator: info.generator,
    shot: shotName(s),
    handoffShotId: shot.shotId,
    version: versionTag(info.version),
    writtenAt: info.writtenAt,
    by: info.by,
    frames: { first: info.first, last: info.last, count: info.last - info.first + 1 },
    resolution: { width: info.width, height: info.height },
    source: info.source,
    colour: {
      encoding: info.encoding,
      linear: info.linear,
      note: info.linear ? 'Foreground and light wrap are scene-linear in this encoding; no display transform or look is applied.' : 'The source encoding is unknown: keyed on its code values, which are written as they are (not linear).',
    },
    files: info.files,
    alpha: { bitDepth: 16, meaning: 'PNG greyscale; 0 = background, full = foreground; straight', exr: info.alphaExr },
    foreground: info.files['foreground'] ? 'RGBA half-float EXR, premultiplied by the alpha: the screen subtracted (P − (1 − α)·screen) and despilled. Prep output only — no composite.' : null,
    lightWrap: info.files['lightWrap'] ? 'RGB half-float EXR, an additive layer (add it over a composite); not in the foreground.' : null,
    shadow: info.files['shadow'] ? 'Shadow pass: 16-bit PNG greyscale, shadow density 0…1 (1 − luminance ratio of the shadowed screen to the clean screen). Multiply the new background by (1 − density), or a tinted version of it; not in the alpha.' : null,
    mattesExr: info.files['mattesExr'] ? 'Half-float EXR with the alpha (channel A) and the shadow density (layer shadow, channel shadow.A).' : null,
    settings: keySettings(doc),
    background: info.background,
    /** A suggestion for the compositor; never applied to these files (§7). */
    suggestedMatch: doc.match.suggestion,
    confidence: keyConfidenceSummary(doc),
    perFrame: doc.frames.map((f) => ({ frame: f.frame, confidence: f.confidence, metrics: f.metrics, status: f.status, problem: f.reason || null, reviewed: f.reviewed })),
    runs: doc.runs.filter((r) => r.taskVersion === info.version),
    approval: s.tasks.find((t) => t.kind === 'key')?.approval ?? null,
  };
}
export type KeyMetadata = ReturnType<typeof keyMetadata>;

/** The key section of the package manifest (§18). Null when the shot has no key document. */
export function keyManifest(s: ShotState) {
  const doc = s.key;
  if (!doc) return null;
  const task = s.tasks.find((t) => t.kind === 'key');
  const despill = s.tasks.find((t) => t.kind === 'despill');
  const version = task?.version ?? 1;
  const exported = doc.exports.find((e) => e.version === version) ?? null;
  const summary = keyConfidenceSummary(doc);
  return {
    version: versionTag(version),
    state: task?.state ?? null,
    approval: task?.approval ?? null,
    despill: despill ? { state: despill.state, version: versionTag(despill.version), approval: despill.approval } : null,
    exported: exported !== null,
    folder: exported?.folder ?? null,
    alpha: exported?.alpha ?? null,
    foreground: exported?.foreground ?? null,
    lightWrap: exported?.lightWrap ?? null,
    shadow: exported?.shadow ?? null,
    subject: doc.subject.source === 'none' ? null : { source: doc.subject.source, partId: doc.subject.partId, engine: doc.subject.run?.engine ?? doc.subject.engine, meanConfidence: doc.subject.run?.meanConfidence ?? null },
    metadata: exported?.metadata ?? null,
    frames: exported ? { first: exported.first, last: exported.last, count: exported.frames } : null,
    resolution: exported ? { width: exported.width, height: exported.height } : null,
    encoding: exported?.encoding ?? null,
    algorithm: `${doc.algorithm.id}@${doc.algorithm.version}`,
    revision: exported?.revision ?? doc.revision,
    screen: doc.screen ? { kind: doc.screen.kind, source: doc.screen.source, rgb: doc.screen.rgb } : null,
    links: doc.links.map((l) => ({ id: l.id, kind: l.kind, source: l.source, mode: l.mode, invert: l.invert, enabled: l.enabled })),
    suggestedMatch: doc.match.suggestion,
    confidence: { frames: summary.frames, mean: summary.mean, min: summary.min, low: summary.low, problems: summary.problems, flagged: summary.flagged, reviewed: summary.reviewed },
  };
}
