import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdir, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { detectFfmpeg, generateSequence, sourceInputFor } from '../sequence';
import { makeDrive } from './fixtures';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

describe('detectFfmpeg', () => {
  it('reports a missing binary', async () => {
    expect(await detectFfmpeg('/definitely/not/ffmpeg')).toMatchObject({ found: false, path: null, version: null, problem: expect.stringMatching(/Settings/) });
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
    if (r.ok) expect(r.record.color).toMatchObject({ policy: { mode: 'as_shot' }, lookApplied: false });
    if (!r.ok) throw new Error(r.reason);
    // frameIn 10..19 with 2 handles → source 8..21 → 14 frames, 1001..1014.
    expect(r.frames).toBe(14);
    const files = (await readdir(r.folder)).sort();
    expect(files[0]).toBe('A_plate_v001.1001.png');
    expect(files[files.length - 1]).toBe('A_plate_v001.1014.png');
    expect(r.folder.endsWith(join('SHOT_A', '01_PLATES'))).toBe(true);
    expect(await readdir(dirname(clip))).toEqual(['a.mov']);
  });

  it('reads an image sequence numbered in the handoff frames (no timecodeIn) from the right files', async () => {
    // Files C_0001996 … C_0002035: frameIn 2000 with 4 handles is the first file, not the 2001st.
    const { project, drive, root } = await makeDrive([{ shotId: 'S', sourcePath: 'VFX/S/C_0001996.png', checksum: 'none', extra: { frameIn: 2000, frameOut: 2031, handles: 4 } }]);
    const dir = join(drive, 'VFX/S');
    await mkdir(dir, { recursive: true });
    const made = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=64x36:rate=24', '-frames:v', '40', '-start_number', '1996', join(dir, 'C_%07d.png')]);
    expect(made.status).toBe(0);
    const resolved = await sourceInputFor(join(dir, 'C_0001996.png'), 24, { frameIn: 2000, from: 'handoff' });
    expect(resolved).toMatchObject({ ok: true, clipStart: 1996 });
    // A timecode, or a range below the first file number, keeps the old reading.
    expect(await sourceInputFor(join(dir, 'C_0001996.png'), 24, { frameIn: 2000, timecodeIn: '00:01:23:08', from: 'handoff' })).not.toHaveProperty('clipStart');
    expect(await sourceInputFor(join(dir, 'C_0001996.png'), 24, { frameIn: 3, from: 'handoff' })).not.toHaveProperty('clipStart');

    const r = await generateSequence({ project, shotId: 'S', outputRoot: join(root, 'OUT'), ffmpeg: 'ffmpeg' });
    if (!r.ok) throw new Error(r.reason);
    expect(r.frames).toBe(40);
    expect(r.notes.join(' ')).not.toMatch(/fewer head-handle/);
    const pixels = (file: string) => createHash('sha256').update(spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']).stdout).digest('hex');
    expect(pixels(join(r.folder, 'S_plate_v001.1001.png'))).toBe(pixels(join(dir, 'C_0001996.png')));
    expect(pixels(join(r.folder, 'S_plate_v001.1040.png'))).toBe(pixels(join(dir, 'C_0002035.png')));
  });
});
