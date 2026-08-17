# Account Atlas

Multi-brand sold/unsold account coverage map for Michigan. Upload any
brand's Excel export, see every account that carries it (and every one that
doesn't) on a real, zoomable map — statewide county view down to individual
store pins — and compare brands against each other.

**No account, store, or SKU data ever leaves your browser or touches this
repo.** Everything after upload lives in IndexedDB, client-side only. This
repo is code and public Michigan county geometry, nothing else — see
`.gitignore`.

## Using it

**Start the local helper first, once per session:**
```
node tools/server.mjs
```
Then open **http://localhost:8181** — not the GitHub Pages link. Leave that
terminal window running in the background; it's what makes the one-click
"Geocode" button work (see "Why a local server" below). Everything else
about the app works the same whether you use this local URL or Pages —
this only matters for the geocode step.

1. **Upload a brand.** Sidebar → "Upload brand spreadsheet." Columns A–G must
   be, in order: Store Full Name, Store Number, Store Address, City, County,
   State, Zip Code. Every column after G is one SKU — any cell holding
   anything other than `-` or blank counts as sold for that SKU.
2. **Geocode it.** Click the 📍 button on the brand row. That's it — it
   calls the local helper, which hits the U.S. Census Bureau's official
   batch geocoder (free, no API key, no billing) and reports back matched
   coordinates in a few seconds, no file to download or re-upload.
3. **Compare.** Toggle brands on/off to overlay them on one map, or switch
   to "Gap view" and pick a Has/Missing pair to see only the accounts that
   carry one brand but not the other — a direct sales-call target list.
4. **Export.** "Export current view to CSV" dumps whatever's currently
   filtered/visible — one county, one gap comparison, whatever's on screen.

Uploading a brand a second time asks before replacing its existing data.

## Why a local server

A browser button can never launch a program on your machine directly —
that's a hard security boundary, not a limitation of this app. The fix is
a small local process that stays running (`tools/server.mjs`): it serves
the app itself AND exposes a `/api/geocode` endpoint the page can call
same-origin, no CORS wall, no manual file round-trip.

This is also why it has to be `http://localhost:8181` rather than the
GitHub Pages URL — a page served over `https://` can't call a plain
`http://localhost` endpoint either (browsers block that as mixed content),
so the app needs to be served BY this same process for the button to
reach it. Neither the Census Bureau's geocoder nor OpenStreetMap's
Nominatim send `Access-Control-Allow-Origin` headers, so a direct browser
`fetch()` to either is blocked outright regardless — confirmed directly
against both before building this, not assumed.

**Note:** `http://localhost:8181` and the GitHub Pages URL are different
origins, so browser storage (IndexedDB) doesn't carry over between them —
data uploaded/geocoded through one won't show up in the other. Use the
local server as the primary way to run the app; Pages is there if you
ever want to browse from a device where you don't want to run the
command.

If the local server isn't running when you click Geocode, the app tells
you and offers the old manual fallback (export a CSV, run
`node tools/geocode.mjs that-file.csv`, import the resulting
`.coords.json`) — same underlying Census API, just without the one-click
convenience.

## Cross-brand matching

Accounts from different brand uploads are linked by normalized name +
address similarity (see `src/data/matcher.js`), not by store number, since
store numbers aren't guaranteed consistent across separate brand exports.
High-confidence matches link automatically; medium-confidence ones surface
in the "N matches need review" panel for a manual same-store/different-store
call. Your calls persist in `localStorage` and are respected on every
future match recompute.

## Local development

Any static file server works, e.g.:
```
npx serve .
```
Then open the printed localhost URL. No build step.

## Structure

- `index.html` — shell, loads Leaflet, leaflet.markercluster, and SheetJS
  from CDN (this is a real hosted site, not a sandboxed artifact, so CDN
  scripts are fine here).
- `src/core/db.js` — IndexedDB wrapper (brands, accounts, match groups,
  geocode cache).
- `src/data/excelParser.js` — the Excel → account-record pipeline.
- `src/data/matcher.js` — cross-brand account matching.
- `src/data/csvTools.js` — address export for geocoding, filtered-view
  export, coordinate import.
- `src/modules/mapView.js` — Leaflet map, county choropleth, marker
  clustering, pin popups.
- `src/app.js` — wires state, sidebar, and map together.
- `data/geo/michigan-counties.geojson` — real Michigan county boundaries
  (U.S. Census Bureau cartographic boundary files, public domain). No
  account data.
- `tools/server.mjs` — local server: serves the app at `http://localhost:8181`
  and exposes `/api/geocode` for the in-app one-click Geocode button.
- `tools/geocode.mjs` — standalone CLI fallback for the same Census
  batch geocoder, used only if the local server isn't running.
