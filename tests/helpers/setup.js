import { afterEach, vi } from 'vitest';

// Keep DOM tests isolated: drop the global Leaflet stub, return to real timers,
// and clear mock call history between tests. Implementations set in a file's
// vi.mock factory survive (clearAllMocks, not resetAllMocks).
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  delete globalThis.L;
});
