import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
}));

vi.mock('https://esm.sh/@supabase/supabase-js@2', () => ({
  createClient: () => ({ rpc: mocks.rpc }),
}));

import { fetchAtlasCity } from '../fe-artifacts/assets/js/dataClient.js';

const featureCollection = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      id: 'ohm:node/1',
      geometry: { type: 'Point', coordinates: [-122.4194, 37.7749] },
      properties: {
        name: 'Test Landmark',
        layer: 'landmarks',
        start_date: '1850',
        end_date: null,
        start_year: 1850,
        end_year: null,
        source: 'ohm',
        source_id: 'node/1',
      },
    },
  ],
};

describe('fetchAtlasCity', () => {
  beforeEach(() => {
    mocks.rpc.mockReset();
  });

  it('returns successful city GeoJSON', async () => {
    mocks.rpc.mockResolvedValue({ data: featureCollection, error: null });

    await expect(fetchAtlasCity('sf')).resolves.toEqual({
      status: 'success',
      featureCollection,
    });
    expect(mocks.rpc).toHaveBeenCalledWith('atlas_city_geojson', {
      p_city_slug: 'sf',
    });
  });

  it('returns a stable empty-city outcome', async () => {
    const empty = { type: 'FeatureCollection', features: [] };
    mocks.rpc.mockResolvedValue({ data: empty, error: null });

    await expect(fetchAtlasCity('empty-city')).resolves.toEqual({
      status: 'empty',
      featureCollection: empty,
    });
  });

  it('returns a stable unknown-city outcome', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: null });

    await expect(fetchAtlasCity('unknown-city')).resolves.toEqual({
      status: 'unknown-city',
      featureCollection: null,
    });
  });

  it('throws the Supabase API error unchanged', async () => {
    const apiError = new Error('network unavailable');
    mocks.rpc.mockResolvedValue({ data: null, error: apiError });

    await expect(fetchAtlasCity('sf')).rejects.toBe(apiError);
  });
});
