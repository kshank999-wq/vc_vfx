import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { PROJECT_EXTENSION } from '@vcvfx/domain';

/**
 * Path rules. No Electron here, so these are unit-tested directly.
 *
 * The handoff names its media relative to itself (it travels on the drive
 * with them), so every source path resolves against the handoff's folder.
 */

/** The project made from the sample has no drive behind it. */
export const SAMPLE_HANDOFF_PATH = 'sample';

export function isSampleHandoff(handoffPath: string): boolean {
  return handoffPath === SAMPLE_HANDOFF_PATH;
}

/** Resolve a handoff-relative path (an absolute one is taken as it is). Null for the sample. */
export function resolveFromHandoff(handoffPath: string, path: string): string | null {
  if (isSampleHandoff(handoffPath)) return null;
  const normalised = path.replace(/[\\/]+/g, sep);
  return isAbsolute(normalised) ? resolve(normalised) : resolve(dirname(handoffPath), normalised);
}

/** `…/NightShift_handoff.json` → `…/NightShift_handoff.vcvfx` */
export function defaultProjectPath(handoffPath: string, fallbackDir: string, projectName: string): string {
  if (isSampleHandoff(handoffPath)) return join(fallbackDir, `${safeFileName(projectName)}.${PROJECT_EXTENSION}`);
  const p = parse(handoffPath);
  return join(p.dir, `${p.name}.${PROJECT_EXTENSION}`);
}

export function withProjectExtension(path: string): string {
  return path.toLowerCase().endsWith(`.${PROJECT_EXTENSION}`) ? path : `${path}.${PROJECT_EXTENSION}`;
}

export function safeFileName(s: string): string {
  return s.trim().replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '_').replace(/\s+/g, ' ') || 'Untitled';
}

/** True when `child` is `parent` or anywhere beneath it. */
export function isInside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Why an output root may not be used, or null. Packages and plates are never
 * written inside a folder that holds source media: originals are read-only to
 * VC VFX, and a stray write beside them is how they get damaged (§19).
 */
export function outputRootProblem(root: string, sourceFiles: readonly string[]): string | null {
  if (!isAbsolute(root)) return 'Choose a full folder path for the output root.';
  for (const source of sourceFiles) {
    if (isInside(root, dirname(source))) {
      return `The output root is inside a source media folder (${dirname(source)}). Choose a folder outside the camera media.`;
    }
  }
  return null;
}

/** `manifest` + 2 + `.json` → `manifest_v002.json` */
export function versionedName(stem: string, version: number, extension: string): string {
  return `${stem}_v${String(version).padStart(3, '0')}.${extension}`;
}

/** Forward-slash path relative to a folder, as the manifest records it. */
export function manifestPath(folder: string, file: string): string {
  return relative(folder, file).split(sep).join('/');
}
