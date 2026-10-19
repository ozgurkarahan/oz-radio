import { test, expect, type Page, type Route } from '@playwright/test';
import { mockApi } from './support/mock-api';

/**
 * Audience level option: the select on the podcast / video create pages must
 * send `audience_level` in the outgoing script request, and libraries show a
 * chip when an item carries one. Every /api call is mocked (no Azure).
 */

const DOC_ID = '0b5f2a7e-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
const SOURCE = { name: 'deck.md', mimeType: 'text/markdown', buffer: Buffer.from('# Title\n\nSome text.') };

async function openAsAdmin(page: Page, path: string) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await mockApi(page, 'admin');
  return { errors, go: () => page.goto(path) };
}

const json = (route: Route, body: unknown) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

/** Podcast mocks; resolves every captured POST /script/stream JSON body. */
async function mockPodcastFlow(page: Page) {
  const bodies: Record<string, unknown>[] = [];
  await page.route('**/api/podcast/ingest', (r) => json(r, {
    document: {
      id: 'doc-1', title: 'deck', source_kind: 'md', sections: [{ heading: '', text: 'Some text.' }],
      slide_images: [], slide_titles: [], slide_notes: [],
    },
  }));
  await page.route('**/api/podcast/script/stream', (r) => {
    bodies.push(JSON.parse(r.request().postData() || '{}'));
    const turn = { idx: 0, speaker: 'interviewer', text: 'Hello there.', slide_idx: null, word_timings: [] };
    return r.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: `event: turn\ndata: ${JSON.stringify(turn)}\n\nevent: done\ndata: {"script_id": "scr-0000aaaa"}\n\n`,
    });
  });
  return bodies;
}

/** Video mocks; resolves every captured POST /script/{doc_id} JSON body. */
async function mockVideoFlow(page: Page) {
  const bodies: Record<string, unknown>[] = [];
  const narration = {
    slide_index: 0, slide_image_ref: '', title: 'Intro', narration: 'Welcome.',
    voice: 'en-US-Ava:DragonHDLatestNeural', speaking_style: null, duration_hint_s: null,
  };
  await page.route('**/api/video/ingest', (r) => json(r, {
    doc_id: DOC_ID, title: 'deck', source_kind: 'pdf',
    slides: [{ index: 0, image_ref: '', title: 'Intro', preview_text: 'Hello' }],
  }));
  await page.route(`**/api/video/script/${DOC_ID}`, (r) => {
    const req = r.request();
    const script = { doc_id: DOC_ID, language: 'en-US', style: 'explainer', voice: narration.voice, narrations: [narration] };
    if (req.method() !== 'POST') return json(r, script);
    const body = JSON.parse(req.postData() || '{}');
    bodies.push(body);
    return r.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body: `${JSON.stringify({ event: 'narration', data: narration })}\n`
        + `${JSON.stringify({ event: 'done', data: { ...script, audience_level: body.audience_level ?? null } })}\n`,
    });
  });
  return bodies;
}

test.describe('Audience level — script requests', () => {
  test('podcast: selected level is sent as audience_level', async ({ page }) => {
    const { errors, go } = await openAsAdmin(page, '/podcast');
    const bodies = await mockPodcastFlow(page);
    await go();

    const select = page.getByLabel('Audience level');
    await expect(select).toBeVisible();
    await expect(select).toHaveValue('');
    await expect(select.locator('option')).toHaveText(['Any (default)', 'Beginner', 'Practitioner', 'Expert']);

    await page.locator('input[type=file]').setInputFiles(SOURCE);
    await select.selectOption('practitioner');
    const generate = page.getByRole('button', { name: /generate podcast script/i });
    await expect(generate).toBeEnabled();
    await generate.click();

    await expect.poll(() => bodies.length).toBe(1);
    expect(bodies[0]).toMatchObject({ document_id: 'doc-1', audience_level: 'practitioner', style: 'casual' });
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('podcast: "Any (default)" sends a null audience_level', async ({ page }) => {
    const { go } = await openAsAdmin(page, '/podcast');
    const bodies = await mockPodcastFlow(page);
    await go();
    await page.locator('input[type=file]').setInputFiles(SOURCE);
    await page.getByRole('button', { name: /generate podcast script/i }).click();
    await expect.poll(() => bodies.length).toBe(1);
    expect(bodies[0].audience_level ?? null).toBeNull();
  });

  test('podcast: hosts default to Sofia (interviewer) + Lucas (expert) and render with their names', async ({ page }) => {
    const { errors, go } = await openAsAdmin(page, '/podcast');
    await mockPodcastFlow(page);
    const renders: Record<string, any>[] = [];
    await page.route('**/api/podcast/render', (r) => {
      renders.push(JSON.parse(r.request().postData() || '{}'));
      return json(r, { id: 'job-0000aaaa', state: 'queued', progress: { stage: 'queued', completed: 0, total: 1, message: '' }, outputs: {} });
    });
    await go();
    await page.locator('input[type=file]').setInputFiles(SOURCE);
    await page.getByRole('button', { name: /generate podcast script/i }).click();
    await expect(page.getByRole('button', { name: 'Render podcast' })).toBeVisible();

    const interviewer = page.getByRole('article', { name: 'Interviewer' });
    const expert = page.getByRole('article', { name: 'Expert' });
    await expect(interviewer.getByLabel('Avatar')).toHaveValue('photo_female');
    await expect(interviewer.getByLabel('Display name')).toHaveValue('Sofia');
    await expect(expert.getByLabel('Avatar')).toHaveValue('photo_male');
    await expect(expert.getByLabel('Display name')).toHaveValue('Lucas');
    await expect(page.locator('.pc-transcript .pc-turn__name').first()).toHaveText('Sofia');

    // Swapping the avatar carries a default name along; a custom name is kept.
    await expert.getByLabel('Avatar').selectOption('photo_female');
    await expect(expert.getByLabel('Display name')).toHaveValue('Sofia');
    await expert.getByLabel('Avatar').selectOption('photo_male');
    await expect(expert.getByLabel('Display name')).toHaveValue('Lucas');
    await interviewer.getByLabel('Display name').fill('Host');
    await interviewer.getByLabel('Avatar').selectOption('photo_male');
    await expect(interviewer.getByLabel('Display name')).toHaveValue('Host');
    await interviewer.getByLabel('Avatar').selectOption('photo_female');
    await interviewer.getByLabel('Display name').fill('');

    await page.getByRole('button', { name: 'Render podcast' }).click();
    await expect.poll(() => renders.length).toBe(1);
    expect(renders[0].roles.interviewer).toMatchObject({ display_name: 'Sofia', avatar: 'photo_female' });
    expect(renders[0].roles.expert).toMatchObject({ display_name: 'Lucas', avatar: 'photo_male' });
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('video: selected level is sent as audience_level', async ({ page }) => {
    const { errors, go } = await openAsAdmin(page, '/video');
    const bodies = await mockVideoFlow(page);
    await go();

    const select = page.getByLabel('Audience level');
    await expect(select).toBeVisible();
    await expect(select).toHaveValue('');
    await expect(select.locator('option')).toHaveText(['Any (default)', 'Beginner', 'Practitioner', 'Expert']);

    await page.locator('input[type=file]').setInputFiles({ ...SOURCE, name: 'deck.pdf', mimeType: 'application/pdf' });
    await select.selectOption('expert');
    const generate = page.getByRole('button', { name: /generate narration/i });
    await expect(generate).toBeEnabled();
    await generate.click();

    await expect.poll(() => bodies.length).toBe(1);
    expect(bodies[0]).toMatchObject({ audience_level: 'expert', style: 'explainer', language: 'en-US' });
    expect(errors, errors.join('\n')).toEqual([]);
  });
});

test.describe('Audience level — library chip', () => {
  test('podcast + video libraries show the level when set', async ({ page }) => {
    await mockApi(page, 'admin');
    await page.route('**/api/podcast/library', (r) => json(r, [{
      job_id: 'pod-1', title: 'ai-agents-mcp', language: 'en-US', created_at: '2026-10-14T21:52:00Z',
      thumbnail_url: null, duration_sec: 114, speaker_names: ['Sofia', 'Lucas'], published: true, audience_level: 'beginner',
    }]));
    await page.route('**/api/video/library', (r) => json(r, [{
      job_id: 'vid-1', title: 'context-engineering-rag', language: 'en-US', created_at: '2026-10-15T00:05:00Z',
      thumbnail_url: null, duration_sec: 98, slide_count: 6, published: true, audience_level: 'expert',
    }, {
      job_id: 'vid-2', title: 'no-level', language: 'en-US', created_at: '2026-10-14T00:05:00Z',
      thumbnail_url: null, duration_sec: 50, slide_count: 3, published: true,
    }]));

    await page.goto('/podcast/library');
    // Rows carry the level chip of EpisodeRow (contracts §5.2); the player's meta keeps `audience-chip`.
    await expect(page.getByTestId('episode-level')).toHaveText('Beginner');

    await page.goto('/video/library');
    await expect(page.getByTestId('library-item')).toHaveCount(2);
    await expect(page.getByTestId('episode-level')).toHaveCount(1);
    await expect(page.getByTestId('episode-level')).toHaveText('Expert');
  });
});
