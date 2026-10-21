import { SAMPLE_HANDOFF, applyCamTrack, camNextId, createProject, focalPixels, parseHandoff, shotState, type Project, type Result } from '@vcvfx/domain';
import type { BetaMessage } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { TrackSessionInfo } from '../bridge';
import { dispatch, type CameraCommand, type CameraSession } from '../camera/commands';
import { decodeTracks, encodeTracks } from '../camera/codec';
import { grayOf } from '../camera/klt';
import { renderScene, roomScene } from '../camera/render';
import { MemoryStore, sessionBase, viewData } from '../camera/session';
import { TsCameraSolver } from '../camera/solver';
import { cameraPath } from '../camera/synthetic';
import { mergeTracks, type TrackData } from '../camera/tracks';
import type { ModelCallResult, ModelClient, TrackAgentRequest } from '../ai/protocol';
import { applyAiOps, type AiOp } from '../ai/ops';
import type { FrameImage, QuadProposal, TrackHost } from '../ai/tools';

/**
 * A rendered tracking shot and a `TrackHost` over it for the AI assistant's
 * tests: the real dispatcher, solver and domain, in memory. The sample
 * project's 020_010 (VENICE 2, 25 mm) at 480×270, 36 frames of a pan.
 */

export const SHOT = '020_010';
export const W = 480;
export const H = 270;
export const FIRST = 1001;
export const N = 36;
const intr = { f: focalPixels(25, 35.9, W), cx: (W - 1) / 2, cy: (H - 1) / 2, k1: 0, k2: 0, k3: 0, p1: 0, p2: 0 };
let frames: ReturnType<typeof grayOf>[] | null = null;
export const shotFrames = () => (frames ??= cameraPath('pan', N, 9).map((p) => grayOf(renderScene(roomScene(5), { width: W, height: H, intr, R: p.R, t: p.t }))));

export function makeProject(): Project {
  const h = parseHandoff(JSON.stringify(SAMPLE_HANDOFF));
  if (!h.ok) throw new Error('sample');
  return createProject(h.handoff, '/drive/handoff.json', 'Ana', new Date('2026-10-20T10:00:00Z'));
}

export const NOW = new Date('2026-10-21T12:00:00Z');

export interface TestHost extends TrackHost {
  current: Project;
  store: MemoryStore;
  commands: string[];
  proposals: QuadProposal[];
}

export function testHost(options: { project?: Project; frames?: boolean; confirm?: (p: QuadProposal) => { accepted: boolean; corners?: [number, number][]; note?: string }; actor?: string } = {}): TestHost {
  const store = new MemoryStore();
  const host: TestHost = {
    shotId: SHOT,
    current: options.project ?? makeProject(),
    store,
    commands: [],
    proposals: [],
    project: () => host.current,
    async apply(ops: readonly AiOp[]): Promise<Result> {
      const r = applyAiOps(host.current, SHOT, ops, options.actor ?? 'Ana (AI assistant)', NOW);
      if (r.ok) host.current = r.project;
      return r;
    },
    async session(): Promise<TrackSessionInfo> {
      return { available: true, reason: null, frames: 'test frames', plate: { width: W, height: H }, working: { width: W, height: H }, first: FIRST, last: FIRST + N - 1, fps: 24, exportable: false, lidarFromDisk: false };
    },
    async command(command: CameraCommand) {
      host.commands.push(command.verb);
      const session: CameraSession = {
        ...sessionBase(host.current, SHOT, { first: FIRST, last: FIRST + N - 1, fps: 24 }, { width: W, height: H }, { width: W, height: H }),
        io: { frame: async (f) => shotFrames()[Math.min(N - 1, Math.max(0, f - FIRST))]! },
        store,
        solver: new TsCameraSolver(),
        actor: 'Ana (AI assistant)',
        now: () => NOW,
        generator: 'VC VFX test',
      };
      return dispatch(session, command);
    },
    async view(o) {
      return viewData(shotState(host.current, SHOT)?.camtrack, store, Boolean(o?.clouds));
    },
    ...(options.frames ? { frameImage: async (_f: number, maxWidth: number): Promise<FrameImage> => ({ mediaType: 'image/jpeg', data: 'AAAA', width: Math.min(maxWidth, W), height: Math.round((Math.min(maxWidth, W) * H) / W) }) } : {}),
    ...(options.confirm
      ? {
          confirmQuad: async (p: QuadProposal) => {
            host.proposals.push(p);
            return options.confirm!(p);
          },
        }
      : {}),
  };
  return host;
}

/**
 * Add `count` bad tracks: copies of real tracks drifting away from the
 * feature (a slow slide plus jitter, as a track on a reflection or a
 * moving edge does), stored and referenced like a tracker's output.
 */
export async function injectBadTracks(host: TestHost, count: number, seed = 7, jitter = 1.6, drift = 0.8): Promise<number[]> {
  const doc = shotState(host.current, SHOT)!.camtrack!;
  const td = decodeTracks((await host.store.get(doc.trackSet!.file))!);
  let s = seed;
  const rand = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const picks: number[] = [];
  for (let i = 0; i < td.ids.length && picks.length < count; i += 1) if (td.length[i]! >= 20 && rand() < 0.5) picks.push(i);
  const ids: number[] = [];
  let next = td.nextId;
  const bad: TrackData = { width: td.width, height: td.height, first: td.first, last: td.last, ids: new Int32Array(picks.length), start: new Int32Array(picks.length), length: new Int32Array(picks.length), offset: new Int32Array(picks.length), xy: new Float32Array(0), nextId: 0, manual: new Uint8Array(picks.length) };
  const xy: number[] = [];
  picks.forEach((i, k) => {
    bad.ids[k] = next;
    ids.push(next);
    next += 1;
    bad.start[k] = td.start[i]!;
    bad.length[k] = td.length[i]!;
    bad.offset[k] = xy.length / 2;
    const dx = (rand() - 0.5) * 0.5;
    const dy = (rand() - 0.5) * 0.5;
    for (let j = 0; j < td.length[i]!; j += 1) {
      const o = (td.offset[i]! + j) * 2;
      xy.push(td.xy[o]! + dx * j * drift + (rand() - 0.5) * jitter, td.xy[o + 1]! + dy * j * drift + (rand() - 0.5) * jitter);
    }
  });
  bad.xy = new Float32Array(xy);
  bad.nextId = next;
  const merged = mergeTracks(td, bad);
  const id = camNextId(doc, 'tracks');
  await host.store.put(id.id, encodeTracks(merged));
  const r = applyCamTrack(host.current, SHOT, { command: 'test_inject', summary: `${ids.length} drifting tracks`, doc: { ...id.doc, trackSet: { ...doc.trackSet!, file: id.id, tracks: merged.ids.length } }, task: null }, 'test', NOW);
  if (!r.ok) throw new Error(r.reason);
  host.current = r.project;
  return ids;
}

/** A mock model: each call returns the next scripted turn (a function of the request, so it can read results). */
export function scriptedModel(turns: ((req: TrackAgentRequest, n: number) => Partial<BetaMessage> & { content: BetaMessage['content'] })[], credits = 1): ModelClient & { requests: TrackAgentRequest[] } {
  const requests: TrackAgentRequest[] = [];
  return {
    requests,
    async call(request, o): Promise<ModelCallResult> {
      requests.push(JSON.parse(JSON.stringify(request)) as TrackAgentRequest);
      if (o.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const n = requests.length - 1;
      const turn = turns[Math.min(n, turns.length - 1)]!(request, n);
      const message = { id: `msg_${n}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: turn.content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn', stop_sequence: null, stop_details: null, usage: { input_tokens: 100, output_tokens: 50 }, ...turn } as unknown as BetaMessage;
      return { message, usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: credits * 0.05, credits }, allowance: { used: 10, limit: 400, remaining: 390, resetsAt: '2026-11-01T00:00:00.000Z', model: 'claude-opus-5-5' } };
    },
  };
}

let toolN = 0;
export const use = (name: string, input: Record<string, unknown> = {}) => ({ type: 'tool_use' as const, id: `toolu_${(toolN += 1)}`, name, input, caller: { type: 'direct' as const } });
export const thinking = (text: string) => ({ type: 'thinking' as const, thinking: text, signature: `sig-${text.length}` });
export const say = (text: string) => ({ type: 'text' as const, text, citations: null });
