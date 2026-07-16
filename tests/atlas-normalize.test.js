import { describe, expect, it } from "vitest";
import {
  isAtlasFeatureVisible,
  normalizeAtlasFeatures,
} from "../scripts/lib/atlas-normalize.js";

const point = coordinates => ({ type: "Point", coordinates });

function ohm(id, tags = {}, extra = {}) {
  return {
    type: "node",
    id,
    geometry: point([-122.42, 37.77]),
    tags: { name: `OHM ${id}`, historic: "yes", ...tags },
    ...extra,
  };
}

function curated(id, properties = {}, extra = {}) {
  return {
    type: "Feature",
    id,
    geometry: point([-122.41, 37.78]),
    properties: { name: `Curated ${id}`, layer: "landmarks", ...properties },
    ...extra,
  };
}

describe("normalizeAtlasFeatures temporal values", () => {
  it("normalizes exact, partial, and approximate dates while preserving source text", () => {
    const features = normalizeAtlasFeatures({
      imported: [
        ohm(1, { start_date: "1850", end_date: "1900" }),
        ohm(2, { start_date: "1850-04", end_date: "1900-06-12" }),
        ohm(3, { start_date: "1850~", end_date: "1900?" }),
        ohm(4, { date: "1875" }),
      ],
    });

    expect(
      features.map(({ properties }) => ({
        start_date: properties.start_date,
        end_date: properties.end_date,
        start_year: properties.start_year,
        end_year: properties.end_year,
      })),
    ).toEqual([
      { start_date: "1850", end_date: "1900", start_year: 1850, end_year: 1900 },
      {
        start_date: "1850-04",
        end_date: "1900-06-12",
        start_year: 1850,
        end_year: 1900,
      },
      { start_date: "1850~", end_date: "1900?", start_year: 1850, end_year: 1900 },
      { start_date: "1875", end_date: null, start_year: 1875, end_year: null },
    ]);
  });

  it("normalizes ranged and open-ended EDTF values", () => {
    const features = normalizeAtlasFeatures({
      imported: [
        ohm(1, { date: "1850/1900" }),
        ohm(2, { date: "1850/.." }),
        ohm(3, { date: "../1900" }),
        ohm(4, { start_date: "1850" }),
      ],
    });

    expect(
      features.map(feature => [
        feature.properties.start_year,
        feature.properties.end_year,
        feature.properties.start_date,
        feature.properties.end_date,
      ]),
    ).toEqual([
      [1850, 1900, "1850/1900", null],
      [1850, null, "1850/..", null],
      [null, 1900, "../1900", null],
      [1850, null, "1850", null],
    ]);
  });

  it("uses start-inclusive and end-exclusive visibility", () => {
    const [feature] = normalizeAtlasFeatures({
      imported: [ohm(1, { start_date: "1860", end_date: "1960" })],
    });

    expect(isAtlasFeatureVisible(feature, 1850)).toBe(false);
    expect(isAtlasFeatureVisible(feature, 1860)).toBe(true);
    expect(isAtlasFeatureVisible(feature, 1950)).toBe(true);
    expect(isAtlasFeatureVisible(feature, 1960)).toBe(false);
  });
});

describe("normalizeAtlasFeatures provenance and merging", () => {
  it("creates stable, non-colliding identities including OHM element type", () => {
    const features = normalizeAtlasFeatures({
      imported: [
        ohm(7),
        { ...ohm(7), type: "way" },
        { ...ohm(7), type: "relation" },
      ],
      curated: [curated("node/7"), curated("7")],
    });

    expect(features.map(feature => feature.id)).toEqual([
      "curated:7",
      "curated:node/7",
      "ohm:node/7",
      "ohm:relation/7",
      "ohm:way/7",
    ]);
    expect(features.map(feature => feature.properties.source_id)).toEqual([
      "7",
      "node/7",
      "node/7",
      "relation/7",
      "way/7",
    ]);
  });

  it("classifies neighborhoods and landmarks", () => {
    const features = normalizeAtlasFeatures({
      imported: [
        ohm(1, { historic: undefined, place: "neighbourhood" }),
        ohm(2, { tourism: "museum" }),
      ],
    });

    expect(features.map(feature => feature.properties.layer)).toEqual([
      "neighborhoods",
      "landmarks",
    ]);
  });

  it("applies overrides, exclusions, and curated additions without mutating inputs", () => {
    const imported = [
      ohm(1, { start_date: "1900", name: "Old name" }),
      ohm(2, { start_date: "1910" }),
    ];
    const importedSnapshot = structuredClone(imported);
    const additions = [curated("local-clock", { start_date: "1880" })];

    const features = normalizeAtlasFeatures({
      imported,
      curated: additions,
      overrides: {
        "ohm:node/1": {
          start_date: "1850~",
          properties: { name: "Corrected name" },
        },
      },
      exclusions: ["ohm:node/2"],
    });

    expect(imported).toEqual(importedSnapshot);
    expect(features.map(feature => feature.id)).toEqual([
      "curated:local-clock",
      "ohm:node/1",
    ]);
    expect(features[1].properties).toMatchObject({
      name: "Corrected name",
      start_date: "1850~",
      start_year: 1850,
      source: "ohm",
      source_id: "node/1",
    });
  });

  it("produces deterministic output for equivalent input order and key order", () => {
    const first = normalizeAtlasFeatures({
      imported: [
        ohm(2, { historic: "memorial", name: "B", start_date: "1900" }),
        ohm(1, { name: "A", historic: "yes", start_date: "1800" }),
      ],
      curated: [curated("z", { start_date: "1950" })],
    });
    const second = normalizeAtlasFeatures({
      curated: [curated("z", { start_date: "1950" })],
      imported: [
        ohm(1, { start_date: "1800", historic: "yes", name: "A" }),
        ohm(2, { start_date: "1900", name: "B", historic: "memorial" }),
      ],
    });

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

describe("normalizeAtlasFeatures validation", () => {
  it.each([
    {
      name: "unsupported temporal values",
      record: ohm(41, { start_date: "mid-1800s" }),
      message: /ohm:node\/41.*unsupported start temporal value "mid-1800s"/,
    },
    {
      name: "invalid calendar dates",
      record: ohm(42, { start_date: "1900-02-30" }),
      message: /ohm:node\/42.*unsupported start temporal value "1900-02-30"/,
    },
    {
      name: "invalid geometry",
      record: { ...ohm(43), geometry: { type: "Point", coordinates: ["west", 37.7] } },
      message: /ohm:node\/43.*invalid geometry/,
    },
    {
      name: "missing identities",
      record: { ...ohm(44), id: undefined, tags: { name: "Nameless ID", historic: "yes" } },
      message: /ohm:Nameless ID.*missing OpenHistoricalMap element type or numeric ID/,
    },
    {
      name: "unclassifiable records",
      record: ohm(45, { historic: undefined }),
      message: /ohm:node\/45.*cannot be classified/,
    },
  ])("rejects $name and names the offending record", ({ record, message }) => {
    expect(() => normalizeAtlasFeatures({ imported: [record] })).toThrow(message);
  });

  it("rejects duplicate identities by record identity", () => {
    expect(() =>
      normalizeAtlasFeatures({ imported: [ohm(9), ohm(9)] }),
    ).toThrow(/ohm:node\/9.*duplicate identity/);
  });
});
