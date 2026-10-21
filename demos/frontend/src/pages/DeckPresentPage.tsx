import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { Eye, Mic, Presentation as PresentationIcon } from 'lucide-react';
import SlideViewer from '../components/SlideViewer';
import AvatarPanel from '../components/AvatarPanel';
import DemoOutcome from '../components/DemoOutcome';
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
import { fetchBootFallback, pickDemoDeck, readBoot } from '../services/boot';
import { lookupRecording, useDemoConfig } from '../services/demo';
import { DEMO_FALLBACK_LINKS, demoDeckPath, type Recording } from '../services/demoProtocol';
import {
  Alert, Button, ButtonLink, Chip, EmptyState, Field, LivePill, PageHeader, Select, Spinner,
  classifyLoadError, humanizeTitle, langAttr, languageName, loadErrorMessage, pluralize,
} from '../ui';
import '../styles/pages/presenter.css';

/** The "Live demo" tail of a live-demo deck's title, in the languages the decks are published in. */
const LIVE_TITLE_SUFFIX = /\s*·\s*(live demo|démo en direct)\s*$/i;

function deckToPresentation(d: DeckDetail, admin: boolean): Presentation {
  return {
    id: d.id ?? d.deck_id,
    // Visitors see the deck's title, never an uploaded file name.
    filename: admin ? (d.filename ?? d.title) : humanizeTitle(d.title),
    slide_count: d.slide_count ?? d.slides?.length ?? 0,
    language: d.language,
    // Slides keep `translated_notes` (admin payload) so narration follows the selected language.
    slides: presenterSlides(d.slides),
  };
}

/** The sentence under "This deck couldn't be loaded": the cause, never a raw transport message. */
function deckErrorMessage(err: unknown): string {
  return classifyLoadError(err) === 'not-found' ? 'Deck not found' : loadErrorMessage(err, 'this deck');
}

/**
 * Where "Start the live demo" leads for this visitor — the live-demo deck of the first browser language that has one —
 * read from the boot block, or (without one) with a single bounded request. `undefined` while it is being found, `null`
 * when the live demo cannot run. Nothing is fetched unless `needed`.
 */
function useLiveDemoPath(needed: boolean): string | null | undefined {
  const resolve = (boot: ReturnType<typeof readBoot>) => {
    const target = boot && boot.demo.enabled ? pickDemoDeck(boot) : null;
    return target ? demoDeckPath(target.deck_id) : null;
  };
  const [path, setPath] = useState<string | null | undefined>(() => {
    const boot = readBoot();
    return boot ? resolve(boot) : undefined;
  });
  useEffect(() => {
    if (!needed || path !== undefined) return;
    let cancelled = false;
    void fetchBootFallback().then((boot) => { if (!cancelled) setPath(resolve(boot)); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needed, path]);
  return path;
}

/** The deck's own recording (a video or an episode with its title), found once `enabled`; null while unknown or when none. */
function useDeckRecording(deck: DeckDetail | null, enabled: boolean): Recording | null {
  const [recording, setRecording] = useState<Recording | null>(null);
  useEffect(() => {
    if (!deck || !enabled) return;
    return lookupRecording({ deck_id: deck.deck_id, title: deck.title, language: deck.language }, setRecording);
  }, [deck, enabled]);
  return recording;
}

export default function DeckPresentPage() {
  const { deckId = '' } = useParams();
  const [sp] = useSearchParams();
  const initialSlide = Math.max(0, parseInt(sp.get('slide') ?? '0', 10) || 0);
  const autoplay = sp.get('autoplay') === '1';

  const [deck, setDeck] = useState<DeckDetail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [reloadKey, setReloadKey] = useState(0);

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
    setDeck(null);
    setError(null);
    getDeck(deckId)
      .then((d) => { if (!cancelled) { setDeck(d); if (d.language) setLanguage(d.language); } })
      .catch((e) => { if (!cancelled) setError(e ?? new Error('Deck not found')); });
    return () => { cancelled = true; };
  }, [deckId, reloadKey]);

  // The route sets a generic title; once the deck is known the tab, history and screen readers name it.
  useEffect(() => {
    if (deck?.title) document.title = `${humanizeTitle(deck.title)} · Oz Radio`;
  }, [deck?.title]);

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

  const presentation = deck ? deckToPresentation(deck, isAdmin) : null;
  // Anonymous narration-only live demo: kill switch on + deck marked "Live demo".
  const demoMode = !auth.loading && !isAdmin && !demo.loading && demo.enabled && deck?.live_demo === true;
  // A visitor on a page where the live avatar cannot run (demo switched off, or a deck that is not a live-demo deck):
  // the cause and the recording instead of a sign-in wall that does not apply to them.
  const railLoading = auth.loading || (!isAdmin && demo.loading);
  const demoUnavailable = !!presentation && !railLoading && !isAdmin && !demoMode;
  const liveDemoPath = useLiveDemoPath(error != null || (demoUnavailable && demo.enabled));
  // The deck's recording: the way out of a deck without a live avatar, and an alternative offered before Start.
  const deckRecording = useDeckRecording(deck, demoUnavailable || demoMode);
  // The demo avatar is chosen server-side (registry default).
  const avatarMode = isPhotoAvatar(
    demoMode ? pickDefaultAvatar(avatars) : avatars.find((a) => a.id === selectedAvatar),
  ) ? 'portrait' : 'wide';

  // The deck's own words (title, language name) carry the deck's language, not the interface's.
  const deckLang = langAttr(deck?.language);
  const selectedLang = langAttr(language);
  // "Live demo" only on a deck that can be started live; every other deck is "Slides". No kicker while the deck loads.
  const canPresentLive = demoMode || isAdmin;
  // The kicker already says "Live demo": the heading drops the same words from the end of the deck's title (the tab keeps
  // the full title). Elsewhere a wrapped heading never starts a line with "·".
  const shownTitle = humanizeTitle(deck?.title || presentation?.filename);
  const kickerSaysLive = deck?.live_demo === true && (canPresentLive || railLoading);
  const headingText = (kickerSaysLive ? shownTitle.replace(LIVE_TITLE_SUFFIX, '') : shownTitle).replace(/\s+·/g, '\u00a0·');
  const title: React.ReactNode = presentation
    ? <span lang={deckLang}>{headingText}</span>
    : error != null ? 'Deck' : 'Loading deck…';
  const eyebrow = presentation ? (
    <>
      {[railLoading ? null : canPresentLive ? 'Live demo' : 'Slides', pluralize(presentation.slide_count, 'slide')].filter(Boolean).join(' · ')}
      {' · '}
      <span lang={selectedLang}>{languageName(language)}</span>
    </>
  ) : undefined;

  const accessBadge = !isAdmin && !auth.loading && presentation ? (
    demoMode ? (
      <LivePill data-testid="live-demo-available">Live avatar demo available</LivePill>
    ) : (
      <Chip icon={Eye}>Read-only preview</Chip>
    )
  ) : null;

  const errorKind = error != null ? classifyLoadError(error) : null;
  // "Start the live demo" where it can run; otherwise the recording. Always something public to do next.
  const startLiveDemo = liveDemoPath
    ? <ButtonLink to={liveDemoPath} variant="primary" data-testid="deck-start-live-demo">Start the live demo</ButtonLink>
    : null;

  return (
    <div className="container page presenter">
      <PageHeader
        back={{ to: '/decks', label: 'Back to decks' }}
        eyebrow={eyebrow}
        title={title}
        actions={accessBadge}
      />

      {error != null && (
        presentation ? (
          <Alert tone="error" className="presenter__alert">{deckErrorMessage(error)}</Alert>
        ) : (
          <EmptyState
            icon={PresentationIcon}
            title="This deck couldn't be loaded"
            action={(
              <div className="presenter__actions">
                {errorKind !== 'not-found' && (
                  <Button data-testid="deck-retry" onClick={() => setReloadKey((k) => k + 1)}>Try again</Button>
                )}
                {startLiveDemo}
                {liveDemoPath === null && (
                  <ButtonLink to="/video/library" variant="primary">Watch a recorded demo</ButtonLink>
                )}
                <ButtonLink to="/podcast/library" variant="outline">Listen to an episode</ButtonLink>
              </div>
            )}
          >
            <Alert tone="error">{deckErrorMessage(error)}</Alert>
          </EmptyState>
        )
      )}

      {!presentation && error == null && (
        // The heading already says "Loading deck…": the spinner's own words are for screen readers only, so it is
        // announced once and never read twice on screen.
        <div className="presenter__loading">
          <span className="spinner" aria-hidden />
          <span className="sr-only" role="status">Loading slides…</span>
        </div>
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
                showFile={isAdmin}
                onVideoPlayingChange={(playing) => {
                  setVideoPlaying(playing);
                  if (playing) setAutoPlayVideo(false);
                }}
              />
            </div>
            <aside className="presenter-grid__rail" aria-label="Now presenting">
              {railLoading ? (
                <div className="presenter__loading"><Spinner label="Loading…" /></div>
              ) : demoUnavailable ? (
                <DemoOutcome
                  kind="unavailable"
                  tone="info"
                  role="status"
                  title={demo.enabled ? "The live avatar isn't available for this deck" : "The live demo isn't available right now"}
                  detail={demo.enabled
                    ? 'Only the live-demo deck can be presented by the avatar. Start it, or watch the recording.'
                    : "A live session can't start at the moment. The recording shows the same demo."}
                  recording={deckRecording}
                  actions={demo.enabled ? startLiveDemo : null}
                />
              ) : (
                <AvatarPanel
                  key={demoMode ? `demo-${presentation.id}` : 'admin'}
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
                  deckTitle={deck?.title}
                  deckId={demoMode ? undefined : deck?.deck_id}
                  preStartRecording={demoMode ? deckRecording : null}
                />
              )}
            </aside>
          </div>
        </>
      )}
    </div>
  );
}
