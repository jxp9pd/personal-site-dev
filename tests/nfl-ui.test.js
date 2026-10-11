import { describe, expect, it, vi } from 'vitest';
import { loadBoardPage, postBodies, nflGame, nflState, reply } from './helpers/vestaboard.js';

const $ = id => document.getElementById(id);
const submit = () => $('game-form').dispatchEvent(new Event('submit', { cancelable: true }));
const bubble = id => document.querySelector(`[data-game-id="${id}"]`);
const choose = value => bubble(value).click();

describe('NFL game selection and shared tracking', () => {
  it('previews team colors, scores, and possession without sending a command', async () => {
    const fetch = await loadBoardPage('nfl');
    expect(bubble('401000001').getAttribute('aria-pressed')).toBe('true');
    expect(bubble('401000001').textContent).toContain('21 – 17');
    expect($('board').getAttribute('aria-label')).toContain('49ers have the ball');
    expect([...document.querySelectorAll('.tile')].map(tile => Number(tile.dataset.code))).toEqual(nflGame().characters.flat());
    expect($('track').disabled).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe('/api/vestaboard/nfl');
  });

  it('tracks once and restores Stop controls from the shared session', async () => {
    const fetch = await loadBoardPage('nfl');
    fetch.mockResolvedValue(reply(nflState({ state: 'tracking', game: nflGame(), delivery: { status: 'pending' } })));
    submit();
    submit();
    await vi.advanceTimersByTimeAsync(0);
    const writes = postBodies(fetch);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual({ action: 'track', gameId: '401000001' });
    expect($('stop').hidden).toBe(false);
    expect($('track').disabled).toBe(true);
    expect($('preview-title').textContent).toBe('Tracking');
    expect($('delivery').textContent).toBe('');
  });

  it('selecting a different game only previews it while the current game keeps tracking', async () => {
    const other = nflGame({ id: '401000002', possession: null });
    const fetch = await loadBoardPage('nfl', { state: 'tracking', game: nflGame(), games: [nflGame(), other] });
    choose(other.id);
    expect($('preview-title').textContent).toBe('Preview');
    expect($('stop').hidden).toBe(false);
    expect($('track').disabled).toBe(false);
    expect(fetch.mock.calls.every(([, options]) => !options.method)).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(bubble(other.id).getAttribute('aria-pressed')).toBe('true'); // Polling keeps the draft selection.
  });

  it('reopens an active game and automatically reflects final without another command', async () => {
    const fetch = await loadBoardPage('nfl', { state: 'tracking', game: nflGame() });
    expect($('preview-title').textContent).toBe('Tracking');
    const final = nflGame({ state: 'final', terminal: true, possession: null });
    fetch.mockResolvedValue(reply(nflState({ state: 'completed', game: final, games: [final] })));
    await vi.advanceTimersByTimeAsync(5000);
    expect($('tracking-status').textContent).toBe('Final');
    expect($('stop').hidden).toBe(true);
    expect($('track').disabled).toBe(true);
    expect(fetch.mock.calls.every(([, options]) => !options.method)).toBe(true);
  });

  it('blocks starting from a stale feed while keeping Stop available', async () => {
    await loadBoardPage('nfl', { state: 'tracking', game: nflGame(), source: { lastCheckedAt: '2026-10-09T00:30:00Z', error: 'NFL scores are unavailable. Retrying shortly.' } });
    expect($('source-status').textContent).toContain('unavailable');
    expect($('stop').disabled).toBe(false);
    expect($('track').disabled).toBe(true);
  });

  it('updates the picker when the refreshed schedule is empty', async () => {
    const fetch = await loadBoardPage('nfl');
    fetch.mockResolvedValue(reply(nflState({ games: [] })));
    await vi.advanceTimersByTimeAsync(5000);
    expect(document.querySelectorAll('[data-game-id]')).toHaveLength(0);
    expect($('source-status').textContent).toContain('No NFL games');
  });

  it('groups all games by local day in chronological order, including Monday night', async () => {
    const scheduled = (id, localTime) => nflGame({ id, state: 'scheduled', startsAt: new Date(localTime).toISOString(),
      away: { ...nflGame().away, score: null }, home: { ...nflGame().home, score: null } });
    const thursday = scheduled('401000001', '2026-10-08T17:15:00');
    const sunday = scheduled('401000002', '2026-10-11T13:25:00');
    const monday = scheduled('401000003', '2026-10-12T17:15:00');
    await loadBoardPage('nfl', { games: [monday, thursday, sunday] });
    const headings = [...document.querySelectorAll('.game-day-heading')].map(heading => heading.textContent);
    expect(headings[0]).toContain('Thursday');
    expect(headings[1]).toContain('Sunday');
    expect(headings[2]).toContain('Monday');
    expect([...document.querySelectorAll('[data-game-id]')].map(button => button.dataset.gameId)).toEqual([thursday.id, sunday.id, monday.id]);
    expect(bubble(monday.id).textContent).not.toContain('21 – 17');
  });

  it('automatically replaces last week’s bubbles with the new schedule while open', async () => {
    const fetch = await loadBoardPage('nfl');
    const next = nflGame({ id: '401000002', startsAt: new Date('2026-10-18T13:25:00').toISOString() });
    fetch.mockResolvedValue(reply(nflState({ games: [next] })));
    await vi.advanceTimersByTimeAsync(5000);
    expect(bubble('401000001')).toBeNull();
    expect(bubble(next.id).getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('.game-day-heading').textContent).toContain('Oct 18');
    expect(fetch.mock.calls.every(([, options]) => !options.method)).toBe(true);
  });

  it('keeps an older active game in the preview without adding it to this week’s bubbles', async () => {
    const fetch = await loadBoardPage('nfl', { state: 'tracking', game: nflGame() });
    const next = nflGame({ id: '401000002', startsAt: new Date('2026-10-18T13:25:00').toISOString() });
    fetch.mockResolvedValue(reply(nflState({ state: 'tracking', game: nflGame(), games: [next] })));
    await vi.advanceTimersByTimeAsync(5000);
    expect(bubble('401000001')).toBeNull();
    expect(bubble(next.id)).not.toBeNull();
    expect($('preview-title').textContent).toBe('Tracking');
    expect($('stop').hidden).toBe(false);
    expect($('track').disabled).toBe(true);
  });
});
