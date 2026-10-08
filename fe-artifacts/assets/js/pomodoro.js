import { layoutMessage, SYMBOLS } from './vestaboard-layout.js?v=1';
import { requestBoard } from './vestaboard-api.js?v=1';
import { createBoardPreview } from './vestaboard-preview.js?v=1';

const $ = id => document.getElementById(id);
const focusInput = $('focus-minutes');
const breakInput = $('break-minutes');
const preview = createBoardPreview($('board'));

let session = null;
let receivedAt = performance.now();
let connected = false;
let busy = false;
let requestVersion = 0;
let polling = false;

const active = () => session && ['running', 'paused'].includes(session.state);
const validMinutes = input => Number.isInteger(input.valueAsNumber) && input.valueAsNumber >= 1 && input.valueAsNumber <= 180;
const draftMinutes = () => validMinutes(focusInput) ? focusInput.valueAsNumber : 25;

function feedback(message, error = false) {
  $('feedback').textContent = message;
  $('feedback').dataset.error = String(error);
}

function draftCharacters() {
  const characters = layoutMessage(`ONE THING\nFOCUS ${draftMinutes()} MIN\n${'🟪'.repeat(15)}`).characters;
  characters[1][0] = characters[1][14] = 68;
  return characters;
}

function renderBoard(characters) {
  const text = characters.slice(0, 2).map(row => row.map(code => code < 63 ? SYMBOLS[code] : ' ').join('').trim()).join('. ');
  preview(characters, `Session preview: ${text}. Colored progress bar.`);
}

function renderClock() {
  const state = session?.state || 'idle';
  let remaining = state === 'idle' ? draftMinutes() * 60 : session.remainingSeconds;
  if (state === 'running') remaining -= (performance.now() - receivedAt) / 1000;
  const seconds = Math.max(0, Math.ceil(remaining));
  const time = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  $('countdown').textContent = time;
  document.title = active() ? `${time} · ${state === 'paused' ? 'Paused' : session.phase === 'focus' ? 'Focus' : 'Break'} — Pomodoro` : 'Pomodoro — Penta Projects';
  if (state === 'running' && seconds === 0) {
    const label = connected ? 'Switching…' : 'Reconnecting…';
    if ($('phase-label').textContent !== label) $('phase-label').textContent = label;
  }
}

function render() {
  const state = session?.state || 'idle';
  const phase = session?.phase || 'focus';
  $('pomodoro').dataset.phase = ['paused', 'completed', 'stopped'].includes(state) ? state : phase;
  $('phase-label').textContent = ({ idle: 'Ready', running: phase === 'focus' ? 'Focus' : 'Break',
    paused: `${phase === 'focus' ? 'Focus' : 'Break'} paused`, completed: 'Done', stopped: 'Stopped' })[state];
  $('durations').disabled = !!active() || busy;
  $('start').hidden = !!active();
  $('start').disabled = busy || !connected || !session?.configured || !validMinutes(focusInput) || !validMinutes(breakInput);
  $('active-controls').hidden = !active();
  $('pause').textContent = state === 'paused' ? 'Resume' : 'Pause';
  $('pause').disabled = $('stop').disabled = busy || !connected;
  $('reconnect').hidden = connected && session?.configured;
  renderBoard(state === 'idle' ? draftCharacters() : session.characters);
  const delivery = session?.delivery;
  $('delivery').dataset.error = String(delivery?.status === 'error');
  $('delivery').textContent = !connected ? 'Connection unavailable. Reconnecting…'
    : !session.configured ? 'Preview only · board not connected.'
    : delivery?.status === 'pending' ? 'Board update queued.'
    : delivery?.status === 'error' ? delivery.error
    : delivery?.status === 'accepted' ? 'Update accepted by Vestaboard.' : '';
  renderClock();
}

function accept(data) {
  if (!data || !['idle', 'running', 'paused', 'completed', 'stopped'].includes(data.state)
      || !Array.isArray(data.characters) || data.characters.length !== 3
      || data.characters.some(row => !Array.isArray(row) || row.length !== 15)
      || !Number.isFinite(data.remainingSeconds)) throw new Error('Invalid timer status.');
  const wasActive = active();
  session = data;
  receivedAt = performance.now();
  connected = true;
  if (active() || wasActive) {
    focusInput.value = data.focusMinutes;
    breakInput.value = data.breakMinutes;
  }
  render();
}

async function sync() {
  if (polling || busy) return;
  polling = true;
  const version = requestVersion;
  try {
    const data = await requestBoard('pomodoro');
    if (version === requestVersion) accept(data);
  } catch {
    if (version === requestVersion) {
      connected = false;
      render();
    }
  } finally {
    polling = false;
  }
}

async function command(action) {
  if (busy || !connected || (action === 'start' && $('start').disabled)) return;
  busy = true;
  requestVersion += 1; // A poll started before this command cannot overwrite its response.
  feedback('');
  render();
  const body = { action };
  if (action === 'start') Object.assign(body, { focusMinutes: focusInput.valueAsNumber, breakMinutes: breakInput.valueAsNumber });
  try {
    accept(await requestBoard('pomodoro', { body, timeoutMs: 12000 }));
  } catch (error) {
    feedback(error.uncertain
      ? 'Connection interrupted. The action may have applied; checking the session…' : error.message, true);
  } finally {
    busy = false;
    render();
    // Reconcile ambiguous responses and changes from other visitors, without
    // ever automatically repeating a start/pause/resume/stop command.
    void sync();
  }
}

$('timer-form').addEventListener('submit', event => { event.preventDefault(); void command('start'); });
$('pause').addEventListener('click', () => void command(session?.state === 'paused' ? 'resume' : 'pause'));
$('stop').addEventListener('click', () => void command('stop'));
$('reconnect').addEventListener('click', () => void sync());
[focusInput, breakInput].forEach(input => input.addEventListener('input', render));
document.addEventListener('visibilitychange', () => { if (!document.hidden) void sync(); });
window.addEventListener('online', () => void sync());
render();
void sync();
setInterval(renderClock, 250);
setInterval(() => { if (!document.hidden) void sync(); }, 5000);
