import { useCallback, useEffect, useState } from 'react';
import {
  Captions, Clapperboard, Download, GraduationCap, Layers, Music, Package, Play, Plus, RotateCw, Trash2,
} from 'lucide-react';
import {
  AUDIENCE_LEVEL_LABELS, LibraryItem, LibrarySummary, toAudienceLevel,
  deleteLibraryItem, getLibraryItem, listLibrary, publishLibraryItem,
} from '../services/videoApi';
import { useAuth } from '../services/auth';
import { pickDefaultAvatar, useAvatars } from '../services/avatars';
import { GateNotice, PublishBadge, PublishToggle } from '../components/AuthGate';
import {
  Alert, Button, ButtonLink, Chip, EmptyState, EpisodeList, EpisodeRow, HostsMini, Modal, PageHeader, Spinner,
  buttonClass, episodeNumber, formatDate, formatDuration, humanizeTitle, languageName, pluralize,
} from '../ui';
import '../styles/pages/library.css';

const KIND = { icon: Clapperboard, label: 'Narrated video' };

const duration = (sec: number | null | undefined) => (sec && sec > 0 ? formatDuration(sec) : '—');
function audienceChip(level: unknown) {
  const lvl = toAudienceLevel(level);
  return lvl ? <Chip icon={GraduationCap} data-testid="audience-chip">{AUDIENCE_LEVEL_LABELS[lvl]} audience</Chip> : null;
}

export default function VideoLibraryPage() {
  const auth = useAuth();
  const isAdmin = auth.is_admin;
  const { avatars } = useAvatars();
  const host = pickDefaultAvatar(avatars);
  const [publishing, setPublishing] = useState<string | null>(null);
  const [items, setItems] = useState<LibrarySummary[] | null>(null);
  const [selected, setSelected] = useState<LibraryItem | null>(null);
  const [loadingItem, setLoadingItem] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

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

  // Auto-open via ?job=<id>
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const jid = q.get('job');
    if (jid) open(jid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function open(jobId: string) {
    setLoadingItem(true);
    try {
      const item = await getLibraryItem(jobId);
      setSelected(item);
    } catch (e: any) {
      setError(`Failed to open: ${e?.message ?? e}`);
    } finally {
      setLoadingItem(false);
    }
  }

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
    if (!confirm('Delete this video permanently?')) return;
    setDeleting(jobId);
    try {
      await deleteLibraryItem(jobId);
      setItems((prev) => prev?.filter((i) => i.job_id !== jobId) ?? null);
      if (selected?.job_id === jobId) setSelected(null);
    } catch (e: any) {
      setError(`Delete failed: ${e?.message ?? e}`);
    } finally {
      setDeleting(null);
    }
  }

  const closePlayer = useCallback(() => setSelected(null), []);

  return (
    <div className="container page library">
      <PageHeader
        eyebrow="Library"
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

      {error && <Alert tone="error" className="library__alert">{error}</Alert>}

      {items === null ? (
        <div className="library__loading"><Spinner label="Loading videos…" /></div>
      ) : items.length === 0 ? (
        <LibraryEmpty isAdmin={isAdmin} />
      ) : (
        <>
          <div className="library__count eyebrow">{pluralize(items.length, 'episode')}</div>
          <EpisodeList label="Videos" className="library-list">
            {items.map((it, i) => {
              const title = humanizeTitle(it.title);
              return (
                <EpisodeRow
                  key={it.job_id}
                  data-testid="library-item"
                  className={['library-row', it.thumbnail_url && 'library-row--thumb', isAdmin && 'library-row--admin'].filter(Boolean).join(' ')}
                  num={episodeNumber(i + 1)}
                  title={title}
                  onOpen={() => open(it.job_id)}
                  meta={[
                    formatDate(it.created_at),
                    languageName(it.language),
                    typeof it.slide_count === 'number' ? pluralize(it.slide_count, 'slide') : null,
                    audienceChip(it.audience_level),
                    isAdmin ? <PublishBadge published={it.published} /> : null,
                  ]}
                  kind={KIND}
                  hosts={<HostsMini hosts={[host]} />}
                  duration={duration(it.duration_sec)}
                  extra={it.thumbnail_url
                    ? <img className="library-thumb" src={it.thumbnail_url} alt="" loading="lazy" />
                    : undefined}
                  actions={(
                    <>
                      <Button
                        size="sm"
                        iconOnly
                        icon={Play}
                        variant={i === 0 ? 'primary' : 'outline'}
                        aria-label={`Play ${title}`}
                        onClick={() => open(it.job_id)}
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
                            aria-label={`Delete ${title}`}
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
        open={!!(selected || loadingItem)}
        onClose={closePlayer}
        label={selected ? humanizeTitle(selected.title) : 'Loading video'}
        variant="stage"
        className="library-player"
      >
        {loadingItem || !selected ? (
          <div className="library-player__status"><Spinner label="Loading video…" /></div>
        ) : (
          <>
            <div className="library-player__screen">
              {selected.video_url ? (
                <video data-testid="library-player" data-oz-media="video" src={selected.video_url} controls autoPlay />
              ) : (
                <div className="library-player__status">Video unavailable</div>
              )}
            </div>
            <div className="library-player__info">
              <div className="eyebrow library-player__eyebrow"><Clapperboard aria-hidden />Narrated video</div>
              <h2 className="library-player__title">{humanizeTitle(selected.title)}</h2>
              <div className="library-player__meta">
                <span>{formatDate(selected.created_at)}</span>
                <span>{duration(selected.duration_sec)}</span>
                <span>{languageName(selected.language)}</span>
                {typeof selected.slide_count === 'number' && <span>{pluralize(selected.slide_count, 'slide')}</span>}
                {audienceChip(selected.audience_level)}
              </div>
              <div className="library-player__downloads">
                {selected.video_url && (
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
      <EmptyState
        icon={Clapperboard}
        title="No published videos yet"
        action={(
          <div className="library__empty-actions">
            <GateNotice action="generate your own avatar video" />
            <ButtonLink to="/decks" icon={Layers}>Browse decks</ButtonLink>
          </div>
        )}
      >
        Check back later — videos appear here once a demo user publishes them.
      </EmptyState>
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
