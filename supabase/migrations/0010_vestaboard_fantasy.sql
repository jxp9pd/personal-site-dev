-- One shared dashboard. Only the gateway can read or write these records.
create table if not exists public.vestaboard_fantasy (
  id text primary key default 'default' check (id = 'default'),
  config_version uuid not null,
  leagues jsonb not null check (jsonb_typeof(leagues) = 'array' and jsonb_array_length(leagues) = 2),
  matchups jsonb not null default '[null, null]'::jsonb
    check (jsonb_typeof(matchups) = 'array' and jsonb_array_length(matchups) = 2),
  week smallint check (week between 1 and 18),
  season text check (season ~ '^[0-9]{4}$'),
  last_checked_at timestamptz,
  updated_at timestamptz not null default now(),
  check ((week is null) = (season is null)),
  check (week is not null or (matchups = '[null, null]'::jsonb and last_checked_at is null))
);

comment on table public.vestaboard_fantasy is
  'Saved league settings and latest Sleeper matchups. Active tracking, board ownership and alerts are transient.';
comment on column public.vestaboard_fantasy.config_version is
  'Replaced on every settings save; stale refreshes may only update their own configuration version.';

alter table public.vestaboard_fantasy enable row level security;
revoke all on public.vestaboard_fantasy from public, anon, authenticated;
grant select, insert, update on public.vestaboard_fantasy to service_role;
