import type { AuthError } from '@supabase/supabase-js';

/** What the two password screens say, kept in one place so they agree. */
export const SHORTEST = 8;

export const checkNewPassword = (password: string, again: string): string | null => {
  if (password.length < SHORTEST) return `Use at least ${SHORTEST} characters.`;
  if (password !== again) return 'Those two do not match.';
  return null;
};

export const refusalFor = (failure: AuthError, credentials: string): string => {
  const code = failure.code ?? '';
  const said = failure.message.toLowerCase();
  if (code === 'same_password') return 'That is the password you already have.';
  if (code.startsWith('reauthentication')) {
    return 'For safety this account needs a fresh sign-in before the password changes. Sign out, sign back in, and try again.';
  }
  if (said.includes('current password') || said.includes('invalid login credentials')) return credentials;
  return failure.message;
};
