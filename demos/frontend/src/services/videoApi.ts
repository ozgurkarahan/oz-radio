// Typed API client for the /api/video/* endpoints.
// Slide-first script model (one narration per slide, NOT turn-based).

import type { AudienceLevel } from './podcast';

export type { AudienceLevel } from './podcast';
export { AUDIENCE_LEVELS, AUDIENCE_LEVEL_LABELS, toAudienceLevel } from './podcast';

export type JobState = 'queued' | 'rendering' | 'composing' | 'publishing' | 'done' | 'failed';
export type ArchiveState = 'none' | 'archiving' | 'published' | 'failed';
export type ScriptStyle = 'casual' | 'formal' | 'explainer' | 'marketing';

export interface SlideInfo {
  index: number;
  image_ref: string;
  title: string;
  preview_text: string;
}

export interface IngestResponse {
  doc_id: string;
  slides: SlideInfo[];
  /** Original upload filename — preserved so UI never shows the uuid. */
  filename?: string;
  title?: string;
}

export interface SlideNarration {
  slide_index: number;
  slide_image_ref: string;
  title: string;
  narration: string;
  voice: string;
  speaking_style?: string | null;
  duration_hint_s?: number | null;
}

export interface VideoScript {
  doc_id: string;
  language: string;
  style?: ScriptStyle | null;
  focus?: string | null;
  audience_level?: AudienceLevel | null;
  voice: string;
  narrations: SlideNarration[];
  title?: string;
  filename?: string;
}

export interface VoiceOption {
  id: string;
  display_name: string;
  language: string;
  gender: 'male' | 'female' | 'neutral';
  hd: boolean;
}

export interface LanguageOption {
  code: string;
  name: string;
}

export interface JobProgress {
  stage: string;
  percent: number;
  completed: number;
  total: number;
  message: string;
}

export interface JobOutputs {
  video_url?: string | null;
  audio_url?: string | null;
  srt_url?: string | null;
  thumbnail_url?: string | null;
  duration_sec?: number | null;
}

export interface VideoJob {
  job_id: string;
  doc_id: string;
  state: JobState;
  progress: JobProgress;
  outputs: JobOutputs;
  error?: string | null;
  created_at: string;
  updated_at: string;
  archive_state: ArchiveState;
}

// Anonymous visitors receive a reduced public DTO (job_id, title, created_at,
// duration_sec, language, audience_level, source_deck_id, captions_vtt_url,
// thumbnail_url, video_url) — every other field may be missing or null, so the
// UI must tolerate absence.
export interface LibrarySummary {
  job_id: string;
  title: string;
  document_title?: string | null;
  language: string;
  voice?: string | null;
  created_at: string;
  thumbnail_url: string | null;
  duration_sec: number | null;
  slide_count?: number | null;
  /** Present in the public DTO too (contracts v1); null when the manifest does not know it. */
  audience_level?: AudienceLevel | null;
  /** Deck the video was rendered from, when the manifest knows it (null today for every item). */
  source_deck_id?: string | null;
  /** Same-origin WebVTT (`/api/video/library/{id}/captions.vtt`); null when the manifest has no subtitles. */
  captions_vtt_url?: string | null;
  /** Present for admins only. */
  published?: boolean;
}

export interface LibraryItem extends LibrarySummary {
  video_url: string | null;
  audio_url?: string | null;
  srt_url?: string | null;
  scorm_url?: string | null;
}

export interface ScriptRequest {
  language: string;
  style?: ScriptStyle;
  focus?: string;
  audience_level?: AudienceLevel | null;
  voice: string;
}

const API = '/api/video';

// ---- Ingest ----------------------------------------------------------------
export async function ingestFile(file: File): Promise<IngestResponse> {
  const fd = new FormData();
  fd.append('file', file);
  // Preserve the original filename (lesson from the podcast: never show uuid as title).
  fd.append('filename', file.name);
  const r = await fetch(`${API}/ingest`, { method: 'POST', body: fd });
  if (!r.ok) throw new Error(await safeText(r));
  const data = await r.json();
  return { filename: file.name, title: stripExt(file.name), ...data };
}

// ---- Script streaming (NDJSON) ---------------------------------------------
export async function streamScript(
  docId: string,
  req: ScriptRequest,
  onItem: (n: SlideNarration) => void,
  onDone: () => void,
  onError: (m: string) => void,
): Promise<() => void> {
  const ctrl = new AbortController();
  (async () => {
    try {
      const r = await fetch(`${API}/script/${docId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(req),
        signal: ctrl.signal,
      });
      if (!r.ok || !r.body) throw new Error(await safeText(r));
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let doneSeen = false;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try {
            doneSeen = handleScriptEvent(JSON.parse(line), onItem, onDone, onError) || doneSeen;
          } catch (e: unknown) {
            onError(`Malformed script stream event: ${String(e)}`);
            doneSeen = true;
          }
        }
      }
      if (buf.trim()) {
        try {
          doneSeen = handleScriptEvent(JSON.parse(buf.trim()), onItem, onDone, onError) || doneSeen;
        } catch (e: unknown) {
          onError(`Malformed script stream event: ${String(e)}`);
          doneSeen = true;
        }
      }
      if (!doneSeen) onDone();
    } catch (e: unknown) {
      if (!isAbortError(e)) onError(errorMessage(e));
    }
  })();
  return () => ctrl.abort();
}

export async function getScript(docId: string): Promise<VideoScript> {
  const r = await fetch(`${API}/script/${docId}`);
  if (!r.ok) throw new Error(await safeText(r));
  return r.json();
}

export interface NarrationPatch {
  slide_index: number;
  narration?: string;
  speaking_style?: string;
  voice?: string;
}

export async function patchScript(docId: string, patches: NarrationPatch[]): Promise<VideoScript> {
  const r = await fetch(`${API}/script/${docId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ patches }),
  });
  if (!r.ok) throw new Error(await safeText(r));
  return r.json();
}

// ---- Render / Job ----------------------------------------------------------
export async function startRender(docId: string): Promise<{ job_id: string }> {
  const r = await fetch(`${API}/render/${docId}`, { method: 'POST' });
  if (!r.ok) throw new Error(await safeText(r));
  return r.json();
}

export async function getJob(jobId: string): Promise<VideoJob> {
  const r = await fetch(`${API}/jobs/${jobId}`);
  if (!r.ok) throw new Error(await safeText(r));
  return r.json();
}

// ---- Library ---------------------------------------------------------------
export async function listLibrary(): Promise<LibrarySummary[]> {
  const r = await fetch(`${API}/library`);
  if (!r.ok) throw new Error(await safeText(r));
  const data = await r.json();
  return Array.isArray(data) ? data : (data.items ?? []);
}

export async function getLibraryItem(jobId: string): Promise<LibraryItem> {
  const r = await fetch(`${API}/library/${jobId}`);
  if (!r.ok) throw new Error(await safeText(r));
  return r.json();
}

export async function deleteLibraryItem(jobId: string): Promise<void> {
  const r = await fetch(`${API}/library/${jobId}`, { method: 'DELETE' });
  if (!r.ok && r.status !== 204) throw new Error(await safeText(r));
}

/** Admin only: publish / unpublish a library item for anonymous visitors. */
export async function publishLibraryItem(jobId: string, published: boolean): Promise<LibraryItem> {
  const r = await fetch(`${API}/library/${encodeURIComponent(jobId)}/publish`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ published }),
  });
  if (!r.ok) throw new Error(await safeText(r));
  return r.json();
}

// ---- Voices / Languages ----------------------------------------------------
export async function listVoices(language?: string): Promise<VoiceOption[]> {
  const q = language ? `?language=${encodeURIComponent(language)}` : '';
  const r = await fetch(`${API}/voices${q}`);
  if (!r.ok) throw new Error(await safeText(r));
  return r.json();
}

export async function listLanguages(): Promise<LanguageOption[]> {
  const r = await fetch(`${API}/languages`);
  if (!r.ok) throw new Error(await safeText(r));
  return r.json();
}

// ---- helpers ---------------------------------------------------------------
async function safeText(r: Response): Promise<string> {
  let text = '';
  try { text = await r.text(); } catch { return `HTTP ${r.status}`; }
  try {
    const detail = JSON.parse(text)?.detail;
    if (typeof detail === 'string' && detail) return detail;
  } catch { /* not JSON */ }
  return text || `HTTP ${r.status}`;
}

function handleScriptEvent(
  obj: unknown,
  onItem: (n: SlideNarration) => void,
  onDone: () => void,
  onError: (m: string) => void,
): boolean {
  if (!obj || typeof obj !== 'object') return false;
  const event = obj as { event?: string; data?: unknown; script?: unknown; slide_index?: unknown };

  if (event.event === 'narration' && isSlideNarration(event.data)) {
    onItem(event.data);
    return false;
  }
  if (event.event === 'done') {
    onDone();
    return true;
  }
  if (event.event === 'error') {
    onError(errorMessageFromData(event.data));
    return true;
  }
  if (isSlideNarration(event)) {
    onItem(event);
  }
  return false;
}

function isSlideNarration(value: unknown): value is SlideNarration {
  return !!value && typeof value === 'object'
    && typeof (value as { slide_index?: unknown }).slide_index === 'number'
    && typeof (value as { narration?: unknown }).narration === 'string';
}

function errorMessageFromData(data: unknown): string {
  if (data && typeof data === 'object' && typeof (data as { message?: unknown }).message === 'string') {
    return (data as { message: string }).message;
  }
  return 'Script generation failed';
}

function isAbortError(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError';
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function stripExt(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}

export const DRAGONHD_LANGUAGES: { code: string; label: string }[] = [
  { code: 'en-US', label: '🇬🇧 English (US)' },
  { code: 'fr-FR', label: '🇫🇷 Français' },
  { code: 'es-ES', label: '🇪🇸 Español' },
  { code: 'de-DE', label: '🇩🇪 Deutsch' },
  { code: 'it-IT', label: '🇮🇹 Italiano' },
  { code: 'pt-BR', label: '🇧🇷 Português (Brasil)' },
  { code: 'zh-CN', label: '🇨🇳 中文 (简体)' },
  { code: 'ja-JP', label: '🇯🇵 日本語' },
];

/** Fallback DragonHD voice id per language (used when /voices fails). */
export const DEFAULT_VOICE_BY_LANG: Record<string, string> = {
  'en-US': 'en-US-Ava:DragonHDLatestNeural',
  'fr-FR': 'fr-FR-Vivienne:DragonHDLatestNeural',
  'es-ES': 'es-ES-Ximena:DragonHDLatestNeural',
  'de-DE': 'de-DE-Seraphina:DragonHDLatestNeural',
  'it-IT': 'it-IT-Isabella:DragonHDLatestNeural',
  'pt-BR': 'pt-BR-Thalita:DragonHDLatestNeural',
  'zh-CN': 'zh-CN-Xiaochen:DragonHDLatestNeural',
  'ja-JP': 'ja-JP-Nanami:DragonHDLatestNeural',
};
