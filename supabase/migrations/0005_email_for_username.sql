-- ============================================================================
-- 0005_email_for_username.sql
-- Resolves a username to its account email so the client can sign in by
-- username (Supabase's password grant only accepts an email).
--
-- Design intent:
--   * profiles never stores email (public-read safety), so the lookup must
--     reach into auth.users. SECURITY DEFINER lets an anon caller read that
--     one column without exposing the rest of auth.users.
--   * Match is case-insensitive to mirror profiles' lower(username) uniqueness.
--   * search_path is locked to '' (Supabase best practice) so unqualified
--     references can't be hijacked; every object below is schema-qualified.
--   * Tradeoff (accepted): a caller can map any username to its email. Closing
--     that leak would require signing in server-side (an Edge Function).
--   * create or replace + grant/revoke keep this migration re-runnable like the
--     0001-0004 style.
-- ============================================================================

create or replace function public.email_for_username(p_username text)
  returns text
  language sql
  security definer
  set search_path = ''
as $$
  select u.email
  from public.profiles p
  join auth.users u on u.id = p.user_id
  where lower(p.username) = lower(p_username)
  limit 1;
$$;

revoke all on function public.email_for_username(text) from public;
grant execute on function public.email_for_username(text) to anon, authenticated;
