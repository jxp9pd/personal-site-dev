// Capture-then-save state machine for completed game results.
//
// Decoupled from Supabase and the DOM: the caller injects `persist` (writes one
// result to the backend) and `isAuthenticated` (whether a session exists).
// Guests' completions are held pending and flushed exactly once if/when they
// authenticate; already-authed completions persist immediately.

function isValidResult(result) {
  return (
    result != null &&
    typeof result === 'object' &&
    typeof result.gameId === 'string' &&
    typeof result.mode === 'string' &&
    typeof result.score === 'number' &&
    typeof result.total === 'number'
  );
}

export function createRecorder({ persist, isAuthenticated }) {
  let pending = null;

  async function flush() {
    if (pending == null) return;
    // Clear before awaiting so re-entrant auth events (the SDK may emit
    // multiple SIGNED_IN) can't observe the same pending result and double-write.
    const result = pending;
    pending = null;
    await persist(result);
  }

  return {
    capture(result) {
      if (!isValidResult(result)) return;
      if (isAuthenticated()) {
        pending = result;
        return flush();
      }
      pending = result;
    },

    onAuthenticated() {
      return flush();
    },

    authChanged(isAuthed) {
      if (isAuthed) return flush();
    },

    hasPending() {
      return pending != null;
    },
  };
}
