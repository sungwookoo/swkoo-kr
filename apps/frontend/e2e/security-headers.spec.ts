import { expect, test } from '@playwright/test';
import { installCatchAll, json } from './fixtures';

test('CSP has a fresh nonce and the login screen hydrates', async ({ page }) => {
  await installCatchAll(page);
  await page.route('**/api/auth/me', route => json(route, 401, {}));
  const first = await page.goto('/deploy');
  const policy = first!.headers()['content-security-policy'];
  expect(policy).toContain("frame-ancestors 'none'");
  expect(policy).toContain("'nonce-");
  expect(first!.headers()['x-content-type-options']).toBe('nosniff');
  await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
  const second = await page.reload();
  expect(second!.headers()['content-security-policy']).not.toBe(policy);
});

test('static demo works with its enforcing CSP', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', message => { if (message.type() === 'error' && /Content Security Policy|Refused to/.test(message.text())) errors.push(message.text()); });
  const response = await page.goto('/excel-service/demo');
  expect(response!.headers()['content-security-policy']).toContain("script-src 'self'");
  await page.locator('#sample').click();
  await expect(page.locator('#countRows')).toHaveText('12');
  expect(errors).toEqual([]);
});

test('portfolio and architecture scripts work under CSP', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', message => { if (message.type() === 'error' && /Content Security Policy|Refused to/.test(message.text())) errors.push(message.text()); });
  const response = await page.goto('/portfolio/');
  expect(response!.headers()['content-security-policy']).toContain('sha256-');
  await expect(page.locator('#print-portfolio')).toBeVisible();
  await installCatchAll(page);
  await page.goto('/about');
  await expect(page.locator('.mermaid-diagram svg')).toBeVisible();
  expect(errors).toEqual([]);
});
