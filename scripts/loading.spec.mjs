import { expect, test } from '@playwright/test';

const slowChunks = (page, delay) => page.route(/\/(assets|src)\/(auth|workspace|product|audit).*\.(js|tsx|ts)/, async route => {
  await new Promise(resolve => setTimeout(resolve, delay));
  await route.continue();
});

test.describe('Opening screen', () => {
  for (const theme of ['light', 'dark']) {
    test(`shows progress while a page loads in ${theme} mode`, async ({ page }) => {
      await slowChunks(page, 900);
      await page.emulateMedia({ colorScheme: theme });
      if (theme === 'dark') {
        await page.addInitScript(() => {
          localStorage.setItem('tjuclaw.appearance.v1', JSON.stringify({ mode: 'dark', accent: 'mono' }));
        });
      }
      await page.goto('/preview/appearance');
      const screen = page.getByRole('status', { name: /^正在打开 TJUClaw：加载界面$/ });
      await expect(screen).toBeVisible();
      await expect(page.getByRole('progressbar', { name: '加载进度' })).toHaveAttribute('aria-valuetext', '阶段 1/6：加载界面');
      await expect(page.locator('.workspace-opening')).toHaveCSS('opacity', '1');
      await page.screenshot({ path: `../test-results/ui/loading-${theme}.png` });
      const bg = await page.locator('.workspace-opening').evaluate(el => getComputedStyle(el).backgroundColor);
      expect(bg).not.toBe('rgba(0, 0, 0, 0)');
      await expect(page.locator('.appearance-panel, [role="dialog"], .product-main')).toBeVisible();
    });
  }

  test('stays hidden for its first moments so a quick load never flashes it', async ({ page }) => {
    // Measure from mount, not the first RAF (which can arrive late under load).
    await page.clock.install();
    await page.clock.pauseAt(new Date());
    let releaseChunk;
    const chunkReady = new Promise(resolve => { releaseChunk = resolve; });
    await page.route(/\/assets\/product.*\.js/, async route => {
      await chunkReady;
      await route.continue();
    });
    await page.goto('/preview/appearance');
    const screen = page.locator('.workspace-opening');
    await expect(screen).toBeAttached();
    await expect(screen).toHaveCSS('opacity', '0');
    await page.clock.runFor(239);
    await expect(screen).toHaveCSS('opacity', '0');
    await page.clock.runFor(1);
    await expect(screen).toHaveCSS('opacity', '1');
    releaseChunk();
    await page.clock.resume();
    await expect(page.locator('.appearance-panel, [role="dialog"], .product-main')).toBeVisible();
  });

  test('renders cleanly on mobile viewport', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await slowChunks(page, 900);
    await page.goto('/preview/appearance');
    await expect(page.locator('.workspace-opening-card')).toBeVisible();
    await expect(page.locator('.workspace-opening')).toHaveCSS('opacity', '1');
    const box = await page.locator('.workspace-opening-card').boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    await page.screenshot({ path: '../test-results/ui/loading-mobile.png' });
    await expect(page.locator('.appearance-panel, [role="dialog"], .product-main')).toBeVisible();
  });

  test('respects reduced motion', async ({ page }) => {
    await slowChunks(page, 900);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/preview/appearance');
    await expect(page.locator('.workspace-opening-card')).toBeVisible();
    await expect(page.locator('.workspace-opening')).toHaveCSS('opacity', '1');
    await expect(page.locator('.workspace-opening-card')).toHaveCSS('animation-name', 'none');
    await expect(page.locator('.workspace-opening-bar span')).toHaveCSS('animation-name', 'none');
  });
});
