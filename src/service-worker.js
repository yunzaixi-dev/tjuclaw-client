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
// - The one exception is a worker older than GENERATION. Those cached the
//   server's HTML fallback as code once a deploy had removed a file their
//   shell still asked for, which leaves a blank page that cannot ask for
//   anything. A worker of this generation replaces them at once and reloads
//   their pages.

const SHELL = `tjuclaw-shell-${BUILD.version}`;
const ASSETS = 'tjuclaw-assets';
// Present on a device once a worker of this generation has taken over.
const GENERATION = 'tjuclaw-worker-2';

// True when the worker in control is from before GENERATION.
const replacesOlderWorker = async () => {
  const names = await caches.keys();
  return !names.includes(GENERATION) && names.some(name => name.startsWith('tjuclaw-shell-') && name !== SHELL);
};

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL);
    await shell.addAll(BUILD.precache.map(url => new Request(url, { cache: 'reload' })));
    if (await replacesOlderWorker()) await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const takeover = await replacesOlderWorker();
    await caches.open(GENERATION);
    for (const name of await caches.keys()) {
      if (name.startsWith('tjuclaw-shell-') && name !== SHELL) await caches.delete(name);
    }
    const current = new Set(BUILD.assets);
    const assets = await caches.open(ASSETS);
    for (const request of await assets.keys()) {
      if (!current.has(new URL(request.url).pathname)) await assets.delete(request);
    }
    await self.clients.claim();
    if (takeover) {
      // Pages of the older worker may be blank: load them again on this build.
      for (const client of await self.clients.matchAll({ type: 'window' })) void client.navigate(client.url).catch(() => undefined);
    }
  })());
});

// The server answers a file it no longer has with the app's HTML. That is
// not the code that was asked for: never store it, and say it is missing.
const isHtml = response => (response.headers.get('Content-Type') || '').includes('text/html');
const missing = () => new Response('', { status: 404, statusText: 'Not Found' });

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
    if (response?.ok && response.type === 'basic' && !isHtml(response)) await assets.put(url.pathname, response);
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
    if (cached && !isHtml(cached)) return cached;
    const response = await fetch(request);
    if (isHtml(response)) return missing();
    if (response.ok && response.type === 'basic') {
      const copy = response.clone();
      event.waitUntil(caches.open(ASSETS).then(cache => cache.put(request, copy)));
    }
    return response;
  })());
});
