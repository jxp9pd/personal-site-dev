import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLayerController,
  discoverAtlasLayers,
} from '../fe-artifacts/assets/js/time-atlas-layers.js';
import { createTimeAtlasMap } from '../fe-artifacts/assets/js/time-atlas-map.js';

vi.mock('../fe-artifacts/assets/js/dataClient.js', () => ({
  fetchAtlasCity: vi.fn(),
}));

import { startTimeAtlas } from '../fe-artifacts/assets/js/time-atlas.js';
import { loadTimeAtlasPage } from './helpers/loadTimeAtlasPage.js';

const features = {
  type: 'FeatureCollection',
  features: [
    feature('neighborhood', 'neighborhoods', 'Polygon', 1850),
    feature('landmark-area', 'landmarks', 'Polygon', 1850),
    feature('landmark-point', 'landmarks', 'Point', 1930),
    feature('future-area', 'future_places', 'MultiPolygon', 1850),
    feature('future-line', 'future_places', 'LineString', 1850),
    feature('future-point', 'future_places', 'Point', 1850),
  ],
};

function feature(id, layer, geometry, startYear) {
  const coordinates = geometry.includes('Point') ? [-122.4, 37.8] : [];
  return {
    type: 'Feature',
    id,
    geometry: { type: geometry, coordinates },
    properties: { layer, start_year: startYear, end_year: null },
  };
}

function rendererHarness() {
  return {
    configureLayers: vi.fn(),
    renderFeatures: vi.fn(),
    setLayerVisibility: vi.fn(),
    setLayerOpacity: vi.fn(),
  };
}

function mapHarness() {
  const source = { setData: vi.fn() };
  const map = {
    loaded: vi.fn(() => true),
    addSource: vi.fn(),
    addLayer: vi.fn(),
    getSource: vi.fn(() => source),
    getCanvas: vi.fn(() => ({ style: {} })),
    on: vi.fn(),
    setLayoutProperty: vi.fn(),
    setPaintProperty: vi.fn(),
  };
  const Map = class {
    constructor() {
      return map;
    }
  };
  return { map, Map };
}

beforeEach(() => {
  loadTimeAtlasPage();
  window.history.replaceState({}, '', '/tools/time-atlas.html');
});

describe('Time Atlas layer controller', () => {
  it('discovers distinct categories and creates meaningful accessible controls', () => {
    const renderer = rendererHarness();
    const container = document.getElementById('atlasLayerControls');

    createLayerController({ featureCollection: features, container, renderer });

    const groups = [...container.querySelectorAll('fieldset')];
    expect(groups.map((group) => group.dataset.layer))
      .toEqual(['future_places', 'landmarks', 'neighborhoods']);
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(3);
    expect(container.querySelectorAll('input[type="range"]')).toHaveLength(3);
    expect(container.querySelector('[aria-label="Show Neighborhoods layer"]')).toBeTruthy();
    expect(container.querySelector('[aria-label="Landmarks layer opacity"]')).toBeTruthy();
    expect(container.querySelector('[aria-label="Future Places layer opacity"]')).toBeTruthy();
  });

  it('uses known styles and geometry-appropriate defaults for future categories', () => {
    const layers = discoverAtlasLayers(features);
    const neighborhoods = layers.find(({ category }) => category === 'neighborhoods');
    const landmarks = layers.find(({ category }) => category === 'landmarks');
    const future = layers.find(({ category }) => category === 'future_places');

    expect(neighborhoods.style).toMatchObject({ color: '#4f746c', fillOpacity: 0.24 });
    expect(landmarks.style).toMatchObject({ color: '#b85c38', fillOpacity: 0.42 });
    expect(future.geometries).toEqual(['MultiPolygon', 'LineString', 'Point']);
    expect(future.style.fillOpacity).toBeGreaterThan(0);
    expect(future.style.lineOpacity).toBeGreaterThan(0);
    expect(future.style.pointOpacity).toBeGreaterThan(0);
    expect(future.style.color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('isolates visibility and opacity changes to their selected category', () => {
    const renderer = rendererHarness();
    const container = document.getElementById('atlasLayerControls');
    const controller = createLayerController({ featureCollection: features, container, renderer });
    const landmarks = container.querySelector('[data-layer="landmarks"]');
    const visibility = landmarks.querySelector('input[type="checkbox"]');
    const opacity = landmarks.querySelector('input[type="range"]');

    visibility.checked = false;
    visibility.dispatchEvent(new Event('change'));
    opacity.value = '35';
    opacity.dispatchEvent(new Event('input'));

    expect(renderer.setLayerVisibility).toHaveBeenCalledOnce();
    expect(renderer.setLayerVisibility).toHaveBeenCalledWith('landmarks', false);
    expect(renderer.setLayerOpacity).toHaveBeenCalledOnce();
    expect(renderer.setLayerOpacity).toHaveBeenCalledWith('landmarks', 0.35);
    expect(controller.getState('landmarks')).toEqual({ visible: false, opacity: 0.35 });
    expect(controller.getState('neighborhoods')).toEqual({ visible: true, opacity: 1 });
  });

  it('keeps layer preferences and timeline state independent', async () => {
    const renderer = rendererHarness();
    await startTimeAtlas({
      fetchCity: vi.fn().mockResolvedValue({ status: 'success', featureCollection: features }),
      createRenderer: vi.fn().mockResolvedValue(renderer),
    });
    const opacity = document.querySelector(
      '[data-layer="neighborhoods"] input[type="range"]',
    );
    opacity.value = '40';
    opacity.dispatchEvent(new Event('input'));

    expect(document.getElementById('atlasCheckpointLabel').textContent).toBe('1910s');
    expect(opacity.value).toBe('40');

    document.getElementById('atlasCheckpoint').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
    );

    expect(document.getElementById('atlasCheckpointLabel').textContent).toBe('1930s');
    expect(opacity.value).toBe('40');

    opacity.value = '65';
    opacity.dispatchEvent(new Event('input'));
    expect(document.getElementById('atlasCheckpointLabel').textContent).toBe('1930s');
  });

  it('adds fills below outlines and interactive points in deterministic order', async () => {
    const { map, Map } = mapHarness();
    const renderer = await createTimeAtlasMap({
      container: document.createElement('div'),
      center: [-122.44, 37.76],
      zoom: 11.5,
      mapLibreLoader: async () => ({ Map }),
    });
    renderer.configureLayers(discoverAtlasLayers(features));

    const added = map.addLayer.mock.calls
      .map(([layer]) => layer)
      .filter(({ source }) => source === 'atlas-features');
    expect(added.map(({ id }) => id)).toEqual([
      'atlas-future_places-fill',
      'atlas-landmarks-fill',
      'atlas-neighborhoods-fill',
      'atlas-future_places-outline',
      'atlas-landmarks-outline',
      'atlas-neighborhoods-outline',
      'atlas-future_places-line',
      'atlas-future_places-point',
      'atlas-landmarks-point',
    ]);
    expect(added.slice(0, 3).every(({ type }) => type === 'fill')).toBe(true);
    expect(added.slice(-2).every(({ type }) => type === 'circle')).toBe(true);

    renderer.setCheckpointStates([
      { featureCollection: features, opacity: 1 },
      { featureCollection: features, opacity: 0 },
    ]);
    const transitionCalls = map.addLayer.mock.calls.slice(added.length);
    for (const [layer, beforeId] of transitionCalls) {
      if (layer.type === 'fill') expect(beforeId).toContain('-outline');
      if (layer.id.includes('-outline-transition')) expect(beforeId).toContain('-line');
      if (layer.id.includes('-line-transition')) expect(beforeId).toContain('-point');
      if (layer.type === 'circle') expect(beforeId).toBeUndefined();
    }
  });
});
