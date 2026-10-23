import { describe, expect, it } from 'vitest';
import { colorTransform, sequencePlan, viewTransform, type Matrix3, type OutputSpec } from '@vcvfx/domain';
import { buildFfmpegArgs, buildFrameArgs, clipRange, conversionFilters, encoderArgs, matrixFilters, parseFfmpegFrame, zscaleIn } from '../ffmpeg-args';

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

  it('places an image sequence numbered in the handoff frames by its first file (clipStart)', () => {
    const plan = sequencePlan({ frameIn: 2000, frameOut: 2031, handles: 4 }, out('exr', 16));
    expect(clipRange({ plan, frameRate: 24, frameIn: 2000, clipStart: 1996 })).toEqual({ selectIn: 0, selectOut: 39, startNumber: 1001, frameCount: 40, missingHead: 0 });
    // The first file is 1998: two head frames are missing, as for a clip.
    expect(clipRange({ plan, frameRate: 24, frameIn: 2000, clipStart: 1998 })).toMatchObject({ selectIn: 0, startNumber: 1003, missingHead: 2 });
    // A timecode, when given, still decides.
    expect(clipRange({ plan, frameRate: 24, frameIn: 2000, timecodeIn: '00:00:00:00', clipStart: 1996 }).selectIn).toBe(1996);
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
  const cmd = buildFfmpegArgs({ source: { kind: 'clip', path: '/drive/VFX/clip.mxf' }, output: '/out/01_PLATES/010_plate_v001.%04d.exr', plan, frameRate: 24, frameIn: 100, compression: 'PIZ' });

  it('selects frames by index, renumbers and never overwrites', () => {
    expect(arg(cmd.args, '-i')).toBe('/drive/VFX/clip.mxf');
    expect(arg(cmd.args, '-vf')).toBe("select='between(n\\,92\\,207)',zscale=filter=point:dither=none,format=gbrpf32le");
    expect(arg(cmd.args, '-frames:v')).toBe('116');
    expect(arg(cmd.args, '-start_number')).toBe('1001');
    expect(cmd.args).toContain('-n');
    expect(cmd.args).not.toContain('-y');
    expect(cmd.args[cmd.args.length - 1]).toBe('/out/01_PLATES/010_plate_v001.%04d.exr');
  });

  it('states a non-square pixel aspect in the plate headers (setsar, last; never a scale)', () => {
    const c = buildFfmpegArgs({ source: { kind: 'clip', path: '/drive/VFX/clip.mxf' }, output: '/o/p.%04d.exr', plan, frameRate: 24, frameIn: 100, pixelAspect: 4 / 3 });
    // The same graph as a square shot's, with only the header stamp added: no pixel is resampled.
    expect(c.filter).toBe(`${cmd.filter},setsar=4/3`);
    expect(c.filter).not.toMatch(/(^|,)scale=/);
    expect(buildFfmpegArgs({ source: { kind: 'clip', path: '/c.mov' }, output: '/o/p.%04d.exr', plan, frameRate: 24, frameIn: 100, pixelAspect: 10 / 11 }).filter).toContain('setsar=10/11');
    expect(cmd.filter).not.toContain('setsar');
  });

  it('applies no LUT or colour transform as shot: only an exact conversion to float', () => {
    const filters = arg(cmd.args, '-vf') ?? '';
    for (const forbidden of ['lut', 'colorspace', 'colorchannelmixer', 'tonemap', 'colormatrix', 'eq=', 'transfer', 'primaries']) expect(filters).not.toContain(forbidden);
    expect(cmd.args.join(' ')).not.toMatch(/lut3d|-color_trc|-colorspace/);
    expect(cmd.filter).toBe(filters);
  });

  it('leaves an RGB source going to an integer format untouched', () => {
    const dpx = sequencePlan({ frameIn: 0, frameOut: 9, handles: 0 }, out('dpx', 10));
    const c = buildFfmpegArgs({ source: { kind: 'sequence', pattern: '/d/A_%07d.dpx', startNumber: 86400, frameRate: 24 }, output: '/o/p.%04d.dpx', plan: dpx, frameRate: 24, frameIn: 0 });
    expect(c.args).not.toContain('-vf');
    expect(c.filter).toBe('');
  });

  it('reads YCbCr exactly with zscale, stating Rec.709 when untagged', () => {
    const dpx = sequencePlan({ frameIn: 0, frameOut: 9, handles: 0 }, out('dpx', 10));
    const notes: string[] = [];
    expect(zscaleIn({ yuv: true }, notes)).toBe('zscale=filter=point:dither=none:matrixin=709:rangein=limited');
    expect(notes[0]).toMatch(/Rec.709/);
    expect(zscaleIn({ yuv: true, colorSpace: 'bt709', colorRange: 'tv' }, [])).toBe('zscale=filter=point:dither=none');
    const c = buildFfmpegArgs({ source: { kind: 'clip', path: '/c.mov' }, output: '/o/p.%04d.dpx', plan: dpx, frameRate: 24, frameIn: 0, hints: { yuv: true, colorSpace: 'bt709' } });
    expect(c.filter).toBe("select='between(n\\,0\\,9)',zscale=filter=point:dither=none:rangein=limited,format=gbrp10le");
  });

  it('falls back to swscale, with a note, when the ffmpeg has no zscale', () => {
    const c = buildFfmpegArgs({ source: { kind: 'clip', path: '/c.mov' }, output: '/o/p.%04d.exr', plan, frameRate: 24, frameIn: 100, caps: { zscale: false, lut1d: true, colorchannelmixer: true } });
    expect(c.filter).toBe("select='between(n\\,92\\,207)',format=gbrpf32le");
    expect(c.notes.join(' ')).toMatch(/swscale/);
  });

  it('notes a compression ffmpeg cannot write', () => {
    expect(cmd.notes.join(' ')).toMatch(/PIZ/);
  });
});

describe('image-sequence sources', () => {
  it('enter the sequence at the first wanted file, without select', () => {
    const p = sequencePlan({ frameIn: 10, frameOut: 19, handles: 2 }, out('exr', 16));
    const c = buildFfmpegArgs({ source: { kind: 'sequence', pattern: '/d/A_%07d.dpx', startNumber: 86400, frameRate: 23.976 }, output: '/o/p.%04d.exr', plan: p, frameRate: 23.976, frameIn: 10 });
    expect(c.args.slice(3, 11)).toEqual(['-f', 'image2', '-framerate', '23.976', '-start_number', '86408', '-i', '/d/A_%07d.dpx']);
    expect(c.filter).not.toContain('select');
    expect(arg(c.args, '-frames:v')).toBe('14');
  });
});

describe('colour conversion', () => {
  const plan = sequencePlan({ frameIn: 0, frameOut: 9, handles: 0 }, out('exr', 16));
  const t = colorTransform('arri_logc3_awg3', 'acescg');

  it('decodes with the 1D LUT, then the matrix, all in float', () => {
    const c = buildFfmpegArgs({ source: { kind: 'clip', path: '/c.mov' }, output: '/o/p.%04d.exr', plan, frameRate: 24, frameIn: 0, color: { transform: t, decodeLut: 'A_plate_v001_decode.cube' } });
    const parts = c.filter.split(/,(?![^(]*\))/);
    expect(parts.slice(1, 3)).toEqual(['zscale=filter=point:dither=none', 'format=gbrpf32le']);
    expect(parts[3]).toBe('lut1d=file=A_plate_v001_decode.cube:interp=linear');
    expect(parts[4]).toMatch(/^colorchannelmixer=rr=0\.96663344\d*:rg=0\.11554161\d*:/); // AWG3 → AP0 (ARRI) · AP0 → AP1
    expect(c.filter).not.toMatch(/lut3d|tonemap|colorspace/);
  });

  it('refuses a conversion into an integer format, and an unsafe LUT name', () => {
    const dpx = sequencePlan({ frameIn: 0, frameOut: 9, handles: 0 }, out('dpx', 10));
    expect(() => buildFfmpegArgs({ source: { kind: 'clip', path: '/c' }, output: '/o', plan: dpx, frameRate: 24, frameIn: 0, color: { transform: t, decodeLut: 'x.cube' } })).toThrow(/float/);
    expect(() => conversionFilters(t, "C:\\x'y.cube")).toThrow(/Unsafe/);
  });

  it('needs no LUT between linear encodings', () => {
    expect(conversionFilters(colorTransform('aces2065_1', 'acescg'), 'x.cube')).toEqual([expect.stringMatching(/^colorchannelmixer=rr=1\.45143931/)]);
  });

  it('splits a matrix with coefficients beyond ±2 into a scaled mixer and gains', () => {
    const m: Matrix3 = [2.5216, -1.1369, -0.3849, -0.2765, 1.3727, -0.0961, -0.0159, -0.1478, 1.1637];
    const f = matrixFilters(m);
    expect(f).toHaveLength(2);
    expect(f[0]).toMatch(/^colorchannelmixer=rr=1\.2608:rg=-0\.56845:/);
    expect(f[1]).toBe('colorchannelmixer=rr=2:gg=2:bb=2');
  });
});

describe('buildFrameArgs', () => {
  it('seeks half a frame early, scales, applies the view and writes one JPEG', () => {
    const view = viewTransform('arri_logc4_awg4', 'rec709');
    const a = buildFrameArgs({ source: { kind: 'clip', path: '/c.mov' }, frame: 48, frameRate: 24, view, luts: { decode: 'v1_decode_logc4.cube', tone: 'v1_tone_rec709.cube' }, maxWidth: 1920, output: '/cache/x.part.jpg' });
    expect(a.slice(a.indexOf('-ss'), a.indexOf('-ss') + 4)).toEqual(['-ss', '1.979167', '-i', '/c.mov']);
    const vf = a[a.indexOf('-vf') + 1]!;
    expect(vf.startsWith('scale=w=min(1920\\,iw):h=-2:flags=bicubic,zscale=')).toBe(true);
    expect(vf).toContain('lut1d=file=v1_decode_logc4.cube:interp=linear,colorchannelmixer=');
    expect(vf.endsWith('lut1d=file=v1_tone_rec709.cube:interp=linear,format=yuvj444p')).toBe(true);
    expect(a.slice(-4)).toEqual(['image2', '-update', '1', '/cache/x.part.jpg']);
  });

  it('reads a sequence frame by its number and does nothing to raw values but scale', () => {
    const a = buildFrameArgs({ source: { kind: 'sequence', pattern: '/p/A.%04d.exr', startNumber: 1001, frameRate: 24 }, frame: 1050, frameRate: 24, view: viewTransform('acescg', 'raw'), luts: {}, maxWidth: 480, output: '/o.jpg' });
    expect(a).toContain('1050');
    expect(a[a.indexOf('-vf') + 1]).toBe('scale=w=min(480\\,iw):h=-2:flags=bicubic,format=yuvj444p');
  });
});

describe('parseFfmpegFrame', () => {
  it('reads the last frame count in a chunk', () => {
    expect(parseFfmpegFrame('frame=   12 fps=0.0 q=-0.0 size=N/A\rframe=   48 fps=24 q=-0.0')).toBe(48);
    expect(parseFfmpegFrame('Input #0, mov')).toBeNull();
  });
});
