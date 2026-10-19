import { cookies, headers } from 'next/headers';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js';
import { env, hasSupabase } from './env';

/**
 * Two clients, deliberately distinct.
 *
 * `serverClient()` acts as the signed-in visitor (cookie) and is bound by row
 * level security. `adminClient()` uses the service role, bypasses RLS, and is
 * the only way orders, licences, activations and release rows are written.
 */

export const serverClient = () => {
  const cookieStore = cookies();
  return createServerClient(env.supabaseUrl, env.supabaseAnonKey, {
    cookies: {
      get(name: string) {
        return cookieStore.get(name)?.value;
      },
      set(name: string, value: string, options: CookieOptions) {
        try {
          cookieStore.set({ name, value, ...options });
        } catch {
          // Read-only in a Server Component; the middleware refreshes instead.
        }
      },
      remove(name: string, options: CookieOptions) {
        try {
          cookieStore.set({ name, value: '', ...options });
        } catch {
          // See above.
        }
      },
    },
  });
};

let cachedAdmin: SupabaseClient | null = null;

/** Service-role client. Never import this from a client component. */
export const adminClient = (): SupabaseClient => {
  if (!cachedAdmin) {
    cachedAdmin = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return cachedAdmin;
};

/** The bearer token a desktop app sent, if any. */
export const bearerFrom = (authorization: string | null | undefined): string | null => {
  const [scheme, token] = (authorization ?? '').trim().split(/\s+/);
  return scheme?.toLowerCase() === 'bearer' && token ? token : null;
};

/**
 * Who is calling: a desktop app with `Authorization: Bearer <access token>`,
 * or a browser with the session cookie. Null when neither, and null (never a
 * throw) when accounts are not configured on this deployment.
 */
export const currentUser = async (): Promise<User | null> => {
  if (!hasSupabase()) return null;
  try {
    let authorization: string | null = null;
    try {
      authorization = headers().get('authorization');
    } catch {
      authorization = null;
    }
    const token = bearerFrom(authorization);
    if (token) {
      const { data } = await adminClient().auth.getUser(token);
      return data.user ?? null;
    }
    const { data } = await serverClient().auth.getUser();
    return data.user ?? null;
  } catch {
    return null;
  }
};
