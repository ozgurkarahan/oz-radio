/**
 * The engine of the cookieless usage telemetry: six events, allow-listed fields, nothing that identifies a visitor.
 *
 * telemetry.ts is the small facade the app imports. THIS file is a separate chunk, downloaded only after telemetry was
 * switched on for the page load — never for a visitor it is off for, nor for one who signals Global Privacy Control or Do
 * Not Track or has set the opt-out key. Same pattern as the portfolio's telemetry.js: no SDK, no cookies, nothing in
 * localStorage or sessionStorage, one random page-load id kept in memory, `navigator.sendBeacon` to the Application
 * Insights ingestion endpoint (`/v2/track`), failures ignored.
 *
 *   oz_load · oz_vitals · oz_first_value · oz_demo · oz_media_error · oz_ui_error   (TELEMETRY_FIELDS below)
 *
 * What can leave the browser is decided in one place, `sanitizeProps`: only the fields of TELEMETRY_FIELDS, each coerced to
 * its shape (numbers rounded, vocabularies and route templates matched exactly, a domain name, a file:line). Anything else
 * is dropped, so a caller cannot send free text, a question, deck content, an error message, a URL or an identifier. The
 * observers below read timings and states of the page only: none reads text, URLs, titles or form values.
 *
 * Importable in Node (tests): nothing here touches the DOM until `start` runs. No dependency: PerformanceObserver is the
 * whole story for the vitals.
 */
import type { BootTelemetry } from './boot';

export type TelemetryEvent = 'oz_load' | 'oz_vitals' | 'oz_first_value' | 'oz_demo' | 'oz_media_error' | 'oz_ui_error';

export const DEMO_STAGES = ['tap', 'ws_open', 'rtc_connected', 'first_word', 'complete'] as const;
export const DEMO_OUTCOMES = ['cap', 'stop', 'error', 'busy', 'limit', 'blocked', 'network'] as const;
export const FIRST_VALUE_KINDS = ['audio', 'video', 'avatar'] as const;
export const MEDIA_KINDS = ['audio', 'video'] as const;
export type DemoStage = (typeof DEMO_STAGES)[number];
export type DemoOutcomeValue = (typeof DEMO_OUTCOMES)[number];
export type FirstValueKind = (typeof FIRST_VALUE_KINDS)[number];

export const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'] as const;
/** Appended to the ingestion origin from the boot block. */
export const INGESTION_PATH = '/v2/track';

// ── The allow-list ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Routes by template: a path that matches none is `other`, never the raw path (it could carry anything). */
const ROUTE_TEMPLATES: readonly (readonly [RegExp, string])[] = [
  [/^\/$/, '/'],
  [/^\/live$/, '/live'],
  [/^\/decks$/, '/decks'],
  [/^\/decks\/[^/]+\/present$/, '/decks/:id/present'],
  [/^\/search$/, '/search'],
  [/^\/playlists$/, '/playlists'],
  [/^\/playlists\/[^/]+$/, '/playlists/:id'],
  [/^\/podcast$/, '/podcast'],
  [/^\/podcast\/library$/, '/podcast/library'],
  [/^\/video$/, '/video'],
  [/^\/video\/library$/, '/video/library'],
  [/^\/sign-in$/, '/sign-in'],
];
export const OTHER_ROUTE = 'other';
export const TELEMETRY_ROUTES: readonly string[] = [...ROUTE_TEMPLATES.map(([, template]) => template), OTHER_ROUTE];

/** `/decks/abc/present` → `/decks/:id/present`. */
export function routeTemplate(pathname: string): string {
  const path = pathname === '/index.html' ? '/' : pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return ROUTE_TEMPLATES.find(([pattern]) => pattern.test(path))?.[1] ?? OTHER_ROUTE;
}

type Shape =
  | 'ms' | 'seconds' | 'count' | 'cls' | 'bool' | 'code' | 'route' | 'domain' | 'campaign' | 'errorName' | 'frame'
  | readonly string[];

/**
 * Every field an event may carry, with its shape. Nothing else is ever sent.
 *   ms        milliseconds, rounded to 10 ms          seconds   whole seconds        count   a small whole number
 *   cls       layout-shift score, 0.01 steps          bool      "true" / "false"     code    a WebSocket close code or a media error code
 *   route     a route template (TELEMETRY_ROUTES)     domain    a host name, no scheme, path or port
 *   campaign  a UTM value: letters, digits and . _ ~ + - space, at most 100 characters
 *   errorName an identifier such as TypeError         frame     `file.js:123`, a same-origin file name and a line
 */
export const TELEMETRY_FIELDS: Readonly<Record<TelemetryEvent, Readonly<Record<string, Shape>>>> = {
  oz_load: {
    route: 'route', referrer: 'domain',
    utm_source: 'campaign', utm_medium: 'campaign', utm_campaign: 'campaign', utm_content: 'campaign', utm_term: 'campaign',
    ttfb_ms: 'ms', first_cta_ms: 'ms', cta_changed: 'bool', server_cold: 'bool',
  },
  oz_vitals: { lcp_ms: 'ms', cls: 'cls', inp_ms: 'ms', fcp_ms: 'ms', ttfb_ms: 'ms' },
  oz_first_value: { kind: FIRST_VALUE_KINDS, ms_from_nav: 'ms', ms_from_tap: 'ms', taps_since_load: 'count' },
  oz_demo: {
    stage_reached: DEMO_STAGES, close_code: 'code', outcome: DEMO_OUTCOMES, ice_gather_ms: 'ms', ms_to_first_word: 'ms',
    questions: 'count', idle_tail_s: 'seconds',
  },
  oz_media_error: { kind: MEDIA_KINDS, media_error_code: 'code', recovered: 'bool', route: 'route' },
  oz_ui_error: { error_name: 'errorName', frame: 'frame', route: 'route' },
};

const MAX_MS = 3_600_000;
const MAX_COUNT = 99;
const CAMPAIGN_RE = /^[A-Za-z0-9._~+ -]{1,100}$/;
const DOMAIN_RE = /^(?=.{4,100}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const ERROR_NAME_RE = /^[A-Za-z][A-Za-z0-9_$]{0,39}$/;
const FRAME_RE = /^[A-Za-z0-9._-]{1,80}:\d{1,7}$/;

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

function cleanValue(shape: Shape, value: unknown): string | null {
  if (typeof shape !== 'string') return typeof value === 'string' && shape.includes(value) ? value : null;
  switch (shape) {
    case 'ms': return finite(value) && value <= MAX_MS ? String(Math.round(value / 10) * 10) : null;
    case 'seconds': return finite(value) && value <= MAX_MS / 1000 ? String(Math.round(value)) : null;
    case 'count': return finite(value) ? String(Math.min(MAX_COUNT, Math.round(value))) : null;
    case 'cls': return finite(value) && value <= 100 ? String(Math.round(value * 100) / 100) : null;
    case 'bool': return typeof value === 'boolean' ? String(value) : null;
    case 'code': return finite(value) && Number.isInteger(value) && value <= 4999 ? String(value) : null;
    case 'route': return typeof value === 'string' && TELEMETRY_ROUTES.includes(value) ? value : null;
    case 'domain': return typeof value === 'string' && DOMAIN_RE.test(value) ? value : null;
    case 'campaign': return typeof value === 'string' && CAMPAIGN_RE.test(value) ? value : null;
    case 'errorName': return typeof value === 'string' && ERROR_NAME_RE.test(value) ? value : null;
    case 'frame': return typeof value === 'string' && FRAME_RE.test(value) ? value : null;
    default: return null;
  }
}

/** The properties that may be sent for `name`: allow-listed keys only, each as a clean string. Pure. */
export function sanitizeProps(name: TelemetryEvent, props: Record<string, unknown>): Record<string, string> {
  const fields = TELEMETRY_FIELDS[name];
  const clean: Record<string, string> = {};
  if (!fields) return clean;
  for (const key of Object.keys(fields)) {
    if (!Object.prototype.hasOwnProperty.call(props, key)) continue;
    const value = cleanValue(fields[key], props[key]);
    if (value !== null) clean[key] = value;
  }
  return clean;
}

// ── Context of this page load ─────────────────────────────────────────────────────────────────────────────────────────

/** The route template of the page right now. */
export function currentRoute(): string {
  return typeof location === 'undefined' ? OTHER_ROUTE : routeTemplate(location.pathname);
}

/** The referring site as a bare domain; same-site, IP and single-label hosts read as no referrer. */
function referrerDomain(): string | undefined {
  try {
    if (!document.referrer) return undefined;
    const host = new URL(document.referrer).hostname.toLowerCase();
    return host !== location.hostname && DOMAIN_RE.test(host) ? host : undefined;
  } catch {
    return undefined;
  }
}

/** The UTM allow-list of the address: only these five names, and only plain values (see `campaign`). */
function campaign(): Record<string, string> {
  const values: Record<string, string> = {};
  try {
    const params = new URLSearchParams(location.search);
    for (const key of UTM_KEYS) {
      const value = params.get(key);
      if (value !== null) values[key] = value.replace(/\s+/g, ' ').trim();
    }
  } catch { /* no address, no campaign */ }
  return values;
}

/** Milliseconds from the start of the navigation to the first byte of the page. */
function navigationTtfb(): number | undefined {
  try {
    const entry = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    return entry && entry.responseStart > 0 ? entry.responseStart : undefined;
  } catch {
    return undefined;
  }
}

/** One random id that links the events of this page load. In memory only: never stored, never reused. */
function newPageLoadId(): string {
  try {
    return Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return (Math.random().toString(16) + '00000000').slice(2, 10) + Date.now().toString(16).padStart(8, '0').slice(-8);
  }
}

// ── Sending ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A page load can only ever send this many events of a kind, and this many in all. */
const EVENT_CAP: Readonly<Record<TelemetryEvent, number>> = {
  oz_load: 1, oz_vitals: 1, oz_first_value: 1, oz_demo: 5, oz_media_error: 3, oz_ui_error: 5,
};
const TOTAL_CAP = 20;
const SDK_VERSION = 'oz-beacon:1';
/** Labels the events in a workspace shared with other sites. A constant, not a visitor's. */
const CLOUD_ROLE = 'oz-radio';
/** Home waits this long for its call to action before `oz_load` goes out without `first_cta_ms`. */
const HOME_CTA_WAIT_MS = 6000;

let started = false;
let endpoint = '';
let ikey = '';
let pageLoadId = '';
let total = 0;
/** The visitor's say, handed in by the facade at `start`; until then (and in Node) everything reads as opted out. */
let isOptedOut: () => boolean = () => true;
const sent: Partial<Record<TelemetryEvent, number>> = {};

function beacon(body: string): void {
  try {
    // A string body is sent as text/plain, so the browser needs no CORS preflight.
    if (navigator.sendBeacon && navigator.sendBeacon(endpoint, body)) return;
  } catch { /* fall back to fetch */ }
  try {
    void fetch(endpoint, {
      method: 'POST',
      body,
      keepalive: true,
      mode: 'no-cors',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
    }).catch(() => { /* ignored */ });
  } catch { /* ignored */ }
}

/**
 * Sends one event. A no-op until `start`; checks the visitor's say again on every send (an opt-out made in another tab
 * applies at once), keeps only allow-listed fields, caps the volume, and never throws.
 */
export function track(name: TelemetryEvent, props: Record<string, unknown>): void {
  if (!started) return;
  try {
    if (total >= TOTAL_CAP || (sent[name] ?? 0) >= EVENT_CAP[name] || isOptedOut()) return;
    const properties = sanitizeProps(name, props);
    if (Object.keys(properties).length === 0) return;
    total += 1;
    sent[name] = (sent[name] ?? 0) + 1;
    beacon(JSON.stringify([{
      name: `Microsoft.ApplicationInsights.${ikey.replace(/-/g, '')}.Event`,
      time: new Date().toISOString(),
      iKey: ikey,
      tags: {
        'ai.operation.id': pageLoadId,
        'ai.operation.name': currentRoute(),
        'ai.cloud.role': CLOUD_ROLE,
        'ai.internal.sdkVersion': SDK_VERSION,
      },
      data: { baseType: 'EventData', baseData: { ver: 2, name, properties } },
    }]));
  } catch { /* telemetry never breaks the app */ }
}

// ── Page hide: the moment pending events are flushed ──────────────────────────────────────────────────────────────────

const hiddenHandlers: (() => void)[] = [];
const unloadHandlers: (() => void)[] = [];

/** `fn` runs when the page is hidden or unloaded (it must be safe to run more than once). */
function onPageHidden(fn: () => void): void {
  hiddenHandlers.push(fn);
}

function runAll(handlers: readonly (() => void)[]): void {
  for (const fn of handlers) {
    try { fn(); } catch { /* ignored */ }
  }
}

function listenForPageHide(): void {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') runAll(hiddenHandlers);
  });
  // Only an unload ends a live demo; a hidden tab does not.
  window.addEventListener('pagehide', () => { runAll(hiddenHandlers); runAll(unloadHandlers); });
}

// ── oz_load ───────────────────────────────────────────────────────────────────────────────────────────────────────────

interface LoadContext {
  route: string;
  referrer?: string;
  campaign: Record<string, string>;
  ttfb?: number;
  serverCold: boolean;
}

let loadContext: LoadContext | null = null;
let loadSent = false;
let loadTimer: ReturnType<typeof setTimeout> | null = null;
let firstCtaMs: number | undefined;

function sendLoad(): void {
  if (loadSent || !loadContext) return;
  loadSent = true;
  if (loadTimer) clearTimeout(loadTimer);
  const ctx = loadContext;
  track('oz_load', {
    route: ctx.route,
    referrer: ctx.referrer,
    ...ctx.campaign,
    ttfb_ms: ctx.ttfb,
    // The calls to action are frozen after the first paint (contracts §3.6), so Home reports `false`.
    ...(ctx.route === '/' ? { first_cta_ms: firstCtaMs, cta_changed: false } : {}),
    server_cold: ctx.serverCold,
  });
}

/** Home's call to action is shown in its final form (not the skeleton), `at` ms after the navigation started. Once. */
export function markHomeCta(entryKind: string, at: number): void {
  if (!started || firstCtaMs !== undefined || entryKind === 'pending') return;
  firstCtaMs = at;
  if (loadContext?.route === '/') sendLoad();
}

// ── oz_first_value ────────────────────────────────────────────────────────────────────────────────────────────────────

let taps = 0;
let lastTapAt: number | undefined;
let firstValueSent = false;

function noteTap(event: Event): void {
  if (!event.isTrusted) return;
  taps += 1;
  lastTapAt = performance.now();
}

/** The first value the visitor got from this page load: audible audio, a video playing, or the avatar's first word. Once. */
function reportFirstValue(kind: FirstValueKind, at: number): void {
  if (firstValueSent) return;
  firstValueSent = true;
  track('oz_first_value', {
    kind,
    ms_from_nav: at,
    ms_from_tap: lastTapAt === undefined ? undefined : Math.max(0, at - lastTapAt),
    taps_since_load: taps,
  });
}

// ── oz_demo: one event per live-demo attempt ──────────────────────────────────────────────────────────────────────────

interface DemoAttempt {
  tapAt: number;
  stage: DemoStage;
  iceStartAt?: number;
  iceMs?: number;
  firstWordAt?: number;
  completeAt?: number;
  questions: number;
}

let attempt: DemoAttempt | null = null;

/** The visitor tapped Start (`tap`, a new attempt) and the stages after it: only ever forward. */
export function trackDemoStage(stage: DemoStage, at: number): void {
  if (!started) return;
  if (stage === 'tap') {
    trackDemoEnd(undefined, at); // an attempt still open here ended without an outcome of its own: the visitor started again
    attempt = { tapAt: at, stage: 'tap', questions: 0 };
    return;
  }
  if (!attempt || DEMO_STAGES.indexOf(stage) <= DEMO_STAGES.indexOf(attempt.stage)) return;
  attempt.stage = stage;
  if (stage === 'first_word') {
    attempt.firstWordAt = at;
    reportFirstValue('avatar', at);
  } else if (stage === 'complete') {
    attempt.completeAt = at;
  }
}

/** ICE gathering of the attempt: `start` when the peer connection is set up, `done` when the offer goes out. */
export function trackDemoIce(phase: 'start' | 'done', at: number): void {
  if (!started || !attempt) return;
  if (phase === 'start') attempt.iceStartAt ??= at;
  else if (attempt.iceStartAt !== undefined) attempt.iceMs ??= at - attempt.iceStartAt;
}

/** The visitor sent a question (typed or by voice). */
export function trackDemoQuestion(): void {
  if (attempt) attempt.questions += 1;
}

/** The attempt is over. `end` is the outcome the visitor saw; without it (Stop, leaving the page) the outcome is `stop`. */
export function trackDemoEnd(end: { code: number; telemetry: DemoOutcomeValue } | undefined, at: number): void {
  const done = attempt;
  attempt = null;
  if (!started || !done) return;
  track('oz_demo', {
    stage_reached: done.stage,
    close_code: end?.code,
    outcome: end?.telemetry ?? 'stop',
    ice_gather_ms: done.iceMs,
    ms_to_first_word: done.firstWordAt === undefined ? undefined : done.firstWordAt - done.tapAt,
    questions: done.questions,
    idle_tail_s: done.completeAt === undefined ? undefined : (at - done.completeAt) / 1000,
  });
}

// ── oz_ui_error ───────────────────────────────────────────────────────────────────────────────────────────────────────

const STACK_LINE_RE = /(https?:\/\/[^\s()'"]+?):(\d+):\d+\)?$/;
/** Where the app's own scripts live: the built chunks (`/assets/`) and, on the dev server, its modules and pre-bundled deps. */
const OWN_SCRIPT_PATH_RE = /^\/(?:assets|src|node_modules\/\.vite\/deps)\/(?:[^/]+\/)*([A-Za-z0-9._-]{1,80}\.(?:m?js|jsx|tsx?))$/;
const reportedErrors = new Set<string>();

/**
 * `https://site/assets/index-ab12.js` → `index-ab12.js`: a script file of the app itself, by origin AND path. Null for any
 * other origin (extensions, third parties), any other path, and the page itself: an inline script — the shell's, or one an
 * extension injects — reports the page's URL, whose path can carry an id (`/playlists/<id>`). Pure (exported for tests).
 */
export function ownScriptFile(url: string, origin: string, pagePath: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== origin || parsed.pathname === pagePath) return null;
    return OWN_SCRIPT_PATH_RE.exec(parsed.pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}

function sameOriginFile(url: string): string | null {
  return typeof location === 'undefined' ? null : ownScriptFile(url, location.origin, location.pathname);
}

/** The first same-origin frame of a stack as `file:line`: the file and the line, never the function, column or address. */
function topFrame(stack: unknown, file?: string, line?: number): string | undefined {
  if (typeof stack === 'string') {
    for (const text of stack.split('\n').slice(0, 15)) {
      const match = STACK_LINE_RE.exec(text.trim());
      const name = match ? sameOriginFile(match[1]) : null;
      if (match && name) return `${name}:${match[2]}`;
    }
  }
  const name = file ? sameOriginFile(file) : null;
  return name && typeof line === 'number' && Number.isInteger(line) && line > 0 ? `${name}:${line}` : undefined;
}

function errorName(error: unknown): string {
  const name = typeof error === 'object' && error !== null ? (error as { name?: unknown }).name : undefined;
  if (typeof name === 'string' && ERROR_NAME_RE.test(name)) return name;
  return error instanceof Error ? 'Error' : 'NonError';
}

/**
 * A UI error: only its NAME, the top frame of our own code (`file:line`) and the route template are sent, never the message,
 * the stack or the data involved. `boundary` errors (a render crash caught by an ErrorBoundary) are always reported;
 * `window` errors (uncaught exceptions, unhandled rejections) only when they come from this site's own files.
 */
export function reportUiError(error: unknown, source: 'boundary' | 'window', where?: { file?: string; line?: number }): void {
  if (!started) return;
  try {
    const frame = topFrame((error as { stack?: unknown } | null)?.stack, where?.file, where?.line);
    if (source === 'window' && !frame) return;
    const name = errorName(error);
    const key = `${name}|${frame ?? '-'}`;
    if (reportedErrors.has(key)) return;
    reportedErrors.add(key);
    track('oz_ui_error', { error_name: name, frame, route: currentRoute() });
  } catch { /* ignored */ }
}

// ── oz_vitals ─────────────────────────────────────────────────────────────────────────────────────────────────────────

interface LayoutShiftEntry extends PerformanceEntry { value: number; hadRecentInput: boolean }
interface InteractionEntry extends PerformanceEntry { interactionId?: number }

type Drain = () => void;

/** Observes one entry type (entries from before this point included). Returns a function that flushes the pending records. */
function observe(type: string, onEntries: (entries: PerformanceEntry[]) => void, init: Record<string, unknown> = {}): Drain | null {
  try {
    const observer = new PerformanceObserver((list) => onEntries(list.getEntries()));
    observer.observe({ type, buffered: true, ...init } as PerformanceObserverInit);
    return () => onEntries(observer.takeRecords());
  } catch {
    return null; // the browser does not offer this entry type: the field is left out
  }
}

/** LCP, CLS, INP and FCP, reported once when the page is first hidden or unloaded. A metric the browser lacks is omitted. */
function observeVitals(): void {
  let fcp: number | undefined;
  let lcp: number | undefined;
  let cls: number | undefined;
  const slowest = new Map<number, number>(); // interactionId → its longest duration (only the slow ones are kept)
  let shifts: LayoutShiftEntry[] = [];
  let windowValue = 0;

  const drains = [
    observe('paint', (entries) => {
      for (const entry of entries) if (entry.name === 'first-contentful-paint') fcp = entry.startTime;
    }),
    observe('largest-contentful-paint', (entries) => {
      const last = entries[entries.length - 1];
      if (last) lcp = last.startTime;
    }),
    // Cumulative layout shift as the largest "session window" (shifts less than 1 s apart, a window at most 5 s long).
    observe('layout-shift', (entries) => {
      for (const entry of entries as LayoutShiftEntry[]) {
        if (entry.hadRecentInput) continue;
        const first = shifts[0];
        const last = shifts[shifts.length - 1];
        if (last && entry.startTime - last.startTime < 1000 && entry.startTime - first.startTime < 5000) {
          windowValue += entry.value;
          shifts.push(entry);
        } else {
          windowValue = entry.value;
          shifts = [entry];
        }
        if (windowValue > (cls ?? 0)) cls = windowValue;
      }
    }),
    // Interaction to next paint, approximated from Event Timing: the slowest interaction, skipping one per 50 interactions.
    observe('event', (entries) => {
      for (const entry of entries as InteractionEntry[]) {
        if (!entry.interactionId) continue;
        if (entry.duration > (slowest.get(entry.interactionId) ?? 0)) slowest.set(entry.interactionId, entry.duration);
      }
      if (slowest.size > 40) {
        const smallest = [...slowest.entries()].sort((a, b) => a[1] - b[1])[0];
        slowest.delete(smallest[0]);
      }
    }, { durationThreshold: 40 }),
  ];

  const inp = (): number | undefined => {
    if (slowest.size === 0) return undefined;
    const durations = [...slowest.values()].sort((a, b) => b - a);
    const count = (performance as { interactionCount?: number }).interactionCount ?? slowest.size;
    return durations[Math.min(durations.length - 1, Math.floor(count / 50))];
  };

  // A browser that measures layout shifts and saw none has a CLS of 0 (the observer never calls back without entries).
  if (drains[2]) cls = 0;

  let reported = false;
  onPageHidden(() => {
    if (reported) return;
    reported = true;
    for (const drain of drains) drain?.();
    track('oz_vitals', { lcp_ms: lcp, cls, inp_ms: inp(), fcp_ms: fcp, ttfb_ms: navigationTtfb() });
  });
}

// ── oz_first_value (audio, video) and oz_media_error ──────────────────────────────────────────────────────────────────

/** A wait this long, while the element should be playing, is a stall. */
const STALL_MS = 8000;
/** An error or stall that has not recovered this long after it began is reported as not recovered. */
const RECOVERY_MS = 10000;
/** media_error_code of a stall (a real MediaError code is 1–4). */
const STALL_CODE = 0;
const MEDIA_ERR_ABORTED = 1;
const HAVE_FUTURE_DATA = 3;

interface Incident {
  code: number;
  timer: ReturnType<typeof setTimeout>;
}

const mediaOf = (event: Event): HTMLMediaElement | null =>
  event.target instanceof HTMLMediaElement ? event.target : null;

const isAudible = (el: HTMLMediaElement): boolean => !el.muted && el.volume > 0;

/** Media events do not bubble, but a capturing listener on the document hears every audio and video element. */
function observeMedia(): void {
  const incidents = new Map<HTMLMediaElement, Incident>();
  const stalls = new Map<HTMLMediaElement, ReturnType<typeof setTimeout>>();

  const finish = (el: HTMLMediaElement, recovered: boolean): void => {
    const incident = incidents.get(el);
    if (!incident) return;
    incidents.delete(el);
    clearTimeout(incident.timer);
    track('oz_media_error', {
      kind: el instanceof HTMLVideoElement ? 'video' : 'audio',
      media_error_code: incident.code,
      recovered,
      route: currentRoute(),
    });
  };

  const begin = (el: HTMLMediaElement, code: number): void => {
    if (incidents.has(el) || el.srcObject) return; // the avatar's stream is the demo's business
    incidents.set(el, { code, timer: setTimeout(() => finish(el, false), RECOVERY_MS) });
  };

  const clearStall = (el: HTMLMediaElement): void => {
    const timer = stalls.get(el);
    if (timer === undefined) return;
    clearTimeout(timer);
    stalls.delete(el);
  };

  const onPlaying = (event: Event): void => {
    const el = mediaOf(event);
    if (!el) return;
    clearStall(el);
    finish(el, true);
    // The avatar's stream (a MediaStream, not a file) reports its own first word through the demo.
    if (!el.srcObject && (el instanceof HTMLVideoElement || isAudible(el))) {
      reportFirstValue(el instanceof HTMLVideoElement ? 'video' : 'audio', performance.now());
    }
  };

  const onWaiting = (event: Event): void => {
    const el = mediaOf(event);
    if (!el || el.paused || stalls.has(el)) return;
    stalls.set(el, setTimeout(() => {
      stalls.delete(el);
      if (!el.paused && !el.ended && el.readyState < HAVE_FUTURE_DATA) begin(el, STALL_CODE);
    }, STALL_MS));
  };

  const onError = (event: Event): void => {
    const el = mediaOf(event);
    const code = el?.error?.code;
    if (!el || !code || code === MEDIA_ERR_ABORTED) return; // an aborted load was superseded, not a failure
    clearStall(el);
    begin(el, code);
  };

  // An audio element that was muted when it started and is unmuted while it plays has now delivered its first sound.
  const onVolumeChange = (event: Event): void => {
    const el = mediaOf(event);
    if (el && !el.srcObject && !el.paused && !(el instanceof HTMLVideoElement) && isAudible(el)) reportFirstValue('audio', performance.now());
  };

  const onStop = (event: Event): void => {
    const el = mediaOf(event);
    if (el) clearStall(el);
  };

  const options = { capture: true, passive: true } as const;
  document.addEventListener('playing', onPlaying, options);
  document.addEventListener('waiting', onWaiting, options);
  document.addEventListener('error', onError, options);
  document.addEventListener('volumechange', onVolumeChange, options);
  for (const type of ['pause', 'ended', 'emptied', 'abort', 'loadstart']) document.addEventListener(type, onStop, options);

  // Leaving or hiding the page: report what is still open, as recovered only if it plays right now.
  onPageHidden(() => {
    for (const el of [...incidents.keys()]) finish(el, !el.error && !el.paused && el.readyState >= HAVE_FUTURE_DATA);
  });
}

// ── Start ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Switches telemetry on for this page load (the facade has already checked the boot block and the visitor's say, and hands
 * the latter in as `optedOut`, which is asked again before every send). Once.
 */
export function start(config: BootTelemetry, optedOut: () => boolean): void {
  if (started || !config.ingestion || !config.ikey) return;
  started = true;
  isOptedOut = optedOut;
  endpoint = `${config.ingestion}${INGESTION_PATH}`;
  ikey = config.ikey.toLowerCase();
  pageLoadId = newPageLoadId();
  loadContext = {
    route: currentRoute(),
    referrer: referrerDomain(),
    campaign: campaign(),
    ttfb: navigationTtfb(),
    serverCold: config.server_cold === true,
  };

  document.addEventListener('click', noteTap, { capture: true, passive: true });
  listenForPageHide();
  onPageHidden(sendLoad);
  unloadHandlers.push(() => trackDemoEnd(undefined, performance.now()));
  observeVitals();
  observeMedia();

  // Home waits for its call to action (`first_cta_ms`); every other page reports at once.
  if (loadContext.route === '/' && firstCtaMs === undefined) loadTimer = setTimeout(sendLoad, HOME_CTA_WAIT_MS);
  else sendLoad();
}
