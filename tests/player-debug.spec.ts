import { test, expect as baseExpect, type Page } from '@playwright/test';
import { MOCKED_MEDIA_REASON, POD_VIDEO, mockApi, mockedMediaUnavailable, podcastLibraryItem } from './support/mock-api';

/**
 * Opt-in on-device playback log (`?debug=player`, demos/frontend/src/debug).
 *
 * Every /api call is mocked (tests/support/mock-api.ts, `podcastV2`); media are real
 * fixtures served with byte ranges. The radio episode is re-signed with a SAS-like
 * query string so the log can be checked for token leaks.
 */

const expect = baseExpect.configure({ timeout: 15_000 });
test.describe.configure({ timeout: 90_000 });

const FLAG_KEY = 'oz-radio.debug';
const LOG_KEY = 'oz-radio.debug.log';
const VIDEO_TITLE = 'Agents on air';
const SAS = 'sv=2025-05-05&st=2026-10-18T02%3A00%3A00Z&se=2026-10-18T02%3A15%3A00Z&sr=b&sp=r&sig=SECRETSIGNATURE%3D';
const SAS_MARKERS = ['sig=', '?sv=', 'se=', 'SECRETSIGNATURE'];

interface Entry { t: string; dt: number; kind: string; detail: Record<string, unknown> }

const toggle = (page: Page) => page.getByTestId('player-debug-toggle');
const panel = (page: Page) => page.getByRole('region', { name: 'Player debug log' });
const dialog = (page: Page) => page.getByRole('dialog');
const radioAudio = (page: Page) => page.getByTestId('radio-audio');
const audioTime = (page: Page) => radioAudio(page).evaluate((a: HTMLAudioElement) => a.currentTime);
const stored = (page: Page, key: string) => page.evaluate((k) => localStorage.getItem(k), key);
const storedEntries = async (page: Page): Promise<Entry[]> => JSON.parse((await stored(page, LOG_KEY)) ?? '[]');
const storedKinds = async (page: Page) => (await storedEntries(page)).map((e) => e.kind);
const nativePlay = (page: Page) => page.evaluate(() => /\[native code\]/.test(HTMLMediaElement.prototype.play.toString()));

function trackErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

async function openListen(page: Page) {
  await page.getByTestId('library-item').filter({ hasText: VIDEO_TITLE })
    .getByRole('button', { name: `Listen to ${VIDEO_TITLE}` }).click();
  const player = dialog(page).getByTestId('radio-player');
  await expect(player).toHaveAttribute('data-state', 'playing');
  const from = await audioTime(page);
  await expect.poll(() => audioTime(page)).toBeGreaterThan(from + 0.5);
  return player;
}

function expectNoSas(label: string, text: string) {
  for (const marker of SAS_MARKERS) expect(text, `${label} leaks "${marker}"`).not.toContain(marker);
}

test('off by default: no toggle, native play(), nothing recorded or loaded', async ({ page, browserName }) => {
  test.skip(mockedMediaUnavailable({ browserName }), MOCKED_MEDIA_REASON);
  const errors = trackErrors(page);
  const debugAssets: string[] = [];
  page.on('request', (r) => { if (/PlayerDebugPanel|player-debug\.css/.test(r.url())) debugAssets.push(r.url()); });
  await mockApi(page, 'visitor', { podcastV2: true });
  await page.goto('/podcast/library');
  await openListen(page);

  await expect(toggle(page)).toHaveCount(0);
  expect(await nativePlay(page)).toBe(true);
  expect(await page.evaluate(() => !('mediaSession' in navigator)
    || /\[native code\]/.test(navigator.mediaSession.setActionHandler.toString()))).toBe(true);
  expect(await stored(page, FLAG_KEY)).toBeNull();
  expect(await stored(page, LOG_KEY)).toBeNull();
  expect(debugAssets).toEqual([]);
  expect(errors).toEqual([]);
});

test('?debug=player logs Listen playback without SAS query strings; Copy, Share and Clear work', async ({ page, browserName }) => {
  test.skip(mockedMediaUnavailable({ browserName }), MOCKED_MEDIA_REASON);
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    const copied: string[] = [];
    const shared: ShareData[] = [];
    const handlers: Record<string, unknown> = {};
    Object.assign(w, { __copied: copied, __shared: shared, __mediaHandlers: handlers });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true, value: { writeText: async (text: string) => { copied.push(text); } },
    });
    Object.defineProperty(navigator, 'share', {
      configurable: true, value: async (data: ShareData) => { shared.push(data); },
    });
    // What reaches the browser's Media Session: the handlers as wrapped by the debug log.
    if ('mediaSession' in navigator) {
      const proto = Object.getPrototypeOf(navigator.mediaSession);
      const native = proto.setActionHandler;
      proto.setActionHandler = function (this: MediaSession, action: string, handler: unknown) {
        handlers[action] = handler;
        return native.call(this, action, handler);
      };
    }
  });
  const errors = trackErrors(page);
  await mockApi(page, 'visitor', { podcastV2: true });
  // Sign the radio audio like Blob storage does (short-lived SAS in the query string).
  await page.route((url) => url.pathname === `/api/podcast/library/${POD_VIDEO.job_id}`, (route) => {
    const item = podcastLibraryItem(POD_VIDEO.job_id, 'visitor', { podcastV2: true })!;
    const signed = `${item.audio_url}?${SAS}`;
    return route.fulfill({ json: { ...item, audio_url: signed, mp3_url: signed } });
  });
  await page.goto('/podcast/library?debug=player');
  await expect(toggle(page)).toHaveAccessibleName('Debug');
  await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false');
  await expect(panel(page)).toBeHidden();
  expect(await stored(page, FLAG_KEY)).toBe('player');
  expect(await nativePlay(page)).toBe(false);

  const player = await openListen(page);
  await expect(radioAudio(page)).toHaveAttribute('src', `${POD_VIDEO.mp3_url}?${SAS}`);

  // Persisted (≤ 1 write/s): the call, its outcome and the media events.
  await expect.poll(() => storedKinds(page)).toEqual(baseExpect.arrayContaining(
    ['session', 'loadstart', 'loadedmetadata', 'play()', 'play', 'playing', 'play() resolved'],
  ));
  const entries = await storedEntries(page);
  const src = new URL(POD_VIDEO.mp3_url, page.url()).href;
  expect(entries[0].kind).toBe('session');
  expect(entries[0].detail).toMatchObject({
    userAgent: baseExpect.stringContaining('Mozilla/'), viewport: baseExpect.stringMatching(/^\d+x\d+$/),
    devicePixelRatio: baseExpect.any(Number), standalone: false,
  });
  const playing = entries.find((e) => e.kind === 'playing')!;
  expect(playing.detail).toMatchObject({
    el: 'audio', testid: 'radio-audio', paused: false, playbackRate: 1, src, srcId: 1,
    currentTime: baseExpect.any(Number), duration: 30, readyState: baseExpect.any(Number), networkState: baseExpect.any(Number),
  });
  const call = entries.find((e) => e.kind === 'play()')!;
  expect(typeof call.detail.userActivation).toBe('boolean');
  for (const [i, e] of entries.entries()) {
    expect(e.t).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(e.dt).toBe(i === 0 ? 0 : Date.parse(e.t) - Date.parse(entries[i - 1].t));
  }

  // The panel lists them, newest first, above the open player dialog.
  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute('aria-expanded', 'true');
  const region = panel(page);
  await expect(region.getByRole('heading', { name: 'Player debug log' })).toBeVisible();
  const rows = region.getByTestId('player-debug-entry');
  for (const kind of ['play()', 'play', 'playing']) {
    await expect(rows.and(page.locator(`[data-kind="${kind}"]`))).not.toHaveCount(0);
  }
  const times = await rows.locator('time').evaluateAll((els) => els.map((el) => el.getAttribute('datetime')!));
  expect(times).toEqual([...times].sort().reverse());

  await region.getByRole('button', { name: 'Copy' }).click();
  await expect(region.getByRole('status')).toHaveText(/^Copied \d+ entries\.$/);
  await region.getByRole('button', { name: 'Share' }).click();
  await expect(region.getByRole('status')).toHaveText('Shared.');
  const [copied, shared] = await page.evaluate(() => {
    const w = window as unknown as { __copied: string[]; __shared: ShareData[] };
    return [w.__copied, w.__shared.map((d) => d.text ?? '')];
  });
  expect(copied).toHaveLength(1);
  expect(shared).toHaveLength(1);
  expect(copied[0]).toContain('"kind":"playing"');

  // A lock-screen "seek forward" runs through the logged handler into the player
  // (the panel covers the player: close it first, as on a phone).
  await toggle(page).click();
  await expect(region).toBeHidden();
  await player.getByTestId('radio-play').click();
  await expect(player).toHaveAttribute('data-state', 'paused');
  const before = await audioTime(page);
  await page.evaluate(() => {
    const w = window as unknown as { __mediaHandlers: Record<string, (d: MediaSessionActionDetails) => void> };
    w.__mediaHandlers.seekforward({ action: 'seekforward', seekOffset: 5 });
  });
  await expect.poll(() => audioTime(page)).toBeGreaterThan(before + 4);
  await toggle(page).click();
  await expect(rows.and(page.locator('[data-kind="mediasession"]')).first())
    .toContainText('action=seekforward · seekOffset=5');

  const texts = {
    panel: await region.innerText(),
    stored: (await stored(page, LOG_KEY)) ?? '',
    copied: copied[0],
    shared: shared[0],
  };
  for (const [label, text] of Object.entries(texts)) {
    expect(text, label).toContain('/media/pod-2.mp3');
    expectNoSas(label, text);
  }

  // Minimising (Escape) keeps the lock-screen controls; Stop clears them: null still reaches the browser untouched.
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
  expect(await page.evaluate(() => typeof (window as unknown as { __mediaHandlers: Record<string, unknown> })
    .__mediaHandlers.seekforward)).toBe('function');
  await page.getByTestId('mini-player').getByRole('button', { name: 'Stop and close player' }).click();
  await expect(page.getByTestId('mini-player')).toBeHidden();
  expect(await page.evaluate(() => (window as unknown as { __mediaHandlers: Record<string, unknown> })
    .__mediaHandlers.seekforward)).toBeNull();

  await region.getByRole('button', { name: 'Clear' }).click();
  await expect(region.getByRole('status')).toHaveText('Log cleared.');
  await expect(rows).toHaveCount(0);
  await expect(page.getByTestId('player-debug-count')).toHaveText('0');
  await expect.poll(() => stored(page, LOG_KEY)).toBeNull();
  expect(errors).toEqual([]);
});

test('the flag survives navigation and reloads; ?debug=off and Turn off clear it', async ({ page, browserName }) => {
  test.skip(mockedMediaUnavailable({ browserName }), MOCKED_MEDIA_REASON);
  const errors = trackErrors(page);
  await mockApi(page, 'visitor', { podcastV2: true });
  await page.goto('/podcast/library?debug=player');
  await expect(toggle(page)).toBeVisible();
  expect(await stored(page, FLAG_KEY)).toBe('player');

  await page.goto('/');
  await expect(toggle(page)).toBeVisible();
  expect(await nativePlay(page)).toBe(false);
  await page.goBack();
  await expect(page).toHaveURL(/\/podcast\/library\?debug=player$/);
  await expect(toggle(page)).toBeVisible();
  await page.goto('/podcast/library');
  await expect(page.getByTestId('library-item')).toHaveCount(3);
  await expect(toggle(page)).toBeVisible();
  // One persisted log across page loads: each load opens with a session entry.
  await expect.poll(async () => (await storedKinds(page)).filter((k) => k === 'session').length)
    .toBeGreaterThanOrEqual(3);

  await page.goto('/?debug=off');
  await expect(page.getByTestId('auth-controls')).toBeVisible();
  await expect(toggle(page)).toHaveCount(0);
  expect(await stored(page, FLAG_KEY)).toBeNull();
  expect(await nativePlay(page)).toBe(true);
  const kept = await stored(page, LOG_KEY);
  expect(kept).not.toBeNull();
  await page.goto('/podcast/library');
  await expect(page.getByTestId('library-item')).toHaveCount(3);
  await expect(toggle(page)).toHaveCount(0);
  expect(await stored(page, LOG_KEY)).toBe(kept); // nothing recorded while off

  // The panel's Turn off: flag cleared, reloaded without ?debug.
  await page.goto('/podcast/library?debug=player');
  await toggle(page).click();
  await panel(page).getByRole('button', { name: 'Turn off' }).click();
  await expect(page).toHaveURL(/\/podcast\/library$/);
  await expect(page.getByTestId('library-item')).toHaveCount(3);
  await expect(toggle(page)).toHaveCount(0);
  expect(await stored(page, FLAG_KEY)).toBeNull();
  expect(await nativePlay(page)).toBe(true);
  expect(errors).toEqual([]);
});

test('registerMediaElement logs a detached element once per event, attached or not', async ({ page, browserName }) => {
  test.skip(mockedMediaUnavailable({ browserName }), MOCKED_MEDIA_REASON);
  const errors = trackErrors(page);
  await mockApi(page, 'visitor', { podcastV2: true });
  await page.goto('/?debug=player');
  await expect(toggle(page)).toBeVisible();

  const logged = await page.evaluate(async () => {
    const hook = (window as unknown as { __ozRadioPlayerDebug: {
      registerMediaElement(el: HTMLMediaElement): void;
      getEntries(): { kind: string; detail: Record<string, unknown> }[];
    } }).__ozRadioPlayerDebug;
    const audio = new Audio();
    hook.registerMediaElement(audio);
    hook.registerMediaElement(audio); // idempotent
    const metadata = new Promise((resolve) => audio.addEventListener('loadedmetadata', resolve, { once: true }));
    audio.preload = 'metadata';
    audio.src = '/media/detached.mp3?sv=2025-05-05&se=2026-10-18&sig=SECRETSIGNATURE';
    await metadata;
    document.body.append(audio); // now also seen by the document listener: still logged once
    const rate = new Promise((resolve) => audio.addEventListener('ratechange', resolve, { once: true }));
    audio.playbackRate = 1.5;
    await rate;
    audio.remove();
    return hook.getEntries()
      .filter((e) => String(e.detail.src).endsWith('/media/detached.mp3'))
      .map((e) => ({ kind: e.kind, detached: e.detail.detached === true, text: JSON.stringify(e) }));
  });
  const of = (kind: string) => logged.filter((e) => e.kind === kind);
  expect(of('loadstart')).toHaveLength(1);
  expect(of('loadedmetadata')).toHaveLength(1);
  expect(of('ratechange')).toHaveLength(1);
  expect(of('loadstart')[0].detached).toBe(true);
  expect(of('ratechange')[0].detached).toBe(false);
  for (const e of logged) expectNoSas(e.kind, e.text);
  expect(errors).toEqual([]);
});

test('Copy falls back to selecting the log when the clipboard is unavailable', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
    document.execCommand = () => false;
  });
  const errors = trackErrors(page);
  await mockApi(page, 'visitor', { podcastV2: true });
  await page.goto('/?debug=player');
  await toggle(page).click();
  const region = panel(page);
  await expect(region.getByRole('button', { name: 'Share' })).toHaveCount(0);
  await region.getByRole('button', { name: 'Copy' }).click();
  const exported = region.getByTestId('player-debug-export');
  await expect(exported).toContainText('"kind":"session"');
  await expect(region.getByRole('status')).toHaveText(/selected below/);
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toContain('"kind":"session"');
  expect(errors).toEqual([]);
});
