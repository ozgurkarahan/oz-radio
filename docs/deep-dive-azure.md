# Oz Radio — Deep Dive: Azure Deployment & Architecture

> **Document scope**: Full technical walkthrough of the cleanup, architecture decisions, Azure infrastructure, and deployment pipeline for the Oz Radio PoC.
>
> **Audience**: Technical stakeholders, Azure architects, developers.
>
> **Date**: March 15, 2026 · **Region**: Sweden Central
>
> **Note**: this walkthrough describes the initial deployment. The current user-facing security model (Microsoft Entra ID Easy Auth, object-ID allowlist, hybrid anonymous/admin exposure, cost guards) is documented in [README › Security model](../README.md#-security-model) and [SECURITY.md](../SECURITY.md).

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Solution Architecture](#2-solution-architecture)
3. [Azure Infrastructure](#3-azure-infrastructure)
4. [Application Components](#4-application-components)
5. [Data Flows](#5-data-flows)
6. [Deployment Pipeline](#6-deployment-pipeline)
7. [Security & Identity](#7-security--identity)
8. [Cleanup & Rationalization](#8-cleanup--rationalization)
9. [Cost Considerations](#9-cost-considerations)
10. [Appendix: File Structure & API Reference](#10-appendix)

---

## 1. Executive Summary

Oz Radio is a PoC built for the organization's training teams that allows users to upload PowerPoint presentations and have a lifelike AI avatar present them with multilingual text-to-speech. The solution was cleaned up from a local-development prototype into a production-ready Azure deployment.

### What We Deployed

| Component | Technology | Azure Resource |
|-----------|-----------|----------------|
| Frontend | React 19 + Vite 8 | Bundled into Container App |
| Backend API | FastAPI (Python 3.12) | Azure Container Apps |
| AI Avatar | Azure VoiceLive WebRTC | Azure AI Services (Foundry) |
| Translation & Q&A | GPT-4.1 + Embeddings | Azure OpenAI |
| Slide Rendering | LibreOffice + Poppler | In-container (Debian packages) |
| Container Registry | Docker (multi-stage) | Azure Container Registry |
| Infrastructure as Code | Bicep | Azure Resource Manager |

### Live URL

```
https://<your-container-app>.azurecontainerapps.io
```

---

## 2. Solution Architecture

### High-Level Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                                   BROWSER                                        │
│                                                                                  │
│   ┌────────────────┐   ┌────────────────┐   ┌──────────────────────────────┐    │
│   │   PPT Upload    │   │  Slide Viewer   │   │  Avatar Panel (WebRTC)       │    │
│   │   Component     │   │  + Navigator    │   │  microsoft-cognitiveservices  │    │
│   └───────┬────────┘   └───────┬────────┘   │  -speech-sdk                  │    │
│           │                    │             └──────────────┬─────────────────┘    │
│   ┌───────┴────────────────────┴──────────────────────┐    │                      │
│   │          Language Selector + Q&A Chat              │    │  WebRTC (ICE/TURN)   │
│   └───────────────────────┬───────────────────────────┘    │                      │
│                           │ REST /api/*                     │                      │
│                           │ WS   /ws/voice                  │                      │
└───────────────────────────┼─────────────────────────────────┼──────────────────────┘
                            │                                 │
                            ▼                                 │
┌───────────────────────────────────────────────────────┐     │
│          AZURE CONTAINER APPS  (<your-container-app>)  │     │
│          ┌─────────────────────────────────────────┐  │     │
│          │  Gunicorn (4 workers)                    │  │     │
│          │  └─ Uvicorn ASGI worker                  │  │     │
│          │     └─ FastAPI Application                │  │     │
│          │        ├── /api/upload                    │  │     │
│          │        ├── /api/presentations             │  │     │
│          │        ├── /api/slides/{id}/{img}         │  │     │
│          │        ├── /api/translate                 │  │     │
│          │        ├── /api/video/*  ─────────────────┼──┼──┐  │
│          │        ├── /api/avatar/batch              │  │  │  │
│          │        ├── /api/qa                        │  │  │  │
│          │        ├── /ws/voice (WebSocket Proxy) ───┼──┼──┤  │
│          │        └── /* (React SPA from /static/)   │  │  │  │
│          │                                           │  │  │  │
│          │  ┌───────────────────────────────────┐    │  │  │  │
│          │  │ In-Container Services              │    │  │  │  │
│          │  │  • LibreOffice Impress (headless)  │    │  │  │  │
│          │  │  • Poppler (pdftoppm)              │    │  │  │  │
│          │  │  • numpy (in-memory vector store)  │    │  │  │  │
│          │  └───────────────────────────────────┘    │  │  │  │
│          └─────────────────────────────────────────┘  │  │  │  │
│          System-Assigned Managed Identity              │  │  │  │
└───────────────────────────────────────────────────────┘  │  │  │
                            │                              │  │  │
              ┌─────────────┼──────────────────────────────┘  │  │
              │             │                                  │  │
              ▼             ▼                                  ▼  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                     AZURE AI SERVICES (Sweden Central)                       │
│                                                                             │
│  ┌──────────────────────────────────┐  ┌──────────────────────────────────┐ │
│  │  Azure OpenAI                     │  │  Azure AI Services (Foundry)     │ │
│  │  <your-openai-account>             │  │  <your-ai-services-account>      │ │
│  │                                   │  │                                  │ │
│  │  Deployments:                     │  │  Capabilities:                   │ │
│  │  ├── gpt-4.1 (Standard, 30 TPM)  │  │  ├── TTS Neural Voices           │ │
│  │  │   • Translation (FR, ES, EN)   │  │  │   en-US-AvaMultilingualNeural  │ │
│  │  │   • Q&A answer generation      │  │  │   fr-FR-DeniseNeural           │ │
│  │  │   • Language detection          │  │  │   es-ES-ElviraNeural           │ │
│  │  │                                │  │  ├── VoiceLive Avatar API         │ │
│  │  └── text-embedding-3-small       │  │  │   WebRTC streaming (lisa)      │ │
│  │      (GlobalStandard, 30 TPM)     │  │  ├── Batch Avatar Synthesis       │ │
│  │      • Slide content embeddings   │  │  │   MP4 video generation         │ │
│  │      • Q&A query embeddings       │  │  └── STS Token Issuance           │ │
│  │                                   │  │      /sts/v1.0/issueToken          │ │
│  └──────────────────────────────────┘  └──────────────────────────────────┘ │
│                                                                             │
│  ┌──────────────────────────────────┐  ┌──────────────────────────────────┐ │
│  │  Azure Container Registry         │  │  Log Analytics Workspace         │ │
│  │  <your-acr>.azurecr.io             │  │  <your-log-analytics>            │ │
│  │                                   │  │                                  │ │
│  │  Repository:                      │  │  • Container App system logs     │ │
│  │  └── oz-radio/backend-<env>       │  │  • Application stdout/stderr     │ │
│  │      Multi-stage Docker image     │  │  • 30-day retention              │ │
│  │      ~800MB (includes LibreOffice)│  │  • PerGB2018 pricing             │ │
│  └──────────────────────────────────┘  └──────────────────────────────────┘ │
│                                                                             │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │  Container App Environment: <your-container-env>                      │   │
│  │  • Shared networking boundary for Container Apps                     │   │
│  │  • Log Analytics integration for observability                       │   │
│  │  • HTTPS ingress with auto TLS                                      │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Single-Container Strategy

We chose a **single-container architecture** where the React frontend is built at Docker build time and served as static files by FastAPI:

```
┌─────────────────────────────────────────┐
│         Docker Image (~800MB)            │
│                                          │
│  /app/                                   │
│  ├── app.py          (FastAPI entry)     │
│  ├── config.py       (Azure config)      │
│  ├── services/       (business logic)    │
│  ├── static/         (React SPA build)   │
│  │   ├── index.html                      │
│  │   └── assets/                         │
│  └── data/           (runtime uploads)   │
│      ├── uploads/                        │
│      └── slides/     (rendered PNGs)     │
│                                          │
│  /usr/bin/soffice    (LibreOffice)       │
│  /usr/bin/pdftoppm   (Poppler)           │
└─────────────────────────────────────────┘
```

**Why single container?**
- PoC simplicity — one image, one service, one URL
- Frontend: an HTML shell of about 7.9 kB (`index.html`, its branded first paint is inlined) and a main JS chunk of 290.75 kB (92.26 kB gzipped), with every page except Home as a lazy chunk — trivial to embed
- No need for a CDN or separate static hosting for a demo
- API and SPA share the same origin — no CORS issues in production

---

## 3. Azure Infrastructure

### Resource Group Overview

**Resource Group**: `<your-resource-group>`
**Region**: Sweden Central (`swedencentral`)
**Subscription**: `<your-subscription>`

```
<your-resource-group> (swedencentral)
│
├── <your-openai-account>              Microsoft.CognitiveServices/accounts  (OpenAI, S0)
│   ├── gpt-4.1                        Model deployment (Standard, 30K TPM)
│   └── text-embedding-3-small         Model deployment (GlobalStandard, 30K TPM)
│
├── <your-ai-services-account>         Microsoft.CognitiveServices/accounts  (AIServices, S0)
│   ├── TTS Neural Voices              (en-US, fr-FR, es-ES)
│   ├── VoiceLive Avatar API           (WebRTC real-time streaming)
│   ├── Batch Avatar Synthesis          (MP4 video generation)
│   └── STS Token Issuance             (AAD → Speech JWT exchange)
│
├── <your-acr>                         Microsoft.ContainerRegistry/registries (Basic)
│   └── oz-radio/backend-<env>         Docker image repository (azd: <project>/<service>-<env>)
│
├── <your-container-env>               Microsoft.App/managedEnvironments
│   └── Log Analytics integration      (<your-log-analytics>)
│
├── <your-container-app>               Microsoft.App/containerApps
│   ├── System-Assigned Managed Identity
│   ├── HTTPS Ingress (port 8000)
│   ├── 2 vCPU / 4 GiB memory
│   └── Scale: 0–1 replicas (`MIN_REPLICAS`; 50 concurrent requests threshold)
│
└── <your-log-analytics>              Microsoft.OperationalInsights/workspaces (PerGB2018)
    └── 30-day retention
```

### Bicep Module Structure

The infrastructure is defined as modular Bicep templates:

```
infra/
├── main.bicep                    Subscription-scoped orchestrator
├── main.parameters.json          Parameter file (environmentName, location)
└── modules/
    ├── existing-ai.bicep         References pre-created OpenAI + AI Services
    ├── containerapp.bicep         ACR + Log Analytics + Container App Env + Container App
    └── roles.bicep                RBAC role assignments for managed identity
```

#### `main.bicep` — Orchestrator

```
targetScope = 'subscription'

Parameters:
  environmentName     → Used for RG naming: rg-{environmentName}
  location            → swedencentral
  openAiAccountName   → <your-openai-account> (existing)
  aiServicesAccountName → <your-ai-services-account> (existing)
  chatModelName       → gpt-4.1
  embeddingModelName  → text-embedding-3-small

Modules:
  existingResources   → Reads endpoints from existing AI resources
  containerapp        → Creates ACR + Container App (receives AI endpoints as params)
  roleAssignments     → Grants Container App identity access to AI resources

Outputs:
  AZURE_CONTAINER_APP_URL, AZURE_CONTAINER_REGISTRY_LOGIN_SERVER,
  AZURE_SPEECH_ENDPOINT, AZURE_OPENAI_ENDPOINT, etc.
```

#### `existing-ai.bicep` — Reference Existing Resources

```bicep
resource openAi 'Microsoft.CognitiveServices/accounts@2023-10-01-preview' existing = {
  name: openAiAccountName
}
resource aiServices 'Microsoft.CognitiveServices/accounts@2023-10-01-preview' existing = {
  name: aiServicesAccountName
}
// Outputs: endpoints, names, resource IDs
```

**Key design decision**: These AI resources were created manually during development. Rather than recreate them (which would lose model deployments), we reference them as `existing` and let Bicep manage only the new infrastructure (ACR, Container App, etc.).

#### `containerapp.bicep` — Compute & Networking

| Setting | Value | Rationale |
|---------|-------|-----------|
| ACR SKU | Basic | Sufficient for PoC (10 GiB storage) |
| Container CPU | 2 vCPU | LibreOffice rendering and ffmpeg compose need CPU headroom |
| Container Memory | 4 GiB | Parallel slide renders and compose outgrew 2 GiB (OOM-kill wiped the in-memory job store) |
| Min Replicas | `MIN_REPLICAS`: 0 in the template, 1 in production | Production keeps one replica warm; `0` scales to zero when idle ([provisioning §10](provisioning.md#10-cost-notes-and-teardown)) |
| Max Replicas | 1 | Fixed: counters and quotas are in-process; the scale rule is 50 concurrent requests |
| Ingress | External HTTPS | Auto-managed TLS certificate |
| Transport | Auto | Supports both HTTP and WebSocket upgrades |
| Identity | System-Assigned | For AAD-based access to AI services |

#### `roles.bicep` — RBAC Assignments

The Container App's managed identity receives three roles:

| Role | Scope | Purpose |
|------|-------|---------|
| **Cognitive Services Speech User** | AI Services account | Issue speech tokens, TTS synthesis |
| **Cognitive Services User** | AI Services account | Broad access for avatar APIs |
| **Cognitive Services OpenAI User** | OpenAI account | Chat completions + embeddings |

---

## 4. Application Components

### Backend (FastAPI)

```
demos/backend/
├── app.py              FastAPI application (routes, lifespan, SPA serving)
├── config.py           Environment-based configuration (AzureConfig dataclass)
├── requirements.txt    14 Python dependencies
└── services/
    ├── pptx_parser.py  PPTX → text extraction + LibreOffice → PDF → PNG rendering
    ├── avatar.py       Speech token exchange, batch avatar synthesis, SSML building
    ├── voice_proxy.py  WebSocket proxy: browser ↔ Azure VoiceLive API
    ├── translation.py  GPT-4.1 translation + language detection
    └── qa.py           In-memory numpy RAG (cosine similarity + GPT-4.1 answering)
```

#### Key Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `fastapi` | ≥0.115 | ASGI web framework |
| `gunicorn` | ≥22.0 | Production WSGI/ASGI server |
| `uvicorn[standard]` | ≥0.30 | ASGI worker (HTTP/2 + WebSocket) |
| `openai` | ≥1.50 | Azure OpenAI SDK |
| `azure-identity` | ≥1.17 | DefaultAzureCredential (managed identity) |
| `python-pptx` | ≥1.0.2 | PowerPoint file parsing |
| `pdf2image` | ≥1.16 | PDF → PNG conversion (wraps Poppler) |
| `Pillow` | ≥10.0 | Image processing (fallback placeholders) |
| `numpy` | ≥2.0 | Vector math for RAG (cosine similarity) |
| `websockets` | ≥12.0 | WebSocket client for VoiceLive proxy |

### Frontend (React 19)

```
demos/frontend/
├── package.json         React 19, Vite 8, TypeScript 5.9
├── vite.config.ts       Dev proxy: /api → localhost:8000, /ws → WS proxy
├── index.html           SPA entry point
└── src/
    ├── main.tsx          React root
    ├── App.tsx           Layout: header + upload/presentation views
    ├── services/
    │   └── api.ts        Typed API client (fetch-based, relative paths)
    └── components/
        ├── PptUpload.tsx       Drag-and-drop PPTX upload
        ├── SlideViewer.tsx     Slide image display + text fallback + navigation
        ├── AvatarPanel.tsx     WebRTC avatar video/audio via Speech SDK
        ├── LanguageSelector.tsx  EN/FR/ES language picker
        └── QaChat.tsx          Chat interface for slide Q&A
```

#### Frontend → Backend Communication

| Path | Protocol | Component | Purpose |
|------|----------|-----------|---------|
| `/api/upload` | HTTP POST | PptUpload | Upload PPTX file |
| `/api/presentations` | HTTP GET | App | List presentations |
| `/api/slides/{id}` | HTTP GET | SlideViewer | Get slide data |
| `/api/slides/{id}/{n}.png` | HTTP GET | SlideViewer | Serve slide images |
| `/api/translate` | HTTP POST | SlideViewer | Translate speaker notes |
| `/api/me` | HTTP GET | App | Sign-in state and admin flag |
| `/api/avatars` | HTTP GET | AvatarPanel | Available avatars |
| `/api/qa` | HTTP POST | QaChat | Ask questions about slides |
| `/ws/voice` | WebSocket | AvatarPanel | VoiceLive avatar streaming |

---

## 5. Data Flows

### Flow 1: Upload & Render PowerPoint

```
┌──────┐   .pptx    ┌──────────────┐   python-pptx   ┌──────────────────────┐
│ User │ ──────────→ │ POST /upload │ ──────────────→ │ Extract text + notes  │
└──────┘             └──────┬───────┘                  └──────────┬───────────┘
                            │                                     │
                            │         LibreOffice (headless)       │
                            │    ┌────────────────────────────┐    │
                            └──→ │ soffice --convert-to pdf   │    │
                                 └────────────┬───────────────┘    │
                                              │ PDF                 │
                                 ┌────────────▼───────────────┐    │
                                 │ pdftoppm → PNG (150 DPI)   │    │
                                 └────────────┬───────────────┘    │
                                              │ PNGs                │
                                 ┌────────────▼───────────────┐    │
                                 │ Save to data/slides/{id}/  │    │
                                 └────────────┬───────────────┘    │
                                              │                    │
                            ┌─────────────────┴────────────────────┘
                            ▼
              ┌──────────────────────────────┐
              │ Index slides (embeddings)     │
              │ via text-embedding-3-small    │──→  In-memory numpy store
              └──────────────────────────────┘
```

### Flow 2: Real-Time Avatar (WebRTC via VoiceLive)

```
┌──────────┐                          ┌─────────────────┐
│  Browser  │  WS /ws/voice            │  FastAPI Backend │
│ (Speech   │ ─────────────────────→   │  voice_proxy.py  │
│  SDK JS)  │                          │                  │
└─────┬────┘                          └────────┬─────────┘
      │                                        │
      │                                        │  WSS connection
      │                                        │  (Bearer AAD token)
      │                                        ▼
      │                          ┌──────────────────────────────────┐
      │                          │  Azure VoiceLive API              │
      │                          │  wss://{host}/voice-live/realtime │
      │                          │                                   │
      │                          │  1. session.update (avatar config)│
      │                          │  2. ICE/TURN credentials          │
      │                          └──────────────┬───────────────────┘
      │                                         │
      │  ◄──── SDP offer/answer ────────────────┘
      │  ◄──── WebRTC media streams ────────────┘
      │
      ▼
  ┌──────────────────┐
  │ RTCPeerConnection │
  │ Video: AI Avatar  │
  │ Audio: TTS speech │
  └──────────────────┘
```

### Flow 3: Slide Q&A (RAG Pipeline)

```
┌──────────┐  "What is the budget?"   ┌──────────────┐
│   User   │ ────────────────────────→│ POST /api/qa │
└──────────┘                          └──────┬───────┘
                                             │
                    ┌────────────────────────┘
                    ▼
          ┌─────────────────────────┐
          │ Generate query embedding │
          │ (text-embedding-3-small) │
          └────────────┬────────────┘
                       │ [1536-dim vector]
                       ▼
          ┌─────────────────────────┐
          │ Cosine similarity search │
          │ against slide embeddings │
          │ (numpy in-memory store)  │
          └────────────┬────────────┘
                       │ Top 3 slides
                       ▼
          ┌─────────────────────────┐
          │ Build prompt:            │
          │ System: "Answer based   │
          │   on these slides..."   │
          │ + slide content chunks   │
          │ + user question          │
          └────────────┬────────────┘
                       │
                       ▼
          ┌─────────────────────────┐
          │ GPT-4.1 chat completion  │
          └────────────┬────────────┘
                       │
                       ▼
              { answer, source_slides }
```

---

## 6. Deployment Pipeline

### Multi-Stage Docker Build

```dockerfile
# STAGE 1: Frontend build (Node 20)
FROM node:20-slim AS frontend-build
  → npm ci (install dependencies)
  → npm run build (tsc + vite build → /frontend/dist/)

# STAGE 2: Backend + Frontend (Python 3.12)
FROM python:3.12-slim
  → apt-get: libreoffice-impress, poppler-utils, fonts-liberation
  → pip install: 14 Python packages
  → COPY backend source → /app/
  → COPY --from=frontend-build /frontend/dist/ → /app/static/
  → gunicorn (4 workers, uvicorn ASGI, port 8000)
```

### Build & Deploy Commands

```bash
# 1. Provision Azure infrastructure (Bicep → ARM)
az deployment sub create \
  --name ai-presenter-provision \
  --location swedencentral \
  --template-file infra/main.bicep \
  --parameters environmentName=ai-presenter-copilot location=swedencentral

# 2. Build Docker image in the cloud (no local Docker needed)
az acr build \
  --registry <your-acr> \
  --image oz-radio/backend-<env>:latest \
  --file Dockerfile . \
  --no-logs

# 3. Update Container App to use new image
az containerapp update \
  --name <your-container-app> \
  --resource-group <your-resource-group> \
  --image <your-acr>.azurecr.io/oz-radio/backend-<env>:latest
```

### CI/CD Flow Diagram

```
┌──────────┐     ┌─────────────┐     ┌──────────────────┐     ┌───────────────┐
│ Git Push  │ ──→ │  az acr     │ ──→ │  ACR Task builds  │ ──→ │  Image pushed  │
│ (source)  │     │  build      │     │  in cloud          │     │  to ACR        │
└──────────┘     └─────────────┘     │  (2 CPU agent)     │     └───────┬───────┘
                                     └──────────────────┘               │
                                                                        ▼
                                                            ┌───────────────────┐
                                                            │  az containerapp   │
                                                            │  update --image    │
                                                            └─────────┬─────────┘
                                                                      │
                                                                      ▼
                                                            ┌───────────────────┐
                                                            │  Container App     │
                                                            │  pulls new image   │
                                                            │  + rolling restart │
                                                            └───────────────────┘
```

---

## 7. Security & Identity

### Authentication Architecture

```
┌──────────────────────────────────────────────────────────┐
│                  ZERO SECRETS IN CODE                      │
│                                                            │
│  Container App                                             │
│  ┌──────────────────────────────────────┐                 │
│  │  System-Assigned Managed Identity     │                 │
│  │  (auto-created by Azure)              │                 │
│  └──────────┬───────────────────────────┘                 │
│             │                                              │
│             │  DefaultAzureCredential                      │
│             │  → Acquires AAD token automatically          │
│             │                                              │
│  ┌──────────▼───────────────────────────┐                 │
│  │  RBAC Role Assignments                │                 │
│  │                                       │                 │
│  │  On Azure OpenAI:                     │                 │
│  │    Cognitive Services OpenAI User     │                 │
│  │    → chat completions, embeddings     │                 │
│  │                                       │                 │
│  │  On Azure AI Services:                │                 │
│  │    Cognitive Services Speech User     │                 │
│  │    → token issuance, TTS              │                 │
│  │    Cognitive Services User             │                 │
│  │    → avatar APIs, VoiceLive           │                 │
│  └───────────────────────────────────────┘                 │
└──────────────────────────────────────────────────────────┘
```

### Token Flow for Avatar (AAD → Speech JWT → TURN)

```
1. Container App Managed Identity
   → DefaultAzureCredential.get_token("https://cognitiveservices.azure.com/.default")
   → Returns: AAD Bearer token

2. Exchange AAD token for Speech JWT
   → POST {speechEndpoint}/sts/v1.0/issueToken
   → Headers: Authorization: Bearer {aadToken}
   → Returns: Short-lived Speech JWT

3. Fetch TURN relay credentials
   → GET {speechEndpoint}/tts/cognitiveservices/avatar/relay/token/v1
   → Headers: Authorization: Bearer {speechJWT}
   → Returns: { urls, username, credential }

4. Used server-side only — Speech credentials are never returned to the
   browser; the live avatar session is relayed through the authorized
   /ws/voice WebSocket proxy.
```

### Security Controls

| Control | Implementation |
|---------|---------------|
| No API keys in code | Managed identity + RBAC everywhere |
| HTTPS only | Container Apps auto-TLS |
| Non-root container | `USER appuser` in Dockerfile |
| No public blob access | Private containers; read-only, blob-scoped SAS (15 min for anonymous viewers of published items) |
| User sign-in | Microsoft Entra ID via Container Apps Easy Auth; admin = object ID in `ALLOWED_OBJECT_IDS` |
| CORS | Same-origin by default; extra origins only via `ALLOWED_ORIGINS` |
| WebSocket auth | Easy Auth principal + allowlist + `Origin` check before `accept()` (close codes 4401/4403) |
| Framing | CSP `frame-ancestors` limited to Teams / Office hosts (`FRAME_ANCESTORS`) |

---

## 8. Cleanup & Rationalization

### What Was Removed

| Item | Reason |
|------|--------|
| `infra/modules/appservice.bicep` | Dead code — was never referenced by `main.bicep` |
| `infra/modules/search.bicep` | Azure AI Search not needed — PoC uses in-memory numpy |
| `infra/modules/storage.bicep` | Blob Storage not needed — slides stored on container filesystem |
| `infra/modules/speech.bicep` | Replaced by `existing-ai.bicep` (reuse pre-created resource) |
| `infra/modules/openai.bicep` | Replaced by `existing-ai.bicep` (reuse pre-created resource) |
| `azure-storage-blob` (Python dep) | No longer needed without Azure Storage |
| `config.py: search_endpoint, search_key, storage_connection_string` | Removed unused fields |
| `infra/infra/` (nested directory) | Duplicate scaffold artifact |
| `demos/backend/static/` (from git) | Built artifacts should not be committed |

### What Was Added

| Item | Purpose |
|------|---------|
| `Dockerfile` (project root) | Multi-stage build: React frontend + Python backend |
| `.dockerignore` | Exclude .git, .env, node_modules, __pycache__ from context |
| `infra/modules/existing-ai.bicep` | Reference pre-created OpenAI + AI Services resources |
| `demos/backend/.env.example` | Documented template for environment variables |
| `websockets` (Python dep) | Required by `voice_proxy.py` (was missing) |
| `.gitignore: demos/backend/static/` | Prevent committing built frontend artifacts |

### What Was Modified

| File | Changes |
|------|---------|
| `infra/main.bicep` | Removed 5 module references, added `existingResources` + `roleAssignments` with new params |
| `infra/modules/containerapp.bicep` | Removed search/storage secrets, added `speechResourceId`, bumped CPU/memory (1 vCPU/2 GiB) |
| `infra/modules/roles.bicep` | Changed from `speechAccountName` to `aiServicesAccountName`, updated role scopes |
| `azure.yaml` | Changed Docker context from `./demos/backend` to `.` (project root) for multi-stage build |
| `demos/backend/config.py` | Removed 3 unused config fields |
| `demos/backend/requirements.txt` | Removed `azure-storage-blob`, added `websockets` |
| `demos/backend/.env` | Removed unused search/storage vars |

---

## 9. Cost Considerations

### Monthly Estimated Cost (PoC Scale)

| Resource | SKU | Estimated Monthly Cost |
|----------|-----|----------------------|
| Azure OpenAI (GPT-4.1) | Standard, 30K TPM | ~$5–15 (pay-per-token) |
| Azure OpenAI (embeddings) | GlobalStandard, 30K TPM | ~$1–3 (pay-per-token) |
| Azure AI Services | S0 | $0 (pay-per-use TTS/avatar) |
| Container Apps | 2 vCPU / 4 GiB, 1 warm replica (`MIN_REPLICAS=1`) | ~$47/month at idle rates (up to ~$158 if never idle) |
| Container Registry | Basic (10 GiB) | ~$5/month |
| Log Analytics | PerGB2018, 30-day retention | ~$2–5/month |
| **Total (PoC)** | | **~$60–75/month** at idle |

### Cost Optimization for Production

- Set `MIN_REPLICAS=0` to scale to zero when idle: that removes the always-on cost (about $47/month at idle rates) at the price of a cold start of about 30 s on the first request. Production runs one warm replica ([provisioning §10](provisioning.md#10-cost-notes-and-teardown)).
- Use Premium Container Registry only if >10 GiB images needed
- Consider Azure OpenAI provisioned throughput for predictable pricing at scale
- Move slide images to Blob Storage to reduce container memory pressure

---

## 10. Appendix

### File Structure (Final State)

```
oz-radio/
├── .azure/                         azd environment config (gitignored)
├── .claude/                        Claude Code config (gitignored)
├── .dockerignore                   Docker build exclusions
├── .gitignore                      Git exclusions
├── AGENT.md                        Project overview & deliverables
├── azure.yaml                      azd service definition (containerapp)
├── Dockerfile                      Multi-stage: React build + Python backend
├── LICENSE
├── run-local.ps1                   Local dev startup script
│
├── demos/
│   ├── backend/
│   │   ├── .env                    Local environment variables (gitignored)
│   │   ├── .env.example            Template for environment variables
│   │   ├── app.py                  FastAPI application
│   │   ├── config.py               AzureConfig dataclass + load_config()
│   │   ├── requirements.txt        Python dependencies (14 packages)
│   │   ├── data/                   Runtime data (gitignored)
│   │   │   ├── uploads/
│   │   │   └── slides/
│   │   └── services/
│   │       ├── __init__.py
│   │       ├── avatar.py           Speech token + batch synthesis
│   │       ├── pptx_parser.py      PPTX → text + LibreOffice → PNG
│   │       ├── qa.py               In-memory numpy RAG
│   │       ├── translation.py      GPT-4.1 translation
│   │       └── voice_proxy.py      WebSocket proxy for VoiceLive
│   └── frontend/
│       ├── package.json            React 19, Vite 8, TypeScript 5.9
│       ├── vite.config.ts          Dev proxy configuration
│       ├── index.html              SPA entry point
│       └── src/
│           ├── main.tsx
│           ├── App.tsx
│           ├── services/api.ts     Typed API client
│           └── components/
│               ├── AvatarPanel.tsx
│               ├── LanguageSelector.tsx
│               ├── PptUpload.tsx
│               ├── QaChat.tsx
│               └── SlideViewer.tsx
│
├── docs/
│   ├── architecture.md             Original architecture document
│   ├── deep-dive-azure.md          THIS DOCUMENT
│   ├── live-demo.md                Public live avatar demo
│   └── teams-integration.md        V2 Teams integration analysis
│
└── infra/
    ├── main.bicep                  Subscription-scoped orchestrator
    ├── main.parameters.json        Parameter defaults
    └── modules/
        ├── existing-ai.bicep       Reference existing AI resources
        ├── containerapp.bicep       ACR + Container App Environment + Container App
        └── roles.bicep              RBAC role assignments
```

### API Reference

| Method | Path | Purpose | Auth |
|--------|------|---------|------|
| `GET` | `/api/health` | Health check | Anonymous |
| `GET` | `/api/me` | Caller identity / admin flag | Anonymous |
| `GET` | `/api/avatars` | Available avatars | Anonymous |
| `POST` | `/api/upload` | Upload PPTX | Admin |
| `GET` | `/api/presentations` | List presentations | Admin |
| `GET` | `/api/slides/{id}` | Get slide data | Admin |
| `GET` | `/api/slides/{id}/{n}.png` | Serve slide image | Admin |
| `POST` | `/api/translate` | Translate text | Admin |
| `POST` | `/api/avatar/batch` | Start batch video | Admin |
| `GET` | `/api/avatar/batch/{job_id}` | Check batch status | Admin |
| `POST` | `/api/qa` | Ask slide question | Admin |
| `WS` | `/ws/voice` | VoiceLive proxy | Admin (checked before `accept()`, plus `Origin` check) |
| `GET` | `/*` | Serve React SPA | Anonymous |

*Admin* = signed in with Microsoft Entra ID (Easy Auth) **and** listed in `ALLOWED_OBJECT_IDS`. Published decks, videos and podcasts are also readable anonymously — see [README › Security model](../README.md#-security-model).

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AZURE_SPEECH_ENDPOINT` | Yes | — | AI Services endpoint URL |
| `AZURE_SPEECH_REGION` | Yes | `swedencentral` | Azure region |
| `AZURE_SPEECH_RESOURCE_ID` | Yes (AAD) | — | Full resource ID for AAD token exchange |
| `AZURE_OPENAI_ENDPOINT` | Yes | — | OpenAI endpoint URL |
| `AZURE_OPENAI_CHAT_DEPLOYMENT` | Yes | `gpt-4.1` | Chat model deployment name |
| `AZURE_OPENAI_EMBEDDING_DEPLOYMENT` | Yes | `text-embedding-3-small` | Embedding model deployment name |
| `AZURE_USE_MANAGED_IDENTITY` | No | `false` | Use AAD auth instead of API keys |
| `USE_LOCAL_SEARCH` | No | `true` | Use in-memory numpy instead of AI Search |
| `LIBREOFFICE_PATH` | No | `soffice` | Path to LibreOffice binary |
