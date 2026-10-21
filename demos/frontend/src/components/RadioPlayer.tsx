/**
 * RadioPlayer — the "Listen" experience for Oz Radio podcasts.
 *
 * Accessible custom controls around a native <audio preload="metadata"> (no
 * native controls): cover art, both hosts lit from the radio transcript (glow on
 * backchannel cues), the current speaker as text, a visible caption that only
 * changes with the cue (not announced: it would duplicate the audio for screen-reader
 * users, who have the transcript on demand), a collapsible click-to-seek transcript
 * (one block per speaker turn, the cues flowing as sentences),
 * a seekable peaks waveform (role="slider", turn ticks), ±15 s, speed, keyboard
 * shortcuts (Space/K, J/L), Media Session (through playback/mediaSession.ts),
 * autoplay-rejection handling and SAS-expiry recovery (at most one automatic source refresh
 * per minute and per episode; "Try again" always fetches a fresh source; position and play
 * state are restored). Parents drive it through the imperative handle (Watch ↔ Listen).
 *
 * Language and level: `language` (BCP-47) marks the title, caption and transcript with their
 * own `lang` (WCAG 3.1.2) and picks the host role labels ("Journaliste" for French); `level`
 * shows the audience level in the header. State changes (loading, reconnecting, autoplay
 * refused, paused) are announced through one polite `role="status"` region — the per-speaker
 * status line and the captions are not.
 *
 * Works standalone (creator page) and as the app's persistent root player
 * (playback/PlaybackProvider): there it is never remounted per episode — `episodeKey`
 * marks a new episode on the same <audio> element, `parked` stops the playhead's paint
 * loop while it is off screen, `onEnded` runs inside the media `ended` event.
 * Styles: styles/shared/radio-player.css — tone "stage" (dark modal) or "light"
 * (studio card).
 */
import React, {
  Fragment, forwardRef, memo, useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState,
} from 'react';
import {
  AudioLines, ChevronDown, Headphones, Pause, Play, Radio as RadioIcon, RotateCcw, RotateCw, ScrollText, Sparkles,
} from 'lucide-react';
import type { PodcastHost, Speaker, Transcript, TranscriptCue, TranscriptTurn } from '../services/podcast';
import {
  Alert, Button, Chip, Field, HostDisc, LivePill, Select, Waveform,
  isFrench, langAttr, languageName, levelLabel, loadErrorMessage,
} from '../ui';
import { useTransitionAnnouncement } from '../playback/announce';
import {
  claimMediaSession, isMediaSessionOwner, releaseMediaSession, setMediaPositionState, updateMediaSession,
  type MediaMetadataInit, type MediaSessionHandlers,
} from '../playback/mediaSession';
import { progressStore } from '../playback/progress';
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
  /** Start position in seconds, applied whenever a new `src` / `episodeKey` loads (use the handle to seek later). */
  initialTime?: number;
  /** 'stage' = dark modal player, 'light' = studio card (default). */
  tone?: 'stage' | 'light';
  /**
   * Episode identity, distinct from `src`. A new key fully resets the episode (position,
   * SAS-refresh throttle, scrubbing, "Press play", late events of the previous source) on the
   * SAME <audio> element. Renewing the same episode's URL must go through `onRefreshSource`,
   * never through `src`. Omitted: `src` is the identity (standalone use).
   */
  episodeKey?: string;
  /** Off screen (parked by the playback provider): stops the playhead's requestAnimationFrame loop only. */
  parked?: boolean;
  /** Returns a fresh source after a media error (expired SAS). Called at most once per minute per episode. */
  onRefreshSource?: () => Promise<string | null>;
  /** Media `timeupdate` (≈ 4 Hz) and seeks applied before the media is ready, with the episode key. */
  onTimeUpdate?: (t: number, episodeKey: string | undefined) => void;
  onPlayStateChange?: (playing: boolean, episodeKey: string | undefined) => void;
  /** Called synchronously inside the media `ended` event (after the player's own updates). */
  onEnded?: (episodeKey: string | undefined) => void;
  /** Player state + the status line shown under the hosts (e.g. for a mini-player). */
  onStatusChange?: (status: RadioStatus) => void;
  /** Extra OS media actions (lock screen / earbuds), e.g. `nexttrack` / `previoustrack`. */
  extraMediaActions?: RadioMediaActions;
  className?: string;
  /** Show the full transcript expanded initially (default: collapsed). */
  defaultTranscriptOpen?: boolean;
  /**
   * Language of the episode (BCP-47, e.g. "fr-FR"): sets `lang` on the title, caption and transcript, and
   * localises the host role labels. Omitted: the document language applies and the labels stay English.
   */
  language?: string | null;
  /** Audience level (`audience_level` of the library DTOs): shown as a chip in the header; nothing for null or an unknown value. */
  level?: string | null;
  /** Load the cover image only once the episode has played (slow connections: the audio gets the bandwidth first). */
  deferCover?: boolean;
}

export type RadioState =
  'unavailable' | 'error' | 'refreshing' | 'press-play' | 'buffering' | 'playing' | 'paused' | 'idle';

export interface RadioStatus {
  state: RadioState;
  /** Visible status text ("Lucas is speaking", "Paused", "Press play to start listening"…). */
  text: string;
  /** Display name of the host speaking now, while playing. */
  speaker: string | null;
}

export type RadioMediaActions = Partial<Record<'nexttrack' | 'previoustrack' | 'stop', () => void>>;

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
/** Same wording as the French renders ("Journaliste" / "Expert", services/podcast_compose.py). */
const ROLE_LABEL_FR: Record<Speaker, string> = { interviewer: 'Journaliste', expert: 'Expert' };
const roleLabels = (language: string | null | undefined): Record<Speaker, string> => (isFrench(language) ? ROLE_LABEL_FR : ROLE_LABEL);
const ALBUM = 'Oz Radio';
const UNAVAILABLE = 'Audio unavailable — the link expired or the connection dropped.';
/** Offline wording shared with every other load failure (ui/format.ts `loadErrorMessage`). */
const OFFLINE = loadErrorMessage('Failed to fetch');
/** What the polite status region says for a state ("playing" and "idle" say nothing). */
const ANNOUNCEMENTS: Partial<Record<RadioState, string>> = {
  buffering: 'Loading…',
  refreshing: 'Reconnecting…',
  'press-play': 'Your browser blocked autoplay. Press play to start listening.',
  paused: 'Paused',
};
/** The sticky dock's height, published on <html> for the phone sheet's scroll-padding (library.css). */
const DOCK_HEIGHT_VAR = '--rp-dock-h';

// Waveform geometry (SVG user units = CSS px once the width is measured).
const BAR_AREA_H = 46;
const TICK_GAP = 4;
const TICK_H = 6;
const VIEW_H = BAR_AREA_H + TICK_GAP + TICK_H;
const FLAT_LEVEL = 0.22;
const NO_TICKS: number[] = [];

/** Playback speed survives source changes and remounts within the page session. */
let rememberedSpeed = 1;

/** Initial speed: the saved preference (playback/progress), else this session's choice. */
function initialSpeed(): number {
  let saved: number | null = null;
  try { saved = progressStore.getSpeed(); } catch { saved = null; }
  return saved != null && SPEEDS.includes(saved) ? saved : rememberedSpeed;
}

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

function resolveHost(
  role: Speaker,
  hosts: RadioHost[] | null | undefined,
  transcript: Transcript | null | undefined,
  labels: Record<Speaker, string> = ROLE_LABEL,
): RadioHost {
  const fromProps = Array.isArray(hosts) ? hosts.find((h) => h?.role === role) : undefined;
  const fromTranscript = Array.isArray(transcript?.hosts) ? transcript.hosts.find((h) => h?.role === role) : undefined;
  return {
    role,
    display_name: fromProps?.display_name?.trim() || fromTranscript?.display_name?.trim() || labels[role],
    thumbnail_url: fromProps?.thumbnail_url ?? null,
  };
}

/**
 * Builds the `hosts` prop: names from the transcript / library `hosts` (by role) and
 * portraits from the avatar catalog (`useAvatars()`) by `avatar_id`. An explicit
 * `avatar_id: null` means "no portrait" (monogram, e.g. audio-only). Without a host
 * entry (legacy items) the name comes from `fallbackNames` (interviewer first, e.g.
 * `speaker_names`) and the portrait from a catalog entry with the same display name;
 * without any name the role label is used ("Journaliste" for a French `language`).
 */
export function toRadioHosts(
  hosts: readonly PodcastHost[] | null | undefined,
  avatars: readonly RadioAvatarLike[] = [],
  fallbackNames: readonly (string | null | undefined)[] = [],
  language?: string | null,
): RadioHost[] {
  const labels = roleLabels(language);
  return ROLES.map((role, i) => {
    const host = hosts?.find((h) => h?.role === role);
    const name = host?.display_name?.trim() || fallbackNames[i]?.trim() || labels[role];
    let avatar: RadioAvatarLike | undefined;
    if (host?.avatar_id) avatar = avatars.find((a) => a.id === host.avatar_id);
    else if (host?.avatar_id !== null) avatar = avatars.find((a) => a.display_name?.trim() === name);
    return { role, display_name: name, thumbnail_url: avatar?.thumbnail_url ?? null };
  });
}

/** A language's name in its own words, marked with its own `lang` ("Français" is French text in an English page). */
export function LanguageName({ code }: { code: string | null | undefined }) {
  const name = languageName(code);
  return <span lang={code && name !== code ? langAttr(code) : undefined}>{name}</span>;
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
    // 0 = not rendered (e.g. parked off screen): keep the last real width until it shows again.
    const measure = (w: number) => {
      if (w > 0) setWidth((prev) => (Math.abs(prev - w) < 1 ? prev : Math.round(w)));
    };
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

/**
 * The phone sheet pins the transport (the dock) to the bottom edge of its scroll container, over the transcript. Its
 * height is published on <html> so `library.css` can use it as `scroll-padding-bottom`: a cue (or any control) that
 * takes keyboard focus scrolls clear of the dock instead of staying hidden behind it (WCAG 2.4.11). 0 when the dock
 * is not sticky (desktop, light card) or not rendered (parked off screen).
 */
function usePublishedDockHeight(dockRef: React.RefObject<HTMLElement | null>, enabled: boolean) {
  useLayoutEffect(() => {
    const dock = dockRef.current;
    if (!enabled || !dock) return undefined;
    const root = document.documentElement;
    const publish = () => {
      const sticky = getComputedStyle(dock).position === 'sticky';
      root.style.setProperty(DOCK_HEIGHT_VAR, `${sticky ? Math.ceil(dock.getBoundingClientRect().height) : 0}px`);
    };
    publish();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(publish);
    observer?.observe(dock);
    window.addEventListener('resize', publish);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', publish);
      root.style.removeProperty(DOCK_HEIGHT_VAR);
    };
  }, [dockRef, enabled]);
}

// ---- Presentational pieces ---------------------------------------------------------

function CoverArt({ url, onNaturalSize }: { url: string | null; onNaturalSize?: (size: string | null) => void }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const showImage = !!url && failedUrl !== url;
  return (
    <div className="radio-player__cover" data-testid="radio-cover" data-cover={showImage ? 'image' : 'placeholder'}>
      {showImage ? (
        <img
          src={url}
          alt=""
          decoding="async"
          draggable={false}
          onLoad={(e) => {
            const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
            onNaturalSize?.(w > 0 && h > 0 ? `${w}x${h}` : null);
          }}
          onError={() => setFailedUrl(url)}
        />
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
  /** `lang` of the cue texts (the episode's language). */
  lang?: string;
  /** Screen-reader suffix of a backchannel cue, in the transcript's language. */
  reactionLabel: string;
}

interface TranscriptGroup {
  speaker: Speaker;
  /** Indexes (into the cue list) of the cues of this turn, backchannels included. */
  indexes: number[];
}

/**
 * Groups the cues into speaker turns: a speech cue of another speaker (or another script turn) opens a new turn;
 * a backchannel stays inside the turn it interrupts.
 */
function groupTurns(cues: TranscriptCue[]): TranscriptGroup[] {
  const groups: TranscriptGroup[] = [];
  let key = '';
  cues.forEach((cue, i) => {
    const last = groups[groups.length - 1];
    if (cue.kind === 'reaction' && last) {
      last.indexes.push(i);
      return;
    }
    const cueKey = `${cue.speaker}:${cue.turn_idx}`;
    if (last && cueKey === key) {
      last.indexes.push(i);
      return;
    }
    key = cueKey;
    groups.push({ speaker: cue.speaker, indexes: [i] });
  });
  return groups;
}

/**
 * Full transcript, one block per speaker turn: the speaker and the start time are shown (and announced) once, and the
 * turn's cues flow as one paragraph of inline buttons, each still a click-to-seek target and tab stop.
 * Re-renders only when the active cue changes.
 */
const TranscriptList = memo(function TranscriptList({
  cues, activeIndex, reactionIndex, names, onSeek, onUserScroll, listRef, lang, reactionLabel,
}: TranscriptListProps) {
  const groups = useMemo(() => groupTurns(cues), [cues]);
  return (
    <ol
      ref={listRef}
      className="radio-player__cues"
      lang={lang}
      onWheel={onUserScroll}
      onTouchMove={onUserScroll}
      onPointerDown={onUserScroll}
    >
      {groups.map((group) => {
        const first = group.indexes[0];
        return (
          <li key={first} className="radio-player__turn" data-testid="radio-turn" data-turn-index={cues[first].turn_idx}>
            <div className="radio-player__turn-head">
              <span className="radio-player__cue-name" data-testid="radio-turn-speaker">{names[group.speaker]}</span>
              <span className="radio-player__cue-time">{clock(cues[first].start)}</span>
            </div>
            <p className="radio-player__turn-text">
              {group.indexes.map((i) => {
                const cue = cues[i];
                const reaction = cue.kind === 'reaction';
                return (
                  <Fragment key={i}>
                    {i !== first && ' '}
                    {/* A span, not a <button>: buttons are inline-block and cannot wrap with the sentence. */}
                    <span
                      role="button"
                      tabIndex={0}
                      className={[
                        'radio-player__cue',
                        reaction && 'radio-player__cue--reaction',
                        i === reactionIndex && 'is-reacting',
                      ].filter(Boolean).join(' ')}
                      aria-current={i === activeIndex ? 'true' : undefined}
                      data-testid="radio-cue"
                      data-kind={cue.kind}
                      data-cue-index={i}
                      onClick={() => onSeek(cue.start)}
                      onKeyDown={(e) => {
                        if (e.key !== 'Enter' && e.key !== ' ') return;
                        e.preventDefault();
                        e.stopPropagation();
                        onSeek(cue.start);
                      }}
                    >
                      {reaction
                        ? <>{names[cue.speaker]} · {cue.text}<span className="sr-only">{reactionLabel}</span></>
                        : cue.text}
                    </span>
                  </Fragment>
                );
              })}
            </p>
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
    tone = 'light', className, defaultTranscriptOpen = false, episodeKey, parked = false, extraMediaActions,
    language = null, level = null, deferCover = false,
  } = props;

  const uid = useId();
  const transcriptId = `${uid}-transcript`;
  const audioRef = useRef<HTMLAudioElement>(null);
  const waveRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLOListElement>(null);

  // Mutable runtime state read by media / DOM callbacks (kept out of React renders).
  const propsRef = useRef(props);
  const metaRef = useRef<{ title: string; artist: string; cover: string | null; coverSize: string | null }>({
    title, artist: '', cover: coverUrl, coverSize: null,
  });
  const mountedRef = useRef(false);
  const startAt = Number.isFinite(initialTime) && initialTime > 0 ? initialTime : 0;
  const lastTimeRef = useRef(startAt);
  const durationRef = useRef(0);
  const [speed, setSpeed] = useState(initialSpeed);
  const speedRef = useRef(speed);
  const wantPlayRef = useRef(false);
  const pendingSeekRef = useRef<number | null>(null);
  const resumeRef = useRef<{ time: number } | null>(null);
  const recoveringRef = useRef(false);
  const refreshingRef = useRef(false);
  const lastRefreshAtRef = useRef(0);
  const srcGenRef = useRef(0);
  const episodeKeyRef = useRef<string | undefined>(undefined);
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
  const [scrubTime, setScrubTime] = useState<number | null>(null);
  const [transcriptOpen, setTranscriptOpen] = useState(defaultTranscriptOpen);
  const [sliderFocused, setSliderFocused] = useState(false);
  const [ariaHeld, setAriaHeld] = useState<number | null>(null);
  const [coverSize, setCoverSize] = useState<{ for: string | null; size: string | null }>({ for: null, size: null });
  const [coverArmed, setCoverArmed] = useState(false);
  const reducedMotion = usePrefersReducedMotion();
  const waveWidth = useElementWidth(waveRef);
  usePublishedDockHeight(dockRef, tone === 'stage');

  const transcriptDuration = isNum(transcript?.duration_sec) && transcript.duration_sec > 0 ? transcript.duration_sec : 0;
  const duration = audioDuration > 0 ? audioDuration : transcriptDuration;

  // Language of the episode: its own `lang` on the content, French role labels for French items.
  const contentLang = langAttr(language);
  const french = isFrench(language);
  const labels = roleLabels(language);
  const hostI = resolveHost('interviewer', hosts, transcript, labels);
  const hostE = resolveHost('expert', hosts, transcript, labels);
  const hostByRole: Record<Speaker, RadioHost> = { interviewer: hostI, expert: hostE };
  const nameI = hostI.display_name;
  const nameE = hostE.display_name;
  const names = useMemo<Record<Speaker, string>>(() => ({ interviewer: nameI, expert: nameE }), [nameI, nameE]);
  const artist = nameI === nameE ? nameI : `${nameI} & ${nameE}`;

  // Keep the latest props for stable callbacks (declared before the source effect below).
  const coverSizeNow = coverSize.for === coverUrl ? coverSize.size : null;
  useLayoutEffect(() => {
    propsRef.current = props;
    metaRef.current = { title, artist, cover: coverUrl, coverSize: coverSizeNow };
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
    if (!playing || parked) return;
    let frame = 0;
    const loop = () => { paint(); frame = requestAnimationFrame(loop); };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [playing, parked, paint]);

  // ---- Media Session (owner = this player's <audio> element) ----------------------------
  const ownsSession = useCallback(() => isMediaSessionOwner(audioRef.current), []);

  const sessionMetadata = useCallback((): MediaMetadataInit => {
    const meta = metaRef.current;
    return {
      title: meta.title,
      artist: meta.artist,
      album: ALBUM,
      artwork: meta.cover ? [{ src: meta.cover, ...(meta.coverSize ? { sizes: meta.coverSize } : {}) }] : [],
    };
  }, []);

  const applyMetadata = useCallback(() => {
    const a = audioRef.current;
    if (a) updateMediaSession(a, { metadata: sessionMetadata() });
  }, [sessionMetadata]);

  const updatePositionState = useCallback(() => {
    const a = audioRef.current;
    if (!a || !ownsSession()) return;
    const d = a.duration;
    if (!Number.isFinite(d) || d <= 0) return;
    setMediaPositionState(a, {
      duration: d,
      playbackRate: a.playbackRate > 0 ? a.playbackRate : 1,
      position: Math.min(d, Math.max(0, a.currentTime)),
    });
  }, [ownsSession]);

  const setPlayingState = useCallback((next: boolean) => {
    if (playingRef.current === next) return;
    playingRef.current = next;
    setPlaying(next);
    propsRef.current.onPlayStateChange?.(next, episodeKeyRef.current);
    const a = audioRef.current;
    if (a) updateMediaSession(a, { playbackState: next ? 'playing' : 'paused' });
  }, []);

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
      propsRef.current.onTimeUpdate?.(target, episodeKeyRef.current);
    } else {
      try { a.currentTime = target; } catch { pendingSeekRef.current = target; }
    }
    paint();
  }, [paint]);

  const skip = useCallback((delta: number) => {
    if (!audioRef.current?.getAttribute('src')) return;
    seekTo(currentTimeNow() + delta);
  }, [seekTo, currentTimeNow]);

  /**
   * Error recovery: refresh the source — automatically at most once a minute, always on an explicit retry ("Try
   * again" fetches the episode afresh) — or, without a refresh callback, reload it once.
   */
  const recover = useCallback(async (manual: boolean) => {
    const a = audioRef.current;
    if (!a || refreshingRef.current) return;
    const gen = srcGenRef.current;
    const resumeAt = lastTimeRef.current;
    const refresh = propsRef.current.onRefreshSource;
    const throttled = !manual && Date.now() - lastRefreshAtRef.current <= REFRESH_MIN_INTERVAL_MS;
    if (refresh && !throttled) {
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
    setErrorMsg(typeof navigator !== 'undefined' && navigator.onLine === false ? OFFLINE : UNAVAILABLE);
  }, []);

  const requestPlay = useCallback(async (): Promise<void> => {
    const a = audioRef.current;
    if (!a || !a.getAttribute('src')) return;
    wantPlayRef.current = true;
    if (refreshingRef.current) return; // resumes once the fresh source has loaded
    if (a.error && a.error.code !== 1) { await recover(true); return; }
    const gen = srcGenRef.current;
    try {
      await a.play();
    } catch (e) {
      const name = (e as { name?: string } | null)?.name;
      if (name === 'NotAllowedError' && gen === srcGenRef.current) {
        wantPlayRef.current = false;
        if (mountedRef.current) setNeedsGesture(true);
      }
      // AbortError: interrupted by pause() or a new source. NotSupportedError: the media
      // `error` event drives the recovery. A refusal for a previous source is stale.
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

  const mediaHandlers = useCallback((): MediaSessionHandlers => {
    const extra = propsRef.current.extraMediaActions;
    const handlers: MediaSessionHandlers = {
      play: () => { void requestPlay(); },
      pause: () => pauseNow(),
      seekbackward: (d) => skip(-(d.seekOffset || SKIP_SEC)),
      seekforward: (d) => skip(d.seekOffset || SKIP_SEC),
      seekto: (d) => { if (typeof d.seekTime === 'number') seekTo(d.seekTime); },
    };
    for (const action of ['nexttrack', 'previoustrack', 'stop'] as const) {
      if (extra?.[action]) handlers[action] = () => { propsRef.current.extraMediaActions?.[action]?.(); };
    }
    return handlers;
  }, [requestPlay, pauseNow, skip, seekTo]);

  const claimSession = useCallback(() => {
    const a = audioRef.current;
    if (a) claimMediaSession(a, { metadata: sessionMetadata(), handlers: mediaHandlers(), playbackState: 'playing' });
  }, [sessionMetadata, mediaHandlers]);

  useImperativeHandle(ref, () => ({
    play: () => requestPlay(),
    pause: () => pauseNow(),
    seek: (seconds: number) => seekTo(seconds),
    getCurrentTime: () => currentTimeNow(),
    getDuration: () => durationRef.current,
  }), [requestPlay, pauseNow, seekTo, currentTimeNow]);

  // ---- Lifecycle -----------------------------------------------------------------------
  // New source or episode from the parent: reset position/state, apply `initialTime`, try autoplay.
  useLayoutEffect(() => {
    const newEpisode = episodeKeyRef.current !== episodeKey;
    episodeKeyRef.current = episodeKey;
    srcGenRef.current += 1; // late async results of the previous source are dropped
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
    if (newEpisode) {
      lastRefreshAtRef.current = 0;
      scrubRef.current = null;
      setScrubTime(null);
      setAriaHeld(null);
      setRefreshed(null);
      setCoverArmed(false);
    }
    const a = audioRef.current;
    if (!src) {
      if (a) { a.pause(); a.load(); }
      return;
    }
    if (autoPlay) void requestPlay();
    // Only a new `src` / `episodeKey` restarts; `initialTime`/`autoPlay` are read at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, episodeKey]);

  useEffect(() => {
    speedRef.current = speed;
    const a = audioRef.current;
    if (!a) return;
    a.defaultPlaybackRate = speed;
    a.playbackRate = speed;
  }, [speed]);

  useEffect(() => { applyMetadata(); }, [title, artist, coverUrl, coverSizeNow, applyMetadata]);

  // OS track buttons appear / disappear with the extra actions (only while this player owns them).
  const extraKey = (['nexttrack', 'previoustrack', 'stop'] as const).filter((k) => !!extraMediaActions?.[k]).join(',');
  useEffect(() => {
    const a = audioRef.current;
    if (a) updateMediaSession(a, { handlers: mediaHandlers() });
  }, [extraKey, mediaHandlers]);

  useEffect(() => {
    mountedRef.current = true;
    const a = audioRef.current;
    return () => {
      mountedRef.current = false;
      a?.pause();
      releaseMediaSession(a);
    };
  }, []);

  // ---- Media element events --------------------------------------------------------------
  const onAudioPlay = () => {
    wantPlayRef.current = true;
    setNeedsGesture(false);
    claimSession();
    setPlayingState(true);
    setBuffering(true); // until the media fires 'playing': one status, never \
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
    // Last: the parent may load the next episode synchronously (same task as `ended`).
    propsRef.current.onEnded?.(episodeKeyRef.current);
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
    propsRef.current.onTimeUpdate?.(t, episodeKeyRef.current);
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

  const state: RadioState = !effectiveSrc ? 'unavailable'
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

  const speakerName = speaking ? names[speaking] : null;
  useEffect(() => {
    propsRef.current.onStatusChange?.({ state, text: status, speaker: speakerName });
  }, [state, status, speakerName]);

  // Polite status region: state transitions only — never the per-speaker status line, which would talk over the audio.
  const ended = duration > 0 && time >= duration - 0.5;
  const announcement = useTransitionAnnouncement(state === 'paused' && ended ? '' : ANNOUNCEMENTS[state] ?? '');

  // With `deferCover` the cover image is requested once the episode has played: the audio gets the bandwidth first.
  useEffect(() => { if (playing) setCoverArmed(true); }, [playing, episodeKey]);
  const shownCover = deferCover && !coverArmed ? null : coverUrl;
  const levelText = levelLabel(level);
  const languageText = language ? languageName(language) : '';

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
    try { progressStore.setSpeed(v); } catch { /* storage failures are silent */ }
    setSpeed(v);
  };

  const onCoverSize = useCallback((size: string | null) => setCoverSize({ for: coverUrl, size }), [coverUrl]);

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
      data-transcript={hasCues && transcriptOpen ? 'open' : 'closed'}
      onKeyDown={onRootKeyDown}
    >
      <audio
        ref={audioRef}
        src={effectiveSrc || undefined}
        preload="metadata"
        data-testid="radio-audio"
        data-oz-media="radio"
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

      {/* Polite status region: loading, reconnecting, autoplay refused, paused. Transitions only (see ANNOUNCEMENTS). */}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-testid="radio-announcer">
        {announcement}
      </div>

      <div className="radio-player__head">
        <CoverArt url={shownCover} onNaturalSize={onCoverSize} />
        <div className="radio-player__meta">
          <div className="radio-player__tags">
            <p className="eyebrow radio-player__eyebrow"><Headphones aria-hidden />Podcast</p>
            {languageText && (
              <span className="radio-player__lang" data-testid="radio-language">
                <LanguageName code={language} />
              </span>
            )}
            {levelText && (
              <Chip className="radio-player__level" data-testid="radio-level" data-level={level ?? undefined}>{levelText}</Chip>
            )}
          </div>
          <p className="radio-player__title" lang={contentLang}>{title}</p>
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
                    <span className="radio-player__host-role" lang={french ? 'fr' : undefined}>{labels[role]}</span>
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="radio-player__speaker" data-testid="radio-speaker">
            {(state === 'buffering' || state === 'refreshing') && <span className="spinner" aria-hidden />}
            {status}
          </p>
          {state === 'press-play' && (
            <p className="radio-player__hint" data-testid="radio-hint">Your browser blocked autoplay.</p>
          )}
        </div>
      </div>

      {hasCues && (
        <div className="radio-player__caption">
          {/* Visible captions only: announcing them would talk over the audio (transcript on demand). */}
          <p className="radio-player__caption-live" aria-live="off" lang={contentLang} data-testid="radio-caption">
            {captionCue && (
              <>
                <span className="radio-player__caption-name">{names[captionCue.speaker]}:</span>
                {' '}
                <span className="radio-player__caption-text">{captionCue.text}</span>
              </>
            )}
          </p>
          {!captionCue && state === 'playing' && <p className="radio-player__caption-hint" aria-hidden>Live captions appear here.</p>}
        </div>
      )}

      {/* Seek + transport: one block, the sticky thumb zone of the phone sheet (library.css). */}
      <div ref={dockRef} className="radio-player__dock">
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
            <span className={['radio-player__onair', state === 'playing' && 'is-on'].filter(Boolean).join(' ')} aria-hidden={state === 'playing' ? undefined : true}>
              <Waveform active={state === 'playing' && !reducedMotion} />
              <LivePill idle={state !== 'playing'}>Playing</LivePill>
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
                lang={contentLang}
                reactionLabel={french ? ' (réaction)' : ' (reaction)'}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
});

export default RadioPlayer;
