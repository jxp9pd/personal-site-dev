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

export function createCollapsiblePanel({
  button,
  content,
  narrowScreen = window.matchMedia?.('(max-width: 640px)'),
}) {
  function setExpanded(expanded) {
    button.setAttribute('aria-expanded', String(expanded));
    button.textContent = expanded ? 'Hide controls' : 'Show controls';
    content.hidden = !expanded;
  }

  button.addEventListener('click', () => {
    setExpanded(button.getAttribute('aria-expanded') !== 'true');
  });

  if (narrowScreen) {
    const syncToViewport = ({ matches }) => setExpanded(!matches);
    syncToViewport(narrowScreen);
    narrowScreen.addEventListener?.('change', syncToViewport);
  }

  return { setExpanded };
}

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
  const layerToggle = document.getElementById('atlasLayerToggle');
  const layerPanelBody = document.getElementById('atlasLayerPanelBody');
  const featurePicker = document.getElementById('atlasFeaturePicker');
  const featureDetails = document.getElementById('atlasFeatureDetails')
    ?? document.getElementById('atlasHoverDetails');

  const city = getTimeAtlasCityConfig(citySlug);
  let featureCollection = null;
  let renderer = null;
  let timeline = null;
  let transitions = null;
  let selectedFeature = null;
  let featuresByPickerValue = new Map();

  createCollapsiblePanel({
    button: layerToggle,
    content: layerPanelBody,
  });

  function showState(state, message = STATE_MESSAGES[state]) {
    app.dataset.state = state;
    statePanel.hidden = state === 'ready';
    stateMessage.textContent = message ?? '';
    retryButton.hidden = state !== 'failure';
    timelinePanel.hidden = state !== 'ready';
    layerPanel.hidden = state !== 'ready';
  }

  function renderCheckpoint(checkpoint) {
    const visibleFeatures = featuresAtCheckpoint(featureCollection, checkpoint);
    transitions.transitionTo(visibleFeatures);
    selectedFeature = null;
    showFeatureDetails(null);
    updateFeaturePicker(visibleFeatures);
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
    const matchingValue = [...featuresByPickerValue.entries()]
      .find(([, candidate]) => String(candidate.id) === String(feature.id))?.[0];
    featurePicker.value = matchingValue ?? '';
  }

  function updateFeaturePicker(visibleFeatures) {
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Choose a visible feature';
    featurePicker.replaceChildren(placeholder);
    featuresByPickerValue = new Map();

    const features = [...visibleFeatures.features].sort((left, right) => (
      (left.properties?.name || 'Unnamed feature').localeCompare(
        right.properties?.name || 'Unnamed feature',
      )
      || String(left.id).localeCompare(String(right.id))
    ));
    features.forEach((feature, index) => {
      const option = document.createElement('option');
      const value = `${feature.id ?? 'feature'}:${index}`;
      option.value = value;
      option.textContent = `${feature.properties?.name || 'Unnamed feature'}`
        + ` — ${feature.properties?.layer || 'uncategorized'}`;
      featuresByPickerValue.set(value, feature);
      featurePicker.append(option);
    });
    featurePicker.value = '';
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
      const initialFeatures = featuresAtCheckpoint(featureCollection, timeline.getCheckpoint());
      transitions.settle(initialFeatures);
      updateFeaturePicker(initialFeatures);
      showState('ready');
    } catch {
      showState('failure');
    }
  }

  retryButton.addEventListener('click', load);
  featurePicker.addEventListener('change', () => {
    const feature = featuresByPickerValue.get(featurePicker.value);
    if (!feature) {
      selectedFeature = null;
      showFeatureDetails(null);
      return;
    }
    selectFeature(feature);
    featureDetails.focus();
  });
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
