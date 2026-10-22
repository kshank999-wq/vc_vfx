import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';
import { versionTag } from '@vcvfx/domain';
import type { TextureScanView } from '../../shared/texture/bridge-types';
import type { CachedRegion } from '../../shared/texture/view';

/**
 * The review cache of built textures (addendum 12 §4): what the viewer shows
 * after a build — each region's original, delit and tiled texture (8-bit
 * sRGB, at most 1024 wide) and its mask, and the scan with its planes — per
 * (project, shot, task version, settings revision), in the app's own folder:
 * `userData/Texture Cache/<project>/<shot>/v001/r7/r4.bin`. Never beside the
 * references and never in the package: exports are made again at full
 * resolution from source + settings. A new build clears the older revisions
 * of its version.
 */

const safe = (s: string) => s.replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 80) || '_';

async function writePacked(path: string, meta: object, parts: (Uint8Array | Uint8ClampedArray | Float32Array)[]): Promise<void> {
  const m = Buffer.from(JSON.stringify(meta));
  const head = Buffer.alloc(4);
  head.writeUInt32LE(m.length, 0);
  const body = deflateSync(Buffer.concat([head, m, ...parts.map((p) => Buffer.from(p.buffer, p.byteOffset, p.byteLength))]), { level: 3 });
  const tmp = `${path}.${process.pid}.${Date.now()}.part`;
  await writeFile(tmp, body);
  await rename(tmp, path);
}

async function readPacked(path: string): Promise<{ meta: Record<string, unknown>; body: Buffer } | null> {
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

export class TextureCache {
  readonly root: string;

  constructor(cacheRoot: string, projectKey: string, shotId: string) {
    this.root = join(cacheRoot, createHash('sha256').update(projectKey).digest('hex').slice(0, 16), safe(shotId));
  }

  static at(root: string): TextureCache {
    const c = Object.create(TextureCache.prototype) as TextureCache;
    (c as { root: string }).root = root;
    return c;
  }

  dir(version: number, revision: number): string {
    return join(this.root, versionTag(version), `r${Math.round(revision)}`);
  }

  /** Forget every other revision of this version (a new build starts). */
  async startBuild(version: number, revision: number): Promise<void> {
    const base = join(this.root, versionTag(version));
    for (const name of await readdir(base).catch(() => [] as string[])) if (name !== `r${revision}`) await rm(join(base, name), { recursive: true, force: true });
    await rm(this.dir(version, revision), { recursive: true, force: true });
    await mkdir(this.dir(version, revision), { recursive: true });
  }

  /** The newest revision of a version with anything in it, or null. */
  async latest(version: number): Promise<number | null> {
    const names = await readdir(join(this.root, versionTag(version))).catch(() => [] as string[]);
    const revs = names.map((n) => /^r(\d+)$/.exec(n)).filter((m): m is RegExpExecArray => m !== null).map((m) => Number(m[1]));
    return revs.length ? Math.max(...revs) : null;
  }

  async putRegion(version: number, revision: number, r: CachedRegion): Promise<void> {
    await mkdir(this.dir(version, revision), { recursive: true });
    const meta = { regionId: r.regionId, o: [r.original.width, r.original.height], d: [r.delit.width, r.delit.height], t: r.tiled ? [r.tiled.width, r.tiled.height] : null, m: [r.maskWidth, r.maskHeight] };
    await writePacked(join(this.dir(version, revision), `${safe(r.regionId)}.bin`), meta, [r.original.rgb, r.delit.rgb, ...(r.tiled ? [r.tiled.rgb] : []), r.mask]);
  }

  async getRegion(version: number, revision: number, regionId: string): Promise<CachedRegion | null> {
    const r = await readPacked(join(this.dir(version, revision), `${safe(regionId)}.bin`));
    if (!r) return null;
    const m = r.meta as { o: [number, number]; d: [number, number]; t: [number, number] | null; m: [number, number] };
    let at = 0;
    const take = (len: number) => r.body.subarray(at, (at += len));
    const pic = (wh: [number, number]) => ({ width: wh[0], height: wh[1], rgb: new Uint8ClampedArray(take(3 * wh[0] * wh[1])) });
    const original = pic(m.o);
    const delit = pic(m.d);
    const tiled = m.t ? pic(m.t) : null;
    return { regionId, original, delit, tiled, mask: new Uint8Array(take(m.m[0] * m.m[1])), maskWidth: m.m[0], maskHeight: m.m[1] };
  }

  async putScan(version: number, revision: number, v: TextureScanView): Promise<void> {
    await mkdir(this.dir(version, revision), { recursive: true });
    const n = v.positions.length / 3;
    const meta = { n, colors: Boolean(v.colors), planeOf: Boolean(v.planeOf), origin: v.origin, planeIds: v.planeIds, panorama: v.panorama, patches: v.patches };
    await writePacked(join(this.dir(version, revision), 'scan.bin'), meta, [new Float32Array(v.positions), ...(v.colors ? [v.colors] : []), ...(v.planeOf ? [v.planeOf] : [])]);
  }

  async getScan(version: number, revision: number): Promise<Omit<TextureScanView, 'built'> | null> {
    const r = await readPacked(join(this.dir(version, revision), 'scan.bin'));
    if (!r) return null;
    const m = r.meta as { n: number; colors: boolean; planeOf: boolean; origin: [number, number, number]; planeIds: string[]; panorama: [number, number, number] | null; patches: TextureScanView['patches'] };
    let at = 0;
    const take = (len: number) => r.body.subarray(at, (at += len));
    const pos = take(12 * m.n);
    return {
      positions: new Float32Array(pos.buffer.slice(pos.byteOffset, pos.byteOffset + pos.byteLength)),
      colors: m.colors ? new Uint8Array(take(3 * m.n)) : null,
      planeOf: m.planeOf ? new Uint8Array(take(m.n)) : null,
      origin: m.origin,
      planeIds: m.planeIds,
      panorama: m.panorama,
      patches: m.patches,
    };
  }
}
