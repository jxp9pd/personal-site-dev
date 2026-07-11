-- ============================================================================
-- 0006_packs.sql
-- "Guess the Price" content: a pack (theme) and its priced items.
--
-- Design intent (mirrors 0002_quizzes.sql):
--   * `packs` is one row per theme (e.g. wearables, groceries); `pack_items`
--     holds the priced products belonging to a pack.
--   * Public read, NO client-facing write policy. This is read-only reference
--     data: the anon key can select it but can never mutate it. Uploads run with
--     the service-role key (see scripts/upload-packs.mjs), which bypasses RLS.
--   * `slug` matches the tracked game mode in the frontend and the pack chosen
--     on the selector, so a pack and its recorded plays share one identifier.
-- ============================================================================

create table if not exists public.packs (
  slug        text primary key,
  name        text not null,
  description text,
  sort_order  int not null default 0,
  art_svg     text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.pack_items (
  id          bigint generated always as identity primary key,
  pack_slug   text not null references public.packs(slug) on delete cascade,
  name        text not null,
  price       numeric(10,2) not null,
  image_url   text,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now()
);

-- Items are listed within a pack in this order.
create index if not exists pack_items_pack_sort_idx
  on public.pack_items (pack_slug, sort_order);

-- ----------------------------------------------------------------------------
-- Row-Level Security: public read, no client writes.
--
-- Mirrors the quizzes pattern (public select) but deliberately omits any
-- insert/update/delete policy. With RLS enabled and no write policy, the anon
-- and authenticated roles cannot write; only the service-role key (used by the
-- upload script) can, since it bypasses RLS entirely.
-- ----------------------------------------------------------------------------
alter table public.packs enable row level security;
alter table public.pack_items enable row level security;

drop policy if exists packs_select_public on public.packs;
create policy packs_select_public
  on public.packs
  for select
  to anon, authenticated
  using (true);

drop policy if exists pack_items_select_public on public.pack_items;
create policy pack_items_select_public
  on public.pack_items
  for select
  to anon, authenticated
  using (true);
