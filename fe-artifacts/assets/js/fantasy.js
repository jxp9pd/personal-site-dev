import { createBoardSession } from './vestaboard-session.js?v=1';
import { createBoardPreview } from './vestaboard-preview.js?v=1';
import { layoutMessage } from './vestaboard-layout.js?v=1';

const $ = id => document.getElementById(id);
const preview = createBoardPreview($('board'));
const idle = layoutMessage('FANTASY\nPICK YOUR TEAMS').characters;
const checked = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
let session = null;
let edited = false;
const controller = createBoardSession({
  resource: 'fantasy', accept, render, feedback,
  uncertainMessage: 'Connection interrupted. The action may have applied; checking tracking…',
});

const active = () => session?.state === 'tracking';
const rounded = value => Math.sign(value) * Math.round(Math.abs(value));
const draft = () => [1, 2].map(i => ({
  url: $(`league-${i}`).value.trim(), username: $(`username-${i}`).value.trim(), label: $(`label-${i}`).value.trim().toUpperCase(),
}));
const valid = () => $('league-form').checkValidity() && draft()[0].label !== draft()[1].label;

function feedback(text, error = false) {
  $('feedback').textContent = text;
  $('feedback').dataset.error = String(error);
}

function fillFields(leagues) {
  leagues.forEach((league, index) => {
    const i = index + 1;
    $(`league-${i}`).value = league.url;
    $(`username-${i}`).value = league.username;
    $(`label-${i}`).value = league.label;
  });
}

function renderMatchups() {
  const cards = (session?.leagues || []).map(league => {
    const card = document.createElement('div');
    card.className = 'matchup';
    const title = document.createElement('h3');
    title.textContent = `${league.label} · ${league.matchup?.leagueName || league.username}`;
    card.append(title);
    if (league.matchup) {
      for (const [side, team] of [['you', league.matchup.you], ['opponent', league.matchup.opponent]]) {
        const row = document.createElement('p');
        row.className = `team-${side}`;
        row.textContent = team ? `${team.name} · ${rounded(team.points)}${side === 'you' ? ' (you)' : ''}` : 'Bye week';
        card.append(row);
      }
    } else {
      const row = document.createElement('p');
      row.textContent = league.error || 'Loading matchup…';
      card.append(row);
    }
    return card;
  });
  $('matchups').replaceChildren(...cards);
}

function render() {
  const { connected, busy } = controller;
  const storageReady = session?.storage?.ready !== false;
  $('preview-title').textContent = session?.alert ? 'Big Play' : 'Scores';
  $('tracking-status').dataset.active = String(!!active());
  $('tracking-status').textContent = active() ? 'Live' : session?.state === 'stopped' ? 'Stopped' : 'Ready';
  $('league-fields').disabled = busy || !!active() || !storageReady;
  $('preview').hidden = $('start').hidden = !!active();
  $('preview').disabled = busy || !connected || !storageReady || !valid();
  $('start').disabled = busy || !connected || !storageReady || !session?.configured || !valid();
  $('stop').hidden = !active();
  $('stop').disabled = busy || !connected;
  $('reconnect').hidden = connected;
  $('week').textContent = session?.week ? `Week ${session.week}` : '';
  const description = session?.alert
    ? `Big Play: ${session.alert.players.join(', ')}. ${session.alert.detail}.`
    : (session?.leagues || []).map(league => league.matchup
      ? `${league.label}: your team ${league.matchup.you.name}, ${rounded(league.matchup.you.points)}; opponent ${league.matchup.opponent?.name || 'bye'}, ${league.matchup.opponent ? rounded(league.matchup.opponent.points) : 'no score'}.`
      : `${league.label}: loading matchup.`).join(' ') || 'Fantasy football preview. Choose two leagues.';
  preview(session?.characters || idle, description);
  renderMatchups();
  $('alert-status').textContent = session?.alert
    ? `${session.alertSecondsRemaining !== null ? `${session.alertSecondsRemaining}s remaining` : 'Waiting for board'}${session.queuedAlerts ? ` · ${session.queuedAlerts} more queued` : ''}` : '';
  const delivery = session?.delivery;
  $('delivery').dataset.error = String(delivery?.status === 'error');
  $('delivery').textContent = !connected ? 'Reconnecting…'
    : delivery?.status === 'pending' ? 'Board update queued.'
    : delivery?.status === 'error' ? delivery.error
    : '';
  $('source-status').textContent = [...new Set([
    ...(session?.leagues || []).filter(league => league.error).map(league => `${league.label}: ${league.error}`),
    session?.source.playError,
    session?.storage?.error,
  ].filter(Boolean))].join(' ');
  $('updated').textContent = $('source-status').textContent && session?.source.lastCheckedAt
    ? `Checked ${checked.format(new Date(session.source.lastCheckedAt))}` : '';
}

function accept(data, { command }) {
  const frame = value => Array.isArray(value) && value.length === 3
    && value.every(row => Array.isArray(row) && row.length === 15 && row.every(Number.isInteger));
  if (!data || !['idle', 'tracking', 'stopped'].includes(data.state) || !frame(data.characters)
      || !Array.isArray(data.leagues) || data.leagues.length !== 2 || !data.source
      || data.leagues.some(league => !league.url || !league.username || !league.label
        || league.matchup && (!league.matchup.you || !Number.isFinite(league.matchup.you.points)
          || league.matchup.opponent && !Number.isFinite(league.matchup.opponent.points)))) throw new Error('Invalid fantasy status.');
  const wasActive = active();
  session = data;
  if (command) edited = false;
  if (active() || wasActive || !edited) fillFields(data.leagues);
}

function command(action) {
  if ($(action).disabled || (action === 'stop' ? !active() : active())) return;
  return controller.command(action === 'stop' ? { action } : { action, leagues: draft() });
}

$('league-form').addEventListener('submit', event => { event.preventDefault(); void command('start'); });
$('preview').addEventListener('click', () => void command('preview'));
$('stop').addEventListener('click', () => void command('stop'));
$('reconnect').addEventListener('click', () => void controller.sync());
$('league-fields').addEventListener('input', () => {
  edited = true;
  feedback(draft()[0].label === draft()[1].label ? 'Give the leagues different board labels.' : '', true);
  render();
});
controller.start();
