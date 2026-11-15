import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { mountSampler, sampleShots } from '../fe-artifacts/assets/js/range-practice.js';

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

it('respects bucket frequencies after removing short shots, without weighting by bucket width', () => {
  let draw = 0;
  const samples = Array.from({ length: 95 }, (_, index) => sampleShots(1, () => (
    draw++ % 2 === 0 ? (index + 0.5) / 95 : 0.5
  ))[0]);
  const counts = [75, 100, 125, 150, 175, 200, 250].map((max, index, ends) => (
    samples.filter(value => value <= max && value > (ends[index - 1] ?? 49)).length
  ));
  expect(counts).toEqual([12, 12, 12, 12, 11, 8, 28]);
});

it('includes the limits of every distance bucket and allows repeated independent draws', () => {
  const cases = [
    [0, 50, 75], [3, 76, 100], [6, 101, 125], [9, 126, 150],
    [12, 151, 175], [14.75, 176, 200], [16.75, 201, 250],
  ];
  for (const [offset, min, max] of cases) {
    for (const [within, expected] of [[0, min], [0.999999, max]]) {
      let draw = 0;
      expect(sampleShots(2, () => draw++ % 2 === 0 ? (offset + 0.01) / 23.75 : within))
        .toEqual([expected, expected]);
    }
  }
});

it('rejects invalid counts before sampling', () => {
  const random = vi.fn();
  for (const count of [0, -1, 201, 1.5, NaN, Infinity, '10']) {
    expect(() => sampleShots(count, random)).toThrow(RangeError);
  }
  expect(random).not.toHaveBeenCalled();
});

it('generates on load, replaces the list on submission, and preserves it for invalid input', () => {
  document.body.innerHTML = readFileSync('site/pages/tools/range-practice.html', 'utf8');
  vi.spyOn(Math, 'random').mockReturnValue(0);
  mountSampler();
  const form = document.querySelector('#range-form');
  const input = document.querySelector('#shot-count');
  const list = document.querySelector('#shot-list');
  expect(list.children).toHaveLength(10);
  input.value = '1';
  form.requestSubmit();
  expect(list.children).toHaveLength(1);
  expect(list.textContent).toContain('50');
  expect(document.querySelector('#range-status').textContent).toBe('1 shot · 50–250 yards');
  for (const value of ['', '0', '201', '1.5']) {
    input.value = value;
    form.requestSubmit();
    expect(list.children).toHaveLength(1);
  }
  input.value = '200';
  form.requestSubmit();
  expect(list.children).toHaveLength(200);
});
