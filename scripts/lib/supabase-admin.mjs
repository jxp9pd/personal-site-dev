// Shared service-role access for the Node admin/publish scripts. Mirrors the
// Python gateway client (services/vestaboard/supabase_rest.py): one env/config
// resolution, one missing-key error, one header policy, and error text that
// never contains the key. Browser code uses fe-artifacts/assets/js/dataClient.js.

import process from 'node:process';
import { SUPABASE_URL as CONFIG_SUPABASE_URL } from '../../fe-artifacts/assets/js/config.js';

export class SupabaseConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SupabaseConfigError';
  }
}

export function missingKeyMessage(command) {
  const lines = [
    'Missing SUPABASE_SERVICE_ROLE_KEY.',
    'Find it in the Supabase dashboard: Project Settings → API → service_role key.',
  ];
  if (command) lines.push(`Run: SUPABASE_SERVICE_ROLE_KEY=... ${command}`);
  return lines.join('\n');
}

export function validateSupabaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    parsed = null;
  }
  if (
    !parsed ||
    parsed.protocol !== 'https:' ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash ||
    /[?#]/.test(value)
  ) {
    throw new SupabaseConfigError('SUPABASE_URL must be an HTTPS project URL.');
  }
  return parsed.origin;
}

// New sb_secret_ keys are not JWTs and belong on `apikey` only; legacy
// service_role JWTs (eyJ...) also go on Authorization, as in supabase_rest.py.
export function supabaseAuthHeaders(key) {
  const headers = { apikey: key };
  if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`;
  return headers;
}

// Accepts any fetch HeadersInit (object, Headers, or [name, value] pairs).
// Auth headers always win, whatever case the caller used.
function mergeHeaders(extra, auth) {
  const entries =
    extra && typeof extra[Symbol.iterator] === 'function'
      ? [...new Headers(extra)]
      : Object.entries(extra ?? {});
  const authNames = new Set(Object.keys(auth).map(name => name.toLowerCase()));
  return {
    ...Object.fromEntries(entries.filter(([name]) => !authNames.has(name.toLowerCase()))),
    ...auth,
  };
}

export function redactSecret(text, secret) {
  const value = String(text);
  return secret ? value.split(secret).join('[redacted]') : value;
}

export function summarizeErrorBody(body, secret) {
  let summary;
  try {
    const parsed = JSON.parse(body);
    summary = ['code', 'message', 'details', 'hint']
      .filter(key => parsed?.[key] !== undefined && parsed[key] !== null)
      .map(key => `${key}=${String(parsed[key])}`)
      .join('; ');
  } catch {
    summary = String(body).replace(/\s+/g, ' ').trim();
  }
  return redactSecret(summary, secret).slice(0, 500);
}

export async function summarizeErrorResponse(response, secret) {
  if (typeof response?.text !== 'function') return '';
  let body;
  try {
    body = await response.text();
  } catch {
    return '';
  }
  return summarizeErrorBody(body, secret);
}

export function createSupabaseAdmin({
  env = process.env,
  fetchImpl = globalThis.fetch,
  command,
} = {}) {
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new SupabaseConfigError(missingKeyMessage(command));
  if (typeof fetchImpl !== 'function') {
    throw new Error('No fetch implementation is available');
  }
  const url = validateSupabaseUrl(env.SUPABASE_URL || CONFIG_SUPABASE_URL);

  const headers = extra => mergeHeaders(extra, supabaseAuthHeaders(key));
  const restUrl = path => `${url}/rest/v1/${path}`;
  const storageUrl = path => `${url}/storage/v1/${path}`;
  const send = (target, init = {}) =>
    fetchImpl(target, { ...init, headers: headers(init.headers) });

  return {
    url,
    headers,
    restUrl,
    storageUrl,
    rest: (path, init) => send(restUrl(path), init),
    storage: (path, init) => send(storageUrl(path), init),
    redact: text => redactSecret(text, key),
    summarizeError: response => summarizeErrorResponse(response, key),
    summarizeErrorBody: body => summarizeErrorBody(body, key),
  };
}

// For top-level CLI scripts: print the config error and exit 1, as before.
export function createSupabaseAdminOrExit(options) {
  try {
    return createSupabaseAdmin(options);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
