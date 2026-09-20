const CACHE = 'imgpro-v2';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png'
];

// CDN libs to cache on first use
const CDN_CACHE = 'imgpro-cdn';

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(STATIC_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE && k !== CDN_CACHE).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // CDN scripts: cache on first fetch, serve stale
  if (url.hostname.includes('cdnjs.cloudflare.com') || url.hostname.includes('cdn.jsdelivr.net')) {
    e.respondWith(
      caches.open(CDN_CACHE).then(cache =>
        cache.match(req).then(cached =>
          (cached || fetch(req).then(res => { cache.put(req, res.clone()); return res; }))
        )
      )
    );
    return;
  }

  // API calls: network only
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(fetch(req).catch(() => new Response(JSON.stringify({ error: 'Offline' }), { status: 503 })));
    return;
  }

  // Static assets: cache-first
  e.respondWith(
    caches.open(CACHE).then(cache =>
      cache.match(req).then(cached =>
        (cached || fetch(req).then(res => {
          if (res.ok && res.type === 'basic') cache.put(req, res.clone());
          return res;
        }).catch(() => cached || new Response('Offline', { status: 503 })))
      )
    )
  );
});
