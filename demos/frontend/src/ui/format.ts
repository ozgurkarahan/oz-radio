// Presentation helpers shared by pages (no emoji — icons come from lucide-react).

const LANGUAGE_NAMES: Record<string, string> = {
  'en-US': 'English',
  'en-GB': 'English (UK)',
  'fr-FR': 'Français',
  'es-ES': 'Español',
  'de-DE': 'Deutsch',
  'it-IT': 'Italiano',
  'pt-BR': 'Português',
  'zh-CN': '中文',
  'ja-JP': '日本語',
};

/** "fr-FR" → "Français"; unknown codes are returned unchanged. */
export function languageName(code: string | null | undefined): string {
  if (!code) return '—';
  return LANGUAGE_NAMES[code] ?? code;
}

/** "fr-FR" → "FR". */
export function languageShort(code: string | null | undefined): string {
  if (!code) return '—';
  return (code.split('-')[0] || code).toUpperCase();
}

/**
 * Turns slug-like titles into readable ones: "ai-enablement" → "AI enablement".
 * Titles that already contain spaces or capitals are kept as-is.
 */
export function humanizeTitle(title: string | null | undefined): string {
  const t = (title ?? '').trim();
  if (!t) return 'Untitled';
  if (/\s/.test(t) || /[A-Z]/.test(t)) return t;
  const spaced = t.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  const words = spaced.split(' ').map((w) => (ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w));
  const out = words.join(' ');
  return out.charAt(0).toUpperCase() + out.slice(1);
}

const ACRONYMS = new Set(['ai', 'ia', 'ki', 'api', 'pdf', 'llm', 'slm', 'mcp', 'rag', 'tts', 'stt', 'ux', 'iot']);

/** 98 → "1:38"; 3725 → "1:02:05"; null → "—". */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function pluralize(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Two-digit episode number: 1 → "01". */
export function episodeNumber(i: number): string {
  return String(i).padStart(2, '0');
}

// ── Shared contract helpers (contracts v1, frozen — see fleet/contracts.md §5) ────────────────
// Pure functions only. The units of the UX-fix run all import these instead of re-implementing them.

/** Audience levels of the public DTOs (same values as `AudienceLevel` in services/podcast.ts). */
export type AudienceLevelValue = 'beginner' | 'practitioner' | 'expert';

const LEVEL_LABELS: Record<AudienceLevelValue, string> = {
  beginner: 'Beginner',
  practitioner: 'Practitioner',
  expert: 'Expert',
};

/** "beginner" → "Beginner"; null, undefined and unknown values → "" (callers then render nothing). */
export function levelLabel(level: unknown): string {
  return typeof level === 'string' && Object.prototype.hasOwnProperty.call(LEVEL_LABELS, level)
    ? LEVEL_LABELS[level as AudienceLevelValue]
    : '';
}

/** "fr-FR" → "fr", "pt_BR" → "pt"; null when `code` is not a language tag. */
export function primaryLanguage(code: unknown): string | null {
  if (typeof code !== 'string') return null;
  const primary = code.trim().split(/[-_]/)[0].toLowerCase();
  return /^[a-z]{2,3}$/.test(primary) ? primary : null;
}

/** True for any French locale ("fr", "fr-FR", "fr-CA"). */
export function isFrench(code: unknown): boolean {
  return primaryLanguage(code) === 'fr';
}

/**
 * Value for a `lang` attribute: "fr-FR" → "fr". `undefined` when the language is unknown, so React
 * omits the attribute and the element inherits the document language.
 */
export function langAttr(code: unknown): string | undefined {
  return primaryLanguage(code) ?? undefined;
}

const SINGLE_QUOTES = /[\u2018\u2019\u201A\u201B\u2032\u0060\u00B4]/g;
const DOUBLE_QUOTES = /[\u201C\u201D\u201E\u201F\u2033]/g;
const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF]/g;

/**
 * Comparison key of a title (the same-deck recording map, contracts §2.6): NFKC, zero-width characters
 * removed, typographic quotes unified to ' and ", whitespace (incl. NBSP) collapsed and trimmed, then
 * case-folded. "L’IA en trois  minutes" and "l'ia en trois minutes" give the same key. Never display it.
 */
export function normalizeTitle(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .replace(SINGLE_QUOTES, "'")
    .replace(DOUBLE_QUOTES, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase()
    .toLowerCase();
}

/** `detail` of every public 503 for a storage failure (lists, details, captions): see contracts §2.4. */
export const LIBRARY_UNAVAILABLE_DETAIL = 'Library temporarily unavailable';

/** Why a list / detail request failed, from the visitor's point of view. */
export type LoadFailureKind = 'unavailable' | 'offline' | 'not-found' | 'unknown';

const OFFLINE_RE = /failed to fetch|load failed|networkerror|network request failed|internet connection|net::err_|offline/i;
const NOT_FOUND_RE = /not found|no longer available|\bhttp 404\b/i;
const UNAVAILABLE_RE = /temporarily unavailable|storage (is )?(not )?available|storage unavailable|service unavailable|upstream|reset reason|bad gateway|gateway time-?out|\bhttp 50[234]\b|overloaded/i;

/**
 * Classifies the error thrown by `listLibrary()`, `listDecks()`, `getLibraryItem()`, `getDeck()`… The services throw
 * `Error(detail | raw body | "HTTP <status>")` for a non-2xx answer and the browser's own `TypeError` for a network
 * failure, so the text is all there is to read. A resolved empty array is *empty*, never a failure.
 */
export function classifyLoadError(err: unknown): LoadFailureKind {
  const text = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  if (OFFLINE_RE.test(text)) return 'offline';
  if (NOT_FOUND_RE.test(text)) return 'not-found';
  if (UNAVAILABLE_RE.test(text)) return 'unavailable';
  if (!text && typeof navigator !== 'undefined' && navigator.onLine === false) return 'offline';
  return 'unknown';
}

/**
 * Visitor-safe sentence for a failed load. Never echoes the error text (no "Failed to fetch", no proxy body).
 * `what` is the noun phrase being loaded: "the episodes", "the decks", "this video".
 */
export function loadErrorMessage(err: unknown, what = 'this page'): string {
  switch (classifyLoadError(err)) {
    case 'offline': return 'You seem to be offline. Check your connection and try again.';
    case 'not-found': return "This item isn't available any more.";
    case 'unavailable': return `We couldn't load ${what} right now. Please try again in a moment.`;
    default: return `Something went wrong while loading ${what}. Please try again.`;
  }
}
