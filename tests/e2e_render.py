"""End-to-end render tests for the narrated video and the podcast (Watch + Listen).

Full happy-path: ingest -> script (streaming) -> render -> poll until done
-> download media file. Expensive: each feature + language costs TTS tokens +
~5-8 min for the video and ~3-5 min for the podcast video (batch avatar jobs);
the audio-only podcast costs TTS only and takes well under a minute.

Runs per language using the matching sample fixture (tests/fixtures/samples):
  fr-FR -> securite-bases.pptx           (Group A - Safety)
  en-US -> ai-models-intro.pptx          (Group B - Generative AI)
  es-ES -> ia-industrial-intro.pptx      (Group C - AI)

Podcast renditions (``--podcast-formats``, default ``video,audio``): one script per
language, rendered once per format.
  video  MP4 + radio MP3. Job contract (format, stable warning codes,
         listener_mode, audio_kind=radio_mix), transcript (turns carry
         video_start/video_end), the radio checks below, Watch/Listen durations
         and the live listener: during each turn the OTHER host's tile moves
         clearly more than a frozen reference (the static slide under the same
         codec) and keeps the colour of that avatar's tile when it speaks (no
         dim); a placed backchannel shows a motion spike on the listener tile
         near its reaction cue mapped to video time.
  audio  radio MP3 only: no MP4/SRT (404), audio-only progress stages
         (synthesizing/mixing: zero avatar jobs), no listener_mode, the radio
         checks, and a render much faster than the video one (ratio reported).
Radio checks: MP3 44.1 kHz stereo CBR with an attached cover and allow-listed
ID3 tags only, integrated loudness -16 +- 1 LUFS (ffmpeg ebur128), no leading
silence >= 1 s, audible backchannels at their reaction cues, transcript JSON
(turns ordered, cues inside the duration, peaks), radio SRT, cover, SCORM, and
no voice ids in tags or transcript.

Media checks need ffmpeg + ffprobe (``OZ_RADIO_E2E_TOOL_DIRS`` like
tests/e2e-live.spec.ts, else PATH) and numpy; ``--no-media-checks`` skips them.
Downloads and per-job measurements (``*.summary.json``) go to ``--evidence-dir``
(default ``OZ_RADIO_E2E_EVIDENCE``, else test-results/e2e-render).

Target a local dev backend started with ``run-local.ps1`` (``AUTH_MODE=disabled``).
Base URL: ``--base-url`` or env ``AI_PRESENTER_BASE_URL`` (default http://localhost:8000).
Backchannels are only rendered when the backend runs with ``PODCAST_REACTIONS=true``.

Usage:
    # Default: English only - narrated video + podcast (video + audio-only)
    python tests/e2e_render.py

    # Multi-language pass (expensive ~30-60 min)
    python tests/e2e_render.py --languages fr-FR,en-US,es-ES

    # Pick one feature
    python tests/e2e_render.py --base-url http://localhost:8000 --skip-podcast --languages en-US

    # Podcast only: 8 turns (room for backchannels), intro/outro, reactions required
    python tests/e2e_render.py --skip-video --podcast-turns 8 --intro --expect-reactions

    # Audio-only rendition only (TTS cost, no avatar)
    python tests/e2e_render.py --skip-video --podcast-formats audio
"""
from __future__ import annotations

import argparse
import io
import json
import math
import os
import re
import shutil
import statistics
import subprocess
import sys
import time
import xml.etree.ElementTree as ET
import zipfile
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Optional, Sequence

import httpx

try:  # media checks only (reported by main() when missing)
    import numpy as np
except ImportError:  # pragma: no cover
    np = None  # type: ignore[assignment]

DEFAULT_BASE = os.environ.get("AI_PRESENTER_BASE_URL", "http://localhost:8000")
FIXTURE_DIR = Path(__file__).resolve().parent / "fixtures" / "samples"
REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_EVIDENCE = os.environ.get("OZ_RADIO_E2E_EVIDENCE") or str(REPO_ROOT / "test-results" / "e2e-render")

POLL_TIMEOUT_SEC = 600  # 10 minutes max per render job
POLL_INTERVAL_SEC = 6
PODCAST_TIMEOUT_SEC = 1200    # podcast video: batch-avatar pacing + a first listener-kit build
AUDIO_POLL_INTERVAL_SEC = 2   # audio-only renders are short: finer timing for the speed ratio


# ---------------------------------------------------------------------------
# Podcast contracts mirrored from the backend (stable: services/podcast_media.py,
# services/podcast_radio.py, services/podcast_compose.py)
# ---------------------------------------------------------------------------
PODCAST_FORMATS = ("video", "audio")
PODCAST_KIND = {"video": "podcast", "audio": "radio"}   # summary matrix KIND
LAYOUT = "split_screen_with_slides"
ROLES = ("interviewer", "expert")
KNOWN_WARNINGS = frozenset({
    "listener_fallback", "listener_static", "listener_timeout",
    "reactions_skipped", "radio_fallback", "cover_fallback",
})
LISTENER_WARNINGS = frozenset({"listener_fallback", "listener_static", "listener_timeout"})
LISTENER_MODES = ("idle_loop", "procedural", "still")
AUDIO_STAGES = frozenset({"queued", "synthesizing", "mixing", "done"})
AVATAR_STAGES = frozenset({"rendering", "composing"})
ID3_ALLOWED = frozenset({"title", "artist", "album_artist", "album", "genre", "date", "language", "comment"})
ID3_COMMENT = "AI-generated voices"

# Video geometry (podcast_compose.LAYOUTS): avatar tiles (x, y, w, h) and a region
# that stays static within a turn (slide centre / label zone) = the frozen reference.
LAYOUT_TILES: dict[str, dict[str, tuple[int, int, int, int]]] = {
    "split_screen_with_slides": {"interviewer": (0, 0, 560, 360), "expert": (1360, 0, 560, 360)},
    "split_screen_only": {"interviewer": (0, 0, 960, 900), "expert": (960, 0, 960, 900)},
}
STATIC_REGIONS: dict[str, tuple[int, int, int, int]] = {
    "split_screen_with_slides": (640, 540, 640, 360),
    "split_screen_only": (0, 900, 1920, 60),
}

# Radio
LOUDNESS_TARGET_LUFS = -16.0
LOUDNESS_TOLERANCE_LU = 1.0
TRUE_PEAK_MAX_DBTP = -1.0     # Apple spec: reported as a warning above it, a failure above 0
MP3_SAMPLE_RATE = 44100
PCM_RATE = 16000
SILENCE_DBFS = -45.0
LEADING_SILENCE_MAX_SEC = 1.0
REACTION_AUDIBLE_DBFS = -40.0
DURATION_TOLERANCE_SEC = 0.5
SPEED_MIN_RATIO = 2.0         # the audio-only render is at least 2x faster than the video one

# Live listener: mean |F(t) - F(t-1)| of a 128 px gray face crop (podcast_listener.MOTION_VF).
MOTION_SIZE = 128
MOTION_ALIVE = 0.30           # podcast_listener.MOTION_ALIVE (S1: idle 1.4-1.5, frozen 0.002)
MOTION_REF_FACTOR = 5.0       # ... and >= 5x the frozen reference (codec noise)
COLOUR_SIZE = 64
COLOUR_FPS = 5
COLOUR_MIN_RATIO = 0.80       # listening vs speaking, per RGB channel (the old dim was 0.55)
WINDOW_LEAD_SEC = 0.6         # skip the 160 ms turn dissolve and the 250 ms SSML lead
WINDOW_TAIL_SEC = 0.4
WINDOW_MAX_SEC = 6.0
WINDOW_MIN_SEC = 1.2
MAX_TURN_WINDOWS = 8
ROLL_FRAMES = 6               # 0.24 s rolling mean for reaction spikes
SPIKE_SEARCH_SEC = 2.0        # radio -> video mapping is approximate (separate placements)
SPIKE_MIN_RATIO = 1.25        # spike vs the listener's idle p95 (rolling)
SPIKE_MIN_ABS = 1.0           # talking-level motion (S1 talking: 3.7-5.9)
MAX_REACTION_CHECKS = 6


# ---------------------------------------------------------------------------
# Per-language test plan (fixture + voice pair)
# ---------------------------------------------------------------------------
@dataclass
class LangPlan:
    language: str              # e.g. "fr-FR"
    fixture: str               # filename under tests/fixtures/samples/
    voice_male: str            # e.g. "fr-FR-Remy:DragonHDLatestNeural"
    voice_female: str          # e.g. "fr-FR-Vivienne:DragonHDLatestNeural"


PLANS: dict[str, LangPlan] = {
    "fr-FR": LangPlan(
        language="fr-FR",
        fixture="securite-bases.pptx",
        voice_male="fr-FR-Remy:DragonHDLatestNeural",
        voice_female="fr-FR-Vivienne:DragonHDLatestNeural",
    ),
    "en-US": LangPlan(
        language="en-US",
        fixture="ai-models-intro.pptx",
        voice_male="en-US-Andrew:DragonHDLatestNeural",
        voice_female="en-US-Ava:DragonHDLatestNeural",
    ),
    "es-ES": LangPlan(
        language="es-ES",
        fixture="ia-industrial-intro.pptx",
        voice_male="es-ES-Tristan:DragonHDLatestNeural",
        voice_female="es-ES-Ximena:DragonHDLatestNeural",
    ),
}


# ---------------------------------------------------------------------------
# Logging helpers (terminal-friendly, ASCII safe for Windows stdout)
# ---------------------------------------------------------------------------
@dataclass
class RunResult:
    kind: str             # "video", "podcast" (video rendition) or "radio" (audio-only podcast)
    language: str
    fixture: str
    state: str = "pending"   # "pending" | "pass" | "fail"
    detail: str = ""
    duration_sec: float = 0.0
    output_bytes: int = 0


class Log:
    def __init__(self) -> None:
        self.passes = 0
        self.fails = 0
        self.warns = 0
        self.runs: list[RunResult] = []

    def header(self, title: str) -> None:
        print(f"\n{'=' * 70}\n== {title}\n{'=' * 70}")

    def step(self, msg: str) -> None:
        print(f"  -> {msg}")

    def ok(self, msg: str) -> None:
        self.passes += 1
        print(f"  [PASS] {msg}")

    def fail(self, msg: str) -> None:
        self.fails += 1
        print(f"  [FAIL] {msg}")

    def warn(self, msg: str) -> None:
        self.warns += 1
        print(f"  [WARN] {msg}")

    def info(self, msg: str) -> None:
        print(f"  [INFO] {msg}")

    def record(self, result: RunResult) -> None:
        self.runs.append(result)

    def summary(self) -> int:
        print(f"\n{'=' * 70}")
        warned = f"  {self.warns} warnings" if self.warns else ""
        print(f"RESULTS: {self.passes} passed  {self.fails} failed{warned}")
        if self.runs:
            print(f"\nPer-run matrix:")
            print(f"{'KIND':<8}{'LANGUAGE':<10}{'FIXTURE':<32}{'STATE':<8}{'BYTES':>12}{'SEC':>8}")
            print("-" * 75)
            for r in self.runs:
                print(
                    f"{r.kind:<8}{r.language:<10}{r.fixture:<32}"
                    f"{r.state:<8}{r.output_bytes:>12,}{r.duration_sec:>8.1f}"
                )
        print(f"{'=' * 70}")
        return 0 if self.fails == 0 else 1


# ---------------------------------------------------------------------------
# Video (1 language)
# ---------------------------------------------------------------------------
def run_video_for_language(client: httpx.Client, plan: LangPlan, log: Log) -> None:
    log.header(f"VIDEO  {plan.language}  {plan.fixture}")
    result = RunResult(kind="video", language=plan.language, fixture=plan.fixture)
    log.record(result)

    fixture_path = FIXTURE_DIR / plan.fixture
    if not fixture_path.exists():
        msg = f"Fixture missing: {fixture_path}"
        log.fail(msg)
        result.state, result.detail = "fail", msg
        return

    t_start = time.time()

    # 1. Ingest
    log.step("POST /api/video/ingest")
    try:
        with fixture_path.open("rb") as f:
            r = client.post(
                "/api/video/ingest",
                files={"file": (
                    fixture_path.name, f,
                    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
                )},
                timeout=120,
            )
    except Exception as e:  # noqa: BLE001
        log.fail(f"ingest: {e}")
        result.state, result.detail = "fail", str(e)
        return
    if r.status_code != 200:
        msg = f"ingest -> {r.status_code}: {r.text[:200]}"
        log.fail(msg)
        result.state, result.detail = "fail", msg
        return
    ingest = r.json()
    doc_id = ingest["doc_id"]
    n_slides = len(ingest.get("slides", []))
    log.ok(f"ingested doc_id={doc_id} ({n_slides} slides)")

    # 2. Script (NDJSON)
    log.step(f"POST /api/video/script/{{doc_id}} lang={plan.language}")
    payload = {"language": plan.language, "style": "explainer", "voice": plan.voice_female}
    narrations = 0
    script_ok = False
    t0 = time.time()
    try:
        with client.stream(
            "POST", f"/api/video/script/{doc_id}",
            json=payload, timeout=180,
        ) as r:
            if r.status_code != 200:
                msg = f"script -> {r.status_code}: {r.read()[:200]!r}"
                log.fail(msg)
                result.state, result.detail = "fail", msg
                return
            for line in r.iter_lines():
                if not line:
                    continue
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if event.get("event") == "narration":
                    narrations += 1
                elif event.get("event") == "done":
                    script_ok = True
                    break
                elif event.get("event") == "error":
                    msg = f"script stream error: {event.get('data')}"
                    log.fail(msg)
                    result.state, result.detail = "fail", msg
                    return
    except Exception as e:  # noqa: BLE001
        log.fail(f"script stream: {e}")
        result.state, result.detail = "fail", str(e)
        return
    if not script_ok:
        msg = "script stream ended without 'done' event"
        log.fail(msg)
        result.state, result.detail = "fail", msg
        return
    log.ok(f"script generated ({narrations} narrations in {time.time()-t0:.1f}s)")

    # 3. Render
    log.step("POST /api/video/render/{doc_id}")
    r = client.post(f"/api/video/render/{doc_id}", timeout=30)
    if r.status_code != 200:
        msg = f"render -> {r.status_code}: {r.text[:200]}"
        log.fail(msg)
        result.state, result.detail = "fail", msg
        return
    job_id = r.json().get("job_id")
    log.ok(f"render job queued job_id={job_id}")

    # 4. Poll
    log.step("poll /api/video/jobs/{job_id}")
    t0 = time.time()
    final_state = None
    last_stage = ""
    while time.time() - t0 < POLL_TIMEOUT_SEC:
        try:
            r = client.get(f"/api/video/jobs/{job_id}", timeout=30)
            if r.status_code != 200:
                time.sleep(POLL_INTERVAL_SEC)
                continue
            job = r.json()
            state = job.get("state")
            stage = job.get("progress", {}).get("stage", "")
            done = job.get("progress", {}).get("completed", 0)
            total = job.get("progress", {}).get("total", 0)
            if stage != last_stage:
                print(f"     ... {state}  stage={stage}  {done}/{total}")
                last_stage = stage
            if state in ("done", "failed"):
                final_state = state
                if state == "failed":
                    msg = f"render failed: {job.get('error')}"
                    log.fail(msg)
                    result.state, result.detail = "fail", msg
                    return
                break
        except Exception as e:  # noqa: BLE001
            print(f"     ... poll error: {e}")
        time.sleep(POLL_INTERVAL_SEC)

    if final_state != "done":
        msg = f"render timeout after {POLL_TIMEOUT_SEC}s"
        log.fail(msg)
        result.state, result.detail = "fail", msg
        return
    log.ok(f"render completed in {time.time()-t0:.1f}s")

    # 5. Download mp4
    log.step("GET /api/video/jobs/{job_id}/file/mp4")
    try:
        r = client.get(f"/api/video/jobs/{job_id}/file/mp4", timeout=180)
        if r.status_code == 200 and len(r.content) > 10_000:
            log.ok(f"mp4 downloaded ({len(r.content):,} bytes)")
            result.output_bytes = len(r.content)
            result.state = "pass"
            result.duration_sec = time.time() - t_start
        else:
            msg = f"mp4 download status={r.status_code} size={len(r.content)}"
            log.fail(msg)
            result.state, result.detail = "fail", msg
    except Exception as e:  # noqa: BLE001
        log.fail(f"mp4 download: {e}")
        result.state, result.detail = "fail", str(e)

    # 6. SCORM package validation
    log.step("GET /api/video/jobs/{job_id}/file/scorm")
    try:
        r = client.get(f"/api/video/jobs/{job_id}/file/scorm", timeout=180)
        if r.status_code != 200:
            log.fail(f"scorm download status={r.status_code}")
        else:
            ct = r.headers.get("content-type", "")
            if ct.startswith("application/zip"):
                log.ok(f"scorm content-type={ct}")
            else:
                log.fail(f"scorm unexpected content-type={ct}")
            zf = zipfile.ZipFile(io.BytesIO(r.content))
            names = zf.namelist()
            if "imsmanifest.xml" in names:
                log.ok("scorm contains imsmanifest.xml")
            else:
                log.fail("scorm missing imsmanifest.xml")
            if "index.html" in names:
                log.ok("scorm contains index.html")
            else:
                log.fail("scorm missing index.html")
            if "scorm.js" in names:
                log.ok("scorm contains scorm.js")
            else:
                log.fail("scorm missing scorm.js")
            if "subtitles.vtt" in names:
                log.ok("scorm contains subtitles.vtt")
            else:
                log.fail("scorm missing subtitles.vtt")
            if any(n.endswith(".mp4") for n in names):
                log.ok("scorm contains mp4 video")
            else:
                log.fail("scorm missing mp4 video")
            # Validate manifest XML
            if "imsmanifest.xml" in names:
                manifest = zf.read("imsmanifest.xml").decode()
                root = ET.fromstring(manifest)
                if "scormtype" in manifest.lower() or "scormType" in manifest:
                    log.ok(f"scorm manifest valid ({len(manifest):,} bytes)")
                else:
                    log.fail("scorm manifest missing scormType attribute")
            # Validate player HTML
            if "index.html" in names:
                html = zf.read("index.html").decode()
                if "<video" in html:
                    log.ok("scorm player contains video tag")
                else:
                    log.fail("scorm player missing video tag")
                if "scormInit" in html:
                    log.ok("scorm player contains scormInit")
                else:
                    log.fail("scorm player missing scormInit")
            # Validate subtitles
            if "subtitles.vtt" in names:
                vtt = zf.read("subtitles.vtt").decode()
                if vtt.startswith("WEBVTT"):
                    log.ok("scorm subtitles in VTT format")
                else:
                    log.fail("scorm subtitles not in VTT format")
            log.ok(f"scorm package valid ({len(names)} files, {len(r.content):,} bytes)")
    except Exception as e:  # noqa: BLE001
        log.fail(f"scorm validation: {e}")


# ---------------------------------------------------------------------------
# Media tooling (ffmpeg / ffprobe / numpy)
# ---------------------------------------------------------------------------
def find_tool(name: str, extra_dirs: str) -> Optional[str]:
    """``ffmpeg``/``ffprobe`` from the extra dirs (``OZ_RADIO_E2E_TOOL_DIRS``), else PATH."""
    exe = f"{name}.exe" if os.name == "nt" else name
    for d in (extra_dirs or "").split(os.pathsep):
        if d.strip() and (Path(d.strip()) / exe).is_file():
            return str(Path(d.strip()) / exe)
    return shutil.which(name)


def _num(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _float(value: object) -> Optional[float]:
    try:
        v = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) else None


class Media:
    """ffmpeg/ffprobe + numpy helpers for the media checks."""

    def __init__(self, ffmpeg: str, ffprobe: str) -> None:
        self.ffmpeg = ffmpeg
        self.ffprobe = ffprobe

    @staticmethod
    def _run(args: list[str], timeout: float = 600) -> subprocess.CompletedProcess:
        return subprocess.run(args, capture_output=True, timeout=timeout, check=False)

    @staticmethod
    def _err(proc: subprocess.CompletedProcess) -> str:
        return proc.stderr.decode("utf-8", errors="replace").strip()[-300:]

    def probe(self, path: Path) -> dict:
        p = self._run([self.ffprobe, "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)], 120)
        if p.returncode != 0:
            raise RuntimeError(f"ffprobe failed: {self._err(p)}")
        return json.loads(p.stdout.decode("utf-8", errors="replace") or "{}")

    def loudness(self, path: Path) -> tuple[Optional[float], Optional[float]]:
        """Integrated loudness (LUFS) and true peak (dBTP) of the first audio stream (``ebur128``)."""
        p = self._run([self.ffmpeg, "-hide_banner", "-nostats", "-i", str(path), "-map", "0:a:0",
                       "-af", "ebur128=peak=true", "-f", "null", "-"], 600)
        text = p.stderr.decode("utf-8", errors="replace")
        idx = text.rfind("Summary:")
        if p.returncode != 0 or idx < 0:
            raise RuntimeError(f"ebur128 failed: {self._err(p)}")
        summary = text[idx:]
        m_i = re.search(r"\bI:\s+(-?\d+(?:\.\d+)?)\s+LUFS", summary)
        m_tp = re.search(r"True peak:\s*Peak:\s+(-?inf|-?\d+(?:\.\d+)?)\s+dBFS", summary)
        lufs = float(m_i.group(1)) if m_i else None
        tp = None
        if m_tp:
            tp = float("-inf") if "inf" in m_tp.group(1) else float(m_tp.group(1))
        return lufs, tp

    def pcm_mono(self, path: Path, rate: int = PCM_RATE) -> "np.ndarray":
        """First audio stream as mono float32 samples in [-1, 1]."""
        p = self._run([self.ffmpeg, "-v", "error", "-i", str(path), "-map", "0:a:0", "-ac", "1",
                       "-ar", str(rate), "-c:a", "pcm_s16le", "-f", "s16le", "-"], 600)
        if p.returncode != 0:
            raise RuntimeError(f"audio decode failed: {self._err(p)}")
        return np.frombuffer(p.stdout, dtype="<i2").astype(np.float32) / 32768.0

    def crops(self, path: Path, start: float, duration: float, rects: Sequence[tuple[int, int, int, int]],
              size: int, pix_fmt: str = "gray", fps: Optional[float] = None) -> list["np.ndarray"]:
        """Frames of ``rects`` (x, y, w, h) over [start, start + duration], each area-scaled
        to ``size`` x ``size``: one uint8 array [N, size, size(, 3)] per rect."""
        k = len(rects)
        head = f"[0:v]fps={fps:g}," if fps else "[0:v]"
        if k == 1:
            x, y, w, h = rects[0]
            graph = f"{head}crop={w}:{h}:{x}:{y},scale={size}:{size}:flags=area,format={pix_fmt}[out]"
        else:
            parts = [f"{head}split={k}" + "".join(f"[s{i}]" for i in range(k))]
            for i, (x, y, w, h) in enumerate(rects):
                parts.append(f"[s{i}]crop={w}:{h}:{x}:{y},scale={size}:{size}:flags=area[c{i}]")
            parts.append("".join(f"[c{i}]" for i in range(k)) + f"hstack=inputs={k},format={pix_fmt}[out]")
            graph = ";".join(parts)
        p = self._run([self.ffmpeg, "-v", "error", "-ss", f"{max(0.0, start):.3f}", "-t", f"{duration:.3f}",
                       "-i", str(path), "-filter_complex", graph, "-map", "[out]",
                       "-f", "rawvideo", "-pix_fmt", pix_fmt, "-"], 600)
        if p.returncode != 0:
            raise RuntimeError(f"frame extraction failed: {self._err(p)}")
        channels = 3 if pix_fmt == "rgb24" else 1
        frame_bytes = size * size * k * channels
        n = len(p.stdout) // frame_bytes
        arr = np.frombuffer(p.stdout[: n * frame_bytes], dtype=np.uint8)
        arr = arr.reshape((n, size, size * k, 3) if channels == 3 else (n, size, size * k))
        return [arr[:, :, i * size:(i + 1) * size] for i in range(k)]

    def snapshot(self, path: Path, at: float, out: Path, crop: str = "1920:360:0:0") -> None:
        """One evidence PNG (default: the avatar band of the 1080p layout)."""
        self._run([self.ffmpeg, "-v", "error", "-y", "-ss", f"{max(0.0, at):.3f}", "-i", str(path),
                   "-frames:v", "1", "-vf", f"crop={crop}", str(out)], 120)


def motion_series(frames: "np.ndarray") -> "np.ndarray":
    """Per frame step: mean |F(t) - F(t-1)| (0..255 scale)."""
    if frames.shape[0] < 2:
        return np.zeros(0, dtype=np.float64)
    d = np.abs(np.diff(frames.astype(np.int16), axis=0))
    return d.reshape(d.shape[0], -1).mean(axis=1)


def rolling_mean(x: "np.ndarray", k: int) -> "np.ndarray":
    if x.size == 0 or x.size < k:
        return x.astype(np.float64)
    return np.convolve(x, np.ones(k) / k, mode="valid")


def rms_dbfs(x: "np.ndarray") -> float:
    if x.size == 0:
        return float("-inf")
    rms = float(np.sqrt(np.mean(np.square(x, dtype=np.float64))))
    return 20.0 * math.log10(rms) if rms > 0 else float("-inf")


def first_onset(pcm: "np.ndarray", rate: int, threshold_dbfs: float, win_sec: float = 0.02) -> Optional[float]:
    """Start (s) of the first ``win_sec`` window at or above ``threshold_dbfs``."""
    win = max(1, int(rate * win_sec))
    n = pcm.size // win
    if n == 0:
        return None
    frames = pcm[: n * win].astype(np.float64).reshape(n, win)
    levels = np.sqrt(np.mean(frames * frames, axis=1))
    loud = np.nonzero(levels >= 10 ** (threshold_dbfs / 20.0))[0]
    return float(loud[0] * win / rate) if loud.size else None


def face_rect(tile: tuple[int, int, int, int]) -> tuple[int, int, int, int]:
    """Face region of a photo avatar inside its tile, in video pixels.

    512 px source cropped to (0.06, 0, 0.88, 1) (``avatar_registry.PODCAST_CROP_PHOTO``),
    scaled into the tile (aspect kept) and padded to its bottom centre; the face is
    the centre 60 % of the source frame (``podcast_listener.MOTION_VF``). For the
    default layout: (173, 72, 216, 216) relative to the tile.
    """
    x, y, w, h = tile
    src = 512
    cx0 = int(src * 0.06 / 2) * 2
    cw = int(src * 0.88 / 2) * 2
    s = min(w / cw, h / src)
    pad_x = (w - cw * s) / 2
    pad_y = h - src * s
    fx0, fx1 = 0.2 * src - cx0, 0.8 * src - cx0
    fy0, fy1 = 0.2 * src, 0.8 * src
    return (int(round(x + pad_x + fx0 * s)), int(round(y + pad_y + fy0 * s)),
            int(round((fx1 - fx0) * s)) // 2 * 2, int(round((fy1 - fy0) * s)) // 2 * 2)


def map_rendition_time(turns: Sequence[dict], t: float, src: str = "audio") -> float:
    """Radio <-> video position, turn by turn (port of RadioPlayer ``mapRenditionTime``)."""
    pos = t if math.isfinite(t) and t > 0 else 0.0
    spans: list[tuple[tuple[float, float], tuple[float, float]]] = []
    for x in turns:
        if all(_num(x.get(k)) for k in ("start", "end", "video_start", "video_end")):
            audio = (float(x["start"]), float(x["end"]))
            video = (float(x["video_start"]), float(x["video_end"]))
            spans.append((video, audio) if src == "video" else (audio, video))
    spans.sort(key=lambda s: s[0][0])
    if not spans:
        return pos
    if pos < spans[0][0][0]:
        return max(0.0, spans[0][1][0] - (spans[0][0][0] - pos))
    i = len(spans) - 1
    while i > 0 and spans[i][0][0] > pos:
        i -= 1
    (s0, s1), (d0, d1) = spans[i]
    if pos <= s1:
        frac = (pos - s0) / (s1 - s0) if s1 > s0 else 0.0
        return d0 + frac * (d1 - d0)
    return spans[i + 1][1][0] if i + 1 < len(spans) else d1 + (pos - s1)


# ---------------------------------------------------------------------------
# Format parsers (no ffmpeg)
# ---------------------------------------------------------------------------
_MP3_BITRATES_V1_L3 = (0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0)
_MP3_RATES_V1 = (44100, 48000, 32000, 0)


def mp3_frame_bitrates(data: bytes) -> tuple[list[int], Optional[str], float]:
    """Bitrates (kb/s) of the MPEG-1 Layer III audio frames after the ID3v2 tag, the
    Xing/Info header of the first frame ("Info" = CBR) and the fraction of the file walked."""
    n = len(data)
    pos = 0
    if n >= 10 and data[:3] == b"ID3":
        size = ((data[6] & 0x7F) << 21) | ((data[7] & 0x7F) << 14) | ((data[8] & 0x7F) << 7) | (data[9] & 0x7F)
        pos = 10 + size + (10 if data[5] & 0x10 else 0)
    while pos + 1 < n and not (data[pos] == 0xFF and (data[pos + 1] & 0xE0) == 0xE0):
        pos += 1
    bitrates: list[int] = []
    header: Optional[str] = None
    first = True
    while pos + 4 <= n:
        b1, b2, b3 = data[pos + 1], data[pos + 2], data[pos + 3]
        if data[pos] != 0xFF or (b1 & 0xE0) != 0xE0 or ((b1 >> 3) & 0x3) != 0x3 or ((b1 >> 1) & 0x3) != 0x1:
            break  # not an MPEG-1 Layer III frame
        br = _MP3_BITRATES_V1_L3[(b2 >> 4) & 0xF]
        sr = _MP3_RATES_V1[(b2 >> 2) & 0x3]
        if not br or not sr:
            break
        length = 144000 * br // sr + ((b2 >> 1) & 0x1)
        if first:
            first = False
            side = 17 if ((b3 >> 6) & 0x3) == 0x3 else 32
            crc = 0 if (b1 & 0x1) else 2
            marker = data[pos + 4 + crc + side: pos + 8 + crc + side]
            if marker in (b"Xing", b"Info"):
                header = marker.decode("ascii")
                pos += length
                continue  # the Xing/Info frame carries no audio
        bitrates.append(br)
        pos += length
    return bitrates, header, (min(pos, n) / n if n else 0.0)


_SRT_TIME = re.compile(
    r"(\d{1,2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{3})")


def parse_srt(text: str) -> list[tuple[float, float, str]]:
    """(start, end, text) per SRT block; ValueError on a block without a timing line."""
    cues: list[tuple[float, float, str]] = []
    body = text.lstrip("\ufeff").replace("\r\n", "\n").strip()
    if not body:
        return cues
    for block in re.split(r"\n\s*\n", body):
        lines = [line for line in block.split("\n") if line.strip()]
        timing = next((i for i, line in enumerate(lines) if _SRT_TIME.search(line)), None)
        if timing is None:
            raise ValueError(f"SRT block without a timing line: {block[:40]!r}")
        g = [int(v) for v in _SRT_TIME.search(lines[timing]).groups()]  # type: ignore[union-attr]
        start = g[0] * 3600 + g[1] * 60 + g[2] + g[3] / 1000
        end = g[4] * 3600 + g[5] * 60 + g[6] + g[7] / 1000
        cues.append((start, end, " ".join(lines[timing + 1:]).strip()))
    return cues


def validate_transcript(tr: object, *, fmt: str, duration: Optional[float], video_duration: Optional[float],
                        turn_count: Optional[int], host_names: dict[str, str]) -> tuple[list[str], dict]:
    """Contract checks of ``transcript.json`` (``podcast_models.Transcript``): (errors, stats)."""
    errors: list[str] = []
    if not isinstance(tr, dict):
        return ["not a JSON object"], {}
    dur = tr.get("duration_sec")
    if not _num(dur) or dur <= 0:
        errors.append(f"duration_sec invalid ({dur!r})")
        dur = duration or 0.0
    elif duration is not None and abs(dur - duration) > DURATION_TOLERANCE_SEC:
        errors.append(f"duration_sec {dur:.2f} vs MP3 {duration:.2f}")
    limit = float(dur) + 0.05

    hosts = {h.get("role"): h.get("display_name") for h in tr.get("hosts") or [] if isinstance(h, dict)}
    if set(hosts) != set(ROLES):
        errors.append(f"host roles {sorted(map(str, hosts))}")
    for role, name in host_names.items():
        if role in hosts and hosts[role] != name:
            errors.append(f"host {role} named {hosts[role]!r}, requested {name!r}")

    turns = [t for t in tr.get("turns") or [] if isinstance(t, dict)]
    speaker_of: dict[int, str] = {}
    prev: Optional[dict] = None
    if not turns:
        errors.append("no turns")
    if turn_count and len(turns) != turn_count:
        errors.append(f"{len(turns)} turns, script has {turn_count}")
    for t in turns:
        idx, start, end = t.get("turn_idx"), t.get("start"), t.get("end")
        if not isinstance(idx, int) or t.get("speaker") not in ROLES or not _num(start) or not _num(end):
            errors.append(f"malformed turn {t}")
            continue
        speaker_of[idx] = t["speaker"]
        if not (0 <= start < end <= limit):
            errors.append(f"turn {idx} [{start:.2f}, {end:.2f}] outside [0, {dur:.2f}]")
        vs, ve = t.get("video_start"), t.get("video_end")
        if fmt == "video":
            if not _num(vs) or not _num(ve) or not 0 <= vs < ve:
                errors.append(f"turn {idx} video offsets {vs!r}..{ve!r}")
            elif video_duration is not None and ve > video_duration + 0.1:
                errors.append(f"turn {idx} video_end {ve:.2f} > video {video_duration:.2f}")
        elif vs is not None or ve is not None:
            errors.append(f"audio-only turn {idx} has video offsets")
        if prev is not None:
            if idx <= prev["turn_idx"] or start < prev["end"] - 0.05:
                errors.append(f"turn {idx} not after turn {prev['turn_idx']}")
            if fmt == "video" and _num(vs) and _num(prev.get("video_end")) and vs < prev["video_end"] - 0.05:
                errors.append(f"turn {idx} video_start before the previous turn ends")
        prev = t

    cues = [c for c in tr.get("cues") or [] if isinstance(c, dict)]
    speech = [c for c in cues if c.get("kind", "speech") == "speech"]
    reactions = [c for c in cues if c.get("kind") == "reaction"]
    if not speech:
        errors.append("no speech cues")
    for c in cues:
        start, end, idx = c.get("start"), c.get("end"), c.get("turn_idx")
        if c.get("kind", "speech") not in ("speech", "reaction") or c.get("speaker") not in ROLES:
            errors.append(f"malformed cue kind/speaker {c.get('kind')!r}/{c.get('speaker')!r}")
        elif not _num(start) or not _num(end) or not -0.01 <= start <= end <= limit:
            errors.append(f"cue [{start!r}, {end!r}] outside [0, {dur:.2f}]")
        elif not isinstance(c.get("text"), str) or not c["text"].strip():
            errors.append("cue without text")
        elif idx not in speaker_of:
            errors.append(f"cue turn_idx {idx!r} is not a turn")
        elif c.get("kind") == "reaction" and c["speaker"] == speaker_of[idx]:
            errors.append(f"reaction cue by the speaker of turn {idx}")
    starts = [c["start"] for c in speech if _num(c.get("start"))]
    if any(b < a - 1e-6 for a, b in zip(starts, starts[1:])):
        errors.append("speech cues not ordered")

    peaks = tr.get("peaks")
    if not isinstance(peaks, list) or not peaks:
        errors.append("no waveform peaks")
    elif not all(_num(p) and 0.0 <= p <= 1.0 for p in peaks):
        errors.append("peaks outside 0..1")
    stats = {"duration_sec": dur, "turns": len(turns), "speech_cues": len(speech),
             "reaction_cues": len(reactions), "peaks": len(peaks) if isinstance(peaks, list) else 0}
    return errors, stats


# ---------------------------------------------------------------------------
# Podcast (1 language): one script, rendered per format (video / audio-only)
# ---------------------------------------------------------------------------
@dataclass
class Options:
    evidence_dir: Path
    formats: tuple[str, ...] = PODCAST_FORMATS
    avatars: tuple[str, str] = ("lisa", "harry")
    podcast_turns: int = 4
    podcast_timeout: float = PODCAST_TIMEOUT_SEC
    intro: bool = False
    expect_reactions: bool = False
    allow_listener_fallback: bool = False
    media: Optional[Media] = None


@dataclass
class PodcastScript:
    doc_id: str
    script_id: str
    turn_count: int


@dataclass
class RenderOutcome:
    job: dict
    elapsed_sec: float      # POST /render -> done (server timestamps when available)
    stages: list[str]       # progress stages seen while polling


@dataclass
class FormatOutcome:
    job_id: str
    elapsed_sec: float
    mp3_duration: Optional[float] = None


HOST_NAMES = {"interviewer": "Host", "expert": "Expert"}


def job_file(job_id: str, kind: str) -> str:
    return f"/api/podcast/jobs/{job_id}/file/{kind}"


def save_json(path: Path, data: object) -> None:
    path.write_text(json.dumps(data, indent=1, ensure_ascii=False, default=str), encoding="utf-8")


def _iso_seconds(value: object) -> Optional[float]:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def podcast_prepare(client: httpx.Client, plan: LangPlan, log: Log,
                    opts: Options) -> tuple[Optional[PodcastScript], str]:
    """Ingest the fixture and stream a script: (script, "") or (None, failure detail)."""
    fixture_path = FIXTURE_DIR / plan.fixture
    if not fixture_path.exists():
        msg = f"Fixture missing: {fixture_path}"
        log.fail(msg)
        return None, msg

    # 1. Ingest
    log.step("POST /api/podcast/ingest")
    try:
        with fixture_path.open("rb") as f:
            r = client.post(
                "/api/podcast/ingest",
                files={"file": (
                    fixture_path.name, f,
                    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
                )},
                timeout=120,
            )
    except Exception as e:  # noqa: BLE001
        log.fail(f"ingest: {e}")
        return None, str(e)
    if r.status_code != 200:
        msg = f"ingest -> {r.status_code}: {r.text[:200]}"
        log.fail(msg)
        return None, msg
    doc = r.json().get("document", {})
    doc_id = doc.get("id")
    log.ok(f"ingested doc_id={doc_id} title={doc.get('title')!r}")

    # 2. Script (SSE)
    log.step(f"POST /api/podcast/script/stream lang={plan.language}")
    payload = {
        "document_id": doc_id,
        "language": plan.language,
        "style": "casual",
        "length": "short",
        "num_turns": opts.podcast_turns,
    }
    script_id: Optional[str] = None
    turn_count = 0
    t0 = time.time()
    try:
        with client.stream(
            "POST", "/api/podcast/script/stream",
            json=payload, timeout=180,
        ) as r:
            if r.status_code != 200:
                msg = f"script -> {r.status_code}: {r.read()[:200]!r}"
                log.fail(msg)
                return None, msg
            current_event = None
            for line in r.iter_lines():
                if not line:
                    current_event = None
                    continue
                if line.startswith("event:"):
                    current_event = line.split(":", 1)[1].strip()
                elif line.startswith("data:"):
                    data = line.split(":", 1)[1].strip()
                    if current_event == "turn":
                        turn_count += 1
                    elif current_event == "done":
                        try:
                            script_id = json.loads(data).get("script_id")
                        except json.JSONDecodeError:
                            pass
                        break
                    elif current_event == "error":
                        msg = f"script stream error: {data}"
                        log.fail(msg)
                        return None, msg
    except Exception as e:  # noqa: BLE001
        log.fail(f"script stream: {e}")
        return None, str(e)
    if not script_id:
        msg = "script stream ended without script_id"
        log.fail(msg)
        return None, msg
    log.ok(f"script id={script_id} turns={turn_count} in {time.time()-t0:.1f}s")
    return PodcastScript(doc_id=str(doc_id), script_id=script_id, turn_count=turn_count), ""


def poll_podcast_job(client: httpx.Client, job_id: str, timeout: float,
                     interval: float) -> tuple[Optional[dict], list[str]]:
    """Poll until done/failed/cancelled: (last job, stages seen); (None, stages) on timeout."""
    t0 = time.time()
    stages: list[str] = []
    while time.time() - t0 < timeout:
        try:
            r = client.get(f"/api/podcast/jobs/{job_id}", timeout=30)
            if r.status_code != 200:
                time.sleep(interval)
                continue
            job = r.json()
            state = job.get("state")
            progress = job.get("progress") or {}
            stage = progress.get("stage", "")
            if not stages or stages[-1] != stage:
                stages.append(stage)
                print(f"     ... {state}  stage={stage}  {progress.get('completed', 0)}/{progress.get('total', 0)}")
            if state in ("done", "failed", "cancelled"):
                return job, stages
        except Exception as e:  # noqa: BLE001
            print(f"     ... poll error: {e}")
        time.sleep(interval)
    return None, stages


def podcast_render(client: httpx.Client, prepared: PodcastScript, plan: LangPlan, fmt: str,
                   log: Log, opts: Options) -> Optional[RenderOutcome]:
    log.step(f"POST /api/podcast/render format={fmt}")
    interviewer, expert = opts.avatars
    render_req = {
        "script_id": prepared.script_id,
        "roles": {
            "interviewer": {
                "display_name": HOST_NAMES["interviewer"],
                "avatar": interviewer,   # audio-only: the portrait (no avatar synthesis)
                "voice": plan.voice_female,
            },
            "expert": {
                "display_name": HOST_NAMES["expert"],
                "avatar": expert,
                "voice": plan.voice_male,
            },
        },
        "layout": LAYOUT,
        "music": False,
        "intro": opts.intro,
        "format": fmt,
        "reactions": True,
    }
    t_post = time.time()
    r = client.post("/api/podcast/render", json=render_req, timeout=30)
    if r.status_code != 200:
        log.fail(f"render -> {r.status_code}: {r.text[:300]}")
        return None
    job_id = r.json().get("id")
    log.ok(f"render job queued job_id={job_id}")

    log.step("poll /api/podcast/jobs/{job_id}")
    interval = POLL_INTERVAL_SEC if fmt == "video" else AUDIO_POLL_INTERVAL_SEC
    job, stages = poll_podcast_job(client, str(job_id), opts.podcast_timeout, interval)
    client_sec = time.time() - t_post
    if job is None:
        log.fail(f"render timeout after {opts.podcast_timeout:.0f}s")
        return None
    if job.get("state") != "done":
        log.fail(f"render {job.get('state')}: {job.get('error')}")
        return None
    created, updated = _iso_seconds(job.get("created_at")), _iso_seconds(job.get("updated_at"))
    elapsed = updated - created if created is not None and updated is not None and updated >= created else client_sec
    log.ok(f"render completed in {elapsed:.1f}s (stages: {' -> '.join(s for s in stages if s)})")
    return RenderOutcome(job=job, elapsed_sec=elapsed, stages=stages)


def check_job_contract(job: dict, fmt: str, stages: list[str], log: Log, summary: dict) -> None:
    outputs = job.get("outputs") or {}
    warnings = job.get("warnings")
    mode = job.get("listener_mode")
    summary.update(listener_mode=mode, warnings=warnings, audio_kind=outputs.get("audio_kind"),
                   reactions_requested=job.get("reactions"))
    if job.get("format", "video") == fmt:
        log.ok(f"job format={fmt}")
    else:
        log.fail(f"job format={job.get('format')!r}, requested {fmt}")
    if not isinstance(warnings, list):
        log.fail(f"job warnings missing ({warnings!r})")
        warnings = []
    unknown = [w for w in warnings if w not in KNOWN_WARNINGS]
    if unknown:
        log.fail(f"unknown warning codes: {unknown}")
    else:
        log.ok(f"warnings are stable codes: {', '.join(warnings) or 'none'}")
    if outputs.get("audio_kind") == "radio_mix":
        log.ok("audio_kind=radio_mix (dedicated radio master)")
    else:
        log.fail(f"audio_kind={outputs.get('audio_kind')!r}, expected radio_mix")
    for key in ("mp3_url", "audio_srt_url", "transcript_url", "cover_url"):
        if not outputs.get(key):
            log.fail(f"outputs.{key} missing")

    if fmt == "video":
        missing = [k for k in ("mp4_url", "srt_url") if not outputs.get(k)]
        if missing:
            log.fail(f"video outputs missing: {missing}")
        else:
            log.ok("video outputs: mp4_url + srt_url + radio mp3_url")
        if mode in LISTENER_MODES:
            log.ok(f"listener_mode reported: {mode}")
        else:
            log.fail(f"listener_mode not reported ({mode!r})")
        return

    if outputs.get("mp4_url") or outputs.get("srt_url"):
        log.fail(f"audio-only job exposes video outputs: mp4_url={outputs.get('mp4_url')!r} "
                 f"srt_url={outputs.get('srt_url')!r}")
    else:
        log.ok("audio-only outputs: no mp4_url / srt_url")
    if mode is None:
        log.ok("no listener_mode (no avatar)")
    else:
        log.fail(f"audio-only job reports listener_mode={mode!r}")
    avatar_stages = [s for s in stages if s in AVATAR_STAGES]
    others = [s for s in stages if s and s not in AUDIO_STAGES and s not in AVATAR_STAGES]
    if avatar_stages or others:
        log.fail(f"audio-only progress stages {stages} (avatar pipeline stages: {avatar_stages})")
    else:
        log.ok(f"zero avatar jobs: audio-only stages only ({' -> '.join(s for s in stages if s)})")
    bad = sorted(set(warnings) & (LISTENER_WARNINGS | {"radio_fallback"}))
    if bad:
        log.fail(f"audio-only job has video-only warning codes: {bad}")


def fetch(client: httpx.Client, url: str, log: Log, label: str, *, dest: Optional[Path] = None,
          min_bytes: int = 1, content_type: Optional[str] = None) -> Optional[bytes]:
    try:
        r = client.get(url, timeout=180)
    except Exception as e:  # noqa: BLE001
        log.fail(f"{label} download: {e}")
        return None
    if r.status_code != 200 or len(r.content) < min_bytes:
        log.fail(f"{label} download status={r.status_code} size={len(r.content)}")
        return None
    ct = r.headers.get("content-type", "")
    if content_type and not ct.startswith(content_type):
        log.fail(f"{label} unexpected content-type={ct}")
    if dest is not None:
        dest.write_bytes(r.content)
    log.ok(f"{label} downloaded ({len(r.content):,} bytes)" + (f" -> {dest.name}" if dest else ""))
    return r.content


def check_absent(client: httpx.Client, job_id: str, kinds: Sequence[str], log: Log) -> None:
    for kind in kinds:
        try:
            status = client.get(job_file(job_id, kind), timeout=60).status_code
        except Exception as e:  # noqa: BLE001
            log.fail(f"{kind} route: {e}")
            continue
        if status == 404:
            log.ok(f"{kind} absent for the audio-only job (404)")
        else:
            log.fail(f"{kind} route returned {status} for an audio-only job (expected 404)")


def secret_hits(text: str, secrets: Sequence[str]) -> list[str]:
    low = text.lower()
    return sorted({s for s in secrets if s and s.lower() in low})


def check_mp3(media: Media, path: Path, data: bytes, log: Log, summary: dict,
              secrets: Sequence[str]) -> Optional[float]:
    """Radio MP3: format, CBR, cover, ID3 allow-list, loudness. Returns its duration."""
    try:
        probe = media.probe(path)
    except Exception as e:  # noqa: BLE001
        log.fail(f"mp3 probe: {e}")
        return None
    streams = probe.get("streams") or []
    fmt_info = probe.get("format") or {}
    duration = _float(fmt_info.get("duration"))
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    if audio is None:
        log.fail("mp3 has no audio stream")
        return duration
    codec, rate, channels = audio.get("codec_name"), int(audio.get("sample_rate") or 0), int(audio.get("channels") or 0)
    if codec == "mp3" and rate == MP3_SAMPLE_RATE and channels == 2:
        log.ok(f"mp3 stream: MP3 44.1 kHz stereo, {duration or 0:.1f}s")
    else:
        log.fail(f"mp3 stream: codec={codec} rate={rate} channels={channels} (expected mp3 44100 Hz stereo)")

    bitrates, header, covered = mp3_frame_bitrates(data)
    distinct = sorted(set(bitrates))
    summary["mp3"] = {"duration_sec": duration, "sample_rate": rate, "channels": channels,
                      "bitrates_kbps": distinct, "frames": len(bitrates), "xing_header": header}
    if len(bitrates) >= 10 and len(distinct) == 1 and covered >= 0.98:
        log.ok(f"mp3 is CBR {distinct[0]} kb/s ({len(bitrates)} frames, {header or 'no'} header)")
    else:
        log.fail(f"mp3 not CBR: bitrates {distinct[:8]} over {len(bitrates)} frames "
                 f"({covered:.0%} parsed, {header or 'no'} header)")

    pics = [s for s in streams
            if s.get("codec_type") == "video" and (s.get("disposition") or {}).get("attached_pic") == 1]
    if pics:
        w, h = int(pics[0].get("width") or 0), int(pics[0].get("height") or 0)
        summary["mp3"]["cover"] = [w, h]
        if w == h and w >= 500:
            log.ok(f"mp3 attached cover {w}x{h} ({pics[0].get('codec_name')})")
        else:
            log.fail(f"mp3 attached cover {w}x{h} (expected square >= 500 px)")
    else:
        log.fail("mp3 has no attached cover (APIC)")

    tags = {str(k).lower(): str(v) for k, v in (fmt_info.get("tags") or {}).items()}
    summary["mp3"]["tags"] = sorted(tags)
    extra = sorted(set(tags) - ID3_ALLOWED)
    if extra:
        log.fail(f"mp3 tags outside the allow-list: {extra}")
    else:
        log.ok(f"mp3 tags allow-listed: {', '.join(sorted(tags))}")
    problems = []
    if not tags.get("title", "").strip():
        problems.append("no title")
    if tags.get("comment") != ID3_COMMENT:
        problems.append(f"comment {tags.get('comment')!r}")
    artist = tags.get("artist", "")
    if not all(name in artist for name in HOST_NAMES.values()):
        problems.append(f"artist {artist!r} lacks the host names")
    leaks = secret_hits(" ".join(tags.values()), secrets)
    if leaks:
        problems.append(f"voice ids in tags {leaks}")
    if problems:
        log.fail("mp3 tag values: " + "; ".join(problems))
    else:
        log.ok("mp3 tag values: title, host names, AI-generated voices comment, no voice ids")

    try:
        lufs, tp = media.loudness(path)
    except Exception as e:  # noqa: BLE001
        log.fail(f"loudness: {e}")
        return duration
    summary["mp3"].update(integrated_lufs=lufs, true_peak_dbtp=tp)
    if lufs is None:
        log.fail("loudness: no integrated loudness from ebur128")
    elif abs(lufs - LOUDNESS_TARGET_LUFS) <= LOUDNESS_TOLERANCE_LU:
        log.ok(f"integrated loudness {lufs:.1f} LUFS (target -16 +- 1)")
    else:
        log.fail(f"integrated loudness {lufs:.1f} LUFS (target -16 +- 1)")
    if tp is not None:
        if tp > 0.0:
            log.fail(f"true peak {tp:.1f} dBTP (clipping)")
        elif tp > TRUE_PEAK_MAX_DBTP:
            log.warn(f"true peak {tp:.1f} dBTP (> -1 dBTP)")
        else:
            log.ok(f"true peak {tp:.1f} dBTP (<= -1)")
    return duration


def check_radio_audio(media: Media, path: Path, transcript: Optional[dict], log: Log, summary: dict,
                      opts: Options) -> None:
    """Leading silence and audible backchannels at their reaction cues."""
    try:
        pcm = media.pcm_mono(path)
    except Exception as e:  # noqa: BLE001
        log.fail(f"radio audio decode: {e}")
        return
    onset = first_onset(pcm, PCM_RATE, SILENCE_DBFS)
    summary["radio_onset_sec"] = onset
    if onset is None:
        log.fail("radio mp3 is silent")
    elif onset < LEADING_SILENCE_MAX_SEC:
        log.ok(f"sound starts at {onset:.2f}s (no leading silence >= 1 s)")
    else:
        log.fail(f"leading silence {onset:.2f}s (>= 1 s)")

    cues = [c for c in (transcript or {}).get("cues") or [] if isinstance(c, dict)]
    reactions = [c for c in cues if c.get("kind") == "reaction" and _num(c.get("start")) and _num(c.get("end"))]
    if not reactions:
        msg = "no reaction cues in the transcript (PODCAST_REACTIONS off, or nothing fitted)"
        (log.fail if opts.expect_reactions else log.info)(msg + (" -- --expect-reactions" if opts.expect_reactions else ""))
        return
    levels = [rms_dbfs(pcm[int(c["start"] * PCM_RATE):int(c["end"] * PCM_RATE)]) for c in reactions]
    summary["reaction_cue_dbfs"] = [round(v, 1) if math.isfinite(v) else None for v in levels]
    quiet = [f"{c['start']:.2f}s" for c, v in zip(reactions, levels) if not v >= REACTION_AUDIBLE_DBFS]
    if quiet:
        log.fail(f"backchannel cues not audible in the radio mix at {quiet} (< {REACTION_AUDIBLE_DBFS:.0f} dBFS)")
    else:
        log.ok(f"{len(reactions)} backchannel cue(s) audible in the radio mix (min {min(levels):.1f} dBFS)")


def check_video_file(media: Media, path: Path, log: Log, summary: dict) -> Optional[float]:
    try:
        probe = media.probe(path)
    except Exception as e:  # noqa: BLE001
        log.fail(f"mp4 probe: {e}")
        return None
    video = next((s for s in probe.get("streams") or [] if s.get("codec_type") == "video"), None)
    duration = _float((probe.get("format") or {}).get("duration"))
    summary["mp4"] = {"duration_sec": duration, "width": (video or {}).get("width"), "height": (video or {}).get("height")}
    if video and video.get("width") == 1920 and video.get("height") == 1080:
        log.ok(f"mp4 1920x1080, {duration or 0:.1f}s")
    else:
        log.fail(f"mp4 video stream {summary['mp4']} (expected 1920x1080)")
    return duration


def check_durations(fmt: str, outputs: dict, mp3_duration: Optional[float], mp4_duration: Optional[float],
                    log: Log, summary: dict) -> None:
    """Reported durations vs probed files; Watch/Listen sanity for video jobs."""
    a, v = outputs.get("audio_duration_sec"), outputs.get("video_duration_sec")
    if mp3_duration is not None:
        if _num(a) and abs(a - mp3_duration) <= DURATION_TOLERANCE_SEC:
            log.ok(f"outputs.audio_duration_sec {a:.1f}s matches the MP3")
        else:
            log.fail(f"outputs.audio_duration_sec {a!r} vs MP3 {mp3_duration:.2f}s")
    if fmt != "video":
        if v is not None:
            log.fail(f"audio-only job reports video_duration_sec={v!r}")
        return
    if mp4_duration is None:
        return
    if _num(v) and abs(v - mp4_duration) <= DURATION_TOLERANCE_SEC:
        log.ok(f"outputs.video_duration_sec {v:.1f}s matches the MP4")
    else:
        log.fail(f"outputs.video_duration_sec {v!r} vs MP4 {mp4_duration:.2f}s")
    if mp3_duration is not None and mp4_duration > 0:
        ratio = mp3_duration / mp4_duration
        summary["listen_watch_ratio"] = round(ratio, 3)
        msg = f"Watch {mp4_duration:.1f}s vs Listen {mp3_duration:.1f}s (radio = {ratio:.0%} of the video)"
        if mp3_duration <= mp4_duration + 1.0 and ratio >= 0.5:
            log.ok(msg)
        else:
            log.fail(msg + " -- expected a tighter radio mix of the same turns")


def check_listener(media: Media, mp4: Path, transcript: dict, job: dict, log: Log, summary: dict,
                   opts: Options, stem: Path) -> None:
    """Live listener: motion vs a frozen reference, full colour, reaction motion spikes."""
    tiles, static = LAYOUT_TILES.get(LAYOUT), STATIC_REGIONS.get(LAYOUT)
    if not tiles or not static:
        log.fail(f"no geometry for layout {LAYOUT}")
        return
    faces = {role: face_rect(tiles[role]) for role in ROLES}
    turns = sorted((t for t in transcript.get("turns") or []
                    if isinstance(t, dict) and t.get("speaker") in ROLES
                    and _num(t.get("video_start")) and _num(t.get("video_end"))),
                   key=lambda t: t["video_start"])
    by_idx = {t.get("turn_idx"): t for t in turns}
    reactions = [c for c in transcript.get("cues") or []
                 if isinstance(c, dict) and c.get("kind") == "reaction" and c.get("speaker") in ROLES
                 and _num(c.get("start")) and _num(c.get("end")) and c.get("turn_idx") in by_idx]
    reacted = {c["turn_idx"] for c in reactions}
    mode = job.get("listener_mode")
    if mode != "idle_loop":
        msg = (f"listener_mode={mode!r}: not the alive idle loop "
               f"(warnings: {', '.join(job.get('warnings') or []) or 'none'})")
        (log.warn if opts.allow_listener_fallback else log.fail)(msg)

    idle: dict[str, list[float]] = {r: [] for r in ROLES}
    any_listen: dict[str, list[float]] = {r: [] for r in ROLES}
    idle_roll: dict[str, list[float]] = {r: [] for r in ROLES}
    listen_rgb: dict[str, list] = {r: [] for r in ROLES}
    speak_rgb: dict[str, list] = {r: [] for r in ROLES}
    ref_motion: list[float] = []
    windows: list[dict] = []
    for t in turns[:MAX_TURN_WINDOWS]:
        speaker = t["speaker"]
        listener = ROLES[1 - ROLES.index(speaker)]
        start = t["video_start"] + WINDOW_LEAD_SEC
        end = min(t["video_end"] - WINDOW_TAIL_SEC, start + WINDOW_MAX_SEC)
        if end - start < WINDOW_MIN_SEC:
            continue
        try:
            face, ref = media.crops(mp4, start, end - start, [faces[listener], static], MOTION_SIZE)
            lc, sc = media.crops(mp4, start, end - start, [faces[listener], faces[speaker]], COLOUR_SIZE,
                                 "rgb24", COLOUR_FPS)
        except Exception as e:  # noqa: BLE001
            log.fail(f"listener frames (turn {t.get('turn_idx')}): {e}")
            continue
        m, r = motion_series(face), motion_series(ref)
        if m.size < 10 or r.size < 10:
            continue
        lm, rm = float(m.mean()), float(r.mean())
        ref_motion.append(rm)
        any_listen[listener].append(lm)
        if t.get("turn_idx") not in reacted:
            idle[listener].append(lm)
            idle_roll[listener].extend(rolling_mean(m, ROLL_FRAMES).tolist())
        if lc.shape[0] and sc.shape[0]:
            listen_rgb[listener].append(lc.reshape(-1, 3).mean(axis=0))
            speak_rgb[speaker].append(sc.reshape(-1, 3).mean(axis=0))
        windows.append({"turn_idx": t.get("turn_idx"), "speaker": speaker, "listener": listener,
                        "window_sec": [round(start, 2), round(end, 2)], "listener_motion": round(lm, 4),
                        "frozen_reference_motion": round(rm, 4), "reaction_turn": t.get("turn_idx") in reacted})
        if len(windows) <= 4:
            media.snapshot(mp4, (start + end) / 2, stem.with_name(f"{stem.name}-listen-turn{t.get('turn_idx')}.png"))
    summary["listener_windows"] = windows
    if not windows:
        log.fail("listener: no turn window long enough to measure")
        return

    frozen = statistics.median(ref_motion)
    threshold = max(MOTION_ALIVE, MOTION_REF_FACTOR * frozen)
    summary["listener"] = {"mode": mode, "frozen_reference": round(frozen, 4), "alive_threshold": round(threshold, 4)}
    for role in ROLES:
        samples = idle[role] or any_listen[role]
        if not samples:
            log.fail(f"listener {role}: never measured while the other host speaks")
            continue
        value = statistics.median(samples)
        summary["listener"][f"{role}_motion"] = round(value, 4)
        msg = (f"listener {role} tile motion {value:.3f} vs frozen reference {frozen:.4f} "
               f"(alive >= {threshold:.3f}; {len(samples)} turn(s))")
        if value >= threshold:
            log.ok(msg)
        elif opts.allow_listener_fallback and mode != "idle_loop":
            log.warn(msg + " -- listener fallback allowed")
        else:
            log.fail(msg)

    for role in ROLES:
        if not listen_rgb[role] or not speak_rgb[role]:
            log.fail(f"listener {role} colour: needs a listening and a speaking turn")
            continue
        lis = np.mean(np.stack(listen_rgb[role]), axis=0)
        spk = np.mean(np.stack(speak_rgb[role]), axis=0)
        ratios = lis / np.maximum(spk, 1.0)
        weights = np.array([0.2126, 0.7152, 0.0722])
        luma = float((lis @ weights) / max(float(spk @ weights), 1.0))
        summary["listener"][f"{role}_colour_ratio_rgb"] = [round(float(x), 3) for x in ratios]
        msg = (f"listener {role} keeps full colour: listening/speaking RGB "
               f"{'/'.join(f'{x:.2f}' for x in ratios)}, luma {luma:.2f} (dimmed < {COLOUR_MIN_RATIO})")
        (log.ok if float(ratios.min()) >= COLOUR_MIN_RATIO else log.fail)(msg)

    if not reactions:
        return
    spikes: list[dict] = []
    for c in reactions[:MAX_REACTION_CHECKS]:
        turn, listener = by_idx[c["turn_idx"]], c["speaker"]
        tv = map_rendition_time(turns, float(c["start"]), "audio")
        ws = max(turn["video_start"] + 0.2, tv - SPIKE_SEARCH_SEC)
        we = min(turn["video_end"] - 0.05, tv + SPIKE_SEARCH_SEC + float(c["end"]) - float(c["start"]))
        if we - ws < 0.6:
            continue
        try:
            (face,) = media.crops(mp4, ws, we - ws, [faces[listener]], MOTION_SIZE)
        except Exception as e:  # noqa: BLE001
            log.fail(f"reaction frames at {tv:.2f}s: {e}")
            continue
        roll = rolling_mean(motion_series(face), ROLL_FRAMES)
        if roll.size == 0:
            continue
        peak = float(roll.max())
        base = float(np.percentile(idle_roll[listener], 95)) if idle_roll[listener] else float(np.median(roll))
        hit = peak >= SPIKE_MIN_ABS and peak >= SPIKE_MIN_RATIO * base
        spikes.append({"radio_sec": round(float(c["start"]), 2), "video_sec": round(tv, 2), "listener": listener,
                       "peak": round(peak, 3), "idle_p95": round(base, 3), "spike": hit})
        if hit:
            media.snapshot(mp4, ws + (int(np.argmax(roll)) + ROLL_FRAMES / 2) / 25.0,
                           stem.with_name(f"{stem.name}-reaction-{tv:.1f}s.png"))
    summary["reaction_spikes"] = spikes
    found = sum(1 for s in spikes if s["spike"])
    detail = ", ".join(f"{s['video_sec']:.1f}s peak {s['peak']:.2f}/idle {s['idle_p95']:.2f}" for s in spikes)
    if found:
        log.ok(f"listener motion spike near {found}/{len(spikes)} reaction cue(s) ({detail})")
    elif "reactions_skipped" in (job.get("warnings") or []):
        log.warn(f"no listener motion spike near the reaction cues ({detail}); reactions_skipped reported")
    else:
        log.fail(f"no listener motion spike near the reaction cues ({detail or 'no window'})")


def check_podcast_scorm(client: httpx.Client, job_id: str, log: Log) -> None:
    """SCORM package of the podcast: the radio MP3 + captions timed on it."""
    log.step("GET /api/podcast/jobs/{job_id}/file/scorm")
    try:
        r = client.get(f"/api/podcast/jobs/{job_id}/file/scorm", timeout=180)
        if r.status_code != 200:
            log.fail(f"scorm download status={r.status_code}")
        else:
            ct = r.headers.get("content-type", "")
            if ct.startswith("application/zip"):
                log.ok(f"scorm content-type={ct}")
            else:
                log.fail(f"scorm unexpected content-type={ct}")
            zf = zipfile.ZipFile(io.BytesIO(r.content))
            names = zf.namelist()
            if "imsmanifest.xml" in names:
                log.ok("scorm contains imsmanifest.xml")
            else:
                log.fail("scorm missing imsmanifest.xml")
            if "index.html" in names:
                log.ok("scorm contains index.html")
            else:
                log.fail("scorm missing index.html")
            if "scorm.js" in names:
                log.ok("scorm contains scorm.js")
            else:
                log.fail("scorm missing scorm.js")
            if "subtitles.vtt" in names:
                log.ok("scorm contains subtitles.vtt")
            else:
                log.fail("scorm missing subtitles.vtt")
            if any(n.endswith(".mp3") for n in names):
                log.ok("scorm contains mp3 audio")
            else:
                log.fail("scorm missing mp3 audio")
            # Validate manifest XML
            if "imsmanifest.xml" in names:
                manifest = zf.read("imsmanifest.xml").decode()
                root = ET.fromstring(manifest)
                if "scormtype" in manifest.lower() or "scormType" in manifest:
                    log.ok(f"scorm manifest valid ({len(manifest):,} bytes)")
                else:
                    log.fail("scorm manifest missing scormType attribute")
            # Validate player HTML
            if "index.html" in names:
                html = zf.read("index.html").decode()
                if "<audio" in html:
                    log.ok("scorm player contains audio tag")
                else:
                    log.fail("scorm player missing audio tag")
                if "scormInit" in html:
                    log.ok("scorm player contains scormInit")
                else:
                    log.fail("scorm player missing scormInit")
            # Validate subtitles
            if "subtitles.vtt" in names:
                vtt = zf.read("subtitles.vtt").decode()
                if vtt.startswith("WEBVTT"):
                    log.ok("scorm subtitles in VTT format")
                else:
                    log.fail("scorm subtitles not in VTT format")
            log.ok(f"scorm package valid ({len(names)} files, {len(r.content):,} bytes)")
    except Exception as e:  # noqa: BLE001
        log.fail(f"scorm validation: {e}")


def run_podcast_format(client: httpx.Client, plan: LangPlan, prepared: PodcastScript, fmt: str, log: Log,
                       result: RunResult, opts: Options, t_start: float) -> Optional[FormatOutcome]:
    """Render ``prepared`` as ``fmt`` and run every check; None when the render failed."""
    fails_before = log.fails
    outcome = podcast_render(client, prepared, plan, fmt, log, opts)
    if outcome is None:
        result.state, result.detail = "fail", f"{fmt} render failed"
        return None
    job = outcome.job
    job_id = str(job.get("id"))
    outputs = job.get("outputs") or {}
    stem = opts.evidence_dir / f"podcast-{plan.language}-{fmt}-{job_id}"
    secrets = (plan.voice_female, plan.voice_male, "DragonHD")
    summary: dict[str, Any] = {"job_id": job_id, "format": fmt, "language": plan.language,
                               "render_sec": round(outcome.elapsed_sec, 1), "stages": outcome.stages,
                               "outputs": outputs}
    check_job_contract(job, fmt, outcome.stages, log, summary)

    # Media: the radio MP3 always; the MP4 for video (absent, 404, for audio-only).
    mp3 = fetch(client, outputs.get("mp3_url") or job_file(job_id, "mp3"), log, "mp3",
                dest=stem.with_suffix(".mp3"), min_bytes=10_000, content_type="audio/mpeg")
    mp4 = None
    if fmt == "video":
        mp4 = fetch(client, outputs.get("mp4_url") or job_file(job_id, "mp4"), log, "mp4",
                    dest=stem.with_suffix(".mp4"), min_bytes=10_000, content_type="video/mp4")
    else:
        check_absent(client, job_id, ("mp4", "srt"), log)
    if mp3 is not None:
        result.output_bytes = len(mp3)
    tr_bytes = fetch(client, outputs.get("transcript_url") or job_file(job_id, "transcript"), log, "transcript",
                     dest=stem.with_name(stem.name + ".transcript.json"), content_type="application/json")
    srt_bytes = fetch(client, outputs.get("audio_srt_url") or job_file(job_id, "audio_srt"), log, "audio_srt",
                      dest=stem.with_name(stem.name + ".audio.srt"))
    cover = fetch(client, outputs.get("cover_url") or job_file(job_id, "cover"), log, "cover",
                  dest=stem.with_name(stem.name + ".cover.jpg"), content_type="image/")

    media = opts.media
    mp3_duration = mp4_duration = None
    if media is not None and mp3 is not None:
        mp3_duration = check_mp3(media, stem.with_suffix(".mp3"), mp3, log, summary, secrets)
    if media is not None and mp4 is not None:
        mp4_duration = check_video_file(media, stem.with_suffix(".mp4"), log, summary)

    transcript: Optional[dict] = None
    if tr_bytes is not None:
        try:
            transcript = json.loads(tr_bytes.decode("utf-8"))
        except ValueError as e:
            log.fail(f"transcript is not JSON: {e}")
    if transcript is not None:
        audio_dur = mp3_duration if mp3_duration is not None else _float(outputs.get("audio_duration_sec"))
        video_dur = mp4_duration if mp4_duration is not None else _float(outputs.get("video_duration_sec"))
        errors, stats = validate_transcript(transcript, fmt=fmt, duration=audio_dur, video_duration=video_dur,
                                            turn_count=prepared.turn_count, host_names=HOST_NAMES)
        leaks = secret_hits(tr_bytes.decode("utf-8", errors="replace"), secrets) if tr_bytes else []
        if leaks:
            errors.append(f"voice ids {leaks}")
        summary["transcript"] = stats
        if errors:
            log.fail(f"transcript invalid: {'; '.join(errors[:6])}" + (f" (+{len(errors) - 6} more)" if len(errors) > 6 else ""))
        else:
            offsets = ", turns carry video_start/video_end" if fmt == "video" else ""
            log.ok(f"transcript valid: {stats['turns']} turns ordered, {stats['speech_cues']} speech + "
                   f"{stats['reaction_cues']} reaction cues inside {stats['duration_sec']:.1f}s, "
                   f"{stats['peaks']} peaks{offsets}")

    if srt_bytes is not None:
        try:
            cues = parse_srt(srt_bytes.decode("utf-8-sig", errors="replace"))
            limit = (mp3_duration or _float(outputs.get("audio_duration_sec")) or float("inf")) + DURATION_TOLERANCE_SEC
            bad = [c for c in cues if not 0 <= c[0] <= c[1] <= limit or not c[2]]
            unordered = any(b[0] < a[0] - 1e-6 for a, b in zip(cues, cues[1:]))
            if not cues or bad or unordered:
                log.fail(f"audio_srt: {len(cues)} cues, {len(bad)} out of range/empty, ordered={not unordered}")
            else:
                log.ok(f"audio_srt parses: {len(cues)} cues, last ends {cues[-1][1]:.1f}s")
        except ValueError as e:
            log.fail(f"audio_srt: {e}")

    if cover is not None:
        if cover[:3] == b"\xff\xd8\xff":
            log.ok(f"cover is a JPEG ({len(cover):,} bytes)")
        else:
            log.fail("cover is not a JPEG")

    check_durations(fmt, outputs, mp3_duration, mp4_duration, log, summary)
    if media is not None and mp3 is not None:
        check_radio_audio(media, stem.with_suffix(".mp3"), transcript, log, summary, opts)
    if media is not None and mp4 is not None and transcript is not None:
        check_listener(media, stem.with_suffix(".mp4"), transcript, job, log, summary, opts, stem)

    check_podcast_scorm(client, job_id, log)
    save_json(stem.with_name(stem.name + ".summary.json"), summary)
    result.duration_sec = time.time() - t_start
    if log.fails == fails_before:
        result.state = "pass"
    else:
        result.state, result.detail = "fail", f"{log.fails - fails_before} check(s) failed"
    return FormatOutcome(job_id=job_id, elapsed_sec=outcome.elapsed_sec, mp3_duration=mp3_duration)


def run_podcast_for_language(client: httpx.Client, plan: LangPlan, log: Log, opts: Options) -> None:
    log.header(f"PODCAST  {plan.language}  {plan.fixture}  ({', '.join(opts.formats)})")
    results = {fmt: RunResult(kind=PODCAST_KIND[fmt], language=plan.language, fixture=plan.fixture)
               for fmt in opts.formats}
    for fmt in opts.formats:
        log.record(results[fmt])

    t_start = time.time()
    prepared, detail = podcast_prepare(client, plan, log, opts)
    if prepared is None:
        for res in results.values():
            res.state, res.detail = "fail", detail
        return

    done: dict[str, FormatOutcome] = {}
    for i, fmt in enumerate(opts.formats):
        log.header(f"PODCAST {fmt.upper()}  {plan.language}  {plan.fixture}")
        # The first rendition's time includes the shared ingest + script.
        started = t_start if i == 0 else time.time()
        out = run_podcast_format(client, plan, prepared, fmt, log, results[fmt], opts, started)
        if out is not None:
            done[fmt] = out

    if "video" in done and "audio" in done:
        log.header(f"PODCAST VIDEO vs AUDIO  {plan.language}")
        v, a = done["video"].elapsed_sec, done["audio"].elapsed_sec
        ratio = v / a if a > 0 else float("inf")
        msg = f"audio-only render {a:.1f}s vs video render {v:.1f}s -> {ratio:.1f}x faster"
        (log.ok if ratio >= SPEED_MIN_RATIO else log.fail)(msg + f" (expected >= {SPEED_MIN_RATIO:.0f}x)")
        va, aa = done["video"].mp3_duration, done["audio"].mp3_duration
        if va and aa:
            log.info(f"radio mixes of the same script: video job {va:.1f}s, audio job {aa:.1f}s "
                     f"({abs(va - aa) / va:.0%} apart)")


# ---------------------------------------------------------------------------
# Entry
# ---------------------------------------------------------------------------
def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default=DEFAULT_BASE)
    parser.add_argument(
        "--languages",
        default="en-US",
        help="Comma-separated list of locales to test, e.g. 'fr-FR,en-US,es-ES'. "
             "Default: en-US only.",
    )
    parser.add_argument("--skip-video", action="store_true", help="Skip the video")
    parser.add_argument("--skip-podcast", action="store_true", help="Skip the podcast")
    parser.add_argument("--podcast-formats", default=",".join(PODCAST_FORMATS),
                        help="Podcast renditions to render from one script: 'video,audio' (default), "
                             "'video' or 'audio'.")
    parser.add_argument("--avatars", default="lisa,harry",
                        help="interviewer,expert avatar ids (video; portraits for audio-only). Default: lisa,harry.")
    parser.add_argument("--podcast-turns", type=int, default=4,
                        help="Script turns (4-16, default 4). The first/last turns never get a backchannel and "
                             "two never follow each other: more turns give reactions more room.")
    parser.add_argument("--podcast-timeout", type=float, default=PODCAST_TIMEOUT_SEC,
                        help=f"Seconds to wait for a podcast render (default {PODCAST_TIMEOUT_SEC}).")
    parser.add_argument("--intro", action="store_true", help="Render podcasts with the intro & outro (sonic logo).")
    parser.add_argument("--expect-reactions", action="store_true",
                        help="Fail when a podcast has no backchannel cue (backend with PODCAST_REACTIONS=true).")
    parser.add_argument("--allow-listener-fallback", action="store_true",
                        help="Only warn when the video listener is not the alive idle loop.")
    parser.add_argument("--no-media-checks", action="store_true",
                        help="Skip ffmpeg/numpy media checks (API, transcript and SRT checks still run).")
    parser.add_argument("--evidence-dir", default=DEFAULT_EVIDENCE,
                        help="Downloads + measurements (default OZ_RADIO_E2E_EVIDENCE or test-results/e2e-render).")
    parser.add_argument("--tool-dirs", default=os.environ.get("OZ_RADIO_E2E_TOOL_DIRS", ""),
                        help="Extra dirs (os.pathsep-separated) holding ffmpeg/ffprobe "
                             "(default OZ_RADIO_E2E_TOOL_DIRS), else PATH.")
    args = parser.parse_args()

    requested = [lang.strip() for lang in args.languages.split(",") if lang.strip()]
    unknown = [lang for lang in requested if lang not in PLANS]
    if unknown:
        print(f"ERROR: unknown languages: {unknown}. Supported: {sorted(PLANS.keys())}")
        return 2
    formats = tuple(f.strip() for f in args.podcast_formats.split(",") if f.strip())
    if not formats or any(f not in PODCAST_FORMATS for f in formats) or len(set(formats)) != len(formats):
        print(f"ERROR: --podcast-formats must list {PODCAST_FORMATS} (got {args.podcast_formats!r})")
        return 2
    avatars = tuple(a.strip() for a in args.avatars.split(","))
    if len(avatars) != 2 or not all(avatars):
        print(f"ERROR: --avatars needs 'interviewer,expert' (got {args.avatars!r})")
        return 2
    if not 4 <= args.podcast_turns <= 16:
        print("ERROR: --podcast-turns must be within 4..16")
        return 2

    opts = Options(
        evidence_dir=Path(args.evidence_dir).resolve(),
        formats=formats,
        avatars=(avatars[0], avatars[1]),
        podcast_turns=args.podcast_turns,
        podcast_timeout=args.podcast_timeout,
        intro=args.intro,
        expect_reactions=args.expect_reactions,
        allow_listener_fallback=args.allow_listener_fallback,
    )
    if not args.skip_podcast:
        if not args.no_media_checks:
            ffmpeg, ffprobe = find_tool("ffmpeg", args.tool_dirs), find_tool("ffprobe", args.tool_dirs)
            if np is None or not ffmpeg or not ffprobe:
                print("ERROR: podcast media checks need numpy + ffmpeg + ffprobe "
                      "(set OZ_RADIO_E2E_TOOL_DIRS / --tool-dirs, or pass --no-media-checks)")
                return 2
            opts.media = Media(ffmpeg, ffprobe)
        opts.evidence_dir.mkdir(parents=True, exist_ok=True)

    print(f"Target: {args.base_url}")
    print(f"Languages: {requested}")
    print(f"Features: {'video ' if not args.skip_video else ''}"
          f"{'podcast' if not args.skip_podcast else ''}".strip())
    if not args.skip_podcast:
        print(f"Podcast formats: {list(formats)}  turns={args.podcast_turns}  intro={args.intro}  "
              f"media checks={'on' if opts.media else 'off'}")
        print(f"Evidence: {opts.evidence_dir}")

    log = Log()
    with httpx.Client(base_url=args.base_url, timeout=60) as client:
        for lang in requested:
            plan = PLANS[lang]
            if not args.skip_video:
                run_video_for_language(client, plan, log)
            if not args.skip_podcast:
                run_podcast_for_language(client, plan, log, opts)
    return log.summary()


if __name__ == "__main__":
    sys.exit(main())
