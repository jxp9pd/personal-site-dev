import { afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { layoutMessage } from '../../fe-artifacts/assets/js/vestaboard-layout.js';

export const reply = (data, ok = true) => ({ ok, json: async () => data });
export const pomodoroState = (overrides = {}) => ({
  configured: true, state: 'idle', phase: 'focus', focusMinutes: 25, breakMinutes: 5,
  focusMessage: 'YOU GOT THIS', remainingSeconds: 1500,
  characters: layoutMessage('YOU GOT THIS\nFOCUS 25 MIN\n🟪🟪🟪🟪🟪🟪🟪🟪🟪🟪🟪🟪🟪🟪🟪').characters,
  delivery: { status: 'idle' }, ...overrides,
});

export const nflGame = (overrides = {}) => ({
  id: '401000001', startsAt: '2026-10-11T20:25:00+00:00', state: 'live', terminal: false, possession: '25',
  away: { id: '25', abbreviation: 'SF', name: 'San Francisco 49ers', score: 21, colors: [63, 65] },
  home: { id: '26', abbreviation: 'SEA', name: 'Seattle Seahawks', score: 17, colors: [67, 66] },
  characters: [
    [63, 0, 19, 6, 0, 65, 0, 0, 67, 0, 19, 5, 1, 0, 66],
    [0, 0, 28, 27, 0, 0, 0, 0, 0, 0, 27, 33, 0, 0, 0],
    [0, 0, 0, 64, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  ], ...overrides,
});

export const nflState = (overrides = {}) => ({
  configured: true, state: 'idle', games: [nflGame()], game: null,
  characters: layoutMessage('NFL SCORES\nPICK A GAME').characters,
  source: { lastCheckedAt: '2026-10-09T00:30:00+00:00', error: null },
  delivery: { status: 'idle' }, ...overrides,
});

const pages = {
  note: { file: 'vestaboard', boot: () => import('../../fe-artifacts/assets/js/vestaboard.js') },
  pomodoro: { file: 'pomodoro', boot: () => import('../../fe-artifacts/assets/js/pomodoro.js') },
  nfl: { file: 'nfl', boot: () => import('../../fe-artifacts/assets/js/nfl.js') },
};

export async function loadBoardPage(page, initial = {}) {
  vi.resetModules();
  vi.useFakeTimers();
  document.body.innerHTML = readFileSync(`fe-artifacts/tools/${pages[page].file}.html`, 'utf8');
  const data = page === 'pomodoro' ? pomodoroState(initial)
    : page === 'nfl' ? nflState(initial) : { configured: true, retryAfter: 0, ...initial };
  const fetch = vi.fn().mockResolvedValue(reply(data));
  vi.stubGlobal('fetch', fetch);
  await pages[page].boot();
  await vi.advanceTimersByTimeAsync(0);
  return fetch;
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});
