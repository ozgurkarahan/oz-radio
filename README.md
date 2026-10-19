# 🎙️ Oz Radio

> **AI avatars that present, narrate and podcast your decks**

*Formerly DeckFM.*

**Turn PowerPoint decks into AI-presented training** — a photorealistic avatar presents your slides live, renders narrated videos, or hosts a two-avatar podcast, in multiple languages. Built on Azure AI Speech (Voice Live + Batch Avatar), Azure OpenAI and Azure Container Apps.

**▶ [Try the live avatar demo](https://ozgurkarahan.com/oz-radio/)** — no sign-in needed (narrated, time-boxed, capped daily; voice and typed questions where the owner enables them) · [More of my work](https://ozgurkarahan.com/)

[![GitHub](https://img.shields.io/badge/GitHub-ozgurkarahan%2Foz--radio-181717.svg?logo=github)](https://github.com/ozgurkarahan/oz-radio)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Python 3.12+](https://img.shields.io/badge/Python-3.12+-3776AB.svg?logo=python&logoColor=white)](https://www.python.org/)
[![React 19](https://img.shields.io/badge/React-19-61DAFB.svg?logo=react&logoColor=white)](https://react.dev/)
[![Azure](https://img.shields.io/badge/Azure-AI%20Services-0078D4.svg?logo=microsoftazure&logoColor=white)](https://azure.microsoft.com/)

---

## 🧭 What's inside

Oz Radio bundles complementary features, each exposed as its own entry in the top nav
(`Oz Radio | Home · Live · Decks · Search · Playlists | Video: Create · Library | Podcast: Create · Library`):

| Feature | Route | What it does |
|---|---|---|
| 🏠 **Home** | `/` | Landing page: **Start the live demo** (or **Watch a recorded demo**), **Listen to an episode**, **Browse decks**, with entry points into every feature |
| 🎙️ **Live** | `/live` | Upload a single `.pptx`; a photorealistic avatar presents each slide in real time via WebRTC with multilingual TTS and slide-level Q&A |
| 📚 **Decks** | `/decks`, `/decks/:deckId/present` | Multi-deck catalog: upload, publish, mark as *Live demo*, and let the avatar present any deck. [Design →](docs/decks-search-playlists.md) |
| 🔎 **Search** | `/search` | Hybrid vector + keyword search across every deck (Azure AI Search when configured, otherwise the built-in local search used by the default deployment); the avatar presents the matching slide |
| 📻 **Playlists** | `/playlists`, `/playlists/:playlistId` | Ordered multi-deck sequences with per-user progress, plus **AI playlist recommendation** (GPT-4.1 picks a coherent deck sequence for any topic) |
| 🎬 **Video** | `/video` + `/video/library` | Automated pre-rendered narrated MP4 from a `.pptx` (slide-first pipeline + Batch Avatar). Outputs MP4 / MP3 / SRT / SCORM. [Design →](docs/video.md) |
| 🎧 **Podcast** | `/podcast` + `/podcast/library` | Turn any document into a two-host podcast: a two-avatar video **plus** a dedicated radio mix, or audio only. Outputs MP4 + radio MP3 + transcript (+ SRT / SCORM); the library offers **Watch** and **Listen** side by side. [Design →](docs/podcast.md) |

Owner tools sit together in one menu (*Owner tools* for visitors, *Create* for the owner) and are marked *Sign-in required* for anonymous visitors; visitors sign in only through the **Owner sign-in** text link.

## ✨ Features

- **📂 PowerPoint Upload** — Upload `.pptx` files; slides are automatically parsed and rendered as images
- **🧑‍💼 Live AI Avatar** — A photorealistic avatar narrates each slide using Azure AI Speech (VoiceLive / WebRTC)
- **📚 Decks, Search & Playlists** — Multi-deck catalog with Azure AI Search (hybrid vector + keyword), playlists (Cosmos-persisted multi-deck sequences with resume + per-user progress), AI playlist recommendation using GPT-4.1 JSON mode, zero-click avatar auto-start between playlist steps
- **🎬 Narrated Video** — Automated narrated MP4 per `.pptx`, slide-first pipeline (one batch-avatar job per slide + ffmpeg compose), multilingual, voice-aware avatar selection, published library
- **🎧 Two-Host Podcast** — Conversational podcast from any document, rendered as a two-avatar video (the listening host stays alive, with optional lip-synced backchannels) plus a radio mix (−16 LUFS MP3 with a live transcript; the cover art is a separate image, not embedded), or as audio only
- **▶️ Live demo** — Optional, off by default: anonymous visitors start the live avatar on decks an admin published and marked **Live demo**. One tap presents the whole deck with live captions; with demo Q&A on, visitors can ask typed or spoken questions. Hard server-side cost guardrails apply ([docs/live-demo.md](docs/live-demo.md))
- **🌍 Multilingual TTS** — DragonHD voices across 10+ languages, Cosmos-cached translations via GPT-4.1
- **❓ Slide Q&A** — RAG with in-memory vector search (numpy + embeddings)
- **🎥 Real-Time Streaming** — WebRTC low-latency video/audio for the live avatar
- **🖼️ Slide Rendering** — High-quality PNG generation from PPTX via LibreOffice headless + Poppler
- **🚀 One-Click Deployment** — Deploy to Azure Container Apps with `azd up`
- **📎 Teams Integration** — Embed as a Microsoft Teams Static Tab with theme support (dark/light/contrast)
- **🔒 Hybrid exposure** — anonymous visitors browse the *published* library; everything else requires a Microsoft Entra ID sign-in on an allowlist

---

## 📸 Screenshots

**Live avatar demo** — anyone can try it on the decks marked *Live demo* (narrated, time-boxed, no sign-in):

![Live avatar demo: Sofia, a photo avatar, presents the current slide, with the demo countdown and the Stop control](docs/screenshots/live-demo.png)

| Home | Narrated slide video | Two-avatar podcast |
|---|---|---|
| ![Oz Radio home page: the tagline, the hosts Sofia and Lucas, and the live-demo call to action](docs/screenshots/home.png) | ![Narrated video frame: slide with a photo avatar narrating and burned-in subtitles](docs/screenshots/video-frame.png) | ![Podcast frame: two photo-avatar hosts and subtitles in a top band above the slide](docs/screenshots/podcast-frame.png) |

| Published video library | Decks | Slide viewer |
|---|---|---|
| ![Video library with published videos](docs/screenshots/video-library.png) | ![Decks catalog with the live avatar demo banner and the published AI decks](docs/screenshots/decks.png) | ![Read-only slide viewer](docs/screenshots/slide-viewer.png) |

The avatars shown are custom **photo avatars** (one portrait each, animated by Azure AI Speech). Out of the box the app uses the stock Azure avatars (Lisa, Harry, …); see [Custom photo avatars](#custom-photo-avatars-optional).

---

## 🏗️ Architecture

```
┌───────────────────────────┐      ┌──────────────────────────────┐      ┌──────────────────────────────┐
│   Browser / Teams Tab      │      │   FastAPI Backend             │      │     Azure Services            │
│   React 19 SPA             │      │   (Python 3.12 · Uvicorn)    │      │                              │
│                            │      │                              │      │  Azure AI Speech              │
│  ┌──────────────────────┐  │      │  ┌────────────────────────┐  │      │   ├─ VoiceLive Avatar (WS)   │
│  │ Home (/)             │  │      │  │ routers/               │  │      │   ├─ DragonHD TTS            │
│  │ Live (/live)         │  │ HTTP │  │  app.py  (Live, WS)    │─────────▶│   └─ Batch Avatar           │
│  │  SlideViewer,        │◀─┼─────▶│  │  decks.py   (Decks)    │  │      │                              │
│  │  AvatarPanel, QA     │  │  &   │  │  playlists.py          │  │      │  Azure OpenAI                │
│  │                      │  │ WSS  │  │  video.py   (Video)    │─────────▶│   ├─ GPT-4.1                │
│  │ Decks, Search,       │  │      │  │  podcast.py (Podcast)  │  │      │   └─ text-embedding-3-small  │
│  │  Playlists, Player   │  │      │  └────────────────────────┘  │      │                              │
│  │                      │  │      │  ┌────────────────────────┐  │      │  Azure AI Search             │
│  │ Video (/video)       │  │      │  │ services/              │  │      │   └─ decks (hybrid)          │
│  │  Create + Library    │  │      │  │  pptx_parser, voice,   │─────────▶│                             │
│  │                      │  │      │  │  qa, translation,      │  │      │  Azure Cosmos DB (Serverless)│
│  │ Podcast (/podcast)   │  │      │  │  deck_search,          │  │      │   ├─ presentations           │
│  │  Create + Library    │  │      │  │  video_* (×6),         │  │      │   │  (decks + playlists)     │
│  └──────────────────────┘  │      │  │  podcast_* (×13),      │  │      │   └─ playlist_progress       │
│                            │      │  │  storage               │─────────▶│  Azure Blob Storage         │
└───────────────────────────┘      │  └────────────────────────┘  │      │   └─ PPTX + slides + media   │
                                    │           │                  │      │                              │
                                    │  ┌────────▼─────────────┐   │      │  Azure Container Apps + ACR  │
                                    │  │ LibreOffice + Poppler │   │      │  Log Analytics               │
                                    │  │ PPTX → PDF → PNG      │   │      └──────────────────────────────┘
                                    │  │ ffmpeg (video/podcast)│   │
                                    │  └──────────────────────┘   │
                                    └──────────────────────────────┘
```

---

## 🔒 Security model

The deployed app uses a **hybrid exposure** model, enforced by the backend (default deny):

| Caller | Can do |
|---|---|
| **Anonymous** | Load the SPA, `GET /api/health`, `GET /api/me`, `GET /api/avatars`; list and play **published** videos and podcasts, and read the captions of published videos (when `PODCAST_PUBLIC_AUDIO=true`, also stream a published podcast's radio audio and read its transcript); view **published** decks (slide images, titles and the visible slide text — never speaker notes, translations or the PPTX download); when enabled, run the **live demo** on decks marked *Live demo* |
| **Signed-in + allowlisted** (admin) | Everything else: uploads, live avatar (`/ws/voice`), batch avatar renders, script generation, translation, agent chat, playlist recommendation, playlists/progress, publish/unpublish, live-demo flag, deletes, unpublished items and full details |

- **Sign-in** is handled by **Microsoft Entra ID** through Azure Container Apps built-in authentication (**Easy Auth**). The backend trusts the `X-MS-CLIENT-PRINCIPAL*` headers injected by the platform only when `AUTH_MODE=easyauth`, checks the tenant (`AUTH_TENANT_ID`) and requires the caller's Entra **object ID** to be in `ALLOWED_OBJECT_IDS`. On Azure Container Apps the backend refuses `AUTH_MODE=disabled`: it keeps Easy Auth and logs one `CRITICAL` line.
- Gated endpoints return **401** when anonymous and **403** when signed-in but not allowlisted. The live-avatar WebSocket is authorized (and its `Origin` checked) before the connection is accepted.
- Nothing is public by default: generated videos, podcasts and decks start **unpublished**; an admin publishes them explicitly. Anonymous media links are read-only, blob-scoped SAS URLs that expire after 15 minutes; public thumbnails and covers are signed per 10-minute window, so the browser cache can reuse them.
- **Public podcast audio (off by default):** with `PODCAST_PUBLIC_AUDIO=true`, anonymous visitors of a *published* podcast also get its radio MP3, cover art, host names and full transcript (live captions), and audio-only episodes are listed. Subtitle files (SRT), SCORM packages and scripts stay admin-only; published video episodes expose their captions as WebVTT. Speech character names never appear in media, ID3 tags, manifests, logs or API payloads. See [docs/podcast.md](docs/podcast.md#61-public-access).
- Abuse / cost guards: concurrent live-avatar sessions (`MAX_VOICE_SESSIONS`), per-session duration cap, per-user daily generation quota and a global render queue limit. The Azure Voice Live connection is closed as soon as the browser disconnects.
- **Public live demo (off by default):** with `PUBLIC_DEMO_ENABLED=true`, anonymous visitors can run the
  live avatar on decks an admin has published and marked **Live demo** (`/ws/voice/demo`). The avatar speaks the
  stored notes; there are no pickers and no uploads. The client sends a slide index to narrate and, only with
  `DEMO_QA_ENABLED=true`, a question (typed or spoken), which is answered only from the deck.
- Guardrails: 1 concurrent session (separate from admin), 180 s hard cap, 20 sessions/day globally and 3 per IP, 60 streaming minutes/day,
  ≤ 2× slides narrations (max 40), 1 s rate limit, same-origin check, settings fixed server-side.
- Daily budget is durable (Cosmos, survives restarts/scale-to-zero, fails closed); worst case ≈ `DEMO_DAILY_MINUTES` (60) avatar-minutes/day.
  Details: [docs/live-demo.md](docs/live-demo.md).
- **Telemetry (off by default):** a cookieless telemetry module ships disabled (`TELEMETRY_ENABLED`).

> ⚠️ **Cost warning** — live avatar streaming and batch avatar synthesis are billed by Azure AI Speech **per minute of video**, and GPT-4.1 / embeddings are billed per token. Keep the allowlist small, keep the session limits low, and set `BUDGET_CONTACT_EMAILS` so the Bicep templates provision a **budget alert** (see [Azure Deployment](#️-azure-deployment)). Production runs one warm replica (`MIN_REPLICAS=1`: about $47/month at idle rates, up to about $158/month if never idle, so raise `BUDGET_AMOUNT` with it). The template default, `MIN_REPLICAS=0`, scales to zero and keeps idle cost near zero; see [infra/README.md](infra/README.md#always-on-min_replicas).

See [SECURITY.md](SECURITY.md) for vulnerability reporting and the operator checklist.

---

## 🛠️ Tech Stack

| Layer            | Technology                                                  |
| ---------------- | ----------------------------------------------------------- |
| **Frontend**     | React 19, TypeScript, Vite 8                                |
| **Backend**      | Python 3.12, FastAPI, Uvicorn, Gunicorn                     |
| **AI / Speech**  | Azure AI Speech (VoiceLive Avatar API, DragonHD TTS, Batch Synthesis) |
| **AI / LLM**     | Azure OpenAI — GPT-4.1 (chat, translation, scripts, playlist recommend JSON mode), text-embedding-3-small |
| **AI / Search**  | Azure AI Search (optional, not provisioned by `infra/`) — hybrid vector + keyword for the deck catalog (`decks` index); default deployment uses local search (`USE_LOCAL_SEARCH=true`) |
| **AI / Agent**   | Function-calling agent (translate, Q&A, SSML generation)    |
| **Slide Render** | LibreOffice Impress (headless) → PDF → pdf2image (Poppler)  |
| **Video/Audio**  | ffmpeg + ffprobe — video slide compose, podcast compose and radio mix (two-pass loudnorm, MP3 + ID3), SRT generation |
| **Vector Search**| Azure AI Search (deck catalog) + in-memory numpy cosine similarity (Live page Q&A) |
| **Persistence**  | Azure Cosmos DB (Serverless) — `presentations` (`/id`) + `playlist_progress` (`/user_id`) — and Azure Blob Storage (SAS URLs) |
| **Auth**         | Users: Microsoft Entra ID via Container Apps Easy Auth + object-ID allowlist · Services: Managed Identity (`DefaultAzureCredential`) |
| **Infra**        | Azure Container Apps, ACR, Bicep IaC, Azure Developer CLI (`azd`) |
| **Teams**        | `@microsoft/teams-js` SDK, Static Tab manifest (v1.17)      |
| **Containerization** | Docker (multi-stage build)                              |

---

## 📋 Prerequisites

| Requirement                  | Version  | Notes                                          |
| ---------------------------- | -------- | ---------------------------------------------- |
| **Python**                   | 3.12+    | Required                                       |
| **Node.js**                  | 18+      | Required for frontend build                    |
| **Azure CLI**                | Latest   | Required — `az login` before running            |
| **Azure Subscription**       | —        | With AI Speech & OpenAI resources provisioned  |
| **LibreOffice**              | 7.x+     | Optional — needed for PPTX → PNG rendering     |
| **Poppler**                  | Latest   | Optional — needed for PDF → PNG conversion     |
| **Azure Developer CLI (azd)**| Latest   | Optional — needed for `azd up` deployment      |

---

## 🚀 Quick Start

### Windows (recommended)

The included PowerShell script starts both backend and frontend with a single command:

```powershell
# 1. Clone the repository
git clone https://github.com/ozgurkarahan/oz-radio.git
cd oz-radio

# 2. Copy and configure environment variables
cp demos/backend/.env.example demos/backend/.env
# Edit demos/backend/.env with your Azure credentials

# 3. Run the local development script (sets AUTH_MODE=disabled for local dev)
./run-local.ps1

# Skip dependency installation on subsequent runs
./run-local.ps1 -SkipInstall
```

This will:
- Set `AUTH_MODE=disabled` for the backend process — **local dev only**: every caller is treated as admin (the backend logs a warning at startup). On Azure Container Apps the backend refuses it.
- Create a Python virtual environment and install dependencies
- Install Node.js packages and build the frontend
- Start the FastAPI backend on **http://localhost:8000**
- Start the Vite dev server on **http://localhost:5173**
- Open your browser automatically

### Manual Setup (macOS / Linux)

```bash
# Backend
cd demos/backend
python3.12 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # configure your Azure credentials
export AUTH_MODE=disabled   # local dev only — never in Azure
uvicorn app:app --reload --port 8000

# Frontend (in a new terminal)
cd demos/frontend
npm install
npm run dev
```

Open **http://localhost:5173** in your browser.

> **Swagger UI** is available at **http://localhost:8000/docs**

---

## 🔐 Environment Variables

Create a `.env` file in `demos/backend/` (see `.env.example`):

| Variable                           | Required | Default          | Description                                      |
| ---------------------------------- | -------- | ---------------- | ------------------------------------------------ |
| `AZURE_SPEECH_KEY`                 | Yes*     | —                | Azure AI Speech API key                          |
| `AZURE_SPEECH_REGION`              | Yes      | `swedencentral`  | Azure region for Speech service                  |
| `AZURE_SPEECH_ENDPOINT`            | Yes      | —                | Full endpoint URL for AI Speech                  |
| `AZURE_SPEECH_RESOURCE_ID`         | Yes      | —                | Full ARM resource ID for Speech service          |
| `AZURE_OPENAI_ENDPOINT`            | Yes      | —                | Azure OpenAI endpoint URL                        |
| `AZURE_OPENAI_KEY`                 | Yes*     | —                | Azure OpenAI API key                             |
| `AZURE_OPENAI_CHAT_DEPLOYMENT`     | Yes      | `gpt-4.1`       | Chat model deployment name                       |
| `AZURE_OPENAI_EMBEDDING_DEPLOYMENT`| Yes      | `text-embedding-3-small` | Embedding model deployment name          |
| `AZURE_USE_MANAGED_IDENTITY`       | No       | `true`           | Use `DefaultAzureCredential` instead of keys     |
| `LIBREOFFICE_PATH`                 | No       | `soffice`        | Path to LibreOffice binary                       |

> **\*** Not required when `AZURE_USE_MANAGED_IDENTITY=true` and running in Azure with Managed Identity.

**Security, exposure & limits** (set automatically by the Bicep templates in Azure; only `AUTH_MODE=disabled` is needed locally):

| Variable | Default | Description |
| -------- | ------- | ----------- |
| `AUTH_MODE` | `easyauth` | `easyauth` trusts Container Apps Easy Auth headers; `disabled` is for **local dev only** (every caller is admin, a warning is logged). On Container Apps (`CONTAINER_APP_NAME` or `CONTAINER_APP_REVISION` set by the platform) `disabled` is refused: the backend keeps `easyauth` and logs one `CRITICAL` line |
| `AUTH_TENANT_ID` | — (required in `easyauth`) | Entra tenant GUID; the caller's `tid` claim must match |
| `ALLOWED_OBJECT_IDS` | empty ⇒ nobody is admin | Comma-separated Entra object IDs (`oid`) allowed as admin |
| `AUTH_CLIENT_ID` / `AUTH_CLIENT_SECRET` | — | Entra app registration used by Easy Auth (infra only — the backend does not read them) |
| `ALLOWED_ORIGINS` | empty ⇒ same-origin only | Extra comma-separated origins for CORS and the WebSocket `Origin` check (same-origin is always allowed) |
| `FRAME_ANCESTORS` | `'self'` + Teams / Office hosts | CSP `frame-ancestors` list (Teams tab embedding) |
| `ENABLE_URL_INGEST` | `false` | Allow URL ingestion for podcasts |
| `CUSTOM_AVATARS_JSON` | empty ⇒ stock avatars only | JSON array of custom photo avatars (see below) |
| `HIDE_STOCK_AVATARS` | `false` | `true` + at least one custom avatar ⇒ only custom avatars are offered; stock ids map to a same-gender custom avatar |
| `MAX_VOICE_SESSIONS` | `2` | Global concurrent live-avatar (`/ws/voice`) sessions |
| `MAX_VOICE_SESSION_SECONDS` | `900` | Hard cap per live-avatar session |
| `DAILY_GENERATION_QUOTA` | `50` | Renders + uploads + chats per signed-in user per UTC day |
| `MAX_PENDING_RENDERS` | `3` | Global queued/running render jobs |
| `MAX_CONCURRENT_COMPOSES` | `1` | Podcast compose steps (ffmpeg) running at once |
| `MAX_ACTIVE_BATCH_JOBS` / `SPEECH_BATCH_CREATE_PER_MIN` | `8` / `2` | Batch avatar jobs active at once (podcast turns + listener kits) / job creations per rolling minute (Speech quota ≈ 2) |
| `PODCAST_PUBLIC_AUDIO` | `false` | Anonymous visitors of published podcasts can stream the radio audio (15-min SAS) and read the transcript; audio-only episodes become public |
| `PODCAST_REACTIONS` | `false` | Kill switch for listener backchannels ("mm-hmm", "right") in new podcast renders |
| `PODCAST_LISTENER_MODE` | `auto` | Listening host in video podcasts: `auto` / `idle_loop` (cached idle loop, else sway), `procedural` (sway on a still), `still` |
| `PODCAST_LISTENER_TIMEOUT_SEC` | `900` | How long a video render waits for the listener kits before the fallback listener (min 30) |
| `AZURE_SEARCH_KEY` | absent | Optional; when absent Azure AI Search uses `DefaultAzureCredential` (managed identity) |
| `PUBLIC_DEMO_ENABLED` | `false` | Kill switch for the anonymous live avatar demo (`/ws/voice/demo`) — see [docs/live-demo.md](docs/live-demo.md) |
| `DEMO_MAX_CONCURRENT` | `1` | Concurrent anonymous demo sessions (global, separate from `MAX_VOICE_SESSIONS`) |
| `DEMO_SESSION_SECONDS` | `180` | Hard cap per demo session |
| `DEMO_DAILY_SESSIONS` | `20` | Demo sessions per UTC day, global (`0` blocks all) |
| `DEMO_DAILY_SESSIONS_PER_IP` | `3` | Demo sessions per UTC day per client IP |
| `DEMO_DAILY_MINUTES` | `60` | Hard cap on total demo streaming minutes per UTC day |
| `DEMO_MAX_SPEAKS` | `0` | Narrations per demo session; `0` = 2 × slide count (never above 40) |
| `DEMO_QUOTA_EXEMPT_IPS` | empty | Client IPs/CIDRs exempt from the demo daily quotas (keep out of git) |
| `DEMO_QA_ENABLED` | `false` | Raise-hand voice and typed Q&A in the public demo (also needs `PUBLIC_DEMO_ENABLED=true`; admins always have it) — see [docs/provisioning.md §6.3](docs/provisioning.md#63-voice-qa-in-the-public-demo-demo_qa_enabled) |
| `DEMO_QA_MAX_QUESTIONS` | `2` | Questions per demo session |
| `DEMO_QA_SESSION_SECONDS` | `300` | Demo session cap used instead of `DEMO_SESSION_SECONDS` when demo Q&A is on |
| `DEMO_QA_DAILY_MAX` / `DEMO_QA_DAILY_PER_IP` | `40` / `6` | Demo questions per UTC day, global / per client IP |

### Custom photo avatars (optional)

Stock avatars (`lisa`, `harry`, `max`, `meg`, …) are available unless `HIDE_STOCK_AVATARS=true` and at least one custom avatar is configured. To add custom photo avatars, set `CUSTOM_AVATARS_JSON` and drop the thumbnails in `demos/backend/static/avatars/` (that folder is git-ignored — avatar photos are never committed). In `azd env set`, escape every `"` as `\"` — see [docs/provisioning.md §4.1](docs/provisioning.md#41-custom-photo-avatars-optional):

```json
[
  {"id": "photo_female", "display_name": "Photo avatar (F)", "character": "<speech-avatar-character>", "gender": "female", "thumbnail": "photo_female.png", "default": true},
  {"id": "photo_male",   "display_name": "Photo avatar (M)", "character": "<speech-avatar-character>", "gender": "male",   "thumbnail": "photo_male.png",   "default": false}
]
```

`character` is the server-only Azure Speech `talkingAvatarCharacter`; `GET /api/avatars` never exposes it.

---

## 🐳 Docker

The project uses a multi-stage Dockerfile: Node.js builds the frontend, Python serves everything.

```bash
# Build the image
docker build -t oz-radio .

# Run the container locally (AUTH_MODE=disabled = local only, never expose it)
docker run -p 127.0.0.1:8000:8000 \
  -e AUTH_MODE=disabled \
  -e AZURE_SPEECH_KEY=<your-key> \
  -e AZURE_SPEECH_REGION=swedencentral \
  -e AZURE_SPEECH_ENDPOINT=https://<name>.cognitiveservices.azure.com/ \
  -e AZURE_SPEECH_RESOURCE_ID=/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.CognitiveServices/accounts/<name> \
  -e AZURE_OPENAI_ENDPOINT=https://<name>.openai.azure.com/ \
  -e AZURE_OPENAI_KEY=<your-key> \
  -e AZURE_OPENAI_CHAT_DEPLOYMENT=gpt-4.1 \
  -e AZURE_OPENAI_EMBEDDING_DEPLOYMENT=text-embedding-3-small \
  oz-radio
```

The container includes LibreOffice and Poppler for full slide rendering support. The app runs on port **8000** with Gunicorn (4 workers).

---

## ☁️ Azure Deployment

Deploy to Azure Container Apps using the [Azure Developer CLI](https://learn.microsoft.com/en-us/azure/developer/azure-developer-cli/):

> 📘 **Full provisioning runbook:** [docs/provisioning.md](docs/provisioning.md) covers the components, prerequisites (permissions, providers, region, quota and policy), the Entra app registration, every azd variable, troubleshooting and teardown.
> 🤖 **Coding agents:** follow [BOOTSTRAP.md](BOOTSTRAP.md), or run the `/deploy` prompt (`.github/prompts/deploy.prompt.md`).

Before the first deployment, create a **Microsoft Entra ID app registration** for sign-in (web platform, redirect URI `https://<your-app-fqdn>/.auth/login/aad/callback`, ID tokens enabled) and a client secret, then:

```bash
# Authenticate
azd auth login
azd env new <env-name>

# Required — the preprovision hook fails if any of these is missing
azd env set AUTH_CLIENT_ID <app-registration-client-id>
azd env set AUTH_CLIENT_SECRET <app-registration-client-secret>
azd env set ALLOWED_OBJECT_IDS <entra-object-id>[,<entra-object-id>...]

# Recommended — monthly budget alert on the resource group (no budget is deployed without recipients)
azd env set BUDGET_CONTACT_EMAILS you@example.com
azd env set BUDGET_AMOUNT 50   # default; raise it when MIN_REPLICAS=1 (see below)

# Recommended for production — one warm replica, no cold start (about $47/month at idle rates).
# The template default is 0 (scale to zero); see infra/README.md#always-on-min_replicas
azd env set MIN_REPLICAS 1

# Optional — custom photo avatars (see "Custom photo avatars" above)
# quotes must be backslash-escaped: azd substitutes the value verbatim into infra/main.parameters.json
azd env set CUSTOM_AVATARS_JSON '[{\"id\":\"photo_female\",\"display_name\":\"Photo avatar (F)\",\"character\":\"<speech-avatar-character>\",\"gender\":\"female\",\"thumbnail\":\"photo_female.png\",\"default\":true}]'

# Provision infrastructure and deploy
azd up
```

Find your object ID with `az ad signed-in-user show --query id -o tsv`. After the first `azd up`, add the app's FQDN redirect URI to the app registration if you did not know it up front.

The Bicep templates in `infra/` provision:
- **Azure Container App** with managed identity + **Container Registry** (`azd deploy` pushes the image to the `oz-radio/backend-<env>` repository)
- **Azure Cosmos DB** (Serverless) for presentation persistence
- **Azure Blob Storage** for slide images and PPTX files
- **Azure AI Services** (Speech/Avatar) and **Azure OpenAI** with model deployments
- **RBAC role assignments** for managed identity access to all services
- **Log Analytics** workspace for container monitoring
- **Easy Auth** (Microsoft Entra ID) on the Container App with anonymous access allowed, so the backend can apply the hybrid model
- A monthly **budget alert** on the resource group (80 % actual / 100 % forecast) when `BUDGET_CONTACT_EMAILS` is set

Production runs one warm replica (`MIN_REPLICAS=1`, set in the azd environment). The Bicep default is `MIN_REPLICAS=0`: the app scales to zero when idle, which also avoids stale Azure Speech/WebRTC sessions after demos. See [infra/README.md](infra/README.md#always-on-min_replicas) and [docs/provisioning.md §10](docs/provisioning.md#10-cost-notes-and-teardown).

> Configure deployment parameters in `infra/main.parameters.json` before running `azd up`.

Keep `AUTH_MODE=easyauth` (the default) in Azure — never deploy with `AUTH_MODE=disabled`. The backend refuses it on Container Apps anyway; admin tests against production use Entra bearer tokens ([docs/provisioning.md §3.1](docs/provisioning.md#31-admin-tests-against-production)).

For parallel deployments (a second azd environment), see [docs/deploy-copilot.md](docs/deploy-copilot.md).

---

## 📎 Teams Integration

The app can be embedded in Microsoft Teams as a **Static Tab**:

```powershell
# Package the Teams app (after deploying to Azure)
.\scripts\package-teams-app.ps1 -Hostname "<your-container-app-fqdn>"
```

Then sideload `teams-app-package.zip` in Teams:
1. Open **Teams → Apps → Manage your apps → Upload an app**
2. Select **Upload a custom app** and choose the generated `.zip`
3. The app appears as a personal tab — "Oz Radio"

**Teams features:**
- Automatic theme adaptation (light, dark, high-contrast)
- Compact layout optimized for Teams tab viewport
- CSP headers configured for Teams iframe embedding

---

## 📡 API Reference

Unless marked 🌐 (anonymous), endpoints require a signed-in, allowlisted caller (401 anonymous / 403 not allowlisted). Anonymous list/detail calls only return **published** items, as public DTOs.

### Identity, avatars & publishing

| Method | Endpoint | Description |
| ------ | -------- | ----------- |
| `GET`  | `/api/me` 🌐 | `{"authenticated", "is_admin", "name", "auth_mode"}` |
| `GET`  | `/api/avatars` 🌐 | Available avatars (`id`, `display_name`, `gender`, `thumbnail_url`, `is_default`) |
| `GET`  | `/.auth/login/aad?post_login_redirect_uri=<path>` | Sign in (Easy Auth) |
| `GET`  | `/.auth/logout?post_logout_redirect_uri=/` | Sign out (Easy Auth) |
| `POST` | `/api/video/library/{job_id}/publish` | Publish / unpublish a video — body `{"published": true\|false}` |
| `POST` | `/api/podcast/library/{job_id}/publish` | Publish / unpublish a podcast |
| `POST` | `/api/decks/{deck_id}/publish` | Publish / unpublish a deck |
| `POST` | `/api/decks/{deck_id}/live-demo` | Allow / stop the anonymous live demo on a published deck — body `{"enabled": true\|false}` |
| `GET`  | `/api/demo/config` 🌐 | `{"enabled", "session_seconds", "remaining_today"?, "qa": {"enabled", "max_questions", "max_audio_seconds"}}` |

### Live — single-deck presenter

| Method | Endpoint                       | Description                              |
| ------ | ------------------------------ | ---------------------------------------- |
| `POST` | `/api/upload`                  | Upload a `.pptx` file for processing     |
| `GET`  | `/api/presentations`           | List all uploaded presentations          |
| `GET`  | `/api/slides/{id}`             | Get slide data for a presentation        |
| `GET`  | `/api/slides/{id}/{n}.png`     | Serve a rendered slide image (PNG)       |
| `DELETE`| `/api/presentations/{id}`     | Delete presentation + assets             |
| `POST` | `/api/presentations/{id}/translate-notes` | Batch-translate notes (cached) |
| `POST` | `/api/translate`               | Translate text to a target language       |
| `POST` | `/api/avatar/batch`            | Start batch avatar video synthesis       |
| `POST` | `/api/qa`                      | Ask a question about slide content (RAG) |
| `WS`   | `/ws/voice`                    | WebSocket proxy for VoiceLive avatar (+ raise-hand `qa.*` voice Q&A when a deck is bound) |
| `WS`   | `/ws/voice/demo?deck_id=<uuid>` 🌐 | Public live demo (only when `PUBLIC_DEMO_ENABLED=true`, live-demo decks only): protocol v2 (captions, `demo.finish`, typed questions with `qa.ask_text`); raise-hand Q&A when `DEMO_QA_ENABLED=true`. Close codes: [docs/live-demo.md](docs/live-demo.md#close-codes-and-outcomes) |

### Decks, Search & Playlists

| Method | Endpoint                                      | Description                                                                       |
| ------ | --------------------------------------------- | --------------------------------------------------------------------------------- |
| `POST` | `/api/decks/upload`                           | Ingest a `.pptx` into the catalog (Azure AI Search indexing)                      |
| `GET`  | `/api/decks` 🌐                               | List decks (returns `deck_id`, not `id`); anonymous callers see published decks only, with `audience_level` and the display title |
| `GET`  | `/api/decks/{deck_id}` 🌐                     | Deck with slides (anonymous: published only; each slide has `index`, `title`, `image_url` and the visible `text`, never notes; `filename` is the display title) |
| `DELETE`| `/api/decks/{deck_id}?force=true`            | Remove a deck from catalog + index (`force` breaks referencing playlists)         |
| `POST` | `/api/search`                                 | Hybrid vector + keyword search across all decks                                   |
| `POST` | `/api/playlists`                              | Create a playlist (ordered multi-deck sequence)                                   |
| `GET`  | `/api/playlists`                              | List playlists                                                                    |
| `GET`  | `/api/playlists/{id}`                         | Get a playlist with hydrated deck info                                            |
| `PUT`  | `/api/playlists/{id}`                         | Update a playlist                                                                 |
| `DELETE`| `/api/playlists/{id}`                        | Delete a playlist                                                                 |
| `GET` / `POST` | `/api/playlists/{id}/progress`        | Read / update the caller's progress (resume slide, completed slides)              |
| `POST` | `/api/playlists/recommend`                    | **AI playlist recommendation** — GPT-4.1 JSON mode picks a coherent deck sequence for a topic+language (no persistence) |

### Video & Podcast

| Method | Endpoint                                      | Description                                                                       |
| ------ | --------------------------------------------- | --------------------------------------------------------------------------------- |
| `POST` | `/api/video/ingest`                           | Ingest PPTX / PDF / image → slide list                                            |
| `POST` | `/api/video/script/{doc_id}`                  | Streaming NDJSON script generation (GPT-4.1)                                      |
| `POST` | `/api/video/render/{doc_id}`                  | Start render job (batch avatar + ffmpeg compose)                                  |
| `GET`  | `/api/video/jobs/{job_id}`                    | Poll job state                                                                    |
| `GET`  | `/api/video/jobs/{job_id}/file/{kind}`        | Local fallback download `mp4` / `mp3` / `srt` / `thumb` / `scorm`                  |
| `GET`  | `/api/video/library` 🌐                       | Video library (anonymous: published only; items carry `audience_level`, `source_deck_id` and `captions_vtt_url`; `503 Library temporarily unavailable` when storage fails) |
| `GET`  | `/api/video/library/{job_id}` 🌐              | Video with fresh SAS URLs (anonymous: MP4 + thumbnail only)                       |
| `GET`  | `/api/video/library/{job_id}/captions.vtt` 🌐 | WebVTT captions of a published video (`text/vtt`; 404 when there are none). Not on by default in the player: the picture already has burned-in captions |
| `POST` | `/api/podcast/ingest`                         | Ingest a document into a podcast-ready Document                                   |
| `POST` | `/api/podcast/script/stream`                  | SSE dialogue generation (2-speaker)                                               |
| `POST` | `/api/podcast/render`                         | Start a render job — body adds `format` (`video` = MP4 + radio MP3, `audio` = radio MP3 only, no avatars) and `reactions` (backchannels, also gated by `PODCAST_REACTIONS`) |
| `GET`  | `/api/podcast/jobs/{job_id}`                  | Poll podcast job state (stage, outputs, warning codes)                            |
| `GET`  | `/api/podcast/jobs/{job_id}/file/{kind}`      | Local fallback download `mp4` / `mp3` / `srt` / `audio_srt` / `transcript` / `cover` / `scorm` (404 when the format has no such rendition) |
| `GET`  | `/api/podcast/library` 🌐                     | Podcast library (anonymous: published only; audio-only episodes only with `PODCAST_PUBLIC_AUDIO=true`; items carry `audience_level`, `source_deck_id` and `captions_vtt_url`; `503 Library temporarily unavailable` when storage fails) |
| `GET`  | `/api/podcast/library/{job_id}` 🌐            | Podcast with fresh SAS URLs + transcript (anonymous: MP4 + thumbnail; plus radio MP3, cover and transcript with `PODCAST_PUBLIC_AUDIO=true`) |
| `GET`  | `/api/podcast/library/{job_id}/captions.vtt` 🌐 | WebVTT captions of a published video episode (audio-only episodes: 404)          |
| `GET`  | `/api/health` 🌐                              | Health check                                                                      |

> Full interactive API documentation is available at `/docs` (Swagger UI) when the server is running.

---

## 🧪 Testing

The repository ships two end-to-end runners that drive a real backend wired to Azure (Speech, OpenAI, Cosmos, ffmpeg compose). They are standalone scripts, not pytest, so the output is demo-friendly.

All suites target **local dev** started with `./run-local.ps1` (`AUTH_MODE=disabled`, so uploads/renders/deletes work without sign-in). Set the target with `AI_PRESENTER_BASE_URL` (default `http://localhost:8000` for the Python suites, `http://localhost:5173` for Playwright). Against a deployed instance the gated endpoints return 401/403. ⚠️ `e2e_full.py` **deletes every deck, playlist and library item** on the target before it starts (use `--skip-reset` to keep them).

| Script | Scope | Last validated |
|---|---|---|
| `tests/e2e_full.py` | Reset DB → upload 9 fixture decks → decks / search / playlists / progress / AI recommend → video & podcast smoke | 30/30 passed |
| `tests/e2e_render.py` | Full render pipeline for the video (PPTX → MP4) and the podcast (PPTX → MP3) including TTS + compose. Accepts `--languages fr-FR,en-US,es-ES` to sweep the three thematic groups. | 30/30 passed multi-language (fr-FR, en-US, es-ES × video + podcast × ingest/script/render/download, ~30 min total) |

```powershell
# Run the fixture+smoke suite (cheap, ~1 min)
python tests/e2e_full.py --base-url http://localhost:8000

# Run the full render suite — English only (~10 min + TTS tokens)
python tests/e2e_render.py --base-url http://localhost:8000

# Multi-language render sweep (~30 min + 3× TTS cost)
python tests/e2e_render.py --base-url http://localhost:8000 --languages fr-FR,en-US,es-ES

# Regenerate the 9 fixture decks from source-of-truth Python
python tests/fixtures/samples/_generate.py
```

Fixtures live in `tests/fixtures/samples/` — 3 coherent thematic groups (Safety FR, Generative AI EN, AI in industry ES), 3 decks each, 5 slides each with 2-sentence speaker notes. See `tests/fixtures/samples/README.md`. The 6 single-topic decks in `tests/fixtures/decks/` are generated by `python scripts/make_multideck_test.py`.

### Seeding a deployed showcase library

`scripts/video_regen.py` and `scripts/podcast_regen.py` rebuild the video / podcast libraries from the sample decks. Against a deployed instance they authenticate as an allowlisted user with an Entra ID access token (the Azure CLI client must be listed in `AUTH_EXTRA_CLIENT_APPS` and pre-authorized on the app registration):

```powershell
$env:AI_PRESENTER_BASE_URL = "https://<your-app>.<env>.<region>.azurecontainerapps.io"
$env:AI_PRESENTER_TOKEN_COMMAND = "az account get-access-token --scope api://<app-client-id>/user_impersonation --query accessToken -o tsv"
$env:AI_PRESENTER_BEARER_TOKEN = (Invoke-Expression $env:AI_PRESENTER_TOKEN_COMMAND)
python scripts/video_regen.py --no-delete
python scripts/podcast_regen.py --no-delete --avatar-female photo_female --avatar-male photo_male
```

Renders are never auto-published — publish the items you want visitors to see from the library pages (or `POST /api/{video|podcast}/library/{job_id}/publish`).

Inside the app container, the operator CLI `python -m maintenance.content` seeds the AI enablement catalog and renders its episodes with the app's managed identity (no HTTP, no sign-in). Renders are published unless `--unpublished` is given, and a new version can be reviewed before visitors see it: `script-podcast` / `script-video` write the script for review, `render-* --from-script FILE --force --unpublished` renders exactly that script privately, `plan-switch` / `switch` / `rollback` move visitors to the new renders through a manifest (nothing is deleted), and `publish` / `unpublish` change single items. See [docs/podcast.md §4.4](docs/podcast.md#44-operator-cli) and [content/ai-enablement/README.md](content/ai-enablement/README.md).

Unit + Playwright suites:

```powershell
# Backend unit tests (no Azure needed)
cd demos/backend && pytest tests

# Live API pytest against local dev (decks + playlists incl. AI recommend)
$env:AI_PRESENTER_BASE_URL = "http://localhost:8000"
pytest tests/test_decks_api.py tests/test_playlists_api.py

# Frontend Playwright (decks + playlists UI) against the Vite dev server
$env:AI_PRESENTER_BASE_URL = "http://localhost:5173"
npx playwright test tests/decks.spec.ts tests/playlists.spec.ts --project=chromium
```

### Phone listening: regression, emulated phones, production smoke

The mocked suites run from the repository root against the Vite dev server alone (`AI_PRESENTER_BASE_URL`, default `http://localhost:5173`): every `/api` call is answered by `tests/support/mock-api.ts` and the media are real fixtures served with byte ranges (`tests/fixtures/media`), so audio genuinely plays — no backend, no Azure.

| Script | Projects | What it covers |
|---|---|---|
| `npm run test:regression` | `chromium` (desktop; the phone tests emulate a 390 × 844 touch phone themselves) | Site regression, podcast library Watch/Listen and studio, plus the phone listening suites: persistent player and mini-player (`playback-engine`), resume and speed (`playback-resume`), auto-next (`playback-continuity`), safe areas, overflow and 16 px controls (`mobile-platform`), `?debug=player` (`player-debug`), listen-first rows (`listen-first`) and accessibility (`mobile-a11y`: axe WCAG 2.2 AA with zero serious/critical violations on the library, the Listen sheet and Home with the mini-player; transport buttons ≥ 44 × 44 px; focus never hidden behind the mini-player) |
| `npm run test:mobile` | `mobile-webkit` (iPhone 15, WebKit) + `mobile-chromium` (Pixel 7) | The same phone listening specs (`playback-*`, `mobile-*`, `listen-first`, `player-debug`) on emulated phones |
| `npm run test:prod-smoke` | `mobile-chromium`, against production | Read-only deploy check, **skipped unless `OZ_RADIO_PROD_SMOKE=1`** (below) |

Emulation is not a phone. The phone projects give the real engines a mobile user agent, pixel ratio, meta viewport, touch and `(hover: none) and (pointer: coarse)`; they do **not** reproduce iOS autoplay rules (the one-tap user-activation budget), the lock screen / Control Center / Android media notification, background audio with the screen off, AirPods or call interruptions, or Safari's dynamic toolbars — those are proven on real phones (device script with `?debug=player`). A spec's own `test.use({ viewport, isMobile, hasTouch })` wins over the device, and engine-specific checks skip themselves with a reason (the emulated safe-area insets use the Chromium DevTools protocol; WebKit's Tab key skips links).

⚠️ **WebKit on Windows cannot play mocked media.** Playwright's WebKit build for Windows decodes media with Windows Media Foundation, which downloads media URLs itself (outside WebKit's network stack): `page.route()` never sees those requests, the Vite server answers them with `index.html`, and the radio ends in `MEDIA_ERR_SRC_NOT_SUPPORTED`. On Windows, `mobile-webkit` covers layout, touch and accessibility — its playback-dependent tests skip themselves with that reason (`mockedMediaUnavailable` / `MOCKED_MEDIA_REASON` in `tests/support/mock-api.ts`); playback on a phone engine is covered by `mobile-chromium`, on WebKit by macOS/Linux runs, and on iOS by the device script.

**Production smoke** (`tests/prod-smoke.spec.ts`, the deploy step's browser check): unmocked, as an anonymous visitor on an emulated Pixel 7, and strictly read-only — every non-GET request is aborted, nothing is signed in, created, published, reset or deleted. It warms the Container App first (`GET /api/health`, up to 120 s: production keeps one replica warm, so this is normally instant; with `MIN_REPLICAS=0` the app scales to zero and a cold start takes ≈ 30 s), then checks that the library lists an episode, one tap on Listen opens the sheet and plays the episode from Blob storage (`currentTime` advances, muted), "Minimise player" keeps it playing in the mini-player, "Open now playing" reopens the sheet on the same `<audio>` element, and the page's `/assets/*.js` are served with `content-encoding: gzip` and an `immutable` `Cache-Control`. SAS query strings are stripped from every message and tracing is off.

```powershell
$env:OZ_RADIO_PROD_SMOKE = "1"
$env:AI_PRESENTER_BASE_URL = "https://<your-app>.<env>.<region>.azurecontainerapps.io"   # required with OZ_RADIO_PROD_SMOKE=1
npm run test:prod-smoke
```

### UX-fix suites (mocked)

The first-visit experience (front door, Home and navigation, the live demo, Listen and Watch) has its own mocked suites. They need no backend: `mockApi` answers `/api`, `mockBoot` injects the boot block into `index.html` the way the server does, and the media are the same byte-range fixtures. Run them from the repository root against the Vite dev server (`AI_PRESENTER_BASE_URL`, default `http://localhost:5173`):

| Spec | What it proves |
|---|---|
| `tests/ux-front-door.spec.ts` | The branded static shell while the bundle loads, the failed-bundle message, route crashes and the 404 page, document titles and focus after navigation, layout stability on a Pixel 7 |
| `tests/ux-home-nav.spec.ts` | Home with the boot block and without it, failed versus empty lists, the gate pages, the owner menu and the live-demo / recording call to action |
| `tests/ux-demo.spec.ts` | The live demo on the deck page: one tap to presenting, the outcome cards and their recordings, captions, countdown warnings, the phone control bar, typed and voice questions. The WebRTC media is simulated |
| `tests/ux-listen-watch.spec.ts` | Listen and Watch: language and level before play, the captions track, the `?video=` deep link, expired links, offline and failure states |
| `tests/mobile-ux-listen-watch.spec.ts` | The phone half of Listen and Watch: the transcript clears the bottom dock, and language, level and durations are readable on a phone. It matches the `mobile-*` projects, so `npm run test:mobile` runs it; on desktop Chromium it emulates a 412 × 839 touch phone |
| `tests/ux-fixtures.spec.ts` | The shared fixtures and the contract smoke test: the TypeScript and Python live-demo constants must agree |
| `tests/cold-path.spec.ts` | Opt-in, never runs by default (`OZ_RADIO_COLD_PATH=1`). It measures the first paint and the first actionable CTA from the portfolio link against a replica that is scaled to zero. It never warms anything up, so run it with `--retries=0` |

```powershell
npm run test:ux                                                       # ux-front-door, ux-home-nav, ux-demo, ux-listen-watch and ux-fixtures, on chromium
npx playwright test tests/mobile-ux-listen-watch.spec.ts --project=chromium
$env:OZ_RADIO_COLD_PATH = "1"; npx playwright test tests/cold-path.spec.ts --project=chromium --retries=0
```

A test that proves a failure state starts its title with that state's ID in brackets (for example `[T3-02]`), so every failure can be traced to its test. Backend tests run without Azure: `cd demos/backend && pytest tests`, and the live-demo protocol is covered by `test_live_demo.py`, `test_demo_qa_ws.py`, `test_voice_questions.py` and `test_boot_block.py`.

### Live browser E2E (real Azure, real avatar)

`tests/e2e-live.spec.ts` drives real Chromium against a local backend wired to real Speech / Voice Live / OpenAI: deck upload → avatar (WebRTC video + audio) → "Present all" with playback-driven advance, raise hand (fake-mic voice question, Ask now, typed), French narration, the anonymous public demo (countdown, 2-question cap) and a short podcast render + frame checks. It is **skipped unless `OZ_RADIO_LIVE_E2E=1`**, so CI and the mocked suites never touch Azure. Needs `az login` with data-plane access to the Speech/AI Services and OpenAI resources in `demos/backend/.env`, LibreOffice, and ffmpeg/ffprobe (`OZ_RADIO_E2E_TOOL_DIRS` when not on `PATH`).

- `tests/e2e_live_server.py` runs the real app with an in-memory Cosmos stand-in (no Cosmos/Blob locally) and `AUTH_MODE=easyauth`.
- `demos/frontend/vite.e2e-live.config.ts` plays the Container Apps Easy Auth front door: the admin instance injects the signed-in principal headers on `/api` and `/ws`, the anonymous instance injects none.
- `tests/e2e_live_audio.py` creates the fake-microphone question WAV (Azure TTS, Entra ID).

```powershell
$ev = "$PWD\test-results\e2e-live"
python tests/e2e_live_audio.py $ev
python tests/e2e_live_server.py --port 8000                                  # shell 1
cd demos/frontend
$env:OZ_RADIO_E2E_PRINCIPAL = python ../../tests/e2e_live_server.py --print-principal
npx vite --config vite.e2e-live.config.ts --port 5199 --strictPort            # shell 2 (admin)
npx vite --config vite.e2e-live.config.ts --port 5198 --strictPort            # shell 3 (anonymous, no OZ_RADIO_E2E_PRINCIPAL)
$env:OZ_RADIO_LIVE_E2E = "1"; $env:OZ_RADIO_E2E_EVIDENCE = $ev
$env:AI_PRESENTER_BASE_URL = "http://localhost:5199"; $env:OZ_RADIO_E2E_ANON_URL = "http://localhost:5198"
npx playwright test tests/e2e-live.spec.ts --project=chromium --workers=1    # --grep "@admin|@demo|@podcast"
```

Evidence (screenshots, WebSocket / data-channel / analyser timelines as JSON, podcast frames) is written to `OZ_RADIO_E2E_EVIDENCE`.

---

## 📁 Project Structure

```
oz-radio/
├── demos/
│   ├── backend/                  # FastAPI backend (Python 3.12)
│   │   ├── app.py                # Live routes (/api/upload, /api/slides, /api/qa, /ws/voice, /ws/voice/demo) + agent chat
│   │   ├── config.py             # Configuration management
│   │   ├── agent_app.py          # Azure AI Foundry agent entry point
│   │   ├── agent_tools.py        # Agent tool definitions
│   │   ├── requirements.txt      # Python dependencies
│   │   ├── .env.example          # Environment variable template
│   │   ├── data/                 # Local dev: uploads/ + slides/
│   │   ├── maintenance/          # Operator CLI (python -m maintenance.content): seed, script, render, warm-listeners, publish, plan-switch / switch / rollback, purge
│   │   ├── routers/              # Feature-scoped routers
│   │   │   ├── decks.py          # Decks catalog — upload, publish, live demo, hybrid search
│   │   │   ├── playlists.py      # Playlists CRUD + progress + AI recommend
│   │   │   ├── video.py          # Video — ingest, script, render, library
│   │   │   └── podcast.py        # Podcast — ingest, script, render, library
│   │   └── services/
│   │       ├── pptx_parser.py    # PPTX parsing & slide rendering
│   │       ├── translation.py    # Azure OpenAI translation (cached in Cosmos)
│   │       ├── avatar.py         # Azure Speech avatar service
│   │       ├── voice_proxy.py    # WebSocket voice proxy (VoiceLive; admin + the public live demo)
│   │       ├── demo_protocol.py  # Live demo protocol v2 constants (close codes, messages), boot block and public library constants
│   │       ├── qa.py             # In-memory numpy RAG (Live page Q&A)
│   │       ├── deck_search.py    # Azure AI Search client (hybrid vector + keyword)
│   │       ├── video_*.py        # Video pipeline — ingest, script, render, compose, library, models
│   │       ├── podcast_*.py      # Podcast pipeline — ingest, script, batch avatar render, TTS, listener kits, reactions, compose, radio mix, cover, jingle, library, models
│   │       ├── speech_rest.py    # Speech REST auth (Entra → STS) + shared retry policy (podcast engines)
│   │       └── storage.py        # Cosmos DB (presentations + playlists + progress) + Blob Storage
│   └── frontend/                 # React 19 SPA (Vite 8 + TypeScript)
│       ├── src/
│       │   ├── main.tsx          # Router entry — /, /live, /decks*, /search, /playlists*, /video*, /podcast*
│       │   ├── components/
│       │   │   ├── TopNav.tsx             # Grouped nav (Home · Live · Decks · Search · Playlists | Video | Podcast)
│       │   │   ├── AvatarPanel.tsx        # WebRTC avatar (autoStart for playlist player)
│       │   │   ├── SlideViewer.tsx        # Slide display & navigation
│       │   │   ├── LanguageSelector.tsx   # Language picker (variant dark/light)
│       │   │   ├── PptUpload.tsx          # File upload UI
│       │   │   ├── PresentationList.tsx   # Saved presentations (CRUD)
│       │   │   ├── QaChat.tsx             # Q&A chat interface
│       │   │   └── RadioPlayer.tsx        # Podcast "Listen" player (cover, hosts, live captions, waveform)
│       │   ├── pages/
│       │   │   ├── HomePage.tsx           # Landing page
│       │   │   ├── LivePage.tsx           # Single-deck live presenter (Teams theme support)
│       │   │   ├── DecksPage.tsx          # Deck catalog
│       │   │   ├── DeckPresentPage.tsx    # Single-deck player (+ public live demo)
│       │   │   ├── SearchPage.tsx         # Hybrid search across the catalog
│       │   │   ├── PlaylistsPage.tsx      # Playlists library + "Recommend with AI"
│       │   │   ├── PlaylistPlayerPage.tsx # Multi-deck sequential player
│       │   │   ├── VideoPage.tsx          # Video generator
│       │   │   ├── VideoLibraryPage.tsx
│       │   │   ├── PodcastPage.tsx        # Podcast generator
│       │   │   └── PodcastLibraryPage.tsx
│       │   └── services/
│       │       ├── api.ts                 # Live page API client
│       │       ├── decksApi.ts            # Decks + search + playlists + recommend
│       │       ├── demo.ts                # Public live demo config
│       │       ├── demoProtocol.ts        # Live demo protocol v2: types, close codes, outcome copy, same-deck recording
│       │       ├── boot.ts                # First-paint boot block (live-demo decks, sessions left) and the demo deck pick
│       │       ├── videoApi.ts            # Video API client
│       │       ├── podcast.ts             # Podcast API client
│       │       └── teams.ts               # Teams SDK helpers
│       └── public/teams/                  # Teams app manifest & icons
├── infra/                        # Azure Bicep IaC
│   ├── main.bicep                # Main template (subscription-scoped)
│   ├── main.parameters.json
│   └── modules/                  # ai-services, openai, cosmos, storage, containerapp, roles, budget
├── hooks/                        # azd hooks (preprovision checks for the auth settings)
├── scripts/                      # Ops + test-prep scripts
│   ├── package-teams-app.ps1     # Teams app packaging
│   ├── video_multilang_run.py    # Video multi-language rendering sweep
│   ├── video_republish.py        # Re-publish video items
│   ├── video_regen.py / podcast_regen.py # Rebuild the video / podcast libraries from the sample decks
│   ├── convert_srt.py            # SRT → WebVTT converter + timestamp fixer
│   ├── compare_subtitles.py      # Compare reference vs Video Translation subtitles
│   ├── make_multideck_test.py    # Generate multi-deck test corpus
│   └── (generators, smoke tests, utilities)
├── tests/
│   ├── e2e_full.py               # End-to-end: reset DB + upload 9 fixtures + decks/video/podcast smoke (30 checks)
│   ├── e2e_render.py             # Full render E2E for video + podcast, with --languages multi-locale sweep
│   ├── test_decks_api.py         # pytest — decks + search API
│   ├── test_playlists_api.py     # pytest — playlists + AI recommend (catalog validation)
│   ├── playlists.spec.ts         # Playwright — playlists UI regressions
│   ├── decks.spec.ts             # Playwright — home / decks / search UI
│   ├── conftest.py
│   └── fixtures/
│       ├── samples/              # 9 coherent decks in 3 thematic groups (Safety FR, Generative AI EN, AI in industry ES)
│       └── decks/                # 6 single-topic decks for multi-deck search tests
├── docs/
│   ├── index.md                  # Docs navigation map
│   ├── architecture.md           # Component architecture, data flows, API contract
│   ├── decks-search-playlists.md # Decks + search + playlists + AI recommend design
│   ├── live-demo.md              # Public live avatar demo — guardrails & cost
│   ├── video.md                  # Video slide-first pipeline design
│   ├── podcast.md                # Two-host podcast design (video + radio, listener, public listening)
│   ├── deep-dive-azure.md        # Full Azure deep-dive (Bicep, RBAC, security, CI/CD)
│   ├── teams-integration.md      # Teams embedding feasibility & options
│   ├── deploy-copilot.md         # Parallel instance (pointer to provisioning.md)
│   └── diagrams/                 # Mermaid + draw.io diagrams
├── Dockerfile                    # Multi-stage build (Node frontend + Python backend + ffmpeg + LibreOffice)
├── azure.yaml                    # Azure Developer CLI config
├── playwright.config.ts          # Playwright config (UI E2E)
├── requirements-test.txt         # Test-time Python deps
├── run-local.ps1                 # One-command local dev startup (Windows)
├── package.json                  # Frontend deps (root-level for Playwright)
├── LICENSE                       # MIT License
├── SECURITY.md                   # Security policy, model & operator checklist
└── README.md                     # This file
```

---

## 📚 Documentation

Detailed technical documentation is available in the [`docs/`](docs/) directory — start at the [**docs index**](docs/index.md) for the full map.

| Document | Description |
|----------|-------------|
| [**Docs Index**](docs/index.md) | Full navigation map of all docs & diagrams |
| [Product brief](PRODUCT.md) | Who Oz Radio is for, the three visitor tasks and their acceptance criteria, what is free and what is owner-only |
| [Architecture](docs/architecture.md) | Component architecture, data flows, API contract, deployment topology |
| [Decks, Search & Playlists](docs/decks-search-playlists.md) | Deck catalog, hybrid search, playlists, AI playlist recommendation, playlist player auto-start |
| [Public live demo](docs/live-demo.md) | Anonymous live avatar: the one-tap flow, protocol v2, close codes and visitor outcomes, guardrails, threat model, cost ceiling |
| [Video](docs/video.md) | Slide-first pipeline, voice→avatar matching, Blob-backed media/SCORM library, deployment, storage-network gotchas on policy-managed enterprise subscriptions |
| [Podcast](docs/podcast.md) | Two-host podcast generator: video + radio renditions, alive listener and backchannels, Blob-backed media/SCORM library, public listening |
| [Provisioning runbook](docs/provisioning.md) | Components, prerequisites, Entra app registration, azd variables, deploy, smoke test, troubleshooting, teardown |
| [BOOTSTRAP.md](BOOTSTRAP.md) | Ordered deployment steps for coding agents, with human checkpoints |
| [Deep Dive: Azure Deployment](docs/deep-dive-azure.md) | Full technical walkthrough — infrastructure, Bicep modules, security, CI/CD |
| [Teams Integration](docs/teams-integration.md) | Feasibility analysis and architecture options for Teams embedding |
| [Parallel instance](docs/deploy-copilot.md) | Deploying a second instance (pointer to the provisioning runbook) |

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).

---

<p align="center">
  Built with ❤️ using Azure AI Services, FastAPI & React
</p>
