import { layoutMessage } from './vestaboard-layout.js?v=1';
import { requestBoard } from './vestaboard-api.js?v=1';
import { createBoardPreview } from './vestaboard-preview.js?v=1';

const $ = id => document.getElementById(id);
const preview = createBoardPreview($('board'));
const kickoff = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
const dayName = new Intl.DateTimeFormat(undefined, { weekday: 'long' });
const dayDate = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const kickoffTime = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const tileColors = { 63: '#cf5146', 64: '#e89344', 65: '#e8c950', 66: '#559f77', 67: '#4b8cc5', 68: '#8c73ae', 69: '#eeeee3', 70: '#151515' };
const idleCharacters = layoutMessage('NFL SCORES\nPICK A GAME').characters;

let session = null;
let selectedId = '';
let connected = null;
let busy = false;
let polling = false;
let requestVersion = 0;
let pickerVersion = '';

const selected = () => session?.games.find(game => game.id === selectedId)
  || (session?.game?.id === selectedId ? session.game : null);
const active = () => session?.state === 'tracking';
const matchup = game => `${game.away.abbreviation} at ${game.home.abbreviation}`;
const gameStatus = game => ({ scheduled: kickoff.format(new Date(game.startsAt)), live: 'Live',
  halftime: 'Halftime', final: 'Final', canceled: 'Canceled', postponed: 'Postponed',
  delayed: 'Delayed', suspended: 'Suspended' })[game.state];

function feedback(message, error = false) {
  $('feedback').textContent = message;
  $('feedback').dataset.error = String(error);
}

function renderPicker() {
  if (!session) return;
  const version = JSON.stringify(session.games);
  if (version !== pickerVersion) {
    const focusedId = document.activeElement?.dataset.gameId;
    const groups = new Map();
    for (const game of [...session.games].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))) {
      const date = new Date(game.startsAt);
      const key = [date.getFullYear(), date.getMonth(), date.getDate()].join('-');
      if (!groups.has(key)) groups.set(key, { date, games: [] });
      groups.get(key).games.push(game);
    }
    const days = [];
    for (const [key, group] of groups) {
      const section = document.createElement('div');
      section.className = 'game-day';
      section.setAttribute('role', 'group');
      section.setAttribute('aria-labelledby', `day-${key}`);
      const heading = document.createElement('h3');
      heading.className = 'game-day-heading';
      heading.id = `day-${key}`;
      heading.append(dayName.format(group.date));
      const dateLabel = document.createElement('span');
      dateLabel.className = 'game-day-date';
      dateLabel.textContent = dayDate.format(group.date);
      heading.append(dateLabel);
      const bubbles = document.createElement('div');
      bubbles.className = 'game-bubbles';
      for (const game of group.games) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'game-bubble';
        button.dataset.gameId = game.id;
        const hasScore = game.away.score !== null && game.home.score !== null;
        button.setAttribute('aria-label', `${game.away.name} at ${game.home.name}. ${gameStatus(game)}.${hasScore ? ` ${game.away.score} to ${game.home.score}.` : ''}`);
        const teams = document.createElement('span');
        teams.className = 'bubble-matchup';
        for (const [index, team] of [game.away, game.home].entries()) {
          if (index) {
            const at = document.createElement('span');
            at.className = 'bubble-at';
            at.textContent = 'at';
            teams.append(at);
          }
          const label = document.createElement('span');
          label.className = 'bubble-team';
          const swatch = document.createElement('span');
          swatch.className = 'team-swatch';
          swatch.setAttribute('aria-hidden', 'true');
          const colors = team.colors.map(code => tileColors[code] || tileColors[69]);
          swatch.style.background = `linear-gradient(90deg, ${colors[0]} 50%, ${colors[1]} 50%)`;
          label.append(swatch, team.abbreviation);
          teams.append(label);
        }
        const detail = document.createElement('span');
        detail.className = 'bubble-detail';
        if (hasScore) {
          const score = document.createElement('span');
          score.className = 'bubble-score';
          score.textContent = `${game.away.score} – ${game.home.score}`;
          detail.append(score);
        }
        const status = document.createElement('span');
        status.className = 'bubble-status';
        status.dataset.live = String(game.state === 'live');
        status.textContent = game.state === 'scheduled' ? kickoffTime.format(new Date(game.startsAt)) : gameStatus(game);
        detail.append(status);
        button.append(teams, detail);
        bubbles.append(button);
      }
      section.append(heading, bubbles);
      days.push(section);
    }
    $('games').replaceChildren(...days);
    pickerVersion = version;
    if (focusedId) $('games').querySelector(`[data-game-id="${focusedId}"]`)?.focus();
  }
  for (const button of $('games').querySelectorAll('[data-game-id]')) {
    button.setAttribute('aria-pressed', String(button.dataset.gameId === selectedId));
    button.disabled = busy;
  }
}

function render() {
  const game = selected();
  const trackingThis = active() && session.game?.id === selectedId;
  const characters = game?.characters || session?.characters || idleCharacters;
  const possession = game && [game.away, game.home].find(team => team.id === game.possession);
  preview(characters, game
    ? `${game.away.name} ${game.away.score ?? 'not started'}, ${game.home.name} ${game.home.score ?? 'not started'}. ${gameStatus(game)}.${possession ? ` ${possession.name} have the ball; orange tile beneath their score.` : ''}`
    : 'NFL scoreboard preview. Choose a game.');
  $('preview-title').textContent = trackingThis ? 'Tracking' : 'Preview';
  $('tracking-status').dataset.active = String(!!active());
  $('tracking-status').textContent = active() ? `Tracking ${matchup(session.game)}`
    : session?.state === 'completed' && session.game?.id === selectedId ? gameStatus(session.game)
    : session?.state === 'stopped' ? 'Stopped' : '';
  renderPicker();
  $('track').disabled = busy || !connected || !session?.configured || !game || game.terminal || trackingThis || !!session.source.error;
  $('stop').hidden = !active();
  $('stop').disabled = busy || !connected;
  $('source-status').textContent = session?.source.error || (session && !session.games.length
    ? session.source.lastCheckedAt ? 'No NFL games scheduled this week.' : 'Loading this week’s games…' : '');
  $('reconnect').hidden = connected !== false;
  const delivery = session?.delivery;
  $('delivery').dataset.error = String(connected === false || delivery?.status === 'error');
  $('delivery').textContent = connected === false ? 'Connection unavailable. Reconnecting…'
    : delivery?.status === 'error' ? delivery.error : '';
}

function accept(data) {
  const validFrame = frame => Array.isArray(frame) && frame.length === 3 && frame.every(row => Array.isArray(row) && row.length === 15);
  if (!data || !['idle', 'tracking', 'completed', 'stopped'].includes(data.state)
      || !Array.isArray(data.games) || !data.source || !validFrame(data.characters)
      || (data.state === 'tracking' && !data.game)
      || data.games.some(game => !game.id || !game.away || !game.home || !validFrame(game.characters)
        || !Number.isFinite(Date.parse(game.startsAt)))) throw new Error('Invalid NFL status.');
  const first = !session;
  session = data;
  connected = true;
  if (first && data.game) selectedId = data.game.id;
  if (!data.games.some(game => game.id === selectedId)
      && !(data.state === 'tracking' && data.game?.id === selectedId)) {
    selectedId = data.games[0]?.id || '';
  }
  render();
}

async function sync() {
  if (polling || busy) return;
  polling = true;
  const version = requestVersion;
  try {
    const data = await requestBoard('nfl');
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
  if (busy || !connected || (action === 'track' ? $('track').disabled : $('stop').disabled || !active())) return;
  busy = true;
  requestVersion += 1;
  feedback('');
  render();
  try {
    accept(await requestBoard('nfl', { body: action === 'track' ? { action, gameId: selectedId } : { action }, timeoutMs: 12000 }));
  } catch (error) {
    feedback(error.uncertain ? 'Connection interrupted. The action may have applied; checking tracking…' : error.message, true);
  } finally {
    busy = false;
    render();
    void sync();
  }
}

$('games').addEventListener('click', event => {
  const button = event.target.closest('[data-game-id]');
  if (!button || button.disabled) return;
  selectedId = button.dataset.gameId;
  feedback('');
  render();
});
$('game-form').addEventListener('submit', event => { event.preventDefault(); void command('track'); });
$('stop').addEventListener('click', () => void command('stop'));
$('reconnect').addEventListener('click', () => void sync());
document.addEventListener('visibilitychange', () => { if (!document.hidden) void sync(); });
window.addEventListener('online', () => void sync());
render();
void sync();
setInterval(() => { if (!document.hidden) void sync(); }, 5000);
