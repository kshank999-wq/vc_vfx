import { createHash } from 'node:crypto';
import { mkdir, readdir, rename, rm, stat, utimes } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * The viewer's frame cache (addendum 03): JPEGs extracted by ffmpeg, one per
 * (file, frame, view, size), kept on disk in the app's own folder and served
 * to the renderer through the `vcvfx-frame://` protocol. The renderer never
 * gets file:// access; the protocol serves only files of this cache, by a
 * name that is a SHA-256, so a crafted URL cannot reach anything else.
 *
 * Least-recently-used files are removed once the cache passes its cap.
 * Extraction is queued — two at a time — and frames the viewer is waiting
 * for go ahead of neighbours fetched in advance. No Electron here.
 */

export const FRAME_SCHEME = 'vcvfx-frame';
export const FRAME_HOST = 'cache';
const NAME = /^[0-9a-f]{64}\.jpg$/;

export const frameUrl = (hash: string): string => `${FRAME_SCHEME}://${FRAME_HOST}/${hash}.jpg`;

export function frameKey(parts: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/**
 * The cache file a `vcvfx-frame://` URL names, or null when it names anything
 * else: another host, a path with more than one segment, `..` in any
 * spelling, a name that is not `<sha256>.jpg`, or a file outside the cache.
 */
export function resolveFrameUrl(url: string, cacheDir: string): string | null {
  // Refuse dot segments and backslashes in any spelling before URL parsing would normalise them away.
  if (/\.\.|%2e|%5c|\\|%00/i.test(url)) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${FRAME_SCHEME}:` || parsed.hostname !== FRAME_HOST) return null;
  if (parsed.search || parsed.hash || parsed.username || parsed.password || parsed.port) return null;
  let name: string;
  try {
    name = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  } catch {
    return null;
  }
  if (!NAME.test(name)) return null;
  const root = resolve(cacheDir);
  const file = resolve(root, name);
  const rel = relative(root, file);
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || rel.includes(sep)) return null;
  return file;
}

interface Pending {
  key: string;
  priority: number;
  run: () => Promise<void>;
  cancel: () => void;
}

export interface FrameCacheOptions {
  dir: string;
  /** Bytes; least recently used frames are removed above it. */
  capBytes?: number;
  concurrency?: number;
  /** Prefetches waiting beyond this many are dropped, oldest first. */
  maxQueuedPrefetch?: number;
}

export class FrameCache {
  readonly dir: string;
  private readonly cap: number;
  private readonly concurrency: number;
  private readonly maxQueuedPrefetch: number;
  private readonly inFlight = new Map<string, Promise<string>>();
  private readonly queue: Pending[] = [];
  private running = 0;
  private sizes: Map<string, { bytes: number; used: number }> | null = null;
  private indexing: Promise<Map<string, { bytes: number; used: number }>> | null = null;
  private total = 0;

  constructor(options: FrameCacheOptions) {
    this.dir = resolve(options.dir);
    this.cap = options.capBytes ?? 512 * 1024 * 1024;
    this.concurrency = options.concurrency ?? 2;
    this.maxQueuedPrefetch = options.maxQueuedPrefetch ?? 24;
  }

  fileFor(hash: string): string {
    return join(this.dir, `${hash}.jpg`);
  }

  private index(): Promise<Map<string, { bytes: number; used: number }>> {
    this.indexing ??= this.readIndex();
    return this.indexing;
  }

  private async readIndex(): Promise<Map<string, { bytes: number; used: number }>> {
    await mkdir(this.dir, { recursive: true });
    const sizes = new Map<string, { bytes: number; used: number }>();
    let total = 0;
    for (const name of await readdir(this.dir)) {
      if (!NAME.test(name)) continue;
      const s = await stat(join(this.dir, name)).catch(() => null);
      if (!s) continue;
      sizes.set(name, { bytes: s.size, used: s.mtimeMs });
      total += s.size;
    }
    this.sizes = sizes;
    this.total = total;
    return sizes;
  }

  /** Bytes the cache holds now. */
  async size(): Promise<number> {
    await this.index();
    return this.total;
  }

  /**
   * The cached frame for `hash`, producing it with `produce(tmpPath)` when it
   * is not there. `produce` writes a JPEG to the path it is given; it is moved
   * into place only once complete.
   */
  async get(hash: string, produce: (tmpPath: string) => Promise<void>, options: { prefetch?: boolean } = {}): Promise<{ file: string; cached: boolean }> {
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('Bad frame key');
    const sizes = await this.index();
    const name = `${hash}.jpg`;
    const file = this.fileFor(hash);
    const hit = sizes.get(name);
    if (hit && (await stat(file).catch(() => null))) {
      const now = Date.now();
      hit.used = now;
      await utimes(file, now / 1000, now / 1000).catch(() => undefined);
      return { file, cached: true };
    }
    const existing = this.inFlight.get(hash);
    if (existing) {
      if (!options.prefetch) this.promote(hash);
      return { file: await existing, cached: false };
    }
    const promise = new Promise<string>((resolvePromise, reject) => {
      const run = async () => {
        const tmp = join(this.dir, `${hash}.${process.pid}.${Date.now()}.part.jpg`);
        try {
          await produce(tmp);
          const s = await stat(tmp);
          await rename(tmp, file);
          this.sizes?.set(name, { bytes: s.size, used: Date.now() });
          this.total += s.size;
          await this.evict();
          resolvePromise(file);
        } catch (error) {
          await rm(tmp, { force: true }).catch(() => undefined);
          reject(error);
        }
      };
      this.enqueue({ key: hash, priority: options.prefetch ? 0 : 1, run, cancel: () => reject(new Error('Prefetch dropped')) });
    });
    this.inFlight.set(hash, promise);
    try {
      return { file: await promise, cached: false };
    } finally {
      this.inFlight.delete(hash);
    }
  }

  private promote(key: string): void {
    const item = this.queue.find((q) => q.key === key);
    if (item) item.priority = 1;
  }

  private enqueue(item: Pending): void {
    this.queue.push(item);
    const prefetches = this.queue.filter((q) => q.priority === 0);
    if (prefetches.length > this.maxQueuedPrefetch) {
      // The oldest neighbour fetched in advance is no longer near where the viewer is.
      const drop = prefetches[0]!;
      this.queue.splice(this.queue.indexOf(drop), 1);
      drop.cancel();
    }
    this.pump();
  }

  private pump(): void {
    while (this.running < this.concurrency && this.queue.length) {
      // Highest priority first; within it, oldest first.
      let best = 0;
      for (let i = 1; i < this.queue.length; i += 1) if (this.queue[i]!.priority > this.queue[best]!.priority) best = i;
      const [item] = this.queue.splice(best, 1);
      this.running += 1;
      void item!.run().finally(() => {
        this.running -= 1;
        this.pump();
      });
    }
  }

  /** Remove least recently used frames until under the cap. */
  async evict(): Promise<number> {
    const sizes = await this.index();
    if (this.total <= this.cap) return 0;
    let removed = 0;
    const order = [...sizes.entries()].sort((a, b) => a[1].used - b[1].used);
    for (const [name, info] of order) {
      if (this.total <= this.cap * 0.9) break;
      if (this.inFlight.has(name.slice(0, 64))) continue;
      await rm(join(this.dir, name), { force: true }).catch(() => undefined);
      sizes.delete(name);
      this.total -= info.bytes;
      removed += 1;
    }
    return removed;
  }
}
