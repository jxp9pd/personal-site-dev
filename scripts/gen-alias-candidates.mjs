// Seeds candidate `properties.aliases` into the data/quizzes/*.data.json source
// files for the Name-it recall game. This is a build-time REVIEW aid: the
// generator only *proposes* aliases (acronyms, dropped "The", a few short
// forms). A human curates the results before `npm run upload-quizzes` — the
// generator seeds, the human curates. Nothing here talks to Supabase.

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { normalizeName } from '../fe-artifacts/assets/js/nameMatch.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(HERE, '../data/quizzes');

const FILES = [
  'sf-neighborhoods.data.json',
  'seattle-neighborhoods.data.json',
  'dc-neighborhoods.data.json',
  'fairfax-neighborhoods.data.json',
  'manhattan-neighborhoods.data.json',
];

// Minimal, per-word long→short substitutions. Kept intentionally tiny; expand
// only when a real name motivates it, since every entry is a human-review cost.
const SHORT_FORMS = new Map([
  ['saint', 'St'],
  ['mount', 'Mt'],
  ['fort', 'Ft'],
]);

// Split a name into word tokens on any non-alphanumeric run, so separators like
// "/" and " - " ("Downtown/Civic Center", "Ballston - Virginia Square") don't
// leak into candidates.
function words(name) {
  return String(name).split(/[^A-Za-z0-9]+/).filter(Boolean);
}

// Raw candidate proposals for a single name, before dedupe/collision filtering.
function proposalsFor(name) {
  const out = [];
  const w = words(name);

  // Acronym from word initials, only when there are ≥2 words to abbreviate.
  if (w.length >= 2) {
    out.push(w.map((t) => t[0]).join('').toUpperCase());
  }

  // Dropped leading "The " ("The Mission" → "Mission").
  if (/^the\s+/i.test(name)) {
    out.push(name.replace(/^the\s+/i, ''));
  }

  // Short-form rewrite of the whole name if any word has one ("Mount Pleasant"
  // → "Mt Pleasant"). Only emit when a substitution actually fired.
  const short = w.map((t) => SHORT_FORMS.get(t.toLowerCase()) ?? t);
  if (short.some((t, i) => t !== w[i])) {
    out.push(short.join(' '));
  }

  return out;
}

/**
 * Pure core. Given canonical name strings, propose candidate aliases per name.
 * Returns every input name mapped to a (possibly empty) array of candidates —
 * consistent shape so callers never have to branch on presence.
 *
 * A candidate is dropped when it: is empty, normalizes to a key already owned by
 * some canonical name in the set (would shadow a real name, incl. its own — a
 * no-op alias), or duplicates an earlier candidate for the same name.
 */
export function generateAliasCandidates(names) {
  const canonicalKeys = new Set(names.map(normalizeName));
  const result = {};

  for (const name of names) {
    const seen = new Set();
    const kept = [];
    for (const cand of proposalsFor(name)) {
      const trimmed = String(cand).trim();
      if (!trimmed) continue;
      const key = normalizeName(trimmed);
      if (!key) continue;
      if (canonicalKeys.has(key)) continue; // shadows a real name (or is a no-op)
      if (seen.has(key)) continue;
      seen.add(key);
      kept.push(trimmed);
    }
    result[name] = kept;
  }

  return result;
}

async function writeFileCandidates(fileName) {
  const path = resolve(DATA_DIR, fileName);
  const parsed = JSON.parse(await readFile(path, 'utf8'));
  const features = parsed?.geo?.features ?? [];
  const names = features.map((f) => f?.properties?.name);
  const candidates = generateAliasCandidates(names);

  let added = 0;
  for (const f of features) {
    const name = f?.properties?.name;
    const proposed = candidates[name] ?? [];
    if (!proposed.length) continue;

    const existing = Array.isArray(f.properties.aliases) ? f.properties.aliases : [];
    const haveKeys = new Set(existing.map(normalizeName));
    const merged = [...existing];
    for (const cand of proposed) {
      const key = normalizeName(cand);
      if (haveKeys.has(key)) continue;
      haveKeys.add(key);
      merged.push(cand);
      added += 1;
    }
    // Only touch `aliases`; name/c/geometry and key order are left as-is so the
    // reserialized file differs from the original by exactly the inserted field.
    f.properties.aliases = merged;
  }

  // These sources are minified single-line JSON; re-serialize in the same style
  // (no spacing) to keep the diff limited to the added `aliases` keys.
  await writeFile(path, JSON.stringify(parsed));
  return added;
}

async function main() {
  console.log('Seeding alias candidates (proposals for human review):\n');
  for (const file of FILES) {
    const added = await writeFileCandidates(file);
    console.log(`  ${file.padEnd(34)} +${added} candidates`);
  }
  console.log('\nReview data/quizzes/*.data.json before `npm run upload-quizzes`.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('\nAlias generation failed:', err.message);
    process.exit(1);
  });
}
