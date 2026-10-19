import { test, expect as baseExpect, type Page } from '@playwright/test';
import {
  MOCKED_MEDIA_REASON, mockApi, mockedMediaUnavailable, type MockApiOptions,
} from './support/mock-api';

/**
 * UX-fix run, WU-E "Listen & watch": the phone half of tests/ux-listen-watch.spec.ts (a-11y finding P1-4, C2.3 on a phone,
 * durations on a phone). It is named `mobile-*` so the `mobile-chromium` / `mobile-webkit` projects pick it up: a mobile
 * project keeps its own device (Pixel 7 / iPhone 15), a desktop project runs it on a 412 × 839 touch phone (the Pixel 7's
 * CSS size, where the audit measured 7 of 12 transcript cues hidden behind the dock).
 *
 * Every /api call is mocked (tests/support/mock-api.ts); media are real fixtures served with byte ranges. Screenshots are
 * viewport-only (`fullPage` drops touch emulation).
 */

const expect = baseExpect.configure({ timeout: 15_000 });
test.describe.configure({ timeout: 90_000 });

const PHONE_VIEWPORT = { width: 412, height: 839 };
const VIDEO_TITLE = 'Agents on air'; // pod-2: video + radio, 7 cues
const AUDIO_TITLE = 'Safety minute'; // pod-3: audio only, French, beginner
const NARRATED_TITLE = 'Context engineering rag'; // vid-1: narrated video, practitioner

test.use({
  isMobile: true,
  hasTouch: true,
  // Keep a mobile project's device screen; a desktop project (1280 × 720) gets a phone.
  viewport: async ({ viewport }, use) => use(viewport && viewport.width <= 480 ? viewport : PHONE_VIEWPORT),
});
test.skip(({ browserName }) => browserName === 'firefox', 'Firefox has no isMobile emulation');

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => {
    const text = String(e);
    // WebKit on Windows sometimes fails a routed (mocked) fetch with this message; it is the test harness, not the page
    // (the same happens on the pre-run baseline). Any other error still fails the test.
    if (/Fetch API cannot load .+ due to access control checks\./.test(text)) return;
    errors.push(text);
  });
  return errors;
}

async function openLibrary(page: Page, opts: MockApiOptions = {}, path = '/podcast/library') {
  const errors = collectErrors(page);
  await mockApi(page, 'visitor', { podcastV2: true, ...opts });
  await page.goto(path);
  return errors;
}

const rowOf = (page: Page, title: string) => page.getByTestId('library-item').filter({ hasText: title });
const dialog = (page: Page) => page.getByRole('dialog');
const radio = (page: Page) => dialog(page).getByTestId('radio-player');
const listenButton = (page: Page, title: string) => rowOf(page, title).getByRole('button', { name: `Listen to ${title}` });

/** Where a focused element sits relative to the parts of the sheet that are pinned over the transcript. */
async function focusReport(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    const rect = (e: Element | null) => (e ? e.getBoundingClientRect() : null);
    const dock = rect(document.querySelector('.radio-player__dock'));
    const tabs = rect(document.querySelector('.library-player__formats'));
    const close = rect(document.querySelector('.library-player--podcast .modal__close'));
    const r = el ? el.getBoundingClientRect() : null;
    const overlap = (a: DOMRect | null, b: DOMRect | null) => (a && b ? Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)) : 0);
    return {
      isCue: !!el?.matches('.radio-player__cue'),
      text: el?.textContent?.trim().slice(0, 40) ?? '',
      top: r?.top ?? 0, bottom: r?.bottom ?? 0,
      underDock: overlap(r, dock), underTabs: overlap(r, tabs), underClose: overlap(r, close),
      viewport: window.innerHeight,
    };
  });
}

test.describe('The Listen sheet on a phone', () => {
  test.skip(mockedMediaUnavailable, MOCKED_MEDIA_REASON);

  async function openSheetWithTranscript(page: Page) {
    await listenButton(page, VIDEO_TITLE).tap();
    const player = radio(page);
    await expect(player).toHaveAttribute('data-state', 'playing');
    // Let it play a moment: a player paused at 0:00 is "ready to play", not "paused".
    await expect.poll(() => page.getByTestId('radio-audio').evaluate((a: HTMLAudioElement) => a.currentTime)).toBeGreaterThan(0.6);
    await expect(player.getByTestId('radio-time')).not.toHaveText(/^0:00 /);
    await player.getByTestId('radio-play').tap(); // paused: the active cue no longer moves the list
    await expect(player).toHaveAttribute('data-state', 'paused');
    await player.getByTestId('radio-transcript-toggle').tap();
    await expect(player.getByTestId('radio-cue')).toHaveCount(7);
    return player;
  }

  test('P1-4: every transcript cue that takes keyboard focus is fully visible — never under the dock, the tabs or the minimise button', async ({ page, browserName }, testInfo) => {
    test.skip(browserName === 'webkit', 'WebKit\'s Tab key skips buttons (Safari\'s default: "Press Tab to highlight each item" is off)');
    const errors = await openLibrary(page);
    const player = await openSheetWithTranscript(page);
    const dockHeight = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--rp-dock-h')));
    expect(dockHeight, 'the dock publishes its height for the sheet\'s scroll-padding').toBeGreaterThan(100);
    expect(await player.locator('.radio-player__dock').evaluate((el) => getComputedStyle(el).position)).toBe('sticky');

    // Tab from the transcript toggle through every cue, and back with Shift+Tab.
    await player.getByTestId('radio-transcript-toggle').focus();
    const seen: Awaited<ReturnType<typeof focusReport>>[] = [];
    for (let i = 0; i < 7; i += 1) {
      await page.keyboard.press('Tab');
      await page.waitForTimeout(120);
      seen.push(await focusReport(page));
    }
    for (let i = 0; i < 5; i += 1) {
      await page.keyboard.press('Shift+Tab');
      await page.waitForTimeout(120);
      seen.push(await focusReport(page));
    }
    const cues = seen.filter((s) => s.isCue);
    expect(cues.length, 'cues reached by keyboard').toBeGreaterThanOrEqual(7);
    for (const s of cues) {
      expect(s.underDock, `"${s.text}" under the dock`).toBeLessThanOrEqual(0.5);
      expect(s.underTabs, `"${s.text}" under the format tabs`).toBeLessThanOrEqual(0.5);
      expect(s.underClose, `"${s.text}" under the minimise button`).toBeLessThanOrEqual(0.5);
      expect(s.top, `"${s.text}" is on screen`).toBeGreaterThanOrEqual(0);
      expect(s.bottom, `"${s.text}" is on screen`).toBeLessThanOrEqual(s.viewport);
    }
    await testInfo.attach('sheet-with-focused-cue.png', { body: await page.screenshot(), contentType: 'image/png' });
    expect(errors).toEqual([]);
  });

  test('P1-4 control: without the sheet\'s scroll-padding the same cues do hide behind the dock (the probe can fail)', async ({ page, browserName }) => {
    test.skip(browserName === 'webkit', 'WebKit\'s Tab key skips buttons (Safari\'s default: "Press Tab to highlight each item" is off)');
    const errors = await openLibrary(page);
    const player = await openSheetWithTranscript(page);
    await page.addStyleTag({ content: '.modal__panel.library-player--podcast { scroll-padding: 0 !important; }' });
    await player.getByTestId('radio-transcript-toggle').focus();
    let hidden = 0;
    for (let i = 0; i < 7; i += 1) {
      await page.keyboard.press('Tab');
      await page.waitForTimeout(120);
      const s = await focusReport(page);
      if (s.isCue && (s.underDock > 0.5 || s.underTabs > 0.5 || s.underClose > 0.5)) hidden += 1;
    }
    expect(hidden, 'cues hidden without the fix').toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });

  test('the header shows the language and level and every control stays inside the screen', async ({ page }) => {
    const errors = await openLibrary(page);
    await listenButton(page, AUDIO_TITLE).tap();
    const player = radio(page);
    await expect(player).toHaveAttribute('data-state', 'playing');
    await expect(player.getByTestId('radio-level')).toBeVisible();
    await expect(player.getByTestId('radio-language')).toBeVisible();
    const width = (await page.viewportSize())!.width;
    for (const id of ['radio-level', 'radio-language', 'radio-play']) {
      const box = (await player.getByTestId(id).boundingBox())!;
      expect(box.x, id).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, id).toBeLessThanOrEqual(width);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    expect(errors).toEqual([]);
  });
});

test.describe('The libraries on a phone', () => {
  test('rows show the audience level and the duration', async ({ page }) => {
    const errors = await openLibrary(page);
    await expect(rowOf(page, AUDIO_TITLE).getByTestId('episode-level')).toBeVisible();
    await expect(rowOf(page, AUDIO_TITLE).locator('.episode-row__dur')).toBeVisible();
    await expect(rowOf(page, VIDEO_TITLE).locator('.episode-row__dur')).toBeVisible();
    await page.goto('/video/library');
    await expect(rowOf(page, NARRATED_TITLE).getByTestId('episode-level')).toBeVisible();
    await expect(rowOf(page, NARRATED_TITLE).getByTestId('library-duration')).toBeVisible();
    await expect(rowOf(page, NARRATED_TITLE).locator('.episode-row__dur')).toBeHidden();
    const width = (await page.viewportSize())!.width;
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    expect(errors).toEqual([]);
  });

  test('a failed list and a gone episode fit the screen and keep their actions reachable', async ({ page }) => {
    const errors = collectErrors(page);
    await mockApi(page, 'visitor', { podcastV2: true, libraryFailure: { podcast: 503 } });
    await page.goto('/podcast/library');
    const failure = page.getByTestId('library-error');
    await expect(failure.getByRole('button', { name: 'Try again' })).toBeVisible();
    await expect(failure.getByRole('link', { name: 'Browse decks' })).toBeVisible();
    const width = (await page.viewportSize())!.width;
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    for (const link of await failure.getByRole('link').all()) {
      const box = (await link.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(box.height, 'thumb-sized').toBeGreaterThanOrEqual(44);
    }
    expect(errors).toEqual([]);
  });
});
