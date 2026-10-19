"""Raise-hand voice Q&A over the voice WebSockets (admin ``/ws/voice`` and
public ``/ws/voice/demo``).

* ``qa.*`` / ``context.*`` client messages are handled here and never
  forwarded to Voice Live; the avatar only ever speaks server-generated text
  (fixed invite strings and the grounded answer).
* The public demo also accepts a typed question (``qa.ask_text``): the text is
  a direct input to the grounded-answer model exactly like a speech
  transcript, and is never forwarded to Voice Live.
* Audio frames are strictly validated (base64, sequence, size, rate) and kept
  in memory only until the question is transcribed or discarded.
* Speech-to-text uses the Speech short-audio REST API (AAD → STS token, or a
  key when one is configured). Audio and transcripts are never logged.
"""
from __future__ import annotations

import asyncio
import base64
import binascii
import logging
import re
import struct
import time
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Optional
from urllib.parse import quote

import httpx

from config import AzureConfig
from services import deck_qa
from services import demo_protocol as dp

logger = logging.getLogger(__name__)

SAMPLE_RATE = 16_000
MAX_AUDIO_SECONDS = 15
MAX_AUDIO_MS = MAX_AUDIO_SECONDS * 1000
MAX_AUDIO_BYTES = SAMPLE_RATE * 2 * MAX_AUDIO_SECONDS  # 480000
MAX_FRAME_BYTES = 16_384
MAX_FRAME_B64_CHARS = ((MAX_FRAME_BYTES + 2) // 3) * 4
MAX_FRAMES_PER_SECOND = 40
MAX_TRANSCRIPT_CHARS = 500
MAX_TEXT_QUESTION_CHARS = 500
ADMIN_MAX_QUESTIONS = 10
MIN_DEMO_SECONDS_LEFT = 30
# Listening watchdog: auto-cancel (no_speech) when neither qa.commit / qa.text
# / qa.cancel arrives within max audio + grace after qa.ready, or when frames
# stop for FRAME_IDLE_SECONDS once recording has started.
LISTEN_GRACE_SECONDS = 10.0
FRAME_IDLE_SECONDS = 8.0
STT_TIMEOUT_SECONDS = 10.0
STS_TOKEN_TTL_SECONDS = 9 * 60
SPEECH_SCOPE = "https://cognitiveservices.azure.com/.default"
REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9._:-]{1,64}$")
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
QA_MODES = ("after_slide", "now")

INVITES: dict[str, str] = {
    "en": "Go ahead, I'm listening.",
    "fr": "Allez-y, je vous écoute.",
    "es": "Adelante, le escucho.",
    "de": "Bitte, ich höre zu.",
    "it": "Prego, la ascolto.",
    "pt": "Pode falar, estou ouvindo.",
    "zh": "请说，我在听。",
    "ja": "どうぞ、お聞きしています。",
}

ERROR_MESSAGES: dict[str, str] = {
    "no_speech": "I didn't catch a question. Please try again.",
    "too_long": "That question is too long. Please keep it under 15 seconds.",
    "limit": "No more questions are available for this session.",
    "rate": "Audio was sent too fast. Please try again.",
    "stt_failed": "Sorry, I couldn't process the audio. Please try again.",
    "answer_failed": "Sorry, I couldn't answer that right now.",
    "bad_state": "That request isn't valid right now.",
    "disabled": "Questions are not available.",
    "time_low": "There isn't enough time left in this session for a question.",
    "bad_deck": "That deck isn't available.",
}

STT_LANGUAGES = {
    "en-US", "fr-FR", "es-ES", "de-DE", "ja-JP", "zh-CN", "it-IT", "pt-BR", "ko-KR", "ar-SA",
}


class QaError(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def invite_text(language: Optional[str]) -> str:
    return INVITES.get((language or "en").split("-", 1)[0].lower(), INVITES["en"])


# ---------------------------------------------------------------------------
# PCM helpers / frame validation
# ---------------------------------------------------------------------------
def pcm_to_wav(pcm: bytes, sample_rate: int = SAMPLE_RATE) -> bytes:
    """Wrap raw PCM16 LE mono in a canonical 44-byte WAV header."""
    data_len = len(pcm)
    header = b"RIFF" + struct.pack("<I", 36 + data_len) + b"WAVE"
    header += b"fmt " + struct.pack("<IHHIIHH", 16, 1, 1, sample_rate, sample_rate * 2, 2, 16)
    header += b"data" + struct.pack("<I", data_len)
    return header + pcm


def decode_frame(audio: Any) -> bytes:
    """Strict base64 → PCM16 bytes (non-empty, even, ≤ :data:`MAX_FRAME_BYTES`)."""
    if not isinstance(audio, str) or not audio or len(audio) > MAX_FRAME_B64_CHARS:
        raise QaError("bad_state")
    try:
        raw = base64.b64decode(audio, validate=True)
    except (binascii.Error, ValueError):
        raise QaError("bad_state") from None
    if not raw or len(raw) % 2 or len(raw) > MAX_FRAME_BYTES:
        raise QaError("bad_state")
    return raw


class AudioCollector:
    """Accumulates the frames of one question: strict ``seq`` (0, 1, 2…),
    total ≤ ``max_bytes`` and a token bucket of ``rate`` frames/s (burst =
    ``rate``)."""

    def __init__(self, max_bytes: int = MAX_AUDIO_BYTES, rate: int = MAX_FRAMES_PER_SECOND,
                 clock: Callable[[], float] = time.monotonic) -> None:
        self.max_bytes = max_bytes
        self.rate = rate
        self._clock = clock
        self._tokens = float(rate)
        self._last = clock()
        self.next_seq = 0
        self._chunks: list[bytes] = []
        self.size = 0

    def add(self, seq: Any, audio: Any) -> None:
        now = self._clock()
        self._tokens = min(float(self.rate), self._tokens + (now - self._last) * self.rate)
        self._last = now
        if self._tokens < 1.0:
            raise QaError("rate")
        self._tokens -= 1.0
        if isinstance(seq, bool) or not isinstance(seq, int) or seq != self.next_seq:
            raise QaError("bad_state")
        raw = decode_frame(audio)
        if self.size + len(raw) > self.max_bytes:
            raise QaError("too_long")
        self._chunks.append(raw)
        self.size += len(raw)
        self.next_seq += 1

    def pcm(self) -> bytes:
        return b"".join(self._chunks)

    def clear(self) -> None:
        self._chunks = []
        self.size = 0


# ---------------------------------------------------------------------------
# Speech-to-text (short-audio REST)
# ---------------------------------------------------------------------------
_sts_cache: dict[str, tuple[str, float]] = {}
_credential: Any = None


def _aad_token() -> str:
    global _credential
    if _credential is None:
        from azure.identity import DefaultAzureCredential

        _credential = DefaultAzureCredential()
    return _credential.get_token(SPEECH_SCOPE).token


def reset_token_cache() -> None:
    _sts_cache.clear()


async def _speech_auth_header(cfg: AzureConfig, http: httpx.AsyncClient) -> dict[str, str]:
    if cfg.speech_key and not cfg.use_managed_identity:
        return {"Ocp-Apim-Subscription-Key": cfg.speech_key}
    endpoint = (cfg.speech_endpoint or "").rstrip("/")
    if not endpoint:
        raise QaError("stt_failed")
    cached = _sts_cache.get(endpoint)
    if cached and cached[1] > time.monotonic():
        return {"Authorization": f"Bearer {cached[0]}"}
    aad = await asyncio.to_thread(_aad_token)
    resp = await http.post(
        f"{endpoint}/sts/v1.0/issuetoken",
        headers={"Authorization": f"Bearer {aad}", "Content-Length": "0"},
    )
    if resp.status_code != 200 or not resp.text.strip():
        logger.info("Voice Q&A: STS token request failed (status=%s)", resp.status_code)
        raise QaError("stt_failed")
    token = resp.text.strip()
    _sts_cache[endpoint] = (token, time.monotonic() + STS_TOKEN_TTL_SECONDS)
    return {"Authorization": f"Bearer {token}"}


def stt_url(cfg: AzureConfig, language: str) -> str:
    region = (cfg.speech_region or "").strip() or "swedencentral"
    lang = language if language in STT_LANGUAGES else "en-US"
    return (
        f"https://{quote(region)}.stt.speech.microsoft.com/speech/recognition/conversation/"
        f"cognitiveservices/v1?language={lang}&format=simple"
    )


async def transcribe_pcm(cfg: AzureConfig, pcm_bytes: bytes, language: str,
                         *, transport: Optional[httpx.AsyncBaseTransport] = None) -> str:
    """Transcribe 16 kHz mono PCM16. Returns the recognised text (≤ 500 chars).

    Raises :class:`QaError` ``no_speech`` (NoMatch / silence / empty) or
    ``stt_failed`` (auth, HTTP, timeout, malformed response). 10 s overall
    timeout, no retry."""
    if not pcm_bytes:
        raise QaError("no_speech")
    wav = pcm_to_wav(pcm_bytes)
    try:
        async with asyncio.timeout(STT_TIMEOUT_SECONDS):
            async with httpx.AsyncClient(timeout=STT_TIMEOUT_SECONDS, transport=transport) as http:
                auth = await _speech_auth_header(cfg, http)
                resp = await http.post(
                    stt_url(cfg, language),
                    headers={
                        **auth,
                        "Content-Type": "audio/wav; codecs=audio/pcm; samplerate=16000",
                        "Accept": "application/json",
                    },
                    content=wav,
                )
    except QaError:
        raise
    except (TimeoutError, asyncio.TimeoutError, httpx.TimeoutException):
        logger.info("Voice Q&A: STT timed out")
        raise QaError("stt_failed") from None
    except Exception as e:
        logger.info("Voice Q&A: STT request failed (%s)", type(e).__name__)
        raise QaError("stt_failed") from None
    if resp.status_code == 401:
        _sts_cache.pop((cfg.speech_endpoint or "").rstrip("/"), None)
    if resp.status_code != 200:
        logger.info("Voice Q&A: STT HTTP %s", resp.status_code)
        raise QaError("stt_failed")
    try:
        body = resp.json()
    except ValueError:
        raise QaError("stt_failed") from None
    status = body.get("RecognitionStatus") if isinstance(body, dict) else None
    if status in ("NoMatch", "InitialSilenceTimeout", "BabbleTimeout"):
        raise QaError("no_speech")
    if status != "Success":
        logger.info("Voice Q&A: STT status %s", status)
        raise QaError("stt_failed")
    text = body.get("DisplayText")
    text = text.replace("\u00a0", " ").strip() if isinstance(text, str) else ""
    if not text:
        raise QaError("no_speech")
    return text[:MAX_TRANSCRIPT_CHARS]


# ---------------------------------------------------------------------------
# Session orchestration
# ---------------------------------------------------------------------------
DeckLoader = Callable[[str], Awaitable[Optional[list]]]


@dataclass
class QaOptions:
    """Per-connection Q&A settings decided by the WebSocket endpoint."""

    access: str = "admin"                       # "admin" | "demo"
    enabled: bool = True
    max_questions: int = ADMIN_MAX_QUESTIONS
    slides: Optional[list] = None               # None ⇒ no deck bound
    deck_id: Optional[str] = None
    deck_loader: Optional[DeckLoader] = None    # admin context.switch
    reserve_daily: Optional[Callable[[], Awaitable[Optional[str]]]] = None
    deadline: Optional[float] = None            # demo session end (time.monotonic)
    language: str = "en-US"


class QaSession:
    """State machine for one voice connection: idle → listening (after
    ``qa.ready``) → processing (STT + answer task) → answered → idle.

    The public demo adds a typed question (``qa.ask_text``): a direct path
    idle → processing with no spoken invite and no listening watchdog.
    ``on_terminal`` (demo idle clock) is called after every terminal question
    event: a ``qa.error`` for a valid request id other than ``bad_state``, a
    ``qa.unavailable``, an effective ``qa.cancel`` / ``qa.resume``."""

    def __init__(
        self,
        opts: QaOptions,
        *,
        cfg: AzureConfig,
        send_client: Callable[[dict], Awaitable[None]],
        speak: Callable[..., Awaitable[None]],
        clock: Callable[[], float] = time.monotonic,
        on_terminal: Optional[Callable[[], None]] = None,
    ) -> None:
        self.opts = opts
        self.cfg = cfg
        self._send_client = send_client
        self._speak = speak
        self._clock = clock
        self._on_terminal = on_terminal
        self.slides: Optional[list] = opts.slides if opts.slides else None
        self.deck_id = opts.deck_id
        self.used = 0
        self.state = "idle"
        self.request_id: Optional[str] = None
        self.slide: int = 0
        self.mode = "after_slide"
        self.audio: Optional[AudioCollector] = None
        self._task: Optional[asyncio.Task] = None
        self._watchdog: Optional[asyncio.Task] = None
        self._last_frame_at: Optional[float] = None
        self._reserving = 0
        self._closed = False

    @property
    def is_demo(self) -> bool:
        return self.opts.access == "demo"

    def is_quiet(self) -> bool:
        """True when no question is being listened to, reserved or answered (idle or answered, no task running, no
        daily reservation pending): the demo's idle clock may then close the session."""
        task = self._task
        return self._reserving == 0 and self.state in ("idle", "answered") and (task is None or task.done())

    def can_ask(self) -> bool:
        """True while a question could still be taken: Q&A is on, a deck is bound and the per-session maximum is not
        reached (the demo's ``demo.activity`` only counts then)."""
        return not self._closed and self.opts.enabled and bool(self.slides) and self.used < self.opts.max_questions

    # -- outgoing ---------------------------------------------------------
    def remaining_ms(self) -> Optional[int]:
        if self.opts.deadline is None:
            return None
        return max(0, int((self.opts.deadline - self._clock()) * 1000))

    async def _send(self, msg: dict) -> None:
        if self._closed:
            return
        rem = self.remaining_ms()
        if rem is not None and str(msg.get("type", "")).startswith("qa."):
            msg = {**msg, "remaining_ms": rem}
        await self._send_client(msg)

    def _terminal(self) -> None:
        if self._on_terminal is not None:
            try:
                self._on_terminal()
            except Exception:
                logger.debug("Voice Q&A: terminal hook failed", exc_info=True)

    async def _error(self, request_id: Optional[str], code: str, *,
                     message: Optional[str] = None, scope: Optional[str] = None) -> None:
        logger.info("Voice Q&A: error code=%s access=%s", code, self.opts.access)
        out = {"type": "qa.error", "request_id": request_id, "code": code,
               "message": message or ERROR_MESSAGES.get(code, ERROR_MESSAGES["bad_state"])}
        if scope is not None:
            out["scope"] = scope
        await self._send(out)
        if request_id is not None and code != "bad_state":
            self._terminal()

    async def _limit_error(self, request_id: str, scope: str) -> None:
        """``qa.error`` ``limit``. The demo says which limit refused (``scope`` + its message); the admin
        endpoint keeps its single text."""
        if self.is_demo:
            await self._error(request_id, "limit", scope=scope, message=dp.QA_LIMIT_MESSAGES[scope])
        else:
            await self._error(request_id, "limit")

    async def _reserve_daily(self) -> Optional[str]:
        """Daily question reservation, bounded by ``QA_RESERVE_TIMEOUT_SECONDS``. ``None`` when granted, else the
        refusal scope: ``daily`` (global / per-IP budget used up) or ``unavailable`` (store busy, down or too slow:
        fail closed). A reservation that completes after the timeout may still count against the daily budget."""
        if self.opts.reserve_daily is None:
            return None
        try:
            exhausted = await asyncio.wait_for(self.opts.reserve_daily(), dp.QA_RESERVE_TIMEOUT_SECONDS)
        except Exception:  # includes the timeout; CancelledError is not an Exception
            exhausted = "unavailable"
        if not exhausted:
            return None
        logger.info("Voice Q&A: daily reservation refused (%s)", exhausted)
        return "unavailable" if exhausted in ("busy", "unavailable") else "daily"

    async def _reserve_or_refuse(self, request_id: str) -> bool:
        """Reserve the daily question for ``request_id``. ``True`` when it was granted; otherwise the refusal has been
        sent (``qa.error`` ``limit``, whose terminal event restarts the demo's idle window). The session is not quiet
        for the whole of it — the wait for the reservation and the refusal that may follow — so the idle close can
        never fire between a submitted question and its outcome."""
        self._reserving += 1
        try:
            refused = await self._reserve_daily()
            if refused:
                await self._limit_error(request_id, refused)
                return False
            return True
        finally:
            self._reserving -= 1

    def _reset(self) -> None:
        self._stop_watchdog()
        if self.audio:
            self.audio.clear()
        self.audio = None
        self.state = "idle"
        self.request_id = None

    def _stop_watchdog(self) -> None:
        wd = self._watchdog
        self._watchdog = None
        self._last_frame_at = None
        if wd and not wd.done():
            try:
                current = asyncio.current_task()
            except RuntimeError:
                current = None
            if wd is not current:
                wd.cancel()

    def _start_watchdog(self, rid: str) -> None:
        self._stop_watchdog()
        self._watchdog = asyncio.ensure_future(self._listen_watchdog(rid))

    async def _listen_watchdog(self, rid: str) -> None:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + MAX_AUDIO_MS / 1000 + LISTEN_GRACE_SECONDS
        while True:
            now = loop.time()
            wake = deadline
            if self._last_frame_at is not None:
                wake = min(wake, self._last_frame_at + FRAME_IDLE_SECONDS)
            if now >= wake:
                break
            await asyncio.sleep(min(wake - now, FRAME_IDLE_SECONDS / 4, 1.0))
        if self.state == "listening" and self.request_id == rid and not self._closed:
            logger.info("Voice Q&A: listening timed out")
            self._reset()
            await self._error(rid, "no_speech")

    # -- incoming ---------------------------------------------------------
    async def handle(self, msg: dict) -> None:
        mtype = msg.get("type")
        if mtype == "context.switch":
            await self._context_switch(msg)
            return
        rid = msg.get("request_id")
        if not isinstance(rid, str) or not REQUEST_ID_RE.fullmatch(rid):
            await self._error(None, "bad_state")
            return
        if mtype == "qa.begin":
            await self._begin(rid, msg)
        elif mtype == "qa.audio":
            await self._audio(rid, msg)
        elif mtype == "qa.commit":
            await self._commit(rid)
        elif mtype == "qa.text":
            await self._text(rid, msg)
        elif mtype == dp.MSG_QA_ASK_TEXT and self.is_demo:
            await self._ask_text(rid, msg)
        elif mtype == "qa.cancel":
            await self._cancel(rid)
        elif mtype == "qa.resume":
            await self._resume(rid)
        else:
            await self._error(rid, "bad_state")

    async def _begin(self, rid: str, msg: dict) -> None:
        if not self.opts.enabled:
            await self._error(rid, "disabled")
            return
        if not self.slides:
            await self._send({"type": "qa.unavailable", "reason": "no_deck"})
            self._terminal()
            return
        mode = msg.get("mode", "after_slide")
        if mode not in QA_MODES or (mode == "now" and self.is_demo):
            await self._error(rid, "bad_state")
            return
        slide = msg.get("slide")
        if isinstance(slide, bool) or not isinstance(slide, int) or not 0 <= slide < 10_000:
            await self._error(rid, "bad_state")
            return
        if self.state == "answered":
            self._reset()  # implicit resume
        if self.state != "idle":
            await self._error(rid, "bad_state")
            return
        rem = self.remaining_ms()
        if self.is_demo and rem is not None and rem < MIN_DEMO_SECONDS_LEFT * 1000:
            await self._error(rid, "time_low")
            return
        if self.used >= self.opts.max_questions:
            await self._limit_error(rid, "session")
            return
        if not await self._reserve_or_refuse(rid):
            return
        if self._closed:
            return
        self.used += 1
        self.request_id, self.slide, self.mode = rid, slide, mode
        self.audio = AudioCollector(clock=self._clock)
        self.state = "listening"
        self._start_watchdog(rid)
        logger.info("Voice Q&A: question reserved (access=%s used=%d/%d)",
                    self.opts.access, self.used, self.opts.max_questions)
        await self._send({
            "type": "qa.ready",
            "request_id": rid,
            "max_audio_ms": MAX_AUDIO_MS,
            "max_audio_bytes": MAX_AUDIO_BYTES,
            "remaining_questions": max(0, self.opts.max_questions - self.used),
        })
        await self._speak(invite_text(self.opts.language), kind="invite")

    async def _ask_text(self, rid: str, msg: dict) -> None:
        """Typed question of the public demo (contracts §4.4): no spoken invite, no listening watchdog.

        Order of checks: enabled / deck, slide, state, text (string, empty, length), time left, per-session
        maximum, daily reservation. Invalid input never costs a question. After the reservation the question is
        counted, ``qa.accepted`` is sent, and only then does the answer task (``qa.transcript`` → model →
        ``qa.answer``) start."""
        if not self.opts.enabled:
            await self._error(rid, "disabled")
            return
        if not self.slides:
            await self._send({"type": "qa.unavailable", "reason": "no_deck"})
            self._terminal()
            return
        slide = msg.get("slide")
        if isinstance(slide, bool) or not isinstance(slide, int) or not 0 <= slide < 10_000:
            await self._error(rid, "bad_state")
            return
        if self.state == "answered":
            self._reset()  # implicit resume
        if self.state != "idle":
            await self._error(rid, "bad_state")
            return
        text = msg.get("text")
        if not isinstance(text, str):
            await self._error(rid, "bad_state")
            return
        text = text.strip()
        if not text:
            await self._error(rid, "no_speech")
            return
        if len(text) > MAX_TEXT_QUESTION_CHARS:
            await self._error(rid, "too_long", message=dp.TEXT_TOO_LONG_MESSAGE)
            return
        rem = self.remaining_ms()
        if rem is not None and rem < MIN_DEMO_SECONDS_LEFT * 1000:
            await self._error(rid, "time_low")
            return
        if self.used >= self.opts.max_questions:
            await self._limit_error(rid, "session")
            return
        if not await self._reserve_or_refuse(rid):
            return
        if self._closed:
            return
        self.used += 1
        self.request_id, self.slide, self.mode = rid, slide, "after_slide"
        self.state = "processing"
        logger.info("Voice Q&A: typed question accepted (used=%d/%d)", self.used, self.opts.max_questions)
        await self._send({
            "type": "qa.accepted",
            "request_id": rid,
            "remaining_questions": max(0, self.opts.max_questions - self.used),
        })
        self._start(rid, text=text)

    async def _audio(self, rid: str, msg: dict) -> None:
        if self.state != "listening" or rid != self.request_id or self.audio is None:
            await self._error(rid, "bad_state")
            return
        try:
            self.audio.add(msg.get("seq"), msg.get("audio"))
            self._last_frame_at = asyncio.get_running_loop().time()
        except QaError as e:
            self._reset()
            await self._error(rid, e.code)

    async def _commit(self, rid: str) -> None:
        if self.state != "listening" or rid != self.request_id or self.audio is None:
            await self._error(rid, "bad_state")
            return
        pcm = self.audio.pcm()
        self.audio.clear()
        if not pcm:
            self._reset()
            await self._error(rid, "no_speech")
            return
        self._start(rid, pcm=pcm)

    async def _text(self, rid: str, msg: dict) -> None:
        if self.is_demo or self.state != "listening" or rid != self.request_id:
            await self._error(rid, "bad_state")
            return
        text = msg.get("text")
        if not isinstance(text, str):
            await self._error(rid, "bad_state")
            return
        text = text.strip()
        if len(text) > MAX_TEXT_QUESTION_CHARS:
            self._reset()
            await self._error(rid, "too_long")
            return
        if not text:
            self._reset()
            await self._error(rid, "no_speech")
            return
        if self.audio:
            self.audio.clear()
        self._start(rid, text=text)

    def _start(self, rid: str, *, pcm: Optional[bytes] = None, text: Optional[str] = None) -> None:
        self._stop_watchdog()
        self.state = "processing"
        self._task = asyncio.ensure_future(self._process(rid, pcm, text, self.slides or [], self.slide))

    async def _process(self, rid: str, pcm: Optional[bytes], text: Optional[str], slides: list, slide: int) -> None:
        stage = "stt_failed"
        try:
            if text is None:
                text = await transcribe_pcm(self.cfg, pcm or b"", self.opts.language)
                pcm = None
            if self.request_id != rid:
                return
            await self._send({"type": "qa.transcript", "request_id": rid, "text": text})
            stage = "answer_failed"
            result = await deck_qa.answer_deck_question(
                slides, slide, text, self.opts.language, self.opts.access, cfg=self.cfg,
            )
            if self.request_id != rid or self._closed:
                return
            self.state = "answered"
            await self._send({
                "type": "qa.answer",
                "request_id": rid,
                "text": result["answer"],
                "source_slides": list(result["source_slides"]),
                "grounded": bool(result["grounded"]),
            })
            await self._speak(result["answer"], kind="answer")
        except asyncio.CancelledError:
            raise
        except (QaError, deck_qa.DeckQaError) as e:
            if self.request_id == rid:
                self._reset()
                await self._error(rid, e.code)
        except Exception as e:
            logger.info("Voice Q&A: processing failed (%s)", type(e).__name__)
            if self.request_id == rid:
                self._reset()
                await self._error(rid, stage)

    async def _cancel(self, rid: str) -> None:
        if rid != self.request_id:
            return
        self._cancel_task()
        self._reset()
        self._terminal()

    async def _resume(self, rid: str) -> None:
        if rid != self.request_id or self.state != "answered":
            return
        self._reset()
        self._terminal()

    async def _context_switch(self, msg: dict) -> None:
        deck_id = msg.get("deck_id")
        if self.is_demo or self.opts.deck_loader is None:
            return
        slides = None
        if isinstance(deck_id, str) and UUID_RE.fullmatch(deck_id):
            try:
                slides = await self.opts.deck_loader(deck_id)
            except Exception:
                slides = None
        if not slides:
            await self._error(None, "bad_deck")
            return
        self.slides, self.deck_id = slides, deck_id
        await self._send({"type": "context.switched", "deck_id": deck_id, "slide_count": len(slides)})

    def _cancel_task(self) -> None:
        if self._task and not self._task.done():
            self._task.cancel()
        self._task = None

    def close(self) -> None:
        """Disconnect / expiry: cancel in-flight STT/LLM work, discard audio."""
        self._closed = True
        self._cancel_task()
        self._reset()
