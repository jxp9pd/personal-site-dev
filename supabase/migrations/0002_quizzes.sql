-- ============================================================================
-- 0002_quizzes.sql
-- Neighborhood-quiz content, moved out of static files and into the DB.
--
-- Design intent:
--   * One row per quiz (city). `geo` holds the full GeoJSON FeatureCollection;
--     everything else is the display + map-framing metadata that used to live in
--     the `CITIES` registry inside neighborhoods-quiz.html.
--   * Public read, NO client-facing write policy. This is read-only reference
--     data: the anon key can select it but can never mutate it. Uploads run with
--     the service-role key (see scripts/upload-quizzes.mjs), which bypasses RLS.
--   * `slug` matches the tracked game_id in the frontend manifest and the
--     `plays.game_id` tag, so a quiz and its recorded plays share one identifier.
-- ============================================================================

create table if not exists public.quizzes (
  slug        text primary key,
  name        text not null,
  description text,
  center_lat  double precision not null,
  center_lng  double precision not null,
  zoom        int not null,
  geo         jsonb not null,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Selector lists quizzes in this order, then by name as a stable tiebreaker.
create index if not exists quizzes_sort_idx on public.quizzes (sort_order, name);

-- ----------------------------------------------------------------------------
-- Row-Level Security: public read, no client writes.
--
-- Mirrors the plays/profiles pattern (public select) but deliberately omits any
-- insert/update/delete policy. With RLS enabled and no write policy, the anon
-- and authenticated roles cannot write; only the service-role key (used by the
-- upload script) can, since it bypasses RLS entirely.
-- ----------------------------------------------------------------------------
alter table public.quizzes enable row level security;

drop policy if exists quizzes_select_public on public.quizzes;
create policy quizzes_select_public
  on public.quizzes
  for select
  to anon, authenticated
  using (true);
