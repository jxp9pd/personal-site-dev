// Single source of truth for game display metadata.
// Adding a future game should be a pure edit to GAMES below — no other file needs
// to change beyond importing this module and calling into it.
//
// Shape: slug -> { name, modes: { modeKey: label } }
// Only score-tracked modes belong here. Untracked modes (e.g. the SF quiz "learn"
// tab) are intentionally omitted so they can't be recorded as plays.
const NEIGHBORHOOD_MODES = { find: 'Find it', name: 'Name it' };

const GAMES = {
  'sf-neighborhoods': {
    name: 'Neighborhoods of SF',
    category: 'Neighborhoods',
    modes: NEIGHBORHOOD_MODES,
  },
  'seattle-neighborhoods': {
    name: 'Neighborhoods of Seattle',
    category: 'Neighborhoods',
    modes: NEIGHBORHOOD_MODES,
  },
  'dc-neighborhoods': {
    name: 'Neighborhoods of DC + Arlington',
    category: 'Neighborhoods',
    modes: NEIGHBORHOOD_MODES,
  },
  'fairfax-neighborhoods': {
    name: 'Neighborhoods of Fairfax County',
    category: 'Neighborhoods',
    modes: NEIGHBORHOOD_MODES,
  },
  'guess-the-price': {
    name: 'Guess the Price',
    category: 'Guess the Price',
    modes: { 'starter-pack': 'Starter Pack', costco: 'Costco', wearables: 'Wearables', groceries: 'Groceries' },
  },
};

export function getGame(slug) {
  return GAMES[slug] ?? null;
}

export function getModeLabel(slug, mode) {
  const game = getGame(slug);
  return game?.modes?.[mode] ?? null;
}

export function isKnownSlug(slug) {
  return Object.prototype.hasOwnProperty.call(GAMES, slug);
}

export function categoryOf(slug) {
  return getGame(slug)?.category ?? null;
}

// Groups games under their category as an ordered array so callers can render
// sections without re-sorting. Categories appear in first-seen order and games
// keep their GAMES declaration order within each category.
export function gamesByCategory() {
  const order = [];
  const byCategory = new Map();

  for (const [slug, meta] of Object.entries(GAMES)) {
    const category = meta.category;
    if (!category) continue;
    if (!byCategory.has(category)) {
      byCategory.set(category, []);
      order.push(category);
    }
    byCategory.get(category).push({ slug, ...meta });
  }

  return order.map((category) => ({ category, games: byCategory.get(category) }));
}
