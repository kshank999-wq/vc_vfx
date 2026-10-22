import { describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  KeyDocumentSchema,
  addTask,
  approveTask,
  compDoc,
  createProject,
  parseHandoff,
  recordCompExport,
  recordCompRender,
  setCompParams,
  shotState,
  startComp,
  type Project,
  type Result,
} from '@vcvfx/domain';
import { FULL_CAPS } from '../../shared/ffmpeg-args';
import { CompEvaluator } from '../../shared/comp/evaluate';
import { parseNukeTopology } from '../../shared/comp/nuke';
import { buildExrWriteArgs, toPlanar } from '../../shared/key/ffmpeg-key';
import { greenScreenScene } from '../../shared/key/synthetic';
import { compExport, compFrameView, compRender, compSession, type CompEnv } from '../comp/api';
import { createCompIO, readRgbaFile } from '../comp/io';
import { shotFolder } from '../package-shot';
import { encodePng } from '../roto/png';

/**
 * The compositor on real media (addendum 13 §4–6): a synthetic green-screen
 * shot written as a linear ACEScg EXR sequence on a "drive", a background
 * reference beside it, and the key's export (despilled foreground EXR and
 * 16-bit alpha PNGs) in the shot package. Then the session, preview frames
 * (a parameter change recomputes only downstream), a render in the worker
 * read back with ffmpeg, and the export for Nuke: graph, script, graph
 * manifest with checksums, the baked light wrap, README; versioned, never
 * rewritten once approved, never under the source paths.
 */

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const NOW = new Date('2026-10-22T12:00:00Z');
const ok = (r: Result): Project => {
  if (!r.ok) throw new Error(r.reason);
  return r.project;
};

let built: Promise<string> | null = null;
function worker(): Promise<string> {
  built ??= (async () => {
    const { build } = await import('vite');
    const out = await mkdtemp(join(tmpdir(), 'vcvfx-comp-worker-'));
    await build({ configFile: false, logLevel: 'silent', ssr: { noExternal: true }, build: { ssr: resolve(__dirname, '../comp/worker.ts'), outDir: out, emptyOutDir: true, minify: false, rollupOptions: { output: { format: 'cjs', entryFileNames: 'comp-worker.js' } } } });
    return join(out, 'comp-worker.js');
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
const buf = (p: Float32Array) => Buffer.from(p.buffer, p.byteOffset, p.byteLength);

const FRAMES = 6;
const W = 192;
const H = 108;

async function drive() {
  const root = await mkdtemp(join(tmpdir(), 'vcvfx-comp-'));
  const media = join(root, 'DRIVE', 'VFX', 'S1');
  await mkdir(media, { recursive: true });
  const scene = greenScreenScene({ width: W, height: H, frames: FRAMES, noise: 0.001 });
  const n = W * H;
  await pipeTo(buildExrWriteArgs({ layout: 'rgb', width: W, height: H, frameRate: 24, startNumber: 1001, output: join(media, 'S1_plate.%04d.exr') }), Array.from({ length: FRAMES }, (_, i) => buf(toPlanar('rgb', n, scene.render(i).data, null))));
  await pipeTo(buildExrWriteArgs({ layout: 'rgb', width: W, height: H, frameRate: 24, startNumber: 1, output: join(media, 'night_bg.%01d.exr') }), [buf(toPlanar('rgb', n, scene.background.data, null))]);
  const handoff = {
    project: 'Comp Test',
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
        tasks: [{ kind: 'key' }, { kind: 'composite' }],
        references: [{ kind: 'background_plate', path: 'VFX/S1/night_bg.1.exr' }],
        checksums: [],
      },
    ],
  };
  const handoffPath = join(root, 'DRIVE', 'handoff.json');
  await writeFile(handoffPath, JSON.stringify(handoff));
  const parsed = parseHandoff(JSON.stringify(handoff));
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  let project = createProject(parsed.handoff, handoffPath, 'Tester', NOW);
  const out = join(root, 'OUT');
  // The key's export in the shot package: the true premultiplied foreground and alpha of the synthetic shot.
  const keyDir = join(shotFolder(project, 'S1', out), '03_KEYS', 'S1_key_v001');
  await mkdir(keyDir, { recursive: true });
  await pipeTo(buildExrWriteArgs({ layout: 'rgba', width: W, height: H, frameRate: 24, startNumber: 1001, output: join(keyDir, 'S1_key_fg_v001.%04d.exr') }), Array.from({ length: FRAMES }, (_, i) => buf(toPlanar('rgba', n, scene.foreground(i), scene.alpha(i)))));
  for (let i = 0; i < FRAMES; i += 1) await writeFile(join(keyDir, `S1_key_alpha_v001.${1001 + i}.png`), encodePng({ width: W, height: H, bitDepth: 16, data: Uint16Array.from(scene.alpha(i), (v) => Math.round(v * 65535)) }));
  const key = KeyDocumentSchema.parse({
    exports: [{ version: 1, folder: '03_KEYS/S1_key_v001', alpha: 'S1_key_alpha_v001.%04d.png', foreground: 'S1_key_fg_v001.%04d.exr', first: 1001, last: 1000 + FRAMES, frames: FRAMES, width: W, height: H, encoding: 'ACEScg (linear AP1)', despill: true, confidence: { mean: 1, min: 1, low: [] }, algorithm: 'test', revision: 0, metadata: '03_KEYS/S1_key_v001/S1_key_v001.json', files: 2 * FRAMES, writtenAt: NOW.toISOString(), by: 'Ana' }],
  });
  project = { ...project, shots: project.shots.map((s) => ({ ...s, key })) };
  const env: CompEnv = { ffmpeg: 'ffmpeg', caps: FULL_CAPS, workerFile: await worker(), generator: 'VC VFX test' };
  await mkdir(out, { recursive: true });
  return { project, env, scene, out, media };
}

function readExr(file: string, alpha: boolean): Float32Array {
  const raw = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', alpha ? 'gbrapf32le' : 'gbrpf32le', '-']).stdout;
  return new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
}

describe.skipIf(!hasFfmpeg)('the compositor on real media', () => {
  it('session → preview (cached) → render (worker) → export for Nuke, versioned, never rewritten once approved', async () => {
    const { project, env, scene, out, media } = await drive();
    let p = ok(startComp(project, 'S1', 'suggested', 'Ana', NOW));
    const doc = () => compDoc(shotState(p, 'S1'))!;
    const id = (name: string) => doc().nodes.find((x) => x.name === name)!.id;
    expect(doc().nodes.map((x) => x.name)).toEqual(['Read_plate', 'Keyer1', 'Read_background', 'LightWrap1', 'Merge1', 'Write1']);

    const session = await compSession(p, 'S1', out, env);
    expect(session).toMatchObject({ available: true, frames: 'source', plate: { width: W, height: H }, first: 1001, last: 1000 + FRAMES, encoding: { linear: true }, exportable: true });
    expect(session.sources.map((s) => [s.source, s.ok])).toEqual([
      ['plate', true],
      ['key_foreground', true],
      ['background', true],
    ]);

    // Preview at half size: the comp (1) and the plate (2).
    const v1 = await compFrameView(p, { text: '', shotId: 'S1', projectKey: 'k', frame: 1003, a: id('Merge1'), b: id('Read_plate'), scale: 0.5 }, out, env);
    expect([v1.width, v1.height, v1.errors]).toEqual([W / 2, H / 2, { a: null, b: null }]);
    expect(v1.a!.rgb.length).toBe((W / 2) * (H / 2) * 3);
    expect(v1.computed).toBe(5);
    // A light-wrap change: only the light wrap and the merge are computed again.
    p = ok(setCompParams(p, 'S1', id('LightWrap1'), { intensity: 1.2 }, 'Ana', NOW));
    const v2 = await compFrameView(p, { text: '', shotId: 'S1', projectKey: 'k', frame: 1003, a: id('Merge1'), b: id('Read_plate'), scale: 0.5 }, out, env);
    expect(v2.computed).toBe(2);
    expect(v2.cached).toBeGreaterThanOrEqual(3);

    // An output root among the camera media is refused.
    await expect(compRender(p, { shotId: 'S1', projectKey: 'k', operator: 'Ana' }, media, env)).rejects.toThrow(/inside a source media folder/);
    // Export before a render: refused.
    await expect(compExport(p, { shotId: 'S1', projectKey: 'k', operator: 'Ana' }, out, env)).rejects.toThrow(/Render comp v001/);

    const t0 = performance.now();
    const rendered = await compRender(p, { shotId: 'S1', projectKey: 'k', operator: 'Ana' }, out, env);
    const renderMs = performance.now() - t0;
    expect(rendered.record).toMatchObject({ version: 1, revision: doc().revision, folder: '08_PREVIEWS/S1_comp_v001', pattern: 'S1_comp_v001.%04d.exr', review: 'S1_comp_review_v001.%04d.jpg', first: 1001, last: 1000 + FRAMES, frames: FRAMES, width: W, height: H, write: 'Write1' });
    // The plate is not upstream of the Write in the suggested graph (it is the viewer's 2): not read by the render.
    expect(rendered.record.references.map((r) => r.label)).toEqual(['Key v001 foreground', 'Background night_bg.1.exr']);
    const names = (await readdir(rendered.folder)).sort();
    expect(names.filter((x) => x.endsWith('.exr'))).toHaveLength(FRAMES);
    expect(names.filter((x) => x.endsWith('.jpg'))).toHaveLength(FRAMES);
    // The rendered EXR against the same graph evaluated here, and against over by hand where there is no wrap.
    const k = 2;
    const exr = readExr(join(rendered.folder, `S1_comp_v001.${1001 + k}.exr`), true);
    const N = W * H;
    const r2 = await (async () => {
      const io = createCompIO({ ffmpeg: 'ffmpeg', caps: FULL_CAPS, plate: { ffmpeg: 'ffmpeg', source: { kind: 'sequence', pattern: join(media, 'S1_plate.%04d.exr'), startNumber: 1001, frameRate: 24 }, firstArg: 1001, first: 1001, last: 1000 + FRAMES, frameRate: 24, hints: { yuv: false }, caps: FULL_CAPS, plate: { width: W, height: H }, encoding: 'acescg', label: 'source' }, space: { encoding: 'acescg', label: 'ACEScg', linear: true, luma: [0.27, 0.67, 0.06], toRec709: null }, sources: { 'key_foreground|': { file: join(shotFolder(p, 'S1', out), '03_KEYS', 'S1_key_v001', 'S1_key_fg_v001.%04d.exr'), still: false, kind: 'rgba', first: 1001, last: 1000 + FRAMES, format: 'exr', version: '1' }, 'background|': { file: join(media, 'night_bg.1.exr'), still: true, kind: 'rgb', first: null, last: null, format: 'exr', version: '1' } }, tracks: [] });
      return new CompEvaluator(io).evaluate(doc(), id('Write1'), 1001 + k, { scale: 1 });
    })();
    let maxDiff = 0;
    for (let i = 0; i < N; i += 1) {
      for (let c = 0; c < 3; c += 1) maxDiff = Math.max(maxDiff, Math.abs(exr[[2 * N, 0, N][c]! + i]! - r2.data[4 * i + c]!) / Math.max(0.05, Math.abs(r2.data[4 * i + c]!)));
      maxDiff = Math.max(maxDiff, Math.abs(exr[3 * N + i]! - r2.data[4 * i + 3]!));
    }
    expect(maxDiff).toBeLessThan(2e-3); // half-float
    const alpha = scene.alpha(k);
    const fg = scene.foreground(k);
    const bg = scene.background.data;
    let checked = 0;
    for (let i = 0; i < N; i += 1) {
      if (alpha[i]! > 0.001) continue;
      // Outside the subject (no wrap there): the background.
      expect(Math.abs(exr[2 * N + i]! - bg[3 * i]!)).toBeLessThan(2e-3 + 2e-3 * bg[3 * i]!);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(N / 3);
    let inside = 0;
    for (let i = 0; i < N; i += 1) {
      if (alpha[i]! < 0.999) continue;
      // Inside: the foreground plus the (non-negative) light wrap, opaque.
      expect(exr[2 * N + i]!).toBeGreaterThan(fg[3 * i]! - 2e-3 - 2e-3 * fg[3 * i]!);
      expect(exr[3 * N + i]!).toBeCloseTo(1, 2);
      inside += 1;
    }
    expect(inside).toBeGreaterThan(50);
    // The plates’ encoding came through: the EXR is RGBA half.
    expect(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=pix_fmt', '-of', 'csv=p=0', join(rendered.folder, `S1_comp_v001.1001.exr`)]).stdout.toString().trim()).toMatch(/^gbrapf/);

    p = ok(recordCompRender(p, 'S1', rendered.record, 'Ana', NOW));
    const exported = await compExport(p, { shotId: 'S1', projectKey: 'k', operator: 'Ana' }, out, env, { now: NOW });
    expect(exported.record).toMatchObject({ version: 1, folder: '09_PROJECT_DATA/S1_comp_v001', graph: 'S1_comp_v001.vcvfxcomp.json', nuke: 'S1_comp_v001.nk', manifest: 'S1_comp_v001_manifest.json', baked: [{ name: 'LightWrap1', pattern: 'baked/S1_comp_LightWrap1_v001.%04d.exr' }] });
    const files = (await readdir(exported.folder)).sort();
    expect(files).toEqual(['README.txt', 'S1_comp_v001.nk', 'S1_comp_v001.vcvfxcomp.json', 'S1_comp_v001_manifest.json', 'baked']);
    expect(await readdir(join(exported.folder, 'baked'))).toHaveLength(FRAMES);
    const nk = await readFile(join(exported.folder, 'S1_comp_v001.nk'), 'utf8');
    const topo = parseNukeTopology(nk);
    const node = (name: string) => topo.find((x) => x.name === name)!;
    expect(node('Merge1')).toMatchObject({ cls: 'Merge2', inputs: ['Read_background', 'LightWrap1'] });
    expect(node('LightWrap1').knobs['file']).toBe('"[file dirname [value root.name]]/baked/S1_comp_LightWrap1_v001.%04d.exr"');
    expect(node('Keyer1').knobs['file']).toBe('"[file dirname [value root.name]]/../../03_KEYS/S1_key_v001/S1_key_fg_v001.%04d.exr"');
    expect(node('Write1').knobs['colorspace']).toBe('"ACES - ACEScg"');
    // The baked light wrap equals the render's input to the merge: read it back.
    const bakedFrame = await readRgbaFile('ffmpeg', join(exported.folder, 'baked', `S1_comp_LightWrap1_v001.${1001 + k}.exr`), W, H);
    expect(bakedFrame.length).toBe(4 * N);
    const manifest = JSON.parse(await readFile(join(exported.folder, 'S1_comp_v001_manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({ format: 'vcvfx.comp-manifest/1', shot: 'S1', version: 'v001', frames: { first: 1001, last: 1000 + FRAMES }, colour: { ocioConfig: 'aces_1.2', ocioWorkingSpace: 'ACES - ACEScg' } });
    expect(manifest.nodes.find((x: { name: string }) => x.name === 'LightWrap1').nuke).toEqual({ class: 'Read', node: 'LightWrap1', translation: 'baked' });
    expect(manifest.nodes.find((x: { name: string }) => x.name === 'Keyer1').nuke.translation).toBe('module-output');
    const roles = manifest.assets.map((a: { role: string; files: unknown[] }) => `${a.role}:${a.files.length}`);
    expect(roles).toEqual([`source:${FRAMES}`, 'source:1', `baked:${FRAMES}`, `render:${FRAMES}`, `review:${FRAMES}`, 'graph:1', 'nuke:1']);
    expect(manifest.assets[0].files[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.untranslated.some((u: string) => u.startsWith('LightWrap1'))).toBe(true);
    const readme = await readFile(join(exported.folder, 'README.txt'), 'utf8');
    expect(readme).toContain('aces_1.2');
    expect(readme).toContain('not approved yet');

    p = ok(recordCompExport(p, 'S1', exported.record, 'Ana', NOW));
    p = ok(approveTask(p, 'S1', 'composite', 'M. Delgado', NOW));
    await expect(compRender(p, { shotId: 'S1', projectKey: 'k', operator: 'Ana' }, out, env)).rejects.toThrow(/approved comp v001; it is never rewritten/);
    await expect(compExport(p, { shotId: 'S1', projectKey: 'k', operator: 'Ana' }, out, env)).rejects.toThrow(/approved comp v001; it is never rewritten/);
    // eslint-disable-next-line no-console
    console.log(`comp render: ${FRAMES} frames ${W}×${H} in ${renderMs.toFixed(0)} ms (${((FRAMES * 1000) / renderMs).toFixed(1)} fps, worker start and ffmpeg included)`);
  });

  it('says which module export is missing', async () => {
    const { project, env, out } = await drive();
    let p = ok(addTask(project, 'S1', 'clean_plate', 'Ana', NOW));
    p = { ...p, shots: p.shots.map((s) => ({ ...s, key: null })) };
    p = ok(startComp(p, 'S1', 'suggested', 'Ana', NOW));
    const session = await compSession(p, 'S1', out, env);
    expect(session.sources.find((s) => s.source === 'key_foreground')).toMatchObject({ ok: false, reason: expect.stringContaining('Key tab › Export') });
    expect(session.sources.find((s) => s.source === 'cleanplate')).toMatchObject({ ok: false, reason: expect.stringContaining('Clean Plate tab › Export') });
    const doc = compDoc(shotState(p, 'S1'))!;
    const merge = doc.nodes.find((x) => x.name === 'Merge1')!.id;
    const view = await compFrameView(p, { text: '', shotId: 'S1', projectKey: 'k', frame: 1001, a: merge, b: doc.nodes[0]!.id, scale: 0.5 }, out, env);
    expect(view.errors.a).toMatch(/^(Keyer1|CleanPlate1): The (key|clean plate) has not been exported/);
    expect(view.b).not.toBeNull();
    await expect(compRender(p, { shotId: 'S1', projectKey: 'k', operator: 'Ana' }, out, env)).rejects.toThrow(/Fix the graph first: (Keyer1|CleanPlate1)/);
  });
});
