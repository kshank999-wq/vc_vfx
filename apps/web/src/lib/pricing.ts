import { PLANS, type SubscriptionPlan } from '@vcvfx/domain';
import { env, hasStripe } from './env';
import { formatPrice, PLAN_WORDS, priceIdForPlan, yearlySavingPercent } from './plans';
import { stripe } from './stripe';

/**
 * The prices, read from Stripe rather than repeated in the code. Returns an
 * empty list when Stripe is not configured or cannot answer, so the pages say
 * "pricing coming soon" instead of failing. Cached for a few minutes per
 * server instance so every page view is not a Stripe round trip.
 */

export interface PlanPrice {
  plan: SubscriptionPlan;
  label: string;
  per: string;
  amountCents: number;
  currency: string;
  formatted: string;
  savingPercent: number | null;
}

export const priceIdFor = (plan: SubscriptionPlan): string =>
  priceIdForPlan(plan, { monthly: env.stripeMonthlyPriceId, yearly: env.stripeYearlyPriceId });

const TTL_MS = 5 * 60 * 1000;
let cache: { at: number; plans: PlanPrice[] } | null = null;

const readOne = async (plan: SubscriptionPlan) => {
  const price = await stripe().prices.retrieve(priceIdFor(plan));
  if (!price.active || price.unit_amount === null || !price.currency) return null;
  return { amountCents: price.unit_amount, currency: price.currency };
};

export const fetchPlanPrices = async (): Promise<PlanPrice[]> => {
  if (!hasStripe()) return [];
  if (cache && Date.now() - cache.at < TTL_MS) return cache.plans;

  let monthly: Awaited<ReturnType<typeof readOne>> = null;
  let yearly: Awaited<ReturnType<typeof readOne>> = null;
  try {
    [monthly, yearly] = await Promise.all([readOne('monthly'), readOne('yearly')]);
  } catch {
    return [];
  }
  const found = { monthly, yearly };
  const saving =
    monthly && yearly ? yearlySavingPercent(monthly.amountCents, yearly.amountCents, monthly.currency, yearly.currency) : null;

  const plans = PLANS.flatMap((plan): PlanPrice[] => {
    const price = found[plan];
    if (!price) return [];
    return [
      {
        plan,
        ...PLAN_WORDS[plan],
        amountCents: price.amountCents,
        currency: price.currency,
        formatted: formatPrice(price.amountCents, price.currency),
        savingPercent: plan === 'yearly' ? saving : null,
      },
    ];
  });
  cache = { at: Date.now(), plans };
  return plans;
};
