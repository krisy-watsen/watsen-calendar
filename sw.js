
const CACHE_NAME = "krisy-app-v100";
const APP_SHELL = [
  "./",
  "./index.html",
  "./invoice.html",
  "./invoiceRecord.html",
  "./style.css",
  "./app.js",
  "./driveShared.js",
  "./manifest.webmanifest",
  "./icons/krisy-icon-180.png",
  "./icons/krisy-icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.map(k => (k !== CACHE_NAME ? caches.delete(k) : null)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;

  // 只处理 GET
  if (req.method !== "GET") return;

  event.respondWith(
    caches.match(req).then((cached) => {
      // 有缓存就先返回缓存，同时后台更新
      const fetchPromise = fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        return res;
      }).catch(() => cached);

      return cached || fetchPromise;
    })
  );
});
