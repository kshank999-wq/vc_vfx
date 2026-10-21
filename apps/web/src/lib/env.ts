/**
 * Environment access.
 *
 * Every value is read lazily and fails loudly at the point of use rather than
 * at import time: a missing Stripe key must break checkout, not the marketing
 * pages or a build that has no secrets configured. The site is deployed before
 * Stripe keys exist, so the `has*` helpers let pages degrade instead of throw.
 */

import { AI_EFFORTS, DEFAULT_AI_EFFORT, DEFAULT_AI_MODEL, DEFAULT_MONTHLY_CREDITS, isAiModel, type AiEffort, type AiModel } from '@vcvfx/domain';

const read = (name: string): string | undefined => {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
};

const required = (name: string): string => {
  const value = read(name);
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
};

const optional = (name: string, fallback: string): string => read(name) ?? fallback;

export const DEFAULT_SITE_URL = 'https://vc-vfx.com';

/**
 * The site's origin with no trailing slash. Forgiving on purpose: it is read
 * at module scope by the root layout (`metadataBase`), so a malformed value
 * must not be able to fail the build. Anything that is not an absolute
 * http(s) URL falls back to production with a warning.
 */
export const resolveSiteUrl = (raw: string | undefined): string => {
  const value = raw?.trim();
  if (!value) return DEFAULT_SITE_URL;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    console.warn(`NEXT_PUBLIC_SITE_URL is not a URL (${JSON.stringify(value)}); using ${DEFAULT_SITE_URL}.`);
    return DEFAULT_SITE_URL;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    console.warn(`NEXT_PUBLIC_SITE_URL must be http(s); using ${DEFAULT_SITE_URL}.`);
    return DEFAULT_SITE_URL;
  }
  return parsed.href.replace(/\/+$/, '');
};

export const env = {
  get supabaseUrl(): string {
    return required('NEXT_PUBLIC_SUPABASE_URL');
  },
  get supabaseAnonKey(): string {
    return required('NEXT_PUBLIC_SUPABASE_ANON_KEY');
  },
  /** Server only. Bypasses row level security — never import into a client component. */
  get supabaseServiceRoleKey(): string {
    return required('SUPABASE_SERVICE_ROLE_KEY');
  },
  get stripeSecretKey(): string {
    return required('STRIPE_SECRET_KEY');
  },
  get stripeWebhookSecret(): string {
    return required('STRIPE_WEBHOOK_SECRET');
  },
  get stripeMonthlyPriceId(): string {
    return required('STRIPE_PRICE_ID_MONTHLY');
  },
  get stripeYearlyPriceId(): string {
    return required('STRIPE_PRICE_ID_YEARLY');
  },
  get resendApiKey(): string {
    return required('RESEND_API_KEY');
  },
  get resendFrom(): string {
    return optional('RESEND_FROM_ADDRESS', 'VC VFX <noreply@vc-vfx.com>');
  },
  get releaseBucket(): string {
    return optional('RELEASE_BUCKET', 'releases');
  },
  get releaseDownloadTtlSeconds(): number {
    const parsed = Number.parseInt(optional('RELEASE_DOWNLOAD_TTL_SECONDS', '900'), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 900;
  },
  get siteUrl(): string {
    return resolveSiteUrl(process.env['NEXT_PUBLIC_SITE_URL']);
  },
  /** Server only. The AI tracking assistant's Anthropic key (addendum 07). */
  get anthropicApiKey(): string {
    return required('ANTHROPIC_API_KEY');
  },
  /** The model the assistant calls: one of the domain's AI_MODELS; anything else falls back to the default. */
  get aiModel(): AiModel {
    const value = optional('AI_MODEL', DEFAULT_AI_MODEL);
    return isAiModel(value) ? value : DEFAULT_AI_MODEL;
  },
  get aiEffort(): AiEffort {
    const value = optional('AI_EFFORT', DEFAULT_AI_EFFORT);
    return (AI_EFFORTS as readonly string[]).includes(value) ? (value as AiEffort) : DEFAULT_AI_EFFORT;
  },
  /** Credits per account per calendar month (1 credit = $0.05 of model cost). */
  get aiMonthlyCredits(): number {
    const parsed = Number.parseFloat(optional('AI_MONTHLY_CREDITS', String(DEFAULT_MONTHLY_CREDITS)));
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MONTHLY_CREDITS;
  },
  /** Output tokens per call (thinking + reply), the cap on what the desktop may ask for. */
  get aiMaxOutputTokens(): number {
    const parsed = Number.parseInt(optional('AI_MAX_OUTPUT_TOKENS', '32000'), 10);
    return Number.isFinite(parsed) && parsed >= 1024 ? Math.min(parsed, 64_000) : 32_000;
  },
} as const;

/** The AI tracking assistant can work: accounts (licence, metering) and an Anthropic key. */
export const hasAi = (): boolean => hasSupabase() && Boolean(read('ANTHROPIC_API_KEY'));

/** Accounts can work: the public Supabase pair and the service key are set. */
export const hasSupabase = (): boolean =>
  Boolean(read('NEXT_PUBLIC_SUPABASE_URL') && read('NEXT_PUBLIC_SUPABASE_ANON_KEY') && read('SUPABASE_SERVICE_ROLE_KEY'));

/** Checkout can work: a secret key and both plan prices are set. */
export const hasStripe = (): boolean =>
  Boolean(read('STRIPE_SECRET_KEY') && read('STRIPE_PRICE_ID_MONTHLY') && read('STRIPE_PRICE_ID_YEARLY'));

export const SITE_NAME = 'VC VFX';
