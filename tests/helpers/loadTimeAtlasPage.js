import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PAGE_PATH = resolve(here, '../../fe-artifacts/tools/time-atlas.html');

export function loadTimeAtlasPage() {
  const html = readFileSync(PAGE_PATH, 'utf8');
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  parsed.querySelectorAll('script').forEach((script) => script.remove());
  document.body.className = parsed.body.className;
  document.body.innerHTML = parsed.body.innerHTML;
  return document.getElementById('timeAtlas');
}
