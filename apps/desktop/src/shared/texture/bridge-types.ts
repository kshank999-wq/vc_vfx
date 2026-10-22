import type { TextureExportInput, TextureReferenceInput, TextureReferenceKind, TextureRegion, TextureRunResult } from '@vcvfx/domain';

/**
 * Texture extraction's part of the renderer ↔ main contract (addendum 12).
 * Kept here so bridge.ts only names these; the preload, ipc and the browser
 * preview implement them.
 */

export interface TextureShotInput {
  text: string;
  shotId: string;
  projectKey: string;
}

/** A reference the handoff names for the shot (reference photo, panorama, LiDAR), and whether it is on the drive. */
export interface TextureHandoffReference {
  kind: TextureReferenceKind;
  /** Handoff-relative path. */
  path: string;
  name: string;
  onDisk: boolean;
}

export interface TextureReferenceStatus {
  id: string;
  onDisk: boolean;
  /** The file's size differs from what was ingested (a cheap check; the build reads it again). */
  changed: boolean;
}

export interface TextureSessionInfo {
  available: boolean;
  reason: string | null;
  /** Written into the package from here (not in the browser preview). */
  exportable: boolean;
  /** Files can be chosen on disk (the preview offers its sample set). */
  fromDisk: boolean;
  handoff: TextureHandoffReference[];
  references: TextureReferenceStatus[];
  /** What the textures are built in. */
  working: { label: string; linear: boolean };
  /** The preview: its sample set, and the regions to mark on it. */
  sample?: boolean;
  sampleRegions?: { photo: string; name: string; corners: TextureRegion['corners']; size: { width: number; height: number; units: 'm' } }[];
}

export type TextureImageRequest =
  | { kind: 'reference'; id: string; maxWidth: number }
  | { kind: 'texture'; regionId: string; stage: 'original' | 'delit' | 'tiled'; maxWidth: number };

/** A picture for the viewer: 8-bit sRGB (the texture view), at most the asked width. */
export interface TextureImageView {
  width: number;
  height: number;
  rgb: Uint8ClampedArray;
  /** 255 where the texel came from inside the photo (textures only). */
  mask: Uint8Array | null;
  /** Textures: built with the current settings, built with older ones, or not built. */
  built: 'current' | 'stale' | 'none';
  label: string;
}

/** The scan for the 3D view, canonical Y-up, relative to `origin`. */
export interface TextureScanView {
  positions: Float32Array;
  colors: Uint8Array | null;
  origin: [number, number, number];
  /** Per point: 1 + the index of its plane in the build's planes, or 0. Null before a build. */
  planeOf: Uint8Array | null;
  planeIds: string[];
  /** Where the panorama was, canonical (relative to origin). */
  panorama: [number, number, number] | null;
  /** The regions' patches, canonical (relative to origin). */
  patches: { regionId: string; corners: [number, number, number][] }[];
  built: 'current' | 'stale' | 'none';
}

export interface TextureIngestSource {
  /** Absolute, or handoff-relative for `handoff`; a name for `sample`. */
  path: string;
  from: 'disk' | 'handoff' | 'sample';
}

export interface TextureExportOutcome {
  /** What was written; the renderer records it with `recordTextureExport`. */
  record: TextureExportInput;
  folder: string;
  files: number;
}

export interface TextureBridge {
  textureSession(input: TextureShotInput): Promise<import('../bridge').ApiResult<TextureSessionInfo>>;
  /** Choose files of a kind on disk (read only). Null when cancelled. */
  textureChoose?(input: { kind: TextureReferenceKind }): Promise<import('../bridge').ApiResult<string[] | null>>;
  /** Read references (checksum, size, camera) without touching them (a job); the renderer records them with `addTextureReference`. */
  textureIngest(input: TextureShotInput & { jobId: string; kind: TextureReferenceKind; sources: TextureIngestSource[] }): Promise<import('../bridge').ApiResult<TextureReferenceInput[]>>;
  textureImage(input: TextureShotInput & { request: TextureImageRequest }): Promise<import('../bridge').ApiResult<TextureImageView>>;
  textureScan(input: TextureShotInput): Promise<import('../bridge').ApiResult<TextureScanView | null>>;
  /** Build every region (a job); the renderer records the result with `recordTextureRun`. */
  textureBuild(input: TextureShotInput & { jobId: string }): Promise<import('../bridge').ApiResult<{ result: TextureRunResult }>>;
  /** Write the versioned textures, mapping file and mesh into the shot package (a job). */
  textureExport(input: TextureShotInput & { jobId: string; operator: string }): Promise<import('../bridge').ApiResult<TextureExportOutcome>>;
}
