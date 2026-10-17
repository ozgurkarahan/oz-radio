"""Cached listener kits: the alive, silent "listening" loop and the lip-synced
backchannel clips of one podcast host (avatar + voice + language).

Recipe (spike S1, custom photo avatars on VASA-1)
-------------------------------------------------
* **One batch-avatar job per (avatar, voice, language)** (``build_kit_ssml``):
  ``<break 250ms/><break 12000ms/>`` (silent idle section), then the unique
  reaction phrases (``reaction_text``; identical texts are spoken once and
  share one clip) separated by ``<break 1500ms/>``, then a 600 ms break. The
  job always has phrase content after the silence: silence that is not
  followed by words is dropped by the service, and the trailing break is cut
  to about 150–225 ms. S1's proven layout keeps that residue because it holds
  the last clip's +60 ms margin; windows are clamped to the media anyway.
  Default photo-avatar config (``scene.amplitude`` is already at its
  maximum); green mp4 512×512 at 25 fps (WebM gives no alpha for photo avatars).
* **Phrases**: ``silencedetect`` (−40 dB, 0.3 s) islands in the phrase section
  (from 1 s before the expected first onset), gaps < 0.7 s merged, bounds
  refined on a 5 ms envelope at max(−50 dBFS, noise + 12 dB). Exactly one
  island per unique phrase is required, else the kit has no reactions
  (``reactions_skipped``). Each clip uses the window [onset − 0.06 s,
  offset + 0.06 s], snapped outward to the frame grid, for both the video
  (keyed to VP9 + alpha WebM: ``chromakey`` first, then ``despill``) and the
  audio (48 kHz mono WAV, 5 ms edge fades). ``duration_sec`` is the window length.
* **Idle window** = [1.0 s, first onset − 1.5 s]: the first second settles and
  the mouth anticipates speech. **Motion** = mean |Fₜ − Fₜ₋₁| of the unkeyed
  128 px face crop (``MOTION_VF``, numpy): ≥ 0.30 is alive; < 0.05 is frozen
  (no loop → ``procedural`` + ``listener_static``); in between is *weak*. A weak
  loop is kept (``idle_loop``), ``listener_static`` flags it, and
  ``IdleLoop.motion_score`` lets compose add its sway.
* **Loop** = the best forward pair i < j, 5–8 s apart, by MSE of the 64 px
  face-crop signatures (``SIGNATURE_VF``). The tail is cross-faded into the
  head over 0.28 s (7 frames), so the loop has (j − i) − 7 frames and wraps
  on natural consecutive frames. The pair is accepted when its MSE is at most
  4 × the p90 of consecutive-frame MSE (S1 measured 1.5–2.5×); otherwise the
  loop is a 4 s ping-pong (8 s cycle, seamless by construction). The blend
  runs on the raw yuv420p source frames, which are then keyed exactly like
  the talking clips. ``signature_path`` (.npz: ``frames`` uint8 [N, 64, 64],
  ``fps``) holds the loop's frames in loop order, computed with
  ``SIGNATURE_VF`` on the unkeyed blended frames.

Cache (hash-only names; no character name in any name, sidecar or log)
----------------------------------------------------------------------
* L1 ``data/podcast/listener_kit/{key}/``: ``kit.json`` (written last) plus
  content-addressed files ``{sha256[:20]}.webm|.wav|.npz``.
* L2 private blob ``podcast-cache/listener-kit/{key}/`` (same layout, same
  storage config as the library; never under ``podcast-library/``, never
  SAS). Uploads are create-if-absent (``If-None-Match: *``), so a 409 is
  ignored. File blobs go first and ``kit.json`` goes last; a corrupt
  ``kit.json`` is replaced only through an ETag-conditional delete.
* ``key`` = the first 24 hex characters of the sha256 of a canonical JSON of
  {kit version, avatar character + style + base model + output format,
  voice, language, phrases, idle_ms, recipe}.
* A per-key ``threading.Lock`` with double-checked L1 → L2 → synthesis.
  Corrupt or incomplete entries (size/sha256 mismatch, bad sidecar) are
  rebuilt. Paid footage whose processing failed is kept under ``.footage/``
  and processed once more before paying again.

API: ``resolve_listener_kits`` (both roles in parallel threads) and
``ensure_listener_kit`` (one host; the ``warm-listeners`` CLI). Neither
raises: a failure gives a fallback kit (``procedural``, or ``still`` when
``PODCAST_LISTENER_MODE=still``) with stable warning codes. Only custom photo
avatars (green mp4) get kits; other avatar kinds use the fallback.
"""
from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import re
import shutil
import subprocess
import threading
import time
import uuid
import wave
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import TYPE_CHECKING, Any, Optional, Sequence
from xml.sax.saxutils import escape as _xml_escape

import numpy as np

from services import avatar_registry
from services.podcast_media import (
    REACTION_IDS,
    WARNING_LISTENER_FALLBACK,
    WARNING_LISTENER_STATIC,
    WARNING_LISTENER_TIMEOUT,
    WARNING_REACTIONS_SKIPPED,
    IdleLoop,
    ListenerKit,
    ReactionClip,
    add_warning,
    listener_mode,
    reaction_text,
)

if TYPE_CHECKING:  # pragma: no cover
    from config import AzureConfig
    from services.avatar_registry import AvatarEntry
    from services.podcast_models import RenderRoles

log = logging.getLogger(__name__)

KIT_VERSION = 1
ROLES: tuple[str, str] = ("interviewer", "expert")

BACKEND_DIR = Path(__file__).resolve().parents[1]
L1_ROOT = BACKEND_DIR / "data" / "podcast" / "listener_kit"
L2_PREFIX = "podcast-cache/listener-kit"
MANIFEST_NAME = "kit.json"
FOOTAGE_DIR_NAME = ".footage"

FFMPEG = "ffmpeg"
FFPROBE = "ffprobe"
FFMPEG_TIMEOUT_SEC = 300.0

FPS = 25  # batch avatar output rate; the probed rate wins

# SSML layout (spike S1).
LEAD_MS = 250
IDLE_MS = 12_000
GAP_MS = 1_500
TAIL_MS = 600

# Idle window [IDLE_START_SEC, first phrase onset - IDLE_GUARD_SEC].
IDLE_START_SEC = 1.0
IDLE_GUARD_SEC = 1.5

# Pose signature shared with podcast_compose: apply to ORIGINAL (unkeyed) footage.
SIGNATURE_VF = "crop=iw*0.6:ih*0.6:iw*0.2:ih*0.2,scale=64:64:flags=area,format=gray"
SIGNATURE_SIZE = 64

# Face-motion metric (S1): mean |F_t - F_t-1| of the unkeyed 128 px face crop.
MOTION_VF = "crop=iw*0.6:ih*0.6:iw*0.2:ih*0.2,scale=128:128:flags=area,format=gray"
MOTION_SIZE = 128
MOTION_ALIVE = 0.30
MOTION_FROZEN = 0.05

# Loop search on the signatures of the idle window.
LOOP_MIN_SEC = 5.0
LOOP_MAX_SEC = 8.0
SEAM_CROSSFADE_SEC = 0.28
SEAM_MAX_RATIO = 4.0      # forward loop when seam MSE <= ratio x p90(consecutive-frame MSE)
SEAM_MSE_FLOOR = 1.0      # guards a ~0 p90 (static or synthetic footage)
PINGPONG_SEC = 4.0        # ping-pong half cycle (fallback)
MIN_PINGPONG_SEC = 2.0

# Phrase segmentation.
SILENCE_NOISE_DB = -40
SILENCE_MIN_SEC = 0.3
ISLAND_MIN_SEC = 0.05
ISLAND_MERGE_SEC = 0.7
PHRASE_SECTION_LEAD_SEC = 1.0   # phrase islands start >= expected first onset - this
ONSET_FLOOR_DBFS = -50.0
ONSET_OVER_NOISE_DB = 12.0
ENVELOPE_SEC = 0.005
REFINE_SEARCH_SEC = 0.25
CLIP_MARGIN_SEC = 0.06
EDGE_FADE_SEC = 0.005
ANALYSIS_RATE = 16_000
AUDIO_RATE = 48_000

# Keying: the compositor's chain (chromakey first, then despill).
CHROMA_VF = "chromakey=0x00ff00:0.22:0.12,despill=type=green:mix=0.6:expand=0.3:brightness=0"
# VP9 + alpha WebM (MP4 drops alpha); -auto-alt-ref 0 is required with alpha.
VP9_ARGS: tuple[str, ...] = (
    "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-auto-alt-ref", "0",
    "-b:v", "0", "-crf", "24", "-deadline", "good", "-cpu-used", "4", "-row-mt", "1", "-g", "50",
)

RECIPE: dict[str, Any] = {
    "ssml": {"lead_ms": LEAD_MS, "gap_ms": GAP_MS, "tail_ms": TAIL_MS},
    "idle_window": [IDLE_START_SEC, IDLE_GUARD_SEC],
    "motion": [MOTION_VF, MOTION_ALIVE, MOTION_FROZEN],
    "loop": [SIGNATURE_VF, LOOP_MIN_SEC, LOOP_MAX_SEC, SEAM_CROSSFADE_SEC, SEAM_MAX_RATIO,
             SEAM_MSE_FLOOR, PINGPONG_SEC, MIN_PINGPONG_SEC],
    "phrases": [SILENCE_NOISE_DB, SILENCE_MIN_SEC, ISLAND_MIN_SEC, ISLAND_MERGE_SEC,
                PHRASE_SECTION_LEAD_SEC, ONSET_FLOOR_DBFS, ONSET_OVER_NOISE_DB, CLIP_MARGIN_SEC,
                EDGE_FADE_SEC],
    "encode": [CHROMA_VF, *VP9_ARGS, AUDIO_RATE],
}

_LANG_RE = re.compile(r"^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$")
_KEY_RE = re.compile(r"^[0-9a-f]{24}$")
_FILE_RE = re.compile(r"^[0-9a-f]{20}\.(?:webm|wav|npz)$")


class ListenerKitError(RuntimeError):
    """Kit build failure. Messages are built here and never contain secrets."""


# ---------------------------------------------------------------------------
# SSML + cache key
# ---------------------------------------------------------------------------


def kit_phrases(language: str) -> tuple[tuple[str, tuple[str, ...]], ...]:
    """Unique reaction phrases of ``language`` with the reaction ids sharing each text.

    Ordered by first occurrence in ``REACTION_IDS``; identical texts (e.g. a
    locale using one word for two ids) are spoken once and share one clip.
    """
    order: list[str] = []
    ids: dict[str, list[str]] = {}
    for rid in REACTION_IDS:
        text = (reaction_text(language, rid) or "").strip()
        if not text:
            continue
        if text not in ids:
            order.append(text)
            ids[text] = []
        ids[text].append(rid)
    return tuple((text, tuple(ids[text])) for text in order)


def _attr(value: str) -> str:
    return _xml_escape(value or "", {'"': "&quot;", "'": "&apos;"})


def build_kit_ssml(voice: str, language: str, phrases: Sequence[str]) -> str:
    """Kit SSML: lead + idle breaks, then the phrases separated by breaks.

    Same structure and escaping as ``avatar.build_ssml``: attribute-escaped
    voice name, ``xml:lang`` validated (fallback en-US), XML-escaped text.
    """
    texts = [str(p).strip() for p in phrases if str(p).strip()]
    if not texts:
        raise ListenerKitError("a kit job needs at least one phrase")
    lang = _attr(language if _LANG_RE.fullmatch(language or "") else "en-US")
    parts = [f'<break time="{LEAD_MS}ms"/>', f'<break time="{IDLE_MS}ms"/>']
    for k, text in enumerate(texts):
        if k:
            parts.append(f'<break time="{GAP_MS}ms"/>')
        parts.append(_xml_escape(text))
    parts.append(f'<break time="{TAIL_MS}ms"/>')
    return (
        f'<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" '
        f'xmlns:mstts="http://www.w3.org/2001/mstts" xml:lang="{lang}">'
        f'<voice name="{_attr(voice)}">{"".join(parts)}</voice></speak>'
    )


def kit_key(entry: "AvatarEntry", voice: str, language: str,
            phrases: Sequence[tuple[str, Sequence[str]]]) -> str:
    """Cache key: first 24 hex chars of sha256(canonical JSON of the kit inputs)."""
    payload = {
        "kit_version": KIT_VERSION,
        "avatar": {
            "foundry_name": entry.foundry_name,
            "default_style": entry.default_style,
            "photo_base_model": entry.photo_base_model,
            "video_format": entry.video_format,
            "video_codec": entry.video_codec,
            "background_color": entry.background_color,
        },
        "voice": voice,
        "language": language,
        "phrases": [[text, list(ids)] for text, ids in phrases],
        "idle_ms": IDLE_MS,
        "recipe": RECIPE,
    }
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:24]


# ---------------------------------------------------------------------------
# ffmpeg helpers
# ---------------------------------------------------------------------------


def _run(cmd: list[str], *, timeout: float = FFMPEG_TIMEOUT_SEC) -> subprocess.CompletedProcess:
    tool = Path(cmd[0]).name
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise ListenerKitError(f"{tool} timed out") from None
    except OSError:
        raise ListenerKitError(f"{tool} unavailable") from None
    if proc.returncode != 0:
        lines = proc.stderr.decode("utf-8", "replace").strip().splitlines()[-3:]
        raise ListenerKitError(f"{tool} failed ({proc.returncode}): {' | '.join(lines)[:300]}")
    return proc


def _ffmpeg(*args: str) -> list[str]:
    return [FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-y", *args]


@lru_cache(maxsize=1)
def _ffmpeg_missing() -> str:
    """Name of a missing tool/encoder/filter the kit needs ("" = all present)."""
    for tool in (FFMPEG, FFPROBE):
        if shutil.which(tool) is None:
            return tool
    try:
        encoders = _run([FFMPEG, "-hide_banner", "-encoders"], timeout=60).stdout.decode("utf-8", "replace")
        filters = _run([FFMPEG, "-hide_banner", "-filters"], timeout=60).stdout.decode("utf-8", "replace")
    except ListenerKitError:
        return FFMPEG
    for name in ("libvpx-vp9", "pcm_s16le"):
        if not re.search(rf"\s{re.escape(name)}\s", encoders):
            return name
    for name in ("chromakey", "despill", "silencedetect", "apad", "afade", "atrim", "trim"):
        if not re.search(rf"\s{re.escape(name)}\s", filters):
            return name
    return ""


def _require_ffmpeg() -> None:
    missing = _ffmpeg_missing()
    if missing:
        raise ListenerKitError(f"ffmpeg capability missing: {missing}")


@dataclass(frozen=True)
class _Probe:
    width: int
    height: int
    fps: float
    duration: float
    frames: int
    has_audio: bool
    color_args: tuple[str, ...] = ()


def _probe(path: Path) -> _Probe:
    out = _run([FFPROBE, "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)]).stdout
    data = json.loads(out.decode("utf-8", "replace") or "{}")
    streams = data.get("streams") or []
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    if video is None:
        raise ListenerKitError("footage has no video stream")
    width, height = int(video.get("width") or 0), int(video.get("height") or 0)
    if width < 16 or height < 16:
        raise ListenerKitError("footage has no usable frame size")
    fps = 0.0
    for rate in (video.get("r_frame_rate"), video.get("avg_frame_rate")):
        try:
            num, _, den = str(rate or "").partition("/")
            fps = float(num) / float(den or 1)
        except (TypeError, ValueError, ZeroDivisionError):
            fps = 0.0
        if math.isfinite(fps) and 1.0 <= fps <= 120.0:
            break
        fps = 0.0
    fps = fps or float(FPS)
    duration = 0.0
    for value in ((data.get("format") or {}).get("duration"), video.get("duration")):
        try:
            duration = float(value)
        except (TypeError, ValueError):
            continue
        if math.isfinite(duration) and duration > 0:
            break
        duration = 0.0
    try:
        frames = int(video.get("nb_frames") or 0)
    except (TypeError, ValueError):
        frames = 0
    frames = frames or int(round(duration * fps))
    color: list[str] = []
    for key, opt in (("color_range", "-color_range"), ("color_space", "-colorspace"),
                     ("color_transfer", "-color_trc"), ("color_primaries", "-color_primaries")):
        value = str(video.get(key) or "").strip()
        if value and value not in ("unknown", "reserved", "unspecified") and re.fullmatch(r"[a-z0-9_-]+", value):
            color += [opt, value]
    return _Probe(width, height, fps, duration, frames,
                  any(s.get("codec_type") == "audio" for s in streams), tuple(color))


def _fps_arg(fps: float) -> str:
    return str(int(round(fps))) if abs(fps - round(fps)) < 1e-6 else f"{fps:.6f}"


def _gray(raw: bytes, size: int) -> np.ndarray:
    n = size * size
    if not raw or len(raw) % n:
        raise ListenerKitError("gray decode returned no frames")
    return np.frombuffer(raw, np.uint8).reshape(-1, size, size)


def signature_frames(video_path: Path, *, decoder_args: list[str] | None = None) -> np.ndarray:
    """Pose signatures (``SIGNATURE_VF``) of every frame: uint8 [N, 64, 64].

    Apply to ORIGINAL (unkeyed) footage. ``decoder_args`` are input options
    placed before ``-i`` (e.g. rawvideo demuxer options or ``-c:v libvpx-vp9``).
    """
    cmd = _ffmpeg(*(decoder_args or []), "-i", str(video_path), "-map", "0:v:0", "-an", "-sn",
                  "-vf", SIGNATURE_VF, "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "gray", "-")
    return _gray(_run(cmd).stdout, SIGNATURE_SIZE).copy()


def load_signature(path: Path) -> tuple[np.ndarray, float]:
    """``(frames uint8 [N, 64, 64], fps)`` of an ``IdleLoop.signature_path``; raises when invalid."""
    with np.load(Path(path), allow_pickle=False) as data:
        frames = np.asarray(data["frames"])
        fps = float(np.asarray(data["fps"]).reshape(-1)[0])
    if (frames.dtype != np.uint8 or frames.ndim != 3 or frames.shape[0] < 1
            or frames.shape[1:] != (SIGNATURE_SIZE, SIGNATURE_SIZE) or not (math.isfinite(fps) and fps > 0)):
        raise ValueError("invalid listener signature file")
    return frames, fps


def _decode_window_gray(path: Path, start: int, end: int, work_dir: Path) -> tuple[np.ndarray, np.ndarray]:
    """``MOTION_VF`` and ``SIGNATURE_VF`` of the ORIGINAL frames [start, end), one decode.

    ``trim``/``split`` only select and duplicate frames; returns (motion uint8
    [F, 128, 128], signatures uint8 [F, 64, 64]).
    """
    motion_raw, sig_raw = work_dir / "motion.gray", work_dir / "signature.gray"
    graph = (f"[0:v]trim=start_frame={start}:end_frame={end},split=2[m][s];"
             f"[m]{MOTION_VF}[mo];[s]{SIGNATURE_VF}[so]")
    try:
        _run(_ffmpeg("-i", str(path), "-filter_complex", graph,
                     "-map", "[mo]", "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "gray", str(motion_raw),
                     "-map", "[so]", "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "gray", str(sig_raw)))
        motion = _gray(motion_raw.read_bytes(), MOTION_SIZE)
        sig = _gray(sig_raw.read_bytes(), SIGNATURE_SIZE)
    finally:
        motion_raw.unlink(missing_ok=True)
        sig_raw.unlink(missing_ok=True)
    if motion.shape[0] != sig.shape[0]:
        raise ListenerKitError("idle window decode returned mismatched frame counts")
    return motion, sig


def _yuv420_frame_bytes(width: int, height: int) -> int:
    return width * height + 2 * ((width + 1) // 2) * ((height + 1) // 2)


def _decode_window_yuv(path: Path, start: int, end: int, probe: _Probe) -> np.ndarray:
    """Raw yuv420p source frames [start, end): uint8 [F, frame_bytes]."""
    cmd = _ffmpeg("-i", str(path), "-map", "0:v:0", "-an", "-sn",
                  "-vf", f"trim=start_frame={start}:end_frame={end}",
                  "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "yuv420p", "-")
    raw = _run(cmd).stdout
    frame_bytes = _yuv420_frame_bytes(probe.width, probe.height)
    if not raw or len(raw) % frame_bytes or len(raw) // frame_bytes != end - start:
        raise ListenerKitError("source frame decode returned an unexpected frame count")
    return np.frombuffer(raw, np.uint8).reshape(-1, frame_bytes)


_KEYED_VF = f"{CHROMA_VF},format=yuva420p"


def _encode_loop(raw_args: Sequence[str], raw: Path, webm: Path, probe: _Probe) -> np.ndarray:
    """Key the raw loop frames once (chromakey first, then despill) into VP9 + alpha WebM.

    The same decode feeds ``SIGNATURE_VF`` on the unkeyed frames (``split``
    only duplicates frames): returns the loop's signatures in loop order.
    """
    sig_raw = raw.with_name("loop_signature.gray")
    graph = f"[0:v]split=2[k][s];[k]{_KEYED_VF}[kv];[s]{SIGNATURE_VF}[sv]"
    try:
        _run(_ffmpeg(*raw_args, "-i", str(raw), "-filter_complex", graph,
                     "-map", "[kv]", "-fps_mode", "passthrough", *VP9_ARGS, *probe.color_args, "-f", "webm", str(webm),
                     "-map", "[sv]", "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "gray", str(sig_raw)))
        return _gray(sig_raw.read_bytes(), SIGNATURE_SIZE).copy()
    finally:
        sig_raw.unlink(missing_ok=True)


def _webm_alpha_frames(path: Path) -> int:
    """Packet count of a VP9 WebM that carries alpha (``alpha_mode=1``), else 0."""
    out = _run([FFPROBE, "-v", "error", "-select_streams", "v:0", "-count_packets",
                "-show_entries", "stream=codec_name,nb_read_packets:stream_tags", "-of", "json",
                str(path)]).stdout
    streams = json.loads(out.decode("utf-8", "replace") or "{}").get("streams") or [{}]
    stream = streams[0]
    tags = {str(k).lower(): str(v).strip() for k, v in (stream.get("tags") or {}).items()}
    if stream.get("codec_name") != "vp9" or tags.get("alpha_mode") != "1":
        return 0
    try:
        return int(stream.get("nb_read_packets") or 0)
    except (TypeError, ValueError):
        return 0


# ---------------------------------------------------------------------------
# Phrase segmentation
# ---------------------------------------------------------------------------


_SILENCE_START_RE = re.compile(r"silence_start:\s*(-?[\d.]+)")
_SILENCE_END_RE = re.compile(r"silence_end:\s*(-?[\d.]+)")


def _analyse_audio(path: Path, rate: int = ANALYSIS_RATE) -> tuple[list[tuple[float, float]], np.ndarray]:
    """One decode: ``silencedetect`` on the source audio (stderr) + mono PCM at ``rate`` (stdout).

    Silences end at ``inf`` when the stream ends silent.
    """
    proc = _run([FFMPEG, "-hide_banner", "-nostdin", "-nostats", "-i", str(path), "-map", "0:a:0", "-vn", "-sn",
                 "-af", f"silencedetect=noise={SILENCE_NOISE_DB}dB:d={SILENCE_MIN_SEC}",
                 "-ac", "1", "-ar", str(rate), "-f", "s16le", "-"])
    silences: list[tuple[float, float]] = []
    start: Optional[float] = None
    for line in proc.stderr.decode("utf-8", "replace").splitlines():
        m = _SILENCE_START_RE.search(line)
        if m:
            start = max(0.0, float(m.group(1)))
            continue
        m = _SILENCE_END_RE.search(line)
        if m and start is not None:
            silences.append((start, float(m.group(1))))
            start = None
    if start is not None:
        silences.append((start, math.inf))
    return silences, np.frombuffer(proc.stdout, np.int16).astype(np.float32) / 32768.0


def _islands(silences: Sequence[tuple[float, float]], total: float) -> list[tuple[float, float]]:
    """Non-silent islands: complement of ``silences``; < 50 ms dropped, gaps < 0.7 s merged."""
    segs: list[tuple[float, float]] = []
    cur = 0.0
    for s, e in sorted(silences):
        if s > cur + 1e-3:
            segs.append((cur, min(s, total)))
        cur = max(cur, min(e, total))
    if cur < total - 1e-3:
        segs.append((cur, total))
    merged: list[tuple[float, float]] = []
    for s, e in segs:
        if e - s < ISLAND_MIN_SEC:
            continue
        if merged and s - merged[-1][1] < ISLAND_MERGE_SEC:
            merged[-1] = (merged[-1][0], e)
        else:
            merged.append((s, e))
    return merged


def _refine_islands(x: np.ndarray, rate: int, islands: Sequence[tuple[float, float]],
                    total: float) -> list[tuple[float, float]]:
    """Onset/offset of each island on a 5 ms RMS envelope at max(-50 dBFS, noise + 12 dB)."""
    if not islands:
        return []
    hop = max(1, int(round(rate * ENVELOPE_SEC)))
    n = len(x) // hop
    if n == 0:
        return list(islands)
    env = 20.0 * np.log10(np.sqrt(np.mean(x[: n * hop].reshape(n, hop) ** 2, axis=1)) + 1e-9)
    quiet_end = int(max(0.0, islands[0][0] - 0.2) / ENVELOPE_SEC)
    quiet = env[: min(quiet_end, n)]
    noise = float(np.percentile(quiet, 95)) if quiet.size >= 20 else -90.0
    thr = max(ONSET_FLOOR_DBFS, noise + ONSET_OVER_NOISE_DB)
    out: list[tuple[float, float]] = []
    for k, (s, e) in enumerate(islands):
        lo = max(s - REFINE_SEARCH_SEC, out[-1][1] + 0.05 if out else 0.0)
        hi = min(e + REFINE_SEARCH_SEC, islands[k + 1][0] - 0.05 if k + 1 < len(islands) else total)
        a, b = max(0, int(lo / ENVELOPE_SEC)), min(n, int(math.ceil(hi / ENVELOPE_SEC)))
        above = np.flatnonzero(env[a:b] >= thr) if b > a else np.array([], dtype=np.int64)
        if above.size:
            on, off = (a + int(above[0])) * ENVELOPE_SEC, (a + int(above[-1]) + 1) * ENVELOPE_SEC
        else:
            on, off = s, min(e, total)
        out.append((round(on, 4), round(min(off, total), 4)))
    return out


def _clip_frames(onset: float, offset: float, fps: float, frames: int) -> tuple[int, int]:
    """[onset - margin, offset + margin] snapped outward to the frame grid, clamped to the footage."""
    k0 = max(0, int(math.floor((onset - CLIP_MARGIN_SEC) * fps + 1e-6)))
    k1 = min(frames, int(math.ceil((offset + CLIP_MARGIN_SEC) * fps - 1e-6)))
    return k0, k1


# ---------------------------------------------------------------------------
# Idle loop
# ---------------------------------------------------------------------------


def crossfade_frames(fps: float = FPS) -> int:
    return max(1, int(round(SEAM_CROSSFADE_SEC * fps)))


@dataclass(frozen=True)
class LoopChoice:
    """Loop source span within the analysed idle window (frame indices).

    ``forward``: frames [start, end) where ``end`` is the frame matching
    ``start``; the loop has ``(end - start) - crossfade`` frames. ``pingpong``:
    frames [start, end) played forward then backward (``2 * span - 2`` frames).
    """
    kind: str
    start: int
    end: int
    seam_mse: float
    consecutive_p90: float
    frames: int


def find_loop(sig: np.ndarray, fps: float = FPS) -> Optional[LoopChoice]:
    """Best forward loop (pair 5–8 s apart minimizing signature MSE), else a ping-pong.

    The forward pair is accepted when its MSE is ≤ ``SEAM_MAX_RATIO`` × the
    p90 of the consecutive-frame MSE (the 0.28 s cross-fade hides a seam up to
    a few natural frame steps). ``None`` when the window is too short.
    """
    n = int(sig.shape[0]) if sig is not None and np.ndim(sig) == 3 else 0
    if n < 2:
        return None
    v = sig.reshape(n, -1).astype(np.float64)
    sq = np.einsum("ij,ij->i", v, v)
    mse = (sq[:, None] + sq[None, :] - 2.0 * (v @ v.T)) / v.shape[1]
    np.maximum(mse, 0.0, out=mse)
    consecutive = np.diagonal(mse, offset=1)
    p90 = float(np.percentile(consecutive, 90)) if consecutive.size else 0.0
    xfade = crossfade_frames(fps)
    lo, hi = int(round(LOOP_MIN_SEC * fps)), int(round(LOOP_MAX_SEC * fps))
    if n > lo:
        ii, jj = np.triu_indices(n, k=lo)
        keep = (jj - ii) <= hi
        ii, jj = ii[keep], jj[keep]
        best = int(np.argmin(mse[ii, jj]))
        i, j = int(ii[best]), int(jj[best])
        seam = float(mse[i, j])
        if seam <= SEAM_MAX_RATIO * max(p90, SEAM_MSE_FLOOR):
            return LoopChoice("forward", i, j, round(seam, 4), round(p90, 4), (j - i) - xfade)
    span = min(n, int(round(PINGPONG_SEC * fps)))
    if span < int(round(MIN_PINGPONG_SEC * fps)):
        return None
    start = (n - span) // 2
    return LoopChoice("pingpong", start, start + span, 0.0, round(p90, 4), 2 * span - 2)


def _write_loop_raw(frames: np.ndarray, choice: LoopChoice, xfade: int, out: Path) -> int:
    """Write the loop's raw yuv420p frames (``frames`` = source frames [start, end)).

    Forward: the tail (last ``xfade`` frames) is blended into the head (first
    ``xfade`` frames) with weights (k + 1) / (xfade + 1), followed by the body;
    the last body frame is the natural predecessor of the first blended frame.
    """
    count = int(frames.shape[0])
    with open(out, "wb") as fh:
        if choice.kind == "forward":
            if count <= 2 * xfade:
                raise ListenerKitError("loop span too short for the seam cross-fade")
            for k in range(xfade):
                w = (k + 1) / (xfade + 1)
                mixed = (frames[count - xfade + k].astype(np.float32) * (1.0 - w)
                         + frames[k].astype(np.float32) * w)
                np.clip(np.rint(mixed), 0, 255).astype(np.uint8).tofile(fh)
            frames[xfade:count - xfade].tofile(fh)
            return count - xfade
        order = list(range(count)) + list(range(count - 2, 0, -1))
        for idx in order:
            frames[idx].tofile(fh)
        return len(order)


def _motion_class(score: float) -> str:
    if score >= MOTION_ALIVE:
        return "alive"
    if score < MOTION_FROZEN:
        return "frozen"
    return "weak"


# ---------------------------------------------------------------------------
# Kit build from the downloaded footage
# ---------------------------------------------------------------------------


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _seal(tmp: Path, ext: str, files: dict[str, dict]) -> str:
    """Rename a finished file to its content-addressed name and register it."""
    if not tmp.is_file() or tmp.stat().st_size == 0:
        raise ListenerKitError("kit output missing or empty")
    digest = _sha256_file(tmp)
    name = f"{digest[:20]}{ext}"
    target = tmp.with_name(name)
    if target.exists():
        tmp.unlink()
    else:
        tmp.replace(target)
    files[name] = {"bytes": target.stat().st_size, "sha256": digest}
    return name


def _build_idle(footage: Path, probe: _Probe, start: int, end: int, out_dir: Path,
                files: dict[str, dict]) -> dict:
    """Idle stats + (unless frozen/short) the keyed loop and its signatures."""
    fps = probe.fps
    idle: dict[str, Any] = {"window_sec": [round(start / fps, 3), round(end / fps, 3)],
                            "motion_score": 0.0, "motion_class": "unknown", "static": False}
    if end - start < 2:
        return {**idle, "status": "short"}
    gray, window_sig = _decode_window_gray(footage, start, end, out_dir)
    gray = gray.astype(np.int16)
    score = float(np.abs(np.diff(gray, axis=0)).mean()) if gray.shape[0] >= 2 else 0.0
    del gray
    cls = _motion_class(score)
    idle.update(motion_score=round(score, 4), motion_class=cls, static=cls == "frozen")
    if cls == "frozen":
        return {**idle, "status": "static"}
    choice = find_loop(window_sig, fps)
    if choice is None:
        return {**idle, "status": "short"}
    xfade = crossfade_frames(fps)
    frames = _decode_window_yuv(footage, start + choice.start, start + choice.end, probe)
    raw = out_dir / "loop.yuv"
    webm = out_dir / "loop.webm"
    try:
        count = _write_loop_raw(frames, choice, xfade, raw)
        del frames
        raw_args = ["-f", "rawvideo", "-pix_fmt", "yuv420p",
                    "-video_size", f"{probe.width}x{probe.height}", "-framerate", _fps_arg(fps)]
        sig = _encode_loop(raw_args, raw, webm, probe)
    finally:
        raw.unlink(missing_ok=True)
    if sig.shape[0] != count or _webm_alpha_frames(webm) != count:
        raise ListenerKitError("idle loop frame count or alpha check failed")
    npz = out_dir / "loop_sig.npz"
    with open(npz, "wb") as fh:
        np.savez_compressed(fh, frames=sig, fps=np.float64(fps))
    loop_info = {
        "kind": choice.kind,
        "source_sec": [round((start + choice.start) / fps, 3), round((start + choice.end) / fps, 3)],
        "seam_mse": choice.seam_mse,
        "consecutive_p90": choice.consecutive_p90,
        "crossfade_frames": xfade if choice.kind == "forward" else 0,
        "first_last_mse": round(float(np.mean((sig[0].astype(np.float64) - sig[-1]) ** 2)), 4),
    }
    return {**idle, "status": "ok", "frames": count, "duration_sec": round(count / fps, 4),
            "file": _seal(webm, ".webm", files), "signature_file": _seal(npz, ".npz", files),
            "has_alpha": True, "loop": loop_info}


def _wav_frames(path: Path) -> int:
    with wave.open(str(path), "rb") as wav:
        if wav.getnchannels() != 1 or wav.getframerate() != AUDIO_RATE or wav.getsampwidth() != 2:
            raise ListenerKitError("reaction audio has an unexpected format")
        return wav.getnframes()


def _cut_reaction(footage: Path, probe: _Probe, k0: int, k1: int, out_dir: Path, idx: int,
                  files: dict[str, dict], *, verify_alpha: bool) -> tuple[str, str, float]:
    """Keyed VP9+alpha clip and 48 kHz mono WAV of the same frame-aligned window (one decode).

    The video chain only selects frames (``trim``/``setpts``) before ``chromakey``.
    """
    fps = probe.fps
    start, end, dur = k0 / fps, k1 / fps, (k1 - k0) / fps
    fade = min(EDGE_FADE_SEC, dur / 4.0)
    graph = (f"[0:v]trim=start_frame={k0}:end_frame={k1},setpts=PTS-STARTPTS,{_KEYED_VF}[v];"
             f"[0:a]atrim=start={start:.6f}:end={end:.6f},asetpts=PTS-STARTPTS,aresample={AUDIO_RATE},"
             f"apad=whole_dur={dur:.6f},atrim=duration={dur:.6f},"
             f"afade=t=in:st=0:d={fade:.4f},afade=t=out:st={max(0.0, dur - fade):.6f}:d={fade:.4f}[a]")
    webm, wav = out_dir / f"reaction_{idx}.webm", out_dir / f"reaction_{idx}.wav"
    _run(_ffmpeg("-i", str(footage), "-filter_complex", graph,
                 "-map", "[v]", "-fps_mode", "passthrough", *VP9_ARGS, *probe.color_args, "-f", "webm", str(webm),
                 "-map", "[a]", "-ac", "1", "-ar", str(AUDIO_RATE), "-c:a", "pcm_s16le", "-f", "wav", str(wav)))
    if verify_alpha and _webm_alpha_frames(webm) != k1 - k0:
        raise ListenerKitError("reaction clip frame count or alpha check failed")
    if abs(_wav_frames(wav) - round(dur * AUDIO_RATE)) > 2:
        raise ListenerKitError("reaction audio length mismatch")
    return _seal(webm, ".webm", files), _seal(wav, ".wav", files), dur


def process_footage(footage: Path, phrases: Sequence[tuple[str, Sequence[str]]], out_dir: Path) -> dict:
    """Build the kit files from downloaded kit footage into ``out_dir``.

    ``phrases`` = ``kit_phrases(language)``: the spoken order and the ids per
    text. Returns the manifest body (``fps``, ``idle``, ``reactions``,
    ``phrases``, ``files``) without identity fields; ``kit.json`` is not
    written. Layout anomalies (frozen idle, short window, phrase count
    mismatch) are recorded in the manifest; tool failures raise.
    """
    if not phrases:
        raise ListenerKitError("a kit needs at least one phrase")
    probe = _probe(footage)
    fps = probe.fps
    expected_onset = (LEAD_MS + IDLE_MS) / 1000.0
    islands: list[tuple[float, float]] = []
    if probe.has_audio:
        silences, pcm = _analyse_audio(footage)
        islands = _refine_islands(pcm, ANALYSIS_RATE, _islands(silences, probe.duration), probe.duration)
        del pcm
    first_onset = islands[0][0] if islands else min(expected_onset, probe.duration)
    phrase_islands = [isl for isl in islands if isl[0] >= expected_onset - PHRASE_SECTION_LEAD_SEC]

    files: dict[str, dict] = {}
    start = int(math.ceil(IDLE_START_SEC * fps - 1e-9))
    end = min(probe.frames, int(math.ceil((first_onset - IDLE_GUARD_SEC) * fps - 1e-9)))
    idle = _build_idle(footage, probe, start, max(start, end), out_dir, files)

    reactions: dict[str, dict] = {}
    status = "skipped"
    if len(phrase_islands) == len(phrases):
        for idx, ((text, ids), (onset, offset)) in enumerate(zip(phrases, phrase_islands)):
            k0, k1 = _clip_frames(onset, offset, fps, probe.frames)
            if k1 - k0 < 2:
                raise ListenerKitError("degenerate reaction window")
            video, audio, dur = _cut_reaction(footage, probe, k0, k1, out_dir, idx, files,
                                              verify_alpha=idx == 0)
            for rid in ids:
                reactions[rid] = {"text": text, "duration_sec": round(dur, 4),
                                  "speech_sec": round(offset - onset, 4), "onset_sec": round(onset, 4),
                                  "video_file": video, "audio_file": audio, "has_alpha": True}
        status = "ok"
    return {
        "fps": fps,
        "frame_size": [probe.width, probe.height],
        "footage_sec": round(probe.duration, 3),
        "idle": idle,
        "reactions": reactions,
        "phrases": {"expected": len(phrases), "detected": len(phrase_islands), "status": status,
                    "first_onset_sec": round(first_onset, 4)},
        "files": files,
    }


# ---------------------------------------------------------------------------
# L1 cache (local directory per key; kit.json written last)
# ---------------------------------------------------------------------------


def _write_manifest(kit_dir: Path, manifest: dict) -> None:
    tmp = kit_dir / f"{MANIFEST_NAME}.tmp"
    tmp.write_text(json.dumps(manifest, indent=1, sort_keys=True, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, kit_dir / MANIFEST_NAME)


def _finite_positive(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value > 0


def _parse_manifest(raw: bytes | str, key: str) -> Optional[dict]:
    """Schema check of a kit.json (no file access); None when unusable."""
    try:
        m = json.loads(raw)
    except (TypeError, ValueError):
        return None
    if not isinstance(m, dict) or m.get("version") != KIT_VERSION or m.get("key") != key:
        return None
    files = m.get("files")
    if not isinstance(files, dict) or not files:
        return None
    for name, meta in files.items():
        if (not _FILE_RE.fullmatch(str(name)) or not isinstance(meta, dict)
                or not isinstance(meta.get("bytes"), int) or meta["bytes"] <= 0
                or not re.fullmatch(r"[0-9a-f]{64}", str(meta.get("sha256") or ""))
                or not str(meta["sha256"]).startswith(str(name)[:20])):
            return None
    if not _finite_positive(m.get("fps")):
        return None
    idle = m.get("idle")
    if not isinstance(idle, dict):
        return None
    if idle.get("status") == "ok" and (idle.get("file") not in files or idle.get("signature_file") not in files
                                       or not _finite_positive(idle.get("duration_sec"))):
        return None
    reactions = m.get("reactions")
    if not isinstance(reactions, dict):
        return None
    for rid, r in reactions.items():
        if (rid not in REACTION_IDS or not isinstance(r, dict) or r.get("video_file") not in files
                or r.get("audio_file") not in files or not _finite_positive(r.get("duration_sec"))
                or not isinstance(r.get("text"), str)):
            return None
    return m


def _read_manifest(kit_dir: Path, key: str) -> Optional[dict]:
    """Validated manifest of a complete L1 entry (sizes + sha256 of every file), else None."""
    try:
        m = _parse_manifest((kit_dir / MANIFEST_NAME).read_bytes(), key)
    except OSError:
        return None
    if m is None:
        return None
    for name, meta in m["files"].items():
        path = kit_dir / name
        try:
            if path.stat().st_size != meta["bytes"] or _sha256_file(path) != meta["sha256"]:
                return None
        except OSError:
            return None
    return m


def _install(staging: Path, final: Path, key: str) -> dict:
    """Move a complete staging dir (kit.json last) to ``final``; a valid concurrent entry wins."""
    for _attempt in range(2):
        existing = _read_manifest(final, key)
        if existing is not None:
            return existing
        if final.exists():
            shutil.rmtree(final, ignore_errors=True)
        try:
            os.replace(staging, final)
        except OSError:
            continue
        installed = _read_manifest(final, key)
        if installed is None:
            raise ListenerKitError("installed listener kit failed validation")
        return installed
    raise ListenerKitError("could not install the listener kit")


def _footage_path(key: str) -> Path:
    return L1_ROOT / FOOTAGE_DIR_NAME / f"{key}.mp4"


_LOCKS: dict[str, threading.Lock] = {}
_LOCKS_GUARD = threading.Lock()


def _key_lock(key: str) -> threading.Lock:
    with _LOCKS_GUARD:
        return _LOCKS.setdefault(key, threading.Lock())


def _check_deadline(deadline: Optional[float]) -> None:
    if deadline is not None and time.monotonic() >= deadline:
        raise TimeoutError("listener kit deadline reached")


# ---------------------------------------------------------------------------
# L2 cache (private blob prefix podcast-cache/listener-kit/{key}/)
# ---------------------------------------------------------------------------

_L2_CLIENTS: dict[tuple, Any] = {}
_L2_GUARD = threading.Lock()
_CONTENT_TYPES = {".webm": "video/webm", ".wav": "audio/wav", ".npz": "application/octet-stream",
                  ".json": "application/json"}


def _l2_container(cfg: "AzureConfig") -> Any:
    """Container client of the private blob cache (library storage config), or None."""
    account = (getattr(cfg, "blob_account_name", "") or "").strip()
    conn = getattr(cfg, "blob_connection_string", "") or ""
    container = (getattr(cfg, "blob_container", "") or "").strip()
    use_mi = bool(getattr(cfg, "use_managed_identity", False)) and bool(account)
    if not container or not (use_mi or conn):
        return None
    cache_key = (use_mi, account, hashlib.sha256(conn.encode("utf-8")).hexdigest(), container)
    with _L2_GUARD:
        if cache_key in _L2_CLIENTS:
            return _L2_CLIENTS[cache_key]
        client = None
        try:
            from azure.storage.blob import BlobServiceClient  # noqa: PLC0415

            if use_mi:
                from azure.identity import DefaultAzureCredential  # noqa: PLC0415

                service = BlobServiceClient(f"https://{account}.blob.core.windows.net",
                                            credential=DefaultAzureCredential())
            else:
                service = BlobServiceClient.from_connection_string(conn)
            client = service.get_container_client(container)
        except Exception as exc:  # noqa: BLE001 — the blob cache is optional
            log.warning("listener kit cache: blob storage unavailable (%s)", type(exc).__name__)
        _L2_CLIENTS[cache_key] = client
        return client


def _blob_name(key: str, name: str) -> str:
    if not _KEY_RE.fullmatch(key) or not (name == MANIFEST_NAME or _FILE_RE.fullmatch(name)):
        raise ListenerKitError("invalid listener kit blob name")
    return f"{L2_PREFIX}/{key}/{name}"


def _is_status(exc: BaseException, status: int, cls_name: str) -> bool:
    return getattr(exc, "status_code", None) == status or type(exc).__name__ == cls_name


def _l2_fetch(container: Any, key: str, final: Path, deadline: Optional[float]) -> tuple[Optional[dict], Optional[str]]:
    """Download a complete L2 entry into L1. Returns (manifest, etag of a corrupt kit.json)."""
    try:
        downloader = container.get_blob_client(_blob_name(key, MANIFEST_NAME)).download_blob()
        raw = downloader.readall()
        etag = getattr(getattr(downloader, "properties", None), "etag", None)
    except Exception as exc:  # noqa: BLE001
        if not _is_status(exc, 404, "ResourceNotFoundError"):
            log.warning("listener kit %s: blob cache read failed (%s)", key[:8], type(exc).__name__)
        return None, None
    manifest = _parse_manifest(raw, key)
    if manifest is None:
        log.warning("listener kit %s: corrupt blob cache entry, rebuilding", key[:8])
        return None, etag
    staging = final.parent / f".fetch-{key[:12]}-{uuid.uuid4().hex[:8]}"
    staging.mkdir(parents=True, exist_ok=True)
    try:
        for name, meta in manifest["files"].items():
            _check_deadline(deadline)
            data = container.get_blob_client(_blob_name(key, name)).download_blob().readall()
            if len(data) != meta["bytes"] or hashlib.sha256(data).hexdigest() != meta["sha256"]:
                log.warning("listener kit %s: blob cache file mismatch, rebuilding", key[:8])
                return None, etag
            (staging / name).write_bytes(data)
        _write_manifest(staging, manifest)
        return _install(staging, final, key), None
    except TimeoutError:
        raise
    except Exception as exc:  # noqa: BLE001
        if _is_status(exc, 404, "ResourceNotFoundError"):
            log.warning("listener kit %s: incomplete blob cache entry, rebuilding", key[:8])
            return None, etag
        log.warning("listener kit %s: blob cache download failed (%s)", key[:8], type(exc).__name__)
        return None, None
    finally:
        shutil.rmtree(staging, ignore_errors=True)


def _upload_if_absent(container: Any, blob: str, data: bytes, content_type: str) -> bool:
    """Create-if-absent upload (``If-None-Match: *``). False when the blob already exists."""
    from azure.storage.blob import ContentSettings  # noqa: PLC0415

    try:
        container.get_blob_client(blob).upload_blob(
            data, overwrite=False, content_settings=ContentSettings(content_type=content_type))
    except Exception as exc:  # noqa: BLE001
        if _is_status(exc, 409, "ResourceExistsError"):
            return False
        raise
    return True


def _l2_store(container: Any, key: str, kit_dir: Path, manifest: dict, corrupt_etag: Optional[str]) -> None:
    """Upload an L1 entry: files first, kit.json last (create-if-absent). Never raises."""
    created: list[str] = []
    try:
        for name in sorted(manifest["files"]):
            if _upload_if_absent(container, _blob_name(key, name), (kit_dir / name).read_bytes(),
                                 _CONTENT_TYPES.get(Path(name).suffix, "application/octet-stream")):
                created.append(name)
        manifest_blob = _blob_name(key, MANIFEST_NAME)
        if corrupt_etag:
            from azure.core import MatchConditions  # noqa: PLC0415

            try:
                container.get_blob_client(manifest_blob).delete_blob(
                    etag=corrupt_etag, match_condition=MatchConditions.IfNotModified)
            except Exception as exc:  # noqa: BLE001
                log.info("listener kit %s: corrupt blob sidecar kept (%s)", key[:8], type(exc).__name__)
        if _upload_if_absent(container, manifest_blob, (kit_dir / MANIFEST_NAME).read_bytes(),
                             _CONTENT_TYPES[".json"]):
            log.info("listener kit %s: stored in the blob cache", key[:8])
            return
        # Another writer's sidecar won: drop the blobs only this upload created and it does not use.
        theirs = _parse_manifest(container.get_blob_client(manifest_blob).download_blob().readall(), key)
        used = set(theirs["files"]) if theirs else set(manifest["files"])
        for name in created:
            if name not in used:
                try:
                    container.get_blob_client(_blob_name(key, name)).delete_blob()
                except Exception:  # noqa: BLE001
                    pass
    except Exception as exc:  # noqa: BLE001 — the blob cache is best effort
        log.warning("listener kit %s: blob cache upload failed (%s)", key[:8], type(exc).__name__)


# ---------------------------------------------------------------------------
# Synthesis + orchestration
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class _KitSpec:
    key: str
    avatar_id: str
    voice: str
    language: str
    phrases: tuple[tuple[str, tuple[str, ...]], ...]
    # Holds the Speech character name: never format, log or persist it.
    entry: "AvatarEntry" = field(repr=False, compare=False)


def _spec_for(entry: "AvatarEntry", voice: str, language: str) -> _KitSpec:
    phrases = kit_phrases(language)
    return _KitSpec(kit_key(entry, voice, language, phrases), entry.id, voice, language, phrases, entry)


def _supported(entry: "AvatarEntry") -> bool:
    """Kits are built for photo avatars only (green mp4 keyed once to VP9 + alpha)."""
    return bool(entry.chroma_key) and entry.video_format == "mp4"


def _batch_runner():
    """The shared batch-avatar helper (lazy: avoids an import cycle and eases faking)."""
    from services.podcast_render import run_batch_avatar_job  # noqa: PLC0415

    return run_batch_avatar_job


def _synthesize(cfg: "AzureConfig", spec: _KitSpec, staging: Path, deadline: Optional[float]) -> Path:
    ssml = build_kit_ssml(spec.voice, spec.language, [text for text, _ids in spec.phrases])
    out = staging / "footage.mp4"
    log.info("listener kit %s avatar=%s: submitting the kit job (%d phrases)",
             spec.key[:8], spec.avatar_id, len(spec.phrases))
    result = _batch_runner()(cfg, ssml, spec.entry, out, label=f"listener-kit-{spec.key[:8]}",
                             deadline=deadline)
    path = Path(getattr(result, "video_path", None) or out)
    if not path.is_file() or path.stat().st_size == 0:
        raise ListenerKitError("the kit job returned no video")
    return path


def _build(cfg: "AzureConfig", spec: _KitSpec, deadline: Optional[float]) -> dict:
    """Synthesize (or reuse retained footage), process, install in L1. Lock held by the caller."""
    started = time.monotonic()
    _require_ffmpeg()
    L1_ROOT.mkdir(parents=True, exist_ok=True)
    footage = _footage_path(spec.key)
    retained = footage.is_file() and footage.stat().st_size > 0
    staging = L1_ROOT / f".staging-{spec.key[:12]}-{uuid.uuid4().hex[:8]}"
    staging.mkdir(parents=True)
    try:
        if retained:
            log.info("listener kit %s avatar=%s: reprocessing retained footage", spec.key[:8], spec.avatar_id)
        else:
            _check_deadline(deadline)
            src = _synthesize(cfg, spec, staging, deadline)
            footage.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(src), str(footage))
        try:
            body = process_footage(footage, spec.phrases, staging)
        except Exception:
            if retained:  # second failure on the same footage: pay for fresh footage next time
                footage.unlink(missing_ok=True)
            raise
        manifest = {
            "kind": "podcast-listener-kit",
            "version": KIT_VERSION,
            "key": spec.key,
            "avatar_id": spec.avatar_id,
            "voice": spec.voice,
            "language": spec.language,
            "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            **body,
        }
        _write_manifest(staging, manifest)
        installed = _install(staging, L1_ROOT / spec.key, spec.key)
        footage.unlink(missing_ok=True)
        idle = installed["idle"]
        log.info("listener kit %s avatar=%s: built in %.1fs (idle=%s motion=%.3f loop=%.2fs, reactions=%s %d/%d)",
                 spec.key[:8], spec.avatar_id, time.monotonic() - started, idle.get("status"),
                 float(idle.get("motion_score") or 0.0), float(idle.get("duration_sec") or 0.0),
                 installed["phrases"]["status"], installed["phrases"]["detected"],
                 installed["phrases"]["expected"])
        return installed
    finally:
        shutil.rmtree(staging, ignore_errors=True)


def _ensure_manifest(cfg: "AzureConfig", spec: _KitSpec, deadline: Optional[float]) -> tuple[Path, dict]:
    """Double-checked L1 → (lock) L1 → L2 → synthesis. Raises on failure / TimeoutError."""
    final = L1_ROOT / spec.key
    manifest = _read_manifest(final, spec.key)
    if manifest is not None:
        return final, manifest
    lock = _key_lock(spec.key)
    timeout = -1.0 if deadline is None else max(0.0, deadline - time.monotonic())
    if not lock.acquire(timeout=timeout):
        raise TimeoutError("listener kit lock wait reached the deadline")
    try:
        manifest = _read_manifest(final, spec.key)
        if manifest is not None:
            return final, manifest
        _check_deadline(deadline)
        if final.exists():
            log.warning("listener kit %s avatar=%s: incomplete or corrupt cache entry, rebuilding",
                        spec.key[:8], spec.avatar_id)
            shutil.rmtree(final, ignore_errors=True)
        corrupt_etag: Optional[str] = None
        container = _l2_container(cfg)
        if container is not None:
            _check_deadline(deadline)
            L1_ROOT.mkdir(parents=True, exist_ok=True)
            manifest, corrupt_etag = _l2_fetch(container, spec.key, final, deadline)
            if manifest is not None:
                log.info("listener kit %s avatar=%s: restored from the blob cache", spec.key[:8], spec.avatar_id)
                return final, manifest
        manifest = _build(cfg, spec, deadline)
        if container is not None:
            _l2_store(container, spec.key, final, manifest, corrupt_etag)
        return final, manifest
    finally:
        lock.release()


def _warnings(*codes: str) -> tuple[str, ...]:
    out: list[str] = []
    for code in codes:
        if code:
            add_warning(out, code)
    return tuple(out)


def _fallback_kit(avatar_id: str, voice: str, setting: str, want_reactions: bool, *,
                  timeout: bool = False) -> ListenerKit:
    """Kit without idle loop or reactions; ``still`` stays still, everything else is procedural."""
    capped = setting in ("still", "procedural")
    return ListenerKit(
        avatar_id=avatar_id,
        voice=voice,
        mode="still" if setting == "still" else "procedural",
        idle=None,
        reactions={},
        warnings=_warnings("" if capped else WARNING_LISTENER_FALLBACK,
                           WARNING_LISTENER_TIMEOUT if timeout else "",
                           WARNING_REACTIONS_SKIPPED if want_reactions else ""),
    )


def _kit_from_manifest(kit_dir: Path, m: dict, *, avatar_id: str, voice: str, setting: str,
                       want_reactions: bool) -> ListenerKit:
    idle = m["idle"]
    codes: list[str] = []
    loop: Optional[IdleLoop] = None
    if setting in ("still", "procedural"):
        mode = setting
    elif idle.get("status") == "ok":
        mode = "idle_loop"
        loop = IdleLoop(
            path=kit_dir / idle["file"],
            duration_sec=float(idle["duration_sec"]),
            has_alpha=True,
            signature_path=kit_dir / idle["signature_file"],
            motion_score=float(idle.get("motion_score") or 0.0),
            static=False,
        )
        if idle.get("motion_class") == "weak":
            codes.append(WARNING_LISTENER_STATIC)
    else:
        mode = "procedural"
        codes.append(WARNING_LISTENER_STATIC if idle.get("status") == "static" else WARNING_LISTENER_FALLBACK)
    reactions: dict[str, ReactionClip] = {}
    if want_reactions:
        for rid in REACTION_IDS:
            r = m["reactions"].get(rid)
            if r:
                reactions[rid] = ReactionClip(
                    reaction_id=rid,  # type: ignore[arg-type]
                    text=r["text"],
                    audio_path=kit_dir / r["audio_file"],
                    video_path=kit_dir / r["video_file"],
                    duration_sec=float(r["duration_sec"]),
                    has_alpha=True,
                )
        if len(reactions) < len(REACTION_IDS):
            codes.append(WARNING_REACTIONS_SKIPPED)
    return ListenerKit(avatar_id=avatar_id, voice=voice, mode=mode, idle=loop,  # type: ignore[arg-type]
                       reactions=reactions, warnings=_warnings(*codes))


def _setting() -> str:
    try:
        return listener_mode()
    except Exception:  # noqa: BLE001
        return "auto"


def _ensure_for_entry(cfg: "AzureConfig", entry: "AvatarEntry", voice: str, language: str, *,
                      want_reactions: bool, deadline: Optional[float], setting: str) -> ListenerKit:
    """Kit for one avatar entry; never raises."""
    key8 = "--------"
    try:
        if not _supported(entry):
            log.info("listener kit avatar=%s: avatar kind not supported, fallback listener", entry.id)
            return _fallback_kit(entry.id, voice, setting, want_reactions)
        spec = _spec_for(entry, voice, language)
        key8 = spec.key[:8]
        kit_dir, manifest = _ensure_manifest(cfg, spec, deadline)
        return _kit_from_manifest(kit_dir, manifest, avatar_id=entry.id, voice=voice, setting=setting,
                                  want_reactions=want_reactions)
    except TimeoutError:
        log.warning("listener kit %s avatar=%s: not ready before the deadline, fallback listener", key8, entry.id)
        return _fallback_kit(entry.id, voice, setting, want_reactions, timeout=True)
    except Exception as exc:  # noqa: BLE001 — a render never fails because of the listener
        log.warning("listener kit %s avatar=%s: failed (%s), fallback listener", key8, entry.id, _safe_reason(exc))
        return _fallback_kit(entry.id, voice, setting, want_reactions)


def _safe_reason(exc: BaseException) -> str:
    """Loggable failure reason: this module's messages and the batch helper's safe ``reason``, else the type."""
    if isinstance(exc, ListenerKitError):
        return str(exc)
    reason = getattr(exc, "reason", None)
    if type(exc).__name__ == "BatchJobError" and isinstance(reason, str):
        return f"BatchJobError: {reason[:200]}"
    return type(exc).__name__


def _default_voice(language: str) -> str:
    from services.avatar import VOICE_MAP  # noqa: PLC0415

    return VOICE_MAP.get(language, VOICE_MAP["en-US"])


def ensure_listener_kit(cfg: "AzureConfig", avatar_id: str, voice: str, language: str, *,
                        want_reactions: bool, deadline: Optional[float] = None) -> ListenerKit:
    """Make sure the kit of one host exists (L1 → L2 → one paid batch job) and return it.

    Always builds, whatever ``PODCAST_LISTENER_MODE`` says (warm-listeners
    CLI); the returned kit is shaped by that mode. ``deadline`` is an absolute
    ``time.monotonic()`` (None = unbounded). Never raises: failures return a
    fallback kit with stable warning codes.
    """
    setting = _setting()
    voice = (voice or "").strip()
    language = (language or "").strip() or "en-US"
    try:
        if not avatar_registry.is_known(avatar_id):
            log.warning("listener kit: unknown avatar id, fallback listener")
            return _fallback_kit(str(avatar_id or ""), voice, setting, want_reactions)
        entry = avatar_registry.get(avatar_id)
        voice = voice or _default_voice(language)
    except Exception as exc:  # noqa: BLE001
        log.warning("listener kit: avatar lookup failed (%s), fallback listener", type(exc).__name__)
        return _fallback_kit(str(avatar_id or ""), voice, setting, want_reactions)
    return _ensure_for_entry(cfg, entry, voice, language, want_reactions=want_reactions,
                             deadline=deadline, setting=setting)


def resolve_listener_kits(cfg: "AzureConfig", roles: "RenderRoles", language: str, *,
                          want_reactions: bool, deadline: float) -> dict[str, ListenerKit]:
    """Listener kits of both hosts, keyed ``"interviewer"`` / ``"expert"``; never raises.

    Honours ``PODCAST_LISTENER_MODE``: ``still`` / ``procedural`` skip
    synthesis unless reactions are wanted (the kit then supplies reactions
    only). Both kits are built in parallel threads; at the deadline the
    caller gets fallback kits (``listener_timeout``) while a running build
    keeps going in the background and fills the cache for the next render.
    """
    setting = _setting()
    language = (language or "").strip() or "en-US"
    hosts: dict[str, tuple[str, str]] = {}
    for role in ROLES:
        rc = getattr(roles, role, None)
        hosts[role] = (str(getattr(rc, "avatar", "") or "").strip(), str(getattr(rc, "voice", "") or "").strip())
    try:
        entries: dict[str, tuple["AvatarEntry", str]] = {}
        for role, (avatar, voice) in hosts.items():
            voice = voice or _default_voice(language)
            entry = avatar_registry.get(avatar) if avatar else avatar_registry.for_voice(voice)
            entries[role] = (entry, voice)
        if setting in ("still", "procedural") and not want_reactions:
            return {role: ListenerKit(avatar_id=entry.id, voice=voice, mode=setting,  # type: ignore[arg-type]
                                      idle=None, reactions={})
                    for role, (entry, voice) in entries.items()}
        pool = ThreadPoolExecutor(max_workers=len(entries), thread_name_prefix="listener-kit")
        try:
            futures = {role: pool.submit(_ensure_for_entry, cfg, entry, voice, language,
                                         want_reactions=want_reactions, deadline=deadline, setting=setting)
                       for role, (entry, voice) in entries.items()}
        finally:
            pool.shutdown(wait=False)
        kits: dict[str, ListenerKit] = {}
        for role, future in futures.items():
            entry, voice = entries[role]
            remaining = None if deadline is None else max(0.0, deadline - time.monotonic())
            try:
                kits[role] = future.result(timeout=remaining)
            except TimeoutError:
                log.warning("listener kit avatar=%s: not ready before the deadline, fallback listener", entry.id)
                kits[role] = _fallback_kit(entry.id, voice, setting, want_reactions, timeout=True)
            except Exception as exc:  # noqa: BLE001
                log.warning("listener kit avatar=%s: failed (%s), fallback listener", entry.id, type(exc).__name__)
                kits[role] = _fallback_kit(entry.id, voice, setting, want_reactions)
        return kits
    except Exception as exc:  # noqa: BLE001 — a render never fails because of the listener
        log.warning("listener kits: resolution failed (%s), fallback listeners", type(exc).__name__)
        return {role: _fallback_kit(avatar, voice, setting, want_reactions) for role, (avatar, voice) in hosts.items()}


__all__ = [
    "KIT_VERSION",
    "L1_ROOT",
    "L2_PREFIX",
    "LoopChoice",
    "ListenerKitError",
    "MOTION_ALIVE",
    "MOTION_FROZEN",
    "MOTION_VF",
    "SIGNATURE_SIZE",
    "SIGNATURE_VF",
    "build_kit_ssml",
    "crossfade_frames",
    "ensure_listener_kit",
    "find_loop",
    "kit_key",
    "kit_phrases",
    "load_signature",
    "process_footage",
    "resolve_listener_kits",
    "signature_frames",
]
