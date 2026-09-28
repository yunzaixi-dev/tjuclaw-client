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
      await expect(page.getByRole('progressbar', { name: '加载进度' })).toHaveAttribute('aria-valuenow', '10');
      await expect(page.locator('.workspace-opening')).toHaveCSS('opacity', '1');
      await page.screenshot({ path: `../test-results/ui/loading-${theme}.png` });
      const bg = await page.locator('.workspace-opening').evaluate(el => getComputedStyle(el).backgroundColor);
      expect(bg).not.toBe('rgba(0, 0, 0, 0)');
      await expect(page.locator('.appearance-panel, [role="dialog"], .product-main')).toBeVisible();
    });
  }

  test('stays hidden for its first moments so a quick load never flashes it', async ({ page }) => {
    await slowChunks(page, 900);
    // Record, per frame, how long the screen has existed and its opacity.
    await page.addInitScript(() => {
      window.__opening = [];
      let born = 0;
      const sample = () => {
        const screen = document.querySelector('.workspace-opening');
        if (screen) {
          born ||= performance.now();
          window.__opening.push([performance.now() - born, Number(getComputedStyle(screen).opacity)]);
        }
        if (!document.querySelector('.appearance-panel, .product-main')) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await page.goto('/preview/appearance');
    await expect(page.locator('.appearance-panel, [role="dialog"], .product-main')).toBeVisible();
    const frames = await page.evaluate(() => window.__opening);
    expect(frames.filter(([age]) => age < 200).every(([, opacity]) => opacity === 0)).toBe(true);
    expect(frames.some(([, opacity]) => opacity === 1)).toBe(true);
  });

  test('renders cleanly on mobile viewport', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await slowChunks(page, 900);
    await page.goto('/preview/appearance');
    await expect(page.locator('.workspace-opening-card')).toBeVisible();
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
    await expect(page.locator('.workspace-opening-card')).toHaveCSS('animation-name', 'none');
    await expect(page.locator('.workspace-opening-bar span')).toHaveCSS('animation-name', 'none');
  });
});
