import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { isAtlasFeatureVisible } from "./lib/atlas-normalize.js";
import { prepareAtlasPublication } from "./publish-atlas.mjs";

const REQUIRED_LAYERS = ["neighborhoods", "landmarks"];

export async function auditAtlas({ city, dataRoot = path.resolve("data/time-atlas") } = {}) {
  if (!city) throw new Error("Atlas audit requires a city");

  const curationRoot = path.join(dataRoot, "curated", city);
  const publication = await prepareAtlasPublication({ city, dataRoot });
  const [imported, overrides, exclusions, allowlist] = await Promise.all([
    readJson(path.join(dataRoot, "imported", city, "ohm-source.json")),
    readJson(path.join(curationRoot, "overrides.json"), {}),
    readJson(path.join(curationRoot, "exclusions.json"), []),
    readJson(path.join(curationRoot, "audit-allowlist.json"), []),
  ]);
  const acknowledgements = acknowledgementMap(overrides, exclusions, allowlist);
  const suspicious = imported.records
    .map(record => {
      const identity = `ohm:${record.type}/${record.id}`;
      const tags = record.tags ?? {};
      const acknowledgement =
        acknowledgements.get(identity) ?? matchingAllowlistEntry(tags, allowlist);
      return {
        identity,
        findings: suspiciousFindings(tags),
        acknowledgement: acknowledgement ?? null,
      };
    })
    .filter(entry => entry.findings.length > 0)
    .map(entry => ({
      ...entry,
      acknowledged: entry.acknowledgement !== null,
    }));

  const checkpoints = [];
  let previousIds = null;
  for (const checkpoint of publication.checkpoints) {
    const visible = publication.features.filter(feature =>
      isAtlasFeatureVisible(feature, checkpoint),
    );
    const ids = new Set(visible.map(feature => feature.id));
    const layer = countBy(visible, feature => feature.properties.layer);
    const source = countBy(visible, feature => feature.properties.source);
    const added = previousIds
      ? [...ids].filter(identity => !previousIds.has(identity)).length
      : visible.length;
    const removed = previousIds
      ? [...previousIds].filter(identity => !ids.has(identity)).length
      : 0;
    const missingLayers = REQUIRED_LAYERS.filter(required => !layer[required]);
    checkpoints.push({
      checkpoint,
      visible: visible.length,
      layer,
      source,
      added,
      removed,
      suspicious: suspicious.filter(entry => ids.has(entry.identity)).length,
      missingLayers,
      noChange: previousIds !== null && added === 0 && removed === 0,
    });
    previousIds = ids;
  }

  const failures = [];
  for (const checkpoint of checkpoints) {
    if (checkpoint.missingLayers.length > 0) {
      failures.push(
        `${checkpoint.checkpoint} missing required layers: ${checkpoint.missingLayers.join(", ")}`,
      );
    }
    if (checkpoint.noChange) failures.push(`${checkpoint.checkpoint} has no change`);
  }
  const unacknowledged = suspicious.filter(entry => !entry.acknowledged);
  if (unacknowledged.length > 0) {
    failures.push(`${unacknowledged.length} suspicious temporal values are unacknowledged`);
  }

  return {
    city,
    checkpoints,
    suspicious,
    summary: {
      features: publication.features.length,
      suspicious: suspicious.length,
      unacknowledged: unacknowledged.length,
      failures,
    },
  };
}

function suspiciousFindings(tags) {
  const findings = [];
  const temporal = [
    ["start_date", tags.start_date],
    ["end_date", tags.end_date],
    ["date", tags.date],
  ];
  for (const [field, value] of temporal) {
    if (value === undefined || value === null || value === "") continue;
    const text = String(value);
    if (/[?~]/.test(text)) findings.push(`${field} is approximate: ${text}`);
    if (/^\d{4}-\d{2}-\d{2}$/.test(text) && !isCalendarDate(text)) {
      findings.push(`${field} is not a valid calendar date: ${text}`);
    }
  }
  for (const boundary of ["start_date", "end_date"]) {
    if (String(tags[`${boundary}:confidence`] ?? "").toLowerCase() === "low") {
      findings.push(`${boundary} confidence is low`);
    }
  }
  const start = yearOf(tags.start_date);
  const end = yearOf(tags.end_date);
  if (start !== null && end !== null && start >= end) {
    findings.push(`temporal range is not positive: ${start}–${end}`);
  }
  if (String(tags.source ?? "").toLowerCase() === "arbitrary") {
    findings.push("temporal source is marked arbitrary");
  }
  return findings;
}

function isCalendarDate(text) {
  const [year, month, day] = text.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function yearOf(value) {
  const match = /^(\d{4})/.exec(String(value ?? ""));
  return match ? Number(match[1]) : null;
}

function acknowledgementMap(overrides, exclusions, allowlist) {
  const entries = new Map();
  for (const [identity, metadata] of Object.entries(overrides)) {
    entries.set(normalizeIdentity(identity), metadata);
  }
  for (const entry of [...exclusions, ...allowlist]) {
    const identity = typeof entry === "string"
      ? entry
      : entry.identity ?? entry.id ?? entry.source_id;
    if (identity) entries.set(normalizeIdentity(identity), entry);
  }
  return entries;
}

function matchingAllowlistEntry(tags, allowlist) {
  return allowlist.find(entry => {
    if (!entry?.match || typeof entry.match !== "object") return false;
    return Object.entries(entry.match).every(([key, value]) => tags[key] === value);
  });
}

function normalizeIdentity(identity) {
  const value = String(identity);
  return value.startsWith("ohm:") ? value : `ohm:${value}`;
}

function countBy(values, getKey) {
  const counts = {};
  for (const value of values) {
    const key = getKey(value);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) =>
    left.localeCompare(right),
  ));
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return structuredClone(fallback);
    throw error;
  }
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== "--city") throw new Error(`Unknown argument "${argument}"`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error("--city requires a value");
    options.city = value;
    index += 1;
  }
  if (!options.city) throw new Error("--city is required");
  return options;
}

async function main() {
  const result = await auditAtlas(parseArguments(process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
  if (result.summary.failures.length > 0) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
