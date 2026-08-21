(function(){
  "use strict";

  if (window.pdfjsLib){
    pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdfjs/pdf.worker.min.js";
  }

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
  const ACTIVE_KEY = "activeFolderId";
  const MAX_OPENS = 300;
  const HALF_LIFE_DAYS = 14;
  const ALL_VALUE = "all";
  const TEXT_INDEXABLE = new Set(["pdf","txt","htm","html"]);
  const MAX_PDF_INDEX_SIZE = 40 * 1024 * 1024; // skip huge PDFs (likely image scans, or pathologically slow)
  const SNIPPET_RADIUS = 80;

  const PREVIEWABLE = new Set(["pdf","png","jpg","jpeg","gif","webp","txt","htm","html"]);
  const STOPWORDS = new Set(["de","la","el","los","las","en","del","para","con","por","un","una","y","the","and","of","for","en-p","en-e","pdf","doc","manual","guide","user","instructions"]);

  let rootHandle = null;
  let folders = [];            // [{ id, name, handle, addedAt, lastScanAt }]
  let activeFolderId = null;
  let allFiles = [];
  let activeCategory = ALL_VALUE;
  let lastScanAt = null;
  let favoritesMap = {};       // { [path]: favoritedAtTs }
  let favoritesOnly = false;
  let collections = [];        // [{ id, name, createdAt, paths: [] }]
  let activeCollectionId = null;
  let textIndex = new Map();   // path -> extracted text (in-memory, loaded from STORE_TEXT_INDEX)
  let indexQueueTotal = 0;
  let indexQueueDone = 0;
  let indexingActive = false;
  let hashIndex = new Map();   // path -> { path, hash, size, lastModified, hashedAt }
  let hashQueueTotal = 0;
  let hashQueueDone = 0;
  let hashingActive = false;
  let duplicateGroups = [];    // [[entry, entry, ...], ...] — groups of 2+ files sharing a hash
  let scanGeneration = 0;      // bumped by scan()/unlinking; lets stale index/hash loops detect they're obsolete and stop
  let lastResults = [];        // last rendered/filtered results, for keyboard nav + export
  let selectedRowIndex = -1;
  const COLLAPSE_KEY = "docSearchCollapsedCards";
  let collapsedCards = loadCollapsedCards();

  const els = {
    status: document.getElementById("status"),
    introView: document.getElementById("introView"),
    layout: document.getElementById("layout"),
    sidebar: document.getElementById("sidebar"),
    rootView: document.getElementById("rootView"),
    controlsRow: document.getElementById("controlsRow"),
    search: document.getElementById("search"),
    categorySelect: document.getElementById("categorySelect"),
    refreshBtn: document.getElementById("refreshBtn"),
    exportBtn: document.getElementById("exportBtn"),
    chips: document.getElementById("chips"),
    toast: document.getElementById("toast"),
    indexStatus: document.getElementById("indexStatus"),
    backupFileInput: document.getElementById("backupFileInput"),
    titleText: document.getElementById("titleText"),
  };

  // ---------- Trusted Types gate ----------
  // Every dynamic HTML string assigned below is already escaped via escapeHtml()/escapeAttr(),
  // so this policy doesn't re-sanitize — it's a gate: only code that calls setHTML() may write
  // innerHTML at all, so a future unescaped assignment fails loudly instead of becoming an XSS hole.
  const ttPolicy = (window.trustedTypes && trustedTypes.createPolicy)
    ? trustedTypes.createPolicy("docsearch-html", { createHTML: s => s })
    : null;
  function setHTML(el, html){
    el.innerHTML = ttPolicy ? ttPolicy.createHTML(html) : html;
  }
  // "default" policy: catches script-URL requests from libraries that aren't Trusted-Types-aware
  // (pdf.js creating its worker via a plain string). Deliberately omits createHTML — any innerHTML
  // write that doesn't go through setHTML()/docsearch-html above still gets blocked as before.
  if (window.trustedTypes && trustedTypes.createPolicy){
    trustedTypes.createPolicy("default", { createScriptURL: s => s, createScript: s => s });
  }

  // ---------- IndexedDB (folder handle + open history + seen manifest) ----------
  function idbOpen(){
    return new Promise((resolve, reject) => {
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
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
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

  function toast(msg){
    els.toast.textContent = msg;
    els.toast.classList.add("show");
    setTimeout(() => els.toast.classList.remove("show"), 1800);
  }

  // ---------- One-time migration: single folder (legacy) -> multi-folder ----------
  async function migrateLegacyDataIfNeeded(){
    const existingFolders = await idbGetAll(STORE_FOLDERS);
    if (existingFolders.length) return; // already migrated (idempotent)
    const legacyHandle = await idbGet(STORE_HANDLES, KEY).catch(() => null);
    if (!legacyHandle) return; // fresh install, nothing to migrate

    const legacyId = crypto.randomUUID();
    await idbSet(STORE_FOLDERS, legacyId, {
      id: legacyId, name: legacyHandle.name, handle: legacyHandle,
      addedAt: Date.now(), lastScanAt: null,
    });

    const oldLog = await idbGet(STORE_OPENS, "log");
    if (oldLog){ await idbSet(STORE_OPENS, legacyId, oldLog); await idbDelete(STORE_OPENS, "log"); }

    const oldManifest = await idbGet(STORE_SEEN, "manifest");
    if (oldManifest){ await idbSet(STORE_SEEN, legacyId, oldManifest); await idbDelete(STORE_SEEN, "manifest"); }

    const oldFavs = await idbGet(STORE_FAVORITES, "map");
    if (oldFavs){ await idbSet(STORE_FAVORITES, legacyId, oldFavs); await idbDelete(STORE_FAVORITES, "map"); }

    const oldCols = await idbGetAll(STORE_COLLECTIONS);
    for (const col of oldCols){
      if (col.folderId) continue;
      col.folderId = legacyId;
      await idbSet(STORE_COLLECTIONS, col.id, col);
    }

    const oldText = await idbGetAll(STORE_TEXT_INDEX);
    for (const rec of oldText){
      if (rec.folderId) continue;
      await idbDelete(STORE_TEXT_INDEX, rec.path);
      rec.folderId = legacyId;
      await idbSet(STORE_TEXT_INDEX, legacyId + "::" + rec.path, rec);
    }

    const oldHash = await idbGetAll(STORE_HASH_INDEX);
    for (const rec of oldHash){
      if (rec.folderId) continue;
      await idbDelete(STORE_HASH_INDEX, rec.path);
      rec.folderId = legacyId;
      await idbSet(STORE_HASH_INDEX, legacyId + "::" + rec.path, rec);
    }

    await idbSet(STORE_HANDLES, ACTIVE_KEY, legacyId);
    await idbDelete(STORE_HANDLES, KEY);
    console.info(`doc-search: migrated legacy single-folder data to folder "${legacyHandle.name}".`);
  }

  // ---------- Folder manager (multiple linked folders) ----------
  async function loadFolders(){
    folders = await idbGetAll(STORE_FOLDERS);
    folders.sort((a, b) => a.name.localeCompare(b.name));
  }

  async function linkFolder(){
    try{
      const handle = await window.showDirectoryPicker();
      for (const f of folders){
        if (await f.handle.isSameEntry(handle)){
          toast("That folder is already linked.");
          await setActiveFolder(f.id);
          return;
        }
      }
      const id = crypto.randomUUID();
      await idbSet(STORE_FOLDERS, id, { id, name: handle.name, handle, addedAt: Date.now(), lastScanAt: null });
      await loadFolders();
      toast("Folder linked: " + handle.name);
      await setActiveFolder(id);
    }catch(e){
      if (e.name !== "AbortError") setStatus("Couldn't open the folder: " + e.message, true);
    }
  }

  async function setActiveFolder(folderId){
    const rec = folders.find(f => f.id === folderId);
    if (!rec) return;
    const perm = await rec.handle.queryPermission({ mode: "read" }).catch(() => "prompt");
    if (perm !== "granted"){
      const req = await rec.handle.requestPermission({ mode: "read" }).catch(() => "denied");
      if (req !== "granted"){ toast("Permission denied for " + rec.name); return; }
    }
    rootHandle = rec.handle;
    activeFolderId = rec.id;
    await idbSet(STORE_HANDLES, ACTIVE_KEY, activeFolderId);
    favoritesMap = {};
    collections = [];
    activeCollectionId = null;
    textIndex = new Map();
    hashIndex = new Map();
    duplicateGroups = [];
    activeCategory = ALL_VALUE;
    favoritesOnly = false;
    await scan();
  }

  async function unlinkFolder(folderId){
    const rec = folders.find(f => f.id === folderId);
    await idbDelete(STORE_FOLDERS, folderId);
    await loadFolders();
    if (folderId === activeFolderId){
      if (folders.length){
        await setActiveFolder(folders[0].id);
      } else {
        rootHandle = null;
        activeFolderId = null;
        scanGeneration++;
        indexingActive = false;
        hashingActive = false;
        els.indexStatus.style.display = "none";
        await idbDelete(STORE_HANDLES, ACTIVE_KEY);
        els.controlsRow.style.display = "none";
        setHTML(els.chips, "");
        renderSelectPrompt(false);
      }
    } else {
      await renderSidebar();
    }
    toast("Folder unlinked" + (rec ? ": " + rec.name : "") + ".");
  }

  // ---------- UI: initial screens ----------
  function renderUnsupported(){
    els.layout.style.display = "none";
    els.indexStatus.style.display = "none";
    setStatus("");
    setHTML(els.introView, `
      <div class="center-panel">
        <h2>Browser not supported</h2>
        <p>This tool needs the <b>File System Access API</b> to read the folder live.
        Open this file with <b>Microsoft Edge</b> or <b>Google Chrome</b> (Firefox doesn't support it).</p>
      </div>`);
  }

  function renderSelectPrompt(reconnect){
    els.layout.style.display = "none";
    els.indexStatus.style.display = "none";
    setStatus("");
    if (!reconnect){
      renderPrivacyModal(renderFolderPicker);
      return;
    }
    renderFolderPicker(true);
  }

  function renderPrivacyModal(onAcknowledge){
    setHTML(els.introView, `
      <div class="modal-overlay">
        <div class="modal-box">
          <h2>🔒 Before you start</h2>
          <p>This tool runs 100% in your browser. Nothing is uploaded, copied, or sent anywhere. There's no server, no account needed, and no internet connection required after this page loads.</p>
          <p>In a moment your browser will ask you to confirm access to a folder. That's a standard security prompt built into Chrome/Edge, not something this site controls. You can revoke that access anytime from your browser's site settings.</p>
          <button class="primary" id="ackBtn">I understand, continue</button>
        </div>
      </div>`);
    const ackBtn = document.getElementById("ackBtn");
    ackBtn.addEventListener("click", () => onAcknowledge(false));
    ackBtn.focus();
  }

  function renderFolderPicker(reconnect){
    setHTML(els.introView, `
      <div class="center-panel">
        <h2>${reconnect ? "Reconnect folder" : "Select a folder to search"}</h2>
        <p>${reconnect
          ? "The browser needs you to re-confirm read permission on the saved folder."
          : "The first time you need to pick a folder manually. It's remembered after that."}</p>
        <div class="picker-actions">
          <button class="primary" id="pickBtn">${reconnect ? "Reconnect" : "📁 Select folder"}</button>
          ${reconnect ? "" : `<a class="button-like" id="githubLink" href="https://github.com/wramirezrg/siganor-search" target="_blank" rel="noopener noreferrer">⭐ View on GitHub</a>`}
        </div>
        <p class="fine-print">${reconnect
          ? "Your browser asks for this every time it opens this page. That's normal, and nothing was lost; your files were never uploaded anywhere, they stay on your device. Press Enter to reconnect instantly."
          : "🔒 Everything stays on your device. Nothing is ever uploaded, no account needed, no server involved."}</p>
      </div>`);
    const pickBtn = document.getElementById("pickBtn");
    pickBtn.onclick = reconnect ? reconnectFolder : linkFolder;
    pickBtn.focus();
  }

  async function reconnectFolder(){
    try{
      const perm = await rootHandle.requestPermission({ mode: "read" });
      if (perm === "granted") await scan();
      else setStatus("Permission denied.", true);
    }catch(e){
      setStatus("Couldn't reconnect: " + e.message, true);
    }
  }

  function setStatus(msg, isErr){
    els.status.textContent = msg || "";
    els.status.className = isErr ? "err" : "";
  }

  // ---------- Live recursive scan ----------
  async function walk(dirHandle, relPath, out){
    for await (const [name, handle] of dirHandle.entries()){
      if (name.startsWith(".")) continue; // .vscode, dotfiles
      const newRel = relPath ? relPath + "/" + name : name;
      if (handle.kind === "directory"){
        await walk(handle, newRel, out);
      } else {
        out.push({ name, path: newRel, handle });
      }
    }
  }

  async function scan(){
    scanGeneration++;
    els.controlsRow.style.display = "none";
    els.layout.style.display = "none";
    setHTML(els.introView, "");
    setHTML(els.chips, "");
    setHTML(els.rootView, "");
    document.title = "Search · " + rootHandle.name;
    els.titleText.textContent = "Search · " + rootHandle.name;
    setStatus(`Scanning ${rootHandle.name} live…`);
    const t0 = performance.now();
    try{
      const files = [];
      await walk(rootHandle, "", files);
      files.forEach(f => {
        const segs = f.path.split("/");
        f.category = segs[0];
        f.folder = segs.slice(1, -1).join(" / ") || "(category root)";
        const dot = f.name.lastIndexOf(".");
        f.ext = dot > -1 ? f.name.slice(dot + 1).toLowerCase() : "";
      });
      allFiles = files;
      lastScanAt = new Date();
      const ms = Math.round(performance.now() - t0);
      setStatus(`${allFiles.length} files indexed in ${ms} ms.`);
      const activeRec = folders.find(f => f.id === activeFolderId);
      if (activeRec){
        activeRec.lastScanAt = Date.now();
        await idbSet(STORE_FOLDERS, activeRec.id, activeRec);
      }
      favoritesMap = (await idbGet(STORE_FAVORITES, activeFolderId)) || {};
      await loadCollections();
      await buildTextIndexMap();
      await buildHashIndexMap();
      buildCategoryChips();
      els.controlsRow.style.display = "flex";
      els.layout.style.display = "grid";
      applyFilters();
      await refreshInsights();
      runIndexQueue(); // fire-and-forget: indexes new/changed PDFs in the background
    }catch(e){
      setStatus("Error scanning the folder: " + e.message, true);
    }
  }

  // ---------- Categories ----------
  function buildCategoryChips(){
    const cats = Array.from(new Set(allFiles.map(f => f.category))).sort();
    setHTML(els.categorySelect, `<option value="${ALL_VALUE}">All categories</option>` +
      cats.map(c => `<option value="${escapeAttr(c)}">${escapeHtml(c)}</option>`).join(""));
    els.categorySelect.value = activeCategory;

    const favCount = Object.keys(favoritesMap).length;
    const favChip = `<div class="chip fav-chip ${favoritesOnly ? "active" : ""}" id="favChip">⭐ Favorites (${favCount})</div>`;

    const catChips = [ALL_VALUE, ...cats].map(c => {
      const label = c === ALL_VALUE ? "All" : c;
      const count = c === ALL_VALUE ? allFiles.length : allFiles.filter(f => f.category === c).length;
      return `<div class="chip ${c === activeCategory && !activeCollectionId ? "active" : ""}" data-cat="${escapeAttr(c)}">${escapeHtml(label)} (${count})</div>`;
    }).join("");

    setHTML(els.chips, favChip + catChips);

    document.getElementById("favChip").addEventListener("click", () => {
      favoritesOnly = !favoritesOnly;
      applyFilters();
      buildCategoryChips();
    });
    els.chips.querySelectorAll(".chip[data-cat]").forEach(chip => {
      chip.addEventListener("click", () => {
        activeCategory = chip.dataset.cat;
        activeCollectionId = null;
        els.categorySelect.value = activeCategory;
        els.chips.querySelectorAll(".chip[data-cat]").forEach(c => c.classList.toggle("active", c.dataset.cat === activeCategory));
        applyFilters();
        renderSidebar();
      });
    });
  }

  // ---------- Filter + render ----------
  let debounceT = null;
  els.search.addEventListener("input", () => {
    clearTimeout(debounceT);
    debounceT = setTimeout(applyFilters, 100);
  });
  els.categorySelect.addEventListener("change", () => {
    activeCategory = els.categorySelect.value;
    activeCollectionId = null;
    document.querySelectorAll(".chip[data-cat]").forEach(c => c.classList.toggle("active", c.dataset.cat === activeCategory));
    applyFilters();
    renderSidebar();
  });
  els.refreshBtn.addEventListener("click", scan);
  els.exportBtn.addEventListener("click", exportResults);
  els.backupFileInput.addEventListener("change", async () => {
    const file = els.backupFileInput.files[0];
    els.backupFileInput.value = ""; // allow re-selecting the same file next time
    if (file) await importBackup(file);
  });

  // ---------- Keyboard shortcuts ----------
  function updateRowSelection(){
    const rows = els.rootView.querySelectorAll("tbody tr");
    rows.forEach((tr, i) => tr.classList.toggle("row-selected", i === selectedRowIndex));
    if (selectedRowIndex >= 0 && rows[selectedRowIndex]){
      rows[selectedRowIndex].scrollIntoView({ block: "nearest" });
    }
  }
  document.addEventListener("keydown", (e) => {
    const tag = (e.target.tagName || "").toLowerCase();
    const inInput = tag === "input" || tag === "textarea";

    if (e.key === "/" && !inInput){
      e.preventDefault();
      els.search.focus();
      return;
    }
    if (e.key === "Escape" && document.activeElement === els.search){
      els.search.value = "";
      applyFilters();
      els.search.blur();
      return;
    }
    if (inInput || !lastResults.length) return;

    if (e.key === "ArrowDown"){
      e.preventDefault();
      selectedRowIndex = Math.min(selectedRowIndex + 1, lastResults.length - 1);
      updateRowSelection();
    } else if (e.key === "ArrowUp"){
      e.preventDefault();
      selectedRowIndex = Math.max(selectedRowIndex - 1, 0);
      updateRowSelection();
    } else if (e.key === "Enter" && selectedRowIndex >= 0){
      e.preventDefault();
      viewFile(lastResults[selectedRowIndex]);
    }
  });

  function applyFilters(){
    const q = els.search.value.trim().toLowerCase();
    let results = allFiles;
    if (activeCollectionId){
      const col = collections.find(c => c.id === activeCollectionId);
      const paths = new Set(col ? col.paths : []);
      results = results.filter(f => paths.has(f.path));
    } else if (activeCategory !== ALL_VALUE){
      results = results.filter(f => f.category === activeCategory);
    }
    if (favoritesOnly) results = results.filter(f => f.path in favoritesMap);

    let snippets = null;
    if (q){
      snippets = new Map();
      results = results.filter(f => {
        if (f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q)) return true;
        const rec = textIndex.get(f.path);
        if (rec && rec.text.toLowerCase().includes(q)){
          const snip = findSnippet(rec.text, q);
          if (snip) snippets.set(f.path, snip);
          return true;
        }
        return false;
      });
    }
    results = results.slice().sort((a, b) => a.path.localeCompare(b.path));
    render(results, snippets);
  }

  function render(results, snippets){
    lastResults = results;
    selectedRowIndex = -1;
    if (!results.length){
      setHTML(els.rootView, `<div class="empty">No results.</div>`);
      return;
    }
    const rows = results.map((f, i) => {
      const canPreview = PREVIEWABLE.has(f.ext);
      const isFav = f.path in favoritesMap;
      const snippet = snippets && snippets.get(f.path);
      return `<tr>
        <td>
          <div class="name">${escapeHtml(f.name)}</div>
          <div class="path">${escapeHtml(f.folder)}</div>
          ${snippet ? `<div class="snippet">📄 "${snippet}"</div>` : ""}
        </td>
        <td class="cat">${escapeHtml(f.category)}</td>
        <td><span class="badge ${escapeAttr(f.ext)}">${escapeHtml(f.ext || "—")}</span></td>
        <td class="actions">
          <button data-act="view" data-idx="${i}">${canPreview ? "👁 View" : "⬇ Open"}</button>
          <button data-act="copy" data-idx="${i}">📋 Copy path</button>
          <button data-act="fav" data-idx="${i}" class="star-btn ${isFav ? "on" : ""}" title="${isFav ? "Remove from favorites" : "Add to favorites"}">${isFav ? "★" : "☆"}</button>
          <button data-act="col" data-idx="${i}" title="Add to a collection">＋</button>
        </td>
      </tr>`;
    }).join("");

    setHTML(els.rootView, `
      <table>
        <thead><tr><th>File</th><th>Category</th><th>Type</th><th>Actions</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <footer>
        <span>${results.length} result(s) out of ${allFiles.length} total files</span>
        <span>Last scan: ${lastScanAt ? lastScanAt.toLocaleTimeString() : "—"}</span>
      </footer>`);

    els.rootView.querySelectorAll("button[data-act]").forEach(btn => {
      btn.addEventListener("click", () => {
        const entry = results[Number(btn.dataset.idx)];
        if (btn.dataset.act === "view") viewFile(entry);
        else if (btn.dataset.act === "copy") copyPath(entry);
        else if (btn.dataset.act === "fav") toggleFavorite(entry, btn);
        else if (btn.dataset.act === "col") openCollectionsMenu(entry, btn);
      });
    });
  }

  async function viewFile(entry){
    try{
      const file = await entry.handle.getFile();
      const url = URL.createObjectURL(file);
      if (PREVIEWABLE.has(entry.ext)){
        window.open(url, "_blank");
      } else {
        const a = document.createElement("a");
        a.href = url; a.download = entry.name;
        document.body.appendChild(a); a.click(); a.remove();
      }
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      await logOpen(entry);
    }catch(e){
      toast("Couldn't open: " + e.message);
    }
  }

  // ---------- Open history ----------
  async function logOpen(entry){
    const log = (await idbGet(STORE_OPENS, activeFolderId)) || [];
    log.push({ path: entry.path, name: entry.name, category: entry.category, ts: Date.now() });
    const trimmed = log.slice(-MAX_OPENS);
    await idbSet(STORE_OPENS, activeFolderId, trimmed);
    await renderSidebar();
  }

  function copyPath(entry){
    // Note: the File System Access API never exposes the real absolute system path —
    // this is relative to the folder you selected, prefixed with that folder's own name.
    const full = rootHandle.name + "\\" + entry.path.replace(/\//g, "\\");
    navigator.clipboard.writeText(full).then(
      () => toast("Path copied: " + full),
      () => toast("Couldn't copy to clipboard")
    );
  }

  // ---------- Export current results ----------
  function exportResults(){
    if (!lastResults.length){ toast("Nothing to export. No results shown."); return; }
    const lines = [`# ${rootHandle.name} · ${lastResults.length} file(s)`, `Exported ${new Date().toLocaleString()}`];
    let lastCat = null;
    lastResults.forEach(f => {
      if (f.category !== lastCat){
        lines.push(`\n## ${f.category}`);
        lastCat = f.category;
      }
      lines.push(`- **${f.name}** · ${f.folder} (${f.ext || "—"})`);
    });
    const blob = new Blob([lines.join("\n")], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "index.md";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    toast(`Exported ${lastResults.length} file(s) to index.md`);
  }

  // ---------- Backup / restore (favorites + collections only) ----------
  function exportBackup(){
    const payload = {
      exportedAt: new Date().toISOString(),
      favorites: favoritesMap,
      collections: collections,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = payload.exportedAt.slice(0, 10);
    a.href = url; a.download = `docsearch-backup-${stamp}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    toast("Backup exported.");
  }

  async function importBackup(file){
    let data;
    try{
      data = JSON.parse(await file.text());
    }catch(e){
      toast("Backup file isn't valid JSON.");
      return;
    }
    if (!data || typeof data.favorites !== "object" || data.favorites === null || !Array.isArray(data.collections)){
      toast("That file doesn't look like a doc-search backup.");
      return;
    }
    const favCount = Object.keys(data.favorites).length;
    if (!confirm(`Replace current favorites (${favCount}) and collections (${data.collections.length}) with this backup? This can't be undone.`)){
      return;
    }
    for (const col of collections){
      await idbDelete(STORE_COLLECTIONS, col.id);
    }
    for (const col of data.collections){
      col.folderId = activeFolderId;
      await idbSet(STORE_COLLECTIONS, col.id, col);
    }
    favoritesMap = data.favorites;
    await idbSet(STORE_FAVORITES, activeFolderId, favoritesMap);

    await loadCollections();
    buildCategoryChips();
    applyFilters();
    await renderSidebar();
    toast("Backup restored.");
  }

  // ---------- Favorites ----------
  async function toggleFavorite(entry, btn){
    const isFav = entry.path in favoritesMap;
    if (isFav) delete favoritesMap[entry.path];
    else favoritesMap[entry.path] = Date.now();
    await idbSet(STORE_FAVORITES, activeFolderId, favoritesMap);
    if (btn){
      const nowFav = entry.path in favoritesMap;
      btn.classList.toggle("on", nowFav);
      btn.textContent = nowFav ? "★" : "☆";
      btn.title = nowFav ? "Remove from favorites" : "Add to favorites";
    }
    if (favoritesOnly) applyFilters();
    buildCategoryChips();
    await renderSidebar();
  }

  // ---------- Collections ----------
  async function loadCollections(){
    collections = (await idbGetAll(STORE_COLLECTIONS)).filter(c => c.folderId === activeFolderId);
    collections.sort((a, b) => a.name.localeCompare(b.name));
  }

  async function createCollection(name){
    name = (name || "").trim();
    if (!name) return null;
    const col = { id: crypto.randomUUID(), folderId: activeFolderId, name, createdAt: Date.now(), paths: [] };
    await idbSet(STORE_COLLECTIONS, col.id, col);
    await loadCollections();
    return col;
  }

  async function toggleFileInCollection(colId, path){
    const col = collections.find(c => c.id === colId);
    if (!col) return;
    const idx = col.paths.indexOf(path);
    if (idx === -1) col.paths.push(path); else col.paths.splice(idx, 1);
    await idbSet(STORE_COLLECTIONS, col.id, col);
  }

  async function deleteCollection(colId){
    await idbDelete(STORE_COLLECTIONS, colId);
    if (activeCollectionId === colId){
      activeCollectionId = null;
      applyFilters();
    }
    await loadCollections();
    await renderSidebar();
  }

  function closeCollectionsMenu(){
    const existing = document.querySelector(".collections-menu");
    if (existing) existing.remove();
  }

  function openCollectionsMenu(entry, btn){
    closeCollectionsMenu();
    const menu = document.createElement("div");
    menu.className = "collections-menu";
    const renderMenuBody = () => `
      ${collections.length ? collections.map(c => `
        <label class="cm-item">
          <input type="checkbox" data-colid="${escapeAttr(c.id)}" ${c.paths.includes(entry.path) ? "checked" : ""}>
          ${escapeHtml(c.name)}
        </label>`).join("") : `<p class="side-hint">No collections yet.</p>`}
      <div class="cm-new">
        <input type="text" placeholder="+ New collection" class="cm-new-input">
      </div>`;
    setHTML(menu, renderMenuBody());

    const rect = btn.getBoundingClientRect();
    menu.style.top = (window.scrollY + rect.bottom + 4) + "px";
    menu.style.left = (window.scrollX + rect.right - 220) + "px";
    document.body.appendChild(menu);

    function wireMenuInputs(){
      menu.querySelectorAll("input[type=checkbox]").forEach(cb => {
        cb.addEventListener("change", async () => {
          await toggleFileInCollection(cb.dataset.colid, entry.path);
          await loadCollections();
          await renderSidebar();
        });
      });
      menu.querySelector(".cm-new-input").addEventListener("keydown", async (e) => {
        if (e.key === "Enter" && e.target.value.trim()){
          const col = await createCollection(e.target.value);
          if (col) await toggleFileInCollection(col.id, entry.path);
          await loadCollections();
          await renderSidebar();
          setHTML(menu, renderMenuBody());
          wireMenuInputs();
        }
      });
    }
    wireMenuInputs();

    setTimeout(() => {
      document.addEventListener("click", function onDocClick(e){
        if (!menu.contains(e.target) && e.target !== btn){
          closeCollectionsMenu();
          document.removeEventListener("click", onDocClick);
        }
      });
    }, 0);
  }

  // ---------- Full-text index (pdf.js for PDFs, plain read for txt/htm) ----------
  async function buildTextIndexMap(){
    const records = (await idbGetAll(STORE_TEXT_INDEX)).filter(r => r.folderId === activeFolderId);
    textIndex = new Map(records.map(r => [r.path, r]));
  }

  async function extractText(entry, file){
    if (entry.ext === "pdf"){
      if (!window.pdfjsLib || file.size > MAX_PDF_INDEX_SIZE) return null;
      const buf = await file.arrayBuffer();
      // isEvalSupported:false disables pdf.js's eval()-based font-loading fast path —
      // mitigates GHSA-wgrm-67xf-hhpq (arbitrary JS execution via a crafted font in this pdf.js version)
      const pdf = await pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
      let text = "";
      for (let p = 1; p <= pdf.numPages; p++){
        const page = await pdf.getPage(p);
        const content = await page.getTextContent();
        text += content.items.map(it => it.str).join(" ") + "\n";
      }
      return text;
    }
    if (entry.ext === "txt" || entry.ext === "htm" || entry.ext === "html"){
      return await file.text();
    }
    return null;
  }

  function updateStatusLine(){
    if (indexingActive){
      const pct = indexQueueTotal ? Math.round((indexQueueDone / indexQueueTotal) * 100) : 0;
      els.indexStatus.style.display = "block";
      els.indexStatus.textContent = `📄 Indexing text for search: ${indexQueueDone}/${indexQueueTotal} (${pct}%)…`;
      return;
    }
    if (hashingActive){
      const pct = hashQueueTotal ? Math.round((hashQueueDone / hashQueueTotal) * 100) : 0;
      els.indexStatus.style.display = "block";
      els.indexStatus.textContent = `🔁 Checking for duplicates: ${hashQueueDone}/${hashQueueTotal} (${pct}%)…`;
      return;
    }
    if (!textIndex.size && !hashIndex.size){
      els.indexStatus.style.display = "none";
      return;
    }
    els.indexStatus.style.display = "block";
    const dupPart = duplicateGroups.length
      ? ` · 🔁 ${duplicateGroups.length} duplicate group(s) found.`
      : (hashIndex.size ? " · 🔁 no duplicates found." : "");
    els.indexStatus.textContent = `📄 Text index: ${textIndex.size} file(s) searchable by content.${dupPart}`;
  }

  async function runIndexQueue(){
    if (indexingActive) return; // don't overlap runs (e.g. a manual refresh mid-index)
    const myGeneration = scanGeneration;
    const candidates = allFiles.filter(f => TEXT_INDEXABLE.has(f.ext));
    if (candidates.length){
      indexingActive = true;
      indexQueueTotal = candidates.length;
      indexQueueDone = 0;
      let indexedCount = 0;
      updateStatusLine();

      for (const entry of candidates){
        if (scanGeneration !== myGeneration){ indexingActive = false; return; } // folder switched/unlinked mid-run — stop, don't touch the new folder's state

        try{
          const file = await entry.handle.getFile();
          const cached = textIndex.get(entry.path);
          if (!cached || cached.size !== file.size || cached.lastModified !== file.lastModified){
            const text = await extractText(entry, file);
            if (text != null){
              const record = { path: entry.path, folderId: activeFolderId, text, size: file.size, lastModified: file.lastModified, indexedAt: Date.now() };
              await idbSet(STORE_TEXT_INDEX, activeFolderId + "::" + entry.path, record);
              textIndex.set(entry.path, record);
              indexedCount++;
            }
          }
        }catch(e){
          // unreadable/encrypted/corrupt PDF — skip it, not fatal to the rest of the queue
        }
        indexQueueDone++;
        updateStatusLine();
        await new Promise(r => setTimeout(r, 0));
      }

      indexingActive = false;
      updateStatusLine();
      if (indexedCount > 0) applyFilters(); // newly-indexed files may now match the current search
    }
    if (scanGeneration !== myGeneration) return;
    runHashQueue(); // chained, not parallel — avoids competing for I/O with the text-index pass above
  }

  // ---------- Duplicate detection (SHA-256, all file types) ----------
  async function buildHashIndexMap(){
    const records = (await idbGetAll(STORE_HASH_INDEX)).filter(r => r.folderId === activeFolderId);
    hashIndex = new Map(records.map(r => [r.path, r]));
    groupDuplicates();
  }

  function groupDuplicates(){
    const byPath = new Map(allFiles.map(f => [f.path, f]));
    const byHash = new Map();
    hashIndex.forEach(rec => {
      const f = byPath.get(rec.path);
      if (!f) return; // stale entry for a file that moved/disappeared — ignore, don't delete (may reappear)
      if (!byHash.has(rec.hash)) byHash.set(rec.hash, []);
      byHash.get(rec.hash).push(f);
    });
    duplicateGroups = Array.from(byHash.values()).filter(g => g.length > 1);
    duplicateGroups.sort((a, b) => b.length - a.length);
  }

  async function hashFile(file){
    const buf = await file.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", buf);
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
  }

  async function runHashQueue(){
    if (hashingActive) return;
    const myGeneration = scanGeneration;
    const candidates = allFiles;
    if (!candidates.length) return;

    hashingActive = true;
    hashQueueTotal = candidates.length;
    hashQueueDone = 0;
    updateStatusLine();

    for (const entry of candidates){
      if (scanGeneration !== myGeneration){ hashingActive = false; return; } // folder switched/unlinked mid-run

      try{
        const file = await entry.handle.getFile();
        const cached = hashIndex.get(entry.path);
        if (!cached || cached.size !== file.size || cached.lastModified !== file.lastModified){
          const hash = await hashFile(file);
          const record = { path: entry.path, folderId: activeFolderId, hash, size: file.size, lastModified: file.lastModified, hashedAt: Date.now() };
          await idbSet(STORE_HASH_INDEX, activeFolderId + "::" + entry.path, record);
          hashIndex.set(entry.path, record);
        }
      }catch(e){
        // unreadable file — skip, not fatal to the rest of the queue
      }
      hashQueueDone++;
      updateStatusLine();
      await new Promise(r => setTimeout(r, 0));
    }

    hashingActive = false;
    groupDuplicates();
    updateStatusLine();
    await renderSidebar(); // duplicates card needs to reflect the freshly computed groups
  }

  function findSnippet(text, q){
    const idx = text.toLowerCase().indexOf(q);
    if (idx === -1) return null;
    const start = Math.max(0, idx - SNIPPET_RADIUS);
    const end = Math.min(text.length, idx + q.length + SNIPPET_RADIUS);
    const prefix = start > 0 ? "…" : "";
    const suffix = end < text.length ? "…" : "";
    const before = escapeHtml(text.slice(start, idx));
    const match = escapeHtml(text.slice(idx, idx + q.length));
    const after = escapeHtml(text.slice(idx + q.length, end));
    return `${prefix}${before}<mark>${match}</mark>${after}${suffix}`.replace(/\s+/g, " ");
  }

  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  }
  function escapeAttr(s){ return escapeHtml(s); }

  function relativeTime(ts){
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return "just now";
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} h ago`;
    const d = Math.round(h / 24);
    if (d < 30) return `${d} d ago`;
    return `${Math.round(d / 30)} month(s) ago`;
  }

  function tokenize(path){
    return path
      .toLowerCase()
      .split(/[\/\-_.\s()]+/)
      .filter(t => t.length >= 3 && !/^\d+$/.test(t) && !STOPWORDS.has(t));
  }

  // ---------- "Seen" manifest -> detect newly added files ----------
  async function updateSeenManifest(currentFiles){
    const manifest = (await idbGet(STORE_SEEN, activeFolderId)) || {};
    const now = Date.now();
    const currentPaths = new Set(currentFiles.map(f => f.path));
    let changed = false;
    currentFiles.forEach(f => {
      if (!(f.path in manifest)){ manifest[f.path] = now; changed = true; }
    });
    Object.keys(manifest).forEach(p => {
      if (!currentPaths.has(p)){ delete manifest[p]; changed = true; }
    });
    if (changed) await idbSet(STORE_SEEN, activeFolderId, manifest);
    return manifest;
  }

  // ---------- Interest profile + reading suggestions ----------
  function computeProfile(log){
    const tokenWeights = new Map();
    const categoryWeights = new Map();
    const now = Date.now();
    log.forEach(o => {
      const daysAgo = (now - o.ts) / 86400000;
      const weight = Math.pow(0.5, daysAgo / HALF_LIFE_DAYS);
      categoryWeights.set(o.category, (categoryWeights.get(o.category) || 0) + weight);
      tokenize(o.path).forEach(tok => {
        tokenWeights.set(tok, (tokenWeights.get(tok) || 0) + weight);
      });
    });
    let topCategory = null, topCategoryWeight = 0;
    categoryWeights.forEach((w, c) => { if (w > topCategoryWeight){ topCategoryWeight = w; topCategory = c; } });
    return { tokenWeights, categoryWeights, topCategory };
  }

  function scoreSuggestions(profile, openedPaths){
    const candidates = allFiles.filter(f => !openedPaths.has(f.path));
    const scored = candidates.map(f => {
      const toks = tokenize(f.path);
      let score = 0;
      const matched = [];
      toks.forEach(t => {
        const w = profile.tokenWeights.get(t);
        if (w){ score += w; matched.push([t, w]); }
      });
      if (profile.topCategory && f.category === profile.topCategory) score += 2;
      matched.sort((a, b) => b[1] - a[1]);
      return { file: f, score, why: matched.slice(0, 2).map(m => m[0]) };
    }).filter(s => s.score > 0);
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 5);
  }

  // ---------- Sidebar card collapse state (persisted, independent of renderSidebar's innerHTML churn) ----------
  function loadCollapsedCards(){
    try{
      const raw = localStorage.getItem(COLLAPSE_KEY);
      return new Set(raw ? JSON.parse(raw) : []);
    }catch(e){ return new Set(); }
  }
  function persistCollapsedCards(){
    try{ localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...collapsedCards])); }catch(e){}
  }
  function toggleCard(cardEl){
    const key = cardEl.dataset.card;
    const nowCollapsed = cardEl.classList.toggle("collapsed");
    if (nowCollapsed) collapsedCards.add(key); else collapsedCards.delete(key);
    persistCollapsedCards();
  }

  // ---------- Library summary (counts by type, no extra I/O — derived from allFiles) ----------
  function buildSummaryHtml(){
    const counts = new Map();
    allFiles.forEach(f => {
      const key = (f.ext || "no ext").toUpperCase();
      counts.set(key, (counts.get(key) || 0) + 1);
    });
    const rows = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
    const rowsHtml = rows.map(([ext, count]) =>
      `<div class="summary-row"><span>${escapeHtml(ext)}</span><span>${count}</span></div>`).join("");
    return `<div class="summary-total">${allFiles.length} file(s) total</div><div class="summary-breakdown">${rowsHtml}</div>`;
  }

  // ---------- Orchestrator: run after every scan ----------
  async function refreshInsights(){
    await updateSeenManifest(allFiles);
    await renderSidebar();
  }

  async function renderSidebar(){
    const [log, manifest] = await Promise.all([
      idbGet(STORE_OPENS, activeFolderId),
      idbGet(STORE_SEEN, activeFolderId),
    ]);
    const opens = log || [];
    const seen = manifest || {};

    // -- Recently opened --
    const seenPaths = new Set();
    const recentOpens = [];
    for (let i = opens.length - 1; i >= 0 && recentOpens.length < 10; i--){
      const o = opens[i];
      if (seenPaths.has(o.path)) continue;
      seenPaths.add(o.path);
      recentOpens.push(o);
    }
    const openedHtml = recentOpens.length ? recentOpens.map(o => `
      <button class="side-item" data-openpath="${escapeAttr(o.path)}">
        <span class="si-name">${escapeHtml(o.name)}</span>
        <span class="si-meta">${escapeHtml(o.category)} · ${relativeTime(o.ts)}</span>
      </button>`).join("") : `<p class="side-hint">You haven't opened anything from here yet. Use "View" on a result and it'll show up here.</p>`;

    // -- Recently added --
    const addedEntries = Object.entries(seen).sort((a, b) => b[1] - a[1]).slice(0, 10);
    const byPath = new Map(allFiles.map(f => [f.path, f]));
    const addedHtml = addedEntries.length ? addedEntries.map(([path, ts]) => {
      const f = byPath.get(path);
      if (!f) return "";
      return `<button class="side-item" data-openpath="${escapeAttr(path)}">
        <span class="si-name">${escapeHtml(f.name)}</span>
        <span class="si-meta">${escapeHtml(f.category)} · ${relativeTime(ts)}</span>
      </button>`;
    }).join("") : `<p class="side-hint">Still building the history. Check back after another scan and new files will show up here.</p>`;

    // -- Reading suggestions --
    let suggestHtml;
    if (!opens.length){
      suggestHtml = `<p class="side-hint">Open a few documents first: I need to see what you read before I can suggest related ones.</p>`;
    } else {
      const profile = computeProfile(opens);
      const openedPaths = new Set(opens.map(o => o.path));
      const suggestions = scoreSuggestions(profile, openedPaths);
      suggestHtml = suggestions.length ? suggestions.map(s => `
        <button class="side-item" data-openpath="${escapeAttr(s.file.path)}">
          <span class="si-name">${escapeHtml(s.file.name)}</span>
          <span class="si-meta">${escapeHtml(s.file.category)}</span>
          ${s.why.length ? `<span class="si-why">Based on your interest in: ${s.why.map(escapeHtml).join(", ")}</span>` : ""}
        </button>`).join("")
        : `<p class="side-hint">I couldn't find unread documents matching your topics yet.</p>`;
    }

    // -- Favorites --
    const favEntries = Object.entries(favoritesMap).sort((a, b) => b[1] - a[1]).slice(0, 10);
    const favHtml = favEntries.length ? favEntries.map(([path, ts]) => {
      const f = byPath.get(path);
      if (!f) return "";
      return `<button class="side-item" data-openpath="${escapeAttr(path)}">
        <span class="si-name">★ ${escapeHtml(f.name)}</span>
        <span class="si-meta">${escapeHtml(f.category)} · ${relativeTime(ts)}</span>
      </button>`;
    }).join("") : `<p class="side-hint">No favorites yet. Click the ☆ next to any file to save it here.</p>`;

    // -- Folders --
    const foldersHtml = folders.length ? folders.map(f => `
      <div class="side-item folder-item ${f.id === activeFolderId ? "active" : ""}" data-folderid="${escapeAttr(f.id)}">
        <button class="folder-open" data-folderid="${escapeAttr(f.id)}" title="${f.id === activeFolderId ? "Active folder" : "Switch to this folder"}">
          <span class="si-name">${f.id === activeFolderId ? "📌" : "📁"} ${escapeHtml(f.name)}</span>
          <span class="si-meta">${f.lastScanAt ? "Last scan " + relativeTime(f.lastScanAt) : "Never scanned"}</span>
        </button>
        <button class="folder-del" data-folderid="${escapeAttr(f.id)}" title="Unlink folder">✕</button>
      </div>`).join("") : `<p class="side-hint">No folders linked yet.</p>`;

    // -- Collections --
    const colHtml = collections.length ? collections.map(c => `
      <div class="side-item col-item ${c.id === activeCollectionId ? "active" : ""}" data-colid="${escapeAttr(c.id)}">
        <button class="col-open" data-colid="${escapeAttr(c.id)}">
          <span class="si-name">🗂 ${escapeHtml(c.name)}</span>
          <span class="si-meta">${c.paths.length} file(s)</span>
        </button>
        <button class="col-del" data-colid="${escapeAttr(c.id)}" title="Delete collection">✕</button>
      </div>`).join("") : `<p class="side-hint">No collections yet. Use the ＋ button next to a file to start one.</p>`;

    // -- Possible duplicates --
    const dupHtml = duplicateGroups.length ? duplicateGroups.map((group, gi) => `
      <div class="dup-group">
        <div class="dup-group-title">⚠ ${group.length} files match</div>
        ${group.map((f, fi) => `
          <div class="side-item dup-item">
            <button class="dup-open" data-dupg="${gi}" data-dupf="${fi}">
              <span class="si-name">${escapeHtml(f.name)}</span>
              <span class="si-meta">${escapeHtml(f.folder)}</span>
            </button>
            <button class="dup-copy" data-dupg="${gi}" data-dupf="${fi}" title="Copy path">📋</button>
          </div>`).join("")}
      </div>`).join("")
      : (hashingActive || !hashIndex.size
        ? `<p class="side-hint">Still checking for duplicates…</p>`
        : `<p class="side-hint">No exact duplicates found.</p>`);

    const cardDef = (key, title, bodyHtml) =>
      `<div class="side-card ${collapsedCards.has(key) ? "collapsed" : ""}" data-card="${key}">
        <h3>${title}<span class="chev">▾</span></h3>
        ${bodyHtml}
      </div>`;

    setHTML(els.sidebar,
      cardDef("folders", "📁 Folders", `<div class="side-list">${foldersHtml}</div><div class="cm-new"><button class="backup-btn" id="linkFolderBtn" style="width:100%;">📁 + Link new folder</button></div>`) +
      cardDef("summary", "📊 Library summary", buildSummaryHtml()) +
      cardDef("duplicates", "⚠ Possible duplicates", `<div class="side-list">${dupHtml}</div>`) +
      cardDef("favorites", "⭐ Favorites", `<div class="side-list">${favHtml}</div>`) +
      cardDef("collections", "🗂 Collections", `<div class="side-list">${colHtml}</div><div class="cm-new"><input type="text" placeholder="+ New collection" class="cm-new-input" id="sidebarNewCollection"></div>`) +
      cardDef("opened", "🕒 Recently opened", `<div class="side-list">${openedHtml}</div>`) +
      cardDef("added", "🆕 Recently added", `<div class="side-list">${addedHtml}</div>`) +
      cardDef("suggestions", "📚 Reading suggestions", `<div class="side-list">${suggestHtml}</div>`) +
      cardDef("backup", "💾 Backup & restore", `
        <p class="side-hint">Covers favorites and collections only; everything else rebuilds automatically from a re-scan.</p>
        <div class="backup-actions">
          <button class="backup-btn" id="exportBackupBtn">⬇ Export backup</button>
          <button class="backup-btn" id="importBackupBtn">⬆ Import backup</button>
        </div>`));

    els.sidebar.querySelectorAll(".side-card > h3").forEach(h3 => {
      h3.addEventListener("click", () => toggleCard(h3.closest(".side-card")));
    });
    document.getElementById("exportBackupBtn").addEventListener("click", exportBackup);
    document.getElementById("importBackupBtn").addEventListener("click", () => els.backupFileInput.click());
    els.sidebar.querySelectorAll(".dup-open").forEach(btn => {
      btn.addEventListener("click", () => {
        const f = duplicateGroups[Number(btn.dataset.dupg)]?.[Number(btn.dataset.dupf)];
        if (f) viewFile(f);
      });
    });
    els.sidebar.querySelectorAll(".dup-copy").forEach(btn => {
      btn.addEventListener("click", () => {
        const f = duplicateGroups[Number(btn.dataset.dupg)]?.[Number(btn.dataset.dupf)];
        if (f) copyPath(f);
      });
    });
    els.sidebar.querySelectorAll("button[data-openpath]").forEach(btn => {
      btn.addEventListener("click", () => {
        const f = byPath.get(btn.dataset.openpath);
        if (f) viewFile(f); else toast("That file isn't available anymore (moved or deleted?).");
      });
    });
    els.sidebar.querySelectorAll(".col-open").forEach(btn => {
      btn.addEventListener("click", () => {
        activeCollectionId = activeCollectionId === btn.dataset.colid ? null : btn.dataset.colid;
        activeCategory = ALL_VALUE;
        els.categorySelect.value = ALL_VALUE;
        buildCategoryChips();
        applyFilters();
        renderSidebar();
      });
    });
    els.sidebar.querySelectorAll(".col-del").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const col = collections.find(c => c.id === btn.dataset.colid);
        if (col && confirm(`Delete collection "${col.name}"? This only removes the grouping, not the files.`)){
          await deleteCollection(btn.dataset.colid);
          applyFilters();
        }
      });
    });
    const newColInput = document.getElementById("sidebarNewCollection");
    if (newColInput){
      newColInput.addEventListener("keydown", async (e) => {
        if (e.key === "Enter" && e.target.value.trim()){
          await createCollection(e.target.value);
          await renderSidebar();
        }
      });
    }
    els.sidebar.querySelectorAll(".folder-open").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (btn.dataset.folderid !== activeFolderId) await setActiveFolder(btn.dataset.folderid);
      });
    });
    els.sidebar.querySelectorAll(".folder-del").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const f = folders.find(x => x.id === btn.dataset.folderid);
        if (f && confirm(`Unlink folder "${f.name}"? It disappears from this list, but its favorites, collections, and history stay saved in case you link it again.`)){
          await unlinkFolder(btn.dataset.folderid);
        }
      });
    });
    const linkFolderBtn = document.getElementById("linkFolderBtn");
    if (linkFolderBtn) linkFolderBtn.addEventListener("click", linkFolder);
  }

  // ---------- Startup ----------
  async function init(){
    if (!("showDirectoryPicker" in window)){
      renderUnsupported();
      return;
    }
    await migrateLegacyDataIfNeeded();
    await loadFolders();
    const savedActiveId = await idbGet(STORE_HANDLES, ACTIVE_KEY).catch(() => null);
    const rec = folders.find(f => f.id === savedActiveId) || folders[0];
    if (rec){
      rootHandle = rec.handle;
      activeFolderId = rec.id;
      const perm = await rec.handle.queryPermission({ mode: "read" }).catch(() => "prompt");
      if (perm === "granted") await scan();
      else renderSelectPrompt(true);
    } else {
      renderSelectPrompt(false);
    }
  }

  init();
})();
