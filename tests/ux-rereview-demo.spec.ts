/**
 * UX re-review (demo unit): labels on the deck page, language of parts, the phone demo bar, what Start tells a first-time
 * visitor, one retry action, the slide placeholder. Mocked: no backend, no real WebRTC (same seams as ux-demo.spec.ts).
 */
import { devices, expect, test, type Page } from '@playwright/test';
import { DEMO_DECK_EN, DEMO_DECK_FR, DEMO_QA_CONFIG, mockApi } from './support/mock-api';
import { demoHooks, mockDemoSocket, refuseDemoHandshake, type DemoSocketOptions } from './support/demo-ws-fixtures';
import { DEMO_CLOSE_CODES as CLOSE } from '../demos/frontend/src/services/demoProtocol';

test.describe.configure({ timeout: 90_000 });

test.use({
  permissions: ['microphone'],
  launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] },
});

const EN_PATH = '/decks/deck-demo-en/present';
const FR_PATH = '/decks/deck-demo-fr/present';

const slimDeck = (base: typeof DEMO_DECK_EN, slides: number, imageUrl = '') => ({
  ...base,
  id: base.deck_id,
  filename: base.title,
  slide_count: slides,
  slides: Array.from({ length: slides }, (_, i) => ({ index: i, title: `Slide ${i + 1}`, image_url: imageUrl, text: `Text of slide ${i + 1}` })),
});

async function open(page: Page, path: string, o: { socket?: DemoSocketOptions; slides?: number; image?: string; refuse?: boolean } = {}) {
  await mockApi(page, 'visitor', { catalog: 'demo', demoQa: DEMO_QA_CONFIG, demoSessionSeconds: 300 });
  if (o.slides) {
    const base = path === FR_PATH ? DEMO_DECK_FR : DEMO_DECK_EN;
    await page.route(`**/api/decks/${base.deck_id}`, (route) => route.fulfill({ json: slimDeck(base as typeof DEMO_DECK_EN, o.slides!, o.image) }));
  }
  if (o.refuse) await refuseDemoHandshake(page, { afterMs: 80 });
  const mock = await mockDemoSocket(page, { slideCount: o.slides ?? 5, sessionSeconds: 300, idleCloseMs: false, ...o.socket });
  await page.goto(path);
  return mock;
}

const eyebrow = (page: Page) => page.locator('.page-header .eyebrow');

test.describe('deck page labels (S4)', () => {
  test('a deck that cannot be presented live is "Slides", never "Live presentation" or "Live demo"', async ({ page }) => {
    await mockApi(page, 'visitor', { catalog: 'demo', demoQa: DEMO_QA_CONFIG });
    await page.goto('/decks/deck-plain/present');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('AI ethics');
    await expect(eyebrow(page)).toHaveText('Slides · 3 slides · English');
    await expect(page.getByText('Live presentation')).toHaveCount(0);
  });

  test('a live-demo deck is "Live demo"', async ({ page }) => {
    await open(page, EN_PATH);
    await expect(page.getByTestId('demo-start')).toBeVisible();
    await expect(eyebrow(page)).toHaveText('Live demo · 5 slides · English');
  });

  test('while the deck loads: a neutral title and no kicker — never "Live presentation" twice', async ({ page }) => {
    await mockApi(page, 'visitor', { catalog: 'demo', demoQa: DEMO_QA_CONFIG });
    await page.route('**/api/decks/deck-demo-en', async (route) => {
      await new Promise((r) => setTimeout(r, 1500));
      await route.fallback();
    });
    await page.goto(EN_PATH);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Loading deck…');
    await expect(eyebrow(page)).toHaveCount(0);
    await expect(page.getByText('Live presentation')).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('AI in three minutes · Live demo', { timeout: 15_000 });
  });
});

test.describe('language of parts (S12)', () => {
  test('the French deck: title, language name and slide picture are French; the answer and its announcement too', async ({ page }) => {
    const mock = await open(page, FR_PATH, { slides: 1, image: '/media/slide-0.png', socket: { language: 'fr-FR' } });
    await expect(page.getByTestId('demo-start')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.page-header h1 [lang="fr"]')).toHaveCount(1);
    await expect(page.locator('.page-header .eyebrow [lang="fr"]')).toHaveText('Français');
    await expect(page.locator('.media-frame[lang="fr"] img')).toHaveCount(1);
    await expect(page.locator('html')).not.toHaveAttribute('lang', 'fr');

    await page.getByTestId('demo-start').click();
    await expect.poll(() => mock.connections).toBe(1);
    await demoHooks.connected(page);
    await expect.poll(() => mock.items.length, { timeout: 20_000 }).toBeGreaterThanOrEqual(1);
    await demoHooks.finishTurn(page, mock.items[0]);
    await expect(page.getByTestId('demo-narration-done')).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('demo-ask').click();
    await page.getByTestId('qa-text-input').fill('Qu’est-ce qu’un agent ?');
    await page.getByTestId('qa-text-submit').click();
    await expect(page.locator('[data-testid="qa-answer"] p[lang="fr"]')).toBeVisible();
    await expect(page.getByTestId('qa-live')).toHaveAttribute('lang', 'fr');
  });
});

test.describe('before Start (S3)', () => {
  test('it says a microphone is not needed to listen, and links the captioned recording before Start', async ({ page }) => {
    const mock = await open(page, EN_PATH);
    await expect(page.getByTestId('demo-start')).toBeVisible();
    await expect(page.getByTestId('demo-mic-note')).toContainText('Listening needs no microphone');
    await expect(page.getByTestId('demo-mic-note')).toContainText('allow the microphone');
    const link = page.getByTestId('demo-prestart-recording');
    await expect(link).toBeVisible();
    await expect(link).toHaveText('Watch AI in three minutes · Demo recording with captions');
    await expect(link).toHaveAttribute('href', '/video/library?video=vid-demo-en');
    expect(mock.connections, 'nothing starts before the tap').toBe(0);
  });
});

test.describe('failures (polish)', () => {
  test('a failed connection shows one retry action, and the card title is a second-level heading', async ({ page }) => {
    await open(page, EN_PATH, { refuse: true });
    await page.getByTestId('demo-start').click();
    const card = page.getByTestId('demo-outcome');
    await expect(card).toBeVisible();
    await expect(card.getByTestId('demo-outcome-title')).toHaveJSProperty('tagName', 'H2');
    await expect(page.getByRole('button', { name: /try again|start the live demo/i })).toHaveCount(1);
    await expect(page.getByTestId('demo-start')).toHaveCount(0);
    await expect(card.getByTestId('demo-outcome-retry')).toHaveText('Try again');
    await expect(card.getByTestId('demo-outcome-recording')).toHaveText(/Demo recording/);
  });

  test('without a retry (daily limit) "Start" stays, disabled with its reason', async ({ page }) => {
    const mock = await open(page, EN_PATH, { socket: { onOpen: { close: CLOSE.DAILY_QUOTA } } });
    await page.getByTestId('demo-start').click();
    await expect.poll(() => mock.connections).toBe(1);
    await expect(page.getByTestId('demo-outcome-retry')).toHaveCount(0);
    await expect(page.getByTestId('demo-start')).toBeDisabled();
  });
});

test.describe('the slide before its picture arrives (S6) and the slide alt (N6)', () => {
  test('the frame is a token-colored skeleton, not a blank white box, then the picture', async ({ page }) => {
    await mockApi(page, 'visitor', { catalog: 'demo', demoQa: DEMO_QA_CONFIG });
    await page.route('**/api/decks/deck-demo-en', (route) => route.fulfill({ json: slimDeck(DEMO_DECK_EN, 2, '/media/slide-0.png') }));
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route('**/media/slide-0.png', async (route) => { await gate; await route.fallback(); });
    await page.goto(EN_PATH);
    const screen = page.locator('.slide-viewer__screen--image');
    await expect(screen).toHaveClass(/is-loading/);
    const box = (await screen.boundingBox())!;
    expect(box.width / box.height, 'the frame already has its 16:9 shape').toBeCloseTo(16 / 9, 1);
    const bg = await screen.evaluate((el) => getComputedStyle(el).backgroundColor);
    const paper = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--c-line').trim());
    expect(bg, 'not the white of an empty page').not.toBe('rgb(255, 255, 255)');
    expect(paper).not.toBe('');
    release();
    await expect(screen).not.toHaveClass(/is-loading/);
  });
});

test.describe('phone demo bar (S2)', () => {
  const { defaultBrowserType: _browser, ...PIXEL_7 } = devices['Pixel 7'];
  test.use({ ...PIXEL_7 });

  test('the bar is capped at 45 % of the screen; a long answer scrolls inside it and the controls stay in view', async ({ page }, testInfo) => {
    const longAnswer = Array.from({ length: 60 }, (_, i) => `Sentence ${i + 1} of a long answer.`).join(' ');
    const mock = await open(page, EN_PATH, { slides: 1, socket: { answer: longAnswer } });
    await expect(page.getByTestId('demo-start')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('demo-start').tap();
    await expect.poll(() => mock.connections).toBe(1);
    await demoHooks.connected(page);
    await expect.poll(() => mock.items.length, { timeout: 20_000 }).toBeGreaterThanOrEqual(1);
    await demoHooks.finishTurn(page, mock.items[0]);
    await expect(page.getByTestId('demo-narration-done')).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('demo-ask').tap();
    await page.getByTestId('qa-text-input').fill('Tell me everything');
    await page.getByTestId('qa-text-submit').tap();
    const answer = page.getByTestId('qa-answer');
    await expect(answer).toBeVisible();

    const dock = page.getByTestId('demo-avatar-controls');
    const viewport = page.viewportSize()!;
    const bar = (await dock.boundingBox())!;
    expect(bar.height, 'the bar never takes more than 45 % of the screen').toBeLessThanOrEqual(viewport.height * 0.45 + 1);
    const scrolls = await answer.evaluate((el) => el.scrollHeight > el.clientHeight + 1);
    expect(scrolls, 'the long answer scrolls inside its own box').toBe(true);
    await expect(page.getByTestId('demo-stop')).toBeInViewport({ ratio: 1 });
    for (const id of ['demo-stop']) {
      const box = (await page.getByTestId(id).boundingBox())!;
      expect(box.height, `${id} keeps a 44 px target`).toBeGreaterThanOrEqual(43);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('answer-phone.png') });
  });
});
