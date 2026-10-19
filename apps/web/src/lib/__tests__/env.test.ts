import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SITE_URL, env, hasStripe, hasSupabase, resolveSiteUrl } from '../env';

afterEach(() => vi.unstubAllEnvs());

describe('environment', () => {
  it('defaults the site URL and strips a trailing slash', () => {
    expect(resolveSiteUrl(undefined)).toBe(DEFAULT_SITE_URL);
    expect(resolveSiteUrl('https://staging.vc-vfx.com/')).toBe('https://staging.vc-vfx.com');
    expect(resolveSiteUrl('NEXT_PUBLIC_SITE_URL')).toBe(DEFAULT_SITE_URL);
    expect(resolveSiteUrl('ftp://vc-vfx.com')).toBe(DEFAULT_SITE_URL);
  });

  it('throws only at the point of use', () => {
    vi.stubEnv('STRIPE_SECRET_KEY', '');
    expect(() => env.stripeSecretKey).toThrow(/STRIPE_SECRET_KEY/);
  });

  it('reports whether accounts and checkout can work', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '');
    vi.stubEnv('STRIPE_SECRET_KEY', '');
    expect(hasSupabase()).toBe(false);
    expect(hasStripe()).toBe(false);

    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://x.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service');
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test');
    vi.stubEnv('STRIPE_PRICE_ID_MONTHLY', 'price_m');
    vi.stubEnv('STRIPE_PRICE_ID_YEARLY', 'price_y');
    expect(hasSupabase()).toBe(true);
    expect(hasStripe()).toBe(true);
  });

  it('has sane release defaults', () => {
    vi.stubEnv('RELEASE_BUCKET', '');
    vi.stubEnv('RELEASE_DOWNLOAD_TTL_SECONDS', 'nonsense');
    expect(env.releaseBucket).toBe('releases');
    expect(env.releaseDownloadTtlSeconds).toBe(900);
  });
});
