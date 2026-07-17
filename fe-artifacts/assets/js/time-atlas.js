import { fetchAtlasCity } from './dataClient.js';
import { getTimeAtlasCityConfig } from './time-atlas-config.js';
import { createLayerController } from './time-atlas-layers.js';
import { createTimeAtlasMap } from './time-atlas-map.js';
import { createTimeline, featuresAtCheckpoint } from './time-atlas-timeline.js';
import { createCheckpointTransition } from './time-atlas-transitions.js';

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
  const layerPanel = document.getElementById('atlasLayers');
  const layerControls = document.getElementById('atlasLayerControls');
  const featureDetails = document.getElementById('atlasFeatureDetails')
    ?? document.getElementById('atlasHoverDetails');

  const city = getTimeAtlasCityConfig(citySlug);
  let featureCollection = null;
  let renderer = null;
  let timeline = null;
  let transitions = null;
  let selectedFeature = null;

  function showState(state, message = STATE_MESSAGES[state]) {
    app.dataset.state = state;
    statePanel.hidden = state === 'ready';
    stateMessage.textContent = message ?? '';
    retryButton.hidden = state !== 'failure';
    timelinePanel.hidden = state !== 'ready';
    layerPanel.hidden = state !== 'ready';
  }

  function renderCheckpoint(checkpoint) {
    transitions.transitionTo(featuresAtCheckpoint(featureCollection, checkpoint));
    selectedFeature = null;
    showFeatureDetails(null);
  }

  function showFeatureDetails(feature, { selected = false } = {}) {
    featureDetails.replaceChildren();
    featureDetails.hidden = !feature;
    if (!feature) return;

    const details = formatFeatureDetails(feature);
    if (selected) {
      const heading = document.createElement('strong');
      heading.textContent = 'Feature details';
      featureDetails.append(heading);
    }
    const list = document.createElement('dl');
    for (const [label, value] of details) {
      const term = document.createElement('dt');
      const description = document.createElement('dd');
      term.textContent = label;
      description.textContent = value;
      list.append(term, description);
    }
    featureDetails.append(list);
  }

  function hoverFeature(feature) {
    showFeatureDetails(feature ?? selectedFeature, { selected: !feature && Boolean(selectedFeature) });
  }

  function selectFeature(feature) {
    selectedFeature = feature;
    showFeatureDetails(feature, { selected: true });
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
        onFeatureHover: hoverFeature,
        onFeatureSelect: selectFeature,
      });
      transitions = createCheckpointTransition({
        renderer: {
          setCheckpointStates(states, options) {
            if (renderer.setCheckpointStates) {
              renderer.setCheckpointStates(states, options);
            } else {
              renderer.renderFeatures(states.at(-1).featureCollection);
            }
          },
        },
      });
      createLayerController({
        featureCollection,
        container: layerControls,
        renderer,
      });

      timeline = createTimeline({
        checkpoints: city.checkpoints,
        initialCheckpoint: city.initialCheckpoint,
        control: timelineControl,
        output: timelineOutput,
        onChange: renderCheckpoint,
      });
      transitions.settle(featuresAtCheckpoint(featureCollection, timeline.getCheckpoint()));
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

export function formatFeatureDetails(feature) {
  const properties = feature?.properties ?? {};
  const start = properties.start_date ?? 'unknown start';
  const end = properties.end_date ?? 'present';
  const identity = properties.source_id ?? feature?.id ?? 'unknown identity';
  return [
    ['Name', properties.name || 'Unnamed feature'],
    ['Category', properties.layer || 'uncategorized'],
    ['Dates', `${start} – ${end}`],
    ['Source', `${properties.source || 'unknown'}:${identity}`],
  ];
}

export const formatHoverDetails = formatFeatureDetails;
