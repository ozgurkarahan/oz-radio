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

/** Words that stay upper case when a shouted run is sentence-cased ("AI", "SQL"); every other shouted word is lower-cased. */
const ACRONYMS = new Set(['AI', 'UI', 'UX', 'API', 'LLM', 'SLM', 'MCP', 'RAG', 'TTS', 'STT', 'SQL', 'PDF', 'FAQ', 'GPU', 'CPU', 'SDK', 'URL', 'ROI']);

const SHOUT_WORD = /^[\p{Lu}\p{N}&'’/-]+$/u;
const SHOUT_SEPARATOR = /^[·•|]$/;
const letterCount = (s: string) => s.replace(/[^\p{L}]/gu, '').length;
const isShoutWord = (t: string) => letterCount(t) >= 2 && SHOUT_WORD.test(t);

/** "OZ RADIO · AI ENABLEMENT" → "Oz radio · AI enablement": shouted words are lower-cased, acronyms kept. */
function sentenceCaseShout(run: string): string {
  const lowered = run.replace(/[\p{L}][\p{L}'’-]*/gu, (word) => (ACRONYMS.has(word) ? word : word.toLocaleLowerCase()));
  return lowered.charAt(0).toLocaleUpperCase() + lowered.slice(1);
}

/**
 * A shouted eyebrow at the start of a run ("OZ RADIO · AI ENABLEMENT · LIVE DEMO A quick look…" → the eyebrow, then the
 * rest). It must be two shouted words or more (or hold a "·"), or the whole run: a single capital "A" or "I" starts the
 * sentence that follows. Mixed-case runs and short acronyms are left alone.
 */
function splitShout(run: string): { shout: string | null; rest: string } {
  const tokens = run.split(' ');
  let end = 0;
  let words = 0;
  let separators = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (isShoutWord(tokens[i])) { words += 1; end = i + 1; }
    else if (SHOUT_SEPARATOR.test(tokens[i]) && i + 1 < tokens.length && isShoutWord(tokens[i + 1])) separators += 1;
    else break;
  }
  const shout = tokens.slice(0, end).join(' ');
  const whole = end === tokens.length;
  if (end === 0 || letterCount(shout) < 6 || (!whole && words < 2 && separators === 0)) return { shout: null, rest: run };
  return { shout, rest: tokens.slice(end).join(' ') };
}

/**
 * Alt text of a slide picture, read as sentences: the title first, then the slide's visible text (public payload `text`,
 * one run per line — or, from the older one-line payload still cached, one run) with repeated runs dropped, shouted
 * eyebrows sentence-cased, page counters ("1 / 5") and a footer that repeats the eyebrow's brand line left out. Cut at a
 * sentence, or at a word.
 */
function slideAlt(slide: { title?: string; text?: string }, index: number): string {
  const title = collapse(slide.title ?? '') || `Slide ${index + 1}`;
  const seen = new Set([title.toLocaleLowerCase()]);
  const pieces: string[] = [];
  let brand = '';
  for (const raw of (slide.text ?? '').split(/\r?\n+/)) {
    const line = collapse(raw);
    if (!line) continue;
    const { shout, rest } = splitShout(line);
    if (shout) {
      const eyebrow = sentenceCaseShout(shout);
      if (pieces.length === 0) brand = eyebrow.split(' · ').slice(0, 2).join(' · ').toLocaleLowerCase();
      pieces.push(eyebrow);
    }
    if (rest) pieces.push(rest);
  }
  const hasBrand = brand.includes(' · ');
  const runs: string[] = [];
  pieces.forEach((piece, i) => {
    let run = piece;
    if (hasBrand && i > 0) {
      const at = run.toLocaleLowerCase().indexOf(brand);
      if (at === 0) return;
      if (at > 0) run = run.slice(0, at);
    }
    run = collapse(run.replace(/\s*\b\d{1,3}\s*\/\s*\d{1,3}\s*$/, ''));
    const key = run.toLocaleLowerCase().replace(/[.!?…:;]+$/, '');
    if (!run || seen.has(key) || seen.has(run.toLocaleLowerCase())) return;
    seen.add(key);
    runs.push(endsSentence(run) ? run : `${run}.`);
  });
  let alt = endsSentence(title) ? title : `${title}.`;
  if (runs.length === 0) return alt.replace(/\.$/, '');
  for (const run of runs) {
    const next = `${alt} ${run}`;
    if (next.length <= ALT_MAX_CHARS) { alt = next; continue; }
    // A first sentence, or a paragraph of one run, that does not fit keeps its start, at a word.
    if (runs[0] === run || run.length > ALT_MAX_CHARS / 2) alt = `${next.slice(0, ALT_MAX_CHARS).replace(/\s+\S*$/, '')}…`;
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
