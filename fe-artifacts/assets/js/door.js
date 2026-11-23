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

// The button that changes the current state is the primary one.
function showLockState(state) {
  const lockState = $('lock-state');
  lockState.dataset.state = state in stateText ? state : 'unknown';
  $('lock-state-text').textContent = stateText[lockState.dataset.state];
  $('unlock').classList.toggle('button-primary', lockState.dataset.state === 'locked');
  $('lock').classList.toggle('button-primary', lockState.dataset.state === 'unlocked');
}

function setButtons(enabled) {
  $('lock').disabled = $('unlock').disabled = !enabled;
}

function item(title, meta, trailing) {
  const li = document.createElement('li');
  const text = document.createElement('div');
  text.className = 'door-item-text';
  const strong = document.createElement('div');
  strong.className = 'door-item-title';
  strong.textContent = title;
  const small = document.createElement('div');
  small.className = 'door-item-meta';
  small.textContent = meta;
  text.append(strong, small);
  const end = document.createElement('div');
  end.className = 'door-item-end';
  end.append(...trailing);
  li.append(text, end);
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
  if (action !== 'status') {
    feedback('lock-feedback', action === 'lock' ? 'Locking…' : 'Unlocking…');
    $('lock-state').dataset.busy = 'true';
  }
  try {
    const data = await api('guest', { token: guestToken, action });
    renderGuest(data);
    if (action !== 'status') feedback('lock-feedback', '');
  } catch (error) {
    if (error.data.pass) renderGuest(error.data);
    else setButtons(guestPass?.status === 'active');
    feedback('lock-feedback', error.message, true);
  }
  delete $('lock-state').dataset.busy;
}

function renderGuest({ pass, lockState }) {
  guestPass = pass;
  $('pass-summary').hidden = false;
  $('pass-summary').textContent = `${pass.label} · ${when(pass.startsAt)} – ${when(pass.endsAt)}`;
  if (lockState) showLockState(lockState);
  const active = pass.status === 'active';
  setButtons(active);
  if (!active) feedback('lock-feedback', {
    scheduled: `This link starts working ${when(pass.startsAt)}.`,
    expired: 'This link has expired.',
    revoked: 'This link was revoked.' }[pass.status] || 'This link is not active.', true);
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

const isCurrent = grant => grant.status === 'active' || grant.status === 'scheduled'
  || (grant.status === 'revoked' && grant.removedFromLock === false);

function renderOwner(data) {
  $('owner').hidden = false;
  $('login').hidden = true;
  showLockState(data.lockState);
  setButtons(true);
  if (data.storeError) feedback('grant-feedback', data.storeError, true);
  const grants = [
    ...(data.codes || []).map(code => ({ ...code, kind: 'code' })),
    ...(data.passes || []).map(pass => ({ ...pass, kind: 'link' })),
  ].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  renderList('grants', 'grants-empty', grants.filter(isCurrent), grantItem);
  const past = grants.filter(grant => !isCurrent(grant)).reverse();
  $('past').hidden = !past.length;
  $('past').querySelector('summary').textContent = `Past (${past.length})`;
  $('past-grants').replaceChildren(...past.map(grantItem));
  renderList('events', 'events-empty', data.events, event => {
    const who = event.actor === 'owner' ? 'You' : event.label || 'Guest';
    const trailing = [];
    if (event.outcome !== 'ok') {
      const outcome = document.createElement('span');
      outcome.className = 'door-item-meta';
      outcome.dataset.outcome = event.outcome;
      outcome.textContent = event.outcome === 'denied' ? 'Denied' : 'Failed';
      trailing.push(outcome);
    }
    return item(`${who} ${event.action === 'lock' ? 'locked' : 'unlocked'}`, when(event.at), trailing);
  });
}

// A keypad code or link: name, window, type, status, and Revoke while it can still be used.
function grantItem(grant) {
  const tag = document.createElement('span');
  tag.className = 'grant-tag';
  tag.textContent = grant.kind === 'code' ? 'Code' : 'Link';
  const status = document.createElement('span');
  status.className = 'grant-status door-item-meta';
  status.dataset.status = grant.status;
  status.textContent = { active: 'Active', scheduled: 'Upcoming', expired: 'Expired', revoked: 'Revoked' }[grant.status];
  const trailing = [tag, status];
  if (isCurrent(grant)) {
    const revoke = document.createElement('button');
    revoke.type = 'button';
    revoke.className = 'button';
    revoke.textContent = grant.status === 'revoked' ? 'Retry removal' : 'Revoke';
    revoke.addEventListener('click', () => revokeGrant(grant, revoke));
    trailing.push(revoke);
  }
  return item(grant.label, `${when(grant.startsAt)} – ${when(grant.endsAt)}`, trailing);
}

async function revokeGrant(grant, button) {
  const noun = grant.kind === 'code' ? 'keypad code' : 'link';
  if (grant.status !== 'revoked' && !confirm(`Revoke ${grant.label}'s ${noun}?`)) return;
  button.disabled = true;
  try {
    const data = await owner({ action: grant.kind === 'code' ? 'revoke_code' : 'revoke_pass', id: grant.id });
    feedback('grant-feedback', data.warning || `Revoked ${grant.label}'s ${noun}.`, Boolean(data.warning));
  } catch (error) {
    feedback('grant-feedback', error.message, true);
  }
  await refreshOwner();
}

let grantKind = 'code';

function chooseKind(kind) {
  grantKind = kind;
  for (const button of document.querySelectorAll('.grant-kind button')) {
    button.setAttribute('aria-pressed', String(button.dataset.kind === kind));
  }
}

async function createGrant(event) {
  event.preventDefault();
  const button = $('create-grant');
  button.disabled = true;
  $('new-grant').hidden = true;
  feedback('grant-feedback', '');
  try {
    const startsAt = fromPacificInput(`${$('grant-start-date').value}T${$('grant-start-time').value}`);
    const endsAt = fromPacificInput(`${$('grant-end-date').value}T${$('grant-end-time').value}`);
    if (!startsAt || !endsAt) throw new DoorError('Pick a start and end time that exist in Pacific time.');
    const body = { label: $('grant-label').value, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() };
    let message;
    if (grantKind === 'code') {
      const data = await owner({ action: 'create_code', ...body });
      message = `Your door code is ${data.pin}. It works ${when(data.code.startsAt)} – ${when(data.code.endsAt)}.`;
    } else {
      const data = await owner({ action: 'create_pass', ...body });
      message = `Door link, works ${when(data.pass.startsAt)} – ${when(data.pass.endsAt)}: `
        + `${location.origin}${location.pathname}#pass=${data.token}`;
    }
    $('new-grant-message').value = message;
    $('new-grant').hidden = false;
    $('copy-grant').textContent = 'Copy';
    $('grant-label').value = '';
    await refreshOwner();
  } catch (error) {
    feedback('grant-feedback', error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function ownerAction(action) {
  setButtons(false);
  $('lock-state').dataset.busy = 'true';
  feedback('lock-feedback', action === 'lock' ? 'Locking…' : 'Unlocking…');
  try {
    const data = await owner({ action });
    showLockState(data.lockState);
    feedback('lock-feedback', '');
  } catch (error) {
    if (error.data.lockState) showLockState(error.data.lockState);
    feedback('lock-feedback', error.message, true);
  }
  delete $('lock-state').dataset.busy;
  await refreshOwner();
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
  document.title = 'Door — Penta Projects';
  document.querySelector('.back-link').hidden = true;
  $('lock').addEventListener('click', () => guest('lock'));
  $('unlock').addEventListener('click', () => guest('unlock'));
  guest();
} else {
  const now = new Date();
  now.setSeconds(0, 0);
  const tomorrow = new Date(now.getTime() + 24 * 3600 * 1000);
  [$('grant-start-date').value, $('grant-start-time').value] = toPacificInput(now).split('T');
  [$('grant-end-date').value, $('grant-end-time').value] = toPacificInput(tomorrow).split('T');
  $('lock').addEventListener('click', () => ownerAction('lock'));
  $('unlock').addEventListener('click', () => ownerAction('unlock'));
  $('grant-form').addEventListener('submit', createGrant);
  for (const button of document.querySelectorAll('.grant-kind button')) {
    button.addEventListener('click', () => chooseKind(button.dataset.kind));
  }
  $('copy-grant').addEventListener('click', () => copyField('new-grant-message', $('copy-grant')));
  $('login').addEventListener('click', () => Profiles.promptLogin());
  Profiles.init({ headerMount: null, onAuthChange: () => refreshOwner() })
    .catch(error => console.error('Profiles init failed', error));
}
