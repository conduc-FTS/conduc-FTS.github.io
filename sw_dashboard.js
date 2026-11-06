/**
 * sw_dashboard.js — Service worker du Dashboard FTS
 *
 * Stratégie réseau-d'abord (network-first) : on essaie toujours de
 * récupérer la version la plus récente d'un fichier sur le serveur ;
 * le cache ne sert que si le réseau est indisponible (usage hors-ligne
 * ponctuel sur chantier). Les appels à l'API Google (Drive, Gmail,
 * auth) ne sont jamais mis en cache.
 *
 * Important : le numéro de version (CACHE_NAME) doit être incrémenté
 * à chaque fois qu'on modifie sw_dashboard.js lui-même, pour forcer
 * la suppression des anciens caches. Pour les autres fichiers
 * (HTML/CSS/JS des modules), la stratégie réseau-d'abord suffit à
 * toujours prendre la version la plus fraîche sans avoir à changer
 * ce numéro.
 */
const CACHE_NAME = "fts-dashboard-v10";
// Documents gardés hors ligne par le chef (onglet DOCUMENTS) : ce cache
// n'est JAMAIS supprimé par une mise à jour de l'appli.
const CACHE_DOCS = "fts-docs-v1";
const ASSETS = [
  "/",
  "/index.html",
  "/css/dashboard.css",
  "/js/auth.js",
  "/js/drive.js",
  "/js/notifications.js",
  "/js/calendar.js",
  "/js/dashboard.js",
  "/js/sheets.js",
  "/js/documents.js",
  "/js/boite-envoi.js",
  "/js/gmail.js",
  "/js/stock.js",
  "/lib/jspdf/jspdf.umd.min.js",
  "/rapport/",
  "/rapport/index.html",
  "/lib/pdfjs/pdf.min.js",
  "/lib/pdfjs/pdf.worker.min.js",
  "/assets/logo-fts.png",
  "/js/parc-materiel.js",
  "/js/personnel.js",
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
      Promise.all(keys.filter((k) => k !== CACHE_NAME && k !== CACHE_DOCS).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Ne jamais intercepter les appels vers d'autres origines
  // (Google Identity, Drive API, Gmail API, jsPDF CDN...).
  if (url.origin !== self.location.origin) {
    return;
  }
  // Documents hors ligne : lus directement par la page (Cache Storage)
  if (url.pathname.startsWith("/__docs/")) return;
  if (event.request.method !== "GET") return;

  event.respondWith(
    fetch(event.request, { cache: "no-store" })
      .then((response) => {
        // Réseau disponible : on sert la réponse fraîche et on met
        // à jour le cache en arrière-plan pour le mode hors-ligne.
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return response;
      })
      .catch(() => {
        // Réseau indisponible : on retombe sur le cache si possible.
        return caches.match(event.request);
      })
  );
});
