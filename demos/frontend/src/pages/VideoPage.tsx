import React, { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ArrowLeft, BarChart3, Check, Clapperboard, Download, FileText, FlaskConical, GraduationCap,
  Library, Play, Plus, RefreshCw, Save, ShoppingBag, Sparkles, type LucideIcon,
} from 'lucide-react';
import {
  DRAGONHD_LANGUAGES, DEFAULT_VOICE_BY_LANG,
  IngestResponse, ScriptStyle, SlideInfo, SlideNarration, VideoJob, VoiceOption, AudienceLevel,
  AUDIENCE_LEVELS, AUDIENCE_LEVEL_LABELS, toAudienceLevel,
  getJob, getScript, ingestFile, listVoices, patchScript,
  startRender, streamScript,
} from '../services/videoApi';
import { useAuth } from '../services/auth';
import { GatedPanel } from '../components/AuthGate';
import {
  Alert, Button, Chip, Dropzone, Field, PageHeader, Progress, Select, Spinner, Steps, Textarea,
  buttonClass, episodeNumber, pluralize,
} from '../ui';
import '../styles/pages/video-create.css';

const SAMPLE_PROMPTS: { icon: LucideIcon; title: string; focus: string }[] = [
  { icon: BarChart3, title: 'Executive Summary', focus: 'Summarize each slide for a C-level audience, highlighting strategic value.' },
  { icon: FlaskConical, title: 'Technical Deep-Dive', focus: 'Explain each slide technically to an engineering audience.' },
  { icon: GraduationCap, title: 'Classroom Explainer', focus: 'Narrate each slide clearly for students. Use analogies.' },
  { icon: ShoppingBag, title: 'Customer Pitch', focus: 'Narrate each slide as a persuasive customer-facing pitch.' },
];

type Phase = 'setup' | 'scripting' | 'review' | 'rendering' | 'done';

const STEPS = ['Deck & settings', 'Narration script', 'Render', 'Result'];
const PHASE_STEP: Record<Phase, number> = { setup: 0, scripting: 1, review: 1, rendering: 2, done: 3 };

const EMOJI_RE = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u{FE0F}\u{200D}]/gu;
/** Language labels from the service carry flag emoji; strip them for display. */
function plainLabel(label: string): string {
  return label.replace(EMOJI_RE, '').replace(/\s+/g, ' ').trim();
}

function VideoHeader({ step }: { step?: number }) {
  return (
    <PageHeader
      className="video-create__header"
      eyebrow="Create · Narrated video"
      title="Narrated video"
      lead="Turn any deck into a narrated video. Upload slides, review the narration slide by slide, pick a voice — the avatar renders the rest."
    >
      {step !== undefined && (
        <div className="video-create__steps">
          <Steps steps={STEPS} current={step} />
        </div>
      )}
    </PageHeader>
  );
}

export default function VideoPage() {
  const auth = useAuth();
  if (auth.loading || !auth.is_admin) {
    return (
      <div className="container page video-create">
        <VideoHeader />
        {auth.loading ? (
          <Spinner label="Loading…" />
        ) : (
          <GatedPanel
            icon={Clapperboard}
            title="Video generation is limited to demo users"
            description="Generating a video uploads a deck, writes narration with an LLM and renders an AI avatar. You can still watch every published video in the library."
            action="generate your own avatar video"
            links={[{ href: '/video/library', label: 'Browse the video library' }, { href: '/decks', label: 'Browse the decks' }]}
          />
        )}
      </div>
    );
  }
  return <VideoGenerator />;
}

function VideoGenerator() {
  const [phase, setPhase] = useState<Phase>('setup');
  const [doc, setDoc] = useState<IngestResponse | null>(null);
  const [uploadBusy, setUploadBusy] = useState(false);

  const [language, setLanguage] = useState('en-US');
  const [style, setStyle] = useState<ScriptStyle>('explainer');
  const [audienceLevel, setAudienceLevel] = useState<AudienceLevel | null>(null);
  const [focus, setFocus] = useState('');
  const [voice, setVoice] = useState<string>(DEFAULT_VOICE_BY_LANG['en-US']);
  const [voices, setVoices] = useState<VoiceOption[]>([]);

  const [narrations, setNarrations] = useState<SlideNarration[]>([]);
  const [selectedIdx, setSelectedIdx] = useState<number>(0);
  const [scriptError, setScriptError] = useState<string | null>(null);
  const [savingPatch, setSavingPatch] = useState(false);
  const abortRef = useRef<(() => void) | null>(null);

  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<VideoJob | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);

  // ---- load voices when language changes ---------------------------------
  useEffect(() => {
    listVoices(language).then((vs) => {
      setVoices(vs);
      if (vs.length === 0) {
        setVoice(DEFAULT_VOICE_BY_LANG[language] ?? voice);
        return;
      }
      const ok = vs.some((v) => v.id === voice);
      if (!ok) {
        const female = vs.find((v) => v.gender === 'female');
        setVoice((female ?? vs[0]).id);
      }
    }).catch(() => {
      setVoices([]);
      setVoice(DEFAULT_VOICE_BY_LANG[language] ?? voice);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language]);

  // ---- poll job ----------------------------------------------------------
  useEffect(() => {
    if (!jobId || !job) return;
    if (['done', 'failed'].includes(job.state)) return;
    const t = setTimeout(async () => {
      try { setJob(await getJob(jobId)); }
      catch { /* ignore transient */ }
    }, 2500);
    return () => clearTimeout(t);
  }, [jobId, job]);

  useEffect(() => { if (job?.state === 'done') setPhase('done'); }, [job?.state]);

  // ---- actions -----------------------------------------------------------
  async function handleFile(f: File) {
    setUploadBusy(true);
    try { setDoc(await ingestFile(f)); }
    catch (e: any) { alert(`Upload failed: ${e?.message ?? e}`); }
    finally { setUploadBusy(false); }
  }

  function startScript() {
    if (!doc) return;
    setPhase('scripting');
    setNarrations([]); setScriptError(null); setSelectedIdx(0);
    abortRef.current?.();
    streamScript(
      doc.doc_id,
      { language, style, focus: focus || undefined, audience_level: audienceLevel, voice },
      (n) => setNarrations((prev) => {
        const next = [...prev];
        const existing = next.findIndex((x) => x.slide_index === n.slide_index);
        if (existing >= 0) next[existing] = n; else next.push(n);
        next.sort((a, b) => a.slide_index - b.slide_index);
        return next;
      }),
      async () => {
        try {
          const full = await getScript(doc.doc_id);
          setNarrations(full.narrations);
        } catch { /* use streamed */ }
        setPhase('review');
      },
      (msg) => setScriptError(msg),
    ).then((abort) => { abortRef.current = abort; });
  }

  async function updateSlideNarration(slideIndex: number, text: string) {
    // Local update first (optimistic)
    setNarrations((prev) => prev.map((n) =>
      n.slide_index === slideIndex ? { ...n, narration: text } : n));
  }

  function updateSlideVoice(slideIndex: number, nextVoice: string) {
    setNarrations((prev) => prev.map((n) =>
      n.slide_index === slideIndex ? { ...n, voice: nextVoice } : n));
  }

  async function saveSlidePatch(slideIndex: number, text: string, nextVoice?: string) {
    if (!doc) return;
    setSavingPatch(true);
    try {
      const updated = await patchScript(doc.doc_id, [{
        slide_index: slideIndex,
        narration: text,
        voice: nextVoice,
      }]);
      setNarrations(updated.narrations);
    } catch (e: any) {
      alert(`Save failed: ${e?.message ?? e}`);
    } finally {
      setSavingPatch(false);
    }
  }

  async function regenerateSlide(slideIndex: number) {
    if (!doc) return;
    // Single-slide regen: re-run script stream with a narrow focus instruction.
    setSavingPatch(true);
    try {
      const r = await fetch(`/api/video/script/${doc.doc_id}/slide/${slideIndex}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ language, style, focus, audience_level: audienceLevel, voice }),
      });
      if (r.ok) {
        const updated = await r.json();
        if (updated && typeof updated.slide_index === 'number') {
          setNarrations((prev) => prev.map((n) =>
            n.slide_index === slideIndex ? updated : n));
        }
      } else {
        // Fallback: re-stream full script
        alert('Per-slide regeneration unavailable — regenerating the whole script.');
        startScript();
      }
    } catch (e: any) {
      alert(`Regenerate failed: ${e?.message ?? e}`);
    } finally {
      setSavingPatch(false);
    }
  }

  async function kickOffRender() {
    if (!doc) return;
    try {
      const { job_id } = await startRender(doc.doc_id);
      setJobId(job_id);
      setJob(makeQueuedJob(job_id, doc.doc_id, doc.slides.length));
      setPhase('rendering');
      setRenderError(null);
      try {
        setJob(await getJob(job_id));
      } catch (e: any) {
        setRenderError(`Render started, but polling failed: ${e?.message ?? e}`);
      }
    } catch (e: any) {
      setRenderError(String(e?.message ?? e));
      alert(`Render failed to start: ${e?.message ?? e}`);
    }
  }

  const displayTitle = doc?.title ?? doc?.filename ?? '';

  return (
    <div className="container page video-create">
      <VideoHeader step={PHASE_STEP[phase]} />
      <AnimatePresence mode="wait">
        {phase === 'setup' && (
          <motion.div key="setup" {...fade}>
            <SetupPhase
              doc={doc} uploadBusy={uploadBusy}
              focus={focus} onFocusChange={setFocus}
              style={style} onStyle={setStyle}
              audienceLevel={audienceLevel} onAudienceLevel={setAudienceLevel}
              language={language} onLanguage={setLanguage}
              voice={voice} onVoice={setVoice} voices={voices}
              onFile={handleFile}
              onApplyPrompt={(p) => setFocus(p.focus)}
              onGenerate={startScript}
            />
          </motion.div>
        )}
        {phase === 'scripting' && (
          <motion.div key="scripting" {...fade}>
            <ScriptStreamingView narrations={narrations} error={scriptError} total={doc?.slides.length ?? 0} />
          </motion.div>
        )}
        {phase === 'review' && doc && (
          <motion.div key="review" {...fade}>
            <ScriptReview
              slides={doc.slides}
              narrations={narrations}
              selectedIdx={selectedIdx}
              onSelect={setSelectedIdx}
              voices={voices}
              onNarrationChange={updateSlideNarration}
              onVoiceChange={updateSlideVoice}
              onSavePatch={saveSlidePatch}
              onRegenerate={regenerateSlide}
              savingPatch={savingPatch}
              onRender={kickOffRender}
              onBack={() => setPhase('setup')}
            />
          </motion.div>
        )}
        {phase === 'rendering' && job && (
          <motion.div key="rendering" {...fade}>
            <RenderingView job={job} slideCount={doc?.slides.length ?? 0} error={renderError} />
          </motion.div>
        )}
        {phase === 'done' && (
          <motion.div key="done" {...fade}>
            <DoneView
              jobId={jobId}
              job={job}
              title={displayTitle}
              onNew={() => {
                setPhase('setup'); setDoc(null); setJob(null); setJobId(null);
                setNarrations([]); setSelectedIdx(0);
              }}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ---------------------------------------------------------------------------
const fade = {
  initial: { opacity: 0, y: 8 }, animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -8 }, transition: { duration: 0.22 },
};

function makeQueuedJob(jobId: string, docId: string, total: number): VideoJob {
  const now = new Date().toISOString();
  return {
    job_id: jobId,
    doc_id: docId,
    state: 'queued',
    progress: {
      stage: 'queued',
      percent: 0,
      completed: 0,
      total,
      message: 'Queued for rendering…',
    },
    outputs: {},
    error: null,
    created_at: now,
    updated_at: now,
    archive_state: 'none',
  };
}

// ---- Setup phase ----------------------------------------------------------
interface SetupProps {
  doc: IngestResponse | null;
  uploadBusy: boolean;
  focus: string; onFocusChange: (v: string) => void;
  style: ScriptStyle; onStyle: (s: ScriptStyle) => void;
  audienceLevel: AudienceLevel | null; onAudienceLevel: (l: AudienceLevel | null) => void;
  language: string; onLanguage: (l: string) => void;
  voice: string; onVoice: (v: string) => void;
  voices: VoiceOption[];
  onFile: (f: File) => void;
  onApplyPrompt: (p: typeof SAMPLE_PROMPTS[number]) => void;
  onGenerate: () => void;
}

function SetupPhase(p: SetupProps) {
  return (
    <div className="video-setup">
      <section className="video-panel video-setup__deck" aria-labelledby="video-deck-title">
        <div className="video-panel__head">
          <span className="video-panel__num" aria-hidden>01</span>
          <h2 id="video-deck-title" className="video-panel__title">Slide deck</h2>
        </div>
        <Uploader doc={p.doc} busy={p.uploadBusy} onFile={p.onFile} />
        {p.doc && <SlidePreviewStrip slides={p.doc.slides} />}
      </section>

      <section className="video-panel video-setup__settings" aria-labelledby="video-settings-title">
        <div className="video-panel__head">
          <span className="video-panel__num" aria-hidden>02</span>
          <h2 id="video-settings-title" className="video-panel__title">Narration</h2>
        </div>
        <div className="video-settings">
          <Field label="Language">
            <Select value={p.language} onChange={(e) => p.onLanguage(e.target.value)}>
              {DRAGONHD_LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>{plainLabel(l.label)}</option>
              ))}
            </Select>
          </Field>
          <Field label="Voice">
            <Select value={p.voice} onChange={(e) => p.onVoice(e.target.value)}>
              {p.voices.length === 0 ? (
                <option value={p.voice}>{p.voice}</option>
              ) : (
                p.voices.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.display_name} · {v.gender}
                  </option>
                ))
              )}
            </Select>
          </Field>
          <Field label="Style">
            <Select value={p.style} onChange={(e) => p.onStyle(e.target.value as ScriptStyle)}>
              <option value="explainer">Explainer</option>
              <option value="formal">Formal</option>
              <option value="casual">Casual</option>
              <option value="marketing">Marketing</option>
            </Select>
          </Field>
          <Field label="Audience level">
            <Select
              value={p.audienceLevel ?? ''}
              onChange={(e) => p.onAudienceLevel(toAudienceLevel(e.target.value))}
            >
              <option value="">Any (default)</option>
              {AUDIENCE_LEVELS.map((lvl) => <option key={lvl} value={lvl}>{AUDIENCE_LEVEL_LABELS[lvl]}</option>)}
            </Select>
          </Field>
          <div className="video-settings__full">
            <span className="field__label" id="video-prompts-label">Starting points</span>
            <div className="video-prompts" role="group" aria-labelledby="video-prompts-label">
              {SAMPLE_PROMPTS.map((sp) => {
                const Icon = sp.icon;
                const active = p.focus === sp.focus;
                return (
                  <button
                    key={sp.title}
                    type="button"
                    className={['video-prompts__item', active && 'is-active'].filter(Boolean).join(' ')}
                    aria-pressed={active}
                    onClick={() => p.onApplyPrompt(sp)}
                  >
                    <span className="video-prompts__title"><Icon aria-hidden />{sp.title}</span>
                    <span className="video-prompts__text">{sp.focus}</span>
                  </button>
                );
              })}
            </div>
          </div>
          <Field label="Narration focus (optional)" className="video-settings__full">
            <Textarea
              value={p.focus}
              onChange={(e) => p.onFocusChange(e.target.value)}
              rows={3}
              placeholder="Describe the angle — e.g. 'emphasise MCP security for practitioners'"
            />
          </Field>
        </div>
        <div className="video-setup__cta">
          <Button variant="primary" size="lg" icon={Sparkles} disabled={!p.doc} onClick={p.onGenerate}>
            Generate narration
          </Button>
          {!p.doc && <span className="small muted">Upload a document first</span>}
        </div>
      </section>
    </div>
  );
}

function Uploader({ doc, busy, onFile }: {
  doc: IngestResponse | null; busy: boolean; onFile: (f: File) => void;
}) {
  if (doc) {
    return (
      <div className="video-doc">
        <span className="video-doc__icon" aria-hidden><FileText /></span>
        <div className="video-doc__body">
          <div className="video-doc__title serif">{doc.title ?? doc.filename ?? 'Uploaded deck'}</div>
          <div className="small muted tabular">
            {pluralize(doc.slides.length, 'slide')} detected
          </div>
        </div>
        <Chip tone="sage" icon={Check}>Ready</Chip>
      </div>
    );
  }
  return (
    <Dropzone
      onFile={onFile}
      accept=".pptx,.pdf,.png,.jpg,.jpeg"
      busy={busy}
      icon={Clapperboard}
      title="Drop a PPTX, PDF or image here"
      busyTitle="Processing…"
      hint="or click to browse"
    />
  );
}

function SlidePreviewStrip({ slides }: { slides: SlideInfo[] }) {
  return (
    <div className="video-strip" aria-label="Slide preview">
      <ol className="video-strip__list">
        {slides.slice(0, 12).map((s) => (
          <li key={s.index} className="video-strip__item">
            {s.image_ref ? (
              <img src={s.image_ref} alt={s.title} loading="lazy" />
            ) : (
              <span className="video-strip__text">{s.title || `Slide ${s.index + 1}`}</span>
            )}
            <span className="video-strip__num tabular">{s.index + 1}</span>
          </li>
        ))}
      </ol>
      {slides.length > 12 && (
        <span className="small muted video-strip__more">+{slides.length - 12} more</span>
      )}
    </div>
  );
}

// ---- Scripting ------------------------------------------------------------
function ScriptStreamingView({ narrations, error, total }: {
  narrations: SlideNarration[]; error: string | null; total: number;
}) {
  return (
    <section className="video-panel" aria-labelledby="video-stream-title" aria-busy={!error}>
      <div className="video-panel__head">
        {!error && <span className="spinner" aria-hidden />}
        <h2 id="video-stream-title" className="video-panel__title">Writing the narration…</h2>
        <span className="video-panel__aside small muted tabular">
          {narrations.length}{total ? ` / ${total}` : ''} slides
        </span>
      </div>
      {total > 0 && !error && <Progress value={narrations.length / total} label="Narration progress" />}
      {error ? (
        <Alert tone="error">Error: {error}</Alert>
      ) : (
        <>
          {narrations.length === 0 && (
            <p className="small muted">Narration appears here slide by slide as it is written.</p>
          )}
          <ol className="video-narrations" aria-live="polite">
            {narrations.map((n) => (
              <motion.li
                key={n.slide_index}
                className="video-narrations__row"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
              >
                <span className="video-narrations__num tabular" aria-hidden>{episodeNumber(n.slide_index + 1)}</span>
                <div className="video-narrations__body">
                  <h3 className="video-narrations__title">
                    <span className="sr-only">Slide {n.slide_index + 1}: </span>{n.title || '—'}
                  </h3>
                  <p className="video-narrations__text">{n.narration}</p>
                </div>
              </motion.li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}

// ---- Review (per-slide editor) -------------------------------------------
function ScriptReview({
  slides, narrations, selectedIdx, onSelect,
  voices, onNarrationChange, onVoiceChange, onSavePatch, onRegenerate, savingPatch,
  onRender, onBack,
}: {
  slides: SlideInfo[];
  narrations: SlideNarration[];
  selectedIdx: number;
  onSelect: (i: number) => void;
  voices: VoiceOption[];
  onNarrationChange: (slideIndex: number, text: string) => void;
  onVoiceChange: (slideIndex: number, voice: string) => void;
  onSavePatch: (slideIndex: number, text: string, voice?: string) => Promise<void>;
  onRegenerate: (slideIndex: number) => Promise<void>;
  savingPatch: boolean;
  onRender: () => void;
  onBack: () => void;
}) {
  const currentSlide = slides[selectedIdx];
  const currentNar = useMemo(
    () => narrations.find((n) => n.slide_index === selectedIdx),
    [narrations, selectedIdx],
  );
  const [draft, setDraft] = useState<string>(currentNar?.narration ?? '');
  useEffect(() => { setDraft(currentNar?.narration ?? ''); }, [selectedIdx, currentNar?.narration]);

  const dirty = (currentNar?.narration ?? '') !== draft;

  return (
    <section className="video-panel" aria-labelledby="video-review-title">
      <div className="video-review__bar">
        <div className="video-review__heading">
          <h2 id="video-review-title" className="video-panel__title">Review &amp; edit narration</h2>
          <span className="small muted tabular">{narrations.length} slides narrated</span>
        </div>
        <div className="cluster">
          <Button icon={ArrowLeft} onClick={onBack}>Back</Button>
          <Button variant="primary" icon={Clapperboard} onClick={onRender}>Render video</Button>
        </div>
      </div>

      <div className="video-review">
        <ol className="video-review__list" aria-label="Slides">
          {slides.map((s) => {
            const active = s.index === selectedIdx;
            const nar = narrations.find((n) => n.slide_index === s.index);
            return (
              <li key={s.index}>
                <button
                  type="button"
                  className={['video-review__item', active && 'is-active'].filter(Boolean).join(' ')}
                  aria-current={active ? 'true' : undefined}
                  onClick={() => onSelect(s.index)}
                >
                  <span className="video-review__num tabular" aria-hidden>{episodeNumber(s.index + 1)}</span>
                  <span className="video-review__thumb" aria-hidden>
                    {s.image_ref ? <img src={s.image_ref} alt="" loading="lazy" /> : <FileText />}
                  </span>
                  <span className="video-review__meta">
                    <span className="video-review__title">
                      <span className="sr-only">Slide {s.index + 1}: </span>{s.title || nar?.title || '—'}
                    </span>
                    <span className={['video-review__state', nar && 'is-done'].filter(Boolean).join(' ')}>
                      {nar ? <><Check aria-hidden />Narrated</> : 'Pending'}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>

        <div className="video-review__editor">
          {currentSlide && (
            <div className="media-frame">
              <div className="media-frame__screen">
                {currentSlide.image_ref ? (
                  <img src={currentSlide.image_ref} alt={currentSlide.title} />
                ) : (
                  <div className="slide-text">
                    <div className="slide-text__title">{currentSlide.title || `Slide ${currentSlide.index + 1}`}</div>
                    <div className="slide-text__num">Slide {currentSlide.index + 1}</div>
                  </div>
                )}
              </div>
            </div>
          )}
          <div className="video-review__form">
            <Field label={`Narration — slide ${selectedIdx + 1}`}>
              <Textarea
                className="video-review__textarea"
                value={draft}
                rows={6}
                onChange={(e) => { setDraft(e.target.value); onNarrationChange(selectedIdx, e.target.value); }}
                placeholder="Narration text for this slide…"
              />
            </Field>
            <div className="video-review__actions">
              <Field label="Voice" className="video-review__voice">
                <Select
                  value={currentNar?.voice ?? ''}
                  onChange={async (e) => {
                    if (!currentNar) return;
                    const nv = e.target.value;
                    onVoiceChange(selectedIdx, nv);
                    try {
                      await onSavePatch(selectedIdx, draft, nv);
                    } catch (err) {
                      alert(`Voice update failed: ${err instanceof Error ? err.message : String(err)}`);
                    }
                  }}
                >
                  {voices.length === 0 ? (
                    <option value={currentNar?.voice ?? ''}>{currentNar?.voice ?? '—'}</option>
                  ) : (
                    voices.map((v) => (
                      <option key={v.id} value={v.id}>{v.display_name} · {v.gender}</option>
                    ))
                  )}
                </Select>
              </Field>
              <div className="cluster video-review__buttons">
                <Button
                  icon={RefreshCw}
                  onClick={() => onRegenerate(selectedIdx)}
                  disabled={savingPatch}
                >
                  Regenerate slide
                </Button>
                <Button
                  variant="primary"
                  icon={Save}
                  busy={savingPatch}
                  onClick={() => onSavePatch(selectedIdx, draft)}
                  disabled={!dirty || savingPatch}
                >
                  {savingPatch ? 'Saving…' : 'Save'}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// ---- Rendering progress ---------------------------------------------------
function RenderingView({ job, slideCount, error }: {
  job: VideoJob; slideCount: number; error: string | null;
}) {
  const pct = Math.max(0, Math.min(100, Math.round(job.progress.percent ?? 0)));
  const failed = job.state === 'failed';
  const done = job.state === 'done';
  const effectiveError = error ?? job.error ?? null;
  return (
    <section className="video-panel video-render" aria-labelledby="video-render-title" aria-busy={!done && !failed}>
      <div className="video-panel__head">
        {!done && !failed && <span className="spinner" aria-hidden />}
        <h2 id="video-render-title" className="video-panel__title">
          {done ? 'Video ready' : failed ? 'Render failed' : 'Rendering your video…'}
        </h2>
      </div>
      <div className={['video-render__stage', failed && 'is-failed', done && 'is-done'].filter(Boolean).join(' ')} role="status">
        <span className="eyebrow">{job.progress.stage || job.state}</span>
        <span className="video-render__message">
          {job.progress.message || (done ? 'Complete.' : 'Working…')}
        </span>
      </div>
      <div className="video-render__progress">
        <div className="split small muted">
          <span>Progress</span>
          <span className="tabular">{pct}%</span>
        </div>
        <Progress value={pct / 100} label="Render progress" />
      </div>
      {effectiveError && <Alert tone="error">{effectiveError}</Alert>}
      <p className="small muted">
        {slideCount} slides · typical render takes 2–5 minutes.
      </p>
    </section>
  );
}

function DoneView({ jobId, job, title, onNew }: {
  jobId: string | null; job: VideoJob | null; title: string; onNew: () => void;
}) {
  const outputs = job?.outputs ?? {};
  return (
    <section className="video-panel video-done" aria-labelledby="video-done-title">
      <div className="video-panel__head">
        <span className="video-done__badge" aria-hidden><Check /></span>
        <h2 id="video-done-title" className="video-panel__title">Your video is ready</h2>
      </div>
      <p className="video-done__lead">
        {title ? <>&ldquo;{title}&rdquo; has been saved to your library as a draft — publish it there to share it publicly.</> : 'Saved to the library as a draft.'}
      </p>
      {outputs.video_url && (
        <div className="stage video-done__stage">
          <video
            src={outputs.video_url}
            poster={outputs.thumbnail_url ?? undefined}
            controls
            playsInline
            preload="metadata"
            data-oz-media="video"
          />
        </div>
      )}
      <div className="cluster video-done__actions">
        <a href="/video/library" className={buttonClass({ variant: 'primary' })}>
          <Library aria-hidden />View in library
        </a>
        {jobId && (
          <a href={`/video/library?job=${encodeURIComponent(jobId)}`} className={buttonClass({})}>
            <Play aria-hidden />Play now
          </a>
        )}
        {outputs.video_url && (
          <a href={outputs.video_url} download className={buttonClass({})}>
            <Download aria-hidden />Download video
          </a>
        )}
        {outputs.srt_url && (
          <a href={outputs.srt_url} download className={buttonClass({})}>
            <Download aria-hidden />Subtitles (.srt)
          </a>
        )}
        <Button icon={Plus} onClick={onNew}>New video</Button>
      </div>
    </section>
  );
}
