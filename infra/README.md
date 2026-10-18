# Infrastructure (azd + Bicep)

> Step-by-step provisioning (prerequisites, Entra app, quota, smoke test, teardown):
> [docs/provisioning.md](../docs/provisioning.md). Coding agents: [BOOTSTRAP.md](../BOOTSTRAP.md).

`azd up` provisions everything into `rg-<AZURE_ENV_NAME>`:

| Resource | Notes |
|---|---|
| User-assigned managed identity `id-*` | Created first; used for ACR pull and every data-plane call (`AZURE_CLIENT_ID`). |
| Container Registry `cr*` | Admin user disabled; the identity has `AcrPull`. |
| Container Apps environment + app `ca-*` | Scale 0–1 replicas, Easy Auth (Microsoft Entra ID) in hybrid mode. |
| Azure OpenAI `oai-*` | Local (key) auth disabled. |
| Azure AI Services `ais-*` (Speech/Avatar) | Skipped when an external resource is used. Local auth disabled. |
| Cosmos DB (serverless) | Local (key) auth disabled; RBAC data contributor for the identity. |
| Storage account | Shared-key access disabled; SAS URLs are signed with a user delegation key. |
| Log Analytics workspace | Container Apps logs (key never emitted as an output). |
| Budget (optional) | Monthly, alerts at 80 % actual and 100 % forecasted. |

## Authentication (fail closed)

A `preprovision` hook (`hooks/preprovision.ps1` / `hooks/preprovision.sh`) aborts
`azd provision` / `azd up` unless these azd env values are set:

```bash
azd env set AUTH_CLIENT_ID <entra-app-client-id>
azd env set AUTH_CLIENT_SECRET <entra-app-client-secret>   # stored as a Container App secret
azd env set ALLOWED_OBJECT_IDS <oid1>,<oid2>                # admins (Entra object IDs)
azd env set AUTH_TENANT_ID <tenant-guid>                    # optional, defaults to the subscription tenant
```

The app registration needs the redirect URI
`https://<app-fqdn>/.auth/login/aad/callback` and ID-token issuance.
Easy Auth runs with `unauthenticatedClientAction: AllowAnonymous`: anonymous
visitors reach the SPA and the published library; the backend authorizes every
other route from the platform-injected principal headers and `ALLOWED_OBJECT_IDS`.

For a throw-away, public, read-only demo only, `azd env set ALLOW_INSECURE_NO_AUTH true`
skips the check (loud warning). Easy Auth is then not configured and the admin
allowlist is forced empty, so nobody can act as admin.

## Optional settings (azd env)

| Variable | Default | Purpose |
|---|---|---|
| `ALLOWED_ORIGINS` | empty | Extra CORS / WebSocket origins (comma-separated); same-origin is always allowed. |
| `AUTH_EXTRA_CLIENT_APPS` | empty | Extra client application IDs allowed to call the app with bearer tokens (e.g. Azure CLI `04b07795-8ddb-461a-bbee-02f9e1bf7b46` for scripted tests, which also needs pre-authorization on the app registration). Empty = only the app itself. |
| `CUSTOM_AVATARS_JSON` | empty | JSON array of custom photo avatars (`id`, `character`, `display_name`, `gender`, `thumbnail`, `default`, `kind`, optional `podcast_crop`). Thumbnails must exist in `demos/backend/static/avatars/` at build time. Photo avatars need the Speech resource that hosts them (`USE_EXTERNAL_AI_SERVICES`). See [`docs/provisioning.md` §4.1](../docs/provisioning.md#41-custom-photo-avatars-optional). |
| `HIDE_STOCK_AVATARS` | `false` | When `true` **and** at least one custom avatar is configured, the stock avatars are hidden from every picker/catalog; stock ids still resolve, as aliases to a same-gender custom avatar. Ignored when `CUSTOM_AVATARS_JSON` is empty. |
| `ENABLE_URL_INGEST` | `false` | Allow podcast URL ingestion. |
| `MAX_VOICE_SESSIONS` / `MAX_VOICE_SESSION_SECONDS` | `2` / `900` | Live avatar limits. |
| `DAILY_GENERATION_QUOTA` / `MAX_PENDING_RENDERS` | `50` / `3` | Cost guardrails. |
| `MAX_CONCURRENT_COMPOSES` | `1` | Podcast compose steps (ffmpeg) running at once on the replica (2 vCPU); other renders wait for the slot. |
| `MAX_ACTIVE_BATCH_JOBS` / `SPEECH_BATCH_CREATE_PER_MIN` | `8` / `2` | Batch avatar jobs active at once (podcast talking turns and listener kits) and job creations per rolling 60 s. The Speech batch avatar API accepts about 2 creations per minute (then HTTP 429 with `Retry-After`); raise the second value only if your resource has a higher quota. |
| `PODCAST_PUBLIC_AUDIO` | `false` | Kill switch for public listening. `true`: anonymous visitors of **published** podcasts get the radio MP3 (15-minute SAS), cover art, host names and the full transcript, and audio-only episodes appear in the public library. `false`: video and thumbnail only; audio-only episodes are hidden (their detail returns 404). Subtitle files, SCORM packages and scripts are never public. See [`docs/podcast.md`](../docs/podcast.md#61-public-access). |
| `PODCAST_REACTIONS` | `false` | Kill switch for listener backchannels ("mm-hmm", "right", …) in new renders, video and audio alike. A render's `reactions` option only takes effect when this is `true`. Existing episodes are not changed. |
| `PODCAST_LISTENER_MODE` | `auto` | How the non-speaking host is drawn in video podcasts: `auto` / `idle_loop` (cached silent "listening" loop when available, else a procedural sway), `procedural` (sway on a still frame) or `still`. `procedural` and `still` skip listener-kit synthesis unless reactions need the clips. |
| `PODCAST_LISTENER_TIMEOUT_SEC` | `900` | How long a video render waits for the listener kits (minimum 30). Past it the render uses the fallback listener and records the `listener_timeout` warning. Pre-build kits with `python -m maintenance.content warm-listeners`. |
| `PUBLIC_DEMO_ENABLED` | `false` | Kill switch for the anonymous, narration-only live avatar demo (`/ws/voice/demo`). Only decks an admin marked *Live demo* can be narrated. See [`docs/live-demo.md`](../docs/live-demo.md). |
| `DEMO_MAX_CONCURRENT` / `DEMO_SESSION_SECONDS` | `1` / `180` | Concurrent anonymous demo sessions (separate from `MAX_VOICE_SESSIONS`) and hard cap per session. |
| `DEMO_DAILY_SESSIONS` / `DEMO_DAILY_SESSIONS_PER_IP` | `20` / `3` | Demo sessions per UTC day, globally and per client IP. Worst case avatar minutes/day = `DEMO_DAILY_SESSIONS` × `DEMO_SESSION_SECONDS` / 60 (60 min with defaults). |
| `DEMO_DAILY_MINUTES` | `60` | Hard cap on total public-demo streaming minutes per UTC day (durable counter in Cosmos). |
| `DEMO_MAX_SPEAKS` | `0` | Narrations per demo session; `0` = 2 × slide count (hard max 40). |
| `DEMO_QUOTA_EXEMPT_IPS` | *(empty)* | Comma-separated client IPs/CIDRs (e.g. the owner's home IP) exempt from the demo daily quotas. Matched against the trusted proxy hop, so it cannot be spoofed via `X-Forwarded-For`; exempt sessions don't consume the visitors' budget but still respect `DEMO_MAX_CONCURRENT` and `DEMO_SESSION_SECONDS`. Keep it in the azd env, not in git. |
| `DEMO_QA_ENABLED` | `false` | Raise-hand voice Q&A in the public demo (visitors ask by voice; STT + grounded answer from the deck, spoken by the avatar). Needs `PUBLIC_DEMO_ENABLED=true` too. When on, the demo session cap becomes `DEMO_QA_SESSION_SECONDS`. Enable only after the smoke test passes: see [`docs/provisioning.md` §6.3](../docs/provisioning.md#63-voice-qa-in-the-public-demo-demo_qa_enabled) and [`docs/live-demo.md`](../docs/live-demo.md#raise-hand-qa). |
| `DEMO_QA_MAX_QUESTIONS` / `DEMO_QA_SESSION_SECONDS` | `2` / `300` | Questions per demo session (each `qa.begin` counts, even if cancelled) and the demo session cap used instead of `DEMO_SESSION_SECONDS` when demo Q&A is on. |
| `DEMO_QA_DAILY_MAX` / `DEMO_QA_DAILY_PER_IP` | `40` / `6` | Demo questions per UTC day, globally and per client IP (durable in the same Cosmos `demo-quota-<day>` doc; fails closed). Exempt IPs skip these daily counters. |
| `USE_EXTERNAL_AI_SERVICES` | `false` | Reuse an existing AI Services / Speech resource (e.g. one hosting custom photo avatars). |
| `EXTERNAL_AI_SERVICES_ENDPOINT` / `_REGION` / `_RESOURCE_ID` | empty | Details of that resource (may be in another resource group of the same subscription). |
| `ASSIGN_EXTERNAL_AI_SERVICES_ROLES` | `true` | Grant the app identity `Cognitive Services User`, `Cognitive Services Speech User` and `Foundry User` on the external resource. Requires Owner / User Access Administrator on its resource group; set `false` and assign them manually otherwise. |
| `EXTRA_TAGS_JSON` | empty | JSON object merged into every resource's tags, e.g. `{"CostCenter":"demo"}`. Use it for tags required or exempted by policy on policy-managed enterprise subscriptions. |
| `BUDGET_CONTACT_EMAILS` | empty | Comma-separated recipients; the budget is deployed only when set. |
| `BUDGET_AMOUNT` | `50` | Monthly amount in the billing currency. |
| `BUDGET_START_DATE` | current month | `yyyy-MM-01`; pin it to the creation month if a later re-provision rejects a changed start date. |

Values are strings in the azd environment; JSON values must be valid JSON
with every inner `"` escaped (same single-quoted string in bash and PowerShell 7.3+), e.g.
`azd env set EXTRA_TAGS_JSON '{\"CostCenter\":\"demo\"}'`.

> **JSON values must be escaped.** azd substitutes env values verbatim into `main.parameters.json`, so every `"` inside `EXTRA_TAGS_JSON` / `CUSTOM_AVATARS_JSON` must be written as `\"` (backslash-quote), as in the examples, or provisioning fails with *invalid character after object key:value pair*.

Concurrency, rate-limit and per-user generation counters are in-process; the Container App is capped at one replica, so
they are global for the deployment. The public-demo daily counters (sessions, minutes, questions)
are durable in Cosmos (`demo-quota-<day>`), survive restarts and scale-to-zero, and fail closed.
Per-IP counting uses the rightmost `X-Forwarded-For` entry, which is the one
the Container Apps ingress appends; put no other proxy in front without
revisiting that assumption.

### Podcast radio and listener flags (staged rollout)

Change a flag with `azd env set <NAME> <value>` then `azd provision`: the app
gets a new revision with the same image. Recommended order when enabling the
radio rendition, the live listener and public listening on an existing
deployment:

1. Deploy with `PODCAST_PUBLIC_AUDIO=false`, `MAX_PENDING_RENDERS=1` at first,
   and `PODCAST_REACTIONS=true` once a sample render with reactions has been
   reviewed. Check the logs.
2. In the container (`az containerapp exec`), run
   `python -m maintenance.content warm-listeners`, re-render the episodes
   (`render-podcast all --force`), review them as an admin, then hide the
   superseded items with `publish --podcast-id <old id> --off` (kept for rollback).
3. Set `PODCAST_PUBLIC_AUDIO=true` and check the public library anonymously.
4. Only then delete the superseded items with
   `purge --podcast-id <old id> --record deleted.json`.

Rollback before step 4: set `PODCAST_PUBLIC_AUDIO=false` (and, if needed,
`PODCAST_REACTIONS=false` or `PODCAST_LISTENER_MODE=still`), republish the old
items (`publish --podcast-id <old id>`) and hide the new ones (`--off`).
`PODCAST_REACTIONS` and `PODCAST_LISTENER_MODE` only affect new renders:
episodes already rendered keep their backchannels and listener. See
[`docs/podcast.md`](../docs/podcast.md#44-operator-cli) for the CLI.

## Not provisioned

Azure AI Search is not part of this template (`USE_LOCAL_SEARCH=true`). If you
add one, disable its local auth and grant the identity `Search Index Data
Contributor` and `Search Service Contributor` instead of using an admin key.
