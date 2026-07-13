// Shared styling primitives for the self-contained UI modules (ui.js, the auth
// modal; leaderboard.js, the leaderboard modal). These widgets ship their own
// scoped stylesheet so they render on any page regardless of host CSS, so the
// palette/fonts can't come from the host's :root — they live here instead, as
// the single source of truth mirroring /assets/site.css.

export const FONT_MONO = '"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace';
export const FONT_DISPLAY = '"Instrument Serif","Iowan Old Style",Georgia,serif';

// The homepage "paper" palette. `faint` is a lighter muted for row metadata,
// `accentInk` is the accent darkened enough to read as text on the light paper.
export const palette = {
  paper: '#fdfcf3',
  paper2: '#f7f5ea',
  ink: '#14130f',
  muted: '#6b675e',
  faint: '#9a968c',
  line: 'rgba(20,19,15,.14)',
  accent: '#22b8ff',
  accentInk: '#1499d6',
  danger: '#d64541',
};

// Appends a <style> with the given CSS to <head> exactly once (keyed by id), so
// a module can be imported by multiple callers without duplicating its styles.
export function injectStyleOnce(id, css) {
  if (document.getElementById(id)) return;
  const style = document.createElement('style');
  style.id = id;
  style.textContent = css;
  document.head.appendChild(style);
}
