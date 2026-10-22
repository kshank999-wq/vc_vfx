import type { LightSpec, LightingAiReviewInput, LightingAnalysisInput, LightingExportFormat, LightingExportInput, LightingReferenceInput, LightingReferenceKind } from '@vcvfx/domain';

/**
 * Lighting and lens analysis' part of the renderer ↔ main contract
 * (addendum 14). Kept here so bridge.ts only names these; the preload, ipc
 * and the browser preview implement them.
 */

export interface LightingShotInput {
  text: string;
  shotId: string;
  projectKey: string;
}

/** A reference the handoff (or the Textures tab) has that the analysis can use, and whether it is on the drive. */
export interface LightingHandoffReference {
  kind: LightingReferenceKind;
  /** Handoff-relative path, or the Textures reference id for `from: 'texture'`. */
  path: string;
  name: string;
  from: 'handoff' | 'texture';
  onDisk: boolean;
}

export interface LightingSessionInfo {
  available: boolean;
  reason: string | null;
  /** Written into the package from here (not in the browser preview). */
  exportable: boolean;
  /** Files can be chosen on disk. */
  fromDisk: boolean;
  frames: string;
  plate: { width: number; height: number } | null;
  first: number;
  last: number;
  fps: number;
  /** The analysis works at this width. */
  analysisWidth: number;
  encoding: { label: string; linear: boolean; note: string | null };
  /** What the analysis will use, in words: the lens metadata, the camera track, the mattes. */
  camera: { focal: string | null; filmBack: string | null; solve: string | null; whiteBalance: string | null; iris: string | null };
  subject: { source: 'roto' | 'bg_matte' | 'key_alpha' | 'sample' | 'none'; label: string };
  sky: { source: 'sky_matte' | 'detected' | 'sample' | 'none'; label: string };
  handoff: LightingHandoffReference[];
  references: { id: string; onDisk: boolean; changed: boolean }[];
  /** The browser preview's synthetic shot: its references to add, and the frame its chrome ball is in. */
  sample?: { refs: { kind: LightingReferenceKind; name: string }[]; ballFrame: number | null };
  /** The AI review: whether it can run here, and why not. */
  ai: { available: boolean; reason: string | null };
}

export interface LightingFrameRequest {
  frame: number;
  maxWidth: number;
  /** The rig as it is now (the estimate with the artist's edits), for the relight preview and its match score. */
  rig: LightSpec[] | null;
}

/** A frame for the viewer: the plate and the subject relit by the rig (8-bit display RGB), a grey ball under the rig. */
export interface LightingFrameView {
  frame: number;
  width: number;
  height: number;
  rgb: Uint8ClampedArray;
  relit: Uint8ClampedArray | null;
  /** The subject's mask at this size (255 inside), for the wipe and the overlays. */
  mask: Uint8Array | null;
  ball: { size: number; rgb: Uint8ClampedArray; alpha: Uint8Array } | null;
  /** How well the rig as it is now explains the subject's shading (0 … 1). */
  match: number | null;
  /** The relight uses the analysis of the settings as they are, an older one, or none. */
  built: 'current' | 'stale' | 'none';
  label: string;
  ms: number;
}

export interface LightingReferenceView {
  width: number;
  height: number;
  rgb: Uint8ClampedArray;
  label: string;
}

export interface LightingIngestSource {
  /** Absolute, handoff-relative for `handoff`, the Textures reference id for `texture`, a name for `sample`; '' for a plate frame. */
  path: string;
  from: 'disk' | 'handoff' | 'texture' | 'sample' | 'plate';
}

export interface LightingExportOutcome {
  /** What was written; the renderer records it with `recordLightingExport`. */
  record: LightingExportInput;
  folder: string;
  files: number;
}

export interface LightingBridge {
  lightingSession(input: LightingShotInput): Promise<import('../bridge').ApiResult<LightingSessionInfo>>;
  /** Choose a reference file on disk (read only). Null when cancelled. */
  lightingChoose?(input: { kind: LightingReferenceKind }): Promise<import('../bridge').ApiResult<string[] | null>>;
  /** Read references (checksum, size) without touching them (a job); the renderer records them with `addLightingReference`. */
  lightingIngest(input: LightingShotInput & { jobId: string; kind: LightingReferenceKind; sources: LightingIngestSource[]; frame?: number | null }): Promise<import('../bridge').ApiResult<LightingReferenceInput[]>>;
  lightingFrame(input: LightingShotInput & { request: LightingFrameRequest }): Promise<import('../bridge').ApiResult<LightingFrameView>>;
  lightingImage(input: LightingShotInput & { id: string; maxWidth: number }): Promise<import('../bridge').ApiResult<LightingReferenceView>>;
  /** Analyse the frames and references (a job); the renderer records the result with `recordLightingAnalysis`. */
  lightingAnalyse(input: LightingShotInput & { jobId: string }): Promise<import('../bridge').ApiResult<{ analysis: LightingAnalysisInput }>>;
  /** Write the versioned rig (Unreal, USD, JSON, Blender, report) into the shot package (a job). */
  lightingExport(input: LightingShotInput & { jobId: string; operator: string; formats: LightingExportFormat[] }): Promise<import('../bridge').ApiResult<LightingExportOutcome>>;
  /** Ask the AI assistant (through vc-vfx.com) for a second opinion on the rig: suggestions only (a job). */
  lightingAiReview?(input: LightingShotInput & { jobId: string; note?: string }): Promise<import('../bridge').ApiResult<{ review: LightingAiReviewInput }>>;
}
