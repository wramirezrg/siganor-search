// Backup import validation/remapping (pure: no DOM, no IndexedDB). The file is untrusted input.
(function (root) {
  "use strict";
  const BACKUP_MAX_BYTES = 5 * 1024 * 1024;
  const BACKUP_MAX_FAVORITES = 50000;
  const BACKUP_MAX_COLLECTIONS = 2000;

  // Pure (no DOM/IndexedDB): validates a backup file and re-targets it at the folders linked HERE.
  // Folder ids are per-browser UUIDs, so a backup from another browser is matched by folder name.
  // The file is untrusted input: only known fields are copied, with their types checked.
  //   linked        [{ id, name }]  folders currently linked
  //   keptIds       Set of collection ids that stay in place (so imported ones must not reuse them)
  //   newId         () => fresh id
  function remapBackup(data, linked, keptIds, newId){
    if (!data || typeof data !== "object" || Array.isArray(data)
        || !data.favorites || typeof data.favorites !== "object" || Array.isArray(data.favorites)
        || !Array.isArray(data.collections)){
      return { ok: false, error: "That file doesn't look like a doc-search backup." };
    }
    if (Object.keys(data.favorites).length > BACKUP_MAX_FAVORITES || data.collections.length > BACKUP_MAX_COLLECTIONS){
      return { ok: false, error: "That backup is too large to import." };
    }
    const names = (data.folders && typeof data.folders === "object" && !Array.isArray(data.folders)) ? data.folders : {};
    const linkedIds = new Set(linked.map(f => f.id));
    const byName = new Map(); // lowercased name -> id, or null when two linked folders share the name
    for (const f of linked){
      const n = String(f.name).toLowerCase();
      byName.set(n, byName.has(n) ? null : f.id);
    }
    const cache = new Map();
    const skippedFolders = new Set();
    function resolve(oldId){
      if (cache.has(oldId)) return cache.get(oldId);
      let target = null;
      if (linkedIds.has(oldId)) target = oldId;
      else if (typeof names[oldId] === "string") target = byName.get(names[oldId].toLowerCase()) || null;
      if (!target) skippedFolders.add(typeof names[oldId] === "string" ? names[oldId] : "(unknown folder)");
      cache.set(oldId, target);
      return target;
    }

    const targets = new Set();
    for (const oldId of Object.keys(names)){ const t = resolve(oldId); if (t) targets.add(t); }

    const favorites = {};       // newFolderId::path -> ts
    let favCount = 0, skipped = 0;
    for (const [key, ts] of Object.entries(data.favorites)){
      const sep = key.indexOf("::");
      const target = sep > 0 ? resolve(key.slice(0, sep)) : null;
      const path = sep > 0 ? key.slice(sep + 2) : "";
      if (!target || !path || typeof ts !== "number" || !Number.isFinite(ts)){ skipped++; continue; }
      favorites[target + "::" + path] = ts;
      targets.add(target);
      favCount++;
    }

    const used = new Set(keptIds);
    const cols = [];
    for (const c of data.collections){
      const target = (c && typeof c.folderId === "string") ? resolve(c.folderId) : null;
      if (!target || typeof c.name !== "string" || !c.name.trim() || !Array.isArray(c.paths)){ skipped++; continue; }
      let id = (typeof c.id === "string" && c.id && !used.has(c.id)) ? c.id : newId();
      used.add(id);
      cols.push({
        id, folderId: target, name: c.name.trim().slice(0, 200),
        createdAt: (typeof c.createdAt === "number" && Number.isFinite(c.createdAt)) ? c.createdAt : Date.now(),
        paths: c.paths.filter(p => typeof p === "string" && p),
      });
      targets.add(target);
    }
    return { ok: true, favorites, favCount, collections: cols, targets, skipped, skippedFolders: [...skippedFolders] };
  }

  const api = { remapBackup, BACKUP_MAX_BYTES };
  root.DocSearch = root.DocSearch || {};
  root.DocSearch.backup = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
