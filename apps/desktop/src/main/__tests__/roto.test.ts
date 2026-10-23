import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addPart,
  addStroke,
  approveShot,
  approveTask,
  buildManifest,
  createProject,
  parseHandoff,
  recordPlates,
  recordPropagation,
  recordRotoExport,
  setTaskState,
  shotState,
  type Project,
  type Result,
} from '@vcvfx/domain';
import { FULL_CAPS } from '../../shared/ffmpeg-args';
import { iou, type Mask } from '../../shared/roto/image';
import { discScene } from '../../shared/roto/synthetic';
import { FrameCache } from '../frame-cache';
import { packageShot } from '../package-shot';
import { generateSequence } from '../sequence';
import { rotoExport, rotoMask, rotoRun, rotoSession, type RotoEnv } from '../roto/api';
import { readFrames, rotoFrameSource, workingSize } from '../roto/frames';
import { downloadModel, isPinned, modelStatus, SAM2_MODEL, SAM2_MODELS, sam2Model, UNPINNED_REFUSAL, verifyModel, type FetchLike, type ModelInfo } from '../roto/models';
import { decodePng, encodePng } from '../roto/png';
import { checkSessions } from '../roto/sam2-ort';
import { runRotoJob } from '../roto/service';
import { MaskStore } from '../roto/store';
import { encodeScene, workerBundle } from './roto-helpers';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const NOW = new Date('2026-10-20T12:00:00Z');
const ok = (r: Result): Project => {
  if (!r.ok) throw new Error(r.reason);
  return r.project;
};

describe('PNG mattes', () => {
  it('round-trips 8- and 16-bit greyscale exactly', () => {
    const w = 37;
    const h = 11;
    const d8 = Uint8Array.from({ length: w * h }, (_, i) => (i * 7) % 256);
    const d16 = Uint16Array.from({ length: w * h }, (_, i) => (i * 2531) % 65536);
    const a = decodePng(encodePng({ width: w, height: h, bitDepth: 8, data: d8 }));
    const b = decodePng(encodePng({ width: w, height: h, bitDepth: 16, data: d16 }, { text: { Software: 'VC VFX' } }));
    expect([a.width, a.height, a.bitDepth]).toEqual([w, h, 8]);
    expect([...a.data]).toEqual([...d8]);
    expect(b.bitDepth).toBe(16);
    expect([...b.data]).toEqual([...d16]);
  });

  it.skipIf(!hasFfmpeg)('writes PNGs ffmpeg reads as 16-bit grey', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vcvfx-png-'));
    const data = Uint16Array.from({ length: 64 }, (_, i) => i * 1000);
    await writeFile(join(dir, 'a.png'), encodePng({ width: 8, height: 8, bitDepth: 16, data }));
    const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=pix_fmt,width,height', '-of', 'csv=p=0', join(dir, 'a.png')]);
    expect(r.stdout.toString().trim()).toBe('8,8,gray16be');
    const raw = spawnSync('ffmpeg', ['-v', 'error', '-i', join(dir, 'a.png'), '-f', 'rawvideo', '-pix_fmt', 'gray16le', '-']).stdout;
    expect(raw.readUInt16LE(2 * 63)).toBe(63000);
  });
});

describe('working matte store', () => {
  it('keeps one PNG per shot, part, version and frame, and falls back to earlier versions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vcvfx-store-'));
    const store = new MaskStore(root, '/projects/a.vcvfx', '010_020');
    const m: Mask = { width: 4, height: 2, data: Uint8Array.from([0, 64, 128, 255, 255, 0, 1, 2]) };
    await store.put('subject', 1, 1001, m);
    expect(store.file('subject', 1, 1001)).toMatch(/010_020[\\/]subject[\\/]v001[\\/]1001\.png$/);
    expect((await store.get('subject', 1, 1001))!.data).toEqual(m.data);
    // A reopened roto (v002) starts from v001's mattes.
    expect((await store.get('subject', 2, 1001))!.data).toEqual(m.data);
    expect(await store.get('subject', 2, 1002)).toBeNull();
    expect(await store.frames('subject', 1)).toEqual([1001]);
    expect(() => store.dir('../evil', 1)).toThrow();
    expect(MaskStore.at(store.root).file('subject', 1, 5)).toBe(store.file('subject', 1, 5));
  });
});

describe('SAM 2 model files', () => {
  const body = (bytes: Uint8Array) => new ReadableStream<Uint8Array>({ start: (c) => (c.enqueue(bytes), c.close()) });
  const fakeFetch = (files: Record<string, Uint8Array>): FetchLike => async (url) => {
    const name = url.split('/').pop()!;
    const bytes = files[name];
    return bytes ? { ok: true, status: 200, headers: { get: () => null }, body: body(bytes) } : { ok: false, status: 404, headers: { get: () => null }, body: null };
  };
  const files = { 'sam2.1_hiera_tiny.encoder.onnx': new Uint8Array([1, 2, 3]), 'sam2.1_hiera_tiny.decoder.onnx': new Uint8Array([4, 5]) };

  it('ships pinned: every model names a fixed revision, an exact size and a SHA-256 per file', () => {
    for (const m of SAM2_MODELS) {
      expect(isPinned(m)).toBe(true);
      expect(m.defaultBaseUrl).toMatch(/^https:\/\/huggingface\.co\/[\w.-]+\/[\w.-]+\/resolve\/[0-9a-f]{40}\//);
      expect(m.defaultBaseUrl).not.toMatch(/\/resolve\/main\//);
      expect(m.source?.revision).toMatch(/^[0-9a-f]{40}$/);
      expect(m.defaultBaseUrl).toContain(m.source!.revision);
      expect(m.licence).toMatch(/Apache-2\.0/);
      for (const f of m.files) {
        expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(Number.isInteger(f.approxBytes) && f.approxBytes > 1_000_000).toBe(true);
      }
    }
    expect(SAM2_MODEL.id).toBe('sam2.1_hiera_tiny');
    expect(sam2Model('sam2_hiera_base_plus').id).toBe('sam2_hiera_base_plus');
    expect(sam2Model('').id).toBe('sam2.1_hiera_tiny');
    expect(sam2Model('nonsense').id).toBe('sam2.1_hiera_tiny');
  });

  it('refuses files that do not match their pins, and an unpinned model in a packaged build', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'vcvfx-models-'));
    await expect(downloadModel({ userData, packaged: true, fetch: fakeFetch(files) })).rejects.toThrow(/does not match its pinned SHA-256 and size/);
    expect((await modelStatus(userData, true)).present).toBe(false);
    const unpinned: ModelInfo = { ...SAM2_MODEL, id: 'unpinned', files: SAM2_MODEL.files.map((f) => ({ ...f, sha256: null })) };
    await expect(downloadModel({ userData, packaged: true, fetch: fakeFetch(files), model: unpinned })).rejects.toThrow(UNPINNED_REFUSAL);
    expect(await modelStatus(userData, true, unpinned)).toMatchObject({ present: false, pinned: false, usable: false, reason: UNPINNED_REFUSAL });
  });

  it('downloads an unpinned model in development and records the hashes to pin', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'vcvfx-models-'));
    const unpinned: ModelInfo = { ...SAM2_MODEL, id: 'unpinned', files: SAM2_MODEL.files.map((f) => ({ ...f, sha256: null })) };
    const got = await downloadModel({ userData, packaged: false, fetch: fakeFetch(files), baseUrl: 'https://example.test/models', model: unpinned });
    expect(got.unpinned).toBe(true);
    expect(got.hashes['sam2.1_hiera_tiny.encoder.onnx']).toBe('039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81');
    expect(JSON.parse(await readFile(join(got.dir, 'PINS.json'), 'utf8')).hashes).toEqual(got.hashes);
    expect((await modelStatus(userData, false, unpinned)).usable).toBe(true);
    // A packaged build checks the files on disk against the pins before every run.
    expect(await verifyModel(userData, { ...unpinned, files: SAM2_MODEL.files })).toMatchObject({ ok: false });
    await expect(downloadModel({ userData, packaged: false, fetch: fakeFetch(files), baseUrl: 'http://insecure.test/' })).rejects.toThrow(/https/);
  });

  it('refuses model files whose tensors are not samexporter’s', () => {
    const enc = { inputNames: ['image'], outputNames: ['high_res_feats_0', 'high_res_feats_1', 'image_embed'] };
    const dec = { inputNames: ['image_embed', 'high_res_feats_0', 'high_res_feats_1', 'point_coords', 'point_labels', 'mask_input', 'has_mask_input'], outputNames: ['masks', 'iou_predictions'] };
    expect(checkSessions(enc, dec)).toBeNull();
    expect(checkSessions({ inputNames: ['pixel_values'], outputNames: [] }, dec)).toMatch(/missing encoder input image, encoder output high_res_feats_0/);
  });
});

/** A shot on a temporary drive whose source is a ProRes clip of the synthetic disc. */
async function discDrive(frames = 16) {
  const root = await mkdtemp(join(tmpdir(), 'vcvfx-roto-'));
  const drive = join(root, 'DRIVE');
  await mkdir(join(drive, 'VFX/R1'), { recursive: true });
  const scene = discScene({ frames });
  await encodeScene('ffmpeg', scene, join(drive, 'VFX/R1/disc.mov'));
  const handoff = {
    project: 'Roto Test',
    output: { format: 'png', bitDepth: 16, startFrame: 1001 },
    shots: [
      {
        shotId: 'R1',
        scene: '1',
        sourcePath: 'VFX/R1/disc.mov',
        frameIn: 0,
        frameOut: frames - 1,
        handles: 0,
        frameRate: 24,
        resolution: { width: scene.width, height: scene.height },
        color: { sourceColorSpace: 'Rec.709' },
        tasks: [{ kind: 'sequence_conversion' }, { kind: 'roto' }],
        checksums: [],
      },
    ],
  };
  await writeFile(join(drive, 'handoff.json'), JSON.stringify(handoff));
  const parsed = parseHandoff(JSON.stringify(handoff));
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  const project = createProject(parsed.handoff, join(drive, 'handoff.json'), 'Tester', NOW);
  const userData = join(root, 'userData');
  const env: RotoEnv = {
    ffmpeg: 'ffmpeg',
    caps: FULL_CAPS,
    cacheRoot: join(userData, 'Roto Cache'),
    frameCache: new FrameCache({ dir: join(userData, 'Frame Cache') }),
    userData,
    packaged: false,
    ort: ['/nowhere/onnxruntime-node'],
    workerFile: await workerBundle(),
    generator: 'VC VFX test',
  };
  return { root, drive, project, scene, env, out: join(root, 'OUT') };
}

const strokesAt = (cx: number, cy: number) => [
  { mode: 'include' as const, radius: 6, points: [[cx - 10, cy - 2], [cx + 10, cy]] as [number, number][] },
  { mode: 'exclude' as const, radius: 6, points: [[10, 20], [300, 30], [300, 220]] as [number, number][] },
];

describe.skipIf(!hasFfmpeg)('roto frames from real media', () => {
  it('reads consecutive frames at the working size through ffmpeg, matching the clip', async () => {
    const { project, env, scene } = await discDrive(8);
    const src = await rotoFrameSource(project, 'R1', null, { ffmpeg: 'ffmpeg', caps: FULL_CAPS, cacheDir: env.frameCache.dir });
    if (!src.ok) throw new Error(src.reason);
    expect(src.spec).toMatchObject({ first: 1001, last: 1008, label: 'source', plate: { width: 320, height: 240 } });
    expect(workingSize({ width: 4096, height: 2160 }, 1920)).toEqual({ width: 1920, height: 1012 });
    const got: number[] = [];
    let third: Uint8Array | null = null;
    await readFrames(src.spec, 1002, 3, { width: 320, height: 240 }, (f, img) => {
      got.push(f);
      if (f === 1003) third = img.data as Uint8Array;
    });
    expect(got).toEqual([1002, 1003, 1004]);
    // Frame 1003 is scene frame 2: the disc is where the scene drew it.
    const truth = scene.truth(2);
    let orange = 0;
    let hit = 0;
    for (let i = 0; i < truth.length; i += 1) {
      const isOrange = third![3 * i]! > 150 && third![3 * i + 2]! < 90;
      if (isOrange) orange += 1;
      if (isOrange && truth[i]) hit += 1;
    }
    expect(hit / orange).toBeGreaterThan(0.95);
  });

  it('cancels a worker-thread job between frames', async () => {
    const { project, env } = await discDrive(16);
    let p = ok(addStroke(project, 'R1', 'subject', 1001, strokesAt(80, 108)[0]!, 'Ana', NOW));
    p = ok(addStroke(p, 'R1', 'subject', 1001, strokesAt(80, 108)[1]!, 'Ana', NOW));
    const controller = new AbortController();
    const seen: number[] = [];
    const run = rotoRun(p, { shotId: 'R1', projectKey: 'k', partId: 'subject', from: 1001, directions: ['key', 'forward'] }, null, env, {
      signal: controller.signal,
      onProgress: (done) => {
        seen.push(done);
        if (done === 3) controller.abort();
      },
    });
    await expect(run).rejects.toThrow('Cancelled');
    const store = new MaskStore(env.cacheRoot, 'k', 'R1');
    const written = await store.frames('subject', 1);
    expect(written.length).toBeGreaterThanOrEqual(3);
    expect(written.length).toBeLessThan(16);
    // A job that never starts is refused straight away.
    await expect(runRotoJob({} as never, { workerFile: env.workerFile, signal: AbortSignal.abort() })).rejects.toThrow('Cancelled');
  });

  it('clip → plates → paint → propagate → export: versioned files, needs review, in the manifest', async () => {
    const { project, env, scene, out } = await discDrive(16);
    // Plates first: roto then reads them in preference to the source.
    let p = ok(setTaskState(project, 'R1', 'sequence_conversion', 'processing', 'Ana', NOW));
    const plates = await generateSequence({ project: p, shotId: 'R1', outputRoot: out, ffmpeg: 'ffmpeg' });
    if (!plates.ok) throw new Error(plates.reason);
    p = ok(recordPlates(p, 'R1', plates.record, 'Ana', NOW));
    p = ok(setTaskState(p, 'R1', 'sequence_conversion', 'needs_review', 'Ana', NOW));
    const session = await rotoSession(p, 'R1', out, env);
    expect(session).toMatchObject({ available: true, frames: 'plates v001', plate: { width: 320, height: 240 }, working: { width: 320, height: 240 }, first: 1001, last: 1016 });
    expect(session.engines.map((e) => [e.id, e.available])).toEqual([
      ['track', true],
      ['sam2', false],
    ]);

    // Paint the key frame (simulated strokes), with a component part as well.
    for (const s of strokesAt(80, 108)) p = ok(addStroke(p, 'R1', 'subject', 1001, s, 'Ana', NOW));
    p = ok(addPart(p, 'R1', { name: 'Core' }, 'Ana', NOW));
    p = ok(addStroke(p, 'R1', 'core', 1001, { mode: 'include', radius: 5, points: [[78, 106], [82, 110]] }, 'Ana', NOW));
    p = ok(addStroke(p, 'R1', 'core', 1001, { mode: 'exclude', radius: 4, points: [[10, 20], [300, 30]] }, 'Ana', NOW));
    const progress: number[] = [];
    const results = await rotoRun(p, { shotId: 'R1', projectKey: 'k', partId: 'subject', from: 1001, directions: ['key', 'forward'] }, out, env, { onProgress: (d) => progress.push(d) });
    expect(progress.at(-1)).toBe(16);
    for (const r of results) p = ok(recordPropagation(p, 'R1', r, 'Ana', NOW));
    const core = await rotoRun(p, { shotId: 'R1', projectKey: 'k', partId: 'core', from: 1001, directions: ['key'] }, out, env);
    for (const r of core) p = ok(recordPropagation(p, 'R1', r, 'Ana', NOW));
    expect(shotState(p, 'R1')!.tasks.find((t) => t.kind === 'roto')!.state).toBe('needs_review');
    const frames = shotState(p, 'R1')!.roto!.parts[0]!.frames;
    expect(frames.map((f) => f.frame)).toEqual(Array.from({ length: 16 }, (_, i) => 1001 + i));
    expect(frames.every((f) => f.engine === 'track@1.0.0' && f.confidence > 0.6)).toBe(true);

    // The overlay's matte matches the disc on every frame.
    for (let f = 1001; f <= 1016; f += 1) {
      const m = (await rotoMask(p, { shotId: 'R1', projectKey: 'k', partId: 'subject', frame: f, maxWidth: 320 }, env))!;
      expect(iou({ width: m.width, height: m.height, data: m.alpha }, scene.truth(f - 1001))).toBeGreaterThan(0.9);
    }
    const combined = (await rotoMask(p, { shotId: 'R1', projectKey: 'k', partId: null, frame: 1001, maxWidth: 160 }, env))!;
    expect([combined.width, combined.height]).toEqual([160, 120]);

    // Export: versioned 16-bit PNGs at plate resolution, metadata beside them.
    const exported = await rotoExport(p, { shotId: 'R1', projectKey: 'k', operator: 'Ana', exr: true }, out, env, { now: NOW });
    const mattes = join(exported.folder, 'R1_matte_v001');
    const names = (await readdir(mattes)).sort();
    expect(names.filter((n) => n.endsWith('.png'))).toEqual(Array.from({ length: 16 }, (_, i) => `R1_matte_v001.${1001 + i}.png`));
    expect(names.filter((n) => n.endsWith('.exr'))).toHaveLength(16);
    expect((await readdir(join(exported.folder, 'R1_roto_core_v001'))).filter((n) => n.endsWith('.png'))).toHaveLength(16);
    const png = decodePng(await readFile(join(mattes, 'R1_matte_v001.1009.png')));
    expect([png.width, png.height, png.bitDepth]).toEqual([320, 240, 16]);
    const alpha: Mask = { width: 320, height: 240, data: Uint8Array.from(png.data as Uint16Array, (v) => v >> 8) };
    expect(iou(alpha, scene.truth(8))).toBeGreaterThan(0.9);
    const meta = JSON.parse(await readFile(join(exported.folder, 'R1_roto_v001.json'), 'utf8'));
    expect(meta).toMatchObject({ format: 'vcvfx.roto/1', shot: 'R1', version: 'v001', frames: { first: 1001, last: 1016, count: 16 }, resolution: { width: 320, height: 240 }, source: 'plates v001' });
    expect(meta.parts.map((x: { id: string }) => x.id)).toEqual(['subject', 'core']);
    expect(meta.parts[0].frames).toHaveLength(16);
    expect(exported.record).toMatchObject({ version: 1, pattern: 'R1_matte_v001.%04d.png', width: 320, height: 240, bitDepth: 16, exr: true, frames: 16, engines: ['track@1.0.0'] });
    p = ok(recordRotoExport(p, 'R1', exported.record, 'Ana', NOW));
    expect(shotState(p, 'R1')!.tasks.find((t) => t.kind === 'roto')!.state).toBe('needs_review');

    // Approval is a person's act; then the package's manifest carries roto.
    p = ok(approveTask(p, 'R1', 'sequence_conversion', 'Sup', NOW));
    p = ok(approveTask(p, 'R1', 'roto', 'Sup', NOW));
    p = ok(approveShot(p, 'R1', 'Sup', NOW));
    const pkg = await packageShot({ project: p, shotId: 'R1', outputRoot: out, operator: 'Ana', appVersion: 'test', now: NOW });
    if (!pkg.ok) throw new Error(pkg.reason);
    const manifest = JSON.parse(await readFile(join(pkg.folder, 'manifest.json'), 'utf8')) as ReturnType<typeof buildManifest>;
    expect(manifest.roto).toMatchObject({ version: 'v001', state: 'approved', exported: true, combined: 'R1_matte_v001.%04d.png', engines: ['track@1.0.0'], confidence: { frames: 16 } });
    expect(manifest.checksums.delivered.some((d) => d.path === '02_MATTES_ROTO/R1_matte_v001/R1_matte_v001.1001.png')).toBe(true);

    // The approved version is never rewritten.
    await expect(rotoExport(p, { shotId: 'R1', projectKey: 'k', operator: 'Ana', exr: false }, out, env)).rejects.toThrow(/approved and already written|is packaged/);
    expect((await stat(join(mattes, 'R1_matte_v001.1001.png'))).size).toBeGreaterThan(0);
  });
});
