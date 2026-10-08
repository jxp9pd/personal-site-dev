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

const pages = {
  note: { file: 'vestaboard', boot: () => import('../../fe-artifacts/assets/js/vestaboard.js') },
  pomodoro: { file: 'pomodoro', boot: () => import('../../fe-artifacts/assets/js/pomodoro.js') },
};

export async function loadBoardPage(page, initial = {}) {
  vi.resetModules();
  vi.useFakeTimers();
  document.body.innerHTML = readFileSync(`fe-artifacts/tools/${pages[page].file}.html`, 'utf8');
  const data = page === 'pomodoro' ? pomodoroState(initial) : { configured: true, retryAfter: 0, ...initial };
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
