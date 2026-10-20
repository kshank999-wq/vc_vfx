import { describe, expect, it } from 'vitest';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FrameCache, frameKey, frameUrl, resolveFrameUrl } from '../frame-cache';

const HASH = 'a'.repeat(64);

describe('resolveFrameUrl', () => {
  const dir = join(tmpdir(), 'vcvfx-cache');
  it('serves a cache file by its hash', () => {
    expect(resolveFrameUrl(frameUrl(HASH), dir)).toBe(join(dir, `${HASH}.jpg`));
  });

  it.each([
    `vcvfx-frame://cache/../${HASH}.jpg`,
    `vcvfx-frame://cache/%2e%2e/${HASH}.jpg`,
    `vcvfx-frame://cache/..%2f..%2fsecret.jpg`,
    `vcvfx-frame://cache/%2e%2e%2f%2e%2e%2fetc%2fpasswd`,
    `vcvfx-frame://cache/sub/${HASH}.jpg`,
    `vcvfx-frame://cache/${HASH}.jpg%00.png`,
    `vcvfx-frame://cache/${HASH}.png`,
    `vcvfx-frame://cache/${'A'.repeat(64)}.jpg`,
    `vcvfx-frame://cache/${HASH}.jpg?x=1`,
    `vcvfx-frame://cache/${HASH}.jpg#x`,
    `vcvfx-frame://elsewhere/${HASH}.jpg`,
    `vcvfx-frame://cache:8080/${HASH}.jpg`,
    `file:///etc/passwd`,
    `vcvfx-frame://cache/C:%5CWindows%5Cwin.ini`,
    `vcvfx-frame://cache/%5c..%5c${HASH}.jpg`,
    'not a url',
  ])('refuses %s', (url) => {
    expect(resolveFrameUrl(url, dir)).toBeNull();
  });
});

describe('FrameCache', () => {
  const jpeg = (bytes: number) => async (tmp: string) => writeFile(tmp, Buffer.alloc(bytes, 1));

  it('produces once, then hits; concurrent requests share one extraction', async () => {
    const cache = new FrameCache({ dir: await mkdtemp(join(tmpdir(), 'vcvfx-fc-')) });
    let runs = 0;
    const produce = async (tmp: string) => {
      runs += 1;
      await new Promise((r) => setTimeout(r, 20));
      await writeFile(tmp, 'jpeg');
    };
    const [a, b] = await Promise.all([cache.get(HASH, produce), cache.get(HASH, produce)]);
    expect(a.file).toBe(b.file);
    expect(runs).toBe(1);
    expect((await cache.get(HASH, produce)).cached).toBe(true);
    expect(runs).toBe(1);
    expect((await readdir(cache.dir)).filter((f) => f.includes('.part'))).toEqual([]);
  });

  it('removes least recently used frames above its cap', async () => {
    const cache = new FrameCache({ dir: await mkdtemp(join(tmpdir(), 'vcvfx-fc-')), capBytes: 3000 });
    const keys = ['1', '2', '3', '4'].map((k) => frameKey({ k }));
    for (const k of keys.slice(0, 3)) {
      await cache.get(k, jpeg(1000));
      await new Promise((r) => setTimeout(r, 5));
    }
    await cache.get(keys[0]!, jpeg(1000)); // touch the oldest: now most recent
    await new Promise((r) => setTimeout(r, 5));
    await cache.get(keys[3]!, jpeg(1000));
    const left = await readdir(cache.dir);
    expect(left).toContain(`${keys[0]}.jpg`);
    expect(left).not.toContain(`${keys[1]}.jpg`);
    expect(await cache.size()).toBeLessThanOrEqual(3000);
  });

  it('does not keep a failed extraction', async () => {
    const cache = new FrameCache({ dir: await mkdtemp(join(tmpdir(), 'vcvfx-fc-')) });
    await expect(cache.get(HASH, async (tmp) => { await writeFile(tmp, 'half'); throw new Error('ffmpeg failed'); })).rejects.toThrow('ffmpeg failed');
    expect(await readdir(cache.dir)).toEqual([]);
  });

  it('serves frames the viewer waits for before queued prefetches, and drops stale prefetches', async () => {
    const cache = new FrameCache({ dir: await mkdtemp(join(tmpdir(), 'vcvfx-fc-')), concurrency: 1, maxQueuedPrefetch: 2 });
    const order: string[] = [];
    const slow = (name: string) => async (tmp: string) => {
      order.push(name);
      await new Promise((r) => setTimeout(r, 5));
      await writeFile(tmp, name);
    };
    const first = cache.get(frameKey({ n: 'busy' }), slow('busy'));
    const pre = ['p1', 'p2', 'p3'].map((n) => cache.get(frameKey({ n }), slow(n), { prefetch: true }).catch((e: Error) => e.message));
    const wanted = cache.get(frameKey({ n: 'now' }), slow('now'));
    await Promise.all([first, wanted, ...pre]);
    expect(order[0]).toBe('busy');
    expect(order[1]).toBe('now');
    expect(await pre[0]).toBe('Prefetch dropped');
    expect(order).toEqual(['busy', 'now', 'p2', 'p3']);
  });
});
