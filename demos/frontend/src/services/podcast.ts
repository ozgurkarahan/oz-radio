// Typed API client for the /api/podcast/* endpoints.

export type SourceKind = 'pptx' | 'pdf' | 'docx' | 'txt' | 'md' | 'url';
export type Speaker = 'interviewer' | 'expert';
export type Style = 'casual' | 'formal' | 'debate' | 'explainer';
export type Length = 'short' | 'medium' | 'long';
/** Target audience expertise for script generation; null = generic (default) prompt. */
export type AudienceLevel = 'beginner' | 'practitioner' | 'expert';
export const AUDIENCE_LEVEL_LABELS: Record<AudienceLevel, string> = {
  beginner: 'Beginner',
  practitioner: 'Practitioner',
  expert: 'Expert',
};
export const AUDIENCE_LEVELS = Object.keys(AUDIENCE_LEVEL_LABELS) as AudienceLevel[];
/** Narrow an untrusted value (select value / API field) to an AudienceLevel or null. */
export function toAudienceLevel(v: unknown): AudienceLevel | null {
  return typeof v === 'string' && (AUDIENCE_LEVELS as string[]).includes(v) ? (v as AudienceLevel) : null;
}
export type Layout = 'split_screen_with_slides' | 'split_screen_only';
export type JobState = 'queued' | 'rendering' | 'composing' | 'done' | 'failed' | 'cancelled';

/** `video` = MP4 + radio MP3 (Watch and Listen); `audio` = radio MP3 only (no avatars). */
export type PodcastFormat = 'video' | 'audio';
export const PODCAST_FORMATS: PodcastFormat[] = ['video', 'audio'];
/** `radio_mix` = dedicated radio master; `soundtrack` = fallback ripped from the video. */
export type AudioKind = 'radio_mix' | 'soundtrack';
/** Listener rendering actually used by a video job (highest fidelity first). */
export type ListenerMode = 'idle_loop' | 'procedural' | 'still';

/** Stable backchannel ids; the spoken, localized text is resolved server-side. */
export type ReactionId = 'ack' | 'right' | 'yeah' | 'exactly' | 'isee' | 'interesting';
/** English labels for reaction chips (the audio uses the script language). */
export const REACTION_LABELS: Record<ReactionId, string> = {
  ack: 'Mm-hmm',
  right: 'Right',
  yeah: 'Yeah',
  exactly: 'Exactly',
  isee: 'I see',
  interesting: 'Interesting',
};
export const REACTION_IDS = Object.keys(REACTION_LABELS) as ReactionId[];
/** The other host reacts after sentence `after_sentence` (1-based, max 20) of the turn. */
export interface ReactionHint { after_sentence: number; reaction_id: ReactionId; }

/** Stable job warning codes (`PodcastJob.warnings`); unknown codes may appear later. */
export type PodcastWarningCode =
  | 'listener_fallback' | 'listener_static' | 'listener_timeout'
  | 'reactions_skipped' | 'radio_fallback' | 'cover_fallback';
export const PODCAST_WARNING_LABELS: Record<PodcastWarningCode, string> = {
  listener_fallback: 'The listening host uses a simplified animation.',
  listener_static: 'The listening host footage was too static; a subtle animation was used instead.',
  listener_timeout: 'The listening host took too long to prepare; a simplified animation was used.',
  reactions_skipped: 'Some listener reactions did not fit and were skipped.',
  radio_fallback: 'The radio mix failed; the audio is the video soundtrack.',
  cover_fallback: 'The cover art fell back to a plain design.',
};
/** Human-readable text for a job warning code (unknown codes are shown generically). */
export function warningLabel(code: string): string {
  return (PODCAST_WARNING_LABELS as Record<string, string>)[code] ?? 'The render completed with a warning.';
}

export interface Section { heading: string; text: string; }
export interface Document {
  id: string;
  title: string;
  source_kind: SourceKind;
  sections: Section[];
  slide_images: string[];
  slide_titles: string[];
  slide_notes: string[];
}

export interface WordTiming { word: string; start_sec: number; end_sec: number; }

export interface DialogueTurn {
  idx: number;
  speaker: Speaker;
  text: string;
  slide_idx: number | null;
  word_timings: WordTiming[];
  /** Optional backchannel by the other host after one of this turn's sentences. */
  reaction?: ReactionHint | null;
}

export interface Script {
  id: string;
  document_id: string;
  language: string;
  style: Style;
  length: Length;
  audience_level?: AudienceLevel | null;
  turns: DialogueTurn[];
}

export interface VoiceOption {
  id: string; display_name: string; language: string;
  gender: 'male' | 'female' | 'neutral'; hd: boolean; style_list: string[];
}

/** `avatar` is a registry id; it may be '' (no portrait) only for audio-only renders. */
export interface RoleConfig { display_name: string; avatar: string; voice: string; }
export interface RenderRoles { interviewer: RoleConfig; expert: RoleConfig; }

export interface RenderRequest {
  script_id: string;
  roles: RenderRoles;
  layout: Layout;
  music: boolean;
  intro: boolean;
  background_image?: string | null;
  /** Default 'video' (both hosts then need an avatar, else HTTP 422). */
  format?: PodcastFormat;
  /** Listener backchannels (default true); the server kill switch can still disable them. */
  reactions?: boolean;
}

export interface JobProgress { stage: string; completed: number; total: number; message: string; }
/** JobProgress.stage values — video: rendering → composing → mixing; audio: synthesizing → mixing. */
export type ProgressStage = 'queued' | 'rendering' | 'synthesizing' | 'composing' | 'mixing' | 'done' | 'failed';
/**
 * Download routes of a finished job; null/absent when a rendition is missing
 * (audio-only jobs have no mp4/srt). `srt_url` is timed on the video,
 * `audio_srt_url` on the MP3; `duration_sec` is the primary rendition's.
 */
export interface JobOutputs {
  mp4_url?: string | null;
  mp3_url?: string | null;
  srt_url?: string | null;
  duration_sec?: number | null;
  audio_srt_url?: string | null;
  transcript_url?: string | null;
  cover_url?: string | null;
  audio_duration_sec?: number | null;
  video_duration_sec?: number | null;
  audio_kind?: AudioKind | null;
}
export type ArchiveState = 'none' | 'archiving' | 'published' | 'failed';
export interface PodcastJob {
  id: string; script_id: string; roles: RenderRoles; layout: Layout;
  music: boolean; intro: boolean; state: JobState;
  progress: JobProgress; outputs: JobOutputs;
  error: string | null; created_at: string; updated_at: string;
  archive_state?: ArchiveState;
  library_job_id?: string | null;
  format?: PodcastFormat;
  reactions?: boolean;
  /** Stable codes (see PodcastWarningCode / warningLabel), never raw error text. */
  warnings?: string[];
  /** Listener rendering used by a video job (a ListenerMode); null for audio-only jobs. */
  listener_mode?: string | null;
}

// ---- Transcript (radio timeline) -------------------------------------
/** Public host identity; `avatar_id` is a registry id (null = monogram). */
export interface PodcastHost { role: Speaker; display_name: string; avatar_id?: string | null; }
/** One turn on the radio timeline (seconds); `video_*` = same turn in the MP4 (null without video). */
export interface TranscriptTurn {
  turn_idx: number;
  speaker: Speaker;
  start: number;
  end: number;
  video_start?: number | null;
  video_end?: number | null;
}
export type TranscriptCueKind = 'speech' | 'reaction';
/** Caption on the radio timeline; `reaction` cues are the listener's backchannels. */
export interface TranscriptCue {
  start: number;
  end: number;
  speaker: Speaker;
  turn_idx: number;
  text: string;
  kind: TranscriptCueKind;
}
/** `transcript.json`: radio-timed captions, host lighting and waveform peaks (no chapters). */
export interface Transcript {
  version: number;
  duration_sec: number;
  hosts: PodcastHost[];
  turns: TranscriptTurn[];
  cues: TranscriptCue[];
  /** ~240 values in 0..1, evenly spaced over duration_sec. */
  peaks: number[];
}

// ---- Library ----------------------------------------------------------
// Anonymous visitors receive a reduced public DTO (job_id, title, created_at,
// duration_sec, language, thumbnail_url, video_url/mp4_url and, when public
// audio is enabled, audio/cover/hosts/transcript) — other fields may be missing
// or null. Legacy items lack format/has_* fields: use hasVideo/hasAudio/isAudioOnly.
export interface LibrarySummary {
  job_id: string;
  title: string;
  document_title?: string | null;
  created_at: string;
  duration_sec: number | null;
  language: string;
  style?: string | null;
  /** Admins only (absent from the anonymous public DTO). */
  audience_level?: AudienceLevel | null;
  speaker_names?: string[] | null;
  turn_count?: number | null;
  thumbnail_url: string | null;
  /** Present for admins only. */
  published?: boolean;
  format?: PodcastFormat | null;
  has_video?: boolean | null;
  has_audio?: boolean | null;
  audio_duration_sec?: number | null;
  hosts?: PodcastHost[] | null;
}
export interface LibraryItem extends LibrarySummary {
  mp4_url: string | null;
  video_url?: string | null;
  mp3_url?: string | null;
  srt_url?: string | null;
  scorm_url?: string | null;
  /** Radio MP3 for the player. */
  audio_url?: string | null;
  cover_url?: string | null;
  /** Radio-timed SRT (admins only). */
  audio_srt_url?: string | null;
  transcript?: Transcript | null;
}

/** Anything describing a rendition set: library summaries/items or jobs. */
export interface RenditionInfo {
  format?: PodcastFormat | null;
  has_video?: boolean | null;
  has_audio?: boolean | null;
}
/** True when a video exists (legacy items without the fields are videos). */
export function hasVideo(item: RenditionInfo): boolean {
  if (typeof item.has_video === 'boolean') return item.has_video;
  return item.format !== 'audio';
}
/** True when an audio rendition exists (legacy items without the fields have one). */
export function hasAudio(item: RenditionInfo): boolean {
  return typeof item.has_audio === 'boolean' ? item.has_audio : true;
}
/** Audio-only episode: Listen only, no Watch. */
export function isAudioOnly(item: RenditionInfo): boolean {
  return !hasVideo(item);
}

const API = '/api/podcast';

async function errorText(r: Response): Promise<string> {
  let text = '';
  try { text = await r.text(); } catch { return `HTTP ${r.status}`; }
  try {
    const detail = JSON.parse(text)?.detail;
    if (typeof detail === 'string' && detail) return detail;
    // FastAPI validation errors (422): [{ msg: 'Value error, …' }, …]
    if (Array.isArray(detail)) {
      const msgs = (detail as Array<{ msg?: unknown }>)
        .map((d) => (typeof d?.msg === 'string' ? d.msg.replace(/^Value error, /, '') : ''))
        .filter(Boolean);
      if (msgs.length) return msgs.join('; ');
    }
  } catch { /* not JSON */ }
  return text || `HTTP ${r.status}`;
}

export async function listVoices(language?: string): Promise<VoiceOption[]> {
  const q = language ? `?language=${encodeURIComponent(language)}` : '';
  const r = await fetch(`${API}/voices${q}`); if (!r.ok) throw new Error('voices'); return r.json();
}

export async function ingestFile(file: File): Promise<Document> {
  const fd = new FormData(); fd.append('file', file);
  const r = await fetch(`${API}/ingest`, { method: 'POST', body: fd });
  if (!r.ok) throw new Error(await r.text()); return (await r.json()).document;
}
export async function ingestUrl(url: string): Promise<Document> {
  const fd = new FormData(); fd.append('url', url);
  const r = await fetch(`${API}/ingest`, { method: 'POST', body: fd });
  if (!r.ok) throw new Error(await r.text()); return (await r.json()).document;
}

export interface ScriptRequest {
  document_id: string; language?: string; style?: Style; length?: Length;
  num_turns?: number; focus?: string;
  audience_level?: AudienceLevel | null;
}

export async function streamScript(req: ScriptRequest,
  onTurn: (t: DialogueTurn) => void,
  onDone: (scriptId: string) => void,
  onError: (m: string) => void,
): Promise<() => void> {
  const ctrl = new AbortController();
  (async () => {
    try {
      const r = await fetch(`${API}/script/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(req),
        signal: ctrl.signal,
      });
      if (!r.ok || !r.body) throw new Error(await r.text());
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          const lines = chunk.split('\n');
          let ev = 'message', data = '';
          for (const l of lines) {
            if (l.startsWith('event:')) ev = l.slice(6).trim();
            else if (l.startsWith('data:')) data += l.slice(5).trim();
          }
          if (!data) continue;
          try {
            const parsed = JSON.parse(data);
            if (ev === 'turn') onTurn(parsed);
            else if (ev === 'done') onDone(parsed.script_id);
            else if (ev === 'error') onError(parsed.message);
          } catch { /* ignore */ }
        }
      }
    } catch (e: any) { if (e.name !== 'AbortError') onError(String(e)); }
  })();
  return () => ctrl.abort();
}

export async function getScript(id: string): Promise<Script> {
  const r = await fetch(`${API}/scripts/${id}`); if (!r.ok) throw new Error('script');
  return r.json();
}
export async function patchScript(id: string, turns: DialogueTurn[]): Promise<Script> {
  const r = await fetch(`${API}/scripts/${id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ turns }),
  });
  if (!r.ok) throw new Error(await r.text()); return r.json();
}

export async function startRender(req: RenderRequest): Promise<PodcastJob> {
  const r = await fetch(`${API}/render`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(req),
  });
  if (!r.ok) throw new Error(await errorText(r)); return r.json();
}

export async function getJob(id: string): Promise<PodcastJob> {
  const r = await fetch(`${API}/jobs/${id}`); if (!r.ok) throw new Error('job');
  return r.json();
}

export type JobFileKind = 'mp4' | 'mp3' | 'srt' | 'audio_srt' | 'transcript' | 'cover' | 'scorm';
/** Local download route of a finished job's file (404 when that rendition is absent). */
export function jobFileUrl(jobId: string, kind: JobFileKind): string {
  return `${API}/jobs/${encodeURIComponent(jobId)}/file/${kind}`;
}
/** Radio-timed transcript of a finished job (captions, host lighting, peaks). */
export async function getJobTranscript(jobId: string): Promise<Transcript> {
  const r = await fetch(jobFileUrl(jobId, 'transcript'));
  if (!r.ok) throw new Error(await errorText(r));
  return r.json();
}

// ---- Library ----------------------------------------------------------
export async function listLibrary(): Promise<LibrarySummary[]> {
  const r = await fetch(`${API}/library`);
  if (!r.ok) throw new Error(await errorText(r));
  const data = await r.json();
  return Array.isArray(data) ? data : (data?.items ?? []);
}
export async function getLibraryItem(jobId: string): Promise<LibraryItem> {
  const r = await fetch(`${API}/library/${jobId}`);
  if (!r.ok) throw new Error(await errorText(r));
  return r.json();
}
export async function deleteLibraryItem(jobId: string): Promise<void> {
  const r = await fetch(`${API}/library/${jobId}`, { method: 'DELETE' });
  if (!r.ok) throw new Error(await errorText(r));
}
/** Admin only: publish / unpublish a podcast for anonymous visitors. */
export async function publishLibraryItem(jobId: string, published: boolean): Promise<LibraryItem> {
  const r = await fetch(`${API}/library/${encodeURIComponent(jobId)}/publish`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ published }),
  });
  if (!r.ok) throw new Error(await errorText(r));
  return r.json();
}
