// Minimal IndexedDB key-value helper. Resolves to undefined/no-op where IndexedDB isn't available (Node tests).
const DB = 'forge';
const STORE = 'kv';
let dbp = null;

function open() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  if (!dbp) {
    dbp = new Promise((resolve) => {
      let req;
      try { req = indexedDB.open(DB, 1); } catch { resolve(null); return; }
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    });
  }
  return dbp;
}

function tx(mode, fn) {
  return open().then((db) => db && new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const r = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(r?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export const idbGet = (key) => tx('readonly', (s) => s.get(key)).catch(() => undefined);
export const idbSet = (key, value) => tx('readwrite', (s) => s.put(value, key));
export const idbDel = (key) => tx('readwrite', (s) => s.delete(key)).catch(() => undefined);
