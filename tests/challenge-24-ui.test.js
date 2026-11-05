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

function start() {
  const parsed = new DOMParser().parseFromString(page, 'text/html');
  parsed.querySelectorAll('script').forEach(script => script.remove());
  document.body.innerHTML = parsed.body.innerHTML;
  let time = 0;
  let index = 0;
  const deck = { next: vi.fn(() => structuredClone(cards[index++ % cards.length])) };
  game = mountGame({ root: document, deck, now: () => time });
  return { deck, at: milliseconds => { time = milliseconds; } };
}

function submit(expression) {
  $('answer').value = expression;
  $('answer-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

function expectCounts(played, correct) {
  expect(text('played-count')).toBe(String(played));
  expect(text('correct-count')).toBe(String(correct));
}

afterEach(() => {
  game?.destroy();
  game = undefined;
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('Challenge 24 session', () => {
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
