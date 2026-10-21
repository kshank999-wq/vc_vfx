import { serializeProject, type Project, type Result } from '@vcvfx/domain';
import type { VcvfxApi } from '../shared/bridge';
import type { AiOp } from '../shared/ai/ops';
import { drawTrackOverlay } from '../shared/ai/overlay';
import type { FrameImage, QuadProposal, TrackHost } from '../shared/ai/tools';
import type { CommandOutcome, ProjectOp } from '../shared/camera/commands';

/**
 * A `TrackHost` over the bridge, for the browser preview's scripted demo
 * (addendum 07 §8): the same calls the Track workspace makes — commands run by
 * the page's dispatcher on the sample shot — and every change applied through
 * the App's `onTrack`, so it lands in the project and its log like the
 * artist's own. Nothing here talks to a model.
 */
export function bridgeHost(o: {
  api: VcvfxApi;
  shotId: string;
  projectKey: string;
  actor: string;
  /** The project now (the latest render's, or the latest applied). */
  project(): Project;
  /** Apply through the App (synchronously); the new project or the refusal. */
  apply(ops: readonly AiOp[]): Result;
  confirm?(p: QuadProposal): Promise<{ accepted: boolean; corners?: [number, number][]; note?: string }>;
  framesAllowed: boolean;
}): TrackHost {
  const { api, shotId, projectKey } = o;
  let job = 0;
  const text = () => serializeProject(o.project());
  const unwrap = <T>(r: { ok: true; data: T } | { ok: false; error: string }): T => {
    if (!r.ok) throw new Error(r.error);
    return r.data;
  };
  return {
    shotId,
    project: o.project,
    apply: async (ops) => o.apply(ops),
    session: async () => unwrap(await api.trackSession({ text: text(), shotId, projectKey })),
    async command(command): Promise<CommandOutcome> {
      job += 1;
      const r = await api.trackCommand({ jobId: `ai-demo-${job}`, text: text(), shotId, projectKey, operator: o.actor, command: command as unknown as { verb: string } & Record<string, unknown> });
      if (!r.ok) return { ok: false, error: r.error };
      return r.data.ok ? { ok: true, summary: r.data.summary, data: r.data.data, ops: r.data.ops as ProjectOp[] } : { ok: false, error: r.data.error };
    },
    view: async (v) => unwrap(await api.trackView({ text: text(), shotId, projectKey, ...(v?.clouds ? { clouds: true } : {}) })),
    roto: async (partId, from, directions) => {
      job += 1;
      return unwrap(await api.rotoRun({ jobId: `ai-demo-${job}`, text: text(), shotId, projectKey, partId, from, directions })).results;
    },
    ...(o.framesAllowed
      ? {
          frameImage: async (frame: number, maxWidth: number, overlay: 'none' | 'tracks' | 'errors'): Promise<FrameImage> => {
            const vf = unwrap(await api.trackFrame({ text: text(), shotId, projectKey, frame, maxWidth }));
            const bitmap = await createImageBitmap(await (await fetch(vf.url)).blob());
            const k = Math.min(1, maxWidth / bitmap.width);
            const canvas = document.createElement('canvas');
            canvas.width = Math.round(bitmap.width * k);
            canvas.height = Math.round(bitmap.height * k);
            const g = canvas.getContext('2d');
            if (!g) throw new Error('This browser cannot draw the frame.');
            g.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
            if (overlay !== 'none') {
              const session = unwrap(await api.trackSession({ text: text(), shotId, projectKey }));
              const view = unwrap(await api.trackView({ text: text(), shotId, projectKey }));
              const data = g.getImageData(0, 0, canvas.width, canvas.height);
              drawTrackOverlay(new Uint8Array(data.data.buffer), { width: canvas.width, height: canvas.height, order: 'rgba' }, view, frame, session.plate ?? { width: canvas.width, height: canvas.height }, overlay);
              g.putImageData(data, 0, 0);
            }
            const url = canvas.toDataURL('image/jpeg', 0.82);
            return { mediaType: 'image/jpeg', data: url.slice(url.indexOf(',') + 1), width: canvas.width, height: canvas.height };
          },
        }
      : {}),
    ...(o.confirm ? { confirmQuad: o.confirm } : {}),
  };
}
