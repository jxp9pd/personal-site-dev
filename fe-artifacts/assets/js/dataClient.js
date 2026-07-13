// The single seam between the app and Supabase. Nothing else in the codebase
// touches the SDK directly — callers speak in intent-named methods and stay
// ignorant of table names, column mappings, and auth plumbing.
//
// Build-free import: the SDK is pulled from esm.sh, which serves the package as
// a browser-native ES module. This keeps `<script type="module">` working with
// no bundler/build step, matching the rest of the site.
//
// Error convention: every async method THROWS an Error on failure and returns
// the useful payload directly on success (no `{ data, error }` envelope leaks
// out to callers). Callers use try/catch. The one exception is `getSession`,
// which returns `null` for the ordinary "not signed in" case and only throws on
// a genuine SDK error.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const PLAY_COLUMNS = 'id, user_id, game_id, mode, score, total, created_at';

const PROFILE_COLUMNS = 'user_id, username, bio, created_at, avatar_url';

// Selector only needs display + framing metadata (plus the lightweight landmark
// SVG it renders behind each card); the heavy `geo` column is fetched per-quiz
// on demand so listing all cities stays cheap.
const QUIZ_LIST_COLUMNS = 'slug, name, description, center_lat, center_lng, zoom, art_svg';

// Pack selector needs only display metadata; items are fetched per-pack on play.
const PACK_LIST_COLUMNS = 'slug, name, description, art_svg';

// One client instance for the whole app.
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Normalizes a `quizzes` row into the shape the quiz page speaks (center as a
// [lat, lng] pair), hiding the split lat/lng columns from callers.
function toQuiz(row) {
  return {
    slug: row.slug,
    name: row.name,
    description: row.description,
    center: [row.center_lat, row.center_lng],
    zoom: row.zoom,
    geo: row.geo,
    artSvg: row.art_svg ?? null,
  };
}

// Passing `username` through options.data lands it in raw_user_meta_data, which
// the DB trigger reads to create the profile row during signup.
export async function signUp({ email, password, username }) {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { username } },
  });
  if (error) throw error;
  return data;
}

// Resolves a username to its account email via the SECURITY DEFINER RPC (see
// migration 0005). Returns null when no username matches. Throws only on a
// genuine SDK error.
export async function emailForUsername(username) {
  const { data, error } = await supabase.rpc('email_for_username', { p_username: username });
  if (error) throw error;
  return data ?? null;
}

// Supabase's password grant only accepts an email, so we resolve the username
// first. An unknown username throws the same "Invalid login credentials" shape
// GoTrue uses for a bad password, so callers map both to one message and never
// reveal whether a username exists.
export async function signIn({ username, password }) {
  const email = await emailForUsername(username);
  if (!email) throw new Error('Invalid login credentials');
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export async function getSession() {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return data.session;
}

// Ownership is derived from the live session, never from a caller argument: a
// forged user_id would be rejected by RLS anyway, so we don't expose the knob.
export async function recordPlay({ gameId, mode, score, total }) {
  const session = await getSession();
  if (!session) throw new Error('recordPlay requires an authenticated session');

  const { data, error } = await supabase
    .from('plays')
    .insert({
      user_id: session.user.id,
      game_id: gameId,
      mode,
      score,
      total,
    })
    .select(PLAY_COLUMNS)
    .single();
  if (error) throw error;
  return data;
}

// Returns rows shaped for the `stats` module ({ id, user_id, game_id, mode,
// score, total, created_at }), oldest-first. `userId` defaults to the current
// session's user.
export async function fetchPlays(userId) {
  let targetUserId = userId;
  if (!targetUserId) {
    const session = await getSession();
    if (!session) throw new Error('fetchPlays requires a userId or an authenticated session');
    targetUserId = session.user.id;
  }

  const { data, error } = await supabase
    .from('plays')
    .select(PLAY_COLUMNS)
    .eq('user_id', targetUserId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data;
}

// Columns the leaderboard view exposes for rendering. game_id/mode are used
// only as filters, so they don't need to be selected.
const LEADERBOARD_COLUMNS = 'user_id, username, score, total, achieved_at, rank';

// Top `limit` entries for one board (game_id + mode), already ranked in SQL.
// Ties share a rank (competition ranking); within a tie the earliest achiever
// is listed first, then username for a stable order. Returns [] when the board
// has no scores yet.
export async function fetchLeaderboard(gameId, mode, limit = 100) {
  const { data, error } = await supabase
    .from('leaderboard')
    .select(LEADERBOARD_COLUMNS)
    .eq('game_id', gameId)
    .eq('mode', mode)
    .order('rank', { ascending: true })
    .order('achieved_at', { ascending: true })
    .order('username', { ascending: true })
    .limit(limit);
  if (error) throw error;
  return data ?? [];
}

// One player's standing on a board (their best row + global rank), or null when
// they have no score for it yet. `userId` is required — the leaderboard never
// infers "me" so a caller can look up any player.
export async function fetchViewerRank(gameId, mode, userId) {
  if (!userId) return null;
  const { data, error } = await supabase
    .from('leaderboard')
    .select(LEADERBOARD_COLUMNS)
    .eq('game_id', gameId)
    .eq('mode', mode)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

// ILIKE treats `_` and `%` as wildcards, but usernames legitimately contain
// underscores, so escape them to force a literal (case-insensitive) match.
function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

// Case-insensitive username lookup (profiles is unique on lower(username)).
// Returns the profile row, or null when no username matches. Throws only on a
// genuine SDK error.
export async function fetchProfileByUsername(username) {
  const { data, error } = await supabase
    .from('profiles')
    .select(PROFILE_COLUMNS)
    .ilike('username', escapeLike(username))
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

// Updates the caller's own profile row. Ownership is derived from the live
// session, never a caller argument (RLS enforces owner-only writes regardless).
// Returns the updated row.
export async function updateProfile({ bio }) {
  const session = await getSession();
  if (!session) throw new Error('updateProfile requires an authenticated session');

  const { data, error } = await supabase
    .from('profiles')
    .update({ bio })
    .eq('user_id', session.user.id)
    .select(PROFILE_COLUMNS)
    .single();
  if (error) throw error;
  return data;
}

// Lists every quiz for the selector, ordered as configured at publish time.
// Omits `geo` — see QUIZ_LIST_COLUMNS. Returns [] when no quizzes exist.
export async function fetchQuizList() {
  const { data, error } = await supabase
    .from('quizzes')
    .select(QUIZ_LIST_COLUMNS)
    .order('sort_order', { ascending: true })
    .order('name', { ascending: true });
  if (error) throw error;
  return (data ?? []).map(toQuiz);
}

// Loads a single quiz (including its `geo` FeatureCollection) by slug. Returns
// null when the slug is unknown, so callers can fall back to the selector.
export async function fetchQuiz(slug) {
  const { data, error } = await supabase
    .from('quizzes')
    .select(`${QUIZ_LIST_COLUMNS}, geo`)
    .eq('slug', slug)
    .maybeSingle();
  if (error) throw error;
  return data ? toQuiz(data) : null;
}

// Normalizes a `packs` row into the display shape the selector speaks.
function toPack(row) {
  return {
    slug: row.slug,
    name: row.name,
    description: row.description,
    artSvg: row.art_svg ?? null,
  };
}

// Lists every pack for the Guess the Price selector, ordered as configured at
// publish time, then by name as a stable tiebreaker. Omits items — see
// PACK_LIST_COLUMNS. Returns [] when no packs exist.
export async function fetchPackList() {
  const { data, error } = await supabase
    .from('packs')
    .select(PACK_LIST_COLUMNS)
    .order('sort_order', { ascending: true })
    .order('name', { ascending: true });
  if (error) throw error;
  return (data ?? []).map(toPack);
}

// Loads a single pack plus its items (ordered by sort_order) by slug. Prices are
// coerced to numbers (PostgREST can serialize numeric as a string). Returns null
// when the slug is unknown, so callers can fall back to the selector.
export async function fetchPack(slug) {
  const { data, error } = await supabase
    .from('packs')
    .select(`${PACK_LIST_COLUMNS}, pack_items(name, price, image_url, sort_order)`)
    .eq('slug', slug)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const items = (data.pack_items ?? [])
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((it) => ({ name: it.name, price: Number(it.price), imageUrl: it.image_url ?? null }));
  return { ...toPack(data), items };
}

// Wraps the SDK subscription so the recorder/UI layer can drive capture-then-save
// off auth transitions. Returns the SDK's subscription handle (has .unsubscribe()).
export function onAuthStateChange(cb) {
  const { data } = supabase.auth.onAuthStateChange(cb);
  return data.subscription;
}
