import { app } from 'electron';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { Settings } from '../shared/bridge';
import { writeAtomic } from './atomic';

/**
 * Per-machine settings in userData. The output root lives here — keyed by
 * project — and not in the project file, because it is a fact about this
 * computer's disks rather than about the production.
 */

const settingsPath = () => join(app.getPath('userData'), 'settings.json');
const MAX_RECENT = 10;

const SettingsSchema = z.object({
  operatorName: z.string().default(''),
  ffmpegPath: z.string().default(''),
  outputRoots: z.record(z.string()).default({}),
  recent: z.array(z.string()).default([]),
  modelBaseUrl: z.string().default(''),
  sam2Model: z.string().default(''),
  aiFrames: z.record(z.boolean()).default({}),
});

let cache: Settings | null = null;

export async function readSettings(): Promise<Settings> {
  if (cache) return cache;
  try {
    cache = SettingsSchema.parse(JSON.parse(await readFile(settingsPath(), 'utf8')));
  } catch {
    cache = SettingsSchema.parse({});
  }
  return cache;
}

export async function updateSettings(fn: (s: Settings) => Settings): Promise<Settings> {
  const next = fn(await readSettings());
  cache = next;
  await writeAtomic(settingsPath(), JSON.stringify(next, null, 2));
  return next;
}

export async function noteRecent(path: string): Promise<Settings> {
  const next = await updateSettings((s) => ({ ...s, recent: [path, ...s.recent.filter((p) => p !== path)].slice(0, MAX_RECENT) }));
  app.addRecentDocument(path);
  return next;
}
