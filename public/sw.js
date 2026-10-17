/**
 * Service Worker per Note PDF PWA (v4)
 */
const CACHE_NAME = 'notepdf-shell-v7';

const APP_SHELL_ASSETS = [
  './',
  './index.html',
  './style.css',
  './config.js',
  './app.js',
  './manifest.json',
  './icon.svg',
  './pwa-192x192.png',
  './pwa-512x512.png',
  './pwa-maskable-512x512.png',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return Promise.allSettled(
        APP_SHELL_ASSETS.map((url) => {
          return fetch(url, { mode: url.startsWith('http') ? 'cors' : 'no-cors' })
            .then((response) => {
              if (response.ok || response.type === 'opaque') {
                return cache.put(url, response);
              }
            })
            .catch((err) => {
              console.warn('[SW] Impossibile pre-memorizzare:', url, err);
            });
        })
      );
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((name) => {
          if (name !== CACHE_NAME) {
            console.log('[SW] Rimozione vecchia cache:', name);
            return caches.delete(name);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const requestUrl = new URL(event.request.url);

  if (
    requestUrl.pathname.startsWith('/api/') ||
    requestUrl.hostname.includes('api.github.com') ||
    requestUrl.hostname.includes('raw.githubusercontent.com')
  ) {
    return;
  }

  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const copy = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return networkResponse;
        })
        .catch(() => caches.match('./index.html') || caches.match('./'))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }

      return fetch(event.request).then((networkResponse) => {
        if (
          networkResponse &&
          (networkResponse.status === 200 || networkResponse.type === 'opaque') &&
          (requestUrl.pathname.endsWith('.js') ||
           requestUrl.pathname.endsWith('.css') ||
           requestUrl.pathname.endsWith('.png') ||
           requestUrl.pathname.endsWith('.svg') ||
           requestUrl.pathname.endsWith('.woff2') ||
           requestUrl.hostname.includes('cdnjs.cloudflare.com'))
        ) {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      });
    })
  );
});
