const CACHE_NAME = "bodyshop-pwa-v1";

const ASSETS = [
  "/",
  "/index.html",
  "/manifest.json",
  "/src/style.css",
  "/src/app.js",
  "/kia_carnival.glb",
  "/images/logo.jpg"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.map((k) => (k !== CACHE_NAME ? caches.delete(k) : null)))
    )
  );
  self.clients.claim();
});

// Network-first for HTML so updates show
self.addEventListener("fetch", (event) => {
  const req = event.request;

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(() => caches.match("/index.html"))
    );
    return;
  }

  // Cache-first for assets
  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req))
  );
});