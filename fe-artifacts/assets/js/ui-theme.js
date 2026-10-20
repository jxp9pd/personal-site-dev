// Scoped widgets use generated values without depending on the host page CSS.
export { FONT_MONO, FONT_DISPLAY, palette } from './ui-theme-tokens.js';

// Appends a <style> with the given CSS to <head> exactly once (keyed by id), so
// a module can be imported by multiple callers without duplicating its styles.
export function injectStyleOnce(id, css) {
  if (document.getElementById(id)) return;
  const style = document.createElement('style');
  style.id = id;
  style.textContent = css;
  document.head.appendChild(style);
}
