import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';
import { versionTag, type CleanPlateMetrics } from '@vcvfx/domain';
import type { CachedPlate } from '../../shared/cleanplate/view';

/**
 * The review cache of built clean plates (addendum 10 §7): what the viewer
 * shows after a build — the display picture, confidence and unresolved masks
 * of each frame, at working resolution — per (project, shot, task version,
 * settings revision), in the app's own folder:
 * `userData/Clean Plate Cache/<project>/<shot>/v001/r7/1001.bin`. Never beside
 * the media and never in the package: exported plates are made again at plate
 * resolution from source + settings (export.ts). A new build clears the older
 * revisions of its version.
 */

const safe = (s: string) => s.replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 80) || '_';

export class PlateCache {
  readonly root: string;

  constructor(cacheRoot: string, projectKey: string, shotId: string) {
    this.root = join(cacheRoot, createHash('sha256').update(projectKey).digest('hex').slice(0, 16), safe(shotId));
  }

  static at(root: string): PlateCache {
    const c = Object.create(PlateCache.prototype) as PlateCache;
    (c as { root: string }).root = root;
    return c;
  }

  dir(version: number, revision: number): string {
    return join(this.root, versionTag(version), `r${Math.round(revision)}`);
  }

  file(version: number, revision: number, frame: number): string {
    return join(this.dir(version, revision), `${Math.round(frame)}.bin`);
  }

  /** Forget every other revision of this version (a new build starts). */
  async startBuild(version: number, revision: number): Promise<void> {
    const base = join(this.root, versionTag(version));
    for (const name of await readdir(base).catch(() => [] as string[])) if (name !== `r${revision}`) await rm(join(base, name), { recursive: true, force: true });
    await rm(this.dir(version, revision), { recursive: true, force: true });
    await mkdir(this.dir(version, revision), { recursive: true });
  }

  async put(version: number, revision: number, frame: number, p: CachedPlate): Promise<void> {
    const meta = Buffer.from(JSON.stringify({ width: p.width, height: p.height, metrics: p.metrics }));
    const head = Buffer.alloc(4);
    head.writeUInt32LE(meta.length, 0);
    const body = deflateSync(Buffer.concat([head, meta, Buffer.from(p.plate.buffer, p.plate.byteOffset, p.plate.byteLength), Buffer.from(p.confidence), Buffer.from(p.unresolved)]), { level: 3 });
    const path = this.file(version, revision, frame);
    const tmp = `${path}.${process.pid}.${Date.now()}.part`;
    await mkdir(this.dir(version, revision), { recursive: true });
    await writeFile(tmp, body);
    await rename(tmp, path);
  }

  async get(version: number, revision: number, frame: number): Promise<CachedPlate | null> {
    const buf = await readFile(this.file(version, revision, frame)).catch(() => null);
    if (!buf) return null;
    try {
      const raw = inflateSync(buf);
      const len = raw.readUInt32LE(0);
      const meta = JSON.parse(raw.subarray(4, 4 + len).toString()) as { width: number; height: number; metrics: CleanPlateMetrics };
      const n = meta.width * meta.height;
      let at = 4 + len;
      const plate = new Uint8ClampedArray(raw.subarray(at, at + 3 * n));
      at += 3 * n;
      const confidence = new Uint8Array(raw.subarray(at, at + n));
      at += n;
      const unresolved = new Uint8Array(raw.subarray(at, at + n));
      return { width: meta.width, height: meta.height, plate, confidence, unresolved, metrics: meta.metrics };
    } catch {
      return null;
    }
  }
}
