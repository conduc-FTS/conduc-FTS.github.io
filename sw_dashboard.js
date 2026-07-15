/**
 * sw_dashboard.js — Service worker du Dashboard FTS
 * Mise en cache des fichiers statiques pour un chargement rapide et
 * une tolérance aux coupures réseau ponctuelles. Les appels à l'API
 * Drive (données dynamiques) ne sont jamais mis en cache.
 */
const CACHE_NAME = "fts-dashboard-v1";
const ASSETS = [
  "/",
  "/index.html",
  "/css/dashboard.css",
  "/js/auth.js",
  "/js/drive.js",
  "/js/notifications.js",
  "/js/dashboard.js",
  "/manifest_dashboard.json",
  "/icon-dashboard-192.png",
  "/icon-dashboard-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Ne jamais mettre en cache les appels API (Google, Drive...)
  if (url.origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      return (
        cached ||
        fetch(event.request).then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          return response;
        })
      );
    })
  );
});
