import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { normalizeName, createNameIndex } from "../fe-artifacts/assets/js/nameMatch.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(resolve(here, "fixtures/sf-neighborhoods.data.json"), "utf8"),
);
const SF_FEATURES = fixture.geo.features;

function feats(...specs) {
  return specs.map(([name, aliases]) => ({
    properties: aliases ? { name, aliases } : { name },
  }));
}

describe("normalizeName", () => {
  it("lowercases, strips punctuation/diacritics, collapses whitespace", () => {
    expect(normalizeName("Kips-Bay")).toBe("kips bay");
    expect(normalizeName("KIPS  BAY")).toBe("kips bay");
    expect(normalizeName("  Café  District  ")).toBe("cafe district");
    expect(normalizeName("Downtown/Civic Center")).toBe("downtown civic center");
  });

  it("preserves the presence/absence of interior spaces", () => {
    expect(normalizeName("kipsbay")).toBe("kipsbay");
    expect(normalizeName("kipsbay")).not.toBe(normalizeName("kips bay"));
  });
});

describe("createNameIndex with SF fixture", () => {
  const index = createNameIndex(SF_FEATURES);

  it("is case-insensitive", () => {
    expect(index.match("pacific heights")).toBe("Pacific Heights");
    expect(index.match("PACIFIC HEIGHTS")).toBe("Pacific Heights");
  });

  it("resolves punctuated canonical names", () => {
    expect(index.match("downtown civic center")).toBe("Downtown/Civic Center");
  });

  it("resolves aliases to their canonical name", () => {
    expect(index.match("PH")).toBe("Pacific Heights");
    expect(index.match("NobHill")).toBe("Nob Hill");
  });

  it("returns null for unknown guesses", () => {
    expect(index.match("Atlantis")).toBeNull();
  });

  it("exposes size and names matching the feature list", () => {
    expect(index.size).toBe(SF_FEATURES.length);
    expect(index.names).toEqual(SF_FEATURES.map(f => f.properties.name));
  });
});

describe("createNameIndex with synthetic lists", () => {
  it("strips diacritics to the base letter, not a space", () => {
    const index = createNameIndex(feats(["Café District"]));
    expect(index.match("cafe district")).toBe("Café District");
  });

  it("preserves interior whitespace so removed spaces don't match", () => {
    const index = createNameIndex(feats(["Kips Bay"]));
    expect(index.match("Kips-Bay")).toBe("Kips Bay");
    expect(index.match("kips bay")).toBe("Kips Bay");
    expect(index.match("kipsbay")).toBeNull();

    const aliased = createNameIndex(feats(["Kips Bay", ["KipsBay"]]));
    expect(aliased.match("kipsbay")).toBe("Kips Bay");
  });

  it("keeps Mission and Mission Bay distinct", () => {
    const index = createNameIndex(feats(["Mission"], ["Mission Bay"]));
    expect(index.match("mission")).toBe("Mission");
    expect(index.match("mission bay")).toBe("Mission Bay");
  });

  it("lets a canonical name beat a colliding alias", () => {
    const index = createNameIndex(
      feats(["Bayview", ["mission"]], ["Mission"]),
    );
    expect(index.match("mission")).toBe("Mission");
  });
});
