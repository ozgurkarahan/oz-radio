"""Voice Q&A building blocks: PCM / frame validation, the speech-to-text call,
the durable daily question quota, the demo filter allow/deny matrix and the
session state machine (cancellation on disconnect)."""
from __future__ import annotations

import asyncio
import base64
import json
import struct

import httpx
import pytest

from config import load_config
from services import voice_questions as vq
from services.voice_questions import AudioCollector, QaError, QaOptions, QaSession


class Clock:
    def __init__(self, t: float = 100.0):
        self.t = t

    def __call__(self):
        return self.t


def _b64(n: int) -> str:
    return base64.b64encode(b"\x01\x00" * (n // 2)).decode()


# ---------------------------------------------------------------------------
# PCM / frames
# ---------------------------------------------------------------------------
def test_pcm_to_wav_header():
    wav = vq.pcm_to_wav(b"\x00\x01" * 100)
    assert wav[:4] == b"RIFF" and wav[8:12] == b"WAVE" and wav[36:40] == b"data"
    assert struct.unpack("<I", wav[4:8])[0] == 36 + 200
    channels, rate = struct.unpack("<HI", wav[22:28])
    assert channels == 1 and rate == 16000
    assert struct.unpack("<H", wav[34:36])[0] == 16
    assert len(wav) == 44 + 200


@pytest.mark.parametrize("audio", [
    None, 5, "", "!!!!", "AAAA\n", "AA AA", "AAA", "data:audio/pcm;base64,AAAA",
    _b64(16_386),                  # decoded > 16384
    base64.b64encode(b"\x01").decode(),   # odd byte count
    "A" * (vq.MAX_FRAME_B64_CHARS + 4),
])
def test_decode_frame_rejects(audio):
    with pytest.raises(QaError) as exc:
        vq.decode_frame(audio)
    assert exc.value.code == "bad_state"


def test_decode_frame_accepts_max_frame():
    assert len(vq.decode_frame(_b64(16_384))) == 16_384


def test_collector_strict_seq_and_total():
    clock = Clock()
    col = AudioCollector(max_bytes=8, clock=clock)
    col.add(0, _b64(4))
    with pytest.raises(QaError) as exc:
        col.add(2, _b64(2))
    assert exc.value.code == "bad_state"
    with pytest.raises(QaError):
        col.add(True, _b64(2))
    col.add(1, _b64(4))
    with pytest.raises(QaError) as exc:
        col.add(2, _b64(2))
    assert exc.value.code == "too_long"
    assert col.size == 8 and len(col.pcm()) == 8
    col.clear()
    assert col.pcm() == b""


def test_collector_default_limits_15_seconds():
    assert vq.MAX_AUDIO_BYTES == 480_000 and vq.MAX_AUDIO_MS == 15_000 and vq.MAX_FRAME_BYTES == 16_384


def test_collector_rate_bucket():
    clock = Clock()
    col = AudioCollector(rate=40, clock=clock)
    for seq in range(40):                 # burst of 40 frames is fine
        col.add(seq, _b64(2))
    with pytest.raises(QaError) as exc:   # the 41st in the same instant is not
        col.add(40, _b64(2))
    assert exc.value.code == "rate"
    clock.t += 0.05                       # refills 2 tokens
    col.add(40, _b64(2))


def test_invites_localised_with_english_fallback():
    assert vq.invite_text("fr-FR") == "Allez-y, je vous écoute."
    assert vq.invite_text("pt-BR").startswith("Pode falar")
    assert vq.invite_text("ko-KR") == vq.invite_text(None) == "Go ahead, I'm listening."
    for lang in ("en", "fr", "es", "de", "it", "pt", "zh", "ja"):
        assert vq.INVITES[lang]


# ---------------------------------------------------------------------------
# transcribe_pcm (mocked HTTP)
# ---------------------------------------------------------------------------
@pytest.fixture
def stt_cfg(monkeypatch):
    vq.reset_token_cache()
    monkeypatch.setattr(vq, "_aad_token", lambda: "aad-token")
    cfg = load_config()
    cfg.speech_endpoint = "https://res.cognitiveservices.azure.com/"
    cfg.speech_region = "swedencentral"
    cfg.speech_key = ""
    yield cfg
    vq.reset_token_cache()


def _transport(stt_response, calls):
    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if request.url.path == "/sts/v1.0/issuetoken":
            assert request.headers["authorization"] == "Bearer aad-token"
            return httpx.Response(200, text="speech-jwt")
        return stt_response(request)
    return httpx.MockTransport(handler)


def test_transcribe_success_uses_sts_token_and_caches_it(stt_cfg):
    calls: list[httpx.Request] = []
    ok = lambda req: httpx.Response(200, json={"RecognitionStatus": "Success", "DisplayText": "Quel\u00a0prix ?"})
    t = _transport(ok, calls)
    text = asyncio.run(vq.transcribe_pcm(stt_cfg, b"\x00\x00" * 1600, "fr-FR", transport=t))
    assert text == "Quel prix ?"
    stt = calls[-1]
    assert stt.url.host == "swedencentral.stt.speech.microsoft.com"
    assert stt.url.params["language"] == "fr-FR" and stt.url.params["format"] == "simple"
    assert stt.headers["authorization"] == "Bearer speech-jwt"
    assert stt.headers["content-type"] == "audio/wav; codecs=audio/pcm; samplerate=16000"
    assert stt.content[:4] == b"RIFF"
    # Second call reuses the cached STS token (no new issuetoken request).
    asyncio.run(vq.transcribe_pcm(stt_cfg, b"\x00\x00" * 1600, "fr-FR", transport=t))
    assert sum(1 for c in calls if c.url.path == "/sts/v1.0/issuetoken") == 1


def test_transcribe_key_path(stt_cfg):
    stt_cfg.speech_key = "k3y"
    calls: list[httpx.Request] = []
    ok = lambda req: httpx.Response(200, json={"RecognitionStatus": "Success", "DisplayText": "Hi"})
    asyncio.run(vq.transcribe_pcm(stt_cfg, b"\x00\x00", "xx-XX", transport=_transport(ok, calls)))
    assert len(calls) == 1 and calls[0].headers["ocp-apim-subscription-key"] == "k3y"
    assert calls[0].url.params["language"] == "en-US"


@pytest.mark.parametrize("body", [
    {"RecognitionStatus": "NoMatch"},
    {"RecognitionStatus": "InitialSilenceTimeout"},
    {"RecognitionStatus": "Success", "DisplayText": "  "},
])
def test_transcribe_no_speech(stt_cfg, body):
    t = _transport(lambda req: httpx.Response(200, json=body), [])
    with pytest.raises(QaError) as exc:
        asyncio.run(vq.transcribe_pcm(stt_cfg, b"\x00\x00", "en-US", transport=t))
    assert exc.value.code == "no_speech"


def test_transcribe_401_is_stt_failed_and_drops_token(stt_cfg):
    t = _transport(lambda req: httpx.Response(401, text="nope"), [])
    with pytest.raises(QaError) as exc:
        asyncio.run(vq.transcribe_pcm(stt_cfg, b"\x00\x00", "en-US", transport=t))
    assert exc.value.code == "stt_failed"
    assert vq._sts_cache == {}


def test_transcribe_timeout_is_stt_failed(stt_cfg):
    def boom(req):
        raise httpx.ReadTimeout("slow", request=req)
    with pytest.raises(QaError) as exc:
        asyncio.run(vq.transcribe_pcm(stt_cfg, b"\x00\x00", "en-US", transport=_transport(boom, [])))
    assert exc.value.code == "stt_failed"


def test_transcribe_sts_failure_and_missing_endpoint(stt_cfg):
    def handler(request):
        return httpx.Response(403, text="forbidden")
    with pytest.raises(QaError) as exc:
        asyncio.run(vq.transcribe_pcm(stt_cfg, b"\x00\x00", "en-US", transport=httpx.MockTransport(handler)))
    assert exc.value.code == "stt_failed"
    stt_cfg.speech_endpoint = ""
    with pytest.raises(QaError) as exc:
        asyncio.run(vq.transcribe_pcm(stt_cfg, b"\x00\x00", "en-US", transport=httpx.MockTransport(handler)))
    assert exc.value.code == "stt_failed"


def test_transcribe_truncates_and_rejects_empty_audio(stt_cfg):
    t = _transport(lambda req: httpx.Response(200, json={"RecognitionStatus": "Success", "DisplayText": "a" * 900}), [])
    assert len(asyncio.run(vq.transcribe_pcm(stt_cfg, b"\x00\x00", "en-US", transport=t))) == 500
    with pytest.raises(QaError) as exc:
        asyncio.run(vq.transcribe_pcm(stt_cfg, b"", "en-US", transport=t))
    assert exc.value.code == "no_speech"


# ---------------------------------------------------------------------------
# Durable daily question quota (same Cosmos doc / etag mechanism)
# ---------------------------------------------------------------------------
def _quota(store):
    from security import DemoQuota

    q = DemoQuota()
    q.set_store(store)
    return q


def test_question_quota_per_ip_and_global(monkeypatch):
    from test_demo_quota_durable import FakeStore

    monkeypatch.setenv("DEMO_QA_DAILY_MAX", "3")
    monkeypatch.setenv("DEMO_QA_DAILY_PER_IP", "2")
    store = FakeStore()
    q = _quota(store)
    assert q.try_reserve_question("198.51.100.1") is None
    assert q.try_reserve_question("198.51.100.1") is None
    assert q.try_reserve_question("198.51.100.1") == "ip"
    assert _quota(store).try_reserve_question("198.51.100.2") is None   # survives "restart"
    assert q.try_reserve_question("198.51.100.3") == "global"
    doc = next(iter(store.docs.values()))[0]
    assert doc["questions"] == 3 and doc["id"].startswith("demo-quota-")
    assert "198.51.100.1" not in json.dumps(store.docs)
    # Sessions budget untouched by question reservations.
    assert doc["total"] == 0


def test_question_quota_fails_closed_and_retries(monkeypatch):
    from test_demo_quota_durable import FakeStore

    store = FakeStore()
    store.conflicts_to_inject = 2
    assert _quota(store).try_reserve_question("192.0.2.1") is None
    store.conflicts_to_inject = 100
    assert _quota(store).try_reserve_question("192.0.2.1") == "busy"
    store.conflicts_to_inject = 0
    store.fail = True
    assert _quota(store).try_reserve_question("192.0.2.1") == "unavailable"


def test_question_quota_in_memory(monkeypatch):
    from security import DemoQuota

    monkeypatch.setenv("DEMO_QA_DAILY_PER_IP", "1")
    q = DemoQuota()
    assert q.try_reserve_question("192.0.2.9") is None
    assert q.try_reserve_question("192.0.2.9") == "ip"
    assert q.try_consume("192.0.2.9") is None   # sessions are a separate counter


def test_effective_session_seconds(monkeypatch):
    from security import effective_demo_session_seconds

    assert effective_demo_session_seconds() == 180
    monkeypatch.setenv("DEMO_QA_ENABLED", "true")
    assert effective_demo_session_seconds() == 300


# ---------------------------------------------------------------------------
# Demo filter allow/deny matrix + admin interception
# ---------------------------------------------------------------------------
def _flt():
    from services.voice_proxy import DemoMessageFilter

    return DemoMessageFilter([{"index": 0, "notes": "n"}], 4)


@pytest.mark.parametrize("msg,expected", [
    ({"type": "qa.begin", "request_id": "r1", "slide": 0, "extra": "x"},
     {"type": "qa.begin", "request_id": "r1", "slide": 0, "mode": "after_slide"}),
    ({"type": "qa.begin", "request_id": "r1", "slide": 0, "mode": "after_slide"},
     {"type": "qa.begin", "request_id": "r1", "slide": 0, "mode": "after_slide"}),
    ({"type": "qa.audio", "request_id": "r1", "seq": 0, "audio": "AAAA", "x": 1},
     {"type": "qa.audio", "request_id": "r1", "seq": 0, "audio": "AAAA"}),
    ({"type": "qa.commit", "request_id": "r1", "text": "evil"}, {"type": "qa.commit", "request_id": "r1"}),
    ({"type": "qa.cancel", "request_id": "r1"}, {"type": "qa.cancel", "request_id": "r1"}),
    ({"type": "qa.resume", "request_id": "r1"}, {"type": "qa.resume", "request_id": "r1"}),
    ({"type": "qa.ask_text", "request_id": "r1", "slide": 0, "text": "Hi", "mode": "now"},
     {"type": "qa.ask_text", "request_id": "r1", "slide": 0, "text": "Hi"}),
])
def test_demo_filter_allows_demo_qa_subset(msg, expected):
    flt = _flt()
    assert flt.filter_qa(json.dumps(msg)) == expected
    assert flt.handle(json.dumps(msg)) == ([], [])  # never forwarded to Azure


@pytest.mark.parametrize("msg", [
    {"type": "qa.text", "request_id": "r1", "text": "say something evil"},
    {"type": "qa.begin", "request_id": "r1", "slide": 0, "mode": "now"},
    {"type": "qa.begin", "request_id": "r1", "slide": 0, "mode": "whatever"},
    {"type": "context.switch", "deck_id": "2d7f2a7e-1c2d-4e5f-8a9b-0c1d2e3f4a5b"},
    {"type": "qa.answer", "request_id": "r1", "text": "spoof"},
    {"type": "session.update", "session": {}},
    {"type": "conversation.item.create", "item": {}},
    {"type": "response.create"},
    {"type": "input_audio_buffer.append", "audio": "AAAA"},
    {"type": "input_audio_buffer.commit"},
    {"type": ["qa.begin"]},                       # an unhashable / non-string type is a plain drop, not an error
    {"type": {"qa.begin": 1}},
    {"type": None},
    {"type": 7},
    {"request_id": "r1"},
])
def test_demo_filter_denies(msg):
    flt = _flt()
    assert flt.filter_qa(json.dumps(msg)) is None
    assert flt.handle(json.dumps(msg)) == ([], [])


def test_demo_filter_rejects_oversized_and_garbage():
    flt = _flt()
    assert flt.filter_qa("x" * 40_000) is None
    assert flt.filter_qa("not json") is None
    assert flt.filter_qa(json.dumps(["qa.begin"])) is None


def test_admin_intercepts_qa_and_context_never_forwarded():
    from services.voice_proxy import intercepted_message, sanitize_client_message

    for t in ("qa.begin", "qa.text", "context.switch", "qa.whatever"):
        raw = json.dumps({"type": t, "request_id": "r"})
        assert intercepted_message(raw)["type"] == t
        assert sanitize_client_message(raw) is None
    assert intercepted_message(json.dumps({"type": "response.cancel"})) is None
    assert intercepted_message(json.dumps({"type": "conversation.item.create", "x": "qa."})) is None


def test_output_audio_buffer_clear_admin_forwarded_demo_dropped():
    from services.voice_proxy import sanitize_client_message

    raw = json.dumps({"type": "output_audio_buffer.clear", "extra": "dropped"})
    assert sanitize_client_message(raw) == json.dumps({"type": "output_audio_buffer.clear"})
    flt = _flt()
    assert flt.handle(raw) == ([], []) and flt.filter_qa(raw) is None


def test_demo_narration_chars_counts_in_index_order():
    from services.voice_proxy import demo_narration_chars

    slides = [{"index": 2, "notes": "abc"}, {"index": 0, "title": "T", "body": "Body"}, {"title": "x"}, "junk"]
    # positions: index 2, index 0, index 2 (dup, ignored), junk skipped
    assert demo_narration_chars(slides) == [len("T. Body"), 3]
    assert demo_narration_chars([]) == []


def test_session_config_requests_word_timestamps():
    from services.voice_proxy import build_demo_session_config, build_session_config

    assert build_session_config()["output_audio_timestamp_types"] == ["word"]
    assert build_demo_session_config("en-US")[0]["output_audio_timestamp_types"] == ["word"]


def test_word_timestamp_events_are_forwarded_to_the_browser():
    from services.voice_proxy import _forward_azure_to_client

    evt = json.dumps({"type": "response.audio_timestamp.delta", "audio_offset_ms": 120,
                      "audio_duration_ms": 300, "text": "Hello", "timestamp_type": "word"})

    class Azure:
        def __init__(self):
            self.items = [evt, json.dumps({"type": "response.audio_timestamp.done"})]

        def __aiter__(self):
            return self

        async def __anext__(self):
            if not self.items:
                raise StopAsyncIteration
            return self.items.pop(0)

    class Client:
        out: list = []

        async def send_text(self, data):
            self.out.append(data)

    client = Client()
    asyncio.run(_forward_azure_to_client(Azure(), client))
    assert client.out[0] == evt and len(client.out) == 2


# ---------------------------------------------------------------------------
# QaSession state machine (unit)
# ---------------------------------------------------------------------------
SLIDES = [{"index": 0, "title": "Intro", "notes": "Hello"}, {"index": 1, "title": "Revenue", "body": "Up 12%"}]


def _session(opts=None, clock=None, on_terminal=None):
    sent: list[dict] = []
    spoken: list[str] = []

    async def send(m):
        sent.append(m)

    async def speak(t, kind="answer"):
        spoken.append(t)

    opts = opts or QaOptions(access="admin", slides=SLIDES, language="en-US")
    return QaSession(opts, cfg=load_config(), send_client=send, speak=speak,
                     clock=clock or Clock(), on_terminal=on_terminal), sent, spoken


def test_disconnect_cancels_inflight_stt(monkeypatch):
    started = asyncio.Event()
    cancelled = []

    async def slow_stt(cfg, pcm, language):
        started.set()
        try:
            await asyncio.sleep(30)
        except asyncio.CancelledError:
            cancelled.append(True)
            raise

    monkeypatch.setattr(vq, "transcribe_pcm", slow_stt)

    async def run():
        s, sent, spoken = _session()
        await s.handle({"type": "qa.begin", "request_id": "r1", "slide": 0})
        await s.handle({"type": "qa.audio", "request_id": "r1", "seq": 0, "audio": _b64(320)})
        await s.handle({"type": "qa.commit", "request_id": "r1"})
        await asyncio.wait_for(started.wait(), 2)
        task = s._task
        s.close()
        await asyncio.gather(task, return_exceptions=True)
        return s, sent

    s, sent = asyncio.run(run())
    assert cancelled == [True]
    assert s.state == "idle" and s.audio is None
    assert [m["type"] for m in sent] == ["qa.ready"]


def test_one_in_flight_and_session_limit(monkeypatch):
    async def run():
        s, sent, _ = _session(QaOptions(access="admin", slides=SLIDES, max_questions=2))
        await s.handle({"type": "qa.begin", "request_id": "a", "slide": 0})
        await s.handle({"type": "qa.begin", "request_id": "b", "slide": 0})
        await s.handle({"type": "qa.cancel", "request_id": "a"})
        await s.handle({"type": "qa.begin", "request_id": "c", "slide": 1, "mode": "now"})
        await s.handle({"type": "qa.cancel", "request_id": "c"})
        await s.handle({"type": "qa.begin", "request_id": "d", "slide": 0})
        return sent

    sent = asyncio.run(run())
    assert [(m["type"], m.get("code")) for m in sent] == [
        ("qa.ready", None), ("qa.error", "bad_state"), ("qa.ready", None), ("qa.error", "limit")]
    assert sent[0]["remaining_questions"] == 1 and sent[2]["remaining_questions"] == 0
    assert "remaining_ms" not in sent[0]  # admin: no demo clock


def test_audio_errors_reset_question(monkeypatch):
    async def run():
        s, sent, _ = _session()
        await s.handle({"type": "qa.audio", "request_id": "r1", "seq": 0, "audio": _b64(2)})  # before begin
        await s.handle({"type": "qa.begin", "request_id": "r1", "slide": 0})
        await s.handle({"type": "qa.audio", "request_id": "r1", "seq": 1, "audio": _b64(2)})  # bad seq
        await s.handle({"type": "qa.commit", "request_id": "r1"})                               # now idle
        await s.handle({"type": "qa.begin", "request_id": "r2", "slide": 0})
        await s.handle({"type": "qa.commit", "request_id": "r2"})                               # no audio
        await s.handle({"type": "qa.begin", "request_id": "bad id!", "slide": 0})
        await s.handle({"type": "qa.begin", "request_id": "r3", "slide": "1"})
        return sent

    codes = [(m["type"], m.get("code")) for m in asyncio.run(run())]
    assert codes == [("qa.error", "bad_state"), ("qa.ready", None), ("qa.error", "bad_state"),
                     ("qa.error", "bad_state"), ("qa.ready", None), ("qa.error", "no_speech"),
                     ("qa.error", "bad_state"), ("qa.error", "bad_state")]


def test_daily_reservation_refusal_and_store_error():
    async def refuse():
        return "ip"

    async def broken():
        raise RuntimeError("cosmos down")

    async def run(reserve):
        s, sent, spoken = _session(QaOptions(access="demo", slides=SLIDES, max_questions=2, reserve_daily=reserve))
        await s.handle({"type": "qa.begin", "request_id": "r1", "slide": 0})
        return s, sent, spoken

    for reserve in (refuse, broken):
        s, sent, spoken = asyncio.run(run(reserve))
        assert sent[0]["code"] == "limit" and spoken == [] and s.state == "idle"


def test_demo_time_low_and_remaining_ms():
    clock = Clock(1000.0)
    opts = QaOptions(access="demo", slides=SLIDES, max_questions=2, deadline=1029.5)

    async def run():
        s, sent, spoken = _session(opts, clock)
        await s.handle({"type": "qa.begin", "request_id": "r1", "slide": 0})
        return sent, spoken

    sent, spoken = asyncio.run(run())
    assert sent[0]["code"] == "time_low" and sent[0]["remaining_ms"] == 29_500 and spoken == []


def test_unavailable_without_deck_and_context_switch():
    async def loader(deck_id):
        return SLIDES if deck_id == "2d7f2a7e-1c2d-4e5f-8a9b-0c1d2e3f4a5b" else None

    async def run():
        s, sent, _ = _session(QaOptions(access="admin", slides=None, deck_loader=loader))
        await s.handle({"type": "qa.begin", "request_id": "r1", "slide": 0})
        await s.handle({"type": "context.switch", "deck_id": "nope"})
        await s.handle({"type": "context.switch", "deck_id": "2d7f2a7e-1c2d-4e5f-8a9b-0c1d2e3f4a5b"})
        await s.handle({"type": "qa.begin", "request_id": "r2", "slide": 0})
        return sent

    sent = asyncio.run(run())
    assert sent[0] == {"type": "qa.unavailable", "reason": "no_deck"}
    assert sent[1]["type"] == "qa.error" and sent[1]["code"] == "bad_deck"
    assert sent[2] == {"type": "context.switched", "deck_id": "2d7f2a7e-1c2d-4e5f-8a9b-0c1d2e3f4a5b",
                       "slide_count": 2}
    assert sent[3]["type"] == "qa.ready"


# ---------------------------------------------------------------------------
# Listening watchdog
# ---------------------------------------------------------------------------
def test_listen_timeout_without_commit(monkeypatch):
    monkeypatch.setattr(vq, "MAX_AUDIO_MS", 50)
    monkeypatch.setattr(vq, "LISTEN_GRACE_SECONDS", 0.05)

    async def run():
        s, sent, _ = _session(QaOptions(access="admin", slides=SLIDES, max_questions=3))
        await s.handle({"type": "qa.begin", "request_id": "r1", "slide": 0})
        await asyncio.sleep(0.3)
        state = s.state
        await s.handle({"type": "qa.begin", "request_id": "r2", "slide": 0})  # slot released
        return s, sent, state

    s, sent, state = asyncio.run(run())
    assert state == "idle"
    assert [(m["type"], m.get("code"), m.get("request_id")) for m in sent] == [
        ("qa.ready", None, "r1"), ("qa.error", "no_speech", "r1"), ("qa.ready", None, "r2")]
    assert s.used == 2  # the timed-out question stays consumed


def test_listen_timeout_when_frames_stop(monkeypatch):
    monkeypatch.setattr(vq, "FRAME_IDLE_SECONDS", 0.1)

    async def run():
        s, sent, _ = _session()
        await s.handle({"type": "qa.begin", "request_id": "r1", "slide": 0})
        await asyncio.sleep(0.2)            # no frames yet: invite playing, no idle timeout
        assert s.state == "listening"
        await s.handle({"type": "qa.audio", "request_id": "r1", "seq": 0, "audio": _b64(320)})
        await asyncio.sleep(0.3)            # frames stopped > FRAME_IDLE_SECONDS
        return s, sent

    s, sent = asyncio.run(run())
    assert s.state == "idle" and s.audio is None
    assert sent[-1]["code"] == "no_speech"


def test_watchdog_stopped_by_commit_and_cancel(monkeypatch):
    monkeypatch.setattr(vq, "MAX_AUDIO_MS", 50)
    monkeypatch.setattr(vq, "LISTEN_GRACE_SECONDS", 0.05)

    async def stt(cfg, pcm, language):
        return "q?"

    async def answer(*a, **k):
        return {"answer": "A.", "source_slides": [0], "grounded": True}

    monkeypatch.setattr(vq, "transcribe_pcm", stt)
    monkeypatch.setattr(vq.deck_qa, "answer_deck_question", answer)

    async def run():
        s, sent, _ = _session()
        await s.handle({"type": "qa.begin", "request_id": "r1", "slide": 0})
        await s.handle({"type": "qa.cancel", "request_id": "r1"})
        await s.handle({"type": "qa.begin", "request_id": "r2", "slide": 0})
        await s.handle({"type": "qa.audio", "request_id": "r2", "seq": 0, "audio": _b64(320)})
        await s.handle({"type": "qa.commit", "request_id": "r2"})
        await asyncio.sleep(0.3)
        return s, sent

    s, sent = asyncio.run(run())
    assert [m["type"] for m in sent] == ["qa.ready", "qa.ready", "qa.transcript", "qa.answer"]
    assert s.state == "answered"


# ---------------------------------------------------------------------------
# Typed question (qa.ask_text), limit scopes, bounded daily reservation (contracts §4.4)
# ---------------------------------------------------------------------------
from services import demo_protocol as dp  # noqa: E402

TYPED_ANSWER = {"answer": "Revenue grew twelve percent.", "source_slides": [1], "grounded": True}


def _demo_session(*, reserve=None, max_questions=2, deadline=None, clock=None, slides=SLIDES, enabled=True,
                  on_terminal=None, language="en-US"):
    sent: list[dict] = []
    spoken: list[tuple[str, str]] = []

    async def send(m):
        sent.append(m)

    async def speak(text, kind="answer"):
        spoken.append((kind, text))

    opts = QaOptions(access="demo", enabled=enabled, slides=slides, max_questions=max_questions,
                     reserve_daily=reserve, deadline=deadline, language=language)
    session = QaSession(opts, cfg=load_config(), send_client=send, speak=speak, clock=clock or Clock(),
                        on_terminal=on_terminal)
    return session, sent, spoken


def _typed(rid="t1", slide=1, text="How much did revenue grow?", **extra):
    return {"type": "qa.ask_text", "request_id": rid, "slide": slide, "text": text, **extra}


def _voice_begin(rid="v1", slide=0):
    return {"type": "qa.begin", "request_id": rid, "slide": slide}


def _answering(monkeypatch, calls=None, sent=None, result=TYPED_ANSWER):
    async def answer(slides, current, question, language, access, **kw):
        if calls is not None:
            calls.append({"sent_before": [m["type"] for m in sent or []], "slides": len(slides), "current": current,
                          "question": question, "language": language, "access": access})
        return dict(result)

    monkeypatch.setattr(vq.deck_qa, "answer_deck_question", answer)


def test_ask_text_is_accepted_before_the_model_is_called(monkeypatch):
    """qa.accepted comes right after the reservation and before any model call; no spoken invite, no watchdog."""
    calls: list[dict] = []
    clock = Clock(1000.0)
    s, sent, spoken = _demo_session(deadline=1300.0, clock=clock)
    _answering(monkeypatch, calls, sent)

    async def run():
        await s.handle(_typed(text="  How much did revenue grow?  "))
        assert s.state == "processing" and s._watchdog is None
        await asyncio.wait_for(s._task, 2)

    asyncio.run(run())
    assert [m["type"] for m in sent] == ["qa.accepted", "qa.transcript", "qa.answer"]
    assert sent[0] == {"type": "qa.accepted", "request_id": "t1", "remaining_questions": 1, "remaining_ms": 300_000}
    assert sent[1]["text"] == "How much did revenue grow?"                   # the trimmed echo
    assert sent[2]["text"] == TYPED_ANSWER["answer"] and sent[2]["source_slides"] == [1] and sent[2]["grounded"] is True
    assert calls == [{"sent_before": ["qa.accepted", "qa.transcript"], "slides": 2, "current": 1,
                      "question": "How much did revenue grow?", "language": "en-US", "access": "demo"}]
    assert spoken == [("answer", TYPED_ANSWER["answer"])]                    # the answer only: no invite
    assert s.state == "answered" and s.used == 1


def test_ask_text_shares_the_session_and_daily_quota_with_voice(monkeypatch):
    reservations: list[int] = []

    async def reserve():
        reservations.append(1)
        return None

    s, sent, spoken = _demo_session(max_questions=2, reserve=reserve)
    _answering(monkeypatch)

    async def run():
        await s.handle(_voice_begin())                       # a voice question consumes one…
        await s.handle({"type": "qa.cancel", "request_id": "v1"})
        await s.handle(_typed("t1"))                         # …a typed one the other
        await asyncio.wait_for(s._task, 2)
        await s.handle(_typed("t2"))                         # …and there is no third

    asyncio.run(run())
    assert [(m["type"], m.get("code")) for m in sent][-1] == ("qa.error", "limit")
    assert sent[-1]["scope"] == "session" and sent[-1]["request_id"] == "t2"
    assert len(reservations) == 2 and s.used == 2
    assert spoken[0] == ("invite", "Go ahead, I'm listening.")


@pytest.mark.parametrize("kind", ["voice", "typed"])
@pytest.mark.parametrize("refusal,scope", [
    ("global", "daily"), ("ip", "daily"),
    ("busy", "unavailable"), ("unavailable", "unavailable"), (RuntimeError("cosmos down"), "unavailable"),
])
def test_t3_q11_daily_scope(kind, refusal, scope):
    """[T3-Q11] an exhausted daily budget refuses with scope "daily" (and says so), a quota store that is busy,
    down or failing with scope "unavailable"; the question is not counted and nothing is spoken."""
    async def reserve():
        if isinstance(refusal, Exception):
            raise refusal
        return refusal

    s, sent, spoken = _demo_session(reserve=reserve)
    asyncio.run(s.handle(_voice_begin("q1") if kind == "voice" else _typed("q1")))
    assert sent == [{"type": "qa.error", "request_id": "q1", "code": "limit", "scope": scope,
                     "message": dp.QA_LIMIT_MESSAGES[scope]}]
    assert s.used == 0 and s.state == "idle" and spoken == []


def test_t3_q11_texts_are_the_contract_texts():
    assert dp.QA_LIMIT_MESSAGES["daily"] == "Today's question allowance for the live demo has been reached."
    assert dp.QA_LIMIT_MESSAGES["session"] == vq.ERROR_MESSAGES["limit"]        # the existing text stays "session"
    assert set(dp.QA_LIMIT_SCOPES) == {"session", "daily", "unavailable"}


@pytest.mark.parametrize("kind", ["voice", "typed"])
def test_t3_q11_session_scope(kind, monkeypatch):
    _answering(monkeypatch)
    s, sent, _ = _demo_session(max_questions=1)

    async def run():
        if kind == "voice":
            await s.handle(_voice_begin("q1"))
            await s.handle({"type": "qa.cancel", "request_id": "q1"})
            await s.handle(_voice_begin("q2"))
        else:
            await s.handle(_typed("q1"))
            await asyncio.wait_for(s._task, 2)
            await s.handle(_typed("q2"))

    asyncio.run(run())
    assert sent[-1] == {"type": "qa.error", "request_id": "q2", "code": "limit", "scope": "session",
                        "message": "No more questions are available for this session."}


def test_admin_limit_errors_keep_their_single_text_without_scope():
    async def quota():
        return "quota"

    async def run():
        a, asent, _ = _session(QaOptions(access="admin", slides=SLIDES, max_questions=1, reserve_daily=quota))
        await a.handle({"type": "qa.begin", "request_id": "a1", "slide": 0})        # the daily quota refuses
        b, bsent, _ = _session(QaOptions(access="admin", slides=SLIDES, max_questions=1))
        await b.handle({"type": "qa.begin", "request_id": "b1", "slide": 0})
        await b.handle({"type": "qa.cancel", "request_id": "b1"})
        await b.handle({"type": "qa.begin", "request_id": "b2", "slide": 0})        # the session maximum
        return asent, bsent

    daily, session = asyncio.run(run())
    for out in (daily[-1], session[-1]):
        assert out["code"] == "limit" and "scope" not in out
        assert out["message"] == vq.ERROR_MESSAGES["limit"]


@pytest.mark.parametrize("kind", ["voice", "typed"])
def test_daily_reservation_is_bounded_and_the_question_is_not_counted(kind, monkeypatch):
    """§4.4: a reservation that does not answer within QA_RESERVE_TIMEOUT_SECONDS refuses the question
    (limit / unavailable) and is not counted for the session."""
    import time

    assert dp.QA_RESERVE_TIMEOUT_SECONDS == 3
    monkeypatch.setattr(dp, "QA_RESERVE_TIMEOUT_SECONDS", 0.05)
    cancelled: list[bool] = []

    async def slow():
        try:
            await asyncio.sleep(30)
        except asyncio.CancelledError:
            cancelled.append(True)
            raise

    s, sent, spoken = _demo_session(reserve=slow)
    started = time.monotonic()
    asyncio.run(s.handle(_voice_begin("q1") if kind == "voice" else _typed("q1")))
    assert time.monotonic() - started < 2
    assert sent == [{"type": "qa.error", "request_id": "q1", "code": "limit", "scope": "unavailable",
                     "message": dp.QA_LIMIT_MESSAGES["unavailable"]}]
    assert s.used == 0 and s.state == "idle" and spoken == [] and cancelled == [True]


@pytest.mark.parametrize("msg,rid,code", [
    (_typed("bad id!"), None, "bad_state"),
    (_typed(slide=None), "t1", "bad_state"),
    (_typed(slide=True), "t1", "bad_state"),
    (_typed(slide=-1), "t1", "bad_state"),
    (_typed(slide=10_000), "t1", "bad_state"),
    (_typed(slide="1"), "t1", "bad_state"),
    (_typed(text=None), "t1", "bad_state"),
    (_typed(text=5), "t1", "bad_state"),
    (_typed(text=["x"]), "t1", "bad_state"),
    (_typed(text=""), "t1", "no_speech"),
    (_typed(text="  \n\t "), "t1", "no_speech"),
])
def test_ask_text_invalid_input_never_costs_a_question(msg, rid, code):
    reserved: list[int] = []

    async def reserve():
        reserved.append(1)
        return None

    s, sent, spoken = _demo_session(reserve=reserve)
    asyncio.run(s.handle(msg))
    assert [(m["request_id"], m["code"]) for m in sent] == [(rid, code)]
    assert "scope" not in sent[0]
    assert reserved == [] and s.used == 0 and s.state == "idle" and spoken == []


def test_ask_text_length_limit_has_its_own_message(monkeypatch):
    reserved: list[int] = []

    async def reserve():
        reserved.append(1)
        return None

    s, sent, _ = _demo_session(reserve=reserve)
    _answering(monkeypatch)

    async def run():
        await s.handle(_typed("long", text="x" * 501))
        await s.handle(_typed("ok", text=" " + "x" * 500 + " "))         # 500 after strip(): accepted
        await asyncio.wait_for(s._task, 2)

    asyncio.run(run())
    assert sent[0] == {"type": "qa.error", "request_id": "long", "code": "too_long",
                       "message": "That question is too long. Please keep it under 500 characters."}
    assert "15 seconds" not in sent[0]["message"] and sent[0]["message"] == dp.TEXT_TOO_LONG_MESSAGE
    assert sent[1]["type"] == "qa.accepted" and len(reserved) == 1 and s.used == 1


def test_ask_text_state_rules(monkeypatch):
    s, sent, _ = _demo_session(max_questions=5)
    _answering(monkeypatch)

    async def run():
        await s.handle(_voice_begin("v1"))                    # a voice question is in flight (listening)
        await s.handle(_typed("t1"))
        await s.handle({"type": "qa.cancel", "request_id": "v1"})
        await s.handle(_typed("t2"))
        await asyncio.wait_for(s._task, 2)
        assert s.state == "answered"
        await s.handle(_typed("t3"))                          # answered: implicit reset, then accepted
        await asyncio.wait_for(s._task, 2)

    asyncio.run(run())
    codes = [(m["type"], m["request_id"], m.get("code")) for m in sent]
    assert ("qa.error", "t1", "bad_state") in codes
    assert [c[:2] for c in codes if c[0] == "qa.accepted"] == [("qa.accepted", "t2"), ("qa.accepted", "t3")]


def test_ask_text_time_low_disabled_and_no_deck():
    reserved: list[int] = []

    async def reserve():
        reserved.append(1)
        return None

    async def run():
        low, sent_low, _ = _demo_session(deadline=1029.5, clock=Clock(1000.0), reserve=reserve)
        await low.handle(_typed())
        off, sent_off, _ = _demo_session(enabled=False, reserve=reserve)
        await off.handle(_typed())
        nodeck, sent_nodeck, _ = _demo_session(slides=None, reserve=reserve)
        await nodeck.handle(_typed())
        return sent_low, sent_off, sent_nodeck

    low, off, nodeck = asyncio.run(run())
    assert low[0]["code"] == "time_low" and low[0]["remaining_ms"] == 29_500
    assert off[0]["code"] == "disabled"
    assert nodeck == [{"type": "qa.unavailable", "reason": "no_deck"}]
    assert reserved == []


def test_ask_text_answer_failure_keeps_the_question_consumed(monkeypatch):
    async def broken(*a, **k):
        raise vq.deck_qa.DeckQaError("answer_failed")

    monkeypatch.setattr(vq.deck_qa, "answer_deck_question", broken)
    s, sent, spoken = _demo_session()

    async def run():
        await s.handle(_typed("t1"))
        await asyncio.wait_for(s._task, 2)

    asyncio.run(run())
    assert [(m["type"], m.get("code")) for m in sent] == [
        ("qa.accepted", None), ("qa.transcript", None), ("qa.error", "answer_failed")]
    assert s.used == 1 and s.state == "idle" and spoken == []


def test_terminal_question_events_reach_the_idle_clock(monkeypatch):
    """§4.5: qa.error (valid request id, not bad_state), qa.unavailable, an effective qa.cancel / qa.resume move
    the idle deadline; rejected messages (bad_state, invalid id) and the accepted / answered path do not."""
    _answering(monkeypatch)
    events: list[str] = []
    s, sent, _ = _demo_session(on_terminal=lambda: events.append("terminal"))

    async def run():
        await s.handle(_typed("bad id!"))                     # invalid id -> bad_state, request_id null
        await s.handle(_typed("a", slide=True))               # bad_state
        assert events == []
        await s.handle(_typed("b", text=""))                  # no_speech: a refused question
        assert events == ["terminal"]
        await s.handle(_voice_begin("v1"))                    # qa.ready
        await s.handle({"type": "qa.cancel", "request_id": "ghost"})   # not the active question: ignored
        assert events == ["terminal"]
        await s.handle({"type": "qa.cancel", "request_id": "v1"})
        assert events == ["terminal", "terminal"]
        await s.handle(_typed("t1"))                          # accepted -> transcript -> answer: not terminal
        await asyncio.wait_for(s._task, 2)
        assert events == ["terminal", "terminal"]
        await s.handle({"type": "qa.resume", "request_id": "ghost"})
        assert events == ["terminal", "terminal"]
        await s.handle({"type": "qa.resume", "request_id": "t1"})
        assert events == ["terminal"] * 3

    asyncio.run(run())

    nodeck_events: list[str] = []
    nodeck, _, _ = _demo_session(slides=None, on_terminal=lambda: nodeck_events.append("terminal"))
    asyncio.run(nodeck.handle(_voice_begin()))
    assert nodeck_events == ["terminal"]                      # qa.unavailable


def test_is_quiet_follows_the_question_state(monkeypatch):
    async def run():
        gate = asyncio.Event()

        async def slow(*a, **k):
            await gate.wait()
            return dict(TYPED_ANSWER)

        monkeypatch.setattr(vq.deck_qa, "answer_deck_question", slow)
        s, _, _ = _demo_session()
        assert s.is_quiet()
        await s.handle(_voice_begin("v1"))
        assert not s.is_quiet()                               # listening
        await s.handle({"type": "qa.cancel", "request_id": "v1"})
        assert s.is_quiet()
        await s.handle(_typed("t1"))
        assert not s.is_quiet()                               # processing
        gate.set()
        await asyncio.wait_for(s._task, 2)
        assert s.state == "answered" and s.is_quiet()

    asyncio.run(run())


@pytest.mark.parametrize("kind", ["voice", "typed"])
@pytest.mark.parametrize("outcome", [None, "global", "ip", "busy", "timeout"])
def test_is_not_quiet_while_the_daily_reservation_is_pending(kind, outcome, monkeypatch):
    """The daily reservation (up to QA_RESERVE_TIMEOUT_SECONDS) runs while the question session is still `idle`: the
    demo's idle close must not fire in that window, however it ends. A refusal's terminal event (which restarts the idle
    window) happens before the session is quiet again; after an acceptance a question is in progress as before."""
    monkeypatch.setattr(dp, "QA_RESERVE_TIMEOUT_SECONDS", 0.2)

    async def run():
        release = asyncio.Event()
        answer_gate = asyncio.Event()                         # the grounded answer never arrives in this test
        quiet_at_terminal: list[bool] = []

        async def slow_answer(*a, **k):
            await answer_gate.wait()
            return dict(TYPED_ANSWER)

        async def reserve():
            if outcome == "timeout":
                await asyncio.sleep(30)                       # never answers within the bound
            await release.wait()
            return outcome

        monkeypatch.setattr(vq.deck_qa, "answer_deck_question", slow_answer)
        s, sent, _ = _demo_session(reserve=reserve, on_terminal=lambda: quiet_at_terminal.append(s.is_quiet()))
        assert s.is_quiet()
        handled = asyncio.ensure_future(s.handle(_voice_begin("q1") if kind == "voice" else _typed("q1")))
        await asyncio.sleep(0.05)
        assert not handled.done() and s.state == "idle"       # still waiting for the reservation…
        assert not s.is_quiet()                               # …which is not a quiet session
        release.set()
        await asyncio.wait_for(handled, 2)
        if outcome is None:
            assert s.used == 1 and quiet_at_terminal == []    # accepted: nothing terminal yet…
            assert not s.is_quiet()                           # …a question is being listened to / answered
            assert s.state == ("listening" if kind == "voice" else "processing")
        else:
            assert s.used == 0 and [m["type"] for m in sent] == ["qa.error"] and sent[0]["code"] == "limit"
            assert quiet_at_terminal == [False]               # the idle window restarted before the session was quiet
            assert s.is_quiet() and s.state == "idle"
        s.close()

    asyncio.run(run())


def test_a_cancelled_reservation_leaves_the_session_quiet_again():
    """The pump is cancelled while a question waits for its reservation (the session ends): nothing stays reserved."""
    async def run():
        async def reserve():
            await asyncio.sleep(30)

        s, _, _ = _demo_session(reserve=reserve)
        handled = asyncio.ensure_future(s.handle(_typed("t1")))
        await asyncio.sleep(0.02)
        assert not s.is_quiet()
        handled.cancel()
        await asyncio.gather(handled, return_exceptions=True)
        return s

    s = asyncio.run(run())
    assert s.is_quiet() and s.used == 0 and s.state == "idle"


def test_can_ask_follows_the_question_budget(monkeypatch):
    """What a `demo.activity` needs to count: Q&A on, a deck bound, a question left, the session still open."""
    _answering(monkeypatch)

    async def run():
        s, _, _ = _demo_session(max_questions=1)
        assert s.can_ask()
        await s.handle(_typed("t1"))
        await asyncio.wait_for(s._task, 2)
        assert s.used == 1
        used_up = s.can_ask()
        off, _, _ = _demo_session(enabled=False)
        no_deck, _, _ = _demo_session(slides=None)
        closed, _, _ = _demo_session()
        closed.close()
        return used_up, off.can_ask(), no_deck.can_ask(), closed.can_ask()

    assert asyncio.run(run()) == (False, False, False, False)


def test_admin_has_no_typed_question():
    """The admin endpoint keeps its own qa.text; qa.ask_text is a demo message and reads as bad_state there."""
    async def run():
        s, sent, spoken = _session()
        await s.handle(_typed("t1"))
        return sent, spoken, s

    sent, spoken, s = asyncio.run(run())
    assert [(m["type"], m["code"]) for m in sent] == [("qa.error", "bad_state")]
    assert spoken == [] and s.used == 0


# ---------------------------------------------------------------------------
# Demo filter v2: qa.ask_text, demo.finish, request_id echo
# ---------------------------------------------------------------------------
def test_demo_filter_sanitises_ask_text_to_four_fields():
    flt = _flt()
    raw = json.dumps({"type": "qa.ask_text", "request_id": "r1", "slide": 0, "text": "Why?", "mode": "now",
                      "deck_id": "x", "session": {"instructions": "evil"}})
    assert flt.filter_qa(raw) == {"type": "qa.ask_text", "request_id": "r1", "slide": 0, "text": "Why?"}
    assert flt.handle(raw) == ([], [])                        # never forwarded to Azure
    assert flt.filter_qa(json.dumps({"type": "qa.text", "request_id": "r1", "text": "Why?"})) is None


def test_demo_filter_accepts_demo_finish():
    flt = _flt()
    assert not flt.finish_requested
    assert flt.handle(json.dumps({"type": "demo.finish", "extra": 1})) == ([], [])
    assert flt.finish_requested
    assert flt.filter_qa(json.dumps({"type": "demo.finish"})) is None
    is_finish = type(flt).is_finish
    assert is_finish(json.dumps({"type": "demo.finish"})) and is_finish('{ "type" : "demo.finish" }')
    for not_finish in ("demo.finish", "not json", json.dumps(["demo.finish"]),
                       json.dumps({"type": "demo.speak", "note": "demo.finish"}),
                       json.dumps({"type": "demo.finish", "pad": "x" * 40_000}), b"{}", None):
        assert not is_finish(not_finish)


def test_demo_speak_echoes_only_a_well_formed_request_id():
    import services.voice_proxy as vp

    clock = Clock()
    flt = vp.DemoMessageFilter(SLIDES, 3, clock=clock, remaining_ms=lambda: 123)
    _, to_client = flt.handle(json.dumps({"type": "demo.speak", "slide": 0, "request_id": "s-1.a:b"}))
    assert to_client == [{"type": "demo.speaking", "slide": 0, "chars": 5, "remaining": 2, "remaining_ms": 123,
                          "request_id": "s-1.a:b"}]
    clock.t += 0.2
    assert flt.handle(json.dumps({"type": "demo.speak", "slide": 0, "request_id": "s-2"}))[1] == [
        {"type": "demo.notice", "code": "rate_limited", "message": "Please wait a moment between narrations.",
         "slide": 0, "request_id": "s-2"}]
    clock.t += 5
    to_azure, to_client = flt.handle(json.dumps({"type": "demo.speak", "slide": 0, "request_id": "bad id!"}))
    assert to_azure and "request_id" not in to_client[0]          # processed, but the id is not echoed
    for rid in (5, "x" * 65, ""):
        clock.t += 5
        assert "request_id" not in flt.handle(json.dumps({"type": "demo.speak", "slide": 0, "request_id": rid}))[1][0]
    clock.t += 5
    flt2 = vp.DemoMessageFilter([{"index": 0, "title": "", "body": "", "notes": ""}], 1, clock=clock)
    assert flt2.handle(json.dumps({"type": "demo.speak", "slide": 0, "request_id": "e-1"}))[1] == [
        {"type": "demo.notice", "code": "empty_slide", "message": "This slide has no narration.", "slide": 0,
         "request_id": "e-1"}]
    flt3 = vp.DemoMessageFilter(SLIDES, 1, clock=clock)
    flt3.handle(json.dumps({"type": "demo.speak", "slide": 0}))
    clock.t += 5
    assert flt3.handle(json.dumps({"type": "demo.speak", "slide": 0, "request_id": "l-1"}))[1] == [
        {"type": "demo.notice", "code": "speak_limit", "message": "Narration limit reached for this demo session.",
         "slide": 0, "request_id": "l-1"}]
