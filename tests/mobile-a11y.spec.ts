import { test, expect as baseExpect, type Locator, type Page, type TestInfo } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mockApi } from './support/mock-api';

/**
 * Accessibility gates of the phone listening experience (WCAG 2.2 AA).
 *
 * - axe-core (wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa) finds no serious or critical
 *   violation on the podcast library, the open Listen sheet and Home with the mini-player.
 * - What axe cannot measure: the mini-player's and the sheet's transport buttons are
 *   thumb-sized (≥ 44 × 44 px: Apple HIG, WCAG 2.5.5), and the fixed mini-player never hides
 *   the focused element while tabbing to the last link of the page (WCAG 2.4.11).
 *
 * Phones: a mobile-* project keeps its device (iPhone 15 / Pixel 7); desktop projects run on a
 * 390 × 844 touch phone. Every /api call is mocked (tests/support/mock-api.ts); media are real
 * fixtures served with byte ranges, so the radio genuinely plays.
 */

const expect = baseExpect.configure({ timeout: 15_000 });
test.describe.configure({ timeout: 90_000 });

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const BLOCKING = new Set(['serious', 'critical']);
const MIN_TARGET = 44;
/** pod-2: 30-s radio MP3, nothing after it in its language (no auto-next during a test). */
const TITLE = 'Agents on air';
const PHONE_VIEWPORT = { width: 390, height: 844 };
const MEDIA_UNPLAYABLE = 'Playwright WebKit on Windows plays media through Windows Media Foundation, which fetches '
  + 'media URLs itself: page.route() never sees them, so the mocked /media fixtures cannot play there';

test.use({
  isMobile: true,
  hasTouch: true,
  // Keep a mobile project's device screen; desktop projects (1280 × 720) get a phone.
  viewport: async ({ viewport }, use) => use(viewport && viewport.width <= 480 ? viewport : PHONE_VIEWPORT),
});
test.skip(({ browserName }) => browserName === 'firefox', 'Firefox has no isMobile emulation');

const dialog = (page: Page) => page.getByRole('dialog');
const sheetPlayer = (page: Page) => dialog(page).getByTestId('radio-player');
const mini = (page: Page) => page.getByTestId('mini-player');
const radioAudio = (page: Page) => page.getByTestId('radio-audio');
const audioTime = (page: Page) => radioAudio(page).evaluate((a: HTMLAudioElement) => a.currentTime);

async function open(page: Page, path: string) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await mockApi(page, 'visitor', { podcastV2: true });
  await page.goto(path);
  return errors;
}

async function openLibrary(page: Page) {
  const errors = await open(page, '/podcast/library');
  await expect(page.getByTestId('library-item')).toHaveCount(3);
  return errors;
}

/** Taps Listen on the episode's row: the Now Playing sheet opens and the radio plays. */
async function startEpisode(page: Page) {
  await page.getByTestId('library-item').filter({ hasText: TITLE })
    .getByRole('button', { name: `Listen to ${TITLE}` }).tap();
  await expect(sheetPlayer(page)).toHaveAttribute('data-state', 'playing');
  const from = await audioTime(page);
  await expect.poll(() => audioTime(page)).toBeGreaterThan(from + 0.3);
}

/** "Minimise player" on the sheet, then Home (client-side, the radio keeps playing). */
async function homeWithMiniPlayer(page: Page) {
  await dialog(page).getByRole('button', { name: 'Minimise player' }).tap();
  await expect(dialog(page)).toHaveCount(0);
  await page.getByRole('link', { name: 'Oz Radio home' }).tap();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(mini(page)).toBeVisible();
  await expect(mini(page).getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
}

function describeViolations(violations: { id: string; impact?: string | null; help: string; helpUrl: string; nodes: { target: unknown[]; failureSummary?: string }[] }[]) {
  return violations.map((v) => [
    `[${v.impact}] ${v.id} — ${v.help} (${v.helpUrl})`,
    ...v.nodes.slice(0, 8).map((n) => `    ${n.target.map(String).join(' ')}\n      ${(n.failureSummary ?? '').replace(/\n/g, '\n      ')}`),
    ...(v.nodes.length > 8 ? [`    … and ${v.nodes.length - 8} more`] : []),
  ].join('\n')).join('\n');
}

/** Runs axe on the page; fails on any serious/critical violation (listed in the message). */
async function expectNoBlockingViolations(page: Page, testInfo: TestInfo, label: string) {
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  await testInfo.attach(`axe-${label}.json`, {
    body: JSON.stringify(results.violations, null, 2), contentType: 'application/json',
  });
  const blocking = results.violations.filter((v) => BLOCKING.has(v.impact ?? ''));
  const other = results.violations.filter((v) => !BLOCKING.has(v.impact ?? ''));
  if (other.length > 0) {
    testInfo.annotations.push({ type: 'axe (not blocking)', description: `${label}: ${other.map((v) => `${v.id} [${v.impact}]`).join(', ')}` });
  }
  expect(blocking.map((v) => `${v.id} [${v.impact}]`), `serious/critical axe violations on ${label}:\n${describeViolations(blocking)}`)
    .toEqual([]);
}

async function expectThumbSized(target: Locator, name: string) {
  await expect(target, name).toBeVisible();
  const box = await target.boundingBox();
  expect(box, `${name} has a box`).not.toBeNull();
  const round = (v: number) => Math.round(v * 100) / 100;
  expect(round(box!.width), `${name} width`).toBeGreaterThanOrEqual(MIN_TARGET);
  expect(round(box!.height), `${name} height`).toBeGreaterThanOrEqual(MIN_TARGET);
}

test('the podcast library has no serious or critical axe violations', async ({ page }, testInfo) => {
  const errors = await openLibrary(page);
  await expectNoBlockingViolations(page, testInfo, 'podcast library');
  expect(errors).toEqual([]);
});

test.describe('with an episode playing', () => {
  test.skip(({ browserName }) => browserName === 'webkit' && process.platform === 'win32', MEDIA_UNPLAYABLE);

  test('the open Listen sheet has no serious or critical axe violations', async ({ page }, testInfo) => {
    const errors = await openLibrary(page);
    await startEpisode(page);
    await expect(dialog(page)).toHaveAttribute('data-mode', 'listen');
    await expectNoBlockingViolations(page, testInfo, 'Listen sheet');
    expect(errors).toEqual([]);
  });

  test('Home with the mini-player has no serious or critical axe violations', async ({ page }, testInfo) => {
    const errors = await openLibrary(page);
    await startEpisode(page);
    await homeWithMiniPlayer(page);
    await expectNoBlockingViolations(page, testInfo, 'Home with the mini-player');
    expect(errors).toEqual([]);
  });

  test('the sheet and mini-player transport buttons are at least 44 × 44 px', async ({ page }) => {
    const errors = await openLibrary(page);
    await startEpisode(page);
    const player = sheetPlayer(page);
    await expectThumbSized(player.getByRole('button', { name: 'Back 15 seconds' }), 'sheet: Back 15 seconds');
    await expectThumbSized(player.getByRole('button', { name: 'Pause', exact: true }), 'sheet: Pause');
    await expectThumbSized(player.getByRole('button', { name: 'Forward 15 seconds' }), 'sheet: Forward 15 seconds');
    await expectThumbSized(dialog(page).getByRole('button', { name: 'Minimise player' }), 'sheet: Minimise player');

    await dialog(page).getByRole('button', { name: 'Minimise player' }).tap();
    await expect(mini(page)).toBeVisible();
    await expectThumbSized(mini(page).getByRole('button', { name: `Open now playing: ${TITLE}` }), 'mini-player: Open now playing');
    const pause = mini(page).getByRole('button', { name: 'Pause', exact: true });
    await expectThumbSized(pause, 'mini-player: Pause');
    await pause.tap();
    await expectThumbSized(mini(page).getByRole('button', { name: 'Play', exact: true }), 'mini-player: Play');
    await expectThumbSized(mini(page).getByRole('button', { name: 'Stop and close player' }), 'mini-player: Stop and close player');
    expect(errors).toEqual([]);
  });

  test('tabbing to the last link never leaves focus behind the mini-player (WCAG 2.4.11)', async ({ page, browserName }) => {
    test.skip(browserName === 'webkit', 'WebKit\'s Tab key skips links (Safari\'s default: "Press Tab to highlight each item" is off)');
    const errors = await openLibrary(page);
    await startEpisode(page);
    await homeWithMiniPlayer(page);
    const bar = (await mini(page).boundingBox())!;
    const lastLink = page.locator('a[href]:visible').last();
    await expect(lastLink).toBeVisible();
    await lastLink.evaluate((el) => { el.setAttribute('data-oz-last-link', ''); });

    await page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
      window.scrollTo(0, 0);
    });
    let reached = false;
    for (let stop = 0; stop < 80 && !reached; stop += 1) {
      await page.keyboard.press('Tab');
      const focused = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return null;
        const r = el.getBoundingClientRect();
        const name = el.getAttribute('aria-label') || el.textContent?.trim().replace(/\s+/g, ' ').slice(0, 60) || '';
        return {
          label: `<${el.tagName.toLowerCase()}> "${name}"`, bottom: r.bottom, inBar: !!el.closest('[data-testid="mini-player"]'),
          last: el.hasAttribute('data-oz-last-link'),
        };
      });
      if (!focused) continue;
      expect(focused.inBar, `reached the mini-player before the last link (${focused.label})`).toBe(false);
      expect(focused.bottom, `${focused.label} is hidden behind the mini-player`).toBeLessThanOrEqual(bar.y + 0.5);
      reached = focused.last;
    }
    expect(reached, 'Tab reached the last link of the page').toBe(true);
    expect(errors).toEqual([]);
  });
});
