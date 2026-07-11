// Bootstrap for the neighborhoods quiz page. Extracted from an inline script so
// the city-select flow can be unit-tested with the data + auth layers mocked.
//
// Two screens live in one page: the city selector (#select) and an in-progress
// game (#app). The profile/login header is mounted on whichever screen is shown
// so a visitor can always reach their profile — see renderSelect + boot.

import { Profiles } from './profiles.js';
import { fetchQuiz, fetchQuizList } from './dataClient.js';

const el = id => document.getElementById(id);

function currentSlug() {
  return new URLSearchParams(location.search).get('city');
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// A `?city=<slug>` that resolves to a quiz plays it; anything else (no slug, an
// unknown slug, or a load error) falls back to the city selector.
export async function start() {
  const slug = currentSlug();
  if (slug) {
    let quiz = null;
    try { quiz = await fetchQuiz(slug); }
    catch (err) { console.error('Failed to load quiz', err); }
    if (quiz) { boot(quiz); return; }
  }
  await renderSelect();
}

async function renderSelect() {
  // Profile/login access must be reachable from the selector too, not only from
  // inside a running game. Auth init is independent of the (network) quiz list
  // fetch below, so mount it first and let it fail on its own if it must.
  Profiles.init({ headerMount: el('selectProfileMount') })
    .catch(err => console.error('Profiles init failed', err));

  const grid = el('cityGrid');
  el('select').style.display = 'flex';
  grid.innerHTML = '<p class="select-msg">Loading cities…</p>';
  let quizzes;
  try {
    quizzes = await fetchQuizList();
  } catch (err) {
    console.error('Failed to load quiz list', err);
    grid.innerHTML = '<p class="select-msg">Couldn’t load the quizzes. Please refresh.</p>';
    return;
  }
  if (!quizzes.length) {
    grid.innerHTML = '<p class="select-msg">No quizzes available yet.</p>';
    return;
  }
  grid.innerHTML = quizzes.map(q => `
    <a class="city-card" href="?city=${encodeURIComponent(q.slug)}">
      <span class="name">${esc(q.name)}</span>
      <span class="desc">${esc(q.description)}</span>
      <span class="go">Play &rarr;</span>
    </a>`).join('');
}

function boot(quiz) {
  const gameId = quiz.slug;
  document.title = `${quiz.name} Neighborhoods Quiz`;
  el('title').textContent = `${quiz.name} Neighborhoods`;
  el('app').style.display = 'flex';

  // Auth/profile layer runs independently of the game bootstrap: an init failure
  // (e.g. network) must never stop the quiz from starting or being played.
  Profiles.init({ gameSlug: gameId, headerMount: el('profileMount') })
    .catch(err => console.error('Profiles init failed', err));

  const GEO = quiz.geo;
  const HOOD_NAMES = GEO.features.map(f => f.properties.name).sort();
  const CENTER = quiz.center, ZOOM = quiz.zoom;

  // single source of truth for semantic colors: the CSS :root tokens
  const cssVar = (() => { const s = getComputedStyle(document.documentElement); return n => s.getPropertyValue(n).trim(); })();
  const C = {
    accent: cssVar('--accent'), accentFill: cssVar('--accent-fill'),
    good: cssVar('--good'), goodFill: cssVar('--good-fill'),
    bad: cssVar('--bad'), badFill: cssVar('--bad-fill'),
    warn: cssVar('--warn'), warnFill: cssVar('--warn-fill'),
    idle: cssVar('--idle'), idleLine: cssVar('--idle-line')
  };

  const map = L.map('map', { zoomControl: true, attributionControl: false }).setView(CENTER, ZOOM);
  L.tileLayer('https://cartodb-basemaps-{s}.global.ssl.fastly.net/dark_nolabels/{z}/{x}/{y}{r}.png',
    { maxZoom: 19, subdomains: 'abcd' }).addTo(map);

  const base = { color: C.idleLine, weight: 1, fillColor: C.idle, fillOpacity: .28 };
  const hover = { color: C.accent, weight: 1.5, fillColor: C.accentFill, fillOpacity: .7 };
  const styleOk = l => l.setStyle({ color: C.good, weight: 1.5, fillColor: C.goodFill, fillOpacity: .8 });
  const styleWrong = l => l.setStyle({ color: C.bad, weight: 1.5, fillColor: C.badFill, fillOpacity: .7 });
  const styleIdle = l => l.setStyle(base);
  const emphasize = l => l.setStyle({ color: C.accent, weight: 2, fillColor: C.accentFill, fillOpacity: .75 });

  const hoodByName = {};
  const hoodLayer = L.geoJSON(GEO, {
    style: () => base,
    onEachFeature: (f, l) => {
      hoodByName[f.properties.name] = l;
      l.on('click', () => onClick(f.properties.name, l));
      l.on('mouseover', () => {
        if (mode === 'learn') { revealHover(f.properties.name, l); }
        else if (!l._locked) l.setStyle(hover);
      });
      l.on('mouseout', () => { if (mode !== 'learn' && !l._locked) l.setStyle(base); });
    }
  }).addTo(map);
  function hoodReset() { hoodLayer.eachLayer(l => { l._locked = false; l._revealed = false; l.unbindTooltip(); l.setStyle(base); }); }

  // once a hood has been clicked, hovering shows its name
  function revealName(l, name) { l._revealed = true; l.bindTooltip(name, { className: 'answer-tip', direction: 'top' }); }

  // ---- state ----
  let mode = 'find', queue = [], current = null,
    correct = 0, answered = 0, choiceWrap = null;
  function shuffle(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0;[a[i], a[j]] = [a[j], a[i]]; } return a; }
  function clearChoices() { if (choiceWrap) { choiceWrap.remove(); choiceWrap = null; } }

  function setMode(m) {
    mode = m;
    document.querySelectorAll('#modeTabs button').forEach(b => b.classList.toggle('active', b.dataset.mode === m));
    startRound();
  }

  function startRound() {
    hoodReset();
    correct = 0; answered = 0; current = null;
    el('done').style.display = 'none';
    el('pFb').textContent = ''; el('pFb').className = 'fb';
    clearChoices();
    if (mode === 'learn') {
      el('prompt').style.display = 'none';
      el('stat').textContent = 'Hover a neighborhood to reveal its name · ' + HOOD_NAMES.length + ' total';
      map.setView(CENTER, ZOOM);
      return;
    }
    el('prompt').style.display = 'block';
    queue = shuffle(HOOD_NAMES);
    el('pLabel').textContent = mode === 'find' ? 'Find on the map' : 'Name this neighborhood';
    next();
  }

  function next() {
    el('pFb').textContent = ''; el('pFb').className = 'fb';
    clearChoices();
    if (queue.length === 0) { return finish(); }
    current = queue.shift();
    updateStat();
    if (mode === 'find') {
      el('pTarget').textContent = current;
    } else { // name
      hoodLayer.eachLayer(l => { l._locked = false; styleIdle(l); });
      const l = hoodByName[current];
      l._locked = true;
      emphasize(l);
      el('pTarget').textContent = '???';
      map.fitBounds(l.getBounds(), { padding: [60, 60], maxZoom: 14 });
      buildChoices();
    }
  }

  function updateStat() {
    const total = HOOD_NAMES.length;
    el('stat').innerHTML = `<b>${correct}</b>/${total} correct · ${queue.length} left · accuracy <b>${answered ? Math.round(correct / answered * 100) : 100}%</b>`;
  }

  // FIND: one click per prompt, then move on
  function onClick(name, l) {
    if (mode !== 'find' || !current) return;
    answered++;
    if (name === current) {
      correct++;
      l._locked = true; revealName(l, name); styleOk(l);
      el('pFb').textContent = 'Correct'; el('pFb').className = 'fb good';
    } else {
      // Leave the wrong pick untouched (no reveal, no red, not locked) so its
      // own clue is still a genuine challenge when it comes back around later.
      el('pFb').textContent = 'Incorrect'; el('pFb').className = 'fb bad';
    }
    updateStat();
    setTimeout(next, 700);
  }

  // NAME: multiple choice
  function buildChoices() {
    clearChoices();
    const pool = shuffle(HOOD_NAMES.filter(n => n !== current)).slice(0, 3);
    const opts = shuffle(pool.concat(current));
    choiceWrap = document.createElement('div');
    choiceWrap.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:8px';
    opts.forEach(o => {
      const b = document.createElement('button');
      b.className = 'btn'; b.textContent = o; b.style.fontSize = '12px';
      b.onclick = () => chooseName(o, b);
      choiceWrap.appendChild(b);
    });
    el('prompt').appendChild(choiceWrap);
  }
  function chooseName(o, b) {
    answered++;
    if (o === current) {
      correct++;
      b.style.background = C.goodFill; b.style.borderColor = C.good;
      el('pFb').textContent = 'Correct'; el('pFb').className = 'fb good';
    } else {
      b.style.background = C.badFill; b.style.borderColor = C.bad;
      el('pFb').textContent = 'Nope — ' + current; el('pFb').className = 'fb bad';
      [...choiceWrap.children].forEach(c => { if (c.textContent === current) { c.style.background = C.goodFill; c.style.borderColor = C.good; } });
    }
    el('pTarget').textContent = current;
    [...choiceWrap.children].forEach(c => c.disabled = true);
    updateStat();
    setTimeout(() => { clearChoices(); next(); }, 700);
  }

  // LEARN: hover reveals name
  function revealHover(name, l) {
    emphasize(l);
    l.bindTooltip(name, { className: 'answer-tip', permanent: false, direction: 'top' }).openTooltip();
    l.on('mouseout', () => { styleIdle(l); }, { once: true });
  }

  // Persists the just-finished play and reflects the ACTUAL outcome: "Saved to
  // your profile" appears only once the row truly lands. A failed write shows a
  // retry affordance instead of a false success, and the recorder keeps the play
  // so the retry (or a later auth event) can still flush it.
  async function saveResult() {
    const nudge = el('saveNudge'), note = el('savedNote'), error = el('saveError');
    nudge.hidden = true; error.hidden = true;
    note.hidden = false; note.textContent = 'Saving…';

    let outcome;
    try {
      outcome = await Profiles.recordPlay({ gameId, mode, score: correct, total: HOOD_NAMES.length });
    } catch (err) {
      console.error('recordPlay failed', err);
      outcome = { status: 'failed', error: err };
    }

    const status = outcome?.status;
    if (status === 'saved') {
      note.textContent = 'Saved to your profile';
    } else if (status === 'pending') {
      // Auth was lost between the check and the write; fall back to the nudge.
      note.hidden = true;
      nudge.hidden = false;
    } else {
      note.hidden = true;
      error.hidden = false;
    }
  }

  async function finish() {
    el('done').style.display = 'flex';
    const pct = answered ? Math.round(correct / answered * 100) : 0;
    el('doneTitle').textContent = pct >= 90 ? 'Local legend' : pct >= 70 ? 'Solid' : pct >= 50 ? 'Getting there' : 'Keep at it';
    el('doneScore').textContent = `${correct}/${HOOD_NAMES.length} correct · ${pct}% accuracy`;

    el('saveNudge').hidden = true;
    el('savedNote').hidden = true;
    el('saveError').hidden = true;

    // Only tracked modes count as a completed play; learn never reaches finish().
    if (mode !== 'find' && mode !== 'name') return;

    let loggedIn = false;
    try { loggedIn = Profiles.isLoggedIn(); } catch { }

    if (!loggedIn) {
      // Guest: capture holds the play so it flushes on later login; nudge to it.
      try { Profiles.recordPlay({ gameId, mode, score: correct, total: HOOD_NAMES.length }); }
      catch (err) { console.error('recordPlay failed', err); }
      el('saveNudge').hidden = false;
      return;
    }

    await saveResult();
  }

  document.querySelectorAll('#modeTabs button').forEach(b => b.onclick = () => setMode(b.dataset.mode));
  el('restart').onclick = startRound;
  el('doneRestart').onclick = startRound;
  el('saveLogin').onclick = () => { try { Profiles.promptLogin(); } catch (err) { console.error('promptLogin failed', err); } };
  el('saveRetry').onclick = () => { saveResult().catch(err => console.error('retry save failed', err)); };

  startRound();
}
