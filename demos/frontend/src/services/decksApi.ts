// Typed API client for the decks catalog, search and playlists endpoints.
import type { Slide } from './api';
import { type AvatarInfo, pickAvatarForGender } from './avatars';
import type { AudienceLevel } from './podcast';

/** A slide of the public payload (an anonymous visitor): never `body`, speaker notes or translations. */
export interface PublicSlideInfo {
  index: number;
  title: string;
  /** Signed or same-origin slide image; empty when the deck has none. */
  image_url: string;
  /** Visible text of the slide (≤ 600 characters), for alt text. Never speaker notes. */
  text?: string;
}

/** A slide of the admin payload: with its `body`, speaker notes and the cached note translations (no `text`). */
export type AdminSlideInfo = Slide;

/** A slide of a `getDeck()` payload: public for visitors, admin for admins. Narrow with `isAdminSlide`. */
export type DeckSlide = PublicSlideInfo | AdminSlideInfo;

/** True for an admin slide: it carries `body` and `notes` (the server always sends both); a public slide never does. */
export function isAdminSlide(slide: DeckSlide): slide is AdminSlideInfo {
  return 'notes' in slide || 'body' in slide;
}

export interface Deck {
  deck_id: string;
  title: string;
  slide_count: number;
  language: string;
  uploaded_at: string;
  tags: string[];
  /** Present for admins; anonymous visitors only ever receive published decks. */
  published?: boolean;
  /** Anonymous visitors may run the narration-only live avatar demo on this deck. */
  live_demo?: boolean;
  /** Stored audience level of the deck; null when unknown (contracts v1). */
  audience_level?: AudienceLevel | null;
}

interface DeckDetailBase extends Deck {
  id: string;
  /**
   * Public payload: the deck's display TITLE, never the uploaded file name (contracts v1.2). Admin payload: the
   * stored file name. Optional — fall back to `title`, and show visitors `title`, not this.
   */
  filename?: string;
}

/** `GET /api/decks/{id}` for an anonymous visitor. */
export interface PublicDeckDetail extends DeckDetailBase {
  slides: PublicSlideInfo[];
}

/** `GET /api/decks/{id}` for an admin. */
export interface AdminDeckDetail extends DeckDetailBase {
  slides: AdminSlideInfo[];
}

/** What `getDeck()` resolves to: the public or the admin payload, depending on who asks. */
export interface DeckDetail extends DeckDetailBase {
  slides: DeckSlide[];
}

export interface SearchResult {
  deck_id: string;
  deck_title: string;
  slide_index: number;
  slide_title: string;
  snippet: string;
  score: number;
}

export interface SearchResponse {
  results: SearchResult[];
}

export interface UploadDeckResponse {
  deck_id: string;
  title: string;
  slide_count: number;
}

const API = '/api';

async function safeText(r: Response): Promise<string> {
  let text = '';
  try { text = await r.text(); } catch { return `HTTP ${r.status}`; }
  try {
    const detail = JSON.parse(text)?.detail;
    if (typeof detail === 'string' && detail) return detail;
  } catch { /* not JSON */ }
  return text || `HTTP ${r.status}`;
}

export async function uploadDeck(file: File): Promise<UploadDeckResponse> {
  const fd = new FormData();
  fd.append('file', file);
  const r = await fetch(`${API}/decks/upload`, { method: 'POST', body: fd });
  if (!r.ok) throw new Error(await safeText(r));
  return r.json();
}

export async function listDecks(): Promise<Deck[]> {
  const r = await fetch(`${API}/decks`);
  if (!r.ok) throw new Error(await safeText(r));
  const data = await r.json();
  return Array.isArray(data) ? data : (data.items ?? []);
}

export async function getDeck(deckId: string): Promise<DeckDetail> {
  const r = await fetch(`${API}/decks/${deckId}`);
  if (!r.ok) throw new Error(await safeText(r));
  return r.json();
}

export async function deleteDeck(deckId: string): Promise<void> {
  const r = await fetch(`${API}/decks/${deckId}`, { method: 'DELETE' });
  if (!r.ok && r.status !== 204) throw new Error(await safeText(r));
}

/** Admin only: make a deck visible (or hidden) to anonymous visitors. */
export async function publishDeck(deckId: string, published: boolean): Promise<Deck> {
  const r = await fetch(`${API}/decks/${encodeURIComponent(deckId)}/publish`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ published }),
  });
  if (!r.ok) throw new Error(await safeText(r));
  return r.json();
}

/** Admin only: allow (or stop) the anonymous live avatar demo on a published deck. */
export async function setDeckLiveDemo(deckId: string, enabled: boolean): Promise<Deck> {
  const r = await fetch(`${API}/decks/${encodeURIComponent(deckId)}/live-demo`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  if (!r.ok) throw new Error(await safeText(r));
  return r.json();
}

export interface TranslateDeckNotesResponse {
  deck_id: string;
  target_language: string;
  /** Slide index (as string) → translated speaker notes. */
  translated_notes: Record<string, string>;
  cached: boolean;
}

/** Admin only: translate a deck's speaker notes into `language` (cached server-side in Cosmos). */
export async function translateDeckNotes(deckId: string, language: string): Promise<TranslateDeckNotesResponse> {
  const r = await fetch(`${API}/decks/${encodeURIComponent(deckId)}/translate-notes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target_language: language }),
  });
  if (!r.ok) throw new Error(await safeText(r));
  return r.json();
}

/**
 * True when narrating `deck` in `language` would fall back to original notes
 * on at least one slide (translations are used whenever `language` differs
 * from the deck's own language, default en-US).
 */
export function deckNeedsNotesTranslation(deck: DeckDetail | null, language: string): boolean {
  if (!deck || language === (deck.language || 'en-US')) return false;
  return (deck.slides ?? []).some((s) => isAdminSlide(s) && !!s.notes?.trim() && !s.translated_notes?.[language]);
}

/** Return a copy of `deck` with `translations` merged into each slide's `translated_notes[language]`. */
export function mergeDeckTranslations(deck: DeckDetail, language: string, translations: Record<string, string>): DeckDetail {
  return {
    ...deck,
    slides: (deck.slides ?? []).map((s) => {
      const text = translations[String(s.index)];
      return text && isAdminSlide(s) ? { ...s, translated_notes: { ...(s.translated_notes ?? {}), [language]: text } } : s;
    }),
  };
}

/**
 * `Slide[]` for the presenter components (`Presentation.slides`). A public slide has no `body` or `notes`
 * (visitors never receive them), so they read as empty strings; its `text` is kept for alt text.
 */
export function presenterSlides(slides: readonly DeckSlide[] | null | undefined): Array<Slide & { text?: string }> {
  return (slides ?? []).map((s) => (isAdminSlide(s)
    ? s
    : {
      index: s.index, title: s.title, body: '', notes: '', image_url: s.image_url,
      ...(s.text !== undefined ? { text: s.text } : {}),
    }));
}

export async function searchDecks(query: string, topK = 5): Promise<SearchResponse> {
  const r = await fetch(`${API}/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, top_k: topK }),
  });
  if (!r.ok) throw new Error(await safeText(r));
  return r.json();
}

// ---- Voice / Avatar static catalogs ---------------------------------------
// Mirrors demos/backend/routers/video.py VOICES.
export interface DeckVoice {
  id: string;
  display_name: string;
  language: string;
  gender: 'male' | 'female';
}

export const DECK_VOICES: DeckVoice[] = [
  { id: 'en-US-Andrew:DragonHDLatestNeural',    display_name: 'Andrew (HD)',          language: 'en-US', gender: 'male' },
  { id: 'en-US-Ava:DragonHDLatestNeural',       display_name: 'Ava (HD)',             language: 'en-US', gender: 'female' },
  { id: 'fr-FR-Remy:DragonHDLatestNeural',      display_name: 'Rémy (HD)',            language: 'fr-FR', gender: 'male' },
  { id: 'fr-FR-Vivienne:DragonHDLatestNeural',  display_name: 'Vivienne (HD)',        language: 'fr-FR', gender: 'female' },
  { id: 'es-ES-Tristan:DragonHDLatestNeural',   display_name: 'Tristán (HD)',         language: 'es-ES', gender: 'male' },
  { id: 'es-ES-Ximena:DragonHDLatestNeural',    display_name: 'Ximena (HD)',          language: 'es-ES', gender: 'female' },
  { id: 'de-DE-Florian:DragonHDLatestNeural',   display_name: 'Florian (HD)',         language: 'de-DE', gender: 'male' },
  { id: 'de-DE-Seraphina:DragonHDLatestNeural', display_name: 'Seraphina (HD)',       language: 'de-DE', gender: 'female' },
  { id: 'it-IT-Alessio:DragonHDLatestNeural',   display_name: 'Alessio (HD)',         language: 'it-IT', gender: 'male' },
  { id: 'it-IT-Isabella:DragonHDLatestNeural',  display_name: 'Isabella (HD)',        language: 'it-IT', gender: 'female' },
  { id: 'pt-BR-Macerio:DragonHDLatestNeural',   display_name: 'Macério (HD)',         language: 'pt-BR', gender: 'male' },
  { id: 'pt-BR-Thalita:DragonHDLatestNeural',   display_name: 'Thalita (HD)',         language: 'pt-BR', gender: 'female' },
  { id: 'zh-CN-Xiaochen:DragonHDLatestNeural',  display_name: '晓辰 Xiaochen (HD)',   language: 'zh-CN', gender: 'female' },
  { id: 'zh-CN-Yunfan:DragonHDLatestNeural',    display_name: '云帆 Yunfan (HD)',     language: 'zh-CN', gender: 'male' },
  { id: 'ja-JP-Masaru:DragonHDLatestNeural',    display_name: 'Masaru (HD)',          language: 'ja-JP', gender: 'male' },
  { id: 'ja-JP-Nanami:DragonHDLatestNeural',    display_name: 'Nanami (HD)',          language: 'ja-JP', gender: 'female' },
];

export const DECK_LANGUAGE_LABELS: Record<string, string> = {
  'en-US': '🇬🇧 English (US)',
  'fr-FR': '🇫🇷 Français',
  'es-ES': '🇪🇸 Español',
  'de-DE': '🇩🇪 Deutsch',
  'it-IT': '🇮🇹 Italiano',
  'pt-BR': '🇧🇷 Português (Brasil)',
  'zh-CN': '🇨🇳 中文 (简体)',
  'ja-JP': '🇯🇵 日本語',
};

const MALE_VOICE_NAMES = ['Andrew', 'Remy', 'Tristan', 'Florian', 'Alessio', 'Macerio', 'Yunfan', 'Masaru'];
const FEMALE_VOICE_NAMES = ['Ava', 'Vivienne', 'Ximena', 'Seraphina', 'Isabella', 'Thalita', 'Xiaochen', 'Nanami'];

/** Gender of a known DragonHD voice id, or null if unknown. */
export function voiceGender(voice: string): 'male' | 'female' | null {
  if (!voice) return null;
  if (MALE_VOICE_NAMES.some((n) => voice.includes(n))) return 'male';
  if (FEMALE_VOICE_NAMES.some((n) => voice.includes(n))) return 'female';
  return null;
}

/**
 * Suggest an avatar id matching the voice gender from the server catalog
 * (`GET /api/avatars`). Falls back to `fallback` when no gender match exists.
 */
export function avatarForVoice(voice: string, avatars: AvatarInfo[], fallback = ''): string {
  const gender = voiceGender(voice);
  if (!gender) return fallback || pickAvatarForGender(avatars, null)?.id || '';
  const sameGender = avatars.filter((a) => a.gender === gender);
  if (fallback && sameGender.some((a) => a.id === fallback)) return fallback;
  return (sameGender.find((a) => a.is_default) ?? sameGender[0])?.id || fallback;
}

/**
 * Voice to use after the narration language changes: the current voice when it
 * already speaks `language`, else a same-gender native voice for it, else the
 * same-gender multilingual en-US HD voice (languages without a native one).
 * An explicitly chosen voice would otherwise win over the language server-side.
 */
export function voiceForLanguage(currentVoice: string, language: string): string {
  const current = DECK_VOICES.find((v) => v.id === currentVoice);
  if (current?.language === language) return currentVoice;
  const gender = current?.gender ?? voiceGender(currentVoice) ?? 'female';
  const native = DECK_VOICES.filter((v) => v.language === language);
  const pick = native.find((v) => v.gender === gender) ?? native[0]
    ?? DECK_VOICES.find((v) => v.language === 'en-US' && v.gender === gender);
  return pick?.id ?? currentVoice;
}


// ======================= Playlists ========================================
export interface PlaylistStep {
  order: number;
  deck_id: string;
  deck_title: string;
  slide_count: number;
  required: boolean;
}

export interface PlaylistSummary {
  id: string;
  title: string;
  description: string;
  status: 'active' | 'broken';
  step_count: number;
  created_at: string;
  updated_at: string;
}

export interface PlaylistDetail extends PlaylistSummary {
  steps: PlaylistStep[];
}

export interface PlaylistStepInput {
  deck_id: string;
  order: number;
  required?: boolean;
}

export interface PlaylistCreateInput {
  title: string;
  description?: string;
  steps: PlaylistStepInput[];
}

export interface PlaylistUpdateInput {
  title?: string;
  description?: string;
  steps?: PlaylistStepInput[];
}

export interface PlaylistProgress {
  user_id: string;
  playlist_id: string;
  last_deck_id: string;
  last_slide_index: number;
  resume_deck_id: string;
  resume_slide_index: number;
  completed_slides: Record<string, number[]>;
  total_slides: number;
  completed_count: number;
  percent: number;
  updated_at: string;
}

export interface ProgressPostInput {
  user_id: string;
  deck_id: string;
  slide_index: number;
  mark_completed?: boolean;
}

export async function listPlaylists(): Promise<PlaylistSummary[]> {
  const r = await fetch(`${API}/playlists`);
  if (!r.ok) throw new Error(await safeText(r));
  return r.json();
}

export async function getPlaylist(playlistId: string): Promise<PlaylistDetail> {
  const r = await fetch(`${API}/playlists/${playlistId}`);
  if (!r.ok) {
    const msg = await safeText(r);
    const err = new Error(msg) as Error & { status?: number };
    err.status = r.status;
    throw err;
  }
  return r.json();
}

export async function createPlaylist(body: PlaylistCreateInput): Promise<PlaylistDetail> {
  const r = await fetch(`${API}/playlists`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await safeText(r));
  return r.json();
}

export async function updatePlaylist(playlistId: string, body: PlaylistUpdateInput): Promise<PlaylistDetail> {
  const r = await fetch(`${API}/playlists/${playlistId}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await safeText(r));
  return r.json();
}

export async function deletePlaylist(playlistId: string): Promise<void> {
  const r = await fetch(`${API}/playlists/${playlistId}`, { method: 'DELETE' });
  if (!r.ok && r.status !== 204) throw new Error(await safeText(r));
}

export async function getProgress(playlistId: string, userId: string): Promise<PlaylistProgress> {
  const r = await fetch(`${API}/playlists/${playlistId}/progress?user_id=${encodeURIComponent(userId)}`);
  if (!r.ok) throw new Error(await safeText(r));
  return r.json();
}

export async function postProgress(playlistId: string, body: ProgressPostInput): Promise<PlaylistProgress> {
  const r = await fetch(`${API}/playlists/${playlistId}/progress`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await safeText(r));
  return r.json();
}

const USER_ID_KEY = 'oz-radio.userId';
// Pre-rename key: migrated once so returning users keep their playlist progress.
const LEGACY_USER_ID_KEY = 'deckfm.userId';
export function getOrCreateUserId(): string {
  try {
    let id = localStorage.getItem(USER_ID_KEY);
    if (!id) {
      const legacy = localStorage.getItem(LEGACY_USER_ID_KEY);
      if (legacy) {
        localStorage.setItem(USER_ID_KEY, legacy);
        localStorage.removeItem(LEGACY_USER_ID_KEY);
        id = legacy;
      }
    }
    if (!id) {
      id = 'u_' + crypto.randomUUID();
      localStorage.setItem(USER_ID_KEY, id);
    }
    return id;
  } catch {
    return 'anonymous';
  }
}


// ======================= AI Playlist Recommendation =======================
export interface RecommendedStep {
  deck_id: string;
  deck_title: string;
  slide_count: number;
  order: number;
  rationale: string;
}

export interface RecommendResponse {
  title: string;
  description: string;
  steps: RecommendedStep[];
  explanation: string;
}

export async function recommendPlaylist(
  topic: string,
  maxSteps = 4,
  language?: string,
): Promise<RecommendResponse> {
  const r = await fetch(`${API}/playlists/recommend`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ topic, max_steps: maxSteps, language }),
  });
  if (!r.ok) {
    const msg = await safeText(r);
    const err = new Error(msg) as Error & { status?: number };
    err.status = r.status;
    throw err;
  }
  return r.json();
}
