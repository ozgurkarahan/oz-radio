/**
 * Shared types of the app-wide podcast playback session (src/playback).
 *
 * One `PlaybackProvider` (main.tsx, inside the router) owns ONE root `RadioPlayer` for the
 * whole visit: the episode dialog of /podcast/library shows it through a `PlayerSlot`, the
 * `MiniPlayer` keeps it on every other screen. Pages talk to it through two contexts:
 * stable commands (`usePlaybackCommands`) and a changing state snapshot (`usePlaybackState`,
 * or `usePlaybackSelector` to re-render only on the slice you read).
 */
import type { LibraryItem } from '../services/podcast';
import { hasAudio } from '../services/podcast';
import type { RadioState } from '../components/RadioPlayer';

/**
 * History state key of an entry pushed by opening an episode in-app (library rows, mini-player):
 * closing the dialog pops that entry, so the listener lands back where they came from.
 */
export const OPENED_HERE = 'podcastEpisode';

/** `/podcast/library?episode=<id>&mode=listen` — the episode's Now Playing sheet. */
export function nowPlayingPath(jobId: string): string {
  const params = new URLSearchParams({ episode: jobId, mode: 'listen' });
  return `/podcast/library?${params}`;
}

/** Radio MP3 of a library item (null without an audio rendition). */
export function audioSrcOf(item: LibraryItem): string | null {
  return hasAudio(item) ? item.audio_url ?? item.mp3_url ?? null : null;
}

export interface StartOptions {
  /** Start playing once the source is set (inside a tap when called from its handler). Default false. */
  autoPlay?: boolean;
  /**
   * Position in seconds on the radio timeline. Undefined = the saved resume point
   * (`progressStore.get`) or 0. For the episode already loaded, a defined `start` seeks.
   */
  start?: number;
}

/** The episode loaded in the root player. `item` may be replaced by a fresher copy (expired link). */
export interface CurrentEpisode {
  jobId: string;
  item: LibraryItem;
}

/** Where the root player is shown: nowhere, in the mini-player, or in a mounted `PlayerSlot`. */
export type Presentation = 'hidden' | 'mini' | 'dialog';

/** An episode change made by the provider itself (auto-next, lock-screen next/previous). */
export interface PlaybackAdvance {
  from: string;
  to: string;
  /** Increments on every advance (tells two identical hops apart). */
  seq: number;
}

export interface PlaybackState {
  current: CurrentEpisode | null;
  /** The radio's media element is playing. */
  playing: boolean;
  /** Seconds, published at most 4 times per second. */
  time: number;
  /** Seconds (0 = unknown). */
  duration: number;
  /** Short status for the mini-player: "Lucas is speaking", "Paused · 3:12 left", "Finished"… */
  status: string;
  /** The radio's own state ("playing", "error", "press-play"…); null while no episode is loaded or before it reports. */
  radioState: RadioState | null;
  presentation: Presentation;
  /** The last episode ended and no next episode was ready. Cleared by any play / start. */
  finished: boolean;
  lastAdvance: PlaybackAdvance | null;
  /** An episode dialog without the player (Watch, loading) hides the mini-player. */
  miniSuppressed: boolean;
}

/** Stable identities for the whole session (safe in effect dependencies). */
export interface PlaybackCommands {
  /**
   * Loads `item` into the root player and applies it synchronously (`flushSync`): called from a
   * tap handler, the new `src` is committed and `audio.play()` runs inside the gesture. The
   * episode already loaded is never reloaded (`start` seeks, `autoPlay` resumes). Call it from
   * event handlers, promise callbacks or timers — not during render or inside effects.
   */
  startEpisode(item: LibraryItem, opts?: StartOptions): void;
  /** Never rejects (a refused autoplay shows the player's "Press play" state). */
  play(): Promise<void>;
  pause(): void;
  seek(seconds: number): void;
  /** Saves the position, unmounts the root player (releasing the Media Session) and clears the state. */
  stop(): void;
  getCurrentTime(): number;
  getDuration(): number;
  /** Prefetches playable details (TTL 10 min, 2 at a time); fresh and in-flight ids are skipped. */
  prepare(jobIds: readonly string[]): void;
  /** A fresh prefetched item, else null. */
  getPrepared(jobId: string): LibraryItem | null;
  /** Fetches an episode (reusing an in-flight prefetch, never a cached copy); the result is cached. */
  loadEpisode(jobId: string): Promise<LibraryItem>;
  /** Synchronous read of the loaded episode. */
  getCurrent(): CurrentEpisode | null;
  /** Synchronous read of the whole state. */
  getState(): PlaybackState;
}
