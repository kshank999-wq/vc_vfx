import { env, hasStripe, hasSupabase } from '@/lib/env';
import { json, notConfigured } from '@/lib/http';
import { stripe } from '@/lib/stripe';
import { adminClient, currentUser } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * A Stripe customer-portal session for the signed-in customer: change plan,
 * update the card, see invoices, cancel. The customer id is read from their
 * own orders — never taken from the request.
 */
export async function POST(): Promise<Response> {
  if (!hasSupabase()) return notConfigured('accounts');
  if (!hasStripe()) return notConfigured('checkout');
  const user = await currentUser();
  if (!user) return json({ error: 'Sign in to manage your subscription' }, 401);

  const { data: order } = await adminClient()
    .from('orders')
    .select('stripe_customer_id')
    .eq('user_id', user.id)
    .not('stripe_customer_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const customer = order?.stripe_customer_id as string | undefined;
  if (!customer) return json({ error: 'There is no subscription on this account yet' }, 404);

  try {
    const session = await stripe().billingPortal.sessions.create({ customer, return_url: `${env.siteUrl}/account` });
    return json({ url: session.url });
  } catch (cause) {
    return json({ error: cause instanceof Error ? cause.message : 'The billing portal could not be opened' }, 502);
  }
}
