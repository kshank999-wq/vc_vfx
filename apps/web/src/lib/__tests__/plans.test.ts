import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatPrice, planForPriceId, planFromInput, priceIdForPlan, yearlySavingPercent } from '../plans';

const ids = { monthly: 'price_month', yearly: 'price_year' };

describe('plan and price selection', () => {
  it('maps each plan to its own Stripe price', () => {
    expect(priceIdForPlan('monthly', ids)).toBe('price_month');
    expect(priceIdForPlan('yearly', ids)).toBe('price_year');
  });

  it('maps a price back to its plan, and refuses strangers', () => {
    expect(planForPriceId('price_year', ids)).toBe('yearly');
    expect(planForPriceId('price_month', ids)).toBe('monthly');
    expect(planForPriceId('price_other', ids)).toBeNull();
    expect(planForPriceId(null, ids)).toBeNull();
  });

  it('defaults a missing plan to monthly and refuses unknown words', () => {
    expect(planFromInput(undefined)).toBe('monthly');
    expect(planFromInput('')).toBe('monthly');
    expect(planFromInput('yearly')).toBe('yearly');
    expect(planFromInput('lifetime')).toBeNull();
    expect(planFromInput(12)).toBeNull();
  });

  it('formats Stripe amounts without inventing cents', () => {
    expect(formatPrice(2900, 'usd')).toBe('$29');
    expect(formatPrice(2950, 'usd')).toBe('$29.50');
  });

  it('reads the yearly saving off the two prices', () => {
    expect(yearlySavingPercent(2900, 29000, 'usd', 'usd')).toBe(16);
    expect(yearlySavingPercent(2900, 34800, 'usd', 'usd')).toBeNull();
    expect(yearlySavingPercent(2900, 29000, 'usd', 'eur')).toBeNull();
  });
});

describe('priceIdFor (env)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('reads the price ids from the environment at use, not at import', async () => {
    vi.stubEnv('STRIPE_PRICE_ID_MONTHLY', '');
    vi.stubEnv('STRIPE_PRICE_ID_YEARLY', '');
    const { priceIdFor } = await import('../pricing');
    expect(() => priceIdFor('monthly')).toThrow(/STRIPE_PRICE_ID_MONTHLY/);

    vi.stubEnv('STRIPE_PRICE_ID_MONTHLY', 'price_m');
    vi.stubEnv('STRIPE_PRICE_ID_YEARLY', 'price_y');
    expect(priceIdFor('monthly')).toBe('price_m');
    expect(priceIdFor('yearly')).toBe('price_y');
  });

  it('shows no prices rather than failing when Stripe is not configured', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', '');
    const { fetchPlanPrices } = await import('../pricing');
    await expect(fetchPlanPrices()).resolves.toEqual([]);
  });
});
