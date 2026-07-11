-- ============================================================================
-- 0001_profiles_and_plays.sql
-- Backend foundation for user profiles + game history.
--
-- Design intent:
--   * profiles/plays are the only client-facing tables. Emails live solely in
--     auth.users and are never mirrored here, so a public read policy cannot
--     leak PII.
--   * game_id/mode are immutable text tags. There is intentionally NO games
--     table -- the frontend manifest is the source of truth for game metadata.
--   * The profile row is created by a SECURITY DEFINER trigger on auth.users so
--     an account can never exist without a matching profile, and signup stays a
--     single client call.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- profiles
-- ----------------------------------------------------------------------------
create table if not exists public.profiles (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  username   text not null,
  created_at timestamptz not null default now()
);

-- Case-insensitive uniqueness: "Foo" and "foo" must collide.
create unique index if not exists profiles_username_lower_key
  on public.profiles (lower(username));

-- ----------------------------------------------------------------------------
-- plays
-- ----------------------------------------------------------------------------
create table if not exists public.plays (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users (id) on delete cascade,
  game_id    text not null,
  mode       text not null,
  score      int  not null,
  total      int  not null,
  created_at timestamptz not null default now()
);

-- Serves "this user's history for this game/mode, newest first" lookups.
create index if not exists plays_user_game_mode_created_idx
  on public.plays (user_id, game_id, mode, created_at desc);

-- ----------------------------------------------------------------------------
-- Row-Level Security
--
-- Both tables are publicly readable (leaderboards / public profiles) and
-- writable only by the owning user. Reads are safe because no PII is stored
-- here. Policies are dropped-then-created so the migration re-runs cleanly.
-- ----------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.plays    enable row level security;

-- profiles: public read
drop policy if exists profiles_select_public on public.profiles;
create policy profiles_select_public
  on public.profiles
  for select
  to anon, authenticated
  using (true);

-- profiles: owner-only insert. The trigger below (SECURITY DEFINER) bypasses
-- RLS, so this is not required for signup -- it is here so a client can also
-- self-heal/create its own row without being able to forge another user's.
drop policy if exists profiles_insert_own on public.profiles;
create policy profiles_insert_own
  on public.profiles
  for insert
  to authenticated
  with check (auth.uid() = user_id);

-- profiles: owner-only update
drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own
  on public.profiles
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- plays: public read
drop policy if exists plays_select_public on public.plays;
create policy plays_select_public
  on public.plays
  for select
  to anon, authenticated
  using (true);

-- plays: owner-only insert (blocks inserting rows under another user_id)
drop policy if exists plays_insert_own on public.plays;
create policy plays_insert_own
  on public.plays
  for insert
  to authenticated
  with check (auth.uid() = user_id);

-- plays: owner-only update
drop policy if exists plays_update_own on public.plays;
create policy plays_update_own
  on public.plays
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ----------------------------------------------------------------------------
-- Profile-creation trigger
--
-- Runs as the function owner (SECURITY DEFINER) so it can insert into
-- public.profiles regardless of the caller's RLS context. The explicit,
-- locked-down search_path is a Supabase security best practice: it prevents a
-- malicious object earlier on the path from hijacking unqualified references.
-- ----------------------------------------------------------------------------
create or replace function public.handle_new_user()
  returns trigger
  language plpgsql
  security definer
  set search_path = ''
as $$
begin
  insert into public.profiles (user_id, username)
  values (
    new.id,
    new.raw_user_meta_data ->> 'username'
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_user();
