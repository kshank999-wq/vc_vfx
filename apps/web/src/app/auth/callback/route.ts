import { NextResponse } from 'next/server';
import { safeNextPath } from '@/lib/auth-redirect';
import { hasSupabase } from '@/lib/env';
import { serverClient } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Exchanges a magic-link or reset code for a session cookie, then continues. */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const destination = safeNextPath(url.searchParams.get('next'));

  if (code && hasSupabase()) {
    const { error } = await serverClient().auth.exchangeCodeForSession(code);
    if (error) {
      // Spent, or opened in a different browser from the one that asked.
      const back = new URL('/signin', url.origin);
      back.searchParams.set('error', 'link_expired');
      back.searchParams.set('next', destination);
      return NextResponse.redirect(back);
    }
  }
  return NextResponse.redirect(new URL(destination, url.origin));
}
