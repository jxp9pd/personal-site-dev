// Shared same-origin gateway client. API tokens and physical delivery stay on
// the server. A failed POST is never retried automatically: it may have applied.
export class BoardRequestError extends Error {
  constructor(message, { uncertain = false, retryAfter = 0 } = {}) {
    super(message);
    this.uncertain = uncertain;
    this.retryAfter = retryAfter;
  }
}

export async function requestBoard(resource, { body, timeoutMs = 8000 } = {}) {
  const writing = body !== undefined;
  let response;
  try {
    response = await fetch(`/api/vestaboard/${resource}`, {
      cache: 'no-store', signal: AbortSignal.timeout(timeoutMs),
      ...(writing ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new BoardRequestError(writing
      ? 'Connection interrupted. The action may have applied; check before trying again.'
      : 'The connection is unavailable. Try again in a moment.',
    { uncertain: writing, retryAfter: writing ? 15 : 0 });
  }
  let data;
  try {
    data = await response.json();
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid response.');
  } catch {
    throw new BoardRequestError(`Unexpected response (HTTP ${response.status}).${writing ? ' The action may have applied; check before trying again.' : ''}`,
      { uncertain: writing, retryAfter: writing ? 15 : 0 });
  }
  if (!response.ok) throw new BoardRequestError(data.error || 'The request was not accepted. Please try again later.',
    { retryAfter: data.retryAfter || 0 });
  return data;
}

export const readBoardStatus = () => requestBoard('status');

export async function sendBoardMessage(characters) {
  const data = await requestBoard('messages', { body: { characters }, timeoutMs: 20000 });
  if (data.accepted !== true) throw new BoardRequestError('The board did not confirm the message. Check before trying again.',
    { uncertain: true, retryAfter: data.retryAfter || 15 });
  return data;
}
