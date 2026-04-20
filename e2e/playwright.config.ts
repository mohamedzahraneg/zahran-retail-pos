import { defineConfig, devices } from '@playwright/test';

/**
 * Zahran Retail — Playwright end-to-end configuration.
 *
 * Env vars (all optional):
 *   BASE_URL      : URL of the frontend (default http://localhost:5173)
 *   API_URL       : URL of the backend API (default http://localhost:3000)
 *   ADMIN_USER    : admin username (default: admin)
 *   ADMIN_PASS    : admin password (default: admin123)
 */
export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,      // retail flows share state (stock etc.)
  retries: process.env.CI ? 2 : 0,
  reporter: [['html', { open: 'never' }], ['list']],

  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    locale: 'ar-EG',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: process.env.CI
    ? undefined
    : [
        {
          command: 'npm --prefix ../backend run start:dev',
          url: process.env.API_URL || 'http://localhost:3000/health',
          reuseExistingServer: true,
          timeout: 120_000,
        },
        {
          command: 'npm --prefix ../frontend run dev',
          url: process.env.BASE_URL || 'http://localhost:5173',
          reuseExistingServer: true,
          timeout: 120_000,
        },
      ],
});
