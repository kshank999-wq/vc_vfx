import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { addStroke, setPartSettings, shotState, type Project, type Result } from '@vcvfx/domain';
import { runRoto } from '../../shared/roto/engine';
import { iou, type Mask } from '../../shared/roto/image';
import { Sam2Engine } from '../../shared/roto/sam2';
import { discScene } from '../../shared/roto/synthetic';
import { rotoRun, rotoSession } from '../roto/api';
import { modelDir, SAM2_MODEL } from '../roto/models';
import { loadOrt, ortCandidates, OrtSam2Runtime } from '../roto/sam2-ort';
import { MaskStore } from '../roto/store';

/**
 * The SAM 2 engine through the real onnxruntime-node, with stand-in models
 * that have samexporter's tensor names and shapes (fixtures/sam2-standin,
 * made by scripts/make-sam2-test-models.py; NOT SAM 2). Proves loading,
 * feeding and reading the sessions, in-process and in the worker thread.
 * Skipped when onnxruntime-node has not been fetched
 * (node scripts/fetch-onnxruntime.mjs).
 */

const candidates = ortCandidates({ resourcesPath: '', appPath: resolve(__dirname, '../../..'), packaged: false });
const ort = loadOrt(candidates);
const fixtures = resolve(__dirname, 'fixtures/sam2-standin');
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const ok = (r: Result): Project => {
  if (!r.ok) throw new Error(r.reason);
  return r.project;
};

describe.skipIf(!ort.ok)('SAM 2 through onnxruntime-node (stand-in models)', () => {
  it('runs the encoder and decoder with samexporter’s tensors and segments by prompt', async () => {
    if (!ort.ok) return;
    const runtime = await OrtSam2Runtime.create(ort.ort, join(fixtures, 'standin.encoder.onnx'), join(fixtures, 'standin.decoder.onnx'));
    const scene = discScene({ frames: 6 });
    const masks = new Map<number, Mask>();
    const conf = new Map<number, number>();
    await runRoto(
      new Sam2Engine(runtime),
      { partId: 'subject', from: 0, directions: ['key', 'forward'], first: 0, last: 5, keyFrames: [{ frame: 0, strokes: [{ id: 's', mode: 'include', radius: 5, points: [[75, 108], [85, 108]], by: '', at: '' }] }], scale: 1, smoothing: 0, settings: {} },
      { frame: async (f) => scene.render(f), getMask: async (f) => masks.get(f) ?? null, putMask: async (f, m, c) => void (masks.set(f, m), conf.set(f, c)) },
    );
    for (let f = 0; f < 6; f += 1) expect(iou(masks.get(f)!, scene.truth(f))).toBeGreaterThan(0.85);
    expect(conf.get(0)).toBeCloseTo(0.9, 5);
    runtime.dispose();
  });

  it.skipIf(!hasFfmpeg)('runs in the roto worker thread when the model files are present', async () => {
    const { discDriveForSam2 } = await import('./roto-sam2-drive');
    const { project, env } = await discDriveForSam2(candidates);
    const dir = modelDir(env.userData, SAM2_MODEL);
    await mkdir(dir, { recursive: true });
    await copyFile(join(fixtures, 'standin.encoder.onnx'), join(dir, SAM2_MODEL.files[0]!.name));
    await copyFile(join(fixtures, 'standin.decoder.onnx'), join(dir, SAM2_MODEL.files[1]!.name));
    const session = await rotoSession(project, 'R1', null, env);
    expect(session.engines.find((e) => e.id === 'sam2')).toMatchObject({ available: true, model: { present: true, pinned: false } });
    let p = ok(addStroke(project, 'R1', 'subject', 1001, { mode: 'include', radius: 5, points: [[75, 108], [85, 108]] }, 'Ana', new Date()));
    p = ok(setPartSettings(p, 'R1', 'subject', { engine: { id: 'sam2' } }, 'Ana', new Date()));
    expect(shotState(p, 'R1')!.roto!.parts[0]!.engine.id).toBe('sam2');
    const results = await rotoRun(p, { shotId: 'R1', projectKey: 'k', partId: 'subject', from: 1001, directions: ['key', 'forward'] }, null, env);
    expect(results.map((r) => [r.direction, r.engine.id, r.frames.length])).toEqual([
      ['key', 'sam2', 1],
      ['forward', 'sam2', 7],
    ]);
    const m = await new MaskStore(env.cacheRoot, 'k', 'R1').get('subject', 1, 1004);
    expect(m).not.toBeNull();
  });
});
