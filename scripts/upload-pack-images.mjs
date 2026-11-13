// Publishes the Guess the Price item photos in data/pack-images/<pack>/ to a
// public Supabase Storage bucket, so pack_items.image_url can point at stable,
// self-hosted URLs instead of fragile third-party hotlinks.
//
// Companion to scripts/upload-packs.mjs: run this FIRST to host the images, then
// upload-packs.mjs to publish the pack rows whose image_url references them.
// Re-runnable: the bucket is created if missing (ignored if it already exists)
// and every object is uploaded with upsert, so re-running just refreshes bytes.
//
// Like upload-packs.mjs this is an admin/publish tool (not shipped), talks to
// Storage through scripts/lib/supabase-admin.mjs (no SDK), and authenticates with the SERVICE-ROLE
// key — a secret read from the environment, never committed.
//
// Layout: data/pack-images/<pack-slug>/<file>  ->  object <pack-slug>/<file> in
// the bucket. The public URL is:
//   <SUPABASE_URL>/storage/v1/object/public/<BUCKET>/<pack-slug>/<file>
//
// Usage:
//   SUPABASE_SERVICE_ROLE_KEY=... node scripts/upload-pack-images.mjs

import { readdir, readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, extname } from 'node:path';
import { createSupabaseAdminOrExit } from './lib/supabase-admin.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const IMAGES_DIR = resolve(HERE, '../data/pack-images');
const BUCKET = process.env.PACK_IMAGES_BUCKET || 'pack-images';

const supabase = createSupabaseAdminOrExit({ command: 'node scripts/upload-pack-images.mjs' });
const SUPABASE_URL = supabase.url;

const CONTENT_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

// Creates the bucket as public. A 400 "already exists" is the expected no-op on
// re-runs, so only genuinely unexpected failures throw.
async function ensureBucket() {
  const res = await supabase.storage('bucket', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: BUCKET, name: BUCKET, public: true }),
  });
  if (res.ok) {
    console.log(`  created public bucket "${BUCKET}"`);
    return;
  }
  const text = await res.text();
  if (res.status === 400 && /exist/i.test(text)) {
    console.log(`  bucket "${BUCKET}" already exists`);
    return;
  }
  throw new Error(
    `create bucket failed (${res.status} ${res.statusText}): ${supabase.summarizeErrorBody(text)}`,
  );
}

async function uploadObject(objectPath, bytes, contentType) {
  const res = await supabase.storage(
    `object/${BUCKET}/${objectPath}`,
    {
      method: 'POST',
      headers: { 'Content-Type': contentType, 'x-upsert': 'true' },
      body: bytes,
    },
  );
  if (!res.ok) {
    const text = await supabase.summarizeError(res);
    throw new Error(`upload ${objectPath} failed (${res.status} ${res.statusText}): ${text}`);
  }
}

async function listPackDirs() {
  const entries = await readdir(IMAGES_DIR, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

async function listImages(packDir) {
  const dir = resolve(IMAGES_DIR, packDir);
  const names = await readdir(dir);
  return names.filter((n) => CONTENT_TYPES[extname(n).toLowerCase()]);
}

async function main() {
  await ensureBucket();

  let total = 0;
  const packs = await listPackDirs();
  for (const pack of packs) {
    const files = await listImages(pack);
    for (const file of files) {
      const abs = resolve(IMAGES_DIR, pack, file);
      const info = await stat(abs);
      if (!info.isFile()) continue;
      const bytes = await readFile(abs);
      const contentType = CONTENT_TYPES[extname(file).toLowerCase()];
      const objectPath = `${pack}/${file}`;
      await uploadObject(objectPath, bytes, contentType);
      total += 1;
      const url = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${objectPath}`;
      console.log(`  uploaded ${objectPath.padEnd(44)} ${url}`);
    }
  }

  console.log(`\nUploaded ${total} image(s) to bucket "${BUCKET}" on ${SUPABASE_URL}`);
}

main().catch((err) => {
  console.error('\nImage upload failed:', err.message);
  process.exit(1);
});
