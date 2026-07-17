create extension if not exists postgis with schema extensions;

create table public.atlas_cities (
  slug text primary key check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  name text not null,
  created_at timestamptz not null default now()
);

create table public.atlas_features (
  id bigint generated always as identity primary key,
  city_slug text not null references public.atlas_cities(slug) on delete cascade,
  source text not null check (length(btrim(source)) > 0),
  source_id text not null check (length(btrim(source_id)) > 0),
  layer_category text not null check (length(btrim(layer_category)) > 0),
  name text,
  start_date text not null,
  end_date text,
  start_year integer not null,
  end_year integer,
  source_properties jsonb not null default '{}'::jsonb
    check (jsonb_typeof(source_properties) = 'object'),
  geom extensions.geometry(Geometry, 4326) not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint atlas_features_provenance_unique unique (source, source_id),
  constraint atlas_features_year_range_valid
    check (end_year is null or end_year > start_year),
  constraint atlas_features_wgs84_valid
    check (extensions.st_srid(geom) = 4326 and extensions.st_isvalid(geom)),
  constraint atlas_features_geometry_type_valid
    check (
      extensions.geometrytype(geom) in (
        'POINT',
        'MULTIPOINT',
        'LINESTRING',
        'MULTILINESTRING',
        'POLYGON',
        'MULTIPOLYGON'
      )
    )
);

create index atlas_features_geom_idx
  on public.atlas_features using gist (geom);

create index atlas_features_city_temporal_idx
  on public.atlas_features (city_slug, start_year, end_year);

alter table public.atlas_cities enable row level security;
alter table public.atlas_features enable row level security;

create policy atlas_cities_select_public
  on public.atlas_cities
  for select
  to anon, authenticated
  using (true);

create policy atlas_features_select_public
  on public.atlas_features
  for select
  to anon, authenticated
  using (true);

create or replace function public.atlas_city_geojson(p_city_slug text)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select case
    when not exists (
      select 1
      from public.atlas_cities
      where slug = p_city_slug
    ) then null
    else jsonb_build_object(
      'type', 'FeatureCollection',
      'features', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'type', 'Feature',
            'id', feature.source || ':' || feature.source_id,
            'geometry', extensions.st_asgeojson(feature.geom)::jsonb,
            'properties', jsonb_build_object(
              'name', feature.name,
              'layer', feature.layer_category,
              'start_date', feature.start_date,
              'end_date', feature.end_date,
              'start_year', feature.start_year,
              'end_year', feature.end_year,
              'source', feature.source,
              'source_id', feature.source_id
            )
          )
          order by feature.source, feature.source_id
        )
        from public.atlas_features as feature
        where feature.city_slug = p_city_slug
      ), '[]'::jsonb)
    )
  end;
$$;

revoke all on table public.atlas_cities from anon, authenticated;
revoke all on table public.atlas_features from anon, authenticated;
grant select on table public.atlas_cities to anon, authenticated;
grant select on table public.atlas_features to anon, authenticated;

revoke all on function public.atlas_city_geojson(text) from public;
grant execute on function public.atlas_city_geojson(text)
  to anon, authenticated, service_role;

insert into public.atlas_cities (slug, name)
values ('sf', 'San Francisco')
on conflict (slug) do update set name = excluded.name;
