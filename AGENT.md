# 🎙️ Oz Radio

> AI avatars that present, narrate and podcast your decks

## Overview

Oz Radio: AI-powered avatar presentation assistant that reads PowerPoint speaker notes with multilingual text-to-speech. Upload a PowerPoint deck and an AI avatar autonomously presents it — translating speaker notes into the target language and delivering them via a realistic TTS avatar, without needing a live presenter.

The repo covers complementary avatar features in a single app:
- **Home** at `/` — landing page
- **Live** at `/live` — upload one deck and let the live avatar present it, with slide Q&A
- **Decks / Search / Playlists** at `/decks`, `/search`, `/playlists` — deck catalog + hybrid Azure AI Search + playlists + AI playlist recommendation
- **Video** at `/video` — batch avatar MP4 pipeline
- **Podcast** at `/podcast` — two-host conversation rendered as a two-avatar video plus a radio mix, or audio only (library: Watch / Listen)
- **Public live demo** (off by default) — anonymous, narration-only live avatar on decks an admin marked *Live demo* (`/ws/voice/demo`, see `docs/live-demo.md`)

## Features

### Live avatar presenter (`/live`)
1. **Async mode**: Upload a PPT in advance, select target language and avatar, system generates a video of the avatar presenting each slide using speaker notes (translated to target language)
2. **Real-time mode**: Upload PPT on the fly, configure language, avatar begins speaking immediately as user navigates slides
3. **Slide Q&A**: While viewing a slide, user can ask questions about the content being shown — AI answers based on slide content and speaker notes
4. **Multilingual**: Avatar speaks in a chosen language regardless of the source language of the speaker notes (translation + TTS)

### Teams
5. **Teams embedding**: Embed Oz Radio in Microsoft Teams as a static tab

### Decks, Search & Playlists (`/decks`, `/search`, `/playlists`)
6. **Multi-deck corpus**: Decks ingested into Azure AI Search (index `decks`, Free SKU), hybrid vector + keyword retrieval across languages
7. **Playlists**: Cosmos-persisted multi-deck sequences; per-user progress tracking (resume slide index); the playlist player auto-connects the avatar and auto-presents each deck without re-clicking between steps
8. **AI playlist recommendation**: `POST /api/playlists/recommend` uses GPT-4.1 JSON mode to pick a coherent, ordered deck sequence from the full catalog for any topic + target language, without persistence

### Video (`/video`) & Podcast (`/podcast`)
9. **Video**: Slide-first render pipeline (1 batch-avatar job per slide → ffmpeg compose → MP4 + SRT + SCORM)
10. **Podcast**: Document → GPT-4.1 two-speaker dialogue → batch avatar clips per turn (video) and DragonHD TTS turns (radio) → ffmpeg compose + radio mix → MP4 + radio MP3 + transcript + cover (+ SRT/SCORM); format `video` or `audio`; cached alive listener and optional backchannels

## Security model

Hybrid exposure: anonymous visitors may load the SPA and view **published** videos, podcasts and decks (slide images + titles only), and — only when `PUBLIC_DEMO_ENABLED=true` — watch the narration-only live demo on decks marked *Live demo*; only when `PODCAST_PUBLIC_AUDIO=true` can they also stream a published podcast's radio audio and read its transcript. Everything else requires a Microsoft Entra ID sign-in (Container Apps Easy Auth) whose object ID is in `ALLOWED_OBJECT_IDS` — default deny. Local dev uses `AUTH_MODE=disabled` (every caller is admin); never deploy that setting. Speech character names never leave the server (no blob names, sidecars, logs, ID3 tags or payloads). See `README.md` → *Security model*, `SECURITY.md`, `docs/live-demo.md` and `docs/podcast.md`.

## Deployment

To provision or deploy to Azure, follow [`BOOTSTRAP.md`](BOOTSTRAP.md). It gives ordered gates and the points where you must stop and ask the human. The human runbook is [`docs/provisioning.md`](docs/provisioning.md). VS Code prompt: `.github/prompts/deploy.prompt.md`.
## Key Technologies

| Service | Purpose |
|---------|---------|
| Azure AI Speech | Text-to-speech with avatar rendering (VoiceLive API + WebRTC, Batch Avatar, DragonHD voices) |
| Azure OpenAI | Translation (GPT-4.1), slide Q&A (RAG), embeddings (text-embedding-3-small), script generation, playlist recommendation |
| Azure AI Search | Deck catalog corpus (hybrid vector + keyword, index `decks`) |
| Azure Cosmos DB | Presentation store + playlists (container `presentations`, partitioned by `/id`) + `playlist_progress` |
| Azure Blob Storage | Slide images, PPTX source files, rendered media |
| LibreOffice (headless) | PPTX → PDF conversion for slide image rendering |
| Poppler (pdf2image) | PDF → PNG conversion for individual slide images |
| ffmpeg | Video/audio compose for the video and podcast generators; podcast radio mix (two-pass loudnorm, MP3 + ID3), listener-kit keying (VP9 + alpha) |
| python-pptx | Extract slide text, titles, speaker notes |
| FastAPI + Uvicorn | Backend REST API + WebSocket proxy |
| **Teams SDK** | `@microsoft/teams-js` — context detection, theme adaptation    |
| React 19 + Vite 8 | Frontend SPA — SlideViewer, AvatarPanel, Decks, Search, Playlists, Video, Podcast |

## Key Paths

| Path | Description |
|------|-------------|
| `demos/backend/` | FastAPI backend — app.py, config.py, services/, routers/, Dockerfile |
| `demos/backend/routers/decks.py` | Decks API (upload, list, publish, live demo, delete, search via Azure AI Search) |
| `demos/backend/routers/playlists.py` | Playlists CRUD + progress + AI `POST /recommend` (GPT-4.1 JSON mode) |
| `demos/backend/routers/podcast.py` | Two-host podcast (ingest, script stream SSE, render `video`\|`audio`, job files, library + public DTO) |
| `demos/backend/services/podcast_models.py` · `podcast_media.py` | Podcast HTTP/JSON contracts (render request, job, transcript, library DTOs) · internal engine contracts, stable warning codes, `PODCAST_*` env flags |
| `demos/backend/services/podcast_render.py` · `speech_rest.py` | Batch avatar job per turn (admission `MAX_ACTIVE_BATCH_JOBS`, creation pacing `SPEECH_BATCH_CREATE_PER_MIN`, deadlines) · Speech REST auth (Entra → STS) + shared retry policy |
| `demos/backend/services/podcast_tts.py` | DragonHD TTS turns for the radio mix and audio-only renders (zero avatar calls) + cached reaction audio |
| `demos/backend/services/podcast_listener.py` | Cached listener kits per (avatar, voice, language): silent idle loop + lip-synced backchannel clips; never raises (fallback listener) |
| `demos/backend/services/podcast_reactions.py` | Backchannel planning on the script text (pauses) and placement in the measured pauses |
| `demos/backend/services/podcast_compose.py` | ffmpeg video compose (geometry contract, live listener, reactions, 160 ms dissolves) |
| `demos/backend/services/podcast_radio.py` · `podcast_cover.py` · `podcast_jingle.py` | Radio mix (gaps, −16 LUFS, CBR MP3 + allow-listed ID3, `transcript.json`, radio SRT) · 1400 px cover art · procedural sonic logo |
| `demos/backend/services/podcast_library.py` | Blob library, manifest v2 (v1 read-compatible), public audio policy |
| `demos/backend/maintenance/content.py` | Operator CLI in the container (`python -m maintenance.content`): seed, render-podcast `--format`, warm-listeners, publish `--off`, purge |
| `demos/backend/routers/video.py` | Batch-avatar MP4 (ingest, script stream NDJSON, render, library) |
| `demos/backend/services/deck_search.py` | Azure AI Search client for the deck catalog (hybrid vector + keyword) |
| `demos/backend/services/pptx_parser.py` | PPT parsing + LibreOffice → PDF → PNG image rendering |
| `demos/backend/services/voice_proxy.py` | WebSocket proxy for VoiceLive avatar API (admin `/ws/voice` + narration-only demo) |
| `demos/backend/services/voice_questions.py` | Raise-hand voice Q&A over both voice WebSockets (`qa.*` protocol, audio validation, Speech STT, admin/demo limits) |
| `demos/backend/services/deck_qa.py` | Deck-grounded answer to an audience question (GPT-4.1 JSON mode, no tools/history) |
| `demos/backend/services/avatar_registry.py` | Avatar catalog: stock avatars, `CUSTOM_AVATARS_JSON`, `HIDE_STOCK_AVATARS`, podcast crops |
| `demos/backend/security.py` | Quotas and guardrails (`DAILY_GENERATION_QUOTA`, `MAX_PENDING_RENDERS`, the podcast compose slot `MAX_CONCURRENT_COMPOSES`, `DEMO_*`, `DEMO_QA_*`; durable demo quota in Cosmos) |
| `demos/backend/services/qa.py` | In-memory numpy vector search for slide Q&A (Live page) |
| `demos/backend/services/storage.py` | PresentationStore (Cosmos containers `presentations` + `playlist_progress`) |
| `demos/frontend/` | React frontend |
| `demos/frontend/src/main.tsx` | Router — `/`, `/live`, `/decks*`, `/search`, `/playlists*`, `/video*`, `/podcast*` |
| `demos/frontend/src/pages/` | `HomePage`, `LivePage`, `DecksPage`, `DeckPresentPage`, `SearchPage`, `PlaylistsPage`, `PlaylistPlayerPage`, `Video*`, `Podcast*` |
| `demos/frontend/src/components/AvatarPanel.tsx` | WebRTC avatar panel — supports `autoStart` prop for playlist player zero-click between decks |
| `demos/frontend/src/components/RadioPlayer.tsx` | Podcast "Listen" player: cover, hosts lit from the transcript, live captions, waveform slider, speed, SAS-expiry recovery |
| `demos/frontend/src/components/RaiseHandPanel.tsx` | Raise-hand Q&A controls (rendered in `AvatarPanel`); mic capture in `src/services/voiceCapture.ts` |
| `demos/frontend/src/components/LanguageSelector.tsx` | Language picker with `variant: 'dark' \| 'light'` (dark = gradient banners, light = white cards) |
| `demos/frontend/src/services/decksApi.ts` | Decks API client (decks, search, playlists, recommend) |
| `demos/frontend/src/services/demo.ts` | Public live demo config + close-code messages |
| `demos/frontend/src/services/teams.ts` | Microsoft Teams SDK integration helpers |
| `demos/backend/auth.py` | Hybrid exposure model — Easy Auth principal parsing, `AUTH_MODE`, object-ID allowlist, `GET /api/me` |
| `tests/e2e_full.py` | End-to-end runner — reset DB + upload 9 sample fixtures + decks / video / podcast smoke (30 checks); targets local dev (`AUTH_MODE=disabled`) via `AI_PRESENTER_BASE_URL` |
| `tests/e2e_render.py` | Full render E2E for video (MP4) + podcast (MP3), with `--languages` flag for multi-locale sweep (30 checks in 3-lang mode) |
| `tests/fixtures/samples/` | 9 coherent fixture decks in 3 thematic groups (Safety FR, Generative AI EN, AI in industry ES) |
| `tests/test_playlists_api.py` | pytest for the playlists API incl. AI recommend |
| `tests/playlists.spec.ts` | Playwright UI regressions for playlists |
| `scripts/package-teams-app.ps1` | Package Teams app for sideloading |
| `content/ai-enablement/` | AI enablement deck series (3 levels + live-demo cut) and seeding steps; regenerate with `scripts/generate_ai_enablement_pptx.py` |
| `docs/provisioning.md` · `BOOTSTRAP.md` · `.github/prompts/deploy.prompt.md` | Azure provisioning runbook (humans) · ordered deployment steps (coding agents) · deploy prompt |
| `docs/` | Architecture docs, decks/search/playlists, video, podcast, live demo, Teams integration |
| `run-local.ps1` | One-command local dev startup (backend + frontend, `AUTH_MODE=disabled`) |
| `SECURITY.md` | Security policy, hybrid exposure model, operator checklist |

## Deliverables

- [x] Architecture diagram
- [x] PoC demo: PPT upload → slide image rendering → avatar presents with TTS
- [x] Multilingual TTS demonstration (10 DragonHD languages via GPT-4.1 translation)
- [x] Slide Q&A demonstration (in-memory numpy RAG)
- [x] Teams integration — Static Tab (iframe embed) with Teams SDK theme support
- [x] Deck catalog with Azure AI Search hybrid retrieval
- [x] Playlists with Cosmos persistence + progress + zero-click playlist player
- [x] AI playlist recommendation (GPT-4.1 JSON mode, catalog-validated)
- [x] Video full render pipeline (validated E2E: 5.9 MB mp4 in 370s)
- [x] Podcast full render pipeline (validated E2E: 854 KB mp3 in 265s)
- [x] Public live demo with server-side cost guardrails (off by default)
- [x] E2E test suites — `tests/e2e_full.py` (30/30) + `tests/e2e_render.py` (30/30 multi-language: fr-FR/en-US/es-ES × video + podcast)
