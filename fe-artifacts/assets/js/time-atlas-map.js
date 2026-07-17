const BASEMAP_STYLE = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';

function safeId(value) {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
}

function geometryFamily(geometry) {
  if (geometry.endsWith('Polygon')) return 'Polygon';
  if (geometry.endsWith('LineString')) return 'LineString';
  return 'Point';
}

function layerDefinitions(layers) {
  const definitions = [];
  for (const layer of layers) {
    const families = new Set(layer.geometries.map(geometryFamily));
    const filterFor = (geometry) => [
      'all',
      ['==', ['geometry-type'], geometry],
      ['==', ['get', 'layer'], layer.category],
    ];
    const id = `atlas-${safeId(layer.category)}`;

    if (families.has('Polygon')) {
      definitions.push({
        order: 0,
        category: layer.category,
        opacityProperty: 'fill-opacity',
        baseOpacity: layer.style.fillOpacity,
        mapLayer: {
          id: `${id}-fill`,
          type: 'fill',
          source: 'atlas-features',
          filter: filterFor('Polygon'),
          paint: {
            'fill-color': layer.style.color,
            'fill-opacity': layer.style.fillOpacity,
          },
        },
      });
      definitions.push({
        order: 1,
        category: layer.category,
        opacityProperty: 'line-opacity',
        baseOpacity: layer.style.lineOpacity,
        mapLayer: {
          id: `${id}-outline`,
          type: 'line',
          source: 'atlas-features',
          filter: filterFor('Polygon'),
          paint: {
            'line-color': layer.style.color,
            'line-opacity': layer.style.lineOpacity,
            'line-width': 1.25,
          },
        },
      });
    }
    if (families.has('LineString')) {
      definitions.push({
        order: 2,
        category: layer.category,
        opacityProperty: 'line-opacity',
        baseOpacity: layer.style.lineOpacity,
        mapLayer: {
          id: `${id}-line`,
          type: 'line',
          source: 'atlas-features',
          filter: filterFor('LineString'),
          paint: {
            'line-color': layer.style.color,
            'line-opacity': layer.style.lineOpacity,
            'line-width': 2,
          },
        },
      });
    }
    if (families.has('Point')) {
      definitions.push({
        order: 3,
        category: layer.category,
        opacityProperty: 'circle-opacity',
        baseOpacity: layer.style.pointOpacity,
        mapLayer: {
          id: `${id}-point`,
          type: 'circle',
          source: 'atlas-features',
          filter: filterFor('Point'),
          paint: {
            'circle-color': layer.style.color,
            'circle-opacity': layer.style.pointOpacity,
            'circle-radius': 5,
            'circle-stroke-color': '#fffaf0',
            'circle-stroke-opacity': layer.style.pointOpacity,
            'circle-stroke-width': 1.5,
          },
        },
      });
    }
  }
  return definitions.sort((left, right) => (
    left.order - right.order || left.mapLayer.id.localeCompare(right.mapLayer.id)
  ));
}

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
  let definitions = [];

  return {
    configureLayers(layers) {
      definitions = layerDefinitions(layers);
      for (const definition of definitions) map.addLayer(definition.mapLayer);

      const interactiveLayerIds = definitions.map(({ mapLayer }) => mapLayer.id);
      if (interactiveLayerIds.length > 0) {
        map.on('mousemove', interactiveLayerIds, (event) => {
          map.getCanvas().style.cursor = 'pointer';
          onFeatureHover(event.features?.[0] ?? null);
        });
        map.on('mouseleave', interactiveLayerIds, () => {
          map.getCanvas().style.cursor = '';
          onFeatureHover(null);
        });
      }
    },
    renderFeatures(featureCollection) {
      map.getSource('atlas-features').setData(featureCollection);
    },
    setLayerVisibility(category, visible) {
      for (const definition of definitions.filter((item) => item.category === category)) {
        map.setLayoutProperty(
          definition.mapLayer.id,
          'visibility',
          visible ? 'visible' : 'none',
        );
      }
    },
    setLayerOpacity(category, opacity) {
      for (const definition of definitions.filter((item) => item.category === category)) {
        map.setPaintProperty(
          definition.mapLayer.id,
          definition.opacityProperty,
          definition.baseOpacity * opacity,
        );
        if (definition.mapLayer.type === 'circle') {
          map.setPaintProperty(
            definition.mapLayer.id,
            'circle-stroke-opacity',
            definition.baseOpacity * opacity,
          );
        }
      }
    },
  };
}
