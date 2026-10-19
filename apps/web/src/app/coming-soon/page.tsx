import type { Metadata } from 'next';
import Link from 'next/link';
import { Mark } from '../wordmark';

export const metadata: Metadata = {
  title: 'VC VFX — coming soon',
  robots: { index: false, follow: false },
};

/** The holding page shown to everyone but admins until SITE_LAUNCHED=true. */
export default function ComingSoon() {
  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        padding: '24px 16px',
        textAlign: 'center',
      }}
    >
      <div style={{ maxWidth: 520 }}>
        <div style={{ marginBottom: 24 }}>
          <Mark size={48} />
        </div>
        <h1 style={{ fontSize: 'clamp(28px, 6vw, 44px)', lineHeight: 1.1, margin: '0 0 16px' }}>VC VFX is coming soon.</h1>
        <p style={{ color: 'var(--muted)', fontSize: 17, lineHeight: 1.55, margin: '0 0 28px' }}>
          VFX preparation and handoff for independent productions — the companion to{' '}
          <a href="https://vc-dit.com">VCDIT</a>.
        </p>
        <Link href="/signin" style={{ color: 'var(--faint)', fontSize: 13 }}>
          Team sign-in
        </Link>
      </div>
    </main>
  );
}
