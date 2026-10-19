import type { Metadata } from 'next';
import Link from 'next/link';
import { licenseLive, type LicenseStatus, type Platform } from '@vcvfx/domain';
import { hasStripe, hasSupabase } from '@/lib/env';
import { formatPrice } from '@/lib/plans';
import { adminClient, currentUser } from '@/lib/supabase';
import { Devices } from './devices';
import { DownloadButton } from './download-button';
import { ManageSubscription } from './manage-subscription';
import { ResendLicense } from './resend-license';
import { SetPassword } from './set-password';
import { SignOut } from './sign-out';

export const metadata: Metadata = { title: 'My account', robots: { index: false } };
export const dynamic = 'force-dynamic';

const formatDate = (value: string | null): string =>
  value ? new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : '—';

const STATUS_WORDS: Record<LicenseStatus, string> = {
  active: 'Active',
  suspended: 'Suspended',
  revoked: 'Revoked',
  expired: 'Expired',
};

interface LicenseRow {
  serial: string;
  status: LicenseStatus;
  expires_at: string | null;
  max_activations: number;
  stripe_subscription_id: string | null;
}

interface BuildRow {
  platform: Platform;
  version: string;
  minimum_os_version: string | null;
}

export default async function AccountPage() {
  if (!hasSupabase()) {
    return (
      <div className="shell">
        <div className="page-hero">
          <h1>My account</h1>
          <p>Accounts are not open yet. They open with the first release — check back soon.</p>
        </div>
      </div>
    );
  }

  const user = await currentUser();
  if (!user) {
    return (
      <div className="shell">
        <div className="page-hero">
          <h1>My account</h1>
          <p>Sign in to see your licence, downloads and computers.</p>
          <p style={{ marginTop: 24 }}>
            <Link href="/signin?next=/account" className="button">
              Sign in
            </Link>
          </p>
        </div>
      </div>
    );
  }

  const client = adminClient();
  const [{ data: licenseRows }, { data: buildRows }, { data: orders }, { data: profile }] = await Promise.all([
    client
      .from('licenses')
      .select('serial, status, expires_at, max_activations, stripe_subscription_id')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false }),
    client.from('release_builds').select('platform, version, minimum_os_version').eq('channel', 'stable').eq('active', true),
    client
      .from('orders')
      .select('id, status, plan, amount_cents, currency, paid_at, created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(20),
    client.from('profiles').select('is_admin').eq('id', user.id).maybeSingle(),
  ]);

  const now = new Date();
  const licenses = (licenseRows ?? []) as LicenseRow[];
  const builds = (buildRows ?? []) as BuildRow[];
  const live = licenses.filter((l) => licenseLive({ status: l.status, expiresAt: l.expires_at }, now));
  const hasOrders = (orders ?? []).length > 0;

  return (
    <div className="shell">
      <div className="page-hero row" style={{ alignItems: 'flex-end' }}>
        <div>
          <h1>My account</h1>
          <p style={{ wordBreak: 'break-all' }}>{user.email}</p>
        </div>
        <SignOut />
      </div>

      <div className="page-body">
        <section>
          <h2>Licence</h2>
          {licenses.length === 0 ? (
            <p className="lede">
              No licence on this account yet. <Link href="/download">Subscribe to VC VFX</Link> to get one.
            </p>
          ) : (
            <div className="grid">
              {licenses.map((license) => {
                const isLive = licenseLive({ status: license.status, expiresAt: license.expires_at }, now);
                return (
                  <article key={license.serial} className="card">
                    <div className="row">
                      <span className={isLive ? 'badge ok' : 'badge warn'}>
                        {isLive ? 'Active' : license.status === 'active' ? 'Lapsed' : STATUS_WORDS[license.status]}
                      </span>
                    </div>
                    <p className="serial" style={{ marginTop: 14 }}>
                      {license.serial}
                    </p>
                    <dl className="kv">
                      <dt>Covers</dt>
                      <dd>Windows and macOS</dd>
                      <dt>Computers</dt>
                      <dd>Up to {license.max_activations}</dd>
                      <dt>{license.stripe_subscription_id ? (isLive ? 'Paid through' : 'Ended') : 'Expires'}</dt>
                      <dd>{license.expires_at ? formatDate(license.expires_at) : 'Never'}</dd>
                    </dl>
                  </article>
                );
              })}
            </div>
          )}
          {licenses.length > 0 || hasOrders ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 16 }}>
              {licenses.length > 0 ? <ResendLicense /> : null}
              {hasOrders && hasStripe() ? <ManageSubscription /> : null}
            </div>
          ) : null}
        </section>

        <section>
          <h2>Downloads</h2>
          {live.length === 0 ? (
            <p className="lede">Downloads appear here while you have an active licence.</p>
          ) : builds.length === 0 ? (
            <p className="lede">The first build has not been published yet. Your licence is ready for it.</p>
          ) : (
            <div className="grid">
              {builds.map((build) => (
                <article key={build.platform} className="card">
                  <h3>{build.platform === 'windows' ? 'Windows' : 'macOS'}</h3>
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

        {licenses.length > 0 ? (
          <section>
            <h2>Computers</h2>
            <Devices />
          </section>
        ) : null}

        {hasOrders ? (
          <section>
            <h2>Payments</h2>
            <ul className="list">
              {(orders ?? []).map((order) => (
                <li key={order.id as string} className="card row">
                  <div>
                    <strong>
                      {order.amount_cents !== null && order.currency
                        ? formatPrice(order.amount_cents as number, order.currency as string)
                        : '—'}
                    </strong>{' '}
                    <span className="muted">· {order.plan === 'yearly' ? 'Yearly' : 'Monthly'} subscription</span>
                    <p className="lede small">{formatDate((order.paid_at as string | null) ?? (order.created_at as string))}</p>
                  </div>
                  {order.status !== 'paid' ? <span className="badge warn">{order.status as string}</span> : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <SetPassword />

        {profile?.is_admin ? (
          <section>
            <h2>Administration</h2>
            <p className="lede">
              <Link href="/admin">Overview</Link> · <Link href="/admin/releases">Release builds</Link>
            </p>
          </section>
        ) : null}
      </div>
    </div>
  );
}
