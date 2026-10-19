/**
 * Boot block — the first-paint data the server inlines into index.html (contracts v1 §3).
 *
 * FROZEN shared contract file (owner WU-F0, UX-fix run). Types, constants and pure helpers only: no UI.
 * Do not edit: ask the coordinator, who records the change in fleet/contracts.md.
 *
 *   server (WU-G)  replaces the `<!--OZ_BOOT-->` marker of index.html (WU-A adds it) with
 *                  `<script type="application/json" id="oz-boot">{…}</script>`
 *   client         `readBoot()` parses it once. WU-C (Home, nav, gates) and WU-D (live demo) consume it.
 *
 * Consumer rule (what makes C1.3 "0 CTA changes after first paint" true):
 *   • `readBoot()` returned a block   → render the final CTAs on the first paint and never change their
 *                                       label or target afterwards. Quota changes appear only as adjacent
 *                                       status text ("17 live sessions left today").
 *   • `readBoot()` returned null      → render a same-size skeleton, call `fetchBootFallback()` (bounded by
 *                                       BOOT_FETCH_TIMEOUT_MS), then render ONCE and freeze. A null result
 *                                       there means "demo unavailable": render that final state, not a retry loop.
 *
 * The Python side (constants, escaping, cache rules) is services/demo_protocol.py — keep both in sync.
 */
import { primaryLanguage } from '../ui/format';

/** Schema version of the JSON block (`v`). A block with another version is treated as absent. */
export const BOOT_VERSION = 1;
/** id of the `<script type="application/json">` element. */
export const BOOT_ELEMENT_ID = 'oz-boot';
/** Placeholder in index.html that the server replaces. Must survive `vite build`. */
export const BOOT_MARKER = '<!--OZ_BOOT-->';
/** Bound for the fallback fetches when there is no boot block. */
export const BOOT_FETCH_TIMEOUT_MS = 2500;
/** At most this many live-demo decks are carried (extra ones are dropped, order kept). */
export const BOOT_MAX_LIVE_DECKS = 20;

export interface BootDemo {
  enabled: boolean;
  /** Effective session cap (seconds). */
  session_seconds: number;
  qa: { enabled: boolean; max_questions: number };
  /** Live sessions left today (global budget); null = unknown or demo disabled. */
  remaining_today: number | null;
}

export interface BootLiveDeck {
  deck_id: string;
  /** BCP-47, e.g. "fr-FR". */
  language: string;
  title: string;
}

/** The JSON exactly as the server writes it. `ok:false` = the server could not read fresh data (fail closed). */
export interface BootPayload {
  v: 1;
  ok: boolean;
  demo: BootDemo;
  live_demo_decks: BootLiveDeck[];
  telemetry: { enabled: boolean };
}

/** What `readBoot()` returns: a payload with `ok: true`. */
export type BootBlock = BootPayload & { ok: true };

/** The fail-closed block a server sends when it has no fresh data (demo off, no decks). */
export const BOOT_FAIL_CLOSED: BootPayload = {
  v: 1,
  ok: false,
  demo: { enabled: false, session_seconds: 180, qa: { enabled: false, max_questions: 0 }, remaining_today: null },
  live_demo_decks: [],
  telemetry: { enabled: false },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function wholeNumber(value: unknown, min: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.floor(value)) : null;
}

function normalizeDeck(value: unknown): BootLiveDeck | null {
  if (!isRecord(value)) return null;
  const { deck_id: id, language, title } = value;
  if (typeof id !== 'string' || id.length === 0 || id.length > 100 || /[\s<>"'&]/.test(id)) return null;
  return {
    deck_id: id,
    language: typeof language === 'string' && language ? language : 'en-US',
    title: typeof title === 'string' ? title : '',
  };
}

/**
 * Validates an untrusted object defensively. Returns null for anything that is not a usable, fresh block:
 * wrong version, `ok` not true, or a malformed `demo` section. Bad deck entries are dropped, not fatal.
 */
export function normalizeBoot(raw: unknown): BootBlock | null {
  if (!isRecord(raw) || raw.v !== BOOT_VERSION || raw.ok !== true) return null;
  const demo = raw.demo;
  if (!isRecord(demo) || typeof demo.enabled !== 'boolean') return null;
  const seconds = wholeNumber(demo.session_seconds, 1);
  const qa = demo.qa;
  if (seconds === null || !isRecord(qa) || typeof qa.enabled !== 'boolean') return null;
  const decks = (Array.isArray(raw.live_demo_decks) ? raw.live_demo_decks : [])
    .map(normalizeDeck)
    .filter((d): d is BootLiveDeck => d !== null)
    .slice(0, BOOT_MAX_LIVE_DECKS);
  const telemetry = isRecord(raw.telemetry) && raw.telemetry.enabled === true;
  return {
    v: 1,
    ok: true,
    demo: {
      enabled: demo.enabled,
      session_seconds: seconds,
      qa: { enabled: qa.enabled, max_questions: wholeNumber(qa.max_questions, 0) ?? 0 },
      remaining_today: wholeNumber(demo.remaining_today, 0),
    },
    live_demo_decks: decks,
    telemetry: { enabled: telemetry },
  };
}

/** Parses the text content of the `#oz-boot` element. Null when empty, not JSON or not a usable block. */
export function parseBoot(text: string | null | undefined): BootBlock | null {
  if (!text || !text.trim()) return null;
  try {
    return normalizeBoot(JSON.parse(text));
  } catch {
    return null;
  }
}

let cached: BootBlock | null | undefined;

/** The page's boot block, parsed once per page load; null when absent, invalid or `ok:false`. */
export function readBoot(): BootBlock | null {
  if (cached !== undefined) return cached;
  cached = typeof document === 'undefined' ? null : parseBoot(document.getElementById(BOOT_ELEMENT_ID)?.textContent);
  return cached;
}

/** Test hook: forget the memoized block so the next `readBoot()` parses the DOM again. */
export function resetBootCache(): void {
  cached = undefined;
}

function browserLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return [];
  if (navigator.languages && navigator.languages.length > 0) return navigator.languages;
  return navigator.language ? [navigator.language] : [];
}

/**
 * The live-demo deck to open for this visitor: a French deck when any of the browser's languages is
 * French (fr*), else the English deck, else the first deck. Null when there is no live-demo deck.
 * Pure: pass `navigator.languages` (default) or a test list.
 */
export function pickDemoDeck(
  boot: { live_demo_decks: readonly BootLiveDeck[] } | null | undefined,
  languages: readonly string[] | null | undefined = browserLanguages(),
): BootLiveDeck | null {
  const decks = boot?.live_demo_decks ?? [];
  if (decks.length === 0) return null;
  const inLanguage = (lang: string) => decks.find((d) => primaryLanguage(d.language) === lang);
  // The visitor's first preference that has a deck decides (["en-US", "fr-FR"] → English).
  for (const l of languages ?? []) {
    const primary = primaryLanguage(l);
    const match = primary ? inLanguage(primary) : undefined;
    if (match) return match;
  }
  return inLanguage('en') ?? decks[0];
}

export interface BootFallbackOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

async function getJson(fetchImpl: typeof fetch, url: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetchImpl(url, { credentials: 'same-origin', signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/**
 * No boot block: ask the API once, bounded by `timeoutMs` (default BOOT_FETCH_TIMEOUT_MS), and build the block
 * the server would have sent. Null = could not tell (timeout, failure) → the caller renders "demo unavailable" and
 * freezes. `/api/decks` is only needed when the demo is enabled.
 */
export async function fetchBootFallback(options: BootFallbackOptions = {}): Promise<BootBlock | null> {
  const fetchImpl = options.fetchImpl ?? (typeof fetch === 'function' ? fetch.bind(globalThis) : undefined);
  if (!fetchImpl) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? BOOT_FETCH_TIMEOUT_MS);
  try {
    const [config, decks] = await Promise.allSettled([
      getJson(fetchImpl, '/api/demo/config', controller.signal),
      getJson(fetchImpl, '/api/decks', controller.signal),
    ]);
    if (config.status !== 'fulfilled' || !isRecord(config.value)) return null;
    const cfg = config.value;
    const enabled = cfg.enabled === true;
    if (enabled && decks.status !== 'fulfilled') return null;
    const list = decks.status === 'fulfilled' ? decks.value : [];
    const rows = Array.isArray(list) ? list : isRecord(list) && Array.isArray(list.items) ? list.items : [];
    const qa = isRecord(cfg.qa) ? cfg.qa : {};
    return normalizeBoot({
      v: BOOT_VERSION,
      ok: true,
      demo: {
        enabled,
        session_seconds: typeof cfg.session_seconds === 'number' ? cfg.session_seconds : 180,
        qa: { enabled: qa.enabled === true, max_questions: qa.max_questions },
        remaining_today: typeof cfg.remaining_today === 'number' ? cfg.remaining_today : null,
      },
      live_demo_decks: enabled
        ? rows
          .filter((d) => isRecord(d) && d.live_demo === true && d.published !== false)
          .map((d) => ({ deck_id: (d as Record<string, unknown>).deck_id, language: (d as Record<string, unknown>).language, title: (d as Record<string, unknown>).title }))
        : [],
      telemetry: { enabled: false },
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
