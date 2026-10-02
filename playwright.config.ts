// Browser tests for the Laissez app. Runs against any deployment: BASE_URL defaults to the live site.
//
//   npm --prefix tests/e2e ci
//   npx --prefix tests/e2e playwright test                       # live site
//   BASE_URL=http://localhost:4321/laissez/ npx --prefix tests/e2e playwright test   # astro dev or preview
//
// Locally the preinstalled Chromium at /opt/pw-browsers/chromium is used when present (override with PW_CHROMIUM).
// In CI, `playwright install --with-deps chromium` provides the browser and the default executable applies.
// This file imports nothing from @playwright/test at runtime: the runner is installed under tests/e2e, not the root,
// and a plain config object loads from either place.
import { existsSync } from 'node:fs';
import type { PlaywrightTestConfig } from '@playwright/test';

const BASE_URL = (process.env.BASE_URL || 'https://parikshit7319.github.io/laissez/').replace(/\/?$/, '/');
const API_URL = (process.env.API_URL || 'https://laissez-api.laissez.workers.dev').replace(/\/$/, '');
const chromium = process.env.PW_CHROMIUM || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);

const config: PlaywrightTestConfig = {
  testDir: './tests/e2e',
  testMatch: /.*\.spec\.ts$/,
  // The flows talk to a real API and database; give them room, and keep retries for network flakiness only.
  timeout: 120_000,
  expect: { timeout: 20_000 },
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : 3,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: 'tests/e2e/report' }], ['github']] : [['list']],
  outputDir: 'tests/e2e/results',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 20_000,
    navigationTimeout: 45_000,
    extraHTTPHeaders: { 'x-laissez-e2e': '1' },
  },
  metadata: { baseUrl: BASE_URL, apiUrl: API_URL },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium', channel: undefined, viewport: { width: 1360, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false, ...(chromium ? { launchOptions: { executablePath: chromium } } : {}) },
    },
  ],
};
export default config;
