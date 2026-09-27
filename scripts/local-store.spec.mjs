import { expect, test } from '@playwright/test';

const open = page => page.evaluate(async () => {
  const module = await import('/src/lib/local-store.ts');
  window.__store = await module.openLocalStore();
  window.__module = module;
  return window.__store.engine;
});

test('browser tabs share one SQLite database on OPFS and survive leader handover', async ({ context }) => {
  const first = await context.newPage();
  await first.goto('/preview/appearance');
  expect(await open(first)).toBe('sqlite-opfs');
  await first.evaluate(async () => {
    await window.__store.set('notes', 'b', '第二条');
    await window.__store.set('notes', 'a', '第一条');
    await window.__store.set('other', 'a', 'x');
  });

  const second = await context.newPage();
  await second.goto('/preview/appearance');
  expect(await open(second)).toBe('sqlite-opfs');
  expect(await second.evaluate(() => window.__store.list('notes'))).toEqual([['a', '第一条'], ['b', '第二条']]);
  await second.evaluate(() => window.__store.set('notes', 'c', '来自第二个标签页'));
  expect(await first.evaluate(() => window.__store.get('notes', 'c'))).toBe('来自第二个标签页');

  // Closing the leader hands the database to the remaining tab.
  await first.close();
  await expect.poll(() => second.evaluate(() => window.__store.get('notes', 'a')), { timeout: 15_000 }).toBe('第一条');
  await second.evaluate(() => window.__store.delete('notes', 'a'));
  expect(await second.evaluate(() => window.__store.get('notes', 'a'))).toBeNull();

  // Data persists across a reload.
  await second.reload();
  expect(await open(second)).toBe('sqlite-opfs');
  expect(await second.evaluate(() => window.__store.list('notes'))).toEqual([['b', '第二条'], ['c', '来自第二个标签页']]);
});

test('legacy localStorage keys migrate once without overwriting newer values', async ({ page }) => {
  await page.goto('/preview/appearance');
  await open(page);
  const result = await page.evaluate(async () => {
    localStorage.setItem('tjuclaw.appearance.v1', '{"mode":"dark"}');
    const first = await window.__module.importLegacyLocalStorage(window.__store, 'prefs', ['tjuclaw.appearance.v1', 'missing']);
    await window.__store.set('prefs', 'tjuclaw.appearance.v1', '{"mode":"light"}');
    const second = await window.__module.importLegacyLocalStorage(window.__store, 'prefs', ['tjuclaw.appearance.v1']);
    return [first, second, await window.__store.get('prefs', 'tjuclaw.appearance.v1')];
  });
  expect(result).toEqual([1, 0, '{"mode":"light"}']);
});

test('invalid names and oversized values are rejected before storage', async ({ page }) => {
  await page.goto('/preview/appearance');
  await open(page);
  const errors = await page.evaluate(async () => {
    const attempt = promise => promise.then(() => 'ok', error => error.message);
    return [
      await attempt(window.__store.set('', 'k', 'v')),
      await attempt(window.__store.get('ns', 'x'.repeat(257))),
      await attempt(window.__store.set('ns', 'k', 'x'.repeat((4 << 20) + 1))),
    ];
  });
  expect(errors).toEqual(['store_invalid_key', 'store_invalid_key', 'store_value_too_large']);
});
