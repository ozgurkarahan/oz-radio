# Video — Narrated Slide-Video Generation

**Status:** Shipped · `master` · deployed with `azd up` (see [README › Azure Deployment](../README.md#️-azure-deployment))
**Scope:** automated, pre-rendered narrated video per deck

---

## 1. Purpose

Turn a `.pptx` into a narrated, lip-synced **MP4 video** automatically — pick a voice, pick a language, pick an avatar. No live presenter needed. The output is stored in a library so anyone with access can watch or re-download MP4 / MP3 / SRT / SCORM.

This complements:

- **Live** — *live* avatar (WebRTC, presenter-driven) — see [decks-search-playlists.md](decks-search-playlists.md)
- **Podcast** — two-avatar podcast-style video from any document — see [podcast.md](podcast.md)

---

## 2. User Flow

```mermaid
flowchart LR
    A[User opens /video] --> B[Upload .pptx]
    B --> C[Pick language + voice + style<br/>+ optional audience level]
    C --> D[Generate narration script]
    D --> E{Review / edit slides}
    E -->|Looks good| F[Click Render]
    E -->|Tweak| D
    F --> G[Poll progress]
    G --> H[Download MP4 / MP3 / SRT / SCORM<br/>+ published to Library]
```

Every generated video lands in the **Library** (`/video/library`) — a grid of thumbnails per language/title.

---

## 3. End-to-End Architecture

```mermaid
flowchart TB
    subgraph Client[Client - React SPA]
        UI1[VideoPage<br/>upload + script editor + progress]
        UI2[VideoLibraryPage<br/>grid of published videos]
        TopNav[Grouped Top Nav<br/>Decks - Video - Podcast]
    end

    subgraph Backend[FastAPI backend on Azure Container Apps]
        R[routers/video.py<br/>/api/video/*]
        S[services/video_script.py<br/>slide-first narration]
        R2[services/video_render.py + video_compose.py<br/>batch avatar + ffmpeg]
        L[services/video_library.py<br/>blob publish - list]
    end

    subgraph Azure[Azure services]
        OAI[Azure OpenAI<br/>gpt-4.1 + embeddings]
        SPEECH[Azure AI Speech<br/>Batch Avatar Synthesis<br/>DragonHD voices]
        BLOB[Blob Storage<br/>videos/]
        COSMOS[Cosmos DB<br/>optional manifest cache]
    end

    Client --> R
    R --> S
    S -->|extract text per slide| OAI
    S --> R2
    R2 -->|SSML per slide| SPEECH
    SPEECH -->|MP4 clip per slide| R2
    R2 -->|ffmpeg compose + burn subs| R2
    R --> L
    L --> BLOB
    Client -->|play mp4| BLOB

    style Client fill:#e3f2fd
    style Backend fill:#e8f5e9
    style Azure fill:#fff3e0
```

### Why "slide-first"?

The first batch-avatar prototype used **one batch job per presentation** — a monolithic avatar video. The video generator flips this: **one batch job per slide**, then ffmpeg stitches clips on top of the slide image with the avatar as a picture-in-picture. Benefits:

- Each slide is visible full-screen; avatar only needs a corner
- Errors in one slide don't poison the whole deck (retry a single clip)
- Parallelism: N slides = N batch jobs running in parallel on Azure Speech
- Subtitles burn-in timed per slide (fine-grained)

### Audience level

`ScriptRequest.audience_level` (optional: `"beginner" | "practitioner" | "expert"`, default `null`) tunes vocabulary and depth of the narration. `services/video_script.py::_build_system_prompt` adds one `Audience:` line next to style / focus / language; it still demands exactly one narration per slide, in slide order. Unknown values are rejected with **422**.

| Level | Directive added to the system prompt |
|---|---|
| *Any (default)* → `null` | nothing: the generic prompt, which carries the grounding, recorded-video and language rules at every level (pinned by `tests/test_audience_level.py`) |
| `beginner` | assume no prior AI/technical knowledge; define every term in plain words; everyday analogies; avoid jargon and acronyms (expand if unavoidable); one idea at a time |
| `practitioner` | audience builds or operates solutions; concrete how-to, trade-offs, practical tips, common pitfalls; standard terminology OK |
| `expert` | deep technical audience; architecture, internals, limits, failure modes, evaluation; precise vocabulary; stay strictly within the source — never invent numbers or details |

The level is saved on `VideoScript`, written to the library `manifest.json` (`audience_level`) and returned by the admin `GET /api/video/library` + `/library/{job_id}` responses. The anonymous public DTO carries it too (`audience_level`, with `source_deck_id` and `captions_vtt_url`), and the library shows it as a level chip on each row and in the player. In the UI, the **Audience level** select sits next to **Style** in the *Narration* panel and is also sent on per-slide regeneration requests.

### Narration rules

Every narration, at every audience level, follows the same rules: it uses only what the slides and their notes state (no invented figures or products), it never presents the video as live, it keeps one language (no English phrase in a French video), and it gives exactly one narration per slide, in slide order. The model gets the whole source (up to 48,000 characters; a longer deck is shortened slide by slide, with a fair share for each slide) at temperature 0.4.

---

## 4. Pipeline Stages

```mermaid
sequenceDiagram
    autonumber
    participant U as User
    participant FE as React SPA
    participant API as FastAPI
    participant OAI as OpenAI gpt-4.1
    participant BA as Batch Avatar
    participant FF as ffmpeg worker
    participant BLOB as Blob Storage

    U->>FE: upload deck.pptx
    FE->>API: POST /api/video/ingest (multipart)
    API-->>FE: {doc_id, slides, detected language}

    U->>FE: pick lang/voice/style + click Generate script
    FE->>API: POST /api/video/script/{doc_id}
    API->>OAI: system prompt + slide bodies
    OAI-->>API: 1 narration per slide
    API-->>FE: NDJSON events<br/>{event:"narration", data}<br/>{event:"done", data: VideoScript}

    U->>FE: (optional edits) + click Render
    FE->>API: POST /api/video/render/{doc_id}
    API->>API: create job, pick avatar by voice gender
    API-->>FE: {job_id}

    par parallel slides
        API->>BA: PUT batchsynthesis/{slide_n} (SSML)
        BA-->>API: status=Succeeded + clip URL
    end

    API->>FF: compose slide PNG + avatar clip + burn SRT
    FF-->>API: slide_n.mp4

    API->>FF: concat all slide mp4s -> final.mp4
    FF-->>API: final.mp4 + full.srt + audio.mp3

    API->>BLOB: upload mp4 + mp3 + srt + scorm.zip + manifest.json
    BLOB-->>API: public URLs
    API-->>FE: state=done + library entry

    FE->>BLOB: stream mp4 for playback
```

### Stage map (what you see in the progress bar)

| State | Stage | Percent | What's happening |
|---|---|---|---|
| `queued` | queued | 0 | Job accepted, awaiting start |
| `rendering` | rendering | 5–75 | N/M slides done by Batch Avatar |
| `composing` | compositing | 75–90 | ffmpeg: slide + avatar PiP + subtitles |
| `publishing` | publishing | 90–98 | Build SCORM and push mp4/mp3/srt/scorm to Blob |
| `done` | done | 100 | Manifest written, entry in library |

---

## 5. Voice → Avatar matching

The major UX fix from this cycle. Default `DEFAULT_AVATAR = "lisa"` is **female**; default voices (`Andrew`, `Rémy`, `Tristan`, `Florian`) are all **male** → mismatch.

Fix in `demos/backend/services/video_render.py`:

```python
_MALE_VOICE_NAMES   = {"andrew", "remy", "tristan", "florian", ...}
_FEMALE_VOICE_NAMES = {"ava", "vivienne", "ximena", "seraphina", ...}

def avatar_for_voice(voice: str, fallback: str = DEFAULT_AVATAR) -> str:
    name = voice.split("-")[-1].split(":")[0].lower()
    if name in _MALE_VOICE_NAMES:   return "harry"   # business style
    if name in _FEMALE_VOICE_NAMES: return "lisa"    # casual-sitting
    return fallback
```

Called from `_submit_slide` before `AVATAR_MAP.get(...)` — overrides any caller-provided avatar that doesn't match the picked voice.

---

## 6. Frontend navigation

Grouped top nav — the main deck pages, then the video and podcast generators:

```mermaid
flowchart LR
    NavBar[Top Nav] --> G1[Decks]
    NavBar --> G2[Video]
    NavBar --> G3[Podcast]

    G1 --> L1a["🏠 Home (/)"]
    G1 --> L1b["🎙️ Live (/live)"]
    G1 --> L1c["📚 Decks (/decks)"]
    G1 --> L1d["🔎 Search (/search)"]
    G1 --> L1e["📻 Playlists (/playlists)"]
    G2 --> L2a["🎬 Create (/video)"]
    G2 --> L2b["🎞️ Library (/video/library)"]
    G3 --> L3a["🎧 Create (/podcast)"]
    G3 --> L3b["📚 Library (/podcast/library)"]
```

Entries that need sign-in are marked *Sign-in required* for anonymous visitors, who sign in only through the **Owner sign-in** text link.

The library opens a video from its link: `/video/library?video=<job_id>` (the same-deck recording that a live-demo visitor is sent to). A failing video offers **Try again** (a fresh fetch of the item) and, when the episode has audio (admins only: the public video DTO carries no audio URL), **Listen instead**. Each row shows its language and level. The captions are a WebVTT track that is never on by default, because the picture already carries burned-in captions.

---

## 7. API Surface

All under `/api/video` (prefix from `routers/video.py`).

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/languages` | supported target languages |
| `GET`  | `/voices` | 16 DragonHD voices w/ `display_name`, language, gender, HD flag |
| `POST` | `/ingest` | multipart upload, returns `doc_id` + parsed slides |
| `POST` | `/script/{doc_id}` | body `{language, style?, focus?, audience_level?, voice}` → NDJSON stream: `{event:"narration", data}` per slide, final `{event:"done", data: VideoScript}` |
| `GET`  | `/script/{doc_id}` | fetch current narrations |
| `POST` | `/render/{doc_id}` | start render job |
| `GET`  | `/jobs/{job_id}` | poll `VideoJob` with nested `progress` + outputs |
| `GET`  | `/jobs/{job_id}/file/{kind}` | local fallback stream `mp4` / `mp3` / `srt` / `thumb` / `scorm` |
| `GET`  | `/library` | list published videos (anonymous: published only; `503 Library temporarily unavailable` when storage fails) |
| `GET`  | `/library/{job_id}` | full manifest of one entry with fresh MP4 / MP3 / SRT / SCORM SAS URLs |
| `GET`  | `/library/{job_id}/captions.vtt` | WebVTT captions of a published video (`text/vtt`; 404 when there are none) |
| `DELETE` | `/library/{job_id}` | remove from library |

---

## 8. Deployment topology

```mermaid
flowchart TB
    subgraph rg[Resource group - provisioned by azd]
        ACR[ACR cr#lt;token#gt;<br/>ai-presenter image]
        ACA[Container App<br/>ca-#lt;token#gt;<br/>2 vCPU - 4 GiB]
        OAI[Azure OpenAI<br/>gpt-4.1 + embeddings]
        AIS[AI Services<br/>Speech + Batch Avatar]
        BLOB[Storage st#lt;token#gt;<br/>container slide-images<br/>prefix videos/]
        COS[Cosmos DB]
        LAW[Log Analytics]
    end

    DEV[Developer / CI] -->|azd deploy| ACR
    ACR -->|pull image| ACA
    ACA -->|MI auth| OAI & AIS & BLOB & COS
    ACA -->|stdout/stderr| LAW
    USER[End user] -->|HTTPS| ACA
    ACA -->|short-lived read SAS| BLOB
```

Resource names follow the `infra/` Bicep convention `<abbreviation><token>` (e.g. `ca-<token>`, `cr<token>`, `st<token>`), where `<token>` is generated per azd environment.

### Build & deploy

The recommended path is `azd deploy` (or `azd up` for a first deployment) — see [README › Azure Deployment](../README.md#️-azure-deployment). The equivalent manual path:

```powershell
# 1. Build in ACR (no local docker needed)
az acr build -r <acr-name> -t oz-radio/backend-<env>:<tag> -t oz-radio/backend-<env>:latest --no-logs .

# 2. Roll new revision with bumped resources
az containerapp update `
  -n ca-<token> -g <resource-group> `
  --image <acr-name>.azurecr.io/oz-radio/backend-<env>:<tag> `
  --cpu 2.0 --memory 4.0Gi `
  --revision-suffix <revision-suffix>
```

### Why 2 vCPU / 4 GiB?

4 parallel slide renders + ffmpeg compose easily blow past 2 GiB — container OOM-kill wipes the in-memory `JOBS` dict and jobs surface as 404. Bumping fixed it for the 4-lang e2e.

### Storage network gotcha (policy-managed enterprise subscriptions)

On policy-managed enterprise subscriptions, fresh storage accounts may be forced to `publicNetworkAccess=Disabled`. Even with the right RBAC (`Storage Blob Data Contributor` for the ACA managed identity), blob uploads then fail with `AuthorizationFailure`. Either give the Container App private network access to the storage account (VNet integration + private endpoint), or — if your organization's policy allows it — enable public network access:

```powershell
az storage account update -n <name> -g <rg> `
  --public-network-access Enabled --default-action Allow
```

Blob containers stay private either way: media is served through short-lived, read-only SAS URLs (15 min for anonymous viewers of published items). Public thumbnails are signed per 10-minute window, so the browser cache can reuse them.

Symptom when this is wrong: job goes `state=done` but `archive_state=failed` and `library` returns `[]`.

Production runs one warm replica (`MIN_REPLICAS=1`, set in the azd environment). The Bicep default is `MIN_REPLICAS=0`, which keeps idle demo cost low and prevents stale Speech streaming sessions from surviving after a presentation. See [infra/README.md](../infra/README.md#always-on-min_replicas).

---

## 9. Testing

Two scripts ship with the repo:

| Script | What it does |
|---|---|
| `scripts/make_test_pptx.py` | Generates a 3-slide test deck (`output/video-test-deck.pptx`) — title + body + speaker notes |
| `scripts/video_multilang_run.py` | Runs the full pipeline (ingest → script → render) in 4 languages **in parallel** against `$env:AI_PRESENTER_BASE_URL` |

```powershell
# Local dev started with ./run-local.ps1 (AUTH_MODE=disabled)
$env:AI_PRESENTER_BASE_URL = "http://localhost:8000"
python scripts/make_test_pptx.py
python scripts/video_multilang_run.py
```

Expected output: 4 jobs done, 4 library entries, ~8 min total wall-clock.

---

## 10. Known limits (PoC only)

- **In-memory state** — `JOBS`, `SCRIPTS`, `DOCUMENTS` live in Python process memory. Container restart = lost in-flight work; published library assets, including SCORM packages, remain in Blob.
- **No job queue** — `BackgroundTasks` only. One replica = one workload. For prod, replace with Azure Queue + worker.
- **Single admin role** — generation, publishing and deletes require a Microsoft Entra ID sign-in on the `ALLOWED_OBJECT_IDS` allowlist; anonymous visitors only see **published** videos (see [README › Security model](../README.md#-security-model)). There is no per-user ownership or multi-tenant isolation.
- **No observability UI** — logs go to Log Analytics; no dashboard. Use KQL directly for now.
- **Library is flat** — no tagging, no folders, no search. Add later if demand.

---

## 11. Files

| File | Why |
|---|---|
| `demos/frontend/src/pages/VideoPage.tsx` | Upload + script editor + progress UI |
| `demos/frontend/src/pages/VideoLibraryPage.tsx` | Grid of published videos |
| `demos/frontend/src/components/TopNav.tsx` | Grouped nav (Decks / Video / Podcast) + tooltips |
| `demos/frontend/src/services/videoApi.ts` | Typed client for `/api/video/*` |
| `demos/backend/routers/video.py` | FastAPI routes + in-memory stores |
| `demos/backend/services/video_models.py` | Pydantic models |
| `demos/backend/services/video_ingest.py` / `video_script.py` | Slide extraction + slide-first narration |
| `demos/backend/services/video_render.py` / `video_compose.py` | Batch avatar + ffmpeg + voice→avatar matching |
| `demos/backend/services/video_library.py` | Blob publish + list + delete |
| `scripts/make_test_pptx.py` | Test deck generator |
| `scripts/video_multilang_run.py` | E2E multilang driver (reads `$AI_PRESENTER_BASE_URL`) |

---

## 12. Related docs

- [Architecture overview](architecture.md) — system-wide
- [Podcast design](podcast.md)
- [Deep dive: Azure deployment](deep-dive-azure.md)
- [Docs index](index.md)
