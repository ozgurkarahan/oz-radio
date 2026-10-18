import { test, expect as baseExpect, type Page, type Request } from '@playwright/test';

/**
 * READ-ONLY production smoke of phone listening, for the deploy step (deploy-verify gates).
 *
 * Skipped unless OZ_RADIO_PROD_SMOKE=1, which also requires AI_PRESENTER_BASE_URL (the deployed origin):
 *   $env:OZ_RADIO_PROD_SMOKE = '1'
 *   $env:AI_PRESENTER_BASE_URL = 'https://<app>.<env>.<region>.azurecontainerapps.io'
 *   npm run test:prod-smoke        # playwright test tests/prod-smoke.spec.ts --project=mobile-chromium
 *
 * No mocks: the real API and the real Blob audio, as an anonymous visitor on a phone.
 * Read-only: every non-GET request is aborted, nothing is signed in, created, published,
 * reset or deleted. Audio URLs carry short-lived SAS tokens: query strings are stripped from
 * every message and tracing is off (a trace would record the signed URLs).
 * The Container App scales to zero: each test first warms it (cold start ≈ 30 s).
 */

const expect = baseExpect.configure({ timeout: 30_000 });
const PROD_SMOKE = process.env.OZ_RADIO_PROD_SMOKE === '1';
const PHONE_VIEWPORT = { width: 390, height: 844 };
const BLOB_ORIGIN = /^https:\/\/[a-z0-9]+\.blob\.core\.windows\.net$/;

test.skip(!PROD_SMOKE, 'Production smoke: set OZ_RADIO_PROD_SMOKE=1 and AI_PRESENTER_BASE_URL to the deployed origin');
test.use({
  isMobile: true,
  hasTouch: true,
  // mobile-chromium keeps its Pixel 7 screen; desktop projects get a phone.
  viewport: async ({ viewport }, use) => use(viewport && viewport.width <= 480 ? viewport : PHONE_VIEWPORT),
  // A missing control fails in 30 s, not at the 4-min test timeout (the cold start is the warm-up's).
  actionTimeout: 30_000,
  trace: 'off',
});
test.describe.configure({ timeout: 240_000 });

/** Drops query strings and fragments (SAS tokens) from every URL in `text`. */
const redact = (text: string) => text.replace(/(https?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/g, '$1?…');

test.beforeAll(() => {
  if (!process.env.AI_PRESENTER_BASE_URL) {
    throw new Error('OZ_RADIO_PROD_SMOKE=1 needs AI_PRESENTER_BASE_URL=<deployed origin> (it would test local dev otherwise)');
  }
});

test.beforeEach(async ({ request }) => {
  const health = await request.get('/api/health', { timeout: 120_000 });
  expect(health.status(), 'GET /api/health (warm-up)').toBe(200);
});

/** GET only: anything else is aborted (and listed on the test as an annotation). */
async function readOnly(page: Page) {
  const blocked: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(redact(String(e))));
  await page.route('**/*', (r) => (r.request().method() === 'GET' ? r.continue() : r.abort()));
  page.on('requestfailed', (r: Request) => {
    if (r.method() !== 'GET') blocked.push(`${r.method()} ${redact(r.url())}`);
  });
  return {
    errors,
    annotate: () => {
      if (blocked.length > 0) test.info().annotations.push({ type: 'blocked writes', description: blocked.join(', ') });
    },
  };
}

const radioAudio = (page: Page) => page.getByTestId('radio-audio');
const audioTime = (page: Page) => radioAudio(page).evaluate((a: HTMLAudioElement) => a.currentTime);
const isTagged = (page: Page) => radioAudio(page).evaluate((a) => (a as unknown as { ozSmoke?: string }).ozSmoke === 'radio');

async function expectAdvancing(page: Page, label: string) {
  const from = await audioTime(page);
  await expect.poll(() => audioTime(page), { message: `${label}: the radio's currentTime advances`, timeout: 20_000 })
    .toBeGreaterThan(from + 1);
}

test('a phone listens: one tap plays the Blob radio, minimising keeps it playing, the sheet reopens on the same <audio>', async ({ page }) => {
  const { errors, annotate } = await readOnly(page);
  await page.goto('/podcast/library');
  const rows = page.getByTestId('library-item');
  await expect(rows.first(), 'the library lists at least one episode').toBeVisible({ timeout: 60_000 });

  // The first row with audio: its Listen button.
  const listen = page.getByTestId('library-listen').first();
  await expect(listen, 'an episode has public audio (PODCAST_PUBLIC_AUDIO)').toBeVisible();
  const title = ((await listen.getAttribute('aria-label')) ?? '').replace(/^Listen to /, '');
  await listen.tap();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toHaveAttribute('data-mode', 'listen');
  await expect(dialog.getByTestId('radio-player')).toHaveAttribute('data-state', 'playing');

  const src = (await radioAudio(page).getAttribute('src')) ?? '';
  const origin = src ? new URL(src, page.url()).origin : '(none)';
  expect(origin, 'the radio plays the episode from Blob storage').toMatch(BLOB_ORIGIN);
  await radioAudio(page).evaluate((a: HTMLAudioElement) => {
    a.muted = true;
    (a as unknown as { ozSmoke?: string }).ozSmoke = 'radio';
  });
  await expectAdvancing(page, 'Now Playing sheet');

  await dialog.getByRole('button', { name: 'Minimise player' }).tap();
  await expect(dialog).toHaveCount(0);
  const mini = page.getByTestId('mini-player');
  await expect(mini).toBeVisible();
  await expect(mini.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await expectAdvancing(page, 'mini-player');

  await mini.getByRole('button', { name: `Open now playing: ${title}` }).tap();
  await expect(dialog).toHaveAttribute('data-mode', 'listen');
  await expect(dialog.getByTestId('radio-player')).toHaveAttribute('data-state', 'playing');
  await expect(dialog.getByTestId('radio-audio')).toHaveCount(1);
  expect(await isTagged(page), 'the reopened sheet plays on the same <audio> element').toBe(true);
  await expectAdvancing(page, 'reopened sheet');

  annotate();
  expect(errors, 'uncaught page errors').toEqual([]);
});

test('the app shell /assets/*.js are gzip-compressed and cached as immutable', async ({ page, baseURL }) => {
  const { errors, annotate } = await readOnly(page);
  const origin = new URL(baseURL!).origin;
  const pending: Promise<{ path: string; status: number; encoding: string; cacheControl: string }>[] = [];
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.origin !== origin || !/^\/assets\/[^/]+\.js$/.test(url.pathname)) return;
    pending.push(response.allHeaders().then((h) => ({
      path: url.pathname, status: response.status(), encoding: h['content-encoding'] ?? '(none)', cacheControl: h['cache-control'] ?? '(none)',
    })));
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 60_000 });
  await page.waitForLoadState('load');

  const assets = await Promise.all(pending);
  expect(assets.length, 'the page loaded /assets/*.js').toBeGreaterThan(0);
  for (const a of assets) {
    expect.soft(a.status, `${a.path} status`).toBe(200);
    expect.soft(a.encoding, `${a.path} content-encoding`).toBe('gzip');
    expect.soft(a.cacheControl, `${a.path} cache-control`).toContain('immutable');
  }
  annotate();
  expect(errors, 'uncaught page errors').toEqual([]);
});
