import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Captions, Clapperboard, Clock, Download, GraduationCap, Music, Package, Play, Plus, RotateCw, Trash2,
} from 'lucide-react';
import {
  AUDIENCE_LEVEL_LABELS, LibraryItem, LibrarySummary, toAudienceLevel,
  deleteLibraryItem, getLibraryItem, listLibrary, publishLibraryItem,
} from '../services/videoApi';
import { VIDEO_DEEP_LINK_PARAM } from '../services/demoProtocol';
import { useAuth } from '../services/auth';
import { pickDefaultAvatar, useAvatars } from '../services/avatars';
import { PublishBadge, PublishToggle } from '../components/AuthGate';
import { LanguageName } from '../components/RadioPlayer';
import {
  LibraryEmpty as PublicEmpty, LibraryListError, LibraryOpenError, actionFailureMessage, describeOpenFailure,
  type OpenFailure,
} from '../playback/libraryStates';
import { VideoProblem, VideoReconnecting, useVideoRecovery } from '../playback/videoRecovery';
import { useSuppressMiniPlayer } from '../playback/PlaybackProvider';
import {
  Alert, Button, ButtonLink, Chip, EmptyState, EpisodeList, EpisodeRow, HostsMini, Modal, PageHeader, Spinner,
  buttonClass, episodeNumber, formatDate, formatDuration, recordingTitle, langAttr, languageName, pluralize,
} from '../ui';
import '../styles/pages/library.css';

const KIND = { icon: Clapperboard, label: 'Narrated video' };

/**
 * Deep link: `/video/library?video=<job_id>` opens that video's player (the live-demo recordings link here). `?job=` is
 * the older spelling (the studio's "Open in library") and keeps working.
 */
const LEGACY_PARAM = 'job';
/** History state of the entry pushed by opening a video from the list: closing the player pops it, so Back and Escape agree. */
const OPENED_VIDEO = 'libraryVideo';
/** Row thumbnail box (16:9 at its desktop width): the reserved space keeps the list from shifting as images arrive. */
const THUMB_WIDTH = 120;
const THUMB_HEIGHT = 68;

const duration = (sec: number | null | undefined) => (sec && sec > 0 ? formatDuration(sec) : '—');
function audienceChip(level: unknown) {
  const lvl = toAudienceLevel(level);
  return lvl ? <Chip icon={GraduationCap} data-testid="audience-chip">{AUDIENCE_LEVEL_LABELS[lvl]} audience</Chip> : null;
}

/** Navigation state of the current history entry (React Router stores it under `usr`). */
function historyState(): Record<string, unknown> | null {
  const usr = (window.history.state as { usr?: unknown } | null)?.usr;
  return usr && typeof usr === 'object' ? (usr as Record<string, unknown>) : null;
}

const videoIdOf = (params: URLSearchParams) => params.get(VIDEO_DEEP_LINK_PARAM) || params.get(LEGACY_PARAM) || null;

export default function VideoLibraryPage() {
  const auth = useAuth();
  const isAdmin = auth.is_admin;
  const { avatars } = useAvatars();
  const host = pickDefaultAvatar(avatars);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const videoParam = videoIdOf(searchParams);

  const [publishing, setPublishing] = useState<string | null>(null);
  const [items, setItems] = useState<LibrarySummary[] | null>(null);
  /** The list request failed (`items` stays what it was: null on the first load). Never the same as an empty list. */
  const [listError, setListError] = useState<unknown>(null);
  /** An admin action (publish, delete) failed. */
  const [actionError, setActionError] = useState<string | null>(null);
  const [selected, setSelected] = useState<LibraryItem | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  /** A failed open (gone, storage down, offline); the list stays in view next to it. */
  const [openError, setOpenError] = useState<OpenFailure | null>(null);
  /** "Listen instead" (the narration audio, for admins): replaces a video that cannot play. */
  const [audioOnly, setAudioOnly] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const titleId = useId();

  const navigateRef = useRef(navigate);
  const pathRef = useRef(window.location.pathname);
  /** Latest open request: responses for any other (closed / superseded) request are ignored. */
  const requestRef = useRef<{ id: string } | null>(null);
  /** Closing went back one history entry and that traversal (popstate) has not landed yet. */
  const backPendingRef = useRef(false);
  const backTimerRef = useRef<number | undefined>(undefined);
  /** Video opened while that back was in flight: its URL is pushed once the back has landed. */
  const queuedOpenRef = useRef<string | null>(null);

  useLayoutEffect(() => { navigateRef.current = navigate; });

  // Same rule as the podcast Watch path: the mini-player stays hidden behind any video dialog.
  useSuppressMiniPlayer(!!(selected || loadingId));

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
  const closeLocal = useCallback(() => {
    requestRef.current = null;
    queuedOpenRef.current = null;
    setSelected(null);
    setLoadingId(null);
    setAudioOnly(false);
  }, []);

  const pushVideoUrl = useCallback((id: string) => {
    navigateRef.current({ search: `?${VIDEO_DEEP_LINK_PARAM}=${encodeURIComponent(id)}` }, { state: { [OPENED_VIDEO]: id } });
  }, []);

  /** Our back traversal landed (or never will): push the URL of a video opened meanwhile. */
  const settleBack = useCallback((): boolean => {
    if (!backPendingRef.current) return false;
    backPendingRef.current = false;
    window.clearTimeout(backTimerRef.current);
    const queued = queuedOpenRef.current;
    queuedOpenRef.current = null;
    if (queued && requestRef.current?.id === queued) pushVideoUrl(queued);
    return true;
  }, [pushVideoUrl]);

  /** Drops ?video / ?job: pops the entry pushed by an in-app open (Back and Escape agree), else replaces a deep link. */
  const leaveVideoUrl = useCallback(() => {
    if (backPendingRef.current) return; // already leaving this entry
    const params = new URLSearchParams(window.location.search);
    const id = videoIdOf(params);
    if (!id) return;
    if (historyState()?.[OPENED_VIDEO] === id) {
      // history.back() is asynchronous: an open before it lands must not push in between.
      backPendingRef.current = true;
      window.clearTimeout(backTimerRef.current);
      backTimerRef.current = window.setTimeout(settleBack, 3000);
      navigateRef.current(-1);
      return;
    }
    params.delete(VIDEO_DEEP_LINK_PARAM);
    params.delete(LEGACY_PARAM);
    const search = params.toString();
    navigateRef.current({ search: search ? `?${search}` : '' }, { replace: true });
  }, [settleBack]);

  /** Fetches the item afresh and shows its player (every open is a fresh fetch: the signed URLs are minted per request). */
  const beginLoad = useCallback((id: string) => {
    const request = { id };
    requestRef.current = request;
    setOpenError(null);
    setSelected(null);
    setAudioOnly(false);
    setLoadingId(id);
    getLibraryItem(id).then(
      (item) => {
        if (requestRef.current !== request) return; // closed, or another video was opened meanwhile
        setSelected(item);
        setLoadingId(null);
      },
      (e: unknown) => {
        if (requestRef.current !== request) return;
        requestRef.current = null;
        if (queuedOpenRef.current === id) queuedOpenRef.current = null;
        setLoadingId(null);
        setOpenError(describeOpenFailure(e, id, 'video'));
        leaveVideoUrl();
      },
    );
  }, [leaveVideoUrl]);

  function openVideo(id: string) {
    beginLoad(id);
    if (backPendingRef.current) queuedOpenRef.current = id;
    else pushVideoUrl(id);
  }

  // Stable identity: the Modal re-runs its focus handling whenever onClose changes.
  const closePlayer = useCallback(() => {
    closeLocal();
    leaveVideoUrl();
  }, [closeLocal, leaveVideoUrl]);

  /** Opens / closes the player to match the address bar (deep links, back / forward). */
  const syncFromUrl = useCallback(() => {
    if (backPendingRef.current) return; // settled by the popstate of our own back()
    if (window.location.pathname !== pathRef.current) return; // leaving the page
    const id = videoIdOf(new URLSearchParams(window.location.search));
    if (!id) {
      if (requestRef.current) closeLocal();
      return;
    }
    if (requestRef.current?.id === id) return; // already open or loading
    beginLoad(id);
  }, [beginLoad, closeLocal]);

  // Back / forward act on popstate directly: the router's transition may coalesce a push and a pop.
  useEffect(() => {
    const onPopState = () => {
      if (!settleBack()) syncFromUrl();
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [settleBack, syncFromUrl]);

  // Initial deep link and any other change of the query (idempotent with the handler above).
  useEffect(() => { syncFromUrl(); }, [videoParam, syncFromUrl]);

  // Leaving the page invalidates any in-flight open (no late navigation from a stale response).
  useEffect(() => () => {
    requestRef.current = null;
    queuedOpenRef.current = null;
    backPendingRef.current = false;
    window.clearTimeout(backTimerRef.current);
  }, []);

  /** "Try again" on a failed open: the video is fetched afresh. */
  function retryOpen() {
    if (!openError) return;
    const { id } = openError;
    setOpenError(null);
    openVideo(id);
  }

  /** "Back to all videos": the gone video's alert goes, focus lands on the list. */
  function dismissOpenError() {
    setOpenError(null);
    const first = document.querySelector<HTMLElement>('.library-list .episode-row__title');
    (first ?? document.getElementById('main'))?.focus();
  }

  // One automatic refresh of an expired / failing video link, then "Try again" (and "Listen instead" with audio).
  const recovery = useVideoRecovery<LibraryItem>({
    jobId: selected && !audioOnly ? selected.job_id : null,
    fetchFresh: getLibraryItem,
    apply: (fresh) => setSelected((prev) => (prev && prev.job_id === fresh.job_id ? fresh : prev)),
  });

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
    if (!confirm('Delete this video permanently?')) return;
    setDeleting(jobId);
    try {
      await deleteLibraryItem(jobId);
      setItems((prev) => prev?.filter((i) => i.job_id !== jobId) ?? null);
      if (requestRef.current?.id === jobId) closePlayer();
    } catch (e: unknown) {
      setActionError(actionFailureMessage(e, 'Delete'));
    } finally {
      setDeleting(null);
    }
  }

  const title = selected ? recordingTitle(selected.title) : '';
  const titleLang = langAttr(selected?.language);
  const listenInstead = selected?.audio_url
    ? { label: 'Listen instead', onClick: () => setAudioOnly(true) }
    : undefined;

  return (
    <div className="container page library">
      <PageHeader
        title="Videos"
        lead={isAdmin
          ? "Narrated slide videos you've generated. Publish a video to make it visible to anonymous visitors."
          : 'Published narrated slide videos, presented by our AI host. Pick an episode to play it.'}
        actions={(
          <>
            <Button variant="ghost" icon={RotateCw} onClick={refresh}>Refresh</Button>
            {isAdmin && <ButtonLink to="/video" variant="primary" icon={Plus}>Create video</ButtonLink>}
          </>
        )}
      />

      {openError && (
        <LibraryOpenError failure={openError} onRetry={retryOpen} onDismiss={dismissOpenError} backLabel="Back to all videos" />
      )}
      {actionError && <Alert tone="error" className="library__alert">{actionError}</Alert>}
      {/* A refresh that failed while a list is on screen keeps the list; a first load that failed shows the failure instead of it. */}
      {listError != null && items !== null && (
        <LibraryListError error={listError} what="the videos" onRetry={refresh} library="video" withLinks={false} />
      )}

      {items === null && listError != null ? (
        <LibraryListError error={listError} what="the videos" onRetry={refresh} library="video" />
      ) : items === null ? (
        <div className="library__loading"><Spinner label="Loading videos…" /></div>
      ) : items.length === 0 ? (
        <LibraryEmpty isAdmin={isAdmin} />
      ) : (
        <>
          <div className="library__count eyebrow">{pluralize(items.length, 'episode')}</div>
          <EpisodeList label="Videos" className="library-list">
            {items.map((it, i) => {
              const rowTitle = recordingTitle(it.title);
              return (
                <EpisodeRow
                  key={it.job_id}
                  data-testid="library-item"
                  className={['library-row', it.thumbnail_url && 'library-row--thumb', isAdmin && 'library-row--admin'].filter(Boolean).join(' ')}
                  num={episodeNumber(i + 1)}
                  title={rowTitle}
                  lang={it.language}
                  level={toAudienceLevel(it.audience_level)}
                  onOpen={() => openVideo(it.job_id)}
                  meta={[
                    formatDate(it.created_at),
                    <LanguageName code={it.language} />,
                    typeof it.slide_count === 'number' ? pluralize(it.slide_count, 'slide') : null,
                    // The duration column is hidden on phones (library.css): the same length rides the meta line there.
                    it.duration_sec && it.duration_sec > 0 ? (
                      <span className="library-row__duration" data-testid="library-duration">
                        <Clock aria-hidden /><span className="sr-only">Duration </span>{formatDuration(it.duration_sec)}
                      </span>
                    ) : null,
                    isAdmin ? <PublishBadge published={it.published} /> : null,
                  ]}
                  kind={KIND}
                  hosts={<HostsMini hosts={[host]} />}
                  duration={duration(it.duration_sec)}
                  extra={it.thumbnail_url
                    ? <img className="library-thumb" src={it.thumbnail_url} alt="" width={THUMB_WIDTH} height={THUMB_HEIGHT} loading="lazy" decoding="async" />
                    : undefined}
                  actions={(
                    <>
                      <Button
                        size="sm"
                        iconOnly
                        icon={Play}
                        variant="primary"
                        aria-label={`Play ${rowTitle}`}
                        onClick={() => openVideo(it.job_id)}
                      />
                      {isAdmin && (
                        <>
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
                        </>
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
        label={selected ? title : 'Loading video'}
        aria-labelledby={selected && !loadingId ? titleId : undefined}
        variant="stage"
        className="library-player"
      >
        {loadingId || !selected ? (
          <div className="library-player__status"><Spinner label="Loading video…" /></div>
        ) : (
          <>
            <div className="library-player__screen">
              {audioOnly && selected.audio_url ? (
                <div className="library-player__status">
                  <audio data-testid="library-audio" data-oz-media="audio" src={selected.audio_url} controls autoPlay />
                </div>
              ) : (
                <>
                  {selected.video_url && (
                    <video
                      key={`${selected.job_id}:${recovery.generation}`}
                      hidden={recovery.fault !== null}
                      data-testid="library-player"
                      data-oz-media="video"
                      src={selected.video_url}
                      controls
                      autoPlay={recovery.resume ? recovery.resume.play : true}
                      onLoadedMetadata={(e) => {
                        const start = recovery.resume?.time ?? 0;
                        if (start > 0) {
                          try { e.currentTarget.currentTime = start; } catch { /* not seekable */ }
                        }
                      }}
                      onPlay={(e) => recovery.track(e.currentTarget, true)}
                      onPause={(e) => recovery.track(e.currentTarget, false)}
                      onTimeUpdate={(e) => recovery.track(e.currentTarget)}
                      onError={recovery.onError}
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
                  {recovery.fault === 'refreshing' && <VideoReconnecting />}
                  {recovery.fault !== 'refreshing' && (!selected.video_url || recovery.fault === 'failed') && (
                    <VideoProblem kind={selected.video_url ? 'failed' : 'unavailable'} onRetry={recovery.retry} instead={listenInstead} />
                  )}
                </>
              )}
            </div>
            <div className="library-player__info">
              <div className="eyebrow library-player__eyebrow"><Clapperboard aria-hidden />Narrated video</div>
              <h2 id={titleId} lang={titleLang} className="library-player__title">{title}</h2>
              <div className="library-player__meta">
                <span>{formatDate(selected.created_at)}</span>
                <span>{duration(selected.duration_sec)}</span>
                <LanguageName code={selected.language} />
                {typeof selected.slide_count === 'number' && <span>{pluralize(selected.slide_count, 'slide')}</span>}
                {audienceChip(selected.audience_level)}
              </div>
              <div className="library-player__downloads">
                {selected.video_url && recovery.fault === null && (
                  <a href={selected.video_url} download={`${selected.title}.mp4`} className={buttonClass({ variant: 'primary', size: 'sm' })}>
                    <Download aria-hidden />Download MP4
                  </a>
                )}
                {selected.audio_url && (
                  <a href={selected.audio_url} download={`${selected.title}.mp3`} className={buttonClass({ size: 'sm' })}>
                    <Music aria-hidden />Audio MP3
                  </a>
                )}
                {selected.srt_url && (
                  <a href={selected.srt_url} download={`${selected.title}.srt`} className={buttonClass({ size: 'sm' })}>
                    <Captions aria-hidden />Subtitles SRT
                  </a>
                )}
                {selected.scorm_url && (
                  <a href={selected.scorm_url} download={`${selected.title}-scorm.zip`} className={buttonClass({ size: 'sm' })}>
                    <Package aria-hidden />SCORM package
                  </a>
                )}
              </div>
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
      <PublicEmpty icon={Clapperboard} title="No videos are published yet" library="video">
        Videos appear here as soon as they are published. In the meantime:
      </PublicEmpty>
    );
  }
  return (
    <EmptyState
      icon={Clapperboard}
      title="No videos yet"
      action={<ButtonLink to="/video" variant="primary" icon={Plus}>Create video</ButtonLink>}
    >
      Head to the video generator and create your first one — it will show up here.
    </EmptyState>
  );
}
