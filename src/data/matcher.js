// Cross-brand account matching, by normalized name + address similarity.
// Used so "Bota Box" and "Bota Box Mini" pins for the same physical store
// can be compared/overlaid instead of treated as unrelated accounts.

const STOP_WORDS = ['party store', 'liquor', 'market', 'inc', 'llc', 'the', '#'];

function normalize(str) {
  let s = (str || '').toLowerCase();
  s = s.replace(/[.,]/g, ' ');
  s = s.replace(/\b(ste|suite|unit|#)\s*\w+/g, ' ');
  STOP_WORDS.forEach((w) => { s = s.split(w).join(' '); });
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

function tokenSet(str) {
  return new Set(normalize(str).split(' ').filter((t) => t.length > 1));
}

function jaccard(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 0;
  let intersection = 0;
  setA.forEach((t) => { if (setB.has(t)) intersection += 1; });
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// Similarity 0-1 combining name and address token overlap, address weighted
// higher since two different stores can share a chain name.
export function similarity(accountA, accountB) {
  const nameSim = jaccard(tokenSet(accountA.storeName), tokenSet(accountB.storeName));
  const addrSim = jaccard(tokenSet(accountA.address), tokenSet(accountB.address));
  const zipMatch = accountA.zip && accountB.zip && accountA.zip === accountB.zip ? 1 : 0;
  return nameSim * 0.35 + addrSim * 0.45 + zipMatch * 0.20;
}

const AUTO_MATCH_THRESHOLD = 0.72;
const REVIEW_THRESHOLD = 0.45;

// Builds match groups across ALL accounts from ALL brands currently loaded.
// Returns { groups, needsReview } where a group is
// { id, memberIds: [accountId...], confidence }
export function buildMatches(allAccounts, existingOverrides = {}) {
  const byBrand = {};
  allAccounts.forEach((a) => {
    (byBrand[a.brandId] = byBrand[a.brandId] || []).push(a);
  });
  const brandIds = Object.keys(byBrand);

  const groups = [];
  const needsReview = [];
  const claimed = new Set();

  for (let i = 0; i < brandIds.length; i++) {
    for (const a of byBrand[brandIds[i]]) {
      if (claimed.has(a.id)) continue;
      const members = [a];
      claimed.add(a.id);

      for (let j = i + 1; j < brandIds.length; j++) {
        let best = null;
        let bestScore = 0;
        for (const b of byBrand[brandIds[j]]) {
          if (claimed.has(b.id)) continue;
          const override = existingOverrides[`${a.id}::${b.id}`] ?? existingOverrides[`${b.id}::${a.id}`];
          const score = override === 'reject' ? 0 : override === 'confirm' ? 1 : similarity(a, b);
          if (score > bestScore) { bestScore = score; best = b; }
        }
        if (best && bestScore >= AUTO_MATCH_THRESHOLD) {
          members.push(best);
          claimed.add(best.id);
        } else if (best && bestScore >= REVIEW_THRESHOLD) {
          needsReview.push({ a, b: best, confidence: Math.round(bestScore * 100) });
        }
      }

      groups.push({
        id: members.map((m) => m.id).sort().join('||'),
        memberIds: members.map((m) => m.id),
      });
    }
  }

  return { groups, needsReview };
}
