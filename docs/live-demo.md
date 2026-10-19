# Public live avatar demo

Oz Radio's live avatar (Azure Voice Live + real-time WebRTC avatar) is normally
**admin-only** (`/ws/voice`): an earlier deployment that let anonymous visitors
stream Voice Live ran up a runaway bill. The *public live demo* lets anonymous
visitors run the avatar on **a deck an admin has already chosen**: one tap presents
the whole deck with live captions, and, when demo Q&A is on, visitors can ask
questions about it. It sits behind hard, server-side cost and abuse guardrails,
and it is **off by default**.

## How it works

1. An admin publishes a deck and switches **Live demo on** for it on the
   Decks page (`POST /api/decks/{deck_id}/live-demo {"enabled": true}`).
   Only published decks can be live demos; unpublishing a deck switches the
   live demo off.
2. The SPA reads its first-paint facts from the **boot block**: the backend
   serves `index.html` with a `<script type="application/json" id="oz-boot">`
   in place of the `<!--OZ_BOOT-->` marker (`demo.enabled`, `session_seconds`,
   `qa`, `remaining_today` and the live-demo decks, at most 20). Home therefore
   renders its final call to action on the first paint. The same facts come from
   `GET /api/demo/config` (anonymous) →
   `{"enabled": bool, "session_seconds": int, "remaining_today"?: int, "qa": {"enabled": bool, "max_questions": int, "max_audio_seconds": int}}`
   (`session_seconds` is the effective cap: `DEMO_QA_SESSION_SECONDS` when demo
   Q&A is on, else `DEMO_SESSION_SECONDS`), which a page without the boot block uses.
3. Where the demo can run, the visitor sees **Start the live demo** on Home,
   Decks and the deck page. It opens `/decks/<deck_id>/present` for the
   live-demo deck of the visitor's first browser language that has one (else the
   English deck, else the first one). When the demo is off, has no live-demo deck or today's allowance is spent, the
   same place offers **Watch a recorded demo** (`/video/library`) instead, and
   Home shows "N live sessions left today" beside the button. Visitors sign in
   only through the **Owner sign-in** text link; owner tools are marked
   *Sign-in required*.
4. The browser opens `wss://<host>/ws/voice/demo?deck_id=<uuid>` and negotiates
   WebRTC exactly like the admin flow, with relay-only ICE. **One tap on
   Start the live demo** connects and presents every slide in order (two taps
   from Home). Visitors have no per-slide controls (admins keep **Present all**
   and the per-slide controls); **Stop** ends the session at any time. After the
   last slide, **Ask a question** (while questions are left) and **Finish demo**
   appear next to the time left. There is no avatar, voice or language picker and
   no upload. When `DEMO_QA_ENABLED=true` the visitor can also **raise a hand** and
   ask a spoken question, or type one in the same panel (see
   [Raise-hand Q&A](#raise-hand-qa)); otherwise there is no microphone at all.

### Message flow

```
Browser                         Oz Radio backend                       Azure Voice Live
  | WS /ws/voice/demo?deck_id=…   |                                        |
  |------------------------------>| kill switch, UUID, Origin, deck        |
  |                               | published+live_demo  (else 4403,       |
  |                               | before accept)                         |
  |                               | slot taken (1013), daily or per-IP     |
  |                               | (4429), quota store down (4503)        |
  |<----------- accept -----------|                                        |
  |<-- demo.started {session_seconds, remaining_ms, narration_chars[],     |
  |     protocol: 2, slide_count, idle_close_seconds}                      |
  |                               |--- connect (managed identity) -------->|
  |<-- proxy.connected -----------|--- session.update (server-side only) ->|
  |<-- session.updated (ICE) -----|<---------------------------------------|
  |-- session.avatar.connect ---->|  (SDP offer, ≤20 KB, once) ----------->|
  |<-- server SDP answer ---------|<---------------------------------------|
  |== WebRTC avatar video/audio (browser ⇄ Azure) =========================|
  |-- {"type":"demo.speak",       |  look up stored notes (→ body → title),|
  |    "slide":n} --------------->|  truncate to 2,000 chars, then send:   |
  |                               |--- conversation.item.create ---------->|
  |                               |--- response.create ------------------->|
  |<-- demo.speaking {chars,      |                                        |
  |     remaining, remaining_ms} -|                                        |
  |<-- response.* events ---------|<---------------------------------------|
  |-- response.cancel ----------->|--------------------------------------->|
  |<-- demo.caption (v2) ---------| the avatar's words, paced to its audio |
  |<-- demo.narration_complete ---| once, after the last slide (v2)        |
  |-- qa.ask_text {request_id,    | typed question (v2): no invite, no mic,|
  |    slide, text} ------------->| answered from the deck, as a spoken one|
  |   (anything else: dropped)    |                                        |
  |-- demo.finish (v2) ---------->|--- close the Azure socket ------------->|
  |<-- close 4001 (the visitor finished)                                   |
  |<-- close 4002 (idle after the narration) ------------------------------|
  |<-- close 4408 at the session cap; Azure socket closed too -------------|
```

The narration messages are exactly what the admin frontend sends for a slide
(`"Please say the following exactly as written: <text>"` as a user
`input_text` item, then `response.create`), so lip-sync and timing behave the
same.

### Message catalogue (protocol v2)

Protocol v2 is additive: a `demo.started` without `protocol` is a v1 server, which
has no captions, no typed questions and no `demo.finish` (the client then ends the
session itself with `1000`).

**Client → server.** A strict allow-list (`DemoMessageFilter`): anything else is
dropped silently. A frame is at most 32 KiB.

| Message | Fields | Notes |
|---|---|---|
| `session.avatar.connect` | `client_sdp` (base64, ≤ 20 KiB) | once; forwarded to Azure |
| `demo.speak` | `slide` (int), optional `request_id` | the stored narration of that slide; at least 1 s between speaks; at most `min(40, 2 × slides)` (`speak_limit`); a slide without text → `empty_slide` |
| `demo.finish` (v2) | — | the server closes with `4001` at once, even while the avatar is still being set up |
| `response.cancel` | — | forwarded to Azure |
| `qa.begin`, `qa.audio`, `qa.commit`, `qa.cancel`, `qa.resume` | as in [Raise-hand Q&A](#raise-hand-qa) | voice questions, handled by the backend, never forwarded |
| `qa.ask_text` (v2) | `request_id`, `slide` (int), `text` (≤ 500 characters) | a typed question, never forwarded |

**Server → client.** The raw Azure events the demo relies on
(`response.created`, `response.output_item.added`,
`response.audio_transcript.delta|done`, `response.audio_timestamp.delta|done`,
`response.done`) are forwarded untouched next to these.

| Message | Fields | Notes |
|---|---|---|
| `demo.started` | `session_seconds`, `remaining_ms`, `narration_chars[]`; v2: `protocol: 2`, `slide_count`, `idle_close_seconds` (30) | first message after accept |
| `proxy.connected` | `message` | the Azure socket is up |
| `demo.speaking` | `slide`, `chars`, `remaining`, `remaining_ms`, `request_id?` | acknowledges an accepted `demo.speak` |
| `demo.notice` | `code` (`rate_limited`, `speak_limit`, `empty_slide`), `message`, `slide?`, `request_id?` | |
| `demo.caption` (v2) | `slide` (int or null), `kind` (`narration`, `answer` or `invite`), `response_id`, `text`, `final` | what the avatar says, from its transcript; the `final: true` text replaces the deltas |
| `demo.narration_complete` (v2) | `slides_spoken`, `slide_count`, `remaining_ms`, `idle_close_ms` | once per session, when the last slide's narration has completed |
| `qa.ready` | `request_id`, `max_audio_ms`, `max_audio_bytes`, `remaining_questions`, `remaining_ms` | voice questions only |
| `qa.accepted` (v2) | `request_id`, `remaining_questions`, `remaining_ms` | the answer to `qa.ask_text`, sent before any model call |
| `qa.transcript` | `request_id`, `text`, `remaining_ms` | the heard or typed question, trimmed |
| `qa.answer` | `request_id`, `text`, `source_slides`, `grounded`, `remaining_ms` | the avatar then speaks it |
| `qa.error` | `request_id` or `null`, `code`, `message`, `remaining_ms`, `scope` (for `limit`) | codes: `no_speech`, `too_long`, `limit`, `rate`, `stt_failed`, `answer_failed`, `bad_state`, `disabled`, `time_low`, `bad_deck` |
| `qa.unavailable` | `reason: "no_deck"` | |
| `error` | `error.message` | a generic message; the socket then closes `1011` |

### Visitor experience

- **Start** gives feedback at once ("Starting the avatar…"). The SDP offer leaves
  250 ms after the first TCP/TLS relay candidate, 2 s after the first relay
  candidate of any kind, or 5 s after the start at the latest. The connection is
  relay-only (`iceTransportPolicy: 'relay'`), so a network that blocks UDP can still
  connect. If the avatar service sends no connection details within 15 s of the
  socket opening, the socket is closed (freeing the slot) and the visitor sees
  *Couldn't connect to the live avatar*.
- **Sound** plays through one persistent `<audio>` element that the Start tap
  unlocks. If the browser blocks it (autoplay policy, muted device), the visitor sees
  *Sound is blocked or muted* with **Tap to turn sound on**, and the captions keep
  the narration readable.
- **Captions** are paced to the avatar's audio, not to the arrival of its text. A
  polite live region announces each whole sentence once, and a cancelled turn clears
  its captions.
- **Countdown** warnings come at 60 s and 20 s before the cap, each announced once.
  The server's `remaining_ms` is the truth; a local timer fills the gaps.
- **Phones** get the controls as a fixed bar at the bottom of the screen. The page
  reserves its height so keyboard focus never lands under it.
- **A dropped media link** shows *Reconnecting…* for up to 8 s; after that the
  session is reported as interrupted.
- **Endings** (Finish demo, the time cap, the idle close, a failure) each show
  an outcome card, see [Close codes and outcomes](#close-codes-and-outcomes)
  (**Stop** returns to the start state without a card). The
  primary action is the same deck's recording (`/video/library?video=<job_id>` or
  `/podcast/library?episode=<job_id>&mode=watch|listen`), or the public fallbacks
  *Listen to an episode* and *Watch a video* when there is none.

## Guardrails

| Guardrail | Where | Default |
|---|---|---|
| Kill switch `PUBLIC_DEMO_ENABLED` | every `/ws/voice/demo` handshake + `/api/demo/config` | `false` |
| Deck allowlist: published **and** `live_demo` | before `accept()` → 4403 | admin choice |
| Same-origin `Origin` check (`ALLOWED_ORIGINS` additive) | before `accept()` → 4403 | same-origin |
| Global concurrency `DEMO_MAX_CONCURRENT` (separate from `MAX_VOICE_SESSIONS`, so the owner can still use the admin avatar) | after `accept()` → 1013 | `1` |
| Daily sessions, global `DEMO_DAILY_SESSIONS` | after `accept()` → 4429 | `20` / UTC day |
| Daily sessions per client IP `DEMO_DAILY_SESSIONS_PER_IP` | after `accept()` → 4429 | `3` / UTC day (IPs stored only as salted hashes) |
| Daily streaming minutes `DEMO_DAILY_MINUTES` | after `accept()` → 4429 | `60` min / UTC day (seconds recorded at session end) |
| Hard session timeout `DEMO_SESSION_SECONDS` (`DEMO_QA_SESSION_SECONDS` when demo Q&A is on) | server timer → 4408 | `180` s (`300` s) |
| Idle close after the narration | server clock → 4002 | 30 s after the estimated end of the last slide's audio (plus a 10 s grace); never while an avatar response or a question is in flight |
| Quota store unavailable or contended | after accept() → 4503 | fail closed |
| Narrations per session `DEMO_MAX_SPEAKS` | message filter | 2 × slides, max 40 |
| `demo.speak` rate limit | message filter | ≥ 1 s apart |
| Narration length | server truncation | 2,000 chars |
| Session config 100 % server-side | `build_demo_session_config` | deck language, registry default avatar (or `?avatar=` restricted to the public avatar catalog), allowlisted voice, fixed "read verbatim" instructions, `turn_detection: none`, no input audio, `max_response_output_tokens: 4096` |
| Strict client→server allowlist | `DemoMessageFilter` | SDP offer, `demo.speak`, `demo.finish` (v2), `response.cancel`, plus `qa.begin` (after_slide) / `qa.audio` / `qa.commit` / `qa.cancel` / `qa.resume` and the typed `qa.ask_text` (v2), handled by the backend (never forwarded) |
| Demo Q&A (`DEMO_QA_ENABLED`) | `QaSession` + `DemoQuota` | off; 2 questions/session, 15 s of audio (500 characters when typed), 40/day global, 6/day per IP, ≥ 30 s of session left |
| Azure socket torn down when either side leaves | `handle_demo_proxy` | — |
| Custom avatar character names redacted from server events | `redact_server_message` | — |

Every ending the visitor can see, with its close code and the wording shown, is
listed in [Close codes and outcomes](#close-codes-and-outcomes).

### Implementation notes

- Daily counters are **durable**: one Cosmos DB document per UTC day (`demo-quota-<day>`,
updated with etag optimistic concurrency), so restarts, redeploys and scale-to-zero
cannot reset the budget. If Cosmos is unavailable the demo **fails closed** (4503,
"Live demo temporarily unavailable"; never the "busy" message).
Only the concurrency slot is in-process (the app is capped at one replica).
- **Client IP** for the per-IP quota is the **rightmost** `X-Forwarded-For`
  entry (else the socket peer). Azure Container Apps ingress *appends* the real
  peer to any client-supplied value and documents that only the rightmost IP is
  set by the platform, so left-hand entries are attacker-controlled and
  ignored. If you put another proxy/CDN (Front Door, App Gateway) in front, the
  rightmost entry becomes that proxy's address and the per-IP quota degrades to
  a global one — revisit before doing so. The global daily cap and concurrency
  cap do not depend on the IP.
- **Validating the chain:** set `LOG_FORWARDING_CHAIN=true` on a revision
  (`az containerapp update --set-env-vars`), open a demo WebSocket with an
  invalid `deck_id` (rejected before any session/quota logic), read the
  `Forwarding chain:` log line, then remove the variable. It logs raw IPs, so
  keep it off otherwise. Note that managed corporate devices may reach Azure
  through Microsoft's secure-access edge, so ACA sees rotating Microsoft
  egress IPs rather than the home line — `DEMO_QUOTA_EXEMPT_IPS` only matches
  devices that connect directly (signed-in admins use the admin avatar and
  are never subject to demo quotas).
- A quota unit is consumed when a session is accepted, even if the visitor
  leaves immediately or Azure fails to connect (conservative).

## Close codes and outcomes

The server closes the socket with a code and a reason. The browser maps the code to
one outcome, and the visitor reads the title and detail below, never the raw reason.
Every outcome offers the same deck's recording first, else the public fallbacks. A
busy or failing quota store never reads as "another visitor is using the avatar": it
closes `4503`.

| Code | Sent when | The visitor reads | Retry |
|---|---|---|---|
| `4001` | the visitor pressed **Finish demo** (`demo.finish`) | "Thanks for trying the live demo" | none |
| `4002` | idle after the narration: no avatar response or question in flight, and 30 s after the estimated end of the last slide's audio (plus a 10 s grace) | "Your live session has ended" | none |
| `4408` | the session time cap (`DEMO_SESSION_SECONDS`, or `DEMO_QA_SESSION_SECONDS` with demo Q&A) | "Your live session has ended" | none |
| `1013` | the single demo slot is taken (`DEMO_MAX_CONCURRENT`) | "Another visitor is using the avatar" | "Try again in a minute" |
| `4429` | daily limit: global sessions, streaming minutes or client IP | "Today's live allowance has been reached" | none; Start is disabled with the reason |
| `4503` | the quota store is unavailable or contended (fail closed) | "Live demo temporarily unavailable" | none |
| `1011` | the avatar service failed: an `error` event came first, or Azure is unreachable | "Live demo temporarily unavailable", with "The live avatar service isn't responding." | "Try again" |
| `1012`, `1001` | service restart (a revision switch), or a proxy going away | "Live demo temporarily unavailable" | "Try again" |
| `1000` | Azure ended the session normally | "Your live session has ended" after the session opened; "Couldn't connect to the live avatar" before it did | none after the session opened; "Try again" before |
| `1006`, `1005`, `1015` | no close frame: a refusal before accept (`4403`: kill switch, deck or Origin; `1011` "Service not configured"), a proxy, a VPN or a dropped connection | before it opened: "Couldn't connect to the live avatar", with a network hint; after it opened: "The live connection was interrupted" | "Try again" |

Notes:

- Browsers never see `4403`: a refusal before accept closes as `1006`.
- **Stop** in the middle of a session is a plain close from the client (no status
  code) and returns to the idle state without a card.
- After an ambiguous `1006` the page re-reads `/api/demo/config`. If the demo is
  switched off, the card says so and offers no retry.
- A retry is a new session and uses a daily allowance (there are no refunds).

## Raise-hand Q&A

Optional (`DEMO_QA_ENABLED=true`, default off) for the demo; always available
to signed-in admins on `/ws/voice` when a deck is bound. The visitor raises a
hand, the avatar says a short localized invite ("Go ahead, I'm listening."),
the browser records the question (energy VAD, ≤ 15 s) and streams it to the
backend; the backend transcribes it (Speech short-audio REST, managed identity
→ STS token), answers **only from the deck** (gpt-4.1, JSON mode, whole deck
with the current slide first, ≤ 12k chars, temperature 0.2) and the avatar
speaks the answer. `qa.*` / `context.*` messages are handled by the backend and
are never forwarded to Voice Live; the avatar only ever speaks server-generated
text.

```
Browser                              Oz Radio backend                     Azure
  |-- qa.begin {request_id, slide} ->| enabled? deck? one in flight?      |
  |                                  | ≥30 s left? session + daily quota  |
  |<-- qa.ready {max_audio_ms,       |--- speak(invite) ----------------->| (avatar)
  |    max_audio_bytes,              |                                    |
  |    remaining_questions} ---------|                                    |
  |-- qa.audio {seq, audio(b64)} x N>| strict base64, seq, ≤16 KB/frame,  |
  |-- qa.commit -------------------->| ≤480 KB total, ≤40 frames/s        |
  |                                  |--- STT (10 s timeout) ------------->| (Speech)
  |<-- qa.transcript {text} ---------|--- grounded answer (10 s) -------->| (OpenAI)
  |<-- qa.answer {text,              |--- speak(answer) ----------------->| (avatar)
  |    source_slides, grounded} -----|                                    |
  |-- qa.resume -------------------->| (ack only, no paid call)           |
  |   then demo.speak {next slide} as usual (normal narration budget)     |
```

**Typed questions (protocol v2).** The same panel has a *Type a question* field. A
typed question (`qa.ask_text`, at most 500 characters) skips the invite and the
listening step: the server answers `qa.accepted` before any model call (the daily
reservation behind it waits at most 3 s), echoes the trimmed text
as `qa.transcript`, and then answers from the deck exactly as it does a spoken
question. Invalid input never costs a question, and a failed question keeps its text
in the field so the visitor can send it again. The client waits 5 s for `qa.accepted`
or `qa.error` before it asks the visitor to try again.

- Demo messages accepted: `qa.begin` (`mode` `after_slide` only), `qa.audio`,
  `qa.commit`, `qa.cancel`, `qa.resume`, and the typed `qa.ask_text`. Dropped: `qa.text`,
  `context.switch`, `mode: "now"` and everything listed in the allowlist above.
- Admin extras: `session.update` may carry `session.deck_id` (catalog deck) or
  `session.presentation_id` (Live upload) — the backend loads title/body/notes
  server-side; `context.switch {deck_id}` → `context.switched {deck_id,
  slide_count}` for playlists; typed `qa.text` (≤ 500 chars) and
  `mode: "now"`. Unknown deck → `qa.unavailable {reason: "no_deck"}`.
- Every `qa.*` server message in the demo carries `remaining_ms` (also
  `demo.speaking`), and `demo.started {session_seconds, remaining_ms,
  narration_chars}` is sent at accept so the client can show the session clock
  and estimate how many slides fit (`narration_chars` = length of each slide's
  narration in slide order — counts only, never text).
- Listening timeout: after `qa.ready`, if no `qa.commit` / `qa.text` /
  `qa.cancel` arrives within `max_audio_ms` + 10 s, or frames stop for 8 s
  once recording started, the question is cancelled with
  `qa.error {code: "no_speech"}` (the question stays consumed).
- Admin "Ask now": the client sends `response.cancel` then
  `output_audio_buffer.clear` (forwarded to Voice Live on `/ws/voice` only;
  dropped in the demo).
- Errors: `qa.error {request_id, code, message}` with `code` in `no_speech`,
  `too_long`, `limit`, `rate`, `stt_failed`, `answer_failed`, `bad_state`,
  `disabled`, `time_low` (`bad_deck` for `context.switch`); messages are
  user-safe and never contain upstream text. A `limit` error carries a `scope`:
  `session` (this session's maximum), `daily` (the global or per-IP daily allowance)
  or `unavailable` (the quota store is busy). The visitor sees the matching message.
- Limits: demo 2 questions/session (`DEMO_QA_MAX_QUESTIONS`), 40/day global
  and 6/day per IP (durable, same `demo-quota-<day>` Cosmos doc, fails closed);
  admin 10/session plus one unit of `DAILY_GENERATION_QUOTA` per question.
  A question is reserved when it is asked (`qa.begin` or `qa.ask_text`) and stays
  consumed if it is cancelled. The daily reservation waits at most 3 s
  (`QA_RESERVE_TIMEOUT_SECONDS`); past that the question is refused as `limit` with
  `scope:"unavailable"` and is not counted for the session.
  Answers: demo ≤ 3 sentences / 600 chars, admin ≤ 5 / 900; not covered →
  fixed localized "This isn't covered in this presentation."
- Disconnect or the session cap cancels in-flight STT/LLM work and discards
  the audio. Logs contain counts and codes only (never audio or transcripts).
- The identity needs a Cognitive Services data-plane role (e.g. *Cognitive
  Services User*) on the AI Services resource for STT, and access to the chat
  deployment (`AZURE_OPENAI_CHAT_DEPLOYMENT`).
- Session config also enables `output_audio_timestamp_types: ["word"]`; the
  resulting `response.audio_timestamp.delta` events are forwarded to the
  browser to estimate the audible end of each turn.

## Threat model

| Threat | Mitigation |
|---|---|
| Runaway Voice Live / avatar spend by anonymous users | kill switch off by default; 1 concurrent session; 180 s hard cap; 20 sessions/day; Azure socket closed when the browser leaves; budget alerts (`BUDGET_*`). |
| One visitor monopolising the demo | 3 sessions per IP per day; 1 s narration rate limit; narration cap per session. |
| Prompt injection / free-form use of the LLM ("make the avatar say X") | the client never chooses what the avatar says: `demo.speak` carries only a slide index, and the server reads admin-authored stored notes. With demo Q&A on, a visitor's question (typed `qa.ask_text`, at most 500 characters, or spoken) is the only free text, and it goes to the same deck-only answer path as a spoken question. `session.update`, `conversation.item.create`, `response.create` and audio buffers from the client are dropped. Instructions are fixed server-side. |
| Voice input / eavesdropping | no microphone track (recv-only WebRTC), `turn_detection: none`, no input transcription, Voice Live input-audio messages dropped. With demo Q&A on, question audio goes only to the backend (`qa.audio`, ≤ 15 s), is transcribed once and discarded; it is never logged nor sent to Voice Live. |
| Prompt injection through a question | the question is answered by a separate, tool-less, history-less call that sees the deck and the question as delimited untrusted data and must answer only from the deck (else a fixed "not covered" sentence); the avatar speaks only that server-generated answer (≤ 3 sentences / 600 chars) or a fixed invite string. Typed questions take the same path. `qa.text`, `context.switch` and `mode: "now"` are dropped in the demo. |
| Narrating private content | only decks that are published **and** explicitly marked Live demo; unpublishing clears the flag. Note: a live-demo deck's speaker notes become audible (and appear in the realtime transcript events) to anyone — only enable it on decks whose notes are public. |
| Cross-site WebSocket hijacking | same-origin `Origin` check before `accept()`. |
| Leaking Azure details | error messages to demo clients are generic; custom avatar character names are redacted; credentials never leave the server. |
| IP spoofing via `X-Forwarded-For` | only the platform-appended rightmost entry is trusted; global caps hold regardless. |

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PUBLIC_DEMO_ENABLED` | `false` | Kill switch. |
| `DEMO_MAX_CONCURRENT` | `1` | Concurrent anonymous demo sessions (global). |
| `DEMO_SESSION_SECONDS` | `180` | Hard cap per session. |
| `DEMO_DAILY_SESSIONS` | `20` | Sessions per UTC day, global. `0` blocks all sessions. |
| `DEMO_DAILY_SESSIONS_PER_IP` | `3` | Sessions per UTC day per client IP. |
| `DEMO_DAILY_MINUTES` | `60` | Hard cap on total demo streaming minutes per UTC day (all visitors). |
| `DEMO_MAX_SPEAKS` | `0` | Narrations per session; `0`/unset = 2 × slide count; never above 40. |
| `DEMO_QUOTA_EXEMPT_IPS` | *(empty)* | Comma-separated client IPs/CIDRs (e.g. the owner's home IP) that skip the daily quotas. Matched on the same trusted client IP as the per-IP quota (not spoofable); exempt sessions don't consume the shared budget but still obey `DEMO_MAX_CONCURRENT` and `DEMO_SESSION_SECONDS`. Set it in the azd env, never commit it. |
| `DEMO_QA_ENABLED` | `false` | Raise-hand voice Q&A and typed questions in the demo. |
| `DEMO_QA_MAX_QUESTIONS` | `2` | Questions per demo session (each `qa.begin` or `qa.ask_text` counts, even if cancelled). |
| `DEMO_QA_SESSION_SECONDS` | `300` | Session cap used instead of `DEMO_SESSION_SECONDS` when demo Q&A is on. |
| `DEMO_QA_DAILY_MAX` | `40` | Demo questions per UTC day, global (durable, fails closed). |
| `DEMO_QA_DAILY_PER_IP` | `6` | Demo questions per UTC day per client IP (exempt IPs skip it). |

All are read per call, so a config change (new revision) takes effect
immediately; flipping `PUBLIC_DEMO_ENABLED=false` blocks new sessions at once.

## Cost estimate

Worst-case avatar minutes per day:

```
min(DEMO_DAILY_MINUTES, DEMO_DAILY_SESSIONS × DEMO_SESSION_SECONDS / 60) + one in-flight session
(defaults: min(60, 20 × 180 / 60) = 60 min/day, ≤ 63 min worst case;
 with demo Q&A on the session cap is 300 s: min(60, 20 × 300 / 60) = 60 min/day, ≤ 65 min)
```

Demo Q&A adds at most `DEMO_QA_DAILY_MAX` (40) questions/day, each one
short-audio STT request (≤ 15 s) and one small gpt-4.1 call (≤ ~12k chars of
deck context in, ≤ 220 tokens out), plus the spoken invite/answer on the
already-billed avatar session.

Multiply by your region's real-time avatar + Voice Live (model + TTS) per-minute
price to get a daily ceiling, and × 30 for a monthly ceiling. Concurrency is 1,
so at most one demo avatar is billed at any moment. Narration tokens are small
(≤ 2,000 chars × ≤ 40 narrations per session). Keep the optional Azure budget
(`BUDGET_CONTACT_EMAILS`, `BUDGET_AMOUNT`) enabled as a backstop.

## Enable it

```bash
azd env set PUBLIC_DEMO_ENABLED true
# optional tuning
azd env set DEMO_DAILY_SESSIONS 10
azd env set DEMO_SESSION_SECONDS 120
azd provision            # or: azd up
```

Then, signed in as an admin, open **Decks**, publish a deck and
click **Live demo off** to switch it to **Live demo on**. Anonymous visitors now
see **Start the live demo** on Home, Decks and the deck page (**Watch a recorded
demo** while the demo is off or today's allowance is spent).

To stop everything immediately: `azd env set PUBLIC_DEMO_ENABLED false` and
re-provision (or edit the Container App environment variable in the portal).
