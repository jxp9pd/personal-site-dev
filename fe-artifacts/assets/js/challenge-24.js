import { createDeck, evaluateAnswer } from './challenge-24-engine.js';

function formatTime(milliseconds, rounding = Math.round) {
  const seconds = rounding(milliseconds / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function mountGame({ root = document, deck = createDeck(), now = () => performance.now() } = {}) {
  const doc = root.ownerDocument || root;
  const find = (id) => root.querySelector(`#${id}`);
  const form = find('answer-form');
  const answer = find('answer');
  const submit = find('submit-answer');
  const reveal = find('show-answer');
  const next = find('next-card');
  const feedback = find('feedback');
  const reset = find('reset-session');
  const card = find('challenge-card');
  const timer = find('card-time');
  let puzzle;
  let finished = false;
  let played = 0;
  let correct = 0;
  let solveTime = 0;
  let elapsed = 0;
  let resumedAt = null;

  function renderClock() {
    const currentElapsed = elapsed + (resumedAt === null ? 0 : Math.max(0, now() - resumedAt));
    timer.textContent = formatTime(currentElapsed, Math.floor);
  }

  function renderStats() {
    find('played-count').textContent = played;
    find('correct-count').textContent = correct;
    find('average-time').textContent = correct ? formatTime(solveTime / correct) : '—';
  }

  function setFeedback(message = '', state = '') {
    feedback.textContent = message;
    feedback.dataset.state = state;
    if (state === 'error') answer.setAttribute('aria-invalid', 'true');
    else answer.removeAttribute('aria-invalid');
  }

  function beginCard(focus = false) {
    puzzle = deck.next();
    finished = false;
    elapsed = 0;
    resumedAt = doc.visibilityState === 'hidden' ? null : now();
    renderClock();
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
    setFeedback();
    if (focus) answer.focus();
  }

  function pauseClock() {
    if (resumedAt !== null) elapsed += Math.max(0, now() - resumedAt);
    resumedAt = null;
    renderClock();
  }

  function finishCard(solved) {
    if (finished) return;
    pauseClock();
    finished = true;
    played += 1;
    if (solved) {
      correct += 1;
      solveTime += elapsed;
    }
    answer.disabled = submit.disabled = reveal.disabled = true;
    submit.hidden = reveal.hidden = true;
    next.hidden = false;
    renderStats();
    next.focus({ preventScroll: true });
  }

  function onSubmit(event) {
    event.preventDefault();
    if (finished) return;
    const result = evaluateAnswer(answer.value, puzzle.numbers);
    if (!result.correct) {
      setFeedback(result.error || 'Not 24. Try again.', 'error');
      answer.focus();
      return;
    }
    setFeedback('Correct.', 'correct');
    finishCard(true);
  }

  function onReveal() {
    if (finished) return;
    const solution = puzzle.solution.replaceAll('*', '×').replaceAll('/', '÷').replaceAll('-', '−');
    setFeedback(`${solution} = 24`, 'revealed');
    finishCard(false);
  }

  function onNext() {
    if (finished) beginCard(true);
  }

  function onReset() {
    played = correct = solveTime = 0;
    renderStats();
    beginCard(true);
  }

  function onVisibilityChange() {
    if (finished) return;
    if (doc.visibilityState === 'hidden') pauseClock();
    else if (resumedAt === null) resumedAt = now();
  }

  function onInput() {
    if (!finished && feedback.dataset.state === 'error') setFeedback();
  }

  form.addEventListener('submit', onSubmit);
  reveal.addEventListener('click', onReveal);
  next.addEventListener('click', onNext);
  reset.addEventListener('click', onReset);
  answer.addEventListener('input', onInput);
  doc.addEventListener('visibilitychange', onVisibilityChange);
  renderStats();
  beginCard();
  const clockInterval = setInterval(renderClock, 250);

  return {
    destroy() {
      clearInterval(clockInterval);
      form.removeEventListener('submit', onSubmit);
      reveal.removeEventListener('click', onReveal);
      next.removeEventListener('click', onNext);
      reset.removeEventListener('click', onReset);
      answer.removeEventListener('input', onInput);
      doc.removeEventListener('visibilitychange', onVisibilityChange);
    },
  };
}
