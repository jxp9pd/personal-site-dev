const BASEMAP_STYLE = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';

function safeId(value) {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
}

function geometryFamily(geometry) {
  if (geometry.endsWith('Polygon')) return 'Polygon';
  if (geometry.endsWith('LineString')) return 'LineString';
  return 'Point';
}

function layerDefinitions(layers, { source = 'atlas-features', suffix = '' } = {}) {
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
          id: `${id}-fill${suffix}`,
          type: 'fill',
          source,
          filter: filterFor('Polygon'),
          paint: {
            'fill-color': [
              'case',
              ['boolean', ['feature-state', 'hover'], false],
              '#d99745',
              layer.style.color,
            ],
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
          id: `${id}-outline${suffix}`,
          type: 'line',
          source,
          filter: filterFor('Polygon'),
          paint: {
            'line-color': layer.style.color,
            'line-opacity': layer.style.lineOpacity,
            'line-width': [
              'case',
              ['boolean', ['feature-state', 'hover'], false],
              3,
              1.25,
            ],
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
          id: `${id}-line${suffix}`,
          type: 'line',
          source,
          filter: filterFor('LineString'),
          paint: {
            'line-color': layer.style.color,
            'line-opacity': layer.style.lineOpacity,
            'line-width': [
              'case',
              ['boolean', ['feature-state', 'hover'], false],
              4,
              2,
            ],
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
          id: `${id}-point${suffix}`,
          type: 'circle',
          source,
          filter: filterFor('Point'),
          paint: {
            'circle-color': layer.style.color,
            'circle-opacity': layer.style.pointOpacity,
            'circle-radius': [
              'case',
              ['boolean', ['feature-state', 'hover'], false],
              8,
              5,
            ],
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
  onFeatureSelect = () => {},
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
  map.addSource('atlas-features-transition', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });
  let definitions = [];
  let transitionDefinitions = [];
  let configuredLayers = [];
  let hoveredFeature = null;
  const categoryOpacity = new Map();
  const categoryVisibility = new Map();
  const transitionOpacity = [1, 0];

  function setDefinitionOpacity(definition, duration = 0) {
    const slotOpacity = transitionOpacity[definition.slot];
    const opacity = categoryOpacity.get(definition.category) ?? 1;
    map.setPaintProperty(
      definition.mapLayer.id,
      `${definition.opacityProperty}-transition`,
      { duration },
    );
    map.setPaintProperty(
      definition.mapLayer.id,
      definition.opacityProperty,
      definition.baseOpacity * opacity * slotOpacity,
    );
    if (definition.mapLayer.type === 'circle') {
      map.setPaintProperty(
        definition.mapLayer.id,
        'circle-stroke-opacity-transition',
        { duration },
      );
      map.setPaintProperty(
        definition.mapLayer.id,
        'circle-stroke-opacity',
        definition.baseOpacity * opacity * slotOpacity,
      );
    }
  }

  function clearHover() {
    if (hoveredFeature && map.setFeatureState) {
      map.setFeatureState(hoveredFeature, { hover: false });
    }
    hoveredFeature = null;
    map.getCanvas().style.cursor = '';
    onFeatureHover(null);
  }

  function allDefinitions() {
    return [...definitions, ...transitionDefinitions];
  }

  function ensureTransitionLayers() {
    if (transitionDefinitions.length > 0) return;
    transitionDefinitions = layerDefinitions(configuredLayers, {
      source: 'atlas-features-transition',
      suffix: '-transition',
    }).map((definition) => ({ ...definition, slot: 1 }));
    const addedTransitionDefinitions = [];
    for (const definition of transitionDefinitions) {
      const nextDefinition = [...definitions, ...addedTransitionDefinitions]
        .filter(({ order }) => order > definition.order)
        .sort((left, right) => (
          left.order - right.order || left.mapLayer.id.localeCompare(right.mapLayer.id)
        ))[0];
      map.addLayer(definition.mapLayer, nextDefinition?.mapLayer.id);
      addedTransitionDefinitions.push(definition);
      setDefinitionOpacity(definition);
      map.setLayoutProperty(
        definition.mapLayer.id,
        'visibility',
        categoryVisibility.get(definition.category) === false ? 'none' : 'visible',
      );
    }
  }

  return {
    configureLayers(layers) {
      configuredLayers = layers;
      definitions = layerDefinitions(layers).map((definition) => ({
        ...definition,
        slot: 0,
      }));
      for (const definition of definitions) map.addLayer(definition.mapLayer);

      const interactiveLayerIds = definitions.map(({ mapLayer }) => mapLayer.id);
      if (interactiveLayerIds.length > 0) {
        map.on('mousemove', interactiveLayerIds, (event) => {
          const feature = event.features?.[0] ?? null;
          const nextHovered = feature?.id === undefined ? null : {
            source: feature.source,
            id: feature.id,
          };
          if (
            hoveredFeature
            && (hoveredFeature.source !== nextHovered?.source || hoveredFeature.id !== nextHovered?.id)
            && map.setFeatureState
          ) {
            map.setFeatureState(hoveredFeature, { hover: false });
          }
          hoveredFeature = nextHovered;
          if (hoveredFeature && map.setFeatureState) {
            map.setFeatureState(hoveredFeature, { hover: true });
          }
          map.getCanvas().style.cursor = 'pointer';
          onFeatureHover(feature);
        });
        map.on('mouseleave', interactiveLayerIds, clearHover);
        map.on('click', interactiveLayerIds, (event) => {
          const feature = event.features?.[0] ?? null;
          if (feature) onFeatureSelect(feature);
        });
      }
    },
    renderFeatures(featureCollection) {
      map.getSource('atlas-features').setData(featureCollection);
      map.getSource('atlas-features-transition').setData({
        type: 'FeatureCollection',
        features: [],
      });
    },
    setCheckpointStates(states, { duration = 0 } = {}) {
      clearHover();
      if (states.length > 1) {
        ensureTransitionLayers();
      }
      const empty = { type: 'FeatureCollection', features: [] };
      map.getSource('atlas-features').setData(states[0]?.featureCollection ?? empty);
      map.getSource('atlas-features-transition').setData(states[1]?.featureCollection ?? empty);
      transitionOpacity[0] = states[0]?.opacity ?? 0;
      transitionOpacity[1] = states[1]?.opacity ?? 0;
      for (const definition of allDefinitions()) setDefinitionOpacity(definition, duration);
    },
    setLayerVisibility(category, visible) {
      categoryVisibility.set(category, visible);
      for (const definition of allDefinitions().filter((item) => item.category === category)) {
        map.setLayoutProperty(
          definition.mapLayer.id,
          'visibility',
          visible ? 'visible' : 'none',
        );
      }
    },
    setLayerOpacity(category, opacity) {
      categoryOpacity.set(category, opacity);
      for (const definition of allDefinitions().filter((item) => item.category === category)) {
        setDefinitionOpacity(definition);
      }
    },
  };
}
