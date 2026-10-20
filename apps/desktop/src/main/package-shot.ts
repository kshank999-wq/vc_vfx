import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  PACKAGE_FOLDERS,
  buildManifest,
  handoffShot,
  markPackaged,
  shotFolderSegments,
  shotState,
  type PackagedFile,
  type Project,
} from '@vcvfx/domain';
import { prepReportHtml } from '../shared/report';
import { writeAtomic, writeNew } from './atomic';
import { sha256File } from './hash';
import { manifestPath, outputRootProblem, resolveFromHandoff, versionedName } from './paths';

/**
 * Writing a shot package (master spec §17, §18). No Electron here, so it is
 * tested against a temporary folder.
 *
 * Order matters:
 *  1. `markPackaged` first — it refuses an unapproved shot, and its new
 *     `packageVersion` names every file this run writes.
 *  2. Every §17 folder exists (created if absent; nothing in them is touched).
 *  3. `prep_report_vNNN.html`, then `manifest_vNNN.json` — written with
 *     exclusive create, so an earlier version is never replaced. The manifest
 *     records the sha256 of every file in the package except manifests and the
 *     unversioned "latest" copies.
 *  4. `manifest.json` and `prep_report.html` are then (over)written as copies
 *     of the latest version, so a reader always finds the newest at a fixed
 *     name and every older version survives under its own.
 *
 * The project is only returned — and so only saved as packaged — once every
 * write has succeeded.
 */

export interface PackageInput {
  project: Project;
  shotId: string;
  outputRoot: string;
  operator: string;
  appVersion: string;
  now: Date;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number, file: string) => void;
}

export type PackageResult =
  | { ok: true; project: Project; folder: string; version: number; files: PackagedFile[] }
  | { ok: false; reason: string };

/** Files in a folder tree, depth first, as absolute paths. */
async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (entry.isFile() && !entry.name.startsWith('.')) out.push(full);
  }
  return out;
}

const isManifestOrLatest = (rel: string) => /^manifest(_v\d{3})?\.json$/.test(rel) || rel === 'prep_report.html';

export function shotFolder(project: Project, shotId: string, outputRoot: string): string {
  const shot = handoffShot(project, shotId);
  if (!shot) throw new Error(`No shot ${shotId}`);
  // Named by the VFX shot number once assigned (it is fixed once a package exists).
  return join(outputRoot, ...shotFolderSegments(project.handoff.project, shot.scene, shotState(project, shotId)?.vfxShotId ?? shotId));
}

export function sourceFiles(project: Project): string[] {
  return project.handoff.shots
    .flatMap((s) => [s.sourcePath, ...(s.sourceFiles ?? []), ...s.checksums.map((c) => c.path)])
    .map((p) => resolveFromHandoff(project.handoffPath, p))
    .filter((p): p is string => p !== null);
}

export async function packageShot(input: PackageInput): Promise<PackageResult> {
  const problem = outputRootProblem(input.outputRoot, sourceFiles(input.project));
  if (problem) return { ok: false, reason: problem };

  const marked = markPackaged(input.project, input.shotId, input.operator, input.now);
  if (!marked.ok) return marked;
  const project = marked.project;
  const version = shotState(project, input.shotId)!.packageVersion;
  const folder = shotFolder(project, input.shotId, input.outputRoot);

  for (const name of PACKAGE_FOLDERS) await mkdir(join(folder, name), { recursive: true });

  const reportName = versionedName('prep_report', version, 'html');
  const manifestName = versionedName('manifest', version, 'json');
  for (const name of [reportName, manifestName]) {
    if (await stat(join(folder, name)).catch(() => null)) {
      return {
        ok: false,
        reason: `${name} already exists in ${folder}. That package version was written before; it is never replaced. Open the project file that wrote it, or choose another output root.`,
      };
    }
  }

  try {
    await writeNew(join(folder, reportName), prepReportHtml(project, input.shotId, { generatedAt: input.now, appVersion: input.appVersion, operator: input.operator }));

    const paths = (await walk(folder)).filter((f) => !isManifestOrLatest(manifestPath(folder, f)));
    const files: PackagedFile[] = [];
    for (const [i, path] of paths.entries()) {
      if (input.signal?.aborted) throw new Error('Cancelled');
      const rel = manifestPath(folder, path);
      input.onProgress?.(i, paths.length, rel);
      const { sha256, bytes } = await sha256File(path, input.signal ? { signal: input.signal } : {});
      files.push({ path: rel, bytes, sha256 });
    }
    input.onProgress?.(paths.length, paths.length, '');

    const manifest = buildManifest(project, input.shotId, { generatedAt: input.now, appVersion: input.appVersion, operator: input.operator, files });
    const text = `${JSON.stringify(manifest, null, 2)}\n`;
    await writeNew(join(folder, manifestName), text);
    await writeAtomic(join(folder, 'manifest.json'), text);
    await copyFile(join(folder, reportName), join(folder, 'prep_report.html'));
    return { ok: true, project, folder, version, files };
  } catch (error) {
    return { ok: false, reason: `The package could not be written: ${(error as Error).message}` };
  }
}
