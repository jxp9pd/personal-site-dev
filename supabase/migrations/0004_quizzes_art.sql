-- ============================================================================
-- 0004_quizzes_art.sql
-- Adds per-quiz landmark artwork for the city selector cards.
--
-- Design intent:
--   * art_svg holds a raw inline SVG (a landmark silhouette rendered translucent
--     behind the city name on the selector). It is admin-authored content
--     published by scripts/upload-quizzes.mjs alongside the geo data.
--   * Nullable, and needs NO new RLS policy: the existing public SELECT (0002)
--     already covers reads, and there is still no client-facing write policy so
--     only the service-role upload can populate it.
--   * add column if not exists keeps this idempotent alongside the 0001-0003 style.
-- ============================================================================

alter table public.quizzes
  add column if not exists art_svg text;
