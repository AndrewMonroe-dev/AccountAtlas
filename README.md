# Account Atlas

Sold/unsold account coverage map for Michigan. Upload a spreadsheet, see every
account that carries it and every one that does not, from a statewide county
view down to individual store pins. Shade counties by sold percentage or by
volume, build a route, and get a pre-visit brief for each stop.

**No account, store or SKU data ever leaves your browser or touches this repo.**
Everything after upload lives in IndexedDB and localStorage on your device. The
repo holds code and public map data only, see `.gitignore`.

## Running it

Windows: double-click the Account Atlas shortcut (it runs `tools/server.mjs` and
opens the app). Or run it yourself:

```
node tools/server.mjs
```

Then open http://localhost:8181. The server listens on this computer only. It
serves the app and answers `/api/geocode` for the one-click Geocode button.

The same app is also served from `accountatlas.pages.dev` (Cloudflare Pages,
behind Cloudflare Access) and from GitHub Pages. Each address is a separate
browser origin, so data uploaded at one does not appear at another. Use
**Back up all lists** and **Import** to move data between them.

Any static file server also works for everything except the Geocode button.

## Using it

1. **Upload a list.** Sidebar, "Upload brand spreadsheet". Row 1 is the header.
   Columns A to G are Store Full Name, Store Number, Store Address, City, County,
   State, Zip Code. Every column from H on is one SKU. Any cell other than `-` or
   blank counts as sold, and the number in the cell is kept as the amount (cases)
   for the volume heatmap. Uploading a list with the same name asks before
   replacing it, and a file that fails validation never touches the old list.
2. **Geocode it.** The pin button on the list row sends unmapped addresses to the
   U.S. Census Bureau batch geocoder (free, no key). Addresses it cannot place
   appear under "accounts not on map", where a second pass through OpenStreetMap
   can try them.
3. **Look.** Switch lists on and off with the chips above the map. The Shade bar
   colors counties by Sold %, Volume total or Volume per account. Heat and Dots
   switch the shading and the pins independently.
4. **Search** by store name, city or address, tap a result to jump to it.
5. **Route.** Tick "Add to route" on a store (or on a gray nearby business) to
   build a numbered route of up to 10 stops. Optimize order, Start route in
   Google Maps, or open the pre-visit **Brief**.
6. **Priorities.** Your brand order, focus periods that bump brands to the top,
   On-premise tags and the SKU matching rules. The Brief reads them.
7. **Export.** The current view to CSV, one list as a snapshot, one list as a
   standalone map page, or every list plus priorities in one backup file.

## Why a local server

A browser cannot launch a program on your machine, a page served over https
cannot call plain http://localhost, and neither the Census geocoder nor
OpenStreetMap's search sends CORS headers, so a browser cannot call them
directly. The local server is the small same-origin helper that makes the
Geocode button work. If it is not running the app offers a manual fallback:
export an address file, run `node tools/geocode.mjs that-file.csv`, import the
resulting `.coords.json`.

GitHub Pages is a plain static host with no server code, so it sends geocoding to
a standalone Cloudflare Worker relay (`tools/cloudflare-worker.js`). Every other
address uses its own `/api/geocode`.

## Development

No build step. Libraries are vendored in `vendor/` so the app has no CDN
dependency (Leaflet 1.9.4, Leaflet.markercluster 1.5.3, SheetJS 0.18.5).

```
npm test            unit tests for the pure modules and the Census client
npm run bump        new cache-busting marker in index.html and every import
```

After changing any file under `src/` or `index.html`, run `npm run bump` so
browsers fetch the new files, then commit and push.

## Structure

- `index.html` shell, `manifest.webmanifest` and `assets/icons/` for the app icon.
- `src/app.js` state, sidebar, rendering, upload, import, geocoding, search, brief.
- `src/core/db.js` IndexedDB wrapper (lists and accounts, single-transaction writes).
- `src/core/util.js` escaping, county-name keys, downloads, script loading.
- `src/data/excelParser.js` spreadsheet to account records.
- `src/data/csvTools.js` CSV exports and coordinate-file import.
- `src/data/snapshot.js` snapshot and backup files, standalone map viewer export.
- `src/modules/mapView.js` map, county shading, pins, nearby businesses, store panel.
- `src/modules/heatmap.js` volume bands and county totals.
- `src/modules/priorities.js` brand order, focus periods, SKU matching rules.
- `src/modules/brief.js` per-stop gaps in priority order.
- `src/modules/route.js` route storage, shortest-path ordering, Maps link.
- `data/geo/michigan-counties.geojson` Census county boundaries (public domain).
- `data/nearby/michigan-places.json` named stores, bars and restaurants from
  OpenStreetMap (ODbL 1.0, extract by Geofabrik), rebuilt by
  `tools/buildNearbyPlaces.py`, whose docstring has the refresh steps.
- `tools/server.mjs` local server. `tools/census.mjs` shared Census client used
  by it and by `tools/geocode.mjs` (command-line fallback).
- `functions/api/geocode.js` Cloudflare Pages relay, `tools/cloudflare-worker.js`
  standalone Worker relay. Both carry their own copy of the Census logic because
  they deploy as single files.
- `tests/` unit tests, run with `npm test`.
