/* Bunk Buddy service worker — offline app shell.
   Bump CACHE on any asset change to invalidate old caches. */
const CACHE = 'bunkbuddy-v9';
const ASSETS = [
  './',
  './index.html',
  './style.css?v=9',
  './script.js?v=9',
  './manifest.webmanifest',
  './logo.png?v=9',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png',
  'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  // Tesseract also pulls wasm + language data at runtime — cache those
  // on first use so a second visit works fully offline.
  const url = new URL(req.url);
  const isTesseractRuntime = /tessdata|tesseract|\.wasm|\.traineddata/.test(url.href);

  if (isTesseractRuntime) {
    e.respondWith(
      caches.open(CACHE).then((cache) =>
        cache.match(req).then((hit) =>
          hit || fetch(req).then((res) => { cache.put(req, res.clone()); return res; })
        )
      )
    );
    return;
  }

  // App shell: cache-first, fall back to network, then to cached index.
  e.respondWith(
    caches.match(req).then((hit) =>
      hit || fetch(req).then((res) => {
        if (res.ok && url.origin === location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => caches.match('./index.html'))
    )
  );
});
