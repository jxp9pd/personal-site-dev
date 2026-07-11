import { describe, it, expect } from "vitest";
import { paginate } from "../fe-artifacts/assets/js/pagination.js";

const items = ["a", "b", "c", "d", "e", "f", "g"];

describe("paginate", () => {
  it("slices a middle page", () => {
    const result = paginate(items, 2, 2);
    expect(result.pageItems).toEqual(["c", "d"]);
    expect(result.page).toBe(2);
    expect(result.total).toBe(7);
  });

  it("computes pageCount for a non-exact division", () => {
    expect(paginate(items, 1, 2).pageCount).toBe(4);
  });

  it("computes pageCount for an exact division", () => {
    expect(paginate(items.slice(0, 6), 1, 2).pageCount).toBe(3);
  });

  it("handles empty input", () => {
    const result = paginate([], 1, 3);
    expect(result.pageItems).toEqual([]);
    expect(result.pageCount).toBe(1);
    expect(result.total).toBe(0);
    expect(result.page).toBe(1);
  });

  it("clamps a page below 1 up to 1", () => {
    const result = paginate(items, 0, 2);
    expect(result.page).toBe(1);
    expect(result.pageItems).toEqual(["a", "b"]);
  });

  it("clamps a page above pageCount down to pageCount", () => {
    const result = paginate(items, 99, 2);
    expect(result.page).toBe(4);
    expect(result.pageItems).toEqual(["g"]);
  });

  it("supports a page size of 1", () => {
    const result = paginate(items, 3, 1);
    expect(result.pageItems).toEqual(["c"]);
    expect(result.pageCount).toBe(7);
    expect(result.page).toBe(3);
  });

  it("returns the whole list when pageSize exceeds total", () => {
    const result = paginate(items, 1, 100);
    expect(result.pageItems).toEqual(items);
    expect(result.pageCount).toBe(1);
    expect(result.page).toBe(1);
  });

  it("treats a pageSize below 1 as at least 1", () => {
    const result = paginate(items, 1, 0);
    expect(result.pageItems).toEqual(["a"]);
    expect(result.pageCount).toBe(7);
  });

  it("guards against non-integer / non-numeric page and pageSize", () => {
    const result = paginate(items, 2.9, 2.5);
    expect(result.page).toBe(2);
    expect(result.pageItems).toEqual(["c", "d"]);

    const nan = paginate(items, "oops", NaN);
    expect(nan.page).toBe(1);
    expect(nan.pageItems).toEqual(["a"]);
  });
});
