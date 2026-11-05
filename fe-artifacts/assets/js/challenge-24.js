import { createDeck, evaluateAnswer } from './challenge-24-engine.js';

const CARD_LIMIT = 60_000;

function formatTime(milliseconds, rounding = Math.round) {
  const seconds = rounding(milliseconds / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function formatScore(milliseconds) {
  const tenths = Math.floor(milliseconds / 100);
  return `${Math.floor(tenths / 600)}:${String(Math.floor(tenths / 10) % 60).padStart(2, '0')}.${tenths % 10}`;
}

export function mountGame({ root = document, deck: providedDeck, deckFactory = createDeck, now = () => Date.now() } = {}) {
  const doc = root.ownerDocument || root;
  const find = (id) => root.querySelector(`#${id}`);
  const form = find('answer-form');
  const answer = find('answer');
  const submit = find('submit-answer');
  const reveal = find('show-answer');
  const next = find('next-card');
  const feedback = find('feedback');
  const card = find('challenge-card');
  const timer = find('card-time');
  const countInput = find('puzzle-count');
  const setupError = find('setup-error');
  const levelButtons = [...root.querySelectorAll('[data-level]')];
  const listeners = [];
  let phase = 'menu';
  let selectedMode = 'time';
  let selectedDifficulty = 'random';
  let run;
  let deck;
  let puzzle;
  let played = 0;
  let correct = 0;
  let solveTime = 0;
  let totalTime = 0;
  let elapsed = 0;
  let resumedAt = null;

  function listen(element, event, handler) {
    element.addEventListener(event, handler);
    listeners.push(() => element.removeEventListener(event, handler));
  }

  function readCount() {
    const count = Number(countInput.value);
    return Number.isSafeInteger(count) && count > 0 ? count : null;
  }

  function clearSetupError() {
    setupError.textContent = '';
    setupError.hidden = true;
    countInput.removeAttribute('aria-invalid');
  }

  function renderMenu() {
    const timed = selectedMode === 'time';
    const count = readCount();
    find('mode-free').setAttribute('aria-pressed', String(!timed));
    find('mode-time').setAttribute('aria-pressed', String(timed));
    find('time-settings').hidden = !timed;
    find('free-description').hidden = timed;
    find('decrease-count').disabled = count === 1;
    find('increase-count').disabled = count === Number.MAX_SAFE_INTEGER;
    levelButtons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.level === String(selectedDifficulty))));
    find('start-game').textContent = !timed ? 'Start Free Play' : count === null ? 'Start puzzles' : `Start ${count} ${count === 1 ? 'puzzle' : 'puzzles'}`;
    find('start-game').disabled = false;
  }

  function showScreen(screen) {
    find('start-menu').hidden = screen !== 'menu';
    find('play-screen').hidden = screen !== 'play';
    find('results-screen').hidden = screen !== 'results';
  }

  function currentElapsed() {
    return elapsed + (resumedAt === null ? 0 : Math.max(0, now() - resumedAt));
  }

  function renderClock() {
    if (!run) return;
    const duration = currentElapsed();
    const timed = run.mode === 'time';
    timer.textContent = timed
      ? formatTime(Math.max(0, CARD_LIMIT - duration), Math.ceil)
      : formatTime(duration, Math.floor);
    timer.parentElement.dataset.low = String(timed && phase === 'playing' && duration >= 50_000);
    if (timed) {
      const activeTime = phase === 'playing' ? Math.min(CARD_LIMIT, duration) : 0;
      find('total-time').textContent = formatScore(totalTime + activeTime);
    }
  }

  function renderStats() {
    const timed = run?.mode === 'time';
    find('played-count').textContent = timed ? `${played} / ${run.count}` : played;
    find('correct-count').textContent = correct;
    find('average-time').textContent = correct ? formatTime(solveTime / correct) : '—';
    find('average-time').hidden = timed;
    find('total-time').hidden = !timed;
    find('time-stat-label').textContent = timed ? 'Total time' : 'Avg. time';
    renderClock();
  }

  function setFeedback(message = '', state = '') {
    feedback.textContent = message;
    feedback.dataset.state = state;
    if (state === 'error') answer.setAttribute('aria-invalid', 'true');
    else answer.removeAttribute('aria-invalid');
  }

  function runLabel() {
    if (run.mode === 'free') return 'Free Play';
    return `Time to ${run.count} · ${run.difficulty === 'random' ? 'Random' : `Level ${run.difficulty}`}`;
  }

  function beginCard(focus = false) {
    puzzle = deck.next();
    phase = 'playing';
    elapsed = 0;
    resumedAt = run.mode === 'free' && doc.visibilityState === 'hidden' ? null : now();
    const description = `Numbers: ${puzzle.numbers.join(', ')}. Estimated difficulty: ${puzzle.difficulty} of 3.`;
    card.setAttribute('aria-label', description);
    find('card-description').textContent = description;
    card.querySelectorAll('[data-number]').forEach((node, index) => {
      node.textContent = puzzle.numbers[index];
    });
    card.querySelectorAll('[data-difficulty]').forEach((node, index) => {
      node.classList.toggle('unused', index >= puzzle.difficulty);
    });
    answer.value = '';
    answer.disabled = submit.disabled = reveal.disabled = false;
    submit.hidden = reveal.hidden = false;
    next.hidden = true;
    next.textContent = 'Next Card →';
    timer.setAttribute('aria-label', run.mode === 'time' ? 'Time remaining on this card' : 'Time on this card');
    setFeedback();
    renderStats();
    if (focus) answer.focus();
  }

  function beginRun(settings) {
    run = { ...settings };
    deck = providedDeck ?? deckFactory({ difficulty: run.mode === 'time' ? run.difficulty : 'random' });
    played = correct = solveTime = totalTime = 0;
    find('mode-label').textContent = runLabel();
    find('reset-session').textContent = run.mode === 'time' ? 'Restart run' : 'Reset session';
    showScreen('play');
    beginCard(true);
  }

  function finishCard(outcome) {
    if (phase !== 'playing') return;
    const duration = currentElapsed();
    const timed = run.mode === 'time';
    if (timed && duration >= CARD_LIMIT) outcome = 'timeout';
    const solved = outcome === 'correct';
    elapsed = timed && !solved ? CARD_LIMIT : duration;
    resumedAt = null;
    phase = 'review';
    played += 1;
    if (solved) {
      correct += 1;
      solveTime += elapsed;
    }
    totalTime += elapsed;
    if (solved) setFeedback('Correct.', 'correct');
    else {
      const solution = puzzle.solution.replaceAll('*', '×').replaceAll('/', '÷').replaceAll('-', '−');
      setFeedback(`${outcome === 'timeout' ? 'Time’s up. ' : ''}${solution} = 24`, 'revealed');
    }
    answer.disabled = submit.disabled = reveal.disabled = true;
    submit.hidden = reveal.hidden = true;
    next.hidden = false;
    next.textContent = timed && played === run.count ? 'Results →' : 'Next Card →';
    renderStats();
    next.focus({ preventScroll: true });
  }

  function expireIfNeeded() {
    if (phase === 'playing' && run.mode === 'time' && currentElapsed() >= CARD_LIMIT) {
      finishCard('timeout');
      return true;
    }
    return false;
  }

  function tick() {
    if (phase === 'playing' && !expireIfNeeded()) renderClock();
  }

  function showResults() {
    phase = 'results';
    find('result-mode').textContent = runLabel();
    find('final-score').textContent = formatScore(totalTime);
    find('result-correct').textContent = `${correct} / ${run.count} correct`;
    showScreen('results');
    find('play-again').focus({ preventScroll: true });
  }

  function returnToMenu() {
    phase = 'menu';
    resumedAt = null;
    clearSetupError();
    renderMenu();
    showScreen('menu');
    find(selectedMode === 'time' ? 'mode-time' : 'mode-free').focus({ preventScroll: true });
  }

  listen(find('start-form'), 'submit', event => {
    event.preventDefault();
    if (phase !== 'menu') return;
    const count = readCount();
    if (selectedMode === 'time' && count === null) {
      setupError.textContent = 'Choose a whole number of puzzles, at least 1.';
      setupError.hidden = false;
      countInput.setAttribute('aria-invalid', 'true');
      countInput.focus();
      return;
    }
    clearSetupError();
    beginRun({ mode: selectedMode, count, difficulty: selectedDifficulty });
  });
  for (const mode of ['free', 'time']) {
    listen(find(`mode-${mode}`), 'click', () => {
      if (phase !== 'menu') return;
      selectedMode = mode;
      clearSetupError();
      renderMenu();
    });
  }
  levelButtons.forEach(button => listen(button, 'click', () => {
    if (phase !== 'menu') return;
    selectedDifficulty = button.dataset.level === 'random' ? 'random' : Number(button.dataset.level);
    renderMenu();
  }));
  listen(countInput, 'input', () => {
    clearSetupError();
    renderMenu();
  });
  for (const [id, step] of [['decrease-count', -1], ['increase-count', 1]]) {
    listen(find(id), 'click', () => {
      const count = Math.max(1, (readCount() ?? 5) + step);
      if (Number.isSafeInteger(count)) countInput.value = count;
      clearSetupError();
      renderMenu();
    });
  }
  listen(form, 'submit', event => {
    event.preventDefault();
    if (phase !== 'playing' || expireIfNeeded()) return;
    const result = evaluateAnswer(answer.value, puzzle.numbers);
    if (!result.correct) {
      setFeedback(result.error || 'Not 24. Try again.', 'error');
      answer.focus();
      return;
    }
    finishCard('correct');
  });
  listen(reveal, 'click', () => {
    if (phase === 'playing' && !expireIfNeeded()) finishCard('revealed');
  });
  listen(next, 'click', () => {
    if (phase !== 'review') return;
    if (run.mode === 'time' && played === run.count) showResults();
    else beginCard(true);
  });
  listen(find('reset-session'), 'click', () => {
    if (phase === 'playing' || phase === 'review') beginRun(run);
  });
  listen(find('play-again'), 'click', () => {
    if (phase === 'results') beginRun(run);
  });
  listen(find('back-to-menu'), 'click', returnToMenu);
  listen(find('results-menu'), 'click', returnToMenu);
  listen(answer, 'input', () => {
    if (phase === 'playing' && feedback.dataset.state === 'error') setFeedback();
  });
  listen(doc, 'visibilitychange', () => {
    if (phase !== 'playing') return;
    if (run.mode === 'time') tick();
    else if (doc.visibilityState === 'hidden') {
      elapsed = currentElapsed();
      resumedAt = null;
      renderClock();
    } else if (resumedAt === null) resumedAt = now();
  });

  renderMenu();
  showScreen('menu');
  const clockInterval = setInterval(tick, 100);

  return {
    destroy() {
      clearInterval(clockInterval);
      listeners.forEach(remove => remove());
    },
  };
}
