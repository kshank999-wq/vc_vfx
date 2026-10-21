import type { CleanPlateExportInput, CleanPlateMetrics, CleanPlateRunResult } from '@vcvfx/domain';

/**
 * The clean plate's part of the renderer ↔ main contract (addendum 10). Kept
 * here so bridge.ts only names these; the preload, ipc and the browser
 * preview implement them.
 */

export interface CleanPlateShotInput {
  text: string;
  shotId: string;
  projectKey: string;
}

export interface CleanPlateSessionInfo {
  available: boolean;
  reason: string | null;
  /** What the frames are: "plates v001", "source", "sample frames". */
  frames: string;
  /** Plate resolution: boxes and patches are in these pixels. */
  plate: { width: number; height: number } | null;
  /** The resolution the review build works at. */
  working: { width: number; height: number } | null;
  first: number;
  last: number;
  /** The encoding the build works in, and whether it is linear. */
  encoding: { label: string; linear: boolean; note: string | null };
  /** A clean plate can be written into the package from here (not in the browser preview). */
  exportable: boolean;
  /** The preview's synthetic shot comes with its subjects already rotoscoped (the desktop paints them in Roto). */
  sampleSubjects?: { name: string }[];
  sample?: boolean;
}

/** One frame for the viewer, at most the working size: 8-bit display images and masks. */
export interface CleanPlateFrameView {
  frame: number;
  width: number;
  height: number;
  /** The frame through the viewer's display transform (RGB, 3 per pixel). */
  source: Uint8ClampedArray;
  /** What is removed on this frame (the dilated matte), 0/255; null when nothing is. */
  hole: Uint8Array | null;
  /** The clean plate (RGB) of this frame — or the still — from the last build of the current settings; null before. */
  plate: Uint8ClampedArray | null;
  /** 0…255 per pixel (255 outside the removed area); null before a build. */
  confidence: Uint8Array | null;
  /** 255 where the reconstruction is unresolved (wants paint or a patch). */
  unresolved: Uint8Array | null;
  /** The plate is a still made in this (reference) frame. */
  stillFrame: number | null;
  /** current: built with the current settings; stale: built, settings changed since; none. */
  built: 'current' | 'stale' | 'none';
  metrics: CleanPlateMetrics | null;
  viewLabel: string;
}

export interface CleanPlateExportOutcome {
  /** What was written; the renderer records it with `recordCleanPlateExport`. */
  record: CleanPlateExportInput;
  folder: string;
  files: number;
}

export interface CleanPlateBridge {
  /** Whether a clean plate can be made on this shot, at what sizes, in which encoding. */
  cleanPlateSession(input: CleanPlateShotInput): Promise<import('../bridge').ApiResult<CleanPlateSessionInfo>>;
  /** One frame for the viewer: source, removal matte, and the built plate and confidence when there is one. */
  cleanPlateFrame(input: CleanPlateShotInput & { frame: number; maxWidth: number }): Promise<import('../bridge').ApiResult<CleanPlateFrameView>>;
  /** Align and build the shot (a job); the renderer records the result with `recordCleanPlateRun`. */
  cleanPlateBuild(input: CleanPlateShotInput & { jobId: string }): Promise<import('../bridge').ApiResult<{ result: CleanPlateRunResult }>>;
  /** Write the versioned clean plate into the shot package (a job). */
  cleanPlateExport(input: CleanPlateShotInput & { jobId: string; operator: string }): Promise<import('../bridge').ApiResult<CleanPlateExportOutcome>>;
}
