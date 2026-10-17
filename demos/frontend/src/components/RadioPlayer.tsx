/**
 * RadioPlayer — the "Listen" experience for Oz Radio podcasts.
 *
 * Accessible custom controls around a native <audio preload="metadata"> (no
 * native controls): cover art, both hosts lit from the radio transcript (glow on
 * backchannel cues), the current speaker as text, a polite live caption that only
 * changes with the cue, a collapsible click-to-seek transcript, a seekable peaks
 * waveform (role="slider", turn ticks), ±15 s, speed, keyboard shortcuts
 * (Space/K, J/L), Media Session, autoplay-rejection handling and SAS-expiry
 * recovery (at most one source refresh per minute; position and play state are
 * restored). Parents drive it through the imperative handle (Watch ↔ Listen).
 * Styles: styles/shared/radio-player.css — tone "stage" (dark modal) or "light"
 * (studio card).
 */
import React, {
  forwardRef, memo, useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState,
} from 'react';
import {
  AudioLines, ChevronDown, Headphones, Pause, Play, Radio as RadioIcon, RotateCcw, RotateCw, ScrollText, Sparkles,
} from 'lucide-react';
import type { PodcastHost, Speaker, Transcript, TranscriptCue, TranscriptTurn } from '../services/podcast';
import { Alert, Button, Field, HostDisc, LivePill, Select, Waveform } from '../ui';
import '../styles/shared/radio-player.css';

// ---- Public API -----------------------------------------------------------

export interface RadioHost {
  role: 'interviewer' | 'expert';
  display_name: string;
  thumbnail_url?: string | null;
}

export interface RadioPlayerHandle {
  /** Starts playback. Never rejects: a blocked autoplay shows a "Press play" state instead. */
  play(): Promise<void>;
  pause(): void;
  /** Seconds on the radio timeline (clamped); applied once metadata has loaded if needed. */
  seek(seconds: number): void;
  getCurrentTime(): number;
  /** Audio duration, else the transcript's `duration_sec`, else 0. */
  getDuration(): number;
}

export interface RadioPlayerProps {
  /** Radio MP3 (SAS URL or local route); null = unavailable (controls disabled). */
  src: string | null;
  title: string;
  /** Radio-timed transcript: captions, host lighting, turn ticks and waveform peaks. */
  transcript?: Transcript | null;
  coverUrl?: string | null;
  /** Names + portraits by role (see `toRadioHosts`); missing roles fall back to the transcript. */
  hosts: RadioHost[];
  /** Try to start when a source loads; a browser refusal shows "Press play" (no error). */
  autoPlay?: boolean;
  /** Start position in seconds, applied whenever a new `src` loads (use the handle to seek later). */
  initialTime?: number;
  /** 'stage' = dark modal player, 'light' = studio card (default). */
  tone?: 'stage' | 'light';
  /** Returns a fresh source after a media error (expired SAS). Called at most once per minute. */
  onRefreshSource?: () => Promise<string | null>;
  /** Media `timeupdate` (≈ 4 Hz) and seeks applied before the media is ready. */
  onTimeUpdate?: (t: number) => void;
  onPlayStateChange?: (playing: boolean) => void;
  className?: string;
  /** Show the full transcript expanded initially (default: collapsed). */
  defaultTranscriptOpen?: boolean;
}

/** Structural subset of `AvatarInfo` (services/avatars) used to resolve portraits. */
export interface RadioAvatarLike {
  id: string;
  display_name?: string | null;
  thumbnail_url?: string | null;
}

// ---- Constants --------------------------------------------------------------

const SKIP_SEC = 15;
const ARROW_STEP_SEC = 5;
const PAGE_STEP_SEC = 30;
const SPEEDS = [0.75, 1, 1.25, 1.5, 2];
const REFRESH_MIN_INTERVAL_MS = 60_000;
/** Keep the caption between sentences instead of blanking it. */
const CAPTION_HOLD_SEC = 1.5;
/** Keep the speaker lit across the short gap before the next turn. */
const TURN_HOLD_SEC = 0.6;
/** Minimum visible length of a backchannel glow. */
const REACTION_MIN_SEC = 0.9;
/** Transcript auto-follow pauses this long after the user scrolls it. */
const USER_SCROLL_GRACE_MS = 4000;
const ROLES: Speaker[] = ['interviewer', 'expert'];
const ROLE_LABEL: Record<Speaker, string> = { interviewer: 'Interviewer', expert: 'Expert' };
const ALBUM = 'Oz Radio';
const UNAVAILABLE = "The audio couldn't be loaded.";
const MEDIA_ACTIONS: MediaSessionAction[] = ['play', 'pause', 'seekbackward', 'seekforward', 'seekto'];

// Waveform geometry (SVG user units = CSS px once the width is measured).
const BAR_AREA_H = 46;
const TICK_GAP = 4;
const TICK_H = 6;
const VIEW_H = BAR_AREA_H + TICK_GAP + TICK_H;
const FLAT_LEVEL = 0.22;
const NO_TICKS: number[] = [];

/** Playback speed survives source changes and remounts within the page session. */
let rememberedSpeed = 1;
/** Player instance that last claimed the OS media controls. */
let mediaSessionOwner: object | null = null;

// ---- Pure helpers -------------------------------------------------------------

/** 83.4 → "1:23"; 3725 → "1:02:05" (floored). */
function clock(seconds: number): string {
  const s = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

function clampTime(t: number, duration: number): number {
  const v = Math.max(0, t);
  return duration > 0 ? Math.min(v, duration) : v;
}

/** Index of the last entry whose start ≤ t (starts sorted ascending), else -1. */
function lastAtOrBefore(starts: number[], t: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= t) { found = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return found;
}

const isRole = (v: unknown): v is Speaker => v === 'interviewer' || v === 'expert';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function hasMediaSession(): boolean {
  return typeof navigator !== 'undefined' && 'mediaSession' in navigator;
}

function isTypingTarget(el: EventTarget | null): boolean {
  return el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
}

/** Elements whose own Space activation must not be hijacked. */
function activatesOnSpace(el: EventTarget | null): boolean {
  return el instanceof HTMLElement && (/^(BUTTON|A|SUMMARY)$/.test(el.tagName) || el.getAttribute('role') === 'button');
}

function hasKeyboardFocusWithin(el: HTMLElement): boolean {
  try { return !!el.querySelector(':focus-visible'); } catch { return el.contains(document.activeElement); }
}

interface Prepared {
  cues: TranscriptCue[];
  speech: number[];
  speechStarts: number[];
  reactions: number[];
  reactionStarts: number[];
  turns: TranscriptTurn[];
  turnStarts: number[];
  peaks: number[];
}

/** Validates and sorts the transcript once (cues by start, speech vs reaction indexes). */
function prepareTranscript(transcript: Transcript | null | undefined): Prepared {
  const rawCues: unknown[] = Array.isArray(transcript?.cues) ? transcript.cues : [];
  const cues: TranscriptCue[] = [];
  for (const raw of rawCues) {
    const c = raw as Partial<TranscriptCue> | null;
    if (!c || !isRole(c.speaker) || !isNum(c.start) || !isNum(c.end) || typeof c.text !== 'string') continue;
    const text = c.text.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    cues.push({
      start: Math.max(0, c.start),
      end: Math.max(c.start, c.end),
      speaker: c.speaker,
      turn_idx: isNum(c.turn_idx) ? c.turn_idx : -1,
      text,
      kind: c.kind === 'reaction' ? 'reaction' : 'speech',
    });
  }
  cues.sort((a, b) => a.start - b.start);
  const speech: number[] = [];
  const reactions: number[] = [];
  cues.forEach((c, i) => (c.kind === 'reaction' ? reactions : speech).push(i));

  const rawTurns: unknown[] = Array.isArray(transcript?.turns) ? transcript.turns : [];
  const turns = rawTurns
    .map((raw) => raw as Partial<TranscriptTurn> | null)
    .filter((t): t is TranscriptTurn => !!t && isRole(t.speaker) && isNum(t.start) && isNum(t.end))
    .sort((a, b) => a.start - b.start);

  const rawPeaks: unknown[] = Array.isArray(transcript?.peaks) ? transcript.peaks : [];
  const peaks = rawPeaks.map((v) => (isNum(v) ? Math.min(1, Math.max(0, v)) : 0));

  return {
    cues,
    speech,
    speechStarts: speech.map((i) => cues[i].start),
    reactions,
    reactionStarts: reactions.map((i) => cues[i].start),
    turns,
    turnStarts: turns.map((t) => t.start),
    peaks,
  };
}

/** Peaks → `count` bar heights in 0..1 (max-pooled, normalised); neutral flat bars without peaks. */
function buildBars(peaks: number[], count: number): number[] {
  if (peaks.length === 0) return Array.from({ length: count }, () => FLAT_LEVEL);
  let values = peaks;
  if (peaks.length > count) {
    values = Array.from({ length: count }, (_, i) => {
      const a = Math.floor((i * peaks.length) / count);
      const b = Math.max(a + 1, Math.floor(((i + 1) * peaks.length) / count));
      let m = 0;
      for (let j = a; j < b; j++) m = Math.max(m, peaks[j]);
      return m;
    });
  }
  const max = values.reduce((m, v) => Math.max(m, v), 0);
  return values.map((v) => (max > 0 ? 0.08 + 0.92 * (v / max) : FLAT_LEVEL));
}

function resolveHost(role: Speaker, hosts: RadioHost[] | null | undefined, transcript: Transcript | null | undefined): RadioHost {
  const fromProps = Array.isArray(hosts) ? hosts.find((h) => h?.role === role) : undefined;
  const fromTranscript = Array.isArray(transcript?.hosts) ? transcript.hosts.find((h) => h?.role === role) : undefined;
  return {
    role,
    display_name: fromProps?.display_name?.trim() || fromTranscript?.display_name?.trim() || ROLE_LABEL[role],
    thumbnail_url: fromProps?.thumbnail_url ?? null,
  };
}

/**
 * Builds the `hosts` prop: names from the transcript / library `hosts` (by role) and
 * portraits from the avatar catalog (`useAvatars()`) by `avatar_id`. An explicit
 * `avatar_id: null` means "no portrait" (monogram, e.g. audio-only). Without a host
 * entry (legacy items) the name comes from `fallbackNames` (interviewer first, e.g.
 * `speaker_names`) and the portrait from a catalog entry with the same display name.
 */
export function toRadioHosts(
  hosts: readonly PodcastHost[] | null | undefined,
  avatars: readonly RadioAvatarLike[] = [],
  fallbackNames: readonly (string | null | undefined)[] = [],
): RadioHost[] {
  return ROLES.map((role, i) => {
    const host = hosts?.find((h) => h?.role === role);
    const name = host?.display_name?.trim() || fallbackNames[i]?.trim() || ROLE_LABEL[role];
    let avatar: RadioAvatarLike | undefined;
    if (host?.avatar_id) avatar = avatars.find((a) => a.id === host.avatar_id);
    else if (host?.avatar_id !== null) avatar = avatars.find((a) => a.display_name?.trim() === name);
    return { role, display_name: name, thumbnail_url: avatar?.thumbnail_url ?? null };
  });
}

/**
 * Maps a position between the video and radio timelines turn by turn using
 * `transcript.turns[].video_start/video_end` (Watch ↔ Listen switching). Inside a
 * turn the offset is scaled; in a gap it snaps to the next turn's start. Returns
 * `t` unchanged when the turns carry no video timings.
 */
export function mapRenditionTime(transcript: Transcript | null | undefined, t: number, from: 'video' | 'audio'): number {
  const time = Number.isFinite(t) && t > 0 ? t : 0;
  const spans = (transcript?.turns ?? [])
    .filter((x) => isNum(x?.start) && isNum(x?.end) && isNum(x?.video_start) && isNum(x?.video_end))
    .map((x) => {
      const audio: [number, number] = [x.start, x.end];
      const video: [number, number] = [x.video_start as number, x.video_end as number];
      return from === 'video' ? { src: video, dst: audio } : { src: audio, dst: video };
    })
    .sort((a, b) => a.src[0] - b.src[0]);
  if (spans.length === 0) return time;
  if (time < spans[0].src[0]) return Math.max(0, spans[0].dst[0] - (spans[0].src[0] - time));
  let i = spans.length - 1;
  while (i > 0 && spans[i].src[0] > time) i--;
  const { src, dst } = spans[i];
  if (time <= src[1]) {
    const span = src[1] - src[0];
    const frac = span > 0 ? (time - src[0]) / span : 0;
    return dst[0] + frac * (dst[1] - dst[0]);
  }
  return i + 1 < spans.length ? spans[i + 1].dst[0] : dst[1] + (time - src[1]);
}

// ---- Hooks ------------------------------------------------------------------------

function usePrefersReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)';
  const [reduced, setReduced] = useState(
    () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(query);
    const update = () => setReduced(mql.matches);
    update();
    mql.addEventListener?.('change', update);
    return () => mql.removeEventListener?.('change', update);
  }, []);
  return reduced;
}

function useElementWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = (w: number) => setWidth((prev) => (Math.abs(prev - w) < 1 ? prev : Math.round(w)));
    measure(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) measure(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

// ---- Presentational pieces ---------------------------------------------------------

function CoverArt({ url }: { url: string | null }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const showImage = !!url && failedUrl !== url;
  return (
    <div className="radio-player__cover" data-testid="radio-cover" data-cover={showImage ? 'image' : 'placeholder'}>
      {showImage ? (
        <img src={url} alt="" decoding="async" draggable={false} onError={() => setFailedUrl(url)} />
      ) : (
        <span className="radio-player__placeholder" aria-hidden>
          <span className="radio-player__placeholder-mark"><RadioIcon /></span>
          <span className="radio-player__placeholder-brand">{ALBUM}</span>
        </span>
      )}
    </div>
  );
}

const WaveBars = memo(function WaveBars({ bars, ticks, width, played = false }: {
  bars: number[];
  ticks: number[];
  width: number;
  played?: boolean;
}) {
  const w = width > 0 ? width : 600;
  const slot = w / Math.max(1, bars.length);
  const barW = Math.max(1, Math.min(slot * 0.62, 6));
  const rx = Math.min(1.5, barW / 2);
  return (
    <svg
      className={['radio-player__bars', played && 'radio-player__bars--played'].filter(Boolean).join(' ')}
      viewBox={`0 0 ${w} ${VIEW_H}`}
      preserveAspectRatio="none"
      aria-hidden
    >
      {bars.map((v, i) => {
        const h = Math.max(2, v * BAR_AREA_H);
        return <rect key={i} x={i * slot + (slot - barW) / 2} y={(BAR_AREA_H - h) / 2} width={barW} height={h} rx={rx} />;
      })}
      {ticks.map((p, i) => (
        <rect key={`t${i}`} className="radio-player__tick" x={p * w - 0.75} y={BAR_AREA_H + TICK_GAP} width={1.5} height={TICK_H} rx={0.75} />
      ))}
    </svg>
  );
});

interface TranscriptListProps {
  cues: TranscriptCue[];
  activeIndex: number;
  reactionIndex: number;
  names: Record<Speaker, string>;
  onSeek: (seconds: number) => void;
  onUserScroll: () => void;
  listRef: React.RefObject<HTMLOListElement | null>;
}

/** Full transcript; re-renders only when the active cue changes. */
const TranscriptList = memo(function TranscriptList({
  cues, activeIndex, reactionIndex, names, onSeek, onUserScroll, listRef,
}: TranscriptListProps) {
  let previousSpeech: TranscriptCue | null = null;
  return (
    <ol
      ref={listRef}
      className="radio-player__cues"
      onWheel={onUserScroll}
      onTouchMove={onUserScroll}
      onPointerDown={onUserScroll}
    >
      {cues.map((cue, i) => {
        const reaction = cue.kind === 'reaction';
        const name = names[cue.speaker];
        const showName = !reaction && (!previousSpeech
          || previousSpeech.speaker !== cue.speaker || previousSpeech.turn_idx !== cue.turn_idx);
        if (!reaction) previousSpeech = cue;
        const current = i === activeIndex;
        return (
          <li key={i} data-cue-index={i}>
            <button
              type="button"
              className={[
                'radio-player__cue',
                reaction && 'radio-player__cue--reaction',
                i === reactionIndex && 'is-reacting',
              ].filter(Boolean).join(' ')}
              aria-current={current ? 'true' : undefined}
              data-testid="radio-cue"
              data-kind={cue.kind}
              onClick={() => onSeek(cue.start)}
            >
              <span className="radio-player__cue-time">{clock(cue.start)}</span>
              <span className="radio-player__cue-body">
                {reaction ? (
                  <span className="radio-player__cue-text">
                    {name} · {cue.text}<span className="sr-only"> (reaction)</span>
                  </span>
                ) : (
                  <>
                    {showName
                      ? <span className="radio-player__cue-name">{name}</span>
                      : <span className="sr-only">{name}: </span>}
                    <span className="radio-player__cue-text">{cue.text}</span>
                  </>
                )}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
});

// ---- Player -------------------------------------------------------------------------

export const RadioPlayer = forwardRef<RadioPlayerHandle, RadioPlayerProps>(function RadioPlayer(props, ref) {
  const {
    src, title, transcript = null, coverUrl = null, hosts, autoPlay = false, initialTime = 0,
    tone = 'light', className, defaultTranscriptOpen = false,
  } = props;

  const uid = useId();
  const transcriptId = `${uid}-transcript`;
  const audioRef = useRef<HTMLAudioElement>(null);
  const waveRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLOListElement>(null);

  // Mutable runtime state read by media / DOM callbacks (kept out of React renders).
  const propsRef = useRef(props);
  const metaRef = useRef({ title, artist: '', cover: coverUrl });
  const mountedRef = useRef(false);
  const ownerToken = useRef<object>({}).current;
  const startAt = Number.isFinite(initialTime) && initialTime > 0 ? initialTime : 0;
  const lastTimeRef = useRef(startAt);
  const durationRef = useRef(0);
  const speedRef = useRef(rememberedSpeed);
  const wantPlayRef = useRef(false);
  const pendingSeekRef = useRef<number | null>(null);
  const resumeRef = useRef<{ time: number } | null>(null);
  const recoveringRef = useRef(false);
  const refreshingRef = useRef(false);
  const lastRefreshAtRef = useRef(0);
  const srcGenRef = useRef(0);
  const scrubRef = useRef<number | null>(null);
  const playingRef = useRef(false);
  const userScrollAtRef = useRef(0);
  const wasOpenRef = useRef(false);

  const [refreshed, setRefreshed] = useState<{ for: string | null; url: string } | null>(null);
  const effectiveSrc = refreshed && refreshed.for === src ? refreshed.url : src;
  const [time, setTime] = useState(startAt);
  const [audioDuration, setAudioDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [needsGesture, setNeedsGesture] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [speed, setSpeed] = useState(rememberedSpeed);
  const [scrubTime, setScrubTime] = useState<number | null>(null);
  const [transcriptOpen, setTranscriptOpen] = useState(defaultTranscriptOpen);
  const [sliderFocused, setSliderFocused] = useState(false);
  const [ariaHeld, setAriaHeld] = useState<number | null>(null);
  const reducedMotion = usePrefersReducedMotion();
  const waveWidth = useElementWidth(waveRef);

  const transcriptDuration = isNum(transcript?.duration_sec) && transcript.duration_sec > 0 ? transcript.duration_sec : 0;
  const duration = audioDuration > 0 ? audioDuration : transcriptDuration;

  const hostI = resolveHost('interviewer', hosts, transcript);
  const hostE = resolveHost('expert', hosts, transcript);
  const hostByRole: Record<Speaker, RadioHost> = { interviewer: hostI, expert: hostE };
  const nameI = hostI.display_name;
  const nameE = hostE.display_name;
  const names = useMemo<Record<Speaker, string>>(() => ({ interviewer: nameI, expert: nameE }), [nameI, nameE]);
  const artist = nameI === nameE ? nameI : `${nameI} & ${nameE}`;

  // Keep the latest props for stable callbacks (declared before the source effect below).
  useLayoutEffect(() => {
    propsRef.current = props;
    metaRef.current = { title, artist, cover: coverUrl };
  });

  // ---- Waveform painting (direct DOM writes; never a React render per frame) ----
  const paint = useCallback(() => {
    const el = waveRef.current;
    if (!el) return;
    const a = audioRef.current;
    const d = durationRef.current;
    const t = scrubRef.current
      ?? (a && !a.paused && !resumeRef.current && pendingSeekRef.current == null ? a.currentTime : lastTimeRef.current);
    const p = d > 0 ? Math.min(1, Math.max(0, t / d)) : 0;
    el.style.setProperty('--rp-progress', String(Math.round(p * 100000) / 100000));
  }, []);

  useLayoutEffect(() => {
    durationRef.current = duration;
    paint();
  }, [duration, time, scrubTime, waveWidth, paint]);

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const loop = () => { paint(); frame = requestAnimationFrame(loop); };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [playing, paint]);

  // ---- Media Session -----------------------------------------------------------------
  const ownsSession = useCallback(() => mediaSessionOwner === ownerToken && hasMediaSession(), [ownerToken]);

  const applyMetadata = useCallback(() => {
    if (!ownsSession() || typeof MediaMetadata === 'undefined') return;
    const meta = metaRef.current;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: meta.title,
        artist: meta.artist,
        album: ALBUM,
        artwork: meta.cover ? [{ src: meta.cover }] : [],
      });
    } catch { /* invalid artwork URL */ }
  }, [ownsSession]);

  const updatePositionState = useCallback(() => {
    const a = audioRef.current;
    if (!a || !ownsSession() || typeof navigator.mediaSession.setPositionState !== 'function') return;
    const d = a.duration;
    if (!Number.isFinite(d) || d <= 0) return;
    try {
      navigator.mediaSession.setPositionState({
        duration: d,
        playbackRate: a.playbackRate > 0 ? a.playbackRate : 1,
        position: Math.min(d, Math.max(0, a.currentTime)),
      });
    } catch { /* inconsistent state while loading */ }
  }, [ownsSession]);

  const setPlayingState = useCallback((next: boolean) => {
    if (playingRef.current === next) return;
    playingRef.current = next;
    setPlaying(next);
    propsRef.current.onPlayStateChange?.(next);
    if (ownsSession()) {
      try { navigator.mediaSession.playbackState = next ? 'playing' : 'paused'; } catch { /* ignore */ }
    }
  }, [ownsSession]);

  // ---- Transport -----------------------------------------------------------------------
  const currentTimeNow = useCallback(() => {
    const a = audioRef.current;
    if (a && a.readyState > 0 && pendingSeekRef.current == null && !resumeRef.current) return a.currentTime;
    return lastTimeRef.current;
  }, []);

  const seekTo = useCallback((seconds: number) => {
    if (!Number.isFinite(seconds)) return;
    const target = clampTime(seconds, durationRef.current);
    const a = audioRef.current;
    lastTimeRef.current = target;
    setTime(target);
    if (resumeRef.current) {
      resumeRef.current = { time: target };
    } else if (!a || a.readyState === 0) {
      pendingSeekRef.current = target;
      propsRef.current.onTimeUpdate?.(target);
    } else {
      try { a.currentTime = target; } catch { pendingSeekRef.current = target; }
    }
    paint();
  }, [paint]);

  const skip = useCallback((delta: number) => {
    if (!audioRef.current?.getAttribute('src')) return;
    seekTo(currentTimeNow() + delta);
  }, [seekTo, currentTimeNow]);

  /** Error recovery: refresh the source (≤ 1/min) or, on explicit retry, reload it once. */
  const recover = useCallback(async (manual: boolean) => {
    const a = audioRef.current;
    if (!a || refreshingRef.current) return;
    const gen = srcGenRef.current;
    const resumeAt = lastTimeRef.current;
    const refresh = propsRef.current.onRefreshSource;
    if (refresh && Date.now() - lastRefreshAtRef.current > REFRESH_MIN_INTERVAL_MS) {
      lastRefreshAtRef.current = Date.now();
      refreshingRef.current = true;
      recoveringRef.current = true;
      setRefreshing(true);
      setErrorMsg(null);
      let next: string | null = null;
      try { next = await refresh(); } catch { next = null; }
      refreshingRef.current = false;
      if (!mountedRef.current || gen !== srcGenRef.current) return;
      setRefreshing(false);
      if (next) {
        resumeRef.current = { time: resumeAt };
        lastTimeRef.current = resumeAt;
        if (next === a.getAttribute('src')) a.load();
        else setRefreshed({ for: propsRef.current.src ?? null, url: next });
        return;
      }
    } else if (manual && a.getAttribute('src')) {
      recoveringRef.current = true;
      resumeRef.current = { time: resumeAt };
      setErrorMsg(null);
      a.load();
      return;
    }
    recoveringRef.current = false;
    resumeRef.current = null;
    if (!a.paused) a.pause();
    setBuffering(false);
    setErrorMsg(UNAVAILABLE);
  }, []);

  const requestPlay = useCallback(async (): Promise<void> => {
    const a = audioRef.current;
    if (!a || !a.getAttribute('src')) return;
    wantPlayRef.current = true;
    if (refreshingRef.current) return; // resumes once the fresh source has loaded
    if (a.error && a.error.code !== 1) { await recover(true); return; }
    try {
      await a.play();
    } catch (e) {
      const name = (e as { name?: string } | null)?.name;
      if (name === 'NotAllowedError') {
        wantPlayRef.current = false;
        if (mountedRef.current) setNeedsGesture(true);
      }
      // AbortError: interrupted by pause() or a new source. NotSupportedError: the media
      // `error` event drives the recovery.
    }
  }, [recover]);

  const pauseNow = useCallback(() => {
    wantPlayRef.current = false;
    setNeedsGesture(false);
    audioRef.current?.pause();
  }, []);

  const togglePlay = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) void requestPlay();
    else pauseNow();
  }, [requestPlay, pauseNow]);

  const claimMediaSession = useCallback(() => {
    if (!hasMediaSession()) return;
    mediaSessionOwner = ownerToken;
    applyMetadata();
    const session = navigator.mediaSession;
    const handlers: Array<[MediaSessionAction, MediaSessionActionHandler]> = [
      ['play', () => { void requestPlay(); }],
      ['pause', () => pauseNow()],
      ['seekbackward', (d) => skip(-(d.seekOffset || SKIP_SEC))],
      ['seekforward', (d) => skip(d.seekOffset || SKIP_SEC)],
      ['seekto', (d) => { if (typeof d.seekTime === 'number') seekTo(d.seekTime); }],
    ];
    for (const [action, handler] of handlers) {
      try { session.setActionHandler(action, handler); } catch { /* action not supported */ }
    }
  }, [ownerToken, applyMetadata, requestPlay, pauseNow, skip, seekTo]);

  const releaseMediaSession = useCallback(() => {
    if (mediaSessionOwner !== ownerToken || !hasMediaSession()) return;
    mediaSessionOwner = null;
    const session = navigator.mediaSession;
    for (const action of MEDIA_ACTIONS) {
      try { session.setActionHandler(action, null); } catch { /* ignore */ }
    }
    try {
      session.metadata = null;
      session.playbackState = 'none';
    } catch { /* ignore */ }
  }, [ownerToken]);

  useImperativeHandle(ref, () => ({
    play: () => requestPlay(),
    pause: () => pauseNow(),
    seek: (seconds: number) => seekTo(seconds),
    getCurrentTime: () => currentTimeNow(),
    getDuration: () => durationRef.current,
  }), [requestPlay, pauseNow, seekTo, currentTimeNow]);

  // ---- Lifecycle -----------------------------------------------------------------------
  // New source from the parent: reset position/state, apply `initialTime`, try autoplay.
  useLayoutEffect(() => {
    srcGenRef.current += 1;
    resumeRef.current = null;
    recoveringRef.current = false;
    refreshingRef.current = false;
    wantPlayRef.current = false;
    pendingSeekRef.current = startAt > 0 ? startAt : null;
    lastTimeRef.current = startAt;
    setTime(startAt);
    setAudioDuration(0);
    setRefreshing(false);
    setErrorMsg(null);
    setNeedsGesture(false);
    setBuffering(false);
    const a = audioRef.current;
    if (!src) {
      if (a) { a.pause(); a.load(); }
      return;
    }
    if (autoPlay) void requestPlay();
    // Only a new `src` restarts the episode; `initialTime`/`autoPlay` are read at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  useEffect(() => {
    speedRef.current = speed;
    const a = audioRef.current;
    if (!a) return;
    a.defaultPlaybackRate = speed;
    a.playbackRate = speed;
  }, [speed]);

  useEffect(() => { applyMetadata(); }, [title, artist, coverUrl, applyMetadata]);

  useEffect(() => {
    mountedRef.current = true;
    const a = audioRef.current;
    return () => {
      mountedRef.current = false;
      a?.pause();
      releaseMediaSession();
    };
  }, [releaseMediaSession]);

  // ---- Media element events --------------------------------------------------------------
  const onAudioPlay = () => {
    wantPlayRef.current = true;
    setNeedsGesture(false);
    claimMediaSession();
    setPlayingState(true);
    updatePositionState();
  };

  const onAudioPause = () => {
    const a = audioRef.current;
    if (a && !a.error && !recoveringRef.current) wantPlayRef.current = false;
    setBuffering(false);
    setPlayingState(false);
    updatePositionState();
  };

  const onAudioEnded = () => {
    const a = audioRef.current;
    wantPlayRef.current = false;
    setBuffering(false);
    setPlayingState(false);
    if (a) {
      lastTimeRef.current = a.currentTime;
      setTime(a.currentTime);
    }
  };

  const onAudioEmptied = () => {
    setBuffering(false);
    setPlayingState(!(audioRef.current?.paused ?? true));
  };

  const onAudioTimeUpdate = () => {
    const a = audioRef.current;
    if (!a || resumeRef.current || (pendingSeekRef.current != null && a.readyState === 0)) return;
    const t = a.currentTime;
    lastTimeRef.current = t;
    setTime(t);
    propsRef.current.onTimeUpdate?.(t);
  };

  const onAudioSeek = () => {
    const a = audioRef.current;
    if (!a || resumeRef.current || a.readyState === 0) return;
    lastTimeRef.current = a.currentTime;
    setTime(a.currentTime);
    updatePositionState();
  };

  const onAudioDurationChange = () => {
    const a = audioRef.current;
    if (!a) return;
    const d = Number.isFinite(a.duration) && a.duration > 0 ? a.duration : 0;
    if (d === 0 && resumeRef.current) return; // keep the timeline steady while a fresh source loads
    setAudioDuration(d);
  };

  const onAudioLoadedMetadata = () => {
    const a = audioRef.current;
    if (!a) return;
    a.defaultPlaybackRate = speedRef.current;
    a.playbackRate = speedRef.current;
    const d = Number.isFinite(a.duration) && a.duration > 0 ? a.duration : 0;
    setAudioDuration(d);
    if (d > 0) durationRef.current = d;
    const target = resumeRef.current ? resumeRef.current.time : pendingSeekRef.current;
    resumeRef.current = null;
    pendingSeekRef.current = null;
    if (target != null && target > 0) {
      try { a.currentTime = clampTime(target, d); } catch { /* not seekable */ }
    }
    lastTimeRef.current = a.currentTime;
    setTime(a.currentTime);
    setErrorMsg(null);
    const recovering = recoveringRef.current;
    recoveringRef.current = false;
    if (recovering && wantPlayRef.current && a.paused) void requestPlay();
    updatePositionState();
  };

  const onAudioWaiting = () => {
    if (audioRef.current && !audioRef.current.paused) setBuffering(true);
  };

  const onAudioPlaying = () => {
    setBuffering(false);
    setErrorMsg(null);
  };

  const onAudioError = () => {
    const err = audioRef.current?.error;
    if (!err || err.code === 1) return; // MEDIA_ERR_ABORTED: superseded load
    setBuffering(false);
    void recover(false);
  };

  // ---- Derived playback view -------------------------------------------------------------
  const prepared = useMemo(() => prepareTranscript(transcript), [transcript]);
  const { cues, speech, speechStarts, reactions, reactionStarts, turns, turnStarts } = prepared;
  const hasCues = cues.length > 0;

  const si = lastAtOrBefore(speechStarts, time);
  const captionIdx = si >= 0 && time <= cues[speech[si]].end + CAPTION_HOLD_SEC ? speech[si] : -1;
  const captionCue = captionIdx >= 0 ? cues[captionIdx] : null;
  const ri = lastAtOrBefore(reactionStarts, time);
  const lastReaction = ri >= 0 ? cues[reactions[ri]] : null;
  const reactionIdx = lastReaction && time < Math.max(lastReaction.end, lastReaction.start + REACTION_MIN_SEC)
    ? reactions[ri] : -1;
  const ti = lastAtOrBefore(turnStarts, time);
  const turn = ti >= 0 && time < turns[ti].end + TURN_HOLD_SEC ? turns[ti] : null;
  const voice: Speaker | null = turn ? turn.speaker : (turns.length === 0 && captionCue ? captionCue.speaker : null);
  const speaking = playing ? voice : null;
  const reacting = playing && reactionIdx >= 0 ? cues[reactionIdx].speaker : null;

  const peakCount = prepared.peaks.length;
  const barCount = waveWidth > 0
    ? (peakCount > 0 ? Math.min(peakCount, Math.max(24, Math.floor(waveWidth / 4))) : Math.max(24, Math.floor(waveWidth / 6)))
    : (peakCount > 0 ? Math.min(peakCount, 160) : 96);
  const bars = useMemo(() => buildBars(prepared.peaks, barCount), [prepared.peaks, barCount]);
  const ticks = useMemo(
    () => (duration > 0 ? turns.map((t) => t.start / duration).filter((p) => p > 0.001 && p < 0.999) : NO_TICKS),
    [turns, duration],
  );

  const canSeek = !!effectiveSrc && duration > 0;
  const shownTime = scrubTime ?? time;
  /** Whole seconds shown to users: floored, except the last instant snaps to the (rounded) total. */
  const wholeSeconds = (t: number) => (duration > 0 && t >= duration - 0.25 ? Math.round(duration) : Math.floor(t + 0.001));
  const totalText = duration > 0 ? clock(Math.round(duration)) : '--:--';
  const elapsedText = clock(wholeSeconds(shownTime));
  const ariaMax = Math.max(0, Math.round(duration));
  // While playing with the slider focused, hold its value (no per-second announcements).
  const ariaSource = playing && sliderFocused && ariaHeld != null && scrubTime == null ? ariaHeld : shownTime;
  const ariaNow = Math.min(ariaMax, Math.max(0, wholeSeconds(ariaSource)));

  const state = !effectiveSrc ? 'unavailable'
    : errorMsg ? 'error'
      : refreshing ? 'refreshing'
        : needsGesture ? 'press-play'
          : playing ? (buffering ? 'buffering' : 'playing')
            : time > 0.05 ? 'paused' : 'idle';

  let status: string;
  switch (state) {
    case 'unavailable':
    case 'error': status = 'Audio unavailable'; break;
    case 'refreshing': status = 'Reconnecting…'; break;
    case 'press-play': status = 'Press play to start listening'; break;
    case 'buffering': status = 'Loading…'; break;
    case 'playing':
      if (speaking) status = `${names[speaking]} is speaking`;
      else if (turns.length > 0 && time < turns[0].start) status = 'Intro';
      else if (turns.length > 0 && time >= turns[turns.length - 1].end) status = 'Outro';
      else status = 'Playing';
      break;
    case 'paused': status = 'Paused'; break;
    default: status = 'Ready to play';
  }

  // ---- Transcript auto-follow --------------------------------------------------------------
  const onCueSeek = useCallback((seconds: number) => {
    seekTo(seconds);
    if (audioRef.current?.paused) void requestPlay();
  }, [seekTo, requestPlay]);

  const onUserScroll = useCallback(() => { userScrollAtRef.current = Date.now(); }, []);

  useEffect(() => {
    const justOpened = transcriptOpen && !wasOpenRef.current;
    wasOpenRef.current = transcriptOpen;
    if (!transcriptOpen || reducedMotion || captionIdx < 0) return;
    const list = listRef.current;
    if (!list || list.scrollHeight <= list.clientHeight) return;
    if (!justOpened && (Date.now() - userScrollAtRef.current < USER_SCROLL_GRACE_MS || hasKeyboardFocusWithin(list))) return;
    const item = list.querySelector<HTMLElement>(`[data-cue-index="${captionIdx}"]`);
    if (!item) return;
    const top = item.offsetTop - (list.clientHeight - item.offsetHeight) / 2;
    list.scrollTo({ top: Math.max(0, top), behavior: justOpened ? 'auto' : 'smooth' });
  }, [captionIdx, transcriptOpen, reducedMotion]);

  // ---- Input handlers ------------------------------------------------------------------------
  const onRootKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || isTypingTarget(e.target)) return;
    if (e.key === ' ' || e.key === 'Spacebar') {
      if (activatesOnSpace(e.target)) return;
      e.preventDefault();
      if (!e.repeat) togglePlay();
      return;
    }
    switch (e.key.toLowerCase()) {
      case 'k':
        e.preventDefault();
        if (!e.repeat) togglePlay();
        break;
      case 'j':
        e.preventDefault();
        skip(-SKIP_SEC);
        break;
      case 'l':
        e.preventDefault();
        skip(SKIP_SEC);
        break;
      default:
        break;
    }
  };

  const seekFromSlider = (target: number) => {
    const t = clampTime(target, durationRef.current);
    seekTo(t);
    setAriaHeld(t);
  };

  const onSliderKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const d = durationRef.current;
    const now = scrubRef.current ?? currentTimeNow();
    let next: number | null;
    switch (e.key) {
      case 'ArrowLeft':
      case 'ArrowDown': next = now - ARROW_STEP_SEC; break;
      case 'ArrowRight':
      case 'ArrowUp': next = now + ARROW_STEP_SEC; break;
      case 'PageDown': next = now - PAGE_STEP_SEC; break;
      case 'PageUp': next = now + PAGE_STEP_SEC; break;
      case 'Home': next = 0; break;
      case 'End': next = d; break;
      default: return;
    }
    e.preventDefault();
    if (canSeek) seekFromSlider(next);
  };

  const timeAtClientX = (clientX: number): number => {
    const el = waveRef.current;
    const d = durationRef.current;
    if (!el || d <= 0) return 0;
    const rect = el.getBoundingClientRect();
    const p = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
    return Math.min(1, Math.max(0, p)) * d;
  };

  const onWavePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!canSeek || (e.pointerType === 'mouse' && e.button !== 0)) return;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* unsupported */ }
    const t = timeAtClientX(e.clientX);
    scrubRef.current = t;
    setScrubTime(t);
  };

  const onWavePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (scrubRef.current == null) return;
    const t = timeAtClientX(e.clientX);
    scrubRef.current = t;
    setScrubTime(t);
  };

  const endScrub = (commit: boolean) => {
    const t = scrubRef.current;
    if (t == null) return;
    scrubRef.current = null;
    setScrubTime(null);
    if (commit) seekFromSlider(t);
    else paint();
  };

  const onSpeedChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const v = Number(e.target.value);
    if (!SPEEDS.includes(v)) return;
    rememberedSpeed = v;
    setSpeed(v);
  };

  const retry = () => {
    wantPlayRef.current = true;
    setErrorMsg(null);
    void recover(true);
  };

  const disabled = !effectiveSrc;

  return (
    <div
      className={['radio-player', `radio-player--${tone}`, playing && 'is-playing', className].filter(Boolean).join(' ')}
      role="region"
      aria-label={`Audio player: ${title}`}
      tabIndex={-1}
      data-testid="radio-player"
      data-state={state}
      onKeyDown={onRootKeyDown}
    >
      <audio
        ref={audioRef}
        src={effectiveSrc || undefined}
        preload="metadata"
        data-testid="radio-audio"
        onPlay={onAudioPlay}
        onPause={onAudioPause}
        onEnded={onAudioEnded}
        onEmptied={onAudioEmptied}
        onTimeUpdate={onAudioTimeUpdate}
        onSeeking={onAudioSeek}
        onSeeked={onAudioSeek}
        onDurationChange={onAudioDurationChange}
        onLoadedMetadata={onAudioLoadedMetadata}
        onWaiting={onAudioWaiting}
        onPlaying={onAudioPlaying}
        onRateChange={updatePositionState}
        onError={onAudioError}
      />

      <div className="radio-player__head">
        <CoverArt url={coverUrl} />
        <div className="radio-player__meta">
          <p className="eyebrow radio-player__eyebrow"><Headphones aria-hidden />Podcast</p>
          <p className="radio-player__title">{title}</p>
          <ul className="radio-player__hosts" aria-label="Hosts">
            {ROLES.map((role) => {
              const host = hostByRole[role];
              const isSpeaking = speaking === role;
              const isReacting = reacting === role;
              return (
                <li
                  key={role}
                  className={['radio-player__host', isSpeaking && 'is-speaking', isReacting && 'is-reacting'].filter(Boolean).join(' ')}
                  data-testid={`radio-host-${role}`}
                  data-speaking={isSpeaking ? 'true' : 'false'}
                  data-reacting={isReacting ? 'true' : 'false'}
                >
                  <HostDisc host={host} size={64} speaking={isSpeaking} tone={role === 'expert' ? 'sand' : 'sage'} label="" />
                  <span className="radio-player__host-text">
                    <span className="radio-player__host-name">
                      {host.display_name}
                      {isSpeaking && <AudioLines className="radio-player__host-icon" aria-hidden />}
                    </span>
                    <span className="radio-player__host-role">{ROLE_LABEL[role]}</span>
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="radio-player__speaker" data-testid="radio-speaker">
            {(state === 'buffering' || state === 'refreshing') && <span className="spinner" aria-hidden />}
            {status}
          </p>
        </div>
      </div>

      {hasCues && (
        <div className="radio-player__caption">
          <p className="radio-player__caption-live" aria-live="polite" aria-atomic="true" data-testid="radio-caption">
            {captionCue && (
              <>
                <span className="radio-player__caption-name">{names[captionCue.speaker]}:</span>
                {' '}
                <span className="radio-player__caption-text">{captionCue.text}</span>
              </>
            )}
          </p>
          {!captionCue && <p className="radio-player__caption-hint" aria-hidden>Live captions appear here.</p>}
        </div>
      )}

      <div className="radio-player__seek">
        <div
          ref={waveRef}
          className="radio-player__wave"
          role="slider"
          tabIndex={0}
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={ariaMax}
          aria-valuenow={ariaNow}
          aria-valuetext={`${clock(ariaNow)} of ${clock(ariaMax)}`}
          aria-disabled={canSeek ? undefined : true}
          data-testid="radio-waveform"
          onKeyDown={onSliderKeyDown}
          onPointerDown={onWavePointerDown}
          onPointerMove={onWavePointerMove}
          onPointerUp={() => endScrub(true)}
          onPointerCancel={() => endScrub(false)}
          onLostPointerCapture={() => endScrub(true)}
          onFocus={() => { setSliderFocused(true); setAriaHeld(currentTimeNow()); }}
          onBlur={() => { setSliderFocused(false); setAriaHeld(null); }}
        >
          <WaveBars bars={bars} ticks={ticks} width={waveWidth} />
          <WaveBars bars={bars} ticks={NO_TICKS} width={waveWidth} played />
          <span className="radio-player__playhead" aria-hidden />
        </div>
        <div className="radio-player__timeline">
          <span className="radio-player__time" data-testid="radio-time">{elapsedText} / {totalText}</span>
          <span className={['radio-player__onair', playing && 'is-on'].filter(Boolean).join(' ')} aria-hidden={playing ? undefined : true}>
            <Waveform active={playing && !reducedMotion} />
            <LivePill idle={!playing}>Playing</LivePill>
          </span>
        </div>
      </div>

      <div className="radio-player__transport">
        <div className="radio-player__buttons" role="group" aria-label="Playback">
          <Button
            className="radio-player__skip"
            icon={RotateCcw}
            aria-label={`Back ${SKIP_SEC} seconds`}
            aria-keyshortcuts="J"
            data-testid="radio-back"
            disabled={disabled}
            onClick={() => skip(-SKIP_SEC)}
          >
            {SKIP_SEC}
          </Button>
          <Button
            variant="primary"
            size="lg"
            iconOnly
            className={['radio-player__play', needsGesture && 'is-attention'].filter(Boolean).join(' ')}
            icon={playing ? Pause : Play}
            aria-label={playing ? 'Pause' : 'Play'}
            aria-keyshortcuts="K"
            data-testid="radio-play"
            disabled={disabled}
            onClick={togglePlay}
          />
          <Button
            className="radio-player__skip"
            iconRight={RotateCw}
            aria-label={`Forward ${SKIP_SEC} seconds`}
            aria-keyshortcuts="L"
            data-testid="radio-forward"
            disabled={disabled}
            onClick={() => skip(SKIP_SEC)}
          >
            {SKIP_SEC}
          </Button>
        </div>
        <Field label="Speed" inline className="radio-player__speed">
          <Select data-testid="radio-speed" value={String(speed)} onChange={onSpeedChange}>
            {SPEEDS.map((s) => <option key={s} value={String(s)}>{`${s}×`}</option>)}
          </Select>
        </Field>
        <p className="radio-player__note" data-testid="radio-ai-note"><Sparkles aria-hidden />AI-generated voices</p>
      </div>

      {errorMsg && (
        <Alert tone="error" className="radio-player__error" data-testid="radio-error">
          {errorMsg}{' '}
          <Button variant="link" onClick={retry}>Try again</Button>
        </Alert>
      )}

      {hasCues && (
        <div className="radio-player__transcript-section">
          <Button
            variant="ghost"
            icon={ScrollText}
            iconRight={ChevronDown}
            className="radio-player__transcript-toggle"
            aria-expanded={transcriptOpen}
            aria-controls={transcriptId}
            data-testid="radio-transcript-toggle"
            onClick={() => setTranscriptOpen((open) => !open)}
          >
            Transcript
          </Button>
          <div id={transcriptId} className="radio-player__transcript" data-testid="radio-transcript" hidden={!transcriptOpen}>
            {transcriptOpen && (
              <TranscriptList
                cues={cues}
                activeIndex={captionIdx}
                reactionIndex={reactionIdx}
                names={names}
                onSeek={onCueSeek}
                onUserScroll={onUserScroll}
                listRef={listRef}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
});

export default RadioPlayer;
