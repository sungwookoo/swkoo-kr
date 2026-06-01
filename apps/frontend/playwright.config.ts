import { defineConfig, devices } from '@playwright/test';

// Mock-only browser smoke. We DO NOT call swkoo.kr or any real backend
// — every /api/* response is provided by `page.route(...)` per spec.
// Run locally with `npm run test:e2e`. Not wired into CI yet (brain
// install + browser launch overhead is larger than Vitest; we stabilize
// on developer machines first and decide a CI hook separately).
//
// Port choice: 3100 (not 3000) so the smoke server doesn't fight a
// regular `next dev` the developer may already have running. The
// NEXT_PUBLIC_API_BASE_URL override is loud-and-clear — it points the
// in-page fetcher at this same port so all `/api/*` calls stay inside
// the page.route() interception net.
export default defineConfig({
  testDir: './e2e',
  // Single worker keeps the dev server hot path simple and avoids
  // flake from parallel route handlers stomping on each other.
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  // Conservative timeout — `next dev` lazy-compiles each route on
  // first visit, so the first navigation in any test can be slow.
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: 'http://localhost:3100',
    trace: 'retain-on-failure',
    // Run headless by default; pass --headed to debug visually.
    actionTimeout: 10_000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: 'npx next dev -p 3100',
    url: 'http://localhost:3100',
    reuseExistingServer: !process.env.CI,
    // First-time `next dev` boot on a cold node_modules can be slow;
    // give it 3 minutes before we give up.
    timeout: 180_000,
    env: {
      // Point the bundled API_BASE_URL at the same origin Playwright
      // is driving — that way `page.route('**/api/**')` catches
      // everything without origin/CORS games.
      NEXT_PUBLIC_API_BASE_URL: 'http://localhost:3100/api',
    },
  },
});
