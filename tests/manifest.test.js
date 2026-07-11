import { describe, it, expect } from "vitest";
import {
  getGame,
  getModeLabel,
  isKnownSlug,
  categoryOf,
  gamesByCategory,
} from "../fe-artifacts/assets/js/manifest.js";

const NEIGHBORHOOD_SLUGS = [
  "sf-neighborhoods",
  "seattle-neighborhoods",
  "dc-neighborhoods",
  "fairfax-neighborhoods",
];

describe("categoryOf", () => {
  it("returns the category for a known game", () => {
    for (const slug of NEIGHBORHOOD_SLUGS) {
      expect(categoryOf(slug)).toBe("Neighborhoods");
    }
  });

  it("returns null for an unknown slug", () => {
    expect(categoryOf("not-a-game")).toBe(null);
    expect(categoryOf("")).toBe(null);
    expect(categoryOf(undefined)).toBe(null);
  });
});

describe("gamesByCategory", () => {
  it("groups games under their category with stable ordering", () => {
    const grouped = gamesByCategory();

    expect(grouped.map((g) => g.category)).toEqual(["Neighborhoods"]);

    const neighborhoods = grouped[0];
    expect(neighborhoods.games.map((g) => g.slug)).toEqual(NEIGHBORHOOD_SLUGS);
  });

  it("includes full game metadata alongside the slug", () => {
    const neighborhoods = gamesByCategory()[0];
    const sf = neighborhoods.games[0];

    expect(sf).toMatchObject({
      slug: "sf-neighborhoods",
      name: "Neighborhoods of SF",
      category: "Neighborhoods",
      modes: { find: "Find it", name: "Name it" },
    });
  });

  it("only surfaces known games (no unknown slugs leak in)", () => {
    const allSlugs = gamesByCategory().flatMap((g) => g.games.map((x) => x.slug));
    for (const slug of allSlugs) {
      expect(isKnownSlug(slug)).toBe(true);
    }
    expect(allSlugs).toEqual(NEIGHBORHOOD_SLUGS);
  });
});

describe("existing helpers stay intact", () => {
  it("getGame returns metadata for known slugs and null otherwise", () => {
    expect(getGame("sf-neighborhoods")).toMatchObject({
      name: "Neighborhoods of SF",
    });
    expect(getGame("nope")).toBe(null);
  });

  it("getModeLabel resolves tracked mode labels and null otherwise", () => {
    expect(getModeLabel("sf-neighborhoods", "find")).toBe("Find it");
    expect(getModeLabel("sf-neighborhoods", "name")).toBe("Name it");
    expect(getModeLabel("sf-neighborhoods", "learn")).toBe(null);
    expect(getModeLabel("nope", "find")).toBe(null);
  });

  it("isKnownSlug reflects membership in GAMES", () => {
    expect(isKnownSlug("dc-neighborhoods")).toBe(true);
    expect(isKnownSlug("nope")).toBe(false);
  });
});
