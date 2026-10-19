-- Move is_admin() out of the API-exposed public schema (Supabase advisor
-- 0029). The release_builds policy is its only caller; the website reads
-- profiles.is_admin directly, so nothing calls it over /rest/v1/rpc.

create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

create or replace function private.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select p.is_admin from public.profiles p where p.id = (select auth.uid())), false);
$$;

revoke execute on function private.is_admin() from public, anon;
grant execute on function private.is_admin() to authenticated;

alter policy "stable builds readable, all builds for admins" on public.release_builds
  using ((active and channel = 'stable') or (select private.is_admin()));

-- The old function is left in place but callable by no one; dropping it
-- timed out against the live project and buys nothing further.
revoke execute on function public.is_admin() from public, anon, authenticated;
