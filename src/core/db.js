// IndexedDB wrapper. Everything the app ever stores lives here, in the browser
// only. Nothing in this file, and nothing it writes, is ever committed to git.
//
// The 'matches' and 'geocodeCache' stores belong to features that were removed.
// They stay in the schema so existing browsers upgrade without a version bump,
// and "Clear all data" still empties them.

const DB_NAME = 'account-atlas';
const DB_VERSION = 1;
const ALL_STORES = ['brands', 'accounts', 'matches', 'geocodeCache'];

let dbPromise = null;

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('This browser does not support local storage (IndexedDB).')); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('brands')) db.createObjectStore('brands', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('accounts')) {
        const store = db.createObjectStore('accounts', { keyPath: 'id' });
        store.createIndex('brandId', 'brandId', { unique: false });
        store.createIndex('county', 'county', { unique: false });
      }
      if (!db.objectStoreNames.contains('matches')) db.createObjectStore('matches', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('geocodeCache')) db.createObjectStore('geocodeCache', { keyPath: 'key' });
    };
    req.onsuccess = () => {
      const db = req.result;
      // Another tab upgrading the database must not be blocked by this one.
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => { dbPromise = null; reject(req.error || new Error('Could not open the local database.')); };
    req.onblocked = () => { dbPromise = null; reject(new Error('The local database is blocked by another open tab. Close other Account Atlas tabs and reload.')); };
  });
  return dbPromise;
}

// Runs fn(stores) inside one transaction and resolves with fn's result once the
// transaction has actually committed (not just when the last request returned).
async function run(storeNames, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeNames, mode);
    const stores = Object.fromEntries(storeNames.map((n) => [n, t.objectStore(n)]));
    let result;
    try { result = fn(stores); } catch (err) { try { t.abort(); } catch { /* already finished */ } reject(err); return; }
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('The database write was cancelled.'));
  });
}

function getAllFrom(storeName) {
  return run([storeName], 'readonly', (s) => {
    const box = { value: [] };
    s[storeName].getAll().onsuccess = (e) => { box.value = e.target.result; };
    return box;
  }).then((box) => box.value);
}

export function putBrand(brand) {
  return run(['brands'], 'readwrite', (s) => { s.brands.put(brand); });
}

export function deleteBrand(brandId) {
  return run(['brands', 'accounts'], 'readwrite', (s) => {
    s.brands.delete(brandId);
    s.accounts.index('brandId').getAllKeys(IDBKeyRange.only(brandId)).onsuccess = (e) => {
      e.target.result.forEach((key) => s.accounts.delete(key));
    };
  });
}

// Replaces a list in one transaction: the old accounts go and the new ones
// arrive together, or nothing changes at all. The new records are written from
// inside the key lookup's callback so they always land after the deletes.
export function replaceBrand(brand, accounts) {
  return run(['brands', 'accounts'], 'readwrite', (s) => {
    s.accounts.index('brandId').getAllKeys(IDBKeyRange.only(brand.id)).onsuccess = (e) => {
      e.target.result.forEach((key) => s.accounts.delete(key));
      s.brands.put(brand);
      accounts.forEach((a) => s.accounts.put(a));
    };
  });
}

export function getAllBrands() { return getAllFrom('brands'); }

export function putAccounts(accounts) {
  return run(['accounts'], 'readwrite', (s) => { accounts.forEach((a) => s.accounts.put(a)); });
}

export function getAccountsByBrand(brandId) {
  return run(['accounts'], 'readonly', (s) => {
    const box = { value: [] };
    s.accounts.index('brandId').getAll(IDBKeyRange.only(brandId)).onsuccess = (e) => { box.value = e.target.result; };
    return box;
  }).then((box) => box.value);
}

export function getAllAccounts() { return getAllFrom('accounts'); }

// Wipes every brand, account and leftover store: everything the app has ever
// stored in this browser. Used by "Clear all data."
export function clearAllData() {
  return run(ALL_STORES, 'readwrite', (s) => { ALL_STORES.forEach((n) => s[n].clear()); });
}
