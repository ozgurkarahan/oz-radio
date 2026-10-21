import { devices, expect as baseExpect, test, type Page, type TestInfo } from '@playwright/test';
import { DEMO_DECK_EN, DEMO_QA_CONFIG, mockApi, mockBoot } from './support/mock-api';
import { demoHooks, mockDemoSocket } from './support/demo-ws-fixtures';

// The shared dev server and the machine are busy during the fleet run: a cold module graph can take seconds to paint.
const expect = baseExpect.configure({ timeout: 15_000 });
test.describe.configure({ timeout: 90_000 });

/**
 * WU-C2 — two layout defects the C3.3 verifier found (fleet/verify/failure-states, "Other findings"). Mocked: no backend.
 *
 *   [D1] T3-12  the narration-limit card: its recording link (ghost, a long "Watch … · Language · 3:12" label) must wrap
 *               inside the card instead of keeping the base `.btn` nowrap (425 px in a 345 px row on a Pixel 7: cut off at
 *               459 px; 1369 px on a 1366 px desktop: a horizontal scroll)
 *   [D2] T2-06 / T2-08  the library player's "couldn't be played" alert must clear the modal's Close button on a phone
 *               (the alert started at 48 px, the 44 px Close button ends at 56 px: they overlapped by 8 px); the desktop
 *               look (48 px) is unchanged. T2-07 (the podcast Watch tab) is checked too: its Close button sits in the sheet's
 *               top bar, so it never overlapped, and still does not
 *
 * Phones emulate a Pixel 7 inside the chromium project (the mobile-chromium project does not match this file) and take
 * viewport screenshots only (`fullPage` drops touch emulation). Each fix has a control: with the old rule injected back the
 * same measurement fails, so the checks are not vacuous.
 */

const { defaultBrowserType: _phoneBrowser, ...PIXEL_7 } = devices['Pixel 7'];
// Spelled out, so a "desktop" test is a mouse on a 1366×768 window whatever device the project it runs in emulates.
const { defaultBrowserType: _desktopBrowser, ...DESKTOP } = devices['Desktop Chrome'];
const DESKTOP_1366 = { ...DESKTOP, viewport: { width: 1366, height: 768 } };

interface Box { left: number; right: number; top: number; bottom: number; width: number; height: number }

/** A viewport screenshot kept with the test output (never fullPage: it drops touch emulation on the phone). */
const shot = (page: Page, testInfo: TestInfo, name: string) => page.screenshot({ path: testInfo.outputPath(`${name}.png`) });

const round = (box: Box) => Object.fromEntries(Object.entries(box).map(([key, value]) => [key, Math.round(value)]));

/** Records what was measured with the test (and in the run log), so a before / after comparison can be read back. */
function report(testInfo: TestInfo, what: string, data: unknown) {
  const text = JSON.stringify(data);
  testInfo.annotations.push({ type: what, description: text });
  console.log(`[fit] ${what} ${text}`);
}

// ── D1 · T3-12 the narration-limit card ─────────────────────────────────────────────────────────────

const demoSource = { catalog: 'demo' as const, demoQa: DEMO_QA_CONFIG, demoSessionSeconds: 300 };

/** The live demo hits the session's narration limit on its first narration request: "Ask a question" / "Finish demo" and the recording. */
async function reachNarrationLimit(page: Page) {
  await mockApi(page, 'visitor', demoSource);
  await mockBoot(page, {}, demoSource);
  const mock = await mockDemoSocket(page, {
    slideCount: DEMO_DECK_EN.slide_count, sessionSeconds: 300, idleCloseMs: false, speak: 'speak_limit',
  });
  await page.goto('/decks/deck-demo-en/present');
  await page.getByTestId('demo-start').click();
  await expect.poll(() => mock.connections).toBe(1);
  await demoHooks.connected(page);
  await expect(page.getByTestId('demo-narration-done')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('demo-done-recording')).toBeVisible();
}

/** Where the actions of the card are, against the card, its row and the viewport. */
function measureCard(page: Page) {
  return page.evaluate(() => {
    const box = (el: Element): Box => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    const card = document.querySelector('[data-testid=demo-narration-done]')!;
    const link = document.querySelector<HTMLElement>('[data-testid=demo-done-recording]')!;
    const actions = card.querySelector('.demo-done__actions')!;
    const others = ['demo-ask', 'demo-finish'].map((id) => document.querySelector(`[data-testid=${id}]`)).filter((el): el is Element => !!el);
    return {
      viewport: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      card: box(card),
      actions: box(actions),
      link: box(link),
      others: others.map(box),
      whiteSpace: getComputedStyle(link).whiteSpace,
      // Text that overflows its own box (a nowrap label in a capped box) is clipped without the box showing it.
      textClipped: link.scrollWidth > link.clientWidth + 1,
    };
  });
}

type CardFit = Awaited<ReturnType<typeof measureCard>>;

function expectLinkFits(m: CardFit) {
  expect(m.whiteSpace, 'the long label may wrap').toBe('normal');
  expect(m.link.width).toBeGreaterThan(0);
  expect(m.link.left, 'the link starts inside the card').toBeGreaterThanOrEqual(m.card.left - 0.5);
  expect(m.link.right, 'the link ends inside the card').toBeLessThanOrEqual(m.card.right + 0.5);
  expect(m.link.right, 'the link ends inside the viewport').toBeLessThanOrEqual(m.viewport + 0.5);
  expect(m.textClipped, 'no part of the label is cut off').toBe(false);
  for (const other of m.others) {
    expect(other.right, 'Ask a question / Finish demo stay inside the card').toBeLessThanOrEqual(m.card.right + 0.5);
  }
  expect(m.scrollWidth, 'no horizontal scroll').toBeLessThanOrEqual(m.clientWidth);
}

/** The rule the card had before: the base `.btn` nowrap, no cap on the width. */
const OLD_NOWRAP = '.demo-done__actions .btn { white-space: nowrap !important; max-width: none !important; }';

async function checkNarrationLimitFit(page: Page, testInfo: TestInfo, name: string) {
  await reachNarrationLimit(page);
  const fixed = await measureCard(page);
  report(testInfo, `${name} (wrapping)`, {
    card: round(fixed.card), link: round(fixed.link), viewport: fixed.viewport, scrollWidth: fixed.scrollWidth, clientWidth: fixed.clientWidth,
  });
  expectLinkFits(fixed);
  await page.getByTestId('demo-narration-done').scrollIntoViewIfNeeded();
  await shot(page, testInfo, name);

  // Control: the old rule on the same card does overflow it, so the measurement above can fail.
  await page.addStyleTag({ content: OLD_NOWRAP });
  const old = await measureCard(page);
  report(testInfo, `${name} (old rule: nowrap)`, {
    card: round(old.card), link: round(old.link), viewport: old.viewport, scrollWidth: old.scrollWidth, clientWidth: old.clientWidth,
  });
  expect(old.link.right, 'control: nowrap overflows the card').toBeGreaterThan(old.card.right + 0.5);
}

test.describe('[D1] the narration-limit card (T3-12)', () => {
  test.describe('phone (Pixel 7 viewport)', () => {
    test.use({ ...PIXEL_7 });

    test('[T3-12] the recording link wraps inside its card: nothing is cut off at the edge of the screen', async ({ page }, testInfo) => {
      await checkNarrationLimitFit(page, testInfo, 'narration-limit-phone');
    });
  });

  test.describe('desktop (1366×768)', () => {
    test.use(DESKTOP_1366);

    test('[T3-12] the recording link stays inside its card and the page does not scroll sideways', async ({ page }, testInfo) => {
      await checkNarrationLimitFit(page, testInfo, 'narration-limit-desktop');
    });
  });
});

// ── D2 · T2-06 / T2-08 the video problem panel and the Close button ─────────────────────────────────

const EXPIRED_XML = '<Error><Code>AuthenticationFailed</Code></Error>';

/** The video of the library cannot be played: the media link answers 403 (expired), also after the one automatic refresh. */
async function openVideoWithMediaError(page: Page) {
  await mockApi(page, 'visitor');
  await page.route('**/media/vid-1.mp4', (route) => route.fulfill({ status: 403, contentType: 'application/xml', body: EXPIRED_XML }));
  await page.goto('/video/library');
  await page.getByTestId('library-item').first().getByRole('button', { name: /^Play / }).click();
}

/** The video has no playable rendition at all (no `video_url`). */
async function openVideoWithoutRendition(page: Page) {
  await mockApi(page, 'visitor');
  await page.route('**/api/video/library/vid-1', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      job_id: 'vid-1', title: 'context-engineering-rag', language: 'en-US', created_at: '2026-10-15T00:05:00Z', thumbnail_url: null,
      duration_sec: 98, slide_count: 6, published: true, audience_level: 'practitioner', source_deck_id: null,
      captions_vtt_url: '/api/video/library/vid-1/captions.vtt', video_url: null,
    }),
  }));
  await page.goto('/video/library');
  await page.getByTestId('library-item').first().getByRole('button', { name: /^Play / }).click();
}

/** The Close button of the player and the alert of the problem panel, and the panel's own top padding. */
function measureProblem(page: Page) {
  return page.evaluate(() => {
    const box = (el: Element): Box => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    const dialog = document.querySelector('[role=dialog]')!;
    const close = dialog.querySelector('button[aria-label="Close"]')!;
    const panel = dialog.querySelector('[data-testid=video-problem]')!;
    const alert = panel.querySelector('[role=alert]')!;
    // Hit-test the lower-left quadrant of the Close button: does a tap there still reach it?
    const rc = close.getBoundingClientRect();
    const hit = document.elementFromPoint(rc.left + rc.width * 0.25, rc.top + rc.height * 0.85);
    return {
      close: box(close),
      alert: box(alert),
      paddingTop: getComputedStyle(panel).paddingTop,
      lowerLeftTapReachesClose: !!hit && (hit === close || close.contains(hit)),
    };
  });
}

type ProblemFit = Awaited<ReturnType<typeof measureProblem>>;

/** Pixels the two boxes share (0 when they only touch or are apart). */
function overlapArea(a: Box, b: Box): number {
  const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return width > 0 && height > 0 ? width * height : 0;
}

function expectAlertClearsClose(m: ProblemFit) {
  expect(overlapArea(m.alert, m.close), 'the alert and the Close button do not intersect').toBe(0);
  expect(m.alert.top, 'the alert starts below the Close button').toBeGreaterThanOrEqual(m.close.bottom);
  expect(m.lowerLeftTapReachesClose, 'a tap on the Close button reaches it').toBe(true);
}

/** The padding the panel had before (`var(--sp-7)`, 48 px). */
const OLD_PADDING = '.library-player__problem { padding-top: var(--sp-7) !important; }';

test.describe('[D2] the video problem panel and the Close button (T2-06, T2-07, T2-08)', () => {
  test.describe('phone (Pixel 7 viewport)', () => {
    test.use({ ...PIXEL_7 });

    test('[T2-06] a media error: the alert starts below the Close button', async ({ page }, testInfo) => {
      await openVideoWithMediaError(page);
      await expect(page.getByRole('dialog').getByTestId('video-problem')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole('dialog').getByTestId('video-problem')).toHaveAttribute('data-kind', 'failed');
      expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), 'the Pixel 7 emulation is a touch screen').toBe(true);

      const fixed = await measureProblem(page);
      report(testInfo, 'video-problem-phone (fixed)', { close: round(fixed.close), alert: round(fixed.alert), paddingTop: fixed.paddingTop });
      expectAlertClearsClose(fixed);
      expect(fixed.close.height, 'the Close button is the full touch target').toBeGreaterThanOrEqual(44);
      await shot(page, testInfo, 'video-problem-phone');

      // Control: the old padding on the same panel no longer reaches the Close button: the modal reserves a top bar for it.
      await page.addStyleTag({ content: OLD_PADDING });
      const old = await measureProblem(page);
      report(testInfo, 'video-problem-phone (old padding)', { close: round(old.close), alert: round(old.alert), paddingTop: old.paddingTop });
      expect(old.paddingTop).toBe('48px');
      expect(overlapArea(old.alert, old.close), 'the reserved top bar keeps even 48 px of padding clear of the Close button').toBe(0);
    });

    test('[T2-08] a video without a playable rendition: the alert starts below the Close button', async ({ page }, testInfo) => {
      await openVideoWithoutRendition(page);
      const panel = page.getByRole('dialog').getByTestId('video-problem');
      await expect(panel).toBeVisible({ timeout: 30_000 });
      await expect(panel).toHaveAttribute('data-kind', 'unavailable');
      const m = await measureProblem(page);
      report(testInfo, 'video-unavailable-phone', { close: round(m.close), alert: round(m.alert), paddingTop: m.paddingTop });
      expectAlertClearsClose(m);
      await shot(page, testInfo, 'video-unavailable-phone');
    });

    test('[T2-07] a podcast episode on Watch: the alert is clear of the Close button too', async ({ page }, testInfo) => {
      await mockApi(page, 'visitor', { podcastV2: true });
      await page.route('**/media/pod-2.mp4', (route) => route.fulfill({ status: 403, contentType: 'application/xml', body: EXPIRED_XML }));
      await page.goto('/podcast/library');
      const row = page.getByTestId('library-item').filter({ hasText: 'Agents on air' });
      await expect(row).toBeVisible();
      await row.getByRole('button', { name: 'Watch Agents on air' }).click();
      const panel = page.getByRole('dialog').getByTestId('video-problem');
      await expect(panel).toBeVisible({ timeout: 30_000 });
      const m = await measureProblem(page);
      report(testInfo, 'podcast-watch-problem-phone', { close: round(m.close), alert: round(m.alert), paddingTop: m.paddingTop });
      expectAlertClearsClose(m);
      await shot(page, testInfo, 'podcast-watch-problem-phone');
    });
  });

  test.describe('desktop (1366×768)', () => {
    test.use(DESKTOP_1366);

    test('[T2-06] the desktop look is unchanged: 48 px above the alert, and it still clears the Close button', async ({ page }, testInfo) => {
      await openVideoWithMediaError(page);
      await expect(page.getByRole('dialog').getByTestId('video-problem')).toBeVisible({ timeout: 30_000 });
      const m = await measureProblem(page);
      report(testInfo, 'video-problem-desktop', { close: round(m.close), alert: round(m.alert), paddingTop: m.paddingTop });
      expect(m.paddingTop, 'a mouse pointer keeps the 48 px of padding').toBe('48px');
      expectAlertClearsClose(m);
      await shot(page, testInfo, 'video-problem-desktop');
    });
  });
});
