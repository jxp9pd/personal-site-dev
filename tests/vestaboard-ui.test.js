import { describe, expect, it, vi } from 'vitest';
import { loadBoardPage, pomodoroState, nflState, reply } from './helpers/vestaboard.js';

const $ = id => document.getElementById(id);
const start = (configured = true) => loadBoardPage('note', { configured });

// Each page wires its own disabled control and feedback, but the same connection
// contract is checked here instead of copying a test into every feature suite.
describe.each(['note', 'pomodoro', 'nfl'])('%s board connection', page => {
  it('blocks writes until configured and recovers when configuration becomes available', async () => {
    const fetch = await loadBoardPage(page, { configured: false });
    const button = $(page === 'note' ? 'send' : page === 'nfl' ? 'track' : 'start');
    expect(button.disabled).toBe(true);
    if (page === 'nfl') {
      expect($('delivery').textContent).toBe('');
      expect($('reconnect').hidden).toBe(true);
    } else {
      expect($(page === 'note' ? 'feedback' : 'delivery').textContent).toContain('not connected');
      expect($('reconnect').hidden).toBe(false);
    }
    fetch.mockResolvedValue(reply(page === 'note' ? { configured: true } : page === 'nfl' ? nflState() : pomodoroState()));
    if (page === 'nfl') await vi.advanceTimersByTimeAsync(5000);
    else {
      $('reconnect').click();
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(button.disabled).toBe(false);
  });
});

describe('Note composer delivery feedback', () => {
  it('sends exactly the preview and prevents double submission until the cooldown ends', async () => {
    const fetch = await start();
    fetch.mockResolvedValueOnce(reply({ accepted: true, retryAfter: 15 }));
    $('message-form').dispatchEvent(new Event('submit', { cancelable: true }));
    $('message-form').dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(2); // status + one send
    const [url, options] = fetch.mock.calls[1];
    expect(url).toBe('/api/vestaboard/messages');
    const preview = [...document.querySelectorAll('.tile')].map(tile => Number(tile.dataset.code));
    expect(JSON.parse(options.body).characters.flat()).toEqual(preview);
    expect($('feedback').textContent).toContain('Accepted by Vestaboard');
    expect($('send').disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(15000);
    expect($('send').disabled).toBe(false);
  });
  it('shows upstream failures and a shared cooldown without claiming success', async () => {
    const fetch = await start();
    fetch.mockResolvedValueOnce(reply({ error: 'Board is busy.', retryAfter: 30 }, false));
    $('message-form').dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect($('feedback').textContent).toBe('Board is busy.');
    expect($('feedback').dataset.error).toBe('true');
    expect($('send-label').textContent).toContain('30s');
  });
  it('sends with Command+Enter while preserving ordinary Enter and preventing repeat sends', async () => {
    const fetch = await start();
    fetch.mockResolvedValueOnce(reply({ accepted: true, retryAfter: 15 }));
    const key = options => $('message').dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', bubbles: true, cancelable: true, ...options,
    }));
    expect(key({})).toBe(true); // Ordinary Enter keeps its normal newline behavior.
    key({ metaKey: true, isComposing: true });
    key({ metaKey: true, repeat: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    $('message').value = 'A\nB\nC\nD';
    $('message').dispatchEvent(new Event('input'));
    key({ metaKey: true });
    expect(fetch).toHaveBeenCalledTimes(1); // Shortcut still respects invalid drafts.
    $('message').value = 'HELLO';
    $('message').dispatchEvent(new Event('input'));
    expect(key({ metaKey: true })).toBe(false);
    key({ metaKey: true }); // Still sending.
    await vi.advanceTimersByTimeAsync(0);
    key({ metaKey: true }); // Cooldown.
    expect(fetch).toHaveBeenCalledTimes(2);
    expect($('feedback').textContent).toContain('Accepted by Vestaboard');
  });
  it('disables invalid drafts and never auto-sends when typing or inserting colors', async () => {
    const fetch = await start();
    $('message').value = 'A\nB\nC\nD';
    $('message').dispatchEvent(new Event('input'));
    expect($('send').disabled).toBe(true);
    expect($('validation').textContent).toContain('4 rows');
    $('clear').click();
    document.querySelector('[aria-label="Add a blue tile"]').click();
    expect($('send').disabled).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
