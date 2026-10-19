import { bestLicense, type LicenseStatus } from '@vcvfx/domain';
import { hasSupabase } from '@/lib/env';
import { json, notConfigured } from '@/lib/http';
import { sendLicenseReminder } from '@/lib/email';
import { adminClient, currentUser } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const COOLDOWN_MS = 5 * 60 * 1000;

/**
 * Send a customer their own licence again. No recipient field — it goes to the
 * account's address — and a short cooldown keeps it from flooding an inbox.
 */
export async function POST(): Promise<Response> {
  if (!hasSupabase()) return notConfigured('accounts');
  const user = await currentUser();
  if (!user?.email) return json({ error: 'Sign in to have your licence re-sent' }, 401);

  const client = adminClient();
  const { data: rows, error } = await client
    .from('licenses')
    .select('serial, status, expires_at')
    .eq('user_id', user.id)
    .neq('status', 'revoked');
  if (error) return json({ error: 'Your licence could not be read' }, 500);

  const license = bestLicense(
    (rows ?? []).map((r) => ({ serial: r.serial as string, status: r.status as LicenseStatus, expiresAt: r.expires_at as string | null })),
    new Date(),
  );
  if (!license) return json({ error: 'There is no licence on this account' }, 404);

  const { data: recent } = await client
    .from('email_events')
    .select('created_at')
    .eq('to_address', user.email)
    .like('template', 'license_reminder@%')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (recent?.created_at && Date.now() - Date.parse(recent.created_at as string) < COOLDOWN_MS) {
    return json({ error: 'A reminder was sent very recently. Check your inbox, then try again in a few minutes.' }, 429);
  }

  const result = await sendLicenseReminder({ to: user.email, serial: license.serial });
  if (!result.sent) return json({ error: result.error ?? 'The email could not be sent' }, 502);
  return json({ sent: true });
}
