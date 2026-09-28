/* Offline support: network first (so updates arrive), cache as fallback. */

const V = '14';                 // keep in step with APP_VERSION in app.js and ?v= in index.html
const CACHE = 'firstwords-v' + V;
const ASSETS = [
  '.',
  'index.html',
  'style.css?v=' + V,
  'manifest.webmanifest',
  'js/db.js?v=' + V,
  'js/session.js?v=' + V,
  'js/parent.js?v=' + V,
  'js/app.js?v=' + V,
  'icons/icon-192.png',
  'icons/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  // Own files are always re-checked with the server (ETag), so an update shows on the
  // next open instead of after the host's 10-minute cache window.
  const own = new URL(e.request.url).origin === self.location.origin;
  e.respondWith(
    (own ? fetch(e.request.url, { cache: 'no-cache' }) : fetch(e.request))
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      })
      .catch(() =>
        caches.match(e.request).then(m => m || caches.match('index.html'))
      )
  );
});
