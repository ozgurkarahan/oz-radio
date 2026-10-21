import { test, expect, type Page } from '@playwright/test';
import { DEMO_DECK_EN, mockApi, mockBoot } from './support/mock-api';

/**
 * UX re-run 2 — gated pages (R6), touch targets (R10) and the /live name (R13), mocked: no backend.
 * R10 must hold on the production build too (AuthGate's CSS is emitted before components.css there), so run this file
 * against `vite preview` as well as the dev server.
 */

const TAP = 44;

async function open(page: Page, path: string, role: 'visitor' | 'admin' = 'visitor') {
  await mockApi(page, role);
  await mockBoot(page, {});
  await page.goto(path);
}

const GATES: [string, RegExp, string][] = [
  ['/live', /Uploading decks for live presentation is for the site owner/, 'upload your own decks'],
  ['/search', /Search across decks is for the site owner/, 'ask questions across the decks'],
  ['/playlists', /Playlists are for the site owner/, 'build and follow playlists'],
  ['/podcast', /Podcast creation is for the site owner/, 'create podcasts'],
  ['/video', /Video generation is for the site owner/, 'generate avatar videos'],
];

test.describe('R6 — gated owner pages are honest next to the free live demo', () => {
  for (const [route, title, action] of GATES) {
    test(`${route}: "for the site owner", the public actions first, never "demo users" or a sign-in invitation`, async ({ page }) => {
      await open(page, route);
      const panel = page.getByTestId('gated-panel');
      await expect(panel.locator('.gated-panel__title')).toHaveText(title);
      await expect(panel.locator('.eyebrow').first()).toHaveText('Sign-in required');
      await expect(panel.getByTestId('gate-demo-action')).toHaveText('Start the live demo');
      await expect(panel.getByTestId('gate-listen-action')).toBeVisible();
      await expect(panel.locator('.gated-panel__text')).toContainText(/without signing in/);

      const notice = panel.getByTestId('auth-gate');
      await expect(notice).toContainText('Owner tools need sign-in');
      await expect(notice).toContainText(action);
      await expect(notice.getByRole('link', { name: 'Owner sign-in' })).toBeVisible();

      await expect(page.getByText(/demo users/i)).toHaveCount(0);
      await expect(page.getByText(/sign in to (try|upload|create|build|generate|ask|follow)/i)).toHaveCount(0);
      await expect(page.getByText(/try the live avatar/i)).toHaveCount(0);
    });
  }

  test('a playlist player gate says the same', async ({ page }) => {
    await open(page, '/playlists/pl-1');
    await expect(page.getByTestId('gated-panel').locator('.gated-panel__title')).toHaveText('Playlists are for the site owner');
    await expect(page.getByText(/demo users/i)).toHaveCount(0);
  });

  test('the notice keeps its sign-in text link and the panel layout (actions above the notice)', async ({ page }) => {
    await open(page, '/search');
    const panel = page.getByTestId('gated-panel');
    const y = await panel.evaluate((el) => {
      const top = (sel: string) => el.querySelector(sel)!.getBoundingClientRect().top;
      return { actions: top('.gated-panel__actions'), notice: top('[data-testid=auth-gate]') };
    });
    expect(y.actions).toBeLessThan(y.notice);
    await expect(panel.getByRole('button', { name: /sign in/i })).toHaveCount(0);
  });

  test('gate styles do not depend on stylesheet order (same-specificity overrides of .alert / .empty)', async ({ page }) => {
    await open(page, '/search');
    const panel = page.getByTestId('gated-panel');
    const css = await panel.evaluate((el) => {
      const cs = (sel: string) => getComputedStyle(el.querySelector(sel)!);
      return {
        noticeAlign: cs('[data-testid=auth-gate]').alignItems,
        panelMaxWidth: getComputedStyle(el).maxWidth,
        panelBackground: getComputedStyle(el).backgroundColor,
        titleSize: parseFloat(cs('.gated-panel__title').fontSize),
        textMaxWidth: cs('.gated-panel__text').maxWidth,
      };
    });
    expect(css.noticeAlign).toBe('center');
    expect(css.panelMaxWidth).toBe('720px');
    expect(css.panelBackground).not.toBe('rgba(0, 0, 0, 0)');
    expect(css.titleSize, 'clamp(…, 2rem) wins over .empty__title (1.75rem)').toBe(32);
    expect(css.textMaxWidth).toBe('560px');
  });
});

test.describe('R10 — touch targets on a phone', () => {
  test.use({ isMobile: true, hasTouch: true, viewport: { width: 412, height: 839 } });

  test('sign-in "Back to where you were" is at least 44 px tall', async ({ page }) => {
    await open(page, '/sign-in?next=%2Fdecks');
    const back = page.getByTestId('sign-in-back');
    await expect(back).toBeVisible();
    const box = await back.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(TAP);
    await expect(back).toHaveCSS('min-height', `${TAP}px`);
  });

  test('a back link (the deck page) has a 44 px hit area', async ({ page }) => {
    await open(page, `/decks/${DEMO_DECK_EN.id}/present`);
    const link = page.locator('.back-link').first();
    await expect(link).toBeVisible();
    const box = await link.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(TAP);
  });

  test('the owner sign-in link inside a gate is a 44 px target', async ({ page }) => {
    await open(page, '/search');
    const box = await page.getByTestId('auth-gate').getByRole('link', { name: 'Owner sign-in' }).boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(TAP);
  });
});

test.describe('R10 — desktop keeps the compact back link', () => {
  test('a back link stays below 44 px with a mouse', async ({ page }) => {
    await open(page, `/decks/${DEMO_DECK_EN.id}/present`);
    const link = page.locator('.back-link').first();
    await expect(link).toBeVisible();
    const box = await link.boundingBox();
    expect(box!.height).toBeLessThan(TAP);
  });
});

test.describe('R13 — one name for /live: "Present a deck live"', () => {
  test('menu entry, h1 and eyebrow agree, and no "Live presentation" label is left on the page', async ({ page }) => {
    await open(page, '/live', 'admin');
    await expect(page.getByRole('heading', { level: 1, name: 'Present a deck live' })).toBeVisible();
    await expect(page.locator('main .eyebrow').first()).toHaveText('Create · Present live');
    await expect(page.locator('main').getByText('Live presentation')).toHaveCount(0);
  });

  test('the gate page for a visitor uses the same h1 and eyebrow', async ({ page }) => {
    await open(page, '/live');
    await expect(page.getByRole('heading', { level: 1, name: 'Present a deck live' })).toBeVisible();
    await expect(page.locator('.page-header .eyebrow').first()).toHaveText('Create · Present live');
  });
});
