const CACHE = 'ecoflow-v3';
const ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/sw.js',
];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  // Skip chrome-extension and non-HTTP requests
  if (!e.request.url.startsWith('http')) return;

  // Never cache API calls — always go to network
  if (e.request.url.includes('/api/')) return;

  // Never cache WebSocket
  if (e.request.url.includes('/ws')) return;

  // For page loads (HTML), network-first so we always get the latest
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).catch(() => caches.match('/index.html'))
    );
    return;
  }

  // For static assets, cache-first but update cache in background
  e.respondWith(
    caches.match(e.request).then(cached => {
      const fetchPromise = fetch(e.request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      });
      return cached || fetchPromise;
    })
  );
});
