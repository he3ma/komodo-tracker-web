const CACHE_NAME = "komodo-tracker-pwa-20261126214656";
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./manifest.webmanifest",
  "./js/app.js",
  "./js/calculator.js",
  "./js/sync.js",
  "./vendor/jsQR.js",
  "./vendor/qrcode.js",
  "./icons/icon-180.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.hostname === "api.github.com" || url.hostname.endsWith("githubusercontent.com")) {
    return; // Immer live über Netzwerk
  }
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (event.request.method === "GET" && res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
