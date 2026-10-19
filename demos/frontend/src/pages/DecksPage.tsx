import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Eye, Headphones, Layers, Mic, Play, Radio, Trash2 } from 'lucide-react';
import { Deck, deleteDeck, listDecks, publishDeck, setDeckLiveDemo, uploadDeck } from '../services/decksApi';
import { useAuth } from '../services/auth';
import { type AvatarInfo, pickDefaultAvatar, useAvatars } from '../services/avatars';
import {
  DEMO_LIVE_LABEL, DEMO_RECORDED_LABEL, GateNotice, LiveDemoBadge, LiveDemoToggle, PublishBadge, PublishToggle,
  liveSessionsLeft, recordedDemoReason, useDemoEntry, type DemoEntry,
} from '../components/AuthGate';
import {
  Alert, Button, ButtonLink, Chip, Dropzone, EmptyState, EpisodeList, EpisodeRow, HostDisc, HostsMini, PageHeader,
  SectionHead, Spinner, episodeNumber, formatDate, humanizeTitle, langAttr, languageName, loadErrorMessage, pluralize,
} from '../ui';
import '../styles/pages/decks.css';

const PPTX_ACCEPT = '.pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation';
// "Live presentation" only labels a deck whose live demo can be started; the other decks are slides.
const DECK_LIVE = { icon: Mic, label: 'Live presentation' };
const DECK_SLIDES = { icon: Layers, label: 'Slides' };

/** The live-demo entry of the page: final from the first paint (boot block), a same-size skeleton while it is read. */
function DemoBanner({ entry, host }: { entry: DemoEntry; host: AvatarInfo | undefined }) {
  if (entry.kind === 'pending') {
    return <div className="decks-demo decks-demo--pending" data-testid="demo-cta-skeleton" aria-hidden />;
  }
  const live = entry.kind === 'live';
  const hostName = host?.display_name;
  return (
    <Link to={entry.to} data-testid="try-live-demo-cta" className="decks-demo">
      {host && <HostDisc host={host} size={72} speaking={live} label="" className="decks-demo__disc" />}
      <span className="decks-demo__copy">
        {live
          ? <Chip tone="clay" icon={Radio} className="decks-demo__tag">Live demo · no sign-in</Chip>
          : <Chip className="decks-demo__tag">Recorded demo</Chip>}
        <span className="decks-demo__title">{live ? DEMO_LIVE_LABEL : DEMO_RECORDED_LABEL}</span>
        <span className="decks-demo__text">
          {live ? (
            <>
              {hostName ? `Watch ${hostName}, the real-time avatar, narrate` : 'Watch the real-time avatar narrate'}
              {' '}<em lang={langAttr(entry.deckLanguage)}>{humanizeTitle(entry.deckTitle)}</em>.
            </>
          ) : `${recordedDemoReason(entry.reason)} The recording shows the same demo.`}
        </span>
        {live && entry.remaining !== null && (
          <span className="decks-demo__quota" data-testid="decks-demo-quota">{liveSessionsLeft(entry.remaining)}</span>
        )}
      </span>
      <ArrowRight aria-hidden className="decks-demo__arrow" />
    </Link>
  );
}

export default function DecksPage() {
  const [decks, setDecks] = useState<Deck[] | null>(null);
  // A failed list is not an empty list: it keeps its reason (only ever read through loadErrorMessage) and a retry.
  const [loadFailure, setLoadFailure] = useState<{ reason: unknown } | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const auth = useAuth();
  const isAdmin = auth.is_admin;
  const [publishing, setPublishing] = useState<string | null>(null);
  const [liveBusy, setLiveBusy] = useState<string | null>(null);
  const entry = useDemoEntry();
  const liveNow = entry.kind === 'live';
  const { avatars } = useAvatars();
  const host = pickDefaultAvatar(avatars);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      setDecks(await listDecks());
      setLoadFailure(null);
    } catch (e) {
      setLoadFailure({ reason: e });
    }
  }, []);

  // Re-fetch once identity is known: admins also see drafts.
  useEffect(() => { if (!auth.loading) refresh(); }, [refresh, auth.loading, auth.is_admin]);

  async function retry() {
    setRetrying(true);
    await refresh();
    setRetrying(false);
  }

  async function handleTogglePublish(deckId: string, next: boolean) {
    setPublishing(deckId);
    try {
      const updated = await publishDeck(deckId, next);
      const published = typeof updated?.published === 'boolean' ? updated.published : next;
      // Unpublishing also switches the live demo off server-side.
      const live_demo = typeof updated?.live_demo === 'boolean' ? updated.live_demo : (published ? undefined : false);
      setDecks((prev) => prev?.map((d) => (d.deck_id === deckId
        ? { ...d, published, ...(live_demo === undefined ? {} : { live_demo }) }
        : d)) ?? null);
    } catch (e: any) {
      setError(`Publish update failed: ${e?.message ?? e}`);
    } finally {
      setPublishing(null);
    }
  }

  async function handleToggleLiveDemo(deckId: string, next: boolean) {
    setLiveBusy(deckId);
    try {
      const updated = await setDeckLiveDemo(deckId, next);
      const live_demo = typeof updated?.live_demo === 'boolean' ? updated.live_demo : next;
      setDecks((prev) => prev?.map((d) => (d.deck_id === deckId ? { ...d, live_demo } : d)) ?? null);
    } catch (e: any) {
      setError(`Live demo update failed: ${e?.message ?? e}`);
    } finally {
      setLiveBusy(null);
    }
  }

  async function handleFile(file: File) {
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      await uploadDeck(file);
      await refresh();
    } catch (e: any) {
      setError(`Upload failed: ${e?.message ?? e}`);
    } finally {
      setUploading(false);
    }
  }

  async function handleDelete(deckId: string) {
    if (!confirm('Delete this deck? This cannot be undone.')) return;
    setDeleting(deckId);
    try { await deleteDeck(deckId); await refresh(); }
    catch (e: any) { setError(`Delete failed: ${e?.message ?? e}`); }
    finally { setDeleting(null); }
  }

  // The rows wait for the demo entry too, so a row's button never flips from "View slides" to "Start the live demo".
  const rowsReady = decks !== null && (isAdmin || entry.kind !== 'pending');
  const hasDecks = decks !== null && decks.length > 0;

  return (
    <div className="container page decks-page">
      <PageHeader
        title="Decks"
        lead={isAdmin
          ? 'Upload .pptx files to make them searchable and presentable by the avatar. Publish a deck to make it visible to anonymous visitors.'
          : 'Browse the published decks slide by slide.'}
      />

      {!isAdmin && <DemoBanner entry={entry} host={host} />}

      {isAdmin && (
        <Dropzone
          className="decks-upload"
          onFile={handleFile}
          accept={PPTX_ACCEPT}
          busy={uploading}
          title="Drop a .pptx here or click to browse"
          busyTitle="Uploading…"
          hint="We'll extract slides, index them for search, and keep them ready to present."
          inputProps={{ 'data-testid': 'deck-upload-input', accept: PPTX_ACCEPT }}
        />
      )}

      {error && <Alert tone="error" className="decks-alert">{error}</Alert>}

      {loadFailure && (
        <Alert tone="error" className="decks-alert" data-testid="decks-load-error">
          <div className="cluster">
            <span>{loadErrorMessage(loadFailure.reason, 'the decks')}</span>
            <Button size="sm" onClick={retry} busy={retrying}>Try again</Button>
          </div>
        </Alert>
      )}

      {loadFailure && !hasDecks ? (
        <div className="decks-actions" role="group" aria-label="Meanwhile">
          <ButtonLink to="/podcast/library" icon={Headphones}>Listen to an episode</ButtonLink>
        </div>
      ) : decks === null ? (
        <div className="decks-state"><Spinner label="Loading decks…" /></div>
      ) : decks.length === 0 ? (
        <EmptyState
          icon={Layers}
          title={isAdmin ? 'No decks yet' : 'No published decks yet'}
          action={isAdmin ? undefined : <ButtonLink to="/podcast/library" icon={Headphones}>Listen to an episode</ButtonLink>}
        >
          {isAdmin ? 'Upload a .pptx above to get started.' : 'Decks appear here once the owner publishes them. The live demo and the episodes are ready now.'}
        </EmptyState>
      ) : !rowsReady ? (
        <div className="decks-state"><Spinner label="Loading decks…" /></div>
      ) : (
        <section aria-labelledby="decks-list-title">
          <SectionHead
            title={<span id="decks-list-title">{isAdmin ? 'All decks' : 'Published decks'}</span>}
            aside={pluralize(decks.length, 'deck')}
          />
          <EpisodeList label="Decks" className="decks-list">
            {decks.map((d, i) => {
              const title = humanizeTitle(d.title);
              const to = `/decks/${d.deck_id}/present`;
              const live = !!d.live_demo && (isAdmin || liveNow);
              const tags = d.tags && d.tags.length > 0 ? (
                <span className="decks-tags">
                  {d.tags.map((t) => <span key={t} className="decks-tag">#{t}</span>)}
                </span>
              ) : null;
              const extra = isAdmin ? (
                <>
                  <PublishBadge published={d.published} />
                  <LiveDemoBadge liveDemo={d.live_demo} />
                  <span className="decks-toggles">
                    <PublishToggle
                      published={d.published}
                      busy={publishing === d.deck_id}
                      onToggle={(next) => handleTogglePublish(d.deck_id, next)}
                    />
                    <LiveDemoToggle
                      liveDemo={d.live_demo}
                      published={d.published}
                      busy={liveBusy === d.deck_id}
                      onToggle={(next) => handleToggleLiveDemo(d.deck_id, next)}
                    />
                  </span>
                </>
              ) : live ? <LiveDemoBadge liveDemo={d.live_demo} /> : null;
              return (
                <EpisodeRow
                  key={d.deck_id}
                  data-testid="deck-card"
                  num={episodeNumber(i + 1)}
                  title={title}
                  to={to}
                  titleProps={{ title: d.title }}
                  level={d.audience_level}
                  lang={d.language}
                  meta={[
                    pluralize(d.slide_count, 'slide'),
                    languageName(d.language),
                    formatDate(d.uploaded_at),
                    tags,
                  ]}
                  kind={live ? DECK_LIVE : DECK_SLIDES}
                  hosts={host ? <HostsMini hosts={[host]} /> : null}
                  extra={extra}
                  actions={(
                    <>
                      <ButtonLink
                        to={to}
                        size="sm"
                        data-testid="deck-open"
                        variant={live ? 'primary' : 'outline'}
                        icon={isAdmin ? Mic : live ? Play : Eye}
                      >
                        {isAdmin ? 'Present' : live ? DEMO_LIVE_LABEL : 'View slides'}
                      </ButtonLink>
                      {isAdmin && (
                        <Button
                          size="sm"
                          variant="danger"
                          iconOnly
                          icon={Trash2}
                          aria-label={`Delete deck ${title}`}
                          title="Delete deck"
                          busy={deleting === d.deck_id}
                          onClick={() => handleDelete(d.deck_id)}
                        />
                      )}
                    </>
                  )}
                />
              );
            })}
          </EpisodeList>
        </section>
      )}

      {!auth.loading && !isAdmin && (
        <GateNotice action="upload decks and let the live avatar present them" className="decks-gate" />
      )}
    </div>
  );
}
