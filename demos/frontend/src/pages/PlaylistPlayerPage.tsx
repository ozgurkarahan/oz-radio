import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, ArrowRight, Check, CircleCheck, ListVideo, Play, SlidersHorizontal, Unlink,
} from 'lucide-react';
import SlideViewer from '../components/SlideViewer';
import AvatarPanel from '../components/AvatarPanel';
import LanguageSelector from '../components/LanguageSelector';
import { type Presentation } from '../services/api';
import {
  DeckDetail, getDeck,
  PlaylistDetail, PlaylistProgress,
  getPlaylist, getProgress, postProgress, getOrCreateUserId,
  DECK_VOICES, avatarForVoice, voiceForLanguage,
  deckNeedsNotesTranslation, mergeDeckTranslations, presenterSlides, translateDeckNotes,
} from '../services/decksApi';
import { isPhotoAvatar, pickAvatarForGender, useAvatars } from '../services/avatars';
import { useAuth } from '../services/auth';
import { GatedPanel } from '../components/AuthGate';
import {
  Alert, Button, Chip, EmptyState, Field, PageHeader, Progress, Select, Spinner,
  humanizeTitle, languageName, pluralize,
} from '../ui';
import '../styles/pages/presenter.css';

function deckToPresentation(d: DeckDetail): Presentation {
  return {
    id: d.id ?? d.deck_id,
    filename: d.filename ?? d.title,
    slide_count: d.slide_count ?? d.slides?.length ?? 0,
    language: d.language,
    // Slides keep `translated_notes` (admin payload) so narration follows the selected language.
    slides: presenterSlides(d.slides),
  };
}

export default function PlaylistPlayerPage() {
  const auth = useAuth();
  if (auth.loading) {
    return (
      <div className="container page">
        <div className="presenter__loading"><Spinner label="Loading…" /></div>
      </div>
    );
  }
  if (!auth.is_admin) {
    return (
      <div className="container page">
        <PageHeader eyebrow="Playlists" title="Follow a learning path" />
        <GatedPanel
          icon={ListVideo}
          title="Playlists are for the site owner"
          description="Playlists track the owner's progress across several decks, presented live by the AI avatar. You can start the live demo of a published deck without signing in, or browse the decks and videos."
          action="follow a playlist"
          links={[{ href: '/decks', label: 'Browse the decks' }, { href: '/video/library', label: 'Browse the video library' }]}
        />
      </div>
    );
  }
  return <PathPlayer />;
}

function PathPlayer() {
  const { playlistId = '' } = useParams();
  const navigate = useNavigate();
  const userId = useMemo(() => getOrCreateUserId(), []);

  const [playlist, setPlaylist] = useState<PlaylistDetail | null>(null);
  const [progress, setProgress] = useState<PlaylistProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [gone, setGone] = useState(false);

  const [currentStep, setCurrentStep] = useState(0);
  const [deck, setDeck] = useState<DeckDetail | null>(null);
  const [currentSlide, setCurrentSlide] = useState(0);
  const [language, setLanguage] = useState('en-US');
  const [videoPlaying, setVideoPlaying] = useState(false);
  const [autoPlayVideo, setAutoPlayVideo] = useState(false);
  const [selectedVoice, setSelectedVoice] = useState<string>(DECK_VOICES[1].id);
  const [selectedAvatar, setSelectedAvatar] = useState<string>('');
  const { avatars } = useAvatars();
  const avatarsRef = React.useRef(avatars);
  useEffect(() => { avatarsRef.current = avatars; }, [avatars]);

  // Default avatar from the server catalog (is_default → first female → first).
  useEffect(() => {
    if (avatars.length === 0) return;
    if (avatars.some((a) => a.id === selectedAvatar)) return;
    const g = DECK_VOICES.find((v) => v.id === selectedVoice)?.gender ?? 'female';
    setSelectedAvatar(pickAvatarForGender(avatars, g)?.id ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [avatars]);
  const [started, setStarted] = useState(false);
  const startedRef = React.useRef(false);
  useEffect(() => { startedRef.current = started; }, [started]);

  // Load playlist + progress, and initialize language once from the first deck
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const p = await getPlaylist(playlistId);
        if (cancelled) return;
        setPlaylist(p);
        const pr = await getProgress(playlistId, userId);
        if (cancelled) return;
        setProgress(pr);
        const idx = p.steps.findIndex((s) => s.deck_id === pr.resume_deck_id);
        // Resume only if the user has not already picked a step while progress loaded.
        if (idx >= 0 && !startedRef.current) setCurrentStep(idx);
        // Initialize language & voice from the first step's deck (one-time)
        if (p.steps.length > 0) {
          try {
            const firstDeck = await getDeck(p.steps[0].deck_id);
            if (cancelled) return;
            if (firstDeck.language) {
              setLanguage(firstDeck.language);
              const match = DECK_VOICES.find((v) => v.language === firstDeck.language && v.gender === 'female');
              if (match) {
                setSelectedVoice(match.id);
                setSelectedAvatar((prev) => avatarForVoice(match.id, avatarsRef.current, prev));
              }
            }
          } catch { /* non-fatal */ }
        }
      } catch (e: any) {
        if (e?.status === 410) setGone(true);
        else setError(e?.message ?? String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [playlistId, userId]);

  // Load current deck when step changes
  useEffect(() => {
    if (!playlist) return;
    const step = playlist.steps[currentStep];
    if (!step) return;
    let cancelled = false;
    // Keep the previous deck on screen while the next one loads so the avatar
    // session stays connected and only rebinds (context.switch) to the new deck.
    getDeck(step.deck_id)
      .then((d) => {
        if (cancelled) return;
        setDeck(d);
        // NOTE: do NOT overwrite language here — the user picks voice/avatar/language
        // once (in the banner) and it must stay stable across all steps of the playlist.
        // If this step matches resume and user clicked start, jump to resume slide
        if (started && progress && progress.resume_deck_id === step.deck_id) {
          setCurrentSlide(Math.max(0, Math.min(progress.resume_slide_index, (d.slides?.length ?? 1) - 1)));
        } else {
          setCurrentSlide(0);
        }
      })
      .catch((e) => { if (!cancelled) setError(String(e?.message ?? e)); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playlist?.id, currentStep, started]);

  // Fetch (and cache server-side) translated speaker notes for the selected language.
  const translationRequested = React.useRef(new Set<string>());
  useEffect(() => {
    if (!deck || !deckNeedsNotesTranslation(deck, language)) return;
    const key = `${deck.deck_id}|${language}`;
    if (translationRequested.current.has(key)) return;
    translationRequested.current.add(key);
    translateDeckNotes(deck.deck_id, language)
      .then((r) => setDeck((d) => (d && d.deck_id === r.deck_id ? mergeDeckTranslations(d, r.target_language, r.translated_notes) : d)))
      .catch((e) => console.warn('Speaker notes translation failed:', e));
  }, [deck, language]);

  const recordProgress = useCallback(async (deckId: string, slideIndex: number) => {
    if (!playlistId) return;
    try {
      const fresh = await postProgress(playlistId, {
        user_id: userId, deck_id: deckId, slide_index: slideIndex,
      });
      setProgress(fresh);
    } catch (e) {
      // non-fatal — keep playing
      console.warn('progress post failed', e);
    }
  }, [playlistId, userId]);

  function onSlideChange(idx: number) {
    setCurrentSlide(idx);
    if (deck) recordProgress(deck.deck_id ?? deck.id, idx);
  }

  function onVoiceChange(voiceId: string) {
    setSelectedVoice(voiceId);
    setSelectedAvatar(avatarForVoice(voiceId, avatars, selectedAvatar));
    const v = DECK_VOICES.find((x) => x.id === voiceId);
    if (v?.language) setLanguage(v.language);
  }

  // A new narration language also needs a voice that speaks it.
  function onLanguageChange(lang: string) {
    setLanguage(lang);
    const voiceId = voiceForLanguage(selectedVoice, lang);
    if (voiceId !== selectedVoice) {
      setSelectedVoice(voiceId);
      setSelectedAvatar(avatarForVoice(voiceId, avatars, selectedAvatar));
    }
  }

  function goToStep(idx: number) {
    if (!playlist) return;
    if (idx < 0 || idx >= playlist.steps.length) return;
    startedRef.current = true;
    setCurrentStep(idx);
    setStarted(true);
  }

  const voicesByLang = useMemo(() => {
    const map = new Map<string, typeof DECK_VOICES>();
    DECK_VOICES.forEach((v) => {
      const arr = map.get(v.language) ?? [];
      arr.push(v);
      map.set(v.language, arr);
    });
    return map;
  }, []);

  const presentation = deck ? deckToPresentation(deck) : null;
  const avatarMode = isPhotoAvatar(avatars.find((a) => a.id === selectedAvatar)) ? 'portrait' : 'wide';

  if (gone) {
    return (
      <div className="container page">
        <PageHeader back={{ to: '/playlists', label: 'All playlists' }} eyebrow="Playlist" title="Playlist is broken" />
        <EmptyState
          icon={Unlink}
          title="A deck in this playlist is missing"
          action={(
            <Button variant="primary" icon={ArrowLeft} onClick={() => navigate('/playlists')}>
              Back to playlists
            </Button>
          )}
        >
          One of the referenced decks has been deleted.
        </EmptyState>
      </div>
    );
  }

  if (error) {
    return (
      <div className="container page">
        <PageHeader back={{ to: '/playlists', label: 'All playlists' }} eyebrow="Playlist" title="Playlist unavailable" />
        <Alert tone="error">{error}</Alert>
      </div>
    );
  }

  if (!playlist) {
    return (
      <div className="container page">
        <div className="presenter__loading"><Spinner label="Loading playlist…" /></div>
      </div>
    );
  }

  const percent = progress?.percent ?? 0;
  const isComplete = progress?.total_slides && progress.completed_count >= progress.total_slides;
  const step = playlist.steps[currentStep];
  const totalSlides = playlist.steps.reduce((n, s) => n + (s.slide_count ?? 0), 0);
  const hasProgress = !!progress && progress.completed_count > 0;

  return (
    <div className="container page presenter playlist-player">
      <PageHeader
        back={{ to: '/playlists', label: 'All playlists' }}
        eyebrow={`Playlist · ${pluralize(playlist.steps.length, 'deck')} · ${pluralize(totalSlides, 'slide')}`}
        title={humanizeTitle(playlist.title)}
        lead={playlist.description || undefined}
        actions={isComplete ? <Chip tone="sage" icon={CircleCheck}>100% complete</Chip> : undefined}
      />

      <div className="pp-progress">
        <div className="pp-progress__meta small muted tabular">
          <span>{progress?.completed_count ?? 0} / {progress?.total_slides ?? 0} slides</span>
          <span>{percent.toFixed(0)}%</span>
        </div>
        <Progress value={percent / 100} label="Playlist progress" />
      </div>

      <ol className="pp-steps" aria-label="Decks in this playlist">
        {playlist.steps.map((s, idx) => {
          const done = (progress?.completed_slides?.[s.deck_id]?.length ?? 0) >= s.slide_count;
          const active = idx === currentStep && started;
          return (
            <li key={s.deck_id}>
              <button
                type="button"
                className={['pp-step', active && 'is-active', done && 'is-done'].filter(Boolean).join(' ')}
                aria-current={active ? 'step' : undefined}
                onClick={() => goToStep(idx)}
              >
                <span className="pp-step__num" aria-hidden>
                  {done ? <Check /> : idx + 1}
                </span>
                <span className="pp-step__text">
                  <span className="eyebrow">Step {idx + 1}{done ? ' · Done' : ''}</span>
                  <span className="pp-step__title">{humanizeTitle(s.deck_title)}</span>
                  <span className="small muted">{pluralize(s.slide_count, 'slide')}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>

      {/* Avatar + voice + language — always visible so user can configure before starting */}
      <section className="presenter-settings" aria-label="Presentation settings">
        <div className="presenter-settings__intro">
          <span className="eyebrow presenter-settings__label"><SlidersHorizontal aria-hidden />Presentation settings</span>
          {started && presentation && (
            <span className="small muted presenter-settings__context">
              {humanizeTitle(step?.deck_title)} · Slide {currentSlide + 1} / {presentation.slide_count}
            </span>
          )}
        </div>

        <div className="presenter-settings__fields">
          <Field label="Avatar" inline size="sm">
            <Select value={selectedAvatar} onChange={(e) => setSelectedAvatar(e.target.value)}>
              {avatars.length === 0 && <option value="">Default avatar</option>}
              {avatars.map((a) => <option key={a.id} value={a.id}>{a.display_name}</option>)}
            </Select>
          </Field>

          <Field label="Voice" inline size="sm" className="presenter-settings__voice">
            <Select value={selectedVoice} onChange={(e) => onVoiceChange(e.target.value)}>
              {Array.from(voicesByLang.entries()).map(([lang, vs]) => (
                <optgroup key={lang} label={languageName(lang)}>
                  {vs.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.display_name} · {v.gender === 'male' ? 'Male' : 'Female'}
                    </option>
                  ))}
                </optgroup>
              ))}
            </Select>
          </Field>

          <LanguageSelector value={language} onChange={onLanguageChange} variant="light" />
        </div>
      </section>

      {/* Start / Resume banner */}
      {!started && step && (
        <section className="pp-start" aria-label="Start playlist">
          <div className="pp-start__text">
            <span className="eyebrow">{hasProgress ? `Resume at step ${currentStep + 1}` : 'Ready to start'}</span>
            <h2 className="pp-start__title">{humanizeTitle(step.deck_title)}</h2>
            <p className="small muted">
              The avatar, voice and language above will be used for <strong>all {playlist.steps.length} decks</strong> in this playlist.
            </p>
          </div>
          <Button
            data-testid="playlist-start"
            variant="primary"
            size="lg"
            icon={Play}
            onClick={() => setStarted(true)}
          >
            {hasProgress ? 'Resume' : 'Start'}
          </Button>
        </section>
      )}

      {/* Player */}
      {started && !presentation && (
        <div className="presenter__loading"><Spinner label="Loading deck…" /></div>
      )}
      {started && presentation && (
        <div className="presenter-grid">
          <div className="presenter-grid__main">
            <SlideViewer
              presentation={presentation}
              currentSlide={currentSlide}
              onSlideChange={onSlideChange}
              language={language}
              autoPlayVideo={autoPlayVideo}
              onVideoPlayingChange={(playing) => {
                setVideoPlaying(playing);
                if (playing) setAutoPlayVideo(false);
              }}
            />
            <nav className="pp-deck-nav" aria-label="Playlist decks">
              <Button
                data-testid="playlist-prev-deck"
                icon={ArrowLeft}
                onClick={() => goToStep(currentStep - 1)}
                disabled={currentStep === 0}
              >
                Previous deck
              </Button>
              <span className="small muted tabular">Deck {currentStep + 1} of {playlist.steps.length}</span>
              <Button
                data-testid="playlist-next-deck"
                variant="primary"
                iconRight={ArrowRight}
                onClick={() => goToStep(currentStep + 1)}
                disabled={currentStep === playlist.steps.length - 1}
              >
                Next deck
              </Button>
            </nav>
          </div>
          <aside className="presenter-grid__rail" aria-label="Now presenting">
            <AvatarPanel
              presentation={presentation}
              currentSlide={currentSlide}
              language={language}
              onSlideChange={onSlideChange}
              videoPlaying={videoPlaying}
              onRequestVideoAutoPlay={() => setAutoPlayVideo(true)}
              selectedAvatar={selectedAvatar}
              selectedVoice={selectedVoice}
              autoStart={true}
              deckId={deck?.deck_id ?? deck?.id}
              mode={avatarMode}
            />
          </aside>
        </div>
      )}
    </div>
  );
}
