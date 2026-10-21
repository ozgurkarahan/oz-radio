import {
  type ComponentProps, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState,
} from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  AudioLines, Captions, Check, ChevronDown, Download, FileText, GraduationCap, Headphones, History,
  MonitorPlay, Music, Package, Plus, RotateCw, Trash2,
} from 'lucide-react';
import {
  AUDIENCE_LEVEL_LABELS, LibraryItem, LibrarySummary, PodcastHost, toAudienceLevel,
  deleteLibraryItem, hasAudio, hasVideo, isAudioOnly, listLibrary, publishLibraryItem,
} from '../services/podcast';
import { useAuth } from '../services/auth';
import { type AvatarInfo, pickDefaultAvatar, useAvatars } from '../services/avatars';
import { PublishBadge, PublishToggle } from '../components/AuthGate';
import { LanguageName, mapRenditionTime, toRadioHosts } from '../components/RadioPlayer';
import { usePlaybackCommands, usePlaybackSelector, useSuppressMiniPlayer } from '../playback/PlaybackProvider';
import { PlayerSlot } from '../playback/PlayerSlot';
import { miniPlayerFocusTarget } from '../playback/MiniPlayer';
import { invalidate as forgetPrepared, refresh as refetchEpisode } from '../playback/prepare';
import { type ProgressSnapshot, usePlaybackProgress } from '../playback/progress';
import { OPENED_HERE, audioSrcOf } from '../playback/types';
import {
  LibraryEmpty as PublicEmpty, LibraryListError, LibraryOpenError, actionFailureMessage, describeOpenFailure,
  type OpenFailure,
} from '../playback/libraryStates';
import { VideoBuffering, VideoProblem, VideoReconnecting, useVideoBuffering, useVideoRecovery } from '../playback/videoRecovery';
import {
  Alert, Button, ButtonLink, Chip, EmptyState, EpisodeList, EpisodeRow, HostsMini, Modal, PageHeader, Spinner, Tabs,
  type HostLike, buttonClass, episodeNumber, formatDate, formatDuration, recordingTitle, langAttr, languageName, pluralize,
} from '../ui';
import '../styles/pages/library.css';

const KIND = { icon: Headphones, label: 'Podcast' };

/** Watch = MP4 video (page-owned), Listen = the app's persistent radio player (playback/). */
type Mode = 'watch' | 'listen';
const MODE_LABEL: Record<Mode, string> = { watch: 'Watch', listen: 'Listen' };
const toMode = (v: string | null): Mode | null => (v === 'watch' || v === 'listen' ? v : null);

/** Deep link: /podcast/library?episode=<job_id>&mode=watch|listen */
const EPISODE_PARAM = 'episode';
const MODE_PARAM = 'mode';
const ROLE_ORDER: Record<string, number> = { interviewer: 0, expert: 1 };
/** Rows whose playable details are prefetched for a one-tap Listen. */
const PREFETCH_ROWS = 10;
/** A bookmark from this many seconds in is offered as "Resume" (earlier, the episode just starts over). */
const RESUME_FROM_SEC = 3;
/** Row thumbnail box (16:9 at its desktop width): the reserved space keeps the list from shifting as images arrive. */
const THUMB_WIDTH = 120;
const THUMB_HEIGHT = 68;

/** Per-open playback settings of the rendition being mounted. */
interface Playback {
  /** Requested rendition (falls back to an available one). */
  mode: Mode;
  /** Start position (seconds) on that rendition's own timeline. */
  start: number;
  autoPlay: boolean;
}

const duration = (sec: number | null | undefined) => (sec && sec > 0 ? formatDuration(sec) : '—');
/** One length, or — when the audio and the video genuinely differ — each format's own ("Listen 7:01 / Watch 7:07"). */
function rowDuration(it: LibrarySummary, canWatch: boolean, canListen: boolean) {
  const video = it.duration_sec && it.duration_sec > 0 ? it.duration_sec : null;
  const audio = it.audio_duration_sec && it.audio_duration_sec > 0 ? it.audio_duration_sec : null;
  if (canWatch && canListen && video && audio && formatDuration(video) !== formatDuration(audio)) {
    return (
      <span className="library-row__durs" data-testid="library-durations">
        <span data-format="listen">Listen {formatDuration(audio)}</span>
        <span className="sr-only">, </span>
        <span data-format="watch">Watch {formatDuration(video)}</span>
      </span>
    );
  }
  return duration(video ?? audio);
}
const styleLabel = (style: string) => style.charAt(0).toUpperCase() + style.slice(1);
function speakersOf(item: LibrarySummary): string[] {
  const names = item.speaker_names?.filter(Boolean) ?? [];
  if (names.length > 0) return names;
  return (item.hosts ?? [])
    .filter((h): h is PodcastHost => !!h?.display_name?.trim())
    .sort((a, b) => (ROLE_ORDER[a.role] ?? 2) - (ROLE_ORDER[b.role] ?? 2))
    .map((h) => h.display_name.trim());
}
function audienceChip(level: unknown) {
  const lvl = toAudienceLevel(level);
  return lvl ? <Chip icon={GraduationCap} data-testid="audience-chip">{AUDIENCE_LEVEL_LABELS[lvl]} audience</Chip> : null;
}
const videoSrcOf = (item: LibraryItem) => (hasVideo(item) ? item.mp4_url ?? item.video_url ?? null : null);

function availableModes(item: LibraryItem): Mode[] {
  const modes: Mode[] = [];
  if (videoSrcOf(item)) modes.push('watch');
  if (audioSrcOf(item)) modes.push('listen');
  return modes;
}

/** The rendition actually shown for a requested mode (falls back to one the episode has). */
function resolveMode(item: LibraryItem, wanted: Mode): Mode {
  const available = availableModes(item);
  return available.includes(wanted) ? wanted : available[0] ?? (isAudioOnly(item) ? 'listen' : 'watch');
}

/** The listener's progress on an episode: "Resume · 1:12 left" (a bookmark) or "Played" (heard to the end). */
function progressChip(saved: ProgressSnapshot | null) {
  if (!saved) return null;
  if (saved.done) {
    return <Chip icon={Check} className="library-row__progress" data-testid="progress-chip" data-progress="played">Played</Chip>;
  }
  const left = saved.duration - saved.position;
  if (saved.position < RESUME_FROM_SEC || !(left > 0)) return null;
  return (
    <Chip tone="clay" icon={History} className="library-row__progress" data-testid="progress-chip" data-progress="resume">
      {`Resume · ${formatDuration(Math.max(1, left))} left`}
    </Chip>
  );
}

/** A library row with the listener's progress leading its meta; re-renders on progress changes only. */
function PodcastRow({ jobId, meta = [], ...row }: { jobId: string } & ComponentProps<typeof EpisodeRow>) {
  const chip = progressChip(usePlaybackProgress(jobId));
  return <EpisodeRow {...row} meta={chip ? [chip, ...meta] : meta} />;
}

/** Navigation state of the current history entry (React Router stores it under `usr`). */
function historyState(): Record<string, unknown> | null {
  const usr = (window.history.state as { usr?: unknown } | null)?.usr;
  return usr && typeof usr === 'object' ? (usr as Record<string, unknown>) : null;
}

export default function PodcastLibraryPage() {
  const auth = useAuth();
  const isAdmin = auth.is_admin;
  const { avatars } = useAvatars();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const episodeParam = searchParams.get(EPISODE_PARAM) || null;
  const modeParam = toMode(searchParams.get(MODE_PARAM));

  const [publishing, setPublishing] = useState<string | null>(null);
  const [items, setItems] = useState<LibrarySummary[] | null>(null);
  const [selected, setSelected] = useState<LibraryItem | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [playback, setPlayback] = useState<Playback>({ mode: 'watch', start: 0, autoPlay: true });
  /** The list request failed (`items` stays what it was: null on the first load). Never the same as an empty list. */
  const [listError, setListError] = useState<unknown>(null);
  /** An admin action (publish, delete) failed. */
  const [actionError, setActionError] = useState<string | null>(null);
  /** A failed open (unknown / unpublished episode, storage down, offline); kept apart so a list refresh does not wipe it. */
  const [openError, setOpenError] = useState<(OpenFailure & { mode: Mode }) | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const titleId = useId();

  const navigateRef = useRef(navigate);
  const pathRef = useRef(window.location.pathname);
  /** Latest open request: responses for any other (closed / superseded) request are ignored. */
  const requestRef = useRef<{ id: string } | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  /** Rendition currently on screen; media events from the other one are ignored. */
  const activeModeRef = useRef<Mode | null>(null);
  /** Whether the Watch video is (meant to be) playing — carried over to Listen. */
  const playIntentRef = useRef(true);
  const selectedRef = useRef<LibraryItem | null>(null);
  /** Closing went back one history entry and that traversal (popstate) has not landed yet. */
  const backPendingRef = useRef(false);
  const backTimerRef = useRef<number | undefined>(undefined);
  /** Episode opened while that back was in flight: its URL is pushed once the back has landed. */
  const queuedOpenRef = useRef<{ id: string; mode: Mode } | null>(null);

  /** The app's persistent radio (Listen): it outlives this dialog and this page. */
  const player = usePlaybackCommands();
  const lastAdvance = usePlaybackSelector((s) => s.lastAdvance);
  const radioItem = usePlaybackSelector((s) => s.current?.item ?? null);
  /** The radio could not load the episode: the sheet then offers Watch instead. */
  const radioFailed = usePlaybackSelector((s) => s.radioState === 'error');
  useLayoutEffect(() => {
    navigateRef.current = navigate;
    selectedRef.current = selected;
  });

  // Fallback pair when speaker names don't match a known avatar: default host + a contrasting co-host.
  const fallbackHosts = useMemo(() => {
    const lead = pickDefaultAvatar(avatars);
    const others = avatars.filter((a) => a.id !== lead?.id);
    const co = others.find((a) => a.gender !== lead?.gender && a.thumbnail_url)
      ?? others.find((a) => a.gender !== lead?.gender)
      ?? others[0];
    return [lead, co];
  }, [avatars]);

  const hostsFor = (item: LibrarySummary): (HostLike | undefined)[] => {
    if (item.hosts && item.hosts.length > 0) return toRadioHosts(item.hosts, avatars, item.speaker_names ?? [], item.language);
    const named = speakersOf(item)
      .map((name) => avatars.find((a) => a.display_name === name))
      .filter(Boolean) as AvatarInfo[];
    return named.length ? named : fallbackHosts;
  };

  async function refresh() {
    setListError(null);
    setActionError(null);
    try {
      const rows = await listLibrary();
      setItems(rows);
    } catch (e: unknown) {
      setListError(e);
    }
  }

  // Re-fetch once identity is known: admins also see drafts.
  useEffect(() => { if (!auth.loading) refresh(); }, [auth.loading, auth.is_admin]);

  // ---- Player: open / close / deep link ----------------------------------------------
  /**
   * Closes the dialog. Listen only minimises (the persistent radio keeps playing in the
   * mini-player); Watch stops its video and leaves the radio where the video was.
   */
  const closeLocal = useCallback(() => {
    const video = videoRef.current;
    const shown = selectedRef.current;
    if (activeModeRef.current === 'watch' && video && shown && video.currentTime > 0
      && player.getCurrent()?.jobId === shown.job_id) {
      player.seek(mapRenditionTime(shown.transcript, video.currentTime, 'video'));
    }
    requestRef.current = null;
    queuedOpenRef.current = null;
    activeModeRef.current = null;
    video?.pause();
    setSelected(null);
    setLoadingId(null);
  }, [player]);

  const pushEpisodeUrl = useCallback((id: string, mode: Mode) => {
    const params = new URLSearchParams(window.location.search);
    params.set(EPISODE_PARAM, id);
    params.set(MODE_PARAM, mode);
    navigateRef.current({ search: `?${params}` }, { state: { [OPENED_HERE]: id } });
  }, []);

  /** Our back traversal landed (or never will): push the URL of an episode opened meanwhile. */
  const settleBack = useCallback((): boolean => {
    if (!backPendingRef.current) return false;
    backPendingRef.current = false;
    window.clearTimeout(backTimerRef.current);
    const queued = queuedOpenRef.current;
    queuedOpenRef.current = null;
    if (!queued || requestRef.current?.id !== queued.id) return false;
    pushEpisodeUrl(queued.id, queued.mode);
    return true;
  }, [pushEpisodeUrl]);

  /** Drops ?episode/&mode: pops the entry pushed by an in-app open, else replaces the deep link. */
  const leaveEpisodeUrl = useCallback(() => {
    if (backPendingRef.current) return; // already leaving this entry
    const params = new URLSearchParams(window.location.search);
    const id = params.get(EPISODE_PARAM);
    if (!id) return;
    if (historyState()?.[OPENED_HERE] === id) {
      // history.back() is asynchronous: an open before it lands must not push in between.
      backPendingRef.current = true;
      window.clearTimeout(backTimerRef.current);
      backTimerRef.current = window.setTimeout(settleBack, 3000);
      navigateRef.current(-1);
      return;
    }
    params.delete(EPISODE_PARAM);
    params.delete(MODE_PARAM);
    const search = params.toString();
    navigateRef.current({ search: search ? `?${search}` : '' }, { replace: true });
  }, [settleBack]);

  /**
   * Opens an episode. Listen with the episode already in the radio, or a fresh prefetched one,
   * opens instantly; from a tap (`gesture`) the radio starts synchronously inside it. Otherwise
   * the details load first (Watch always does: its video is page-owned).
   */
  const beginLoad = useCallback((id: string, wanted: Mode | null, gesture = false) => {
    const request = { id };
    requestRef.current = request;
    activeModeRef.current = null;
    playIntentRef.current = true;
    videoRef.current?.pause();
    const requested: Mode = wanted ?? 'listen'; // resolveMode falls back to Watch for an episode without audio
    setPlayback({ mode: requested, start: 0, autoPlay: true });

    if (requested === 'listen') {
      const held = player.getCurrent();
      const instant = held?.jobId === id ? held.item : player.getPrepared(id);
      if (instant && audioSrcOf(instant)) {
        if (gesture) {
          player.startEpisode(instant, { autoPlay: true }); // same episode: resumes, never reloads
        } else if (held?.jobId !== id) {
          queueMicrotask(() => {
            if (requestRef.current === request) player.startEpisode(instant, { autoPlay: true });
          });
        }
        setOpenError(null);
        setLoadingId(null);
        setSelected(instant);
        return;
      }
    }

    // Watch pauses the radio; a cold Listen pauses it until the new episode replaces it.
    player.pause();
    setSelected(null);
    setLoadingId(id);
    player.loadEpisode(id).then(
      (item) => {
        if (requestRef.current !== request) return; // closed, or another episode was opened meanwhile
        setOpenError(null);
        setSelected(item);
        setLoadingId(null);
        // Not in a tap any more: a refused autoplay shows "Press play".
        if (resolveMode(item, requested) === 'listen') player.startEpisode(item, { autoPlay: true });
      },
      (e: unknown) => {
        if (requestRef.current !== request) return;
        requestRef.current = null;
        if (queuedOpenRef.current?.id === id) queuedOpenRef.current = null;
        setLoadingId(null);
        setOpenError({ ...describeOpenFailure(e, id, 'episode'), mode: requested });
        leaveEpisodeUrl();
      },
    );
  }, [player, leaveEpisodeUrl]);

  function openEpisode(id: string, wanted: Mode) {
    beginLoad(id, wanted, true);
    if (backPendingRef.current) queuedOpenRef.current = { id, mode: wanted };
    else pushEpisodeUrl(id, wanted);
  }

  /** "Try again" on a failed open: the episode is fetched afresh (never a cached copy). */
  function retryOpen() {
    if (!openError) return;
    const { id, mode: wanted } = openError;
    setOpenError(null);
    openEpisode(id, wanted);
  }

  /** "Back to all episodes": the gone episode's alert goes, focus lands on the list. */
  function dismissOpenError() {
    setOpenError(null);
    const first = document.querySelector<HTMLElement>('.library-list .episode-row__title');
    (first ?? document.getElementById('main'))?.focus();
  }

  // Stable identity: the Modal re-runs its focus handling whenever onClose changes.
  const closePlayer = useCallback(() => {
    closeLocal();
    leaveEpisodeUrl();
  }, [closeLocal, leaveEpisodeUrl]);

  /** Opens / closes the player to match the address bar (deep links, back / forward). */
  const syncFromUrl = useCallback(() => {
    if (backPendingRef.current) return; // settled by the popstate of our own back()
    if (window.location.pathname !== pathRef.current) return; // leaving the page
    const params = new URLSearchParams(window.location.search);
    const id = params.get(EPISODE_PARAM) || null;
    if (!id) {
      if (requestRef.current) closeLocal();
      return;
    }
    if (requestRef.current?.id === id) return; // already open or loading
    beginLoad(id, toMode(params.get(MODE_PARAM)));
  }, [beginLoad, closeLocal]);

  // Back / forward act on popstate directly: the router's transition may coalesce a push and a pop
  // (no visible change in its state) while the player was opened locally in between.
  useEffect(() => {
    const onPopState = () => {
      if (!settleBack()) syncFromUrl();
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [settleBack, syncFromUrl]);

  // Initial deep link and any other change of the query (idempotent with the handler above).
  useEffect(() => { syncFromUrl(); }, [episodeParam, modeParam, syncFromUrl]);

  // Leaving the page invalidates any in-flight open (no late navigation from a stale response).
  useEffect(() => () => {
    requestRef.current = null;
    queuedOpenRef.current = null;
    backPendingRef.current = false;
    window.clearTimeout(backTimerRef.current);
  }, []);

  const videoSrc = selected ? videoSrcOf(selected) : null;
  const available: Mode[] = selected ? availableModes(selected) : [];
  const mode: Mode = selected ? resolveMode(selected, playback.mode) : playback.mode;
  const showTabs = available.length > 1;
  const listening = !!selected && mode === 'listen';

  useLayoutEffect(() => { activeModeRef.current = selected ? mode : null; }, [selected, mode]);

  // The mini-player stays hidden behind any episode dialog (Watch, loading); Listen shows the player itself.
  useSuppressMiniPlayer(!!(selected || loadingId));

  // Listen: initial focus goes to Play (so K / Space work at once), unless focus already moved on (e.g. the format tab).
  // The radio's DOM is re-parented while the sheet opens (which drops focus), so it is re-checked for about a second.
  const listeningId = listening ? selected?.job_id : null;
  useEffect(() => {
    if (!listeningId) return undefined;
    let frames = 0;
    let frame = 0;
    const focusPlay = () => {
      const panel = document.querySelector<HTMLElement>('.library-player--podcast[role="dialog"]');
      const active = document.activeElement;
      if (!active || active === panel || active === document.body) {
        const play = panel?.querySelector<HTMLButtonElement>('[data-testid="radio-play"]');
        if (play && !play.disabled) play.focus();
      }
      if (++frames < 60) frame = requestAnimationFrame(focusPlay);
    };
    focusPlay();
    return () => cancelAnimationFrame(frame);
  }, [listeningId]);

  // Watch: one automatic refresh of an expired / failing video link, then "Try again" and "Listen instead".
  const recovery = useVideoRecovery<LibraryItem>({
    jobId: selected && mode === 'watch' ? selected.job_id : null,
    fetchFresh: refetchEpisode,
    apply: (fresh) => setSelected((prev) => (prev && prev.job_id === fresh.job_id ? fresh : prev)),
  });

  // Watch: the app says so while the video has no frame to show yet (each rendition, refresh or episode starts afresh).
  const buffering = useVideoBuffering(`${selected?.job_id ?? ''}:${recovery.generation}:${mode}`);

  // Keep ?mode= in step with what is shown (fallback rendition, tab switches) without new entries.
  useEffect(() => {
    if (!selected) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get(EPISODE_PARAM) !== selected.job_id || params.get(MODE_PARAM) === mode) return;
    params.set(MODE_PARAM, mode);
    navigate({ search: `?${params}` }, { replace: true, state: historyState() });
  }, [selected, mode, navigate, episodeParam, modeParam]);

  // The radio moved on by itself (auto-next) while this sheet shows it: follow without a new entry.
  useEffect(() => {
    const shown = selectedRef.current;
    if (!lastAdvance || !shown || shown.job_id !== lastAdvance.from || activeModeRef.current !== 'listen') return;
    if (requestRef.current?.id !== shown.job_id) return;
    const cur = player.getCurrent();
    if (!cur || cur.jobId !== lastAdvance.to) return;
    requestRef.current = { id: cur.jobId };
    setSelected(cur.item);
    const params = new URLSearchParams(window.location.search);
    if (params.get(EPISODE_PARAM) !== shown.job_id) return;
    params.set(EPISODE_PARAM, cur.jobId);
    params.set(MODE_PARAM, 'listen');
    const state = historyState();
    const openedHere = state?.[OPENED_HERE] === shown.job_id;
    navigateRef.current(
      { search: `?${params}` },
      { replace: true, state: openedHere ? { ...state, [OPENED_HERE]: cur.jobId } : state },
    );
  }, [lastAdvance, player]);

  // A fresher copy of the shown episode (the radio renewed an expired link): keep its other URLs fresh too.
  useEffect(() => {
    if (radioItem) setSelected((prev) => (prev && prev !== radioItem && prev.job_id === radioItem.job_id ? radioItem : prev));
  }, [radioItem]);

  // One-tap Listen: keep the first rows' playable details ready (on load and whenever the page shows again).
  const prefetchIds = useMemo(
    () => (items ?? []).slice(0, PREFETCH_ROWS).filter((it) => hasAudio(it)).map((it) => it.job_id),
    [items],
  );
  useEffect(() => {
    if (prefetchIds.length === 0) return undefined;
    player.prepare(prefetchIds);
    const onVisible = () => { if (document.visibilityState === 'visible') player.prepare(prefetchIds); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [prefetchIds, player]);

  /** Watch ↔ Listen: pause the current medium and continue on the other at the same point of the conversation. */
  function switchMode(next: Mode) {
    if (!selected || next === mode || !available.includes(next)) return;
    activeModeRef.current = next;
    if (mode === 'watch') {
      const wasPlaying = playIntentRef.current;
      const video = videoRef.current;
      // The video is gone while its failure panel shows ("Listen instead"): continue from where it stopped.
      const t = video && Number.isFinite(video.currentTime) ? video.currentTime : recovery.lastTime();
      video?.pause();
      const start = Math.max(0, mapRenditionTime(selected.transcript, t, 'video'));
      if (player.getCurrent()?.jobId === selected.job_id) {
        player.seek(start);
        if (wasPlaying) void player.play();
      } else {
        player.startEpisode(selected, { autoPlay: wasPlaying, start });
      }
      setPlayback({ mode: next, start, autoPlay: wasPlaying });
    } else {
      const wasPlaying = player.getState().playing;
      const t = player.getCurrentTime();
      player.pause();
      const start = Math.max(0, mapRenditionTime(selected.transcript, t, 'audio'));
      const held = player.getCurrent();
      if (held && held.jobId === selected.job_id && held.item !== selected) setSelected(held.item);
      playIntentRef.current = wasPlaying; // the video's own play / pause events take over from here
      setPlayback({ mode: next, start, autoPlay: wasPlaying });
    }
  }

  const onVideoPlayState = (playing: boolean, video: HTMLVideoElement) => {
    if (activeModeRef.current === 'watch') playIntentRef.current = playing;
    recovery.track(video, playing);
  };

  // ---- Admin actions ------------------------------------------------------------------
  async function togglePublish(jobId: string, next: boolean) {
    setPublishing(jobId);
    try {
      const updated = await publishLibraryItem(jobId, next);
      const published = typeof updated?.published === 'boolean' ? updated.published : next;
      setItems((prev) => prev?.map((i) => (i.job_id === jobId ? { ...i, published } : i)) ?? null);
      setSelected((prev) => (prev && prev.job_id === jobId ? { ...prev, published } : prev));
    } catch (e: unknown) {
      setActionError(actionFailureMessage(e, 'Publish update'));
    } finally {
      setPublishing(null);
    }
  }

  async function remove(jobId: string) {
    if (!confirm('Delete this podcast permanently?')) return;
    setDeleting(jobId);
    try {
      await deleteLibraryItem(jobId);
      forgetPrepared(jobId);
      setItems((prev) => prev?.filter((i) => i.job_id !== jobId) ?? null);
      if (requestRef.current?.id === jobId) closePlayer();
      if (player.getCurrent()?.jobId === jobId) player.stop();
    } catch (e: unknown) {
      setActionError(actionFailureMessage(e, 'Delete'));
    } finally {
      setDeleting(null);
    }
  }

  const title = selected ? recordingTitle(selected.title) : '';
  const titleLang = langAttr(selected?.language);
  const audioOnlySelected = !!selected && isAudioOnly(selected);
  const formatText = audioOnlySelected ? 'Audio only' : showTabs ? 'Video + audio' : 'Video';
  const mp4Download = selected ? selected.mp4_url ?? selected.video_url ?? null : null;
  /** Visitors keep the MP4 download they always had (Watch mode); every other download is admin-only. A failing URL is not offered. */
  const visibleMp4 = mp4Download && (isAdmin || mode === 'watch') && recovery.fault === null ? mp4Download : null;
  const mp3Download = selected ? selected.mp3_url ?? selected.audio_url ?? null : null;
  const adminDownloads = isAdmin && !!selected
    && !!(mp3Download || selected.srt_url || selected.audio_srt_url || selected.scorm_url);
  const selectedDuration = selected
    ? (mode === 'listen' ? selected.audio_duration_sec ?? selected.duration_sec : selected.duration_sec ?? selected.audio_duration_sec)
    : null;

  return (
    <div className="container page library library--podcast">
      <PageHeader
        title="Podcasts"
        lead={isAdmin
          ? "All podcasts you've generated. Publish a podcast to make it visible to anonymous visitors."
          : 'Published two-host podcasts: our AI hosts discuss a document together. Pick an episode to play it.'}
        actions={(
          <>
            <Button variant="ghost" icon={RotateCw} onClick={refresh}>Refresh</Button>
            {isAdmin && <ButtonLink to="/podcast" variant="primary" icon={Plus}>Create podcast</ButtonLink>}
          </>
        )}
      />

      {openError && (
        <LibraryOpenError failure={openError} onRetry={retryOpen} onDismiss={dismissOpenError} backLabel="Back to all episodes" />
      )}
      {actionError && <Alert tone="error" className="library__alert">{actionError}</Alert>}
      {/* A refresh that failed while a list is on screen keeps the list; a first load that failed shows the failure instead of it. */}
      {listError != null && items !== null && (
        <LibraryListError error={listError} what="the episodes" onRetry={refresh} library="podcast" withLinks={false} />
      )}

      {items === null && listError != null ? (
        <LibraryListError error={listError} what="the episodes" onRetry={refresh} library="podcast" />
      ) : items === null ? (
        <div className="library__loading"><Spinner label="Loading podcasts…" /></div>
      ) : items.length === 0 ? (
        <LibraryEmpty isAdmin={isAdmin} />
      ) : (
        <>
          <div className="library__count eyebrow">{pluralize(items.length, 'episode')}</div>
          <EpisodeList label="Podcasts" className="library-list">
            {items.map((it, i) => {
              const rowTitle = recordingTitle(it.title);
              const speakers = speakersOf(it);
              const audioOnly = isAudioOnly(it);
              const canWatch = hasVideo(it);
              const canListen = hasAudio(it);
              // Oz Radio: every episode with audio leads with Listen on every device (title and primary button); Watch is the alternative.
              const titleMode: Mode = canListen ? 'listen' : 'watch';
              const lead: Mode = titleMode;
              const watchButton = canWatch && (
                <Button
                  size="sm"
                  icon={MonitorPlay}
                  variant={lead === 'watch' ? 'primary' : 'outline'}
                  aria-label={`Watch ${rowTitle}`}
                  data-testid="library-watch"
                  onClick={() => openEpisode(it.job_id, 'watch')}
                >
                  Watch
                </Button>
              );
              const listenButton = canListen && (
                <Button
                  size="sm"
                  icon={Headphones}
                  variant={lead === 'listen' ? 'primary' : 'outline'}
                  aria-label={`Listen to ${rowTitle}`}
                  data-testid="library-listen"
                  onClick={() => openEpisode(it.job_id, 'listen')}
                >
                  Listen
                </Button>
              );
              return (
                <PodcastRow
                  key={it.job_id}
                  jobId={it.job_id}
                  data-testid="library-item"
                  data-format={audioOnly ? 'audio' : 'video'}
                  className={[
                    'library-row',
                    it.thumbnail_url && 'library-row--thumb',
                    audioOnly && 'library-row--audio',
                    isAdmin && 'library-row--admin',
                  ].filter(Boolean).join(' ')}
                  onPointerDown={canListen ? () => player.prepare([it.job_id]) : undefined}
                  num={episodeNumber(i + 1)}
                  title={rowTitle}
                  lang={it.language}
                  level={toAudienceLevel(it.audience_level)}
                  onOpen={() => openEpisode(it.job_id, titleMode)}
                  meta={[
                    formatDate(it.created_at),
                    <LanguageName code={it.language} />,
                    speakers.length > 0 ? speakers.join(' & ') : null,
                    it.style ? styleLabel(it.style) : null,
                    audioOnly ? <Chip icon={AudioLines} data-testid="audio-only-chip">Audio only</Chip> : null,
                    isAdmin ? <PublishBadge published={it.published} /> : null,
                  ]}
                  kind={KIND}
                  hosts={<HostsMini hosts={hostsFor(it)} label={speakers.join(' and ') || undefined} />}
                  duration={rowDuration(it, canWatch, canListen)}
                  extra={it.thumbnail_url
                    ? <img className="library-thumb" src={it.thumbnail_url} alt="" width={THUMB_WIDTH} height={THUMB_HEIGHT} loading="lazy" decoding="async" />
                    : undefined}
                  actions={(
                    <>
                      <span className="library-row__play">
                        {listenButton}
                        {watchButton}
                      </span>
                      {isAdmin && (
                        <span className="library-row__manage">
                          <PublishToggle
                            published={it.published}
                            busy={publishing === it.job_id}
                            onToggle={(next) => togglePublish(it.job_id, next)}
                          />
                          <Button
                            size="sm"
                            iconOnly
                            variant="danger"
                            icon={Trash2}
                            busy={deleting === it.job_id}
                            aria-label={`Delete ${rowTitle}`}
                            title="Delete"
                            onClick={(e) => { e.stopPropagation(); remove(it.job_id); }}
                          />
                        </span>
                      )}
                    </>
                  )}
                />
              );
            })}
          </EpisodeList>
        </>
      )}

      <Modal
        open={!!(selected || loadingId)}
        onClose={closePlayer}
        label={selected ? title : 'Loading podcast'}
        aria-labelledby={selected && !loadingId ? titleId : undefined}
        variant="stage"
        className={['library-player', 'library-player--podcast', showTabs && 'library-player--tabs'].filter(Boolean).join(' ')}
        data-mode={selected ? mode : undefined}
        closeLabel={listening ? 'Minimise player' : 'Close'}
        closeIcon={listening ? ChevronDown : undefined}
        fallbackFocus={miniPlayerFocusTarget}
      >
        {loadingId || !selected ? (
          <div className="library-player__status"><Spinner label="Loading podcast…" /></div>
        ) : (
          <>
            {showTabs && (
              <div className="library-player__formats" data-testid="player-format-tabs">
                <Tabs<Mode>
                  label="Episode format"
                  value={mode}
                  onChange={switchMode}
                  tabs={[
                    { id: 'watch', label: <><MonitorPlay aria-hidden />{MODE_LABEL.watch}</> },
                    { id: 'listen', label: <><Headphones aria-hidden />{MODE_LABEL.listen}</> },
                  ]}
                />
              </div>
            )}
            <div
              className="library-player__screen"
              role={showTabs ? 'tabpanel' : undefined}
              aria-label={showTabs ? MODE_LABEL[mode] : undefined}
              data-mode={mode}
            >
              {mode === 'listen' ? (
                <>
                  {/* The app's radio (one <audio> for the whole visit) moves in here; closing parks it, still playing. */}
                  <PlayerSlot />
                  {radioFailed && available.includes('watch') && (
                    <div className="library-player__instead">
                      <Button size="sm" icon={MonitorPlay} onClick={() => switchMode('watch')} data-testid="watch-instead">
                        Watch instead
                      </Button>
                    </div>
                  )}
                </>
              ) : (
                <>
                  {videoSrc && (
                    <video
                      key={`${selected.job_id}:${recovery.generation}`}
                      ref={videoRef}
                      hidden={recovery.fault !== null}
                      data-testid="library-player"
                      data-oz-media="video"
                      src={videoSrc}
                      controls
                      autoPlay={recovery.resume ? recovery.resume.play : playback.autoPlay}
                      onLoadedMetadata={(e) => {
                        const start = recovery.resume?.time ?? playback.start;
                        if (start > 0) {
                          try { e.currentTarget.currentTime = start; } catch { /* not seekable */ }
                        }
                      }}
                      onPlay={(e) => onVideoPlayState(true, e.currentTarget)}
                      onPause={(e) => onVideoPlayState(false, e.currentTarget)}
                      onTimeUpdate={(e) => recovery.track(e.currentTarget)}
                      onError={recovery.onError}
                      {...buffering.handlers}
                    >
                      {/* Captions are burned into the picture: the track is there for assistive technology and is never `default`. */}
                      {selected.captions_vtt_url && (
                        <track
                          kind="captions"
                          src={selected.captions_vtt_url}
                          srcLang={langAttr(selected.language)}
                          label={languageName(selected.language)}
                          data-testid="video-captions"
                        />
                      )}
                    </video>
                  )}
                  {/* The video stays mounted (hidden) under these: a failed one is replaced by a fresh element on the next refresh. */}
                  {videoSrc && buffering.active && recovery.fault === null && <VideoBuffering />}
                  {recovery.fault === 'refreshing' && <VideoReconnecting />}
                  {recovery.fault !== 'refreshing' && (!videoSrc || recovery.fault === 'failed') && (
                    <VideoProblem
                      kind={videoSrc ? 'failed' : 'unavailable'}
                      onRetry={recovery.retry}
                      instead={available.includes('listen') ? { label: 'Listen instead', onClick: () => switchMode('listen') } : undefined}
                    />
                  )}
                </>
              )}
            </div>
            <div className="library-player__info">
              {mode !== 'listen' && (
                <div className="eyebrow library-player__eyebrow"><Headphones aria-hidden />Podcast</div>
              )}
              {/* In Listen mode the radio player already shows the title: keep the heading for screen readers only. */}
              <h2
                id={titleId}
                lang={titleLang}
                className={['library-player__title', mode === 'listen' && 'sr-only'].filter(Boolean).join(' ')}
              >
                {title}
              </h2>
              {selected.document_title && selected.document_title !== selected.title && (
                <p className="library-player__source">Source: {selected.document_title}</p>
              )}
              <div className="library-player__meta">
                <span>{formatDate(selected.created_at)}</span>
                <span>{duration(selectedDuration)}</span>
                <LanguageName code={selected.language} />
                {selected.style && <span>{styleLabel(selected.style)}</span>}
                <Chip icon={audioOnlySelected ? AudioLines : MonitorPlay} data-testid="format-chip">{formatText}</Chip>
                {audienceChip(selected.audience_level)}
                {typeof selected.turn_count === 'number' && <span>{pluralize(selected.turn_count, 'turn')}</span>}
                {speakersOf(selected).length > 0 && <span>{speakersOf(selected).join(' & ')}</span>}
              </div>
              {(visibleMp4 || adminDownloads) && (
                <div className="library-player__downloads" data-testid="library-downloads">
                  {visibleMp4 && (
                    <a href={visibleMp4} download={`${selected.title}.mp4`} className={buttonClass({ variant: 'primary', size: 'sm' })} data-testid="download-mp4">
                      <Download aria-hidden />Download MP4
                    </a>
                  )}
                  {isAdmin && mp3Download && (
                    <a href={mp3Download} download={`${selected.title}.mp3`} className={buttonClass({ variant: visibleMp4 ? 'outline' : 'primary', size: 'sm' })} data-testid="download-mp3">
                      <Music aria-hidden />Audio MP3
                    </a>
                  )}
                  {isAdmin && selected.srt_url && (
                    <a href={selected.srt_url} download={`${selected.title}.srt`} className={buttonClass({ size: 'sm' })} data-testid="download-srt">
                      <Captions aria-hidden />Subtitles SRT
                    </a>
                  )}
                  {isAdmin && selected.audio_srt_url && (
                    <a href={selected.audio_srt_url} download={`${selected.title}-radio.srt`} className={buttonClass({ size: 'sm' })} data-testid="download-audio-srt">
                      <FileText aria-hidden />Radio transcript SRT
                    </a>
                  )}
                  {isAdmin && selected.scorm_url && (
                    <a href={selected.scorm_url} download={`${selected.title}-scorm.zip`} className={buttonClass({ size: 'sm' })} data-testid="download-scorm">
                      <Package aria-hidden />SCORM package
                    </a>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}

function LibraryEmpty({ isAdmin }: { isAdmin: boolean }) {
  if (!isAdmin) {
    return (
      <PublicEmpty icon={Headphones} title="No episodes are published yet" library="podcast">
        Episodes appear here as soon as they are published. In the meantime:
      </PublicEmpty>
    );
  }
  return (
    <EmptyState
      icon={Headphones}
      title="No podcasts yet"
      action={<ButtonLink to="/podcast" variant="primary" icon={Plus}>Create podcast</ButtonLink>}
    >
      Head to the podcast studio and generate your first one — it will appear here automatically.
    </EmptyState>
  );
}
