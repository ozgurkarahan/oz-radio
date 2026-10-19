# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| `main` (latest commit) | ✅ |
| Older commits, forks, tags | ❌ |

This is a demo / portfolio project. Security fixes land on `main` only.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report vulnerabilities privately through GitHub's **private vulnerability reporting**:
open the repository's **Security** tab → **Report a vulnerability**. Include:

- the affected endpoint, file or configuration,
- reproduction steps or a proof of concept,
- the impact you observed (data exposure, cost abuse, privilege escalation, …).

You should get an acknowledgement within a few days. Please give a reasonable
window to fix the issue before any public disclosure.

## Security model (summary)

The app uses a **hybrid exposure** model, enforced by the FastAPI backend with
**default deny** (see [README › Security model](README.md#-security-model) for
details):

- **Anonymous** callers may load the SPA, call `GET /api/health`, `GET /api/me`,
  `GET /api/avatars`, list and play **published** videos / podcasts and
  view **published** decks (slide images, titles and the visible slide text — no
  speaker notes, translations or PPTX download).
- **Public podcast audio** (supersedes the earlier "no audio in public DTOs"
  rule): with `PODCAST_PUBLIC_AUDIO=true` (default `false`, the kill switch),
  anonymous callers also get a published podcast's radio MP3, cover art, host
  names and full transcript, and audio-only episodes are listed. Without it,
  the public DTO carries no audio, cover, host names or transcript (video and
  thumbnail only), and audio-only episodes are hidden (their detail answers
  404). Subtitle files (SRT), SCORM packages and scripts are never public;
  published video episodes expose their captions as WebVTT. One
  publish flag covers every rendition of an episode.
- **Admins** — callers signed in with **Microsoft Entra ID** through Azure
  Container Apps built-in authentication (**Easy Auth**) whose object ID is in
  `ALLOWED_OBJECT_IDS` — can do everything else (uploads, live avatar, renders,
  translation, agent chat, publish/unpublish, deletes, unpublished items).
- Gated endpoints answer **401** (anonymous) or **403** (signed in but not
  allowlisted). The live-avatar WebSocket (`/ws/voice`) is authorized and its
  `Origin` checked **before** the connection is accepted.
- Identity headers (`X-MS-CLIENT-PRINCIPAL*`) are trusted only when
  `AUTH_MODE=easyauth`; Azure Container Apps strips client-supplied copies.
  The tenant (`AUTH_TENANT_ID`) and identity provider (`aad`) are verified.
- Generated content is **unpublished by default**. Anonymous media links are
  read-only, blob-scoped SAS URLs that expire after 15 minutes (public thumbnails
  and covers are signed per 10-minute window, so the browser cache can reuse
  them); podcast responses carrying SAS URLs are sent with
  `Cache-Control: no-store`.
- **Speech character names** of custom photo avatars can identify the
  customer: they stay server-side and never appear in blob names, manifests,
  cache sidecars, logs, job warnings (stable codes only), ID3 tags or API
  payloads. Radio MP3 ID3 tags come from an allow-list (episode title, host
  names, album, genre, year, language and an "AI-generated voices" comment; no
  embedded picture, the cover is a separate file). The listener-kit cache (`podcast-cache/listener-kit/`) is private
  and never SAS-signed, and anonymous traffic never triggers synthesis.
- Azure services are reached with a **managed identity** (`DefaultAzureCredential`);
  Speech credentials are never sent to the browser.
- Cost / abuse guards: `MAX_VOICE_SESSIONS`, `MAX_VOICE_SESSION_SECONDS`,
  `DAILY_GENERATION_QUOTA`, `MAX_PENDING_RENDERS`, `MAX_CONCURRENT_COMPOSES`,
  `MAX_ACTIVE_BATCH_JOBS`, `SPEECH_BATCH_CREATE_PER_MIN`, plus an Azure budget alert.
- `AUTH_MODE=disabled` exists **for local development only**: every caller is
  treated as admin and the backend logs a warning at startup. On Azure Container
  Apps the backend refuses it: it keeps Easy Auth and logs one `CRITICAL` line.

## Operator checklist

Before (and after) every deployment of your own instance:

- [ ] **Entra app registration** — create a dedicated app registration for sign-in
      (web redirect URI `https://<your-app-fqdn>/.auth/login/aad/callback`, ID
      tokens enabled) and a client secret; set `AUTH_CLIENT_ID` and
      `AUTH_CLIENT_SECRET` in the `azd` environment. Rotate the secret before it
      expires and never commit it.
- [ ] **Allowlist** — set `ALLOWED_OBJECT_IDS` to the Entra object IDs of the
      people who may administer the app (keep it short). An empty list means
      nobody is admin. The `azd` preprovision hook refuses to deploy without
      `AUTH_CLIENT_ID`, `AUTH_CLIENT_SECRET` and `ALLOWED_OBJECT_IDS`.
- [ ] **Keep `AUTH_MODE=easyauth` in Azure** — never deploy with
      `AUTH_MODE=disabled`, and never expose a local `AUTH_MODE=disabled`
      instance to a network. The backend refuses `disabled` on Container Apps
      anyway; admin tests against production use Entra bearer tokens
      ([provisioning §3.1](docs/provisioning.md#31-admin-tests-against-production)).
- [ ] **Budget alert** — set `BUDGET_CONTACT_EMAILS` (and `BUDGET_AMOUNT`) in the
      `azd` environment; no budget is deployed without recipients. Confirm the
      monthly alert on the resource group has the right amount and recipients. Live avatar streaming and batch
      avatar synthesis are billed per minute of video.
- [ ] **Limits** — review `MAX_VOICE_SESSIONS`, `MAX_VOICE_SESSION_SECONDS`,
      `DAILY_GENERATION_QUOTA`, `MAX_PENDING_RENDERS`, `MAX_CONCURRENT_COMPOSES`
      and `MAX_ACTIVE_BATCH_JOBS` for your expected usage.
- [ ] **Origins & framing** — only add trusted origins to `ALLOWED_ORIGINS`;
      keep `FRAME_ANCESTORS` limited to the hosts that embed the app (Teams /
      Office by default).
- [ ] **Publishing** — review what is published; anything published is
      visible to anyone with the URL.
- [ ] **Public podcast audio** — keep `PODCAST_PUBLIC_AUDIO=false` until the
      published podcasts have been reviewed as an admin (audio, transcript,
      cover): once it is on, their audio and full transcript are public.
      Setting it back to `false` withdraws them for every new request (links
      already handed out expire within 15 minutes), with no re-render.
- [ ] **Custom avatars** — keep avatar photos out of git
      (`demos/backend/static/avatars/` is ignored) and only use likenesses you
      have consent for.
- [ ] **URL ingestion** — leave `ENABLE_URL_INGEST=false` unless you need it.
