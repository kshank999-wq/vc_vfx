import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { TRANSFERS, recordPlates, setShotPlateColor, viewDisplayCurve, type Project } from '@vcvfx/domain';
import { generateSequence } from '../sequence';
import { FrameCache } from '../frame-cache';
import { viewerFrame, viewerSources } from '../viewer';
import { CAMERA_RAW_MESSAGE } from '../image-sequence';
import { makeDrive } from './fixtures';

/**
 * The colour pipeline against real ffmpeg: what lands in the files, read
 * back as numbers. Runs with the ffmpeg on PATH and, when it has been
 * fetched, the bundled one too.
 */

const bundled = resolve(__dirname, '../../../resources/ffmpeg', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const binaries = [
  ...(spawnSync('ffmpeg', ['-version']).status === 0 ? [['PATH ffmpeg', 'ffmpeg'] as const] : []),
  ...(existsSync(bundled) ? [['bundled ffmpeg', bundled] as const] : []),
];
// With no ffmpeg anywhere, describe.each below makes no suites at all, which
// vitest reports as a failure; say plainly that this machine cannot run them.
describe.skipIf(binaries.length > 0)('colour pipeline', () => {
  it.skip('needs ffmpeg on PATH or fetched with scripts/fetch-ffmpeg.mjs', () => {});
});

/** ffprobe from the same place as the ffmpeg. */
const probeFor = (bin: string) => (bin === 'ffmpeg' ? 'ffprobe' : bin.replace(/ffmpeg(\.exe)?$/, (_m, e: string | undefined) => `ffprobe${e ?? ''}`));
const W = 64;
const H = 32;

function ff(bin: string, args: string[]): Buffer {
  const r = spawnSync(bin, ['-hide_banner', '-v', 'error', ...args], { maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`ffmpeg ${args.join(' ')}\n${r.stderr.toString()}`);
  return r.stdout;
}

/** RGB float planes of an image, as [r, g, b] at (x, y). */
function readFloat(bin: string, file: string) {
  const b = ff(bin, ['-i', file, '-f', 'rawvideo', '-pix_fmt', 'gbrpf32le', '-']);
  const f = new Float32Array(b.buffer, b.byteOffset, b.length / 4);
  const width = W;
  const P = f.length / 3;
  return (x: number, y: number) => [f[2 * P + y * width + x]!, f[y * width + x]!, f[P + y * width + x]!];
}

/** A 10-bit DPX sequence: left half at `left`, right half at `right` (10-bit codes), plus the frame index in red. */
async function dpxSequence(bin: string, dir: string, left: number, right: number, frames = 12, start = 86400) {
  await mkdir(dir, { recursive: true });
  ff(bin, [
    '-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:r=24`, '-frames:v', String(frames),
    '-vf', `format=gbrp10le,geq=r='if(lt(X\\,${W / 2})\\,${left}\\,${right})':g='if(lt(X\\,${W / 2})\\,${left}\\,${right})':b='if(lt(X\\,${W / 2})\\,${left}\\,${right})'`,
    '-c:v', 'dpx', '-pix_fmt', 'gbrp10le', '-start_number', String(start), join(dir, 'A015C002_%07d.dpx'),
  ]);
}

const LOGC3_GREY = Math.round(TRANSFERS.logc3.fromLinear(0.18) * 1023); // 400

describe.each(binaries)('plates with %s', (_label, bin) => {
  it('converts a LogC3 18% grey DPX sequence to 0.18 in an ACEScg EXR, keeping values above 1.0', async () => {
    const { project, drive, root } = await makeDrive([
      { shotId: 'G', sourcePath: 'VFX/G/A015C002_0086400.dpx', checksum: 'none', extra: { frameIn: 0, frameOut: 9, handles: 1, color: { sourceColorSpace: 'ARRI LogC3 / AWG3' }, output: { format: 'exr', bitDepth: 16, startFrame: 1001 } } },
    ]);
    await dpxSequence(bin, join(drive, 'VFX/G'), LOGC3_GREY, 1023);
    const before = (await readdir(join(drive, 'VFX/G'))).sort();
    const r = await generateSequence({ project, shotId: 'G', outputRoot: join(root, 'OUT'), ffmpeg: bin, ffprobe: null, appVersion: 'test' });
    if (!r.ok) throw new Error(r.reason);
    expect(r.record.color.policy).toEqual({ mode: 'convert', from: 'arri_logc3_awg3', to: 'acescg' });
    expect(r.record.color.summary).toBe('Writes ACEScg linear EXR half from ARRI LogC3 (EI 800) / AWG3; no look applied.');
    expect(r.frames).toBe(11); // 0–9 plus a 1-frame tail handle; no head handle before frame 0
    const files = (await readdir(r.folder)).sort();
    expect(files[0]).toBe('G_plate_v001.1001.exr');
    const px = readFloat(bin, join(r.folder, files[0]!));
    const grey = px(8, 8);
    for (const c of grey) expect(Math.abs(c - 0.18) / 0.18).toBeLessThan(0.002);
    const white = px(W - 8, 8);
    const expected = TRANSFERS.logc3.toLinear(1);
    for (const c of white) expect(Math.abs(c - expected) / expected).toBeLessThan(0.002);
    expect(white[1]).toBeGreaterThan(50);
    // The transform is on disk beside the plates, and the source folder is untouched.
    const data = join(r.folder, '..', '09_PROJECT_DATA');
    expect((await readdir(data)).sort()).toEqual(['G_plate_v001_colour.json', 'G_plate_v001_decode.cube']);
    const colour = JSON.parse(await readFile(join(data, 'G_plate_v001_colour.json'), 'utf8'));
    expect(colour).toMatchObject({ lookApplied: false, policy: { mode: 'convert' }, transform: { decode: { lut: 'G_plate_v001_decode.cube' } } });
    expect(colour.ffmpeg.args).toContain('<source>');
    expect((await readdir(join(drive, 'VFX/G'))).sort()).toEqual(before);
  });

  it('writes DPX as shot with the source code values unchanged, from the right frames of a sequence', async () => {
    const { project, drive, root } = await makeDrive([
      { shotId: 'D', sourcePath: 'VFX/D/A015C002_0086400.dpx', checksum: 'none', extra: { frameIn: 2, frameOut: 5, handles: 1, color: { sourceColorSpace: 'ARRI LogC4 / AWG4' }, output: { format: 'dpx', bitDepth: 10, startFrame: 1001 } } },
    ]);
    const dir = join(drive, 'VFX/D');
    await mkdir(dir, { recursive: true });
    // A different gradient on every frame, so a frame off by one would show.
    ff(bin, ['-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:r=24`, '-frames:v', '8', '-vf', "format=gbrp10le,geq=r='X*15+N':g='Y*30+N*2':b='(X+Y)*9+N*3'", '-c:v', 'dpx', '-pix_fmt', 'gbrp10le', '-start_number', '86400', join(dir, 'A015C002_%07d.dpx')]);
    const r = await generateSequence({ project, shotId: 'D', outputRoot: join(root, 'OUT'), ffmpeg: bin, ffprobe: null });
    if (!r.ok) throw new Error(r.reason);
    expect(r.record.color.policy).toEqual({ mode: 'as_shot' });
    expect(r.record.color.filter).toBe('');
    expect(r.frames).toBe(6); // source 1–6
    const raw = (file: string) => ff(bin, ['-i', file, '-f', 'rawvideo', '-pix_fmt', 'gbrp10le', '-']);
    for (let k = 0; k < 6; k += 1) {
      const plate = raw(join(r.folder, `D_plate_v001.${1001 + k}.dpx`));
      const source = raw(join(dir, `A015C002_${String(86401 + k).padStart(7, '0')}.dpx`));
      expect(Buffer.compare(plate, source)).toBe(0);
    }
  });

  it('reads a ProRes 4444 (YCbCr) LogC3 grey to ≈0.18 ACEScg', async () => {
    const { project, drive, root } = await makeDrive([
      { shotId: 'P', sourcePath: 'VFX/P/clip.mov', checksum: 'none', extra: { frameIn: 0, frameOut: 3, handles: 0, color: { sourceColorSpace: 'LogC3' }, output: { format: 'exr', bitDepth: 32, startFrame: 1001 } } },
    ]);
    const seq = join(root, 'SEQ');
    await dpxSequence(bin, seq, LOGC3_GREY, 1023, 6, 0);
    await mkdir(join(drive, 'VFX/P'), { recursive: true });
    ff(bin, ['-framerate', '24', '-i', join(seq, 'A015C002_%07d.dpx'), '-vf', 'zscale=matrix=709:range=limited,format=yuv444p10le', '-c:v', 'prores_ks', '-profile:v', '4444', '-color_range', 'tv', '-colorspace', 'bt709', join(drive, 'VFX/P/clip.mov')]);
    const r = await generateSequence({ project, shotId: 'P', outputRoot: join(root, 'OUT'), ffmpeg: bin, ffprobe: probeFor(bin) });
    if (!r.ok) throw new Error(r.reason);
    const px = readFloat(bin, join(r.folder, 'P_plate_v001.1001.exr'));
    for (const c of px(8, 8)) expect(Math.abs(c - 0.18) / 0.18).toBeLessThan(0.02);
  });

  it('refuses camera raw with the transcode instruction', async () => {
    const { project, root } = await makeDrive([{ shotId: 'R', sourcePath: 'VFX/R/A001_C002.R3D', bytes: Buffer.from('not really'), checksum: 'none' }]);
    const r = await generateSequence({ project, shotId: 'R', outputRoot: join(root, 'OUT'), ffmpeg: bin });
    expect(r).toEqual({ ok: false, reason: CAMERA_RAW_MESSAGE });
  });
});

describe.each(binaries)('viewer frames with %s', (_label, bin) => {
  const jpegPixel = (file: string, x: number, y: number) => {
    const b = ff(bin, ['-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    const dims = ff(probeFor(bin), ['-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]).toString().trim().split(',').map(Number);
    const width = dims[0]!;
    return { rgb: [...b.subarray((y * width + x) * 3, (y * width + x) * 3 + 3)], width, height: dims[1]! };
  };

  it('extracts a frame through the view transform, caches it and serves plates too', async () => {
    const { project: p0, drive, root } = await makeDrive([
      { shotId: 'V', sourcePath: 'VFX/V/A015C002_0086400.dpx', checksum: 'none', extra: { frameIn: 0, frameOut: 9, handles: 0, color: { sourceColorSpace: 'ARRI LogC3 / AWG3' }, output: { format: 'exr', bitDepth: 16, startFrame: 1001 } } },
    ]);
    await dpxSequence(bin, join(drive, 'VFX/V'), LOGC3_GREY, 1023);
    const cache = new FrameCache({ dir: join(root, 'cache') });
    const ctx = { cache, ffmpeg: bin, caps: { zscale: true, lut1d: true, colorchannelmixer: true } };
    const base = { text: '', shotId: 'V', projectKey: 'k', layer: 'source' as const, frame: 1005, maxWidth: 64 };

    const raw = await viewerFrame(p0, { ...base, view: 'raw' }, null, ctx);
    expect(raw.url).toMatch(/^vcvfx-frame:\/\/cache\/[0-9a-f]{64}\.jpg$/);
    const rawFile = join(cache.dir, raw.url.split('/').pop()!);
    const rawPx = jpegPixel(rawFile, 8, 8);
    expect(rawPx.width).toBe(64);
    expect(Math.abs(rawPx.rgb[1]! - (LOGC3_GREY / 1023) * 255)).toBeLessThan(4);

    const view = await viewerFrame(p0, { ...base, view: 'rec709' }, null, ctx);
    expect(view.viewLabel).toBe('ARRI LogC3 → Rec.709 (approx.)');
    const shown = jpegPixel(join(cache.dir, view.url.split('/').pop()!), 8, 8).rgb;
    expect(Math.abs(shown[1]! - viewDisplayCurve(0.18) * 255)).toBeLessThan(4);

    // A second request is a cache hit: same URL, no new file.
    const files = (await readdir(cache.dir)).filter((f) => f.endsWith('.jpg'));
    expect((await viewerFrame(p0, { ...base, view: 'rec709' }, null, ctx)).url).toBe(view.url);
    expect((await readdir(cache.dir)).filter((f) => f.endsWith('.jpg'))).toEqual(files);

    // Plates: the viewer finds the version on disk and shows it through ACEScg → Rec.709.
    const out = join(root, 'OUT');
    const made = await generateSequence({ project: p0, shotId: 'V', outputRoot: out, ffmpeg: bin });
    if (!made.ok) throw new Error(made.reason);
    const recorded = recordPlates(p0, 'V', made.record, 'test', new Date());
    if (!recorded.ok) throw new Error(recorded.reason);
    const p1: Project = recorded.project;
    const sources = await viewerSources(p1, 'V', out);
    expect(sources.source).toEqual({ available: true, reason: null, encoding: 'arri_logc3_awg3' });
    expect(sources.plates).toEqual([{ version: 1, format: 'exr', first: 1001, last: 1010, count: 10, encoding: 'acescg' }]);
    const plate = await viewerFrame(p1, { ...base, layer: 'plates', version: 1, view: 'rec709' }, out, ctx);
    expect(plate.viewLabel).toBe('ACEScg → Rec.709 (approx.)');
    const platePx = jpegPixel(join(cache.dir, plate.url.split('/').pop()!), 8, 8).rgb;
    expect(Math.abs(platePx[1]! - shown[1]!)).toBeLessThan(4);
  });

  it('says why a shot cannot be shown', async () => {
    const { project, root } = await makeDrive([{ shotId: 'R', sourcePath: 'VFX/R/clip.braw', bytes: Buffer.from('x'), checksum: 'none' }]);
    expect((await viewerSources(project, 'R', null)).source.reason).toBe(CAMERA_RAW_MESSAGE);
    const changed = setShotPlateColor(project, 'R', { encoding: 'red_log3g10_rwg' }, 't', new Date());
    expect(changed.ok).toBe(true);
    await expect(viewerFrame(project, { text: '', shotId: 'R', projectKey: 'k', layer: 'source', frame: 1001, view: 'raw', maxWidth: 64 }, null, { cache: new FrameCache({ dir: join(root, 'c') }), ffmpeg: bin, caps: { zscale: true, lut1d: true, colorchannelmixer: true } })).rejects.toThrow(/Camera raw/);
  });
});
