# Provisioning Oz Radio on Azure

> **Last verified:** 2026-10 against the repo (`azure.yaml`, `infra/`, `hooks/`, `Dockerfile`, `demos/backend/`).
> The steps are documented from the code and must be validated on a fresh environment
> (clean subscription and app registration). Report anything that doesn't match.
> Coding agents should follow [`BOOTSTRAP.md`](../BOOTSTRAP.md). It points to the sections below.

Oz Radio ships as **one Azure Container App** plus its backing services. They
are provisioned with the Azure Developer CLI (`azd`) and Bicep (`infra/`).
Everything here comes from `azure.yaml`, `infra/`, `hooks/` and `Dockerfile`.
Placeholders look like `<this>`. Never commit real IDs or secrets.

**Contents:** [1. What gets deployed](#1-what-gets-deployed) ·
[2. Prerequisites](#2-prerequisites) ·
[3. Entra app registration](#3-entra-app-registration-easy-auth) ·
[4. azd environment variables](#4-azd-environment-variables) ·
[5. Deploy](#5-deploy) · [6. Post-deploy](#6-post-deploy-configuration) ·
[7. Smoke test](#7-smoke-test-checklist) · [8. Local development](#8-local-development) ·
[9. Troubleshooting](#9-troubleshooting) · [10. Cost and teardown](#10-cost-notes-and-teardown)

---

## 1. What gets deployed

`azd up` creates one resource group, `rg-<AZURE_ENV_NAME>`. All resources share
`AZURE_LOCATION`. Names end in a deterministic token:
`uniqueString(subscription, env name, location)`.

| Component | Purpose | Created by | Key settings (from Bicep) |
|---|---|---|---|
| User-assigned managed identity `id-*` | Pulls images from ACR and makes every data-plane call (`AZURE_CLIENT_ID`) | Bicep (`identity.bicep`) | Created first, so the roles exist before the app starts |
| Container Registry `cr*` | Stores the backend image | Bicep (`registry.bicep`) | SKU Basic. Admin user disabled. Identity has `AcrPull`. `azd` builds the image **remotely in ACR** (`remoteBuild: true`) |
| Azure OpenAI `oai-*` | Translation, Q&A, scripts and embeddings | Bicep (`openai.bicep`) | Kind `OpenAI`, S0, `disableLocalAuth: true`. Deployments: `gpt-4.1` (version `2025-04-14`, **GlobalStandard, capacity 80**) and `text-embedding-3-small` (version `1`, **GlobalStandard, capacity 120**) |
| Azure AI Services `ais-*` | Speech: Voice Live, real-time avatar (WebRTC), batch avatar and DragonHD voices | Bicep (`ai-services.bicep`), **unless** `USE_EXTERNAL_AI_SERVICES=true` | Kind `AIServices`, S0, `disableLocalAuth: true`. Identity has Cognitive Services User, Cognitive Services Speech User and Foundry User |
| *External AI Services* (optional) | Reuses an existing Speech/Foundry resource, for example one that hosts custom photo avatars | You (pre-existing) | `EXTERNAL_AI_SERVICES_ENDPOINT` / `_REGION` / `_RESOURCE_ID`. Same subscription, any resource group. The same three roles are assigned there if `ASSIGN_EXTERNAL_AI_SERVICES_ROLES=true` |
| Cosmos DB `cosmos-*` | Presentations, decks, playlists, demo quota counters | Bicep (`cosmos.bicep`) | **Serverless**, `disableLocalAuth: true`. Database `ai-presenter`. Containers `presentations` (`/id`) and `playlist_progress` (`/user_id`). Identity has Built-in Data Contributor |
| Storage account `st*` | Slide images, source files, rendered media | Bicep (`storage.bicep`) | StorageV2 LRS. **`allowSharedKeyAccess: false`**. No public blob access. Container `slide-images`. SAS URLs use a user-delegation key. Identity has Storage Blob Data Contributor |
| Log Analytics `cae-*-logs` | Container Apps logs; Blob `StorageRead` access logs (podcast audio reads, unless `ENABLE_BLOB_ACCESS_LOGS=false`) | Bicep (`containerapp.bicep`, `blob-access-logs.bicep`) | PerGB2018, 30-day retention |
| Container Apps environment `cae-*` and app `ca-*` | Hosts the FastAPI backend and the built React SPA (port 8000) | Bicep (`containerapp.bicep`) | **2 vCPU / 4 GiB**, scale **0–1** replicas (`MIN_REPLICAS`: `0` = scale to zero, the default; `1` = always on, see [§10](#10-cost-notes-and-teardown)). External HTTPS ingress. `AUTH_MODE=easyauth` (the backend refuses `disabled` on Container Apps). `USE_LOCAL_SEARCH=true` |
| Easy Auth (Microsoft Entra ID) | Sign-in. Hybrid mode: anonymous visitors are let through and the backend authorizes each route | Bicep (`authConfigs`), **only when `AUTH_CLIENT_ID` is set** | `unauthenticatedClientAction: AllowAnonymous`, `requireHttps`. Issuer `…/<tenant>/v2.0`. The client secret is stored as a Container App secret |
| Budget `budget-<env>` | Cost alert on the resource group | Bicep (`budget.bicep`), **only when `BUDGET_CONTACT_EMAILS` is set** | Monthly, `BUDGET_AMOUNT` (default 50). Alerts at 80% actual and 100% forecasted |
| Entra app registration | Easy Auth client | **You** (manual, [§3](#3-entra-app-registration-easy-auth)) | Not created by Bicep and not deleted by `azd down` |
| Azure AI Search | — | **Not provisioned** | Deck search runs in-process (`USE_LOCAL_SEARCH=true`) |

Architecture: [architecture.md › Deployment Architecture](architecture.md#deployment-architecture-azure)
and the diagram [azure-architecture.png](diagrams/images/azure-architecture.png).
For a deeper walkthrough see [deep-dive-azure.md](deep-dive-azure.md).
Parameter reference: [infra/README.md](../infra/README.md).

---

## 2. Prerequisites

### 2.1 Tools

- [ ] **Azure Developer CLI** (`azd version`). It provisions the Bicep and installs the Bicep CLI when needed.
- [ ] **Azure CLI** (`az version`). Used for the Entra, quota, provider and log steps below.
- [ ] **Windows: PowerShell 7+** (`pwsh -v`). The preprovision hook runs with `shell: pwsh`.
      macOS/Linux: the hook runs with `sh`.
- [ ] **Git**, to clone the repo.
- [ ] **Docker is _not_ required** for deployment. `azure.yaml` sets `remoteBuild: true`,
      so the image is built by ACR Tasks.
- [ ] **For local development only** ([§8](#8-local-development)): Python 3.12+, Node.js 18+ (the image uses Node 20),
      LibreOffice and Poppler (slide rendering), and ffmpeg (video/podcast). The container image already includes LibreOffice, Poppler, ffmpeg and fonts.

### 2.2 Permissions

- [ ] On the subscription (or a pre-created scope): **Contributor**, plus a role that can write
      role assignments: **Owner**, **User Access Administrator** or **Role Based Access Control Administrator**.
      Bicep creates the resource group (`targetScope = 'subscription'`) and about 9 role assignments.
- [ ] If you use an external AI Services resource with `ASSIGN_EXTERNAL_AI_SERVICES_ROLES=true`, you need the same
      role-assignment right on **that resource's resource group**. Otherwise set it to `false` and ask its owner to grant the three roles ([§1](#1-what-gets-deployed)).
- [ ] **Entra ID:** rights to create an app registration and a client secret.
      By default, users can register apps; some tenants restrict this to the *Application Developer* role. You also need the
      **object IDs** of the future admins.
- [ ] Optional: users can consent to the app, or an admin grants consent for `openid profile email` / `User.Read`.

### 2.3 Resource providers

These are derived from the resource types in `infra/`. Registering a provider needs subscription-level rights.

```bash
for p in Microsoft.App Microsoft.ContainerRegistry Microsoft.CognitiveServices Microsoft.DocumentDB \
         Microsoft.Storage Microsoft.OperationalInsights Microsoft.ManagedIdentity Microsoft.Consumption; do
  echo "$p: $(az provider show -n $p --query registrationState -o tsv)"
done
az provider register -n <namespace> --wait   # for any that are not "Registered"
```

- [ ] All of the above show `Registered`. `Microsoft.Consumption` is only needed for the budget.
      `Microsoft.Resources` and `Microsoft.Authorization` are always registered.

### 2.4 Region

Every resource goes into `AZURE_LOCATION`, so one region must support **all** of these:

- [ ] Real-time **and** batch text-to-speech avatar: [Speech regions › Text-to-speech avatar](https://learn.microsoft.com/azure/ai-services/speech-service/regions?tabs=ttsavatar).
- [ ] **Voice Live**, with `gpt-4.1` available as a Voice Live model. The proxy connects with `model=gpt-4.1`, which is the chat deployment name: [Speech regions › Voice Live](https://learn.microsoft.com/azure/ai-services/speech-service/regions?tabs=voice-live).
- [ ] Azure OpenAI **`gpt-4.1` (2025-04-14)** and **`text-embedding-3-small` (1)** as **GlobalStandard**: [model region availability](https://learn.microsoft.com/azure/foundry/foundry-models/concepts/models-sold-directly-by-azure-region-availability#global-standard).
      Also check the [retirement schedule](https://learn.microsoft.com/azure/foundry/openai/concepts/model-retirement-schedule). `gpt-4.1` 2025-04-14 has a published retirement date, after which you must change the pinned version in `infra/modules/openai.bicep`.
- [ ] Azure Container Apps and Cosmos DB serverless (both available in most regions).

**Tested region: `swedencentral`.** When this runbook was written, the Speech region tables showed
real-time avatar, batch avatar, Voice Live and Voice Live `gpt-4.1` there. Re-check the links above,
because availability changes. To keep Speech in a different region, use an external AI Services resource ([§4](#4-azd-environment-variables)).

```bash
az cognitiveservices model list -l <region> \
  --query "[?model.name=='gpt-4.1' || model.name=='text-embedding-3-small'].{model:model.name, version:model.version, skus:join(',', model.skus[].name)}" -o table
```

### 2.5 Quota

The Bicep pins capacity: **80** (thousand TPM) for `gpt-4.1` and **120** for `text-embedding-3-small`, both GlobalStandard.
You can't override these with an azd variable. To lower them, edit `infra/modules/openai.bicep`.

```bash
az cognitiveservices usage list -l <region> \
  --query "[?contains(name.value,'gpt-4.1') || contains(name.value,'text-embedding-3-small')].{name:name.value, used:currentValue, limit:limit}" -o table
```

- [ ] `limit − used` is at least 80 for the GlobalStandard `gpt-4.1` row and at least 120 for the GlobalStandard `text-embedding-3-small` row.
      If not, [request quota](https://aka.ms/oai/quotaincrease) or lower the capacity in Bicep.
- [ ] No soft-deleted Cognitive Services account with the same name blocks a re-deploy: `az cognitiveservices account list-deleted -o table`.

### 2.6 Azure Policy pitfalls (enterprise / policy-managed subscriptions)

| Policy effect | Impact | What to do |
|---|---|---|
| *Require local auth disabled* (Cognitive Services, Cosmos) and *storage shared key disabled* | Already compliant: the templates set `disableLocalAuth: true` and `allowSharedKeyAccess: false` | Nothing |
| *Required tags* | Deployment denied | `EXTRA_TAGS_JSON` ([§4](#4-azd-environment-variables)) |
| *Public network access disabled* (Storage, Cosmos, Cognitive Services) | Templates set public access; a `modify`/`deny` policy breaks uploads, renders or Voice Live | See [video.md §8](video.md#8-deployment-topology). Get an exemption for the resource group, or add private networking (not in this template) |
| *Allowed locations / allowed SKUs* | Denies the region, ACR Basic, S0 or serverless | Pick an allowed region, or request an exemption |
| Deny of `Microsoft.Authorization/roleAssignments/write` | Role assignments fail; the app can't reach any service | You need a principal that can assign roles |

```bash
az policy assignment list --scope /subscriptions/<subscription-id> --query "[].{name:displayName, enforcement:enforcementMode}" -o table
```

---

## 3. Entra app registration (Easy Auth)

Bicep doesn't create this. The preprovision hook (`hooks/preprovision.ps1` / `.sh`) **fails closed**.
It refuses to provision unless `AUTH_CLIENT_ID`, `AUTH_CLIENT_SECRET` and `ALLOWED_OBJECT_IDS` are set.
`AUTH_CLIENT_ID`, `AUTH_TENANT_ID` and each object ID must be GUIDs.
The app FQDN isn't known before the first provision. Create the registration first and add the redirect URI later ([§5](#5-deploy)).

**Portal:** *Microsoft Entra ID → App registrations → New registration*.

1. Name it `Oz Radio (<env-name>)`. Supported account types: **single tenant**.
2. Platform **Web**. Redirect URI: `https://<app-fqdn>/.auth/login/aad/callback`. Leave it empty if you don't know the FQDN yet.
3. *Authentication* → enable **ID tokens** (implicit and hybrid flows).
4. *Certificates & secrets* → **New client secret**. Copy it straight into `azd env set` (below). Note the expiry date and plan a rotation.
5. Copy the **Application (client) ID** and the **Directory (tenant) ID**.

**CLI equivalent** (the secret never appears on screen):

```powershell
$appId = az ad app create --display-name "Oz Radio (<env-name>)" --sign-in-audience AzureADMyOrg `
          --enable-id-token-issuance true --query appId -o tsv
az ad sp create --id $appId | Out-Null                       # enterprise app in your tenant
azd env set AUTH_CLIENT_ID $appId
azd env set AUTH_CLIENT_SECRET (az ad app credential reset --id $appId --append --display-name oz-radio-easyauth --query password -o tsv)
azd env set AUTH_TENANT_ID (az account show --query tenantId -o tsv)   # optional; defaults to the subscription tenant
```

**Admin allowlist (`ALLOWED_OBJECT_IDS`)** is a comma-separated list of Entra **object IDs** (`oid`), not UPNs:

```bash
az ad signed-in-user show --query id -o tsv          # yourself
az ad user show --id <user@your-tenant> --query id -o tsv   # someone else
azd env set ALLOWED_OBJECT_IDS <oid-1>,<oid-2>
```

**Optional: bearer tokens for scripts** (for example `scripts/video_regen.py`):

1. Set the Application ID URI to `api://<client-id>` and add the scope `user_impersonation`.
2. Pre-authorize the Azure CLI client `04b07795-8ddb-461a-bbee-02f9e1bf7b46`.
3. Run `azd env set AUTH_EXTRA_CLIENT_APPS 04b07795-8ddb-461a-bbee-02f9e1bf7b46`.

The same tokens are how you test production as an admin: see [§3.1](#31-admin-tests-against-production).

> `ALLOW_INSECURE_NO_AUTH=true` skips the hook for a **throw-away, public, read-only** demo.
> Easy Auth isn't configured and nobody can be admin. Don't use it for a real instance.

### 3.1 Admin tests against production

**Never flip `AUTH_MODE` on Azure** (for example with `az containerapp update --set-env-vars AUTH_MODE=disabled`) to run admin
tests. `AUTH_MODE=disabled` makes every caller an admin for as long as it is set. Bicep hard-codes `AUTH_MODE=easyauth`, and the
backend now refuses `disabled` on Azure Container Apps:

- When `CONTAINER_APP_NAME` or `CONTAINER_APP_REVISION` is set (the platform sets both on every replica), `auth_mode()` returns
  `easyauth` whatever `AUTH_MODE` says, and logs one `CRITICAL` line per process: `AUTH_MODE=disabled was refused: …`.
  There is no flag to override this. Local development (no such variables) is unchanged.
- The preprovision hook stops `azd provision` when the azd environment contains `AUTH_MODE=disabled`. It reads the azd
  environment only, never your shell, so a shell that ran `run-local.ps1` is not a problem.
- To find a refused attempt: `ContainerAppConsoleLogs_CL | where Log_s has "AUTH_MODE=disabled was refused"`.
  (Older replicas logged `AUTH_MODE=disabled — every caller is treated as admin`.)

Test production as an **allowlisted user with an Entra ID bearer token** instead. After the three setup steps above
(scope, pre-authorized client, `AUTH_EXTRA_CLIENT_APPS`) and an `azd provision`:

```powershell
az login --tenant <tenant-id>             # an account whose object ID is in ALLOWED_OBJECT_IDS
$token = az account get-access-token --scope api://<client-id>/user_impersonation --query accessToken -o tsv
curl.exe -s -H "Authorization: Bearer $token" <app-url>/api/me     # "is_admin": true, "auth_mode": "easyauth"
```

Easy Auth validates the token and injects the principal headers, so the backend sees a real admin and every gated route behaves
as it does for a signed-in browser. Send the header from your test client (`requests`, Playwright's `request` fixture). Tokens
last about an hour: for long runs refresh them (`scripts/video_regen.py` and `scripts/podcast_regen.py` do it through
`AI_PRESENTER_BEARER_TOKEN` and `AI_PRESENTER_TOKEN_COMMAND`, see [README](../README.md#seeding-a-deployed-showcase-library)).
A browser page cannot add an `Authorization` header to the `/ws/voice` WebSocket handshake: for UI flows that open it, sign in once as the allowlisted
account (`/.auth/login/aad`) and reuse the saved browser state (`storageState`), whose session cookie travels with the handshake.

---

## 4. azd environment variables

Values live in `.azure/<env>/.env`. That folder is git-ignored and **holds the client secret in plain text**.
`infra/main.parameters.json` maps them to Bicep parameters. azd sets `AZURE_ENV_NAME`, `AZURE_LOCATION` and
`AZURE_SUBSCRIPTION_ID` when you run `azd env new` / the first `azd up`, and sets `SERVICE_BACKEND_IMAGE_NAME` after a deploy
(`<acr>.azurecr.io/oz-radio/backend-<env>:azd-deploy-<timestamp>`; the repository follows the `name` in `azure.yaml`).

| Variable | Req. | Default | Description |
|---|---|---|---|
| `AZURE_ENV_NAME` | ✅ | — | Environment name (1–64 chars). Gives the resource group `rg-<name>` and seeds the name token |
| `AZURE_LOCATION` | ✅ | — | Region for **all** resources ([§2.4](#24-region)) |
| `AZURE_SUBSCRIPTION_ID` | ✅ | prompted | Target subscription |
| `AUTH_CLIENT_ID` | ✅ | — | Easy Auth app (client) ID. GUID |
| `AUTH_CLIENT_SECRET` | ✅ | — | Client secret. Stored as a Container App secret. **Never print or commit it** |
| `ALLOWED_OBJECT_IDS` | ✅ | — | Comma-separated admin object IDs (GUIDs) |
| `AUTH_TENANT_ID` | | subscription tenant | Tenant used for the Easy Auth issuer and the backend `tid` check |
| `AUTH_EXTRA_CLIENT_APPS` | | empty | Extra client app IDs allowed to send bearer tokens. This is how admin tests run against production ([§3.1](#31-admin-tests-against-production)) |
| `ALLOW_INSECURE_NO_AUTH` | | `false` | Hook escape hatch for a throw-away read-only demo only (see §3) |
| `ALLOWED_ORIGINS` | | empty (same-origin) | Extra CORS / WebSocket origins |
| `CUSTOM_AVATARS_JSON` | | empty | JSON array of custom photo avatars ([§4.1](#41-custom-photo-avatars-optional)). Thumbnails must exist in `demos/backend/static/avatars/` (git-ignored) at build time |
| `HIDE_STOCK_AVATARS` | | `false` | `true` **and** at least one valid custom avatar: only custom/photo avatars are offered; legacy stock ids (`lisa`, `harry`, …) resolve to a same-gender custom avatar. Ignored when `CUSTOM_AVATARS_JSON` is empty |
| `ENABLE_URL_INGEST` | | `false` | Podcast URL ingestion |
| `MAX_VOICE_SESSIONS` / `MAX_VOICE_SESSION_SECONDS` | | `2` / `900` | Admin live-avatar limits |
| `DAILY_GENERATION_QUOTA` / `MAX_PENDING_RENDERS` | | `50` / `3` | Per-user daily renders, uploads and chats / global render queue |
| `PODCAST_PUBLIC_AUDIO` | | `false` | Anonymous visitors can stream **published** podcast audio and read its transcript (*Listen*). See [podcast.md](podcast.md) |
| `PODCAST_REACTIONS` | | `false` | Hard kill switch for listener backchannels ("mm-hmm", "right") in podcast video and radio |
| `PODCAST_LISTENER_MODE` / `PODCAST_LISTENER_TIMEOUT_SEC` | | `auto` / `900` | Listener look (`auto`, `idle_loop`, `procedural`, `still`) / max wait for the cached listener kits |
| `MAX_CONCURRENT_COMPOSES` / `MAX_ACTIVE_BATCH_JOBS` / `SPEECH_BATCH_CREATE_PER_MIN` | | `1` / `8` / `2` | ffmpeg video composes at a time / batch avatar jobs in flight / batch job creations per minute (Speech quota) |
| `PUBLIC_DEMO_ENABLED` | | `false` | Kill switch for the anonymous live avatar demo ([live-demo.md](live-demo.md)) |
| `DEMO_MAX_CONCURRENT` / `DEMO_SESSION_SECONDS` | | `1` / `180` | Demo concurrency / per-session cap |
| `DEMO_DAILY_SESSIONS` / `DEMO_DAILY_SESSIONS_PER_IP` / `DEMO_DAILY_MINUTES` | | `20` / `3` / `60` | Demo daily caps (durable in Cosmos) |
| `DEMO_MAX_SPEAKS` | | `0` | Narrations per demo session (`0` = 2 × slides, max 40) |
| `DEMO_QUOTA_EXEMPT_IPS` | | empty | IPs/CIDRs exempt from demo daily quotas. Keep it out of git |
| `DEMO_QA_ENABLED` | | `false` | Raise-hand voice and typed Q&A in the public demo (needs `PUBLIC_DEMO_ENABLED=true` too). See [§6.3](#63-voice-qa-in-the-public-demo-demo_qa_enabled) |
| `DEMO_QA_MAX_QUESTIONS` / `DEMO_QA_SESSION_SECONDS` | | `2` / `300` | Questions per demo session / demo session cap used **instead of** `DEMO_SESSION_SECONDS` when demo Q&A is on |
| `DEMO_QA_DAILY_MAX` / `DEMO_QA_DAILY_PER_IP` | | `40` / `6` | Demo questions per UTC day, global / per client IP (durable in Cosmos, fails closed) |
| `USE_EXTERNAL_AI_SERVICES` | | `false` | `true` = don't create `ais-*`; use the resource described below |
| `EXTERNAL_AI_SERVICES_ENDPOINT` / `_REGION` / `_RESOURCE_ID` | when external | empty | Endpoint (`https://<name>.cognitiveservices.azure.com/`), region, and full ARM ID |
| `ASSIGN_EXTERNAL_AI_SERVICES_ROLES` | | `true` | Assign the three AI roles on the external resource |
| `EXTRA_TAGS_JSON` | | empty | JSON object merged into every resource's tags (policy) |
| `ENABLE_BLOB_ACCESS_LOGS` | | `true` | Blob `StorageRead` diagnostic setting → the Log Analytics workspace (audio reads, expired-SAS 403s, user agents). See [infra/README.md](../infra/README.md) |
| `MIN_REPLICAS` | | `0` | Container App minimum replicas, `0` or `1` (the maximum is fixed at 1). `0` scales to zero when idle (about 30 s cold start). `1` keeps one replica always on: about **$47/month** at idle rates, up to about **$158/month** if never idle. Raise `BUDGET_AMOUNT` with it ([§10](#10-cost-notes-and-teardown)) |
| `BUDGET_CONTACT_EMAILS` | recommended | empty (no budget) | Comma-separated recipients. The budget is deployed only when this is set |
| `BUDGET_AMOUNT` / `BUDGET_START_DATE` | | `50` / current month | Monthly amount / `yyyy-MM-01`. Pin the date to keep re-provisions idempotent |

Not set through azd: `FRAME_ANCESTORS` (the backend default allows Teams/Office) and `LOG_FORWARDING_CHAIN`
(diagnostics only, see [live-demo.md](live-demo.md#implementation-notes)). Set them on the Container App if you need them.
`AUTH_MODE` is hard-coded to `easyauth` in Bicep. The backend also refuses `AUTH_MODE=disabled` on Container Apps, and the preprovision hook
stops if the azd environment contains it ([§3.1](#31-admin-tests-against-production)).

**JSON values must be backslash-escaped.** azd copies the value verbatim into `main.parameters.json`, so each `"` inside the value must be written `\"`.
The same single-quoted string works in **bash** and **PowerShell 7.3+**. In Windows PowerShell 5.1 the backslashes may be stripped; use `pwsh`.

```bash
azd env set EXTRA_TAGS_JSON '{\"CostCenter\":\"demo\",\"Owner\":\"<team>\"}'
```

If provisioning fails with *invalid character after object key:value pair*, the quotes weren't escaped.

### 4.1 Custom photo avatars (optional)

Without configuration Oz Radio offers the stock video avatars (`lisa`, `harry`, `max`, `meg`, `jeff`, `lori`).
To add your own photo avatars (custom avatars created in Azure AI Speech), set `CUSTOM_AVATARS_JSON` to a JSON
array. Each item (validated by `demos/backend/services/avatar_registry.py`; invalid items are skipped with a log warning):

| Key | Req. | Meaning |
|---|---|---|
| `id` | ✅ | Lower-case id used by the API and UI (`[a-z0-9][a-z0-9_-]{0,63}`). Must not reuse a stock id |
| `character` | ✅ | Speech `talkingAvatarCharacter` of your custom avatar. Server-only, never returned by `GET /api/avatars` |
| `display_name` | | Label in the pickers (defaults to `id`) |
| `gender` | | `female` or `male` (anything else → `female`). Used to match voices and to map stock ids when `HIDE_STOCK_AVATARS=true` |
| `thumbnail` | | File name under `demos/backend/static/avatars/` (`.png`, `.jpg`, `.jpeg` or `.webp`) |
| `default` | | `true` on the avatar to preselect. Otherwise the default is `lisa`, or the first female custom avatar when stock avatars are hidden |
| `kind` | | `photo` (default; head-only, rendered on green and chroma-keyed, no gestures) or `video` (custom video avatar) |
| `podcast_crop` | | Optional `[x, y, w, h]` (normalized 0..1) head-and-shoulders crop for the podcast tiles. Defaults per kind |

Set it with escaped quotes ([§4](#4-azd-environment-variables)). The two examples are the same string:

```powershell
# PowerShell 7.3+ (pwsh)
azd env set CUSTOM_AVATARS_JSON '[{\"id\":\"photo_female\",\"display_name\":\"Photo avatar (F)\",\"character\":\"<speech-avatar-character>\",\"gender\":\"female\",\"thumbnail\":\"photo_female.png\",\"default\":true,\"kind\":\"photo\"},{\"id\":\"photo_male\",\"display_name\":\"Photo avatar (M)\",\"character\":\"<speech-avatar-character>\",\"gender\":\"male\",\"thumbnail\":\"photo_male.png\",\"kind\":\"photo\",\"podcast_crop\":[0.06,0.0,0.88,1.0]}]'
azd env set HIDE_STOCK_AVATARS true      # optional: offer only the custom avatars
```

```bash
# bash / zsh
azd env set CUSTOM_AVATARS_JSON '[{\"id\":\"photo_female\",\"display_name\":\"Photo avatar (F)\",\"character\":\"<speech-avatar-character>\",\"gender\":\"female\",\"thumbnail\":\"photo_female.png\",\"default\":true,\"kind\":\"photo\"},{\"id\":\"photo_male\",\"display_name\":\"Photo avatar (M)\",\"character\":\"<speech-avatar-character>\",\"gender\":\"male\",\"thumbnail\":\"photo_male.png\",\"kind\":\"photo\",\"podcast_crop\":[0.06,0.0,0.88,1.0]}]'
azd env set HIDE_STOCK_AVATARS true
```

- **Thumbnails** go in `demos/backend/static/avatars/`. The folder is **git-ignored** (avatar photos are never committed),
  so a fresh clone has none: copy them in on the machine that runs `azd deploy`. They are **baked into the image**
  (`.dockerignore` keeps the folder in the build context). After adding or changing one, run `azd deploy`.
- **Speech resource.** A custom avatar exists only in the Speech resource where it was created. Point Oz Radio at it with
  `USE_EXTERNAL_AI_SERVICES=true` plus `EXTERNAL_AI_SERVICES_ENDPOINT`, `EXTERNAL_AI_SERVICES_REGION` and
  `EXTERNAL_AI_SERVICES_RESOURCE_ID` ([§1](#1-what-gets-deployed), [§2.2](#22-permissions)). All Speech traffic
  (Voice Live, avatar, batch renders, question transcription) then goes to that resource, so its region must meet [§2.4](#24-region).
- **`HIDE_STOCK_AVATARS=true`** only takes effect when at least one custom avatar is valid. Saved jobs, library items and
  old clients that reference a stock id keep working: the id resolves to a custom avatar of the same gender.
- Changing `CUSTOM_AVATARS_JSON`, `HIDE_STOCK_AVATARS` or the external-resource variables needs `azd provision`.
  Check the result with `curl -s <app-url>/api/avatars`.

---

## 5. Deploy

```bash
azd auth login                       # add --tenant-id <tenant-id> if you have several tenants
az login                             # for the az commands in this guide
azd env new <env-name>               # or: azd env select <env-name>
azd env set AZURE_LOCATION swedencentral
azd env set AZURE_SUBSCRIPTION_ID <subscription-id>
# §3: AUTH_CLIENT_ID, AUTH_CLIENT_SECRET, ALLOWED_OBJECT_IDS (+ AUTH_TENANT_ID)
azd env set BUDGET_CONTACT_EMAILS <ops@your-domain>
azd env set BUDGET_AMOUNT 50
```

**Option A (recommended for the first run): provision, register the redirect URI, then deploy.**

```bash
azd provision                                        # runs the preprovision hook, then Bicep
azd env get-value AZURE_CONTAINER_APP_URL            # https://ca-<token>.<env-id>.<region>.azurecontainerapps.io
az ad app update --id <client-id> --web-redirect-uris "<AZURE_CONTAINER_APP_URL>/.auth/login/aad/callback"
azd deploy                                           # remote ACR build + new revision
```

`--web-redirect-uris` **replaces** the list. Include any existing URIs you want to keep.

**Option B:** `azd up` (provision and deploy). Then add the redirect URI the same way.
Sign-in fails with a redirect-URI mismatch until you do.

After that:

| Change | Command |
|---|---|
| Code only | `azd deploy` |
| azd variables or Bicep | `azd provision`. A new revision picks up the env vars |
| Both | `azd up` |

Before the first `azd deploy`, the app runs a placeholder `containerapps-helloworld` image.

---

## 6. Post-deploy configuration

### 6.1 First use

1. Open `AZURE_CONTAINER_APP_URL`. With the default `MIN_REPLICAS=0` the app scales to zero, so the first request after an idle period can take about 30 s ([§10](#10-cost-notes-and-teardown) for the always-on option).
2. Sign in from the header link (`/.auth/login/aad`). Consent if prompted.
3. **Decks:** upload a `.pptx`. Samples are in `tests/fixtures/samples/`.
4. **Seed content (optional):** the repo ships an avatar-narrated **AI enablement** series in `content/ai-enablement/`
   (Beginner, Practitioner and Expert decks plus a 5-slide public-demo cut). Upload, publish, build the
   *AI enablement path* playlist and mark only the demo cut *Live demo* by following
   [content/ai-enablement/README.md › Seed the series in Oz Radio](../content/ai-enablement/README.md#seed-the-series-in-oz-radio).
5. **Publish** the decks, videos and podcasts that anonymous visitors should see. Everything is **unpublished by default**.

### 6.2 Public live demo (optional, off by default)

`azd env set PUBLIC_DEMO_ENABLED true`, tune the `DEMO_*` caps, then `azd provision`.
Then, as an admin, publish a deck and switch **Live demo on** for it.
Read the cost ceiling and threat model in [live-demo.md](live-demo.md) first.
To switch it off: `azd env set PUBLIC_DEMO_ENABLED false` and `azd provision`.
Voice Q&A for demo visitors is a separate opt-in ([§6.3](#63-voice-qa-in-the-public-demo-demo_qa_enabled)).
The AI enablement demo cut (`content/ai-enablement/ai-enablement-demo-beginner.pptx`) is sized for the default 180-second session.

### 6.3 Voice Q&A in the public demo (`DEMO_QA_ENABLED`)

**Raise-hand Q&A** lets the audience ask a spoken question about the deck being presented. The browser records
the question (≤ 15 s) and streams it to the backend. The backend transcribes it once with Speech and answers
**only from the deck** with `gpt-4.1`. The avatar speaks the answer, then the deck resumes. Audio and transcripts
are never logged or sent to Voice Live. In the public demo visitors can also type a question (≤ 500 characters); it takes the same deck-only answer path and counts against the same limits. Details: [live-demo.md › Raise-hand Q&A](live-demo.md#raise-hand-qa).

- **Signed-in admins** always have it when the avatar presents a deck (Live, a deck's present page, playlists; `/ws/voice` with a deck bound). No flag.
  Each question uses one unit of `DAILY_GENERATION_QUOTA`, up to 10 per session.
- **Anonymous public demo:** **off by default**. It works only when **both** `PUBLIC_DEMO_ENABLED=true` and
  `DEMO_QA_ENABLED=true`.

| Variable | Default | Effect |
|---|---|---|
| `DEMO_QA_ENABLED` | `false` | Turns demo Q&A on |
| `DEMO_QA_MAX_QUESTIONS` | `2` | Questions per demo session. Each started question counts, even if cancelled |
| `DEMO_QA_SESSION_SECONDS` | `300` | Demo session cap while Q&A is on. **Replaces** `DEMO_SESSION_SECONDS` (`180`) |
| `DEMO_QA_DAILY_MAX` | `40` | Demo questions per UTC day, all visitors (durable in Cosmos, fails closed) |
| `DEMO_QA_DAILY_PER_IP` | `6` | Demo questions per UTC day per client IP. `DEMO_QUOTA_EXEMPT_IPS` skip it |

These defaults are the same in `infra/main.parameters.json`, `infra/main.bicep` and `demos/backend/security.py`.

**What it costs.** Each question is one Speech short-audio speech-to-text request (≤ 15 s of audio) plus one small
`gpt-4.1` call (≤ ~12k characters of deck in, ≤ 220 tokens out). The spoken invite and answer run on the avatar
session that is already billed. The daily ceiling is `DEMO_QA_DAILY_MAX` questions. Q&A also makes each demo session
longer (300 s instead of 180 s); `DEMO_DAILY_MINUTES` (`60`) still caps total demo avatar minutes per day.
See [live-demo.md › Cost estimate](live-demo.md#cost-estimate).

**Before you enable it:**

- [ ] The whole [§7 smoke test](#7-smoke-test-checklist) passes, **including the admin raise-hand item**.
- [ ] The public demo already works without Q&A ([§6.2](#62-public-live-demo-optional-off-by-default)).
- [ ] The app identity has *Cognitive Services User* on the Speech resource (Bicep assigns it; for an external
      resource see [§2.2](#22-permissions)) and access to the `gpt-4.1` deployment.
- [ ] A budget is configured (`BUDGET_CONTACT_EMAILS`).

**Enable** (the values are Container App env vars set by Bicep, so `azd provision` is required; `azd deploy` alone doesn't apply them):

```bash
azd env set DEMO_QA_ENABLED true
# optional tuning (defaults shown)
azd env set DEMO_QA_MAX_QUESTIONS 2
azd env set DEMO_QA_SESSION_SECONDS 300
azd env set DEMO_QA_DAILY_MAX 40
azd env set DEMO_QA_DAILY_PER_IP 6
azd provision          # new revision with the new env vars; then azd deploy only if the code changed
curl -s <app-url>/api/demo/config   # "qa": {"enabled": true, ...} and "session_seconds": 300
```

**Disable:** `azd env set DEMO_QA_ENABLED false` and `azd provision`. `PUBLIC_DEMO_ENABLED=false` switches off the whole demo,
Q&A included. The backend reads these values on every call, so a new revision takes effect immediately.

### 6.4 Teams (optional)

`.\scripts\package-teams-app.ps1 -Hostname "<app-fqdn>"`, then sideload the zip.
See [teams-integration.md](teams-integration.md).

---

## 7. Smoke-test checklist

Run this in a **real browser** (Edge/Chrome) on the network your users are on.

- [ ] `curl -s <app-url>/api/health` returns `{"status":"ok","service":"oz-radio"}`.
- [ ] `curl -s <app-url>/api/me` (anonymous) returns `"authenticated": false` and `"auth_mode": "easyauth"`.
- [ ] `az containerapp auth show -n <app-name> -g <rg> -o json` shows the platform enabled, `unauthenticatedClientAction: AllowAnonymous` and the Microsoft identity provider with your client ID.
- [ ] Sign in. `/api/me` now shows `"authenticated": true, "is_admin": true`.
- [ ] Optional: a non-allowlisted account gets 403 on admin actions.
- [ ] Upload a sample `.pptx` on **Decks**. The slides render as real images, not placeholders.
- [ ] Open the deck (`/decks/<id>/present`) or **Live** and start the avatar. **Video and audio** both play.
      In `edge://webrtc-internals` the selected candidate pair is `relay`.
- [ ] Narrate **one slide** end to end.
- [ ] **Raise-hand Q&A (admin):** on a deck's present page, start the avatar, click **Raise hand** and allow the microphone.
      After the slide the avatar invites you, you ask a question about the deck by voice, the transcript and a deck-grounded
      answer appear, the avatar speaks the answer, and the **deck resumes** with the next slide.
- [ ] Generate a short **video** (`/video`) **or podcast** (`/podcast`) from a small file. The job completes and plays from the library.
- [ ] In a rendered **podcast** (layout with slides), both avatars are head-and-shoulders tiles **across the top** and the slide
      below keeps its aspect ratio (**not stretched or cropped**; 4:3 slides are pillar-boxed). The listening host stays
      **in full colour and visibly alive** (blinks, slight head motion) while the other speaks.
- [ ] The podcast library shows **Watch** and **Listen** side by side; *Listen* plays the radio version with live captions.
      An *Audio only* render (`/podcast`, format picker) completes in about a minute and appears with *Listen* only.
- [ ] Publish an item. In a private window (anonymous) it's visible and plays. Unpublished items aren't listed.
- [ ] No startup warnings in the logs: no `AUTH_MODE=disabled`, no `ALLOWED_OBJECT_IDS is empty`, no `AUTH_TENANT_ID is not set`, and no `CRITICAL` line `AUTH_MODE=disabled was refused` (it means something set `AUTH_MODE=disabled` on the app; remove it, [§3.1](#31-admin-tests-against-production)):
      ```bash
      az containerapp logs show -n <app-name> -g <rg> --tail 200
      az containerapp logs show -n <app-name> -g <rg> --type system --tail 50
      ```
- [ ] If you configured a budget: `az consumption budget list --resource-group <rg> -o table` shows `budget-<env>`.
- [ ] If you enabled the public demo: in a private window, **Start the live demo** narrates a live-demo deck with live captions and ends by itself, at the latest at `DEMO_SESSION_SECONDS` (`DEMO_QA_SESSION_SECONDS` when demo Q&A is on).
- [ ] If you enabled demo Q&A ([§6.3](#63-voice-qa-in-the-public-demo-demo_qa_enabled)): in the private window, raise a hand,
      ask one spoken question, hear the answer and see the deck resume. After `DEMO_QA_MAX_QUESTIONS` questions, **Raise hand** is disabled.
- [ ] If you configured custom avatars ([§4.1](#41-custom-photo-avatars-optional)): `curl -s <app-url>/api/avatars` lists them with
      thumbnails and no `character` field. With `HIDE_STOCK_AVATARS=true`, no stock avatar is listed.

---

## 8. Local development

1. `cp demos/backend/.env.example demos/backend/.env`. The `.env` file is git-ignored.
2. Point it at your resources. To get the values: `azd env get-values`.
   - Resources deployed by this template have **keys disabled**. Use `AZURE_USE_MANAGED_IDENTITY=true`; `DefaultAzureCredential` falls back to your `az login`.
     Set `AZURE_BLOB_ACCOUNT_NAME` and leave `AZURE_*_KEY` and `AZURE_BLOB_CONNECTION_STRING` empty.
   - Grant **your own** user the data-plane roles the app identity has:
     - On `oai-*`: Cognitive Services OpenAI User.
     - On `ais-*` (or the external resource): Cognitive Services User, Cognitive Services Speech User and Foundry User.
     - On `st*`: Storage Blob Data Contributor.
     - On Cosmos: `az cosmosdb sql role assignment create -a <cosmos> -g <rg> --role-definition-id 00000000-0000-0000-0000-000000000002 --principal-id <your-oid> --scope "/"`.
3. `./run-local.ps1` (Windows). It sets `AUTH_MODE=disabled`, starts the backend on `:8000` and Vite on `:5173`.
   On macOS/Linux, follow [README › Manual Setup](../README.md#manual-setup-macos--linux).
4. `AUTH_MODE=disabled` makes **every caller an admin**. Use it **only on localhost**. Never set it in Azure and never expose a local instance.
   The backend refuses it on Azure Container Apps (when `CONTAINER_APP_NAME` or `CONTAINER_APP_REVISION` is set, which the platform does
   on every replica) and the preprovision hook stops `azd provision` if the azd environment contains it. Locally, and in a plain `docker run`, it works as before.
5. **`.env` wins over the shell.** `demos/backend/config.py` loads `demos/backend/.env` with `override=True`, so a key in that file
   replaces the same variable set in your shell or by `run-local.ps1` (including `AUTH_MODE`). Change values in `.env`, or remove the key from it,
   then restart the backend.
6. Optional feature keys in `demos/backend/.env` (same names and defaults as in Azure, [§4](#4-azd-environment-variables)):

   ```dotenv
   PUBLIC_DEMO_ENABLED=false
   # Raise-hand Q&A in the public demo (admins always have it)
   DEMO_QA_ENABLED=false
   HIDE_STOCK_AVATARS=false
   # Plain JSON here: no backslash escaping (that is only for azd env set)
   CUSTOM_AVATARS_JSON=[{"id":"photo_female","display_name":"Photo avatar (F)","character":"<speech-avatar-character>","gender":"female","thumbnail":"photo_female.png","default":true,"kind":"photo"}]
   ```

   Custom avatars also need the thumbnails in `demos/backend/static/avatars/` and Speech settings (`AZURE_SPEECH_ENDPOINT`,
   `AZURE_SPEECH_REGION`, `AZURE_SPEECH_RESOURCE_ID`) pointing at the resource that hosts them.
7. **Local tools:** without LibreOffice (and Poppler), slides fall back to placeholder images. Video and podcast renders need
   **ffmpeg and ffprobe** on `PATH`. Raise-hand Q&A needs a microphone; browsers allow it on `http://localhost`.

---

## 9. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `azd provision` stops with *refusing to provision without authentication* | Hook: `AUTH_CLIENT_ID`, `AUTH_CLIENT_SECRET` or `ALLOWED_OBJECT_IDS` missing | Do [§3](#3-entra-app-registration-easy-auth). Don't use `ALLOW_INSECURE_NO_AUTH` for a real instance |
| Hook: *refusing to provision: AUTH_MODE=disabled is set in the azd environment* | `AUTH_MODE=disabled` in `.azure/<env>/.env`. The hook reads only the azd environment, not your shell | `azd env set AUTH_MODE easyauth`. For admin tests use bearer tokens ([§3.1](#31-admin-tests-against-production)) |
| Log line `CRITICAL … AUTH_MODE=disabled was refused` | `AUTH_MODE=disabled` was set on the Container App outside Bicep (for example with `az containerapp update --set-env-vars`). The backend ignored it and kept Easy Auth | `azd provision` resets `AUTH_MODE=easyauth`, or remove the variable. Use bearer tokens for admin tests ([§3.1](#31-admin-tests-against-production)) |
| Hook: *expected GUID value(s)* | UPN/e-mail or stray spaces in `ALLOWED_OBJECT_IDS`, `AUTH_CLIENT_ID` or `AUTH_TENANT_ID` | Use object/client/tenant GUIDs |
| `AADSTS50011` redirect URI mismatch | FQDN callback not registered | `az ad app update --web-redirect-uris "<url>/.auth/login/aad/callback"` |
| Sign-in loop or `AADSTS700054` (id_token not enabled) | ID tokens disabled | Enable **ID tokens** on the app registration |
| `AADSTS65001` / *needs admin approval* | Tenant blocks user consent | Ask a tenant admin to grant consent |
| Signed in but **403** on admin actions | Object ID not in `ALLOWED_OBJECT_IDS`, or a tenant mismatch with `AUTH_TENANT_ID` | Check `/api/me`, fix the allowlist, `azd provision` |
| Sign-in fails after months | Client secret expired | Create a new secret, `azd env set AUTH_CLIENT_SECRET …`, `azd provision` |
| `InsufficientQuota` / `DeploymentModelNotSupported` / SKU not available | Region quota or model availability ([§2.4](#24-region), [§2.5](#25-quota)) | Request quota, pick another region, or edit capacity/version in `openai.bicep` |
| *invalid character after object key:value pair* | Unescaped JSON in `EXTRA_TAGS_JSON` / `CUSTOM_AVATARS_JSON` | Escape with `\"` ([§4](#4-azd-environment-variables)) |
| Custom avatars missing from `/api/avatars`, stock avatars still shown | Log `CUSTOM_AVATARS_JSON is not valid JSON` / `Ignoring custom avatar with invalid id/character`; `HIDE_STOCK_AVATARS` is ignored when no custom avatar is valid | Fix the JSON ([§4.1](#41-custom-photo-avatars-optional)) and `azd provision` |
| Custom avatar listed but has no thumbnail | The file wasn't in `demos/backend/static/avatars/` when the image was built (git-ignored folder) | Copy it there and `azd deploy` |
| Custom avatar fails to start or render | `character` doesn't exist in the Speech resource in use | Use the resource that hosts it (`USE_EXTERNAL_AI_SERVICES` + `EXTERNAL_AI_SERVICES_*`) |
| **Raise hand** is disabled / Q&A errors `stt_failed` | Microphone permission denied, missing Speech role for STT, `DEMO_QA_ENABLED` off (demo), or a question limit reached | Allow the mic; check roles ([§1](#1-what-gets-deployed)); check `/api/demo/config` → `qa` ([§6.3](#63-voice-qa-in-the-public-demo-demo_qa_enabled)) |
| `RequestDisallowedByPolicy` | Azure Policy | [§2.6](#26-azure-policy-pitfalls-enterprise--policy-managed-subscriptions) |
| Name conflict on `oai-*` / `ais-*` after a teardown | Soft-deleted Cognitive Services account | `az cognitiveservices account purge …`, or tear down with `azd down --purge` |
| Remote build fails in ACR Tasks | ACR Tasks unavailable for the subscription or offer, or a policy | Check the ACR/Tasks error in the `azd deploy` output. Ask a human; don't disable security settings to get past it |
| **Avatar tile black**, ICE `failed`, audio but no video | The browser can't reach Azure TURN. The SPA forces `iceTransportPolicy: 'relay'` and adds TURN over TCP/TLS 443 next to UDP 3478 | Allow outbound UDP 3478 and TCP 443 to the Azure TURN hosts. Test from another network. **Don't** remove relay-only to make the test pass |
| Avatar WebSocket closes immediately | Origin not same-origin or not in `ALLOWED_ORIGINS`, `MAX_VOICE_SESSIONS` reached, or a missing Foundry User / Speech role | Check the logs. Wait 1–2 min after the first provision for RBAC to propagate |
| 401/403 from OpenAI, Speech, Cosmos or Storage in the logs | Role assignments not propagated yet, or missing on an external resource | Wait, or assign the roles ([§1](#1-what-gets-deployed)) |
| Slides render with wrong fonts or reflow | Font missing in the image. The image ships Liberation, Carlito, Caladea and DejaVu | Embed fonts in the PPTX, or add the font package to the `Dockerfile` |
| Uploads or renders fail with storage 403 on a policy-managed subscription | Storage `publicNetworkAccess` forced to Disabled | [video.md §8](video.md#8-deployment-topology) |
| First request very slow or times out | Scale-to-zero cold start (`MIN_REPLICAS=0`, the default) | Retry: the first request wakes the app (about 30 s). To remove the wait, `azd env set MIN_REPLICAS 1` and `azd provision` (always on, about $47/month at idle rates, [§10](#10-cost-notes-and-teardown)) |

---

## 10. Cost notes and teardown

Main cost drivers (check [Azure pricing](https://azure.microsoft.com/pricing/calculator/) for your region):

| Item | Billing |
|---|---|
| **Real-time avatar and Voice Live** (admin live avatar, public demo) | Per minute of avatar streaming plus Voice Live model/TTS usage. This is the largest risk; keep `MAX_VOICE_SESSION_SECONDS` and the `DEMO_*` caps |
| Raise-hand Q&A | Per question: one Speech speech-to-text request (≤ 15 s audio) plus one small `gpt-4.1` call. Demo questions are capped by `DEMO_QA_*` ([§6.3](#63-voice-qa-in-the-public-demo-demo_qa_enabled)) |
| Batch avatar (video/podcast renders) | Per minute of generated video |
| Azure OpenAI | Per token. Capacity is only a rate limit for GlobalStandard |
| Container Apps | Per vCPU-second and GiB-second while a replica runs (2 vCPU / 4 GiB). `MIN_REPLICAS=0` (the default) scales to zero when idle; `MIN_REPLICAS=1` keeps one replica always on (see below) |
| ACR Basic | Daily fixed fee plus build minutes |
| Cosmos DB serverless, Storage LRS, Log Analytics | Per request unit, per GB stored, per GB ingested (30-day retention) |

**Always-on cost (`MIN_REPLICAS=1`).** The default `MIN_REPLICAS=0` scales to zero, so the first request after an idle period
waits about 30 s for a cold start. `azd env set MIN_REPLICAS 1` and `azd provision` keep one 2 vCPU / 4 GiB replica warm and remove
that wait. At the pay-as-you-go rates of the [Container Apps pricing page](https://azure.microsoft.com/pricing/details/container-apps/)
(check your region), before the monthly free grants:

- **Idle** (no requests, the usual case): (2 vCPU × $0.000003 + 4 GiB × $0.000003) per second × about 2.63 M seconds per month ≈ **$47/month**.
- **Never idle** (the active vCPU rate is $0.000024/s): (2 vCPU × $0.000024 + 4 GiB × $0.000003) per second × 2.63 M seconds ≈ **$158/month**.

The default budget is `BUDGET_AMOUNT=50`: the always-on replica alone is close to it, so raise `BUDGET_AMOUNT` when you use `1`
(the template doesn't change the default for you). Go back with `azd env set MIN_REPLICAS 0` and `azd provision`. The maximum stays
one replica (counters and quotas are in-process), so only `0` and `1` are accepted. Set the value in the azd environment:
`az containerapp update --min-replicas` is overwritten by the next `azd provision`.

Keep `BUDGET_CONTACT_EMAILS` set. The budget alerts; it **doesn't stop** spend.

**Teardown**

```bash
azd down --purge      # deletes rg-<env> (including the budget) and purges soft-deleted Cognitive Services accounts
```

What `azd down` leaves behind:

- [ ] The **Entra app registration** and its secret: `az ad app delete --id <client-id>`.
- [ ] The **external AI Services** resource, if used, and the now-orphaned role assignments on it ("Identity not found"). Remove them.
- [ ] Quota and policy exemptions you requested.
- [ ] The local `.azure/<env>/` folder, which contains the client secret: `azd env` files. Delete it, or keep it outside any shared location.
