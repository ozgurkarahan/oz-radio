import { test, expect as baseExpect, devices, type Page } from '@playwright/test';
import { mockApi, mockBoot, type MockApiOptions, type Role } from './support/mock-api';

const expect = baseExpect.configure({ timeout: 15_000 });
test.describe.configure({ timeout: 90_000 });

/** Impeccable re-review: Home rows, owner tool names, status separators and touch targets. */
async function open(page: Page, path = '/', opts: MockApiOptions & { role?: Role } = {}) {
  const { role = 'visitor', ...api } = opts;
  await mockApi(page, role, api);
  await mockBoot(page, {}, api);
  await page.goto(path);
}

test.describe('Home rows', () => {
  test('[S1] a video row opens that video, not the generic library', async ({ page }) => {
    await open(page, '/', { catalog: 'demo' });
    const rows = page.getByTestId('home-episode');
    await expect(rows.first()).toBeVisible();
    const videoRows = rows.filter({ has: page.locator('.episode-row__kind', { hasText: 'Narrated video' }) });
    expect(await videoRows.count()).toBeGreaterThan(0);
    for (const row of await videoRows.all()) {
      const hrefs = await row.locator('a').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
      for (const href of hrefs) expect(href).toMatch(/^\/video\/library\?video=[^&]+$/);
    }
  });

  test('[S8] recordings are never titled "Live demo"; deck rows keep their title', async ({ page }) => {
    await open(page, '/', { catalog: 'demo' });
    const rows = page.getByTestId('home-episode');
    await expect(rows.first()).toBeVisible();
    const recordings = rows.filter({ hasNot: page.locator('.episode-row__kind', { hasText: /Slides|Live presentation/ }) });
    const titles = await recordings.locator('.episode-row__title').allTextContents();
    expect(titles.length).toBeGreaterThan(0);
    for (const t of titles) expect(t).not.toMatch(/live demo|démo en direct/i);
    expect(titles.some((t) => /Demo recording|Démo enregistrée/.test(t))).toBe(true);
  });

  test('[S11] the aside is honest about the list: "Latest 6 of N" (decks, videos and podcasts), never a bare episode count', async ({ page }) => {
    await open(page, '/', { catalog: 'demo' });
    const rows = page.getByTestId('home-episode');
    await expect(rows.first()).toBeVisible();
    const total = await page.evaluate(async () => {
      const lists = await Promise.all(['/api/decks', '/api/video/library', '/api/podcast/library'].map((u) => fetch(u).then((r) => r.json())));
      return lists.reduce((n, l) => n + (Array.isArray(l) ? l : l.items ?? []).length, 0);
    });
    expect(total).toBeGreaterThan(6);
    await expect(rows).toHaveCount(6);
    await expect(page.locator('.section-head').filter({ has: page.locator('#home-episodes') }).locator('.eyebrow'))
      .toHaveText(`Latest 6 of ${total}`);
  });

  test('[S14] one tab stop per row: the play button is hidden from the keyboard and screen readers', async ({ page }) => {
    await open(page, '/', { catalog: 'demo' });
    const rows = page.getByTestId('home-episode');
    await expect(rows.first()).toBeVisible();
    for (const row of await rows.all()) {
      await expect(row.locator('a:not([aria-hidden])')).toHaveCount(1);
      await expect(row.locator('a[aria-hidden]')).toHaveAttribute('tabindex', '-1');
    }
  });

  test('[S14] the hosts group has a role and the status line has no text separator element', async ({ page }) => {
    await open(page, '/', { catalog: 'demo' });
    await expect(page.locator('.home-hosts')).toHaveAttribute('role', 'group');
    const status = page.locator('.home-hero__status');
    await expect(status).toBeVisible();
    const sep = await status.evaluate((el) => Array.from(el.querySelectorAll('span')).map((s) => getComputedStyle(s, '::before').content));
    for (const content of sep) expect(['none', 'normal']).toContain(content);
    expect(await status.evaluate((el) => (el.textContent ?? '').trim().startsWith('·'))).toBe(false);
  });
});

test.describe('owner tool names', () => {
  test('[S9] creation tools read as creation tools and stay grouped under Owner tools', async ({ page }) => {
    await open(page);
    const main = page.locator('nav[aria-label="Main"]');
    await main.getByRole('button', { name: /^Owner tools/ }).click();
    const list = main.getByRole('list', { name: 'Owner tools' });
    await expect(list.getByRole('link')).toHaveText([
      /Playlists/, /Search/, /Present a deck live/, /Create a narrated video/, /Create a podcast/,
    ]);
    for (const wrong of ['Narrated video', 'Two-host podcast']) {
      await expect(list.getByRole('link', { name: new RegExp(`^${wrong}`) })).toHaveCount(0);
    }
  });
});

test.describe('phone', () => {
  const { defaultBrowserType: _ignored, ...PIXEL_7 } = devices['Pixel 7'];
  test.use({ ...PIXEL_7, isMobile: true, hasTouch: true });

  test('[S9] the menu sheet folds the owner tools behind one disclosure', async ({ page }) => {
    await open(page);
    await page.getByRole('button', { name: 'Open menu' }).click();
    const tools = page.locator('#site-sheet').getByRole('navigation', { name: 'Owner tools' });
    const toggle = tools.getByRole('button', { name: 'Owner tools' });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(tools.getByRole('link')).toHaveCount(0);
    expect((await toggle.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await toggle.click();
    await expect(tools.getByRole('link')).toHaveText([
      /Playlists/, /Search/, /Present a deck live/, /Create a narrated video/, /Create a podcast/,
    ]);
  });

  test('[S14] the gate notice\'s "Owner sign-in" link has a 44 px hit area on touch screens', async ({ page }) => {
    await open(page, '/playlists');
    const link = page.locator('.gate-notice').getByRole('link', { name: 'Owner sign-in' });
    await expect(link).toBeVisible();
    expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  });
});
