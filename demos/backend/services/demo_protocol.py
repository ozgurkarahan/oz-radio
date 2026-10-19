"""Shared contract constants of the UX-fix run (contracts v1.2): demo WebSocket protocol v2, close codes,
boot block and the public library API.

FROZEN shared contract file (owner WU-F0). Constants only — no behaviour, no imports. Do not edit: ask the
coordinator, who records the change in fleet/contracts.md.

Mirrors demos/frontend/src/services/demoProtocol.ts, boot.ts and ui/format.ts — keep them in sync.
tests/ux-fixtures.spec.ts compares the close codes, reasons, timings, message type names and boot constants of the
two sides and fails when they drift.

Who imports what:
    WU-G  every demo and boot constant (``from services import demo_protocol as dp``).
    WU-F  the public library section at the bottom.
"""
from __future__ import annotations

# ---------------------------------------------------------------------------------------------------------
# Demo WebSocket protocol v2 (/ws/voice/demo)
# ---------------------------------------------------------------------------------------------------------
PROTOCOL_VERSION = 2
WS_PATH = "/ws/voice/demo"

# Busy-based idle close (contracts §4.5). After demo.narration_complete the server closes with CLOSE_IDLE when ALL
# hold: no avatar response is in flight (every response.created has had its response.done, any status), the QA
# session is idle or answered, and now >= idle_deadline. The deadline only moves later: each later completed turn
# -> anchor(turn) + AUDIO_TAIL_GRACE_SECONDS + IDLE_CLOSE_SECONDS; each terminal QA event (qa.error, qa.unavailable,
# qa.cancel, qa.resume) -> now + IDLE_CLOSE_SECONDS. Rejected or dropped client messages never move it.
IDLE_CLOSE_SECONDS = 30
# Safety margin added after the estimated end of the avatar's audio before the idle window starts.
AUDIO_TAIL_GRACE_SECONDS = 10
# The idle deadline is evaluated at least this often.
IDLE_CHECK_INTERVAL_SECONDS = 1
# Estimate of response.created -> first audible sample (measured 1.0-1.4 s, 2026-10-18 trial).
FIRST_AUDIO_LATENCY_SECONDS = 1.5
# Fallback narration speed when no word timestamps arrived (same default as NarrationRate on the client).
NARRATION_CHARS_PER_SECOND = 13
# Longest typed question (characters, after strip). Equals voice_questions.MAX_TEXT_QUESTION_CHARS.
MAX_TEXT_QUESTION_CHARS = 500
# The daily question reservation (reserve_daily) is bounded by this many seconds; on timeout the question is refused
# qa.error {code: "limit", scope: "unavailable"} and is not counted for the session.
QA_RESERVE_TIMEOUT_SECONDS = 3
# Largest client frame the demo accepts. Equals voice_proxy.DEMO_MAX_CLIENT_MESSAGE_BYTES.
MAX_CLIENT_MESSAGE_BYTES = 32 * 1024
# Seconds before the session cap at which the client announces the countdown (client-side only).
WARN_AT_SECONDS = (60, 20)
# Sent as qa.error.message for code "too_long" on the typed path (the voice message says "15 seconds").
TEXT_TOO_LONG_MESSAGE = "That question is too long. Please keep it under 500 characters."
# Detail line the client shows for the "outage" outcome when the avatar service reported an error before the close.
SERVICE_ERROR_DETAIL = "The live avatar service isn't responding."

# Close codes. Post-accept unless noted: browsers only read the code of a socket that was accepted.
CLOSE_NORMAL = 1000          # bare close (Azure ended the session); the client refines it
CLOSE_GOING_AWAY = 1001      # infrastructure (browser or proxy going away)
CLOSE_NO_STATUS = 1005       # browser: close frame without a status code
CLOSE_ABNORMAL = 1006        # browser: no close frame (pre-accept refusals, proxies, VPNs, drops); never sent
CLOSE_SESSION_ERROR = 1011   # session error (also Azure unreachable); pre-accept: "Service not configured"
CLOSE_RESTART = 1012         # service restart (revision switch), sent by the ASGI server on shutdown
CLOSE_BUSY = 1013            # DEMO_SESSIONS at capacity (the only use of 1013 from now on)
CLOSE_FINISHED = 4001        # the client sent demo.finish
CLOSE_IDLE = 4002            # idle after the narration was complete
CLOSE_REFUSED = 4403         # PRE-accept refusal (kill switch, deck, Origin): browsers see 1006
CLOSE_TIME_CAP = 4408        # session cap
CLOSE_DAILY_QUOTA = 4429     # daily budget (global sessions, minutes or per-IP)
CLOSE_STORE_OUTAGE = 4503    # the quota store is unavailable or contended (fail closed)
# 4000 is used by the evidence guard of the UX-evidence run: never use it.
RESERVED_CLOSE_CODES = (4000,)

# reason strings of the close frames the application sends (ASCII, well under the 123-byte limit)
CLOSE_REASONS = {
    1011: "Demo session error",
    1013: "The demo avatar is busy, try again in a minute",
    4001: "Demo finished",
    4002: "Demo idle timeout",
    4403: "Demo not available",
    4408: "Demo time limit reached",
    4429: "Daily demo limit reached, come back tomorrow",
    4503: "Live demo temporarily unavailable",
}

# DemoQuota.try_consume() refusal -> close code. "busy" (optimistic-concurrency retries exhausted) and
# "unavailable" (store exception) are store problems, not "another visitor": both close with CLOSE_STORE_OUTAGE.
QUOTA_REFUSAL_TO_CLOSE = {
    "global": CLOSE_DAILY_QUOTA,
    "minutes": CLOSE_DAILY_QUOTA,
    "ip": CLOSE_DAILY_QUOTA,
    "busy": CLOSE_STORE_OUTAGE,
    "unavailable": CLOSE_STORE_OUTAGE,
}

# Application message types (client -> server)
MSG_AVATAR_CONNECT = "session.avatar.connect"
MSG_SPEAK = "demo.speak"
MSG_FINISH = "demo.finish"
MSG_RESPONSE_CANCEL = "response.cancel"
MSG_QA_BEGIN = "qa.begin"
MSG_QA_AUDIO = "qa.audio"
MSG_QA_COMMIT = "qa.commit"
MSG_QA_CANCEL = "qa.cancel"
MSG_QA_RESUME = "qa.resume"
MSG_QA_ASK_TEXT = "qa.ask_text"
# Application message types (server -> client)
MSG_PROXY_CONNECTED = "proxy.connected"
MSG_STARTED = "demo.started"
MSG_SPEAKING = "demo.speaking"
MSG_NOTICE = "demo.notice"
MSG_CAPTION = "demo.caption"
MSG_NARRATION_COMPLETE = "demo.narration_complete"
MSG_QA_READY = "qa.ready"
MSG_QA_ACCEPTED = "qa.accepted"
MSG_QA_TRANSCRIPT = "qa.transcript"
MSG_QA_ANSWER = "qa.answer"
MSG_QA_ERROR = "qa.error"
MSG_QA_UNAVAILABLE = "qa.unavailable"
MSG_ERROR = "error"

# Azure Voice Live events the server reads to build captions and detect the end of the narration
AZURE_RESPONSE_CREATED = "response.created"
AZURE_OUTPUT_ITEM_ADDED = "response.output_item.added"
AZURE_TRANSCRIPT_DELTA = "response.audio_transcript.delta"
AZURE_TRANSCRIPT_DONE = "response.audio_transcript.done"
AZURE_TIMESTAMP_DELTA = "response.audio_timestamp.delta"
AZURE_TIMESTAMP_DONE = "response.audio_timestamp.done"
AZURE_RESPONSE_DONE = "response.done"
AZURE_SESSION_UPDATED = "session.updated"
AZURE_AVATAR_CONNECTING = "session.avatar.connecting"

# demo.caption.kind
CAPTION_KINDS = ("narration", "answer", "invite")

# qa.error.code values (voice_questions.ERROR_MESSAGES keys) and the optional scope of code "limit"
QA_ERROR_CODES = (
    "no_speech", "too_long", "limit", "rate", "stt_failed", "answer_failed",
    "bad_state", "disabled", "time_low", "bad_deck",
)
# qa.error {code: "limit", scope, message}: which limit refused the question. "session" = the per-session maximum,
# "daily" = the daily question budget is used up (global or per IP), "unavailable" = the quota store failed (fail closed).
# The server sends the matching message; a client may fall back to the same text.
QA_LIMIT_MESSAGES = {
    "session": "No more questions are available for this session.",
    "daily": "Today's question allowance for the live demo has been reached.",
    "unavailable": "Questions are temporarily unavailable. Please try again in a moment.",
}
QA_LIMIT_SCOPES = tuple(QA_LIMIT_MESSAGES)

# ---------------------------------------------------------------------------------------------------------
# Boot block (index.html)
# ---------------------------------------------------------------------------------------------------------
BOOT_VERSION = 1
BOOT_ELEMENT_ID = "oz-boot"
# Placeholder in index.html that the server replaces with the <script type="application/json" id="oz-boot"> element.
BOOT_MARKER = "<!--OZ_BOOT-->"
# In-memory cache: fresh for 10 s, served stale (while a single background refresh runs) up to 60 s.
BOOT_TTL_SECONDS = 10
BOOT_STALE_MAX_SECONDS = 60
# On a cold cache wait at most this long for the first refresh, then serve BOOT_FAIL_CLOSED (ok=false).
BOOT_COLD_WAIT_SECONDS = 0.15
BOOT_MAX_LIVE_DECKS = 20
# What the server sends when it has no fresh data. Read-only: copy before changing.
BOOT_FAIL_CLOSED = {
    "v": BOOT_VERSION,
    "ok": False,
    "demo": {
        "enabled": False,
        "session_seconds": 180,
        "qa": {"enabled": False, "max_questions": 0},
        "remaining_today": None,
    },
    "live_demo_decks": [],
    "telemetry": {"enabled": False},
}

# ---------------------------------------------------------------------------------------------------------
# Public library API (WU-F)
# ---------------------------------------------------------------------------------------------------------
# detail of every public 503 caused by a storage failure (lists, details, captions) — never an empty list.
LIBRARY_UNAVAILABLE_DETAIL = "Library temporarily unavailable"
# Longest PublicSlidePayload.text (characters, ellipsis included).
PUBLIC_SLIDE_TEXT_MAX_CHARS = 600
# GET /api/{video,podcast}/library/{job_id}/captions.vtt
CAPTIONS_VTT_MEDIA_TYPE = "text/vtt; charset=utf-8"
CAPTIONS_VTT_CACHE_CONTROL = "public, max-age=600"
CAPTIONS_VTT_MAX_SOURCE_BYTES = 512 * 1024
# Public thumbnail / cover SAS: start = bucket_start - SKEW, expiry = bucket_start + WINDOW, bucket = floor(now, BUCKET).
SAS_BUCKET_MINUTES = 10
SAS_WINDOW_MINUTES = 20
SAS_SKEW_MINUTES = 5
