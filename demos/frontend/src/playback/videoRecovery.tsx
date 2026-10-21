/**
 * Narrated / podcast video that cannot play: one automatic recovery, then a visible way out (contracts §6.2, rows
 * T2-06 … T2-08).
 *
 * The signed media URL of a library item lives 15 minutes, so a media error usually means "expired": like the radio
 * (components/RadioPlayer), the first error re-fetches the item (fresh SAS) and resumes at the same second. A second
 * error, a failed re-fetch, or an item without a playable rendition ends in `VideoProblem`: the cause, "Try again"
 * (always a fresh fetch — the automatic refresh happens once per open, the button never throttles), and "Listen
 * instead" when the other medium exists. While the re-fetch runs, `VideoReconnecting` says so.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type SyntheticEvent } from 'react';
import { Headphones, RotateCw } from 'lucide-react';
import { Alert, Button, Spinner } from '../ui';

export type VideoFault = 'refreshing' | 'failed';

export interface VideoResume {
  /** Seconds into the video where the failed load stopped. */
  time: number;
  /** Whether it was playing (a paused viewer stays paused after the refresh). */
  play: boolean;
}

export interface VideoRecovery {
  /** `refreshing`: render `VideoReconnecting`; `failed`: render `VideoProblem`; null: the video itself. */
  fault: VideoFault | null;
  /** Where the next load of this video starts (after a refresh), else null. */
  resume: VideoResume | null;
  /** Counts the successful refreshes of this item: part of the <video> key, so each one mounts a fresh element. */
  generation: number;
  /** `onError` of the <video> element: one automatic refresh, then `failed`. */
  onError(event: SyntheticEvent<HTMLVideoElement>): void;
  /** `onTimeUpdate` / `onPlay` / `onPause`: remembers the position (and whether it plays) for a refresh or "Listen instead". */
  track(video: HTMLVideoElement, playing?: boolean): void;
  /** Last known position, in seconds. */
  lastTime(): number;
  /** "Try again": a fresh fetch of the item, whatever happened before. */
  retry(): void;
}

interface State {
  id: string;
  fault: VideoFault | null;
  resume: VideoResume | null;
  generation: number;
}

/**
 * `jobId` is the item on screen (null = none); `fetchFresh` fetches it afresh (never a cached copy) and `apply` puts the
 * result in the page's state — its video URL then changes. The page keeps the <video> mounted (hidden) under the fault UI
 * and keys it with `generation`: a successful refresh always mounts a new element, even when the URL did not change.
 */
export function useVideoRecovery<T>({ jobId, fetchFresh, apply }: {
  jobId: string | null;
  fetchFresh: (id: string) => Promise<T>;
  apply: (fresh: T) => void;
}): VideoRecovery {
  const [state, setState] = useState<State | null>(null);
  const lastRef = useRef<VideoResume>({ time: 0, play: true });
  /** The item that already had its one automatic refresh. */
  const autoRef = useRef<string | null>(null);
  const genRef = useRef(0);
  const callbacks = useRef({ fetchFresh, apply });
  useLayoutEffect(() => { callbacks.current = { fetchFresh, apply }; });

  // Another item (or none): a clean slate with its own single automatic refresh; late answers are dropped.
  useEffect(() => {
    genRef.current += 1;
    autoRef.current = null;
    lastRef.current = { time: 0, play: true };
    setState(null);
  }, [jobId]);

  const refetch = useCallback((id: string, resume: VideoResume) => {
    genRef.current += 1;
    const gen = genRef.current;
    const next = (prev: State | null, fault: VideoFault | null, generation = 0): State => ({
      id, fault, resume, generation: (prev && prev.id === id ? prev.generation : 0) + generation,
    });
    setState((prev) => next(prev, 'refreshing'));
    callbacks.current.fetchFresh(id).then(
      (fresh) => {
        if (gen !== genRef.current) return;
        callbacks.current.apply(fresh);
        setState((prev) => next(prev, null, 1));
      },
      () => {
        if (gen === genRef.current) setState((prev) => next(prev, 'failed'));
      },
    );
  }, []);

  const mine = state && state.id === jobId ? state : null;

  const track = useCallback((video: HTMLVideoElement, playing?: boolean) => {
    lastRef.current = { time: Number.isFinite(video.currentTime) ? video.currentTime : 0, play: playing ?? lastRef.current.play };
  }, []);

  const onError = useCallback((event: SyntheticEvent<HTMLVideoElement>) => {
    const video = event.currentTarget;
    const error = video.error;
    // MEDIA_ERR_ABORTED: a superseded load, not a failure.
    if (!jobId || !error || error.code === 1) return;
    const resume: VideoResume = {
      time: video.currentTime > 0 ? video.currentTime : lastRef.current.time,
      play: lastRef.current.play,
    };
    if (autoRef.current === jobId) {
      setState((prev) => ({ id: jobId, fault: 'failed', resume, generation: prev && prev.id === jobId ? prev.generation : 0 }));
      return;
    }
    autoRef.current = jobId;
    refetch(jobId, resume);
  }, [jobId, refetch]);

  const retry = useCallback(() => {
    if (jobId) refetch(jobId, mine?.resume ?? { time: lastRef.current.time, play: true });
  }, [jobId, mine, refetch]);

  return {
    fault: mine?.fault ?? null,
    resume: mine?.resume ?? null,
    generation: mine?.generation ?? 0,
    onError,
    track,
    lastTime: () => lastRef.current.time,
    retry,
  };
}

/** Shown in place of the video while its item is fetched again. */
export function VideoReconnecting() {
  return (
    <div className="library-player__status" data-testid="video-reconnecting">
      <Spinner label="Reconnecting…" />
    </div>
  );
}

/**
 * Whether a <video> has no frame to show yet: from the start of its load until `loadeddata` / `canplay` / `playing`,
 * and again during a `waiting` stall. `key` identifies the element on screen (item, refresh generation, rendition):
 * a new key starts as "buffering" again. A paused element that is not about to autoplay is idle, not loading (a browser
 * may fetch nothing until Play: `preload=none`, data saver, iOS), so it never keeps the status on screen. Errors are not
 * handled here — the page hides the status while `useVideoRecovery` has a fault.
 */
export function useVideoBuffering(key: string) {
  const [state, setState] = useState({ key, active: true });
  const active = state.key === key ? state.active : true;
  const handlers = useMemo(() => {
    const set = (next: boolean) => () => setState({ key, active: next });
    const idleIfPaused = (event: SyntheticEvent<HTMLVideoElement>) => {
      const video = event.currentTarget;
      if (video.paused && !video.autoplay) setState({ key, active: false });
    };
    // Capture-phase names: the pages already use onPlay / onPause / onLoadedMetadata on the same <video>.
    return {
      onLoadStart: set(true),
      onWaiting: set(true),
      onPlayCapture: (event: SyntheticEvent<HTMLVideoElement>) => {
        if (event.currentTarget.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) setState({ key, active: true });
      },
      onLoadedMetadataCapture: idleIfPaused,
      onSuspend: idleIfPaused,
      onPauseCapture: set(false),
      onLoadedData: set(false),
      onCanPlay: set(false),
      onPlaying: set(false),
    };
  }, [key]);
  return { active, handlers };
}

/**
 * "Loading video…" over the video until it can show a frame. Decorative for pointers (the native controls stay usable);
 * announced politely to assistive technology.
 */
export function VideoBuffering() {
  return (
    <div className="library-player__buffering" role="status" aria-live="polite" data-testid="video-buffering">
      <span className="spinner" aria-hidden />
      <span>Loading video…</span>
    </div>
  );
}

/**
 * The video cannot be played. `unavailable` = the item has no playable rendition at all; `failed` = it has one that
 * would not play. Takes focus on "Try again" (the player it replaced had it).
 */
export function VideoProblem({ kind, onRetry, instead }: {
  kind: 'failed' | 'unavailable';
  onRetry: () => void;
  /** The other medium, when the item has one ("Listen instead"). */
  instead?: { label: string; onClick: () => void };
}) {
  const retryRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { retryRef.current?.focus(); }, []);
  return (
    <div className="library-player__problem" data-testid="video-problem" data-kind={kind}>
      <Alert tone="error" className="library-player__problem-alert">
        {kind === 'failed'
          ? "This video couldn't be played. The link may have expired or the connection dropped."
          : "This video isn't available to play right now."}
      </Alert>
      <div className="library-player__problem-actions">
        <Button ref={retryRef} icon={RotateCw} onClick={onRetry} data-testid="video-retry">Try again</Button>
        {instead && <Button icon={Headphones} onClick={instead.onClick} data-testid="video-instead">{instead.label}</Button>}
      </div>
    </div>
  );
}
