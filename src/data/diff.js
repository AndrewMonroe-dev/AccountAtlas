// What changed between a stored list and a freshly uploaded file, so a
// re-upload can say what it is about to replace. Pure functions, no DOM.
//
// Accounts are matched by id (store number, name and address together), so a
// store whose name or address was edited counts as one gone and one new.

const anySold = (skus) => Object.values(skus || {}).some(Boolean);

export function diffLists(oldAccounts, oldSkus, newAccounts, newSkus) {
  const oldById = new Map(oldAccounts.map((a) => [a.id, a]));
  const newById = new Map(newAccounts.map((a) => [a.id, a]));

  let added = 0;
  let removed = 0;
  newById.forEach((_, id) => { if (!oldById.has(id)) added += 1; });
  oldById.forEach((_, id) => { if (!newById.has(id)) removed += 1; });

  const oldSet = new Set(oldSkus);
  const newSet = new Set(newSkus);
  const skusAdded = newSkus.filter((s) => !oldSet.has(s));
  const skusRemoved = oldSkus.filter((s) => !newSet.has(s));
  const shared = newSkus.filter((s) => oldSet.has(s));

  let newlySold = 0;
  let noLongerSold = 0;
  let startedSelling = 0;
  let stoppedSelling = 0;
  newById.forEach((n, id) => {
    const o = oldById.get(id);
    if (!o) return;
    shared.forEach((s) => {
      const was = !!(o.skus && o.skus[s]);
      const is = !!(n.skus && n.skus[s]);
      if (!was && is) newlySold += 1;
      else if (was && !is) noLongerSold += 1;
    });
    const wasAny = anySold(o.skus);
    const isAny = anySold(n.skus);
    if (!wasAny && isAny) startedSelling += 1;
    else if (wasAny && !isAny) stoppedSelling += 1;
  });

  return {
    oldTotal: oldAccounts.length, newTotal: newAccounts.length, added, removed,
    skusAdded, skusRemoved, newlySold, noLongerSold, startedSelling, stoppedSelling,
  };
}

export function isUnchanged(d) {
  return !d.added && !d.removed && !d.skusAdded.length && !d.skusRemoved.length && !d.newlySold && !d.noLongerSold;
}

function nameList(names, max = 4) {
  const shown = names.slice(0, max).join(', ');
  return names.length > max ? `${shown} and ${names.length - max} more` : shown;
}

// Plain-language lines for a confirm box.
export function describeDiff(d) {
  if (isUnchanged(d)) return `No changes from the stored list (${d.newTotal} accounts).`;
  const lines = [`Accounts: ${d.oldTotal} now, ${d.newTotal} in the file (${d.added} new, ${d.removed} gone).`];
  if (d.skusAdded.length) lines.push(`New SKU columns (${d.skusAdded.length}): ${nameList(d.skusAdded)}.`);
  if (d.skusRemoved.length) lines.push(`SKU columns dropped (${d.skusRemoved.length}): ${nameList(d.skusRemoved)}.`);
  if (d.newlySold || d.noLongerSold) lines.push(`Sold cells: ${d.newlySold} newly sold, ${d.noLongerSold} no longer sold.`);
  if (d.startedSelling || d.stoppedSelling) lines.push(`Stores that started selling: ${d.startedSelling}. Stores that stopped: ${d.stoppedSelling}.`);
  return lines.join('\n');
}
