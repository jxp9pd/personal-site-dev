import { describe, expect, it } from 'vitest';
import { createDeck, evaluateAnswer, solve } from '../fe-artifacts/assets/js/challenge-24-engine.js';

describe('Challenge 24 answers', () => {
  it.each([
    ['1 + 2 + 3 * 7', [1, 2, 3, 7]],
    ['(1+2+3)×4 = 24', [1, 2, 3, 4]],
    ['(1+2+3) x 4', [1, 2, 3, 4]],
    ['(1+2+3) X 4', [1, 2, 3, 4]],
    ['8 ÷ (3 − 8 ÷ 3)', [3, 3, 8, 8]],
    ['(1–7)*(2—6)', [1, 2, 6, 7]],
    ['6/(1-3/4)', [1, 3, 4, 6]],
    ['8/2*6*1', [1, 2, 6, 8]],
  ])('accepts exact arithmetic: %s', (expression, numbers) => {
    expect(evaluateAnswer(expression, numbers)).toEqual({ correct: true });
  });

  it.each([
    ['3*8', [3, 3, 8, 8]],
    ['6+6+6+6', [1, 2, 3, 6]],
    ['8/(3-8/2)', [3, 3, 8, 8]],
    ['12+8+3+1', [1, 2, 3, 8]],
    ['+1+2+3+4', [1, 2, 3, 4]],
    ['1+2+3--4', [1, 2, 3, 4]],
    ['(1+2)(3+4)', [1, 2, 3, 4]],
    ['1 2+3+4', [1, 2, 3, 4]],
    ['1+2+3+4)', [1, 2, 3, 4]],
    ['(1+2+3+4', [1, 2, 3, 4]],
    ['1+2+3+', [1, 2, 3, 4]],
    ['1+2+3+()', [1, 2, 3, 4]],
    ['1+2+3+4=25', [1, 2, 3, 4]],
    ['1+2+3+4=24=24', [1, 2, 3, 4]],
    ['4!+1-2+3', [1, 2, 3, 4]],
    ['4**3+2+1', [1, 2, 3, 4]],
    ['4^3+2+1', [1, 2, 3, 4]],
    ['1.0+2+3+4', [1, 2, 3, 4]],
    ['alert(24)', [1, 2, 3, 4]],
    ['globalThis.pwned=24', [1, 2, 3, 4]],
  ])('rejects rule violations and malformed syntax: %s', (expression, numbers) => {
    expect(evaluateAnswer(expression, numbers)).toMatchObject({
      correct: false, error: expect.any(String),
    });
  });

  it('distinguishes an incorrect value, missing occurrences, and division by zero', () => {
    expect(evaluateAnswer('1+2+3+4', [1, 2, 3, 4])).toEqual({
      correct: false, error: 'Not 24. Try again.',
    });
    expect(evaluateAnswer('1+2+3', [1, 2, 3, 4]).error).toMatch(/exactly once/);
    expect(evaluateAnswer('8/(3-3)+8', [3, 3, 8, 8]).error).toMatch(/Division by zero/);
  });

  it('bounds input length and parenthesis depth', () => {
    expect(evaluateAnswer(' '.repeat(160) + '1', [1, 2, 3, 4]).error).toMatch(/160/);
    expect(evaluateAnswer('('.repeat(17) + '1+2+3+4' + ')'.repeat(17), [1, 2, 3, 4]).error)
      .toMatch(/nested parentheses/);
    expect(evaluateAnswer('('.repeat(16) + '1*2*3*4' + ')'.repeat(16), [1, 2, 3, 4]).correct)
      .toBe(true);
  });

  it('handles empty expressions and invalid puzzle data', () => {
    for (const expression of ['', '  ', undefined, null]) {
      expect(evaluateAnswer(expression, [1, 2, 3, 4]).correct).toBe(false);
    }
    for (const numbers of [null, [], [1, 2, 3], [0, 2, 3, 4], [1, 2, 3, 10], [1, 2, 3, 4.5], Array(4)]) {
      expect(evaluateAnswer('(1+2+3)*4', numbers).correct).toBe(false);
      expect(solve(numbers)).toBeNull();
    }
  });
});

describe('Challenge 24 solutions and decks', () => {
  it('finds order-independent solutions, including required fractional intermediates', () => {
    const fractional = solve([3, 8, 3, 8]);
    expect(fractional.difficulty).toBe(3);
    expect(evaluateAnswer(fractional.expression, [3, 3, 8, 8])).toEqual({ correct: true });
    expect(solve([8, 8, 3, 3])).toEqual(fractional);
    expect(solve([1, 1, 1, 1])).toBeNull();
  });

  it('deals every solvable multiset once, verifies every solution, then refreshes', () => {
    const deck = createDeck({ random: () => 0.37 });
    const seen = new Set();
    const tiers = new Set();
    for (let index = 0; index < 404; index += 1) {
      const card = deck.next();
      const key = card.numbers.slice().sort().join('');
      expect(seen.has(key)).toBe(false);
      expect(evaluateAnswer(card.solution, card.numbers)).toEqual({ correct: true });
      expect(solve(card.numbers)).toEqual({ expression: card.solution, difficulty: card.difficulty });
      expect(card.numbers.every(number => number >= 1 && number <= 9)).toBe(true);
      seen.add(key);
      tiers.add(card.difficulty);
    }
    expect([...tiers].sort()).toEqual([1, 2, 3]);
    expect(seen.has(deck.next().numbers.slice().sort().join(''))).toBe(true);
  });

  it('returns independent puzzle data and respects its random source', () => {
    const first = createDeck({ random: () => 0.5 });
    const second = createDeck({ random: () => 0.5 });
    expect(first.next()).toEqual(second.next());
    const card = first.next();
    const pristine = second.next();
    expect(card).toEqual(pristine);
    const solution = solve(pristine.numbers);
    card.numbers.fill(0);
    solution.expression = 'broken';
    expect(solve(pristine.numbers).expression).toBe(pristine.solution);
    const fresh = createDeck({ random: () => 0.5 });
    fresh.next();
    expect(fresh.next()).toEqual(pristine);
  });
});
