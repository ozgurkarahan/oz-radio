import { test, expect, type Page } from '@playwright/test';
import { avatar, calls, mockApi, mockVoice } from './support/mock-api';

/**
 * WS3 — playback-driven slide advance and the honest demo countdown.
 *
 * The playback controller is pure TS: its rules are exercised in the page with
 * an injected clock (the module is served by the Vite dev server). The UI
 * tests drive a fake Voice Live socket plus the dev-only window.__ozRadioTest
 * hook (no real WebRTC in the mocks).
 */

async function loadPlayback(page: Page) {
  await mockApi(page, 'visitor');
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  const ok = await page.evaluate(async () => {
    try {
      const modPath = '/src/services/avatarPlayback.ts';
      (window as any).__pb = await import(/* @vite-ignore */ modPath);
      return true;
    } catch {
      return false;
    }
  });
  test.skip(!ok, 'module import needs the Vite dev server');
}

test.describe('Playback controller (unit)', () => {
  test('early response.done never completes; TURN_END + 700 ms silence does', async ({ page }) => {
    await loadPlayback(page);
    const r = await page.evaluate(() => {
      const { AvatarPlayback } = (window as any).__pb;
      let now = 0;
      const done: any[] = [];
      const pb = new AvatarPlayback({ now: () => now, onComplete: (c: any) => done.push(c) });
      pb.setAnalyserAvailable(true);
      pb.begin('slide', { chars: 185 });
      pb.onServerEvent({ type: 'response.created', response: { id: 'r1' } });
      pb.onServerEvent({ type: 'response.output_item.added', response_id: 'r1', item: { id: 'i1' } });
      now = 800; pb.onDataChannelMessage(JSON.stringify({ event: { eventType: 'EVENT_TYPE_TURN_START', turnID: 'i1' } }));
      now = 1350; pb.onAudioLevel(-25);
      now = 3000; pb.onServerEvent({ type: 'response.done', response: { id: 'r1' } });
      const afterDone = done.length;
      for (now = 3050; now <= 11000; now += 50) pb.onAudioLevel(now % 1000 < 400 ? -60 : -22);
      const whileTalking = done.length;
      now = 11050; pb.onAudioLevel(-22);
      now = 11100; pb.onDataChannelMessage({ event: { eventType: 'EVENT_TYPE_TURN_END', turnID: 'i1' } });
      for (now = 11150; now <= 11700; now += 50) pb.onAudioLevel(-90);
      const beforeQuiet = done.length;
      for (; now <= 12000; now += 50) pb.onAudioLevel(-90);
      return { afterDone, whileTalking, beforeQuiet, done };
    });
    expect(r.afterDone).toBe(0);
    expect(r.whileTalking).toBe(0);
    expect(r.beforeQuiet).toBe(0);
    expect(r.done).toHaveLength(1);
    expect(r.done[0]).toMatchObject({ kind: 'slide', reason: 'turn_end', chars: 185 });
    expect(r.done[0].audibleMs).toBeGreaterThan(9000);
  });

  test('missing TURN_END falls back to first audible + last word end + 1 s', async ({ page }) => {
    await loadPlayback(page);
    const r = await page.evaluate(() => {
      const { AvatarPlayback } = (window as any).__pb;
      let now = 0;
      const done: any[] = [];
      const pb = new AvatarPlayback({ now: () => now, onComplete: (c: any) => done.push({ ...c, at: now }) });
      pb.setAnalyserAvailable(true);
      pb.begin('slide', { chars: 120 });
      pb.onServerEvent({ type: 'response.created', response: { id: 'r1' } });
      pb.onServerEvent({ type: 'response.output_item.added', response_id: 'r1', item: { id: 'i1' } });
      for (let w = 0; w < 9900; w += 450) {
        pb.onServerEvent({ type: 'response.audio_timestamp.delta', response_id: 'r1', item_id: 'i1', audio_offset_ms: w, audio_duration_ms: 400 });
      }
      pb.onServerEvent({ type: 'response.audio_timestamp.delta', response_id: 'r1', item_id: 'i1', audio_offset_ms: 9500, audio_duration_ms: 400 });
      now = 2900; pb.onServerEvent({ type: 'response.done', response: { id: 'r1' } });
      for (now = 1000; now <= 10900; now += 50) pb.onAudioLevel(-25); // audible from 1000 to 10900
      for (; now <= 13000 && done.length === 0; now += 50) pb.onAudioLevel(-90);
      return done;
    });
    expect(r).toHaveLength(1);
    expect(r[0].reason).toBe('word_timestamps');
    // first audible (1000) + last word end (9900) + 1000 = 11900
    expect(r[0].at).toBeGreaterThanOrEqual(11900);
    expect(r[0].at).toBeLessThan(12000);
  });

  test('a dropped media link is not the end of speech: completes after the buffered tail', async ({ page }) => {
    await loadPlayback(page);
    const r = await page.evaluate(() => {
      const { AvatarPlayback } = (window as any).__pb;
      let now = 0;
      const done: any[] = [];
      const pb = new AvatarPlayback({ now: () => now, onComplete: (c: any) => done.push({ ...c, at: now }) });
      pb.setAnalyserAvailable(true);
      pb.begin('slide', { chars: 120 });
      pb.onServerEvent({ type: 'response.created', response: { id: 'r1' } });
      pb.onServerEvent({ type: 'response.output_item.added', response_id: 'r1', item: { id: 'i1' } });
      now = 800; pb.onDataChannelMessage({ event: { eventType: 'EVENT_TYPE_TURN_START', turnID: 'i1' } });
      pb.onServerEvent({ type: 'response.audio_timestamp.delta', response_id: 'r1', item_id: 'i1', audio_offset_ms: 9500, audio_duration_ms: 400 });
      now = 2900; pb.onServerEvent({ type: 'response.done', response: { id: 'r1' } });
      // Network stalls delay playback past the word-timestamp estimate (1000 + 9900 + 1000).
      for (now = 1000; now <= 12000; now += 50) pb.onAudioLevel(-25);
      pb.setMediaInterrupted(true); // WebRTC 'disconnected': silence for 1.1 s
      for (; now <= 13100; now += 50) pb.onAudioLevel(-120);
      const duringOutage = done.length;
      const quietDuringOutage = pb.quietForMs();
      pb.setMediaInterrupted(false); // 'connected': the buffered tail plays
      for (; now <= 13600; now += 50) pb.onAudioLevel(-25);
      now = 13650; pb.onDataChannelMessage({ event: { eventType: 'EVENT_TYPE_TURN_END', turnID: 'i1' } });
      for (; now <= 16000 && done.length === 0; now += 50) pb.onAudioLevel(-120);
      return { duringOutage, quietDuringOutage, done };
    });
    expect(r.duringOutage).toBe(0);
    expect(r.quietDuringOutage).toBe(0);
    expect(r.done).toHaveLength(1);
    expect(r.done[0].reason).toBe('turn_end');
    // Last loud sample (13600) + 700 ms of real silence.
    expect(r.done[0].at).toBeGreaterThanOrEqual(14300);
  });

  test('silence right after the link is restored still needs 700 ms before completing', async ({ page }) => {
    await loadPlayback(page);
    const r = await page.evaluate(() => {
      const { AvatarPlayback } = (window as any).__pb;
      let now = 0;
      const done: any[] = [];
      const pb = new AvatarPlayback({ now: () => now, onComplete: (c: any) => done.push({ ...c, at: now }) });
      pb.setAnalyserAvailable(true);
      pb.begin('slide', { chars: 120 });
      pb.onServerEvent({ type: 'response.created', response: { id: 'r1' } });
      pb.onServerEvent({ type: 'response.audio_timestamp.delta', response_id: 'r1', audio_offset_ms: 9500, audio_duration_ms: 400 });
      pb.onServerEvent({ type: 'response.done', response: { id: 'r1' } });
      for (now = 1000; now <= 11000; now += 50) pb.onAudioLevel(-25);
      pb.setMediaInterrupted(true);
      for (; now <= 14000; now += 50) pb.onAudioLevel(-120);
      pb.setMediaInterrupted(false);
      const restoredAt = now;
      for (; now <= 16000 && done.length === 0; now += 50) pb.onAudioLevel(-120);
      return { restoredAt, done };
    });
    expect(r.done).toHaveLength(1);
    expect(r.done[0].reason).toBe('word_timestamps');
    expect(r.done[0].at - r.restoredAt).toBeGreaterThanOrEqual(700);
  });

  test('no completion signal at all → stalled (Continue), never a silent skip', async ({ page }) => {
    await loadPlayback(page);
    const r = await page.evaluate(() => {
      const { AvatarPlayback } = (window as any).__pb;
      let now = 0;
      const done: any[] = [];
      const stalled: any[] = [];
      const pb = new AvatarPlayback({ now: () => now, onComplete: (c: any) => done.push(c), onStalled: (s: any) => stalled.push({ ...s, at: now }) });
      pb.begin('slide', { chars: 130 });
      pb.onServerEvent({ type: 'response.created', response: { id: 'r1' } });
      pb.onServerEvent({ type: 'response.done', response: { id: 'r1' } });
      for (now = 0; now <= 120000; now += 100) pb.tick();
      const before = { done: done.length, stalled: stalled.length, phase: pb.snapshot()?.phase };
      pb.forceComplete();
      return { before, stalledAt: stalled[0]?.at, done };
    });
    expect(r.before).toEqual({ done: 0, stalled: 1, phase: 'stalled' });
    // created + 1.3 s + 130 chars / 13 + 8 s ≈ 19.3 s
    expect(r.stalledAt).toBeGreaterThan(15000);
    expect(r.stalledAt).toBeLessThan(25000);
    expect(r.done).toEqual([expect.objectContaining({ reason: 'manual', kind: 'slide' })]);
  });

  test('events of a stale epoch are ignored; on-connect idle is ignored', async ({ page }) => {
    await loadPlayback(page);
    const r = await page.evaluate(() => {
      const { AvatarPlayback } = (window as any).__pb;
      let now = 0;
      const done: any[] = [];
      const pb = new AvatarPlayback({ now: () => now, onComplete: (c: any) => done.push(c) });
      const a = pb.begin('slide', { chars: 50 });
      pb.onServerEvent({ type: 'response.created', response: { id: 'rA' } });
      pb.onServerEvent({ type: 'response.output_item.added', response_id: 'rA', item: { id: 'iA' } });
      now = 500;
      const b = pb.begin('slide', { chars: 50 });
      pb.onServerEvent({ type: 'response.created', response: { id: 'rB' } });
      pb.onServerEvent({ type: 'response.output_item.added', response_id: 'rB', item: { id: 'iB' } });
      // Late events of turn A, plus an id-less idle (as sent on connect).
      pb.onDataChannelMessage({ event: { eventType: 'EVENT_TYPE_SWITCH_TO_IDLE', offset: '0s' } });
      pb.onDataChannelMessage({ event: { eventType: 'EVENT_TYPE_TURN_START', turnID: 'iA' } });
      pb.onDataChannelMessage({ event: { eventType: 'EVENT_TYPE_TURN_END', turnID: 'iA' } });
      pb.onServerEvent({ type: 'response.done', response: { id: 'rA' } });
      for (now = 600; now <= 3000; now += 100) pb.tick();
      const staleDone = done.length;
      pb.onDataChannelMessage('{"event":{"eventType":"EVENT_TYPE_TURN_END","turnID":"iB"}}');
      for (now = 3100; now <= 3600; now += 100) pb.tick();
      pb.onDataChannelMessage('not json');
      pb.onDataChannelMessage({ event: { eventType: 'EVENT_TYPE_SOMETHING_NEW' } });
      return { a, b, staleDone, done };
    });
    expect(r.b).toBeGreaterThan(r.a);
    expect(r.staleDone).toBe(0);
    // No analyser → TURN_END + 400 ms tail is enough.
    expect(r.done).toEqual([expect.objectContaining({ epoch: r.b, reason: 'turn_end' })]);
  });

  test('server-initiated speech before begin() is adopted (Q&A invite)', async ({ page }) => {
    await loadPlayback(page);
    const r = await page.evaluate(() => {
      const { AvatarPlayback } = (window as any).__pb;
      let now = 0;
      const done: any[] = [];
      const pb = new AvatarPlayback({ now: () => now, onComplete: (c: any) => done.push(c) });
      pb.setAnalyserAvailable(true);
      pb.onServerEvent({ type: 'response.created', response: { id: 'rq' } });
      pb.onServerEvent({ type: 'response.output_item.added', response_id: 'rq', item: { id: 'iq' } });
      now = 300;
      pb.begin('qa_invite', { adopt: true, chars: 30, meta: 'req-1' });
      pb.onDataChannelMessage({ event: { eventType: 'EVENT_TYPE_TURN_START', turnID: 'iq' } });
      for (now = 400; now <= 2000; now += 50) pb.onAudioLevel(-30);
      pb.onDataChannelMessage({ event: { eventType: 'EVENT_TYPE_TURN_END', turnID: 'iq' } });
      for (; now <= 3000; now += 50) pb.onAudioLevel(-90);
      return done;
    });
    expect(r).toEqual([expect.objectContaining({ kind: 'qa_invite', reason: 'turn_end', meta: 'req-1' })]);
  });
});

test.describe('Playback controller — stale tails (unit)', () => {
  test('a stale SWITCH_TO_IDLE of the previous turn never completes the next one', async ({ page }) => {
    await loadPlayback(page);
    const r = await page.evaluate(() => {
      const { AvatarPlayback } = (window as any).__pb;
      let now = 0;
      const done: any[] = [];
      const pb = new AvatarPlayback({ now: () => now, onComplete: (c: any) => done.push({ ...c, at: now }) });
      pb.setAnalyserAvailable(true);
      // Slide 1 (msg_1): plays until 10950, TURN_END at 10600.
      pb.begin('slide', { chars: 130, meta: 0 });
      pb.onServerEvent({ type: 'response.created', response: { id: 'resp_1' } });
      pb.onServerEvent({ type: 'response.output_item.added', response_id: 'resp_1', item: { id: 'msg_1' } });
      now = 800; pb.onDataChannelMessage({ event: { eventType: 'EVENT_TYPE_TURN_START', turnID: 'msg_1' } });
      for (now = 1000; now <= 10550; now += 50) pb.onAudioLevel(-25);
      now = 10600; pb.onDataChannelMessage({ event: { eventType: 'EVENT_TYPE_TURN_END', turnID: 'msg_1' } });
      for (now = 10600; now <= 10950; now += 50) pb.onAudioLevel(-25);
      for (now = 11000; now <= 11650; now += 50) pb.onAudioLevel(-90);
      const slide1 = done.map((d) => d.meta);
      // Slide 2 starts after the gap; response.created but no output_item yet.
      now = 12200; pb.begin('slide', { chars: 130, meta: 1 });
      now = 12250; pb.onServerEvent({ type: 'response.created', response: { id: 'resp_2' } });
      // Stale idle of msg_1 (~1.6 s after its audible end), plus an id-less one.
      now = 12650; pb.onDataChannelMessage({ event: { eventType: 'EVENT_TYPE_SWITCH_TO_IDLE', turnID: 'msg_1' } });
      pb.onServerEvent({ type: 'session.avatar.switch_to_idle', turn_id: 'msg_1' });
      for (now = 12700; now <= 16000; now += 50) pb.onAudioLevel(-90);
      const afterStale = done.length;
      pb.onServerEvent({ type: 'response.output_item.added', response_id: 'resp_2', item: { id: 'msg_2' } });
      return { slide1, afterStale, snapshot: pb.snapshot() };
    });
    expect(r.slide1).toEqual([0]);
    expect(r.afterStale).toBe(1);
    expect(r.snapshot).toMatchObject({ meta: 1, turnEnded: false });
  });

  test('an unbound turn ignores END events with an unknown id; id-less ends need its own TURN_START', async ({ page }) => {
    await loadPlayback(page);
    const r = await page.evaluate(() => {
      const { AvatarPlayback } = (window as any).__pb;
      let now = 0;
      const done: any[] = [];
      const pb = new AvatarPlayback({ now: () => now, onComplete: (c: any) => done.push(c) });
      pb.begin('slide', { chars: 50 });
      pb.onServerEvent({ type: 'response.created', response: { id: 'r' } });
      pb.onDataChannelMessage({ event: { eventType: 'EVENT_TYPE_TURN_END', turnID: 'other' } });
      pb.onDataChannelMessage({ event: { eventType: 'EVENT_TYPE_SWITCH_TO_IDLE' } });
      for (now = 0; now <= 2000; now += 100) pb.tick();
      const early = done.length;
      // Photo avatar: id-less TURN_START then id-less idle/end.
      now = 2100; pb.onDataChannelMessage({ event: { eventType: 'EVENT_TYPE_TURN_START' } });
      now = 9000; pb.onDataChannelMessage({ event: { eventType: 'EVENT_TYPE_SWITCH_TO_IDLE' } });
      pb.onDataChannelMessage({ event: { eventType: 'EVENT_TYPE_TURN_END' } });
      for (now = 9100; now <= 9600; now += 100) pb.tick();
      return { early, done };
    });
    expect(r.early).toBe(0);
    expect(r.done).toEqual([expect.objectContaining({ reason: 'turn_end' })]);
  });

  test('id-less idle right after a photo-avatar turn ends is not credited to the next turn', async ({ page }) => {
    await loadPlayback(page);
    const r = await page.evaluate(() => {
      const { AvatarPlayback } = (window as any).__pb;
      let now = 0;
      const done: any[] = [];
      const pb = new AvatarPlayback({ now: () => now, onComplete: (c: any) => done.push(c.meta) });
      pb.begin('slide', { chars: 50, meta: 'a' });
      pb.onServerEvent({ type: 'response.created', response: { id: 'ra' } });
      now = 500; pb.onDataChannelMessage({ event: { eventType: 'EVENT_TYPE_TURN_START' } });
      now = 5000; pb.onDataChannelMessage({ event: { eventType: 'EVENT_TYPE_TURN_END' } });
      for (now = 5100; now <= 5500; now += 100) pb.tick();
      now = 6000; pb.begin('slide', { chars: 50, meta: 'b' });
      pb.onServerEvent({ type: 'response.created', response: { id: 'rb' } });
      now = 6300; pb.onDataChannelMessage({ event: { eventType: 'EVENT_TYPE_TURN_START' } });
      now = 6600; pb.onDataChannelMessage({ event: { eventType: 'EVENT_TYPE_SWITCH_TO_IDLE' } }); // tail of 'a'
      for (now = 6700; now <= 8000; now += 100) pb.tick();
      return done;
    });
    expect(r).toEqual(['a']);
  });

  test('residual audio of the previous turn does not count as the new turn being heard', async ({ page }) => {
    await loadPlayback(page);
    const r = await page.evaluate(() => {
      const { AvatarPlayback } = (window as any).__pb;
      let now = 0;
      const pb = new AvatarPlayback({ now: () => now });
      pb.setAnalyserAvailable(true);
      for (now = 0; now <= 1000; now += 50) pb.onAudioLevel(-20); // old deck still talking
      pb.begin('slide', { chars: 50 });
      for (now = 1050; now <= 2000; now += 50) pb.onAudioLevel(-20);
      const whileResidual = pb.snapshot().heard;
      for (now = 2050; now <= 2300; now += 50) pb.onAudioLevel(-90); // 250 ms: not enough
      now = 2350; pb.onAudioLevel(-20);
      const shortGap = pb.snapshot().heard;
      for (now = 2400; now <= 2900; now += 50) pb.onAudioLevel(-90);
      now = 2950; pb.onAudioLevel(-20);
      return { whileResidual, shortGap, after: pb.snapshot().heard };
    });
    expect(r).toEqual({ whileResidual: false, shortGap: false, after: true });
  });
});

test.describe('Presenter playback (UI)', () => {
  test('admin: session binds the deck; response.done does not advance; TURN_END + silence does', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await mockApi(page, 'admin');
    const voice = await mockVoice(page);
    await page.goto('/decks/deck-plain/present');
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'Connect avatar' }).click();
    await expect.poll(() => voice.ofType('session.update').length).toBe(1);
    expect(voice.ofType('session.update')[0].session).toMatchObject({ deck_id: 'deck-plain', language: 'en-US' });
    await avatar.connected(page);

    await expect(page.getByTestId('narration-left')).toContainText('Slide 1/3');
    await expect(page.getByTestId('narration-left')).toContainText('narration left');

    await page.getByRole('button', { name: 'Present all' }).click();
    await expect.poll(() => voice.ofType('response.create').length).toBe(1);
    await expect.poll(() => voice.items.length).toBe(1);
    // response.done already arrived — the slide must stay put.
    await page.waitForTimeout(1500);
    await expect(page.getByTestId('slide-counter')).toContainText('Slide 1 of 3');

    await avatar.finishTurn(page, voice.items[0]);
    await expect(page.getByTestId('slide-counter')).toContainText('Slide 2 of 3');
    await expect.poll(() => voice.ofType('response.create').length).toBe(2);
    const prompts = voice.ofType('conversation.item.create').map((m) => m.item.content[0].text);
    expect(prompts[1]).toContain('Notes 2');
    expect(errors).toEqual([]);
  });

  test('admin: no completion signal → Continue button, then the user advances', async ({ page }) => {
    test.setTimeout(60_000);
    await mockApi(page, 'admin');
    const voice = await mockVoice(page);
    await page.goto('/decks/deck-plain/present');
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'Connect avatar' }).click();
    await avatar.connected(page);
    await page.getByRole('button', { name: 'Present all' }).click();
    await expect.poll(() => voice.items.length).toBe(1);
    const cont = page.getByTestId('playback-continue');
    await expect(cont).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('slide-counter')).toContainText('Slide 1 of 3');
    await cont.click();
    await expect(page.getByTestId('slide-counter')).toContainText('Slide 2 of 3');
    await expect(cont).toHaveCount(0);
  });

  test('admin: word timestamps complete the turn when TURN_END is missing', async ({ page }) => {
    await mockApi(page, 'admin');
    const voice = await mockVoice(page, { wordTimestamps: true });
    await page.goto('/decks/deck-plain/present');
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'Connect avatar' }).click();
    await avatar.connected(page);
    await page.getByRole('button', { name: 'Present all' }).click();
    await expect.poll(() => voice.items.length).toBe(1);
    await page.evaluate(() => (window as any).__ozRadioTest.audioLevel(-20));
    await page.waitForTimeout(300);
    await page.evaluate(() => (window as any).__ozRadioTest.audioLevel(-90));
    await expect(page.getByTestId('slide-counter')).toContainText('Slide 2 of 3', { timeout: 5000 });
  });

  test('admin: switching the language also switches to a voice that speaks it', async ({ page }) => {
    await mockApi(page, 'admin');
    const voice = await mockVoice(page);
    await page.goto('/decks/deck-plain/present');
    await page.waitForLoadState('networkidle');
    await expect(page.getByLabel('Voice')).toHaveValue('en-US-Ava:DragonHDLatestNeural');
    await page.getByLabel('Language').selectOption('fr-FR');
    // Same gender, native French HD voice (an explicit voice wins server-side).
    await expect(page.getByLabel('Voice')).toHaveValue('fr-FR-Vivienne:DragonHDLatestNeural');
    await page.getByLabel('Language').selectOption('ko-KR');
    // No native Korean HD voice: the multilingual en-US voice of the same gender.
    await expect(page.getByLabel('Voice')).toHaveValue('en-US-Ava:DragonHDLatestNeural');
    await page.getByLabel('Voice').selectOption('fr-FR-Remy:DragonHDLatestNeural');
    await expect(page.getByLabel('Language')).toHaveValue('fr-FR');
    await page.getByLabel('Language').selectOption('de-DE');
    await expect(page.getByLabel('Voice')).toHaveValue('de-DE-Florian:DragonHDLatestNeural');
    await page.getByRole('button', { name: 'Connect avatar' }).click();
    await expect.poll(() => voice.ofType('session.update').length).toBe(1);
    expect(voice.ofType('session.update')[0].session).toMatchObject({ language: 'de-DE', voice: 'de-DE-Florian:DragonHDLatestNeural' });
  });

  test('admin: the avatar offer carries a client data channel (server events channel) and stays relay-only', async ({ page }) => {
    await page.addInitScript(() => {
      const calls: string[] = [];
      (window as any).__pcCalls = calls;
      const Native = window.RTCPeerConnection;
      (window as any).RTCPeerConnection = class extends Native {
        constructor(cfg?: RTCConfiguration) {
          super(cfg);
          calls.push(`new:${cfg?.iceTransportPolicy}`);
        }
        createDataChannel(label: string, init?: RTCDataChannelInit) {
          calls.push(`dc:${label}`);
          return super.createDataChannel(label, init);
        }
        async createOffer(...args: any[]) {
          const offer = await (super.createOffer as any)(...args);
          calls.push(`offer:${/m=application/.test(offer.sdp ?? '') ? 'sctp' : 'no-sctp'}`);
          return offer;
        }
      };
    });
    await mockApi(page, 'admin');
    const voice = await mockVoice(page);
    await page.goto('/decks/deck-plain/present');
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'Connect avatar' }).click();
    await expect.poll(() => voice.ofType('session.update').length).toBe(1);
    voice.send({
      type: 'session.updated',
      session: { avatar: { ice_servers: [{ urls: ['turn:127.0.0.1:3478?transport=udp'] }], username: 'u', credential: 'c' } },
    });
    await expect.poll(() => page.evaluate(() => (window as any).__pcCalls.join(' '))).toMatch(/offer:/);
    const calls: string[] = await page.evaluate(() => (window as any).__pcCalls);
    expect(calls[0]).toBe('new:relay');
    expect(calls.indexOf('dc:eventChannel')).toBeGreaterThan(0);
    expect(calls.indexOf('dc:eventChannel')).toBeLessThan(calls.indexOf('offer:sctp'));
  });

  test('playlist: moving to the next deck sends context.switch on the same socket', async ({ page }) => {
    await mockApi(page, 'admin');
    const voice = await mockVoice(page);
    await page.goto('/playlists/pl-1');
    await page.waitForLoadState('networkidle');
    await page.getByTestId('playlist-start').click();
    await expect.poll(() => voice.ofType('session.update').length).toBe(1);
    expect(voice.ofType('session.update')[0].session.deck_id).toBe('deck-live');
    await avatar.connected(page);
    await page.getByTestId('playlist-next-deck').click();
    await expect.poll(() => voice.ofType('context.switch')).toEqual([{ type: 'context.switch', deck_id: 'deck-plain' }]);
    expect(voice.ofType('session.update')).toHaveLength(1);
    expect(calls.some((c) => c.path === '/api/decks/deck-plain')).toBe(true);
  });

  test('live upload binds session.presentation_id', async ({ page }) => {
    await mockApi(page, 'admin');
    await page.route('**/api/presentations', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'pres-9', filename: 'q3.pptx', slide_count: 1 }]) }));
    await page.route('**/api/slides/pres-9', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'pres-9', filename: 'q3.pptx', slide_count: 1, slides: [{ index: 0, title: 'Q3', body: 'B', notes: 'N' }] }) }));
    const voice = await mockVoice(page);
    await page.goto('/live');
    await page.waitForLoadState('networkidle');
    await page.locator('.deck-picker__open').first().click();
    await page.getByRole('button', { name: 'Connect avatar' }).click();
    await expect.poll(() => voice.ofType('session.update').length).toBe(1);
    expect(voice.ofType('session.update')[0].session).toMatchObject({ presentation_id: 'pres-9' });
    expect(voice.ofType('session.update')[0].session.deck_id).toBeUndefined();
  });
});

test.describe('Demo countdown (UI)', () => {
  // `mockVoice` is an older (protocol v1) demo server; ux-demo.spec.ts covers the v2 protocol and every ending.
  test('server remaining_ms re-syncs the countdown; narration estimate is a separate label', async ({ page }) => {
    await mockApi(page, 'visitor', { demoSessionSeconds: 300 });
    await mockVoice(page, { demoRemainingMs: 150_000, narrationChars: [1300, 1300, 1300] });
    await page.goto('/decks/deck-live/present');
    await page.waitForLoadState('networkidle');
    await page.getByTestId('demo-start').click();
    const left = page.getByTestId('demo-time-left');
    await expect(left).toHaveText(/^Demo time left 2:(30|29)$/);
    // 3 × 1300 chars at 1/13 s ≈ 300 s of narration > 150 s left → about 1 slide fits.
    await expect(page.getByTestId('demo-coverage-note')).toHaveText('This demo covers about 1 of 3 slides');
    await avatar.connected(page);
    // The presentation starts by itself: the server's acknowledgement of slide 1 (130 characters) refines the estimate.
    await expect(page.getByTestId('narration-left')).toHaveText('Slide 1/3 · ~3:30 narration left');
    await expect(left).toHaveText(/^Demo time left 2:(2\d|30)$/);
  });

  test('demo: the slide stays visible when the session ends, and the card says it ended', async ({ page }) => {
    await mockApi(page, 'visitor');
    const voice = await mockVoice(page);
    await page.goto('/decks/deck-live/present');
    await page.waitForLoadState('networkidle');
    await page.getByTestId('slide-next').click();
    await page.getByTestId('demo-start').click();
    await avatar.connected(page);
    // One Start tap presents from the slide on screen: no "Present this slide" for visitors.
    await expect.poll(() => voice.ofType('demo.speak')).toEqual([{ type: 'demo.speak', slide: 1 }]);
    await page.evaluate(() => (window as any).__ozRadioTest.playback()).then((s) => expect(s).toMatchObject({ kind: 'slide', chars: 130 }));
    voice.close(4408, 'time limit');
    const ended = page.getByTestId('demo-outcome');
    await expect(ended).toHaveAttribute('data-outcome', 'cap');
    await expect(page.getByTestId('demo-outcome-title')).toHaveText('Your live session has ended');
    await expect(ended.getByTestId('demo-outcome-fallback')).toHaveCount(2); // no same-deck recording in this catalog
    await expect(page.getByText('Demo time limit reached')).toHaveCount(0);
    await expect(page.getByTestId('slide-counter')).toContainText('Slide 2 of 3');
    await expect(page.getByText('Slide title 2').first()).toBeVisible();
    await expect(page.getByTestId('demo-time-left')).toHaveCount(0);
  });
});
