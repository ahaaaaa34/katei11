/* ===================================================
   TRIG MASTER — Service Worker (sw.js)
   Caches core assets for offline use (PWA)
   =================================================== */

const CACHE_NAME = "trig-master-v2";
const PRECACHE = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(PRECACHE))
  );
  self.skipWaiting();
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;

  // Network-first: always try to load the freshest version, so code updates
  // show up without bumping the cache version. The cache is only a fallback
  // for when the device is offline.
  e.respondWith(
    fetch(req)
      .then(resp => {
        // Keep a fresh copy of same-origin files for offline use
        if (resp.ok && new URL(req.url).origin === self.location.origin) {
          const copy = resp.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, copy));
        }
        return resp;
      })
      .catch(() =>
        caches.match(req).then(cached => cached || caches.match("./index.html"))
      )
  );
});
