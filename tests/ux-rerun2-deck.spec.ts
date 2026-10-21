/**
 * UX re-run 2 (deck unit): the mini-player and the live-demo deck page (R3), the slide alt text (R11), the language of a
 * recording title inside an English link (R12) and the deck header (R13). Mocked API only: no real live session starts.
 */
import { expect as baseExpect, test, type Page } from '@playwright/test';
import { DEMO_DECK_EN, DEMO_QA_CONFIG, MOCKED_MEDIA_REASON, mockApi, mockedMediaUnavailable } from './support/mock-api';
import { mockDemoSocket, refuseDemoHandshake } from './support/demo-ws-fixtures';

// The dev server is shared: first requests of a page can be slow.
const expect = baseExpect.configure({ timeout: 15_000 });
test.describe.configure({ timeout: 90_000 });

test.use({
  permissions: ['microphone'],
  launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] },
});

const EN_PATH = '/decks/deck-demo-en/present';
const FR_PATH = '/decks/deck-demo-fr/present';
const EPISODE = 'pod-demo-fr';

async function mock(page: Page) {
  await mockApi(page, 'visitor', { catalog: 'demo', demoQa: DEMO_QA_CONFIG, demoSessionSeconds: 300 });
}

/** Opens an episode's Now Playing sheet, minimises it into the mini-player and, when asked, pauses it. */
async function episodeInMiniPlayer(page: Page, { playing }: { playing: boolean }) {
  await page.goto(`/podcast/library?episode=${EPISODE}&mode=listen`);
  const dialog = page.getByRole('dialog');
  const audio = page.getByTestId('radio-audio');
  await expect(audio).toHaveAttribute('src', /pod-demo-fr\.mp3/);
  // The mocked MP3 lasts a few seconds: on a busy machine it would end before the deck page is reached.
  await audio.evaluate((a: HTMLAudioElement) => { a.loop = true; });
  const player = dialog.getByTestId('radio-player');
  // Autoplay may still be starting: give it a moment, then press Play only if it did not.
  const started = await expect(player).toHaveAttribute('data-state', 'playing', { timeout: 5_000 }).then(() => true, () => false);
  if (!started && await dialog.getByTestId('radio-play').getAttribute('aria-label') === 'Play') {
    await dialog.getByTestId('radio-play').click();
  }
  await expect(player).toHaveAttribute('data-state', 'playing');
  await dialog.getByRole('button', { name: 'Minimise player' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('mini-player')).toBeVisible();
  if (!playing) {
    await audio.evaluate((a: HTMLAudioElement) => a.pause());
    await expect(page.getByTestId('mini-player-status')).toHaveText(/Paused/);
  }
}

/** Client-side navigation to the live-demo deck (the player must survive: no reload). */
async function toDeck(page: Page) {
  const menu = page.getByRole('button', { name: 'Open menu' });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('link', { name: 'Decks', exact: true }).first().click();
  await page.locator(`a[href="${EN_PATH}"]`).first().click();
  await expect(page).toHaveURL(new RegExp(`${EN_PATH}$`));
  await expect(page.getByTestId('demo-start')).toBeVisible();
}

const rect = (page: Page, testId: string) => page.getByTestId(testId).evaluate((el) => {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom, right: r.right };
});

test.describe('R3 · the mini-player and the live-demo deck page (desktop)', () => {
  test.use({ viewport: { width: 1366, height: 768 } });
  test.skip(mockedMediaUnavailable, MOCKED_MEDIA_REASON);

  test('a paused episode is not in the way: the mini-player is hidden and the recording link is clickable', async ({ page }) => {
    await mock(page);
    await episodeInMiniPlayer(page, { playing: false });
    await toDeck(page);
    await expect(page.getByTestId('mini-player')).toBeHidden();
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--mini-player-h').trim())).toBe('0px');
    const link = page.getByTestId('demo-prestart-recording');
    await link.scrollIntoViewIfNeeded();
    const covered = await link.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return !(top === el || el.contains(top));
    });
    expect(covered, 'nothing covers the recording link').toBe(false);
  });

  test('a playing episode keeps its mini-player and the recording link stays clear of it', async ({ page }) => {
    await mock(page);
    await episodeInMiniPlayer(page, { playing: true });
    await toDeck(page);
    await expect(page.getByTestId('mini-player')).toBeVisible();
    const link = page.getByTestId('demo-prestart-recording');
    await link.scrollIntoViewIfNeeded();
    const l = await link.evaluate((el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; });
    const mini = await rect(page, 'mini-player');
    expect(l.bottom, 'the link ends above the mini-player').toBeLessThanOrEqual(mini.y + 1);
    expect(l.top).toBeGreaterThanOrEqual(0);
  });

  test('pausing that episode from its bar keeps the bar and the focus on it (so it can be resumed)', async ({ page }) => {
    await mock(page);
    await episodeInMiniPlayer(page, { playing: true });
    await toDeck(page);
    const play = page.getByTestId('mini-player-play');
    await play.click();
    await expect(page.getByTestId('mini-player-status')).toHaveText(/Paused/);
    await expect(page.getByTestId('mini-player')).toBeVisible();
    await expect(play).toBeFocused();
    await play.click();
    await expect(page.getByTestId('mini-player-status')).not.toHaveText(/Paused/);
  });

  test('starting the live demo hides the mini-player: the demo owns the stage', async ({ page }) => {
    await mock(page);
    const socket = await mockDemoSocket(page, { slideCount: 5, sessionSeconds: 300, idleCloseMs: false });
    await episodeInMiniPlayer(page, { playing: true });
    await toDeck(page);
    await expect(page.getByTestId('mini-player')).toBeVisible();
    await page.getByTestId('demo-start').click();
    await expect.poll(() => socket.connections).toBe(1);
    await expect(page.getByTestId('mini-player')).toBeHidden();
  });

  test('the pre-start note says how to ask and that nothing needs signing in to', async ({ page }) => {
    await mock(page);
    await page.goto(EN_PATH);
    await expect(page.getByTestId('demo-start')).toBeVisible();
    const note = page.getByTestId('demo-avatar-controls').locator('.avatar-rail__note', { hasText: 'up to' });
    await expect(note).toHaveText('Ask by voice or text · up to 5 minutes · no sign-in');
    await expect(page.getByText('no uploads')).toHaveCount(0);
  });

  test('the help is in the rail next to Start, once', async ({ page }) => {
    await mock(page);
    await page.goto(EN_PATH);
    await expect(page.getByTestId('demo-start')).toBeVisible();
    await expect(page.getByTestId('demo-prestart-help')).toHaveCount(1);
    const start = await rect(page, 'demo-start');
    const help = await rect(page, 'demo-prestart-help');
    expect(help.y, 'the help sits under Start').toBeGreaterThan(start.bottom - 1);
    expect(help.y - start.bottom, 'and close to it').toBeLessThan(160);
    await expect(page.getByTestId('demo-mic-note')).toContainText('allow the microphone');
  });
});

test.describe('R3 · the mini-player and the live-demo deck page (phone)', () => {
  test.use({ isMobile: true, hasTouch: true, viewport: { width: 412, height: 839 } });

  test('Start, the reassurance and the recording link share the first screen, in one compact bar', async ({ page }) => {
    await mock(page);
    await page.goto(EN_PATH);
    await expect(page.getByTestId('demo-start')).toBeVisible();
    const dock = await rect(page, 'demo-avatar-controls');
    const start = await rect(page, 'demo-start');
    const note = await rect(page, 'demo-mic-note');
    const link = await rect(page, 'demo-prestart-recording');
    expect(start.height, 'Start keeps a 44 px target').toBeGreaterThanOrEqual(43);
    for (const [name, r] of Object.entries({ start, note, link })) {
      expect(r.bottom, `${name} is in the first viewport`).toBeLessThanOrEqual(839);
      expect(r.y, `${name} is on screen`).toBeGreaterThanOrEqual(0);
      expect(r.y, `${name} is inside the bar`).toBeGreaterThanOrEqual(dock.y - 1);
    }
    expect(Math.abs(dock.bottom - 839), 'the bar is pinned to the bottom edge (no mini-player, no gap)').toBeLessThanOrEqual(1);
    expect(dock.height, 'the bar stays compact').toBeLessThanOrEqual(839 * 0.35);
    await expect(page.getByTestId('demo-mic-note')).toBeVisible();
    await expect(page.getByTestId('demo-mic-note')).toHaveText(/^Listening needs no microphone\./);
    expect(await page.getByTestId('demo-mic-note').evaluate((el) => (el as HTMLElement).innerText)).not.toMatch(/allow the microphone/);
    await expect(page.getByTestId('demo-prestart-help')).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });

  test.describe('with an episode in the mini-player', () => {
    test.skip(mockedMediaUnavailable, MOCKED_MEDIA_REASON);

    test('paused: the mini-player is hidden and the bar sits on the bottom edge', async ({ page }) => {
      await mock(page);
      await episodeInMiniPlayer(page, { playing: false });
      await toDeck(page);
      await expect(page.getByTestId('mini-player')).toBeHidden();
      const dock = await rect(page, 'demo-avatar-controls');
      expect(Math.abs(dock.bottom - 839)).toBeLessThanOrEqual(1);
      await expect(page.getByTestId('demo-prestart-recording')).toBeInViewport({ ratio: 1 });
    });

    test('playing: the bar rides directly on top of the mini-player, nothing overlaps', async ({ page }) => {
      await mock(page);
      await episodeInMiniPlayer(page, { playing: true });
      await toDeck(page);
      await expect(page.getByTestId('mini-player')).toBeVisible();
      const dock = await rect(page, 'demo-avatar-controls');
      const mini = await rect(page, 'mini-player');
      expect(Math.abs(dock.bottom - mini.y), 'no gap and no overlap between the bar and the mini-player').toBeLessThanOrEqual(1);
      const h = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--mini-player-h')));
      expect(Math.abs(mini.height - h)).toBeLessThanOrEqual(1);
    });
  });
});

// ── R11 · slide alt text ─────────────────────────────────────────────────────────────────────────────────────

const COLLAPSED = 'OZ RADIO · AI ENABLEMENT · LIVE DEMO A quick, live look at how AI works Beginner · three-minute demo Built from a language model '
  + 'Voice generated in real time Here to explain AI, simply language model realtime voice avatar Oz Radio · AI enablement · Beginner demo 1 / 5';
const LINES = 'OZ RADIO · AI ENABLEMENT · LIVE DEMO\nA quick, live look at how AI works\nBeginner · three-minute demo\nBuilt from a language model\n'
  + 'Voice generated in real time\nHere to explain AI, simply\nlanguage model\nrealtime voice\navatar\nOz Radio · AI enablement · Beginner demo\n1 / 5';

async function altOf(page: Page, text: string): Promise<string> {
  await mock(page);
  await page.route('**/api/decks/deck-demo-en', (route) => route.fulfill({
    json: {
      ...DEMO_DECK_EN,
      id: DEMO_DECK_EN.deck_id,
      filename: DEMO_DECK_EN.title,
      slide_count: 1,
      slides: [{ index: 0, title: "Hi, I'm an AI presenter", image_url: '/media/slide-0.png', text }],
    },
  }));
  await page.goto(EN_PATH);
  const img = page.locator('.slide-viewer img');
  await expect(img).toHaveCount(1);
  return (await img.getAttribute('alt')) ?? '';
}

function expectReadable(alt: string) {
  expect(alt).toMatch(/^Hi, I'm an AI presenter\. \S/);
  expect(alt, 'no run of shouted words').not.toMatch(/\b[A-Z]{3,}\b(\s+[^\sa-z]*\b[A-Z]{3,}\b)+/);
  expect(alt, 'no page counter').not.toMatch(/\b1 \/ 5\b/);
  expect(alt, 'no repeated brand footer').not.toMatch(/Oz Radio · AI enablement · Beginner demo/i);
  expect(alt.length).toBeLessThanOrEqual(251);
  expect(alt).toMatch(/[.!?…]$/);
  expect(alt).toContain('A quick, live look at how AI works');
  expect(alt, 'the eyebrow is sentence-cased').toMatch(/Oz radio · AI enablement · live demo\./i);
}

test.describe('R11 · slide alt text', () => {
  test('one run per line (the new public payload)', async ({ page }) => {
    expectReadable(await altOf(page, LINES));
  });

  test('the one-line payload already served and cached in production', async ({ page }) => {
    expectReadable(await altOf(page, COLLAPSED));
  });
});

// ── R12 · the language of a recording title ──────────────────────────────────────────────────────────────

test.describe('R12 · a French recording title inside the English link', () => {
  test('the pre-start link marks the title as French', async ({ page }) => {
    await mock(page);
    await page.goto(FR_PATH);
    const link = page.getByTestId('demo-prestart-recording');
    await expect(link).toBeVisible();
    await expect(link).toContainText('Watch');
    const title = link.locator('span[lang]');
    await expect(title).toHaveAttribute('lang', 'fr');
    await expect(title).toHaveText('L’IA en trois minutes · Démo enregistrée');
    await expect(link).toHaveText(/with captions$/);
  });

  test('the outcome card button marks the title as French too', async ({ page }) => {
    await mock(page);
    await refuseDemoHandshake(page, { afterMs: 80 });
    await mockDemoSocket(page, { slideCount: 5, sessionSeconds: 300, idleCloseMs: false });
    await page.goto(FR_PATH);
    await page.getByTestId('demo-start').click();
    const button = page.getByTestId('demo-outcome').getByTestId('demo-outcome-recording');
    await expect(button).toBeVisible();
    await expect(button.locator('span[lang="fr"]')).toHaveText('L’IA en trois minutes · Démo enregistrée');
    await expect(button).toContainText('Watch');
  });
});

// ── R13 · the deck header ────────────────────────────────────────────────────────────────────────────────

test.describe('R13 · deck header', () => {
  test.use({ isMobile: true, hasTouch: true, viewport: { width: 412, height: 839 } });

  test('the heading drops the "Live demo" its kicker already says (the tab keeps the full title)', async ({ page }) => {
    await mock(page);
    await page.goto(EN_PATH);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('AI in three minutes');
    await expect(page.locator('.page-header .eyebrow')).toHaveText('Live demo · 5 slides · English');
    await expect(page).toHaveTitle('AI in three minutes · Live demo · Oz Radio');
  });

  test('the French suffix goes too', async ({ page }) => {
    await mock(page);
    await page.goto(FR_PATH);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('L’IA en trois minutes');
    await expect(page.locator('.page-header .eyebrow')).toHaveText('Live demo · 5 slides · Français');
  });

  test('a title with a "·" never wraps with the dot opening a line', async ({ page }) => {
    await mock(page);
    await page.route('**/api/decks/deck-plain', (route) => route.fulfill({
      json: {
        deck_id: 'deck-plain', id: 'deck-plain', title: 'Responsible AI for everyone in the company · Part two', filename: 'x',
        slide_count: 1, language: 'en-US', published: true, live_demo: false,
        slides: [{ index: 0, title: 'One', image_url: '', text: 'Body' }],
      },
    }));
    await page.goto('/decks/deck-plain/present');
    const h1 = page.getByRole('heading', { level: 1 });
    await expect(h1).toContainText('Part two');
    expect(await h1.evaluate((el) => el.textContent)).toContain('\u00a0· Part two');
    const startsWithDot = await h1.evaluate((el) => {
      const text = el.querySelector('span') ?? el;
      const range = document.createRange();
      const node = text.firstChild as Text;
      const lines = new Map<number, string>();
      for (let i = 0; i < node.length; i++) {
        range.setStart(node, i);
        range.setEnd(node, i + 1);
        const rects = range.getClientRects();
        if (!rects.length) continue;
        const top = Math.round(rects[0].top);
        lines.set(top, (lines.get(top) ?? '') + node.data[i]);
      }
      return [...lines.values()].some((l) => l.trim().startsWith('·'));
    });
    expect(startsWithDot).toBe(false);
  });

  test('while the deck loads there is one loading message, announced once', async ({ page }) => {
    await mock(page);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route('**/api/decks/deck-demo-en', async (route) => { await gate; await route.fallback(); });
    await page.goto(EN_PATH);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Loading deck…');
    const status = page.getByRole('status').filter({ hasText: /Loading/ });
    await expect(status).toHaveCount(1);
    const box = (await page.getByText('Loading slides…').boundingBox())!;
    expect(box.width, 'the spinner label is for screen readers only').toBeLessThanOrEqual(2);
    expect(await page.locator('main').evaluate((el) => (el.textContent ?? '').match(/Loading/g)?.length)).toBe(2);
    release();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('AI in three minutes');
    await expect(page.getByText('Loading slides…')).toHaveCount(0);
  });
});
