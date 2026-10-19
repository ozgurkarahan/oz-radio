/**
 * Demo WebSocket protocol v2 (`/ws/voice/demo`) and the live-demo outcome contract (contracts v1.2 §4).
 *
 * FROZEN shared contract file (owner WU-F0, UX-fix run). Types, constants and pure helpers only: no UI.
 * Do not edit: ask the coordinator, who records the change in fleet/contracts.md.
 *
 * Mirrors demos/backend/services/demo_protocol.py — keep both in sync. tests/ux-fixtures.spec.ts compares
 * the close codes, reasons, timings and message type names of the two files and fails when they drift.
 *
 * Who uses what:
 *   WU-G (server)  emits the new messages and close codes; imports the Python twin.
 *   WU-D (client)  maps `onclose` through `outcomeFor()`, renders `DEMO_OUTCOME_COPY` in the DemoOutcome card,
 *                  offers `findRecording()` as the primary action, speaks `qa.ask_text`, renders `demo.caption`.
 *   WU-C (Home)    links to `demoDeckPath()`.
 *   WU-E (library) opens the deep links built by `recordingPath()`.
 */
import { formatDuration, humanizeTitle, languageName, normalizeTitle, primaryLanguage } from '../ui/format';
import type { QaAnswerMessage, QaReadyMessage, QaTranscriptMessage, QaUnavailableMessage } from './api';

// ── Constants ───────────────────────────────────────────────────────────────────────────────────────

/** Value of `protocol` in `demo.started`. A server that omits it speaks v1 (no captions, no typed questions). */
export const DEMO_PROTOCOL_VERSION = 2;
export const DEMO_WS_PATH = '/ws/voice/demo';
/**
 * Idle window of the server's busy-based deadline (contracts §4.5): once the narration is complete the server closes
 * with 4002 only when no avatar response is in flight, the question session is idle or answered, and the deadline passed.
 * A terminal question event (qa.error, qa.unavailable, qa.cancel, qa.resume) moves the deadline to now + this.
 */
export const DEMO_IDLE_CLOSE_SECONDS = 30;
/** Safety margin the server adds after the estimated end of the avatar's audio before the idle window starts. */
export const DEMO_AUDIO_TAIL_GRACE_SECONDS = 10;
/** The server evaluates the idle deadline at least this often (seconds). */
export const DEMO_IDLE_CHECK_INTERVAL_SECONDS = 1;
/** Estimate of `response.created` → first audible sample (seconds): part of the idle-clock anchor. */
export const DEMO_FIRST_AUDIO_LATENCY_SECONDS = 1.5;
/** Narration speed assumed when no word timestamps arrived (characters per second); same default as NarrationRate. */
export const DEMO_NARRATION_CHARS_PER_SECOND = 13;
/** Longest typed question (characters, after trimming). Same limit as the voice transcript path. */
export const DEMO_MAX_TEXT_QUESTION_CHARS = 500;
/** Seconds before the session cap at which the countdown is announced (once each, aria-live). */
export const DEMO_WARN_AT_SECONDS = [60, 20] as const;
/** Client-side timing defaults of the live demo (WU-D may tune within reason; tests read these). */
export const DEMO_TIMING = {
  /** Non-trickle ICE: send the offer this long after the first relay candidate if gathering has not finished. */
  iceRelayGraceMs: 2000,
  /** …otherwise wait at most this long for gathering to finish. */
  iceGatherMaxMs: 5000,
  /** No ICE servers this long after the socket opened → give up ('connect' outcome, socket closed by the client). */
  setupTimeoutMs: 15000,
  /**
   * No `qa.accepted` / `qa.error` this long after `qa.ask_text` → the typed question failed. It must stay above
   * `qaReserveTimeoutMs` + 1 s: the server may spend that long reserving the daily question before it answers.
   */
  askTextAckTimeoutMs: 5000,
  /**
   * Server bound on the daily-question reservation (mirrors QA_RESERVE_TIMEOUT_SECONDS). On timeout the question is
   * refused `qa.error {code:"limit", scope:"unavailable"}` and not counted for the session.
   */
  qaReserveTimeoutMs: 3000,
} as const;
/** Same text the server sends in `qa.error {code:"too_long"}` for a typed question. */
export const DEMO_TEXT_TOO_LONG_MESSAGE = 'That question is too long. Please keep it under 500 characters.';

/** Which limit refused a question (`qa.error {code:"limit"}.scope`) and the message the server sends with it. */
export const DEMO_QA_LIMIT_MESSAGES = {
  session: 'No more questions are available for this session.',
  daily: "Today's question allowance for the live demo has been reached.",
  unavailable: 'Questions are temporarily unavailable. Please try again in a moment.',
} as const;
export type DemoQaLimitScope = keyof typeof DEMO_QA_LIMIT_MESSAGES;

/** Detail line of the `outage` outcome when the avatar service reported an error (an `error` event) before the close. */
export const DEMO_SERVICE_ERROR_DETAIL = "The live avatar service isn't responding.";

// ── Close codes ─────────────────────────────────────────────────────────────────────────────────────

export const DEMO_CLOSE_CODES = {
  NORMAL: 1000,
  GOING_AWAY: 1001,
  NO_STATUS: 1005,
  ABNORMAL: 1006,
  SESSION_ERROR: 1011,
  RESTART: 1012,
  BUSY: 1013,
  FINISHED: 4001,
  IDLE: 4002,
  REFUSED: 4403,
  TIME_CAP: 4408,
  DAILY_QUOTA: 4429,
  STORE_OUTAGE: 4503,
} as const;

/** Never use 4000: the evidence guard of the UX-evidence run closes unmocked sockets with it. */
export const DEMO_RESERVED_CLOSE_CODES: readonly number[] = [4000];

/** `reason` strings the server sets on its own close frames (ASCII, well under the 123-byte limit). */
export const DEMO_CLOSE_REASONS: Readonly<Record<number, string>> = {
  1011: 'Demo session error',
  1013: 'The demo avatar is busy, try again in a minute',
  4001: 'Demo finished',
  4002: 'Demo idle timeout',
  4403: 'Demo not available',
  4408: 'Demo time limit reached',
  4429: 'Daily demo limit reached, come back tomorrow',
  4503: 'Live demo temporarily unavailable',
};

export type DemoOutcomeKind =
  | 'finished' | 'idle' | 'cap' | 'busy' | 'quota' | 'outage' | 'connect' | 'interrupted' | 'ended';

/** Vocabulary of `ui/Alert` tones. */
export type OutcomeTone = 'success' | 'info' | 'clay' | 'error';
/** `none` = no retry button; `now` = "Try again"; `later` = "Try again in a minute" style (no countdown required). */
export type OutcomeRetry = 'none' | 'now' | 'later';

export interface DemoOutcomeCopy {
  title: string;
  detail: string;
  tone: OutcomeTone;
  /** `alert` for refusals and failures (focus moves to the card, it is announced), `status` for normal endings. */
  role: 'status' | 'alert';
  retry: OutcomeRetry;
  retryLabel?: string;
  /** Value of `outcome` in the telemetry event `oz_demo` (telemetry-spec.md). */
  telemetry: 'stop' | 'cap' | 'busy' | 'limit' | 'error' | 'blocked' | 'network';
}

/**
 * Visitor wording of every ending of a live session (plan wording; WU-D renders these, never the raw close reason).
 * Every outcome also offers the same-deck recording as the primary action (`findRecording`), or
 * DEMO_FALLBACK_LINKS when no recording can be found.
 */
export const DEMO_OUTCOME_COPY: Readonly<Record<DemoOutcomeKind, DemoOutcomeCopy>> = {
  finished: {
    title: 'Thanks for trying the live demo',
    detail: 'Your live session has ended. The recorded version of this demo is ready whenever you want it.',
    tone: 'success', role: 'status', retry: 'none', telemetry: 'stop',
  },
  idle: {
    title: 'Your live session has ended',
    detail: 'The demo had finished and the session closed after 30 seconds without activity.',
    tone: 'info', role: 'status', retry: 'none', telemetry: 'stop',
  },
  cap: {
    title: 'Your live session has ended',
    detail: 'Live sessions have a time limit. The recording shows the whole demo.',
    tone: 'info', role: 'status', retry: 'none', telemetry: 'cap',
  },
  busy: {
    title: 'Another visitor is using the avatar',
    detail: 'The live demo handles one visitor at a time. Try again in a minute, or watch the recording now.',
    tone: 'clay', role: 'alert', retry: 'later', retryLabel: 'Try again in a minute', telemetry: 'busy',
  },
  quota: {
    title: "Today's live allowance has been reached",
    detail: 'Live sessions are limited each day and start again tomorrow. The recording shows the same demo.',
    tone: 'clay', role: 'alert', retry: 'none', telemetry: 'limit',
  },
  outage: {
    title: 'Live demo temporarily unavailable',
    detail: "We couldn't start or keep the live avatar running. The recording shows the same demo.",
    tone: 'error', role: 'alert', retry: 'later', retryLabel: 'Try again', telemetry: 'error',
  },
  connect: {
    title: "Couldn't connect to the live avatar",
    detail: 'Your network, a VPN or a security filter may be blocking live connections. Try again, or watch the recording instead.',
    tone: 'error', role: 'alert', retry: 'now', retryLabel: 'Try again', telemetry: 'blocked',
  },
  interrupted: {
    title: 'The live connection was interrupted',
    detail: 'The connection dropped during your session. Try again, or watch the recording.',
    tone: 'error', role: 'alert', retry: 'now', retryLabel: 'Try again', telemetry: 'network',
  },
  ended: {
    title: 'Your live session has ended',
    detail: 'The live avatar service closed the session.',
    tone: 'info', role: 'status', retry: 'none', telemetry: 'stop',
  },
};

/** Detail used when an ambiguous 1006 is refined by `/api/demo/config` answering `enabled:false`. */
export const DEMO_SWITCHED_OFF_DETAIL = 'The live demo is switched off at the moment. The recording shows the same demo.';

/** Value of last resort when no same-deck recording is found: always something to watch or listen to. */
export const DEMO_FALLBACK_LINKS: readonly { label: string; to: string }[] = [
  { label: 'Listen to an episode', to: '/podcast/library' },
  { label: 'Watch a video', to: '/video/library' },
];

export interface DemoOutcome extends DemoOutcomeCopy {
  kind: DemoOutcomeKind;
  /** The close code that produced it. */
  code: number;
  /** Whether the socket had opened (`onopen` fired) before it closed. */
  opened: boolean;
}

export interface OutcomeContext {
  /** `/api/demo/config` re-fetched after an ambiguous 1006: `false` = the demo is switched off. */
  configEnabled?: boolean;
  /**
   * The avatar service reported an error (a proxy `error` event) on this session before it closed. Any close without
   * a meaning of its own (1000, 1001, 1005, 1006, 1011, 1012, 1015, unknown codes) then reads as an `outage` whose
   * `detail` is DEMO_SERVICE_ERROR_DETAIL; 1013, 4001, 4002, 4403, 4408, 4429 and 4503 keep their own outcome.
   */
  sawServiceError?: boolean;
}

/** Closes that mean something on their own: a service error reported before them does not change the outcome. */
const OWN_MEANING: ReadonlySet<number> = new Set([
  DEMO_CLOSE_CODES.FINISHED, DEMO_CLOSE_CODES.IDLE, DEMO_CLOSE_CODES.TIME_CAP, DEMO_CLOSE_CODES.BUSY,
  DEMO_CLOSE_CODES.DAILY_QUOTA, DEMO_CLOSE_CODES.STORE_OUTAGE, DEMO_CLOSE_CODES.REFUSED,
]);

/**
 * Maps the close of a demo socket to the outcome the visitor sees (contracts §4.6 table); the text to show is
 * `outcome.title` / `outcome.detail` (never the raw close reason).
 *   1013 busy · 4429 quota · 4408 cap · 4001 finished · 4002 idle · 4503 / 1011 / 1012 / 1001 outage ·
 *   1006 & co: not opened → connect (or switched off), opened → interrupted · bare 1000 → ended ·
 *   after a service `error` event: outage with `detail = DEMO_SERVICE_ERROR_DETAIL` (see OutcomeContext).
 */
export function outcomeFor(code: number, opened: boolean, ctx: OutcomeContext = {}): DemoOutcome {
  let kind: DemoOutcomeKind;
  let override: Partial<DemoOutcomeCopy> = {};
  switch (code) {
    case DEMO_CLOSE_CODES.FINISHED: kind = 'finished'; break;
    case DEMO_CLOSE_CODES.IDLE: kind = 'idle'; break;
    case DEMO_CLOSE_CODES.TIME_CAP: kind = 'cap'; break;
    case DEMO_CLOSE_CODES.BUSY: kind = 'busy'; break;
    case DEMO_CLOSE_CODES.DAILY_QUOTA: kind = 'quota'; break;
    case DEMO_CLOSE_CODES.STORE_OUTAGE:
    case DEMO_CLOSE_CODES.REFUSED:
      kind = 'outage';
      override = { retry: 'none', retryLabel: undefined };
      break;
    case DEMO_CLOSE_CODES.SESSION_ERROR:
    case DEMO_CLOSE_CODES.RESTART:
    case DEMO_CLOSE_CODES.GOING_AWAY:
      kind = 'outage';
      break;
    case DEMO_CLOSE_CODES.NORMAL:
      kind = !opened ? 'connect' : 'ended';
      break;
    default:
      // 1005 / 1006 / 1015 and anything unknown: the browser never saw an application close frame.
      kind = !opened ? 'connect' : code >= 4000 && code < 5000 ? 'ended' : 'interrupted';
      break;
  }
  if (ctx.sawServiceError && !OWN_MEANING.has(code)) {
    kind = 'outage';
    override = { detail: DEMO_SERVICE_ERROR_DETAIL };
  }
  if (kind === 'connect' && ctx.configEnabled === false) {
    kind = 'outage';
    override = { retry: 'none', retryLabel: undefined, detail: DEMO_SWITCHED_OFF_DETAIL };
  }
  return { ...DEMO_OUTCOME_COPY[kind], ...override, kind, code, opened };
}

// ── Messages ────────────────────────────────────────────────────────────────────────────────────────

export const DEMO_MSG = {
  // client → server
  AVATAR_CONNECT: 'session.avatar.connect',
  SPEAK: 'demo.speak',
  FINISH: 'demo.finish',
  RESPONSE_CANCEL: 'response.cancel',
  QA_BEGIN: 'qa.begin',
  QA_AUDIO: 'qa.audio',
  QA_COMMIT: 'qa.commit',
  QA_CANCEL: 'qa.cancel',
  QA_RESUME: 'qa.resume',
  QA_ASK_TEXT: 'qa.ask_text',
  // server → client (Azure Voice Live events are forwarded untouched next to these)
  PROXY_CONNECTED: 'proxy.connected',
  STARTED: 'demo.started',
  SPEAKING: 'demo.speaking',
  NOTICE: 'demo.notice',
  CAPTION: 'demo.caption',
  NARRATION_COMPLETE: 'demo.narration_complete',
  QA_READY: 'qa.ready',
  QA_ACCEPTED: 'qa.accepted',
  QA_TRANSCRIPT: 'qa.transcript',
  QA_ANSWER: 'qa.answer',
  QA_ERROR: 'qa.error',
  QA_UNAVAILABLE: 'qa.unavailable',
  ERROR: 'error',
} as const;

/** Azure Voice Live events the demo relies on (forwarded raw; `response_id` / `item_id` are Azure's). */
export const DEMO_AZURE_EVENTS = {
  RESPONSE_CREATED: 'response.created',
  OUTPUT_ITEM_ADDED: 'response.output_item.added',
  TRANSCRIPT_DELTA: 'response.audio_transcript.delta',
  TRANSCRIPT_DONE: 'response.audio_transcript.done',
  TIMESTAMP_DELTA: 'response.audio_timestamp.delta',
  TIMESTAMP_DONE: 'response.audio_timestamp.done',
  RESPONSE_DONE: 'response.done',
  SESSION_UPDATED: 'session.updated',
  AVATAR_CONNECTING: 'session.avatar.connecting',
} as const;

/** `demo.caption.kind`: what the avatar is saying. `invite` = the fixed "Go ahead, I'm listening." line. */
export const DEMO_CAPTION_KINDS = ['narration', 'answer', 'invite'] as const;
export type DemoCaptionKind = (typeof DEMO_CAPTION_KINDS)[number];

// client → server
export interface DemoSpeakMessage { type: 'demo.speak'; slide: number; request_id?: string }
export interface DemoFinishMessage { type: 'demo.finish' }
export interface QaAskTextMessage { type: 'qa.ask_text'; request_id: string; slide: number; text: string }

// server → client
export interface DemoStartedMessage {
  type: 'demo.started';
  session_seconds: number;
  remaining_ms: number;
  narration_chars?: number[];
  /** v2: 2. Absent on a v1 server. */
  protocol?: number;
  slide_count?: number;
  idle_close_seconds?: number;
}
export interface DemoSpeakingMessage {
  type: 'demo.speaking';
  slide: number;
  chars: number;
  remaining: number;
  remaining_ms?: number;
  /** Echo of `demo.speak.request_id` when the client sent one. */
  request_id?: string;
}
export interface DemoNoticeMessage {
  type: 'demo.notice';
  code: 'rate_limited' | 'speak_limit' | 'empty_slide' | string;
  message: string;
  slide?: number;
  request_id?: string;
}
export interface DemoCaptionMessage {
  type: 'demo.caption';
  /** Slide index for `narration`; null for `answer` and `invite`. */
  slide: number | null;
  kind: DemoCaptionKind;
  /** Azure response id: groups the deltas and the final text of one spoken turn. */
  response_id: string;
  /** `final:false` → a delta to append (may start with a space). `final:true` → the complete text, replaces the deltas. */
  text: string;
  final: boolean;
}
export interface DemoNarrationCompleteMessage {
  type: 'demo.narration_complete';
  slides_spoken: number;
  slide_count: number;
  remaining_ms: number;
  /** Server's estimate of the time left before it closes with 4002 if the visitor does nothing. */
  idle_close_ms: number;
}
export interface QaAcceptedMessage {
  type: 'qa.accepted';
  request_id: string;
  remaining_questions: number;
  remaining_ms: number;
}
/** `qa.error` of the demo. `scope` accompanies `code:"limit"` (absent from a v1 server: treat as `session`). */
export interface DemoQaErrorMessage {
  type: 'qa.error';
  request_id?: string | null;
  code: string;
  message?: string;
  remaining_ms?: number;
  scope?: DemoQaLimitScope;
}
export interface DemoProxyErrorMessage { type: 'error'; error: { message: string } }

export type DemoClientMessage =
  | DemoSpeakMessage | DemoFinishMessage | QaAskTextMessage
  | { type: 'session.avatar.connect'; client_sdp: string }
  | { type: 'response.cancel' }
  | { type: 'qa.begin'; request_id: string; slide: number; mode: 'after_slide' }
  | { type: 'qa.audio'; request_id: string; seq: number; audio: string }
  | { type: 'qa.commit' | 'qa.cancel' | 'qa.resume'; request_id: string };

export type DemoServerMessage =
  | DemoStartedMessage | DemoSpeakingMessage | DemoNoticeMessage | DemoCaptionMessage | DemoNarrationCompleteMessage
  | QaReadyMessage | QaAcceptedMessage | QaTranscriptMessage | QaAnswerMessage | DemoQaErrorMessage | QaUnavailableMessage
  | DemoProxyErrorMessage | { type: 'proxy.connected'; message?: string };

// ── Same-deck recording (the value of every failure state) ──────────────────────────────────────────

/** Deep link of the Video library: `/video/library?video=<job_id>` opens that video (WU-E implements it). */
export const VIDEO_DEEP_LINK_PARAM = 'video';

/**
 * Route of a live-demo deck. The Home CTA links to exactly this path (no fragment, no query), and WU-D moves
 * focus to the start control on arrival (it never starts the session by itself).
 */
export function demoDeckPath(deckId: string): string {
  return `/decks/${encodeURIComponent(deckId)}/present`;
}

export interface RecordingDeck { deck_id: string; title: string; language?: string | null }

/** The public library fields `findRecording` reads (podcast and video list rows both fit). */
export interface RecordingCandidate {
  job_id: string;
  title: string;
  language?: string | null;
  created_at?: string | null;
  duration_sec?: number | null;
  audio_duration_sec?: number | null;
  /** Manifest link to the deck the item was rendered from; null/absent for every item today. */
  source_deck_id?: string | null;
  format?: 'video' | 'audio' | null;
  has_video?: boolean | null;
}

export interface Recording {
  kind: 'video' | 'podcast';
  id: string;
  /** Title as published (humanized for slug titles). */
  title: string;
  language: string;
  durationSec: number | null;
  /** False for an audio-only podcast: the action reads "Listen to…". */
  watchable: boolean;
  matchedBy: 'source_deck_id' | 'title';
  sameLanguage: boolean;
  /** "Watch {title} · {language name} · {duration}" ("Listen to …" when not watchable; parts without data are omitted). */
  label: string;
  /** In-app route that opens the item (see `recordingPath`). */
  to: string;
}

/** `/video/library?video=<id>` · `/podcast/library?episode=<id>&mode=watch|listen`. */
export function recordingPath(kind: 'video' | 'podcast', id: string, watchable = true): string {
  const q = encodeURIComponent(id);
  return kind === 'video'
    ? `/video/library?${VIDEO_DEEP_LINK_PARAM}=${q}`
    : `/podcast/library?episode=${q}&mode=${watchable ? 'watch' : 'listen'}`;
}

function podcastWatchable(item: RecordingCandidate): boolean {
  return typeof item.has_video === 'boolean' ? item.has_video : item.format !== 'audio';
}

function createdMs(item: RecordingCandidate): number {
  const t = typeof item.created_at === 'string' ? Date.parse(item.created_at) : Number.NaN;
  return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
}

interface Hit {
  item: RecordingCandidate;
  kind: 'video' | 'podcast';
  matchedBy: 'source_deck_id' | 'title';
  sameLanguage: boolean;
  watchable: boolean;
}

/**
 * The published recording of a live-demo deck, or null (the caller then shows DEMO_FALLBACK_LINKS).
 *
 *   1. Per medium (videos, podcasts): the items whose `source_deck_id` equals `deck.deck_id`; when the medium has
 *      none, the items whose `normalizeTitle(title)` equals `normalizeTitle(deck.title)`.
 *   2. All hits are ranked by: same primary language as the deck first, then a video before a podcast, then a
 *      watchable podcast before an audio-only one, then an id match before a title match, then the newest
 *      `created_at`, then `job_id` ascending. The first hit wins.
 * Inputs are the public (published-only) library lists.
 */
export function findRecording(
  deck: RecordingDeck,
  videos: readonly RecordingCandidate[],
  podcasts: readonly RecordingCandidate[],
): Recording | null {
  const deckKey = normalizeTitle(deck.title);
  const deckLanguage = primaryLanguage(deck.language);
  const collect = (items: readonly RecordingCandidate[], kind: Hit['kind']): Hit[] => {
    const rows = (items ?? []).filter((i) => i && typeof i.job_id === 'string' && i.job_id !== '');
    const byId = rows.filter((i) => !!i.source_deck_id && i.source_deck_id === deck.deck_id);
    const byTitle = byId.length === 0 && deckKey !== '' ? rows.filter((i) => normalizeTitle(i.title) === deckKey) : [];
    const pool = byId.length > 0 ? byId : byTitle;
    const matchedBy: Hit['matchedBy'] = byId.length > 0 ? 'source_deck_id' : 'title';
    return pool.map((item) => ({
      item,
      kind,
      matchedBy,
      sameLanguage: deckLanguage !== null && primaryLanguage(item.language) === deckLanguage,
      watchable: kind === 'video' || podcastWatchable(item),
    }));
  };
  const hits = [...collect(videos, 'video'), ...collect(podcasts, 'podcast')];
  if (hits.length === 0) return null;
  const rank = (h: Hit) => [
    h.sameLanguage ? 0 : 1,
    h.kind === 'video' ? 0 : 1,
    h.watchable ? 0 : 1,
    h.matchedBy === 'source_deck_id' ? 0 : 1,
  ];
  hits.sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    for (let i = 0; i < ra.length; i += 1) if (ra[i] !== rb[i]) return ra[i] - rb[i];
    return createdMs(b.item) - createdMs(a.item) || (a.item.job_id < b.item.job_id ? -1 : a.item.job_id > b.item.job_id ? 1 : 0);
  });
  const best = hits[0];
  const { item } = best;
  const durationSec = best.kind === 'podcast' && !best.watchable
    ? item.audio_duration_sec ?? item.duration_sec ?? null
    : item.duration_sec ?? null;
  const title = humanizeTitle(item.title);
  const language = typeof item.language === 'string' ? item.language : '';
  const parts = [`${best.watchable ? 'Watch' : 'Listen to'} ${title}`];
  if (language) parts.push(languageName(language));
  if (durationSec != null && Number.isFinite(durationSec) && durationSec > 0) parts.push(formatDuration(durationSec));
  return {
    kind: best.kind,
    id: item.job_id,
    title,
    language,
    durationSec,
    watchable: best.watchable,
    matchedBy: best.matchedBy,
    sameLanguage: best.sameLanguage,
    label: parts.join(' · '),
    to: recordingPath(best.kind, item.job_id, best.watchable),
  };
}
