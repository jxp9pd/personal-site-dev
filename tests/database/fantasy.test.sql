-- Run with: supabase db query --linked --file tests/database/fantasy.test.sql
-- Data validation uses a temporary table; existing dashboard data is untouched.
begin;

do $$
begin
  if not (select relrowsecurity from pg_class where oid = 'public.vestaboard_fantasy'::regclass) then
    raise exception 'Fantasy RLS must be enabled';
  end if;
  if exists (
    select 1 from unnest(array['anon', 'authenticated']) as r(role_name)
    cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) as p(privilege_name)
    where has_table_privilege(role_name, 'public.vestaboard_fantasy', privilege_name)
  ) then
    raise exception 'Browser roles must not have direct Fantasy access';
  end if;
  if exists (
    select 1 from unnest(array['SELECT', 'INSERT', 'UPDATE']) as p(privilege_name)
    where not has_table_privilege('service_role', 'public.vestaboard_fantasy', privilege_name)
  ) then
    raise exception 'Gateway service role must have Fantasy access';
  end if;
end $$;

create temporary table fantasy_validation (like public.vestaboard_fantasy including all) on commit drop;
insert into fantasy_validation (config_version, leagues) values (gen_random_uuid(), '[{}, {}]');

do $$
begin
  begin
    update fantasy_validation set week = 19, season = '2026';
    raise exception 'Invalid week was accepted';
  exception when check_violation then null;
  end;
  begin
    update fantasy_validation set leagues = '[]';
    raise exception 'Missing league settings were accepted';
  exception when check_violation then null;
  end;
  begin
    update fantasy_validation set matchups = '[{}, null]';
    raise exception 'Scores without a season/week were accepted';
  exception when check_violation then null;
  end;
  update fantasy_validation set week = 6, season = '2026', matchups = '[{}, null]';
  if not found then raise exception 'Valid snapshot was not saved'; end if;
end $$;

do $$
begin
  if not (select relrowsecurity from pg_class where oid = 'public.vestaboard_fantasy_weeks'::regclass) then
    raise exception 'Weekly Fantasy RLS must be enabled';
  end if;
  if exists (
    select 1 from unnest(array['anon', 'authenticated']) as r(role_name)
    cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) as p(privilege_name)
    where has_table_privilege(role_name, 'public.vestaboard_fantasy_weeks', privilege_name)
  ) then
    raise exception 'Browser roles must not have direct weekly Fantasy access';
  end if;
  if exists (
    select 1 from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) as p(privilege_name)
    where not has_table_privilege('service_role', 'public.vestaboard_fantasy_weeks', privilege_name)
  ) then
    raise exception 'Service role must be able to refresh and rebuild weeks';
  end if;
end $$;

create temporary table fantasy_week_validation (like public.vestaboard_fantasy_weeks including all) on commit drop;
insert into fantasy_week_validation (season, week, config_version, leagues, matchups, last_checked_at)
  values ('2026', 5, gen_random_uuid(), '[{}, {}]', '[{}, {}]', now());
insert into fantasy_week_validation (season, week, config_version, leagues, matchups, last_checked_at)
  values ('2026', 6, gen_random_uuid(), '[{}, {}]', '[{}, {}]', now());

do $$
begin
  begin
    update fantasy_week_validation set matchups = '[{}, null]' where week = 5;
    raise exception 'An incomplete week was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into fantasy_week_validation select * from fantasy_week_validation where week = 5;
    raise exception 'A duplicate week was accepted';
  exception when unique_violation then null;
  end;
  delete from fantasy_week_validation where season = '2026' and week = 5;
  if (select count(*) from fantasy_week_validation where week = 6) <> 1 then
    raise exception 'Deleting one week affected another';
  end if;
end $$;

rollback;
