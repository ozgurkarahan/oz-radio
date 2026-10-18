import { test, expect as baseExpect, type Locator, type Page } from '@playwright/test';
import { POD_VIDEO, mockApi, podcastLibraryItem } from './support/mock-api';

/**
 * Resume points and the preferred speed (src/playback/progress.ts).
 *
 * The owner listens on a phone with the screen locked: after a call, a reload or a day he
 * resumes exactly where he stopped. Progress lives in localStorage `oz-radio.progress.v1`
 * (`{ v: 1, episodes: { <jobId>: { position, duration, done, updatedAt } } }`), the speed in
 * `oz-radio.speed`. Every /api call is mocked (tests/support/mock-api.ts); media are real
 * fixtures served with byte ranges, so seeking, pausing and `ended` genuinely happen.
 */

const expect = baseExpect.configure({ timeout: 15_000 });
test.describe.configure({ timeout: 90_000 });

const PROGRESS_KEY = 'oz-radio.progress.v1';
const SPEED_KEY = 'oz-radio.speed';
/** pod-2: 30 s radio MP3; no later episode in its language, so `ended` never auto-advances. */
const TITLE = 'Agents on air';
const EPISODE = POD_VIDEO.job_id;
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

interface Saved { position: number; duration: number; done: boolean; updatedAt: number }
interface RadioEvent { type: 'seeked' | 'playing'; t: number }

/** Init script: the radio's position at each `seeked` / `playing` (media events do not bubble: capture). */
function recordRadio() {
  const log: { type: string; t: number }[] = [];
  (window as unknown as { __radioLog: typeof log }).__radioLog = log;
  for (const type of ['seeked', 'playing']) {
    document.addEventListener(type, (event) => {
      const el = event.target;
      if (el instanceof HTMLMediaElement && el.dataset.testid === 'radio-audio') log.push({ type, t: el.currentTime });
    }, true);
  }
}

async function open(page: Page, path = '/podcast/library', setup?: (page: Page) => Promise<void>) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.addInitScript(recordRadio);
  await mockApi(page, 'visitor', { podcastV2: true });
  await setup?.(page);
  await page.goto(path);
  return errors;
}

/** Writes `oz-radio.progress.v1` before the app's first load (`ageMs` → `updatedAt` = now − ageMs). */
async function seedProgress(page: Page, episodes: Record<string, Omit<Saved, 'updatedAt'> & { ageMs: number }>) {
  await page.addInitScript(([key, seed]) => {
    if (sessionStorage.getItem('oz-test.seeded')) return; // once: reloads keep what the app saved
    sessionStorage.setItem('oz-test.seeded', '1');
    const now = Date.now();
    const out = Object.fromEntries(Object.entries(seed).map(([id, e]) => [
      id, { position: e.position, duration: e.duration, done: e.done, updatedAt: now - e.ageMs },
    ]));
    localStorage.setItem(key, JSON.stringify({ v: 1, episodes: out }));
  }, [PROGRESS_KEY, episodes] as const);
}

const rowOf = (page: Page, title = TITLE) => page.getByTestId('library-item').filter({ hasText: title });
const dialog = (page: Page) => page.getByRole('dialog');
const mini = (page: Page) => page.getByTestId('mini-player');
const radioAudio = (page: Page) => page.getByTestId('radio-audio');
const audioTime = (page: Page) => radioAudio(page).evaluate((a: HTMLAudioElement) => a.currentTime);
const audioRate = (page: Page) => radioAudio(page).evaluate((a: HTMLAudioElement) => a.playbackRate);
const radioLog = (page: Page) => page.evaluate(() => (window as unknown as { __radioLog?: RadioEvent[] }).__radioLog ?? []);
const readItem = (page: Page, key: string) => page.evaluate((k) => localStorage.getItem(k), key);

async function savedOf(page: Page, jobId = EPISODE): Promise<Saved | null> {
  const raw = await readItem(page, PROGRESS_KEY);
  return raw ? (JSON.parse(raw).episodes?.[jobId] ?? null) : null;
}

/** Sets a media element's position and resolves once it has seeked. */
async function seekMedia(media: Locator, seconds: number) {
  await media.evaluate((el: HTMLMediaElement, to: number) => new Promise<void>((resolve) => {
    el.addEventListener('seeked', () => resolve(), { once: true });
    el.currentTime = to;
  }), seconds);
}

const press = (locator: Locator, tap: boolean) => (tap ? locator.tap() : locator.click());

/** Listen on the episode's row; resolves once the radio plays. */
async function listen(page: Page, tap = false, title = TITLE) {
  await press(rowOf(page, title).getByRole('button', { name: `Listen to ${title}` }), tap);
  const player = dialog(page).getByTestId('radio-player');
  await expect(player).toHaveAttribute('data-state', 'playing');
  return player;
}

async function pause(player: Locator, tap = false) {
  await press(player.getByTestId('radio-play'), tap);
  await expect(player).toHaveAttribute('data-state', 'paused');
}

/** Minimises the Now Playing sheet: back on the library URL, the radio stays in the mini-player. */
async function minimise(page: Page) {
  await dialog(page).getByRole('button', { name: 'Minimise player' }).tap();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/podcast\/library$/);
}

/** Position of the `n`-th (0-based) `playing` / `seeked` event of the radio on this page. */
async function radioEvent(page: Page, type: RadioEvent['type'], n = 0): Promise<number> {
  await expect.poll(async () => (await radioLog(page)).filter((e) => e.type === type).length).toBeGreaterThan(n);
  return (await radioLog(page)).filter((e) => e.type === type)[n].t;
}

test.describe('Resume — on the phone', () => {
  test.use(PHONE);

  test('pause → reload → Listen resumes at the bookmark; a shared link opened cold lands there too', async ({ page }) => {
    const errors = await open(page);
    let player = await listen(page, true);
    await seekMedia(radioAudio(page), 12);
    await pause(player, true);
    const pausedAt = await audioTime(page);
    const first = (await savedOf(page))!;
    expect(first).toMatchObject({ done: false, duration: 30 });
    expect(first.position).toBeGreaterThan(11.9);
    expect(Math.abs(first.position - pausedAt)).toBeLessThan(0.05);

    // Back on the library (the sheet minimised), the app is reloaded and the episode tapped again.
    await minimise(page);
    await page.reload();
    player = await listen(page, true);
    expect(Math.abs((await radioEvent(page, 'playing')) - first.position)).toBeLessThanOrEqual(1);

    // Paused again, then the shared link loads in a fresh document (no tap): the radio is put back on the bookmark.
    await pause(player, true);
    const second = (await savedOf(page))!;
    expect(second.position).toBeGreaterThanOrEqual(first.position);
    await page.goto(`/podcast/library?episode=${EPISODE}&mode=listen`);
    await expect(dialog(page)).toHaveAttribute('data-mode', 'listen');
    await expect(dialog(page).getByTestId('radio-player')).toHaveAttribute('data-state', /^(playing|press-play|paused)$/);
    expect(Math.abs((await radioEvent(page, 'seeked')) - second.position)).toBeLessThanOrEqual(1);
    expect(errors).toEqual([]);
  });

  test('screen locked, then the tab killed: the bookmark is written at once and a new tab resumes there', async ({ context, page }) => {
    const errors = await open(page);
    await listen(page, true);
    await seekMedia(radioAudio(page), 10);
    await expect.poll(() => audioTime(page)).toBeGreaterThan(11);

    // Screen locked: the page goes hidden while the radio plays on.
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const lockedAt = await audioTime(page);
    const atLock = (await savedOf(page))!;
    expect(atLock.done).toBe(false);
    expect(Math.abs(atLock.position - lockedAt)).toBeLessThan(0.5);
    await page.evaluate(() => {
      delete (document as unknown as { visibilityState?: string }).visibilityState;
      document.dispatchEvent(new Event('visibilitychange'));
    });

    // The OS kills the tab a little later (close() fires pagehide).
    await expect.poll(() => audioTime(page)).toBeGreaterThan(lockedAt + 1.5);
    const realAt = await audioTime(page);
    await page.close();

    const next = await context.newPage();
    const nextErrors = await open(next);
    const saved = (await savedOf(next))!;
    expect(saved).toMatchObject({ done: false, duration: 30 });
    expect(Math.abs(saved.position - realAt)).toBeLessThanOrEqual(5);
    await listen(next, true);
    expect(Math.abs((await radioEvent(next, 'playing')) - saved.position)).toBeLessThanOrEqual(1);
    expect([...errors, ...nextErrors]).toEqual([]);
  });

  test('an episode heard to the end is marked done (position 0) and the next open starts from 0', async ({ page }) => {
    const errors = await open(page);
    await listen(page, true);
    await seekMedia(radioAudio(page), 29.5);
    await minimise(page);
    await expect(mini(page).getByTestId('mini-player-status')).toHaveText('Finished', { timeout: 20_000 });
    const saved = (await savedOf(page))!;
    expect(saved).toMatchObject({ done: true, position: 0, duration: 30 });

    await page.goto('/podcast/library');
    await listen(page, true);
    expect(await radioEvent(page, 'playing')).toBeLessThan(1);
    expect(errors).toEqual([]);
  });

  test('a bookmark older than a minute resumes 3 s earlier', async ({ page }) => {
    await seedProgress(page, { [EPISODE]: { position: 20, duration: 30, done: false, ageMs: 2 * 60_000 } });
    const errors = await open(page);
    await listen(page, true);
    const start = await radioEvent(page, 'playing');
    expect(start).toBeGreaterThanOrEqual(16.5);
    expect(start).toBeLessThanOrEqual(17.5);
    expect(errors).toEqual([]);
  });

  test('back from a call: a pause over a minute rewinds 3 s, a short one does not', async ({ page }) => {
    const errors = await open(page);
    const player = await listen(page, true);
    const seeks = async () => (await radioLog(page)).filter((e) => e.type === 'seeked').length;
    // Only the wall clock moves (`Date`); timers and the media keep their real pace.
    const t0 = Date.now();
    await seekMedia(radioAudio(page), 10);
    await page.clock.setFixedTime(t0);
    await pause(player, true);
    const shortPause = await audioTime(page);
    const seeksAtShortPause = await seeks();
    await page.clock.setFixedTime(t0 + 30_000);
    await press(player.getByTestId('radio-play'), true);
    await expect(player).toHaveAttribute('data-state', 'playing');
    await expect.poll(() => audioTime(page)).toBeGreaterThan(shortPause + 0.5);
    expect(await seeks(), 'no rewind after a 30 s pause').toBe(seeksAtShortPause);

    await seekMedia(radioAudio(page), 20);
    await pause(player, true);
    const longPause = await audioTime(page);
    const seeksAtLongPause = await seeks();
    await page.clock.setFixedTime(t0 + 30_000 + 2 * 60_000);
    await press(player.getByTestId('radio-play'), true);
    await expect(player).toHaveAttribute('data-state', 'playing');
    const rewoundTo = await radioEvent(page, 'seeked', seeksAtLongPause);
    expect(Math.abs(rewoundTo - (longPause - 3))).toBeLessThan(0.3);
    expect(errors).toEqual([]);
  });

  test('the chosen speed survives a reload', async ({ page }) => {
    const errors = await open(page);
    const player = await listen(page, true);
    const speed = player.getByTestId('radio-speed');
    await expect(speed).toHaveValue('1');
    await speed.selectOption('1.5');
    await expect.poll(() => audioRate(page)).toBe(1.5);
    expect(await readItem(page, SPEED_KEY)).toBe('1.5');

    await minimise(page);
    await page.reload();
    const again = await listen(page, true);
    await expect(again.getByTestId('radio-speed')).toHaveValue('1.5');
    await expect(again.getByTestId('radio-speed').locator('option:checked')).toHaveText('1.5×');
    await expect.poll(() => audioRate(page)).toBe(1.5);
    expect(errors).toEqual([]);
  });
});

test.describe('Resume — storage failures', () => {
  test('corrupted values: the page and the player work (from 0, at 1×) and the next save repairs the store', async ({ page }) => {
    await page.addInitScript(([progressKey, speedKey]) => {
      localStorage.setItem(progressKey, '{not json');
      localStorage.setItem(speedKey, 'fast');
    }, [PROGRESS_KEY, SPEED_KEY] as const);
    const errors = await open(page);
    const player = await listen(page);
    expect(await radioEvent(page, 'playing')).toBeLessThan(1);
    await expect(player.getByTestId('radio-speed')).toHaveValue('1');
    await seekMedia(radioAudio(page), 9);
    await pause(player);
    const saved = await savedOf(page);
    expect(saved).toMatchObject({ done: false, duration: 30 });
    expect(saved!.position).toBeGreaterThan(8.9);
    expect(errors).toEqual([]);
  });

  const BROKEN_STORAGE: [string, () => void][] = [
    ['blocked (SecurityError)', () => {
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        get() { throw new DOMException('The operation is insecure.', 'SecurityError'); },
      });
    }],
    ['full (QuotaExceededError)', () => {
      Storage.prototype.setItem = function setItem() {
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      };
    }],
    ['missing', () => {
      Object.defineProperty(window, 'localStorage', { configurable: true, value: undefined });
    }],
  ];

  for (const [name, breakStorage] of BROKEN_STORAGE) {
    test(`localStorage ${name}: playback works and the bookmark and speed hold for the visit`, async ({ page }) => {
      await page.addInitScript(breakStorage);
      const errors = await open(page);
      let player = await listen(page);
      await seekMedia(radioAudio(page), 12);
      await player.getByTestId('radio-speed').selectOption('1.25');
      await pause(player);
      const pausedAt = await audioTime(page);

      // Stop unloads the radio; opening the episode again resumes from memory.
      await page.keyboard.press('Escape');
      await mini(page).getByRole('button', { name: 'Stop and close player' }).click();
      await expect(radioAudio(page)).toHaveCount(0);
      const playedBefore = (await radioLog(page)).filter((e) => e.type === 'playing').length;
      player = await listen(page);
      expect(Math.abs((await radioEvent(page, 'playing', playedBefore)) - pausedAt)).toBeLessThanOrEqual(1);
      await expect(player.getByTestId('radio-speed')).toHaveValue('1.25');
      expect(errors).toEqual([]);
    });
  }

  test('only numbers and booleans are stored — never a media URL or a SAS token', async ({ page, baseURL }) => {
    const sas = 'sv=2025-05-05&se=2099-01-01T00%3A00%3A00Z&sr=b&sp=r&sig=c2VjcmV0';
    const signed = new URL(`${POD_VIDEO.mp3_url}?${sas}`, baseURL).href;
    const errors = await open(page, '/podcast/library', async (p) => {
      await p.route((url) => url.pathname === `/api/podcast/library/${EPISODE}`, (route) => {
        const item = podcastLibraryItem(EPISODE, 'visitor', { podcastV2: true })!;
        const cover = new URL(`${item.cover_url}?${sas}`, baseURL).href;
        return route.fulfill({ json: { ...item, audio_url: signed, mp3_url: signed, cover_url: cover } });
      });
    });
    const player = await listen(page);
    await expect(radioAudio(page)).toHaveAttribute('src', signed);
    // Every checkpoint: seeked, ratechange, pause, pagehide.
    await seekMedia(radioAudio(page), 8);
    await player.getByTestId('radio-speed').selectOption('2');
    await pause(player);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));

    const progress = JSON.parse((await readItem(page, PROGRESS_KEY))!);
    expect(Object.keys(progress)).toEqual(['v', 'episodes']);
    expect(progress.v).toBe(1);
    expect(Object.keys(progress.episodes)).toEqual([EPISODE]);
    const entry = progress.episodes[EPISODE];
    expect(Object.keys(entry)).toEqual(['position', 'duration', 'done', 'updatedAt']);
    expect(Object.values(entry).map((v) => typeof v)).toEqual(['number', 'number', 'boolean', 'number']);
    expect(await readItem(page, SPEED_KEY)).toBe('2');

    const stored = await page.evaluate(() => Object.keys(localStorage).map((k) => [k, localStorage.getItem(k) ?? ''] as const));
    expect(stored.length).toBeGreaterThan(0);
    for (const [key, value] of stored) {
      for (const needle of ['http', 'sig=', '?sv=', 'se=']) expect(value, `${key} must not contain "${needle}"`).not.toContain(needle);
    }
    expect(errors).toEqual([]);
  });
});

test.describe('Resume — the store, unit level (Vite dev server ESM)', () => {
  test('LRU 50, snapshot identity, notifications, save rules, rewind threshold, speed range, other tabs', async ({ page }) => {
    const errors = await open(page, '/');
    const r = await page.evaluate(async ([progressKey, speedKey]) => {
      type Snap = { position: number; duration: number; done: boolean; updatedAt: number };
      interface Store {
        get(id: string): Snap | null;
        save(id: string, position: number, duration: number): void;
        markDone(id: string): void;
        positionAfterPause(id: string, position: number, pausedForMs: number): number;
        getSpeed(): number | null;
        setSpeed(rate: number): void;
        subscribe(listener: () => void): () => void;
      }
      let s: Store;
      try {
        const path = '/src/playback/progress.ts';
        s = (await import(/* @vite-ignore */ path)).progressStore;
      } catch {
        return null;
      }
      const stored = () => JSON.parse(localStorage.getItem(progressKey) ?? 'null');
      const snap = (id: string) => {
        const v = s.get(id);
        return v && { position: v.position, duration: v.duration, done: v.done };
      };
      /** What another tab does: write the key, and this tab receives a `storage` event. */
      const fromOtherTab = (key: string, value: string | null) => {
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
        window.dispatchEvent(new StorageEvent('storage', { key, newValue: value, storageArea: localStorage }));
      };
      fromOtherTab(progressKey, null);
      fromOtherTab(speedKey, null);

      const rewind = [
        s.positionAfterPause('u', 20, 30_000),
        s.positionAfterPause('u', 20, 60_000),
        s.positionAfterPause('u', 20, 60_001),
        s.positionAfterPause('u', 20, 24 * 3600_000),
        s.positionAfterPause('u', 1.5, 120_000),
        s.positionAfterPause('u', 20, -5_000),
      ];

      // Identity and notifications.
      let calls = 0;
      const unsubscribe = s.subscribe(() => { calls += 1; });
      s.save('id-a', 12.3456, 30);
      const a1 = s.get('id-a');
      const a2 = s.get('id-a');
      s.save('id-b', 5, 30);
      const a3 = s.get('id-a');
      s.save('id-a', 13, 30);
      const a4 = s.get('id-a');
      const identity = {
        sameUntilChanged: a1 !== null && a1 === a2 && a2 === a3,
        newOnChange: a4 !== a3,
        frozen: Object.isFrozen(a4),
        unknown: s.get('id-unknown'),
        first: a1 && { position: a1.position, duration: a1.duration, done: a1.done, updatedAt: typeof a1.updatedAt },
      };
      const notified = [calls];
      s.markDone('id-a');
      notified.push(calls);
      s.save('id-a', Number.NaN, 30);
      s.save('id-a', 10, Number.POSITIVE_INFINITY);
      notified.push(calls);
      unsubscribe();
      s.save('id-c', 3, 30);
      notified.push(calls);

      // Save rules.
      s.save('r-end', 29.2, 30);
      s.save('r-clamp', 45, 30);
      s.save('r-near', 28.5, 30);
      s.save('r-neg', -4, 30);
      s.save('r-unknown', 7, 0);
      s.save('r-keep', 10, 30);
      s.save('r-keep', 11, 0);
      s.save('r-done', 10, 30);
      s.markDone('r-done');
      s.save('r-done', 0.4, 30);
      s.save('r-again', 10, 30);
      s.markDone('r-again');
      s.save('r-again', 4, 30);
      const url = 'https://acct.blob.core.windows.net/radio/a.mp3?sv=1&se=2&sig=3';
      s.save(url, 5, 30);
      s.save('', 5, 30);
      const rules = {
        end: snap('r-end'), clamp: snap('r-clamp'), near: snap('r-near'), neg: snap('r-neg'), unknown: snap('r-unknown'),
        keep: snap('r-keep'), done: snap('r-done'), again: snap('r-again'), refused: [s.get(url), s.get('')],
      };
      s.markDone('r-near');
      const markDoneKeepsDuration = snap('r-near');

      // Speed.
      const speeds: unknown[] = [s.getSpeed()];
      s.setSpeed(1.25);
      speeds.push(s.getSpeed(), localStorage.getItem(speedKey));
      for (const bad of [10, 0.25, Number.NaN]) s.setSpeed(bad);
      speeds.push(s.getSpeed(), localStorage.getItem(speedKey));
      for (const raw of ['9', 'fast', '', '0.4', '3.5', 'Infinity', '0.75', '3', '0.5']) {
        fromOtherTab(speedKey, raw);
        speeds.push(s.getSpeed());
      }

      // Another tab: the cache follows, untouched entries keep their identity, listeners hear it.
      let tabCalls = 0;
      const unsubscribeTab = s.subscribe(() => { tabCalls += 1; });
      const untouched = s.get('r-end');
      const data = stored();
      data.episodes['tab-x'] = { position: 42, duration: 60, done: false, updatedAt: Date.now() };
      fromOtherTab(progressKey, JSON.stringify(data));
      const keptIdentity = untouched !== null && s.get('r-end') === untouched;
      s.save('id-b', 6, 30);
      const stale = stored();
      stale.episodes['id-b'] = { position: 1, duration: 30, done: false, updatedAt: 1 };
      fromOtherTab(progressKey, JSON.stringify(stale));
      const otherTab = { adopted: snap('tab-x'), keptIdentity, newerHereWins: snap('id-b'), notified: tabCalls };
      unsubscribeTab();

      // Corrupted or wrongly shaped stores read as empty; invalid entries are skipped.
      const valid = JSON.stringify({ v: 1, episodes: { 'id-b': { position: 1, duration: 30, done: false, updatedAt: 1 } } });
      const shapes = ['{not json', '[]', 'null', '42', '"text"', JSON.stringify({ v: 1 }), JSON.stringify({ v: 1, episodes: [] }),
        JSON.stringify({ v: 1, episodes: null }), valid.replace('"v":1', '"v":2')];
      const wrongShapesEmpty = shapes.map((raw) => {
        fromOtherTab(progressKey, valid);
        const before = s.get('id-b') !== null;
        fromOtherTab(progressKey, raw);
        return before && s.get('id-b') === null;
      });
      fromOtherTab(progressKey, JSON.stringify({ v: 1, episodes: {
        ok: { position: 12, duration: 30, done: false, updatedAt: 5 },
        over: { position: 99, duration: 30, done: false, updatedAt: 5 },
        'bad-position': { position: '12', duration: 30, done: false, updatedAt: 5 },
        'bad-done': { position: 12, duration: 30, done: 'no', updatedAt: 5 },
        'bad-negative': { position: -1, duration: 30, done: false, updatedAt: 5 },
        'bad-time': { position: 12, duration: 30, done: false },
        [url]: { position: 12, duration: 30, done: false, updatedAt: 5 },
      } }));
      const mixed = {
        ok: snap('ok'), over: snap('over'),
        bad: ['bad-position', 'bad-done', 'bad-negative', 'bad-time', url].map((id) => s.get(id)),
      };

      // LRU: at most 50 episodes, the oldest save dropped first.
      fromOtherTab(progressKey, null);
      for (let i = 0; i < 60; i += 1) s.save(`lru-${i}`, 5, 30);
      const kept = Object.keys(stored().episodes);
      s.save('lru-10', 6, 30);
      s.save('lru-60', 5, 30);
      const lru = {
        count: kept.length, first: kept[0], last: kept[kept.length - 1], dropped: s.get('lru-9'),
        refreshedKept: s.get('lru-10') !== null, nextDropped: s.get('lru-11'), countAfter: Object.keys(stored().episodes).length,
      };
      fromOtherTab(progressKey, null);
      fromOtherTab(speedKey, null);
      return { rewind, identity, notified, rules, markDoneKeepsDuration, speeds, otherTab, wrongShapesEmpty, mixed, lru };
    }, [PROGRESS_KEY, SPEED_KEY] as const);
    test.skip(r === null, 'importing a source module needs the Vite dev server');
    const res = r!;

    expect(res.rewind).toEqual([20, 20, 17, 17, 0, 20]);
    expect(res.identity).toEqual({
      sameUntilChanged: true, newOnChange: true, frozen: true, unknown: null,
      first: { position: 12.346, duration: 30, done: false, updatedAt: 'number' },
    });
    expect(res.notified, 'three saves, a markDone, two ignored saves, then unsubscribed').toEqual([3, 4, 4, 4]);
    expect(res.rules).toEqual({
      end: { position: 0, duration: 30, done: true },
      clamp: { position: 0, duration: 30, done: true },
      near: { position: 28.5, duration: 30, done: false },
      neg: { position: 0, duration: 30, done: false },
      unknown: { position: 7, duration: 0, done: false },
      keep: { position: 11, duration: 30, done: false },
      done: { position: 0, duration: 30, done: true },
      again: { position: 4, duration: 30, done: false },
      refused: [null, null],
    });
    expect(res.markDoneKeepsDuration).toEqual({ position: 0, duration: 30, done: true });
    expect(res.speeds).toEqual([null, 1.25, '1.25', 1.25, '1.25', null, null, null, null, null, null, 0.75, 3, 0.5]);
    expect(res.otherTab).toEqual({
      adopted: { position: 42, duration: 60, done: false }, keptIdentity: true,
      newerHereWins: { position: 6, duration: 30, done: false }, notified: 2,
    });
    expect(res.wrongShapesEmpty).toEqual(Array(9).fill(true));
    expect(res.mixed).toEqual({
      ok: { position: 12, duration: 30, done: false }, over: { position: 30, duration: 30, done: false },
      bad: [null, null, null, null, null],
    });
    expect(res.lru).toEqual({
      count: 50, first: 'lru-10', last: 'lru-59', dropped: null, refreshedKept: true, nextDropped: null, countAfter: 50,
    });
    expect(errors).toEqual([]);
  });
});
