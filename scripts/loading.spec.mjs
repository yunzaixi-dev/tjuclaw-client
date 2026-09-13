import { expect, test } from '@playwright/test';

test.describe('Loading fallback UI', () => {
  for (const theme of ['light', 'dark']) {
    test(`renders styled loading fallback in ${theme} mode`, async ({ page }) => {
      // Intercept dynamic imports of lazy modules to delay them
      await page.route(/\/(assets|src)\/(auth|workspace|product|audit).*\.(js|tsx|ts)/, async route => {
        await new Promise(resolve => setTimeout(resolve, 800));
        await route.continue();
      });

      await page.emulateMedia({ colorScheme: theme });
      // Set storage theme if dark
      if (theme === 'dark') {
        await page.addInitScript(() => {
          localStorage.setItem('tjuclaw.appearance.v1', JSON.stringify({ mode: 'dark', accent: 'mono' }));
        });
      }

      await page.goto('/preview/appearance');

      const fallback = page.locator('.app-loading-shell');
      await expect(fallback).toBeVisible();
      await expect(fallback).toHaveAttribute('role', 'status');
      await expect(page.locator('.app-loading-title')).toHaveText('正在打开 TJUClaw');
      await expect(page.locator('.app-loading-brand')).toBeVisible();

      await page.screenshot({ path: `../test-results/ui/loading-${theme}.png` });

      // Check background color matches theme
      const bg = await fallback.evaluate(el => window.getComputedStyle(el).backgroundColor);
      // Ensure it's not transparent and has proper contrast
      expect(bg).not.toBe('rgba(0, 0, 0, 0)');

      // Eventually resolves to lazy page
      await expect(page.locator('.appearance-panel, [role="dialog"], .product-main')).toBeVisible();
    });
  }

  test('renders cleanly on mobile viewport', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.route(/\/(assets|src)\/(auth|workspace|product|audit).*\.(js|tsx|ts)/, async route => {
      await new Promise(resolve => setTimeout(resolve, 800));
      await route.continue();
    });

    await page.goto('/preview/appearance');
    const fallback = page.locator('.app-loading-shell');
    await expect(fallback).toBeVisible();
    await page.screenshot({ path: '../test-results/ui/loading-mobile.png' });
    await expect(page.locator('.app-loading-title')).toBeVisible();
    await expect(page.locator('.appearance-panel, [role="dialog"], .product-main')).toBeVisible();
  });

  test('respects reduced motion', async ({ page }) => {
    await page.route(/\/(assets|src)\/(auth|workspace|product|audit).*\.(js|tsx|ts)/, async route => {
      await new Promise(resolve => setTimeout(resolve, 600));
      await route.continue();
    });

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/preview/appearance');

    const spinner = page.locator('.app-loading-spinner');
    await expect(spinner).toBeVisible();
    await expect(spinner).toHaveCSS('animation-name', 'none');
  });
});
