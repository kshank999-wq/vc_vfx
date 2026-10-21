import { randomUUID } from 'node:crypto';
import { parseProject, serializeProject, shotState, type Project, type Result } from '@vcvfx/domain';
import type { AiAck, AiRunEvent, AiRunRequest, AiRunResult, TrackViewData } from '../../shared/bridge';
import { runTrackAgent, type Conversation } from '../../shared/ai/agent';
import type { AiOp } from '../../shared/ai/ops';
import { drawTrackOverlay } from '../../shared/ai/overlay';
import type { ModelClient } from '../../shared/ai/protocol';
import type { FrameImage, QuadProposal, TrackHost } from '../../shared/ai/tools';
import { COMMAND_SPECS, type CameraCommand, type CommandOutcome } from '../../shared/camera/commands';
import type { RotoDirection, RotoPropagationResult } from '@vcvfx/domain';
import type { TrackSessionInfo, ViewerFrame } from '../../shared/bridge';

/**
 * The AI tracking assistant in the main process (addendum 07 §2). The loop
 * runs here, next to the camera worker; the project stays the renderer's.
 * Each change the assistant makes is sent to the renderer as ops (`apply`),
 * which applies them through the domain — checked and logged exactly as the
 * artist's own commands are — and answers with the project afterwards
 * (`AiAck`), so every command runs on the project as it really stands,
 * including anything the artist did meanwhile.
 *
 * No Electron here: the camera, roto and frame functions, the model client and
 * the event channel are passed in (ipc.ts wires the real ones).
 */

export interface AiServiceDeps {
  model: ModelClient;
  /** Mutating camera verbs need a full licence; checked before every command. */
  canEdit(): Promise<boolean>;
  readOnlyReason: string;
  session(project: Project, req: AiRunRequest): Promise<TrackSessionInfo>;
  command(project: Project, req: AiRunRequest, command: CameraCommand, o: { signal?: AbortSignal; onProgress?: (label: string, done: number, total: number) => void }): Promise<CommandOutcome>;
  view(project: Project, req: AiRunRequest, clouds: boolean): Promise<TrackViewData>;
  roto?(project: Project, req: AiRunRequest, partId: string, from: number, directions: RotoDirection[], signal?: AbortSignal): Promise<RotoPropagationResult[]>;
  /** A frame for the model; `image` decodes, overlays and re-encodes it (nativeImage in ipc.ts). */
  frame?(project: Project, req: AiRunRequest, frame: number, maxWidth: number): Promise<ViewerFrame>;
  image?(frame: ViewerFrame, maxWidth: number, draw: ((pixels: Uint8Array, size: { width: number; height: number }) => void) | null): Promise<FrameImage>;
  send(event: AiRunEvent): void;
  /** How long to wait for the renderer to apply ops. */
  ackTimeoutMs?: number;
}

interface Running {
  controller: AbortController;
  waiting: Map<number, (ack: AiAck) => void>;
}

const running = new Map<string, Running>();
const conversations = new Map<string, Conversation>();
const KEEP_CONVERSATIONS = 8;

export function ackAiRun(ack: AiAck): void {
  running.get(ack.runId)?.waiting.get(ack.seq)?.(ack);
}

export function cancelAiRun(runId: string): void {
  running.get(runId)?.controller.abort();
}

export async function runAiTrack(text: string, req: AiRunRequest, deps: AiServiceDeps): Promise<AiRunResult> {
  const parsed = parseProject(text);
  if (!parsed.ok) throw new Error(`The project could not be read: ${parsed.reason}`);
  if (!shotState(parsed.project, req.shotId)) throw new Error(`No shot ${req.shotId}`);
  if (running.has(req.runId)) throw new Error('That run is already going.');
  const controller = new AbortController();
  const state: Running = { controller, waiting: new Map() };
  running.set(req.runId, state);
  let project = parsed.project;
  let seq = 0;
  const send = (e: AiRunEvent) => deps.send(e);

  const ask = (event: (seq: number) => AiRunEvent, timeoutMs: number | null): Promise<AiAck> => {
    seq += 1;
    const mine = seq;
    return new Promise<AiAck>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = (ack: AiAck) => {
        if (timer) clearTimeout(timer);
        state.waiting.delete(mine);
        controller.signal.removeEventListener('abort', onAbort);
        resolve(ack);
      };
      const onAbort = () => finish({ runId: req.runId, seq: mine, ok: false, error: 'Cancelled' });
      state.waiting.set(mine, finish);
      controller.signal.addEventListener('abort', onAbort, { once: true });
      if (timeoutMs) timer = setTimeout(() => finish({ runId: req.runId, seq: mine, ok: false, error: 'The window did not apply the change in time.' }), timeoutMs);
      send(event(mine));
    });
  };

  const host: TrackHost = {
    shotId: req.shotId,
    project: () => project,
    async apply(ops: readonly AiOp[]): Promise<Result> {
      const ack = await ask((s) => ({ runId: req.runId, type: 'apply', seq: s, ops: [...ops] }), deps.ackTimeoutMs ?? 30_000);
      if (!ack.ok || !ack.text) return { ok: false, reason: ack.error ?? 'The change was not applied.' };
      const next = parseProject(ack.text);
      if (!next.ok) return { ok: false, reason: next.reason };
      project = next.project;
      return { ok: true, project };
    },
    session: () => deps.session(project, req),
    async command(command, signal) {
      if (COMMAND_SPECS[command.verb].mutates && !(await deps.canEdit())) return { ok: false, error: deps.readOnlyReason };
      return deps.command(project, req, command, { ...(signal ? { signal } : {}), onProgress: (label, done, total) => send({ runId: req.runId, type: 'progress', label, done, total }) });
    },
    view: (o) => deps.view(project, req, Boolean(o?.clouds)),
    ...(deps.roto ? { roto: (partId: string, from: number, directions: RotoDirection[], signal?: AbortSignal) => deps.roto!(project, req, partId, from, directions, signal) } : {}),
    ...(req.framesAllowed && deps.frame && deps.image
      ? {
          frameImage: async (frame: number, maxWidth: number, overlay: 'none' | 'tracks' | 'errors'): Promise<FrameImage> => {
            const vf = await deps.frame!(project, req, frame, maxWidth);
            if (overlay === 'none') return deps.image!(vf, maxWidth, null);
            const [view, session] = await Promise.all([deps.view(project, req, false), deps.session(project, req)]);
            const plate = session.plate ?? { width: 1, height: 1 };
            return deps.image!(vf, maxWidth, (pixels, size) => drawTrackOverlay(pixels, { ...size, order: 'bgra' }, view, frame, plate, overlay));
          },
        }
      : {}),
    async confirmQuad(proposal: QuadProposal) {
      const ack = await ask((s) => ({ runId: req.runId, type: 'confirm', seq: s, proposal }), null);
      return { accepted: ack.ok && Boolean(ack.accepted), ...(ack.corners ? { corners: ack.corners } : {}), ...(ack.note ? { note: ack.note } : {}) };
    },
  };

  try {
    const conversation = req.conversationId ? (conversations.get(req.conversationId) ?? null) : null;
    if (req.conversationId && !conversation) throw new Error('That conversation is no longer held. Start a new session.');
    const outcome = await runTrackAgent({
      model: deps.model,
      host,
      instruction: req.instruction,
      ...(req.notes ? { notes: req.notes } : {}),
      framesAllowed: req.framesAllowed,
      exportAllowed: req.exportAllowed,
      focalRange: req.focalRange ?? null,
      limits: { creditCap: req.creditCap, maxTurns: req.maxTurns },
      signal: controller.signal,
      onEvent: (e) => {
        if (e.type !== 'done') send({ runId: req.runId, ...e } as AiRunEvent);
      },
      conversation,
      sessionId: req.conversationId ?? req.runId,
      shotRef: shotState(project, req.shotId)?.vfxShotId ?? req.shotId,
    });
    const conversationId = req.conversationId ?? randomUUID();
    conversations.delete(conversationId);
    conversations.set(conversationId, outcome.conversation);
    while (conversations.size > KEEP_CONVERSATIONS) conversations.delete(conversations.keys().next().value!);
    return { reason: outcome.reason, message: outcome.message, report: outcome.report, text: outcome.text, credits: outcome.credits, turns: outcome.turns, created2d: outcome.created2d, conversationId };
  } finally {
    running.delete(req.runId);
  }
}

export { serializeProject };
