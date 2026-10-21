import { test, expect as baseExpect, type Locator, type Page } from '@playwright/test';
import {
  POD_AUDIO, POD_VIDEO, RADIO_TRANSCRIPT, mockApi, podcastLibraryItem, type MockApiOptions, type Role,
} from './support/mock-api';

/**
 * Podcast library — Watch / Listen (radio) behaviour lock.
 *
 * Every /api call is mocked (tests/support/mock-api.ts, `podcastV2`): a video +
 * radio episode, an audio-only episode and a legacy (pre-radio) item. Media are
 * real fixtures (tests/fixtures/media) served with byte ranges, so the radio
 * player and the video genuinely load, seek and play.
 */

// Playback and job polling run in real time on a busy machine: allow generous waits.
const expect = baseExpect.configure({ timeout: 15_000 });
test.describe.configure({ timeout: 90_000 });

const VIDEO_TITLE = 'Agents on air';
const AUDIO_TITLE = 'Safety minute';
const LEGACY_TITLE = 'AI agents MCP';

type Span = [number, number];
const lerp = (t: number, [a0, a1]: Span, [b0, b1]: Span) => b0 + ((t - a0) / (a1 - a0)) * (b1 - b0);
const turn = (i: number) => RADIO_TRANSCRIPT.turns[i];
const audioSpan = (i: number): Span => [turn(i).start, turn(i).end];
const videoSpan = (i: number): Span => [turn(i).video_start!, turn(i).video_end!];
/** 14 s on the radio = turn 1 (audio 9.3–19.0 ↔ video 12.5–25.0) → ≈ 18.56 s in the video. */
const AUDIO_14_IN_VIDEO = lerp(14, audioSpan(1), videoSpan(1));
/** 30 s in the video = turn 2 (video 25.5–31.5 ↔ audio 19.3–24.0) → ≈ 22.83 s on the radio. */
const VIDEO_30_IN_AUDIO = lerp(30, videoSpan(2), audioSpan(2));

async function openLibrary(page: Page, role: Role, opts: MockApiOptions = {}, path = '/podcast/library') {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const api = await mockApi(page, role, { podcastV2: true, ...opts });
  await page.goto(path);
  return { errors, api };
}

const rowOf = (page: Page, title: string) => page.getByTestId('library-item').filter({ hasText: title });
const dialog = (page: Page) => page.getByRole('dialog');
const radioAudio = (page: Page) => page.getByTestId('radio-audio');
const videoEl = (page: Page) => page.getByTestId('library-player');
const audioState = (page: Page) => radioAudio(page).evaluate((a: HTMLAudioElement) => ({
  t: a.currentTime, paused: a.paused, rate: a.playbackRate,
}));
const audioTime = async (page: Page) => (await audioState(page)).t;
const videoTime = (page: Page) => videoEl(page).evaluate((v: HTMLVideoElement) => v.currentTime);
const videoPaused = (page: Page) => videoEl(page).evaluate((v: HTMLVideoElement) => v.paused);
const mediaInDialog = (page: Page) => page.locator('[role=dialog] audio, [role=dialog] video').count();

/** Sets a media element's position and resolves once it has seeked. */
async function seekMedia(media: Locator, seconds: number) {
  await media.evaluate((el: HTMLMediaElement, to: number) => new Promise<void>((resolve) => {
    el.addEventListener('seeked', () => resolve(), { once: true });
    el.currentTime = to;
  }), seconds);
}

/** Waits until the radio audio has moved at least `by` seconds forward. */
async function expectAdvancing(page: Page, by = 0.5) {
  const from = await audioTime(page);
  await expect.poll(() => audioTime(page)).toBeGreaterThan(from + by);
}

async function openListen(page: Page, title = VIDEO_TITLE) {
  await rowOf(page, title).getByRole('button', { name: `Listen to ${title}` }).click();
  const player = dialog(page).getByTestId('radio-player');
  await expect(player).toHaveAttribute('data-state', 'playing');
  return player;
}

test.describe('Podcast library — rows', () => {
  test('visitor: Watch and Listen side by side, audio-only episodes are Listen-only', async ({ page }) => {
    const { errors } = await openLibrary(page, 'visitor');
    await expect(page.getByTestId('library-item')).toHaveCount(3);

    const video = rowOf(page, VIDEO_TITLE);
    await expect(video).toHaveAttribute('data-format', 'video');
    await expect(video.getByTestId('library-watch')).toHaveAccessibleName(`Watch ${VIDEO_TITLE}`);
    await expect(video.getByTestId('library-watch')).toHaveText('Watch');
    await expect(video.getByTestId('library-listen')).toHaveAccessibleName(`Listen to ${VIDEO_TITLE}`);
    await expect(video.getByTestId('library-listen')).toHaveText('Listen');
    await expect(video.getByTestId('audio-only-chip')).toHaveCount(0);

    const audio = rowOf(page, AUDIO_TITLE);
    await expect(audio).toHaveAttribute('data-format', 'audio');
    await expect(audio.getByTestId('audio-only-chip')).toHaveText('Audio only');
    await expect(audio.getByTestId('library-watch')).toHaveCount(0);
    await expect(audio.getByTestId('library-listen')).toHaveAccessibleName(`Listen to ${AUDIO_TITLE}`);

    const legacy = rowOf(page, LEGACY_TITLE);
    await expect(legacy).toHaveAttribute('data-format', 'video');
    await expect(legacy.getByTestId('library-watch')).toBeVisible();

    await expect(page.getByTestId('publish-toggle')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('visitor without public audio: Watch only, audio-only episodes hidden and not found', async ({ page }) => {
    const { errors } = await openLibrary(page, 'visitor', { publicAudio: false });
    await expect(page.getByTestId('library-item')).toHaveCount(2);
    await expect(rowOf(page, AUDIO_TITLE)).toHaveCount(0);
    const video = rowOf(page, VIDEO_TITLE);
    await expect(video.getByTestId('library-watch')).toBeVisible();
    await expect(video.getByTestId('library-listen')).toHaveCount(0);

    await video.getByTestId('library-watch').click();
    const d = dialog(page);
    await expect(d).toHaveAttribute('data-mode', 'watch');
    await expect(videoEl(page)).toHaveAttribute('src', POD_VIDEO.mp4_url!);
    await expect(d.getByTestId('player-format-tabs')).toHaveCount(0);
    await expect(d.getByTestId('radio-player')).toHaveCount(0);
    await expect(d.getByTestId('format-chip')).toHaveText('Video');
    await page.keyboard.press('Escape');
    await expect(d).toHaveCount(0);
    await expect(page).toHaveURL(/\/podcast\/library$/);

    // A shared link to the audio-only episode is a 404 for visitors: the alert says it is gone and offers the way back.
    await page.goto(`/podcast/library?episode=${POD_AUDIO.job_id}&mode=listen`);
    const gone = page.getByTestId('library-open-error');
    await expect(gone).toContainText("This episode isn't available any more.");
    await expect(gone).not.toContainText(/Failed to open|Library item not found/);
    await expect(gone.getByRole('button', { name: 'Back to all episodes' })).toBeVisible();
    await expect(d).toHaveCount(0);
    await expect(page).toHaveURL(/\/podcast\/library$/);
    expect(errors).toEqual([]);
  });

  test('the title opens Listen for every episode with audio, Watch only for video-only ones', async ({ page }) => {
    const { errors } = await openLibrary(page, 'visitor');
    const d = dialog(page);

    await rowOf(page, VIDEO_TITLE).getByRole('button', { name: VIDEO_TITLE, exact: true }).click();
    await expect(page).toHaveURL(/\/podcast\/library\?episode=pod-2&mode=listen$/);
    await expect(d).toHaveAttribute('data-mode', 'listen');
    await expect(radioAudio(page)).toHaveAttribute('src', POD_VIDEO.mp3_url);
    await expect(videoEl(page)).toHaveCount(0);
    await expect(d.getByRole('tablist', { name: 'Episode format' })).toBeVisible();
    await expect(d.getByRole('tab', { name: 'Listen' })).toHaveAttribute('aria-selected', 'true');
    await expect(d.getByTestId('format-chip')).toHaveText('Video + audio');
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(/\/podcast\/library$/);

    // Watch stays one tap away on the row.
    await rowOf(page, VIDEO_TITLE).getByTestId('library-watch').click();
    await expect(page).toHaveURL(/\/podcast\/library\?episode=pod-2&mode=watch$/);
    await expect(d).toHaveAttribute('data-mode', 'watch');
    await expect(videoEl(page)).toHaveAttribute('src', POD_VIDEO.mp4_url!);
    await expect(d.getByRole('tab', { name: 'Watch' })).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(/\/podcast\/library$/);

    await rowOf(page, AUDIO_TITLE).getByRole('button', { name: AUDIO_TITLE, exact: true }).click();
    await expect(page).toHaveURL(/\/podcast\/library\?episode=pod-3&mode=listen$/);
    await expect(d).toHaveAttribute('data-mode', 'listen');
    await expect(radioAudio(page)).toHaveAttribute('src', POD_AUDIO.mp3_url);
    await expect(d.getByRole('tablist')).toHaveCount(0);
    await expect(videoEl(page)).toHaveCount(0);
    await expect(d.getByTestId('format-chip')).toHaveText('Audio only');
    await expect(d.getByTestId('radio-player')).toHaveAttribute('data-state', 'playing');
    await expectAdvancing(page, 0.3);
    expect(errors).toEqual([]);
  });
});

test.describe('Podcast library — Listen (radio player)', () => {
  test('plays: time advances, captions and hosts follow the transcript', async ({ page }) => {
    const { errors } = await openLibrary(page, 'visitor');
    const player = await openListen(page);
    await expect(radioAudio(page)).toHaveAttribute('src', POD_VIDEO.mp3_url);
    await expectAdvancing(page);
    await expect(player.getByTestId('radio-time')).toHaveText(/^0:0\d \/ 0:30$/);
    await expect(player.getByTestId('radio-ai-note')).toHaveText('AI-generated voices');

    const caption = player.getByTestId('radio-caption');
    const interviewer = player.getByTestId('radio-host-interviewer');
    const expert = player.getByTestId('radio-host-expert');
    const slider = player.getByRole('slider', { name: 'Seek' });
    await expect(interviewer).toContainText('Sofia');
    await expect(expert).toContainText('Lucas');

    // Record every backchannel glow with the radio time it lit up at.
    await page.evaluate(() => {
      const w = window as unknown as { __reactions: { role: string; t: number }[] };
      w.__reactions = [];
      for (const role of ['interviewer', 'expert']) {
        const host = document.querySelector(`[data-testid=radio-host-${role}]`)!;
        new MutationObserver(() => {
          if (host.getAttribute('data-reacting') !== 'true') return;
          const a = document.querySelector('[data-testid=radio-audio]') as HTMLAudioElement;
          w.__reactions.push({ role, t: a.currentTime });
        }).observe(host, { attributes: true, attributeFilter: ['data-reacting'] });
      }
    });

    // Paused, the slider seeks exactly: Home → 0 s, → +5 s, → +5 s.
    await player.getByTestId('radio-play').click();
    await expect(player).toHaveAttribute('data-state', 'paused');
    await slider.focus();
    await page.keyboard.press('Home');
    await expect(slider).toHaveAttribute('aria-valuenow', '0');
    await expect(player.getByTestId('radio-time')).toHaveText('0:00 / 0:30');
    await expect(caption).toHaveText('');
    await page.keyboard.press('ArrowRight');
    await expect(slider).toHaveAttribute('aria-valuenow', '5');
    await expect(caption).toHaveText('Sofia: Today we talk about agents.');
    await expect(interviewer).toHaveAttribute('data-speaking', 'false'); // lit only while playing
    await page.keyboard.press('ArrowRight');
    await expect(slider).toHaveAttribute('aria-valuenow', '10');
    await expect(caption).toHaveText('Lucas: Agents plan, act and check their work.');
    expect((await audioState(page)).t).toBeCloseTo(10, 1);

    // K resumes at 10 s: the expert's turn lights the expert.
    await page.keyboard.press('k');
    await expect(player).toHaveAttribute('data-state', 'playing');
    await expect(expert).toHaveAttribute('data-speaking', 'true');
    await expect(interviewer).toHaveAttribute('data-speaking', 'false');
    await expect(player.getByTestId('radio-speaker')).toHaveText('Lucas is speaking');

    // The interviewer's "Mm-hmm." (13.0–13.6 s) glows on the listening host, then the caption moves on.
    await expect.poll(() => page.evaluate(() => (window as any).__reactions as { role: string; t: number }[]))
      .toEqual([{ role: 'interviewer', t: baseExpect.any(Number) }]);
    const [glow] = await page.evaluate(() => (window as any).__reactions as { role: string; t: number }[]);
    expect(glow.t).toBeGreaterThanOrEqual(12.9);
    expect(glow.t).toBeLessThan(14);
    await expect(caption).toHaveText('Lucas: That loop is what makes them useful.');
    await expect(interviewer).toHaveAttribute('data-reacting', 'false');
    await expect(expert).toHaveAttribute('data-reacting', 'false');
    await expect(expert).toHaveAttribute('data-speaking', 'true');

    // Pointer seek on the waveform: 20.5 s = turn 2, the interviewer speaks again.
    await slider.scrollIntoViewIfNeeded();
    const box = (await slider.boundingBox())!;
    await page.mouse.click(box.x + box.width * (20.5 / 30), box.y + box.height / 2);
    await expect(caption).toHaveText('Sofia: So where should a team start?');
    await expect(interviewer).toHaveAttribute('data-speaking', 'true');
    await expect(expert).toHaveAttribute('data-speaking', 'false');
    await expect(player.getByTestId('radio-time')).toHaveText(/^0:2\d \/ 0:30$/);
    const t = await audioTime(page);
    expect(t).toBeGreaterThan(20);
    expect(t).toBeLessThan(24);
    expect(errors).toEqual([]);
  });

  test('transcript lists speech and reactions; clicking a cue seeks there', async ({ page }) => {
    const { errors } = await openLibrary(page, 'visitor');
    const player = await openListen(page);
    const toggle = player.getByTestId('radio-transcript-toggle');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(player.getByTestId('radio-transcript')).toBeHidden();
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const cues = player.getByTestId('radio-cue');
    await expect(cues).toHaveCount(RADIO_TRANSCRIPT.cues.length);
    await expect(player.locator('[data-testid=radio-cue][data-kind=speech]')).toHaveCount(6);
    const reaction = player.locator('[data-testid=radio-cue][data-kind=reaction]');
    await expect(reaction).toHaveCount(1);
    await expect(reaction).toContainText('Sofia · Mm-hmm. (reaction)');

    const last = cues.filter({ hasText: 'Start small, measure, then scale.' });
    await last.click();
    await expect.poll(() => audioTime(page)).toBeGreaterThanOrEqual(24.3);
    await expect(player.getByTestId('radio-caption')).toHaveText('Lucas: Start small, measure, then scale.');
    await expect(last).toHaveAttribute('aria-current', 'true');
    await expect(player).toHaveAttribute('data-state', 'playing');
    expect(errors).toEqual([]);
  });

  test('the chosen speed persists across Watch / Listen and episodes', async ({ page }) => {
    const { errors } = await openLibrary(page, 'visitor');
    const player = await openListen(page);
    const speed = player.getByTestId('radio-speed');
    await expect(speed).toHaveValue('1');
    await speed.selectOption('1.5');
    await expect.poll(async () => (await audioState(page)).rate).toBe(1.5);

    const d = dialog(page);
    await d.getByRole('tab', { name: 'Watch' }).click();
    // The app's radio stays loaded (paused, parked outside the dialog) while Watch plays.
    await expect(d.getByTestId('radio-audio')).toHaveCount(0);
    expect((await audioState(page)).paused).toBe(true);
    await d.getByRole('tab', { name: 'Listen' }).click();
    await expect(d.getByTestId('radio-speed')).toHaveValue('1.5');
    await expect.poll(async () => (await audioState(page)).rate).toBe(1.5);

    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(/\/podcast\/library$/);
    await openListen(page, AUDIO_TITLE);
    await expect(d.getByTestId('radio-speed')).toHaveValue('1.5');
    await expect.poll(async () => (await audioState(page)).rate).toBe(1.5);
    expect(errors).toEqual([]);
  });

  test('Watch ↔ Listen keeps one medium and maps the position turn by turn', async ({ page }) => {
    const { errors } = await openLibrary(page, 'visitor');
    await openListen(page);
    const d = dialog(page);
    await expect(d).toHaveAttribute('data-mode', 'listen');
    expect(await mediaInDialog(page)).toBe(1);
    const historyLength = await page.evaluate(() => history.length);

    // Playing carries over: the video starts, the radio pauses outside the dialog.
    await d.getByRole('tab', { name: 'Watch' }).click();
    await expect(d).toHaveAttribute('data-mode', 'watch');
    await expect(page).toHaveURL(/\?episode=pod-2&mode=watch$/);
    await expect(videoEl(page)).toHaveAttribute('src', POD_VIDEO.mp4_url!);
    await expect(d.getByTestId('radio-audio')).toHaveCount(0);
    expect((await audioState(page)).paused).toBe(true);
    await expect.poll(() => videoPaused(page)).toBe(false);
    expect(await mediaInDialog(page)).toBe(1);

    await d.getByRole('tab', { name: 'Listen' }).click();
    await expect(d).toHaveAttribute('data-mode', 'listen');
    await expect(page).toHaveURL(/\?episode=pod-2&mode=listen$/);
    await expect(videoEl(page)).toHaveCount(0);
    await expect(d.getByTestId('radio-player')).toHaveAttribute('data-state', 'playing');
    expect(await mediaInDialog(page)).toBe(1);
    // Tab switches replace the deep link instead of stacking history entries.
    expect(await page.evaluate(() => history.length)).toBe(historyLength);

    // Paused at 14.0 s on the radio → the video opens paused at the same point of turn 1.
    await d.getByTestId('radio-player').getByTestId('radio-play').click();
    await expect(d.getByTestId('radio-player')).toHaveAttribute('data-state', 'paused');
    await seekMedia(radioAudio(page), 14);
    await d.getByRole('tab', { name: 'Watch' }).click();
    await expect.poll(async () => Math.abs((await videoTime(page)) - AUDIO_14_IN_VIDEO)).toBeLessThanOrEqual(0.3);
    expect(await videoPaused(page)).toBe(true);
    expect(await mediaInDialog(page)).toBe(1);

    // 30 s in the video (turn 2) → ≈ 22.8 s on the radio, still paused.
    await seekMedia(videoEl(page), 30);
    await d.getByRole('tab', { name: 'Listen' }).click();
    await expect.poll(async () => Math.abs((await audioTime(page)) - VIDEO_30_IN_AUDIO)).toBeLessThanOrEqual(0.3);
    expect((await audioState(page)).paused).toBe(true);
    await expect(d.getByTestId('radio-player')).toHaveAttribute('data-state', 'paused');
    await expect(d.getByTestId('radio-caption')).toHaveText('Sofia: So where should a team start?');
    expect(await mediaInDialog(page)).toBe(1);
    expect(errors).toEqual([]);
  });
});

test.describe('Podcast library — deep links & loading', () => {
  test('a pushed episode URL: Back closes the player, Forward reopens it', async ({ page }) => {
    const { errors } = await openLibrary(page, 'visitor');
    await expect(page.getByTestId('library-item')).toHaveCount(3);
    const d = dialog(page);

    await rowOf(page, VIDEO_TITLE).getByTestId('library-listen').click();
    await expect(page).toHaveURL(/\/podcast\/library\?episode=pod-2&mode=listen$/);
    await expect(d).toHaveAttribute('data-mode', 'listen');
    await d.getByRole('tab', { name: 'Watch' }).click();
    await expect(page).toHaveURL(/\?episode=pod-2&mode=watch$/);

    await page.goBack();
    await expect(d).toHaveCount(0);
    await expect(page).toHaveURL(/\/podcast\/library$/);
    await page.goForward();
    await expect(page).toHaveURL(/\?episode=pod-2&mode=watch$/);
    await expect(d).toHaveAttribute('data-mode', 'watch');
    await expect(videoEl(page)).toHaveAttribute('src', POD_VIDEO.mp4_url!);

    await page.keyboard.press('Escape');
    await expect(d).toHaveCount(0);
    await expect(page).toHaveURL(/\/podcast\/library$/);
    await page.goForward();
    await expect(d).toHaveAttribute('data-mode', 'watch');
    await page.goBack();
    await expect(d).toHaveCount(0);
    await expect(page).toHaveURL(/\/podcast\/library$/);
    expect(errors).toEqual([]);
  });

  test('a shared link opens straight into the requested mode; closing drops the parameters', async ({ page }) => {
    const { errors } = await openLibrary(page, 'visitor', {}, '/podcast/library?episode=pod-2&mode=listen');
    const d = dialog(page);
    await expect(d).toHaveAttribute('data-mode', 'listen');
    await expect(d.getByRole('tab', { name: 'Listen' })).toHaveAttribute('aria-selected', 'true');
    await expect(radioAudio(page)).toHaveAttribute('src', POD_VIDEO.mp3_url);
    await expect(d.getByTestId('radio-player')).toHaveAttribute('data-state', /^(playing|press-play)$/);
    // Listen minimises (the audio carries on in the mini-player) instead of closing.
    await d.getByRole('button', { name: 'Minimise player' }).click();
    await expect(d).toHaveCount(0);
    await expect(page).toHaveURL(/\/podcast\/library$/);
    await expect(page.getByTestId('library-item')).toHaveCount(3);
    expect(errors).toEqual([]);
  });

  test('home episode rows deep-link into Listen (Watch only without audio)', async ({ page }) => {
    const { errors } = await openLibrary(page, 'visitor', {}, '/');
    const listenLink = page.locator(`a[href="/podcast/library?episode=${POD_AUDIO.job_id}&mode=listen"]`).first();
    await expect(page.locator(`a[href="/podcast/library?episode=${POD_VIDEO.job_id}&mode=listen"]`).first()).toBeVisible();
    await expect(page.locator(`a[href="/podcast/library?episode=${POD_VIDEO.job_id}&mode=watch"]`)).toHaveCount(0);
    await listenLink.click();
    await expect(page).toHaveURL(/\/podcast\/library\?episode=pod-3&mode=listen$/);
    await expect(dialog(page)).toHaveAttribute('data-mode', 'listen');
    await expect(radioAudio(page)).toHaveAttribute('src', POD_AUDIO.mp3_url);
    expect(errors).toEqual([]);
  });

  test('the mode falls back to a rendition the episode has', async ({ page }) => {
    const { errors } = await openLibrary(page, 'visitor', {}, '/podcast/library?episode=pod-3&mode=watch');
    const d = dialog(page);
    await expect(d).toHaveAttribute('data-mode', 'listen');
    await expect(page).toHaveURL(/\?episode=pod-3&mode=listen$/);
    await expect(d.getByRole('tablist')).toHaveCount(0);
    await expect(radioAudio(page)).toHaveAttribute('src', POD_AUDIO.mp3_url);

    // Legacy item: video only.
    await page.goto('/podcast/library?episode=pod-1&mode=listen');
    await expect(d).toHaveAttribute('data-mode', 'watch');
    await expect(page).toHaveURL(/\?episode=pod-1&mode=watch$/);
    await expect(videoEl(page)).toHaveAttribute('src', '/media/pod-1.mp4');
    await expect(radioAudio(page)).toHaveCount(0);

    // No (or an unknown) mode: Listen when the episode has audio.
    for (const query of ['episode=pod-2', 'episode=pod-2&mode=sideways']) {
      await page.goto(`/podcast/library?${query}`);
      await expect(d).toHaveAttribute('data-mode', 'listen');
      await expect(page).toHaveURL(/\?episode=pod-2&mode=listen$/);
      await expect(radioAudio(page)).toHaveAttribute('src', POD_VIDEO.mp3_url);
    }
    expect(errors).toEqual([]);
  });

  test('an unknown episode shows an error and clears the deep link', async ({ page }) => {
    const { errors } = await openLibrary(page, 'visitor', {}, '/podcast/library?episode=pod-404&mode=listen');
    const error = page.getByTestId('library-open-error');
    await expect(error).toContainText("This episode isn't available any more.");
    await expect(error).not.toContainText(/Failed to open|Library item not found/);
    await expect(error.getByRole('button', { name: 'Back to all episodes' })).toBeVisible();
    await expect(dialog(page)).toHaveCount(0);
    await expect(page).toHaveURL(/\/podcast\/library$/);
    await expect(page.getByTestId('library-item')).toHaveCount(3);

    // The next successful open clears the error.
    await rowOf(page, VIDEO_TITLE).getByTestId('library-watch').click();
    await expect(dialog(page)).toHaveAttribute('data-mode', 'watch');
    await expect(error).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('a late episode response is ignored once the player moved on', async ({ page }) => {
    // Hold the episode's details from the start: the library prefetches them on load (one-tap Listen).
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await mockApi(page, 'visitor', { podcastV2: true });
    const detailPath = `/api/podcast/library/${POD_VIDEO.job_id}`;
    const held: (() => void)[] = [];
    await page.route((url) => url.pathname === detailPath, async (route) => {
      await new Promise<void>((resolve) => held.push(resolve));
      await route.fallback();
    });
    await page.goto('/podcast/library');
    await expect(page.getByTestId('library-item')).toHaveCount(3);
    const lateResponse = () => page.waitForResponse((r) => new URL(r.url()).pathname === detailPath);
    const d = dialog(page);

    // Open (held: the open joins the in-flight prefetch) → close → open another episode → the late response lands.
    await rowOf(page, VIDEO_TITLE).getByTestId('library-listen').click();
    await expect(page.getByRole('dialog', { name: 'Loading podcast' })).toBeVisible();
    await expect.poll(() => held.length).toBe(1);
    await page.keyboard.press('Escape');
    await expect(d).toHaveCount(0);
    await rowOf(page, AUDIO_TITLE).getByTestId('library-listen').click();
    await expect(page.getByRole('dialog', { name: AUDIO_TITLE })).toBeVisible();
    await expect(page).toHaveURL(/\?episode=pod-3&mode=listen$/);
    let late = lateResponse();
    held.shift()!();
    await (await late).finished();
    await page.waitForTimeout(300); // give a stale handler the chance to (wrongly) apply it
    await expect(page.getByRole('dialog', { name: AUDIO_TITLE })).toBeVisible();
    await expect(radioAudio(page)).toHaveAttribute('src', POD_AUDIO.mp3_url);
    await expect(page).toHaveURL(/\?episode=pod-3&mode=listen$/);
    // History stayed linear: one Back closes it.
    await page.goBack();
    await expect(d).toHaveCount(0);
    await expect(page).toHaveURL(/\/podcast\/library$/);

    // Back while loading: the late response does not reopen the player.
    await rowOf(page, VIDEO_TITLE).getByTestId('library-watch').click();
    await expect(page).toHaveURL(/\?episode=pod-2&mode=watch$/);
    await expect.poll(() => held.length).toBe(1);
    await page.goBack();
    await expect(d).toHaveCount(0);
    await expect(page).toHaveURL(/\/podcast\/library$/);
    late = lateResponse();
    held.shift()!();
    await (await late).finished();
    await page.waitForTimeout(300);
    await expect(d).toHaveCount(0);
    await expect(page).toHaveURL(/\/podcast\/library$/);
    expect(errors).toEqual([]);
  });

  test('an expired audio URL is re-fetched from the episode and playback resumes', async ({ page }) => {
    // Routes first: the library prefetches the episode (the expired link) as soon as it lists it.
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await mockApi(page, 'visitor', { podcastV2: true });
    let detailCalls = 0;
    const rejected: string[] = [];
    await page.route((url) => url.pathname === `/api/podcast/library/${POD_VIDEO.job_id}`, (route) => {
      detailCalls += 1;
      const item = podcastLibraryItem(POD_VIDEO.job_id, 'visitor', { podcastV2: true })!;
      const signed = `${item.audio_url}?sig=${detailCalls === 1 ? 'expired' : 'fresh'}`;
      return route.fulfill({ json: { ...item, audio_url: signed, mp3_url: signed } });
    });
    await page.route((url) => url.pathname === POD_VIDEO.mp3_url && url.searchParams.get('sig') === 'expired', (route) => {
      rejected.push(route.request().url());
      return route.fulfill({ status: 403, contentType: 'application/xml', body: '<Error><Code>AuthenticationFailed</Code></Error>' });
    });
    await page.goto('/podcast/library');
    await expect(page.getByTestId('library-item')).toHaveCount(3);
    await expect.poll(() => detailCalls).toBe(1);

    await rowOf(page, VIDEO_TITLE).getByTestId('library-listen').click();
    const player = dialog(page).getByTestId('radio-player');
    await expect(radioAudio(page)).toHaveAttribute('src', `${POD_VIDEO.mp3_url}?sig=fresh`);
    await expect(player).toHaveAttribute('data-state', 'playing');
    await expectAdvancing(page);
    expect(rejected.length).toBeGreaterThanOrEqual(1);
    expect(detailCalls).toBe(2);
    await expect(player.getByTestId('radio-error')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});

test.describe('Podcast library — downloads, motion, layout, focus', () => {
  test('admins get every rendition to download, in both modes', async ({ page }) => {
    const { errors } = await openLibrary(page, 'admin');
    await expect(page.getByTestId('library-item')).toHaveCount(3);
    const video = rowOf(page, VIDEO_TITLE);
    await expect(video.getByTestId('publish-toggle')).toBeVisible();
    await expect(video.getByRole('button', { name: `Delete ${VIDEO_TITLE}` })).toBeVisible();

    await video.getByTestId('library-watch').click();
    const d = dialog(page);
    const all: [string, string | null][] = [
      ['download-mp4', POD_VIDEO.mp4_url], ['download-mp3', POD_VIDEO.mp3_url], ['download-srt', POD_VIDEO.srt_url],
      ['download-audio-srt', POD_VIDEO.audio_srt_url], ['download-scorm', POD_VIDEO.scorm_url],
    ];
    for (const [id, href] of all) await expect(d.getByTestId(id)).toHaveAttribute('href', href!);
    await d.getByRole('tab', { name: 'Listen' }).click();
    await expect(d.getByTestId('radio-player')).toBeVisible();
    for (const [id] of all) await expect(d.getByTestId(id)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(/\/podcast\/library$/);

    await rowOf(page, AUDIO_TITLE).getByTestId('library-listen').click();
    await expect(d.getByTestId('download-mp3')).toHaveAttribute('href', POD_AUDIO.mp3_url);
    await expect(d.getByTestId('download-audio-srt')).toHaveAttribute('href', POD_AUDIO.audio_srt_url);
    await expect(d.getByTestId('download-scorm')).toHaveAttribute('href', POD_AUDIO.scorm_url);
    await expect(d.getByTestId('download-mp4')).toHaveCount(0);
    await expect(d.getByTestId('download-srt')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('visitors only get the MP4 download, in Watch mode', async ({ page }) => {
    const { errors } = await openLibrary(page, 'visitor');
    await rowOf(page, VIDEO_TITLE).getByTestId('library-watch').click();
    const d = dialog(page);
    const downloads = d.getByTestId('library-downloads');
    await expect(d.getByTestId('download-mp4')).toHaveAttribute('href', POD_VIDEO.mp4_url!);
    await expect(downloads.getByRole('link')).toHaveCount(1);
    await d.getByRole('tab', { name: 'Listen' }).click();
    await expect(d.getByTestId('radio-player')).toBeVisible();
    await expect(downloads).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(/\/podcast\/library$/);

    await openListen(page, AUDIO_TITLE);
    await expect(downloads).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('reduced motion stills the animations while playback carries on', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const { errors } = await openLibrary(page, 'visitor');
    const player = await openListen(page);
    const bars = player.locator('.radio-player__onair .waveform');
    const pill = player.locator('.radio-player__onair .live-pill');
    const barAnimation = () => bars.locator('span').first().evaluate((el) => getComputedStyle(el).animationName);
    const pillAnimation = () => pill.evaluate((el) => getComputedStyle(el, '::before').animationName);

    await expect(bars).toHaveClass(/waveform--idle/);
    expect(await barAnimation()).toBe('none');
    expect(await pillAnimation()).toBe('none');
    await expectAdvancing(page);
    await expect(player).toHaveAttribute('data-state', 'playing');
    await expect(player.getByTestId('radio-host-interviewer')).toHaveAttribute('data-speaking', 'true');
    await expect(player.getByTestId('radio-caption')).not.toHaveText('');

    // The same player animates again once the preference is lifted.
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await expect(bars).not.toHaveClass(/waveform--idle/);
    await expect.poll(barAnimation).toBe('ozradio-wave');
    await expect.poll(pillAnimation).toBe('ozradio-pulse');
    await expectAdvancing(page);
    expect(errors).toEqual([]);
  });

  test('390 px: Watch and Listen stay visible side by side and the player fits', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const { errors } = await openLibrary(page, 'visitor');
    const video = rowOf(page, VIDEO_TITLE);
    const watch = video.getByTestId('library-watch');
    const listen = video.getByTestId('library-listen');
    await expect(watch).toBeVisible();
    await expect(listen).toBeVisible();
    const w = (await watch.boundingBox())!;
    const l = (await listen.boundingBox())!;
    expect(l.x).toBeGreaterThanOrEqual(0);
    expect(l.x + l.width).toBeLessThanOrEqual(w.x + 0.5); // Listen leads, Watch follows
    expect(w.x + w.width).toBeLessThanOrEqual(390);
    expect(Math.abs(w.y - l.y)).toBeLessThan(1);
    await expect(rowOf(page, AUDIO_TITLE).getByTestId('library-listen')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

    await listen.click();
    const d = dialog(page);
    await expect(d.getByTestId('radio-player')).toHaveAttribute('data-state', 'playing');
    for (const id of ['radio-play', 'radio-back', 'radio-forward', 'radio-speed', 'radio-waveform']) {
      const box = (await d.getByTestId(id).boundingBox())!;
      expect(box.x, id).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, id).toBeLessThanOrEqual(390);
    }
    for (const name of ['Watch', 'Listen']) await expect(d.getByRole('tab', { name })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('the player dialog traps focus across the format tabs and restores it', async ({ page }) => {
    const { errors } = await openLibrary(page, 'visitor');
    const trigger = rowOf(page, VIDEO_TITLE).getByTestId('library-listen');
    await trigger.click();
    const d = dialog(page);
    await expect(d.getByTestId('radio-player')).toBeVisible();
    const inDialog = () => page.evaluate(() => !!document.activeElement?.closest('[role=dialog]'));
    const onTab = () => page.evaluate(() => document.activeElement?.getAttribute('role') === 'tab');
    expect(await inDialog()).toBe(true);
    let reachedTab = false;
    for (let i = 0; i < 16; i++) {
      await page.keyboard.press('Tab');
      expect(await inDialog()).toBe(true);
      reachedTab ||= await onTab();
    }
    expect(reachedTab).toBe(true);
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Shift+Tab');
      expect(await inDialog()).toBe(true);
    }

    // Arrow keys on the tablist switch the format and keep focus there.
    await d.getByRole('tab', { name: 'Listen' }).focus();
    await page.keyboard.press('ArrowLeft');
    await expect(d.getByRole('tab', { name: 'Watch' })).toBeFocused();
    await expect(d).toHaveAttribute('data-mode', 'watch');
    expect(await inDialog()).toBe(true);

    await page.keyboard.press('Escape');
    await expect(d).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expect(errors).toEqual([]);
  });
});
