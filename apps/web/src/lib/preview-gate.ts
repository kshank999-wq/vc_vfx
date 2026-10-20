/**
 * The browser preview at /preview (docs/deployment.md, "Browser preview"):
 * the desktop renderer built for a browser and copied under public/preview at
 * deploy time. Administrators only — before launch and after it.
 *
 * The page gets a policy that suits a Vite bundle rather than the site's
 * nonce one: the bundle has no inline script for a nonce to bless.
 */

export type PreviewRoute = { kind: 'page'; to: string } | { kind: 'asset' } | null;

/**
 * What the middleware should do with a path, before any question of who is
 * asking. The page is served at the bare `/preview`: Next strips a trailing
 * slash before the middleware runs, so a redirect *to* the slash form would
 * loop. The bundle's asset paths are absolute (`/preview/assets/…`, Vite's
 * `base`), so the page does not care which form it was reached by.
 */
export const previewRoute = (pathname: string): PreviewRoute => {
  if (pathname === '/preview' || pathname === '/preview/' || pathname === '/preview/index.html') {
    return { kind: 'page', to: '/preview/index.html' };
  }
  if (pathname.startsWith('/preview/')) return { kind: 'asset' };
  return null;
};

/** Where an anonymous or non-admin visitor is sent instead. */
export const previewSignIn = '/signin?next=%2Fpreview';

/**
 * The bundle loads its own script and stylesheet from /preview/assets and
 * needs nothing else: no cloud, no third parties, no inline scripts. The
 * print window is opened by script, is same-origin, and carries no script.
 */
export const previewContentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
].join('; ');
