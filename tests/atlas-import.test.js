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
      json: async () => payload,
    }));

    await importOhm({ city: "sf", output, fetchImpl });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, request] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://overpass-api.openhistoricalmap.org/api/interpreter");
    expect(request.method).toBe("POST");
    const query = request.body.get("data");
    expect(query).toBe(buildQuery([37.707, -122.515, 37.833, -122.349]));
    expect(query).toContain('nwr["place"~"^(neighbourhood|neighborhood|quarter|suburb)$"]');
    expect(query).toContain('nwr["building"]["start_date"]');
  });
});
