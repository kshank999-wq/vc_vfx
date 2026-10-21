import type { BetaMessage, BetaMessageParam, BetaTool } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { AiAllowance } from '@vcvfx/domain';

/**
 * The wire contract between the desktop's AI tracking assistant and
 * vc-vfx.com's `/api/ai/track-agent` (addendum 07 §4). The desktop sends the
 * conversation; the server chooses the model, effort, thinking, caching and
 * refusal fallbacks, checks the licence and the allowance, calls Anthropic and
 * streams the answer back as NDJSON, one `TrackAgentLine` per line, ending
 * with `final` (or `error`). apps/web/src/lib/ai.ts mirrors these types.
 *
 * Type-only imports from the SDK: the desktop never calls Anthropic itself.
 */

export type { BetaMessage, BetaMessageParam, BetaTool };

export interface TrackAgentRequest {
  /** The stable system prompt (the server puts the cache breakpoint on it). */
  system: string;
  /** The session's tools, in a fixed order. */
  tools: BetaTool[];
  messages: BetaMessageParam[];
  /** Asked-for output limit; the server caps it. */
  maxTokens?: number;
  /** For the usage record: the shot (VFX shot number), never footage. */
  shotRef?: string;
  /** For the usage record: one assistant run. */
  sessionId?: string;
}

export interface TrackAgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  credits: number;
}

export type TrackAgentLine =
  | { type: 'start'; model: string; allowance: AiAllowance }
  | { type: 'block'; index: number; block: string; name?: string }
  | { type: 'delta'; index: number; kind: 'thinking' | 'text'; text: string }
  | { type: 'final'; message: BetaMessage; usage: TrackAgentUsage; allowance: AiAllowance }
  | { type: 'error'; status: number; error: string; allowance?: AiAllowance };

/** A streamed fragment the panel can show while the model works. */
export type StreamFragment = { kind: 'block'; index: number; block: string; name?: string } | { kind: 'delta'; index: number; delta: 'thinking' | 'text'; text: string };

export interface ModelCallResult {
  message: BetaMessage;
  usage: TrackAgentUsage;
  allowance: AiAllowance | null;
}

/** How the agent loop reaches the model: vc-vfx.com on the desktop, a script in the preview and the tests. */
export interface ModelClient {
  call(request: TrackAgentRequest, options: { signal?: AbortSignal; onFragment?: (f: StreamFragment) => void }): Promise<ModelCallResult>;
}

/** A refusal from vc-vfx.com before or instead of a model answer (402 allowance used up, 401, 403, 503…). */
export class ModelCallError extends Error {
  override name = 'ModelCallError';
  constructor(
    message: string,
    readonly status: number,
    readonly allowance: AiAllowance | null = null,
  ) {
    super(message);
  }
}

/** Parse an NDJSON body into lines (tolerant of a final line without a newline). */
export async function* ndjsonLines(body: AsyncIterable<Uint8Array>): AsyncGenerator<TrackAgentLine> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) yield JSON.parse(line) as TrackAgentLine;
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) yield JSON.parse(buffer.trim()) as TrackAgentLine;
}

/**
 * Collect a streamed answer: fragments to `onFragment`, the final message and
 * usage returned; an `error` line (or a stream that ends without `final`) is a
 * `ModelCallError`.
 */
export async function collectAnswer(lines: AsyncIterable<TrackAgentLine>, onFragment?: (f: StreamFragment) => void): Promise<ModelCallResult> {
  for await (const line of lines) {
    if (line.type === 'block') onFragment?.({ kind: 'block', index: line.index, block: line.block, ...(line.name ? { name: line.name } : {}) });
    else if (line.type === 'delta') onFragment?.({ kind: 'delta', index: line.index, delta: line.kind, text: line.text });
    else if (line.type === 'final') return { message: line.message, usage: line.usage, allowance: line.allowance };
    else if (line.type === 'error') throw new ModelCallError(line.error, line.status, line.allowance ?? null);
  }
  throw new ModelCallError('The connection to vc-vfx.com ended before the answer did. Try again.', 502);
}
