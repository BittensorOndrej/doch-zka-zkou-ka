// Keeps the app files on the device so it opens without internet. It never touches names or attendance.
const VERSION = 'dochazka-3';
const FILES = [
  './',
  './index.html',
  './style.css',
  './store.js',
  './app.js',
  './manifest.webmanifest',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
  './bricolage-grotesque-latin-700-normal.woff2',
  './bricolage-grotesque-latin-ext-700-normal.woff2',
  './ibm-plex-sans-latin-400-normal.woff2',
  './ibm-plex-sans-latin-500-normal.woff2',
  './ibm-plex-sans-latin-600-normal.woff2',
  './ibm-plex-sans-latin-ext-400-normal.woff2',
  './ibm-plex-sans-latin-ext-500-normal.woff2',
  './ibm-plex-sans-latin-ext-600-normal.woff2',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(VERSION).then(cache => cache.addAll(FILES.map(f => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then(hit => hit || fetch(event.request)),
  );
});
