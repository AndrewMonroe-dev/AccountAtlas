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

1. **Upload a brand.** Sidebar → "Upload brand spreadsheet." Columns A–G must
   be, in order: Store Full Name, Store Number, Store Address, City, County,
   State, Zip Code. Every column after G is one SKU — any cell holding
   anything other than `-` or blank counts as sold for that SKU.
2. **Geocode it.** The Excel has no coordinates, so pins need a one-time
   lookup. Click the ↓ button on the brand row to export its address list,
   then run:
   ```
   node tools/geocode.mjs your-brand-addresses.csv
   ```
   This calls the U.S. Census Bureau's official batch geocoder — free, no
   API key, no billing. It writes a `.coords.json` file next to the CSV.
   Click the ↑ button on the same brand row and pick that file to import the
   coordinates. (This step runs locally because the Census API doesn't allow
   direct calls from a browser — see "Why a local step" below.)
3. **Compare.** Toggle brands on/off to overlay them on one map, or switch
   to "Gap view" and pick a Has/Missing pair to see only the accounts that
   carry one brand but not the other — a direct sales-call target list.
4. **Export.** "Export current view to CSV" dumps whatever's currently
   filtered/visible — one county, one gap comparison, whatever's on screen.

Uploading a brand a second time asks before replacing its existing data.

## Why a local step for geocoding

Neither the Census Bureau's geocoder nor OpenStreetMap's Nominatim send
`Access-Control-Allow-Origin` headers, so a browser `fetch()` to either is
blocked outright — confirmed directly against both before building this,
not assumed. Since this app is a static site with no backend, the fix is
running the same official, free, no-key Census geocoder from Node instead
of the browser, where CORS doesn't apply. It's a one-time step per brand,
not per session — coordinates persist in IndexedDB after import.

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
- `tools/geocode.mjs` — the local Census batch-geocoding helper.
