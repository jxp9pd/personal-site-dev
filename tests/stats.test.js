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
});
