import type { Page, Route } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const AVATAR_DIR = path.join(__dirname, '..', '..', 'demos', 'backend', 'static', 'avatars');

// Shared /api mocks for the regression + screenshot specs (deterministic, no Azure).
export type Role = 'visitor' | 'admin';

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

export const DECKS = [
  { deck_id: 'deck-live', title: 'ai-fundamentals', slide_count: 3, language: 'en-US', uploaded_at: '2026-10-14T21:51:41Z', tags: [], published: true, live_demo: true },
  { deck_id: 'deck-plain', title: 'ai-ethics', slide_count: 3, language: 'en-US', uploaded_at: '2026-10-14T21:51:46Z', tags: [], published: true, live_demo: false },
];

// Cached FR translations of the speaker notes (admin payload only, like the backend).
export const FR_NOTES = ['Notes FR 1', 'Notes FR 2', 'Notes FR 3'];

const deckDetail = (id: string, admin: boolean) => {
  const d = DECKS.find((x) => x.deck_id === id) ?? DECKS[0];
  return {
    ...d,
    id: d.deck_id,
    filename: `${d.title}.pptx`,
    // Anonymous payload mirrors routers/decks.py PublicSlidePayload: no body, notes or translations.
    slides: [0, 1, 2].map((i) => (admin
      ? { index: i, title: `Slide title ${i + 1}`, body: `Body ${i + 1}`, notes: `Notes ${i + 1}`, translated_notes: { 'fr-FR': FR_NOTES[i] } }
      : { index: i, title: `Slide title ${i + 1}` })),
  };
};

const AVATARS = [
  { id: 'photo_female', display_name: 'Sofia', gender: 'female', thumbnail_url: '/static/avatars/photo_female.png', is_default: true },
  { id: 'photo_male', display_name: 'Lucas', gender: 'male', thumbnail_url: '/static/avatars/photo_male.png', is_default: false },
  { id: 'lisa', display_name: 'Lisa', gender: 'female', thumbnail_url: '', is_default: false },
];

const VIDEO_ITEM = {
  job_id: 'vid-1', title: 'context-engineering-rag', language: 'en-US', created_at: '2026-10-15T00:05:00Z',
  thumbnail_url: null, duration_sec: 98, slide_count: 6, published: true,
};
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

/** `_public_item`: list rows carry no media URLs; the detail mints them. */
function publicItem(item: PodcastRecord, publicAudio: boolean, detail: boolean) {
  const hasAudio = publicAudio && item.has_audio;
  const videoUrl = detail && item.has_video ? item.mp4_url : null;
  const audioUrl = detail && hasAudio ? item.mp3_url : null;
  return {
    job_id: item.job_id, title: item.title, created_at: item.created_at, duration_sec: item.duration_sec,
    audio_duration_sec: hasAudio ? item.audio_duration_sec : null, language: item.language, format: item.format,
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
  /** Include the v2 (radio) episodes; off = the legacy item only. */
  podcastV2?: boolean;
}

const visibleTo = (role: Role, item: PodcastRecord, publicAudio: boolean) =>
  role === 'admin' || (item.published && (item.has_video || (publicAudio && item.has_audio)));

/** A library JSON payload (shape depends on the item version and the caller's role). */
export type PodcastPayload = Record<string, any>;

/** GET /api/podcast/library as `role` would receive it. */
export function podcastLibraryList(role: Role, opts: PodcastPayloadOptions = {}): PodcastPayload[] {
  const publicAudio = opts.publicAudio ?? true;
  if (!opts.podcastV2) return [PODCAST_ITEM];
  return PODCASTS_V2.flatMap((item): PodcastPayload[] => {
    if (!isRecord(item)) return [item];
    if (!visibleTo(role, item, publicAudio)) return [];
    return [role === 'admin' ? adminSummary(item) : publicItem(item, publicAudio, false)];
  });
}

/** GET /api/podcast/library/{id} as `role` would receive it (null = 404). */
export function podcastLibraryItem(id: string, role: Role, opts: PodcastPayloadOptions = {}): PodcastPayload | null {
  const publicAudio = opts.publicAudio ?? true;
  if (id === PODCAST_ITEM.job_id) return legacyDetail();
  if (!opts.podcastV2) return null;
  const item = PODCASTS_V2.find((x): x is PodcastRecord => isRecord(x) && x.job_id === id);
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

export interface MockApiOptions extends PodcastPayloadOptions {
  /** `qa` block of `/api/demo/config` (omitted → demo Q&A disabled, like the default server). */
  demoQa?: { enabled: boolean; max_questions: number; max_audio_seconds: number };
  demoSessionSeconds?: number;
  /** Podcast render jobs advance one step per poll (default) or only on `advanceJobs()`. */
  jobAdvance?: 'poll' | 'manual';
  /** Warning codes reported by finished render jobs. */
  jobWarnings?: string[];
}

export interface MockApi {
  /** JSON bodies of POST /api/podcast/render, in order. */
  renders: Record<string, any>[];
  /** Moves every render job one step forward (`jobAdvance: 'manual'`). */
  advanceJobs(): void;
}

export async function mockApi(page: Page, role: Role, opts: MockApiOptions = {}): Promise<MockApi> {
  calls.length = 0;
  const jobs = new Map<string, MockJob>();
  const api: MockApi = {
    renders: [],
    advanceJobs: () => { for (const job of jobs.values()) job.step += 1; },
  };
  const videoPaths = new Set([POD_VIDEO.mp4_url]);
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

    if (p === '/api/me') return json({ authenticated: admin, is_admin: admin, name: admin ? 'Admin User' : null, auth_mode: 'easyauth' });
    if (p === '/api/demo/config') {
      return json({ enabled: true, session_seconds: opts.demoSessionSeconds ?? 180, ...(opts.demoQa ? { qa: opts.demoQa } : {}) });
    }
    if (p === '/api/avatars') return json(AVATARS);
    if (p === '/api/decks' && m === 'GET') return json(DECKS);
    if (p === '/api/decks/upload' && m === 'POST') return admin ? json({ deck_id: 'deck-new', title: 'new', slide_count: 1 }) : json({ detail: 'forbidden' }, 403);
    const deckMatch = p.match(/^\/api\/decks\/([^/]+)$/);
    if (deckMatch && m === 'GET') return json(deckDetail(deckMatch[1], admin));
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
    if (p === '/api/video/library') return json([VIDEO_ITEM]);
    if (p === '/api/video/library/vid-1') return json({ ...VIDEO_ITEM, video_url: '/media/vid-1.mp4' });
    if (p.startsWith('/api/podcast/')) {
      const payload = { publicAudio: opts.publicAudio, podcastV2: opts.podcastV2 };
      if (p === '/api/podcast/library' && m === 'GET') return json(podcastLibraryList(role, payload));
      const libMatch = p.match(/^\/api\/podcast\/library\/([^/]+)$/);
      if (libMatch && m === 'GET') {
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
