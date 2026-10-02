import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'workspace.spec.mjs',
  outputDir: '../test-results/workspace',
  // Every test mocks its own page, so tests of one file can run side by side.
  fullyParallel: true,
  workers: 4,
  timeout: 45000,
  expect: { timeout: 10000 },
  reporter: [['list'], ['json', { outputFile: '../test-results/workspace/report.json' }]],
  use: {
    baseURL: 'http://127.0.0.1:1424',
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
  webServer: [
    {
      cwd: '..',
      command: 'pnpm exec vite preview --host 127.0.0.1 --port 1424 --strictPort',
      url: 'http://127.0.0.1:1424',
      reuseExistingServer: false,
    },
  ],
});
