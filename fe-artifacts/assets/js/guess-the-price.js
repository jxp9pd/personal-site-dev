// Bootstrap for the Guess the Price page.
//
// Two screens live in one page: the pack selector (#select) and an in-progress
// game (#play). Inside #play three stages swap: guessing → reveal → summary.
// The profile/login header is mounted on whichever screen is shown so a visitor
// can always reach their profile.
//
// Routing is by `?pack=<slug>`: a known pack plays it; anything else (no slug,
// unknown slug, or a load error) falls back to the pack selector.

import { Profiles } from './profiles.js';
import { fetchPackList, fetchPack } from './dataClient.js';
import { errorPct, scorePoints, aggregateRound } from './guess-the-price-scoring.js';

const el = id => document.getElementById(id);

// Seconds allowed per item; the timer bar tracks secondsLeft / ROUND_SECONDS.
const ROUND_SECONDS = 20;
// Below this relative error the "off by" figure reads as good rather than warn.
const OFF_GOOD = 0.15;

function currentSlug() {
  return new URLSearchParams(location.search).get('pack');
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatPrice(n) {
  return `$${Number(n).toFixed(2)}`;
}

function shuffle(a) {
  const out = a.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export async function start() {
  const slug = currentSlug();
  if (slug) {
    let pack = null;
    try { pack = await fetchPack(slug); }
    catch (err) { console.error('Failed to load pack', err); }
    if (pack && pack.items.length) { boot(pack); return; }
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

function boot(pack) {
  document.title = `Guess the Price · ${pack.name}`;
  el('play').style.display = 'flex';

  // Auth/profile layer runs independently of the game: an init failure must
  // never stop the game from starting or being played.
  Profiles.init({ gameSlug: 'guess-the-price', headerMount: el('playProfileMount') })
    .catch(err => console.error('Profiles init failed', err));

  const guessInput = el('guessInput');
  const lockIn = el('lockIn');
  const revealNext = el('revealNext');

  // ---- round state ----
  let phase = 'guessing'; // 'guessing' | 'reveal' | 'summary'
  let roundItems = [];
  let currentIndex = 0;
  let secondsLeft = ROUND_SECONDS;
  let results = []; // { name, guess, actual, errorPct, points }
  let timerId = null;

  function stopTimer() {
    if (timerId != null) { clearInterval(timerId); timerId = null; }
  }

  function renderTimer() {
    el('countdown').textContent = String(secondsLeft);
    el('countdown').classList.toggle('low', secondsLeft <= 5);
    el('timerFill').style.width = `${Math.max(0, (secondsLeft / ROUND_SECONDS) * 100)}%`;
  }

  function startTimer() {
    stopTimer();
    secondsLeft = ROUND_SECONDS;
    renderTimer();
    timerId = setInterval(() => {
      secondsLeft -= 1;
      renderTimer();
      // At 0 the item auto-ends with whatever (possibly empty) guess is typed.
      if (secondsLeft <= 0) endItem();
    }, 1000);
  }

  function showStage(which) {
    el('guessStage').hidden = which !== 'guessing';
    el('revealStage').hidden = which !== 'reveal';
    el('summaryStage').hidden = which !== 'summary';
  }

  function renderImage(item) {
    if (item.imageUrl) {
      el('imageFrame').innerHTML =
        `<img src="${esc(item.imageUrl)}" alt="${esc(item.name)}" />`;
    } else {
      el('imageFrame').innerHTML = '<span class="chip">No image</span>';
    }
  }

  function showItem() {
    phase = 'guessing';
    const item = roundItems[currentIndex];
    el('playEyebrow').textContent =
      `${pack.name.toUpperCase()} · ITEM ${currentIndex + 1} / ${roundItems.length}`;
    el('productName').textContent = item.name;
    renderImage(item);
    guessInput.value = '';
    showStage('guessing');
    startTimer();
    guessInput.focus();
  }

  function endItem() {
    if (phase !== 'guessing') return;
    stopTimer();
    const item = roundItems[currentIndex];
    const raw = guessInput.value.trim();
    results.push({
      name: item.name,
      guess: raw === '' ? null : Number(raw),
      actual: item.price,
      errorPct: errorPct(raw, item.price),
      points: scorePoints(raw, item.price),
    });
    showReveal();
  }

  function showReveal() {
    phase = 'reveal';
    const r = results[results.length - 1];
    el('revealActual').textContent = formatPrice(r.actual);
    el('revealGuess').textContent = r.guess == null ? '—' : formatPrice(r.guess);
    if (r.guess == null) {
      el('revealOff').textContent = '—';
      el('revealOff').className = 'v warn';
    } else {
      el('revealOff').textContent = `${Math.round(r.errorPct * 100)}%`;
      el('revealOff').className = r.errorPct <= OFF_GOOD ? 'v good' : 'v warn';
    }
    el('revealPoints').textContent = `+${r.points}`;
    el('revealPointsFill').style.width = `${(r.points / 1000) * 100}%`;
    const isLast = currentIndex >= roundItems.length - 1;
    el('revealNext').textContent = isLast ? 'See results →' : 'Next →';
    showStage('reveal');
  }

  function advance() {
    if (currentIndex >= roundItems.length - 1) { enterSummary(); return; }
    currentIndex += 1;
    showItem();
  }

  // Summary screen (3C) + persistence land in T6; for now route into the phase
  // and show the running total so the last item doesn't dead-end.
  function enterSummary() {
    phase = 'summary';
    const { totalPoints, maxPoints } = aggregateRound(results);
    el('summaryTotal').textContent = String(totalPoints);
    el('summaryOutOf').textContent = `out of ${maxPoints} points`;
    showStage('summary');
  }

  function startRound() {
    stopTimer();
    roundItems = shuffle(pack.items);
    currentIndex = 0;
    results = [];
    showItem();
  }

  guessInput.addEventListener('input', () => {
    // Numeric only: digits plus a single decimal point.
    let v = guessInput.value.replace(/[^0-9.]/g, '');
    const dot = v.indexOf('.');
    if (dot !== -1) v = v.slice(0, dot + 1) + v.slice(dot + 1).replace(/\./g, '');
    guessInput.value = v;
  });
  guessInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); endItem(); }
  });
  lockIn.addEventListener('click', () => endItem());
  revealNext.addEventListener('click', () => advance());

  startRound();
}
