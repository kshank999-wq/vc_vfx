import { describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  addPart,
  approveTask,
  buildManifest,
  createProject,
  isolateDoc,
  parseHandoff,
  recordIsolateExport,
  recordIsolateRun,
  recordPropagation,
  setIsolateSeed,
  setIsolateSettings,
  setTaskState,
  shotState,
  type Project,
  type Result,
} from '@vcvfx/domain';
import { FULL_CAPS } from '../../shared/ffmpeg-args';
import { buildExrWriteArgs, toPlanar } from '../../shared/key/ffmpeg-key';
import { lumaWeights } from '../../shared/key/linear';
import { skyScene } from '../../shared/isolate/synthetic';
import { isolateBuild, isolateExport, isolateFrameView, isolateSession, type IsolateEnv } from '../isolate/api';
import { runIsolateJob } from '../isolate/service';
import { decodePng } from '../roto/png';
import { MaskStore } from '../roto/store';

/**
 * Sky isolation and background removal on real media (addendum 11 §4): a
 * synthetic rooftop shot written as a linear ACEScg EXR sequence on a
 * "drive", then the session, the review frame, a build in the worker, and a
 * versioned export into 02_MATTES_ROTO read back with ffmpeg; the subject
 * from a roto part in the roto cache.
 */

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const NOW = new Date('2026-10-21T12:00:00Z');
const LUMA = lumaWeights('ap1');
const ok = (r: Result): Project => {
  if (!r.ok) throw new Error(r.reason);
  return r.project;
};

let built: Promise<string> | null = null;
function worker(): Promise<string> {
  built ??= (async () => {
    const { build } = await import('vite');
    const out = await mkdtemp(join(tmpdir(), 'vcvfx-isolate-worker-'));
    await build({ configFile: false, logLevel: 'silent', ssr: { noExternal: true }, build: { ssr: resolve(__dirname, '../isolate/worker.ts'), outDir: out, emptyOutDir: true, minify: false, rollupOptions: { output: { format: 'cjs', entryFileNames: 'isolate-worker.js' } } } });
    return join(out, 'isolate-worker.js');
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

const FRAMES = 12;
const W = 320;
const H = 180;

async function drive() {
  const root = await mkdtemp(join(tmpdir(), 'vcvfx-isolate-'));
  const media = join(root, 'DRIVE', 'VFX', 'S1');
  await mkdir(media, { recursive: true });
  const scene = skyScene({ width: W, height: H, frames: FRAMES, noise: 0.002 });
  const n = W * H;
  const chunks = Array.from({ length: FRAMES }, (_, i) => {
    const p = toPlanar('rgb', n, scene.render(i).data, null);
    return Buffer.from(p.buffer, p.byteOffset, p.byteLength);
  });
  await pipeTo(buildExrWriteArgs({ layout: 'rgb', width: W, height: H, frameRate: 24, startNumber: 1001, output: join(media, 'S1_plate.%04d.exr') }), chunks);
  const handoff = {
    project: 'Sky Test',
    output: { format: 'exr', bitDepth: 16, startFrame: 1001 },
    shots: [
      {
        shotId: 'S1',
        scene: '1',
        sourcePath: 'VFX/S1/S1_plate.1001.exr',
        frameIn: 0,
        frameOut: FRAMES - 1,
        handles: 0,
        frameRate: 24,
        resolution: { width: W, height: H },
        color: { sourceColorSpace: 'ACEScg' },
        tasks: [{ kind: 'roto' }, { kind: 'sky_replacement' }, { kind: 'background_removal' }],
        references: [],
        checksums: [],
      },
    ],
  };
  const handoffPath = join(root, 'DRIVE', 'handoff.json');
  await writeFile(handoffPath, JSON.stringify(handoff));
  const parsed = parseHandoff(JSON.stringify(handoff));
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  let project = createProject(parsed.handoff, handoffPath, 'Tester', NOW);
  // The runner, rotoscoped into the roto cache (the subject of the background removal).
  const userData = join(root, 'userData');
  const store = new MaskStore(join(userData, 'Roto Cache'), 'k', 'S1');
  project = ok(addPart(project, 'S1', { name: 'runner' }, 'Ana', NOW));
  for (let i = 0; i < FRAMES; i += 1) await store.put('runner', 1, 1001 + i, { width: W, height: H, data: Uint8Array.from(scene.runner(i), (v) => Math.round(v * 255)) });
  project = ok(recordPropagation(project, 'S1', { partId: 'runner', engine: { id: 'track', version: 'test' }, direction: 'forward', from: 1001, frames: Array.from({ length: FRAMES }, (_, i) => ({ frame: 1001 + i, confidence: 0.95 })) }, 'Ana', NOW));
  const env: IsolateEnv = { ffmpeg: 'ffmpeg', caps: FULL_CAPS, rotoCacheRoot: join(userData, 'Roto Cache'), cacheRoot: join(userData, 'Isolate Cache'), workerFile: await worker(), generator: 'VC VFX test' };
  const out = join(root, 'OUT');
  await mkdir(out, { recursive: true });
  return { project, env, scene, out, media };
}

/** Read back an EXR as planar float (ffmpeg's gbrp/gbrap). */
function readExr(file: string, alpha: boolean): Float32Array {
  const raw = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', alpha ? 'gbrapf32le' : 'gbrpf32le', '-']).stdout;
  return new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
}

describe.skipIf(!hasFfmpeg)('sky isolation and background removal on real media', () => {
  it('session → review frame → build (worker) → export: matte, foreground, plate and manifest, versioned, never rewritten once approved', async () => {
    const { project, env, scene, out, media } = await drive();
    let p = project;
    const session = await isolateSession(p, 'S1', 'sky', out, env);
    expect(session).toMatchObject({ available: true, frames: 'source', plate: { width: W, height: H }, working: { width: W, height: H }, first: 1001, last: 1000 + FRAMES, encoding: { linear: true }, exportable: true, engines: [{ id: 'track' }] });

    const before = await isolateFrameView(p, { shotId: 'S1', projectKey: 'k', target: 'sky', frame: 1006, maxWidth: 960 }, out, env);
    expect([before.width, before.height, before.built, before.matte]).toEqual([W, H, 'none', null]);

    // The sky needs nothing to start: build straight away, in the worker.
    const progress: number[] = [];
    const result = await isolateBuild(p, { shotId: 'S1', projectKey: 'k', target: 'sky' }, out, env, { onProgress: (d) => progress.push(d) });
    expect(result).toMatchObject({ first: 1001, last: 1000 + FRAMES, alignment: 'homography', engine: 'sky-cues@1.0.0', revision: 0 });
    expect(result.frames).toHaveLength(FRAMES);
    expect(progress.at(-1)).toBe(6 * FRAMES);
    p = ok(recordIsolateRun(p, 'S1', 'sky', result, 'Ana', NOW));
    expect(shotState(p, 'S1')!.tasks.find((t) => t.kind === 'sky_replacement')!.state).toBe('needs_review');

    const after = await isolateFrameView(p, { shotId: 'S1', projectKey: 'k', target: 'sky', frame: 1006, maxWidth: 960 }, out, env);
    expect(after.built).toBe('current');
    expect(after.matte).not.toBeNull();
    expect(after.plate).not.toBeNull();
    expect(after.metrics!.foreground).toBeGreaterThan(0.3);

    // An output root among the camera media is refused.
    await expect(isolateExport(p, { shotId: 'S1', projectKey: 'k', target: 'sky', operator: 'Ana' }, media, env)).rejects.toThrow(/inside a source media folder/);

    const t0 = performance.now();
    const exported = await isolateExport(p, { shotId: 'S1', projectKey: 'k', target: 'sky', operator: 'Ana' }, out, env, { now: NOW });
    const ms = performance.now() - t0;
    const names = (await readdir(exported.folder)).sort();
    const seq = (stem: string, ext: string) => Array.from({ length: FRAMES }, (_, i) => `S1_${stem}_v001.${1001 + i}.${ext}`);
    expect(names.filter((x) => x.startsWith('S1_sky_matte_v001.') && x.endsWith('.png'))).toEqual(seq('sky_matte', 'png'));
    expect(names.filter((x) => x.startsWith('S1_sky_matte_v001.') && x.endsWith('.exr'))).toEqual(seq('sky_matte', 'exr'));
    expect(names.filter((x) => x.startsWith('S1_sky_fg_'))).toEqual(seq('sky_fg', 'exr'));
    expect(names.filter((x) => x.startsWith('S1_sky_plate_'))).toEqual(seq('sky_plate', 'exr'));
    expect(names.filter((x) => x.startsWith('S1_sky_conf_'))).toEqual(seq('sky_conf', 'png'));
    expect(names.filter((x) => x.startsWith('S1_sky_plateconf_'))).toEqual(seq('sky_plateconf', 'png'));
    expect(names).toContain('S1_sky_v001.json');
    expect(names).toContain('README.txt');
    // The matte against the truth.
    const k = 5;
    const matte = decodePng(await readFile(join(exported.folder, `S1_sky_matte_v001.${1001 + k}.png`)));
    expect([matte.width, matte.height, matte.bitDepth]).toEqual([W, H, 16]);
    const truth = scene.alpha(k);
    let I = 0;
    let U = 0;
    for (let i = 0; i < W * H; i += 1) {
      const a = matte.data[i]! >= 32768;
      const t = truth[i]! >= 0.5;
      if (a && t) I += 1;
      if (a || t) U += 1;
    }
    // The foreground EXR: RGBA, premultiplied (its alpha is the matte).
    const fg = readExr(join(exported.folder, `S1_sky_fg_v001.${1001 + k}.exr`), true);
    expect(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height,pix_fmt', '-of', 'csv=p=0', join(exported.folder, `S1_sky_fg_v001.${1001 + k}.exr`)]).stdout.toString().trim()).toMatch(/^320,180,gbrapf/);
    let alphaDiff = 0;
    for (let i = 0; i < W * H; i += 1) alphaDiff = Math.max(alphaDiff, Math.abs(fg[3 * W * H + i]! - matte.data[i]! / 65535));
    // The plate: the sky behind the bird (seen in other frames) against the truth.
    const plate = readExr(join(exported.folder, `S1_sky_plate_v001.${1001 + k}.exr`), false);
    const sky = scene.sky(k).data;
    const bird = scene.bird(k);
    let err = 0;
    let cnt = 0;
    const N = W * H;
    for (let i = 0; i < N; i += 1) {
      if (bird[i]! < 0.99) continue;
      const tl = LUMA[0] * sky[3 * i]! + LUMA[1] * sky[3 * i + 1]! + LUMA[2] * sky[3 * i + 2]!;
      err += (Math.abs(plate[2 * N + i]! - sky[3 * i]!) + Math.abs(plate[i]! - sky[3 * i + 1]!) + Math.abs(plate[N + i]! - sky[3 * i + 2]!)) / 3 / Math.max(0.02, tl);
      cnt += 1;
    }
    console.log(`export (320×180, ${FRAMES} frames, EXR round trip): matte IoU ${(I / U).toFixed(4)}, sky behind the bird ${((err / cnt) * 100).toFixed(2)} %, ${(ms / FRAMES).toFixed(0)} ms/frame`);
    expect(I / U).toBeGreaterThan(0.98);
    expect(alphaDiff).toBeLessThan(0.002);
    expect(err / cnt).toBeLessThan(0.03);
    const meta = JSON.parse(await readFile(join(exported.folder, 'S1_sky_v001.json'), 'utf8'));
    expect(meta).toMatchObject({ format: 'vcvfx.isolate/1', target: 'sky', task: 'sky_replacement', shot: 'S1', version: 'v001', engine: 'sky-cues@1.0.0', frames: { first: 1001, count: FRAMES }, resolution: { width: W, height: H }, colour: { linear: true }, alignment: { model: 'homography' }, settings: { seed: { mode: 'auto' } } });
    expect(meta.perFrame).toHaveLength(FRAMES);
    expect(meta.alignment.frames).toHaveLength(FRAMES);
    expect(exported.record).toMatchObject({ version: 1, target: 'sky', folder: '02_MATTES_ROTO/S1_sky_v001', matte: 'S1_sky_matte_v001.%04d.png', matteExr: 'S1_sky_matte_v001.%04d.exr', foreground: 'S1_sky_fg_v001.%04d.exr', plate: 'S1_sky_plate_v001.%04d.exr', format: 'exr', frames: FRAMES });
    p = ok(recordIsolateExport(p, 'S1', 'sky', exported.record, 'Ana', NOW));

    // Approval is a person's act; the manifest carries it.
    p = ok(approveTask(p, 'S1', 'sky_replacement', 'Sup', NOW));
    expect(buildManifest(p, 'S1', { generatedAt: NOW, appVersion: 'test', operator: 'Ana', files: [] }).isolate!.sky).toMatchObject({ version: 'v001', state: 'approved', exported: true, folder: '02_MATTES_ROTO/S1_sky_v001' });
    // Never rewritten once approved; reopened, v002 is written beside v001.
    await expect(isolateExport(p, { shotId: 'S1', projectKey: 'k', target: 'sky', operator: 'Ana' }, out, env)).rejects.toThrow(/approved and already written/);
    const v1 = (await stat(join(exported.folder, 'S1_sky_matte_v001.1001.png'))).mtimeMs;
    p = ok(setTaskState(p, 'S1', 'sky_replacement', 'needs_correction', 'Sup', NOW));
    p = ok(setIsolateSettings(p, 'S1', 'sky', { edgeSoftnessPx: 2 }, 'Ana', NOW));
    const again = await isolateExport(p, { shotId: 'S1', projectKey: 'k', target: 'sky', operator: 'Ana' }, out, env);
    expect(again.record).toMatchObject({ version: 2, folder: '02_MATTES_ROTO/S1_sky_v002' });
    expect((await stat(join(exported.folder, 'S1_sky_matte_v001.1001.png'))).mtimeMs).toBe(v1);
    // The source media were only read.
    expect((await readdir(media)).filter((x) => !x.startsWith('S1_plate.'))).toEqual([]);
  }, 240_000);

  it('removes the background behind a rotoscoped subject: matte, foreground and background plate into 02_MATTES_ROTO', async () => {
    const { project, env, scene, out } = await drive();
    let p = ok(setIsolateSeed(project, 'S1', 'background', { mode: 'roto', partId: 'runner' }, 'Ana', NOW));
    const result = await isolateBuild(p, { shotId: 'S1', projectKey: 'k', target: 'background' }, out, env);
    p = ok(recordIsolateRun(p, 'S1', 'background', result, 'Ana', NOW));
    expect(isolateDoc(shotState(p, 'S1'), 'background')!.frames).toHaveLength(FRAMES);
    const exported = await isolateExport(p, { shotId: 'S1', projectKey: 'k', target: 'background', operator: 'Ana' }, out, env);
    expect(exported.record).toMatchObject({ target: 'background', folder: '02_MATTES_ROTO/S1_bg_v001', matte: 'S1_bg_matte_v001.%04d.png', plate: 'S1_bg_plate_v001.%04d.exr' });
    const k = 4;
    const matte = decodePng(await readFile(join(exported.folder, `S1_bg_matte_v001.${1001 + k}.png`)));
    const truth = scene.runner(k);
    let I = 0;
    let U = 0;
    for (let i = 0; i < W * H; i += 1) {
      const a = matte.data[i]! >= 32768;
      const t = truth[i]! >= 0.5;
      if (a && t) I += 1;
      if (a || t) U += 1;
    }
    expect(I / U).toBeGreaterThan(0.95);
    const meta = JSON.parse(await readFile(join(exported.folder, 'S1_bg_v001.json'), 'utf8'));
    expect(meta).toMatchObject({ target: 'background', task: 'background_removal', settings: { seed: { mode: 'roto', partId: 'runner' } } });
  }, 240_000);

  it('cancels a worker job between frames', async () => {
    const { project, env } = await drive();
    const controller = new AbortController();
    const seen: number[] = [];
    const run = isolateBuild(project, { shotId: 'S1', projectKey: 'k', target: 'sky' }, null, env, { signal: controller.signal, onProgress: (done) => (seen.push(done), done === 3 ? controller.abort() : undefined) });
    await expect(run).rejects.toThrow('Cancelled');
    expect(seen.length).toBeLessThan(6 * FRAMES);
    await expect(runIsolateJob({} as never, { workerFile: env.workerFile, signal: AbortSignal.abort() })).rejects.toThrow('Cancelled');
  }, 60_000);
});
