const CACHE_NAME = 'cairn-cache-v5'; // bumped: added the CAIRN_PIN_URLS message handler below
const STALE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // don't re-check anything already cached within 24h

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

async function putWithTimestamp(cache, req, res){
  const headers = new Headers(res.headers);
  headers.set('x-cairn-cached-at', Date.now().toString());
  const body = await res.blob();
  const timestamped = new Response(body, { status: res.status, statusText: res.statusText, headers });
  await cache.put(req, timestamped);
}

function isStale(cachedRes){
  const ts = cachedRes.headers.get('x-cairn-cached-at');
  if(!ts) return true;
  return (Date.now() - parseInt(ts, 10)) > STALE_MAX_AGE_MS;
}

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

  // Everything else: serve instantly from cache when available. Only bother
  // re-checking the network in the background if that cached copy is actually
  // old — already-cached photos don't get re-fetched on every single view.
  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(req);
      if (cached) {
        if (isStale(cached)) {
          event.waitUntil(
            fetch(req).then(res => {
              if (res && res.status === 200) return putWithTimestamp(cache, req, res);
            }).catch(() => null)
          );
        }
        return cached;
      }
      try {
        const netRes = await fetch(req);
        if (netRes && netRes.status === 200) {
          await putWithTimestamp(cache, req, netRes.clone());
        }
        return netRes;
      } catch (e) {
        throw new Error('offline and not cached');
      }
    })
  );
});

// Per-pin "save offline": index.html asks us to proactively fetch and cache a
// specific waypoint's files (its notes/checklist file, GPX route, and photos)
// so the drawer works with no signal later. Handled here — rather than
// index.html reaching into caches.open(CACHE_NAME) directly — so the cache
// name/versioning stays owned by this one file and can't drift out of sync.
self.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || msg.type !== 'CAIRN_PIN_URLS') return;
  const urls = Array.isArray(msg.urls) ? msg.urls : [];
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(urls.map(async (url) => {
      try {
        const res = await fetch(url);
        if (res && res.status === 200) await putWithTimestamp(cache, new Request(url), res);
      } catch (e) {
        // Leave it uncached — the pin just won't be fully available offline yet;
        // the drawer's normal cache-first fetch will retry next time it's viewed online.
      }
    }));
    if (event.source) event.source.postMessage({ type: 'CAIRN_PIN_URLS_DONE', urls });
  })());
});
