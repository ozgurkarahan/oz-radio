import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle, ArrowDown, ArrowUp, CheckCircle2, ListMusic, Play, Plus, RefreshCw, Sparkles, Trash2, X,
} from 'lucide-react';
import {
  Deck, listDecks,
  PlaylistSummary, PlaylistStepInput, listPlaylists, createPlaylist, deletePlaylist,
  RecommendResponse, RecommendedStep, recommendPlaylist,
} from '../services/decksApi';
import { useAuth } from '../services/auth';
import { GatedPanel } from '../components/AuthGate';
import {
  Alert, Button, Chip, EmptyState, EpisodeList, EpisodeRow, Field, Input, Modal, PageHeader, SectionHead, Select,
  Spinner, Textarea, episodeNumber, formatDate, humanizeTitle, languageName, pluralize,
} from '../ui';
import '../styles/pages/playlists.css';

const PLAYLIST_KIND = { icon: ListMusic, label: 'Playlist' };

export default function PlaylistsPage() {
  const auth = useAuth();
  if (auth.loading) {
    return <div className="container page playlists-state"><Spinner label="Loading…" /></div>;
  }
  if (!auth.is_admin) {
    return (
      <div className="container page">
        <h1 className="sr-only">Playlists</h1>
        <GatedPanel
          icon={ListMusic}
          title="Playlists are for the site owner"
          description="The owner creates playlists, gets AI recommendations and follows a series of decks. You can start the live demo of a published deck without signing in, or browse the decks and videos."
          action="build and follow playlists"
          links={[{ href: '/decks', label: 'Browse the decks' }, { href: '/video/library', label: 'Browse the video library' }]}
        />
      </div>
    );
  }
  return <PlaylistsList />;
}

function PlaylistsList() {
  const navigate = useNavigate();
  const [playlists, setPlaylists] = useState<PlaylistSummary[] | null>(null);
  const [decks, setDecks] = useState<Deck[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showRecommend, setShowRecommend] = useState(false);
  const [prefill, setPrefill] = useState<RecommendResponse | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [pp, dd] = await Promise.all([listPlaylists(), listDecks()]);
      setPlaylists(pp);
      setDecks(dd);
    } catch (e: any) {
      setError(String(e?.message ?? e));
      setPlaylists([]);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  async function handleDelete(id: string, title: string) {
    if (!confirm(`Delete playlist "${title}"?`)) return;
    setDeleting(id);
    try {
      await deletePlaylist(id);
      await refresh();
    } catch (e: any) {
      setError(`Delete failed: ${e?.message ?? e}`);
    } finally {
      setDeleting(null);
    }
  }

  const noDecks = decks.length === 0;
  const closeCreate = useCallback(() => { setShowCreate(false); setPrefill(null); }, []);
  const closeRecommend = useCallback(() => setShowRecommend(false), []);

  return (
    <div className="container page playlists-page">
      <PageHeader
        back={{ to: '/', label: 'Back to home' }}
        eyebrow="Playlists"
        title="Playlists of decks"
        lead="Chain multiple decks into an ordered playlist. Viewers resume where they left off, progress is tracked."
        actions={(
          <>
            <Button
              icon={Sparkles}
              onClick={() => setShowRecommend(true)}
              data-testid="recommend-playlist-btn"
              disabled={noDecks}
            >
              Recommend with AI
            </Button>
            <Button variant="primary" icon={Plus} onClick={() => setShowCreate(true)} disabled={noDecks}>
              Create playlist
            </Button>
          </>
        )}
      />

      {error && <Alert tone="error" className="playlists-alert">{error}</Alert>}

      {playlists === null && <div className="playlists-state"><Spinner label="Loading playlists…" /></div>}

      {playlists && playlists.length === 0 && (
        <EmptyState icon={ListMusic} title="No playlists yet">
          {noDecks
            ? 'Upload some decks first, then you can chain them into a playlist.'
            : 'Use “Create playlist” to combine 2 or more decks into an ordered sequence.'}
        </EmptyState>
      )}

      {playlists && playlists.length > 0 && (
        <section aria-labelledby="playlists-list-title">
          <SectionHead
            title={<span id="playlists-list-title">Your playlists</span>}
            aside={pluralize(playlists.length, 'playlist')}
          />
          <EpisodeList label="Playlists" className="playlists-list">
            {playlists.map((p, i) => {
              const broken = p.status === 'broken';
              const title = humanizeTitle(p.title);
              return (
                <EpisodeRow
                  key={p.id}
                  data-testid="playlist-card"
                  className={broken ? 'playlists-row is-broken' : 'playlists-row'}
                  num={episodeNumber(i + 1)}
                  title={title}
                  to={broken ? undefined : `/playlists/${p.id}`}
                  meta={[
                    broken
                      ? <Chip tone="danger" icon={AlertTriangle}>Broken</Chip>
                      : <Chip tone="sage" icon={CheckCircle2}>Active</Chip>,
                    pluralize(p.step_count, 'deck'),
                    formatDate(p.updated_at || p.created_at),
                  ]}
                  extra={p.description ? <p className="playlists-row__desc">{p.description}</p> : undefined}
                  kind={PLAYLIST_KIND}
                  actions={(
                    <>
                      <Button
                        size="sm"
                        variant={broken ? 'outline' : 'primary'}
                        icon={broken ? undefined : Play}
                        onClick={() => navigate(`/playlists/${p.id}`)}
                        disabled={broken}
                      >
                        {broken ? 'Unavailable' : 'Open'}
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        iconOnly
                        icon={Trash2}
                        aria-label={`Delete playlist ${title}`}
                        title="Delete playlist"
                        busy={deleting === p.id}
                        onClick={() => handleDelete(p.id, p.title)}
                      />
                    </>
                  )}
                />
              );
            })}
          </EpisodeList>
        </section>
      )}

      {showCreate && (
        <CreatePathModal
          decks={decks}
          prefill={prefill}
          onClose={closeCreate}
          onCreated={() => { setShowCreate(false); setPrefill(null); refresh(); }}
        />
      )}

      {showRecommend && (
        <RecommendPathModal
          decks={decks}
          onClose={closeRecommend}
          onAccept={(rec) => {
            setPrefill(rec);
            setShowRecommend(false);
            setShowCreate(true);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create-playlist modal
// ---------------------------------------------------------------------------
function CreatePathModal({
  decks, prefill, onClose, onCreated,
}: { decks: Deck[]; prefill?: RecommendResponse | null; onClose: () => void; onCreated: () => void }) {
  const [title, setTitle] = useState(prefill?.title ?? '');
  const [description, setDescription] = useState(prefill?.description ?? '');
  const [selected, setSelected] = useState<string[]>(prefill?.steps.map((s) => s.deck_id) ?? []);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function toggle(deckId: string) {
    setSelected((s) => s.includes(deckId) ? s.filter((x) => x !== deckId) : [...s, deckId]);
  }
  function move(idx: number, delta: number) {
    const next = [...selected];
    const j = idx + delta;
    if (j < 0 || j >= next.length) return;
    [next[idx], next[j]] = [next[j], next[idx]];
    setSelected(next);
  }

  async function submit() {
    if (!title.trim() || selected.length === 0) {
      setErr('Title and at least one deck are required.');
      return;
    }
    setSaving(true); setErr(null);
    try {
      const steps: PlaylistStepInput[] = selected.map((deck_id, order) => ({ deck_id, order, required: true }));
      await createPlaylist({ title: title.trim(), description: description.trim(), steps });
      onCreated();
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setSaving(false);
    }
  }

  const available = decks.filter((d) => !selected.includes(d.deck_id));

  return (
    <Modal open onClose={onClose} label="Create playlist" variant="narrow">
      <div className="modal__body playlists-modal">
        <div className="playlists-modal__head">
          <span className="eyebrow">New playlist</span>
          <h2>Create playlist</h2>
        </div>

        <Field label="Title (required)">
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. AI Enablement Path"
            required
          />
        </Field>

        <Field label="Description">
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Short description…"
            rows={2}
            className="playlists-modal__desc"
          />
        </Field>

        <div className="playlists-modal__group" role="group" aria-labelledby="playlist-steps-label">
          <div className="playlists-modal__group-head">
            <span id="playlist-steps-label" className="field__label">Steps, in order (required)</span>
            <span className="muted small">{pluralize(selected.length, 'deck')}</span>
          </div>

          {selected.length > 0 && (
            <ol className="playlist-steps" aria-label="Selected decks">
              {selected.map((deckId, idx) => {
                const d = decks.find((x) => x.deck_id === deckId);
                const name = d ? humanizeTitle(d.title) : deckId;
                return (
                  <li key={deckId} className="playlist-steps__item">
                    <span className="playlist-steps__num" aria-hidden>{episodeNumber(idx + 1)}</span>
                    <span className="playlist-steps__title" title={d?.title}>{name}</span>
                    <span className="playlist-steps__ctrls">
                      <Button
                        size="sm" variant="ghost" iconOnly icon={ArrowUp}
                        aria-label={`Move ${name} up`}
                        onClick={() => move(idx, -1)}
                        disabled={idx === 0}
                      />
                      <Button
                        size="sm" variant="ghost" iconOnly icon={ArrowDown}
                        aria-label={`Move ${name} down`}
                        onClick={() => move(idx, 1)}
                        disabled={idx === selected.length - 1}
                      />
                      <Button
                        size="sm" variant="ghost" iconOnly icon={X}
                        className="playlist-steps__remove"
                        aria-label={`Remove ${name}`}
                        onClick={() => toggle(deckId)}
                      />
                    </span>
                  </li>
                );
              })}
            </ol>
          )}

          <ul className="playlist-picker" aria-label="Available decks">
            {available.map((d) => (
              <li key={d.deck_id}>
                <button type="button" className="playlist-picker__item" onClick={() => toggle(d.deck_id)}>
                  <Plus aria-hidden className="playlist-picker__icon" />
                  <span className="playlist-picker__title" title={d.title}>{humanizeTitle(d.title)}</span>
                  <span className="playlist-picker__meta">
                    {pluralize(d.slide_count, 'slide')} · {languageName(d.language)}
                  </span>
                </button>
              </li>
            ))}
            {available.length === 0 && (
              <li className="playlist-picker__empty">All decks added.</li>
            )}
          </ul>
        </div>

        {err && <Alert tone="error">{err}</Alert>}

        <div className="playlists-modal__foot">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} busy={saving}>
            {saving ? 'Creating…' : 'Create playlist'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Recommend-with-AI modal
// ---------------------------------------------------------------------------
function RecommendPathModal({
  decks, onClose, onAccept,
}: { decks: Deck[]; onClose: () => void; onAccept: (rec: RecommendResponse) => void }) {
  const [topic, setTopic] = useState('');
  const [maxSteps, setMaxSteps] = useState(4);
  const [language, setLanguage] = useState('');
  const [loading, setLoading] = useState(false);
  const [rec, setRec] = useState<RecommendResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const availableLanguages = Array.from(new Set(decks.map((d) => d.language).filter(Boolean))) as string[];

  async function generate() {
    if (!topic.trim()) { setErr('Enter a topic'); return; }
    setLoading(true); setErr(null); setRec(null);
    try {
      const r = await recommendPlaylist(topic.trim(), maxSteps, language || undefined);
      setRec(r);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally { setLoading(false); }
  }

  return (
    <Modal open onClose={onClose} label="Recommend playlist" variant="narrow">
      <div className="modal__body playlists-modal">
        <div className="playlists-modal__head">
          <span className="eyebrow playlists-modal__kicker"><Sparkles aria-hidden />AI producer</span>
          <h2>Recommend a playlist</h2>
        </div>

        <Field label="Topic">
          <Textarea
            data-testid="recommend-topic"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="e.g., AI fundamentals, building agents with MCP…"
            rows={2}
            className="playlists-modal__desc"
          />
        </Field>

        <div className="playlists-modal__row">
          <Field label={<>Max steps: <span className="tabular">{maxSteps}</span></>}>
            <input
              type="range"
              min={2}
              max={8}
              value={maxSteps}
              onChange={(e) => setMaxSteps(Number(e.target.value))}
              className="playlists-modal__range"
            />
          </Field>
          <Field label="Language filter">
            <Select value={language} onChange={(e) => setLanguage(e.target.value)}>
              <option value="">Any</option>
              {availableLanguages.map((l) => <option key={l} value={l}>{languageName(l)}</option>)}
            </Select>
          </Field>
        </div>

        <div>
          <Button
            variant="primary"
            icon={Sparkles}
            onClick={generate}
            data-testid="recommend-generate"
            busy={loading}
            disabled={!topic.trim()}
          >
            {loading ? 'Generating…' : 'Generate recommendation'}
          </Button>
        </div>

        {err && <Alert tone="error">{err}</Alert>}

        {rec && (
          <div data-testid="recommend-preview" className="recommend-preview">
            <h3 className="recommend-preview__title">{rec.title}</h3>
            {rec.description && <p className="recommend-preview__desc">{rec.description}</p>}
            {rec.explanation && <p className="recommend-preview__why">{rec.explanation}</p>}
            <ol className="recommend-preview__steps">
              {rec.steps.map((s: RecommendedStep, i) => (
                <li key={s.deck_id} className="recommend-preview__step">
                  <span className="recommend-preview__num" aria-hidden>{episodeNumber(i + 1)}</span>
                  <div className="recommend-preview__step-body">
                    <div>
                      <strong title={s.deck_title}>{humanizeTitle(s.deck_title)}</strong>{' '}
                      <span className="muted small">({pluralize(s.slide_count, 'slide')})</span>
                    </div>
                    {s.rationale && <div className="muted small">{s.rationale}</div>}
                  </div>
                </li>
              ))}
            </ol>
            <div className="playlists-modal__foot">
              <Button size="sm" icon={RefreshCw} onClick={generate}>Regenerate</Button>
              <Button size="sm" variant="primary" data-testid="recommend-accept" onClick={() => onAccept(rec)}>
                Accept & customize
              </Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
