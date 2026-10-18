"""Shared Speech REST plumbing: Entra auth (AAD + STS) and one bounded retry policy.

Used by the podcast engines: batch avatar jobs (``services.podcast_render``) and
audio-only TTS (``services.podcast_tts``). ``services.voice_questions`` keeps its
own async STS client.

Auth
----
* ``aad_header(cfg)``: batch/management APIs on the resource endpoint.
  ``Authorization: Bearer <AAD>`` with managed identity, else the resource key
  (same rule as ``avatar._get_speech_auth_header``). The AAD token comes from a
  process-wide ``DefaultAzureCredential`` and is cached until 5 min before expiry.
* ``sts_header(cfg)``: regional TTS/STT REST endpoints. The AAD token is exchanged
  at ``{speech_endpoint}/sts/v1.0/issuetoken`` for an STS token (valid 10 min,
  cached per endpoint for 9 min); the resource key is used instead when one is
  configured and managed identity is off (same rule as ``voice_questions``).
  Spike S2: the exchange needs the *custom-domain* endpoint (the regional STS
  answers 400 to an Entra bearer, and a raw Entra bearer on the regional TTS
  host gets 401).

Retry policy (``request_with_retry``)
-------------------------------------
* 401: refresh credentials once (``headers_factory(True)``), then fail.
* 429: honour ``Retry-After`` (seconds or HTTP date; at least 2 s, at most 120 s).
* 408 / 5xx / connection errors / timeouts: jittered exponential backoff
  1, 2, 4 ... s (+-25 %), capped at 30 s. Other statuses (e.g. 400) never retry.
* Bounded attempts and a cooperative ``deadline`` (absolute ``time.monotonic()``):
  ``TimeoutError`` instead of a wait that would pass it; per-request timeouts are
  capped by the time left.

Privacy: tokens, keys, query strings (SAS signatures) and bodies are never logged.
URLs appear as ``host/path`` only, and raised errors carry the same redacted form
(the original transport exception is not chained).
"""
from __future__ import annotations

import logging
import math
import os
import random
import threading
import time
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Optional, Union
from urllib.parse import urlsplit

import requests

from config import AzureConfig

log = logging.getLogger(__name__)

SPEECH_SCOPE = "https://cognitiveservices.azure.com/.default"
STS_TOKEN_TTL_SEC = 9 * 60
AAD_REFRESH_MARGIN_SEC = 5 * 60
AAD_RETRY_DELAY_SEC = 1.0
# CLI-based developer credentials can take > 10 s on a dev box (S1/S2);
# managed identity in production is unaffected.
CREDENTIAL_PROCESS_TIMEOUT_SEC = 30

RETRY_STATUSES: tuple[int, ...] = (408, 429, 500, 502, 503, 504)
BACKOFF_BASE_SEC = 1.0
BACKOFF_CAP_SEC = 30.0
MIN_RETRY_AFTER_SEC = 2.0
MAX_RETRY_AFTER_SEC = 120.0
MIN_REQUEST_TIMEOUT_SEC = 1.0

_TRANSIENT_ERRORS: tuple[type[BaseException], ...] = (
    requests.ConnectionError,
    requests.Timeout,
    requests.exceptions.ChunkedEncodingError,
)

# Indirections so tests can drive time without patching the global modules.
_monotonic: Callable[[], float] = time.monotonic
_sleep: Callable[[float], None] = time.sleep
_jitter: Callable[[float, float], float] = random.uniform


def monotonic() -> float:
    """Clock used for every deadline in the speech engines (``time.monotonic``)."""
    return _monotonic()


def sleep(seconds: float) -> None:
    if seconds > 0:
        _sleep(seconds)


def env_int(name: str, default: int, lo: int, hi: int) -> int:
    """Integer env var clamped to [lo, hi]; missing or invalid -> ``default``."""
    try:
        value = int((os.environ.get(name) or "").strip())
    except ValueError:
        return default
    return max(lo, min(hi, value))


class SpeechAuthError(RuntimeError):
    """Speech credentials could not be obtained (the message never contains secrets)."""


def redact_url(url: str) -> str:
    """``host/path`` only: no credentials, query string (SAS) or fragment."""
    try:
        parts = urlsplit(url)
        host = parts.hostname or "?"
    except ValueError:
        return "<url>"
    return f"{host}{parts.path}"


# ---------------------------------------------------------------------------
# Entra (AAD) token
# ---------------------------------------------------------------------------
_credential: Any = None
_credential_lock = threading.Lock()
_aad_cache: Optional[tuple[str, float]] = None  # (token, expires_on epoch seconds)
_aad_lock = threading.Lock()


def _get_credential() -> Any:
    global _credential
    with _credential_lock:
        if _credential is None:
            from azure.identity import DefaultAzureCredential

            _credential = DefaultAzureCredential(process_timeout=CREDENTIAL_PROCESS_TIMEOUT_SEC)
        return _credential


def aad_token(*, force_refresh: bool = False) -> str:
    """Entra access token for Cognitive Services (cached until 5 min before expiry).

    A transient credential failure (e.g. "Failed to invoke the Azure Developer
    CLI") is retried once before it propagates.
    """
    global _aad_cache
    from azure.core.exceptions import ClientAuthenticationError
    from azure.identity import CredentialUnavailableError

    with _aad_lock:
        cached = _aad_cache
        if cached and not force_refresh and cached[1] - time.time() > AAD_REFRESH_MARGIN_SEC:
            return cached[0]
        for attempt in (1, 2):
            try:
                access = _get_credential().get_token(SPEECH_SCOPE)
                break
            except (CredentialUnavailableError, ClientAuthenticationError) as exc:
                if attempt == 2:
                    raise
                log.warning("Speech: Entra token request failed (%s); retrying once", type(exc).__name__)
                sleep(AAD_RETRY_DELAY_SEC)
        _aad_cache = (access.token, float(access.expires_on))
        return access.token


def aad_header(cfg: AzureConfig, *, force_refresh: bool = False) -> dict[str, str]:
    """Auth header for the batch/management Speech APIs (see module docstring)."""
    if cfg.use_managed_identity:
        return {"Authorization": "Bearer " + aad_token(force_refresh=force_refresh)}
    return {"Ocp-Apim-Subscription-Key": cfg.speech_key}


# ---------------------------------------------------------------------------
# STS token (regional TTS/STT REST)
# ---------------------------------------------------------------------------
_sts_cache: dict[str, tuple[str, float]] = {}  # endpoint -> (token, monotonic expiry)
_sts_lock = threading.Lock()
# S2: the regional STS answers 400 to an Entra bearer; only the custom domain works.
_REGIONAL_HOST_SUFFIXES = (".api.cognitive.microsoft.com", ".tts.speech.microsoft.com",
                           ".stt.speech.microsoft.com")


def _issue_sts_token(endpoint: str) -> str:
    resp = request_with_retry(
        "POST",
        f"{endpoint}/sts/v1.0/issuetoken",
        headers_factory=lambda refresh: {
            "Authorization": "Bearer " + aad_token(force_refresh=refresh),
            "Content-Length": "0",
        },
        timeout=15,
        max_attempts=3,
    )
    token = (resp.text or "").strip()
    if not token:
        raise SpeechAuthError("Speech STS returned an empty token")
    return token


def sts_header(cfg: AzureConfig, *, force_refresh: bool = False) -> dict[str, str]:
    """Auth header for the regional TTS/STT REST endpoints (see module docstring)."""
    if cfg.speech_key and not cfg.use_managed_identity:
        return {"Ocp-Apim-Subscription-Key": cfg.speech_key}
    endpoint = (cfg.speech_endpoint or "").strip().rstrip("/")
    try:
        host = (urlsplit(endpoint).hostname or "").lower()
    except ValueError:
        host = ""
    if not host or host.endswith(_REGIONAL_HOST_SUFFIXES):
        raise SpeechAuthError("Entra auth for Speech REST needs AZURE_SPEECH_ENDPOINT = the custom-domain endpoint")
    with _sts_lock:
        cached = _sts_cache.get(endpoint)
        if cached and not force_refresh and cached[1] > monotonic():
            return {"Authorization": "Bearer " + cached[0]}
        token = _issue_sts_token(endpoint)
        _sts_cache[endpoint] = (token, monotonic() + STS_TOKEN_TTL_SEC)
        return {"Authorization": "Bearer " + token}


def reset_auth_cache() -> None:
    """Forget cached AAD and STS tokens (tests, credential rotation)."""
    global _aad_cache
    with _aad_lock:
        _aad_cache = None
    with _sts_lock:
        _sts_cache.clear()


# ---------------------------------------------------------------------------
# Retry policy
# ---------------------------------------------------------------------------
def retry_after_seconds(value: Optional[str]) -> Optional[float]:
    """``Retry-After`` as seconds (delta-seconds or HTTP date); None if absent/invalid."""
    if not value:
        return None
    value = value.strip()
    try:
        seconds = float(value)
    except ValueError:
        try:
            when = parsedate_to_datetime(value)
        except (TypeError, ValueError, IndexError):
            return None
        if when is None:
            return None
        if when.tzinfo is None:
            when = when.replace(tzinfo=timezone.utc)
        return max(0.0, (when - datetime.now(timezone.utc)).total_seconds())
    return seconds if math.isfinite(seconds) and seconds >= 0 else None


def backoff_seconds(n: int) -> float:
    """n-th (0-based) jittered exponential backoff: 1, 2, 4 ... s +-25 %, capped at 30 s."""
    base = min(BACKOFF_CAP_SEC, BACKOFF_BASE_SEC * (2 ** min(n, 16)))
    return min(BACKOFF_CAP_SEC, base * _jitter(0.75, 1.25))


def _check_deadline(deadline: Optional[float], what: str) -> None:
    if deadline is not None and monotonic() >= deadline:
        raise TimeoutError(f"deadline reached before {what}")


def _wait_or_timeout(wait: float, deadline: Optional[float], what: str) -> None:
    if deadline is not None and monotonic() + wait > deadline:
        raise TimeoutError(f"deadline reached before retrying {what}")
    sleep(wait)


def _http_error(resp: requests.Response, what: str) -> requests.HTTPError:
    return requests.HTTPError(f"HTTP {resp.status_code} for {what}", response=resp)


def _transport_error(exc: BaseException, what: str, attempts: int) -> requests.RequestException:
    cls = type(exc) if isinstance(exc, requests.RequestException) else requests.ConnectionError
    try:
        return cls(f"{what} failed after {attempts} attempt(s): {type(exc).__name__}")
    except Exception:  # noqa: BLE001 - exotic constructor
        return requests.ConnectionError(f"{what} failed after {attempts} attempt(s): {type(exc).__name__}")


TimeoutSpec = Union[float, tuple[float, float]]


def _capped_timeout(timeout: TimeoutSpec, deadline: Optional[float]) -> TimeoutSpec:
    """Per-request timeout(s) capped by the time left before ``deadline``."""
    if deadline is None:
        return timeout
    left = max(MIN_REQUEST_TIMEOUT_SEC, deadline - monotonic())
    if isinstance(timeout, tuple):
        return (min(float(timeout[0]), left), min(float(timeout[1]), left))
    return min(float(timeout), left)


def request_with_retry(
    method: str,
    url: str,
    *,
    headers_factory: Callable[[bool], Mapping[str, str]],
    json: Any = None,
    data: Any = None,
    timeout: TimeoutSpec = 30,
    max_attempts: int = 6,
    deadline: Optional[float] = None,
    retry_statuses: Iterable[int] = RETRY_STATUSES,
    stream: bool = False,
    before_attempt: Optional[Callable[[], None]] = None,
    on_throttle: Optional[Callable[[float], None]] = None,
) -> requests.Response:
    """HTTP call with the shared Speech retry policy (see module docstring).

    ``timeout`` is seconds or ``(connect, read)`` as in ``requests``.
    ``headers_factory(force_refresh)`` is called before every attempt;
    ``force_refresh`` is True only right after a 401. ``before_attempt`` runs
    before every attempt (e.g. job-creation pacing). ``on_throttle(wait)`` is
    called on 429 and then *owns* the wait: no sleep happens here, so the
    caller must enforce it (e.g. a pacer hold checked by ``before_attempt``).

    Returns the first response with status < 400. Raises ``requests.HTTPError``
    (redacted message, ``.response`` set) for other statuses once retries are
    exhausted or not applicable, a redacted ``requests.RequestException`` after
    repeated transport errors, and ``TimeoutError`` at the deadline.
    """
    what = f"{method.upper()} {redact_url(url)}"
    statuses = frozenset(retry_statuses)
    attempts = max(1, int(max_attempts))
    refreshed = False
    force_refresh = False
    backoff_n = 0
    for attempt in range(1, attempts + 1):
        _check_deadline(deadline, what)
        if before_attempt is not None:
            before_attempt()
        headers = dict(headers_factory(force_refresh))
        force_refresh = False
        failure: Optional[BaseException] = None
        resp: Optional[requests.Response] = None
        try:
            resp = requests.request(method, url, headers=headers, json=json, data=data,
                                    timeout=_capped_timeout(timeout, deadline), stream=stream)
        except _TRANSIENT_ERRORS as exc:
            failure = exc
        if resp is None:
            assert failure is not None
            if attempt >= attempts:
                raise _transport_error(failure, what, attempt)
            wait = backoff_seconds(backoff_n)
            backoff_n += 1
            log.warning("Speech %s: %s (attempt %d/%d), retrying in %.1fs",
                        what, type(failure).__name__, attempt, attempts, wait)
            _wait_or_timeout(wait, deadline, what)
            continue

        status = resp.status_code
        if status < 400:
            return resp
        if status == 401 and not refreshed and attempt < attempts:
            refreshed = True
            force_refresh = True
            resp.close()
            log.info("Speech %s: HTTP 401, refreshing credentials", what)
            continue
        if status in statuses and attempt < attempts:
            if status == 429:
                retry_after = retry_after_seconds(resp.headers.get("Retry-After"))
                if retry_after is None:
                    retry_after = backoff_seconds(backoff_n)
                    backoff_n += 1
                wait = min(MAX_RETRY_AFTER_SEC, max(MIN_RETRY_AFTER_SEC, retry_after))
            else:
                wait = backoff_seconds(backoff_n)
                backoff_n += 1
            resp.close()
            log.warning("Speech %s: HTTP %d (attempt %d/%d), retrying in %.1fs",
                        what, status, attempt, attempts, wait)
            if status == 429 and on_throttle is not None:
                if deadline is not None and monotonic() + wait > deadline:
                    raise TimeoutError(f"deadline reached before retrying {what}")
                on_throttle(wait)
                continue
            _wait_or_timeout(wait, deadline, what)
            continue
        raise _http_error(resp, what)
    raise AssertionError("unreachable")  # pragma: no cover


def _no_auth(_force_refresh: bool) -> dict[str, str]:
    return {}


def download_to(
    url: str,
    dest: Path,
    *,
    deadline: Optional[float] = None,
    timeout: TimeoutSpec = (10, 120),
    max_attempts: int = 3,
    headers_factory: Callable[[bool], Mapping[str, str]] = _no_auth,
) -> Path:
    """Stream ``url`` (e.g. a SAS URL) to ``dest`` atomically (``.part`` then rename).

    Transport errors in the middle of the body restart the download (bounded).
    The URL is never logged with its query string.
    """
    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_name(dest.name + ".part")
    what = f"GET {redact_url(url)}"
    attempts = max(1, int(max_attempts))
    for attempt in range(1, attempts + 1):
        resp = request_with_retry("GET", url, headers_factory=headers_factory, timeout=timeout,
                                  max_attempts=attempts, deadline=deadline, stream=True)
        failure: Optional[BaseException] = None
        try:
            with resp, part.open("wb") as fh:
                for chunk in resp.iter_content(1 << 16):
                    if chunk:
                        fh.write(chunk)
        except _TRANSIENT_ERRORS as exc:
            failure = exc
        except BaseException:
            part.unlink(missing_ok=True)
            raise
        if failure is None:
            os.replace(part, dest)
            return dest
        part.unlink(missing_ok=True)
        if attempt >= attempts:
            raise _transport_error(failure, what, attempt)
        wait = backoff_seconds(attempt - 1)
        log.warning("Speech %s: body interrupted (%s), retrying in %.1fs", what, type(failure).__name__, wait)
        _wait_or_timeout(wait, deadline, what)
    raise AssertionError("unreachable")  # pragma: no cover


__all__ = [
    "RETRY_STATUSES",
    "SPEECH_SCOPE",
    "STS_TOKEN_TTL_SEC",
    "SpeechAuthError",
    "TimeoutSpec",
    "aad_header",
    "aad_token",
    "backoff_seconds",
    "download_to",
    "env_int",
    "monotonic",
    "redact_url",
    "request_with_retry",
    "reset_auth_cache",
    "retry_after_seconds",
    "sleep",
    "sts_header",
]
