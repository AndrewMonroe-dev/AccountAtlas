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
