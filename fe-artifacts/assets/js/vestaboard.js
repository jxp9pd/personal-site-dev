import { layoutMessage, SYMBOLS } from './vestaboard-layout.js?v=1';

const $ = id => document.getElementById(id);
const form = $('message-form');
const input = $('message');
const board = $('board');
let configured = false;
let sending = false;
let cooldownUntil = 0;
let layout;

const tiles = Array.from({ length: 45 }, () => {
  const tile = document.createElement('span');
  tile.className = 'tile';
  tile.setAttribute('aria-hidden', 'true');
  board.append(tile);
  return tile;
});

function updateButton() {
  const seconds = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
  $('send').disabled = sending || !configured || !!layout.error || seconds > 0;
  $('send-label').textContent = sending ? 'Sending…' : seconds > 0 ? `Next note in ${seconds}s` : 'Send to the board';
}

function render() {
  layout = layoutMessage(input.value);
  layout.characters.flat().forEach((code, index) => {
    const tile = tiles[index];
    if (tile.dataset.code === String(code)) return;
    tile.dataset.code = code;
    tile.textContent = code >= 63 ? '' : SYMBOLS[code];
    tile.classList.remove('changed');
    void tile.offsetWidth;
    tile.classList.add('changed');
  });
  board.setAttribute('aria-label', layout.error ? 'Empty preview. ' + layout.error : 'Preview: ' + input.value);
  input.setAttribute('aria-invalid', String(!!layout.error && !!input.value.trim()));
  $('validation').textContent = input.value.trim() ? layout.error || '' : '';
  updateButton();
}

function feedback(message, error = false) {
  $('feedback').textContent = message;
  $('feedback').dataset.error = String(error);
}

async function checkConnection() {
  $('reconnect').hidden = true;
  try {
    const response = await fetch('/api/vestaboard/status', { cache: 'no-store', signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error('unavailable');
    const data = await response.json();
    configured = data.configured === true;
    cooldownUntil = Math.max(cooldownUntil, Date.now() + (data.retryAfter || 0) * 1000);
    feedback(configured ? '' : 'The board is not connected yet.');
  } catch {
    configured = false;
    feedback('The connection is unavailable. Try again in a moment.');
  }
  $('reconnect').hidden = configured;
  updateButton();
}

input.addEventListener('input', render);
$('clear').addEventListener('click', () => { input.value = ''; render(); input.focus(); });
document.querySelectorAll('[data-symbol]').forEach(button => {
  button.addEventListener('click', () => {
    input.setRangeText(button.dataset.symbol, input.selectionStart, input.selectionEnd, 'end');
    render(); input.focus();
  });
});
$('reconnect').addEventListener('click', checkConnection);
form.addEventListener('submit', async event => {
  event.preventDefault();
  if ($('send').disabled) return;
  sending = true;
  updateButton();
  feedback('Sending your note…');
  try {
    const response = await fetch('/api/vestaboard/messages', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ characters: layout.characters }),
      signal: AbortSignal.timeout(20000),
    });
    let data;
    try {
      data = await response.json();
    } catch {
      // A proxy may replace an upstream error with an HTML error page.
      // The physical board may already have received the note; don't imply a failed send.
      cooldownUntil = Date.now() + 15000;
      throw new Error(`The request returned an unexpected response (HTTP ${response.status}). Your note may have been sent; check the board before retrying.`);
    }
    if (data.retryAfter) cooldownUntil = Date.now() + data.retryAfter * 1000;
    if (!response.ok) throw new Error(data.error || 'Your note could not be sent. Please try again.');
    if (data.accepted !== true) throw new Error('The board did not confirm your note. Please check before retrying.');
    feedback('Accepted by Vestaboard. Your note is on its way.');
  } catch (error) {
    const message = error.name === 'TimeoutError' || error instanceof TypeError || error instanceof SyntaxError
      ? 'The connection was interrupted. Your note may have been sent; check the board before trying again.'
      : error.message;
    feedback(message, true);
  } finally {
    sending = false;
    updateButton();
  }
});

render();
checkConnection();
setInterval(updateButton, 250);
