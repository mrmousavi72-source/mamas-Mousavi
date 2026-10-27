// Caches the app shell so it opens without a network; API calls and map
// tiles always go to the network.
const CACHE = 'bedo-v5';
const SHELL = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/icon.svg',
  '/manifest.webmanifest',
  '/vendor/maplibre/maplibre-gl.css',
  '/vendor/maplibre/maplibre-gl.js',
  '/vendor/pmtiles/pmtiles.js',
  '/vendor/rtl-text/mapbox-gl-rtl-text.js',
  '/vendor/vazirmatn/Vazirmatn-font-face.css',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/map/')) {
    return;
  }
  // Network first so updates show up immediately; fall back to the cache offline.
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        return res;
      })
      .catch(() => caches.match(event.request)),
  );
});
