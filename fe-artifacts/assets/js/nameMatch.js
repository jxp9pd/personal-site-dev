// Pure, dependency-free matching core for name-recall games.
// No DOM / Leaflet / Supabase; safe to import from tests and other modules.

// Interior spaces between words are meaningful: "kips bay" must not equal
// "kipsbay". So punctuation becomes a space and runs of whitespace collapse to
// a single space, rather than being stripped outright.
export function normalizeName(str) {
  return String(str)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function createNameIndex(features) {
  const list = Array.isArray(features) ? features : [];
  const names = list.map(f => f?.properties?.name);
  const byKey = new Map();

  // Canonical names are authoritative: they claim their key unconditionally and
  // must never be overwritten by an alias, even across features.
  for (const name of names) {
    const key = normalizeName(name);
    byKey.set(key, name);
  }

  for (const f of list) {
    const name = f?.properties?.name;
    const aliases = f?.properties?.aliases;
    if (!Array.isArray(aliases)) continue;
    for (const alias of aliases) {
      const key = normalizeName(alias);
      if (!byKey.has(key)) byKey.set(key, name);
    }
  }

  return {
    match(rawGuess) {
      const key = normalizeName(rawGuess);
      return byKey.has(key) ? byKey.get(key) : null;
    },
    names,
    size: names.length,
  };
}
