// Small helpers shared by the app, the map and the exports.

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// County names typed into a real Excel by a real person rarely match the map's
// Census spelling exactly: "St. Clair" vs "Saint Clair" vs "st clair county".
// Every place that groups or looks up counties goes through this key.
export function normalizeCountyName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\bcounty\b/g, '')
    .replace(/[.,]/g, '')
    .replace(/\bst\b/g, 'saint')
    .replace(/\s+/g, ' ')
    .trim();
}

// Saves a Blob as a file. The URL is revoked late because Safari can cancel a
// download whose URL is revoked in the same tick as the click.
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

// A file-name-safe version of a list name.
export function safeFileName(name) {
  return String(name || 'list').trim().replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'list';
}

const loadedScripts = new Map();

// Loads a classic script once and resolves when it has run.
export function loadScriptOnce(src) {
  if (loadedScripts.has(src)) return loadedScripts.get(src);
  const p = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => { s.remove(); loadedScripts.delete(src); reject(new Error(`Could not load ${src}`)); };
    document.head.appendChild(s);
  });
  loadedScripts.set(src, p);
  return p;
}

// A unique id. crypto.randomUUID needs a secure page, so fall back if it is missing.
export function newId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

// A rough box around Michigan, used only to catch a typo such as a swapped or
// mistyped coordinate before it puts a store in another state.
export function inMichigan(lat, lon) {
  return lat >= 41.6 && lat <= 48.4 && lon >= -90.6 && lon <= -82.0;
}

// Reads "42.7325, -84.5555" in the ways people paste it (comma, space, brackets,
// Google Maps degree text). Returns { lat, lon } or null. A longitude-first
// paste is swapped back when only that order lands in Michigan.
export function parseLatLon(text) {
  const raw = String(text ?? '');
  const nums = raw.match(/-?\d+(?:\.\d+)?/g);
  if (!nums || nums.length !== 2) return null;
  let [a, b] = nums.map(Number);
  // "84.5 W" style text carries its sign in a letter.
  if (/w/i.test(raw) && b > 0) b = -b;
  if (!(Math.abs(a) <= 90 && Math.abs(b) <= 180)) {
    if (Math.abs(b) <= 90 && Math.abs(a) <= 180) return inMichigan(b, a) ? { lat: b, lon: a } : null;
    return null;
  }
  if (!inMichigan(a, b) && inMichigan(b, a)) return { lat: b, lon: a };
  return { lat: a, lon: b };
}
