import { describe, expect, it, vi } from 'vitest';
import { SUPABASE_URL as CONFIG_SUPABASE_URL } from '../fe-artifacts/assets/js/config.js';
import {
  SupabaseConfigError,
  createSupabaseAdmin,
  missingKeyMessage,
  summarizeErrorBody,
  supabaseAuthHeaders,
  validateSupabaseUrl,
} from '../scripts/lib/supabase-admin.mjs';

const LEGACY_KEY = 'eyJhbGciOiJIUzI1NiJ9.e30.signature';
const SECRET_KEY = 'sb_secret_test_only_value';

function admin(env, fetchImpl = vi.fn(async () => ({ ok: true, status: 200 }))) {
  return { client: createSupabaseAdmin({ env, fetchImpl }), fetchImpl };
}

describe('env and config resolution', () => {
  it('uses SUPABASE_URL from the environment, normalized to the origin', () => {
    const { client } = admin({ SUPABASE_URL: 'https://abc.supabase.co/', SUPABASE_SERVICE_ROLE_KEY: SECRET_KEY });
    expect(client.url).toBe('https://abc.supabase.co');
  });

  it('falls back to the public config URL when SUPABASE_URL is unset or empty', () => {
    for (const env of [{}, { SUPABASE_URL: '' }]) {
      const { client } = admin({ ...env, SUPABASE_SERVICE_ROLE_KEY: SECRET_KEY });
      expect(client.url).toBe(CONFIG_SUPABASE_URL);
    }
  });

  it('does not expose the key on the client object', () => {
    const { client } = admin({ SUPABASE_SERVICE_ROLE_KEY: SECRET_KEY });
    expect(JSON.stringify(Object.keys(client))).not.toContain('key');
    expect(JSON.stringify(client)).not.toContain(SECRET_KEY);
  });
});

describe('missing key', () => {
  it('throws one config error before any request', () => {
    const fetchImpl = vi.fn();
    expect(() => createSupabaseAdmin({ env: { SUPABASE_URL: 'https://abc.supabase.co' }, fetchImpl }))
      .toThrow(SupabaseConfigError);
    expect(() => createSupabaseAdmin({ env: { SUPABASE_SERVICE_ROLE_KEY: '' }, fetchImpl }))
      .toThrow(/^Missing SUPABASE_SERVICE_ROLE_KEY\./);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('adds a run hint only when a command is given', () => {
    expect(missingKeyMessage()).toBe(
      'Missing SUPABASE_SERVICE_ROLE_KEY.\n' +
        'Find it in the Supabase dashboard: Project Settings → API → service_role key.',
    );
    expect(missingKeyMessage('node scripts/upload-packs.mjs').split('\n').at(-1)).toBe(
      'Run: SUPABASE_SERVICE_ROLE_KEY=... node scripts/upload-packs.mjs',
    );
  });

  it('requires a fetch implementation', () => {
    expect(() => createSupabaseAdmin({ env: { SUPABASE_SERVICE_ROLE_KEY: SECRET_KEY }, fetchImpl: null }))
      .toThrow('No fetch implementation is available');
  });
});

describe('URL validation', () => {
  it.each([
    'https://abc.supabase.co',
    'https://abc.supabase.co/',
    'https://localhost:54321',
  ])('accepts %s', url => {
    expect(validateSupabaseUrl(url)).toBe(url.replace(/\/$/, ''));
  });

  it.each([
    'http://abc.supabase.co',
    'abc.supabase.co',
    '',
    'https://user:pass@abc.supabase.co',
    'https://abc.supabase.co/rest/v1',
    'https://abc.supabase.co?x=1',
    'https://abc.supabase.co/?',
    'https://abc.supabase.co#frag',
  ])('rejects %j', url => {
    expect(() => validateSupabaseUrl(url)).toThrow('SUPABASE_URL must be an HTTPS project URL.');
  });

  it('validates the environment URL when building a client', () => {
    expect(() => admin({ SUPABASE_URL: 'http://abc.supabase.co', SUPABASE_SERVICE_ROLE_KEY: SECRET_KEY }))
      .toThrow(SupabaseConfigError);
  });
});

describe('headers', () => {
  it('sends new sb_secret_ keys on apikey only', () => {
    expect(supabaseAuthHeaders(SECRET_KEY)).toEqual({ apikey: SECRET_KEY });
  });

  it('also sends legacy service_role JWTs as a Bearer token', () => {
    expect(supabaseAuthHeaders(LEGACY_KEY)).toEqual({
      apikey: LEGACY_KEY,
      Authorization: `Bearer ${LEGACY_KEY}`,
    });
  });

  it('merges caller headers without letting them override auth', () => {
    const { client } = admin({ SUPABASE_SERVICE_ROLE_KEY: SECRET_KEY });
    expect(client.headers({ Prefer: 'return=minimal', apikey: 'other' })).toEqual({
      Prefer: 'return=minimal',
      apikey: SECRET_KEY,
    });
  });
});

describe('rest and storage requests', () => {
  const env = { SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_SERVICE_ROLE_KEY: LEGACY_KEY };

  it('builds REST URLs and passes the request through with auth headers', async () => {
    const { client, fetchImpl } = admin(env);
    expect(client.restUrl('plays?mode=eq.name')).toBe('https://abc.supabase.co/rest/v1/plays?mode=eq.name');
    await client.rest('quizzes', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: '[]' });
    expect(fetchImpl).toHaveBeenCalledWith('https://abc.supabase.co/rest/v1/quizzes', {
      method: 'POST',
      headers: { Prefer: 'return=minimal', apikey: LEGACY_KEY, Authorization: `Bearer ${LEGACY_KEY}` },
      body: '[]',
    });
  });

  it('builds Storage URLs', async () => {
    const { client, fetchImpl } = admin(env);
    expect(client.storageUrl('bucket')).toBe('https://abc.supabase.co/storage/v1/bucket');
    const bytes = Buffer.from('png');
    await client.storage('object/pack-images/costco/a.png', { method: 'POST', body: bytes });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://abc.supabase.co/storage/v1/object/pack-images/costco/a.png',
      { method: 'POST', headers: { apikey: LEGACY_KEY, Authorization: `Bearer ${LEGACY_KEY}` }, body: bytes },
    );
  });

  it('defaults to GET with only auth headers', async () => {
    const { client, fetchImpl } = admin({ ...env, SUPABASE_SERVICE_ROLE_KEY: SECRET_KEY });
    await client.rest('leaderboard');
    expect(fetchImpl).toHaveBeenCalledWith('https://abc.supabase.co/rest/v1/leaderboard', {
      headers: { apikey: SECRET_KEY },
    });
  });
});

describe('secret redaction', () => {
  it('summarizes structured errors and redacts the key', async () => {
    const { client } = admin({ SUPABASE_SERVICE_ROLE_KEY: SECRET_KEY });
    const response = {
      text: async () => JSON.stringify({ code: '42501', message: `denied for ${SECRET_KEY}`, hint: null, extra: 'x' }),
    };
    expect(await client.summarizeError(response)).toBe('code=42501; message=denied for [redacted]');
  });

  it('redacts plain-text bodies, collapses whitespace, and caps length', () => {
    expect(summarizeErrorBody(`bad\n  key ${SECRET_KEY} here`, SECRET_KEY)).toBe('bad key [redacted] here');
    expect(summarizeErrorBody('x'.repeat(2000), SECRET_KEY)).toHaveLength(500);
  });

  it('redacts every occurrence of the key in arbitrary text', () => {
    const { client } = admin({ SUPABASE_SERVICE_ROLE_KEY: SECRET_KEY });
    expect(client.redact(`${SECRET_KEY}/${SECRET_KEY}`)).toBe('[redacted]/[redacted]');
  });

  it('returns an empty summary for unreadable bodies', async () => {
    const { client } = admin({ SUPABASE_SERVICE_ROLE_KEY: SECRET_KEY });
    expect(await client.summarizeError({ ok: false })).toBe('');
    expect(await client.summarizeError({ text: async () => { throw new Error(SECRET_KEY); } })).toBe('');
  });
});
