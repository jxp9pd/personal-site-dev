import { describe, expect, it } from 'vitest';
import { findPageIssues, findStyleIssues } from '../scripts/check-styles.mjs';

describe('style guard', () => {
  it('flags hard-coded colors and document resets in page CSS', () => {
    const issues = findStyleIssues('fe-artifacts/assets/css/demo.css', `
      /* #ffffff in a comment is fine */
      html, body { margin: 0; }
      .card { color: #123456; background: rgba(0, 0, 0, .1); }
      body.demo-page .card { color: var(--ink); }
    `);
    expect(issues).toEqual([
      'fe-artifacts/assets/css/demo.css: 2 hard-coded color(s); use theme tokens',
      'fe-artifacts/assets/css/demo.css: restyles html, body; base.css owns document styles',
    ]);
  });

  it('allows shared layers and tokenized page CSS', () => {
    expect(findStyleIssues('fe-artifacts/assets/base.css', 'body { color: #000; }')).toEqual([]);
    expect(findStyleIssues('fe-artifacts/assets/css/demo.css', '.demo { color: var(--accent); }')).toEqual([]);
  });

  it('requires pages to use the shared bundle, a layout, and the site title', () => {
    expect(findPageIssues([
      { output: 'tools/ok.html', title: 'Ok — Penta Projects', assets: 'site', layout: 'default' },
      { output: 'tools/hub.html', title: 'Hub', assets: 'hub', styleException: 'Dark board theme.' },
      { output: 'tools/bad.html', title: 'Bad', assets: 'calculator', inlineStyles: 'styles/bad.css' },
    ])).toEqual([
      'tools/bad.html: uses "calculator" assets; pages share the "site" bundle',
      'tools/bad.html: layout must be one of narrow, default, wide, app',
      'tools/bad.html: inlineStyles; move page CSS to a stylesheet in "styles"',
      'tools/bad.html: title should end with " — Penta Projects"',
    ]);
  });
});
