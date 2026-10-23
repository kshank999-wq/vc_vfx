import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ffprobePathFor, normaliseTimecode, parseFfprobe, parseRational } from '../probe';
import { hashFile } from '../hash';

/** Trimmed real ffprobe output: an ARRI MXF (timecode on the container) and a ProRes MOV (tmcd stream, cover art). */
const MXF = {
  streams: [
    { index: 0, codec_name: 'arriraw', codec_type: 'video', width: 4608, height: 3164, r_frame_rate: '24000/1001', avg_frame_rate: '24000/1001', duration: '10.010000' },
    { index: 1, codec_name: 'pcm_s24le', codec_type: 'audio' },
  ],
  format: { filename: 'A015C002_261007_R1AB.mxf', duration: '10.010000', tags: { timecode: '14:22:10:05' } },
};
const MOV = {
  streams: [
    { index: 0, codec_name: 'mjpeg', codec_type: 'video', width: 300, height: 300, disposition: { attached_pic: 1 } },
    {
      index: 1,
      codec_name: 'prores',
      codec_type: 'video',
      width: 3840,
      height: 2160,
      r_frame_rate: '25/1',
      avg_frame_rate: '25/1',
      nb_frames: '250',
      tags: { handler_name: 'Core Media Video' },
    },
    { index: 2, codec_type: 'data', codec_tag_string: 'tmcd', tags: { timecode: '10:00:00:00' } },
  ],
  format: { duration: '10.000000' },
};

describe('parseFfprobe', () => {
  it('keeps the pixel format and colour tags, dropping “unknown”', () => {
    const doc = { streams: [{ codec_type: 'video', codec_name: 'prores', pix_fmt: 'yuv444p12le', color_space: 'bt709', color_range: 'tv', color_transfer: 'unknown', color_primaries: 'bt709', width: 4096, height: 2160, avg_frame_rate: '24/1', nb_frames: '48' }] };
    expect(parseFfprobe(doc, 'c.mov')).toMatchObject({ pixelFormat: 'yuv444p12le', colorSpace: 'bt709', colorRange: 'tv', colorPrimaries: 'bt709' });
    expect(parseFfprobe(doc, 'c.mov')).not.toHaveProperty('colorTransfer');
  });

  it('reads an MXF: frame count from duration × rate, timecode from the container', () => {
    expect(parseFfprobe(MXF, 'SCENE_014/a.mxf')).toEqual({
      file: 'SCENE_014/a.mxf',
      frameCount: 240,
      timecodeIn: '14:22:10:05',
      frameRate: 23.976,
      resolution: { width: 4608, height: 3164 },
      codec: 'arriraw',
    });
  });

  it('reads a MOV: skips cover art, counts nb_frames, takes the tmcd timecode', () => {
    expect(parseFfprobe(MOV, 'b.mov')).toEqual({ file: 'b.mov', frameCount: 250, timecodeIn: '10:00:00:00', frameRate: 25, resolution: { width: 3840, height: 2160 }, codec: 'prores' });
  });

  it('reads the file’s own pixel aspect (sample_aspect_ratio), leaving out unknown (0:1)', () => {
    const v = (sar?: string) => ({ streams: [{ codec_type: 'video', codec_name: 'dvvideo', width: 1280, height: 1080, avg_frame_rate: '24/1', nb_frames: '10', ...(sar ? { sample_aspect_ratio: sar } : {}) }] });
    expect(parseFfprobe(v('3:2'), 'a.mov')).toMatchObject({ sampleAspect: 1.5 });
    expect(parseFfprobe(v('1:1'), 'a.mov')).toMatchObject({ sampleAspect: 1 });
    expect(parseFfprobe(v('0:1'), 'a.mov')).not.toHaveProperty('sampleAspect');
    expect(parseFfprobe(v(), 'a.mov')).not.toHaveProperty('sampleAspect');
  });

  it('keeps what it can and refuses what is not a picture', () => {
    expect(parseFfprobe({ streams: [{ codec_type: 'video', codec_name: 'dng', r_frame_rate: '0/0' }] }, 'f.dng')).toEqual({ file: 'f.dng', codec: 'dng' });
    expect(parseFfprobe({ streams: [{ codec_type: 'audio' }] }, 'x.wav')).toBeNull();
    expect(parseFfprobe('nonsense', 'x')).toBeNull();
  });

  it('parses rates and timecode forms', () => {
    expect(parseRational('30000/1001')).toBe(29.97);
    expect(parseRational('24')).toBe(24);
    expect(parseRational('0/0')).toBeNull();
    expect(normaliseTimecode('01:00:00;00')).toBe('01:00:00;00');
    expect(normaliseTimecode('01:00:00.12')).toBe('01:00:00:12');
    expect(normaliseTimecode('1:0:0:0')).toBeUndefined();
  });
});

describe('ffprobePathFor', () => {
  it('finds ffprobe beside the configured ffmpeg', () => {
    expect(ffprobePathFor('')).toBe('ffprobe');
    expect(ffprobePathFor('ffmpeg')).toBe('ffprobe');
    expect(ffprobePathFor('/opt/homebrew/bin/ffmpeg')).toBe('/opt/homebrew/bin/ffprobe');
    expect(ffprobePathFor('C:\\Tools\\ffmpeg\\bin\\ffmpeg.exe')).toBe('C:\\Tools\\ffmpeg\\bin\\ffprobe.exe');
  });
});

describe('hashFile', () => {
  it('computes xxh64 as VCDIT writes it (known vectors), with md5, sha1 and sha256 in one read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vcvfx-hash-'));
    await writeFile(join(dir, 'empty'), '');
    await writeFile(join(dir, 'abc'), 'abc');
    expect((await hashFile(join(dir, 'empty'), ['xxh64'])).digests.xxh64).toBe('ef46db3751d8e999');
    const { digests, bytes } = await hashFile(join(dir, 'abc'), ['xxh64', 'md5', 'sha1', 'sha256']);
    expect(bytes).toBe(3);
    expect(digests).toEqual({
      xxh64: '44bc2cf5ad770999',
      md5: '900150983cd24fb0d6963f7d28e17f72',
      sha1: 'a9993e364706816aba3e25717850c26c9cd0d89d',
      sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    });
  });
});
