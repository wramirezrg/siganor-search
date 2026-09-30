// User settings (how PDFs are opened). Pure: storage is injected, so it can be tested without a browser.
// A web page can't launch a specific installed app; the only choices are the browser's viewer or a download,
// which the operating system then opens with its default PDF app.
(function (root) {
  "use strict";

  const STORAGE_KEY = "docSearchSettings";
  const DEFAULTS = { pdfMode: "browser", pdfSidePanel: false };

  // Accepts anything (corrupt storage included) and returns a valid settings object.
  function normalize(raw){
    const s = { pdfMode: DEFAULTS.pdfMode, pdfSidePanel: DEFAULTS.pdfSidePanel };
    if (raw && typeof raw === "object"){
      if (raw.pdfMode === "download") s.pdfMode = "download";
      if (raw.pdfSidePanel === true) s.pdfSidePanel = true;
    }
    return s;
  }

  function loadSettings(storage){
    try{ return normalize(JSON.parse(storage.getItem(STORAGE_KEY))); }
    catch(e){ return normalize(null); }
  }

  function saveSettings(storage, settings){
    const s = normalize(settings);
    try{ storage.setItem(STORAGE_KEY, JSON.stringify(s)); }catch(e){}
    return s;
  }

  // How to open a file of type `ext`:
  //   { action: "default" }                 non-PDF: keep the app's normal behavior
  //   { action: "open", hash }              PDF in the browser viewer (hash may ask for the side panel)
  //   { action: "download", hash: "" }      PDF saved, so the system opens it with its default PDF app
  function planOpen(ext, settings){
    if (ext !== "pdf") return { action: "default", hash: "" };
    const s = normalize(settings);
    if (s.pdfMode === "download") return { action: "download", hash: "" };
    return { action: "open", hash: s.pdfSidePanel ? "#navpanes=1" : "" };
  }

  const api = { loadSettings, saveSettings, planOpen, normalize, STORAGE_KEY, DEFAULTS };
  root.DocSearch = root.DocSearch || {};
  root.DocSearch.settings = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
