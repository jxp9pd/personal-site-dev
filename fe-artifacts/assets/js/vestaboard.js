import { layoutMessage } from './vestaboard-layout.js?v=1';
import { readBoardStatus, sendBoardMessage } from './vestaboard-api.js?v=1';
import { createBoardPreview } from './vestaboard-preview.js?v=1';

const $ = id => document.getElementById(id);
const form = $('message-form');
const input = $('message');
const renderBoard = createBoardPreview($('board'));
let configured = false;
let sending = false;
let cooldownUntil = 0;
let layout;

function updateButton() {
  const seconds = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
  $('send').disabled = sending || !configured || !!layout.error || seconds > 0;
  $('send-label').textContent = sending ? 'Sending…' : seconds > 0 ? `Next note in ${seconds}s` : 'Send to the board';
}

function render() {
  layout = layoutMessage(input.value);
  renderBoard(layout.characters, layout.error ? 'Empty preview. ' + layout.error : 'Preview: ' + input.value);
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
    const data = await readBoardStatus();
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
form.addEventListener('keydown', event => {
  if (event.key !== 'Enter' || !event.metaKey || event.isComposing) return;
  event.preventDefault();
  if (!event.repeat && !$('send').disabled) form.requestSubmit($('send'));
});
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
    const data = await sendBoardMessage(layout.characters);
    if (data.retryAfter) cooldownUntil = Date.now() + data.retryAfter * 1000;
    feedback('Accepted by Vestaboard. Your note is on its way.');
  } catch (error) {
    if (error.retryAfter) cooldownUntil = Date.now() + error.retryAfter * 1000;
    feedback(error.message, true);
  } finally {
    sending = false;
    updateButton();
  }
});

render();
checkConnection();
setInterval(updateButton, 250);
