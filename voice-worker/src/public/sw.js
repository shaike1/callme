// Service Worker for CallMe Bot PWA
const CACHE = 'callme-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', () => self.clients.claim());

self.addEventListener('fetch', (event) => {
  // Network-first for API, cache-first for static
  if (event.request.url.includes('/api/')) return;
  event.respondWith(
    fetch(event.request).then(r => {
      const clone = r.clone();
      caches.open(CACHE).then(c => c.put(event.request, clone));
      return r;
    }).catch(() => caches.match(event.request))
  );
});
