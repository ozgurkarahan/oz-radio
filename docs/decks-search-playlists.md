# Decks, Search & Playlists — Design

> Multi-deck catalog with hybrid search, live avatar presentation of any deck,
> playlists with per-user progress, and AI playlist recommendation.

The catalog lives at `/decks` (e.g. `https://<your-app>.<env>.<region>.azurecontainerapps.io/decks`), next to
the **Home** landing page (`/`) and the single-deck **Live** page (`/live`).

Ready-made content: the **AI enablement series** (Beginner → Practitioner → Expert, plus a live-demo cut) and how to
seed it as the "AI enablement path" playlist — see [content/ai-enablement/README.md](../content/ai-enablement/README.md).

---

## 1. Scope

- Avatar overlaid on the slides, slide-by-slide presentation, interruptible Q&A and natural-language slide navigation.
- Content understanding across a corpus of decks (hybrid vector + keyword search).
- **Playlists**: ordered sequences of decks with per-user progress and resume.
- **AI playlist recommendation**: GPT-4.1 selects a coherent sequence of decks from the catalog for a topic.
- **Publication**: admins publish decks for anonymous visitors (slide images, titles and the visible slide text; never
  speaker notes) and may mark a published
  deck as a **Live demo** (see [live-demo.md](live-demo.md)).

### Pages

| Route | Page | Purpose |
|---|---|---|
| `/` | `HomePage` | Landing — entry points into decks / search / playlists / live / video / podcast |
| `/decks` | `DecksPage` | Deck catalog (list, upload, publish, live demo, delete) |
| `/decks/:deckId/present` | `DeckPresentPage` | Single-deck player (shared component with the playlist player) |
| `/search` | `SearchPage` | Hybrid semantic search across the whole catalog |
| `/playlists` | `PlaylistsPage` | Playlists library + **"✨ Recommend with AI"** modal |
| `/playlists/:playlistId` | `PlaylistPlayerPage` | Playlist player — avatar auto-presents each deck in sequence |

---

## 2. Architecture

```
┌───────────────────────────────────────┐
│             React SPA                 │
│  Home · Decks · Search · Playlists    │
└─────────────┬─────────────────────────┘
              │ REST
┌─────────────▼─────────────────────────┐
│   FastAPI routers                     │
│   - routers/decks.py                  │  → ingest, list, publish, delete, search
│   - routers/playlists.py              │  → playlists CRUD, progress, recommend
└──┬────────────────┬───────────────────┘
   │                │
   │                └─► Azure OpenAI (GPT-4.1) ── JSON mode ──► playlist recommendation
   │
   ├─► Azure AI Search ── hybrid (vector + keyword) ──► index `decks`
   │      (srch-<token>, Free SKU)
   │
   └─► Azure Cosmos DB
          container `presentations`      → decks (source="deck") + playlists (source="playlist"), partition key /id
          container `playlist_progress`  → per-user playlist progress (partition key: /user_id)
```

---

## 3. Corpus & search

### 3.1 Ingestion

`POST /api/decks/upload` accepts a `.pptx`, runs the shared PPTX parser (title, bullets, notes, slide PNG), and writes:

1. Slide images + manifest to **Blob Storage** (SAS URL reads).
2. A deck record (`source: "deck"`) to the **`presentations`** Cosmos container (partitioned by `/id`).
3. Per-slide documents to the **Azure AI Search** index `decks` with:
   - `content_vector` (1536-dim, `text-embedding-3-small`)
   - `content_text` (keyword)
   - `deck_id`, `slide_index`, `language`, `title`, `notes_en` (auto-translated for cross-language search)

### 3.2 Search

`POST /api/search` runs a **hybrid** query:

- Vector kNN on `content_vector`
- BM25 keyword on `content_text` + `notes_en`
- Reciprocal rank fusion (server-side via AI Search)

Returns slide-level hits grouped by deck, with highlighted snippet + link to `/decks/:deckId/present?slide=:n`.

> **Note on field naming:** the decks endpoint returns `deck_id` — **not** `id`. This is important when writing tests
> or clients. See `tests/test_playlists_api.py` for the canonical pattern.

---

## 4. Playlists

A **playlist** is an ordered list of decks the user navigates sequentially. Progress is tracked per user, so the user
can leave and come back.

### 4.1 Data model

```json
{
  "id": "pl_0123456789ab",
  "source": "playlist",
  "title": "Workplace safety essentials",
  "description": "...",
  "status": "active",
  "steps": [
    { "deck_id": "<uuid>", "order": 0, "required": true, "deck_title": "securite-bases",       "slide_count": 5 },
    { "deck_id": "<uuid>", "order": 1, "required": true, "deck_title": "risques-chantier",     "slide_count": 5 },
    { "deck_id": "<uuid>", "order": 2, "required": true, "deck_title": "intervention-urgence", "slide_count": 5 }
  ],
  "created_at": "...",
  "updated_at": "..."
}
```

Stored in the Cosmos `presentations` container (partition key `/id`) with `source: "playlist"`. Deck title and slide
count are denormalized onto each step when the playlist is saved. Per-user progress (`{user_id}:{playlist_id}`,
`completed_slides`, `last_deck_id`, `last_slide_index`) is stored separately in `playlist_progress` (partition key
`/user_id`). Deleting a deck that a playlist references requires `?force=true` and marks the playlist `broken`.

### 4.2 Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/playlists` | Create |
| `GET` | `/api/playlists` | List |
| `GET` | `/api/playlists/{id}` | Get (410 when broken) |
| `PUT` | `/api/playlists/{id}` | Update |
| `DELETE` | `/api/playlists/{id}` | Delete |
| `GET` / `POST` | `/api/playlists/{id}/progress` | Read / record progress (monotonic, keyed by the signed-in principal) |
| `POST` | `/api/playlists/recommend` | AI recommendation (see below) |

### 4.3 Playlist player — zero-click between decks

The playlist player (`PlaylistPlayerPage`) reuses `AvatarPanel` with two props that were added specifically for this flow:

- **`autoStart: true`** — on mount, `AvatarPanel` auto-connects to Speech (instead of waiting for a "Connect avatar"
  click) and, for each new `presentation.id`, auto-calls `speakSlide(currentSlide)`. A `useRef` keyed on
  `presentation.id` makes sure the auto-trigger fires exactly once per deck. The user-selected avatar, voice, and
  language stay stable across the whole playlist — no re-picking.
- **`<LanguageSelector variant="light">`** — light variant uses dark text + light-gray border so the control is
  readable on the player's white card background. The default dark variant assumes a gradient banner (used on the
  Live page).

A Playwright regression test (`tests/playlists.spec.ts → "playlist player language selector is readable on white
banner"`) asserts the computed `color` is not `rgb(255, 255, 255)` to prevent a silent regression.

---

## 5. AI playlist recommendation

`POST /api/playlists/recommend` is a **no-persistence** endpoint that returns an *on-the-fly* suggested playlist for a topic.

### 5.1 Request

```json
{
  "topic": "sécurité sur chantier et prévention des risques",
  "max_steps": 3,
  "language": "fr-FR"    // optional filter on deck language
}
```

Validation:
- `topic` length 3–500
- `max_steps` 2–8
- `language` optional; if set, the catalog passed to GPT is filtered to that language first

### 5.2 Prompt / response format

The backend:

1. Fetches the full catalog from Cosmos (`presentations`).
2. Optionally filters by `language`.
3. Passes `[{deck_id, title, language, slide_count}]` plus the user topic to **GPT-4.1** with
   `response_format={"type":"json_object"}` and `temperature=0.2`.
4. Enforces a strict JSON schema (`RecommendResponse` — title, description, steps with deck_id + rationale).
5. Validates every returned `deck_id` against the catalog (rejects hallucinations) and hydrates each step with the
   real title + slide count.

### 5.3 UI flow

`PlaylistsPage` has a **"✨ Recommend with AI"** button that opens the recommend modal:

1. User enters topic, picks max steps + language.
2. Modal calls `recommendPlaylist()` and shows a preview with per-step rationale.
3. Clicking **"Accept & customize"** prefills the create-playlist modal with the suggestion so the user can edit
   before saving.

### 5.4 Validation

Tested end-to-end with `tests/e2e_full.py` against the 9 fixture decks. Last run (3 topics, 3 languages):

| Topic | Expected keyword group | GPT-4.1 result |
|---|---|---|
| "sécurité sur chantier et prévention des risques" (`fr-FR`) | `safety` group | `securite-bases → risques-chantier → intervention-urgence` ✅ ordered from basics to advanced |
| "language models, RAG and AI agents with MCP" (`en-US`) | `genai` group | expected `ai-models-intro → context-engineering-rag → ai-agents-mcp` (fixture group refreshed — not re-run yet) |
| "inteligencia artificial en la industria y su ética" (`es-ES`) | `ai` group | `ia-industrial-intro → ia-en-produccion → etica-ia-empresa` ✅ ordered from basics to advanced |

---

## 6. Testing

### 6.1 E2E coverage

| Script | Scope | Last run |
|---|---|---|
| `tests/e2e_full.py` | Reset all Cosmos containers + video library → upload 9 fixture decks → catalog + search + playlists + progress + AI recommend → video/podcast smoke | 30/30 passed |
| `tests/e2e_render.py` | Video + podcast full render, one language or multi-language sweep | 30/30 passed multi-language (fr-FR / en-US / es-ES × video + podcast) |
| `tests/test_playlists_api.py` | pytest — playlists CRUD, progress, AI recommend (incl. catalog validation) | 4 passed, 1 skipped (LLM-dependent) |
| `tests/playlists.spec.ts` | Playwright UI — create playlist, recommend modal, light language selector regression | 9 passed |

### 6.2 Fixtures

`tests/fixtures/samples/` contains 9 coherent decks in 3 thematic groups:

- **Group A — Safety (FR-FR):** `securite-bases`, `risques-chantier`, `intervention-urgence`
- **Group B — Generative AI (EN-US):** `ai-models-intro`, `context-engineering-rag`, `ai-agents-mcp`
- **Group C — AI in industry (ES-ES):** `ia-industrial-intro`, `ia-en-produccion`, `etica-ia-empresa`

Each deck: 5 slides, 2-sentence speaker notes, progresses from intro → deepening → application. Regenerate from
`python tests/fixtures/samples/_generate.py`. The 6 single-topic decks in `tests/fixtures/decks/` (used by
`tests/test_decks_api.py` and the Playwright specs) come from `python scripts/make_multideck_test.py`.

### 6.3 Running locally

```powershell
# Target: local dev started with ./run-local.ps1 (AUTH_MODE=disabled → no sign-in needed).
# A deployed instance answers 401/403 on the gated endpoints these suites use.
$BASE = "http://localhost:8000"   # or set $env:AI_PRESENTER_BASE_URL

# Cheap (~1 min) — WARNING: resets (deletes) all decks, playlists and library items first
python tests/e2e_full.py --base-url $BASE

# Expensive (~10 min + TTS tokens) — full video + podcast media render, English only
python tests/e2e_render.py --base-url $BASE

# Multi-language render sweep (~30 min) — fr-FR (Safety), en-US (Generative AI), es-ES (AI in industry)
python tests/e2e_render.py --base-url $BASE --languages fr-FR,en-US,es-ES
```

`--skip-reset` preserves existing data when iterating locally. `--skip-video` / `--skip-podcast` in `e2e_render.py`
let you run one feature at a time.

---

## 7. Azure resources

| Resource | Name | Purpose |
|---|---|---|
| Azure AI Search | `srch-<token>` | Free SKU, index `decks`, hybrid search |
| Cosmos DB (Serverless) | `cosmos-<token>` | Containers `presentations` (decks `source="deck"` + playlists `source="playlist"`) + `playlist_progress` |
| Blob Storage | `st<token>` | Slide PNGs + PPTX sources |
| Azure OpenAI | `oai-*` | `gpt-4.1` (chat + recommend) + `text-embedding-3-small` (indexing) |
| Azure AI Speech | `speech-*` | DragonHD TTS + batch avatar |
| Container App | `ca-<token>` | FastAPI + React SPA |
| ACR | `cr<token>` | Container image registry |

`<token>` is the per-environment suffix generated by the `infra/` Bicep. Deploy with `azd up` / `azd deploy` (see
[README › Azure Deployment](../README.md#️-azure-deployment)), or manually via
`az acr build -r <acr-name> -t oz-radio/backend-<env>:<tag> --no-logs .` then
`az containerapp update -n ca-<token> -g <resource-group> --image <acr-name>.azurecr.io/oz-radio/backend-<env>:<tag>`.

---

## 8. Known limitations / open items

- **Search index rebuild** — there is no one-click "re-index all decks" endpoint; `POST /api/decks/upload` re-ingests
  individually.
- **Language filter in recommend** — if the user picks a language that has fewer than `max_steps` decks, the response
  may be shorter than requested (GPT currently respects "don't invent content").
- **Playlist progress aggregation** — the player records progress per user, but there is no dashboard view of global
  playlist completion yet.
- **Single admin role** — anonymous visitors only see **published** decks (slide images, titles and the visible slide
  text) and, when enabled, can run the live demo; uploads, search, playlists and the interactive avatar require a Microsoft Entra ID
  sign-in on the `ALLOWED_OBJECT_IDS` allowlist (see [README › Security model](../README.md#-security-model)). There
  is no per-user playlist ownership yet.

---

## 9. Related docs

- [../README.md](../README.md) — overall project readme + API reference
- [video.md](video.md) — narrated video generator
- [podcast.md](podcast.md) — two-avatar podcast generator
- [live-demo.md](live-demo.md) — public live avatar demo
- [deep-dive-azure.md](deep-dive-azure.md) — infrastructure walkthrough
