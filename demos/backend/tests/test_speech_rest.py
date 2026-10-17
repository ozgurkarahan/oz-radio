"""services.speech_rest: shared Speech auth (AAD/STS) and the bounded retry policy.

All HTTP is faked by patching ``requests.request``; no Azure call is made.
"""
from __future__ import annotations

import json
import logging
import re
import threading
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime
from types import SimpleNamespace

import pytest
import requests

from config import AzureConfig
from services import speech_rest

SAS_URL = "https://acct.blob.core.windows.net/out/clip.mp4?sv=2024&sig=SECRETSIG"


def make_cfg(**overrides) -> AzureConfig:
    base = dict(speech_endpoint="", speech_key="test-key", speech_region="swedencentral",
                speech_resource_id="", openai_endpoint="", openai_key="", openai_chat_deployment="",
                openai_embedding_deployment="", use_managed_identity=False)
    base.update(overrides)
    return AzureConfig(**base)


def make_response(status: int = 200, body: bytes | str = b"", headers: dict | None = None,
                  json_body: object = None) -> requests.Response:
    resp = requests.Response()
    resp.status_code = status
    if json_body is not None:
        body = json.dumps(json_body)
    resp._content = body.encode() if isinstance(body, str) else body
    resp._content_consumed = True
    resp.headers = requests.structures.CaseInsensitiveDict(headers or {})
    resp.reason = "fake"
    resp.encoding = "utf-8"
    resp.url = "https://fake.invalid/"
    return resp


class FakeHTTP:
    """Scripted ``requests.request``: per-route queues (the last item repeats)."""

    def __init__(self) -> None:
        self.calls: list[dict] = []
        self.routes: list[tuple[str, re.Pattern, list]] = []
        self.lock = threading.Lock()

    def add(self, method: str, pattern: str, *items) -> "FakeHTTP":
        self.routes.append((method.upper(), re.compile(pattern), list(items)))
        return self

    def __call__(self, method, url, **kw):
        with self.lock:
            call = {"method": method.upper(), "url": url, **kw}
            self.calls.append(call)
            for m, rx, queue in self.routes:
                if m == method.upper() and rx.search(url):
                    item = queue.pop(0) if len(queue) > 1 else queue[0]
                    break
            else:
                raise AssertionError(f"unexpected request {method} {url}")
        if callable(item) and not isinstance(item, (requests.Response, BaseException)):
            item = item(call)
        if isinstance(item, BaseException):
            raise item
        return item

    def urls(self, method: str | None = None) -> list[str]:
        return [c["url"] for c in self.calls if method is None or c["method"] == method]


class FakeClock:
    def __init__(self, start: float = 1000.0) -> None:
        self.now = start
        self.sleeps: list[float] = []

    def monotonic(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(round(seconds, 6))
        self.now += seconds


@pytest.fixture
def http(monkeypatch):
    fake = FakeHTTP()
    monkeypatch.setattr(requests, "request", fake)
    return fake


@pytest.fixture
def clock(monkeypatch):
    fake = FakeClock()
    monkeypatch.setattr(speech_rest, "_monotonic", fake.monotonic)
    monkeypatch.setattr(speech_rest, "_sleep", fake.sleep)
    monkeypatch.setattr(speech_rest, "_jitter", lambda a, b: 1.0)
    return fake


@pytest.fixture(autouse=True)
def _fresh_auth(monkeypatch):
    speech_rest.reset_auth_cache()
    monkeypatch.setattr(speech_rest, "_credential", None)
    yield
    speech_rest.reset_auth_cache()


def no_auth(_refresh: bool) -> dict:
    return {}


# ---------------------------------------------------------------------------
# Retry matrix
# ---------------------------------------------------------------------------

def test_success_needs_a_single_call(http, clock):
    http.add("GET", "x", make_response(200, "ok"))
    resp = speech_rest.request_with_retry("GET", "https://h.invalid/x", headers_factory=no_auth)
    assert resp.text == "ok" and len(http.calls) == 1 and clock.sleeps == []


def test_401_refreshes_credentials_once_then_succeeds(http, clock):
    seen: list[bool] = []

    def factory(refresh: bool) -> dict:
        seen.append(refresh)
        return {"Authorization": "Bearer " + ("fresh" if refresh else "stale")}

    http.add("GET", "x", make_response(401), make_response(200, "ok"))
    resp = speech_rest.request_with_retry("GET", "https://h.invalid/x", headers_factory=factory)
    assert resp.status_code == 200
    assert seen == [False, True]
    assert [c["headers"]["Authorization"] for c in http.calls] == ["Bearer stale", "Bearer fresh"]
    assert clock.sleeps == []


def test_second_401_is_not_retried_again(http, clock):
    http.add("GET", "x", make_response(401))
    with pytest.raises(requests.HTTPError) as err:
        speech_rest.request_with_retry("GET", "https://h.invalid/x?sig=SECRETSIG", headers_factory=no_auth)
    assert err.value.response.status_code == 401
    assert len(http.calls) == 2
    assert "SECRETSIG" not in str(err.value) and "h.invalid/x" in str(err.value)


def test_429_honours_retry_after_seconds(http, clock):
    http.add("PUT", "x", make_response(429, headers={"Retry-After": "7"}), make_response(201))
    resp = speech_rest.request_with_retry("PUT", "https://h.invalid/x", headers_factory=no_auth, json={"a": 1})
    assert resp.status_code == 201 and clock.sleeps == [7.0]


def test_429_honours_retry_after_http_date(http, clock):
    when = format_datetime(datetime.now(timezone.utc) + timedelta(seconds=30), usegmt=True)
    http.add("PUT", "x", make_response(429, headers={"Retry-After": when}), make_response(201))
    speech_rest.request_with_retry("PUT", "https://h.invalid/x", headers_factory=no_auth)
    assert len(clock.sleeps) == 1 and 27.0 <= clock.sleeps[0] <= 30.5


@pytest.mark.parametrize("value", ["0", "0.5", "garbage", None])
def test_429_waits_at_least_two_seconds(http, clock, value):
    headers = {"Retry-After": value} if value is not None else {}
    http.add("GET", "x", make_response(429, headers=headers), make_response(200))
    speech_rest.request_with_retry("GET", "https://h.invalid/x", headers_factory=no_auth)
    assert clock.sleeps == [2.0]


def test_429_retry_after_is_capped(http, clock):
    http.add("GET", "x", make_response(429, headers={"Retry-After": "3600"}), make_response(200))
    speech_rest.request_with_retry("GET", "https://h.invalid/x", headers_factory=no_auth)
    assert clock.sleeps == [speech_rest.MAX_RETRY_AFTER_SEC]


def test_transient_5xx_and_408_back_off_exponentially(http, clock):
    http.add("GET", "x", make_response(503), make_response(502), make_response(408),
             make_response(500), make_response(504), make_response(200))
    speech_rest.request_with_retry("GET", "https://h.invalid/x", headers_factory=no_auth)
    assert clock.sleeps == [1.0, 2.0, 4.0, 8.0, 16.0]


def test_backoff_is_capped_at_thirty_seconds_and_attempts_are_bounded(http, clock):
    http.add("GET", "x", make_response(503))
    with pytest.raises(requests.HTTPError) as err:
        speech_rest.request_with_retry("GET", "https://h.invalid/x", headers_factory=no_auth, max_attempts=8)
    assert err.value.response.status_code == 503
    assert len(http.calls) == 8
    assert clock.sleeps == [1.0, 2.0, 4.0, 8.0, 16.0, 30.0, 30.0]


def test_backoff_is_jittered_within_bounds(monkeypatch):
    monkeypatch.setattr(speech_rest, "_jitter", lambda a, b: b)
    assert speech_rest.backoff_seconds(0) == pytest.approx(1.25)
    assert speech_rest.backoff_seconds(10) == 30.0
    monkeypatch.setattr(speech_rest, "_jitter", lambda a, b: a)
    assert speech_rest.backoff_seconds(2) == pytest.approx(3.0)


def test_non_retryable_status_raises_immediately(http, clock):
    http.add("POST", "x", make_response(400, json_body={"error": {"message": "bad"}}))
    with pytest.raises(requests.HTTPError) as err:
        speech_rest.request_with_retry("POST", "https://h.invalid/x", headers_factory=no_auth)
    assert err.value.response.status_code == 400 and len(http.calls) == 1 and clock.sleeps == []


def test_custom_retry_statuses(http, clock):
    http.add("GET", "x", make_response(429, headers={"Retry-After": "5"}))
    with pytest.raises(requests.HTTPError):
        speech_rest.request_with_retry("GET", "https://h.invalid/x", headers_factory=no_auth,
                                       retry_statuses=(500,))
    assert len(http.calls) == 1


def test_connection_error_is_retried(http, clock):
    http.add("GET", "x", requests.ConnectionError("boom"), requests.Timeout("slow"), make_response(200))
    resp = speech_rest.request_with_retry("GET", "https://h.invalid/x", headers_factory=no_auth)
    assert resp.status_code == 200 and clock.sleeps == [1.0, 2.0]


def test_exhausted_connection_errors_are_redacted_and_unchained(http, clock):
    http.add("GET", "blob", requests.ConnectionError(f"Max retries exceeded with url: {SAS_URL}"))
    with pytest.raises(requests.ConnectionError) as err:
        speech_rest.request_with_retry("GET", SAS_URL, headers_factory=no_auth, max_attempts=3)
    assert len(http.calls) == 3
    assert "SECRETSIG" not in str(err.value) and "sig=" not in str(err.value)
    assert err.value.__cause__ is None and err.value.__context__ is None


def test_deadline_already_passed_makes_no_call(http, clock):
    http.add("GET", "x", make_response(200))
    with pytest.raises(TimeoutError):
        speech_rest.request_with_retry("GET", "https://h.invalid/x", headers_factory=no_auth,
                                       deadline=clock.now - 0.1)
    assert http.calls == []


def test_deadline_stops_a_wait_that_would_pass_it(http, clock):
    http.add("GET", "x", make_response(503))
    with pytest.raises(TimeoutError):
        speech_rest.request_with_retry("GET", "https://h.invalid/x", headers_factory=no_auth,
                                       deadline=clock.now + 2.5)
    # attempt 1 (t+0) -> wait 1 s -> attempt 2 (t+1) -> wait 2 s would end at t+3 > deadline.
    assert len(http.calls) == 2 and clock.sleeps == [1.0]


def test_retry_after_past_the_deadline_raises_without_waiting(http, clock):
    http.add("PUT", "x", make_response(429, headers={"Retry-After": "55"}))
    with pytest.raises(TimeoutError):
        speech_rest.request_with_retry("PUT", "https://h.invalid/x", headers_factory=no_auth,
                                       deadline=clock.now + 30)
    assert len(http.calls) == 1 and clock.sleeps == []


def test_request_timeout_is_capped_by_the_deadline(http, clock):
    http.add("GET", "x", make_response(200))
    speech_rest.request_with_retry("GET", "https://h.invalid/x", headers_factory=no_auth,
                                   timeout=30, deadline=clock.now + 5)
    assert http.calls[0]["timeout"] == pytest.approx(5.0)
    speech_rest.request_with_retry("GET", "https://h.invalid/x", headers_factory=no_auth,
                                   timeout=30, deadline=clock.now + 0.2)
    assert http.calls[1]["timeout"] == speech_rest.MIN_REQUEST_TIMEOUT_SEC
    speech_rest.request_with_retry("GET", "https://h.invalid/x", headers_factory=no_auth,
                                   timeout=(10, 90), deadline=clock.now + 40)
    assert http.calls[2]["timeout"] == (10.0, 40.0)
    speech_rest.request_with_retry("GET", "https://h.invalid/x", headers_factory=no_auth, timeout=(10, 90))
    assert http.calls[3]["timeout"] == (10, 90)


def test_hooks_run_before_each_attempt_and_on_throttle_owns_the_wait(http, clock):
    before: list[float] = []
    throttled: list[float] = []
    http.add("PUT", "x", make_response(429, headers={"Retry-After": "55"}), make_response(503),
             make_response(201))
    speech_rest.request_with_retry(
        "PUT", "https://h.invalid/x", headers_factory=no_auth,
        before_attempt=lambda: before.append(clock.now), on_throttle=throttled.append,
    )
    assert throttled == [55.0]
    assert len(before) == 3
    assert clock.sleeps == [1.0]  # only the 503 backoff; the 429 wait is delegated


def test_retry_logs_never_contain_secrets(http, clock, caplog):
    caplog.set_level(logging.DEBUG)
    http.add("GET", "blob", make_response(503), requests.ConnectionError(SAS_URL), make_response(401),
             make_response(200))
    speech_rest.request_with_retry("GET", SAS_URL,
                                   headers_factory=lambda r: {"Authorization": "Bearer TOKEN-SECRET"})
    assert "SECRETSIG" not in caplog.text and "sig=" not in caplog.text
    assert "TOKEN-SECRET" not in caplog.text
    assert "acct.blob.core.windows.net/out/clip.mp4" in caplog.text


def test_retry_after_parsing():
    assert speech_rest.retry_after_seconds("12") == 12.0
    assert speech_rest.retry_after_seconds(" 1.5 ") == 1.5
    assert speech_rest.retry_after_seconds("-3") is None
    assert speech_rest.retry_after_seconds("nan") is None
    assert speech_rest.retry_after_seconds("") is None
    assert speech_rest.retry_after_seconds("Wed, 21 Oct 2015 07:28:00 GMT") == 0.0
    future = format_datetime(datetime.now(timezone.utc) + timedelta(seconds=90), usegmt=True)
    assert 85 <= speech_rest.retry_after_seconds(future) <= 90.5


def test_redact_url_drops_query_and_userinfo():
    assert speech_rest.redact_url(SAS_URL) == "acct.blob.core.windows.net/out/clip.mp4"
    assert speech_rest.redact_url("https://user:pw@h.invalid/p?q=1#f") == "h.invalid/p"


# ---------------------------------------------------------------------------
# Download
# ---------------------------------------------------------------------------

def test_download_streams_atomically(http, clock, tmp_path):
    http.add("GET", "blob", make_response(200, b"x" * 200_000))
    out = speech_rest.download_to(SAS_URL, tmp_path / "sub" / "clip.mp4")
    assert out.read_bytes() == b"x" * 200_000
    assert http.calls[0]["stream"] is True and http.calls[0]["headers"] == {}
    assert not list(tmp_path.rglob("*.part"))


def test_download_retries_an_interrupted_body(http, clock, tmp_path):
    broken = make_response(200, b"partial")

    def explode(*_a, **_k):
        raise requests.exceptions.ChunkedEncodingError("cut")

    broken.iter_content = explode
    http.add("GET", "blob", broken, make_response(200, b"complete"))
    out = speech_rest.download_to(SAS_URL, tmp_path / "clip.mp4")
    assert out.read_bytes() == b"complete" and len(http.calls) == 2
    assert not list(tmp_path.glob("*.part"))


def test_download_failure_leaves_no_file(http, clock, tmp_path):
    http.add("GET", "blob", make_response(404))
    with pytest.raises(requests.HTTPError) as err:
        speech_rest.download_to(SAS_URL, tmp_path / "clip.mp4")
    assert "SECRETSIG" not in str(err.value)
    assert list(tmp_path.iterdir()) == []


# ---------------------------------------------------------------------------
# Auth: AAD token, aad_header, STS
# ---------------------------------------------------------------------------

class FakeCredential:
    def __init__(self, *outcomes) -> None:
        self.outcomes = list(outcomes)
        self.calls = 0

    def get_token(self, scope):
        assert scope == speech_rest.SPEECH_SCOPE
        self.calls += 1
        item = self.outcomes.pop(0) if len(self.outcomes) > 1 else self.outcomes[0]
        if isinstance(item, BaseException):
            raise item
        return item


def _token(value: str, ttl: float = 3600.0):
    import time

    return SimpleNamespace(token=value, expires_on=int(time.time() + ttl))


def test_aad_token_retries_once_on_a_transient_credential_failure(monkeypatch, clock):
    from azure.identity import CredentialUnavailableError

    cred = FakeCredential(CredentialUnavailableError("Failed to invoke the Azure Developer CLI"), _token("AAD-1"))
    monkeypatch.setattr(speech_rest, "_credential", cred)
    assert speech_rest.aad_token() == "AAD-1"
    assert cred.calls == 2 and clock.sleeps == [speech_rest.AAD_RETRY_DELAY_SEC]


def test_aad_token_gives_up_after_the_second_failure(monkeypatch, clock):
    from azure.core.exceptions import ClientAuthenticationError

    cred = FakeCredential(ClientAuthenticationError("nope"))
    monkeypatch.setattr(speech_rest, "_credential", cred)
    with pytest.raises(ClientAuthenticationError):
        speech_rest.aad_token()
    assert cred.calls == 2


def test_aad_token_is_cached_until_close_to_expiry(monkeypatch, clock):
    cred = FakeCredential(_token("AAD-1"), _token("AAD-2"))
    monkeypatch.setattr(speech_rest, "_credential", cred)
    assert speech_rest.aad_token() == "AAD-1"
    assert speech_rest.aad_token() == "AAD-1" and cred.calls == 1
    assert speech_rest.aad_token(force_refresh=True) == "AAD-2" and cred.calls == 2

    short = FakeCredential(_token("SHORT-1", ttl=60), _token("SHORT-2", ttl=60))
    speech_rest.reset_auth_cache()
    monkeypatch.setattr(speech_rest, "_credential", short)
    assert speech_rest.aad_token() == "SHORT-1"
    assert speech_rest.aad_token() == "SHORT-2"  # expires within the refresh margin


def test_aad_header_matches_the_avatar_rule(monkeypatch):
    monkeypatch.setattr(speech_rest, "aad_token", lambda force_refresh=False: "AAD-R" if force_refresh else "AAD")
    assert speech_rest.aad_header(make_cfg(speech_key="k")) == {"Ocp-Apim-Subscription-Key": "k"}
    mi = make_cfg(use_managed_identity=True, speech_key="ignored")
    assert speech_rest.aad_header(mi) == {"Authorization": "Bearer AAD"}
    assert speech_rest.aad_header(mi, force_refresh=True) == {"Authorization": "Bearer AAD-R"}


ENDPOINT = "https://res.cognitiveservices.azure.com"


def test_sts_header_uses_the_key_without_managed_identity(http):
    assert speech_rest.sts_header(make_cfg(speech_key="k")) == {"Ocp-Apim-Subscription-Key": "k"}
    assert http.calls == []


@pytest.mark.parametrize("endpoint", ["", "not a url",
                                      "https://swedencentral.api.cognitive.microsoft.com",
                                      "https://swedencentral.tts.speech.microsoft.com/"])
def test_sts_header_needs_the_custom_domain_endpoint(http, endpoint):
    with pytest.raises(speech_rest.SpeechAuthError):
        speech_rest.sts_header(make_cfg(use_managed_identity=True, speech_endpoint=endpoint))
    assert http.calls == []


def test_sts_token_is_issued_once_and_cached_per_endpoint(http, clock, monkeypatch):
    monkeypatch.setattr(speech_rest, "aad_token", lambda force_refresh=False: "AAD")
    tokens = iter(["STS-1", "STS-2", "STS-3"])
    http.add("POST", r"/sts/v1\.0/issuetoken$", lambda call: make_response(200, next(tokens)))
    cfg = make_cfg(use_managed_identity=True, speech_endpoint=ENDPOINT + "/", speech_key="")
    assert speech_rest.sts_header(cfg) == {"Authorization": "Bearer STS-1"}
    assert speech_rest.sts_header(cfg) == {"Authorization": "Bearer STS-1"}
    assert http.urls() == [ENDPOINT + "/sts/v1.0/issuetoken"]
    assert http.calls[0]["headers"]["Authorization"] == "Bearer AAD"

    other = make_cfg(use_managed_identity=True, speech_endpoint="https://other.cognitiveservices.azure.com")
    assert speech_rest.sts_header(other) == {"Authorization": "Bearer STS-2"}

    clock.now += speech_rest.STS_TOKEN_TTL_SEC + 1
    assert speech_rest.sts_header(cfg) == {"Authorization": "Bearer STS-3"}
    assert len(http.calls) == 3


def test_sts_force_refresh_reissues(http, clock, monkeypatch):
    monkeypatch.setattr(speech_rest, "aad_token", lambda force_refresh=False: "AAD")
    tokens = iter(["STS-1", "STS-2"])
    http.add("POST", "issuetoken", lambda call: make_response(200, next(tokens)))
    cfg = make_cfg(use_managed_identity=True, speech_endpoint=ENDPOINT)
    assert speech_rest.sts_header(cfg)["Authorization"] == "Bearer STS-1"
    assert speech_rest.sts_header(cfg, force_refresh=True)["Authorization"] == "Bearer STS-2"


def test_sts_issue_refreshes_the_aad_token_on_401(http, clock, monkeypatch):
    seen: list[bool] = []

    def fake_aad(force_refresh: bool = False) -> str:
        seen.append(force_refresh)
        return "AAD-NEW" if force_refresh else "AAD-OLD"

    monkeypatch.setattr(speech_rest, "aad_token", fake_aad)
    http.add("POST", "issuetoken", make_response(401), make_response(200, "STS"))
    cfg = make_cfg(use_managed_identity=True, speech_endpoint=ENDPOINT)
    assert speech_rest.sts_header(cfg) == {"Authorization": "Bearer STS"}
    assert seen == [False, True]


def test_empty_sts_token_is_an_auth_error(http, clock, monkeypatch):
    monkeypatch.setattr(speech_rest, "aad_token", lambda force_refresh=False: "AAD")
    http.add("POST", "issuetoken", make_response(200, "  "))
    with pytest.raises(speech_rest.SpeechAuthError):
        speech_rest.sts_header(make_cfg(use_managed_identity=True, speech_endpoint=ENDPOINT))


def test_tts_401_refreshes_the_sts_token(http, clock, monkeypatch):
    monkeypatch.setattr(speech_rest, "aad_token", lambda force_refresh=False: "AAD")
    tokens = iter(["STS-OLD", "STS-NEW"])
    http.add("POST", "issuetoken", lambda call: make_response(200, next(tokens)))
    http.add("POST", r"tts\.speech\.microsoft\.com", make_response(401), make_response(200, b"RIFF"))
    cfg = make_cfg(use_managed_identity=True, speech_endpoint=ENDPOINT)
    speech_rest.request_with_retry(
        "POST", "https://swedencentral.tts.speech.microsoft.com/cognitiveservices/v1",
        headers_factory=lambda refresh: speech_rest.sts_header(cfg, force_refresh=refresh), data=b"<speak/>",
    )
    tts_auth = [c["headers"]["Authorization"] for c in http.calls if "tts.speech" in c["url"]]
    assert tts_auth == ["Bearer STS-OLD", "Bearer STS-NEW"]


def test_env_int_clamps_and_defaults(monkeypatch):
    monkeypatch.setenv("SPEECH_TEST_INT", "99")
    assert speech_rest.env_int("SPEECH_TEST_INT", 4, 1, 16) == 16
    monkeypatch.setenv("SPEECH_TEST_INT", "0")
    assert speech_rest.env_int("SPEECH_TEST_INT", 4, 1, 16) == 1
    monkeypatch.setenv("SPEECH_TEST_INT", "abc")
    assert speech_rest.env_int("SPEECH_TEST_INT", 4, 1, 16) == 4
    monkeypatch.delenv("SPEECH_TEST_INT")
    assert speech_rest.env_int("SPEECH_TEST_INT", 4, 1, 16) == 4
