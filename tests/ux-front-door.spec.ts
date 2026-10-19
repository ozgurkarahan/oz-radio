import { test, expect, devices, type Page } from '@playwright/test';
import { DEMO_DECK_EN, MOCKED_MEDIA_REASON, mockApi, mockBoot, mockedMediaUnavailable } from './support/mock-api';
import { BOOT_MARKER } from '../demos/frontend/src/services/boot';
import { demoDeckPath } from '../demos/frontend/src/services/demoProtocol';

/**
 * Front door (WU-A): the static shell while the app downloads, a failed bundle, route crashes and the 404 page,
 * document titles and focus after navigation, layout stability, and the Teams SDK staying out of ordinary visits.
 * Mocked: `/api` answers come from `mockApi`, the boot block from `mockBoot`; nothing needs a backend.
 * The phone check emulates a Pixel 7 inside the spec, so the default `chromium` project runs every test.
 */

const ENTRY_MODULE = '**/src/main.tsx*';
const SHELL_LEAD = 'AI hosts explain slide decks and discuss them as podcasts.';
const FAILED_TEXT = "Oz Radio couldn't load. Check your connection.";
const HOME_TITLE = 'Oz Radio — AI hosts explain slide decks';
const demoSource = { catalog: 'demo' as const };

/** Holds the app's entry module back (a slow network, the tail of a cold start) until `release()` is called. */
async function holdEntryModule(page: Page) {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route(ENTRY_MODULE, async (route) => {
    await held;
    await route.fallback();
  });
  return release;
}

/**
 * Opens a page and returns once its document has been parsed. A deferred module script holds DOMContentLoaded back until it
 * has run, so a page whose entry module is delayed or lost is waited for at `readyState: interactive`.
 */
async function openShell(page: Page, url = '/') {
  await page.goto(url, { waitUntil: 'commit' });
  await page.waitForFunction(() => document.readyState !== 'loading');
}

/** Waits until React has rendered the app (the masthead exists and the static shell is gone). */
async function appRendered(page: Page) {
  await expect(page.locator('header.masthead')).toBeVisible();
  await expect(page.locator('#oz-shell')).toHaveCount(0);
}

const activeElementId = (page: Page) => page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName || '');

/** A client-side navigation without a page load (what a link click ends in). */
const navigateInApp = (page: Page, to: string) => page.evaluate((path) => {
  window.history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}, to);

/** Resolves after `count` animation frames: the new route has painted and every effect and retry of the commit has run. */
const afterFrames = (page: Page, count = 6) => page.evaluate((frames) => new Promise<void>((resolve) => {
  const step = (left: number) => (left === 0 ? resolve() : requestAnimationFrame(() => step(left - 1)));
  step(frames);
}), count);

test.describe('static shell and failed bundle', () => {
  test('[T1-01] the branded shell paints within 1 s of the parsed document while the entry module is delayed, then offers Reload after 10 s', async ({ page }) => {
    await mockApi(page, 'visitor');
    const release = await holdEntryModule(page);
    await page.clock.install();
    try {
      await openShell(page);
      const shell = page.locator('#oz-shell');
      await expect(shell).toBeVisible({ timeout: 1000 });
      await expect(shell.getByRole('heading', { level: 1 })).toHaveText('Opening Oz Radio…');
      await expect(shell).toContainText(SHELL_LEAD);
      await expect(shell.locator('.oz-shell__brand')).toHaveText('Oz Radio');

      // Nothing about slowness yet, and no Reload.
      await expect(page.locator('#oz-shell-note')).toBeEmpty();
      await expect(page.getByRole('button', { name: 'Reload' })).toBeHidden();

      await page.clock.fastForward(10_000);
      await expect(page.locator('#oz-shell-note')).toHaveText('This is taking longer than expected.');
      const reload = page.getByRole('button', { name: 'Reload' });
      await expect(reload).toBeVisible();
      const reloaded = page.waitForRequest((request) => request.isNavigationRequest() && new URL(request.url()).pathname === '/');
      await reload.click();
      await reloaded;
    } finally {
      release();
    }
  });

  test('[T1-01] the shell reserves the masthead height and is replaced by the app without moving the page', async ({ page }) => {
    await mockApi(page, 'visitor');
    await mockBoot(page, {}, demoSource);
    const release = await holdEntryModule(page);
    try {
      await openShell(page);
      await expect(page.locator('#oz-shell')).toBeVisible();
      // The shell is painted, not just in the DOM: a screenshot of it carries far more detail than one of the same page without it.
      // (CDP directly: page.screenshot() waits for document.fonts.ready, which stays pending while the entry module is held.)
      const cdp = await page.context().newCDPSession(page);
      const screenshotBytes = async () => Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64').length;
      const painted = await screenshotBytes();
      const hideShell = await page.addStyleTag({ content: '#oz-shell { visibility: hidden !important; }' });
      const blank = await screenshotBytes();
      expect(painted, `screenshot bytes: shell ${painted}, without it ${blank}`).toBeGreaterThan(blank * 3);
      await hideShell.evaluate((style) => (style as Element).remove());
      const bar = await page.locator('.oz-shell__bar').boundingBox();
      release();
      await appRendered(page);
      const masthead = await page.locator('header.masthead').boundingBox();
      expect(bar && masthead).toBeTruthy();
      expect(Math.abs(masthead!.height - bar!.height)).toBeLessThanOrEqual(1);
      expect(masthead!.y).toBe(bar!.y);
    } finally {
      release();
    }
  });

  test('the shell uses system fonts only and does not animate when the visitor prefers reduced motion', async ({ page }) => {
    await mockApi(page, 'visitor');
    const release = await holdEntryModule(page);
    try {
      const inspect = () => page.evaluate(() => ({
        animation: getComputedStyle(document.querySelector('.oz-shell__wave i')!).animationName,
        fonts: ['.oz-shell__brand', '.oz-shell__title', '.oz-shell__lead']
          .map((selector) => getComputedStyle(document.querySelector(selector)!).fontFamily),
      }));
      await openShell(page);
      const motion = await inspect();
      expect(motion.animation).not.toBe('none');
      for (const family of motion.fonts) expect(family).not.toMatch(/Newsreader|Hanken/);

      await page.emulateMedia({ reducedMotion: 'reduce' });
      expect((await inspect()).animation).toBe('none');
    } finally {
      release();
    }
  });

  test('[T1-02] an entry module that fails to load shows the failure at once, with Reload and the description', async ({ page }) => {
    await mockApi(page, 'visitor');
    await page.route(ENTRY_MODULE, (route) => route.abort('connectionreset'));
    await openShell(page);
    const shell = page.locator('#oz-shell');
    await expect(shell.getByRole('alert')).toHaveText(FAILED_TEXT, { timeout: 2000 });
    await expect(shell).toHaveAttribute('data-state', 'failed');
    await expect(shell.getByRole('heading', { level: 1 })).toBeHidden();
    await expect(shell).toContainText(SHELL_LEAD);
    const reload = shell.getByRole('button', { name: 'Reload' });
    await expect(reload).toBeVisible();

    const reloaded = page.waitForRequest((request) => request.isNavigationRequest() && new URL(request.url()).pathname === '/');
    await reload.click();
    await reloaded;
    await expect(page.locator('#oz-shell').getByRole('alert')).toHaveText(FAILED_TEXT, { timeout: 2000 });
  });

  test('[T1-02] without JavaScript the page describes the site and says JavaScript is required', async ({ browser, baseURL }) => {
    const context = await browser.newContext({ javaScriptEnabled: false, baseURL });
    try {
      const page = await context.newPage();
      await page.goto('/');
      const body = page.locator('#root');
      await expect(body).toContainText('Oz Radio is a site where AI hosts explain slide decks and discuss documents as podcasts', { useInnerText: true });
      await expect(body).toContainText('JavaScript is required', { useInnerText: true });
      await expect(body).not.toContainText('Opening Oz Radio', { useInnerText: true });
      await expect(page.getByRole('button', { name: 'Reload' })).toBeHidden();
    } finally {
      await context.close();
    }
  });

  test('the served HTML has exactly one boot marker, in the head before the module script, and the shell inside #root', async ({ request }) => {
    for (const url of ['/', '/decks/deck-live/present', '/index.html']) {
      const html = await (await request.get(url)).text();
      const marker = html.indexOf(BOOT_MARKER);
      expect(html.split(BOOT_MARKER).length - 1, url).toBe(1);
      expect(marker, url).toBeGreaterThan(html.indexOf('<head'));
      expect(marker, url).toBeLessThan(html.indexOf('</head>'));
      expect(marker, url).toBeLessThan(html.search(/<script[^>]*type="module"[^>]*src="\/src\/main\.tsx"/));
      expect(html, url).toMatch(/<div id="root">\s*<div id="oz-shell"/);
      expect(html, url).toContain('<noscript>');
      expect(html, url).toContain(`<title>${HOME_TITLE}</title>`);
    }
  });
});

test.describe('crashes and unknown routes', () => {
  test('[T1-08] a page that crashes on a malformed payload is caught by the route boundary and the navigation stays', async ({ page }) => {
    await mockApi(page, 'admin', demoSource);
    await mockBoot(page, {}, demoSource);
    // A playlist whose title is not a string: the page cannot render it.
    await page.route('**/api/playlists/pl-1', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ playlist_id: 'pl-1', title: { text: 'unexpected shape' }, description: '', steps: [] }),
    }));
    await page.goto('/playlists/pl-1');

    const panel = page.getByTestId('route-crash');
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute('role', 'alert');
    const heading = panel.getByRole('heading', { level: 1, name: 'Something went wrong on this page' });
    await expect(heading).toBeFocused();
    await expect(panel).toContainText('The rest of Oz Radio still works');
    await expect(panel.getByRole('button', { name: 'Reload' })).toBeVisible();
    await expect(panel.getByRole('link', { name: 'Home' })).toHaveAttribute('href', '/');
    await expect(panel.getByRole('link', { name: 'Listen to an episode' })).toHaveAttribute('href', '/podcast/library');
    await expect(panel.getByRole('link', { name: 'Start the live demo' })).toHaveAttribute('href', demoDeckPath(DEMO_DECK_EN.deck_id));
    // The masthead is outside the boundary: it still works.
    await expect(page.locator('header.masthead')).toBeVisible();
    await expect(page.getByTestId('app-crash')).toHaveCount(0);

    await panel.getByRole('link', { name: 'Home' }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId('route-crash')).toHaveCount(0);
    await expect(page.locator('#main h1').first()).toBeVisible();
  });

  test('a page chunk that cannot be downloaded shows the same panel with a connection hint', async ({ page }) => {
    await mockApi(page, 'visitor');
    await page.route('**/src/pages/DecksPage.tsx*', (route) => route.abort('connectionreset'));
    await page.goto('/decks');
    const panel = page.getByTestId('route-crash');
    await expect(panel.getByRole('heading', { name: 'Something went wrong on this page' })).toBeFocused();
    await expect(panel).toContainText('This page could not be downloaded. Check your connection, then reload.');
    await expect(panel).toContainText('The rest of Oz Radio still works');
    await expect(panel.getByRole('button', { name: 'Reload' })).toBeVisible();
    await expect(page.locator('header.masthead')).toBeVisible();
  });

  test('[T1-08b] a crash outside the route boundary shows the brand, a message, Reload and Home instead of a blank page', async ({ page }) => {
    await mockApi(page, 'visitor', demoSource);
    await mockBoot(page, {}, demoSource);
    await page.goto('/');
    await appRendered(page);

    // The global 401/403 banner (outside the route boundary) renders an error detail it cannot read: a real DOM event, no hook.
    const crash = page.getByTestId('app-crash');
    await expect(async () => {
      await page.evaluate(() => {
        const detail = { url: '/api/x', get status(): number { throw new Error('malformed auth error detail'); } };
        window.dispatchEvent(new CustomEvent('app:auth-error', { detail }));
      });
      await expect(crash).toBeVisible({ timeout: 500 });
    }).toPass({ timeout: 10_000 });

    await expect(crash).toHaveAttribute('role', 'alert');
    await expect(crash.getByText('Oz Radio', { exact: true })).toBeVisible();
    const heading = crash.getByRole('heading', { level: 1, name: 'Something went wrong' });
    await expect(heading).toBeFocused();
    await expect(crash.getByRole('button', { name: 'Reload' })).toBeVisible();
    const home = crash.getByRole('link', { name: 'Home' });
    await expect(home).toHaveAttribute('href', '/');
    await expect(page.locator('header.masthead')).toHaveCount(0);

    await home.click();
    await expect(page.locator('header.masthead')).toBeVisible();
    await expect(page.getByTestId('app-crash')).toHaveCount(0);
  });

  test('[T1-09] an unknown route says "Page not found" (heading and title), focuses the heading and offers the public ways in', async ({ page }) => {
    await mockApi(page, 'visitor', demoSource);
    await mockBoot(page, {}, demoSource);
    await page.goto('/oz-radio/');

    const heading = page.getByRole('heading', { level: 1, name: 'Page not found' });
    await expect(heading).toBeVisible();
    await expect(heading).toBeFocused();
    await expect(page).toHaveTitle('Page not found · Oz Radio');
    const notFound = page.getByTestId('not-found');
    await expect(notFound.getByRole('link', { name: 'Home' })).toHaveAttribute('href', '/');
    await expect(notFound.getByRole('link', { name: 'Start the live demo' })).toHaveAttribute('href', demoDeckPath(DEMO_DECK_EN.deck_id));
    await expect(notFound.getByRole('link', { name: 'Listen to an episode' })).toHaveAttribute('href', '/podcast/library');
    await expect(notFound.getByRole('link', { name: 'Browse decks' })).toHaveAttribute('href', '/decks');
    await expect(page.locator('header.masthead')).toBeVisible();

    await notFound.getByRole('link', { name: 'Home' }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page).toHaveTitle(HOME_TITLE);
  });

  test('[T1-09] without a boot block "Start the live demo" falls back to the decks', async ({ page }) => {
    await mockApi(page, 'visitor');
    await mockBoot(page, 'absent');
    await page.goto('/no-such-page');
    await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeFocused();
    await expect(page.getByTestId('not-found').getByRole('link', { name: 'Start the live demo' })).toHaveAttribute('href', '/decks');
  });

  test('an explicit /index.html opens Home', async ({ page }) => {
    await mockApi(page, 'visitor');
    await page.goto('/index.html');
    await expect(page).toHaveURL(/\/$/);
    await expect(page).toHaveTitle(HOME_TITLE);
    await expect(page.getByTestId('not-found')).toHaveCount(0);
    expect(await activeElementId(page)).toBe('BODY');
  });
});

test.describe('titles, focus and page chunks', () => {
  test('every route has its own document title, set once per navigation', async ({ page }) => {
    await mockApi(page, 'visitor', demoSource);
    await mockBoot(page, {}, demoSource);
    const expectedTitles: [string, string | RegExp][] = [
      ['/decks', 'Decks · Oz Radio'],
      ['/podcast/library', 'Podcasts · Oz Radio'],
      ['/video/library', 'Videos · Oz Radio'],
      ['/search', 'Search · Oz Radio'],
      ['/playlists', 'Playlists · Oz Radio'],
      ['/live', 'Live presentation · Oz Radio'],
      ['/podcast', 'Create a podcast · Oz Radio'],
      ['/video', 'Create a video · Oz Radio'],
      ['/playlists/pl-1', 'Playlist · Oz Radio'],
      // The deck page refines its title once the deck is loaded (WU-D); the route sets the generic one first.
      ['/decks/deck-demo-en/present', /Live demo · Oz Radio$/],
    ];
    await page.goto('/');
    await appRendered(page);
    await expect(page).toHaveTitle(HOME_TITLE);

    // Client-side navigation: the title follows the pathname without a page load.
    for (const [path, title] of expectedTitles) {
      await navigateInApp(page, path);
      await expect(page, path).toHaveTitle(title);
    }
    await navigateInApp(page, '/');
    await expect(page).toHaveTitle(HOME_TITLE);

    // A first load gets the same title (no navigation happened).
    await page.goto('/video/library');
    await expect(page).toHaveTitle('Videos · Oz Radio');
  });

  test('focus moves to #main after a navigation only when it is outside #main, and never on the first load', async ({ page }) => {
    await mockApi(page, 'visitor', demoSource);
    await mockBoot(page, {}, demoSource);
    await page.goto('/');
    await appRendered(page);
    expect(await activeElementId(page)).toBe('BODY');

    // A masthead link (outside #main) → focus lands on #main once the new route has committed.
    await page.locator('header.masthead a[href="/decks"]').first().click();
    await expect(page).toHaveTitle('Decks · Oz Radio');
    await expect.poll(() => activeElementId(page)).toBe('main');

    // A page that focuses one of its own controls keeps it: the 404 page focuses its heading.
    await navigateInApp(page, '/no-such-page');
    await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeFocused();

    // Back to a normal page: focus is outside #main again (the heading is gone) → #main.
    await page.locator('header.masthead a[href="/"]').first().click();
    await expect(page).toHaveTitle(HOME_TITLE);
    await expect.poll(() => activeElementId(page)).toBe('main');

    // A first load of a lazily loaded route does not move focus either.
    await page.goto('/decks');
    await expect(page).toHaveTitle('Decks · Oz Radio');
    await expect(page.locator('#main > *').first()).toBeVisible();
    expect(await activeElementId(page)).toBe('BODY');
  });

  test('focus stays put when the pathname is unchanged, and while a dialog or the mini-player holds it', async ({ page }) => {
    await mockApi(page, 'visitor', demoSource);
    await mockBoot(page, {}, demoSource);
    await page.goto('/decks');
    await expect(page).toHaveTitle('Decks · Oz Radio');
    await expect(page.locator('#main > *').first()).toBeVisible();

    const mastheadLink = page.locator('header.masthead a[href="/"]').first();
    const inMasthead = () => page.evaluate(() => !!document.activeElement?.closest('header.masthead'));

    // A search, hash or state-only navigation (`?episode=…&mode=…`, `?video=…`) keeps the pathname: nothing moves.
    await mastheadLink.focus();
    for (const to of ['/decks?utm=1', '/decks?utm=1#section', '/decks#section']) {
      await navigateInApp(page, to);
      await afterFrames(page);
      expect(await inMasthead(), to).toBe(true);
    }

    // Stand-ins for the owners of focus, appended next to the app (no production hook): the mini-player, a dialog that
    // has focus inside it, and a modal that is open while focus is on the page itself.
    const claim = (kind: 'mini-player' | 'dialog' | 'modal') => page.evaluate((what) => {
      const host = document.createElement('div');
      host.id = 'focus-claim';
      if (what === 'mini-player') host.className = 'mini-player';
      else host.setAttribute(what === 'dialog' ? 'role' : 'aria-modal', what === 'dialog' ? 'dialog' : 'true');
      const button = document.createElement('button');
      button.id = 'claim-button';
      button.textContent = 'Claim';
      host.append(button);
      document.body.append(host);
      if (what === 'modal') (document.activeElement as HTMLElement | null)?.blur();
      else button.focus();
    }, kind);
    const release = () => page.evaluate(() => document.getElementById('focus-claim')?.remove());

    const cases: [kind: 'mini-player' | 'dialog' | 'modal', to: string, held: string][] = [
      ['mini-player', '/', 'claim-button'],
      ['dialog', '/decks', 'claim-button'],
      ['modal', '/', 'BODY'],
    ];
    for (const [kind, to, held] of cases) {
      await claim(kind);
      await navigateInApp(page, to);
      await expect(page).toHaveTitle(to === '/' ? HOME_TITLE : 'Decks · Oz Radio');
      await afterFrames(page);
      expect(await activeElementId(page), `${kind} → ${to}`).toBe(held);
      await release();
    }

    // Control: with nobody holding focus the same navigation still moves it to #main (the checks above are not vacuous).
    await mastheadLink.focus();
    await navigateInApp(page, '/decks');
    await expect.poll(() => activeElementId(page)).toBe('main');
  });

  test.describe('opening the Listen sheet from the mini-player', () => {
    test.skip(mockedMediaUnavailable, MOCKED_MEDIA_REASON);
    test.describe.configure({ timeout: 90_000 });

    test('does not move focus to #main, and Minimise puts it back on the mini-player', async ({ page }) => {
      const media = { timeout: 15_000 };
      await mockApi(page, 'visitor', { podcastV2: true });
      await page.goto('/podcast/library');
      const dialog = page.getByRole('dialog');
      const mini = page.getByTestId('mini-player');
      const openNowPlaying = mini.getByRole('button', { name: 'Open now playing: Agents on air' });

      await page.getByTestId('library-item').filter({ hasText: 'Agents on air' })
        .getByRole('button', { name: 'Listen to Agents on air' }).click();
      await expect(dialog.getByTestId('radio-player')).toHaveAttribute('data-state', 'playing', media);
      await page.keyboard.press('Escape');
      await expect(mini).toBeVisible(media);
      await page.getByRole('link', { name: 'Oz Radio home' }).click();
      await expect(page).toHaveURL(/\/$/);
      await expect(openNowPlaying).toBeVisible(media);
      // The masthead link was outside #main: after an ordinary navigation the new route gets the focus.
      await expect.poll(() => activeElementId(page)).toBe('main');

      // From here on, count every focus that lands on #main.
      await page.evaluate(() => {
        const counter = window as unknown as { mainFocused: number };
        counter.mainFocused = 0;
        document.addEventListener('focusin', (event) => {
          if ((event.target as Element | null)?.id === 'main') counter.mainFocused += 1;
        }, true);
      });

      // Home → the sheet: the pathname changes while the mini-player's button holds focus.
      await openNowPlaying.click();
      await expect(page).toHaveURL(/\/podcast\/library\?episode=pod-2&mode=listen$/);
      await expect(dialog.getByTestId('radio-player')).toHaveAttribute('data-state', 'playing', media);
      await afterFrames(page, 8);
      expect(await page.evaluate(() => (window as unknown as { mainFocused: number }).mainFocused)).toBe(0);

      // The sheet → Home: its opener was the mini-player, so focus returns there and stays.
      await dialog.getByRole('button', { name: 'Minimise player' }).click();
      await expect(page).toHaveURL(/\/$/);
      await expect(dialog).toHaveCount(0);
      await expect(openNowPlaying).toBeFocused(media);
      await afterFrames(page, 8);
      await expect(openNowPlaying).toBeFocused();
      expect(await page.evaluate(() => (window as unknown as { mainFocused: number }).mainFocused)).toBe(0);
    });
  });

  test('a lazily loaded page shows a fallback that keeps the height of the main area', async ({ page }) => {
    await mockApi(page, 'visitor', demoSource);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route('**/src/pages/DecksPage.tsx*', async (route) => {
      await held;
      await route.fallback();
    });
    try {
      await page.goto('/decks');
      const fallback = page.getByTestId('route-fallback');
      await expect(fallback).toBeVisible();
      await expect(page.locator('header.masthead')).toBeVisible();
      const viewport = page.viewportSize()!;
      const box = (await fallback.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(viewport.height * 0.59);
      // The main area itself fills the space under the masthead.
      const main = (await page.locator('#main').boundingBox())!;
      expect(main.y + main.height).toBeGreaterThanOrEqual(viewport.height - 1);
      release();
      await expect(fallback).toHaveCount(0);
      await expect(page.getByTestId('route-crash')).toHaveCount(0);
    } finally {
      release();
    }
  });

  test('Home does not download the other pages, and showing intent on a link starts its chunk', async ({ page }) => {
    await mockApi(page, 'visitor', demoSource);
    await mockBoot(page, {}, demoSource);
    const pageModules: string[] = [];
    page.on('request', (request) => {
      const match = new URL(request.url()).pathname.match(/\/src\/pages\/(\w+)\.tsx$/);
      if (match) pageModules.push(match[1]);
    });
    await page.goto('/');
    await appRendered(page);
    await page.waitForLoadState('networkidle');
    for (const lazyPage of ['DecksPage', 'DeckPresentPage', 'VideoLibraryPage', 'LivePage', 'SearchPage', 'PlaylistsPage', 'PlaylistPlayerPage', 'PodcastPage', 'VideoPage']) {
      expect(pageModules, `${lazyPage} must not load with Home`).not.toContain(lazyPage);
    }

    const requested = page.waitForRequest((request) => /\/src\/pages\/DecksPage\.tsx/.test(request.url()));
    await page.locator('header.masthead a[href="/decks"]').first().hover();
    await requested;
  });
});

test.describe('Home before the API answers', () => {
  test('[C1.2] Home shows its final live-demo CTA from the boot block while no list request has been answered', async ({ page }) => {
    const hang = 120_000;
    await mockApi(page, 'visitor', { ...demoSource, delayMs: { me: hang, demoConfig: hang, decks: hang, podcast: hang, video: hang } });
    await mockBoot(page, {}, demoSource);
    const answered: string[] = [];
    page.on('response', (response) => {
      const { pathname } = new URL(response.url());
      if (pathname.startsWith('/api/') && pathname !== '/api/avatars') answered.push(pathname);
    });
    await page.goto('/');
    const cta = page.getByTestId('home-try-live-demo');
    await expect(cta).toBeVisible({ timeout: 3000 });
    await expect(cta).toHaveAttribute('href', demoDeckPath(DEMO_DECK_EN.deck_id));
    await expect(cta).toBeEnabled();
    expect(answered, 'no /api answer yet: the CTA comes from the boot block').toEqual([]);
  });
});

test.describe('layout stability on a phone', () => {
  const { defaultBrowserType: _browser, ...pixel7 } = devices['Pixel 7'];
  test.use({ ...pixel7 });

  test('CLS stays within 0.1 on Home when the web fonts arrive after the first paint', async ({ page }) => {
    await mockApi(page, 'visitor', demoSource);
    await mockBoot(page, {}, demoSource);
    await page.addInitScript(() => {
      const w = window as unknown as { __shifts: { t: number; v: number }[] };
      w.__shifts = [];
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as unknown as { hadRecentInput: boolean; startTime: number; value: number }[]) {
          if (!entry.hadRecentInput) w.__shifts.push({ t: entry.startTime, v: entry.value });
        }
      }).observe({ type: 'layout-shift', buffered: true });
    });
    // The fonts come late (a slow link): the page paints with the fallback faces first, then swaps.
    await page.route('**/*.woff2', async (route) => {
      await new Promise((resolve) => { setTimeout(resolve, 1500); });
      await route.continue();
    });
    await page.goto('/');
    await appRendered(page);
    await expect(page.locator('#main h1').first()).toBeVisible();
    await page.waitForFunction(() => document.fonts.check('44px "Newsreader Variable"') && document.fonts.check('16px "Hanken Grotesk Variable"'), null, { timeout: 20_000 });
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(600);

    const { shifts, fonts, firstPaint } = await page.evaluate(() => ({
      shifts: (window as unknown as { __shifts: { t: number; v: number }[] }).__shifts,
      fonts: (performance.getEntriesByType('resource') as PerformanceResourceTiming[]).filter((r) => r.name.endsWith('.woff2')).map((r) => r.responseEnd),
      firstPaint: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? 0,
    }));
    // The test is only meaningful when the swap really happened after the first paint.
    expect(fonts.length).toBeGreaterThan(0);
    expect(Math.min(...fonts)).toBeGreaterThan(firstPaint);

    // web.dev CLS: the largest window of shifts less than 1 s apart, 5 s long at most.
    let worst = 0;
    let windowValue = 0;
    let windowStart = 0;
    let previous = 0;
    for (const { t, v } of shifts) {
      if (windowValue === 0 || t - previous > 1000 || t - windowStart > 5000) { windowValue = 0; windowStart = t; }
      windowValue += v;
      previous = t;
      worst = Math.max(worst, windowValue);
    }
    const total = shifts.reduce((sum, s) => sum + s.v, 0);
    const summary = `window ${worst.toFixed(4)}, sum ${total.toFixed(4)}, ${shifts.length} shifts`;
    console.log(`[CLS] Pixel 7, fonts after first paint: ${summary}`);
    test.info().annotations.push({ type: 'cls', description: summary });
    expect(worst, `layout shifts: ${JSON.stringify(shifts)}`).toBeLessThanOrEqual(0.1);
  });

  test('the fallback faces give the Home title the same height as the web font at the Pixel 7 width', async ({ page }) => {
    await mockApi(page, 'visitor', demoSource);
    await mockBoot(page, {}, demoSource);
    await page.goto('/');
    await appRendered(page);
    const title = page.locator('#main h1').first();
    await expect(title).toBeVisible();
    await page.evaluate(() => document.fonts.ready);

    // The fallback faces are local fonts: without Georgia (a Linux runner) there is nothing to compare.
    const fallbackLoaded = await page.evaluate(async () => {
      const faces = [...document.fonts].filter((face) => face.family.includes('Newsreader Fallback'));
      await Promise.allSettled(faces.map((face) => face.load()));
      return faces.length > 0 && faces.every((face) => face.status === 'loaded');
    });
    test.skip(!fallbackLoaded, 'Georgia is not installed on this machine, so the Newsreader fallback face has no local font to adjust');

    const heights = async (width: number) => {
      await page.setViewportSize({ width, height: 915 });
      return title.evaluate((h1: HTMLElement) => {
        const web = h1.getBoundingClientRect().height;
        const original = h1.style.fontFamily;
        h1.style.fontFamily = "'Newsreader Fallback'";
        const fallback = h1.getBoundingClientRect().height;
        h1.style.fontFamily = original;
        return { web, fallback };
      });
    };
    // Other common phone widths are reported, not asserted: a line more or less there is a real, smaller shift.
    const others: string[] = [];
    for (const width of [360, 390, 430]) {
      const { web, fallback } = await heights(width);
      others.push(`${width}px: web ${web.toFixed(1)} fallback ${fallback.toFixed(1)}`);
    }
    console.log(`[title height] ${others.join(' · ')}`);
    test.info().annotations.push({ type: 'title-height', description: others.join(' · ') });
    const pixel7 = await heights(412);
    expect(Math.abs(pixel7.fallback - pixel7.web), `title height at 412px: ${JSON.stringify(pixel7)}`).toBeLessThanOrEqual(1);
  });
});

test.describe('the Teams SDK stays out of ordinary visits', () => {
  const OFFICE_CDN = /res\.cdn\.office\.net/;
  const SDK_REQUEST = /teams-js|teams_js|res\.cdn\.office\.net/i;
  const APP_ORIGIN = 'https://oz-radio.example.test';

  /**
   * Serves the app under a public-looking origin, proxied to the dev server: Chromium refuses to let a public page frame
   * 127.0.0.1 (local network access checks), and the page that frames the app has to be a "Teams" origin.
   * `/api`, `/media` and `/static` fall through to the mocks.
   */
  async function serveAppAt(page: Page, devServer: string) {
    await page.route(`${APP_ORIGIN}/**`, async (route) => {
      const url = new URL(route.request().url());
      if (/^\/(api|media|static)\//.test(url.pathname)) return route.fallback();
      const upstream = await route.fetch({ url: `${devServer}${url.pathname}${url.search}` });
      const headers = { ...upstream.headers() };
      for (const name of ['content-length', 'content-encoding', 'transfer-encoding']) delete headers[name];
      return route.fulfill({ status: upstream.status(), headers, body: await upstream.body() });
    });
  }

  /** A page at `hostOrigin` that frames the app: the app sees that origin as its parent. */
  async function frameAppFrom(page: Page, hostOrigin: string) {
    await page.route(`${hostOrigin}/**`, (route) => route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: `<!doctype html><title>host</title><iframe src="${APP_ORIGIN}/" style="width:1000px;height:700px;border:0"></iframe>`,
    }));
  }

  test('no request reaches the Teams CDN and the SDK is not loaded, on Home or on a page that detects Teams', async ({ page }) => {
    await mockApi(page, 'visitor', demoSource);
    await mockBoot(page, {}, demoSource);
    const seen: string[] = [];
    page.on('request', (request) => { if (SDK_REQUEST.test(request.url())) seen.push(request.url()); });
    await page.route(OFFICE_CDN, (route) => route.abort());
    await page.goto('/');
    await appRendered(page);
    await page.waitForLoadState('networkidle');
    // The live-presentation page also asks whether it runs inside Teams.
    await page.goto('/live');
    await expect(page.locator('#main')).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(seen).toEqual([]);
  });

  test('a frame under a site that is not a Teams host does not load the SDK either', async ({ page, baseURL }) => {
    await mockApi(page, 'visitor', demoSource);
    const seen: string[] = [];
    page.on('request', (request) => { if (SDK_REQUEST.test(request.url())) seen.push(request.url()); });
    await page.route(OFFICE_CDN, (route) => route.abort());
    await serveAppAt(page, baseURL!);
    await frameAppFrom(page, 'https://portal.example.test');
    await page.goto('https://portal.example.test/host');
    await expect(page.frameLocator('iframe').locator('header.masthead')).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(seen).toEqual([]);
  });

  test('inside a Teams host frame the SDK is loaded and the Office CDN is asked for its valid origins', async ({ page, baseURL }) => {
    await mockApi(page, 'visitor', demoSource);
    const cdn: string[] = [];
    await page.route(OFFICE_CDN, (route) => {
      cdn.push(route.request().url());
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({ validOrigins: ['teams.microsoft.com'] }),
      });
    });
    await serveAppAt(page, baseURL!);
    await frameAppFrom(page, 'https://teams.microsoft.com');
    await page.goto('https://teams.microsoft.com/host');
    await expect(page.frameLocator('iframe').locator('header.masthead')).toBeVisible();
    await expect.poll(() => cdn.length, { timeout: 15_000 }).toBeGreaterThan(0);
    expect(cdn[0]).toContain('validDomains');
  });
});
