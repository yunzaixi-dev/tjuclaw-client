import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: ['ui.spec.mjs', 'loading.spec.mjs', 'auth-transition.spec.mjs', 'pwa.spec.mjs'],
  outputDir: '../test-results/ui',
  workers: 1,
  // A few tests depend on browser timing the suite does not control (a
  // service worker activating while the test's debugger is attached to it, a
  // hover finishing before a click). On CI a failed test is run again, and
  // one that then passes is reported as flaky instead of blocking the release.
  retries: process.env.CI ? 2 : 0,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:1422',
    browserName: 'chromium',
    viewport: { width: 1440, height: 900 },
    colorScheme: 'light',
    reducedMotion: 'reduce',
    // Suites mock the network; the installed-app behaviour has its own spec.
    serviceWorkers: 'block',
    screenshot: 'only-on-failure',
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {},
  },
  webServer: {
    cwd: '..',
    command: 'pnpm exec vite preview --host 127.0.0.1 --port 1422 --strictPort',
    url: 'http://127.0.0.1:1422',
    reuseExistingServer: false,
  },
});
