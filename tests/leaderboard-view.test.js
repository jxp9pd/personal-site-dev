import { describe, it, expect } from "vitest";
import {
  formatScore,
  formatDate,
  playersBetween,
  buildCompactRows,
} from "../fe-artifacts/assets/js/leaderboard-view.js";

function row(overrides) {
  return {
    user_id: "u1",
    username: "Player",
    score: 100,
    total: 150,
    achieved_at: "2026-01-01T00:00:00.000Z",
    rank: 1,
    ...overrides,
  };
}

describe("formatScore", () => {
  it("groups thousands", () => {
    expect(formatScore(8640)).toBe("8,640");
    expect(formatScore(14980)).toBe("14,980");
  });

  it("leaves small numbers unchanged", () => {
    expect(formatScore(12)).toBe("12");
    expect(formatScore(0)).toBe("0");
  });

  it("returns empty string for non-numeric input", () => {
    expect(formatScore(null)).toBe("");
    expect(formatScore(undefined)).toBe("");
    expect(formatScore(NaN)).toBe("");
  });
});

describe("formatDate", () => {
  it("formats an ISO timestamp as 'Mon D, YYYY' in UTC", () => {
    expect(formatDate("2026-07-11T00:00:00.000Z")).toBe("Jul 11, 2026");
  });

  it("uses UTC so a late-night UTC time does not roll to the next local day", () => {
    expect(formatDate("2026-07-11T23:30:00.000Z")).toBe("Jul 11, 2026");
  });

  it("returns empty string for missing or invalid input", () => {
    expect(formatDate(null)).toBe("");
    expect(formatDate("")).toBe("");
    expect(formatDate("not-a-date")).toBe("");
  });
});

describe("playersBetween", () => {
  it("counts the hidden players between the last shown row and the viewer", () => {
    // top 5 shown, viewer at rank 35 -> ranks 6..34 hidden = 29
    expect(playersBetween(35, 5)).toBe(29);
  });

  it("is zero when the viewer is just past the shown rows", () => {
    expect(playersBetween(6, 5)).toBe(0);
  });

  it("never goes negative", () => {
    expect(playersBetween(3, 5)).toBe(0);
  });
});

describe("buildCompactRows", () => {
  const top = [
    row({ user_id: "a", rank: 1, score: 15 }),
    row({ user_id: "b", rank: 2, score: 14 }),
    row({ user_id: "c", rank: 3, score: 13 }),
    row({ user_id: "d", rank: 4, score: 12 }),
    row({ user_id: "e", rank: 5, score: 11 }),
  ];

  it("pins the viewer below a divider when they rank outside the top", () => {
    const viewer = row({ user_id: "z", rank: 35, score: 8 });
    const res = buildCompactRows(top, viewer, 5);
    expect(res.rows).toHaveLength(5);
    expect(res.viewerInTop).toBe(false);
    expect(res.showDivider).toBe(true);
    expect(res.between).toBe(29);
    expect(res.viewerRow).toBe(viewer);
  });

  it("does not pin or divide when the viewer is already in the top", () => {
    const viewer = top[2]; // rank 3, user c
    const res = buildCompactRows(top, viewer, 5);
    expect(res.viewerInTop).toBe(true);
    expect(res.showDivider).toBe(false);
    expect(res.viewerRow).toBeNull();
    expect(res.between).toBe(0);
  });

  it("shows just the top rows when there is no viewer", () => {
    const res = buildCompactRows(top, null, 5);
    expect(res.rows).toHaveLength(5);
    expect(res.viewerRow).toBeNull();
    expect(res.showDivider).toBe(false);
    expect(res.viewerInTop).toBe(false);
  });

  it("caps the shown rows at the limit", () => {
    const res = buildCompactRows(top, null, 3);
    expect(res.rows.map((r) => r.user_id)).toEqual(["a", "b", "c"]);
  });

  it("tolerates an empty board", () => {
    const res = buildCompactRows([], null, 5);
    expect(res.rows).toEqual([]);
    expect(res.showDivider).toBe(false);
  });
});
