import { adminClient, currentUser } from './supabase';

/**
 * Who may manage releases: `profiles.is_admin`, checked on every request
 * rather than carried in a token, so revoking it takes effect immediately.
 */
export interface AdminIdentity {
  userId: string;
  email: string | null;
}

export const currentAdmin = async (): Promise<AdminIdentity | null> => {
  const user = await currentUser();
  if (!user) return null;
  try {
    const { data } = await adminClient().from('profiles').select('is_admin').eq('id', user.id).maybeSingle();
    if (!data?.is_admin) return null;
  } catch {
    return null;
  }
  return { userId: user.id, email: user.email ?? null };
};

/** Throws with a message suitable for a 403 body. */
export const requireAdmin = async (): Promise<AdminIdentity> => {
  const admin = await currentAdmin();
  if (!admin) throw new Error('This area is for administrators.');
  return admin;
};
