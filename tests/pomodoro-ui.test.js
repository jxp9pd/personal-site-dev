import { describe, expect, it, vi } from 'vitest';
import { loadBoardPage, pomodoroState as snapshot, reply } from './helpers/vestaboard.js';

const $ = id => document.getElementById(id);
const start = (initial = {}) => loadBoardPage('pomodoro', initial);

const submit = () => $('timer-form').dispatchEvent(new Event('submit', { cancelable: true }));
const change = (id, value) => { $(id).value = value; $(id).dispatchEvent(new Event('input')); };

describe('Pomodoro controls and live countdown', () => {
  it('previews durations without writing to the board and validates whole minutes', async () => {
    const fetch = await start();
    change('focus-minutes', '50');
    change('break-minutes', '10');
    expect($('focus-minutes').value).toBe('50');
    expect($('break-minutes').value).toBe('10');
    expect($('countdown').textContent).toBe('50:00');
    expect($('board').getAttribute('aria-label')).toContain('FOCUS 50 MIN');
    for (const value of ['', '0', '181', '1.5']) {
      change('focus-minutes', value);
      expect($('start').disabled).toBe(true);
      submit();
    }
    change('focus-minutes', '1');
    change('break-minutes', '1');
    expect($('start').disabled).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('sends chosen durations once and uses the shared session and exact server preview', async () => {
    const fetch = await start();
    change('focus-minutes', '50');
    change('break-minutes', '10');
    const state = snapshot({ state: 'running', focusMinutes: 50, breakMinutes: 10, remainingSeconds: 3000, delivery: { status: 'pending' } });
    fetch.mockResolvedValue(reply(state));
    submit();
    submit();
    await vi.advanceTimersByTimeAsync(0);
    const writes = fetch.mock.calls.filter(([, options]) => options.method === 'POST');
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0][1].body)).toEqual({ action: 'start', focusMinutes: 50, breakMinutes: 10 });
    expect($('durations').disabled).toBe(true);
    expect($('start').hidden).toBe(true);
    expect($('active-controls').hidden).toBe(false);
    expect([...document.querySelectorAll('.tile')].map(tile => Number(tile.dataset.code))).toEqual(state.characters.flat());
    expect($('delivery').textContent).toContain('queued');
  });

  it('counts seconds in the browser without per-second requests or board changes', async () => {
    const fetch = await start({ state: 'running', remainingSeconds: 64 });
    const board = $('board').innerHTML;
    await vi.advanceTimersByTimeAsync(2100);
    expect($('countdown').textContent).toBe('01:02');
    expect($('board').innerHTML).toBe(board);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(document.title).toContain('01:02 · Focus');
  });

  it('restores an existing paused session and resumes, then stops', async () => {
    const fetch = await start({ state: 'paused', phase: 'break', remainingSeconds: 42 });
    await vi.advanceTimersByTimeAsync(2000);
    expect($('countdown').textContent).toBe('00:42');
    expect($('pause').textContent).toBe('Resume');
    expect($('phase-label').textContent).toBe('Break paused');
    fetch.mockResolvedValue(reply(snapshot({ state: 'running', phase: 'break', remainingSeconds: 42 })));
    $('pause').click();
    await vi.advanceTimersByTimeAsync(0);
    expect($('pause').textContent).toBe('Pause');
    fetch.mockResolvedValue(reply(snapshot({ state: 'stopped', phase: 'break', remainingSeconds: 0 })));
    $('stop').click();
    await vi.advanceTimersByTimeAsync(0);
    const actions = fetch.mock.calls.filter(([, options]) => options.method === 'POST').map(([, options]) => JSON.parse(options.body).action);
    expect(actions).toEqual(['resume', 'stop']);
    expect($('start').hidden).toBe(false);
    expect($('durations').disabled).toBe(false);
    expect($('phase-label').textContent).toBe('Stopped');
  });

  it('syncs phase changes and completed sessions without starting another cycle', async () => {
    const fetch = await start({ state: 'running', remainingSeconds: 1 });
    await vi.advanceTimersByTimeAsync(1100);
    expect($('countdown').textContent).toBe('00:00');
    expect($('phase-label').textContent).toBe('Switching…');
    fetch.mockResolvedValue(reply(snapshot({ state: 'running', phase: 'break', remainingSeconds: 300 })));
    await vi.advanceTimersByTimeAsync(3900);
    expect($('pomodoro').dataset.phase).toBe('break');
    expect($('phase-label').textContent).toBe('Break');
    fetch.mockResolvedValue(reply(snapshot({ state: 'completed', phase: 'break', remainingSeconds: 0 })));
    await vi.advanceTimersByTimeAsync(5000);
    expect($('phase-label').textContent).toBe('Done');
    expect($('active-controls').hidden).toBe(true);
    expect(fetch.mock.calls.every(([, options]) => !options.method)).toBe(true);
  });

  it('ignores a stale poll that finishes after a pause command', async () => {
    const fetch = await start({ state: 'running' });
    let resolvePoll;
    fetch.mockImplementationOnce(() => new Promise(resolve => { resolvePoll = resolve; }));
    await vi.advanceTimersByTimeAsync(5000);
    fetch.mockResolvedValue(reply(snapshot({ state: 'paused', remainingSeconds: 1495 })));
    $('pause').click();
    await vi.advanceTimersByTimeAsync(0);
    resolvePoll(reply(snapshot({ state: 'running' })));
    await vi.advanceTimersByTimeAsync(0);
    expect($('phase-label').textContent).toBe('Focus paused');
    expect($('pause').textContent).toBe('Resume');
  });

  it('reconciles a lost command response without automatically repeating it', async () => {
    const fetch = await start();
    fetch.mockRejectedValueOnce(new TypeError('offline'));
    fetch.mockResolvedValue(reply(snapshot({ state: 'running', delivery: { status: 'error', error: 'Check the board before retrying.' } })));
    submit();
    await vi.advanceTimersByTimeAsync(0);
    expect($('feedback').textContent).toContain('may have applied');
    expect($('phase-label').textContent).toBe('Focus');
    expect($('delivery').dataset.error).toBe('true');
    expect($('delivery').textContent).toBe('Check the board before retrying.');
    expect(fetch.mock.calls.filter(([, options]) => options.method === 'POST')).toHaveLength(1);
  });

  it('disables controls during an outage and recovers on the next status check', async () => {
    const fetch = await start({ state: 'running', remainingSeconds: 100 });
    fetch.mockRejectedValueOnce(new TypeError('offline'));
    await vi.advanceTimersByTimeAsync(5000);
    expect($('stop').disabled).toBe(true);
    expect($('delivery').textContent).toContain('Reconnecting');
    fetch.mockResolvedValue(reply(snapshot({ state: 'paused', remainingSeconds: 95 })));
    await vi.advanceTimersByTimeAsync(5000);
    expect($('stop').disabled).toBe(false);
    expect($('pause').textContent).toBe('Resume');
  });
});
