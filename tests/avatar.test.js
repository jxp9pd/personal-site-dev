import { describe, it, expect } from "vitest";
import { initialsAvatar, PALETTE } from "../fe-artifacts/assets/js/avatar.js";

describe("initialsAvatar determinism", () => {
  it("returns identical output for the same seed across calls", () => {
    const a = initialsAvatar("johnpentakalos");
    const b = initialsAvatar("johnpentakalos");
    expect(a).toEqual(b);
  });

  it("can differ across seeds", () => {
    const a = initialsAvatar("alice");
    const b = initialsAvatar("zzzzz");
    expect(a.color === b.color && a.initials === b.initials).toBe(false);
  });
});

describe("initialsAvatar initials extraction", () => {
  it("uppercases the first character of a single-word username", () => {
    expect(initialsAvatar("john").initials).toBe("J");
  });

  it("uses first + last word initials for multi-word seeds", () => {
    expect(initialsAvatar("John Pentakalos").initials).toBe("JP");
    expect(initialsAvatar("ada_lovelace").initials).toBe("AL");
    expect(initialsAvatar("grace-hopper").initials).toBe("GH");
  });
});

describe("initialsAvatar color", () => {
  it("draws color from the fixed palette", () => {
    expect(PALETTE).toContain(initialsAvatar("john").color);
  });

  it("is stable per seed", () => {
    expect(initialsAvatar("carol").color).toBe(initialsAvatar("carol").color);
  });
});

describe("initialsAvatar fallbacks", () => {
  it("does not throw and yields a sensible fallback for empty/odd seeds", () => {
    for (const seed of ["", "   ", undefined, null, 42, {}]) {
      const result = initialsAvatar(seed);
      expect(result.initials).toBe("?");
      expect(PALETTE).toContain(result.color);
    }
  });
});
