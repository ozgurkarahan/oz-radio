/**
 * WU-D — the live demo for anonymous visitors (deck page + avatar rail), mocked: no backend, no real WebRTC.
 *
 *  - the server side is `mockDemoSocket` (protocol v2, the executable contract of fleet/contracts.md §4);
 *  - the avatar's media is the dev-build seam `window.__ozRadioTest` (`demoHooks`): connected, TURN events, audio level,
 *    ICE state; long waits (15 s setup, 20 s ICE, 8 s reconnect, 60 s / 20 s warnings) run on `page.clock`;
 *  - every failure-matrix row of unit D is a test whose title starts with its `[ID]`: T2-13, T3-01 … T3-14, T3-08b,
 *    T3-11 and T3-Q01 … T3-Q14. The other tests cover the criteria C3.1 (two taps from Home to the first narration
 *    request, progress within a second), C3.4 (captions in sync), the countdown warnings (P1-5), captions for screen
 *    readers (P1-1), the audio element, ICE offer timing, the typed question, the v1-server degradation and the
 *    replacements for the demo block of regression.spec.ts.
 *
 * Phone tests emulate a Pixel 7 inside the chromium project (the mobile-chromium project does not match this file) and
 * take viewport screenshots only (`fullPage` drops touch emulation).
 */
import { devices, expect, test, type Page, type TestInfo } from '@playwright/test';
import { DEMO_DECK_EN, DEMO_QA_CONFIG, calls, mockApi, mockBoot, type MockApi, type MockApiOptions } from './support/mock-api';
import {
  SERVER_QA_ERRORS, demoHooks, mockDemoSocket, refuseDemoHandshake, type DemoSocketMock, type DemoSocketOptions,
} from './support/demo-ws-fixtures';
import {
  DEMO_CLOSE_CODES as CLOSE, DEMO_FALLBACK_LINKS, DEMO_OUTCOME_COPY as COPY, DEMO_QA_LIMIT_MESSAGES, DEMO_SERVICE_ERROR_DETAIL,
  DEMO_SWITCHED_OFF_DETAIL, DEMO_TIMING, DEMO_WARN_AT_SECONDS,
} from '../demos/frontend/src/services/demoProtocol';
import {
  ICE_PREFERRED_SETTLE_MS, ICE_WAIT_FOR_GATHERING, IceOfferPlanner, classifyIceCandidate,
} from '../demos/frontend/src/services/demoIce';
import { CaptionPacer, splitSentences, type CaptionView } from '../demos/frontend/src/services/demoCaptions';

test.describe.configure({ timeout: 90_000 });

// A fake microphone (Chromium's synthetic device) so the voice-question capture really starts; no real audio is
// recorded. Browser launch options cannot be set per describe, so the whole file runs with it.
test.use({
  permissions: ['microphone'],
  launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] },
});

const DECK_PATH = '/decks/deck-demo-en/present';
const SLIDES = DEMO_DECK_EN.slide_count;
/** The same-deck recording every ending offers (mock catalog `demo`: video `vid-demo-en`, 192 s). */
const RECORDING = { label: 'Watch AI in three minutes · Live demo · English · 3:12', href: '/video/library?video=vid-demo-en' };

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────────────────

interface OpenOptions {
  /** Slides of the deck AND of the mock server (default 5, the demo deck). A shorter deck makes the narration quick. */
  slides?: number;
  socket?: DemoSocketOptions;
  api?: MockApiOptions;
  path?: string;
  /** The demo socket never opens (1006), after N ms. */
  refuse?: number | boolean;
  /** `page.clock.install()` before the page loads: long waits run on `clock.runFor`. */
  clock?: boolean;
  /** Wait for the Start control (default true). */
  waitStart?: boolean;
  /** Runs after the mocks are registered and before the page loads (set up `api`, add init scripts that wrap the socket…). */
  before?: (run: Run) => Promise<void> | void;
}

interface Run { api: MockApi; mock: DemoSocketMock; errors: string[] }

const slimDeck = (slides: number) => ({
  ...DEMO_DECK_EN,
  id: DEMO_DECK_EN.deck_id,
  filename: DEMO_DECK_EN.title,
  slide_count: slides,
  slides: Array.from({ length: slides }, (_, i) => ({ index: i, title: `Slide ${i + 1}`, image_url: '', text: `Text of slide ${i + 1}` })),
});

async function open(page: Page, o: OpenOptions = {}): Promise<Run> {
  const slides = o.slides ?? SLIDES;
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  if (o.clock) await page.clock.install();
  const api = await mockApi(page, 'visitor', { catalog: 'demo', demoQa: DEMO_QA_CONFIG, demoSessionSeconds: 300, ...o.api });
  if (slides !== SLIDES) await page.route('**/api/decks/deck-demo-en', (route) => route.fulfill({ json: slimDeck(slides) }));
  if (o.refuse) await refuseDemoHandshake(page, typeof o.refuse === 'number' ? { afterMs: o.refuse } : {});
  const mock = await mockDemoSocket(page, {
    slideCount: slides, sessionSeconds: o.api?.demoSessionSeconds ?? 300, idleCloseMs: false, ...o.socket,
  });
  const run: Run = { api, mock, errors };
  await o.before?.(run);
  await page.goto(o.path ?? DECK_PATH);
  if (o.waitStart !== false) await expect(page.getByTestId('demo-start')).toBeVisible({ timeout: 30_000 });
  return run;
}

/** Taps Start and waits for the socket. */
async function tapStart(page: Page, mock: DemoSocketMock) {
  await page.getByTestId('demo-start').click();
  await expect.poll(() => mock.connections).toBe(1);
}

/** Start + the avatar's media comes up: the presentation starts by itself. */
async function connect(page: Page, mock: DemoSocketMock) {
  await tapStart(page, mock);
  await demoHooks.connected(page);
}

/** The first `count` spoken turns play to their end, one after the other. */
async function endTurns(page: Page, mock: DemoSocketMock, count: number, from = 1) {
  for (let i = from; i < from + count; i += 1) {
    await expect.poll(() => mock.items.length, { timeout: 20_000 }).toBeGreaterThanOrEqual(i);
    await demoHooks.finishTurn(page, mock.items[i - 1]);
  }
}

/** Connects and lets every slide play to its end: the "presentation is complete" card is up. */
async function reachNarrationDone(page: Page, mock: DemoSocketMock, slides: number) {
  await connect(page, mock);
  await endTurns(page, mock, slides);
  await expect(page.getByTestId('demo-narration-done')).toBeVisible({ timeout: 20_000 });
}

/** The page's own clock (the fake one under `page.clock`). */
const pageNow = (page: Page) => page.evaluate(() => Date.now());

/** Freezes the page's clock where it is: from now on time only moves with `page.clock.runFor`. */
async function freezeClock(page: Page) {
  // The clock keeps running while the request travels: ask for a moment a little ahead, a longer one if that is already past.
  for (let margin = 100; ; margin *= 4) {
    try {
      await page.clock.pauseAt(new Date((await pageNow(page)) + margin));
      return;
    } catch (error) {
      if (!/past/i.test(String(error)) || margin > 5000) throw error;
    }
  }
}

const card = (page: Page) => page.getByTestId('demo-outcome');

/** A viewport screenshot kept with the test output (never fullPage: it drops touch emulation on the phone). */
const shot = (page: Page, testInfo: TestInfo, name: string) => page.screenshot({ path: testInfo.outputPath(`${name}.png`) });

/** The outcome card of an ending: in view, focused, with the role its kind asks for, the cause and the recording. */
async function expectOutcome(page: Page, kind: string, title: string, role: 'alert' | 'status', opts: { recording?: boolean } = {}) {
  const c = card(page);
  await expect(c).toBeVisible();
  await expect(c).toHaveAttribute('data-outcome', kind);
  await expect(c).toHaveAttribute('role', role);
  await expect(c.getByTestId('demo-outcome-title')).toHaveText(title);
  await expect(c).toBeInViewport();
  await expect(c).toBeFocused();
  if (opts.recording !== false) {
    const link = c.getByTestId('demo-outcome-recording');
    await expect(link).toHaveText(RECORDING.label);
    await expect(link).toHaveAttribute('href', RECORDING.href);
  }
  return c;
}

/** Records every non-empty text the nodes with these test ids ever had, with the page's clock, plus the last click time. */
async function trackTexts(page: Page, ids: string[]) {
  await page.addInitScript((testIds) => {
    const w = window as any;
    const seen: Record<string, { text: string; at: number }[]> = Object.fromEntries(testIds.map((id) => [id, []]));
    w.__texts = seen;
    document.addEventListener('click', () => { w.__clickAt = performance.now(); }, true);
    const sample = () => {
      for (const id of testIds) {
        const el = document.querySelector(`[data-testid="${id}"]`);
        const text = el ? (el.textContent ?? '').trim() : '';
        const list = seen[id];
        if (text && (list.length === 0 || list[list.length - 1].text !== text)) list.push({ text, at: performance.now() });
      }
    };
    new MutationObserver(sample).observe(document, { subtree: true, childList: true, characterData: true });
  }, ids);
}

const textsOf = (page: Page, id: string) => page.evaluate((key) => ((window as any).__texts[key] as { text: string }[]).map((e) => e.text), id);

/** Wraps `HTMLMediaElement.play`: logs every call, and rejects audio plays (NotAllowedError) while `window.__blockAudio`. */
async function trackAudio(page: Page) {
  await page.addInitScript(() => {
    const w = window as any;
    w.__plays = [] as unknown[];
    w.__blockAudio = false;
    const native = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function play(this: HTMLMediaElement) {
      w.__plays.push({
        tag: this.tagName, active: navigator.userActivation?.isActive === true, hasStream: !!this.srcObject, muted: this.muted,
      });
      if (this.tagName === 'AUDIO') {
        // The mocked media has no stream: stand in for the browser's answer.
        return w.__blockAudio
          ? Promise.reject(new DOMException('play() failed because the user did not interact with the document first.', 'NotAllowedError'))
          : Promise.resolve();
      }
      return native.call(this);
    };
  });
}

/** Keeps the live `WebSocket` of the demo reachable (`window.__demoWs`) so a spec can inject a close the server cannot send. */
async function recordDemoSocket(page: Page) {
  await page.addInitScript(() => {
    const Native = window.WebSocket;
    const Recording = function Recording(this: unknown, url: string | URL, protocols?: string | string[]) {
      const ws = new Native(url, protocols);
      if (String(url).includes('/ws/voice/demo')) (window as any).__demoWs = ws;
      return ws;
    } as unknown as typeof WebSocket;
    Recording.prototype = Native.prototype;
    Object.assign(Recording, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
    window.WebSocket = Recording;
  });
}

// ── 1. Start: one tap, no scroll, plain words (C3.1) ─────────────────────────────────────────────────────

test.describe('start flow (C3.1)', () => {
  test('[C3.1] the page never starts by itself, Start has focus on arrival, one tap connects and presents every slide', async ({ page }, testInfo) => {
    const { mock, errors } = await open(page);
    const start = page.getByTestId('demo-start');
    await expect(start).toBeFocused();
    await expect(start, 'Start is on the first screen of a 1280×720 window').toBeInViewport({ ratio: 1 });
    await shot(page, testInfo, 'desktop-start');
    await expect(start).toHaveText('Start the live demo');
    await expect(start).toBeEnabled();
    await page.waitForTimeout(1500);
    expect(mock.connections, 'nothing starts before the visitor taps').toBe(0);
    // Visitors have exactly one way to start: no admin controls, no per-slide controls, no file name.
    for (const name of [/present all/i, /present this slide/i, /connect avatar/i, /speak slide/i, /disconnect/i]) {
      await expect(page.getByRole('button', { name })).toHaveCount(0);
    }
    await start.click();
    await expect.poll(() => mock.connections).toBe(1);
    await demoHooks.connected(page);
    for (let i = 0; i < SLIDES; i += 1) {
      await mock.waitForSent('demo.speak', i + 1);
      await expect.poll(() => mock.items.length).toBe(i + 1);
      await demoHooks.finishLastTurn(page, mock);
    }
    await expect(page.getByTestId('demo-narration-done')).toBeVisible();
    expect(mock.ofType('demo.speak').map((m) => m.slide), 'every slide once, in order, without another tap').toEqual([0, 1, 2, 3, 4]);
    expect(errors).toEqual([]);
  });

  test('[C3.1] progress shows within a second of the tap, in plain words (never the services behind the avatar)', async ({ page }) => {
    await trackTexts(page, ['demo-status']);
    const { mock } = await open(page);
    await tapStart(page, mock);
    await expect(page.getByTestId('demo-status')).toHaveText('The presenter is getting ready…');
    const seen = await page.evaluate(() => {
      const w = window as any;
      return { texts: (w.__texts['demo-status'] as { text: string; at: number }[]), clickAt: w.__clickAt as number };
    });
    expect(seen.texts[0].text).toBe('Starting the avatar…');
    expect(seen.texts[0].at - seen.clickAt, 'first progress text, ms after the tap').toBeLessThan(1000);
    for (const { text } of seen.texts) expect(text).not.toMatch(/azure|voice api|video connection|setting up|websocket/i);
    await expect(page.getByTestId('demo-start')).toHaveText('Starting…');
    await expect(page.getByTestId('demo-start')).toBeDisabled();
  });

  test('[C3.1] the visitor sees the deck title, never an uploaded file name, and the tab is named after the deck', async ({ page }) => {
    await open(page);
    await expect(page).toHaveTitle('AI in three minutes · Live demo · Oz Radio');
    await expect(page.locator('.slide-viewer__file')).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('AI in three minutes · Live demo');
    await expect(page.locator('.avatar-rail')).not.toContainText(/azure|voice api|\.pptx/i);
    await expect(page.getByTestId('live-demo-available')).toBeVisible();
  });
});

// ── 2. The avatar's voice: a persistent <audio> unlocked by the Start tap (T3-10) ────────────────────────────

test.describe('demo config at first paint, and the file name', () => {
  const source = { catalog: 'demo' as const, demoQa: DEMO_QA_CONFIG, demoSessionSeconds: 120 };
  const configCalls = () => calls.filter((c) => c.path === '/api/demo/config');

  test('with a boot block the deck page needs no request for the demo config: Start is there at first paint and the boot\'s cap is used', async ({ page }) => {
    const { mock } = await open(page, {
      api: { demoSessionSeconds: 120 },
      socket: { sessionSeconds: 120 },
      before: async () => { await mockBoot(page, {}, source); },
    });
    await expect(page.getByTestId('demo-start')).toBeVisible();
    expect(configCalls(), 'the boot block carries what the page needs').toHaveLength(0);
    await expect(page.locator('.avatar-rail')).toContainText('up to 2 minutes');
    await tapStart(page, mock);
    await expect(page.getByTestId('demo-time-left')).toHaveText(/^Demo time left (2:00|1:59)$/);
  });

  test('without a boot block the deck page asks for the demo config itself — it never relies on a cache warmed by Home', async ({ page }) => {
    await open(page, { api: { demoSessionSeconds: 120 } });
    expect(configCalls()).toHaveLength(1);
    await expect(page.locator('.avatar-rail')).toContainText('up to 2 minutes');
  });

  test('[C3.1] the owner still sees the file name above the slide; a visitor never does', async ({ page }) => {
    await open(page);
    await expect(page.locator('.slide-viewer__file')).toHaveCount(0);
    await expect(page.locator('.slide-viewer')).not.toContainText('.pptx');
    const owner = await page.context().newPage();
    await mockApi(owner, 'admin');
    await owner.goto('/decks/deck-live/present');
    await expect(owner.locator('.slide-viewer__file')).toHaveText('ai-fundamentals.pptx');
  });
});

// ── 2b. The avatar's voice: a persistent <audio> unlocked by the Start tap (T3-10) ───────────────────────────

test.describe('audio', () => {
  test('[C3.1] the voice is one persistent <audio playsInline>; play() runs inside the Start tap, with user activation', async ({ page }) => {
    await trackAudio(page);
    const { mock } = await open(page);
    await expect(page.locator('audio')).toHaveCount(1);
    await expect(page.locator('audio')).toHaveAttribute('playsinline', '');
    await page.evaluate(() => { (window as any).__voice = document.querySelector('audio'); });
    expect(await page.evaluate(() => (window as any).__plays.length), 'nothing plays before the tap').toBe(0);
    await tapStart(page, mock);
    const first = await page.evaluate(() => (window as any).__plays[0]);
    expect(first, 'the tap banks the permission on the voice element').toMatchObject({ tag: 'AUDIO', active: true, hasStream: false });
    await demoHooks.connected(page);
    expect(await page.evaluate(() => (window as any).__plays.filter((p: { tag: string }) => p.tag === 'AUDIO').length), 'plays again when the track arrives').toBeGreaterThanOrEqual(2);
    // never re-created: the same element all session
    await expect(page.locator('audio')).toHaveCount(1);
    expect(await page.evaluate(() => (window as any).__voice === document.querySelector('audio'))).toBe(true);
  });

  test('[T3-10] sound blocked by the browser: the avatar is not "Speaking", the cause and "Tap to turn sound on" are shown, captions still run', async ({ page }) => {
    await trackAudio(page);
    const { mock } = await open(page);
    await page.evaluate(() => { (window as any).__blockAudio = true; });
    await connect(page, mock);
    const notice = page.getByTestId('demo-sound-blocked');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('Sound is blocked or muted');
    await expect(notice).toHaveAttribute('role', 'status');
    const turnOn = page.getByTestId('demo-sound-on');
    await expect(turnOn).toHaveText('Tap to turn sound on');
    await expect.poll(() => mock.items.length).toBe(1);
    await demoHooks.startTurn(page, mock.items[0]);
    const pill = page.locator('.avatar-rail__live .live-pill');
    await expect(pill, 'never claims "Speaking" when nothing can be heard').toHaveText('Sound off');
    await expect(page.getByTestId('live-captions-text'), 'the narration is readable regardless').not.toHaveText('');
    await page.evaluate(() => { (window as any).__blockAudio = false; });
    await turnOn.click();
    await expect(notice).toHaveCount(0);
    await expect(pill).toHaveText('Speaking');
  });

  test('[T3-10] a muted voice element while the stream is attached is reported too, and one tap turns the sound on', async ({ page }) => {
    await trackAudio(page);
    const { mock } = await open(page);
    await connect(page, mock);
    const notice = page.getByTestId('demo-sound-blocked');
    await expect(notice).toHaveCount(0);
    await page.evaluate(() => {
      const el = document.querySelector('audio') as HTMLAudioElement;
      Object.defineProperty(el, 'paused', { get: () => false, configurable: true }); // the stand-in play() does not really play
      el.srcObject = new MediaStream();
      el.muted = true;
    });
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('Sound is blocked or muted');
    await page.getByTestId('demo-sound-on').click();
    await expect(notice).toHaveCount(0);
    expect(await page.locator('audio').evaluate((el: HTMLAudioElement) => el.muted)).toBe(false);
  });
});

// ── 3. Captions in sync with the avatar's audio (C3.4, P1-1) ──────────────────────────────────────────────

/** Words of a mock turn whose timestamp is due `elapsedMs` into its audio. */
const wordsDue = (words: { offsetMs: number }[], elapsedMs: number) => words.filter((w) => w.offsetMs <= elapsedMs).length;

test.describe('captions (C3.4, P1-1)', () => {
  test('[C3.4] captions are revealed at the avatar\'s pace, word by word, from the mock\'s word offsets — not when the text arrives', async ({ page }, testInfo) => {
    const { mock } = await open(page, { clock: true });
    await connect(page, mock);
    await expect.poll(() => mock.items.length).toBe(1);
    const turn = mock.turns[0];
    const box = page.getByTestId('live-captions-text');
    // The server has already sent the whole text and response.done; the avatar has not said a word yet.
    await expect(box).toHaveText('');
    await freezeClock(page);
    await demoHooks.startTurn(page, mock.items[0]);
    await expect(box).toHaveText(turn.words[0].text);
    expect(wordsDue(turn.words, 0)).toBe(1);
    // The pacer is ticked every 50 ms, so the revealed text is the one due somewhere in (target − 50, target]: targets sit
    // clear of the word offsets (0, 350, 700, 1050 …).
    let elapsed = 0;
    for (const target of [500, 900, 1500, 3300]) {
      await page.clock.runFor(target - elapsed);
      elapsed = target;
      const due = wordsDue(turn.words, target);
      await expect(box, `words after ${target} ms`).toHaveText(turn.words.slice(0, due).map((w) => w.text).join(' '));
      if (target === 1500) {
        await expect(box, 'the captions are on the first screen of a 1280×720 window').toBeInViewport({ ratio: 1 });
        await shot(page, testInfo, 'desktop-captions');
      }
    }
    await expect(box).not.toHaveAttribute('data-complete', 'true');
    // The turn ends (TURN_END, then 700 ms of silence): the final text is whole and complete.
    await demoHooks.finishLastTurn(page, mock);
    await page.clock.runFor(1000);
    await expect(box).toHaveText(turn.text);
    await expect(box).toHaveAttribute('data-complete', 'true');
    await expect(box).toHaveAttribute('data-kind', 'narration');
    await expect(box).toHaveAttribute('data-slide', '0');
  });

  test('[P1-1] the caption box is not a live region; a separate hidden polite region announces whole sentences once each', async ({ page }) => {
    await trackTexts(page, ['live-captions-announce']);
    const { mock } = await open(page, { slides: 1, clock: true });
    await connect(page, mock);
    await expect.poll(() => mock.items.length).toBe(1);
    const group = page.getByTestId('live-captions');
    const box = page.getByTestId('live-captions-text');
    const announce = page.getByTestId('live-captions-announce');
    await expect(group).not.toHaveAttribute('aria-live', /.*/);
    await expect(box).not.toHaveAttribute('aria-live', /.*/);
    await expect(box).not.toHaveAttribute('role', /.*/);
    await expect(announce).toHaveAttribute('aria-live', 'polite');
    await expect(announce).toHaveClass(/sr-only/);
    expect(await group.getAttribute('lang')).toBe('en');
    await freezeClock(page);
    await demoHooks.startTurn(page, mock.items[0]);
    // The first sentence is whole at "demo." (1750 ms), the second at "ideas." (3500 ms): nothing is announced word by word.
    await page.clock.runFor(1500);
    await expect(announce).toHaveText('');
    await page.clock.runFor(500);
    await expect(announce).toHaveText('Welcome to this short live demo.');
    await page.clock.runFor(1700);
    await expect(announce).toHaveText('I will explain three ideas.');
    await demoHooks.finishLastTurn(page, mock);
    await expect(box).toHaveText(mock.turns[0].text);
    expect(await textsOf(page, 'live-captions-announce'), 'whole sentences, in order, once each').toEqual([
      'Welcome to this short live demo.',
      'I will explain three ideas.',
    ]);
  });

  test('[C3.4] a cancelled turn clears its captions', async ({ page }) => {
    const { mock } = await open(page, { slides: 1, clock: true });
    await connect(page, mock);
    await expect.poll(() => mock.items.length).toBe(1);
    await freezeClock(page);
    await demoHooks.startTurn(page, mock.items[0]);
    await page.clock.runFor(1200);
    const box = page.getByTestId('live-captions-text');
    await expect(box).not.toHaveText('');
    mock.send({ type: 'response.done', response: { id: mock.turns[0].responseId, status: 'cancelled' } });
    await expect(box).toHaveText('');
  });

  test('[C3.4] a French deck captions in French and the box says so (lang)', async ({ page }) => {
    const { mock } = await open(page, { path: '/decks/deck-demo-fr/present', slides: SLIDES, socket: { language: 'fr-FR' } });
    await connect(page, mock);
    await expect.poll(() => mock.items.length).toBe(1);
    await expect(page.getByTestId('live-captions')).toHaveAttribute('lang', 'fr');
    await demoHooks.startTurn(page, mock.items[0]);
    await demoHooks.finishLastTurn(page, mock);
    await expect(page.getByTestId('live-captions-text')).toHaveText(mock.turns[0].text);
  });
});

// ── 4. Countdown (P1-5) and the replacement of the regression test ───────────────────────────────────────────

const secondsOf = async (page: Page) => {
  const text = (await page.getByTestId('demo-time-left').textContent()) ?? '';
  const m = /(\d+):(\d\d)$/.exec(text);
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
};

test.describe('countdown (P1-5)', () => {
  test('[P1-5] the time left is visible; 60 s and 20 s are announced once each in a polite status region', async ({ page }) => {
    await trackTexts(page, ['demo-time-warning']);
    // No word timestamps: nothing finishes the turn by itself, so the server sends no new remaining_ms while the clock runs.
    const { mock } = await open(page, { clock: true, api: { demoSessionSeconds: 90 }, socket: { wordTimestamps: false } });
    await connect(page, mock);
    await mock.waitForSent('demo.speak');
    const left = page.getByTestId('demo-time-left');
    const warning = page.getByTestId('demo-time-warning');
    await expect(left).toBeVisible();
    await expect(warning).toHaveAttribute('role', 'status');
    await expect(warning).toHaveAttribute('aria-live', 'polite');
    await expect(left, 'the per-second countdown is never a live region').not.toHaveAttribute('aria-live', /.*/);
    mock.send({ type: 'demo.speaking', slide: 0, chars: 62, remaining: 9, remaining_ms: 90_000 });
    await expect.poll(() => secondsOf(page)).toBeGreaterThanOrEqual(89);
    await freezeClock(page);
    await page.clock.runFor(25_000);
    expect(await secondsOf(page)).toBeGreaterThan(60);
    await expect(warning).toHaveText('');
    await page.clock.runFor(7000);
    await expect(warning).toHaveText('1 minute left in the live demo');
    await page.clock.runFor(30_000);
    expect(await secondsOf(page)).toBeGreaterThan(20);
    await expect(warning, 'announced once, not every second').toHaveText('1 minute left in the live demo');
    await page.clock.runFor(10_000);
    await expect(warning).toHaveText('20 seconds left in the live demo');
    await page.clock.runFor(10_000);
    expect(await secondsOf(page)).toBeLessThan(20);
    expect(await textsOf(page, 'demo-time-warning')).toEqual(['1 minute left in the live demo', '20 seconds left in the live demo']);
    expect(DEMO_WARN_AT_SECONDS).toEqual([60, 20]);
  });

  test('[P1-5] the server\'s remaining_ms is the truth: it moves the countdown and the warnings', async ({ page }) => {
    const { mock } = await open(page, { clock: true });
    await connect(page, mock);
    await mock.waitForSent('demo.speak');
    const warning = page.getByTestId('demo-time-warning');
    await expect.poll(() => secondsOf(page)).toBeGreaterThan(290);
    await expect(warning).toHaveText('');
    mock.send({ type: 'demo.speaking', slide: 0, chars: 62, remaining: 9, remaining_ms: 61_000 });
    await expect.poll(() => secondsOf(page)).toBeLessThanOrEqual(61);
    await freezeClock(page);
    await page.clock.runFor(3000);
    await expect(warning).toHaveText('1 minute left in the live demo');
    await expect(page.getByTestId('demo-time-left')).toHaveText(/^Demo time left 0:5\d$/);
  });

  test('[T3-14] the countdown starts at the full session length when the socket opens and ticks down (replaces regression.spec.ts L294–321)', async ({ page }) => {
    const { mock } = await open(page, { clock: true, api: { demoSessionSeconds: 180 }, socket: { onOpen: 'silent' } });
    await tapStart(page, mock);
    const left = page.getByTestId('demo-time-left');
    await expect(left).toHaveText(/^Demo time left (3:00|2:59)$/);
    // Inside the 15 s setup window, whatever the load of the machine: a few seconds on the fake clock, a few seconds off the display.
    await page.clock.runFor(1000);
    expect(await secondsOf(page)).toBeLessThanOrEqual(180);
    expect(await secondsOf(page)).toBeGreaterThanOrEqual(172);
    await page.clock.runFor(8000);
    expect(await secondsOf(page), 'nine seconds on').toBeGreaterThanOrEqual(163);
    expect(await secondsOf(page)).toBeLessThanOrEqual(171);
    await expect(left).toHaveText(/^Demo time left 2:[4-5]\d$/);
  });
  test('[T3-14] regression.spec.ts L294–321, ported: a silent socket counts down exactly, and the 15 s setup limit ends it', async ({ page }) => {
    await page.clock.install();
    // Stub only the demo socket: it opens and stays silent (avatar still connecting).
    await page.addInitScript(() => {
      const Native = window.WebSocket;
      class FakeDemoSocket extends EventTarget {
        readyState = 0;
        onopen: ((e: Event) => void) | null = null;
        onmessage: ((e: MessageEvent) => void) | null = null;
        onclose: ((e: CloseEvent) => void) | null = null;
        onerror: ((e: Event) => void) | null = null;
        constructor(public url: string) {
          super();
          setTimeout(() => { this.readyState = 1; this.onopen?.(new Event('open')); }, 10);
        }
        send() {}
        close() { this.readyState = 3; }
      }
      (window as any).WebSocket = function (url: string, protocols?: string | string[]) {
        return String(url).includes('/ws/voice/demo') ? new FakeDemoSocket(url) : new Native(url, protocols);
      };
    });
    await mockApi(page, 'visitor');
    await page.goto('/decks/deck-live/present');
    await page.getByTestId('demo-start').click();
    await page.clock.runFor(50);
    const left = page.getByTestId('demo-time-left');
    await expect(left).toHaveText('Demo time left 3:00');
    await page.clock.runFor(1000);
    await expect(left).toHaveText('Demo time left 2:59');
    // The old test ran 60 s on a silent socket; the avatar service now gets 15 s (DEMO_TIMING.setupTimeoutMs) to answer.
    await page.clock.runFor(9000);
    await expect(left).toHaveText('Demo time left 2:50');
    await page.clock.runFor(DEMO_TIMING.setupTimeoutMs - 10_000 + 500);
    await expect(card(page)).toHaveAttribute('data-outcome', 'connect');
    await expect(left).toHaveCount(0);
  });
});

// ── 5. How a live session ends: the outcome card (T3-02 … T3-07) ─────────────────────────────────────────────

test.describe('outcome card', () => {
  test('[T3-02] busy (1013): the cause, the recording and "Try again in a minute"; the retry opens a new session', async ({ page }, testInfo) => {
    const { mock } = await open(page, { socket: { onOpen: { close: CLOSE.BUSY } } });
    await tapStart(page, mock);
    const c = await expectOutcome(page, 'busy', COPY.busy.title, 'alert');
    await shot(page, testInfo, 'desktop-busy');
    await expect(c.getByTestId('demo-outcome-detail')).toHaveText(COPY.busy.detail);
    await expect(c).not.toContainText(/demo avatar is busy, try again in a minute|not available for this deck/i);
    const retry = c.getByTestId('demo-outcome-retry');
    await expect(retry).toHaveText('Try again in a minute');
    await expect(page.getByTestId('demo-start')).toBeEnabled();
    mock.options.onOpen = 'session';
    await retry.click();
    await expect.poll(() => mock.connections).toBe(2);
    await expect(card(page), 'a new attempt clears the card').toHaveCount(0);
    await expect(page.getByTestId('demo-status')).toHaveText(/The presenter is getting ready…|Starting the avatar…/);
  });

  test('[T3-03] daily limit (4429): the cause and the recording, no retry, Start stays disabled with the reason', async ({ page }) => {
    const { mock } = await open(page, { socket: { onOpen: { close: CLOSE.DAILY_QUOTA } } });
    await tapStart(page, mock);
    const c = await expectOutcome(page, 'quota', COPY.quota.title, 'alert');
    await expect(c.getByTestId('demo-outcome-detail')).toHaveText(COPY.quota.detail);
    await expect(c.getByTestId('demo-outcome-retry')).toHaveCount(0);
    const start = page.getByTestId('demo-start');
    await expect(start).toBeDisabled();
    await expect(page.getByTestId('demo-start-reason')).toContainText(/Today.s live allowance has been reached/);
    await expect(start).toHaveAttribute('aria-describedby', /.+/);
    expect(mock.connections, 'a disabled Start opens nothing').toBe(1);
    await expect(page.getByTestId('demo-start-reason')).toBeVisible();
  });

  test('[T3-04] the session cap (4408): "Your live session has ended" + the recording; the slide stays; the countdown is gone', async ({ page }) => {
    const { mock } = await open(page, { socket: { closeAt: { code: CLOSE.TIME_CAP, on: 'first-speak' } } });
    await page.getByTestId('slide-next').click();
    await connect(page, mock);
    const c = await expectOutcome(page, 'cap', COPY.cap.title, 'status');
    await expect(c.getByTestId('demo-outcome-detail')).toHaveText(COPY.cap.detail);
    await expect(c.getByTestId('demo-outcome-retry')).toHaveCount(0);
    await expect(page.getByTestId('slide-counter')).toContainText(`Slide 2 of ${SLIDES}`);
    await expect(page.getByTestId('demo-time-left')).toHaveCount(0);
    await expect(page.getByTestId('demo-start')).toBeEnabled();
    await expect(page.locator('.avatar-rail')).not.toContainText('Demo time limit reached');
  });

  test('[T3-05] the handshake is refused (1006): "Couldn\'t connect" + "Try again" + the recording, never "not available for this deck"', async ({ page }) => {
    const { mock } = await open(page, { refuse: 80 });
    await page.getByTestId('demo-start').click();
    const c = await expectOutcome(page, 'connect', COPY.connect.title, 'alert');
    await expect(c.getByTestId('demo-outcome-detail')).toHaveText(COPY.connect.detail);
    await expect(c.getByTestId('demo-outcome-retry')).toHaveText('Try again');
    await expect(page.locator('.avatar-rail')).not.toContainText(/not available for this deck/i);
    expect(mock.connections).toBe(0);
    await expect(page.getByTestId('demo-start')).toBeEnabled();
  });

  test('[T3-05] a refused handshake while the demo is switched off says so (config re-checked), with no retry', async ({ page }) => {
    const { api } = await open(page, { refuse: 80 });
    api.demo.enabled = false;
    await page.getByTestId('demo-start').click();
    const c = card(page);
    await expect(c).toHaveAttribute('data-outcome', 'outage');
    await expect(c.getByTestId('demo-outcome-detail')).toHaveText(DEMO_SWITCHED_OFF_DETAIL);
    await expect(c.getByTestId('demo-outcome-retry')).toHaveCount(0);
    await expect(c.getByTestId('demo-outcome-recording')).toHaveAttribute('href', RECORDING.href);
  });

  for (const row of [
    { code: CLOSE.SESSION_ERROR, label: '1011 session error', kind: 'outage' as const },
    { code: CLOSE.RESTART, label: '1012 service restart', kind: 'outage' as const },
    { code: CLOSE.NORMAL, label: 'a bare 1000 after the session opened', kind: 'ended' as const },
  ]) {
    test(`[T3-06] ${row.label}: ${COPY[row.kind].title}${COPY[row.kind].retry === 'none' ? '' : ' + "Try again"'} + the recording`, async ({ page }) => {
      const { mock } = await open(page, { socket: { onOpen: { close: row.code } } });
      await tapStart(page, mock);
      const c = await expectOutcome(page, row.kind, COPY[row.kind].title, COPY[row.kind].role);
      await expect(c.getByTestId('demo-outcome-detail')).toHaveText(COPY[row.kind].detail);
      if (COPY[row.kind].retry === 'none') await expect(c.getByTestId('demo-outcome-retry')).toHaveCount(0);
      else await expect(c.getByTestId('demo-outcome-retry')).toHaveText('Try again');
      await expect(page.getByTestId('demo-start')).toBeEnabled();
    });
  }

  test('[T3-06] the socket drops after it opened (1006): "The live connection was interrupted" + "Try again" + the recording', async ({ page }) => {
    const { mock } = await open(page, { before: () => recordDemoSocket(page) });
    await connect(page, mock);
    await mock.waitForSent('demo.speak');
    // The browser reports 1006 when the connection dies without a close frame; a server cannot send it.
    await page.evaluate(() => (window as any).__demoWs.dispatchEvent(new CloseEvent('close', { code: 1006, wasClean: false })));
    const c = await expectOutcome(page, 'interrupted', COPY.interrupted.title, 'alert');
    await expect(c.getByTestId('demo-outcome-retry')).toHaveText('Try again');
    await expect(page.getByTestId('live-captions')).toHaveCount(0);
    await expect(page.getByTestId('demo-start')).toBeEnabled();
  });

  test('[T3-07] the avatar service errors (error event, then 1011): "isn\'t responding", never "Azure", "Voice API" or the raw text', async ({ page }) => {
    const { mock } = await open(page, { socket: { onOpen: { error: 'Voice backend exploded at azure-speech-eastus', closeCode: CLOSE.SESSION_ERROR } } });
    await tapStart(page, mock);
    const c = await expectOutcome(page, 'outage', COPY.outage.title, 'alert');
    await expect(c.getByTestId('demo-outcome-detail')).toHaveText(DEMO_SERVICE_ERROR_DETAIL);
    await expect(c.getByTestId('demo-outcome-retry')).toHaveText('Try again');
    await expect(page.locator('.avatar-rail')).not.toContainText(/azure|voice api|exploded|avatar service unavailable/i);
  });

  test('[T3-07] today\'s bare 1000 close after an error event reads as a service error too', async ({ page }) => {
    const { mock } = await open(page, { socket: { onOpen: { error: 'boom', closeCode: CLOSE.NORMAL } } });
    await tapStart(page, mock);
    const c = await expectOutcome(page, 'outage', COPY.outage.title, 'alert');
    await expect(c.getByTestId('demo-outcome-detail')).toHaveText(DEMO_SERVICE_ERROR_DETAIL);
  });

  test('[F2] a quota-store outage (4503) is not "busy": "Live demo temporarily unavailable", no retry', async ({ page }) => {
    const { mock } = await open(page, { socket: { onOpen: { close: CLOSE.STORE_OUTAGE } } });
    await tapStart(page, mock);
    const c = await expectOutcome(page, 'outage', COPY.outage.title, 'alert');
    await expect(c).not.toContainText(/another visitor/i);
    await expect(c.getByTestId('demo-outcome-retry')).toHaveCount(0);
  });

  test('[F2] without a same-deck recording the public fallback links stand in, and the card never waits for the lists', async ({ page }) => {
    const { mock } = await open(page, { socket: { onOpen: { close: CLOSE.TIME_CAP } }, api: { libraryFailure: 503 } });
    await tapStart(page, mock);
    const c = card(page);
    await expect(c).toBeVisible();
    await expect(c.getByTestId('demo-outcome-recording')).toHaveCount(0);
    const fallbacks = c.getByTestId('demo-outcome-fallback');
    await expect(fallbacks).toHaveText(DEMO_FALLBACK_LINKS.map((l) => l.label));
    for (let i = 0; i < DEMO_FALLBACK_LINKS.length; i += 1) await expect(fallbacks.nth(i)).toHaveAttribute('href', DEMO_FALLBACK_LINKS[i].to);
  });

  test('[F2] slow recording lists never block the card: it appears at once, the recording joins it', async ({ page }) => {
    const { mock } = await open(page, { socket: { onOpen: { close: CLOSE.TIME_CAP } }, api: { delayMs: { video: 1500, podcast: 1500 } } });
    await tapStart(page, mock);
    await expect(card(page)).toBeVisible({ timeout: 1500 });
    await expect(card(page).getByTestId('demo-outcome-recording')).toHaveText(RECORDING.label, { timeout: 10_000 });
  });
});

// ── 6. The avatar never comes up, or its media breaks (T3-14, T3-08, T3-08b) ──────────────────────────────────

test.describe('setup and media failures', () => {
  test('[T3-14] the avatar service never answers: after 15 s the socket is closed (slot freed) and the card says "Couldn\'t connect"', async ({ page }) => {
    const { mock } = await open(page, { clock: true, socket: { onOpen: 'silent' } });
    await tapStart(page, mock);
    await expect(page.getByTestId('demo-status')).toHaveText('Starting the avatar…');
    await freezeClock(page);
    await page.clock.runFor(DEMO_TIMING.setupTimeoutMs - 5000);
    await expect(card(page)).toHaveCount(0);
    await page.clock.runFor(6000);
    const c = await expectOutcome(page, 'connect', COPY.connect.title, 'alert');
    await expect(c.getByTestId('demo-outcome-retry')).toHaveText('Try again');
    await expect(page.getByTestId('demo-time-left'), 'the countdown does not burn to the cap').toHaveCount(0);
    await expect.poll(() => mock.ofType('demo.finish').length, { message: 'the client asks the server to finish' }).toBe(1);
    await expect.poll(() => mock.closes, { message: 'the slot is freed' }).toEqual([{ code: CLOSE.FINISHED, reason: 'Demo finished' }]);
    await expect(page.getByTestId('demo-start')).toBeEnabled();
  });

  test('[T3-08] the network blocks the avatar stream (ICE never connects): the network hint + "Try again", the socket is closed, relay-only is kept', async ({ page }) => {
    await page.addInitScript(() => {
      const configs: RTCConfiguration[] = [];
      (window as any).__pcConfigs = configs;
      const Native = window.RTCPeerConnection;
      (window as any).RTCPeerConnection = class extends Native {
        constructor(cfg?: RTCConfiguration) { super(cfg); configs.push(cfg ?? {}); }
      };
    });
    const { mock } = await open(page, { clock: true, socket: { onOpen: 'ice' } });
    await tapStart(page, mock);
    await mock.waitForSent('session.avatar.connect');
    await expect(card(page)).toHaveCount(0);
    await page.clock.runFor(20_500);
    const c = await expectOutcome(page, 'connect', COPY.connect.title, 'alert');
    await expect(c.getByTestId('demo-outcome-detail')).toContainText(/network, a VPN or a security filter/i);
    await expect(c.getByTestId('demo-outcome-retry')).toHaveText('Try again');
    await expect.poll(() => mock.closes, { message: 'the slot is freed' }).toEqual([{ code: CLOSE.FINISHED, reason: 'Demo finished' }]);
    const configs = await page.evaluate(() => (window as any).__pcConfigs as RTCConfiguration[]);
    expect(configs[0].iceTransportPolicy).toBe('relay');
  });

  test('[T3-08b] the media drops mid-session: "Reconnecting…" for up to 8 s, then "The live connection was interrupted" — not "your network blocks the stream"', async ({ page }) => {
    const { mock } = await open(page, { clock: true });
    await connect(page, mock);
    await expect.poll(() => mock.items.length).toBe(1);
    await demoHooks.startTurn(page, mock.items[0]);
    const pill = page.locator('.avatar-rail__live .live-pill');
    await expect(pill).toHaveText('Speaking');
    await freezeClock(page);
    await page.evaluate(() => (window as any).__ozRadioTest.mediaState('disconnected'));
    await expect(page.getByTestId('demo-reconnecting')).toHaveText('Reconnecting…');
    await expect(pill, '"Speaking" is no longer claimed').toHaveText('Reconnecting…');
    await page.clock.runFor(7000);
    await expect(card(page)).toHaveCount(0);
    await page.clock.runFor(1500);
    const c = await expectOutcome(page, 'interrupted', COPY.interrupted.title, 'alert');
    await expect(c).not.toContainText(/blocks the avatar stream|VPN/i);
    await expect(c.getByTestId('demo-outcome-retry')).toHaveText('Try again');
    await expect(page.getByTestId('demo-reconnecting')).toHaveCount(0);
  });

  test('[T3-08b] a media link that comes back within 8 s carries on: no card, no "Reconnecting…"', async ({ page }) => {
    const { mock } = await open(page, { clock: true });
    await connect(page, mock);
    await freezeClock(page);
    await page.evaluate(() => (window as any).__ozRadioTest.mediaState('disconnected'));
    await expect(page.getByTestId('demo-reconnecting')).toBeVisible();
    await page.clock.runFor(4000);
    await page.evaluate(() => (window as any).__ozRadioTest.mediaState('connected'));
    await expect(page.getByTestId('demo-reconnecting')).toHaveCount(0);
    await page.clock.runFor(10_000);
    await expect(card(page)).toHaveCount(0);
    await expect(page.getByTestId('demo-stop')).toBeVisible();
  });
});

// ── 7. After the narration: ask, finish, or nothing (F2) ───────────────────────────────────────────────────

test.describe('after the narration (F2)', () => {
  test('[F2] after the last slide: "Ask a question" / "Finish demo" with the time left — no "Present all" again; Finish ends with the thank-you card (4001)', async ({ page }, testInfo) => {
    const { mock } = await open(page, { slides: 2 });
    await reachNarrationDone(page, mock, 2);
    await expect(page.getByTestId('demo-narration-done'), 'the choice is in view, not below the fold').toBeInViewport();
    await shot(page, testInfo, 'desktop-done');
    const done = page.getByTestId('demo-narration-done');
    await expect(done).toContainText('The presentation is complete');
    await expect(page.getByTestId('demo-done-time')).toHaveText(/^\d:\d\d left in this live session$/);
    await expect(page.getByTestId('demo-ask')).toHaveText('Ask a question');
    await expect(page.getByTestId('demo-finish')).toHaveText('Finish demo');
    for (const name of [/present all/i, /present this slide/i, /speak slide/i]) await expect(page.getByRole('button', { name })).toHaveCount(0);
    expect(mock.log.some((e) => e.dir === 'out' && e.type === 'demo.narration_complete')).toBe(true);
    await expect(page.getByTestId('demo-coverage-note'), 'no stale "This demo covers…" after the presentation').toHaveCount(0);
    await page.getByTestId('demo-finish').click();
    await mock.waitForSent('demo.finish');
    const c = await expectOutcome(page, 'finished', COPY.finished.title, 'status');
    await expect(c.getByTestId('demo-outcome-detail')).toHaveText(COPY.finished.detail);
    await expect(c.getByTestId('demo-outcome-retry')).toHaveCount(0);
    expect(mock.closes).toEqual([{ code: CLOSE.FINISHED, reason: 'Demo finished' }]);
    await expect(page.getByTestId('demo-narration-done')).toHaveCount(0);
  });

  test('[F2] doing nothing ends with 4002: "Your live session has ended" — not an idle avatar offering "Present all" again', async ({ page }) => {
    const { mock } = await open(page, { slides: 1, socket: { idleCloseMs: 12_000 } });
    await reachNarrationDone(page, mock, 1);
    await expect(card(page)).toBeVisible({ timeout: 25_000 });
    const c = await expectOutcome(page, 'idle', COPY.idle.title, 'status');
    await expect(c.getByTestId('demo-outcome-detail')).toHaveText(COPY.idle.detail);
    expect(mock.closes).toEqual([{ code: CLOSE.IDLE, reason: 'Demo idle timeout' }]);
    await expect(page.getByTestId('demo-narration-done')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /present all/i })).toHaveCount(0);
  });

  test('[F2] "Finish demo" ends the session locally when the 4001 does not arrive within 3 s', async ({ page }) => {
    const { mock } = await open(page, {
      slides: 1,
      clock: true,
      before: async () => {
        // The server never closes: the client drops the finish request on the wire.
        await page.addInitScript(() => {
          const send = WebSocket.prototype.send;
          WebSocket.prototype.send = function patched(this: WebSocket, data: string | ArrayBufferLike | Blob | ArrayBufferView) {
            if (typeof data === 'string' && data.includes('"demo.finish"')) return;
            send.call(this, data);
          };
        });
      },
    });
    await reachNarrationDone(page, mock, 1);
    await freezeClock(page);
    await page.getByTestId('demo-finish').click();
    await expect(page.getByTestId('demo-finish')).toHaveText('Finishing…');
    await page.clock.runFor(2500);
    await expect(card(page)).toHaveCount(0);
    await page.clock.runFor(800);
    await expectOutcome(page, 'finished', COPY.finished.title, 'status');
    expect(mock.ofType('demo.finish')).toHaveLength(0);
  });

  test('[T3-12] the narration limit: the cause, "Ask a question" / "Finish demo" and the recording — no Present buttons', async ({ page }) => {
    const { mock } = await open(page, { socket: { speak: 'speak_limit' } });
    await connect(page, mock);
    const done = page.getByTestId('demo-narration-done');
    await expect(done).toBeVisible();
    await expect(done).toContainText("You've reached this session's narration limit");
    await expect(page.getByTestId('demo-ask')).toBeVisible();
    await expect(page.getByTestId('demo-finish')).toBeVisible();
    const recording = page.getByTestId('demo-done-recording');
    await expect(recording).toHaveText(RECORDING.label);
    await expect(recording).toHaveAttribute('href', RECORDING.href);
    await expect(page.getByRole('button', { name: /present/i })).toHaveCount(0);
    await expect(page.getByTestId('demo-status')).toHaveCount(0);
  });

  test('[T3-13] a slide without narration: "No narration for slide 1", then the presentation moves on by itself', async ({ page }) => {
    const { mock } = await open(page, { slides: 2, socket: { narrations: ['', 'The second slide.'] } });
    await connect(page, mock);
    await expect(page.getByTestId('demo-status')).toHaveText('No narration for slide 1');
    await mock.waitForSent('demo.speak', 2);
    expect(mock.ofType('demo.speak').map((m) => m.slide)).toEqual([0, 1]);
    await expect(page.getByTestId('slide-counter')).toContainText('Slide 2 of 2');
  });

  test('[T3-09] the avatar\'s lifecycle events are lost: "The avatar seems to have stopped", Continue, and the caption text stays whole', async ({ page }) => {
    const { mock } = await open(page, { clock: true, slides: 2, socket: { wordTimestamps: false } });
    await connect(page, mock);
    await expect.poll(() => mock.items.length).toBe(1);
    await freezeClock(page);
    await page.clock.runFor(25_000);
    await expect(page.getByTestId('demo-status')).toHaveText('The avatar seems to have stopped — press Continue to go on');
    const box = page.getByTestId('live-captions-text');
    await expect(box).toHaveText(mock.turns[0].text);
    await expect(box).toHaveAttribute('data-complete', 'true');
    await page.getByTestId('playback-continue').click();
    await page.clock.runFor(700);
    await mock.waitForSent('demo.speak', 2);
    expect(mock.ofType('demo.speak').map((m) => m.slide)).toEqual([0, 1]);
  });
});

// ── 8. "This demo covers about 0 of N slides" (T3-11) ───────────────────────────────────────────────────────

test.describe('coverage note (T3-11)', () => {
  const note = (page: Page) => page.getByTestId('demo-coverage-note');
  const long = (n: number) => 'x'.repeat(n);

  test('[T3-11] a narration that does not fit says how many slides fit', async ({ page }) => {
    // 5 slides × 1,500 characters ≈ 115 s each at 13 characters a second: two fit in the 300 s of the session.
    const { mock } = await open(page, { socket: { narrations: Array.from({ length: SLIDES }, () => long(1500)) } });
    await tapStart(page, mock);
    await expect(note(page)).toHaveText('This demo covers about 2 of 5 slides');
  });

  test('[T3-11] when not even one slide fits, the note is by duration — never "0 of N"', async ({ page }) => {
    const { mock } = await open(page, { socket: { narrations: [long(5000), 'Short.', 'Short.', 'Short.', 'Short.'] } });
    await tapStart(page, mock);
    await expect(note(page)).toHaveText(/^The narration takes about 6 minutes, more than the (5:00|4:5\d) left in this demo$/);
    await expect(page.locator('.avatar-rail')).not.toContainText(/\b0 of \d/);
  });

  test('[T3-11] a one-slide deck that does not fit is never "0 of 1"', async ({ page }) => {
    const { mock } = await open(page, { slides: 1, socket: { narrations: [long(5000)] } });
    await tapStart(page, mock);
    await expect(note(page)).toContainText(/^The narration takes about 6 minutes/);
    await expect(page.locator('.avatar-rail')).not.toContainText(/\b0 of \d/);
  });

  test('[T3-11] a narration that fits shows no note', async ({ page }) => {
    const { mock } = await open(page);
    await tapStart(page, mock);
    await expect(page.getByTestId('demo-status')).toBeVisible();
    await expect(note(page)).toHaveCount(0);
  });
});

// ── 9. Questions: typed, always part of the panel; by voice, with every failure leading to the typed field ────────

test.describe('questions', () => {
  const raise = (page: Page) => page.getByTestId('raise-hand');
  const panel = (page: Page) => page.getByTestId('raise-hand-panel');
  const typed = (page: Page) => page.getByTestId('qa-text-input');
  const err = (page: Page) => page.getByTestId('qa-error');

  /** Slide 1 narrates; the hand goes up; when the slide ends the presenter invites the question and the invite plays out. */
  async function raiseAndInvite(page: Page, mock: DemoSocketMock) {
    await raise(page).click();
    await expect(panel(page)).toHaveAttribute('data-phase', 'raised');
    await endTurns(page, mock, 1);
    await mock.waitForSent('qa.begin');
    await endTurns(page, mock, 1, 2);
  }

  /** Listening: some audio, then "Done". */
  async function sayAndCommit(page: Page, mock: DemoSocketMock) {
    await expect(page.getByTestId('qa-mic-level')).toBeVisible();
    await page.waitForTimeout(1200);
    await page.getByTestId('qa-done').click();
    await mock.waitForSent('qa.commit');
  }

  /** A failed question offers the typed field next to Continue (contracts §10.6). */
  async function expectTypedNextToContinue(page: Page) {
    await expect(page.getByTestId('qa-continue')).toBeVisible();
    await expect(typed(page)).toBeVisible();
    await expect(typed(page)).toBeEnabled();
    await expect(page.getByTestId('qa-text-submit')).toBeVisible();
  }

  async function breakMicrophone(page: Page, kind: 'denied' | 'missing' | 'unsupported' | 'silent') {
    await page.addInitScript((k) => {
      if (k === 'unsupported') {
        Object.defineProperty(Navigator.prototype, 'mediaDevices', { get: () => undefined, configurable: true });
        return;
      }
      if (k === 'silent') {
        // A live microphone that hears nothing.
        navigator.mediaDevices.getUserMedia = async () => new AudioContext().createMediaStreamDestination().stream;
        return;
      }
      const error = k === 'denied' ? new DOMException('Permission denied', 'NotAllowedError') : new DOMException('Requested device not found', 'NotFoundError');
      navigator.mediaDevices.getUserMedia = () => Promise.reject(error);
    }, kind);
  }

  for (const row of [
    { id: 'T3-Q01', kind: 'denied' as const, what: 'permission denied', message: 'Microphone access was blocked. Allow the microphone for this site to ask a question.' },
    { id: 'T3-Q02', kind: 'missing' as const, what: 'no microphone', message: 'No microphone was found. Connect one and try again.' },
    { id: 'T3-Q03', kind: 'unsupported' as const, what: 'recording unsupported', message: 'This browser cannot record audio here. Use a recent browser over HTTPS.' },
  ]) {
    test(`[${row.id}] raise hand with ${row.what}: the message, "Microphone unavailable", and the typed question as the next action`, async ({ page }) => {
      await breakMicrophone(page, row.kind);
      const { mock } = await open(page, { slides: 2 });
      await connect(page, mock);
      await raise(page).click();
      await expect(page.getByTestId('qa-notice')).toHaveText(row.message);
      await expect(page.getByTestId('demo-status')).toHaveText('Microphone unavailable');
      await expect(typed(page)).toBeVisible();
      expect(mock.ofType('qa.begin')).toHaveLength(0);
      // The typed question works from here: it is queued behind the slide, then sent.
      await typed(page).fill('What is an agent?');
      await typed(page).press('Enter');
      await expect(page.getByTestId('qa-state')).toHaveText('Your question is queued — answered after this slide');
      await endTurns(page, mock, 1);
      const ask = await mock.waitForSent('qa.ask_text');
      expect(ask).toMatchObject({ type: 'qa.ask_text', slide: 0, text: 'What is an agent?' });
    });
  }

  test('[T3-Q04] the presenter never takes the hand (no qa.ready in 12 s): the message, Continue and the typed field', async ({ page }) => {
    const { mock } = await open(page, { slides: 2, clock: true, socket: { qaBegin: 'silent' } });
    await connect(page, mock);
    await raise(page).click();
    await endTurns(page, mock, 1);
    await mock.waitForSent('qa.begin');
    await page.clock.runFor(12_500);
    await expect(err(page)).toHaveText('The presenter did not respond. Try again in a moment.');
    await expectTypedNextToContinue(page);
    await mock.waitForSent('qa.cancel');
  });

  test('[T3-Q05] silence while listening (client): "I didn\'t catch a question", Continue and the typed field', async ({ page }) => {
    await breakMicrophone(page, 'silent');
    const { mock } = await open(page, { slides: 2 });
    await connect(page, mock);
    await raiseAndInvite(page, mock);
    await expect(page.getByTestId('qa-done')).toBeVisible();
    await expect(err(page)).toHaveText("I didn't catch a question. Press Continue to go on.", { timeout: 20_000 });
    await expectTypedNextToContinue(page);
    await mock.waitForSent('qa.cancel');
    expect(mock.ofType('qa.commit')).toHaveLength(0);
  });

  for (const row of [
    { id: 'T3-Q06', code: 'no_speech' as const, what: 'speech-to-text heard nothing' },
    { id: 'T3-Q07', code: 'stt_failed' as const, what: 'speech-to-text failed' },
  ]) {
    test(`[${row.id}] ${row.what}: the server's words, Continue and the typed field`, async ({ page }) => {
      const { mock } = await open(page, { slides: 2, socket: { qaCommit: row.code } });
      await connect(page, mock);
      await raiseAndInvite(page, mock);
      await sayAndCommit(page, mock);
      await expect(err(page)).toHaveText(SERVER_QA_ERRORS[row.code]);
      await expectTypedNextToContinue(page);
    });
  }

  test('[T3-Q08] the answer cannot be produced: the heard question stays visible, "Ask again" pre-fills the field, the narration continues', async ({ page }) => {
    const { mock } = await open(page, { slides: 2, socket: { qaCommit: 'answer_failed', transcript: 'What drives growth?' } });
    await connect(page, mock);
    await raiseAndInvite(page, mock);
    await sayAndCommit(page, mock);
    await expect(err(page)).toHaveText(SERVER_QA_ERRORS.answer_failed);
    await expect(page.getByTestId('qa-transcript')).toContainText('What drives growth?');
    await expectTypedNextToContinue(page);
    await expect(typed(page), 'ask again with one tap').toHaveValue('What drives growth?');
    await page.getByTestId('qa-continue').click();
    await mock.waitForSent('demo.speak', 2);
    expect(mock.ofType('demo.speak').map((m) => m.slide)).toEqual([0, 1]);
  });

  test('[T3-Q09] not enough time left: the message, then no "Question answered", and Raise hand disabled with the reason', async ({ page }) => {
    const { mock } = await open(page, { slides: 2, socket: { qaBegin: 'time_low' } });
    await connect(page, mock);
    await raise(page).click();
    await endTurns(page, mock, 1);
    await expect(err(page)).toHaveText(SERVER_QA_ERRORS.time_low);
    await page.getByTestId('qa-continue').click();
    await expect(raise(page)).toBeDisabled();
    await expect(page.getByTestId('qa-disabled')).toHaveText('Not enough demo time is left for a question.');
    await expect(page.locator('.avatar-rail')).not.toContainText('Question answered');
  });

  test('[T3-Q10a] the server refuses the question (session limit): shown once, the reason on the disabled button, "0 questions left"', async ({ page }) => {
    const { mock } = await open(page, { slides: 2, socket: { qaBegin: 'limit' } });
    await connect(page, mock);
    await raise(page).click();
    await endTurns(page, mock, 1);
    await expect(err(page)).toHaveText(DEMO_QA_LIMIT_MESSAGES.session);
    await expect(page.getByTestId('demo-status'), 'one display only: no second copy in the status line').toHaveCount(0);
    await page.getByTestId('qa-continue').click();
    await expect(raise(page)).toBeDisabled();
    await expect(page.getByTestId('qa-disabled')).toHaveText(DEMO_QA_LIMIT_MESSAGES.session);
    await expect(page.getByTestId('qa-remaining')).toHaveText('0 questions left');
    await expect(typed(page)).toHaveCount(0);
  });

  test('[T3-Q10b] the last question is used: "0 questions left" and a reason line on the disabled button', async ({ page }) => {
    const { mock } = await open(page, { slides: 1, socket: { remainingQuestions: 1 } });
    await reachNarrationDone(page, mock, 1);
    await page.getByTestId('demo-ask').click();
    await typed(page).fill('Why does it matter?');
    await typed(page).press('Enter');
    await expect(page.getByTestId('qa-answer')).toBeVisible();
    await endTurns(page, mock, 1, 2);
    await mock.waitForSent('qa.resume');
    await expect(page.getByTestId('qa-remaining')).toHaveText('0 questions left');
    await expect(raise(page)).toBeDisabled();
    await expect(page.getByTestId('qa-disabled')).toHaveText(DEMO_QA_LIMIT_MESSAGES.session);
    await expect(typed(page)).toHaveCount(0);
    await expect(page.getByTestId('demo-ask'), 'nothing left to ask').toHaveCount(0);
  });

  test('[T3-Q11] the daily question budget is exhausted: the server\'s message verbatim, Raise hand disabled with that reason', async ({ page }) => {
    const { mock } = await open(page, { slides: 1, socket: { qaAskText: 'daily' } });
    await reachNarrationDone(page, mock, 1);
    await page.getByTestId('demo-ask').click();
    await typed(page).fill('What is the daily limit?');
    await typed(page).press('Enter');
    await expect(err(page)).toHaveText(DEMO_QA_LIMIT_MESSAGES.daily);
    await page.getByTestId('qa-continue').click();
    await expect(raise(page)).toBeDisabled();
    await expect(page.getByTestId('qa-disabled')).toHaveText(DEMO_QA_LIMIT_MESSAGES.daily);
  });

  test('[T3-Q11] the quota store is unavailable: its message, and Raise hand stays enabled (it is temporary)', async ({ page }) => {
    const { mock } = await open(page, { slides: 1, socket: { qaAskText: 'quota-store' } });
    await reachNarrationDone(page, mock, 1);
    await page.getByTestId('demo-ask').click();
    await typed(page).fill('Can I ask now?');
    await typed(page).press('Enter');
    await expect(err(page)).toHaveText(DEMO_QA_LIMIT_MESSAGES.unavailable);
    await page.getByTestId('qa-continue').click();
    await expect(raise(page)).toBeEnabled();
    await expect(page.getByTestId('qa-disabled')).toHaveCount(0);
    await expect(page.getByTestId('qa-remaining'), 'the refused question is not counted').toHaveText('2 questions left');
    await expect(typed(page)).toHaveValue('Can I ask now?');
  });

  test('[T3-Q12] the microphone opens but capture cannot start: "could not be started. Try again or type your question", Continue and the typed field', async ({ page }) => {
    await page.addInitScript(() => {
      AudioWorklet.prototype.addModule = () => Promise.reject(new DOMException('Unable to load a worklet\'s module.', 'AbortError'));
    });
    const { mock } = await open(page, { slides: 2 });
    await connect(page, mock);
    await raiseAndInvite(page, mock);
    await expect(err(page)).toHaveText('The microphone could not be started. Try again or type your question.', { timeout: 15_000 });
    await expectTypedNextToContinue(page);
    await mock.waitForSent('qa.cancel');
  });

  test('[T3-Q13] the answer is too slow (30 s): "taking too long", Continue and the typed field', async ({ page }) => {
    const { mock } = await open(page, { slides: 1, clock: true, socket: { qaDelaysMs: { transcript: 600_000 } } });
    await reachNarrationDone(page, mock, 1);
    await page.getByTestId('demo-ask').click();
    await typed(page).fill('Take your time.');
    await typed(page).press('Enter');
    await mock.waitForSent('qa.ask_text');
    await expect(page.getByTestId('qa-state')).toHaveText('Finding the answer in the deck…');
    await page.clock.runFor(30_500);
    await expect(err(page)).toHaveText('The answer is taking too long. Try again.');
    await expectTypedNextToContinue(page);
  });

  test('[T3-Q14] questions are unavailable for the deck: the message and Continue; the typed field and Raise hand are off', async ({ page }) => {
    const { mock } = await open(page, { slides: 2, socket: { qaBegin: 'unavailable' } });
    await connect(page, mock);
    await raise(page).click();
    await endTurns(page, mock, 1);
    await expect(err(page)).toHaveText("Questions aren't available for this presentation.");
    await page.getByTestId('qa-continue').click();
    await expect(raise(page)).toBeDisabled();
    await expect(page.getByTestId('qa-disabled')).toHaveText("Questions aren't available for this presentation.");
    await expect(typed(page)).toHaveCount(0);
  });

  // ── the typed question itself (§4.4) ──

  test('typed question: part of the panel whenever demo Q&A is on; absent when it is off', async ({ page }) => {
    const on = await open(page, { slides: 1 });
    await connect(page, on.mock);
    await expect(raise(page)).toBeVisible();
    await expect(typed(page)).toBeVisible();
    await expect(page.getByTestId('qa-text-submit')).toBeDisabled();
    await expect(page.getByText(/^(\d+) questions? left$/)).toHaveText('2 questions left');
    await typed(page).fill('  ');
    await expect(page.getByTestId('qa-text-submit'), 'blank text cannot be sent').toBeDisabled();
    await expect(typed(page), 'the field stops at 500 characters').toHaveAttribute('maxlength', '500');

    const off = await page.context().newPage();
    await mockApi(off, 'visitor', { catalog: 'demo', demoQa: undefined });
    const offMock = await mockDemoSocket(off, { slideCount: SLIDES, idleCloseMs: false });
    await off.goto(DECK_PATH);
    await off.getByTestId('demo-start').click();
    await expect.poll(() => offMock.connections).toBe(1);
    await demoHooks.connected(off);
    await expect(off.getByTestId('demo-stop')).toBeVisible();
    await expect(off.getByTestId('raise-hand-panel')).toHaveCount(0);
    await expect(off.getByTestId('qa-text-input')).toHaveCount(0);
  });

  test('typed question: "Sending your question…" at once; accepted clears the field and counts it; the answer is written and spoken', async ({ page }) => {
    await trackTexts(page, ['qa-state']);
    const { mock } = await open(page, { slides: 1, socket: { qaDelaysMs: { transcript: 200, answer: 300 } } });
    await reachNarrationDone(page, mock, 1);
    await page.getByTestId('demo-ask').click();
    await expect(typed(page), 'Ask a question moves focus to the field').toBeFocused();
    await typed(page).fill('What is an agent?');
    await page.getByTestId('qa-text-submit').click();
    const ask = await mock.waitForSent('qa.ask_text');
    expect(ask).toMatchObject({ type: 'qa.ask_text', slide: 0, text: 'What is an agent?' });
    expect(ask.request_id).toMatch(/^[A-Za-z0-9._:-]{1,64}$/);
    await expect(page.getByTestId('qa-answer')).toContainText(mock.options.answer ?? 'The deck says growth comes from new markets.');
    const seen = await page.evaluate(() => {
      const w = window as any;
      return { states: w.__texts['qa-state'] as { text: string; at: number }[], clickAt: w.__clickAt as number };
    });
    expect(seen.states[0].text).toBe('Sending your question…');
    expect(seen.states[0].at - seen.clickAt, 'ms from the tap to the first feedback').toBeLessThan(1000);
    await expect(page.getByTestId('qa-transcript')).toContainText('What is an agent?');
    await expect(typed(page), 'the field is gone while the question is answered').toHaveCount(0);
    await endTurns(page, mock, 1, 2);
    await mock.waitForSent('qa.resume');
    await expect(typed(page)).toHaveValue('');
    await expect(page.getByTestId('qa-remaining'), 'remaining_questions from qa.accepted').toHaveText('1 question left');
  });

  test('typed question: no answer from the server in 5 s → "couldn\'t be sent", the text is kept, a new attempt is a new request', async ({ page }) => {
    const { mock } = await open(page, { slides: 1, clock: true, socket: { qaAskText: 'silent' } });
    await reachNarrationDone(page, mock, 1);
    await page.getByTestId('demo-ask').click();
    await typed(page).fill('Is it safe?');
    await typed(page).press('Enter');
    await expect(page.getByTestId('qa-state')).toHaveText('Sending your question…');
    await mock.waitForSent('qa.ask_text');
    await page.clock.runFor(DEMO_TIMING.askTextAckTimeoutMs + 300);
    await expect(err(page)).toHaveText("The question couldn't be sent. Try again.");
    await expect(typed(page)).toHaveValue('Is it safe?');
    mock.options.qaAskText = 'answer';
    await page.getByTestId('qa-text-submit').click();
    const second = await mock.waitForSent('qa.ask_text', 2);
    const [first] = mock.ofType('qa.ask_text');
    expect(second.request_id).not.toBe(first.request_id);
    expect(second.text).toBe('Is it safe?');
    await expect(page.getByTestId('qa-answer')).toBeVisible();
  });

  test('typed question: a refusal keeps the typed text', async ({ page }) => {
    const { mock } = await open(page, { slides: 1, socket: { qaAskText: 'bad_state' } });
    await reachNarrationDone(page, mock, 1);
    await page.getByTestId('demo-ask').click();
    await typed(page).fill('Keep this text');
    await typed(page).press('Enter');
    await expect(err(page)).toHaveText(SERVER_QA_ERRORS.bad_state);
    await expect(typed(page)).toHaveValue('Keep this text');
  });

  test('typed question: while a slide narrates it is queued and goes out when the slide ends', async ({ page }) => {
    const { mock } = await open(page, { slides: 2 });
    await connect(page, mock);
    await expect(raise(page)).toBeVisible();
    await typed(page).fill('Why?');
    await typed(page).press('Enter');
    await expect(page.getByTestId('qa-state')).toHaveText('Your question is queued — answered after this slide');
    await expect(page.getByTestId('qa-transcript')).toContainText('Why?');
    await page.getByTestId('qa-cancel').click();
    await expect(typed(page), 'cancelling the queued question puts the field back').toBeVisible();
    await typed(page).fill('Why again?');
    await typed(page).press('Enter');
    await endTurns(page, mock, 1);
    const ask = await mock.waitForSent('qa.ask_text');
    expect(ask.text).toBe('Why again?');
    expect(mock.ofType('qa.begin'), 'no spoken invitation for a typed question').toHaveLength(0);
  });
});

// ── 10. The deck page itself: a link that no longer resolves (T2-13), a demo that cannot run (T3-01) ──────────

test.describe('deck page states', () => {
  test('[T2-13] a deck link that no longer resolves: "Deck not found" and the public next steps', async ({ page }) => {
    const { api } = await open(page, { path: '/decks/deck-gone/present', api: { detailFailure: 404 }, waitStart: false });
    await expect(page.getByText("This deck couldn't be loaded")).toBeVisible();
    await expect(page.getByText('Deck not found')).toBeVisible();
    const start = page.getByTestId('deck-start-live-demo');
    await expect(start).toHaveText('Start the live demo');
    await expect(start).toHaveAttribute('href', DECK_PATH);
    await expect(page.getByRole('link', { name: 'Listen to an episode' })).toHaveAttribute('href', '/podcast/library');
    await expect(page.getByRole('link', { name: 'Back to decks' })).toBeVisible();
    await expect(page.getByTestId('deck-retry'), 'a missing deck is not retried').toHaveCount(0);
    api.detailFailures.deck = null;
    await start.click();
    await expect(page).toHaveURL(/\/decks\/deck-demo-en\/present$/);
    await expect(page.getByTestId('demo-start')).toBeVisible();
  });

  test('[T2-13] a storage outage is not "Deck not found": a friendly cause and a "Try again" that heals', async ({ page }) => {
    const { api } = await open(page, { path: '/decks/deck-live/present', api: { detailFailure: 503 }, waitStart: false });
    await expect(page.getByText("This deck couldn't be loaded")).toBeVisible();
    await expect(page.getByText("We couldn't load this deck right now. Please try again in a moment.")).toBeVisible();
    await expect(page.getByText('Deck not found')).toHaveCount(0);
    await expect(page.getByTestId('deck-start-live-demo')).toBeVisible();
    api.detailFailures.deck = null;
    await page.getByTestId('deck-retry').click();
    await expect(page.getByTestId('demo-start')).toBeVisible();
    await expect(page.getByText("This deck couldn't be loaded")).toHaveCount(0);
  });

  test('[T2-13] offline reads as offline; with the demo switched off the recording replaces the live start', async ({ page }) => {
    const offline = await open(page, { path: '/decks/deck-live/present', api: { detailFailure: 'network' }, waitStart: false });
    await expect(page.getByText('You seem to be offline. Check your connection and try again.')).toBeVisible();
    await expect(page.getByTestId('deck-retry')).toBeVisible();
    expect(offline.errors).toEqual([]);

    const off = await page.context().newPage();
    await mockApi(off, 'visitor', { catalog: 'demo', detailFailure: 404, demoEnabled: false });
    await off.goto('/decks/deck-gone/present');
    await expect(off.getByText("This deck couldn't be loaded")).toBeVisible();
    await expect(off.getByRole('link', { name: 'Watch a recorded demo' })).toHaveAttribute('href', '/video/library');
    await expect(off.getByTestId('deck-start-live-demo')).toHaveCount(0);
  });

  const unavailableCard = async (page: Page) => {
    const c = card(page);
    await expect(c).toBeVisible();
    await expect(c).toHaveAttribute('data-outcome', 'unavailable');
    await expect(c).toHaveAttribute('role', 'status');
    await expect(c.getByTestId('demo-outcome-title')).toHaveText("The live demo isn't available right now");
    await expect(c.getByTestId('demo-outcome-detail')).toContainText("A live session can't start at the moment");
    await expect(c.getByTestId('demo-outcome-recording')).toHaveText(RECORDING.label);
    await expect(c.getByTestId('demo-outcome-recording')).toHaveAttribute('href', RECORDING.href);
    await expect(page.getByTestId('demo-start')).toHaveCount(0);
    await expect(page.getByTestId('live-demo-available')).toHaveCount(0);
    await expect(page.getByText('Read-only preview')).toBeVisible();
    await expect(page.getByText(/sign in to try the live avatar/i), 'visitors are never sent to a sign-in wall').toHaveCount(0);
  };

  test('[T3-01] the demo is switched off: "The live demo isn\'t available right now" + the recording', async ({ page }) => {
    const { mock } = await open(page, { api: { demoEnabled: false }, waitStart: false });
    await unavailableCard(page);
    expect(mock.connections).toBe(0);
  });

  test('[T3-01] the demo configuration cannot be read (503): the same card', async ({ page }) => {
    await open(page, { before: ({ api }) => { api.demo.failure = 503; }, waitStart: false });
    await unavailableCard(page);
  });

  test('[T3-01] a deck that is not a live-demo deck: the cause, "Start the live demo" and the public links', async ({ page }) => {
    await open(page, { path: '/decks/deck-plain/present', waitStart: false });
    const c = card(page);
    await expect(c.getByTestId('demo-outcome-title')).toHaveText("The live avatar isn't available for this deck");
    const start = c.getByTestId('deck-start-live-demo');
    await expect(start).toHaveText('Start the live demo');
    await expect(start).toHaveAttribute('href', DECK_PATH);
    await expect(c.getByTestId('demo-outcome-fallback')).toHaveCount(DEMO_FALLBACK_LINKS.length);
    await expect(page.getByText(/sign in to try the live avatar/i)).toHaveCount(0);
  });

  test('[P2-6] a slide picture is named "{title}: {text}", truncated at a word, and by its title alone without text', async ({ page }) => {
    const long = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ');
    const deck = {
      ...DEMO_DECK_EN,
      id: DEMO_DECK_EN.deck_id,
      filename: DEMO_DECK_EN.title,
      slide_count: 3,
      slides: [
        { index: 0, title: "Hi, I'm an AI presenter", image_url: '/media/slide-0.png', text: 'A short live demo\nBeginner level' },
        { index: 1, title: 'A long slide', image_url: '/media/slide-1.png', text: long },
        { index: 2, title: 'Only a title', image_url: '/media/slide-2.png', text: '' },
      ],
    };
    await open(page, { before: async () => { await page.route('**/api/decks/deck-demo-en', (route) => route.fulfill({ json: deck })); } });
    const img = page.locator('.slide-viewer img');
    await expect(img).toHaveAttribute('alt', "Hi, I'm an AI presenter: A short live demo Beginner level");
    await page.getByTestId('slide-next').click();
    await expect(img).toHaveAttribute('alt', /^A long slide: word0 word1 /);
    const alt = (await img.getAttribute('alt')) ?? '';
    expect(alt.length, 'title + text, at most 250 characters and an ellipsis').toBeLessThanOrEqual(251);
    expect(alt).toMatch(/ word\d+…$/);
    await page.getByTestId('slide-next').click();
    await expect(img).toHaveAttribute('alt', 'Only a title');
  });
});

// ── 11. ICE offer timing (C3.2): the decision logic, then its wiring ──────────────────────────────────────────

const RELAY_UDP = { candidate: 'candidate:1 1 udp 41820159 10.0.0.1 3478 typ relay raddr 0.0.0.0 rport 0', type: 'relay', protocol: 'udp', relayProtocol: 'udp', url: 'turn:turn.example:3478?transport=udp' };
const RELAY_UDP_2 = { ...RELAY_UDP, candidate: 'candidate:2 1 udp 41820158 10.0.0.2 3478 typ relay raddr 0.0.0.0 rport 0' };
const RELAY_TLS = { candidate: 'candidate:3 1 tcp 41819903 10.0.0.1 443 typ relay raddr 0.0.0.0 rport 0', type: 'relay', protocol: 'tcp', relayProtocol: 'tls', url: 'turns:turn.example:443?transport=tcp' };
const HOST = { candidate: 'candidate:9 1 udp 2122260223 192.168.1.5 53000 typ host', type: 'host', protocol: 'udp' };

test.describe('ICE offer timing (C3.2)', () => {
  test('planner: gathering complete sends the offer at once', () => {
    const p = new IceOfferPlanner(1000);
    p.candidate(RELAY_UDP, 1200);
    p.complete(1500);
    expect(p.due()).toEqual({ at: 1500, reason: 'complete' });
  });

  test('planner: iceRelayGraceMs after the FIRST relay candidate; later relay candidates and host candidates do not move it', () => {
    const p = new IceOfferPlanner(0);
    expect(p.due()).toEqual({ at: DEMO_TIMING.iceGatherMaxMs, reason: 'max-wait' });
    expect(p.candidate(HOST, 100)).toBe('other');
    expect(p.due().reason).toBe('max-wait');
    expect(p.candidate(RELAY_UDP, 1000)).toBe('relay');
    p.candidate(RELAY_UDP_2, 1500);
    p.candidate(RELAY_UDP, 1900);
    expect(p.due()).toEqual({ at: 1000 + DEMO_TIMING.iceRelayGraceMs, reason: 'relay-grace' });
    p.complete(2400);
    expect(p.due(), 'completing earlier than the grace wins').toEqual({ at: 2400, reason: 'complete' });
  });

  test('planner: a relay that arrives late never pushes the offer past iceGatherMaxMs', () => {
    const p = new IceOfferPlanner(0);
    p.candidate(RELAY_UDP, 4500);
    expect(p.due()).toEqual({ at: DEMO_TIMING.iceGatherMaxMs, reason: 'max-wait' });
    const q = new IceOfferPlanner(10_000);
    expect(q.due().at, 'relative to the start of gathering').toBe(10_000 + DEMO_TIMING.iceGatherMaxMs);
  });

  test('planner: a TCP/TLS relay (443) is preferred — the offer leaves shortly after it, before the UDP grace', () => {
    const p = new IceOfferPlanner(0);
    p.candidate(RELAY_UDP, 300);
    expect(p.due()).toEqual({ at: 300 + DEMO_TIMING.iceRelayGraceMs, reason: 'relay-grace' });
    expect(p.candidate(RELAY_TLS, 500)).toBe('preferred');
    expect(p.due()).toEqual({ at: 500 + ICE_PREFERRED_SETTLE_MS, reason: 'preferred-relay' });
    const late = new IceOfferPlanner(0);
    late.candidate(RELAY_UDP, 300);
    late.candidate(RELAY_TLS, 2000);
    expect(late.due(), 'a TLS relay after the UDP one still shortens the wait').toEqual({ at: 2000 + ICE_PREFERRED_SETTLE_MS, reason: 'preferred-relay' });
  });

  test('planner: the admin presenter keeps the old rule (gathering complete, or the 5 s cap)', () => {
    const p = new IceOfferPlanner(0, ICE_WAIT_FOR_GATHERING);
    p.candidate(RELAY_UDP, 100);
    p.candidate(RELAY_TLS, 200);
    expect(p.due()).toEqual({ at: DEMO_TIMING.iceGatherMaxMs, reason: 'max-wait' });
    p.complete(1200);
    expect(p.due()).toEqual({ at: 1200, reason: 'complete' });
  });

  test('classifyIceCandidate: relay over UDP, relay over TCP/TLS, and everything else', () => {
    expect(classifyIceCandidate(RELAY_UDP)).toBe('relay');
    expect(classifyIceCandidate(RELAY_TLS)).toBe('preferred');
    expect(classifyIceCandidate(HOST)).toBe('other');
    expect(classifyIceCandidate(null)).toBe('other');
    expect(classifyIceCandidate({ candidate: 'candidate:5 1 tcp 1 10.0.0.1 443 typ relay' })).toBe('preferred');
    expect(classifyIceCandidate({ candidate: 'candidate:5 1 udp 1 10.0.0.1 3478 typ relay' })).toBe('relay');
    expect(classifyIceCandidate({ type: 'relay', url: 'turns:turn.example:5349' })).toBe('preferred');
    expect(classifyIceCandidate({ candidate: 'candidate:6 1 udp 1 10.0.0.1 3478 typ srflx' })).toBe('other');
  });

  /** A scripted `RTCPeerConnection`: gathering follows `window.__iceScript` from the moment the offer is set. */
  async function fakePeerConnection(page: Page) {
    await page.addInitScript(() => {
      const w = window as any;
      w.__pcConfigs = [] as unknown[];
      w.__iceScript = [] as unknown[];
      class FakePC {
        onicecandidate: ((e: unknown) => void) | null = null;
        onicegatheringstatechange: (() => void) | null = null;
        onconnectionstatechange: (() => void) | null = null;
        oniceconnectionstatechange: (() => void) | null = null;
        ondatachannel: unknown = null;
        ontrack: unknown = null;
        iceGatheringState = 'new';
        connectionState = 'new';
        signalingState = 'stable';
        localDescription: { type: string; sdp: string } | null = null;
        constructor(config: unknown) { w.__pcConfigs.push(config); }
        addTransceiver() {}
        createDataChannel() { return {}; }
        async createOffer() { return { type: 'offer', sdp: 'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n' }; }
        async setLocalDescription(description: { type: string; sdp: string }) {
          this.localDescription = description;
          this.iceGatheringState = 'gathering';
          for (const step of w.__iceScript as { at: number; candidate?: unknown; complete?: boolean }[]) {
            setTimeout(() => {
              if (step.complete) {
                this.iceGatheringState = 'complete';
                this.onicecandidate?.({ candidate: null });
                this.onicegatheringstatechange?.();
              } else {
                this.onicecandidate?.({ candidate: step.candidate });
              }
            }, step.at);
          }
        }
        async setRemoteDescription() {}
        close() { this.connectionState = 'closed'; }
      }
      w.RTCPeerConnection = FakePC;
    });
  }

  for (const row of [
    { name: 'gathering completes', script: [{ at: 200, candidate: RELAY_UDP }, { at: 600, complete: true }], min: 500, max: 2500 },
    { name: 'a TCP/TLS relay is ready before gathering completes', script: [{ at: 200, candidate: RELAY_UDP }, { at: 300, candidate: RELAY_TLS }], min: 450, max: 2000 },
    { name: 'the first (UDP) relay arrives late and a second one follows', script: [{ at: 100, candidate: HOST }, { at: 1000, candidate: RELAY_UDP }, { at: 1500, candidate: RELAY_UDP_2 }], min: 2900, max: 4500 },
    { name: 'no relay candidate ever arrives (the 5 s cap)', script: [{ at: 100, candidate: HOST }], min: 4900, max: 7000 },
  ]) {
    test(`the offer leaves when ${row.name}`, async ({ page }) => {
      await fakePeerConnection(page);
      const { mock } = await open(page, { socket: { onOpen: 'ice' } });
      await page.evaluate((script) => { (window as any).__iceScript = script; }, row.script);
      await tapStart(page, mock);
      const offer = await mock.waitForSent('session.avatar.connect');
      const iceAt = mock.log.find((e) => e.dir === 'out' && e.type === 'session.updated')!.t;
      const sentAt = mock.log.find((e) => e.dir === 'in' && e.type === 'session.avatar.connect')!.t;
      expect(sentAt - iceAt, 'ms from the ICE servers to the offer').toBeGreaterThanOrEqual(row.min);
      expect(sentAt - iceAt).toBeLessThanOrEqual(row.max);
      expect(JSON.parse(Buffer.from(offer.client_sdp, 'base64').toString()).type).toBe('offer');
      const configs = await page.evaluate(() => (window as any).__pcConfigs as RTCConfiguration[]);
      expect(configs[0].iceTransportPolicy, 'relay-only is kept').toBe('relay');
      const urls = (configs[0].iceServers ?? []).flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]));
      expect(urls).toEqual(expect.arrayContaining(['turn:127.0.0.1:443?transport=tcp', 'turns:127.0.0.1:443?transport=tcp']));
    });
  }
});

// ── 12. Captions and the clock: the pure modules, in Node ─────────────────────────────────────────────────────

test.describe('caption pacing (pure)', () => {
  const clockAt = (t: { now: number }) => () => t.now;

  const feed = (pacer: CaptionPacer, id: string, text: string, wordMs = 350, kind: 'narration' | 'answer' | 'invite' = 'narration') => {
    text.split(' ').forEach((w, i) => {
      pacer.caption({ response_id: id, slide: 0, kind, text: i === 0 ? w : ` ${w}`, final: false });
      pacer.word({ response_id: id, audio_offset_ms: i * wordMs, text: w });
    });
  };

  test('words appear at their timestamps after the turn starts, never before', () => {
    const t = { now: 0 };
    const views: (CaptionView | null)[] = [];
    const pacer = new CaptionPacer({ now: clockAt(t), onChange: (v) => views.push(v) });
    feed(pacer, 'r1', 'one two three four');
    expect(pacer.view?.text ?? '', 'text arrived, avatar silent').toBe('');
    t.now = 1000;
    pacer.start('r1', 1000);
    expect(pacer.view?.text).toBe('one');
    t.now = 1000 + 349; pacer.tick();
    expect(pacer.view?.text).toBe('one');
    t.now = 1000 + 350; pacer.tick();
    expect(pacer.view?.text).toBe('one two');
    t.now = 1000 + 1050; pacer.tick();
    expect(pacer.view?.text).toBe('one two three four');
    expect(pacer.view?.complete).toBe(false);
    pacer.caption({ response_id: 'r1', slide: 0, kind: 'narration', text: 'one two three four', final: true });
    pacer.end('r1');
    expect(pacer.view).toMatchObject({ text: 'one two three four', complete: true });
  });

  test('the final text replaces the deltas, and a turn that ends early shows everything', () => {
    const t = { now: 0 };
    const pacer = new CaptionPacer({ now: clockAt(t) });
    feed(pacer, 'r1', 'Hello wor ld');
    pacer.start('r1', 0);
    pacer.caption({ response_id: 'r1', slide: 0, kind: 'narration', text: 'Hello world', final: true });
    pacer.end('r1');
    expect(pacer.view?.text).toBe('Hello world');
  });

  test('without word timestamps the text is paced at the learned narration speed', () => {
    const t = { now: 0 };
    const pacer = new CaptionPacer({ now: clockAt(t), secondsPerChar: () => 0.1 });
    pacer.caption({ response_id: 'r1', slide: 1, kind: 'narration', text: 'alpha beta gamma delta', final: true });
    pacer.start('r1', 0);
    expect(pacer.view?.text, 'at least the first word').toBe('alpha');
    t.now = 1000; pacer.tick();                       // 10 characters a second
    expect(pacer.view?.text).toBe('alpha beta');
    t.now = 10_000; pacer.tick();
    expect(pacer.view?.text).toBe('alpha beta gamma delta');
  });

  test('a turn whose start is never signalled starts pacing after the safety delay, never staying blank', () => {
    const t = { now: 0 };
    const pacer = new CaptionPacer({ now: clockAt(t), startFallbackMs: 4000, secondsPerChar: () => 0.1 });
    pacer.caption({ response_id: 'r1', slide: 0, kind: 'narration', text: 'alpha beta gamma', final: true });
    t.now = 3999; pacer.tick();
    expect(pacer.view?.text ?? '').toBe('');
    t.now = 4000; pacer.tick();
    expect(pacer.view?.text).toBe('alpha');
  });

  test('a cancelled turn is cleared', () => {
    const t = { now: 0 };
    const pacer = new CaptionPacer({ now: clockAt(t) });
    feed(pacer, 'r1', 'one two three');
    pacer.start('r1', 0);
    expect(pacer.view?.text).toBe('one');
    pacer.cancel('r1');
    expect(pacer.view).toBeNull();
  });

  test('sentences are announced whole, once, in order — together when several finish at once', () => {
    const t = { now: 0 };
    const said: string[] = [];
    const pacer = new CaptionPacer({ now: clockAt(t), onSentence: (s) => said.push(s) });
    feed(pacer, 'r1', 'First one. Second here. Third');   // words at 0, 350, 700, 1050, 1400 ms
    pacer.start('r1', 0);
    expect(said, 'the first word only').toEqual([]);
    t.now = 349; pacer.tick();
    expect(said).toEqual([]);
    t.now = 350; pacer.tick();                            // "one." completes the first sentence
    expect(said).toEqual(['First one.']);
    t.now = 1049; pacer.tick();
    expect(said).toEqual(['First one.']);
    t.now = 1050; pacer.tick();                           // "here." completes the second
    expect(said).toEqual(['First one.', 'Second here.']);
    t.now = 1400; pacer.tick();                           // "Third" has no terminator yet: not a sentence
    expect(said).toHaveLength(2);
    pacer.caption({ response_id: 'r1', slide: 0, kind: 'narration', text: 'First one. Second here. Third part.', final: true });
    pacer.end('r1');
    expect(said, 'the tail is announced once the turn ended').toEqual(['First one.', 'Second here.', 'Third part.']);
    pacer.tick(); pacer.tick();
    expect(said).toHaveLength(3);

    const together: string[] = [];
    const b = new CaptionPacer({ now: clockAt(t), onSentence: (s) => together.push(s) });
    b.caption({ response_id: 'r2', slide: 0, kind: 'narration', text: 'A one. B two.', final: true });
    b.end('r2');
    expect(together, 'a region replaced twice in one frame would only read the last').toEqual(['A one. B two.']);
  });

  test('splitSentences keeps "3.5 million" whole and does not end a sentence at "U.S.A. it"', () => {
    expect(splitSentences('It grew 3.5 million. In the U.S.A. it doubled! Why?').map((s) => s.text)).toEqual([
      'It grew 3.5 million.', 'In the U.S.A. it doubled!', 'Why?',
    ]);
    expect(splitSentences('Use e.g. a model. Then stop.').map((s) => s.text)).toEqual(['Use e.g. a model.', 'Then stop.']);
    expect(splitSentences('No end yet')).toEqual([{ text: 'No end yet', end: 10, terminated: false }]);
  });
});

// ── 13. A server that speaks protocol v1 (no `protocol` in demo.started) ────────────────────────────────────────

test.describe('older server (protocol v1)', () => {
  test('[C3.3] no captions box and no typed field; the presentation is detected as finished by the client; Finish closes from the client', async ({ page }) => {
    const { mock } = await open(page, { slides: 1, socket: { protocol: 1 } });
    await connect(page, mock);
    await mock.waitForSent('demo.speak');
    await expect(page.getByTestId('live-captions')).toHaveCount(0);
    await expect(page.getByTestId('raise-hand')).toBeVisible();
    await expect(page.getByTestId('qa-text-input')).toHaveCount(0);
    await endTurns(page, mock, 1);
    await expect(page.getByTestId('demo-narration-done')).toBeVisible();
    await page.getByTestId('demo-finish').click();
    await expectOutcome(page, 'finished', COPY.finished.title, 'status');
    expect(mock.closes, 'a v1 server has not closed it: the client did').toEqual([]);
    await expect(page.getByTestId('demo-start')).toBeEnabled();
  });
});

// ── 14. Phone (Pixel 7): two taps from Home, everything within the thumb's reach ───────────────────────────────

const { defaultBrowserType: _browser, ...PIXEL_7 } = devices['Pixel 7'];

test.describe('phone (Pixel 7 viewport)', () => {
  test.use({ ...PIXEL_7 });

  test('[C3.1] from the Home CTA: 2 taps and 0 scrolls to the first narration request', async ({ page }, testInfo) => {
    const source = { catalog: 'demo' as const, demoQa: DEMO_QA_CONFIG, demoSessionSeconds: 300 };
    await mockApi(page, 'visitor', source);
    await mockBoot(page, {}, source);
    const mock = await mockDemoSocket(page, { slideCount: SLIDES, idleCloseMs: false });
    await page.addInitScript(() => {
      const w = window as any;
      w.__taps = 0;
      w.__scrolls = 0;
      addEventListener('touchstart', () => { w.__taps += 1; }, { capture: true, passive: true });
      addEventListener('scroll', () => { w.__scrolls += 1; }, { capture: true, passive: true });
    });
    await page.goto('/');
    const cta = page.getByTestId('home-try-live-demo');
    await expect(cta).toBeVisible();
    await expect(cta).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: testInfo.outputPath('home-phone.png') }); // viewport only: fullPage drops touch emulation
    await cta.tap();
    await expect(page).toHaveURL(/\/decks\/deck-demo-en\/present$/);
    const start = page.getByTestId('demo-start');
    await expect(start).toBeVisible();
    await expect(start, 'Start is on the first screen').toBeInViewport({ ratio: 1 });
    await expect(start).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath('deck-phone.png') });
    await start.tap();
    await expect.poll(() => mock.connections).toBe(1);
    await demoHooks.connected(page);
    await mock.waitForSent('demo.speak');
    expect(await page.evaluate(() => (window as any).__taps), 'taps from Home to the first narration request').toBe(2);
    expect(await page.evaluate(() => (window as any).__scrolls), 'scrolls').toBe(0);
  });

  test('[C3.1] Start, captions, questions and Stop are reachable without scrolling while the slide stays readable', async ({ page }, testInfo) => {
    const { mock } = await open(page);
    const dock = page.getByTestId('demo-avatar-controls');
    await expect(page.getByTestId('demo-start')).toBeInViewport({ ratio: 1 });
    expect(await dock.evaluate((el) => getComputedStyle(el).position), 'the controls are a bar fixed to the bottom of the screen').toBe('fixed');
    await connect(page, mock);
    await expect.poll(() => mock.items.length).toBe(1);
    await demoHooks.startTurn(page, mock.items[0]);
    await expect(page.getByTestId('live-captions-text')).not.toHaveText('');
    for (const id of ['live-captions', 'raise-hand', 'qa-text-input', 'demo-stop', 'demo-time-left']) {
      await expect(page.getByTestId(id), `${id} is on the first screen`).toBeInViewport({ ratio: 1 });
    }
    const slide = (await page.locator('.media-frame').boundingBox())!;
    const bar = (await dock.boundingBox())!;
    expect(slide.width).toBeGreaterThanOrEqual(300);
    expect(slide.height, 'the slide is picture-sized').toBeGreaterThanOrEqual(160);
    expect(slide.y + slide.height, 'the slide sits above the bar, not under it').toBeLessThanOrEqual(bar.y + 1);
    expect(Math.abs(bar.y + bar.height - page.viewportSize()!.height), 'the bar is pinned to the bottom edge of the screen').toBeLessThanOrEqual(1);
    expect(bar.height, 'the bar leaves most of the screen to the slide').toBeLessThanOrEqual(page.viewportSize()!.height * 0.55);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('connected-phone.png') });
  });

  test('[T3-02] the outcome card is in view above the bar, with the recording one tap away', async ({ page }, testInfo) => {
    const { mock } = await open(page, { socket: { onOpen: { close: CLOSE.BUSY } } });
    await page.getByTestId('demo-start').tap();
    await expect.poll(() => mock.connections).toBe(1);
    const c = await expectOutcome(page, 'busy', COPY.busy.title, 'alert');
    const cardBox = (await c.boundingBox())!;
    const bar = (await page.getByTestId('demo-avatar-controls').boundingBox())!;
    expect(cardBox.y + cardBox.height, 'the card is not hidden under the bar').toBeLessThanOrEqual(bar.y + 1);
    await expect(c.getByTestId('demo-outcome-recording')).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath('outcome-phone.png') });
  });
});

// @@APPEND@@
