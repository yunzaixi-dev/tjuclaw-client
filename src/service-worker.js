/* global BUILD */
// The Web app's service worker. The build prepends `const BUILD = { version,
// precache, assets }` (vite.config.ts): the shell files the first screen
// needs, and every hashed file of this build.
//
// - The app shell and its code are served from the device, so a repeat visit
//   does not wait for the network and the shell opens offline.
// - Hashed files under /assets/ never change: cache first, kept until a later
//   build no longer has them.
// - /api/ is never touched: data and sessions always go to the server.
// - A new build installs in the background and takes over only when the page
//   asks (after the user chooses to refresh), so code never changes mid-use.

const SHELL = `tjuclaw-shell-${BUILD.version}`;
const ASSETS = 'tjuclaw-assets';

self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL).then(cache =>
    cache.addAll(BUILD.precache.map(url => new Request(url, { cache: 'reload' })))));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith('tjuclaw-shell-') && name !== SHELL) await caches.delete(name);
    }
    const current = new Set(BUILD.assets);
    const assets = await caches.open(ASSETS);
    for (const request of await assets.keys()) {
      if (!current.has(new URL(request.url).pathname)) await assets.delete(request);
    }
    await self.clients.claim();
  })());
});

const cacheable = url => url.origin === self.location.origin && (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/'));

// The first visit loads its files before this worker controls the page. The
// page then lists what it used, so those files are on the device as well.
async function keep(urls) {
  const shell = await caches.open(SHELL);
  const assets = await caches.open(ASSETS);
  for (const value of urls.slice(0, 400)) {
    let url;
    try { url = new URL(value, self.location.origin); } catch { continue; }
    if (!cacheable(url) || await shell.match(url.pathname, { ignoreVary: true }) || await assets.match(url.pathname, { ignoreVary: true })) continue;
    const response = await fetch(url.pathname).catch(() => null);
    if (response?.ok && response.type === 'basic') await assets.put(url.pathname, response);
  }
}

self.addEventListener('message', event => {
  if (event.data === 'activate') void self.skipWaiting();
  else if (event.data?.type === 'keep' && Array.isArray(event.data.urls)) event.waitUntil(keep(event.data.urls));
});

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (request.mode === 'navigate') {
    // Every route is the same single-page shell.
    event.respondWith(caches.match('/index.html', { cacheName: SHELL, ignoreVary: true }).then(shell => shell ?? fetch(request)));
    return;
  }
  if (!cacheable(url)) return;
  event.respondWith((async () => {
    // A hashed file is the same bytes for every request, whatever the server's Vary says.
    const cached = await caches.match(request, { cacheName: SHELL, ignoreVary: true })
      ?? await caches.match(request, { cacheName: ASSETS, ignoreVary: true });
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok && response.type === 'basic') {
      const copy = response.clone();
      event.waitUntil(caches.open(ASSETS).then(cache => cache.put(request, copy)));
    }
    return response;
  })());
});
