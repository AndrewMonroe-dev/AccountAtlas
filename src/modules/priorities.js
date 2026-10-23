// Brand priority list for the pre-visit Brief: the base order, focus presets
// that bump a few brands to the top, and the rules that match each brand to
// SKU column headers in the master sold/unsold list. Pure functions plus
// localStorage, no DOM, so the matching can be tested on its own.
//
// An entry is a brand or a sub-brand (parentId set). A rule says which SKU
// headers belong to it. Rule text, one group per line, alternatives split by
// "|": a header matches when every line has at least one alternative in it,
// and none of the alternatives on a "not:" line. Words are compared after
// lowercasing and turning punctuation into spaces, and an alternative matches
// at the start of a word, so "bsp" matches "BSP" and "transcendent" matches
// "Transcendent706" but "3l" does not match "13l".

const KEY = 'aa-priorities-v1';
export const IGNORE = '_ignore';

export function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function parseRule(text) {
  const groups = [];
  let none = [];
  String(text || '').split('\n').forEach((line) => {
    const raw = line.trim();
    if (!raw) return;
    const isNot = /^not\s*:/i.test(raw);
    const alts = (isNot ? raw.replace(/^not\s*:/i, '') : raw)
      .split('|').map(norm).filter(Boolean);
    if (!alts.length) return;
    if (isNot) none = none.concat(alts); else groups.push(alts);
  });
  return { groups, none };
}

// Left word boundary only, so abbreviations glued to digits still match.
function hasAlt(padded, alt) {
  return padded.includes(' ' + alt);
}

function ruleMatches(rule, normalizedSku) {
  if (!rule.groups.length) return false;
  const padded = ' ' + normalizedSku;
  if (!rule.groups.every((alts) => alts.some((a) => hasAlt(padded, a)))) return false;
  return !rule.none.some((a) => hasAlt(padded, a));
}

const e = (id, name, ruleText, { parentId = null, tags = [] } = {}) => ({ id, name, parentId, tags, ruleText });

// Andrew's base order, 2026-10-23 (see "Brand Priority List" in the vault).
// tags: 'on' = On-Premise focus, 'off' = Off-Premise priority.
export function defaultEntries() {
  return [
    e('bota', 'Bota Box', 'bota\n3l'),
    e('bota-nighthawk', 'Bota Nighthawk 3L', 'bota\n3l\nnighthawk', { parentId: 'bota' }),
    e('bota-breeze', 'Bota Breeze 3L', 'bota\n3l\nbreeze', { parentId: 'bota' }),
    e('bota-mini', 'Bota Mini', 'bota\n500ml | mini\nnot: lil | 187', { parentId: 'bota' }),
    e('bota-lilmini', "Bota Lil' Mini", 'bota\nlil | 187', { parentId: 'bota' }),
    e('diamond', 'Diamond Collection', 'diamond collection'),
    e('diamond-prosecco750', 'Diamond Collection Prosecco 750ml', 'diamond collection\nprosecco\n712 | 750', { parentId: 'diamond' }),
    e('diamond-prosecco187', 'Diamond Collection Prosecco 187', 'diamond collection\nprosecco\n103 | 124 | 187', { parentId: 'diamond' }),
    e('diamond-brut', 'Diamond Collection Brut', 'diamond collection\nbrut', { parentId: 'diamond' }),
    e('stoneleigh', 'Stoneleigh', 'stoneleigh', { tags: ['on', 'off'] }),
    e('bs-collection', 'Black Stallion Collection', 'black stallion collection', { tags: ['on', 'off'] }),
    e('bs-reserve', 'Black Stallion Reserve', 'black stallion | blkstln\nreserve | rsv | blkstlnrsv\nnot: limited | prestige | bsp | transcendent | gaspare', { tags: ['on', 'off'] }),
    e('1924', '1924', '1924'),
    e('tfj', 'Three Finger Jack', 'three finger jack | 3 finger jack'),
    e('zab', 'Z. Alexander Brown', 'alexander brown'),
    e('relax', 'Relax', 'relax'),
    e('schmitt-sohne', 'Schmitt Sohne', 'schmitt sohne | schmitt sohn'),
    e('noble-vines', 'Noble Vines', 'noble vines', { tags: ['on'] }),
    e('gnarly', 'Gnarly Head', 'gnarly head'),
    e('bs-prestige', 'Black Stallion Prestige Wines', 'black stallion | bsp | blkstln\nprestige | bsp | transcendent | limited | gaspare'),
    e('diora', 'Diora', 'diora', { tags: ['on'] }),
    e('directors-cut', "Director's Cut", 'director s cut | directors cut'),
    e('torbreck', 'Torbreck', 'torbreck', { tags: ['on'] }),
    e('schloss', 'Schloss Vollrads', 'schloss vollrads'),
    e('markstone', 'Markstone', 'markstone', { tags: ['on'] }),
    e('woc', 'Wines of Francis Coppola', 'wines of francis coppola', { tags: ['on'] }),
    e('thomas-schmitt', 'Thomas Schmitt', 'thomas schmitt', { tags: ['on'] }),
    e('franz-keller', 'Franz Keller', 'franz keller', { tags: ['on'] }),
    e('bwt', 'Bischofliche Weinguter Trier', 'bischof', { tags: ['on'] }),
    e('archimedes', 'Archimedes', 'archimedes'),
    e('sam-jasper', 'Sam Jasper', 'sam jasper'),
  ];
}

export function defaultPriorities() {
  return { version: 1, entries: defaultEntries(), presets: [], activePresetId: null, masterBrandId: null, assign: {} };
}

function sanitize(p) {
  const base = defaultPriorities();
  if (!p || typeof p !== 'object') return base;
  const entries = Array.isArray(p.entries) && p.entries.length
    ? p.entries.filter((x) => x && x.id && x.name).map((x) => ({
      id: String(x.id), name: String(x.name), parentId: x.parentId || null,
      tags: Array.isArray(x.tags) ? x.tags.filter((t) => t === 'on' || t === 'off') : [], ruleText: String(x.ruleText || ''),
    }))
    : base.entries;
  const ids = new Set(entries.map((x) => x.id));
  return {
    version: 1,
    entries: entries.map((x) => (x.parentId && !ids.has(x.parentId) ? { ...x, parentId: null } : x)),
    presets: Array.isArray(p.presets)
      ? p.presets.filter((x) => x && x.id && x.name).map((x) => ({
        id: String(x.id), name: String(x.name), endDate: /^\d{4}-\d{2}-\d{2}$/.test(x.endDate || '') ? x.endDate : '',
        bump: Array.isArray(x.bump) ? x.bump.filter((id) => ids.has(id)) : [],
      })) : [],
    activePresetId: p.activePresetId || null,
    masterBrandId: p.masterBrandId || null,
    assign: p.assign && typeof p.assign === 'object' && !Array.isArray(p.assign) ? p.assign : {},
  };
}

export function loadPriorities() {
  try {
    const raw = localStorage.getItem(KEY);
    return sanitize(raw ? JSON.parse(raw) : null);
  } catch {
    return defaultPriorities();
  }
}

export function savePriorities(p) {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* storage blocked */ }
}

// Importing a backup: accepts only well-formed data, returns it cleaned.
export function cleanPriorities(p) {
  return sanitize(p);
}

// Base order flattened: each top-level brand, then its sub-brands.
export function flatOrder(entries) {
  const out = [];
  entries.filter((x) => !x.parentId).forEach((top) => {
    out.push(top);
    entries.filter((x) => x.parentId === top.id).forEach((child) => out.push(child));
  });
  return out;
}

export function todayString(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// The focus preset in force today, or null (none chosen, deleted, or past its end date).
export function activePreset(p, today = todayString()) {
  const preset = p.presets.find((x) => x.id === p.activePresetId);
  if (!preset) return null;
  if (preset.endDate && today > preset.endDate) return null;
  return preset;
}

// Bumped brands first in the preset's order, then the base order without them.
export function effectiveOrder(p, today = todayString()) {
  const flat = flatOrder(p.entries);
  const preset = activePreset(p, today);
  if (!preset) return flat.map((entry) => ({ entry, bumped: false }));
  const byId = new Map(flat.map((x) => [x.id, x]));
  const bumped = preset.bump.map((id) => byId.get(id)).filter(Boolean);
  const bumpedIds = new Set(bumped.map((x) => x.id));
  return [
    ...bumped.map((entry) => ({ entry, bumped: true })),
    ...flat.filter((x) => !bumpedIds.has(x.id)).map((entry) => ({ entry, bumped: false })),
  ];
}

// Which entry a SKU header belongs to: a manual choice first, then the most
// specific matching rule (more rule lines and "not:" words win, ties go to the
// earlier entry). Returns an entry id, IGNORE, or null when nothing matches.
export function matcherFor(p) {
  const rules = p.entries.map((entry, i) => ({ entry, i, rule: parseRule(entry.ruleText) }))
    .filter((r) => r.rule.groups.length)
    .sort((a, b) => (b.rule.groups.length * 10 + b.rule.none.length) - (a.rule.groups.length * 10 + a.rule.none.length) || a.i - b.i);
  const ids = new Set(p.entries.map((x) => x.id));
  return (skuName) => {
    const key = norm(skuName);
    const manual = p.assign[key];
    if (manual === IGNORE || (manual && ids.has(manual))) return manual;
    const hit = rules.find((r) => ruleMatches(r.rule, key));
    return hit ? hit.entry.id : null;
  };
}

// skuNames -> { byEntry: Map<entryId, string[]>, unmatched: string[] }
export function matchSkus(p, skuNames) {
  const match = matcherFor(p);
  const byEntry = new Map();
  const unmatched = [];
  skuNames.forEach((sku) => {
    const id = match(sku);
    if (id === IGNORE) return;
    if (id === null) { unmatched.push(sku); return; }
    if (!byEntry.has(id)) byEntry.set(id, []);
    byEntry.get(id).push(sku);
  });
  return { byEntry, unmatched };
}

// ---- edits (each returns a new priorities object) ----

function siblingsOf(entries, entry) {
  return entries.filter((x) => (x.parentId || null) === (entry.parentId || null));
}

// dir: -1 up, +1 down, 'top'. Moves among its siblings only (a sub-brand stays under its brand).
export function moveEntry(p, id, dir) {
  const entries = p.entries.slice();
  const entry = entries.find((x) => x.id === id);
  if (!entry) return p;
  const sibs = siblingsOf(entries, entry);
  const at = sibs.indexOf(entry);
  const to = dir === 'top' ? 0 : at + dir;
  if (to < 0 || to >= sibs.length || to === at) return p;
  const target = sibs[to];
  const from = entries.indexOf(entry);
  entries.splice(from, 1);
  let insertAt = entries.indexOf(target);
  if (dir === 'top' || dir === -1) {
    // before the target
  } else {
    // after the target, and after a brand's own sub-brands when the target is a brand
    insertAt += 1;
    if (!target.parentId) {
      while (insertAt < entries.length && entries[insertAt].parentId === target.id) insertAt += 1;
    }
  }
  entries.splice(insertAt, 0, entry);
  return { ...p, entries };
}

export function slugId(name, existing) {
  const base = norm(name).replace(/ /g, '-') || 'brand';
  let id = 'u-' + base;
  let n = 2;
  while (existing.has(id)) { id = `u-${base}-${n}`; n += 1; }
  return id;
}

// New brand goes to the bottom of the base order with a rule that looks for its name.
export function addEntry(p, name) {
  const clean = String(name || '').trim();
  if (!clean) return p;
  const id = slugId(clean, new Set(p.entries.map((x) => x.id)));
  return { ...p, entries: [...p.entries, { id, name: clean, parentId: null, tags: [], ruleText: norm(clean) }] };
}

export function removeEntry(p, id) {
  const gone = new Set([id, ...p.entries.filter((x) => x.parentId === id).map((x) => x.id)]);
  return {
    ...p,
    entries: p.entries.filter((x) => !gone.has(x.id)),
    presets: p.presets.map((x) => ({ ...x, bump: x.bump.filter((b) => !gone.has(b)) })),
    assign: Object.fromEntries(Object.entries(p.assign).filter(([, v]) => !gone.has(v))),
  };
}
