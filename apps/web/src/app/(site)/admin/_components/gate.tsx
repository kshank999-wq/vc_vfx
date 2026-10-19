import Link from 'next/link';

/** What a non-administrator sees on any admin page. */
export function AdminGate({ title, next }: { title: string; next: string }) {
  return (
    <div className="page-hero">
      <h1>{title}</h1>
      <p>This area is for administrators.</p>
      <p style={{ marginTop: 24 }}>
        <Link href={`/signin?next=${encodeURIComponent(next)}`} className="button">
          Sign in
        </Link>
      </p>
    </div>
  );
}
