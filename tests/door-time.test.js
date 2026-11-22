import { describe, expect, it } from 'vitest';
import { formatPacific, fromPacificInput, toPacificInput } from '../fe-artifacts/assets/js/door-time.js';

describe('door Pacific time helpers', () => {
  it('reads datetime inputs as Pacific time across daylight saving', () => {
    expect(fromPacificInput('2026-11-22T15:00').toISOString()).toBe('2026-11-22T23:00:00.000Z');
    expect(fromPacificInput('2026-07-04T09:30').toISOString()).toBe('2026-07-04T16:30:00.000Z');
    expect(fromPacificInput('2026-11-22')).toBeNull();
    expect(fromPacificInput('2027-03-14T02:30')).toBeNull();
    expect(fromPacificInput('2027-03-14T03:00').toISOString()).toBe('2027-03-14T10:00:00.000Z');
    expect(fromPacificInput('2026-11-01T01:30').toISOString()).toBe('2026-11-01T08:30:00.000Z');
  });

  it('round-trips instants to Pacific inputs', () => {
    expect(toPacificInput(new Date('2026-11-22T23:00:00Z'))).toBe('2026-11-22T15:00');
    expect(toPacificInput(new Date('2026-07-04T16:30:00Z'))).toBe('2026-07-04T09:30');
  });

  it('formats with the Pacific zone name', () => {
    expect(formatPacific('2026-11-22T23:00:00Z')).toBe('Nov 22, 3:00 PM PST');
  });
});
