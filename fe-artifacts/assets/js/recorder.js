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

  // Resolves to a status object rather than throwing, so callers can reflect the
  // real outcome in the UI ("Saved" only when the row actually landed):
  //   { status: 'saved' }             — persisted successfully
  //   { status: 'failed', error }     — persist threw; the play is RETAINED
  //   { status: 'idle' }              — nothing was pending to flush
  async function flush() {
    if (pending == null) return { status: 'idle' };
    // Clear before awaiting so re-entrant auth events (the SDK may emit
    // multiple SIGNED_IN) can't observe the same pending result and double-write.
    const result = pending;
    pending = null;
    try {
      await persist(result);
      return { status: 'saved' };
    } catch (error) {
      // Don't lose a play to a transient failure: put it back so a later auth
      // event / retry can flush it again.
      pending = result;
      return { status: 'failed', error };
    }
  }

  return {
    // Returns (or resolves to) a status object:
    //   { status: 'ignored' }   — malformed result, nothing recorded
    //   { status: 'pending' }   — guest; held until authentication
    //   { status: 'saved' | 'failed', error? } — attempted an authenticated write
    capture(result) {
      if (!isValidResult(result)) return { status: 'ignored' };
      pending = result;
      if (isAuthenticated()) return flush();
      return { status: 'pending' };
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
