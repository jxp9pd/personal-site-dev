---
name: neighborhood-quiz
description: >-
  Build a "Neighborhoods of <City>" geography quiz for fe-artifacts/games: find
  a basemap + neighborhood boundary GeoJSON, curate it into a set of recognizable
  neighborhoods, and emit a quiz data.json matching the SF quiz. Use when the
  user wants a new city/neighborhood quiz, mentions neighborhood boundaries, or
  says "make a neighborhoods quiz for <place>".
disable-model-invocation: true
---

# Neighborhood quiz builder

Produces `fe-artifacts/games/<city>-neighborhoods-quiz.data.json` (and the quiz page)
in the exact shape of the existing `sf-neighborhoods-quiz.html` / `.data.json`. The user
usually just names a city; the hard part is sourcing boundaries and curating them into a
set the user is happy with.

**The two human-in-the-loop gates are steps 3 (pick the base source) and 5 (merging).**
Everything else can run without check-ins.

Reusable pieces live in `scripts/`:
- `build_quiz_data.py` — simplify, geo-cut, and merge/dissolve raw GeoJSON into the quiz format.
- `mockup.html` — dark Leaflet map to eyeball candidate sources and curation stages.

See `reference.md` for source-hunting, the `config.json` schema, and the merge subagent prompt.

## Workflow

```
- [ ] 1. Basemap: center/zoom for the city
- [ ] 2. Sources: fetch 2-3 candidate neighborhood GeoJSONs
- [ ] 3. Review: build mockup, screenshot, pick a base source WITH the user  [HITL]
- [ ] 4. Geo cut: (optional) apply user cutoffs (lat/lon lines) if they ask
- [ ] 5. Merge: ask if they want to merge micro-hoods; if so, subagent + repeat  [HITL]
- [ ] 6. Emit: final data.json (dissolved) + wire up the quiz page
- [ ] 7. Clean up scratch
```

Work in a scratch dir (e.g. `/tmp/<city>-quiz/`) for raw downloads and config.

### 1. Basemap
Basemap is CartoDB `dark_nolabels` (unchanged from SF). Center/zoom is per-city — step 6
prints a suggested center from the data. Don't reuse SF's hardcoded values.

### 2. Sources
Web-search 2-3 candidate boundary sets and download them. Prefer official ArcGIS Hub
`.geojson`, then community repos. See `reference.md` § "Finding neighborhood boundary
GeoJSON" for URL patterns and gotchas (Socrata `href` export failures, metro-scoped
community data needing a `city_filter`).

### 3. Review candidates
Write a `config.json` (schema in `reference.md`) listing the sources, then:
```
python3 scripts/build_quiz_data.py mockup config.json mockup.data.json
python3 -m http.server 8747   # from the scratch dir
```
Open `mockup.html?data=mockup.data.json&center=<lat>,<lon>,<zoom>`, screenshot each tab,
and decide the base source with the user. Official "districts" are usually too coarse
(~20), fine "neighborhoods" too many (~90) — you'll curate the fine set down.

### 4. Geographic cut (optional)
Only if the user asks to trim by geography ("nothing north of Green Lake"). Look up the
anchor neighborhood's centroid latitude/longitude, set `geo_cut` bounds in config, rerun
`mockup` to show the `curated` tab, and report the new count. Skip this step entirely if
the user doesn't ask for it.

### 5. Merge micro-neighborhoods (HITL loop)
Ask the user whether they want to merge micro-neighborhoods. There is **no target count** —
it's their call how consolidated the set should be. If yes, delegate a merge proposal to a
subagent using the prompt and decision logic in `reference.md` § "Delegating
micro-neighborhood merging" (fold sub-hoods into the recognizable parent; when merging
peers, name after the largest population; keep culturally distinct hoods separate).
**Present the proposed `merges`, apply the user's edits verbatim, and never finalize merges
silently.** Add the agreed mapping to `config.json`, rerun `mockup`, and review the `merged`
tab (borders should be dissolved, no seams). Re-run the subagent as many times as the user
asks — this is an iterate-until-they're-happy loop, not a one-shot.

### 6. Emit + wire up
```
python3 scripts/build_quiz_data.py final config.json \
  fe-artifacts/games/<city>-neighborhoods-quiz.data.json
```
All cities share one page, `fe-artifacts/games/neighborhoods-quiz.html`, which renders a
city selector and loads a city via `?city=<slug>`. To register a new city, don't clone HTML —
just add it in two places:
- `fe-artifacts/games/neighborhoods-quiz.html` → the `CITIES` registry: `<slug>-neighborhoods`
  with `name`, `desc`, `data` (the data.json filename), `center` (printed by `final`), and
  `zoom` (12 for a city-core band, 11 for a whole city).
- `fe-artifacts/assets/js/manifest.js` → a `GAMES` entry keyed by the same slug so completed
  plays are tracked and show on the profile page.

The `/games/index.html` "Neighborhoods Quiz" entry already points at the shared page, so it
only needs a copy tweak if you want the new city named in its blurb.

### 7. Clean up
Delete the scratch dir (raw downloads, config, mockup data, venv). Only the final
`<city>-neighborhoods-quiz.data.json` and quiz HTML ship.

## shapely setup (dissolve requires it)
Externally-managed Python needs a venv:
```
python3 -m venv venv && venv/bin/pip install shapely
venv/bin/python scripts/build_quiz_data.py final config.json out.json
```
