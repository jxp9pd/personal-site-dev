const KNOWN_STYLES = Object.freeze({
  neighborhoods: Object.freeze({
    color: '#4f746c',
    fillOpacity: 0.24,
    lineOpacity: 0.8,
    pointOpacity: 0.9,
  }),
  landmarks: Object.freeze({
    color: '#b85c38',
    fillOpacity: 0.42,
    lineOpacity: 0.9,
    pointOpacity: 1,
  }),
});

const DEFAULT_COLORS = Object.freeze([
  '#486f91',
  '#80609b',
  '#9a6b35',
  '#39776d',
  '#8b5368',
]);

const GEOMETRY_ORDER = Object.freeze({
  Polygon: 0,
  MultiPolygon: 0,
  LineString: 1,
  MultiLineString: 1,
  Point: 2,
  MultiPoint: 2,
});

function categoryLabel(category) {
  return category
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => `${word[0].toUpperCase()}${word.slice(1)}`)
    .join(' ');
}

function colorForCategory(category) {
  let hash = 0;
  for (const character of category) {
    hash = ((hash * 31) + character.charCodeAt(0)) >>> 0;
  }
  return DEFAULT_COLORS[hash % DEFAULT_COLORS.length];
}

function defaultStyle(category, geometries) {
  const known = KNOWN_STYLES[category];
  if (known) return { ...known };

  const hasArea = geometries.some((geometry) => GEOMETRY_ORDER[geometry] === 0);
  const hasLine = geometries.some((geometry) => GEOMETRY_ORDER[geometry] === 1);
  return {
    color: colorForCategory(category),
    fillOpacity: hasArea ? 0.32 : 0,
    lineOpacity: hasLine || hasArea ? 0.85 : 0,
    pointOpacity: 0.95,
  };
}

export function discoverAtlasLayers(featureCollection) {
  const geometryByCategory = new Map();

  for (const feature of featureCollection?.features ?? []) {
    const category = feature.properties?.layer;
    const geometry = feature.geometry?.type;
    if (typeof category !== 'string' || !category.trim() || !(geometry in GEOMETRY_ORDER)) {
      continue;
    }
    if (!geometryByCategory.has(category)) geometryByCategory.set(category, new Set());
    geometryByCategory.get(category).add(geometry);
  }

  return [...geometryByCategory.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([category, geometries]) => {
      const orderedGeometries = [...geometries].sort((left, right) => (
        GEOMETRY_ORDER[left] - GEOMETRY_ORDER[right] || left.localeCompare(right)
      ));
      return {
        category,
        label: categoryLabel(category),
        geometries: orderedGeometries,
        style: defaultStyle(category, orderedGeometries),
      };
    });
}

export function createLayerController({
  featureCollection,
  container,
  renderer,
}) {
  const layers = discoverAtlasLayers(featureCollection);
  const states = new Map(layers.map(({ category }) => [
    category,
    { visible: true, opacity: 1 },
  ]));

  renderer.configureLayers?.(layers);
  container.replaceChildren();

  for (const layer of layers) {
    const group = document.createElement('fieldset');
    const legend = document.createElement('legend');
    const visibilityLabel = document.createElement('label');
    const visibility = document.createElement('input');
    const opacityLabel = document.createElement('label');
    const opacity = document.createElement('input');

    group.className = 'atlas-layer-control';
    group.dataset.layer = layer.category;
    legend.textContent = layer.label;

    visibility.type = 'checkbox';
    visibility.checked = true;
    visibility.setAttribute('aria-label', `Show ${layer.label} layer`);
    visibilityLabel.append(visibility, ' Visible');

    opacity.type = 'range';
    opacity.min = '0';
    opacity.max = '100';
    opacity.value = '100';
    opacity.setAttribute('aria-label', `${layer.label} layer opacity`);
    opacityLabel.append('Opacity ', opacity);

    visibility.addEventListener('change', () => {
      states.get(layer.category).visible = visibility.checked;
      renderer.setLayerVisibility?.(layer.category, visibility.checked);
    });
    opacity.addEventListener('input', () => {
      const value = Number(opacity.value) / 100;
      states.get(layer.category).opacity = value;
      renderer.setLayerOpacity?.(layer.category, value);
    });

    group.append(legend, visibilityLabel, opacityLabel);
    container.append(group);
  }

  return {
    getLayers: () => layers.map((layer) => ({
      ...layer,
      geometries: [...layer.geometries],
      style: { ...layer.style },
    })),
    getState: (category) => {
      const state = states.get(category);
      return state ? { ...state } : null;
    },
  };
}
