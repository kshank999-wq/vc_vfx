import { standingFor } from '@/lib/activation';
import { hasSupabase } from '@/lib/env';
import { json, notConfigured } from '@/lib/http';
import { adminClient, currentUser } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The account's licence standing, for the desktop to cache:
 * `{standing: {status, expiresAt} | null}`. Facts only — what a lapse means
 * is the domain's `capabilityFrom`, read on the machine.
 */
export async function GET(): Promise<Response> {
  if (!hasSupabase()) return notConfigured('accounts');
  const user = await currentUser();
  if (!user) return json({ error: 'Sign in to check your licence' }, 401);

  const { data, error } = await adminClient().from('licenses').select('status, expires_at').eq('user_id', user.id);
  if (error) return json({ error: 'The licence could not be read' }, 502);

  return json({ standing: standingFor((data ?? []) as Array<{ status: string; expires_at: string | null }>, new Date()) });
}
