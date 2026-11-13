# Penta Projects

The site is served from `fe-artifacts/`. A small Node build renders shared HTML and theme assets; application JavaScript remains in ES modules.

## Where to edit

| Change | Source |
| --- | --- |
| Brand, navigation, shared asset bundles | `site/config.json` |
| Page titles, routes, assets, section listings | `site/pages.json` |
| Page content | `site/pages/` |
| Shared document, headers, navigation links, listing entries | `site/templates/` |
| Page styles embedded in generated HTML | `site/styles/` |
| Colors, fonts, spacing/radius/type scales, theme variants, board tile colors | `site/theme.json` |
| Shared and application styles | `fe-artifacts/assets/`, plus report-specific CSS |
| Application behavior | `fe-artifacts/assets/js/` |

Generated HTML, `tokens.css`, board tile color CSS, and `ui-theme-tokens.js` carry generation notices. Edit their source and rebuild. Commit the generated files alongside source changes; the production server serves these committed files.

## Build and preview

Use Node 20 or later.

```sh
npm ci
npm run build:site
npm run check:site
npm test
```

`check:site` does not write files. CI runs it to reject stale generated output.

Serve the web root so root-relative links resolve:

```sh
python3 -m http.server 8000 --bind 127.0.0.1 --directory fe-artifacts
```

Open <http://127.0.0.1:8000/>. After changing templates, theme data, CSS, or JavaScript, run `npm run build:site` and reload the browser. The build updates asset hashes so shared changes reach returning visitors.

## Styling

Every page except the Vestaboard hub loads the `site` bundle, in this order:

| Layer | File | Owns |
| --- | --- | --- |
| Tokens | `assets/tokens.css` (generated from `site/theme.json`) | Colors, fonts, spacing, radii, type sizes, widths, shadows |
| Base | `assets/base.css` | Reset, document, headings, links, form inheritance, focus ring, `.reveal` |
| Layout | `assets/layout.css` | `<main class="page">` sized by the page's `layout` |
| Components | `assets/components.css` | Site header, `.btn`, back link, page title, entry list |

Each page in `site/pages.json` sets `layout` to `narrow` (440px), `default` (860px), `wide` (1200px), or `app` (full-bleed), and lists only its own CSS in `styles`. Page CSS should use tokens and tune components through their custom properties instead of redefining them. `npm run check:styles` lists hard-coded colors, page-level `html`/`body`/`*`/`:root` rules, inline page styles, non-shared bundles, and off-pattern titles; `build:site` prints the count. A page that intentionally keeps its own look sets `styleException` with a reason.

## Shared behavior

`vestaboard-session.js` owns polling, connection and busy state, stale-response protection, and reconciliation after commands for Pomodoro, Sports, and Fantasy. Each app keeps its validation, rendering, and command payloads. Failed commands are reconciled with a status read and are never automatically repeated.

The board API client, message layout, preview renderer, and page helpers (`vestaboard-page.js`) are separate shared modules. The note composer retains its own send/cooldown lifecycle.

## Publishing

Push a branch with source and generated output, pass CI, and merge to `main`. The existing Deploy workflow updates the static site. The separately deployed `/fantasy-dashboard/` application is maintained outside this repository.
