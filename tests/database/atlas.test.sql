begin;

create extension if not exists pgtap with schema extensions;

select plan(27);

select ok(
  exists (select 1 from pg_extension where extname = 'postgis'),
  'PostGIS is installed'
);
select ok(to_regclass('public.atlas_cities') is not null, 'atlas cities table exists');
select ok(to_regclass('public.atlas_features') is not null, 'atlas features table exists');
select ok(
  to_regclass('public.atlas_features_geom_idx') is not null,
  'spatial index exists'
);
select ok(
  to_regclass('public.atlas_features_city_temporal_idx') is not null,
  'city temporal index exists'
);
select ok(
  exists (
    select 1
    from pg_constraint
    where conrelid = 'public.atlas_features'::regclass
      and conname = 'atlas_features_provenance_unique'
  ),
  'provenance identity is unique'
);
select ok(
  to_regprocedure('public.atlas_city_geojson(text)') is not null,
  'city GeoJSON function exists'
);
select is(
  extensions.find_srid('public', 'atlas_features', 'geom'),
  4326,
  'geometry column uses WGS84'
);

insert into public.atlas_cities (slug, name)
values
  ('empty-city', 'Empty City'),
  ('oakland', 'Oakland');

insert into public.atlas_features (
  city_slug,
  source,
  source_id,
  layer_category,
  name,
  start_date,
  end_date,
  start_year,
  end_year,
  source_properties,
  geom
)
values
  (
    'sf',
    'ohm',
    'node/1',
    'landmarks',
    'Point Feature',
    '1850',
    null,
    1850,
    null,
    '{"historic":"monument"}',
    extensions.st_geomfromtext('POINT(-122.4194 37.7749)', 4326)
  ),
  (
    'sf',
    'ohm',
    'way/2',
    'streetcars',
    'Line Feature',
    '1860-04',
    '1950',
    1860,
    1950,
    '{"railway":"tram"}',
    extensions.st_geomfromtext(
      'LINESTRING(-122.42 37.77, -122.41 37.78)',
      4326
    )
  ),
  (
    'sf',
    'curated',
    'neighborhood/3',
    'neighborhoods',
    'Polygon Feature',
    '1900~',
    null,
    1900,
    null,
    '{"editorial_note":"fixture"}',
    extensions.st_geomfromtext(
      'POLYGON((-122.43 37.77, -122.42 37.77, -122.42 37.78, -122.43 37.77))',
      4326
    )
  ),
  (
    'oakland',
    'curated',
    'landmark/oakland',
    'landmarks',
    'Oakland Feature',
    '1900',
    null,
    1900,
    null,
    '{}',
    extensions.st_geomfromtext('POINT(-122.2712 37.8044)', 4326)
  );

insert into public.atlas_features (
  city_slug,
  source,
  source_id,
  layer_category,
  name,
  start_date,
  start_year,
  source_properties,
  geom
)
values (
  'sf',
  'ohm',
  'node/1',
  'landmarks',
  'Updated Point Feature',
  '1850',
  1850,
  '{"historic":"monument"}',
  extensions.st_geomfromtext('POINT(-122.4194 37.7749)', 4326)
)
on conflict (source, source_id) do update
set name = excluded.name;

select is(
  (select count(*)::integer from public.atlas_features where source = 'ohm' and source_id = 'node/1'),
  1,
  're-upsert keeps one provenance row'
);
select is(
  (select name from public.atlas_features where source = 'ohm' and source_id = 'node/1'),
  'Updated Point Feature',
  're-upsert updates the existing provenance row'
);

select is(
  public.atlas_city_geojson('sf')->>'type',
  'FeatureCollection',
  'known city returns a FeatureCollection'
);
select is(
  jsonb_array_length(public.atlas_city_geojson('sf')->'features'),
  3,
  'city response contains only that city'
);
select is(
  jsonb_array_length(public.atlas_city_geojson('oakland')->'features'),
  1,
  'second city is isolated'
);
select is(
  jsonb_array_length(public.atlas_city_geojson('empty-city')->'features'),
  0,
  'known empty city returns an empty FeatureCollection'
);
select ok(
  public.atlas_city_geojson('unknown-city') is null,
  'unknown city returns explicit not-found'
);

select ok(
  exists (
    select 1
    from jsonb_array_elements(public.atlas_city_geojson('sf')->'features') feature
    where feature->'geometry'->>'type' = 'Point'
  ),
  'point geometry serializes as GeoJSON'
);
select ok(
  exists (
    select 1
    from jsonb_array_elements(public.atlas_city_geojson('sf')->'features') feature
    where feature->'geometry'->>'type' = 'LineString'
  ),
  'line geometry serializes as GeoJSON'
);
select ok(
  exists (
    select 1
    from jsonb_array_elements(public.atlas_city_geojson('sf')->'features') feature
    where feature->'geometry'->>'type' = 'Polygon'
  ),
  'polygon geometry serializes as GeoJSON'
);
select ok(
  (
    select bool_and(
      feature->>'type' = 'Feature'
      and feature ? 'id'
      and feature ? 'geometry'
      and feature ? 'properties'
    )
    from jsonb_array_elements(public.atlas_city_geojson('sf')->'features') feature
  ),
  'every returned item is a valid GeoJSON Feature'
);
select ok(
  (
    select bool_and(
      properties ?& array[
        'name',
        'layer',
        'start_date',
        'end_date',
        'start_year',
        'end_year',
        'source',
        'source_id'
      ]
    )
    from jsonb_array_elements(public.atlas_city_geojson('sf')->'features') feature,
      lateral (select feature->'properties' as properties) props
  ),
  'rendering, temporal, detail, and provenance properties are returned'
);
select ok(
  (
    select bool_and(not (properties ? 'source_properties'))
    from jsonb_array_elements(public.atlas_city_geojson('sf')->'features') feature,
      lateral (select feature->'properties' as properties) props
  ),
  'source property bag is not leaked by the public contract'
);
select is(
  (
    select source_properties->>'historic'
    from public.atlas_features
    where source = 'ohm' and source_id = 'node/1'
  ),
  'monument',
  'source properties are retained in persistence'
);

set local role anon;
select is(
  jsonb_array_length(public.atlas_city_geojson('sf')->'features'),
  3,
  'anonymous city RPC read succeeds'
);
select is(
  (select count(*)::integer from public.atlas_features where city_slug = 'sf'),
  3,
  'anonymous table read succeeds'
);
select throws_ok(
  $$insert into public.atlas_features (
    city_slug, source, source_id, layer_category, start_date, start_year, geom
  ) values (
    'sf', 'anon', 'point/1', 'landmarks', '2000', 2000,
    extensions.st_geomfromtext('POINT(-122.4 37.7)', 4326)
  )$$,
  '42501',
  'permission denied for table atlas_features',
  'anonymous writes are rejected'
);

reset role;
set local role authenticated;
select is(
  jsonb_array_length(public.atlas_city_geojson('sf')->'features'),
  3,
  'authenticated city RPC read succeeds'
);
select throws_ok(
  $$update public.atlas_features set name = 'forbidden' where city_slug = 'sf'$$,
  '42501',
  'permission denied for table atlas_features',
  'authenticated writes are rejected'
);

select * from finish();
rollback;
