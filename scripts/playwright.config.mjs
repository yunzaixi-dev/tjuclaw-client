import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: ['ui.spec.mjs', 'loading.spec.mjs', 'auth-transition.spec.mjs'],
  outputDir: '../test-results/ui',
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:1422',
    browserName: 'chromium',
    viewport: { width: 1440, height: 900 },
    colorScheme: 'light',
    reducedMotion: 'reduce',
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
