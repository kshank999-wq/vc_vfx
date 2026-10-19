import type { Metadata, Viewport } from 'next';
import { env, SITE_NAME } from '@/lib/env';
import './globals.css';

const DESCRIPTION =
  'VC VFX turns the VCDIT handoff into a VFX shot queue, a printable prep list, verified image-sequence plates and documented shot packages for your artist or VFX house. Windows and macOS.';

export const metadata: Metadata = {
  metadataBase: new URL(env.siteUrl),
  title: {
    default: `${SITE_NAME} — VFX prep for independent productions`,
    template: `%s · ${SITE_NAME}`,
  },
  description: DESCRIPTION,
  applicationName: SITE_NAME,
  openGraph: {
    title: `${SITE_NAME} — VFX prep for independent productions`,
    description: DESCRIPTION,
    url: '/',
    siteName: SITE_NAME,
    type: 'website',
    locale: 'en_US',
  },
  twitter: {
    card: 'summary',
    title: `${SITE_NAME} — VFX prep for independent productions`,
    description: DESCRIPTION,
  },
  alternates: { canonical: '/' },
};

export const viewport: Viewport = {
  themeColor: '#0b0c10',
  colorScheme: 'dark',
  width: 'device-width',
  initialScale: 1,
};

/**
 * Every page renders per request: the content security policy carries a fresh
 * nonce on each response (middleware.ts), and a prerendered page would hold
 * HTML built before that nonce existed — `strict-dynamic` would then refuse
 * every script on it.
 */
export const dynamic = 'force-dynamic';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
