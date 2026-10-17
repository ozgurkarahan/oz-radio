import { test, expect as baseExpect, type Page } from '@playwright/test';
import {
  MEDIA, PODCAST_VOICES, STUDIO_SCRIPT_ID, STUDIO_TURNS, mockApi, type MockApiOptions,
} from './support/mock-api';

/**
 * Podcast studio (admin) — format choice, render request, format-aware stages
 * and the Watch / Listen result. Every /api call is mocked: the render job only
 * moves on when the test calls `advanceJobs()` (or once per poll), the job's MP3
 * / MP4 are real fixtures served with byte ranges.
 */

// The studio polls the job every 2.5 s: allow a few polls per step on a busy machine.
const expect = baseExpect.configure({ timeout: 15_000 });
test.describe.configure({ timeout: 90_000 });

const SOURCE = { name: 'agents.md', mimeType: 'text/markdown', buffer: Buffer.from('# Agents\n\nAgents plan, act and check their work.') };
const [AVA, ANDREW] = PODCAST_VOICES;
const FILE_RE = (kind: string) => new RegExp(`^/api/podcast/jobs/job-\\d+/file/${kind}$`);

/** Admin studio up to "Review & cast" with the streamed script. */
async function openReview(page: Page, opts: MockApiOptions = {}) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const api = await mockApi(page, 'admin', { jobAdvance: 'manual', ...opts });
  await page.goto('/podcast');
  await page.locator('input[type=file]').setInputFiles(SOURCE);
  const generate = page.getByRole('button', { name: /generate podcast script/i });
  await expect(generate).toBeEnabled();
  await generate.click();
  await expect(page.getByTestId('render-podcast')).toBeVisible();
  return { errors, api };
}

const stage = (page: Page, key: string) => page.locator(`[data-testid=render-stage][data-stage=${key}]`);
const host = (page: Page, role: 'Interviewer' | 'Expert') => page.getByRole('article', { name: role });

test.describe('Podcast studio — format', () => {
  test('format picker is a radio group driven by the arrow keys', async ({ page }) => {
    const { errors } = await openReview(page);
    const group = page.getByRole('radiogroup', { name: 'Podcast format' });
    const video = group.getByRole('radio', { name: 'Video + audio' });
    const audio = group.getByRole('radio', { name: 'Audio only' });
    await expect(video).toHaveAttribute('data-testid', 'format-video');
    await expect(audio).toHaveAttribute('data-testid', 'format-audio');
    await expect(video).toBeChecked();
    await expect(audio).not.toBeChecked();
    await expect(video).toHaveAttribute('tabindex', '0');
    await expect(audio).toHaveAttribute('tabindex', '-1');

    await video.focus();
    await page.keyboard.press('ArrowRight');
    await expect(audio).toBeChecked();
    await expect(audio).toBeFocused();
    await expect(audio).toHaveAttribute('tabindex', '0');
    await expect(video).toHaveAttribute('tabindex', '-1');
    await page.keyboard.press('ArrowDown'); // wraps around
    await expect(video).toBeChecked();
    await expect(video).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(audio).toBeChecked();
    await page.keyboard.press('Home');
    await expect(video).toBeChecked();
    await expect(video).toBeFocused();
    await page.keyboard.press('End');
    await expect(audio).toBeChecked();
    await expect(audio).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(video).toBeChecked();
    expect(errors).toEqual([]);
  });

  test('audio only: optional portraits, request body, audio stages and a radio-only result', async ({ page }) => {
    const { errors, api } = await openReview(page);
    const interviewer = host(page, 'Interviewer');
    const expert = host(page, 'Expert');
    await expect(interviewer.getByLabel('Avatar')).toHaveValue('photo_female');
    await expect(expert.getByLabel('Avatar')).toHaveValue('photo_male');

    await page.getByTestId('format-audio').click();
    await expect(page.getByTestId('format-audio')).toBeChecked();
    // The avatar becomes an optional portrait; names and voices stay.
    await expect(interviewer.getByLabel('Avatar')).toHaveCount(0);
    const portrait = expert.getByLabel('Portrait (optional)');
    await expect(portrait).toHaveValue('photo_male');
    await expect(portrait.locator('option').first()).toHaveText('No portrait');
    await portrait.selectOption('');
    await expect(portrait).toHaveValue('');
    await expect(expert).toContainText('No portrait');
    await expect(expert.getByLabel('Display name')).toHaveValue('Lucas');
    await expect(expert.getByLabel('Voice')).toHaveValue(ANDREW.id);
    await expect(interviewer.getByLabel('Portrait (optional)')).toHaveValue('photo_female');

    // The planned backchannel shows on the turn, voiced by the listening host.
    const chip = page.getByTestId('turn-reaction');
    await expect(chip).toHaveCount(1);
    await expect(chip).toContainText('Sofia · Mm-hmm');
    await expect(chip).toContainText('(reaction)');

    await expect(page.getByTestId('option-intro')).toBeChecked();
    await expect(page.getByTestId('option-reactions')).toBeChecked();
    await expect(page.getByTestId('option-music')).toBeChecked();
    await page.getByTestId('option-music').uncheck();
    await expect(page.getByTestId('render-podcast')).toBeEnabled();
    await page.getByTestId('render-podcast').click();
    await expect.poll(() => api.renders.length).toBe(1);
    expect(api.renders[0]).toMatchObject({
      script_id: STUDIO_SCRIPT_ID, format: 'audio', reactions: true, intro: true, music: false,
    });
    expect(api.renders[0].roles.interviewer).toMatchObject({ display_name: 'Sofia', avatar: 'photo_female', voice: AVA.id });
    expect(api.renders[0].roles.expert).toMatchObject({ display_name: 'Lucas', avatar: '', voice: ANDREW.id });

    // Audio stages: queued → synthesizing → mixing → ready.
    await expect(page.getByTestId('render-view')).toHaveAttribute('data-format', 'audio');
    await expect(page.getByTestId('render-stage')).toHaveText([/Queued/, /Synthesizing voices/, /Mixing audio/, /Ready/]);
    await expect(stage(page, 'queued')).toHaveAttribute('data-status', 'active');
    await expect(page.getByTestId('render-hint')).toContainText('about a minute');
    api.advanceJobs();
    await expect(stage(page, 'synthesizing')).toHaveAttribute('data-status', 'active');
    await expect(stage(page, 'queued')).toHaveAttribute('data-status', 'done');
    await expect(page.getByTestId('render-progress')).toContainText('Voices synthesized');
    await expect(page.getByTestId('render-progress')).toContainText('2 / 4');
    api.advanceJobs();
    await expect(stage(page, 'mixing')).toHaveAttribute('data-status', 'active');
    await expect(stage(page, 'synthesizing')).toHaveAttribute('data-status', 'done');
    await expect(stage(page, 'done')).toHaveAttribute('data-status', 'pending');
    await expect(page.getByTestId('render-stage-sub')).toHaveCount(0);
    api.advanceJobs();

    // Result: the radio player only — no Watch tab, no "Video unavailable".
    const result = page.getByTestId('result-view');
    await expect(result).toHaveAttribute('data-format', 'audio');
    await expect(result).toContainText('Audio only · Ready');
    await expect(page.getByRole('tab')).toHaveCount(0);
    await expect(page.getByTestId('result-watch')).toHaveCount(0);
    await expect(page.getByTestId('result-video')).toHaveCount(0);
    await expect(page.getByText(/Video unavailable/)).toHaveCount(0);
    const player = page.getByTestId('result-listen').getByTestId('radio-player');
    await expect(player).toBeVisible();
    await expect(player.getByTestId('radio-audio')).toHaveAttribute('src', FILE_RE('mp3'));
    await expect(player).toHaveAttribute('data-state', 'playing');
    await expect(player.getByTestId('radio-time')).toHaveText(/\/ 0:30$/);
    await expect(player.getByTestId('radio-host-interviewer')).toHaveAttribute('data-speaking', 'true');
    await expect(player.getByTestId('radio-caption')).toHaveText(/^Sofia: /);
    await expect(player.getByTestId('radio-host-expert')).toContainText('Lucas');
    await expect(player.getByTestId('radio-host-expert').locator('[data-avatar-status]')).toHaveAttribute('data-avatar-status', 'none');

    for (const id of ['mp3', 'audio-srt', 'scorm']) await expect(page.getByTestId(`download-${id}`)).toBeVisible();
    await expect(page.getByTestId('download-mp3')).toHaveAttribute('href', FILE_RE('mp3'));
    await expect(page.getByTestId('download-scorm')).toHaveAttribute('href', FILE_RE('scorm'));
    await expect(page.getByTestId('download-mp4')).toHaveCount(0);
    await expect(page.getByTestId('download-srt')).toHaveCount(0);
    await expect(page.getByTestId('result-warnings')).toHaveCount(0);
    // The result transcript keeps the reaction chip.
    await expect(page.getByTestId('turn-reaction')).toContainText('Sofia · Mm-hmm');
    await expect(page.getByTestId('result-library')).toHaveAttribute('href', '/podcast/library');
    await expect(page.getByTestId('result-create-another')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('video + audio: stages include the radio mix; the result has Watch and Listen tabs', async ({ page }) => {
    const { errors, api } = await openReview(page);
    await expect(page.getByTestId('format-video')).toBeChecked();
    await page.getByTestId('render-podcast').click();
    await expect.poll(() => api.renders.length).toBe(1);
    expect(api.renders[0]).toMatchObject({ format: 'video', reactions: true, intro: true, music: true });
    expect(api.renders[0].roles.expert).toMatchObject({ display_name: 'Lucas', avatar: 'photo_male' });

    await expect(page.getByTestId('render-view')).toHaveAttribute('data-format', 'video');
    await expect(page.getByTestId('render-stage')).toHaveText([/Queued/, /Rendering avatars/, /Composing video/, /Ready/]);
    await expect(page.getByTestId('render-hint')).toContainText('several minutes');
    api.advanceJobs();
    await expect(stage(page, 'rendering')).toHaveAttribute('data-status', 'active');
    await expect(page.getByTestId('render-progress')).toContainText('Avatar clips rendered');
    await expect(page.getByTestId('render-progress')).toContainText('1 / 4');
    api.advanceJobs();
    await expect(stage(page, 'composing')).toHaveAttribute('data-status', 'active');
    await expect(stage(page, 'rendering')).toHaveAttribute('data-status', 'done');
    await expect(page.getByTestId('render-stage-sub')).toHaveCount(0);
    api.advanceJobs();
    await expect(page.getByTestId('render-stage-sub')).toHaveText('and the radio mix');
    await expect(stage(page, 'composing')).toHaveAttribute('data-status', 'active');
    await expect(stage(page, 'composing').getByTestId('render-stage-sub')).toHaveCount(1);
    api.advanceJobs();

    // Result: Watch | Listen, one medium at a time.
    await expect(page.getByTestId('result-view')).toHaveAttribute('data-format', 'video');
    await expect(page.getByRole('tablist', { name: 'Podcast player' })).toBeVisible();
    const watchTab = page.getByRole('tab', { name: 'Watch' });
    const listenTab = page.getByRole('tab', { name: 'Listen' });
    await expect(watchTab).toHaveAttribute('aria-selected', 'true');
    const video = page.getByTestId('result-video');
    await expect(video).toBeVisible();
    await expect(video).toHaveAttribute('src', FILE_RE('mp4'));
    await expect(page.getByTestId('result-listen')).toBeHidden();
    for (const id of ['mp4', 'mp3', 'srt', 'audio-srt', 'scorm']) await expect(page.getByTestId(`download-${id}`)).toBeVisible();
    const videoPlaying = () => video.evaluate((v: HTMLVideoElement) => !v.paused);
    const radioPlaying = () => page.getByTestId('radio-audio').evaluate((a: HTMLAudioElement) => !a.paused);
    await expect.poll(videoPlaying).toBe(true);

    await listenTab.click();
    await expect(listenTab).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('result-listen')).toBeVisible();
    await expect(page.getByTestId('result-watch')).toBeHidden();
    await expect.poll(radioPlaying).toBe(true);
    expect(await videoPlaying()).toBe(false);
    await expect(page.getByTestId('radio-player')).toHaveAttribute('data-state', 'playing');
    await expect(page.getByTestId('radio-audio')).toHaveAttribute('src', FILE_RE('mp3'));

    await listenTab.focus();
    await page.keyboard.press('ArrowLeft');
    await expect(watchTab).toHaveAttribute('aria-selected', 'true');
    await expect(watchTab).toBeFocused();
    await expect(page.getByTestId('result-watch')).toBeVisible();
    await expect.poll(videoPlaying).toBe(true);
    expect(await radioPlaying()).toBe(false);
    expect(errors).toEqual([]);
  });

  test('listener reactions can be switched off: no chips, reactions false', async ({ page }) => {
    const { errors, api } = await openReview(page, { jobAdvance: 'poll' });
    await expect(page.getByTestId('turn-reaction')).toHaveCount(1);
    await page.getByTestId('option-reactions').uncheck();
    await expect(page.getByTestId('turn-reaction')).toHaveCount(0);
    await page.getByTestId('format-audio').click();
    await page.getByTestId('render-podcast').click();
    await expect.poll(() => api.renders.length).toBe(1);
    expect(api.renders[0]).toMatchObject({ format: 'audio', reactions: false });
    await expect(page.getByTestId('result-view')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('turn-reaction')).toHaveCount(0);
    await expect(page.locator('.pc-result__transcript .pc-turn')).toHaveCount(STUDIO_TURNS.length);
    expect(errors).toEqual([]);
  });
});

test.describe('Podcast studio — result edge cases', () => {
  test('job warnings are listed with their labels', async ({ page }) => {
    const { errors } = await openReview(page, {
      jobAdvance: 'poll', jobWarnings: ['reactions_skipped', 'listener_fallback', 'reactions_skipped', 'some_future_code'],
    });
    await page.getByTestId('format-audio').click();
    await page.getByTestId('render-podcast').click();
    const warnings = page.getByTestId('result-warnings');
    await expect(warnings).toBeVisible({ timeout: 30_000 });
    await expect(warnings.getByRole('listitem')).toHaveText([
      'Some listener reactions did not fit and were skipped.',
      'The listening host uses a simplified animation.',
      'The render completed with a warning.',
    ]);
    await expect(page.getByTestId('radio-player')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('a missing transcript (404) still leaves a working player', async ({ page }) => {
    const { errors } = await openReview(page, { jobAdvance: 'poll' });
    const transcriptRequests: string[] = [];
    await page.route((url) => FILE_RE('transcript').test(url.pathname), (route) => {
      transcriptRequests.push(route.request().url());
      return route.fulfill({ status: 404, json: { detail: 'File not found' } });
    });
    await page.getByTestId('format-audio').click();
    await page.getByTestId('render-podcast').click();

    const player = page.getByTestId('result-listen').getByTestId('radio-player');
    await expect(player).toBeVisible({ timeout: 30_000 });
    await expect(player).toHaveAttribute('data-state', 'playing');
    const audioTime = () => player.getByTestId('radio-audio').evaluate((a: HTMLAudioElement) => a.currentTime);
    const from = await audioTime();
    await expect.poll(audioTime).toBeGreaterThan(from + 0.5);
    expect(transcriptRequests.length).toBeGreaterThanOrEqual(1);
    await expect(player.getByTestId('radio-caption')).toHaveCount(0);
    await expect(player.getByTestId('radio-transcript-toggle')).toHaveCount(0);
    await expect(player.getByTestId('radio-time')).toHaveText(new RegExp(`/ 0:${MEDIA.mp3.durationSec}$`));
    await expect(player.getByTestId('radio-host-interviewer')).toContainText('Sofia');
    await expect(player.getByTestId('radio-host-expert')).toContainText('Lucas');
    await expect(player.getByTestId('radio-error')).toHaveCount(0);

    // Controls still work without captions.
    await player.getByTestId('radio-play').click();
    await expect(player).toHaveAttribute('data-state', 'paused');
    await player.getByTestId('radio-forward').click();
    await expect.poll(audioTime).toBeGreaterThan(from + 15);
    expect(errors).toEqual([]);
  });
});
