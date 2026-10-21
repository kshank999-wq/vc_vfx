import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';
import { versionTag, type IsolateTarget } from '@vcvfx/domain';
import type { CachedMatte, CachedPlate } from '../../shared/isolate/view';

/**
 * The review cache of built isolations (addendum 11 §4): what the viewer
 * shows after a build — each frame's matte, foreground, confidence and edge
 * band, and its plate and unresolved mask, at working resolution — per
 * (project, shot, target, task version, settings revision), in the app's own
 * folder: `userData/Isolate Cache/<project>/<shot>/sky/v001/r7/1001.m.bin`.
 * Never beside the media and never in the package: exports are made again at
 * plate resolution from source + settings. A new build clears the older
 * revisions of its version.
 */

const safe = (s: string) => s.replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 80) || '_';

export class IsolateCache {
  readonly root: string;

  constructor(cacheRoot: string, projectKey: string, shotId: string, target: IsolateTarget) {
    this.root = join(cacheRoot, createHash('sha256').update(projectKey).digest('hex').slice(0, 16), safe(shotId), target);
  }

  static at(root: string): IsolateCache {
    const c = Object.create(IsolateCache.prototype) as IsolateCache;
    (c as { root: string }).root = root;
    return c;
  }

  dir(version: number, revision: number): string {
    return join(this.root, versionTag(version), `r${Math.round(revision)}`);
  }

  private file(version: number, revision: number, frame: number, kind: 'm' | 'p'): string {
    return join(this.dir(version, revision), `${Math.round(frame)}.${kind}.bin`);
  }

  /** Forget every other revision of this version (a new build starts). */
  async startBuild(version: number, revision: number): Promise<void> {
    const base = join(this.root, versionTag(version));
    for (const name of await readdir(base).catch(() => [] as string[])) if (name !== `r${revision}`) await rm(join(base, name), { recursive: true, force: true });
    await rm(this.dir(version, revision), { recursive: true, force: true });
    await mkdir(this.dir(version, revision), { recursive: true });
  }

  private async write(path: string, meta: object, parts: (Uint8Array | Uint8ClampedArray)[]): Promise<void> {
    const m = Buffer.from(JSON.stringify(meta));
    const head = Buffer.alloc(4);
    head.writeUInt32LE(m.length, 0);
    const body = deflateSync(Buffer.concat([head, m, ...parts.map((p) => Buffer.from(p.buffer, p.byteOffset, p.byteLength))]), { level: 3 });
    const tmp = `${path}.${process.pid}.${Date.now()}.part`;
    await writeFile(tmp, body);
    await rename(tmp, path);
  }

  private async read(path: string): Promise<{ meta: Record<string, unknown>; body: Buffer } | null> {
    const buf = await readFile(path).catch(() => null);
    if (!buf) return null;
    try {
      const raw = inflateSync(buf);
      const len = raw.readUInt32LE(0);
      return { meta: JSON.parse(raw.subarray(4, 4 + len).toString()) as Record<string, unknown>, body: raw.subarray(4 + len) };
    } catch {
      return null;
    }
  }

  async putMatte(version: number, revision: number, frame: number, m: CachedMatte): Promise<void> {
    await mkdir(this.dir(version, revision), { recursive: true });
    await this.write(this.file(version, revision, frame, 'm'), { width: m.width, height: m.height, metrics: m.metrics }, [m.matte, m.foreground, m.confidence, m.band]);
  }

  async putPlate(version: number, revision: number, frame: number, p: CachedPlate): Promise<void> {
    await mkdir(this.dir(version, revision), { recursive: true });
    await this.write(this.file(version, revision, frame, 'p'), { width: p.width, height: p.height, share: p.share }, [p.plate, p.unresolved]);
  }

  async getMatte(version: number, revision: number, frame: number): Promise<CachedMatte | null> {
    const r = await this.read(this.file(version, revision, frame, 'm'));
    if (!r) return null;
    const { width, height, metrics } = r.meta as { width: number; height: number; metrics: CachedMatte['metrics'] };
    const n = width * height;
    let at = 0;
    const take = (len: number) => r.body.subarray(at, (at += len));
    return { width, height, metrics, matte: new Uint8Array(take(n)), foreground: new Uint8ClampedArray(take(3 * n)), confidence: new Uint8Array(take(n)), band: new Uint8Array(take(n)) };
  }

  async getPlate(version: number, revision: number, frame: number): Promise<CachedPlate | null> {
    const r = await this.read(this.file(version, revision, frame, 'p'));
    if (!r) return null;
    const { width, height, share } = r.meta as { width: number; height: number; share: number };
    const n = width * height;
    return { width, height, share, plate: new Uint8ClampedArray(r.body.subarray(0, 3 * n)), unresolved: new Uint8Array(r.body.subarray(3 * n, 4 * n)) };
  }
}
