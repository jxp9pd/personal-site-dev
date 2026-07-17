const GEOJSON_COORDINATE_DEPTH = {
  Point: 0,
  MultiPoint: 1,
  LineString: 1,
  MultiLineString: 2,
  Polygon: 2,
  MultiPolygon: 3,
};

const NEIGHBORHOOD_PLACES = new Set(["neighbourhood", "neighborhood", "quarter", "suburb"]);
const LANDMARK_TAGS = ["historic", "tourism", "amenity", "building", "man_made", "memorial"];
const SUPPORTED_LAYERS = new Set(["neighborhoods", "landmarks"]);

export function normalizeAtlasFeatures({
  imported = [],
  curated = [],
  overrides = {},
  exclusions = [],
} = {}) {
  assertArray(imported, "imported");
  assertArray(curated, "curated");

  const overrideMap = normalizeOverrides(overrides);
  const exclusionSet = normalizeExclusions(exclusions);
  const inputs = [
    ...imported.map(record => ({ record, source: "ohm" })),
    ...curated.map(record => ({ record, source: "curated" })),
  ];
  const identities = new Set();
  const features = [];

  for (const input of inputs) {
    const identity = getIdentity(input.record, input.source);
    if (identities.has(identity.id)) {
      fail(identity.id, "duplicate identity");
    }
    identities.add(identity.id);

    if (exclusionSet.has(identity.id) || exclusionSet.has(identity.sourceId)) {
      continue;
    }

    const override = overrideMap.get(identity.id) ?? overrideMap.get(identity.sourceId);
    const candidate = applyOverride(input.record, override);
    features.push(normalizeRecord(candidate, identity));
  }

  return features.sort((left, right) => left.id.localeCompare(right.id));
}

export function isAtlasFeatureVisible(feature, checkpoint) {
  const year = Number(checkpoint);
  if (!Number.isInteger(year)) {
    throw new TypeError(`Invalid checkpoint "${checkpoint}"`);
  }

  const start = feature?.properties?.start_year;
  const end = feature?.properties?.end_year;
  return (start === null || start <= year) && (end === null || year < end);
}

function normalizeRecord(record, identity) {
  const label = identity.id;
  const geometry = clone(record?.geometry);
  validateGeometry(geometry, label);

  const sourceProperties =
    identity.source === "ohm"
      ? clone(record.tags ?? record.properties ?? {})
      : clone(record.properties ?? {});
  const layer = classify(record, sourceProperties);
  if (!layer) fail(label, "record cannot be classified as neighborhoods or landmarks");

  const temporal = normalizeTemporal(record, sourceProperties, label);
  if (
    temporal.startYear !== null &&
    temporal.endYear !== null &&
    temporal.startYear > temporal.endYear
  ) {
    fail(label, "start year is after end year");
  }

  const name = sourceProperties.name ?? record.name ?? null;
  return stableClone({
    type: "Feature",
    id: identity.id,
    geometry,
    properties: {
      name,
      layer,
      start_date: temporal.rawStart,
      end_date: temporal.rawEnd,
      start_year: temporal.startYear,
      end_year: temporal.endYear,
      source: identity.source,
      source_id: identity.sourceId,
      source_properties: sourceProperties,
    },
  });
}

function getIdentity(record, source) {
  if (!record || typeof record !== "object") {
    fail(`${source}:unknown`, "record must be an object");
  }

  if (source === "ohm") {
    const elementType = record.type ?? record.element_type ?? record.elementType;
    const numericId = record.id ?? record.osm_id;
    if (!["node", "way", "relation"].includes(elementType) || !isNumericId(numericId)) {
      fail(describeRecord(record, source), "missing OpenHistoricalMap element type or numeric ID");
    }
    const sourceId = `${elementType}/${String(numericId)}`;
    return { id: `ohm:${sourceId}`, source, sourceId };
  }

  const curatedId = record.id ?? record.properties?.id ?? record.properties?.source_id;
  if (
    (typeof curatedId !== "string" && typeof curatedId !== "number") ||
    String(curatedId).trim() === ""
  ) {
    fail(describeRecord(record, source), "missing curated identity");
  }
  const sourceId = String(curatedId);
  return { id: `curated:${sourceId}`, source, sourceId };
}

function isNumericId(value) {
  return (
    (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) ||
    (typeof value === "string" && /^\d+$/.test(value))
  );
}

function describeRecord(record, source) {
  const hint = record?.properties?.name ?? record?.tags?.name ?? record?.name ?? "unknown";
  return `${source}:${hint}`;
}

function classify(record, properties) {
  const explicit = properties.layer ?? properties.atlas_layer ?? record.layer;
  if (SUPPORTED_LAYERS.has(explicit)) return explicit;

  const place = properties.place?.toLowerCase?.();
  if (
    NEIGHBORHOOD_PLACES.has(place) ||
    properties.boundary === "administrative" ||
    properties.type === "boundary"
  ) {
    return "neighborhoods";
  }
  if (LANDMARK_TAGS.some(tag => properties[tag] !== undefined && properties[tag] !== "no")) {
    return "landmarks";
  }
  return null;
}

function normalizeTemporal(record, properties, label) {
  const rawStart = firstDefined(
    record.start_date,
    record.startDate,
    properties.start_date,
    properties.startDate,
  );
  const rawEnd = firstDefined(
    record.end_date,
    record.endDate,
    properties.end_date,
    properties.endDate,
  );
  const singleDate = firstDefined(record.date, properties.date);

  if (rawStart === undefined && rawEnd === undefined && singleDate !== undefined) {
    const text = String(singleDate).trim();
    const interval = text.includes("/")
      ? parseInterval(text, label)
      : { start: parseDateYear(text, "start", label), end: null };
    return {
      rawStart: asRaw(singleDate),
      rawEnd: null,
      startYear: interval.start,
      endYear: interval.end,
    };
  }

  const start = parseBoundary(rawStart, "start", label);
  const end = parseBoundary(rawEnd, "end", label);
  if (start.interval || end.interval) {
    if (start.interval && rawEnd === undefined) {
      return {
        rawStart: asRaw(rawStart),
        rawEnd: null,
        startYear: start.interval.start,
        endYear: start.interval.end,
      };
    }
    fail(label, "an EDTF interval must be the only temporal value");
  }

  return {
    rawStart: asRaw(rawStart),
    rawEnd: asRaw(rawEnd),
    startYear: start.year,
    endYear: end.year,
  };
}

function parseBoundary(value, boundary, label) {
  if (isOpen(value)) return { year: null, interval: null };
  const text = String(value).trim();
  if (text.includes("/")) {
    return { year: null, interval: parseInterval(text, label) };
  }
  return { year: parseDateYear(text, boundary, label), interval: null };
}

function parseInterval(value, label) {
  const text = String(value).trim();
  const parts = text.split("/");
  if (parts.length !== 2) fail(label, `unsupported temporal value "${text}"`);
  return {
    start: isOpen(parts[0]) ? null : parseDateYear(parts[0], "start", label),
    end: isOpen(parts[1]) ? null : parseDateYear(parts[1], "end", label),
  };
}

function parseDateYear(value, boundary, label) {
  const text = String(value).trim();
  const match = /^([+-]?\d{4})(?:-(\d{2})(?:-(\d{2}))?)?([?~])?$/.exec(text);
  if (!match) fail(label, `unsupported ${boundary} temporal value "${text}"`);

  const year = Number(match[1]);
  const month = match[2] === undefined ? null : Number(match[2]);
  const day = match[3] === undefined ? null : Number(match[3]);
  if (
    (month !== null && (month < 1 || month > 12)) ||
    (day !== null && (day < 1 || day > daysInMonth(year, month)))
  ) {
    fail(label, `unsupported ${boundary} temporal value "${text}"`);
  }
  return year;
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function isOpen(value) {
  return value === undefined || value === null || value === "" || value === ".." || value === "open";
}

function asRaw(value) {
  return isOpen(value) ? null : String(value);
}

function validateGeometry(geometry, label) {
  if (!geometry || typeof geometry !== "object" || !(geometry.type in GEOJSON_COORDINATE_DEPTH)) {
    fail(label, "invalid geometry");
  }
  if (!validCoordinates(geometry.coordinates, GEOJSON_COORDINATE_DEPTH[geometry.type])) {
    fail(label, "invalid geometry");
  }
}

function validCoordinates(value, depth) {
  if (depth === 0) {
    return (
      Array.isArray(value) &&
      value.length >= 2 &&
      value.every(coordinate => typeof coordinate === "number" && Number.isFinite(coordinate))
    );
  }
  return Array.isArray(value) && value.length > 0 && value.every(item => validCoordinates(item, depth - 1));
}

function normalizeOverrides(overrides) {
  if (Array.isArray(overrides)) {
    return new Map(
      overrides.map(override => {
        const id = override?.identity ?? override?.id ?? override?.source_id;
        if (!id) throw new TypeError("Each atlas override requires an identity");
        const changes = override.changes ?? override.override ?? omitKeys(override, ["identity", "id"]);
        return [String(id), changes];
      }),
    );
  }
  if (!overrides || typeof overrides !== "object") {
    throw new TypeError("Atlas overrides must be an object or array");
  }
  return new Map(Object.entries(overrides));
}

function normalizeExclusions(exclusions) {
  if (!Array.isArray(exclusions)) throw new TypeError("Atlas exclusions must be an array");
  return new Set(
    exclusions.map(exclusion =>
      String(
        typeof exclusion === "object"
          ? exclusion.identity ?? exclusion.id ?? exclusion.source_id
          : exclusion,
      ),
    ),
  );
}

function applyOverride(record, override) {
  const copy = clone(record);
  if (!override) return copy;

  const propertyChanges = override.properties ?? override.tags;
  const result = { ...copy, ...clone(omitKeys(override, ["properties", "tags"])) };
  if (propertyChanges) {
    if (copy.tags) result.tags = { ...copy.tags, ...clone(propertyChanges) };
    else result.properties = { ...(copy.properties ?? {}), ...clone(propertyChanges) };
  }
  return result;
}

function omitKeys(object, keys) {
  return Object.fromEntries(Object.entries(object).filter(([key]) => !keys.includes(key)));
}

function firstDefined(...values) {
  return values.find(value => value !== undefined);
}

function assertArray(value, name) {
  if (!Array.isArray(value)) throw new TypeError(`Atlas ${name} records must be an array`);
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
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

function fail(record, message) {
  throw new Error(`Invalid atlas record "${record}": ${message}`);
}
