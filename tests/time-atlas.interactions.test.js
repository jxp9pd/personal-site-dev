import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../fe-artifacts/assets/js/dataClient.js', () => ({
  fetchAtlasCity: vi.fn(),
}));

import {
  createCollapsiblePanel,
  startTimeAtlas,
} from '../fe-artifacts/assets/js/time-atlas.js';
import { discoverAtlasLayers } from '../fe-artifacts/assets/js/time-atlas-layers.js';
import { createTimeAtlasMap } from '../fe-artifacts/assets/js/time-atlas-map.js';
import { createCheckpointTransition } from '../fe-artifacts/assets/js/time-atlas-transitions.js';
import { loadTimeAtlasPage } from './helpers/loadTimeAtlasPage.js';

const feature = {
  type: 'Feature',
  id: 'ohm:way/42',
  geometry: { type: 'Point', coordinates: [-122.4, 37.8] },
  properties: {
    name: 'Ferry Building',
    layer: 'landmarks',
    start_date: '1898-??',
    end_date: null,
    start_year: 1898,
    end_year: null,
    source: 'ohm',
    source_id: 'way/42',
  },
};

const laterFeature = {
  ...feature,
  id: 'curated:transamerica',
  properties: {
    ...feature.properties,
    name: 'Transamerica Pyramid',
    start_date: '1969',
    source: 'curated',
    source_id: 'transamerica',
  },
};

function cityResult() {
  return {
    status: 'success',
    featureCollection: { type: 'FeatureCollection', features: [feature, laterFeature] },
  };
}

function rendererHarness() {
  let options;
  const renderer = {
    setCheckpointStates: vi.fn(),
  };
  return {
    renderer,
    createRenderer: vi.fn(async (value) => {
      options = value;
      return renderer;
    }),
    getOptions: () => options,
  };
}

function transitionHarness() {
  const frames = [];
  const cleanups = [];
  const renderer = { setCheckpointStates: vi.fn() };
  const transition = createCheckpointTransition({
    renderer,
    duration: 200,
    scheduleFrame(callback) {
      frames.push(callback);
      return callback;
    },
    cancelFrame(callback) {
      const index = frames.indexOf(callback);
      if (index >= 0) frames.splice(index, 1);
    },
    scheduleCleanup(callback) {
      cleanups.push(callback);
      return callback;
    },
    cancelCleanup(callback) {
      const index = cleanups.indexOf(callback);
      if (index >= 0) cleanups.splice(index, 1);
    },
  });
  return {
    renderer,
    transition,
    runFrame: () => frames.shift()?.(),
    runCleanup: () => cleanups.shift()?.(),
  };
}

beforeEach(() => {
  loadTimeAtlasPage();
  window.history.replaceState({}, '', '/tools/time-atlas.html');
});

describe('Time Atlas feature interactions', () => {
  it('uses public MapLibre APIs for hover and unified click/tap selection', async () => {
    const source = { setData: vi.fn() };
    const map = {
      loaded: vi.fn(() => true),
      addSource: vi.fn(),
      addLayer: vi.fn(),
      getSource: vi.fn(() => source),
      getCanvas: vi.fn(() => ({ style: {} })),
      on: vi.fn(),
      setPaintProperty: vi.fn(),
      setFeatureState: vi.fn(),
    };
    const Map = class {
      constructor() {
        return map;
      }
    };
    const onFeatureSelect = vi.fn();
    const renderer = await createTimeAtlasMap({
      container: document.createElement('div'),
      center: [-122.44, 37.76],
      zoom: 11.5,
      onFeatureSelect,
      mapLibreLoader: async () => ({ Map }),
    });
    renderer.configureLayers(discoverAtlasLayers(cityResult().featureCollection));
    const move = map.on.mock.calls.find(([event]) => event === 'mousemove')[2];
    const leave = map.on.mock.calls.find(([event]) => event === 'mouseleave')[2];
    const select = map.on.mock.calls.find(([event]) => event === 'click')[2];

    move({ features: [{ ...feature, source: 'atlas-features' }] });
    leave();
    select({ features: [feature], originalEvent: new MouseEvent('click') });
    select({ features: [feature], originalEvent: new Event('touchend') });

    expect(map.setFeatureState).toHaveBeenNthCalledWith(
      1,
      { source: 'atlas-features', id: feature.id },
      { hover: true },
    );
    expect(map.setFeatureState).toHaveBeenNthCalledWith(
      2,
      { source: 'atlas-features', id: feature.id },
      { hover: false },
    );
    expect(onFeatureSelect).toHaveBeenNthCalledWith(1, feature);
    expect(onFeatureSelect).toHaveBeenNthCalledWith(2, feature);
  });

  it('emphasizes hovered features and cleans up without changing render state', async () => {
    const fetchCity = vi.fn().mockResolvedValue(cityResult());
    const harness = rendererHarness();
    await startTimeAtlas({ fetchCity, createRenderer: harness.createRenderer });

    harness.getOptions().onFeatureHover(feature);
    expect(document.getElementById('atlasHoverDetails').textContent).toContain('Ferry Building');

    harness.getOptions().onFeatureHover(null);
    expect(document.getElementById('atlasHoverDetails').hidden).toBe(true);
    expect(harness.renderer.setCheckpointStates).toHaveBeenCalledTimes(1);
    expect(fetchCity).toHaveBeenCalledTimes(1);
  });

  it.each(['mouse click', 'touch tap'])('%s opens equivalent complete details', async () => {
    const fetchCity = vi.fn().mockResolvedValue(cityResult());
    const harness = rendererHarness();
    await startTimeAtlas({ fetchCity, createRenderer: harness.createRenderer });

    harness.getOptions().onFeatureSelect(feature);

    const details = document.getElementById('atlasHoverDetails');
    expect(details.hidden).toBe(false);
    expect(details.textContent).toContain('Ferry Building');
    expect(details.textContent).toContain('1898-?? – present');
    expect(details.textContent).toContain('landmarks');
    expect(details.textContent).toContain('ohm:way/42');
    expect(fetchCity).toHaveBeenCalledTimes(1);
    expect(harness.createRenderer).toHaveBeenCalledTimes(1);
  });

  it('provides a keyboard-reachable path to selected feature details', async () => {
    const fetchCity = vi.fn().mockResolvedValue(cityResult());
    const harness = rendererHarness();
    await startTimeAtlas({ fetchCity, createRenderer: harness.createRenderer });

    const picker = document.getElementById('atlasFeaturePicker');
    picker.value = [...picker.options].find((option) => option.textContent.includes('Ferry Building')).value;
    picker.dispatchEvent(new Event('change', { bubbles: true }));

    const details = document.getElementById('atlasHoverDetails');
    expect(details.hidden).toBe(false);
    expect(details.textContent).toContain('Ferry Building');
    expect(document.activeElement).toBe(details);
    expect(fetchCity).toHaveBeenCalledTimes(1);
  });

  it('collapses map controls on narrow screens and toggles them by button', () => {
    const button = document.getElementById('atlasLayerToggle');
    const content = document.getElementById('atlasLayerPanelBody');

    createCollapsiblePanel({
      button,
      content,
      narrowScreen: { matches: true, addEventListener: vi.fn() },
    });

    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(content.hidden).toBe(true);
    button.click();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(content.hidden).toBe(false);
  });
});

describe('Time Atlas checkpoint transitions', () => {
  const checkpoint = (id) => ({
    type: 'FeatureCollection',
    features: [{ ...feature, id }],
  });

  it('keeps previous and next states only during the cross-fade', () => {
    const harness = transitionHarness();
    const previous = checkpoint('previous');
    const next = checkpoint('next');

    harness.transition.settle(previous);
    harness.transition.transitionTo(next);

    expect(harness.renderer.setCheckpointStates.mock.calls.at(-1)[0]).toEqual([
      expect.objectContaining({ featureCollection: previous, opacity: 1 }),
      expect.objectContaining({ featureCollection: next, opacity: 0 }),
    ]);

    harness.runFrame();
    expect(harness.renderer.setCheckpointStates.mock.calls.at(-1)[0].map((state) => state.opacity))
      .toEqual([0, 1]);

    harness.runCleanup();
    const settled = harness.renderer.setCheckpointStates.mock.calls.at(-1)[0];
    expect(settled).toHaveLength(1);
    expect(settled[0]).toEqual(expect.objectContaining({ featureCollection: next, opacity: 1 }));
  });

  it('removes stale work and settles the final rapid request', () => {
    const harness = transitionHarness();
    const first = checkpoint('first');
    const stale = checkpoint('stale');
    const final = checkpoint('final');

    harness.transition.settle(first);
    harness.transition.transitionTo(stale);
    harness.transition.transitionTo(final);
    harness.runFrame();
    harness.runCleanup();

    const settled = harness.renderer.setCheckpointStates.mock.calls.at(-1)[0];
    expect(settled).toHaveLength(1);
    expect(settled[0].featureCollection).toBe(final);
    expect(harness.renderer.setCheckpointStates.mock.calls.some(([states]) => (
      states.length === 1 && states[0].featureCollection === stale
    ))).toBe(false);
  });
});
