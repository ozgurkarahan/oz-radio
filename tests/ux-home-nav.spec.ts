import { test, expect as baseExpect, devices, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {
  DEMO_QA_CONFIG, calls, mockApi, mockBoot, type ApiFailure, type BootMode, type MockApiOptions, type Role,
} from './support/mock-api';

// The shared dev server and the machine are busy during the fleet run: a cold module graph can take seconds to paint.
const expect = baseExpect.configure({ timeout: 15_000 });
test.describe.configure({ timeout: 90_000 });

/**
 * WU-C — Home, navigation and gate pages for the first-time anonymous visitor (UX-fix run, contracts v1.2).
 *
 *   [T1-03]  the live-demo CTA is final at the first paint (boot block) and never changes afterwards
 *   [T1-04] [T1-05] [T1-07a] [T1-07b]  failed ≠ empty: friendly cause, "Try again", the public actions stay
 *   [T1-10a…e] [T1-12] [T1-13]  gate pages: honest cause, public primary actions, "Owner sign-in" as a text link
 *   [T1-13]  "Owner sign-in" opens the in-app explainer (/sign-in): the public actions first, then "Continue to Microsoft sign-in"
 *   [T1-11]  owner tools are grouped and marked "Sign-in required"
 *   [T3-01] [T3-03]  demo off / allowance spent → "Watch a recorded demo"; N left → status beside the unchanged CTA
 *   P1-3 / P2-4 / P2-5  the modal phone sheet, the sticky masthead and the Create disclosure (keyboard)
 *
 * Everything runs against the mocked API (no backend); `mockBoot` plays the server's boot block.
 */

type Opts = MockApiOptions & { role?: Role; boot?: BootMode };

/** Mocks the API (and the boot block when `boot` is given). Call before `page.goto`. */
async function setup(page: Page, opts: Opts = {}) {
  const { role = 'visitor', boot, ...api } = opts;
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const mock = await mockApi(page, role, api);
  const bootMock = boot === undefined ? null : await mockBoot(page, boot, api);
  return { api: mock, boot: bootMock, errors };
}

async function open(page: Page, path = '/', opts: Opts = {}) {
  const ctx = await setup(page, opts);
  await page.goto(path);
  return ctx;
}

interface HeroItem { text: string; href: string | null; testid: string | null }

/** Records the hero's CTAs after every DOM mutation, from the very first render: label, target and test id. */
async function watchHero(page: Page) {
  await page.addInitScript(() => {
    const log: HeroItem[][] = [];
    (window as unknown as { __heroLog: HeroItem[][] }).__heroLog = log;
    const snapshot = () => {
      const box = document.querySelector('.home-hero__ctas');
      if (!box) return;
      const items = Array.from(box.children).map((el) => ({
        text: (el.textContent ?? '').trim(),
        href: el.getAttribute('href'),
        testid: el.getAttribute('data-testid'),
      }));
      if (JSON.stringify(log[log.length - 1]) !== JSON.stringify(items)) log.push(items);
    };
    new MutationObserver(snapshot).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  });
}

const heroLog = (page: Page) => page.evaluate(() => (window as unknown as { __heroLog: HeroItem[][] }).__heroLog);

const SKELETON: HeroItem = { text: '', href: null, testid: 'demo-cta-skeleton' };
const LISTEN: HeroItem = { text: 'Listen to an episode', href: '/podcast/library', testid: null };
const BROWSE: HeroItem = { text: 'Browse decks', href: '/decks', testid: null };
const live = (href: string): HeroItem => ({ text: 'Start the live demo', href, testid: 'home-try-live-demo' });
const recorded: HeroItem = { text: 'Watch a recorded demo', href: '/video/library', testid: 'home-watch-recorded-demo' };

/** The page is idle and nothing else can move: network quiet, then a grace period for late timers. */
async function settle(page: Page) {
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(900);
}

/**
 * Holds `/api/demo/config` until `release()`: the page's bounded fallback read (2.5 s) stays pending, so the skeleton can be
 * measured without racing a timer. Register after `setup` (the later route wins, then falls back to the mock).
 */
async function holdDemoConfig(page: Page) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/demo/config', async (route) => {
    await gate;
    await route.fallback().catch(() => { /* the page gave up (timeout): nothing to answer */ });
  });
  return release;
}

const demoConfigCalls = () => calls.filter((c) => c.path === '/api/demo/config').length;

// ── [T1-03] the CTA never changes ───────────────────────────────────────────────────────────────
test.describe('[T1-03] Home CTAs', () => {
  const slow = { me: 500, demoConfig: 500, decks: 500, podcast: 500, video: 500 };

  test('[T1-03] boot block: the CTAs are final at the first paint and never change, whatever the APIs say later', async ({ page }) => {
    await watchHero(page);
    const { api, boot, errors } = await setup(page, { catalog: 'demo', demoRemainingToday: 17, delayMs: slow, boot: {} });
    await page.goto('/');
    await expect(page.getByTestId('home-try-live-demo')).toBeVisible();

    const first = await heroLog(page);
    expect(first, 'one render, already final: no skeleton, no later swap').toEqual([
      [live('/decks/deck-demo-en/present'), LISTEN, BROWSE],
    ]);
    expect(boot?.markerSeen, 'the document carries the boot marker').toBe(true);
    await expect(page.getByTestId('home-demo-quota')).toHaveText('17 live sessions left today');

    // The API now disagrees with the boot block: nothing on Home may follow it.
    api.demo.enabled = false;
    api.demo.remainingToday = 0;
    await settle(page);
    expect(await heroLog(page)).toEqual(first);
    await expect(page.getByTestId('home-demo-quota')).toHaveText('17 live sessions left today');
    expect(demoConfigCalls(), 'Home decides from the boot block, not from /api/demo/config').toBe(0);
    expect(errors).toEqual([]);
  });

  test('[T1-03] no boot block: a same-size skeleton, then the final CTA once — and it never changes again', async ({ page }) => {
    await watchHero(page);
    const { errors } = await setup(page, { demoQa: DEMO_QA_CONFIG, demoSessionSeconds: 300 });
    const release = await holdDemoConfig(page);
    await page.goto('/');

    // One round trip while the read is held: the page gives up on it after 2.5 s.
    await page.getByTestId('demo-cta-skeleton').waitFor();
    const before = await page.evaluate(() => {
      const rect = (el: Element | null) => (el ? el.getBoundingClientRect().toJSON() : null);
      const box = document.querySelector('.home-hero__ctas')!;
      return {
        busy: box.getAttribute('aria-busy'),
        liveLinks: document.querySelectorAll('[data-testid=home-try-live-demo]').length,
        skeleton: rect(document.querySelector('[data-testid=demo-cta-skeleton]')),
        listen: rect(document.querySelector('.home-hero__ctas a[href="/podcast/library"]')),
      };
    });
    release();
    expect(before.busy).toBe('true');
    expect(before.liveLinks).toBe(0);

    const link = page.getByTestId('home-try-live-demo');
    await expect(link).toBeVisible();
    const after = {
      link: await link.boundingBox(),
      listen: await page.getByRole('link', { name: 'Listen to an episode' }).boundingBox(),
    };
    expect(Math.abs(after.link!.width - before.skeleton!.width), 'same width').toBeLessThanOrEqual(1);
    expect(Math.abs(after.link!.height - before.skeleton!.height), 'same height').toBeLessThanOrEqual(1);
    expect(Math.abs(after.listen!.x - before.listen!.x), 'the next control does not move').toBeLessThanOrEqual(1);
    expect(Math.abs(after.listen!.y - before.listen!.y)).toBeLessThanOrEqual(1);

    await settle(page);
    expect(await heroLog(page), 'one skeleton state, one final state').toEqual([
      [SKELETON, LISTEN, BROWSE],
      [live('/decks/deck-live/present'), LISTEN, BROWSE],
    ]);
    await expect(page.getByTestId('home-demo-note')).toHaveText('Ask questions by voice · up to 5 min · no sign-in');
    expect(demoConfigCalls(), 'one bounded read, no retry loop').toBe(1);
    expect(errors).toEqual([]);
  });

  test('[T1-03] an ok:false boot block is not trusted: it reads like no block, never freezing a wrong "demo off"', async ({ page }) => {
    await watchHero(page);
    await setup(page, { boot: 'fallback', delayMs: { demoConfig: 400, decks: 400 } });
    await page.goto('/');
    await expect(page.getByTestId('home-try-live-demo')).toBeVisible();
    await settle(page);
    expect(await heroLog(page)).toEqual([
      [SKELETON, LISTEN, BROWSE],
      [live('/decks/deck-live/present'), LISTEN, BROWSE],
    ]);
  });

  test('[T1-03] the decision is frozen for the page load: Decks and Home show the same entry after the API changes its mind', async ({ page }) => {
    await watchHero(page);
    const { api } = await setup(page, { demoRemainingToday: 9, boot: {} });
    await page.goto('/');
    await expect(page.getByTestId('home-try-live-demo')).toBeVisible();
    api.demo.enabled = false;
    api.demo.remainingToday = 0;

    await page.locator('nav[aria-label="Main"]').getByRole('link', { name: 'Decks' }).click();
    const banner = page.getByTestId('try-live-demo-cta');
    await expect(banner).toContainText('Start the live demo');
    await expect(banner).toHaveAttribute('href', '/decks/deck-live/present');
    await expect(page.getByTestId('decks-demo-quota')).toHaveText('9 live sessions left today');

    await page.locator('nav[aria-label="Main"]').getByRole('link', { name: 'Home' }).click();
    await expect(page.getByTestId('home-try-live-demo')).toBeVisible();
    expect(await heroLog(page), 'still the one final state after leaving and coming back').toHaveLength(1);
  });

  test('the live-demo link goes to exactly /decks/{id}/present (no fragment, no query)', async ({ page }) => {
    await open(page, '/', { boot: {} });
    await expect(page.getByTestId('home-try-live-demo')).toHaveAttribute('href', /^\/decks\/deck-live\/present$/);
  });

  test('each public action is one link by its name, so a visitor, a screen reader and other specs never face two of them', async ({ page }) => {
    await open(page, '/', { catalog: 'demo', boot: {} });
    await expect(page.getByTestId('home-try-live-demo')).toBeVisible();
    for (const name of ['Start the live demo', 'Listen to an episode', 'Browse decks']) {
      await expect(page.getByRole('link', { name }), `Home: "${name}"`).toHaveCount(1);
    }
    await page.goto('/video');
    await expect(page.getByTestId('gated-panel')).toBeVisible();
    for (const name of ['Start the live demo', 'Listen to an episode']) {
      await expect(page.getByRole('link', { name }), `gate: "${name}"`).toHaveCount(1);
    }
  });
});

// ── the visitor's language picks the demo deck ──────────────────────────────────────────────────
test.describe('demo deck by browser language', () => {
  test.describe('French visitor', () => {
    test.use({ locale: 'fr-FR' });
    test('[T1-03] a French browser gets the French demo deck on Home and Decks', async ({ page }) => {
      await watchHero(page);
      await open(page, '/', { catalog: 'demo', boot: {} });
      await expect(page.getByTestId('home-try-live-demo')).toBeVisible();
      expect((await heroLog(page))[0][0]).toEqual(live('/decks/deck-demo-fr/present'));
      await page.locator('nav[aria-label="Main"]').getByRole('link', { name: 'Decks' }).click();
      const banner = page.getByTestId('try-live-demo-cta');
      await expect(banner).toHaveAttribute('href', '/decks/deck-demo-fr/present');
      await expect(banner.locator('em')).toHaveAttribute('lang', 'fr');
    });
  });

  test.describe('German visitor (no German deck)', () => {
    test.use({ locale: 'de-DE' });
    test('falls back to the English deck', async ({ page }) => {
      await open(page, '/', { catalog: 'demo', boot: {} });
      await expect(page.getByTestId('home-try-live-demo')).toHaveAttribute('href', '/decks/deck-demo-en/present');
    });
  });

  test('an English browser gets the English deck without a boot block too (bounded API read)', async ({ page }) => {
    await open(page, '/', { catalog: 'demo' });
    await expect(page.getByTestId('home-try-live-demo')).toHaveAttribute('href', '/decks/deck-demo-en/present');
  });
});

// ── [T3-01] [T3-03] demo off, allowance spent, sessions left ────────────────────────────────────
test.describe('demo availability on Home', () => {
  test('[T3-01] demo off: "Watch a recorded demo" is final at the first paint, with the cause beside it', async ({ page }) => {
    await watchHero(page);
    await setup(page, { demoEnabled: false, delayMs: { demoConfig: 400, decks: 400 }, boot: {} });
    await page.goto('/');
    await expect(page.getByTestId('home-watch-recorded-demo')).toBeVisible();
    expect(await heroLog(page)).toEqual([[recorded, LISTEN, BROWSE]]);
    await expect(page.getByTestId('home-demo-note')).toHaveText("The live demo isn't available right now.");
    await expect(page.getByTestId('home-try-live-demo')).toHaveCount(0);
    await expect(page.getByTestId('home-demo-quota')).toHaveCount(0);
    await settle(page);
    expect(await heroLog(page)).toHaveLength(1);

    await page.locator('nav[aria-label="Main"]').getByRole('link', { name: 'Decks' }).click();
    const banner = page.getByTestId('try-live-demo-cta');
    await expect(banner).toContainText('Watch a recorded demo');
    await expect(banner).toHaveAttribute('href', '/video/library');
    await expect(banner).not.toContainText('Sign in');
    // the live-demo deck loses its "Start the live demo" button and its "Live presentation" label
    await expect(page.getByTestId('deck-open').first()).toHaveText('View slides');
    await expect(page.getByTestId('deck-card').first().locator('.episode-row__kind')).toHaveText('Slides');
  });

  test('[T3-01] no boot block and /api/demo/config failing: "Watch a recorded demo", decided once', async ({ page }) => {
    await watchHero(page);
    const { api } = await setup(page, {});
    api.demo.failure = 503;
    await page.goto('/');
    await expect(page.getByTestId('home-watch-recorded-demo')).toBeVisible();
    await settle(page);
    expect(await heroLog(page)).toEqual([
      [SKELETON, LISTEN, BROWSE],
      [recorded, LISTEN, BROWSE],
    ]);
    expect(demoConfigCalls(), 'no retry loop').toBe(1);
  });

  test('[T3-01] no boot block and the read outlives its 2.5 s bound: "Watch a recorded demo", once, even if the answer comes later', async ({ page }) => {
    await watchHero(page);
    await setup(page, {});
    const release = await holdDemoConfig(page);
    await page.goto('/');
    await expect(page.getByTestId('home-watch-recorded-demo')).toBeVisible({ timeout: 20_000 });
    release(); // the late answer is ignored: the page already decided
    await settle(page);
    expect(await heroLog(page)).toEqual([
      [SKELETON, LISTEN, BROWSE],
      [recorded, LISTEN, BROWSE],
    ]);
    await expect(page.getByTestId('home-demo-note')).toHaveText("The live demo isn't available right now.");
  });

  test('[T3-01] demo on but no live-demo deck: "Watch a recorded demo"', async ({ page }) => {
    await open(page, '/', { boot: { live_demo_decks: [] } });
    await expect(page.getByTestId('home-watch-recorded-demo')).toBeVisible();
    await expect(page.getByTestId('home-demo-note')).toHaveText("The live demo isn't available right now.");
  });

  test('[T3-03] no live session left today: "Watch a recorded demo", decided at the first paint', async ({ page }) => {
    await watchHero(page);
    await setup(page, { demoRemainingToday: 0, boot: {} });
    await page.goto('/');
    await expect(page.getByTestId('home-watch-recorded-demo')).toBeVisible();
    expect(await heroLog(page)).toEqual([[recorded, LISTEN, BROWSE]]);
    await expect(page.getByTestId('home-demo-note')).toHaveText("Today's live allowance has been reached.");
  });

  test('[T3-03] sessions left: the count sits beside the unchanged CTA, in the singular too', async ({ page }) => {
    await watchHero(page);
    await setup(page, { demoRemainingToday: 17, boot: {} });
    await page.goto('/');
    await expect(page.getByTestId('home-try-live-demo')).toBeVisible();
    await expect(page.getByTestId('home-demo-quota')).toHaveText('17 live sessions left today');
    expect(await heroLog(page)).toEqual([[live('/decks/deck-live/present'), LISTEN, BROWSE]]);

    const one = await page.context().newPage();
    await setup(one, { demoRemainingToday: 1, boot: {} });
    await one.goto('/');
    await expect(one.getByTestId('home-demo-quota')).toHaveText('1 live session left today');
    await expect(one.getByTestId('home-try-live-demo')).toBeVisible();
  });

  test('the first viewport names what is free, with no "Upload once, ask anything" promise', async ({ page }) => {
    await open(page, '/', { boot: {} });
    await expect(page.locator('.home-hero .lead')).toHaveText(
      'AI hosts explain slide decks and discuss them as podcasts. Listen, watch, or try the live demo — free, no sign-in.',
    );
    await expect(page.locator('.home-hero')).not.toContainText(/upload once|ask anything/i);
  });
});

// ── [T1-04] [T1-07a] Home when the lists fail or are empty ──────────────────────────────────────
test.describe('Home lists', () => {
  const rows = (page: Page) => page.getByTestId('home-episode');
  const heroLinks = async (page: Page) => {
    await expect(page.getByRole('link', { name: 'Listen to an episode' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Browse decks' })).toBeVisible();
  };

  const FAILURES: [string, ApiFailure, string][] = [
    ['503', 503, "We couldn't load the latest episodes right now. Please try again in a moment."],
    ['network', 'network', 'You seem to be offline. Check your connection and try again.'],
    ['proxy 503', 'proxy-503', "We couldn't load the latest episodes right now. Please try again in a moment."],
  ];

  for (const [label, failure, message] of FAILURES) {
    test(`[T1-04] every list fails (${label}): a friendly cause and "Try again", the demo CTA and the links stay; never the empty-site layout`, async ({ page }) => {
      const { api, errors } = await open(page, '/', { libraryFailure: failure, boot: {} });
      const alert = page.getByTestId('home-load-error');
      await expect(alert).toBeVisible();
      await expect(alert).toHaveAttribute('role', 'alert');
      await expect(alert).toContainText(message);
      const text = await page.locator('main').innerText();
      expect(text).not.toMatch(/Failed to fetch|upstream connect|reset reason|Library temporarily unavailable|HTTP \d/i);
      await expect(page.getByText('No episodes are published yet')).toHaveCount(0);
      await expect(page.locator('#home-episodes')).toBeVisible();
      await expect(page.getByTestId('home-try-live-demo')).toHaveAttribute('href', '/decks/deck-live/present');
      await heroLinks(page);

      // "Try again" re-fetches the lists; the alert goes and the rows come.
      await expect(rows(page)).toHaveCount(0);
      api.failures.decks = null;
      api.failures.video = null;
      api.failures.podcast = null;
      await alert.getByRole('button', { name: 'Try again' }).click();
      await expect(alert).toHaveCount(0);
      await expect(rows(page).first()).toBeVisible();
      expect(errors).toEqual([]);
    });
  }

  test('[T1-04] every list fails and there is no boot block: still a demo link (the recording) and the Browse and Listen links', async ({ page }) => {
    await open(page, '/', { libraryFailure: 503 });
    await expect(page.getByTestId('home-load-error')).toContainText("We couldn't load the latest episodes right now.");
    // without the deck list the bounded fallback cannot name a live deck: it offers the recording, once
    await expect(page.getByTestId('home-watch-recorded-demo')).toHaveAttribute('href', '/video/library');
    await heroLinks(page);
    await expect(page.getByText('No episodes are published yet')).toHaveCount(0);
  });

  test('[T1-04] one list fails: the other rows stay, with a status and "Try again"', async ({ page }) => {
    const { api } = await open(page, '/', { libraryFailure: { podcast: 503 }, boot: {} });
    const alert = page.getByTestId('home-load-error');
    await expect(alert).toBeVisible();
    await expect(alert).toHaveAttribute('role', 'status');
    await expect(alert).toContainText("We couldn't load some episodes right now.");
    await expect(rows(page).first()).toBeVisible();
    api.failures.podcast = null;
    await alert.getByRole('button', { name: 'Try again' }).click();
    await expect(alert).toHaveCount(0);
  });

  test('[T1-07a] empty libraries: an honest "No episodes are published yet" — not a failure — with the demo and Browse decks', async ({ page }) => {
    await setup(page, { boot: {} });
    await page.route(/\/api\/(decks|video\/library|podcast\/library)$/, (route) => route.fulfill({
      status: 200, contentType: 'application/json', body: '[]',
    }));
    await page.goto('/');
    await expect(page.getByText('No episodes are published yet')).toBeVisible();
    await expect(page.getByTestId('home-load-error')).toHaveCount(0);
    await expect(page.getByTestId('home-try-live-demo')).toBeVisible();
    await heroLinks(page);
    await expect(rows(page)).toHaveCount(0);
  });
});

// ── rows: level, language, kind labels, copy ────────────────────────────────────────────────────
test.describe('Home rows and copy', () => {
  test('rows carry the level chip and the language of their title (C2.3)', async ({ page }) => {
    await open(page, '/', { catalog: 'demo', boot: {} });
    const rows = page.getByTestId('home-episode');
    await expect(rows).toHaveCount(6);
    // newest first: the French live-demo podcast and video, the English video, then the expert → beginner series
    const frenchPodcast = rows.nth(0);
    await expect(frenchPodcast.locator('.episode-row__title')).toHaveAttribute('lang', 'fr');
    await expect(frenchPodcast.getByTestId('episode-level')).toHaveText('Beginner');
    await expect(rows.nth(2).locator('.episode-row__title')).toHaveAttribute('lang', 'en');
    await expect(rows.nth(3).getByTestId('episode-level')).toHaveText('Expert');
    await expect(rows.nth(3).getByTestId('episode-level')).toHaveAttribute('data-level', 'expert');
    await expect(rows.nth(4).getByTestId('episode-level')).toHaveText('Practitioner');
    await expect(rows.nth(5).getByTestId('episode-level')).toHaveText('Beginner');
    for (let i = 0; i < 6; i += 1) {
      await expect(rows.nth(i).getByTestId('episode-level')).toBeVisible();
    }
  });

  test('"Live presentation" labels only the live-demo deck; the other deck is "Slides"; nothing pulses "On air"', async ({ page }) => {
    await open(page, '/', { boot: {} });
    const rows = page.getByTestId('home-episode');
    await expect(rows).toHaveCount(4);
    const kinds = await rows.locator('.episode-row__kind').allInnerTexts();
    expect(kinds.filter((k) => /live presentation/i.test(k))).toHaveLength(1);
    expect(kinds.filter((k) => /^slides$/i.test(k.trim()))).toHaveLength(1);
    const liveDeck = rows.filter({ has: page.locator('a[href="/decks/deck-live/present"]') });
    await expect(liveDeck.locator('.episode-row__kind')).toContainText('Live presentation');
    await expect(liveDeck.getByTestId('live-demo-badge')).toBeVisible();
    await expect(page.getByText('On air')).toHaveCount(0);
    await expect(page.locator('main .live-pill')).toHaveCount(0);
  });

  test('no SCORM or subtitle promise, no "This week", short sentence-case eyebrows', async ({ page }) => {
    await open(page, '/', { boot: {} });
    await expect(page.getByTestId('home-try-live-demo')).toBeVisible();
    const text = await page.locator('main').innerText();
    expect(text).not.toMatch(/scorm|subtitle/i);
    expect(text).not.toMatch(/this week/i);
    const eyebrows = await page.locator('main .eyebrow:visible').evaluateAll((els) => els.map((el) => ({
      text: (el.textContent ?? '').trim(), sentence: el.classList.contains('eyebrow--sentence'),
    })));
    expect(eyebrows.length).toBeGreaterThan(0);
    for (const e of eyebrows) {
      expect(e.sentence || e.text.length <= 30, `"${e.text}" is a sentence in tracked caps`).toBe(true);
      expect(e.text, 'no raw file name').not.toMatch(/\.(pptx?|docx?|mp4|mp3)\b/i);
    }
  });

  test('Decks: no "Library" kicker; the list shows level and language; only the live-demo deck says "Start the live demo"', async ({ page }) => {
    await open(page, '/decks', { boot: {} });
    await expect(page.getByTestId('deck-card')).toHaveCount(2);
    await expect(page.locator('.eyebrow', { hasText: /^library$/i })).toHaveCount(0);
    const liveCard = page.getByTestId('deck-card').filter({ has: page.locator('a[href="/decks/deck-live/present"]') });
    await expect(liveCard.getByTestId('deck-open')).toHaveText('Start the live demo');
    await expect(liveCard.locator('.episode-row__kind')).toHaveText('Live presentation');
    await expect(liveCard.getByTestId('episode-level')).toHaveText('Beginner');
    await expect(liveCard.locator('.episode-row__title')).toHaveAttribute('lang', 'en');
    const plain = page.getByTestId('deck-card').filter({ has: page.locator('a[href="/decks/deck-plain/present"]') });
    await expect(plain.getByTestId('deck-open')).toHaveText('View slides');
    await expect(plain.locator('.episode-row__kind')).toHaveText('Slides');
    await expect(plain.getByTestId('episode-level')).toHaveCount(0);
  });

  test('PageHeader: a label stays a tracked-caps eyebrow; a sentence (> 30 characters) becomes sentence case', async ({ page }) => {
    await open(page, '/', { boot: {} });
    await expect(page.getByTestId('home-try-live-demo')).toBeVisible();
    const classes = await page.evaluate(async () => {
      const modPath = '/src/ui/PageHeader.tsx';
      const { PageHeader } = await import(/* @vite-ignore */ modPath);
      const eyebrowClass = (node: any): string | null => {
        if (!node || typeof node !== 'object') return null;
        const cls = node.props?.className;
        if (typeof cls === 'string' && /\beyebrow\b/.test(cls)) return cls;
        for (const child of [].concat(node.props?.children ?? [])) {
          const found = eyebrowClass(child);
          if (found) return found;
        }
        return null;
      };
      const of = (eyebrow: string) => eyebrowClass(PageHeader({ eyebrow, title: 'Title' }));
      return {
        label: of('Create · Live presentation'),
        thirty: of('x'.repeat(30)),
        sentence: of('Live presentation · 5 slides · English'),
        file: of('ai-enablement-demo-beginner.pptx — a long raw file name'),
      };
    });
    expect(classes.label).toBe('eyebrow');
    expect(classes.thirty).toBe('eyebrow');
    expect(classes.sentence).toBe('eyebrow eyebrow--sentence');
    expect(classes.file).toBe('eyebrow eyebrow--sentence');
  });
});

// ── [T1-05] [T1-07b] Decks failures and empty state ─────────────────────────────────────────────
test.describe('Decks list', () => {
  test('[T1-05] the decks request fails: a friendly cause and "Try again", the demo and the episodes stay offered; never "No published decks yet"', async ({ page }) => {
    const { api, errors } = await open(page, '/decks', { libraryFailure: { decks: 'network' }, boot: {} });
    const alert = page.getByTestId('decks-load-error');
    await expect(alert).toBeVisible();
    await expect(alert).toHaveAttribute('role', 'alert');
    await expect(alert).toContainText('You seem to be offline. Check your connection and try again.');
    expect(await page.locator('main').innerText()).not.toMatch(/Failed to fetch|Load failed|HTTP \d/i);
    await expect(page.getByText('No published decks yet')).toHaveCount(0);
    await expect(page.getByText('Check back later')).toHaveCount(0);
    await expect(page.getByTestId('try-live-demo-cta')).toContainText('Start the live demo');
    await expect(page.getByRole('link', { name: 'Listen to an episode' })).toHaveAttribute('href', '/podcast/library');

    api.failures.decks = null;
    await alert.getByRole('button', { name: 'Try again' }).click();
    await expect(alert).toHaveCount(0);
    await expect(page.getByTestId('deck-card')).toHaveCount(2);
    expect(errors).toEqual([]);
  });

  test('[T1-05] a 503 reads "We couldn\'t load the decks right now", not the server text', async ({ page }) => {
    await open(page, '/decks', { libraryFailure: { decks: 503 }, boot: {} });
    await expect(page.getByTestId('decks-load-error')).toContainText("We couldn't load the decks right now. Please try again in a moment.");
    expect(await page.locator('main').innerText()).not.toContain('Library temporarily unavailable');
  });

  test('[T1-07b] no published decks: an honest empty state with the demo and the episodes, sign-in demoted to "Owner sign-in"', async ({ page }) => {
    await setup(page, { boot: {} });
    await page.route(/\/api\/decks$/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.goto('/decks');
    await expect(page.getByText('No published decks yet')).toBeVisible();
    await expect(page.getByText('Check back later')).toHaveCount(0);
    await expect(page.getByTestId('decks-load-error')).toHaveCount(0);
    await expect(page.getByTestId('try-live-demo-cta')).toContainText('Start the live demo');
    await expect(page.getByRole('link', { name: 'Listen to an episode' })).toBeVisible();
    await expect(page.getByTestId('auth-gate').getByRole('link', { name: 'Owner sign-in' })).toBeVisible();
    await expect(page.getByRole('button', { name: /sign in/i })).toHaveCount(0);
    // the sign-in notice comes after the public actions, never above them
    const order = await page.evaluate(() => {
      const y = (sel: string) => document.querySelector(sel)!.getBoundingClientRect().top;
      return { banner: y('[data-testid=try-live-demo-cta]'), empty: y('.empty'), gate: y('[data-testid=auth-gate]') };
    });
    expect(order.banner).toBeLessThan(order.empty);
    expect(order.empty).toBeLessThan(order.gate);
  });
});

// ── [T1-10a…e] [T1-12] [T1-13] gate pages ───────────────────────────────────────────────────────
const GATES: [string, string, RegExp][] = [
  ['[T1-10a]', '/live', /The live presenter is limited to demo users/],
  ['[T1-10b]', '/search', /AI search across decks is limited to demo users/],
  ['[T1-10c]', '/playlists', /Playlists are limited to demo users/],
  ['[T1-10d]', '/podcast', /Podcast creation is limited to demo users/],
  ['[T1-10e]', '/video', /Video generation is limited to demo users/],
];

test.describe('gate pages', () => {
  for (const [tag, route, cause] of GATES) {
    test(`${tag} ${route}: the honest cause stays; the primary actions are public; sign-in is a quiet text link`, async ({ page }) => {
      await open(page, route, { boot: {} });
      const panel = page.getByTestId('gated-panel');
      await expect(panel).toBeVisible();
      await expect(panel.locator('.gated-panel__title')).toHaveText(cause);
      await expect(panel.locator('.gated-panel__text')).toBeVisible();
      await expect(panel.locator('.eyebrow').first()).toHaveText('Sign-in required');

      const demo = panel.getByTestId('gate-demo-action');
      await expect(demo).toHaveText('Start the live demo');
      await expect(demo).toHaveAttribute('href', '/decks/deck-live/present');
      const listen = panel.getByTestId('gate-listen-action');
      await expect(listen).toHaveText('Listen to an episode');
      await expect(listen).toHaveAttribute('href', '/podcast/library');
      await expect(panel.getByRole('link', { name: /podcast library/i }), 'no duplicate of "Listen to an episode"').toHaveCount(0);
      // the actions come first, the sign-in notice last
      const y = await panel.evaluate((el) => {
        const top = (sel: string) => el.querySelector(sel)!.getBoundingClientRect().top;
        return { actions: top('.gated-panel__actions'), notice: top('[data-testid=auth-gate]') };
      });
      expect(y.actions).toBeLessThan(y.notice);

      const notice = panel.getByTestId('auth-gate');
      await expect(notice).toContainText('Sign in to ');
      const signIn = notice.getByRole('link', { name: 'Owner sign-in' });
      await expect(signIn).toBeVisible();
      await expect(signIn).toHaveAttribute('href', `/sign-in?next=${encodeURIComponent(route)}`);
      await expect(signIn).toHaveAccessibleDescription('For the site owner and invited users.');
      await expect(panel.getByRole('button', { name: /sign in/i })).toHaveCount(0);
    });
  }

  test('[T1-10] without a boot block the actions are a same-size skeleton, then the final links', async ({ page }) => {
    await setup(page, {});
    const release = await holdDemoConfig(page);
    await page.goto('/search');
    const panel = page.getByTestId('gated-panel');
    // One round trip while the read is held: the page gives up on it after 2.5 s.
    await panel.getByTestId('demo-cta-skeleton').waitFor();
    const before = await page.evaluate(() => {
      const rect = (sel: string) => document.querySelector(sel)?.getBoundingClientRect().toJSON() ?? null;
      return {
        links: document.querySelectorAll('[data-testid=gate-demo-action]').length,
        skeleton: rect('[data-testid=demo-cta-skeleton]'),
        listen: rect('[data-testid=gate-listen-action]'),
      };
    });
    release();
    expect(before.links).toBe(0);

    const link = panel.getByTestId('gate-demo-action');
    await expect(link).toHaveText('Start the live demo');
    await expect(panel.getByTestId('demo-cta-skeleton')).toHaveCount(0);
    const after = { link: await link.boundingBox(), listen: await panel.getByTestId('gate-listen-action').boundingBox() };
    expect(Math.abs(after.link!.width - before.skeleton!.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(after.link!.height - before.skeleton!.height)).toBeLessThanOrEqual(1);
    expect(Math.abs(after.listen!.x - before.listen!.x), 'the next action does not move').toBeLessThanOrEqual(1);
  });

  test('[T1-10] when the live demo is off the gate offers the recording instead', async ({ page }) => {
    await open(page, '/playlists', { demoEnabled: false, boot: {} });
    const demo = page.getByTestId('gate-demo-action');
    await expect(demo).toHaveText('Watch a recorded demo');
    await expect(demo).toHaveAttribute('href', '/video/library');
    // the same target is not repeated as a "Browse the video library" link
    await expect(page.getByTestId('gated-panel').getByRole('link', { name: 'Browse the video library' })).toHaveCount(0);
  });

  test('[T1-12] signed in but not on the allow-list: the cause, the account line and Sign out stay; the public actions are added', async ({ page }) => {
    await open(page, '/search', { me: { authenticated: true, name: 'Guest Visitor' }, boot: {} });
    const panel = page.getByTestId('gated-panel');
    await expect(panel.getByTestId('auth-gate')).toContainText("Your account isn't enabled for this demo.");
    const account = panel.getByTestId('gate-account');
    await expect(account).toContainText('Guest Visitor · read-only');
    await expect(account.getByRole('link', { name: 'Sign out' })).toHaveAttribute('href', '/.auth/logout?post_logout_redirect_uri=/');
    await expect(panel.getByTestId('gate-demo-action')).toHaveAttribute('href', '/decks/deck-live/present');
    await expect(panel.getByTestId('gate-listen-action')).toHaveAttribute('href', '/podcast/library');
    // no sign-in control for someone who is already signed in
    await expect(page.getByRole('link', { name: /owner sign-in/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /sign in/i })).toHaveCount(0);
    await expect(page.getByTestId('auth-controls')).toContainText('Guest Visitor · read-only');
  });

  test('[T1-13] a visitor never meets a sign-in button: the masthead and every gate offer the text link "Owner sign-in"', async ({ page }) => {
    await setup(page, { boot: {} });
    for (const path of ['/', '/decks', ...GATES.map((g) => g[1])]) {
      await page.goto(path);
      const masthead = page.getByTestId('auth-controls').getByRole('link', { name: 'Owner sign-in' });
      await expect(masthead, path).toBeVisible();
      await expect(masthead, path).toHaveAccessibleDescription('For the site owner and invited users.');
      await expect(masthead, path).toHaveAttribute('href', `/sign-in?next=${encodeURIComponent(path)}`);
      await expect(masthead, path).not.toHaveClass(/btn/);
      await expect(page.getByRole('button', { name: /sign in/i }), path).toHaveCount(0);
      await expect(page.locator('.btn--primary', { hasText: /sign in/i }), path).toHaveCount(0);
    }
  });

  test('[T1-13] the masthead link is there from the first paint, before /api/me answers (no pop-in)', async ({ page }) => {
    await setup(page, { delayMs: { me: 800 }, boot: {} });
    await page.goto('/');
    await expect(page.getByTestId('auth-controls').getByRole('link', { name: 'Owner sign-in' })).toBeVisible();
    // and an admin is not offered it once /api/me has answered
    const admin = await page.context().newPage();
    await setup(admin, { role: 'admin', boot: {} });
    await admin.goto('/');
    await expect(admin.getByTestId('auth-controls').getByRole('link', { name: 'Sign out' })).toBeVisible();
    await expect(admin.getByRole('link', { name: /owner sign-in/i })).toHaveCount(0);
  });
});

// ── [T1-13] the "Owner sign-in" explainer ───────────────────────────────────────────────────────
// A visitor cannot sign in (the Entra app is single-tenant), so "Owner sign-in" opens /sign-in first: the public actions
// come first there, and only "Continue to Microsoft sign-in" leaves for Easy Auth. Easy Auth is answered locally.
const SIGN_IN_TITLE = 'Owner sign-in · Oz Radio';
const SIGN_IN_LEAD = 'Signing in is only for the site owner and the people they have invited; everything public on Oz Radio works without an account.';
const MICROSOFT_NOTE = "If your Microsoft account isn't invited, Microsoft shows an error page. Use your browser's Back button to return here.";
const explainerUrl = (next: string) => `/sign-in?next=${encodeURIComponent(next)}`;
const microsoftUrl = (next: string) => `/.auth/login/aad?post_login_redirect_uri=${encodeURIComponent(next)}`;

/**
 * Answers Easy Auth's endpoints with a page of their own and records the requests: nothing leaves the machine. Register it
 * after `setup`: the boot-block route of `mockBoot` also matches a navigation to `/.auth/…`, and the later route wins.
 */
async function mockEasyAuth(page: Page) {
  const requests: string[] = [];
  await page.route('**/.auth/**', (route) => {
    requests.push(route.request().url());
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Microsoft sign-in (mock)</title><p>Microsoft</p>' });
  });
  return requests;
}

/** A visitor (or `opts.role`) on `path`, with the boot block and Easy Auth mocked. */
async function visit(page: Page, path: string, opts: Opts = {}) {
  const ctx = await setup(page, { boot: {}, ...opts });
  const easyAuth = await mockEasyAuth(page);
  await page.goto(path);
  return { ...ctx, easyAuth };
}

/** The explainer is up for `next`: URL, document title, and — after a click inside the app — focus on its heading. */
async function expectExplainer(page: Page, next: string) {
  await expect(page).toHaveURL(explainerUrl(next));
  await expect(page).toHaveTitle(SIGN_IN_TITLE);
  const heading = page.getByRole('heading', { level: 1, name: 'Owner sign-in' });
  await expect(heading).toBeVisible();
  await expect(heading, 'a click inside the app puts focus on the heading').toBeFocused();
}

const markPageLoad = (page: Page) => page.evaluate(() => { (window as unknown as { __kept?: boolean }).__kept = true; });
const stillSamePageLoad = (page: Page) => page.evaluate(() => (window as unknown as { __kept?: boolean }).__kept === true);
const activeTestId = (page: Page) => page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.tagName ?? '');

test.describe('[T1-13] the "Owner sign-in" explainer', () => {
  test('[T1-13] the masthead, a gate and the 401 toast lead to the explainer inside the app, which remembers where the visitor was', async ({ page }) => {
    const { easyAuth, errors } = await visit(page, '/decks?level=beginner');
    const here = '/decks?level=beginner';
    await expect(page.getByTestId('auth-gate')).toBeVisible();
    await markPageLoad(page);

    // the masthead
    const masthead = page.getByTestId('auth-controls').getByRole('link', { name: 'Owner sign-in' });
    await expect(masthead).toHaveAttribute('href', explainerUrl(here));
    await masthead.click();
    await expectExplainer(page, here);
    expect(await stillSamePageLoad(page), 'a route change, not a page load').toBe(true);

    // "Back to where you were" returns to the page, with its search string
    await page.getByTestId('sign-in-back').click();
    await expect(page).toHaveURL(here);
    await expect(page.getByTestId('auth-gate')).toBeVisible();

    // a gate on the page
    const gate = page.getByTestId('auth-gate').getByRole('link', { name: 'Owner sign-in' });
    await expect(gate).toHaveAttribute('href', explainerUrl(here));
    await gate.click();
    await expectExplainer(page, here);
    await page.goBack();
    await expect(page).toHaveURL(here);

    // the 401 banner
    await page.evaluate(() => window.dispatchEvent(
      new CustomEvent('app:auth-error', { detail: { status: 401, url: '/api/podcast/render' } }),
    ));
    const toast = page.getByTestId('auth-toast').getByRole('link', { name: 'Owner sign-in' });
    await expect(toast).toHaveAttribute('href', explainerUrl(here));
    await toast.click();
    await expectExplainer(page, here);

    expect(await stillSamePageLoad(page), 'three clicks, no page load').toBe(true);
    expect(easyAuth, 'nothing went to Easy Auth: only "Continue to Microsoft sign-in" does').toEqual([]);
    expect(errors).toEqual([]);
  });

  test('[T1-13] on the explainer the masthead link keeps the `next` it has, never nesting a second one', async ({ page }) => {
    await visit(page, explainerUrl('/decks?level=beginner'));
    const masthead = page.getByTestId('auth-controls').getByRole('link', { name: 'Owner sign-in' });
    await expect(masthead).toHaveAttribute('href', explainerUrl('/decks?level=beginner'));
    // without a usable `next` it points at Home: the explainer itself is never a destination
    await page.goto('/sign-in');
    await expect(page.getByTestId('auth-controls').getByRole('link', { name: 'Owner sign-in' })).toHaveAttribute('href', explainerUrl('/'));
    await expect(page.getByTestId('sign-in-back')).toHaveAttribute('href', '/');
  });

  test('[T1-13] it is a real link: a new tab opens the explainer, and the page the visitor was on stays put', async ({ page }) => {
    const { easyAuth } = await visit(page, '/search');
    // A new tab has none of this page's mocks: a failing /api/me reads as a visitor there.
    await page.context().route('**/api/**', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{"detail":"mock"}' }));
    const link = page.getByTestId('auth-controls').getByRole('link', { name: 'Owner sign-in' });
    await expect(link).toHaveAttribute('href', explainerUrl('/search'));
    const [tab] = await Promise.all([page.context().waitForEvent('page'), link.click({ button: 'middle' })]);
    await tab.waitForURL(/\/sign-in\?next=%2Fsearch$/);
    await expect(tab.getByRole('heading', { level: 1, name: 'Owner sign-in' })).toBeVisible();
    await expect(tab).toHaveTitle(SIGN_IN_TITLE);
    await tab.close();
    expect(page.url()).toMatch(/\/search$/);
    await expect(page.getByTestId('gated-panel')).toBeVisible();
    expect(easyAuth).toEqual([]);
  });

  test('[T1-13] the explainer: who may sign in, the public actions first (in the page and in the tab order), the owner\'s own way in second', async ({ page }, testInfo) => {
    await visit(page, '/search');
    await page.getByTestId('auth-controls').getByRole('link', { name: 'Owner sign-in' }).click();
    await expectExplainer(page, '/search');
    await page.screenshot({ path: testInfo.outputPath('sign-in-desktop.png') });
    const root = page.getByTestId('sign-in-page');
    await expect(root.getByRole('heading', { level: 1 })).toHaveText('Owner sign-in');
    await expect(root.locator('.page-header__lead')).toHaveText(SIGN_IN_LEAD);

    const demo = root.getByTestId('sign-in-demo-action');
    await expect(demo).toHaveText('Start the live demo');
    await expect(demo).toHaveAttribute('href', '/decks/deck-live/present');
    const listen = root.getByTestId('sign-in-listen-action');
    await expect(listen).toHaveText('Listen to an episode');
    await expect(listen).toHaveAttribute('href', '/podcast/library');
    const back = root.getByTestId('sign-in-back');
    await expect(back).toHaveText('Back to where you were');
    await expect(back).toHaveAttribute('href', '/search');
    const owner = root.getByRole('region', { name: 'For the site owner' });
    await expect(owner.getByRole('heading', { level: 2 })).toHaveText('For the site owner');
    const next = owner.getByTestId('sign-in-continue');
    await expect(next).toHaveText('Continue to Microsoft sign-in');
    await expect(next).toHaveAttribute('href', microsoftUrl('/search'));
    await expect(owner).toContainText(MICROSOFT_NOTE);

    // the public actions are the primary ones; the owner's button is secondary; a visitor never meets a sign-in button
    await expect(demo).toHaveClass(/btn--primary/);
    await expect(next).not.toHaveClass(/btn--primary/);
    await expect(root.getByRole('button', { name: /sign in/i })).toHaveCount(0);
    await expect(root.getByRole('link', { name: /owner sign-in/i })).toHaveCount(0);
    for (const name of ['Start the live demo', 'Listen to an episode']) await expect(page.getByRole('link', { name }), name).toHaveCount(1);

    // DOM order, then the order on the screen, then the tab order: demo, listen, back, and only then Microsoft
    const order = await root.evaluate((el) => {
      const ids = ['sign-in-demo-action', 'sign-in-listen-action', 'sign-in-back', 'sign-in-continue'];
      const nodes = ids.map((id) => el.querySelector(`[data-testid=${id}]`)!);
      return {
        dom: nodes.slice(1).every((node, i) => !!(nodes[i].compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)),
        tops: nodes.map((node) => Math.round(node.getBoundingClientRect().top)),
      };
    });
    expect(order.dom, 'DOM order').toBe(true);
    expect([...order.tops].sort((a, b) => a - b), 'the same order on the screen').toEqual(order.tops);
    const tabs: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      await page.keyboard.press('Tab');
      tabs.push(await activeTestId(page));
    }
    expect(tabs, 'tab order from the heading').toEqual(['sign-in-demo-action', 'sign-in-listen-action', 'sign-in-back', 'sign-in-continue']);
  });

  test('[T1-13] when the live demo is off the explainer offers the recording instead, as Home does', async ({ page }) => {
    await visit(page, explainerUrl('/'), { demoEnabled: false });
    const demo = page.getByTestId('sign-in-demo-action');
    await expect(demo).toHaveText('Watch a recorded demo');
    await expect(demo).toHaveAttribute('href', '/video/library');
    await expect(page.getByTestId('sign-in-listen-action')).toHaveAttribute('href', '/podcast/library');
  });

  test('[T1-13] the explainer is its own chunk: Home does not load it, and showing intent on the link fetches it, so the click finds it ready', async ({ page }) => {
    const modules: string[] = [];
    page.on('request', (request) => {
      const match = new URL(request.url()).pathname.match(/\/src\/pages\/(\w+)\.tsx$/);
      if (match) modules.push(match[1]);
    });
    await visit(page, '/');
    await expect(page.getByTestId('home-try-live-demo')).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(modules, 'Home does not download the explainer').not.toContain('SignInPage');
    const requested = page.waitForRequest((request) => /\/src\/pages\/SignInPage\.tsx/.test(request.url()));
    await page.getByTestId('auth-controls').getByRole('link', { name: 'Owner sign-in' }).hover();
    await requested;
  });

  test('[T1-13] a first load sets the title and does not move focus (only a click inside the app puts it on the heading)', async ({ page }) => {
    await visit(page, explainerUrl('/decks'));
    await expect(page.getByRole('heading', { level: 1, name: 'Owner sign-in' })).toBeVisible();
    await expect(page).toHaveTitle(SIGN_IN_TITLE);
    expect(await page.evaluate(() => document.activeElement === document.body), 'a first load never moves focus').toBe(true);
  });

  test('[T1-13] "Continue to Microsoft sign-in" is the only way out: a page load of Easy Auth, back to the page the visitor was on', async ({ page }) => {
    const { easyAuth } = await visit(page, explainerUrl('/decks?x=1'));
    await expect(page.getByTestId('sign-in-page')).toBeVisible();
    expect(easyAuth, 'nothing goes to Easy Auth before the owner asks').toEqual([]);

    await page.getByRole('link', { name: 'Continue to Microsoft sign-in' }).click();
    await expect(page).toHaveTitle('Microsoft sign-in (mock)');
    const url = new URL(page.url());
    expect(url.pathname).toBe('/.auth/login/aad');
    expect(url.search).toBe('?post_login_redirect_uri=%2Fdecks%3Fx%3D1');
    expect(easyAuth).toHaveLength(1);

    // the browser's Back returns to the explainer: it is the page the single-tenant error page leads back to
    await page.goBack();
    await expect(page).toHaveURL(explainerUrl('/decks?x=1'));
    await expect(page.getByRole('heading', { level: 1, name: 'Owner sign-in' })).toBeVisible();
  });

  test('[T1-13] `next` is sanitised: one in-app path survives; an external address, a look-alike or the explainer itself becomes Home', async ({ page }) => {
    const { easyAuth } = await visit(page, '/');
    const long = (n: number) => `/${'a'.repeat(n - 1)}`;
    const cases: [input: unknown, expected: string][] = [
      ['/decks?x=1', '/decks?x=1'],
      ['/podcast/library?episode=pod-2&mode=listen', '/podcast/library?episode=pod-2&mode=listen'],
      ['/decks#top', '/decks#top'],
      ['/', '/'],
      [long(2048), long(2048)],
      ['/%5Cevil.example', '/%5Cevil.example'],
      ['//evil.example', '/'],
      ['https://evil.example', '/'],
      ['/\\evil.example', '/'],
      ['\\/evil', '/'],
      ['\\\\evil.example', '/'],
      ['javascript:alert(1)', '/'],
      ['data:text/html,x', '/'],
      ['/\t/evil.example', '/'],
      ['/\n/evil.example', '/'],
      ['/\u0000decks', '/'],
      [' /decks', '/'],
      ['/de cks', '/'],
      ['/sign-in', '/'],
      ['/sign-in?next=/x', '/'],
      ['/sign-in/', '/'],
      ['/Sign-In#x', '/'],
      ['/sign%2Din', '/'],
      [long(3000), '/'],
      [long(2049), '/'],
      ['', '/'],
      [null, '/'],
      [42, '/'],
    ];
    // `new Function` keeps the dynamic import out of the spec's CommonJS transform: it runs in the page, on the dev server's module.
    const results = await page.evaluate(async (inputs) => {
      const load = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<Record<string, any>>;
      const auth = await load('/src/services/auth.tsx');
      return {
        safe: inputs.map((input) => auth.safeNextPath(input)),
        onExplainer: auth.ownerSignInPath({ pathname: '/sign-in', search: '?next=%2Fdecks%3Fx%3D1' }),
        onExplainerHostile: auth.ownerSignInPath({ pathname: '/sign-in', search: '?next=%2F%2Fevil.example' }),
        onPage: auth.ownerSignInPath({ pathname: '/decks', search: '?x=1' }),
        microsoft: auth.microsoftSignInUrl('/decks?x=1'),
        legacy: (() => { history.replaceState(null, '', '/podcast/library?episode=pod-2'); return auth.signInUrl(); })(),
      };
    }, cases.map(([input]) => input));
    expect(results.safe).toEqual(cases.map(([, expected]) => expected));
    expect(results.onExplainer).toBe(explainerUrl('/decks?x=1'));
    expect(results.onExplainerHostile).toBe(explainerUrl('/'));
    expect(results.onPage).toBe(explainerUrl('/decks?x=1'));
    expect(results.microsoft).toBe(microsoftUrl('/decks?x=1'));
    expect(results.legacy, 'signIn() keeps the URL it always built (the expired-session button)').toBe(microsoftUrl('/podcast/library?episode=pod-2'));

    // and on the page itself: a hostile `next` never reaches a link
    for (const hostile of ['//evil.example', 'https://evil.example', '/\\evil.example', '/sign-in?next=/x']) {
      await page.goto(explainerUrl(hostile));
      await expect(page.getByTestId('sign-in-page')).toBeVisible();
      await expect(page.getByTestId('sign-in-back'), hostile).toHaveAttribute('href', '/');
      await expect(page.getByTestId('sign-in-continue'), hostile).toHaveAttribute('href', microsoftUrl('/'));
      await expect(page.getByTestId('auth-controls').getByRole('link', { name: 'Owner sign-in' }), hostile).toHaveAttribute('href', explainerUrl('/'));
    }
    const hrefs = await page.evaluate(() => Array.from(document.querySelectorAll('a[href]'), (a) => a.getAttribute('href')));
    expect(hrefs.filter((href) => /evil/.test(href ?? ''))).toEqual([]);
    expect(easyAuth).toEqual([]);
  });

  test('[T1-13] signed in: the owner is told so and sent back; with sign-in switched off or an account that is not enabled it says that instead', async ({ page }) => {
    const { api } = await visit(page, explainerUrl('/decks'), { role: 'admin' });
    const root = page.getByTestId('sign-in-page');
    const lead = root.locator('.page-header__lead');

    await test.step('the owner', async () => {
      await expect(root.getByRole('heading', { level: 1 })).toHaveText('Owner sign-in');
      await expect(lead).toHaveText("You're signed in.");
      await expect(root.getByTestId('sign-in-back')).toHaveAttribute('href', '/decks');
      await expect(root.getByTestId('sign-in-continue'), 'no second sign-in').toHaveCount(0);
      await expect(page.getByRole('link', { name: /owner sign-in/i }), 'the masthead offers Sign out, not sign-in').toHaveCount(0);
      await expect(page.getByTestId('auth-controls').getByRole('link', { name: 'Sign out' })).toBeVisible();
    });

    await test.step('sign-in switched off (local development)', async () => {
      Object.assign(api.me, { auth_mode: 'disabled' });
      await page.goto(explainerUrl('/decks'));
      await expect(lead).toHaveText("Sign-in isn't used in this environment.");
      await expect(root.getByTestId('sign-in-back')).toHaveAttribute('href', '/decks');
      await expect(root.getByTestId('sign-in-continue')).toHaveCount(0);
    });

    await test.step('signed in, but the account is not enabled', async () => {
      Object.assign(api.me, { auth_mode: 'easyauth', is_admin: false, name: 'Guest Visitor' });
      await page.goto(explainerUrl('/decks'));
      await expect(lead).toHaveText("You're signed in, but your account isn't enabled for this demo.");
      await expect(root.getByTestId('sign-in-demo-action')).toHaveAttribute('href', '/decks/deck-live/present');
      await expect(root.getByTestId('sign-in-listen-action')).toHaveAttribute('href', '/podcast/library');
      await expect(root.getByTestId('sign-in-back')).toHaveAttribute('href', '/decks');
      await expect(root.getByTestId('sign-in-continue'), 'already signed in').toHaveCount(0);
      await expect(root.getByTestId('sign-in-sign-out')).toHaveAttribute('href', '/.auth/logout?post_logout_redirect_uri=/');
    });
  });

  test('[T1-13] it fits a 360 px phone: nothing scrolls sideways and every action is inside the screen', async ({ page }) => {
    const variants: [string, Opts][] = [
      ['live demo', {}],
      ['recorded demo', { demoEnabled: false }],
      ['signed in, not enabled', { me: { authenticated: true, name: 'Guest Visitor' } }],
    ];
    for (const [name, opts] of variants) {
      const phone = await page.context().newPage();
      await phone.setViewportSize({ width: 360, height: 740 });
      await visit(phone, explainerUrl('/decks?level=beginner'), opts);
      await expect(phone.getByTestId('sign-in-demo-action'), name).toBeVisible();
      const fit = await phone.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        outside: Array.from(document.querySelectorAll('main a[href], main button, main h1, main p'))
          .map((el) => ({ text: (el.textContent ?? '').trim().slice(0, 40), right: el.getBoundingClientRect().right, left: el.getBoundingClientRect().left }))
          .filter((box) => box.right > document.documentElement.clientWidth + 0.5 || box.left < -0.5),
      }));
      expect(fit.scrollWidth, `${name}: no horizontal scroll`).toBeLessThanOrEqual(fit.clientWidth);
      expect(fit.outside, `${name}: nothing outside the screen`).toEqual([]);
      await phone.close();
    }
  });

  test('[T1-13] an expired session keeps its own "Sign in" button: straight to Microsoft, back to the same page', async ({ page }) => {
    const { easyAuth } = await visit(page, '/decks?level=beginner', { role: 'admin' });
    await expect(page.getByTestId('auth-controls').getByRole('link', { name: 'Sign out' })).toBeVisible();
    await page.evaluate(() => window.dispatchEvent(
      new CustomEvent('app:auth-error', { detail: { status: 401, url: '/api/podcast/render' } }),
    ));
    const toast = page.getByTestId('auth-toast');
    await expect(toast).toContainText('Your session has expired. Please sign in again.');
    expect(easyAuth).toEqual([]);
    await toast.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveTitle('Microsoft sign-in (mock)');
    const url = new URL(page.url());
    expect(`${url.pathname}${url.search}`).toBe(microsoftUrl('/decks?level=beginner'));
  });

  test('[T1-13] no serious or critical axe violation (colour contrast included) in the explainer, for a visitor and for a guest', async ({ page }, testInfo) => {
    const { api } = await visit(page, explainerUrl('/search'));
    await expect(page.getByTestId('sign-in-demo-action')).toBeVisible();
    for (const [name, me] of [['visitor', null], ['not enabled', { authenticated: true, name: 'Guest Visitor' }]] as const) {
      if (me) {
        Object.assign(api.me, me);
        await page.goto(explainerUrl('/search'));
        await expect(page.getByTestId('sign-in-sign-out')).toBeVisible();
      }
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .include('[data-testid=sign-in-page]')
        .analyze();
      await testInfo.attach(`axe-${name}.json`, { body: JSON.stringify(results.violations, null, 2), contentType: 'application/json' });
      expect(results.passes.map((rule) => rule.id), `${name}: the colour contrast was measured`).toContain('color-contrast');
      const blocking = results.violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? ''));
      expect(blocking.map((v) => `${v.id} [${v.impact}]`), `${name}: ${JSON.stringify(blocking.map((v) => v.nodes.map((n) => n.html.slice(0, 120))))}`).toEqual([]);
    }
  });
});

// ── [T1-11] owner tools: grouped and marked ─────────────────────────────────────────────────────
test.describe('owner tools', () => {
  const GATED_HREFS = ['/live', '/search', '/playlists', '/video', '/podcast'];

  test('[T1-11] a visitor\'s navigation: four public sections, one "Owner tools" disclosure that marks every wall', async ({ page }) => {
    await open(page, '/', { boot: {} });
    const main = page.locator('nav[aria-label="Main"]');
    await expect(main.locator(':scope > a')).toHaveText(['Home', 'Decks', 'Videos', 'Podcasts']);
    await expect(main.getByRole('link', { name: /^(Playlists|Search)$/ })).toHaveCount(0);

    const trigger = main.getByRole('button', { name: /^Owner tools/ });
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const list = main.getByRole('list', { name: 'Owner tools' });
    await expect(list.getByRole('listitem')).toHaveCount(5);
    await expect(list.getByRole('link')).toHaveText([
      /Playlists/, /Search/, /Live presentation/, /Narrated video/, /Two-host podcast/,
    ]);
    for (const item of await list.getByRole('listitem').all()) {
      await expect(item).toContainText('Sign-in required');
    }
    await expect(main).toContainText('For the site owner and invited users');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(page.getByRole('menuitem')).toHaveCount(0);
    await expect(list.getByRole('link').first()).toHaveAttribute('href', '/playlists');
  });

  test('[T1-11] Home: every link to a gated page says "Sign-in required" — no unmarked wall', async ({ page }) => {
    await open(page, '/', { boot: {} });
    await expect(page.getByTestId('home-try-live-demo')).toBeVisible();
    const cards = page.getByTestId('home-owner-tools').locator('a.home-dept');
    await expect(cards).toHaveCount(3);
    for (const card of await cards.all()) await expect(card).toContainText('Sign-in required');
    await expect(page.getByTestId('home-owner-tools')).toContainText('Sign-in required');
    await expect(page.getByTestId('home-owner-tools')).toContainText('For the site owner and invited users.');

    // everything visible that leads to a gated route is marked (masthead disclosure is closed: its walls are not links yet)
    const unmarked = await page.evaluate((hrefs) => Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'))
      .filter((a) => hrefs.includes(a.getAttribute('href')!) && a.getClientRects().length > 0)
      .filter((a) => !/sign-in required/i.test(a.textContent ?? ''))
      .map((a) => a.getAttribute('href')), GATED_HREFS);
    expect(unmarked).toEqual([]);

    // the public sections are not marked
    const publicCards = page.locator('.home-departments').first().locator('a.home-dept');
    await expect(publicCards).toHaveCount(3);
    for (const card of await publicCards.all()) await expect(card).not.toContainText('Sign-in required');
  });

  test('[T1-11] the owner sees Playlists and Search in the main navigation, a plain "Create" disclosure, and open Home cards', async ({ page }) => {
    await open(page, '/', { role: 'admin', boot: {} });
    const main = page.locator('nav[aria-label="Main"]');
    await expect(main.locator(':scope > a')).toHaveText(['Home', 'Decks', 'Videos', 'Podcasts', 'Playlists', 'Search']);
    const trigger = main.getByRole('button', { name: /^Create/ });
    await trigger.click();
    const list = main.getByRole('list', { name: 'Create' });
    await expect(list.getByRole('link')).toHaveText([/Live presentation/, /Narrated video/, /Two-host podcast/]);
    await expect(list).not.toContainText('Sign-in required');
    const owner = page.getByTestId('home-owner-tools');
    await expect(owner).not.toContainText('Sign-in required');
    await expect(owner.getByRole('link', { name: /Open Search/ })).toBeVisible();
    await expect(owner.getByRole('link', { name: /Open Playlists/ })).toBeVisible();
    await expect(owner.getByRole('link', { name: /Open Live/ })).toBeVisible();
  });
});

// ── P2-5 / P2-4: the Create disclosure and the sticky masthead (keyboard) ───────────────────────
interface Focus {
  name: string; inMasthead: boolean; inMain: boolean; top: number; bottom: number; mastheadBottom: number; covered: boolean;
}

const focusInfo = (page: Page) => page.evaluate((): Focus | null => {
  const el = document.activeElement as HTMLElement | null;
  if (!el || el === document.body) return null;
  const r = el.getBoundingClientRect();
  const x = Math.min(Math.max(r.x + r.width / 2, 0), window.innerWidth - 1);
  const y = Math.min(Math.max(r.y + r.height / 2, 0), window.innerHeight - 1);
  const hit = document.elementFromPoint(x, y);
  return {
    name: (el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 40),
    inMasthead: !!el.closest('header.masthead'),
    inMain: !!el.closest('main'),
    top: r.top,
    bottom: r.bottom,
    mastheadBottom: document.querySelector('header.masthead')!.getBoundingClientRect().bottom,
    covered: !!hit && !el.contains(hit) && !hit.contains(el),
  };
});

test.describe('keyboard', () => {
  test('[P2-5] the Create menu is a disclosure of links: no menu role, focus stays on its button, Escape closes it and keeps focus there', async ({ page }) => {
    await open(page, '/', { role: 'admin', boot: {} });
    const trigger = page.getByRole('button', { name: /^Create/ });
    const list = page.getByRole('list', { name: 'Create' });
    await trigger.focus();
    await page.keyboard.press('Enter');
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await expect(trigger).not.toHaveAttribute('aria-haspopup', /.+/);
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(page.getByRole('menuitem')).toHaveCount(0);
    await expect(list.getByRole('link')).toHaveCount(3);
    await expect(trigger, 'a disclosure does not steal focus').toBeFocused();

    await page.keyboard.press('Tab');
    await expect(list.getByRole('link').first()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(list).toHaveCount(0);
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(trigger, 'Escape returns focus to the Create button').toBeFocused();

    // Escape from the button itself, and Space to reopen
    await page.keyboard.press('Space');
    await expect(list).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(list).toHaveCount(0);
    await expect(trigger).toBeFocused();

    // a click elsewhere closes it; Tab past the last link closes it too
    await trigger.click();
    await expect(list).toBeVisible();
    await page.locator('h1').click();
    await expect(list).toHaveCount(0);
    await trigger.focus();
    await page.keyboard.press('Enter');
    await list.getByRole('link').last().focus();
    await page.keyboard.press('Tab');
    await expect(list).toHaveCount(0);
  });

  test('[P2-5] a visitor\'s "Owner tools" disclosure behaves the same', async ({ page }) => {
    await open(page, '/', { boot: {} });
    const trigger = page.getByRole('button', { name: /^Owner tools/ });
    await trigger.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('list', { name: 'Owner tools' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('list', { name: 'Owner tools' })).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  async function walkBackwards(page: Page, steps: number) {
    await page.locator('main a[href], main button:not([disabled])').last().focus();
    const hidden: Focus[] = [];
    for (let i = 0; i < steps; i += 1) {
      await page.keyboard.press('Shift+Tab');
      const info = await focusInfo(page);
      if (!info || !info.inMain) break;
      if (info.top < info.mastheadBottom - 1) hidden.push(info);
    }
    return hidden;
  }

  test('[P2-4] Shift+Tab up a long Home never leaves a focused control under the sticky masthead', async ({ page }) => {
    await open(page, '/', { catalog: 'demo', boot: {} });
    await expect(page.getByTestId('home-episode')).toHaveCount(6);
    expect(await walkBackwards(page, 40), 'stops hidden under the masthead').toEqual([]);
  });

  test('[P2-4] control: without scroll-padding-top the same walk does hide stops (the check can fail)', async ({ page }) => {
    await open(page, '/', { catalog: 'demo', boot: {} });
    await expect(page.getByTestId('home-episode')).toHaveCount(6);
    await page.addStyleTag({ content: 'html { scroll-padding-top: 0 !important; }' });
    expect((await walkBackwards(page, 40)).length).toBeGreaterThan(0);
  });

  test('[P2-4] the root keeps the masthead\'s height as scroll padding (plus the safe-area inset)', async ({ page }) => {
    await open(page, '/', { boot: {} });
    const { padding, masthead } = await page.evaluate(() => ({
      padding: parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop),
      masthead: document.querySelector('header.masthead')!.getBoundingClientRect().height,
    }));
    expect(padding).toBeGreaterThanOrEqual(masthead);
  });
});

// ── phone: the modal menu sheet (P1-3) and the first viewport (C1.4) ────────────────────────────
const { defaultBrowserType: _ignored, ...PIXEL_7 } = devices['Pixel 7'];

test.describe('phone (Pixel 7 viewport)', () => {
  test.use({ ...PIXEL_7, contextOptions: { reducedMotion: 'reduce' } });

  test('[C1.4] the first viewport says what it is, what is free, and offers the live demo without scrolling', async ({ page }, testInfo) => {
    await open(page, '/', { catalog: 'demo', boot: {} });
    const viewport = page.viewportSize()!;
    await expect(page.locator('.home-hero .lead')).toContainText('free, no sign-in');
    const cta = page.getByTestId('home-try-live-demo');
    await expect(cta).toBeVisible();
    const lead = (await page.locator('.home-hero .lead').boundingBox())!;
    const box = (await cta.boundingBox())!;
    expect(lead.y + lead.height).toBeLessThanOrEqual(viewport.height);
    expect(box.y + box.height, 'the demo link is above the fold').toBeLessThanOrEqual(viewport.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('home-phone.png') }); // viewport only: fullPage drops touch emulation
  });

  test('[P1-3] the open menu sheet is modal: the page behind is inert, Tab cycles inside, Escape returns focus to the menu button', async ({ page }, testInfo) => {
    await open(page, '/', { boot: {} });
    await expect(page.getByTestId('home-try-live-demo')).toBeVisible();
    const toggle = page.getByRole('button', { name: 'Open menu' });
    await toggle.focus();
    await page.keyboard.press('Enter');
    const sheet = page.locator('#site-sheet');
    await expect(sheet).toHaveAttribute('data-open', 'true');
    await expect(page.getByRole('button', { name: 'Close menu' })).toHaveAttribute('aria-expanded', 'true');
    await expect(sheet.getByRole('link').first(), 'focus moves into the sheet').toBeFocused();
    await expect(page.locator('main')).toHaveAttribute('inert', '');
    await page.screenshot({ path: testInfo.outputPath('menu-sheet-phone.png') });

    // the visitor's sheet: public sections, then the owner tools, each wall marked
    await expect(sheet.getByRole('navigation', { name: 'Sections' }).getByRole('link')).toHaveText(['Home', 'Decks', 'Videos', 'Podcasts']);
    const tools = sheet.getByRole('navigation', { name: 'Owner tools' });
    await expect(tools.getByRole('link')).toHaveCount(5);
    for (const link of await tools.getByRole('link').all()) await expect(link).toContainText('Sign-in required');

    // 16 Tabs (more than one lap): focus never leaves the masthead and is never covered by the sheet
    const seen = new Set<string>();
    for (let i = 0; i < 16; i += 1) {
      await page.keyboard.press('Tab');
      const info = await focusInfo(page);
      expect(info, `Tab ${i + 1} left focus on the body`).not.toBeNull();
      expect(info!.inMasthead, `Tab ${i + 1} ("${info!.name}") escaped the masthead`).toBe(true);
      expect(info!.covered, `Tab ${i + 1} ("${info!.name}") is covered`).toBe(false);
      seen.add(info!.name);
    }
    expect(seen.size, 'a full lap: brand, sign-in, close button and the nine sheet links').toBeGreaterThanOrEqual(12);

    // Shift+Tab from the first stop wraps to the last link of the sheet
    await page.locator('.masthead__brand').focus();
    await page.keyboard.press('Shift+Tab');
    await expect(sheet.getByRole('link').last()).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(sheet).toHaveAttribute('data-open', 'false');
    await expect(page.getByRole('button', { name: 'Open menu' })).toBeFocused();
    await expect(page.locator('main')).not.toHaveAttribute('inert', /.*/);
    expect(await page.evaluate(() => document.body.style.overflow)).not.toBe('hidden');
  });

  test('[P1-3] following a link in the sheet closes it, frees the page and lets the route move focus to #main', async ({ page }) => {
    await open(page, '/', { boot: {} });
    await page.getByRole('button', { name: 'Open menu' }).click();
    await page.locator('#site-sheet').getByRole('link', { name: 'Decks' }).click();
    await expect(page).toHaveURL(/\/decks$/);
    await expect(page.locator('#site-sheet')).toHaveAttribute('data-open', 'false');
    await expect(page.locator('main')).not.toHaveAttribute('inert', /.*/);
    expect(await page.evaluate(() => document.body.style.overflow)).not.toBe('hidden');
    // the route's own focus handling is not blocked by an inert page: focus lands on the new page, not on <body>
    await expect(page.locator('#main')).toBeFocused();
  });

  test('[P1-3] tapping the link of the page you are on closes the sheet and keeps focus on the menu button', async ({ page }) => {
    await open(page, '/', { boot: {} });
    await page.getByRole('button', { name: 'Open menu' }).click();
    await page.locator('#site-sheet').getByRole('link', { name: 'Home' }).click();
    await expect(page.locator('#site-sheet')).toHaveAttribute('data-open', 'false');
    await expect(page.getByRole('button', { name: 'Open menu' })).toBeFocused();
    await expect(page.locator('main')).not.toHaveAttribute('inert', /.*/);
  });

  test('[P1-3] growing the window past the sheet\'s breakpoint closes it: the page never stays inert behind a hidden sheet', async ({ page }) => {
    await open(page, '/', { boot: {} });
    await page.getByRole('button', { name: 'Open menu' }).click();
    await expect(page.locator('main')).toHaveAttribute('inert', '');
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.locator('#site-sheet')).toHaveAttribute('data-open', 'false');
    await expect(page.locator('main')).not.toHaveAttribute('inert', /.*/);
    await expect(page.getByTestId('home-try-live-demo')).toBeVisible();
  });

  test('[T1-13] the explainer on a phone: a tap on "Owner sign-in" lands on the public actions, first on the screen, and nothing scrolls sideways', async ({ page }, testInfo) => {
    await open(page, '/decks?level=beginner', { catalog: 'demo', boot: {} });
    await page.getByTestId('auth-controls').getByRole('link', { name: 'Owner sign-in' }).tap();
    await expect(page).toHaveURL(explainerUrl('/decks?level=beginner'));
    await expect(page.getByRole('heading', { level: 1, name: 'Owner sign-in' })).toBeFocused();
    for (const id of ['sign-in-demo-action', 'sign-in-listen-action', 'sign-in-back']) {
      await expect(page.getByTestId(id), `${id} is on the first screen`).toBeInViewport({ ratio: 1 });
    }
    await expect(page.getByTestId('sign-in-continue')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('sign-in-phone.png') }); // viewport only: fullPage drops touch emulation
  });
});

// ── wiring sanity ───────────────────────────────────────────────────────────────────────────────
test.describe('Home basics', () => {
  test('the page loads without uncaught errors, for a visitor and for the owner', async ({ page }) => {
    const visitor = await open(page, '/', { catalog: 'demo', boot: {} });
    await expect(page.getByTestId('home-episode').first()).toBeVisible();
    expect(visitor.errors).toEqual([]);
    const owner = await page.context().newPage();
    const ctx = await open(owner, '/', { role: 'admin', catalog: 'demo', boot: {} });
    await expect(owner.getByTestId('home-episode').first()).toBeVisible();
    expect(ctx.errors).toEqual([]);
  });

  test('no React warning (keys, DOM nesting, invalid attributes) on Home, Decks, a gate or with the menus open', async ({ page }) => {
    const warnings: string[] = [];
    page.on('console', (msg) => {
      const text = msg.text();
      if (['error', 'warning'].includes(msg.type()) && /warning:|validateDOMNesting|unique "key"|non-boolean attribute|cannot be a descendant|hydrat/i.test(text)) {
        warnings.push(text.slice(0, 240));
      }
    });
    await setup(page, { catalog: 'demo', boot: {} });
    for (const path of ['/', '/decks', '/search', explainerUrl('/decks')]) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
    }
    await page.goto('/');
    await page.getByRole('button', { name: /^Owner tools/ }).click();
    await expect(page.getByRole('list', { name: 'Owner tools' })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 800 });
    await page.getByRole('button', { name: 'Open menu' }).click();
    await expect(page.locator('#site-sheet')).toHaveAttribute('data-open', 'true');
    expect(warnings).toEqual([]);
  });

  // Review aids: screenshots land in the test output folder; nothing is compared pixel by pixel.
  test('desktop screenshots: Home, Decks, a gate page and the Owner tools disclosure', async ({ page }, testInfo) => {
    await open(page, '/', { catalog: 'demo', demoQa: DEMO_QA_CONFIG, demoRemainingToday: 12, boot: {} });
    await expect(page.getByTestId('home-episode')).toHaveCount(6);
    await page.screenshot({ path: testInfo.outputPath('home-desktop.png'), fullPage: true });
    await page.getByRole('button', { name: /^Owner tools/ }).click();
    await page.screenshot({ path: testInfo.outputPath('owner-tools-open.png'), clip: { x: 0, y: 0, width: 1280, height: 420 } });
    await page.goto('/decks');
    await expect(page.getByTestId('deck-card').first()).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('decks-desktop.png'), fullPage: true });
    await page.goto('/search');
    await expect(page.getByTestId('gated-panel')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('gate-search-desktop.png'), fullPage: true });
  });
});

test('[T1-13] a 401 toast offers the "Owner sign-in" text link, never a filled sign-in button', async ({ page }) => {
  await open(page, '/');
  await page.evaluate(() => window.dispatchEvent(
    new CustomEvent('app:auth-error', { detail: { status: 401, url: '/api/podcast/render' } }),
  ));
  const toast = page.getByTestId('auth-toast');
  await expect(toast).toBeVisible();
  await expect(toast.getByRole('link', { name: 'Owner sign-in' })).toBeVisible();
  await expect(toast.getByRole('button', { name: /sign in/i })).toHaveCount(0);
});
