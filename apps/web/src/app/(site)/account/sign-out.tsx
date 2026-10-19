'use client';

import { browserClient } from '@/lib/supabase-browser';

export function SignOut() {
  return (
    <button
      type="button"
      className="button secondary small"
      onClick={async () => {
        await browserClient().auth.signOut();
        window.location.assign('/');
      }}
    >
      Sign out
    </button>
  );
}
