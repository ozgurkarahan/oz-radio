import { test, expect as baseExpect, type Page } from '@playwright/test';
import { MOCKED_MEDIA_REASON, mockApi, mockedMediaUnavailable, type MockApiOptions } from './support/mock-api';

/**
 * UX re-review, "Listen & watch" fixes: one status while loading, per-format durations, one button variant on every row,
 * initial focus on Play, the compact reading dock on phones, and recording titles. Every /api call is mocked.
 */

const expect = baseExpect.configure({ timeout: 15_000 });
test.describe.configure({ timeout: 90_000 });

const VIDEO_TITLE = 'Agents on air'; // pod-2: Watch 0:40, Listen 0:30
const AUDIO_TITLE = 'Safety minute'; // pod-3: audio only, 0:06
const FR_RECORDING = 'L’IA en trois minutes · Démo enregistrée'; // pod-demo-fr, stored as "… · Démo en direct"

async function openLibrary(page: Page, path = '/podcast/library', opts: MockApiOptions = {}) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await mockApi(page, 'visitor', { podcastV2: true, ...opts });
  await page.goto(path);
  return errors;
}

const rowOf = (page: Page, title: string) => page.getByTestId('library-item').filter({ hasText: title });
const dialog = (page: Page) => page.getByRole('dialog');
const radio = (page: Page) => dialog(page).getByTestId('radio-player');

test.describe('Desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false });

  test('[S5] the sheet never shows "Loading…" together with the Playing pill', async ({ page, browserName }) => {
    test.skip(mockedMediaUnavailable({ browserName }), MOCKED_MEDIA_REASON);
    const errors = await openLibrary(page);
    await page.evaluate(() => {
      const w = window as unknown as { __samples: { status: string; on: boolean; hint: boolean }[] };
      w.__samples = [];
      const tick = () => {
        const status = document.querySelector('[data-testid=radio-speaker]')?.textContent?.trim();
        if (status) {
          w.__samples.push({
            status,
            on: !!document.querySelector('.radio-player__onair.is-on'),
            hint: !!document.querySelector('.radio-player__caption-hint'),
          });
        }
        requestAnimationFrame(tick);
      };
      tick();
    });
    await rowOf(page, VIDEO_TITLE).getByTestId('library-listen').click();
    await expect(radio(page)).toHaveAttribute('data-state', 'playing');
    await page.waitForTimeout(800);
    const samples = await page.evaluate(
      () => (window as unknown as { __samples: { status: string; on: boolean; hint: boolean }[] }).__samples,
    );
    expect(samples.length).toBeGreaterThan(0);
    expect(samples.filter((s) => s.status === 'Loading…' && s.on)).toEqual([]);
    // The "Live captions appear here." hint is not shown before playback starts.
    expect(samples.filter((s) => s.status !== 'Playing' && /Loading|Ready|Press play/.test(s.status) && s.hint)).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('[S11] audio and video lengths that differ are labelled per format; equal ones stay a single length', async ({ page }) => {
    await openLibrary(page);
    const durations = rowOf(page, VIDEO_TITLE).getByTestId('library-durations');
    await expect(durations).toContainText('Listen 0:30');
    await expect(durations).toContainText('Watch 0:40');
    const audioRow = rowOf(page, AUDIO_TITLE);
    await expect(audioRow.getByTestId('library-durations')).toHaveCount(0);
    await expect(audioRow.locator('.episode-row__dur')).toHaveText('0:06');
  });

  test('[F-09] every row of both libraries uses the same primary variant', async ({ page }) => {
    await openLibrary(page);
    const rows = page.getByTestId('library-item');
    await expect(rows.first()).toBeVisible();
    const count = await rows.count();
    expect(count).toBeGreaterThan(1);
    // One preferred (primary) action per row, never only on the first row.
    for (let i = 0; i < count; i++) {
      await expect(rows.nth(i).locator('.library-row__play .btn--primary')).toHaveCount(1);
    }
    await page.goto('/video/library');
    const play = page.getByRole('button', { name: /^Play / });
    await expect(play.first()).toBeVisible();
    const plays = await play.count();
    expect(plays).toBeGreaterThan(0);
    for (let i = 0; i < plays; i++) await expect(play.nth(i)).toHaveClass(/\bbtn--primary\b/);
  });

  test('[P3-5] Listen opens with focus on Play, so K works at once', async ({ page, browserName }) => {
    test.skip(mockedMediaUnavailable({ browserName }), MOCKED_MEDIA_REASON);
    const errors = await openLibrary(page);
    await rowOf(page, VIDEO_TITLE).getByTestId('library-listen').click();
    await expect(radio(page)).toHaveAttribute('data-state', 'playing');
    await expect(dialog(page).getByTestId('radio-play')).toBeFocused();
    await page.keyboard.press('k');
    await expect(dialog(page).getByTestId('radio-play')).toHaveAccessibleName('Play');
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('[S8] a recording\u2019s row and player use "Demo recording", never "Live demo"', async ({ page }) => {
    await openLibrary(page, '/podcast/library', { catalog: 'demo' });
    const row = page.getByTestId('library-item').filter({ hasText: 'Démo enregistrée' });
    await expect(row).toHaveCount(1);
    await expect(row.getByRole('button', { name: FR_RECORDING, exact: true })).toBeVisible();
    await expect(page.getByTestId('library-item').filter({ hasText: /Démo en direct/ })).toHaveCount(0);
    await row.getByTestId('library-watch').click();
    await expect(dialog(page)).toHaveAccessibleName(FR_RECORDING);
  });
});

test.describe('Phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('[S7] an open transcript compacts the pinned dock and folds the cover away', async ({ page }) => {
    const errors = await openLibrary(page);
    await rowOf(page, VIDEO_TITLE).getByTestId('library-listen').tap();
    const player = radio(page);
    await expect(player).toBeVisible();
    const dock = player.locator('.radio-player__dock');
    const full = (await dock.boundingBox())!;
    await expect(player.locator('.radio-player__cover')).toBeVisible();

    await player.getByTestId('radio-transcript-toggle').tap();
    await expect(player).toHaveAttribute('data-transcript', 'open');
    await expect(player.getByTestId('radio-transcript')).toBeVisible();
    await expect(player.locator('.radio-player__cover')).toBeHidden();
    await expect(player.getByTestId('radio-back')).toBeHidden();
    await expect(player.getByTestId('radio-speed')).toBeHidden();

    const compact = (await dock.boundingBox())!;
    expect(compact.height).toBeLessThan(full.height * 0.6);
    expect(compact.height).toBeLessThanOrEqual(130);
    const play = (await player.getByTestId('radio-play').boundingBox())!;
    expect(play.width).toBeGreaterThanOrEqual(44);
    expect(play.height).toBeGreaterThanOrEqual(44);
    await expect(player.getByTestId('radio-waveform')).toBeVisible();
    await expect(player.getByTestId('radio-time')).toBeVisible();
    // Focus is never hidden behind the dock: its height is still published to the sheet's scroll-padding.
    await expect.poll(async () => {
      const published = await page.evaluate(() => parseFloat(document.documentElement.style.getPropertyValue('--rp-dock-h')));
      return Math.abs(published - (compact.height));
    }).toBeLessThanOrEqual(2);

    await player.getByTestId('radio-transcript-toggle').tap();
    await expect(player.getByTestId('radio-back')).toBeVisible();
    await expect(player.locator('.radio-player__cover')).toBeVisible();
    expect(errors).toEqual([]);
  });
});
