/**
 * Where to send a request that landed on the wrong page carrying Supabase auth
 * parameters. If the redirect allow-list refuses `/auth/callback`, Supabase
 * falls back to the bare Site URL and the visitor arrives at `/?code=…`; this
 * forwards the code to the callback. Pure so it can be tested; the middleware
 * calls it.
 */
export const CALLBACK_PATH = '/auth/callback';

export const strayAuthRedirect = (url: URL): URL | null => {
  const { pathname, searchParams } = url;
  if (pathname === CALLBACK_PATH || pathname.startsWith('/api/')) return null;

  const code = searchParams.get('code');
  if (code) {
    const remaining = new URLSearchParams(searchParams);
    remaining.delete('code');
    const suffix = remaining.toString();
    const next = suffix.length > 0 ? `${pathname}?${suffix}` : pathname;
    const target = new URL(CALLBACK_PATH, url.origin);
    target.searchParams.set('code', code);
    target.searchParams.set('next', pathname === '/' ? '/account' : next);
    return target;
  }

  if (searchParams.has('error_code') || searchParams.get('error') === 'access_denied') {
    return new URL('/signin?error=link_expired', url.origin);
  }
  return null;
};

/** A `next` parameter is a path on this site and nothing else. */
export const safeNextPath = (value: string | null | undefined, fallback = '/account'): string =>
  value && value.startsWith('/') && !value.startsWith('//') && !value.includes('\\') ? value : fallback;
