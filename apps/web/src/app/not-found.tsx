import Link from 'next/link';
import { SiteChrome } from './site-chrome';

export default function NotFound() {
  return (
    <SiteChrome>
      <div className="shell page-hero">
        <span className="eyebrow">404</span>
        <h1 style={{ marginTop: 14 }}>That shot is not in the queue.</h1>
        <p>The page you asked for does not exist.</p>
        <p style={{ marginTop: 24 }}>
          <Link href="/" className="button">
            Back to the home page
          </Link>
        </p>
      </div>
    </SiteChrome>
  );
}
