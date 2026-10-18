/**
 * Continuity: which episode plays after (auto-next) or before the current one.
 *
 * Rules — pure functions of the current episode and the catalog the visitor sees:
 * 1. Same language only, never across: candidates share the current episode's language,
 *    compared on its primary subtag, case-insensitively ("en-US" = "en-GB" = "en", never
 *    "fr-FR"). An episode without a language has no neighbours and is never one.
 * 2. Listenable only: candidates need audio per their summary — `hasAudio`, the rule of the
 *    library's Listen button (`has_audio`; legacy rows without the field have audio). The
 *    public DTO reads `has_audio: false` when visitors get no audio, so they never chain into
 *    an episode they cannot play.
 * 3. Series order (total: every episode has exactly one place):
 *    a. `audience_level` ascending — beginner → practitioner → expert — when known (admin
 *       payloads; the public DTO has none), episodes without a level after the levelled ones;
 *    b. then `created_at` ascending, oldest first (missing / unparsable dates last);
 *    c. then the title (numeric-aware: "Part 2" before "Part 10"), then `job_id`.
 * 4. `next` = the candidate right after the current episode in that order, `previous` = the one
 *    right before; null at either end (end of the series: the player reads "Finished") and when
 *    the current episode is not in the catalog. The current episode is placed by its catalog
 *    row even when that row reports no audio (it is the one playing).
 *
 * The exported names and signatures are the contract used by `PlaybackProvider` — keep them.
 *
 * How the engine calls it:
 * - The provider loads the catalog once per session (`listLibrary()`, the rows the visitor may
 *   see, newest first) on the first episode start and calls `next(current, catalog)` /
 *   `previous(current, catalog)` with the loaded episode's summary. Both must be pure and
 *   cheap (called on every time update past `prepareAt`, on resume and on visibility changes)
 *   and return an entry of `catalog` or null.
 * - At ≥ `prepareAt` (0..1) of the current episode, on every resume and when the page becomes
 *   visible, the provider prefetches the next episode's playable details (prepare.ts, TTL 10 min).
 * - On `ended` it starts that prepared item synchronously inside the media event (`autoPlay`,
 *   from 0) — iOS keeps the unlocked <audio> playing with the screen locked. No fresh prepared
 *   item → the session is "finished".
 * - `LOCKSCREEN_TRACK_BUTTONS` (default OFF, decided by the iPhone device test): when true and a
 *   neighbour exists, the lock screen / earbuds get `nexttrack` / `previoustrack` (iOS then shows
 *   them instead of ±15 s).
 */
import {
  hasAudio, toAudienceLevel, type AudienceLevel, type LibrarySummary,
} from '../services/podcast';

export const LOCKSCREEN_TRACK_BUTTONS = false;

export interface NextEpisodeResolver {
  next(current: LibrarySummary, catalog: readonly LibrarySummary[]): LibrarySummary | null;
  previous(current: LibrarySummary, catalog: readonly LibrarySummary[]): LibrarySummary | null;
  /** Fraction of the current episode (0..1) from which the next one is kept ready. */
  prepareAt: number;
}

const LEVEL_RANK: Record<AudienceLevel, number> = { beginner: 0, practitioner: 1, expert: 2 };
/** Episodes without a known level come after every levelled one. */
const NO_LEVEL_RANK = 3;
const TITLE_ORDER = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** "en-US" → "en"; null when unknown. */
function languageKey(language: unknown): string | null {
  if (typeof language !== 'string') return null;
  return language.trim().split(/[-_]/)[0].toLowerCase() || null;
}

function levelRank(episode: LibrarySummary): number {
  const level = toAudienceLevel(episode.audience_level);
  return level ? LEVEL_RANK[level] : NO_LEVEL_RANK;
}

function createdAt(episode: LibrarySummary): number {
  const t = typeof episode.created_at === 'string' ? Date.parse(episode.created_at) : Number.NaN;
  return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
}

function compareValues(a: number | string, b: number | string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** < 0 when `a` plays before `b` in a series (rule 3). */
function compareEpisodes(a: LibrarySummary, b: LibrarySummary): number {
  return compareValues(levelRank(a), levelRank(b))
    || compareValues(createdAt(a), createdAt(b))
    || TITLE_ORDER.compare(String(a.title ?? ''), String(b.title ?? ''))
    || compareValues(String(a.job_id), String(b.job_id));
}

/** The closest same-language, listenable episode after (`step` 1) or before (-1) the current one. */
function neighbour(current: LibrarySummary, catalog: readonly LibrarySummary[], step: 1 | -1): LibrarySummary | null {
  const here = current ? catalog.find((s) => s?.job_id === current.job_id) : undefined;
  const language = here ? languageKey(here.language) : null;
  if (!here || !language) return null;
  let best: LibrarySummary | null = null;
  for (const candidate of catalog) {
    if (!candidate?.job_id || candidate.job_id === here.job_id) continue;
    if (!hasAudio(candidate) || languageKey(candidate.language) !== language) continue;
    if (compareEpisodes(candidate, here) * step <= 0) continue; // on the other side of the current one
    if (!best || compareEpisodes(candidate, best) * step < 0) best = candidate;
  }
  return best;
}

export const nextEpisodeResolver: NextEpisodeResolver = {
  next: (current, catalog) => neighbour(current, catalog, 1),
  previous: (current, catalog) => neighbour(current, catalog, -1),
  prepareAt: 0.75,
};
