"""services.podcast_tts: audio-only turns and cached backchannel clips over TTS REST.

HTTP is faked by patching ``requests.request`` (fake RIFF/WAV bodies built with
numpy); no Azure call is made and no avatar endpoint may ever be hit.
"""
from __future__ import annotations

import io
import json
import logging
import re
import threading
import time
import wave
from types import SimpleNamespace

import numpy as np
import pytest
import requests

from config import AzureConfig
from services import podcast_media, podcast_tts, speech_rest
from services.podcast_models import DialogueTurn, RenderRoles, RoleConfig, Script

AVA = "en-US-Ava:DragonHDLatestNeural"
ANDREW = "en-US-Andrew:DragonHDLatestNeural"
TTS_URL = "https://swedencentral.tts.speech.microsoft.com/cognitiveservices/v1"
ENDPOINT = "https://res.cognitiveservices.azure.com"


def make_cfg(**overrides) -> AzureConfig:
    base = dict(speech_endpoint="", speech_key="test-key", speech_region="swedencentral",
                speech_resource_id="", openai_endpoint="", openai_key="", openai_chat_deployment="",
                openai_embedding_deployment="", use_managed_identity=False)
    base.update(overrides)
    return AzureConfig(**base)


def make_response(status: int = 200, body: bytes = b"", headers: dict | None = None) -> requests.Response:
    resp = requests.Response()
    resp.status_code = status
    resp._content = body
    resp._content_consumed = True
    resp.headers = requests.structures.CaseInsensitiveDict(headers or {})
    resp.reason = "fake"
    resp.url = "https://fake.invalid/"
    return resp


def make_wav(rate: int = 24_000, lead: float = 0.25, tone: float = 0.5, tail: float = 0.2,
             amp: float = 0.3, placeholder_size: bool = False) -> bytes:
    n_lead, n_tone, n_tail = (int(round(rate * s)) for s in (lead, tone, tail))
    t = np.arange(n_tone) / rate
    samples = np.concatenate([np.zeros(n_lead), amp * np.sin(2 * np.pi * 440.0 * t), np.zeros(n_tail)])
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes((samples * 32767).astype("<i2").tobytes())
    data = buf.getvalue()
    if placeholder_size:
        data = data[:40] + b"\xff\xff\xff\xff" + data[44:]
    return data


def tone_for(text: str) -> float:
    return round(0.2 + 0.01 * len(text), 2)


def make_segments_wav(*segments: tuple[float, float], rate: int = 24_000, freq: float = 1000.0) -> bytes:
    """``(seconds, amplitude)`` segments; amplitude 0 = digital silence, else a sine burst."""
    parts = []
    for seconds, amp in segments:
        t = np.arange(int(round(rate * seconds))) / rate
        parts.append(amp * np.sin(2 * np.pi * freq * t))
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes((np.concatenate(parts) * 32767).astype("<i2").tobytes())
    return buf.getvalue()


CLICK = 0.008  # ~ -45 dBFS RMS: above the -50 dBFS gate, like DragonHD's end-of-synthesis clicks


class FakeTTS:
    """Fake TTS REST + STS endpoints. ``handler(ssml)`` -> WAV bytes, a Response or an exception."""

    def __init__(self) -> None:
        self.calls: list[dict] = []
        self.lock = threading.Lock()
        self.sts_issued = 0
        self.handler = lambda ssml: make_wav()

    def __call__(self, method, url, **kw):
        with self.lock:
            self.calls.append({"method": method.upper(), "url": url, **kw})
        if method.upper() == "POST" and url == f"{ENDPOINT}/sts/v1.0/issuetoken":
            with self.lock:
                self.sts_issued += 1
            return make_response(200, f"STS-{self.sts_issued}".encode())
        if method.upper() == "POST" and url == TTS_URL:
            item = self.handler(kw["data"].decode("utf-8"))
            if isinstance(item, BaseException):
                raise item
            if isinstance(item, requests.Response):
                return item
            return make_response(200, item, {"Content-Type": "audio/x-wav"})
        raise AssertionError(f"unexpected request {method} {url}")

    def tts_calls(self) -> list[dict]:
        return [c for c in self.calls if c["url"] == TTS_URL]

    def ssml_calls(self) -> list[str]:
        return [c["data"].decode("utf-8") for c in self.tts_calls()]


@pytest.fixture
def tts(monkeypatch):
    fake = FakeTTS()
    monkeypatch.setattr(requests, "request", fake)
    sleeps: list[float] = []
    monkeypatch.setattr(speech_rest, "_sleep", sleeps.append)
    monkeypatch.setattr(speech_rest, "_jitter", lambda a, b: 1.0)
    speech_rest.reset_auth_cache()
    yield SimpleNamespace(http=fake, sleeps=sleeps, cfg=make_cfg())
    speech_rest.reset_auth_cache()


def make_script(language: str = "en-US") -> Script:
    return Script(id="s1", document_id="d1", language=language, turns=[
        DialogueTurn(idx=2, speaker="interviewer", text="Thanks a lot for joining us today."),
        DialogueTurn(idx=0, speaker="interviewer", text="Welcome to the show. Let's start."),
        DialogueTurn(idx=1, speaker="expert", text="First point here. Second point there. Third one."),
    ])


def make_roles(interviewer_voice: str = AVA, expert_voice: str = ANDREW) -> RenderRoles:
    return RenderRoles(interviewer=RoleConfig(display_name="Sofia", voice=interviewer_voice),
                       expert=RoleConfig(display_name="Lucas", voice=expert_voice))


def by_text(handler):
    """Route the fake TTS by turn text found in the SSML."""
    return lambda ssml: handler(next(t.text for t in make_script().turns if t.text.split(".")[0] in ssml))


# ---------------------------------------------------------------------------
# synthesize_turns
# ---------------------------------------------------------------------------

def test_turns_are_written_sorted_measured_and_never_touch_the_avatar_api(tts, tmp_path):
    def handler(text):
        if text.startswith("Welcome"):
            time.sleep(0.05)  # finishes last
        return make_wav(tone=tone_for(text))

    tts.http.handler = by_text(handler)
    progress: list[int] = []
    turns = podcast_tts.synthesize_turns(tts.cfg, make_script(), make_roles(), tmp_path, progress_cb=progress.append)

    script = {t.idx: t for t in make_script().turns}
    assert [a.turn_idx for a in turns] == [0, 1, 2]
    assert [a.speaker for a in turns] == ["interviewer", "expert", "interviewer"]
    assert all(a.source == "tts" for a in turns)
    assert [a.path for a in turns] == [tmp_path / f"tts_turn_{i:03d}.wav" for i in range(3)]
    for audio in turns:
        expected = 0.25 + tone_for(script[audio.turn_idx].text) + 0.2
        assert audio.duration_sec == pytest.approx(expected, abs=1e-4)
        with wave.open(str(audio.path), "rb") as w:
            assert (w.getframerate(), w.getnchannels(), w.getsampwidth()) == (24_000, 1, 2)
            assert w.getnframes() / w.getframerate() == pytest.approx(audio.duration_sec)
    assert progress == [1, 2, 3]

    assert len(tts.http.calls) == 3
    for call in tts.http.calls:
        assert call["method"] == "POST" and call["url"] == TTS_URL
        assert "avatar" not in call["url"] and "batchsyntheses" not in call["url"]
        assert call["headers"]["X-Microsoft-OutputFormat"] == "riff-24khz-16bit-mono-pcm"
        assert call["headers"]["Content-Type"] == "application/ssml+xml"
        assert call["headers"]["User-Agent"] and call["headers"]["Ocp-Apim-Subscription-Key"] == "test-key"
        assert call["timeout"] == (10.0, 30.0)
    assert not list(tmp_path.glob("*.part"))


def test_ssml_comes_from_build_ssml_with_the_planned_pauses(tts, tmp_path):
    from services.avatar import build_ssml

    tts.http.handler = lambda ssml: make_wav()
    podcast_tts.synthesize_turns(tts.cfg, make_script(), make_roles(), tmp_path, pauses={1: {1: 700}, 9: {1: 400}})
    ssml = sorted(tts.http.ssml_calls())
    expert = next(s for s in ssml if "First point" in s)
    assert expert == build_ssml("First point here. Second point there. Third one.", "en-US", voice=ANDREW,
                                pause_after_sentence={1: 700})
    assert 'First point here.<break time="700ms"/>Second point there.' in expert
    others = [s for s in ssml if s is not expert]
    assert all('<break time="700ms"/>' not in s and AVA in s for s in others)
    assert all(s.count('<break time="250ms"/>') == 1 for s in ssml)


def test_output_format_is_configurable(tts, tmp_path, monkeypatch):
    monkeypatch.setenv("PODCAST_TTS_OUTPUT_FORMAT", "riff-48khz-16bit-mono-pcm")
    tts.http.handler = lambda ssml: make_wav(rate=48_000, tone=0.4)
    turns = podcast_tts.synthesize_turns(tts.cfg, make_script(), make_roles(), tmp_path)
    assert {c["headers"]["X-Microsoft-OutputFormat"] for c in tts.http.calls} == {"riff-48khz-16bit-mono-pcm"}
    assert all(a.duration_sec == pytest.approx(0.85) for a in turns)
    with wave.open(str(turns[0].path), "rb") as w:
        assert w.getframerate() == 48_000
    monkeypatch.setenv("PODCAST_TTS_OUTPUT_FORMAT", "audio-24khz-48kbitrate-mono-mp3")
    assert podcast_tts.tts_output_format() == podcast_tts.DEFAULT_TTS_OUTPUT_FORMAT


def test_timeouts_scale_with_the_expected_audio(tts, tmp_path):
    assert podcast_tts.tts_timeout(2.0) == (10.0, 30.0)
    latin = "word " * 120  # 600 chars ~ 43 s
    assert podcast_tts.expected_audio_sec(latin) == pytest.approx(0.4 + 600 / 14)
    cjk = "人工智能" * 25  # 100 CJK chars ~ 20 s
    assert podcast_tts.expected_audio_sec(cjk, 700) == pytest.approx(0.4 + 20 + 0.7)
    script = Script(id="s", document_id="d", turns=[DialogueTurn(idx=0, speaker="expert", text=latin.strip())])
    podcast_tts.synthesize_turns(tts.cfg, script, make_roles(), tmp_path)
    connect, read = tts.http.calls[0]["timeout"]
    assert connect == 10.0 and read == pytest.approx(3 * podcast_tts.expected_audio_sec(latin.strip()))


def test_a_voice_outside_the_allow_list_fails_before_any_request(tts, tmp_path):
    with pytest.raises(ValueError) as err:
        podcast_tts.synthesize_turns(tts.cfg, make_script(), make_roles(expert_voice='x"/><audio src="y'), tmp_path)
    assert "turn 1" in str(err.value) and "audio" not in str(err.value)
    assert tts.http.calls == []


def test_a_failed_turn_fails_loud_and_stops_further_requests(tts, tmp_path, monkeypatch):
    monkeypatch.setenv("PODCAST_TTS_PARALLEL", "1")
    tts.http.handler = lambda ssml: make_response(400, b"bad ssml") if "Welcome" in ssml else make_wav()
    progress: list[int] = []
    with pytest.raises(RuntimeError) as err:
        podcast_tts.synthesize_turns(tts.cfg, make_script(), make_roles(), tmp_path, progress_cb=progress.append)
    assert str(err.value) == "1/3 TTS turns failed: turn 0: HTTP 400 (2 not synthesized)"
    assert len(tts.http.calls) == 1 and progress == []
    assert not (tmp_path / "tts_turn_000.wav").exists()


def test_transient_errors_get_at_most_three_attempts(tts, tmp_path, monkeypatch):
    monkeypatch.setenv("PODCAST_TTS_PARALLEL", "1")
    tts.http.handler = lambda ssml: make_response(503)
    with pytest.raises(RuntimeError) as err:
        podcast_tts.synthesize_turns(tts.cfg, make_script(), make_roles(), tmp_path)
    assert "HTTP 503" in str(err.value)
    assert len(tts.http.calls) == podcast_tts.TTS_MAX_ATTEMPTS == 3
    assert tts.sleeps == [1.0, 2.0]


def test_a_transient_error_then_success(tts, tmp_path):
    outcomes = [requests.ConnectionError("reset"), make_response(500)]
    lock = threading.Lock()

    def handler(ssml):
        with lock:
            return outcomes.pop(0) if outcomes else make_wav()

    tts.http.handler = handler
    turns = podcast_tts.synthesize_turns(tts.cfg, make_script(), make_roles(), tmp_path)
    assert len(turns) == 3 and len(tts.http.calls) == 5


def test_deadline_already_passed_makes_no_request(tts, tmp_path):
    with pytest.raises(TimeoutError):
        podcast_tts.synthesize_turns(tts.cfg, make_script(), make_roles(), tmp_path,
                                     deadline=speech_rest.monotonic() - 1)
    assert tts.http.calls == []


def test_deadline_stops_the_remaining_turns(tts, tmp_path, monkeypatch):
    monkeypatch.setenv("PODCAST_TTS_PARALLEL", "1")
    clock = {"now": 100.0}
    monkeypatch.setattr(speech_rest, "_monotonic", lambda: clock["now"])

    def slow(ssml):
        clock["now"] += 5.0
        return make_wav()

    tts.http.handler = slow
    with pytest.raises(TimeoutError):
        podcast_tts.synthesize_turns(tts.cfg, make_script(), make_roles(), tmp_path, deadline=107.0)
    assert len(tts.http.calls) == 2  # t=100 and t=105; t=110 is past the deadline


def test_managed_identity_uses_one_cached_custom_domain_sts_token(tts, tmp_path, monkeypatch):
    monkeypatch.setattr(speech_rest, "aad_token", lambda force_refresh=False: "AAD")
    cfg = make_cfg(use_managed_identity=True, speech_endpoint=ENDPOINT, speech_key="")
    podcast_tts.synthesize_turns(cfg, make_script(), make_roles(), tmp_path)
    sts = [c for c in tts.http.calls if c["url"].endswith("/sts/v1.0/issuetoken")]
    assert len(sts) == 1 and sts[0]["headers"]["Authorization"] == "Bearer AAD"
    assert {c["headers"]["Authorization"] for c in tts.http.tts_calls()} == {"Bearer STS-1"}


def test_parse_wav_handles_streaming_placeholders_and_rejects_garbage():
    info, pcm = podcast_tts.parse_wav(make_wav(tone=0.4, placeholder_size=True))
    assert info.sample_rate == 24_000 and info.duration_sec == pytest.approx(0.85)
    assert len(pcm) == info.frames * 2
    with pytest.raises(podcast_tts.TtsError):
        podcast_tts.parse_wav(b'{"error": "nope"}')
    with pytest.raises(podcast_tts.TtsError):
        podcast_tts.parse_wav(make_wav()[:36])
    eight_bit = bytearray(make_wav())
    eight_bit[34:36] = (8).to_bytes(2, "little")
    with pytest.raises(podcast_tts.TtsError):
        podcast_tts.parse_wav(bytes(eight_bit))


def test_empty_audio_is_a_failure(tts, tmp_path):
    tts.http.handler = lambda ssml: make_wav(lead=0, tone=0, tail=0)
    with pytest.raises(RuntimeError) as err:
        podcast_tts.synthesize_turns(tts.cfg, make_script(), make_roles(), tmp_path)
    assert "empty audio" in str(err.value)


# ---------------------------------------------------------------------------
# synthesize_reaction_audio
# ---------------------------------------------------------------------------

HASH_NAME = re.compile(r"^[0-9a-f]{32}\.wav$")


def test_reaction_clips_are_trimmed_cached_and_hash_named(tts, tmp_path):
    tts.http.handler = lambda ssml: make_wav(tone=0.4)
    clips = podcast_tts.synthesize_reaction_audio(tts.cfg, AVA, "en-US", ["ack", "isee", "ack"], tmp_path)
    assert list(clips) == ["ack", "isee"]
    assert len(tts.http.calls) == 2
    for rid, clip in clips.items():
        assert clip.reaction_id == rid and clip.text == podcast_media.reaction_text("en-US", rid)
        assert clip.video_path is None and clip.has_alpha is False
        assert HASH_NAME.match(clip.audio_path.name) and clip.audio_path.parent == tmp_path
        assert clip.duration_sec == pytest.approx(0.4 + 2 * podcast_tts.REACTION_MARGIN_SEC, abs=1e-6)
        with wave.open(str(clip.audio_path), "rb") as w:
            samples = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2")
            assert w.getframerate() == 24_000
        margin = int(24_000 * podcast_tts.REACTION_MARGIN_SEC)
        assert np.abs(samples[:margin]).max() == 0 and np.abs(samples[-margin:]).max() == 0
        assert np.abs(samples[margin:margin + 240]).max() > 1000
    ssml = tts.http.ssml_calls()
    assert any(">Mm-hmm.<" in s or "Mm-hmm." in s for s in ssml) and all(AVA in s for s in ssml)

    again = podcast_tts.synthesize_reaction_audio(tts.cfg, AVA, "en-US", ["isee", "ack"], tmp_path)
    assert len(tts.http.calls) == 2  # cache hits only
    assert {k: (v.audio_path, v.duration_sec) for k, v in again.items()} == \
        {k: (v.audio_path, v.duration_sec) for k, v in clips.items()}
    assert sorted(p.name for p in tmp_path.iterdir()) == sorted(c.audio_path.name for c in clips.values())


def test_reaction_cache_key_covers_voice_locale_text_format_budget_and_recipe(monkeypatch):
    fmt = "riff-24khz-16bit-mono-pcm"
    key = podcast_tts.reaction_cache_key(AVA, "en-US", "ack", "Mm-hmm.", fmt, 0.53)
    assert re.fullmatch(r"[0-9a-f]{32}", key)
    variants = {
        podcast_tts.reaction_cache_key(ANDREW, "en-US", "ack", "Mm-hmm.", fmt, 0.53),
        podcast_tts.reaction_cache_key(AVA, "en-GB", "ack", "Mm-hmm.", fmt, 0.53),
        podcast_tts.reaction_cache_key(AVA, "en-US", "yeah", "Mm-hmm.", fmt, 0.53),
        podcast_tts.reaction_cache_key(AVA, "en-US", "ack", "Mhm.", fmt, 0.53),
        podcast_tts.reaction_cache_key(AVA, "en-US", "ack", "Mm-hmm.", "riff-48khz-16bit-mono-pcm", 0.53),
        podcast_tts.reaction_cache_key(AVA, "en-US", "ack", "Mm-hmm.", fmt, 0.6),
    }
    assert key not in variants and len(variants) == 6
    assert podcast_tts.RECIPE_VERSION >= 2  # v1 clips (clicks included, no re-takes) are never reused
    monkeypatch.setattr(podcast_tts, "RECIPE_VERSION", podcast_tts.RECIPE_VERSION + 1)
    assert podcast_tts.reaction_cache_key(AVA, "en-US", "ack", "Mm-hmm.", fmt, 0.53) != key


def test_reactions_are_cached_per_voice(tts, tmp_path):
    tts.http.handler = lambda ssml: make_wav(tone=0.3)
    ava = podcast_tts.synthesize_reaction_audio(tts.cfg, AVA, "en-US", ["yeah"], tmp_path)
    andrew = podcast_tts.synthesize_reaction_audio(tts.cfg, ANDREW, "en-US", ["yeah"], tmp_path)
    assert ava["yeah"].audio_path != andrew["yeah"].audio_path and len(tts.http.calls) == 2


def test_reaction_failures_are_omitted_and_logged_by_id_only(tts, tmp_path, caplog):
    caplog.set_level(logging.DEBUG)
    tts.http.handler = lambda ssml: make_response(400, b"bad") if "Yeah." in ssml else make_wav(tone=0.3)
    clips = podcast_tts.synthesize_reaction_audio(tts.cfg, AVA, "en-US", ["ack", "lol<script>", "yeah"], tmp_path)
    assert list(clips) == ["ack"]
    assert "id=yeah" in caplog.text and "id=lolscript" in caplog.text
    assert "Ava" not in caplog.text and "Yeah." not in caplog.text and "<script>" not in caplog.text
    assert len(list(tmp_path.glob("*.wav"))) == 1 and not list(tmp_path.glob("*.part"))


def test_silent_tts_output_yields_no_reaction(tts, tmp_path):
    tts.http.handler = lambda ssml: make_wav(tone=0.4, amp=0.0)
    assert podcast_tts.synthesize_reaction_audio(tts.cfg, AVA, "en-US", ["ack"], tmp_path) == {}


def test_reaction_voice_outside_the_allow_list_yields_nothing(tts, tmp_path):
    assert podcast_tts.synthesize_reaction_audio(tts.cfg, "en-US-Fake", "en-US", ["ack"], tmp_path) == {}
    assert tts.http.calls == []


def test_reaction_deadline_omits_instead_of_raising(tts, tmp_path):
    clips = podcast_tts.synthesize_reaction_audio(tts.cfg, AVA, "en-US", ["ack"], tmp_path,
                                                  deadline=speech_rest.monotonic() - 1)
    assert clips == {} and tts.http.calls == []


def test_corrupt_cache_entries_are_resynthesized(tts, tmp_path):
    tts.http.handler = lambda ssml: make_wav(tone=0.3)
    text = podcast_media.reaction_text("fr-FR", "isee")
    budget = podcast_media.reaction_clip_budget_sec("fr-FR", "isee")
    path = tmp_path / (podcast_tts.reaction_cache_key(AVA, "fr-FR", "isee", text,
                                                      podcast_tts.tts_output_format(), budget) + ".wav")
    path.write_bytes(b"not a wav")
    clips = podcast_tts.synthesize_reaction_audio(tts.cfg, AVA, "fr-FR", ["isee"], tmp_path)
    assert clips["isee"].audio_path == path and clips["isee"].text == podcast_media.reaction_text("fr-FR", "isee")
    assert len(tts.http.calls) == 1 and podcast_tts.read_wav_info(path).frames > 0


def test_trim_to_speech_keeps_margins_and_fades_the_edges():
    data = make_wav(rate=24_000, lead=0.25, tone=0.3, tail=0.2)
    info, pcm = podcast_tts.parse_wav(data)
    trimmed = np.frombuffer(podcast_tts.trim_to_speech(pcm, info), dtype="<i2")
    assert len(trimmed) / 24_000 == pytest.approx(0.36, abs=1e-6)
    assert trimmed[0] == 0 and trimmed[-1] == 0
    with pytest.raises(podcast_tts.TtsError):
        podcast_tts.trim_to_speech(b"\x00\x00" * 24_000, info)
    blip = make_wav(rate=24_000, lead=0.25, tone=0.01, tail=0.2)
    with pytest.raises(podcast_tts.TtsError):
        podcast_tts.trim_to_speech(*reversed(podcast_tts.parse_wav(blip)))


def _trimmed_sec(data: bytes) -> float:
    info, pcm = podcast_tts.parse_wav(data)
    return len(podcast_tts.trim_to_speech(pcm, info)) / 2 / info.sample_rate


@pytest.mark.parametrize("name, segments, expected", [
    ("click 0.34 s after the phrase",
     [(0.25, 0), (0.3, 0.3), (0.34, 0), (0.01, CLICK), (0.2, 0)], 0.36),
    ("click before the phrase",
     [(0.05, 0), (0.01, CLICK), (0.2, 0), (0.3, 0.3), (0.2, 0)], 0.36),
    ("two chained clicks far from the phrase",
     [(0.25, 0), (0.3, 0.3), (0.34, 0), (0.01, CLICK), (0.1, 0), (0.02, CLICK), (0.2, 0)], 0.36),
    ("click exactly 150 ms away",
     [(0.25, 0), (0.3, 0.3), (0.15, 0), (0.055, CLICK), (0.2, 0)], 0.36),
    ("short sound close to the speech (final consonant)",
     [(0.25, 0), (0.3, 0.3), (0.1, 0), (0.03, 0.05), (0.2, 0)], 0.49),
    ("a 60 ms sound far away is speech",
     [(0.25, 0), (0.3, 0.3), (0.3, 0), (0.06, 0.05), (0.2, 0)], 0.72),
    ("two words with a comma pause ('Oui, oui.')",
     [(0.25, 0), (0.2, 0.3), (0.3, 0), (0.2, 0.3), (0.2, 0)], 0.76),
    ("a click near the second word belongs to it",
     [(0.25, 0), (0.2, 0.3), (0.3, 0), (0.2, 0.3), (0.1, 0), (0.01, CLICK), (0.2, 0)], 0.87),
    ("a click louder than the phrase is still a click (it-IT 'Già.' take)",
     [(0.25, 0), (0.3, 0.05), (0.3, 0), (0.03, 0.5), (0.2, 0)], 0.36),
    ("a faint sound split by gate flicker is one 70 ms island (de-DE 'Ja.' take)",
     [(0.25, 0), (0.3, 0.3), (0.25, 0), (0.03, CLICK), (0.005, 0), (0.015, CLICK), (0.01, 0),
      (0.01, CLICK), (0.2, 0)], 0.68),
])
def test_trim_ignores_isolated_clicks_only(name, segments, expected):
    assert _trimmed_sec(make_segments_wav(*segments)) == pytest.approx(expected, abs=1e-6), name


def _takes(*items):
    """Fake TTS answering successive takes in order (WAV bytes, Responses or exceptions)."""
    queue = list(items)
    lock = threading.Lock()

    def handler(ssml):
        with lock:
            return queue.pop(0)
    return handler


def test_a_take_over_budget_is_retaken_until_one_fits(tts, tmp_path, caplog):
    caplog.set_level(logging.INFO)
    budget = podcast_media.reaction_clip_budget_sec("en-US", "ack")
    long_tone, fitting_tone = round(budget + 0.2, 2), round(budget - 0.16, 2)
    tts.http.handler = _takes(make_wav(tone=long_tone), make_wav(tone=fitting_tone))
    clips = podcast_tts.synthesize_reaction_audio(tts.cfg, AVA, "en-US", ["ack"], tmp_path)
    assert len(tts.http.calls) == 2
    assert clips["ack"].duration_sec == pytest.approx(fitting_tone + 0.06, abs=1e-6)
    assert clips["ack"].duration_sec <= budget
    assert podcast_tts.read_wav_info(clips["ack"].audio_path).duration_sec == pytest.approx(clips["ack"].duration_sec)
    assert "over budget (id=ack)" in caplog.text and "Ava" not in caplog.text and "Mm-hmm" not in caplog.text
    again = podcast_tts.synthesize_reaction_audio(tts.cfg, AVA, "en-US", ["ack"], tmp_path)
    assert len(tts.http.calls) == 2 and again["ack"].audio_path == clips["ack"].audio_path


def test_clicks_do_not_trigger_retakes(tts, tmp_path):
    budget = podcast_media.reaction_clip_budget_sec("en-US", "right")
    tone = round(budget - 0.16, 2)
    tts.http.handler = lambda ssml: make_segments_wav((0.25, 0), (tone, 0.3), (0.34, 0), (0.01, CLICK), (0.15, 0))
    clips = podcast_tts.synthesize_reaction_audio(tts.cfg, AVA, "en-US", ["right"], tmp_path)
    assert len(tts.http.calls) == 1 and clips["right"].duration_sec == pytest.approx(tone + 0.06, abs=1e-6)


def test_no_take_within_budget_keeps_the_shortest(tts, tmp_path, caplog):
    caplog.set_level(logging.INFO)
    budget = podcast_media.reaction_clip_budget_sec("en-US", "yeah")
    tones = [round(budget + d, 2) for d in (0.4, 0.2, 0.3)]
    tts.http.handler = _takes(*(make_wav(tone=t) for t in tones))
    clips = podcast_tts.synthesize_reaction_audio(tts.cfg, AVA, "en-US", ["yeah"], tmp_path)
    assert len(tts.http.calls) == podcast_tts.REACTION_MAX_TAKES == 3
    assert clips["yeah"].duration_sec == pytest.approx(min(tones) + 0.06, abs=1e-6)
    assert clips["yeah"].duration_sec > budget
    assert "over budget after 3 takes (id=yeah)" in caplog.text
    podcast_tts.synthesize_reaction_audio(tts.cfg, AVA, "en-US", ["yeah"], tmp_path)
    assert len(tts.http.calls) == 3  # the best take is cached for this budget: no re-takes next time


def test_a_failed_retake_keeps_the_best_take(tts, tmp_path):
    budget = podcast_media.reaction_clip_budget_sec("en-US", "isee")
    first, third = round(budget + 0.2, 2), round(budget + 0.3, 2)
    tts.http.handler = _takes(make_wav(tone=first), make_response(400, b"bad"), make_wav(tone=third))
    clips = podcast_tts.synthesize_reaction_audio(tts.cfg, AVA, "en-US", ["isee"], tmp_path)
    assert len(tts.http.calls) == 3
    assert clips["isee"].duration_sec == pytest.approx(first + 0.06, abs=1e-6)


def test_retakes_stop_at_the_deadline(tts, tmp_path, monkeypatch):
    clock = {"now": 100.0}
    monkeypatch.setattr(speech_rest, "_monotonic", lambda: clock["now"])
    budget = podcast_media.reaction_clip_budget_sec("en-US", "exactly")
    long_tone = round(budget + 0.2, 2)

    def slow(ssml):
        clock["now"] += 10.0
        return make_wav(tone=long_tone)

    tts.http.handler = slow
    clips = podcast_tts.synthesize_reaction_audio(tts.cfg, AVA, "en-US", ["exactly"], tmp_path, deadline=105.0)
    assert len(tts.http.calls) == 1
    assert clips["exactly"].duration_sec == pytest.approx(long_tone + 0.06, abs=1e-6)


def test_audio_only_mode_has_zero_avatar_calls_end_to_end(tts, tmp_path):
    tts.http.handler = lambda ssml: make_wav(tone=0.3)
    podcast_tts.synthesize_turns(tts.cfg, make_script(), make_roles(), tmp_path / "turns", pauses={1: {2: 600}})
    podcast_tts.synthesize_reaction_audio(tts.cfg, ANDREW, "en-US", list(podcast_media.REACTION_IDS),
                                          tmp_path / "rx")
    urls = {c["url"] for c in tts.http.calls}
    assert urls == {TTS_URL}
    assert not any("avatar" in json.dumps(c.get("json") or {}) for c in tts.http.calls)
