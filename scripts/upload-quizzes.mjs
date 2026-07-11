// Publishes the neighborhood-quiz content in data/quizzes/ to the Supabase
// `quizzes` table (see supabase/migrations/0002_quizzes.sql). Re-runnable: rows
// are upserted on `slug`, so running it again just refreshes existing quizzes.
//
// This is an admin/publish tool, not part of the shipped site. It talks to
// PostgREST directly with global fetch (no SDK dependency) and authenticates
// with the SERVICE-ROLE key, which bypasses RLS. That key is a secret: it is
// read from the environment and must never be committed or shipped to config.js.
//
// Usage:
//   SUPABASE_SERVICE_ROLE_KEY=... node scripts/upload-quizzes.mjs
//
// The project URL defaults to the one in the public config; override with
// SUPABASE_URL if needed.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { SUPABASE_URL as CONFIG_URL } from '../fe-artifacts/assets/js/config.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(HERE, '../data/quizzes');

// Single source of truth for quiz metadata at publish time. `file` is the
// GeoJSON source in data/quizzes/; everything else populates the table columns.
const QUIZZES = [
  {
    slug: 'sf-neighborhoods',
    name: 'San Francisco',
    description: 'How well do you really know San Francisco? Place the neighborhoods and find out.',
    center: [37.759, -122.444],
    zoom: 12,
    file: 'sf-neighborhoods.data.json',
  },
  {
    slug: 'seattle-neighborhoods',
    name: 'Seattle',
    description: 'Ballard to Beacon Hill, Fremont to Rainier Valley — place the Emerald City.',
    center: [47.6276, -122.3408],
    zoom: 12,
    file: 'seattle-neighborhoods.data.json',
  },
  {
    slug: 'dc-neighborhoods',
    name: 'DC + Arlington',
    description: 'Georgetown to Anacostia, Rosslyn to Shirlington — how well do you know DC and Arlington?',
    center: [38.8936, -77.0409],
    zoom: 12,
    file: 'dc-neighborhoods.data.json',
  },
  {
    slug: 'fairfax-neighborhoods',
    name: 'Fairfax County',
    description: 'Reston, McLean, Annandale and more — place the communities of Fairfax County.',
    center: [38.8621, -77.3035],
    zoom: 11,
    file: 'fairfax-neighborhoods.data.json',
  },
];

const SUPABASE_URL = process.env.SUPABASE_URL || CONFIG_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SERVICE_ROLE_KEY) {
  console.error(
    'Missing SUPABASE_SERVICE_ROLE_KEY.\n' +
    'Find it in the Supabase dashboard: Project Settings → API → service_role key.\n' +
    'Run: SUPABASE_SERVICE_ROLE_KEY=... node scripts/upload-quizzes.mjs',
  );
  process.exit(1);
}

async function buildRow(q, index) {
  const raw = await readFile(resolve(DATA_DIR, q.file), 'utf8');
  const parsed = JSON.parse(raw);
  const geo = parsed.geo ?? parsed; // tolerate a bare FeatureCollection
  const featureCount = geo?.features?.length ?? 0;
  if (!featureCount) throw new Error(`${q.file} has no GeoJSON features`);

  return {
    row: {
      slug: q.slug,
      name: q.name,
      description: q.description,
      center_lat: q.center[0],
      center_lng: q.center[1],
      zoom: q.zoom,
      geo,
      sort_order: index,
      updated_at: new Date().toISOString(),
    },
    featureCount,
  };
}

async function main() {
  const rows = [];
  for (const [i, q] of QUIZZES.entries()) {
    const { row, featureCount } = await buildRow(q, i);
    rows.push(row);
    console.log(`  prepared ${q.slug.padEnd(22)} ${featureCount} neighborhoods`);
  }

  const res = await fetch(`${SUPABASE_URL}/rest/v1/quizzes`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(rows),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Upsert failed (${res.status} ${res.statusText}): ${body}`);
  }

  console.log(`\nUpserted ${rows.length} quizzes to ${SUPABASE_URL}`);
}

main().catch((err) => {
  console.error('\nUpload failed:', err.message);
  process.exit(1);
});
