#!/usr/bin/env python3
"""Build data/nearby/michigan-places.json for the map's "Nearby businesses" layer.

Reads a Michigan OpenStreetMap extract and keeps the named stores, gas
stations, bars, pubs and restaurants (the same categories the layer shows).
Public map data only, nothing from any account list.

Refresh it whenever you want newer data:

  1. Download the latest extract (about 315 MB), for example
       https://download.geofabrik.de/north-america/us/michigan-latest.osm.pbf
     and keep it outside the repo. Geofabrik redirects "latest" to a dated file
     such as michigan-261020.osm.pbf, and the date in the file name becomes the
     "as of" date shown in the map popup.
  2. pip install osmium        (a virtual environment is a good idea)
  3. python tools/buildNearbyPlaces.py --input path/to/michigan-261020.osm.pbf
  4. Set NEARBY_DATA_VERSION in src/modules/mapView.js to the extract date
     (YYYYMMDD) and bump the ?v= cache-bust marker in index.html and
     src/app.js, then commit and push. The file is public map data, safe to
     commit (see .gitignore).

Data: (c) OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright).
Extract provider: Geofabrik GmbH.

Relations (very large multipolygon buildings) are skipped, which drops a small
number of big-box stores. Ways use the average of their corner points.
"""
import argparse
import datetime
import gzip
import json
import os
import re
import sys

import osmium

SHOP_LABELS = {
    'alcohol': 'Liquor store',
    'wine': 'Wine shop',
    'supermarket': 'Supermarket',
    'convenience': 'Convenience store',
    'beverages': 'Beverage store',
}
AMENITY_LABELS = {
    'fuel': 'Gas station',
    'bar': 'Bar',
    'pub': 'Pub',
    'restaurant': 'Restaurant',
}
# Order matters: the numbers in the output file index into this list, and the
# app treats the last three (bar, pub, restaurant) as on-premise.
LABELS = [
    'Liquor store', 'Wine shop', 'Supermarket', 'Convenience store',
    'Beverage store', 'Gas station', 'Bar', 'Pub', 'Restaurant',
]
LABEL_INDEX = {name: i for i, name in enumerate(LABELS)}


def as_of_from_name(path):
    m = re.search(r'-(\d{2})(\d{2})(\d{2})\.osm\.pbf$', os.path.basename(path))
    if not m:
        return None
    return f'20{m.group(1)}-{m.group(2)}-{m.group(3)}'


def centroid(nodes):
    lats, lons = [], []
    for n in nodes:
        try:
            if n.location.valid():
                lats.append(n.location.lat)
                lons.append(n.location.lon)
        except Exception:
            continue
    if not lats:
        return None
    return sum(lats) / len(lats), sum(lons) / len(lons)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--input', required=True, help='Michigan .osm.pbf extract')
    ap.add_argument('--output', default=os.path.join(os.path.dirname(__file__), '..', 'data', 'nearby', 'michigan-places.json'))
    ap.add_argument('--as-of', help='YYYY-MM-DD of the extract (default: taken from the file name)')
    args = ap.parse_args()

    as_of = args.as_of or as_of_from_name(args.input)
    if not as_of:
        sys.exit('Could not read the extract date from the file name. Pass --as-of YYYY-MM-DD.')

    fp = osmium.FileProcessor(args.input).with_locations().with_filter(osmium.filter.KeyFilter('shop', 'amenity'))

    places = []
    seen = set()
    skipped_unnamed = 0
    skipped_relations = 0
    for o in fp:
        tags = o.tags
        label = SHOP_LABELS.get(tags.get('shop', '')) or AMENITY_LABELS.get(tags.get('amenity', ''))
        if not label:
            continue
        if o.is_relation():
            skipped_relations += 1
            continue
        name = (tags.get('name') or '').strip()
        if not name:
            skipped_unnamed += 1
            continue
        if o.is_node():
            lat, lon = o.location.lat, o.location.lon
        elif o.is_way():
            c = centroid(o.nodes)
            if c is None:
                continue
            lat, lon = c
        else:
            continue
        # The same business is sometimes mapped twice (a point inside its own
        # building outline). Keep one per name per ~100 m.
        key = (name.lower(), round(lat, 3), round(lon, 3))
        if key in seen:
            continue
        seen.add(key)
        street = ' '.join(x for x in (tags.get('addr:housenumber'), tags.get('addr:street')) if x)
        addr = ', '.join(x for x in (street, tags.get('addr:city')) if x)
        places.append([round(lat, 5), round(lon, 5), name, LABEL_INDEX[label], addr])

    places.sort(key=lambda p: (p[0], p[1]))
    out = {
        'asOf': as_of,
        'source': 'OpenStreetMap contributors (ODbL 1.0), extract by Geofabrik',
        'builtAt': datetime.date.today().isoformat(),
        'labels': LABELS,
        'places': places,
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
    text = json.dumps(out, ensure_ascii=False, separators=(',', ':'))
    with open(args.output, 'w', encoding='utf-8') as f:
        f.write(text)

    counts = {}
    for p in places:
        counts[LABELS[p[3]]] = counts.get(LABELS[p[3]], 0) + 1
    raw = len(text.encode('utf-8'))
    gz = len(gzip.compress(text.encode('utf-8'), 6))
    print(f'as of {as_of}: {len(places)} places')
    for name in LABELS:
        print(f'  {name}: {counts.get(name, 0)}')
    print(f'skipped: {skipped_unnamed} unnamed, {skipped_relations} relations')
    print(f'file: {raw / 1e6:.2f} MB raw, about {gz / 1e6:.2f} MB gzipped -> {os.path.abspath(args.output)}')


if __name__ == '__main__':
    main()
