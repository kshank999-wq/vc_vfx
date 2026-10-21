import { outputFor, type ChecksumRecord } from './handoff.js';
import { framePattern, versionTag } from './frames.js';
import { handoffShot, planFor, plateColorFor, shotState, shotStatus, shotTiming, type Project } from './project.js';
import { partsInOrder, rotoConfidenceSummary, rotoNames } from './roto.js';
import { camtrackManifest, track2dManifest } from './camtrack.js';
import { keyManifest } from './key.js';
import { cleanPlateManifest } from './cleanplate.js';
import { isolateManifest } from './isolate.js';

/**
 * The per-shot output package (master spec §17) and its manifest (§18).
 *
 *   PROJECT_VFX/SCENE_012/SHOT_012A_030/
 *     00_SOURCE_REFERENCE/ … 10_DELIVERY/
 *     manifest.json
 *     prep_report.html
 */

export const PACKAGE_FOLDERS = [
  '00_SOURCE_REFERENCE',
  '01_PLATES',
  '02_MATTES_ROTO',
  '03_KEYS',
  '04_CLEAN_PLATES',
  '05_TRACKS_2D',
  '06_CAMERA_TRACK',
  '07_TEXTURES_REFERENCES',
  '08_PREVIEWS',
  '09_PROJECT_DATA',
  '10_DELIVERY',
] as const;
export type PackageFolder = (typeof PACKAGE_FOLDERS)[number];

export const MANIFEST_SCHEMA_VERSION = 1;

/** Upper-case, filesystem-safe on Windows and macOS. */
export function safeName(s: string): string {
  return s.trim().replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '_').replace(/\s+/g, '_').replace(/_+/g, '_').replace(/^\.+/, '').toUpperCase() || 'UNTITLED';
}

/** Path segments of the shot folder, relative to the chosen output root. */
export function shotFolderSegments(project: string, scene: string, shotId: string): [string, string, string] {
  return [`${safeName(project)}_VFX`, `SCENE_${safeName(scene)}`, `SHOT_${safeName(shotId)}`];
}

export interface PackagedFile {
  /** Relative to the shot folder, forward slashes. */
  path: string;
  bytes: number;
  sha256: string;
}

export interface ManifestInput {
  generatedAt: Date;
  appVersion: string;
  operator: string;
  files: readonly PackagedFile[];
}

/**
 * The roto section of the manifest (§5.2, §18): the task version, the export
 * of that version (or null when none was written), which engines made it and
 * how confident they were. Null when the shot has no roto document.
 */
function rotoManifest(state: NonNullable<ReturnType<typeof shotState>>, name: string) {
  const doc = state.roto;
  if (!doc) return null;
  const task = state.tasks.find((t) => t.kind === 'roto');
  const version = task?.version ?? 1;
  const exported = doc.exports.find((e) => e.version === version) ?? null;
  const summary = rotoConfidenceSummary(doc);
  return {
    version: versionTag(version),
    state: task?.state ?? null,
    approval: task?.approval ?? null,
    exported: exported !== null,
    folder: exported?.folder ?? null,
    combined: exported ? exported.pattern : rotoNames.mattePattern(name, version),
    metadata: exported?.metadata ?? null,
    frames: exported ? { first: exported.first, last: exported.last, count: exported.frames } : null,
    resolution: exported ? { width: exported.width, height: exported.height } : null,
    bitDepth: exported?.bitDepth ?? null,
    exr: exported?.exr ?? false,
    engines: [...new Set(doc.parts.flatMap((p) => p.frames.map((f) => f.engine)).filter(Boolean))],
    parts: partsInOrder(doc).map((p) => ({ id: p.id, name: p.name, parent: p.parentId, combine: p.combine, engine: p.engine, refine: p.refine, keyFrames: p.keyFrames.map((k) => k.frame), confidence: rotoConfidenceSummary(doc, p.id) })),
    confidence: { frames: summary.frames, mean: summary.mean, min: summary.min, low: summary.low, flagged: summary.flagged, reviewed: summary.reviewed },
  };
}

/** The machine-readable manifest written into each shot package. */
export function buildManifest(p: Project, shotId: string, input: ManifestInput) {
  const shot = handoffShot(p, shotId);
  const state = shotState(p, shotId);
  if (!shot || !state) throw new Error(`No shot ${shotId}`);
  const output = outputFor(p.handoff, shot);
  const plan = planFor(p, shot);
  const timing = shotTiming(p, shot);
  const name = state.vfxShotId ?? shot.shotId;
  const sourceChecksums: ChecksumRecord[] = shot.checksums;
  const plateVersion = state.tasks.find((t) => t.kind === 'sequence_conversion')?.version ?? 1;
  const written = state.plates.find((r) => r.version === plateVersion) ?? null;
  const planned = plateColorFor(p, shotId);
  return {
    manifestSchemaVersion: MANIFEST_SCHEMA_VERSION,
    generator: `VC VFX ${input.appVersion}`,
    generatedAt: input.generatedAt.toISOString(),
    operator: input.operator,
    project: p.handoff.project,
    origin: p.handoff.origin ?? null,
    packageVersion: versionTag(Math.max(1, state.packageVersion)),
    shot: {
      /** The VFX shot number when assigned, else the handoff's ID. */
      shotId: name,
      handoffShotId: shot.shotId,
      unit: shot.unit ?? null,
      shootDay: shot.shootDay ?? null,
      scene: shot.scene,
      setup: shot.setup ?? null,
      take: shot.take ?? null,
      circled: shot.circled,
      cameraRoll: shot.cameraRoll ?? null,
      clip: shot.clip ?? null,
      sourcePath: shot.sourcePath,
      sourceFiles: shot.sourceFiles ?? [],
      flaggedBy: shot.flaggedBy ?? null,
      timecodeIn: timing?.timecodeIn ?? null,
      timecodeOut: shot.timecodeOut ?? null,
      frameRate: timing?.frameRate ?? shot.frameRate,
      resolution: timing?.resolution ?? null,
      /** handoff: the range the handoff gave; probe: the whole clip as ffprobe read it; null: unknown. */
      rangeFrom: timing?.from ?? null,
      probedMedia: state.probe,
      camera: shot.camera,
      color: shot.color,
      supervisorNotes: shot.supervisorNotes ?? null,
      references: shot.references,
    },
    plates: {
      /** Null fields: the frame range was never known (not in the handoff, clip not read). */
      sourceIn: plan?.sourceIn ?? null,
      sourceOut: plan?.sourceOut ?? null,
      deliveredIn: plan?.deliveredIn ?? null,
      deliveredOut: plan?.deliveredOut ?? null,
      editorialIn: plan?.editorialIn ?? null,
      editorialOut: plan?.editorialOut ?? null,
      handles: plan?.handles ?? shot.handles,
      frameCount: plan?.frameCount ?? null,
      format: output.format,
      bitDepth: output.bitDepth,
      pattern: framePattern(name, 'plate', plateVersion, output.format),
      /** Display looks are never baked into plates (§4). */
      colorBaked: false,
      /**
       * Exactly what was applied to the plates of this version (written: true),
       * or what will be (written: false) when none have been made yet.
       */
      color: written
        ? { written: true, ...written.color, writtenAt: written.writtenAt, by: written.by, frames: written.frames }
        : {
            written: false,
            policy: planned.policy,
            sourceEncoding: planned.sourceEncoding,
            plateEncoding: planned.plateEncoding,
            summary: planned.summary,
            warnings: planned.warnings,
            lookApplied: false as const,
          },
    },
    review: { marks: state.reviewMarks },
    roto: rotoManifest(state, name),
    cameraTrack: camtrackManifest(state),
    tracks2d: track2dManifest(state),
    key: keyManifest(state),
    cleanPlate: cleanPlateManifest(state),
    isolate: isolateManifest(state),
    status: shotStatus(state),
    tasks: state.tasks.map((t) => ({ kind: t.kind, state: t.state, version: versionTag(t.version), notes: t.notes, approval: t.approval })),
    approval: state.approval,
    sourceVerification: state.sourceVerified,
    checksums: { source: sourceChecksums, delivered: input.files.map((f) => ({ path: f.path, algorithm: 'sha256', value: f.sha256, bytes: f.bytes })) },
    log: p.log.filter((l) => l.shotId === shotId),
  };
}
export type Manifest = ReturnType<typeof buildManifest>;
