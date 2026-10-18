/**
 * Listening progress (resume points) and the preferred speed, persisted in localStorage.
 *
 * The owner listens on a phone with the screen locked (episodes of 2–4 min): after a call, a
 * reload or a day, he picks up exactly where he stopped. The exported names and signatures
 * below are the contract used by `PlaybackProvider`, `RadioPlayer` and the library rows — keep them.
 *
 * Storage — numbers and booleans keyed by job id, never a media URL (SAS tokens stay in memory):
 * - `oz-radio.progress.v1`: `{ "v": 1, "episodes": { "<jobId>": { "position": number,
 *   "duration": number, "done": boolean, "updatedAt": number } } }` (seconds; `updatedAt` = epoch ms).
 * - `oz-radio.speed`: the preferred playback rate as a string number (`"1.5"`).
 *
 * Semantics:
 * - `save(jobId, position, duration)` writes through synchronously (the engine throttles, and a
 *   `pagehide` checkpoint must land before the page goes away). Non-finite values are ignored;
 *   a `duration` of 0 (unknown) keeps the duration known before; the position is clamped to
 *   [0, duration]. From `duration - 1` on, the episode counts as listened to the end (exactly
 *   like `markDone`); before that it is a bookmark (`done: false`), kept until `ended` (no
 *   "last seconds" rule). A finished episode stays done while the position is under 1 s: the
 *   engine checkpoints a freshly loaded episode (e.g. on `ratechange`) before anything is heard.
 * - `markDone(jobId)`: `done: true`, `position: 0`, the known duration is kept.
 * - `get(jobId)`: the saved snapshot (frozen) or null; the SAME object until that entry changes.
 * - `positionAfterPause(jobId, position, pausedForMs)`: 3 s earlier (never below 0) after a pause
 *   longer than 60 s, else `position` unchanged.
 * - `getSpeed()`: the stored rate when finite and within [0.5, 3], else null. `setSpeed(rate)`
 *   stores a rate within that range (anything else is ignored).
 * - At most 50 episodes are kept: the oldest `updatedAt` is dropped first.
 * - `subscribe(listener)`: called after every change in this tab, and when another tab changes
 *   the stored progress or speed (`storage` event; per episode, the newer save wins).
 * - Storage never breaks playback and nothing here throws: corrupted JSON, a wrong shape and a
 *   missing or disabled localStorage (private mode, SecurityError) read as empty; a failed write
 *   (quota) keeps the change in memory for the page session. Safe without `window` (SSR).
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

const PROGRESS_KEY = 'oz-radio.progress.v1';
const SPEED_KEY = 'oz-radio.speed';
const VERSION = 1;
const MAX_EPISODES = 50;
/** Seconds: the end margin that counts as finished, and the start margin that keeps it finished. */
const MARGIN_SEC = 1;
const REWIND_AFTER_MS = 60_000;
const REWIND_SEC = 3;
const MIN_SPEED = 0.5;
const MAX_SPEED = 3;
const MAX_ID_LENGTH = 200;
/** Job ids are opaque tokens: anything with URL syntax is refused, so no URL is ever persisted. */
const UNSAFE_ID = /[\s/?#&=%]/;

/** Episodes by job id, least recently saved first. */
type Entries = Map<string, ProgressSnapshot>;

let entries: Entries = new Map();
let speed: number | null = null;
let loaded = false;
const listeners = new Set<() => void>();

// ---- Storage access (never throws) ------------------------------------------------------

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    return null; // SecurityError: storage disabled for this origin
  }
}

function readItem(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeItem(key: string, value: string): void {
  try {
    storage()?.setItem(key, value);
  } catch { /* quota or private mode: the change lives in memory for this page session */ }
}

// ---- Validation -----------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNonNegative = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

const isValidId = (jobId: unknown): jobId is string =>
  typeof jobId === 'string' && jobId.length > 0 && jobId.length <= MAX_ID_LENGTH && !UNSAFE_ID.test(jobId);

const isValidSpeed = (rate: unknown): rate is number =>
  typeof rate === 'number' && Number.isFinite(rate) && rate >= MIN_SPEED && rate <= MAX_SPEED;

/** Millisecond precision keeps the stored JSON short. */
const round = (seconds: number) => Math.round(seconds * 1000) / 1000;

function snapshot(position: number, duration: number, done: boolean, updatedAt: number): ProgressSnapshot {
  return Object.freeze({ position: round(position), duration: round(duration), done, updatedAt });
}

const sameSnapshot = (a: ProgressSnapshot, b: ProgressSnapshot) =>
  a.position === b.position && a.duration === b.duration && a.done === b.done && a.updatedAt === b.updatedAt;

/** The valid stored episodes (the newest 50), oldest save first; anything malformed reads as empty. */
function readEntries(): Entries {
  const out: Entries = new Map();
  const raw = readItem(PROGRESS_KEY);
  if (!raw) return out;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!isRecord(data) || data.v !== VERSION || !isRecord(data.episodes)) return out;
  const valid: [string, ProgressSnapshot][] = [];
  for (const [jobId, entry] of Object.entries(data.episodes)) {
    if (!isValidId(jobId) || !isRecord(entry)) continue;
    const { position, duration, done, updatedAt } = entry;
    if (!isNonNegative(position) || !isNonNegative(duration) || typeof done !== 'boolean' || !isNonNegative(updatedAt)) continue;
    const at = done ? 0 : duration > 0 ? Math.min(position, duration) : position;
    valid.push([jobId, snapshot(at, duration, done, updatedAt)]);
  }
  valid.sort((a, b) => a[1].updatedAt - b[1].updatedAt);
  for (const [jobId, saved] of valid.slice(-MAX_EPISODES)) out.set(jobId, saved);
  return out;
}

function readSpeed(): number | null {
  const raw = readItem(SPEED_KEY);
  if (raw === null || raw.trim() === '') return null;
  const rate = Number(raw);
  return isValidSpeed(rate) ? rate : null;
}

// ---- State --------------------------------------------------------------------------------

function notify(): void {
  for (const listener of Array.from(listeners)) {
    try { listener(); } catch { /* one listener must not break the others, nor the caller */ }
  }
}

/** Another tab wrote the progress: adopt it (per episode the newer save wins); unchanged entries keep their identity. */
function adoptStored(): boolean {
  const stored = readEntries();
  const next: Entries = new Map();
  let changed = stored.size !== entries.size;
  for (const [jobId, theirs] of stored) {
    const mine = entries.get(jobId);
    const kept = mine && (mine.updatedAt > theirs.updatedAt || sameSnapshot(mine, theirs)) ? mine : theirs;
    if (kept !== mine) changed = true;
    next.set(jobId, kept);
  }
  entries = next;
  return changed;
}

function onStorage(event: StorageEvent): void {
  try {
    if (event.storageArea && event.storageArea !== storage()) return; // sessionStorage
    let changed = false;
    if (event.key === null || event.key === SPEED_KEY) {
      const rate = readSpeed();
      changed = rate !== speed;
      speed = rate;
    }
    if (event.key === null || event.key === PROGRESS_KEY) changed = adoptStored() || changed;
    if (changed) notify();
  } catch { /* never throws */ }
}

/** Reads storage once, on first use (not at import), and follows other tabs from then on. */
function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  entries = readEntries();
  speed = readSpeed();
  try {
    if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);
  } catch { /* no cross-tab updates */ }
}

/** Stores `next` as the most recent save of `jobId`, drops the oldest beyond 50, writes through, notifies. */
function commit(jobId: string, next: ProgressSnapshot): void {
  entries.delete(jobId);
  entries.set(jobId, next);
  if (entries.size > MAX_EPISODES) {
    // Stable sort: on equal times the earlier save goes first. The episode just saved always stays.
    const oldest = Array.from(entries).filter(([id]) => id !== jobId).sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    for (const [id] of oldest.slice(0, entries.size - MAX_EPISODES)) entries.delete(id);
  }
  const episodes = Object.fromEntries(Array.from(entries, ([id, s]) => [
    id, { position: s.position, duration: s.duration, done: s.done, updatedAt: s.updatedAt },
  ]));
  writeItem(PROGRESS_KEY, JSON.stringify({ v: VERSION, episodes }));
  notify();
}

export const progressStore: ProgressStore = {
  get(jobId) {
    ensureLoaded();
    return entries.get(jobId) ?? null;
  },

  save(jobId, position, duration) {
    try {
      if (!isValidId(jobId) || !Number.isFinite(position) || !Number.isFinite(duration)) return;
      ensureLoaded();
      const prev = entries.get(jobId);
      const known = duration > 0 ? duration : prev?.duration ?? 0;
      const at = Math.max(0, known > 0 ? Math.min(position, known) : position);
      if (known > 0 && at >= known - MARGIN_SEC) commit(jobId, snapshot(0, known, true, Date.now()));
      else if (!(prev?.done && at < MARGIN_SEC)) commit(jobId, snapshot(at, known, false, Date.now()));
    } catch { /* never throws */ }
  },

  markDone(jobId) {
    try {
      if (!isValidId(jobId)) return;
      ensureLoaded();
      commit(jobId, snapshot(0, entries.get(jobId)?.duration ?? 0, true, Date.now()));
    } catch { /* never throws */ }
  },

  positionAfterPause(_jobId, position, pausedForMs) {
    if (!Number.isFinite(position) || !(pausedForMs > REWIND_AFTER_MS)) return position;
    return Math.max(0, position - REWIND_SEC);
  },

  getSpeed() {
    ensureLoaded();
    return speed;
  },

  setSpeed(rate) {
    try {
      if (!isValidSpeed(rate)) return;
      ensureLoaded();
      writeItem(SPEED_KEY, String(rate));
      if (rate === speed) return;
      speed = rate;
      notify();
    } catch { /* never throws */ }
  },

  subscribe(listener) {
    ensureLoaded();
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
};

// Dev server only: a re-evaluated module must not leave this one listening.
import.meta.hot?.dispose(() => {
  if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
});

/** Saved progress of an episode (null when none); re-renders whenever the store notifies. */
export function usePlaybackProgress(jobId: string | null | undefined): ProgressSnapshot | null {
  const getSnapshot = useCallback(() => (jobId ? progressStore.get(jobId) : null), [jobId]);
  return useSyncExternalStore(progressStore.subscribe, getSnapshot, getSnapshot);
}
