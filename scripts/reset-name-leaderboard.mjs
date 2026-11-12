// One-off leaderboard reset for the Name-it cutover.
//
// The "Name it" mode changed from multiple-choice recognition to a timed
// type-to-recall game, so its old scores are no longer comparable. This deletes
// every `plays` row with mode='name' for the five neighborhood games, giving the
// reset board an empty start. `find` scores and all other games are left alone.
//
// Destructive and irreversible — run once, at cutover. Requires the SERVICE-ROLE
// key (bypasses RLS) via scripts/lib/supabase-admin.mjs.
//
// Usage:
//   SUPABASE_SERVICE_ROLE_KEY=... node scripts/reset-name-leaderboard.mjs --confirm

import { createSupabaseAdminOrExit } from './lib/supabase-admin.mjs';

const GAME_IDS = [
  'sf-neighborhoods',
  'seattle-neighborhoods',
  'dc-neighborhoods',
  'fairfax-neighborhoods',
  'manhattan-neighborhoods',
];

const supabase = createSupabaseAdminOrExit({
  command: 'node scripts/reset-name-leaderboard.mjs --confirm',
});

// mode='name' AND game_id in the five neighborhood games. The filter is
// mandatory: a filterless DELETE would wipe the whole table.
const filter = `mode=eq.name&game_id=in.(${GAME_IDS.join(',')})`;
const path = `plays?${filter}`;

async function count() {
  const res = await supabase.rest(`${path}&select=id`, { method: 'HEAD', headers: { Prefer: 'count=exact' } });
  return Number((res.headers.get('content-range') || '/0').split('/')[1]);
}

async function main() {
  const before = await count();
  console.log(`Neighborhood mode='name' rows before: ${before}`);

  if (!process.argv.includes('--confirm')) {
    console.log('\nDry run. This would DELETE the rows above (destructive, irreversible).');
    console.log('Re-run with --confirm to execute.');
    return;
  }

  const res = await supabase.rest(path, { method: 'DELETE', headers: { Prefer: 'return=representation' } });
  if (!res.ok) {
    throw new Error(`Delete failed (${res.status} ${res.statusText}): ${await supabase.summarizeError(res)}`);
  }
  const deleted = await res.json();
  const after = await count();
  console.log(`Deleted ${deleted.length} row(s). Neighborhood mode='name' rows after: ${after}`);
  if (after !== 0) throw new Error(`Expected 0 remaining, found ${after}`);
  console.log('Reset complete.');
}

main().catch((err) => {
  console.error('\nReset failed:', err.message);
  process.exit(1);
});
