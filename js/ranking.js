// Relevance scoring for search results (pure; all inputs are already folded with DocSearch.text.fold).
(function (root) {
  "use strict";
  // Relevance score for a file that already matched every term (see applyFilters). Simple and explainable:
  //   name hit +50 (+20 if it starts the name or a word), folder/path hit +20,
  //   +2 per occurrence in the content (max 10 counted, keeps it cheap), +40 if the name IS the query.
  // All inputs are folded (fold()); `hay` is the folded indexed text or "".
  const SCORE_WORD_BREAK = /[\s._\-\/()\[\]]/;
  function scoreMatch(terms, nameF, pathF, hay, queryF){
    let score = 0;
    for (const t of terms){
      const ni = nameF.indexOf(t);
      if (ni !== -1){
        score += 50;
        if (ni === 0 || SCORE_WORD_BREAK.test(nameF[ni - 1])) score += 20;
      }
      if (pathF.indexOf(t) !== -1) score += 20;
      if (hay){
        let count = 0, i = 0;
        while (count < 10 && (i = hay.indexOf(t, i)) !== -1){ count++; i += t.length; }
        score += count * 2;
      }
    }
    const dot = nameF.lastIndexOf(".");
    if (nameF === queryF || (dot > 0 && nameF.slice(0, dot) === queryF)) score += 40;
    return score;
  }

  const api = { scoreMatch };
  root.DocSearch = root.DocSearch || {};
  root.DocSearch.ranking = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
