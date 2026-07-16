export function featuresAtCheckpoint(featureCollection, checkpoint) {
  return {
    type: 'FeatureCollection',
    features: featureCollection.features.filter((feature) => {
      const start = feature.properties?.start_year;
      const end = feature.properties?.end_year;
      return Number.isFinite(start)
        && start <= checkpoint
        && (end === null || end === undefined || checkpoint < end);
    }),
  };
}

export function createTimeline({
  checkpoints,
  initialCheckpoint,
  control,
  output,
  onChange,
}) {
  if (!checkpoints.includes(initialCheckpoint)) {
    throw new Error('Initial checkpoint must be in the configured checkpoint list');
  }

  let currentIndex = checkpoints.indexOf(initialCheckpoint);
  control.min = '0';
  control.max = String(checkpoints.length - 1);
  control.step = '1';

  function updateControl() {
    const checkpoint = checkpoints[currentIndex];
    control.value = String(currentIndex);
    control.setAttribute('aria-valuetext', `${checkpoint}s`);
    output.textContent = `${checkpoint}s`;
  }

  function select(checkpoint) {
    const nextIndex = checkpoints.indexOf(checkpoint);
    if (nextIndex === -1 || nextIndex === currentIndex) return false;
    currentIndex = nextIndex;
    updateControl();
    onChange(checkpoint);
    return true;
  }

  function selectIndex(index) {
    const bounded = Math.max(0, Math.min(checkpoints.length - 1, index));
    return select(checkpoints[bounded]);
  }

  control.addEventListener('input', () => {
    selectIndex(Number(control.value));
  });

  control.addEventListener('keydown', (event) => {
    const nextIndex = {
      ArrowLeft: currentIndex - 1,
      ArrowDown: currentIndex - 1,
      ArrowRight: currentIndex + 1,
      ArrowUp: currentIndex + 1,
      Home: 0,
      End: checkpoints.length - 1,
    }[event.key];
    if (nextIndex === undefined) return;
    event.preventDefault();
    selectIndex(nextIndex);
  });

  updateControl();

  return {
    getCheckpoint: () => checkpoints[currentIndex],
    getCheckpoints: () => [...checkpoints],
    select,
  };
}
