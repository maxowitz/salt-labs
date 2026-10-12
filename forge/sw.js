// FORGE service worker — precache the app shell, then network-first with offline fallback for same-origin GETs.
// Bump VERSION whenever the precache list changes.
const VERSION = 'forge-v4';
const SHELL = [
  './', 'index.html', 'manifest.json', 'icon.svg',
  'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
  'fonts/archivo-var.woff2', 'fonts/plex-mono-400.woff2', 'fonts/plex-mono-500.woff2',
  'css/app.css', 'css/train.css', 'css/workout.css', 'css/fuel.css', 'css/dash.css',
  'js/app.js', 'js/theme.js', 'js/store.js', 'js/idb.js', 'js/api.js', 'js/sync.js', 'js/lock.js', 'js/ui.js', 'js/charts.js',
  'js/data/exercises.js', 'js/data/foods.js',
  'js/engine/program.js', 'js/engine/coach.js', 'js/engine/hyrox.js', 'js/engine/nutrition.js', 'js/engine/timer.js',
  'js/views/today.js', 'js/views/train.js', 'js/views/session.js', 'js/views/workout.js', 'js/views/_timerui.js',
  'js/views/timer.js', 'js/views/library.js', 'js/views/hyrox.js', 'js/views/history.js',
  'js/views/fuel.js', 'js/views/progress.js', 'js/views/me.js', 'js/views/onboarding.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    // add individually so one missing file never blocks install
    await Promise.all(SHELL.map((u) => cache.add(new Request(u, { cache: 'reload' })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // Open Food Facts etc. go straight to network
  if (url.pathname.includes('/api/')) return; // never cache API traffic (backups, photo estimates)

  // Network-first: always run the newest code when online (no mixing old and new modules between releases);
  // fall back to the precached copy offline.
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const cached = await cache.match(req, { ignoreSearch: req.mode === 'navigate' });
    const network = fetch(req, { cache: 'no-cache' }).then((res) => {
      if (res.ok && res.type === 'basic') cache.put(req, res.clone());
      return res;
    });
    try {
      // weak gym wifi: if a cached copy exists, don't wait more than 3.5 s for the network
      if (!cached) return await network;
      return await Promise.race([network, new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), 3500))]);
    } catch {
      if (cached) { e.waitUntil(network.catch(() => {})); return cached; }
      if (req.mode === 'navigate') return (await cache.match('index.html')) || Response.error();
      return Response.error();
    }
  })());
});
