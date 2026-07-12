---
name: guess-the-price-packs
description: >-
  Add or update a "pack" (themed set of priced items) for the Guess the Price
  game in personal-site-dev: author the seed JSON, register it in the uploader,
  publish it to Supabase, and verify it live. Use when the user wants a new pack,
  says "add a pack", "upload packs", "new set for guess the price", or wants to
  edit an existing pack's items/prices.
disable-model-invocation: true
---

# Guess the Price — packs

Adds a pack to the Guess the Price game. A pack is one themed set of priced items
(e.g. Wearables, Groceries). All packs share the single `guess-the-price` game;
**a pack is a game "mode"**, keyed by its slug, and the recorded play's `mode` is
that slug.

Content lives in the Supabase `packs` / `pack_items` tables, **not** in served
files. The selector (`fe-artifacts/games/guess-the-price.html` +
`guess-the-price.js`) reads packs from the DB, so adding a pack is a DB upsert —
no HTML edit, and the schema already exists (migration `0006_packs.sql`, so a new
pack **never** needs a migration).

The frontend and scoring are pack-agnostic: the game shuffles whatever items a
pack has, shows `ITEM n / N`, and scores each with the exponential falloff
(`K=0.35`). No per-pack config.

All commands below run from the repo root.

## Workflow

```
- [ ] 1. Author  data/packs/<slug>.data.json
- [ ] 2. Register the file in scripts/upload-packs.mjs (PACKS array)
- [ ] 3. (Recommended) Add the pack label to manifest.js modes; update its test
- [ ] 4. Publish: node scripts/upload-packs.mjs  (NOT npm run)
- [ ] 5. Verify live via the anon key
- [ ] 6. Preview locally / note what ships on merge
```

### 1. Author the seed file
`data/packs/<slug>.data.json`:

```json
{
  "slug": "electronics",
  "name": "Electronics",
  "description": "Gadgets and gizmos — price the tech in your cart.",
  "sort_order": 2,
  "items": [
    { "name": "AirPods Pro (2nd gen)", "price": 249.00, "image_url": null }
  ]
}
```

- `slug` — lowercase-hyphenated, unique, **stable** (it is the recorded play
  `mode`; changing it later orphans past plays).
- `price` — a number in dollars (stored as `numeric(10,2)`).
- `image_url` — `null` unless hosting an image; when set, the item frame renders
  it `object-fit: cover`.
- `sort_order` — integer controlling selector order; use the next value after the
  existing packs.
- Item count is flexible (the game adapts to any N). Match the existing packs
  (5) unless the user wants otherwise.

Seed files under `data/packs/` are **git-ignored** (like `data/quizzes/`) — they
are upload source, not served assets. Keep them on disk locally.

### 2. Register in the uploader
Add the file to the `PACKS` array in `scripts/upload-packs.mjs`:

```js
const PACKS = [
  { file: 'wearables.data.json' },
  { file: 'groceries.data.json' },
  { file: 'electronics.data.json' },
];
```

### 3. Add the display label (recommended)
In `fe-artifacts/assets/js/manifest.js`, add the pack to the `guess-the-price`
`modes` map so the profile page shows a readable label instead of the raw slug:

```js
'guess-the-price': {
  name: 'Guess the Price',
  category: 'Guess the Price',
  modes: { wearables: 'Wearables', groceries: 'Groceries', electronics: 'Electronics' },
},
```

Plays still save without this (the label just falls back to the slug on the
profile), but keep it in sync. If you change the `modes` map, update the
`guess-the-price` assertions in `tests/manifest.test.js` and run `npm test`.

### 4. Publish
Idempotent: packs upsert on `slug`; each pack's items are deleted then
re-inserted, so re-running just refreshes. Fetch the service-role key on demand
and run with **`node` directly, not `npm run`** — Socket Firewall wraps npm and
breaks the TLS fetch to Supabase (`fetch failed`). Key handling details are in
the `personal-dev-setup` skill.

```bash
export SUPABASE_SERVICE_ROLE_KEY="$(supabase projects api-keys \
  --project-ref iveomuwigelmyjbxpykx --reveal --output-format json 2>/dev/null \
  | jq -r '.keys[] | select(.name=="service_role" and .type=="legacy") | .api_key')"
node scripts/upload-packs.mjs
```

The service-role key is the secret one (never the `sb_publishable_...` anon key in
`config.js`); it is re-fetchable and never stored at rest.

### 5. Verify live
Read back with the public anon key (packs are public-read; anon writes are
blocked by RLS):

```bash
ANON="sb_publishable_Y8HLbe2M_uxK_hjq6WOr3g_XEspZPne"
BASE="https://iveomuwigelmyjbxpykx.supabase.co/rest/v1"
curl -sS "$BASE/packs?select=slug,name,sort_order&order=sort_order" \
  -H "apikey: $ANON" -H "Authorization: Bearer $ANON"
curl -sS "$BASE/pack_items?pack_slug=eq.<slug>&select=name,price,sort_order&order=sort_order" \
  -H "apikey: $ANON" -H "Authorization: Bearer $ANON"
```

Expect the new pack in the list and its items in `sort_order`.

### 6. Preview / go live
- The selector is DB-driven, so the pack **appears immediately** after upload —
  no deploy needed to try it. Preview against the live DB:
  ```bash
  python3 -m http.server 8000 --directory fe-artifacts
  # http://localhost:8000/games/guess-the-price.html
  ```
- Public site (`jpentakalos.com`) serves frontend code from `origin/main` only.
  Pack **content** is already live via the DB regardless of branch; a
  `manifest.js` label change only ships once merged to `main` (see
  `personal-dev-setup` for the deploy pipeline).

## Editing an existing pack
Same flow: edit `data/packs/<slug>.data.json` (change prices, add/remove/reorder
items), keep the `slug` unchanged, and re-run step 4. The wholesale item replace
makes removals and reorders take effect cleanly.
