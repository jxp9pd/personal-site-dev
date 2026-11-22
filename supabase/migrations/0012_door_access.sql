-- Temporary apartment access. Only the door service's service role can access these.
create table public.door_passes (
  id uuid primary key,
  label text not null check (length(label) between 1 and 60),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  check (ends_at > starts_at and ends_at - starts_at <= interval '30 days')
);

comment on column public.door_passes.token_hash is
  'SHA-256 of the guest link secret. The secret itself is shown once and never stored.';

create index door_passes_starts_at_idx on public.door_passes (starts_at desc);

create table public.door_events (
  id uuid primary key,
  at timestamptz not null,
  actor text not null check (actor in ('owner', 'guest')),
  pass_id uuid references public.door_passes (id) on delete set null,
  label text check (length(label) <= 60),
  action text not null check (action in ('lock', 'unlock')),
  outcome text not null check (outcome in ('ok', 'failed', 'denied')),
  ip inet
);

create index door_events_at_idx on public.door_events (at desc);

alter table public.door_passes enable row level security;
alter table public.door_events enable row level security;
revoke all on public.door_passes, public.door_events from public, anon, authenticated;
grant select, insert, update on public.door_passes to service_role;
grant select, insert on public.door_events to service_role;
