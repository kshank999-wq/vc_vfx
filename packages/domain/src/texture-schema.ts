import { z } from 'zod';
import { COLOR_ENCODINGS } from './color.js';
import { SCENE_UNITS } from './camtrack-schema.js';
import { DistortionSchema } from './camera-db.js';

/**
 * The texture-extraction document a shot carries in the project file (master
 * spec §12; addendum 12). Kept apart from `texture.ts` so `project.ts` can
 * embed the schema without importing the mutations.
 *
 * What lives here is small and is the artist's work: the references that were
 * ingested (paths, checksums, sizes, the camera and lens when known — never
 * the pictures or the scan themselves), the texture regions marked on the
 * photographs and their settings, the planes found in the scan, the placement
 * suggestions and the artist's decisions on them, per-region confidence and
 * measurements, the builds and the versioned exports. Textures, masks and
 * meshes are files — never here.
 */

export const TEXTURE_FORMAT_VERSION = 1;
/** Rectification + delighting + seam-cut tiling + panorama/scan placement (addendum 12 §3). */
export const TEXTURE_ALGORITHM = { id: 'vcvfx-texture', version: '1.0.0' } as const;

export const TEXTURE_REFERENCE_KINDS = ['photo', 'panorama', 'scan'] as const;
export type TextureReferenceKind = (typeof TEXTURE_REFERENCE_KINDS)[number];

/** Where a reference came from: chosen on disk, named by the handoff, or the browser preview's synthetic set. */
export const TEXTURE_REFERENCE_ORIGINS = ['disk', 'handoff', 'sample'] as const;
export type TextureReferenceOrigin = (typeof TEXTURE_REFERENCE_ORIGINS)[number];

export const TEXTURE_TILE_MODES = ['none', 'x', 'xy'] as const;
export type TextureTileMode = (typeof TEXTURE_TILE_MODES)[number];

const Vec3Schema = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
const PointSchema = z.tuple([z.number().finite(), z.number().finite()]);
const Id = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/);

/** The camera and lens a photograph was taken with, when known: lets it be undistorted and its focal length used. */
export const TextureCameraSchema = z.object({
  body: z.string().max(200).default(''),
  lens: z.string().max(200).default(''),
  /** Focal length, millimetres. */
  focalMm: z.number().positive().max(2000).nullable().default(null),
  /** The film back's width, millimetres: what the (de-squeezed) picture's width covers. */
  filmBackWidthMm: z.number().positive().max(200).nullable().default(null),
  /** Brown–Conrady distortion (OpenCV's model, as the lens profiles). Null: none known — not undistorted. */
  distortion: DistortionSchema.nullable().default(null),
  /** The project lens profile the distortion was taken from. */
  lensProfileId: z.string().max(64).nullable().default(null),
});
export type TextureCamera = z.infer<typeof TextureCameraSchema>;

export const TextureScanInfoSchema = z.object({
  units: z.enum(SCENE_UNITS).default('m'),
  up: z.enum(['y', 'z']).default('z'),
});
export type TextureScanInfo = z.infer<typeof TextureScanInfoSchema>;

/** Where an equirectangular panorama was taken and which way its centre column faces, in the scan's coordinates. */
export const TexturePanoramaInfoSchema = z.object({
  /** Degrees: the scan direction the panorama's centre column looks along, about the up axis. Null: estimated by the build. */
  headingDeg: z.number().min(-360).max(360).nullable().default(null),
  /** Scan coordinates of the panorama's centre. Null: the middle of the scan. */
  position: Vec3Schema.nullable().default(null),
});
export type TexturePanoramaInfo = z.infer<typeof TexturePanoramaInfoSchema>;

export const TextureReferenceSchema = z.object({
  id: Id,
  kind: z.enum(TEXTURE_REFERENCE_KINDS),
  name: z.string().min(1).max(200),
  /** Absolute path on disk; handoff-relative for `handoff`; a name for `sample`. Read only, always. */
  path: z.string().min(1).max(4096),
  from: z.enum(TEXTURE_REFERENCE_ORIGINS).default('disk'),
  /** File extension, lower case ("jpg", "exr", "e57"). */
  format: z.string().max(16).default(''),
  checksum: z.object({ algorithm: z.literal('sha256'), value: z.string().regex(/^[0-9a-f]{64}$/) }).nullable().default(null),
  bytes: z.number().int().nonnegative().nullable().default(null),
  /** Pictures: their size in pixels. */
  width: z.number().int().positive().nullable().default(null),
  height: z.number().int().positive().nullable().default(null),
  /** Scans: their point count. */
  points: z.number().int().nonnegative().nullable().default(null),
  /** Pictures: how their values are read (sRGB for JPEG/PNG/TIFF, linear for EXR). */
  encoding: z.enum(COLOR_ENCODINGS).nullable().default(null),
  camera: TextureCameraSchema.nullable().default(null),
  /**
   * Pictures: the stored pixel's width over its height (addendum 17). A frame
   * of an anamorphic or DV plate is not square; rectification, the focal
   * length and the viewer de-squeeze through it. Null: square.
   */
  pixelAspect: z.number().min(0.25).max(4).nullable().default(null),
  /** Where it came from: the shot (a frame of its own clip), the file's header, or the artist. */
  pixelAspectFrom: z.enum(['shot', 'file', 'artist']).nullable().default(null),
  scan: TextureScanInfoSchema.nullable().default(null),
  panorama: TexturePanoramaInfoSchema.nullable().default(null),
  addedBy: z.string(),
  addedAt: z.string(),
});
export type TextureReference = z.infer<typeof TextureReferenceSchema>;

export const TextureSizeSchema = z.object({
  width: z.number().positive().max(1e6),
  height: z.number().positive().max(1e6),
  units: z.enum(SCENE_UNITS).default('m'),
});
export type TextureSize = z.infer<typeof TextureSizeSchema>;

export const TextureOutputSchema = z.object({
  /** resolution: the texture's long edge in pixels; density: pixels per metre (needs the real size). */
  mode: z.enum(['resolution', 'density']).default('resolution'),
  resolution: z.number().int().min(64).max(8192).default(1024),
  /** Texels per metre. */
  density: z.number().min(16).max(20000).default(512),
});
export type TextureOutput = z.infer<typeof TextureOutputSchema>;

export const TextureRegionSettingsSchema = z.object({
  /** Take out the lens's distortion first (when the photo's lens is known). */
  undistort: z.boolean().default(true),
  /** Square the region up from its four corners (a homography); off: the corners' bounding box as it is. */
  rectify: z.boolean().default(true),
  /** 0 … 1: how much of the large-scale light falloff and shading is divided out. */
  delight: z.number().min(0).max(1).default(1),
  /** The scale of the shading taken out, as a share of the texture's short side (smaller: more local). */
  delightRadius: z.number().min(0.05).max(1).default(0.2),
  /** Bring regions of the same surface to one exposure. */
  exposureMatch: z.boolean().default(true),
  tile: z.enum(TEXTURE_TILE_MODES).default('none'),
  /** Share of the texture that overlaps itself where it is made to tile (the seam is cut inside it). */
  tileOverlap: z.number().min(0.05).max(0.45).default(0.2),
  output: TextureOutputSchema.default({ mode: 'resolution', resolution: 1024, density: 512 }),
});
export type TextureRegionSettings = z.infer<typeof TextureRegionSettingsSchema>;
export const DEFAULT_TEXTURE_SETTINGS: TextureRegionSettings = TextureRegionSettingsSchema.parse({});

/** A surface to extract: four corners on one photograph (top-left, top-right, bottom-right, bottom-left), photo pixels. */
export const TextureRegionSchema = z.object({
  id: Id,
  name: z.string().min(1).max(120),
  photoId: Id,
  corners: z.tuple([PointSchema, PointSchema, PointSchema, PointSchema]),
  /** The surface's real width (top edge) and height (left edge), when known. */
  size: TextureSizeSchema.nullable().default(null),
  /** The scan plane the artist put this region on; null: the suggestion. */
  target: z.object({ planeId: z.string().max(32).nullable().default(null), label: z.string().max(120).default('') }).default({ planeId: null, label: '' }),
  settings: TextureRegionSettingsSchema.default(DEFAULT_TEXTURE_SETTINGS),
  enabled: z.boolean().default(true),
  by: z.string(),
  at: z.string(),
});
export type TextureRegion = z.infer<typeof TextureRegionSchema>;

/** A dominant plane found in the scan (RANSAC), in the scan's coordinates and units. */
export const TexturePlaneSchema = z.object({
  id: z.string().min(1).max(32),
  /** "floor", "wall facing +X", "ceiling" … */
  label: z.string().max(120),
  /** Unit normal and offset: n·X = d. The normal faces the scan's centre (where it was seen from). */
  normal: Vec3Schema,
  d: z.number().finite(),
  centroid: Vec3Schema,
  /** In-plane axes (u horizontal where it can be; v = n × u). */
  axisU: Vec3Schema,
  axisV: Vec3Schema,
  /** The inliers' extent along the axes, from the centroid. */
  extent: z.object({ u0: z.number(), u1: z.number(), v0: z.number(), v1: z.number() }),
  inliers: z.number().int().nonnegative(),
  /** RMS distance of the inliers from the plane, in the scan's units. */
  rms: z.number().nonnegative(),
});
export type TexturePlane = z.infer<typeof TexturePlaneSchema>;

/** Which way a photo looked, from matching it against the panorama: yaw about up, pitch above the horizon, degrees, in the panorama's frame. */
export const TextureDirectionSchema = z.object({
  yawDeg: z.number().min(-360).max(360),
  pitchDeg: z.number().min(-90).max(90),
  rollDeg: z.number().min(-180).max(180).default(0),
  fovDeg: z.number().min(1).max(179).default(60),
});
export type TextureDirection = z.infer<typeof TextureDirectionSchema>;

export const TEXTURE_PLACEMENT_DECISIONS = ['pending', 'accepted', 'rejected', 'edited'] as const;
export type TexturePlacementDecision = (typeof TEXTURE_PLACEMENT_DECISIONS)[number];

/** Where a photograph belongs: the build's suggestion and the artist's decision on it (§19 "AI suggestions editable"). */
export const TexturePlacementSchema = z.object({
  photoId: Id,
  suggested: z
    .object({
      direction: TextureDirectionSchema,
      /** The scan plane under the photo's centre; null without a scan. */
      planeId: z.string().max(32).nullable(),
      /** Where the centre ray meets it, scan coordinates. */
      hit: Vec3Schema.nullable(),
      confidence: z.number().min(0).max(1),
      /** NCC of the best match and how far it stands above the next best. */
      score: z.number().min(-1).max(1),
      method: z.enum(['panorama', 'none']),
      note: z.string().max(400).default(''),
    })
    .nullable()
    .default(null),
  decision: z.enum(TEXTURE_PLACEMENT_DECISIONS).default('pending'),
  /** The artist's own placement (decision `edited`). */
  edited: z.object({ direction: TextureDirectionSchema, planeId: z.string().max(32).nullable() }).nullable().default(null),
  by: z.string().nullable().default(null),
  at: z.string().nullable().default(null),
});
export type TexturePlacement = z.infer<typeof TexturePlacementSchema>;

export const TextureMetricsSchema = z.object({
  /** The texture's size, pixels. */
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** Texels per metre in the output; null without a real size. */
  texelDensity: z.number().nonnegative().nullable(),
  /** Photo pixels per metre where the region is sampled most sparsely; null without a real size. */
  nativeDensity: z.number().nonnegative().nullable(),
  /** Large-scale light variation across the texture, stops: before and after delighting. */
  residualBefore: z.number().nonnegative(),
  residualAfter: z.number().nonnegative(),
  /** Fine detail kept through delighting (high-pass energy after / before; 1 = all). */
  detailKept: z.number().nonnegative(),
  /** How visible the tile's seams are: the step across them against the texture's own pixel-to-pixel steps (1 = invisible); null when not tiled. */
  seamScore: z.number().nonnegative().nullable(),
  /** 0 … 1: how sharp the photo is inside the region (fine against coarse detail). */
  sharpness: z.number().min(0).max(1),
  /** Shares of the region that are clipped highlights and specular glints. */
  clipped: z.number().min(0).max(1),
  specular: z.number().min(0).max(1),
  /** Exposure gain applied to match the other regions of the surface. */
  exposureGain: z.number().positive(),
  /** Share of the texture that came from inside the photo. */
  coverage: z.number().min(0).max(1),
  /** The rectified texture's aspect (width / height) and where it came from. */
  aspect: z.number().positive(),
  aspectFrom: z.enum(['size', 'plane', 'focal', 'corners']),
  /** The scan plane suggested under the region and how sure that is. */
  planeId: z.string().max(32).nullable(),
  planeConfidence: z.number().min(0).max(1),
});
export type TextureMetrics = z.infer<typeof TextureMetricsSchema>;

export const TextureRegionRecordSchema = z.object({
  regionId: Id,
  confidence: z.number().min(0).max(1),
  metrics: TextureMetricsSchema,
  status: z.enum(['processed', 'flagged']).default('processed'),
  reason: z.string().default(''),
  reviewed: z.object({ by: z.string(), at: z.string() }).nullable().default(null),
  note: z.string().default(''),
});
export type TextureRegionRecord = z.infer<typeof TextureRegionRecordSchema>;

export const TextureRunSchema = z.object({
  algorithm: z.string(),
  revision: z.number().int().nonnegative(),
  regions: z.number().int().nonnegative(),
  meanConfidence: z.number().min(0).max(1),
  minConfidence: z.number().min(0).max(1),
  planes: z.number().int().nonnegative(),
  placements: z.number().int().nonnegative(),
  problems: z.array(z.string()).default([]),
  taskVersion: z.number().int().positive(),
  at: z.string(),
  by: z.string(),
});
export type TextureRun = z.infer<typeof TextureRunSchema>;

export const TextureExportRegionSchema = z.object({
  id: Id,
  name: z.string(),
  /** File names inside the export folder. */
  map: z.string(),
  mapExr: z.string().nullable(),
  original: z.string().nullable(),
  tilePreview: z.string().nullable(),
  mask: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  planeId: z.string().nullable(),
});
export type TextureExportRegion = z.infer<typeof TextureExportRegionSchema>;

/** A versioned export into the shot package's 07_TEXTURES_REFERENCES (§12, §17). */
export const TextureExportSchema = z.object({
  version: z.number().int().positive(),
  /** Package-relative folder `07_TEXTURES_REFERENCES/<shot>_tex_vNNN`. */
  folder: z.string(),
  regions: z.array(TextureExportRegionSchema),
  /** File names inside `folder`. */
  mapping: z.string(),
  obj: z.string().nullable(),
  mtl: z.string().nullable(),
  format: z.enum(['exr', 'png']),
  encoding: z.string(),
  summary: z.object({ regions: z.number().int().nonnegative(), mean: z.number(), min: z.number(), low: z.array(z.string()) }),
  algorithm: z.string(),
  revision: z.number().int().nonnegative(),
  files: z.number().int().nonnegative(),
  writtenAt: z.string(),
  by: z.string(),
});
export type TextureExport = z.infer<typeof TextureExportSchema>;
export type TextureExportInput = Omit<TextureExport, 'writtenAt' | 'by'>;

/** Where the build put the panorama in the scan and which way it faced: given by the artist, found from the scan, or a default. */
export const TexturePanoramaPoseSchema = z.object({
  position: Vec3Schema,
  headingDeg: z.number(),
  positionFrom: z.enum(['given', 'scan', 'default']),
  headingFrom: z.enum(['given', 'scan', 'default']),
  confidence: z.number().min(0).max(1),
});
export type TexturePanoramaPose = z.infer<typeof TexturePanoramaPoseSchema>;

export const TextureDocumentSchema = z.object({
  formatVersion: z.literal(TEXTURE_FORMAT_VERSION).default(TEXTURE_FORMAT_VERSION),
  algorithm: z.object({ id: z.string(), version: z.string() }).default({ ...TEXTURE_ALGORITHM }),
  references: z.array(TextureReferenceSchema).max(200).default([]),
  regions: z.array(TextureRegionSchema).max(200).default([]),
  /** The scan's dominant planes, from the newest build. */
  planes: z.array(TexturePlaneSchema).max(64).default([]),
  placements: z.array(TexturePlacementSchema).max(200).default([]),
  /** The panorama's place in the scan, from the newest build. */
  panoramaPose: TexturePanoramaPoseSchema.nullable().default(null),
  /** One record per built region. */
  records: z.array(TextureRegionRecordSchema).default([]),
  /** Kept to the most recent 200. */
  runs: z.array(TextureRunSchema).default([]),
  exports: z.array(TextureExportSchema).default([]),
  /** Longest edge of a texture in the review build; exports are made at the regions' own output size. */
  workingWidth: z.number().int().min(256).max(4096).default(1024),
  /** Bumped by every change of settings: a build records which revision it used (§19). */
  revision: z.number().int().nonnegative().default(0),
  seq: z.number().int().nonnegative().default(0),
});
export type TextureDocument = z.infer<typeof TextureDocumentSchema>;
