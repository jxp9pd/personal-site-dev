// Pure presentation helpers for the leaderboard modal. No I/O, no DOM — safe to
// run in the browser and under Vitest. Ranking itself is done in SQL (the
// `leaderboard` view); these helpers only shape already-ranked rows for display.
//
// A leaderboard row looks like:
//   { user_id, username, score, total, achieved_at, rank }

// "8640" -> "8,640". Leaves the grouping to the runtime's en-US locale so both
// the browser and Node format identically.
export function formatScore(n) {
  if (n == null || n === '') return '';
  const num = Number(n);
  return Number.isFinite(num) ? num.toLocaleString('en-US') : '';
}

// ISO timestamp -> "Jul 11, 2026". Formatted in UTC so a row's date is stable
// regardless of the viewer's timezone (and so tests are deterministic).
const DATE_FMT = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});
export function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : DATE_FMT.format(d);
}

// How many players sit between the last shown row and the viewer's row, for the
// "··· N players between ···" divider. Derived from the viewer's rank alone:
// with the top `shownCount` displayed, everyone from rank (shownCount+1) up to
// (viewerRank-1) is hidden. Never negative.
export function playersBetween(viewerRank, shownCount) {
  return Math.max(0, Number(viewerRank) - shownCount - 1);
}

// Decides what the compact (end-of-round) view renders: the top `limit` rows,
// plus — only when the viewer is ranked below the cut — a divider and the
// viewer's own row pinned beneath it.
//
// Returns:
//   {
//     rows,          // top rows to render (highlight any whose user_id === viewer)
//     viewerRow,     // the pinned viewer row, or null (in-top / no score)
//     showDivider,   // whether to render the "N between" divider
//     between,       // count for that divider
//     viewerInTop,   // viewer already appears within `rows`
//   }
export function buildCompactRows(top, viewer, limit) {
  const rows = (top ?? []).slice(0, limit);
  if (!viewer) {
    return { rows, viewerRow: null, showDivider: false, between: 0, viewerInTop: false };
  }
  const viewerInTop = rows.some((r) => r.user_id === viewer.user_id);
  if (viewerInTop) {
    return { rows, viewerRow: null, showDivider: false, between: 0, viewerInTop: true };
  }
  return {
    rows,
    viewerRow: viewer,
    showDivider: true,
    between: playersBetween(viewer.rank, rows.length),
    viewerInTop: false,
  };
}
