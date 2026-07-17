import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadTimeAtlasPage } from './helpers/loadTimeAtlasPage.js';

vi.mock('../fe-artifacts/assets/js/dataClient.js', () => ({
  fetchAtlasCity: vi.fn(),
}));

import { startTimeAtlas } from '../fe-artifacts/assets/js/time-atlas.js';

const featureCollection = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      id: 'early',
      geometry: { type: 'Point', coordinates: [-122.4, 37.8] },
      properties: { start_year: 1850, end_year: 1930 },
    },
    {
      type: 'Feature',
      id: 'later',
      geometry: { type: 'Point', coordinates: [-122.5, 37.7] },
      properties: { start_year: 1920, end_year: null },
    },
  ],
};

function successfulCity() {
  return { status: 'success', featureCollection };
}

function rendererHarness() {
  const renderer = { renderFeatures: vi.fn() };
  let options;
  return {
    renderer,
    createRenderer: vi.fn().mockImplementation(async (value) => {
      options = value;
      return renderer;
    }),
    getOptions: () => options,
  };
}

beforeEach(() => {
  loadTimeAtlasPage();
  window.history.replaceState({}, '', '/tools/time-atlas.html');
});

describe('Time Atlas bootstrap', () => {
  it('provides full-viewport layout hooks and an explicit geometry legend', () => {
    const page = document.getElementById('timeAtlas');
    const legend = document.querySelector('.atlas-legend');

    expect(document.body.classList.contains('atlas-body')).toBe(true);
    expect(page.classList.contains('atlas-page--viewport')).toBe(true);
    expect(document.querySelector('.atlas-topbar #atlasTimeline')).toBeTruthy();
    expect(legend.textContent).toContain('Large shaded regions: neighborhoods');
    expect(legend.textContent).toContain('smaller building footprints: landmarks');
  });

  it('keeps a stable loading state while the city request is pending', async () => {
    let resolveRequest;
    const fetchCity = vi.fn(() => new Promise((resolve) => {
      resolveRequest = resolve;
    }));
    const { createRenderer } = rendererHarness();

    const boot = startTimeAtlas({ fetchCity, createRenderer });

    expect(document.getElementById('timeAtlas').dataset.state).toBe('loading');
    expect(document.getElementById('atlasStateMessage').textContent).toContain('Loading');
    expect(document.querySelector('.atlas-shell')).toBeTruthy();

    resolveRequest({ status: 'empty', featureCollection: { type: 'FeatureCollection', features: [] } });
    await boot;
  });

  it('renders the configured initial checkpoint at boot', async () => {
    const fetchCity = vi.fn().mockResolvedValue(successfulCity());
    const { renderer, createRenderer } = rendererHarness();

    const app = await startTimeAtlas({ fetchCity, createRenderer });

    expect(app.getCheckpoint()).toBe(1910);
    expect(document.getElementById('atlasCheckpointLabel').textContent).toBe('1910s');
    expect(renderer.renderFeatures).toHaveBeenCalledTimes(1);
    expect(renderer.renderFeatures.mock.calls[0][0].features.map((feature) => feature.id))
      .toEqual(['early']);
    expect(createRenderer).toHaveBeenCalledWith(expect.objectContaining({
      center: [-122.44, 37.76],
      zoom: 11.5,
    }));
  });

  it('updates local render state without fetching the city again', async () => {
    const fetchCity = vi.fn().mockResolvedValue(successfulCity());
    const { renderer, createRenderer } = rendererHarness();
    await startTimeAtlas({ fetchCity, createRenderer });

    document.getElementById('atlasCheckpoint').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
    );

    expect(document.getElementById('atlasCheckpointLabel').textContent).toBe('1930s');
    expect(renderer.renderFeatures).toHaveBeenCalledTimes(2);
    expect(renderer.renderFeatures.mock.calls[1][0].features.map((feature) => feature.id))
      .toEqual(['later']);
    expect(fetchCity).toHaveBeenCalledTimes(1);
  });

  it('shows and clears hover details without refetching or recreating the map', async () => {
    const fetchCity = vi.fn().mockResolvedValue(successfulCity());
    const harness = rendererHarness();
    await startTimeAtlas({ fetchCity, createRenderer: harness.createRenderer });
    const feature = {
      type: 'Feature',
      id: 'ohm:way/42',
      properties: {
        name: null,
        layer: 'landmarks',
        start_date: '1915',
        end_date: '1916',
        source: 'ohm',
        source_id: 'way/42',
      },
    };

    harness.getOptions().onFeatureHover(feature);

    const details = document.getElementById('atlasHoverDetails');
    expect(details.hidden).toBe(false);
    expect(details.textContent).toContain('Unnamed feature');
    expect(details.textContent).toContain('landmarks');
    expect(details.textContent).toContain('1915 – 1916');
    expect(details.textContent).toContain('ohm:way/42');

    harness.getOptions().onFeatureHover(null);

    expect(details.hidden).toBe(true);
    expect(details.textContent).toBe('');
    expect(fetchCity).toHaveBeenCalledTimes(1);
    expect(harness.createRenderer).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['empty', { status: 'empty', featureCollection: { type: 'FeatureCollection', features: [] } }, 'No atlas features'],
    ['unknown-city', { status: 'unknown-city', featureCollection: null }, 'not available'],
  ])('shows the %s city state', async (state, result, message) => {
    const fetchCity = vi.fn().mockResolvedValue(result);
    const { createRenderer } = rendererHarness();

    await startTimeAtlas({ fetchCity, createRenderer });

    expect(document.getElementById('timeAtlas').dataset.state).toBe(state);
    expect(document.getElementById('atlasStateMessage').textContent).toContain(message);
    expect(createRenderer).not.toHaveBeenCalled();
  });

  it('shows a retryable failure and retries the city request', async () => {
    const fetchCity = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({
        status: 'empty',
        featureCollection: { type: 'FeatureCollection', features: [] },
      });
    const { createRenderer } = rendererHarness();

    const app = await startTimeAtlas({ fetchCity, createRenderer });
    expect(document.getElementById('timeAtlas').dataset.state).toBe('failure');
    expect(document.getElementById('atlasRetry').hidden).toBe(false);

    await app.retry();

    expect(fetchCity).toHaveBeenCalledTimes(2);
    expect(document.getElementById('timeAtlas').dataset.state).toBe('empty');
  });
});
