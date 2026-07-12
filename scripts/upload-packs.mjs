// Publishes the Guess the Price content in data/packs/ to the Supabase `packs`
// and `pack_items` tables (see supabase/migrations/0006_packs.sql). Re-runnable:
// packs are upserted on `slug`, and each pack's items are replaced wholesale
// (delete-then-insert), so running it again just refreshes existing packs.
//
// This is an admin/publish tool, not part of the shipped site. It talks to
// PostgREST directly with global fetch (no SDK dependency) and authenticates
// with the SERVICE-ROLE key, which bypasses RLS. That key is a secret: it is
// read from the environment and must never be committed or shipped to config.js.
//
// Usage:
//   SUPABASE_SERVICE_ROLE_KEY=... node scripts/upload-packs.mjs
//
// The project URL defaults to the one in the public config; override with
// SUPABASE_URL if needed.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { SUPABASE_URL as CONFIG_URL } from '../fe-artifacts/assets/js/config.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(HERE, '../data/packs');
const ART_DIR = resolve(DATA_DIR, 'art');

// Each entry names a data file in data/packs/ (metadata + item list) and an
// optional `art` SVG in data/packs/art/ rendered behind the pack name on the
// selector — mirroring how upload-quizzes.mjs handles landmark art.
const PACKS = [
  { file: 'wearables.data.json', art: 'wearables.svg' },
  { file: 'groceries.data.json', art: 'groceries.svg' },
  { file: 'starter-pack.data.json', art: 'starter-pack.svg' },
  { file: 'costco.data.json', art: 'costco.svg' },
];

const SUPABASE_URL = process.env.SUPABASE_URL || CONFIG_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SERVICE_ROLE_KEY) {
  console.error(
    'Missing SUPABASE_SERVICE_ROLE_KEY.\n' +
    'Find it in the Supabase dashboard: Project Settings → API → service_role key.\n' +
    'Run: SUPABASE_SERVICE_ROLE_KEY=... node scripts/upload-packs.mjs',
  );
  process.exit(1);
}

const AUTH_HEADERS = {
  apikey: SERVICE_ROLE_KEY,
  Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
};

async function readPack(entry) {
  const raw = await readFile(resolve(DATA_DIR, entry.file), 'utf8');
  const pack = JSON.parse(raw);
  if (!Array.isArray(pack.items) || pack.items.length === 0) {
    throw new Error(`${entry.file} has no items`);
  }
  // Pack art is optional: a missing file leaves art_svg null and the card falls
  // back to the plain centered name.
  if (entry.art) {
    try {
      pack.art_svg = (await readFile(resolve(ART_DIR, entry.art), 'utf8')).trim();
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      console.warn(`  ! ${pack.slug}: art file ${entry.art} not found, skipping art_svg`);
    }
  }
  return pack;
}

async function request(path, { method, body, prefer }) {
  const headers = { ...AUTH_HEADERS };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} ${path} failed (${res.status} ${res.statusText}): ${text}`);
  }
}

async function publishPack(pack, index) {
  await request('packs', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=minimal',
    body: [
      {
        slug: pack.slug,
        name: pack.name,
        description: pack.description,
        sort_order: pack.sort_order ?? index,
        art_svg: pack.art_svg ?? null,
        updated_at: new Date().toISOString(),
      },
    ],
  });

  // Replace the pack's items wholesale so removed/reordered items don't linger.
  await request(`pack_items?pack_slug=eq.${encodeURIComponent(pack.slug)}`, {
    method: 'DELETE',
    prefer: 'return=minimal',
  });

  const rows = pack.items.map((item, i) => ({
    pack_slug: pack.slug,
    name: item.name,
    price: item.price,
    image_url: item.image_url ?? null,
    sort_order: i,
  }));
  await request('pack_items', {
    method: 'POST',
    prefer: 'return=minimal',
    body: rows,
  });
}

async function main() {
  let itemTotal = 0;
  for (const [i, entry] of PACKS.entries()) {
    const pack = await readPack(entry);
    await publishPack(pack, i);
    itemTotal += pack.items.length;
    console.log(`  published ${pack.slug.padEnd(12)} ${pack.items.length} items`);
  }

  console.log(`\nUpserted ${PACKS.length} packs (${itemTotal} items) to ${SUPABASE_URL}`);
}

main().catch((err) => {
  console.error('\nUpload failed:', err.message);
  process.exit(1);
});
