import { z } from 'zod';
import { PLANS, PLATFORMS } from '@vcvfx/domain';
import { env, hasStripe } from '@/lib/env';
import { json, notConfigured } from '@/lib/http';
import { priceIdFor } from '@/lib/pricing';
import { stripe } from '@/lib/stripe';
import { currentUser } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  platform: z.enum(PLATFORMS),
  plan: z.enum(PLANS).default('monthly'),
  email: z.string().email().optional(),
});

/**
 * Start a Stripe Checkout subscription. The client names a plan word and a
 * platform; the price is the server's to choose. Nothing is granted here —
 * the licence is issued by the webhook once Stripe confirms payment.
 */
export async function POST(request: Request): Promise<Response> {
  if (!hasStripe()) return notConfigured('checkout');

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: 'A platform ("windows" or "macos") and a plan are required' }, 400);
  const { platform, plan } = parsed.data;

  const user = await currentUser();
  const email = user?.email ?? parsed.data.email;

  try {
    const session = await stripe().checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceIdFor(plan), quantity: 1 }],
      success_url: `${env.siteUrl}/purchase/complete?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${env.siteUrl}/download?cancelled=1`,
      ...(email ? { customer_email: email } : {}),
      metadata: { platform, supabase_user_id: user?.id ?? '', plan },
      subscription_data: { metadata: { kind: 'desktop', supabase_user_id: user?.id ?? '', plan } },
      allow_promotion_codes: true,
      automatic_tax: { enabled: true },
      // A subscription is re-taxed at each renewal from the Customer's saved
      // address, so the address is required rather than inferred.
      billing_address_collection: 'required',
    });
    if (!session.url) return json({ error: 'Stripe did not return a checkout URL' }, 502);
    return json({ url: session.url });
  } catch (cause) {
    return json({ error: cause instanceof Error ? cause.message : 'Checkout could not be started' }, 500);
  }
}
