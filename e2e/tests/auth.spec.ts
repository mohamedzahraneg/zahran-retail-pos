import { test, expect } from '@playwright/test';
import { login, ADMIN_USER } from '../fixtures/auth';

test.describe('Authentication', () => {
  test('rejects bad credentials', async ({ page }) => {
    await page.goto('/login');
    await page
      .locator('input[name="username"]')
      .first()
      .fill('no-such-user');
    await page
      .locator('input[type="password"]')
      .first()
      .fill('wrong');
    await page
      .getByRole('button', { name: /login|دخول|تسجيل/i })
      .first()
      .click();

    // Stays on /login and shows some error
    await expect(page).toHaveURL(/\/login/);
  });

  test('admin can log in and reach dashboard', async ({ page }) => {
    await login(page);
    // Expect some admin-visible navigation element to exist.
    await expect(
      page.locator('nav, aside').filter({ hasText: /POS|لوحة|dashboard/i }).first(),
    ).toBeVisible({ timeout: 15_000 });
  });

  test('logout clears session', async ({ page, context }) => {
    await login(page);
    await context.clearCookies();
    await page.goto('/pos');
    await expect(page).toHaveURL(/\/login/);
    // Re-login works after clearing
    await login(page, ADMIN_USER);
  });
});
