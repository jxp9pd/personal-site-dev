import { describe, expect, it, vi } from 'vitest';
import { createTimeAtlasMap } from '../fe-artifacts/assets/js/time-atlas-map.js';

function mapHarness() {
  const source = { setData: vi.fn() };
  const map = {
    loaded: vi.fn(() => true),
    addSource: vi.fn(),
    addLayer: vi.fn(),
    getSource: vi.fn(() => source),
    getCanvas: vi.fn(() => ({ style: {} })),
    on: vi.fn(),
  };
  const Map = class {
    constructor() {
      return map;
    }
  };
  return { map, Map, source };
}

describe('Time Atlas map adapter', () => {
  it('separates neighborhood regions from landmark footprints', async () => {
    const { map, Map } = mapHarness();

    await createTimeAtlasMap({
      container: document.createElement('div'),
      center: [-122.44, 37.76],
      zoom: 11.5,
      mapLibreLoader: async () => ({ Map }),
    });

    const layers = map.addLayer.mock.calls.map(([layer]) => layer);
    const neighborhoods = layers.find((layer) => layer.id === 'atlas-neighborhoods');
    const landmarks = layers.find((layer) => layer.id === 'atlas-landmark-polygons');
    expect(neighborhoods.filter).toContainEqual(['==', ['get', 'layer'], 'neighborhoods']);
    expect(landmarks.filter).toContainEqual(['==', ['get', 'layer'], 'landmarks']);
  });

  it('forwards hover and cleanup through the narrow adapter', async () => {
    const { map, Map } = mapHarness();
    const onFeatureHover = vi.fn();
    const renderer = await createTimeAtlasMap({
      container: document.createElement('div'),
      center: [-122.44, 37.76],
      zoom: 11.5,
      onFeatureHover,
      mapLibreLoader: async () => ({ Map }),
    });
    const feature = { id: 'ohm:node/7', properties: { layer: 'landmarks' } };
    const move = map.on.mock.calls.find(([event]) => event === 'mousemove')[2];
    const leave = map.on.mock.calls.find(([event]) => event === 'mouseleave')[2];

    move({ features: [feature] });
    leave();
    renderer.renderFeatures({ type: 'FeatureCollection', features: [feature] });

    expect(onFeatureHover).toHaveBeenNthCalledWith(1, feature);
    expect(onFeatureHover).toHaveBeenNthCalledWith(2, null);
    expect(map.getSource).toHaveBeenCalledWith('atlas-features');
  });
});
