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
  return {
    renderer,
    createRenderer: vi.fn().mockResolvedValue(renderer),
  };
}

beforeEach(() => {
  loadTimeAtlasPage();
  window.history.replaceState({}, '', '/tools/time-atlas.html');
});

describe('Time Atlas bootstrap', () => {
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
