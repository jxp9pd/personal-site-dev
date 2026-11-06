import { createDeck, evaluateAnswer } from './challenge-24-engine.js';

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
  const limitInput = find('card-limit');
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

  function readLimit() {
    const seconds = Number(limitInput.value);
    const milliseconds = seconds * 1000;
    return Number.isSafeInteger(seconds) && seconds > 0 && Number.isSafeInteger(milliseconds) ? milliseconds : null;
  }

  function clearSetupError() {
    setupError.textContent = '';
    setupError.hidden = true;
    countInput.removeAttribute('aria-invalid');
    limitInput.removeAttribute('aria-invalid');
  }

  function showSetupError(input, message) {
    setupError.textContent = message;
    setupError.hidden = false;
    input.setAttribute('aria-invalid', 'true');
    input.focus();
  }

  function renderMenu() {
    const timed = selectedMode === 'time';
    const count = readCount();
    const limit = readLimit();
    find('mode-free').setAttribute('aria-pressed', String(!timed));
    find('mode-time').setAttribute('aria-pressed', String(timed));
    find('time-settings').hidden = !timed;
    find('free-description').hidden = timed;
    find('decrease-count').disabled = count === 1;
    find('increase-count').disabled = count === Number.MAX_SAFE_INTEGER;
    find('decrease-limit').disabled = limit === 1000;
    find('increase-limit').disabled = limit !== null && !Number.isSafeInteger(limit + 15_000);
    find('time-rule-limit').textContent = limit === null ? 'Set a time limit' : `${limit / 1000}s`;
    levelButtons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.level === String(selectedDifficulty))));
    find('start-game').textContent = !timed ? 'Start Free Play' : count === null ? 'Solve puzzles' : `Solve ${count} ${count === 1 ? 'puzzle' : 'puzzles'}`;
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
    const remaining = Math.max(0, run.cardLimit - duration);
    timer.textContent = timed
      ? formatTime(remaining, Math.ceil)
      : formatTime(duration, Math.floor);
    timer.parentElement.dataset.low = String(timed && phase === 'playing' && remaining <= Math.min(10_000, run.cardLimit / 6));
    if (timed) {
      const activeTime = phase === 'playing' ? Math.min(run.cardLimit, duration) : 0;
      find('total-time').textContent = formatScore(totalTime + activeTime);
    }
  }

  function renderStats() {
    const timed = run?.mode === 'time';
    find('played-count').textContent = played;
    find('correct-count').textContent = timed ? `${correct} / ${run.count}` : correct;
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
    const mode = run.mode === 'free' ? 'Free Play' : `Time to ${run.count}`;
    if (!run.showDifficulty) return mode;
    return `${mode} · ${run.difficulty === 'random' ? 'Random' : `Level ${run.difficulty}`}`;
  }

  function beginCard(focus = false) {
    puzzle = deck.next();
    phase = 'playing';
    elapsed = 0;
    resumedAt = run.mode === 'free' && doc.visibilityState === 'hidden' ? null : now();
    const description = `Numbers: ${puzzle.numbers.join(', ')}.${run.showDifficulty ? ` Estimated difficulty: ${puzzle.difficulty} of 3.` : ''}`;
    card.setAttribute('aria-label', description);
    find('card-description').textContent = description;
    card.querySelector('.difficulty-dots').toggleAttribute('hidden', !run.showDifficulty);
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
    deck = providedDeck ?? deckFactory({ difficulty: run.difficulty });
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
    if (timed && duration >= run.cardLimit) outcome = 'timeout';
    const solved = outcome === 'correct';
    elapsed = timed && !solved ? run.cardLimit : duration;
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
    next.textContent = timed && correct === run.count ? 'Results →' : 'Next Card →';
    renderStats();
    next.focus({ preventScroll: true });
  }

  function expireIfNeeded() {
    if (phase === 'playing' && run.mode === 'time' && currentElapsed() >= run.cardLimit) {
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
    find('result-correct').textContent = `${correct} / ${played} correct`;
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
    const cardLimit = readLimit();
    clearSetupError();
    if (selectedMode === 'time' && count === null) {
      showSetupError(countInput, 'Choose a whole number of solves, at least 1.');
      return;
    }
    if (selectedMode === 'time' && cardLimit === null) {
      showSetupError(limitInput, 'Choose a whole number of seconds, at least 1.');
      return;
    }
    beginRun({ mode: selectedMode, count, difficulty: selectedDifficulty, cardLimit, showDifficulty: find('show-difficulty').checked });
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
  listen(limitInput, 'input', () => {
    clearSetupError();
    renderMenu();
  });
  const helpElements = [...root.querySelectorAll('.setting-help')];
  helpElements.forEach(help => {
    const tooltip = help.querySelector('[role="tooltip"]');
    for (const event of ['pointerenter', 'focusin']) {
      listen(help, event, () => {
        helpElements.forEach(element => element.querySelector('[role="tooltip"]').hidden = element !== help);
      });
    }
    for (const event of ['pointerleave', 'focusout']) {
      listen(help, event, () => { tooltip.hidden = true; });
    }
    listen(help, 'keydown', event => {
      if (event.key === 'Escape') tooltip.hidden = true;
    });
  });
  for (const [id, step] of [['decrease-count', -1], ['increase-count', 1]]) {
    listen(find(id), 'click', () => {
      const count = Math.max(1, (readCount() ?? 5) + step);
      if (Number.isSafeInteger(count)) countInput.value = count;
      clearSetupError();
      renderMenu();
    });
  }
  for (const [id, step] of [['decrease-limit', -15], ['increase-limit', 15]]) {
    listen(find(id), 'click', () => {
      const seconds = Math.max(1, (readLimit() ?? 60_000) / 1000 + step);
      if (Number.isSafeInteger(seconds * 1000)) limitInput.value = seconds;
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
    if (run.mode === 'time' && correct === run.count) showResults();
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
