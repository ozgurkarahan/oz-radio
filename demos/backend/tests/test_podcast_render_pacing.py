"""services.podcast_render: job-creation pacing, admission, the shared batch-job
helper and ``render_podcast`` on top of it.

HTTP is faked by patching ``requests.request`` with a stateful fake of the batch
avatar API; time is a fake clock shared by speech_rest, the pacer and the poll
loop. No Azure call is made.
"""
from __future__ import annotations

import inspect
import json
import logging
import re
import threading
import time
from types import SimpleNamespace

import pytest
import requests

from config import AzureConfig
from services import avatar_registry, speech_rest
from services import podcast_render as pr
from services.podcast_models import DialogueTurn, RenderRoles, RoleConfig, Script

SENTINEL = "Zebracorp-Sentinel-Sofia"
SENTINEL_MALE = "Zebracorp-Sentinel-Lucas"
SAS = "sv=2024&sig=SECRETSIG"
FORBIDDEN = ("Zebracorp", "Sentinel", "SECRETSIG", "sig=")


def make_cfg() -> AzureConfig:
    return AzureConfig(speech_endpoint="", speech_key="test-key", speech_region="swedencentral",
                       speech_resource_id="", openai_endpoint="", openai_key="", openai_chat_deployment="",
                       openai_embedding_deployment="", use_managed_identity=False)


def make_response(status: int = 200, body: bytes = b"", headers: dict | None = None,
                  json_body: object = None) -> requests.Response:
    resp = requests.Response()
    resp.status_code = status
    resp._content = json.dumps(json_body).encode() if json_body is not None else body
    resp._content_consumed = True
    resp.headers = requests.structures.CaseInsensitiveDict(headers or {})
    resp.reason = "fake"
    resp.encoding = "utf-8"
    resp.url = "https://fake.invalid/"
    return resp


class FakeClock:
    def __init__(self, start: float = 1000.0) -> None:
        self.now = start
        self.lock = threading.Lock()

    def monotonic(self) -> float:
        with self.lock:
            return self.now

    def sleep(self, seconds: float) -> None:
        with self.lock:
            self.now += max(0.0, seconds)
        time.sleep(0)


def character(job: dict) -> str:
    return job["payload"]["avatarConfig"]["talkingAvatarCharacter"]


def ssml_of(job: dict) -> str:
    return job["payload"]["inputs"][0]["content"]


class FakeBatchService:
    """Stateful fake of ``/avatar/batchsyntheses`` + the output blobs."""

    JOB_RE = re.compile(r"/avatar/batchsyntheses/([0-9a-f-]{36})\?api-version=2024-08-01$")
    BLOB_RE = re.compile(r"^https://blob\.example/out/([0-9a-f-]{36})\.(mp4|vtt)\?")

    def __init__(self, clock: FakeClock) -> None:
        self.clock = clock
        self.lock = threading.Lock()
        self.jobs: dict[str, dict] = {}
        self.events: list[tuple[str, str, float]] = []  # (method, job id, time)
        self.put_script: list = []
        self.polls_to_finish = 2
        self.never_finish = False
        self.fail = lambda job: None  # -> error message for a Failed job
        self.with_vtt = False

    def __call__(self, method, url, **kw):
        method = method.upper()
        with self.lock:
            m = self.JOB_RE.search(url)
            if m:
                jid = m.group(1)
                self.events.append((method, jid, self.clock.now))
                if method == "PUT":
                    return self._put(jid, kw)
                if method == "GET":
                    return self._get(jid)
                if method == "DELETE":
                    return make_response(204)
            m = self.BLOB_RE.search(url)
            if m and method == "GET" and kw.get("headers") == {}:
                self.events.append(("DOWNLOAD", m.group(1), self.clock.now))
                return make_response(200, body=f"{m.group(2)}:{m.group(1)}".encode())
        raise AssertionError(f"unexpected request {method} {url}")

    def _put(self, jid: str, kw: dict) -> requests.Response:
        assert kw["headers"]["Ocp-Apim-Subscription-Key"] == "test-key"
        if self.put_script:
            item = self.put_script.pop(0)
            if item == "create-and-drop":
                self.jobs[jid] = {"payload": kw["json"], "polls": 0}
                raise requests.ConnectionError("connection reset")
            if isinstance(item, BaseException):
                raise item
            return item
        if jid in self.jobs:
            return make_response(409, json_body={"error": {"code": "Conflict", "message": "exists"}})
        self.jobs[jid] = {"payload": kw["json"], "polls": 0}
        return make_response(201, json_body=self._body(jid, "NotStarted"))

    def _get(self, jid: str) -> requests.Response:
        job = self.jobs[jid]
        job["polls"] += 1
        if self.never_finish or job["polls"] < self.polls_to_finish:
            return make_response(200, json_body=self._body(jid, "Running"))
        error = self.fail(job)
        return make_response(200, json_body=self._body(jid, "Failed" if error else "Succeeded", error))

    def _body(self, jid: str, status: str, error: str | None = None) -> dict:
        body: dict = {
            "id": jid, "status": status,
            # Like the real service: the status payload echoes the character name.
            "avatarConfig": {"talkingAvatarCharacter": character(self.jobs[jid]), "customized": True},
            "properties": {"timeToLiveInHours": 24},
        }
        if status == "Succeeded":
            body["properties"].update({"durationInMilliseconds": 4200,
                                       "billingDetails": {"talkingAvatarDurationSeconds": 4}})
            body["outputs"] = {"result": f"https://blob.example/out/{jid}.mp4?{SAS}",
                               "summary": f"https://blob.example/out/{jid}.json?{SAS}"}
            if self.with_vtt:
                body["outputs"]["subtitles"] = f"https://blob.example/out/{jid}.vtt?{SAS}"
        if status == "Failed":
            body["properties"]["error"] = {"code": "InvalidSsml", "message": error}
        return body

    def ssml(self, jid: str) -> str:
        return self.jobs[jid]["payload"]["inputs"][0]["content"]

    def of(self, method: str) -> list[tuple[str, float]]:
        return [(jid, t) for m, jid, t in self.events if m == method]


class RecordingPacer(pr.BatchCreatePacer):
    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self.acquired: list[float] = []
        self.holds: list[float] = []

    def acquire(self, deadline=None, *, cancel=None) -> None:
        super().acquire(deadline, cancel=cancel)
        self.acquired.append(self._clock())

    def hold(self, seconds: float) -> None:
        self.holds.append(seconds)
        super().hold(seconds)


ENTRY = avatar_registry.AvatarEntry(
    id="photo_test", foundry_name=SENTINEL, display_name="Photo", gender="female", customized=True,
    photo_base_model="vasa-1", default_style="", supports_gestures=False, video_format="mp4",
    video_codec="h264", background_color="#00FF00FF", chroma_key=True, thumbnail_url="",
)


@pytest.fixture
def batch(monkeypatch):
    clock = FakeClock()
    monkeypatch.setattr(speech_rest, "_monotonic", clock.monotonic)
    monkeypatch.setattr(speech_rest, "_sleep", clock.sleep)
    monkeypatch.setattr(speech_rest, "_jitter", lambda a, b: 1.0)
    service = FakeBatchService(clock)
    monkeypatch.setattr(requests, "request", service)
    pacer = RecordingPacer(per_window=2, margin_sec=0)
    monkeypatch.setattr(pr, "BATCH_CREATE_PACER", pacer)
    monkeypatch.setattr(pr, "BATCH_ADMISSION", pr.BatchAdmission())
    return SimpleNamespace(clock=clock, service=service, pacer=pacer, cfg=make_cfg())


def assert_clean(text: str) -> None:
    for word in FORBIDDEN:
        assert word not in text, word


# ---------------------------------------------------------------------------
# Pacer
# ---------------------------------------------------------------------------

def _pacer(clock: FakeClock, **kwargs) -> pr.BatchCreatePacer:
    kwargs.setdefault("margin_sec", 0)
    return pr.BatchCreatePacer(clock=clock.monotonic, sleep=clock.sleep, **kwargs)


def test_pacer_allows_two_creations_per_rolling_minute():
    clock = FakeClock(0.0)
    pacer = _pacer(clock, per_window=2, window_sec=60)
    times = []
    for _ in range(5):
        pacer.acquire()
        times.append(clock.now)
    assert times == [0.0, 0.0, 60.0, 60.0, 120.0]


def test_pacer_window_slides_from_each_creation():
    clock = FakeClock(0.0)
    pacer = _pacer(clock, per_window=2, window_sec=60)
    pacer.acquire()
    clock.now = 50.0
    pacer.acquire()
    pacer.acquire()  # first slot frees at 60
    assert clock.now == 60.0
    pacer.acquire()  # second slot frees at 110
    assert clock.now == 110.0


def test_pacer_default_keeps_a_safety_margin_and_reads_the_env(monkeypatch):
    clock = FakeClock(0.0)
    pacer = pr.BatchCreatePacer(clock=clock.monotonic, sleep=clock.sleep)
    for _ in range(3):
        pacer.acquire()
    assert clock.now == pytest.approx(pr.BATCH_CREATE_WINDOW_SEC + pr.BATCH_CREATE_MARGIN_SEC)
    monkeypatch.setenv("SPEECH_BATCH_CREATE_PER_MIN", "3")
    clock2 = FakeClock(0.0)
    pacer2 = pr.BatchCreatePacer(clock=clock2.monotonic, sleep=clock2.sleep)
    for _ in range(3):
        pacer2.acquire()
    assert clock2.now == 0.0
    monkeypatch.setenv("SPEECH_BATCH_CREATE_PER_MIN", "nonsense")
    assert pr.batch_create_per_min() == pr.DEFAULT_BATCH_CREATE_PER_MIN == 2


def test_pacer_raises_instead_of_waiting_past_the_deadline():
    clock = FakeClock(0.0)
    pacer = _pacer(clock, per_window=2, window_sec=60)
    pacer.acquire()
    pacer.acquire()
    with pytest.raises(TimeoutError):
        pacer.acquire(deadline=30.0)
    assert clock.now == 0.0
    pacer.acquire(deadline=61.0)  # the failed attempt took no slot
    assert clock.now == 60.0


def test_pacer_hold_blocks_every_creator():
    clock = FakeClock(0.0)
    pacer = _pacer(clock, per_window=5, window_sec=60)
    pacer.hold(55)
    pacer.acquire()
    assert clock.now == 55.0


def test_pacer_honours_cancel():
    clock = FakeClock(0.0)
    pacer = _pacer(clock, per_window=1, window_sec=60)
    pacer.acquire()
    cancel = threading.Event()
    cancel.set()
    with pytest.raises(pr.BatchJobCancelled):
        pacer.acquire(cancel=cancel)


# ---------------------------------------------------------------------------
# Admission
# ---------------------------------------------------------------------------

def test_admission_limits_active_jobs():
    admission = pr.BatchAdmission(limit=2)
    lock = threading.Lock()
    state = {"active": 0, "max": 0}
    go = threading.Event()

    def worker():
        admission.acquire()
        try:
            with lock:
                state["active"] += 1
                state["max"] = max(state["max"], state["active"])
            go.wait(5)
            with lock:
                state["active"] -= 1
        finally:
            admission.release()

    threads = [threading.Thread(target=worker) for _ in range(6)]
    for t in threads:
        t.start()
    until = time.monotonic() + 5
    while admission.active < 2 and time.monotonic() < until:
        time.sleep(0.005)
    time.sleep(0.05)  # the other four must stay blocked
    assert admission.active == 2 and state["active"] == 2
    go.set()
    for t in threads:
        t.join(10)
    assert state["max"] == 2 and admission.active == 0


def test_admission_deadline_and_cancel():
    clock = FakeClock(0.0)
    admission = pr.BatchAdmission(limit=1, clock=clock.monotonic)
    admission.acquire()
    with pytest.raises(TimeoutError):
        admission.acquire(deadline=0.0)
    cancel = threading.Event()
    cancel.set()
    with pytest.raises(pr.BatchJobCancelled):
        admission.acquire(cancel=cancel)
    admission.release()
    admission.acquire(deadline=0.0)
    assert admission.active == 1


def test_admission_limit_comes_from_the_env(monkeypatch):
    monkeypatch.setenv("MAX_ACTIVE_BATCH_JOBS", "3")
    assert pr.max_active_batch_jobs() == 3
    monkeypatch.delenv("MAX_ACTIVE_BATCH_JOBS")
    assert pr.max_active_batch_jobs() == pr.DEFAULT_MAX_ACTIVE_BATCH_JOBS == 8


# ---------------------------------------------------------------------------
# run_batch_avatar_job
# ---------------------------------------------------------------------------

SSML = '<speak version="1.0"><voice name="v"><break time="250ms"/>Hi.</voice></speak>'


def test_batch_job_happy_path(batch, tmp_path, caplog):
    caplog.set_level(logging.DEBUG)
    result = pr.run_batch_avatar_job(batch.cfg, SSML, ENTRY, tmp_path / "kit.mp4", label="listener kit",
                                     poll_interval=5, avatar_config_overrides={"subtitleType": "none"})
    (jid, put_at), = batch.service.of("PUT")
    assert result == pr.BatchJobResult(video_path=tmp_path / "kit.mp4", duration_sec=4.2, vtt_path=None,
                                       billed_seconds=4.0)
    assert result.video_path.read_bytes() == f"mp4:{jid}".encode()
    payload = batch.service.jobs[jid]["payload"]
    assert payload["inputKind"] == "SSML" and payload["inputs"] == [{"content": SSML}]
    assert payload["avatarConfig"]["talkingAvatarCharacter"] == SENTINEL  # sent to Azure only
    assert payload["avatarConfig"]["subtitleType"] == "none"
    assert payload["avatarConfig"]["backgroundColor"] == "#00FF00FF"
    gets = batch.service.of("GET")
    assert len(gets) == 2 and gets[1][1] - gets[0][1] == pytest.approx(5.0)
    assert batch.pacer.acquired == [put_at]
    assert batch.service.of("DELETE") == [] and pr.BATCH_ADMISSION.active == 0
    assert_clean(caplog.text)
    assert "listener kit" in caplog.text and "photo_test" in caplog.text
    assert not list(tmp_path.glob("*.part"))


def test_batch_job_downloads_subtitles_when_exposed(batch, tmp_path):
    batch.service.with_vtt = True
    result = pr.run_batch_avatar_job(batch.cfg, SSML, ENTRY, tmp_path / "turn_000.mp4", label="turn 0",
                                     poll_interval=1)
    assert result.vtt_path == tmp_path / "turn_000.vtt"
    assert result.vtt_path.read_text().startswith("vtt:")


def test_failed_job_raises_a_redacted_error(batch, tmp_path, caplog):
    caplog.set_level(logging.DEBUG)
    batch.service.fail = lambda job: f"Avatar {character(job)} cannot render. See https://docs.example/x?{SAS}"
    with pytest.raises(pr.BatchJobError) as err:
        pr.run_batch_avatar_job(batch.cfg, SSML, ENTRY, tmp_path / "kit.mp4", label="turn 4", poll_interval=1)
    message = str(err.value)
    assert message.startswith("turn 4: InvalidSsml: Avatar <avatar> cannot render") and "<url>" in message
    assert_clean(message)
    assert_clean(caplog.text)
    assert batch.service.of("DELETE") == []  # terminal job: nothing left running
    assert pr.BATCH_ADMISSION.active == 0 and not (tmp_path / "kit.mp4").exists()


def test_deadline_deletes_the_running_job(batch, tmp_path, caplog):
    caplog.set_level(logging.DEBUG)
    batch.service.never_finish = True
    deadline = batch.clock.now + 12
    with pytest.raises(TimeoutError) as err:
        pr.run_batch_avatar_job(batch.cfg, SSML, ENTRY, tmp_path / "kit.mp4", label="kit", poll_interval=5,
                                deadline=deadline)
    assert not isinstance(err.value, pr.BatchPollTimeout)
    (jid, _), = batch.service.of("PUT")
    assert [j for j, _ in batch.service.of("DELETE")] == [jid]
    assert len(batch.service.of("GET")) == 3  # t+0, t+5, t+10; t+15 would pass the deadline
    assert batch.clock.now <= deadline
    assert pr.BATCH_ADMISSION.active == 0 and not (tmp_path / "kit.mp4").exists()
    assert_clean(caplog.text)


def test_poll_timeout_is_a_distinct_timeout(batch, tmp_path):
    batch.service.never_finish = True
    with pytest.raises(pr.BatchPollTimeout):
        pr.run_batch_avatar_job(batch.cfg, SSML, ENTRY, tmp_path / "kit.mp4", label="kit", poll_interval=5,
                                poll_timeout=7)
    assert len(batch.service.of("DELETE")) == 1 and pr.BATCH_ADMISSION.active == 0


def test_deadline_while_waiting_for_the_pacer_submits_nothing(batch, tmp_path):
    pr.run_batch_avatar_job(batch.cfg, SSML, ENTRY, tmp_path / "a.mp4", label="a", poll_interval=1)
    pr.run_batch_avatar_job(batch.cfg, SSML, ENTRY, tmp_path / "b.mp4", label="b", poll_interval=1)
    with pytest.raises(TimeoutError):
        pr.run_batch_avatar_job(batch.cfg, SSML, ENTRY, tmp_path / "c.mp4", label="c", poll_interval=1,
                                deadline=batch.clock.now + 30)
    assert len(batch.service.of("PUT")) == 2
    assert batch.service.of("DELETE") == [] and pr.BATCH_ADMISSION.active == 0


def test_429_on_create_holds_the_pacer_then_retries(batch, tmp_path):
    batch.service.put_script = [make_response(429, headers={"Retry-After": "55"})]
    result = pr.run_batch_avatar_job(batch.cfg, SSML, ENTRY, tmp_path / "kit.mp4", label="kit", poll_interval=1)
    puts = batch.service.of("PUT")
    assert len(puts) == 2 and puts[1][1] - puts[0][1] >= 55.0
    assert batch.pacer.holds == [55.0] and len(batch.pacer.acquired) == 2
    assert result.video_path.exists()


def test_lost_create_response_is_adopted(batch, tmp_path):
    batch.service.put_script = ["create-and-drop"]
    result = pr.run_batch_avatar_job(batch.cfg, SSML, ENTRY, tmp_path / "kit.mp4", label="kit", poll_interval=1)
    puts = batch.service.of("PUT")
    assert len(puts) == 2 and puts[0][0] == puts[1][0]
    assert result.video_path.exists() and batch.service.of("DELETE") == []


def test_http_error_on_create_is_wrapped_and_redacted(batch, tmp_path):
    batch.service.put_script = [make_response(400, json_body={
        "error": {"code": "InvalidArgument", "message": f"Unknown character {SENTINEL} ({SAS})"}})]
    with pytest.raises(pr.BatchJobError) as err:
        pr.run_batch_avatar_job(batch.cfg, SSML, ENTRY, tmp_path / "kit.mp4", label="kit")
    assert str(err.value).startswith("kit: HTTP 400: Unknown character <avatar>")
    assert_clean(str(err.value))
    assert err.value.__cause__ is None
    assert batch.service.of("DELETE") == [] and pr.BATCH_ADMISSION.active == 0


def test_cancelled_before_submission_makes_no_call(batch, tmp_path):
    cancel = threading.Event()
    cancel.set()
    with pytest.raises(pr.BatchJobCancelled):
        pr.run_batch_avatar_job(batch.cfg, SSML, ENTRY, tmp_path / "kit.mp4", label="kit", cancel=cancel)
    assert batch.service.events == [] and pr.BATCH_ADMISSION.active == 0


def test_legacy_retry_wrapper_still_works(batch):
    batch.service.put_script = [make_response(503), make_response(201)]
    url = pr.batch_job_url(batch.cfg, "0" * 8 + "-0000-0000-0000-" + "0" * 12)
    resp = pr._request_with_429_retry("PUT", url, headers={"Ocp-Apim-Subscription-Key": "test-key"},
                                      json_body={})
    assert resp.status_code == 201


# ---------------------------------------------------------------------------
# render_podcast
# ---------------------------------------------------------------------------

def make_script() -> Script:
    return Script(id="s1", document_id="d1", language="en-US", turns=[
        DialogueTurn(idx=1, speaker="expert", text="First point here. Second point there. Third one."),
        DialogueTurn(idx=0, speaker="interviewer", text="Welcome to the show. Let's start."),
        DialogueTurn(idx=2, speaker="interviewer", text="Thanks for joining."),
    ])


def make_roles(interviewer: str = "lisa", expert: str = "harry") -> RenderRoles:
    return RenderRoles(
        interviewer=RoleConfig(display_name="Sofia", avatar=interviewer, voice="en-US-Ava:DragonHDLatestNeural"),
        expert=RoleConfig(display_name="Lucas", avatar=expert, voice="en-US-Andrew:DragonHDLatestNeural"),
    )


def _job_for(service: FakeBatchService, needle: str) -> str:
    (jid,) = [j for j in service.jobs if needle in service.ssml(j)]
    return jid


def test_render_paces_creation_polls_concurrently_and_passes_pauses(batch, tmp_path, monkeypatch):
    monkeypatch.setenv("MAX_ACTIVE_BATCH_JOBS", "3")
    progress: list[int] = []
    clips = pr.render_podcast(batch.cfg, make_script(), make_roles(), progress.append, "en-US",
                              work_dir=tmp_path, poll_interval=5, pauses={1: {1: 700}, 7: {1: 500}})
    assert [c.turn_idx for c in clips] == [0, 1, 2]
    assert [c.avatar_id for c in clips] == ["lisa", "harry", "lisa"]
    assert [c.speaker for c in clips] == ["interviewer", "expert", "interviewer"]
    assert all(c.chroma_key is False and c.duration_sec == 4.2 for c in clips)
    assert [c.blob_url for c in clips] == [str(tmp_path / f"turn_{i:03d}.webm") for i in range(3)]
    assert all((tmp_path / f"turn_{i:03d}.webm").read_bytes().startswith(b"mp4:") for i in range(3))
    assert progress == [1, 2, 3]

    service = batch.service
    expert_ssml = service.ssml(_job_for(service, "First point"))
    assert 'First point here.<break time="700ms"/>Second point there. Third one.' in expert_ssml
    assert "en-US-Andrew:DragonHDLatestNeural" in expert_ssml
    for needle in ("Welcome", "Thanks"):
        assert '<break time="700ms"/>' not in service.ssml(_job_for(service, needle))

    puts = service.of("PUT")
    assert len(puts) == 3 and len(batch.pacer.acquired) == 3
    assert puts[2][1] - puts[0][1] >= 60.0  # 2 creations per rolling minute
    order = [m for m, _, _ in service.events]
    third_put = [i for i, m in enumerate(order) if m == "PUT"][2]
    assert "GET" in order[:third_put]  # polling started before the last creation
    assert pr.BATCH_ADMISSION.active == 0


def test_render_without_pauses_sends_the_legacy_ssml(batch, tmp_path, monkeypatch):
    from services.avatar import build_ssml

    pr.render_podcast(batch.cfg, make_script(), make_roles(), work_dir=tmp_path, poll_interval=1)
    service = batch.service
    assert service.ssml(_job_for(service, "First point")) == build_ssml(
        "First point here. Second point there. Third one.", "en-US", voice="en-US-Andrew:DragonHDLatestNeural")


def use_photo_avatars() -> RenderRoles:
    avatar_registry.reload(json.dumps([
        {"id": "photo_female", "character": SENTINEL, "gender": "female", "kind": "photo"},
        {"id": "photo_male", "character": SENTINEL_MALE, "gender": "male", "kind": "photo"},
    ]))
    return make_roles("photo_female", "photo_male")


def test_render_fails_loud_and_stops_submitting(batch, tmp_path, monkeypatch, caplog):
    caplog.set_level(logging.DEBUG)
    monkeypatch.setenv("MAX_ACTIVE_BATCH_JOBS", "1")
    roles = use_photo_avatars()
    batch.service.fail = lambda job: f"character {character(job)} failed" if "Welcome" in ssml_of(job) else None
    progress: list[int] = []
    with pytest.raises(RuntimeError) as err:
        pr.render_podcast(batch.cfg, make_script(), roles, progress.append, work_dir=tmp_path,
                          poll_interval=1)
    assert str(err.value) == ("1/3 avatar turns failed: turn 0: InvalidSsml: character <avatar> failed "
                              "(2 not rendered)")
    assert len(batch.service.of("PUT")) == 1 and progress == [1]
    assert_clean(caplog.text)
    assert pr.BATCH_ADMISSION.active == 0


def test_render_per_turn_timeout_is_a_turn_failure(batch, tmp_path, monkeypatch):
    monkeypatch.setenv("MAX_ACTIVE_BATCH_JOBS", "1")
    batch.service.never_finish = True
    with pytest.raises(RuntimeError) as err:
        pr.render_podcast(batch.cfg, make_script(), make_roles(), work_dir=tmp_path, timeout=7, poll_interval=5)
    assert "turn 0: timeout" in str(err.value)
    assert len(batch.service.of("DELETE")) == 1


def test_render_deadline_stops_new_submissions(batch, tmp_path, monkeypatch):
    monkeypatch.setenv("MAX_ACTIVE_BATCH_JOBS", "1")
    monkeypatch.setattr(pr, "BATCH_CREATE_PACER", RecordingPacer(per_window=1, margin_sec=0))
    with pytest.raises(TimeoutError):
        pr.render_podcast(batch.cfg, make_script(), make_roles(), work_dir=tmp_path, poll_interval=5,
                          deadline=batch.clock.now + 30)
    assert len(batch.service.of("PUT")) == 1  # turn 1 would be created at t+60 > deadline
    assert batch.service.of("DELETE") == [] and pr.BATCH_ADMISSION.active == 0


def test_render_deadline_deletes_jobs_still_running(batch, tmp_path, monkeypatch):
    monkeypatch.setenv("MAX_ACTIVE_BATCH_JOBS", "2")
    monkeypatch.setattr(pr, "BATCH_CREATE_PACER", RecordingPacer(per_window=10, margin_sec=0))
    batch.service.never_finish = True
    with pytest.raises(TimeoutError):
        pr.render_podcast(batch.cfg, make_script(), make_roles(), work_dir=tmp_path, poll_interval=5,
                          deadline=batch.clock.now + 20)
    created = {jid for jid, _ in batch.service.of("PUT")}
    assert created and {jid for jid, _ in batch.service.of("DELETE")} == created
    assert pr.BATCH_ADMISSION.active == 0


def test_render_deadline_already_passed_submits_nothing(batch, tmp_path):
    with pytest.raises(TimeoutError):
        pr.render_podcast(batch.cfg, make_script(), make_roles(), work_dir=tmp_path,
                          deadline=batch.clock.now - 1)
    assert batch.service.events == []


def test_render_with_photo_avatars_never_leaks_the_character_name(batch, tmp_path, caplog):
    caplog.set_level(logging.DEBUG)
    roles = use_photo_avatars()
    clips = pr.render_podcast(batch.cfg, make_script(), roles, work_dir=tmp_path, poll_interval=1)
    assert [c.avatar_id for c in clips] == ["photo_female", "photo_male", "photo_female"]
    assert all(c.chroma_key and c.blob_url.endswith(".mp4") for c in clips)
    names = " ".join(p.name for p in tmp_path.rglob("*"))
    assert_clean(names)
    assert_clean(caplog.text)
    assert_clean(json.dumps([c.model_dump() for c in clips]))


def test_render_podcast_signature_is_backward_compatible():
    params = inspect.signature(pr.render_podcast).parameters
    assert list(params)[:9] == ["cfg", "script", "roles", "progress_cb", "language", "work_dir", "timeout",
                                "poll_interval", "max_parallel"]
    assert params["pauses"].kind is inspect.Parameter.KEYWORD_ONLY and params["pauses"].default is None
    assert params["deadline"].kind is inspect.Parameter.KEYWORD_ONLY and params["deadline"].default is None
    # Names other modules import from here.
    for name in ("ClipManifest", "DialogueTurn", "RenderRoles", "RoleConfig", "Script", "RenderRequest"):
        assert hasattr(pr, name)
