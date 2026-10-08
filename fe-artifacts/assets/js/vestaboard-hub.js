import { layoutMessage } from './vestaboard-layout.js?v=1';
import { createBoardPreview } from './vestaboard-preview.js?v=1';

// Illustrations only: browsing the collection never contacts the board.
for (const element of document.querySelectorAll('[data-preview]')) {
  createBoardPreview(element)(layoutMessage(element.dataset.preview).characters, '');
}
