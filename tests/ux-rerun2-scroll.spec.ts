import { test, expect, devices, type Page } from '@playwright/test';
import { mockApi, mockBoot } from './support/mock-api';

/**
 * R1 (Impeccable re-run 2): a link to another page opens it at its top, so its title is visible; Back returns to where the
 * visitor was. Mocked `/api` and boot block; the phone case emulates a Pixel 7 inside the spec.
 */

const demoSource = { catalog: 'demo' as const };

async function openHome(page: Page) {
  await mockApi(page, 'visitor', demoSource);
  await mockBoot(page, {}, demoSource);
  await page.goto('/');
  await expect(page.locator('header.masthead')).toBeVisible();
  await expect(page.getByTestId('home-episode').first()).toBeVisible();
}

/** Scrolls Home to its bottom and follows the "Ask your decks" card (an owner tool at the end of the page). */
async function followBottomLink(page: Page) {
  const card = page.locator('a[href="/search"]').last();
  await card.scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const before = await page.evaluate(() => window.scrollY);
  expect(before).toBeGreaterThan(200);
  await card.click();
  await expect(page).toHaveURL(/\/search$/);
  return before;
}

for (const viewport of ['desktop', 'phone'] as const) {
  test.describe(viewport, () => {
    if (viewport === 'phone') {
      const { defaultBrowserType: _ignored, ...pixel } = devices['Pixel 7'];
      test.use({ ...pixel });
    }

    test('[R1] a link to another page opens it at the top with its title in view', async ({ page }) => {
      await openHome(page);
      await followBottomLink(page);
      const heading = page.getByRole('heading', { level: 1 });
      await expect(heading).toBeVisible();
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
      const top = await heading.evaluate((el) => el.getBoundingClientRect().top);
      expect(top).toBeGreaterThanOrEqual(0);
      // Focus still moves to the new page's main area (route-change focus is unchanged).
      await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('main');
    });

    test('[R1] Back returns to the previous scroll position', async ({ page }) => {
      await openHome(page);
      const before = await followBottomLink(page);
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
      await page.goBack();
      await expect(page).toHaveURL(/\/$/);
      await expect(page.getByTestId('home-episode').first()).toBeAttached();
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(before / 2);
    });

    test('[R1] a query-only change keeps the scroll position', async ({ page }) => {
      await mockApi(page, 'visitor', demoSource);
      await mockBoot(page, {}, demoSource);
      await page.goto('/video/library');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await page.evaluate(() => {
        document.body.style.minHeight = '4000px';
        window.scrollTo(0, 600);
      });
      const y = await page.evaluate(() => window.scrollY);
      await page.evaluate(() => {
        window.history.pushState({}, '', '/video/library?probe=1');
        window.dispatchEvent(new PopStateEvent('popstate'));
      });
      await page.waitForTimeout(100);
      expect(await page.evaluate(() => window.scrollY)).toBe(y);
    });
  });
}
