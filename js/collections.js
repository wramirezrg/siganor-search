// Collection helpers (pure): how many of a collection's saved files still exist, and which filters hide the rest.
(function (root) {
  "use strict";

  // A collection stores file paths inside ONE linked folder. `files` are the currently scanned files
  // ({ folderId, path, ... }). Returns { total, found, missing: [paths not present in the scan] }.
  function collectionStatus(col, files){
    if (!col || !Array.isArray(col.paths)) return { total: 0, found: 0, missing: [] };
    const present = new Set();
    for (const f of files) if (f.folderId === col.folderId) present.add(f.path);
    const missing = col.paths.filter(p => !present.has(p));
    return { total: col.paths.length, found: col.paths.length - missing.length, missing };
  }

  // Human-readable list of the filters (besides the collection itself) that narrow what is shown.
  function activeFilterLabels({ favoritesOnly, folderName, query }){
    const out = [];
    if (favoritesOnly) out.push("Favorites only");
    if (folderName) out.push("Folder: " + folderName);
    if (query && query.trim()) out.push("Search: \"" + query.trim() + "\"");
    return out;
  }

  // Last path segment, for compact "not found" lists.
  function baseName(p){ return String(p).split("/").pop(); }

  const api = { collectionStatus, activeFilterLabels, baseName };
  root.DocSearch = root.DocSearch || {};
  root.DocSearch.collections = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
