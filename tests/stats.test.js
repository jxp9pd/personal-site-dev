import { describe, it, expect } from "vitest";
import { computeStats } from "../fe-artifacts/assets/js/stats.js";

function play(overrides) {
  return {
    id: overrides.id,
    user_id: "u1",
    game_id: "sf-neighborhoods",
    mode: "find",
    score: 0,
    total: 10,
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function groupFor(result, gameId, mode) {
  return result.find((g) => g.gameId === gameId && g.mode === mode);
}

describe("computeStats", () => {
  it("returns an empty array for empty input", () => {
    expect(computeStats([])).toEqual([]);
  });

  it("returns an empty array for non-array input", () => {
    expect(computeStats(null)).toEqual([]);
    expect(computeStats(undefined)).toEqual([]);
  });

  it("computes best, mostRecent, and count per group", () => {
    const plays = [
      play({ id: "a", score: 5, created_at: "2026-01-01T00:00:00.000Z" }),
      play({ id: "b", score: 8, created_at: "2026-01-02T00:00:00.000Z" }),
      play({ id: "c", score: 3, created_at: "2026-01-03T00:00:00.000Z" }),
    ];
    const result = computeStats(plays);
    expect(result).toHaveLength(1);
    const g = groupFor(result, "sf-neighborhoods", "find");
    expect(g.count).toBe(3);
    expect(g.best.id).toBe("b");
    expect(g.best.score).toBe(8);
    expect(g.mostRecent.id).toBe("c");
    expect(g.mostRecent.score).toBe(3);
  });

  it("keeps find and name modes separate", () => {
    const plays = [
      play({ id: "a", mode: "find", score: 4 }),
      play({ id: "b", mode: "name", score: 9 }),
      play({ id: "c", mode: "find", score: 7 }),
    ];
    const result = computeStats(plays);
    expect(result).toHaveLength(2);

    const find = groupFor(result, "sf-neighborhoods", "find");
    const name = groupFor(result, "sf-neighborhoods", "name");
    expect(find.count).toBe(2);
    expect(find.best.score).toBe(7);
    expect(name.count).toBe(1);
    expect(name.best.score).toBe(9);
  });

  it("keeps different games separate", () => {
    const plays = [
      play({ id: "a", game_id: "sf-neighborhoods", score: 4 }),
      play({ id: "b", game_id: "nyc-boroughs", score: 9 }),
    ];
    const result = computeStats(plays);
    expect(result).toHaveLength(2);
    expect(groupFor(result, "sf-neighborhoods", "find").count).toBe(1);
    expect(groupFor(result, "nyc-boroughs", "find").count).toBe(1);
  });

  it("orders history newest-first", () => {
    const plays = [
      play({ id: "a", score: 1, created_at: "2026-01-01T00:00:00.000Z" }),
      play({ id: "b", score: 2, created_at: "2026-01-03T00:00:00.000Z" }),
      play({ id: "c", score: 3, created_at: "2026-01-02T00:00:00.000Z" }),
    ];
    const g = groupFor(computeStats(plays), "sf-neighborhoods", "find");
    expect(g.history.map((p) => p.id)).toEqual(["b", "c", "a"]);
    expect(g.mostRecent.id).toBe("b");
  });

  it("breaks a best-score tie by earliest created_at", () => {
    const plays = [
      play({ id: "late", score: 8, created_at: "2026-01-05T00:00:00.000Z" }),
      play({ id: "early", score: 8, created_at: "2026-01-02T00:00:00.000Z" }),
      play({ id: "mid", score: 8, created_at: "2026-01-03T00:00:00.000Z" }),
    ];
    const g = groupFor(computeStats(plays), "sf-neighborhoods", "find");
    expect(g.best.id).toBe("early");
  });

  it("breaks a best-score tie deterministically by id when timestamps also tie", () => {
    const ts = "2026-01-02T00:00:00.000Z";
    const plays = [
      play({ id: "zeta", score: 8, created_at: ts }),
      play({ id: "alpha", score: 8, created_at: ts }),
    ];
    const g = groupFor(computeStats(plays), "sf-neighborhoods", "find");
    expect(g.best.id).toBe("alpha");
  });

  it("breaks a most-recent tie deterministically by id descending", () => {
    const ts = "2026-01-09T00:00:00.000Z";
    const plays = [
      play({ id: "alpha", score: 4, created_at: ts }),
      play({ id: "zeta", score: 7, created_at: ts }),
    ];
    const g = groupFor(computeStats(plays), "sf-neighborhoods", "find");
    expect(g.mostRecent.id).toBe("zeta");
    expect(g.history[0].id).toBe("zeta");
  });

  it("only includes groups present in the input", () => {
    const plays = [play({ id: "a", mode: "find", score: 4 })];
    const result = computeStats(plays);
    expect(result).toHaveLength(1);
    expect(groupFor(result, "sf-neighborhoods", "name")).toBeUndefined();
  });

  it("averages a single play to that play's ratio", () => {
    const plays = [play({ id: "a", score: 7, total: 10 })];
    const g = groupFor(computeStats(plays), "sf-neighborhoods", "find");
    expect(g.average).toBe(0.7);
  });

  it("averages multiple plays as the mean of per-play ratios", () => {
    const plays = [
      play({ id: "a", score: 5, total: 10 }),
      play({ id: "b", score: 10, total: 10 }),
    ];
    const g = groupFor(computeStats(plays), "sf-neighborhoods", "find");
    // ratios 0.5 and 1.0 -> exactly-representable mean 0.75
    expect(g.average).toBe(0.75);
  });

  it("averages over per-play ratios, not summed score / summed total", () => {
    const plays = [
      play({ id: "a", score: 1, total: 1 }),
      play({ id: "b", score: 0, total: 100 }),
    ];
    const g = groupFor(computeStats(plays), "sf-neighborhoods", "find");
    // mean of ratios = (1/1 + 0/100) / 2 = 0.5, not summed 1/101
    expect(g.average).toBe(0.5);
  });

  it("averages non-terminating per-play ratios", () => {
    const plays = [
      play({ id: "a", score: 1, total: 3 }),
      play({ id: "b", score: 1, total: 3 }),
    ];
    const g = groupFor(computeStats(plays), "sf-neighborhoods", "find");
    expect(g.average).toBeCloseTo(1 / 3, 12);
  });

  it("adds average without altering best, mostRecent, count, or ordering", () => {
    const plays = [
      play({ id: "a", score: 5, total: 10, created_at: "2026-01-01T00:00:00.000Z" }),
      play({ id: "b", score: 8, total: 10, created_at: "2026-01-02T00:00:00.000Z" }),
      play({ id: "c", score: 3, total: 10, created_at: "2026-01-03T00:00:00.000Z" }),
    ];
    const g = groupFor(computeStats(plays), "sf-neighborhoods", "find");
    expect(g.count).toBe(3);
    expect(g.best.id).toBe("b");
    expect(g.mostRecent.id).toBe("c");
    expect(g.history.map((p) => p.id)).toEqual(["c", "b", "a"]);
    expect(g.average).toBeCloseTo(0.5333333333, 9);
  });

  it("preserves gameId-then-mode sort order with average present", () => {
    const plays = [
      play({ id: "a", game_id: "sf-neighborhoods", mode: "name", score: 2 }),
      play({ id: "b", game_id: "nyc-boroughs", mode: "find", score: 4 }),
      play({ id: "c", game_id: "sf-neighborhoods", mode: "find", score: 6 }),
    ];
    const result = computeStats(plays);
    expect(result.map((g) => [g.gameId, g.mode])).toEqual([
      ["nyc-boroughs", "find"],
      ["sf-neighborhoods", "find"],
      ["sf-neighborhoods", "name"],
    ]);
    result.forEach((g) => expect(typeof g.average).toBe("number"));
  });
});
