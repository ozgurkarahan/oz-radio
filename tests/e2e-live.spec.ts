/**
 * LIVE end-to-end suite: real Chromium, real local backend, real Azure Speech /
 * Voice Live / OpenAI. Skipped unless OZ_RADIO_LIVE_E2E=1 (CI and the mocked
 * regression runs never touch Azure).
 *
 * Setup (see tests/e2e_live_server.py and tests/e2e_live_audio.py):
 *   python tests/e2e_live_audio.py <evidence-dir>          # fake-mic question WAV
 *   python tests/e2e_live_server.py --port 8000            # backend, AUTH_MODE=easyauth
 *   # Easy Auth front door: admin (principal injected) on 5199, anonymous on 5198.
 *   cd demos/frontend
 *   $env:OZ_RADIO_E2E_PRINCIPAL = python ../../tests/e2e_live_server.py --print-principal
 *   npx vite --config vite.e2e-live.config.ts --port 5199 --strictPort
 *   (new shell, no OZ_RADIO_E2E_PRINCIPAL) npx vite --config vite.e2e-live.config.ts --port 5198 --strictPort
 *   $env:OZ_RADIO_LIVE_E2E='1'; $env:AI_PRESENTER_BASE_URL='http://localhost:5199'
 *   $env:OZ_RADIO_E2E_ANON_URL='http://localhost:5198'
 *   $env:OZ_RADIO_E2E_EVIDENCE='<evidence-dir>'
 *   npx playwright test tests/e2e-live.spec.ts --project=chromium --workers=1
 *
 * Tags: @admin (A/B/C: deck flow, raise hand, French), @demo (D), @podcast (E/F/G).
 * Evidence (screenshots, WS/data-channel/analyser timelines, podcast frames)
 * goes to OZ_RADIO_E2E_EVIDENCE.
 *
 * G (library Watch + Listen) needs the podcast library, i.e. blob storage for the
 * backend (AZURE_BLOB_ACCOUNT_NAME or AZURE_BLOB_CONNECTION_STRING): it plays the
 * episode E rendered, else the newest library podcast with a video and a radio
 * rendition, and is skipped when there is none.
 */
import {
  test, expect, type Browser, type BrowserContext, type ElementHandle, type Locator, type Page, type APIRequestContext,
} from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const LIVE = process.env.OZ_RADIO_LIVE_E2E === '1';
const BASE_URL = process.env.AI_PRESENTER_BASE_URL ?? 'http://localhost:5173';
const EVIDENCE = path.resolve(process.env.OZ_RADIO_E2E_EVIDENCE ?? 'test-results/e2e-live');
const WAV = path.resolve(process.env.OZ_RADIO_E2E_QUESTION_WAV ?? path.join(EVIDENCE, 'question-en.wav'));
const CONTENT = path.resolve(__dirname, '..', 'content', 'ai-enablement');
const DEMO_DECK = path.join(CONTENT, 'ai-enablement-demo-beginner.pptx');
const FULL_DECK = path.join(CONTENT, 'ai-enablement-1-beginner.pptx');
const SPEAK_PREFIX = 'Please say the following exactly as written: ';
const LOUD_DB = -50;

// Easy Auth is emulated by two Vite instances (demos/frontend/vite.e2e-live.config.ts):
// the admin one injects the signed-in principal headers on /api and /ws, the
// anonymous one injects nothing.
const ANON_URL = process.env.OZ_RADIO_E2E_ANON_URL ?? 'http://localhost:5198';

test.skip(!LIVE, 'Live E2E: set OZ_RADIO_LIVE_E2E=1 (real Azure, see header)');
test.use({
  launchOptions: {
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${WAV}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  },
});

if (LIVE) fs.mkdirSync(EVIDENCE, { recursive: true });

// ── In-page instrumentation ─────────────────────────────────────────────
// Records voice WS frames (summaries, never audio or SDP/ICE credentials),
// the avatar data channel, an independent analyser on the remote avatar
// audio, slide counter / notes / Q&A phase / status changes.
const INSTRUMENT = String.raw`(() => {
  if (window.__e2e) return;
  const E = window.__e2e = { events: [], levels: [], pcState: null, qaAudioFrames: 0 };
  const now = () => Math.round(performance.now());
  const log = (kind, data) => E.events.push(Object.assign({ t: now(), kind }, data || {}));
  E.log = log;
  const pick = (src, dst, keys) => { for (const k of keys) if (src[k] !== undefined) dst[k] = src[k]; return dst; };
  const summarizeIn = (m) => {
    const o = pick(m, { type: m.type }, ['request_id','code','message','remaining_ms','remaining_questions','slide','chars',
      'grounded','source_slides','session_seconds','narration_chars','turn_id','max_audio_ms','deck_id','slide_count','reason']);
    if (typeof m.text === 'string') o.text = m.text;
    if (m.response && m.response.id) o.rid = m.response.id;
    if (m.response_id) o.rid = m.response_id;
    if (m.item && m.item.id) o.item = m.item.id;
    if (m.item_id) o.item = m.item_id;
    if (m.type === 'session.updated' && m.session) {
      o.voice = m.session.voice && (m.session.voice.name || m.session.voice);
      o.avatarCharacter = m.session.avatar && m.session.avatar.character;
    }
    if (typeof m.audio_offset_ms === 'number') o.end = m.audio_offset_ms + (m.audio_duration_ms || 0);
    if (m.type === 'response.audio_transcript.done') o.transcript = m.transcript;
    if (m.type === 'error') o.error = m.error && m.error.message;
    return o;
  };
  const summarizeOut = (m) => {
    const o = pick(m, { type: m.type }, ['request_id','slide','mode','seq','deck_id']);
    if (m.type === 'session.update') o.session = m.session;
    if (m.type === 'conversation.item.create') o.text = m.item && m.item.content && m.item.content[0] && m.item.content[0].text;
    if (typeof m.text === 'string') o.text = m.text;
    return o;
  };
  const NativeWS = window.WebSocket;
  class InstrumentedWS extends NativeWS {
    constructor(url, protocols) {
      super(url, protocols);
      this.__voice = String(url).indexOf('/ws/voice') >= 0;
      if (!this.__voice) return;
      log('ws.connect', { url: String(url).replace(/^.*?\/ws\//, '/ws/') });
      this.addEventListener('open', () => log('ws.open'));
      this.addEventListener('message', (e) => { try { log('ws.in', summarizeIn(JSON.parse(e.data))); } catch (err) {} });
      this.addEventListener('close', (e) => log('ws.close', { code: e.code, reason: e.reason }));
    }
    send(data) {
      if (this.__voice) {
        try {
          const m = JSON.parse(data);
          if (m.type === 'qa.audio') { E.qaAudioFrames++; if (m.seq === 0) log('ws.out', { type: 'qa.audio', seq: 0 }); }
          else log('ws.out', summarizeOut(m));
        } catch (err) {}
      }
      return super.send(data);
    }
  }
  window.WebSocket = InstrumentedWS;

  let actx = null, timer = null;
  function startAnalyser(stream) {
    try {
      actx = actx || new AudioContext();
      if (actx.state === 'suspended') actx.resume();
      const src = actx.createMediaStreamSource(stream);
      const an = actx.createAnalyser();
      an.fftSize = 1024;
      src.connect(an);
      const buf = new Float32Array(1024);
      if (timer) clearInterval(timer);
      timer = setInterval(() => {
        an.getFloatTimeDomainData(buf);
        let s = 0;
        for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
        const rms = Math.sqrt(s / buf.length);
        E.levels.push([now(), rms > 0 ? Math.round(200 * Math.log10(rms)) / 10 : -120]);
      }, 50);
      log('analyser.start', { state: actx.state });
    } catch (err) { log('analyser.error', { message: String(err) }); }
  }
  const NativePC = window.RTCPeerConnection;
  window.RTCPeerConnection = class extends NativePC {
    constructor(cfg, ...rest) {
      super(cfg, ...rest);
      E.pc = this;
      E.iceTransportPolicy = cfg && cfg.iceTransportPolicy;
      log('pc.new', { iceTransportPolicy: E.iceTransportPolicy });
      this.addEventListener('connectionstatechange', () => { E.pcState = this.connectionState; log('pc.state', { state: this.connectionState }); });
      this.addEventListener('datachannel', (e) => {
        log('dc.open', { label: e.channel.label });
        e.channel.addEventListener('message', (m) => log('dc.msg', { data: typeof m.data === 'string' ? m.data.slice(0, 400) : '[binary]' }));
      });
      this.addEventListener('track', (e) => {
        log('pc.track', { trackKind: e.track.kind });
        // After the app attached the stream to its <audio> element (Chrome needs it).
        if (e.track.kind === 'audio') setTimeout(() => startAnalyser(e.streams[0]), 200);
      });
    }
  };

  const text = (sel) => { const el = document.querySelector(sel); return el ? el.textContent : null; };
  const last = {};
  setInterval(() => {
    const counter = text('[data-testid=slide-counter]');
    if (counter !== last.counter) {
      last.counter = counter;
      const m = counter && counter.match(/Slide (\d+) of (\d+)/);
      log('slide', { n: m ? Number(m[1]) : null, of: m ? Number(m[2]) : null, notes: text('[data-testid=slide-notes-text]') });
    }
    const notes = text('[data-testid=slide-notes-text]');
    if (notes !== last.notes) { last.notes = notes; log('notes', { notes }); }
    const panel = document.querySelector('[data-testid=raise-hand-panel]');
    const phase = panel ? panel.getAttribute('data-phase') : null;
    if (phase !== last.phase) { last.phase = phase; log('qa.phase', { phase }); }
    const status = text('.avatar-rail__status') || text('.avatar-rail__panel [role=alert]');
    if (status !== last.status) { last.status = status; log('status', { status }); }
    const clock = text('[data-testid=demo-time-left]');
    if (clock !== last.clock) { last.clock = clock; log('demo.clock', { clock }); }
  }, 50);
})();`;

// ── Timeline helpers ────────────────────────────────────────────────────
interface Ev { t: number; kind: string; [k: string]: any }
interface Timeline { events: Ev[]; levels: [number, number][]; qaAudioFrames: number; iceTransportPolicy?: string }

async function timeline(page: Page): Promise<Timeline> {
  return page.evaluate(() => {
    const E = (window as any).__e2e;
    return { events: E.events, levels: E.levels, qaAudioFrames: E.qaAudioFrames, iceTransportPolicy: E.iceTransportPolicy };
  });
}

async function pageNow(page: Page): Promise<number> {
  return page.evaluate(() => Math.round(performance.now()));
}

function saveJson(name: string, data: unknown): string {
  const p = path.join(EVIDENCE, name);
  fs.writeFileSync(p, JSON.stringify(data, null, 1));
  return p;
}

function sinceT(tl: Timeline, t0: number): Timeline {
  // Keep the state in force at t0 (current slide / notes / phase) as context.
  const before = tl.events.filter((e) => e.t < t0);
  const lastOf = (kind: string) => [...before].reverse().find((e) => e.kind === kind);
  const ctx = ['slide', 'notes', 'qa.phase'].map(lastOf).filter((e): e is Ev => !!e);
  return { ...tl, events: [...ctx, ...tl.events.filter((e) => e.t >= t0)], levels: tl.levels.filter(([t]) => t >= t0) };
}

const loud = (db: number) => db > LOUD_DB;

function firstLoud(levels: [number, number][], from: number, to = Infinity): number | null {
  for (const [t, db] of levels) if (t >= from && t <= to && loud(db)) return t;
  return null;
}

function lastLoud(levels: [number, number][], from: number, to: number): number | null {
  let r: number | null = null;
  for (const [t, db] of levels) if (t >= from && t <= to && loud(db)) r = t;
  return r;
}

/** Start of the first run of >= minMs continuous quiet samples after `from`. */
function firstQuietRun(levels: [number, number][], from: number, minMs: number): number | null {
  let start: number | null = null;
  for (const [t, db] of levels) {
    if (t < from) continue;
    if (loud(db)) { start = null; continue; }
    if (start == null) start = t;
    if (t - start >= minMs) return start;
  }
  return null;
}

function speaks(tl: Timeline): Ev[] {
  return tl.events.filter((e) => e.kind === 'ws.out' && (e.type === 'conversation.item.create' || e.type === 'demo.speak'));
}

function slideEvents(tl: Timeline): Ev[] {
  return tl.events.filter((e) => e.kind === 'slide' && e.n != null);
}

function slideAt(tl: Timeline, t: number): Ev | undefined {
  let cur: Ev | undefined;
  for (const e of slideEvents(tl)) if (e.t <= t) cur = e;
  return cur;
}

function lastWordEnd(tl: Timeline, after: number, before: number): number | null {
  const created = tl.events.find((e) => e.kind === 'ws.in' && e.type === 'response.created' && e.t >= after && e.t <= before);
  if (!created?.rid) return null;
  let end: number | null = null;
  for (const e of tl.events) {
    if (e.kind === 'ws.in' && e.rid === created.rid && typeof e.end === 'number') end = Math.max(end ?? 0, e.end);
  }
  return end;
}

interface Transition {
  from: number; to: number; audibleStart: number | null; audibleEnd: number | null; audibleMs: number | null;
  lastWordEndMs: number | null; slideChangeAt: number; nextSpeakAt: number | null;
  advanceDelayMs: number | null; quietBeforeNextSpeakMs: number | null; loudBetweenChangeAndSpeak: boolean;
}

/** Per pair of consecutive narrated slides: audible end of N vs advance to N+1. */
function transitions(tl: Timeline): Transition[] {
  const sp = speaks(tl);
  const out: Transition[] = [];
  for (let i = 0; i < sp.length; i++) {
    const s = sp[i];
    const slideN = s.type === 'demo.speak' ? s.slide + 1 : slideAt(tl, s.t)?.n;
    const change = slideEvents(tl).find((e) => e.t > s.t && e.n !== slideN);
    if (!change) continue;
    const next = sp.find((x) => x.t >= change.t);
    const aStart = firstLoud(tl.levels, s.t, change.t);
    const aEnd = lastLoud(tl.levels, s.t, change.t);
    out.push({
      from: slideN, to: change.n, audibleStart: aStart, audibleEnd: aEnd,
      audibleMs: aStart != null && aEnd != null ? aEnd - aStart : null,
      lastWordEndMs: lastWordEnd(tl, s.t, change.t),
      slideChangeAt: change.t, nextSpeakAt: next?.t ?? null,
      advanceDelayMs: aEnd != null ? change.t - aEnd : null,
      quietBeforeNextSpeakMs: next && aEnd != null ? next.t - aEnd : null,
      loudBetweenChangeAndSpeak: next ? lastLoud(tl.levels, change.t, next.t) != null : false,
    });
  }
  return out;
}

// ── Page helpers ────────────────────────────────────────────────────────
async function newInstrumentedContext(browser: Browser, admin: boolean): Promise<BrowserContext> {
  const ctx = await browser.newContext({
    baseURL: admin ? BASE_URL : ANON_URL,
    viewport: { width: 1440, height: 1000 },
  });
  await ctx.addInitScript({ content: INSTRUMENT });
  return ctx;
}

function attachConsole(page: Page, name: string): void {
  const file = path.join(EVIDENCE, `${name}-console.log`);
  fs.writeFileSync(file, '');
  page.on('console', (m) => fs.appendFileSync(file, `[${m.type()}] ${m.text()}\n`));
  page.on('pageerror', (e) => fs.appendFileSync(file, `[pageerror] ${e.message}\n`));
}

async function videoFrames(page: Page): Promise<{ frames: number; width: number; height: number }> {
  return page.evaluate(() => {
    const v = document.querySelector<HTMLVideoElement>('.avatar-rail__video');
    if (!v) return { frames: 0, width: 0, height: 0 };
    return { frames: v.getVideoPlaybackQuality().totalVideoFrames, width: v.videoWidth, height: v.videoHeight };
  });
}

/** Connect the avatar (admin "Connect avatar" or demo "Try the live demo"), retrying flaky ICE. */
async function connectAvatar(page: Page, demo: boolean, attempts = 4): Promise<number> {
  for (let i = 1; i <= attempts; i++) {
    const t0 = await pageNow(page);
    if (demo) await page.getByTestId('demo-start').click();
    else await page.getByRole('button', { name: 'Connect avatar' }).click();
    const ok = await page.waitForFunction((since) => {
      const E = (window as any).__e2e;
      const states = E.events.filter((e: any) => e.t >= since && e.kind === 'pc.state').map((e: any) => e.state);
      if (states.includes('connected')) return 'connected';
      if (states.includes('failed')) return 'failed';
      const closed = E.events.find((e: any) => e.t >= since && e.kind === 'ws.close');
      if (closed) return `closed:${closed.code}`;
      const st = document.querySelector('.avatar-rail__status, .avatar-rail__panel [role=alert]')?.textContent ?? '';
      if (/Video connection (failed|timed out)|^Error|Connection closed/.test(st)) return `status:${st}`;
      return false;
    }, t0, { timeout: 60_000 }).then((h) => h.jsonValue()).catch(() => 'timeout');
    test.info().annotations.push({ type: 'connect', description: `attempt ${i}: ${ok}` });
    if (ok === 'connected') {
      await expect(page.locator('.avatar-rail.is-live')).toBeVisible({ timeout: 15_000 });
      return i;
    }
    // Reset and retry (the avatar relay fails ~1 in 3 attempts from some networks).
    const stop = demo ? page.getByRole('button', { name: 'Stop' }) : page.getByRole('button', { name: 'Disconnect' });
    if (await stop.isVisible().catch(() => false)) await stop.click();
    await page.waitForTimeout(4000);
  }
  throw new Error(`Avatar did not connect after ${attempts} attempts`);
}

async function expectMediaFlowing(page: Page): Promise<void> {
  const a = await videoFrames(page);
  await page.waitForTimeout(2500);
  const b = await videoFrames(page);
  expect(b.width, 'avatar video has a size').toBeGreaterThan(0);
  expect(b.frames - a.frames, 'avatar video frames are decoding').toBeGreaterThan(20);
  const tl = await timeline(page);
  expect(tl.iceTransportPolicy, 'avatar RTCPeerConnection stays relay-only').toBe('relay');
  expect(tl.events.some((e) => e.kind === 'pc.track' && e.trackKind !== 'video'), 'remote audio track').toBeTruthy();
  expect(tl.events.some((e) => e.kind === 'analyser.start'), 'remote audio analyser attached').toBeTruthy();
}

async function waitForPhase(page: Page, phases: string | string[], timeout: number): Promise<void> {
  const list = Array.isArray(phases) ? phases : [phases];
  await expect.poll(async () => page.getByTestId('raise-hand-panel').getAttribute('data-phase'), { timeout, intervals: [100] })
    .toMatch(new RegExp(`^(${list.join('|')})$`));
}

async function phaseTime(page: Page, phase: string, after: number): Promise<number | null> {
  const tl = await timeline(page);
  return tl.events.find((e) => e.kind === 'qa.phase' && e.phase === phase && e.t >= after)?.t ?? null;
}

/** Wait until the current slide's narration has been audible for `ms`. */
async function waitNarrating(page: Page, ms = 3000, timeout = 60_000): Promise<number> {
  const since = await pageNow(page);
  const h = await page.waitForFunction(({ since, ms, db }) => {
    const E = (window as any).__e2e;
    const sp = E.events.filter((e: any) => e.kind === 'ws.out' && (e.type === 'conversation.item.create' || e.type === 'demo.speak'));
    const s = sp[sp.length - 1];
    if (!s) return false;
    const from = Math.max(s.t, since - 120_000);
    const first = E.levels.find(([t, d]: [number, number]) => t >= from && d > db);
    const lastL = E.levels[E.levels.length - 1];
    if (!first || !lastL) return false;
    const recentLoud = E.levels.slice(-10).some(([, d]: [number, number]) => d > db);
    return lastL[0] - first[0] >= ms && recentLoud ? first[0] : false;
  }, { since, ms, db: LOUD_DB }, { timeout });
  return (await h.jsonValue()) as number;
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: path.join(EVIDENCE, `${name}.png`), fullPage: true });
}

async function adminApi(browser: Browser): Promise<APIRequestContext> {
  const ctx = await browser.newContext({ baseURL: BASE_URL });
  return ctx.request;
}

async function uploadDeckViaApi(api: APIRequestContext, file: string): Promise<string> {
  const r = await api.post('/api/decks/upload', {
    multipart: { file: { name: path.basename(file), mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', buffer: fs.readFileSync(file) } },
    timeout: 240_000,
  });
  expect(r.ok(), await r.text()).toBeTruthy();
  return (await r.json()).deck_id as string;
}

// ═════════════════════════════════════════════════════════════════════════
// A / B / C — admin presenter (one avatar session reused across steps)
// ═════════════════════════════════════════════════════════════════════════
test.describe('@admin live presenter', () => {
  test.describe.configure({ mode: 'serial' });
  let ctx: BrowserContext;
  let page: Page;
  let deckId = '';
  const notesBySlide: Record<number, string> = {};

  test.beforeAll(async ({ browser }) => {
    ctx = await newInstrumentedContext(browser, true);
    page = await ctx.newPage();
    attachConsole(page, 'admin');
  });

  test.afterAll(async () => {
    if (page) saveJson('admin-full-timeline.json', await timeline(page).catch(() => null));
    await ctx?.close();
  });

  test('A: upload deck, Sofia connects, Present all advances on audible end', async () => {
    test.setTimeout(12 * 60_000);
    // Upload through the Decks UI.
    await page.goto('/decks');
    await expect(page.getByTestId('deck-upload-input')).toBeAttached({ timeout: 20_000 });
    await page.getByTestId('deck-upload-input').setInputFiles(DEMO_DECK);
    const card = page.getByTestId('deck-card').filter({ hasText: /demo.beginner/i });
    await expect(card.first()).toBeVisible({ timeout: 240_000 });
    const decks = await (await page.request.get('/api/decks')).json();
    const deck = decks.filter((d: any) => /demo-beginner/.test(d.title)).sort((a: any, b: any) => (a.uploaded_at < b.uploaded_at ? 1 : -1))[0];
    deckId = deck.deck_id;
    fs.writeFileSync(path.join(EVIDENCE, 'deck-id.txt'), deckId);
    const detail = await (await page.request.get(`/api/decks/${deckId}`)).json();
    detail.slides.forEach((s: any, i: number) => { notesBySlide[i + 1] = s.notes; });
    expect(detail.slides.length).toBe(5);

    await page.goto(`/decks/${deckId}/present`);
    await expect(page.getByTestId('slide-counter')).toHaveText('Slide 1 of 5');
    await expect(page.getByLabel('Avatar')).toHaveValue('photo_female');
    await expect(page.getByLabel('Avatar').locator('option')).toHaveText(['Sofia', 'Lucas']);
    await expect(page.getByTestId('slide-notes-text')).toHaveText(notesBySlide[1]);

    const attempts = await connectAvatar(page, false);
    await expectMediaFlowing(page);
    const tlConn = await timeline(page);
    const upd = tlConn.events.find((e) => e.kind === 'ws.out' && e.type === 'session.update');
    expect(upd?.session?.avatar?.character).toBe('photo_female');
    expect(upd?.session?.deck_id).toBe(deckId);
    await shot(page, 'A-connected');

    const t0 = await pageNow(page);
    await page.getByRole('button', { name: 'Present all' }).click();
    // Slides 1→2→3→4: three full narrations and three advances.
    await expect(page.getByTestId('slide-counter')).toHaveText('Slide 4 of 5', { timeout: 6 * 60_000 });
    await page.waitForFunction(() => {
      const E = (window as any).__e2e;
      return E.events.filter((e: any) => e.kind === 'ws.out' && e.type === 'conversation.item.create').length >= 4;
    }, null, { timeout: 30_000 });
    await shot(page, 'A-slide4');
    const tl = sinceT(await timeline(page), t0);
    const tr = transitions(tl);
    saveJson('A-timeline.json', { attempts, transitions: tr, ...tl });

    // No slide skipped, narration order 1,2,3,4.
    const sp = speaks(tl);
    expect(sp.map((s) => slideAt(tl, s.t)?.n)).toEqual([1, 2, 3, 4]);
    expect(slideEvents(tl).map((e) => e.n)).toEqual([1, 2, 3, 4]);
    // Spoken text source == displayed notes.
    for (const s of sp) {
      const n = slideAt(tl, s.t)!.n as number;
      expect(s.text).toBe(SPEAK_PREFIX + notesBySlide[n]);
      expect(slideAt(tl, s.t)!.notes).toBe(notesBySlide[n]);
    }
    expect(tr.map((x) => [x.from, x.to])).toEqual([[1, 2], [2, 3], [3, 4]]);
    // Primary completion signal: the avatar's server-created `events` channel.
    const full = await timeline(page);
    expect(full.events.some((e) => e.kind === 'dc.open' && e.label === 'events'), 'avatar events data channel').toBe(true);
    expect(tl.events.filter((e) => e.kind === 'dc.msg' && /TURN_END/.test(e.data ?? '')).length).toBeGreaterThanOrEqual(3);
    for (const x of tr) {
      expect(x.audibleEnd, `slide ${x.from} was audible`).not.toBeNull();
      // N+1 never starts before N is audibly finished (>= 700 ms quiet).
      expect(x.quietBeforeNextSpeakMs!, `quiet before slide ${x.to}`).toBeGreaterThanOrEqual(700);
      expect(x.loudBetweenChangeAndSpeak, `no audio between advance and slide ${x.to} request`).toBe(false);
      // No long dead time.
      expect(x.advanceDelayMs!, `advance delay after slide ${x.from}`).toBeLessThanOrEqual(2500);
      // Not cut short: audible span covers the synthesized speech.
      if (x.lastWordEndMs) expect(x.audibleMs!, `slide ${x.from} played fully`).toBeGreaterThanOrEqual(0.85 * x.lastWordEndMs);
    }
  });

  test('B1: Raise hand waits for the slide, voice question, grounded answer, resumes on next slide', async () => {
    test.setTimeout(6 * 60_000);
    expect(deckId).not.toBe('');
    await waitNarrating(page, 2000);
    const t0 = await pageNow(page);
    await expect(page.getByTestId('ask-now')).toBeVisible();
    await page.getByTestId('raise-hand').click();
    await waitForPhase(page, 'raised', 5000);
    await expect(page.getByTestId('qa-state')).toHaveText(/Hand raised — after this slide/);
    await shot(page, 'B1-raised');
    await waitForPhase(page, 'inviting', 90_000);
    await waitForPhase(page, 'listening', 30_000);
    await expect(page.getByTestId('qa-mic-level')).toBeVisible();
    await shot(page, 'B1-listening');
    await waitForPhase(page, 'thinking', 30_000);
    await expect(page.getByTestId('qa-transcript')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('qa-answer')).toBeVisible({ timeout: 30_000 });
    const transcript = (await page.getByTestId('qa-transcript').textContent()) ?? '';
    expect(transcript).toMatch(/agent/i);
    await expect(page.getByTestId('qa-answer-source')).toHaveText(/From slides? .*3/);
    await shot(page, 'B1-answer');
    await waitForPhase(page, 'resumed', 120_000);
    await expect(page.getByTestId('slide-counter')).toHaveText('Slide 5 of 5', { timeout: 15_000 });
    await page.waitForFunction((t0) => (window as any).__e2e.events.some((e: any) => e.t > t0 && e.kind === 'ws.out'
      && e.type === 'conversation.item.create' && /Thanks for watching|three-minute version/.test(e.text ?? '')), t0, { timeout: 15_000 });

    const tl = sinceT(await timeline(page), t0);
    const at = (phase: string) => tl.events.find((e) => e.kind === 'qa.phase' && e.phase === phase)!.t;
    const tRaised = at('raised'); const tInviting = at('inviting'); const tListening = at('listening');
    const tAnswering = at('answering'); const tResumed = at('resumed');
    const slide4End = lastLoud(tl.levels, tRaised, tInviting);
    const ready = tl.events.find((e) => e.kind === 'ws.in' && e.type === 'qa.ready')!;
    const begin = tl.events.find((e) => e.kind === 'ws.out' && e.type === 'qa.begin')!;
    const answer = tl.events.find((e) => e.kind === 'ws.in' && e.type === 'qa.answer')!;
    const nextSpeak = speaks(tl).find((s) => s.t > tResumed)!;
    const answerEnd = lastLoud(tl.levels, tAnswering, nextSpeak.t);
    const summary = {
      tRaised, tInviting, tListening, tAnswering, tResumed, slide4AudibleEnd: slide4End,
      quietBeforeQaBeginMs: slide4End != null ? begin.t - slide4End : null,
      inviteAudible: firstLoud(tl.levels, ready.t, tListening) != null,
      answerAudibleStart: firstLoud(tl.levels, answer.t), answerAudibleEnd: answerEnd,
      quietBeforeNextSlideMs: answerEnd != null ? nextSpeak.t - answerEnd : null,
      transcript, answer: answer.text, source_slides: answer.source_slides, grounded: answer.grounded,
      qaAudioFrames: tl.qaAudioFrames,
    };
    saveJson('B1-timeline.json', { summary, ...tl });
    expect(begin.mode).toBe('after_slide');
    expect(begin.slide).toBe(3); // 0-based: slide 4
    // The hand stayed pending until slide 4 was audibly over.
    expect(summary.quietBeforeQaBeginMs!).toBeGreaterThanOrEqual(500);
    expect(summary.inviteAudible, 'invite spoken').toBe(true);
    expect(answer.grounded).toBe(true);
    expect(answer.source_slides).toContain(2);
    expect(summary.answerAudibleStart, 'answer spoken').not.toBeNull();
    expect(summary.quietBeforeNextSlideMs!, 'next slide only after the answer').toBeGreaterThanOrEqual(700);
  });

  test('B2: Ask now interrupts promptly and re-narrates the same slide', async () => {
    test.setTimeout(5 * 60_000);
    await waitNarrating(page, 3000);
    const t0 = await pageNow(page);
    await expect(page.getByTestId('slide-counter')).toHaveText('Slide 5 of 5');
    const tBefore = await pageNow(page);
    await page.getByTestId('ask-now').click();
    const tClicked = await pageNow(page);
    await waitForPhase(page, 'listening', 30_000);
    await waitForPhase(page, 'thinking', 30_000);
    await expect(page.getByTestId('qa-answer')).toBeVisible({ timeout: 40_000 });
    await shot(page, 'B2-answer');
    await waitForPhase(page, 'resumed', 120_000);
    await page.waitForFunction((t0) => (window as any).__e2e.events.some((e: any) => e.t > t0 && e.kind === 'ws.out'
      && e.type === 'conversation.item.create' && /three-minute version/.test(e.text ?? '')), t0, { timeout: 15_000 });
    await expect(page.getByTestId('slide-counter')).toHaveText('Slide 5 of 5');
    const tl = sinceT(await timeline(page), t0 - 5000);
    const cancel = tl.events.find((e) => e.kind === 'ws.out' && e.type === 'response.cancel' && e.t >= tBefore && e.t <= tClicked);
    const tAsk = cancel?.t ?? tClicked;
    const stopAt = firstQuietRun(tl.levels, tAsk, 600);
    const begin = tl.events.find((e) => e.kind === 'ws.out' && e.type === 'qa.begin' && e.t >= tAsk)!;
    const audioClear = tl.events.find((e) => e.kind === 'ws.out' && e.type === 'output_audio_buffer.clear' && e.t >= tBefore);
    const summary = { tAsk, stopAt, stopLatencyMs: stopAt != null ? stopAt - tAsk : null, cancelSent: !!cancel,
      audioBufferClearSent: !!audioClear, beginMode: begin?.mode };
    saveJson('B2-timeline.json', { summary, ...tl });
    expect(cancel, 'response.cancel sent').toBeTruthy();
    expect(begin.mode).toBe('now');
    expect(summary.stopLatencyMs!, 'avatar audio stops within ~1.5 s').toBeLessThanOrEqual(1500);
    const ready = tl.events.find((e) => e.kind === 'ws.in' && e.type === 'qa.ready' && e.t >= tAsk)!;
    expect(lastLoud(tl.levels, stopAt! + 700, ready.t), 'narration stays stopped until the invite').toBeNull();
  });

  test('B3: typed question waits for the slide, answers and continues', async () => {
    test.setTimeout(5 * 60_000);
    await waitNarrating(page, 2000);
    const t0 = await pageNow(page);
    const q = 'How does text-to-speech fit into this presentation?';
    await page.getByTestId('qa-text-input').fill(q);
    await page.getByTestId('qa-text-submit').click();
    await waitForPhase(page, 'raised', 5000);
    await waitForPhase(page, ['inviting', 'thinking'], 90_000);
    await expect(page.getByTestId('qa-answer')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('qa-transcript')).toContainText(q);
    await expect(page.getByTestId('qa-answer-source')).toHaveText(/From slides? .*4/);
    await shot(page, 'B3-answer');
    await waitForPhase(page, 'resumed', 120_000);
    await expect(page.locator('.avatar-rail__status')).toHaveText(/Presentation complete/, { timeout: 15_000 });
    const tl = sinceT(await timeline(page), t0);
    saveJson('B3-timeline.json', tl);
    const sent = tl.events.find((e) => e.kind === 'ws.out' && e.type === 'qa.text');
    expect(sent?.text).toBe(q);
  });

  test('C: French — translated notes are displayed and spoken with a French voice', async () => {
    test.setTimeout(6 * 60_000);
    if (!deckId) {
      // Run on its own (e.g. --grep "C:"): fresh deck + avatar session.
      deckId = await uploadDeckViaApi(page.request, DEMO_DECK);
      await page.goto(`/decks/${deckId}/present`);
      await connectAvatar(page, false);
    }
    const t0 = await pageNow(page);
    const counter = page.getByTestId('slide-counter');
    while (!/Slide 1 of/.test((await counter.textContent()) ?? '')) await page.getByTestId('slide-prev').click();
    await expect(counter).toHaveText('Slide 1 of 5');
    const translated = page.waitForResponse((r) => r.url().includes(`/api/decks/${deckId}/translate-notes`), { timeout: 120_000 });
    await page.getByLabel('Language').selectOption('fr-FR');
    await expect(page.getByLabel('Voice')).toHaveValue(/^fr-FR-/);
    const tr = await translated;
    expect(tr.ok()).toBeTruthy();
    const body = await tr.json();
    expect(body.target_language).toBe('fr-FR');
    expect(Object.keys(body.translated_notes).length).toBe(5);
    await expect(page.getByTestId('slide-notes-text')).toHaveText(body.translated_notes['0'], { timeout: 15_000 });
    await expect(page.getByTestId('slide-notes-text')).toHaveAttribute('lang', 'fr-FR');
    // Reconnected with the French session; speak slide 1 explicitly.
    await expect(page.locator('.avatar-rail.is-live')).toBeVisible({ timeout: 90_000 }).catch(async () => {
      await connectAvatar(page, false);
    });
    await page.waitForTimeout(1500);
    const speakBtn = page.getByRole('button', { name: /Speak slide 1/ });
    await expect(speakBtn).toBeEnabled({ timeout: 90_000 });
    await speakBtn.click();
    await waitNarrating(page, 3000, 60_000);
    await shot(page, 'C-french');
    const tl = sinceT(await timeline(page), t0);
    saveJson('C-timeline.json', tl);
    const upd = [...tl.events].reverse().find((e) => e.kind === 'ws.out' && e.type === 'session.update');
    expect(upd?.session?.language).toBe('fr-FR');
    const echoed = [...tl.events].reverse().find((e) => e.kind === 'ws.in' && e.type === 'session.updated' && e.voice);
    expect(String(echoed?.voice), 'French voice in the live session').toMatch(/^fr-FR-/);
    const spoken = speaks(tl).filter((s) => s.type === 'conversation.item.create');
    expect(spoken.length).toBeGreaterThan(0);
    for (const s of spoken) {
      const n = slideAt(tl, s.t)!.n as number;
      expect(s.text).toBe(SPEAK_PREFIX + body.translated_notes[String(n - 1)]);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════
// D — anonymous public demo
// ═════════════════════════════════════════════════════════════════════════
test.describe('@demo anonymous live demo', () => {
  test.describe.configure({ mode: 'serial' });
  let demoPage: Page | undefined;
  test.afterEach(async () => {
    if (demoPage && !demoPage.isClosed()) saveJson('D-full-timeline.json', await timeline(demoPage).catch(() => null));
  });

  test('D: published live-demo deck, countdown, narration advance, 2 questions then limit', async ({ browser }) => {
    test.setTimeout(12 * 60_000);
    const api = await adminApi(browser);
    const demoDeck = await uploadDeckViaApi(api, DEMO_DECK);
    // Publish + live demo through the admin Decks UI.
    const adminCtx = await newInstrumentedContext(browser, true);
    const admin = await adminCtx.newPage();
    await admin.goto('/decks');
    const row = admin.getByTestId('deck-card').filter({ has: admin.locator(`a[href*="${demoDeck}"]`) });
    await expect(row).toHaveCount(1, { timeout: 20_000 });
    await row.getByTestId('publish-toggle').click();
    await expect(row.getByTestId('publish-badge')).toHaveText(/Published/);
    await row.getByTestId('live-demo-toggle').click();
    await expect(row.getByTestId('live-demo-toggle')).toHaveText(/Live demo on/);
    await shot(admin, 'D-admin-published');
    await adminCtx.close();

    // A second, long live-demo deck for the "covers about N of M slides" note.
    const fullDeck = await uploadDeckViaApi(api, FULL_DECK);
    for (const [p, b] of [['publish', { published: true }], ['live-demo', { enabled: true }]] as const) {
      const r = await api.post(`/api/decks/${fullDeck}/${p}`, { data: b });
      expect(r.ok(), await r.text()).toBeTruthy();
    }

    const ctx = await newInstrumentedContext(browser, false);
    const page = await ctx.newPage();
    demoPage = page;
    attachConsole(page, 'demo');
    const me = await (await page.request.get('/api/me')).json();
    expect(me.is_admin).toBe(false);
    // Anonymous deck JSON: titles + images only.
    const anonDeck = await (await page.request.get(`/api/decks/${demoDeck}`)).json();
    saveJson('D-anonymous-deck.json', anonDeck);
    for (const s of anonDeck.slides) {
      expect(Object.keys(s).sort()).toEqual(['image_url', 'index', 'title']);
    }
    expect(JSON.stringify(anonDeck)).not.toMatch(/notes|"body"|translated/);
    const cfg = await (await page.request.get('/api/demo/config')).json();
    expect(cfg.qa.enabled).toBe(true);
    expect(cfg.session_seconds).toBe(300);

    // Coverage note on the long deck (narration > time left).
    await page.goto(`/decks/${fullDeck}/present`);
    await expect(page.getByTestId('live-demo-available')).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('demo-start').click();
    await page.waitForFunction(() => (window as any).__e2e.events.some((e: any) => e.kind === 'ws.in' && e.type === 'demo.started'), null, { timeout: 30_000 });
    await expect(page.getByTestId('demo-coverage-note')).toBeVisible({ timeout: 10_000 });
    const noteText = (await page.getByTestId('demo-coverage-note').textContent()) ?? '';
    const started = (await timeline(page)).events.find((e) => e.kind === 'ws.in' && e.type === 'demo.started')!;
    const chars: number[] = started.narration_chars;
    const left = 300;
    let used = 0; let fit = 0;
    for (const c of chars) { used += c / 13; if (used > left) break; fit++; }
    const m = noteText.match(/covers about (\d+) of (\d+) slides/);
    expect(m, noteText).not.toBeNull();
    expect(Number(m![2])).toBe(chars.length);
    expect(Math.abs(Number(m![1]) - fit)).toBeLessThanOrEqual(1);
    expect(Number(m![1])).toBeLessThan(chars.length);
    await shot(page, 'D-coverage-note');
    saveJson('D-coverage.json', { noteText, narration_chars: chars, expectedFit: fit });
    await page.getByRole('button', { name: 'Stop' }).click();
    await page.waitForTimeout(3000);

    // The real demo on the 5-slide deck.
    await page.goto(`/decks/${demoDeck}/present`);
    await expect(page.getByTestId('live-demo-available')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.presenter-settings')).toHaveCount(0);
    await connectAvatar(page, true);
    await expectMediaFlowing(page);
    await expect(page.getByTestId('demo-time-left')).toHaveText(/Demo time left [45]:\d\d/);
    const startedD = (await timeline(page)).events.filter((e) => e.kind === 'ws.in' && e.type === 'demo.started').pop()!;
    expect(startedD.remaining_ms).toBe(300_000);
    // 5 slides × ~35 s fit in 5:00 → no coverage note.
    await expect(page.getByTestId('demo-coverage-note')).toHaveCount(0);
    await expect(page.getByTestId('ask-now')).toHaveCount(0);
    await expect(page.getByTestId('qa-text-input')).toHaveCount(0);
    await expect(page.getByTestId('qa-remaining')).toHaveText('2 questions left');
    await shot(page, 'D-connected');

    const t0 = await pageNow(page);
    await page.getByRole('button', { name: 'Present all' }).click();
    // Q1 during slide 1, Q2 during slide 3 (after_slide → answers then next slide).
    for (const [slideNo, left] of [[1, 1], [3, 0]] as const) {
      await expect(page.getByTestId('slide-counter')).toHaveText(`Slide ${slideNo} of 5`, { timeout: 4 * 60_000 });
      await waitNarrating(page, 2000);
      await expect(page.getByTestId('ask-now')).toHaveCount(0);
      await page.getByTestId('raise-hand').click();
      await waitForPhase(page, 'raised', 5000);
      await waitForPhase(page, 'listening', 90_000);
      await waitForPhase(page, ['thinking', 'error'], 30_000);
      await expect(page.getByTestId('qa-answer')).toBeVisible({ timeout: 40_000 });
      await shot(page, `D-answer-${slideNo}`);
      await waitForPhase(page, 'resumed', 120_000);
      await expect(page.getByTestId('qa-remaining')).toHaveText(left === 1 ? '1 question left' : '0 questions left');
      await expect(page.getByTestId('slide-counter')).toHaveText(`Slide ${slideNo + 1} of 5`, { timeout: 15_000 });
    }
    await expect(page.getByTestId('raise-hand')).toBeDisabled();
    await expect(page.getByTestId('slide-counter')).toHaveText('Slide 5 of 5', { timeout: 4 * 60_000 });
    await waitNarrating(page, 2000);
    await shot(page, 'D-slide5');

    const tl = sinceT(await timeline(page), t0);
    // Countdown vs server clock: every server remaining_ms vs the displayed clock right after it.
    const clockChecks = tl.events.filter((e) => e.kind === 'ws.in' && typeof e.remaining_ms === 'number').map((e) => {
      const shown = tl.events.find((c) => c.kind === 'demo.clock' && c.t >= e.t + 1100 && c.t <= e.t + 3000);
      const mm = shown?.clock?.match(/(\d+):(\d\d)/);
      const shownS = mm ? Number(mm[1]) * 60 + Number(mm[2]) : null;
      const expected = (e.remaining_ms - (shown ? shown.t - e.t : 0)) / 1000;
      return { type: e.type, remaining_ms: e.remaining_ms, shown: shown?.clock, diffS: shownS != null ? shownS - expected : null };
    });
    const tr = transitions(tl).filter((x) => !tl.events.some((e) => e.kind === 'qa.phase' && e.phase === 'raised'
      && e.t >= (x.audibleStart ?? 0) - 60_000 && e.t <= x.slideChangeAt));
    saveJson('D-timeline.json', { clockChecks, transitions: transitions(tl), plainTransitions: tr, ...tl });
    const diffs = clockChecks.filter((c) => c.diffS != null);
    expect(diffs.length).toBeGreaterThan(2);
    for (const c of diffs) expect(Math.abs(c.diffS!), `countdown vs server (${c.type})`).toBeLessThanOrEqual(2);
    expect(tr.length, 'narration-only transitions measured').toBeGreaterThanOrEqual(1);
    for (const x of tr) {
      expect(x.quietBeforeNextSpeakMs!).toBeGreaterThanOrEqual(700);
      expect(x.advanceDelayMs!).toBeLessThanOrEqual(2500);
      expect(x.loudBetweenChangeAndSpeak).toBe(false);
    }
    const speakSlides = speaks(tl).map((s) => s.slide);
    expect(speakSlides).toEqual([0, 1, 2, 3, 4]);
    await ctx.close();
  });
});

// ═════════════════════════════════════════════════════════════════════════
// E / F — podcast (API-driven, real Azure OpenAI + batch avatar + ffmpeg)
// ═════════════════════════════════════════════════════════════════════════
async function ingest(api: APIRequestContext): Promise<any> {
  const r = await api.post('/api/podcast/ingest', {
    multipart: { file: { name: path.basename(DEMO_DECK), mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', buffer: fs.readFileSync(DEMO_DECK) } },
    timeout: 240_000,
  });
  expect(r.ok(), await r.text()).toBeTruthy();
  return (await r.json()).document;
}

async function script(api: APIRequestContext, documentId: string, level: string | null, turns = 4): Promise<{ id: string; turns: any[] }> {
  const r = await api.post('/api/podcast/script/stream', {
    data: { document_id: documentId, language: 'en-US', style: 'casual', length: 'short', num_turns: turns, audience_level: level },
    timeout: 180_000,
  });
  expect(r.ok()).toBeTruthy();
  const raw = await r.text();
  const turnsOut: any[] = [];
  let id = '';
  for (const block of raw.split('\n\n')) {
    const ev = block.match(/^event: (\w+)/m)?.[1];
    const data = block.match(/^data: (.*)$/m)?.[1];
    if (!ev || !data) continue;
    if (ev === 'turn') turnsOut.push(JSON.parse(data));
    if (ev === 'done') id = JSON.parse(data).script_id;
    if (ev === 'error') throw new Error(`script error: ${data}`);
  }
  expect(id).not.toBe('');
  return { id, turns: turnsOut };
}

function tool(name: 'ffmpeg' | 'ffprobe'): string {
  for (const dir of (process.env.OZ_RADIO_E2E_TOOL_DIRS ?? '').split(path.delimiter).filter(Boolean)) {
    const p = path.join(dir, process.platform === 'win32' ? `${name}.exe` : name);
    if (fs.existsSync(p)) return p;
  }
  return name;
}

/** Fraction of chroma-green pixels (g > 150, r,b < 100) in a raw RGB crop. */
function greenFraction(png: string, crop: string): number {
  const raw = execFileSync(tool('ffmpeg'), ['-v', 'error', '-i', png, '-vf', `crop=${crop}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 64 * 1024 * 1024 });
  let green = 0;
  for (let i = 0; i < raw.length; i += 3) if (raw[i + 1] > 150 && raw[i] < 100 && raw[i + 2] < 100) green++;
  return green / (raw.length / 3);
}

/** Stable job warning codes (services/podcast_media.WARNING_CODES). */
const KNOWN_WARNINGS = ['listener_fallback', 'listener_static', 'listener_timeout', 'reactions_skipped', 'radio_fallback', 'cover_fallback'];

/** Library episode rendered by E (job id), played by G. */
let podcastLibraryJob = '';

interface LibraryEntry { job_id: string; format?: string | null; has_video?: boolean | null; has_audio?: boolean | null }
interface RadioTurn { turn_idx: number; speaker: string; start: number; end: number; video_start?: number | null; video_end?: number | null }
interface RadioTranscript { duration_sec: number; turns: RadioTurn[] }

/** Port of RadioPlayer.mapRenditionTime: radio <-> video position, turn by turn. */
function mapRenditionTime(transcript: RadioTranscript, t: number, from: 'video' | 'audio'): number {
  const time = Number.isFinite(t) && t > 0 ? t : 0;
  const spans = transcript.turns
    .filter((x) => typeof x.video_start === 'number' && typeof x.video_end === 'number')
    .map((x) => {
      const audio: [number, number] = [x.start, x.end];
      const video: [number, number] = [x.video_start as number, x.video_end as number];
      return from === 'video' ? { src: video, dst: audio } : { src: audio, dst: video };
    })
    .sort((a, b) => a.src[0] - b.src[0]);
  if (spans.length === 0) return time;
  if (time < spans[0].src[0]) return Math.max(0, spans[0].dst[0] - (spans[0].src[0] - time));
  let i = spans.length - 1;
  while (i > 0 && spans[i].src[0] > time) i--;
  const { src, dst } = spans[i];
  if (time <= src[1]) {
    const span = src[1] - src[0];
    return dst[0] + (span > 0 ? (time - src[0]) / span : 0) * (dst[1] - dst[0]);
  }
  return i + 1 < spans.length ? spans[i + 1].dst[0] : dst[1] + (time - src[1]);
}

/** A library row action (button or deep link) by accessible name. */
function rowAction(row: Locator, name: RegExp): Locator {
  return row.getByRole('button', { name }).or(row.getByRole('link', { name })).first();
}

test.describe('@podcast podcast render + audience level', () => {
  test('E: short podcast with Sofia + Lucas renders a correct 1920x1080 layout', async ({ browser }) => {
    test.setTimeout(30 * 60_000);
    const api = await adminApi(browser);
    const avatars = await (await api.get('/api/podcast/avatars')).json();
    expect(avatars.map((a: any) => a.display_name).sort()).toEqual(['Lucas', 'Sofia']);
    const doc = await ingest(api);
    expect(doc.source_kind).toBe('pptx');
    expect(doc.slide_images.length).toBe(5);
    const s = await script(api, doc.id, 'beginner', 4);
    saveJson('E-script.json', s);
    const job0 = await (await api.post('/api/podcast/render', {
      data: {
        script_id: s.id, layout: 'split_screen_with_slides', music: true, intro: true,
        roles: {
          interviewer: { display_name: 'Sofia', avatar: 'photo_female', voice: 'en-US-Ava:DragonHDLatestNeural' },
          expert: { display_name: 'Lucas', avatar: 'photo_male', voice: 'en-US-Andrew:DragonHDLatestNeural' },
        },
      },
    })).json();
    expect(job0.id, JSON.stringify(job0)).toMatch(/^job-/);
    const tStart = Date.now();
    let job = job0;
    while (!['done', 'failed', 'cancelled'].includes(job.state)) {
      await new Promise((r) => setTimeout(r, 15_000));
      job = await (await api.get(`/api/podcast/jobs/${job0.id}`)).json();
      fs.appendFileSync(path.join(EVIDENCE, 'E-render-progress.log'), `${new Date().toISOString()} ${job.state} ${job.progress?.stage} ${job.progress?.completed}/${job.progress?.total} ${job.progress?.message ?? ''}\n`);
    }
    const renderMin = (Date.now() - tStart) / 60_000;
    test.info().annotations.push({ type: 'render-minutes', description: renderMin.toFixed(1) });
    expect(job.state, job.error ?? '').toBe('done');
    // Watch + Listen: a video job also carries the radio master and reports its listener.
    const warnings: string[] = job.warnings ?? [];
    test.info().annotations.push(
      { type: 'listener-mode', description: String(job.listener_mode) },
      { type: 'audio-kind', description: String(job.outputs?.audio_kind) },
      { type: 'warnings', description: warnings.join(',') || 'none' },
    );
    expect(job.format ?? 'video').toBe('video');
    expect(job.outputs?.mp3_url, 'radio MP3 route').toBeTruthy();
    expect(warnings.filter((w) => !KNOWN_WARNINGS.includes(w)), 'warnings are stable codes').toEqual([]);
    expect.soft(job.outputs?.audio_kind, 'dedicated radio mix (not the soundtrack fallback)').toBe('radio_mix');
    expect.soft(job.listener_mode, 'alive listener loop').toBe('idle_loop');
    if (job.archive_state === 'published') podcastLibraryJob = job.library_job_id ?? job0.id;
    const mp4 = path.join(EVIDENCE, 'E-podcast.mp4');
    const file = await api.get(`/api/podcast/jobs/${job0.id}/file/mp4`, { timeout: 120_000 });
    expect(file.ok()).toBeTruthy();
    fs.writeFileSync(mp4, await file.body());
    const probe = JSON.parse(execFileSync(tool('ffprobe'), ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
      'stream=width,height:format=duration', '-of', 'json', mp4]).toString());
    expect(probe.streams[0].width).toBe(1920);
    expect(probe.streams[0].height).toBe(1080);
    const dur = Number(probe.format.duration);
    const frames: string[] = [];
    for (const [i, frac] of [0.3, 0.55, 0.8].entries()) {
      const out = path.join(EVIDENCE, `E-frame-${i + 1}.png`);
      execFileSync(tool('ffmpeg'), ['-v', 'error', '-y', '-ss', (dur * frac).toFixed(2), '-i', mp4, '-frames:v', '1', out]);
      frames.push(out);
    }
    // No chroma-green left in the avatar band (top 360 px).
    const greens = frames.map((f) => greenFraction(f, '1920:360:0:0'));
    saveJson('E-summary.json', { job: job0.id, renderMinutes: renderMin, duration: dur, frames, greenFractionTopBand: greens,
      listenerMode: job.listener_mode, warnings, audioKind: job.outputs?.audio_kind, archiveState: job.archive_state,
      audioDuration: job.outputs?.audio_duration_sec, videoDuration: job.outputs?.video_duration_sec });
    for (const g of greens) expect(g).toBeLessThan(0.005);
    expect(renderMin, 'render time').toBeLessThan(15);
  });

  test('F: beginner vs expert scripts differ in vocabulary and depth', async ({ browser }) => {
    test.setTimeout(10 * 60_000);
    const api = await adminApi(browser);
    const doc = await ingest(api);
    const beginner = await script(api, doc.id, 'beginner', 8);
    const expert = await script(api, doc.id, 'expert', 8);
    const text = (s: { turns: any[] }) => s.turns.map((t) => `${t.speaker}: ${t.text}`).join('\n');
    const words = (s: string) => s.toLowerCase().match(/[a-z][a-z-]+/g) ?? [];
    const stats = (s: string) => {
      const w = words(s);
      return { words: w.length, avgWordLen: w.reduce((a, x) => a + x.length, 0) / Math.max(1, w.length), longWords: w.filter((x) => x.length >= 10).length / Math.max(1, w.length) };
    };
    const b = text(beginner); const e = text(expert);
    fs.writeFileSync(path.join(EVIDENCE, 'F-beginner.txt'), b);
    fs.writeFileSync(path.join(EVIDENCE, 'F-expert.txt'), e);
    const sb = stats(b); const se = stats(e);
    saveJson('F-summary.json', { beginner: sb, expert: se });
    expect(b).not.toBe(e);
    expect(se.longWords, 'expert script uses more technical vocabulary').toBeGreaterThan(sb.longWords);
  });

  test('G: library Watch + Listen — the radio player plays with live captions and lit hosts; Watch resumes the video at the mapped position', async ({ browser }) => {
    test.setTimeout(8 * 60_000);
    const api = await adminApi(browser);
    const list: LibraryEntry[] = await (await api.get('/api/podcast/library')).json();
    const both = (i: LibraryEntry) => (i.has_video ?? i.format !== 'audio') && (i.has_audio ?? true);
    const target = list.find((i) => i.job_id === podcastLibraryJob && both(i)) ?? list.find(both);
    if (!target) {
      test.skip(true, 'No library podcast with a video and a radio rendition: run E first (the backend needs AZURE_BLOB_* storage)');
      return;
    }
    const item = await (await api.get(`/api/podcast/library/${target.job_id}`)).json();
    let transcript: RadioTranscript | null = item.transcript ?? null;
    if (!transcript) {
      const r = await api.get(`/api/podcast/jobs/${target.job_id}/file/transcript`);
      transcript = r.ok() ? await r.json() : null;
    }
    expect(transcript?.turns?.length, 'radio transcript with turns').toBeGreaterThan(0);
    const tr = transcript as RadioTranscript;
    // Legacy (soundtrack) items may lack video offsets: the player then maps positions 1:1.
    const videoOffsets = tr.turns.every((t) => typeof t.video_start === 'number' && typeof t.video_end === 'number');
    if (target.job_id === podcastLibraryJob) expect(videoOffsets, 'transcript turns carry video_start/video_end').toBe(true);

    const ctx = await browser.newContext({ baseURL: BASE_URL, viewport: { width: 1440, height: 1000 } });
    const page = await ctx.newPage();
    attachConsole(page, 'G');
    const summary: Record<string, unknown> = { job: target.job_id, renderedByE: target.job_id === podcastLibraryJob, videoOffsets };
    try {
      const fetched: string[] = [];
      page.on('request', (r) => {
        const m = new URL(r.url()).pathname.match(/\/api\/podcast\/library\/(job-[0-9a-f]{8})$/);
        if (m) fetched.push(m[1]);
      });
      const codecs = await page.evaluate(() => ({
        mp3: document.createElement('audio').canPlayType('audio/mpeg'),
        mp4: document.createElement('video').canPlayType('video/mp4; codecs="avc1.640028, mp4a.40.2"'),
      }));
      summary.codecs = codecs;
      expect(codecs.mp3 && codecs.mp4, `this Chromium plays MP3 and H.264/AAC (${JSON.stringify(codecs)})`).toBeTruthy();

      // The library row offers Watch and Listen side by side.
      await page.goto('/podcast/library');
      const rows = page.getByTestId('library-item');
      await expect(rows.first()).toBeVisible({ timeout: 30_000 });
      const row = rows.nth(list.findIndex((i) => i.job_id === target.job_id));
      await row.scrollIntoViewIfNeeded();
      const watch = rowAction(row, /^watch\b/i);
      const listen = rowAction(row, /^listen\b/i);
      await expect(watch, 'Watch on the library row').toBeVisible();
      await expect(listen, 'Listen on the library row').toBeVisible();
      await shot(page, 'G-library-row');

      // Listen: the radio player opens on the Listen tab and plays.
      await listen.click();
      const dialog = page.getByRole('dialog');
      const listenTab = dialog.getByRole('tab', { name: /listen/i });
      const watchTab = dialog.getByRole('tab', { name: /watch/i });
      await expect(listenTab).toHaveAttribute('aria-selected', 'true', { timeout: 30_000 });
      const player = dialog.getByTestId('radio-player');
      await expect(player).toBeVisible({ timeout: 30_000 });
      const episode = new URL(page.url()).searchParams.get('episode');
      expect(episode === target.job_id || fetched.includes(target.job_id),
        `the row opened ${target.job_id} (url episode=${episode}, fetched ${fetched.join(',') || 'none'})`).toBe(true);
      const audio = dialog.getByTestId('radio-audio');
      await expect(audio).toHaveAttribute('src', /\S/, { timeout: 30_000 });
      const audioEl = (await audio.elementHandle()) as ElementHandle<HTMLAudioElement>;
      const audioState = () => audioEl.evaluate((a) => ({ t: a.currentTime, paused: a.paused, duration: a.duration }));
      const autoplayed = await expect.poll(async () => (await audioState()).paused, { timeout: 5_000 }).toBe(false)
        .then(() => true, () => false);
      summary.autoplayed = autoplayed;
      if (!autoplayed) await dialog.getByTestId('radio-play').click();
      await expect(player).toHaveAttribute('data-state', 'playing', { timeout: 30_000 });
      const t0 = (await audioState()).t;
      await expect.poll(async () => (await audioState()).t, { timeout: 20_000, message: 'radio currentTime advances' })
        .toBeGreaterThan(t0 + 2);

      // Live caption follows the audio.
      const caption = dialog.getByTestId('radio-caption');
      const captionText = async () => ((await caption.textContent()) ?? '').trim();
      await expect(caption, 'a live caption is shown').toHaveText(/\S/, { timeout: 20_000 });
      const firstCaption = await captionText();
      await expect.poll(async () => {
        const text = await captionText();
        return text && text !== firstCaption ? 'updated' : 'same';
      }, { timeout: 45_000, message: 'the live caption updates' }).toBe('updated');
      summary.captions = [firstCaption, await captionText()];

      // Exactly one host disc lights up, and it is the speaker of the current turn.
      await expect(dialog.locator('[data-testid^="radio-host-"][data-speaking="true"]'), 'a host disc lights up while playing')
        .toHaveCount(1, { timeout: 15_000 });
      const hostSamples: { t: number; lit: string[]; speaker: string | null }[] = [];
      for (let i = 0; i < 10; i++) {
        const s = await page.evaluate(() => ({
          t: document.querySelector<HTMLAudioElement>('[data-testid="radio-audio"]')?.currentTime ?? -1,
          lit: [...document.querySelectorAll('[data-testid^="radio-host-"][data-speaking="true"]')]
            .map((e) => (e.getAttribute('data-testid') ?? '').replace('radio-host-', '')),
        }));
        const turn = tr.turns.find((x) => s.t >= x.start + 0.5 && s.t <= x.end - 0.5);
        hostSamples.push({ ...s, speaker: turn?.speaker ?? null });
        await page.waitForTimeout(600);
      }
      summary.hostSamples = hostSamples;
      const judged = hostSamples.filter((s) => s.speaker);
      expect(judged.length, 'host lighting sampled inside turns').toBeGreaterThan(0);
      expect(judged.filter((s) => s.lit.length !== 1 || s.lit[0] !== s.speaker), 'the lit host disc is the current speaker')
        .toEqual([]);
      await shot(page, 'G-listen-playing');

      // Seek the radio to ~45 % so that the Watch position mapping is not trivial.
      const radioDuration = (await audioState()).duration;
      const wave = dialog.getByTestId('radio-waveform');
      const box = await wave.boundingBox();
      expect(box, 'waveform slider').not.toBeNull();
      await wave.click({ position: { x: box!.width * 0.45, y: box!.height / 2 } });
      await expect.poll(async () => (await audioState()).t, { timeout: 10_000, message: 'a waveform click seeks the radio' })
        .toBeGreaterThan(radioDuration * 0.4);
      await expect(player).toHaveAttribute('data-state', 'playing', { timeout: 15_000 });
      await page.waitForTimeout(1500);

      // Watch: the radio pauses and the video plays from the mapped position.
      const tAudio = (await audioState()).t;
      const expectedVideo = mapRenditionTime(tr, tAudio, 'audio');
      const tSwitch = Date.now();
      await watchTab.click();
      await expect(watchTab).toHaveAttribute('aria-selected', 'true');
      await expect.poll(async () => (await audioState()).paused, { timeout: 5_000, message: 'the radio pauses on Watch' })
        .toBe(true);
      const video = dialog.locator('video:visible').first();
      await expect(video).toBeVisible({ timeout: 30_000 });
      const videoEl = (await video.elementHandle()) as ElementHandle<HTMLVideoElement>;
      const videoState = () => videoEl.evaluate((v) => ({
        t: v.currentTime, paused: v.paused, seeking: v.seeking, ready: v.readyState, duration: v.duration,
      }));
      await expect.poll(async () => {
        const s = await videoState();
        return !s.paused && !s.seeking && s.ready >= 3;
      }, { timeout: 30_000, message: 'the video plays on Watch' }).toBe(true);
      const vStart = (await videoState()).t;
      const switchSec = (Date.now() - tSwitch) / 1000;
      Object.assign(summary, { radioDuration, tAudio, expectedVideo, vStart, switchSec });
      expect(vStart, `video starts near the mapped position ${expectedVideo.toFixed(1)}s (radio ${tAudio.toFixed(1)}s)`)
        .toBeGreaterThanOrEqual(expectedVideo - 1.5);
      expect(vStart, `video starts near the mapped position ${expectedVideo.toFixed(1)}s (+${switchSec.toFixed(1)}s switch)`)
        .toBeLessThanOrEqual(expectedVideo + switchSec + 1.5);
      await page.waitForTimeout(2500);
      const vLater = await videoState();
      summary.videoLater = vLater;
      expect(vLater.paused, 'the video keeps playing').toBe(false);
      expect(vLater.t - vStart, 'video currentTime advances').toBeGreaterThan(1);
      expect((await audioState()).paused, 'one active media element: the radio stays paused').toBe(true);
      await shot(page, 'G-watch-video');

      // Same episode on both tabs: the tight radio mix is not longer than the video.
      expect(Number.isFinite(radioDuration) && Number.isFinite(vLater.duration), 'media durations are known').toBe(true);
      expect(radioDuration, 'Listen is not longer than Watch (+1 s)').toBeLessThanOrEqual(vLater.duration + 1);
      expect(radioDuration / vLater.duration, 'Listen covers the same episode (>= 50 % of Watch)').toBeGreaterThanOrEqual(0.5);
      expect(Math.abs(radioDuration - tr.duration_sec), 'radio duration matches the transcript').toBeLessThanOrEqual(1);

      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden({ timeout: 10_000 });
      await expect.poll(async () => (await videoState()).paused, { timeout: 5_000, message: 'closing the player stops the video' })
        .toBe(true);
    } finally {
      saveJson('G-summary.json', summary);
      await ctx.close();
    }
  });
});
