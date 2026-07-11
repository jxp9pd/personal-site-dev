# Supabase backend

This directory holds the SQL migrations for the site's user profiles + game
history backend (hosted Postgres + Auth + Row-Level Security).

- `migrations/0001_profiles_and_plays.sql` — `profiles` and `plays` tables, RLS
  policies, and the `auth.users` → `profiles` creation trigger.

## How to apply & verify (HITL)

You (the human) apply this migration against the live Supabase project and run
the verification checks below. The agent cannot do this — it has no credentials.

### Step 0 — Disable email confirmation (Dashboard, not SQL)

Email confirmation is an Auth **project setting**, not something this SQL
migration can express. In the Supabase Dashboard:

> **Authentication → Sign In / Providers → Email → toggle OFF "Confirm email"**

This lets signups create a session immediately so the four checks below can be
run without an inbox round-trip.

### Step 1 — Apply the migration

Either paste the file into the Dashboard **SQL Editor** and run it, or use the
CLI from the repo root:

```bash
supabase db push
# or, applying the single file directly against your project's connection string:
psql "$SUPABASE_DB_URL" -f supabase/migrations/0001_profiles_and_plays.sql
```

The migration is re-runnable (`create table if not exists`, `drop policy if
exists`, `drop trigger if exists`, `create or replace function`).

### Verification checks

Run each against the live project and confirm the expected result.

#### Check 1 — Trigger auto-creates a profile

Create an auth user with a `username` in signup metadata, then confirm a
matching `profiles` row appeared automatically.

Easiest via the JS SDK from a browser console / small script:

```js
await supabase.auth.signUp({
  email: 'alice@example.com',
  password: 'correct-horse-battery-staple',
  options: { data: { username: 'Alice' } },
});
```

Then in the SQL Editor:

```sql
select p.user_id, p.username, p.created_at
from public.profiles p
join auth.users u on u.id = p.user_id
where u.email = 'alice@example.com';
```

**Expected:** exactly one row, `username = 'Alice'`. (Trigger works.)

#### Check 2 — Case-insensitive username uniqueness

With `Alice` already registered, attempt to insert a differing-only-by-case
username directly:

```sql
-- Reuse Alice's user_id; only the username case differs.
insert into public.profiles (user_id, username)
select user_id, 'alice'
from public.profiles
where username = 'Alice';
```

**Expected:** error —
`duplicate key value violates unique constraint "profiles_username_lower_key"`.
(A real second signup with username `alice` would likewise fail; the trigger
insert raises inside the signup and rolls it back.)

#### Check 3 — Public read with the anon key

Using the project's **anon** public key (no authenticated session), both selects
must succeed:

```js
const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
console.log(await anon.from('profiles').select('*')); // -> { data: [...], error: null }
console.log(await anon.from('plays').select('*'));     // -> { data: [...], error: null }
```

**Expected:** both return data with `error: null`. (Public read policy works;
note no email column exists to leak.)

#### Check 4 — RLS blocks cross-user inserts

Authenticated as user A, attempt to insert a `plays` row carrying user **B's**
`user_id`. From an authenticated SDK session for user A:

```js
// bId = some other user's id (user B)
const { error } = await supabase.from('plays').insert({
  user_id: bId,
  game_id: 'sf-neighborhoods',
  mode: 'find',
  score: 5,
  total: 10,
});
console.log(error); // -> row-level security policy violation
```

**Expected:** insert is rejected — `new row violates row-level security policy
for table "plays"`. Inserting with A's *own* `user_id` should succeed.

---

**Validation gate for trace T1 is HITL.** The four checks above must be run and
confirmed by the human against the live Supabase project before T1 is
considered done.
