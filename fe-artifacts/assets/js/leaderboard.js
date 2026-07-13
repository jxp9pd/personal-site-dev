// DOM/glue layer for the leaderboard modal. Pure UI + a thin call into the data
// client; ranking is done in SQL (the `leaderboard` view). Two variants share
// one modal:
//   * 'round' — end-of-round: eyebrow + result title/subline, top 5, the
//     viewer's placement (pinned below a "N players between" divider when they
//     rank lower), and Go again / Full leaderboard actions.
//   * 'full'  — header button: the scrollable all-time board with a "Your best"
//     footer.
//
// Like ui.js, everything is scoped under an `lb-` prefix and ships its own
// stylesheet so it renders correctly on any page regardless of host CSS.

import * as dataClient from './dataClient.js';
import { buildCompactRows, formatScore, formatDate } from './leaderboard-view.js';

const STYLE_ID = 'lb-style';
const COMPACT_TOP = 5;
const FULL_LIMIT = 100;

const FONT_MONO = '"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace';
const FONT_DISPLAY = '"Instrument Serif","Iowan Old Style",Georgia,serif';

// Same paper palette as the host pages, inlined (the module can't rely on a
// page's :root tokens being present). --accent (#22b8ff) marks the viewer.
const CSS = `
.lb-overlay{position:fixed;inset:0;z-index:2100;display:flex;align-items:center;
  justify-content:center;background:rgba(20,19,15,.42);padding:16px}
.lb-overlay[hidden]{display:none}
.lb-modal{position:relative;width:100%;max-width:420px;max-height:88vh;
  display:flex;flex-direction:column;background:#fdfcf3;
  border:1px solid rgba(20,19,15,.14);border-radius:18px;padding:24px 24px 22px;
  color:#14130f;box-shadow:0 30px 70px -30px rgba(20,19,15,.5);
  font:14px/1.45 ${FONT_MONO}}
.lb-close{position:absolute;top:12px;right:14px;background:none;border:0;
  color:#6b675e;font-size:22px;line-height:1;cursor:pointer}
.lb-close:hover{color:#14130f}
.lb-eyebrow{font:500 10px/1.3 ${FONT_MONO};color:#6b675e;text-transform:uppercase;
  letter-spacing:.18em;padding-right:20px}
.lb-title{margin:6px 0 0;font-family:${FONT_DISPLAY};font-size:27px;font-weight:400;
  letter-spacing:.01em;line-height:1.1}
.lb-sub{color:#6b675e;font-size:13px;margin:4px 0 0}
.lb-sub[hidden]{display:none}
.lb-body{margin-top:16px;display:flex;flex-direction:column;min-height:0}
.lb-head,.lb-row{display:grid;grid-template-columns:26px 1fr auto 64px;
  align-items:center;gap:10px}
.lb-head{font:500 9px/1 ${FONT_MONO};color:#9a968c;text-transform:uppercase;
  letter-spacing:.14em;padding:0 2px 8px;border-bottom:1px solid rgba(20,19,15,.14)}
.lb-head .lb-date,.lb-head .lb-score{text-align:right}
.lb-rows{display:flex;flex-direction:column;overflow-y:auto;min-height:0}
.lb-row{padding:9px 2px;border-bottom:1px solid rgba(20,19,15,.08)}
.lb-row:last-child{border-bottom:0}
.lb-rank{color:#9a968c;font-variant-numeric:tabular-nums;font-size:12px}
.lb-name{font-family:${FONT_DISPLAY};font-size:16px;line-height:1.1;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lb-you{margin-left:7px;font:500 8px/1 ${FONT_MONO};color:#9a968c;
  text-transform:uppercase;letter-spacing:.14em;vertical-align:middle}
.lb-date{text-align:right;font-size:11px;color:#9a968c;font-variant-numeric:tabular-nums}
.lb-score{text-align:right;font-weight:500;font-variant-numeric:tabular-nums;font-size:13px}
.lb-row.me{background:rgba(34,184,255,.09);border-radius:8px;
  box-shadow:inset 3px 0 0 #22b8ff}
.lb-row.me .lb-score{color:#1499d6}
.lb-pinned{margin-top:2px}
.lb-divider{text-align:center;color:#9a968c;font-size:10px;letter-spacing:.08em;
  text-transform:uppercase;padding:12px 0 8px}
.lb-hint,.lb-empty,.lb-error,.lb-loading{color:#6b675e;font-size:13px;
  text-align:center;padding:18px 4px}
.lb-footer{margin-top:14px;padding-top:12px;border-top:1px solid rgba(20,19,15,.14);
  color:#6b675e;font-size:12px}
.lb-footer[hidden]{display:none}
.lb-footer b{color:#14130f}
.lb-actions{display:flex;gap:10px;justify-content:center;margin-top:18px}
.lb-actions[hidden]{display:none}
.lb-btn{background:transparent;border:1px solid #14130f;color:#14130f;
  padding:10px 18px;border-radius:999px;cursor:pointer;
  font:500 11px/1 ${FONT_MONO};text-transform:uppercase;letter-spacing:.12em;
  transition:color .25s,background .25s,box-shadow .25s}
.lb-btn:hover{color:#fdfcf3;background:#14130f;box-shadow:0 12px 30px -14px rgba(20,19,15,.55)}
.lb-btn.primary{color:#fdfcf3;background:#14130f}
.lb-btn.primary:hover{color:#14130f;background:transparent}
`;

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function injectStyleOnce() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

let overlay = null;
let els = null;
// Current open board: { gameId, mode, eyebrow, title, subline, onAgain,
// viewerId, top, viewer, variant }. Kept so Full leaderboard can re-render from
// the already-fetched data without another round-trip.
let state = null;

function build() {
  if (overlay) return;
  injectStyleOnce();
  overlay = document.createElement('div');
  overlay.className = 'lb-overlay';
  overlay.hidden = true;
  overlay.innerHTML = `
    <div class="lb-modal" role="dialog" aria-modal="true" aria-label="Leaderboard">
      <button class="lb-close" type="button" aria-label="Close">&times;</button>
      <div class="lb-eyebrow"></div>
      <h2 class="lb-title"></h2>
      <div class="lb-sub" hidden></div>
      <div class="lb-body"></div>
      <div class="lb-footer" hidden></div>
      <div class="lb-actions" hidden>
        <button class="lb-btn primary lb-go" type="button">Go again</button>
        <button class="lb-btn lb-full" type="button">Full leaderboard</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  els = {
    modal: overlay.querySelector('.lb-modal'),
    close: overlay.querySelector('.lb-close'),
    eyebrow: overlay.querySelector('.lb-eyebrow'),
    title: overlay.querySelector('.lb-title'),
    sub: overlay.querySelector('.lb-sub'),
    body: overlay.querySelector('.lb-body'),
    footer: overlay.querySelector('.lb-footer'),
    actions: overlay.querySelector('.lb-actions'),
    go: overlay.querySelector('.lb-go'),
    full: overlay.querySelector('.lb-full'),
  };

  els.close.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.hidden) close();
  });
  els.go.addEventListener('click', () => {
    const again = state?.onAgain;
    close();
    if (typeof again === 'function') again();
  });
  els.full.addEventListener('click', () => {
    if (!state) return;
    state.variant = 'full';
    render();
  });
}

function rowHtml(row, viewerId, pinned) {
  const me = row.user_id === viewerId;
  const cls = `lb-row${me ? ' me' : ''}${pinned ? ' lb-pinned' : ''}`;
  return `<div class="${cls}">
    <span class="lb-rank">${row.rank}</span>
    <span class="lb-name">${esc(row.username)}${me ? '<span class="lb-you">you</span>' : ''}</span>
    <span class="lb-date">${formatDate(row.achieved_at)}</span>
    <span class="lb-score">${formatScore(row.score)}</span>
  </div>`;
}

const HEAD = `<div class="lb-head"><span>#</span><span>Name</span>` +
  `<span class="lb-date">Date</span><span class="lb-score">Score</span></div>`;

function renderRound() {
  els.title.textContent = state.title || 'Nicely done.';
  els.sub.textContent = state.subline || '';
  els.sub.hidden = !state.subline;
  els.footer.hidden = true;
  els.actions.hidden = false;

  if (!state.top.length) {
    els.body.innerHTML = `<div class="lb-empty">No scores yet — be the first.</div>`;
    return;
  }

  const { rows, viewerRow, showDivider, between } = buildCompactRows(
    state.top, state.viewer, COMPACT_TOP);
  let inner = HEAD + `<div class="lb-rows">` +
    rows.map((r) => rowHtml(r, state.viewerId)).join('');
  if (showDivider && viewerRow) {
    const label = `${between} player${between === 1 ? '' : 's'} between`;
    inner += `<div class="lb-divider">· · · ${label} · · ·</div>` +
      rowHtml(viewerRow, state.viewerId, true);
  } else if (!state.viewer) {
    inner += `<div class="lb-hint">Play a round to get ranked</div>`;
  }
  inner += `</div>`;
  els.body.innerHTML = inner;
}

function renderFull() {
  els.title.textContent = 'Leaderboard';
  els.sub.hidden = true;
  els.actions.hidden = true;

  if (!state.top.length) {
    els.body.innerHTML = `<div class="lb-empty">No scores yet — be the first.</div>`;
    els.footer.hidden = true;
    return;
  }

  els.body.innerHTML = HEAD + `<div class="lb-rows">` +
    state.top.map((r) => rowHtml(r, state.viewerId)).join('') + `</div>`;

  if (state.viewer) {
    const v = state.viewer;
    els.footer.innerHTML = `Your best · <b>#${v.rank}</b> · ${formatScore(v.score)} · ${esc(v.username)}`;
  } else {
    els.footer.innerHTML = `Play a round to get ranked`;
  }
  els.footer.hidden = false;
}

function render() {
  els.eyebrow.textContent = state.eyebrow || '';
  if (state.variant === 'full') renderFull();
  else renderRound();
}

function close() {
  if (overlay) overlay.hidden = true;
}

// Opens the leaderboard for one board. Options:
//   gameId, mode        — board identity (required)
//   variant             — 'round' | 'full' (default 'round')
//   eyebrow             — small uppercase context line
//   title, subline      — round variant only (result heading + detail)
//   onAgain             — round variant "Go again" callback
async function open(options = {}) {
  const { gameId, mode, variant = 'round', eyebrow = '', title = '', subline = '', onAgain = null } = options;
  build();

  state = { gameId, mode, variant, eyebrow, title, subline, onAgain, viewerId: null, top: [], viewer: null };

  overlay.hidden = false;
  els.eyebrow.textContent = eyebrow;
  els.title.textContent = variant === 'full' ? 'Leaderboard' : (title || '');
  els.sub.hidden = true;
  els.footer.hidden = true;
  els.actions.hidden = true;
  els.body.innerHTML = `<div class="lb-loading">Loading…</div>`;

  try {
    const session = await dataClient.getSession();
    state.viewerId = session?.user?.id ?? null;
    const [top, viewer] = await Promise.all([
      dataClient.fetchLeaderboard(gameId, mode, FULL_LIMIT),
      state.viewerId ? dataClient.fetchViewerRank(gameId, mode, state.viewerId) : Promise.resolve(null),
    ]);
    state.top = top;
    state.viewer = viewer;
    render();
  } catch (err) {
    console.error('Leaderboard load failed', err);
    els.body.innerHTML = `<div class="lb-error">Couldn’t load the leaderboard — check your connection.</div>`;
  }
}

export const Leaderboard = { open, close };
