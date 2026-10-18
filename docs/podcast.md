# Podcast — Two-Host Podcast (Video + Radio) — Design

**Status:** Implemented PoC — demo-quality, with Blob-backed media library

> **Demo-quality PoC, not production.** This doc has been re-scoped away from production robustness (workers, idempotent manifests, global semaphores, chunk-reduce) toward **demo polish**: split-screen layout with live speaker highlight, scrolling subtitles under each avatar, waveform pulse, premium HD voices, branded intro/outro, sample prompt gallery, streaming script generation. The goal is a convincing end-to-end demo.
**Scope:** podcast-style conversation from any document, rendered as a two-avatar video with a dedicated radio (audio-only) mix, or as audio only
**Inspiration:** NotebookLM "Audio Overview"

---

## 1. Goals & Non-Goals

### Goals
- Upload documents (PPTX, PDF, DOCX, TXT, URL) + optional instructions → get a **podcast-style conversation** between two AI hosts, in the **format** picked at render time:
  - **`video`** (*Video + audio*) — the two-avatar video **and** the radio mix; the library offers **Watch** and **Listen** side by side;
  - **`audio`** (*Audio only*) — the radio mix only: DragonHD text-to-speech, no avatar synthesis, so it is faster and far cheaper (§7).
- Deliverables per job: the radio **MP3** (ID3 tags + cover art), **`transcript.json`** (radio-timed captions, host turns, waveform peaks), **`cover.jpg`**, a radio-timed **SRT**, and a **SCORM ZIP** for LMS upload (radio MP3 + radio SRT). The video format adds the dual-avatar **MP4** and its video-timed **SRT**.
- The host who is not speaking looks **alive and listening** (a cached silent "listening" loop of its avatar, in full colour) and can react with audible, lip-synced **backchannels** ("Mm-hmm.", "Right.", "Exactly.") in both formats.
- Synthesize each turn with its own batch avatar job (talking clips), run concurrently within the Speech job-creation quota. The listener and the radio layers degrade to fallbacks with a warning code; they never fail a render.
- Reuse the shared deployment (one resource group, one `azd up`) for easy teardown.
- Ship as a second page (`/podcast`) in the existing React app, sharing the backend and auth of the deck and video features.

### Non-Goals (first release)
- Real-time (streaming) dual-avatar conversations.
- A shipped music bed: the video compose and the radio mix duck a licensed file under the voices when one is provided (`demos/backend/data/music/background.mp3`); none ships.
- Custom (trained) avatars — custom *photo* avatars are supported (`CUSTOM_AVATARS_JSON`).
- Mixing languages within a single podcast.
- Multi-talker voices (DragonHD multi-talker is preview, en-US only and not offered in the showcase Speech region), chapters, per-rendition publish flags, a mini player.
- Teams embedding — reuse manifest later if needed.

---

## 2. User Flow

The studio is a five-step wizard: **Source → Script → Review & cast → Render → Listen**.

1. User navigates to `/podcast`.
2. **Source:** uploads one or more documents (drag/drop) and/or pastes a URL.
3. (Optional) Enters instructions: topic focus, conversation style (casual/formal/debate), **audience level** (Any / Beginner / Practitioner / Expert — see §3.2.1), target length (short ~3 min / medium ~6 min / long ~10 min), target language, number of turns.
4. **Script:** clicks **Generate script** → the two-host dialogue streams in turn by turn, with speaker labels (and, when *Listener reactions* is on, a chip for each backchannel the script asks for). **Back to setup** changes the instructions and generates again.
5. **Review & cast:** picks the format — **Video + audio** or **Audio only** — reviews the script, names the two hosts and picks their voices and avatars (for *Audio only* the avatar becomes an optional **portrait**), sets the options **Background music** (only used when a licensed bed file is installed), **Intro & outro** and **Listener reactions**, and clicks **Render podcast**.
6. **Render:** the backend starts the job and the UI polls stage-level progress (video: rendering 3/8 → composing → mixing → done; audio: synthesizing 3/8 → mixing → done).
7. **Listen:** the result view shows the same Watch / Listen player as the library, the transcript and the downloads the format produced (MP4, MP3, SRT, radio SRT, transcript, cover, SCORM), plus any warning. The episode is saved to the library unpublished.
8. In the library (`/podcast/library`), each episode shows **Watch** and **Listen** side by side (audio-only episodes: **Listen** and an *Audio only* chip). The player opens with Watch | Listen tabs that keep the position (mapped turn by turn) and play one medium at a time; `?episode=<id>&mode=watch|listen` deep-links to it.

---

## 3. Backend Architecture

### 3.1 Router: `demos/backend/routers/podcast.py`

```
POST   /api/podcast/ingest                     → Ingest docs, return document_id + extracted text
POST   /api/podcast/script/stream              → Stream the generated dialogue (SSE) from document_id + options
GET    /api/podcast/scripts/{script_id}        → Saved script
PATCH  /api/podcast/scripts/{script_id}        → Save edited script
POST   /api/podcast/render                     → Start render job: script_id + roles + layout/music/intro + format + reactions
GET    /api/podcast/jobs/{job_id}              → Job status (stage, outputs, warning codes)
GET    /api/podcast/jobs                       → List recent jobs
GET    /api/podcast/jobs/{job_id}/file/{kind}  → mp4 | mp3 | srt | audio_srt | transcript | cover | scorm (local files)
GET    /api/podcast/library                    → Library (admin: every item; anonymous: published items, public DTO)
GET    /api/podcast/library/{job_id}           → Item with fresh SAS URLs + inline transcript (anonymous: see §6.1)
POST   /api/podcast/library/{job_id}/publish   → Publish / unpublish (one flag for every rendition)
DELETE /api/podcast/library/{job_id}           → Delete published item
GET    /api/podcast/voices                     → Available voices per language (subset of the live presenter list)
GET    /api/podcast/avatars                    → Available avatars (stock and custom photo avatars)
```

`RenderRequest` adds `format` (`"video"` default, or `"audio"`) and `reactions` (default `true`; effective only when `PODCAST_REACTIONS=true`, see §3.9). A `video` render needs a known avatar for both hosts; for `audio` the avatar is optional (it only supplies the portrait on the cover and in the player, else a monogram). The job file route answers **404** for a kind the format did not produce (no `mp4`/`srt` for audio-only jobs).

### 3.2 New services

| Module | Responsibility |
|---|---|
| `services/podcast_ingest.py` | Multi-format parsing: PPTX (reuse `pptx_parser`), PDF (`pypdf`), DOCX (`python-docx`), TXT/MD (plain), URL (`httpx` + `readability-lxml`). Returns normalized `Document`. |
| `services/podcast_script.py` | GPT-4.1 structured output. Prompt builds context from `Document`, respects style / length / language, asks for radio-safe wording (no visual references) and optional per-turn backchannel hints. Returns `Script` (list of `DialogueTurn`). |
| `services/podcast_models.py` · `podcast_media.py` | HTTP/JSON contracts (render request, job, transcript, library DTOs) · internal engine contracts (turn audio, listener kits, reaction placements, radio result, library files), stable warning codes and the `PODCAST_*` env flags. |
| `services/speech_rest.py` | Shared Speech REST plumbing: Entra token → custom-domain STS token (cached), resource-key fallback, one bounded retry policy (401 refresh once, 429 `Retry-After`, jittered backoff on 408/5xx, cooperative deadlines). Never logs tokens, bodies or SAS query strings. |
| `services/podcast_render.py` | Batch avatar synthesis, **one job per turn** (the multi-input output shape of API 2024-08-01 proved unstable), run concurrently: admission `MAX_ACTIVE_BATCH_JOBS`, process-wide creation pacing `SPEECH_BATCH_CREATE_PER_MIN` (the service answers 429 beyond ≈ 2 creations per rolling minute), poll, download. Also builds the listener-kit jobs. |
| `services/podcast_tts.py` | DragonHD TTS REST per turn (24 kHz PCM WAV, same voices and SSML as the avatar path, bounded parallelism) for the radio mix and audio-only renders — zero avatar calls; backchannel audio cached per voice. |
| `services/podcast_listener.py` | Cached **listener kits** per (avatar, voice, language): silent idle loop + lip-synced backchannel clips (§3.8). Never raises. |
| `services/podcast_reactions.py` | Backchannel planning on the script text (speaker pauses) and placement in the measured pauses (§3.9). |
| `services/podcast_compose.py` | ffmpeg composition. **Split-screen layout** (see §3.5): both avatars as head-and-shoulders tiles across the top, karaoke captions + speaker labels between them, the current slide below in true 16:9 (contained, never stretched). Per-turn segments are rendered then concatenated; the listener tile is animated, backchannels are overlaid; applies `loudnorm`, probes actual durations with `ffprobe` to build SRT. Emits MP4 + soundtrack MP3 (radio fallback) + SRT + `ComposeTimeline`. |
| `services/podcast_radio.py` · `podcast_cover.py` · `podcast_jingle.py` | The radio mix (§3.7) · 1400×1400 cover art · the procedural Oz Radio sonic logo (intro/outro of both renditions). |
| `services/podcast_library.py` | Blob-backed library: uploads the renditions, writes the v2 manifest last, mints SAS URLs, applies the public audio policy (§3.11, §6.1). |

#### 3.2.1 Audience level

`ScriptRequest.audience_level` (optional: `"beginner" | "practitioner" | "expert"`, default `null`) tunes vocabulary and depth of the dialogue. It is composed with style, focus and language in `_build_system_prompt` as one extra `Audience:` line and never changes the turn / `slide_idx` / output-format rules. Unknown values are rejected with **422**.

| Level | Directive added to the system prompt |
|---|---|
| *Any (default)* → `null` | nothing — no `Audience:` line; the prompt stays byte-for-byte the SHA-pinned baseline (`tests/test_audience_level.py`, re-pinned once when the radio-safe directive and the reaction hints were added) |
| `beginner` | assume no prior AI/technical knowledge; define every term in plain words; everyday analogies; avoid jargon and acronyms (expand if unavoidable); one idea at a time |
| `practitioner` | audience builds or operates solutions; concrete how-to, trade-offs, practical tips, common pitfalls; standard terminology OK |
| `expert` | deep technical audience; architecture, internals, limits, failure modes, evaluation; precise vocabulary; stay strictly within the source — never invent numbers or details |

The level is stored on the saved `Script` (`GET /api/podcast/scripts/{id}`), written to the library `manifest.json` (`audience_level`) and returned by the admin `GET /api/podcast/library` + `/library/{job_id}` responses — the library shows it as a small "*Level* audience" chip. The anonymous public DTO does not carry it. In the UI, the **Audience level** select sits next to **Style** in *Conversation settings*.

### 3.3 Data model — Cosmos DB `podcasts` database (original design)

> The PoC keeps documents, scripts and jobs **in memory** (`routers/podcast.py`) and persists finished episodes in the Blob library (§3.11). The Cosmos model below is the original production design, kept for reference.

**Three containers, partitioned by `/userId`** (matches access patterns: a user lists their own docs/scripts/jobs). `scriptId` / `documentId` are indexed non-partition fields.

```jsonc
// container "documents"  (PK /userId)
{ "id": "doc-…", "userId": "alice", "sources": [{"kind": "pdf", "name": "…", "blobUrl": "…"}],
  "content": { "title": "…", "sections": [{"heading": "…", "text": "…"}] },
  "tokenCount": 18420, "createdAt": "…" }

// container "scripts"    (PK /userId)
{ "id": "scr-…", "userId": "alice", "documentId": "doc-…",
  "language": "en-US", "style": "casual", "targetDurationSec": 360,
  "turns": [ {"idx": 0, "speaker": "interviewer", "text": "…"}, … ],
  "createdAt": "…", "updatedAt": "…" }

// container "jobs"       (PK /userId)
{ "id": "job-…", "userId": "alice", "scriptId": "scr-…",
  // job config is snapshotted from the script at job creation time (immutable)
  "scriptSnapshot": { /* full turns + roles + layout */ },
  "roles": {
    "interviewer": { "avatar": "harry", "voice": "en-US-Andrew:DragonHDLatestNeural" },
    "expert":      { "avatar": "lisa",  "voice": "en-US-Ava:DragonHDLatestNeural" }
  },
  "layout": "split_screen_with_slides",   // or "split_screen_only" (no slide)
  "state":  "queued|rendering|composing|done|failed|cancelled",
  "progress": { "stage": "rendering", "completed": 3, "total": 8 },
  // per-clip manifest — the source of truth for idempotent retry & resume
  "clips": [
    { "turnIdx": 0, "speaker": "interviewer",
      "remoteJobId": "…", "attempt": 1,
      "status": "queued|submitted|succeeded|failed",
      "blobUrl": "…", "durationSec": 7.23, "checksum": "sha256:…" }
  ],
  // per-speaker remote batch job ids (one job per (avatar, voice) pair)
  "remoteBatchJobs": {
    "interviewer": { "id": "…", "status": "…", "inputsCount": 4 },
    "expert":      { "id": "…", "status": "…", "inputsCount": 4 }
  },
   "outputs": { "mp4Blob": "…", "mp3Blob": "…", "srtBlob": "…", "scormBlob": "…" },
  "error": null, "cancelRequested": false,
  "createdAt": "…", "updatedAt": "…" }
```

Indexing: default indexing on the three containers is fine. Add composite indexes on `(userId ASC, createdAt DESC)` for listings.

### 3.4 Job state machine & idempotency (original design)

> Implemented today: in-memory jobs with the states below, stage-level progress per format (§3.6), the global queue limit `MAX_PENDING_RENDERS` and one batch avatar job per turn. The per-speaker batch jobs, Cosmos lease and resumable worker described here are the original design.

Ingest and scripting are synchronous endpoints (no long-running state). The **job** covers only rendering + composition:

```
queued → rendering → composing → done
             ↘            ↘
              ↘→  failed  ←↗
    cancelled (set cancelRequested=true; worker transitions to cancelled at next checkpoint)
```

**Worker loop (idempotent / resumable):**

1. **Load job.** If `state ∈ {done, failed, cancelled}` → return.
2. **Honor cancellation.** If `cancelRequested`: best-effort DELETE any live remote batch jobs, set `state=cancelled`, return.
3. **Per-speaker batch submission.** For each speaker in `roles`:
   - If `remoteBatchJobs[speaker].id` is already set and remote status ∈ {Running, Succeeded} → reuse.
   - Otherwise submit one batch avatar synthesis job with one SSML input per turn belonging to that speaker, ordered by `turnIdx`. Persist `remoteJobId` per clip.
4. **Poll until both speakers complete.** Update each clip's `status`, `blobUrl`, `durationSec` as outputs become available. Failed individual inputs → retry that batch job with only the failed inputs (attempt+1). Second failure → mark clip `failed` → job `failed`.
5. **Download clips to our blob.** Idempotent by `checksum`; skip if already present.
6. **Compose.** Skip if `outputs.mp4Blob` already set and checksum matches clip manifest hash (i.e., restart after crash during upload is safe). Run ffmpeg: concat per `turnIdx` order, apply `loudnorm`, probe durations with `ffprobe`, emit MP4 + MP3 + SRT.
7. **Mark `done`.**

**Global render queue:** a single semaphore (implemented as a Cosmos lease doc) caps the number of concurrently rendering jobs across the worker fleet (starting value: 3). New jobs beyond the cap stay in `queued`.

Ingestion + scripting are synchronous REST endpoints (no job row); if their outputs take longer than the request budget we move them to the same worker pattern later.

### 3.5 Composition algorithm — video layout (geometry contract v2)

Output is 1920x1080 @ 25 fps. Each turn is rendered as its own segment (slide still + the active speaker's clip + the listener's tile, see *Live listener* below), then the segments are concatenated with the concat *filter* (full re-encode, no AAC clicks). The AI still chooses `slide_idx` per turn.

**`split_screen_with_slides` (default)**

| Zone | Rect (x, y, w, h) | Content |
|---|---|---|
| Interviewer tile | 0, 0, 560, 360 | head-and-shoulders crop on a `#16213A` panel; active = live clip in a 4 px clay (`#B8461E`) frame with a soft inner glow; listener = **full colour, never dimmed**, inside a subtle 2 px neutral (`#475569`) border |
| Expert tile | 1360, 0, 560, 360 | same for the expert |
| Label zone | 560, 0, 800, 96 | "Name / Role" next to each tile, in the **same font sizes for both hosts** (name 28 px, role 20 px) so nothing jumps between turns; colour and a clay accent bar mark the active speaker |
| Caption zone | 560, 96, 800, 264 | karaoke captions (ASS `\k`), `\an5\pos(960,228)`, wrapped with `\N` to ≤ 40 chars (≈ 760 px) and ≤ 3 lines per event; MarginL/R = 580 so text never leaves the zone |
| Slide | 320, 360, 1280, 720 | `scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2` — never stretched or cropped (4:3 / portrait slides are pillar-boxed) |
| Gutters | 0..320 and 1600..1920 below the tiles | background `#0B1220`; "n / N" slide counter in the right gutter |

**`split_screen_only`** — two 960x900 tiles at (0,0) and (960,0), "Name · Role" labels at y 900..960 (same size for both), captions (≤ 2 lines) at y 960..1080.

v1 → v2: the listener is no longer a first-frame still dimmed to ~55 % (grey reads as "camera off"); labels keep one size; turns open with a dissolve; title cards carry the sonic logo.

**Avatar framing.** Per tile: `chromakey/despill` (only if *that* speaker's clip is a green-screen photo avatar) → `crop` (normalized rect, even pixels) → `scale` to the tile (decrease) → `pad` (bottom-aligned, transparent) → `format=yuva420p` → `overlay`. The chroma flag is resolved per speaker from its own clips, so the listener never inherits the active clip's flag. VP9 WebM clips are decoded with `libvpx-vp9` so their alpha channel survives. The crop rect comes from `avatar_registry` (`AvatarEntry.podcast_crop`, normalized `[x, y, w, h]`; custom avatars may set `"podcast_crop"` in `CUSTOM_AVATARS_JSON`) with kind fallbacks: prebuilt 16:9 avatars `(0.31, 0.02, 0.38, 0.43)`, photo avatars `(0.06, 0.0, 0.88, 1.0)`; Lisa is tuned to `(0.355, 0.05, 0.306, 0.35)`.

**Live listener.** What fills the listener's tile, best first (the lower-fidelity mode of the two hosts is recorded as the job's `listener_mode`):

1. `idle_loop` — the listener kit's silent "listening" loop (§3.8), looped with `-stream_loop` and trimmed from an offset chosen by pose matching against the listener's neighbouring frames (fallback: a per-host running cursor from a job-seeded offset). Its audio is never mapped.
2. `procedural` — the still with a subtle "breathing" sway: ≤ 0.8 % zoom anchored at the bottom centre (no point moves more than 2 px), a ~5.6 s sine, rendered on a ×4 supersampled frame so it never jitters.
3. `still` — the plain still (an early frame of the listener's own clip, never its talking footage).
4. no tile — the listener has no clip at all.

`PODCAST_LISTENER_MODE=still|procedural` caps the choice. A segment that fails to render is retried with the plain still, then with the plain still and no reaction or dissolve; once the listener source has failed, the rest of the episode uses the still (`listener_fallback`).

**Backchannels.** A placed reaction (§3.9) overlays the listener's lip-synced clip on its tile with 100 ms alpha fades, and its audio is mixed under the speaker.

**Transitions.** Every segment but the first opens with a **160 ms whole-frame dissolve** from the previous segment's last frame, inside the talking clip's 250 ms silent lead (never across speech), without changing the segment length.

**Slides.** PPTX slides are rendered with the same LibreOffice binary as Decks (`LIBREOFFICE_PATH`, passed through `ingest_file`); `Document.slide_images` stays index-aligned with the slides and a missing image falls back to a 1280x720 title card (a warning is logged). Intro/outro cards stay full-frame and, with **Intro & outro** on, carry the Oz Radio sonic logo (`podcast_jingle`, the same motif as the radio mix).

- **MP3 output:** the episode MP3 is the radio mix (§3.7). `ffmpeg -i final.mp4 -vn -acodec libmp3lame -q:a 2 final.mp3` (the video soundtrack) is only the fallback when the radio mix fails (`audio_kind: "soundtrack"`, warning `radio_fallback`).
- **SRT output:** iterate clips; for each, read actual duration via `ffprobe -v quiet -of csv=p=0 -show_entries format=duration` and accumulate. This avoids timing drift introduced by `loudnorm` or re-encoding. This SRT is timed on the MP4; the radio mix writes its own `audio.srt`.
- **Timeline:** `ComposeTimeline` returns each turn's (start, end) in `final.mp4` (title card included); the radio transcript stores them as `video_start`/`video_end` for the Watch ↔ Listen mapping.

### 3.6 Formats, render pipeline and job stages

| | `video` (*Video + audio*) | `audio` (*Audio only*) |
|---|---|---|
| Speech | one batch avatar job per turn (talking clips) **and** one DragonHD TTS request per turn for the radio mix | one DragonHD TTS request per turn — zero avatar calls |
| Listener | listener kits (§3.8), resolved in parallel with the talking turns | — |
| Renditions | MP4 + video SRT; radio MP3 + radio SRT + `transcript.json` + `cover.jpg`; SCORM | radio MP3 + radio SRT + `transcript.json` + `cover.jpg`; SCORM |
| Progress stages | `queued → rendering n/N → composing → mixing → done` | `queued → synthesizing n/N → mixing → done` |
| Avatars | required for both hosts | optional (cover and player portraits) |

`JobState` is unchanged: `synthesizing` runs under `rendering` and `mixing` under `composing`.

**Video pipeline** (`routers/podcast.py`, `_render_job_body`):

1. `plan_reactions` on the script text (when reactions are effective, §3.9) → planned speaker pauses.
2. In parallel: the talking turns (batch avatar jobs with the pauses), the radio TTS turns (same SSML and pauses) and the listener kits (deadline `PODCAST_LISTENER_TIMEOUT_SEC`).
3. `place_reactions` once per rendition — on the avatar clips for the video, on the TTS turns for the radio.
4. Video compose (§3.5) inside the compose slot: at most `MAX_CONCURRENT_COMPOSES` (default 1) at once; other renders wait for the slot.
5. Radio mix (§3.7). Source fallback: TTS turns → avatar clip audio → the video soundtrack (`radio_fallback`).
6. Library publish (§3.11), unpublished.

The radio uses TTS turns even in video mode because the avatar clips' audio is band-limited (spike S1: 16 kHz AAC, nothing above 8 kHz), while DragonHD TTS is natively 24 kHz and costs about $0.02 per minute.

**Audio pipeline:** `plan_reactions` → TTS turns with the pauses + reaction audio → `place_reactions` → radio mix → library publish.

**Warnings.** `PodcastJob.warnings` holds stable codes only (`podcast_media.WARNING_CODES`) — never exception text, voices, character names or paths:

| Code | Meaning |
|---|---|
| `listener_fallback` | No idle loop: the listener is procedural or still. |
| `listener_static` | The idle footage is too static (procedural listener) or weak (kept, with sway). |
| `listener_timeout` | A listener kit was not ready within `PODCAST_LISTENER_TIMEOUT_SEC`. |
| `reactions_skipped` | Some planned backchannels were not placed (no clip, or the measured pause was too short). |
| `radio_fallback` | The radio mix failed: the MP3 is the video soundtrack (`audio_kind: "soundtrack"`). |
| `cover_fallback` | The cover art failed: plain branded cover. |

**Capacity.** `MAX_PENDING_RENDERS` caps queued + running jobs (429 beyond). Batch avatar jobs — talking turns and listener kits alike — go through one process-wide gate: at most `MAX_ACTIVE_BATCH_JOBS` active, creations paced to `SPEECH_BATCH_CREATE_PER_MIN` per rolling 60 s (S1: the third creation within a minute gets 429 with `Retry-After: 55`; status polls are not throttled). Deadlines are cooperative: past one, no new job is created and a running job is deleted (best effort).

### 3.7 Radio rendition (`podcast_radio.py`)

A dedicated broadcast-style master, built from the per-turn speech of either format:

1. **Per turn:** decode to 48 kHz mono, find the speech onset/offset with `silencedetect` (−45 dB, 120 ms) and keep ≈ 80 ms of pre-roll and ≈ 120 ms of tail (400 ms after the last turn). Trims only remove silence.
2. **Gaps:** natural, seeded per job: Gaussian 240 ± 60 ms between speakers, clamped to 120–350 ms; 350 ms between two turns of the same speaker.
3. **Levels and stereo:** every turn is levelled to −20 LUFS first (voices differ by up to ~12 LU); constant-power pan, interviewer slightly left (−0.15), expert slightly right (+0.15); backchannels on the listener's side at their placement.
4. **Intro & outro:** the Oz Radio sonic logo (`podcast_jingle`: an original procedural FM-bell motif synthesised with ffmpeg — 2 s rising intro, 1.5 s falling outro, no samples or existing melody) a few dB under the voices; only its faded tail rings under the first word. A licensed bed is ducked under the voices when provided (none ships).
5. **Loudness:** pre-gain + sample-peak limiter, then a **two-pass linear `loudnorm`** (I −16 LUFS, TP −1.5 dBTP, LRA 11; raw TTS would otherwise make loudnorm fall back to dynamic mode) → **CBR MP3 128 kb/s, 44.1 kHz stereo** (measures ≈ −16.3 LUFS after encoding).
6. **ID3v2.3 allow-list** (nothing else is written): `title` (episode title), `artist` (host display names), `album_artist` "Oz Radio", `album` "Oz Radio Podcasts", `genre` "Podcast", `date` (year), `language`, `comment` "AI-generated voices", plus the cover as APIC (re-encoded JPEG, no EXIF) — i.e. exactly the frames `TIT2`, `TPE1`, `TPE2`, `TALB`, `TCON`, `TYER`, `TLAN`, `TXXX:comment` and `APIC`. Never voices, Speech character names or source file names.
7. **Sidecars:** `transcript.json` (§3.10, with waveform peaks) and the radio-timed `audio.srt` (used for SCORM).

**Cover art** (`podcast_cover.py`): 1400×1400 JPEG drawn with Pillow — brand gradient, "Oz Radio" wordmark, the wrapped episode title, two circular host portraits (the photo avatars' green background keyed out; monogram when there is no portrait) and an "AI-generated voices" note. It is the MP3's APIC picture and the thumbnail of audio-only items; a rendering error gives a plain branded cover (`cover_fallback`).

### 3.8 Live listener (`podcast_listener.py`)

A **listener kit** per (avatar, voice, language) holds the silent idle loop and the lip-synced backchannel clips of one host. Kits are only built for custom photo avatars (green-screen mp4); other avatars use the fallback listener.

- **One batch avatar job per kit** (spike S1 recipe): a 250 ms lead, a 12 s silent break, then the unique backchannel phrases of the language separated by 1.5 s breaks. The job must end with words: break-only SSML is truncated by the service. Default photo-avatar settings (`scene.amplitude` is already at its maximum); green mp4 512×512 at 25 fps (WebM gives no alpha for photo avatars).
- **Idle loop:** the window from 1.0 s to the first phrase onset − 1.5 s (the first second settles, the mouth anticipates speech). Motion check on the 128 px face crop (mean frame-to-frame difference): ≥ 0.30 alive, < 0.05 frozen (no loop → procedural, `listener_static`), in between weak (kept, with `listener_static`). Loop = the best forward pair of frames 5–8 s apart (64 px face signatures), tail cross-faded into the head over 0.28 s; a 4 s ping-pong when no pair matches. Keyed once (`chromakey` first, then `despill`) to VP9 + alpha WebM.
- **Backchannel clips:** phrases found with `silencedetect`; exactly one island per phrase is required, else the kit has no reactions (`reactions_skipped`). Each clip keeps its measured duration (60 ms margins): VP9 + alpha WebM video and 48 kHz WAV audio.
- **Cache:** L1 `data/podcast/listener_kit/{key}/` and L2 private blob prefix `podcast-cache/listener-kit/{key}/` (never under `podcast-library/`, never SAS-signed). `key` = 24 hex characters of a sha256 over the kit inputs (avatar settings, voice, language, phrases, recipe); file names are content hashes; the `kit.json` sidecar is written last and holds no character name. Uploads are create-if-absent; a per-key lock with double-checked L1 → L2 → synthesis; corrupt entries are rebuilt.
- **Never fails a render:** any error, unsupported avatar or deadline gives a fallback kit (`procedural`, or `still` under `PODCAST_LISTENER_MODE=still`) with stable warning codes. `PODCAST_LISTENER_MODE=still|procedural` skips synthesis unless reactions need the clips. Anonymous traffic never triggers synthesis; `warm-listeners` (§4.4) pre-builds the kits.

### 3.9 Backchannels (`podcast_reactions.py`)

- **Stable ids:** `ack`, `right`, `yeah`, `exactly`, `isee`, `interesting`. The spoken text is resolved server-side per locale (8 locales; e.g. en-US "Mm-hmm." / "Right." / "Yeah." / "Exactly." / "I see." / "Interesting."), never written by the LLM. The script may carry one optional hint per turn: `reaction: {after_sentence, reaction_id}`.
- **Kill switch:** reactions are rendered only when the request asks for them **and** `PODCAST_REACTIONS=true`.
- **Planning** (`plan_reactions`, on the script text, before synthesis): valid hints first, else neutral acknowledgements (`ack`, `right`, `yeah`, `isee`) on about half of the eligible turns, seeded by the job id. Eligible: not the first or last turn, ≥ 2 sentences and ≥ 12 words; at most one per turn, never on consecutive turns, ≥ 20 s apart (estimated), ≤ 6 per episode.
- **Room by construction:** each planned reaction inserts a speaker pause (`<break>`, per language and phrase, ≈ 0.4–1.1 s) after the chosen sentence, in the avatar SSML and the TTS SSML alike (`build_ssml(pause_after_sentence=…)`; sentence counting is CJK-aware).
- **Placement** (`place_reactions`, once per rendition): the inserted pause is located with `silencedetect`; the clip is placed only if the pause holds 60 ms + clip + 60 ms — it never overlaps speech and is never stretched or truncated; otherwise it is skipped (the speaker simply pauses; `reactions_skipped`). Gain −4 dB, on the listener's side. Video: the listener's lip-synced clip on its tile; radio: its audio. Transcript cues of kind `reaction` use the measured clip duration.

### 3.10 `transcript.json` (radio timeline)

`podcast_models.Transcript`, produced by the radio mix and served inline in the library item (`transcript`) and as the job file `transcript`:

```jsonc
{
  "version": 1,
  "duration_sec": 412.6,
  "hosts": [ { "role": "interviewer", "display_name": "Sofia", "avatar_id": "photo_female" },
             { "role": "expert", "display_name": "Lucas", "avatar_id": "photo_male" } ],
  "turns": [ { "turn_idx": 0, "speaker": "interviewer", "start": 2.31, "end": 14.02,
               "video_start": 2.0, "video_end": 14.4 } ],          // video_* null without video
  "cues":  [ { "start": 2.31, "end": 5.10, "speaker": "interviewer", "turn_idx": 0,
               "text": "Welcome to …", "kind": "speech" },
             { "start": 9.80, "end": 10.33, "speaker": "expert", "turn_idx": 0,
               "text": "Mm-hmm.", "kind": "reaction" } ],           // speaker = the listener
  "peaks": [ 0.02, 0.41, … ]                                        // ≈ 240 values 0..1
}
```

- Times are seconds on the radio MP3; `turns[].video_start/video_end` locate the same turn in the MP4 (Watch ↔ Listen position mapping, turn by turn).
- `hosts[].avatar_id` is a registry id (`null` = monogram), never a Speech character name. No chapters (slide titles could expose text that is not spoken).
- v1 library items have no `transcript.json`: one is derived at read time from the SRT aligned with their MP3 (cue speakers from the `Name:` labels, consecutive cues of one speaker form a turn, no peaks).

### 3.11 Library manifest v2 (`podcast_library.py`)

```
podcast-library/{job_id}/audio.mp3        radio MP3 (or the video soundtrack, see audio_kind)
podcast-library/{job_id}/audio.srt        captions timed on audio.mp3 (SCORM)
podcast-library/{job_id}/transcript.json  radio transcript (§3.10)
podcast-library/{job_id}/cover.jpg        cover art
podcast-library/{job_id}/video.mp4        video rendition (format "video" only)
podcast-library/{job_id}/subtitles.srt    captions timed on video.mp4 (format "video" only)
podcast-library/{job_id}/scorm.zip        optional SCORM package
podcast-library/{job_id}/thumb.jpg        480w JPEG: a video frame, else the cover
podcast-library/{job_id}/manifest.json    written LAST: presence = archived
```

The v2 manifest (`schema_version: 2`) stores blob names only (SAS URLs are minted at read time) plus `format`, `has_video`, `has_audio`, `duration_sec` (primary rendition: the video when present), `audio_duration_sec`, `video_duration_sec`, `audio_kind` (`radio_mix` | `soundtrack`), `hosts`, `listener_mode`, the episode metadata and `published` (always `false` at publish time). It never holds voices, Speech character names or URLs.

- **v1 compatibility:** writers (`set_published`, `set_title`) edit the stored JSON one key at a time and never persist derived fields; readers get a normalized copy — a v1 manifest reads as `format: "video"`, `audio_kind: "soundtrack"`, `has_audio` from its MP3 blob, hosts from `speaker_names`, both durations from `duration_sec`, and a transcript derived from its SRT (§3.10).
- Only `podcast-library/job-*/` is listed or deleted; the listener cache lives under `podcast-cache/`.

---

## 4. Infrastructure

The podcast generator is deployed by the shared `infra/` Bicep templates (same Container App, Cosmos DB, Blob Storage and AI resources as the deck and video features). An isolated podcast-only resource group was considered in the original design and dropped to keep a single `azd up` deployment. The resource list below is the original design reference.

### 4.1 Resources

| Resource | Purpose | Notes |
|---|---|---|
| Azure OpenAI | GPT-4.1 + embeddings | New deployment; capacity: 50K TPM to start |
| Azure AI Services (Speech) | Batch Avatar Synthesis + TTS | Must be in a region that supports batch synthesis with DragonHD voices (westeurope ✓) |
| Storage Account | Blob: `podcasts/{job_id}/clips/*.mp4`, `podcasts/{job_id}/final.{mp4,mp3,srt}` | Lifecycle: delete after 30 days |
| Cosmos DB (Serverless) | `podcasts` DB, containers: `documents`, `scripts`, `jobs` | Serverless keeps cost tied to usage |
| Container App (web) | API + UI | Reuses root `Dockerfile`; no ffmpeg needed here |
| **Container Apps Job** (new) | Dedicated render worker | Separate image with ffmpeg added; triggered by queue message (Cosmos change feed or Service Bus). Keeps web app responsive; survives crashes via worker restart + idempotent state. |
| ACR | Images for web + worker | Shared |
| Log Analytics | Diagnostics | Shared workspace |

All resources are tagged with the `azd` environment name so they can be found and torn down together.

### 4.2 RBAC

Managed identities on **both** the web Container App and the worker Job need the same roles (since both call Cosmos + Blob; worker additionally calls Speech batch):
- `Cognitive Services OpenAI User` on the OpenAI account (web only)
- `Cognitive Services User` on the AI Services account (worker — batch synthesis REST)
- `Cognitive Services Speech User` on the AI Services account (worker)
- `Storage Blob Data Contributor` on the storage account (both — worker uploads clips; web mints user-delegation SAS for downloads)
- `Cosmos DB Built-in Data Contributor` on the Cosmos account (both; assigned via CLI post-deploy — not ARM-native)

We **download Speech batch output via the signed URL it returns** and re-upload to our own blob, so we don't need a `destinationContainerUrl` path or cross-resource SAS tokens.

### 4.3 Configuration

Plumbed through `infra/main.parameters.json` → `infra/main.bicep` → `infra/modules/containerapp.bicep` (see [`infra/README.md`](../infra/README.md)):

| Variable | Default | Effect |
|---|---|---|
| `PODCAST_PUBLIC_AUDIO` | `false` | Public listening for published podcasts (§6.1). |
| `PODCAST_REACTIONS` | `false` | Kill switch for backchannels in new renders (§3.9). |
| `PODCAST_LISTENER_MODE` | `auto` | `auto` / `idle_loop`: the kit's idle loop when it has one, else procedural; `procedural`; `still`. Unknown values read as `auto`. |
| `PODCAST_LISTENER_TIMEOUT_SEC` | `900` | Listener-kit budget of a video render (minimum 30 s). |
| `MAX_PENDING_RENDERS` | `3` | Queued + running render jobs (429 beyond). |
| `MAX_CONCURRENT_COMPOSES` | `1` | Video composes at once; other renders wait for the slot. |
| `MAX_ACTIVE_BATCH_JOBS` | `8` | Batch avatar jobs active at once (talking turns + listener kits). |
| `SPEECH_BATCH_CREATE_PER_MIN` | `2` | Batch avatar job creations per rolling minute. |

The `PODCAST_*` flags are read on each use. `PODCAST_REACTIONS` and `PODCAST_LISTENER_MODE` only affect new renders; `PODCAST_PUBLIC_AUDIO` applies to the next library request. Tuning knobs read from the environment but not plumbed through the templates: `PODCAST_TTS_OUTPUT_FORMAT` (default `riff-24khz-16bit-mono-pcm`) and `PODCAST_TTS_PARALLEL` (default 4).

### 4.4 Operator CLI

`demos/backend/maintenance/content.py` runs inside the app container (`az containerapp exec`, working directory `/app`) with the app's managed identity: no HTTP, no Easy Auth, no daily quota. It manages the AI enablement showcase catalog (decks, playlist, four podcast episodes, videos):

```bash
python -m maintenance.content inventory --json before.json     # decks, playlists, podcasts, videos (no URLs)
python -m maintenance.content warm-listeners [--language en-US] [--timeout 900] [--dry-run]
python -m maintenance.content render-podcast {beginner,practitioner,expert,demo-fr,all} \
    [--format video|audio] [--force] [--dry-run]
python -m maintenance.content publish --podcast-id job-… [--podcast-id job-…] [--off] [--dry-run]
python -m maintenance.content purge --podcast-id job-… --record deleted.json [--dry-run]
python -m maintenance.content --background /tmp/podcasts.log render-podcast all --force
python -m maintenance.content logtail /tmp/podcasts.log -n 40
```

- **`render-podcast`** renders and publishes an episode with the showcase cast (Sofia on `photo_female`, Lucas on `photo_male`, the DragonHD voices of the episode's language). `--format` overrides the episode's format (`video` for all four). Renders ask for backchannels; they are rendered only with `PODCAST_REACTIONS=true`. An item with the same title **and format** is only (re)published unless `--force`. The output lists the job id, format, `listener_mode` and warning codes.
- **`warm-listeners`** builds — or finds cached — the listener kit of each cast avatar with its voice, for each podcast language (one paid batch avatar job per missing kit). It prints avatar ids, voices, modes, idle-loop facts, reaction ids and warning codes, never character names, and exits with 1 when a kit fell back or has no backchannel clips.
- **`publish --off`** hides items from visitors without deleting them (a staged rollout keeps the superseded items for rollback); `publish` shows them again. Each entry warns when its title ends up with no published item, or with two.
- `--background LOG` detaches the job so a short `az containerapp exec` call can start a long render; `logtail` prints the log with URL query strings redacted.
- The CLI runs in its own process: its render limits and batch pacing do not coordinate with the server's, so do not render from the CLI and the studio at the same time.

**Staged rollout** (as used for the showcase): deploy with `PODCAST_PUBLIC_AUDIO=false` → `inventory` → `warm-listeners` → `render-podcast all --force` → review as an admin → `publish --podcast-id <old id> --off` for each superseded item → `PODCAST_PUBLIC_AUDIO=true` → verify anonymously → `purge --podcast-id <old id> --record deleted.json`. Rollback before the purge: set the flags back, republish the old items and hide the new ones. See [`infra/README.md`](../infra/README.md#podcast-radio-and-listener-flags-staged-rollout).

---

## 5. Frontend changes

> §5.1–5.2 are the original plan. The shipped studio and library are `src/pages/PodcastPage.tsx` and `src/pages/PodcastLibraryPage.tsx` (§5.4).

### 5.1 Routing
Install `react-router-dom@7`. Wrap App in `<BrowserRouter>`. Routes:
- `/` → existing single-avatar presenter
- `/podcast` → new `PodcastPage`

Shared top nav with two tabs.

### 5.2 New components
```
src/pages/PodcastPage.tsx
src/components/podcast/DocumentUploader.tsx   // multi-file + URL
src/components/podcast/InstructionsPanel.tsx  // style, length, language, turns
src/components/podcast/RoleConfig.tsx         // avatar/voice pickers x2
src/components/podcast/ScriptEditor.tsx       // two-column dialogue editor
src/components/podcast/RenderControls.tsx     // start render + layout toggle
src/components/podcast/JobStatus.tsx          // progress + final player
```

### 5.3 API client
`src/services/podcast.ts` — typed fetch wrappers for every endpoint, mirroring the contracts (`format`, `reactions`, job outputs and warnings, `Transcript`, library DTOs).

### 5.4 Watch and Listen

- `src/components/RadioPlayer.tsx` (+ `src/styles/shared/radio-player.css`) — the **Listen** experience around a native `<audio preload="metadata">`: cover art; both hosts lit from `transcript.turns` (glow on reaction cues); the current speaker as text; a visible live caption (not announced — `aria-live="off"`, so screen readers don't talk over the hosts; the transcript stays available on demand) and a collapsible click-to-seek transcript; a seekable waveform from the precomputed peaks (`role="slider"`, turn ticks); play/pause, ±15 s, speed 0.75–2×; keyboard shortcuts (Space/K, J/L, arrows, Home/End); Media Session; an "AI-generated voices" note; autoplay-rejection handling; reduced motion; SAS-expiry recovery (at most one source refresh per minute, position and play state restored).
- `src/pages/PodcastLibraryPage.tsx` — **Watch** and **Listen** side by side on each episode (audio-only: **Listen** + an *Audio only* chip); a player with Watch | Listen tabs that maps the position turn by turn (`video_start`/`video_end` ↔ `start`/`end`) and keeps one active media element; deep link `?episode=<id>&mode=watch|listen` (without `mode`, touch devices open Listen when audio exists, desktops Watch).
- `src/pages/PodcastPage.tsx` — the format choice at the top of **Review & cast**, the **Listener reactions** and **Intro & outro** options, format-aware stages and the same Watch / Listen player in the result view (it keeps its own local radio player).

#### Persistent listening (`src/playback/`)

Built for a phone in a pocket: listening must survive the page.

- **One audio session per visit**: `PlaybackProvider` (above the routes, `main.tsx`) owns ONE `RadioPlayer` and therefore one `<audio>` element; episodes change by props (`episodeKey`), never by remounting, so iOS keeps the element unlocked after the first tap (needed for auto-next with the screen locked). The player renders through a portal into a host node that `PlayerSlot` moves into the episode dialog and back to a hidden, inert parking container — moves happen in layout effects only, so the media element never leaves the document and playback never stops.
- **Minimise, don't stop**: in Listen, close, Back, the scrim and Escape minimise to the **mini-player** (all routes: cover, title, live status, play/pause, *Stop and close player* while paused, and *Open now playing* which returns to the episode and, on close, to the page you came from). `--mini-player-h` keeps content, focus (`scroll-padding-bottom`), toasts and the debug panel clear of it. Watch (video) is page-owned and still stops on close.
- **Phone sheet**: under 640 px (and in short landscape on touch screens) the podcast dialog is a full-screen sheet; the seek bar and transport are pinned at the bottom (thumb zone), the transcript scrolls above them.
- **One-tap start**: library rows prefetch playable details (`prepare.ts`, 10-minute cache, below the 15-minute anonymous SAS); a prepared episode starts inside the tap (`flushSync`). Otherwise the item is fetched first and a refused autoplay shows *Press play*.
- **Resume** (`progress.ts`): per-episode bookmark and speed in `localStorage` (`oz-radio.progress.v1`, `oz-radio.speed`; numbers only, never URLs), saved on time updates (≤ 1 per 5 s), pause, seek, rate change, `pagehide`, hidden and `freeze`; an ended episode restarts from 0; after a pause longer than a minute playback rewinds 3 s.
- **Auto-next** (`queue.ts`): the next episode in the same language (audience level ascending when known, then oldest first) is prepared at 75 % of the current one (never earlier than 5 minutes before its end, so the prepared link is still fresh) and started inside the `ended` event on the same audio element; a failed prefetch is retried while playing, and if nothing is ready at the end the next episode is fetched then (best effort); the end of a series shows *Finished*. Lock-screen previous/next buttons are behind `LOCKSCREEN_TRACK_BUTTONS` (off: iOS shows either ±15 s or previous/next, and an earbud double-press would skip whole episodes).
- **One medium at a time** (`exclusive.ts`) and **one lock-screen owner** (`mediaSession.ts`): any other audible media (videos, the creator page's player, the live avatar) pauses the radio; the radio pauses `[data-oz-media]` videos; every claim sets or clears all Media Session actions. Expired SAS links are refreshed by `jobId` in the provider, independent of any page.
- Tests: `tests/playback-engine.spec.ts`, `tests/playback-resume.spec.ts`, `tests/playback-continuity.spec.ts`, `tests/mobile-platform.spec.ts`.

#### On-device playback log (`?debug=player`)

An opt-in event log for testing listening on a real phone (screen locked, earbuds) without a remote inspector — e.g. an iPhone tested from a Windows PC, where Safari Web Inspector is unavailable. Code: `src/debug/playerDebug.ts` (hooks + ring buffer) and `src/debug/PlayerDebugPanel.tsx` (lazy chunk, loaded only when the log is on).

- **Turn on**: open any page with `?debug=player` (e.g. `/podcast/library?debug=player`). The flag is kept in `localStorage` (`oz-radio.debug`), so it survives navigation and reloads on that device. **Turn off**: the panel's **Turn off** button (clears the flag and reloads without `?debug`) or any page with `?debug=off`. Off, nothing is patched, listened to or stored.
- **What is logged**: a `session` entry per page load (user agent, viewport, device pixel ratio, standalone display mode); every `<audio>`/`<video>` event `loadstart`, `loadedmetadata`, `canplay`, `play`, `playing`, `pause`, `waiting`, `stalled`, `seeking`, `seeked`, `ratechange`, `ended`, `emptied`, `abort`, `error` (element + `data-testid`, `currentTime`, `duration`, `readyState`, `networkState`, `paused`, `playbackRate`, `error.code`, source URL); each `play()` call with `navigator.userActivation.isActive` and its outcome (`play() resolved` / `play() rejected` with the error name, e.g. `NotAllowedError`); every Media Session action from the lock screen or earbuds (`mediasession`: action, `seekOffset`, `seekTime`); page lifecycle (`visibilitychange`, `pagehide`/`pageshow`, `freeze`/`resume`, `online`/`offline`, `focus`/`blur`) and uncaught errors.
- **No SAS tokens**: media URLs are logged as origin + path — the query string is always stripped (`srcId` numbers distinct full URLs within the page load, so a re-signed URL still shows up as a new source).
- **Storage**: the last 500 entries `{ t, dt, kind, detail }` (ISO time with ms, ms since the previous entry) in `localStorage` (`oz-radio.debug.log`), written at most once a second and flushed when the page is hidden or left, so a reload or a killed tab keeps the log. Turning off keeps the stored log until it is cleared.
- **Read and export**: tap **Debug** (bottom left, above dialogs) for the entries, newest first. **Copy** puts the whole log on the clipboard (a header, then one JSON entry per line, oldest first; without clipboard access — plain HTTP on a LAN address — the text is selected for a manual copy). **Share** opens the OS share sheet (Mail, Teams, Notes…) where supported. **Clear** empties it.
- A player that plays a detached `new Audio()` (never in the DOM) must call `registerMediaElement(el)` (idempotent, a no-op when the log is off); elements in the document are picked up automatically. UI tests: `tests/player-debug.spec.ts`.

---

## 6. Security & compliance

- **No secrets in code.** All Azure auth via `DefaultAzureCredential` (existing pattern in `services/avatar.py`).
- **SAS tokens**: minted on demand, blob-scoped and read-only — 24 h for admins, 15 min for anonymous visitors; manifests store blob names only; responses that carry SAS URLs are sent with `Cache-Control: no-store`.
- **Speech character names** (they can identify the customer) never appear in blob names, manifests, listener-kit sidecars, logs, job warnings, ID3 tags or API payloads; batch avatar status payloads, which echo the character, are never logged or stored. Hosts are identified by display name and avatar registry id.
- **ID3 allow-list** (§3.7): the radio MP3 carries only the episode title, host display names, brand album/artist, genre, year, language, an "AI-generated voices" comment and the re-encoded cover — no voices, file names or EXIF.
- **Listener cache**: private `podcast-cache/listener-kit/` prefix, never listed by the library and never SAS-signed; anonymous traffic never triggers synthesis.
- **Content filtering**: Azure OpenAI default content filter stays on; the generated script is shown for review (Review & cast) before anything is rendered.
- **PII**: Documents uploaded are stored in blob (encrypted at rest) for the lifetime of the job; lifecycle rule deletes after 30 days.
- **Rate limits / abuse**: at most 40 turns per script, the per-user `DAILY_GENERATION_QUOTA` (renders, uploads and chats per UTC day), `MAX_PENDING_RENDERS` queued + running jobs, the compose slot and the batch avatar admission and pacing (§3.6).

### 6.1 Public access

Anonymous visitors only ever see **published** episodes (one publish flag covers every rendition). `PODCAST_PUBLIC_AUDIO` (default `false`) is the kill switch for public listening; it supersedes the earlier rule that public DTOs carry no audio.

| Anonymous visitor gets | `PODCAST_PUBLIC_AUDIO=false` | `PODCAST_PUBLIC_AUDIO=true` |
|---|---|---|
| Video episodes in the list / detail | yes | yes |
| Audio-only episodes | hidden (detail → 404) | listed and playable |
| `mp4_url` / `video_url`, `thumbnail_url` (15-min SAS) | yes | yes |
| `audio_url` = `mp3_url` (radio MP3, 15-min SAS), `cover_url` | `null` | yes |
| `transcript` (inline, live captions) | `null` | yes |
| `hosts`, `speaker_names` | empty | yes |
| `format`, `has_video`, `has_audio` | yes (`has_audio: false`) | yes |
| `srt_url`, `audio_srt_url`, `scorm_url`, script, document title | never | never |

Every response carrying SAS URLs is sent with `Cache-Control: no-store`. Turning the flag off withdraws the audio and transcripts for every new request; links already handed out expire within 15 minutes.

---

## 7. Cost model (rough, westeurope)

**Variable cost per 6-minute podcast** (~8 turns, ~1200 spoken words):
| Item | Estimate |
|---|---|
| GPT-4.1 script gen (~15K in + 3K out tokens, incl. chunk-reduce) | ~$0.05 |
| Batch Avatar Synthesis — DragonHD pre-built avatar | ~6 min × ~$0.36/min ≈ $2.16 |
| Blob storage + egress | ~$0.01 |
| Cosmos serverless RU | ~$0.01 |
| **Per-podcast total** | **~$2.25** |

**Fixed (standing) infra cost** for a podcast-only deployment:
| Item | Estimate |
|---|---|
| Container App (web) min-replicas=0 → scale-to-zero, so ~$0 idle | ~$0–5/mo |
| Container Apps Job (worker) — consumption; bills only while running | ~$0–3/mo for 200 jobs |
| Cosmos serverless | ~$2–5/mo |
| Storage (100 podcasts retained × ~200 MB) | ~$1/mo |
| Log Analytics ingest | ~$3–10/mo |
| ACR Basic | ~$5/mo |
| **Fixed total** | **~$15–30/mo (~$200–400/yr)** |

**Example volume (200 podcasts/year):**
- Variable: 200 × $2.25 ≈ **$450/yr**
- Fixed:   ~**$200–400/yr**
- **All-in: ~$650–850/yr**

**Radio and listener (rough):** DragonHD TTS is billed per character (≈ $22 per 1M characters at the time of writing, ≈ $0.02 per minute of speech), so an audio-only episode costs cents and the radio mix adds about as much to a video episode; the avatar minutes dominate (custom photo avatars are billed at a higher per-minute rate than the pre-built avatar above). A listener kit is one ≈ 25 s batch avatar job per (avatar, voice, language), paid once and cached.

---

## 8. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Batch Avatar Synthesis quota exhaustion | Process-wide creation pacing (`SPEECH_BATCH_CREATE_PER_MIN`, `Retry-After` honoured) and admission (`MAX_ACTIVE_BATCH_JOBS`); listener kits cached; audio-only renders make no avatar calls |
| ffmpeg missing from container | Added to **worker Dockerfile** (`demos/worker/Dockerfile`) only; web image unchanged. Worker startup smoke-checks `ffmpeg -version` and `ffprobe -version` |
| DragonHD voices not available in selected language | `/voices` endpoint validates per-language availability and falls back to best standard neural voice; UI shows a banner when falling back |
| Long render latency | Per-turn batch jobs run concurrently within the pacing; poll with exponential backoff; UI shows stage + clip-level progress; *Audio only* skips avatar synthesis |
| Cosmos partition hot-spots | Partition `/userId` spreads load across users; composite indexes `(userId ASC, createdAt DESC)` for listings |
| Audio loudness variance across clips | Video: single `loudnorm` pass during compose (I=-16 LUFS, TP=-1.5 dBTP, LRA=11). Radio: per-turn levelling, then a two-pass linear `loudnorm` to the same targets |
| SRT timing drift after loudnorm/re-encode | Timestamps derived from `ffprobe` on actual post-encode clips, not planned durations |
| Listener footage static, rejected or late | Motion check → procedural sway → plain still; listener deadline (`PODCAST_LISTENER_TIMEOUT_SEC`); `warm-listeners` pre-builds kits; a render never fails because of the listener |
| Backchannels sound dubbed or clip speech | Stable ids with server-side phrases, measured clips placed only inside measured pauses (never over speech, never stretched), density limits, kill switch `PODCAST_REACTIONS` |
| Radio mix failure | Soundtrack fallback (`radio_fallback`); the episode still publishes |
| Public audio and transcripts widen the anonymous surface | Kill switch `PODCAST_PUBLIC_AUDIO` (off by default, enabled after review), published items only, 15-min SAS, `no-store`, allow-listed DTO and ID3 tags |
| 2 vCPU replica pressure | Single compose slot (`MAX_CONCURRENT_COMPOSES`), batch admission, `MAX_PENDING_RENDERS` |
| Long-doc script generation blowing the context window | **Chunk → map-summarize → reduce → script** pipeline (implemented in `services/podcast_script.py` from v1); hard cap total input at 120K tokens |
| Crash / restart during render | Idempotent worker: per-clip manifest (remoteJobId, status, checksum) + idempotent compose step; any restart resumes without re-billing completed clips |
| Cancellation leaking remote billable jobs | Cancel path: DELETE active Speech batch jobs before marking `cancelled` |
| User edits script in dangerous ways (prompt injection via docs) | GPT-4.1 content filter + output schema enforcement (pydantic parse); reject invalid JSON; cap turns per script (16) and total text (8K chars) |

---

## 9. Testing plan

- **Unit**: pydantic schema round-trips, SRT time math, ffmpeg command builder.
- **Radio + listener (offline, `demos/backend/tests`)**: contracts and env flags, conditional avatar validation, zero avatar calls in audio mode, deadlines and batch admission/pacing, reaction planning and fit (no overlap, measured cues), radio mix loudness/CBR/ID3 allow-list, manifest v1/v2 normalization, public DTOs with the flag on and off (exact keys, 404 for hidden audio-only items, `no-store`), sentinel test that a fake character name never reaches blob names, sidecars, logs, warnings, ID3 tags or public JSON, and the operator CLI with fakes (`test_maintenance_content.py`).
- **Integration**: hit Azure OpenAI with a fixture doc → assert script JSON shape.
- **E2E smoke** (`tests/e2e_render.py`): upload a sample deck → generate → render 3-turn podcast → verify MP4/MP3/SRT exist and have non-zero duration. Gate deployment on this.
- **Cost guard**: track token/minute usage in Cosmos; assert smoke test stays under $0.50.

---

## 10. Delivery phases

**Current PoC:** backend router + services, frontend route, render pipeline, library, and Blob-backed MP4 / MP3 / SRT / SCORM deliverables; video + radio renditions (`video` / `audio` formats), the live listener with backchannels, Watch / Listen in the library and public listening behind `PODCAST_PUBLIC_AUDIO`.

**Next polish:** regenerate single turn, voice preview; CJK fonts in the container image (zh-CN / ja-JP captions and cover titles do not render without them).
