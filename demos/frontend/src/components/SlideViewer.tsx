import React, { useRef, useEffect } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { type Presentation } from '../services/api';
import { useAuth } from '../services/auth';
import { narrationFor } from '../services/narration';
import { Button, Chip, Segments, langAttr, languageName } from '../ui';
import '../styles/shared/slide-viewer.css';

interface Props {
  presentation: Presentation;
  currentSlide: number;
  onSlideChange: (index: number) => void;
  language: string;
  onVideoPlayingChange?: (playing: boolean) => void;
  autoPlayVideo?: boolean;
  /** Show the file name above the slide (default). Only ever for the owner: a visitor never sees it, whatever the caller passes. */
  showFile?: boolean;
}

const ALT_MAX_CHARS = 250;

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();
const endsSentence = (s: string) => /[.!?…:;]$/.test(s);

/** "BEGINNER LEVEL" → "Beginner level"; short shouted words ("AI", "SQL") and mixed-case runs are left alone. */
function sentenceCaseShout(run: string): string {
  const letters = run.replace(/[^\p{L}]/gu, '');
  if (letters.length < 6 || run !== run.toLocaleUpperCase() || run === run.toLocaleLowerCase()) return run;
  const lower = run.toLocaleLowerCase();
  return lower.charAt(0).toLocaleUpperCase() + lower.slice(1);
}

/**
 * Alt text of a slide picture, read as sentences: the title first, then the slide's visible text (public payload `text`,
 * one run per line) with repeated runs dropped and shouted eyebrows sentence-cased. Cut at a sentence, or at a word.
 */
function slideAlt(slide: { title?: string; text?: string }, index: number): string {
  const title = collapse(slide.title ?? '') || `Slide ${index + 1}`;
  const seen = new Set([title.toLocaleLowerCase()]);
  const runs: string[] = [];
  for (const raw of (slide.text ?? '').split(/\r?\n+/)) {
    const run = sentenceCaseShout(collapse(raw));
    const key = run.toLocaleLowerCase().replace(/[.!?…:;]+$/, '');
    if (!run || seen.has(key) || seen.has(run.toLocaleLowerCase())) continue;
    seen.add(key);
    runs.push(endsSentence(run) ? run : `${run}.`);
  }
  let alt = endsSentence(title) ? title : `${title}.`;
  if (runs.length === 0) return alt.replace(/\.$/, '');
  for (const run of runs) {
    const next = `${alt} ${run}`;
    if (next.length <= ALT_MAX_CHARS) { alt = next; continue; }
    // Not even the first sentence fits: keep its start, at a word.
    if (runs[0] === run) alt = `${next.slice(0, ALT_MAX_CHARS).replace(/\s+\S*$/, '')}…`;
    break;
  }
  return alt;
}

function formatBody(body: string) {
  if (!body) return null;
  const lines = body.split('\n').filter((l) => l.trim());
  if (lines.length <= 1) {
    return <div className="slide-text__body">{body}</div>;
  }
  return (
    <ul className="slide-text__body slide-viewer__bullets">
      {lines.map((line, i) => <li key={i}>{line.trim()}</li>)}
    </ul>
  );
}

export default function SlideViewer({ presentation, currentSlide, onSlideChange, language, onVideoPlayingChange, autoPlayVideo = false, showFile = true }: Props) {
  const slide = presentation.slides[currentSlide];
  const isOwner = useAuth().is_admin;
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [imgError, setImgError] = React.useState(false);
  const [imgLoaded, setImgLoaded] = React.useState(false);

  // Reset image state when slide changes
  useEffect(() => { setImgError(false); setImgLoaded(false); }, [currentSlide, slide?.image_url]);

  // Auto-play the video when the avatar triggers it during presentation mode
  useEffect(() => {
    if (autoPlayVideo && videoRef.current) {
      setTimeout(() => videoRef.current?.play().catch(() => {}), 100);
    }
  }, [autoPlayVideo, slide?.video_url]);

  if (!slide) return <p className="muted">No slides found.</p>;

  // Same selection as the avatar's speech, so what is shown is what is read aloud.
  const narration = narrationFor(slide, language, presentation.language);
  const showNotes = narration.source === 'notes' || narration.source === 'translated_notes';
  const notesLanguage = narration.source === 'translated_notes' ? language : (presentation.language || 'en-US');

  // Build Office Online embed URL when pptx_url is available from Blob Storage
  // wdSlidePage (1-based) navigates the viewer to the current slide
  const officeEmbedUrl = presentation.pptx_url
    ? `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(presentation.pptx_url)}&wdSlidePage=${currentSlide + 1}`
    : null;

  const total = presentation.slide_count;
  const atStart = currentSlide === 0;
  const atEnd = currentSlide >= total - 1;

  return (
    <div className="slide-viewer">
      {showFile && isOwner && (
        <div className="slide-viewer__head">
          <span className="eyebrow slide-viewer__file" title={presentation.filename}>{presentation.filename}</span>
        </div>
      )}

      <div className="media-frame" lang={langAttr(presentation.language)}>
        {slide.video_url ? (
          <div className="media-frame__screen slide-viewer__screen--video">
            <video
              ref={videoRef}
              src={slide.video_url}
              poster={slide.image_url}
              controls
              playsInline
              onPlay={() => onVideoPlayingChange?.(true)}
              onPause={() => onVideoPlayingChange?.(false)}
              onEnded={() => onVideoPlayingChange?.(false)}
            />
          </div>
        ) : slide.image_url && !imgError ? (
          <div className={['media-frame__screen', 'slide-viewer__screen--image', !imgLoaded && 'is-loading'].filter(Boolean).join(' ')}>
            <img
              key={slide.image_url}
              ref={(el) => { if (el?.complete && el.naturalWidth > 0) setImgLoaded(true); }}
              src={slide.image_url}
              alt={slideAlt(slide, currentSlide)}
              onLoad={() => setImgLoaded(true)}
              onError={() => setImgError(true)}
            />
          </div>
        ) : officeEmbedUrl ? (
          <div className="media-frame__screen">
            <iframe
              key={`${presentation.id}-${currentSlide}`}
              src={officeEmbedUrl}
              title={presentation.filename}
              allowFullScreen
            />
          </div>
        ) : (
          <div className="media-frame__screen">
            <div className="slide-text">
              {slide.title && <div className="slide-text__title">{slide.title}</div>}
              {formatBody(slide.body || slide.text || '')}
              <div className="slide-text__num">Slide {currentSlide + 1}</div>
            </div>
          </div>
        )}
      </div>

      <div className="slide-viewer__controls">
        <Button
          size="sm"
          iconOnly
          icon={ChevronLeft}
          aria-label="Previous slide"
          data-testid="slide-prev"
          disabled={atStart}
          onClick={() => onSlideChange(currentSlide - 1)}
        />
        <Button
          size="sm"
          iconOnly
          icon={ChevronRight}
          aria-label="Next slide"
          data-testid="slide-next"
          disabled={atEnd}
          onClick={() => onSlideChange(currentSlide + 1)}
        />
        <Segments total={total} current={currentSlide} label="Slide progress" />
        <span className="slide-viewer__counter small muted tabular" data-testid="slide-counter" aria-live="polite">
          Slide {currentSlide + 1} of {total}
        </span>
      </div>

      {showNotes && (
        <section className="slide-viewer__notes" aria-label="Speaker notes" data-testid="slide-notes">
          <div className="slide-viewer__notes-head">
            <span className="eyebrow" data-testid="slide-notes-label">Speaker notes — read aloud</span>
            <Chip>{languageName(notesLanguage)}</Chip>
          </div>
          {narration.fallbackOriginal && (
            <p className="small muted" data-testid="slide-notes-fallback">
              Original language — translation not available yet
            </p>
          )}
          <p className="slide-viewer__notes-text" data-testid="slide-notes-text" lang={notesLanguage}>{narration.text}</p>
        </section>
      )}
    </div>
  );
}
