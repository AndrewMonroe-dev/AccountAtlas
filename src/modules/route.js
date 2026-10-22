// Route builder logic: pure functions plus localStorage persistence. No DOM
// and no Leaflet in here so the ordering math can be tested on its own.
//
// A route is an ordered array of stops: { id, name, lat, lon, query } where
// query is descriptive text for the route bar. A stop that is a nearby
// business rather than one of the user's accounts also has kind: 'place'.

export const MAX_STOPS = 10; // Google Maps URLs take 9 waypoints + 1 destination
const STORAGE_KEY = 'aa-route-v1';

const EARTH_RADIUS_MI = 3958.8;

// Straight-line (great-circle) distance in miles between two {lat, lon}.
export function haversineMiles(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MI * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Shortest open path that starts at `start` ({lat, lon}) and visits every
// point once, ending wherever is shortest. Exact (Held-Karp), fine for the
// 10-stop cap. Returns the point indices in visiting order.
// With start === null the first point is the fixed starting stop.
export function optimizeOrder(points, start) {
  const n = points.length;
  if (n <= 1) return points.map((_, i) => i);

  let nodes = points;
  let first = null;
  let origin = start;
  if (!origin) {
    first = 0;
    origin = points[0];
    nodes = points.slice(1);
  }
  const m = nodes.length;
  const dist = (p, q) => haversineMiles(p, q);
  const full = (1 << m) - 1;
  const INF = Infinity;
  const dp = Array.from({ length: 1 << m }, () => new Array(m).fill(INF));
  const parent = Array.from({ length: 1 << m }, () => new Array(m).fill(-1));

  for (let j = 0; j < m; j++) dp[1 << j][j] = dist(origin, nodes[j]);
  for (let mask = 1; mask <= full; mask++) {
    for (let j = 0; j < m; j++) {
      if (!(mask & (1 << j)) || dp[mask][j] === INF) continue;
      for (let k = 0; k < m; k++) {
        if (mask & (1 << k)) continue;
        const next = mask | (1 << k);
        const cost = dp[mask][j] + dist(nodes[j], nodes[k]);
        if (cost < dp[next][k]) { dp[next][k] = cost; parent[next][k] = j; }
      }
    }
  }

  let end = 0;
  for (let j = 1; j < m; j++) if (dp[full][j] < dp[full][end]) end = j;
  const order = [];
  let mask = full;
  let cur = end;
  while (cur !== -1) {
    order.push(cur);
    const prev = parent[mask][cur];
    mask &= ~(1 << cur);
    cur = prev;
  }
  order.reverse();
  // Map back to indices in the original `points` array.
  return first === null ? order : [0, ...order.map((i) => i + 1)];
}

// Total straight-line length of a path, optionally starting from `start`.
export function pathMiles(points, order, start) {
  let total = 0;
  let prev = start || null;
  order.forEach((i) => {
    if (prev) total += haversineMiles(prev, points[i]);
    prev = points[i];
  });
  return total;
}

// Google Maps directions link. No origin on purpose: Maps then starts from
// wherever the phone is standing when the link is opened.
//
// Stops are sent as "lat,lon", not address text: Maps matches text against
// its own place database and answered "can't seem to find that place" for
// the addresses typed into the source spreadsheets (reported 2026-10-21).
// Coordinates can't be misread, and every stop on a route is already mapped.
export function googleRouteUrl(stops) {
  if (!stops.length) return null;
  const enc = encodeURIComponent;
  const point = (s) => enc(`${s.lat.toFixed(6)},${s.lon.toFixed(6)}`);
  const last = stops[stops.length - 1];
  let url = `https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=${point(last)}`;
  const waypoints = stops.slice(0, -1).map(point);
  if (waypoints.length) url += `&waypoints=${waypoints.join('%7C')}`;
  return url;
}

export function stopFromAccount(acct) {
  const query = [acct.address, acct.city, `${acct.state || 'MI'} ${acct.zip || ''}`.trim()]
    .filter(Boolean).join(', ');
  return { id: acct.id, name: acct.storeName, lat: acct.lat, lon: acct.lon, query };
}

// A gray "nearby business" from the OSM snapshot, which is not one of the
// user's accounts. The id is built from the coordinates so it can never clash
// with an account id and stays stable when the snapshot is rebuilt. The name is
// part of it because two businesses can share one coordinate (same building).
export function placeStopId(place) {
  return `osm:${place.lat.toFixed(6)},${place.lon.toFixed(6)}:${place.name}`;
}

export function stopFromPlace(place) {
  const query = [place.label, place.addr].filter(Boolean).join(', ');
  return { id: placeStopId(place), name: place.name, lat: place.lat, lon: place.lon, query, kind: 'place', label: place.label, addr: place.addr || '' };
}

export function loadRoute() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((s) => s && s.id && Number.isFinite(s.lat) && Number.isFinite(s.lon) && s.query)
      .slice(0, MAX_STOPS);
  } catch {
    return [];
  }
}

export function saveRoute(stops) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stops));
  } catch {
    // Storage blocked or full: the route still works for this session.
  }
}
