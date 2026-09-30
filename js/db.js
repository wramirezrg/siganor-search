// IndexedDB helpers shared by the app. DB name/version and the object stores are unchanged.
(function (root) {
  "use strict";
  const DB_NAME = "doc-search";
  const DB_VERSION = 6;
  const STORE_HANDLES = "handles";
  const STORE_FOLDERS = "folders"; // one record per linked folder: { id, name, handle, addedAt, lastScanAt }
  const STORE_OPENS = "opens";     // { key: folderId, value: [{path,name,category,ts}, ...] }
  const STORE_SEEN = "seen";       // { key: folderId, value: { [path]: firstSeenTs } }
  const STORE_FAVORITES = "favorites";     // { key: folderId, value: { [path]: favoritedAtTs } }
  const STORE_COLLECTIONS = "collections"; // one record per collection: { id, folderId, name, createdAt, paths: [] }
  const STORE_TEXT_INDEX = "textIndex";    // one record per file: { path, folderId, text, size, lastModified, indexedAt }, key = `${folderId}::${path}`
  const STORE_HASH_INDEX = "hashIndex";    // one record per file: { path, folderId, hash, size, lastModified, hashedAt }, key = `${folderId}::${path}`
  const KEY = "root";              // legacy single-folder handle key, only read during migration

  // ---------- IndexedDB (folder handle + open history + seen manifest) ----------
  // One shared connection instead of opening a new one per operation. It's dropped if another tab
  // upgrades the DB (versionchange) or the browser closes it, and never caches a failed open.
  let dbPromise = null;
  function idbOpen(){
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_HANDLES)) db.createObjectStore(STORE_HANDLES);
        if (!db.objectStoreNames.contains(STORE_FOLDERS)) db.createObjectStore(STORE_FOLDERS);
        if (!db.objectStoreNames.contains(STORE_OPENS)) db.createObjectStore(STORE_OPENS);
        if (!db.objectStoreNames.contains(STORE_SEEN)) db.createObjectStore(STORE_SEEN);
        if (!db.objectStoreNames.contains(STORE_FAVORITES)) db.createObjectStore(STORE_FAVORITES);
        if (!db.objectStoreNames.contains(STORE_COLLECTIONS)) db.createObjectStore(STORE_COLLECTIONS);
        if (!db.objectStoreNames.contains(STORE_TEXT_INDEX)) db.createObjectStore(STORE_TEXT_INDEX);
        if (!db.objectStoreNames.contains(STORE_HASH_INDEX)) db.createObjectStore(STORE_HASH_INDEX);
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => { db.close(); dbPromise = null; };
        db.onclose = () => { dbPromise = null; };
        resolve(db);
      };
      req.onerror = () => { dbPromise = null; reject(req.error); };
    });
    return dbPromise;
  }
  async function idbGet(store, key){
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, "readonly");
      const req = tx.objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }
  async function idbSet(store, key, val){
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, "readwrite");
      tx.objectStore(store).put(val, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  async function idbGetAll(store){
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, "readonly");
      const req = tx.objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }
  async function idbDelete(store, key){
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, "readwrite");
      tx.objectStore(store).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // Deletes every record whose (string) key starts with `prefix` — used to clear one folder's `folderId::path` entries.
  async function idbDeleteByPrefix(store, prefix){
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, "readwrite");
      const req = tx.objectStore(store).openKeyCursor(IDBKeyRange.bound(prefix, prefix + "\uffff"));
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;
        tx.objectStore(store).delete(cursor.primaryKey);
        cursor.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  const api = {
    DB_NAME, DB_VERSION, KEY,
    STORE_HANDLES, STORE_FOLDERS, STORE_OPENS, STORE_SEEN, STORE_FAVORITES, STORE_COLLECTIONS, STORE_TEXT_INDEX, STORE_HASH_INDEX,
    idbOpen, idbGet, idbSet, idbGetAll, idbDelete, idbDeleteByPrefix,
  };
  root.DocSearch = root.DocSearch || {};
  root.DocSearch.db = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
