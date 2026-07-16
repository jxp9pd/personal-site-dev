import { fetchAtlasCity } from './dataClient.js';
import { getTimeAtlasCityConfig } from './time-atlas-config.js';
import { createTimeAtlasMap } from './time-atlas-map.js';
import { createTimeline, featuresAtCheckpoint } from './time-atlas-timeline.js';

const STATE_MESSAGES = {
  loading: 'Loading San Francisco atlas data…',
  empty: 'No atlas features are available for this city yet.',
  'unknown-city': 'This city is not available in Time Atlas.',
  failure: 'Time Atlas could not load this city.',
};

export async function startTimeAtlas({
  citySlug = new URLSearchParams(window.location.search).get('city') ?? 'sf',
  fetchCity = fetchAtlasCity,
  createRenderer = createTimeAtlasMap,
} = {}) {
  const app = document.getElementById('timeAtlas');
  const mapContainer = document.getElementById('atlasMap');
  const statePanel = document.getElementById('atlasState');
  const stateMessage = document.getElementById('atlasStateMessage');
  const retryButton = document.getElementById('atlasRetry');
  const timelinePanel = document.getElementById('atlasTimeline');
  const timelineControl = document.getElementById('atlasCheckpoint');
  const timelineOutput = document.getElementById('atlasCheckpointLabel');

  const city = getTimeAtlasCityConfig(citySlug);
  let featureCollection = null;
  let renderer = null;
  let timeline = null;

  function showState(state, message = STATE_MESSAGES[state]) {
    app.dataset.state = state;
    statePanel.hidden = state === 'ready';
    stateMessage.textContent = message ?? '';
    retryButton.hidden = state !== 'failure';
    timelinePanel.hidden = state !== 'ready';
  }

  function renderCheckpoint(checkpoint) {
    renderer.renderFeatures(featuresAtCheckpoint(featureCollection, checkpoint));
  }

  async function load() {
    if (!city) {
      showState('unknown-city');
      return;
    }

    showState('loading');
    try {
      const result = await fetchCity(city.slug);
      if (result.status === 'unknown-city') {
        showState('unknown-city');
        return;
      }
      if (result.status === 'empty') {
        showState('empty');
        return;
      }

      featureCollection = result.featureCollection;
      renderer = await createRenderer({
        container: mapContainer,
        center: city.center,
        zoom: city.zoom,
      });

      timeline = createTimeline({
        checkpoints: city.checkpoints,
        initialCheckpoint: city.initialCheckpoint,
        control: timelineControl,
        output: timelineOutput,
        onChange: renderCheckpoint,
      });
      renderCheckpoint(timeline.getCheckpoint());
      showState('ready');
    } catch {
      showState('failure');
    }
  }

  retryButton.addEventListener('click', load);
  await load();

  return {
    getCheckpoint: () => timeline?.getCheckpoint() ?? null,
    retry: load,
  };
}
