import { test, expect as baseExpect, type Locator, type Page } from '@playwright/test';
import { MOCKED_MEDIA_REASON, POD_AUDIO, POD_VIDEO, mockApi, mockedMediaUnavailable, type MockApiOptions, type Role } from './support/mock-api';

/**
 * App-wide playback engine (src/playback): one persistent radio for the whole visit.
 *
 * Listen survives the episode dialog (close / Back / scrim / Escape minimise it), other
 * routes and episode changes on the SAME <audio> element; the mini-player keeps it on every
 * route; Watch stays page-owned and pauses the radio; phones get a full-screen Now Playing
 * sheet. Every /api call is mocked (tests/support/mock-api.ts); media are real fixtures
 * served with byte ranges, so playback genuinely runs.
 */

const expect = baseExpect.configure({ timeout: 15_000 });
test.describe.configure({ timeout: 90_000 });

const VIDEO_TITLE = 'Agents on air';
const AUDIO_TITLE = 'Safety minute';
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
/** Desktop-only behaviour (the scrim exists only around the desktop dialog), also under phone projects. */
const DESKTOP = { viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false };

async function open(page: Page, path = '/podcast/library', role: Role = 'visitor', opts: MockApiOptions = {}) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await mockApi(page, role, { podcastV2: true, ...opts });
  await page.goto(path);
  return errors;
}

const rowOf = (page: Page, title: string) => page.getByTestId('library-item').filter({ hasText: title });
const dialog = (page: Page) => page.getByRole('dialog');
const mini = (page: Page) => page.getByTestId('mini-player');
const radioAudio = (page: Page) => page.getByTestId('radio-audio');
const audioTime = (page: Page) => radioAudio(page).evaluate((a: HTMLAudioElement) => a.currentTime);
const audioPaused = (page: Page) => radioAudio(page).evaluate((a: HTMLAudioElement) => a.paused);
const rootVar = (page: Page, name: string) =>
  page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);

/** Waits until the radio has moved at least `by` seconds forward. */
async function expectAdvancing(page: Page, by = 0.5) {
  const from = await audioTime(page);
  await expect.poll(() => audioTime(page)).toBeGreaterThan(from + by);
}

/** Marks the radio's <audio> element; `isTagged` tells whether the element on the page is still that one. */
const tagAudio = (page: Page) => radioAudio(page).evaluate((a) => { (a as unknown as { ozTag?: string }).ozTag = 'engine'; });
const isTagged = (page: Page) => radioAudio(page).evaluate((a) => (a as unknown as { ozTag?: string }).ozTag === 'engine');

async function listen(page: Page, title = VIDEO_TITLE, tap = false) {
  const button = rowOf(page, title).getByRole('button', { name: `Listen to ${title}` });
  if (tap) await button.tap();
  else await button.click();
  const player = dialog(page).getByTestId('radio-player');
  await expect(player).toHaveAttribute('data-state', 'playing');
  return player;
}

async function expectMiniPlaying(page: Page) {
  await expect(dialog(page)).toHaveCount(0);
  await expect(mini(page)).toBeVisible();
  await expect(mini(page).getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await expectAdvancing(page);
}

async function box(locator: Locator) {
  const b = await locator.boundingBox();
  expect(b, 'element has a box').not.toBeNull();
  return b!;
}

test.describe('Playback engine — Listen outlives the dialog', () => {
  test.skip(mockedMediaUnavailable, MOCKED_MEDIA_REASON);

  test.describe('desktop dialog', () => {
    test.use(DESKTOP);

    test('Back, the scrim, the minimise button and Escape keep the audio playing in the mini-player', async ({ page }) => {
      const errors = await open(page);
      await listen(page);
      await tagAudio(page);
      // While the sheet shows the player, the mini-player stays out of the way.
      await expect(mini(page)).toBeHidden();
      await expect(dialog(page).getByRole('button', { name: 'Minimise player' })).toBeVisible();

      await page.goBack();
      await expect(page).toHaveURL(/\/podcast\/library$/);
      await expectMiniPlaying(page);
      expect(await isTagged(page)).toBe(true);
      await expect(mini(page).getByTestId('mini-player-status')).toHaveText(/is speaking|left$/);

      const reopen = async () => {
        await mini(page).getByRole('button', { name: `Open now playing: ${VIDEO_TITLE}` }).click();
        await expect(page).toHaveURL(/\?episode=pod-2&mode=listen$/);
        await expect(dialog(page).getByTestId('radio-player')).toHaveAttribute('data-state', 'playing');
        await expect(mini(page)).toBeHidden();
        expect(await isTagged(page)).toBe(true);
      };

      // Scrim (outside the centred panel).
      await reopen();
      await page.mouse.click(12, 360);
      await expectMiniPlaying(page);

      await reopen();
      await dialog(page).getByRole('button', { name: 'Minimise player' }).click();
      await expectMiniPlaying(page);

      await reopen();
      await page.keyboard.press('Escape');
      await expectMiniPlaying(page);
      await expect(page).toHaveURL(/\/podcast\/library$/);
      expect(await isTagged(page)).toBe(true);
      expect(errors).toEqual([]);
    });
  });

  test('the radio keeps playing across routes; the mini-player reopens the same player and returns', async ({ page }) => {
    const errors = await open(page);
    await listen(page);
    await tagAudio(page);
    await page.keyboard.press('Escape');
    await expect(mini(page)).toBeVisible();

    await page.getByRole('link', { name: 'Oz Radio home' }).click();
    await expect(page).toHaveURL(/\/$/);
    await expectMiniPlaying(page);
    const before = await audioTime(page);

    // Reopen from Home: the same element, no restart, no detail fetch needed.
    await mini(page).getByRole('button', { name: `Open now playing: ${VIDEO_TITLE}` }).click();
    await expect(page).toHaveURL(/\/podcast\/library\?episode=pod-2&mode=listen$/);
    const player = dialog(page).getByTestId('radio-player');
    await expect(player).toHaveAttribute('data-state', 'playing');
    expect(await isTagged(page)).toBe(true);
    expect(await audioTime(page)).toBeGreaterThanOrEqual(before);
    await expect(player.getByTestId('radio-audio')).toHaveCount(1);

    // Minimising pops back to where the listener came from; focus lands on the mini-player.
    await dialog(page).getByRole('button', { name: 'Minimise player' }).click();
    await expect(page).toHaveURL(/\/$/);
    await expectMiniPlaying(page);
    await expect(mini(page).getByRole('button', { name: `Open now playing: ${VIDEO_TITLE}` })).toBeFocused();
    expect(await isTagged(page)).toBe(true);
    expect(errors).toEqual([]);
  });

  test('Stop is available while playing and while paused, and unloads the player', async ({ page }) => {
    const errors = await open(page);
    await listen(page);
    await page.keyboard.press('Escape');
    await expect(mini(page)).toBeVisible();
    expect(await rootVar(page, '--mini-player-h')).toBe('64px');
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollPaddingBottom)).toBe('64px');
    const stop = mini(page).getByRole('button', { name: 'Stop and close player' });
    await expect(stop).toBeVisible();

    await mini(page).getByRole('button', { name: 'Pause', exact: true }).click();
    await expect.poll(() => audioPaused(page)).toBe(true);
    await expect(mini(page).getByTestId('mini-player-status')).toHaveText(/^Paused · \d+:\d\d left$/);
    await expect(stop).toBeVisible();
    await stop.click();
    await expect(mini(page)).toHaveCount(0);
    await expect(radioAudio(page)).toHaveCount(0);
    expect(await rootVar(page, '--mini-player-h')).toBe('0px');
    // Focus is not lost to <body>.
    expect(await page.evaluate(() => document.activeElement !== document.body)).toBe(true);
    expect(errors).toEqual([]);
  });

  test('every episode plays on the same <audio> element; Watch ↔ Listen seeks instead of reloading', async ({ page }) => {
    const errors = await open(page);
    await listen(page);
    await tagAudio(page);
    const d = dialog(page);
    const srcBefore = await radioAudio(page).getAttribute('src');

    await d.getByRole('tab', { name: 'Watch' }).click();
    await expect(d).toHaveAttribute('data-mode', 'watch');
    await expect(mini(page)).toBeHidden();
    await d.getByRole('tab', { name: 'Listen' }).click();
    await expect(d.getByTestId('radio-player')).toHaveAttribute('data-state', 'playing');
    expect(await isTagged(page)).toBe(true);
    expect(await radioAudio(page).getAttribute('src')).toBe(srcBefore);

    await page.keyboard.press('Escape');
    await listen(page, AUDIO_TITLE);
    await expect(radioAudio(page)).toHaveAttribute('src', POD_AUDIO.mp3_url);
    expect(await isTagged(page)).toBe(true);
    await expect(d.getByTestId('radio-player')).toContainText('Ana');
    expect(errors).toEqual([]);
  });

  test('an episode that ends with nothing queued reads "Finished"', async ({ page }) => {
    const errors = await open(page);
    await listen(page, AUDIO_TITLE); // 6 s
    await page.keyboard.press('Escape');
    await expect(mini(page).getByTestId('mini-player-status')).toHaveText('Finished', { timeout: 20_000 });
    await expect(mini(page).getByRole('button', { name: 'Play', exact: true })).toBeVisible();
    await expect(mini(page).getByRole('button', { name: 'Stop and close player' })).toBeVisible();
    expect(errors).toEqual([]);
  });
});

test.describe('Playback engine — one medium at a time', () => {
  test('the Media Session follows the radio: claimed on play, released on takeover and on Stop', async ({ page, browserName }) => {
    test.skip(mockedMediaUnavailable({ browserName }), MOCKED_MEDIA_REASON);
    test.skip(!(await page.evaluate(() => 'mediaSession' in navigator)), 'No Media Session API in this browser build');
    const errors = await open(page);
    await listen(page);
    const sessionTitle = () => page.evaluate(() => navigator.mediaSession.metadata?.title ?? null);
    await expect.poll(sessionTitle).toBe(VIDEO_TITLE);
    expect(await page.evaluate(() => navigator.mediaSession.metadata?.album)).toBe('Oz Radio');
    await page.keyboard.press('Escape');
    await expect.poll(sessionTitle).toBe(VIDEO_TITLE); // minimised: still the radio's

    // Another audible medium takes over: the radio pauses and lets go of the OS controls.
    await page.evaluate(async () => {
      const other = document.createElement('audio');
      other.src = '/media/other.wav';
      document.body.append(other);
      await other.play();
      other.pause();
      other.remove();
    });
    await expect.poll(() => audioPaused(page)).toBe(true);
    await expect.poll(sessionTitle).toBeNull();

    await mini(page).getByRole('button', { name: 'Play', exact: true }).click();
    await expect.poll(sessionTitle).toBe(VIDEO_TITLE);
    await mini(page).getByRole('button', { name: 'Pause', exact: true }).click();
    await mini(page).getByRole('button', { name: 'Stop and close player' }).click();
    await expect.poll(sessionTitle).toBeNull();
    expect(errors).toEqual([]);
  });

  test('opening Watch on another episode pauses the radio; closing shows it paused', async ({ page, browserName }) => {
    test.skip(mockedMediaUnavailable({ browserName }), MOCKED_MEDIA_REASON);
    const errors = await open(page);
    await listen(page, AUDIO_TITLE);
    await page.keyboard.press('Escape');
    await expect(mini(page)).toBeVisible();

    await rowOf(page, VIDEO_TITLE).getByTestId('library-watch').click();
    const d = dialog(page);
    await expect(d).toHaveAttribute('data-mode', 'watch');
    await expect.poll(() => page.getByTestId('library-player').evaluate((v: HTMLVideoElement) => !v.paused)).toBe(true);
    expect(await audioPaused(page)).toBe(true);
    await expect(mini(page)).toBeHidden();
    await expect(d.getByRole('button', { name: 'Close' })).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(mini(page)).toBeVisible();
    await expect(mini(page).getByRole('button', { name: 'Play', exact: true })).toBeVisible();
    expect(await audioPaused(page)).toBe(true);
    expect(errors).toEqual([]);
  });

  test('another audible medium pauses the radio; a muted one does not', async ({ page, browserName }) => {
    test.skip(mockedMediaUnavailable({ browserName }), MOCKED_MEDIA_REASON);
    const errors = await open(page);
    await listen(page);
    await page.keyboard.press('Escape');
    await expectMiniPlaying(page);

    const playOther = (muted: boolean) => page.evaluate(async (m) => {
      const other = document.createElement('audio');
      other.src = '/media/other.wav';
      other.muted = m;
      document.body.append(other);
      await other.play();
      return !other.paused;
    }, muted);

    expect(await playOther(true)).toBe(true);
    await page.waitForTimeout(300);
    expect(await audioPaused(page)).toBe(false);

    expect(await playOther(false)).toBe(true);
    await expect.poll(() => audioPaused(page)).toBe(true);
    await expect(mini(page).getByRole('button', { name: 'Play', exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('the creator page keeps its own single radio player and pauses the app radio when it plays', async ({ page, browserName }) => {
    test.skip(mockedMediaUnavailable({ browserName }), MOCKED_MEDIA_REASON);
    const errors = await open(page, '/podcast/library', 'admin', { jobAdvance: 'poll' });
    await listen(page);
    await page.keyboard.press('Escape');
    await expectMiniPlaying(page);

    // Client-side navigation keeps the app radio (parked, out of sight).
    await page.getByRole('link', { name: 'Create podcast' }).click();
    await expect(page).toHaveURL(/\/podcast$/);
    await expectMiniPlaying(page);
    await page.locator('input[type=file]').setInputFiles({
      name: 'agents.md', mimeType: 'text/markdown', buffer: Buffer.from('# Agents\n\nAgents plan, act and check their work.'),
    });
    await page.getByRole('button', { name: /generate podcast script/i }).click();
    await page.getByTestId('format-audio').click();
    await page.getByTestId('render-podcast').click();

    const result = page.getByTestId('result-listen').getByTestId('radio-player');
    await expect(result).toHaveAttribute('data-state', 'playing', { timeout: 30_000 });
    await expect(page.locator('[data-testid=radio-player]:visible')).toHaveCount(1);
    // The app radio (the parked one) was paused by the creator's player.
    const appRadio = page.getByTestId('playback-parking').getByTestId('radio-audio');
    await expect.poll(() => appRadio.evaluate((a: HTMLAudioElement) => a.paused)).toBe(true);
    await expect(mini(page).getByRole('button', { name: 'Play', exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('a fresh creator page has exactly one radio player', async ({ page }) => {
    const errors = await open(page, '/podcast', 'admin', { jobAdvance: 'poll' });
    await page.locator('input[type=file]').setInputFiles({
      name: 'agents.md', mimeType: 'text/markdown', buffer: Buffer.from('# Agents\n\nAgents plan, act and check their work.'),
    });
    await page.getByRole('button', { name: /generate podcast script/i }).click();
    await page.getByTestId('format-audio').click();
    await page.getByTestId('render-podcast').click();
    await expect(page.getByTestId('result-listen').getByTestId('radio-player')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('radio-player')).toHaveCount(1);
    await expect(mini(page)).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});

test.describe('Playback engine — one tap, continuity', () => {
  test.skip(mockedMediaUnavailable, MOCKED_MEDIA_REASON);

  /** Counts GET /api/podcast/library/<id> requests. */
  function countDetails(page: Page, id: string) {
    const seen = { count: 0 };
    page.on('request', (r) => {
      if (new URL(r.url()).pathname === `/api/podcast/library/${id}`) seen.count += 1;
    });
    return seen;
  }

  test('a prefetched episode starts in one tap without fetching it again; reopening it never refetches', async ({ page }) => {
    const details = countDetails(page, POD_VIDEO.job_id);
    const errors = await open(page);
    await expect(page.getByTestId('library-item')).toHaveCount(3);
    await expect.poll(() => details.count).toBe(1); // the library's prefetch
    await listen(page);
    await page.keyboard.press('Escape');
    await page.getByRole('link', { name: 'Oz Radio home' }).click();
    await mini(page).getByRole('button', { name: `Open now playing: ${VIDEO_TITLE}` }).click();
    await expect(dialog(page).getByTestId('radio-player')).toHaveAttribute('data-state', 'playing');
    expect(details.count).toBe(1);
    expect(errors).toEqual([]);
  });

  /**
   * queue.ts ships a stub (no next episode): inject a resolver through the dev server's module
   * graph to check the engine's auto-advance contract (skipped against a production build).
   */
  async function injectNext(page: Page, from: string, to: string): Promise<boolean> {
    return page.evaluate(async ([a, b]) => {
      try {
        const path = '/src/playback/queue.ts';
        const queue = await import(/* @vite-ignore */ path);
        queue.nextEpisodeResolver.next = (cur: { job_id: string }, catalog: { job_id: string }[]) => (
          cur.job_id === a ? catalog.find((s) => s.job_id === b) ?? null : null);
        return true;
      } catch {
        return false;
      }
    }, [from, to]);
  }

  test('auto-advance: the next episode starts inside `ended` on the same element and the open sheet follows', async ({ page }) => {
    const errors = await open(page);
    await expect(page.getByTestId('library-item')).toHaveCount(3);
    test.skip(!(await injectNext(page, POD_AUDIO.job_id, POD_VIDEO.job_id)), 'module injection needs the Vite dev server');
    await listen(page, AUDIO_TITLE); // 6 s
    await tagAudio(page);
    const historyLength = await page.evaluate(() => history.length);

    await expect(page).toHaveURL(/\?episode=pod-2&mode=listen$/, { timeout: 20_000 });
    await expect(page.getByRole('dialog', { name: VIDEO_TITLE })).toBeVisible();
    await expect(radioAudio(page)).toHaveAttribute('src', POD_VIDEO.mp3_url);
    await expect(dialog(page).getByTestId('radio-player')).toHaveAttribute('data-state', 'playing');
    expect(await isTagged(page)).toBe(true);
    expect(await page.evaluate(() => history.length)).toBe(historyLength);

    // The followed entry still pops back to the library.
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(/\/podcast\/library$/);
    await expectMiniPlaying(page);
    expect(errors).toEqual([]);
  });

  test('auto-advance while minimised changes the mini-player, never the URL', async ({ page }) => {
    const errors = await open(page);
    await expect(page.getByTestId('library-item')).toHaveCount(3);
    test.skip(!(await injectNext(page, POD_AUDIO.job_id, POD_VIDEO.job_id)), 'module injection needs the Vite dev server');
    await listen(page, AUDIO_TITLE);
    await tagAudio(page);
    await page.keyboard.press('Escape');
    await expect(mini(page).getByRole('button', { name: `Open now playing: ${AUDIO_TITLE}` })).toBeVisible();

    await expect(mini(page).getByRole('button', { name: `Open now playing: ${VIDEO_TITLE}` })).toBeVisible({ timeout: 20_000 });
    await expectMiniPlaying(page);
    await expect(page).toHaveURL(/\/podcast\/library$/);
    await expect(dialog(page)).toHaveCount(0);
    expect(await isTagged(page)).toBe(true);
    expect(errors).toEqual([]);
  });
});

test.describe('Playback engine — accessibility', () => {
  test.skip(mockedMediaUnavailable, MOCKED_MEDIA_REASON);

  test('captions stay visible but are not announced', async ({ page }) => {
    const errors = await open(page);
    const player = await listen(page);
    const caption = player.getByTestId('radio-caption');
    await expect(caption).toHaveAttribute('aria-live', 'off');
    await expect(caption).not.toHaveText('');
    expect(errors).toEqual([]);
  });
});

test.describe('Playback engine — deep links', () => {
  test.describe('desktop', () => {
    test.use(DESKTOP);

    test('an episode link without a mode opens Listen when the episode has audio (Watch for video-only ones)', async ({ page }) => {
      const errors = await open(page, `/podcast/library?episode=${POD_VIDEO.job_id}`);
      await expect(dialog(page)).toHaveAttribute('data-mode', 'listen');
      await expect(page).toHaveURL(/\?episode=pod-2&mode=listen$/);
      await expect(page.getByTestId('library-player')).toHaveCount(0);
      await page.goto('/podcast/library?episode=pod-1');
      await expect(dialog(page)).toHaveAttribute('data-mode', 'watch');
      await expect(page).toHaveURL(/\?episode=pod-1&mode=watch$/);
      expect(errors).toEqual([]);
    });
  });

  test.describe('phone', () => {
    test.use(PHONE);

    test('an episode link without a mode opens Listen when the episode has audio', async ({ page, browserName }) => {
      test.skip(mockedMediaUnavailable({ browserName }), MOCKED_MEDIA_REASON); // it asserts the radio's playback state (fails 3/5 on WebKit at 1b41947 too)
      const errors = await open(page, `/podcast/library?episode=${POD_VIDEO.job_id}`);
      const d = dialog(page);
      await expect(d).toHaveAttribute('data-mode', 'listen');
      await expect(page).toHaveURL(/\?episode=pod-2&mode=listen$/);
      await expect(d.getByTestId('radio-player')).toHaveAttribute('data-state', /^(playing|press-play)$/);
      // Video-only (legacy) episodes still open in Watch.
      await page.goto('/podcast/library?episode=pod-1');
      await expect(d).toHaveAttribute('data-mode', 'watch');
      await expect(page).toHaveURL(/\?episode=pod-1&mode=watch$/);
      expect(errors).toEqual([]);
    });
  });
});

test.describe('Playback engine — phone layout', () => {
  test.use(PHONE);

  test('Listen is a full-screen sheet with the controls pinned in the thumb zone', async ({ page }) => {
    const errors = await open(page);
    await expect(page.getByTestId('library-item')).toHaveCount(3);
    const player = await listen(page, VIDEO_TITLE, true);
    const d = dialog(page);
    const sheet = await box(d);
    // Sub-pixel layout (WebKit reports 843.984375): compare to the pixel.
    expect(sheet.x).toBeCloseTo(0, 0);
    expect(sheet.y).toBeCloseTo(0, 0);
    expect(sheet.width).toBeCloseTo(390, 0);
    expect(sheet.height).toBeCloseTo(844, 0);
    await expect(d.getByRole('button', { name: 'Minimise player' })).toBeVisible();

    const play = await box(player.getByTestId('radio-play'));
    expect(play.height).toBeGreaterThanOrEqual(64);
    for (const id of ['radio-back', 'radio-forward', 'radio-speed']) {
      expect((await box(player.getByTestId(id))).height, id).toBeGreaterThanOrEqual(44);
    }

    // One scroll container: the transcript opens inside the sheet, the transport stays on screen.
    await player.getByTestId('radio-transcript-toggle').tap();
    const cues = player.locator('.radio-player__cues');
    await expect(cues).toBeVisible();
    expect(await cues.evaluate((el) => getComputedStyle(el).overflowY)).toBe('visible');
    // The turns flow as paragraphs (short): the sheet may just fit, but never scrolls inside the transcript.
    expect(await d.evaluate((el) => el.scrollHeight >= el.clientHeight)).toBe(true);
    for (const top of [0, 300, 100_000]) {
      await d.evaluate((el, y) => el.scrollTo(0, y), top);
      const p = await box(player.getByTestId('radio-play'));
      expect(p.y, `scrolled to ${top}`).toBeGreaterThanOrEqual(0);
      expect(p.y + p.height, `scrolled to ${top}`).toBeLessThanOrEqual(844);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    expect(errors).toEqual([]);
  });

  test('the mini-player spans the screen without overflow and its buttons are thumb-sized', async ({ page }) => {
    const errors = await open(page);
    await listen(page, AUDIO_TITLE, true);
    await dialog(page).getByRole('button', { name: 'Minimise player' }).tap();
    await expect(mini(page)).toBeVisible();

    const bar = await box(mini(page));
    expect(bar.x).toBe(0);
    expect(bar.width).toBe(390);
    expect(bar.y + bar.height).toBeCloseTo(844, 0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

    const openButton = mini(page).getByRole('button', { name: `Open now playing: ${AUDIO_TITLE}` });
    expect((await box(openButton)).height).toBeGreaterThanOrEqual(44);
    const playPause = mini(page).getByTestId('mini-player-play');
    expect((await box(playPause)).height).toBeGreaterThanOrEqual(48);
    expect((await box(playPause)).width).toBeGreaterThanOrEqual(48);
    await playPause.tap();
    const stop = mini(page).getByRole('button', { name: 'Stop and close player' });
    await expect(stop).toBeVisible();
    expect((await box(stop)).height).toBeGreaterThanOrEqual(44);
    expect((await box(stop)).width).toBeGreaterThanOrEqual(44);

    // The page's end scrolls clear of the bar.
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const lastRow = await box(page.getByTestId('library-item').last());
    expect(lastRow.y + lastRow.height).toBeLessThanOrEqual(bar.y + 1);
    expect(errors).toEqual([]);
  });
});
