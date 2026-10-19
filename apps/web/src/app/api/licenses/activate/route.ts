import { z } from 'zod';
import { PLATFORMS } from '@vcvfx/domain';
import { activateDevice } from '@/lib/activation';
import { hasSupabase } from '@/lib/env';
import { json, notConfigured } from '@/lib/http';
import { adminClient, currentUser } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  deviceFingerprint: z.string().min(8).max(200),
  deviceName: z.string().max(120).default(''),
  platform: z.enum(PLATFORMS),
  appVersion: z.string().max(40).default(''),
  serial: z.string().max(60).optional(),
});

/**
 * Activate this installation (desktop contract).
 *
 * `Authorization: Bearer <supabase access token>` or the session cookie.
 * Body `{deviceFingerprint, deviceName, platform, appVersion, serial?}`.
 * 200 `{outcome, license}` · 409 `{error, outcome}` · 401 · 400.
 * Without a serial the account's best live licence is used.
 */
export async function POST(request: Request): Promise<Response> {
  if (!hasSupabase()) return notConfigured('accounts');

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: 'A device fingerprint and platform are required' }, 400);

  const user = await currentUser();
  if (!user) return json({ error: 'Sign in to activate VC VFX' }, 401);

  const result = await activateDevice({ userId: user.id, ...parsed.data }, adminClient());
  return json(result.body, result.status);
}
