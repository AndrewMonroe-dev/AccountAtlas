// Pre-visit Brief logic: for each stop on the route, which of Andrew's priority
// brands the store carries and which it is missing, in his priority order
// (focus period first). Pure functions, no DOM, so it can be tested on its own.
//
// Sold or not comes from the master sold/unsold list. Cases come from one
// source per brand: a separate volume list when one covers that brand,
// otherwise the amounts in the master list itself. The two are never added
// together, because the same product can sit in both files.

import { effectiveOrder, matchSkus, activePreset } from './priorities.js?v=20261023e';

// "Bota Box 3L Pinot Grigio 3L3" -> "Bota Box 3L Pinot Grigio": drop a trailing
// item code (a last word that contains a digit) when something else remains.
export function shortSku(name) {
  const words = String(name || '').trim().split(/\s+/);
  if (words.length > 2 && /\d/.test(words[words.length - 1])) words.pop();
  return words.join(' ');
}

function sumQty(account, skus) {
  let total = 0;
  skus.forEach((s) => { total += Number(account.qty && account.qty[s]) || 0; });
  return total;
}

// ctx: { stops, accounts, brands, prio, master, addressKey, today }
//   stops: route stops [{ id, name, kind? }]; accounts: every stored account;
//   master: the master list's brand record or null; addressKey(account) -> string.
export function buildBriefs(ctx) {
  const { stops, accounts, brands, prio, master, addressKey, today } = ctx;
  const order = effectiveOrder(prio, today);
  const preset = activePreset(prio, today);
  const header = {
    master: master ? master.name : null,
    focus: preset ? { name: preset.name, endDate: preset.endDate, bumped: order.filter((o) => o.bumped).map((o) => o.entry.name) } : null,
    noSkus: [],
    needsHome: 0,
  };
  if (!master) return { header, stops: [] };

  const masterMatch = matchSkus(prio, master.skuList || []);
  header.needsHome = masterMatch.unmatched.length;
  // A brand whose SKUs all sit under its sub-brands (Diamond Collection) is not "empty".
  const hasSkus = (id) => (masterMatch.byEntry.get(id) || []).length > 0;
  header.noSkus = order
    .filter((o) => !hasSkus(o.entry.id) && !prio.entries.some((x) => x.parentId === o.entry.id && hasSkus(x.id)))
    .map((o) => o.entry.name);

  // Index every account by address, per list.
  const byBrand = new Map();
  accounts.forEach((a) => {
    if (!byBrand.has(a.brandId)) byBrand.set(a.brandId, new Map());
    byBrand.get(a.brandId).set(addressKey(a), a);
  });
  const masterIndex = byBrand.get(master.id) || new Map();

  // Volume lists: any other list with amounts, each matched to the entries.
  const volumeLists = brands.filter((b) => b.id !== master.id && accounts.some((a) => a.brandId === b.id && a.qty))
    .map((b) => ({ brand: b, match: matchSkus(prio, b.skuList || []), index: byBrand.get(b.id) || new Map() }));
  const masterHasQty = accounts.some((a) => a.brandId === master.id && a.qty);

  const out = stops.map((stop) => {
    if (stop.kind === 'place') return { stop, account: null, kind: 'place', rows: [] };
    const acct = accounts.find((a) => a.id === stop.id) || null;
    if (!acct) return { stop, account: null, kind: 'gone', rows: [] };
    const key = addressKey(acct);
    const mAcct = acct.brandId === master.id ? acct : (masterIndex.get(key) || null);
    const rows = order.map(({ entry, bumped }) => {
      const skus = masterMatch.byEntry.get(entry.id) || [];
      const sold = mAcct ? skus.filter((s) => mAcct.skus[s]) : [];
      const missing = mAcct ? skus.filter((s) => !mAcct.skus[s]) : [];
      let status = 'nodata';
      if (!skus.length) status = 'noskus';
      else if (mAcct) status = sold.length === skus.length ? 'carries' : (sold.length ? 'partial' : 'missing');

      let cases = null;
      const vol = volumeLists.find((v) => (v.match.byEntry.get(entry.id) || []).length);
      if (vol) {
        const vAcct = vol.index.get(key);
        cases = vAcct ? sumQty(vAcct, vol.match.byEntry.get(entry.id)) : 0;
      } else if (masterHasQty && mAcct && skus.length) {
        cases = sumQty(mAcct, skus);
      }
      return { entry, bumped, status, total: skus.length, soldCount: sold.length, missing, cases };
    });
    return { stop, account: acct, kind: mAcct ? 'ok' : 'nomaster', masterAcct: mAcct, rows };
  });
  return { header, stops: out };
}

// Rows of one stop split for display: gaps first, in priority order. With
// onPremFirst, the brands tagged On-Premise focus come back in gaps and
// carrying (still in priority order) and every other brand in otherGaps and
// otherCarrying, so nothing is hidden, just moved below.
export function splitRows(rows, onPremFirst = false) {
  const isGap = (r) => r.status === 'missing' || r.status === 'partial';
  const isCarry = (r) => r.status === 'carries';
  const focus = onPremFirst ? rows.filter((r) => r.entry.tags.includes('on')) : rows;
  const other = onPremFirst ? rows.filter((r) => !r.entry.tags.includes('on')) : [];
  return {
    gaps: focus.filter(isGap),
    carrying: focus.filter(isCarry),
    otherGaps: other.filter(isGap),
    otherCarrying: other.filter(isCarry),
  };
}
