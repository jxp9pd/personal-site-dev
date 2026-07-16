import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { SUPABASE_URL as CONFIG_SUPABASE_URL } from "../fe-artifacts/assets/js/config.js";
import {
  isAtlasFeatureVisible,
  normalizeAtlasFeatures,
} from "./lib/atlas-normalize.js";

const DEFAULT_DATA_ROOT = path.resolve("data/time-atlas");

export async function prepareAtlasPublication({
  city,
  fixture,
  dataRoot = DEFAULT_DATA_ROOT,
} = {}) {
  if (!city) throw new Error("Atlas publication requires a city");

  const paths = publicationPaths({ city, fixture, dataRoot });
  const [importArtifact, curatedArtifact, overrides, exclusions, checkpoints] =
    await Promise.all([
      readJson(paths.imported),
      readJson(paths.curated, { optional: true, fallback: emptyFeatureCollection() }),
      readJson(paths.overrides, { optional: true, fallback: {} }),
      readJson(paths.exclusions, { optional: true, fallback: [] }),
      readJson(paths.checkpoints),
    ]);

  if (importArtifact.city !== city) {
    throw new Error(
      `Imported atlas artifact city "${importArtifact.city ?? "unknown"}" does not match "${city}"`,
    );
  }
  if (!Array.isArray(importArtifact.records)) {
    throw new Error(`Imported atlas artifact for "${city}" is missing records`);
  }
  if (curatedArtifact.type !== "FeatureCollection" || !Array.isArray(curatedArtifact.features)) {
    throw new Error(`Curated atlas artifact for "${city}" must be a GeoJSON FeatureCollection`);
  }

  const normalizedCheckpoints = validateCheckpoints(checkpoints, city);
  const features = normalizeAtlasFeatures({
    imported: importArtifact.records,
    curated: curatedArtifact.features,
    overrides,
    exclusions,
  });
  const rows = features.map(feature => featureToRow(city, feature));

  return {
    city,
    checkpoints: normalizedCheckpoints,
    features,
    rows,
    counts: countPublication(city, features, normalizedCheckpoints),
  };
}

export async function publishAtlas({
  city,
  fixture,
  dataRoot,
  dryRun = false,
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  const publication = await prepareAtlasPublication({ city, fixture, dataRoot });
  if (dryRun) return { ...publication, published: false };

  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("No fetch implementation is available");
  }

  const supabaseUrl = env.SUPABASE_URL || CONFIG_SUPABASE_URL;
  const response = await fetchImpl(
    `${supabaseUrl}/rest/v1/atlas_features?on_conflict=source%2Csource_id`,
    {
      method: "POST",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(publication.rows),
    },
  );
  if (!response.ok) {
    throw new Error(`Atlas publication request failed with HTTP ${response.status}`);
  }

  return { ...publication, published: true };
}

function publicationPaths({ city, fixture, dataRoot }) {
  if (fixture) {
    const root = path.resolve(fixture);
    return {
      imported: path.join(root, "ohm-source.json"),
      curated: path.join(root, "curated.geojson"),
      overrides: path.join(root, "overrides.json"),
      exclusions: path.join(root, "exclusions.json"),
      checkpoints: path.join(root, "checkpoints.json"),
    };
  }

  const curationRoot = path.join(path.resolve(dataRoot), "curated", city);
  return {
    imported: path.join(path.resolve(dataRoot), "imported", city, "ohm-source.json"),
    curated: path.join(curationRoot, "features.geojson"),
    overrides: path.join(curationRoot, "overrides.json"),
    exclusions: path.join(curationRoot, "exclusions.json"),
    checkpoints: path.join(curationRoot, "checkpoints.json"),
  };
}

async function readJson(file, { optional = false, fallback } = {}) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (optional && error.code === "ENOENT") return structuredClone(fallback);
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in atlas publication input "${file}"`);
    }
    throw error;
  }
}

function validateCheckpoints(value, city) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(checkpoint => !Number.isInteger(checkpoint))
  ) {
    throw new Error(`Atlas checkpoints for "${city}" must be a non-empty array of integers`);
  }
  const sorted = [...new Set(value)].sort((left, right) => left - right);
  if (sorted.length !== value.length || sorted.some((checkpoint, index) => checkpoint !== value[index])) {
    throw new Error(`Atlas checkpoints for "${city}" must be unique and ascending`);
  }
  return sorted;
}

function featureToRow(city, feature) {
  const properties = feature.properties;
  if (properties.start_date === null || properties.start_year === null) {
    throw new Error(`Invalid atlas record "${feature.id}": publication requires a start date`);
  }
  if (properties.end_year !== null && properties.end_year <= properties.start_year) {
    throw new Error(`Invalid atlas record "${feature.id}": end year must be after start year`);
  }

  return stableClone({
    city_slug: city,
    source: properties.source,
    source_id: properties.source_id,
    layer_category: properties.layer,
    name: properties.name,
    start_date: properties.start_date,
    end_date: properties.end_date,
    start_year: properties.start_year,
    end_year: properties.end_year,
    source_properties: properties.source_properties,
    geom: feature.geometry,
  });
}

function countPublication(city, features, checkpoints) {
  const counts = {
    city: { [city]: features.length },
    layer: {},
    source: {},
    checkpoint: {},
  };
  for (const feature of features) {
    increment(counts.layer, feature.properties.layer);
    increment(counts.source, feature.properties.source);
  }
  for (const checkpoint of checkpoints) {
    counts.checkpoint[String(checkpoint)] = features.filter(feature =>
      isAtlasFeatureVisible(feature, checkpoint),
    ).length;
  }
  return stableClone(counts);
}

function increment(counts, key) {
  counts[key] = (counts[key] ?? 0) + 1;
}

function emptyFeatureCollection() {
  return { type: "FeatureCollection", features: [] };
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
    if (argument === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (!["--city", "--fixture"].includes(argument)) {
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
  const result = await publishAtlas(parseArguments(process.argv.slice(2)));
  if (result.published) {
    console.log(`Published ${result.rows.length} atlas features for ${result.city}`);
  } else {
    console.log(JSON.stringify(result.counts, null, 2));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
