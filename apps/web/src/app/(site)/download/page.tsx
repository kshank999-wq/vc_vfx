import type { Metadata } from 'next';
import Link from 'next/link';
import { bestLicense, canDownloadPlatform, isPlan, type LicenseStatus, type Platform } from '@vcvfx/domain';
import { hasStripe, hasSupabase } from '@/lib/env';
import { fetchPlanPrices } from '@/lib/pricing';
import { adminClient, currentUser } from '@/lib/supabase';
import { DownloadButton } from '../account/download-button';
import { PlatformChoice } from './platform-choice';

export const metadata: Metadata = {
  title: 'Download',
  description: 'Subscribe to VC VFX and download the Windows or macOS installer.',
};
export const dynamic = 'force-dynamic';

interface Build {
  platform: Platform;
  version: string;
  minimum_os_version: string | null;
}

const PLATFORM_NAME: Record<Platform, string> = { windows: 'Windows', macos: 'macOS' };

/** What the visitor already has: their live licence and the published builds. */
const readState = async (): Promise<{ signedIn: boolean; licensed: boolean; builds: Build[] }> => {
  if (!hasSupabase()) return { signedIn: false, licensed: false, builds: [] };
  try {
    const user = await currentUser();
    const client = adminClient();
    const { data: builds } = await client
      .from('release_builds')
      .select('platform, version, minimum_os_version')
      .eq('channel', 'stable')
      .eq('active', true);
    if (!user) return { signedIn: false, licensed: false, builds: (builds ?? []) as Build[] };

    const { data: rows } = await client
      .from('licenses')
      .select('status, expires_at, entitled_platforms')
      .eq('user_id', user.id);
    const licenses = (rows ?? []).map((r) => ({
      status: r.status as LicenseStatus,
      expiresAt: (r.expires_at as string | null) ?? null,
      entitledPlatforms: (r.entitled_platforms as Platform[]) ?? [],
    }));
    const best = bestLicense(licenses, new Date());
    const licensed = best ? canDownloadPlatform(best, 'windows', new Date()) || canDownloadPlatform(best, 'macos', new Date()) : false;
    return { signedIn: true, licensed, builds: (builds ?? []) as Build[] };
  } catch {
    return { signedIn: false, licensed: false, builds: [] };
  }
};

export default async function DownloadPage({ searchParams }: { searchParams: { plan?: string; cancelled?: string } }) {
  const [plans, state] = await Promise.all([fetchPlanPrices(), readState()]);
  const requested = searchParams.plan && isPlan(searchParams.plan) ? searchParams.plan : null;

  return (
    <div className="shell">
      <div className="page-hero">
        <span className="eyebrow">Download</span>
        <h1 style={{ marginTop: 14 }}>Get VC VFX</h1>
        <p>
          A subscription covers both Windows and macOS. Pick a plan and the platform you are installing on now — you
          can download the other at any time from your account.
        </p>
      </div>

      <div className="page-body">
        {searchParams.cancelled ? (
          <p className="notice" role="status" style={{ marginBottom: 24 }}>
            Checkout was cancelled. Nothing was charged.
          </p>
        ) : null}

        {state.licensed ? (
          <section>
            <p className="notice" style={{ marginBottom: 24 }}>
              Your account already has an active licence. Download straight from here or from{' '}
              <Link href="/account">your account</Link>.
            </p>
            {state.builds.length === 0 ? (
              <p className="lede">The first build has not been published yet. Your licence is ready for it.</p>
            ) : (
              <div className="grid">
                {state.builds.map((build) => (
                  <article key={build.platform} className="card">
                    <h3>{PLATFORM_NAME[build.platform]}</h3>
                    <p>
                      Version {build.version}
                      {build.minimum_os_version ? ` · requires ${build.minimum_os_version} or later` : ''}
                    </p>
                    <div style={{ marginTop: 16 }}>
                      <DownloadButton platform={build.platform} />
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        ) : (
          <PlatformChoice
            plans={plans.map(({ plan, label, per, formatted, savingPercent }) => ({ plan, label, per, formatted, savingPercent }))}
            initialPlan={requested}
            checkoutOpen={hasStripe() && plans.length > 0}
            signedIn={state.signedIn}
          />
        )}

        <section style={{ marginTop: 56 }}>
          <h2>Current builds</h2>
          {state.builds.length === 0 ? (
            <p className="lede">The first release is on its way. Subscribers are emailed when it is published.</p>
          ) : (
            <ul className="list">
              {state.builds.map((build) => (
                <li key={build.platform} className="card">
                  <strong>{PLATFORM_NAME[build.platform]}</strong> · version {build.version}
                  {build.minimum_os_version ? ` · requires ${build.minimum_os_version} or later` : ''}
                </li>
              ))}
            </ul>
          )}
          <p className="lede small" style={{ marginTop: 16 }}>
            Installers are delivered as short-lived signed links from your account, with a SHA-256 checksum for each
            build.
          </p>
        </section>
      </div>
    </div>
  );
}
