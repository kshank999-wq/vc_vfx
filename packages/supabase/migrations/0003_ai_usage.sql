-- VC VFX: metering for the AI tracking assistant (docs/spec/addendum-07).
--
-- One row per model call vc-vfx.com makes on a customer's behalf, written by
-- the /api/ai/track-agent route with the service role after the call ends.
-- Cost is at Anthropic's list price (the price table is in
-- packages/domain/src/ai-usage.ts); 1 credit = US$0.05 of cost. The monthly
-- allowance is the sum of cost_usd since the first of the month (UTC):
--
--   select coalesce(sum(cost_usd), 0) from public.ai_usage
--   where user_id = $1 and created_at >= date_trunc('month', now() at time zone 'utc') at time zone 'utc';
--
-- served by ai_usage_user_created_idx. Customers may read their own rows;
-- nobody but the service role writes.

create table public.ai_usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  license_id uuid references public.licenses (id) on delete set null,
  created_at timestamptz not null default now(),
  model text not null,
  input_tokens integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  cache_read_tokens integer not null default 0 check (cache_read_tokens >= 0),
  cache_write_tokens integer not null default 0 check (cache_write_tokens >= 0),
  cost_usd numeric(10, 4) not null default 0 check (cost_usd >= 0),
  shot_ref text check (shot_ref is null or length(shot_ref) <= 200),
  session_id text check (session_id is null or length(session_id) <= 100)
);

create index ai_usage_user_created_idx on public.ai_usage (user_id, created_at desc);
-- Covers the foreign key (advisor 0001, unindexed foreign keys).
create index ai_usage_license_idx on public.ai_usage (license_id);

alter table public.ai_usage enable row level security;

create policy "own ai usage readable" on public.ai_usage
  for select to authenticated using (user_id = (select auth.uid()));

-- No insert, update or delete policy: only the service role (which bypasses
-- RLS) records usage. Belt and braces against a future permissive policy:
revoke insert, update, delete, truncate on public.ai_usage from anon, authenticated;
revoke all on public.ai_usage from anon;
