import { test, expect as baseExpect, type Locator, type Page } from '@playwright/test';
import {
  MEDIA, MOCKED_MEDIA_REASON, POD_AUDIO, POD_VIDEO, fulfillMedia, mockApi, mockBoot, mockedMediaUnavailable, routeExpiredMedia,
  type MockApiOptions,
} from './support/mock-api';

const expect = baseExpect.configure({ timeout: 15_000 });
test.describe.configure({ timeout: 90_000 });

/**
 * UX re-run 2, libraries and Home:
 *  R2  podcasts lead with Listen on every viewport (Watch stays the secondary button / the lead of a video-only episode);
 *  R4  Home "Latest": an honest count, "All podcasts / All videos" links, and the format as a leading badge, printed once;
 *  R8  phone video modal: the Close button never overlaps the video, and "Loading video…" shows until a frame is ready.
 */
const DESKTOP = { viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false };
const PHONE = { viewport: { width: 412, height: 839 }, isMobile: true, hasTouch: true };

/** pod-2: Watch + Listen; pod-3: Listen only; pod-1: legacy (video only). */
const VIDEO_TITLE = 'Agents on air';
const AUDIO_TITLE = 'Safety minute';

async function open(page: Page, path: string, opts: MockApiOptions = {}) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await mockApi(page, 'visitor', { podcastV2: true, ...opts });
  await mockBoot(page, {}, opts);
  await page.goto(path);
  return errors;
}

const rowOf = (page: Page, title: string) => page.getByTestId('library-item').filter({ hasText: title });
const dialog = (page: Page) => page.getByRole('dialog');
const playButtons = (row: Locator) => row.locator('[data-testid="library-listen"], [data-testid="library-watch"]')
  .evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')));

async function box(locator: Locator) {
  const b = await locator.boundingBox();
  expect(b, 'element has a box').not.toBeNull();
  return b!;
}

const noHorizontalOverflow = (page: Page) => page.evaluate(
  () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
);

/** The two rectangles share no area. */
function disjoint(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) {
  return a.x + a.width <= b.x + 0.5 || b.x + b.width <= a.x + 0.5 || a.y + a.height <= b.y + 0.5 || b.y + b.height <= a.y + 0.5;
}

for (const [label, device] of [['desktop', DESKTOP], ['phone', PHONE]] as const) {
  test.describe(`R2 · Listen leads the podcast library (${label})`, () => {
    test.use(device);

    test('every episode with audio leads with Listen: primary and first button, title opens Listen', async ({ page }) => {
      const errors = await open(page, '/podcast/library');
      await expect(page.getByTestId('library-item')).toHaveCount(3);
      const row = rowOf(page, VIDEO_TITLE);
      expect(await playButtons(row)).toEqual(['library-listen', 'library-watch']);
      await expect(row.getByTestId('library-listen')).toHaveClass(/\bbtn--primary\b/);
      await expect(row.getByTestId('library-watch')).not.toHaveClass(/\bbtn--primary\b/);
      const [l, w] = [await box(row.getByTestId('library-listen')), await box(row.getByTestId('library-watch'))];
      expect(l.x + l.width).toBeLessThanOrEqual(w.x + 0.5);
      await expect(page.getByTestId('library-item').locator('.btn--primary')).toHaveCount(3);

      await row.getByRole('button', { name: VIDEO_TITLE, exact: true }).click();
      await expect(page).toHaveURL(/\?episode=pod-2&mode=listen$/);
      await expect(dialog(page)).toHaveAttribute('data-mode', 'listen');
      await expect(page.getByTestId('library-player')).toHaveCount(0);
      expect(errors).toEqual([]);
    });

    test('Watch is still one tap away; an episode link without a mode opens Listen', async ({ page, browserName }) => {
      test.skip(mockedMediaUnavailable({ browserName }), MOCKED_MEDIA_REASON);
      const errors = await open(page, '/podcast/library');
      await rowOf(page, VIDEO_TITLE).getByTestId('library-watch').click();
      await expect(page).toHaveURL(/\?episode=pod-2&mode=watch$/);
      await expect(dialog(page)).toHaveAttribute('data-mode', 'watch');
      await expect(page.getByTestId('library-player')).toHaveAttribute('src', POD_VIDEO.mp4_url!);
      await page.keyboard.press('Escape');

      await page.goto('/podcast/library?episode=pod-2');
      await expect(dialog(page)).toHaveAttribute('data-mode', 'listen');
      await expect(page).toHaveURL(/\?episode=pod-2&mode=listen$/);
      expect(errors).toEqual([]);
    });

    test('a video-only episode (no audio) still leads with Watch', async ({ page }) => {
      const errors = await open(page, '/podcast/library', { publicAudio: false });
      const row = rowOf(page, VIDEO_TITLE);
      await expect(row).toBeVisible();
      expect(await playButtons(row)).toEqual(['library-watch']);
      await expect(row.getByTestId('library-watch')).toHaveClass(/\bbtn--primary\b/);
      await row.getByRole('button', { name: VIDEO_TITLE, exact: true }).click();
      await expect(page).toHaveURL(/\?episode=pod-2&mode=watch$/);
      expect(errors).toEqual([]);
    });

    test('Home deep-links every episode with audio into Listen, a video-only one into Watch', async ({ page }) => {
      const errors = await open(page, '/');
      for (const id of [POD_VIDEO.job_id, POD_AUDIO.job_id]) {
        await expect(page.locator(`a[href="/podcast/library?episode=${id}&mode=listen"]`)).toHaveCount(2);
      }
      await expect(page.locator(`a[href="/podcast/library?episode=${POD_VIDEO.job_id}&mode=watch"]`)).toHaveCount(0);
      expect(errors).toEqual([]);
    });

    test('Home keeps Watch for an episode without audio', async ({ page }) => {
      await open(page, '/', { publicAudio: false });
      await expect(page.locator(`a[href="/podcast/library?episode=${POD_VIDEO.job_id}&mode=watch"]`)).toHaveCount(2);
      await expect(page.locator(`a[href="/podcast/library?episode=${POD_VIDEO.job_id}&mode=listen"]`)).toHaveCount(0);
    });
  });
}

test.describe('R4 · Home "Latest"', () => {
  const total = (page: Page) => page.evaluate(async () => {
    const lists = await Promise.all(['/api/decks', '/api/video/library', '/api/podcast/library'].map((u) => fetch(u).then((r) => r.json())));
    return lists.reduce((n, l) => n + (Array.isArray(l) ? l : l.items ?? []).length, 0);
  });
  const aside = (page: Page) => page.locator('.section-head').filter({ has: page.locator('#home-episodes') }).locator('.eyebrow');

  for (const [label, device] of [['desktop', DESKTOP], ['phone', PHONE]] as const) {
    test.describe(label, () => {
      test.use(device);

      test('the count is honest ("Latest 6 of N") and "All podcasts" / "All videos" lead to the libraries', async ({ page }) => {
        const errors = await open(page, '/', { catalog: 'demo' });
        const rows = page.getByTestId('home-episode');
        await expect(rows).toHaveCount(6);
        const n = await total(page);
        expect(n).toBeGreaterThan(6);
        await expect(aside(page)).toHaveText(`Latest 6 of ${n}`);

        const more = page.getByTestId('home-see-all');
        const podcasts = more.getByRole('link', { name: 'All podcasts' });
        const videos = more.getByRole('link', { name: 'All videos' });
        await expect(podcasts).toHaveAttribute('href', '/podcast/library');
        await expect(videos).toHaveAttribute('href', '/video/library');
        if (label === 'phone') {
          for (const link of [podcasts, videos]) expect((await box(link)).height).toBeGreaterThanOrEqual(44);
        }
        await videos.click();
        await expect(page).toHaveURL(/\/video\/library$/);
        expect(errors).toEqual([]);
      });

      test('with everything shown, the header counts the items and no "All …" link is offered', async ({ page }) => {
        await open(page, '/');
        await expect(page.getByTestId('home-episode').first()).toBeVisible();
        const n = await total(page);
        test.skip(n > 6, 'the default catalog has more than six items');
        await expect(aside(page)).toHaveText(`${n} items`);
        await expect(page.getByTestId('home-see-all')).toHaveCount(0);
      });

      test('the format leads each row as a badge, once, and is not repeated in the meta line', async ({ page }) => {
        const errors = await open(page, '/', { catalog: 'demo' });
        const rows = page.getByTestId('home-episode');
        await expect(rows).toHaveCount(6);
        const kinds = new Set<string>();
        for (const row of await rows.all()) {
          const badge = row.locator('.episode-row__kind');
          await expect(badge).toHaveCount(1);
          await expect(badge).toBeVisible();
          await expect(badge.locator('svg')).toHaveAttribute('aria-hidden', 'true');
          kinds.add((await badge.innerText()).trim());
          // Above the title, inside the text column.
          const [b, t] = [await box(badge), await box(row.locator('.episode-row__title'))];
          expect(b.y + b.height).toBeLessThanOrEqual(t.y + 1);
          await expect(row.locator('.episode-row__meta')).not.toContainText(/Podcast|Narrated video|Slides|Live presentation/i);
          await expect(row.locator('.episode-row__body .episode-row__kind')).toHaveCount(1);
        }
        expect([...kinds].some((k) => /podcast/i.test(k))).toBe(true);
        expect([...kinds].some((k) => /narrated video/i.test(k))).toBe(true);
        expect(await noHorizontalOverflow(page)).toBe(true);
        expect(errors).toEqual([]);
      });
    });
  }

  test.describe('tablet width', () => {
    test.use({ viewport: { width: 820, height: 1000 }, isMobile: false, hasTouch: false });

    test('the badge is there where the old kind column was hidden', async ({ page }) => {
      await open(page, '/', { catalog: 'demo' });
      const rows = page.getByTestId('home-episode');
      await expect(rows).toHaveCount(6);
      for (const row of await rows.all()) await expect(row.locator('.episode-row__kind')).toBeVisible();
      expect(await noHorizontalOverflow(page)).toBe(true);
    });
  });
});

test.describe('R8 · phone video modal', () => {
  test.use(PHONE);

  /** The Close button is a 44 px target; the video starts below it. */
  const expectCloseClearOfVideo = async (page: Page) => {
    const video = page.getByTestId('library-player');
    await expect(video).toBeVisible();
    const close = dialog(page).locator('.modal__close');
    await expect(close).toBeVisible();
    const [c, v] = [await box(close), await box(video)];
    expect(c.height).toBeGreaterThanOrEqual(44);
    expect(disjoint(c, v), `close ${JSON.stringify(c)} overlaps video ${JSON.stringify(v)}`).toBe(true);
    expect(v.y).toBeGreaterThanOrEqual(c.y + c.height - 0.5);
    expect(await noHorizontalOverflow(page)).toBe(true);
  };

  test('the video library modal reserves a top bar: Close never overlaps the video', async ({ page }) => {
    const errors = await open(page, '/video/library');
    await page.route('**/media/vid-1.mp4', (r) => fulfillMedia(r, MEDIA.mp4));
    await page.getByRole('button', { name: /^Play / }).first().tap();
    await expectCloseClearOfVideo(page);
    expect(errors).toEqual([]);
  });

  test('the podcast Watch video clears Close too', async ({ page }) => {
    const errors = await open(page, '/podcast/library?episode=pod-2&mode=watch');
    await expect(dialog(page)).toHaveAttribute('data-mode', 'watch');
    await expectCloseClearOfVideo(page);
    expect(errors).toEqual([]);
  });

  test.describe('buffering status', () => {
    test.skip(({ browserName }) => mockedMediaUnavailable({ browserName }), MOCKED_MEDIA_REASON);

    test('a library video that has not started shows "Loading video…" (polite status over the video)', async ({ page }) => {
      const errors = await open(page, '/video/library');
      await page.route('**/media/vid-1.mp4', () => { /* never answers */ });
      await page.getByRole('button', { name: /^Play / }).first().tap();
      const status = page.getByTestId('video-buffering');
      await expect(status).toBeVisible();
      await expect(status).toHaveAttribute('role', 'status');
      await expect(status).toHaveAttribute('aria-live', 'polite');
      await expect(status).toContainText('Loading video…');
      // Over the picture, and never in the way of the native controls.
      await expect(status).toHaveCSS('pointer-events', 'none');
      const [s, v] = [await box(status), await box(page.getByTestId('library-player'))];
      expect(s.x).toBeGreaterThanOrEqual(v.x - 0.5);
      expect(s.y).toBeGreaterThanOrEqual(v.y - 0.5);
      expect(s.x + s.width).toBeLessThanOrEqual(v.x + v.width + 0.5);
      expect(s.y + s.height).toBeLessThanOrEqual(v.y + v.height + 0.5);
      expect(errors).toEqual([]);
    });

    test('it goes away once the video can play, and comes back on a stall (waiting → playing)', async ({ page }) => {
      const errors = await open(page, '/video/library');
      await page.route('**/media/vid-1.mp4', (r) => fulfillMedia(r, MEDIA.mp4));
      await page.getByRole('button', { name: /^Play / }).first().tap();
      const video = page.getByTestId('library-player');
      await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(2);
      await expect(page.getByTestId('video-buffering')).toHaveCount(0);

      await video.evaluate((v) => v.dispatchEvent(new Event('waiting')));
      await expect(page.getByTestId('video-buffering')).toBeVisible();
      await video.evaluate((v) => v.dispatchEvent(new Event('playing')));
      await expect(page.getByTestId('video-buffering')).toHaveCount(0);
      expect(errors).toEqual([]);
    });

    test('a paused video that is not about to autoplay is idle, not "loading"', async ({ page }) => {
      const errors = await open(page, '/video/library');
      await page.route('**/media/vid-1.mp4', () => { /* never answers: like a browser that fetches nothing before Play */ });
      await page.getByRole('button', { name: /^Play / }).first().tap();
      await expect(page.getByTestId('video-buffering')).toBeVisible();
      await page.getByTestId('library-player').evaluate((v: HTMLVideoElement) => {
        v.autoplay = false;
        v.pause();
        v.dispatchEvent(new Event('pause'));
      });
      await expect(page.getByTestId('video-buffering')).toHaveCount(0);
      expect(errors).toEqual([]);
    });

    test('never shown after an error: the recovery panel takes over', async ({ page }) => {
      const errors = await open(page, '/video/library');
      await routeExpiredMedia(page, '**/media/vid-1.mp4');
      await page.getByRole('button', { name: /^Play / }).first().tap();
      await expect(page.getByTestId('video-problem')).toBeVisible();
      await expect(page.getByTestId('video-buffering')).toHaveCount(0);
      expect(errors).toEqual([]);
    });

    test('the podcast Watch video says it is loading, then clears', async ({ page }) => {
      const errors = await open(page, '/podcast/library');
      await page.route('**/media/pod-2.mp4', () => { /* never answers */ });
      await rowOf(page, VIDEO_TITLE).getByTestId('library-watch').tap();
      await expect(dialog(page)).toHaveAttribute('data-mode', 'watch');
      await expect(page.getByTestId('video-buffering')).toBeVisible();
      await expect(page.getByTestId('video-buffering')).toContainText('Loading video…');
      expect(errors).toEqual([]);
    });

    test('the podcast Watch buffering status clears once the video plays', async ({ page }) => {
      const errors = await open(page, '/podcast/library?episode=pod-2&mode=watch');
      const video = page.getByTestId('library-player');
      await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(2);
      await expect(page.getByTestId('video-buffering')).toHaveCount(0);
      expect(errors).toEqual([]);
    });
  });
});
