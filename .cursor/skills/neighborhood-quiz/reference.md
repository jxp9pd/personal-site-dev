# Reference: sources, config, and merge delegation

## Finding neighborhood boundary GeoJSON

There is rarely one canonical set. Web-search for 2-3 candidates and prefer, in order:

1. **Official city open-data (ArcGIS Hub).** Many portals (data.<city>.gov) are Socrata
   pages that only *link* to ArcGIS — the Socrata `.geojson` export fails with
   "Unexportable view type: href". Get the real data from the ArcGIS Hub download:
   ```
   https://<org>.opendata.arcgis.com/datasets/<ORG>::<dataset-slug>.geojson
   ```
   Cities often publish two useful layers: coarse **districts** (~15-25, quiz-friendly
   count but vague names) and fine **neighborhoods** (~80-130, recognizable but too many).
2. **Community repos** (e.g. `seattleio/seattle-boundaries-data` neighborhoods.geojson).
   Often Zillow-derived and region-scoped (whole metro), so filter to the city via a
   property (`city_filter` in config).
3. **Zillow / Statistical Atlas** as a fallback.

Always compare candidates visually before committing (see mockup step in SKILL.md).

## Map center / zoom

Basemap is CartoDB `dark_nolabels` (same as the SF quiz). Do NOT reuse SF's hardcoded
center. `build_quiz_data.py final` prints a suggested `[lat,lon]` (bbox center of the
final set). Zoom 12 fits a curated city-core band; 11 fits a whole city.

## config.json schema

```json
{
  "sources": {
    "neighborhoods": {"file": "raw/atlas_neighborhoods.geojson", "name_key": "S_HOOD", "label": "Official Neighborhoods"},
    "districts":     {"file": "raw/atlas_districts.geojson",      "name_key": "L_HOOD", "label": "Official Districts"},
    "community":     {"file": "raw/community.geojson", "name_key": "name", "label": "Community",
                      "city_filter": {"key": "city", "value": "Seattle"}}
  },
  "base_source": "neighborhoods",
  "geo_cut": {"min_lat": 47.576, "max_lat": 47.6906},
  "merges": {
    "Ballard": ["Ballard", "West Woodland", "Loyal Heights", "Whittier Heights"],
    "Queen Anne": ["North Queen Anne", "East Queen Anne", "West Queen Anne", "Lower Queen Anne"]
  },
  "simplify_tol": 0.00035,
  "precision": 5
}
```

- `geo_cut` bounds are optional (`min_lat`/`max_lat`/`min_lon`/`max_lon`), applied on each
  feature's bbox-center. Use it for user cutoffs like "nothing north of Green Lake" —
  look up the anchor neighborhood's centroid latitude to pick the number.
- `merges` maps a canonical name to the raw `name_key` values folded into it. Names not
  listed pass through unchanged. Merges are dissolved via raw-geometry union.
- Paths in `file` are relative to config.json's directory.

## Delegating micro-neighborhood merging to a subagent

Merging is optional and user-driven — ask first, and don't chase any particular count.
When the user wants to consolidate, delegate a merge proposal to a subagent (Task tool,
`explore` or `generalPurpose`). Give it the neighbor list and this decision logic; have it
return a `merges` mapping. The user makes the final call — present the proposal, don't
apply silently — and you may re-run the subagent as many times as they ask.

### Subagent prompt template

```
You are curating a "<CITY>" neighborhoods geography quiz. Here is the current list of
<N> neighborhoods (after geographic trimming):

<comma-separated names, optionally with centroid lat/lon>

Propose a `merges` mapping that consolidates only the obvious micro-/sub-neighborhoods
into recognizable answers, following this decision logic:

1. Fold a sub-neighborhood into the RECOGNIZABLE PARENT locals would name
   (e.g. "West Woodland" -> "Ballard", "North/East/West Queen Anne" -> "Queen Anne").
2. When merging peers with no clear parent, name the group after the one with the
   LARGEST POPULATION / strongest name recognition (verify population by web search
   if unsure; cite the numbers).
3. KEEP culturally distinct neighborhoods separate even when small — a good quiz wants
   Fremont, Wallingford, Belltown, Pioneer Square, etc. as their own answers.
4. Prefer folding tiny slivers / industrial / institutional polygons into an adjacent
   named neighborhood (e.g. a campus into its district, a harbor island into the
   industrial zone).
5. There is NO target count — consolidate what's clearly a micro/sub-hood and leave the
   rest. Don't over-merge into vague mega-districts. The user decides how far to go and
   may ask for more merge passes.

Return ONLY a JSON `merges` object ({ "Canonical": ["src", ...] }) plus a one-line
rationale per group and any population figures you used. Flag borderline calls for
human review.
```

## Learned preferences (bespoke to this workflow)

- **Output format** must match `fe-artifacts/games/sf-neighborhoods-quiz.data.json`
  exactly: `{"geo": FeatureCollection}`, each feature `{properties:{name, c}, geometry}`,
  `c = [lon, lat]` centroid, geometry normalized to `MultiPolygon`, features sorted by
  `name`, JSON minified. `build_quiz_data.py final` does all of this.
- **Dissolve, don't stack.** Merging must union RAW geometries then simplify once —
  otherwise shared borders diverge and internal seams show through the merged shape.
- **shapely on externally-managed Python** needs a venv (see SKILL.md).
- Keep raw downloads and config in a scratch dir; delete after the final data.json is in
  place. Only the final `<city>-neighborhoods-quiz.data.json` (and the quiz HTML) ship.
