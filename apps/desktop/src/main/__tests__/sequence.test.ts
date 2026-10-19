import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdir, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { detectFfmpeg, generateSequence } from '../sequence';
import { makeDrive } from './fixtures';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

describe('detectFfmpeg', () => {
  it('reports a missing binary', async () => {
    expect(await detectFfmpeg('/definitely/not/ffmpeg')).toEqual({ found: false, path: null, version: null });
  });
});

describe.skipIf(!hasFfmpeg)('generateSequence (real ffmpeg)', () => {
  it('writes exactly the planned frames, renumbered from 1001, into 01_PLATES', async () => {
    const { project, drive, root } = await makeDrive([{ shotId: 'A', sourcePath: 'VFX/A/a.mov', checksum: 'none' }]);
    const clip = join(drive, 'VFX/A/a.mov');
    await mkdir(dirname(clip), { recursive: true });
    const made = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=64x36:rate=24', '-t', '2', '-pix_fmt', 'yuv420p', clip]);
    expect(made.status).toBe(0);
    const progress: number[] = [];
    const r = await generateSequence({ project, shotId: 'A', outputRoot: join(root, 'OUT'), ffmpeg: 'ffmpeg', onProgress: (f) => progress.push(f) });
    if (!r.ok) throw new Error(r.reason);
    // frameIn 10..19 with 2 handles → source 8..21 → 14 frames, 1001..1014.
    expect(r.frames).toBe(14);
    const files = (await readdir(r.folder)).sort();
    expect(files[0]).toBe('A_plate_v001.1001.png');
    expect(files[files.length - 1]).toBe('A_plate_v001.1014.png');
    expect(r.folder.endsWith(join('SHOT_A', '01_PLATES'))).toBe(true);
    expect(await readdir(dirname(clip))).toEqual(['a.mov']);
  });
});
