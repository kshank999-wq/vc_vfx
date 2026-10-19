import { isPlan, PLANS, type SubscriptionPlan } from '@vcvfx/domain';

/**
 * Plan words and the plan → Stripe price mapping, with no Stripe client in
 * sight so it can be tested and imported anywhere. Figures never live here:
 * what a plan costs is whatever Stripe says.
 */

export interface PriceIds {
  monthly: string;
  yearly: string;
}

/** The Stripe price a plan is sold at. */
export const priceIdForPlan = (plan: SubscriptionPlan, ids: PriceIds): string =>
  plan === 'monthly' ? ids.monthly : ids.yearly;

/** The plan a request named, defaulting to monthly; null for an unknown word. */
export const planFromInput = (value: unknown): SubscriptionPlan | null => {
  if (value === undefined || value === null || value === '') return 'monthly';
  return typeof value === 'string' && isPlan(value) ? value : null;
};

/** Which plan a Stripe price id belongs to, or null if it is neither. */
export const planForPriceId = (priceId: string | null | undefined, ids: PriceIds): SubscriptionPlan | null => {
  if (!priceId) return null;
  return PLANS.find((plan) => priceIdForPlan(plan, ids) === priceId) ?? null;
};

export const PLAN_WORDS: Record<SubscriptionPlan, { label: string; per: string }> = {
  monthly: { label: 'Monthly', per: 'per month' },
  yearly: { label: 'Yearly', per: 'per year' },
};

export const formatPrice = (amountCents: number, currency: string): string => {
  const whole = amountCents % 100 === 0;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(amountCents / 100);
};

/** Whole percent saved by yearly against twelve months, or null if none / not comparable. */
export const yearlySavingPercent = (
  monthlyCents: number,
  yearlyCents: number,
  monthlyCurrency: string,
  yearlyCurrency: string,
): number | null => {
  if (monthlyCurrency.toLowerCase() !== yearlyCurrency.toLowerCase()) return null;
  const twelve = monthlyCents * 12;
  if (twelve <= 0 || yearlyCents >= twelve) return null;
  const percent = Math.floor(((twelve - yearlyCents) / twelve) * 100);
  return percent > 0 ? percent : null;
};
