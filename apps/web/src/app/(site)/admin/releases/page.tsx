import type { Metadata } from 'next';
import { currentAdmin } from '@/lib/admin';
import { adminClient } from '@/lib/supabase';
import { AdminGate } from '../_components/gate';
import { ReleaseManager, type ReleaseBuildRow } from './release-manager';

export const metadata: Metadata = { title: 'Releases', robots: { index: false } };
export const dynamic = 'force-dynamic';

export default async function ReleasesPage() {
  const admin = await currentAdmin();
  if (!admin) return <AdminGate title="Releases" next="/admin/releases" />;

  const { data } = await adminClient()
    .from('release_builds')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(100);

  return (
    <>
      <div className="page-hero">
        <h1>Releases</h1>
        <p>Windows and macOS are published independently — making one live never touches the other.</p>
      </div>
      <div className="page-body">
        <ReleaseManager initialBuilds={(data ?? []) as ReleaseBuildRow[]} />
      </div>
    </>
  );
}
