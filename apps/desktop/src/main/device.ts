import { app } from 'electron';
import { createHash, randomBytes } from 'node:crypto';
import { hostname, userInfo } from 'node:os';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Platform } from '@vcvfx/domain';

/**
 * Identifying this installation for licensing.
 *
 * A seat is a place VC VFX is installed, not a piece of hardware: a random
 * salt made on first run, kept in the app's data folder, hashed with the
 * machine name. Stable across restarts; meaningless outside this app. No
 * hardware serial or MAC address is used.
 */

const saltPath = () => join(app.getPath('userData'), 'device-salt');

const readOrCreateSalt = async (): Promise<string> => {
  try {
    const existing = (await readFile(saltPath(), 'utf8')).trim();
    if (existing.length >= 32) return existing;
  } catch {
    // First run on this installation.
  }
  const salt = randomBytes(32).toString('hex');
  await mkdir(app.getPath('userData'), { recursive: true });
  await writeFile(saltPath(), salt, 'utf8');
  return salt;
};

let cached: string | null = null;

export const deviceFingerprint = async (): Promise<string> => {
  if (cached) return cached;
  const salt = await readOrCreateSalt();
  cached = createHash('sha256').update(`${salt}:${hostname()}`).digest('hex');
  return cached;
};

/** A name the owner will recognise in a list of their own devices. */
export const deviceName = (): string => {
  const machine = hostname().replace(/\.local$/i, '');
  try {
    const user = userInfo().username;
    return user && !machine.toLowerCase().includes(user.toLowerCase()) ? `${machine} (${user})` : machine;
  } catch {
    return machine;
  }
};

export const devicePlatform = (): Platform | null =>
  process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : null;
