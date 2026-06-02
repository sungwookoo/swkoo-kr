// Mobile horizontal-overflow regression. /about is content-only
// (no `/api/*` fetches) so we don't need page.route mocks to make
// it render. The 390 × 844 viewport approximates iPhone 14 — small
// enough to surface the desktop-nav overflow that triggered the
// Header rewrite.
import { expect, test } from '@playwright/test';

test.describe('Mobile viewport — horizontal overflow', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('/about at 390px has no horizontal scroll', async ({ page }) => {
    await page.goto('/about');

    // Assert the document's scrollable width fits inside the viewport
    // width. A 1-px tolerance covers sub-pixel rendering quirks.
    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(scrollWidth - clientWidth).toBeLessThanOrEqual(1);
  });

  test('/about at 390px shows the hamburger trigger and opens the mobile panel', async ({ page }) => {
    await page.goto('/about');

    // Hamburger is visible.
    const trigger = page.getByRole('button', { name: 'Open menu' });
    await expect(trigger).toBeVisible();

    // Tap the trigger and assert the panel (id="mobile-nav") becomes
    // visible with all four nav links inside it. We scope queries to
    // the panel via Playwright's locator chain so we never collide
    // with the (visually hidden) desktop nav anchors.
    await trigger.click();
    const panel = page.locator('#mobile-nav');
    await expect(panel).toBeVisible();
    for (const label of ['Home', 'Deploy', 'Observatory', 'About']) {
      await expect(panel.getByRole('link', { name: label })).toBeVisible();
    }
  });
});
