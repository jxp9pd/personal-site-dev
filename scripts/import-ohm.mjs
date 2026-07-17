import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import path from "node:path";
import process from "node:process";
import { normalizeAtlasFeatures } from "./lib/atlas-normalize.js";

const OVERPASS_URL = "https://overpass-api.openhistoricalmap.org/api/interpreter";
const CITY_CONFIG = {
  sf: {
    name: "San Francisco",
    bounds: [37.707, -122.515, 37.833, -122.349],
  },
};

export async function importOhm({
  city,
  fixture,
  output,
  overrides,
  exclusions,
  fetchImpl = globalThis.fetch,
} = {}) {
  const config = CITY_CONFIG[city];
  if (!config) throw new Error(`Unsupported city "${city}"`);

  const query = buildQuery(config.bounds);
  const [payload, overrideEntries, exclusionEntries] = await Promise.all([
    fixture
      ? JSON.parse(await readFile(fixture, "utf8"))
      : fetchOhm(query, fetchImpl),
    readOptionalJson(
      overrides ?? path.join("data", "time-atlas", "curated", city, "overrides.json"),
      {},
    ),
    readOptionalJson(
      exclusions ?? path.join("data", "time-atlas", "curated", city, "exclusions.json"),
      [],
    ),
  ]);
  const sourceRecords = convertElements(payload?.elements);
  const features = normalizeAtlasFeatures({
    imported: sourceRecords,
    overrides: overrideEntries,
    exclusions: exclusionEntries,
  });
  const counts = countLayers(features);
  const outputDirectory = output ?? path.join("data", "time-atlas", "imported", city);

  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    writeJson(path.join(outputDirectory, "ohm-source.json"), {
      city,
      bounds: config.bounds,
      records: sourceRecords,
      source: "OpenHistoricalMap",
    }),
    writeJson(path.join(outputDirectory, "features.geojson"), {
      type: "FeatureCollection",
      features,
    }),
    writeJson(path.join(outputDirectory, "manifest.json"), {
      city,
      bounds: config.bounds,
      counts,
      query,
      source: "OpenHistoricalMap",
    }),
  ]);

  return { city, counts, features, output: outputDirectory, sourceRecords };
}

export function buildQuery(bounds) {
  const bbox = bounds.join(",");
  return [
    "[out:json][timeout:180];",
    "(",
    `  nwr["place"~"^(neighbourhood|neighborhood|quarter|suburb)$"](${bbox});`,
    `  nwr["historic"](${bbox});`,
    `  nwr["tourism"](${bbox});`,
    `  nwr["amenity"]["start_date"](${bbox});`,
    `  nwr["building"]["start_date"](${bbox});`,
    `  nwr["man_made"]["start_date"](${bbox});`,
    `  nwr["memorial"](${bbox});`,
    ");",
    "out body geom;",
  ].join("\n");
}

async function fetchOhm(query, fetchImpl) {
  if (typeof fetchImpl !== "function") throw new Error("No fetch implementation is available");
  const maximumRetries = 5;
  const requestNonce = randomUUID();
  for (let attempt = 0; attempt <= maximumRetries; attempt += 1) {
    const requestQuery =
      `${query}\n// time-atlas-request-${requestNonce}-attempt-${attempt}`;
    const response = await fetchImpl(OVERPASS_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: new URLSearchParams({ data: requestQuery }),
    });
    if (!response.ok) {
      throw new Error(`OpenHistoricalMap request failed with HTTP ${response.status}`);
    }

    const body = await response.text();
    try {
      return JSON.parse(body);
    } catch {
      if (body.includes("duplicate_query")) {
        if (attempt < maximumRetries) continue;
        throw new Error("OpenHistoricalMap duplicate query retries exhausted");
      }
      throw new Error(`OpenHistoricalMap returned non-JSON: ${summarizeServerError(body)}`);
    }
  }
  throw new Error("OpenHistoricalMap duplicate query retries exhausted");
}

function summarizeServerError(body) {
  const text = String(body)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (text || "empty response").slice(0, 240);
}

async function readOptionalJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return structuredClone(fallback);
    throw error;
  }
}

function convertElements(elements) {
  if (!Array.isArray(elements)) throw new Error("OpenHistoricalMap response is missing elements");

  return elements
    .map(element => ({
      type: element?.type,
      id: element?.id,
      geometry: elementToGeometry(element),
      tags: stableClone(element?.tags ?? {}),
    }))
    .sort(compareSourceRecords);
}

function elementToGeometry(element) {
  const label = `${element?.type ?? "unknown"}/${element?.id ?? "unknown"}`;
  if (element?.type === "node") {
    if (!isCoordinate(element.lon, element.lat)) {
      throw new Error(`OpenHistoricalMap record "${label}" has no usable geometry`);
    }
    return { type: "Point", coordinates: [element.lon, element.lat] };
  }

  if (element?.type === "way") {
    const coordinates = coordinatesFromGeometry(element.geometry, label);
    return isArea(element.tags, coordinates)
      ? { type: "Polygon", coordinates: [coordinates] }
      : { type: "LineString", coordinates };
  }

  if (element?.type === "relation") {
    return relationGeometry(element, label);
  }

  throw new Error(`OpenHistoricalMap record "${label}" has unsupported element type`);
}

function relationGeometry(element, label) {
  const members = Array.isArray(element.members) ? element.members : [];
  const outerSegments = [];
  const innerSegments = [];

  for (const member of members) {
    if (member?.type !== "way" || !Array.isArray(member.geometry)) continue;
    const coordinates = coordinatesFromGeometry(member.geometry, `${label} member ${member.ref}`);
    (member.role === "inner" ? innerSegments : outerSegments).push(coordinates);
  }

  const outerRings = joinRings(outerSegments, label);
  const innerRings = joinRings(innerSegments, label);
  if (outerRings.length === 1) {
    return { type: "Polygon", coordinates: [outerRings[0], ...innerRings] };
  }
  if (outerRings.length > 1 && innerRings.length === 0) {
    return { type: "MultiPolygon", coordinates: outerRings.map(ring => [ring]) };
  }
  if (outerRings.length > 1) {
    throw new Error(`OpenHistoricalMap record "${label}" has ambiguous inner relation rings`);
  }
  throw new Error(`OpenHistoricalMap record "${label}" has no usable outer geometry`);
}

function joinRings(segments, label) {
  const remaining = segments.map(segment => [...segment]);
  const rings = [];

  while (remaining.length > 0) {
    const ring = remaining.shift();
    while (!sameCoordinate(ring[0], ring.at(-1))) {
      const end = ring.at(-1);
      const index = remaining.findIndex(
        segment => sameCoordinate(segment[0], end) || sameCoordinate(segment.at(-1), end),
      );
      if (index === -1) {
        throw new Error(`OpenHistoricalMap record "${label}" contains an open relation ring`);
      }
      const [next] = remaining.splice(index, 1);
      if (sameCoordinate(next.at(-1), end)) next.reverse();
      ring.push(...next.slice(1));
    }
    rings.push(ring);
  }
  return rings;
}

function coordinatesFromGeometry(geometry, label) {
  const coordinates = geometry.map(point => [point?.lon, point?.lat]);
  if (coordinates.length < 2 || coordinates.some(([lon, lat]) => !isCoordinate(lon, lat))) {
    throw new Error(`OpenHistoricalMap record "${label}" has no usable geometry`);
  }
  return coordinates;
}

function isCoordinate(lon, lat) {
  return Number.isFinite(lon) && Number.isFinite(lat);
}

function isArea(tags = {}, coordinates) {
  return (
    coordinates.length >= 4 &&
    sameCoordinate(coordinates[0], coordinates.at(-1)) &&
    (tags.area === "yes" ||
      tags.building !== undefined ||
      tags.boundary !== undefined ||
      tags.place !== undefined)
  );
}

function sameCoordinate(left, right) {
  return left?.[0] === right?.[0] && left?.[1] === right?.[1];
}

function compareSourceRecords(left, right) {
  return `${left.type}/${left.id}`.localeCompare(`${right.type}/${right.id}`);
}

function countLayers(features) {
  const counts = { landmarks: 0, neighborhoods: 0, total: features.length };
  for (const feature of features) counts[feature.properties.layer] += 1;
  return counts;
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(stableClone(value), null, 2)}\n`);
}

function stableClone(value) {
  if (Array.isArray(value)) return value.map(stableClone);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map(key => [key, stableClone(value[key])]),
  );
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!["--city", "--fixture", "--output"].includes(argument)) {
      throw new Error(`Unknown argument "${argument}"`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    options[argument.slice(2)] = value;
    index += 1;
  }
  if (!options.city) throw new Error("--city is required");
  return options;
}

async function main() {
  const result = await importOhm(parseArguments(process.argv.slice(2)));
  console.log(
    `Imported ${result.city}: ${result.counts.neighborhoods} neighborhoods, ` +
      `${result.counts.landmarks} landmarks (${result.counts.total} total)`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
