import { describe, expect, it } from 'vitest';
import { layoutMessage } from '../fe-artifacts/assets/js/vestaboard-layout.js';

describe('Vestaboard Note layouts', () => {
  it('centers a note and encodes the exact 3 × 15 display', () => {
    const result = layoutMessage('Hello');
    expect(result.error).toBeNull();
    expect(result.characters).toEqual([
      Array(15).fill(0),
      [0, 0, 0, 0, 0, 8, 5, 12, 12, 15, 0, 0, 0, 0, 0],
      Array(15).fill(0),
    ]);
  });
  it('wraps words, preserves explicit newlines, and splits long words without data loss', () => {
    expect(layoutMessage('Hello from the internet').lines).toBe(2);
    expect(layoutMessage('A\n\nB').lines).toBe(3);
    const exact = layoutMessage('A'.repeat(45));
    expect(exact.error).toBeNull();
    expect(exact.characters.flat()).toEqual(Array(45).fill(1));
    expect(layoutMessage('A'.repeat(46)).error).toContain('4 rows');
    expect(layoutMessage('A\nB\nC\nD').error).toContain('4 rows');
  });
  it('rejects unsupported symbols and blank notes instead of silently losing characters', () => {
    expect(layoutMessage('Hello 😊').error).toContain('😊');
    expect(layoutMessage(' \n ').error).toBeTruthy();
    expect(layoutMessage('A_B').error).toContain('_');
  });
  it('maps Note hearts, color squares, smart punctuation, and zero correctly', () => {
    const result = layoutMessage('“0” ❤️🟦');
    expect(result.error).toBeNull();
    expect(result.characters[1].filter(Boolean)).toEqual([53, 36, 53, 62, 67]);
    expect(layoutMessage('🟦'.repeat(45)).error).toBeNull();
    expect(layoutMessage('🟦'.repeat(46)).error).toBeTruthy();
  });
});
