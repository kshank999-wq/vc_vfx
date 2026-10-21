import type { SegmentationEngine } from '../../shared/roto/engine';
import { Sam2Engine } from '../../shared/roto/sam2';
import { TrackEngine } from '../../shared/roto/track';
import { loadOrt, OrtSam2Runtime } from './sam2-ort';

/**
 * The segmentation engines a worker can run (addendum 04): Track always;
 * SAM 2.1 when its model files and onnxruntime are there. Shared by the roto
 * worker and the sky/background isolation worker (addendum 11), so both
 * choose and load engines the same way.
 */

export interface Sam2Files {
  ort: string[];
  encoder: string;
  decoder: string;
  threads?: number;
}

export async function segmentationEngine(id: 'track' | 'sam2', sam2?: Sam2Files): Promise<SegmentationEngine> {
  if (id === 'track') return new TrackEngine();
  if (!sam2) throw new Error('SAM 2 needs its model files');
  const loaded = loadOrt(sam2.ort);
  if (!loaded.ok) throw new Error(`${loaded.reason} (${loaded.detail})`);
  return new Sam2Engine(await OrtSam2Runtime.create(loaded.ort, sam2.encoder, sam2.decoder, sam2.threads));
}
