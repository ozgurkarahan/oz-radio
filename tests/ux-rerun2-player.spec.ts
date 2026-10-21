import { test, expect as baseExpect, type Locator, type Page } from '@playwright/test';
import { MOCKED_MEDIA_REASON, mockApi, mockedMediaUnavailable } from './support/mock-api';

/**
 * UX re-run 2, player fixes. R7: the transcript reads as speaker turns (one label per turn, the cues flowing as one
 * paragraph, each cue still click-to-seek). R9: the mini-player's "Stop and close player" is available while playing.
 * Every /api call is mocked.
 */

const expect = baseExpect.configure({ timeout: 15_000 });
test.describe.configure({ timeout: 90_000 });

const VIDEO_TITLE = 'Agents on air'; // pod-2: radio cues 0:01–0:29 (see RADIO_TRANSCRIPT)

async function openLibrary(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await mockApi(page, 'visitor', { podcastV2: true });
  await page.goto('/podcast/library');
  return errors;
}

const dialog = (page: Page) => page.getByRole('dialog');
const radio = (page: Page) => dialog(page).getByTestId('radio-player');
const mini = (page: Page) => page.getByTestId('mini-player');
const audioTime = (page: Page) => page.getByTestId('radio-audio').evaluate((a: HTMLAudioElement) => a.currentTime);

async function listen(page: Page, tap: boolean) {
  const button = page.getByTestId('library-item').filter({ hasText: VIDEO_TITLE }).getByRole('button', { name: `Listen to ${VIDEO_TITLE}` });
  if (tap) await button.tap();
  else await button.click();
  await expect(radio(page)).toHaveAttribute('data-state', 'playing');
}

async function openTranscript(page: Page, tap: boolean) {
  const toggle = radio(page).getByTestId('radio-transcript-toggle');
  if (tap) await toggle.tap();
  else await toggle.click();
  await expect(radio(page).getByTestId('radio-cue').first()).toBeVisible();
}

const box = async (locator: Locator) => (await locator.boundingBox())!;

function transcriptSuite(tap: boolean) {
  test('[R7] the transcript groups the cues into speaker turns with one label each', async ({ page }) => {
    const errors = await openLibrary(page);
    await listen(page, tap);
    await openTranscript(page, tap);
    const turns = radio(page).getByTestId('radio-turn');
    await expect(turns).toHaveCount(4);
    await expect(radio(page).getByTestId('radio-turn-speaker')).toHaveText(['Sofia', 'Lucas', 'Sofia', 'Lucas']);
    await expect(radio(page).getByTestId('radio-cue')).toHaveCount(7);

    // Turn 0: two consecutive cues of one speaker → one paragraph, one name, the time of its first cue.
    const first = turns.nth(0);
    await expect(first.getByTestId('radio-cue')).toHaveCount(2);
    await expect(first).toHaveText('Sofia0:01Welcome to Oz Radio. Today we talk about agents.');
    // The accessible text (what a screen reader walks) does not repeat the speaker per cue.
    expect((await first.evaluate((el) => el.textContent)).match(/Sofia/g)).toHaveLength(1);

    // The cues of a turn flow in one paragraph: same line when they fit, never one row per cue.
    const [a, b] = [await box(first.getByTestId('radio-cue').nth(0)), await box(first.getByTestId('radio-cue').nth(1))];
    expect(Math.abs(a.y - b.y) < a.height || b.x > a.x, 'second cue follows the first inline').toBe(true);
    expect(await first.getByTestId('radio-cue').first().evaluate((el) => getComputedStyle(el).display)).toBe('inline');
    expect(await first.locator('p').count()).toBe(1);

    // A backchannel stays inside the turn it interrupts and keeps its own speaker + screen-reader suffix.
    const second = turns.nth(1);
    await expect(second.getByTestId('radio-cue')).toHaveCount(3);
    await expect(second.locator('[data-kind=reaction]')).toHaveText('Sofia · Mm-hmm. (reaction)');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(await page.evaluate(() => document.documentElement.clientWidth));
    expect(errors).toEqual([]);
  });

  test('[R7] each cue of a turn still seeks to its own start and carries the active highlight', async ({ page, browserName }) => {
    test.skip(mockedMediaUnavailable({ browserName }), MOCKED_MEDIA_REASON);
    const errors = await openLibrary(page);
    await listen(page, tap);
    await openTranscript(page, tap);
    const later = radio(page).getByTestId('radio-turn').nth(1).getByTestId('radio-cue').filter({ hasText: 'That loop is what makes them useful.' });
    if (tap) await later.tap();
    else await later.click();
    await expect.poll(() => audioTime(page)).toBeGreaterThanOrEqual(13.7);
    await expect(later).toHaveAttribute('aria-current', 'true');
    await expect(radio(page).locator('[aria-current=true][data-testid=radio-cue]')).toHaveCount(1);
    await expect(radio(page).getByTestId('radio-caption')).toHaveText('Lucas: That loop is what makes them useful.');
    expect(errors).toEqual([]);
  });

  test('[R7] a cue is keyboard-operable: Tab reaches it, Enter seeks', async ({ page, browserName }) => {
    test.skip(mockedMediaUnavailable({ browserName }), MOCKED_MEDIA_REASON);
    const errors = await openLibrary(page);
    await listen(page, tap);
    await openTranscript(page, tap);
    const cue = radio(page).getByTestId('radio-cue').filter({ hasText: 'So where should a team start?' });
    await expect(cue).toHaveAttribute('role', 'button');
    await cue.focus();
    await expect(cue).toBeFocused();
    await page.keyboard.press('Enter');
    await expect.poll(() => audioTime(page)).toBeGreaterThanOrEqual(19.2);
    await expect(cue).toHaveAttribute('aria-current', 'true');
    expect(errors).toEqual([]);
  });
}

function miniSuite(tap: boolean) {
  test('[R9] the mini-player can be closed while it is playing; focus lands on #main', async ({ page, browserName }) => {
    test.skip(mockedMediaUnavailable({ browserName }), MOCKED_MEDIA_REASON);
    const errors = await openLibrary(page);
    await listen(page, tap);
    const minimise = dialog(page).getByRole('button', { name: 'Minimise player' });
    if (tap) await minimise.tap();
    else await minimise.click();
    await expect(mini(page)).toBeVisible();
    await expect(mini(page).getByRole('button', { name: 'Pause', exact: true })).toBeVisible();

    const stop = mini(page).getByTestId('mini-player-stop');
    await expect(stop).toBeVisible();
    const s = await box(stop);
    const p = await box(mini(page).getByTestId('mini-player-play'));
    expect(s.width).toBeGreaterThanOrEqual(44);
    expect(s.height).toBeGreaterThanOrEqual(44);
    expect(s.x - (p.x + p.width), 'room between Play/Pause and Stop').toBeGreaterThanOrEqual(8);
    const bar = await box(mini(page));
    expect(s.x + s.width).toBeLessThanOrEqual(bar.x + bar.width);
    const viewportWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewportWidth);

    if (tap) await stop.tap();
    else await stop.click();
    await expect(mini(page)).toHaveCount(0);
    await expect(page.getByTestId('radio-audio')).toHaveCount(0);
    await expect(page.locator('#main')).toBeFocused();
    expect(errors).toEqual([]);
  });
}

test.describe('Desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false });
  transcriptSuite(false);
  miniSuite(false);
});

test.describe('Phone 412', () => {
  test.use({ isMobile: true, hasTouch: true, viewport: { width: 412, height: 839 } });
  transcriptSuite(true);
  miniSuite(true);
});

test.describe('Phone 360', () => {
  test.use({ isMobile: true, hasTouch: true, viewport: { width: 360, height: 740 } });

  test('[R9] the mini-player with Stop fits 360 px: the title truncates, nothing overflows', async ({ page, browserName }) => {
    test.skip(mockedMediaUnavailable({ browserName }), MOCKED_MEDIA_REASON);
    const errors = await openLibrary(page);
    await listen(page, true);
    await dialog(page).getByRole('button', { name: 'Minimise player' }).tap();
    await expect(mini(page)).toBeVisible();
    await expect(mini(page).getByTestId('mini-player-stop')).toBeVisible();

    const bar = await box(mini(page));
    expect(bar.x).toBe(0);
    expect(bar.width).toBe(360);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
    const open = await box(mini(page).getByTestId('mini-player-open'));
    const play = await box(mini(page).getByTestId('mini-player-play'));
    const stop = await box(mini(page).getByTestId('mini-player-stop'));
    expect(open.x + open.width).toBeLessThanOrEqual(play.x);
    expect(play.x + play.width).toBeLessThanOrEqual(stop.x);
    expect(stop.x + stop.width).toBeLessThanOrEqual(360);
    expect(stop.width).toBeGreaterThanOrEqual(44);
    expect(errors).toEqual([]);
  });
});
