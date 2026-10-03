import { defineConfig } from '@playwright/test';

// Run separately; never overlap with the other browser suites.
export default defineConfig({
  testDir: '.',
  testMatch: 'workspace-connections.spec.mjs',
  outputDir: '../test-results/workspace-connections',
  workers: 1,
  timeout: 30000,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:1426',
    browserName: 'chromium',
    viewport: { width: 1440, height: 900 },
    colorScheme: 'light',
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
    screenshot: 'only-on-failure',
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {},
  },
  webServer: {
    cwd: '..',
    command: 'pnpm exec vite preview --host 127.0.0.1 --port 1426 --strictPort',
    url: 'http://127.0.0.1:1426',
    reuseExistingServer: false,
  },
});
