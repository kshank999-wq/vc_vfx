-- VC VFX: accounts, commerce, licences, device activations and releases.
--
-- Same model as VC Writer. Customers read their own rows through RLS; every
-- write goes through the service role from vc-vfx.com's API routes (the
-- Stripe webhook, activation, admin). Webhook and email logs have no
-- policies at all, so only the service role can see them.

create type public.platform as enum ('windows', 'macos');
create type public.order_status as enum ('pending', 'paid', 'refunded', 'failed', 'disputed');
create type public.license_status as enum ('active', 'suspended', 'revoked', 'expired');
create type public.release_channel as enum ('stable', 'beta', 'internal');

-- ---------------------------------------------------------------------------
-- Profiles
-- ---------------------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  display_name text,
  is_admin boolean not null default false,
  marketing_opt_in boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index profiles_email_lower_idx on public.profiles (lower(email));

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1)))
  on conflict (id) do update set email = excluded.email, updated_at = now();
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert or update of email on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select p.is_admin from public.profiles p where p.id = (select auth.uid())), false);
$$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- ---------------------------------------------------------------------------
-- Orders and licences
-- ---------------------------------------------------------------------------

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users (id) on delete set null,
  status public.order_status not null default 'pending',
  plan text not null check (plan in ('monthly', 'yearly')),
  selected_platform public.platform,
  amount_cents integer,
  currency text,
  stripe_checkout_session_id text unique,
  stripe_payment_intent_id text,
  stripe_customer_id text,
  stripe_subscription_id text,
  paid_at timestamptz,
  created_at timestamptz not null default now()
);
create index orders_user_idx on public.orders (user_id);
create index orders_payment_intent_idx on public.orders (stripe_payment_intent_id);

create table public.licenses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  order_id uuid unique references public.orders (id) on delete set null,
  serial text not null unique,
  status public.license_status not null default 'active',
  entitled_platforms public.platform[] not null default array['windows', 'macos']::public.platform[],
  max_activations integer not null default 2 check (max_activations > 0),
  expires_at timestamptz,
  stripe_subscription_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index licenses_user_idx on public.licenses (user_id);
create index licenses_subscription_idx on public.licenses (stripe_subscription_id);

create table public.device_activations (
  id uuid primary key default gen_random_uuid(),
  license_id uuid not null references public.licenses (id) on delete cascade,
  device_fingerprint text not null,
  device_name text not null default '',
  platform public.platform not null,
  app_version text,
  activated_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  deactivated_at timestamptz,
  unique (license_id, device_fingerprint)
);

-- ---------------------------------------------------------------------------
-- Releases
-- ---------------------------------------------------------------------------

create table public.release_builds (
  id uuid primary key default gen_random_uuid(),
  platform public.platform not null,
  version text not null,
  channel public.release_channel not null default 'stable',
  minimum_os_version text,
  artifact_key text not null,
  artifact_size_bytes bigint,
  sha256 text not null,
  release_notes text,
  active boolean not null default false,
  published_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (platform, channel, version)
);
create unique index release_builds_one_active_idx on public.release_builds (platform, channel) where active;
create index release_builds_created_by_idx on public.release_builds (created_by);

-- ---------------------------------------------------------------------------
-- Service-role-only logs
-- ---------------------------------------------------------------------------

create table public.stripe_webhook_events (
  id text primary key,
  type text not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  error text
);

create table public.email_events (
  id uuid primary key default gen_random_uuid(),
  to_address text not null,
  template text not null,
  status text not null,
  provider_message_id text,
  error text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.orders enable row level security;
alter table public.licenses enable row level security;
alter table public.device_activations enable row level security;
alter table public.release_builds enable row level security;
alter table public.stripe_webhook_events enable row level security;
alter table public.email_events enable row level security;

create policy "own profile readable" on public.profiles
  for select to authenticated using (id = (select auth.uid()));
create policy "own profile name editable" on public.profiles
  for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));
-- A customer may rename themselves but never grant themselves admin.
revoke update on public.profiles from authenticated;
grant update (display_name, marketing_opt_in) on public.profiles to authenticated;

create policy "own orders readable" on public.orders
  for select to authenticated using (user_id = (select auth.uid()));

create policy "own licenses readable" on public.licenses
  for select to authenticated using (user_id = (select auth.uid()));

create policy "own activations readable" on public.device_activations
  for select to authenticated using (
    exists (select 1 from public.licenses l where l.id = license_id and l.user_id = (select auth.uid()))
  );

create policy "stable builds readable, all builds for admins" on public.release_builds
  for select to authenticated using ((active and channel = 'stable') or (select public.is_admin()));

-- ---------------------------------------------------------------------------
-- Storage: private bucket for installers, handed out as signed URLs only.
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('releases', 'releases', false)
on conflict (id) do nothing;
