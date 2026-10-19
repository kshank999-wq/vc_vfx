import { hasSupabase } from '@/lib/env';
import { json } from '@/lib/http';
import { adminClient } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Release metadata for the desktop updater (public): active stable builds only,
 * and never a download URL — that comes from `/api/downloads/[platform]`.
 */
export async function GET(): Promise<Response> {
  if (!hasSupabase()) return json({ builds: [] });

  const { data, error } = await adminClient()
    .from('release_builds')
    .select('platform, version, minimum_os_version, release_notes, published_at, sha256, artifact_size_bytes')
    .eq('channel', 'stable')
    .eq('active', true);
  if (error) return json({ error: 'Could not read the release catalogue' }, 500);

  return json({
    builds: (data ?? []).map((build) => ({
      platform: build.platform,
      version: build.version,
      minimumOsVersion: build.minimum_os_version,
      releaseNotes: build.release_notes,
      publishedAt: build.published_at,
      sha256: build.sha256,
      sizeBytes: build.artifact_size_bytes,
    })),
  });
}
