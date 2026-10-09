import { ROWS, COLUMNS, SYMBOLS } from './vestaboard-layout.js?v=1';

// All board apps render through this component. Reusing tiles also avoids
// animating unchanged characters when live status is polled.
export function createBoardPreview(element) {
  const tiles = Array.from({ length: ROWS * COLUMNS }, () => {
    const tile = document.createElement('span');
    tile.className = 'tile';
    tile.setAttribute('aria-hidden', 'true');
    return tile;
  });
  element.replaceChildren(...tiles);
  return (characters, description) => {
    characters.flat().forEach((code, index) => {
      const tile = tiles[index];
      if (tile.dataset.code === String(code)) return;
      tile.dataset.code = code;
      tile.textContent = code >= 63 ? '' : SYMBOLS[code];
      tile.classList.remove('changed');
      void tile.offsetWidth;
      tile.classList.add('changed');
    });
    element.setAttribute('aria-label', description);
  };
}
