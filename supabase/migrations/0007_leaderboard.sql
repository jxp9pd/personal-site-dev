-- ============================================================================
-- 0007_leaderboard.sql
-- Per game+mode leaderboards, computed from the existing `plays` history.
--
-- Design intent:
--   * No new writable table. A leaderboard is a pure read-model over `plays`
--     (each user's best row) joined to `profiles` for the display name. Ranking
--     lives in SQL so the client just SELECTs — matching the "read directly from
--     Supabase" goal and keeping one source of truth for the ranking rules.
--   * Board identity is (game_id, mode): e.g. sf-neighborhoods/find and
--     sf-neighborhoods/name are distinct boards, and Seattle is separate again.
--   * "Best per user" = the user's highest score; ties within a user resolve to
--     the EARLIEST time they first reached it (achieved_at), mirroring stats.js.
--   * Cross-user rank is competition ranking via rank(): tied players share a
--     rank and the next rank has a gap (1,1,3). Display order within a tie is a
--     client concern (earliest achieved_at first).
--   * security_invoker: the view runs with the querying role's privileges, so
--     the existing public-read RLS on plays/profiles governs access (no PII is
--     exposed — profiles holds no email). Explicit grants are required because
--     new entities are not auto-exposed to the Data API roles.
-- ============================================================================

-- Supports the per-(game_id, mode, user_id) best-row pick below.
create index if not exists plays_game_mode_user_score_idx
  on public.plays (game_id, mode, user_id, score desc, created_at);

create or replace view public.leaderboard
  with (security_invoker = on)
as
-- One row per (game_id, mode, user_id): the user's best score for that board,
-- tie-broken to the first time they reached it.
with best_rows as (
  select distinct on (p.game_id, p.mode, p.user_id)
    p.game_id,
    p.mode,
    p.user_id,
    p.score,
    p.total,
    p.created_at as achieved_at
  from public.plays p
  order by p.game_id, p.mode, p.user_id, p.score desc, p.created_at asc
)
select
  b.game_id,
  b.mode,
  b.user_id,
  pr.username,
  b.score,
  b.total,
  b.achieved_at,
  rank() over (
    partition by b.game_id, b.mode
    order by b.score desc
  ) as rank
from best_rows b
join public.profiles pr on pr.user_id = b.user_id;

grant select on public.leaderboard to anon, authenticated;
