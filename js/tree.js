// Folder-tree HTML for the browse view (pure: returns strings, touches no DOM).
// All dynamic text goes through DocSearch.text.escapeHtml/escapeAttr; app.js inserts the result with setHTML().
(function (root) {
  "use strict";
  const text = (typeof require === "function" && typeof module !== "undefined") ? require("./text.js") : root.DocSearch.text;
  const { escapeHtml, escapeAttr } = text;

  // ctx = { expanded: Set of tree keys the user opened, favorites: { "folderId::path": ts }, previewable: Set of extensions }
  function countTreeFiles(node){
    let count = node.files.length;
    node.children.forEach(child => { count += countTreeFiles(child); });
    return count;
  }

  function treeFileRowHtml(f, idx, depth, ctx){
    const canPreview = ctx.previewable.has(f.ext);
    const isFav = (f.folderId + "::" + f.path) in ctx.favorites;
    return `<div class="tree-file-row" style="--depth:${depth}">
      <span class="tree-file-name">${escapeHtml(f.name)}</span>
      <span class="badge ${escapeAttr(f.ext)}">${escapeHtml(f.ext || "—")}</span>
      <span class="tree-file-actions">
        <button data-act="view" data-idx="${idx}" aria-label="${canPreview ? "View" : "Open"} ${escapeAttr(f.name)}" title="${canPreview ? "View" : "Open"}">${canPreview ? "👁" : "⬇"}</button>
        <button data-act="copy" data-idx="${idx}" aria-label="Copy path of ${escapeAttr(f.name)}" title="Copy path">📋</button>
        <button data-act="fav" data-idx="${idx}" class="star-btn ${isFav ? "on" : ""}" aria-pressed="${isFav}" aria-label="Favorite: ${escapeAttr(f.name)}" title="${isFav ? "Remove from favorites" : "Add to favorites"}">${isFav ? "★" : "☆"}</button>
        <button data-act="col" data-idx="${idx}" aria-haspopup="dialog" aria-label="Add ${escapeAttr(f.name)} to a collection" title="Add to a collection">＋</button>
      </span>
    </div>`;
  }

  // Large result sets: don't put collapsed folders' files in the DOM. Their HTML (plain text) is kept in
  // `deferred` and inserted when the folder is expanded. Below this size the tree renders exactly as before.
  const TREE_LAZY_MIN = 2000;

  // `deferred` is a Map (key -> body HTML) in lazy mode, or null. `order` is filled identically either way,
  // so data-idx values, Export list and lastResults don't depend on what is currently in the DOM.
  function renderTreeBranch(node, key, label, depth, order, htmlParts, deferred, ctx){
    const childNames = Array.from(node.children.keys()).sort((a, b) => a.localeCompare(b));
    const files = node.files.slice().sort((a, b) => a.name.localeCompare(b.name));
    const nextDepth = label !== null ? depth + 1 : depth;
    const collapsed = label !== null && !ctx.expanded.has(key);
    const defer = !!deferred && collapsed;
    const bodyParts = defer ? [] : htmlParts;
    if (label !== null){
      htmlParts.push(`<div class="tree-folder ${collapsed ? "collapsed" : ""}" data-treekey="${escapeAttr(key)}">`);
      htmlParts.push(`<button type="button" class="tree-folder-toggle" data-treekey="${escapeAttr(key)}" aria-expanded="${!collapsed}" style="--depth:${depth}">
        <span class="tree-chev">▾</span> 📁 <span class="tree-folder-name">${escapeHtml(label)}</span>
        <span class="tree-folder-count">${countTreeFiles(node)}</span>
      </button>`);
      htmlParts.push(defer ? `<div class="tree-folder-body"></div>` : `<div class="tree-folder-body">`);
    }
    for (const name of childNames){
      renderTreeBranch(node.children.get(name), key + "/" + name, name, nextDepth, order, bodyParts, deferred, ctx);
    }
    files.forEach(f => {
      const idx = order.length;
      order.push(f);
      bodyParts.push(treeFileRowHtml(f, idx, nextDepth, ctx));
    });
    if (label !== null){
      if (defer){
        deferred.set(key, bodyParts.join(""));
        htmlParts.push(`</div>`);
      } else {
        htmlParts.push(`</div></div>`);
      }
    }
  }

  // Builds the whole tree for `results`. Returns { order, html, deferred }:
  //   order    files in display order (data-idx values index into it)
  //   html     markup for the tree
  //   deferred Map(key -> body HTML) of collapsed folders in lazy mode (> TREE_LAZY_MIN files), else null
  function buildTreeHtml(results, ctx){
    // Group into the original folder structure: one root per linked folder, then its
    // real subfolder chain (from each file's path), so browsing mirrors the disk layout.
    const byFolder = new Map(); // folderId -> { name, root: {children:Map, files:[]} }
    results.forEach(f => {
      if (!byFolder.has(f.folderId)){
        byFolder.set(f.folderId, { name: f.folderName, root: { children: new Map(), files: [] } });
      }
      const node0 = byFolder.get(f.folderId).root;
      const segs = f.path.split("/");
      let node = node0;
      for (let i = 0; i < segs.length - 1; i++){
        const seg = segs[i];
        if (!node.children.has(seg)) node.children.set(seg, { children: new Map(), files: [] });
        node = node.children.get(seg);
      }
      node.files.push(f);
    });

    const showFolderHeader = byFolder.size > 1;
    const order = [];
    const htmlParts = [];
    const deferred = results.length > TREE_LAZY_MIN ? new Map() : null;
    Array.from(byFolder.entries())
      .sort((a, b) => a[1].name.localeCompare(b[1].name))
      .forEach(([folderId, entry]) => {
        renderTreeBranch(entry.root, "root::" + folderId, showFolderHeader ? entry.name : null, 0, order, htmlParts, deferred, ctx);
      });
    return { order, html: htmlParts.join(""), deferred };
  }

  const api = { buildTreeHtml, renderTreeBranch, countTreeFiles, treeFileRowHtml, TREE_LAZY_MIN };
  root.DocSearch = root.DocSearch || {};
  root.DocSearch.tree = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
