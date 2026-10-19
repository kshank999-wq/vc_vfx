import Link from 'next/link';

/** Shared admin sub-navigation. Each page checks access for itself. */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="shell">
      <nav className="subnav" aria-label="Admin">
        <Link href="/admin">Overview</Link>
        <Link href="/admin/releases">Releases</Link>
      </nav>
      {children}
    </div>
  );
}
