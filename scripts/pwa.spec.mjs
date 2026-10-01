import { expect, test } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';

test.use({ serviceWorkers: 'allow' });

const controlled = page => page.evaluate(async () => {
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
  return Boolean(navigator.serviceWorker.controller);
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
    // Until the reader agrees, the page keeps the build it started with.
    expect(await page.evaluate(() => navigator.serviceWorker.getRegistration().then(registration => Boolean(registration.waiting)))).toBe(true);

    await Promise.all([page.waitForEvent('load'), notice.getByRole('button', { name: '刷新', exact: true }).click()]);
    await expect(page.getByLabel('邮箱地址', { exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(async () => (await caches.keys()).filter(name => name.startsWith('tjuclaw-shell-')))).toEqual([`tjuclaw-shell-${'f'.repeat(16)}`]);
  } finally {
    writeFileSync(file, current);
  }
  await expect(page.getByRole('status', { name: '应用更新' })).toHaveCount(0);
});
