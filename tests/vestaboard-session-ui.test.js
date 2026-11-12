import { describe, expect, it, vi } from 'vitest';
import { boardState, loadBoardPage, nflGame, postBodies, reply } from './helpers/vestaboard.js';

const $ = id => document.getElementById(id);
const submit = form => $(form).dispatchEvent(new Event('submit', { cancelable: true }));
const cases = [
  { page: 'pomodoro', form: 'timer-form', active: { state: 'running' },
    control: 'pause', action: 'pause', updated: { state: 'paused', remainingSeconds: 1495 },
    expected: { 'phase-label': 'Focus paused', pause: 'Resume' }, live: { 'phase-label': 'Focus' } },
  { page: 'sports', form: 'game-form', active: { state: 'tracking', game: nflGame() },
    control: 'stop', action: 'stop', updated: { state: 'stopped', game: nflGame() },
    expected: { 'tracking-status': 'Stopped' }, live: { 'preview-title': 'Tracking' } },
  { page: 'fantasy', form: 'league-form', active: { state: 'tracking' },
    action: 'start', updated: { state: 'tracking' },
    expected: { 'tracking-status': 'Live' }, live: { 'tracking-status': 'Live' } },
];

const expectLabels = labels => {
  for (const [id, text] of Object.entries(labels)) expect($(id).textContent).toBe(text);
};

describe.each(cases)('$page session synchronization', scenario => {
  it('keeps the latest command when an older poll finishes afterward', async () => {
    const initial = scenario.control ? scenario.active : {};
    const fetch = await loadBoardPage(scenario.page, initial);
    let resolvePoll;
    fetch.mockImplementationOnce(() => new Promise(resolve => { resolvePoll = resolve; }));
    await vi.advanceTimersByTimeAsync(5000);
    fetch.mockResolvedValue(reply(boardState(scenario.page, scenario.updated)));
    if (scenario.control) $(scenario.control).click();
    else submit(scenario.form);
    await vi.advanceTimersByTimeAsync(0);
    resolvePoll(reply(boardState(scenario.page, initial)));
    await vi.advanceTimersByTimeAsync(0);
    expectLabels(scenario.expected);
    expect(postBodies(fetch)).toEqual([expect.objectContaining({ action: scenario.action })]);
    if (scenario.action === 'stop') expect($('stop').hidden).toBe(true);
  });

  it('reconciles an uncertain command without retrying and displays delivery errors', async () => {
    const fetch = await loadBoardPage(scenario.page);
    fetch.mockRejectedValueOnce(new TypeError('offline'));
    const delivery = { status: 'error', error: 'Check the board before retrying.' };
    fetch.mockResolvedValue(reply(boardState(scenario.page, { ...scenario.active, delivery })));
    submit(scenario.form);
    await vi.advanceTimersByTimeAsync(0);
    expect($('feedback').textContent).toContain('may have applied');
    expectLabels(scenario.live);
    expect($('delivery').dataset.error).toBe('true');
    expect($('delivery').textContent).toBe(delivery.error);
    expect(postBodies(fetch)).toHaveLength(1);
  });

  it('disables controls during a browser outage and recovers through polling', async () => {
    const fetch = await loadBoardPage(scenario.page, scenario.active);
    fetch.mockRejectedValueOnce(new TypeError('offline'));
    await vi.advanceTimersByTimeAsync(5000);
    expect($('stop').disabled).toBe(true);
    expect($('delivery').textContent).toContain('Reconnecting');
    fetch.mockResolvedValue(reply(boardState(scenario.page, scenario.active)));
    await vi.advanceTimersByTimeAsync(5000);
    expect($('stop').disabled).toBe(false);
    expectLabels(scenario.live);
    expect(postBodies(fetch)).toHaveLength(0);
  });
});

describe.each([
  { page: 'pomodoro', button: 'start' },
  { page: 'sports', button: 'track' },
  { page: 'fantasy', button: 'start' },
])('$page status validation', ({ page, button }) => {
  const tiles = () => [...document.querySelectorAll('.tile')].map(tile => tile.dataset.code);
  const shortRow = () => {
    const characters = boardState(page).characters.map(row => [...row]);
    characters[1].pop();
    return characters;
  };
  const textTile = () => {
    const characters = boardState(page).characters.map(row => [...row]);
    characters[0][0] = 'A';
    return characters;
  };

  it.each([['a row that is not 15 tiles', shortRow], ['a non-integer tile code', textTile]])('rejects a board grid with %s', async (_, characters) => {
    const fetch = await loadBoardPage(page);
    expect($(button).disabled).toBe(false);
    const board = tiles();
    fetch.mockResolvedValue(reply(boardState(page, { characters: characters() })));
    await vi.advanceTimersByTimeAsync(5000);
    expect($(button).disabled).toBe(true);
    expect($('delivery').textContent).toContain('Reconnecting');
    expect(tiles()).toEqual(board);
    expect(postBodies(fetch)).toHaveLength(0);
  });
});
