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

export async function signIn({ email, password }) {
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

// Wraps the SDK subscription so the recorder/UI layer can drive capture-then-save
// off auth transitions. Returns the SDK's subscription handle (has .unsubscribe()).
export function onAuthStateChange(cb) {
  const { data } = supabase.auth.onAuthStateChange(cb);
  return data.subscription;
}
