# Local Document Search

A zero backend document search tool that runs entirely in your browser, no build step. Point it at any local folder and get instant search, full text PDF search, favorites, collections, duplicate detection, and more with **nothing ever uploaded anywhere**.

Built by [Wilmer Ramirez Gutierrez](mailto:info@siganor.com), creator of [Trace](https://trace.siganor.com)  Signal Analysis & Operational Reliability.

## Why

Most "document search" tools either need a server, an installed app, or send your files to the cloud. This one doesn't. It's a plain HTML + JS page that reads a folder live from disk using the browser's [File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_Access_API) no upload, no server, no account, no internet required after the first load.

## Features

- **Live folder scan**  always reflects what's actually on disk, no index to regenerate.
- **Search by name, folder, or category**, with instant filtering. Results are ranked by relevance (name matches first, then folder, then content), ignore accents and case, and can be sorted by path instead.
- **Full-text search inside PDFs** (and `.txt`/`.htm`)  indexed in the background via [pdf.js](https://mozilla.github.io/pdf.js/), cached so re scans are fast, with a highlighted context snippet under matches.
- **Favorites**  star any file, filter to just your favorites.
- **Collections**  group files across categories, browse or delete them from the sidebar.
- **Duplicate detection**  SHA-256 hashes every file in the background and groups exact duplicates.
- **Reading suggestions**  a local, explainable heuristic (recency weighted token matching, no AI/network call) suggests unread documents related to what you've been opening.
- **Recently opened / recently added** tracking.
- **Keyboard shortcuts**  `/` to search, `Esc` to clear, `↑`/`↓` + `Enter` to browse results.
- **Export** the current filtered results as a Markdown list.
- **Backup & restore** favorites/collections as a `.json` file.
- **Settings** choose how PDFs open: in the browser's built-in viewer (optionally asking for its side panel with the bookmarks), or as a download that your system opens with its default PDF app. A web page can't launch a specific installed app, so the default one is the only app choice. The setting is stored in your browser only.

## Privacy

Everything runs client side. Your files are read directly from disk by your browser and never leave your machine: file contents, file names, and folder names are never uploaded, and there is no server component that receives them. Search history, favorites, and collections are stored in your browser's IndexedDB, scoped to your browser profile only.

**What stays in the browser after you unlink a folder.** Unlinking deletes that folder's text index and duplicate-detection hashes from IndexedDB. Favorites and collections are kept, so you get them back if you link the same folder again. They can include file names and relative paths, so on a shared computer, remove them from the browser profile with the browser's "Clear site data" if that matters to you.

**What goes over the network.** In the flows our automated test covers (linking a folder, indexing, searching PDF/`.txt`/`.html`, opening a file, exporting, importing a backup), only the site's own expected files were requested, and no URL or request body carried a file name, a folder name, or the text of a document.

**Demo vs. installed app.** The public site (a plain browser tab) is a demo over sample files only. The installed app (see below) lets you pick a real folder, and the browser is what controls that access either way.

No analytics or third-party script runs on the publicly hosted version today; the Content Security Policy allows no script or connection beyond the page's own origin. If that changes (for example, turning on [Cloudflare Web Analytics](https://www.cloudflare.com/web-analytics/) to count page visits), it would still only ever see that the page was loaded, never your files or folders, and the CSP would be updated to name exactly what's allowed (see [DEPLOY.md](DEPLOY.md)).

## Requirements

A Chromium based browser  **Microsoft Edge or Google Chrome**. Firefox and Safari don't support the File System Access API yet.

## Demo vs. installed app

[search.siganor.com](https://search.siganor.com) in a normal browser tab is a **demo**: it only ever reads the sample folders bundled with the site (`demo-data/`), never your own files, so you can try the search, the full-text PDF indexing and the duplicate detection without granting access to anything real.

To search your own folders, **install the app**: open the site in Edge or Chrome and use the browser's own "Install app" button (or the Install button on the demo screen). Installed, it runs in its own window, works offline, and the real **Select folder** picker appears in place of the demo. Nothing is downloaded or certified to do this  it's the browser's standard install feature (a PWA), so there's no `.exe` to trust and nothing for Windows to block or warn about.

## Using it

1. Visit the site, or open `index.html` directly (double click it) if you're hosting your own copy.
2. In a plain browser tab you get the demo; install the app (see above) to search real folders.
3. Once installed, click **Select folder** and pick any folder on your computer.
4. Search, star favorites, build collections — it's all local to your browser.

Note: because of how the File System Access API works, the browser never exposes your folder's true absolute system path  only its name and the structure inside it. "Copy path" and the exported list reflect that (relative to the folder you picked), not a full OS path.

Each time you reopen the page, your browser will ask you to reconfirm access to the folder (a one click "Reconnect")  that's a browser security limitation, not a bug, and it doesn't affect anything you've saved.

## Running it locally / hosting it yourself

No build step, no dependencies to install. `index.html`, `app.js` (keep them together) plus the `js/`, `img/` and `vendor/` folders are the whole app  copy them anywhere and open `index.html`, or serve them from any static host. See [DEPLOY.md](DEPLOY.md) for step by step instructions to publish your own copy on GitHub Pages.

## Development

There is no build step and no dependencies. The code is split into small classic scripts so the page still works when opened straight from disk: `app.js` holds the state, scanning and rendering, while the pure logic lives in `js/` (`text.js` accent-insensitive matching and snippets, `ranking.js` relevance scoring, `backup.js` backup import validation, `tree.js` the lazy folder tree, `db.js` IndexedDB helpers, `settings.js` user settings). `manifest.json` and `sw.js` make the page installable (a PWA); `app.js` reads `matchMedia("(display-mode: standalone)")` to tell the installed app from a plain browser tab and switches between the real folder picker and the demo accordingly.

The demo (`demo-data/`, ~10 synthetic sample folders, never real content) is generated by `node tools/build-demo-data.js`; re-run it and commit the output after changing the sample set. Run the tests with `node tests/run-all.js`: unit checks of the escaping, the backup import and the vendored pdf.js files, a run in a real Edge (headless, skipped if Edge is not installed) with a synthetic folder (PDF, TXT, HTML with scripts) that links, indexes, searches, opens, exports and imports a backup while recording every network request, and a second Edge run of the demo screen (plain browser tab, no folder permission) that searches the sample folders and checks duplicate detection. Both fail if any request leaves the page or carries a file name or file content. The `tests/` and `tools/` folders aren't needed to host the site. pdf.js lives in `vendor/pdfjs` (version, source and checksums in `vendor/pdfjs/VERSION`); to update it, download and check the `pdfjs-dist` package from npm and run `node tools/vendor-pdfjs.js <package folder> <npm integrity>`.

## License

MIT  see [LICENSE](LICENSE). Use it, fork it, adapt it.
