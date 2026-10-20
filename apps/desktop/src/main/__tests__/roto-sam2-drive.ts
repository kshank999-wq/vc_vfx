import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProject, parseHandoff } from '@vcvfx/domain';
import { FULL_CAPS } from '../../shared/ffmpeg-args';
import { discScene } from '../../shared/roto/synthetic';
import { FrameCache } from '../frame-cache';
import type { RotoEnv } from '../roto/api';
import { encodeScene, workerBundle } from './roto-helpers';

/** A one-shot drive with a ProRes disc clip, and a roto environment that can find onnxruntime-node. */
export async function discDriveForSam2(ort: string[]) {
  const root = await mkdtemp(join(tmpdir(), 'vcvfx-sam2-'));
  const drive = join(root, 'DRIVE');
  await mkdir(join(drive, 'VFX/R1'), { recursive: true });
  const scene = discScene({ frames: 8 });
  await encodeScene('ffmpeg', scene, join(drive, 'VFX/R1/disc.mov'));
  const handoff = { project: 'Roto Test', output: { format: 'png', bitDepth: 16, startFrame: 1001 }, shots: [{ shotId: 'R1', scene: '1', sourcePath: 'VFX/R1/disc.mov', frameIn: 0, frameOut: 7, handles: 0, frameRate: 24, resolution: { width: 320, height: 240 }, color: { sourceColorSpace: 'Rec.709' }, tasks: [{ kind: 'roto' }], checksums: [] }] };
  await writeFile(join(drive, 'handoff.json'), JSON.stringify(handoff));
  const parsed = parseHandoff(JSON.stringify(handoff));
  if (!parsed.ok) throw new Error('handoff');
  const userData = join(root, 'userData');
  const env: RotoEnv = { ffmpeg: 'ffmpeg', caps: FULL_CAPS, cacheRoot: join(userData, 'Roto Cache'), frameCache: new FrameCache({ dir: join(userData, 'Frame Cache') }), userData, packaged: false, ort, workerFile: await workerBundle(), generator: 'test' };
  return { project: createProject(parsed.handoff, join(drive, 'handoff.json'), 'Tester', new Date()), env, scene };
}
