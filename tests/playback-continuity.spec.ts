import { test, expect as baseExpect, type Page, type Route } from '@playwright/test';
import { MOCKED_MEDIA_REASON, RADIO_TRANSCRIPT, SHORT_TRANSCRIPT, mockApi, mockedMediaUnavailable } from './support/mock-api';

/**
 * Continuity (src/playback/queue.ts): which episode plays next, and the engine's auto-next.
 *
 * Episodes are short (2–4 min) and form series per language (Beginner → Practitioner → Expert,
 * FR / EN), listened to on a phone with the screen locked: when one ends, the next one of the
 * SAME language starts by itself on the same <audio> element; the end of a series reads
 * "Finished".
 *
 * The ordering runs in the browser on the real module (Vite serves the TypeScript source as
 * ESM). The engine runs on a series catalog served by this spec (`page.route` over the
 * tests/support/mock-api.ts mocks) with the real audio fixtures (`/media/*.mp3` = 30 s,
 * `/media/*.wav` = 6 s) served with byte ranges, so playback genuinely runs and ends.
 */

const expect = baseExpect.configure({ timeout: 15_000 });
test.describe.configure({ timeout: 90_000 });

const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const QUEUE_MODULE = '/src/playback/queue.ts';

// ---- Ordering (pure) ---------------------------------------------------------------------------

type Row = Record<string, unknown> & { job_id: string; language: string };
interface Link { next: string | null; previous: string | null; fromCatalog: boolean }
type Links = Record<string, Link>;

/** Admin `LibrarySummary` of a listenable, audio-only episode. */
const row = (jobId: string, language: string, level: string | null, createdAt: string, extra: Record<string, unknown> = {}): Row => ({
  job_id: jobId, title: jobId, document_title: `${jobId}.pptx`, created_at: createdAt, duration_sec: 180, language,
  style: 'explainer', audience_level: level, speaker_names: ['Ana', 'Marc'], turn_count: 6, thumbnail_url: null,
  published: true, format: 'audio', has_video: false, has_audio: true, audio_duration_sec: 180, ...extra,
});

/** Anonymous public DTO row (`_public_item`): no `audience_level`. */
const publicRow = (jobId: string, title: string, createdAt: string, language = 'en-US'): Row => ({
  job_id: jobId, title, created_at: createdAt, duration_sec: 180, audio_duration_sec: 180, language,
  format: 'audio', has_video: false, has_audio: true, thumbnail_url: null, hosts: [], speaker_names: [],
});

/**
 * `next` / `previous` of every `currents` episode (default: the catalog rows, as the engine
 * passes them), computed in the page by the real resolver. Also checks that the results are
 * entries of `catalog` and that the catalog is left untouched (pure).
 */
async function links(page: Page, catalog: Row[], currents: Row[] = catalog): Promise<Links> {
  return page.evaluate(async ({ path, catalog: rows, currents: asked }) => {
    const { nextEpisodeResolver: resolver } = await import(/* @vite-ignore */ path);
    const before = JSON.stringify(rows);
    const out: Record<string, { next: string | null; previous: string | null; fromCatalog: boolean }> = {};
    for (const current of asked) {
      const next = resolver.next(current, rows);
      const previous = resolver.previous(current, rows);
      out[current.job_id] = {
        next: next?.job_id ?? null,
        previous: previous?.job_id ?? null,
        fromCatalog: [next, previous].every((hit) => hit === null || rows.includes(hit)),
      };
    }
    if (JSON.stringify(rows) !== before) throw new Error('the resolver mutated the catalog');
    return out;
  }, { path: QUEUE_MODULE, catalog, currents });
}

/** The episodes auto-next plays from `first` (or lock-screen "previous" walks back). */
function chain(all: Links, first: string, dir: 'next' | 'previous' = 'next'): string[] {
  const ids = [first];
  for (let id = all[first]?.[dir]; id; id = all[id]?.[dir]) {
    if (ids.includes(id)) throw new Error(`cycle at ${id}: ${ids.join(' → ')}`);
    ids.push(id);
  }
  return ids;
}

test.describe('Continuity — series order (queue.ts)', () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page, 'visitor', { podcastV2: true });
    await page.goto('/');
  });

  test('same language only; audience level first (beginner → practitioner → expert), then oldest first', async ({ page }) => {
    // Newest first, like GET /api/podcast/library; EN and FR series interleaved.
    const catalog = [
      row('fr-e', 'fr-FR', 'expert', '2026-10-09T08:00:00.000000+00:00'),
      row('en-p', 'en-US', 'practitioner', '2026-10-08T08:00:00.000000+00:00'), // re-recorded after the expert one
      row('en-e', 'en-US', 'expert', '2026-10-07T08:00:00.000000+00:00'),
      row('fr-b', 'fr-FR', 'beginner', '2026-10-06T08:00:00.000000+00:00'),
      row('en-b2', 'en-US', 'beginner', '2026-10-05T08:00:00.000000+00:00'),
      row('en-b1', 'en-US', 'beginner', '2026-10-04T08:00:00.000000+00:00'),
      row('fr-p', 'fr-FR', 'practitioner', '2026-10-03T08:00:00.000000+00:00'),
      row('en-x', 'en-US', null, '2026-10-01T08:00:00.000000+00:00'), // oldest, but no level: after the levelled ones
    ];
    const all = await links(page, catalog);

    expect(chain(all, 'en-b1')).toEqual(['en-b1', 'en-b2', 'en-p', 'en-e', 'en-x']);
    expect(chain(all, 'en-x', 'previous')).toEqual(['en-x', 'en-e', 'en-p', 'en-b2', 'en-b1']);
    expect(chain(all, 'fr-b')).toEqual(['fr-b', 'fr-p', 'fr-e']);
    expect(chain(all, 'fr-e', 'previous')).toEqual(['fr-e', 'fr-p', 'fr-b']);
    // The ends of each series: nothing after the last, nothing before the first.
    expect(all['en-x'].next).toBeNull();
    expect(all['en-b1'].previous).toBeNull();
    expect(all['fr-e'].next).toBeNull();
    expect(all['fr-b'].previous).toBeNull();
    // Never across languages, and always an entry of the catalog.
    const languageOf = new Map(catalog.map((r) => [r.job_id, r.language]));
    for (const r of catalog) {
      const { next, previous, fromCatalog } = all[r.job_id];
      expect(fromCatalog, r.job_id).toBe(true);
      for (const hit of [next, previous]) if (hit) expect(languageOf.get(hit), `${r.job_id} → ${hit}`).toBe(r.language);
    }
  });

  test('without levels (public DTO): oldest first by instant, then title (numeric), whatever the catalog order', async ({ page }) => {
    const catalog = [
      publicRow('v-3', 'Part 3', '2026-10-03T10:00:00.000000+00:00'),
      publicRow('v-10', 'Part 10', '2026-10-02T09:00:00+00:00'),
      publicRow('v-2', 'Part 2', '2026-10-02T09:00:00+00:00'), // same instant: "Part 2" before "Part 10"
      publicRow('v-tz', 'Paris morning', '2026-10-02T10:30:00+02:00'), // 08:30 UTC
      publicRow('v-gb', 'London edition', '2026-10-01T12:00:00+00:00', 'en-GB'), // a regional variant is the same language
      publicRow('v-1', 'Part 1', '2026-10-01T09:00:00.123456+00:00'), // the backend's isoformat()
      publicRow('v-fr', 'Partie 1', '2026-09-30T09:00:00+00:00', 'fr-FR'),
      publicRow('v-undated', 'Bonus', ''), // no date: last
    ];
    const expected = ['v-1', 'v-gb', 'v-tz', 'v-2', 'v-10', 'v-3', 'v-undated'];

    const all = await links(page, catalog);
    expect(chain(all, 'v-1')).toEqual(expected);
    expect(chain(all, 'v-undated', 'previous')).toEqual([...expected].reverse());
    expect(all['v-fr']).toEqual({ next: null, previous: null, fromCatalog: true });

    const reversed = await links(page, [...catalog].reverse());
    expect(chain(reversed, 'v-1')).toEqual(expected);
  });

  test('only listenable episodes; an unknown current episode or language has no neighbours', async ({ page }) => {
    const catalog = [
      { job_id: 'en-legacy', title: 'Legacy episode', language: 'en-US', created_at: '2026-10-04T08:00:00+00:00', duration_sec: 114, thumbnail_url: null }, // pre-radio row: has audio
      row('en-2', 'en-US', 'practitioner', '2026-10-03T08:00:00+00:00'),
      row('en-private', 'en-US', 'beginner', '2026-10-02T12:00:00+00:00', { has_audio: false, audio_duration_sec: null }), // public DTO without public audio
      row('en-video', 'en-US', 'beginner', '2026-10-02T08:00:00+00:00', { format: 'video', has_video: true, has_audio: false }),
      row('en-1', 'en-US', 'beginner', '2026-10-01T09:00:00+00:00'),
      row('no-language', '', 'beginner', '2026-10-01T06:00:00+00:00'),
    ];
    const ghost = row('ghost', 'en-US', 'beginner', '2026-10-01T07:00:00+00:00');

    const all = await links(page, catalog, [...catalog, ghost]);
    expect(chain(all, 'en-1')).toEqual(['en-1', 'en-2', 'en-legacy']);
    expect(chain(all, 'en-legacy', 'previous')).toEqual(['en-legacy', 'en-2', 'en-1']);
    // An episode without audio is placed by its own row but never chosen.
    expect(all['en-video']).toMatchObject({ next: 'en-2', previous: 'en-1' });
    expect(all['no-language']).toMatchObject({ next: null, previous: null });
    expect(all.ghost).toMatchObject({ next: null, previous: null });

    const empty = await links(page, [], [catalog[4]]);
    expect(empty['en-1']).toMatchObject({ next: null, previous: null });
  });
});

// ---- Engine: auto-next on a phone ----------------------------------------------------------------

interface Episode {
  id: string;
  title: string;
  language: string;
  level: 'beginner' | 'practitioner' | 'expert' | null;
  createdAt: string;
  /** Radio fixture served by mock-api's /media route (mp3 = 30 s, wav = 6 s); null = video only. */
  audio: 'mp3' | 'wav' | null;
}

const EN_B: Episode = {
  id: 'en-b', title: 'Agents 101: Beginner', language: 'en-US', level: 'beginner', createdAt: '2026-10-10T08:00:00.000000+00:00', audio: 'mp3',
};
/** Video only, between episodes 1 and 2 by level and date: auto-next must skip it. */
const EN_KEYNOTE: Episode = {
  id: 'en-keynote', title: 'Agents 101: Keynote', language: 'en-US', level: 'beginner', createdAt: '2026-10-10T12:00:00.000000+00:00', audio: null,
};
/** Recorded before the practitioner episode: the level decides, not the date. */
const EN_E: Episode = {
  id: 'en-e', title: 'Agents 101: Expert', language: 'en-US', level: 'expert', createdAt: '2026-10-11T08:00:00.000000+00:00', audio: 'mp3',
};
const EN_P: Episode = {
  id: 'en-p', title: 'Agents 101: Practitioner', language: 'en-US', level: 'practitioner', createdAt: '2026-10-12T08:00:00.000000+00:00', audio: 'mp3',
};
/** The French cut: next after the EN expert episode if languages were mixed (same level, newer). */
const FR_E: Episode = {
  id: 'fr-e', title: 'Agents 101 (FR): Expert', language: 'fr-FR', level: 'expert', createdAt: '2026-10-14T08:00:00.000000+00:00', audio: 'wav',
};
/** Newest first, like the backend. */
const EPISODES = [FR_E, EN_P, EN_E, EN_KEYNOTE, EN_B];
const LIBRARY_API = '/api/podcast/library';
/** 30-s episodes are sought here: past 75 %, 4 s before `ended`. */
const NEAR_END = 26;

const srcOf = (e: Episode) => (e.audio ? `/media/${e.id}.${e.audio}` : null);
const transcriptOf = (e: Episode) => (e.audio === 'wav' ? SHORT_TRANSCRIPT : RADIO_TRANSCRIPT);

/** Admin `LibrarySummary` (the owner's view: with `audience_level`). */
function summaryOf(e: Episode) {
  const transcript = transcriptOf(e);
  return {
    job_id: e.id, title: e.title, document_title: `${e.title}.pptx`, created_at: e.createdAt,
    duration_sec: e.audio ? transcript.duration_sec : 40, language: e.language, style: 'explainer',
    audience_level: e.level, speaker_names: transcript.hosts.map((h) => h.display_name), turn_count: transcript.turns.length,
    thumbnail_url: null, published: true, format: e.audio ? 'audio' : 'video', has_video: !e.audio, has_audio: !!e.audio,
    audio_duration_sec: e.audio ? transcript.duration_sec : null, hosts: transcript.hosts,
  };
}

/** Admin `LibraryItem` with its renditions. */
function itemOf(e: Episode) {
  const audio = srcOf(e);
  const video = e.audio ? null : `/media/${e.id}.mp4`;
  return {
    ...summaryOf(e), mp4_url: video, video_url: video, mp3_url: audio, audio_url: audio, srt_url: null,
    audio_srt_url: null, scorm_url: null, cover_url: null, transcript: e.audio ? transcriptOf(e) : null,
  };
}

interface JournalEntry { kind: 'fetch' | 'ended'; path?: string; src: string | null; t?: number; d?: number | null }

/**
 * Page-side journal, in one clock: every fetch (with the radio's source and position at that
 * moment) and every media `ended` (captured before the player's own handler runs).
 */
function installJournal(page: Page) {
  return page.addInitScript(() => {
    const journal: Record<string, unknown>[] = [];
    Object.assign(window, { __ozJournal: journal });
    const radio = () => document.querySelector<HTMLAudioElement>('audio[data-testid="radio-audio"]');
    const nativeFetch = window.fetch;
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const audio = radio();
      journal.push({
        kind: 'fetch', path: new URL(url, location.href).pathname,
        src: audio?.getAttribute('src') ?? null, t: audio?.currentTime ?? 0, d: audio?.duration ?? null,
      });
      return nativeFetch.call(window, input, init);
    };
    document.addEventListener('ended', (e) => {
      journal.push({ kind: 'ended', src: (e.target as Element).getAttribute('src') });
    }, true);
  });
}

const readJournal = (page: Page) =>
  page.evaluate(() => (window as unknown as { __ozJournal: JournalEntry[] }).__ozJournal);

/** A journal fetch of `target`'s details made while the radio held `playing`. */
const detailFetch = (target: Episode, playing: Episode) => (j: JournalEntry) =>
  j.kind === 'fetch' && j.path === `${LIBRARY_API}/${target.id}` && j.src === srcOf(playing);

/**
 * The library as the owner (admin) sees it, serving this spec's series. Detail requests of
 * `hold` episodes fail (503, so nothing is cached) until `release()`; `heldServed()` counts them.
 */
async function openSeries(page: Page, hold: string[] = []) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const held = new Set(hold);
  let heldServed = 0;
  await installJournal(page);
  await mockApi(page, 'admin');
  await page.route((url) => url.pathname === LIBRARY_API || url.pathname.startsWith(`${LIBRARY_API}/`), (route: Route) => {
    const request = route.request();
    if (request.method() !== 'GET') return route.fallback();
    const path = new URL(request.url()).pathname;
    if (path === LIBRARY_API) return route.fulfill({ json: EPISODES.map(summaryOf) });
    const id = decodeURIComponent(path.slice(LIBRARY_API.length + 1));
    const episode = EPISODES.find((e) => e.id === id);
    if (!episode) return route.fulfill({ status: 404, json: { detail: 'Library item not found' } });
    if (held.has(id)) {
      heldServed += 1;
      return route.fulfill({ status: 503, json: { detail: 'Held by the test' } });
    }
    return route.fulfill({ json: itemOf(episode) });
  });
  await page.goto('/podcast/library');
  await expect(page.getByTestId('library-item')).toHaveCount(EPISODES.length);
  return { errors, release: () => held.clear(), heldServed: () => heldServed };
}

const rowOf = (page: Page, e: Episode) => page.getByTestId('library-item').filter({ hasText: e.title });
const dialog = (page: Page) => page.getByRole('dialog');
const mini = (page: Page) => page.getByTestId('mini-player');
const miniOpen = (page: Page, e: Episode) => mini(page).getByRole('button', { name: `Open now playing: ${e.title}`, exact: true });
const radioAudio = (page: Page) => page.getByTestId('radio-audio');
const audioState = (page: Page) => radioAudio(page).evaluate((a: HTMLAudioElement) => ({
  src: a.getAttribute('src'), paused: a.paused, ended: a.ended, t: a.currentTime,
}));

/** Marks the radio's <audio> element; `isTagged` tells whether the element on the page is still that one. */
const tagAudio = (page: Page) => radioAudio(page).evaluate((a) => { (a as unknown as { ozTag?: string }).ozTag = 'continuity'; });
const isTagged = (page: Page) => radioAudio(page).evaluate((a) => (a as unknown as { ozTag?: string }).ozTag === 'continuity');

/** Taps Listen on `e`'s row and waits for the Now Playing sheet to play it. */
async function listen(page: Page, e: Episode) {
  await rowOf(page, e).getByRole('button', { name: `Listen to ${e.title}`, exact: true }).tap();
  await expect(dialog(page).getByTestId('radio-player')).toHaveAttribute('data-state', 'playing');
  await expect(radioAudio(page)).toHaveAttribute('src', srcOf(e)!);
}

async function minimise(page: Page, e: Episode) {
  await dialog(page).getByRole('button', { name: 'Minimise player' }).tap();
  await expect(dialog(page)).toHaveCount(0);
  await expect(miniOpen(page, e)).toBeVisible();
}

/** Sets the radio's position (like scrubbing) and resolves once it has sought. */
async function seekRadio(page: Page, seconds: number) {
  await radioAudio(page).evaluate((a: HTMLAudioElement, to: number) => new Promise<void>((resolve) => {
    a.addEventListener('seeked', () => resolve(), { once: true });
    a.currentTime = to;
  }), seconds);
}

/** Waits until the radio plays `e` and moves forward. */
async function expectPlaying(page: Page, e: Episode) {
  await expect.poll(async () => {
    const { src, paused } = await audioState(page);
    return { src, paused };
  }).toEqual({ src: srcOf(e), paused: false });
  const from = (await audioState(page)).t;
  await expect.poll(async () => (await audioState(page)).t).toBeGreaterThan(from + 0.5);
}

test.describe('Continuity — auto-next on a phone', () => {
  test.use(PHONE);
  test.skip(mockedMediaUnavailable, MOCKED_MEDIA_REASON);

  test('when an episode ends, the next of the series starts on the same <audio>, prepared at ≥ 75 %', async ({ page }) => {
    // The library prefetches its first rows on load: fail episode 2's details until episode 1
    // plays, so the only fetch that can make it ready is the engine's own (past 75 %).
    const { errors, release, heldServed } = await openSeries(page, [EN_P.id]);
    await expect.poll(heldServed).toBeGreaterThanOrEqual(1);
    await listen(page, EN_B);
    await tagAudio(page);
    release();
    await minimise(page, EN_B);
    const preparesNext = detailFetch(EN_P, EN_B);

    // Through 67–70 % (too early to prepare), then near the end.
    await seekRadio(page, 20);
    await expect.poll(async () => (await audioState(page)).t).toBeGreaterThan(21);
    await seekRadio(page, NEAR_END);
    await expect(miniOpen(page, EN_P)).toBeVisible({ timeout: 20_000 });
    await expectPlaying(page, EN_P);
    expect(await isTagged(page)).toBe(true);
    await expect(mini(page)).toContainText(EN_P.title);
    await expect(mini(page).getByTestId('mini-player-status')).toHaveText(/is speaking|left$/);
    await expect(mini(page).getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/podcast\/library$/);

    // Episode 2's details were fetched while episode 1 played — only past 75 % — before it ended
    // (each fetch carries the radio's position at that instant).
    const journal = await readJournal(page);
    const preparing = journal.filter(preparesNext);
    const ended = journal.findIndex((j) => j.kind === 'ended' && j.src === srcOf(EN_B));
    expect(preparing.length, 'episode 2 prepared while episode 1 played').toBeGreaterThan(0);
    expect(ended, 'episode 1 ended').toBeGreaterThan(-1);
    expect(journal.indexOf(preparing[0]), 'prepared before the end').toBeLessThan(ended);
    for (const { t, d } of preparing) {
      expect(d).toBeCloseTo(30, 0);
      expect(t! / d!).toBeGreaterThanOrEqual(0.75);
    }
    // Nothing had to be fetched to switch inside `ended`.
    expect(journal.slice(ended).filter((j) => j.kind === 'fetch' && j.path === `${LIBRARY_API}/${EN_P.id}`)).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('with the Now Playing sheet open, its title and URL follow the next episode without a new history entry', async ({ page }) => {
    const { errors } = await openSeries(page);
    await listen(page, EN_B);
    await tagAudio(page);
    await expect(page).toHaveURL(new RegExp(`\\?episode=${EN_B.id}&mode=listen$`));
    const historyLength = await page.evaluate(() => history.length);

    await seekRadio(page, NEAR_END);
    await expect(page.getByRole('dialog', { name: EN_P.title, exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page).toHaveURL(new RegExp(`\\?episode=${EN_P.id}&mode=listen$`));
    expect(await page.evaluate(() => history.length)).toBe(historyLength);
    const player = dialog(page).getByTestId('radio-player');
    await expect(player).toHaveAttribute('data-state', 'playing');
    await expect(player).toHaveAccessibleName(`Audio player: ${EN_P.title}`);
    await expectPlaying(page, EN_P);
    expect(await isTagged(page)).toBe(true);
    await expect(mini(page)).toBeHidden();

    // The followed entry still pops back to the library.
    await minimise(page, EN_P);
    await expect(page).toHaveURL(/\/podcast\/library$/);
    expect(errors).toEqual([]);
  });

  test('the last episode of a series ends the session: "Finished", never an episode in another language', async ({ page }) => {
    const { errors } = await openSeries(page);
    await listen(page, EN_E);
    await tagAudio(page);
    await minimise(page, EN_E);

    await seekRadio(page, NEAR_END);
    const status = mini(page).getByTestId('mini-player-status');
    await expect(status).toHaveText('Finished', { timeout: 20_000 });
    await expect(miniOpen(page, EN_E)).toBeVisible();
    await expect(mini(page).getByRole('button', { name: 'Play', exact: true })).toBeVisible();
    expect(await audioState(page)).toMatchObject({ src: srcOf(EN_E), paused: true, ended: true });

    // Nothing starts afterwards — in particular not the French cut, next if languages were mixed.
    await page.waitForTimeout(1_500);
    expect(await audioState(page)).toMatchObject({ src: srcOf(EN_E), paused: true });
    await expect(status).toHaveText('Finished');
    expect(await isTagged(page)).toBe(true);
    expect(errors).toEqual([]);
  });

  test('lock-screen track buttons stay off: no nexttrack / previoustrack handlers, even with neighbours', async ({ page }) => {
    await page.addInitScript(() => {
      const calls: { action: string; handler: boolean }[] = [];
      Object.assign(window, { __ozMediaActions: calls });
      if (!('mediaSession' in navigator)) return;
      const proto = Object.getPrototypeOf(navigator.mediaSession);
      const native = proto.setActionHandler;
      proto.setActionHandler = function (this: MediaSession, action: MediaSessionAction, handler: MediaSessionActionHandler | null) {
        calls.push({ action, handler: typeof handler === 'function' });
        return native.call(this, action, handler);
      };
    });
    const { errors } = await openSeries(page);
    const around = await page.evaluate(async ({ path, id }) => {
      const queue = await import(/* @vite-ignore */ path);
      const catalog: { job_id: string }[] = await (await fetch('/api/podcast/library')).json();
      const current = catalog.find((s) => s.job_id === id);
      return {
        flag: queue.LOCKSCREEN_TRACK_BUTTONS,
        next: queue.nextEpisodeResolver.next(current, catalog)?.job_id ?? null,
        previous: queue.nextEpisodeResolver.previous(current, catalog)?.job_id ?? null,
      };
    }, { path: QUEUE_MODULE, id: EN_P.id });
    expect(around).toEqual({ flag: false, next: EN_E.id, previous: EN_B.id });

    // The middle episode, past 75 % (catalog loaded, next prepared), then through auto-next.
    await listen(page, EN_P);
    await seekRadio(page, NEAR_END);
    await expect(page).toHaveURL(new RegExp(`\\?episode=${EN_E.id}&mode=listen$`), { timeout: 20_000 });
    await expectPlaying(page, EN_E);

    const calls = await page.evaluate(() => (window as unknown as { __ozMediaActions: { action: string; handler: boolean }[] }).__ozMediaActions);
    const installed = calls.filter((c) => c.handler).map((c) => c.action);
    expect(installed).toEqual(baseExpect.arrayContaining(['play', 'pause', 'seekbackward', 'seekforward']));
    expect(installed.filter((a) => a === 'nexttrack' || a === 'previoustrack')).toEqual([]);
    // Every claim clears them explicitly (no stale handler from another player).
    expect(calls.some((c) => c.action === 'nexttrack' && !c.handler)).toBe(true);
    expect(calls.some((c) => c.action === 'previoustrack' && !c.handler)).toBe(true);
    expect(errors).toEqual([]);
  });
});

test.describe('Continuity — resilience (screen locked, flaky network)', () => {
  test.use(PHONE);
  test.skip(mockedMediaUnavailable, MOCKED_MEDIA_REASON);

  const nextDetails = (e: Episode) => (j: JournalEntry) => j.kind === 'fetch' && j.path === `${LIBRARY_API}/${e.id}`;
  const endedOf = (journal: JournalEntry[], e: Episode) => journal.findIndex((j) => j.kind === 'ended' && j.src === srcOf(e));

  test('a failed prefetch does not end the series: the next episode is fetched at `ended` and starts on the same <audio>', async ({ page }) => {
    const { errors, release, heldServed } = await openSeries(page, [EN_P.id]);
    await expect.poll(heldServed).toBeGreaterThanOrEqual(1); // the library prefetch failed
    await listen(page, EN_B);
    await tagAudio(page);
    await minimise(page, EN_B);

    const failedBefore = heldServed();
    await seekRadio(page, NEAR_END); // 4 s before the end: shorter than the retry interval
    await expect.poll(heldServed).toBeGreaterThan(failedBefore); // the near-end prefetch failed too
    release();

    await expect.poll(async () => endedOf(await readJournal(page), EN_B), { timeout: 20_000 }).toBeGreaterThan(-1);
    await expectPlaying(page, EN_P);
    expect(await isTagged(page)).toBe(true);
    await expect(miniOpen(page, EN_P)).toBeVisible();
    const journal = await readJournal(page);
    // Nothing was prepared: the details were fetched after `ended` (best effort).
    expect(journal.slice(endedOf(journal, EN_B)).filter(nextDetails(EN_P)).length).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });

  test('a failed near-end prefetch is retried while the episode plays, so `ended` swaps without a fetch', async ({ page }) => {
    const { errors, release, heldServed } = await openSeries(page, [EN_P.id]);
    await expect.poll(heldServed).toBeGreaterThanOrEqual(1);
    await listen(page, EN_B);
    await tagAudio(page);
    await minimise(page, EN_B);

    // Stretch the last quarter (7.4 s of audio at 0.5× ≈ 15 s) past the 10-s retry interval.
    await radioAudio(page).evaluate((a: HTMLAudioElement) => { a.playbackRate = 0.5; });
    const failedBefore = heldServed();
    await seekRadio(page, 22.6);
    await expect.poll(heldServed).toBeGreaterThan(failedBefore); // first near-end attempt failed
    release();
    const failed = heldServed();

    await expect.poll(async () => endedOf(await readJournal(page), EN_B), { timeout: 40_000 }).toBeGreaterThan(-1);
    await expectPlaying(page, EN_P);
    expect(await isTagged(page)).toBe(true);
    const journal = await readJournal(page);
    const ended = endedOf(journal, EN_B);
    // A retry before the end succeeded (more requests than failures), and `ended` needed no fetch.
    expect(journal.slice(0, ended).filter(nextDetails(EN_P)).length).toBeGreaterThan(failed);
    expect(journal.slice(ended).filter(nextDetails(EN_P))).toEqual([]);
    expect(errors).toEqual([]);
  });
});
