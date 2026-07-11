// Facade that wires the auth UI, the Supabase data client, and the capture-then-
// save recorder into one module. Each game imports only this file.
//
// It owns the single source of truth for the current session and keeps the
// header button, the auto-prompt, and the recorder in sync with auth events.

import * as dataClient from './dataClient.js';
import { isKnownSlug } from './manifest.js';
import { createRecorder } from './recorder.js';
import { createAuthUI } from './ui.js';

let currentSession = null;
let authUI = null;
let initialized = false;

const recorder = createRecorder({
  persist: (result) => dataClient.recordPlay(result),
  isAuthenticated: () => currentSession != null,
});

function usernameOf(session) {
  return session?.user?.user_metadata?.username || session?.user?.email || 'Profile';
}

const TAKEN_USERNAME_MSG = 'That username is already taken. Please choose another.';

// A raw SDK/backend message that carries no useful text for the user. The
// GoTrue SDK collapses the underlying Postgres error into the literal "{}".
function isOpaqueMessage(raw) {
  return !raw || raw === '{}' || raw === '[object Object]';
}

// Maps a failed signup to human-readable copy. The signup trigger only inserts
// (user_id, username) into profiles; a brand-new auth id can't collide, so the
// sole unique-index it can violate is profiles_username_lower_key. That failure
// surfaces here as a 500 / AuthRetryableFetchError with an opaque "{}" message,
// so we treat that shape as "username taken" rather than leaking the noise.
function signupError(err) {
  const raw = typeof err?.message === 'string' ? err.message : '';
  if (
    raw.includes('profiles_username_lower_key') ||
    raw.includes('duplicate key') ||
    err?.code === '23505' ||
    err?.status === 500 ||
    err?.name === 'AuthRetryableFetchError'
  ) {
    return TAKEN_USERNAME_MSG;
  }
  if (raw.includes('User already registered')) {
    return 'An account with that email already exists. Try logging in.';
  }
  return isOpaqueMessage(raw) ? 'Something went wrong. Please try again.' : raw;
}

// Maps a failed login to human-readable copy.
function loginError(err) {
  const raw = typeof err?.message === 'string' ? err.message : '';
  if (raw.includes('Invalid login credentials')) {
    return 'Incorrect email or password.';
  }
  return isOpaqueMessage(raw) ? 'Something went wrong. Please try again.' : raw;
}

function applyAuthState() {
  authUI?.setAuthState({
    loggedIn: currentSession != null,
    username: usernameOf(currentSession),
  });
}

async function init({ gameSlug, headerMount } = {}) {
  if (initialized) return;
  initialized = true;

  try {
    currentSession = await dataClient.getSession();
  } catch {
    currentSession = null;
  }

  authUI = createAuthUI({
    mountButtonInto: headerMount,
    onLogin: async ({ email, password }) => {
      try {
        return await dataClient.signIn({ email, password });
      } catch (err) {
        throw new Error(loginError(err));
      }
    },
    onSignup: async ({ email, password, username }) => {
      try {
        return await dataClient.signUp({ email, password, username });
      } catch (err) {
        throw new Error(signupError(err));
      }
    },
    onLogout: () => dataClient.signOut(),
    onOpenProfile: () => {
      window.location.href = '/profile.html';
    },
  });

  applyAuthState();

  // Keep the header + recorder in sync with every auth transition. The SDK also
  // emits an initial event on subscribe, which harmlessly re-confirms state.
  dataClient.onAuthStateChange((_event, session) => {
    currentSession = session ?? null;
    applyAuthState();
    recorder.authChanged(currentSession != null);
  });

  if (currentSession == null) authUI.maybeAutoPrompt();
}

// Routes a completed game through the recorder: a guest's result is captured and
// flushed on later login; a logged-in user's persists immediately. Unknown
// slugs are refused so untracked pages can't write junk plays.
function recordPlay({ gameId, mode, score, total }) {
  if (!isKnownSlug(gameId)) return;
  return recorder.capture({ gameId, mode, score, total });
}

function isLoggedIn() {
  return currentSession != null;
}

function promptLogin() {
  authUI?.openModal();
}

export const Profiles = { init, recordPlay, isLoggedIn, promptLogin };
