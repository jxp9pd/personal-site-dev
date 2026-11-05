import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountGame } from '../fe-artifacts/assets/js/challenge-24.js';

const page = readFileSync('site/pages/games/challenge-24.html', 'utf8');
const cards = [
  { numbers: [1, 2, 3, 4], solution: '(1 + 2 + 3) * 4', difficulty: 1 },
  { numbers: [2, 2, 2, 3], solution: '2 * 2 * 2 * 3', difficulty: 1 },
  { numbers: [3, 3, 4, 4], solution: '3 * 4 + 3 * 4', difficulty: 2 },
];
const $ = id => document.getElementById(id);
const text = id => $(id).textContent.trim();
let game;

function mount({ injectDeck = true, deckFactory } = {}) {
  game?.destroy();
  const parsed = new DOMParser().parseFromString(page, 'text/html');
  parsed.querySelectorAll('script').forEach(script => script.remove());
  document.body.innerHTML = parsed.body.innerHTML;
  let time = 0;
  let index = 0;
  const deck = { next: vi.fn(() => structuredClone(cards[index++ % cards.length])) };
  game = mountGame({
    root: document,
    ...(injectDeck ? { deck } : {}),
    ...(deckFactory ? { deckFactory } : {}),
    now: () => time,
  });
  return { deck, at: milliseconds => { time = milliseconds; } };
}

function begin({ mode = 'free', count = 5, difficulty = 'random' } = {}) {
  $(`mode-${mode}`).click();
  if (mode === 'time') {
    $('puzzle-count').value = String(count);
    $(`difficulty-${difficulty}`).click();
  }
  $('start-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

function start(options = {}) {
  const state = mount(options);
  begin(options);
  return state;
}

function submit(expression) {
  $('answer').value = expression;
  $('answer-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

function expectCounts(played, correct) {
  expect(text('played-count')).toBe(String(played));
  expect(text('correct-count')).toBe(String(correct));
}

function expectTimedCounts(played, correct, count) {
  expect(text('played-count').replace(/\s/g, '')).toBe(`${played}/${count}`);
  expect(text('correct-count')).toBe(String(correct));
}

function expectSolution(card) {
  const normalize = value => value.replaceAll('×', '*').replaceAll('÷', '/').replaceAll('−', '-').replace(/\s/g, '');
  expect(normalize(text('feedback'))).toContain(normalize(card.solution));
}

afterEach(() => {
  game?.destroy();
  game = undefined;
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('Challenge 24 Free Play session', () => {
  it('shows elapsed time, freezes on reveal, and restarts for the next card or session', () => {
    vi.useFakeTimers();
    const { at } = start();
    expect(text('card-time')).toBe('0:00');
    at(999);
    vi.advanceTimersByTime(250);
    expect(text('card-time')).toBe('0:00');
    at(1_500);
    vi.advanceTimersByTime(250);
    expect(text('card-time')).toBe('0:01');
    submit('1 + 2 + 3 + 4');
    at(2_500);
    vi.advanceTimersByTime(250);
    expect(text('card-time')).toBe('0:02');
    $('show-answer').click();
    at(30_000);
    vi.advanceTimersByTime(5_000);
    expect(text('card-time')).toBe('0:02');

    $('next-card').click();
    expect(text('card-time')).toBe('0:00');
    at(32_000);
    vi.advanceTimersByTime(250);
    expect(text('card-time')).toBe('0:02');
    submit(cards[1].solution);
    at(40_000);
    vi.advanceTimersByTime(250);
    expect(text('card-time')).toBe('0:02');
    $('reset-session').click();
    expect(text('card-time')).toBe('0:00');
    game.destroy();
    at(45_000);
    vi.advanceTimersByTime(1_000);
    expect(text('card-time')).toBe('0:00');
  });

  it('keeps invalid and incorrect attempts on the same card and preserves solve time', () => {
    const { deck, at } = start();
    expect(deck.next).toHaveBeenCalledTimes(1);
    at(20_000);
    submit('1 +');
    expect(text('feedback')).not.toBe('');
    expectCounts(0, 0);
    expect($('answer').disabled).toBe(false);
    expect($('next-card').hidden).toBe(true);

    at(40_000);
    submit('1 + 2 + 3 + 4');
    expect(text('feedback')).not.toBe('');
    expectCounts(0, 0);

    at(64_900);
    submit(cards[0].solution);
    expectCounts(1, 1);
    expect(text('average-time')).toBe('1:05');
    expect($('answer').disabled).toBe(true);
    expect($('submit-answer').disabled).toBe(true);
    expect($('show-answer').disabled).toBe(true);
    expect($('next-card').hidden).toBe(false);
    expect(deck.next).toHaveBeenCalledTimes(1);

    $('next-card').click();
    expect(deck.next).toHaveBeenCalledTimes(2);
    expectCounts(1, 1);
    expect($('answer').disabled).toBe(false);
    expect($('next-card').hidden).toBe(true);
    expect([...$('card-numbers').querySelectorAll('[data-number]')].map(node => Number(node.textContent))).toEqual(cards[1].numbers);
  });

  it('counts a revealed card as played and excludes it from the average of correct solves', () => {
    const { at } = start();
    at(10_000);
    submit(cards[0].solution);
    expect(text('average-time')).toBe('0:10');
    $('next-card').click();

    at(110_000);
    $('show-answer').click();
    expect(text('feedback').replaceAll('×', '*').replace(/\s/g, '')).toContain(cards[1].solution.replace(/\s/g, ''));
    expectCounts(2, 1);
    expect(text('average-time')).toBe('0:10');
    expect($('answer').disabled).toBe(true);
    expect($('next-card').hidden).toBe(false);

    $('next-card').click();
    at(140_000);
    submit(cards[2].solution);
    expectCounts(3, 2);
    expect(text('average-time')).toBe('0:20');
  });

  it('finishes each card only once even if completion events repeat', () => {
    const { deck, at } = start();
    at(5_000);
    submit(cards[0].solution);
    at(55_000);
    submit(cards[0].solution);
    $('show-answer').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expectCounts(1, 1);
    expect(text('average-time')).toBe('0:05');
    expect(deck.next).toHaveBeenCalledTimes(1);

    $('next-card').click();
    $('show-answer').click();
    $('show-answer').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    submit(cards[1].solution);
    expectCounts(2, 1);
    expect(text('average-time')).toBe('0:05');
    expect(deck.next).toHaveBeenCalledTimes(2);
  });

  it('excludes time while the page is hidden from a correct solve', () => {
    vi.useFakeTimers();
    let visibility = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => visibility === 'hidden');
    const { at } = start();
    at(10_000);
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    at(110_000);
    vi.advanceTimersByTime(250);
    expect(text('card-time')).toBe('0:10');
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    at(115_000);
    submit(cards[0].solution);
    expect(text('card-time')).toBe('0:15');
    expectCounts(1, 1);
    expect(text('average-time')).toBe('0:15');
  });

  it('resets stats and the current timer, and starts a fresh session after remount', () => {
    const storageWrites = vi.spyOn(Storage.prototype, 'setItem');
    const { deck, at } = start();
    const emptyAverage = text('average-time');
    at(15_000);
    submit(cards[0].solution);
    at(60_000);
    $('reset-session').click();
    expectCounts(0, 0);
    expect(text('average-time')).toBe(emptyAverage);
    expect(deck.next).toHaveBeenCalledTimes(2);
    expect($('answer').disabled).toBe(false);
    expect($('next-card').hidden).toBe(true);
    at(65_000);
    submit(cards[1].solution);
    expectCounts(1, 1);
    expect(text('average-time')).toBe('0:05');

    game.destroy();
    start();
    expectCounts(0, 0);
    expect(text('average-time')).toBe(emptyAverage);
    expect(storageWrites).not.toHaveBeenCalled();
  });
});

describe('Challenge 24 start menu', () => {
  it('defaults to Time to K and does not draw cards or run a clock before Start', () => {
    vi.useFakeTimers();
    const deckFactory = vi.fn();
    const { deck, at } = mount({ deckFactory });
    expect($('start-menu').hidden).toBe(false);
    expect($('play-screen').hidden).toBe(true);
    expect($('results-screen').hidden).toBe(true);
    expect($('mode-time').getAttribute('aria-pressed')).toBe('true');
    expect($('puzzle-count').value).toBe('5');
    expect($('difficulty-random').getAttribute('aria-pressed')).toBe('true');
    expect($('time-settings').hidden).toBe(false);
    expect($('free-description').hidden).toBe(true);
    expect(deck.next).not.toHaveBeenCalled();
    expect(deckFactory).not.toHaveBeenCalled();

    $('mode-free').click();
    expect($('time-settings').hidden).toBe(true);
    expect($('free-description').hidden).toBe(false);
    $('mode-time').click();
    expect($('time-settings').hidden).toBe(false);
    expect($('free-description').hidden).toBe(true);
    $('decrease-count').click();
    expect($('puzzle-count').value).toBe('4');
    $('increase-count').click();
    expect($('puzzle-count').value).toBe('5');
    at(100_000);
    vi.advanceTimersByTime(1_000);
    expect(deck.next).not.toHaveBeenCalled();
    begin({ mode: 'time' });
    expect(text('card-time')).toBe('1:00');
    expect(text('total-time')).toBe('0:00.0');
  });

  it.each([1, 2, 3, 'random'])('constructs the selected difficulty %s only when starting', difficulty => {
    const deck = { next: vi.fn(() => structuredClone(cards[0])) };
    const deckFactory = vi.fn(() => deck);
    mount({ injectDeck: false, deckFactory });
    expect(deckFactory).not.toHaveBeenCalled();
    begin({ mode: 'time', count: 2, difficulty });
    expect(deckFactory).toHaveBeenCalledExactlyOnceWith({ difficulty });
    expect(deck.next).toHaveBeenCalledTimes(1);
    expectTimedCounts(0, 0, 2);
    expect($('start-menu').hidden).toBe(true);
    expect($('play-screen').hidden).toBe(false);
  });

  it.each(['', '0', '-1', '1.5', '9007199254740992'])('rejects invalid puzzle count %j without starting', count => {
    vi.useFakeTimers();
    const deckFactory = vi.fn();
    mount({ injectDeck: false, deckFactory });
    begin({ mode: 'time', count });
    expect(text('setup-error')).not.toBe('');
    expect($('start-menu').hidden).toBe(false);
    expect($('play-screen').hidden).toBe(true);
    expect(deckFactory).not.toHaveBeenCalled();
  });

  it('bypasses the factory for an injected deck and retains its stream across resets', () => {
    const deckFactory = vi.fn();
    const { deck } = start({ mode: 'time', count: 2, difficulty: 3, deckFactory });
    $('reset-session').click();
    expect(deckFactory).not.toHaveBeenCalled();
    expect(deck.next).toHaveBeenCalledTimes(2);
    expect([...$('card-numbers').querySelectorAll('[data-number]')].map(node => Number(node.textContent))).toEqual(cards[1].numbers);
  });
});

describe('Challenge 24 Time to K session', () => {
  it('counts down with ceiling seconds and accepts a correct answer just before the deadline', () => {
    vi.useFakeTimers();
    const { at } = start({ mode: 'time', count: 1 });
    expect(text('card-time')).toBe('1:00');
    expect(text('total-time')).toBe('0:00.0');
    expect($('average-time').closest('[hidden]')).not.toBeNull();
    at(1);
    vi.advanceTimersByTime(250);
    expect(text('card-time')).toBe('1:00');
    at(1_000);
    vi.advanceTimersByTime(250);
    expect(text('card-time')).toBe('0:59');
    at(59_999);
    vi.advanceTimersByTime(250);
    expect(text('card-time')).toBe('0:01');
    expect(text('total-time')).toBe('0:59.9');
    submit(cards[0].solution);
    expectTimedCounts(1, 1, 1);
    expect(text('total-time')).toBe('0:59.9');
  });

  it.each([60_000, 65_000])('rejects a late correct answer at %ims even before a delayed timer callback', milliseconds => {
    const { at, deck } = start({ mode: 'time', count: 1 });
    at(milliseconds);
    submit(cards[0].solution);
    expectTimedCounts(1, 0, 1);
    expect(text('card-time')).toBe('0:00');
    expect(text('total-time')).toBe('1:00.0');
    expectSolution(cards[0]);
    expect($('answer').disabled).toBe(true);
    expect($('next-card').hidden).toBe(false);
    expect(deck.next).toHaveBeenCalledTimes(1);
  });

  it('charges one minute for an early reveal and one minute for a timeout, each only once', () => {
    vi.useFakeTimers();
    const { at, deck } = start({ mode: 'time', count: 2 });
    at(4_567);
    $('show-answer').click();
    expectTimedCounts(1, 0, 2);
    expect(text('total-time')).toBe('1:00.0');
    expectSolution(cards[0]);
    $('show-answer').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    submit(cards[0].solution);
    expectTimedCounts(1, 0, 2);

    at(100_000);
    $('next-card').click();
    at(160_000);
    vi.advanceTimersByTime(250);
    expectTimedCounts(2, 0, 2);
    expect(text('total-time')).toBe('2:00.0');
    expect(text('card-time')).toBe('0:00');
    expectSolution(cards[1]);
    $('show-answer').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    submit(cards[1].solution);
    vi.advanceTimersByTime(5_000);
    expectTimedCounts(2, 0, 2);
    expect(text('total-time')).toBe('2:00.0');
    expect(deck.next).toHaveBeenCalledTimes(2);
  });

  it('sums card solve times and penalties without charging review time, then shows results after k cards', () => {
    vi.useFakeTimers();
    const { at, deck } = start({ mode: 'time', count: 3 });
    at(12_345);
    submit(cards[0].solution);
    expect(text('total-time')).toBe('0:12.3');
    expectTimedCounts(1, 1, 3);
    at(100_000);
    vi.advanceTimersByTime(5_000);
    expect(text('total-time')).toBe('0:12.3');
    expect(deck.next).toHaveBeenCalledTimes(1);

    $('next-card').click();
    expect(text('card-time')).toBe('1:00');
    at(102_999);
    vi.advanceTimersByTime(250);
    expect(text('total-time')).toBe('0:15.3');
    $('show-answer').click();
    expect(text('total-time')).toBe('1:12.3');
    expectTimedCounts(2, 1, 3);

    at(500_000);
    $('next-card').click();
    at(508_765);
    submit(cards[2].solution);
    expectTimedCounts(3, 2, 3);
    expect(text('total-time')).toBe('1:21.1');
    expect(text('next-card')).toContain('Results');
    expect($('results-screen').hidden).toBe(true);
    expect($('play-screen').hidden).toBe(false);
    expect($('answer').value).toBe(cards[2].solution);
    expect($('answer').disabled).toBe(true);

    at(900_000);
    $('next-card').click();
    expect($('play-screen').hidden).toBe(true);
    expect($('results-screen').hidden).toBe(false);
    expect(text('final-score')).toBe('1:21.1');
    expect(text('result-correct')).toBe('2 / 3 correct');
    expect(deck.next).toHaveBeenCalledTimes(3);
    $('play-again').click();
    expect($('results-screen').hidden).toBe(true);
    expect($('play-screen').hidden).toBe(false);
    expectTimedCounts(0, 0, 3);
    expect(text('total-time')).toBe('0:00.0');
    expect(text('card-time')).toBe('1:00');
    expect(deck.next).toHaveBeenCalledTimes(4);
  });

  it('keeps invalid and incorrect attempts active without resetting the deadline', () => {
    vi.useFakeTimers();
    const { at, deck } = start({ mode: 'time', count: 1 });
    at(20_000);
    submit('1 +');
    expectTimedCounts(0, 0, 1);
    expect($('answer').disabled).toBe(false);
    at(40_000);
    submit('1 + 2 + 3 + 4');
    expectTimedCounts(0, 0, 1);
    at(60_000);
    vi.advanceTimersByTime(250);
    expectTimedCounts(1, 0, 1);
    expect(text('total-time')).toBe('1:00.0');
    expectSolution(cards[0]);
    expect(deck.next).toHaveBeenCalledTimes(1);
  });

  it('continues counting while hidden and enforces the deadline when returning', () => {
    vi.useFakeTimers();
    let visibility = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => visibility === 'hidden');
    const { at } = start({ mode: 'time', count: 2 });
    at(10_000);
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    at(40_000);
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    submit(cards[0].solution);
    expectTimedCounts(1, 1, 2);
    expect(text('total-time')).toBe('0:40.0');

    $('next-card').click();
    at(45_000);
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    at(105_000);
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    submit(cards[1].solution);
    expectTimedCounts(2, 1, 2);
    expect(text('total-time')).toBe('1:40.0');
    expectSolution(cards[1]);
  });

  it('restarts the current mode on reset and stops all clocks on Menu and destroy', () => {
    vi.useFakeTimers();
    const storageWrites = vi.spyOn(Storage.prototype, 'setItem');
    const { at, deck } = start({ mode: 'time', count: 2 });
    at(10_000);
    submit(cards[0].solution);
    at(60_000);
    $('reset-session').click();
    expectTimedCounts(0, 0, 2);
    expect(text('total-time')).toBe('0:00.0');
    expect(text('card-time')).toBe('1:00');
    expect(deck.next).toHaveBeenCalledTimes(2);
    at(65_000);
    submit(cards[1].solution);
    expect(text('total-time')).toBe('0:05.0');
    $('next-card').click();
    $('back-to-menu').click();
    expect($('start-menu').hidden).toBe(false);
    expect($('play-screen').hidden).toBe(true);
    at(200_000);
    vi.advanceTimersByTime(1_000);
    expect(deck.next).toHaveBeenCalledTimes(3);

    begin({ mode: 'time', count: 1 });
    expectTimedCounts(0, 0, 1);
    expect(text('total-time')).toBe('0:00.0');
    $('show-answer').click();
    $('next-card').click();
    $('results-menu').click();
    expect($('start-menu').hidden).toBe(false);
    expect($('results-screen').hidden).toBe(true);
    begin({ mode: 'time', count: 1 });
    game.destroy();
    at(300_000);
    vi.advanceTimersByTime(1_000);
    expectTimedCounts(0, 0, 1);
    expect(text('total-time')).toBe('0:00.0');
    expect(text('card-time')).toBe('1:00');
    expect(storageWrites).not.toHaveBeenCalled();
  });
});
