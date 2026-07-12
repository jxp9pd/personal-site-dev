import { describe, it, expect } from "vitest";
import {
  K,
  errorPct,
  scorePoints,
  aggregateRound,
} from "../fe-artifacts/assets/js/guess-the-price-scoring.js";

describe("scorePoints", () => {
  it("awards full points for an exact guess", () => {
    expect(scorePoints(69, 69)).toBe(1000);
  });

  it("matches frozen values computed from K=0.35", () => {
    expect(scorePoints(60, 69)).toBe(689);
    expect(scorePoints(2, 2.29)).toBe(696);
  });

  it("scores empty / invalid guesses as 0 for any positive actual", () => {
    for (const actual of [1, 2.29, 69, 1000]) {
      expect(scorePoints("", actual)).toBe(0);
      expect(scorePoints(null, actual)).toBe(0);
      expect(scorePoints(undefined, actual)).toBe(0);
      expect(scorePoints(NaN, actual)).toBe(0);
    }
  });

  it("stays within [0, 1000] across a spread of inputs", () => {
    const cases = [
      [0, 5],
      [5, 5],
      [4.9, 5],
      [50, 5], // 10x over
      [0.5, 5],
      [123.45, 67.89],
      [1_000_000, 1],
    ];
    for (const [guess, actual] of cases) {
      const pts = scorePoints(guess, actual);
      expect(pts).toBeGreaterThanOrEqual(0);
      expect(pts).toBeLessThanOrEqual(1000);
    }
  });

  it("scores a symmetric over- and under-guess equally", () => {
    const a = 42;
    expect(scorePoints(1.2 * a, a)).toBe(scorePoints(0.8 * a, a));
  });
});

describe("errorPct", () => {
  it("is the relative error for a valid guess", () => {
    expect(errorPct(60, 69)).toBeCloseTo(9 / 69, 12);
    expect(errorPct(69, 69)).toBe(0);
  });

  it("is Infinity for a null/empty/NaN guess", () => {
    expect(errorPct("", 5)).toBe(Infinity);
    expect(errorPct(null, 5)).toBe(Infinity);
    expect(errorPct(undefined, 5)).toBe(Infinity);
    expect(errorPct(NaN, 5)).toBe(Infinity);
  });
});

describe("aggregateRound", () => {
  it("sums points, sets maxPoints to itemCount x 1000, and averages accuracy", () => {
    const results = [
      { errorPct: 0, points: 1000 }, // accuracy 1
      { errorPct: 0.2, points: scorePoints(1.2 * 10, 10) }, // accuracy 0.8
      { errorPct: 0.5, points: scorePoints(1.5 * 10, 10) }, // accuracy 0.5
    ];
    const { totalPoints, maxPoints, avgAccuracy } = aggregateRound(results);
    expect(totalPoints).toBe(results.reduce((s, r) => s + r.points, 0));
    expect(maxPoints).toBe(3000);
    // mean(1, 0.8, 0.5) = 0.7666... -> round(76.66) = 77
    expect(avgAccuracy).toBe(77);
  });

  it("floors per-item accuracy at 0 for errors beyond 100%", () => {
    const results = [
      { errorPct: 0, points: 1000 }, // accuracy 1
      { errorPct: Infinity, points: 0 }, // empty guess -> accuracy 0
    ];
    expect(aggregateRound(results).avgAccuracy).toBe(50);
  });

  it("reports avgAccuracy 0 for an all-empty round", () => {
    const results = [
      { errorPct: Infinity, points: 0 },
      { errorPct: Infinity, points: 0 },
    ];
    const { totalPoints, maxPoints, avgAccuracy } = aggregateRound(results);
    expect(totalPoints).toBe(0);
    expect(maxPoints).toBe(2000);
    expect(avgAccuracy).toBe(0);
  });

  it("returns zeros for an empty round", () => {
    expect(aggregateRound([])).toEqual({ totalPoints: 0, maxPoints: 0, avgAccuracy: 0 });
  });
});

describe("K", () => {
  it("is the documented falloff constant", () => {
    expect(K).toBe(0.35);
  });
});
