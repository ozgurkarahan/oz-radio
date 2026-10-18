import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  AudioLines, Captions, Download, FileText, GraduationCap, Headphones, Layers, MonitorPlay, Music, Package, Plus,
  RotateCw, Trash2,
} from 'lucide-react';
import {
  AUDIENCE_LEVEL_LABELS, LibraryItem, LibrarySummary, PodcastHost, toAudienceLevel,
  deleteLibraryItem, getLibraryItem, hasAudio, hasVideo, isAudioOnly, listLibrary, publishLibraryItem,
} from '../services/podcast';
import { useAuth } from '../services/auth';
import { type AvatarInfo, pickDefaultAvatar, useAvatars } from '../services/avatars';
import { GateNotice, PublishBadge, PublishToggle } from '../components/AuthGate';
import { RadioPlayer, type RadioPlayerHandle, mapRenditionTime, toRadioHosts } from '../components/RadioPlayer';
import {
  Alert, Button, ButtonLink, Chip, EmptyState, EpisodeList, EpisodeRow, HostsMini, Modal, PageHeader, Spinner, Tabs,
  type HostLike, buttonClass, episodeNumber, formatDate, formatDuration, humanizeTitle, languageName, pluralize,
} from '../ui';
import '../styles/pages/library.css';

const KIND = { icon: Headphones, label: 'Podcast' };

/** Watch = MP4 video, Listen = radio MP3 (RadioPlayer). */
type Mode = 'watch' | 'listen';
const MODE_LABEL: Record<Mode, string> = { watch: 'Watch', listen: 'Listen' };
const toMode = (v: string | null): Mode | null => (v === 'watch' || v === 'listen' ? v : null);

/** Deep link: /podcast/library?episode=<job_id>&mode=watch|listen */
const EPISODE_PARAM = 'episode';
const MODE_PARAM = 'mode';
/** History state of an entry pushed by opening an episode on this page: closing pops it. */
const OPENED_HERE = 'podcastEpisode';
const ROLE_ORDER: Record<string, number> = { interviewer: 0, expert: 1 };

/** Per-open playback settings of the rendition being mounted. */
interface Playback {
  /** Requested rendition (falls back to an available one). */
  mode: Mode;
  /** Start position (seconds) on that rendition's own timeline. */
  start: number;
  autoPlay: boolean;
}

const duration = (sec: number | null | undefined) => (sec && sec > 0 ? formatDuration(sec) : '—');
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
const audioSrcOf = (item: LibraryItem) => (hasAudio(item) ? item.audio_url ?? item.mp3_url ?? null : null);

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
  const [error, setError] = useState<string | null>(null);
  /** A failed open (unknown / unpublished episode); kept apart so a list refresh does not wipe it. */
  const [openError, setOpenError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const navigateRef = useRef(navigate);
  const pathRef = useRef(window.location.pathname);
  /** Latest open request: responses for any other (closed / superseded) request are ignored. */
  const requestRef = useRef<{ id: string } | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const radioRef = useRef<RadioPlayerHandle>(null);
  /** Rendition currently on screen; media events from the other one are ignored. */
  const activeModeRef = useRef<Mode | null>(null);
  /** Whether the active rendition is (meant to be) playing — carried over on Watch ↔ Listen. */
  const playIntentRef = useRef(true);
  /** Item re-fetched by the radio player after a SAS expiry, applied at the next switch. */
  const freshItemRef = useRef<LibraryItem | null>(null);
  /** Closing went back one history entry and that traversal (popstate) has not landed yet. */
  const backPendingRef = useRef(false);
  const backTimerRef = useRef<number | undefined>(undefined);
  /** Episode opened while that back was in flight: its URL is pushed once the back has landed. */
  const queuedOpenRef = useRef<{ id: string; mode: Mode } | null>(null);

  useLayoutEffect(() => { navigateRef.current = navigate; });

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
    if (item.hosts && item.hosts.length > 0) return toRadioHosts(item.hosts, avatars, item.speaker_names ?? []);
    const named = speakersOf(item)
      .map((name) => avatars.find((a) => a.display_name === name))
      .filter(Boolean) as AvatarInfo[];
    return named.length ? named : fallbackHosts;
  };

  async function refresh() {
    setError(null);
    try {
      const rows = await listLibrary();
      setItems(rows);
    } catch (e: any) {
      setError(String(e?.message ?? e));
      setItems([]);
    }
  }

  // Re-fetch once identity is known: admins also see drafts.
  useEffect(() => { if (!auth.loading) refresh(); }, [auth.loading, auth.is_admin]);

  // ---- Player: open / close / deep link ----------------------------------------------
  const pauseAll = useCallback(() => {
    videoRef.current?.pause();
    radioRef.current?.pause();
  }, []);

  const closeLocal = useCallback(() => {
    requestRef.current = null;
    queuedOpenRef.current = null;
    freshItemRef.current = null;
    activeModeRef.current = null;
    pauseAll();
    setSelected(null);
    setLoadingId(null);
  }, [pauseAll]);

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

  /** Drops ?episode/&mode: pops the entry pushed by an in-page open, else replaces the deep link. */
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

  const beginLoad = useCallback((id: string, wanted: Mode | null) => {
    const request = { id };
    requestRef.current = request;
    freshItemRef.current = null;
    activeModeRef.current = null;
    playIntentRef.current = true;
    pauseAll();
    setSelected(null);
    setLoadingId(id);
    setPlayback({ mode: wanted ?? 'watch', start: 0, autoPlay: true });
    getLibraryItem(id).then(
      (item) => {
        if (requestRef.current !== request) return; // closed, or another episode was opened meanwhile
        setOpenError(null);
        setSelected(item);
        setLoadingId(null);
      },
      (e: any) => {
        if (requestRef.current !== request) return;
        requestRef.current = null;
        if (queuedOpenRef.current?.id === id) queuedOpenRef.current = null;
        setLoadingId(null);
        setOpenError(`Failed to open: ${e?.message ?? e}`);
        leaveEpisodeUrl();
      },
    );
  }, [pauseAll, leaveEpisodeUrl]);

  function openEpisode(id: string, wanted: Mode) {
    beginLoad(id, wanted);
    if (backPendingRef.current) queuedOpenRef.current = { id, mode: wanted };
    else pushEpisodeUrl(id, wanted);
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
  const audioSrc = selected ? audioSrcOf(selected) : null;
  const available: Mode[] = [];
  if (videoSrc) available.push('watch');
  if (audioSrc) available.push('listen');
  const mode: Mode = available.includes(playback.mode)
    ? playback.mode
    : available[0] ?? (selected && isAudioOnly(selected) ? 'listen' : 'watch');
  const showTabs = available.length > 1;

  useLayoutEffect(() => { activeModeRef.current = selected ? mode : null; }, [selected, mode]);

  // Keep ?mode= in step with what is shown (fallback rendition, tab switches) without new entries.
  useEffect(() => {
    if (!selected) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get(EPISODE_PARAM) !== selected.job_id || params.get(MODE_PARAM) === mode) return;
    params.set(MODE_PARAM, mode);
    navigate({ search: `?${params}` }, { replace: true, state: historyState() });
  }, [selected, mode, navigate, episodeParam, modeParam]);

  /** Watch ↔ Listen: pause the current medium and start the other at the same point of the conversation. */
  function switchMode(next: Mode) {
    if (!selected || next === mode || !available.includes(next)) return;
    const wasPlaying = playIntentRef.current;
    let start = 0;
    if (mode === 'watch') {
      const video = videoRef.current;
      const t = video && Number.isFinite(video.currentTime) ? video.currentTime : 0;
      video?.pause();
      start = mapRenditionTime(selected.transcript, t, 'video');
    } else {
      const radio = radioRef.current;
      const t = radio ? radio.getCurrentTime() : 0;
      radio?.pause();
      start = mapRenditionTime(selected.transcript, t, 'audio');
    }
    activeModeRef.current = next;
    const fresh = freshItemRef.current;
    freshItemRef.current = null;
    if (fresh && fresh.job_id === selected.job_id) setSelected(fresh);
    setPlayback({ mode: next, start: Math.max(0, start), autoPlay: wasPlaying });
  }

  const refreshAudio = useCallback(async (): Promise<string | null> => {
    const request = requestRef.current;
    if (!request) return null;
    try {
      const fresh = await getLibraryItem(request.id);
      if (requestRef.current !== request) return null;
      freshItemRef.current = fresh;
      return audioSrcOf(fresh);
    } catch {
      return null;
    }
  }, []);

  const onRadioPlayState = useCallback((playing: boolean) => {
    if (activeModeRef.current === 'listen') playIntentRef.current = playing;
  }, []);
  const onVideoPlayState = (playing: boolean) => {
    if (activeModeRef.current === 'watch') playIntentRef.current = playing;
  };

  const radioHosts = useMemo(
    () => (selected ? toRadioHosts(selected.hosts, avatars, selected.speaker_names ?? []) : []),
    [selected, avatars],
  );

  // ---- Admin actions ------------------------------------------------------------------
  async function togglePublish(jobId: string, next: boolean) {
    setPublishing(jobId);
    try {
      const updated = await publishLibraryItem(jobId, next);
      const published = typeof updated?.published === 'boolean' ? updated.published : next;
      setItems((prev) => prev?.map((i) => (i.job_id === jobId ? { ...i, published } : i)) ?? null);
      setSelected((prev) => (prev && prev.job_id === jobId ? { ...prev, published } : prev));
    } catch (e: any) {
      setError(`Publish update failed: ${e?.message ?? e}`);
    } finally {
      setPublishing(null);
    }
  }

  async function remove(jobId: string) {
    if (!confirm('Delete this podcast permanently?')) return;
    setDeleting(jobId);
    try {
      await deleteLibraryItem(jobId);
      setItems((prev) => prev?.filter((i) => i.job_id !== jobId) ?? null);
      if (requestRef.current?.id === jobId) closePlayer();
    } catch (e: any) {
      setError(`Delete failed: ${e?.message ?? e}`);
    } finally {
      setDeleting(null);
    }
  }

  const title = selected ? humanizeTitle(selected.title) : '';
  const audioOnlySelected = !!selected && isAudioOnly(selected);
  const formatText = audioOnlySelected ? 'Audio only' : showTabs ? 'Video + audio' : 'Video';
  const mp4Download = selected ? selected.mp4_url ?? selected.video_url ?? null : null;
  /** Visitors keep the MP4 download they always had (Watch mode); every other download is admin-only. */
  const visibleMp4 = mp4Download && (isAdmin || mode === 'watch') ? mp4Download : null;
  const mp3Download = selected ? selected.mp3_url ?? selected.audio_url ?? null : null;
  const adminDownloads = isAdmin && !!selected
    && !!(mp3Download || selected.srt_url || selected.audio_srt_url || selected.scorm_url);
  const selectedDuration = selected
    ? (mode === 'listen' ? selected.audio_duration_sec ?? selected.duration_sec : selected.duration_sec ?? selected.audio_duration_sec)
    : null;

  return (
    <div className="container page library library--podcast">
      <PageHeader
        eyebrow="Library"
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

      {openError && <Alert tone="error" className="library__alert" data-testid="library-open-error">{openError}</Alert>}
      {error && <Alert tone="error" className="library__alert">{error}</Alert>}

      {items === null ? (
        <div className="library__loading"><Spinner label="Loading podcasts…" /></div>
      ) : items.length === 0 ? (
        <LibraryEmpty isAdmin={isAdmin} />
      ) : (
        <>
          <div className="library__count eyebrow">{pluralize(items.length, 'episode')}</div>
          <EpisodeList label="Podcasts" className="library-list">
            {items.map((it, i) => {
              const rowTitle = humanizeTitle(it.title);
              const speakers = speakersOf(it);
              const audioOnly = isAudioOnly(it);
              const canWatch = hasVideo(it);
              const canListen = hasAudio(it);
              return (
                <EpisodeRow
                  key={it.job_id}
                  data-testid="library-item"
                  data-format={audioOnly ? 'audio' : 'video'}
                  className={[
                    'library-row',
                    it.thumbnail_url && 'library-row--thumb',
                    audioOnly && 'library-row--audio',
                    isAdmin && 'library-row--admin',
                  ].filter(Boolean).join(' ')}
                  num={episodeNumber(i + 1)}
                  title={rowTitle}
                  onOpen={() => openEpisode(it.job_id, audioOnly ? 'listen' : 'watch')}
                  meta={[
                    formatDate(it.created_at),
                    languageName(it.language),
                    speakers.length > 0 ? speakers.join(' & ') : null,
                    it.style ? styleLabel(it.style) : null,
                    audioOnly ? <Chip icon={AudioLines} data-testid="audio-only-chip">Audio only</Chip> : null,
                    audienceChip(it.audience_level),
                    isAdmin ? <PublishBadge published={it.published} /> : null,
                  ]}
                  kind={KIND}
                  hosts={<HostsMini hosts={hostsFor(it)} label={speakers.join(' and ') || undefined} />}
                  duration={duration(it.duration_sec ?? it.audio_duration_sec)}
                  extra={it.thumbnail_url
                    ? <img className="library-thumb" src={it.thumbnail_url} alt="" loading="lazy" />
                    : undefined}
                  actions={(
                    <>
                      <span className="library-row__play">
                        {canWatch && (
                          <Button
                            size="sm"
                            icon={MonitorPlay}
                            variant={i === 0 ? 'primary' : 'outline'}
                            aria-label={`Watch ${rowTitle}`}
                            data-testid="library-watch"
                            onClick={() => openEpisode(it.job_id, 'watch')}
                          >
                            Watch
                          </Button>
                        )}
                        {canListen && (
                          <Button
                            size="sm"
                            icon={Headphones}
                            variant={i === 0 && !canWatch ? 'primary' : 'outline'}
                            aria-label={`Listen to ${rowTitle}`}
                            data-testid="library-listen"
                            onClick={() => openEpisode(it.job_id, 'listen')}
                          >
                            Listen
                          </Button>
                        )}
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
        variant="stage"
        className={['library-player', 'library-player--podcast', showTabs && 'library-player--tabs'].filter(Boolean).join(' ')}
        data-mode={selected ? mode : undefined}
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
                <RadioPlayer
                  key={selected.job_id}
                  ref={radioRef}
                  tone="stage"
                  src={audioSrc}
                  title={title}
                  transcript={selected.transcript ?? null}
                  coverUrl={selected.cover_url ?? null}
                  hosts={radioHosts}
                  autoPlay={playback.autoPlay}
                  initialTime={playback.start}
                  onRefreshSource={refreshAudio}
                  onPlayStateChange={onRadioPlayState}
                />
              ) : videoSrc ? (
                <video
                  key={selected.job_id}
                  ref={videoRef}
                  data-testid="library-player"
                  src={videoSrc}
                  controls
                  autoPlay={playback.autoPlay}
                  onLoadedMetadata={(e) => {
                    if (playback.start > 0) {
                      try { e.currentTarget.currentTime = playback.start; } catch { /* not seekable */ }
                    }
                  }}
                  onPlay={() => onVideoPlayState(true)}
                  onPause={() => onVideoPlayState(false)}
                />
              ) : (
                <div className="library-player__status">Video unavailable</div>
              )}
            </div>
            <div className="library-player__info">
              {mode !== 'listen' && (
                <div className="eyebrow library-player__eyebrow"><Headphones aria-hidden />Podcast</div>
              )}
              {/* In Listen mode the radio player already shows the title: keep the heading for screen readers only. */}
              <h2 className={['library-player__title', mode === 'listen' && 'sr-only'].filter(Boolean).join(' ')}>{title}</h2>
              {selected.document_title && selected.document_title !== selected.title && (
                <p className="library-player__source">Source: {selected.document_title}</p>
              )}
              <div className="library-player__meta">
                <span>{formatDate(selected.created_at)}</span>
                <span>{duration(selectedDuration)}</span>
                <span>{languageName(selected.language)}</span>
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
      <EmptyState
        icon={Headphones}
        title="No published podcasts yet"
        action={(
          <div className="library__empty-actions">
            <GateNotice action="create your own podcast" />
            <ButtonLink to="/decks" icon={Layers}>Browse decks</ButtonLink>
          </div>
        )}
      >
        Check back later — podcasts appear here once a demo user publishes them.
      </EmptyState>
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
