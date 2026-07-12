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

The frontend and scoring are pack-agnostic: each round randomly samples up to
**10** items (`ROUND_MAX_ITEMS` in `guess-the-price.js`), shows `ITEM n / N`, and
scores each with the exponential falloff (`K=0.35`). No per-pack config — a pack
can hold as many items as you like; a big pack just plays a fresh random 10 each
round.

All commands below run from the repo root.

## Workflow

```
- [ ] 1. Author  data/packs/<slug>.data.json  (incl. each item's image_url)
- [ ] 2. (Photos) Save one file per item to data/pack-images/<slug>/
- [ ] 3. Register the file in scripts/upload-packs.mjs (PACKS array)
- [ ] 4. (Recommended) Add the pack label to manifest.js modes; update its test
- [ ] 5. (Photos) Publish images: node scripts/upload-pack-images.mjs
- [ ] 6. Publish content: node scripts/upload-packs.mjs  (NOT npm run)
- [ ] 7. Verify live via the anon key (rows + image URLs return 200)
- [ ] 8. Preview locally / note what ships on merge
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
- `image_url` — the item photo. Either `null` (frame shows "No image") or a hosted
  URL rendered `object-fit: cover`. To host photos see **Item images** below; the
  Storage URL is deterministic, so fill it in here before the file is uploaded.
- `sort_order` — integer controlling selector order (`0` = first card). Renumber
  the other packs' seed files if you need to slot one ahead of them.
- Item count is flexible and can be large — each round samples 10 (see above), so
  a big, varied pack plays well. The starter pack ships 19.

Seed files under `data/packs/` **and** photos under `data/pack-images/` are
**git-ignored** (like `data/quizzes/`) — they are upload source, not served or
tracked assets. Keep them on disk locally.

### Item images
Photos live in the public Supabase Storage bucket `pack-images`, **not** in git.
`scripts/upload-pack-images.mjs` creates the bucket (idempotent) and uploads
everything under `data/pack-images/<slug>/`.

1. Save one file per item to `data/pack-images/<slug>/<name>.<ext>`. Keep the
   extension matching the actual bytes (`file <img>` to check) — some CDNs serve
   JPEG at a `.png` URL, and the uploader sets the Storage content-type from the
   extension.
2. Set each `image_url` to the deterministic public URL:
   `https://iveomuwigelmyjbxpykx.supabase.co/storage/v1/object/public/pack-images/<slug>/<file>`
3. Publish with `node scripts/upload-pack-images.mjs` (same service-role key +
   `node`-not-`npm` caveat as step 6). Re-runnable: every object is upserted.

Sourcing a photo from a product link:
- `curl` the page — `og:image` / JSON-LD `image` is often right there. But many
  retailers (Nike, Ray-Ban, Levi's, Le Creuset, Nintendo…) hard-block bots and
  return a tiny challenge shell.
- For those, drive the in-IDE browser (`cursor-ide-browser`): `browser_navigate`,
  then `browser_cdp` → `Runtime.evaluate` to read `og:image`, JSON-LD `image`, or
  the largest `<img>`. A real browser clears the challenge.
- Amazon (search or product page) is a reliable fallback for a clean white-bg
  product shot when the brand site is blocked or the link is a category/news page.
- Download the chosen CDN URL with `curl` (image CDNs are usually not bot-gated
  even when their HTML is) and eyeball each file before publishing.

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
node scripts/upload-pack-images.mjs   # only if the pack has photos; run FIRST
node scripts/upload-packs.mjs
```

Publish images **before** content so every `image_url` resolves the moment the
pack goes live. Both scripts share the same key and the same `node`-not-`npm`
caveat.

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
curl -sS "$BASE/pack_items?pack_slug=eq.<slug>&select=name,price,image_url,sort_order&order=sort_order" \
  -H "apikey: $ANON" -H "Authorization: Bearer $ANON"
```

Expect the new pack in the list and its items in `sort_order`. If the pack has
photos, confirm one `image_url` actually serves an image:

```bash
curl -s -o /dev/null -w "%{http_code} %{content_type}\n" \
  "https://iveomuwigelmyjbxpykx.supabase.co/storage/v1/object/public/pack-images/<slug>/<file>"
# expect: 200 image/jpeg (or image/png)
```

### 6. Preview / go live
- The selector is DB-driven, so the pack **appears immediately** after upload —
  no deploy needed to try it. Preview against the live DB:
  ```bash
  python3 -m http.server 8000 --directory fe-artifacts
  # http://localhost:8000/games/guess-the-price.html
  ```
  A server may already be running on :8000 (`Address already in use` just means
  it's up — check `lsof -nP -iTCP:8000 -sTCP:LISTEN` before starting another).
- Public site (`jpentakalos.com`) serves frontend code from `origin/main` only.
  Pack **content** is already live via the DB regardless of branch; a
  `manifest.js` label change only ships once merged to `main` (see
  `personal-dev-setup` for the deploy pipeline).

## Editing an existing pack
Same flow: edit `data/packs/<slug>.data.json` (change prices, add/remove/reorder
items), keep the `slug` unchanged, and re-run the publish step. The wholesale item
replace makes removals and reorders take effect cleanly. If you added or swapped a
photo, drop the file in `data/pack-images/<slug>/` and re-run
`node scripts/upload-pack-images.mjs` too (objects are upserted).
