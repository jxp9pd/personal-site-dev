// Bootstrap for the neighborhoods quiz page. Extracted from an inline script so
// the city-select flow can be unit-tested with the data + auth layers mocked.
//
// Two screens live in one page: the city selector (#select) and an in-progress
// game (#app). The profile/login header is mounted on whichever screen is shown
// so a visitor can always reach their profile — see renderSelect + boot.

import { Profiles } from './profiles.js';
import { fetchQuiz, fetchQuizList } from './dataClient.js';
import { Leaderboard } from './leaderboard.js';
import { createNameIndex } from './nameMatch.js';

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
  // `artSvg` is admin-only content (service-role upload, no client writes — same
  // trust level as name/geo), so it is inlined as markup rather than escaped. The
  // name still goes through esc(). A card with no art just shows its name.
  grid.innerHTML = quizzes.map(q => `
    <a class="city-card" href="?city=${encodeURIComponent(q.slug)}">
      ${q.artSvg ? `<span class="art" aria-hidden="true">${q.artSvg}</span>` : ''}
      <span class="name">${esc(q.name)}</span>
    </a>`).join('');
}

function boot(quiz) {
  const gameId = quiz.slug;
  document.title = `${quiz.name} Neighborhoods Quiz`;
  el('title').textContent = `${quiz.name} Neighborhoods`;
  el('app').style.display = 'flex';

  // Auth/profile layer runs independently of the game bootstrap: an init failure
  // (e.g. network) must never stop the quiz from starting or being played.
  // onAuthChange keeps the Leaderboard button in sync — it's shown only to
  // logged-in players in a scored mode (find/name, never learn).
  let loggedIn = false;
  const modeLabel = () => (mode === 'find' ? 'Find it' : mode === 'name' ? 'Name it' : '');
  const boardEyebrow = () => `${quiz.name} · ${modeLabel()}`;
  function updateLbBtn() {
    el('leaderboardBtn').hidden = !(loggedIn && (mode === 'find' || mode === 'name'));
  }
  Profiles.init({
    gameSlug: gameId,
    headerMount: el('profileMount'),
    onAuthChange: (li) => { loggedIn = li; updateLbBtn(); },
  }).catch(err => console.error('Profiles init failed', err));

  el('leaderboardBtn').onclick = () => {
    if (mode !== 'find' && mode !== 'name') return;
    Leaderboard.open({ gameId, mode, variant: 'full', eyebrow: boardEyebrow() });
  };

  const GEO = quiz.geo;
  const HOOD_NAMES = GEO.features.map(f => f.properties.name).sort();
  const CENTER = quiz.center, ZOOM = quiz.zoom;
  // Forgiving name matcher for the timed type-to-recall mode (aliases included).
  const NAME_INDEX = createNameIndex(GEO.features);
  const NAME_SECONDS = 600; // 10-minute countdown

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
  L.tileLayer('https://cartodb-basemaps-{s}.global.ssl.fastly.net/light_nolabels/{z}/{x}/{y}{r}.png',
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
    correct = 0, answered = 0;
  // name-mode (timed type-to-recall) state
  let found = new Set(), nameTimer = null, nameDebounce = null, timeLeft = 0;
  function shuffle(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0;[a[i], a[j]] = [a[j], a[i]]; } return a; }

  // A single interval drives the countdown; the debounce backs the live check.
  // Both must die whenever a round ends so nothing leaks into the next round.
  function clearNameTimers() {
    if (nameTimer) { clearInterval(nameTimer); nameTimer = null; }
    if (nameDebounce) { clearTimeout(nameDebounce); nameDebounce = null; }
  }

  function setMode(m) {
    mode = m;
    document.querySelectorAll('#modeTabs button').forEach(b => b.classList.toggle('active', b.dataset.mode === m));
    updateLbBtn();
    startRound();
  }

  function startRound() {
    clearNameTimers();
    hoodReset();
    el('app').dataset.mode = mode;
    correct = 0; answered = 0; current = null;
    found = new Set();
    el('done').style.display = 'none';
    el('pFb').textContent = ''; el('pFb').className = 'fb';
    if (mode === 'learn') {
      el('prompt').style.display = 'none';
      el('namePregame').hidden = true;
      el('namePlay').hidden = true;
      el('stat').textContent = 'Hover a neighborhood to reveal its name · ' + HOOD_NAMES.length + ' total';
      map.setView(CENTER, ZOOM);
      return;
    }
    if (mode === 'name') {
      startNameRound();
      return;
    }
    el('prompt').style.display = 'block';
    el('namePregame').hidden = true;
    el('namePlay').hidden = true;
    queue = shuffle(HOOD_NAMES);
    el('pLabel').textContent = 'Find on the map';
    next();
  }

  // FIND only: one target at a time, pulled from a shuffled queue.
  function next() {
    el('pFb').textContent = ''; el('pFb').className = 'fb';
    if (queue.length === 0) { return finish(); }
    current = queue.shift();
    updateStat();
    el('pTarget').textContent = current;
  }

  function updateStat() {
    const total = HOOD_NAMES.length;
    // Segments are spans so the mobile breakpoint can drop "left"/"accuracy"
    // and show only the count. The leading " · " lives inside each optional
    // span so hiding it removes its separator too. textContent is unchanged.
    el('stat').innerHTML =
      `<span class="s-correct"><b>${correct}</b>/${total} correct</span>` +
      `<span class="s-left"> · ${queue.length} left</span>` +
      `<span class="s-acc"> · accuracy <b>${answered ? Math.round(correct / answered * 100) : 100}%</b></span>`;
  }

  // FIND: one click per prompt, then move on
  function onClick(name, l) {
    // Learn mode has no prompt: a tap reveals the name via the same tooltip
    // path as hover, so tapping between hoods moves the reveal along.
    if (mode === 'learn') { revealHover(name, l); return; }
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

  // NAME: timed type-to-recall. A pre-game panel gates the clock; nothing runs
  // until the player hits Start (unlike find, which auto-starts a round).
  function startNameRound() {
    el('prompt').style.display = 'none';
    el('namePlay').hidden = true;
    el('nameInput').value = '';
    el('nameInput').classList.remove('flash-bad');
    el('namePregameCount').textContent = `${HOOD_NAMES.length} neighborhoods`;
    el('namePregame').hidden = false;
    el('stat').textContent = '';
    map.setView(CENTER, ZOOM);
  }

  function nameStart() {
    if (mode !== 'name') return;
    clearNameTimers();
    found = new Set();
    timeLeft = NAME_SECONDS;
    el('namePregame').hidden = true;
    el('namePlay').hidden = false;
    renderNameStat();
    el('nameInput').value = '';
    el('nameInput').focus();
    nameTimer = setInterval(nameTick, 1000);
  }

  function nameTick() {
    timeLeft = Math.max(0, timeLeft - 1);
    renderNameStat();
    if (timeLeft <= 0) endNameRound();
  }

  function fmtTime(s) {
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, '0')}`;
  }

  function renderNameStat() {
    const total = HOOD_NAMES.length;
    const low = timeLeft <= 60 ? ' low' : '';
    el('stat').innerHTML =
      `<span class="s-correct"><b>${found.size}</b>/${total} found</span>` +
      `<span class="s-left"> · <span class="time${low}">${fmtTime(timeLeft)}</span> left</span>`;
  }

  function flashInput() {
    const input = el('nameInput');
    input.classList.remove('flash-bad');
    // reflow so re-adding the class always restarts the color cue
    void input.offsetWidth;
    input.classList.add('flash-bad');
  }

  // fromEnter distinguishes a submit (Enter) from live typing: only a submit
  // flashes on a miss; live typing that matches nothing does nothing.
  function checkName(fromEnter) {
    if (mode !== 'name' || !nameTimer) return;
    const input = el('nameInput');
    const canonical = NAME_INDEX.match(input.value);
    if (!canonical) {
      if (fromEnter) flashInput();
      return;
    }
    if (found.has(canonical)) return; // already found: no-op, keep the text
    found.add(canonical);
    const l = hoodByName[canonical];
    if (l) {
      l._locked = true;
      styleOk(l);
      l.bindTooltip(canonical, { className: 'answer-tip', permanent: true, direction: 'top' });
    }
    input.value = '';
    correct = found.size;
    renderNameStat();
    if (found.size >= HOOD_NAMES.length) endNameRound();
  }

  function onNameInput() {
    if (mode !== 'name' || !nameTimer) return;
    if (nameDebounce) clearTimeout(nameDebounce);
    nameDebounce = setTimeout(() => { nameDebounce = null; checkName(false); }, 400);
  }

  function onNameKeydown(e) {
    if (mode !== 'name' || !nameTimer) return;
    if (e.key === 'Enter') {
      if (nameDebounce) { clearTimeout(nameDebounce); nameDebounce = null; }
      checkName(true);
    }
  }

  // Both end conditions (all found, timer expiry) route through the shared
  // finish() path; correct/answered are set so the accuracy title + save shape
  // match find mode exactly (score = found count, all N treated as answered).
  function endNameRound() {
    clearNameTimers();
    correct = found.size;
    answered = HOOD_NAMES.length;
    finish();
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

    let loggedInNow = false;
    try { loggedInNow = Profiles.isLoggedIn(); } catch { }

    if (!loggedInNow) {
      // Guest: capture holds the play so it flushes on later login; nudge to it.
      try { Profiles.recordPlay({ gameId, mode, score: correct, total: HOOD_NAMES.length }); }
      catch (err) { console.error('recordPlay failed', err); }
      el('saveNudge').hidden = false;
      return;
    }

    // Land the row first so the board (and the viewer's placement) reflects this
    // round, then celebrate with the leaderboard modal over the done overlay.
    await saveResult();
    Leaderboard.open({
      gameId,
      mode,
      variant: 'round',
      eyebrow: boardEyebrow(),
      title: el('doneTitle').textContent,
      subline: `${correct} of ${HOOD_NAMES.length} correct`,
      onAgain: () => startRound(),
    });
  }

  document.querySelectorAll('#modeTabs button').forEach(b => b.onclick = () => setMode(b.dataset.mode));
  el('nameStart').onclick = nameStart;
  el('nameInput').addEventListener('input', onNameInput);
  el('nameInput').addEventListener('keydown', onNameKeydown);
  el('restart').onclick = startRound;
  el('doneRestart').onclick = startRound;
  el('saveLogin').onclick = () => { try { Profiles.promptLogin(); } catch (err) { console.error('promptLogin failed', err); } };
  el('saveRetry').onclick = () => { saveResult().catch(err => console.error('retry save failed', err)); };

  startRound();
}
