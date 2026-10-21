import React, { useEffect, useId, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  AlertCircle, ArrowLeft, BarChart3, CheckCircle2, Clapperboard, Clock, Download, FileText, FlaskConical, Globe,
  GraduationCap, Headphones, Library, Mic, Plus, Presentation, Scale, SlidersHorizontal, Sparkles, Users,
  type LucideIcon,
} from 'lucide-react';
import {
  DialogueTurn, Document as PodDoc, Layout, PodcastFormat, PodcastHost,
  PodcastJob, ReactionId, RoleConfig, Speaker, Style, Transcript, VoiceOption, AudienceLevel,
  AUDIENCE_LEVELS, AUDIENCE_LEVEL_LABELS, REACTION_LABELS, toAudienceLevel,
  getJob, getJobTranscript, hasVideo, ingestFile, ingestUrl, jobFileUrl, listVoices,
  startRender, streamScript, warningLabel,
} from '../services/podcast';
import { type AvatarInfo, listAvatars, pickAvatarForGender } from '../services/avatars';
import { useAuth } from '../services/auth';
import { GatedPanel } from '../components/AuthGate';
import { RadioPlayer, mapRenditionTime, toRadioHosts, type RadioPlayerHandle } from '../components/RadioPlayer';
import {
  Alert, Button, ButtonLink, Checkbox, Chip, Dropzone, Field, HostDisc, Input, LivePill, PageHeader,
  Progress, SectionHead, Select, Spinner, Steps, Tabs, Textarea, Waveform, buttonClass, languageName, pluralize,
} from '../ui';
import '../styles/pages/podcast-create.css';

const SAMPLE_PROMPTS: { icon: LucideIcon; title: string; focus: string }[] = [
  { icon: BarChart3, title: 'Executive Summary', focus: 'Summarize the key strategic points for a C-level audience.' },
  { icon: FlaskConical, title: 'Product Deep-Dive', focus: 'Explain the technical mechanics clearly to an engineering audience.' },
  { icon: Scale, title: 'Balanced Debate', focus: 'Present the strongest arguments for and against the proposal.' },
  { icon: GraduationCap, title: 'Classroom Explainer', focus: 'Make this accessible to a motivated student. Use analogies.' },
];

const LANGUAGES = ['en-US', 'fr-FR', 'es-ES', 'de-DE', 'it-IT', 'pt-BR', 'zh-CN', 'ja-JP'];

type Phase = 'setup' | 'scripting' | 'review' | 'rendering' | 'done';

const WIZARD_STEPS = ['Source', 'Script', 'Review & cast', 'Render', 'Listen'];
const PHASE_STEP: Record<Phase, number> = { setup: 0, scripting: 1, review: 2, rendering: 3, done: 4 };

function Header({ actions }: { actions?: React.ReactNode }) {
  return (
    <PageHeader
      eyebrow="Create · Two-host podcast"
      title={<>Two hosts, <em>one conversation.</em></>}
      lead="Transform any document into a dual-host conversation, with two AI avatars walking through your slides — in any language, in minutes."
      actions={actions}
    />
  );
}

export default function PodcastPage() {
  const auth = useAuth();
  if (auth.loading || !auth.is_admin) {
    return (
      <div className="container page podcast-create">
        <Header />
        {!auth.loading && (
          <GatedPanel
            icon={Headphones}
            title="Podcast creation is for the site owner"
            description="The owner uploads a document, writes a script with an LLM and renders two AI avatars. You can listen to every published podcast in the library without signing in, or start the live demo."
            action="create podcasts"
            links={[{ href: '/podcast/library', label: 'Browse the podcast library' }, { href: '/video/library', label: 'Browse the video library' }]}
          />
        )}
      </div>
    );
  }
  return <PodcastGenerator />;
}

function PodcastGenerator() {
  const [phase, setPhase] = useState<Phase>('setup');
  const [doc, setDoc] = useState<PodDoc | null>(null);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [urlInput, setUrlInput] = useState('');
  const [focus, setFocus] = useState('');
  const [style, setStyle] = useState<Style>('casual');
  const [audienceLevel, setAudienceLevel] = useState<AudienceLevel | null>(null);
  const [numTurns, setNumTurns] = useState(8);
  const [language, setLanguage] = useState('en-US');
  const [avatars, setAvatars] = useState<AvatarInfo[]>([]);
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  // Same cast as the live presenter and the published library: Sofia interviews,
  // Lucas is the expert. Display names default to the avatar names.
  const [interviewer, setInterviewer] = useState<RoleConfig>({
    display_name: '', avatar: '', voice: 'en-US-Ava:DragonHDLatestNeural',
  });
  const [expert, setExpert] = useState<RoleConfig>({
    display_name: '', avatar: '', voice: 'en-US-Andrew:DragonHDLatestNeural',
  });
  const [streamingTurns, setStreamingTurns] = useState<DialogueTurn[]>([]);
  const [scriptId, setScriptId] = useState<string | null>(null);
  const [scriptError, setScriptError] = useState<string | null>(null);
  const abortRef = useRef<(() => void) | null>(null);
  const [job, setJob] = useState<PodcastJob | null>(null);
  const [starting, setStarting] = useState(false);
  const [format, setFormat] = useState<PodcastFormat>('video');
  const [music, setMusic] = useState(true);
  const [intro, setIntro] = useState(true);
  const [reactions, setReactions] = useState(true);
  const [layout] = useState<Layout>('split_screen_with_slides');
  // Last avatar per host, restored when switching back to video (which needs both).
  const lastAvatar = useRef<Record<Speaker, string>>({ interviewer: '', expert: '' });

  useEffect(() => {
    listAvatars().then((list) => {
      setAvatars(list);
      const ids = new Set(list.map((a) => a.id));
      const female = pickAvatarForGender(list, 'female');
      const male = pickAvatarForGender(list, 'male');
      const withAvatar = (prev: RoleConfig, pick: AvatarInfo | undefined): RoleConfig => {
        const avatar = ids.has(prev.avatar) ? list.find((a) => a.id === prev.avatar) : pick;
        return { ...prev, avatar: avatar?.id ?? '', display_name: prev.display_name || avatar?.display_name || '' };
      };
      setInterviewer((prev) => withAvatar(prev, female));
      setExpert((prev) => withAvatar(prev, male));
    }).catch(() => {});
  }, []);
  useEffect(() => {
    listVoices(language).then((vs) => {
      setVoices(vs);
      if (vs.length === 0) return;
      // Auto-swap interviewer/expert voices when the selected language changes,
      // unless the user's current voice already matches the new language.
      const intOk = vs.some(v => v.id === interviewer.voice);
      const expOk = vs.some(v => v.id === expert.voice);
      if (intOk && expOk) return;
      const male = vs.find(v => v.gender === 'male');
      const female = vs.find(v => v.gender === 'female');
      const intPick = female ?? vs[0];
      const expPick = male && male.id !== intPick.id ? male : vs.find(v => v.id !== intPick.id) ?? vs[0];
      if (!intOk) setInterviewer(prev => ({ ...prev, voice: intPick.id }));
      if (!expOk) setExpert(prev => ({ ...prev, voice: expPick.id }));
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language]);
  useEffect(() => { if (interviewer.avatar) lastAvatar.current.interviewer = interviewer.avatar; }, [interviewer.avatar]);
  useEffect(() => { if (expert.avatar) lastAvatar.current.expert = expert.avatar; }, [expert.avatar]);

  useEffect(() => {
    if (!job || TERMINAL_STATES.includes(job.state)) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      let next: PodcastJob | null = null;
      try { next = await getJob(job.id); } catch { /* transient error: poll again */ }
      if (!cancelled) setJob(isJob(next) ? next : { ...job });
    }, 2500);
    return () => { cancelled = true; clearTimeout(t); };
  }, [job]);

  useEffect(() => { if (job?.state === 'done') setPhase('done'); }, [job?.state]);

  async function handleFile(f: File) {
    setUploadBusy(true);
    try { setDoc(await ingestFile(f)); }
    catch (e) { alert(`Upload failed: ${e}`); }
    finally { setUploadBusy(false); }
  }
  async function handleUrl() {
    if (!urlInput.trim()) return;
    setUploadBusy(true);
    try { setDoc(await ingestUrl(urlInput.trim())); setUrlInput(''); }
    catch (e) { alert(`URL ingest failed: ${e}`); }
    finally { setUploadBusy(false); }
  }

  function startScript() {
    if (!doc) return;
    setPhase('scripting');
    setStreamingTurns([]); setScriptId(null); setScriptError(null);
    abortRef.current?.();
    streamScript(
      {
        document_id: doc.id, language, style, length: 'medium', num_turns: numTurns, focus: focus || undefined,
        audience_level: audienceLevel,
      },
      (t) => setStreamingTurns((prev) => [...prev, t]),
      (id) => { setScriptId(id); setPhase('review'); },
      (msg) => setScriptError(msg),
    ).then((abort) => { abortRef.current = abort; });
  }

  /** Video needs both avatars: switching back restores the last ones (else the default cast). */
  function changeFormat(next: PodcastFormat) {
    setFormat(next);
    if (next !== 'video') return;
    const restore = (speaker: Speaker) => (prev: RoleConfig): RoleConfig => {
      if (prev.avatar) return prev;
      const pick = avatars.find((a) => a.id === lastAvatar.current[speaker])
        ?? pickAvatarForGender(avatars, speaker === 'interviewer' ? 'female' : 'male');
      return pick ? { ...prev, avatar: pick.id, display_name: prev.display_name || pick.display_name } : prev;
    };
    setInterviewer(restore('interviewer'));
    setExpert(restore('expert'));
  }

  const canRender = format === 'audio' || (!!interviewer.avatar && !!expert.avatar);

  async function kickOffRender() {
    if (!scriptId || !canRender || starting) return;
    setStarting(true);
    try {
      const named = (r: RoleConfig, speaker: Speaker): RoleConfig => ({
        ...r, display_name: r.display_name.trim() || avatars.find((a) => a.id === r.avatar)?.display_name || ROLE_LABEL[speaker],
      });
      const j = await startRender({
        script_id: scriptId, roles: { interviewer: named(interviewer, 'interviewer'), expert: named(expert, 'expert') },
        format, reactions, intro, music, layout,
      });
      setJob(j); setPhase('rendering');
    } catch (e) { alert(`Render failed to start: ${e}`); }
    finally { setStarting(false); }
  }

  const cast: Cast = { interviewer, expert, avatars };
  // Mocked or legacy jobs may omit `format`: fall back to the requested one.
  const jobFormat: PodcastFormat = job?.format ?? format;

  return (
    <div className="container page podcast-create">
      <Header actions={<ButtonLink to="/podcast/library" icon={Library}>Podcast library</ButtonLink>} />
      <div className="pc-steps">
        <Steps steps={WIZARD_STEPS} current={PHASE_STEP[phase]} />
      </div>
      <AnimatePresence mode="wait">
        {phase === 'setup' && (
          <motion.div key="setup" {...fade}>
            <SetupPhase {...{
              doc, uploadBusy, urlInput, focus, style, audienceLevel, numTurns, language,
            }}
              onUrlInput={setUrlInput} onFile={handleFile} onUrl={handleUrl}
              onFocusChange={setFocus} onApplyPrompt={(p) => setFocus(p.focus)}
              onStyle={setStyle} onAudienceLevel={setAudienceLevel}
              onNumTurns={setNumTurns} onLanguage={setLanguage}
              onGenerate={startScript} />
          </motion.div>
        )}
        {phase === 'scripting' && (
          <motion.div key="scripting" {...fade}>
            <ScriptStreamingView turns={streamingTurns} error={scriptError} cast={cast} showReactions={reactions} />
          </motion.div>
        )}
        {phase === 'review' && (
          <motion.div key="review" {...fade}>
            <ScriptReview
              turns={streamingTurns} cast={cast} voices={voices}
              format={format} onFormat={changeFormat}
              onInterviewer={setInterviewer} onExpert={setExpert}
              music={music} intro={intro} reactions={reactions}
              onMusic={setMusic} onIntro={setIntro} onReactions={setReactions}
              canRender={canRender} starting={starting}
              onRender={kickOffRender} onBack={() => setPhase('setup')} />
          </motion.div>
        )}
        {phase === 'rendering' && job && (
          <motion.div key="rendering" {...fade}>
            <RenderingView job={job} format={jobFormat} turns={streamingTurns}
              onBack={() => { setJob(null); setPhase('review'); }} />
          </motion.div>
        )}
        {phase === 'done' && job && (
          <motion.div key="done" {...fade}>
            <ResultView job={job} format={jobFormat} title={doc?.title || 'Your podcast'}
              turns={streamingTurns} cast={cast} reactions={job.reactions ?? reactions}
              onNew={() => {
                setPhase('setup'); setDoc(null); setJob(null);
                setStreamingTurns([]); setScriptId(null);
              }} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

const fade = {
  initial: { opacity: 0, y: 10 }, animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -10 }, transition: { duration: 0.25 },
};

interface Cast { interviewer: RoleConfig; expert: RoleConfig; avatars: AvatarInfo[] }

const ROLE_LABEL: Record<Speaker, string> = { interviewer: 'Interviewer', expert: 'Expert' };
const SPEAKERS: Speaker[] = ['interviewer', 'expert'];
const TERMINAL_STATES: string[] = ['done', 'failed', 'cancelled'];

function hostFor(cast: Cast, speaker: Speaker) {
  const role = speaker === 'interviewer' ? cast.interviewer : cast.expert;
  const avatar = cast.avatars.find((a) => a.id === role.avatar);
  return { display_name: role.display_name || ROLE_LABEL[speaker], thumbnail_url: avatar?.thumbnail_url ?? null };
}

const otherSpeaker = (s: Speaker): Speaker => (s === 'interviewer' ? 'expert' : 'interviewer');

/** Label of a turn's planned backchannel, or null (none / unknown id). */
function reactionLabel(turn: DialogueTurn): string | null {
  const id = turn.reaction?.reaction_id;
  return id && Object.prototype.hasOwnProperty.call(REACTION_LABELS, id) ? REACTION_LABELS[id as ReactionId] : null;
}

function isJob(v: unknown): v is PodcastJob {
  return !!v && typeof v === 'object' && !Array.isArray(v)
    && typeof (v as PodcastJob).id === 'string' && typeof (v as PodcastJob).state === 'string';
}

/** A transcript.json payload, else null (e.g. a job rendered before radio transcripts existed). */
function asTranscript(v: unknown): Transcript | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const t = v as Partial<Transcript>;
  return Array.isArray(t.cues) || Array.isArray(t.turns) ? (v as Transcript) : null;
}

interface SetupProps {
  doc: PodDoc | null; uploadBusy: boolean;
  urlInput: string; onUrlInput: (v: string) => void;
  onFile: (f: File) => void; onUrl: () => void;
  focus: string; onFocusChange: (v: string) => void;
  onApplyPrompt: (p: typeof SAMPLE_PROMPTS[number]) => void;
  style: Style; onStyle: (s: Style) => void;
  audienceLevel: AudienceLevel | null; onAudienceLevel: (l: AudienceLevel | null) => void;
  numTurns: number; onNumTurns: (n: number) => void;
  language: string; onLanguage: (l: string) => void;
  onGenerate: () => void;
}
function SetupPhase(p: SetupProps) {
  return (
    <div className="pc-setup">
      <div className="pc-setup__main">
        <section className="pc-section">
          <SectionHead title="Source material" aside="Required" />
          <Uploader doc={p.doc} busy={p.uploadBusy}
            urlInput={p.urlInput} onUrlInput={p.onUrlInput}
            onFile={p.onFile} onUrl={p.onUrl} />
        </section>
        <section className="pc-section">
          <SectionHead title="Conversation angle" aside="Optional" />
          <div className="pc-prompts">
            {SAMPLE_PROMPTS.map((sp) => (
              <button
                key={sp.title}
                type="button"
                className="pc-prompt"
                aria-pressed={p.focus === sp.focus}
                onClick={() => p.onApplyPrompt(sp)}
              >
                <span className="pc-prompt__title"><sp.icon aria-hidden />{sp.title}</span>
                <span className="pc-prompt__text">{sp.focus}</span>
              </button>
            ))}
          </div>
          <Field label="Your own angle" hint="Pick a preset above or describe the angle the hosts should take.">
            <Textarea
              value={p.focus}
              onChange={(e) => p.onFocusChange(e.target.value)}
              rows={3}
              placeholder="e.g. focus on when to use open-weight models"
            />
          </Field>
        </section>
      </div>
      <aside className="pc-setup__side">
        <div className="card pc-settings">
          <h2 className="pc-card-title">Conversation settings</h2>
          <Field label="Style">
            <Select value={p.style} onChange={(e) => p.onStyle(e.target.value as Style)}>
              <option value="casual">Casual</option>
              <option value="formal">Formal</option>
              <option value="debate">Debate</option>
              <option value="explainer">Explainer</option>
            </Select>
          </Field>
          <Field label="Audience level" hint="Tunes vocabulary and depth for the listeners.">
            <Select
              value={p.audienceLevel ?? ''}
              onChange={(e) => p.onAudienceLevel(toAudienceLevel(e.target.value))}
            >
              <option value="">Any (default)</option>
              {AUDIENCE_LEVELS.map((lvl) => <option key={lvl} value={lvl}>{AUDIENCE_LEVEL_LABELS[lvl]}</option>)}
            </Select>
          </Field>
          <Field label={<>Turns <span className="pc-range-value tabular">{p.numTurns}</span></>} hint="Between 4 and 16 exchanges. Practitioner and Expert episodes add turns so each slide gets covered.">
            <input
              type="range" min={4} max={16} value={p.numTurns}
              className="pc-range"
              onChange={(e) => p.onNumTurns(Number(e.target.value))}
            />
          </Field>
          <Field label="Language">
            <Select value={p.language} onChange={(e) => p.onLanguage(e.target.value)}>
              {LANGUAGES.map((code) => <option key={code} value={code}>{languageName(code)}</option>)}
            </Select>
          </Field>
          <Button variant="primary" size="lg" block icon={Sparkles} disabled={!p.doc} onClick={p.onGenerate}>
            Generate podcast script
          </Button>
          {!p.doc && <p className="pc-settings__hint">Upload a document first</p>}
        </div>
      </aside>
    </div>
  );
}

const KIND_ICON: Record<string, LucideIcon> = { pptx: Presentation, url: Globe };

function Uploader({ doc, busy, urlInput, onUrlInput, onFile, onUrl }: {
  doc: PodDoc | null; busy: boolean;
  urlInput: string; onUrlInput: (v: string) => void;
  onFile: (f: File) => void; onUrl: () => void;
}) {
  if (doc) {
    const Icon = KIND_ICON[doc.source_kind] ?? FileText;
    return (
      <div className="pc-doc">
        <span className="pc-doc__icon" aria-hidden><Icon /></span>
        <div className="pc-doc__body">
          <div className="pc-doc__title">{doc.title}</div>
          <div className="pc-doc__meta">
            {pluralize(doc.sections.length, 'section')}
            {doc.slide_images.length > 0 && ` · ${pluralize(doc.slide_images.length, 'slide')}`}
          </div>
        </div>
        <Chip tone="sage" icon={CheckCircle2}>Ready</Chip>
      </div>
    );
  }
  return (
    <div className="pc-uploader">
      <Dropzone
        onFile={onFile}
        accept=".pptx,.pdf,.docx,.txt,.md"
        busy={busy}
        busyTitle="Processing…"
        title="Drop a PPTX, PDF or DOCX"
        hint="or click to browse · TXT and Markdown work too"
      />
      <div className="pc-url">
        <Field label="Or fetch a web page" className="pc-url__field">
          <Input
            type="url"
            value={urlInput}
            onChange={(e) => onUrlInput(e.target.value)}
            placeholder="https://… article, research page, etc."
          />
        </Field>
        <Button icon={Globe} onClick={onUrl} disabled={busy || !urlInput.trim()}>Fetch</Button>
      </div>
      {busy && <Spinner label="Processing…" />}
    </div>
  );
}

function RoleCard({ speaker, role, onChange, avatars, voices, audioOnly }: {
  speaker: Speaker; role: RoleConfig; onChange: (r: RoleConfig) => void;
  avatars: AvatarInfo[]; voices: VoiceOption[]; audioOnly: boolean;
}) {
  const avatar = avatars.find((a) => a.id === role.avatar);
  const voice = voices.find((v) => v.id === role.voice);
  const lead = speaker === 'interviewer';
  const meta = [avatar?.display_name ?? (audioOnly ? 'No portrait' : null), voice?.display_name].filter(Boolean).join(' · ');
  const chooseAvatar = (id: string) => {
    const next = avatars.find((a) => a.id === id);
    // "No portrait" (audio only) keeps the name: the voice still speaks as this host.
    if (!next) { onChange({ ...role, avatar: '' }); return; }
    // Keep a custom name; follow the avatar when the name was a default one.
    const name = role.display_name.trim();
    const followName = !name
      || (avatar ? role.display_name === avatar.display_name : avatars.some((a) => a.display_name === name));
    onChange({ ...role, avatar: next.id, display_name: followName ? next.display_name : role.display_name });
  };
  return (
    <article className={`pc-host pc-host--${speaker}`} aria-label={ROLE_LABEL[speaker]}>
      <div className="pc-host__portrait">
        <HostDisc
          host={{ display_name: role.display_name || ROLE_LABEL[speaker], thumbnail_url: avatar?.thumbnail_url ?? null }}
          size={120}
          speaking={lead}
          tone={lead ? 'sage' : 'sand'}
          label=""
        />
        <div className="pc-host__id">
          {lead ? <LivePill>Interviewer · leads</LivePill> : <span className="eyebrow">Expert</span>}
          <span className="pc-host__name">{role.display_name || ROLE_LABEL[speaker]}</span>
          <span className="pc-host__meta">
            {meta || (audioOnly ? 'Choose a voice' : 'Choose an avatar and a voice')}
          </span>
        </div>
      </div>
      <div className="pc-host__fields">
        <Field label="Display name">
          <Input
            value={role.display_name}
            onChange={(e) => onChange({ ...role, display_name: e.target.value })}
            placeholder="Display name"
          />
        </Field>
        <Field
          label={audioOnly ? 'Portrait (optional)' : 'Avatar'}
          hint={audioOnly ? 'Shown on the cover art and in the player.' : undefined}
          error={!audioOnly && !role.avatar ? 'Required for a video podcast.' : undefined}
        >
          <Select value={role.avatar} onChange={(e) => chooseAvatar(e.target.value)} data-testid={`avatar-${speaker}`}>
            {audioOnly
              ? <option value="">No portrait</option>
              : !role.avatar && <option value="">Choose an avatar</option>}
            {avatars.map((a) => <option key={a.id} value={a.id}>{a.display_name}</option>)}
          </Select>
        </Field>
        <Field label="Voice">
          <Select value={role.voice} onChange={(e) => onChange({ ...role, voice: e.target.value })}>
            {voices.map((v) => (
              <option key={v.id} value={v.id}>
                {v.display_name}{v.hd ? ' · HD' : ''} ({v.language})
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </article>
  );
}

function ScriptStreamingView({ turns, error, cast, showReactions }: {
  turns: DialogueTurn[]; error: string | null; cast: Cast; showReactions: boolean;
}) {
  return (
    <section className="pc-panel" aria-live="polite">
      <div className="pc-panel__head">
        {error ? <span className="eyebrow">Script</span> : <Waveform />}
        <h2 className="pc-panel__title">{error ? 'The script could not be written' : 'Writing the script…'}</h2>
        <span className="eyebrow tabular">{pluralize(turns.length, 'turn')} so far</span>
      </div>
      {error
        ? <Alert tone="error" title="Script generation failed">{error}</Alert>
        : (
          <>
            {turns.length === 0 && <Spinner label="The hosts are reading your document…" />}
            <TurnsList turns={turns} cast={cast} showReactions={showReactions} />
          </>
        )}
    </section>
  );
}

const FORMAT_OPTIONS: { id: PodcastFormat; title: string; text: string; icon: LucideIcon }[] = [
  { id: 'video', title: 'Video + audio', text: 'Avatar video plus a radio version you can listen to', icon: Clapperboard },
  { id: 'audio', title: 'Audio only', text: 'A two-host radio conversation — no avatars, ready in about a minute', icon: Headphones },
];

/** Radio group of option cards (roving tabindex; arrows/Home/End move and select). */
function FormatPicker({ value, onChange }: { value: PodcastFormat; onChange: (f: PodcastFormat) => void }) {
  const uid = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const n = FORMAT_OPTIONS.length;
  const selectAt = (i: number) => {
    const idx = (i + n) % n;
    onChange(FORMAT_OPTIONS[idx].id);
    refs.current[idx]?.focus();
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, i: number) => {
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown': selectAt(i + 1); break;
      case 'ArrowLeft':
      case 'ArrowUp': selectAt(i - 1); break;
      case 'Home': selectAt(0); break;
      case 'End': selectAt(n - 1); break;
      default: return;
    }
    e.preventDefault();
  };
  return (
    <div role="radiogroup" aria-label="Podcast format" className="pc-format">
      {FORMAT_OPTIONS.map((o, i) => {
        const checked = o.id === value;
        return (
          <button
            key={o.id}
            ref={(el) => { refs.current[i] = el; }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-labelledby={`${uid}-${o.id}`}
            aria-describedby={`${uid}-${o.id}-text`}
            tabIndex={checked ? 0 : -1}
            className="pc-format__option"
            data-testid={`format-${o.id}`}
            onClick={() => onChange(o.id)}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            <span className="pc-format__icon" aria-hidden><o.icon /></span>
            <span className="pc-format__body">
              <span className="pc-format__title" id={`${uid}-${o.id}`}>{o.title}</span>
              <span className="pc-format__text" id={`${uid}-${o.id}-text`}>{o.text}</span>
            </span>
            <span className="pc-format__dot" aria-hidden />
          </button>
        );
      })}
    </div>
  );
}

function ProductionOption({ label, hint, checked, onChange, testId }: {
  label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void; testId: string;
}) {
  const hintId = useId();
  return (
    <div className="pc-option">
      <Checkbox
        label={label}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        aria-describedby={hint ? hintId : undefined}
        data-testid={testId}
      />
      {hint && <span className="pc-option__hint" id={hintId}>{hint}</span>}
    </div>
  );
}

function ScriptReview({
  turns, cast, voices, format, onFormat, onInterviewer, onExpert,
  music, intro, reactions, onMusic, onIntro, onReactions, canRender, starting, onRender, onBack,
}: {
  turns: DialogueTurn[]; cast: Cast; voices: VoiceOption[];
  format: PodcastFormat; onFormat: (f: PodcastFormat) => void;
  onInterviewer: (r: RoleConfig) => void; onExpert: (r: RoleConfig) => void;
  music: boolean; intro: boolean; reactions: boolean;
  onMusic: (b: boolean) => void; onIntro: (b: boolean) => void; onReactions: (b: boolean) => void;
  canRender: boolean; starting: boolean;
  onRender: () => void; onBack: () => void;
}) {
  const audioOnly = format === 'audio';
  const blockedId = useId();
  return (
    <div className="pc-review">
      <section className="pc-section">
        <SectionHead title="Format" aside="Choose one" />
        <FormatPicker value={format} onChange={onFormat} />
      </section>
      <section className="pc-section">
        <SectionHead title="The script" aside={pluralize(turns.length, 'turn')} />
        <TurnsList turns={turns} cast={cast} showSlides={!audioOnly} showReactions={reactions} />
      </section>
      <section className="pc-section">
        <SectionHead title="Cast your hosts" aside={audioOnly ? 'Voices & portraits' : 'Avatars & voices'} />
        <div className="pc-cast">
          <RoleCard speaker="interviewer" role={cast.interviewer} onChange={onInterviewer}
            avatars={cast.avatars} voices={voices} audioOnly={audioOnly} />
          <RoleCard speaker="expert" role={cast.expert} onChange={onExpert}
            avatars={cast.avatars} voices={voices} audioOnly={audioOnly} />
        </div>
      </section>
      <section className="pc-bar" aria-label="Production">
        <div className="pc-bar__options">
          <span className="eyebrow">Production</span>
          <div className="pc-options">
            <ProductionOption
              label="Intro & outro" testId="option-intro" checked={intro} onChange={onIntro}
              hint={audioOnly ? 'The Oz Radio jingle at the start and the end.' : 'Title cards with the Oz Radio jingle.'}
            />
            <ProductionOption label="Background music" testId="option-music" checked={music} onChange={onMusic} />
            <ProductionOption
              label="Listener reactions" testId="option-reactions" checked={reactions} onChange={onReactions}
              hint={audioOnly
                ? 'Short “mm-hmm” or “right” from the listening host.'
                : 'Short “mm-hmm” or “right” from the listening host, lip-synced in the video.'}
            />
          </div>
        </div>
        <div className="pc-bar__actions">
          {!canRender && (
            <p className="pc-bar__hint" id={blockedId}>Choose an avatar for each host to render a video.</p>
          )}
          <Button icon={ArrowLeft} onClick={onBack}>Back to setup</Button>
          <Button
            variant="primary"
            icon={audioOnly ? Headphones : Clapperboard}
            onClick={onRender}
            disabled={!canRender}
            busy={starting}
            aria-describedby={canRender ? undefined : blockedId}
            data-testid="render-podcast"
          >
            Render podcast
          </Button>
        </div>
      </section>
    </div>
  );
}

function TurnsList({ turns, cast, showSlides = true, showReactions = true }: {
  turns: DialogueTurn[]; cast: Cast; showSlides?: boolean; showReactions?: boolean;
}) {
  if (turns.length === 0) return null;
  return (
    <ol className="pc-transcript">
      {turns.map((t) => {
        const host = hostFor(cast, t.speaker);
        const reaction = showReactions ? reactionLabel(t) : null;
        const listener = reaction ? hostFor(cast, otherSpeaker(t.speaker)) : null;
        return (
          <motion.li
            key={t.idx}
            className={`pc-turn pc-turn--${t.speaker}`}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3 }}
          >
            <HostDisc host={host} size={36} tone={t.speaker === 'expert' ? 'sand' : 'sage'} label="" />
            <div className="pc-turn__body">
              <div className="pc-turn__who">
                <span className="pc-turn__name">{host.display_name}</span>
                {showSlides && t.slide_idx !== null && t.slide_idx !== undefined && (
                  <Chip className="pc-turn__slide">Slide {t.slide_idx + 1}</Chip>
                )}
              </div>
              <p className="pc-turn__text">{t.text}</p>
              {reaction && listener && (
                <Chip className="pc-turn__reaction" data-testid="turn-reaction">
                  <span className="pc-turn__reaction-arrow" aria-hidden="true">↳</span>{' '}
                  <span>{listener.display_name} · {reaction}</span>
                  <span className="sr-only"> (reaction)</span>
                </Chip>
              )}
            </div>
          </motion.li>
        );
      })}
    </ol>
  );
}

interface RenderStage { key: string; label: string; icon: LucideIcon }

const RENDER_STAGES: Record<PodcastFormat, RenderStage[]> = {
  video: [
    { key: 'queued', label: 'Queued', icon: Clock },
    { key: 'rendering', label: 'Rendering avatars', icon: Users },
    { key: 'composing', label: 'Composing video', icon: Clapperboard },
    { key: 'done', label: 'Ready', icon: CheckCircle2 },
  ],
  audio: [
    { key: 'queued', label: 'Queued', icon: Clock },
    { key: 'synthesizing', label: 'Synthesizing voices', icon: Mic },
    { key: 'mixing', label: 'Mixing audio', icon: SlidersHorizontal },
    { key: 'done', label: 'Ready', icon: CheckCircle2 },
  ],
};

const RENDER_HINT: Record<PodcastFormat, string> = {
  video: 'Video podcasts take several minutes — avatar rendering is rate-limited.',
  audio: 'Audio-only podcasts are usually ready in about a minute.',
};

/**
 * Step (0 queued … 3 ready) from the job state and its progress stage: audio jobs
 * report `synthesizing` under the rendering state and `mixing` under composing;
 * video jobs mix the radio version while composing. -1 once failed or cancelled.
 */
function renderStep(job: PodcastJob): number {
  if (job.state === 'done') return 3;
  if (job.state === 'failed' || job.state === 'cancelled') return -1;
  const stage = job.progress?.stage;
  if (job.state === 'composing' || stage === 'composing' || stage === 'mixing') return 2;
  if (job.state === 'rendering' || stage === 'rendering' || stage === 'synthesizing') return 1;
  return 0;
}

function RenderingView({ job, format, turns, onBack }: {
  job: PodcastJob; format: PodcastFormat; turns: DialogueTurn[]; onBack: () => void;
}) {
  const stages = RENDER_STAGES[format];
  const progress = job.progress ?? { stage: job.state, completed: 0, total: 0, message: '' };
  const step = renderStep(job);
  const failed = step < 0;
  const cancelled = job.state === 'cancelled';
  // Furthest step seen, so a failure is shown on the step it happened in.
  const [reached, setReached] = useState(0);
  useEffect(() => { if (step > reached) setReached(step); }, [step, reached]);
  const failedAt = failed ? reached : -1;
  const workLabel = format === 'audio' ? 'Voices synthesized' : 'Avatar clips rendered';
  const pct = progress.total > 0 ? Math.min(100, Math.round((100 * progress.completed) / progress.total)) : 0;
  return (
    <section className="pc-panel" aria-live="polite" data-testid="render-view" data-format={format}>
      <div className="pc-panel__head">
        {failed ? <span className="eyebrow">Render</span> : <Spinner />}
        <h2 className="pc-panel__title">{failed ? 'The podcast could not be rendered' : 'Building your podcast…'}</h2>
      </div>
      <ol className="pc-stages" data-testid="render-stages">
        {stages.map((s, i) => {
          const isFailed = i === failedAt;
          const active = i === step;
          const done = failed ? i < failedAt : i < step;
          const Icon = isFailed ? AlertCircle : s.icon;
          return (
            <li
              key={s.key}
              className={['pc-stage', active && 'is-active', done && 'is-done', isFailed && 'is-failed'].filter(Boolean).join(' ')}
              aria-current={active ? 'step' : undefined}
              data-testid="render-stage"
              data-stage={s.key}
              data-status={isFailed ? 'failed' : active ? 'active' : done ? 'done' : 'pending'}
            >
              <span className="pc-stage__icon" aria-hidden><Icon /></span>
              <span className="pc-stage__label">
                {s.label}
                {isFailed && <span className="sr-only"> (failed)</span>}
              </span>
              {active && s.key === 'composing' && progress.stage === 'mixing' && (
                <span className="pc-stage__sub" data-testid="render-stage-sub">and the radio mix</span>
              )}
              {active && <LivePill className="pc-stage__msg">{progress.message || 'working…'}</LivePill>}
            </li>
          );
        })}
      </ol>
      {step === 1 && progress.total > 0 && (
        <div className="pc-progress" data-testid="render-progress">
          <div className="pc-progress__row">
            <span>{workLabel}</span>
            <span className="tabular">{progress.completed} / {progress.total}</span>
          </div>
          <Progress value={pct / 100} label={workLabel} />
        </div>
      )}
      {failed ? (
        <>
          <Alert tone="error" title={cancelled ? 'Render cancelled' : 'Render failed'}>
            {job.error || (cancelled ? 'The render was cancelled.' : 'Something went wrong while rendering.')}
          </Alert>
          <div className="pc-panel__actions">
            <Button icon={ArrowLeft} onClick={onBack} data-testid="render-back">Back to review</Button>
          </div>
        </>
      ) : (
        <p className="pc-panel__foot" data-testid="render-hint">
          Script has {pluralize(turns.length, 'turn')}. {RENDER_HINT[format]}
        </p>
      )}
    </section>
  );
}

type ResultTab = 'watch' | 'listen';
const RESULT_TABS: { id: ResultTab; label: string }[] = [
  { id: 'watch', label: 'Watch' },
  { id: 'listen', label: 'Listen' },
];
/** A switch before this point starts the other rendition from the top. */
const SWITCH_FROM_START_SEC = 0.25;

function ResultView({ job, format, title, turns, cast, reactions, onNew }: {
  job: PodcastJob; format: PodcastFormat; title: string; turns: DialogueTurn[]; cast: Cast; reactions: boolean;
  onNew: () => void;
}) {
  const outputs = job.outputs ?? {};
  const withVideo = hasVideo({ format });
  const audioUrl = outputs.mp3_url || null;
  // Audio-only jobs always show the player; video jobs add Listen when a radio MP3 exists.
  const withAudio = !withVideo || !!audioUrl;
  const withTabs = withVideo && withAudio;
  const [tab, setTab] = useState<ResultTab>(withVideo ? 'watch' : 'listen');
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const radioRef = useRef<RadioPlayerHandle>(null);
  const radioPlaying = useRef(false);

  useEffect(() => {
    let cancelled = false;
    getJobTranscript(job.id)
      .then((t) => { if (!cancelled) setTranscript(asTranscript(t)); })
      .catch(() => { /* no transcript (404): the player works without captions */ });
    return () => { cancelled = true; };
  }, [job.id]);

  const roles = job.roles ?? { interviewer: cast.interviewer, expert: cast.expert };
  const fallbackHosts: PodcastHost[] = SPEAKERS.map((role) => ({
    role,
    display_name: roles[role]?.display_name || ROLE_LABEL[role],
    avatar_id: roles[role]?.avatar || null,
  }));
  const hosts = toRadioHosts(transcript?.hosts?.length ? transcript.hosts : fallbackHosts, cast.avatars);

  // One medium at a time: switching pauses the other and carries the position over (turn-mapped).
  const switchTab = (next: ResultTab) => {
    if (next === tab) return;
    const video = videoRef.current;
    const radio = radioRef.current;
    if (next === 'listen') {
      const wasPlaying = !!video && !video.paused && !video.ended;
      const t = video?.currentTime ?? 0;
      video?.pause();
      radio?.seek(t > SWITCH_FROM_START_SEC ? mapRenditionTime(transcript, t, 'video') : 0);
      if (wasPlaying) void radio?.play();
    } else {
      const wasPlaying = radioPlaying.current;
      const t = radio?.getCurrentTime() ?? 0;
      radio?.pause();
      if (video) {
        try {
          video.currentTime = t > SWITCH_FROM_START_SEC ? mapRenditionTime(transcript, t, 'audio') : 0;
        } catch { /* not seekable yet */ }
        if (wasPlaying) video.play().catch(() => { /* playback refused: stays paused */ });
      }
    }
    setTab(next);
  };
  const onVideoPlay = () => {
    radioRef.current?.pause();
    setTab('watch');
  };
  const onRadioPlayState = (playing: boolean) => {
    radioPlaying.current = playing;
    if (!playing) return;
    videoRef.current?.pause();
    setTab('listen');
  };

  const downloads: { id: string; url: string; label: string }[] = [];
  const addDownload = (id: string, url: string | null | undefined, label: string) => {
    if (url) downloads.push({ id, url, label });
  };
  addDownload('mp4', outputs.mp4_url, 'Video (MP4)');
  addDownload('mp3', audioUrl, 'Audio (MP3)');
  addDownload('srt', outputs.srt_url, 'Subtitles (SRT)');
  addDownload('audio-srt', outputs.audio_srt_url, 'Radio transcript (SRT)');
  // SCORM is packaged on demand from the MP3 and the captions timed on it.
  addDownload('scorm', audioUrl && outputs.audio_srt_url ? jobFileUrl(job.id, 'scorm') : null, 'SCORM package');

  const warnings = Array.from(new Set(
    (job.warnings ?? []).filter((w): w is string => typeof w === 'string' && !!w).map(warningLabel),
  ));

  return (
    <div className="pc-result" data-testid="result-view" data-format={format}>
      <section className="pc-result__main">
        <SectionHead title="Your podcast" aside={withVideo ? 'Ready' : 'Audio only · Ready'} />
        {withTabs && (
          <Tabs className="pc-result__tabs" label="Podcast player" tabs={RESULT_TABS} value={tab} onChange={switchTab} />
        )}
        {withVideo && (
          <div
            className="pc-result__panel"
            role={withTabs ? 'tabpanel' : undefined}
            aria-label={withTabs ? 'Watch' : undefined}
            hidden={withTabs && tab !== 'watch'}
            data-testid="result-watch"
          >
            <div className="stage pc-result__stage">
              {outputs.mp4_url ? (
                <video
                  ref={videoRef}
                  controls
                  autoPlay
                  src={outputs.mp4_url}
                  className="pc-result__video"
                  data-testid="result-video"
                  data-oz-media="video"
                  onPlay={onVideoPlay}
                />
              ) : (
                <div className="pc-result__video pc-result__video--empty">Video unavailable.</div>
              )}
            </div>
          </div>
        )}
        {withAudio && (
          <div
            className="pc-result__panel"
            role={withTabs ? 'tabpanel' : undefined}
            aria-label={withTabs ? 'Listen' : undefined}
            hidden={withTabs && tab !== 'listen'}
            data-testid="result-listen"
          >
            <RadioPlayer
              ref={radioRef}
              tone="light"
              src={audioUrl}
              title={title}
              transcript={transcript}
              coverUrl={outputs.cover_url ?? null}
              hosts={hosts}
              autoPlay={!withVideo}
              onPlayStateChange={onRadioPlayState}
            />
          </div>
        )}
        {warnings.length > 0 && (
          <Alert className="pc-result__warnings" data-testid="result-warnings">
            {warnings.length === 1 ? warnings[0] : <ul>{warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
          </Alert>
        )}
        <div className="pc-result__actions">
          {downloads.length > 0 && (
            <div className="pc-result__downloads" role="group" aria-label="Downloads" data-testid="result-downloads">
              {downloads.map((d) => (
                <a key={d.id} href={d.url} download className={buttonClass({ size: 'sm' })} data-testid={`download-${d.id}`}>
                  <Download aria-hidden />{d.label}
                </a>
              ))}
            </div>
          )}
          <span className="pc-result__spacer" />
          <ButtonLink to="/podcast/library" variant="ghost" icon={Library} data-testid="result-library">Library</ButtonLink>
          <Button icon={Plus} onClick={onNew} data-testid="result-create-another">Create another</Button>
        </div>
        {job.archive_state === 'archiving' && (
          <Spinner label="Saving to library…" />
        )}
        {job.archive_state === 'published' && (
          <Alert tone="success">
            Saved to library as a draft (publish it there to share it publicly) — <a href="/podcast/library">view all podcasts</a>
          </Alert>
        )}
        {job.archive_state === 'failed' && (
          <Alert tone="clay">Could not save to library (the files are still downloadable above).</Alert>
        )}
      </section>
      <section className="pc-result__side">
        <SectionHead title="Transcript" aside={pluralize(turns.length, 'turn')} />
        <div className="pc-result__transcript">
          <TurnsList turns={turns} cast={cast} showSlides={withVideo} showReactions={reactions} />
        </div>
      </section>
    </div>
  );
}
