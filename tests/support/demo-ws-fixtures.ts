import { expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEMO_ACTIVITY_MIN_INTERVAL_SECONDS,
  DEMO_AZURE_EVENTS as AZ,
  DEMO_CLOSE_CODES as CLOSE,
  DEMO_CLOSE_REASONS,
  DEMO_IDLE_ANNOUNCE_MIN_DELTA_SECONDS,
  DEMO_IDLE_CLOSE_SECONDS,
  DEMO_AUDIO_TAIL_GRACE_SECONDS,
  DEMO_IDLE_CHECK_INTERVAL_SECONDS,
  DEMO_FIRST_AUDIO_LATENCY_SECONDS,
  DEMO_NARRATION_CHARS_PER_SECOND,
  DEMO_MAX_TEXT_QUESTION_CHARS,
  DEMO_MSG as MSG,
  DEMO_PROTOCOL_VERSION,
  DEMO_QA_LIMIT_MESSAGES,
  DEMO_TEXT_TOO_LONG_MESSAGE,
  type DemoCaptionKind,
  type DemoQaLimitScope,
} from '../../demos/frontend/src/services/demoProtocol';
import { avatar } from './mock-api';

/**
 * Executable contract of the demo WebSocket (`/ws/voice/demo`, protocol v2 — fleet/contracts.md §4) for mocked specs.
 * Only WU-F0 edits this file. It speaks the protocol the way the real server will (WU-G), and the v1 server on request
 * (`protocol: 1`), so a unit's spec exercises its UI against both.
 *
 *   mockDemoSocket(page, opts)   the server side: demo.started right after accept (before anything else, like the real
 *                                endpoint), demo.speaking, per-speak captions + word timestamps + response.done (optionally
 *                                spread over `responseMs`), response.cancel, demo.narration_complete after the last slide,
 *                                the busy-based idle close (4002) with its `demo.idle` announcements and the `demo.activity`
 *                                keep-alive (v1.3), qa.ask_text, voice questions, demo.finish (4001 at any
 *                                time, even before the avatar service answers), scripted close codes, an `error` event
 *   refuseDemoHandshake(page)    the socket never opens and closes with 1006 (pre-accept refusal, proxy, VPN)
 *   demoProbe(page)              drives a WebSocket from the page itself (socket-level checks, no UI)
 *   demoHooks                    the avatar test hooks of the dev build (`window.__ozRadioTest`) — see mock-api.ts `avatar`
 *   expectedIdleCloseMs()        the reference formula of the idle clock, for assertions
 */

// ── Server texts, read from the backend source so simulated payloads are the real ones ───────────────────────────
const backend = (rel: string) => {
  try {
    return fs.readFileSync(path.join(__dirname, '..', '..', 'demos', 'backend', rel), 'utf8');
  } catch {
    return '';
  }
};

const FALLBACK_QA_ERRORS: Record<string, string> = {
  no_speech: "I didn't catch a question. Please try again.",
  too_long: 'That question is too long. Please keep it under 15 seconds.',
  limit: 'No more questions are available for this session.',
  rate: 'Audio was sent too fast. Please try again.',
  stt_failed: "Sorry, I couldn't process the audio. Please try again.",
  answer_failed: "Sorry, I couldn't answer that right now.",
  bad_state: "That request isn't valid right now.",
  disabled: 'Questions are not available.',
  time_low: "There isn't enough time left in this session for a question.",
  bad_deck: "That deck isn't available.",
};

/** voice_questions.py `ERROR_MESSAGES` (sent as `qa.error.message`; the SPA shows it verbatim). */
export const SERVER_QA_ERRORS: Record<string, string> = (() => {
  const src = backend('services/voice_questions.py');
  const start = src.indexOf('ERROR_MESSAGES');
  const out: Record<string, string> = {};
  if (start >= 0) {
    const block = src.slice(start, src.indexOf('}', start));
    for (const m of block.matchAll(/"([a-z_]+)":\s*"((?:[^"\\]|\\.)*)"/g)) out[m[1]] = m[2];
  }
  return { ...FALLBACK_QA_ERRORS, ...out };
})();

const FALLBACK_NOTICES: Record<string, string> = {
  rate_limited: 'Please wait a moment between narrations.',
  speak_limit: 'Narration limit reached for this demo session.',
  empty_slide: 'This slide has no narration.',
};

/** voice_proxy.py `DemoMessageFilter._notice(code, message)` texts. */
export const DEMO_NOTICES: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  for (const m of backend('services/voice_proxy.py').matchAll(/_notice\("([a-z_]+)",\s*"((?:[^"\\]|\\.)*)"/g)) out[m[1]] = m[2];
  return { ...FALLBACK_NOTICES, ...out };
})();

/** voice_proxy.py generic error when Azure refuses the connection in a demo session. */
export const GENERIC_PROXY_ERROR = /"(Avatar service unavailable)" if generic_errors/.exec(backend('services/voice_proxy.py'))?.[1]
  ?? 'Avatar service unavailable';

// ── Scripted data ─────────────────────────────────────────────────────────────────────────────────────────────

/** Every scriptable post-accept close: `onOpen: { close: code }` or `closeAt`. 1006 is `refuseDemoHandshake`. */
export const DEMO_SCRIPTED_CLOSES: readonly { code: number; reason: string }[] = [
  { code: CLOSE.BUSY, reason: DEMO_CLOSE_REASONS[CLOSE.BUSY] },
  { code: CLOSE.DAILY_QUOTA, reason: DEMO_CLOSE_REASONS[CLOSE.DAILY_QUOTA] },
  { code: CLOSE.STORE_OUTAGE, reason: DEMO_CLOSE_REASONS[CLOSE.STORE_OUTAGE] },
  { code: CLOSE.TIME_CAP, reason: DEMO_CLOSE_REASONS[CLOSE.TIME_CAP] },
  { code: CLOSE.FINISHED, reason: DEMO_CLOSE_REASONS[CLOSE.FINISHED] },
  { code: CLOSE.IDLE, reason: DEMO_CLOSE_REASONS[CLOSE.IDLE] },
  { code: CLOSE.SESSION_ERROR, reason: DEMO_CLOSE_REASONS[CLOSE.SESSION_ERROR] },
  { code: CLOSE.RESTART, reason: 'Service restart' },
  { code: CLOSE.NORMAL, reason: '' },
];

const NARRATIONS: Record<string, string[]> = {
  en: [
    'Welcome to this short live demo. I will explain three ideas.',
    'A model predicts the next word, again and again.',
    'An agent uses tools in a loop to get things done.',
    'A voice and a face are built from three speech technologies.',
    'Thank you for watching. Bring your questions.',
  ],
  fr: [
    'Bienvenue dans cette courte démo en direct. Je vais expliquer trois idées.',
    'Un modèle prédit le mot suivant, encore et encore.',
    'Un agent utilise des outils en boucle pour accomplir une tâche.',
    'Une voix et un visage reposent sur trois technologies vocales.',
    'Merci de votre attention. Posez vos questions.',
  ],
};

const INVITES: Record<string, string> = { en: "Go ahead, I'm listening.", fr: 'Allez-y, je vous écoute.' };
const ANSWERS: Record<string, string> = {
  en: 'The deck says growth comes from new markets.',
  fr: 'Le diaporama dit que la croissance vient de nouveaux marchés.',
};
const lang2 = (language: string) => (language.toLowerCase().startsWith('fr') ? 'fr' : 'en');

// ── Options ───────────────────────────────────────────────────────────────────────────────────────────────────

export type DemoOpen =
  /** `demo.started`, `proxy.connected`, then answers `demo.speak` / `qa.*` (the normal session). */
  | 'session'
  /**
   * `demo.started` right after accept (the real endpoint sends it before it connects to Azure), then nothing: the Azure
   * connection hangs (T3-14). Only `demo.finish` is answered (4001) — the server must honour it before `proxy.connected`.
   */
  | 'silent'
  /** `session` plus `session.updated` WITHOUT ICE servers: connected, but the avatar never gets a media path (T3-14). */
  | 'no-ice'
  /** `session` plus `session.updated` with an unreachable local TURN relay: WebRTC never connects (T3-08). */
  | 'ice'
  /** Accepted, then closed with a code (no `demo.started`): the post-accept refusals 1013 / 4429 / 4503… */
  | { close: number; reason?: string; afterMs?: number }
  /**
   * `demo.started`, an Azure-side `error` event, then a close (T3-07). By default the Azure connection failed, so there
   * is no `proxy.connected` and the close is 1011 like the target server; `connected: true` sends `proxy.connected`
   * first (a mid-session Azure error) and `closeCode: 1000` models today's bare close.
   */
  | { error: string; closeCode?: number; connected?: boolean };

export interface DemoSocketOptions {
  onOpen?: DemoOpen;
  /** The protocol spoken. 1 = an old server: no v2 fields, no captions, no narration_complete, no qa.ask_text, no demo.finish. */
  protocol?: 1 | 2;
  /** Deck language: picks the default narrations, invite and answer (default en-US). */
  language?: string;
  sessionSeconds?: number;
  /** Time left at open (default sessionSeconds × 1000); it then counts down in real time like the server's deadline. */
  remainingMs?: number;
  /** Slides of the deck (default 3, like the default mock deck). */
  slideCount?: number;
  /** Spoken text per slide (default derived from `language`). An empty string makes that slide answer `empty_slide`. */
  narrations?: string[];
  /** Milliseconds per word in `response.audio_timestamp.delta` (default 330 ≈ 180 wpm). */
  wordMs?: number;
  /** Emit `response.audio_timestamp.delta` per word (default true). */
  wordTimestamps?: boolean;
  /** Emit `demo.caption` (v2 only, default true). */
  captions?: boolean;
  /**
   * Milliseconds between `response.created` and `response.done` of every spoken response (default 0: instantaneous).
   * While it runs the response is IN FLIGHT: the idle close cannot fire, and `response.cancel` ends it with
   * `response.done {status:"cancelled"}` (no further captions, no final caption). Words are spread over the span.
   */
  responseMs?: number;
  /** Reply to every `demo.speak` with a forced notice. */
  speak?: 'speak' | 'speak_limit' | 'empty_slide' | 'rate_limited';
  /**
   * Reply to `qa.begin`. `limit` = per-session maximum, `daily` = daily budget, `quota-store` = the daily reservation failed or
   * did not answer within `QA_RESERVE_TIMEOUT_SECONDS` (3 s): `qa.error {code:"limit", scope:"unavailable"}`, and the
   * question is NOT counted for the session.
   */
  qaBegin?: 'ready' | 'silent' | 'limit' | 'daily' | 'quota-store' | 'time_low' | 'unavailable';
  /** Reply to `qa.commit`. */
  qaCommit?: 'answer' | 'no_speech' | 'stt_failed' | 'answer_failed';
  /** Reply to `qa.ask_text` (v2). `silent` = no reply at all (client ack timeout). Limits as for `qaBegin` (`quota-store` is not counted). */
  qaAskText?: 'answer' | 'silent' | 'limit' | 'daily' | 'quota-store' | 'time_low' | 'disabled' | 'bad_state' | 'answer_failed';
  /** Questions the session still allows (default 2). */
  remainingQuestions?: number;
  /** Echoed transcript of a voice question (default "What does this slide say about agents?"). */
  transcript?: string;
  /** Answer text (default per language). */
  answer?: string;
  /** Delay before `qa.transcript` / `qa.answer` after `qa.accepted` (defaults 40 / 80 ms). While it runs the question is `processing`. */
  qaDelaysMs?: { transcript?: number; answer?: number };
  /**
   * Busy-based idle close (contracts §4.5, v2 only). After `demo.narration_complete` the mock closes with 4002 when no
   * response is in flight, the question session is idle or answered, and `now ≥ idle deadline`. The deadline starts at
   * `max(t_done, t_created + 1.5 s + D) + 10 s + 30 s` (D = end of the last word timestamp, else chars / 13) and only moves
   * later: a later completed turn (its own anchor + 40 s), a terminal question event (now + 30 s).
   *
   * The number is the (grace + idle) window, 40 000 ms by default; a smaller value scales EVERY idle duration by
   * `idleCloseMs / 40 000` (latency, D, the 30 s, the 1 s check interval), so a spec can run it in ~2 s.
   * `false` = report the real, unscaled `idle_close_ms` but never close.
   *
   * v1.3: a `demo.activity` (the visitor is composing a question) pushes the deadline to now + 30 s — honoured only after the
   * narration is complete and while a question can still be asked, at most one per 5 s (scaled like the rest), never a
   * reply — and every move of the deadline later by ≥ 1 s (scaled) since the last value sent is announced as
   * `demo.idle {idle_close_ms}` from the idle ticker (also with `false`, which only stops the closing).
   */
  idleCloseMs?: number | false;
  /** Close mid-session: after the first `demo.speak` ack, after `demo.narration_complete`, after the first answer, or N ms after open. */
  closeAt?: { code: number; reason?: string; on: 'first-speak' | 'narration-complete' | 'first-answer' | number };
}

export interface DemoWord { text: string; offsetMs: number; durationMs: number }

/** One spoken response the mock produced (the audio the avatar would play). */
export interface DemoTurn {
  responseId: string;
  itemId: string;
  kind: DemoCaptionKind;
  slide: number | null;
  text: string;
  words: DemoWord[];
  /** End of the last word (ms from the start of the turn's audio): what Azure's timestamps add up to. */
  endMs: number;
  /** `in_progress` while in flight, then how `response.done` reported it. */
  status: 'in_progress' | 'completed' | 'cancelled';
}

/** One entry of `DemoSocketMock.log`: what crossed the socket, with the Node clock (`Date.now()`). */
export interface DemoLogEntry {
  t: number;
  /** `in` = client → server, `out` = server → client, `close` = the mock closed the socket (`type` is "close"). */
  dir: 'in' | 'out' | 'close';
  type: string;
  /** Close code, for `dir: 'close'`. */
  code?: number;
}

export interface DemoSocketMock {
  /**
   * The live options object: change `speak`, `qaBegin`, `qaCommit`, `qaAskText`, `idleCloseMs`, `responseMs`, `onOpen`
   * or `closeAt` between steps of a spec (read when needed). `slideCount`, `narrations`, `language` and `protocol` are
   * fixed at creation.
   */
  options: DemoSocketOptions;
  /** Every client → server JSON message, in order. */
  sent: any[];
  /** Every message in both directions plus the closes, with timestamps (for timing assertions). */
  log: DemoLogEntry[];
  /** Assistant item ids (= avatar turn ids) of every spoken response, in order. */
  items: string[];
  turns: DemoTurn[];
  /** Page sockets accepted so far. */
  connections: number;
  /** Request URLs of the accepted sockets. */
  urls: string[];
  /** Server-initiated closes, in order. */
  closes: { code: number; reason: string }[];
  ofType(type: string): any[];
  /** Pushes a server message to the page (ignored when no socket is open). */
  send(msg: object): void;
  /** Pushes a `demo.idle {idle_close_ms}` (v1.3), e.g. to re-sync the time the narration-done card counts down to. */
  idle(idleCloseMs: number): void;
  close(code: number, reason?: string): void;
  /** Resolves with the n-th (1-based) client message of `type` once it arrived. */
  waitForSent(type: string, n?: number, timeoutMs?: number): Promise<any>;
}

export const DEMO_WS_URL = /\/ws\/voice\/demo/;

const IDLE_WINDOW_MS = (DEMO_IDLE_CLOSE_SECONDS + DEMO_AUDIO_TAIL_GRACE_SECONDS) * 1000;

/**
 * Reference formula of the idle clock (contracts §4.5), in ms: how long after the narration completes the idle deadline
 * falls, when the last response was created `elapsedMs` before it completed. The deadline is
 * `max(t_done, t_created + 1.5 s + D) + 10 s + 30 s`, so the result is `(1.5 s + D) − elapsedMs + (10 s + 30 s)`, and just
 * the 40 s window once the estimated audio has already ended (`elapsedMs` ≥ 1.5 s + D). `audioMs` is D, the end of the
 * last word timestamp (chars / 13 s without timestamps). With a numeric `idleCloseMs` the audio and the windows are scaled
 * by `idleCloseMs / 40 000` (what `mockDemoSocket` does; `elapsedMs` is always real time); `false` or `undefined` = unscaled.
 * The emission loop of a "synchronous" response takes real time on a loaded machine: measure `elapsedMs` from `mock.log`
 * (`response.created` → `demo.narration_complete`) instead of assuming 0, and prefer unscaled runs for exact checks.
 * The fixture keeps the latest audible end over all responses, so the formula is exact when the last response is the one
 * whose audio ends last (a client waits for the end of a slide's audio before the next `demo.speak`).
 */
export function expectedIdleCloseMs(audioMs: number, idleCloseMs?: number | false, elapsedMs = 0): number {
  const scale = typeof idleCloseMs === 'number' ? idleCloseMs / IDLE_WINDOW_MS : 1;
  const audibleMs = (DEMO_FIRST_AUDIO_LATENCY_SECONDS * 1000 + audioMs) * scale;
  return Math.round(Math.max(audibleMs, elapsedMs) - elapsedMs + IDLE_WINDOW_MS * scale);
}

/** Registers the demo socket server. Call before `page.goto`. One page, one mock. */
export async function mockDemoSocket(page: Page, o: DemoSocketOptions = {}): Promise<DemoSocketMock> {
  const v2 = (o.protocol ?? 2) === 2;
  const language = o.language ?? 'en-US';
  const l2 = lang2(language);
  const slideCount = o.slideCount ?? 3;
  const sessionSeconds = o.sessionSeconds ?? 300;
  const narrations = o.narrations ?? Array.from({ length: slideCount }, (_, i) => NARRATIONS[l2][i % NARRATIONS[l2].length]);
  const wordMs = o.wordMs ?? 330;
  const wordTimestamps = o.wordTimestamps !== false;
  const captions = v2 && o.captions !== false;
  const maxSpeaks = Math.min(40, 2 * Math.max(1, slideCount));
  const requestIdOk = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,64}$/.test(value);

  const mock: DemoSocketMock = {
    options: o,
    sent: [], log: [], items: [], turns: [], connections: 0, urls: [], closes: [],
    send: () => {},
    idle: () => {},
    close: () => {},
    ofType(type) { return this.sent.filter((m) => m?.type === type); },
    async waitForSent(type, n = 1, timeoutMs = 20_000) {
      await expect.poll(() => mock.ofType(type).length, { timeout: timeoutMs }).toBeGreaterThanOrEqual(n);
      return mock.ofType(type)[n - 1];
    },
  };
  let turnSeq = 0;

  await page.routeWebSocket(DEMO_WS_URL, (ws) => {
    mock.connections += 1;
    mock.urls.push(ws.url());
    const openedAt = Date.now();
    const initialRemaining = o.remainingMs ?? sessionSeconds * 1000;
    const remaining = () => Math.max(0, initialRemaining - (Date.now() - openedAt));
    const timers = new Set<ReturnType<typeof setTimeout>>();
    let idleTicker: ReturnType<typeof setInterval> | null = null;
    let closed = false;
    const later = (ms: number, fn: () => void) => {
      const t = setTimeout(() => { timers.delete(t); if (!closed) fn(); }, ms);
      timers.add(t);
    };
    const note = (dir: DemoLogEntry['dir'], type: string, code?: number) => {
      mock.log.push({ t: Date.now(), dir, type, ...(code !== undefined ? { code } : {}) });
    };
    const stopTimers = () => {
      for (const t of timers) clearTimeout(t);
      timers.clear();
      if (idleTicker) clearInterval(idleTicker);
      idleTicker = null;
    };
    const send = (m: object) => {
      if (closed) return;
      note('out', String((m as { type?: unknown }).type));
      try { ws.send(JSON.stringify(m)); } catch { /* socket gone */ }
    };
    const closeWs = (code: number, reason = DEMO_CLOSE_REASONS[code] ?? '') => {
      if (closed) return;
      closed = true;
      stopTimers();
      mock.closes.push({ code, reason });
      note('close', 'close', code);
      try { void ws.close({ code, reason }); } catch { /* already closed */ }
    };
    mock.send = send;
    mock.idle = (idleCloseMs) => send({ type: MSG.IDLE, idle_close_ms: idleCloseMs });
    mock.close = closeWs;
    ws.onClose(() => { closed = true; stopTimers(); });

    let questionsLeft = o.remainingQuestions ?? 2;
    let speaks = 0;
    let answers = 0;
    const slidesSpoken = new Set<number>();
    /** False while the avatar service has not answered (`silent`, a failed connect): the proxy has no message pump yet. */
    let connected = true;

    // ── Idle close (contracts §4.5): a busy-based deadline, not a timer that is cancelled and re-armed ──
    interface Flight { turn: DemoTurn; createdAt: number; timers: Set<ReturnType<typeof setTimeout>> }
    const inflight = new Map<string, Flight>();            // responses created and not yet done (any status)
    type QaState = 'idle' | 'listening' | 'processing' | 'answered';   // the states of QaSession
    let qaState: QaState = 'idle';
    let qaRequest: string | null = null;                   // request id of the active question
    let completeSent = false;
    let idleDeadline: number | null = null;                // epoch ms; set at narration_complete, only moves later
    let announcedDeadline: number | null = null;           // the deadline the client was last told (narration_complete, then demo.idle)
    let lastActivityAt: number | null = null;              // when the last demo.activity was honoured
    let audibleEnd = 0;                                    // estimated end of the latest avatar audio (epoch ms)
    const idleScale = () => (typeof o.idleCloseMs === 'number' ? o.idleCloseMs / IDLE_WINDOW_MS : 1);
    const scaled = (seconds: number) => seconds * 1000 * idleScale();
    const idleTail = () => scaled(DEMO_AUDIO_TAIL_GRACE_SECONDS + DEMO_IDLE_CLOSE_SECONDS);
    const raiseDeadline = (t: number) => { idleDeadline = idleDeadline === null ? t : Math.max(idleDeadline, t); };
    /** A terminal question event (qa.error, qa.unavailable, qa.cancel, qa.resume): the visitor just acted. */
    const terminalQaEvent = () => { if (completeSent) raiseDeadline(Date.now() + scaled(DEMO_IDLE_CLOSE_SECONDS)); };
    /**
     * `demo.activity` (v1.3): the visitor is composing a question. Honoured only after the narration is complete and while a
     * question can still be asked, at most once per ACTIVITY_MIN_INTERVAL_SECONDS (scaled like the other idle durations);
     * pushes the deadline to now + 30 s. Never a reply (the move reaches the client as `demo.idle`), never an error.
     */
    const onActivity = () => {
      if (!v2 || !completeSent || questionsLeft <= 0 || o.qaAskText === 'disabled') return;
      const now = Date.now();
      if (lastActivityAt !== null && now - lastActivityAt < scaled(DEMO_ACTIVITY_MIN_INTERVAL_SECONDS)) return;
      lastActivityAt = now;
      raiseDeadline(now + scaled(DEMO_IDLE_CLOSE_SECONDS));
    };
    /** `demo.idle`: the deadline moved later by ≥ 1 s (scaled) since the last value the client was told. The real server does this from its idle watcher. */
    const announceIdle = () => {
      if (idleDeadline === null || announcedDeadline === null) return;
      if (idleDeadline - announcedDeadline < scaled(DEMO_IDLE_ANNOUNCE_MIN_DELTA_SECONDS)) return;
      announcedDeadline = idleDeadline;
      send({ type: MSG.IDLE, idle_close_ms: Math.max(0, Math.round(idleDeadline - Date.now())) });
    };
    const startIdleTicker = () => {
      if (!v2 || idleTicker) return;
      const everyMs = Math.max(20, Math.round(DEMO_IDLE_CHECK_INTERVAL_SECONDS * 1000 * idleScale()));
      idleTicker = setInterval(() => {
        if (closed || idleDeadline === null) return;
        if (o.idleCloseMs !== false) {
          const quiet = inflight.size === 0 && (qaState === 'idle' || qaState === 'answered');
          if (quiet && Date.now() >= idleDeadline) { closeWs(CLOSE.IDLE); return; }
        }
        announceIdle();
      }, everyMs);
    };
    const qaReset = () => { qaState = 'idle'; qaRequest = null; };

    /**
     * `qa.error`. A refused question moves the idle deadline (terminal question event); a rejected message — an invalid
     * request id (`request_id: null`) or `bad_state` — never does.
     */
    const qaError = (rid: unknown, code: string, extra: Record<string, unknown> = {}) => {
      send({
        type: MSG.QA_ERROR, request_id: rid ?? null, code,
        message: (extra.message as string | undefined) ?? SERVER_QA_ERRORS[code] ?? SERVER_QA_ERRORS.bad_state,
        remaining_ms: remaining(), ...(extra.scope ? { scope: extra.scope } : {}),
      });
      if (rid != null && code !== 'bad_state') terminalQaEvent();
    };
    /** `qa.error {code:"limit"}` with the scope and the message the server sends for it (contracts §4.4). */
    const limitError = (rid: unknown, scope: DemoQaLimitScope) => qaError(rid, 'limit', { scope, message: DEMO_QA_LIMIT_MESSAGES[scope] });
    const limitScopeOf = (mode: string): DemoQaLimitScope | null => (mode === 'limit' ? 'session' : mode === 'daily' ? 'daily' : mode === 'quota-store' ? 'unavailable' : null);

    /** Estimated audible end of a response (epoch ms): `max(t_done, t_created + 1.5 s + D)`, scaled like the deadline. */
    const audibleAnchor = (turn: DemoTurn, createdAt: number, doneAt: number) => {
      const audioMs = wordTimestamps ? turn.endMs : (turn.text.length / DEMO_NARRATION_CHARS_PER_SECOND) * 1000;
      return Math.max(doneAt, createdAt + scaled(DEMO_FIRST_AUDIO_LATENCY_SECONDS) + audioMs * idleScale());
    };
    /** A response is done (any status): it stops being in flight and, once the narration is complete, moves the deadline. */
    const endFlight = (flight: Flight, status: 'completed' | 'cancelled') => {
      inflight.delete(flight.turn.responseId);
      flight.turn.status = status;
      const doneAt = Date.now();
      if (status === 'completed') {
        const anchor = audibleAnchor(flight.turn, flight.createdAt, doneAt);
        audibleEnd = Math.max(audibleEnd, anchor);
        if (completeSent) raiseDeadline(anchor + idleTail());            // a later completed turn: its own anchor
      } else if (completeSent) {
        raiseDeadline(doneAt + scaled(DEMO_IDLE_CLOSE_SECONDS));          // cancelled: the visitor just acted
      }
    };

    /**
     * One spoken response: Azure's events, then (v2) the demo.caption mirror. Instantaneous unless `responseMs` is set, in
     * which case the words are spread over it and the response stays in flight until `response.done`.
     */
    const speakTurn = (kind: DemoCaptionKind, slide: number | null, text: string, afterDone?: () => void) => {
      turnSeq += 1;
      const responseId = `resp_${turnSeq}`;
      const itemId = `item_${turnSeq}`;
      const words: DemoWord[] = [];
      let offset = 0;
      for (const w of text.split(/\s+/).filter(Boolean)) {
        words.push({ text: w, offsetMs: offset, durationMs: wordMs });
        offset += wordMs + 20;
      }
      const turn: DemoTurn = { responseId, itemId, kind, slide, text, words, endMs: words.length ? offset - 20 : 0, status: 'in_progress' };
      mock.turns.push(turn);
      mock.items.push(itemId);
      const flight: Flight = { turn, createdAt: Date.now(), timers: new Set() };
      inflight.set(responseId, flight);
      send({ type: AZ.RESPONSE_CREATED, response: { id: responseId } });
      send({ type: AZ.OUTPUT_ITEM_ADDED, response_id: responseId, item: { id: itemId, role: 'assistant' } });
      const emitWord = (i: number) => {
        const w = words[i];
        const delta = i === 0 ? w.text : ` ${w.text}`;
        send({ type: AZ.TRANSCRIPT_DELTA, response_id: responseId, item_id: itemId, output_index: 0, content_index: 0, delta });
        if (captions) send({ type: MSG.CAPTION, slide, kind, response_id: responseId, text: delta, final: false });
        if (wordTimestamps) {
          send({
            type: AZ.TIMESTAMP_DELTA, response_id: responseId, item_id: itemId, output_index: 0, content_index: 0,
            audio_offset_ms: w.offsetMs, audio_duration_ms: w.durationMs, text: w.text, timestamp_type: 'word',
          });
        }
      };
      const finish = () => {
        if (wordTimestamps) send({ type: AZ.TIMESTAMP_DONE, response_id: responseId, item_id: itemId, output_index: 0, content_index: 0 });
        send({ type: AZ.TRANSCRIPT_DONE, response_id: responseId, item_id: itemId, output_index: 0, content_index: 0, transcript: text });
        if (captions) send({ type: MSG.CAPTION, slide, kind, response_id: responseId, text, final: true });
        // Generation finishes long before playback — the client must not treat this as the end of the audio.
        send({ type: AZ.RESPONSE_DONE, response: { id: responseId, status: 'completed' } });
        endFlight(flight, 'completed');
        afterDone?.();
      };
      const span = Math.max(0, o.responseMs ?? 0);
      if (span === 0) {
        words.forEach((_, i) => emitWord(i));
        finish();
        return;
      }
      const schedule = (ms: number, fn: () => void) => {
        const t = setTimeout(() => { flight.timers.delete(t); timers.delete(t); if (!closed) fn(); }, ms);
        flight.timers.add(t);
        timers.add(t);
      };
      words.forEach((_, i) => schedule(Math.round((i * span) / Math.max(1, words.length)), () => emitWord(i)));
      schedule(span, finish);
    };

    /** `response.cancel`: every response in flight ends with `response.done {status:"cancelled"}` — no more captions for it. */
    const cancelInflight = () => {
      for (const flight of [...inflight.values()]) {
        for (const t of flight.timers) { clearTimeout(t); timers.delete(t); }
        flight.timers.clear();
        send({ type: AZ.RESPONSE_DONE, response: { id: flight.turn.responseId, status: 'cancelled' } });
        endFlight(flight, 'cancelled');
      }
    };

    /**
     * The narration is complete: emitted once, after the `response.done` of the last slide's turn — or right after its
     * `empty_slide` notice (a slide with nothing to say counts as spoken). Starts the idle clock (busy-based deadline).
     */
    const emitNarrationComplete = () => {
      if (!v2 || completeSent) return;
      completeSent = true;
      raiseDeadline(Math.max(audibleEnd, Date.now()) + idleTail());
      announcedDeadline = idleDeadline;                    // the idle_close_ms below is the first announcement
      send({
        type: MSG.NARRATION_COMPLETE, slides_spoken: slidesSpoken.size, slide_count: slideCount,
        remaining_ms: remaining(), idle_close_ms: Math.max(0, Math.round((idleDeadline ?? Date.now()) - Date.now())),
      });
      startIdleTicker();
      if (o.closeAt?.on === 'narration-complete') later(0, () => closeWs(o.closeAt!.code, o.closeAt!.reason));
    };

    const onSpeak = (msg: any) => {
      const slide = msg.slide;
      // Dropped silently: a rejected message never moves the idle deadline and never holds the slot.
      if (typeof slide !== 'number' || !Number.isInteger(slide) || slide < 0 || slide >= slideCount) return;
      const rid = typeof msg.request_id === 'string' ? { request_id: msg.request_id } : {};
      const notice = (code: string) => {
        send({ type: MSG.NOTICE, code, message: DEMO_NOTICES[code], slide, ...rid });
        if (code === 'empty_slide' && slide === slideCount - 1) emitNarrationComplete();
      };
      const forced = o.speak ?? 'speak';
      if (forced !== 'speak') return notice(forced);
      if (speaks >= maxSpeaks) return notice('speak_limit');
      const text = narrations[slide] ?? '';
      if (text === '') return notice('empty_slide');
      speaks += 1;
      send({ type: MSG.SPEAKING, slide, chars: text.length, remaining: maxSpeaks - speaks, remaining_ms: remaining(), ...rid });
      speakTurn('narration', slide, text, () => {
        slidesSpoken.add(slide);
        if (o.closeAt?.on === 'first-speak' && speaks === 1) later(0, () => closeWs(o.closeAt!.code, o.closeAt!.reason));
        if (slide === slideCount - 1) emitNarrationComplete();
      });
    };

    /** An accepted question: `qa.transcript`, then `qa.answer` (state `answered`) and the avatar speaking it. While it runs the state is `processing`. */
    const answerTurn = (rid: string, text: string, transcript: string, delays = { transcript: 40, answer: 80 }) => {
      later(delays.transcript, () => {
        if (qaRequest !== rid) return;                      // cancelled meanwhile
        send({ type: MSG.QA_TRANSCRIPT, request_id: rid, text: transcript, remaining_ms: remaining() });
        later(delays.answer, () => {
          if (qaRequest !== rid) return;
          qaState = 'answered';
          send({ type: MSG.QA_ANSWER, request_id: rid, text, source_slides: [0], grounded: true, remaining_ms: remaining() });
          speakTurn('answer', null, text, () => {
            answers += 1;
            if (o.closeAt?.on === 'first-answer' && answers === 1) later(0, () => closeWs(o.closeAt!.code, o.closeAt!.reason));
          });
        });
      });
    };
    /** The answer could not be produced after the question was accepted: transcript echoed, then `qa.error`; the question stays consumed. */
    const failAnswer = (rid: string, transcript: string, delayMs: number) => {
      later(delayMs, () => {
        if (qaRequest !== rid) return;
        send({ type: MSG.QA_TRANSCRIPT, request_id: rid, text: transcript, remaining_ms: remaining() });
        qaReset();
        qaError(rid, 'answer_failed');
      });
    };
    const qaDelays = () => ({ transcript: o.qaDelaysMs?.transcript ?? 40, answer: o.qaDelaysMs?.answer ?? 80 });

    /** Server order (contracts §4.4): rid, enabled, slide, state, text, length, time, session limit, daily reservation. */
    const onAskText = (msg: any): void => {
      const rid = msg.request_id;
      if (!requestIdOk(rid)) return qaError(null, 'bad_state');
      const mode = o.qaAskText ?? 'answer';
      if (mode === 'disabled') return qaError(rid, 'disabled');
      const text = typeof msg.text === 'string' ? msg.text.trim() : null;
      if (text === null || typeof msg.slide !== 'number') return qaError(rid, 'bad_state');
      if (qaState === 'answered') qaReset();                // implicit resume, like QaSession
      if (mode === 'bad_state' || qaState !== 'idle') return qaError(rid, 'bad_state');
      if (!text) return qaError(rid, 'no_speech');
      if (text.length > DEMO_MAX_TEXT_QUESTION_CHARS) return qaError(rid, 'too_long', { message: DEMO_TEXT_TOO_LONG_MESSAGE });
      if (mode === 'silent') return undefined;
      if (mode === 'time_low' || remaining() < 30_000) return qaError(rid, 'time_low');
      const scope = limitScopeOf(mode);
      if (scope) return limitError(rid, scope);
      if (questionsLeft <= 0) return limitError(rid, 'session');
      questionsLeft -= 1;
      qaState = 'processing';
      qaRequest = rid;
      send({ type: MSG.QA_ACCEPTED, request_id: rid, remaining_questions: questionsLeft, remaining_ms: remaining() });
      if (mode === 'answer_failed') failAnswer(rid, text, qaDelays().transcript);
      else answerTurn(rid, o.answer ?? ANSWERS[l2], text, qaDelays());
      return undefined;
    };

    ws.onMessage((data) => {
      let msg: any;
      try { msg = JSON.parse(String(data)); } catch { return; }
      mock.sent.push(msg);
      note('in', String(msg?.type));
      const rid = msg.request_id;
      // While the avatar service has not answered (`silent`, a failed connect) the proxy has no message pump yet: only the
      // finish request is honoured, so a visitor can always leave and free the slot.
      if (!connected && msg.type !== MSG.FINISH) return;
      switch (msg.type) {
        case MSG.SPEAK:
          onSpeak(msg);
          break;
        case MSG.FINISH:
          if (v2) closeWs(CLOSE.FINISHED);
          break;
        case MSG.ACTIVITY:
          onActivity();                                     // v1.3: no reply, never an error; an old server drops it as unknown
          break;
        case MSG.RESPONSE_CANCEL:
          cancelInflight();
          break;
        case MSG.QA_BEGIN: {
          if (!requestIdOk(rid)) { qaError(null, 'bad_state'); break; }
          const mode = o.qaBegin ?? 'ready';
          if (mode === 'silent') break;
          if (mode === 'unavailable') {
            send({ type: MSG.QA_UNAVAILABLE, reason: 'no_deck', remaining_ms: remaining() });
            terminalQaEvent();
            break;
          }
          if (qaState === 'answered') qaReset();            // implicit resume, like QaSession
          if (qaState !== 'idle') { qaError(rid, 'bad_state'); break; }
          if (mode === 'time_low' || remaining() < 30_000) { qaError(rid, 'time_low'); break; }
          const scope = limitScopeOf(mode);
          if (scope) { limitError(rid, scope); break; }
          if (questionsLeft <= 0) { limitError(rid, 'session'); break; }
          questionsLeft -= 1;
          qaState = 'listening';
          qaRequest = rid;
          send({
            type: MSG.QA_READY, request_id: rid, max_audio_ms: 15000, max_audio_bytes: 480000,
            remaining_questions: questionsLeft, remaining_ms: remaining(),
          });
          speakTurn('invite', null, INVITES[l2]);
          break;
        }
        case MSG.QA_AUDIO:
          // frames of the active question are accepted without a reply
          if (!(qaState === 'listening' && rid === qaRequest)) qaError(rid, 'bad_state');
          break;
        case MSG.QA_COMMIT: {
          if (!(qaState === 'listening' && rid === qaRequest)) { qaError(rid, 'bad_state'); break; }
          const mode = o.qaCommit ?? 'answer';
          if (mode === 'no_speech' || mode === 'stt_failed') { qaReset(); qaError(rid, mode); break; }
          qaState = 'processing';
          const transcript = o.transcript ?? 'What does this slide say about agents?';
          if (mode === 'answer_failed') failAnswer(rid, transcript, qaDelays().transcript);
          else answerTurn(rid, o.answer ?? ANSWERS[l2], transcript, qaDelays());
          break;
        }
        case MSG.QA_ASK_TEXT:
          if (!v2) break; // an old server drops what it does not know
          onAskText(msg);
          break;
        case MSG.QA_CANCEL:
          if (rid === qaRequest && qaState !== 'idle') { qaReset(); terminalQaEvent(); }
          break;
        case MSG.QA_RESUME:
          if (rid === qaRequest && qaState === 'answered') { qaReset(); terminalQaEvent(); }
          break;
        default:
          break; // unknown types are dropped: they never move the idle deadline
      }
    });

    // ── what happens on open ──
    const open = o.onOpen ?? 'session';
    if (typeof open === 'object' && 'close' in open) {
      later(open.afterMs ?? 100, () => closeWs(open.close, open.reason ?? DEMO_CLOSE_REASONS[open.close] ?? ''));
      return;
    }
    // The real endpoint sends demo.started right after accept, before it connects to Azure.
    send({
      type: MSG.STARTED, session_seconds: sessionSeconds, remaining_ms: remaining(),
      narration_chars: narrations.slice(0, slideCount).map((t) => t.length),
      ...(v2 ? { protocol: DEMO_PROTOCOL_VERSION, slide_count: slideCount, idle_close_seconds: DEMO_IDLE_CLOSE_SECONDS } : {}),
    });
    if (open === 'silent') {
      connected = false;
      return;
    }
    if (typeof open === 'object' && 'error' in open) {
      connected = open.connected === true;
      if (connected) send({ type: MSG.PROXY_CONNECTED, message: 'Connected to Azure Voice API' });
      send({ type: MSG.ERROR, error: { message: open.error } });
      later(250, () => closeWs(open.closeCode ?? CLOSE.SESSION_ERROR));
      return;
    }
    send({ type: MSG.PROXY_CONNECTED, message: 'Connected to Azure Voice API' });
    if (open === 'ice') {
      // A TURN relay on localhost that does not exist: nothing leaves this machine, ICE never connects.
      send({
        type: AZ.SESSION_UPDATED,
        session: { id: 'sess_mock', avatar: { ice_servers: [{ urls: ['turn:127.0.0.1:3478'] }], username: 'mock', credential: 'mock' } },
      });
    }
    if (open === 'no-ice') send({ type: AZ.SESSION_UPDATED, session: { id: 'sess_mock', avatar: {} } });
    if (typeof o.closeAt?.on === 'number') later(o.closeAt.on, () => closeWs(o.closeAt!.code, o.closeAt!.reason));
  });
  return mock;
}

// ── Pre-accept refusal ──────────────────────────────────────────────────────────────────────────────────────

/**
 * The demo socket never opens and closes with 1006 (`onopen` never fires): what a browser sees for a pre-accept 4403 or
 * 1011, a proxy or VPN that blocks WebSockets, a dropped network. Replaces `window.WebSocket` for `/ws/voice/demo` only.
 * Works in either order with `mockDemoSocket` / `routeWebSocket` (Playwright's own WebSocket patch is wrapped, not replaced).
 */
export async function refuseDemoHandshake(page: Page, opts: { afterMs?: number } = {}): Promise<void> {
  await page.addInitScript((afterMs) => {
    type WsCtor = typeof WebSocket;
    let Native: WsCtor = window.WebSocket;
    class RefusedSocket extends EventTarget {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
      readyState = 0; url: string; protocol = ''; extensions = ''; bufferedAmount = 0; binaryType: BinaryType = 'blob';
      onopen: ((e: Event) => void) | null = null; onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: ((e: Event) => void) | null = null; onclose: ((e: CloseEvent) => void) | null = null;
      constructor(url: string) {
        super();
        this.url = url;
        setTimeout(() => {
          this.readyState = 3;
          const err = new Event('error');
          this.onerror?.(err); this.dispatchEvent(err);
          const ev = new CloseEvent('close', { code: 1006, reason: '', wasClean: false });
          this.onclose?.(ev); this.dispatchEvent(ev);
        }, afterMs);
      }
      send() { /* never open */ }
      close() { this.readyState = 3; }
    }
    const Patched = function Patched(this: unknown, url: string | URL, protocols?: string | string[]) {
      return String(url).includes('/ws/voice/demo') ? new RefusedSocket(String(url)) : new Native(url, protocols);
    } as unknown as WsCtor;
    Object.assign(Patched, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
    // An accessor keeps the wrapper in place when Playwright's routeWebSocket assigns window.WebSocket afterwards.
    Object.defineProperty(window, 'WebSocket', {
      configurable: true,
      get: () => Patched,
      set: (next: WsCtor) => { Native = next; Patched.prototype = next.prototype; },
    });
    Patched.prototype = Native.prototype;
  }, opts.afterMs ?? 400);
}

// ── Page-level probe ─────────────────────────────────────────────────────────────────────────────────────────

export interface DemoProbeClose { code: number; reason: string; wasClean: boolean; opened: boolean }

export interface DemoProbe {
  /** Opens `/ws/voice/demo?deck_id=…` from the page (the page must already have loaded). */
  open(deckId?: string): Promise<void>;
  send(msg: object): Promise<void>;
  /** Every message received so far. */
  messages(): Promise<any[]>;
  /** Resolves with the n-th (1-based) message of `type` once it arrived. */
  waitForMessage(type: string, opts?: { n?: number; timeout?: number }): Promise<any>;
  /** Resolves when the socket's `onclose` fired. */
  waitForClose(timeout?: number): Promise<DemoProbeClose>;
  /** Client-initiated close. */
  close(code?: number): Promise<void>;
}

/**
 * Default wait of the probe: generous (a loaded CI or dev machine stalls for seconds) and polled on a timer, not on
 * animation frames, so a page that is not painting still answers.
 */
const PROBE_TIMEOUT_MS = 20_000;
const PROBE_POLL_MS = 50;

/** Drives a WebSocket from inside the page — socket-level checks that need no UI. */
export function demoProbe(page: Page): DemoProbe {
  const handle = '__ozDemoProbe';
  return {
    async open(deckId = 'deck-live') {
      await page.evaluate(({ deckId: id, key }) => {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(`${proto}//${location.host}/ws/voice/demo?deck_id=${encodeURIComponent(id)}`);
        const state: { ws: WebSocket; opened: boolean; messages: any[]; closed: null | { code: number; reason: string; wasClean: boolean } } =
          { ws, opened: false, messages: [], closed: null };
        ws.onopen = () => { state.opened = true; };
        ws.onmessage = (e) => {
          try { state.messages.push(JSON.parse(String(e.data))); } catch { state.messages.push({ raw: String(e.data) }); }
        };
        ws.onclose = (e) => { state.closed = { code: e.code, reason: e.reason, wasClean: e.wasClean }; };
        (window as any)[key] = state;
      }, { deckId, key: handle });
    },
    async send(msg) {
      await page.evaluate(({ m, key }) => (window as any)[key].ws.send(JSON.stringify(m)), { m: msg, key: handle });
    },
    async messages() {
      return page.evaluate((key) => (window as any)[key].messages.slice(), handle);
    },
    async waitForMessage(type, opts = {}) {
      const n = opts.n ?? 1;
      await page.waitForFunction(
        ({ t, count, key }) => (window as any)[key].messages.filter((m: any) => m?.type === t).length >= count,
        { t: type, count: n, key: handle },
        { timeout: opts.timeout ?? PROBE_TIMEOUT_MS, polling: PROBE_POLL_MS },
      );
      return page.evaluate(({ t, count, key }) => (window as any)[key].messages.filter((m: any) => m?.type === t)[count - 1], { t: type, count: n, key: handle });
    },
    async waitForClose(timeout = PROBE_TIMEOUT_MS) {
      await page.waitForFunction((key) => !!(window as any)[key].closed, handle, { timeout, polling: PROBE_POLL_MS });
      return page.evaluate((key) => ({ ...(window as any)[key].closed, opened: (window as any)[key].opened }), handle);
    },
    async close(code = 1000) {
      await page.evaluate(({ c, key }) => (window as any)[key].ws.close(c), { c: code, key: handle });
    },
  };
}

// ── Avatar hooks ─────────────────────────────────────────────────────────────────────────────────────────────

/** `window.__ozRadioTest` is installed by AvatarPanel in the Vite dev build only (`mediaConnected`, `dataChannel`, `audioLevel`, `playback`). */
export const demoHooks = {
  ...avatar,
  /** Plays the mock's most recent spoken turn to its end (TURN_START, speech heard, TURN_END, silence). */
  async finishLastTurn(page: Page, mock: Pick<DemoSocketMock, 'items'>) {
    const id = mock.items[mock.items.length - 1];
    if (!id) throw new Error('no spoken turn to finish');
    await avatar.finishTurn(page, id);
  },
};

export { avatar };
