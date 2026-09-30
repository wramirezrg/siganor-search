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

The publicly hosted version uses [Cloudflare Web Analytics](https://www.cloudflare.com/web-analytics/) to count page visits (cookieless, no personal profiles). That measurement only sees that the page was loaded; it never has access to your files or folders. A copy you host yourself doesn't include it unless you add it.

## Requirements

A Chromium based browser  **Microsoft Edge or Google Chrome**. Firefox and Safari don't support the File System Access API yet, and the tool will tell you so if you open it there.

## Using it

1. Open `index.html` (double click it, or visit the hosted URL if you're using the public version).
2. Click **Select folder** and pick any folder on your computer.
3. Search, star favorites, build collections — it's all local to your browser.

Note: because of how the File System Access API works, the browser never exposes your folder's true absolute system path  only its name and the structure inside it. "Copy path" and the exported list reflect that (relative to the folder you picked), not a full OS path.

Each time you reopen the page, your browser will ask you to reconfirm access to the folder (a one click "Reconnect")  that's a browser security limitation, not a bug, and it doesn't affect anything you've saved.

## Running it locally / hosting it yourself

No build step, no dependencies to install. `index.html`, `app.js` (keep them together) plus the `js/`, `img/` and `vendor/` folders are the whole app  copy them anywhere and open `index.html`, or serve them from any static host. See [DEPLOY.md](DEPLOY.md) for step by step instructions to publish your own copy on GitHub Pages.

## Development

There is no build step and no dependencies. The code is split into small classic scripts so the page still works when opened straight from disk: `app.js` holds the state, scanning and rendering, while the pure logic lives in `js/` (`text.js` accent-insensitive matching and snippets, `ranking.js` relevance scoring, `backup.js` backup import validation, `tree.js` the lazy folder tree, `db.js` IndexedDB helpers, `settings.js` user settings). Run all the regression tests with `node tests/run-all.js` (they also check that `index.html` loads every file in `js/` and that the app boots). The `tests/` folder isn't needed to host the site.

## License

MIT  see [LICENSE](LICENSE). Use it, fork it, adapt it.
