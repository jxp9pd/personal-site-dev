// Bootstrap for the Guess the Price page.
//
// Two screens live in one page: the pack selector (#select) and an in-progress
// game (#play). The profile/login header is mounted on whichever screen is
// shown so a visitor can always reach their profile.
//
// Routing is by `?pack=<slug>`: a known pack plays it; anything else (no slug,
// unknown slug, or a load error) falls back to the pack selector.

import { Profiles } from './profiles.js';
import { fetchPackList } from './dataClient.js';

const el = id => document.getElementById(id);

function currentSlug() {
  return new URLSearchParams(location.search).get('pack');
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export async function start() {
  const slug = currentSlug();
  if (slug) {
    // Playing path is a stub until T5 wires fetchPack + boot; show the play
    // shell so a `?pack=` link doesn't dead-end on the selector.
    el('play').style.display = 'flex';
    Profiles.init({ gameSlug: 'guess-the-price', headerMount: el('playProfileMount') })
      .catch(err => console.error('Profiles init failed', err));
    return;
  }
  await renderSelect();
}

async function renderSelect() {
  // Profile/login access must be reachable from the selector too. Auth init is
  // independent of the pack-list fetch, so mount it first and let it fail on
  // its own if it must.
  Profiles.init({ headerMount: el('selectProfileMount') })
    .catch(err => console.error('Profiles init failed', err));

  const grid = el('packGrid');
  el('select').style.display = 'flex';
  grid.innerHTML = '<p class="select-msg">Loading packs…</p>';
  let packs;
  try {
    packs = await fetchPackList();
  } catch (err) {
    console.error('Failed to load pack list', err);
    grid.innerHTML = '<p class="select-msg">Couldn’t load the packs. Please refresh.</p>';
    return;
  }
  if (!packs.length) {
    grid.innerHTML = '<p class="select-msg">No packs available yet.</p>';
    return;
  }
  // `artSvg` is admin-only content (service-role upload, no client writes), so
  // it is inlined as markup. Name/description still go through esc().
  grid.innerHTML = packs.map(p => `
    <a class="pack-card" href="?pack=${encodeURIComponent(p.slug)}">
      ${p.artSvg ? `<span class="art" aria-hidden="true">${p.artSvg}</span>` : ''}
      <span class="pack-body">
        <span class="name">${esc(p.name)}</span>
        ${p.description ? `<span class="desc">${esc(p.description)}</span>` : ''}
      </span>
    </a>`).join('');
}
