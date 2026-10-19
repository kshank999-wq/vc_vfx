import Link from 'next/link';
import { currentAdmin } from '@/lib/admin';
import { SITE_NAME } from '@/lib/env';
import { Wordmark } from './wordmark';

/** Whether to show the Admin link. Never allowed to fail the layout. */
const isAdminVisitor = async (): Promise<boolean> => {
  try {
    return (await currentAdmin()) !== null;
  } catch {
    return false;
  }
};

const LINKS = [
  { href: '/#workflow', label: 'How it works' },
  { href: '/#roadmap', label: 'Roadmap' },
  { href: '/#pricing', label: 'Pricing' },
  { href: '/#faq', label: 'FAQ' },
  { href: '/account', label: 'Account' },
];

export async function SiteChrome({ children }: { children: React.ReactNode }) {
  const admin = await isAdminVisitor();
  const links = admin ? [...LINKS, { href: '/admin', label: 'Admin' }] : LINKS;

  return (
    <>
      <header className="site-header">
        <div className="shell">
          <Link href="/" className="wordmark" aria-label="VC VFX home">
            <Wordmark />
          </Link>
          <nav className="nav-links" aria-label="Main">
            {links.map((link) => (
              <Link key={link.href} href={link.href}>
                {link.label}
              </Link>
            ))}
          </nav>
          <div className="nav-cta">
            <Link href="/download" className="button small">
              Download
            </Link>
            <details className="mobile-menu">
              <summary aria-label="Menu">Menu</summary>
              <nav aria-label="Main">
                {links.map((link) => (
                  <Link key={link.href} href={link.href}>
                    {link.label}
                  </Link>
                ))}
              </nav>
            </details>
          </div>
        </div>
      </header>
      <main>{children}</main>
      <footer className="site-footer">
        <div className="shell">
          <span>
            © {new Date().getFullYear()} {SITE_NAME}. Windows and macOS.
          </span>
          <nav aria-label="Footer">
            <Link href="/privacy">Privacy</Link>
            <Link href="/terms">Terms</Link>
            <Link href="/account">Account</Link>
            <a href="https://vc-dit.com">VCDIT</a>
          </nav>
        </div>
      </footer>
    </>
  );
}
