import { NextResponse } from 'next/server';

export const json = (body: unknown, status = 200): Response => NextResponse.json(body, { status });

/** 503 for a feature whose keys this deployment does not have yet. */
export const notConfigured = (what: 'accounts' | 'checkout'): Response =>
  json(
    {
      error:
        what === 'accounts'
          ? 'Accounts are not open yet on this deployment.'
          : 'Checkout is not open yet. Pricing is coming soon.',
    },
    503,
  );
