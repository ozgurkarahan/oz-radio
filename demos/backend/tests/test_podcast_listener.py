"""Listener kit (services.podcast_listener): no Azure, synthetic footage.

A fake ``run_batch_avatar_job`` parses the kit SSML and renders matching
synthetic footage with ffmpeg: green 25 fps video with a textured "face"
that sways (6 s period) and blinks (3 s period) during the idle section,
and smoothed tone bursts as the phrases (silence between them, trailing
break truncated like the service does). The main end-to-end kit is
512×512 with the real en-US phrases; the other builds use 256×256 footage
and two phrases to keep the suite fast.
"""
from __future__ import annotations

import hashlib
import json
import logging
import shutil
import subprocess
import threading
import time
import uuid
import wave
import xml.etree.ElementTree as ET
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

import services.podcast_listener as pl
from services import avatar_registry
from services.podcast_media import (
    REACTION_IDS,
    WARNING_LISTENER_FALLBACK,
    WARNING_LISTENER_STATIC,
    WARNING_LISTENER_TIMEOUT,
    WARNING_REACTIONS_SKIPPED,
)

FFMPEG = shutil.which("ffmpeg")
needs_ffmpeg = pytest.mark.skipif(FFMPEG is None or shutil.which("ffprobe") is None,
                                  reason="ffmpeg/ffprobe not on PATH")

SENTINEL = "Zq9SentinelCharacterXv7"
VOICE_F = "en-US-Ava:DragonHDLatestNeural"
VOICE_M = "en-US-Andrew:DragonHDLatestNeural"
SYN = "{http://www.w3.org/2001/10/synthesis}"
CHEAP_PHRASES = (("Mm-hmm.", ("ack", "right", "yeah")), ("Interesting.", ("exactly", "isee", "interesting")))


def _registry(*, female: str = SENTINEL, male: str = SENTINEL + "Male") -> str:
    return json.dumps([
        {"id": "photo_female", "display_name": "Photo Female", "character": female, "gender": "female",
         "kind": "photo", "default": True},
        {"id": "photo_male", "display_name": "Photo Male", "character": male, "gender": "male", "kind": "photo"},
    ])


def _cfg() -> SimpleNamespace:
    # Never config.load_config(): it would reload a developer .env (real blob storage).
    return SimpleNamespace(use_managed_identity=False, blob_account_name="", blob_connection_string="",
                           blob_container="", speech_region="test", speech_endpoint="", speech_key="")


def _roles(interviewer: str = "photo_female", expert: str = "photo_male",
           v1: str = VOICE_F, v2: str = VOICE_M) -> SimpleNamespace:
    return SimpleNamespace(interviewer=SimpleNamespace(avatar=interviewer, voice=v1, display_name="A"),
                           expert=SimpleNamespace(avatar=expert, voice=v2, display_name="B"))


# ---------------------------------------------------------------------------
# Synthetic kit footage
# ---------------------------------------------------------------------------

def _ssml_events(ssml: str) -> list[tuple[str, object]]:
    voice = ET.fromstring(ssml).find(f"{SYN}voice")
    assert voice is not None
    events: list[tuple[str, object]] = []
    if (voice.text or "").strip():
        events.append(("text", voice.text.strip()))
    for child in voice:
        assert child.tag == f"{SYN}break", child.tag
        events.append(("break", int(child.get("time", "0ms").removesuffix("ms"))))
        if (child.tail or "").strip():
            events.append(("text", child.tail.strip()))
    return events


def _layout(ssml: str) -> tuple[list[tuple[float, float]], float]:
    """Phrase spans + total length the "service" renders for this SSML."""
    events = _ssml_events(ssml)
    last_text = max(i for i, (kind, _) in enumerate(events) if kind == "text")
    t, spans = 0.0, []
    for i, (kind, value) in enumerate(events):
        if kind == "break":
            if i > last_text:
                t += min(int(value), 150) / 1000.0  # trailing silence is truncated
            else:
                t += int(value) / 1000.0 + (0.1 if spans else 0.0)  # voice edge silence
        else:
            dur = 0.22 + 0.03 * len(str(value))
            spans.append((round(t, 3), round(t + dur, 3)))
            t += dur
    return spans, round(t, 3)


_FOOTAGE: dict[tuple, Path] = {}
_FOOTAGE_LOCK = threading.Lock()


def _render_footage(dest: Path, spans: list[tuple[float, float]], total: float, *, size: int,
                    motion: bool) -> None:
    fw, fh = int(size * 0.39) // 2 * 2, int(size * 0.47) // 2 * 2
    ew, eh = int(size * 0.24) // 2 * 2, max(2, int(size * 0.045) // 2 * 2)
    cx, cy = (size - fw) // 2, (size - fh) // 2 - size // 30
    if motion:
        x = f"{cx}+{size * 0.06:.2f}*sin(2*PI*t/6)"
        y = f"{cy}+{size * 0.016:.2f}*sin(2*PI*t/3)"
    else:
        x, y = str(cx), str(cy)
    gates = "+".join(f"between(t,{s:.3f},{e:.3f})*min(1,min((t-{s:.3f})/0.01,({e:.3f}-t)/0.01))"
                     for s, e in spans) or "0"
    graph = (f"[1:v]format=yuv420p,geq=lum='128+90*sin(X/{size / 100:.2f})*cos(Y/{size / 85:.2f})':"
             f"cb=110:cr=150[face];[0:v][face]overlay=x='{x}':y='{y}'[a]")
    if motion:
        graph += (f";[a][2:v]overlay=x='{x}+{(fw - ew) // 2}':y='{y}+{fh // 3}':"
                  f"enable='lt(mod(t,3),0.16)'[v]")
    else:
        graph += ";[a]null[v]"
    d = f"{total:.3f}"
    cmd = [FFMPEG, "-hide_banner", "-loglevel", "error", "-y",
           "-f", "lavfi", "-i", f"color=c=0x00FF00:s={size}x{size}:r=25:d={d}",
           "-f", "lavfi", "-i", f"color=c=black:s={fw}x{fh}:r=25:d={d}",
           "-f", "lavfi", "-i", f"color=c=0x1E1E1E:s={ew}x{eh}:r=25:d={d}",
           "-f", "lavfi", "-i", f"aevalsrc='0.3*sin(2*PI*330*t)*({gates})':s=16000:d={d}",
           "-filter_complex", graph, "-map", "[v]", "-map", "3:a",
           "-c:v", "libx264", "-preset", "ultrafast", "-crf", "14", "-pix_fmt", "yuv420p", "-g", "50",
           "-c:a", "aac", "-b:a", "64k", "-ar", "16000", "-ac", "1", "-t", d, str(dest)]
    subprocess.run(cmd, check=True, capture_output=True, timeout=300)


def _footage_for(ssml: str, root: Path, *, size: int, motion: bool, drop: int) -> Path:
    spans, total = _layout(ssml)
    spans = spans[: len(spans) - drop] if drop else spans
    key = (tuple(spans), total, size, motion)
    with _FOOTAGE_LOCK:
        cached = _FOOTAGE.get(key)
        if cached is not None and cached.is_file():
            return cached
        root.mkdir(parents=True, exist_ok=True)
        dest = root / f"footage-{hashlib.sha256(repr(key).encode()).hexdigest()[:16]}.mp4"
        _render_footage(dest, spans, total, size=size, motion=motion)
        _FOOTAGE[key] = dest
        return dest


class FakeBatch:
    """Stands in for ``podcast_render.run_batch_avatar_job`` (agreed signature)."""

    def __init__(self, root: Path, *, size: int = 256, motion: bool = True, drop: int = 0,
                 error: BaseException | None = None):
        self.root, self.size, self.motion, self.drop, self.error = root, size, motion, drop, error
        self.calls: list[dict] = []
        self._lock = threading.Lock()

    def __call__(self, cfg, ssml, entry, out_path, *, label, deadline=None, poll_interval=5.0,
                 avatar_config_overrides=None):
        with self._lock:
            self.calls.append({"ssml": ssml, "avatar_id": entry.id, "label": label, "deadline": deadline,
                               "overrides": avatar_config_overrides})
        if self.error is not None:
            raise self.error
        src = _footage_for(ssml, self.root, size=self.size, motion=self.motion, drop=self.drop)
        self.last_src = src
        shutil.copyfile(src, out_path)
        return SimpleNamespace(video_path=Path(out_path), duration_sec=_layout(ssml)[1])


def _slow_batch(cfg, ssml, entry, out_path, *, label, deadline=None, **_kw):
    """Behaves like the real helper at its deadline: stops polling, raises TimeoutError."""
    while deadline is not None and time.monotonic() < deadline:
        time.sleep(0.02)
    raise TimeoutError("batch job deadline")


class _Exists(Exception):
    status_code = 409


class _Missing(Exception):
    status_code = 404


class FakeContainer:
    """In-memory blob container (create-if-absent semantics, ETags, upload order)."""

    def __init__(self):
        self.blobs: dict[str, bytes] = {}
        self.etags: dict[str, str] = {}
        self.order: list[str] = []
        self.deleted: list[str] = []

    def get_blob_client(self, name: str) -> "_FakeBlob":
        return _FakeBlob(self, name)


class _FakeBlob:
    def __init__(self, container: FakeContainer, name: str):
        self.c, self.name = container, name

    def upload_blob(self, data, overwrite=False, content_settings=None, **_kw):
        if not overwrite and self.name in self.c.blobs:
            raise _Exists("exists")
        self.c.blobs[self.name] = bytes(data)
        self.c.etags[self.name] = uuid.uuid4().hex
        self.c.order.append(self.name)

    def download_blob(self, **_kw):
        if self.name not in self.c.blobs:
            raise _Missing("missing")
        data, etag = self.c.blobs[self.name], self.c.etags[self.name]
        return SimpleNamespace(readall=lambda: data, properties=SimpleNamespace(etag=etag))

    def delete_blob(self, etag=None, match_condition=None, **_kw):
        if self.name not in self.c.blobs:
            raise _Missing("missing")
        if etag is not None and self.c.etags[self.name] != etag:
            raise RuntimeError("condition not met")
        del self.c.blobs[self.name]
        self.c.deleted.append(self.name)


# ---------------------------------------------------------------------------
# Media helpers
# ---------------------------------------------------------------------------

def _decode(path: Path, vf: str, pix: str, size: tuple[int, int], channels: int) -> np.ndarray:
    raw = subprocess.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-c:v", "libvpx-vp9", "-i", str(path),
                          "-vf", vf, "-f", "rawvideo", "-pix_fmt", pix, "-"],
                         check=True, capture_output=True, timeout=120).stdout
    w, h = size
    return np.frombuffer(raw, np.uint8).reshape(-1, h, w, channels) if channels > 1 else \
        np.frombuffer(raw, np.uint8).reshape(-1, h, w)


def _wav(path: Path) -> tuple[int, int, np.ndarray]:
    with wave.open(str(path), "rb") as w:
        rate, ch, n = w.getframerate(), w.getnchannels(), w.getnframes()
        data = np.frombuffer(w.readframes(n), np.int16).astype(np.float32) / 32768.0
    return rate, ch, data


def _mse(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.mean((a.astype(np.float64) - b.astype(np.float64)) ** 2))


def _scan_tree(root: Path, needle: str) -> list[str]:
    """Paths whose name or bytes contain ``needle`` (case-insensitive)."""
    low = needle.lower().encode("utf-8")
    hits = []
    for p in root.rglob("*"):
        if needle.lower() in p.name.lower():
            hits.append(str(p))
        elif p.is_file() and low in p.read_bytes().lower():
            hits.append(str(p))
    return hits


class _ListHandler(logging.Handler):
    def __init__(self, records: list[logging.LogRecord]):
        super().__init__(logging.DEBUG)
        self.records = records

    def emit(self, record: logging.LogRecord) -> None:
        self.records.append(record)


def _ensure(avatar: str = "photo_female", voice: str = VOICE_F, *, want_reactions: bool = True,
            deadline: float | None = 600.0):
    return pl.ensure_listener_kit(_cfg(), avatar, voice, "en-US", want_reactions=want_reactions,
                                  deadline=None if deadline is None else time.monotonic() + deadline)


def _manifest(kit) -> dict:
    return json.loads((kit.idle.path.parent / "kit.json").read_text(encoding="utf-8")) if kit.idle else {}


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def footage_root(tmp_path_factory) -> Path:
    return tmp_path_factory.mktemp("listener_footage")


@pytest.fixture(scope="module")
def main_kit(tmp_path_factory, footage_root):
    """One real build: 512×512 alive footage, the en-US phrases, fake blob cache, captured logs."""
    if FFMPEG is None or shutil.which("ffprobe") is None:
        pytest.skip("ffmpeg/ffprobe not on PATH")
    root = tmp_path_factory.mktemp("listener_main")
    fake = FakeBatch(footage_root, size=512)
    container = FakeContainer()
    records: list[logging.LogRecord] = []
    handler = _ListHandler(records)
    root_logger = logging.getLogger()
    with pytest.MonkeyPatch.context() as mp:
        mp.setenv("PODCAST_LISTENER_MODE", "auto")
        mp.setattr(pl, "L1_ROOT", root / "l1")
        mp.setattr(pl, "_batch_runner", lambda: fake)
        mp.setattr(pl, "_l2_container", lambda cfg: container)
        avatar_registry.reload(_registry())
        old_level = root_logger.level
        root_logger.addHandler(handler)
        root_logger.setLevel(logging.DEBUG)
        try:
            kit = _ensure()
        finally:
            root_logger.removeHandler(handler)
            root_logger.setLevel(old_level)
            avatar_registry.reload("")
    assert kit.idle is not None, kit
    kit_dir = kit.idle.path.parent
    return SimpleNamespace(kit=kit, kit_dir=kit_dir, key=kit_dir.name, l1=root / "l1", fake=fake,
                           container=container, records=records, manifest=_manifest(kit))


@pytest.fixture
def cheap(monkeypatch, tmp_path, footage_root):
    """Fast builds: two phrases (all six ids), 256×256 footage, no blob cache."""
    monkeypatch.setenv("PODCAST_LISTENER_MODE", "auto")
    monkeypatch.setattr(pl, "L1_ROOT", tmp_path / "l1")
    monkeypatch.setattr(pl, "kit_phrases", lambda language: CHEAP_PHRASES)
    monkeypatch.setattr(pl, "_l2_container", lambda cfg: None)
    avatar_registry.reload(_registry())

    def install(fake):
        monkeypatch.setattr(pl, "_batch_runner", lambda: fake)
        return fake

    return SimpleNamespace(l1=tmp_path / "l1", tmp=tmp_path, footage=footage_root, install=install)


# ---------------------------------------------------------------------------
# Pure units (no ffmpeg)
# ---------------------------------------------------------------------------

def test_signature_vf_contract():
    assert pl.SIGNATURE_VF == "crop=iw*0.6:ih*0.6:iw*0.2:ih*0.2,scale=64:64:flags=area,format=gray"
    assert pl.MOTION_VF == "crop=iw*0.6:ih*0.6:iw*0.2:ih*0.2,scale=128:128:flags=area,format=gray"
    assert pl.CHROMA_VF.startswith("chromakey=0x00ff00:0.22:0.12,despill=type=green")
    assert "-auto-alt-ref" in pl.VP9_ARGS and "yuva420p" in pl.VP9_ARGS


def test_build_kit_ssml_layout_and_escaping():
    ssml = pl.build_kit_ssml('en-US-Ava:"Dragon"', "en-US", ["Mm-hmm.", "A & B <c>", "Right."])
    root = ET.fromstring(ssml)
    assert root.get("{http://www.w3.org/XML/1998/namespace}lang") == "en-US"
    voice = root.find(f"{SYN}voice")
    assert voice.get("name") == 'en-US-Ava:"Dragon"'
    events = _ssml_events(ssml)
    assert events == [("break", 250), ("break", 12000), ("text", "Mm-hmm."), ("break", 1500),
                      ("text", "A & B <c>"), ("break", 1500), ("text", "Right."), ("break", 600)]
    assert ET.fromstring(pl.build_kit_ssml(VOICE_F, "not a lang!", ["Yes."])).get(
        "{http://www.w3.org/XML/1998/namespace}lang") == "en-US"
    with pytest.raises(pl.ListenerKitError):
        pl.build_kit_ssml(VOICE_F, "en-US", ["  "])


def test_kit_phrases_dedupes_identical_texts(monkeypatch):
    texts = {"ack": "Oui.", "right": "D'accord.", "yeah": "Oui.", "exactly": "Exactement.",
             "isee": "Je vois.", "interesting": "Intéressant."}
    monkeypatch.setattr(pl, "reaction_text", lambda language, rid: texts[rid])
    phrases = pl.kit_phrases("fr-FR")
    assert phrases[0] == ("Oui.", ("ack", "yeah"))
    assert [t for t, _ in phrases] == ["Oui.", "D'accord.", "Exactement.", "Je vois.", "Intéressant."]
    assert sorted(i for _, ids in phrases for i in ids) == sorted(REACTION_IDS)


def test_kit_phrases_cover_every_reaction_id():
    for language in ("en-US", "fr-FR", "de-DE", "xx-YY"):
        phrases = pl.kit_phrases(language)
        assert phrases and sorted(i for _, ids in phrases for i in ids) == sorted(REACTION_IDS)
        assert len({t for t, _ in phrases}) == len(phrases)


def test_kit_key_is_stable_and_input_sensitive():
    avatar_registry.reload(_registry())
    entry = avatar_registry.get("photo_female")
    phrases = pl.kit_phrases("en-US")
    key = pl.kit_key(entry, VOICE_F, "en-US", phrases)
    assert len(key) == 24 and all(c in "0123456789abcdef" for c in key)
    assert key == pl.kit_key(entry, VOICE_F, "en-US", phrases)
    assert SENTINEL.lower() not in key
    assert key != pl.kit_key(entry, VOICE_M, "en-US", phrases)
    assert key != pl.kit_key(entry, VOICE_F, "fr-FR", phrases)
    assert key != pl.kit_key(entry, VOICE_F, "en-US", phrases[:-1])
    avatar_registry.reload(_registry(female="AnotherCharacter"))
    assert key != pl.kit_key(avatar_registry.get("photo_female"), VOICE_F, "en-US", phrases)


def _periodic_signatures(n: int, period: int, seed: int = 1) -> np.ndarray:
    rng = np.random.default_rng(seed)
    base = rng.integers(0, 256, size=(period, 64, 64)).astype(np.float64)
    smooth = np.stack([(base[k] + base[(k + 1) % period]) / 2 for k in range(period)])
    return np.stack([smooth[k % period] for k in range(n)]).astype(np.uint8)


def test_find_loop_forward_pingpong_and_short():
    sig = _periodic_signatures(240, 150)
    choice = pl.find_loop(sig, 25)
    assert choice.kind == "forward" and choice.end - choice.start == 150 and choice.seam_mse == 0.0
    assert choice.frames == 150 - pl.crossfade_frames(25)
    # A blob drifting steadily never comes back: no acceptable forward pair -> 4 s ping-pong.
    yy, xx = np.mgrid[0:64, 0:64]
    drift = np.stack([200 * np.exp(-((xx - (5 + 0.2 * t)) ** 2 + (yy - 32) ** 2) / 30.0)
                      for t in range(240)]).astype(np.uint8)
    pp = pl.find_loop(drift, 25)
    assert pp.kind == "pingpong" and pp.end - pp.start == 100 and pp.frames == 198
    assert pl.find_loop(drift[:40], 25) is None


def test_write_loop_raw_crossfade(tmp_path):
    frames = np.stack([np.full(12, v, np.uint8) for v in range(0, 200, 10)])  # 20 "frames"
    choice = pl.LoopChoice("forward", 0, 20, 0.0, 0.0, 20 - 7)
    out = tmp_path / "loop.raw"
    n = pl._write_loop_raw(frames, choice, 7, out)
    data = np.frombuffer(out.read_bytes(), np.uint8).reshape(-1, 12)[:, 0]
    assert n == 13 and len(data) == 13
    # head = tail (13..19) blended into head (0..6); body = frames 7..12
    expected_head = [round(int(frames[13 + k, 0]) * (1 - (k + 1) / 8) + int(frames[k, 0]) * (k + 1) / 8)
                     for k in range(7)]
    assert list(data[:7]) == expected_head and list(data[7:]) == [70, 80, 90, 100, 110, 120]
    pp = pl._write_loop_raw(frames[:5], pl.LoopChoice("pingpong", 0, 5, 0.0, 0.0, 8), 7, out)
    assert pp == 8 and list(np.frombuffer(out.read_bytes(), np.uint8).reshape(-1, 12)[:, 0]) == \
        [0, 10, 20, 30, 40, 30, 20, 10]


def test_islands_merge_and_drop():
    silences = [(0.0, 12.3), (12.6, 12.9), (13.0, 14.6), (14.62, 14.64), (15.0, 16.0)]
    # (12.3, 12.6) + (12.9, 13.0) merge (gap < 0.7 s); (14.6, 14.62) is too short; tail runs to the end.
    assert pl._islands(silences, 17.0) == [(12.3, 13.0), (14.64, 15.0), (16.0, 17.0)]
    assert pl._islands([(0.0, float("inf"))], 10.0) == []


def test_clip_frames_snap_outward():
    k0, k1 = pl._clip_frames(12.275, 12.58, 25, 672)
    assert (k0, k1) == (305, 316)  # [12.215, 12.64] -> frames 305..315
    assert k0 / 25 <= 12.275 - 0.06 + 1e-9 and k1 / 25 >= 12.58 + 0.06 - 1e-9
    assert pl._clip_frames(0.02, 26.87, 25, 672) == (0, 672)


def test_fallback_kits_carry_stable_codes():
    kit = pl._fallback_kit("photo_female", VOICE_F, "auto", True, timeout=True)
    assert (kit.mode, kit.idle, kit.reactions) == ("procedural", None, {})
    assert kit.warnings == (WARNING_LISTENER_FALLBACK, WARNING_LISTENER_TIMEOUT, WARNING_REACTIONS_SKIPPED)
    still = pl._fallback_kit("photo_female", VOICE_F, "still", False)
    assert still.mode == "still" and still.warnings == ()
    proc = pl._fallback_kit("photo_female", VOICE_F, "procedural", True)
    assert proc.mode == "procedural" and proc.warnings == (WARNING_REACTIONS_SKIPPED,)


def test_batch_runner_is_the_render_helper():
    from services import podcast_render

    if not hasattr(podcast_render, "run_batch_avatar_job"):
        pytest.skip("podcast_render.run_batch_avatar_job not available yet")
    assert pl._batch_runner() is podcast_render.run_batch_avatar_job


@pytest.mark.parametrize("mode", ["still", "procedural"])
def test_capped_modes_skip_synthesis(cheap, monkeypatch, mode):
    monkeypatch.setenv("PODCAST_LISTENER_MODE", mode)
    fake = cheap.install(FakeBatch(cheap.footage))
    kits = pl.resolve_listener_kits(_cfg(), _roles(), "en-US", want_reactions=False,
                                    deadline=time.monotonic() + 60)
    assert not fake.calls
    assert {r: (k.avatar_id, k.voice) for r, k in kits.items()} == {
        "interviewer": ("photo_female", VOICE_F), "expert": ("photo_male", VOICE_M)}
    for kit in kits.values():
        assert (kit.mode, kit.idle, kit.reactions, kit.warnings) == (mode, None, {}, ())


def test_unsupported_and_unknown_avatars_fall_back_without_synthesis(cheap):
    avatar_registry.reload("")  # stock avatars only: VP9 video avatars, no chroma key
    fake = cheap.install(FakeBatch(cheap.footage))
    kit = _ensure("lisa")
    assert (kit.mode, kit.idle, kit.reactions) == ("procedural", None, {})
    assert kit.warnings == (WARNING_LISTENER_FALLBACK, WARNING_REACTIONS_SKIPPED)
    unknown = _ensure("no_such_avatar", want_reactions=False)
    assert unknown.mode == "procedural" and unknown.warnings == (WARNING_LISTENER_FALLBACK,)
    assert not fake.calls


def test_resolve_never_raises_and_never_logs_error_text(cheap, caplog):
    cheap.install(FakeBatch(cheap.footage, error=RuntimeError(f"boom {SENTINEL} payload")))
    caplog.set_level(logging.DEBUG)
    kits = pl.resolve_listener_kits(_cfg(), _roles(), "en-US", want_reactions=True,
                                    deadline=time.monotonic() + 60)
    assert set(kits) == {"interviewer", "expert"}
    for kit in kits.values():
        assert (kit.mode, kit.idle, kit.reactions) == ("procedural", None, {})
        assert kit.warnings == (WARNING_LISTENER_FALLBACK, WARNING_REACTIONS_SKIPPED)
    assert SENTINEL.lower() not in caplog.text.lower() and "payload" not in caplog.text


def test_past_deadline_never_submits(cheap):
    fake = cheap.install(FakeBatch(cheap.footage))
    kits = pl.resolve_listener_kits(_cfg(), _roles(), "en-US", want_reactions=False,
                                    deadline=time.monotonic() - 1.0)
    assert not fake.calls
    for kit in kits.values():
        assert kit.mode == "procedural" and kit.warnings == (WARNING_LISTENER_FALLBACK, WARNING_LISTENER_TIMEOUT)


@needs_ffmpeg
def test_job_timeout_gives_timeout_fallback(cheap):
    cheap.install(FakeBatch(cheap.footage, error=TimeoutError("batch job deadline")))
    kit = _ensure()
    assert (kit.mode, kit.idle, kit.reactions) == ("procedural", None, {})
    assert kit.warnings == (WARNING_LISTENER_FALLBACK, WARNING_LISTENER_TIMEOUT, WARNING_REACTIONS_SKIPPED)


@needs_ffmpeg
def test_resolve_returns_at_the_deadline(cheap):
    cheap.install(_slow_batch)
    started = time.monotonic()
    kits = pl.resolve_listener_kits(_cfg(), _roles(), "en-US", want_reactions=False,
                                    deadline=time.monotonic() + 1.0)
    assert time.monotonic() - started < 6.0
    for kit in kits.values():
        assert kit.mode == "procedural" and WARNING_LISTENER_TIMEOUT in kit.warnings
        assert WARNING_LISTENER_FALLBACK in kit.warnings


# ---------------------------------------------------------------------------
# Main kit: 512×512, en-US phrases (one real build, shared)
# ---------------------------------------------------------------------------

@needs_ffmpeg
def test_main_kit_idle_loop(main_kit):
    kit, m = main_kit.kit, main_kit.manifest
    assert (kit.mode, kit.warnings, kit.avatar_id, kit.voice) == ("idle_loop", (), "photo_female", VOICE_F)
    idle = kit.idle
    assert idle.has_alpha and not idle.static and idle.path.suffix == ".webm"
    assert idle.motion_score >= pl.MOTION_ALIVE and m["idle"]["motion_class"] == "alive"
    loop = m["idle"]["loop"]
    span = round((loop["source_sec"][1] - loop["source_sec"][0]) * 25)
    assert loop["kind"] == "forward" and span == 150  # the synthetic idle repeats every 6 s
    assert loop["crossfade_frames"] == pl.crossfade_frames(25) == 7
    assert m["idle"]["frames"] == span - 7 and idle.duration_sec == pytest.approx((span - 7) / 25)
    first_onset = m["phrases"]["first_onset_sec"]
    assert first_onset == pytest.approx(12.25, abs=0.08)
    assert m["idle"]["window_sec"][0] == 1.0
    assert m["idle"]["window_sec"][1] == pytest.approx(first_onset - 1.5, abs=0.041)
    assert loop["source_sec"][0] >= 1.0 and loop["source_sec"][1] <= m["idle"]["window_sec"][1]


@needs_ffmpeg
def test_main_kit_loop_alpha_frames_and_seam(main_kit):
    idle, frames = main_kit.kit.idle, main_kit.manifest["idle"]["frames"]
    alpha = _decode(idle.path, "alphaextract", "gray", (512, 512), 1)
    assert alpha.shape[0] == frames
    assert (alpha[0] == 0).mean() > 0.3 and (alpha[0] == 255).mean() > 0.05  # keyed bg, opaque face
    rgba = _decode(idle.path, "scale=128:128:flags=area,format=rgba", "rgba", (128, 128), 4).astype(np.float64)
    visible = rgba[..., :3] * (rgba[..., 3:] / 255.0)
    steps = [_mse(visible[k], visible[k + 1]) for k in range(len(visible) - 1)]
    wrap = _mse(visible[-1], visible[0])
    assert wrap <= 3.0 * float(np.percentile(steps, 95)) + 1.0
    assert wrap * 4 < _mse(visible[0], visible[len(visible) // 2])
    # Encoded loop length is exact (seamless -stream_loop playback).
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0",
                          str(idle.path)], capture_output=True, text=True, check=True).stdout
    assert float(out) == pytest.approx(frames / 25, abs=0.001)


@needs_ffmpeg
def test_main_kit_signature_npz(main_kit):
    idle, m = main_kit.kit.idle, main_kit.manifest
    with np.load(idle.signature_path, allow_pickle=False) as data:
        assert sorted(data.files) == ["fps", "frames"]
    sig, fps = pl.load_signature(idle.signature_path)
    assert sig.dtype == np.uint8 and sig.shape == (m["idle"]["frames"], 64, 64) and fps == 25.0
    # Loop order, unkeyed: body frames are exactly the source footage signatures.
    src = pl.signature_frames(main_kit.fake.last_src)
    start = round(m["idle"]["loop"]["source_sec"][0] * 25)
    for k in range(7, sig.shape[0]):
        assert np.array_equal(sig[k], src[start + k]), k
    steps = [_mse(sig[k], sig[k + 1]) for k in range(len(sig) - 1)]
    assert _mse(sig[-1], sig[0]) <= 3.0 * float(np.percentile(steps, 95)) + 1.0
    assert m["idle"]["loop"]["first_last_mse"] == pytest.approx(_mse(sig[0], sig[-1]), abs=1e-3)


@needs_ffmpeg
def test_main_kit_reactions(main_kit):
    kit = main_kit.kit
    phrases = pl.kit_phrases("en-US")
    spans, _total = _layout(main_kit.fake.calls[0]["ssml"])
    assert len(spans) == len(phrases)
    span_of = {text: span for (text, _ids), span in zip(phrases, spans)}
    assert set(kit.reactions) == set(REACTION_IDS)
    for rid, clip in kit.reactions.items():
        assert clip.reaction_id == rid and clip.text == pl.reaction_text("en-US", rid) and clip.has_alpha
        assert clip.video_path.suffix == ".webm" and clip.audio_path.suffix == ".wav"
        s, e = span_of[clip.text]
        expected = (e - s) + 2 * pl.CLIP_MARGIN_SEC
        assert expected - 0.01 <= clip.duration_sec <= expected + 0.2, (rid, clip.duration_sec, expected)
        n_frames = round(clip.duration_sec * 25)
        assert clip.duration_sec * 25 == pytest.approx(n_frames)
        alpha = _decode(clip.video_path, "alphaextract", "gray", (512, 512), 1)
        assert alpha.shape[0] == n_frames and alpha.min() == 0 and alpha.max() == 255
        rate, channels, x = _wav(clip.audio_path)
        assert (rate, channels, len(x)) == (48000, 1, round(clip.duration_sec * 48000))
        assert float(np.sqrt(np.mean(x ** 2))) > 0.05
        assert float(np.max(np.abs(x[:1440]))) < 0.05 and float(np.max(np.abs(x[-1440:]))) < 0.05


@needs_ffmpeg
def test_main_kit_sidecar_and_layout(main_kit):
    m, kit_dir = main_kit.manifest, main_kit.kit_dir
    assert m["version"] == pl.KIT_VERSION and m["key"] == kit_dir.name and len(kit_dir.name) == 24
    assert (m["avatar_id"], m["voice"], m["language"]) == ("photo_female", VOICE_F, "en-US")
    assert m["created_at"] and m["phrases"]["status"] == "ok"
    assert sorted(p.name for p in kit_dir.iterdir()) == sorted([*m["files"], "kit.json"])
    for name, meta in m["files"].items():
        data = (kit_dir / name).read_bytes()
        assert len(data) == meta["bytes"] and hashlib.sha256(data).hexdigest() == meta["sha256"]
        assert name.startswith(meta["sha256"][:20])
    for r in m["reactions"].values():
        assert {"text", "duration_sec", "video_file", "audio_file"} <= set(r)
    text = json.dumps(m).lower()
    assert not any(word in text for word in ("foundry", "character", "talkingavatar"))
    # Nothing else under the cache root (staging and retained footage are gone).
    assert sorted(p.name for p in main_kit.l1.iterdir()) in ([kit_dir.name], sorted([kit_dir.name, ".footage"]))
    assert not list((main_kit.l1 / ".footage").glob("*")) if (main_kit.l1 / ".footage").exists() else True


@needs_ffmpeg
def test_main_kit_never_leaks_the_character_name(main_kit):
    assert main_kit.fake.calls and main_kit.records
    assert not _scan_tree(main_kit.l1, SENTINEL)
    for name, data in main_kit.container.blobs.items():
        assert SENTINEL.lower() not in name.lower() and SENTINEL.lower().encode() not in data.lower()
    for record in main_kit.records:
        assert SENTINEL.lower() not in record.getMessage().lower()
    for call in main_kit.fake.calls:
        assert SENTINEL not in call["ssml"] and SENTINEL not in call["label"]
        assert call["overrides"] is None


@needs_ffmpeg
def test_main_kit_blob_cache_layout(main_kit):
    prefix = f"podcast-cache/listener-kit/{main_kit.key}/"
    names = main_kit.container.order
    assert names[-1] == prefix + "kit.json"
    assert all(n.startswith(prefix) and "podcast-library" not in n for n in names)
    assert sorted(n[len(prefix):] for n in names) == sorted([*main_kit.manifest["files"], "kit.json"])
    assert main_kit.container.blobs[prefix + "kit.json"] == (main_kit.kit_dir / "kit.json").read_bytes()


@needs_ffmpeg
def test_l1_cache_hit_does_not_resubmit(main_kit, monkeypatch):
    monkeypatch.setenv("PODCAST_LISTENER_MODE", "auto")
    monkeypatch.setattr(pl, "L1_ROOT", main_kit.l1)
    monkeypatch.setattr(pl, "_batch_runner", lambda: main_kit.fake)
    monkeypatch.setattr(pl, "_l2_container", lambda cfg: None)
    avatar_registry.reload(_registry())
    assert len(main_kit.fake.calls) == 1
    kit = _ensure()
    assert len(main_kit.fake.calls) == 1 and kit == main_kit.kit


@needs_ffmpeg
def test_l2_restores_the_kit_without_synthesis(main_kit, monkeypatch, tmp_path):
    container = FakeContainer()
    container.blobs, container.etags = dict(main_kit.container.blobs), dict(main_kit.container.etags)
    boom = FakeBatch(tmp_path, error=AssertionError("must not synthesize"))
    monkeypatch.setenv("PODCAST_LISTENER_MODE", "auto")
    monkeypatch.setattr(pl, "L1_ROOT", tmp_path / "l1")
    monkeypatch.setattr(pl, "_batch_runner", lambda: boom)
    monkeypatch.setattr(pl, "_l2_container", lambda cfg: container)
    avatar_registry.reload(_registry())
    kit = _ensure()
    assert not boom.calls and kit.mode == "idle_loop" and kit.warnings == ()
    restored = tmp_path / "l1" / main_kit.key
    assert sorted(p.name for p in restored.iterdir()) == sorted(p.name for p in main_kit.kit_dir.iterdir())
    for p in restored.iterdir():
        assert p.read_bytes() == (main_kit.kit_dir / p.name).read_bytes()
    assert not container.order  # nothing re-uploaded


@needs_ffmpeg
def test_l2_store_is_create_if_absent(main_kit):
    container = FakeContainer()
    container.blobs, container.etags = dict(main_kit.container.blobs), dict(main_kit.container.etags)
    before = dict(container.etags)
    pl._l2_store(container, main_kit.key, main_kit.kit_dir, main_kit.manifest, None)
    assert container.etags == before and not container.order and not container.deleted


# ---------------------------------------------------------------------------
# Cheap builds: 256×256, two phrases
# ---------------------------------------------------------------------------

@needs_ffmpeg
def test_static_footage_gives_procedural_listener_and_shared_clips(cheap):
    fake = cheap.install(FakeBatch(cheap.footage, motion=False))
    kit = _ensure()
    assert (kit.mode, kit.idle, kit.warnings) == ("procedural", None, (WARNING_LISTENER_STATIC,))
    assert set(kit.reactions) == set(REACTION_IDS)
    assert kit.reactions["ack"].video_path == kit.reactions["yeah"].video_path
    assert kit.reactions["ack"].video_path != kit.reactions["isee"].video_path
    assert kit.reactions["isee"].text == "Interesting."
    assert [t for kind, t in _ssml_events(fake.calls[0]["ssml"]) if kind == "text"] == ["Mm-hmm.", "Interesting."]
    m = json.loads((kit.reactions["ack"].video_path.parent / "kit.json").read_text(encoding="utf-8"))
    assert m["idle"]["status"] == "static" and m["idle"]["static"] is True
    assert m["idle"]["motion_score"] < pl.MOTION_FROZEN and "file" not in m["idle"]


@needs_ffmpeg
def test_weak_motion_keeps_the_loop_with_a_warning(cheap, monkeypatch):
    monkeypatch.setattr(pl, "MOTION_ALIVE", 1e9)  # classify the synthetic motion as weak
    cheap.install(FakeBatch(cheap.footage))
    kit = _ensure(want_reactions=False)
    assert kit.mode == "idle_loop" and kit.idle is not None and not kit.idle.static
    assert kit.warnings == (WARNING_LISTENER_STATIC,) and kit.reactions == {}
    assert _manifest(kit)["idle"]["motion_class"] == "weak"


@needs_ffmpeg
def test_phrase_count_mismatch_skips_reactions_only(cheap):
    fake = cheap.install(FakeBatch(cheap.footage, drop=1))
    kit = _ensure()
    assert kit.mode == "idle_loop" and kit.reactions == {} and kit.warnings == (WARNING_REACTIONS_SKIPPED,)
    m = _manifest(kit)
    assert (m["phrases"]["expected"], m["phrases"]["detected"], m["phrases"]["status"]) == (2, 1, "skipped")
    again = _ensure(want_reactions=False)
    assert again.warnings == () and len(fake.calls) == 1


@needs_ffmpeg
def test_corrupt_cache_entries_are_rebuilt(cheap):
    fake = cheap.install(FakeBatch(cheap.footage))
    kit = _ensure()
    assert kit.mode == "idle_loop" and len(fake.calls) == 1
    kit_dir = kit.idle.path.parent
    (kit_dir / "kit.json").write_text("{not json", encoding="utf-8")
    kit = _ensure()
    assert len(fake.calls) == 2 and kit.mode == "idle_loop" and kit.warnings == ()
    assert json.loads((kit_dir / "kit.json").read_text(encoding="utf-8"))["key"] == kit_dir.name
    data = bytearray(kit.idle.path.read_bytes())
    data[len(data) // 2] ^= 0xFF  # same size, different bytes
    kit.idle.path.write_bytes(bytes(data))
    kit = _ensure()
    assert len(fake.calls) == 3 and kit.mode == "idle_loop"
    assert pl._read_manifest(kit_dir, kit_dir.name) is not None


@needs_ffmpeg
def test_processing_failure_keeps_the_paid_footage(cheap, monkeypatch):
    fake = cheap.install(FakeBatch(cheap.footage))
    real = pl.process_footage
    attempts = {"n": 0}

    def flaky(*args, **kwargs):
        attempts["n"] += 1
        if attempts["n"] == 1:
            raise pl.ListenerKitError("simulated encoder failure")
        return real(*args, **kwargs)

    monkeypatch.setattr(pl, "process_footage", flaky)
    kit = _ensure()
    assert kit.mode == "procedural" and kit.warnings == (WARNING_LISTENER_FALLBACK, WARNING_REACTIONS_SKIPPED)
    retained = list((cheap.l1 / ".footage").glob("*.mp4"))
    assert len(retained) == 1 and len(fake.calls) == 1
    kit = _ensure()
    assert len(fake.calls) == 1 and kit.mode == "idle_loop" and not retained[0].exists()


@needs_ffmpeg
def test_resolve_builds_both_hosts_in_parallel(cheap):
    fake = cheap.install(FakeBatch(cheap.footage))
    kits = pl.resolve_listener_kits(_cfg(), _roles(), "en-US", want_reactions=True,
                                    deadline=time.monotonic() + 600)
    assert sorted(c["avatar_id"] for c in fake.calls) == ["photo_female", "photo_male"]
    assert {r: k.avatar_id for r, k in kits.items()} == {"interviewer": "photo_female", "expert": "photo_male"}
    for kit in kits.values():
        assert kit.mode == "idle_loop" and kit.warnings == () and set(kit.reactions) == set(REACTION_IDS)
    assert kits["interviewer"].idle.path.parent != kits["expert"].idle.path.parent
    assert all(c["label"].startswith("listener-kit-") for c in fake.calls)


@needs_ffmpeg
def test_still_mode_with_reactions_builds_once_for_a_shared_host(cheap, monkeypatch, caplog):
    monkeypatch.setenv("PODCAST_LISTENER_MODE", "still")
    fake = cheap.install(FakeBatch(cheap.footage))
    caplog.set_level(logging.DEBUG)
    kits = pl.resolve_listener_kits(_cfg(), _roles("photo_female", "photo_female", VOICE_F, VOICE_F), "en-US",
                                    want_reactions=True, deadline=time.monotonic() + 600)
    assert len(fake.calls) == 1
    for kit in kits.values():
        assert (kit.mode, kit.idle, kit.warnings) == ("still", None, ())
        assert set(kit.reactions) == set(REACTION_IDS)
    assert SENTINEL.lower() not in caplog.text.lower()
    assert not _scan_tree(cheap.l1, SENTINEL)


@needs_ffmpeg
def test_corrupt_blob_entry_is_replaced(cheap, monkeypatch):
    container = FakeContainer()
    monkeypatch.setattr(pl, "_l2_container", lambda cfg: container)
    fake = cheap.install(FakeBatch(cheap.footage))
    key = pl._spec_for(avatar_registry.get("photo_female"), VOICE_F, "en-US").key
    sidecar = f"podcast-cache/listener-kit/{key}/kit.json"
    container.blobs[sidecar], container.etags[sidecar] = b"{corrupt", "etag-1"
    kit = _ensure()
    assert len(fake.calls) == 1 and kit.mode == "idle_loop"
    assert sidecar in container.deleted and container.order[-1] == sidecar
    assert json.loads(container.blobs[sidecar])["key"] == key
