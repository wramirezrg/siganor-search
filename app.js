(function(){
  "use strict";

  // Pure logic lives in js/*.js (classic scripts loaded before this file, see index.html).
  // If only part of the site was uploaded, say so instead of failing silently.
  const DS = window.DocSearch || {};
  if (!DS.text || !DS.ranking || !DS.backup || !DS.tree || !DS.db){
    const status = document.getElementById("status");
    if (status){
      status.textContent = "Some app files failed to load (js/*.js). Upload the whole folder and reload the page.";
      status.className = "err";
    }
    return;
  }
  const { fold, findSnippet, escapeHtml, escapeAttr, relativeTime, tokenize } = DS.text;
  const { scoreMatch } = DS.ranking;
  const { remapBackup, BACKUP_MAX_BYTES } = DS.backup;
  const {
    KEY,
    STORE_HANDLES, STORE_FOLDERS, STORE_OPENS, STORE_SEEN, STORE_FAVORITES, STORE_COLLECTIONS, STORE_TEXT_INDEX, STORE_HASH_INDEX,
    idbGet, idbSet, idbGetAll, idbDelete, idbDeleteByPrefix,
  } = DS.db;

  if (window.pdfjsLib){
    pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdfjs/pdf.worker.min.js";
  }

  const ACTIVE_KEY = "activeFolderId";
  const MAX_OPENS = 300;
  const HALF_LIFE_DAYS = 14;
  const ALL_VALUE = "all";
  const TEXT_INDEXABLE = new Set(["pdf","txt","htm","html"]);
  const MAX_PDF_INDEX_SIZE = 40 * 1024 * 1024; // skip huge PDFs (likely image scans, or pathologically slow)

  const PREVIEWABLE = new Set(["pdf","png","jpg","jpeg","gif","webp","txt","htm","html"]);


  let folders = [];            // [{ id, name, handle, addedAt, lastScanAt }] — every linked folder, always in scope
  let folderPermissionState = new Map(); // folderId -> "granted" | "needs-reconnect" | "error"
  let activeFolderFilterId = null; // cosmetic sidebar toggle; null = show results from every linked folder
  let allFiles = [];            // merged across every linked folder; each entry carries folderId/folderName
  let activeCategory = ALL_VALUE;
  let lastScanAt = null;
  let favoritesMap = {};       // { [fileKey]: favoritedAtTs } — merged in memory, persisted per-folder on disk
  let favoritesOnly = false;
  let collections = [];        // [{ id, folderId, name, createdAt, paths: [] }] — merged across folders, each still scoped to one
  let activeCollectionId = null;
  let textIndex = new Map();   // fileKey -> extracted text record (in-memory, loaded from STORE_TEXT_INDEX)
  let indexQueueTotal = 0;
  let indexQueueDone = 0;
  let indexingActive = false;
  let indexQueuePending = false; // a folder was linked/unlinked mid-run; re-run once this pass finishes
  let hashIndex = new Map();   // fileKey -> { path, folderId, hash, size, lastModified, hashedAt }
  let hashQueueTotal = 0;
  let hashQueueDone = 0;
  let hashingActive = false;
  let hashQueuePending = false;
  let duplicateGroups = [];    // [[entry, entry, ...], ...] — groups of 2+ files sharing a hash
  let scanGeneration = 0;      // bumped when the linked-folder set changes; lets stale index/hash loops detect they're obsolete and stop
  let lastResults = [];        // last rendered/filtered results, for keyboard nav + export
  let lastSnippets = null;     // snippets for lastResults, so "Show more" can repaint
  let renderedCount = 0;       // rows actually drawn in the flat list (lastResults may be longer)
  const RENDER_STEP = 300;     // flat result list draws this many rows at a time
  let renderLimit = RENDER_STEP;
  let lastFilterSig = "";
  const SORT_KEY = "docSearchSort";
  let sortMode = loadSortMode(); // "relevance" | "path" — order of search results (browsing tree is unaffected)
  function loadSortMode(){
    try{ return localStorage.getItem(SORT_KEY) === "path" ? "path" : "relevance"; }catch(e){ return "relevance"; }
  }
  let foldedText = new Map();  // fileKey -> accent/case-folded copy of the indexed text (memory only, never persisted)
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
    sortSelect: document.getElementById("sortSelect"),
    refreshBtn: document.getElementById("refreshBtn"),
    exportBtn: document.getElementById("exportBtn"),
    chips: document.getElementById("chips"),
    toast: document.getElementById("toast"),
    indexStatus: document.getElementById("indexStatus"),
    backupFileInput: document.getElementById("backupFileInput"),
    titleText: document.getElementById("titleText"),
  };

  // ---------- Stable header height (avoids layout shift while the UI loads) ----------
  // For a returning user the header grows several times during startup (controls row, then the category chips,
  // which wrap onto more rows as folders are scanned), pushing the whole page down each time. The height from
  // the last finished load is remembered (per window width) and reserved from the first paint.
  const HEADER_H_KEY = "docSearchHeaderH";
  const headerEl = document.querySelector("header");
  function reserveHeaderHeight(){
    try{
      const [h, w] = String(localStorage.getItem(HEADER_H_KEY) || "").split("@").map(Number);
      if (headerEl && h >= 40 && h <= 600 && Math.abs(w - window.innerWidth) < 60) headerEl.style.minHeight = h + "px";
    }catch(e){}
  }
  function rememberHeaderHeight(){
    if (!headerEl || !folders.length) return;
    headerEl.style.minHeight = "";                 // measure the natural height...
    const h = headerEl.offsetHeight;
    headerEl.style.minHeight = h + "px";           // ...then hold it
    try{ localStorage.setItem(HEADER_H_KEY, h + "@" + window.innerWidth); }catch(e){}
  }
  function forgetHeaderHeight(){
    if (headerEl) headerEl.style.minHeight = "";
    try{ localStorage.removeItem(HEADER_H_KEY); }catch(e){}
  }
  reserveHeaderHeight(); // synchronous, before any IndexedDB work
  window.addEventListener("resize", () => { if (headerEl) headerEl.style.minHeight = ""; }); // height depends on width

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

  // Screen-reader announcements (visually hidden live region in index.html).
  function announce(msg){
    const el = document.getElementById("srStatus");
    if (el) el.textContent = msg;
  }

  let toastTimer = null;
  function toast(msg){
    els.toast.textContent = msg;
    els.toast.classList.add("show");
    clearTimeout(toastTimer); // a newer toast must not be hidden by the previous one's timer
    toastTimer = setTimeout(() => els.toast.classList.remove("show"), 1800);
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

  async function checkNestedFolder(handle){
    for (const f of folders){
      try{
        if ((await f.handle.resolve(handle)) !== null){
          return `This folder appears to be inside the already-linked folder "${f.name}". Results may show the same physical file twice. Link anyway?`;
        }
        if ((await handle.resolve(f.handle)) !== null){
          return `The already-linked folder "${f.name}" appears to be inside this folder. Results may show the same physical file twice. Link anyway?`;
        }
      }catch(e){ /* resolve() can throw comparing handles from different pickers — ignore, non-fatal */ }
    }
    return null;
  }

  async function linkFolder(){
    try{
      const handle = await window.showDirectoryPicker();
      for (const f of folders){
        if (await f.handle.isSameEntry(handle)){
          toast("That folder is already linked.");
          activeFolderFilterId = f.id;
          applyFilters();
          await renderSidebar();
          return;
        }
      }
      const nestedWarning = await checkNestedFolder(handle);
      if (nestedWarning && !confirm(nestedWarning)) return;

      const id = crypto.randomUUID();
      await idbSet(STORE_FOLDERS, id, { id, name: handle.name, handle, addedAt: Date.now(), lastScanAt: null });
      await loadFolders();
      const rec = folders.find(f => f.id === id);
      toast("Folder linked: " + rec.name);

      setHTML(els.introView, "");
      els.controlsRow.style.display = "flex";
      els.layout.style.display = "grid";

      const result = await scanFolder(rec);
      if (result.ok){
        allFiles = allFiles.concat(result.files);
        const favSubset = await idbGet(STORE_FAVORITES, id);
        if (favSubset){
          for (const [path, ts] of Object.entries(favSubset)) favoritesMap[id + "::" + path] = ts;
        }
        await loadCollections();
        groupDuplicates();
        updateTitle();
        buildCategoryChips();
        rememberHeaderHeight();
        applyFilters();
        await refreshInsights();
        runIndexQueue();
      } else {
        updateTitle();
        await renderSidebar();
        toast(rec.name + " needs permission. Click Reconnect in the Folders list.");
      }
    }catch(e){
      if (e.name !== "AbortError") setStatus("Couldn't open the folder: " + e.message, true);
    }
  }

  async function reconnectFolder(folderId){
    const rec = folders.find(f => f.id === folderId);
    if (!rec) return;
    try{
      const perm = await rec.handle.requestPermission({ mode: "read" });
      if (perm !== "granted"){ toast("Permission denied for " + rec.name); return; }
      const result = await scanFolder(rec);
      if (result.ok){
        allFiles = allFiles.filter(f => f.folderId !== rec.id).concat(result.files);
        groupDuplicates();
        updateTitle();
        buildCategoryChips();
        rememberHeaderHeight();
        applyFilters();
        await refreshInsights();
        runIndexQueue();
      } else {
        await renderSidebar();
      }
    }catch(e){
      toast("Couldn't reconnect: " + e.message);
    }
  }

  async function unlinkFolder(folderId){
    const rec = folders.find(f => f.id === folderId);
    await idbDelete(STORE_FOLDERS, folderId);
    // Search index and hashes are rebuilt on the next scan, so don't leave them behind on disk.
    await idbDeleteByPrefix(STORE_TEXT_INDEX, folderId + "::").catch(() => {});
    await idbDeleteByPrefix(STORE_HASH_INDEX, folderId + "::").catch(() => {});
    await loadFolders();
    folderPermissionState.delete(folderId);
    allFiles = allFiles.filter(f => f.folderId !== folderId);
    for (const k of [...textIndex.keys()]) if (k.startsWith(folderId + "::")) textIndex.delete(k);
    for (const k of [...foldedText.keys()]) if (k.startsWith(folderId + "::")) foldedText.delete(k);
    for (const k of [...hashIndex.keys()]) if (k.startsWith(folderId + "::")) hashIndex.delete(k);
    for (const k of Object.keys(favoritesMap)) if (k.startsWith(folderId + "::")) delete favoritesMap[k];
    if (activeFolderFilterId === folderId) activeFolderFilterId = null;
    scanGeneration++; // safety net: lets any in-flight index/hash pass touching this folder's handles bail out
    groupDuplicates();
    updateTitle();
    toast("Folder unlinked" + (rec ? ": " + rec.name : "") + ".");

    if (!folders.length){
      indexingActive = false;
      hashingActive = false;
      indexQueuePending = false;
      hashQueuePending = false;
      els.indexStatus.style.display = "none";
      els.controlsRow.style.display = "none";
      setHTML(els.chips, "");
      forgetHeaderHeight();
      renderSelectPrompt();
      return;
    }

    buildCategoryChips();
    rememberHeaderHeight();
    applyFilters();
    await refreshInsights();
    runIndexQueue();
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

  function renderSelectPrompt(){
    els.layout.style.display = "none";
    els.indexStatus.style.display = "none";
    setStatus("");
    renderPrivacyModal(renderFolderPicker);
  }

  function renderPrivacyModal(onAcknowledge){
    setHTML(els.introView, `
      <div class="modal-overlay">
        <div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="privacyTitle">
          <h2 id="privacyTitle">🔒 Before you start</h2>
          <p>This tool runs 100% in your browser. Your files are never uploaded, copied, or sent anywhere. There's no account needed, and no internet connection required after this page loads.</p>
          <p>In a moment your browser will ask you to confirm access to a folder. That's a standard security prompt built into Chrome/Edge, not something this site controls. You can revoke that access anytime from your browser's site settings.</p>
          <button class="primary" id="ackBtn">I understand, continue</button>
        </div>
      </div>`);
    const ackBtn = document.getElementById("ackBtn");
    ackBtn.addEventListener("click", () => onAcknowledge());
    ackBtn.addEventListener("keydown", (e) => { if (e.key === "Tab") e.preventDefault(); }); // only control: keep focus in the dialog
    ackBtn.focus();
  }

  function renderFolderPicker(){
    setHTML(els.introView, `
      <div class="center-panel">
        <h2>Select a folder to search</h2>
        <p>The first time you need to pick a folder manually. It's remembered after that. You can link more folders later from the sidebar, and search covers all of them at once.</p>
        <div class="picker-actions">
          <button class="primary" id="pickBtn">📁 Select folder</button>
          <a class="button-like" id="githubLink" href="https://github.com/wramirezrg/siganor-search" target="_blank" rel="noopener noreferrer">⭐ View on GitHub</a>
        </div>
        <p class="fine-print">🔒 Your files stay on your device. They are never uploaded, and no account is needed.</p>
      </div>`);
    const pickBtn = document.getElementById("pickBtn");
    pickBtn.onclick = linkFolder;
    pickBtn.focus();
  }

  function setStatus(msg, isErr){
    els.status.textContent = msg || "";
    els.status.className = isErr ? "err" : "";
  }

  // ---------- Live recursive scan ----------
  function fileKey(f){ return f.folderId + "::" + f.path; }

  function updateTitle(){
    let label;
    if (!folders.length) label = "Search";
    else if (folders.length === 1) label = "Search · " + folders[0].name;
    else label = "Search · " + folders.length + " folders";
    document.title = label;
    els.titleText.textContent = label;
  }

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

  // Scans one linked folder. Never touches allFiles/UI state — pure per-folder work so
  // callers can merge results incrementally (link/unlink) or in a full pass (scanAllFolders).
  async function scanFolder(rec){
    const perm = await rec.handle.queryPermission({ mode: "read" }).catch(() => "prompt");
    if (perm !== "granted"){
      folderPermissionState.set(rec.id, "needs-reconnect");
      return { ok: false };
    }
    try{
      const files = [];
      await walk(rec.handle, "", files);
      files.forEach(f => {
        const segs = f.path.split("/");
        f.category = segs.length > 1 ? segs[0] : "(root)";
        f.folder = segs.slice(1, -1).join(" / ") || "(category root)";
        const dot = f.name.lastIndexOf(".");
        f.ext = dot > -1 ? f.name.slice(dot + 1).toLowerCase() : "";
        f.folderId = rec.id;
        f.folderName = rec.name;
      });
      rec.lastScanAt = Date.now();
      await idbSet(STORE_FOLDERS, rec.id, rec);
      folderPermissionState.set(rec.id, "granted");
      return { ok: true, files };
    }catch(e){
      folderPermissionState.set(rec.id, "error");
      return { ok: false, message: e.message };
    }
  }

  // Full pass over every linked folder — used at startup and on manual Refresh.
  // Scans sequentially and merges results in as each folder finishes, so results stream in
  // instead of the user waiting for the slowest folder. A folder needing reconnect is flagged
  // (see folderPermissionState) without blocking the others.
  async function scanAllFolders(){
    scanGeneration++;
    const myGeneration = scanGeneration;
    setHTML(els.introView, "");
    setHTML(els.chips, "");
    setHTML(els.rootView, "");
    updateTitle();
    setStatus(`Scanning ${folders.length} folder(s) live…`);
    const t0 = performance.now();
    allFiles = [];
    duplicateGroups = [];
    favoritesMap = await loadFavoritesMap();
    await loadCollections();
    textIndex = await loadTextIndex();
    foldedText = new Map();
    warmFoldedIndex(); // fire-and-forget, in small slices
    hashIndex = await loadHashIndex();
    els.controlsRow.style.display = "flex";
    els.layout.style.display = "grid";
    buildCategoryChips();
    applyFilters();
    await renderSidebar();

    for (const rec of folders){
      const result = await scanFolder(rec);
      if (scanGeneration !== myGeneration) return;
      if (result.ok){
        allFiles = allFiles.concat(result.files);
        buildCategoryChips();
        applyFilters();
        await renderSidebar();
      }
    }
    if (scanGeneration !== myGeneration) return;

    lastScanAt = new Date();
    const ms = Math.round(performance.now() - t0);
    setStatus(`${allFiles.length} files indexed in ${ms} ms.`);
    groupDuplicates();
    updateStatusLine();
    rememberHeaderHeight(); // chips are final now: hold this height for the next load
    await refreshInsights();
    runIndexQueue(); // fire-and-forget: indexes new/changed PDFs in the background
  }

  // ---------- Categories ----------
  function buildCategoryChips(){
    const cats = Array.from(new Set(allFiles.map(f => f.category))).sort();
    setHTML(els.categorySelect, `<option value="${ALL_VALUE}">All categories</option>` +
      cats.map(c => `<option value="${escapeAttr(c)}">${escapeHtml(c)}</option>`).join(""));
    els.categorySelect.value = activeCategory;

    const favCount = Object.keys(favoritesMap).length;
    const favChip = `<button type="button" class="chip fav-chip ${favoritesOnly ? "active" : ""}" id="favChip" aria-pressed="${favoritesOnly}">⭐ Favorites (${favCount})</button>`;

    const catChips = [ALL_VALUE, ...cats].map(c => {
      const label = c === ALL_VALUE ? "All" : c;
      const count = c === ALL_VALUE ? allFiles.length : allFiles.filter(f => f.category === c).length;
      const on = c === activeCategory && !activeCollectionId;
      return `<button type="button" class="chip ${on ? "active" : ""}" data-cat="${escapeAttr(c)}" aria-pressed="${on}">${escapeHtml(label)} (${count})</button>`;
    }).join("");

    setHTML(els.chips, favChip + catChips);

    document.getElementById("favChip").addEventListener("click", () => {
      favoritesOnly = !favoritesOnly;
      applyFilters();
      buildCategoryChips();
      document.getElementById("favChip").focus(); // the chips were rebuilt: keep keyboard focus on the same control
    });
    els.chips.querySelectorAll(".chip[data-cat]").forEach(chip => {
      chip.addEventListener("click", () => {
        activeCategory = chip.dataset.cat;
        activeCollectionId = null;
        els.categorySelect.value = activeCategory;
        syncCategoryChips();
        applyFilters();
        renderSidebar();
      });
    });
  }

  // Mirrors the active category on the chips (visual state + aria-pressed).
  function syncCategoryChips(){
    document.querySelectorAll(".chip[data-cat]").forEach(c => {
      const on = c.dataset.cat === activeCategory;
      c.classList.toggle("active", on);
      c.setAttribute("aria-pressed", String(on));
    });
  }

  // ---------- Filter + render ----------
  let debounceT = null;
  els.search.addEventListener("input", () => {
    clearTimeout(debounceT);
    debounceT = setTimeout(applyFilters, 100);
  });
  els.sortSelect.value = sortMode;
  els.sortSelect.addEventListener("change", () => {
    sortMode = els.sortSelect.value === "path" ? "path" : "relevance";
    try{ localStorage.setItem(SORT_KEY, sortMode); }catch(e){}
    applyFilters();
  });
  els.categorySelect.addEventListener("change", () => {
    activeCategory = els.categorySelect.value;
    activeCollectionId = null;
    syncCategoryChips();
    applyFilters();
    renderSidebar();
  });
  els.refreshBtn.addEventListener("click", scanAllFolders);
  els.exportBtn.addEventListener("click", exportResults);
  els.backupFileInput.addEventListener("change", async () => {
    const file = els.backupFileInput.files[0];
    els.backupFileInput.value = ""; // allow re-selecting the same file next time
    if (file) await importBackup(file);
  });

  // ---------- Keyboard shortcuts ----------
  function updateRowSelection(){
    const rows = els.rootView.querySelectorAll("tbody tr");
    rows.forEach((tr, i) => {
      tr.classList.toggle("row-selected", i === selectedRowIndex);
      if (i === selectedRowIndex) tr.setAttribute("aria-current", "true"); else tr.removeAttribute("aria-current");
    });
    if (selectedRowIndex >= 0 && rows[selectedRowIndex]){
      rows[selectedRowIndex].scrollIntoView({ block: "nearest" });
    }
  }
  document.addEventListener("keydown", (e) => {
    const tag = (e.target.tagName || "").toLowerCase();
    const inInput = tag === "input" || tag === "textarea" || tag === "select";
    const onControl = tag === "button" || tag === "a"; // Enter on a focused button/link must activate THAT control

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
      selectedRowIndex = Math.min(selectedRowIndex + 1, renderedCount - 1);
      updateRowSelection();
    } else if (e.key === "ArrowUp"){
      e.preventDefault();
      selectedRowIndex = Math.max(selectedRowIndex - 1, 0);
      updateRowSelection();
    } else if (e.key === "Enter" && selectedRowIndex >= 0 && !onControl){
      e.preventDefault();
      viewFile(lastResults[selectedRowIndex]);
    }
  });

  function applyFilters(){
    const q = fold(els.search.value.trim());
    // Reset the "Show more" window only when the filter really changes (not on favorite toggles / index refreshes).
    const sig = [q, activeFolderFilterId, activeCollectionId, activeCategory, favoritesOnly, sortMode].join("|");
    if (sig !== lastFilterSig){ lastFilterSig = sig; renderLimit = RENDER_STEP; }
    let results = allFiles;
    if (activeFolderFilterId){
      results = results.filter(f => f.folderId === activeFolderFilterId);
    }
    if (activeCollectionId){
      const col = collections.find(c => c.id === activeCollectionId);
      const paths = new Set(col ? col.paths : []);
      const colFolderId = col ? col.folderId : null;
      results = results.filter(f => f.folderId === colFolderId && paths.has(f.path));
    } else if (activeCategory !== ALL_VALUE){
      results = results.filter(f => f.category === activeCategory);
    }
    if (favoritesOnly) results = results.filter(f => fileKey(f) in favoritesMap);

    // Browsing (no search text) shows the original folder structure as a tree.
    // Typing a query switches to the flat, ranked results list below.
    if (!q){
      renderTree(results);
      return;
    }

    const terms = q.split(/\s+/).filter(Boolean);
    const snippets = new Map();
    const scores = new Map();
    results = results.filter(f => {
      if (f._nf === undefined){ f._nf = fold(f.name); f._pf = fold(f.path); } // cached per file entry
      const key = fileKey(f);
      const rec = textIndex.get(key);
      const hay = rec ? getFolded(key, rec) : "";
      const allMatch = terms.every(t => f._nf.includes(t) || f._pf.includes(t) || hay.includes(t));
      if (!allMatch) return false;
      if (rec){
        const snip = findSnippet(rec.text, terms, hay);
        if (snip) snippets.set(key, snip);
      }
      scores.set(key, scoreMatch(terms, f._nf, f._pf, hay, q));
      return true;
    });
    // Relevance: best score first, ties by path. "Path" keeps the previous plain path order.
    results = results.slice().sort(sortMode === "relevance"
      ? (a, b) => (scores.get(fileKey(b)) - scores.get(fileKey(a))) || a.path.localeCompare(b.path)
      : (a, b) => a.path.localeCompare(b.path));
    render(results, snippets);
  }

  function wireResultActions(container, resultsArray){
    container.querySelectorAll("button[data-act]").forEach(btn => {
      btn.addEventListener("click", () => {
        const entry = resultsArray[Number(btn.dataset.idx)];
        if (btn.dataset.act === "view") viewFile(entry);
        else if (btn.dataset.act === "copy") copyPath(entry);
        else if (btn.dataset.act === "fav") toggleFavorite(entry, btn);
        else if (btn.dataset.act === "col") openCollectionsMenu(entry, btn);
      });
    });
  }

  function render(results, snippets){
    lastResults = results;      // full list: Export list and keyboard nav use it, not just the drawn rows
    lastSnippets = snippets;
    selectedRowIndex = -1;
    if (!results.length){
      renderedCount = 0;
      setHTML(els.rootView, `<div class="empty">No results.</div>`);
      announce("No results");
      return;
    }
    const shown = results.slice(0, renderLimit);
    renderedCount = shown.length;
    announce(`${results.length} result${results.length === 1 ? "" : "s"}`);
    const rows = shown.map((f, i) => {
      const canPreview = PREVIEWABLE.has(f.ext);
      const isFav = fileKey(f) in favoritesMap;
      const snippet = snippets && snippets.get(fileKey(f));
      const folderBadge = folders.length > 1 ? `<span class="folder-badge">📁 ${escapeHtml(f.folderName)}</span>` : "";
      return `<tr>
        <td>
          <div class="name">${escapeHtml(f.name)}</div>
          <div class="path">${folderBadge}${escapeHtml(f.folder)}</div>
          ${snippet ? `<div class="snippet">📄 "${snippet}"</div>` : ""}
        </td>
        <td class="cat">${escapeHtml(f.category)}</td>
        <td><span class="badge ${escapeAttr(f.ext)}">${escapeHtml(f.ext || "—")}</span></td>
        <td class="actions">
          <button data-act="view" data-idx="${i}" aria-label="${canPreview ? "View" : "Open"} ${escapeAttr(f.name)}">${canPreview ? "👁 View" : "⬇ Open"}</button>
          <button data-act="copy" data-idx="${i}" aria-label="Copy path of ${escapeAttr(f.name)}">📋 Copy path</button>
          <button data-act="fav" data-idx="${i}" class="star-btn ${isFav ? "on" : ""}" aria-pressed="${isFav}" aria-label="Favorite: ${escapeAttr(f.name)}" title="${isFav ? "Remove from favorites" : "Add to favorites"}">${isFav ? "★" : "☆"}</button>
          <button data-act="col" data-idx="${i}" aria-haspopup="dialog" aria-label="Add ${escapeAttr(f.name)} to a collection" title="Add to a collection">＋</button>
        </td>
      </tr>`;
    }).join("");

    setHTML(els.rootView, `
      <table>
        <thead><tr><th scope="col">File</th><th scope="col">Category</th><th scope="col">Type</th><th scope="col">Actions</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <footer>
        <span>${shown.length < results.length ? `Showing ${shown.length} of ${results.length} result(s)` : `${results.length} result(s)`} out of ${allFiles.length} total files</span>
        ${shown.length < results.length ? `<button class="backup-btn" id="showMoreBtn" style="flex:none;">Show more</button>` : ""}
        <span>Last scan: ${lastScanAt ? lastScanAt.toLocaleTimeString() : "—"}</span>
      </footer>`);

    wireResultActions(els.rootView, results);
    const showMoreBtn = document.getElementById("showMoreBtn");
    if (showMoreBtn){
      showMoreBtn.addEventListener("click", () => {
        const scrollTop = els.rootView.scrollTop;
        renderLimit += RENDER_STEP;
        render(lastResults, lastSnippets);
        els.rootView.scrollTop = scrollTop; // keep the reading position after appending rows
      });
    }
  }

  // ---------- Browse view: original folder structure, collapsible ----------
  let expandedTreeNodes = new Set(); // tree node keys the user has manually expanded; collapsed by default

  function renderTree(results){
    lastResults = [];
    renderedCount = 0;
    selectedRowIndex = -1;
    if (!results.length){
      setHTML(els.rootView, `<div class="empty">No results.</div>`);
      announce("No results");
      return;
    }

    const { order, html, deferred } = DS.tree.buildTreeHtml(results, {
      expanded: expandedTreeNodes, favorites: favoritesMap, previewable: PREVIEWABLE,
    });
    lastResults = order;
    renderedCount = order.length;
    announce(`${order.length} file${order.length === 1 ? "" : "s"}`);
    setHTML(els.rootView, `
      <div class="tree-view">${html}</div>
      <footer>
        <span>${order.length} file(s)</span>
        <span>Last scan: ${lastScanAt ? lastScanAt.toLocaleTimeString() : "—"}</span>
      </footer>`);

    wireResultActions(els.rootView, order);
    function wireTreeToggles(container){
      container.querySelectorAll(".tree-folder-toggle").forEach(btn => {
        btn.addEventListener("click", () => {
          const key = btn.dataset.treekey;
          const folderEl = btn.closest(".tree-folder");
          if (deferred && deferred.has(key)){
            // First expand of a lazily rendered folder: build its rows now and wire their buttons/sub-folders.
            const body = folderEl.querySelector(":scope > .tree-folder-body");
            setHTML(body, deferred.get(key));
            deferred.delete(key);
            wireResultActions(body, order);
            wireTreeToggles(body);
          }
          if (expandedTreeNodes.has(key)) expandedTreeNodes.delete(key); else expandedTreeNodes.add(key);
          folderEl.classList.toggle("collapsed");
          btn.setAttribute("aria-expanded", String(!folderEl.classList.contains("collapsed")));
        });
      });
    }
    wireTreeToggles(els.rootView);
  }

  async function viewFile(entry){
    try{
      const file = await entry.handle.getFile();
      // HTML from the user's folder is shown as source text, never interpreted as a page of this origin.
      const isHtml = entry.ext === "htm" || entry.ext === "html";
      const url = URL.createObjectURL(isHtml ? new Blob([file], { type: "text/plain;charset=utf-8" }) : file);
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
    const log = (await idbGet(STORE_OPENS, entry.folderId)) || [];
    log.push({ path: entry.path, name: entry.name, category: entry.category, ts: Date.now() });
    const trimmed = log.slice(-MAX_OPENS);
    await idbSet(STORE_OPENS, entry.folderId, trimmed);
    await renderSidebar();
  }

  function copyPath(entry){
    // Note: the File System Access API never exposes the real absolute system path —
    // this is relative to the folder you linked, prefixed with that folder's own name.
    const full = entry.folderName + "\\" + entry.path.replace(/\//g, "\\");
    navigator.clipboard.writeText(full).then(
      () => toast("Path copied: " + full),
      () => toast("Couldn't copy to clipboard")
    );
  }

  // ---------- Export current results ----------
  function exportResults(){
    if (!lastResults.length){ toast("Nothing to export. No results shown."); return; }
    const folderCount = new Set(lastResults.map(f => f.folderId)).size;
    const title = folderCount > 1 ? `${folderCount} folders` : lastResults[0].folderName;
    const lines = [`# ${title} · ${lastResults.length} file(s)`, `Exported ${new Date().toLocaleString()}`];
    let lastCat = null;
    lastResults.forEach(f => {
      if (f.category !== lastCat){
        lines.push(`\n## ${f.category}`);
        lastCat = f.category;
      }
      const folderTag = folderCount > 1 ? ` · [${f.folderName}]` : "";
      lines.push(`- **${f.name}**${folderTag} · ${f.folder} (${f.ext || "—"})`);
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
    const linkedIds = new Set(folders.map(f => f.id));
    const folderNames = {};
    folders.forEach(f => { folderNames[f.id] = f.name; });
    const payload = {
      version: 2,
      exportedAt: new Date().toISOString(),
      folders: folderNames, // lets another browser match by name, since folder ids are local
      favorites: favoritesMap,
      collections: collections.filter(c => linkedIds.has(c.folderId)),
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
    if (file.size > BACKUP_MAX_BYTES){
      toast("That backup file is too large to import.");
      return;
    }
    let data;
    try{
      data = JSON.parse(await file.text());
    }catch(e){
      toast("Backup file isn't valid JSON.");
      return;
    }
    // Collections outside the folders this backup covers stay untouched, so their ids can't be reused.
    const preview = remapBackup(data, folders, new Set(), () => "");
    if (!preview.ok){ toast(preview.error); return; }
    if (!preview.targets.size){
      toast(preview.skippedFolders.length
        ? `Nothing to restore: link these folders first (${preview.skippedFolders.join(", ")}).`
        : "That backup has nothing to restore.");
      return;
    }
    const keptIds = new Set(collections.filter(c => !preview.targets.has(c.folderId)).map(c => c.id));
    const result = remapBackup(data, folders, keptIds, () => crypto.randomUUID());

    const targetNames = folders.filter(f => result.targets.has(f.id)).map(f => f.name).join(", ");
    const skippedNote = result.skipped || result.skippedFolders.length
      ? `\n\n${result.skipped} item(s) will be skipped` + (result.skippedFolders.length ? ` (folder not linked here: ${result.skippedFolders.join(", ")})` : "") + "."
      : "";
    if (!confirm(`Replace favorites and collections of ${targetNames} with this backup (${result.favCount} favorite(s), ${result.collections.length} collection(s))? Other folders are not touched. This can't be undone.${skippedNote}`)){
      return;
    }

    for (const col of collections){
      if (result.targets.has(col.folderId)) await idbDelete(STORE_COLLECTIONS, col.id);
    }
    for (const col of result.collections){
      await idbSet(STORE_COLLECTIONS, col.id, col);
    }
    for (const key of Object.keys(favoritesMap)){
      const sep = key.indexOf("::");
      if (sep > 0 && result.targets.has(key.slice(0, sep))) delete favoritesMap[key];
    }
    Object.assign(favoritesMap, result.favorites);
    for (const folderId of result.targets) await persistFavorites(folderId);

    await loadCollections();
    buildCategoryChips();
    applyFilters();
    await renderSidebar();
    toast(`Backup restored: ${result.favCount} favorite(s), ${result.collections.length} collection(s)` + (result.skipped ? `, ${result.skipped} skipped.` : "."));
  }

  // ---------- Favorites ----------
  // In memory, favoritesMap is merged across every linked folder (key = fileKey = folderId::path)
  // to make cross-folder search/filter simple. On disk it stays exactly as before: one record
  // per folder, keyed by bare path — these helpers translate between the two shapes.
  async function loadFavoritesMap(){
    const merged = {};
    for (const rec of folders){
      const m = await idbGet(STORE_FAVORITES, rec.id);
      if (m) for (const [path, ts] of Object.entries(m)) merged[rec.id + "::" + path] = ts;
    }
    return merged;
  }

  async function persistFavorites(folderId){
    const prefix = folderId + "::";
    const subset = {};
    for (const [key, ts] of Object.entries(favoritesMap)){
      if (key.startsWith(prefix)) subset[key.slice(prefix.length)] = ts;
    }
    await idbSet(STORE_FAVORITES, folderId, subset);
  }

  async function persistAllFavorites(){
    for (const rec of folders) await persistFavorites(rec.id);
  }

  async function toggleFavorite(entry, btn){
    const key = fileKey(entry);
    const isFav = key in favoritesMap;
    if (isFav) delete favoritesMap[key];
    else favoritesMap[key] = Date.now();
    await persistFavorites(entry.folderId);
    if (btn){
      const nowFav = key in favoritesMap;
      btn.classList.toggle("on", nowFav);
      btn.setAttribute("aria-pressed", String(nowFav));
      btn.textContent = nowFav ? "★" : "☆";
      btn.title = nowFav ? "Remove from favorites" : "Add to favorites";
    }
    if (favoritesOnly) applyFilters();
    buildCategoryChips();
    await renderSidebar();
  }

  // ---------- Collections ----------
  // Each collection stays scoped to a single folder (its own folderId field, no schema change),
  // but the in-memory list is merged across every linked folder for sidebar display + filtering.
  async function loadCollections(){
    collections = await idbGetAll(STORE_COLLECTIONS);
    collections.sort((a, b) => a.name.localeCompare(b.name));
  }

  async function createCollection(name, folderId){
    name = (name || "").trim();
    if (!name) return null;
    const fid = folderId || activeFolderFilterId || (folders[0] && folders[0].id);
    if (!fid) return null;
    const col = { id: crypto.randomUUID(), folderId: fid, name, createdAt: Date.now(), paths: [] };
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

  let menuCleanup = null; // removes the open menu's outside-click listener
  function closeCollectionsMenu(){
    if (menuCleanup){ menuCleanup(); menuCleanup = null; }
    const existing = document.querySelector(".collections-menu");
    if (existing) existing.remove();
  }

  function openCollectionsMenu(entry, btn){
    closeCollectionsMenu();
    const menu = document.createElement("div");
    menu.className = "collections-menu";
    menu.setAttribute("role", "dialog");
    menu.setAttribute("aria-label", "Add to collection");
    const renderMenuBody = () => {
      const folderCollections = collections.filter(c => c.folderId === entry.folderId);
      return `
      ${folderCollections.length ? folderCollections.map(c => `
        <label class="cm-item">
          <input type="checkbox" data-colid="${escapeAttr(c.id)}" ${c.paths.includes(entry.path) ? "checked" : ""}>
          ${escapeHtml(c.name)}
        </label>`).join("") : `<p class="side-hint">No collections yet.</p>`}
      <div class="cm-new">
        <input type="text" placeholder="+ New collection" aria-label="New collection name" class="cm-new-input">
      </div>`;
    };
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
          const col = await createCollection(e.target.value, entry.folderId);
          if (col) await toggleFileInCollection(col.id, entry.path);
          await loadCollections();
          await renderSidebar();
          setHTML(menu, renderMenuBody());
          wireMenuInputs();
          menu.querySelector(".cm-new-input").focus(); // the body was rebuilt: keep keyboard focus in the menu
        }
      });
    }
    wireMenuInputs();

    // Esc closes and returns focus to the "＋" button; Tab stays inside the menu.
    menu.addEventListener("keydown", (e) => {
      if (e.key === "Escape"){
        e.preventDefault();
        closeCollectionsMenu();
        btn.focus();
      } else if (e.key === "Tab"){
        const items = Array.from(menu.querySelectorAll("input"));
        if (!items.length) return;
        const first = items[0], last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first){ e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last){ e.preventDefault(); first.focus(); }
      }
    });
    (menu.querySelector("input[type=checkbox]") || menu.querySelector(".cm-new-input")).focus();

    // Outside click closes it. The listener is registered on the next tick (so the click that opened the
    // menu doesn't close it) and removed whenever the menu closes, so an old menu can't close a newer one.
    const onDocClick = (e) => {
      if (!menu.contains(e.target) && e.target !== btn) closeCollectionsMenu();
    };
    const cleanup = () => document.removeEventListener("click", onDocClick);
    menuCleanup = cleanup;
    setTimeout(() => { if (menuCleanup === cleanup) document.addEventListener("click", onDocClick); }, 0);
  }

  // ---------- Full-text index (pdf.js for PDFs, plain read for txt/htm) ----------
  async function loadTextIndex(){
    const records = await idbGetAll(STORE_TEXT_INDEX);
    return new Map(records.map(r => [r.folderId + "::" + r.path, r]));
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
    if (indexingActive){ indexQueuePending = true; return; } // a folder was linked/unlinked mid-run — rerun once this pass finishes
    const myGeneration = scanGeneration;
    const candidates = allFiles.filter(f => TEXT_INDEXABLE.has(f.ext));
    if (candidates.length){
      indexingActive = true;
      indexQueueTotal = candidates.length;
      indexQueueDone = 0;
      let indexedCount = 0;
      updateStatusLine();

      for (const entry of candidates){
        if (scanGeneration !== myGeneration){ indexingActive = false; return; } // folder set changed mid-run — stop, don't touch stale state

        try{
          const file = await entry.handle.getFile();
          const key = fileKey(entry);
          const cached = textIndex.get(key);
          if (!cached || cached.size !== file.size || cached.lastModified !== file.lastModified){
            const text = await extractText(entry, file);
            if (text != null){
              const record = { path: entry.path, folderId: entry.folderId, text, size: file.size, lastModified: file.lastModified, indexedAt: Date.now() };
              await idbSet(STORE_TEXT_INDEX, key, record);
              textIndex.set(key, record);
              foldedText.delete(key); // re-folded lazily on next search
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
    if (indexQueuePending){ indexQueuePending = false; return runIndexQueue(); }
    runHashQueue(); // chained, not parallel — avoids competing for I/O with the text-index pass above
  }

  // ---------- Duplicate detection (SHA-256, all file types) ----------
  async function loadHashIndex(){
    const records = await idbGetAll(STORE_HASH_INDEX);
    return new Map(records.map(r => [r.folderId + "::" + r.path, r]));
  }

  function groupDuplicates(){
    const byKey = new Map(allFiles.map(f => [fileKey(f), f]));
    const byHash = new Map();
    hashIndex.forEach((rec, key) => {
      const f = byKey.get(key);
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
    if (hashingActive){ hashQueuePending = true; return; }
    const myGeneration = scanGeneration;
    const candidates = allFiles;
    if (!candidates.length) return;

    hashingActive = true;
    hashQueueTotal = candidates.length;
    hashQueueDone = 0;
    updateStatusLine();

    // Pass 1 (metadata only): identical files always have the same size, so a file whose size is
    // unique can't be a duplicate and never needs to be read in full.
    const bySize = new Map(); // size -> [{ entry, lastModified }]
    for (const entry of candidates){
      if (scanGeneration !== myGeneration){ hashingActive = false; return; } // folder set changed mid-run
      try{
        const file = await entry.handle.getFile();
        if (!bySize.has(file.size)) bySize.set(file.size, []);
        bySize.get(file.size).push({ entry, size: file.size, lastModified: file.lastModified });
      }catch(e){
        // unreadable file — skip, not fatal to the rest of the queue
      }
      hashQueueDone++;
      updateStatusLine();
      await new Promise(r => setTimeout(r, 0));
    }

    const toHash = [];
    for (const group of bySize.values()){
      if (group.length > 1){ toHash.push(...group); continue; }
      // Unique size: drop any stale hash record (changed file) so groupDuplicates can't build a false group from it.
      const { entry, size, lastModified } = group[0];
      const key = fileKey(entry);
      const cached = hashIndex.get(key);
      if (cached && (cached.size !== size || cached.lastModified !== lastModified)){
        hashIndex.delete(key);
        try{ await idbDelete(STORE_HASH_INDEX, key); }catch(e){ /* stale record stays on disk, ignored in memory */ }
      }
    }

    // Pass 2: hash only the files that share a size with another file (reusing still-valid cached hashes).
    hashQueueTotal = candidates.length + toHash.length;
    for (const item of toHash){
      if (scanGeneration !== myGeneration){ hashingActive = false; return; }
      const { entry } = item;
      try{
        const key = fileKey(entry);
        const cached = hashIndex.get(key);
        if (!cached || cached.size !== item.size || cached.lastModified !== item.lastModified){
          const file = await entry.handle.getFile();
          const hash = await hashFile(file);
          const record = { path: entry.path, folderId: entry.folderId, hash, size: file.size, lastModified: file.lastModified, hashedAt: Date.now() };
          await idbSet(STORE_HASH_INDEX, key, record);
          hashIndex.set(key, record);
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
    if (hashQueuePending){ hashQueuePending = false; runHashQueue(); }
  }

  function getFolded(key, rec){
    let f = foldedText.get(key);
    if (f === undefined){ f = fold(rec.text); foldedText.set(key, f); }
    return f;
  }

  // Pre-folds the loaded index in small time slices so the first search doesn't have to do it all at once.
  async function warmFoldedIndex(){
    const myGeneration = scanGeneration;
    let deadline = performance.now() + 8;
    for (const [key, rec] of textIndex){
      if (scanGeneration !== myGeneration) return;
      getFolded(key, rec);
      if (performance.now() > deadline){
        await new Promise(r => setTimeout(r, 0));
        deadline = performance.now() + 8;
      }
    }
  }

  // ---------- "Seen" manifest -> detect newly added files ----------
  // Stays a per-folder record on disk (as before); groups the merged file list by folder
  // so each folder's manifest only ever reflects that folder's own current files.
  async function updateSeenManifest(currentFiles){
    const byFolder = new Map();
    currentFiles.forEach(f => {
      if (!byFolder.has(f.folderId)) byFolder.set(f.folderId, []);
      byFolder.get(f.folderId).push(f);
    });
    for (const [folderId, folderFiles] of byFolder){
      const manifest = (await idbGet(STORE_SEEN, folderId)) || {};
      const now = Date.now();
      const currentPaths = new Set(folderFiles.map(f => f.path));
      let changed = false;
      folderFiles.forEach(f => {
        if (!(f.path in manifest)){ manifest[f.path] = now; changed = true; }
      });
      Object.keys(manifest).forEach(p => {
        if (!currentPaths.has(p)){ delete manifest[p]; changed = true; }
      });
      if (changed) await idbSet(STORE_SEEN, folderId, manifest);
    }
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

  function scoreSuggestions(profile, openedKeys){
    const candidates = allFiles.filter(f => !openedKeys.has(fileKey(f)));
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
    const toggle = cardEl.querySelector(".card-toggle");
    if (toggle) toggle.setAttribute("aria-expanded", String(!nowCollapsed));
    if (nowCollapsed) collapsedCards.add(key); else collapsedCards.delete(key);
    persistCollapsedCards();
  }

  // Selector for the sidebar control that currently has focus (id, or class + data-* attributes), or "".
  function sidebarFocusSelector(){
    const a = document.activeElement;
    if (!a || !els.sidebar.contains(a) || a === els.sidebar) return "";
    if (a.id) return "#" + CSS.escape(a.id);
    let sel = a.classList.length ? "." + CSS.escape(a.classList[0]) : a.tagName.toLowerCase();
    for (const attr of a.attributes){
      if (attr.name.startsWith("data-")) sel += `[${attr.name}="${CSS.escape(attr.value)}"]`;
    }
    return sel;
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
    // Opens/seen stay per-folder records on disk; merge them here, tagging each entry with
    // its own folderId so recency/favorites lists can span every linked folder without collisions.
    let opens = [];
    let seen = {}; // composite-keyed: fileKey -> firstSeenTs
    for (const rec of folders){
      const log = await idbGet(STORE_OPENS, rec.id);
      if (log) opens = opens.concat(log.map(o => ({ ...o, folderId: rec.id })));
      const manifest = await idbGet(STORE_SEEN, rec.id);
      if (manifest){
        for (const [path, ts] of Object.entries(manifest)) seen[rec.id + "::" + path] = ts;
      }
    }
    opens.sort((a, b) => a.ts - b.ts);
    const byKey = new Map(allFiles.map(f => [fileKey(f), f]));

    // -- Recently opened --
    const seenKeys = new Set();
    const recentOpens = [];
    for (let i = opens.length - 1; i >= 0 && recentOpens.length < 10; i--){
      const o = opens[i];
      const k = o.folderId + "::" + o.path;
      if (seenKeys.has(k)) continue;
      seenKeys.add(k);
      recentOpens.push({ ...o, key: k });
    }
    const openedHtml = recentOpens.length ? recentOpens.map(o => `
      <button class="side-item" data-filekey="${escapeAttr(o.key)}">
        <span class="si-name">${escapeHtml(o.name)}</span>
        <span class="si-meta">${escapeHtml(o.category)} · ${relativeTime(o.ts)}</span>
      </button>`).join("") : `<p class="side-hint">You haven't opened anything from here yet. Use "View" on a result and it'll show up here.</p>`;

    // -- Recently added --
    const addedEntries = Object.entries(seen).sort((a, b) => b[1] - a[1]).slice(0, 10);
    const addedHtml = addedEntries.length ? addedEntries.map(([key, ts]) => {
      const f = byKey.get(key);
      if (!f) return "";
      return `<button class="side-item" data-filekey="${escapeAttr(key)}">
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
      const openedKeys = new Set(opens.map(o => o.folderId + "::" + o.path));
      const suggestions = scoreSuggestions(profile, openedKeys);
      suggestHtml = suggestions.length ? suggestions.map(s => `
        <button class="side-item" data-filekey="${escapeAttr(fileKey(s.file))}">
          <span class="si-name">${escapeHtml(s.file.name)}</span>
          <span class="si-meta">${escapeHtml(s.file.category)}</span>
          ${s.why.length ? `<span class="si-why">Based on your interest in: ${s.why.map(escapeHtml).join(", ")}</span>` : ""}
        </button>`).join("")
        : `<p class="side-hint">I couldn't find unread documents matching your topics yet.</p>`;
    }

    // -- Favorites --
    const favEntries = Object.entries(favoritesMap).sort((a, b) => b[1] - a[1]).slice(0, 10);
    const favHtml = favEntries.length ? favEntries.map(([key, ts]) => {
      const f = byKey.get(key);
      if (!f) return "";
      return `<button class="side-item" data-filekey="${escapeAttr(key)}">
        <span class="si-name">★ ${escapeHtml(f.name)}</span>
        <span class="si-meta">${escapeHtml(f.category)} · ${relativeTime(ts)}</span>
      </button>`;
    }).join("") : `<p class="side-hint">No favorites yet. Click the ☆ next to any file to save it here.</p>`;

    // -- Folders --
    const foldersHtml = folders.length ? folders.map(f => {
      const permState = folderPermissionState.get(f.id);
      const needsReconnect = permState === "needs-reconnect" || permState === "error";
      const isFiltered = f.id === activeFolderFilterId;
      return `
      <div class="side-item folder-item ${isFiltered ? "active" : ""}" data-folderid="${escapeAttr(f.id)}">
        <button class="folder-open" data-folderid="${escapeAttr(f.id)}" aria-pressed="${isFiltered}" title="${isFiltered ? "Showing only this folder. Click to show all" : "Filter results to this folder"}">
          <span class="si-name">${isFiltered ? "📌" : "📁"} ${escapeHtml(f.name)}${needsReconnect ? ` <span class="folder-reconnect-badge">Needs reconnect</span>` : ""}</span>
          <span class="si-meta">${f.lastScanAt ? "Last scan " + relativeTime(f.lastScanAt) : "Never scanned"}</span>
        </button>
        ${needsReconnect ? `<button class="folder-reconnect" data-folderid="${escapeAttr(f.id)}" aria-label="Reconnect folder ${escapeAttr(f.name)}" title="Reconnect this folder">🔄</button>` : ""}
        <button class="folder-del" data-folderid="${escapeAttr(f.id)}" aria-label="Unlink folder ${escapeAttr(f.name)}" title="Unlink folder">✕</button>
      </div>`;
    }).join("") : `<p class="side-hint">No folders linked yet.</p>`;

    // -- Collections --
    const colHtml = collections.length ? collections.map(c => {
      const folderRec = folders.find(f => f.id === c.folderId);
      const folderTag = folders.length > 1 && folderRec ? ` <span class="col-folder-tag">(${escapeHtml(folderRec.name)})</span>` : "";
      return `
      <div class="side-item col-item ${c.id === activeCollectionId ? "active" : ""}" data-colid="${escapeAttr(c.id)}">
        <button class="col-open" data-colid="${escapeAttr(c.id)}" aria-pressed="${c.id === activeCollectionId}">
          <span class="si-name">🗂 ${escapeHtml(c.name)}${folderTag}</span>
          <span class="si-meta">${c.paths.length} file(s)</span>
        </button>
        <button class="col-del" data-colid="${escapeAttr(c.id)}" aria-label="Delete collection ${escapeAttr(c.name)}" title="Delete collection">✕</button>
      </div>`;
    }).join("") : `<p class="side-hint">No collections yet. Use the ＋ button next to a file to start one.</p>`;

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
            <button class="dup-copy" data-dupg="${gi}" data-dupf="${fi}" aria-label="Copy path of ${escapeAttr(f.name)}" title="Copy path">📋</button>
          </div>`).join("")}
      </div>`).join("")
      : (hashingActive || !hashIndex.size
        ? `<p class="side-hint">Still checking for duplicates…</p>`
        : `<p class="side-hint">No exact duplicates found.</p>`);

    const cardDef = (key, title, bodyHtml) =>
      `<div class="side-card ${collapsedCards.has(key) ? "collapsed" : ""}" data-card="${key}">
        <h2><button type="button" class="card-toggle" aria-expanded="${!collapsedCards.has(key)}">${title}<span class="chev" aria-hidden="true">▾</span></button></h2>
        ${bodyHtml}
      </div>`;

    // The sidebar is rebuilt on most actions; remember which control had keyboard focus so it isn't lost.
    const focusSel = sidebarFocusSelector();
    setHTML(els.sidebar,
      cardDef("folders", "📁 Folders", `<div class="side-list">${foldersHtml}</div><div class="cm-new"><button class="backup-btn" id="linkFolderBtn" style="width:100%;">📁 + Link new folder</button></div>`) +
      cardDef("summary", "📊 Library summary", buildSummaryHtml()) +
      cardDef("duplicates", "⚠ Possible duplicates", `<div class="side-list">${dupHtml}</div>`) +
      cardDef("favorites", "⭐ Favorites", `<div class="side-list">${favHtml}</div>`) +
      cardDef("collections", "🗂 Collections", `<div class="side-list">${colHtml}</div><div class="cm-new"><input type="text" placeholder="+ New collection" aria-label="New collection name" class="cm-new-input" id="sidebarNewCollection"></div>`) +
      cardDef("opened", "🕒 Recently opened", `<div class="side-list">${openedHtml}</div>`) +
      cardDef("added", "🆕 Recently added", `<div class="side-list">${addedHtml}</div>`) +
      cardDef("suggestions", "📚 Reading suggestions", `<div class="side-list">${suggestHtml}</div>`) +
      cardDef("backup", "💾 Backup & restore", `
        <p class="side-hint">Covers favorites and collections only; everything else rebuilds automatically from a re-scan.</p>
        <div class="backup-actions">
          <button class="backup-btn" id="exportBackupBtn">⬇ Export backup</button>
          <button class="backup-btn" id="importBackupBtn">⬆ Import backup</button>
        </div>`));

    els.sidebar.querySelectorAll(".card-toggle").forEach(btn => {
      btn.addEventListener("click", () => toggleCard(btn.closest(".side-card")));
    });
    if (focusSel){
      const again = els.sidebar.querySelector(focusSel);
      if (again) again.focus({ preventScroll: true });
    }
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
    els.sidebar.querySelectorAll("button[data-filekey]").forEach(btn => {
      btn.addEventListener("click", () => {
        const f = byKey.get(btn.dataset.filekey);
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
      btn.addEventListener("click", () => {
        activeFolderFilterId = activeFolderFilterId === btn.dataset.folderid ? null : btn.dataset.folderid;
        applyFilters();
        renderSidebar();
      });
    });
    els.sidebar.querySelectorAll(".folder-reconnect").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await reconnectFolder(btn.dataset.folderid);
      });
    });
    els.sidebar.querySelectorAll(".folder-del").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const f = folders.find(x => x.id === btn.dataset.folderid);
        if (f && confirm(`Unlink folder "${f.name}"? It disappears from this list and its search index is cleared. Favorites and collections are tied to this link, so linking the same folder again starts them fresh. Your files are not touched.`)){
          await unlinkFolder(btn.dataset.folderid);
        }
      });
    });
    const linkFolderBtn = document.getElementById("linkFolderBtn");
    if (linkFolderBtn) linkFolderBtn.addEventListener("click", linkFolder);
  }

  // ---------- Banner auto-hide (desktop: panels scroll, not the page) ----------
  // Collapses the promo banner once a panel is scrolled, and restores it when both are back at the top.
  // The overflow check keeps a nearly-fitting panel from flapping: hiding the banner grows the panel,
  // which would clamp scrollTop to 0 and re-show it.
  function initBannerAutoHide(){
    const banner = document.querySelector(".promo-banner");
    const panes = [els.sidebar, els.rootView];
    const ANIM_MS = 650; // a bit above the CSS height transition (.6s)
    let queued = false;
    let hidden = false;
    let settleTimer = null;
    // Animates an explicit pixel height: 'height:auto' can't be transitioned, so start from the
    // current measured height (works even if a previous animation was interrupted midway).
    function setBannerHidden(next){
      if (next === hidden) return;
      hidden = next;
      clearTimeout(settleTimer);
      banner.style.height = banner.getBoundingClientRect().height + "px";
      void banner.offsetHeight; // commit the starting height before changing it
      document.body.classList.toggle("banner-hidden", hidden);
      if (hidden){
        banner.style.height = "0px";
      } else {
        banner.style.height = banner.scrollHeight + "px"; // natural content height
        settleTimer = setTimeout(() => { banner.style.height = ""; }, ANIM_MS); // back to auto so it follows window width
      }
    }
    function update(){
      queued = false;
      const bannerH = banner.scrollHeight; // natural height; unlike offsetHeight it doesn't change while collapsing
      const scrolled = panes.some(p => p.scrollTop > 20 && p.scrollHeight - p.clientHeight > bannerH + 50);
      const atTop = panes.every(p => p.scrollTop === 0);
      if (scrolled) setBannerHidden(true);
      else if (atTop) setBannerHidden(false);
    }
    panes.forEach(p => p.addEventListener("scroll", () => {
      if (!queued){ queued = true; requestAnimationFrame(update); }
    }, { passive: true }));
  }
  initBannerAutoHide();

  // ---------- Startup ----------
  async function init(){
    if (!("showDirectoryPicker" in window)){
      renderUnsupported();
      return;
    }
    await migrateLegacyDataIfNeeded();
    await loadFolders();
    if (!folders.length){
      renderSelectPrompt();
      return;
    }
    // Each folder's permission is checked individually inside scanAllFolders → scanFolder;
    // folders that still have access show results immediately, others get a "Needs reconnect"
    // badge in the sidebar without blocking the rest.
    await scanAllFolders();
  }

  init();
})();
