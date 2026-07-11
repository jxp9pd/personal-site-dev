// Pure aggregation over play rows. No I/O, no DOM, no imports — safe to run in the
// browser via `<script type="module">` and in Node (Vitest) alike.
//
// A play row looks like:
//   { id, user_id, game_id, mode, score, total, created_at }
// where `created_at` is an ISO-8601 timestamp string.
//
// computeStats(plays) returns an array of per-(gameId, mode) group summaries:
//   [
//     {
//       gameId,        // string
//       mode,          // string ('find' | 'name' | ...)
//       best,          // play row with the highest score in the group
//       mostRecent,    // play row with the latest created_at in the group
//       count,         // number of plays in the group
//       history,       // plays for the group, newest-first
//     },
//     ...
//   ]
// Groups appear only if the input contains at least one play for them; a
// (game, mode) that never produced a score simply never appears. Empty input
// yields an empty array. The output array is ordered by gameId then mode
// (both ascending) for stable rendering.
//
// Tie-break rules (documented because they are non-obvious intent):
//   - best: among plays sharing the highest score, pick the EARLIEST created_at
//     (the first time that best was achieved). If those also tie, pick the
//     lexicographically smallest `id`.
//   - mostRecent / history ordering: order by created_at descending; when two
//     plays share a created_at, break the tie by `id` descending. `mostRecent`
//     is therefore history[0].

function compareRecency(a, b) {
  if (a.created_at !== b.created_at) {
    return a.created_at < b.created_at ? 1 : -1;
  }
  const aId = String(a.id);
  const bId = String(b.id);
  if (aId === bId) return 0;
  return aId < bId ? 1 : -1;
}

function pickBest(history) {
  return history.reduce((best, play) => {
    if (play.score > best.score) return play;
    if (play.score < best.score) return best;
    if (play.created_at !== best.created_at) {
      return play.created_at < best.created_at ? play : best;
    }
    return String(play.id) < String(best.id) ? play : best;
  });
}

export function computeStats(plays) {
  if (!Array.isArray(plays) || plays.length === 0) return [];

  const groups = new Map();
  for (const play of plays) {
    const key = `${play.game_id}\u0000${play.mode}`;
    let group = groups.get(key);
    if (!group) {
      group = { gameId: play.game_id, mode: play.mode, history: [] };
      groups.set(key, group);
    }
    group.history.push(play);
  }

  return [...groups.values()]
    .map((group) => {
      const history = group.history.slice().sort(compareRecency);
      return {
        gameId: group.gameId,
        mode: group.mode,
        best: pickBest(history),
        mostRecent: history[0],
        count: history.length,
        history,
      };
    })
    .sort((a, b) => {
      if (a.gameId !== b.gameId) return a.gameId < b.gameId ? -1 : 1;
      if (a.mode === b.mode) return 0;
      return a.mode < b.mode ? -1 : 1;
    });
}
