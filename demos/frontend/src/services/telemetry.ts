/**
 * Cookieless usage telemetry — the small part the app imports. Ships dark.
 *
 * Six events (oz_load, oz_vitals, oz_first_value, oz_demo, oz_media_error, oz_ui_error), allow-listed fields, nothing that
 * identifies a visitor: no cookies, no storage, one random page-load id kept in memory (see telemetryVitals.ts, the engine).
 *
 * Off unless ALL of these hold: the boot block says `telemetry.enabled` (the server flag TELEMETRY_ENABLED plus a valid
 * Application Insights connection string), the browser sends no Global Privacy Control and no Do Not Track, and the
 * visitor has not set the `site-analytics-opt-out` key. While off every function here does nothing, nothing is observed or
 * sent, and the engine is never downloaded. When on, calls made while the engine downloads wait in a short queue (at most 40).
 */
import { readBoot, type BootTelemetry } from './boot';
import type { DemoOutcomeValue, DemoStage, TelemetryEvent } from './telemetryVitals';

/** The opt-out key a visitor sets in this origin's localStorage (the same key as the portfolio's). */
export const OPT_OUT_KEY = 'site-analytics-opt-out';

/** Global Privacy Control or Do Not Track. Any doubt reads as "do not track". */
export function browserSignal(): boolean {
  try {
    const nav = navigator as Navigator & { globalPrivacyControl?: boolean; msDoNotTrack?: string };
    if (nav.globalPrivacyControl === true) return true;
    const dnt = nav.doNotTrack || (window as unknown as { doNotTrack?: string }).doNotTrack || nav.msDoNotTrack;
    return dnt === '1' || dnt === 'yes';
  } catch {
    return true;
  }
}

/** A browser signal or the opt-out key. Storage that cannot be read stays on the safe side: opted out. */
export function optedOut(): boolean {
  if (browserSignal()) return true;
  try {
    return window.localStorage.getItem(OPT_OUT_KEY) === '1';
  } catch {
    return true;
  }
}

type Api = Pick<
  typeof import('./telemetryVitals'),
  'track' | 'markHomeCta' | 'trackDemoStage' | 'trackDemoIce' | 'trackDemoQuestion' | 'trackDemoEnd' | 'reportUiError'
>;

let engine: Api | null = null;
/** Calls made while the engine downloads; null when telemetry is off (nothing is kept) or once the engine runs. */
let waiting: (() => void)[] | null = null;
const MAX_WAITING = 40;

function call<K extends keyof Api>(name: K, ...args: Parameters<Api[K]>): void {
  if (engine) {
    try {
      (engine[name] as (...rest: unknown[]) => void)(...args);
    } catch { /* telemetry never breaks the app */ }
  } else if (waiting && waiting.length < MAX_WAITING) {
    waiting.push(() => call(name, ...args));
  }
}

/** True once telemetry runs for this page load. */
export function isTelemetryActive(): boolean {
  return engine !== null;
}

/**
 * Switches telemetry on when the boot block enables it and the visitor has not opted out; otherwise does nothing at all
 * (no listener, no download). Call it once, as early as possible.
 */
export function initTelemetry(config: BootTelemetry | undefined = readBoot()?.telemetry): void {
  if (engine || waiting || !config || config.enabled !== true || !config.ingestion || !config.ikey) return;
  if (typeof window === 'undefined' || optedOut()) return;
  waiting = [];
  // Uncaught errors and rejections are heard from now on; the engine decides which of them may be reported.
  window.addEventListener('error', (event) => reportUiError(event.error, 'window', { file: event.filename, line: event.lineno }));
  window.addEventListener('unhandledrejection', (event) => reportUiError(event.reason, 'window'));
  import('./telemetryVitals')
    .then((module) => {
      module.start(config, optedOut);
      engine = module;
      const pending = waiting ?? [];
      waiting = null;
      for (const run of pending) run();
    })
    .catch(() => { waiting = null; }); // offline or blocked: telemetry stays off, the app is unaffected
}

/** Sends an event of the engine's allow-list (extra keys are dropped). */
export function track(name: TelemetryEvent, props: Record<string, unknown>): void {
  call('track', name, props);
}

/** Home's call to action is shown in its final form (not the skeleton). */
export function markHomeCta(entryKind: string): void {
  call('markHomeCta', entryKind, performance.now());
}

/** The visitor tapped Start (`tap` opens an attempt) and how far the attempt got; stages only move forward. */
export function trackDemoStage(stage: DemoStage): void {
  call('trackDemoStage', stage, performance.now());
}

/** ICE gathering of a live-demo attempt: the peer connection is set up (`start`), the offer goes out (`done`). */
export function trackDemoIce(phase: 'start' | 'done'): void {
  call('trackDemoIce', phase, performance.now());
}

/** The visitor sent a question to the live demo (the question itself is never read here). */
export function trackDemoQuestion(): void {
  call('trackDemoQuestion');
}

/** The live-demo attempt is over: with the outcome the visitor saw, or (Stop, leaving the page) without one. */
export function trackDemoEnd(end?: { code: number; telemetry: DemoOutcomeValue }): void {
  call('trackDemoEnd', end, performance.now());
}

/** A UI error: the error's name, its top frame in our own code and the route template are reported, never its message. */
export function reportUiError(error: unknown, source: 'boundary' | 'window' = 'boundary', where?: { file?: string; line?: number }): void {
  call('reportUiError', error, source, where);
}
