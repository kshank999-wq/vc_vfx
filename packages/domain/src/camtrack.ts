import { handoffShot, shotState, type LogEntry, type Project, type Result, type ShotState } from './project.js';
import { versionTag } from './frames.js';
import { CameraBodySchema, LensProfileSchema, findLensProfile, matchCamera, type CameraBodyInput, type LensProfile } from './camera-db.js';
import {
  CAMTRACK_FORMAT_VERSION,
  CamExportSchema,
  CamTrackDocumentSchema,
  Track2dDocumentSchema,
  Track2dExportSchema,
  type CamExportInput,
  type CamTrackDocument,
  type Track2d,
  type Track2dDocument,
  type Track2dExportInput,
  type Track2dFrame,
  type Track2dKind,
} from './camtrack-schema.js';

export * from './camtrack-schema.js';
export * from './camera-db.js';

/**
 * Camera tracking and 2D/planar tracking as a model (master spec §9, §10,
 * §15, §19; addendum 06).
 *
 *  - Camera tracking is the shot's `camera_track` task, 2D tracking its
 *    `track_2d` task. Work moves the task to processing, a finished solve or
 *    track or an export puts it up for review; nothing here approves it —
 *    that is `approveTask`, a named person's act, which for tracks made here
 *    also needs the current version exported.
 *  - Approved work is never edited in place: changes are refused until the
 *    task is reopened, which bumps its version, so the next export writes
 *    `v002` beside the approved `v001`.
 *  - Every change is logged with who and when (`camtrack.*`, `track2d.*`).
 *  - The large data (feature tracks, solved cameras, point clouds) are files;
 *    the project holds references and summaries.
 */

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

const nameOf = (s: ShotState) => s.vfxShotId ?? s.shotId;

/** Why camera tracking on this shot cannot be changed right now, or null. */
export function camtrackLocked(s: ShotState): string | null {
  if (s.stage !== 'prep') return `${nameOf(s)} is ${s.stage}; reopen it before changing its camera track`;
  const task = s.tasks.find((t) => t.kind === 'camera_track');
  if (!task) return `${nameOf(s)} has no Camera track task. Add it first.`;
  if (task.state === 'approved') return `Camera track ${versionTag(task.version)} is approved. Reopen it (Needs correction) to make ${versionTag(task.version + 1)}; the approved solve is kept.`;
  return null;
}

export function track2dLocked(s: ShotState): string | null {
  if (s.stage !== 'prep') return `${nameOf(s)} is ${s.stage}; reopen it before changing its 2D tracks`;
  const task = s.tasks.find((t) => t.kind === 'track_2d');
  if (!task) return `${nameOf(s)} has no 2D / planar track task. Add it first.`;
  if (task.state === 'approved') return `2D tracks ${versionTag(task.version)} are approved. Reopen them (Needs correction) to make ${versionTag(task.version + 1)}.`;
  return null;
}

export const camtrackTaskVersion = (s: ShotState): number => s.tasks.find((t) => t.kind === 'camera_track')?.version ?? 1;
export const track2dTaskVersion = (s: ShotState): number => s.tasks.find((t) => t.kind === 'track_2d')?.version ?? 1;

/**
 * A fresh camera-track document for a shot: the camera matched from the
 * handoff's body / sensor-mode text against the database (the handoff's own
 * film back wins when it gives one), the lens from its focal length, and a
 * project lens profile when one matches.
 */
export function newCamTrackDocument(p: Project, shotId: string): CamTrackDocument {
  const shot = handoffShot(p, shotId);
  const cam = shot?.camera ?? {};
  const resolution = shot?.resolution ?? shotState(p, shotId)?.probe?.resolution;
  const match = matchCamera({ body: cam.body, sensorMode: cam.sensorMode, filmBackMm: cam.filmBackMm, resolution }, p.customCameras);
  let camera: CamTrackDocument['camera'] = null;
  const handoffText = [cam.body, cam.sensorMode].filter(Boolean).join(' · ') || null;
  if (cam.filmBackMm) {
    const sameMode = match && Math.abs(match.mode.filmBackMm.width - cam.filmBackMm.width) < 0.1 ? match.mode : null;
    camera = {
      source: 'handoff',
      cameraId: match?.confident ? match.camera.id : null,
      modeId: match?.confident && sameMode ? sameMode.id : null,
      label: handoffText || 'From the handoff',
      filmBackMm: cam.filmBackMm,
      sensorPx: null,
      verified: false,
      note: 'Film back from the handoff',
      handoffText,
    };
  } else if (match?.confident) {
    camera = {
      source: 'handoff',
      cameraId: match.camera.id,
      modeId: match.mode.id,
      label: `${match.camera.make} ${match.camera.model} · ${match.mode.name}`,
      filmBackMm: match.mode.filmBackMm,
      sensorPx: match.mode.px,
      verified: match.mode.verified,
      note: match.why,
      handoffText,
    };
  }
  const profile = findLensProfile(p.lensProfiles, { cameraId: camera?.cameraId ?? null, lens: cam.lens, focalMm: cam.focalLengthMm ?? null });
  const doc = CamTrackDocumentSchema.parse({ formatVersion: CAMTRACK_FORMAT_VERSION });
  // A fixed-lens camera (drone, phone) gives the focal when the slate does not.
  const fixed = match?.confident && camera?.cameraId === match.camera.id ? match.camera.fixedFocalMm : null;
  const focalMm = cam.focalLengthMm ?? fixed ?? null;
  const modeSqueeze = match?.confident && camera?.modeId === match.mode.id ? match.mode.anamorphicSqueeze : 1;
  return {
    ...doc,
    camera,
    lens: {
      ...doc.lens,
      name: cam.lens ?? (fixed ? `${match!.camera.make} ${match!.camera.model} (fixed lens)` : ''),
      focalMm,
      // A focal length from the slate is a good start, not gospel (zoom marks, focus breathing); a fixed lens's is derived.
      focalMode: focalMm && camera ? 'approx' : 'unknown',
      profileId: profile?.id ?? null,
      distortion: profile ? { ...profile.distortion } : doc.lens.distortion,
      squeeze: profile?.squeeze ?? modeSqueeze,
    },
  };
}

export type TaskMove = 'work' | 'review' | null;

export interface CamTrackChange {
  /** The command's verb, e.g. "solve", "set_lens". */
  command: string;
  /** One line for the log. */
  summary: string;
  /** The document after the command. */
  doc: CamTrackDocument;
  task?: TaskMove;
}

/**
 * Record a camera-track command's outcome: validates the new document,
 * replaces the shot's, logs `camtrack.<command>` and moves the task. Every
 * command the UI or an assistant runs ends here. Refused while locked.
 */
export function applyCamTrack(p: Project, shotId: string, change: CamTrackChange, actor: string, now: Date): Result {
  const at = now.toISOString();
  const parsed = CamTrackDocumentSchema.safeParse(change.doc);
  if (!parsed.success) return { ok: false, reason: `The camera track is not valid: ${parsed.error.issues[0]?.path.join('.')} ${parsed.error.issues[0]?.message ?? ''}`.trim() };
  if (!/^[a-z0-9_]{1,40}$/.test(change.command)) return { ok: false, reason: `Not a command name: ${change.command}` };
  let started = false;
  let taskMove: string | null = null;
  const r = withShot(p, shotId, (s) => {
    const locked = camtrackLocked(s);
    if (locked) return locked;
    started = s.camtrack === null;
    let tasks = s.tasks;
    if (change.task) {
      tasks = s.tasks.map((t) => {
        if (t.kind !== 'camera_track') return t;
        const next = change.task === 'review' ? 'needs_review' : t.state === 'pending' ? 'processing' : t.state === 'needs_review' ? 'needs_correction' : t.state;
        if (next !== t.state) taskMove = `camera_track → ${next}`;
        return next === t.state ? t : { ...t, state: next };
      });
    }
    return { ...s, tasks, camtrack: parsed.data };
  });
  if (!r.ok) return r;
  let out = r.project;
  if (started) out = logged(out, { at, actor, shotId, action: 'camtrack.started', detail: parsed.data.camera ? `Camera ${parsed.data.camera.label}` : 'No camera matched; set the film back' });
  out = logged(out, { at, actor, shotId, action: `camtrack.${change.command}`, detail: change.summary });
  if (taskMove) out = logged(out, { at, actor, shotId, action: 'task.state', detail: taskMove });
  return { ok: true, project: out };
}

/** Next id for a file or record in the document. */
export function camNextId(doc: CamTrackDocument, prefix: string): { doc: CamTrackDocument; id: string } {
  const seq = doc.seq + 1;
  return { doc: { ...doc, seq }, id: `${prefix}-${String(seq).padStart(4, '0')}` };
}

/** Record an export of the current version (also puts the task up for review). */
export function recordCamExport(p: Project, shotId: string, record: CamExportInput, actor: string, now: Date): Result {
  const at = now.toISOString();
  const parsed = CamExportSchema.safeParse({ ...record, writtenAt: at, by: actor });
  if (!parsed.success) return { ok: false, reason: `The export record is not usable: ${parsed.error.issues[0]?.message ?? 'bad data'}` };
  const s = shotState(p, shotId);
  if (!s?.camtrack) return { ok: false, reason: 'There is no camera track to export' };
  if (parsed.data.version !== camtrackTaskVersion(s)) return { ok: false, reason: `That export is ${versionTag(parsed.data.version)}; the camera track task is ${versionTag(camtrackTaskVersion(s))}` };
  const doc: CamTrackDocument = { ...s.camtrack, exports: [...s.camtrack.exports.filter((e) => e.version !== parsed.data.version), parsed.data].sort((a, b) => a.version - b.version) };
  return applyCamTrack(p, shotId, { command: 'export', summary: `${versionTag(parsed.data.version)} of solve ${parsed.data.solve}: ${parsed.data.formats.join(', ')}${parsed.data.stmaps ? ' + STMaps' : ''} → ${parsed.data.folder} (${parsed.data.files.length} files)`, doc, task: 'review' }, actor, now);
}

export function activeSolve(doc: CamTrackDocument | null | undefined) {
  if (!doc || doc.activeSolve === null) return null;
  return doc.solves.find((s) => s.number === doc.activeSolve) ?? null;
}

export const camtrackNames = {
  /** `010_020_camtrack_v001` */
  folder: (shot: string, version: number) => `${shot}_camtrack_${versionTag(version)}`,
  file: (shot: string, version: number, ext: string) => `${shot}_camtrack_${versionTag(version)}${ext}`,
};

export const track2dNames = {
  folder: (shot: string, version: number) => `${shot}_track2d_${versionTag(version)}`,
  file: (shot: string, version: number, track: string, ext: string) => `${shot}_track2d_${track}_${versionTag(version)}${ext}`,
};

/** The camera-track section of the manifest (§18). */
export function camtrackManifest(s: ShotState) {
  const doc = s.camtrack;
  if (!doc) return null;
  const task = s.tasks.find((t) => t.kind === 'camera_track');
  const version = task?.version ?? 1;
  const exported = doc.exports.find((e) => e.version === version) ?? null;
  const solve = exported ? doc.solves.find((x) => x.number === exported.solve) ?? null : activeSolve(doc);
  return {
    version: versionTag(version),
    state: task?.state ?? null,
    approval: task?.approval ?? null,
    exported: exported !== null,
    folder: exported?.folder ?? null,
    files: exported?.files ?? [],
    formats: exported?.formats ?? [],
    camera: doc.camera,
    lens: { name: doc.lens.name, focalMm: doc.lens.focalMm, focalMode: doc.lens.focalMode, distortion: doc.lens.distortion, squeeze: doc.lens.squeeze, profileId: doc.lens.profileId },
    solve: solve
      ? { number: solve.number, engine: solve.engine, intrinsics: solve.intrinsics, rmsPx: solve.stats.rms, framesSolved: solve.stats.framesSolved, framesTotal: solve.stats.framesTotal, tracks: solve.stats.tracksUsed, nodal: solve.stats.nodal, confidence: solve.stats.confidence, warnings: solve.stats.warnings, constraint: solve.constraint }
      : null,
    lidar: doc.lidar.map((l) => ({ name: l.name, path: l.path, format: l.format, units: l.units, points: l.points })),
    alignment: doc.alignment,
    correspondences: doc.correspondences.length,
    coords: { units: doc.coords.units, upAxis: doc.coords.upAxis },
  };
}

// ---------------------------------------------------------------------------
// Lens profiles and custom cameras (project level)
// ---------------------------------------------------------------------------

export function saveLensProfile(p: Project, profile: Omit<LensProfile, 'at' | 'by'>, actor: string, now: Date): Result {
  const at = now.toISOString();
  const parsed = LensProfileSchema.safeParse({ ...profile, at, by: actor });
  if (!parsed.success) return { ok: false, reason: `The lens profile is not usable: ${parsed.error.issues[0]?.message ?? 'bad data'}` };
  const rec = parsed.data;
  const replaced = p.lensProfiles.some((x) => x.id === rec.id);
  const d = rec.distortion;
  return {
    ok: true,
    project: logged(
      { ...p, lensProfiles: [...p.lensProfiles.filter((x) => x.id !== rec.id), rec].sort((a, b) => a.id.localeCompare(b.id)) },
      { at, actor, shotId: null, action: replaced ? 'lens.profile_updated' : 'lens.profile_added', detail: `${rec.id}: ${rec.camera}${rec.lens ? `, ${rec.lens}` : ''} ${rec.focalMm} mm — k1 ${d.k1.toFixed(5)} k2 ${d.k2.toFixed(5)} p1 ${d.p1.toFixed(5)} p2 ${d.p2.toFixed(5)}${rec.rms !== null ? `, RMS ${rec.rms.toFixed(3)} px` : ''} (${rec.source})` },
    ),
  };
}

export function removeLensProfile(p: Project, id: string, actor: string, now: Date): Result {
  if (!p.lensProfiles.some((x) => x.id === id)) return { ok: false, reason: `No lens profile ${id}` };
  return { ok: true, project: logged({ ...p, lensProfiles: p.lensProfiles.filter((x) => x.id !== id) }, { at: now.toISOString(), actor, shotId: null, action: 'lens.profile_removed', detail: id }) };
}

export function lensProfileId(p: Project, camera: string, lens: string, focalMm: number): string {
  const base = `${camera}-${lens}-${focalMm}mm`.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 56) || 'lens';
  let id = base;
  for (let n = 2; p.lensProfiles.some((x) => x.id === id); n += 1) id = `${base}-${n}`;
  return id;
}

export function addCustomCamera(p: Project, camera: Omit<CameraBodyInput, 'custom'>, actor: string, now: Date): Result {
  const parsed = CameraBodySchema.safeParse({ ...camera, custom: true });
  if (!parsed.success) return { ok: false, reason: `The camera is not usable: ${parsed.error.issues[0]?.message ?? 'bad data'}` };
  const c = parsed.data;
  return {
    ok: true,
    project: logged(
      { ...p, customCameras: [...p.customCameras.filter((x) => x.id !== c.id), c] },
      { at: now.toISOString(), actor, shotId: null, action: 'camera.custom_added', detail: `${c.make} ${c.model}: ${c.modes.map((mo) => `${mo.name} ${mo.filmBackMm.width}×${mo.filmBackMm.height} mm`).join('; ')}` },
    ),
  };
}

// ---------------------------------------------------------------------------
// 2D / planar tracks (§9)
// ---------------------------------------------------------------------------

export const TRACK2D_PALETTE = ['#ffb02e', '#4aa3ff', '#3ad07a', '#e85dff', '#ff5f56', '#2ee6d6'] as const;

function editTrack2d(
  p: Project,
  shotId: string,
  actor: string,
  now: Date,
  action: string,
  fn: (doc: Track2dDocument, s: ShotState) => { doc: Track2dDocument; detail: string; task?: TaskMove } | string,
): Result {
  const at = now.toISOString();
  let detail = '';
  let taskMove: string | null = null;
  const r = withShot(p, shotId, (s) => {
    const locked = track2dLocked(s);
    if (locked) return locked;
    const out = fn(s.track2d ?? Track2dDocumentSchema.parse({}), s);
    if (typeof out === 'string') return out;
    const parsed = Track2dDocumentSchema.safeParse(out.doc);
    if (!parsed.success) return `The 2D track is not valid: ${parsed.error.issues[0]?.message ?? ''}`;
    detail = out.detail;
    let tasks = s.tasks;
    if (out.task) {
      tasks = s.tasks.map((t) => {
        if (t.kind !== 'track_2d') return t;
        const next = out.task === 'review' ? 'needs_review' : t.state === 'pending' ? 'processing' : t.state === 'needs_review' ? 'needs_correction' : t.state;
        if (next !== t.state) taskMove = `track_2d → ${next}`;
        return next === t.state ? t : { ...t, state: next };
      });
    }
    return { ...s, tasks, track2d: parsed.data };
  });
  if (!r.ok) return r;
  let out = logged(r.project, { at, actor, shotId, action, detail });
  if (taskMove) out = logged(out, { at, actor, shotId, action: 'task.state', detail: taskMove });
  return { ok: true, project: out };
}

const roundPt = (pt: readonly [number, number]): [number, number] => [Math.round(pt[0] * 1000) / 1000, Math.round(pt[1] * 1000) / 1000];

export function track2dId(doc: Track2dDocument, name: string): string {
  const base = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'track';
  const stem = /^[a-z0-9]/.test(base) ? base : `t${base}`;
  let id = stem;
  for (let n = 2; doc.tracks.some((t) => t.id === id); n += 1) id = `${stem}_${n}`;
  return id;
}

export function createTrack2d(p: Project, shotId: string, input: { name: string; kind: Track2dKind; frame: number; points: [number, number][] }, actor: string, now: Date): Result {
  const name = input.name.trim();
  if (!name) return { ok: false, reason: 'A track needs a name' };
  if (input.kind === 'planar' && input.points.length !== 4) return { ok: false, reason: 'A planar track needs four corners' };
  if (input.kind === 'point' && input.points.length !== 1) return { ok: false, reason: 'A point track needs one point' };
  const at = now.toISOString();
  return editTrack2d(p, shotId, actor, now, 'track2d.created', (doc) => {
    if (doc.tracks.some((t) => t.name.toLowerCase() === name.toLowerCase())) return `There is already a track called ${name}`;
    const id = track2dId(doc, name);
    const pts = input.points.map(roundPt);
    const track: Track2d = {
      id,
      name,
      kind: input.kind,
      color: TRACK2D_PALETTE[doc.tracks.length % TRACK2D_PALETTE.length]!,
      keys: [{ frame: input.frame, points: pts, by: actor, at }],
      frames: [{ frame: input.frame, points: pts, confidence: 1, status: 'key' }],
      occluders: [],
      pattern: 12,
      search: 48,
      engine: '',
    };
    return { doc: { ...doc, tracks: [...doc.tracks, track] }, detail: `${name} (${input.kind}) on ${input.frame}: ${pts.map((q) => `(${q[0]}, ${q[1]})`).join(' ')}`, task: 'work' };
  });
}

/** Set (or correct) a key frame's points: it becomes a key and its frame record is replaced. */
export function setTrack2dKey(p: Project, shotId: string, trackId: string, frame: number, points: [number, number][], actor: string, now: Date): Result {
  const at = now.toISOString();
  return editTrack2d(p, shotId, actor, now, 'track2d.key', (doc) => {
    const t = doc.tracks.find((x) => x.id === trackId);
    if (!t) return `No 2D track ${trackId}`;
    if (points.length !== (t.kind === 'planar' ? 4 : 1)) return t.kind === 'planar' ? 'A planar key has four corners' : 'A point key has one point';
    const pts = points.map(roundPt);
    const correction = t.frames.some((f) => f.frame === frame && f.status === 'tracked');
    const next: Track2d = {
      ...t,
      keys: [...t.keys.filter((k) => k.frame !== frame), { frame, points: pts, by: actor, at }].sort((a, b) => a.frame - b.frame),
      frames: [...t.frames.filter((f) => f.frame !== frame), { frame, points: pts, confidence: 1, status: 'key' as const }].sort((a, b) => a.frame - b.frame),
    };
    return { doc: { ...doc, tracks: doc.tracks.map((x) => (x.id === trackId ? next : x)) }, detail: `${t.name} ${correction ? 'corrected' : 'key'} on ${frame}`, task: 'work' };
  });
}

export function removeTrack2dKey(p: Project, shotId: string, trackId: string, frame: number, actor: string, now: Date): Result {
  return editTrack2d(p, shotId, actor, now, 'track2d.key_removed', (doc) => {
    const t = doc.tracks.find((x) => x.id === trackId);
    if (!t) return `No 2D track ${trackId}`;
    if (t.keys.length <= 1) return 'A track keeps at least one key frame';
    if (!t.keys.some((k) => k.frame === frame)) return `${frame} is not a key frame of ${t.name}`;
    const next = { ...t, keys: t.keys.filter((k) => k.frame !== frame), frames: t.frames.filter((f) => f.frame !== frame) };
    return { doc: { ...doc, tracks: doc.tracks.map((x) => (x.id === trackId ? next : x)) }, detail: `${t.name}: key ${frame} removed` };
  });
}

/** Record tracked frames (keys are never overwritten by tracking). */
export function recordTrack2dRun(p: Project, shotId: string, trackId: string, run: { frames: Track2dFrame[]; engine: string; from: number; direction: string }, actor: string, now: Date): Result {
  return editTrack2d(p, shotId, actor, now, 'track2d.tracked', (doc) => {
    const t = doc.tracks.find((x) => x.id === trackId);
    if (!t) return `No 2D track ${trackId}`;
    const keys = new Set(t.keys.map((k) => k.frame));
    const incoming = run.frames.filter((f) => !keys.has(f.frame)).map((f) => ({ ...f, points: f.points.map(roundPt), confidence: Math.round(f.confidence * 1000) / 1000 }));
    const replace = new Set(incoming.map((f) => f.frame));
    const frames = [...t.frames.filter((f) => !replace.has(f.frame)), ...incoming].sort((a, b) => a.frame - b.frame);
    const conf = incoming.map((f) => f.confidence);
    const lost = incoming.filter((f) => f.status === 'lost').length;
    const mean = conf.length ? conf.reduce((a, b) => a + b, 0) / conf.length : 0;
    return {
      doc: { ...doc, tracks: doc.tracks.map((x) => (x.id === trackId ? { ...t, frames, engine: run.engine } : x)) },
      detail: `${t.name} ${run.direction} from ${run.from}: ${incoming.length} frames, confidence mean ${mean.toFixed(2)} min ${conf.length ? Math.min(...conf).toFixed(2) : '—'}${lost ? `, ${lost} lost` : ''} (${run.engine})`,
      task: 'review',
    };
  });
}

export function updateTrack2d(p: Project, shotId: string, trackId: string, change: { name?: string; occluders?: string[]; pattern?: number; search?: number; color?: string }, actor: string, now: Date): Result {
  return editTrack2d(p, shotId, actor, now, 'track2d.settings', (doc) => {
    const t = doc.tracks.find((x) => x.id === trackId);
    if (!t) return `No 2D track ${trackId}`;
    const name = change.name?.trim();
    if (name !== undefined && !name) return 'A track needs a name';
    if (name && doc.tracks.some((x) => x.id !== trackId && x.name.toLowerCase() === name.toLowerCase())) return `There is already a track called ${name}`;
    const next = { ...t, ...(name ? { name } : {}), ...(change.occluders ? { occluders: change.occluders } : {}), ...(change.pattern ? { pattern: change.pattern } : {}), ...(change.search ? { search: change.search } : {}), ...(change.color ? { color: change.color } : {}) };
    return { doc: { ...doc, tracks: doc.tracks.map((x) => (x.id === trackId ? next : x)) }, detail: `${t.name}: ${Object.keys(change).join(', ')}` };
  });
}

export function removeTrack2d(p: Project, shotId: string, trackId: string, actor: string, now: Date): Result {
  return editTrack2d(p, shotId, actor, now, 'track2d.removed', (doc) => {
    const t = doc.tracks.find((x) => x.id === trackId);
    if (!t) return `No 2D track ${trackId}`;
    return { doc: { ...doc, tracks: doc.tracks.filter((x) => x.id !== trackId) }, detail: `${t.name} (${t.frames.length} frames)` };
  });
}

export function recordTrack2dExport(p: Project, shotId: string, record: Track2dExportInput, actor: string, now: Date): Result {
  const parsed = Track2dExportSchema.safeParse({ ...record, writtenAt: now.toISOString(), by: actor });
  if (!parsed.success) return { ok: false, reason: `The export record is not usable: ${parsed.error.issues[0]?.message ?? 'bad data'}` };
  return editTrack2d(p, shotId, actor, now, 'track2d.exported', (doc, s) => {
    if (parsed.data.version !== track2dTaskVersion(s)) return `That export is ${versionTag(parsed.data.version)}; the 2D track task is ${versionTag(track2dTaskVersion(s))}`;
    return {
      doc: { ...doc, exports: [...doc.exports.filter((e) => e.version !== parsed.data.version), parsed.data].sort((a, b) => a.version - b.version) },
      detail: `${versionTag(parsed.data.version)}: ${parsed.data.tracks.join(', ')} as ${parsed.data.formats.join(', ')} → ${parsed.data.folder}`,
      task: 'review',
    };
  });
}

export function track2dManifest(s: ShotState) {
  const doc = s.track2d;
  if (!doc) return null;
  const task = s.tasks.find((t) => t.kind === 'track_2d');
  const version = task?.version ?? 1;
  const exported = doc.exports.find((e) => e.version === version) ?? null;
  return {
    version: versionTag(version),
    state: task?.state ?? null,
    approval: task?.approval ?? null,
    exported: exported !== null,
    folder: exported?.folder ?? null,
    files: exported?.files ?? [],
    tracks: doc.tracks.map((t) => {
      const conf = t.frames.filter((f) => f.status !== 'key').map((f) => f.confidence);
      return { id: t.id, name: t.name, kind: t.kind, keys: t.keys.map((k) => k.frame), frames: t.frames.length, first: t.frames[0]?.frame ?? null, last: t.frames[t.frames.length - 1]?.frame ?? null, confidence: conf.length ? { mean: conf.reduce((a, b) => a + b, 0) / conf.length, min: Math.min(...conf) } : null, engine: t.engine };
    }),
  };
}

/** Frames between neighbouring keys of a 2D track, for local re-tracking around `frame`. */
export function track2dSpan(t: Pick<Track2d, 'keys'>, frame: number, first: number, last: number): { previous: number; next: number } {
  const ks = t.keys.map((k) => k.frame).sort((a, b) => a - b);
  const previous = [...ks].reverse().find((k) => k < frame) ?? first;
  const next = ks.find((k) => k > frame) ?? last;
  return { previous, next };
}
