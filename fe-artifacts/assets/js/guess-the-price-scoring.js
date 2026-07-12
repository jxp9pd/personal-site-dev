// Pure scoring for Guess the Price. No I/O, no DOM, no imports — safe to run in
// the browser via `<script type="module">` and in Node (Vitest) alike, like
// stats.js.
//
// GeoGuessr-style falloff: a guess's points decay exponentially with its
// relative error. K controls how forgiving that decay is (larger = gentler).
// An empty/invalid guess is treated as infinite error so it scores 0 and
// contributes 0 accuracy — no special-casing downstream.

export const K = 0.35;

// Coerces a raw guess (often a string from an input field) to a number, mapping
// the "no real guess" cases (null, undefined, blank, non-numeric) to NaN.
function toGuess(guess) {
  if (guess === null || guess === undefined) return NaN;
  if (typeof guess === 'string' && guess.trim() === '') return NaN;
  return Number(guess);
}

// Relative error |guess - actual| / actual. A null/empty/NaN guess yields
// maximal (infinite) error so it scores 0.
export function errorPct(guess, actual) {
  const g = toGuess(guess);
  if (Number.isNaN(g)) return Infinity;
  return Math.abs(g - actual) / actual;
}

// Points for one guess: 1000 at a perfect guess, decaying with relative error,
// clamped to [0, 1000]. Empty/invalid guess → 0 (errorPct is Infinity, so the
// exponential underflows to 0).
export function scorePoints(guess, actual) {
  const raw = Math.round(1000 * Math.exp(-errorPct(guess, actual) / K));
  return Math.max(0, Math.min(1000, raw));
}

// Aggregates per-item results (each carrying at least `errorPct` and `points`)
// into a round summary. `avgAccuracy` is a 0–100 percent: the mean of each
// item's accuracy 1 - min(errorPct, 1), so a wildly wrong or empty guess floors
// at 0 rather than dragging the mean negative. An empty round → avgAccuracy 0.
export function aggregateRound(results) {
  const itemCount = results.length;
  const totalPoints = results.reduce((sum, r) => sum + r.points, 0);
  const maxPoints = itemCount * 1000;
  const avgAccuracy =
    itemCount === 0
      ? 0
      : Math.round(
          (results.reduce((sum, r) => sum + (1 - Math.min(r.errorPct, 1)), 0) / itemCount) * 100,
        );
  return { totalPoints, maxPoints, avgAccuracy };
}
