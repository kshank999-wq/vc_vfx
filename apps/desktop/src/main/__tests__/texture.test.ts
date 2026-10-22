import { describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  addTextureReference,
  addTextureRegion,
  approveTask,
  buildManifest,
  createProject,
  parseHandoff,
  recordTextureExport,
  recordTextureRun,
  setTaskState,
  setTextureReference,
  shotState,
  textureDoc,
  type Project,
  type Result,
} from '@vcvfx/domain';
import { FULL_CAPS } from '../../shared/ffmpeg-args';
import { buildExrWriteArgs, toPlanar } from '../../shared/key/ffmpeg-key';
import { srgbEncode } from '../../shared/texture/image';
import { parseMtlText, parseObjText } from '../../shared/texture/obj';
import { PANO_POSITION, SAMPLE_PHOTOS, renderPanorama, renderPhoto, sampleRegions, scanCloud, type SampleSetOptions } from '../../shared/texture/synthetic';
import { textureBuild, textureExport, textureImage, textureIngest, textureScan, textureSession, type TextureEnv } from '../texture/api';

/**
 * Texture extraction on real files (addendum 12 §4): the synthetic storeroom
 * written to a "drive" as JPEG stills, a half-float EXR panorama and a
 * coloured PLY scan, named by the handoff; then the session, the read-only
 * ingest (checksums), a build in the worker, the review pictures and the
 * scan, and a versioned export into 07_TEXTURES_REFERENCES read back with
 * ffmpeg and the OBJ reader — and the references byte-for-byte unchanged.
 */

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const NOW = new Date('2026-10-22T12:00:00Z');
const ok = (r: Result): Project => {
  if (!r.ok) throw new Error(r.reason);
  return r.project;
};
const PW = 480;
const PH = 360;
const SET: SampleSetOptions = { photo: { width: PW, height: PH, supersample: 1 }, panorama: { width: 1024, supersample: 1, heading: 25 }, scan: { spacing: 0.08, up: 'z' } };

let built: Promise<string> | null = null;
function worker(): Promise<string> {
  built ??= (async () => {
    const { build } = await import('vite');
    const out = await mkdtemp(join(tmpdir(), 'vcvfx-texture-worker-'));
    await build({ configFile: false, logLevel: 'silent', ssr: { noExternal: true }, build: { ssr: resolve(__dirname, '../texture/worker.ts'), outDir: out, emptyOutDir: true, minify: false, rollupOptions: { output: { format: 'cjs', entryFileNames: 'texture-worker.js' } } } });
    return join(out, 'texture-worker.js');
  })();
  return built;
}

function pipeTo(args: string[], data: Buffer): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolvePromise() : reject(new Error(err))));
    child.stdin.end(data);
  });
}

const sha = async (file: string) => createHash('sha256').update(await readFile(file)).digest('hex');
const probe = (file: string) => {
  const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,pix_fmt', '-of', 'json', file]);
  return (JSON.parse(r.stdout.toString()) as { streams: { width: number; height: number; pix_fmt: string }[] }).streams[0]!;
};

async function drive() {
  const root = await mkdtemp(join(tmpdir(), 'vcvfx-texture-'));
  const ref = join(root, 'DRIVE', 'VFX', 'REF');
  await mkdir(ref, { recursive: true });
  // The stills: 8-bit sRGB JPEG, as a still camera writes them.
  for (const p of SAMPLE_PHOTOS) {
    const img = renderPhoto({ ...p.camera, width: PW, height: PH, supersample: 1 });
    const rgb = Buffer.from(Uint8Array.from(img.data, (v) => Math.round(srgbEncode(v) * 255)));
    await pipeTo(['-hide_banner', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${PW}x${PH}`, '-i', 'pipe:0', '-q:v', '2', '-frames:v', '1', join(ref, p.name)], rgb);
  }
  // The panorama: half-float EXR, linear.
  const pano = renderPanorama(1024, 512, PANO_POSITION, 25, 1, 1);
  const planes = toPlanar('rgb', 1024 * 512, pano.data, null);
  await pipeTo(buildExrWriteArgs({ layout: 'rgb', width: 1024, height: 512, frameRate: 1, startNumber: 0, output: join(ref, 'storeroom_360.exr') }), Buffer.from(planes.buffer, planes.byteOffset, planes.byteLength));
  // The scan: a coloured ASCII PLY, Z-up, metres.
  const cloud = scanCloud(0.08, { up: 'z' });
  const lines = ['ply', 'format ascii 1.0', `element vertex ${cloud.count}`, 'property float x', 'property float y', 'property float z', 'property uchar red', 'property uchar green', 'property uchar blue', 'end_header'];
  for (let i = 0; i < cloud.count; i += 1) lines.push(`${cloud.positions[3 * i]!.toFixed(4)} ${cloud.positions[3 * i + 1]!.toFixed(4)} ${cloud.positions[3 * i + 2]!.toFixed(4)} ${cloud.colors![3 * i]} ${cloud.colors![3 * i + 1]} ${cloud.colors![3 * i + 2]}`);
  await mkdir(join(root, 'DRIVE', 'VFX', 'LIDAR'), { recursive: true });
  await writeFile(join(root, 'DRIVE', 'VFX', 'LIDAR', 'storeroom.ply'), `${lines.join('\n')}\n`);
  const handoff = {
    project: 'Texture Test',
    output: { format: 'exr', bitDepth: 16, startFrame: 1001 },
    shots: [
      {
        shotId: 'T1',
        scene: '1',
        sourcePath: 'VFX/T1/T1.mov',
        frameIn: 0,
        frameOut: 23,
        handles: 0,
        frameRate: 24,
        color: { sourceColorSpace: 'ACEScg' },
        tasks: [{ kind: 'texture_extraction' }],
        references: [...SAMPLE_PHOTOS.map((p) => ({ kind: 'reference_photo', path: `VFX/REF/${p.name}` })), { kind: 'lidar', path: 'VFX/LIDAR/storeroom.ply' }],
        checksums: [],
      },
    ],
  };
  const handoffPath = join(root, 'DRIVE', 'handoff.json');
  await writeFile(handoffPath, JSON.stringify(handoff));
  const parsed = parseHandoff(JSON.stringify(handoff));
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  const project = createProject(parsed.handoff, handoffPath, 'Tester', NOW);
  const env: TextureEnv = { ffmpeg: 'ffmpeg', caps: FULL_CAPS, cacheRoot: join(root, 'userData', 'Texture Cache'), workerFile: await worker(), generator: 'VC VFX test' };
  const out = join(root, 'OUT');
  await mkdir(out, { recursive: true });
  return { project, env, out, ref, root };
}

describe.skipIf(!hasFfmpeg)('texture extraction on real files', () => {
  it('ingests read-only, builds in the worker, exports versioned maps, the mapping and the mesh, and never touches a reference', async () => {
    const { project, env, out, ref, root } = await drive();
    const files = [...SAMPLE_PHOTOS.map((p) => join(ref, p.name)), join(ref, 'storeroom_360.exr'), join(root, 'DRIVE', 'VFX', 'LIDAR', 'storeroom.ply')];
    const before = await Promise.all(files.map(async (f) => ({ hash: await sha(f), mtime: (await stat(f)).mtimeMs })));

    const session = await textureSession(project, 'T1', env);
    expect(session.available).toBe(true);
    expect(session.handoff.map((h) => [h.kind, h.onDisk])).toEqual([
      ['photo', true],
      ['photo', true],
      ['photo', true],
      ['scan', true],
    ]);

    // Ingest: from the handoff (photos, scan) and from disk (the panorama).
    const photos = await textureIngest(project, 'T1', 'photo', SAMPLE_PHOTOS.map((p) => ({ path: `VFX/REF/${p.name}`, from: 'handoff' as const })), env);
    const pano = await textureIngest(project, 'T1', 'panorama', [{ path: join(ref, 'storeroom_360.exr'), from: 'disk' }], env);
    const scan = await textureIngest(project, 'T1', 'scan', [{ path: 'VFX/LIDAR/storeroom.ply', from: 'handoff' }], env);
    expect(photos.map((r) => [r.width, r.height, r.encoding, r.checksum?.value])).toEqual(await Promise.all(SAMPLE_PHOTOS.map(async (p) => [PW, PH, 'srgb', await sha(join(ref, p.name))])));
    expect(pano[0]).toMatchObject({ width: 1024, height: 512, encoding: 'linear_rec709', from: 'disk' });
    expect(scan[0]).toMatchObject({ points: scanCloud(0.08, { up: 'z' }).count, scan: { units: 'm', up: 'y' } });
    await expect(textureIngest(project, 'T1', 'photo', [{ path: join(ref, 'missing.jpg'), from: 'disk' }], env)).rejects.toThrow(/not on the drive/);
    await expect(textureIngest(project, 'T1', 'photo', [{ path: join(root, 'DRIVE', 'VFX', 'LIDAR', 'storeroom.ply'), from: 'disk' }], env)).rejects.toThrow(/not a picture/);

    let p = project;
    for (const r of [...photos, ...pano, ...scan]) p = ok(addTextureReference(p, 'T1', r, 'Ana', NOW));
    const doc0 = textureDoc(shotState(p, 'T1'))!;
    // The scan is Z-up (the PLY default guess is Y-up): set it. The stills' lens, as a lens profile would give it.
    const scanRef = doc0.references.find((r) => r.kind === 'scan')!;
    p = ok(setTextureReference(p, 'T1', scanRef.id, { scan: { up: 'z' } }, 'Ana', NOW));
    for (const [i, s] of SAMPLE_PHOTOS.entries()) {
      const rec = sampleRegions(SET)[i]!;
      const ph = doc0.references.find((r) => r.name === s.name)!;
      const f = PW / 2 / Math.tan((s.camera.fov * Math.PI) / 360);
      p = ok(setTextureReference(p, 'T1', ph.id, { camera: { focalMm: (f / PW) * 36, filmBackWidthMm: 36, distortion: { k1: s.camera.k1 ?? 0, k2: 0, k3: 0, p1: 0, p2: 0 } } }, 'Ana', NOW));
      p = ok(addTextureRegion(p, 'T1', { photoId: ph.id, corners: rec.corners, name: rec.name, size: rec.size, settings: { tile: i === 0 ? 'xy' : 'none', output: { mode: 'density', density: 120 } } }, 'Ana', NOW));
    }

    // Build in the worker; the review pictures and the scan with its planes come from the cache.
    const progress: number[] = [];
    const result = await textureBuild(p, { shotId: 'T1', projectKey: 'k' }, env, { onProgress: (d) => progress.push(d) });
    expect(progress.length).toBeGreaterThan(3);
    expect(result.regions).toHaveLength(3);
    expect(result.planes).toHaveLength(6);
    p = ok(recordTextureRun(p, 'T1', result, 'Ana', NOW));
    const doc = textureDoc(shotState(p, 'T1'))!;
    const brick = doc.regions[0]!;
    const photoView = await textureImage(p, { shotId: 'T1', projectKey: 'k', request: { kind: 'reference', id: brick.photoId, maxWidth: 240 } }, env);
    expect([photoView.width, photoView.height]).toEqual([240, 180]);
    const tiled = await textureImage(p, { shotId: 'T1', projectKey: 'k', request: { kind: 'texture', regionId: brick.id, stage: 'tiled', maxWidth: 1024 } }, env);
    expect(tiled.built).toBe('current');
    expect(tiled.width).toBeLessThan(Math.round(1.6 * 120));
    const view = await textureScan(p, { shotId: 'T1', projectKey: 'k' }, env);
    expect(view!.planeIds).toHaveLength(6);
    expect(view!.planeOf!.some((v) => v > 0)).toBe(true);
    expect(view!.patches).toHaveLength(3);
    const brickRec = doc.records.find((r) => r.regionId === brick.id)!;
    expect(doc.planes.find((x) => x.id === brickRec.metrics.planeId)!.label).toBe('wall facing +Y');

    // Never under the references (or the camera media).
    await expect(textureExport(p, { shotId: 'T1', projectKey: 'k', operator: 'Ana' }, join(ref, 'OUT'), env)).rejects.toThrow(/inside a source media or reference folder/);

    const exported = await textureExport(p, { shotId: 'T1', projectKey: 'k', operator: 'Ana' }, out, env, { now: NOW });
    const folder = exported.folder;
    expect(folder.endsWith(join('07_TEXTURES_REFERENCES', 'T1_tex_v001'))).toBe(true);
    const names = (await readdir(folder)).sort();
    expect(names).toContain('README.txt');
    expect(names).toContain('T1_tex_v001.json');
    expect(names).toContain('T1_tex_v001.obj');
    expect(names).toContain('T1_tex_v001.mtl');
    const r0 = exported.record.regions[0]!;
    expect(r0.map).toBe('T1_tex_r6_Brick_wall_v001.png');
    expect(names).toEqual(expect.arrayContaining([r0.map, r0.mapExr!, r0.mask, r0.original!, r0.tilePreview!]));
    expect(exported.record.files).toBe(names.length);
    // The texture: 16-bit PNG and half-float EXR, the same size; the tile preview three by three.
    const png = probe(join(folder, r0.map));
    expect(png.pix_fmt).toMatch(/rgb48/);
    const exr = probe(join(folder, r0.mapExr!));
    expect([exr.width, exr.height]).toEqual([png.width, png.height]);
    expect(png.width).toBe(r0.width);
    expect(probe(join(folder, r0.tilePreview!)).width).toBe(3 * png.width);
    // The others at their texel density: 120 px/m of their real size.
    const r1 = exported.record.regions[1]!;
    expect([r1.width, r1.height]).toEqual([192, 144]);
    // The mapping file.
    const meta = JSON.parse(await readFile(join(folder, 'T1_tex_v001.json'), 'utf8'));
    expect(meta).toMatchObject({ format: 'vcvfx.texture/1', task: 'texture_extraction', version: 'v001', mesh: { obj: 'T1_tex_v001.obj' } });
    expect(meta.references).toHaveLength(5);
    expect(meta.regions[1]).toMatchObject({ name: 'Plaster wall', realSize: { width: 1.6 }, texture: { width: 192, height: 144, texelDensity: 120 }, undistorted: true });
    expect(meta.regions[0].homography).toHaveLength(9);
    expect(meta.regions[0].surface.label).toBe('wall facing +Y');
    expect(meta.regions[0].patch).toHaveLength(4);
    // The mesh reads back: three patches, materials mapping the PNGs.
    const obj = parseObjText(await readFile(join(folder, 'T1_tex_v001.obj'), 'utf8'));
    const mtl = parseMtlText(await readFile(join(folder, 'T1_tex_v001.mtl'), 'utf8'));
    expect(obj.objects).toHaveLength(3);
    expect(obj.objects.map((o) => mtl.get(o.material!))).toEqual(exported.record.regions.map((r) => r.map));
    // The back wall's patch sits on the wall (Y = −2.5 in the Z-up scan).
    const brickVerts = obj.objects[0]!.faces[0]!.v.map((k) => obj.vertices[k]!);
    for (const v of brickVerts) expect(Math.abs(v[1] + 2.5)).toBeLessThan(0.03);

    // Record, approve; the approved version is never rewritten; reopened, v002 goes beside it.
    p = ok(recordTextureExport(p, 'T1', exported.record, 'Ana', NOW));
    p = ok(approveTask(p, 'T1', 'texture_extraction', 'Sup', NOW));
    await expect(textureExport(p, { shotId: 'T1', projectKey: 'k', operator: 'Ana' }, out, env)).rejects.toThrow(/approved and already written/);
    p = ok(setTaskState(p, 'T1', 'texture_extraction', 'needs_correction', 'Sup', NOW));
    p = ok(recordTextureRun(p, 'T1', { ...(await textureBuild(p, { shotId: 'T1', projectKey: 'k' }, env)) }, 'Ana', NOW));
    const v2 = await textureExport(p, { shotId: 'T1', projectKey: 'k', operator: 'Ana' }, out, env, { now: NOW });
    expect(v2.folder.endsWith('T1_tex_v002')).toBe(true);
    expect((await readdir(folder)).sort()).toEqual(names);
    p = ok(recordTextureExport(p, 'T1', v2.record, 'Ana', NOW));
    const manifest = buildManifest(p, 'T1', { generatedAt: NOW, appVersion: '0.1.0', operator: 'Ana', files: [] }).texture!;
    expect(manifest).toMatchObject({ version: 'v002', exported: true, folder: '07_TEXTURES_REFERENCES/T1_tex_v002', obj: '07_TEXTURES_REFERENCES/T1_tex_v002/T1_tex_v002.obj' });

    // The references were only read.
    const after = await Promise.all(files.map(async (f) => ({ hash: await sha(f), mtime: (await stat(f)).mtimeMs })));
    expect(after).toEqual(before);
  }, 180_000);
});

describe('the handoff references offered to the Textures tab', () => {
  it('offers a file the handoff names twice (panorama and HDRI) once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vcvfx-texture-refs-'));
    const handoff = {
      project: 'Refs',
      shots: [
        {
          shotId: 'R1',
          scene: '1',
          sourcePath: 'VFX/R1/R1.mov',
          frameIn: 0,
          frameOut: 9,
          frameRate: 24,
          tasks: [{ kind: 'texture_extraction' }],
          references: [
            { kind: 'panorama', path: 'VFX/REF/set_360.exr' },
            { kind: 'hdri', path: 'VFX/REF/set_360.exr' },
            { kind: 'reference_photo', path: 'VFX/REF/wall.jpg' },
          ],
        },
      ],
    };
    const parsed = parseHandoff(JSON.stringify(handoff));
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
    const project = createProject(parsed.handoff, join(root, 'handoff.json'), 'Tester', NOW);
    const env: TextureEnv = { ffmpeg: 'ffmpeg', caps: FULL_CAPS, cacheRoot: join(root, 'cache'), workerFile: 'unused.js', generator: 'VC VFX test' };
    const session = await textureSession(project, 'R1', env);
    expect(session.handoff.map((h) => [h.kind, h.path])).toEqual([
      ['panorama', 'VFX/REF/set_360.exr'],
      ['photo', 'VFX/REF/wall.jpg'],
    ]);
  });
});
