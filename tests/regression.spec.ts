import { test, expect, type Page } from '@playwright/test';
import { calls, DECKS, FR_NOTES, mockApi, type Role } from './support/mock-api';

/**
 * Behaviour lock for the UI redesign (non-regression).
 *
 * Every `/api/*` call is mocked in the browser so the suite is deterministic
 * and independent from Azure. Assertions target routes, roles and
 * `data-testid`s — never colours or marketing copy — so the visual redesign
 * must keep them passing unchanged.
 */

async function open(page: Page, role: Role, path: string) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await mockApi(page, role);
  await page.goto(path);
  await page.waitForLoadState('networkidle');
  return errors;
}

async function expectHealthy(page: Page, errors: string[]) {
  await expect(page.getByText('Something went wrong on this page')).toHaveCount(0);
  expect(errors, `uncaught page errors: ${errors.join('\n')}`).toEqual([]);
  const text = (await page.locator('#root').innerText()).trim();
  expect(text.length).toBeGreaterThan(20);
}

// Pre-rename localStorage key that getOrCreateUserId() migrates.
const LEGACY_USER_ID_KEY = 'deckfm.userId';

const ROUTES = [
  '/', '/live', '/decks', '/decks/deck-live/present', '/search', '/playlists', '/playlists/pl-1',
  '/podcast', '/podcast/library', '/video', '/video/library',
];

test.describe('Regression — every route renders', () => {
  for (const role of ['visitor', 'admin'] as Role[]) {
    for (const path of ROUTES) {
      test(`${role} ${path}`, async ({ page }) => {
        const errors = await open(page, role, path);
        await expectHealthy(page, errors);
      });
    }
  }
});

test.describe('Regression — navigation & auth gating', () => {
  test('primary nav links reach every public section', async ({ page }) => {
    await open(page, 'visitor', '/');
    for (const href of ['/decks', '/video/library', '/podcast/library']) {
      await page.locator(`a[href="${href}"]`).first().click();
      await expect(page).toHaveURL(new RegExp(`${href.replace(/\//g, '\\/')}$`));
    }
  });

  test('visitor sees "Owner sign-in" as a text link (never a sign-in button) and gated create pages', async ({ page }) => {
    await open(page, 'visitor', '/');
    await expect(page.getByTestId('auth-controls')).toBeVisible();
    await expect(page.getByTestId('auth-controls').getByRole('link', { name: 'Owner sign-in' })).toBeVisible();
    await expect(page.getByRole('button', { name: /sign in/i })).toHaveCount(0);
    for (const path of ['/video', '/podcast', '/search', '/playlists', '/live']) {
      await page.goto(path);
      await expect(page.getByTestId('gated-panel'), path).toBeVisible();
    }
  });

  test('admin sees create pages, not gated panels', async ({ page }) => {
    await open(page, 'admin', '/video');
    await expect(page.getByTestId('gated-panel')).toHaveCount(0);
    await expect(page.getByTestId('auth-controls').getByText(/sign out/i)).toBeVisible();
  });

  test('visitor never gets upload or publish controls on decks', async ({ page }) => {
    await open(page, 'visitor', '/decks');
    await expect(page.getByTestId('deck-upload-input')).toHaveCount(0);
    await expect(page.getByTestId('publish-toggle')).toHaveCount(0);
    await expect(page.getByTestId('auth-gate')).toBeVisible();
  });
});

test.describe('Regression — decks & presenter', () => {
  test('home live-demo CTA opens the live-demo deck', async ({ page }) => {
    await open(page, 'visitor', '/');
    const cta = page.getByTestId('home-try-live-demo');
    await expect(cta).toHaveText('Start the live demo');
    // the target is exactly the deck's present route: no fragment, no query
    await expect(cta).toHaveAttribute('href', /^\/decks\/deck-live\/present$/);
    await cta.click();
    await expect(page).toHaveURL(/\/decks\/deck-live\/present$/);
  });

  test('home demo note reflects whether demo Q&A is on, and the sessions left sit beside it', async ({ page }) => {
    await open(page, 'visitor', '/');
    await expect(page.getByTestId('home-demo-note')).toHaveText(/^Narration-only · up to 3 min · no sign-in$/);
    await expect(page.getByTestId('home-demo-quota')).toHaveCount(0);

    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await mockApi(page, 'visitor', {
      demoQa: { enabled: true, max_questions: 3, max_audio_seconds: 15 }, demoSessionSeconds: 300, demoRemainingToday: 4,
    });
    await page.reload();
    await expect(page.getByTestId('home-demo-note')).toHaveText(/^Ask questions by voice · up to 5 min · no sign-in$/);
    await expect(page.getByTestId('home-demo-quota')).toHaveText('4 live sessions left today');
    await expect(page.getByTestId('home-try-live-demo')).toHaveText('Start the live demo');
  });

  test('decks list renders one card per deck and opens the presenter', async ({ page }) => {
    await open(page, 'visitor', '/decks');
    await expect(page.getByTestId('deck-card')).toHaveCount(DECKS.length);
    await expect(page.getByTestId('try-live-demo-cta')).toBeVisible();
    await page.getByTestId('deck-open').nth(1).click();
    await expect(page).toHaveURL(/\/decks\/deck-plain\/present$/);
  });

  test('slide navigation moves forward and back', async ({ page }) => {
    await open(page, 'visitor', '/decks/deck-plain/present');
    const counter = page.getByTestId('slide-counter');
    await expect(counter).toContainText('1');
    await expect(page.getByTestId('slide-prev')).toBeDisabled();
    await page.getByTestId('slide-next').click();
    await expect(counter).toContainText('2');
    await page.getByTestId('slide-next').click();
    await expect(page.getByTestId('slide-next')).toBeDisabled();
    await page.getByTestId('slide-prev').click();
    await expect(counter).toContainText('2');
  });

  test('live-demo affordance only on live_demo decks', async ({ page }) => {
    await open(page, 'visitor', '/decks/deck-live/present');
    await expect(page.getByTestId('live-demo-available')).toBeVisible();
    await expect(page.getByTestId('demo-start')).toBeVisible();
    await page.goto('/decks/deck-plain/present');
    await expect(page.getByTestId('slide-counter')).toBeVisible();
    await expect(page.getByTestId('live-demo-available')).toHaveCount(0);
    await expect(page.getByTestId('demo-start')).toHaveCount(0);
  });

  test('admin presenter exposes avatar & voice selection', async ({ page }) => {
    await open(page, 'admin', '/decks/deck-plain/present');
    await expect(page.getByRole('combobox').first()).toBeVisible();
    await expect(page.getByRole('option', { name: 'Sofia' })).toHaveCount(1);
  });

  test('admin upload posts the file to /api/decks/upload', async ({ page }) => {
    await open(page, 'admin', '/decks');
    await page.getByTestId('deck-upload-input').setInputFiles({ name: 'x.pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', buffer: Buffer.from('PK') });
    await expect.poll(() => calls.some((c) => c.method === 'POST' && c.path === '/api/decks/upload')).toBe(true);
  });
});

test.describe('Regression — search, libraries, playlists', () => {
  test('search posts the query and renders results', async ({ page }) => {
    await open(page, 'admin', '/search');
    await page.getByTestId('search-input').fill('bias');
    await page.getByTestId('search-input').press('Enter');
    await expect(page.getByTestId('search-result').first()).toBeVisible();
    const post = calls.find((c) => c.path === '/api/search');
    expect(JSON.parse(post!.body!).query).toBe('bias');
  });

  for (const [path, src] of [['/video/library', '/media/vid-1.mp4'], ['/podcast/library', '/media/pod-1.mp4']] as const) {
    test(`${path}: clicking an item opens a player with the media source`, async ({ page }) => {
      await open(page, 'visitor', path);
      await expect(page.getByTestId('library-item')).toHaveCount(1);
      await page.getByTestId('library-item').first().click();
      await expect(page.getByTestId('library-player')).toHaveAttribute('src', src);
    });
  }

  test('playlists list opens the playlist player', async ({ page }) => {
    await open(page, 'admin', '/playlists');
    await expect(page.getByTestId('playlist-card')).toHaveCount(1);
    await page.getByTestId('playlist-card').getByRole('button').first().click();
    await expect(page).toHaveURL(/\/playlists\/pl-1$/);
    await page.getByTestId('playlist-start').click();
    await expect(page.getByTestId('slide-counter')).toBeVisible();
    await page.getByTestId('slide-next').click();
    await expect.poll(() => calls.some((c) => c.method === 'POST' && c.path === '/api/playlists/pl-1/progress')).toBe(true);
    await expect(page.getByTestId('playlist-prev-deck')).toBeDisabled();
    await page.getByTestId('playlist-next-deck').click();
    await expect(page.getByTestId('playlist-next-deck')).toBeDisabled();
  });

  test('playlist: a step picked while progress is loading is not overridden by the resume step', async ({ page }) => {
    let release!: () => void;
    let served = false;
    const gate = new Promise<void>((r) => { release = r; });
    await open(page, 'admin', '/playlists');
    await page.route(/\/api\/playlists\/pl-1\/progress(\?|$)/, async (r) => {
      if (r.request().method() !== 'GET') return r.fallback();
      await gate;
      served = true;
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        user_id: 'u', playlist_id: 'pl-1', last_deck_id: 'deck-plain', last_slide_index: 1, resume_deck_id: 'deck-plain',
        resume_slide_index: 1, completed_slides: { 'deck-live': [0, 1, 2] }, total_slides: 6, completed_count: 3, percent: 50,
        updated_at: '2026-10-14T00:00:00Z' }) });
    });
    await page.goto('/playlists/pl-1');
    const steps = page.locator('.pp-step');
    await expect(steps).toHaveCount(2);
    await steps.first().click();
    await expect(steps.first()).toHaveAttribute('aria-current', 'step');
    release();
    await expect.poll(() => served).toBe(true);
    await page.waitForTimeout(500);
    await expect(steps.first()).toHaveAttribute('aria-current', 'step');
    await expect(steps.nth(1)).not.toHaveAttribute('aria-current', 'step');
    await expect(page.getByText('Deck 1 of 2')).toBeVisible();
  });

  test('playlist: the pre-rename user id is migrated once to oz-radio.userId', async ({ page }) => {
    await open(page, 'admin', '/');
    await page.evaluate((k) => { localStorage.clear(); localStorage.setItem(k, 'u_legacy-123'); }, LEGACY_USER_ID_KEY);
    const progressUser = async () => {
      const req = page.waitForRequest((r) => r.method() === 'GET' && /\/api\/playlists\/pl-1\/progress\?/.test(r.url()));
      await page.goto('/playlists/pl-1');
      return new URL((await req).url()).searchParams.get('user_id');
    };
    expect(await progressUser()).toBe('u_legacy-123');
    const stored = () => page.evaluate((k) => ({ next: localStorage.getItem('oz-radio.userId'), old: localStorage.getItem(k) }), LEGACY_USER_ID_KEY);
    expect(await stored()).toEqual({ next: 'u_legacy-123', old: null });
    // A stale legacy key must never override the migrated id.
    await page.evaluate((k) => localStorage.setItem(k, 'u_other'), LEGACY_USER_ID_KEY);
    expect(await progressUser()).toBe('u_legacy-123');
    expect((await stored()).next).toBe('u_legacy-123');
  });

  test('playlist: a first-time user gets a fresh id under oz-radio.userId', async ({ page }) => {
    await open(page, 'admin', '/');
    await page.evaluate(() => localStorage.clear());
    const req = page.waitForRequest((r) => r.method() === 'GET' && /\/api\/playlists\/pl-1\/progress\?/.test(r.url()));
    await page.goto('/playlists/pl-1');
    const userId = new URL((await req).url()).searchParams.get('user_id');
    expect(userId).toMatch(/^u_[0-9a-f-]{36}$/);
    expect(await page.evaluate(() => localStorage.getItem('oz-radio.userId'))).toBe(userId);
    expect(await page.evaluate((k) => localStorage.getItem(k), LEGACY_USER_ID_KEY)).toBeNull();
  });
});

test.describe('Regression — redesign behaviours', () => {
  test('mobile menu sheet opens and navigates', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await open(page, 'visitor', '/');
    await page.getByRole('button', { name: /open menu/i }).click();
    const sheet = page.getByRole('navigation', { name: 'Sections' });
    await expect(sheet).toBeVisible();
    await sheet.getByRole('link', { name: 'Decks' }).click();
    await expect(page).toHaveURL(/\/decks$/);
    await expect(sheet).toHaveCount(0);
  });

  test('create menu is a keyboard-operable disclosure: Escape closes it and returns focus to its button', async ({ page }) => {
    await open(page, 'admin', '/');
    const trigger = page.getByRole('button', { name: /^Create/ });
    await trigger.focus();
    await page.keyboard.press('Enter');
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('list', { name: 'Create' })).toBeVisible();
    // a disclosure of links, not an ARIA menu
    await expect(page.getByRole('menu')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('list', { name: 'Create' })).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test('presenter controls work from the keyboard', async ({ page }) => {
    await open(page, 'visitor', '/decks/deck-plain/present');
    await page.getByTestId('slide-next').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('slide-counter')).toContainText('2');
    await page.getByTestId('slide-prev').focus();
    await page.keyboard.press(' ');
    await expect(page.getByTestId('slide-counter')).toContainText('1');
  });

  test('player modal traps focus, cycles Tab and restores focus on Escape', async ({ page }) => {
    await open(page, 'visitor', '/video/library');
    const trigger = page.getByTestId('library-item').first().locator('.episode-row__title');
    await trigger.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    const inDialog = () => page.evaluate(() => !!document.activeElement?.closest('[role=dialog]'));
    expect(await inDialog()).toBe(true);
    // Focusing something behind the scrim is pulled back into the dialog.
    await page.evaluate(() => (document.querySelector('.masthead__brand') as HTMLElement).focus());
    expect(await inDialog()).toBe(true);
    for (let i = 0; i < 6; i++) { await page.keyboard.press('Tab'); expect(await inDialog()).toBe(true); }
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test('demo countdown starts at the full session length on socket open and ticks exactly', async ({ page }) => {
    await page.clock.install();
    // Stub only the demo socket: it opens and stays silent (avatar still connecting).
    await page.addInitScript(() => {
      const Native = window.WebSocket;
      class FakeDemoSocket extends EventTarget {
        readyState = 0; onopen: any = null; onmessage: any = null; onclose: any = null; onerror: any = null;
        constructor(public url: string) {
          super();
          setTimeout(() => { this.readyState = 1; this.onopen?.(new Event('open')); }, 10);
        }
        send() {}
        close() { this.readyState = 3; }
      }
      (window as any).WebSocket = function (url: string, protocols?: any) {
        return String(url).includes('/ws/voice/demo') ? new FakeDemoSocket(url) : new Native(url, protocols);
      };
    });
    await open(page, 'visitor', '/decks/deck-live/present');
    await page.getByTestId('demo-start').click();
    await page.clock.runFor(50);
    const left = page.getByTestId('demo-time-left');
    await expect(left).toHaveText('Demo time left 3:00');
    await page.clock.runFor(1000);
    await expect(left).toHaveText('Demo time left 2:59');
    await page.clock.runFor(60_000);
    await expect(left).toHaveText('Demo time left 1:59');
  });

  test('host disc falls back to a monogram when the avatar image fails', async ({ page }) => {
    await mockApi(page, 'visitor');
    await page.route('**/static/avatars/photo_female.png', (r) => r.fulfill({ status: 404, body: '' }));
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const sofia = page.getByRole('img', { name: 'Sofia' }).first();
    await expect(sofia).toHaveAttribute('data-avatar-status', 'none');
    await expect(sofia).toContainText('S');
    const lucas = page.getByRole('img', { name: 'Lucas' }).first();
    await expect(lucas).toHaveAttribute('data-avatar-status', /keyed|original/);
  });
});

test.describe('Regression — speaker notes read aloud', () => {
  const notes = (page: Page) => page.getByTestId('slide-notes');

  test('admin sees the notes the avatar reads, in English by default', async ({ page }) => {
    const errors = await open(page, 'admin', '/decks/deck-plain/present');
    await expect(page.getByTestId('slide-notes-label')).toHaveText('Speaker notes — read aloud');
    await expect(page.getByTestId('slide-notes-text')).toHaveText('Notes 1');
    await expect(page.getByTestId('slide-notes-fallback')).toHaveCount(0);
    await expectHealthy(page, errors);
  });

  test('fr-FR shows the cached French translation on every slide', async ({ page }) => {
    await open(page, 'admin', '/decks/deck-plain/present');
    await page.getByRole('combobox', { name: 'Language' }).selectOption('fr-FR');
    await expect(notes(page).getByText('Speaker notes — read aloud')).toBeVisible();
    await expect(page.getByTestId('slide-notes-text')).toHaveText(FR_NOTES[0]);
    await expect(page.getByTestId('slide-notes-fallback')).toHaveCount(0);
    await page.getByTestId('slide-next').click();
    await expect(page.getByTestId('slide-notes-text')).toHaveText(FR_NOTES[1]);
    // Already cached: no translation request.
    expect(calls.some((c) => c.path.endsWith('/translate-notes'))).toBe(false);
  });

  test('an uncached language is translated on demand (admin) and narrated', async ({ page }) => {
    await open(page, 'admin', '/decks/deck-plain/present');
    await page.getByRole('combobox', { name: 'Language' }).selectOption('es-ES');
    await expect(page.getByTestId('slide-notes-text')).toHaveText('Notes es-ES 1');
    await expect(page.getByTestId('slide-notes-fallback')).toHaveCount(0);
    const post = calls.find((c) => c.method === 'POST' && c.path === '/api/decks/deck-plain/translate-notes');
    expect(JSON.parse(post!.body!).target_language).toBe('es-ES');
  });

  test('original notes are shown with a hint when no translation is available', async ({ page }) => {
    await mockApi(page, 'admin');
    await page.route('**/api/decks/*/translate-notes', (r) => r.fulfill({ status: 503, contentType: 'application/json', body: '{"detail":"Translation service not configured"}' }));
    await page.goto('/decks/deck-plain/present');
    await page.waitForLoadState('networkidle');
    await page.getByRole('combobox', { name: 'Language' }).selectOption('de-DE');
    await expect(page.getByTestId('slide-notes-text')).toHaveText('Notes 1');
    await expect(page.getByTestId('slide-notes-fallback')).toHaveText('Original language — translation not available yet');
  });

  test('visitors never receive or see speaker notes', async ({ page }) => {
    await open(page, 'visitor', '/decks/deck-live/present');
    await expect(page.getByTestId('slide-counter')).toBeVisible();
    await expect(notes(page)).toHaveCount(0);
    expect(calls.some((c) => c.path.endsWith('/translate-notes'))).toBe(false);
  });

  test('narrationFor keeps the avatar priority (translated → notes → body → title)', async ({ page }) => {
    await open(page, 'visitor', '/');
    const results = await page.evaluate(async () => {
      try {
        const modPath = '/src/services/narration.ts';
        const { narrationFor } = await import(/* @vite-ignore */ modPath);
        const full = { title: 'T', body: 'B', notes: 'N', translated_notes: { 'fr-FR': 'N-fr' } };
        return [
          narrationFor(full, 'en-US'),
          narrationFor(full, 'fr-FR'),
          narrationFor(full, 'de-DE'),
          narrationFor(full, 'fr-FR', 'fr-FR'),
          narrationFor({ ...full, notes: '' , translated_notes: {} }, 'fr-FR'),
          narrationFor({ title: 'T', body: '', notes: '' }, 'en-US'),
          narrationFor({ title: '', body: '', notes: '' }, 'fr-FR'),
          narrationFor({ title: 'T', body: 'B', notes: 'N' }, 'de-DE', 'de-DE'),
          // French deck narrated in English: the cached en-US translation is read.
          narrationFor({ title: 'T', notes: 'N-fr', translated_notes: { 'en-US': 'N-en' } }, 'en-US', 'fr-FR'),
          narrationFor({ title: 'T', notes: 'N-fr' }, 'en-US', 'fr-FR'),
        ];
      } catch {
        return null;
      }
    });
    test.skip(results === null, 'module import needs the Vite dev server');
    expect(results).toEqual([
      { text: 'N', source: 'notes', fallbackOriginal: false },
      { text: 'N-fr', source: 'translated_notes', fallbackOriginal: false },
      { text: 'N', source: 'notes', fallbackOriginal: true },
      { text: 'N', source: 'notes', fallbackOriginal: false },
      { text: 'B', source: 'body', fallbackOriginal: true },
      { text: 'T', source: 'title', fallbackOriginal: false },
      { text: '', source: 'none', fallbackOriginal: false },
      { text: 'N', source: 'notes', fallbackOriginal: false },
      { text: 'N-en', source: 'translated_notes', fallbackOriginal: false },
      { text: 'N-fr', source: 'notes', fallbackOriginal: true },
    ]);
  });
});

test.describe('Regression — testid inventory', () => {
  test('stable hooks still exist on their pages', async ({ page }) => {
    const expectations: [Role, string, string[]][] = [
      ['visitor', '/', ['auth-controls', 'home-try-live-demo']],
      ['visitor', '/decks', ['deck-card', 'deck-open', 'try-live-demo-cta', 'auth-gate']],
      ['admin', '/decks', ['deck-upload-input', 'publish-toggle', 'publish-badge', 'live-demo-toggle', 'live-demo-badge']],
      ['visitor', '/decks/deck-live/present', ['slide-prev', 'slide-next', 'slide-counter', 'live-demo-available', 'demo-avatar-controls', 'demo-start']],
      ['admin', '/playlists', ['recommend-playlist-btn', 'playlist-card']],
    ];
    for (const [role, path, ids] of expectations) {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await mockApi(page, role);
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      for (const id of ids) await expect(page.getByTestId(id).first(), `${role} ${path} → ${id}`).toBeAttached();
    }
  });
});
