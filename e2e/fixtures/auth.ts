import { Page, expect } from '@playwright/test';

export const ADMIN_USER = process.env.ADMIN_USER || 'admin';
export const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';

/**
 * Log in as admin. Expects a username + password pair of inputs on
 * `/login` and a main `/dashboard` route after success.
 */
export async function login(
  page: Page,
  username = ADMIN_USER,
  password = ADMIN_PASS,
) {
  await page.goto('/login');
  // Prefer accessible locators with fallback to common input names.
  const userInput = page.getByLabel(/username|اسم المستخدم/i).or(
    page.locator('input[name="username"]'),
  );
  const passInput = page.getByLabel(/password|كلمة المرور/i).or(
    page.locator('input[type="password"]'),
  );
  await userInput.first().fill(username);
  await passInput.first().fill(password);

  await page
    .getByRole('button', { name: /login|دخول|تسجيل/i })
    .first()
    .click();

  // We should be redirected away from /login
  await expect(page).not.toHaveURL(/\/login/);
}
