import type { BetaContentBlock, BetaContentBlockParam, BetaMessageParam, BetaToolResultBlockParam, BetaToolUseBlock } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { AiAllowance } from '@vcvfx/domain';
import { ModelCallError, type ModelClient, type StreamFragment, type TrackAgentUsage } from './protocol';
import { TRACK_AGENT_SYSTEM, rmsTarget } from './prompt';
import { agentTools, executeTool, type CommandEntry, type FinishReport, type ToolContext, type TrackHost } from './tools';

/**
 * The AI tracking assistant's loop (addendum 07 §2): a manual tool-use loop —
 * the transport is vc-vfx.com, not the SDK — over the camera command layer.
 *
 *   inspect → act → re-solve → verify, until the model calls `finish`.
 *
 * - The history is append-only: every assistant turn goes back exactly as it
 *   came (thinking blocks included), so the prompt cache holds and the
 *   thinking stays valid. Per-run facts live in the first user message.
 * - All of a turn's tool results return together in one user message; tools
 *   run one after another (they change the same shot), and a failure is an
 *   `is_error` result the model can read and recover from.
 * - Stops: `finish`, a turn with no tool call, the turn and credit budgets,
 *   Stop (the signal), a refusal, a turn cut off at max_tokens, the monthly
 *   allowance, or an error from vc-vfx.com.
 *
 * The same loop runs in the desktop's main process (real model, worker-thread
 * commands), the browser preview (a scripted model, the page's dispatcher)
 * and the tests (a mock model).
 */

export interface AgentLimits {
  /** Model calls per run. */
  maxTurns: number;
  /** Credits per run (1 credit = $0.05 of model cost); the artist sees and sets it. */
  creditCap: number;
  /** Frame images per run, when frames are allowed. */
  maxImages: number;
  /** Output tokens asked for per call (thinking + reply); the server caps it. */
  maxTokens: number;
  /** Refuse to send a request body above this (vc-vfx.com accepts up to ~4.5 MB). */
  maxRequestBytes: number;
}

export const DEFAULT_LIMITS: AgentLimits = { maxTurns: 40, creditCap: 60, maxImages: 8, maxTokens: 32_000, maxRequestBytes: 4_000_000 };

export type StopReason = 'finished' | 'end_turn' | 'max_turns' | 'credit_cap' | 'cancelled' | 'refusal' | 'max_tokens' | 'allowance' | 'error';

export interface AgentOutcome {
  reason: StopReason;
  /** What to tell the artist about how the run ended. */
  message: string;
  report: FinishReport | null;
  /** The model's closing text when it ended without `finish`. */
  text: string | null;
  credits: number;
  turns: number;
  /** 2D tracks the run created (Undo removes them). */
  created2d: string[];
  /** The conversation so far, for a follow-up instruction in the same session. */
  conversation: Conversation;
}

export interface Conversation {
  messages: BetaMessageParam[];
  /** Tool calls of the last assistant turn that were never answered (e.g. finish): answered first on a follow-up. */
  unanswered: string[];
  framesAllowed: boolean;
}

export type AgentEvent =
  | { type: 'turn'; turn: number; maxTurns: number }
  | { type: 'fragment'; fragment: StreamFragment }
  | { type: 'thinking'; text: string }
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'command'; toolId: string; entry: CommandEntry }
  | { type: 'tool_result'; id: string; name: string; ok: boolean; summary: string }
  | { type: 'usage'; credits: number; last: TrackAgentUsage; allowance: AiAllowance | null }
  | { type: 'done'; outcome: AgentOutcome };

export interface AgentRun {
  model: ModelClient;
  host: TrackHost;
  instruction: string;
  /** Extra facts for the briefing (what the artist has selected, drawn…). */
  notes?: string[];
  framesAllowed: boolean;
  exportAllowed: boolean;
  focalRange?: { min: number; max: number } | null;
  limits?: Partial<AgentLimits>;
  signal?: AbortSignal;
  onEvent?: (e: AgentEvent) => void;
  /** Continue an earlier conversation (same frames setting: the tools must not change). */
  conversation?: Conversation | null;
  sessionId?: string;
  shotRef?: string;
}

/** The run's facts, as the first lines of the user's message (never in the cached system prompt). */
export async function briefing(run: Pick<AgentRun, 'host' | 'framesAllowed' | 'exportAllowed' | 'notes'>, limits: AgentLimits): Promise<string> {
  const s = await run.host.session();
  const target = rmsTarget(s.plate?.width ?? 1920);
  const lines = [
    `Shot ${run.host.shotId}${s.available ? `: frames ${s.first}–${s.last} (${s.last - s.first + 1}), plate ${s.plate?.width}×${s.plate?.height}, ${s.fps} fps, tracking on ${s.frames}` : ` (frames unavailable: ${s.reason ?? 'unknown'})`}.`,
    `Targets: solve RMS ≤ ${target.good} px is good, ≤ ${target.acceptable} px acceptable with a note; every frame solved; at least 20 tracks on every frame.`,
    run.framesAllowed ? `Frames: the artist allows you to look at frames of this project (get_frame_image, at most ${limits.maxImages} this run, downscaled to ≤ 1024 px).` : 'Frames: you may not see frames of this project; work from the numbers.',
    run.exportAllowed ? 'Export: allowed when the work is good (export tool).' : 'Export: not allowed in this run.',
    `Budget: at most ${limits.maxTurns} model turns and ${limits.creditCap} credits this run.`,
    ...(run.notes ?? []),
  ];
  return `<briefing>\n${lines.join('\n')}\n</briefing>`;
}

type ResultBlock = BetaToolResultBlockParam;

/** What to echo back, and which tool calls to run, from a turn's content. */
export function turnContent(content: readonly BetaContentBlock[]): { echo: BetaContentBlockParam[]; toolUses: BetaToolUseBlock[] } {
  // After a mid-output refusal fallback, the declined partial's thinking and
  // tool calls (everything before the last fallback block but text) are
  // neither echoed nor run.
  let boundary = -1;
  content.forEach((b, k) => {
    if (b.type === 'fallback') boundary = k;
  });
  const kept = boundary < 0 ? [...content] : content.filter((b, k) => k > boundary || b.type === 'text');
  return { echo: kept as unknown as BetaContentBlockParam[], toolUses: kept.filter((b): b is BetaToolUseBlock => b.type === 'tool_use') };
}

export async function runTrackAgent(run: AgentRun): Promise<AgentOutcome> {
  const limits: AgentLimits = { ...DEFAULT_LIMITS, ...(run.limits ?? {}) };
  const emit = (e: AgentEvent) => run.onEvent?.(e);
  const tools = agentTools({ framesAllowed: run.framesAllowed });
  const ctx: ToolContext = { framesAllowed: run.framesAllowed, exportAllowed: run.exportAllowed, maxImages: limits.maxImages, imagesUsed: 0, focalRange: run.focalRange ?? null, created2d: [], ...(run.signal ? { signal: run.signal } : {}) };
  let credits = 0;
  let turns = 0;
  let unanswered: string[] = [];
  const messages: BetaMessageParam[] = run.conversation ? [...run.conversation.messages] : [];
  if (run.conversation && run.conversation.framesAllowed !== run.framesAllowed) throw new Error('A follow-up keeps the frames setting of its conversation (the tools may not change mid-conversation). Start a new session instead.');

  const opening: BetaContentBlockParam[] = [
    // A follow-up answers any tool call the last turn left open (finish), first.
    ...(run.conversation?.unanswered ?? []).map((id): ResultBlock => ({ type: 'tool_result', tool_use_id: id, content: 'Noted.' })),
    { type: 'text', text: `${await briefing(run, limits)}\n\nThe artist's instruction:\n${run.instruction.trim()}` },
  ];
  messages.push({ role: 'user', content: opening });

  const finish = (reason: StopReason, message: string, report: FinishReport | null = null, text: string | null = null): AgentOutcome => {
    const outcome: AgentOutcome = { reason, message, report, text, credits: Math.round(credits * 100) / 100, turns, created2d: [...ctx.created2d], conversation: { messages, unanswered, framesAllowed: run.framesAllowed } };
    emit({ type: 'done', outcome });
    return outcome;
  };

  while (true) {
    if (run.signal?.aborted) return finish('cancelled', 'Stopped. Everything done so far is kept and logged; Undo reverts it.');
    if (turns >= limits.maxTurns) return finish('max_turns', `Stopped after ${limits.maxTurns} model turns without a final report. What it did is kept and logged.`);
    if (credits >= limits.creditCap) return finish('credit_cap', `Stopped at this run’s limit of ${limits.creditCap} credits. What it did is kept and logged.`);
    const request = { system: TRACK_AGENT_SYSTEM, tools, messages, maxTokens: limits.maxTokens, ...(run.sessionId ? { sessionId: run.sessionId } : {}), ...(run.shotRef ? { shotRef: run.shotRef } : {}) };
    if (JSON.stringify(request).length > limits.maxRequestBytes) return finish('error', 'The conversation has grown too large to send (mostly frame images). Start a new session.');
    turns += 1;
    emit({ type: 'turn', turn: turns, maxTurns: limits.maxTurns });
    let answer;
    try {
      answer = await run.model.call(request, { ...(run.signal ? { signal: run.signal } : {}), onFragment: (fragment) => emit({ type: 'fragment', fragment }) });
    } catch (error) {
      if (run.signal?.aborted) return finish('cancelled', 'Stopped. Everything done so far is kept and logged; Undo reverts it.');
      if (error instanceof ModelCallError && error.status === 402) return finish('allowance', error.message);
      return finish('error', (error as Error).message || 'The assistant could not reach vc-vfx.com.');
    }
    credits += answer.usage.credits;
    emit({ type: 'usage', credits: Math.round(credits * 100) / 100, last: answer.usage, allowance: answer.allowance });
    const message = answer.message;
    for (const b of message.content) {
      if (b.type === 'thinking' && b.thinking.trim()) emit({ type: 'thinking', text: b.thinking.trim() });
      else if (b.type === 'text' && b.text.trim()) emit({ type: 'text', text: b.text.trim() });
    }
    if (message.stop_reason === 'refusal') {
      // A refusal can cut a tool call off mid-input: nothing of this turn runs or is kept.
      const why = message.stop_details && 'category' in message.stop_details && message.stop_details.category ? ` (${String(message.stop_details.category)})` : '';
      return finish('refusal', `The model declined to continue${why}. Nothing further was changed; what was done before is kept.`);
    }
    const { echo, toolUses } = turnContent(message.content);
    const text = message.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n').trim() || null;
    if (message.stop_reason === 'max_tokens' && toolUses.length) return finish('max_tokens', 'The model ran out of room in the middle of a step, so that step was not run. Try again.');
    messages.push({ role: 'assistant', content: echo });
    if (message.stop_reason === 'pause_turn') continue;
    if (!toolUses.length) {
      unanswered = [];
      return finish(message.stop_reason === 'max_tokens' ? 'max_tokens' : 'end_turn', text ? 'Finished without a structured report.' : 'The assistant stopped without a report.', null, text);
    }

    const results: ResultBlock[] = [];
    let report: FinishReport | null = null;
    for (const use of toolUses) {
      if (run.signal?.aborted) {
        results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: 'Stopped by the artist before this ran.' });
        continue;
      }
      emit({ type: 'tool_call', id: use.id, name: use.name, input: use.input });
      ctx.onCommand = (entry) => emit({ type: 'command', toolId: use.id, entry });
      const out = await executeTool(run.host, ctx, use.name, use.input);
      ctx.onCommand = undefined;
      emit({ type: 'tool_result', id: use.id, name: use.name, ok: out.ok, summary: out.summary });
      results.push({ type: 'tool_result', tool_use_id: use.id, content: out.content, ...(out.ok ? {} : { is_error: true }) });
      if (out.report) report = out.report;
    }
    if (report) {
      // finish ends the run; its result is sent at the start of a follow-up, with any siblings answered now.
      const finishId = toolUses.find((u) => u.name === 'finish')!.id;
      const others = results.filter((r) => r.tool_use_id !== finishId);
      if (others.length) messages.push({ role: 'user', content: [...others, { type: 'tool_result', tool_use_id: finishId, content: 'Report delivered.' }] });
      unanswered = others.length ? [] : [finishId];
      return finish('finished', report.targetsMet ? 'Finished: targets met. Review it, then approve the task in Details (right) if you agree.' : 'Finished: targets not all met — see the concerns.', report, text);
    }
    messages.push({ role: 'user', content: results });
    unanswered = [];
    if (run.signal?.aborted) return finish('cancelled', 'Stopped. Everything done so far is kept and logged; Undo reverts it.');
  }
}
