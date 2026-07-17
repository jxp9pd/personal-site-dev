export function createCheckpointTransition({
  renderer,
  duration = 220,
  scheduleFrame = (callback) => requestAnimationFrame(callback),
  cancelFrame = (handle) => cancelAnimationFrame(handle),
  scheduleCleanup = (callback, delay) => setTimeout(callback, delay),
  cancelCleanup = (handle) => clearTimeout(handle),
}) {
  let settled = null;
  let requested = null;
  let frameHandle = null;
  let cleanupHandle = null;
  let revision = 0;

  function cancelPending() {
    if (frameHandle !== null) cancelFrame(frameHandle);
    if (cleanupHandle !== null) cancelCleanup(cleanupHandle);
    frameHandle = null;
    cleanupHandle = null;
  }

  function settle(featureCollection) {
    cancelPending();
    settled = featureCollection;
    requested = featureCollection;
    renderer.setCheckpointStates([
      { key: `settled-${revision}`, featureCollection, opacity: 1 },
    ]);
  }

  function transitionTo(featureCollection) {
    if (!settled) {
      settle(featureCollection);
      return;
    }

    cancelPending();
    revision += 1;
    const transitionRevision = revision;
    const previous = requested ?? settled;
    requested = featureCollection;
    const states = [
      { key: `previous-${transitionRevision}`, featureCollection: previous, opacity: 1 },
      { key: `next-${transitionRevision}`, featureCollection, opacity: 0 },
    ];
    renderer.setCheckpointStates(states);

    frameHandle = scheduleFrame(() => {
      frameHandle = null;
      if (transitionRevision !== revision) return;
      renderer.setCheckpointStates([
        { ...states[0], opacity: 0 },
        { ...states[1], opacity: 1 },
      ], { duration });
    });

    cleanupHandle = scheduleCleanup(() => {
      cleanupHandle = null;
      if (transitionRevision !== revision) return;
      settled = featureCollection;
      renderer.setCheckpointStates([
        { key: `settled-${transitionRevision}`, featureCollection, opacity: 1 },
      ]);
    }, duration + 34);
  }

  return {
    settle,
    transitionTo,
  };
}
