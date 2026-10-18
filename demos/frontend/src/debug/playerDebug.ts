/**
 * Opt-in on-device playback log (`?debug=player`).
 *
 * For testing listening on a real phone (screen locked, earbuds) without a remote
 * inspector. Off by default with zero effect: until `installPlayerDebug()` runs (only
 * when the flag is on) nothing is patched, listened to or stored.
 *
 * When on, it records media element events, `play()` calls and their outcome, Media
 * Session actions and page lifecycle events in a ring buffer persisted to localStorage,
 * shown, copied and shared by `PlayerDebugPanel`. Media URLs are reduced to origin +
 * path: query strings (SAS tokens) are never logged.
 */

export const DEBUG_FLAG_KEY = 'oz-radio.debug';
export const DEBUG_LOG_KEY = 'oz-radio.debug.log';
const DEBUG_PARAM = 'debug';
const FLAG_ON = 'player';
const FLAG_OFF = 'off';
const MAX_ENTRIES = 500;
const WRITE_INTERVAL_MS = 1000;

const MEDIA_EVENTS = [
  'loadstart', 'loadedmetadata', 'canplay', 'play', 'playing', 'pause', 'waiting', 'stalled',
  'seeking', 'seeked', 'ratechange', 'ended', 'emptied', 'abort', 'error',
] as const;

export type DebugValue = string | number | boolean | null;
export type DebugDetail = Record<string, DebugValue>;
type DetailInput = Record<string, DebugValue | undefined>;

export interface PlayerDebugEntry {
  /** ISO 8601 time with milliseconds (UTC). */
  t: string;
  /** Milliseconds since the previous entry (0 for the first one). */
  dt: number;
  kind: string;
  detail: DebugDetail;
}

// ---- Flag ---------------------------------------------------------------------------

/** `?debug=player` turns the log on and persists it; `?debug=off` clears it. False on any storage error. */
export function isPlayerDebugEnabled(): boolean {
  try {
    const param = new URLSearchParams(window.location.search).get(DEBUG_PARAM);
    if (param === FLAG_ON) window.localStorage.setItem(DEBUG_FLAG_KEY, FLAG_ON);
    else if (param === FLAG_OFF) window.localStorage.removeItem(DEBUG_FLAG_KEY);
    return window.localStorage.getItem(DEBUG_FLAG_KEY) === FLAG_ON;
  } catch {
    return false;
  }
}

/** Clears the flag (effective from the next page load). The stored log is kept until cleared. */
export function disablePlayerDebug(): void {
  flush();
  try { window.localStorage.removeItem(DEBUG_FLAG_KEY); } catch { /* storage unavailable */ }
}

// ---- Ring buffer --------------------------------------------------------------------

let entries: readonly PlayerDebugEntry[] = [];
let loaded = false;
let dirty = false;
let lastAt: number | null = null;
let lastWriteAt = 0;
let writeTimer: number | undefined;
let notifyQueued = false;
const listeners = new Set<() => void>();

function isEntry(value: unknown): value is PlayerDebugEntry {
  const e = value as Partial<PlayerDebugEntry> | null;
  return !!e && typeof e === 'object' && typeof e.t === 'string' && typeof e.dt === 'number'
    && typeof e.kind === 'string' && !!e.detail && typeof e.detail === 'object';
}

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(DEBUG_LOG_KEY) ?? '[]');
    if (Array.isArray(parsed)) entries = parsed.filter(isEntry).slice(-MAX_ENTRIES);
  } catch {
    entries = [];
  }
  const at = entries.length ? Date.parse(entries[entries.length - 1].t) : NaN;
  lastAt = Number.isFinite(at) ? at : null;
}

function write(): void {
  window.clearTimeout(writeTimer);
  writeTimer = undefined;
  lastWriteAt = Date.now();
  dirty = false;
  try {
    if (entries.length) window.localStorage.setItem(DEBUG_LOG_KEY, JSON.stringify(entries));
    else window.localStorage.removeItem(DEBUG_LOG_KEY);
  } catch { /* quota or private mode: the log stays in memory */ }
}

/** At most one write per second: right away when idle, else once that second is over. */
function scheduleWrite(): void {
  if (writeTimer !== undefined) return;
  const wait = lastWriteAt + WRITE_INTERVAL_MS - Date.now();
  if (wait <= 0) write();
  else writeTimer = window.setTimeout(write, wait);
}

/** Forced write when the page is hidden or left: it may never run again. */
function flush(): void {
  if (loaded && dirty) write();
}

function notify(): void {
  if (notifyQueued) return;
  notifyQueued = true;
  queueMicrotask(() => {
    notifyQueued = false;
    listeners.forEach((listener) => {
      try { listener(); } catch { /* one listener must not stop the others */ }
    });
  });
}

/** Any `?key=value…` run in free text (error messages): SAS tokens live there. */
const QUERY_IN_TEXT = /\?[^\s"'<>]*=[^\s"'<>]*/g;

function sanitize(detail: DetailInput): DebugDetail {
  const out: DebugDetail = {};
  for (const [key, value] of Object.entries(detail)) {
    if (value === undefined) continue;
    if (typeof value === 'string') out[key] = value.replace(QUERY_IN_TEXT, '');
    else if (typeof value === 'number' && !Number.isFinite(value)) out[key] = String(value);
    else out[key] = value;
  }
  return out;
}

function record(kind: string, detail: DetailInput = {}): void {
  try {
    load();
    const now = Date.now();
    const entry: PlayerDebugEntry = {
      t: new Date(now).toISOString(),
      dt: lastAt === null ? 0 : now - lastAt,
      kind,
      detail: sanitize(detail),
    };
    lastAt = now;
    entries = [...entries.slice(-(MAX_ENTRIES - 1)), entry];
    dirty = true;
    scheduleWrite();
    notify();
  } catch { /* the log must never break playback */ }
}

/** Records an entry whose detail is built defensively (reading media state can throw). */
function note(kind: string, build: () => DetailInput = () => ({})): void {
  try { record(kind, build()); } catch { /* the log must never break playback */ }
}

/** Entries, oldest first. A new array after each change (useSyncExternalStore snapshot). */
export function getEntries(): readonly PlayerDebugEntry[] {
  load();
  return entries;
}

export function clearEntries(): void {
  load();
  entries = [];
  lastAt = null;
  dirty = true;
  write();
  notify();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Plain-text export: a header line, then one JSON entry per line, oldest first. */
export function exportLog(list: readonly PlayerDebugEntry[] = getEntries()): string {
  const count = `${list.length} ${list.length === 1 ? 'entry' : 'entries'}`;
  const header = `Oz Radio player debug log · ${count} · exported ${new Date().toISOString()}`;
  return [header, ...list.map((entry) => JSON.stringify(entry))].join('\n');
}

// ---- What gets logged -----------------------------------------------------------------

/** Origin + path only: never the query string (SAS token) nor the fragment. */
function safeUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw, window.location.href);
    if (url.protocol === 'http:' || url.protocol === 'https:') return `${url.origin}${url.pathname}`;
    if (url.protocol === 'blob:') return `blob:${url.pathname}`;
    return url.protocol; // data:, mediastream:… never their payload
  } catch {
    return '(invalid URL)';
  }
}

/** Full URL → 1-based id, in memory only: tells a re-signed URL from a reload of the same one. */
const sourceIds = new Map<string, number>();

function sourceOf(el: HTMLMediaElement): DetailInput {
  const raw = el.currentSrc || el.getAttribute('src');
  if (!raw) return { src: null };
  let full = raw;
  try { full = new URL(raw, window.location.href).href; } catch { /* keep raw */ }
  let id = sourceIds.get(full);
  if (id === undefined) {
    id = sourceIds.size + 1;
    sourceIds.set(full, id);
  }
  return { src: safeUrl(full), srcId: id };
}

const seconds = (value: number): DebugValue => (Number.isFinite(value) ? Math.round(value * 1000) / 1000 : String(value));

function elementOf(el: HTMLMediaElement): DetailInput {
  return {
    el: el.tagName.toLowerCase(),
    testid: el.getAttribute('data-testid') ?? (el.id || null),
    detached: el.isConnected ? undefined : true,
  };
}

function mediaState(el: HTMLMediaElement): DetailInput {
  return {
    ...elementOf(el),
    currentTime: seconds(el.currentTime),
    duration: seconds(el.duration),
    readyState: el.readyState,
    networkState: el.networkState,
    paused: el.paused,
    playbackRate: el.playbackRate,
    ...sourceOf(el),
    errorCode: el.error ? el.error.code : undefined,
    errorMessage: el.error?.message || undefined,
  };
}

function errorOf(error: unknown): DetailInput {
  const e = error as { name?: unknown; message?: unknown } | null;
  return {
    error: typeof e?.name === 'string' ? e.name : String(error),
    message: typeof e?.message === 'string' && e.message ? e.message : undefined,
  };
}

/** "radio-audio playing @12.345s; library-player paused @0s" for lifecycle entries. */
function mediaSummary(): string | undefined {
  const parts = Array.from(document.querySelectorAll<HTMLMediaElement>('audio, video'), (el) => (
    `${el.getAttribute('data-testid') ?? el.tagName.toLowerCase()} ${el.paused ? 'paused' : 'playing'} @${seconds(el.currentTime)}s`
  ));
  return parts.length ? parts.join('; ') : undefined;
}

function sessionInfo(): DetailInput {
  const nav = navigator as Navigator & { standalone?: boolean };
  let standalone = nav.standalone === true;
  try { standalone ||= window.matchMedia('(display-mode: standalone)').matches; } catch { /* old engine */ }
  return {
    userAgent: navigator.userAgent,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    devicePixelRatio: window.devicePixelRatio,
    standalone,
    path: window.location.pathname,
    visibilityState: document.visibilityState,
    mediaSession: 'mediaSession' in navigator,
    userActivationApi: 'userActivation' in navigator,
  };
}

// ---- Hooks ----------------------------------------------------------------------------

/** Elements with their own listeners (registerMediaElement): the document listener skips them. */
const registered = new WeakSet<HTMLMediaElement>();

// Media events do not bubble, but capture-phase listeners on `document` still see them.
function onDocumentMediaEvent(event: Event): void {
  const el = event.target;
  if (el instanceof HTMLMediaElement && !registered.has(el)) note(event.type, () => mediaState(el));
}

function onElementMediaEvent(event: Event): void {
  const el = event.currentTarget;
  if (el instanceof HTMLMediaElement) note(event.type, () => mediaState(el));
}

/** Logs every play() call (with the user activation) and its outcome; callers get the same promise. */
function wrapPlay(): void {
  const proto = HTMLMediaElement.prototype;
  const nativePlay = proto.play;
  proto.play = function play(this: HTMLMediaElement): Promise<void> {
    note('play()', () => {
      const activation = navigator.userActivation as UserActivation | undefined;
      return {
        ...mediaState(this),
        userActivation: activation ? activation.isActive : null,
        hasBeenActive: activation ? activation.hasBeenActive : null,
      };
    });
    let result: Promise<void>;
    try {
      result = nativePlay.call(this);
    } catch (error) {
      note('play() threw', () => ({ ...elementOf(this), ...errorOf(error) }));
      throw error;
    }
    const pending = result as Promise<void> | undefined; // undefined from pre-promise engines
    if (pending && typeof pending.then === 'function') {
      pending.then(
        () => note('play() resolved', () => ({ ...elementOf(this), currentTime: seconds(this.currentTime) })),
        (error: unknown) => note('play() rejected', () => ({ ...elementOf(this), ...errorOf(error) })),
      );
    }
    return result;
  };
}

/** Logs each Media Session action (lock screen, earbuds) before running the app's handler. */
function wrapMediaSession(): void {
  if (!('mediaSession' in navigator)) return;
  const session = navigator.mediaSession;
  const original = session.setActionHandler;
  if (typeof original !== 'function') return;
  session.setActionHandler = function setActionHandler(
    this: MediaSession, action: MediaSessionAction, handler: MediaSessionActionHandler | null,
  ): void {
    // Clearing (null) and invalid values reach the browser untouched.
    if (typeof handler !== 'function') { original.call(this, action, handler); return; }
    original.call(this, action, function loggedHandler(this: unknown, details: MediaSessionActionDetails) {
      note('mediasession', () => ({
        action: details?.action ?? action,
        seekOffset: details?.seekOffset,
        seekTime: details?.seekTime,
        fastSeek: details?.fastSeek,
      }));
      return handler.call(this, details);
    });
  };
}

function watchPage(): void {
  document.addEventListener('visibilitychange', () => {
    note('visibilitychange', () => ({ visibilityState: document.visibilityState, media: mediaSummary() }));
    if (document.visibilityState === 'hidden') flush();
  });
  window.addEventListener('pagehide', (event) => {
    note('pagehide', () => ({ persisted: event.persisted, media: mediaSummary() }));
    flush();
  });
  window.addEventListener('pageshow', (event) => note('pageshow', () => ({ persisted: event.persisted, media: mediaSummary() })));
  document.addEventListener('freeze', () => {
    note('freeze', () => ({ media: mediaSummary() }));
    flush();
  });
  document.addEventListener('resume', () => note('resume', () => ({ media: mediaSummary() })));
  for (const type of ['online', 'offline'] as const) window.addEventListener(type, () => note(type));
  for (const type of ['focus', 'blur'] as const) {
    window.addEventListener(type, (event) => { if (event.target === window) note(type); });
  }
  window.addEventListener('error', (event) => note('js-error', () => ({
    message: event.message, source: safeUrl(event.filename), line: event.lineno, column: event.colno,
  })));
  window.addEventListener('unhandledrejection', (event) => note('unhandled-rejection', () => errorOf(event.reason)));
}

let installed = false;

/** Installs the hooks once, and only when the flag is on. */
export function installPlayerDebug(): void {
  if (installed || !isPlayerDebugEnabled()) return;
  installed = true;
  load();
  note('session', sessionInfo);
  for (const type of MEDIA_EVENTS) document.addEventListener(type, onDocumentMediaEvent, true);
  wrapPlay();
  wrapMediaSession();
  watchPage();
  if (import.meta.env.DEV) {
    // Dev-server hook for the UI tests; compiled out of production builds.
    (window as unknown as Record<string, unknown>).__ozRadioPlayerDebug = { getEntries, registerMediaElement };
  }
}

/**
 * Logs a media element that may never be in the DOM (e.g. a persistent `new Audio()`),
 * exactly once per event whether attached or not. Idempotent; a no-op when the log is off.
 */
export function registerMediaElement(el: HTMLMediaElement): void {
  if (registered.has(el)) return;
  installPlayerDebug();
  if (!installed) return;
  registered.add(el);
  for (const type of MEDIA_EVENTS) el.addEventListener(type, onElementMediaEvent);
}
