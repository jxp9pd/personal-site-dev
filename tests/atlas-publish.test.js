import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  prepareAtlasPublication,
  publishAtlas,
} from "../scripts/publish-atlas.mjs";

const fixture = path.resolve("tests/fixtures/atlas/publish");
const temporaryDirectories = [];

async function copyFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "atlas-publish-test-"));
  temporaryDirectories.push(directory);
  await cp(fixture, directory, { recursive: true });
  return directory;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true })),
  );
});

describe("atlas publication preparation", () => {
  it("merges inputs deterministically with overrides, exclusions, and isolated identities", async () => {
    const first = await prepareAtlasPublication({ city: "sf", fixture });
    const shuffledFixture = await copyFixture();
    const importedFile = path.join(shuffledFixture, "ohm-source.json");
    const imported = JSON.parse(await readFile(importedFile, "utf8"));
    imported.records.reverse();
    await writeFile(importedFile, JSON.stringify(imported));

    const second = await prepareAtlasPublication({ city: "sf", fixture: shuffledFixture });

    expect(second.rows).toEqual(first.rows);
    expect(first.rows).toHaveLength(2);
    expect(first.rows.map(row => [row.source, row.source_id])).toEqual([
      ["curated", "node/10"],
      ["ohm", "node/10"],
    ]);
    expect(first.rows.find(row => row.source === "ohm")).toMatchObject({
      name: "Corrected neighborhood",
      start_date: "1850",
      start_year: 1850,
    });
    expect(first.rows.some(row => row.source_id === "node/20")).toBe(false);
    expect(first.counts).toEqual({
      checkpoint: { 1850: 1, 1900: 2, 1950: 1 },
      city: { sf: 2 },
      layer: { landmarks: 1, neighborhoods: 1 },
      source: { curated: 1, ohm: 1 },
    });
  });

  it("validates the complete set before making any write request", async () => {
    const invalidFixture = await copyFixture();
    const curatedFile = path.join(invalidFixture, "curated.geojson");
    const curated = JSON.parse(await readFile(curatedFile, "utf8"));
    curated.features[0].properties.end_date = "1900";
    const fetchImpl = vi.fn();
    await writeFile(curatedFile, JSON.stringify(curated));

    await expect(
      publishAtlas({
        city: "sf",
        fixture: invalidFixture,
        env: { SUPABASE_SERVICE_ROLE_KEY: "test-secret" },
        fetchImpl,
      }),
    ).rejects.toThrow(/curated:node\/10.*end year must be after start year/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("atlas publication requests", () => {
  it("supports dry runs without a service-role key or network request", async () => {
    const fetchImpl = vi.fn();
    const result = await publishAtlas({
      city: "sf",
      fixture,
      dryRun: true,
      env: {},
      fetchImpl,
    });

    expect(result.published).toBe(false);
    expect(result.counts.city).toEqual({ sf: 2 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("requires the current environment secret before writing", async () => {
    const fetchImpl = vi.fn();

    await expect(
      publishAtlas({ city: "sf", fixture, env: {}, fetchImpl }),
    ).rejects.toThrow("Missing SUPABASE_SERVICE_ROLE_KEY");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("makes repeatable provenance upserts with deterministic request bodies", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 201 }));
    const options = {
      city: "sf",
      fixture,
      env: {
        SUPABASE_SERVICE_ROLE_KEY: "test-secret",
        SUPABASE_URL: "https://example.supabase.co",
      },
      fetchImpl,
    };

    await publishAtlas(options);
    await publishAtlas(options);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1]).toEqual(fetchImpl.mock.calls[0]);
    const [url, request] = fetchImpl.mock.calls[0];
    expect(url).toBe(
      "https://example.supabase.co/rest/v1/atlas_features?on_conflict=source%2Csource_id",
    );
    expect(request).toMatchObject({
      method: "POST",
      headers: {
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
    });
    expect(JSON.parse(request.body).map(row => [row.source, row.source_id])).toEqual([
      ["curated", "node/10"],
      ["ohm", "node/10"],
    ]);
  });

  it("rejects failed API responses without exposing the service-role key", async () => {
    const secret = "do-not-print-this-secret";
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 409 }));

    let failure;
    try {
      await publishAtlas({
        city: "sf",
        fixture,
        env: {
          SUPABASE_SERVICE_ROLE_KEY: secret,
          SUPABASE_URL: "https://example.supabase.co",
        },
        fetchImpl,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure?.message).toBe("Atlas publication request failed with HTTP 409");
    expect(failure?.message).not.toContain(secret);
  });

  it("summarizes structured PostgREST failures without exposing secrets", async () => {
    const secret = "do-not-print-this-secret";
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({
        code: "23514",
        message: "new row violates check constraint",
        details: "Failing row contains ohm:way/199596913",
        hint: `authorization ${secret}`,
        ignored: "x".repeat(1000),
      }),
    }));

    await expect(
      publishAtlas({
        city: "sf",
        fixture,
        env: {
          SUPABASE_SERVICE_ROLE_KEY: secret,
          SUPABASE_URL: "https://example.supabase.co",
        },
        fetchImpl,
      }),
    ).rejects.toThrow(
      "Atlas publication request failed with HTTP 400: code=23514; " +
        "message=new row violates check constraint; " +
        "details=Failing row contains ohm:way/199596913; " +
        "hint=authorization [redacted]",
    );
  });
});
