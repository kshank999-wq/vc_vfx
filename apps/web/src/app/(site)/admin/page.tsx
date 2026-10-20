import type { Metadata } from 'next';
import Link from 'next/link';
import { currentAdmin } from '@/lib/admin';
import { adminClient } from '@/lib/supabase';
import { AdminGate } from './_components/gate';

export const metadata: Metadata = { title: 'Admin', robots: { index: false } };
export const dynamic = 'force-dynamic';

/** Row count, optionally `column = value` (or `column is null` when value is null). */
const count = async (table: string, column?: string, value?: string | boolean | null): Promise<number | null> => {
  const base = adminClient().from(table).select('*', { count: 'exact', head: true });
  const query = column === undefined ? base : value === null ? base.is(column, null) : base.eq(column, value as string | boolean);
  const { count: n, error } = await query;
  return error ? null : n ?? 0;
};

export default async function AdminOverviewPage() {
  const admin = await currentAdmin();
  if (!admin) return <AdminGate title="Admin" next="/admin" />;

  const [paidOrders, allOrders, activeLicenses, allLicenses, activeSeats, liveBuilds, failedEmails] = await Promise.all([
    count('orders', 'status', 'paid'),
    count('orders'),
    count('licenses', 'status', 'active'),
    count('licenses'),
    count('device_activations', 'deactivated_at', null),
    count('release_builds', 'active', true),
    count('email_events', 'status', 'failed'),
  ]);

  const tiles = [
    { label: 'Paid orders', value: paidOrders, of: allOrders },
    { label: 'Active licences', value: activeLicenses, of: allLicenses },
    { label: 'Active computers', value: activeSeats, of: null },
    { label: 'Live builds', value: liveBuilds, of: null },
    { label: 'Failed emails', value: failedEmails, of: null },
  ];

  return (
    <>
      <div className="page-hero">
        <h1>Overview</h1>
        <p>Signed in as {admin.email ?? 'an administrator'}. Money lives in Stripe; licences and releases live here.</p>
      </div>
      <div className="page-body">
        <div className="grid">
          {tiles.map((tile) => (
            <article key={tile.label} className="card">
              <span className="lede small">{tile.label}</span>
              <div className="stat">{tile.value ?? '—'}</div>
              {tile.of !== null ? <span className="field-note">of {tile.of ?? '—'} total</span> : null}
            </article>
          ))}
        </div>
        <p className="lede" style={{ marginTop: 32 }}>
          <Link href="/admin/releases">Manage release builds →</Link>
        </p>
        <p className="lede">
          {/* A static page outside the app router, so a plain link: a full navigation. */}
          <a href="/preview">Preview the app →</a>
          <span className="field-note"> The desktop interface in this browser, built from this deployment, with the sample project open.</span>
        </p>
      </div>
    </>
  );
}
