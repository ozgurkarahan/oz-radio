import { useState, useEffect } from 'react';
import { Mic } from 'lucide-react';
import PptUpload from '../components/PptUpload';
import PresentationList from '../components/PresentationList';
import SlideViewer from '../components/SlideViewer';
import AvatarPanel from '../components/AvatarPanel';
import LanguageSelector from '../components/LanguageSelector';
import QaChat from '../components/QaChat';
import { getSlides, getTranslationsStatus, type Presentation } from '../services/api';
import { initializeTeams } from '../services/teams';
import { useAuth } from '../services/auth';
import { AdminOnly, GatedPanel } from '../components/AuthGate';
import { Alert, PageHeader, Spinner, humanizeTitle, pluralize } from '../ui';
import '../styles/pages/live.css';

const EYEBROW = 'Create · Present live';

export default function LivePage() {
  const auth = useAuth();
  if (auth.loading) {
    return (
      <div className="container page live-page">
        <Spinner label="Loading…" />
      </div>
    );
  }
  if (!auth.is_admin) {
    return (
      <div className="container page live-page">
        <PageHeader
          eyebrow={EYEBROW}
          title="Present a deck live"
          lead="An AI avatar presents your PowerPoint slide by slide, in your language, and answers questions about it."
        />
        <GatedPanel
          icon={Mic}
          title="Uploading decks for live presentation is for the site owner"
          description="The owner uploads a PowerPoint deck with speaker notes and a live AI avatar presents it in their language, with slide-aware Q&A. You can start the live demo of a published deck without signing in, or browse the decks and videos."
          action="upload your own decks for live presentation"
          links={[{ href: '/decks', label: 'Browse the decks' }, { href: '/video/library', label: 'Browse the video library' }]}
        />
      </div>
    );
  }
  return <LivePresenter />;
}

function deckTitle(filename: string): string {
  return humanizeTitle(filename.replace(/\.pptx$/i, ''));
}

function LivePresenter() {
  const [presentation, setPresentation] = useState<Presentation | null>(null);
  const [currentSlide, setCurrentSlide] = useState(0);
  const [language, setLanguage] = useState('en-US');
  const [videoPlaying, setVideoPlaying] = useState(false);
  const [autoPlayVideo, setAutoPlayVideo] = useState(false);
  const [inTeams, setInTeams] = useState(false);

  // The Teams theme itself is synced onto <html data-theme> by the app shell;
  // here we only need to know whether we run inside Teams (compact spacing).
  useEffect(() => {
    initializeTeams().then((detected) => setInTeams(detected));
  }, []);

  const [translationStatus, setTranslationStatus] = useState<string | null>(null);

  // Re-fetch slides when language changes to pick up cached translations from CosmosDB
  useEffect(() => {
    if (!presentation) return;
    getSlides(presentation.id)
      .then((fresh) => setPresentation(fresh))
      .catch(() => {}); // silently ignore if backend unreachable
  }, [language, presentation?.id]);

  // Poll background batch-translation progress after a new upload.
  // When completed, re-fetch slides from Cosmos DB to get all translated_notes.
  useEffect(() => {
    if (!presentation) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const status = await getTranslationsStatus(presentation.id);
        if (cancelled) return;
        if (status.status === 'in_progress') {
          setTranslationStatus(`Translating notes: ${status.completed}/${status.total} languages...`);
          setTimeout(poll, 3000);
        } else if (status.status === 'completed') {
          setTranslationStatus(null);
          // Re-fetch slides to get all translated_notes from Cosmos DB
          try {
            const fresh = await getSlides(presentation.id);
            if (!cancelled) setPresentation(fresh);
          } catch (e) {
            console.warn('Failed to refresh slides after translation:', e);
          }
        } else {
          setTranslationStatus(null);
        }
      } catch {
        if (!cancelled) setTranslationStatus(null);
      }
    };
    poll();
    return () => { cancelled = true; };
  }, [presentation?.id]);

  const rootClass = ['container', 'page', 'live-page', inTeams && 'live--teams'].filter(Boolean).join(' ');

  return (
    <div className={rootClass}>
      {!presentation ? (
        <PageHeader
          className="live-header"
          eyebrow={EYEBROW}
          title="Present a deck live"
          lead={inTeams ? undefined : 'Upload a PowerPoint file (.pptx) with speaker notes. The AI avatar presents your slides with multilingual text-to-speech and answers questions from the room.'}
        />
      ) : (
        <PageHeader
          className="live-header"
          back={{ onClick: () => { setPresentation(null); setCurrentSlide(0); }, label: 'Back to presentations' }}
          eyebrow={`${EYEBROW} · ${pluralize(presentation.slide_count ?? presentation.slides.length, 'slide')}`}
          title={deckTitle(presentation.filename)}
          actions={<LanguageSelector value={language} onChange={setLanguage} variant="light" />}
        />
      )}

      {translationStatus && (
        <Alert className="live-page__status">
          <span className="cluster live-page__status-row">
            <span className="spinner" aria-hidden />
            {translationStatus}
          </span>
        </Alert>
      )}

      {!presentation ? (
        <div className="live-start">
          <section className="live-start__upload" aria-labelledby="live-upload-title">
            <h2 id="live-upload-title" className="eyebrow live-start__title">Upload a presentation</h2>
            <PptUpload onUploaded={setPresentation} />
          </section>
          <div className="live-start__list">
            <PresentationList onSelect={(p) => { setPresentation(p); setCurrentSlide(0); }} />
          </div>
        </div>
      ) : (
        <div className="live-presenter">
          <div className="live-presenter__main">
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
          <aside className="live-presenter__rail" aria-label="Presenter">
            <AvatarPanel
              presentation={presentation}
              currentSlide={currentSlide}
              language={language}
              onSlideChange={setCurrentSlide}
              videoPlaying={videoPlaying}
              onRequestVideoAutoPlay={() => setAutoPlayVideo(true)}
              presentationId={presentation.id}
            />
            <div className="live-presenter__qa">
              <AdminOnly action="chat with the presenter agent">
                <QaChat
                  presentationId={presentation.id}
                  slideIndex={currentSlide}
                />
              </AdminOnly>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
