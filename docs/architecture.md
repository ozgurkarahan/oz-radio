# Oz Radio — Architecture Document

> **Context**: Oz Radio — AI avatars that present, narrate and podcast your decks. A live avatar presents PowerPoint slides with Q&A, a batch pipeline renders narrated videos, and a two-avatar generator turns documents into podcast-style videos.

## System Overview

Oz Radio is a web-based application that allows users to upload PowerPoint presentations and have a photorealistic AI avatar present them with multilingual text-to-speech. The system supports:

- **Real-time presentation** — avatar speaks as user navigates slides via WebRTC (VoiceLive API)
- **Batch video generation** — pre-render full presentation video (Batch Avatar Synthesis API)
- **Slide Q&A** — RAG-based question answering over slide content
- **Multilingual translation** — automatic translation into 10 languages with Cosmos DB caching
- **Agent chat** — LLM function-calling agent for conversational slide interaction
- **Persistent storage** — presentations survive container restarts via Cosmos DB + Blob Storage
- **Teams integration** — embeddable as a Microsoft Teams Static Tab

---

## Component Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          CLIENT (Browser / Teams Tab)                     │
│                                                                          │
│  ┌──────────────┐  ┌───────────────┐  ┌────────────────────────────┐    │
│  │  PPT Upload   │  │  Slide Viewer  │  │  Avatar Panel (WebRTC)     │    │
│  │  Component    │  │  + Navigator   │  │  VoiceLive + DragonHD TTS  │    │
│  └──────┬───────┘  └───────┬───────┘  └──────────────┬─────────────┘    │
│         │                  │                          │                   │
│  ┌──────┴──────────────────┴──────────────────────────┴───────────────┐  │
│  │  Presentation List │ Language Selector │ Q&A Chat │ Agent Chat     │  │
│  └───────────────────────────┬────────────────────────────────────────┘  │
│                              │                                           │
│         REST /api/*          │   WebSocket /ws/voice                     │
└──────────────────────────────┼───────────────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                   BACKEND (FastAPI on Azure Container Apps)               │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │                      API Router (app.py)                           │  │
│  │                                                                    │  │
│  │  POST /api/upload                → PPT Parser + Persist            │  │
│  │  GET  /api/presentations         → List (Cosmos DB → in-memory)    │  │
│  │  GET  /api/slides/{id}           → Get slides + SAS image URLs     │  │
│  │  GET  /api/slides/{id}/{img}     → Serve slide image (disk/Blob)   │  │
│  │  DEL  /api/presentations/{id}    → Delete (Cosmos + Blob + disk)   │  │
│  │  POST /api/presentations/{id}/translate-notes → Batch translate     │  │
│  │  GET  /api/presentations/{id}/translations-status → Progress       │  │
│  │  POST /api/translate             → Single-text translation         │  │
│  │  GET  /api/me                    → Caller identity / admin flag    │  │
│  │  POST /api/avatar/batch          → Batch Avatar Synthesis          │  │
│  │  GET  /api/avatar/batch/{job_id} → Batch job status                │  │
│  │  POST /api/qa                    → Slide Q&A (RAG)                 │  │
│  │  POST /api/agent/chat            → Agent chat (function-calling)   │  │
│  │  WS   /ws/voice                  → VoiceLive WebSocket proxy       │  │
│  └───┬──────────┬──────────┬──────────┬──────────┬──────────┬────────┘  │
│      │          │          │          │          │          │            │
│  ┌───▼────┐ ┌──▼───────┐ ┌▼────────┐ ┌▼───────┐ ┌▼───────┐ ┌▼───────┐ │
│  │ PPTX   │ │ Translat.│ │ Avatar  │ │ Q&A    │ │Voice   │ │Storage │ │
│  │ Parser │ │ Service  │ │ Service │ │(RAG)   │ │Proxy   │ │Service │ │
│  │        │ │          │ │         │ │        │ │        │ │        │ │
│  │python  │ │ GPT-4.1  │ │VoiceLive│ │Embed + │ │WSS →   │ │CosmosDB│ │
│  │-pptx   │ │ + detect │ │WebSocket│ │numpy   │ │Azure   │ │+ Blob  │ │
│  │+Libre  │ │ + cache  │ │+ batch  │ │cosine  │ │Voice   │ │+ SAS   │ │
│  │Office  │ │          │ │+ token  │ │+ GPT   │ │Live    │ │tokens  │ │
│  └────────┘ └──────────┘ └─────────┘ └────────┘ └────────┘ └────────┘ │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                          AZURE SERVICES                                  │
│                                                                          │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────────┐   │
│  │ Azure AI Services │  │ Azure OpenAI      │  │ Azure Cosmos DB      │   │
│  │ (Speech/Avatar)   │  │ (S0)              │  │ (Serverless)         │   │
│  │                   │  │                   │  │                      │   │
│  │ • VoiceLive API   │  │ • GPT-4.1         │  │ • presentations      │   │
│  │   (WebRTC avatar) │  │   (translation,   │  │   container          │   │
│  │ • DragonHD TTS    │  │    Q&A, agent)    │  │ • Slide metadata     │   │
│  │   voices (6 native│  │ • text-embedding- │  │ • Translated notes   │   │
│  │   + 4 multilingual│  │   3-small         │  │   cache              │   │
│  │ • Batch Synthesis │  │   (RAG embeddings)│  │                      │   │
│  │ • ICE/TURN relay  │  │                   │  │                      │   │
│  └──────────────────┘  └──────────────────┘  └──────────────────────┘   │
│                                                                          │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────────┐   │
│  │ Azure Blob        │  │ Azure Container  │  │ Azure Container      │   │
│  │ Storage (Std LRS) │  │ Apps             │  │ Registry (Basic)     │   │
│  │                   │  │                   │  │                      │   │
│  │ • Slide images    │  │ • FastAPI backend │  │ • Docker images      │   │
│  │   (PNG, SAS URLs) │  │ • React static   │  │ • Multi-stage build  │   │
│  │ • Original PPTX   │  │ • System-assigned │  │                      │   │
│  │   files           │  │   Managed Identity│  │                      │   │
│  │ • Embedded videos │  │ • Auto-scale 1-3  │  │                      │   │
│  └──────────────────┘  └──────────────────┘  └──────────────────────┘   │
│                                                                          │
│  ┌──────────────────┐  ┌──────────────────┐                             │
│  │ Log Analytics     │  │ In-Memory Vector │                             │
│  │ Workspace         │  │ Store (numpy)    │                             │
│  │                   │  │                   │                             │
│  │ • Container logs  │  │ • Cosine search   │                             │
│  │ • 30-day retention│  │ • Ephemeral       │                             │
│  └──────────────────┘  └──────────────────┘                             │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## Feature Map

| Feature | Implementation | Status |
|-----------------|---------------|--------|
| **Voice conversation** with the avatar | Agent chat (`/api/agent/chat`) + VoiceLive WebRTC | ✅ Implemented |
| **Live** — avatar over PPT slides with Q&A | SlideViewer + AvatarPanel + Q&A RAG pipeline (`/live`) | ✅ Implemented |
| **Decks, Search & Playlists** — multi-deck catalog + AI deck selection | `/decks`, `/search`, `/playlists` — Azure AI Search hybrid, playlists (Cosmos), AI playlist recommendation (GPT-4.1 JSON mode) | ✅ Implemented |
| **Public live demo** — anonymous, narration-only | `/ws/voice/demo` with server-side guardrails (see [live-demo.md](live-demo.md)) | ✅ Implemented (off by default) |
| **Video** — narrated batch video | Slide-first pipeline (`/video`) — Batch Avatar per slide + ffmpeg compose | ✅ Implemented |
| **Podcast** — two-host video + radio | Two-host podcast (`/podcast`) — GPT-4.1 dialogue → Batch Avatar talking turns with a cached, alive listening loop and optional backchannels + ffmpeg compose, plus a radio mix (DragonHD TTS, sonic logo, −16 LUFS MP3 + transcript); *Audio only* format skips the avatars | ✅ Implemented |
| **Multilingual** | 10 languages (6 native DragonHD + 4 multilingual fallback) | ✅ Implemented |
| **LMS/SCORM export** | Video and podcast render jobs generate SCORM ZIPs and persist them with library assets in Blob Storage | ✅ Implemented |
| **M365 Copilot / Teams integration** | Agent Framework + Teams Static Tab | ✅ Partial |
| **GDPR compliance** | Managed Identity, no keys in client, Azure-hosted | ✅ PoC level |

---

## Data Flows

### Flow 1: Upload & Parse PowerPoint (with Persistence)

```
User → [Upload .pptx] → Frontend → POST /api/upload → Backend
  1. Validate file (ZIP header, Content_Types.xml)
  2. python-pptx extracts: slide count, titles, body text, speaker notes
  3. Extract embedded videos (MP4/WMV) from PPTX media
  4. LibreOffice headless → PPTX to PDF → pdf2image → PNGs
  5. Save PNGs to local disk (data/slides/{id}/)
  6. Upload PNGs to Azure Blob Storage (slide-images container)
  7. Upload original PPTX to Blob Storage
  8. Save metadata to Cosmos DB (id, filename, slides[])
  9. Generate embeddings → index in numpy vector store (for Q&A)
  10. Kick off background batch translation (9 languages, async)
  → Return presentation with SAS-signed image URLs to Frontend
```

### Flow 2: Real-Time Avatar Presentation (VoiceLive)

```
User → [Selects slide + language] → Frontend
  1. Frontend opens WebSocket to /ws/voice
  2. Backend proxies to Azure VoiceLive API:
     wss://{resource}.cognitiveservices.azure.com/voice-live/realtime
  3. Backend sends session.update with:
     - Avatar: lisa / casual-sitting
     - Voice: DragonHD (native per language, e.g. fr-FR-Vivienne)
     - Modalities: text + audio + avatar
     - VAD: azure_semantic_vad
  4. Azure returns ICE servers (TURN credentials)
  5. Frontend WebRTC handshake → avatar video streams to browser
  6. User navigates slides → Frontend sends text via conversation.item.create
  7. Avatar speaks slide notes in target language
```

### Flow 3: Batch Video Generation

```
User → [Click "Generate Video"] → Frontend → POST /api/avatar/batch → Backend
  1. Collect speaker notes (or body/title fallback) for all slides
  2. Translate notes if target language ≠ source (via GPT-4.1)
  3. Build SSML with voice name for target language
  4. PUT /avatar/batchsyntheses/{job_id} to Azure Speech API
  5. Azure renders avatar video asynchronously
  6. Client polls GET /api/avatar/batch/{job_id} for status
  7. Azure stores MP4 → return download URL
```

### Flow 4: Slide Q&A (RAG)

```
User → [Types question] → Frontend → POST /api/qa → Backend
  1. Generate embedding for question (text-embedding-3-small)
  2. Cosine similarity search in numpy vector store
  3. Retrieve top-3 relevant slide chunks (filtered by presentation)
  4. Build RAG prompt: system context + slide chunks + question
  5. Call GPT-4.1 for grounded answer
  → Return answer + source slide indices
```

### Flow 5: Translation (with Caching)

```
On Upload:
  → Background task translates all slide notes into 9 languages
  → Each translation cached in Cosmos DB (slides[].translated_notes.{lang})
  → Frontend polls /translations-status for progress

On Demand:
  → POST /api/translate for single text
  → POST /api/presentations/{id}/translate-notes for a language
  → If cached in Cosmos → return instantly
  → If not cached → translate via GPT-4.1 → cache → return
```

### Flow 6: Agent Chat (Function-Calling)

```
User → [Types message] → Frontend → POST /api/agent/chat → Backend
  1. Build message list with system prompt + slide context
  2. Call GPT-4.1 with tool definitions:
     - translate_slide_notes, detect_text_language
     - ask_about_slides, generate_avatar_speech_ssml
     - prepare_slide_for_presentation
  3. LLM decides which tools to call (up to 5 iterations)
  4. Execute tool calls, append results
  5. Return final assistant response
```

---

## API Contract

### Presentation Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/upload` | Upload `.pptx`, parse, render, persist |
| `GET` | `/api/presentations` | List all presentations (Cosmos DB → in-memory) |
| `GET` | `/api/slides/{id}` | Get slides with fresh SAS image URLs |
| `GET` | `/api/slides/{id}/{filename}` | Serve slide image or video (disk → Blob fallback) |
| `DELETE` | `/api/presentations/{id}` | Delete from Cosmos + Blob + disk |
| `POST` | `/api/presentations/{id}/share` | Share presentation (placeholder) |

### Translation

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/translate` | Translate single text with language detection |
| `POST` | `/api/presentations/{id}/translate-notes` | Batch-translate notes for a language (cached) |
| `GET` | `/api/presentations/{id}/translations-status` | Background translation progress |

### Avatar

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/avatars` | Available avatars (anonymous; never exposes the Speech character name) |
| `POST` | `/api/avatar/batch` | Submit batch avatar synthesis job |
| `GET` | `/api/avatar/batch/{job_id}` | Poll batch job status |
| `WS` | `/ws/voice` | WebSocket proxy → Azure VoiceLive API |

### AI & Q&A

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/qa` | RAG-based slide Q&A |
| `POST` | `/api/agent/chat` | Multi-turn agent chat with function-calling |

### System

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/health` | Health check |

---

## Voice Configuration (DragonHD)

The system uses Azure AI Speech **DragonHD** voices for maximum quality and natural prosody.

| Language | Voice Name | Type |
|----------|-----------|------|
| English (US) | `en-US-Ava:DragonHDLatestNeural` | Native DragonHD |
| French (FR) | `fr-FR-Vivienne:DragonHDLatestNeural` | Native DragonHD |
| Spanish (ES) | `es-ES-Ximena:DragonHDLatestNeural` | Native DragonHD |
| German (DE) | `de-DE-Seraphina:DragonHDLatestNeural` | Native DragonHD |
| Japanese (JP) | `ja-JP-Nanami:DragonHDLatestNeural` | Native DragonHD |
| Chinese (CN) | `zh-CN-Xiaochen:DragonHDLatestNeural` | Native DragonHD |
| Italian (IT) | `en-US-Ava:DragonHDLatestNeural` | Multilingual fallback |
| Portuguese (BR) | `en-US-Ava:DragonHDLatestNeural` | Multilingual fallback |
| Korean (KR) | `en-US-Ava:DragonHDLatestNeural` | Multilingual fallback |
| Arabic (SA) | `en-US-Ava:DragonHDLatestNeural` | Multilingual fallback |

---

## Avatar Configuration

Standard prebuilt avatars (no Microsoft approval required):

| Avatar | Character | Style | Use Case |
|--------|-----------|-------|----------|
| `lisa` | Professional female | `casual-sitting` | Default presenter |
| `harry` | Professional male | — | Alternative presenter |

---

## Deployment Architecture (Azure)

```
Resource Group: rg-<environment-name>
Region: Sweden Central (swedencentral)

├── Azure AI Services (S0) — ais-{token}
│   ├── VoiceLive API (real-time avatar via WebRTC)
│   ├── Batch Avatar Synthesis API
│   ├── TTS Neural Voices (DragonHD)
│   └── ICE/TURN relay for WebRTC
│
├── Azure OpenAI (S0) — oai-{token}
│   ├── Deployment: gpt-4.1 (GlobalStandard, 80 TPM)
│   │   └── Translation, Q&A generation, agent chat
│   └── Deployment: text-embedding-3-small (GlobalStandard, 120 TPM)
│       └── RAG embeddings for slide content
│
├── Azure Cosmos DB (Serverless) — cosmos-{token}
│   └── Database: ai-presenter
│       └── Container: presentations (partition key: /id)
│           ├── Presentation metadata (filename, slide_count)
│           ├── Slide data (title, body, notes, image_url)
│           └── Cached translations (translated_notes per language)
│
├── Azure Storage Account (Standard LRS) — st{token}
│   └── Container: slide-images (private, no public access)
│       ├── {presentation_id}/{index}.png — rendered slide images
│       └── {presentation_id}/{filename}.pptx — original files
│       └── Access: SAS tokens via User Delegation Key (24h expiry)
│
├── Azure Container Registry (Basic) — cr{token}
│   └── Docker images (multi-stage: Node.js build + Python runtime)
│
├── Azure Container Apps — ca-{token}
│   ├── Environment: cae-{token}
│   ├── Identity: System-assigned Managed Identity
│   ├── Ingress: external, port 8000, HTTPS only
│   ├── Scale: 1-3 replicas (HTTP concurrency: 50 req/replica)
│   ├── Resources: 1 vCPU, 2 GiB RAM per container
│   └── Runtime: Gunicorn + Uvicorn + FastAPI + React static
│       ├── LibreOffice Impress (headless, PPTX → PDF)
│       ├── Poppler (PDF → PNG)
│       └── Liberation fonts
│
├── Log Analytics Workspace — cae-{token}-logs
│   └── Container App logs (30-day retention)
│
└── RBAC Role Assignments (Managed Identity → resources)
    ├── Cognitive Services Speech User → AI Services
    ├── Cognitive Services User → AI Services
    ├── Cognitive Services OpenAI User → OpenAI
    ├── Cosmos DB Built-in Data Contributor → Cosmos DB
    └── Storage Blob Data Contributor → Storage Account
```

**SPA delivery** — FastAPI serves the Vite build copied into `demos/backend/static`. `index.html` and client routes stay `no-cache, no-store` so a deploy is picked up on the next load, while `/assets/*` goes through `StaticAssetDeliveryMiddleware` (`app.py`): gzip for text-like files ≥ 1 KB (never `Range` requests, API, media or the shell; `Vary: Accept-Encoding`, weak ETag when encoded) and `Cache-Control: public, max-age=31536000, immutable` for content-hashed `<name>-<hash>.<ext>` files (`max-age=3600` otherwise). The main JS bundle drops from ~665 KB to ~208 KB on the wire and is not re-requested between visits.

---

## Security

| Aspect | Implementation |
|--------|---------------|
| **Service authentication** | Azure Managed Identity (no keys in environment) |
| **User authentication** | Microsoft Entra ID via Container Apps Easy Auth (`AUTH_MODE=easyauth`); backend validates tenant + `X-MS-CLIENT-PRINCIPAL-IDP=aad` |
| **Authorization** | Hybrid exposure, default deny: anonymous = SPA, health, `/api/me`, `/api/avatars`, **published** library items and published deck slides; everything else requires an object ID in `ALLOWED_OBJECT_IDS` (401 anonymous / 403 not allowlisted) |
| **Speech credentials** | Never sent to the browser — the live avatar is relayed through the authorized `/ws/voice` proxy |
| **Blob access** | Read-only SAS via User Delegation Key; blob-scoped, 15 min for anonymous viewers of published items |
| **OpenAI access** | Managed Identity → Cognitive Services OpenAI User role |
| **Cosmos DB** | Managed Identity → Built-in Data Contributor role |
| **Network** | HTTPS only ingress, no public blob access |
| **Browser isolation** | CORS + WebSocket `Origin` check (`ALLOWED_ORIGINS`, same-origin by default), CSP `frame-ancestors` limited to Teams / Office hosts (`FRAME_ANCESTORS`) |
| **Cost guards** | `MAX_VOICE_SESSIONS`, `MAX_VOICE_SESSION_SECONDS`, `DAILY_GENERATION_QUOTA`, `MAX_PENDING_RENDERS`, budget alert |
| **Local dev** | `AUTH_MODE=disabled` (every caller is admin, warning logged) — never deployed |

See [SECURITY.md](../SECURITY.md) for the operator checklist.

---

## Directory Structure

```
oz-radio/
├── AGENT.md                           ← Project overview & deliverables
├── Dockerfile                         ← Multi-stage Docker build
├── azure.yaml                         ← Azure Developer CLI (azd) config
├── run-local.ps1                      ← One-command local dev startup
├── docs/
│   ├── architecture.md                ← This document
│   ├── deep-dive-azure.md             ← Full Azure deployment walkthrough
│   ├── deploy-copilot.md              ← Parallel deployment guide
│   ├── teams-integration.md           ← Teams embedding analysis
│   └── diagrams/
│       ├── azure-architecture.drawio           ← Azure resource topology
│       ├── deck-ingestion-sequence.drawio      ← Upload + persist flow
│       ├── deck-present-sequence.drawio        ← Runtime presentation flow
│       ├── live-qa-sequence.drawio             ← VoiceLive + Q&A flow
│       ├── video-batch-sequence.drawio         ← Batch video generation
│       └── agent-chat-sequence.drawio           ← Agent function-calling flow
├── demos/
│   ├── backend/
│   │   ├── app.py                     ← FastAPI app (REST + WebSocket + Agent)
│   │   ├── config.py                  ← Azure service configuration
│   │   ├── agent_app.py               ← Azure AI Foundry agent entry point
│   │   ├── agent_tools.py             ← Agent tool definitions
│   │   ├── requirements.txt           ← Python dependencies
│   │   ├── .env / .env.example        ← Environment variables
│   │   ├── data/
│   │   │   ├── uploads/               ← Uploaded PPTX files (local cache)
│   │   │   └── slides/                ← Rendered PNG images (local cache)
│   │   └── services/
│   │       ├── pptx_parser.py         ← PPTX parsing + LibreOffice rendering
│   │       ├── voice_proxy.py         ← WebSocket proxy → VoiceLive API
│   │       ├── translation.py         ← GPT-4.1 translation + detection
│   │       ├── avatar.py              ← Speech tokens, batch synthesis, SSML
│   │       ├── qa.py                  ← RAG Q&A (numpy vector search)
│   │       └── storage.py             ← Cosmos DB + Blob Storage persistence
│   └── frontend/
│       ├── package.json
│       ├── vite.config.ts             ← Dev proxy for /api and /ws
│       ├── src/
│       │   ├── App.tsx                ← Root component with Teams theme
│       │   ├── components/
│       │   │   ├── PptUpload.tsx       ← File upload UI
│       │   │   ├── PresentationList.tsx← Saved presentations (CRUD)
│       │   │   ├── SlideViewer.tsx     ← Slide display + navigation
│       │   │   ├── AvatarPanel.tsx     ← WebRTC avatar video/audio
│       │   │   ├── LanguageSelector.tsx← Language picker (10 languages)
│       │   │   └── QaChat.tsx          ← Q&A chat + Agent chat
│       │   └── services/
│       │       ├── api.ts             ← API client (all endpoints)
│       │       └── teams.ts           ← Teams SDK integration helpers
│       └── public/
│           └── teams/                 ← Teams manifest + icons
├── infra/                             ← Azure Bicep IaC
│   ├── main.bicep                     ← Orchestrator (subscription-scoped)
│   ├── main.parameters.json           ← Default deployment params
│   ├── main.parameters.copilot.json   ← Parallel instance params
│   └── modules/
│       ├── ai-services.bicep          ← Azure AI Services (Speech/Avatar)
│       ├── openai.bicep               ← Azure OpenAI + model deployments
│       ├── cosmos.bicep               ← Cosmos DB (Serverless)
│       ├── storage.bicep              ← Blob Storage account
│       ├── containerapp.bicep         ← Container App + ACR + Log Analytics
│       └── roles.bicep                ← RBAC role assignments (5 roles)
├── scripts/
│   └── package-teams-app.ps1          ← Teams app packaging
└── tests/
    └── playwright.config.ts           ← E2E test config
```
