import { describe, expect, it } from 'vitest';
import { sequencePlan, type OutputSpec } from '@vcvfx/domain';
import { buildFfmpegArgs, clipRange, encoderArgs, parseFfmpegFrame } from '../ffmpeg-args';

const out = (format: OutputSpec['format'], bitDepth: OutputSpec['bitDepth']): OutputSpec => ({ format, bitDepth, startFrame: 1001 });
const arg = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

describe('clipRange', () => {
  it('treats frameIn as clip-relative without timecode', () => {
    const plan = sequencePlan({ frameIn: 100, frameOut: 199, handles: 8 }, out('exr', 16));
    expect(clipRange({ plan, frameRate: 24, frameIn: 100 })).toEqual({ selectIn: 92, selectOut: 207, startNumber: 1001, frameCount: 116, missingHead: 0 });
  });

  it('subtracts the clip start timecode from absolute frame numbers', () => {
    // 01:00:00:00 at 24 fps is 86400; the in-point is 48 frames into the clip.
    const plan = sequencePlan({ frameIn: 86448, frameOut: 86471, handles: 8 }, out('dpx', 10));
    const r = clipRange({ plan, frameRate: 24, frameIn: 86448, timecodeIn: '01:00:00:00' });
    expect(r).toMatchObject({ selectIn: 40, selectOut: 79, startNumber: 1001, frameCount: 40 });
    expect(r.frameCount).toBe(plan.frameCount);
  });

  it('starts at the clip head and shifts numbering when the head handle is not there', () => {
    // The sample's 010_020: in-point equals the clip's first frame.
    const plan = sequencePlan({ frameIn: 86400, frameOut: 86511, handles: 8 }, out('dpx', 10));
    const r = clipRange({ plan, frameRate: 24, frameIn: 86400, timecodeIn: '01:00:00:00' });
    expect(r).toEqual({ selectIn: 0, selectOut: 119, startNumber: 1009, frameCount: 120, missingHead: 8 });
    // Editorial frames keep the delivered numbers the plan promised.
    expect(r.startNumber).toBe(plan.editorialIn);
  });

  it('refuses a shot that lies before its clip', () => {
    const plan = sequencePlan({ frameIn: 10, frameOut: 20, handles: 0 }, out('exr', 16));
    expect(() => clipRange({ plan, frameRate: 24, frameIn: 10, timecodeIn: '00:00:10:00' })).toThrow(/before the start/);
  });
});

describe('encoderArgs', () => {
  it('picks pixel formats by format and bit depth', () => {
    expect(encoderArgs('dpx', 10)).toEqual(['-c:v', 'dpx', '-pix_fmt', 'gbrp10le']);
    expect(encoderArgs('dpx', 12)).toContain('gbrp12le');
    expect(encoderArgs('dpx', 16)).toContain('rgb48le');
    expect(encoderArgs('tiff', 16)).toContain('rgb48le');
    expect(encoderArgs('tiff', 8)).toContain('rgb24');
    expect(encoderArgs('png', 16)).toContain('rgb48be');
    expect(encoderArgs('exr', 16)).toEqual(['-c:v', 'exr', '-pix_fmt', 'gbrpf32le', '-format', 'half', '-compression', 'zip16']);
    expect(encoderArgs('exr', 32)).toContain('float');
    expect(encoderArgs('exr', 16, 'RLE')).toContain('rle');
  });
});

describe('buildFfmpegArgs', () => {
  const plan = sequencePlan({ frameIn: 100, frameOut: 199, handles: 8 }, out('exr', 16));
  const cmd = buildFfmpegArgs({ input: '/drive/VFX/clip.mxf', output: '/out/01_PLATES/010_plate_v001.%04d.exr', plan, frameRate: 24, frameIn: 100, compression: 'PIZ' });

  it('selects frames by index, renumbers and never overwrites', () => {
    expect(arg(cmd.args, '-i')).toBe('/drive/VFX/clip.mxf');
    expect(arg(cmd.args, '-vf')).toBe("select='between(n\\,92\\,207)'");
    expect(arg(cmd.args, '-frames:v')).toBe('116');
    expect(arg(cmd.args, '-start_number')).toBe('1001');
    expect(cmd.args).toContain('-n');
    expect(cmd.args).not.toContain('-y');
    expect(cmd.args[cmd.args.length - 1]).toBe('/out/01_PLATES/010_plate_v001.%04d.exr');
  });

  it('applies no LUT or colour transform', () => {
    const filters = arg(cmd.args, '-vf') ?? '';
    for (const forbidden of ['lut', 'colorspace', 'zscale', 'tonemap', 'colormatrix', 'eq=']) expect(filters).not.toContain(forbidden);
    expect(cmd.args.join(' ')).not.toMatch(/lut3d|-color_trc|-colorspace/);
  });

  it('notes a compression ffmpeg cannot write', () => {
    expect(cmd.notes.join(' ')).toMatch(/PIZ/);
  });
});

describe('parseFfmpegFrame', () => {
  it('reads the last frame count in a chunk', () => {
    expect(parseFfmpegFrame('frame=   12 fps=0.0 q=-0.0 size=N/A\rframe=   48 fps=24 q=-0.0')).toBe(48);
    expect(parseFfmpegFrame('Input #0, mov')).toBeNull();
  });
});
