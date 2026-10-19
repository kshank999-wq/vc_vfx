import { z } from 'zod';
import { PLATFORMS } from '@vcvfx/domain';
import { requireAdmin } from '@/lib/admin';
import { env, hasSupabase } from '@/lib/env';
import { json, notConfigured } from '@/lib/http';
import { adminClient } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Publishing a build. The installer goes from the admin's browser straight to
 * the private bucket with a signed upload URL (PUT), then the row is recorded
 * inactive (POST); making it live is a separate, deliberate PATCH. Windows and
 * macOS are independent throughout.
 */

const VERSION = z.string().min(1).max(40).regex(/^[\w.\-+]+$/, 'Version may only contain letters, digits, . - _ and +');

const uploadRequestSchema = z.object({
  platform: z.enum(PLATFORMS),
  version: VERSION,
  fileName: z.string().min(1).max(200),
});

const publishSchema = z.object({
  platform: z.enum(PLATFORMS),
  version: VERSION,
  channel: z.enum(['stable', 'beta', 'internal']).default('internal'),
  minimumOsVersion: z.string().max(40).default(''),
  releaseNotes: z.string().max(20_000).default(''),
  artifactKey: z.string().min(1).max(400),
  artifactSizeBytes: z.number().int().nonnegative().default(0),
  sha256: z.string().regex(/^[a-fA-F0-9]{64}$/, 'SHA-256 must be 64 hex characters'),
});

const forbidden = () => json({ error: 'This area is for administrators.' }, 403);

const gate = async (): Promise<{ userId: string } | Response> => {
  if (!hasSupabase()) return notConfigured('accounts');
  try {
    return await requireAdmin();
  } catch {
    return forbidden();
  }
};

/** Every build, newest first. */
export async function GET(): Promise<Response> {
  const admin = await gate();
  if (admin instanceof Response) return admin;

  const { data, error } = await adminClient()
    .from('release_builds')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) return json({ error: 'The release catalogue could not be read' }, 500);
  return json({ builds: data ?? [] });
}

/** Record a build whose artifact is already in the bucket. Never active on arrival. */
export async function POST(request: Request): Promise<Response> {
  const admin = await gate();
  if (admin instanceof Response) return admin;

  const parsed = publishSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: parsed.error.issues[0]?.message ?? 'Invalid build' }, 400);
  const build = parsed.data;

  const { data, error } = await adminClient()
    .from('release_builds')
    .upsert(
      {
        platform: build.platform,
        version: build.version,
        channel: build.channel,
        minimum_os_version: build.minimumOsVersion || null,
        release_notes: build.releaseNotes || null,
        artifact_key: build.artifactKey,
        artifact_size_bytes: build.artifactSizeBytes,
        sha256: build.sha256.toLowerCase(),
        active: false,
        created_by: admin.userId,
      },
      { onConflict: 'platform,channel,version' },
    )
    .select('id')
    .single();
  if (error || !data) return json({ error: error?.message ?? 'The build could not be recorded' }, 500);
  return json({ id: data.id });
}

/** A signed URL so the browser can upload the installer directly to storage. */
export async function PUT(request: Request): Promise<Response> {
  const admin = await gate();
  if (admin instanceof Response) return admin;

  const parsed = uploadRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: parsed.error.issues[0]?.message ?? 'Invalid upload' }, 400);

  const { platform, version, fileName } = parsed.data;
  const artifactKey = `${platform}/${version}/${fileName.replace(/[^\w.\-]+/g, '_')}`;
  const { data, error } = await adminClient()
    .storage.from(env.releaseBucket)
    .createSignedUploadUrl(artifactKey, { upsert: true });
  if (error || !data) return json({ error: error?.message ?? 'The upload could not be prepared' }, 500);

  return json({ artifactKey, signedUrl: data.signedUrl, token: data.token });
}
