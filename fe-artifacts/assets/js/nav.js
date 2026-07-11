// Same-origin navigation helpers shared by the quiz and profile pages.
//
// The profile page can be opened from any game, so its "← Home" link must send
// a visitor back to wherever they came from rather than to the site root. That
// origin travels through the URL as a `?from=` param, so it is untrusted input:
// only root-relative same-origin paths are honored. A crafted
// `?from=https://evil.example.com` (or `//evil`, `javascript:`, …) can never
// turn the link into an open redirect.

const PROFILE_PATH = '/profile.html';

// Returns `raw` only if it is a root-relative same-origin path; otherwise
// `fallback`. Rejects protocol-relative (`//host`), scheme-bearing
// (`https:`, `javascript:`, `data:`), and non-slash-leading values.
export function safeInternalPath(raw, fallback = '/') {
  if (typeof raw !== 'string' || raw === '') return fallback;
  if (raw[0] !== '/') return fallback;
  if (raw[1] === '/') return fallback;
  if (raw.includes('\\')) return fallback;
  return raw;
}

// Builds the profile URL, remembering the caller's location so Home can return
// there. Drops the `from` param when the current location isn't a safe path.
export function buildProfileHref(currentPathWithSearch) {
  const safe = safeInternalPath(currentPathWithSearch, '');
  return safe ? `${PROFILE_PATH}?from=${encodeURIComponent(safe)}` : PROFILE_PATH;
}

// Resolves the profile page's "← Home" target from its own query string.
export function resolveHomeHref(searchString, fallback = '/') {
  let from = null;
  try {
    from = new URLSearchParams(searchString || '').get('from');
  } catch {
    from = null;
  }
  return safeInternalPath(from, fallback);
}
