-- Historical refreshes must not replace the live dashboard's current week.
create table if not exists public.vestaboard_fantasy_weeks (
  season text not null check (season ~ '^[0-9]{4}$'),
  week smallint not null check (week between 1 and 18),
  config_version uuid not null,
  leagues jsonb not null check (jsonb_typeof(leagues) = 'array' and jsonb_array_length(leagues) = 2),
  matchups jsonb not null check (jsonb_typeof(matchups) = 'array' and jsonb_array_length(matchups) = 2
    and jsonb_typeof(matchups->0) = 'object' and jsonb_typeof(matchups->1) = 'object'),
  last_checked_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (season, week)
);

comment on table public.vestaboard_fantasy_weeks is
  'One complete two-league snapshot per season/week, refreshed on demand. Independent of live board tracking.';
comment on column public.vestaboard_fantasy_weeks.config_version is
  'Snapshot version used to guard updates and backup/rebuild deletion against concurrent refreshes.';

alter table public.vestaboard_fantasy_weeks enable row level security;
revoke all on public.vestaboard_fantasy_weeks from public, anon, authenticated;
grant select, insert, update, delete on public.vestaboard_fantasy_weeks to service_role;
