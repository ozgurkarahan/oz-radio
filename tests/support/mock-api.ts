import type { Page, Route } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { BOOT_ELEMENT_ID, BOOT_FAIL_CLOSED, BOOT_MARKER, type BootLiveDeck, type BootPayload } from '../../demos/frontend/src/services/boot';
import { LIBRARY_UNAVAILABLE_DETAIL } from '../../demos/frontend/src/ui/format';

const AVATAR_DIR = path.join(__dirname, '..', '..', 'demos', 'backend', 'static', 'avatars');

// Shared /api mocks for the regression + screenshot specs (deterministic, no Azure).
// Extended by WU-F0 for the UX-fix run (contracts v1): public DTO fields, same-origin VTT routes, failure and delay
// toggles, an opt-in `demo` catalog (bilingual live-demo decks + same-title recordings) and `mockBoot`.
// Every addition is backward compatible: the default catalog and the default responses are unchanged except for
// the new additive DTO fields. Only WU-F0 edits this file.
export type Role = 'visitor' | 'admin';
/** `default` = the original fixtures; `demo` = adds the EN/FR live-demo decks, same-title recordings and a level series. */
export type Catalog = 'default' | 'demo';

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

export const DECKS = [
  { deck_id: 'deck-live', title: 'ai-fundamentals', slide_count: 3, language: 'en-US', uploaded_at: '2026-10-14T21:51:41Z', tags: [], published: true, live_demo: true, audience_level: 'beginner' as string | null },
  { deck_id: 'deck-plain', title: 'ai-ethics', slide_count: 3, language: 'en-US', uploaded_at: '2026-10-14T21:51:46Z', tags: [], published: true, live_demo: false, audience_level: null as string | null },
];

/** Longest public slide `text` (characters, ellipsis included) — contracts §2.1. */
export const PUBLIC_SLIDE_TEXT_MAX = 600;

// Cached FR translations of the speaker notes (admin payload only, like the backend).
export const FR_NOTES = ['Notes FR 1', 'Notes FR 2', 'Notes FR 3'];

// ── Demo catalog (opt-in: `catalog: 'demo'`) ───────────────────────────────
// Mirrors production: the two live-demo decks and their recordings share the display title
// (maintenance/content.py DISPLAY_TITLES, French one with a typographic apostrophe).
export const DEMO_DECK_EN = {
  deck_id: 'deck-demo-en', title: 'AI in three minutes · Live demo', slide_count: 5, language: 'en-US',
  uploaded_at: '2026-10-17T09:00:00Z', tags: [], published: true, live_demo: true, audience_level: 'beginner' as string | null,
};
export const DEMO_DECK_FR = {
  deck_id: 'deck-demo-fr', title: 'L\u2019IA en trois minutes · Démo en direct', slide_count: 5, language: 'fr-FR',
  uploaded_at: '2026-10-17T09:05:00Z', tags: [], published: true, live_demo: true, audience_level: 'beginner' as string | null,
};
export const DEMO_DECKS = [DEMO_DECK_EN, DEMO_DECK_FR, DECKS[1]];

/** Visible text of the demo slides (public `text`), per deck. */
const DEMO_SLIDES: Record<string, { title: string; text: string }[]> = {
  'deck-demo-en': [
    { title: "Hi, I'm an AI presenter", text: 'A short live demo\nBeginner level\nWhat a model is\nWhat an agent is' },
    { title: 'What a model is', text: 'Trained on text\nPredicts the next word' },
    { title: 'Models and agents', text: 'A model produces words\nAn agent uses tools in a loop' },
    { title: 'A voice and a face', text: 'Speech to text\nText to speech\nAn animated avatar' },
    { title: 'Thank you', text: 'Bring your questions' },
  ],
  'deck-demo-fr': [
    { title: 'Bonjour, je suis un présentateur IA', text: 'Une courte démo en direct\nNiveau débutant' },
    { title: 'Ce qu’est un modèle', text: 'Entraîné sur du texte\nPrédit le mot suivant' },
    { title: 'Modèles et agents', text: 'Un modèle produit des mots\nUn agent utilise des outils en boucle' },
    { title: 'Une voix et un visage', text: 'Reconnaissance vocale\nSynthèse vocale\nUn avatar animé' },
    { title: 'Merci', text: 'Posez vos questions' },
  ],
};

/** `GET /api/decks` for a catalog. */
const deckList = (catalog: Catalog) => (catalog === 'demo' ? DEMO_DECKS : DECKS);
/** Decks whose detail resolves (the demo catalog still serves the default decks by id). */
const deckPool = (catalog: Catalog) => (catalog === 'demo' ? [...DEMO_DECKS, DECKS[0]] : DECKS);

const deckDetail = (id: string, admin: boolean, catalog: Catalog = 'default') => {
  const d = deckPool(catalog).find((x) => x.deck_id === id) ?? DECKS[0];
  const demoSlides = DEMO_SLIDES[d.deck_id];
  const slides = demoSlides
    ? demoSlides.map((s, i) => ({ index: i, title: s.title, body: s.text, text: s.text }))
    : [0, 1, 2].map((i) => ({ index: i, title: `Slide title ${i + 1}`, body: `Body ${i + 1}`, text: `Body ${i + 1}` }));
  return {
    ...d,
    id: d.deck_id,
    // Public payload (contracts v1.2): `filename` carries the deck's display TITLE, never the uploaded file name.
    filename: admin ? `${d.title}.pptx` : d.title,
    // Anonymous payload mirrors routers/decks.py PublicSlidePayload: index, title, image_url (empty here: no image)
    // and the visible `text` (<= PUBLIC_SLIDE_TEXT_MAX chars); never body, notes or translations.
    slides: slides.map((s) => (admin
      ? { index: s.index, title: s.title, body: s.body, notes: `Notes ${s.index + 1}`, translated_notes: { 'fr-FR': FR_NOTES[s.index] ?? `Notes FR ${s.index + 1}` } }
      : { index: s.index, title: s.title, image_url: '', text: s.text.slice(0, PUBLIC_SLIDE_TEXT_MAX) })),
  };
};

const AVATARS = [
  { id: 'photo_female', display_name: 'Sofia', gender: 'female', thumbnail_url: '/static/avatars/photo_female.png', is_default: true },
  { id: 'photo_male', display_name: 'Lucas', gender: 'male', thumbnail_url: '/static/avatars/photo_male.png', is_default: false },
  { id: 'lisa', display_name: 'Lisa', gender: 'female', thumbnail_url: '', is_default: false },
];

interface VideoRecord {
  job_id: string; title: string; language: string; created_at: string; thumbnail_url: string | null; duration_sec: number;
  slide_count: number; published: boolean; audience_level: string | null; source_deck_id: string | null; has_captions: boolean;
}
const VIDEO_ITEM: VideoRecord = {
  job_id: 'vid-1', title: 'context-engineering-rag', language: 'en-US', created_at: '2026-10-15T00:05:00Z',
  thumbnail_url: null, duration_sec: 98, slide_count: 6, published: true,
  audience_level: 'practitioner', source_deck_id: null, has_captions: true,
};
/** Recordings of the live-demo decks: same display title, same language (demo catalog). */
export const VIDEO_DEMO_EN: VideoRecord = {
  job_id: 'vid-demo-en', title: DEMO_DECK_EN.title, language: 'en-US', created_at: '2026-10-18T10:00:00Z',
  thumbnail_url: null, duration_sec: 192, slide_count: 5, published: true,
  audience_level: 'beginner', source_deck_id: null, has_captions: true,
};
export const VIDEO_DEMO_FR: VideoRecord = {
  job_id: 'vid-demo-fr', title: DEMO_DECK_FR.title, language: 'fr-FR', created_at: '2026-10-18T10:05:00Z',
  thumbnail_url: null, duration_sec: 205, slide_count: 5, published: true,
  audience_level: 'beginner', source_deck_id: null, has_captions: true,
};
/** Newest first, like the backend. */
const videoList = (catalog: Catalog): VideoRecord[] => (catalog === 'demo' ? [VIDEO_DEMO_FR, VIDEO_DEMO_EN, VIDEO_ITEM] : [VIDEO_ITEM]);

/**
 * Library video as `role` receives it. A superset of routers/video.py `_public_item` (it keeps `slide_count` and
 * `published` for the legacy specs) plus the contracts-v1 fields: `audience_level`, `source_deck_id` and the same-origin
 * `captions_vtt_url`. The detail adds the signed-media stand-in `video_url`.
 */
function videoPayload(item: VideoRecord, detail: boolean) {
  const { has_captions: hasCaptions, ...rest } = item;
  return {
    ...rest,
    captions_vtt_url: hasCaptions ? `/api/video/library/${item.job_id}/captions.vtt` : null,
    ...(detail ? { video_url: `/media/${item.job_id}.mp4` } : {}),
  };
}

/** WebVTT body served by the mocked `captions.vtt` routes. */
export const VTT_BODY = 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:04.800\nWelcome to Oz Radio.\n\n2\n00:00:05.000 --> 00:00:09.000\nToday we talk about agents.\n';
const PODCAST_ITEM = {
  job_id: 'pod-1', title: 'ai-agents-mcp', language: 'en-US', created_at: '2026-10-14T21:52:00Z',
  thumbnail_url: null, duration_sec: 114, speaker_names: ['Sofia', 'Lucas'], published: true,
};
const PLAYLIST = {
  id: 'pl-1', title: 'Security onboarding', description: 'Two decks', status: 'active', step_count: 2,
  created_at: '2026-10-14T00:00:00Z', updated_at: '2026-10-14T00:00:00Z',
};

// ── Media fixtures (tests/fixtures/media, see its README) ─────────────────
const MEDIA_DIR = path.join(__dirname, '..', 'fixtures', 'media');

interface MediaFixture { file: string; contentType: string; durationSec: number }
export const MEDIA: Record<'mp3' | 'wav' | 'mp4', MediaFixture> = {
  /** Radio MP3 served for every `/media/*.mp3` and job `file/mp3`. */
  mp3: { file: 'radio.mp3', contentType: 'audio/mpeg', durationSec: 30 },
  /** Short WAV served for every `/media/*.wav`. */
  wav: { file: 'radio.wav', contentType: 'audio/wav', durationSec: 6 },
  /** Silent VP9 MP4: the v2 video rendition and job `file/mp4` (other `/media/*.mp4` stay empty). */
  mp4: { file: 'video.mp4', contentType: 'video/mp4', durationSec: 40 },
};

const mediaBytes = new Map<string, Buffer>();
function mediaBody(fixture: MediaFixture): Buffer {
  let body = mediaBytes.get(fixture.file);
  if (!body) {
    body = fs.readFileSync(path.join(MEDIA_DIR, fixture.file));
    mediaBytes.set(fixture.file, body);
  }
  return body;
}

/** Serves a media fixture like Blob storage behind a SAS URL: `Accept-Ranges` + byte ranges (206 / 416). */
export function fulfillMedia(route: Route, fixture: MediaFixture) {
  const body = mediaBody(fixture);
  const size = body.length;
  const range = route.request().headers()['range'];
  if (!range) {
    return route.fulfill({ status: 200, contentType: fixture.contentType, body, headers: { 'accept-ranges': 'bytes' } });
  }
  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  let start = -1;
  let end = -1;
  if (m && m[1] !== '') {
    start = Number(m[1]);
    end = m[2] !== '' ? Math.min(Number(m[2]), size - 1) : size - 1;
  } else if (m && m[2] !== '') {
    start = Math.max(0, size - Number(m[2])); // suffix range: the last N bytes
    end = size - 1;
  }
  if (start < 0 || start >= size || start > end) {
    return route.fulfill({ status: 416, headers: { 'accept-ranges': 'bytes', 'content-range': `bytes */${size}` }, body: '' });
  }
  return route.fulfill({
    status: 206,
    contentType: fixture.contentType,
    body: body.subarray(start, end + 1),
    headers: { 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${size}` },
  });
}

// ── Podcasts v2 (radio) ───────────────────────────────────────────────────
// Library payloads mirror routers/podcast.py: admins get LibrarySummary /
// LibraryItem (every rendition), anonymous visitors the public DTO
// (`_public_item`: no srt/audio_srt/scorm/script/document_title; audio, cover,
// hosts and transcript only with PODCAST_PUBLIC_AUDIO on).
type Speaker = 'interviewer' | 'expert';

export const PODCAST_HOSTS = [
  { role: 'interviewer' as Speaker, display_name: 'Sofia', avatar_id: 'photo_female' as string | null },
  { role: 'expert' as Speaker, display_name: 'Lucas', avatar_id: 'photo_male' as string | null },
];

const peaks = (n: number) => Array.from({ length: n }, (_, i) => Math.round(Math.abs(Math.sin(i / 7)) * 1000) / 1000);

/**
 * Radio timeline of the video + audio episode (`radio.mp3`, 30 s) with each turn's
 * span in its video (`video.mp4`, 40 s). Turn 1 maps audio 9.3–19.0 ↔ video 12.5–25.0.
 */
export const RADIO_TRANSCRIPT = {
  version: 1,
  duration_sec: 30,
  hosts: PODCAST_HOSTS,
  turns: [
    { turn_idx: 0, speaker: 'interviewer' as Speaker, start: 1.0, end: 9.0, video_start: 2.0 as number | null, video_end: 12.0 as number | null },
    { turn_idx: 1, speaker: 'expert' as Speaker, start: 9.3, end: 19.0, video_start: 12.5 as number | null, video_end: 25.0 as number | null },
    { turn_idx: 2, speaker: 'interviewer' as Speaker, start: 19.3, end: 24.0, video_start: 25.5 as number | null, video_end: 31.5 as number | null },
    { turn_idx: 3, speaker: 'expert' as Speaker, start: 24.3, end: 29.0, video_start: 32.0 as number | null, video_end: 38.0 as number | null },
  ],
  cues: [
    { start: 1.0, end: 4.8, speaker: 'interviewer' as Speaker, turn_idx: 0, text: 'Welcome to Oz Radio.', kind: 'speech' },
    { start: 5.0, end: 9.0, speaker: 'interviewer' as Speaker, turn_idx: 0, text: 'Today we talk about agents.', kind: 'speech' },
    { start: 9.3, end: 12.8, speaker: 'expert' as Speaker, turn_idx: 1, text: 'Agents plan, act and check their work.', kind: 'speech' },
    { start: 13.0, end: 13.6, speaker: 'interviewer' as Speaker, turn_idx: 1, text: 'Mm-hmm.', kind: 'reaction' },
    { start: 13.8, end: 19.0, speaker: 'expert' as Speaker, turn_idx: 1, text: 'That loop is what makes them useful.', kind: 'speech' },
    { start: 19.3, end: 24.0, speaker: 'interviewer' as Speaker, turn_idx: 2, text: 'So where should a team start?', kind: 'speech' },
    { start: 24.3, end: 29.0, speaker: 'expert' as Speaker, turn_idx: 3, text: 'Start small, measure, then scale.', kind: 'speech' },
  ],
  peaks: peaks(240),
};

/** Radio-only transcript (no video timings) of the audio-only episode (`radio.wav`, 6 s). */
export const SHORT_TRANSCRIPT = {
  version: 1,
  duration_sec: 6,
  hosts: [
    { role: 'interviewer' as Speaker, display_name: 'Ana', avatar_id: null },
    { role: 'expert' as Speaker, display_name: 'Marc', avatar_id: null },
  ],
  turns: [
    { turn_idx: 0, speaker: 'interviewer' as Speaker, start: 0.4, end: 2.8, video_start: null, video_end: null },
    { turn_idx: 1, speaker: 'expert' as Speaker, start: 3.0, end: 5.6, video_start: null, video_end: null },
  ],
  cues: [
    { start: 0.4, end: 2.8, speaker: 'interviewer' as Speaker, turn_idx: 0, text: 'Bienvenue sur Oz Radio.', kind: 'speech' },
    { start: 3.0, end: 5.6, speaker: 'expert' as Speaker, turn_idx: 1, text: 'Une minute pour la sécurité.', kind: 'speech' },
  ],
  peaks: peaks(60),
};

/** Stored library item (every field; payloads are derived per role). */
export interface PodcastRecord {
  job_id: string; title: string; document_title: string; created_at: string; language: string; style: string;
  audience_level: string | null; speaker_names: string[]; turn_count: number; thumbnail_url: string | null;
  published: boolean; format: 'video' | 'audio'; has_video: boolean; has_audio: boolean;
  duration_sec: number; audio_duration_sec: number; hosts: typeof PODCAST_HOSTS;
  mp4_url: string | null; mp3_url: string; srt_url: string | null; audio_srt_url: string; scorm_url: string;
  cover_url: string; transcript: typeof RADIO_TRANSCRIPT;
  /** Manifest link to the source deck (null for every item today). */
  source_deck_id?: string | null;
}

/** Video + radio episode: Watch and Listen. */
export const POD_VIDEO: PodcastRecord = {
  job_id: 'pod-2', title: 'agents-on-air', document_title: 'Agents on air.pptx', created_at: '2026-10-16T09:00:00Z',
  language: 'en-US', style: 'casual', audience_level: null, speaker_names: ['Sofia', 'Lucas'], turn_count: 4,
  thumbnail_url: '/media/pod-2-thumb.png', published: true, format: 'video', has_video: true, has_audio: true,
  duration_sec: 40, audio_duration_sec: 30, hosts: PODCAST_HOSTS,
  mp4_url: '/media/pod-2.mp4', mp3_url: '/media/pod-2.mp3', srt_url: '/media/pod-2.srt',
  audio_srt_url: '/media/pod-2-radio.srt', scorm_url: '/media/pod-2-scorm.zip', cover_url: '/media/pod-2-cover.png',
  transcript: RADIO_TRANSCRIPT,
};

/** Audio-only episode: Listen only. */
export const POD_AUDIO: PodcastRecord = {
  job_id: 'pod-3', title: 'safety-minute', document_title: 'Safety minute.docx', created_at: '2026-10-17T08:00:00Z',
  language: 'fr-FR', style: 'explainer', audience_level: 'beginner', speaker_names: ['Ana', 'Marc'], turn_count: 2,
  thumbnail_url: '/media/pod-3-cover.png', published: true, format: 'audio', has_video: false, has_audio: true,
  duration_sec: 6, audio_duration_sec: 6, hosts: SHORT_TRANSCRIPT.hosts,
  mp4_url: null, mp3_url: '/media/pod-3.wav', srt_url: null, audio_srt_url: '/media/pod-3-radio.srt',
  scorm_url: '/media/pod-3-scorm.zip', cover_url: '/media/pod-3-cover.png', transcript: SHORT_TRANSCRIPT,
};

/** Newest first, like the backend; the legacy (pre-radio) item has no format/has_* fields. */
const PODCASTS_V2: (PodcastRecord | typeof PODCAST_ITEM)[] = [POD_AUDIO, POD_VIDEO, PODCAST_ITEM];

/** Demo catalog: the French live-demo recording (same title as its deck) and an English beginner → expert series. */
const demoEpisode = (job_id: string, title: string, language: string, created_at: string, level: string, hosts: typeof PODCAST_HOSTS): PodcastRecord => ({
  job_id, title, document_title: `${title}.pptx`, created_at, language, style: 'casual', audience_level: level,
  speaker_names: hosts.map((h) => h.display_name), turn_count: 4, thumbnail_url: `/media/${job_id}-thumb.png`, published: true,
  format: 'video', has_video: true, has_audio: true, duration_sec: 40, audio_duration_sec: 30, hosts,
  mp4_url: `/media/${job_id}.mp4`, mp3_url: `/media/${job_id}.mp3`, srt_url: `/media/${job_id}.srt`,
  audio_srt_url: `/media/${job_id}-radio.srt`, scorm_url: `/media/${job_id}-scorm.zip`, cover_url: `/media/${job_id}-cover.png`,
  transcript: RADIO_TRANSCRIPT, source_deck_id: null,
});
export const POD_DEMO_FR = demoEpisode('pod-demo-fr', DEMO_DECK_FR.title, 'fr-FR', '2026-10-18T11:00:00Z', 'beginner', PODCAST_HOSTS);
export const POD_LEVEL_BEGINNER = demoEpisode('pod-lvl-1', 'AI, demystified · Beginner', 'en-US', '2026-10-18T07:00:00Z', 'beginner', PODCAST_HOSTS);
export const POD_LEVEL_PRACTITIONER = demoEpisode('pod-lvl-2', 'Building with AI · Practitioner', 'en-US', '2026-10-18T08:00:00Z', 'practitioner', PODCAST_HOSTS);
export const POD_LEVEL_EXPERT = demoEpisode('pod-lvl-3', 'Under the hood · Expert', 'en-US', '2026-10-18T09:00:00Z', 'expert', PODCAST_HOSTS);
const DEMO_PODCASTS: PodcastRecord[] = [POD_DEMO_FR, POD_LEVEL_EXPERT, POD_LEVEL_PRACTITIONER, POD_LEVEL_BEGINNER];
const podcastCatalog = (catalog: Catalog): (PodcastRecord | typeof PODCAST_ITEM)[] =>
  (catalog === 'demo' ? [...DEMO_PODCASTS, ...PODCASTS_V2] : PODCASTS_V2);

const legacyDetail = () => ({ ...PODCAST_ITEM, mp4_url: '/media/pod-1.mp4', video_url: '/media/pod-1.mp4' });
const isRecord = (item: PodcastRecord | typeof PODCAST_ITEM): item is PodcastRecord => 'format' in item;

function adminSummary(item: PodcastRecord) {
  return {
    job_id: item.job_id, title: item.title, document_title: item.document_title, created_at: item.created_at,
    duration_sec: item.duration_sec, language: item.language, style: item.style, audience_level: item.audience_level,
    speaker_names: item.speaker_names, turn_count: item.turn_count, thumbnail_url: item.thumbnail_url,
    published: item.published, format: item.format, has_video: item.has_video, has_audio: item.has_audio,
    audio_duration_sec: item.audio_duration_sec, hosts: item.hosts,
  };
}

function adminItem(item: PodcastRecord) {
  return {
    ...adminSummary(item), mp4_url: item.mp4_url, mp3_url: item.mp3_url, srt_url: item.srt_url,
    scorm_url: item.scorm_url, audio_url: item.mp3_url, cover_url: item.cover_url,
    audio_srt_url: item.audio_srt_url, transcript: item.transcript,
  };
}

/** `captions_vtt_url` of a podcast: only a video rendition with a video-timed SRT has one. */
const podcastCaptionsUrl = (item: PodcastRecord) =>
  (item.has_video && item.srt_url ? `/api/podcast/library/${item.job_id}/captions.vtt` : null);

/**
 * `_public_item`: list rows carry no media URLs; the detail mints them. Contracts v1 adds `audience_level`,
 * `source_deck_id` and the same-origin `captions_vtt_url` (list rows and detail alike).
 */
function publicItem(item: PodcastRecord, publicAudio: boolean, detail: boolean) {
  const hasAudio = publicAudio && item.has_audio;
  const videoUrl = detail && item.has_video ? item.mp4_url : null;
  const audioUrl = detail && hasAudio ? item.mp3_url : null;
  return {
    job_id: item.job_id, title: item.title, created_at: item.created_at, duration_sec: item.duration_sec,
    audio_duration_sec: hasAudio ? item.audio_duration_sec : null, language: item.language, format: item.format,
    audience_level: item.audience_level ?? null, source_deck_id: item.source_deck_id ?? null,
    captions_vtt_url: podcastCaptionsUrl(item),
    has_video: item.has_video, has_audio: hasAudio, thumbnail_url: item.thumbnail_url,
    cover_url: detail && publicAudio ? item.cover_url : null, video_url: videoUrl, mp4_url: videoUrl,
    audio_url: audioUrl, mp3_url: audioUrl, hosts: publicAudio ? item.hosts : [],
    speaker_names: publicAudio ? item.speaker_names : [], transcript: detail && hasAudio ? item.transcript : null,
    srt_url: null, audio_srt_url: null, scorm_url: null, script: null,
  };
}

export interface PodcastPayloadOptions {
  /** PODCAST_PUBLIC_AUDIO (default true): off hides audio facts and audio-only items from visitors. */
  publicAudio?: boolean;
  /** Include the v2 (radio) episodes; off = the legacy item only. The `demo` catalog implies it unless set to false. */
  podcastV2?: boolean;
  /** `demo` adds the French live-demo recording and the beginner → expert series (default `default`). */
  catalog?: Catalog;
}

const visibleTo = (role: Role, item: PodcastRecord, publicAudio: boolean) =>
  role === 'admin' || (item.published && (item.has_video || (publicAudio && item.has_audio)));

/** A library JSON payload (shape depends on the item version and the caller's role). */
export type PodcastPayload = Record<string, any>;

/** GET /api/podcast/library as `role` would receive it. */
export function podcastLibraryList(role: Role, opts: PodcastPayloadOptions = {}): PodcastPayload[] {
  const publicAudio = opts.publicAudio ?? true;
  const catalog = opts.catalog ?? 'default';
  if (!(opts.podcastV2 ?? catalog === 'demo')) return [PODCAST_ITEM];
  return podcastCatalog(catalog).flatMap((item): PodcastPayload[] => {
    if (!isRecord(item)) return [item];
    if (!visibleTo(role, item, publicAudio)) return [];
    return [role === 'admin' ? adminSummary(item) : publicItem(item, publicAudio, false)];
  });
}

/** GET /api/podcast/library/{id} as `role` would receive it (null = 404). */
export function podcastLibraryItem(id: string, role: Role, opts: PodcastPayloadOptions = {}): PodcastPayload | null {
  const publicAudio = opts.publicAudio ?? true;
  const catalog = opts.catalog ?? 'default';
  if (id === PODCAST_ITEM.job_id) return legacyDetail();
  if (!(opts.podcastV2 ?? catalog === 'demo')) return null;
  const item = podcastCatalog(catalog).find((x): x is PodcastRecord => isRecord(x) && x.job_id === id);
  if (!item || !visibleTo(role, item, publicAudio)) return null;
  return role === 'admin' ? adminItem(item) : publicItem(item, publicAudio, true);
}

// ── Podcast studio: voices, ingest, script stream, render jobs ────────────
export const PODCAST_VOICES = [
  { id: 'en-US-Ava:DragonHDLatestNeural', display_name: 'Ava', language: 'en-US', gender: 'female', hd: true, style_list: [] },
  { id: 'en-US-Andrew:DragonHDLatestNeural', display_name: 'Andrew', language: 'en-US', gender: 'male', hd: true, style_list: [] },
  { id: 'fr-FR-Vivienne:DragonHDLatestNeural', display_name: 'Vivienne', language: 'fr-FR', gender: 'female', hd: true, style_list: [] },
  { id: 'fr-FR-Remy:DragonHDLatestNeural', display_name: 'Remy', language: 'fr-FR', gender: 'male', hd: true, style_list: [] },
];

export const STUDIO_DOCUMENT = {
  id: 'doc-1', title: 'Agents on air', source_kind: 'md',
  sections: [{ heading: 'Agents', text: 'Agents plan, act and check their work.' }],
  slide_images: [], slide_titles: [], slide_notes: [],
};

export const STUDIO_SCRIPT_ID = 'scr-00000001';

/** Streamed script; turn 1 plans a backchannel ("ack") by the interviewer after its first sentence. */
export const STUDIO_TURNS = [
  { idx: 0, speaker: 'interviewer', text: 'Welcome to Oz Radio. Today we talk about agents.', slide_idx: 0, word_timings: [] },
  {
    idx: 1, speaker: 'expert', text: 'Agents plan, act and check their work. That loop is what makes them useful.',
    slide_idx: 1, word_timings: [], reaction: { after_sentence: 1, reaction_id: 'ack' },
  },
  { idx: 2, speaker: 'interviewer', text: 'So where should a team start?', slide_idx: 1, word_timings: [] },
  { idx: 3, speaker: 'expert', text: 'Start small, measure, then scale.', slide_idx: 2, word_timings: [] },
];

type JobFormat = 'video' | 'audio';
interface JobStep { state: string; stage: string; completed: number; total: number; message: string }

/** Progress after the POST (queued): JobState + JobProgress.stage per format, like `_render_job_body`. */
export const JOB_STEPS: Record<JobFormat, JobStep[]> = {
  video: [
    { state: 'rendering', stage: 'rendering', completed: 1, total: 4, message: 'Rendering avatar clips…' },
    { state: 'composing', stage: 'composing', completed: 0, total: 1, message: 'Composing the video…' },
    { state: 'composing', stage: 'mixing', completed: 0, total: 1, message: 'Mixing the radio version…' },
    { state: 'done', stage: 'done', completed: 1, total: 1, message: '' },
  ],
  audio: [
    { state: 'rendering', stage: 'synthesizing', completed: 2, total: 4, message: 'Synthesizing voices…' },
    { state: 'composing', stage: 'mixing', completed: 0, total: 1, message: 'Mixing the radio version…' },
    { state: 'done', stage: 'done', completed: 1, total: 1, message: '' },
  ],
};

interface MockJob { id: string; format: JobFormat; body: Record<string, any>; step: number }

const NO_OUTPUTS = {
  mp4_url: null, mp3_url: null, srt_url: null, duration_sec: null, audio_srt_url: null, transcript_url: null,
  cover_url: null, audio_duration_sec: null, video_duration_sec: null, audio_kind: null,
};

function jobView(job: MockJob, warnings: string[]) {
  const steps = JOB_STEPS[job.format];
  const step = job.step >= 0 ? steps[Math.min(job.step, steps.length - 1)] : null;
  const done = step?.state === 'done';
  const video = job.format === 'video';
  const file = (kind: string) => `/api/podcast/jobs/${job.id}/file/${kind}`;
  return {
    id: job.id,
    script_id: job.body.script_id ?? STUDIO_SCRIPT_ID,
    roles: job.body.roles,
    layout: job.body.layout ?? 'split_screen_with_slides',
    music: !!job.body.music,
    intro: !!job.body.intro,
    state: step?.state ?? 'queued',
    progress: step
      ? { stage: step.stage, completed: step.completed, total: step.total, message: step.message }
      : { stage: 'queued', completed: 0, total: 0, message: '' },
    outputs: done ? {
      ...NO_OUTPUTS,
      mp4_url: video ? file('mp4') : null,
      mp3_url: file('mp3'),
      srt_url: video ? file('srt') : null,
      duration_sec: video ? MEDIA.mp4.durationSec : MEDIA.mp3.durationSec,
      audio_srt_url: file('audio_srt'),
      transcript_url: file('transcript'),
      cover_url: file('cover'),
      audio_duration_sec: MEDIA.mp3.durationSec,
      video_duration_sec: video ? MEDIA.mp4.durationSec : null,
      audio_kind: 'radio_mix',
    } : NO_OUTPUTS,
    error: null,
    created_at: '2026-10-17T20:00:00Z',
    updated_at: '2026-10-17T20:00:00Z',
    archive_state: done ? 'published' : 'none',
    library_job_id: done ? job.id : null,
    format: job.format,
    reactions: job.body.reactions ?? true,
    warnings: done ? warnings : [],
    listener_mode: video && done ? 'idle_loop' : null,
  };
}

/** transcript.json of a finished job: the radio timeline; video timings only for video jobs. */
function jobTranscript(job: MockJob) {
  const roles = (job.body.roles ?? {}) as Record<string, { display_name?: string; avatar?: string }>;
  const hosts = (['interviewer', 'expert'] as Speaker[]).map((role) => ({
    role, display_name: roles[role]?.display_name || PODCAST_HOSTS.find((h) => h.role === role)!.display_name,
    avatar_id: roles[role]?.avatar || null,
  }));
  const video = job.format === 'video';
  return {
    ...RADIO_TRANSCRIPT,
    hosts,
    turns: RADIO_TRANSCRIPT.turns.map((t) => (video ? t : { ...t, video_start: null, video_end: null })),
  };
}

const SRT = '1\n00:00:01,000 --> 00:00:04,800\nWelcome to Oz Radio.\n';
const EMPTY_ZIP = Buffer.from([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)]);

export const calls: { method: string; path: string; body: string | null }[] = [];

/** A failure the mock injects on an endpoint family (see `MockApi.failures`). */
export type ApiFailure =
  /** HTTP 503 `{ detail: "Library temporarily unavailable" }` — what WU-F's API returns when storage fails. */
  | 503
  /** HTTP 404 (`Library item not found` / `Deck not found`). */
  | 404
  /** The request is aborted before any response (offline, reset): `fetch()` rejects with a TypeError. */
  | 'network'
  /** HTTP 503 with a plain-text proxy body (Envoy style), the raw text the old UI used to print. */
  | 'proxy-503';

export interface ApiFailures {
  /** GET /api/decks · GET /api/podcast/library · GET /api/video/library */
  decks?: ApiFailure | null;
  podcast?: ApiFailure | null;
  video?: ApiFailure | null;
}
export interface ApiDetailFailures {
  /** GET /api/decks/{id} · GET /api/podcast/library/{id} · GET /api/video/library/{id} · the `captions.vtt` routes */
  deck?: ApiFailure | null;
  podcast?: ApiFailure | null;
  video?: ApiFailure | null;
}
export interface ApiDelays {
  /** Milliseconds the mock waits before answering: /api/me, /api/demo/config, the three lists. */
  me?: number;
  demoConfig?: number;
  decks?: number;
  podcast?: number;
  video?: number;
}

/** `/api/demo/config` as a spec configures it. */
export interface MockDemoConfig {
  /** Default true. `false` → `{ enabled: false, … }` (kill switch off): no `remaining_today`. */
  enabled: boolean;
  sessionSeconds: number;
  /** Omitted (undefined) → no `qa` block, like a server with demo Q&A off. */
  qa?: { enabled: boolean; max_questions: number; max_audio_seconds: number };
  /** Live sessions left today; undefined/null → the key is omitted (legacy default). */
  remainingToday?: number | null;
  /** The endpoint itself fails. */
  failure?: ApiFailure | null;
}

export const DEMO_QA_CONFIG = { enabled: true, max_questions: 2, max_audio_seconds: 15 };

/** What `/api/me` answers (auth.tsx reads these three fields). */
export interface MockMe {
  authenticated: boolean;
  is_admin: boolean;
  name: string | null;
  auth_mode: string;
}

export interface MockApiOptions extends PodcastPayloadOptions {
  /** `qa` block of `/api/demo/config` (omitted → demo Q&A disabled, like the default server). */
  demoQa?: { enabled: boolean; max_questions: number; max_audio_seconds: number };
  demoSessionSeconds?: number;
  /** `/api/me` overrides, e.g. `{ authenticated: true, name: 'Guest Visitor' }` = signed in but not on the allow-list (T1-12). */
  me?: Partial<MockMe>;
  /** Podcast render jobs advance one step per poll (default) or only on `advanceJobs()`. */
  jobAdvance?: 'poll' | 'manual';
  /** Warning codes reported by finished render jobs. */
  jobWarnings?: string[];
  /** `/api/demo/config` `enabled` (default true). */
  demoEnabled?: boolean;
  /** `/api/demo/config` `remaining_today` (omitted by default, like before contracts v1). */
  demoRemainingToday?: number | null;
  /** The list endpoints fail: one failure for all three, or per list. Flip it later through `api.failures`. */
  libraryFailure?: ApiFailure | ApiFailures;
  /** The detail endpoints fail (decks, podcast and video items, the `captions.vtt` routes). */
  detailFailure?: ApiFailure | ApiDetailFailures;
  /** Delays in ms (see `ApiDelays`); change them later through `api.delays`. */
  delayMs?: ApiDelays;
}

export interface MockApi {
  /** JSON bodies of POST /api/podcast/render, in order. */
  renders: Record<string, any>[];
  /** Moves every render job one step forward (`jobAdvance: 'manual'`). */
  advanceJobs(): void;
  /** Mutable: list failures, read on every request (set to `null` to let the next "Try again" succeed). */
  failures: ApiFailures;
  /** Mutable: detail failures. */
  detailFailures: ApiDetailFailures;
  /** Mutable: per-endpoint delays in ms. */
  delays: ApiDelays;
  /** Mutable: what `/api/demo/config` answers (e.g. drop `remainingToday` to 0 after first paint). */
  demo: MockDemoConfig;
  /** Mutable: what `/api/me` answers. */
  me: MockMe;
}

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

const PROXY_503_BODY = 'upstream connect error or disconnect/reset before headers. reset reason: connection failure';

/** Answers `route` with the injected failure. */
function failRoute(route: Route, failure: ApiFailure, notFound: string): Promise<void> {
  switch (failure) {
    case 'network': return route.abort('internetdisconnected');
    case 'proxy-503': return route.fulfill({ status: 503, contentType: 'text/plain', body: PROXY_503_BODY });
    case 404: return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ detail: notFound }) });
    default: return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ detail: LIBRARY_UNAVAILABLE_DETAIL }) });
  }
}

const isFailureMap = <T extends object>(v: unknown): v is T => typeof v === 'object' && v !== null;

/** Registers a 403 "expired SAS" answer on media requests matching `pattern` (the first `times` ones, default all). */
export async function routeExpiredMedia(page: Page, pattern: string | RegExp, opts: { times?: number } = {}): Promise<void> {
  let left = opts.times ?? Number.POSITIVE_INFINITY;
  await page.route(pattern, (route) => {
    if (left <= 0) return route.fallback();
    left -= 1;
    return route.fulfill({ status: 403, contentType: 'application/xml', body: '<Error><Code>AuthenticationFailed</Code></Error>' });
  });
}

export async function mockApi(page: Page, role: Role, opts: MockApiOptions = {}): Promise<MockApi> {
  calls.length = 0;
  const jobs = new Map<string, MockJob>();
  const catalog: Catalog = opts.catalog ?? 'default';
  const listFail: ApiFailures = isFailureMap<ApiFailures>(opts.libraryFailure)
    ? { ...opts.libraryFailure }
    : opts.libraryFailure ? { decks: opts.libraryFailure, podcast: opts.libraryFailure, video: opts.libraryFailure } : {};
  const detailFail: ApiDetailFailures = isFailureMap<ApiDetailFailures>(opts.detailFailure)
    ? { ...opts.detailFailure }
    : opts.detailFailure ? { deck: opts.detailFailure, podcast: opts.detailFailure, video: opts.detailFailure } : {};
  const isAdmin = role === 'admin';
  const api: MockApi = {
    renders: [],
    advanceJobs: () => { for (const job of jobs.values()) job.step += 1; },
    failures: listFail,
    detailFailures: detailFail,
    delays: { ...(opts.delayMs ?? {}) },
    me: { authenticated: isAdmin, is_admin: isAdmin, name: isAdmin ? 'Admin User' : null, auth_mode: 'easyauth', ...(opts.me ?? {}) },
    demo: {
      enabled: opts.demoEnabled ?? true,
      sessionSeconds: opts.demoSessionSeconds ?? 180,
      qa: opts.demoQa,
      remainingToday: opts.demoRemainingToday,
      failure: null,
    },
  };
  const videoPaths = new Set<string | null>([
    POD_VIDEO.mp4_url, ...DEMO_PODCASTS.map((e) => e.mp4_url),
  ]);
  await page.route('**/static/avatars/**', (r) => {
    // Use the real (git-ignored) deployment avatars when present for realistic screenshots.
    const file = path.join(AVATAR_DIR, path.basename(new URL(r.request().url()).pathname));
    const body = fs.existsSync(file) ? fs.readFileSync(file) : PNG_1PX;
    return r.fulfill({ status: 200, contentType: 'image/png', body });
  });
  await page.route('**/media/**', (r) => {
    const p = new URL(r.request().url()).pathname;
    const ext = path.extname(p).toLowerCase();
    if (videoPaths.has(p)) return fulfillMedia(r, MEDIA.mp4);
    if (ext === '.mp3') return fulfillMedia(r, MEDIA.mp3);
    if (ext === '.wav') return fulfillMedia(r, MEDIA.wav);
    if (ext === '.png') return r.fulfill({ status: 200, contentType: 'image/png', body: PNG_1PX });
    return r.fulfill({ status: 200, contentType: 'video/mp4', body: '' });
  });
  await page.route('**/api/**', async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    const m = req.method();
    calls.push({ method: m, path: p, body: req.postData() });
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    const admin = role === 'admin';

    if (p === '/api/me') {
      if (api.delays.me) await sleep(api.delays.me);
      return json(api.me);
    }
    if (p === '/api/demo/config') {
      const d = api.demo;
      if (api.delays.demoConfig) await sleep(api.delays.demoConfig);
      if (d.failure) return failRoute(route, d.failure, 'Not found');
      if (!d.enabled) {
        return json({ enabled: false, session_seconds: d.sessionSeconds, qa: { enabled: false, max_questions: 2, max_audio_seconds: 15 } });
      }
      return json({
        enabled: true, session_seconds: d.sessionSeconds, ...(d.qa ? { qa: d.qa } : {}),
        ...(typeof d.remainingToday === 'number' ? { remaining_today: d.remainingToday } : {}),
      });
    }
    if (p === '/api/avatars') return json(AVATARS);
    if (p === '/api/decks' && m === 'GET') {
      if (api.delays.decks) await sleep(api.delays.decks);
      if (api.failures.decks) return failRoute(route, api.failures.decks, 'Deck not found');
      return json(deckList(catalog));
    }
    if (p === '/api/decks/upload' && m === 'POST') return admin ? json({ deck_id: 'deck-new', title: 'new', slide_count: 1 }) : json({ detail: 'forbidden' }, 403);
    const deckMatch = p.match(/^\/api\/decks\/([^/]+)$/);
    if (deckMatch && m === 'GET') {
      if (api.detailFailures.deck) return failRoute(route, api.detailFailures.deck, 'Deck not found');
      return json(deckDetail(deckMatch[1], admin, catalog));
    }
    const translateMatch = p.match(/^\/api\/decks\/([^/]+)\/translate-notes$/);
    if (translateMatch && m === 'POST') {
      if (!admin) return json({ detail: 'Sign-in required' }, 401);
      const lang = JSON.parse(req.postData() || '{}').target_language as string;
      return json({ deck_id: translateMatch[1], target_language: lang, cached: false,
        translated_notes: Object.fromEntries([0, 1, 2].map((i) => [String(i), `Notes ${lang} ${i + 1}`])) });
    }
    if (p === '/api/search' && m === 'POST') {
      return json({ results: [{ deck_id: 'deck-plain', deck_title: 'ai-ethics', slide_index: 1, slide_title: 'Bias', snippet: 'Bias and fairness', score: 0.9 }] });
    }
    if (p === '/api/qa' && m === 'POST') return json({ answer: 'Mocked answer', source_slides: [1] });
    if (p === '/api/agent/chat' && m === 'POST') return json({ reply: 'Mocked reply' });

    // Same-origin WebVTT of the public library (contracts §2.3): published items with captions only.
    const vttMatch = p.match(/^\/api\/(video|podcast)\/library\/([^/]+)\/captions\.vtt$/);
    if (vttMatch && m === 'GET') {
      const kind = vttMatch[1] as 'video' | 'podcast';
      const id = decodeURIComponent(vttMatch[2]);
      const failure = kind === 'video' ? api.detailFailures.video : api.detailFailures.podcast;
      if (failure) return failRoute(route, failure, 'Library item not found');
      const available = kind === 'video'
        ? videoList(catalog).some((v) => v.job_id === id && v.published && v.has_captions)
        : podcastCatalog(catalog).some((x) => isRecord(x) && x.job_id === id && x.published && podcastCaptionsUrl(x) !== null);
      if (!available) return json({ detail: 'Library item not found' }, 404);
      return route.fulfill({ status: 200, contentType: 'text/vtt; charset=utf-8', headers: { 'cache-control': 'public, max-age=600' }, body: VTT_BODY });
    }

    if (p === '/api/video/library' && m === 'GET') {
      if (api.delays.video) await sleep(api.delays.video);
      if (api.failures.video) return failRoute(route, api.failures.video, 'Library item not found');
      return json(videoList(catalog).map((v) => videoPayload(v, false)));
    }
    const videoMatch = p.match(/^\/api\/video\/library\/([^/]+)$/);
    if (videoMatch && m === 'GET') {
      if (api.detailFailures.video) return failRoute(route, api.detailFailures.video, 'Library item not found');
      const item = videoList(catalog).find((v) => v.job_id === decodeURIComponent(videoMatch[1]));
      return item ? json(videoPayload(item, true)) : json({ detail: 'Library item not found' }, 404);
    }
    if (p.startsWith('/api/podcast/')) {
      const payload = { publicAudio: opts.publicAudio, podcastV2: opts.podcastV2, catalog };
      if (p === '/api/podcast/library' && m === 'GET') {
        if (api.delays.podcast) await sleep(api.delays.podcast);
        if (api.failures.podcast) return failRoute(route, api.failures.podcast, 'Library item not found');
        return json(podcastLibraryList(role, payload));
      }
      const libMatch = p.match(/^\/api\/podcast\/library\/([^/]+)$/);
      if (libMatch && m === 'GET') {
        if (api.detailFailures.podcast) return failRoute(route, api.detailFailures.podcast, 'Library item not found');
        const item = podcastLibraryItem(decodeURIComponent(libMatch[1]), role, payload);
        return item ? json(item) : json({ detail: 'Library item not found' }, 404);
      }
      if (p === '/api/podcast/voices' && m === 'GET') {
        const lang = url.searchParams.get('language');
        return json(PODCAST_VOICES.filter((v) => !lang || v.language === lang));
      }
      const studio = p === '/api/podcast/ingest' || p === '/api/podcast/script/stream' || p === '/api/podcast/render'
        || p.startsWith('/api/podcast/jobs/');
      if (studio && !admin) return json({ detail: 'Sign-in required' }, 401);
      if (p === '/api/podcast/ingest' && m === 'POST') return json({ document: STUDIO_DOCUMENT });
      if (p === '/api/podcast/script/stream' && m === 'POST') {
        const events = STUDIO_TURNS.map((t) => `event: turn\ndata: ${JSON.stringify(t)}\n\n`).join('');
        return route.fulfill({
          status: 200, contentType: 'text/event-stream',
          body: `${events}event: done\ndata: ${JSON.stringify({ script_id: STUDIO_SCRIPT_ID })}\n\n`,
        });
      }
      if (p === '/api/podcast/render' && m === 'POST') {
        const body = JSON.parse(req.postData() || '{}') as Record<string, any>;
        api.renders.push(body);
        const job: MockJob = {
          id: `job-${String(jobs.size + 1).padStart(8, '0')}`, format: body.format === 'audio' ? 'audio' : 'video', body, step: -1,
        };
        jobs.set(job.id, job);
        return json(jobView(job, opts.jobWarnings ?? []));
      }
      const jobMatch = p.match(/^\/api\/podcast\/jobs\/([^/]+)(?:\/file\/([a-z0-9_]+))?$/);
      const job = jobMatch && m === 'GET' ? jobs.get(decodeURIComponent(jobMatch[1])) : undefined;
      if (jobMatch && m === 'GET' && !jobMatch[2]) {
        if (!job) return json({ detail: 'Job not found' }, 404);
        if ((opts.jobAdvance ?? 'poll') === 'poll') job.step += 1;
        return json(jobView(job, opts.jobWarnings ?? []));
      }
      if (jobMatch && m === 'GET') {
        const done = !!job && jobView(job, []).state === 'done';
        const kind = jobMatch[2];
        const video = job?.format === 'video';
        if (!job || !done) return json({ detail: 'File not found' }, 404);
        if (kind === 'transcript') return json(jobTranscript(job));
        if (kind === 'mp3') return fulfillMedia(route, MEDIA.mp3);
        if (kind === 'mp4' && video) return fulfillMedia(route, MEDIA.mp4);
        if (kind === 'cover') return route.fulfill({ status: 200, contentType: 'image/png', body: PNG_1PX });
        if (kind === 'audio_srt' || (kind === 'srt' && video)) {
          return route.fulfill({ status: 200, contentType: 'application/x-subrip', body: SRT });
        }
        if (kind === 'scorm') return route.fulfill({ status: 200, contentType: 'application/zip', body: EMPTY_ZIP });
        return json({ detail: 'File not found' }, 404);
      }
    }
    if (p === '/api/playlists' && m === 'GET') return json([PLAYLIST]);
    if (p === '/api/playlists/pl-1') {
      return json({ ...PLAYLIST, steps: [
        { order: 0, deck_id: 'deck-live', deck_title: 'ai-fundamentals', slide_count: 3, required: true },
        { order: 1, deck_id: 'deck-plain', deck_title: 'ai-ethics', slide_count: 3, required: true },
      ] });
    }
    if (p === '/api/playlists/pl-1/progress') {
      return json({ user_id: 'u', playlist_id: 'pl-1', last_deck_id: 'deck-live', last_slide_index: 0, resume_deck_id: 'deck-live',
        resume_slide_index: 0, completed_slides: {}, total_slides: 6, completed_count: 0, percent: 0, updated_at: '2026-10-14T00:00:00Z' });
    }
    if (p.endsWith('/languages')) return json([{ code: 'en-US', name: 'English' }, { code: 'fr-FR', name: 'Français' }]);
    if (m === 'GET') return json([]);
    return json({ detail: 'not mocked' }, 404);
  });
  return api;
}


// ── Fake Voice Live WebSocket (/ws/voice, /ws/voice/demo) ─────────────────
// Simulates the backend proxy: Voice Live response events (no WebRTC: the test
// drives the avatar data channel / audio levels through window.__ozRadioTest)
// plus the qa.* / context.* / demo.* messages of the raise-hand contract.

export interface VoiceMockOptions {
  /** Reply to qa.begin: ready (default), a qa.error code, or qa.unavailable. */
  qaBegin?: 'ready' | 'limit' | 'time_low' | 'unavailable';
  remainingQuestions?: number;
  /** Demo: `demo.started` payload. */
  demoRemainingMs?: number;
  narrationChars?: number[];
  /** Emit word timestamps (enables the fallback completion path). */
  wordTimestamps?: boolean;
  answer?: { text: string; source_slides: number[]; grounded: boolean };
  transcript?: string;
}

export interface VoiceMock {
  /** Every client → server JSON message, in order. */
  sent: any[];
  /** Assistant item ids (= avatar turn ids) of every spoken response, in order. */
  items: string[];
  url: string | null;
  send(msg: object): void;
  close(code: number, reason?: string): void;
  ofType(type: string): any[];
}

export async function mockVoice(page: Page, opts: VoiceMockOptions = {}): Promise<VoiceMock> {
  const mock: VoiceMock = {
    sent: [], items: [], url: null,
    send: () => {},
    close: () => {},
    ofType(type) { return this.sent.filter((m) => m?.type === type); },
  };
  let n = 0;
  await page.routeWebSocket(/\/ws\/voice/, (ws) => {
    mock.url = ws.url();
    const demo = ws.url().includes('/ws/voice/demo');
    const send = (m: object) => ws.send(JSON.stringify(m));
    mock.send = send;
    mock.close = (code, reason) => { void ws.close({ code, reason }); };
    let remaining = opts.remainingQuestions ?? 2;
    const speakTurn = (chars: number) => {
      n += 1;
      const rid = `resp_${n}`;
      const iid = `item_${n}`;
      mock.items.push(iid);
      send({ type: 'response.created', response: { id: rid } });
      send({ type: 'response.output_item.added', response_id: rid, item: { id: iid, role: 'assistant' } });
      if (opts.wordTimestamps) {
        send({ type: 'response.audio_timestamp.delta', response_id: rid, item_id: iid, audio_offset_ms: 0, audio_duration_ms: Math.max(300, chars * 20), text: 'w', timestamp_type: 'word' });
      }
      // Generation finishes long before playback — the client must not treat this as completion.
      send({ type: 'response.done', response: { id: rid, status: 'completed' } });
    };
    send({ type: 'proxy.connected', message: 'Connected to Azure Voice API' });
    if (demo) {
      send({
        type: 'demo.started', session_seconds: 300, remaining_ms: opts.demoRemainingMs ?? 300000,
        ...(opts.narrationChars ? { narration_chars: opts.narrationChars } : {}),
      });
    }
    ws.onMessage((data) => {
      let msg: any;
      try { msg = JSON.parse(String(data)); } catch { return; }
      mock.sent.push(msg);
      const rid = msg.request_id;
      switch (msg.type) {
        case 'session.update':
          send({ type: 'session.updated', session: { id: 'sess_1' } });
          break;
        case 'response.create':
          speakTurn(40);
          break;
        case 'demo.speak':
          send({ type: 'demo.speaking', slide: msg.slide, chars: 130, remaining: 9, remaining_ms: opts.demoRemainingMs ?? 290000 });
          speakTurn(130);
          break;
        case 'context.switch':
          send({ type: 'context.switched', deck_id: msg.deck_id, slide_count: 3 });
          break;
        case 'qa.begin':
          if (opts.qaBegin === 'unavailable') { send({ type: 'qa.unavailable', reason: 'no_deck' }); break; }
          if (opts.qaBegin === 'limit' || opts.qaBegin === 'time_low') {
            send({ type: 'qa.error', request_id: rid, code: opts.qaBegin, message: opts.qaBegin === 'limit' ? 'No more questions in this demo.' : 'Not enough time left for a question.' });
            break;
          }
          remaining -= 1;
          send({ type: 'qa.ready', request_id: rid, max_audio_ms: 15000, max_audio_bytes: 480000, remaining_questions: remaining, ...(demo ? { remaining_ms: 200000 } : {}) });
          speakTurn(25);
          break;
        case 'qa.commit':
        case 'qa.text': {
          const text = msg.type === 'qa.text' ? msg.text : (opts.transcript ?? 'What drives the results?');
          send({ type: 'qa.transcript', request_id: rid, text });
          const a = opts.answer ?? { text: 'The deck says growth comes from new markets.', source_slides: [1], grounded: true };
          send({ type: 'qa.answer', request_id: rid, ...a });
          speakTurn(a.text.length);
          break;
        }
        default:
          break;
      }
    });
  });
  return mock;
}

/** Test hook helpers (window.__ozRadioTest is only installed by the Vite dev build). */
export const avatar = {
  async connected(page: Page) {
    await page.waitForFunction(() => !!(window as any).__ozRadioTest);
    await page.evaluate(() => (window as any).__ozRadioTest.mediaConnected());
  },
  /** Plays a turn to its end: speech heard, TURN_START/TURN_END on the data channel, then silence. */
  async finishTurn(page: Page, itemId: string) {
    await page.evaluate((id) => {
      const t = (window as any).__ozRadioTest;
      t.dataChannel({ event: { eventType: 'EVENT_TYPE_TURN_START', turnID: id } });
      t.audioLevel(-20);
      t.dataChannel({ event: { eventType: 'EVENT_TYPE_TURN_END', turnID: id } });
      t.audioLevel(-90);
    }, itemId);
  },
  async startTurn(page: Page, itemId: string) {
    await page.evaluate((id) => {
      const t = (window as any).__ozRadioTest;
      t.dataChannel({ event: { eventType: 'EVENT_TYPE_TURN_START', turnID: id } });
      t.audioLevel(-20);
    }, itemId);
  },
};

/**
 * Playwright's WebKit on Windows fetches <audio>/<video> media through Media Foundation, outside the
 * page's network stack: `page.route` media mocks never apply there (the dev server answers with
 * index.html), so specs that need mocked playback skip on that platform only. WebKit on macOS/Linux,
 * Chromium and real devices still run them. Use at describe level:
 * `test.skip(mockedMediaUnavailable, MOCKED_MEDIA_REASON)`, or in a test with its `browserName`.
 */
export const MOCKED_MEDIA_REASON = 'Playwright WebKit on Windows loads media outside page.route: mocked playback cannot run';
export const mockedMediaUnavailable = ({ browserName }: { browserName: string }): boolean =>
  browserName === 'webkit' && process.platform === 'win32';

// ── Boot block (contracts §3) ─────────────────────────────────────────────
// The server replaces `<!--OZ_BOOT-->` in index.html with a JSON <script id="oz-boot">. `mockBoot` does the same to the
// HTML document the Vite dev server returns, so a spec can show the app what production will show it.

export interface BootOverrides {
  ok?: boolean;
  demo?: { enabled?: boolean; session_seconds?: number; qa?: { enabled?: boolean; max_questions?: number }; remaining_today?: number | null };
  live_demo_decks?: BootLiveDeck[];
  telemetry?: { enabled: boolean };
}

/** The `mockApi` options a boot block should agree with (pass the same object to both). */
export type BootSource = Pick<MockApiOptions, 'catalog' | 'demoEnabled' | 'demoQa' | 'demoSessionSeconds' | 'demoRemainingToday'>;

/** The live-demo decks of a catalog, as the server lists them in the boot block. */
export function liveDemoDecks(catalog: Catalog = 'default'): BootLiveDeck[] {
  return deckList(catalog)
    .filter((d) => d.published && d.live_demo)
    .map((d) => ({ deck_id: d.deck_id, language: d.language, title: d.title }));
}

/**
 * The boot payload the server would send. With no `from` it mirrors the default `mockApi` (demo on, 180 s, Q&A off,
 * `remaining_today` unknown); pass the options given to `mockApi` to keep both consistent. `overrides` wins.
 */
export function bootPayload(overrides: BootOverrides = {}, from: BootSource = {}): BootPayload {
  const enabled = from.demoEnabled ?? true;
  const base: BootPayload = {
    v: 1,
    ok: true,
    demo: {
      enabled,
      session_seconds: from.demoSessionSeconds ?? 180,
      qa: { enabled: enabled && from.demoQa?.enabled === true, max_questions: from.demoQa?.max_questions ?? 0 },
      remaining_today: enabled && typeof from.demoRemainingToday === 'number' ? from.demoRemainingToday : null,
    },
    live_demo_decks: enabled ? liveDemoDecks(from.catalog ?? 'default') : [],
    telemetry: { enabled: false },
  };
  return {
    ...base,
    ok: overrides.ok ?? base.ok,
    demo: {
      ...base.demo,
      ...overrides.demo,
      qa: { ...base.demo.qa, ...overrides.demo?.qa },
    } as BootPayload['demo'],
    live_demo_decks: overrides.live_demo_decks ?? base.live_demo_decks,
    telemetry: overrides.telemetry ?? base.telemetry,
  };
}

/** JSON that is safe inside a <script> element: no raw `<`, `>`, `&`, U+2028 or U+2029 (contracts §3.4). */
export function escapeBootJson(json: string): string {
  return json
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** The element the server injects for `payload`. */
export function bootScriptTag(payload: unknown): string {
  return `<script type="application/json" id="${BOOT_ELEMENT_ID}">${escapeBootJson(JSON.stringify(payload))}</script>`;
}

/** An element with a hand-written body (malformed-JSON tests). */
export function rawBootScriptTag(raw: string): string {
  return `<script type="application/json" id="${BOOT_ELEMENT_ID}">${raw}</script>`;
}

/**
 * What the server does with index.html (contracts §3): replaces the `<!--OZ_BOOT-->` marker with `tag`. A document
 * WITHOUT the marker comes back unchanged (the server does not guess a position; the client then takes the fallback
 * path), and so does any document when `tag` is `null` (no block). `markerCount` is the number of markers in `html`
 * (contracts §3.2: exactly one); only the first one is replaced.
 */
export function injectBootIntoHtml(html: string, tag: string | null): { html: string; markerSeen: boolean; markerCount: number } {
  const markerCount = html.split(BOOT_MARKER).length - 1;
  const markerSeen = markerCount > 0;
  if (!markerSeen || tag === null) return { html, markerSeen, markerCount };
  return { html: html.replace(BOOT_MARKER, () => tag), markerSeen, markerCount };
}

export type BootMode = 'absent' | 'fallback' | BootPayload | BootOverrides | { raw: string };

export interface BootMock {
  /** HTML documents the route has served (rewritten or not). */
  documents: number;
  /** Whether the last document carried the `<!--OZ_BOOT-->` marker. */
  markerSeen: boolean;
  /** How many markers the last document carried (the built index.html must have exactly one). */
  markerCount: number;
  /** The element injected into the last document (null = none). */
  lastTag: string | null;
}

/** Navigation-like paths: no file extension, not an API, socket or dev-server asset. */
const isNavigationPath = (url: URL) => !/\.[a-z0-9]{1,8}$/i.test(url.pathname) && !/^\/(api|ws|src|node_modules|@)/.test(url.pathname);
/** Documents the server injects into: client routes (`/`, `/decks/…`) and an explicit `/index.html`. */
const isDocumentPath = (url: URL) => url.pathname === '/index.html' || isNavigationPath(url);

/**
 * Rewrites the HTML document the way the server will (only `resourceType() === 'document'` GETs of `isDocumentPath`
 * URLs are touched; everything else `route.fallback()`s). The marker is the ONLY insertion point: a document without
 * `<!--OZ_BOOT-->` is served unchanged and recorded (`markerSeen: false`).
 *   - `{}` / overrides / a full payload → the block the server would send (`bootPayload(overrides, from)`);
 *   - `'fallback'`  → the fail-closed block (`ok:false`, demo off, no decks);
 *   - `'absent'`    → the document is served unchanged: no `#oz-boot` element (the marker stays a harmless comment);
 *   - `{ raw }`     → an element with that exact body.
 * Call it before or after `mockApi`: it never touches `/api`, `/media` or the dev server's modules.
 */
export async function mockBoot(page: Page, boot: BootMode = {}, from: BootSource = {}): Promise<BootMock> {
  const state: BootMock = { documents: 0, markerSeen: false, markerCount: 0, lastTag: null };
  const tag = ((): string | null => {
    if (boot === 'absent') return null;
    if (boot === 'fallback') return bootScriptTag(BOOT_FAIL_CLOSED);
    if ('raw' in boot) return rawBootScriptTag(boot.raw);
    if ('v' in boot) return bootScriptTag(boot);
    return bootScriptTag(bootPayload(boot, from));
  })();
  await page.route(isDocumentPath, async (route) => {
    const req = route.request();
    if (req.resourceType() !== 'document' || req.method() !== 'GET') return route.fallback();
    const response = await route.fetch();
    const injected = injectBootIntoHtml(await response.text(), tag);
    state.documents += 1;
    state.markerSeen = injected.markerSeen;
    state.markerCount = injected.markerCount;
    state.lastTag = injected.markerSeen ? tag : null;
    const headers = { ...response.headers() };
    for (const name of ['content-length', 'content-encoding', 'transfer-encoding']) delete headers[name];
    return route.fulfill({ status: response.status(), headers, contentType: 'text/html; charset=utf-8', body: injected.html });
  });
  return state;
}

/** Text content of the page's `#oz-boot` element (null when there is none). */
export const readBootText = (page: Page) =>
  page.evaluate((id) => document.getElementById(id)?.textContent ?? null, BOOT_ELEMENT_ID);
