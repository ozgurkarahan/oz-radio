import { test, expect as baseExpect, type Locator, type Page } from '@playwright/test';
import {
  MEDIA, MOCKED_MEDIA_REASON, POD_AUDIO, POD_VIDEO, fulfillMedia, mockApi, mockBoot, mockedMediaUnavailable, routeExpiredMedia,
  type MockApiOptions,
} from './support/mock-api';

/**
 * UX-fix run, WU-E "Listen & watch" (contracts v1.2 §2.3, §2.4, §5.2, §6.2): the public podcast and video libraries and
 * their players — language and level before play, honest failure and empty states, recovery of an expired media link, the
 * `?video=` deep link, the phone sheet and the player's announcements. Every /api call is mocked (tests/support/mock-api.ts);
 * the media are real fixtures served with byte ranges, so the radio and the video genuinely load and play.
 *
 * Tests that prove a failure-matrix row start with its `[ID]` (T1-06, T2-01 … T2-12).
 */

// Playback runs in real time on a busy machine: allow generous waits.
const expect = baseExpect.configure({ timeout: 15_000 });
test.describe.configure({ timeout: 90_000 });

const VIDEO_TITLE = 'Agents on air'; // pod-2: video + radio, English, no level
const AUDIO_TITLE = 'Safety minute'; // pod-3: audio only, French, beginner
const LEGACY_TITLE = 'AI agents MCP'; // pod-1: legacy item (no format / level fields)
const NARRATED_TITLE = 'Context engineering rag'; // vid-1: narrated video, English, practitioner, captions

/** The narrated video as `GET /api/video/library/vid-1` answers it (the mock has no audio and one fixed media URL). */
const VIDEO_DETAIL = {
  job_id: 'vid-1', title: 'context-engineering-rag', language: 'en-US', created_at: '2026-10-15T00:05:00Z', thumbnail_url: null,
  duration_sec: 98, slide_count: 6, published: true, audience_level: 'practitioner', source_deck_id: null,
  captions_vtt_url: '/api/video/library/vid-1/captions.vtt', video_url: '/media/vid-1.mp4',
} as const;

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

async function openLibrary(page: Page, role: 'visitor' | 'admin' = 'visitor', opts: MockApiOptions = {}, path = '/podcast/library') {
  const errors = collectErrors(page);
  const api = await mockApi(page, role, { podcastV2: true, ...opts });
  await page.goto(path);
  return { api, errors };
}

const rowOf = (page: Page, title: string) => page.getByTestId('library-item').filter({ hasText: title });
const dialog = (page: Page) => page.getByRole('dialog');
const radio = (page: Page) => dialog(page).getByTestId('radio-player');
const radioAudio = (page: Page) => page.getByTestId('radio-audio');
const videoEl = (page: Page) => page.getByTestId('library-player');
const listenButton = (page: Page, title: string) => rowOf(page, title).getByRole('button', { name: `Listen to ${title}` });
const watchButton = (page: Page, title: string) => rowOf(page, title).getByRole('button', { name: `Watch ${title}` });
const playVideoButton = (page: Page, title = NARRATED_TITLE) => rowOf(page, title).getByRole('button', { name: `Play ${title}` });

const radioTime = (page: Page) => radioAudio(page).evaluate((a: HTMLAudioElement) => a.currentTime);
const videoPlaying = (page: Page) => videoEl(page).evaluate((v: HTMLVideoElement) => !v.paused && v.readyState >= 2 && v.currentTime > 0);

/** The audio has moved at least `by` seconds forward. */
async function expectAdvancing(page: Page, by = 0.4) {
  const from = await radioTime(page);
  await expect.poll(() => radioTime(page)).toBeGreaterThan(from + by);
}

/** Texts a polite status region announced (every text it held), recorded from now on. */
async function watchAnnouncer(page: Page, testId: string) {
  await page.evaluate((id) => {
    const w = window as unknown as { __announced: Record<string, string[]> };
    w.__announced ??= {};
    w.__announced[id] = [];
    const el = document.querySelector(`[data-testid=${id}]`)!;
    new MutationObserver(() => {
      const text = el.textContent?.trim();
      if (text) w.__announced[id].push(text);
    }).observe(el, { childList: true, characterData: true, subtree: true });
  }, testId);
}
const announced = (page: Page, testId: string) =>
  page.evaluate((id) => (window as unknown as { __announced: Record<string, string[]> }).__announced[id], testId);

/** Autoplay policy stand-in: the radio's play() is refused until the visitor has tapped or typed on the page. */
async function refuseAutoplayUntilGesture(page: Page) {
  await page.addInitScript(() => {
    let gestured = false;
    const mark = (e: Event) => { if (e.isTrusted) gestured = true; };
    window.addEventListener('pointerdown', mark, true);
    window.addEventListener('keydown', mark, true);
    const original = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function play(this: HTMLMediaElement) {
      if (this.dataset.ozMedia === 'radio' && !gestured) {
        return Promise.reject(new DOMException("play() failed because the user didn't interact with the document first.", 'NotAllowedError'));
      }
      return original.call(this);
    };
  });
}

/**
 * Simulated offline: the mock aborts every /api and /media request and `navigator.onLine` reads false. (The browser's own
 * offline switch would also cut the connection to the shared dev server mid-request, which can take that server down.)
 */
async function simulateOffline(page: Page) {
  let offline = false;
  await page.route('**/api/**', (r) => (offline ? r.abort('internetdisconnected') : r.fallback()));
  await page.route('**/media/**', (r) => (offline ? r.abort('internetdisconnected') : r.fallback()));
  return async (next: boolean) => {
    offline = next;
    await page.evaluate((off) => {
      Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => !off });
      window.dispatchEvent(new Event(off ? 'offline' : 'online'));
    }, next);
  };
}

const EXPIRED_XML = '<Error><Code>AuthenticationFailed</Code></Error>';

// ── WCAG contrast of a computed colour pair ──────────────────────────────────────────────────────────────────────
function rgbOf(css: string): [number, number, number] {
  const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(css);
  if (!m) throw new Error(`not an rgb colour: ${css}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}
function luminance([r, g, b]: [number, number, number]): number {
  const channel = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(rgbOf(a)), luminance(rgbOf(b))].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Failed lists, empty lists
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
test.describe('Lists: failed ≠ empty', () => {
  test('[T1-06] a proxy 503 on the podcast list: a friendly sentence, Try again and the public actions — no raw body, no empty state', async ({ page }) => {
    const source = { catalog: 'default' as const };
    const api = await mockApi(page, 'visitor', { podcastV2: true, libraryFailure: { podcast: 'proxy-503' } });
    await mockBoot(page, {}, source);
    const errors = collectErrors(page);
    await page.goto('/podcast/library');

    const failure = page.getByTestId('library-error');
    await expect(failure.getByRole('alert')).toContainText("We couldn't load the episodes right now. Please try again in a moment.");
    // The proxy's text never reaches the page, and a failure is not the empty site.
    expect(await page.locator('body').innerText()).not.toMatch(/upstream connect error|reset reason|connection failure|Failed to fetch/i);
    await expect(page.getByText(/No episodes are published yet|No published|Check back later/)).toHaveCount(0);
    await expect(page.getByTestId('library-empty')).toHaveCount(0);
    await expect(page.getByTestId('library-item')).toHaveCount(0);
    // The value stays: the live demo, the other library, the decks.
    await expect(failure.getByRole('link', { name: 'Start the live demo' })).toHaveAttribute('href', '/decks/deck-live/present');
    await expect(failure.getByRole('link', { name: 'Browse the video library' })).toHaveAttribute('href', '/video/library');
    await expect(failure.getByRole('link', { name: 'Browse decks' })).toHaveAttribute('href', '/decks');

    // "Try again" fetches the list again and the success replaces the alert.
    api.failures.podcast = null;
    await failure.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByTestId('library-item')).toHaveCount(3);
    await expect(page.getByTestId('library-error')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  for (const [library, path, what] of [['podcast', '/podcast/library', 'episodes'], ['video', '/video/library', 'videos']] as const) {
    test(`a failed ${library} list says why in plain words for a 503, a network failure and a gone endpoint`, async ({ page }) => {
      const api = await mockApi(page, 'visitor', { podcastV2: true, libraryFailure: { [library]: 503 } });
      const errors = collectErrors(page);
      await page.goto(path);
      const alert = page.getByTestId('library-error').getByRole('alert');
      await expect(alert).toContainText(`We couldn't load the ${what} right now.`);

      api.failures[library] = 'network';
      await page.getByTestId('library-error').getByRole('button', { name: 'Try again' }).click();
      await expect(alert).toContainText('You seem to be offline. Check your connection and try again.');
      expect(await page.locator('body').innerText()).not.toMatch(/Failed to fetch|Load failed|HTTP 5\d\d/);

      api.failures[library] = null;
      await page.getByTestId('library-error').getByRole('button', { name: 'Try again' }).click();
      await expect(page.getByTestId('library-item').first()).toBeVisible();
      await expect(page.getByTestId('library-error')).toHaveCount(0);
      expect(errors).toEqual([]);
    });
  }

  test('a refresh that fails while the list is on screen keeps the list and shows the alert above it', async ({ page }) => {
    const { api, errors } = await openLibrary(page);
    await expect(page.getByTestId('library-item')).toHaveCount(3);
    api.failures.podcast = 503;
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(page.getByTestId('library-error').getByRole('alert')).toContainText("We couldn't load the episodes right now.");
    await expect(page.getByTestId('library-item')).toHaveCount(3);
    api.failures.podcast = null;
    await page.getByTestId('library-error').getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByTestId('library-error')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  for (const [id, library, path, title, others] of [
    ['T2-10', 'podcast', '/podcast/library', 'No episodes are published yet', ['Browse the video library', 'Browse decks']],
    ['T2-11', 'video', '/video/library', 'No videos are published yet', ['Listen to an episode', 'Browse decks']],
  ] as const) {
    test(`[${id}] a truly empty ${library} library says so and offers the public actions before any sign-in`, async ({ page }) => {
      const source = { catalog: 'default' as const };
      await mockApi(page, 'visitor', { podcastV2: true });
      await page.route(`**/api/${library}/library`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
      await mockBoot(page, {}, source);
      const errors = collectErrors(page);
      await page.goto(path);

      const empty = page.getByTestId('library-empty');
      await expect(empty).toContainText(title);
      await expect(page.getByTestId('library-error')).toHaveCount(0);
      const live = empty.getByRole('link', { name: 'Start the live demo' });
      await expect(live).toHaveAttribute('href', '/decks/deck-live/present');
      const links = [live, ...others.map((name) => empty.getByRole('link', { name }))];
      for (const link of links) await expect(link).toBeVisible();
      // Sign-in never comes first: every public action sits above the gate notice.
      const gate = empty.getByTestId('auth-gate');
      await expect(gate).toBeVisible();
      const gateTop = (await gate.boundingBox())!.y;
      for (const link of links) expect((await link.boundingBox())!.y, `${await link.textContent()} is above the sign-in notice`).toBeLessThan(gateTop);
      expect(errors).toEqual([]);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Opening an episode or a video that does not open
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
test.describe('Opening fails', () => {
  test('[T2-01] a stale episode link: "isn\'t available any more" + Back to all episodes; unavailable and offline have their own words and Try again', async ({ page }) => {
    const { api, errors } = await openLibrary(page, 'visitor', {}, '/podcast/library?episode=pod-9&mode=listen');

    // 404: the episode is gone. The cause in plain words, focus on it, the list stays, the dead link is dropped.
    const gone = page.getByTestId('library-open-error');
    await expect(gone).toContainText("This episode isn't available any more.");
    await expect(gone).not.toContainText(/Failed to open|Library item not found/);
    await expect(gone).toBeFocused();
    await expect(page.getByTestId('library-item')).toHaveCount(3);
    await expect(page).toHaveURL(/\/podcast\/library$/);
    await expect(dialog(page)).toHaveCount(0);
    await gone.getByRole('button', { name: 'Back to all episodes' }).click();
    await expect(gone).toHaveCount(0);
    await expect(page.locator('.library-list .episode-row__title').first()).toBeFocused();

    // Storage unavailable: friendly sentence and Try again, which fetches the episode afresh and opens it.
    api.detailFailures.podcast = 503;
    await page.goto('/podcast/library?episode=pod-2&mode=watch');
    await expect(gone).toContainText("We couldn't load this episode right now. Please try again in a moment.");
    await expect(gone).not.toContainText(/Failed to open|Library temporarily unavailable|Library storage/);
    api.detailFailures.podcast = null;
    await gone.getByRole('button', { name: 'Try again' }).click();
    await expect(dialog(page)).toHaveAttribute('data-mode', 'watch');
    await expect(videoEl(page)).toHaveAttribute('src', POD_VIDEO.mp4_url!);
    await expect(gone).toHaveCount(0);
    await page.keyboard.press('Escape');

    // A network failure reads as being offline, never as "Failed to fetch".
    api.detailFailures.podcast = 'network';
    await page.goto('/podcast/library?episode=pod-2&mode=watch');
    await expect(gone).toContainText('You seem to be offline. Check your connection and try again.');
    expect(await page.locator('body').innerText()).not.toMatch(/Failed to fetch|Load failed/);
    expect(errors).toEqual([]);
  });

  test('[T2-12] offline when opening an episode: "You seem to be offline", Try again once online, the other items stay listed', async ({ page }) => {
    const { errors } = await openLibrary(page);
    await expect(rowOf(page, VIDEO_TITLE)).toBeVisible();
    await page.waitForLoadState('networkidle');
    const setOffline = await simulateOffline(page);
    await setOffline(true);

    await watchButton(page, VIDEO_TITLE).click(); // Watch always fetches the episode: its video is page-owned
    const alert = page.getByTestId('library-open-error');
    await expect(alert).toContainText('You seem to be offline. Check your connection and try again.');
    expect(await page.locator('body').innerText()).not.toMatch(/Failed to fetch|Load failed|Failed to open/);
    await expect(page.getByTestId('library-item')).toHaveCount(3);
    await expect(dialog(page)).toHaveCount(0);

    await setOffline(false);
    await alert.getByRole('button', { name: 'Try again' }).click();
    await expect(dialog(page)).toHaveAttribute('data-mode', 'watch');
    await expect(videoEl(page)).toHaveAttribute('src', POD_VIDEO.mp4_url!);
    await expect(alert).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('[T2-09] a video that does not open: the cause by status next to the list (focused), Try again for unavailable and offline', async ({ page }) => {
    const errors = collectErrors(page);
    const api = await mockApi(page, 'visitor');
    await page.goto('/video/library');
    await expect(page.getByTestId('library-item')).toHaveCount(1);

    // 404 (unpublished since the list was loaded)
    api.detailFailures.video = 404;
    await playVideoButton(page).click();
    const alert = page.getByTestId('library-open-error');
    await expect(alert).toContainText("This video isn't available any more.");
    await expect(alert).not.toContainText(/Failed to open|Library item not found/);
    await expect(alert).toBeFocused();
    await expect(page.getByTestId('library-item')).toHaveCount(1);
    await expect(dialog(page)).toHaveCount(0);
    await expect(page).toHaveURL(/\/video\/library$/);
    await alert.getByRole('button', { name: 'Back to all videos' }).click();
    await expect(alert).toHaveCount(0);

    // 503 → Try again fetches it afresh and opens the player
    api.detailFailures.video = 503;
    await playVideoButton(page).click();
    await expect(alert).toContainText("We couldn't load this video right now. Please try again in a moment.");
    await expect(alert).toBeFocused();
    api.detailFailures.video = 'network';
    await alert.getByRole('button', { name: 'Try again' }).click();
    await expect(alert).toContainText('You seem to be offline. Check your connection and try again.');
    expect(await page.locator('body').innerText()).not.toMatch(/Failed to fetch|Load failed|Failed to open/);
    api.detailFailures.video = null;
    await alert.getByRole('button', { name: 'Try again' }).click();
    await expect(dialog(page).getByRole('heading', { name: NARRATED_TITLE })).toBeVisible();
    await expect(videoEl(page)).toHaveAttribute('src', '/media/vid-1.mp4');
    await expect(alert).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Listen: recovery, autoplay, announcements
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
test.describe('Listen: recovery and announcements', () => {
  test.skip(mockedMediaUnavailable, MOCKED_MEDIA_REASON);

  test('[T2-02] offline when tapping Listen: "You seem to be offline", the transcript stays, Try again plays once online', async ({ page }) => {
    const { errors } = await openLibrary(page);
    await expect(rowOf(page, AUDIO_TITLE)).toBeVisible();
    await page.waitForLoadState('networkidle'); // the first rows are prefetched for one-tap Listen
    const setOffline = await simulateOffline(page);
    await setOffline(true);

    await listenButton(page, AUDIO_TITLE).click();
    const player = radio(page);
    await expect(player).toHaveAttribute('data-state', 'error', { timeout: 20_000 });
    await expect(player.getByTestId('radio-error')).toContainText('You seem to be offline. Check your connection and try again.');
    await expect(player.getByTestId('radio-error')).not.toContainText(/Failed to fetch|couldn't be loaded/);
    await expect(player.getByTestId('radio-speaker')).toHaveText('Audio unavailable');
    // The transcript stays expandable while nothing plays.
    await player.getByTestId('radio-transcript-toggle').click();
    await expect(player.getByTestId('radio-cue')).toHaveCount(2);

    await setOffline(false);
    await player.getByRole('button', { name: 'Try again' }).click();
    await expect(player).toHaveAttribute('data-state', 'playing');
    await expect(player.getByTestId('radio-error')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('[T2-03] an expired media link is renewed automatically: "Reconnecting…" (announced), then it plays again', async ({ page }) => {
    const errors = collectErrors(page);
    await mockApi(page, 'visitor', { podcastV2: true });
    await routeExpiredMedia(page, '**/media/pod-2.mp3', { times: 1 });
    let details = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route('**/api/podcast/library/pod-2', async (route) => {
      details += 1;
      if (details > 1) await gate; // the renewal is slow: the player says so meanwhile
      return route.fallback();
    });
    await page.goto('/podcast/library');
    await expect.poll(() => details).toBe(1); // prefetched with the first rows

    await listenButton(page, VIDEO_TITLE).click();
    const player = radio(page);
    await expect(player).toHaveAttribute('data-state', 'refreshing');
    await expect(player.getByTestId('radio-speaker')).toHaveText('Reconnecting…');
    await expect(player.getByTestId('radio-announcer')).toHaveText('Reconnecting…');
    release();
    await expect(player).toHaveAttribute('data-state', 'playing');
    await expectAdvancing(page);
    await expect(player.getByTestId('radio-error')).toHaveCount(0);
    expect(details).toBe(2);
    expect(errors).toEqual([]);
  });

  test('[T2-04] a media error whose renewal fails too: the cause, the transcript and Watch instead stay; Try again always fetches afresh', async ({ page }) => {
    const errors = collectErrors(page);
    await mockApi(page, 'visitor', { podcastV2: true });
    let healthy = false;
    await page.route('**/media/pod-2.mp3', (route) => (healthy
      ? route.fallback()
      : route.fulfill({ status: 403, contentType: 'application/xml', body: EXPIRED_XML })));
    let details = 0;
    await page.route('**/api/podcast/library/pod-2', (route) => {
      details += 1;
      if (details > 1 && !healthy) {
        return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ detail: 'Library temporarily unavailable' }) });
      }
      return route.fallback();
    });
    await page.goto('/podcast/library');
    await expect.poll(() => details).toBe(1);

    await listenButton(page, VIDEO_TITLE).click();
    const player = radio(page);
    await expect(player).toHaveAttribute('data-state', 'error', { timeout: 20_000 });
    await expect(player.getByTestId('radio-error')).toContainText('Audio unavailable — the link expired or the connection dropped.');
    await expect(player.getByTestId('radio-speaker')).toHaveText('Audio unavailable');
    // The value stays: the transcript, and the other medium.
    await player.getByTestId('radio-transcript-toggle').click();
    await expect(player.getByTestId('radio-cue').first()).toBeVisible();
    await expect(dialog(page).getByTestId('watch-instead')).toBeVisible();

    // "Try again" fetches the episode afresh — even inside the minute that throttles the automatic renewal.
    const before = details;
    await player.getByRole('button', { name: 'Try again' }).click();
    await expect.poll(() => details).toBe(before + 1);
    await expect(player).toHaveAttribute('data-state', 'error');
    healthy = true;
    await player.getByRole('button', { name: 'Try again' }).click();
    await expect.poll(() => details).toBe(before + 2);
    await expect(player).toHaveAttribute('data-state', 'playing');
    await expect(player.getByTestId('radio-error')).toHaveCount(0);
    await expect(dialog(page).getByTestId('watch-instead')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('[T2-05] autoplay refused: the cause, "Press play to start listening", Play highlighted — announced; one tap plays; the cover waits for it', async ({ page }) => {
    await refuseAutoplayUntilGesture(page);
    let covers = 0;
    await mockApi(page, 'visitor', { podcastV2: true });
    await page.route('**/media/pod-2-cover.png', (route) => { covers += 1; return route.fallback(); });
    const errors = collectErrors(page);
    await page.goto('/podcast/library?episode=pod-2&mode=listen');

    const player = radio(page);
    await expect(player).toHaveAttribute('data-state', 'press-play');
    await expect(player.getByTestId('radio-hint')).toHaveText('Your browser blocked autoplay.');
    await expect(player.getByTestId('radio-speaker')).toHaveText('Press play to start listening');
    await expect(player.getByTestId('radio-play')).toHaveClass(/is-attention/);
    await expect(player.getByTestId('radio-announcer')).toHaveText('Your browser blocked autoplay. Press play to start listening.');
    // Nothing has played yet: the cover image is not downloaded (the audio gets the bandwidth first).
    await expect(player.getByTestId('radio-cover')).toHaveAttribute('data-cover', 'placeholder');
    expect(covers).toBe(0);

    await player.getByTestId('radio-play').click();
    await expect(player).toHaveAttribute('data-state', 'playing');
    await expect(player.getByTestId('radio-hint')).toHaveCount(0);
    await expect(player.getByTestId('radio-cover')).toHaveAttribute('data-cover', 'image');
    await expect.poll(() => covers).toBeGreaterThan(0);
    await expect(player.getByTestId('radio-announcer')).toHaveText('');
    expect(errors).toEqual([]);
  });

  test('the player announces state transitions politely — loading, paused — and never the per-speaker status line', async ({ page }) => {
    const { errors } = await openLibrary(page);
    await listenButton(page, VIDEO_TITLE).click();
    const player = radio(page);
    await expect(player).toHaveAttribute('data-state', 'playing');
    const announcer = player.getByTestId('radio-announcer');
    await expect(announcer).toHaveAttribute('role', 'status');
    await expect(announcer).toHaveAttribute('aria-live', 'polite');
    await expect(player.getByTestId('radio-caption')).toHaveAttribute('aria-live', 'off');
    await watchAnnouncer(page, 'radio-announcer');

    // Cross several turns while playing: the status line changes speaker, the region stays silent.
    const slider = player.getByRole('slider', { name: 'Seek' });
    await slider.focus();
    for (let i = 0; i < 4; i += 1) {
      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(250);
    }
    await expect(player.getByTestId('radio-speaker')).toHaveText(/is speaking$/);
    await expect(announcer).toHaveText('');

    await player.getByTestId('radio-play').click();
    await expect(player).toHaveAttribute('data-state', 'paused');
    await expect(announcer).toHaveText('Paused');
    await player.getByTestId('radio-play').click();
    await expect(player).toHaveAttribute('data-state', 'playing');
    await expect(announcer).toHaveText(''); // cleared, so the next "Paused" reads again
    await player.getByTestId('radio-play').click();
    await expect(announcer).toHaveText('Paused');

    const log = await announced(page, 'radio-announcer');
    expect(log.length).toBeGreaterThan(0);
    for (const text of log) expect(text, 'only state transitions are announced').toMatch(/^(Loading…|Reconnecting…|Paused|Your browser blocked autoplay\. Press play to start listening\.)$/);
    expect(log.filter((t) => /speaking|Intro|Outro/.test(t))).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('C2.2: tapping Listen answers within a second even when the audio is slow — the sheet opens and says Loading…', async ({ page }) => {
    const errors = collectErrors(page);
    await mockApi(page, 'visitor', { podcastV2: true });
    await page.route('**/media/pod-2.mp3', async (route) => {
      await new Promise((resolve) => { setTimeout(resolve, 4000); });
      await route.fallback();
    });
    await page.goto('/podcast/library');
    await expect(rowOf(page, VIDEO_TITLE)).toBeVisible();
    await page.evaluate(() => {
      const w = window as unknown as { __tapAt: number; __feedbackAt: number };
      w.__tapAt = 0;
      w.__feedbackAt = 0;
      document.addEventListener('click', () => { if (!w.__tapAt) w.__tapAt = performance.now(); }, true);
      new MutationObserver(() => {
        const state = document.querySelector('[data-testid=radio-player]')?.getAttribute('data-state') ?? '';
        if (/^(buffering|refreshing)$/.test(state) && !w.__feedbackAt) w.__feedbackAt = performance.now();
      }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-state'] });
    });

    await listenButton(page, VIDEO_TITLE).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __feedbackAt: number }).__feedbackAt)).toBeGreaterThan(0);
    const { tap, feedback } = await page.evaluate(() => {
      const w = window as unknown as { __tapAt: number; __feedbackAt: number };
      return { tap: w.__tapAt, feedback: w.__feedbackAt };
    });
    expect(feedback - tap, 'tap → "Loading…" in ms').toBeLessThan(1000);
    await expect(radio(page).getByTestId('radio-speaker')).toHaveText('Loading…');
    await expect(radio(page).locator('.radio-player__speaker .spinner')).toBeVisible();
    await expect(radio(page)).toHaveAttribute('data-state', 'playing', { timeout: 20_000 });
    expect(errors).toEqual([]);
  });

  test('C2.1: one tap on Listen and the episode is audible', async ({ page }) => {
    const { errors } = await openLibrary(page);
    await listenButton(page, VIDEO_TITLE).click();
    await expect(radio(page)).toHaveAttribute('data-state', 'playing');
    await expectAdvancing(page);
    expect(errors).toEqual([]);
  });

  test('the mini-player announces a state change when it is the only player on screen (autoplay refused, sheet minimised)', async ({ page }) => {
    await refuseAutoplayUntilGesture(page);
    await mockApi(page, 'visitor', { podcastV2: true });
    const errors = collectErrors(page);
    await page.goto('/podcast/library?episode=pod-2&mode=listen');
    await expect(radio(page)).toHaveAttribute('data-state', 'press-play');
    await dialog(page).getByRole('button', { name: 'Minimise player' }).click();
    const mini = page.getByTestId('mini-player');
    await expect(mini).toBeVisible();
    await expect(mini.getByTestId('mini-player-status')).toHaveText('Press play');
    const announcer = mini.getByTestId('mini-player-announcer');
    await expect(announcer).toHaveAttribute('role', 'status');
    await expect(announcer).toHaveAttribute('aria-live', 'polite');
    await expect(announcer).toHaveText('Press play to start listening');
    expect(errors).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Watch: a video that cannot play
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
test.describe('Watch: recovery', () => {
  test.skip(mockedMediaUnavailable, MOCKED_MEDIA_REASON);

  test('[T2-06] a narrated video with an expired link: one automatic refresh, then the cause, Try again and Listen instead — no download of a failing URL', async ({ page }) => {
    const errors = collectErrors(page);
    await mockApi(page, 'visitor');
    let healthy = false;
    let withAudio = true;
    let details = 0;
    await page.route('**/media/vid-1.mp4', (route) => (healthy
      ? fulfillMedia(route, MEDIA.mp4)
      : route.fulfill({ status: 403, contentType: 'application/xml', body: EXPIRED_XML })));
    await page.route('**/api/video/library/vid-1', (route) => {
      details += 1;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...VIDEO_DETAIL, ...(withAudio ? { audio_url: '/media/vid-1.mp3' } : {}) }) });
    });
    await page.goto('/video/library');
    await expect(page.getByTestId('library-item')).toHaveCount(1);

    await playVideoButton(page).click();
    const problem = dialog(page).getByTestId('video-problem');
    await expect(problem).toBeVisible({ timeout: 20_000 });
    await expect(problem.getByRole('alert')).toContainText("This video couldn't be played.");
    expect(details, 'the open + exactly one automatic refresh').toBe(2);
    await page.waitForTimeout(1200);
    expect(details, 'no refresh loop').toBe(2);
    await expect(problem.getByRole('button', { name: 'Try again' })).toBeFocused();
    await expect(problem.getByRole('button', { name: 'Listen instead' })).toBeVisible();
    await expect(dialog(page).getByRole('link', { name: /Download MP4/ })).toHaveCount(0);
    await expect(videoEl(page)).toBeHidden(); // the failed player stays in the DOM under the panel, out of sight and out of the accessibility tree

    // "Try again" is a fresh fetch, whatever happened before.
    await problem.getByRole('button', { name: 'Try again' }).click();
    await expect.poll(() => details).toBe(3);
    await expect(problem).toBeVisible();
    // No audio: nothing to listen to instead.
    withAudio = false;
    await problem.getByRole('button', { name: 'Try again' }).click();
    await expect.poll(() => details).toBe(4);
    await expect(problem).toBeVisible();
    await expect(problem.getByRole('button', { name: 'Listen instead' })).toHaveCount(0);

    // The link works again: Try again plays the video and brings the download back.
    healthy = true;
    await problem.getByRole('button', { name: 'Try again' }).click();
    await expect.poll(() => details).toBe(5);
    await expect(videoEl(page)).toBeVisible();
    await expect.poll(() => videoPlaying(page)).toBe(true);
    await expect(problem).toHaveCount(0);
    await expect(dialog(page).getByRole('link', { name: /Download MP4/ })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('[T2-06] an expired link that the one automatic refresh renews plays on by itself', async ({ page }) => {
    const errors = collectErrors(page);
    await mockApi(page, 'visitor');
    let mediaRequests = 0;
    await page.route('**/media/vid-1.mp4', (route) => {
      mediaRequests += 1;
      return mediaRequests === 1
        ? route.fulfill({ status: 403, contentType: 'application/xml', body: EXPIRED_XML })
        : fulfillMedia(route, MEDIA.mp4);
    });
    await page.goto('/video/library');
    await playVideoButton(page).click();
    await expect(videoEl(page)).toBeVisible();
    await expect.poll(() => videoPlaying(page), { timeout: 20_000 }).toBe(true);
    await expect(dialog(page).getByTestId('video-problem')).toHaveCount(0);
    expect(mediaRequests).toBeGreaterThanOrEqual(2);
    expect(errors).toEqual([]);
  });

  test('[T2-07] a podcast video that will not play: the same panel; Listen instead switches to the Listen tab', async ({ page }) => {
    const errors = collectErrors(page);
    await mockApi(page, 'visitor', { podcastV2: true });
    await routeExpiredMedia(page, '**/media/pod-2.mp4');
    await page.goto('/podcast/library');
    await expect(rowOf(page, VIDEO_TITLE)).toBeVisible();

    await watchButton(page, VIDEO_TITLE).click();
    const d = dialog(page);
    const problem = d.getByTestId('video-problem');
    await expect(problem).toBeVisible({ timeout: 20_000 });
    await expect(problem.getByRole('alert')).toContainText("This video couldn't be played.");
    await expect(problem.getByRole('button', { name: 'Try again' })).toBeFocused();
    await expect(d.getByRole('link', { name: /Download MP4/ })).toHaveCount(0);
    // The other medium is one tap away, in the panel and in the tabs.
    await expect(d.getByRole('tab', { name: 'Listen' })).toBeVisible();
    await problem.getByRole('button', { name: 'Listen instead' }).click();
    await expect(d).toHaveAttribute('data-mode', 'listen');
    await expect(d.getByRole('tab', { name: 'Listen' })).toHaveAttribute('aria-selected', 'true');
    await expect(radio(page)).toHaveAttribute('data-state', 'playing');
    await expect(page).toHaveURL(/\?episode=pod-2&mode=listen$/);
    expect(errors).toEqual([]);
  });

  test('[T2-07] a podcast video whose link is renewed by the automatic refresh plays on, and Try again heals a failing one', async ({ page }) => {
    const errors = collectErrors(page);
    await mockApi(page, 'visitor', { podcastV2: true });
    let healthy = false;
    await page.route('**/media/pod-2.mp4', (route) => (healthy
      ? route.fallback()
      : route.fulfill({ status: 403, contentType: 'application/xml', body: EXPIRED_XML })));
    await page.goto('/podcast/library');
    await watchButton(page, VIDEO_TITLE).click();
    const problem = dialog(page).getByTestId('video-problem');
    await expect(problem).toBeVisible({ timeout: 20_000 });
    healthy = true;
    await problem.getByRole('button', { name: 'Try again' }).click();
    await expect(videoEl(page)).toBeVisible();
    await expect.poll(() => videoPlaying(page)).toBe(true);
    await expect(problem).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('[T2-08] a video without a playable rendition: the cause, Try again re-fetches, Close stays; other episodes remain', async ({ page }) => {
    const errors = collectErrors(page);
    await mockApi(page, 'visitor');
    let playable = false;
    let details = 0;
    await page.route('**/media/vid-1.mp4', (route) => fulfillMedia(route, MEDIA.mp4));
    await page.route('**/api/video/library/vid-1', (route) => {
      details += 1;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...VIDEO_DETAIL, video_url: playable ? VIDEO_DETAIL.video_url : null }) });
    });
    await page.goto('/video/library');
    await playVideoButton(page).click();
    const d = dialog(page);
    const problem = d.getByTestId('video-problem');
    await expect(problem.getByRole('alert')).toContainText("This video isn't available to play right now.");
    await expect(problem).toHaveAttribute('data-kind', 'unavailable');
    await expect(d.getByRole('button', { name: 'Close' })).toBeVisible();
    await expect(d.getByRole('link', { name: /Download MP4/ })).toHaveCount(0);
    await expect(page.getByTestId('library-item')).toHaveCount(1); // the library behind the player

    playable = true;
    await problem.getByRole('button', { name: 'Try again' }).click();
    await expect(videoEl(page)).toHaveAttribute('src', '/media/vid-1.mp4');
    expect(details).toBe(2);
    await expect(problem).toHaveCount(0);
    await d.getByRole('button', { name: 'Close' }).click();
    await expect(d).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Language and level before play (C2.3, P1-2)
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
test.describe('Language and level', () => {
  test('podcast rows show the audience level first in the meta line and mark the language of their title', async ({ page }) => {
    const { errors } = await openLibrary(page);
    await expect(page.getByTestId('library-item')).toHaveCount(3);

    const fr = rowOf(page, AUDIO_TITLE);
    await expect(fr.locator('.episode-row__title')).toHaveAttribute('lang', 'fr');
    const chip = fr.getByTestId('episode-level');
    await expect(chip).toHaveText('Beginner');
    await expect(chip).toHaveAttribute('data-level', 'beginner');
    await expect(chip).toBeVisible();
    await expect(fr.locator('.episode-row__meta > *').first().getByTestId('episode-level')).toHaveCount(0); // chip itself is the first child
    expect(await fr.locator('.episode-row__meta > *').first().getAttribute('data-testid')).toBe('episode-level');
    // "Français" is French text in an English page: it carries its own language.
    await expect(fr.locator('.episode-row__meta [lang="fr"]')).toHaveText('Français');
    // One level chip per row: the old "Beginner audience" chip is no longer repeated next to it.
    await expect(fr.getByTestId('audience-chip')).toHaveCount(0);

    const en = rowOf(page, VIDEO_TITLE);
    await expect(en.locator('.episode-row__title')).toHaveAttribute('lang', 'en');
    await expect(en.getByTestId('episode-level')).toHaveCount(0); // no level: nothing to show
    await expect(rowOf(page, LEGACY_TITLE).getByTestId('episode-level')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('the level chip is styled with tokens only and stays visible on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const { errors } = await openLibrary(page);
    const chip = rowOf(page, AUDIO_TITLE).getByTestId('episode-level');
    await expect(chip).toBeVisible();
    const style = await chip.evaluate((el) => {
      const s = getComputedStyle(el);
      const root = getComputedStyle(document.documentElement);
      return { color: s.color, bg: s.backgroundColor, border: s.borderTopColor, sage: root.getPropertyValue('--c-sage').trim() };
    });
    expect(style.bg === 'rgba(0, 0, 0, 0)' || style.bg === 'transparent').toBe(true); // an outline chip, not another filled pill
    expect(style.color).toBe(style.border);
    expect(contrast(style.color, 'rgb(246, 241, 232)'), 'level chip text on the page background').toBeGreaterThanOrEqual(4.5);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    expect(errors).toEqual([]);
  });

  test('video rows: level chip, language marks, and the duration visible on a phone only in the meta line', async ({ page }) => {
    const { errors } = await openLibrary(page, 'visitor', {}, '/video/library');
    const row = rowOf(page, NARRATED_TITLE);
    await expect(row.getByTestId('episode-level')).toHaveText('Practitioner');
    await expect(row.locator('.episode-row__title')).toHaveAttribute('lang', 'en');
    await expect(row.locator('.episode-row__meta [lang="en"]')).toHaveText('English');
    // Wide screen: the duration column carries it; the inline copy is not shown (no duplicate).
    await expect(row.locator('.episode-row__dur')).toHaveText('1:38');
    await expect(row.getByTestId('library-duration')).toBeHidden();

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(row.locator('.episode-row__dur')).toBeHidden();
    await expect(row.getByTestId('library-duration')).toBeVisible();
    await expect(row.getByTestId('library-duration')).toContainText('1:38');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    expect(errors).toEqual([]);
  });

  test('podcast rows keep their duration visible on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const { errors } = await openLibrary(page);
    const dur = rowOf(page, VIDEO_TITLE).locator('.episode-row__dur');
    await expect(dur).toBeVisible();
    // Audio and video differ here: each format carries its own length.
    await expect(dur).toContainText('0:40');
    await expect(dur).toContainText('0:30');
    expect(errors).toEqual([]);
  });

  test('a French episode: the player marks its title, caption and transcript as French and uses the French role labels', async ({ page }) => {
    const { errors } = await openLibrary(page);
    await listenButton(page, AUDIO_TITLE).click();
    const d = dialog(page);
    const player = radio(page);
    await expect(player).toBeVisible();

    await expect(player.locator('.radio-player__title')).toHaveAttribute('lang', 'fr');
    await expect(player.getByTestId('radio-caption')).toHaveAttribute('lang', 'fr');
    await expect(player.getByTestId('radio-language').locator('[lang="fr"]')).toHaveText('Français');
    await expect(player.getByTestId('radio-level')).toHaveText('Beginner');
    await expect(player.getByTestId('radio-level')).toHaveAttribute('data-level', 'beginner');
    await expect(player.locator('.radio-player__host-role')).toHaveText(['Journaliste', 'Expert']);
    await expect(player.locator('.radio-player__host-role').first()).toHaveAttribute('lang', 'fr');
    await player.getByTestId('radio-transcript-toggle').click();
    await expect(player.locator('.radio-player__cues')).toHaveAttribute('lang', 'fr');
    // The dialog is named by its French heading, which carries the language.
    await expect(page.getByRole('dialog', { name: AUDIO_TITLE })).toBeVisible();
    await expect(d.locator('h2.library-player__title')).toHaveAttribute('lang', 'fr');
    const labelledBy = await d.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    await expect(d.locator(`[id="${labelledBy}"]`)).toHaveAttribute('lang', 'fr');
    // Chrome around the content stays English: the dialog itself is not marked French.
    await expect(d).not.toHaveAttribute('lang', /./);
    await expect(d.getByRole('button', { name: 'Minimise player' })).not.toHaveAttribute('lang', /./);

    // The mini-player keeps the title's language too.
    await d.getByRole('button', { name: 'Minimise player' }).click();
    await expect(page.getByTestId('mini-player').locator('.mini-player__title')).toHaveAttribute('lang', 'fr');
    expect(errors).toEqual([]);
  });

  test('a French narrated video: level chip, French title and language marks, a French captions track', async ({ page }) => {
    const { errors } = await openLibrary(page, 'visitor', { catalog: 'demo' }, '/video/library');
    const row = rowOf(page, 'Démo enregistrée');
    await expect(row.locator('.episode-row__title')).toHaveAttribute('lang', 'fr');
    await expect(row.getByTestId('episode-level')).toHaveText('Beginner');
    await expect(row.locator('.episode-row__meta [lang="fr"]')).toHaveText('Français');
    await row.getByRole('button', { name: /^Play / }).click();
    const d = dialog(page);
    await expect(page.getByRole('dialog', { name: /Démo enregistrée/ })).toBeVisible();
    await expect(d.locator('h2.library-player__title')).toHaveAttribute('lang', 'fr');
    await expect(d.locator('.library-player__meta [lang="fr"]')).toHaveText('Français');
    await expect(d).not.toHaveAttribute('lang', /./);
    const track = d.locator('video track');
    await expect(track).toHaveAttribute('srclang', 'fr');
    await expect(track).toHaveAttribute('label', 'Français');
    await expect(track).not.toHaveAttribute('default', /.*/);
    expect(errors).toEqual([]);
  });

  test('an admin\'s failed publish says so in a sentence — never the raw error text', async ({ page }) => {
    const { errors } = await openLibrary(page, 'admin', {}, '/video/library');
    await page.route('**/api/video/library/vid-1/publish', (route) => route.fulfill({
      status: 500, contentType: 'text/plain', body: 'Traceback (most recent call last): boom',
    }));
    await rowOf(page, NARRATED_TITLE).getByTestId('publish-toggle').click();
    await expect(page.getByRole('alert').filter({ hasText: "Publish update didn't go through. Please try again." })).toBeVisible();
    expect(await page.locator('body').innerText()).not.toMatch(/Traceback|boom/);
    expect(errors).toEqual([]);
  });

  test('an English episode: English role labels, English title, level only when it has one', async ({ page }) => {
    const { errors } = await openLibrary(page);
    await listenButton(page, VIDEO_TITLE).click();
    const player = radio(page);
    await expect(player).toBeVisible();
    await expect(player.locator('.radio-player__title')).toHaveAttribute('lang', 'en');
    await expect(player.locator('.radio-player__host-role')).toHaveText(['Interviewer', 'Expert']);
    await expect(player.locator('.radio-player__host-role').first()).not.toHaveAttribute('lang', /./);
    await expect(player.getByTestId('radio-level')).toHaveCount(0);
    await expect(player.getByTestId('radio-language')).toHaveText('English');
    expect(errors).toEqual([]);
  });

  test('French role labels also name hosts that the episode does not name', async ({ page }) => {
    const errors = collectErrors(page);
    await mockApi(page, 'visitor', { podcastV2: true });
    // An episode with no host names anywhere: the labels are the names.
    const nameless = { ...(await import('./support/mock-api')).podcastLibraryItem(POD_AUDIO.job_id, 'visitor', { podcastV2: true })!, hosts: [], speaker_names: [], transcript: { ...POD_AUDIO.transcript, hosts: [] } };
    await page.route('**/api/podcast/library/pod-3', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(nameless) }));
    await page.goto('/podcast/library');
    await listenButton(page, AUDIO_TITLE).click();
    await expect(radio(page).locator('.radio-player__host-name')).toHaveText(['Journaliste', 'Expert']);
    expect(errors).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Captions track (never default), deep link, Back
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
test.describe('Video: captions track, deep link, history', () => {
  test('the video carries a captions <track> from captions_vtt_url — never `default` (the captions are burned in)', async ({ page }) => {
    const { errors } = await openLibrary(page, 'visitor', {}, '/video/library');
    await playVideoButton(page).click();
    const track = dialog(page).locator('video track');
    await expect(track).toHaveCount(1);
    await expect(track).toHaveAttribute('kind', 'captions');
    await expect(track).toHaveAttribute('src', '/api/video/library/vid-1/captions.vtt');
    await expect(track).toHaveAttribute('srclang', 'en');
    await expect(track).toHaveAttribute('label', 'English');
    await expect(track).not.toHaveAttribute('default', /.*/);
    const state = await videoEl(page).evaluate((v: HTMLVideoElement) => {
      const t = v.textTracks[0];
      const el = v.querySelector('track') as HTMLTrackElement;
      return { count: v.textTracks.length, kind: t.kind, mode: t.mode, isDefault: el.default };
    });
    expect(state).toEqual({ count: 1, kind: 'captions', mode: 'disabled', isDefault: false });
    expect(errors).toEqual([]);
  });

  test('podcast Watch gets the same track; an item without captions gets none', async ({ page }) => {
    const { errors } = await openLibrary(page);
    await watchButton(page, VIDEO_TITLE).click();
    const track = dialog(page).locator('video track');
    await expect(track).toHaveAttribute('src', '/api/podcast/library/pod-2/captions.vtt');
    await expect(track).toHaveAttribute('kind', 'captions');
    await expect(track).toHaveAttribute('srclang', 'en');
    await expect(track).not.toHaveAttribute('default', /.*/);
    await page.keyboard.press('Escape');

    // The legacy item has no `captions_vtt_url`: no track at all.
    await watchButton(page, LEGACY_TITLE).click();
    await expect(videoEl(page)).toHaveAttribute('src', '/media/pod-1.mp4');
    await expect(dialog(page).locator('video track')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('?video=<job_id> opens that video\'s player like a tap would (the live-demo fallback link); ?job= keeps working', async ({ page }) => {
    const { errors } = await openLibrary(page, 'visitor', {}, '/video/library?video=vid-1');
    const d = dialog(page);
    await expect(d.getByRole('heading', { name: NARRATED_TITLE })).toBeVisible();
    await expect(videoEl(page)).toHaveAttribute('src', '/media/vid-1.mp4');
    await expect(page.getByTestId('library-item')).toHaveCount(1); // the library is there behind it
    await page.keyboard.press('Escape');
    await expect(d).toHaveCount(0);
    await expect(page).toHaveURL(/\/video\/library$/);

    await page.goto('/video/library?job=vid-1');
    await expect(d.getByRole('heading', { name: NARRATED_TITLE })).toBeVisible();
    await expect(videoEl(page)).toHaveAttribute('src', '/media/vid-1.mp4');
    await page.keyboard.press('Escape');
    await expect(d).toHaveCount(0);
    await expect(page).toHaveURL(/\/video\/library$/);
    expect(errors).toEqual([]);
  });

  test('the video player pushes a history entry: Back closes it, Forward reopens it, Escape leaves no stray entry', async ({ page }) => {
    const { errors } = await openLibrary(page, 'visitor', {}, '/video/library');
    const d = dialog(page);
    await expect(page.getByTestId('library-item')).toHaveCount(1);

    await playVideoButton(page).click();
    await expect(d).toBeVisible();
    await expect(page).toHaveURL(/\/video\/library\?video=vid-1$/);
    await page.goBack();
    await expect(d).toHaveCount(0);
    await expect(page).toHaveURL(/\/video\/library$/);
    await page.goForward();
    await expect(d.getByRole('heading', { name: NARRATED_TITLE })).toBeVisible();
    await expect(page).toHaveURL(/\/video\/library\?video=vid-1$/);

    // Escape pops the entry it pushed: one more Back leaves the library (no duplicate entry behind).
    await page.keyboard.press('Escape');
    await expect(d).toHaveCount(0);
    await expect(page).toHaveURL(/\/video\/library$/);
    await page.goBack();
    await expect(page).not.toHaveURL(/\/video\/library/);
    expect(errors).toEqual([]);
  });

  test('closing a deep-linked video replaces the URL (nothing to go back to inside the app)', async ({ page }) => {
    const { errors } = await openLibrary(page, 'visitor', {}, '/video/library?video=vid-1');
    await expect(dialog(page).getByRole('heading', { name: NARRATED_TITLE })).toBeVisible();
    await dialog(page).getByRole('button', { name: 'Close' }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(page).toHaveURL(/\/video\/library$/);
    await page.goBack();
    await expect(page).not.toHaveURL(/\/video\/library/);
    expect(errors).toEqual([]);
  });

  test('opening a video straight after closing another one does not lose it to the pending Back', async ({ page }) => {
    const { errors } = await openLibrary(page, 'visitor', { catalog: 'demo' }, '/video/library');
    await expect(page.getByTestId('library-item')).toHaveCount(3);
    const first = page.getByTestId('library-item').first().getByRole('button', { name: /^Play / });
    const second = page.getByTestId('library-item').nth(1).getByRole('button', { name: /^Play / });
    await first.click();
    await expect(dialog(page)).toBeVisible();
    await page.evaluate(() => {
      // Close and reopen inside one task: the Back of the first close has not landed when the second open starts.
      (document.querySelector('[role=dialog] .modal__close') as HTMLButtonElement).click();
    });
    await second.click({ force: true }).catch(() => undefined);
    await expect(dialog(page)).toBeVisible();
    await expect(page).toHaveURL(/\/video\/library\?video=vid-/);
    expect(errors).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Thumbnails, covers
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
test.describe('Images', () => {
  test('row thumbnails are lazy, decoded off the main thread and size-reserved: the rows do not shift when they arrive', async ({ page }) => {
    const errors = collectErrors(page);
    await mockApi(page, 'visitor', { podcastV2: true });
    await page.route('**/media/pod-2-thumb.png', async (route) => {
      await new Promise((resolve) => { setTimeout(resolve, 1500); });
      await route.fallback();
    });
    await page.goto('/podcast/library');
    const row = rowOf(page, VIDEO_TITLE);
    const img = row.locator('img.library-thumb');
    await expect(img).toHaveAttribute('loading', 'lazy');
    await expect(img).toHaveAttribute('decoding', 'async');
    await expect(img).toHaveAttribute('width', /^\d+$/);
    await expect(img).toHaveAttribute('height', /^\d+$/);
    const before = (await row.boundingBox())!;
    const beforeBox = (await img.boundingBox())!;
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0), { timeout: 20_000 }).toBe(true);
    const after = (await row.boundingBox())!;
    const afterBox = (await img.boundingBox())!;
    expect(Math.abs(after.height - before.height), 'row height before / after the image loads').toBeLessThan(1);
    expect(Math.abs(afterBox.height - beforeBox.height), 'image box before / after').toBeLessThan(1);
    expect(afterBox.height).toBeGreaterThan(20);

    await page.goto('/video/library');
    await expect(page.locator('img.library-thumb')).toHaveCount(0); // vid-1 has no thumbnail in the mock
    expect(errors).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Page header
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
test.describe('Library page headers', () => {
  for (const [path, heading] of [['/podcast/library', 'Podcasts'], ['/video/library', 'Videos']] as const) {
    test(`${heading}: no "Library" kicker above the title — the heading and the nav already say where you are`, async ({ page }) => {
      const { errors } = await openLibrary(page, 'visitor', {}, path);
      await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
      await expect(page.getByTestId('library-item').first()).toBeVisible();
      await expect(page.locator('main .eyebrow', { hasText: /^library$/i })).toHaveCount(0);
      expect(errors).toEqual([]);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Focus ring on the dark sheet (P2-3)
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
test.describe('Focus ring on the dark player (P2-3)', () => {
  for (const [name, open, close] of [
    ['the Listen sheet\'s Minimise button', async (page: Page) => { await listenButton(page, VIDEO_TITLE).click(); await expect(radio(page)).toBeVisible(); }, 'Minimise player'],
    ['the Watch dialog\'s Close button', async (page: Page) => { await watchButton(page, VIDEO_TITLE).click(); await expect(videoEl(page)).toBeVisible(); }, 'Close'],
  ] as const) {
    test(`${name} has a focus ring of at least 3:1 against the stage`, async ({ page }) => {
      const { errors } = await openLibrary(page);
      await open(page);
      const button = dialog(page).getByRole('button', { name: close });
      // Listen opens with focus on Play (the close button is behind it); Watch opens on the panel (the close button is next).
      const direction = close === 'Close' ? 'Tab' : 'Shift+Tab';
      for (let i = 0; i < 8 && !(await button.evaluate((el) => el === document.activeElement)); i += 1) await page.keyboard.press(direction);
      await expect(button).toBeFocused();
      const ring = await button.evaluate((el) => {
        const s = getComputedStyle(el);
        const panel = el.closest('[role=dialog]') as HTMLElement;
        return { color: s.outlineColor, style: s.outlineStyle, width: parseFloat(s.outlineWidth), stage: getComputedStyle(panel).backgroundColor };
      });
      expect(ring.style).toBe('solid');
      expect(ring.width).toBeGreaterThanOrEqual(2);
      expect(contrast(ring.color, ring.stage), `ring ${ring.color} on ${ring.stage}`).toBeGreaterThanOrEqual(3);
      expect(errors).toEqual([]);
    });
  }

  test('the narrated-video dialog\'s Close button too', async ({ page }) => {
    const { errors } = await openLibrary(page, 'visitor', {}, '/video/library');
    await playVideoButton(page).click();
    await expect(dialog(page)).toBeVisible();
    await page.keyboard.press('Tab');
    const button = dialog(page).getByRole('button', { name: 'Close' });
    await expect(button).toBeFocused();
    const ring = await button.evaluate((el) => ({
      color: getComputedStyle(el).outlineColor, stage: getComputedStyle(el.closest('[role=dialog]') as HTMLElement).backgroundColor,
    }));
    expect(contrast(ring.color, ring.stage), `ring ${ring.color} on ${ring.stage}`).toBeGreaterThanOrEqual(3);
    expect(errors).toEqual([]);
  });
});
