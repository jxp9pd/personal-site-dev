// Apartment door console. Only the owner's Supabase session can use it; guests get keypad codes.
import { Profiles } from './profiles.js';
import { getSession } from './dataClient.js';
import { formatPacific as when, fromPacificInput, toPacificInput } from './door-time.js';

const $ = id => document.getElementById(id);
const stateText = { locked: 'Locked', unlocked: 'Unlocked', unknown: 'State unknown' };

class DoorError extends Error {
  constructor(message, status = 0, data = {}) { super(message); this.status = status; this.data = data; }
}

async function owner(body) {
  const session = await getSession().catch(() => null);
  if (!session?.access_token) throw new DoorError('Log in as the owner to manage the door.', 401);
  let response;
  try {
    response = await fetch('/api/door/owner', {
      method: body ? 'POST' : 'GET', cache: 'no-store', signal: AbortSignal.timeout(25000),
      headers: { Authorization: `Bearer ${session.access_token}`, ...(body && { 'Content-Type': 'application/json' }) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new DoorError(body
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

function item(title, meta, trailing = []) {
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

async function refresh() {
  try {
    render(await owner());
  } catch (error) {
    $('owner').hidden = true;
    setButtons(false);
    showLockState('unknown');
    $('login').hidden = error.status !== 401;
    feedback('lock-feedback', error.status === 401 && Profiles.isLoggedIn()
      ? 'This account cannot manage the door.' : error.message, true);
  }
}

function render(data) {
  $('owner').hidden = false;
  $('login').hidden = true;
  showLockState(data.lockState);
  setButtons(true);
  if (data.error) feedback('code-feedback', data.error, true);
  renderList('codes', 'codes-empty', data.codes, codeItem);
  renderList('events', 'events-empty', data.events, event =>
    item(event.label ? `${event.label} ${event.action}ed` : event.action === 'lock' ? 'Locked' : 'Unlocked',
      when(event.at)));
}

function codeItem(code) {
  const status = document.createElement('span');
  status.className = 'code-status door-item-meta';
  status.dataset.status = code.status;
  status.textContent = { active: 'Active', scheduled: 'Upcoming', setting: 'Setting up',
    failed: 'Not on lock', expired: 'Expired' }[code.status];
  const revoke = document.createElement('button');
  revoke.type = 'button';
  revoke.className = 'button';
  revoke.textContent = 'Revoke';
  revoke.addEventListener('click', () => revokeCode(code, revoke));
  const pin = code.pin ? `${code.pin} · ` : '';
  return item(code.label, `${pin}${when(code.startsAt)} – ${when(code.endsAt)}`, [status, revoke]);
}

async function revokeCode(code, button) {
  if (!confirm(`Revoke ${code.label}'s code?`)) return;
  button.disabled = true;
  try {
    await owner({ action: 'revoke_code', id: code.id });
    feedback('code-feedback', `Revoked ${code.label}'s code.`);
  } catch (error) {
    feedback('code-feedback', error.message, true);
  }
  await refresh();
}

async function createCode(event) {
  event.preventDefault();
  const button = $('create-code');
  button.disabled = true;
  $('new-code').hidden = true;
  feedback('code-feedback', '');
  try {
    const startsAt = fromPacificInput(`${$('code-start-date').value}T${$('code-start-time').value}`);
    const endsAt = fromPacificInput(`${$('code-end-date').value}T${$('code-end-time').value}`);
    if (!startsAt || !endsAt) throw new DoorError('Pick a start and end time that exist in Pacific time.');
    const { code } = await owner({ action: 'create_code', label: $('code-label').value,
      startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() });
    $('new-code-message').value = `Your door code is ${code.pin}. It works ${when(code.startsAt)} – ${when(code.endsAt)}.`;
    $('new-code').hidden = false;
    if (code.status === 'setting' || code.status === 'failed') {
      feedback('code-feedback', 'The lock has not confirmed this code yet. Send it once the list shows it as Active or Upcoming.', true);
    }
    $('copy-code').textContent = 'Copy';
    $('code-label').value = '';
    await refresh();
  } catch (error) {
    feedback('code-feedback', error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function command(action) {
  setButtons(false);
  $('lock-state').dataset.busy = 'true';
  feedback('lock-feedback', action === 'lock' ? 'Locking…' : 'Unlocking…');
  try {
    showLockState((await owner({ action })).lockState);
    feedback('lock-feedback', '');
  } catch (error) {
    if (error.data.lockState) showLockState(error.data.lockState);
    feedback('lock-feedback', error.message, true);
  }
  delete $('lock-state').dataset.busy;
  await refresh();
}

const now = new Date();
now.setSeconds(0, 0);
[$('code-start-date').value, $('code-start-time').value] = toPacificInput(now).split('T');
[$('code-end-date').value, $('code-end-time').value] = toPacificInput(new Date(now.getTime() + 864e5)).split('T');
$('lock').addEventListener('click', () => command('lock'));
$('unlock').addEventListener('click', () => command('unlock'));
$('code-form').addEventListener('submit', createCode);
$('copy-code').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('new-code-message').value);
    $('copy-code').textContent = 'Copied';
  } catch {
    $('new-code-message').select();
  }
});
$('login').addEventListener('click', () => Profiles.promptLogin());
Profiles.init({ headerMount: null, onAuthChange: () => refresh() })
  .catch(error => console.error('Profiles init failed', error));
