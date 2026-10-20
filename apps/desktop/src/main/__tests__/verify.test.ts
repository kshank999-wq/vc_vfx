import { describe, expect, it } from 'vitest';
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { verifyProject } from '../verify';
import { makeDrive } from './fixtures';

describe('verifyProject', () => {
  it('streams sha256 and reports verified, mismatch, missing and unchecked', async () => {
    const { project, drive } = await makeDrive([
      { shotId: 'A', sourcePath: 'VFX/A/a.mov', bytes: Buffer.alloc(9 * 1024 * 1024, 7), checksum: 'right' },
      { shotId: 'B', sourcePath: 'VFX/B/b.mov', bytes: Buffer.from('bytes'), checksum: 'wrong' },
      { shotId: 'C', sourcePath: 'VFX/C/c.mov', checksum: 'right' },
      { shotId: 'D', sourcePath: 'VFX/D/d.mov', bytes: Buffer.from('d'), checksum: 'xxh128' },
      { shotId: 'E', sourcePath: 'VFX/E/e.mov', bytes: Buffer.from('e'), checksum: 'none' },
      { shotId: 'F', sourcePath: 'VFX/F/f.mov', bytes: Buffer.from('f'), checksum: 'md5' },
      { shotId: 'G', sourcePath: 'VFX/G/g.mov', bytes: Buffer.from('g'), checksum: 'md5-wrong' },
    ]);
    const before = await readdir(dirname(join(drive, 'VFX/A/a.mov')));
    const progress: number[] = [];
    const results = await verifyProject(project, { onProgress: (p) => progress.push(p.bytesDone) });
    expect(Object.fromEntries(results.map((r) => [r.shotId, r.result]))).toEqual({
      A: 'verified',
      B: 'mismatch',
      C: 'missing',
      D: 'unchecked',
      E: 'unchecked',
      F: 'verified',
      G: 'mismatch',
    });
    expect(results.find((r) => r.shotId === 'D')!.detail).toMatch(/not computed: .*xxh128/);
    expect(progress.length).toBeGreaterThan(1);
    // Read only: nothing appeared beside the source.
    expect(await readdir(dirname(join(drive, 'VFX/A/a.mov')))).toEqual(before);
  });

  it('can be cancelled', async () => {
    const { project } = await makeDrive([{ shotId: 'A', sourcePath: 'VFX/A/a.mov', bytes: Buffer.alloc(32 * 1024 * 1024, 1), checksum: 'right' }]);
    const controller = new AbortController();
    controller.abort();
    await expect(verifyProject(project, { signal: controller.signal })).rejects.toThrow(/Cancelled/);
  });
});
