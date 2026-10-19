import { app, safeStorage } from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createClient, type Session, type SupabaseClient, type User } from '@supabase/supabase-js';
import type { AccountStatus } from '../shared/bridge';
import { SUPABASE_ANON_KEY, SUPABASE_URL, isCloudConfigured } from './config';

/**
 * Sign-in (email one-time code via Supabase). All of it lives in the main
 * process: the renderer never holds a token. The refresh token is encrypted
 * with the OS keychain (safeStorage) where one is available.
 */

export class CloudError extends Error {
  override name = 'CloudError';
}

export const NOT_CONFIGURED =
  'Sign-in is not available in this build (it was built without a Supabase project). VC VFX works fully offline in read-only mode: open, browse, verify and print.';

let client: SupabaseClient | null = null;

const supabase = (): SupabaseClient => {
  if (!isCloudConfigured()) throw new CloudError(NOT_CONFIGURED);
  client ??= createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: true, detectSessionInUrl: false },
  });
  return client;
};

const sessionPath = () => join(app.getPath('userData'), 'session.bin');

const storeSession = async (session: Session | null): Promise<void> => {
  await mkdir(app.getPath('userData'), { recursive: true });
  if (!session) {
    await writeFile(sessionPath(), '', 'utf8').catch(() => undefined);
    return;
  }
  const payload = JSON.stringify({ access_token: session.access_token, refresh_token: session.refresh_token });
  if (safeStorage.isEncryptionAvailable()) await writeFile(sessionPath(), safeStorage.encryptString(payload));
  else await writeFile(sessionPath(), `plain:${payload}`, 'utf8');
};

const readStoredSession = async (): Promise<{ access_token: string; refresh_token: string } | null> => {
  try {
    const raw = await readFile(sessionPath());
    if (raw.length === 0) return null;
    const text = raw.toString('utf8');
    const payload = text.startsWith('plain:') ? text.slice('plain:'.length) : safeStorage.decryptString(raw);
    return JSON.parse(payload) as { access_token: string; refresh_token: string };
  } catch {
    return null;
  }
};

const statusOf = (user: User | null | undefined): AccountStatus => {
  const meta = (user?.user_metadata ?? {}) as Record<string, unknown>;
  const name = [meta['full_name'], meta['name'], meta['display_name']].find((v): v is string => typeof v === 'string' && v.trim().length > 0);
  return { configured: true, signedIn: Boolean(user), email: user?.email ?? null, displayName: name?.trim() ?? null };
};

const signedOut: AccountStatus = { configured: false, signedIn: false, email: null, displayName: null };

export const restoreSession = async (): Promise<AccountStatus> => {
  if (!isCloudConfigured()) return signedOut;
  const stored = await readStoredSession();
  if (!stored) return statusOf(null);
  const { data, error } = await supabase().auth.setSession(stored);
  if (error || !data.session) return statusOf(null);
  await storeSession(data.session);
  // Keep the stored refresh token current as Supabase rotates it.
  supabase().auth.onAuthStateChange((_event, session) => void storeSession(session));
  return statusOf(data.session.user);
};

export const accountStatus = async (): Promise<AccountStatus> => {
  if (!isCloudConfigured()) return signedOut;
  const { data } = await supabase().auth.getSession();
  return statusOf(data.session?.user ?? null);
};

export const requestSignInCode = async (email: string): Promise<void> => {
  const { error } = await supabase().auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
  if (error) throw new CloudError(error.message);
};

export const verifySignInCode = async (email: string, token: string): Promise<AccountStatus> => {
  const { data, error } = await supabase().auth.verifyOtp({ email, token, type: 'email' });
  if (error) throw new CloudError(error.message);
  if (!data.session) throw new CloudError('That code was accepted but no session came back. Try again.');
  await storeSession(data.session);
  return statusOf(data.session.user);
};

export const signOut = async (): Promise<void> => {
  if (isCloudConfigured()) await supabase().auth.signOut().catch(() => undefined);
  await storeSession(null);
};

/** The signed-in session's access token, for the endpoints that need one. */
export const accessToken = async (): Promise<string> => {
  const { data, error } = await supabase().auth.getSession();
  if (error || !data.session) throw new CloudError('Sign in first (VC VFX › Account).');
  return data.session.access_token;
};
