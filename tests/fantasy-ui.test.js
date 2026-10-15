import { describe, expect, it, vi } from 'vitest';
import { fantasyState as snapshot, loadBoardPage, postBodies, reply } from './helpers/vestaboard.js';
import { layoutMessage } from '../fe-artifacts/assets/js/vestaboard-layout.js';

const $ = id => document.getElementById(id);
const load = (initial = {}) => loadBoardPage('fantasy', initial);

function edit(id, value) {
  $(id).value = value;
  $(id).dispatchEvent(new Event('input', { bubbles: true }));
}

const submit = () => $('league-form').dispatchEvent(new Event('submit', { cancelable: true }));

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
    expect(postBodies(fetch)[0]).toEqual({ action: 'preview', leagues: [
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
    expect(postBodies(fetch)).toHaveLength(1);
    expect($('league-fields').disabled).toBe(true);
    expect($('start').hidden).toBe(true);
    expect($('stop').hidden).toBe(false);
    expect($('delivery').textContent).toBe('Board update queued.');
    submit();
    expect(postBodies(fetch)).toHaveLength(1);
    fetch.mockResolvedValue(reply(snapshot({ state: 'stopped' })));
    $('stop').click();
    await vi.advanceTimersByTimeAsync(0);
    expect(postBodies(fetch).at(-1)).toEqual({ action: 'stop' });
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

  it('waits for saved settings and leaves Stop available when score storage fails', async () => {
    const fetch = await load({ storage: { enabled: true, ready: false, error: 'Loading saved leagues…' } });
    expect($('league-fields').disabled).toBe(true);
    expect($('preview').disabled).toBe(true);
    expect($('start').disabled).toBe(true);
    expect($('source-status').textContent).toContain('Loading saved leagues');
    const restored = snapshot({ storage: { enabled: true, ready: true, error: null } });
    restored.leagues[0].username = 'saveduser';
    fetch.mockResolvedValue(reply(restored));
    await vi.advanceTimersByTimeAsync(5000);
    expect($('username-1').value).toBe('saveduser');
    expect($('start').disabled).toBe(false);
    fetch.mockResolvedValue(reply(snapshot({ state: 'tracking',
      storage: { enabled: true, ready: true, error: 'Latest scores could not be saved. Retrying shortly.' },
    })));
    await vi.advanceTimersByTimeAsync(5000);
    expect($('stop').disabled).toBe(false);
    expect($('source-status').textContent).toContain('could not be saved');
  });
});
