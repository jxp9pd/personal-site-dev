import { ROWS, COLUMNS } from './vestaboard-layout.js';

// DOM and status helpers shared by the board app pages.
export const $ = id => document.getElementById(id);

export function feedback(message, error = false) {
  $('feedback').textContent = message;
  $('feedback').dataset.error = String(error);
}

export const validFrame = frame => Array.isArray(frame) && frame.length === ROWS
  && frame.every(row => Array.isArray(row) && row.length === COLUMNS && row.every(Number.isInteger));

const deliveryText = { pending: 'Board update queued.', accepted: 'Update accepted by Vestaboard.' };

// `notice` (connection or setup state) replaces the delivery text; `announce`
// lists the non-error delivery states the page reports.
export function renderDelivery(delivery, { notice = '', noticeIsError = false, announce = [] } = {}) {
  const failed = delivery?.status === 'error';
  $('delivery').dataset.error = String(failed || (!!notice && noticeIsError));
  $('delivery').textContent = notice || (failed ? delivery.error
    : announce.includes(delivery?.status) ? deliveryText[delivery.status] : '');
}
