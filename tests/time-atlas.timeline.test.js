import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTimeline,
  featuresAtCheckpoint,
} from '../fe-artifacts/assets/js/time-atlas-timeline.js';

function makeTimeline(overrides = {}) {
  document.body.innerHTML = `
    <label for="checkpoint">Historical decade checkpoint</label>
    <output id="label"></output>
    <input id="checkpoint" type="range" aria-label="Historical decade checkpoint" />
  `;
  const onChange = vi.fn();
  const timeline = createTimeline({
    checkpoints: [1850, 1900, 1950],
    initialCheckpoint: 1900,
    control: document.getElementById('checkpoint'),
    output: document.getElementById('label'),
    onChange,
    ...overrides,
  });
  return { timeline, onChange, control: document.getElementById('checkpoint') };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('Time Atlas timeline', () => {
  it('boots at the configured initial checkpoint and labels the control', () => {
    const { timeline, control } = makeTimeline();

    expect(timeline.getCheckpoint()).toBe(1900);
    expect(control.value).toBe('1');
    expect(control.getAttribute('aria-valuetext')).toBe('1900s');
    expect(document.querySelector('label').textContent).toContain('Historical decade');
    expect(control.getAttribute('aria-label')).toBe('Historical decade checkpoint');
  });

  it('selects only explicitly configured checkpoints', () => {
    const { timeline, onChange } = makeTimeline();

    expect(timeline.select(1910)).toBe(false);
    expect(timeline.getCheckpoint()).toBe(1900);
    expect(onChange).not.toHaveBeenCalled();
    expect(timeline.select(1950)).toBe(true);
    expect(onChange).toHaveBeenCalledWith(1950);
  });

  it('moves by configured checkpoints with keyboard controls', () => {
    const { timeline, control } = makeTimeline();

    control.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(timeline.getCheckpoint()).toBe(1950);
    control.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(timeline.getCheckpoint()).toBe(1850);
    control.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(timeline.getCheckpoint()).toBe(1850);
  });

  it('uses start-inclusive and end-exclusive feature visibility', () => {
    const collection = {
      type: 'FeatureCollection',
      features: [
        { id: 'starts-now', properties: { start_year: 1900, end_year: null } },
        { id: 'ended-now', properties: { start_year: 1850, end_year: 1900 } },
        { id: 'spans-now', properties: { start_year: 1899, end_year: 1901 } },
        { id: 'starts-later', properties: { start_year: 1901, end_year: null } },
      ],
    };

    expect(featuresAtCheckpoint(collection, 1900).features.map((feature) => feature.id))
      .toEqual(['starts-now', 'spans-now']);
  });
});
