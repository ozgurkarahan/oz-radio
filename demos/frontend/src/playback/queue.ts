/**
 * Continuity: which episode plays next — EXTENSION POINT (stub).
 *
 * `bu-continuity` replaces this file (order: same language → `audience_level` ascending when
 * present → oldest first; end of series → null). The exported names and signatures below
 * are the contract used by `PlaybackProvider` — keep them.
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
import type { LibrarySummary } from '../services/podcast';

export const LOCKSCREEN_TRACK_BUTTONS = false;

export interface NextEpisodeResolver {
  next(current: LibrarySummary, catalog: readonly LibrarySummary[]): LibrarySummary | null;
  previous(current: LibrarySummary, catalog: readonly LibrarySummary[]): LibrarySummary | null;
  /** Fraction of the current episode (0..1) from which the next one is kept ready. */
  prepareAt: number;
}

/** Stub: no continuity (every episode ends the session). */
export const nextEpisodeResolver: NextEpisodeResolver = {
  next: () => null,
  previous: () => null,
  prepareAt: 0.75,
};
