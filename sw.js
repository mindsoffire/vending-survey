const CACHE_NAME = 'vending-survey-shell-v2';

const APP_SHELL_URLS = [
  './',
  './index.html',
  './styles.css',
  './config.js',
  './db.js',
  './photo.js',
  './drive.js',
  './zip.js',
  './map.js',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

// External library assets cached on first load so Leaflet UI works offline.
// Map tiles (tile.openstreetmap.org, onemap.gov.sg/maps/tiles) are NEVER cached
// or prefetched, in compliance with OSM tile usage policy.
const LIB_URLS = [
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      await cache.addAll(APP_SHELL_URLS);
      for (const url of LIB_URLS) {
        try {
          await cache.add(url);
        } catch (err) {
          // Non-fatal if offline during install
        }
      }
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never cache map tiles, Google APIs, or OAuth endpoints
  if (
    url.hostname.includes('tile.openstreetmap.org') ||
    (url.hostname.includes('onemap.gov.sg') && url.pathname.includes('/tiles/')) ||
    url.hostname.includes('googleapis.com') ||
    url.hostname.includes('accounts.google.com')
  ) {
    return;
  }

  // Same-origin app shell & Leaflet library: cache-first with network fallback
  if (url.origin === self.location.origin || url.hostname === 'unpkg.com') {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        }).catch(() => {
          if (request.mode === 'navigate') {
            return caches.match('./index.html');
          }
          return new Response('Offline', { status: 503, statusText: 'Offline' });
        });
      })
    );
  }
});
