import { test, expect as baseExpect, type Locator, type Page } from '@playwright/test';
import { POD_AUDIO, POD_VIDEO, mockApi, type MockApiOptions } from './support/mock-api';

/**
 * Listen-first episode rows on phones, and listening-progress chips on every device.
 *
 * The owner listens with the screen locked (a video stops when an iPhone locks), so on touch
 * phones — `(hover: none) and (pointer: coarse)`, emulated here with `isMobile` + `hasTouch` —
 * an episode row's title opens Listen whenever the episode has audio, Listen is each row's
 * primary (and first) button, and Home links episodes with audio into Listen. Desktop keeps
 * Watch. Every device shows the saved progress (`oz-radio.progress.v1`, src/playback/progress.ts)
 * on the rows: "Resume · m:ss left" or "Played". Every /api call is mocked
 * (tests/support/mock-api.ts, `podcastV2`); media are real fixtures served with byte ranges.
 */

const expect = baseExpect.configure({ timeout: 15_000 });
test.describe.configure({ timeout: 90_000 });

/** pod-2: Watch + Listen (30 s radio), row 2. */
const VIDEO_TITLE = 'Agents on air';
/** pod-3: Listen only, row 1 (newest). */
const AUDIO_TITLE = 'Safety minute';
/** pod-1: legacy item without rendition flags (Watch + Listen buttons), row 3. */
const LEGACY_TITLE = 'AI agents MCP';
const PROGRESS_KEY = 'oz-radio.progress.v1';
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const SMALL_PHONE = { width: 320, height: 568 };
const DESKTOP = { viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false };

interface Saved { position: number; duration: number; done: boolean }

async function open(page: Page, path = '/podcast/library', opts: MockApiOptions = {}) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await mockApi(page, 'visitor', { podcastV2: true, ...opts });
  await page.goto(path);
  return errors;
}

/** Writes `oz-radio.progress.v1` before the app's first load, once (later loads keep what the app saved). */
async function seedProgress(page: Page, episodes: Record<string, Saved>) {
  const updatedAt = Date.now();
  const value = JSON.stringify({
    v: 1,
    episodes: Object.fromEntries(Object.entries(episodes).map(([id, saved]) => [id, { ...saved, updatedAt }])),
  });
  await page.addInitScript(([key, json]) => {
    if (sessionStorage.getItem('oz-test.seeded')) return;
    sessionStorage.setItem('oz-test.seeded', '1');
    localStorage.setItem(key, json);
  }, [PROGRESS_KEY, value] as const);
}

const rowOf = (page: Page, title: string) => page.getByTestId('library-item').filter({ hasText: title });
const titleOf = (row: Locator, title: string) => row.getByRole('button', { name: title, exact: true });
const chipOf = (row: Locator) => row.getByTestId('progress-chip');
const dialog = (page: Page) => page.getByRole('dialog');
const radioAudio = (page: Page) => page.getByTestId('radio-audio');
const audioTime = (page: Page) => radioAudio(page).evaluate((a: HTMLAudioElement) => a.currentTime);

/** Waits until a row's Watch / Listen buttons are, in DOM (= reading) order, these test ids. */
const expectPlayButtons = (row: Locator, testIds: string[]) => expect.poll(
  () => row.locator('[data-testid="library-listen"], [data-testid="library-watch"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-testid'))),
).toEqual(testIds);

/** A colour token (e.g. `--c-clay`) as the browser computes it for a background. */
const tokenColour = (page: Page, token: string) => page.evaluate((t) => {
  const probe = document.createElement('span');
  probe.style.backgroundColor = `var(${t})`;
  document.body.append(probe);
  const colour = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return colour;
}, token);

/** "Resume · m:ss left" for a stored bookmark (the row rounds like the mini-player's time left). */
function resumeText({ position, duration }: Saved) {
  const left = Math.round(Math.max(1, duration - position));
  return `Resume · ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} left`;
}

async function savedOf(page: Page, jobId: string): Promise<Saved | null> {
  const raw = await page.evaluate((key) => localStorage.getItem(key), PROGRESS_KEY);
  return raw ? (JSON.parse(raw).episodes?.[jobId] ?? null) : null;
}

async function box(locator: Locator) {
  const b = await locator.boundingBox();
  expect(b, 'element has a box').not.toBeNull();
  return b!;
}

/**
 * Whether this engine decodes the radio fixture. Playwright's WebKit on Windows answers
 * `canPlayType('audio/mpeg') === 'probably'` but fails every load (MEDIA_ERR_SRC_NOT_SUPPORTED).
 */
const decodesRadio = (page: Page) => page.evaluate(() => new Promise<boolean>((resolve) => {
  const probe = new Audio();
  probe.muted = true;
  probe.addEventListener('canplay', () => resolve(true), { once: true });
  probe.addEventListener('error', () => resolve(false), { once: true });
  window.setTimeout(() => resolve(probe.readyState >= 2), 5000);
  probe.src = '/media/decode-probe.mp3';
  probe.load();
}));
const NO_DECODER = 'mocked media cannot play in this browser build (Playwright WebKit on Windows loads media outside page.route)';

test.describe('Phones lead with Listen', () => {
  test.use(PHONE);
  test.skip(({ browserName }) => browserName === 'firefox', 'Firefox has no isMobile emulation');

  test('the title of a Watch + Listen episode opens Listen: the radio plays, no video', async ({ page }) => {
    const errors = await open(page);
    expect(await page.evaluate(() => matchMedia('(hover: none) and (pointer: coarse)').matches), 'touch phone emulated').toBe(true);
    const decodes = await decodesRadio(page);
    await titleOf(rowOf(page, VIDEO_TITLE), VIDEO_TITLE).tap();

    await expect(page).toHaveURL(/\/podcast\/library\?episode=pod-2&mode=listen$/);
    const d = dialog(page);
    await expect(d).toHaveAttribute('data-mode', 'listen');
    await expect(d.getByRole('tab', { name: 'Listen' })).toHaveAttribute('aria-selected', 'true');
    await expect(d.getByTestId('radio-player')).toBeVisible();
    await expect(radioAudio(page)).toHaveAttribute('src', POD_VIDEO.mp3_url);
    if (decodes) await expect(d.getByTestId('radio-player')).toHaveAttribute('data-state', 'playing');
    await expect(d.locator('video')).toHaveCount(0);
    await expect(page.getByTestId('library-player')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('Listen is every row\'s primary button and comes first; Watch is the outline alternative', async ({ page }) => {
    const errors = await open(page);
    await expect(page.getByTestId('library-item')).toHaveCount(3);
    const clay = await tokenColour(page, '--c-clay');

    for (const title of [VIDEO_TITLE, LEGACY_TITLE]) {
      const row = rowOf(page, title);
      const listen = row.getByTestId('library-listen');
      const watch = row.getByTestId('library-watch');
      await expectPlayButtons(row, ['library-listen', 'library-watch']);
      await expect(listen).toHaveAccessibleName(`Listen to ${title}`);
      await expect(watch).toHaveAccessibleName(`Watch ${title}`);
      await expect(listen).toHaveClass(/\bbtn--primary\b/);
      await expect(listen).toHaveCSS('background-color', clay);
      await expect(watch).not.toHaveClass(/\bbtn--primary\b/);
      await expect(watch).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      // The visual order is the reading order: Listen on the left of Watch.
      const [l, w] = [await box(listen), await box(watch)];
      expect(l.x + l.width, title).toBeLessThanOrEqual(w.x);
    }

    // Audio-only rows are unchanged: Listen only (the title opens it too).
    const audio = rowOf(page, AUDIO_TITLE);
    await expectPlayButtons(audio, ['library-listen']);
    await expect(audio.getByTestId('library-listen')).toHaveClass(/\bbtn--primary\b/);
    await titleOf(audio, AUDIO_TITLE).tap();
    await expect(page).toHaveURL(/\?episode=pod-3&mode=listen$/);
    await expect(dialog(page)).toHaveAttribute('data-mode', 'listen');
    await expect(radioAudio(page)).toHaveAttribute('src', POD_AUDIO.mp3_url);
    await expect(dialog(page).locator('video')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('an episode without audio keeps Watch: the title opens the video', async ({ page }) => {
    const errors = await open(page, '/podcast/library', { publicAudio: false });
    const row = rowOf(page, VIDEO_TITLE);
    await expectPlayButtons(row, ['library-watch']);
    await expect(row.getByTestId('library-watch')).toHaveClass(/\bbtn--primary\b/);
    await titleOf(row, VIDEO_TITLE).tap();
    await expect(page).toHaveURL(/\?episode=pod-2&mode=watch$/);
    await expect(dialog(page)).toHaveAttribute('data-mode', 'watch');
    await expect(page.getByTestId('library-player')).toHaveAttribute('src', POD_VIDEO.mp4_url!);
    await expect(radioAudio(page)).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('Home links episodes with audio into Listen', async ({ page }) => {
    const errors = await open(page, '/');
    // Each Home row links twice (title + play button).
    for (const id of [POD_VIDEO.job_id, POD_AUDIO.job_id]) {
      await expect(page.locator(`a[href="/podcast/library?episode=${id}&mode=listen"]`)).toHaveCount(2);
    }
    await expect(page.locator(`a[href="/podcast/library?episode=${POD_VIDEO.job_id}&mode=watch"]`)).toHaveCount(0);

    await page.getByRole('link', { name: VIDEO_TITLE, exact: true }).tap();
    await expect(page).toHaveURL(/\/podcast\/library\?episode=pod-2&mode=listen$/);
    const d = dialog(page);
    await expect(d).toHaveAttribute('data-mode', 'listen');
    await expect(d.getByTestId('radio-player')).toBeVisible();
    await expect(radioAudio(page)).toHaveAttribute('src', POD_VIDEO.mp3_url);
    await expect(d.locator('video')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('Home keeps Watch for an episode without audio', async ({ page }) => {
    const errors = await open(page, '/', { publicAudio: false });
    await expect(page.locator(`a[href="/podcast/library?episode=${POD_VIDEO.job_id}&mode=watch"]`)).toHaveCount(2);
    await expect(page.locator(`a[href="/podcast/library?episode=${POD_VIDEO.job_id}&mode=listen"]`)).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('a Resume chip appears live after listening (play, pause), and the title resumes there', async ({ page }) => {
    const errors = await open(page);
    test.skip(!(await decodesRadio(page)), NO_DECODER);
    await page.evaluate(() => { (window as unknown as { ozSameDocument?: boolean }).ozSameDocument = true; });
    const row = rowOf(page, VIDEO_TITLE);
    await expect(row).toBeVisible();
    await expect(page.getByTestId('progress-chip')).toHaveCount(0);

    await row.getByRole('button', { name: `Listen to ${VIDEO_TITLE}` }).tap();
    const player = dialog(page).getByTestId('radio-player');
    await expect(player).toHaveAttribute('data-state', 'playing');
    await expect.poll(() => audioTime(page)).toBeGreaterThan(4);
    await player.getByTestId('radio-play').tap();
    await expect(player).toHaveAttribute('data-state', 'paused');
    await dialog(page).getByRole('button', { name: 'Minimise player' }).tap();
    await expect(dialog(page)).toHaveCount(0);

    const saved = await savedOf(page, POD_VIDEO.job_id);
    expect(saved).toMatchObject({ done: false });
    expect(saved!.position).toBeGreaterThanOrEqual(4);
    const chip = chipOf(row);
    await expect(chip).toHaveText(resumeText(saved!));
    await expect(chip).toHaveAttribute('data-progress', 'resume');
    await expect(page.getByTestId('progress-chip')).toHaveCount(1);
    expect(await page.evaluate(() => (window as unknown as { ozSameDocument?: boolean }).ozSameDocument), 'no reload').toBe(true);

    // The title picks the episode up where the chip says.
    await titleOf(row, VIDEO_TITLE).tap();
    await expect(page).toHaveURL(/\?episode=pod-2&mode=listen$/);
    await expect(player).toHaveAttribute('data-state', 'playing');
    expect(await audioTime(page)).toBeGreaterThanOrEqual(saved!.position - 0.5);
    expect(errors).toEqual([]);
  });

  for (const viewport of [PHONE.viewport, SMALL_PHONE]) {
    test.describe(`${viewport.width} px wide`, () => {
      test.use({ viewport });

      test('rows with chips fit the screen and the play buttons are thumb-sized', async ({ page }) => {
        await seedProgress(page, {
          [POD_VIDEO.job_id]: { position: 12, duration: 30, done: false },
          [POD_AUDIO.job_id]: { position: 0, duration: 6, done: true },
        });
        const errors = await open(page);
        await expect(chipOf(rowOf(page, VIDEO_TITLE))).toHaveText('Resume · 0:18 left');
        await expect(chipOf(rowOf(page, AUDIO_TITLE))).toHaveText('Played');

        // innerWidth is unreliable under mobile emulation (widened to the content): use the layout width.
        const m = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }));
        expect(m.clientWidth, 'layout viewport is the device width').toBe(viewport.width);
        expect(m.scrollWidth, 'page is wider than the screen').toBeLessThanOrEqual(m.clientWidth);

        // Chips stay inside their row's text column (no overlap with the duration).
        for (const chip of await page.getByTestId('progress-chip').all()) {
          const c = await box(chip);
          const body = await box(chip.locator('xpath=ancestor::div[contains(@class, "episode-row__body")]'));
          expect(c.x + c.width).toBeLessThanOrEqual(body.x + body.width + 0.5);
        }
        const buttons = page.getByTestId('library-item').locator('.btn');
        await expect(buttons).toHaveCount(5);
        for (const button of await buttons.all()) {
          expect((await box(button)).height, await button.getAttribute('aria-label') ?? '').toBeGreaterThanOrEqual(44);
        }
        expect(errors).toEqual([]);
      });
    });
  }
});

test.describe('Desktop keeps Watch', () => {
  test.use(DESKTOP);

  test('the title of a Watch + Listen episode still opens Watch; button styles as before', async ({ page }) => {
    const errors = await open(page);
    expect(await page.evaluate(() => matchMedia('(hover: none) and (pointer: coarse)').matches)).toBe(false);
    const row = rowOf(page, VIDEO_TITLE);
    await expectPlayButtons(row, ['library-watch', 'library-listen']);
    // Every row has the same variant: the preferred action (Watch, or Listen for an audio-only episode) is primary, the other outline.
    await expect(row.getByTestId('library-watch')).toHaveClass(/\bbtn--primary\b/);
    await expect(row.getByTestId('library-listen')).not.toHaveClass(/\bbtn--primary\b/);
    await expect(rowOf(page, AUDIO_TITLE).getByTestId('library-listen')).toHaveClass(/\bbtn--primary\b/);
    await expect(page.getByTestId('library-item').locator('.btn--primary')).toHaveCount(3);

    await titleOf(row, VIDEO_TITLE).click();
    await expect(page).toHaveURL(/\?episode=pod-2&mode=watch$/);
    await expect(dialog(page)).toHaveAttribute('data-mode', 'watch');
    await expect(page.getByTestId('library-player')).toHaveAttribute('src', POD_VIDEO.mp4_url!);
    await expect(radioAudio(page)).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('every row\'s Watch is the primary button (no row is singled out)', async ({ page }) => {
    const errors = await open(page, '/podcast/library', { publicAudio: false });
    const first = page.getByTestId('library-item').first();
    await expect(first).toContainText(VIDEO_TITLE);
    await expect(first.getByTestId('library-watch')).toHaveClass(/\bbtn--primary\b/);
    const legacy = rowOf(page, LEGACY_TITLE);
    await expectPlayButtons(legacy, ['library-watch', 'library-listen']);
    await expect(legacy.getByTestId('library-watch')).toHaveClass(/\bbtn--primary\b/);
    await expect(legacy.getByTestId('library-listen')).not.toHaveClass(/\bbtn--primary\b/);
    expect(errors).toEqual([]);
  });

  test('Home links keep Watch for video episodes', async ({ page }) => {
    const errors = await open(page, '/');
    await expect(page.locator(`a[href="/podcast/library?episode=${POD_VIDEO.job_id}&mode=watch"]`)).toHaveCount(2);
    await expect(page.locator(`a[href="/podcast/library?episode=${POD_AUDIO.job_id}&mode=listen"]`)).toHaveCount(2);
    expect(errors).toEqual([]);
  });

  test.describe('progress chips', () => {
    const cases: [string, Saved, string | null][] = [
      ['a bookmark shows the time left', { position: 12, duration: 30, done: false }, 'Resume · 0:18 left'],
      ['an episode heard to the end shows Played', { position: 0, duration: 30, done: true }, 'Played'],
      ['a bookmark under 3 s shows nothing', { position: 1, duration: 30, done: false }, null],
    ];
    for (const [name, saved, text] of cases) {
      test(name, async ({ page }) => {
        await seedProgress(page, { [POD_VIDEO.job_id]: saved });
        const errors = await open(page);
        const row = rowOf(page, VIDEO_TITLE);
        await expect(row).toBeVisible();
        if (text === null) {
          await expect(chipOf(row)).toHaveCount(0);
        } else {
          const chip = chipOf(row);
          await expect(chip).toHaveText(text);
          // The text carries the meaning; the icon is decorative.
          await expect(chip.locator('svg')).toHaveAttribute('aria-hidden', 'true');
        }
        // Episodes without saved progress show no chip.
        await expect(page.getByTestId('progress-chip')).toHaveCount(text === null ? 0 : 1);
        expect(errors).toEqual([]);
      });
    }
  });
});
