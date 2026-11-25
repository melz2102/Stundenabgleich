// Speichert die App-Dateien, damit sie auch ohne Internet startet.
const CACHE = 'stundenabgleich-v22';
const FILES = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'woche-parser.js',
  'extract.js',
  'lohn-parser.js',
  'auswertung.js',
  'manual.js',
  'hand-erkennung.js',
  'ziffern-netz.js',
  'export.js',
  'vendor/jspdf.umd.min.js',
  'vendor/pdf.min.mjs',
  'vendor/pdf.worker.min.mjs',
  'vendor/xlsx.full.min.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Erst Netz (für Updates), bei fehlendem Internet aus dem Speicher.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
