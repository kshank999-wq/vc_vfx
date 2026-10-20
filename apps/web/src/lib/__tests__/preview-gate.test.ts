import { describe, expect, it } from 'vitest';
import { previewContentSecurityPolicy, previewRoute, previewSignIn } from '../preview-gate';

describe('the browser preview route', () => {
  it('serves the page at every spelling of /preview', () => {
    for (const path of ['/preview', '/preview/', '/preview/index.html']) {
      expect(previewRoute(path)).toEqual({ kind: 'page', to: '/preview/index.html' });
    }
  });

  it('treats the bundle’s files as assets and leaves other paths alone', () => {
    expect(previewRoute('/preview/assets/index-abc.js')).toEqual({ kind: 'asset' });
    expect(previewRoute('/previews')).toBeNull();
    expect(previewRoute('/')).toBeNull();
    expect(previewRoute('/admin')).toBeNull();
  });

  it('sends visitors to sign in and back', () => {
    expect(previewSignIn).toBe('/signin?next=%2Fpreview');
  });

  it('allows the bundle’s own scripts and no inline ones', () => {
    expect(previewContentSecurityPolicy).toContain("script-src 'self'");
    expect(previewContentSecurityPolicy).not.toMatch(/script-src[^;]*(unsafe-inline|nonce|unsafe-eval)/);
    expect(previewContentSecurityPolicy).toContain("frame-ancestors 'none'");
  });
});
