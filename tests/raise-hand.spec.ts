import { test, expect, type Page } from '@playwright/test';
import { avatar, mockApi, mockVoice, type VoiceMock, type VoiceMockOptions } from './support/mock-api';
import { demoHooks, mockDemoSocket } from './support/demo-ws-fixtures';

/**
 * WS4 — raise-hand voice Q&A. Chromium's fake microphone feeds the capture
 * worklet; the fake voice socket answers the qa.* contract; avatar turns are
 * finished through the dev-only window.__ozRadioTest hook.
 */

test.use({
  permissions: ['microphone'],
  launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] },
});

const DEMO_QA = { enabled: true, max_questions: 2, max_audio_seconds: 15 };

async function openAdmin(page: Page, opts: VoiceMockOptions = {}) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await mockApi(page, 'admin');
  const voice = await mockVoice(page, opts);
  await page.goto('/decks/deck-plain/present');
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'Connect avatar' }).click();
  await avatar.connected(page);
  return { voice, errors };
}

async function openDemo(page: Page, opts: VoiceMockOptions = {}, demoQa: typeof DEMO_QA | null = DEMO_QA) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await mockApi(page, 'visitor', { demoQa: demoQa ?? undefined, demoSessionSeconds: 300 });
  const voice = await mockVoice(page, opts);
  await page.goto('/decks/deck-live/present');
  await page.waitForLoadState('networkidle');
  await page.getByTestId('demo-start').click();
  await avatar.connected(page);
  return { voice, errors };
}

/** qa.begin → qa.ready + invite turn → finish invite → listening. */
async function reachListening(page: Page, voice: VoiceMock) {
  await expect.poll(() => voice.ofType('qa.begin').length).toBe(1);
  await expect(page.getByTestId('qa-state')).toHaveText('The presenter is inviting your question…');
  await expect.poll(() => voice.items.length).toBeGreaterThan(0);
  await avatar.finishTurn(page, voice.items[voice.items.length - 1]);
  await expect(page.getByTestId('qa-done')).toBeVisible();
  await expect(page.getByTestId('qa-done')).toBeFocused();
  await expect(page.getByTestId('qa-mic-level')).toBeVisible();
}

function expectFrames(voice: VoiceMock, requestId: string) {
  const frames = voice.ofType('qa.audio');
  expect(frames.length).toBeGreaterThan(0);
  frames.forEach((f, i) => {
    expect(f.request_id).toBe(requestId);
    expect(f.seq).toBe(i);
    const bytes = Buffer.from(f.audio, 'base64');
    expect(bytes.length).toBeGreaterThan(0);
    expect(bytes.length).toBeLessThanOrEqual(16384);
    expect(bytes.length % 2).toBe(0);
    expect(bytes.toString('base64')).toBe(f.audio);
  });
}

test.describe('Raise hand — admin', () => {
  test('voice question: begin → ready → audio frames → commit → transcript → answer → resume', async ({ page }) => {
    const { voice, errors } = await openAdmin(page);
    await expect(page.getByTestId('ask-now')).toHaveCount(0); // nothing narrating
    await page.getByTestId('raise-hand').click();
    await reachListening(page, voice);
    const begin = voice.ofType('qa.begin')[0];
    expect(begin).toMatchObject({ slide: 0, mode: 'after_slide' });
    expect(typeof begin.request_id).toBe('string');
    expect(begin.request_id.length).toBeLessThanOrEqual(64);

    await page.waitForTimeout(700);
    await page.getByTestId('qa-done').click();
    await expect.poll(() => voice.ofType('qa.commit').length).toBe(1);
    expect(voice.ofType('qa.commit')[0].request_id).toBe(begin.request_id);
    expectFrames(voice, begin.request_id);
    const commitIdx = voice.sent.findIndex((m) => m.type === 'qa.commit');
    expect(voice.sent.slice(commitIdx).some((m) => m.type === 'qa.audio')).toBe(false);

    await expect(page.getByTestId('qa-transcript')).toContainText('What drives the results?');
    await expect(page.getByTestId('qa-answer')).toContainText('growth comes from new markets');
    await expect(page.getByTestId('qa-answer-source')).toHaveText('From slide 2');
    expect(voice.ofType('qa.resume')).toHaveLength(0);

    await avatar.finishTurn(page, voice.items[voice.items.length - 1]);
    await expect.poll(() => voice.ofType('qa.resume')).toEqual([{ type: 'qa.resume', request_id: begin.request_id }]);
    // Not presenting → stays on the slide.
    await expect(page.getByTestId('slide-counter')).toContainText('Slide 1 of 3');
    await expect(page.getByTestId('raise-hand')).toBeVisible();
    expect(voice.ofType('response.create')).toHaveLength(0);
    expect(errors).toEqual([]);
  });

  test('hand raised mid-slide waits for the narration to finish, then the deck continues', async ({ page }) => {
    const { voice } = await openAdmin(page);
    await page.getByRole('button', { name: 'Present all' }).click();
    await expect.poll(() => voice.items.length).toBe(1);
    await avatar.startTurn(page, voice.items[0]);
    await expect(page.getByTestId('ask-now')).toBeVisible();
    await page.getByTestId('raise-hand').click();
    await expect(page.getByTestId('qa-state')).toHaveText('Hand raised — after this slide');
    await page.waitForTimeout(800);
    expect(voice.ofType('qa.begin')).toHaveLength(0);

    await page.evaluate((id) => {
      const t = (window as any).__ozRadioTest;
      t.dataChannel({ event: { eventType: 'EVENT_TYPE_TURN_END', turnID: id } });
      t.audioLevel(-90);
    }, voice.items[0]);
    await reachListening(page, voice);
    await expect(page.getByTestId('slide-counter')).toContainText('Slide 1 of 3');

    await page.getByTestId('qa-done').click();
    await expect.poll(() => voice.ofType('qa.commit').length).toBe(1);
    await expect(page.getByTestId('qa-answer')).toBeVisible();
    await avatar.finishTurn(page, voice.items[voice.items.length - 1]);
    await expect.poll(() => voice.ofType('qa.resume').length).toBe(1);
    // after_slide → advances to the next slide and narrates it.
    await expect(page.getByTestId('slide-counter')).toContainText('Slide 2 of 3');
    await expect.poll(() => voice.ofType('response.create').length).toBe(2);
  });

  test('Ask now interrupts, waits for silence, and re-narrates the same slide afterwards', async ({ page }) => {
    const { voice } = await openAdmin(page);
    await page.getByRole('button', { name: 'Present all' }).click();
    await expect.poll(() => voice.items.length).toBe(1);
    await avatar.startTurn(page, voice.items[0]);
    await page.getByTestId('ask-now').click();
    await expect.poll(() => voice.ofType('response.cancel').length).toBe(1);
    expect(voice.ofType('output_audio_buffer.clear')).toHaveLength(1);
    // Audio still loud → no qa.begin yet.
    await page.waitForTimeout(500);
    expect(voice.ofType('qa.begin')).toHaveLength(0);
    await page.evaluate(() => (window as any).__ozRadioTest.audioLevel(-90));
    await expect.poll(() => voice.ofType('qa.begin').length).toBe(1);
    expect(voice.ofType('qa.begin')[0]).toMatchObject({ mode: 'now', slide: 0 });
    await avatar.finishTurn(page, voice.items[voice.items.length - 1]);
    await expect(page.getByTestId('qa-done')).toBeVisible();
    await page.getByTestId('qa-done').click();
    await expect(page.getByTestId('qa-answer')).toBeVisible();
    await avatar.finishTurn(page, voice.items[voice.items.length - 1]);
    await expect.poll(() => voice.ofType('qa.resume').length).toBe(1);
    await expect.poll(() => voice.ofType('response.create').length).toBe(2);
    await expect(page.getByTestId('slide-counter')).toContainText('Slide 1 of 3');
    const prompts = voice.ofType('conversation.item.create').map((m) => m.item.content[0].text);
    expect(prompts[1]).toContain('Notes 1');
  });

  test('typed question sends qa.text after the invite (no microphone)', async ({ page }) => {
    const { voice } = await openAdmin(page);
    await page.getByTestId('qa-text-input').fill('What is the budget?');
    await page.getByTestId('qa-text-submit').click();
    await expect.poll(() => voice.ofType('qa.begin').length).toBe(1);
    expect(voice.ofType('qa.text')).toHaveLength(0);
    await avatar.finishTurn(page, voice.items[voice.items.length - 1]);
    await expect.poll(() => voice.ofType('qa.text').length).toBe(1);
    expect(voice.ofType('qa.text')[0]).toMatchObject({ text: 'What is the budget?', request_id: voice.ofType('qa.begin')[0].request_id });
    expect(voice.ofType('qa.audio')).toHaveLength(0);
    await expect(page.getByTestId('qa-answer')).toBeVisible();
  });

  test('changing slide while listening cancels the question first', async ({ page }) => {
    const { voice } = await openAdmin(page);
    await page.getByTestId('raise-hand').click();
    await reachListening(page, voice);
    await page.getByTestId('slide-next').click();
    await expect.poll(() => voice.ofType('qa.cancel').length).toBe(1);
    await expect(page.getByTestId('raise-hand')).toBeVisible();
    expect(voice.ofType('qa.commit')).toHaveLength(0);
  });

  test('qa.unavailable shows a message and a Continue button', async ({ page }) => {
    const { voice } = await openAdmin(page, { qaBegin: 'unavailable' });
    await page.getByTestId('raise-hand').click();
    await expect.poll(() => voice.ofType('qa.begin').length).toBe(1);
    await expect(page.getByTestId('qa-error')).toContainText("Questions aren't available");
    await page.getByTestId('qa-continue').click();
    await expect(page.getByTestId('raise-hand')).toBeDisabled();
    await expect(page.getByTestId('slide-counter')).toContainText('Slide 1 of 3');
  });
});

test.describe('Raise hand — public demo', () => {
  // `mockVoice` is an older (protocol v1) demo server: no captions, no typed question, no `demo.finish`. The v2 protocol
  // (captions, typed questions, narration complete…) is covered by ux-demo.spec.ts; one smoke of it follows here.
  test('older server (v1): no Ask now or typed field; the question is taken after the slide, the count goes down and the presentation goes on', async ({ page }) => {
    const { voice, errors } = await openDemo(page, { remainingQuestions: 2 });
    await expect(page.getByTestId('qa-remaining')).toHaveText('2 questions left');
    await expect(page.getByTestId('qa-text-input')).toHaveCount(0);
    // One Start tap presented the first slide by itself: visitors have no "Present all" / "Present this slide".
    await expect(page.getByRole('button', { name: /^Present/ })).toHaveCount(0);
    await expect.poll(() => voice.items.length).toBe(1);
    expect(voice.ofType('demo.speak')).toEqual([{ type: 'demo.speak', slide: 0 }]);
    await avatar.startTurn(page, voice.items[0]);
    await expect(page.getByTestId('ask-now')).toHaveCount(0);
    await page.getByTestId('raise-hand').click();
    await expect(page.getByTestId('qa-state')).toHaveText('Hand raised — after this slide');
    await page.evaluate((id) => {
      const t = (window as any).__ozRadioTest;
      t.dataChannel({ event: { eventType: 'EVENT_TYPE_TURN_END', turnID: id } });
      t.audioLevel(-90);
    }, voice.items[0]);
    await reachListening(page, voice);
    expect(voice.ofType('qa.begin')[0].mode).toBe('after_slide');
    await page.getByTestId('qa-done').click();
    await expect.poll(() => voice.ofType('qa.commit').length).toBe(1);
    expectFrames(voice, voice.ofType('qa.begin')[0].request_id);
    await expect(page.getByTestId('qa-answer')).toBeVisible();
    await avatar.finishTurn(page, voice.items[voice.items.length - 1]);
    await expect.poll(() => voice.ofType('qa.resume').length).toBe(1);
    await expect(page.getByTestId('qa-remaining')).toHaveText('1 question left');
    // The presentation was running: after the answer it goes on with the next slide, with no further tap.
    await expect(page.getByTestId('slide-counter')).toContainText('Slide 2 of 3');
    await expect.poll(() => voice.ofType('demo.speak').map((m) => m.slide)).toEqual([0, 1]);
    expect(voice.sent.some((m) => m.type === 'qa.text' || m.type === 'session.update' || m.type === 'response.create')).toBe(false);
    expect(errors).toEqual([]);
  });

  test('older server (v1): question limit — error with Continue, then Raise hand is disabled', async ({ page }) => {
    const { voice } = await openDemo(page, { qaBegin: 'limit' });
    await expect.poll(() => voice.items.length).toBe(1);
    await page.getByTestId('raise-hand').click();
    await avatar.finishTurn(page, voice.items[0]); // the slide ends: the raised hand is taken
    await expect.poll(() => voice.ofType('qa.begin').length).toBe(1);
    await expect(page.getByTestId('qa-error')).toHaveText('No more questions in this demo.');
    await expect(page.getByTestId('qa-continue')).toBeFocused();
    await page.getByTestId('qa-continue').click();
    await expect(page.getByTestId('raise-hand')).toBeDisabled();
    await expect(page.getByTestId('qa-remaining')).toHaveText('0 questions left');
    await expect(page.getByTestId('qa-disabled')).toBeVisible();
  });

  test('demo Q&A disabled in /api/demo/config → no Raise hand', async ({ page }) => {
    await openDemo(page, {}, null);
    await expect(page.getByTestId('demo-stop')).toBeVisible();
    await expect(page.getByRole('button', { name: /^Present/ })).toHaveCount(0);
    await expect(page.getByTestId('raise-hand')).toHaveCount(0);
    await expect(page.getByTestId('qa-text-input')).toHaveCount(0);
  });

  test('protocol v2: the typed question sits next to Raise hand and goes out after the slide (qa.ask_text)', async ({ page }) => {
    await mockApi(page, 'visitor', { demoQa: DEMO_QA, demoSessionSeconds: 300 });
    const mock = await mockDemoSocket(page, { slideCount: 3, idleCloseMs: false });
    await page.goto('/decks/deck-live/present');
    await page.waitForLoadState('networkidle');
    await page.getByTestId('demo-start').click();
    await demoHooks.connected(page);
    await expect(page.getByTestId('raise-hand')).toBeVisible();
    await page.getByTestId('qa-text-input').fill('What is the budget?');
    await page.getByTestId('qa-text-input').press('Enter');
    await expect(page.getByTestId('qa-state')).toHaveText('Your question is queued — answered after this slide');
    await expect.poll(() => mock.items.length).toBe(1);
    await demoHooks.finishLastTurn(page, mock);
    const ask = await mock.waitForSent('qa.ask_text');
    expect(ask).toMatchObject({ slide: 0, text: 'What is the budget?' });
    await expect(page.getByTestId('qa-answer')).toBeVisible();
    expect(mock.ofType('qa.begin')).toHaveLength(0);
  });
});

test.describe('Raise hand — microphone denied', () => {
  test('a blocked microphone shows a clear message and sends nothing', async ({ page }) => {
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
    });
    const { voice, errors } = await openAdmin(page);
    await page.getByTestId('raise-hand').click();
    await expect(page.getByTestId('qa-notice')).toHaveText('Microphone access was blocked. Allow the microphone for this site to ask a question.');
    await expect(page.getByTestId('raise-hand')).toBeEnabled();
    expect(voice.ofType('qa.begin')).toHaveLength(0);
    expect(errors).toEqual([]);
  });
});

test.describe('Capture framing (unit)', () => {
  test('manual Done before speech flushes the pre-roll in a few frames of at most 16384 bytes', async ({ page }) => {
    await mockApi(page, 'visitor');
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const r = await page.evaluate(async () => {
      try {
        const modPath = '/src/services/voiceCapture.ts';
        const { CaptureSegmenter } = await import(/* @vite-ignore */ modPath);
        const run = (chunks: number, rms: number, finish: string | null) => {
          const frames: number[] = [];
          const seg = new CaptureSegmenter({}, (f: Uint8Array) => frames.push(f.length));
          let reason: string | null = null;
          for (let i = 0; i < chunks && !reason; i++) reason = seg.push(new Uint8Array(640), rms); // 20 ms chunks
          if (!reason && finish) seg.end(finish); else if (reason) seg.end(reason);
          return { reason, frames, bytes: frames.reduce((a, b) => a + b, 0) };
        };
        return {
          // 4.9 s of sub-threshold audio, then Done: pre-roll capped at 3 s.
          manualQuiet: run(245, 0.004, 'manual'),
          // 5 s of silence: no_speech, nothing sent.
          silence: run(260, 0.0, null),
          // 2 s of speech: streamed as 100 ms frames.
          speech: run(100, 0.05, 'manual'),
        };
      } catch {
        return null;
      }
    });
    test.skip(r === null, 'module import needs the Vite dev server');
    expect(r!.manualQuiet.reason).toBeNull();
    expect(r!.manualQuiet.bytes).toBe(96000);
    expect(r!.manualQuiet.frames.length).toBeLessThanOrEqual(6);
    expect(Math.max(...r!.manualQuiet.frames)).toBeLessThanOrEqual(16384);
    expect(r!.silence).toEqual({ reason: 'no_speech', frames: [], bytes: 0 });
    expect(r!.speech.bytes).toBe(64000);
    expect(r!.speech.frames.every((n) => n <= 3200 && n % 2 === 0)).toBe(true);
    expect(r!.speech.frames.length).toBe(20);
  });
});

test.describe('Raise hand — playlist deck switch', () => {
  async function openPlaylist(page: Page) {
    await mockApi(page, 'admin');
    const voice = await mockVoice(page);
    await page.goto('/playlists/pl-1');
    await page.waitForLoadState('networkidle');
    await page.getByTestId('playlist-start').click();
    await avatar.connected(page);
    await expect.poll(() => voice.items.length).toBe(1); // auto-presents deck 1, slide 1
    return voice;
  }

  test('a question in flight is cancelled (qa.cancel) before context.switch', async ({ page }) => {
    const voice = await openPlaylist(page);
    await avatar.startTurn(page, voice.items[0]);
    await page.getByTestId('ask-now').click();
    await page.evaluate(() => (window as any).__ozRadioTest.audioLevel(-90));
    await expect.poll(() => voice.ofType('qa.begin').length).toBe(1);
    await expect(page.getByTestId('qa-state')).toHaveText('The presenter is inviting your question…');
    const rid = voice.ofType('qa.begin')[0].request_id;
    await page.getByTestId('playlist-next-deck').click();
    await expect.poll(() => voice.ofType('context.switch').length).toBe(1);
    const cancelIdx = voice.sent.findIndex((m) => m.type === 'qa.cancel' && m.request_id === rid);
    const switchIdx = voice.sent.findIndex((m) => m.type === 'context.switch');
    expect(cancelIdx).toBeGreaterThanOrEqual(0);
    expect(cancelIdx).toBeLessThan(switchIdx);
    await expect(page.getByTestId('raise-hand')).toBeVisible();
  });

  test('narration in progress: response.cancel + output_audio_buffer.clear, and the new deck waits for quiet', async ({ page }) => {
    const voice = await openPlaylist(page);
    await avatar.startTurn(page, voice.items[0]); // old deck audio still loud
    const keepLoud = setInterval(() => { void page.evaluate(() => (window as any).__ozRadioTest?.audioLevel(-20)).catch(() => {}); }, 100);
    try {
      await page.getByTestId('playlist-next-deck').click();
      await expect.poll(() => voice.ofType('context.switch').length).toBe(1);
      expect(voice.ofType('response.cancel').length).toBeGreaterThanOrEqual(1);
      expect(voice.ofType('output_audio_buffer.clear')).toHaveLength(1);
      // Still loud: the new deck does not start for a while (bounded at 3 s).
      await page.waitForTimeout(1500);
      expect(voice.ofType('response.create')).toHaveLength(1);
      await expect.poll(() => voice.ofType('response.create').length, { timeout: 5000 }).toBe(2);
      // The new turn began during residual audio: not "heard" from the old tail.
      const snap = await page.evaluate(() => (window as any).__ozRadioTest.playback());
      expect(snap).toMatchObject({ kind: 'slide', heard: false });
    } finally {
      clearInterval(keepLoud);
    }
    const prompts = voice.ofType('conversation.item.create').map((m) => m.item.content[0].text);
    expect(prompts[1]).toContain('Notes 1');
  });

  test('Disconnect sticks in the playlist player (no auto-reconnect) until Connect avatar', async ({ page }) => {
    const voice = await openPlaylist(page);
    expect(voice.ofType('session.update')).toHaveLength(1);
    await page.getByRole('button', { name: 'Disconnect' }).click();
    await expect(page.getByRole('button', { name: 'Connect avatar' })).toBeVisible();
    await page.waitForTimeout(2500);
    expect(voice.ofType('session.update'), 'no new voice session after Disconnect').toHaveLength(1);
    // Changing deck while disconnected does not reconnect either.
    await page.getByTestId('playlist-next-deck').click();
    await page.waitForTimeout(1500);
    expect(voice.ofType('session.update')).toHaveLength(1);
    await expect(page.getByRole('button', { name: 'Connect avatar' })).toBeVisible();
    await page.getByRole('button', { name: 'Connect avatar' }).click();
    await expect.poll(() => voice.ofType('session.update').length).toBe(2);
    await avatar.connected(page);
    await expect(page.getByRole('button', { name: 'Disconnect' })).toBeVisible();
  });
});
