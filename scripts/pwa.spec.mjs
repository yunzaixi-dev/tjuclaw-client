import { expect, test } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';

test.use({ serviceWorkers: 'allow' });

const controlled = page => page.evaluate(async () => {
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
  return Boolean(navigator.serviceWorker.controller);
});

test('Android adaptive icons use the brand dark ground and keep the logo inside the safe circle', async ({ page }) => {
  await page.goto('/auth/login');
  const manifest = await (await page.request.get('/manifest.json')).json();
  const adaptive = manifest.icons.find(icon => icon.purpose === 'maskable');
  // A new URL avoids retaining the old white icon in a device's icon cache.
  expect(adaptive).toMatchObject({ src: '/icons/icon-maskable-dark-512.png', sizes: '512x512', type: 'image/png' });
  for (const icon of manifest.icons) {
    const pixels = await page.evaluate(async ({ src, maskable }) => {
      const image = new Image();
      image.src = src;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(image, 0, 0);
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      let opaque = true;
      let foreground = 0;
      let outsideSafeCircle = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] !== 255) opaque = false;
        if (maskable && (data[i] !== 32 || data[i + 1] !== 33 || data[i + 2] !== 31)) {
          foreground++;
          const pixel = i / 4;
          if (Math.hypot(pixel % canvas.width + 0.5 - canvas.width / 2,
            Math.floor(pixel / canvas.width) + 0.5 - canvas.height / 2) > canvas.width * 0.4) outsideSafeCircle++;
        }
      }
      return { width: canvas.width, height: canvas.height, corner: [...data.slice(0, 4)], opaque, foreground, outsideSafeCircle };
    }, { src: icon.src, maskable: icon.purpose === 'maskable' });
    expect(`${pixels.width}x${pixels.height}`).toBe(icon.sizes);
    if (icon.purpose === 'maskable') {
      expect(pixels.corner).toEqual([32, 33, 31, 255]);
      expect(pixels.opaque).toBe(true);
      expect(pixels.foreground).toBeGreaterThan(5000);
      expect(pixels.outsideSafeCircle).toBe(0);
    } else {
      expect(pixels.corner[3]).toBe(0);
      expect(pixels.opaque).toBe(false);
    }
  }
});

test('the app is installable and its shell opens offline, while the API is never cached', async ({ page, context }) => {
  await page.goto('/auth/login');
  await expect(page.getByLabel('邮箱地址', { exact: true })).toBeVisible();

  // Installable: a manifest with a standalone display, a start URL and both icon sizes.
  const manifest = await (await page.request.get(await page.locator('link[rel="manifest"]').getAttribute('href'))).json();
  expect(manifest).toMatchObject({ name: 'TJUClaw', display: 'standalone', start_url: '/workspace', scope: '/' });
  expect(manifest.icons.map(icon => icon.sizes)).toEqual(['192x192', '512x512', '512x512']);
  expect(manifest.icons.some(icon => icon.purpose === 'maskable')).toBe(true);
  for (const icon of manifest.icons) expect((await page.request.get(icon.src)).headers()['content-type']).toBe('image/png');

  expect(await controlled(page)).toBe(true);
  const cached = await page.evaluate(async () => {
    const names = await caches.keys();
    const shell = await caches.open(names.find(name => name.startsWith('tjuclaw-shell-')));
    return (await shell.keys()).map(request => new URL(request.url).pathname);
  });
  expect(cached).toContain('/index.html');
  expect(cached.filter(path => path.startsWith('/assets/')).length).toBeGreaterThan(5);
  // Exactly what the built page asks for up front.
  const html = readFileSync(new URL('../dist/index.html', import.meta.url), 'utf8');
  expect([...cached].sort()).toEqual(['/index.html', ...new Set([...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(match => match[1]))].sort());

  await page.evaluate(() => fetch('/api/auth/flow').catch(() => undefined));
  expect(await page.evaluate(async () => {
    for (const name of await caches.keys()) {
      for (const request of await (await caches.open(name)).keys()) if (new URL(request.url).pathname.startsWith('/api/')) return true;
    }
    return false;
  })).toBe(false);

  // What the first visit loaded before the worker took over (the sign-in page's own code) is kept too.
  await expect.poll(() => page.evaluate(async () => (await (await caches.open('tjuclaw-assets')).keys()).length)).toBeGreaterThan(0);

  // Offline, the shell and its code still come from the device; only the server is missing.
  await context.setOffline(true);
  await page.goto('/workspace');
  await expect(page.locator('#root')).not.toBeEmpty();
  await page.goto('/auth/login');
  await expect(page.getByRole('alert')).toContainText('暂时连接不上认证服务');
  await context.setOffline(false);
});

test('a newer build waits until the reader chooses to refresh', async ({ page }) => {
  // The public changelog: one entry from before this build, two after it.
  const later = minutes => new Date(Date.now() + minutes * 60_000).toISOString();
  await page.route('**/api/release-notes', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: [
    { title: '刷新后编辑笔记可以正常保存', published_at: later(2) },
    { title: '维护记录', published_at: later(3), tags: ['维护'] },
    { title: '手机上从笔记主页直接提问', published_at: later(1) },
    { title: '构建之前的旧条目', published_at: '2020-01-01T00:00:00Z' },
  ] }) }));
  await page.goto('/auth/login');
  expect(await controlled(page)).toBe(true);
  await expect(page.getByRole('status', { name: '应用更新' })).toHaveCount(0);

  // The next check finds a different worker on the server, as after a deployment.
  const file = new URL('../dist/sw.js', import.meta.url);
  const current = readFileSync(file, 'utf8');
  const version = current.match(/"version":"([0-9a-f]{16})"/)[1];
  try {
    writeFileSync(file, current.replace(version, 'f'.repeat(16)));
    await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration()).update(); });
    const notice = page.getByRole('status', { name: '应用更新' });
    await expect(notice).toContainText('新版本已就绪');
    // The notice names the build the reader is on.
    await expect(notice).toContainText(/当前 v\d+\.\d+\.\d+/);
    // It lists the changelog entries published since this build, newest first, and where the rest is.
    const summary = notice.getByRole('list', { name: '更新内容' });
    await expect(summary.getByRole('listitem')).toHaveText(['刷新后编辑笔记可以正常保存', '手机上从笔记主页直接提问']);
    await expect(notice.getByRole('link', { name: '全部更新' })).toHaveAttribute('href', 'https://changelog.tjuclaw.cloud/');
    // Until the reader agrees, the page keeps the build it started with.
    expect(await page.evaluate(() => navigator.serviceWorker.getRegistration().then(registration => Boolean(registration.waiting)))).toBe(true);

    await Promise.all([page.waitForEvent('load'), notice.getByRole('button', { name: '刷新', exact: true }).click()]);
    await expect(page.getByLabel('邮箱地址', { exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(async () => (await caches.keys()).filter(name => name.startsWith('tjuclaw-shell-')))).toEqual([`tjuclaw-shell-${'f'.repeat(16)}`]);
    // Entries already shown are not listed again by the next update.
    expect(Number(await page.evaluate(() => localStorage.getItem('tjuclaw.release-notes.seen')))).toBeGreaterThan(Date.now());
  } finally {
    writeFileSync(file, current);
  }
  await expect(page.getByRole('status', { name: '应用更新' })).toHaveCount(0);
});

// A worker as shipped before the generation marker: it serves its cached
// shell, waits to be asked before taking over, and leaves no marker.
const legacyWorker = `
const SHELL = 'tjuclaw-shell-0000000000000000';
self.addEventListener('install', event => event.waitUntil(caches.open(SHELL).then(cache => cache.add('/index.html'))));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('message', event => { if (event.data === 'activate') void self.skipWaiting(); });
self.addEventListener('fetch', event => {
  if (event.request.mode === 'navigate') event.respondWith(caches.match('/index.html', { cacheName: SHELL }).then(shell => shell ?? fetch(event.request)));
});
`;

test('a build replaces an older-generation worker by itself and reloads its page', async ({ page }) => {
  const file = new URL('../dist/sw.js', import.meta.url);
  const current = readFileSync(file, 'utf8');
  const version = current.match(/"version":"([0-9a-f]{16})"/)[1];
  try {
    writeFileSync(file, legacyWorker);
    await page.goto('/auth/login');
    expect(await controlled(page)).toBe(true);
    expect(await page.evaluate(() => caches.keys())).toEqual(['tjuclaw-shell-0000000000000000']);

    // A deployment: the server now has this build's worker. The page of the
    // older worker may be blank, so nobody is there to press "refresh".
    // The page checks for updates by itself too, so the reload may come
    // before the explicit check: wait for it from before the deployment.
    const reloaded = page.waitForEvent('load');
    writeFileSync(file, current);
    await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration())?.update(); }).catch(() => undefined);
    await reloaded;
    await expect(page.getByLabel('邮箱地址', { exact: true })).toBeVisible();
    // The older shell is gone, this build's shell is in place, and the device is marked as taken over.
    await expect.poll(() => page.evaluate(async () => (await caches.keys()).filter(name => name !== 'tjuclaw-assets').sort())).toEqual(['tjuclaw-shell-' + version, 'tjuclaw-worker-2'].sort());
    expect(await page.evaluate(() => navigator.serviceWorker.getRegistration().then(registration => Boolean(registration.waiting)))).toBe(false);
    await expect(page.getByRole('status', { name: '应用更新' })).toHaveCount(0);
  } finally {
    writeFileSync(file, current);
  }
});

test('the server\'s HTML fallback is never served or kept as code', async ({ page }) => {
  await page.goto('/auth/login');
  expect(await controlled(page)).toBe(true);
  // A file an older shell still asks for after a deployment removed it.
  const gone = '/assets/removed-by-a-later-build-0123abcd.js';
  const direct = await page.request.get(gone);
  test.skip(!(direct.headers()['content-type'] ?? '').includes('text/html'), 'this server does not answer missing files with the app HTML');
  const seen = await page.evaluate(async path => {
    const response = await fetch(path);
    return { status: response.status, type: response.headers.get('Content-Type') ?? '' };
  }, gone);
  expect(seen.status).toBe(404);
  expect(seen.type).not.toContain('text/html');
  expect(await page.evaluate(async path => {
    for (const name of await caches.keys()) if (await (await caches.open(name)).match(path)) return true;
    return false;
  }, gone)).toBe(false);
});
