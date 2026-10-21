import { describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  addCleanPlateRemove,
  addPart,
  approveTask,
  buildManifest,
  createProject,
  parseHandoff,
  recordCleanPlateExport,
  recordCleanPlateRun,
  recordPropagation,
  setCleanPlateSettings,
  setTaskState,
  shotState,
  type Project,
  type Result,
} from '@vcvfx/domain';
import { FULL_CAPS } from '../../shared/ffmpeg-args';
import { buildExrWriteArgs, toPlanar } from '../../shared/key/ffmpeg-key';
import { lumaWeights } from '../../shared/key/linear';
import { cleanPlateScene, type CleanPlateScene } from '../../shared/cleanplate/synthetic';
import { morph } from '../../shared/roto/image';
import { cleanPlateBuild, cleanPlateExport, cleanPlateFrameView, cleanPlateSession, type CleanPlateEnv } from '../cleanplate/api';
import { runCleanPlateJob } from '../cleanplate/service';
import { decodePng } from '../roto/png';
import { MaskStore } from '../roto/store';

/**
 * Clean plates on real media (addendum 10 §7): a synthetic shot written as a
 * linear ACEScg EXR sequence on a "drive", the subject rotoscoped into the
 * roto cache, then the session, the review frame, a build in the worker, and
 * a versioned export into 04_CLEAN_PLATES read back with ffmpeg.
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
    const out = await mkdtemp(join(tmpdir(), 'vcvfx-cleanplate-worker-'));
    await build({ configFile: false, logLevel: 'silent', ssr: { noExternal: true }, build: { ssr: resolve(__dirname, '../cleanplate/worker.ts'), outDir: out, emptyOutDir: true, minify: false, rollupOptions: { output: { format: 'cjs', entryFileNames: 'cleanplate-worker.js' } } } });
    return join(out, 'cleanplate-worker.js');
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

const FRAMES = 14;

async function drive() {
  const root = await mkdtemp(join(tmpdir(), 'vcvfx-cleanplate-'));
  const media = join(root, 'DRIVE', 'VFX', 'C1');
  await mkdir(media, { recursive: true });
  const scene = cleanPlateScene({ width: 320, height: 180, frames: FRAMES, noise: 0.002 });
  const n = scene.width * scene.height;
  const chunks = Array.from({ length: FRAMES }, (_, i) => {
    const p = toPlanar('rgb', n, scene.render(i).data, null);
    return Buffer.from(p.buffer, p.byteOffset, p.byteLength);
  });
  await pipeTo(buildExrWriteArgs({ layout: 'rgb', width: scene.width, height: scene.height, frameRate: 24, startNumber: 1001, output: join(media, 'C1_plate.%04d.exr') }), chunks);
  const handoff = {
    project: 'Clean Test',
    output: { format: 'exr', bitDepth: 16, startFrame: 1001 },
    shots: [
      {
        shotId: 'C1',
        scene: '1',
        sourcePath: 'VFX/C1/C1_plate.1001.exr',
        frameIn: 0,
        frameOut: FRAMES - 1,
        handles: 0,
        frameRate: 24,
        resolution: { width: scene.width, height: scene.height },
        color: { sourceColorSpace: 'ACEScg' },
        tasks: [{ kind: 'roto' }, { kind: 'clean_plate' }],
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
  // The subjects, rotoscoped: the crew member and the light stand, written into the roto cache.
  const userData = join(root, 'userData');
  const store = new MaskStore(join(userData, 'Roto Cache'), 'k', 'C1');
  for (const [name, matte] of [
    ['crew', (i: number) => scene.crew(i)],
    ['stand', (i: number) => scene.stand(i)],
  ] as const) {
    project = ok(addPart(project, 'C1', { name }, 'Ana', NOW));
    for (let i = 0; i < FRAMES; i += 1) await store.put(name, 1, 1001 + i, { width: scene.width, height: scene.height, data: Uint8Array.from(matte(i), (v) => Math.round(v * 255)) });
    project = ok(recordPropagation(project, 'C1', { partId: name, engine: { id: 'track', version: 'test' }, direction: 'forward', from: 1001, frames: Array.from({ length: FRAMES }, (_, i) => ({ frame: 1001 + i, confidence: 0.95 })) }, 'Ana', NOW));
    project = ok(addCleanPlateRemove(project, 'C1', { source: { type: 'roto', partId: name } }, 'Ana', NOW));
  }
  project = ok(setCleanPlateSettings(project, 'C1', { dilatePx: 3 }, 'Ana', NOW));
  const env: CleanPlateEnv = { ffmpeg: 'ffmpeg', caps: FULL_CAPS, rotoCacheRoot: join(userData, 'Roto Cache'), cacheRoot: join(userData, 'Clean Plate Cache'), workerFile: await worker(), generator: 'VC VFX test' };
  const out = join(root, 'OUT');
  await mkdir(out, { recursive: true });
  return { project, env, scene, out, media };
}

/** Pixels the crew member hides on frame i that the stand never does (revealed elsewhere). */
function revealed(scene: CleanPlateScene, i: number): number[] {
  const w = scene.width;
  const crew = scene.crew(i);
  const near = morph(Uint8Array.from(scene.stand(i), (v) => (v > 0.02 ? 1 : 0)), w, scene.height, 10);
  const idx: number[] = [];
  for (let k = 0; k < crew.length; k += 1) {
    const x = k % w;
    const y = (k - x) / w;
    if (crew[k]! > 0.5 && !near[k] && x > 5 && y > 5 && x < w - 6 && y < scene.height - 6) idx.push(k);
  }
  return idx;
}

describe.skipIf(!hasFfmpeg)('clean plates on real media', () => {
  it('session → review frame → build (worker) → export: versioned files, needs review, in the manifest, never rewritten once approved', async () => {
    const { project, env, scene, out, media } = await drive();
    let p = project;
    const session = await cleanPlateSession(p, 'C1', out, env);
    expect(session).toMatchObject({ available: true, frames: 'source', plate: { width: 320, height: 180 }, working: { width: 320, height: 180 }, first: 1001, last: 1000 + FRAMES, encoding: { label: 'ACEScg (linear AP1)', linear: true }, exportable: true });

    // Before a build: the frame and what is removed, no plate.
    const before = await cleanPlateFrameView(p, { shotId: 'C1', projectKey: 'k', frame: 1006, maxWidth: 960 }, out, env);
    expect([before.width, before.height, before.built, before.plate]).toEqual([320, 180, 'none', null]);
    expect(before.hole!.filter((v) => v).length).toBeGreaterThan(1000);

    // Build in the worker.
    const progress: number[] = [];
    const result = await cleanPlateBuild(p, { shotId: 'C1', projectKey: 'k' }, out, env, { onProgress: (d) => progress.push(d) });
    expect(result).toMatchObject({ mode: 'sequence', alignment: 'homography', first: 1001, last: 1000 + FRAMES });
    expect(result.frames).toHaveLength(FRAMES);
    expect(progress.at(-1)).toBe(3 * FRAMES);
    p = ok(recordCleanPlateRun(p, 'C1', result, 'Ana', NOW));
    expect(shotState(p, 'C1')!.tasks.find((t) => t.kind === 'clean_plate')!.state).toBe('needs_review');

    const after = await cleanPlateFrameView(p, { shotId: 'C1', projectKey: 'k', frame: 1006, maxWidth: 960 }, out, env);
    expect(after.built).toBe('current');
    expect(after.plate).not.toBeNull();
    expect(after.unresolved!.some((v) => v === 255)).toBe(true);
    expect(after.metrics!.coverage).toBeGreaterThan(0.5);

    // An output root among the camera media is refused.
    await expect(cleanPlateExport(p, { shotId: 'C1', projectKey: 'k', operator: 'Ana' }, media, env)).rejects.toThrow(/inside a source media folder/);

    // Export at plate resolution.
    const t0 = performance.now();
    const exported = await cleanPlateExport(p, { shotId: 'C1', projectKey: 'k', operator: 'Ana' }, out, env, { now: NOW });
    const ms = performance.now() - t0;
    const names = (await readdir(exported.folder)).sort();
    const seq = (stem: string, ext: string) => Array.from({ length: FRAMES }, (_, i) => `C1_${stem}_v001.${1001 + i}.${ext}`);
    expect(names.filter((x) => x.startsWith('C1_cleanplate_v001.') && x.endsWith('.exr'))).toEqual(seq('cleanplate', 'exr'));
    expect(names.filter((x) => x.startsWith('C1_cleanplate_conf'))).toEqual(seq('cleanplate_conf', 'png'));
    expect(names.filter((x) => x.startsWith('C1_cleanplate_unresolved'))).toEqual(seq('cleanplate_unresolved', 'png'));
    expect(names).toContain('C1_cleanplate_v001.json');
    expect(names).toContain('README.txt');
    // Read a plate back: linear ACEScg, half float, rebuilt where the crew member was.
    const file = join(exported.folder, 'C1_cleanplate_v001.1005.exr');
    expect(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height,pix_fmt', '-of', 'csv=p=0', file]).stdout.toString().trim()).toMatch(/^320,180,gbrpf/);
    const raw = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'gbrpf32le', '-']).stdout;
    const planes = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
    const N = 320 * 180;
    const truth = scene.clean(4).data;
    let err = 0;
    const idx = revealed(scene, 4);
    for (const k of idx) {
      const t = LUMA[0] * truth[3 * k]! + LUMA[1] * truth[3 * k + 1]! + LUMA[2] * truth[3 * k + 2]!;
      const e = (Math.abs(planes[2 * N + k]! - truth[3 * k]!) + Math.abs(planes[k]! - truth[3 * k + 1]!) + Math.abs(planes[N + k]! - truth[3 * k + 2]!)) / 3;
      err += e / Math.max(0.02, t);
    }
    err /= idx.length;
    console.log(`export (320×180, ${FRAMES} frames, EXR round trip): revealed error ${(err * 100).toFixed(2)} %, ${(ms / FRAMES).toFixed(0)} ms/frame`);
    expect(err).toBeLessThan(0.03);
    const conf = decodePng(await readFile(join(exported.folder, 'C1_cleanplate_conf_v001.1005.png')));
    expect([conf.width, conf.height, conf.bitDepth]).toEqual([320, 180, 16]);
    const unres = decodePng(await readFile(join(exported.folder, 'C1_cleanplate_unresolved_v001.1005.png')));
    const stand = scene.stand(4);
    let inStand = 0;
    let flagged = 0;
    for (let k = 0; k < N; k += 1) if (stand[k]! > 0.99) (inStand += 1), (flagged += (unres.data[k]! > 32768 ? 1 : 0));
    expect(flagged / inStand).toBeGreaterThan(0.95);
    const meta = JSON.parse(await readFile(join(exported.folder, 'C1_cleanplate_v001.json'), 'utf8'));
    expect(meta).toMatchObject({ format: 'vcvfx.cleanplate/1', shot: 'C1', version: 'v001', mode: 'sequence', frames: { first: 1001, count: FRAMES }, resolution: { width: 320, height: 180 }, colour: { linear: true }, alignment: { model: 'homography' }, settings: { params: { dilatePx: 3 } } });
    expect(meta.alignment.frames).toHaveLength(FRAMES);
    expect(meta.perFrame).toHaveLength(FRAMES);
    expect(exported.record).toMatchObject({ version: 1, folder: '04_CLEAN_PLATES/C1_cleanplate_v001', mode: 'sequence', plate: 'C1_cleanplate_v001.%04d.exr', format: 'exr', frames: FRAMES, width: 320, height: 180, encoding: 'ACEScg (linear AP1)' });
    p = ok(recordCleanPlateExport(p, 'C1', exported.record, 'Ana', NOW));
    expect(shotState(p, 'C1')!.tasks.find((t) => t.kind === 'clean_plate')!.state).toBe('needs_review');

    // Approval is a person's act; the manifest carries the clean plate.
    p = ok(approveTask(p, 'C1', 'clean_plate', 'Sup', NOW));
    expect(buildManifest(p, 'C1', { generatedAt: NOW, appVersion: 'test', operator: 'Ana', files: [] }).cleanPlate).toMatchObject({ version: 'v001', state: 'approved', exported: true, folder: '04_CLEAN_PLATES/C1_cleanplate_v001', plate: 'C1_cleanplate_v001.%04d.exr' });
    // The approved version is never rewritten; reopening writes v002 beside it.
    await expect(cleanPlateExport(p, { shotId: 'C1', projectKey: 'k', operator: 'Ana' }, out, env)).rejects.toThrow(/approved and already written/);
    const v1 = (await stat(join(exported.folder, 'C1_cleanplate_v001.1001.exr'))).mtimeMs;
    p = ok(setTaskState(p, 'C1', 'clean_plate', 'needs_correction', 'Sup', NOW));
    p = ok(setCleanPlateSettings(p, 'C1', { mode: 'still' }, 'Ana', NOW));
    const again = await cleanPlateExport(p, { shotId: 'C1', projectKey: 'k', operator: 'Ana' }, out, env);
    expect(again.record).toMatchObject({ version: 2, mode: 'still', folder: '04_CLEAN_PLATES/C1_cleanplate_v002', plate: `C1_cleanplate_still_v002.${again.record.reference}.exr` });
    expect((await readdir(again.folder)).filter((x) => x.endsWith('.exr'))).toEqual([`C1_cleanplate_still_v002.${again.record.reference}.exr`]);
    expect((await stat(join(exported.folder, 'C1_cleanplate_v001.1001.exr'))).mtimeMs).toBe(v1);
    // The source media were only read.
    expect((await readdir(media)).filter((x) => !x.startsWith('C1_plate.'))).toEqual([]);
  }, 180_000);

  it('cancels a worker job between frames', async () => {
    const { project, env } = await drive();
    const controller = new AbortController();
    const seen: number[] = [];
    const run = cleanPlateBuild(project, { shotId: 'C1', projectKey: 'k' }, null, env, { signal: controller.signal, onProgress: (done) => (seen.push(done), done === 3 ? controller.abort() : undefined) });
    await expect(run).rejects.toThrow('Cancelled');
    expect(seen.length).toBeLessThan(3 * FRAMES);
    await expect(runCleanPlateJob({} as never, { workerFile: env.workerFile, signal: AbortSignal.abort() })).rejects.toThrow('Cancelled');
  }, 60_000);
});
