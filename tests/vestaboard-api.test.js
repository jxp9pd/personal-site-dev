import { afterEach, expect, it, vi } from 'vitest';
import { sendBoardMessage } from '../fe-artifacts/assets/js/vestaboard-api.js';

afterEach(() => vi.unstubAllGlobals());

it('preserves rejection cooldowns and distinguishes unconfirmed writes without retrying them', async () => {
  const cases = [
    { response: { ok: false, json: async () => ({ error: 'Board is busy.', retryAfter: 30 }) },
      expected: { message: 'Board is busy.', retryAfter: 30, uncertain: false } },
    { failure: new TypeError('offline'),
      expected: { message: expect.stringContaining('may have applied'), retryAfter: 15, uncertain: true } },
    { response: { ok: false, status: 502, json: async () => { throw new SyntaxError('HTML proxy error'); } },
      expected: { message: expect.stringContaining('HTTP 502'), retryAfter: 15, uncertain: true } },
    { response: { ok: true, json: async () => ({ accepted: false }) },
      expected: { message: expect.stringContaining('did not confirm'), retryAfter: 15, uncertain: true } },
  ];
  for (const { response, failure, expected } of cases) {
    const fetch = failure ? vi.fn().mockRejectedValue(failure) : vi.fn().mockResolvedValue(response);
    vi.stubGlobal('fetch', fetch);
    await expect(sendBoardMessage([[1, ...Array(14).fill(0)], Array(15).fill(0), Array(15).fill(0)]))
      .rejects.toMatchObject(expected);
    expect(fetch).toHaveBeenCalledTimes(1);
  }
});
