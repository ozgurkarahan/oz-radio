/**
 * Listening progress (resume points) and the preferred speed — EXTENSION POINT (stub).
 *
 * `bu-resume` replaces this file with a persistent implementation (localStorage
 * `oz-radio.progress.v1`, LRU 50, speed in `oz-radio.speed`; never SAS URLs; storage
 * failures are silent). The exported names and signatures below are the contract used by
 * `PlaybackProvider`, `RadioPlayer` and the library rows — keep them.
 *
 * How the engine calls it (PlaybackProvider, root player only):
 * - `save(jobId, position, duration)` on time updates (at most once per 5 s), pause, seeked,
 *   ratechange, pagehide, visibilitychange → hidden and freeze. `duration` may be 0 (unknown).
 * - `markDone(jobId)` when the episode's media fires `ended`.
 * - `get(jobId)` when an episode is loaded without an explicit start (`startEpisode` with
 *   `opts.start` undefined): a snapshot that is not `done` resumes at `position` (paused unless
 *   the caller asked for autoplay); `done` or null starts from 0.
 * - `positionAfterPause(jobId, position, pausedForMs)` right after playback resumes on the same
 *   episode: a different return value (e.g. 3 s earlier after a pause > 60 s) is seeked to.
 * - `getSpeed()` / `setSpeed(v)`: every RadioPlayer's initial speed is `getSpeed()` (else the
 *   speed chosen earlier in the page session, else 1×); a change in the player calls `setSpeed`.
 * - `subscribe(listener)`: notify after any change; `usePlaybackProgress` re-renders on it.
 *   `get(jobId)` must return the SAME object until that entry changes (it is a
 *   `useSyncExternalStore` snapshot), and null for unknown ids.
 */
import { useCallback, useSyncExternalStore } from 'react';

export interface ProgressSnapshot {
  /** Seconds on the radio timeline. */
  position: number;
  /** Seconds (0 = unknown). */
  duration: number;
  /** Listened to the end. */
  done: boolean;
  /** `Date.now()` of the last save. */
  updatedAt: number;
}

export interface ProgressStore {
  get(jobId: string): ProgressSnapshot | null;
  save(jobId: string, position: number, duration: number): void;
  markDone(jobId: string): void;
  /** Position to resume from after a pause of `pausedForMs` on the same episode. */
  positionAfterPause(jobId: string, position: number, pausedForMs: number): number;
  /** Preferred playback rate, or null when never chosen. */
  getSpeed(): number | null;
  setSpeed(rate: number): void;
  /** Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

/** Stub: remembers nothing (no-ops / null). */
export const progressStore: ProgressStore = {
  get: () => null,
  save: () => {},
  markDone: () => {},
  positionAfterPause: (_jobId, position) => position,
  getSpeed: () => null,
  setSpeed: () => {},
  subscribe: () => () => {},
};

/** Saved progress of an episode (null when none); re-renders whenever the store notifies. */
export function usePlaybackProgress(jobId: string | null | undefined): ProgressSnapshot | null {
  const getSnapshot = useCallback(() => (jobId ? progressStore.get(jobId) : null), [jobId]);
  return useSyncExternalStore(progressStore.subscribe, getSnapshot, getSnapshot);
}
