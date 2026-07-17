const BASEMAP_STYLE = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';
const INTERACTIVE_LAYER_IDS = [
  'atlas-neighborhoods',
  'atlas-landmark-polygons',
  'atlas-lines',
  'atlas-points',
];

async function loadMapLibre() {
  return import('https://esm.sh/maplibre-gl@5');
}

function waitForLoad(map) {
  if (map.loaded()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    map.once('load', resolve);
    map.once('error', (event) => reject(event.error ?? new Error('Map failed to load')));
  });
}

export async function createTimeAtlasMap({
  container,
  center,
  zoom,
  onFeatureHover = () => {},
  mapLibreLoader = loadMapLibre,
}) {
  const module = await mapLibreLoader();
  const maplibregl = module.default ?? module;
  const map = new maplibregl.Map({
    container,
    center,
    zoom,
    style: BASEMAP_STYLE,
    attributionControl: true,
  });

  await waitForLoad(map);
  map.addSource('atlas-features', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });
  map.addLayer({
    id: 'atlas-neighborhoods',
    type: 'fill',
    source: 'atlas-features',
    filter: [
      'all',
      ['==', ['geometry-type'], 'Polygon'],
      ['==', ['get', 'layer'], 'neighborhoods'],
    ],
    paint: {
      'fill-color': '#4f746c',
      'fill-opacity': 0.24,
    },
  });
  map.addLayer({
    id: 'atlas-landmark-polygons',
    type: 'fill',
    source: 'atlas-features',
    filter: [
      'all',
      ['==', ['geometry-type'], 'Polygon'],
      ['==', ['get', 'layer'], 'landmarks'],
    ],
    paint: {
      'fill-color': '#b85c38',
      'fill-opacity': 0.42,
    },
  });
  map.addLayer({
    id: 'atlas-lines',
    type: 'line',
    source: 'atlas-features',
    filter: ['==', ['geometry-type'], 'LineString'],
    paint: {
      'line-color': '#8c3f25',
      'line-width': 2,
    },
  });
  map.addLayer({
    id: 'atlas-points',
    type: 'circle',
    source: 'atlas-features',
    filter: ['==', ['geometry-type'], 'Point'],
    paint: {
      'circle-color': '#8c3f25',
      'circle-radius': 5,
      'circle-stroke-color': '#fffaf0',
      'circle-stroke-width': 1.5,
    },
  });

  map.on('mousemove', INTERACTIVE_LAYER_IDS, (event) => {
    map.getCanvas().style.cursor = 'pointer';
    onFeatureHover(event.features?.[0] ?? null);
  });
  map.on('mouseleave', INTERACTIVE_LAYER_IDS, () => {
    map.getCanvas().style.cursor = '';
    onFeatureHover(null);
  });

  return {
    renderFeatures(featureCollection) {
      map.getSource('atlas-features').setData(featureCollection);
    },
  };
}
