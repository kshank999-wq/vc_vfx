import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ROTO_PART_ID, versionTag } from '@vcvfx/domain';
import type { Mask } from '../../shared/roto/image';
import { decodePng, encodePng } from './png';

/**
 * The working mattes (addendum 04): what the engines produced, one 8-bit
 * greyscale PNG per frame at working resolution, cached per
 * (project, shot, part, roto version, frame) in the app's own folder —
 * `userData/Roto Cache/<project>/<shot>/<part>/v001/1001.png`. Never beside
 * the media and never in the package: exported mattes are written separately,
 * at plate resolution, versioned (export.ts).
 *
 * A frame not found in the current version is looked for in earlier ones, so
 * a reopened roto (v002) starts from the mattes v001 had.
 */

const safe = (s: string) => s.replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 80) || '_';

export class MaskStore {
  readonly root: string;

  constructor(cacheRoot: string, projectKey: string, shotId: string) {
    this.root = join(cacheRoot, createHash('sha256').update(projectKey).digest('hex').slice(0, 16), safe(shotId));
  }

  /** The same store, by its folder (how a worker thread is handed it). */
  static at(root: string): MaskStore {
    const store = Object.create(MaskStore.prototype) as MaskStore;
    (store as { root: string }).root = root;
    return store;
  }

  dir(partId: string, version: number): string {
    if (!ROTO_PART_ID.test(partId)) throw new Error(`Not a part id: ${partId}`);
    return join(this.root, partId, versionTag(version));
  }

  file(partId: string, version: number, frame: number): string {
    return join(this.dir(partId, version), `${Math.round(frame)}.png`);
  }

  async put(partId: string, version: number, frame: number, mask: Mask): Promise<void> {
    const dir = this.dir(partId, version);
    await mkdir(dir, { recursive: true });
    const path = this.file(partId, version, frame);
    const tmp = `${path}.${process.pid}.${Date.now()}.part`;
    await writeFile(tmp, encodePng({ width: mask.width, height: mask.height, bitDepth: 8, data: mask.data }, { level: 3 }));
    await rename(tmp, path);
  }

  /** The matte of a frame in `version`, or else in the newest earlier version that has it. */
  async get(partId: string, version: number, frame: number): Promise<Mask | null> {
    for (let v = version; v >= 1; v -= 1) {
      const buf = await readFile(this.file(partId, v, frame)).catch(() => null);
      if (!buf) continue;
      const img = decodePng(buf);
      const data = img.bitDepth === 16 ? Uint8Array.from(img.data as Uint16Array, (x) => x >> 8) : (img.data as Uint8Array);
      return { width: img.width, height: img.height, data };
    }
    return null;
  }

  /** Frames with a matte in `version` (not counting earlier versions). */
  async frames(partId: string, version: number): Promise<number[]> {
    const names = await readdir(this.dir(partId, version)).catch(() => [] as string[]);
    return names
      .map((n) => /^(\d+)\.png$/.exec(n)?.[1])
      .filter((x): x is string => x !== undefined)
      .map(Number)
      .sort((a, b) => a - b);
  }

  /** Forget a part's working mattes (all versions). */
  async clearPart(partId: string): Promise<void> {
    if (!ROTO_PART_ID.test(partId)) return;
    await rm(join(this.root, partId), { recursive: true, force: true });
  }
}
