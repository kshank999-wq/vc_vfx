import { z } from 'zod';
import { requireAdmin } from '@/lib/admin';
import { hasSupabase } from '@/lib/env';
import { json, notConfigured } from '@/lib/http';
import { adminClient } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const patchSchema = z.object({
  active: z.boolean().optional(),
  releaseNotes: z.string().max(20_000).optional(),
  minimumOsVersion: z.string().max(40).optional(),
  channel: z.enum(['stable', 'beta', 'internal']).optional(),
});

/**
 * Make one build live, or retire it. Making one live retires the build it
 * replaces for that platform and channel only — the partial unique index says
 * the same, so the two cannot disagree.
 */
export async function PATCH(request: Request, { params }: { params: { id: string } }): Promise<Response> {
  if (!hasSupabase()) return notConfigured('accounts');
  try {
    await requireAdmin();
  } catch {
    return json({ error: 'This area is for administrators.' }, 403);
  }

  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: 'Nothing valid to change' }, 400);

  const client = adminClient();
  const { data: build, error: readError } = await client
    .from('release_builds')
    .select('id, platform, channel')
    .eq('id', params.id)
    .maybeSingle();
  if (readError) return json({ error: 'That build could not be read' }, 500);
  if (!build) return json({ error: 'No such build' }, 404);

  const channel = parsed.data.channel ?? build.channel;
  if (parsed.data.active === true) {
    const { error: retireError } = await client
      .from('release_builds')
      .update({ active: false })
      .eq('platform', build.platform)
      .eq('channel', channel)
      .eq('active', true)
      .neq('id', params.id);
    if (retireError) return json({ error: 'The previous build could not be retired' }, 500);
  }

  const patch: Record<string, unknown> = {};
  if (parsed.data.active !== undefined) {
    patch['active'] = parsed.data.active;
    if (parsed.data.active) patch['published_at'] = new Date().toISOString();
  }
  if (parsed.data.releaseNotes !== undefined) patch['release_notes'] = parsed.data.releaseNotes;
  if (parsed.data.minimumOsVersion !== undefined) patch['minimum_os_version'] = parsed.data.minimumOsVersion;
  if (parsed.data.channel !== undefined) patch['channel'] = parsed.data.channel;

  const { error } = await client.from('release_builds').update(patch).eq('id', params.id);
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true });
}
