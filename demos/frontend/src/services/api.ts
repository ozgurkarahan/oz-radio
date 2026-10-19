const API_BASE = '/api';

export interface Slide {
  index: number;
  title: string;
  body: string;
  notes: string;
  image_url?: string;
  video_url?: string;
  translated_notes?: Record<string, string>;
  /** Slide-visible text for alt text (public decks; contracts §2.2). Never speaker notes. */
  text?: string;
}

export interface Presentation {
  id: string;
  filename: string;
  slide_count: number;
  pptx_url?: string;
  /** Source language of the notes (catalog decks); used to tell "untranslated" from "already in this language". */
  language?: string;
  slides: Slide[];
}

export interface TranslateResponse {
  translated_text: string;
  source_language: string;
}

export interface QaResponse {
  answer: string;
  source_slides: number[];
}

// ── Raise-hand voice Q&A over the voice WebSocket (contract v1) ────────────

export type QaMode = 'after_slide' | 'now';

export type QaErrorCode =
  | 'no_speech' | 'too_long' | 'limit' | 'rate' | 'stt_failed' | 'answer_failed'
  | 'bad_state' | 'disabled' | 'time_low' | 'bad_deck';

export type QaClientMessage =
  | { type: 'qa.begin'; request_id: string; slide: number; mode: QaMode }
  | { type: 'qa.audio'; request_id: string; seq: number; audio: string }
  | { type: 'qa.commit'; request_id: string }
  | { type: 'qa.text'; request_id: string; text: string }
  | { type: 'qa.cancel'; request_id: string }
  | { type: 'qa.resume'; request_id: string }
  | { type: 'context.switch'; deck_id: string };

export interface QaReadyMessage {
  type: 'qa.ready';
  request_id: string;
  max_audio_ms?: number;
  max_audio_bytes?: number;
  remaining_questions?: number;
  remaining_ms?: number;
}

export interface QaTranscriptMessage { type: 'qa.transcript'; request_id: string; text: string; remaining_ms?: number }

export interface QaAnswerMessage {
  type: 'qa.answer';
  request_id: string;
  text: string;
  source_slides: number[];
  grounded: boolean;
  remaining_ms?: number;
}

export interface QaErrorMessage { type: 'qa.error'; request_id?: string; code: QaErrorCode | string; message?: string; remaining_ms?: number }
export interface QaUnavailableMessage { type: 'qa.unavailable'; reason?: string }
export interface ContextSwitchedMessage { type: 'context.switched'; deck_id: string; slide_count: number }
export interface DemoStartedMessage { type: 'demo.started'; session_seconds: number; remaining_ms: number; narration_chars?: number[] }

export type QaServerMessage =
  | QaReadyMessage | QaTranscriptMessage | QaAnswerMessage | QaErrorMessage | QaUnavailableMessage | ContextSwitchedMessage;

export async function uploadPresentation(file: File): Promise<Presentation> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`${API_BASE}/upload`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`Upload failed: ${res.statusText}`);
  return res.json();
}

export interface PresentationListItem {
  id: string;
  filename: string;
  slide_count: number;
}

export async function listPresentations(): Promise<PresentationListItem[]> {
  const res = await fetch(`${API_BASE}/presentations`);
  if (!res.ok) throw new Error(`Failed to list presentations: ${res.statusText}`);
  return res.json();
}

export async function getSlides(presentationId: string): Promise<Presentation> {
  const res = await fetch(`${API_BASE}/slides/${presentationId}`);
  if (!res.ok) throw new Error(`Failed to get slides: ${res.statusText}`);
  return res.json();
}

export async function deletePresentation(presentationId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/presentations/${presentationId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`Failed to delete presentation: ${res.statusText}`);
}

export async function sharePresentation(presentationId: string): Promise<{ status: string; message?: string }> {
  const res = await fetch(`${API_BASE}/presentations/${presentationId}/share`, { method: 'POST' });
  if (!res.ok) throw new Error(`Failed to share presentation: ${res.statusText}`);
  return res.json();
}

export interface TranslatedSlide {
  index: number;
  translated_notes: string;
}

export interface TranslateNotesResponse {
  presentation_id: string;
  target_language: string;
  translated_slides: TranslatedSlide[];
  cached: boolean;
}

export async function translateNotes(presentationId: string, targetLanguage: string): Promise<TranslateNotesResponse> {
  const res = await fetch(`${API_BASE}/presentations/${presentationId}/translate-notes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target_language: targetLanguage }),
  });
  if (!res.ok) throw new Error(`Failed to pre-translate notes: ${res.statusText}`);
  return res.json();
}

export interface TranslationsStatus {
  total: number;
  completed: number;
  languages_done: string[];
  status: 'in_progress' | 'completed' | 'not_started' | 'unknown';
}

export async function getTranslationsStatus(presentationId: string): Promise<TranslationsStatus> {
  const res = await fetch(`${API_BASE}/presentations/${presentationId}/translations-status`);
  if (!res.ok) throw new Error(`Failed to get translations status: ${res.statusText}`);
  return res.json();
}

export async function translateText(text: string, targetLanguage: string): Promise<TranslateResponse> {
  const res = await fetch(`${API_BASE}/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, target_language: targetLanguage }),
  });
  if (!res.ok) throw new Error(`Translation failed: ${res.statusText}`);
  return res.json();
}

export async function askQuestion(
  presentationId: string,
  question: string,
  slideIndex?: number,
): Promise<QaResponse> {
  const res = await fetch(`${API_BASE}/qa`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      presentation_id: presentationId,
      question,
      slide_index: slideIndex,
    }),
  });
  if (!res.ok) throw new Error(`Q&A failed: ${res.statusText}`);
  return res.json();
}

export interface AgentChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AgentChatResponse {
  reply: string;
}

export async function agentChat(
  messages: AgentChatMessage[],
  presentationId?: string,
  slideIndex?: number,
): Promise<AgentChatResponse> {
  const res = await fetch(`${API_BASE}/agent/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages,
      presentation_id: presentationId,
      slide_index: slideIndex,
    }),
  });
  if (!res.ok) throw new Error(`Agent chat failed: ${res.statusText}`);
  return res.json();
}
