"""Audio-only speech for the podcast: DragonHD TTS REST, zero avatar calls.

* One request per turn to ``https://{region}.tts.speech.microsoft.com/cognitiveservices/v1``
  with ``speech_rest.sts_header`` (Entra -> custom-domain STS, or the resource
  key) and the shared retry policy (at most 3 attempts; a 400 never retries).
* Output ``PODCAST_TTS_OUTPUT_FORMAT``, default ``riff-24khz-16bit-mono-pcm``:
  spike S2 showed DragonHD's native rate is 24 kHz (the 48 kHz format is the
  same spectrum upsampled, at twice the bytes). Every turn starts with ~0.27 s
  of silence (the 250 ms SSML lead break + onset).
* Timeouts: connect 10 s, read ``max(30 s, 3 x expected audio)`` with
  ~14 chars/s for Latin scripts and ~5 chars/s for CJK (S2 speech rates).
* SSML comes from ``avatar.build_ssml``: same voices, same 250 ms lead and the
  same planned ``pause_after_sentence`` breaks as the avatar path. S2: a
  700 ms break yields ~0.96-1.07 s of measured silence at the boundary.
* Voices must be on the ``voice_catalog`` allow-list; turns run with bounded
  parallelism (``PODCAST_TTS_PARALLEL``, default 4; the service queues beyond).
* Backchannel phrases (``podcast_media.reaction_text``) are synthesized once per
  (voice, locale, id, text, format, clip budget, RECIPE_VERSION), trimmed to the
  speech span (RMS gate, isolated end-of-synthesis clicks ignored, ~30 ms
  margins, 5 ms edge fades), re-taken (<= 2 more) when longer than
  ``podcast_media.reaction_clip_budget_sec`` and cached under hash-only names.

No ffmpeg: WAV headers are parsed and written in Python, trimming uses numpy.
Voices, SSML and response bodies are never logged.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import struct
import threading
import uuid
import wave
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable, Optional

import numpy as np
import requests

from config import AzureConfig
from services import podcast_media, speech_rest, voice_catalog
from services.avatar import VOICE_MAP, build_ssml
from services.podcast_media import ReactionClip, TurnAudio
from services.podcast_models import DialogueTurn, RenderRoles, RoleConfig, Script

log = logging.getLogger(__name__)

DEFAULT_TTS_OUTPUT_FORMAT = "riff-24khz-16bit-mono-pcm"
TTS_OUTPUT_FORMATS = frozenset({
    "riff-16khz-16bit-mono-pcm",
    "riff-22050hz-16bit-mono-pcm",
    "riff-24khz-16bit-mono-pcm",
    "riff-44100hz-16bit-mono-pcm",
    "riff-48khz-16bit-mono-pcm",
})
USER_AGENT = "ai-presenter-podcast"
DEFAULT_TTS_PARALLEL = 4
MAX_TTS_PARALLEL = 16
TTS_CONNECT_TIMEOUT_SEC = 10.0
TTS_MIN_READ_TIMEOUT_SEC = 30.0
TTS_MAX_ATTEMPTS = 3
LATIN_CHARS_PER_SEC = 14.0
CJK_CHARS_PER_SEC = 5.0
_CJK_CHAR_RE = re.compile("[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af\uff66-\uff9f]")

# Bump whenever the reaction recipe (SSML, trimming, take selection) changes: it
# is part of the cache key (with the output format and the clip budget), so stale
# clips are never reused. v2: isolated clicks ignored, re-takes over budget.
RECIPE_VERSION = 2
REACTION_MARGIN_SEC = 0.030
REACTION_FADE_SEC = 0.005
REACTION_MAX_TAKES = 3
GATE_BLOCK_SEC = 0.005
GATE_FLOOR_DBFS = -50.0
GATE_RELATIVE_DB = -40.0
MIN_REACTION_SPEECH_SEC = 0.05
# DragonHD sometimes emits a faint (-44...-51 dBFS) click ~0.34 s after a short
# phrase (3.6 % of the reactions-spike takes): sound islands shorter than this,
# at least BLIP_GAP_SEC away from the speech, are not part of the clip.
BLIP_MAX_SEC = 0.060
BLIP_GAP_SEC = 0.150
# Dips this short inside one sound are gate flicker, not silence.
ISLAND_BRIDGE_SEC = 0.020


class TtsError(RuntimeError):
    """TTS produced no usable audio (the message is safe: no voices or payloads)."""


def tts_parallel() -> int:
    """``PODCAST_TTS_PARALLEL``: concurrent TTS requests (default 4, 1-16)."""
    return speech_rest.env_int("PODCAST_TTS_PARALLEL", DEFAULT_TTS_PARALLEL, 1, MAX_TTS_PARALLEL)


def tts_output_format() -> str:
    """``PODCAST_TTS_OUTPUT_FORMAT``: a 16-bit mono RIFF PCM format (default 24 kHz)."""
    value = (os.environ.get("PODCAST_TTS_OUTPUT_FORMAT") or "").strip().lower()
    return value if value in TTS_OUTPUT_FORMATS else DEFAULT_TTS_OUTPUT_FORMAT


def expected_audio_sec(text: str, pause_ms_total: int = 0) -> float:
    """Rough spoken duration of ``text`` (S2 rates: ~14 chars/s Latin, ~5 chars/s CJK)
    plus the planned pauses and ~0.4 s of lead/tail silence."""
    text = text or ""
    cjk = len(_CJK_CHAR_RE.findall(text))
    return 0.4 + (len(text) - cjk) / LATIN_CHARS_PER_SEC + cjk / CJK_CHARS_PER_SEC + max(0, pause_ms_total) / 1000.0


def tts_timeout(expected_sec: float) -> tuple[float, float]:
    """``(connect, read)``: the first byte only arrives after the whole turn is synthesized."""
    return (TTS_CONNECT_TIMEOUT_SEC, max(TTS_MIN_READ_TIMEOUT_SEC, 3.0 * expected_sec))


def tts_url(cfg: AzureConfig) -> str:
    region = re.sub(r"[^a-z0-9]", "", (cfg.speech_region or "").strip().lower()) or "swedencentral"
    return f"https://{region}.tts.speech.microsoft.com/cognitiveservices/v1"


# ---------------------------------------------------------------------------
# WAV helpers
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class WavInfo:
    sample_rate: int
    channels: int
    frames: int

    @property
    def duration_sec(self) -> float:
        return self.frames / self.sample_rate if self.sample_rate else 0.0


def parse_wav(data: bytes) -> tuple[WavInfo, bytes]:
    """Validate a 16-bit PCM RIFF/WAVE payload and return (info, interleaved PCM).

    A data chunk whose declared size is a streaming placeholder or larger than
    the payload is read to the end of the payload.
    """
    if len(data) < 12 or data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise TtsError("not a RIFF/WAVE payload")
    pos = 12
    fmt: Optional[tuple[int, int, int, int, int]] = None
    while pos + 8 <= len(data):
        chunk_id = data[pos:pos + 4]
        size = struct.unpack_from("<I", data, pos + 4)[0]
        start = pos + 8
        if chunk_id == b"fmt ":
            if size < 16 or start + 16 > len(data):
                raise TtsError("truncated WAV fmt chunk")
            tag, channels, rate, _byte_rate, block_align, bits = struct.unpack_from("<HHIIHH", data, start)
            fmt = (tag, channels, rate, block_align, bits)
        elif chunk_id == b"data":
            if fmt is None:
                raise TtsError("WAV data before fmt")
            tag, channels, rate, block_align, bits = fmt
            if tag not in (1, 0xFFFE) or bits != 16 or channels < 1 or rate <= 0 or block_align != 2 * channels:
                raise TtsError("unsupported WAV format (16-bit PCM expected)")
            end = start + size
            if size == 0xFFFFFFFF or end > len(data) or (size == 0 and len(data) > start):
                end = len(data)
            pcm = data[start:end]
            pcm = pcm[: len(pcm) - len(pcm) % block_align]
            return WavInfo(sample_rate=rate, channels=channels, frames=len(pcm) // block_align), pcm
        pos = start + size + (size & 1)
    raise TtsError("WAV without a data chunk")


def read_wav_info(path: Path) -> WavInfo:
    return parse_wav(Path(path).read_bytes())[0]


def _write_wav_atomic(path: Path, pcm: bytes, sample_rate: int, channels: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    part = path.with_name(f"{path.name}.{uuid.uuid4().hex[:8]}.part")
    try:
        with wave.open(str(part), "wb") as w:
            w.setnchannels(channels)
            w.setsampwidth(2)
            w.setframerate(sample_rate)
            w.writeframes(pcm)
        os.replace(part, path)
    finally:
        part.unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# TTS REST
# ---------------------------------------------------------------------------

def _tts(cfg: AzureConfig, ssml: str, *, deadline: Optional[float], expected_sec: float = 0.0,
         output_format: Optional[str] = None) -> tuple[WavInfo, bytes]:
    fmt = output_format or tts_output_format()
    resp = speech_rest.request_with_retry(
        "POST", tts_url(cfg),
        headers_factory=lambda refresh: {
            **speech_rest.sts_header(cfg, force_refresh=refresh),
            "Content-Type": "application/ssml+xml",
            "X-Microsoft-OutputFormat": fmt,
            "User-Agent": USER_AGENT,
        },
        data=ssml.encode("utf-8"), timeout=tts_timeout(expected_sec), max_attempts=TTS_MAX_ATTEMPTS,
        deadline=deadline,
    )
    info, pcm = parse_wav(resp.content)
    if info.frames == 0:
        raise TtsError("empty audio")
    return info, pcm


def synthesize_ssml(cfg: AzureConfig, ssml: str, out_path: Path, *, deadline: Optional[float] = None,
                    expected_sec: float = 0.0) -> float:
    """Synthesize ``ssml`` to a canonical 16-bit PCM WAV at ``out_path``; returns its duration (s).

    ``expected_sec`` (see ``expected_audio_sec``) sizes the read timeout.
    """
    info, pcm = _tts(cfg, ssml, deadline=deadline, expected_sec=expected_sec)
    _write_wav_atomic(Path(out_path), pcm, info.sample_rate, info.channels)
    return info.duration_sec


def _turn_voice(role: RoleConfig, language: str) -> Optional[str]:
    voice = role.voice or VOICE_MAP.get(language, VOICE_MAP["en-US"])
    return voice if voice_catalog.is_allowed_voice(voice) else None


def _safe_reason(exc: BaseException) -> str:
    if isinstance(exc, TtsError):
        return str(exc)
    if isinstance(exc, requests.HTTPError) and exc.response is not None:
        return f"HTTP {exc.response.status_code}"
    return type(exc).__name__


class _Skipped(Exception):
    pass


@dataclass(frozen=True)
class _TurnJob:
    turn: DialogueTurn
    ssml: str
    path: Path
    expected_sec: float


def synthesize_turns(
    cfg: AzureConfig,
    script: Script,
    roles: RenderRoles,
    work_dir: Path,
    *,
    pauses: Optional[dict[int, dict[int, int]]] = None,
    progress_cb: Optional[Callable[[int], None]] = None,
    deadline: Optional[float] = None,
) -> list[TurnAudio]:
    """One TTS request per turn -> ``work_dir/tts_turn_{idx:03d}.wav`` (16-bit mono
    PCM, 24 kHz unless ``PODCAST_TTS_OUTPUT_FORMAT`` says otherwise).

    Returns ``TurnAudio(source="tts")`` sorted by ``turn_idx``; durations are read
    from the WAV data. ``pauses`` = ``{turn_idx: {after_sentence: ms}}``.
    ``progress_cb(turns_done)`` runs after each finished turn. Fails loud: a
    voice outside the allow-list raises ``ValueError`` before any request; the
    first failed turn stops further requests and raises ``RuntimeError``;
    ``TimeoutError`` once ``deadline`` (absolute ``time.monotonic()``) passes.
    Never calls the avatar API.
    """
    work_dir = Path(work_dir)
    language = script.language
    turn_pauses = pauses or {}
    role_for = {"interviewer": roles.interviewer, "expert": roles.expert}
    jobs: list[_TurnJob] = []
    for turn in sorted(script.turns, key=lambda t: t.idx):
        voice = _turn_voice(role_for[turn.speaker], language)
        if voice is None:
            raise ValueError(f"turn {turn.idx}: voice is not on the allow-list")
        planned = turn_pauses.get(turn.idx) or {}
        ssml = build_ssml(turn.text, language, voice=voice, pause_after_sentence=planned)
        pause_total = sum(int(v) for v in planned.values() if isinstance(v, (int, float)) and v > 0)
        jobs.append(_TurnJob(turn=turn, ssml=ssml, path=work_dir / f"tts_turn_{turn.idx:03d}.wav",
                             expected_sec=expected_audio_sec(turn.text, pause_total)))
    if not jobs:
        return []
    if deadline is not None and speech_rest.monotonic() >= deadline:
        raise TimeoutError("TTS deadline reached before any request")
    work_dir.mkdir(parents=True, exist_ok=True)

    stop = threading.Event()

    def run(job: _TurnJob) -> TurnAudio:
        if stop.is_set():
            raise _Skipped()
        try:
            duration = synthesize_ssml(cfg, job.ssml, job.path, deadline=deadline, expected_sec=job.expected_sec)
        except BaseException:
            # Stop sibling turns before this worker thread picks up the next one.
            stop.set()
            raise
        return TurnAudio(turn_idx=job.turn.idx, speaker=job.turn.speaker, path=job.path,
                         source="tts", duration_sec=duration)

    results: dict[int, TurnAudio] = {}
    failed: dict[int, str] = {}
    deadline_hit = False
    done = 0
    with ThreadPoolExecutor(max_workers=max(1, min(len(jobs), tts_parallel())),
                            thread_name_prefix="podcast-tts") as pool:
        futures = {pool.submit(run, job): job.turn.idx for job in jobs}
        for fut in as_completed(futures):
            idx = futures[fut]
            try:
                results[idx] = fut.result()
            except _Skipped:
                continue
            except TimeoutError:
                deadline_hit = True
                stop.set()
                continue
            except Exception as exc:  # noqa: BLE001
                failed[idx] = _safe_reason(exc)
                log.error("TTS turn %d failed: %s", idx, failed[idx])
                stop.set()
                continue
            done += 1
            if progress_cb:
                try:
                    progress_cb(done)
                except Exception:  # noqa: BLE001
                    pass

    if deadline_hit:
        raise TimeoutError(f"TTS deadline reached ({len(results)}/{len(jobs)} turns synthesized)")
    if failed or len(results) != len(jobs):
        details = "; ".join(f"turn {i}: {reason}" for i, reason in sorted(failed.items()))
        skipped = len(jobs) - len(results) - len(failed)
        suffix = f" ({skipped} not synthesized)" if skipped else ""
        raise RuntimeError(f"{len(failed)}/{len(jobs)} TTS turns failed: {details}{suffix}")
    return [results[job.turn.idx] for job in jobs]


# ---------------------------------------------------------------------------
# Backchannel phrases
# ---------------------------------------------------------------------------

def _speech_blocks(loud: np.ndarray, energy: np.ndarray, block_sec: float) -> tuple[int, int]:
    """``[first, last)`` block of the speech.

    Sound islands are runs of loud blocks (dips <= ISLAND_BRIDGE_SEC bridged).
    Islands of at least BLIP_MAX_SEC are speech; shorter ones count only when
    they lie within BLIP_GAP_SEC of the speech, so isolated clicks are ignored
    even when they are louder than the phrase. Without any long island, the most
    energetic one is the speech.
    """
    edges = np.flatnonzero(np.diff(np.concatenate(([0], loud.astype(np.int8), [0]))))
    bridge = int(round(ISLAND_BRIDGE_SEC / block_sec))
    islands: list[list[int]] = []
    for start, end in zip(edges[0::2].tolist(), edges[1::2].tolist()):
        if islands and start - islands[-1][1] <= bridge:
            islands[-1][1] = end
        else:
            islands.append([start, end])
    min_len = int(round(BLIP_MAX_SEC / block_sec))
    max_gap = int(round(BLIP_GAP_SEC / block_sec))
    long_islands = [isl for isl in islands if isl[1] - isl[0] >= min_len]
    if long_islands:
        lo, hi = long_islands[0][0], long_islands[-1][1]
    else:
        lo, hi = max(islands, key=lambda isl: float(energy[isl[0]:isl[1]].sum()))
    grown = True
    while grown:
        grown = False
        for start, end in islands:
            if lo <= start and end <= hi:
                continue
            gap = start - hi if start >= hi else lo - end
            if gap < max_gap:
                lo, hi = min(lo, start), max(hi, end)
                grown = True
    return lo, hi


def trim_to_speech(pcm: bytes, info: WavInfo, *, margin_sec: float = REACTION_MARGIN_SEC,
                   fade_sec: float = REACTION_FADE_SEC) -> bytes:
    """Cut PCM to the speech span (5 ms blocks above the RMS gate) +- ``margin_sec``,
    with short linear fades at both cut edges (inside the margins).

    Gate = max(-50 dBFS, loudest block - 40 dB). Isolated islands shorter than
    60 ms and at least 150 ms away from the speech (end-of-synthesis clicks) are
    ignored. Raises ``TtsError`` when nothing passes the gate or less than 50 ms
    of speech remains.
    """
    channels = info.channels
    frames = np.frombuffer(pcm, dtype="<i2").reshape(-1, channels).astype(np.float64)
    mono = frames.mean(axis=1) / 32768.0
    rate = info.sample_rate
    block = max(1, int(round(rate * GATE_BLOCK_SEC)))
    n_blocks = len(mono) // block
    if n_blocks == 0:
        raise TtsError("no speech detected")
    rms = np.sqrt(np.mean(mono[: n_blocks * block].reshape(n_blocks, block) ** 2, axis=1))
    floor = 10 ** (GATE_FLOOR_DBFS / 20)
    peak = float(rms.max())
    if peak < floor:
        raise TtsError("no speech detected")
    loud = rms >= max(floor, peak * 10 ** (GATE_RELATIVE_DB / 20))
    first, last = _speech_blocks(loud, rms ** 2, block / rate)
    if (last - first) * block < rate * MIN_REACTION_SPEECH_SEC:
        raise TtsError("no speech detected")
    margin = int(round(rate * margin_sec))
    start = max(0, first * block - margin)
    end = min(len(mono), last * block + margin)
    clip = frames[start:end].copy()
    fade = min(int(round(rate * fade_sec)), len(clip) // 4)
    if fade > 1:
        ramp = np.linspace(0.0, 1.0, fade, endpoint=False)[:, None]
        clip[:fade] *= ramp
        clip[-fade:] *= ramp[::-1]
    return np.clip(np.round(clip), -32768, 32767).astype("<i2").tobytes()


def reaction_cache_key(voice: str, locale: str, reaction_id: str, text: str,
                       output_format: Optional[str] = None, budget_sec: Optional[float] = None) -> str:
    """Hash-only cache name stem: sha256(voice, locale, id, text, format, clip
    budget, RECIPE_VERSION)."""
    raw = json.dumps({"voice": voice, "locale": locale, "id": reaction_id, "text": text,
                      "format": output_format or tts_output_format(),
                      "budget": None if budget_sec is None else round(float(budget_sec), 3),
                      "recipe": RECIPE_VERSION},
                     sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:32]


def _safe_id(value: object) -> str:
    return re.sub(r"[^a-z0-9_-]", "", str(value).lower())[:32] or "?"


_key_locks: dict[str, threading.Lock] = {}
_key_locks_guard = threading.Lock()


def _key_lock(key: str) -> threading.Lock:
    with _key_locks_guard:
        return _key_locks.setdefault(key, threading.Lock())


def _cached_clip(reaction_id: str, text: str, path: Path) -> Optional[ReactionClip]:
    if not path.is_file():
        return None
    try:
        info = read_wav_info(path)
    except (OSError, TtsError):
        log.warning("reaction audio cache entry unreadable (id=%s); re-synthesizing", _safe_id(reaction_id))
        return None
    if info.frames == 0:
        return None
    return ReactionClip(reaction_id=reaction_id, text=text, audio_path=path, video_path=None,
                        duration_sec=info.duration_sec)


def _reaction_clip(cfg: AzureConfig, voice: str, language: str, reaction_id: str, text: str,
                   path: Path, deadline: Optional[float], output_format: str,
                   budget_sec: Optional[float]) -> ReactionClip:
    """Synthesize (or reuse) one clip. A take longer than ``budget_sec`` is
    re-synthesized up to REACTION_MAX_TAKES - 1 times; the first take within
    budget wins, else the shortest take is kept (``place_reactions`` skips it)."""
    with _key_lock(path.name):
        cached = _cached_clip(reaction_id, text, path)
        if cached is not None:
            return cached
        ssml = build_ssml(text, language, voice=voice)
        rid = _safe_id(reaction_id)
        best: Optional[tuple[float, bytes, WavInfo]] = None
        for take in range(1, REACTION_MAX_TAKES + 1):
            try:
                info, pcm = _tts(cfg, ssml, deadline=deadline, expected_sec=expected_audio_sec(text),
                                 output_format=output_format)
                trimmed = trim_to_speech(pcm, info)
            except Exception as exc:  # noqa: BLE001
                if best is None:
                    raise
                log.warning("reaction audio re-take %d failed (id=%s): %s", take, rid, _safe_reason(exc))
                if isinstance(exc, TimeoutError):
                    break
                continue
            duration = len(trimmed) / (2 * info.channels * info.sample_rate)
            if best is None or duration < best[0]:
                best = (duration, trimmed, info)
            if budget_sec is None or duration <= budget_sec:
                break
            log.info("reaction audio take %d over budget (id=%s): %.3fs > %.3fs", take, rid, duration, budget_sec)
        assert best is not None
        duration, trimmed, info = best
        if budget_sec is not None and duration > budget_sec:
            log.warning("reaction audio over budget after %d takes (id=%s): %.3fs > %.3fs",
                        REACTION_MAX_TAKES, rid, duration, budget_sec)
        _write_wav_atomic(path, trimmed, info.sample_rate, info.channels)
        return ReactionClip(reaction_id=reaction_id, text=text, audio_path=path, video_path=None,
                            duration_sec=duration)


def synthesize_reaction_audio(
    cfg: AzureConfig,
    voice: str,
    language: str,
    reaction_ids: Iterable[str],
    cache_dir: Path,
    *,
    deadline: Optional[float] = None,
) -> dict[str, ReactionClip]:
    """Audio-only backchannel clips of ``voice`` keyed by reaction id.

    Text = ``podcast_media.reaction_text(language, id)``; SSML via ``build_ssml``;
    the TTS output is trimmed to the speech span (isolated clicks ignored) and
    cached in ``cache_dir`` as ``<sha256 prefix>.wav`` (no voice, locale or id in
    the name; format and clip budget are part of the key). A take longer than
    ``podcast_media.reaction_clip_budget_sec(language, id)`` is re-synthesized
    (up to 2 more takes; the first within budget wins, else the shortest is
    kept and ``place_reactions`` skips it). ``duration_sec`` is measured;
    ``video_path`` is None. Ids that fail (unknown id, TTS error, no speech,
    deadline) are omitted and logged by id only; never raises for them. A voice
    outside the allow-list yields ``{}``.
    """
    if not voice_catalog.is_allowed_voice(voice):
        log.warning("reaction audio skipped: voice is not on the allow-list")
        return {}
    cache_dir = Path(cache_dir)
    output_format = tts_output_format()
    wanted: list[tuple[str, str, Path, float]] = []
    for reaction_id in dict.fromkeys(reaction_ids):
        try:
            text = podcast_media.reaction_text(language, reaction_id)
            budget = podcast_media.reaction_clip_budget_sec(language, reaction_id)
        except ValueError:
            log.warning("reaction audio skipped (id=%s): unknown id", _safe_id(reaction_id))
            continue
        key = reaction_cache_key(voice, language, reaction_id, text, output_format, budget)
        wanted.append((reaction_id, text, cache_dir / f"{key}.wav", budget))
    if not wanted:
        return {}
    cache_dir.mkdir(parents=True, exist_ok=True)

    clips: dict[str, ReactionClip] = {}
    missing: list[tuple[str, str, Path, float]] = []
    for reaction_id, text, path, budget in wanted:
        cached = _cached_clip(reaction_id, text, path)
        if cached is not None:
            clips[reaction_id] = cached
        else:
            missing.append((reaction_id, text, path, budget))

    if missing:
        with ThreadPoolExecutor(max_workers=max(1, min(len(missing), tts_parallel())),
                                thread_name_prefix="podcast-tts-rx") as pool:
            futures = {
                pool.submit(_reaction_clip, cfg, voice, language, rid, text, path, deadline,
                            output_format, budget): rid
                for rid, text, path, budget in missing
            }
            for fut in as_completed(futures):
                rid = futures[fut]
                try:
                    clips[rid] = fut.result()
                except Exception as exc:  # noqa: BLE001
                    log.warning("reaction audio failed (id=%s): %s", _safe_id(rid), _safe_reason(exc))
    return {rid: clips[rid] for rid, _text, _path, _budget in wanted if rid in clips}


__all__ = [
    "DEFAULT_TTS_OUTPUT_FORMAT",
    "RECIPE_VERSION",
    "TTS_OUTPUT_FORMATS",
    "TtsError",
    "WavInfo",
    "expected_audio_sec",
    "parse_wav",
    "reaction_cache_key",
    "read_wav_info",
    "synthesize_reaction_audio",
    "synthesize_ssml",
    "synthesize_turns",
    "trim_to_speech",
    "tts_output_format",
    "tts_parallel",
    "tts_timeout",
    "tts_url",
]
