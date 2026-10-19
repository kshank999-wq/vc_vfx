import { describe, expect, it } from 'vitest';
import { safeNextPath, strayAuthRedirect } from '../auth-redirect';

describe('stray auth codes', () => {
  it('forwards a code on the home page to the callback, continuing to the account', () => {
    const target = strayAuthRedirect(new URL('https://vc-vfx.com/?code=abc'));
    expect(target?.pathname).toBe('/auth/callback');
    expect(target?.searchParams.get('code')).toBe('abc');
    expect(target?.searchParams.get('next')).toBe('/account');
  });

  it('leaves the callback and API routes alone', () => {
    expect(strayAuthRedirect(new URL('https://vc-vfx.com/auth/callback?code=abc'))).toBeNull();
    expect(strayAuthRedirect(new URL('https://vc-vfx.com/api/releases?code=abc'))).toBeNull();
  });

  it('sends an expired link to sign-in', () => {
    expect(strayAuthRedirect(new URL('https://vc-vfx.com/?error=access_denied&error_code=otp_expired'))?.pathname).toBe('/signin');
  });

  it('only continues to paths on this site', () => {
    expect(safeNextPath('/admin')).toBe('/admin');
    expect(safeNextPath('https://evil.example')).toBe('/account');
    expect(safeNextPath('//evil.example')).toBe('/account');
    expect(safeNextPath(null)).toBe('/account');
  });
});
