import { describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  applyTransform,
  approveTask,
  buildManifest,
  colorTransform,
  createProject,
  keyRepairPart,
  parseHandoff,
  recordBgMatch,
  recordKeyExport,
  recordKeyRun,
  recordPlates,
  rotoPart,
  setKeyBackground,
  setKeyScreen,
  setLightWrap,
  setTaskState,
  shotState,
  startKeyRepair,
  type Project,
  type Result,
} from '@vcvfx/domain';
import { FULL_CAPS } from '../../shared/ffmpeg-args';
import { buildExrWriteArgs, buildLinearFramesArgs, toPlanar } from '../../shared/key/ffmpeg-key';
import { greenScreenScene, type GreenScreenScene } from '../../shared/key/synthetic';
import { accuracy } from '../../shared/__tests__/key-helpers';
import { keyDetect, keyExport, keyFrameView, keyMatch, keyProcess, keySample, keySeedRoto, keySession, type KeyEnv } from '../key/api';
import { keyFrameSource, readLinearFrames } from '../key/frames';
import { runKeyJob } from '../key/service';
import { generateSequence } from '../sequence';
import { decodePng } from '../roto/png';
import { MaskStore } from '../roto/store';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const NOW = new Date('2026-10-21T12:00:00Z');
const ok = (r: Result): Project => {
  if (!r.ok) throw new Error(r.reason);
  return r.project;
};

let built: Promise<string> | null = null;
/** The key worker, bundled once per run (the app gets it from electron-vite as out/main/key-worker.js). */
function keyWorker(): Promise<string> {
  built ??= (async () => {
    const { build } = await import('vite');
    const out = await mkdtemp(join(tmpdir(), 'vcvfx-key-worker-'));
    await build({ configFile: false, logLevel: 'silent', ssr: { noExternal: true }, build: { ssr: resolve(__dirname, '../key/worker.ts'), outDir: out, emptyOutDir: true, minify: false, rollupOptions: { output: { format: 'cjs', entryFileNames: 'key-worker.js' } } } });
    return join(out, 'key-worker.js');
  })();
  return built;
}

function pipeTo(args: string[], chunks: Buffer[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolvePromise() : reject(new Error(err))));
    for (const c of chunks) child.stdin.write(c);
    child.stdin.end();
  });
}

/** The scene as a camera would record it: ARRI LogC4 / AWG4 code values in ProRes 4444. */
async function encodeLogC4(scene: GreenScreenScene, file: string): Promise<void> {
  const t = colorTransform('acescg', 'arri_logc4_awg4');
  const chunks: Buffer[] = [];
  for (let n = 0; n < scene.frames; n += 1) {
    const img = scene.render(n);
    const buf = Buffer.alloc(scene.width * scene.height * 6);
    for (let i = 0; i < scene.width * scene.height; i += 1) {
      const v = applyTransform(t, [img.data[3 * i]!, img.data[3 * i + 1]!, img.data[3 * i + 2]!]);
      for (let c = 0; c < 3; c += 1) buf.writeUInt16LE(Math.max(0, Math.min(65535, Math.round(v[c]! * 65535))), 6 * i + 2 * c);
    }
    chunks.push(buf);
  }
  await pipeTo(['-hide_banner', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb48le', '-s', `${scene.width}x${scene.height}`, '-r', '24', '-i', 'pipe:0', '-vf', 'zscale=matrix=709:range=limited:dither=none,format=yuv444p10le', '-c:v', 'prores_ks', '-profile:v', '4', '-pix_fmt', 'yuv444p10le', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', file], chunks);
}

async function keyDrive(frames = 12) {
  const root = await mkdtemp(join(tmpdir(), 'vcvfx-key-'));
  const drive = join(root, 'DRIVE');
  await mkdir(join(drive, 'VFX/K1'), { recursive: true });
  await mkdir(join(drive, 'VFX/BG'), { recursive: true });
  const scene = greenScreenScene({ width: 320, height: 180, frames });
  await encodeLogC4(scene, join(drive, 'VFX/K1/greenscreen.mov'));
  // The background plate the handoff names: a linear ACEScg EXR.
  const n = scene.width * scene.height;
  const bgPlanes = toPlanar('rgb', n, scene.background.data, null);
  await pipeTo(buildExrWriteArgs({ layout: 'rgb', width: scene.width, height: scene.height, frameRate: 24, startNumber: 1, output: join(drive, 'VFX/BG/street.%d.exr') }), [Buffer.from(bgPlanes.buffer)]);
  const handoff = {
    project: 'Key Test',
    output: { format: 'exr', bitDepth: 16, startFrame: 1001 },
    shots: [
      {
        shotId: 'K1',
        scene: '1',
        sourcePath: 'VFX/K1/greenscreen.mov',
        frameIn: 0,
        frameOut: frames - 1,
        handles: 0,
        frameRate: 24,
        resolution: { width: scene.width, height: scene.height },
        color: { sourceColorSpace: 'ARRI LogC4 / AWG4' },
        tasks: [{ kind: 'sequence_conversion' }, { kind: 'key' }, { kind: 'despill' }],
        references: [{ kind: 'background_plate', path: 'VFX/BG/street.1.exr' }],
        checksums: [],
      },
    ],
  };
  await writeFile(join(drive, 'handoff.json'), JSON.stringify(handoff));
  const parsed = parseHandoff(JSON.stringify(handoff));
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  const project = createProject(parsed.handoff, join(drive, 'handoff.json'), 'Tester', NOW);
  const userData = join(root, 'userData');
  const env: KeyEnv = { ffmpeg: 'ffmpeg', caps: FULL_CAPS, rotoCacheRoot: join(userData, 'Roto Cache'), keyCacheRoot: join(userData, 'Key Cache'), workerFile: await keyWorker(), generator: 'VC VFX test' };
  const out = join(root, 'OUT');
  await mkdir(out, { recursive: true });
  return { project, env, scene, out };
}

describe('ffmpeg commands for the key', () => {
  it('reads float code values (planar), resized in zimg, and writes half-float EXR from stdin', () => {
    const a = buildLinearFramesArgs({ source: { kind: 'sequence', pattern: '/p/x.%04d.exr', startNumber: 1001, frameRate: 24 }, frame: 1003, frameRate: 24, count: 4, width: 960, height: 540, native: false, caps: FULL_CAPS });
    expect(a).toContain('-start_number');
    expect(a[a.indexOf('-start_number') + 1]).toBe('1003');
    expect(a[a.indexOf('-vf') + 1]).toBe('zscale=w=960:h=540:filter=bilinear:dither=none,format=gbrpf32le');
    expect(a.slice(-5)).toEqual(['-f', 'rawvideo', '-pix_fmt', 'gbrpf32le', 'pipe:1']);
    const y = buildLinearFramesArgs({ source: { kind: 'clip', path: '/c.mov' }, frame: 10, frameRate: 24, count: 1, width: 320, height: 180, native: true, hints: { yuv: true }, caps: { ...FULL_CAPS, zscale: false } });
    expect(y[y.indexOf('-vf') + 1]).toBe('format=gbrpf32le');
    expect(y.slice(0, 8)).toContain('-ss');
    const w = buildExrWriteArgs({ layout: 'rgba', width: 4, height: 2, frameRate: 24, startNumber: 1001, output: '/o/a.%04d.exr' });
    expect(w).toEqual(expect.arrayContaining(['-n', 'gbrapf32le', '4x2', 'zip16', 'half', '1001', '/o/a.%04d.exr']));
    expect([...toPlanar('rgba', 1, Float32Array.from([0.1, 0.2, 0.3]), Float32Array.from([0.5]))].map((v) => +v.toFixed(2))).toEqual([0.2, 0.3, 0.1, 0.5]);
  });
});

describe.skipIf(!hasFfmpeg)('keying real media', () => {
  it('decodes a LogC4 ProRes clip to linear ACEScg', async () => {
    const { project, scene } = await keyDrive(4);
    const src = await keyFrameSource(project, 'K1', null, { ffmpeg: 'ffmpeg', caps: FULL_CAPS });
    if (!src.ok) throw new Error(src.reason);
    expect(src.spec).toMatchObject({ first: 1001, last: 1004, label: 'source', encoding: 'arri_logc4_awg4', plate: { width: 320, height: 180 } });
    expect(src.space).toMatchObject({ encoding: 'acescg', linear: true });
    const got: number[] = [];
    let img: Float32Array | null = null;
    await readLinearFrames(src.spec, 1002, 2, { width: 320, height: 180 }, (f, i) => {
      got.push(f);
      if (f === 1002) img = i.data;
    });
    expect(got).toEqual([1002, 1003]);
    const truth = scene.render(1).data;
    let err = 0;
    for (let i = 0; i < truth.length; i += 3) err += Math.abs(img![i + 1]! - truth[i + 1]!) / Math.max(0.02, truth[i + 1]!);
    expect(err / (truth.length / 3)).toBeLessThan(0.03); // 10-bit log, 4:4:4 YCbCr, noise
  });

  it('cancels a worker job between frames', async () => {
    const { project, env } = await keyDrive(12);
    const p = ok(setKeyScreen(project, 'K1', { kind: 'green', source: 'auto', rgb: [0.063, 0.457, 0.097] }, 'Ana', NOW));
    const controller = new AbortController();
    const seen: number[] = [];
    const run = keyProcess(p, { shotId: 'K1', projectKey: 'k' }, null, env, { signal: controller.signal, onProgress: (done) => (seen.push(done), done === 3 ? controller.abort() : undefined) });
    await expect(run).rejects.toThrow('Cancelled');
    expect(seen.length).toBeLessThan(12);
    await expect(runKeyJob({} as never, { workerFile: env.workerFile, signal: AbortSignal.abort() })).rejects.toThrow('Cancelled');
  });

  it('clip → plates → auto key → despill against the background → process → export: versioned files, needs review, in the manifest', async () => {
    const { project, env, scene, out } = await keyDrive(12);
    let p = ok(setTaskState(project, 'K1', 'sequence_conversion', 'processing', 'Ana', NOW));
    const plates = await generateSequence({ project: p, shotId: 'K1', outputRoot: out, ffmpeg: 'ffmpeg' });
    if (!plates.ok) throw new Error(plates.reason);
    p = ok(recordPlates(p, 'K1', plates.record, 'Ana', NOW));
    expect(plates.record.color.plateEncoding).toBe('acescg');

    const session = await keySession(p, 'K1', out, env);
    expect(session).toMatchObject({ available: true, frames: 'plates v001', plate: { width: 320, height: 180 }, first: 1001, last: 1012, encoding: { label: 'ACEScg (linear AP1)', linear: true }, references: ['VFX/BG/street.1.exr'] });

    // Auto key: detect the screen (worker), use it.
    const detected = await keyDetect(p, { shotId: 'K1', projectKey: 'k', kind: null }, out, env);
    expect(detected.kind).toBe('green');
    expect(detected.coverage).toBeGreaterThan(0.6);
    p = ok(setKeyScreen(p, 'K1', { ...detected, source: 'auto' }, 'Ana', NOW));
    p = ok(setKeyBackground(p, 'K1', { kind: 'reference', path: 'VFX/BG/street.1.exr', frame: null, label: '' }, 'Ana', NOW));
    p = ok(setLightWrap(p, 'K1', { output: true, widthPx: 8 }, 'Ana', NOW));
    expect((await keySession(p, 'K1', out, env)).background).toMatchObject({ available: true, label: 'street.1.exr' });

    // The eyedropper reads linear colour at plate pixels.
    const sample = await keySample(p, { shotId: 'K1', projectKey: 'k', frame: 1001, x: 10, y: 10, radius: 3 }, out, env);
    expect(sample.rgb[1]).toBeGreaterThan(sample.rgb[0] * 3);

    // Review frame: every layer there.
    const view = await keyFrameView(p, { shotId: 'K1', projectKey: 'k', frame: 1005, maxWidth: 320, wrap: true, match: false }, out, env);
    expect([view.width, view.height, view.source.length, view.alpha.length]).toEqual([320, 180, 320 * 180 * 3, 320 * 180]);
    expect(view.comp).not.toBeNull();
    const acc = accuracy(Float32Array.from(view.alpha, (v) => v / 255), scene.alpha(4), 320, 180);
    expect(acc.bg).toBeLessThan(0.01);
    expect(acc.core).toBeGreaterThan(0.99);
    expect(acc.edgeMae).toBeLessThan(0.1);

    // Process the shot (worker): key and despill go up for review.
    const progress: number[] = [];
    const result = await keyProcess(p, { shotId: 'K1', projectKey: 'k' }, out, env, { onProgress: (d) => progress.push(d) });
    expect(progress.at(-1)).toBe(12);
    expect(result.frames).toHaveLength(12);
    p = ok(recordKeyRun(p, 'K1', result, 'Ana', NOW));
    const tasks = () => Object.fromEntries(shotState(p, 'K1')!.tasks.map((t) => [t.kind, t.state]));
    expect(tasks()).toMatchObject({ key: 'needs_review', despill: 'needs_review' });
    expect(Math.min(...shotState(p, 'K1')!.key!.frames.map((f) => f.confidence))).toBeGreaterThan(0.8);
    expect(await new MaskStore(env.keyCacheRoot, 'k', 'K1').frames('alpha', 1)).toHaveLength(12);

    // Suggested match, as metadata.
    const match = await keyMatch(p, { shotId: 'K1', projectKey: 'k', frame: 1003 }, out, env);
    expect(match.samples.foreground).toBeGreaterThan(50);
    p = ok(recordBgMatch(p, 'K1', match, 'Ana', NOW));

    // Repair with roto: the key on 1006 becomes a roto part's matte there.
    const { partId, name } = keyRepairPart(p, 'K1');
    const seeded = await keySeedRoto(p, { shotId: 'K1', projectKey: 'k', partId, frame: 1006 }, out, env);
    p = ok(startKeyRepair(p, 'K1', { partId, name, frame: 1006, confidence: seeded.confidence }, 'Ana', NOW));
    expect(rotoPart(shotState(p, 'K1')!.roto, partId)!.keyFrames[0]).toMatchObject({ frame: 1006, correction: true });
    expect(await new MaskStore(env.rotoCacheRoot, 'k', 'K1').get(partId, 1, 1006)).not.toBeNull();
    // The repair (replace, by the seed — the key itself) keeps the key as it was there.
    const repairedView = await keyFrameView(p, { shotId: 'K1', projectKey: 'k', frame: 1006, maxWidth: 320, wrap: false, match: false }, out, env);
    expect(repairedView.repair).not.toBeNull();
    expect(accuracy(Float32Array.from(repairedView.alpha, (v) => v / 255), scene.alpha(5), 320, 180).core).toBeGreaterThan(0.99);
    // That was a change of settings: process again before exporting.
    p = ok(recordKeyRun(p, 'K1', await keyProcess(p, { shotId: 'K1', projectKey: 'k' }, out, env), 'Ana', NOW));

    // Export at plate resolution.
    const exported = await keyExport(p, { shotId: 'K1', projectKey: 'k', operator: 'Ana', options: { foreground: true, core: true, edge: true, alphaExr: true } }, out, env, { now: NOW });
    const names = (await readdir(exported.folder)).sort();
    const seq = (stem: string, ext: string) => Array.from({ length: 12 }, (_, i) => `K1_key_${stem}_v001.${1001 + i}.${ext}`);
    expect(names.filter((n) => n.startsWith('K1_key_alpha') && n.endsWith('.png'))).toEqual(seq('alpha', 'png'));
    expect(names.filter((n) => n.startsWith('K1_key_alpha') && n.endsWith('.exr'))).toEqual(seq('alpha', 'exr'));
    expect(names.filter((n) => n.startsWith('K1_key_fg'))).toEqual(seq('fg', 'exr'));
    expect(names.filter((n) => n.startsWith('K1_key_core'))).toEqual(seq('core', 'png'));
    expect(names.filter((n) => n.startsWith('K1_key_edge'))).toEqual(seq('edge', 'png'));
    expect(names.filter((n) => n.startsWith('K1_key_lightwrap'))).toEqual(seq('lightwrap', 'exr'));
    expect(names).toContain('K1_key_v001.json');
    expect(names).toContain('README.txt');
    const png = decodePng(await readFile(join(exported.folder, 'K1_key_alpha_v001.1009.png')));
    expect([png.width, png.height, png.bitDepth]).toEqual([320, 180, 16]);
    const exportedAcc = accuracy(Float32Array.from(png.data as Uint16Array, (v) => v / 65535), scene.alpha(8), 320, 180);
    expect(exportedAcc.bg).toBeLessThan(0.01);
    expect(exportedAcc.core).toBeGreaterThan(0.99);
    expect(exportedAcc.edgeMae).toBeLessThan(0.1);
    // The foreground EXR: RGBA, premultiplied (its alpha is the matte), at plate size.
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height,pix_fmt', '-of', 'csv=p=0', join(exported.folder, 'K1_key_fg_v001.1009.exr')]).stdout.toString().trim();
    expect(probe).toMatch(/^320,180,gbrapf/);
    const raw = spawnSync('ffmpeg', ['-v', 'error', '-i', join(exported.folder, 'K1_key_fg_v001.1009.exr'), '-f', 'rawvideo', '-pix_fmt', 'gbrapf32le', '-']).stdout;
    const planes = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
    const n = 320 * 180;
    let premultOk = 0;
    let checked = 0;
    for (let i = 0; i < n; i += 7) {
      const a = planes[3 * n + i]!;
      const g = planes[i]!;
      if (a < 0.001) {
        checked += 1;
        if (g < 1e-3) premultOk += 1;
      }
    }
    expect(premultOk / checked).toBeGreaterThan(0.99); // nothing outside the matte
    const meta = JSON.parse(await readFile(join(exported.folder, 'K1_key_v001.json'), 'utf8'));
    expect(meta).toMatchObject({ format: 'vcvfx.key/1', shot: 'K1', version: 'v001', frames: { first: 1001, last: 1012, count: 12 }, resolution: { width: 320, height: 180 }, source: 'plates v001', colour: { encoding: 'ACEScg (linear AP1)', linear: true }, settings: { screen: { kind: 'green' } } });
    expect(meta.suggestedMatch).toMatchObject({ frame: 1003 });
    expect(meta.perFrame).toHaveLength(12);
    expect(meta.background).toMatch(/street\.1\.exr/);
    expect(exported.record).toMatchObject({ version: 1, folder: '03_KEYS/K1_key_v001', alpha: 'K1_key_alpha_v001.%04d.png', foreground: 'K1_key_fg_v001.%04d.exr', lightWrap: 'K1_key_lightwrap_v001.%04d.exr', width: 320, height: 180, frames: 12, despill: true, encoding: 'ACEScg (linear AP1)' });
    p = ok(recordKeyExport(p, 'K1', exported.record, 'Ana', NOW));
    expect(tasks()).toMatchObject({ key: 'needs_review', despill: 'needs_review' });

    // Approval is a person's act; the manifest carries the key.
    p = ok(approveTask(p, 'K1', 'key', 'Sup', NOW));
    p = ok(approveTask(p, 'K1', 'despill', 'Sup', NOW));
    const manifest = buildManifest(p, 'K1', { generatedAt: NOW, appVersion: 'test', operator: 'Ana', files: [] });
    expect(manifest.key).toMatchObject({ version: 'v001', state: 'approved', despill: { state: 'approved' }, exported: true, folder: '03_KEYS/K1_key_v001', foreground: 'K1_key_fg_v001.%04d.exr', encoding: 'ACEScg (linear AP1)', confidence: { frames: 12 } });
    expect(manifest.key!.links.map((l) => l.kind)).toEqual(['repair']);

    // The approved version is never rewritten.
    await expect(keyExport(p, { shotId: 'K1', projectKey: 'k', operator: 'Ana', options: { foreground: false, core: false, edge: false, alphaExr: false } }, out, env)).rejects.toThrow(/approved and already written/);
    expect((await stat(join(exported.folder, 'K1_key_alpha_v001.1001.png'))).size).toBeGreaterThan(0);
  }, 120_000);
});
