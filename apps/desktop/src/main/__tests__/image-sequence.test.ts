import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CAMERA_RAW_MESSAGE, cameraRawProblem, detectImageSequence, parseFrameName, printfPattern, sequenceFromNames } from '../image-sequence';

describe('camera raw', () => {
  it.each(['A001C002.R3D', 'clip.braw', 'A_0001.ari', 'x.arx', 'MVI.CRM', 'frame_0001.dng', 'clip.NEV'])('refuses %s', (f) => {
    expect(cameraRawProblem(`/drive/${f}`)).toBe(CAMERA_RAW_MESSAGE);
  });
  it.each(['clip.mov', 'clip.mxf', 'A_0001.dpx'])('reads %s', (f) => {
    expect(cameraRawProblem(`/drive/${f}`)).toBeNull();
  });
});

describe('frame names', () => {
  it('finds the last number before the extension', () => {
    expect(parseFrameName('A001C002_0086400.dpx')).toEqual({ prefix: 'A001C002_', number: 86400, padding: 7, suffix: '.dpx' });
    expect(parseFrameName('shot.1001.exr')).toEqual({ prefix: 'shot.', number: 1001, padding: 4, suffix: '.exr' });
    expect(parseFrameName('plate.exr')).toBeNull();
    expect(printfPattern({ prefix: '50%_', padding: 4, suffix: '.tif' })).toBe('50%%_%04d.tif');
  });

  it('counts the unbroken run from the named frame and reports a gap', () => {
    const names = ['a_0010.dpx', 'a_0011.dpx', 'a_0012.dpx', 'a_0014.dpx', 'b_0011.dpx', 'a_011.dpx', 'a_0013.exr'];
    expect(sequenceFromNames('/d/a_0010.dpx', names)).toEqual({ patternName: 'a_%04d.dpx', startNumber: 10, count: 3, padding: 4, gapAt: 13 });
    expect(sequenceFromNames('/d/a_0014.dpx', names)).toMatchObject({ count: 1, gapAt: null });
  });

  it('reads a folder; a movie file is not a sequence', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vcvfx-seq-'));
    for (const n of [1001, 1002, 1003]) await writeFile(join(dir, `p.${n}.exr`), '');
    expect(await detectImageSequence(join(dir, 'p.1001.exr'))).toEqual({ pattern: join(dir, 'p.%04d.exr'), startNumber: 1001, count: 3, padding: 4, gapAt: null });
    expect(await detectImageSequence(join(dir, 'clip.mov'))).toBeNull();
  });
});
