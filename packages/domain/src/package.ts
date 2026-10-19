import { outputFor, type ChecksumRecord } from './handoff.js';
import { framePattern, sequencePlan, versionTag } from './frames.js';
import { handoffShot, shotState, shotStatus, type Project } from './project.js';

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

/** The machine-readable manifest written into each shot package. */
export function buildManifest(p: Project, shotId: string, input: ManifestInput) {
  const shot = handoffShot(p, shotId);
  const state = shotState(p, shotId);
  if (!shot || !state) throw new Error(`No shot ${shotId}`);
  const output = outputFor(p.handoff, shot);
  const plan = sequencePlan(shot, output);
  const sourceChecksums: ChecksumRecord[] = shot.checksums;
  return {
    manifestSchemaVersion: MANIFEST_SCHEMA_VERSION,
    generator: `VC VFX ${input.appVersion}`,
    generatedAt: input.generatedAt.toISOString(),
    operator: input.operator,
    project: p.handoff.project,
    packageVersion: versionTag(Math.max(1, state.packageVersion)),
    shot: {
      shotId: shot.shotId,
      unit: shot.unit ?? null,
      shootDay: shot.shootDay ?? null,
      scene: shot.scene,
      setup: shot.setup ?? null,
      take: shot.take ?? null,
      circled: shot.circled,
      cameraRoll: shot.cameraRoll ?? null,
      clip: shot.clip ?? null,
      sourcePath: shot.sourcePath,
      timecodeIn: shot.timecodeIn ?? null,
      timecodeOut: shot.timecodeOut ?? null,
      frameRate: shot.frameRate,
      resolution: shot.resolution ?? null,
      camera: shot.camera,
      color: shot.color,
      supervisorNotes: shot.supervisorNotes ?? null,
      references: shot.references,
    },
    plates: {
      ...plan,
      pattern: framePattern(shot.shotId, 'plate', 1, output.format),
      /** Display looks are never baked into plates (§4). */
      colorBaked: false,
    },
    status: shotStatus(state),
    tasks: state.tasks.map((t) => ({ kind: t.kind, state: t.state, version: versionTag(t.version), notes: t.notes, approval: t.approval })),
    approval: state.approval,
    sourceVerification: state.sourceVerified,
    checksums: { source: sourceChecksums, delivered: input.files.map((f) => ({ path: f.path, algorithm: 'sha256', value: f.sha256, bytes: f.bytes })) },
    log: p.log.filter((l) => l.shotId === shotId),
  };
}
export type Manifest = ReturnType<typeof buildManifest>;
