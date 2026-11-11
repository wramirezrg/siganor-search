"use strict";
// App-shell cache for the installed app: only the static files below, never anything else (no user
// files, no demo-data fetches, no cross-origin request). Bump CACHE when any of these files change.
const CACHE = "docsearch-shell-v1";
const SHELL = [
  "./",
  "index.html",
  "app.js",
  "manifest.json",
  "js/text.js",
  "js/ranking.js",
  "js/backup.js",
  "js/tree.js",
  "js/db.js",
  "js/settings.js",
  "js/collections.js",
  "vendor/pdfjs/pdf.min.mjs",
  "vendor/pdfjs/pdf.worker.min.mjs",
  "vendor/pdfjs/pdf.classic.js",
  "vendor/pdfjs/pdf.worker.classic.js",
  "img/siganor-icon.png",
  "img/icon-192.png",
  "img/icon-512.png",
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req))
  );
});
