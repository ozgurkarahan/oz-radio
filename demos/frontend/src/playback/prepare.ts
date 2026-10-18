/**
 * Prepared episodes: playable library details fetched ahead of a tap (one-tap start).
 *
 * The library prefetches its first rows; the provider keeps the next episode ready. A tap on
 * a fresh prepared item starts it synchronously inside the gesture (no fetch). Entries live
 * `PREPARE_TTL_MS` (10 min), safely below the 15-minute anonymous SAS of the media URLs.
 *
 * API (module singletons, shared by the whole app):
 * - `prepare(ids, maxAgeMs = TTL)`: queues background fetches, at most `PREPARE_CONCURRENCY`
 *   (2) at a time. Ids fetched less than `maxAgeMs` ago, queued or in flight are skipped (a
 *   smaller `maxAgeMs` re-fetches older entries early). Errors are swallowed (no entry).
 * - `get(id)`: the fresh item (younger than the TTL), else null — never a stale one.
 * - `load(id)`: the in-flight request for `id`, else a new one (not throttled) — never a cached
 *   copy. The result is cached. Use it for user-initiated opens.
 * - `refresh(id)`: always a new request (cache bypass, e.g. an expired link); cached.
 * - `invalidate(id)`: forgets the cached item.
 */
import { getLibraryItem, type LibraryItem } from '../services/podcast';

export const PREPARE_TTL_MS = 10 * 60_000;
export const PREPARE_CONCURRENCY = 2;

interface Entry {
  item: LibraryItem;
  /** When the request that produced it started (≈ when its SAS URLs were minted). */
  fetchedAt: number;
}

interface Queued {
  id: string;
  maxAgeMs: number;
}

const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<LibraryItem>>();
const queue: Queued[] = [];
let active = 0;

/** Fetched less than `maxAgeMs` (capped by the TTL) ago. */
function isRecent(id: string, maxAgeMs: number, now = Date.now()): boolean {
  const entry = cache.get(id);
  return !!entry && now - entry.fetchedAt < Math.min(maxAgeMs, PREPARE_TTL_MS);
}

function request(id: string): Promise<LibraryItem> {
  const startedAt = Date.now();
  const pending: Promise<LibraryItem> = getLibraryItem(id).then(
    (item) => {
      if (inflight.get(id) === pending) inflight.delete(id);
      const known = cache.get(id);
      if (!known || known.fetchedAt <= startedAt) cache.set(id, { item, fetchedAt: startedAt });
      return item;
    },
    (error: unknown) => {
      if (inflight.get(id) === pending) inflight.delete(id);
      throw error;
    },
  );
  inflight.set(id, pending);
  return pending;
}

function pump(): void {
  while (active < PREPARE_CONCURRENCY && queue.length > 0) {
    const { id, maxAgeMs } = queue.shift()!;
    if (isRecent(id, maxAgeMs) || inflight.has(id)) continue;
    active += 1;
    request(id)
      .catch(() => { /* prefetch only: the open flow reports errors */ })
      .finally(() => {
        active -= 1;
        pump();
      });
  }
}

export function prepare(ids: readonly string[], maxAgeMs: number = PREPARE_TTL_MS): void {
  const now = Date.now();
  for (const id of ids) {
    if (!id || isRecent(id, maxAgeMs, now) || inflight.has(id)) continue;
    const queued = queue.find((q) => q.id === id);
    if (queued) queued.maxAgeMs = Math.min(queued.maxAgeMs, maxAgeMs);
    else queue.push({ id, maxAgeMs });
  }
  pump();
}

export function get(id: string): LibraryItem | null {
  return isRecent(id, PREPARE_TTL_MS) ? cache.get(id)!.item : null;
}

export function load(id: string): Promise<LibraryItem> {
  const queued = queue.findIndex((q) => q.id === id);
  if (queued >= 0) queue.splice(queued, 1);
  return inflight.get(id) ?? request(id);
}

export function refresh(id: string): Promise<LibraryItem> {
  return request(id);
}

export function invalidate(id: string): void {
  cache.delete(id);
}
