'use client';

import { createBrowserClient } from '@supabase/ssr';

/** Browser client. Anon key only, so it is bound by row level security. */
export const browserClient = () =>
  createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '', process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '');

/** Inlined at build time, so a client component can say accounts are closed. */
export const accountsOpen = (): boolean =>
  Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
