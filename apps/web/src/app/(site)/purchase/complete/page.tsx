import type { Metadata } from 'next';
import Link from 'next/link';
import { hasStripe, hasSupabase } from '@/lib/env';
import { parsePlatform } from '@/lib/fulfillment';
import { stripe } from '@/lib/stripe';
import { adminClient, currentUser } from '@/lib/supabase';
import { DownloadButton } from '../../account/download-button';

export const metadata: Metadata = { title: 'Subscription complete', robots: { index: false } };
export const dynamic = 'force-dynamic';

/**
 * The post-checkout screen. The licence is issued by the webhook, which may
 * land a moment after the redirect, so this reads what exists and says so
 * plainly when it is still on its way. It never shows a licence the server
 * has not issued.
 */
export default async function PurchaseCompletePage({ searchParams }: { searchParams: { session_id?: string } }) {
  const sessionId = searchParams.session_id;
  const fallback = (
    <div className="shell">
      <div className="page-hero">
        <h1>Thank you</h1>
        <p>
          If your payment went through, your licence is on your account. <Link href="/account">Go to my account</Link>.
        </p>
      </div>
    </div>
  );
  if (!sessionId || !hasStripe() || !hasSupabase()) return fallback;

  const session = await stripe()
    .checkout.sessions.retrieve(sessionId)
    .catch(() => null);
  if (!session) return fallback;

  const platform = parsePlatform(session.metadata?.['platform']);
  const email = session.customer_details?.email ?? session.customer_email ?? null;

  const client = adminClient();
  const { data: order } = await client.from('orders').select('id').eq('stripe_checkout_session_id', sessionId).maybeSingle();
  const { data: license } = order
    ? await client.from('licenses').select('serial').eq('order_id', order.id).maybeSingle()
    : { data: null };

  const user = await currentUser();
  const signedInAsBuyer = Boolean(user && email && user.email?.toLowerCase() === email.toLowerCase());

  return (
    <div className="shell">
      <div className="page-hero">
        <span className="eyebrow">Subscription complete</span>
        <h1 style={{ marginTop: 14 }}>Welcome to VC VFX</h1>
        <p>Your licence and a sign-in link have been emailed to {email ?? 'your address'}.</p>
      </div>
      <div className="page-body">
        <section>
          {license ? (
            <div className="card">
              <span className="lede small">Your licence</span>
              <p className="serial" style={{ marginTop: 6 }}>
                {license.serial}
              </p>
            </div>
          ) : (
            <p className="notice">
              Your payment went through. The licence is being issued now — refresh this page in a moment, or open{' '}
              <Link href="/account">your account</Link>, where it will appear.
            </p>
          )}
        </section>

        {license && platform ? (
          <section>
            <h2>Download for {platform === 'windows' ? 'Windows' : 'macOS'}</h2>
            {signedInAsBuyer ? (
              <DownloadButton platform={platform} />
            ) : (
              <p className="lede">
                <Link href="/signin?next=/account">Sign in</Link> with {email ?? 'the address you paid with'} to
                download. Choose “Email me a link” — no password needed.
              </p>
            )}
          </section>
        ) : null}

        <section>
          <p className="lede">
            Then sign in to the VC VFX app with the same account and it activates itself. You can download either
            platform at any time from your account.
          </p>
          <p style={{ marginTop: 18 }}>
            <Link href="/account" className="button secondary">
              Go to my account
            </Link>
          </p>
        </section>
      </div>
    </div>
  );
}
