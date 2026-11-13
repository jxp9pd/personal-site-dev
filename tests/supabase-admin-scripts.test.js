// @vitest-environment node
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createScriptSandbox } from './helpers/script-sandbox.mjs';

const URL = 'https://example.supabase.co';
const LEGACY_KEY = 'eyJlegacy.test.jwt';
const SECRET_KEY = 'sb_secret_test_only';

const SCRIPTS = {
  'publish-atlas.mjs': {
    args: ['--city', 'sf', '--fixture', 'atlas-fixture'],
    requests: [['POST', '/rest/v1/atlas_features?on_conflict=source%2Csource_id']],
  },
  'reset-name-leaderboard.mjs': {
    args: ['--confirm'],
    requests: [
      ['HEAD', '/rest/v1/plays?mode=eq.name&game_id=in.(sf-neighborhoods,seattle-neighborhoods,dc-neighborhoods,fairfax-neighborhoods,manhattan-neighborhoods)&select=id'],
      ['DELETE', '/rest/v1/plays?mode=eq.name&game_id=in.(sf-neighborhoods,seattle-neighborhoods,dc-neighborhoods,fairfax-neighborhoods,manhattan-neighborhoods)'],
      ['HEAD', '/rest/v1/plays?mode=eq.name&game_id=in.(sf-neighborhoods,seattle-neighborhoods,dc-neighborhoods,fairfax-neighborhoods,manhattan-neighborhoods)&select=id'],
    ],
  },
  'upload-packs.mjs': {
    args: [],
    requests: ['wearables', 'groceries', 'starter-pack', 'costco'].flatMap(slug => [
      ['POST', '/rest/v1/packs'],
      ['DELETE', `/rest/v1/pack_items?pack_slug=eq.${slug}`],
      ['POST', '/rest/v1/pack_items'],
    ]),
  },
  'upload-quizzes.mjs': { args: [], requests: [['POST', '/rest/v1/quizzes']] },
  'upload-pack-images.mjs': {
    args: [],
    requests: [
      ['POST', '/storage/v1/bucket'],
      ['POST', '/storage/v1/object/pack-images/costco/a.png'],
      ['POST', '/storage/v1/object/pack-images/costco/b.jpg'],
      ['POST', '/storage/v1/object/pack-images/wearables/c.webp'],
    ],
  },
};

let sandbox;
beforeAll(async () => {
  sandbox = await createScriptSandbox(path.resolve('.'));
});
afterAll(() => sandbox?.remove());

describe.each(Object.entries(SCRIPTS))('%s', (script, { args, requests }) => {
  it('sends the expected requests with Bearer auth for legacy JWT keys', async () => {
    const result = await sandbox.run(script, args, { SUPABASE_URL: URL, SUPABASE_SERVICE_ROLE_KEY: LEGACY_KEY });
    expect(result.status).toBe(0);
    expect(result.requests.map(({ method, url }) => [method, url])).toEqual(
      requests.map(([method, pathname]) => [method, URL + pathname]),
    );
    for (const request of result.requests) {
      expect(request.headers).toMatchObject({ apikey: LEGACY_KEY, authorization: `Bearer ${LEGACY_KEY}` });
    }
  });

  it('sends sb_secret_ keys on apikey only', async () => {
    const result = await sandbox.run(script, args, { SUPABASE_URL: URL, SUPABASE_SERVICE_ROLE_KEY: SECRET_KEY });
    expect(result.status).toBe(0);
    expect(result.requests).toHaveLength(requests.length);
    for (const request of result.requests) {
      expect(request.headers.apikey).toBe(SECRET_KEY);
      expect(request.headers).not.toHaveProperty('authorization');
    }
  });

  it('exits before any request when the key is missing', async () => {
    const result = await sandbox.run(script, args, { SUPABASE_URL: URL });
    expect(result.status).toBe(1);
    expect(result.requests).toEqual([]);
    expect(result.stderr).toMatch(/^Missing SUPABASE_SERVICE_ROLE_KEY/);
  });

  it('rejects a non-HTTPS project URL before any request', async () => {
    const result = await sandbox.run(script, args, {
      SUPABASE_URL: 'http://example.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: SECRET_KEY,
    });
    expect(result.status).toBe(1);
    expect(result.requests).toEqual([]);
    expect(result.stderr).toContain('SUPABASE_URL must be an HTTPS project URL.');
  });

  it('never prints the key when the API echoes it back in an error', async () => {
    const result = await sandbox.run(script, args, {
      SUPABASE_URL: URL,
      SUPABASE_SERVICE_ROLE_KEY: SECRET_KEY,
      MOCK_STATUS: '500',
      MOCK_BODY: JSON.stringify({ message: `bad key ${SECRET_KEY}` }),
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('[redacted]');
    expect(result.stdout + result.stderr).not.toContain(SECRET_KEY);
  });
});
