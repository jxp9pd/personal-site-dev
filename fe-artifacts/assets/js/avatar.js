const PALETTE = [
  "#e6194b",
  "#3cb44b",
  "#4363d8",
  "#f58231",
  "#911eb4",
  "#008080",
  "#9a6324",
  "#800000",
];

const FALLBACK_INITIALS = "?";

function normalizeSeed(seed) {
  if (typeof seed !== "string") return "";
  return seed.trim();
}

function extractInitials(seed) {
  const words = seed.split(/[\s._-]+/).filter(Boolean);
  if (words.length === 0) return FALLBACK_INITIALS;
  if (words.length === 1) return words[0].charAt(0).toUpperCase();
  return (words[0].charAt(0) + words[words.length - 1].charAt(0)).toUpperCase();
}

// djb2 keeps the palette pick stable across runs without relying on
// insertion order or the JS engine's hashing internals.
function hashSeed(seed) {
  let hash = 5381;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 33) ^ seed.charCodeAt(i);
  }
  return hash >>> 0;
}

export function initialsAvatar(seed) {
  const normalized = normalizeSeed(seed);
  const initials = extractInitials(normalized);
  const key = normalized || FALLBACK_INITIALS;
  const color = PALETTE[hashSeed(key) % PALETTE.length];
  return { initials, color };
}

export { PALETTE };
