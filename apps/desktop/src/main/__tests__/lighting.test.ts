import { describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  KeyDocumentSchema,
  addLightingReference,
  approveTask,
  createProject,
  lightingDoc,
  lightingRig,
  parseHandoff,
  recordLightingAiReview,
  recordLightingAnalysis,
  recordLightingExport,
  serializeProject,
  setLightFields,
  shotState,
  updateLightingReference,
  type Project,
  type Result,
} from '@vcvfx/domain';
import { FULL_CAPS } from '../../shared/ffmpeg-args';
import { buildExrWriteArgs, toPlanar } from '../../shared/key/ffmpeg-key';
import { inAzRange, inRange } from '../../shared/lighting/geometry';
import { STUDIO_SCENE, renderEquirect, renderScene } from '../../shared/lighting/synthetic';
import type { ModelClient } from '../../shared/ai/protocol';
import { lightingAiReview, lightingAnalyse, lightingExport, lightingFrameView, lightingIngest, lightingSession, type LightingEnv } from '../lighting/api';
import { shotFolder } from '../package-shot';
import { encodePng } from '../roto/png';

/**
 * The lighting analysis on real media (addendum 14 §4–5): the synthetic
 * studio shot written as a linear ACEScg EXR sequence on a "drive", the key's
 * alpha export in the shot package (the subject matte), an equirectangular
 * HDRI the handoff names. Then the session, ingest (read only, checksummed),
 * the analysis in the worker, the relight preview, the export (Unreal script
 * compiled by Python when there is one, USD, the rig file, Blender, report,
 * README) — versioned, never rewritten once approved, never under the source
 * paths — and the AI review with a stubbed model.
 */

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const hasPython = spawnSync('python3', ['--version']).status === 0;
const NOW = new Date('2026-10-22T12:00:00Z');
const ok = (r: Result): Project => {
  if (!r.ok) throw new Error(r.reason);
  return r.project;
};

let built: Promise<string> | null = null;
function worker(): Promise<string> {
  built ??= (async () => {
    const { build } = await import('vite');
    const out = await mkdtemp(join(tmpdir(), 'vcvfx-lighting-worker-'));
    await build({ configFile: false, logLevel: 'silent', ssr: { noExternal: true }, build: { ssr: resolve(__dirname, '../lighting/worker.ts'), outDir: out, emptyOutDir: true, minify: false, rollupOptions: { output: { format: 'cjs', entryFileNames: 'lighting-worker.js' } } } });
    return join(out, 'lighting-worker.js');
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

const W = 320;
const H = 180;
const SCENE = { ...STUDIO_SCENE, width: W, height: H, samples: 14 };

async function drive() {
  const root = await mkdtemp(join(tmpdir(), 'vcvfx-lighting-'));
  const media = join(root, 'DRIVE', 'VFX', 'S1');
  await mkdir(media, { recursive: true });
  const shot = renderScene(SCENE);
  const n = W * H;
  await pipeTo(buildExrWriteArgs({ layout: 'rgb', width: W, height: H, frameRate: 24, startNumber: 1001, output: join(media, 'S1_plate.%04d.exr') }), [buf(toPlanar('rgb', n, shot.image.data, null)), buf(toPlanar('rgb', n, shot.image.data, null))]);
  const hdri = renderEquirect(SCENE, 256, 20);
  await pipeTo(buildExrWriteArgs({ layout: 'rgb', width: 256, height: 128, frameRate: 24, startNumber: 1, output: join(media, 'set_hdri.%01d.exr') }), [buf(toPlanar('rgb', 256 * 128, hdri.data, null))]);
  const handoff = {
    project: 'Lighting Test',
    output: { format: 'exr', bitDepth: 16, startFrame: 1001 },
    shots: [
      {
        shotId: 'S1',
        scene: '1',
        sourcePath: 'VFX/S1/S1_plate.1001.exr',
        frameIn: 0,
        frameOut: 1,
        handles: 0,
        frameRate: 24,
        resolution: { width: W, height: H },
        camera: { body: 'Test cam', filmBackMm: { width: 36, height: 20.25 }, lens: 'Test 35', focalLengthMm: 35, iris: 'T2.8', whiteBalance: 5600 },
        color: { sourceColorSpace: 'ACEScg' },
        tasks: [{ kind: 'key' }, { kind: 'lighting_analysis' }],
        // The same 360 named as the HDRI and as the panorama is offered once.
        references: [{ kind: 'hdri', path: 'VFX/S1/set_hdri.1.exr' }, { kind: 'panorama', path: 'VFX/S1/set_hdri.1.exr' }],
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
  // The key's export: the subject's true matte, 16-bit PNGs.
  const keyDir = join(shotFolder(project, 'S1', out), '03_KEYS', 'S1_key_v001');
  await mkdir(keyDir, { recursive: true });
  for (let i = 0; i < 2; i += 1) await writeFile(join(keyDir, `S1_key_alpha_v001.${1001 + i}.png`), encodePng({ width: W, height: H, bitDepth: 16, data: Uint16Array.from(shot.matte, (v) => Math.round(v * 65535)) }));
  const key = KeyDocumentSchema.parse({
    exports: [{ version: 1, folder: '03_KEYS/S1_key_v001', alpha: 'S1_key_alpha_v001.%04d.png', foreground: null, first: 1001, last: 1002, frames: 2, width: W, height: H, encoding: 'ACEScg (linear AP1)', despill: false, confidence: { mean: 1, min: 1, low: [] }, algorithm: 'test', revision: 0, metadata: '03_KEYS/S1_key_v001/S1_key_v001.json', files: 2, writtenAt: NOW.toISOString(), by: 'Ana' }],
  });
  project = { ...project, shots: project.shots.map((s) => ({ ...s, key })) };
  const env: LightingEnv = { ffmpeg: 'ffmpeg', caps: FULL_CAPS, workerFile: await worker(), generator: 'VC VFX test', trackCacheRoot: join(root, 'Track Cache'), ai: null };
  return { root, out, project, env, media, shot };
}

describe.skipIf(!hasFfmpeg)('the lighting analysis on real media', () => {
  it('session, read-only ingest, the analysis in the worker, the relight preview, the export, approval and the AI review', { timeout: 180_000 }, async () => {
    const d = await drive();
    let project = d.project;
    // The session: the key's matte is the subject, the handoff's HDRI is offered, the lens comes from the metadata.
    const session = await lightingSession(project, 'S1', 'k', d.out, d.env);
    expect(session).toMatchObject({ available: true, exportable: true, plate: { width: W, height: H }, subject: { source: 'key_alpha' }, camera: { focal: '35 mm (metadata)', whiteBalance: '5600 K (metadata)', iris: 'T2.8' } });
    expect(session.handoff).toEqual([{ kind: 'hdri', path: 'VFX/S1/set_hdri.1.exr', name: 'set_hdri.1.exr', from: 'handoff', onDisk: true }]);
    expect(session.ai.available).toBe(false);

    // Ingest the HDRI (checksummed, measured, never written) and record it with its heading.
    const refs = await lightingIngest(project, 'S1', 'hdri', [{ path: 'VFX/S1/set_hdri.1.exr', from: 'handoff' }], null, d.env);
    expect(refs[0]).toMatchObject({ kind: 'hdri', from: 'handoff', width: 256, height: 128, encoding: 'linear_rec709', checksum: { algorithm: 'sha256' } });
    const before = await readFile(join(d.media, 'set_hdri.1.exr'));
    project = ok(addLightingReference(project, 'S1', { ...refs[0]!, encoding: 'acescg' }, 'Ana', NOW));
    const hdriId = lightingDoc(shotState(project, 'S1'))!.references[0]!.id;
    project = ok(updateLightingReference(project, 'S1', hdriId, { headingDeg: 20 }, 'Ana', NOW));

    // Output roots among the media are refused before anything is analysed or written.
    await expect(lightingExport(project, { shotId: 'S1', projectKey: 'k', operator: 'Ana', formats: ['unreal'], text: serializeProject(project) }, d.media, d.env)).rejects.toThrow(/source media/);

    // The analysis, in the worker.
    const t0 = Date.now();
    const analysis = await lightingAnalyse(project, { shotId: 'S1', projectKey: 'k' }, d.out, d.env);
    const seconds = (Date.now() - t0) / 1000;
    expect(seconds).toBeLessThan(120);
    project = ok(recordLightingAnalysis(project, 'S1', analysis, 'Ana', NOW));
    const key = analysis.lights.find((l) => l.id === 'key')!;
    expect(key.evidence).toContain('hdri');
    expect(inAzRange(key.azimuth, 48)).toBe(true);
    expect(inRange(key.elevation, 32)).toBe(true);
    expect(Math.abs(key.azimuth.value - 48)).toBeLessThan(6);
    expect(Math.abs(key.elevation.value - 32)).toBeLessThan(6);
    expect(analysis.subject.source).toBe('key_alpha');
    expect(analysis.lens).toMatchObject({ focalSource: 'metadata', aperture: { source: 'metadata' }, filmBackMm: { width: 36 } });
    expect(analysis.whiteBalance).toEqual({ kelvin: 5600, source: 'metadata' });
    expect(key.temperature!.low).toBeLessThanOrEqual(4300);
    expect(key.temperature!.high).toBeGreaterThanOrEqual(4300);
    expect((await readFile(join(d.media, 'set_hdri.1.exr'))).equals(before)).toBe(true);

    // The relight preview: the estimate reproduces the plate on the subject; moving the key changes it.
    const rig = lightingRig(lightingDoc(shotState(project, 'S1'))).map((l) => l.spec);
    const view = await lightingFrameView(project, { shotId: 'S1', projectKey: 'k', request: { frame: 1001, maxWidth: 640, rig } }, d.out, d.env);
    expect(view).toMatchObject({ width: W, height: H, built: 'current' });
    expect(view.relit).not.toBeNull();
    expect(view.match!).toBeGreaterThan(0.8);
    const moved = rig.map((s) => (s.role === 'key' ? { ...s, azimuthDeg: -60 } : s));
    const view2 = await lightingFrameView(project, { shotId: 'S1', projectKey: 'k', request: { frame: 1001, maxWidth: 640, rig: moved } }, d.out, d.env);
    expect(view2.match!).toBeLessThan(view.match! - 0.2);

    // An artist's edit, then the export.
    project = ok(setLightFields(project, 'S1', 'key', { intensityStops: 0.5 }, 'Ana', NOW));
    const outcome = await lightingExport(project, { shotId: 'S1', projectKey: 'k', operator: 'Ana', formats: ['unreal', 'usd', 'blender', 'report'], text: serializeProject(project) }, d.out, d.env, { now: NOW });
    expect(outcome.record).toMatchObject({ version: 1, folder: '09_PROJECT_DATA/S1_light_v001', formats: ['json', 'unreal', 'usd', 'blender', 'report'], camera: 'estimate' });
    const folder = outcome.folder;
    const files = (await readdir(folder)).sort();
    expect(files).toEqual(['README.txt', 'S1_light_v001.usda', 'S1_light_v001_blender.py', 'S1_light_v001_frame.png', 'S1_light_v001_report.html', 'S1_light_v001_rig.json', 'S1_light_v001_unreal.py']);
    const rigFile = JSON.parse(await readFile(join(folder, 'S1_light_v001_rig.json'), 'utf8'));
    expect(rigFile.format).toBe('vcvfx.lighting/1');
    const keyLight = rigFile.lights.find((l: { id: string }) => l.id === 'key');
    expect(keyLight).toMatchObject({ intensityStops: 0.5, locked: ['intensityStops'] });
    expect(keyLight.intensity.lux).toBeCloseTo(1000 * 2 ** 0.5, 6);
    expect(rigFile.unreal.lights.length).toBe(rigFile.lights.length);
    expect(rigFile.unreal.camera.focal_mm).toBe(35);
    expect(rigFile.hdri).toMatch(/^(\.\.\/)+DRIVE\/VFX\/S1\/set_hdri\.1\.exr$/);
    const usd = await readFile(join(folder, 'S1_light_v001.usda'), 'utf8');
    expect(usd.startsWith('#usda 1.0')).toBe(true);
    expect(usd).toMatch(/def (RectLight|SphereLight|DistantLight) "key"/);
    expect(usd).toContain('def DomeLight');
    expect(usd).toContain('def Camera "camera"');
    if (hasPython) {
      for (const f of ['S1_light_v001_unreal.py', 'S1_light_v001_blender.py']) {
        const r = spawnSync('python3', ['-c', 'import sys, py_compile; py_compile.compile(sys.argv[1], doraise=True)', join(folder, f)]);
        expect(r.status, r.stderr.toString()).toBe(0);
      }
    }
    const report = await readFile(join(folder, 'S1_light_v001_report.html'), 'utf8');
    expect(report).toContain('data:image/png;base64,');
    expect(report).toContain('Lens and camera');
    project = ok(recordLightingExport(project, 'S1', outcome.record, 'Ana', NOW));
    project = ok(approveTask(project, 'S1', 'lighting_analysis', 'M. Delgado', NOW));
    await expect(lightingExport(project, { shotId: 'S1', projectKey: 'k', operator: 'Ana', formats: ['unreal'], text: serializeProject(project) }, d.out, d.env)).rejects.toThrow(/never rewritten/);

    // The AI review: refused without consent; with it, the stubbed model's suggestions come back for the artist.
    const calls: unknown[] = [];
    const model: ModelClient = {
      async call(request) {
        calls.push(request);
        return {
          message: { id: 'm', type: 'message', role: 'assistant', model: 'stub-model', content: [{ type: 'tool_use', id: 't', name: 'suggest_light_changes', input: { summary: 'A warm practical motivates the key.', suggestions: [{ kind: 'adjust', light_id: 'key', reason: 'Warmer', confidence: 0.6, changes: { azimuth_deg: null, elevation_deg: null, distance_m: null, intensity_stops: null, size_deg: null, temperature_k: 3800, role: null, type: null }, new_light: null }] } }], stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } as never,
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01, credits: 2 },
          allowance: null,
        };
      },
    };
    let allowed = false;
    const aiEnv: LightingEnv = { ...d.env, ai: { model, framesAllowed: async () => allowed, signedIn: async () => true, jpeg: () => 'AAAA' } };
    await expect(lightingAiReview(project, { shotId: 'S1', projectKey: 'k', jobId: 'j' }, d.out, aiEnv)).rejects.toThrow(/Allow AI to see frames/);
    expect(calls).toHaveLength(0);
    allowed = true;
    const review = await lightingAiReview(project, { shotId: 'S1', projectKey: 'k', jobId: 'j' }, d.out, aiEnv);
    expect(review).toMatchObject({ model: 'stub-model', promptVersion: 'lighting-review/1', credits: 2, suggestions: [{ kind: 'adjust', lightId: 'key', change: { temperatureK: 3800 } }] });
    const sent = calls[0] as { tools: { name: string }[]; messages: { content: { type: string }[] }[] };
    expect(sent.tools.map((t) => t.name)).toEqual(['suggest_light_changes']);
    expect(sent.messages[0]!.content.map((c) => c.type)).toEqual(['image', 'text']);
    // Recording it is refused on the approved rig (reopen first): the review is a change to the rig's record.
    expect(recordLightingAiReview(project, 'S1', review, 'Ana', NOW).ok).toBe(false);
    console.log(`lighting worker analysis ${W}×${H} with an HDRI: ${seconds.toFixed(2)} s; key ${key.azimuth.value}°/${key.elevation.value}°`);
  });
});
