// Shared Playwright fixtures + small mocking helpers for the smoke
// suite. Everything in this file is intercept-only — we never reach a
// real backend. Keeping the shapes co-located with the suite makes
// each test self-contained for review.
import type { Page, Route } from '@playwright/test';

export interface MeShape {
  id: number;
  githubLogin: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  isAllowed: boolean;
  isAdmin: boolean;
  requiresReauth: boolean;
  requiresConsent: boolean;
  policyVersion: string;
  brandName: string;
}

export const ALICE: MeShape = {
  id: 1,
  githubLogin: 'alice',
  name: 'Alice Tester',
  email: 'alice@example.com',
  avatarUrl: null,
  isAllowed: true,
  isAdmin: false,
  requiresReauth: false,
  requiresConsent: false,
  policyVersion: 'v1',
  brandName: 'swkoo.kr',
};

export async function json(route: Route, status: number, body: unknown): Promise<void> {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

/** Catch-all for `/api/**` calls the test didn't mock. Failing loudly
 * is safer than letting an unstubbed call hit a real host. */
export async function installCatchAll(page: Page): Promise<void> {
  await page.route('**/api/**', async (route) => {
    const url = route.request().url();
    // Surface in the test log so we know which call to add.
    console.warn(`[smoke] unmocked API call: ${url}`);
    await json(route, 599, { message: `unmocked: ${url}` });
  });
}

/** Stable mocks every authenticated-user scenario needs. Call BEFORE
 * scenario-specific routes so per-test handlers (registered AFTER)
 * win priority — Playwright runs handlers in reverse-registration
 * order. */
export async function mockAuthenticatedAs(
  page: Page,
  me: MeShape = ALICE
): Promise<void> {
  await page.route('**/api/auth/me', async (route) => {
    await json(route, 200, me);
  });
  // /current is polled by the deploy page even when no app is deployed.
  await page.route('**/api/deploy/current', async (route) => {
    await json(route, 200, null);
  });
  // Latest scan endpoint — polled by status page.
  await page.route('**/api/account/scan', async (route) => {
    await json(route, 200, null);
  });
}
