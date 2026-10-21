import { describe, expect, it } from 'vitest';
import { AI_PRICES, allowanceExhausted, allowanceFrom, allowanceMonth, creditsFor, priceFor, resetsOnLabel, roundCost, usageCost } from '../ai-usage';

describe('AI usage metering', () => {
  it('prices a call from its token counts at list price', () => {
    // 10k uncached in, 2k out, 50k cache read, 4k cache write on Claude Opus 5.5.
    const u = usageCost({ input_tokens: 10_000, output_tokens: 2_000, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 4_000 }, 'claude-opus-5-5');
    expect(u.costUsd).toBeCloseTo(0.04 + 0.04 + 0.01 + 0.02, 10);
    expect(creditsFor(u.costUsd)).toBe(2.2);
    const s = usageCost({ input_tokens: 10_000, output_tokens: 2_000 }, 'claude-sonnet-5-5');
    expect(s.costUsd).toBeCloseTo(0.02 + 0.02, 10);
  });

  it('cache writes are 1.25 × input, cache reads $0.20 per million on both models', () => {
    for (const m of ['claude-opus-5-5', 'claude-sonnet-5-5']) {
      expect(AI_PRICES[m]!.cacheWrite).toBeCloseTo(AI_PRICES[m]!.input * 1.25, 10);
      expect(AI_PRICES[m]!.cacheRead).toBe(0.2);
    }
  });

  it('sums every attempt when a refusal fallback ran, each at its own model’s rates', () => {
    const u = usageCost(
      {
        input_tokens: 1000,
        output_tokens: 100,
        iterations: [
          { type: 'message', model: 'claude-opus-5-5', input_tokens: 1000, output_tokens: 0 },
          { type: 'fallback_message', model: 'claude-opus-5', input_tokens: 1000, output_tokens: 100 },
          { type: 'compaction', input_tokens: 99_999, output_tokens: 9_999 },
        ],
      },
      'claude-opus-5-5',
    );
    expect(u.inputTokens).toBe(2000);
    expect(u.costUsd).toBeCloseTo((1000 * 4 + 1000 * 5 + 100 * 25) / 1e6, 10);
  });

  it('an unknown model is charged as the dearest known one, never free', () => {
    expect(priceFor('claude-something-new').output).toBe(25);
    expect(usageCost(null, 'claude-opus-5-5').costUsd).toBe(0);
    expect(creditsFor(0.0001)).toBe(0.01);
    expect(creditsFor(0)).toBe(0);
    expect(roundCost(0.123456)).toBe(0.1235);
  });

  it('the allowance is per UTC calendar month and resets on the first', () => {
    const { start, resetsAt } = allowanceMonth(new Date('2026-12-31T23:30:00Z'));
    expect(start.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(resetsAt.toISOString()).toBe('2027-01-01T00:00:00.000Z');
    expect(resetsOnLabel(resetsAt.toISOString())).toBe('1 January');
  });

  it('works out what is left, and admins are not metered', () => {
    const now = new Date('2026-10-21T10:00:00Z');
    const a = allowanceFrom({ costsUsd: ['1.2500', 2.5, '0.25'], limit: 400, unlimited: false, model: 'claude-opus-5-5', now });
    expect(a).toEqual({ used: 80, limit: 400, remaining: 320, resetsAt: '2026-11-01T00:00:00.000Z', model: 'claude-opus-5-5' });
    expect(allowanceExhausted(a)).toBe(false);
    const over = allowanceFrom({ costsUsd: [25], limit: 400, unlimited: false, model: 'claude-opus-5-5', now });
    expect(over.remaining).toBe(0);
    expect(allowanceExhausted(over)).toBe(true);
    const admin = allowanceFrom({ costsUsd: [250], limit: 400, unlimited: true, model: 'claude-sonnet-5-5', now });
    expect(admin.limit).toBeNull();
    expect(admin.remaining).toBeNull();
    expect(admin.used).toBe(5000);
    expect(allowanceExhausted(admin)).toBe(false);
  });
});
