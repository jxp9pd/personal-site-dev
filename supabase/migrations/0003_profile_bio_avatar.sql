-- ============================================================================
-- 0003_profile_bio_avatar.sql
-- Adds optional self-authored profile fields.
--
-- Design intent:
--   * bio is a short, self-authored blurb; avatar_url is a dormant seam for a
--     future uploaded-avatar path (v1 always leaves it null and renders a
--     generated initials avatar instead).
--   * Both columns are nullable and need NO new RLS policy: the existing
--     owner-only UPDATE on profiles (0001) already gates bio edits, and the
--     existing public SELECT already covers reads.
--   * add column if not exists keeps this migration idempotent alongside the
--     0001/0002 re-runnable style.
-- ============================================================================

alter table public.profiles
  add column if not exists bio text;

alter table public.profiles
  add column if not exists avatar_url text;
