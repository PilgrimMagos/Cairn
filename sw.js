const CACHE_NAME = 'cairn-cache-v3';

const NEVER_INTERCEPT = [
  'accounts.google.com',
  'apis.google.com',
  'oauth2.googleapis.com',
  'content.googleapis.com',
];

// The shared trip/photo data file — kept network-first so changes from another
// signed-in editor show up immediately rather than waiting for a cache refresh.
const ALWAYS_FRESH = [
  'files/198TxkGbesGAK3tXxCS725vUHil42-3Qn',
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(names =>
      Promise.all(names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  if (req.method !== 'GET') return;
  if (NEVER_INTERCEPT.some(host => req.url.includes(host))) return;

  if (ALWAYS_FRESH.some(pattern => req.url.includes(pattern))) {
    event.respondWith(
      fetch(req).then(res => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, copy));
        }
        return res;
      }).catch(() =>
        caches.match(req).then(cached => {
          if (cached) return cached;
          throw new Error('offline and not cached');
        })
      )
    );
    return;
  }

  // Everything else: serve instantly from cache when available, and quietly
  // refresh the cache in the background for next time (stale-while-revalidate).
  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(req);
      const networkFetch = fetch(req).then(res => {
        if (res && res.status === 200) cache.put(req, res.clone());
        return res;
      }).catch(() => null);

      if (cached) {
        event.waitUntil(networkFetch);
        return cached;
      }
      const netRes = await networkFetch;
      if (netRes) return netRes;
      throw new Error('offline and not cached');
    })
  );
});
