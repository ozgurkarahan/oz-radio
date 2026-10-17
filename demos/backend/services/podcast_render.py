"""Batch avatar synthesis for the podcast: one batch job per dialogue turn.

``run_batch_avatar_job`` is the shared submit/poll helper for talking turns
*and* listener kits:

1. admission: at most ``MAX_ACTIVE_BATCH_JOBS`` (default 8) jobs per process are
   active, from submission until a terminal status;
2. pacing: job creation (PUT) is limited process-wide to
   ``SPEECH_BATCH_CREATE_PER_MIN`` (default 2) per rolling 60 s. Spike S1
   measured the AIServices S0 limit: the 3rd PUT within a minute got 429 with
   ``Retry-After: 55``, while status GETs are not throttled. A 429 still holds
   every creator for the Retry-After period;
3. PUT, then poll (server time is about 9 s + 1 s per video second), then
   download ``outputs.result``.

Deadlines are absolute ``time.monotonic()`` values, checked cooperatively while
waiting for a slot, for the pacer, between retries and between polls. A job that
is still running at the deadline is deleted (best effort) and ``TimeoutError``
is raised; jobs not yet created are never submitted.

Privacy: status payloads echo ``avatarConfig.talkingAvatarCharacter`` (the
Speech character name contains the client name). Raw requests and responses
are never logged or stored. Logs carry the caller's label, the avatar id and
the job id, and error messages are redacted.

History: the original design used one multi-input job per speaker, but the
2024-08-01 multi-input output shape was unstable, so each turn is its own job
and ``render_podcast`` runs them concurrently within the admission limit.
"""

from __future__ import annotations

import logging
import re
import threading
import uuid
from collections import deque
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable, Optional, Union

import requests
from pydantic import BaseModel, Field

from config import AzureConfig
from services import avatar_registry, speech_rest
from services.avatar import (
    VOICE_MAP,
    _get_speech_base_url,
    build_ssml,
)
from services.podcast_models import (
    DialogueTurn,
    RenderRoles,
    RoleConfig,
    Script,
)

log = logging.getLogger(__name__)

API_VERSION = "2024-08-01"
DEFAULT_BATCH_CREATE_PER_MIN = 2
BATCH_CREATE_WINDOW_SEC = 60.0
# Pacing stamps are taken before the PUT is sent; S1 measured PUT round trips of
# 1.4-3.9 s, so keep a small margin over the service's 60 s window.
BATCH_CREATE_MARGIN_SEC = 2.0
DEFAULT_MAX_ACTIVE_BATCH_JOBS = 8
DEFAULT_POLL_TIMEOUT_SEC = 900.0
_CREATE_ATTEMPTS = 6
_POLL_ATTEMPTS = 6
_WAIT_CHUNK_SEC = 1.0
_TERMINAL_STATUSES = frozenset({"Succeeded", "Failed"})


def batch_create_per_min() -> int:
    """``SPEECH_BATCH_CREATE_PER_MIN``: batch job creations per rolling minute (default 2)."""
    return speech_rest.env_int("SPEECH_BATCH_CREATE_PER_MIN", DEFAULT_BATCH_CREATE_PER_MIN, 1, 60)


def max_active_batch_jobs() -> int:
    """``MAX_ACTIVE_BATCH_JOBS``: batch jobs active at once in this process (default 8)."""
    return speech_rest.env_int("MAX_ACTIVE_BATCH_JOBS", DEFAULT_MAX_ACTIVE_BATCH_JOBS, 1, 64)


# Back-compat alias so callers importing RenderRequest from here still work.
class RenderRequest(BaseModel):
    """Internal render request used by `render_podcast` when invoked directly.

    The HTTP API uses `podcast_models.RenderRequest` (which has script_id and
    layout/music/intro); this dataclass-like model bundles the script + roles
    + language so the synchronous worker has everything it needs.
    """
    script: Script
    roles: RenderRoles
    language: str = "en-US"


class ClipManifest(BaseModel):
    turn_idx: int
    speaker: str
    blob_url: str
    duration_sec: float = 0.0
    word_timings: list[dict] = Field(default_factory=list)
    chroma_key: bool = True
    avatar_id: str = avatar_registry.DEFAULT_ID


# ---------------------------------------------------------------------------
# Errors and results
# ---------------------------------------------------------------------------

class BatchJobError(RuntimeError):
    """A batch avatar job failed. ``reason`` is safe to surface: it never contains
    Speech character names, URLs or raw payloads."""

    def __init__(self, label: str, reason: str) -> None:
        super().__init__(f"{label}: {reason}")
        self.label = label
        self.reason = reason


class BatchJobCancelled(RuntimeError):
    """The caller's ``cancel`` event was set before the job finished."""


class BatchPollTimeout(TimeoutError):
    """The job was still running after ``poll_timeout`` seconds of polling
    (a per-job limit, distinct from the caller's overall deadline)."""


@dataclass(frozen=True)
class BatchJobResult:
    video_path: Path
    duration_sec: float
    vtt_path: Optional[Path] = None
    billed_seconds: Optional[float] = None


# ---------------------------------------------------------------------------
# Process-wide pacing and admission
# ---------------------------------------------------------------------------

IntOrFactory = Union[int, Callable[[], int]]


def _limit_fn(value: Optional[IntOrFactory], default: Callable[[], int]) -> Callable[[], int]:
    if value is None:
        return default
    if callable(value):
        return value
    fixed = int(value)
    return lambda: fixed


def _cancelled(cancel: Optional[threading.Event], what: str) -> None:
    if cancel is not None and cancel.is_set():
        raise BatchJobCancelled(f"{what}: cancelled")


class BatchCreatePacer:
    """Sliding-window limiter for batch job creation: at most ``per_window`` PUT
    attempts per ``window_sec + margin_sec``. Every attempt (retries included)
    takes a slot; ``hold(seconds)`` blocks all creators after a 429."""

    def __init__(
        self,
        per_window: Optional[IntOrFactory] = None,
        window_sec: float = BATCH_CREATE_WINDOW_SEC,
        *,
        margin_sec: float = BATCH_CREATE_MARGIN_SEC,
        clock: Optional[Callable[[], float]] = None,
        sleep: Optional[Callable[[float], None]] = None,
    ) -> None:
        self._limit = _limit_fn(per_window, batch_create_per_min)
        self._span = float(window_sec) + float(margin_sec)
        self._clock = clock or speech_rest.monotonic
        self._sleep = sleep or speech_rest.sleep
        self._stamps: deque[float] = deque()
        self._hold_until = float("-inf")
        self._lock = threading.Lock()

    def acquire(self, deadline: Optional[float] = None, *, cancel: Optional[threading.Event] = None) -> None:
        """Block until a creation slot is free; ``TimeoutError`` if that is past ``deadline``."""
        while True:
            _cancelled(cancel, "batch job creation")
            with self._lock:
                now = self._clock()
                while self._stamps and now - self._stamps[0] >= self._span:
                    self._stamps.popleft()
                limit = max(1, int(self._limit()))
                ready_at = self._hold_until
                if len(self._stamps) >= limit:
                    ready_at = max(ready_at, self._stamps[len(self._stamps) - limit] + self._span)
                if ready_at <= now:
                    self._stamps.append(now)
                    return
            if deadline is not None and ready_at > deadline:
                raise TimeoutError("no batch job creation slot before the deadline")
            wait = ready_at - now
            self._sleep(min(wait, _WAIT_CHUNK_SEC) if cancel is not None else wait)

    def hold(self, seconds: float) -> None:
        """No creation for ``seconds`` (the service answered 429 + Retry-After)."""
        with self._lock:
            self._hold_until = max(self._hold_until, self._clock() + max(0.0, float(seconds)))

    def reset(self) -> None:
        with self._lock:
            self._stamps.clear()
            self._hold_until = float("-inf")


class BatchAdmission:
    """At most ``limit`` (``MAX_ACTIVE_BATCH_JOBS``) batch jobs active at once."""

    def __init__(self, limit: Optional[IntOrFactory] = None, *,
                 clock: Optional[Callable[[], float]] = None) -> None:
        self._limit = _limit_fn(limit, max_active_batch_jobs)
        self._clock = clock or speech_rest.monotonic
        self._cond = threading.Condition()
        self._active = 0

    @property
    def active(self) -> int:
        return self._active

    def acquire(self, deadline: Optional[float] = None, *, cancel: Optional[threading.Event] = None) -> None:
        with self._cond:
            while self._active >= max(1, int(self._limit())):
                _cancelled(cancel, "batch job admission")
                wait = _WAIT_CHUNK_SEC
                if deadline is not None:
                    remaining = deadline - self._clock()
                    if remaining <= 0:
                        raise TimeoutError("no batch job slot before the deadline")
                    wait = min(wait, remaining)
                self._cond.wait(wait)
            self._active += 1

    def release(self) -> None:
        with self._cond:
            self._active = max(0, self._active - 1)
            self._cond.notify_all()


BATCH_CREATE_PACER = BatchCreatePacer()
BATCH_ADMISSION = BatchAdmission()


# ---------------------------------------------------------------------------
# Redaction helpers
# ---------------------------------------------------------------------------

_URL_RE = re.compile(r"https?://\S+", re.IGNORECASE)
_SECRET_PARAM_RE = re.compile(
    r"\b(?:sig|signature|token|key|code|sv|se|st|sp|sr|spr|skoid|sktid|skt|ske|sks|skv)=[^\s&\"')]*",
    re.IGNORECASE,
)
_NAME_TOKEN_RE = re.compile(r"[^0-9A-Za-z\u00C0-\uFFFF]+")
_CODE_RE = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")


def _secret_terms(*names: object) -> list[str]:
    terms: set[str] = set()
    for name in names:
        if isinstance(name, str) and name.strip():
            terms.add(name.strip())
            terms.update(t for t in _NAME_TOKEN_RE.split(name) if len(t) >= 4)
    return sorted(terms, key=len, reverse=True)


def _redaction_terms(entry: avatar_registry.AvatarEntry, avatar_config: dict) -> list[str]:
    """Character names to scrub from error text: every custom avatar's (they carry
    the client name) plus this job's when it is custom. Stock names are public."""
    names: list[object] = [e.foundry_name for e in avatar_registry.all_entries() if e.customized]
    if entry.customized:
        names += [entry.foundry_name, avatar_config.get("talkingAvatarCharacter")]
    return _secret_terms(*names)


def _scrub(text: object, terms: Iterable[str], limit: int = 200) -> str:
    out = _SECRET_PARAM_RE.sub("<redacted>", _URL_RE.sub("<url>", str(text or "")))
    for term in terms:
        out = re.sub(re.escape(term), "<avatar>", out, flags=re.IGNORECASE)
    return " ".join(out.split())[:limit] or "unknown error"


def _dict(value: object) -> dict:
    return value if isinstance(value, dict) else {}


def _error_code(err: dict) -> str:
    code = err.get("code")
    return code if isinstance(code, str) and _CODE_RE.fullmatch(code) else ""


def _job_failure_reason(props: dict, terms: Iterable[str]) -> tuple[str, str]:
    err = _dict(props.get("error"))
    code = _error_code(err)
    message = _scrub(err.get("message") or "failed", terms)
    return code, (f"{code}: {message}" if code else message)


def _http_failure_reason(exc: requests.HTTPError, terms: Iterable[str]) -> str:
    resp = exc.response
    if resp is None:
        return "HTTP error"
    detail = ""
    try:
        body = resp.json()
    except ValueError:
        body = None
    if isinstance(body, dict):
        err = _dict(body.get("error")) or body
        message = err.get("message")
        if isinstance(message, str) and message.strip():
            detail = _scrub(message, terms, 160)
    return f"HTTP {resp.status_code}" + (f": {detail}" if detail else "")


def _seconds(value: object, divisor: float) -> Optional[float]:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value < 0:
        return None
    return float(value) / divisor


# ---------------------------------------------------------------------------
# Shared batch job helper
# ---------------------------------------------------------------------------

def batch_job_url(cfg: AzureConfig, job_id: str) -> str:
    return f"{_get_speech_base_url(cfg)}/avatar/batchsyntheses/{job_id}?api-version={API_VERSION}"


def _pause(seconds: float, cancel: Optional[threading.Event], what: str) -> None:
    if seconds <= 0:
        return
    if cancel is None:
        speech_rest.sleep(seconds)
        return
    end = speech_rest.monotonic() + seconds
    while True:
        _cancelled(cancel, what)
        left = end - speech_rest.monotonic()
        if left <= 0:
            return
        speech_rest.sleep(min(left, _WAIT_CHUNK_SEC))


def _create_job(cfg: AzureConfig, url: str, payload: dict, *, label: str, deadline: Optional[float],
                before_put: Callable[[], None], on_throttle: Callable[[float], None]) -> None:
    try:
        speech_rest.request_with_retry(
            "PUT", url,
            headers_factory=lambda refresh: {**speech_rest.aad_header(cfg, force_refresh=refresh),
                                             "Content-Type": "application/json"},
            json=payload, timeout=30, max_attempts=_CREATE_ATTEMPTS, deadline=deadline,
            before_attempt=before_put, on_throttle=on_throttle,
        )
    except requests.HTTPError as exc:
        # Same (fresh uuid) id already exists: an earlier attempt of this call was
        # created but its response was lost -> adopt the job.
        if exc.response is not None and exc.response.status_code == 409:
            log.info("batch avatar job already exists, adopting it: %s", label)
            return
        raise


def _poll_job(cfg: AzureConfig, url: str, *, label: str, deadline: Optional[float], poll_interval: float,
              poll_timeout: Optional[float], cancel: Optional[threading.Event]) -> dict:
    poll_deadline = None if poll_timeout is None else speech_rest.monotonic() + max(0.0, float(poll_timeout))
    while True:
        _cancelled(cancel, label)
        resp = speech_rest.request_with_retry(
            "GET", url,
            headers_factory=lambda refresh: speech_rest.aad_header(cfg, force_refresh=refresh),
            timeout=15, max_attempts=_POLL_ATTEMPTS, deadline=deadline,
        )
        try:
            data = resp.json()
        except ValueError:
            raise BatchJobError(label, "invalid status response") from None
        if not isinstance(data, dict):
            raise BatchJobError(label, "invalid status response")
        if data.get("status") in _TERMINAL_STATUSES:
            return data
        now = speech_rest.monotonic()
        if poll_deadline is not None and now + poll_interval > poll_deadline:
            raise BatchPollTimeout(f"{label}: still running after {poll_timeout:.0f}s")
        if deadline is not None and now + poll_interval > deadline:
            raise TimeoutError(f"{label}: deadline reached while the job was running")
        _pause(poll_interval, cancel, label)


def _delete_job_quietly(cfg: AzureConfig, url: str, *, label: str, avatar_id: str, job_id: str) -> None:
    try:
        resp = requests.request("DELETE", url, headers=speech_rest.aad_header(cfg), timeout=10)
        log.info("batch avatar job deleted: %s avatar=%s job=%s (HTTP %d)",
                 label, avatar_id, job_id, resp.status_code)
        resp.close()
    except Exception as exc:  # noqa: BLE001 - best effort
        log.warning("batch avatar job delete failed: %s avatar=%s job=%s (%s)",
                    label, avatar_id, job_id, type(exc).__name__)


def _collect_outputs(data: dict, out_path: Path, *, label: str, entry: avatar_registry.AvatarEntry,
                     job_id: str, deadline: Optional[float], terms: list[str]) -> BatchJobResult:
    props = _dict(data.get("properties"))
    if data.get("status") != "Succeeded":
        code, reason = _job_failure_reason(props, terms)
        log.warning("batch avatar job failed: %s avatar=%s job=%s code=%s",
                    label, entry.id, job_id, code or "unknown")
        raise BatchJobError(label, reason)
    outputs = _dict(data.get("outputs"))
    video_url = outputs.get("result")
    if not isinstance(video_url, str) or not video_url:
        raise BatchJobError(label, "no video url")
    duration = _seconds(props.get("durationInMilliseconds"), 1000.0) or 0.0
    billed = _seconds(_dict(props.get("billingDetails")).get("talkingAvatarDurationSeconds"), 1.0)
    speech_rest.download_to(video_url, out_path, deadline=deadline)
    vtt_path: Optional[Path] = None
    # WebVTT for word-by-word karaoke; the field name varies by API version and
    # soft-embedded subtitles usually have none.
    vtt_url = outputs.get("subtitles") or outputs.get("destinationUrl") or outputs.get("webvttUrl")
    if isinstance(vtt_url, str) and vtt_url:
        try:
            vtt_path = speech_rest.download_to(vtt_url, out_path.with_suffix(".vtt"), deadline=deadline)
        except TimeoutError:
            raise
        except Exception as exc:  # noqa: BLE001
            log.warning("batch avatar subtitles unavailable: %s (%s)", label, type(exc).__name__)
    log.info("batch avatar job done: %s avatar=%s job=%s video=%.2fs billed=%s",
             label, entry.id, job_id, duration, "?" if billed is None else f"{billed:g}s")
    return BatchJobResult(video_path=out_path, duration_sec=duration, vtt_path=vtt_path, billed_seconds=billed)


def run_batch_avatar_job(
    cfg: AzureConfig,
    ssml: str,
    entry: avatar_registry.AvatarEntry,
    out_path: Path,
    *,
    label: str,
    deadline: Optional[float] = None,
    poll_interval: float = 5.0,
    avatar_config_overrides: Optional[dict] = None,
    poll_timeout: Optional[float] = DEFAULT_POLL_TIMEOUT_SEC,
    cancel: Optional[threading.Event] = None,
) -> BatchJobResult:
    """Render one SSML input with one batch avatar job and download the video.

    admission -> pacer -> PUT -> poll -> download ``outputs.result`` to
    ``out_path`` (+ ``.vtt`` when the job exposes subtitles). ``label`` is for
    logs and errors (e.g. ``"turn 3"``); it must not contain character names.
    ``avatar_config_overrides`` is shallow-merged over the registry's
    ``avatarConfig``. ``poll_timeout`` bounds polling of this job; ``deadline``
    (absolute ``time.monotonic()``) bounds everything; ``cancel`` aborts.

    Raises ``TimeoutError`` (deadline; ``BatchPollTimeout`` for ``poll_timeout``),
    ``BatchJobCancelled``, ``BatchJobError`` (failed job, HTTP or transport
    error; safe message) or credential errors. A job left running by any error
    is deleted (best effort).
    """
    out_path = Path(out_path)
    job_id = str(uuid.uuid4())
    url = batch_job_url(cfg, job_id)
    avatar_config = {**avatar_registry.avatar_config_payload(entry), **(avatar_config_overrides or {})}
    payload = {"inputKind": "SSML", "inputs": [{"content": ssml}], "avatarConfig": avatar_config}
    terms = _redaction_terms(entry, avatar_config)
    pacer = BATCH_CREATE_PACER
    admission = BATCH_ADMISSION
    put_attempted = False
    created = False
    terminal = False

    def before_put() -> None:
        nonlocal put_attempted
        pacer.acquire(deadline, cancel=cancel)
        put_attempted = True

    _cancelled(cancel, label)
    admission.acquire(deadline, cancel=cancel)
    holding = True
    try:
        _create_job(cfg, url, payload, label=label, deadline=deadline,
                    before_put=before_put, on_throttle=pacer.hold)
        created = True
        log.info("batch avatar job submitted: %s avatar=%s job=%s", label, entry.id, job_id)
        data = _poll_job(cfg, url, label=label, deadline=deadline, poll_interval=poll_interval,
                         poll_timeout=poll_timeout, cancel=cancel)
        terminal = True
        admission.release()
        holding = False
        return _collect_outputs(data, out_path, label=label, entry=entry, job_id=job_id,
                                deadline=deadline, terms=terms)
    except Exception as exc:
        # A job may exist (created, or a PUT whose outcome is unknown) and still
        # run: delete it so it stops consuming the quota.
        maybe_running = (created and not terminal) or (
            put_attempted and not created and not isinstance(exc, requests.HTTPError))
        if maybe_running:
            _delete_job_quietly(cfg, url, label=label, avatar_id=entry.id, job_id=job_id)
        if isinstance(exc, requests.HTTPError):
            raise BatchJobError(label, _http_failure_reason(exc, terms)) from None
        if isinstance(exc, requests.RequestException):
            raise BatchJobError(label, type(exc).__name__) from None
        if isinstance(exc, (BatchJobCancelled, TimeoutError)):
            log.info("batch avatar job stopped: %s avatar=%s job=%s (%s)",
                     label, entry.id, job_id, type(exc).__name__)
        raise
    finally:
        if holding:
            admission.release()


# ---------------------------------------------------------------------------
# Legacy helpers (thin wrappers over services.speech_rest)
# ---------------------------------------------------------------------------

def _request_with_429_retry(
    method: str,
    url: str,
    *,
    headers: dict,
    json_body: Optional[dict] = None,
    timeout: int = 30,
    max_retries: int = 6,
) -> requests.Response:
    """Back-compat wrapper: ``speech_rest.request_with_retry`` with fixed headers."""
    return speech_rest.request_with_retry(method, url, headers_factory=lambda _refresh: headers,
                                          json=json_body, timeout=timeout, max_attempts=max_retries)


def _download(url: str, dest: Path) -> Path:
    return speech_rest.download_to(url, dest)


def _parse_webvtt_word_timings(vtt_text: str) -> list[dict]:
    """Best-effort parse: each cue → {start, end, text}.

    Speech batch synthesis emits cue-level (not word-level) WebVTT in most
    cases; we surface those as 'words' so the karaoke filter has something
    to work with. If no cues are present, returns [].
    """
    out: list[dict] = []
    cur_start = cur_end = None
    cur_text: list[str] = []
    for raw in vtt_text.splitlines():
        line = raw.strip()
        if "-->" in line:
            if cur_start is not None and cur_text:
                out.append({"start": cur_start, "end": cur_end, "text": " ".join(cur_text).strip()})
            cur_text = []
            try:
                lhs, rhs = [s.strip() for s in line.split("-->", 1)]
                cur_start = _vtt_ts(lhs)
                cur_end = _vtt_ts(rhs.split(" ", 1)[0])
            except Exception:
                cur_start = cur_end = None
        elif line and not line.startswith(("WEBVTT", "NOTE")):
            cur_text.append(line)
    if cur_start is not None and cur_text:
        out.append({"start": cur_start, "end": cur_end, "text": " ".join(cur_text).strip()})
    return out


def _vtt_ts(s: str) -> float:
    parts = s.split(":")
    if len(parts) == 3:
        h, m, rest = parts
        return int(h) * 3600 + int(m) * 60 + float(rest.replace(",", "."))
    if len(parts) == 2:
        m, rest = parts
        return int(m) * 60 + float(rest.replace(",", "."))
    return float(s)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class _TurnPlan:
    turn: DialogueTurn
    entry: avatar_registry.AvatarEntry
    ssml: str
    out_path: Path


def _plan_turn(turn: DialogueTurn, role: RoleConfig, language: str,
               pauses: Optional[dict[int, int]], work_dir: Path) -> _TurnPlan:
    voice = role.voice or VOICE_MAP.get(language, VOICE_MAP["en-US"])
    entry = avatar_registry.get(role.avatar) if role.avatar else avatar_registry.for_voice(voice)
    ssml = build_ssml(turn.text, language, voice=voice, pause_after_sentence=pauses)
    ext = entry.video_format or "webm"
    return _TurnPlan(turn=turn, entry=entry, ssml=ssml, out_path=work_dir / f"turn_{turn.idx:03d}.{ext}")


def _render_turn(cfg: AzureConfig, plan: _TurnPlan, *, deadline: Optional[float], poll_interval: float,
                 poll_timeout: Optional[float], cancel: threading.Event) -> ClipManifest:
    try:
        result = run_batch_avatar_job(cfg, plan.ssml, plan.entry, plan.out_path, label=f"turn {plan.turn.idx}",
                                      deadline=deadline, poll_interval=poll_interval,
                                      poll_timeout=poll_timeout, cancel=cancel)
    except BatchJobCancelled:
        raise
    except BaseException:
        # Stop sibling turns before this worker thread picks up the next one.
        cancel.set()
        raise
    word_timings: list[dict] = []
    if result.vtt_path:
        try:
            word_timings = _parse_webvtt_word_timings(result.vtt_path.read_text(encoding="utf-8"))
        except Exception as exc:  # noqa: BLE001
            log.warning("vtt parse failed for turn %d (%s)", plan.turn.idx, type(exc).__name__)
    return ClipManifest(
        turn_idx=plan.turn.idx,
        speaker=plan.turn.speaker,
        blob_url=str(result.video_path),
        duration_sec=result.duration_sec,
        word_timings=word_timings,
        chroma_key=plan.entry.chroma_key,
        avatar_id=plan.entry.id,
    )


def _safe_reason(exc: BaseException) -> str:
    if isinstance(exc, BatchJobError):
        return exc.reason
    if isinstance(exc, TimeoutError):
        return "timeout"
    return type(exc).__name__


def render_podcast(
    cfg: AzureConfig,
    script: Script,
    roles: RenderRoles,
    progress_cb: Optional[Callable[[int], None]] = None,
    language: str = "en-US",
    work_dir: Optional[Path] = None,
    timeout: int = 900,
    poll_interval: int = 5,
    max_parallel: int = 1,
    *,
    pauses: Optional[dict[int, dict[int, int]]] = None,
    deadline: Optional[float] = None,
) -> list[ClipManifest]:
    """Render every dialogue turn into an avatar clip (one batch job per turn).

    Returns ClipManifest list ordered by `turn_idx`. Local file paths are
    used for `blob_url`; callers that need real Azure blob URLs can re-upload
    via `services.storage.PresentationStore` afterward.

    Turns run concurrently up to ``MAX_ACTIVE_BATCH_JOBS``: each job is created
    as soon as the process-wide pacer allows and polled while others are still
    being created. ``pauses`` = ``{turn_idx: {after_sentence: ms}}`` planned
    speaker pauses (``build_ssml(pause_after_sentence=...)``). ``timeout`` bounds
    the polling of each turn (that turn fails with "timeout"); ``deadline``
    (absolute ``time.monotonic()``) bounds the whole render: nothing is
    submitted after it, running jobs are deleted and ``TimeoutError`` is raised.
    ``max_parallel`` is kept for backward compatibility and ignored.

    Fails loud: the first failed turn stops further submissions and a
    ``RuntimeError`` lists the failed turns. progress_cb(n_completed) is invoked
    after each turn finishes.
    """
    work_dir = Path(work_dir) if work_dir else Path("data/podcast") / uuid.uuid4().hex[:8]
    work_dir.mkdir(parents=True, exist_ok=True)

    role_for = {"interviewer": roles.interviewer, "expert": roles.expert}
    turn_pauses = pauses or {}
    plans = [
        _plan_turn(t, role_for[t.speaker], language, turn_pauses.get(t.idx), work_dir)
        for t in sorted(script.turns, key=lambda x: x.idx)
    ]
    if not plans:
        return []
    if deadline is not None and speech_rest.monotonic() >= deadline:
        raise TimeoutError("podcast render deadline reached before any submission")

    cancel = threading.Event()
    clips: dict[int, ClipManifest] = {}
    failed: dict[int, str] = {}
    deadline_hit = False
    completed_n = 0
    workers = max(1, min(len(plans), max_active_batch_jobs()))
    with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="podcast-turn") as pool:
        futures = {
            pool.submit(_render_turn, cfg, plan, deadline=deadline, poll_interval=poll_interval,
                        poll_timeout=timeout, cancel=cancel): plan.turn.idx
            for plan in plans
        }
        for fut in as_completed(futures):
            idx = futures[fut]
            try:
                clips[idx] = fut.result()
            except BatchJobCancelled:
                continue
            except BatchPollTimeout:
                failed[idx] = "timeout"
            except TimeoutError:
                deadline_hit = True
                cancel.set()
                continue
            except Exception as exc:  # noqa: BLE001
                failed[idx] = _safe_reason(exc)
            if idx in failed:
                log.error("turn %d failed: %s", idx, failed[idx])
                cancel.set()
            completed_n += 1
            if progress_cb:
                try:
                    progress_cb(completed_n)
                except Exception:  # noqa: BLE001
                    pass

    if deadline_hit:
        raise TimeoutError(f"podcast render deadline reached ({len(clips)}/{len(plans)} turns rendered)")
    if failed or len(clips) != len(plans):
        # Fail loud — silent drops produce unusable videos where one speaker
        # is missing entirely. The PoC should surface the problem instead.
        details = "; ".join(f"turn {i}: {err}" for i, err in sorted(failed.items()))
        not_rendered = len(plans) - len(clips) - len(failed)
        suffix = f" ({not_rendered} not rendered)" if not_rendered else ""
        raise RuntimeError(f"{len(failed)}/{len(plans)} avatar turns failed: {details}{suffix}")

    return [clips[plan.turn.idx] for plan in plans]
