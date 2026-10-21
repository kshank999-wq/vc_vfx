import {
  CAMERA_EXPORT_FORMATS,
  TRACK2D_EXPORT_FORMATS,
  UNIT_METRES,
  addCustomCamera,
  applyCamTrack,
  camNextId,
  camtrackNames,
  createTrack2d,
  CameraBodySchema,
  defaultMode,
  findCamera,
  focalMillimetres,
  focalPixels,
  recordTrack2dExport,
  recordTrack2dRun,
  removeTrack2d,
  removeTrack2dKey,
  saveLensProfile,
  setTrack2dKey,
  track2dNames,
  track2dSpan,
  updateTrack2d,
  versionTag,
  type CamExport,
  type CameraBody,
  type CameraBodyInput,
  type CamTrackChange,
  type CamTrackDocument,
  type CameraExportFormat,
  type Correspondence,
  type LensProfile,
  type LidarFormat,
  type Project,
  type Result,
  type SceneUnit,
  type SolveRecord,
  type Track2dDocument,
  type Track2dExportFormat,
  type Track2dExportInput,
  type Track2dFrame,
  type Track2dKind,
  type UpAxis,
} from '@vcvfx/domain';
import { applySim, composeSim, estimateNormals, icpPointToPlane, invertSim, PointGrid, umeyama, type Similarity } from './align';
import { decodeCloud, decodeSolve, decodeTracks, encodeCloud, encodeSolve, encodeTracks } from './codec';
import { sceneCameras, sceneTransform, unitScale } from './coords';
import { writeAfterEffects, writeBlender, writeCameraJson, writeChan, writeExportReadme, writeFbx, writeFusionComp, writeFusionSetting, writeHoudini, writeMax, writeMaya, writeNuke, writePointsObj, writeUnity, writeUnreal, writeUsda, type CameraExportData } from './export-formats';
import { project as projectPoint, type Intrinsics } from './geometry';
import { KLT_VERSION, trackFrames, type GrayFrame, type KltOptions } from './klt';
import { downsampleTo, formatFromName, parsePointFile } from './lidar';
import { mul3, t3 } from './linalg';
import { blendRuns, PLANAR_VERSION, trackPlanar, trackPoint, type Quad } from './planar';
import { centreOf } from './pose';
import type { CameraSolver, SolveResult, SolveSettings } from './solver';
import { redistortMap, stmapExr, undistortMap } from './stmap';
import { filterTracks, mergeTracks, summariseTracks, trackAt, type TrackData } from './tracks';
import { writeCornerPinJsx, writeMochaText, writeNukeCornerPin, writeTrack2dJson } from './track2d-export';

/**
 * The camera-tracking command layer (addendum 06 §8). Every operation on a
 * shot's camera track or 2D tracks is a serialisable command with a
 * structured result, run by `dispatch` over a `CameraSession`. The Track
 * workspace uses these verbs and so will the AI tracking assistant: both see
 * the same results and leave the same trail.
 *
 * A command never changes the project itself. Its outcome carries `ops` —
 * data describing the project changes (a new camera-track document, a 2D
 * run, a lens profile…) — which the renderer applies with `applyOps`, through
 * the domain's mutations, so every command is checked against the approval
 * rules and logged (`camtrack.<verb>` / `track2d.*`), queries included.
 *
 * Heavy commands (tracking, solving, ICP, LiDAR import, export) run in the
 * desktop's worker thread or, in the browser preview, in the page; large
 * data goes through `session.store` (files in the track cache), never the
 * project.
 */

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export type Rect = { x0: number; y0: number; x1: number; y1: number };

export type CameraCommand =
  | { verb: 'auto_track'; from?: number; to?: number; append?: boolean }
  | { verb: 'detect_features'; frame: number; region?: Rect; maxFeatures?: number }
  | { verb: 'track_features'; from: number; to: number }
  | { verb: 'delete_tracks'; ids?: number[]; maxErrorPx?: number; minLength?: number; region?: Rect & { frame: number } }
  | { verb: 'set_camera'; cameraId?: string; modeId?: string; filmBackMm?: { width: number; height: number }; label?: string; custom?: Omit<CameraBodyInput, 'custom'> }
  | { verb: 'add_custom_camera'; camera: Omit<CameraBodyInput, 'custom'> }
  | { verb: 'set_lens'; name?: string; focalMm?: number | null; focalMode?: 'known' | 'approx' | 'unknown'; distortion?: Partial<Record<'k1' | 'k2' | 'k3' | 'p1' | 'p2', number>>; refine?: Partial<Record<'focal' | 'k1k2' | 'k3' | 'p1p2', boolean>>; profileId?: string | null; squeeze?: number }
  | { verb: 'set_track_settings'; maxFeatures?: number; workingWidth?: number; minDistance?: number; quality?: number; fbThreshold?: number }
  | { verb: 'set_masks'; excludeRotoParts?: string[]; rects?: (Rect & { mode: 'include' | 'exclude' })[] }
  | { verb: 'solve'; useLidar?: boolean; refine?: Partial<Record<'focal' | 'k1k2' | 'k3' | 'p1p2', boolean>>; loss?: 'huber' | 'cauchy'; nodal?: boolean }
  | { verb: 'select_solve'; number: number }
  | { verb: 'get_report'; worst?: number; frames?: [number, number] }
  | { verb: 'import_lidar'; path: string; name?: string; units?: SceneUnit; up?: UpAxis; format?: LidarFormat }
  | { verb: 'remove_lidar'; id: string }
  | { verb: 'add_correspondence'; lidarId: string; point: [number, number, number]; trackId?: number; frame?: number; x?: number; y?: number; name?: string }
  | { verb: 'remove_correspondence'; id: string }
  | { verb: 'align_to_lidar'; method: 'similarity' | 'constrained' | 'icp'; lidarId?: string }
  | { verb: 'set_coordinate_system'; units?: SceneUnit; upAxis?: UpAxis; origin?: { trackId: number } | { point: [number, number, number] } | null; ground?: [number, number, number] | null; scale?: { trackIds: [number, number]; distance: number } | null }
  | { verb: 'export_camera'; formats?: CameraExportFormat[]; stmaps?: boolean }
  | { verb: 'save_lens_profile'; id?: string; notes?: string }
  | { verb: 'track2d_create'; name: string; kind: Track2dKind; frame: number; points: [number, number][] }
  | { verb: 'track2d_set_key'; trackId: string; frame: number; points: [number, number][] }
  | { verb: 'track2d_remove_key'; trackId: string; frame: number }
  | { verb: 'track2d_track'; trackId: string; from: number; direction: 'forward' | 'backward' | 'around' }
  | { verb: 'track2d_update'; trackId: string; name?: string; occluders?: string[]; pattern?: number; search?: number }
  | { verb: 'track2d_delete'; trackId: string }
  | { verb: 'track2d_export'; trackIds?: string[]; formats?: Track2dExportFormat[] };

export type CommandVerb = CameraCommand['verb'];

/** What each verb does, for the interface and the AI assistant's tool list. */
export const COMMAND_SPECS: Record<CommandVerb, { summary: string; heavy: boolean; mutates: boolean; scope: 'camera' | '2d' }> = {
  auto_track: { summary: 'Detect corners and track them through the shot (replaces the tracks unless append)', heavy: true, mutates: true, scope: 'camera' },
  detect_features: { summary: 'Detect new features in a region of one frame and track them both ways through the shot', heavy: true, mutates: true, scope: 'camera' },
  track_features: { summary: 'Track (with fresh detections) over a frame range and add the tracks', heavy: true, mutates: true, scope: 'camera' },
  delete_tracks: { summary: 'Delete tracks by id, by solve error above a threshold, by length below a minimum, or inside a rectangle on a frame', heavy: false, mutates: true, scope: 'camera' },
  set_camera: { summary: 'Choose the camera body and recording mode (film back) from the database, add and choose a custom body (sensor mm and pixels), or type a film back. A fixed-lens camera (drone, phone) also sets the starting focal length; an anamorphic mode sets the squeeze', heavy: false, mutates: true, scope: 'camera' },
  add_custom_camera: { summary: "Add a camera body to the project's database", heavy: false, mutates: true, scope: 'camera' },
  set_lens: { summary: 'Set the lens: focal length and whether it is known, distortion, a lens profile, which intrinsics the solve refines', heavy: false, mutates: true, scope: 'camera' },
  set_track_settings: { summary: 'Tracker settings: features, working size, spacing, quality, forward–backward threshold', heavy: false, mutates: true, scope: 'camera' },
  set_masks: { summary: 'Exclude roto parts (moving objects) and rectangles from tracking; include rectangles restrict it', heavy: false, mutates: true, scope: 'camera' },
  solve: { summary: 'Solve the camera from the tracks (optionally constrained by LiDAR correspondences)', heavy: true, mutates: true, scope: 'camera' },
  select_solve: { summary: 'Make an earlier solve the active one', heavy: false, mutates: true, scope: 'camera' },
  get_report: { summary: 'Per-frame and per-track residuals of the active solve, the worst tracks and the warnings', heavy: false, mutates: false, scope: 'camera' },
  import_lidar: { summary: 'Import a LiDAR scan, mesh or survey CSV (read only; a downsampled copy is cached)', heavy: true, mutates: true, scope: 'camera' },
  remove_lidar: { summary: 'Forget an imported LiDAR file (and its correspondences)', heavy: false, mutates: true, scope: 'camera' },
  add_correspondence: { summary: 'Tie a LiDAR/survey point to a track (or a pixel on a frame)', heavy: false, mutates: true, scope: 'camera' },
  remove_correspondence: { summary: 'Remove a correspondence', heavy: false, mutates: true, scope: 'camera' },
  align_to_lidar: { summary: 'Align the solve to the LiDAR: similarity (Umeyama), constrained re-solve, or ICP refinement', heavy: true, mutates: true, scope: 'camera' },
  set_coordinate_system: { summary: 'Units, up axis, origin, ground plane from three tracks, scale from a known distance', heavy: false, mutates: true, scope: 'camera' },
  export_camera: { summary: 'Write the camera for Nuke, Maya, Blender, After Effects, 3ds Max, FBX, .chan, JSON, OBJ, and lens STMaps', heavy: true, mutates: true, scope: 'camera' },
  save_lens_profile: { summary: "Save the active solve's lens (focal and distortion) as a project lens profile", heavy: false, mutates: true, scope: 'camera' },
  track2d_create: { summary: 'Create a planar (four corners) or point track on a frame', heavy: false, mutates: true, scope: '2d' },
  track2d_set_key: { summary: 'Set or correct the corners (or point) on a frame: it becomes a key', heavy: false, mutates: true, scope: '2d' },
  track2d_remove_key: { summary: 'Remove a key frame', heavy: false, mutates: true, scope: '2d' },
  track2d_track: { summary: 'Track forward or backward from a key to the neighbouring key, or re-track around a key (blended)', heavy: true, mutates: true, scope: '2d' },
  track2d_update: { summary: "Rename a track, set its occluders (roto parts), the point tracker's pattern and search sizes", heavy: false, mutates: true, scope: '2d' },
  track2d_delete: { summary: 'Delete a 2D track', heavy: false, mutates: true, scope: '2d' },
  track2d_export: { summary: 'Write corner-pin / track data: Nuke CornerPin2D, After Effects, Mocha-style text, JSON', heavy: true, mutates: true, scope: '2d' },
};

/** Project changes a command asks for (applied by `applyOps`). */
export type ProjectOp =
  | { op: 'camtrack'; change: CamTrackChange }
  | { op: 'note'; command: string; summary: string }
  | { op: 'lens_profile'; profile: Omit<LensProfile, 'at' | 'by'> }
  | { op: 'custom_camera'; camera: Omit<CameraBodyInput, 'custom'> }
  | { op: 'track2d_create'; input: { name: string; kind: Track2dKind; frame: number; points: [number, number][] } }
  | { op: 'track2d_key'; trackId: string; frame: number; points: [number, number][] }
  | { op: 'track2d_remove_key'; trackId: string; frame: number }
  | { op: 'track2d_run'; trackId: string; run: { frames: Track2dFrame[]; engine: string; from: number; direction: string } }
  | { op: 'track2d_update'; trackId: string; change: { name?: string; occluders?: string[]; pattern?: number; search?: number } }
  | { op: 'track2d_delete'; trackId: string }
  | { op: 'track2d_export'; record: Track2dExportInput };

export type CommandOutcome = { ok: true; summary: string; data: Record<string, unknown>; ops: ProjectOp[] } | { ok: false; error: string; ops?: ProjectOp[] };

// ---------------------------------------------------------------------------
// The session a command runs against
// ---------------------------------------------------------------------------

export interface CameraStore {
  get(id: string): Promise<Uint8Array | null>;
  put(id: string, bytes: Uint8Array): Promise<void>;
}

export interface CameraSessionIO {
  /** A frame at the working size, grey 0 … 1. */
  frame(f: number): Promise<GrayFrame>;
  /** 1 inside the given roto parts' mattes on frame f, at the working size; null when none. */
  rotoMask?(partIds: string[], f: number): Promise<Uint8Array | null>;
  /** Read a LiDAR / survey file (read only). */
  readFile?(path: string): Promise<Uint8Array>;
  /** Write export files into the shot package; returns the folder (package-relative) and file names. */
  writeExport?(folder: { section: '06_CAMERA_TRACK' | '05_TRACKS_2D'; name: string }, files: { name: string; data: Uint8Array | string }[]): Promise<{ folder: string; files: string[] }>;
}

export interface CameraSession {
  shotId: string;
  /** The name files carry (VFX shot number or handoff id). */
  name: string;
  first: number;
  last: number;
  fps: number;
  plate: { width: number; height: number };
  working: { width: number; height: number };
  camtrack: CamTrackDocument;
  track2d: Track2dDocument;
  camtrackVersion: number;
  track2dVersion: number;
  /** Why camera / 2D changes are refused right now (approved, past prep…), or null. */
  camtrackLocked: string | null;
  track2dLocked: string | null;
  lensProfiles: LensProfile[];
  customCameras: CameraBody[];
  actor: string;
  now(): Date;
  generator: string;
  io: CameraSessionIO;
  store: CameraStore;
  solver: CameraSolver;
  signal?: { aborted: boolean };
  progress?: (label: string, done: number, total: number) => void;
  yieldNow?: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ok = (summary: string, data: Record<string, unknown>, ops: ProjectOp[]): CommandOutcome => ({ ok: true, summary, data, ops });
const fail = (error: string): CommandOutcome => ({ ok: false, error });
const px = (v: number) => `${v.toFixed(2)} px`;

async function loadTracks(s: CameraSession): Promise<TrackData | null> {
  const ts = s.camtrack.trackSet;
  if (!ts) return null;
  const bytes = await s.store.get(ts.file);
  return bytes ? decodeTracks(bytes) : null;
}

async function loadSolve(s: CameraSession, number = s.camtrack.activeSolve): Promise<{ record: SolveRecord; solve: SolveResult } | null> {
  if (number === null) return null;
  const record = s.camtrack.solves.find((x) => x.number === number);
  if (!record) return null;
  const bytes = await s.store.get(record.file);
  return bytes ? { record, solve: decodeSolve(bytes) } : null;
}

function change(s: CameraSession, command: string, summary: string, doc: CamTrackDocument, task: CamTrackChange['task'] = null): ProjectOp {
  s.camtrack = doc; // later commands in the same session see it
  return { op: 'camtrack', change: { command, summary, doc, task } };
}

/** Film back width (mm) the plate spans, and whether it was known. */
export function filmBackOf(doc: CamTrackDocument): { width: number; height: number; nominal: boolean } {
  return doc.camera ? { ...doc.camera.filmBackMm, nominal: false } : { width: 36, height: 24, nominal: true };
}

function rectsMask(s: CameraSession): ((f: number) => Promise<Uint8Array | null>) | undefined {
  const { masks } = s.camtrack;
  if (!masks.rects.length && !masks.excludeRotoParts.length) return undefined;
  const W = s.working.width;
  const H = s.working.height;
  const kx = W / s.plate.width;
  const ky = H / s.plate.height;
  const base = new Uint8Array(W * H);
  const includes = masks.rects.filter((r) => r.mode === 'include');
  base.fill(includes.length ? 0 : 1);
  const paint = (r: Rect, v: number) => {
    const x0 = Math.max(0, Math.floor(Math.min(r.x0, r.x1) * kx));
    const x1 = Math.min(W - 1, Math.ceil(Math.max(r.x0, r.x1) * kx));
    const y0 = Math.max(0, Math.floor(Math.min(r.y0, r.y1) * ky));
    const y1 = Math.min(H - 1, Math.ceil(Math.max(r.y0, r.y1) * ky));
    for (let y = y0; y <= y1; y += 1) base.fill(v, y * W + x0, y * W + x1 + 1);
  };
  for (const r of includes) paint(r, 1);
  for (const r of masks.rects.filter((q) => q.mode === 'exclude')) paint(r, 0);
  return async (f) => {
    if (!masks.excludeRotoParts.length || !s.io.rotoMask) return base;
    const roto = await s.io.rotoMask(masks.excludeRotoParts, f);
    if (!roto) return base;
    const out = new Uint8Array(base);
    for (let i = 0; i < out.length; i += 1) if (roto[i]) out[i] = 0;
    return out;
  };
}

function kltOptions(s: CameraSession): KltOptions {
  const t = s.camtrack.trackSettings;
  const k = s.working.width / s.plate.width;
  return { maxFeatures: t.maxFeatures, quality: t.quality, fbThreshold: t.fbThreshold, ...(t.minDistance ? { minDistance: Math.max(3, t.minDistance * k) } : {}) };
}

async function runTracker(s: CameraSession, from: number, to: number, region: Rect | null, nextId: number, maxFeatures?: number): Promise<TrackData> {
  const mask = rectsMask(s);
  return trackFrames(
    { frame: (f) => s.io.frame(f), ...(mask ? { mask } : {}) },
    { first: s.first, last: s.last, from, to, working: s.working, plate: s.plate, region, nextId, options: { ...kltOptions(s), ...(maxFeatures ? { maxFeatures } : {}) } },
    { ...(s.signal ? { signal: s.signal } : {}), progress: (d, t, f) => s.progress?.(`Tracking frame ${f}`, d, t), ...(s.yieldNow ? { yieldNow: s.yieldNow } : {}) },
  );
}

async function storeTracks(s: CameraSession, doc: CamTrackDocument, td: TrackData, deleted = 0): Promise<CamTrackDocument> {
  const id = camNextId(doc, 'tracks');
  await s.store.put(id.id, encodeTracks(td));
  const sum = summariseTracks(td);
  return {
    ...id.doc,
    trackSet: { file: id.id, tracks: sum.tracks, observations: sum.observations, meanLength: Math.round(sum.meanLength * 10) / 10, minPerFrame: sum.minPerFrame, medianPerFrame: sum.medianPerFrame, first: td.first, last: td.last, engine: `klt@${KLT_VERSION}`, deleted: (doc.trackSet?.deleted ?? 0) + deleted, at: s.now().toISOString(), by: s.actor },
  };
}

/** Intrinsics for the solve from the lens settings and the film back. */
function solveSettingsFor(s: CameraSession, cmd: Extract<CameraCommand, { verb: 'solve' }>): SolveSettings {
  const { lens } = s.camtrack;
  const fb = filmBackOf(s.camtrack);
  const focalPx = lens.focalMm && !fb.nominal ? focalPixels(lens.focalMm, fb.width, s.plate.width) : null;
  const mode = focalPx ? lens.focalMode : 'unknown';
  const refine = { ...lens.refine, ...(cmd.refine ?? {}) };
  return {
    focal: { mode, ...(focalPx ? { px: focalPx } : {}) },
    distortion: lens.distortion,
    refine,
    loss: cmd.loss ?? 'huber',
    ...(cmd.nodal !== undefined ? { nodal: cmd.nodal } : {}),
  };
}

function recordOf(s: CameraSession, number: number, file: string, tracksFile: string, solve: SolveResult, settings: SolveSettings, constraint: SolveRecord['constraint']): SolveRecord {
  const fb = filmBackOf(s.camtrack);
  const k = solve.intrinsics;
  return {
    number,
    taskVersion: s.camtrackVersion,
    file,
    tracks: tracksFile,
    engine: solve.engine,
    settings: { focal: settings.focal.mode, focalPx: settings.focal.px ?? null, refineFocal: Boolean(settings.refine?.focal), k1k2: Boolean(settings.refine?.k1k2), k3: Boolean(settings.refine?.k3), p1p2: Boolean(settings.refine?.p1p2), loss: settings.loss ?? 'huber', priors: settings.pointPriors?.length ?? 0, controlPoints: settings.controlPoints?.length ?? 0 },
    intrinsics: { focalPx: k.f, focalMm: fb.nominal ? null : focalMillimetres(k.f, fb.width, s.plate.width), cx: k.cx, cy: k.cy, k1: k.k1, k2: k.k2, k3: k.k3, p1: k.p1, p2: k.p2 },
    stats: {
      rms: solve.stats.rms,
      medianError: solve.stats.medianError,
      framesSolved: solve.stats.framesSolved,
      framesTotal: solve.stats.framesTotal,
      tracksUsed: solve.stats.tracksUsed,
      tracksTotal: solve.stats.tracksTotal,
      keyframes: solve.stats.keyframes,
      nodal: solve.stats.nodal,
      confidence: solve.stats.confidence,
      minTracksPerFrame: solve.stats.minTracksPerFrame,
      warnings: solve.stats.warnings.slice(0, 20),
      ms: solve.stats.timings.total,
    },
    constraint,
    at: s.now().toISOString(),
    by: s.actor,
  };
}

/** Transform a solve by a similarity (its world → a new world). */
export function transformSolve(solve: SolveResult, T: Similarity): SolveResult {
  return {
    ...solve,
    frames: solve.frames.map((f) => {
      if (!f.solved) return f;
      const R = mul3(f.R, t3(T.R));
      const RAtb = [R[0]! * T.t[0]! + R[1]! * T.t[1]! + R[2]! * T.t[2]!, R[3]! * T.t[0]! + R[4]! * T.t[1]! + R[5]! * T.t[2]!, R[6]! * T.t[0]! + R[7]! * T.t[1]! + R[8]! * T.t[2]!];
      return { ...f, R, t: [T.s * f.t[0]! - RAtb[0]!, T.s * f.t[1]! - RAtb[1]!, T.s * f.t[2]! - RAtb[2]!] };
    }),
    tracks: solve.tracks.map((tr) => (tr.X ? { ...tr, X: applySim(T, tr.X) as [number, number, number] } : tr)),
  };
}

function simOf(rec: { s: number; R: number[]; t: [number, number, number] | number[] }): Similarity {
  return { s: rec.s, R: [...rec.R], t: [...rec.t] };
}

/** Recompute the scene transform after the solve, alignment or coordinate settings changed. */
function withCoords(doc: CamTrackDocument, solve: SolveResult | null): { doc: CamTrackDocument; error: string | null; notes: string[] } {
  if (!solve) return { doc, error: null, notes: [] };
  const lidar = doc.alignment ? doc.lidar.find((l) => l.id === doc.alignment!.lidarId) : undefined;
  const r = sceneTransform({ solve, alignment: doc.alignment && lidar && doc.alignment.solve === doc.activeSolve ? { transform: simOf(doc.alignment.transform), lidar: { units: lidar.units, up: lidar.up } } : null, coords: doc.coords });
  const T = r.error ? r.base : r.transform;
  return { doc: { ...doc, coords: { ...doc.coords, transform: { s: T.s, R: [...T.R], t: [T.t[0]!, T.t[1]!, T.t[2]!] } } }, error: r.error, notes: r.notes };
}

/** Residuals of each correspondence under a solve-world → LiDAR transform. */
function correspondenceResiduals(s: CameraSession, solve: SolveResult, tracks: TrackData | null, T: Similarity, list: Correspondence[]): Correspondence[] {
  const Tinv = invertSim(T);
  const k = solve.intrinsics;
  const byId = new Map(solve.tracks.map((t) => [t.id, t]));
  return list.map((c) => {
    const lidar = s.camtrack.lidar.find((l) => l.id === c.lidarId);
    const mmPer = lidar ? UNIT_METRES[lidar.units] * 1000 : 1000;
    const Xs = applySim(Tinv, c.point); // LiDAR point in the solve world
    let residualMm: number | null = null;
    let residualPx: number | null = null;
    if (c.target.kind === 'track') {
      const tr = byId.get(c.target.trackId);
      if (tr?.X) {
        const p = applySim(T, tr.X);
        residualMm = Math.hypot(p[0]! - c.point[0], p[1]! - c.point[1], p[2]! - c.point[2]) * mmPer;
      }
      if (tracks) {
        const ti = tracks.ids.indexOf(c.target.trackId);
        const errs: number[] = [];
        if (ti >= 0)
          for (const f of solve.frames) {
            if (!f.solved) continue;
            const o = trackAt(tracks, ti, f.frame);
            const pr = o ? projectPoint(k, f.R, f.t, Xs) : null;
            if (o && pr) errs.push(Math.hypot(pr[0] - o[0], pr[1] - o[1]));
          }
        residualPx = errs.length ? errs.reduce((a, b) => a + b, 0) / errs.length : null;
      }
    } else {
      const target = c.target;
      const f = solve.frames.find((x) => x.frame === target.frame && x.solved);
      const pr = f ? projectPoint(k, f.R, f.t, Xs) : null;
      if (pr) residualPx = Math.hypot(pr[0] - target.x, pr[1] - target.y);
    }
    return { ...c, residualPx: residualPx === null ? null : Math.round(residualPx * 1000) / 1000, residualMm: residualMm === null ? null : Math.round(residualMm * 10) / 10 };
  });
}

// ---------------------------------------------------------------------------
// The dispatcher
// ---------------------------------------------------------------------------

export async function dispatch(s: CameraSession, cmd: CameraCommand): Promise<CommandOutcome> {
  const spec = COMMAND_SPECS[cmd.verb];
  if (!spec) return fail(`Unknown command ${(cmd as { verb: string }).verb}`);
  if (spec.mutates) {
    const locked = spec.scope === 'camera' ? s.camtrackLocked : s.track2dLocked;
    if (locked) return fail(locked);
  }
  try {
    return await run(s, cmd);
  } catch (error) {
    const message = (error as Error).message;
    return fail(message === 'Cancelled' ? 'Cancelled' : message);
  }
}

async function run(s: CameraSession, cmd: CameraCommand): Promise<CommandOutcome> {
  const doc = s.camtrack;
  switch (cmd.verb) {
    // ----- tracking ---------------------------------------------------------
    case 'auto_track': {
      const from = cmd.from ?? s.first;
      const to = cmd.to ?? s.last;
      const existing = cmd.append ? await loadTracks(s) : null;
      const td = await runTracker(s, from, to, null, existing?.nextId ?? 1);
      const merged = existing ? mergeTracks(existing, td) : td;
      const next = await storeTracks(s, doc, merged);
      const sum = summariseTracks(merged);
      const summary = `${sum.tracks} tracks over ${from}–${to} (mean ${sum.meanLength.toFixed(1)} frames, at least ${sum.minPerFrame} per frame)${cmd.append ? `, ${td.ids.length} added` : ''}`;
      return ok(summary, { tracks: sum.tracks, observations: sum.observations, meanLength: sum.meanLength, minPerFrame: sum.minPerFrame, medianPerFrame: sum.medianPerFrame, added: td.ids.length }, [change(s, 'auto_track', summary, next, 'work')]);
    }
    case 'detect_features':
    case 'track_features': {
      const existing = await loadTracks(s);
      const region = cmd.verb === 'detect_features' ? (cmd.region ?? null) : null;
      let added: TrackData;
      if (cmd.verb === 'detect_features') {
        const f = Math.min(s.last, Math.max(s.first, cmd.frame));
        // Detect on f only (no re-detection) and track both ways until each feature is lost.
        const fwd = await trackFrames({ frame: (x) => s.io.frame(x) }, { first: s.first, last: s.last, from: f, to: s.last, working: s.working, plate: s.plate, region, nextId: existing?.nextId ?? 1, options: { ...kltOptions(s), maxFeatures: cmd.maxFeatures ?? 60, detectOnce: true, minLength: 1 } }, { ...(s.signal ? { signal: s.signal } : {}), progress: (d, t) => s.progress?.('Tracking forward', d, t) });
        // Backward from f for the same features: seed by detecting again with the same settings (deterministic).
        const bwd = await trackFrames({ frame: (x) => s.io.frame(x) }, { first: s.first, last: s.last, from: f, to: s.first, working: s.working, plate: s.plate, region, nextId: fwd.nextId, options: { ...kltOptions(s), maxFeatures: cmd.maxFeatures ?? 60, detectOnce: true, minLength: 1 } }, { ...(s.signal ? { signal: s.signal } : {}), progress: (d, t) => s.progress?.('Tracking backward', d, t) });
        // Join each forward track with the backward track that started at the same place.
        const joined = joinAtFrame(fwd, bwd, f);
        added = filterTracks(joined, (i) => joined.length[i]! >= 4);
      } else {
        added = await runTracker(s, cmd.from, cmd.to, null, existing?.nextId ?? 1);
      }
      const merged = existing ? mergeTracks(existing, added) : added;
      const next = await storeTracks(s, doc, merged);
      const summary = `${added.ids.length} tracks added${cmd.verb === 'detect_features' ? ` from frame ${cmd.frame}${region ? ` in (${Math.round(region.x0)}, ${Math.round(region.y0)})–(${Math.round(region.x1)}, ${Math.round(region.y1)})` : ''}` : ` over ${cmd.from}–${cmd.to}`}; ${merged.ids.length} in all`;
      return ok(summary, { added: added.ids.length, ids: Array.from(added.ids), total: merged.ids.length }, [change(s, cmd.verb, summary, next, 'work')]);
    }
    case 'delete_tracks': {
      const td = await loadTracks(s);
      if (!td) return fail('There are no tracks yet. Run auto_track first.');
      const solved = cmd.maxErrorPx !== undefined ? await loadSolve(s) : null;
      if (cmd.maxErrorPx !== undefined && !solved) return fail('Deleting by error needs a solve: solve first.');
      const err = new Map(solved?.solve.tracks.map((t) => [t.id, t]) ?? []);
      const ids = new Set(cmd.ids ?? []);
      const drop = (i: number) => {
        const id = td.ids[i]!;
        if (ids.has(id)) return true;
        if (cmd.minLength !== undefined && td.length[i]! < cmd.minLength) return true;
        if (cmd.maxErrorPx !== undefined) {
          const e = err.get(id);
          if (e && e.inliers > 0 && e.rms > cmd.maxErrorPx) return true;
        }
        if (cmd.region) {
          const p = trackAt(td, i, cmd.region.frame);
          const r = cmd.region;
          if (p && p[0] >= Math.min(r.x0, r.x1) && p[0] <= Math.max(r.x0, r.x1) && p[1] >= Math.min(r.y0, r.y1) && p[1] <= Math.max(r.y0, r.y1)) return true;
        }
        return false;
      };
      const dropped: number[] = [];
      for (let i = 0; i < td.ids.length; i += 1) if (drop(i)) dropped.push(td.ids[i]!);
      if (!dropped.length) return ok('No tracks matched', { deleted: 0, ids: [] }, [{ op: 'note', command: 'delete_tracks', summary: 'No tracks matched' }]);
      const gone = new Set(dropped);
      const kept = filterTracks(td, (i) => !gone.has(td.ids[i]!));
      const next = await storeTracks(s, doc, kept, dropped.length);
      const why = [cmd.ids?.length ? `${cmd.ids.length} by id` : null, cmd.maxErrorPx !== undefined ? `error > ${cmd.maxErrorPx} px` : null, cmd.minLength !== undefined ? `shorter than ${cmd.minLength} frames` : null, cmd.region ? `in a rectangle on ${cmd.region.frame}` : null].filter(Boolean).join(', ');
      const summary = `Deleted ${dropped.length} track${dropped.length === 1 ? '' : 's'} (${why}); ${kept.ids.length} left. Solve again to update the camera.`;
      return ok(summary, { deleted: dropped.length, ids: dropped.slice(0, 500), remaining: kept.ids.length }, [change(s, 'delete_tracks', summary, next, 'work')]);
    }

    // ----- camera, lens, settings -------------------------------------------
    case 'set_camera': {
      let camera: CamTrackDocument['camera'];
      let body: CameraBody | undefined;
      const ops: ProjectOp[] = [];
      if (cmd.filmBackMm) {
        if (!(cmd.filmBackMm.width > 1 && cmd.filmBackMm.width < 100 && cmd.filmBackMm.height > 1 && cmd.filmBackMm.height < 100)) return fail('A film back is a width and height in millimetres (1 – 100)');
        camera = { source: 'manual', cameraId: null, modeId: null, label: cmd.label ?? `Film back ${cmd.filmBackMm.width} × ${cmd.filmBackMm.height} mm`, filmBackMm: cmd.filmBackMm, sensorPx: null, verified: false, note: 'Typed in', handoffText: null };
      } else {
        if (cmd.custom) {
          const parsed = CameraBodySchema.safeParse({ ...cmd.custom, custom: true });
          if (!parsed.success) return fail(`The camera is not usable: ${parsed.error.issues[0]?.message ?? 'bad data'}`);
          body = parsed.data;
          ops.push({ op: 'custom_camera', camera: cmd.custom });
        } else body = cmd.cameraId ? findCamera(cmd.cameraId, s.customCameras) : undefined;
        if (!body) return fail(`No camera ${cmd.cameraId ?? ''} in the database`);
        const mode = body.modes.find((m) => m.id === cmd.modeId) ?? defaultMode(body);
        camera = { source: body.custom ? 'custom' : 'database', cameraId: body.id, modeId: mode.id, label: `${body.make} ${body.model} · ${mode.name}`, filmBackMm: mode.filmBackMm, sensorPx: mode.px, verified: mode.verified, note: mode.notes || body.verifiedNotes || body.source, handoffText: null };
      }
      let lens = doc.lens;
      const extra: string[] = [];
      if (body?.fixedFocalMm && body.id !== doc.camera?.cameraId) {
        // A fixed lens: its focal is the start (derived from the 35 mm equivalent unless the notes say otherwise).
        lens = { ...lens, focalMm: body.fixedFocalMm, focalMode: 'approx', name: `${body.make} ${body.model} (fixed lens)`, profileId: null };
        extra.push(`fixed lens ${body.fixedFocalMm} mm (approximate)`);
      } else if (body && !body.fixedFocalMm && /\(fixed lens\)$/.test(lens.name)) {
        // Leaving a fixed-lens camera: its focal no longer applies.
        lens = { ...lens, name: '', focalMm: null, focalMode: 'unknown' };
      }
      const squeeze = body ? (body.modes.find((m) => m.id === camera.modeId)?.anamorphicSqueeze ?? 1) : 1;
      if (squeeze !== lens.squeeze && (squeeze !== 1 || !lens.profileId)) {
        lens = { ...lens, squeeze };
        extra.push(`squeeze ${squeeze}×`);
      }
      const summary = `${camera.label}: film back ${camera.filmBackMm.width} × ${camera.filmBackMm.height} mm${camera.verified ? ' (verified)' : ''}${extra.length ? `; ${extra.join(', ')}` : ''}`;
      return ok(summary, { camera, lens }, [...ops, change(s, 'set_camera', summary, { ...doc, camera, lens })]);
    }
    case 'add_custom_camera':
      return ok(`Added ${cmd.camera.make} ${cmd.camera.model} to the project's cameras`, { id: cmd.camera.id }, [{ op: 'custom_camera', camera: cmd.camera }]);
    case 'set_lens': {
      let lens = { ...doc.lens, refine: { ...doc.lens.refine, ...(cmd.refine ?? {}) } };
      if (cmd.name !== undefined) lens.name = cmd.name;
      if (cmd.focalMm !== undefined) lens.focalMm = cmd.focalMm && cmd.focalMm > 0 ? cmd.focalMm : null;
      if (cmd.focalMode) lens.focalMode = cmd.focalMode;
      if (cmd.squeeze !== undefined && cmd.squeeze > 0) lens.squeeze = cmd.squeeze;
      if (cmd.distortion) lens.distortion = { ...lens.distortion, ...cmd.distortion };
      if (cmd.profileId !== undefined) {
        if (cmd.profileId === null) lens.profileId = null;
        else {
          const p = s.lensProfiles.find((x) => x.id === cmd.profileId);
          if (!p) return fail(`No lens profile ${cmd.profileId}`);
          lens = { ...lens, profileId: p.id, distortion: { ...p.distortion }, squeeze: p.squeeze, focalMm: lens.focalMm ?? p.focalMm, name: lens.name || p.lens };
        }
      }
      if (lens.focalMode !== 'unknown' && !lens.focalMm) return fail('A known or approximate focal length needs the focal length in mm');
      const d = lens.distortion;
      const summary = `${lens.name || 'Lens'}: ${lens.focalMm ? `${lens.focalMm} mm` : 'focal unknown'} (${lens.focalMode}); k1 ${d.k1} k2 ${d.k2}${d.p1 || d.p2 ? ` p1 ${d.p1} p2 ${d.p2}` : ''}; refine ${Object.entries(lens.refine).filter(([, v]) => v).map(([k]) => k).join(', ') || 'nothing beyond the focal mode'}`;
      return ok(summary, { lens }, [change(s, 'set_lens', summary, { ...doc, lens })]);
    }
    case 'set_track_settings': {
      const { verb: _v, ...rest } = cmd;
      const trackSettings = { ...doc.trackSettings, ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) };
      const summary = `Tracker: ${trackSettings.maxFeatures} features at ${trackSettings.workingWidth} px, quality ${trackSettings.quality}, forward–backward ${trackSettings.fbThreshold} px`;
      return ok(summary, { trackSettings }, [change(s, 'set_track_settings', summary, { ...doc, trackSettings })]);
    }
    case 'set_masks': {
      const masks = { excludeRotoParts: cmd.excludeRotoParts ?? doc.masks.excludeRotoParts, rects: cmd.rects ?? doc.masks.rects };
      const summary = `Masks: ${masks.excludeRotoParts.length ? `roto ${masks.excludeRotoParts.join(', ')} excluded` : 'no roto exclusions'}; ${masks.rects.length} rectangle${masks.rects.length === 1 ? '' : 's'}`;
      return ok(summary, { masks }, [change(s, 'set_masks', summary, { ...doc, masks })]);
    }

    // ----- solving ----------------------------------------------------------
    case 'solve': {
      const td = await loadTracks(s);
      if (!td || !td.ids.length) return fail('There are no tracks to solve from. Run auto_track first.');
      const settings = solveSettingsFor(s, cmd);
      let constraint: SolveRecord['constraint'] = 'none';
      let base = doc;
      if (cmd.useLidar) {
        const prev = await loadSolve(s);
        if (!prev || !doc.alignment) return fail('A LiDAR-constrained solve starts from an aligned solve: align to the LiDAR first (similarity).');
        const T = simOf(doc.alignment.transform);
        const lidar = doc.lidar.find((l) => l.id === doc.alignment!.lidarId);
        const sigma = (0.01 / (lidar ? UNIT_METRES[lidar.units] : 1)); // 1 cm, in the file's units
        settings.initial = transformSolve(prev.solve, T);
        settings.pointPriors = doc.correspondences.filter((c) => c.target.kind === 'track' && c.lidarId === doc.alignment!.lidarId).map((c) => ({ trackId: (c.target as { trackId: number }).trackId, X: c.point, sigma }));
        settings.controlPoints = doc.correspondences.filter((c) => c.target.kind === 'pixel' && c.lidarId === doc.alignment!.lidarId).map((c) => ({ frame: (c.target as { frame: number }).frame, u: (c.target as { x: number }).x, v: (c.target as { y: number }).y, X: c.point }));
        if (settings.pointPriors.length + settings.controlPoints.length < 3) return fail('A LiDAR-constrained solve needs at least 3 correspondences');
        constraint = 'lidar_points';
      }
      s.progress?.('Solving', 0, 1);
      const solve = await s.solver.solve(td, settings, { ...(s.signal ? { signal: s.signal } : {}), progress: (stage, d, t) => s.progress?.(stage, d, t), ...(s.yieldNow ? { yieldNow: s.yieldNow } : {}) });
      if (!solve.ok) return fail(solve.reason ?? 'The solve failed');
      const number = (doc.solves.reduce((m, x) => Math.max(m, x.number), 0) || 0) + 1;
      const fileId = camNextId(base, 'solve');
      base = fileId.doc;
      await s.store.put(fileId.id, encodeSolve(solve));
      const record = recordOf(s, number, fileId.id, doc.trackSet!.file, solve, settings, constraint);
      let next: CamTrackDocument = { ...base, solves: [...base.solves, record], activeSolve: number };
      if (constraint === 'lidar_points' && doc.alignment) {
        // The solve is now in the LiDAR's own coordinates.
        next = { ...next, alignment: { ...doc.alignment, method: 'constrained', solve: number, transform: { s: 1, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] }, at: s.now().toISOString(), by: s.actor } };
        next = { ...next, correspondences: correspondenceResiduals(s, solve, td, { s: 1, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] }, next.correspondences) };
        const mm = next.correspondences.map((c) => c.residualMm).filter((v): v is number => v !== null);
        next = { ...next, alignment: { ...next.alignment!, rmsMm: mm.length ? Math.sqrt(mm.reduce((a, b) => a + b * b, 0) / mm.length) : null } };
      } else if (doc.alignment && doc.alignment.solve !== number) {
        // An unconstrained re-solve leaves the old alignment behind: it belonged to the previous solve.
      }
      const c = withCoords(next, solve);
      next = c.doc;
      const st = solve.stats;
      const summary = `Solve ${number}: RMS ${px(st.rms)}, ${st.framesSolved}/${st.framesTotal} frames, ${st.tracksUsed} tracks, focal ${record.intrinsics.focalMm ? `${record.intrinsics.focalMm.toFixed(2)} mm` : `${record.intrinsics.focalPx.toFixed(1)} px`}${st.nodal ? ', nodal' : ''}, confidence ${(st.confidence * 100).toFixed(0)} %${constraint !== 'none' ? ', LiDAR-constrained' : ''}${st.warnings.length ? ` — ${st.warnings.length} warning${st.warnings.length === 1 ? '' : 's'}` : ''}`;
      return ok(summary, { solve: record.number, rms: st.rms, framesSolved: st.framesSolved, framesTotal: st.framesTotal, tracks: st.tracksUsed, nodal: st.nodal, confidence: st.confidence, focalPx: record.intrinsics.focalPx, focalMm: record.intrinsics.focalMm, distortion: { k1: record.intrinsics.k1, k2: record.intrinsics.k2 }, warnings: st.warnings, timings: st.timings }, [change(s, 'solve', summary, next, 'review')]);
    }
    case 'select_solve': {
      if (!doc.solves.some((x) => x.number === cmd.number)) return fail(`No solve ${cmd.number}`);
      const solved = await loadSolve(s, cmd.number);
      const c = withCoords({ ...doc, activeSolve: cmd.number }, solved?.solve ?? null);
      const summary = `Solve ${cmd.number} is active`;
      return ok(summary, { solve: cmd.number }, [change(s, 'select_solve', summary, c.doc)]);
    }
    case 'get_report': {
      const solved = await loadSolve(s);
      if (!solved) return fail('There is no solve yet.');
      const { solve, record } = solved;
      const td = await loadTracks(s);
      const lens = new Map<number, number>();
      if (td) td.ids.forEach((id, i) => lens.set(id, td.length[i]!));
      const worstN = Math.max(1, Math.min(200, cmd.worst ?? 20));
      const frames = solve.frames.filter((f) => !cmd.frames || (f.frame >= cmd.frames[0] && f.frame <= cmd.frames[1]));
      const worstTracks = [...solve.tracks]
        .filter((t) => t.inliers > 0)
        .sort((a, b) => b.rms - a.rms)
        .slice(0, worstN)
        .map((t) => ({ id: t.id, rmsPx: Math.round(t.rms * 1000) / 1000, inliers: t.inliers, observations: t.observations, length: lens.get(t.id) ?? t.observations }));
      const worstFrames = [...frames]
        .filter((f) => f.solved)
        .sort((a, b) => b.rms - a.rms)
        .slice(0, 10)
        .map((f) => ({ frame: f.frame, rmsPx: Math.round(f.rms * 1000) / 1000, tracks: f.tracks }));
      const summary = `Solve ${record.number}: RMS ${px(record.stats.rms)}; worst frame ${worstFrames[0]?.frame ?? '—'} (${worstFrames[0] ? px(worstFrames[0].rmsPx) : '—'}); worst track ${worstTracks[0]?.id ?? '—'} (${worstTracks[0] ? px(worstTracks[0].rmsPx) : '—'})`;
      return ok(
        summary,
        {
          solve: record.number,
          stats: record.stats,
          intrinsics: record.intrinsics,
          perFrame: frames.map((f) => ({ frame: f.frame, solved: f.solved, rmsPx: Math.round(f.rms * 1000) / 1000, tracks: f.tracks, keyframe: f.keyframe })),
          worstTracks,
          worstFrames,
          correspondences: doc.correspondences.map((c) => ({ id: c.id, name: c.name, residualPx: c.residualPx, residualMm: c.residualMm })),
          alignment: doc.alignment ? { method: doc.alignment.method, rmsMm: doc.alignment.rmsMm, rmsPx: doc.alignment.rmsPx, confidence: doc.alignment.confidence } : null,
        },
        [{ op: 'note', command: 'get_report', summary }],
      );
    }

    // ----- LiDAR ------------------------------------------------------------
    case 'import_lidar': {
      if (!s.io.readFile) return fail('Reading LiDAR files needs the desktop app.');
      const format = cmd.format ?? formatFromName(cmd.path);
      if (!format) return fail('Unknown point-cloud format: use PLY, OBJ, E57, LAS, XYZ, PTS or a survey CSV');
      s.progress?.('Reading the point cloud', 0, 1);
      const bytes = await s.io.readFile(cmd.path);
      const cloud = parsePointFile(bytes, format);
      const { cloud: shown, voxel } = downsampleTo(cloud, 200_000);
      s.progress?.('Estimating normals', 0, 1);
      const normals = format === 'csv' ? undefined : estimateNormals(shown.positions, 10);
      const idc = camNextId(doc, 'cloud');
      await s.store.put(idc.id, encodeCloud(shown, { ...(normals ? { normals } : {}), voxel }));
      const idr = camNextId(idc.doc, 'lidar');
      const name = cmd.name ?? cmd.path.split(/[\\/]/).pop() ?? 'LiDAR';
      const ref = {
        id: idr.id,
        name,
        path: cmd.path,
        format,
        units: cmd.units ?? 'm',
        up: cmd.up ?? 'z',
        survey: format === 'csv',
        points: cloud.count,
        displayPoints: shown.count,
        bbox: cloud.bbox,
        named: cloud.named.slice(0, 5000),
        cache: idc.id,
        at: s.now().toISOString(),
        by: s.actor,
      } as const;
      const next = { ...idr.doc, lidar: [...idr.doc.lidar, ref] };
      const summary = `${name}: ${cloud.count.toLocaleString('en')} points (${format.toUpperCase()}, ${ref.units}, ${ref.up.toUpperCase()}-up)${voxel ? `, shown as ${shown.count.toLocaleString('en')} (${(voxel * 1000).toFixed(0)} mm voxels)` : ''}${cloud.named.length ? `, ${cloud.named.length} named points` : ''}${cloud.notes.length ? ` — ${cloud.notes.join('; ')}` : ''}`;
      return ok(summary, { id: ref.id, points: cloud.count, displayPoints: shown.count, bbox: cloud.bbox, named: cloud.named.length }, [change(s, 'import_lidar', summary, next)]);
    }
    case 'remove_lidar': {
      const ref = doc.lidar.find((l) => l.id === cmd.id);
      if (!ref) return fail(`No LiDAR ${cmd.id}`);
      const next = { ...doc, lidar: doc.lidar.filter((l) => l.id !== cmd.id), correspondences: doc.correspondences.filter((c) => c.lidarId !== cmd.id), alignment: doc.alignment?.lidarId === cmd.id ? null : doc.alignment };
      const solved = await loadSolve(s);
      const c = withCoords(next, solved?.solve ?? null);
      const summary = `Removed ${ref.name}`;
      return ok(summary, { id: cmd.id }, [change(s, 'remove_lidar', summary, c.doc)]);
    }
    case 'add_correspondence': {
      const ref = doc.lidar.find((l) => l.id === cmd.lidarId);
      if (!ref) return fail(`No LiDAR ${cmd.lidarId}`);
      let target: Correspondence['target'];
      if (cmd.trackId !== undefined) target = { kind: 'track', trackId: cmd.trackId };
      else if (cmd.frame !== undefined && cmd.x !== undefined && cmd.y !== undefined) {
        // Snap to a track within 6 px on that frame when there is one.
        const td = await loadTracks(s);
        let best = -1;
        let bd = 6;
        if (td)
          for (let i = 0; i < td.ids.length; i += 1) {
            const p = trackAt(td, i, cmd.frame);
            if (!p) continue;
            const d = Math.hypot(p[0] - cmd.x, p[1] - cmd.y);
            if (d < bd) {
              bd = d;
              best = i;
            }
          }
        target = best >= 0 && td ? { kind: 'track', trackId: td.ids[best]! } : { kind: 'pixel', frame: cmd.frame, x: cmd.x, y: cmd.y };
      } else return fail('A correspondence needs a track id, or a frame and a pixel');
      const id = camNextId(doc, 'cp');
      const c: Correspondence = { id: id.id, name: cmd.name ?? `CP ${doc.correspondences.length + 1}`, lidarId: ref.id, point: cmd.point, target, residualPx: null, residualMm: null };
      const next = { ...id.doc, correspondences: [...id.doc.correspondences, c] };
      const summary = `${c.name}: (${cmd.point.map((v) => v.toFixed(3)).join(', ')}) in ${ref.name} ↔ ${target.kind === 'track' ? `track ${target.trackId}` : `pixel (${target.x.toFixed(1)}, ${target.y.toFixed(1)}) on ${target.frame}`}`;
      return ok(summary, { id: c.id, target }, [change(s, 'add_correspondence', summary, next)]);
    }
    case 'remove_correspondence': {
      const c = doc.correspondences.find((x) => x.id === cmd.id);
      if (!c) return fail(`No correspondence ${cmd.id}`);
      const summary = `Removed ${c.name}`;
      return ok(summary, { id: cmd.id }, [change(s, 'remove_correspondence', summary, { ...doc, correspondences: doc.correspondences.filter((x) => x.id !== cmd.id) })]);
    }
    case 'align_to_lidar': {
      const solved = await loadSolve(s);
      if (!solved) return fail('Solve the camera first.');
      const lidarId = cmd.lidarId ?? doc.alignment?.lidarId ?? doc.lidar[0]?.id;
      const ref = doc.lidar.find((l) => l.id === lidarId);
      if (!ref) return fail('Import a LiDAR scan or survey first.');
      if (cmd.method === 'constrained') return run(s, { verb: 'solve', useLidar: true });
      const td = await loadTracks(s);
      const byId = new Map(solved.solve.tracks.map((t) => [t.id, t]));
      const pairs = doc.correspondences.filter((c) => c.lidarId === ref.id && c.target.kind === 'track' && byId.get(c.target.trackId)?.X);
      let T: Similarity;
      let method: 'similarity' | 'icp' = 'similarity';
      let icpNote = '';
      if (cmd.method === 'similarity') {
        if (pairs.length < 3) return fail(`A similarity needs at least 3 correspondences to solved tracks (${pairs.length} so far)`);
        const src = pairs.flatMap((c) => byId.get((c.target as { trackId: number }).trackId)!.X!);
        const dst = pairs.flatMap((c) => c.point);
        const fit = robustSimilarity(src, dst);
        T = fit.T;
        if (fit.outliers.length) icpNote = `; ${fit.outliers.map((i) => pairs[i]!.name).join(', ')} disagree with the others and were left out of the fit (check those picks)`;
      } else {
        if (!doc.alignment || doc.alignment.solve !== solved.record.number) return fail('ICP refines an existing alignment: align by similarity (3+ correspondences) first.');
        const cache = await s.store.get(ref.cache);
        if (!cache) return fail('The LiDAR cache is missing; import the file again.');
        const cloud = decodeCloud(cache);
        if (!cloud.normals) return fail('Survey points have no surface for ICP.');
        // ICP in the cloud's cached frame (relative to its origin).
        const toCache: Similarity = { s: 1, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [-cloud.origin[0], -cloud.origin[1], -cloud.origin[2]] };
        const start = composeSim(toCache, simOf(doc.alignment.transform));
        const pts = solved.solve.tracks.filter((t) => t.X && t.inliers >= 3).flatMap((t) => t.X!);
        const ext = Math.hypot(cloud.bbox.max[0] - cloud.bbox.min[0], cloud.bbox.max[1] - cloud.bbox.min[1], cloud.bbox.max[2] - cloud.bbox.min[2]);
        const grid = new PointGrid(cloud.positions);
        const r = icpPointToPlane(pts, cloud.positions, cloud.normals, start, { maxDistance: ext * 0.02, iterations: 40, allowScale: true, grid });
        T = composeSim(invertSim(toCache), r.transform);
        method = 'icp';
        icpNote = `, ${r.pairs} track points within ${(ext * 0.02).toFixed(2)} ${ref.units} of the surface, ${r.iterations} iterations, RMS ${(r.rms * UNIT_METRES[ref.units] * 1000).toFixed(1)} mm to the surface`;
      }
      const corr = correspondenceResiduals(s, solved.solve, td, T, doc.correspondences);
      const mine = corr.filter((c) => c.lidarId === ref.id);
      const mm = mine.map((c) => c.residualMm).filter((v): v is number => v !== null);
      const pxs = mine.map((c) => c.residualPx).filter((v): v is number => v !== null);
      const rmsMm = mm.length ? Math.sqrt(mm.reduce((a, b) => a + b * b, 0) / mm.length) : null;
      const rmsPx = pxs.length ? Math.sqrt(pxs.reduce((a, b) => a + b * b, 0) / pxs.length) : null;
      // Confidence: enough correspondences, small residuals in pixels.
      const confidence = Math.max(0, Math.min(1, Math.min(1, mine.length / 6) * (rmsPx === null ? 0.6 : Math.max(0, 1.25 - rmsPx / 4))));
      const alignment = { method, solve: solved.record.number, lidarId: ref.id, transform: { s: T.s, R: [...T.R], t: [T.t[0]!, T.t[1]!, T.t[2]!] as [number, number, number] }, rmsMm, rmsPx, confidence, at: s.now().toISOString(), by: s.actor };
      let next: CamTrackDocument = { ...doc, alignment, correspondences: corr };
      const c = withCoords(next, solved.solve);
      next = c.doc;
      const summary = `${method === 'icp' ? 'ICP' : 'Similarity'} to ${ref.name}: scale ${T.s.toFixed(4)}, ${mine.length} correspondence${mine.length === 1 ? '' : 's'}, RMS ${rmsMm === null ? '—' : `${rmsMm.toFixed(1)} mm`} / ${rmsPx === null ? '—' : px(rmsPx)}${icpNote}; confidence ${(confidence * 100).toFixed(0)} %`;
      return ok(summary, { method, scale: T.s, rmsMm, rmsPx, confidence, correspondences: mine.map((x) => ({ id: x.id, residualPx: x.residualPx, residualMm: x.residualMm })) }, [change(s, 'align_to_lidar', summary, next)]);
    }
    case 'set_coordinate_system': {
      const coords = { ...doc.coords };
      if (cmd.units) coords.units = cmd.units;
      if (cmd.upAxis) coords.upAxis = cmd.upAxis;
      if (cmd.origin !== undefined) coords.origin = cmd.origin === null ? { kind: 'none' } : 'trackId' in cmd.origin ? { kind: 'track', trackId: cmd.origin.trackId } : { kind: 'point', point: cmd.origin.point };
      if (cmd.ground !== undefined) coords.ground = cmd.ground ? { trackIds: cmd.ground } : null;
      if (cmd.scale !== undefined) coords.scale = cmd.scale;
      const solved = await loadSolve(s);
      const c = withCoords({ ...doc, coords }, solved?.solve ?? null);
      if (c.error) return fail(c.error);
      const summary = `Scene: ${coords.units}, ${coords.upAxis.toUpperCase()}-up exports; ${c.notes.join('; ')}`;
      return ok(summary, { coords: c.doc.coords, notes: c.notes }, [change(s, 'set_coordinate_system', summary, c.doc)]);
    }
    case 'save_lens_profile': {
      const solved = await loadSolve(s);
      if (!solved) return fail('Solve first: the profile is the solve’s lens.');
      const k = solved.record.intrinsics;
      if (!k.focalMm) return fail('Set the camera’s film back first so the focal length is in millimetres.');
      const camera = doc.camera?.label ?? 'Camera';
      const id = (cmd.id ?? `${camera}-${doc.lens.name || 'lens'}-${Math.round(k.focalMm)}mm`).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'lens';
      const profile = { id, camera, cameraId: doc.camera?.cameraId ?? null, modeId: doc.camera?.modeId ?? null, lens: doc.lens.name, focalMm: Math.round(k.focalMm * 100) / 100, distortion: { k1: k.k1, k2: k.k2, k3: k.k3, p1: k.p1, p2: k.p2 }, squeeze: doc.lens.squeeze, measuredWidthPx: s.plate.width, source: 'solve' as const, rms: solved.record.stats.rms, notes: cmd.notes ?? `From ${s.name} solve ${solved.record.number}` };
      return ok(`Lens profile ${id}: ${profile.focalMm} mm, k1 ${k.k1.toFixed(5)} k2 ${k.k2.toFixed(5)}`, { profile }, [{ op: 'lens_profile', profile }, { op: 'note', command: 'save_lens_profile', summary: `Saved lens profile ${id}` }]);
    }

    // ----- export -----------------------------------------------------------
    case 'export_camera': {
      if (!s.io.writeExport) return fail('Available in the desktop app: exports are written into the shot package on disk.');
      const solved = await loadSolve(s);
      if (!solved) return fail('Solve first.');
      const formats = (cmd.formats?.length ? cmd.formats : [...CAMERA_EXPORT_FORMATS]).filter((f) => (CAMERA_EXPORT_FORMATS as readonly string[]).includes(f));
      const data = exportData(s, solved);
      const v = s.camtrackVersion;
      const file = (ext: string) => camtrackNames.file(s.name, v, ext);
      const stmaps = cmd.stmaps ?? true;
      const k: Intrinsics = { f: solved.solve.intrinsics.f, cx: solved.solve.intrinsics.cx, cy: solved.solve.intrinsics.cy, k1: solved.solve.intrinsics.k1, k2: solved.solve.intrinsics.k2, k3: solved.solve.intrinsics.k3, p1: solved.solve.intrinsics.p1, p2: solved.solve.intrinsics.p2 };
      const hasLens = k.k1 !== 0 || k.k2 !== 0 || k.k3 !== 0 || k.p1 !== 0 || k.p2 !== 0;
      data.files = { obj: file('_points.obj'), ...(stmaps && hasLens ? { undistort: file('_undistort.exr'), redistort: file('_redistort.exr') } : {}) };
      const files: { name: string; data: Uint8Array | string }[] = [];
      const writers: Record<CameraExportFormat, () => void> = {
        nuke: () => files.push({ name: file('.nk'), data: writeNuke(data) }),
        maya: () => files.push({ name: file('.ma'), data: writeMaya(data) }),
        blender: () => files.push({ name: file('.py'), data: writeBlender(data) }),
        ae: () => files.push({ name: file('.jsx'), data: writeAfterEffects(data) }),
        usd: () => files.push({ name: file('.usda'), data: writeUsda(data) }),
        unreal: () => files.push({ name: file('_unreal.py'), data: writeUnreal(data) }),
        unity: () => files.push({ name: file('_Unity.cs'), data: writeUnity(data) }),
        houdini: () => files.push({ name: file('_houdini.py'), data: writeHoudini(data) }),
        fusion: () => files.push({ name: file('_fusion.setting'), data: writeFusionSetting(data) }, { name: file('_fusion.comp'), data: writeFusionComp(data) }),
        max: () => files.push({ name: file('.ms'), data: writeMax(data) }),
        fbx: () => files.push({ name: file('.fbx'), data: writeFbx(data) }),
        chan: () => files.push({ name: file('.chan'), data: writeChan(data) }),
        json: () => {},
        obj: () => files.push({ name: data.files.obj, data: writePointsObj(data) }),
      };
      for (const f of formats) writers[f]();
      if (!formats.includes('obj') && (formats.includes('nuke') || formats.includes('maya'))) files.push({ name: data.files.obj, data: writePointsObj(data) });
      if (data.files.undistort && data.files.redistort) {
        s.progress?.('Writing lens STMaps', 0, 2);
        files.push({ name: data.files.undistort, data: stmapExr(undistortMap(k, s.plate.width, s.plate.height)) });
        s.progress?.('Writing lens STMaps', 1, 2);
        files.push({ name: data.files.redistort, data: stmapExr(redistortMap(k, s.plate.width, s.plate.height)) });
      }
      const meta = { camera: doc.camera, lens: doc.lens, solve: solved.record, coords: doc.coords, alignment: doc.alignment, correspondences: doc.correspondences, lidar: doc.lidar.map((l) => ({ name: l.name, path: l.path, format: l.format, units: l.units, up: l.up })) };
      files.push({ name: file('.json'), data: writeCameraJson(data, { vcvfx: meta }) });
      files.push({ name: file('_report.html'), data: reportHtml(s, solved, data, files.map((f) => f.name)) });
      files.push({ name: file('_README.txt'), data: writeExportReadme(data, files.map((f) => f.name)) });
      const written = await s.io.writeExport({ section: '06_CAMERA_TRACK', name: camtrackNames.folder(s.name, v) }, files);
      const record: CamExport = { version: v, solve: solved.record.number, folder: written.folder, files: written.files, formats: [...new Set([...formats, 'json' as const])], stmaps: Boolean(data.files.undistort), writtenAt: s.now().toISOString(), by: s.actor };
      const next = { ...doc, exports: [...doc.exports.filter((e) => e.version !== v), record].sort((a, b) => a.version - b.version) };
      const summary = `${versionTag(v)} of solve ${solved.record.number}: ${record.formats.join(', ')}${record.stmaps ? ' + STMaps' : ''} → ${written.folder} (${written.files.length} files)`;
      return ok(summary, { folder: written.folder, files: written.files }, [change(s, 'export', summary, next, 'review')]);
    }

    // ----- 2D tracks --------------------------------------------------------
    case 'track2d_create':
      return ok(`Created ${cmd.kind} track ${cmd.name} on ${cmd.frame}`, {}, [{ op: 'track2d_create', input: { name: cmd.name, kind: cmd.kind, frame: cmd.frame, points: cmd.points } }]);
    case 'track2d_set_key':
      return ok(`Key on ${cmd.frame}`, {}, [{ op: 'track2d_key', trackId: cmd.trackId, frame: cmd.frame, points: cmd.points }]);
    case 'track2d_remove_key':
      return ok(`Key ${cmd.frame} removed`, {}, [{ op: 'track2d_remove_key', trackId: cmd.trackId, frame: cmd.frame }]);
    case 'track2d_update': {
      const { verb: _v, trackId, ...change2 } = cmd;
      return ok(`Updated ${trackId}`, {}, [{ op: 'track2d_update', trackId, change: change2 }]);
    }
    case 'track2d_delete':
      return ok(`Deleted ${cmd.trackId}`, {}, [{ op: 'track2d_delete', trackId: cmd.trackId }]);
    case 'track2d_track':
      return track2dRun(s, cmd);
    case 'track2d_export':
      return track2dExport(s, cmd);
  }
}

/**
 * Similarity from correspondences, robust to a wrong pick: with five or more,
 * every triple (up to 300) is tried and the fit with the most correspondences
 * within 3 % of their spread wins, then is refitted on those.
 */
export function robustSimilarity(src: number[], dst: number[]): { T: Similarity; outliers: number[] } {
  const n = src.length / 3;
  const all = umeyama(src, dst);
  if (n < 5) return { T: { s: all.s, R: all.R, t: all.t }, outliers: [] };
  let spread = 0;
  const c = [0, 1, 2].map((k) => dst.filter((_, i) => i % 3 === k).reduce((a, b) => a + b, 0) / n);
  for (let i = 0; i < n; i += 1) spread = Math.max(spread, Math.hypot(dst[3 * i]! - c[0]!, dst[3 * i + 1]! - c[1]!, dst[3 * i + 2]! - c[2]!));
  const th = 0.03 * spread;
  const residual = (T: Similarity, i: number) => {
    const p = applySim(T, src.slice(3 * i, 3 * i + 3));
    return Math.hypot(p[0]! - dst[3 * i]!, p[1]! - dst[3 * i + 1]!, p[2]! - dst[3 * i + 2]!);
  };
  let best: number[] = [];
  let tries = 0;
  for (let a = 0; a < n && tries < 300; a += 1)
    for (let b = a + 1; b < n && tries < 300; b += 1)
      for (let d = b + 1; d < n && tries < 300; d += 1, tries += 1) {
        try {
          const u = umeyama([...src.slice(3 * a, 3 * a + 3), ...src.slice(3 * b, 3 * b + 3), ...src.slice(3 * d, 3 * d + 3)], [...dst.slice(3 * a, 3 * a + 3), ...dst.slice(3 * b, 3 * b + 3), ...dst.slice(3 * d, 3 * d + 3)]);
          const inl = Array.from({ length: n }, (_, i) => i).filter((i) => residual(u, i) < th);
          if (inl.length > best.length) best = inl;
        } catch {
          // a degenerate triple
        }
      }
  if (best.length < 3 || best.length === n) return { T: { s: all.s, R: all.R, t: all.t }, outliers: [] };
  const u = umeyama(best.flatMap((i) => src.slice(3 * i, 3 * i + 3)), best.flatMap((i) => dst.slice(3 * i, 3 * i + 3)));
  const keep = new Set(best);
  return { T: { s: u.s, R: u.R, t: u.t }, outliers: Array.from({ length: n }, (_, i) => i).filter((i) => !keep.has(i)) };
}

/** Join forward and backward runs of features detected on the same frame (same order of detection). */
function joinAtFrame(fwd: TrackData, bwd: TrackData, f: number): TrackData {
  // Pair by position on frame f (both detected there with the same settings).
  const key = (t: TrackData, i: number) => {
    const p = trackAt(t, i, f);
    return p ? `${Math.round(p[0] * 4)},${Math.round(p[1] * 4)}` : '';
  };
  const back = new Map<string, number>();
  for (let i = 0; i < bwd.ids.length; i += 1) back.set(key(bwd, i), i);
  const used = new Set<number>();
  const out: { start: number; xy: number[]; id: number }[] = [];
  for (let i = 0; i < fwd.ids.length; i += 1) {
    const j = back.get(key(fwd, i));
    const fo = fwd.offset[i]! * 2;
    const fxy = Array.from(fwd.xy.subarray(fo, fo + fwd.length[i]! * 2));
    if (j === undefined) {
      out.push({ start: fwd.start[i]!, xy: fxy, id: fwd.ids[i]! });
      continue;
    }
    used.add(j);
    const bo = bwd.offset[j]! * 2;
    const bxy = Array.from(bwd.xy.subarray(bo, bo + bwd.length[j]! * 2));
    // bwd is stored forward, ending on f; drop its last position (= f).
    out.push({ start: bwd.start[j]!, xy: [...bxy.slice(0, -2), ...fxy], id: fwd.ids[i]! });
  }
  for (let j = 0; j < bwd.ids.length; j += 1) {
    if (used.has(j)) continue;
    const bo = bwd.offset[j]! * 2;
    out.push({ start: bwd.start[j]!, xy: Array.from(bwd.xy.subarray(bo, bo + bwd.length[j]! * 2)), id: bwd.ids[j]! });
  }
  const ids = new Int32Array(out.length);
  const start = new Int32Array(out.length);
  const length = new Int32Array(out.length);
  const offset = new Int32Array(out.length);
  let total = 0;
  out.sort((a, b) => a.id - b.id).forEach((t, i) => {
    ids[i] = t.id;
    start[i] = t.start;
    length[i] = t.xy.length / 2;
    offset[i] = total;
    total += t.xy.length / 2;
  });
  const xy = new Float32Array(total * 2);
  out.forEach((t, i) => xy.set(t.xy, offset[i]! * 2));
  return { width: fwd.width, height: fwd.height, first: fwd.first, last: fwd.last, ids, start, length, offset, xy, nextId: Math.max(fwd.nextId, bwd.nextId), manual: new Uint8Array(out.length) };
}

/** The scene cameras and points for the exporters. */
export function exportData(s: CameraSession, solved: { record: SolveRecord; solve: SolveResult }): CameraExportData {
  const doc = s.camtrack;
  const T = simOf(doc.coords.transform);
  const fb = filmBackOf(doc);
  const k = solved.solve.intrinsics;
  const cameras = sceneCameras(solved.solve, T);
  const points = solved.solve.tracks.filter((t) => t.X && t.inliers >= 2).map((t) => ({ id: t.id, position: applySim(T, t.X!) as [number, number, number], error: t.rms }));
  return {
    shot: s.name,
    version: s.camtrackVersion,
    generator: s.generator,
    writtenAt: s.now().toISOString(),
    fps: s.fps,
    width: s.plate.width,
    height: s.plate.height,
    filmBackMm: { width: fb.width, height: fb.height },
    nominalFilmBack: fb.nominal,
    focalMm: focalMillimetres(k.f, fb.width, s.plate.width),
    focalPx: k.f,
    principalOffsetPx: { x: k.cx - (s.plate.width - 1) / 2, y: k.cy - (s.plate.height - 1) / 2 },
    distortion: { k1: k.k1, k2: k.k2, k3: k.k3, p1: k.p1, p2: k.p2 },
    units: doc.coords.units,
    upAxis: doc.coords.upAxis,
    cameras,
    points,
    solve: { number: solved.record.number, rms: solved.record.stats.rms, frames: solved.record.stats.framesSolved, engine: `${solved.record.engine.id}@${solved.record.engine.version}`, nodal: solved.record.stats.nodal, confidence: solved.record.stats.confidence, warnings: solved.record.stats.warnings },
    files: { obj: '' },
  };
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function reportHtml(s: CameraSession, solved: { record: SolveRecord; solve: SolveResult }, d: CameraExportData, files: string[]): string {
  const r = solved.record;
  const doc = s.camtrack;
  const rows = solved.solve.frames.map((f) => `<tr><td>${f.frame}</td><td>${f.solved ? 'yes' : 'no'}</td><td>${f.keyframe ? '◆' : ''}</td><td>${f.rms.toFixed(3)}</td><td>${f.tracks}</td></tr>`).join('');
  const maxRms = Math.max(0.5, ...solved.solve.frames.map((f) => f.rms));
  const bars = solved.solve.frames.map((f, i) => `<rect x="${i * 4}" y="${100 - (f.rms / maxRms) * 100}" width="3" height="${(f.rms / maxRms) * 100}" fill="${f.rms > 1.5 ? '#d33' : f.rms > 0.8 ? '#e90' : '#3a7'}"/>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(s.name)} camera track ${versionTag(s.camtrackVersion)}</title>
<style>body{font:14px system-ui,sans-serif;margin:24px;color:#222}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:2px 8px;text-align:right}h1{font-size:20px}.warn{color:#a40}</style></head><body>
<h1>${esc(s.name)} — camera track ${versionTag(s.camtrackVersion)} (solve ${r.number})</h1>
<p>Written by ${esc(s.generator)} at ${esc(d.writtenAt)} by ${esc(s.actor)}. ${r.engine.id}@${r.engine.version}.</p>
<p><b>RMS reprojection error ${r.stats.rms.toFixed(3)} px</b> (median ${r.stats.medianError.toFixed(3)} px) over ${r.stats.framesSolved} of ${r.stats.framesTotal} frames, ${r.stats.tracksUsed} of ${r.stats.tracksTotal} tracks, ${r.stats.keyframes} keyframes${r.stats.nodal ? ', <b>nodal</b>' : ''}. Confidence ${(r.stats.confidence * 100).toFixed(0)} %.</p>
${r.stats.warnings.map((w) => `<p class="warn">⚠ ${esc(w)}</p>`).join('')}
<p>Camera: ${esc(doc.camera?.label ?? 'not set (nominal 36 mm film back)')}${doc.camera && !doc.camera.verified ? ' — film back not verified against the manufacturer' : ''}. Film back ${d.filmBackMm.width} × ${(d.filmBackMm.width * d.height / d.width).toFixed(3)} mm over ${d.width} × ${d.height} px.</p>
<p>Lens: ${esc(doc.lens.name || '—')}; focal ${d.focalMm.toFixed(3)} mm (${d.focalPx.toFixed(2)} px; ${doc.lens.focalMode}). Distortion (OpenCV Brown–Conrady, normalised by the focal length): k1 ${d.distortion.k1.toFixed(6)}, k2 ${d.distortion.k2.toFixed(6)}, k3 ${d.distortion.k3.toFixed(6)}, p1 ${d.distortion.p1.toFixed(6)}, p2 ${d.distortion.p2.toFixed(6)}.</p>
<p>Scene: ${d.units}, exports ${d.upAxis.toUpperCase()}-up where generic. ${doc.alignment ? `Aligned to ${esc(doc.lidar.find((l) => l.id === doc.alignment!.lidarId)?.name ?? 'LiDAR')} by ${doc.alignment.method}: RMS ${doc.alignment.rmsMm?.toFixed(1) ?? '—'} mm / ${doc.alignment.rmsPx?.toFixed(2) ?? '—'} px, confidence ${(doc.alignment.confidence * 100).toFixed(0)} %.` : 'Not aligned to LiDAR.'}</p>
<svg width="${solved.solve.frames.length * 4}" height="100" style="background:#f6f6f6">${bars}</svg>
<p>Files: ${files.map(esc).join(', ')}</p>
<table><tr><th>Frame</th><th>Solved</th><th>Key</th><th>RMS px</th><th>Tracks</th></tr>${rows}</table>
<p>The solve is an automated result: it is a suggestion until a named person approves the camera-track task.</p>
</body></html>
`;
}

// ---------------------------------------------------------------------------
// 2D tracking runs and exports
// ---------------------------------------------------------------------------

async function track2dRun(s: CameraSession, cmd: Extract<CameraCommand, { verb: 'track2d_track' }>): Promise<CommandOutcome> {
  const t = s.track2d.tracks.find((x) => x.id === cmd.trackId);
  if (!t) return fail(`No 2D track ${cmd.trackId}`);
  const key = t.keys.find((k) => k.frame === cmd.from);
  if (!key) return fail(`Frame ${cmd.from} is not a key frame of ${t.name}`);
  const kx = s.working.width / s.plate.width;
  const ky = s.working.height / s.plate.height;
  const toW = (p: readonly [number, number]): [number, number] => [(p[0] + 0.5) * kx - 0.5, (p[1] + 0.5) * ky - 0.5];
  const toP = (p: readonly [number, number]): [number, number] => [(p[0] + 0.5) / kx - 0.5, (p[1] + 0.5) / ky - 0.5];
  const occl = t.occluders.length && s.io.rotoMask ? (f: number) => s.io.rotoMask!(t.occluders, f) : undefined;
  const io = { frame: (f: number) => s.io.frame(f), ...(occl ? { occlusion: occl } : {}) };
  const ctx = { ...(s.signal ? { signal: s.signal } : {}), progress: (d: number, n: number) => s.progress?.(`Tracking ${t.name}`, d, n), ...(s.yieldNow ? { yieldNow: s.yieldNow } : {}) };
  type Step = { frame: number; points: [number, number][]; confidence: number; status: 'tracked' | 'lost' };
  const runFrom = async (k: { frame: number; points: [number, number][] }, frames: number[]): Promise<Step[]> => {
    if (!frames.length) return [];
    if (t.kind === 'planar') {
      const steps = await trackPlanar(io, { frame: k.frame, corners: k.points.map(toW) as Quad }, frames, ctx);
      return steps.map((x) => ({ frame: x.frame, points: x.corners.map(toP), confidence: x.confidence, status: x.status }));
    }
    const steps = await trackPoint(io, { frame: k.frame, point: toW(k.points[0]!) }, frames, { pattern: t.pattern * kx, search: t.search * kx }, ctx);
    return steps.map((x) => ({ frame: x.frame, points: [toP(x.point)], confidence: x.confidence, status: x.status }));
  };
  const range = (a: number, b: number) => {
    const out: number[] = [];
    if (a <= b) for (let f = a; f <= b; f += 1) out.push(f);
    else for (let f = a; f >= b; f -= 1) out.push(f);
    return out;
  };
  const span = track2dSpan(t, cmd.from, s.first, s.last);
  const keyOf = (f: number) => t.keys.find((k) => k.frame === f);
  let frames: Step[] = [];
  if (cmd.direction === 'forward') frames = await runFrom(key, range(cmd.from + 1, keyOf(span.next) ? span.next - 1 : s.last));
  else if (cmd.direction === 'backward') frames = await runFrom(key, range(cmd.from - 1, keyOf(span.previous) ? span.previous + 1 : s.first));
  else {
    // Around: both intervals to the neighbouring keys, each tracked from both ends and blended.
    const prevKey = keyOf(span.previous);
    const nextKey = keyOf(span.next);
    const left = prevKey ? blendRuns(await runFrom(prevKey, range(span.previous + 1, cmd.from - 1)), await runFrom(key, range(cmd.from - 1, span.previous + 1)), span.previous, cmd.from) : await runFrom(key, range(cmd.from - 1, s.first));
    const right = nextKey ? blendRuns(await runFrom(key, range(cmd.from + 1, span.next - 1)), await runFrom(nextKey, range(span.next - 1, cmd.from + 1)), cmd.from, span.next) : await runFrom(key, range(cmd.from + 1, s.last));
    frames = [...left, ...right];
  }
  const recorded: Track2dFrame[] = frames.map((f) => ({ frame: f.frame, points: f.points, confidence: f.confidence, status: f.status }));
  const lost = recorded.filter((f) => f.status === 'lost').length;
  const mean = recorded.length ? recorded.reduce((a, b) => a + b.confidence, 0) / recorded.length : 0;
  const engine = `${t.kind === 'planar' ? 'planar' : 'point'}@${PLANAR_VERSION}`;
  const summary = `${t.name}: ${recorded.length} frames ${cmd.direction} from ${cmd.from}, confidence mean ${mean.toFixed(2)}${lost ? `, ${lost} lost` : ''}`;
  return ok(summary, { frames: recorded.length, lost, meanConfidence: mean, first: recorded[0]?.frame ?? null, last: recorded[recorded.length - 1]?.frame ?? null }, [{ op: 'track2d_run', trackId: t.id, run: { frames: recorded, engine, from: cmd.from, direction: cmd.direction } }]);
}

async function track2dExport(s: CameraSession, cmd: Extract<CameraCommand, { verb: 'track2d_export' }>): Promise<CommandOutcome> {
  if (!s.io.writeExport) return fail('Available in the desktop app: track data is written into the shot package on disk.');
  const tracks = s.track2d.tracks.filter((t) => !cmd.trackIds || cmd.trackIds.includes(t.id));
  if (!tracks.length) return fail('There are no 2D tracks to export.');
  const formats = cmd.formats?.length ? cmd.formats : [...TRACK2D_EXPORT_FORMATS];
  const v = s.track2dVersion;
  const files: { name: string; data: string }[] = [];
  for (const t of tracks) {
    const info = { shot: s.name, version: v, generator: s.generator, fps: s.fps, width: s.plate.width, height: s.plate.height, first: s.first, writtenAt: s.now().toISOString() };
    if (formats.includes('nuke')) files.push({ name: track2dNames.file(s.name, v, t.id, '.nk'), data: writeNukeCornerPin(t, info) });
    if (formats.includes('ae')) files.push({ name: track2dNames.file(s.name, v, t.id, '.jsx'), data: writeCornerPinJsx(t, info) });
    if (formats.includes('mocha')) files.push({ name: track2dNames.file(s.name, v, t.id, '_ae_keyframes.txt'), data: writeMochaText(t, info) });
    if (formats.includes('json')) files.push({ name: track2dNames.file(s.name, v, t.id, '.json'), data: writeTrack2dJson(t, info) });
  }
  const written = await s.io.writeExport({ section: '05_TRACKS_2D', name: track2dNames.folder(s.name, v) }, files);
  const record = { version: v, folder: written.folder, files: written.files, tracks: tracks.map((t) => t.id), formats };
  return ok(`${versionTag(v)}: ${tracks.map((t) => t.name).join(', ')} → ${written.folder} (${written.files.length} files)`, { folder: written.folder, files: written.files }, [{ op: 'track2d_export', record }]);
}

// ---------------------------------------------------------------------------
// Applying a command's ops to the project (renderer side)
// ---------------------------------------------------------------------------

/** Apply a command's project changes in order; stops at the first refusal. */
export function applyOps(p: Project, shotId: string, ops: readonly ProjectOp[], actor: string, now: Date): Result {
  let project = p;
  for (const o of ops) {
    let r: Result;
    switch (o.op) {
      case 'camtrack':
        r = applyCamTrack(project, shotId, o.change, actor, now);
        break;
      case 'note':
        r = { ok: true, project: { ...project, updatedAt: now.toISOString(), log: [...project.log, { at: now.toISOString(), actor, shotId, action: `camtrack.${o.command}`, detail: o.summary }] } };
        break;
      case 'lens_profile':
        r = saveLensProfile(project, o.profile, actor, now);
        break;
      case 'custom_camera':
        r = addCustomCamera(project, o.camera, actor, now);
        break;
      case 'track2d_create':
        r = createTrack2d(project, shotId, o.input, actor, now);
        break;
      case 'track2d_key':
        r = setTrack2dKey(project, shotId, o.trackId, o.frame, o.points, actor, now);
        break;
      case 'track2d_remove_key':
        r = removeTrack2dKey(project, shotId, o.trackId, o.frame, actor, now);
        break;
      case 'track2d_run':
        r = recordTrack2dRun(project, shotId, o.trackId, o.run, actor, now);
        break;
      case 'track2d_update':
        r = updateTrack2d(project, shotId, o.trackId, o.change, actor, now);
        break;
      case 'track2d_delete':
        r = removeTrack2d(project, shotId, o.trackId, actor, now);
        break;
      case 'track2d_export':
        r = recordTrack2dExport(project, shotId, o.record, actor, now);
        break;
    }
    if (!r.ok) return r;
    project = r.project;
  }
  return { ok: true, project };
}

export { unitScale, centreOf };
