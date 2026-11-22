// Apartment door page. With `#pass=<token>` it is a guest's pass; otherwise it
// is the owner's console. The server decides who may do what: the owner by
// Supabase session, a guest by the pass secret, which stays in the URL hash so
// it never reaches server logs or Referer headers.
import { Profiles } from './profiles.js';
import { getSession } from './dataClient.js';

const $ = id => document.getElementById(id);
const guestToken = new URLSearchParams(location.hash.slice(1)).get('pass');
const stateText = { locked: 'Locked', unlocked: 'Unlocked', unknown: 'State unknown' };
const when = value => new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const pad = n => String(n).padStart(2, '0');
const localInput = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

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

async function guest(action = 'status') {
  setButtons(false);
  if (action !== 'status') feedback('lock-feedback', action === 'lock' ? 'Locking…' : 'Unlocking…');
  try {
    const data = await api('guest', { token: guestToken, action });
    renderGuest(data);
    if (action !== 'status') feedback('lock-feedback', action === 'lock' ? 'Locked.' : 'Unlocked.');
  } catch (error) {
    if (error.data.pass) renderGuest(error.data);
    else $('pass-summary').hidden = true;
    feedback('lock-feedback', error.message, true);
  }
}

function renderGuest({ pass, lockState }) {
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
  renderList('passes', 'passes-empty', data.passes, pass => {
    const status = document.createElement('span');
    status.className = 'pass-status';
    status.dataset.status = pass.status;
    status.textContent = pass.status;
    const trailing = [status];
    if (pass.status === 'active' || pass.status === 'scheduled') {
      const revoke = document.createElement('button');
      revoke.type = 'button';
      revoke.className = 'button';
      revoke.textContent = 'Revoke';
      revoke.addEventListener('click', () => revokePass(pass, revoke));
      trailing.push(revoke);
    }
    return item(pass.label, `${when(pass.startsAt)} – ${when(pass.endsAt)}`, trailing);
  });
  renderList('events', 'events-empty', data.events, event => {
    const outcome = document.createElement('span');
    outcome.className = 'event-outcome door-item-meta';
    outcome.dataset.outcome = event.outcome;
    outcome.textContent = event.outcome === 'ok' ? 'Done' : event.outcome === 'denied' ? 'Denied' : 'Failed';
    const who = event.actor === 'owner' ? 'You' : event.label || 'Guest';
    return item(`${who} ${event.action === 'lock' ? 'locked' : 'unlocked'}`, when(event.at), [outcome]);
  });
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
    const startsAt = new Date($('pass-start').value), endsAt = new Date($('pass-end').value);
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) throw new DoorError('Pick a start and end time.');
    const data = await owner({ action: 'create_pass', label: $('pass-label').value,
      startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() });
    $('new-pass-link').value = `${location.origin}${location.pathname}#pass=${data.token}`;
    $('new-pass').hidden = false;
    feedback('pass-feedback', `Created a pass for ${data.pass.label}.`);
    $('pass-label').value = '';
    await refreshOwner();
  } catch (error) {
    feedback('pass-feedback', error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function copyLink() {
  try {
    await navigator.clipboard.writeText($('new-pass-link').value);
    $('copy-link').textContent = 'Copied';
  } catch {
    $('new-pass-link').select();
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
  $('pass-start').value = localInput(now);
  $('pass-end').value = localInput(new Date(now.getTime() + 24 * 3600 * 1000));
  $('lock').addEventListener('click', () => ownerAction('lock'));
  $('unlock').addEventListener('click', () => ownerAction('unlock'));
  $('pass-form').addEventListener('submit', createPass);
  $('copy-link').addEventListener('click', copyLink);
  $('login').addEventListener('click', () => Profiles.promptLogin());
  Profiles.init({ headerMount: null, onAuthChange: () => refreshOwner() })
    .catch(error => console.error('Profiles init failed', error));
}
