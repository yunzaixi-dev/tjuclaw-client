import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'pdf-preview.spec.mjs',
  outputDir: '../test-results/pdf-preview',
  workers: 1,
  timeout: 30000,
  reporter: 'list',
  use: {
    browserName: 'chromium',
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {},
  },
});
