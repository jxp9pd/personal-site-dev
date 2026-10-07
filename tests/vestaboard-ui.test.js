import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const html = readFileSync(resolve('fe-artifacts/tools/vestaboard.html'), 'utf8');
const reply = (data, ok = true) => ({ ok, json: async () => data });
const $ = id => document.getElementById(id);

async function start(configured = true) {
  vi.resetModules();
  vi.useFakeTimers();
  document.body.innerHTML = html;
  const fetch = vi.fn().mockResolvedValueOnce(reply({ configured, retryAfter: 0 }));
  vi.stubGlobal('fetch', fetch);
  await import('../fe-artifacts/assets/js/vestaboard.js');
  await vi.advanceTimersByTimeAsync(0);
  return fetch;
}

afterEach(() => { vi.clearAllTimers(); vi.unstubAllGlobals(); document.body.innerHTML = ''; });

describe('Note composer delivery feedback', () => {
  it('keeps sending disabled until configured, then supports an explicit connection recheck', async () => {
    const fetch = await start(false);
    expect($('send').disabled).toBe(true);
    expect($('feedback').textContent).toContain('not connected');
    fetch.mockResolvedValueOnce(reply({ configured: true }));
    $('reconnect').click();
    await vi.advanceTimersByTimeAsync(0);
    expect($('send').disabled).toBe(false);
  });
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
  it('handles proxy HTML errors without misreporting them as a connection failure', async () => {
    const fetch = await start();
    fetch.mockResolvedValueOnce({ ok: false, status: 502, json: async () => { throw new SyntaxError('HTML'); } });
    $('message-form').dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect($('feedback').textContent).toContain('HTTP 502');
    expect($('feedback').textContent).toContain('may have been sent');
    expect($('send').disabled).toBe(true);
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
