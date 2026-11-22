-- Expiring keypad codes for the apartment door. The PIN itself lives only on the
-- lock (via Seam); this table tracks who has a code, when it works, and the
-- lock-side id needed to remove it. Only the door service's service role can access it.
create table public.door_access_codes (
  id uuid primary key,
  label text not null check (length(label) between 1 and 60),
  lock_code_id text not null check (length(lock_code_id) between 1 and 200),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  check (ends_at > starts_at and ends_at - starts_at <= interval '30 days')
);

comment on column public.door_access_codes.lock_code_id is
  'Seam access_code_id (or the mock lock''s id). The PIN is shown to the owner once and never stored here.';

create index door_access_codes_starts_at_idx on public.door_access_codes (starts_at desc);

alter table public.door_access_codes enable row level security;
revoke all on public.door_access_codes from public, anon, authenticated;
grant select, insert, update on public.door_access_codes to service_role;
