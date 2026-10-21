/**
 * The AI tracking assistant's metering (addendum 07 §6): what a model call
 * costs at list price, what that is in credits, and what is left of the
 * month's allowance. vc-vfx.com computes and records it after every call; the
 * desktop shows the same numbers. Pure, so both sides agree to the cent.
 *
 * 1 credit = US$0.05 of model cost at Anthropic's list price. The allowance
 * is per calendar month (UTC), set on the server (`AI_MONTHLY_CREDITS`,
 * default 400 ≈ $20 of model cost); administrators are not metered.
 */

/** Models the server may call. The first is the default. */
export const AI_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5'] as const;
export type AiModel = (typeof AI_MODELS)[number];
export const DEFAULT_AI_MODEL: AiModel = 'claude-opus-5-5';
export const isAiModel = (value: string): value is AiModel => (AI_MODELS as readonly string[]).includes(value);

export const AI_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type AiEffort = (typeof AI_EFFORTS)[number];
export const DEFAULT_AI_EFFORT: AiEffort = 'high';

/** US dollars per million tokens. */
export interface AiPrice {
  input: number;
  output: number;
  cacheRead: number;
  /** 5-minute cache writes (1.25 × input); the assistant never asks for the 1-hour TTL. */
  cacheWrite: number;
}

/**
 * List prices, October 2026. UPDATE THIS TABLE when Anthropic's prices change
 * (platform.claude.com/docs/en/about-claude/pricing); it is the only place
 * they are written down. The last three are the models a server-side refusal
 * fallback (`fallbacks: "default"`) may hand a turn to: a fallback attempt is
 * billed at the fallback model's own rates. Claude Opus 4.8's figures are
 * taken as Claude Opus 5's (not separately confirmed here).
 */
export const AI_PRICES: Readonly<Record<string, AiPrice>> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
};

/** A model this table does not know is charged as the dearest it does, never as free. */
const DEAREST: AiPrice = Object.values(AI_PRICES).reduce((a, b) => (b.output > a.output ? b : a));
export const priceFor = (model: string | null | undefined): AiPrice => (model ? AI_PRICES[model] : undefined) ?? DEAREST;

export const CREDIT_USD = 0.05;
export const DEFAULT_MONTHLY_CREDITS = 400;

/** Token counts as the Messages API reports them (top-level `usage`, or one `usage.iterations` entry). */
export interface AiTokenCounts {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export interface AiUsageLike extends AiTokenCounts {
  /**
   * Per-attempt breakdown. With a server-side fallback the top-level counts
   * cover only the attempt that produced the message; `iterations` is the
   * source of truth for billing, each entry at its own model's rates.
   */
  iterations?: ReadonlyArray<AiTokenCounts & { type?: string; model?: string | null }> | null;
}

export interface AiUsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

const n = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

function attemptCost(c: AiTokenCounts, model: string | null | undefined): AiUsageTotals {
  const p = priceFor(model);
  const t = { inputTokens: n(c.input_tokens), outputTokens: n(c.output_tokens), cacheReadTokens: n(c.cache_read_input_tokens), cacheWriteTokens: n(c.cache_creation_input_tokens) };
  return { ...t, costUsd: (t.inputTokens * p.input + t.outputTokens * p.output + t.cacheReadTokens * p.cacheRead + t.cacheWriteTokens * p.cacheWrite) / 1_000_000 };
}

/**
 * What one Messages API response cost at list price. `model` is the model the
 * request named (used for the top-level counts and for iterations that carry
 * no model). Message and fallback-message iterations are summed; compaction
 * and other entries are not model attempts this assistant makes.
 */
export function usageCost(usage: AiUsageLike | null | undefined, model: string): AiUsageTotals {
  const zero: AiUsageTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
  if (!usage) return zero;
  const attempts = (usage.iterations ?? []).filter((i) => i.type === 'message' || i.type === 'fallback_message');
  const parts = attempts.length ? attempts.map((i) => attemptCost(i, i.model ?? model)) : [attemptCost(usage, model)];
  return parts.reduce((a, b) => ({
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    costUsd: a.costUsd + b.costUsd,
  }), zero);
}

/** Credits for a cost, to the hundredth (never rounded down to nothing). */
export function creditsFor(costUsd: number): number {
  if (!(costUsd > 0)) return 0;
  return Math.max(0.01, Math.round((costUsd / CREDIT_USD) * 100) / 100);
}

/** Cost as stored (numeric(10,4)). */
export const roundCost = (costUsd: number): number => Math.round(Math.max(0, costUsd) * 10_000) / 10_000;

/** The calendar month (UTC) an instant falls in, and when the next one starts. */
export function allowanceMonth(now: Date): { start: Date; resetsAt: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const resetsAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, resetsAt };
}

export interface AiAllowance {
  /** Credits used this month. */
  used: number;
  /** The month's allowance; null when not metered (administrators). */
  limit: number | null;
  /** What is left (never negative); null when not metered. */
  remaining: number | null;
  /** ISO time the allowance next resets (the first of next month, UTC). */
  resetsAt: string;
  /** The model the server calls. */
  model: AiModel;
}

/** The month's allowance from the costs recorded since the month began. */
export function allowanceFrom(input: { costsUsd: ReadonlyArray<number | string>; limit: number; unlimited: boolean; model: AiModel; now: Date }): AiAllowance {
  const total = input.costsUsd.reduce<number>((a, c) => a + (Number(c) || 0), 0);
  const used = Math.round((total / CREDIT_USD) * 100) / 100;
  const { resetsAt } = allowanceMonth(input.now);
  if (input.unlimited) return { used, limit: null, remaining: null, resetsAt: resetsAt.toISOString(), model: input.model };
  return { used, limit: input.limit, remaining: Math.max(0, Math.round((input.limit - used) * 100) / 100), resetsAt: resetsAt.toISOString(), model: input.model };
}

export const allowanceExhausted = (a: Pick<AiAllowance, 'remaining'>): boolean => a.remaining !== null && a.remaining <= 0;

/** "resets on 1 November" — for the desktop's and the website's wording. */
export function resetsOnLabel(resetsAt: string): string {
  const d = new Date(resetsAt);
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]}`;
}
