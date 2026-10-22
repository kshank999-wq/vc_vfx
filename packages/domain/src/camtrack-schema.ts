import { z } from 'zod';
import { DistortionSchema, FilmBackSchema } from './camera-db.js';

/**
 * The camera-track and 2D-track documents a shot carries in the project file
 * (master spec §9, §10; addendum 06). Kept apart from `camtrack.ts` so
 * `project.ts` can embed the schemas without importing the mutations.
 *
 * What lives here is small: the operator's choices (camera, lens, masks,
 * coordinate system), summaries of each solve, the LiDAR references and the
 * correspondences, the exports. The big data — feature tracks per frame, the
 * solved camera per frame, point-cloud caches — are files beside the project
 * (the app's track cache), referenced here by id.
 */

export const CAMTRACK_FORMAT_VERSION = 1;
export const SCENE_UNITS = ['m', 'cm', 'mm', 'ft', 'in'] as const;
export type SceneUnit = (typeof SCENE_UNITS)[number];
/** Metres per unit. */
export const UNIT_METRES: Record<SceneUnit, number> = { m: 1, cm: 0.01, mm: 0.001, ft: 0.3048, in: 0.0254 };
export const UP_AXES = ['y', 'z'] as const;
export type UpAxis = (typeof UP_AXES)[number];

const Vec3 = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
const Mat3 = z.array(z.number().finite()).length(9);

export const SimilaritySchema = z.object({ s: z.number().positive(), R: Mat3, t: Vec3 });
export type SimilarityRecord = z.infer<typeof SimilaritySchema>;
export const IDENTITY_SIMILARITY: SimilarityRecord = { s: 1, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };

export const CameraSelectionSchema = z.object({
  /** handoff: matched from the handoff's camera text; database: chosen; custom: a project camera; manual: film back typed in. */
  source: z.enum(['handoff', 'database', 'custom', 'manual']),
  cameraId: z.string().nullable(),
  modeId: z.string().nullable(),
  label: z.string(),
  filmBackMm: FilmBackSchema,
  /** The mode's pixel size; the plate maps onto the whole film back. */
  sensorPx: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).nullable().default(null),
  verified: z.boolean().default(false),
  note: z.string().default(''),
  /** The handoff's camera text this was matched from (body · sensor mode), when it was. */
  handoffText: z.string().nullable().default(null),
});
export type CameraSelection = z.infer<typeof CameraSelectionSchema>;

export const LensSettingsSchema = z.object({
  name: z.string().default(''),
  focalMm: z.number().positive().nullable().default(null),
  /** known: hold (unless refine.focal); approx: a start the solve refines; unknown: self-calibrated. */
  focalMode: z.enum(['known', 'approx', 'unknown']).default('unknown'),
  profileId: z.string().nullable().default(null),
  distortion: DistortionSchema.default({}),
  squeeze: z.number().positive().default(1),
  refine: z
    .object({ focal: z.boolean().default(false), k1k2: z.boolean().default(false), k3: z.boolean().default(false), p1p2: z.boolean().default(false) })
    .default({}),
});
export type LensSettings = z.infer<typeof LensSettingsSchema>;

export const RectSchema = z.object({ x0: z.number(), y0: z.number(), x1: z.number(), y1: z.number() });

export const MaskSettingsSchema = z.object({
  /** Roto parts whose mattes are excluded from tracking (moving objects). */
  excludeRotoParts: z.array(z.string()).default([]),
  /** Rectangles in plate pixels: include restricts detection, exclude removes it. On every frame. */
  rects: z.array(RectSchema.extend({ mode: z.enum(['include', 'exclude']) })).max(64).default([]),
});
export type MaskSettings = z.infer<typeof MaskSettingsSchema>;

export const TrackSettingsSchema = z.object({
  maxFeatures: z.number().int().min(20).max(5000).default(500),
  /** Longest edge the tracker works at. */
  workingWidth: z.number().int().min(256).max(8192).default(1920),
  minDistance: z.number().min(0).max(200).default(0),
  quality: z.number().min(0.0001).max(0.5).default(0.01),
  fbThreshold: z.number().min(0.05).max(5).default(0.5),
});
export type TrackSettings = z.infer<typeof TrackSettingsSchema>;

export const TrackSetSchema = z.object({
  /** The file id in the track cache. */
  file: z.string().min(1),
  tracks: z.number().int().nonnegative(),
  observations: z.number().int().nonnegative(),
  meanLength: z.number().nonnegative(),
  minPerFrame: z.number().int().nonnegative(),
  medianPerFrame: z.number().nonnegative(),
  first: z.number().int(),
  last: z.number().int(),
  engine: z.string(),
  /** Tracks deleted by hand or by criteria since detection. */
  deleted: z.number().int().nonnegative().default(0),
  at: z.string(),
  by: z.string(),
});
export type TrackSet = z.infer<typeof TrackSetSchema>;

export const SolveStatsSchema = z.object({
  rms: z.number().nonnegative(),
  medianError: z.number().nonnegative(),
  framesSolved: z.number().int().nonnegative(),
  framesTotal: z.number().int().nonnegative(),
  tracksUsed: z.number().int().nonnegative(),
  tracksTotal: z.number().int().nonnegative(),
  keyframes: z.number().int().nonnegative(),
  nodal: z.boolean(),
  confidence: z.number().min(0).max(1),
  minTracksPerFrame: z.number().int().nonnegative(),
  warnings: z.array(z.string()).default([]),
  ms: z.number().nonnegative().default(0),
});
export type SolveStats = z.infer<typeof SolveStatsSchema>;

export const SolveRecordSchema = z.object({
  /** Solve number within the shot (1, 2, …). */
  number: z.number().int().positive(),
  taskVersion: z.number().int().positive(),
  /** The solve file id in the track cache. */
  file: z.string().min(1),
  /** The track set file it was solved from. */
  tracks: z.string().min(1),
  engine: z.object({ id: z.string(), version: z.string() }),
  settings: z.record(z.union([z.number(), z.string(), z.boolean(), z.null()])).default({}),
  intrinsics: z.object({
    focalPx: z.number().positive(),
    focalMm: z.number().positive().nullable(),
    cx: z.number(),
    cy: z.number(),
    k1: z.number(),
    k2: z.number(),
    k3: z.number(),
    p1: z.number(),
    p2: z.number(),
    /**
     * The pixel aspect the solve was made at (addendum 17). `focalPx` is the
     * vertical focal in plate pixels (= the focal in de-squeezed pixels); the
     * horizontal focal in plate pixels is focalPx / pixelAspect. 1 for solves
     * made before pixel aspect was modelled.
     */
    pixelAspect: z.number().positive().default(1),
  }),
  stats: SolveStatsSchema,
  /** How the solve was tied to survey/LiDAR data, if at all. */
  constraint: z.enum(['none', 'lidar_points']).default('none'),
  at: z.string(),
  by: z.string(),
});
export type SolveRecord = z.infer<typeof SolveRecordSchema>;

export const LIDAR_FORMATS = ['ply', 'obj', 'e57', 'las', 'xyz', 'pts', 'csv'] as const;
export type LidarFormat = (typeof LIDAR_FORMATS)[number];

export const LidarRefSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  name: z.string().min(1),
  /** As chosen: absolute, or relative to the handoff. Read only, never written. */
  path: z.string(),
  format: z.enum(LIDAR_FORMATS),
  /** Units the file's coordinates are in. */
  units: z.enum(SCENE_UNITS).default('m'),
  /** The file's up axis (scans are usually Z-up). */
  up: z.enum(UP_AXES).default('z'),
  /** Survey points (CSV) rather than a scan. */
  survey: z.boolean().default(false),
  points: z.number().int().nonnegative(),
  displayPoints: z.number().int().nonnegative(),
  bbox: z.object({ min: Vec3, max: Vec3 }),
  /** Named points (survey CSV), in file coordinates. */
  named: z.array(z.object({ name: z.string(), X: Vec3 })).max(5000).default([]),
  /** The downsampled cache file id. */
  cache: z.string().min(1),
  at: z.string(),
  by: z.string(),
});
export type LidarRef = z.infer<typeof LidarRefSchema>;

export const CorrespondenceSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  name: z.string().default(''),
  lidarId: z.string(),
  /** In the LiDAR file's coordinates and units. */
  point: Vec3,
  target: z.union([z.object({ kind: z.literal('track'), trackId: z.number().int() }), z.object({ kind: z.literal('pixel'), frame: z.number().int(), x: z.number(), y: z.number() })]),
  /** After the last alignment: reprojection error (pixels, mean over the frames it is seen on) and 3D distance (mm). */
  residualPx: z.number().nonnegative().nullable().default(null),
  residualMm: z.number().nonnegative().nullable().default(null),
});
export type Correspondence = z.infer<typeof CorrespondenceSchema>;

export const AlignmentSchema = z.object({
  method: z.enum(['similarity', 'constrained', 'icp']),
  solve: z.number().int().positive(),
  lidarId: z.string(),
  /** Solve world → LiDAR coordinates. */
  transform: SimilaritySchema,
  rmsMm: z.number().nonnegative().nullable(),
  rmsPx: z.number().nonnegative().nullable(),
  confidence: z.number().min(0).max(1),
  at: z.string(),
  by: z.string(),
});
export type Alignment = z.infer<typeof AlignmentSchema>;

/**
 * The scene coordinate system. Internally the scene is Y-up; `upAxis` is the
 * up axis written into the generic exports (JSON, .chan, OBJ, FBX). Exports
 * for a particular application always use that application's own up axis
 * (Blender and 3ds Max Z-up; Nuke, Maya and After Effects Y-up).
 */
export const CoordSystemSchema = z.object({
  units: z.enum(SCENE_UNITS).default('m'),
  upAxis: z.enum(UP_AXES).default('y'),
  origin: z.union([z.object({ kind: z.literal('none') }), z.object({ kind: z.literal('track'), trackId: z.number().int() }), z.object({ kind: z.literal('point'), point: Vec3 })]).default({ kind: 'none' }),
  ground: z.object({ trackIds: z.tuple([z.number().int(), z.number().int(), z.number().int()]) }).nullable().default(null),
  scale: z.object({ trackIds: z.tuple([z.number().int(), z.number().int()]), distance: z.number().positive() }).nullable().default(null),
  /**
   * Solve world (after any LiDAR alignment) → scene, Y-up or Z-up per
   * `upAxis`, in `units`. Recomputed whenever the inputs above change.
   */
  transform: SimilaritySchema.default(IDENTITY_SIMILARITY),
});
export type CoordSystem = z.infer<typeof CoordSystemSchema>;

export const CAMERA_EXPORT_FORMATS = ['nuke', 'maya', 'blender', 'ae', 'usd', 'unreal', 'unity', 'houdini', 'fusion', 'max', 'fbx', 'chan', 'json', 'obj'] as const;
export type CameraExportFormat = (typeof CAMERA_EXPORT_FORMATS)[number];

export const CamExportSchema = z.object({
  version: z.number().int().positive(),
  solve: z.number().int().positive(),
  folder: z.string(),
  files: z.array(z.string()),
  formats: z.array(z.enum(CAMERA_EXPORT_FORMATS)),
  stmaps: z.boolean().default(false),
  writtenAt: z.string(),
  by: z.string(),
});
export type CamExport = z.infer<typeof CamExportSchema>;
export type CamExportInput = Omit<CamExport, 'writtenAt' | 'by'>;

export const CamTrackDocumentSchema = z.object({
  formatVersion: z.literal(CAMTRACK_FORMAT_VERSION).default(CAMTRACK_FORMAT_VERSION),
  camera: CameraSelectionSchema.nullable().default(null),
  lens: LensSettingsSchema.default({}),
  trackSettings: TrackSettingsSchema.default({}),
  masks: MaskSettingsSchema.default({}),
  trackSet: TrackSetSchema.nullable().default(null),
  solves: z.array(SolveRecordSchema).default([]),
  activeSolve: z.number().int().positive().nullable().default(null),
  lidar: z.array(LidarRefSchema).max(16).default([]),
  correspondences: z.array(CorrespondenceSchema).max(500).default([]),
  alignment: AlignmentSchema.nullable().default(null),
  coords: CoordSystemSchema.default({}),
  exports: z.array(CamExportSchema).default([]),
  /** Source of file and record ids. */
  seq: z.number().int().nonnegative().default(0),
});
export type CamTrackDocument = z.infer<typeof CamTrackDocumentSchema>;

// ---------------------------------------------------------------------------
// 2D / planar tracks (§9)
// ---------------------------------------------------------------------------

const Point2 = z.tuple([z.number().finite(), z.number().finite()]);

export const TRACK2D_KINDS = ['planar', 'point'] as const;
export type Track2dKind = (typeof TRACK2D_KINDS)[number];

export const Track2dKeySchema = z.object({
  frame: z.number().int(),
  /** Planar: four corners (top-left, top-right, bottom-right, bottom-left as drawn), plate pixels. Point: one. */
  points: z.array(Point2).min(1).max(4),
  by: z.string(),
  at: z.string(),
});
export type Track2dKey = z.infer<typeof Track2dKeySchema>;

export const Track2dFrameSchema = z.object({
  frame: z.number().int(),
  points: z.array(Point2).min(1).max(4),
  confidence: z.number().min(0).max(1),
  status: z.enum(['key', 'tracked', 'lost']),
});
export type Track2dFrame = z.infer<typeof Track2dFrameSchema>;

export const Track2dSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/),
  name: z.string().min(1).max(64),
  kind: z.enum(TRACK2D_KINDS),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  keys: z.array(Track2dKeySchema).default([]),
  /** One per tracked frame, sorted. Small (≤ 4 points), so kept in the project. */
  frames: z.array(Track2dFrameSchema).default([]),
  /** Roto parts whose mattes hide the surface (occluders). */
  occluders: z.array(z.string()).default([]),
  /** Point tracker: pattern and search half-sizes in plate pixels. */
  pattern: z.number().int().min(3).max(200).default(12),
  search: z.number().int().min(4).max(800).default(48),
  engine: z.string().default(''),
});
export type Track2d = z.infer<typeof Track2dSchema>;

export const TRACK2D_EXPORT_FORMATS = ['nuke', 'ae', 'mocha', 'json'] as const;
export type Track2dExportFormat = (typeof TRACK2D_EXPORT_FORMATS)[number];

export const Track2dExportSchema = z.object({
  version: z.number().int().positive(),
  folder: z.string(),
  files: z.array(z.string()),
  tracks: z.array(z.string()),
  formats: z.array(z.enum(TRACK2D_EXPORT_FORMATS)),
  writtenAt: z.string(),
  by: z.string(),
});
export type Track2dExport = z.infer<typeof Track2dExportSchema>;
export type Track2dExportInput = Omit<Track2dExport, 'writtenAt' | 'by'>;

export const Track2dDocumentSchema = z.object({
  formatVersion: z.literal(1).default(1),
  tracks: z.array(Track2dSchema).max(64).default([]),
  exports: z.array(Track2dExportSchema).default([]),
  seq: z.number().int().nonnegative().default(0),
});
export type Track2dDocument = z.infer<typeof Track2dDocumentSchema>;
