import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');

describe('Time Atlas public placement', () => {
  it('lists Time Atlas as a tool and never as a game', () => {
    const tools = read('fe-artifacts/tools/index.html');
    const games = read('fe-artifacts/games/index.html');
    const manifest = read('fe-artifacts/assets/js/manifest.js');

    expect(tools).toContain('href="/tools/time-atlas.html"');
    expect(tools).toContain('Time Atlas');
    expect(games).not.toContain('Time Atlas');
    expect(manifest).not.toContain('time-atlas');
  });

  it('keeps the page static with root-relative local assets', () => {
    const page = read('fe-artifacts/tools/time-atlas.html');
    const map = read('fe-artifacts/assets/js/time-atlas-map.js');

    expect(page).toContain('href="/assets/site.css?v=3"');
    expect(page).toContain('href="/assets/css/time-atlas.css"');
    expect(page).toContain("from '/assets/js/time-atlas.js'");
    expect(page).not.toContain('/src/');
    expect(map).toContain('https://basemaps.cartocdn.com/gl/positron-gl-style/style.json');
    expect(map).toContain('attributionControl: true');
  });

  it('exposes responsive panel and feature-detail semantics', () => {
    const page = read('fe-artifacts/tools/time-atlas.html');
    const styles = read('fe-artifacts/assets/css/time-atlas.css');

    expect(page).toContain('aria-controls="atlasLayerPanelBody"');
    expect(page).toContain('aria-expanded="true"');
    expect(page).toContain('<label for="atlasFeaturePicker">Explore feature details</label>');
    expect(page).toContain('id="atlasHoverDetails"');
    expect(page).toContain('tabindex="-1"');
    expect(styles).toContain('@media (max-width: 640px)');
    expect(styles).toContain('min-height: 44px');
  });
});
