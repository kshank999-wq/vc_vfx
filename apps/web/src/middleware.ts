import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { strayAuthRedirect } from '@/lib/auth-redirect';

/**
 * Refreshes the Supabase session cookie on navigation and sets a nonce-based
 * content security policy. Next reads the nonce back off the request's CSP
 * header and stamps it onto its own inline scripts; every page renders per
 * request (`dynamic = 'force-dynamic'` in the root layout) so the nonce in the
 * HTML and the one in the header are always the same.
 */
const contentSecurityPolicy = (nonce: string, dev: boolean, local: boolean): string => {
  const supabase = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const supabaseSocket = supabase.replace(/^https:/, 'wss:');
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    // React and Next set inline style attributes; there is no nonce for those.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self' ${supabase} ${supabaseSocket}`.trim(),
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "object-src 'none'",
    ...(local ? [] : ['upgrade-insecure-requests']),
  ].join('; ');
};

/**
 * Before launch the site shows a holding page to everyone except admins
 * (`profiles.is_admin`). Sign-in, the auth callback and the APIs stay open so
 * an admin can get in and the desktop app and Stripe keep working. Set
 * SITE_LAUNCHED=true in Vercel to open the site.
 */
const PRELAUNCH_OPEN = [/^\/coming-soon/, /^\/signin/, /^\/reset/, /^\/auth\//, /^\/api\//];
const launched = (): boolean => process.env.SITE_LAUNCHED?.trim() === 'true';

export async function middleware(request: NextRequest) {
  const stray = strayAuthRedirect(request.nextUrl);
  if (stray) return NextResponse.redirect(stray);

  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const local = request.nextUrl.hostname === 'localhost' || request.nextUrl.hostname === '127.0.0.1';
  const policy = contentSecurityPolicy(nonce, process.env.NODE_ENV !== 'production', local);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('content-security-policy', policy);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('content-security-policy', policy);

  const gated = !launched() && !PRELAUNCH_OPEN.some((re) => re.test(request.nextUrl.pathname));
  const holdingPage = (): NextResponse => {
    const rewrite = NextResponse.rewrite(new URL('/coming-soon', request.url), { request: { headers: requestHeaders } });
    rewrite.headers.set('content-security-policy', policy);
    for (const cookie of response.cookies.getAll()) rewrite.cookies.set(cookie);
    return rewrite;
  };

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  // A deployment without accounts yet has no admins to let through.
  if (!url || !anon) return gated ? holdingPage() : response;

  try {
    const supabase = createServerClient(url, anon, {
      cookies: {
        get: (name: string) => request.cookies.get(name)?.value,
        set: (name: string, value: string, options: CookieOptions) => {
          response.cookies.set({ name, value, ...options });
        },
        remove: (name: string, options: CookieOptions) => {
          response.cookies.set({ name, value: '', ...options });
        },
      },
    });
    const { data } = await supabase.auth.getUser();
    if (gated) {
      if (!data.user) return holdingPage();
      const { data: profile } = await supabase.from('profiles').select('is_admin').eq('id', data.user.id).maybeSingle();
      if (!profile?.is_admin) return holdingPage();
    }
  } catch {
    // A Supabase hiccup costs a refresh, never the page — but never opens the gate.
    if (gated) return holdingPage();
  }
  return response;
}

export const config = {
  // Everything except static assets and the Stripe webhook, which
  // authenticates with a signature rather than a session.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg|robots.txt|sitemap.xml|api/stripe).*)'],
};
