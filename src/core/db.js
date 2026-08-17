// IndexedDB wrapper. Everything the app ever stores lives here, in the browser
// only. Nothing in this file, and nothing it writes, is ever committed to git.

const DB_NAME = 'account-atlas';
const DB_VERSION = 1;

let dbPromise = null;

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('brands')) {
        db.createObjectStore('brands', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('accounts')) {
        const store = db.createObjectStore('accounts', { keyPath: 'id' });
        store.createIndex('brandId', 'brandId', { unique: false });
        store.createIndex('county', 'county', { unique: false });
      }
      if (!db.objectStoreNames.contains('matches')) {
        db.createObjectStore('matches', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('geocodeCache')) {
        // key: normalized "address|city|state|zip" -> { lat, lon, matched }
        db.createObjectStore('geocodeCache', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(db, storeName, mode) {
  return db.transaction(storeName, mode).objectStore(storeName);
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function putBrand(brand) {
  const db = await openDb();
  return reqToPromise(tx(db, 'brands', 'readwrite').put(brand));
}

export async function deleteBrand(brandId) {
  const db = await openDb();
  await reqToPromise(tx(db, 'brands', 'readwrite').delete(brandId));
  const accStore = tx(db, 'accounts', 'readwrite');
  const idx = accStore.index('brandId');
  const range = IDBKeyRange.only(brandId);
  return new Promise((resolve, reject) => {
    const cursorReq = idx.openCursor(range);
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      } else {
        resolve();
      }
    };
    cursorReq.onerror = () => reject(cursorReq.error);
  });
}

export async function getAllBrands() {
  const db = await openDb();
  return reqToPromise(tx(db, 'brands', 'readonly').getAll());
}

export async function putAccounts(accounts) {
  const db = await openDb();
  const store = tx(db, 'accounts', 'readwrite');
  await Promise.all(accounts.map((a) => reqToPromise(store.put(a))));
}

export async function getAccountsByBrand(brandId) {
  const db = await openDb();
  const idx = tx(db, 'accounts', 'readonly').index('brandId');
  return reqToPromise(idx.getAll(IDBKeyRange.only(brandId)));
}

export async function getAllAccounts() {
  const db = await openDb();
  return reqToPromise(tx(db, 'accounts', 'readonly').getAll());
}

export async function putMatchGroup(group) {
  const db = await openDb();
  return reqToPromise(tx(db, 'matches', 'readwrite').put(group));
}

export async function getAllMatchGroups() {
  const db = await openDb();
  return reqToPromise(tx(db, 'matches', 'readonly').getAll());
}

export async function getGeocodeCache(key) {
  const db = await openDb();
  return reqToPromise(tx(db, 'geocodeCache', 'readonly').get(key));
}

export async function putGeocodeCache(entry) {
  const db = await openDb();
  return reqToPromise(tx(db, 'geocodeCache', 'readwrite').put(entry));
}

export async function getAllGeocodeCache() {
  const db = await openDb();
  return reqToPromise(tx(db, 'geocodeCache', 'readonly').getAll());
}

export async function bulkPutGeocodeCache(entries) {
  const db = await openDb();
  const store = tx(db, 'geocodeCache', 'readwrite');
  await Promise.all(entries.map((e) => reqToPromise(store.put(e))));
}

// Wipes every brand, account, match, and cached geocode -- everything the
// app has ever stored in this browser. Used by "Clear all data."
export async function clearAllData() {
  const db = await openDb();
  await Promise.all(
    ['brands', 'accounts', 'matches', 'geocodeCache'].map(
      (storeName) => reqToPromise(tx(db, storeName, 'readwrite').clear())
    )
  );
}
