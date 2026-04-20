import { test, expect } from '@playwright/test';
import { login } from '../fixtures/auth';

/**
 * Smoke tests: after login, every main route renders without
 * a blank page or an error boundary.
 */
test.describe('Navigation smoke tests', () => {
  const routes = [
    '/dashboard',
    '/pos',
    '/products',
    '/customers',
    '/suppliers',
    '/purchases',
    '/reports',
    '/settings',
    '/returns',
    '/returns-analytics',
  ];

  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  for (const route of routes) {
    test(`loads ${route}`, async ({ page }) => {
      const res = await page.goto(route);
      // some routes are SPA — status may be 200 or null
      if (res) {
        expect([200, 304, null]).toContain(res.status());
      }
      // Should not see any hard error
      await expect(page.locator('body')).not.toHaveText(/Application error/i);
      await expect(page.locator('body')).not.toHaveText(/Something went wrong/i);
    });
  }
});
