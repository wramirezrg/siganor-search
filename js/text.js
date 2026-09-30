// Pure text helpers: HTML escaping, accent/case folding, snippets, tokenizing, relative time.
// Classic script (no modules) so index.html still works when opened from disk; also loadable from Node for tests.
(function (root) {
  "use strict";
  const SNIPPET_RADIUS = 80;
  const STOPWORDS = new Set(["de","la","el","los","las","en","del","para","con","por","un","una","y","the","and","of","for","en-p","en-e","pdf","doc","manual","guide","user","instructions"]);

  // ---------- Accent/case-insensitive matching ----------
  // "ñ" is kept distinct from "n" (año != ano); every other accent is dropped. Length is preserved
  // for normal (precomposed) text, which lets snippets be cut from the original with its accents.
  function fold(s){
    return s.toLowerCase().replace(/\u00f1|n\u0303/g, "\u0001").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  }

  // `hay` is the folded text (see getFolded). Matching runs on it; the fragment shown to the user is cut
  // from the original text when both have the same length (keeps accents), otherwise from `hay`.
  function findSnippet(text, terms, hay){
    if (hay.length !== text.length) text = hay;
    let firstIdx = -1;
    for (const t of terms){
      const i = hay.indexOf(t);
      if (i !== -1 && (firstIdx === -1 || i < firstIdx)) firstIdx = i;
    }
    if (firstIdx === -1) return null;

    const start = Math.max(0, firstIdx - SNIPPET_RADIUS);
    const end = Math.min(text.length, firstIdx + SNIPPET_RADIUS);
    const prefix = start > 0 ? "…" : "";
    const suffix = end < text.length ? "…" : "";
    const slice = text.slice(start, end);
    const lowerSlice = hay.slice(start, end);

    const ranges = [];
    for (const t of terms){
      let idx = 0;
      while (true){
        const found = lowerSlice.indexOf(t, idx);
        if (found === -1) break;
        ranges.push([found, found + t.length]);
        idx = found + t.length;
      }
    }
    ranges.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const r of ranges){
      const last = merged[merged.length - 1];
      if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
      else merged.push(r);
    }

    let out = "";
    let cursor = 0;
    for (const [s, e] of merged){
      out += escapeHtml(slice.slice(cursor, s));
      out += `<mark>${escapeHtml(slice.slice(s, e))}</mark>`;
      cursor = e;
    }
    out += escapeHtml(slice.slice(cursor));
    return `${prefix}${out}${suffix}`.replace(/\s+/g, " ");
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

  const api = { fold, findSnippet, escapeHtml, escapeAttr, relativeTime, tokenize };
  root.DocSearch = root.DocSearch || {};
  root.DocSearch.text = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
