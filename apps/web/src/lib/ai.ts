import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';
import type { BetaMessage, BetaRawMessageStreamEvent } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { z } from 'zod';
import {
  allowanceExhausted,
  allowanceFrom,
  allowanceMonth,
  bestLicense,
  creditsFor,
  licenseLive,
  resetsOnLabel,
  roundCost,
  usageCost,
  type AiAllowance,
  type AiEffort,
  type AiModel,
  type LicenseStatus,
} from '@vcvfx/domain';

/**
 * The AI tracking assistant's server side (addendum 07 §4). The desktop app
 * runs the agent loop and its tools on the artist's machine; for each model
 * turn it posts the conversation here with the account's access token. This
 * module checks the caller has a live licence and allowance left, builds the
 * Messages API request itself (model, effort, thinking, caching and refusal
 * fallbacks are the server's, never the client's), calls Anthropic, streams
 * the answer back as NDJSON and records what the call cost.
 *
 * Streaming: one JSON object per line — `start`, then `block` / `delta` while
 * the model works (thinking summaries and text, for the panel), then `final`
 * with the whole message, its usage and the allowance after it; or `error`.
 * The desktop's shared/ai/protocol.ts mirrors these types.
 *
 * Credit packs / top-ups are not built yet. TODO(addendum 07 §6.4): a Stripe
 * one-off price per pack, a `ai_credit_grants` table (user, credits, expires,
 * order) whose unexpired sum is added to the monthly limit, granted by the
 * existing webhook on `checkout.session.completed`.
 */

// ---------------------------------------------------------------------------
// The wire contract (mirrored in apps/desktop/src/shared/ai/protocol.ts)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// What the desktop may send: everything else is stripped or refused
// ---------------------------------------------------------------------------

const MAX_TEXT = 200_000;
const noCache = <T extends Record<string, unknown>>(b: T): T => {
  const { cache_control: _c, ...rest } = b as T & { cache_control?: unknown };
  return rest as T;
};

const textBlock = z.object({ type: z.literal('text'), text: z.string().max(MAX_TEXT) }).strip();
const imageBlock = z
  .object({
    type: z.literal('image'),
    source: z.object({ type: z.literal('base64'), media_type: z.enum(['image/jpeg', 'image/png']), data: z.string().max(3_000_000).regex(/^[A-Za-z0-9+/=]*$/) }).strict(),
  })
  .strip();
const toolResultBlock = z
  .object({
    type: z.literal('tool_result'),
    tool_use_id: z.string().min(1).max(200),
    content: z.union([z.string().max(MAX_TEXT), z.array(z.union([textBlock, imageBlock])).max(8)]).optional(),
    is_error: z.boolean().optional(),
  })
  .strip();
const userBlock = z.union([textBlock, imageBlock, toolResultBlock]);

/** Assistant turns go back exactly as the API returned them (thinking signatures included): checked by type, not rebuilt. */
const ASSISTANT_TYPES = ['text', 'thinking', 'redacted_thinking', 'tool_use', 'fallback'] as const;
const assistantBlock = z.object({ type: z.enum(ASSISTANT_TYPES) }).passthrough().transform((b) => noCache(b));

const messageSchema = z.discriminatedUnion('role', [
  z.object({ role: z.literal('user'), content: z.union([z.string().max(MAX_TEXT), z.array(userBlock).min(1).max(64)]) }).strip(),
  z.object({ role: z.literal('assistant'), content: z.array(assistantBlock).min(1).max(64) }).strip(),
]);

const toolSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    description: z.string().max(4000),
    input_schema: z.object({ type: z.literal('object') }).passthrough(),
    strict: z.boolean().optional(),
  })
  .strip();

export const trackAgentRequestSchema = z
  .object({
    system: z.string().min(1).max(60_000),
    tools: z.array(toolSchema).max(40),
    messages: z.array(messageSchema).min(1).max(800),
    maxTokens: z.number().int().positive().optional(),
    shotRef: z.string().max(200).optional(),
    sessionId: z.string().max(100).optional(),
  })
  .strip();

export type TrackAgentBody = z.infer<typeof trackAgentRequestSchema>;

export interface AiConfig {
  model: AiModel;
  effort: AiEffort;
  monthlyCredits: number;
  maxTokens: number;
}

export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/** The Messages API request, built here from the desktop's conversation and the server's settings. */
export function messagesParams(body: TrackAgentBody, config: AiConfig, userId: string) {
  if (body.messages[0]?.role !== 'user') throw new Error('The conversation must start with the artist.');
  return {
    model: config.model,
    max_tokens: Math.min(body.maxTokens ?? config.maxTokens, config.maxTokens),
    // The stable prefix: tools, then this system block, cached together.
    system: [{ type: 'text' as const, text: body.system, cache_control: { type: 'ephemeral' as const } }],
    tools: body.tools.map((t) => ({ ...t, strict: true })),
    messages: body.messages,
    // Automatic caching of the conversation so far (the last cacheable block).
    cache_control: { type: 'ephemeral' as const },
    // Claude Opus 5.5 / Sonnet 5.5: thinking is adaptive (always on for Opus 5.5); effort is the control.
    thinking: { type: 'adaptive' as const, display: 'summarized' as const },
    output_config: { effort: config.effort },
    // A classifier decline is retried server-side on the model Anthropic recommends for that category.
    fallbacks: 'default' as const,
    betas: [FALLBACK_BETA],
    // tool_choice is left at auto: forced tool use is a 400 on these models.
    metadata: { user_id: createHash('sha256').update(`vcvfx:${userId}`).digest('hex').slice(0, 40) },
  };
}

// ---------------------------------------------------------------------------
// Licence and allowance
// ---------------------------------------------------------------------------

export interface Caller {
  userId: string;
  admin: boolean;
  licenseId: string | null;
  live: boolean;
}

export async function callerStanding(userId: string, db: SupabaseClient, now: Date): Promise<Caller> {
  const [{ data: rows }, { data: profile }] = await Promise.all([db.from('licenses').select('id, status, expires_at').eq('user_id', userId), db.from('profiles').select('is_admin').eq('id', userId).maybeSingle()]);
  const licences = ((rows ?? []) as { id: string; status: LicenseStatus; expires_at: string | null }[]).map((r) => ({ id: r.id, status: r.status, expiresAt: r.expires_at }));
  const best = bestLicense(licences, now);
  return { userId, admin: Boolean((profile as { is_admin?: boolean } | null)?.is_admin), licenseId: best?.id ?? null, live: Boolean(best && licenseLive(best, now)) };
}

export async function monthAllowance(caller: Pick<Caller, 'userId' | 'admin'>, db: SupabaseClient, config: Pick<AiConfig, 'model' | 'monthlyCredits'>, now: Date): Promise<AiAllowance> {
  const { start } = allowanceMonth(now);
  const { data, error } = await db.from('ai_usage').select('cost_usd').eq('user_id', caller.userId).gte('created_at', start.toISOString());
  if (error) throw new Error('The AI allowance could not be read.');
  return allowanceFrom({ costsUsd: ((data ?? []) as { cost_usd: number | string }[]).map((r) => r.cost_usd), limit: config.monthlyCredits, unlimited: caller.admin, model: config.model, now });
}

export const exhaustedMessage = (a: AiAllowance) => `AI allowance used up this month — resets on ${resetsOnLabel(a.resetsAt)}.`;

export async function recordUsage(db: SupabaseClient, row: { caller: Caller; model: string; usage: TrackAgentUsage; shotRef?: string | undefined; sessionId?: string | undefined }): Promise<void> {
  const { error } = await db.from('ai_usage').insert({
    user_id: row.caller.userId,
    license_id: row.caller.licenseId,
    model: row.model,
    input_tokens: row.usage.inputTokens,
    output_tokens: row.usage.outputTokens,
    cache_read_tokens: row.usage.cacheReadTokens,
    cache_write_tokens: row.usage.cacheWriteTokens,
    cost_usd: roundCost(row.usage.costUsd),
    shot_ref: row.shotRef ?? null,
    session_id: row.sessionId ?? null,
  });
  if (error) console.error('ai_usage insert failed', error.message);
}

export function usageOf(message: Pick<BetaMessage, 'usage' | 'model'>, requested: string): TrackAgentUsage {
  const c = usageCost(message.usage as never, requested);
  return { inputTokens: c.inputTokens, outputTokens: c.outputTokens, cacheReadTokens: c.cacheReadTokens, cacheWriteTokens: c.cacheWriteTokens, costUsd: c.costUsd, credits: creditsFor(c.costUsd) };
}

// ---------------------------------------------------------------------------
// The handlers (dependencies passed in, so they are tested without the network)
// ---------------------------------------------------------------------------

/** The part of the SDK's beta message stream this module uses. */
export interface StreamLike extends AsyncIterable<BetaRawMessageStreamEvent> {
  finalMessage(): Promise<BetaMessage>;
  abort(): void;
  readonly currentMessage?: BetaMessage | undefined;
}

export interface AnthropicLike {
  beta: { messages: { stream(params: ReturnType<typeof messagesParams>, options?: { signal?: AbortSignal }): StreamLike } };
}

export interface AiDeps {
  /** Accounts and the Anthropic key are set on this deployment. */
  configured(): boolean;
  user(): Promise<{ id: string } | null>;
  db(): SupabaseClient;
  anthropic(): AnthropicLike;
  config(): AiConfig;
  now(): Date;
}

const jsonResponse = (body: unknown, status: number): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
export const NOT_CONFIGURED = 'AI assistant not configured on this deployment.';
const MAX_BODY = 4_400_000;

export async function handleAllowance(deps: AiDeps): Promise<Response> {
  if (!deps.configured()) return jsonResponse({ error: NOT_CONFIGURED }, 503);
  const user = await deps.user();
  if (!user) return jsonResponse({ error: 'Sign in to see your AI allowance.' }, 401);
  const db = deps.db();
  const now = deps.now();
  const caller = await callerStanding(user.id, db, now);
  try {
    const a = await monthAllowance(caller, db, deps.config(), now);
    return jsonResponse({ ...a, licensed: caller.live || caller.admin }, 200);
  } catch (error) {
    return jsonResponse({ error: (error as Error).message }, 502);
  }
}

/** Why the model API refused, in words for the artist. */
function apiErrorMessage(error: unknown): { status: number; message: string } {
  const status = typeof (error as { status?: unknown })?.status === 'number' ? (error as { status: number }).status : 502;
  if (status === 429) return { status: 429, message: 'The AI service is busy. Wait a minute and try again.' };
  if (status === 529 || status === 503) return { status: 503, message: 'The AI service is overloaded right now. Try again shortly.' };
  if (status === 400) return { status: 400, message: `The AI service refused the request: ${(error as Error).message?.slice(0, 300) ?? 'bad request'}` };
  if (status === 401 || status === 403) return { status: 503, message: 'The AI service rejected vc-vfx.com’s key. This is our problem, not yours; it has been logged.' };
  return { status: 502, message: 'The AI service could not be reached. Try again.' };
}

export async function handleTrackAgent(request: Request, deps: AiDeps): Promise<Response> {
  if (!deps.configured()) return jsonResponse({ error: NOT_CONFIGURED }, 503);
  const length = Number(request.headers.get('content-length') ?? 0);
  if (length > MAX_BODY) return jsonResponse({ error: 'The conversation is too large to send. Start a new session.' }, 413);
  const user = await deps.user();
  if (!user) return jsonResponse({ error: 'Sign in to use the AI assistant (VC VFX › Account).' }, 401);
  const raw = await request.text();
  if (raw.length > MAX_BODY) return jsonResponse({ error: 'The conversation is too large to send. Start a new session.' }, 413);
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return jsonResponse({ error: 'Not JSON.' }, 400);
  }
  const parsed = trackAgentRequestSchema.safeParse(parsedJson);
  if (!parsed.success) return jsonResponse({ error: `Invalid request: ${parsed.error.issues[0]?.path.join('.') ?? ''} ${parsed.error.issues[0]?.message ?? ''}`.trim() }, 400);
  const body = parsed.data;

  const db = deps.db();
  const now = deps.now();
  const config = deps.config();
  const caller = await callerStanding(user.id, db, now);
  if (!caller.live && !caller.admin) return jsonResponse({ error: 'The AI assistant needs an active VC VFX licence. Renew at vc-vfx.com/account.' }, 403);
  let allowance: AiAllowance;
  try {
    allowance = await monthAllowance(caller, db, config, now);
  } catch (error) {
    return jsonResponse({ error: (error as Error).message }, 502);
  }
  if (allowanceExhausted(allowance)) return jsonResponse({ error: exhaustedMessage(allowance), remaining: 0, resetsAt: allowance.resetsAt, allowance }, 402);

  let params: ReturnType<typeof messagesParams>;
  try {
    params = messagesParams(body, config, user.id);
  } catch (error) {
    return jsonResponse({ error: (error as Error).message }, 400);
  }

  const anthropic = deps.anthropic();
  const controller = new AbortController();
  request.signal?.addEventListener('abort', () => controller.abort(), { once: true });
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(out) {
      const send = (line: TrackAgentLine) => {
        try {
          out.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
        } catch {
          // The desktop went away.
        }
      };
      send({ type: 'start', model: config.model, allowance });
      let sdk: StreamLike | null = null;
      try {
        sdk = anthropic.beta.messages.stream(params, { signal: controller.signal });
        for await (const event of sdk) {
          if (event.type === 'content_block_start') {
            const b = event.content_block as { type: string; name?: string };
            send({ type: 'block', index: event.index, block: b.type, ...(b.type === 'tool_use' && b.name ? { name: b.name } : {}) });
          } else if (event.type === 'content_block_delta') {
            if (event.delta.type === 'thinking_delta') send({ type: 'delta', index: event.index, kind: 'thinking', text: event.delta.thinking });
            else if (event.delta.type === 'text_delta') send({ type: 'delta', index: event.index, kind: 'text', text: event.delta.text });
          }
        }
        const message = await sdk.finalMessage();
        const usage = usageOf(message, config.model);
        await recordUsage(db, { caller, model: message.model || config.model, usage, shotRef: body.shotRef, sessionId: body.sessionId });
        const after = caller.admin ? { ...allowance, used: Math.round((allowance.used + usage.credits) * 100) / 100 } : { ...allowance, used: Math.round((allowance.used + usage.credits) * 100) / 100, remaining: Math.max(0, Math.round(((allowance.remaining ?? 0) - usage.credits) * 100) / 100) };
        send({ type: 'final', message, usage, allowance: after });
      } catch (error) {
        // Bill what was spent before a cancel or a failure, when the stream knows it.
        const partial = sdk?.currentMessage;
        if (partial?.usage && (partial.usage.input_tokens || partial.usage.output_tokens)) await recordUsage(db, { caller, model: partial.model || config.model, usage: usageOf(partial, config.model), shotRef: body.shotRef, sessionId: body.sessionId });
        if (!controller.signal.aborted) {
          const e = apiErrorMessage(error);
          console.error('track-agent model call failed', e.status, (error as Error).message);
          send({ type: 'error', status: e.status, error: e.message });
        }
      } finally {
        try {
          out.close();
        } catch {
          // already closed
        }
      }
    },
    cancel() {
      controller.abort();
    },
  });

  return new Response(stream, { status: 200, headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store, no-transform', 'x-accel-buffering': 'no' } });
}

// ---------------------------------------------------------------------------
// Live dependencies
// ---------------------------------------------------------------------------

let client: Anthropic | null = null;

/** The real SDK client, created on first use (importing this module needs no key, so the build passes without one). */
export function anthropicClient(apiKey: string): AnthropicLike {
  // The function may run 300 s; leave room to send the final line and record usage.
  client ??= new Anthropic({ apiKey, timeout: 270_000, maxRetries: 1 });
  return client as unknown as AnthropicLike;
}
