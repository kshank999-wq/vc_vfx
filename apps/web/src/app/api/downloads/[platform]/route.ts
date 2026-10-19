import { canDownloadPlatform, isPlatform, type LicenseStatus, type Platform } from '@vcvfx/domain';
import { env, hasSupabase } from '@/lib/env';
import { json, notConfigured } from '@/lib/http';
import { adminClient, currentUser } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * A short-lived signed URL for the current stable build of one platform.
 * Bearer or cookie. Every request re-checks the licence, so a leaked link dies
 * within minutes and a revoked licence stops working at once.
 * → `{url, version, sha256, minimumOsVersion, expiresInSeconds}`
 */
export async function GET(_request: Request, { params }: { params: { platform: string } }): Promise<Response> {
  if (!isPlatform(params.platform)) return json({ error: 'Unknown platform' }, 404);
  const platform: Platform = params.platform;
  if (!hasSupabase()) return notConfigured('accounts');

  const user = await currentUser();
  if (!user) return json({ error: 'Sign in to download VC VFX' }, 401);

  const client = adminClient();
  const { data: licenses, error: licenseError } = await client
    .from('licenses')
    .select('status, expires_at, entitled_platforms')
    .eq('user_id', user.id);
  if (licenseError) return json({ error: 'Could not read your licences' }, 500);

  const now = new Date();
  const entitled = (licenses ?? []).some((row) =>
    canDownloadPlatform(
      {
        status: row.status as LicenseStatus,
        expiresAt: (row.expires_at as string | null) ?? null,
        entitledPlatforms: (row.entitled_platforms as Platform[] | null) ?? [],
      },
      platform,
      now,
    ),
  );
  if (!entitled) {
    return json({ error: `Your account does not have an active ${platform === 'windows' ? 'Windows' : 'macOS'} licence` }, 403);
  }

  const { data: build, error: buildError } = await client
    .from('release_builds')
    .select('version, artifact_key, sha256, minimum_os_version')
    .eq('platform', platform)
    .eq('channel', 'stable')
    .eq('active', true)
    .maybeSingle();
  if (buildError) return json({ error: 'Could not read the release catalogue' }, 500);
  if (!build) return json({ error: 'No published build for this platform yet' }, 404);

  const ttl = env.releaseDownloadTtlSeconds;
  const { data: signed, error: signError } = await client.storage
    .from(env.releaseBucket)
    .createSignedUrl(build.artifact_key as string, ttl, { download: true });
  if (signError || !signed) return json({ error: 'Could not prepare the download' }, 500);

  return json({
    url: signed.signedUrl,
    version: build.version,
    sha256: build.sha256,
    minimumOsVersion: build.minimum_os_version,
    expiresInSeconds: ttl,
  });
}
