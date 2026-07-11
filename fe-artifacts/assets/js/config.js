// Public Supabase project config.
//
// The anon (publishable) key is public by design and is safe to ship in
// client code: it only grants what Row-Level Security allows. RLS on the
// `profiles`/`plays` tables (public read, owner-only write) is the actual
// security boundary — this key is not a secret.

export const SUPABASE_URL = 'https://iveomuwigelmyjbxpykx.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_Y8HLbe2M_uxK_hjq6WOr3g_XEspZPne';
