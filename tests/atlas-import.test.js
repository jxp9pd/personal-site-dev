import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildQuery, importOhm } from "../scripts/import-ohm.mjs";

const fixture = path.resolve("tests/fixtures/atlas/ohm-sf.json");
const temporaryDirectories = [];

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "atlas-import-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function outputContents(directory) {
  const files = (await readdir(directory)).sort();
  return Object.fromEntries(
    await Promise.all(files.map(async file => [file, await readFile(path.join(directory, file), "utf8")])),
  );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true })));
});

describe("OpenHistoricalMap importer", () => {
  it("imports the SF fixture without network access and preserves curation inputs", async () => {
    const output = await temporaryDirectory();
    const curationSentinel = path.join(output, "curated.geojson");
    await writeFile(curationSentinel, '{"curated":true}\n');
    const fetchImpl = vi.fn(() => {
      throw new Error("fixture mode attempted network access");
    });

    const result = await importOhm({ city: "sf", fixture, output, fetchImpl });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.counts).toEqual({ landmarks: 2, neighborhoods: 1, total: 3 });
    expect(result.features.map(feature => feature.id)).toEqual([
      "ohm:node/7",
      "ohm:relation/31",
      "ohm:way/22",
    ]);
    expect(result.features.map(feature => feature.properties.source_id)).toEqual([
      "node/7",
      "relation/31",
      "way/22",
    ]);
    expect(result.features.map(feature => feature.properties.start_year)).toEqual([1850, 1847, 1899]);
    expect(result.features[0].properties.source_properties).toMatchObject({
      historic: "memorial",
      start_date: "1850",
    });
    expect(await readFile(curationSentinel, "utf8")).toBe('{"curated":true}\n');
  });

  it("writes byte-identical artifacts for equivalent element ordering", async () => {
    const firstOutput = await temporaryDirectory();
    const secondOutput = await temporaryDirectory();
    const shuffledFixture = path.join(await temporaryDirectory(), "shuffled.json");
    const payload = JSON.parse(await readFile(fixture, "utf8"));
    payload.elements.reverse();
    await writeFile(shuffledFixture, JSON.stringify(payload));

    await importOhm({ city: "sf", fixture, output: firstOutput });
    await importOhm({ city: "sf", fixture: shuffledFixture, output: secondOutput });

    expect(await outputContents(firstOutput)).toEqual(await outputContents(secondOutput));
  });

  it("uses configured SF bounds and selected classes in live mode", async () => {
    const output = await temporaryDirectory();
    const payload = JSON.parse(await readFile(fixture, "utf8"));
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      text: async () => JSON.stringify(payload),
    }));

    await importOhm({ city: "sf", output, fetchImpl });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, request] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://overpass-api.openhistoricalmap.org/api/interpreter");
    expect(request.method).toBe("POST");
    const query = request.body.get("data");
    const baseQuery = buildQuery([37.707, -122.515, 37.833, -122.349]);
    expect(query).toMatch(
      new RegExp(`^${escapeRegExp(baseQuery)}\\n// time-atlas-request-[\\w-]+-attempt-0$`),
    );
    expect(query).toContain('nwr["place"~"^(neighbourhood|neighborhood|quarter|suburb)$"]');
    expect(query).toContain('nwr["building"]["start_date"]');
    expect(query).toContain("out body geom;");
    expect(query).not.toContain("out tags geom;");
    const manifest = JSON.parse(await readFile(path.join(output, "manifest.json"), "utf8"));
    expect(manifest.query).toBe(baseQuery);
  });

  it("retries a duplicate query response with distinct per-attempt suffixes", async () => {
    const payload = await readFile(fixture, "utf8");
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        text: async () => "<html>Dispatcher_Client::request_read_and_idx::duplicate_query</html>",
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => payload,
      });

    await importOhm({
      city: "sf",
      output: await temporaryDirectory(),
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const firstQuery = fetchImpl.mock.calls[0][1].body.get("data");
    const retryQuery = fetchImpl.mock.calls[1][1].body.get("data");
    const firstSuffix = firstQuery.match(/\/\/ time-atlas-request-([\w-]+)-attempt-0$/);
    expect(firstSuffix).not.toBeNull();
    expect(
      retryQuery.endsWith(`// time-atlas-request-${firstSuffix[1]}-attempt-1`),
    ).toBe(true);
    expect(retryQuery).not.toBe(firstQuery);
  });

  it("does not reuse transient request queries across importer invocations", async () => {
    const payload = await readFile(fixture, "utf8");
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      text: async () => payload,
    }));

    await importOhm({
      city: "sf",
      output: await temporaryDirectory(),
      fetchImpl,
    });
    await importOhm({
      city: "sf",
      output: await temporaryDirectory(),
      fetchImpl,
    });

    const firstQuery = fetchImpl.mock.calls[0][1].body.get("data");
    const secondQuery = fetchImpl.mock.calls[1][1].body.get("data");
    expect(secondQuery).not.toBe(firstQuery);
    expect(firstQuery.split("\n// time-atlas-request-")[0]).toBe(
      secondQuery.split("\n// time-atlas-request-")[0],
    );
  });

  it("reports concise server text for an unexpected non-JSON response", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      text: async () => "<html><body><h1>Runtime error</h1><p>Query execution failed.</p></body></html>",
    }));

    await expect(
      importOhm({
        city: "sf",
        output: await temporaryDirectory(),
        fetchImpl,
      }),
    ).rejects.toThrow(
      "OpenHistoricalMap returned non-JSON: Runtime error Query execution failed.",
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("converts a relation returned with body member geometries", async () => {
    const result = await importOhm({
      city: "sf",
      fixture,
      output: await temporaryDirectory(),
    });
    const relation = result.features.find(feature => feature.id === "ohm:relation/31");

    expect(relation.geometry).toEqual({
      type: "Polygon",
      coordinates: [[
        [-122.41, 37.79],
        [-122.39, 37.79],
        [-122.39, 37.77],
        [-122.41, 37.77],
        [-122.41, 37.79],
      ]],
    });
  });

  it("applies a tracked temporal override while preserving the imported source record", async () => {
    const root = await temporaryDirectory();
    const invalidFixture = path.join(root, "invalid-date.json");
    const overrides = path.join(root, "overrides.json");
    const payload = JSON.parse(await readFile(fixture, "utf8"));
    payload.elements.push({
      type: "node",
      id: 2096330437,
      lat: 37.73,
      lon: -122.39,
      tags: {
        amenity: "library",
        name: "San Francisco Public Library Bayview Branch",
        start_date: "1900-02-29",
      },
    });
    await writeFile(invalidFixture, JSON.stringify(payload));
    await writeFile(
      overrides,
      JSON.stringify({
        "ohm:node/2096330437": {
          start_date: "2013-02-23",
          reason: "Correct impossible source date from library history.",
          citation: "https://sfpl.org/locations/bayview/library-history",
        },
      }),
    );

    const result = await importOhm({
      city: "sf",
      fixture: invalidFixture,
      overrides,
      output: path.join(root, "output"),
    });
    const library = result.features.find(feature => feature.id === "ohm:node/2096330437");
    const source = result.sourceRecords.find(record => record.id === 2096330437);

    expect(library.properties).toMatchObject({
      start_date: "2013-02-23",
      start_year: 2013,
    });
    expect(source.tags.start_date).toBe("1900-02-29");
  });

  it("applies an open-ended historical-origin override to an undated neighborhood", async () => {
    const root = await temporaryDirectory();
    const undatedFixture = path.join(root, "undated-neighborhood.json");
    const overrides = path.join(root, "overrides.json");
    const payload = JSON.parse(await readFile(fixture, "utf8"));
    payload.elements.push({
      type: "node",
      id: 2108838779,
      lat: 37.7608268,
      lon: -122.4187558,
      tags: {
        name: "Mission District",
        place: "neighbourhood",
        wikidata: "Q7469",
        wikipedia: "en:Mission District, San Francisco",
      },
    });
    await writeFile(undatedFixture, JSON.stringify(payload));
    await writeFile(
      overrides,
      JSON.stringify({
        "ohm:node/2108838779": {
          start_date: "1776",
          end_date: null,
          reason: "Historical origin is Mission San Francisco de Asís.",
          citation: "https://en.wikipedia.org/wiki/Mission_District,_San_Francisco",
        },
      }),
    );

    const result = await importOhm({
      city: "sf",
      fixture: undatedFixture,
      overrides,
      output: path.join(root, "output"),
    });
    const mission = result.features.find(feature => feature.id === "ohm:node/2108838779");
    const source = result.sourceRecords.find(record => record.id === 2108838779);

    expect(mission.properties).toMatchObject({
      start_date: "1776",
      start_year: 1776,
      end_date: null,
      end_year: null,
    });
    expect(source.tags.start_date).toBeUndefined();
  });

  it("omits an excluded invalid temporal record while an unexcluded equivalent fails", async () => {
    const root = await temporaryDirectory();
    const invertedFixture = path.join(root, "inverted-range.json");
    const exclusions = path.join(root, "exclusions.json");
    const noExclusions = path.join(root, "no-exclusions.json");
    const payload = JSON.parse(await readFile(fixture, "utf8"));
    payload.elements.push({
      type: "way",
      id: 199444347,
      tags: {
        end_date: "1880",
        man_made: "pier",
        start_date: "1885",
      },
      geometry: [
        { lat: 37.8, lon: -122.4 },
        { lat: 37.8, lon: -122.39 },
      ],
    });
    await writeFile(invertedFixture, JSON.stringify(payload));
    await writeFile(
      exclusions,
      JSON.stringify([{
        identity: "way/199444347",
        reason: "Source range is inverted and provides no authoritative source.",
      }]),
    );
    await writeFile(noExclusions, "[]");

    const result = await importOhm({
      city: "sf",
      fixture: invertedFixture,
      exclusions,
      output: path.join(root, "excluded-output"),
    });
    expect(result.features.map(feature => feature.id)).not.toContain("ohm:way/199444347");
    expect(result.sourceRecords.map(record => record.id)).toContain(199444347);

    await expect(
      importOhm({
        city: "sf",
        fixture: invertedFixture,
        exclusions: noExclusions,
        output: path.join(root, "invalid-output"),
      }),
    ).rejects.toThrow(
      'Invalid atlas record "ohm:way/199444347": start year is after end year',
    );
  });

  it("curates sourced same-year records as intervals and excludes arbitrary peers", async () => {
    const root = await temporaryDirectory();
    const cohortFixture = path.join(root, "same-year-cohort.json");
    const overrides = path.join(root, "overrides.json");
    const exclusions = path.join(root, "exclusions.json");
    const payload = JSON.parse(await readFile(fixture, "utf8"));
    payload.elements.push(
      {
        type: "node",
        id: 2118141137,
        lat: 37.78,
        lon: -122.43,
        tags: {
          end_date: "1947",
          historic: "hotel",
          project: "Negro Motorist Green Book",
          source: "1947 Green Book",
          start_date: "1947",
        },
      },
      {
        type: "way",
        id: 199444354,
        tags: {
          end_date: "1870",
          man_made: "pier",
          source: "arbitrary",
          start_date: "1870",
        },
        geometry: [
          { lat: 37.8, lon: -122.4 },
          { lat: 37.8, lon: -122.39 },
        ],
      },
    );
    await writeFile(cohortFixture, JSON.stringify(payload));
    await writeFile(
      overrides,
      JSON.stringify({
        "ohm:node/2118141137": {
          end_date: "1948",
          reason: "Treat sourced 1947 evidence as a one-year interval.",
          citation: "Negro Motorist Green Book (1947)",
        },
      }),
    );
    await writeFile(
      exclusions,
      JSON.stringify([{
        identity: "way/199444354",
        reason: "Same-year pier range is arbitrary.",
      }]),
    );

    const result = await importOhm({
      city: "sf",
      fixture: cohortFixture,
      overrides,
      exclusions,
      output: path.join(root, "output"),
    });
    const greenBook = result.features.find(feature => feature.id === "ohm:node/2118141137");

    expect(greenBook.properties).toMatchObject({
      start_date: "1947",
      start_year: 1947,
      end_date: "1948",
      end_year: 1948,
      source_properties: {
        start_date: "1947",
        end_date: "1947",
      },
    });
    expect(result.features.map(feature => feature.id)).not.toContain("ohm:way/199444354");
  });

  it("fails record-specifically when a relation has no member geometry", async () => {
    const root = await temporaryDirectory();
    const malformedFixture = path.join(root, "malformed.json");
    const payload = JSON.parse(await readFile(fixture, "utf8"));
    payload.elements.push({
      type: "relation",
      id: 2693762,
      tags: { historic: "stadium", name: "Oracle Park", start_date: "2000" },
      members: [],
    });
    await writeFile(malformedFixture, JSON.stringify(payload));

    await expect(
      importOhm({
        city: "sf",
        fixture: malformedFixture,
        output: path.join(root, "output"),
      }),
    ).rejects.toThrow(
      'OpenHistoricalMap record "relation/2693762" has no usable outer geometry',
    );
  });
});
