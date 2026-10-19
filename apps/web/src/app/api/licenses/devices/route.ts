import { z } from 'zod';
import { deactivateDevice, listDevices } from '@/lib/activation';
import { hasSupabase } from '@/lib/env';
import { json, notConfigured } from '@/lib/http';
import { adminClient, currentUser } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The computers using this account's seats, and the ones that used to. */
export async function GET(): Promise<Response> {
  if (!hasSupabase()) return notConfigured('accounts');
  const user = await currentUser();
  if (!user) return json({ error: 'Sign in to see your devices' }, 401);
  return json({ devices: await listDevices(user.id, adminClient()) });
}

const deleteSchema = z.object({ activationId: z.string().uuid() });

/** Free a seat — the lost or replaced computer flow, done by the customer. */
export async function DELETE(request: Request): Promise<Response> {
  if (!hasSupabase()) return notConfigured('accounts');
  const user = await currentUser();
  if (!user) return json({ error: 'Sign in to manage your devices' }, 401);

  const parsed = deleteSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: 'Which device?' }, 400);

  const result = await deactivateDevice({ userId: user.id, activationId: parsed.data.activationId }, adminClient());
  if (!result.ok) return json({ error: result.error }, 400);
  return json({ deactivated: true });
}
