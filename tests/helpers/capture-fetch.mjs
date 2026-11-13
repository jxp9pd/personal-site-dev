// Preloaded with `node --import` to run an admin script against a fake
// Supabase: records every request to $CAPTURE_FILE and answers with
// $MOCK_STATUS / $MOCK_BODY. No network access.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const requests = [];
const status = Number(process.env.MOCK_STATUS || 200);
const body = process.env.MOCK_BODY ?? '[]';

function describeBody(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') {
    return value.replace(/"updated_at":"[^"]*"/g, '"updated_at":"<now>"');
  }
  const bytes = Buffer.from(value);
  return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

globalThis.fetch = async (url, init = {}) => {
  const headers = Object.fromEntries(
    Object.entries(init.headers ?? {})
      .map(([name, value]) => [name.toLowerCase(), String(value)])
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  requests.push({ method: init.method ?? 'GET', url: String(url), headers, body: describeBody(init.body) });
  writeFileSync(process.env.CAPTURE_FILE, JSON.stringify(requests, null, 2));
  const method = init.method ?? 'GET';
  return new Response(method === 'HEAD' ? null : body, {
    status,
    headers: { 'content-range': '*/0', 'content-type': 'application/json' },
  });
};
