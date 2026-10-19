import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { Eye, Mic, Presentation as PresentationIcon } from 'lucide-react';
import SlideViewer from '../components/SlideViewer';
import AvatarPanel from '../components/AvatarPanel';
import LanguageSelector from '../components/LanguageSelector';
import { type Presentation } from '../services/api';
import {
  DeckDetail, getDeck,
  DECK_VOICES,
  avatarForVoice,
  voiceForLanguage,
  deckNeedsNotesTranslation, mergeDeckTranslations, presenterSlides, translateDeckNotes,
} from '../services/decksApi';
import { isPhotoAvatar, pickAvatarForGender, pickDefaultAvatar, useAvatars } from '../services/avatars';
import { useAuth } from '../services/auth';
import { useDemoConfig } from '../services/demo';
import {
  Alert, Chip, EmptyState, Field, LivePill, PageHeader, Select, Spinner,
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

export default function DeckPresentPage() {
  const { deckId = '' } = useParams();
  const [sp] = useSearchParams();
  const initialSlide = Math.max(0, parseInt(sp.get('slide') ?? '0', 10) || 0);
  const autoplay = sp.get('autoplay') === '1';

  const [deck, setDeck] = useState<DeckDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [currentSlide, setCurrentSlide] = useState(initialSlide);
  const [language, setLanguage] = useState('en-US');
  const [videoPlaying, setVideoPlaying] = useState(false);
  const [autoPlayVideo, setAutoPlayVideo] = useState(autoplay);

  const [selectedVoice, setSelectedVoice] = useState<string>(DECK_VOICES[1].id); // Ava
  const [selectedAvatar, setSelectedAvatar] = useState<string>('');
  const { avatars } = useAvatars();
  const auth = useAuth();
  const isAdmin = auth.is_admin;
  const demo = useDemoConfig();

  // Default avatar from the server catalog (is_default → first female → first).
  useEffect(() => {
    if (avatars.length === 0) return;
    if (avatars.some((a) => a.id === selectedAvatar)) return;
    const g = DECK_VOICES.find((v) => v.id === selectedVoice)?.gender ?? 'female';
    setSelectedAvatar(pickAvatarForGender(avatars, g)?.id ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [avatars]);

  useEffect(() => {
    let cancelled = false;
    getDeck(deckId)
      .then((d) => { if (!cancelled) { setDeck(d); if (d.language) setLanguage(d.language); } })
      .catch((e) => { if (!cancelled) setError(String(e?.message ?? e)); });
    return () => { cancelled = true; };
  }, [deckId]);

  useEffect(() => {
    // Clamp current slide when deck arrives
    if (deck && currentSlide >= deck.slides.length) setCurrentSlide(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deck]);

  // Admin: fetch (and cache server-side) translated speaker notes for the selected language.
  const translationRequested = useRef(new Set<string>());
  useEffect(() => {
    if (!isAdmin || !deck || !deckNeedsNotesTranslation(deck, language)) return;
    const key = `${deck.deck_id}|${language}`;
    if (translationRequested.current.has(key)) return;
    translationRequested.current.add(key);
    translateDeckNotes(deck.deck_id, language)
      .then((r) => setDeck((d) => (d && d.deck_id === r.deck_id ? mergeDeckTranslations(d, r.target_language, r.translated_notes) : d)))
      .catch((e) => console.warn('Speaker notes translation failed:', e));
  }, [isAdmin, deck, language]);

  // Auto-pick gender-appropriate avatar when voice changes
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
  // Anonymous narration-only live demo: kill switch on + deck marked "Live demo".
  const demoMode = !auth.loading && !isAdmin && !demo.loading && demo.enabled && deck?.live_demo === true;
  // The demo avatar is chosen server-side (registry default).
  const avatarMode = isPhotoAvatar(
    demoMode ? pickDefaultAvatar(avatars) : avatars.find((a) => a.id === selectedAvatar),
  ) ? 'portrait' : 'wide';

  const title = presentation ? humanizeTitle(deck?.title || presentation.filename) : 'Live presentation';
  const eyebrow = presentation
    ? ['Live presentation', pluralize(presentation.slide_count, 'slide'), languageName(language)].join(' · ')
    : 'Live presentation';

  const accessBadge = !isAdmin && !auth.loading && presentation ? (
    demoMode ? (
      <LivePill data-testid="live-demo-available">Live avatar demo available</LivePill>
    ) : (
      <Chip icon={Eye}>Read-only preview</Chip>
    )
  ) : null;

  return (
    <div className="container page presenter">
      <PageHeader
        back={{ to: '/decks', label: 'Back to decks' }}
        eyebrow={eyebrow}
        title={title}
        actions={accessBadge}
      />

      {error && (
        presentation ? (
          <Alert tone="error" className="presenter__alert">{error}</Alert>
        ) : (
          <EmptyState icon={PresentationIcon} title="This deck couldn't be loaded">
            <Alert tone="error">{error}</Alert>
          </EmptyState>
        )
      )}

      {!presentation && !error && (
        <div className="presenter__loading"><Spinner label="Loading deck…" /></div>
      )}

      {presentation && (
        <>
          {isAdmin && (
            <section className="presenter-settings" aria-label="Presentation settings">
              <span className="eyebrow presenter-settings__label"><Mic aria-hidden />Host settings</span>
              <div className="presenter-settings__fields">
                <Field label="Avatar" inline size="sm">
                  <Select value={selectedAvatar} onChange={(e) => setSelectedAvatar(e.target.value)}>
                    {avatars.length === 0 && <option value="">Default avatar</option>}
                    {avatars.map((a) => (
                      <option key={a.id} value={a.id}>{a.display_name}</option>
                    ))}
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
          )}

          <div className="presenter-grid">
            <div className="presenter-grid__main">
              <SlideViewer
                presentation={presentation}
                currentSlide={currentSlide}
                onSlideChange={setCurrentSlide}
                language={language}
                autoPlayVideo={autoPlayVideo}
                onVideoPlayingChange={(playing) => {
                  setVideoPlaying(playing);
                  if (playing) setAutoPlayVideo(false);
                }}
              />
            </div>
            <aside className="presenter-grid__rail" aria-label="Now presenting">
              <AvatarPanel
                key={demoMode ? 'demo' : 'admin'}
                presentation={presentation}
                currentSlide={currentSlide}
                language={language}
                onSlideChange={setCurrentSlide}
                videoPlaying={videoPlaying}
                onRequestVideoAutoPlay={() => setAutoPlayVideo(true)}
                selectedAvatar={selectedAvatar}
                selectedVoice={selectedVoice}
                mode={avatarMode}
                access={demoMode ? 'demo' : 'admin'}
                demoSessionSeconds={demo.session_seconds}
                demoQa={demo.qa}
                deckId={demoMode ? undefined : deck?.deck_id}
              />
            </aside>
          </div>
        </>
      )}
    </div>
  );
}
