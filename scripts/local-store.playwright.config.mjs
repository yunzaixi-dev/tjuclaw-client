import { defineConfig } from '@playwright/test';

// The store is not reachable from any route until cutover, so this suite loads
// the module from the Vite dev server in a real Chromium with OPFS.
export default defineConfig({
  testDir: '.',
  testMatch: ['local-store.spec.mjs'],
  outputDir: '../test-results/local-store',
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:1424',
    browserName: 'chromium',
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {},
  },
  webServer: {
    cwd: '..',
    command: 'pnpm exec vite --host 127.0.0.1 --port 1424 --strictPort',
    url: 'http://127.0.0.1:1424',
    reuseExistingServer: false,
  },
});
