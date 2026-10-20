import { describe, expect, it } from 'vitest';
import { runRoto, type RotoRunIO } from '../roto/engine';
import { iou, type Mask } from '../roto/image';
import { discScene } from '../roto/synthetic';
import { TrackEngine } from '../roto/track';

const ioFor = (scene: ReturnType<typeof discScene>, masks: Map<number, Mask>, confidence = new Map<number, number>()): RotoRunIO => ({
  frame: async (f) => scene.render(f),
  getMask: async (f) => masks.get(f) ?? null,
  putMask: async (f, m, c) => {
    masks.set(f, m);
    confidence.set(f, c);
  },
});

describe('Track engine', () => {
  it('propagates a moving disc from one painted key frame with IoU ≥ 0.9 on every frame', async () => {
    const scene = discScene({ width: 320, height: 240, frames: 24 });
    const masks = new Map<number, Mask>();
    const conf = new Map<number, number>();
    // Paint a stroke across the disc on frame 0 and one on the background.
    const keyFrames = [
      {
        frame: 0,
        strokes: [
          { id: 's1', mode: 'include' as const, radius: 6, points: [[70, 108], [90, 110]] as [number, number][], by: 't', at: '' },
          { id: 's2', mode: 'exclude' as const, radius: 6, points: [[10, 20], [300, 30], [300, 220]] as [number, number][], by: 't', at: '' },
        ],
      },
    ];
    const t0 = Date.now();
    const results = await runRoto(new TrackEngine(), { partId: 'subject', from: 0, directions: ['key', 'forward'], first: 0, last: 23, keyFrames, scale: 1, smoothing: 0, settings: {} }, ioFor(scene, masks, conf));
    const ms = Date.now() - t0;
    const scores = Array.from({ length: 24 }, (_, f) => iou(masks.get(f)!, scene.truth(f)));
    console.log('IoU', scores.map((s) => s.toFixed(3)).join(' '), 'conf', [...conf.values()].map((c) => c.toFixed(2)).join(' '), `${ms} ms`);
    expect(results.map((r) => r.direction)).toEqual(['key', 'forward']);
    for (const s of scores) expect(s).toBeGreaterThanOrEqual(0.9);
  });
});
