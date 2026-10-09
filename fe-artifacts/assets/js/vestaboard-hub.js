import { CODES, normalizeMessage, layoutMessage } from './vestaboard-layout.js?v=1';
import { createBoardPreview } from './vestaboard-preview.js?v=1';

// Illustrations only: browsing the collection never contacts the board.
for (const element of document.querySelectorAll('[data-preview]')) {
  // Fixed grid illustrations preserve scoreboard columns and possession tiles.
  const characters = element.hasAttribute('data-grid')
    ? normalizeMessage(element.dataset.preview).split('\n').map(line => {
      const row = Array.from(line, char => CODES[char]);
      return row.concat(Array(15 - row.length).fill(0));
    }) : layoutMessage(element.dataset.preview).characters;
  createBoardPreview(element)(characters, '');
}
