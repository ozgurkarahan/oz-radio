/**
 * PlaybackProvider — the app-wide podcast audio session (one per visit).
 *
 * Owns ONE root `RadioPlayer` (mounted on the first `startEpisode`, unmounted by `stop()`),
 * never keyed per episode: every episode plays on the same <audio> element, which iOS keeps
 * unlocked after the first tap (needed to auto-advance with the screen locked).
 *
 * The player renders through a portal into a host node that is physically moved between a
 * `PlayerSlot` (the episode dialog) and a hidden, inert parking container. Moving a media
 * element within one task never pauses it, so closing / Back / scrim / route changes keep the
 * audio, the waveform, the transcript and the Media Session intact. Moves happen only in
 * layout effects (their cleanups run before React removes the dialog DOM; router navigations
 * are transitions, so a passive effect would run too late).
 *
 * Also here: SAS-expiry refresh by job id (cache bypass), exclusive playback (exclusive.ts),
 * progress checkpoints (progress.ts), next-episode readiness + auto-advance inside `ended`
 * (queue.ts, prepare.ts). Contexts are split: stable commands vs a changing state snapshot.
 */
import React, {
  createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState,
  useSyncExternalStore,
} from 'react';
import { createPortal, flushSync } from 'react-dom';
import { listLibrary, type LibraryItem, type LibrarySummary } from '../services/podcast';
import { useAvatars } from '../services/avatars';
import {
  RadioPlayer, toRadioHosts, type RadioMediaActions, type RadioPlayerHandle, type RadioStatus,
} from '../components/RadioPlayer';
import { humanizeTitle } from '../ui';
import ErrorBoundary from '../components/ErrorBoundary';
import * as prepared from './prepare';
import { progressStore } from './progress';
import { LOCKSCREEN_TRACK_BUTTONS, nextEpisodeResolver } from './queue';
import { installExclusivePlayback } from './exclusive';
import { releaseMediaSession } from './mediaSession';
import {
  audioSrcOf, type CurrentEpisode, type PlaybackCommands, type PlaybackState, type StartOptions,
} from './types';

export type { PlaybackCommands, PlaybackState } from './types';

const PUBLISH_INTERVAL_MS = 250;
const SAVE_INTERVAL_MS = 5000;
/** On resume / page visible: re-fetch a prepared next episode older than this. */
const RESUME_MAX_AGE_MS = 5 * 60_000;
/** Past `prepareAt`: re-fetch unless fetched within the last minute. */
const NEAR_END_MAX_AGE_MS = 60_000;

const INITIAL_STATE: PlaybackState = {
  current: null,
  playing: false,
  time: 0,
  duration: 0,
  status: '',
  presentation: 'hidden',
  finished: false,
  lastAdvance: null,
  miniSuppressed: false,
};

// ---- Tiny external store (selector subscriptions without context re-render storms) ----

type Listener = () => void;

interface Store {
  get(): PlaybackState;
  replace(next: PlaybackState): void;
  subscribe(listener: Listener): () => void;
}

function createStore(initial: PlaybackState): Store {
  let state = initial;
  const listeners = new Set<Listener>();
  return {
    get: () => state,
    replace(next) {
      const keys = Object.keys(next) as (keyof PlaybackState)[];
      if (keys.every((k) => Object.is(state[k], next[k]))) return;
      state = next;
      listeners.forEach((listener) => listener());
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

/** 192.4 → "3:12". */
function clock(seconds: number): string {
  const s = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : 0;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function miniStatus(state: PlaybackState, radio: RadioStatus | null): string {
  if (!state.current) return '';
  if (state.finished) return 'Finished';
  const left = state.duration > 0 ? `${clock(Math.max(0, state.duration - state.time))} left` : null;
  switch (radio?.state) {
    case 'unavailable':
    case 'error': return 'Audio unavailable';
    case 'refreshing': return 'Reconnecting…';
    case 'buffering': return 'Loading…';
    case 'press-play': return 'Press play';
    case 'playing': return radio.speaker ? `${radio.speaker} is speaking` : left ?? 'Playing';
    default: return left ? `Paused · ${left}` : 'Paused';
  }
}

/** Radio duration known before the media loads. */
function knownDuration(item: LibraryItem): number {
  const d = item.audio_duration_sec ?? item.transcript?.duration_sec ?? 0;
  return typeof d === 'number' && Number.isFinite(d) && d > 0 ? d : 0;
}

// ---- Contexts ------------------------------------------------------------------------

interface Internal {
  store: Store;
  /** Moves the player into `slot`; returns the function that parks it again. */
  attachSlot(slot: HTMLElement): () => void;
  /** Hides the mini-player until the returned function is called. */
  suppressMini(): () => void;
}

const CommandsContext = createContext<PlaybackCommands | null>(null);
const StateContext = createContext<PlaybackState | null>(null);
const InternalContext = createContext<Internal | null>(null);

function required<T>(value: T | null, hook: string): T {
  if (!value) throw new Error(`${hook} must be used inside <PlaybackProvider>`);
  return value;
}

/** Stable commands (never change identity). */
export function usePlaybackCommands(): PlaybackCommands {
  return required(useContext(CommandsContext), 'usePlaybackCommands');
}

/** The whole state; re-renders on every change (time ≤ 4 Hz while playing). */
export function usePlaybackState(): PlaybackState {
  return required(useContext(StateContext), 'usePlaybackState');
}

/**
 * Re-renders only when `selector`'s result changes (`Object.is`). Return primitives or
 * references taken from the state (e.g. `(s) => s.current?.jobId ?? null`).
 */
export function usePlaybackSelector<T>(selector: (state: PlaybackState) => T): T {
  const { store } = required(useContext(InternalContext), 'usePlaybackSelector');
  const get = () => selector(store.get());
  return useSyncExternalStore(store.subscribe, get, get);
}

/** While `active`, the mini-player stays hidden (an episode dialog showing Watch or a spinner). */
export function useSuppressMiniPlayer(active: boolean): void {
  const internal = required(useContext(InternalContext), 'useSuppressMiniPlayer');
  useLayoutEffect(() => (active ? internal.suppressMini() : undefined), [active, internal]);
}

/** Internal (PlayerSlot). */
export function usePlaybackInternals(): Internal {
  return required(useContext(InternalContext), 'usePlaybackInternals');
}

// ---- Root player ------------------------------------------------------------------------

interface EpisodeLoad {
  jobId: string;
  item: LibraryItem;
  /** The episode's source; renewals go through `onRefreshSource`, never through this prop. */
  src: string | null;
  start: number;
  autoPlay: boolean;
}

interface RootRadioProps {
  episode: EpisodeLoad;
  parked: boolean;
  radioRef: React.RefObject<RadioPlayerHandle | null>;
  onRefreshSource: () => Promise<string | null>;
  onTimeUpdate: (t: number, key: string | undefined) => void;
  onPlayStateChange: (playing: boolean, key: string | undefined) => void;
  onEnded: (key: string | undefined) => void;
  onStatusChange: (status: RadioStatus) => void;
  extraMediaActions?: RadioMediaActions;
}

const RootRadio = memo(function RootRadio({ episode, radioRef, ...handlers }: RootRadioProps) {
  const { avatars } = useAvatars();
  const { item } = episode;
  const hosts = useMemo(() => toRadioHosts(item.hosts, avatars, item.speaker_names ?? []), [item, avatars]);
  return (
    <RadioPlayer
      ref={radioRef}
      tone="stage"
      episodeKey={episode.jobId}
      src={episode.src}
      title={humanizeTitle(item.title)}
      transcript={item.transcript ?? null}
      coverUrl={item.cover_url ?? null}
      hosts={hosts}
      autoPlay={episode.autoPlay}
      initialTime={episode.start}
      {...handlers}
    />
  );
});

// ---- Provider --------------------------------------------------------------------------------

export function PlaybackProvider({ children }: { children: React.ReactNode }) {
  const [store] = useState(() => createStore(INITIAL_STATE));
  const [hostNode] = useState(() => {
    const el = document.createElement('div');
    el.className = 'playback-host';
    return el;
  });
  const [episode, setEpisode] = useState<EpisodeLoad | null>(null);
  const [parked, setParked] = useState(true);
  const [catalogVersion, setCatalogVersion] = useState(0);

  const radioRef = useRef<RadioPlayerHandle>(null);
  const parkingRef = useRef<HTMLDivElement>(null);
  const slotRef = useRef<HTMLElement | null>(null);
  const currentRef = useRef<CurrentEpisode | null>(null);
  const internalRef = useRef({ radioStatus: null as RadioStatus | null, slotMounted: false, suppress: 0 });
  const catalogRef = useRef<LibrarySummary[] | null>(null);
  const catalogLoadingRef = useRef(false);
  const lastPublishRef = useRef(0);
  const publishTimerRef = useRef<number | undefined>(undefined);
  const lastSaveRef = useRef(0);
  const pausedAtRef = useRef<number | null>(null);
  /** Episode marked done by `ended`: no position checkpoint may overwrite that. */
  const doneForRef = useRef<string | null>(null);
  /** Episode for which the next one was made ready past `prepareAt`. */
  const nearEndForRef = useRef<string | null>(null);
  const advanceSeqRef = useRef(0);

  /** Merges `patch` and derives presentation, mini-player visibility and status. */
  const publish = useCallback((patch: Partial<PlaybackState> = {}) => {
    const internal = internalRef.current;
    const next: PlaybackState = { ...store.get(), ...patch };
    next.presentation = internal.slotMounted ? 'dialog' : next.current ? 'mini' : 'hidden';
    next.miniSuppressed = internal.suppress > 0;
    next.status = miniStatus(next, internal.radioStatus);
    store.replace(next);
  }, [store]);

  const radioDuration = useCallback(() => {
    const d = radioRef.current?.getDuration() ?? 0;
    return d > 0 ? d : store.get().duration;
  }, [store]);

  /** Position checkpoint of the loaded episode (never after it was marked done). */
  const saveNow = useCallback(() => {
    const cur = currentRef.current;
    const radio = radioRef.current;
    if (!cur || !radio || doneForRef.current === cur.jobId) return;
    lastSaveRef.current = Date.now();
    try { progressStore.save(cur.jobId, radio.getCurrentTime(), radio.getDuration()); } catch { /* silent */ }
  }, []);

  // ---- Continuity (queue.ts) ----
  const resolveNeighbour = useCallback((dir: 'next' | 'previous'): LibrarySummary | null => {
    const cur = currentRef.current;
    const catalog = catalogRef.current;
    if (!cur || !catalog) return null;
    const summary = catalog.find((s) => s.job_id === cur.jobId) ?? cur.item;
    try {
      const hit = dir === 'next'
        ? nextEpisodeResolver.next(summary, catalog)
        : nextEpisodeResolver.previous(summary, catalog);
      return hit && hit.job_id !== cur.jobId ? hit : null;
    } catch {
      return null;
    }
  }, []);

  const prepareNext = useCallback((maxAgeMs: number) => {
    const next = resolveNeighbour('next');
    if (next) prepared.prepare([next.job_id], maxAgeMs);
  }, [resolveNeighbour]);

  /** Past `prepareAt` of the loaded episode (once per episode, once the catalog is known). */
  const checkNearEnd = useCallback((t: number) => {
    const cur = currentRef.current;
    if (!cur || nearEndForRef.current === cur.jobId || !catalogRef.current) return;
    const d = radioDuration();
    if (d <= 0 || t / d < nextEpisodeResolver.prepareAt) return;
    nearEndForRef.current = cur.jobId;
    prepareNext(NEAR_END_MAX_AGE_MS);
  }, [prepareNext, radioDuration]);

  const ensureCatalog = useCallback(() => {
    if (catalogRef.current || catalogLoadingRef.current) return;
    catalogLoadingRef.current = true;
    listLibrary()
      .then((rows) => {
        catalogRef.current = rows;
        setCatalogVersion((v) => v + 1);
        checkNearEnd(radioRef.current?.getCurrentTime() ?? 0);
      }, () => { /* retried on the next start */ })
      .finally(() => { catalogLoadingRef.current = false; });
  }, [checkNearEnd]);

  // ---- Commands ----
  const startImpl = useCallback((item: LibraryItem, opts: StartOptions = {}, advanceFrom?: string) => {
    const jobId = item.job_id;
    const cur = currentRef.current;
    if (cur && cur.jobId === jobId) {
      // Same episode: never reload (the <audio> keeps its source, position and unlock).
      const radio = radioRef.current;
      if (typeof opts.start === 'number' && Number.isFinite(opts.start)) radio?.seek(Math.max(0, opts.start));
      if (opts.autoPlay) {
        publish({ finished: false });
        void radio?.play();
      }
      return;
    }
    saveNow();
    let start = 0;
    if (typeof opts.start === 'number' && Number.isFinite(opts.start)) {
      start = Math.max(0, opts.start);
    } else {
      try {
        const saved = progressStore.get(jobId);
        if (saved && !saved.done && Number.isFinite(saved.position)) start = Math.max(0, saved.position);
      } catch { /* silent */ }
    }
    currentRef.current = { jobId, item };
    doneForRef.current = null;
    nearEndForRef.current = null;
    pausedAtRef.current = null;
    lastSaveRef.current = Date.now();
    internalRef.current.radioStatus = null;
    const lastAdvance = advanceFrom
      ? { from: advanceFrom, to: jobId, seq: (advanceSeqRef.current += 1) }
      : store.get().lastAdvance;
    // Synchronous commit: RadioPlayer's layout effect calls play() inside the caller's task.
    flushSync(() => {
      setEpisode({ jobId, item, src: audioSrcOf(item), start, autoPlay: !!opts.autoPlay });
      publish({
        current: { jobId, item }, playing: false, time: start, duration: knownDuration(item), finished: false, lastAdvance,
      });
    });
    ensureCatalog();
  }, [publish, saveNow, store, ensureCatalog]);

  const skipTo = useCallback((dir: 'next' | 'previous') => {
    const from = currentRef.current?.jobId;
    const target = resolveNeighbour(dir);
    if (!from || !target) return;
    const go = (item: LibraryItem) => {
      if (currentRef.current?.jobId === from) startImpl(item, { autoPlay: true, start: 0 }, from);
    };
    const ready = prepared.get(target.job_id);
    if (ready) go(ready);
    else prepared.load(target.job_id).then(go, () => { /* stays on the current episode */ });
  }, [resolveNeighbour, startImpl]);

  const commands = useMemo<PlaybackCommands>(() => ({
    startEpisode: (item, opts) => startImpl(item, opts),
    play: async () => {
      publish({ finished: false });
      await radioRef.current?.play();
    },
    pause: () => radioRef.current?.pause(),
    seek: (seconds) => radioRef.current?.seek(seconds),
    stop: () => {
      saveNow();
      const audio = hostNode.querySelector('audio');
      currentRef.current = null;
      internalRef.current.radioStatus = null;
      setEpisode(null);
      publish({ current: null, playing: false, time: 0, duration: 0, finished: false });
      if (audio) releaseMediaSession(audio);
    },
    getCurrentTime: () => radioRef.current?.getCurrentTime() ?? 0,
    getDuration: () => radioDuration(),
    prepare: (ids) => prepared.prepare(ids),
    getPrepared: (id) => prepared.get(id),
    loadEpisode: (id) => prepared.load(id),
    getCurrent: () => store.get().current,
    getState: () => store.get(),
  }), [startImpl, publish, saveNow, store, hostNode, radioDuration]);

  // ---- RadioPlayer callbacks (stable) ----
  const onRefreshSource = useCallback(async (): Promise<string | null> => {
    const jobId = currentRef.current?.jobId;
    if (!jobId) return null;
    try {
      const fresh = await prepared.refresh(jobId);
      if (currentRef.current?.jobId !== jobId) return null;
      currentRef.current = { jobId, item: fresh };
      setEpisode((e) => (e && e.jobId === jobId ? { ...e, item: fresh } : e));
      publish({ current: { jobId, item: fresh } });
      return audioSrcOf(fresh);
    } catch {
      return null;
    }
  }, [publish]);

  const flushTime = useCallback(() => {
    window.clearTimeout(publishTimerRef.current);
    publishTimerRef.current = undefined;
    lastPublishRef.current = performance.now();
    const radio = radioRef.current;
    if (radio && currentRef.current) publish({ time: radio.getCurrentTime(), duration: radioDuration() });
  }, [publish, radioDuration]);

  const onTimeUpdate = useCallback((t: number, key: string | undefined) => {
    const cur = currentRef.current;
    if (!cur || key !== cur.jobId) return; // late event of a previous episode
    const wait = lastPublishRef.current + PUBLISH_INTERVAL_MS - performance.now();
    if (wait <= 0) flushTime();
    else if (publishTimerRef.current === undefined) publishTimerRef.current = window.setTimeout(flushTime, wait);
    if (Date.now() - lastSaveRef.current >= SAVE_INTERVAL_MS) saveNow();
    checkNearEnd(t);
  }, [flushTime, saveNow, checkNearEnd]);

  const onPlayStateChange = useCallback((playing: boolean, key: string | undefined) => {
    const cur = currentRef.current;
    const radio = radioRef.current;
    if (!cur || !radio || key !== cur.jobId) return;
    if (playing) {
      doneForRef.current = null;
      const pausedAt = pausedAtRef.current;
      pausedAtRef.current = null;
      if (pausedAt != null) {
        const t = radio.getCurrentTime();
        let target = t;
        try { target = progressStore.positionAfterPause(cur.jobId, t, Date.now() - pausedAt); } catch { target = t; }
        if (Number.isFinite(target) && Math.abs(target - t) > 0.25) radio.seek(Math.max(0, target));
        prepareNext(RESUME_MAX_AGE_MS);
      }
      publish({ playing: true, finished: false });
    } else {
      pausedAtRef.current = Date.now();
      saveNow();
      publish({ playing: false, time: radio.getCurrentTime(), duration: radioDuration() });
    }
  }, [publish, saveNow, prepareNext, radioDuration]);

  const onEnded = useCallback((key: string | undefined) => {
    const cur = currentRef.current;
    if (!cur || key !== cur.jobId) return;
    doneForRef.current = cur.jobId;
    try { progressStore.markDone(cur.jobId); } catch { /* silent */ }
    const next = resolveNeighbour('next');
    const item = next ? prepared.get(next.job_id) : null;
    if (item && audioSrcOf(item)) {
      // Same task as `ended`: new src + play() before the audio session can go idle.
      startImpl(item, { autoPlay: true, start: 0 }, cur.jobId);
      return;
    }
    publish({ finished: true, playing: false, time: radioDuration() });
  }, [resolveNeighbour, startImpl, publish, radioDuration]);

  const onStatusChange = useCallback((status: RadioStatus) => {
    internalRef.current.radioStatus = status;
    publish();
  }, [publish]);

  const extraMediaActions = useMemo<RadioMediaActions | undefined>(() => {
    if (!LOCKSCREEN_TRACK_BUTTONS || !episode) return undefined;
    const actions: RadioMediaActions = {};
    if (resolveNeighbour('next')) actions.nexttrack = () => skipTo('next');
    if (resolveNeighbour('previous')) actions.previoustrack = () => skipTo('previous');
    return actions.nexttrack || actions.previoustrack ? actions : undefined;
  }, [episode, catalogVersion, resolveNeighbour, skipTo]);

  // ---- Host node: parking + slot ----
  useLayoutEffect(() => {
    const parking = parkingRef.current;
    if (!slotRef.current && parking && hostNode.parentNode !== parking) parking.appendChild(hostNode);
  }, [hostNode]);

  const attachSlot = useCallback((slot: HTMLElement) => {
    slotRef.current = slot;
    if (hostNode.parentNode !== slot) slot.appendChild(hostNode);
    internalRef.current.slotMounted = true;
    setParked(false);
    publish();
    return () => {
      if (slotRef.current !== slot) return;
      slotRef.current = null;
      // Same task as the dialog's removal: the media element never leaves the document.
      const parking = parkingRef.current;
      if (parking) parking.appendChild(hostNode);
      internalRef.current.slotMounted = false;
      setParked(true);
      publish();
    };
  }, [hostNode, publish]);

  const suppressMini = useCallback(() => {
    internalRef.current.suppress += 1;
    publish();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      internalRef.current.suppress -= 1;
      publish();
    };
  }, [publish]);

  const internal = useMemo<Internal>(() => ({ store, attachSlot, suppressMini }), [store, attachSlot, suppressMini]);

  // ---- Exclusive playback, checkpoints, lifecycle ----
  useEffect(() => installExclusivePlayback({
    getRadio: () => hostNode.querySelector('audio'),
    onRadioTakenOver: () => radioRef.current?.pause(),
  }), [hostNode]);

  useEffect(() => {
    const onMediaChange = (e: Event) => {
      if (e.target instanceof HTMLMediaElement) saveNow();
    };
    hostNode.addEventListener('seeked', onMediaChange, true);
    hostNode.addEventListener('ratechange', onMediaChange, true);
    return () => {
      hostNode.removeEventListener('seeked', onMediaChange, true);
      hostNode.removeEventListener('ratechange', onMediaChange, true);
    };
  }, [hostNode, saveNow]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') saveNow();
      else if (currentRef.current) prepareNext(RESUME_MAX_AGE_MS);
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', saveNow);
    document.addEventListener('freeze', saveNow);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', saveNow);
      document.removeEventListener('freeze', saveNow);
      window.clearTimeout(publishTimerRef.current);
    };
  }, [saveNow, prepareNext]);

  const snapshot = useSyncExternalStore(store.subscribe, store.get, store.get);

  return (
    <InternalContext.Provider value={internal}>
      <CommandsContext.Provider value={commands}>
        <StateContext.Provider value={snapshot}>
          {children}
          <div ref={parkingRef} className="playback-parking" hidden inert data-testid="playback-parking" />
          {episode && createPortal(
            // A player crash stays inside the player (the page keeps working); a new episode resets it.
            <ErrorBoundary resetKey={episode.jobId}>
              <RootRadio
                episode={episode}
                parked={parked}
                radioRef={radioRef}
                onRefreshSource={onRefreshSource}
                onTimeUpdate={onTimeUpdate}
                onPlayStateChange={onPlayStateChange}
                onEnded={onEnded}
                onStatusChange={onStatusChange}
                extraMediaActions={extraMediaActions}
              />
            </ErrorBoundary>,
            hostNode,
          )}
        </StateContext.Provider>
      </CommandsContext.Provider>
    </InternalContext.Provider>
  );
}
