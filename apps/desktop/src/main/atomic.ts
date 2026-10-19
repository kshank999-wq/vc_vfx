import { randomBytes } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';

/**
 * Write a file so that a crash or a full disk leaves either the old file or
 * the new one, never half of either: write a temporary sibling, then rename
 * it over the target (atomic on the same volume on Windows and macOS).
 */
export async function writeAtomic(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(temp, data);
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Like writeAtomic, but refuses to replace an existing file. */
export async function writeNew(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // 'wx' fails if the file exists, so a versioned file is never replaced.
  await writeFile(path, data, { flag: 'wx' });
}
