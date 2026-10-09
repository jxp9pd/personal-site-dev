import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { layoutMessage } from '../fe-artifacts/assets/js/vestaboard-layout.js';

const $ = id => document.getElementById(id);
const reply = (data, ok = true) => ({ ok, json: async () => data });
const snapshot = (overrides = {}) => ({
  configured: true, state: 'idle', week: 5, season: '2026',
  leagues: [
    { url: 'https://sleeper.com/leagues/1399168246661296128', username: 'pentakalos', label: 'TD', error: null,
      matchup: { leagueName: 'Show Me Your TDs', you: { name: 'Bite me', points: 123.45 },
        opponent: { name: 'Opponent one', points: 119.4 }, starters: ['1'], winChance: null } },
    { url: 'https://sleeper.com/leagues/1389707496347697152', username: 'pentakalos', label: 'SH', error: null,
      matchup: { leagueName: 'Shmeed League', you: { name: 'Ladd & the Lads', points: 98.6 },
        opponent: { name: 'Opponent two', points: 101.2 }, starters: ['2'], winChance: null } },
  ],
  characters: layoutMessage('TD 123 - 119\nSH 99 - 101').characters,
  source: { lastCheckedAt: '2026-10-09T03:00:00+00:00', playError: null, winChanceAvailable: false },
  alert: null, queuedAlerts: 0, alertSecondsRemaining: null, delivery: { status: 'idle' }, ...overrides,
});

async function load(initial = {}) {
  vi.resetModules();
  vi.useFakeTimers();
  document.body.innerHTML = readFileSync('fe-artifacts/tools/fantasy.html', 'utf8');
  const fetch = vi.fn().mockResolvedValue(reply(snapshot(initial)));
  vi.stubGlobal('fetch', fetch);
  await import('../fe-artifacts/assets/js/fantasy.js');
  await vi.advanceTimersByTimeAsync(0);
  return fetch;
}

function edit(id, value) {
  $(id).value = value;
  $(id).dispatchEvent(new Event('input', { bubbles: true }));
}

const submit = () => $('league-form').dispatchEvent(new Event('submit', { cancelable: true }));

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('Fantasy matchups and tracking controls', () => {
  it('loads real defaults, rounds scores, and only reads until an explicit command', async () => {
    const fetch = await load();
    expect($('username-1').value).toBe('pentakalos');
    expect($('league-2').value).toContain('1389707496347697152');
    expect($('board').getAttribute('aria-label')).toContain('123; opponent Opponent one, 119');
    expect($('matchups').textContent).toContain('Ladd & the Lads · 99');
    expect($('matchups').textContent).not.toContain('98.6');
    expect($('board').textContent).not.toContain('%');
    expect($('board').children).toHaveLength(45);
    expect($('start').disabled).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.every(([, options]) => !options.method)).toBe(true);
  });

  it('preserves edited settings during polls and previews without a board token', async () => {
    const fetch = await load({ configured: false });
    edit('league-1', 'https://sleeper.com/leagues/123/matchup');
    edit('username-1', 'someoneelse');
    edit('label-1', 'abc');
    await vi.advanceTimersByTimeAsync(5000);
    expect($('username-1').value).toBe('someoneelse');
    expect($('start').disabled).toBe(true);
    expect($('preview').disabled).toBe(false);
    $('preview').click();
    await vi.advanceTimersByTimeAsync(0);
    const post = fetch.mock.calls.find(([, options]) => options.method === 'POST');
    expect(JSON.parse(post[1].body)).toEqual({ action: 'preview', leagues: [
      { url: 'https://sleeper.com/leagues/123/matchup', username: 'someoneelse', label: 'ABC' },
      { url: 'https://sleeper.com/leagues/1389707496347697152', username: 'pentakalos', label: 'SH' },
    ] });
  });

  it('validates blank fields and duplicate labels before sending', async () => {
    const fetch = await load();
    edit('username-1', '');
    expect($('start').disabled).toBe(true);
    submit();
    edit('username-1', 'pentakalos');
    edit('label-1', 'SH');
    expect($('preview').disabled).toBe(true);
    submit();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('starts once, disables configuration, and stops the shared session', async () => {
    const fetch = await load();
    fetch.mockResolvedValue(reply(snapshot({ state: 'tracking', delivery: { status: 'pending' } })));
    submit();
    submit();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch.mock.calls.filter(([, options]) => options.method === 'POST')).toHaveLength(1);
    expect($('league-fields').disabled).toBe(true);
    expect($('start').hidden).toBe(true);
    expect($('stop').hidden).toBe(false);
    expect($('delivery').textContent).toBe('Board update queued.');
    submit();
    expect(fetch.mock.calls.filter(([, options]) => options.method === 'POST')).toHaveLength(1);
    fetch.mockResolvedValue(reply(snapshot({ state: 'stopped' })));
    $('stop').click();
    await vi.advanceTimersByTimeAsync(0);
    expect(JSON.parse(fetch.mock.calls.findLast(([, options]) => options.method === 'POST')[1].body)).toEqual({ action: 'stop' });
    expect($('league-fields').disabled).toBe(false);
    expect($('tracking-status').textContent).toBe('Stopped');
  });

  it('uses the exact server alert frame and shows the queue and remaining time', async () => {
    const characters = layoutMessage('BIG PLAY!\nCEEDEE LAMB\n24YD TD').characters;
    await load({ state: 'tracking', characters, alert: {
      players: ['CeeDee Lamb'], detail: '24YD TD', description: 'CeeDee Lamb 24yd touchdown',
    }, queuedAlerts: 2, alertSecondsRemaining: 30 });
    expect($('preview-title').textContent).toBe('Big Play');
    expect($('board').textContent).toContain('CEEDEE LAMB');
    expect($('alert-status').textContent).toContain('30s remaining · 2 more queued');
    expect([...$('board').children].map(tile => Number(tile.dataset.code))).toEqual(characters.flat());
  });

  it('keeps stop available during source outages and safely renders team names', async () => {
    const state = snapshot({ state: 'tracking', source: { playError: 'Feed unavailable.', lastCheckedAt: null } });
    state.leagues[0].error = 'Scores unavailable.';
    state.leagues[0].matchup.you.name = '<img src=x onerror=alert(1)>';
    await load(state);
    expect($('stop').disabled).toBe(false);
    expect($('source-status').textContent).toContain('TD: Scores unavailable.');
    expect($('source-status').textContent).toContain('Feed unavailable.');
    expect($('matchups').querySelector('img')).toBeNull();
    expect($('matchups').textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('reconciles ambiguous starts without repeating the POST', async () => {
    const fetch = await load();
    fetch.mockImplementation(async (url, options) => {
      if (options.method === 'POST') throw new Error('Disconnected');
      return reply(snapshot({ state: 'tracking' }));
    });
    submit();
    await vi.advanceTimersByTimeAsync(0);
    expect($('feedback').textContent).toContain('may have applied');
    expect($('tracking-status').textContent).toBe('Live');
    expect(fetch.mock.calls.filter(([, options]) => options.method === 'POST')).toHaveLength(1);
  });

  it('does not let a stale poll overwrite a newer start response', async () => {
    const fetch = await load();
    let resolvePoll;
    fetch.mockImplementation((url, options) => options.method === 'POST'
      ? Promise.resolve(reply(snapshot({ state: 'tracking' })))
      : new Promise(resolve => { resolvePoll = resolve; }));
    await vi.advanceTimersByTimeAsync(5000);
    submit();
    await vi.advanceTimersByTimeAsync(0);
    resolvePoll(reply(snapshot({ state: 'stopped' })));
    await vi.advanceTimersByTimeAsync(0);
    expect($('tracking-status').textContent).toBe('Live');
  });
});
