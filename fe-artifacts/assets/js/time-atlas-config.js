export const TIME_ATLAS_CITIES = Object.freeze({
  sf: Object.freeze({
    slug: 'sf',
    name: 'San Francisco',
    center: Object.freeze([-122.44, 37.76]),
    zoom: 11.5,
    checkpoints: Object.freeze([1850, 1870, 1890, 1910, 1930, 1950, 1970, 1990, 2010]),
    initialCheckpoint: 1910,
  }),
});

export function getTimeAtlasCityConfig(slug) {
  return TIME_ATLAS_CITIES[slug] ?? null;
}
