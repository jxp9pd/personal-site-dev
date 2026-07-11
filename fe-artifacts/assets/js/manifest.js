// Single source of truth for game display metadata.
// Adding a future game should be a pure edit to GAMES below — no other file needs
// to change beyond importing this module and calling into it.
//
// Shape: slug -> { name, modes: { modeKey: label } }
// Only score-tracked modes belong here. Untracked modes (e.g. the SF quiz "learn"
// tab) are intentionally omitted so they can't be recorded as plays.
const GAMES = {
  'sf-neighborhoods': {
    name: 'Neighborhoods of SF',
    modes: {
      find: 'Find it',
      name: 'Name it',
    },
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
