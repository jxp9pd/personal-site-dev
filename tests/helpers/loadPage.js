// Mounts the real neighborhoods-quiz page markup into jsdom without running the
// page's own <script> tags, so a test controls when boot happens. There is one
// source of truth for the DOM: fe-artifacts/games/neighborhoods-quiz.html.
//
// Two script tags in that page must NOT execute under test:
//   1. the Leaflet CDN <script> (network + real map geometry) — tests set
//      globalThis.L to a geometry-free fake instead;
//   2. the inline module that calls start() — the test calls start() itself.
// jsdom does not fetch/run external classic scripts by default, and we strip the
// bootstrap tag's contents here, so nothing auto-runs on mount.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const PAGE_PATH = resolve(here, '../../fe-artifacts/games/neighborhoods-quiz.html');

// Parses the real page in an inert document, then imports only its <body> into
// the live jsdom document. Script tags are dropped so the test drives boot.
export function loadPage() {
  const html = readFileSync(PAGE_PATH, 'utf8');
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  parsed.querySelectorAll('script').forEach(s => s.remove());
  document.body.innerHTML = parsed.body.innerHTML;
  return document.body;
}
