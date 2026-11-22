// Apartment door page. With `#pass=<token>` it is a guest's pass; otherwise it
// is the owner's console. The server decides who may do what: the owner by
// Supabase session, a guest by the pass secret, which stays in the URL hash so
// it never reaches server logs or Referer headers.
import { Profiles } from './profiles.js';
import { getSession } from './dataClient.js';
import { formatPacific, fromPacificInput, toPacificInput } from './door-time.js';

const $ = id => document.getElementById(id);
const guestToken = new URLSearchParams(location.hash.slice(1)).get('pass');
const stateText = { locked: 'Locked', unlocked: 'Unlocked', unknown: 'State unknown' };
const when = formatPacific;

class DoorError extends Error {
  constructor(message, status = 0, data = {}) { super(message); this.status = status; this.data = data; }
}

async function api(path, body, accessToken) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  let response;
  try {
    response = await fetch(`/api/door/${path}`, {
      method: body ? 'POST' : 'GET', headers, cache: 'no-store',
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(25000),
    });
  } catch {
    throw new DoorError(body && body.action !== 'status'
      ? 'Connection interrupted. Check the lock state before trying again.'
      : 'The door service is unavailable. Try again in a moment.');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new DoorError(data.error || `Request failed (HTTP ${response.status}).`, response.status, data);
  return data;
}

function feedback(id, message, error = false) {
  $(id).textContent = message;
  $(id).dataset.error = String(error);
}

function showLockState(state) {
  const lockState = $('lock-state');
  lockState.dataset.state = state in stateText ? state : 'unknown';
  lockState.textContent = stateText[lockState.dataset.state];
}

function setButtons(enabled) {
  $('lock').disabled = $('unlock').disabled = !enabled;
}

function item(title, meta, trailing) {
  const li = document.createElement('li');
  const text = document.createElement('div');
  const strong = document.createElement('div');
  strong.className = 'door-item-title';
  strong.textContent = title;
  const small = document.createElement('div');
  small.className = 'door-item-meta';
  small.textContent = meta;
  text.append(strong, small);
  li.append(text, ...trailing);
  return li;
}

function renderList(listId, emptyId, rows, render) {
  $(listId).replaceChildren(...(rows || []).map(render));
  $(emptyId).hidden = Boolean(rows?.length);
}

// Guest -----------------------------------------------------------------------

let guestPass = null;

async function guest(action = 'status') {
  setButtons(false);
  if (action !== 'status') feedback('lock-feedback', action === 'lock' ? 'Locking…' : 'Unlocking…');
  try {
    const data = await api('guest', { token: guestToken, action });
    renderGuest(data);
    if (action !== 'status') feedback('lock-feedback', action === 'lock' ? 'Locked.' : 'Unlocked.');
  } catch (error) {
    if (error.data.pass) renderGuest(error.data);
    else setButtons(guestPass?.status === 'active');
    feedback('lock-feedback', error.message, true);
  }
}

function renderGuest({ pass, lockState }) {
  guestPass = pass;
  $('pass-summary').hidden = false;
  $('pass-summary').textContent = `Pass for ${pass.label} · ${when(pass.startsAt)} – ${when(pass.endsAt)}`;
  if (lockState) showLockState(lockState);
  const active = pass.status === 'active';
  setButtons(active);
  if (!active) feedback('lock-feedback', {
    scheduled: `This pass starts ${when(pass.startsAt)}.`,
    expired: 'This pass has expired.',
    revoked: 'This pass was revoked.' }[pass.status] || 'This pass is not active.', true);
}

// Owner -----------------------------------------------------------------------

async function ownerToken() {
  const session = await getSession().catch(() => null);
  return session?.access_token || null;
}

async function owner(body) {
  const token = await ownerToken();
  if (!token) throw new DoorError('Log in as the owner to manage the door.', 401);
  return api('owner', body, token);
}

async function refreshOwner() {
  try {
    renderOwner(await owner());
  } catch (error) {
    $('owner').hidden = true;
    setButtons(false);
    showLockState('unknown');
    $('login').hidden = error.status !== 401;
    feedback('lock-feedback', error.status === 401 && Profiles.isLoggedIn()
      ? 'This account cannot manage the door.' : error.message, true);
  }
}

function renderOwner(data) {
  $('owner').hidden = false;
  $('login').hidden = true;
  showLockState(data.lockState);
  setButtons(true);
  if (data.driver === 'mock') feedback('lock-feedback', 'Using the test lock: no real door is connected.');
  if (data.storeError) feedback('pass-feedback', data.storeError, true);
  renderList('passes', 'passes-empty', data.passes, pass => grantItem(pass, button => revokePass(pass, button)));
  renderList('codes', 'codes-empty', data.codes, code => grantItem(code, () => revokeCode(code)));
  renderList('events', 'events-empty', data.events, event => {
    const outcome = document.createElement('span');
    outcome.className = 'event-outcome door-item-meta';
    outcome.dataset.outcome = event.outcome;
    outcome.textContent = event.outcome === 'ok' ? 'Done' : event.outcome === 'denied' ? 'Denied' : 'Failed';
    const who = event.actor === 'owner' ? 'You' : event.label || 'Guest';
    return item(`${who} ${event.action === 'lock' ? 'locked' : 'unlocked'}`, when(event.at), [outcome]);
  });
}

// A guest link or keypad code: label, window, status and a Revoke button while it can still be used.
function grantItem(grant, onRevoke) {
  const status = document.createElement('span');
  status.className = 'pass-status';
  status.dataset.status = grant.status;
  status.textContent = grant.status;
  const trailing = [status];
  const retry = grant.status === 'revoked' && grant.removedFromLock === false;
  if (grant.status === 'active' || grant.status === 'scheduled' || retry) {
    const revoke = document.createElement('button');
    revoke.type = 'button';
    revoke.className = 'button';
    revoke.textContent = retry ? 'Retry removal' : 'Revoke';
    revoke.addEventListener('click', () => onRevoke(revoke));
    trailing.push(revoke);
  }
  return item(grant.label, `${when(grant.startsAt)} – ${when(grant.endsAt)}`, trailing);
}

function readWindow(startId, endId) {
  const startsAt = fromPacificInput($(startId).value), endsAt = fromPacificInput($(endId).value);
  if (!startsAt || !endsAt) throw new DoorError('Pick a start and end time.');
  return { startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() };
}

async function createCode(event) {
  event.preventDefault();
  const button = $('create-code');
  button.disabled = true;
  $('new-code').hidden = true;
  try {
    const data = await owner({ action: 'create_code', label: $('code-label').value, ...readWindow('code-start', 'code-end') });
    $('new-code-message').value = `Your door code is ${data.pin}. It works ${when(data.code.startsAt)} – ${when(data.code.endsAt)}.`;
    $('new-code').hidden = false;
    $('copy-code').textContent = 'Copy';
    feedback('code-feedback', `Created a code for ${data.code.label}.`);
    $('code-label').value = '';
    await refreshOwner();
  } catch (error) {
    feedback('code-feedback', error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function revokeCode(code) {
  if (code.status !== 'revoked' && !confirm(`Revoke the keypad code for ${code.label}?`)) return;
  try {
    const data = await owner({ action: 'revoke_code', id: code.id });
    feedback('code-feedback', data.warning || `Revoked the code for ${code.label}.`, Boolean(data.warning));
  } catch (error) {
    feedback('code-feedback', error.message, true);
  }
  await refreshOwner();
}

async function ownerAction(action) {
  setButtons(false);
  feedback('lock-feedback', action === 'lock' ? 'Locking…' : 'Unlocking…');
  try {
    const data = await owner({ action });
    showLockState(data.lockState);
    feedback('lock-feedback', action === 'lock' ? 'Locked.' : 'Unlocked.');
  } catch (error) {
    if (error.data.lockState) showLockState(error.data.lockState);
    feedback('lock-feedback', error.message, true);
  }
  await refreshOwner();
}

async function revokePass(pass, button) {
  if (!confirm(`Revoke the pass for ${pass.label}? The link stops working immediately.`)) return;
  button.disabled = true;
  try {
    await owner({ action: 'revoke_pass', id: pass.id });
    feedback('pass-feedback', `Revoked the pass for ${pass.label}.`);
  } catch (error) {
    feedback('pass-feedback', error.message, true);
  }
  await refreshOwner();
}

async function createPass(event) {
  event.preventDefault();
  const button = $('create-pass');
  button.disabled = true;
  $('new-pass').hidden = true;
  try {
    const data = await owner({ action: 'create_pass', label: $('pass-label').value, ...readWindow('pass-start', 'pass-end') });
    $('new-pass-link').value = `${location.origin}${location.pathname}#pass=${data.token}`;
    $('new-pass').hidden = false;
    $('copy-link').textContent = 'Copy';
    feedback('pass-feedback', `Created a pass for ${data.pass.label}.`);
    $('pass-label').value = '';
    await refreshOwner();
  } catch (error) {
    feedback('pass-feedback', error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function copyField(fieldId, button) {
  try {
    await navigator.clipboard.writeText($(fieldId).value);
    button.textContent = 'Copied';
  } catch {
    $(fieldId).select();
  }
}

// -----------------------------------------------------------------------------

if (guestToken) {
  document.title = 'Guest pass — Penta Projects';
  $('lock').addEventListener('click', () => guest('lock'));
  $('unlock').addEventListener('click', () => guest('unlock'));
  guest();
} else {
  const now = new Date();
  now.setSeconds(0, 0);
  const tomorrow = new Date(now.getTime() + 24 * 3600 * 1000);
  $('pass-start').value = $('code-start').value = toPacificInput(now);
  $('pass-end').value = $('code-end').value = toPacificInput(tomorrow);
  $('lock').addEventListener('click', () => ownerAction('lock'));
  $('unlock').addEventListener('click', () => ownerAction('unlock'));
  $('pass-form').addEventListener('submit', createPass);
  $('code-form').addEventListener('submit', createCode);
  $('copy-link').addEventListener('click', () => copyField('new-pass-link', $('copy-link')));
  $('copy-code').addEventListener('click', () => copyField('new-code-message', $('copy-code')));
  $('login').addEventListener('click', () => Profiles.promptLogin());
  Profiles.init({ headerMount: null, onAuthChange: () => refreshOwner() })
    .catch(error => console.error('Profiles init failed', error));
}
