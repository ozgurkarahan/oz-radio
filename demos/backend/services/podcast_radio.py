"""Radio master of a podcast: the dedicated audio-only mix ("Listen").

Turns the synthesized speech of every turn — the audio track of the avatar
clips (video format) or the TTS WAVs (audio format) — into a tight,
broadcast-style programme:

1. **Per turn**: decode (any input rate — DragonHD is natively 24 kHz) to
   48 kHz mono float WAV, detect the speech onset and offset with
   ``silencedetect`` (−45 dB, 120 ms) and keep ≈ 80 ms of pre-roll and
   ≈ 120 ms of tail. Trims only ever remove silence; a turn whose detection
   fails stays untrimmed.
2. **Timing**: seeded natural gaps *between the words* of consecutive turns
   (speaker change: Gaussian 240 ± 60 ms clamped to 120–350 ms; same speaker:
   350 ms). When a gap is shorter than tail + pre-roll, both shrink
   proportionally (still silence only), so the programme stays sequential.
3. **Levels + stereo**: every turn is levelled to ``TURN_LEVEL_LUFS`` (voices
   and generations differ by up to ~12 LU); constant-power pan, interviewer
   slightly left, expert slightly right; backchannels (``ReactionPlacement``)
   on the listener's side at ``turn start + at_sec − lead trim`` with their
   voice's levelling gain plus the placement gain. Placements whose clip is
   missing (or that fall outside the kept audio) are skipped.
4. **Intro & outro** (``intro=True``): the Oz Radio sonic logo
   (``podcast_jingle``) a few dB under the voices. Only its faded tail rings
   under the first word (``INTRO_UNDER_SPEECH_SEC``); the outro follows the
   last word after a short breath, overlapping the speech file's tail only.
   An optional licensed bed (``music_path``) is ducked under the voices.
5. **Loudness**: a pre-gain + sample-peak limiter keeps the peak-to-loudness
   ratio low enough for a *linear* two-pass ``loudnorm`` (I −16, TP −1.5,
   LRA 11; raw TTS would silently fall back to dynamic mode; single pass
   when the measurement is unusable) → CBR MP3 128 kb/s, 44.1 kHz stereo,
   ID3v2.3 from an allow-list + the cover re-encoded as APIC (a 128 kb/s MP3
   measures ≈ 0.4 LU under its source: ≈ −16.3 LUFS).
6. **Sidecars**: ``transcript.json`` (``podcast_models.Transcript`` on the
   radio timeline: turns with video offsets, speech + reaction cues, waveform
   peaks) and the radio-timed ``audio.srt`` (SCORM) in the video SRT style.

Graphs stay small: one decode per input, one voice-bus graph (concat filter +
``amix normalize=0``), one programme graph, all through intermediate WAVs in a
private work directory (removed afterwards). Only long-standing filters and
options are used (FFmpeg 5.1+; production runs Debian's 7.1).

``mix_radio`` raises on failure — the caller falls back to the video
soundtrack (``WARNING_RADIO_FALLBACK``). It never reads voices or Speech
character names: ID3 tags come from ``id3_metadata`` only.
"""

from __future__ import annotations

import json
import logging
import math
import os
import random
import re
import shutil
import struct
import subprocess
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Mapping, Optional, Sequence

import numpy as np

from services import podcast_jingle
from services.podcast_media import (
    WARNING_COVER_FALLBACK,
    WARNING_REACTIONS_SKIPPED,
    RadioResult,
    ReactionClip,
    ReactionPlacement,
    TurnAudio,
    add_warning,
)
from services.podcast_models import PodcastHost, Transcript, TranscriptCue, TranscriptTurn

log = logging.getLogger(__name__)

SAMPLE_RATE = 48000
SPEAKERS = ("interviewer", "expert")
PAN = {"interviewer": -0.15, "expert": 0.15}   # −1 left … +1 right

# Speech detection and trims.
SILENCE_NOISE_DB = -45
SILENCE_MIN_SEC = 0.12
EDGE_TOLERANCE_SEC = 0.02      # a silence this close to an edge is leading/trailing
PREROLL_SEC = 0.080
TAIL_SEC = 0.120
LAST_TAIL_SEC = 0.400          # the last turn rings out (the outro overlaps it)
SEGMENT_FADE_IN_SEC = 0.005    # click guards at each cut (inside the kept silence)
SEGMENT_FADE_OUT_SEC = 0.010

# Turn gaps (silence between the last word of a turn and the first of the next).
GAP_MEAN_SEC = 0.240
GAP_SD_SEC = 0.060
GAP_MIN_SEC = 0.120
GAP_MAX_SEC = 0.350
SAME_SPEAKER_GAP_SEC = 0.350

# Programme layout.
LEAD_IN_SEC = 0.25             # no logo: silence before the first word
INTRO_UNDER_SPEECH_SEC = 0.30  # first word this long before the intro logo ends (its faded tail)
OUTRO_AFTER_SPEECH_SEC = 0.15  # breath between the last word and the outro logo
PROGRAM_FADE_IN_SEC = 0.010
PROGRAM_FADE_OUT_SEC = 0.050

# Levels relative to the voices (integrated loudness).
TURN_LEVEL_LUFS = -20.0        # every turn is levelled here first (voices differ by up to ~12 LU)
TURN_GAIN_RANGE_DB = (-20.0, 20.0)
JINGLE_UNDER_SPEECH_LU = 4.0
JINGLE_DEFAULT_GAIN_DB = 6.0   # logo peaks at −18 dBFS ≈ 10 LU under typical speech
JINGLE_GAIN_RANGE_DB = (-6.0, 14.0)
BED_UNDER_SPEECH_LU = 16.0     # + sidechain ducking ≈ −20 LU under the voices
BED_DEFAULT_GAIN_DB = -25.0
BED_FADE_IN_SEC = 1.5
BED_FADE_OUT_SEC = 2.0
BED_DUCKING = "threshold=0.05:ratio=4:attack=20:release=400:makeup=1"
SIDECHAIN_REF_LUFS = -20.0     # the sidechain is levelled to this before ducking

# Loudness normalisation (Apple: −16 LKFS ± 1, true peak ≤ −1 dBTP). Raw TTS has
# too high a peak-to-loudness ratio for a linear loudnorm (it silently falls
# back to dynamic): levelled turns + pre-gain + sample-peak limiter keep the
# PLR ≤ 13.5 dB, so the final gain (≈ +3 dB) stays linear under −1.5 dBTP.
TARGET_I = -16.0
TARGET_TP = -1.5
TARGET_LRA = 11.0
PRE_LEVEL_LUFS = -19.0         # pre-gain target before the safety limiter
LIMITER_CEILING_DBFS = -5.5    # sample-peak ceiling → linear loudnorm stays under TP
LIMITER_ATTACK_MS = 5
LIMITER_RELEASE_MS = 50
LIMITER_ROUNDS = 3             # corrective limiting rounds when linear is still unreachable
LINEAR_TP_MARGIN_DB = 0.1

MP3_BITRATE = "128k"
MP3_SAMPLE_RATE = 44100
COVER_QSCALE = 2               # APIC re-encoded (never stream-copied: drops EXIF/COM)
PEAKS_RATE = 8000
PEAK_BUCKETS = 240
FFMPEG_TIMEOUT_SEC = 900

# ID3 allow-list: nothing else is ever written (no voices, file or character names).
ALBUM_ARTIST = "Oz Radio"
ALBUM = "Oz Radio Podcasts"
GENRE = "Podcast"
ID3_COMMENT = "AI-generated voices"
ID3_KEYS = ("title", "artist", "album_artist", "album", "genre", "date", "language", "comment")
ID3_TITLE_MAX = 200
ID3_NAME_MAX = 80
# ISO 639-2 (terminology codes) by primary language subtag; "und" otherwise.
ISO_639_2 = {"en": "eng", "fr": "fra", "es": "spa", "de": "deu",
             "it": "ita", "pt": "por", "zh": "zho", "ja": "jpn"}

_UNSAFE_TEXT = re.compile(r"[\x00-\x1f\x7f-\x9f\u200b-\u200f\u2028-\u202e\u2066-\u2069]")


# ---------------------------------------------------------------------------
# Data types
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class TurnSpan:
    """Detected speech of one untrimmed turn audio, in samples."""
    frames: int
    onset: int
    offset: int
    detected: bool = True


@dataclass(frozen=True)
class TurnSlot:
    """Where one turn's kept audio sits on the voice bus (samples).

    ``src_start``/``src_end`` select the kept part of the untrimmed audio
    (``src_start`` is the lead trim); ``onset``/``offset`` are the speech
    bounds on the voice bus; ``pad_after`` is the silence that follows.
    """
    turn_idx: int
    speaker: str
    src_start: int
    src_end: int
    bus_start: int
    pad_after: int
    onset: int
    offset: int

    @property
    def length(self) -> int:
        return self.src_end - self.src_start


@dataclass(frozen=True)
class PlacedReaction:
    """A backchannel mapped onto the voice bus."""
    turn_idx: int
    listener: str
    reaction_id: str
    text: str
    audio_path: Path
    bus_start: int          # samples on the voice bus
    duration_sec: float     # measured clip duration (cue length)
    gain_db: float


@dataclass(frozen=True)
class ProgramLayout:
    """Voice bus and logo positions in the programme (samples)."""
    voice_offset: int
    total: int
    outro_start: Optional[int] = None


@dataclass(frozen=True)
class LoudnormStats:
    """First-pass ``loudnorm`` measurement."""
    i: float
    tp: float
    lra: float
    thresh: float
    offset: float


@dataclass(frozen=True)
class _Decoded:
    path: Path
    frames: int
    span: TurnSpan
    loudness: Optional[float]


# ---------------------------------------------------------------------------
# Pure helpers: timing, panning, metadata
# ---------------------------------------------------------------------------

def _samples(sec: float, sample_rate: int = SAMPLE_RATE) -> int:
    return int(round(sec * sample_rate))


def pan_gains(pan: float) -> tuple[float, float]:
    """Constant-power pan law: (left, right) gains, −3 dB each at the centre."""
    theta = (max(-1.0, min(1.0, pan)) + 1.0) * math.pi / 4
    return math.cos(theta), math.sin(theta)


def turn_gaps(speakers: Sequence[str], seed: str) -> list[float]:
    """Silence (s) between the words of turn k−1 and turn k, for k ≥ 1.

    Deterministic for a given ``seed``: a speaker change draws a Gaussian gap
    (mean 240 ms, sd 60 ms) clamped to 120–350 ms; the same speaker continuing
    gets 350 ms.
    """
    rng = random.Random(f"oz-radio-gaps:{seed}")
    gaps: list[float] = []
    for prev, cur in zip(speakers, speakers[1:]):
        if prev == cur:
            gaps.append(SAME_SPEAKER_GAP_SEC)
        else:
            gaps.append(min(GAP_MAX_SEC, max(GAP_MIN_SEC, rng.gauss(GAP_MEAN_SEC, GAP_SD_SEC))))
    return gaps


_SILENCE_RE = re.compile(r"silence_(start|end)\s*:\s*(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)")


def parse_silences(log_text: str) -> list[tuple[float, Optional[float]]]:
    """``silencedetect`` intervals ``(start, end)``; ``end`` is None at EOF."""
    intervals: list[tuple[float, Optional[float]]] = []
    start: Optional[float] = None
    for kind, value in _SILENCE_RE.findall(log_text or ""):
        t = float(value)
        if kind == "start":
            start = max(0.0, t)
        else:
            intervals.append((0.0 if start is None else start, max(0.0, t)))
            start = None
    if start is not None:
        intervals.append((start, None))
    return intervals


def speech_bounds(
    silences: Sequence[tuple[float, Optional[float]]],
    duration: float,
    *,
    tolerance: float = EDGE_TOLERANCE_SEC,
) -> Optional[tuple[float, float]]:
    """(onset, offset) in seconds from the leading/trailing silences.

    Internal pauses are ignored. None when the audio is all silence (or empty).
    """
    if duration <= 0:
        return None
    onset, offset = 0.0, duration
    if silences:
        first_start, first_end = silences[0]
        if first_start <= tolerance:
            if first_end is None or first_end >= duration - tolerance:
                return None
            onset = first_end
        last_start, last_end = silences[-1]
        if (last_end is None or last_end >= duration - tolerance) and last_start > tolerance:
            offset = last_start
    if offset - onset <= 0:
        return None
    return onset, min(offset, duration)


def detect_span(frames: int, silences: Sequence[tuple[float, Optional[float]]],
                sample_rate: int = SAMPLE_RATE) -> TurnSpan:
    """Speech span in samples; the whole clip (``detected=False``) when unknown."""
    bounds = speech_bounds(silences, frames / sample_rate) if frames > 0 else None
    if bounds is not None:
        onset = max(0, min(frames, _samples(bounds[0], sample_rate)))
        offset = max(0, min(frames, _samples(bounds[1], sample_rate)))
        if offset > onset:
            return TurnSpan(frames, onset, offset, True)
    return TurnSpan(frames, 0, frames, False)


def plan_timeline(
    turn_ids: Sequence[int],
    speakers: Sequence[str],
    spans: Sequence[TurnSpan],
    gaps: Sequence[float],
    *,
    sample_rate: int = SAMPLE_RATE,
) -> list[TurnSlot]:
    """Trim and place every turn on the voice bus (time 0 = first kept sample).

    The silence between the words of consecutive turns equals the gap exactly:
    tail + inserted silence + pre-roll. Only silence is ever cut.
    """
    n = len(spans)
    if len(turn_ids) != n or len(speakers) != n or len(gaps) != max(0, n - 1):
        raise ValueError("plan_timeline: turns, speakers, spans and gaps disagree")
    pre = [min(_samples(PREROLL_SEC, sample_rate), s.onset) for s in spans]
    tail = [
        min(_samples(LAST_TAIL_SEC if k == n - 1 else TAIL_SEC, sample_rate), s.frames - s.offset)
        for k, s in enumerate(spans)
    ]
    silence_before = [0] * n
    for k in range(1, n):
        gap = _samples(gaps[k - 1], sample_rate)
        t, p = tail[k - 1], pre[k]
        if t + p > gap:
            scale = gap / (t + p)
            tail[k - 1], pre[k] = int(t * scale), int(p * scale)
        silence_before[k] = gap - tail[k - 1] - pre[k]
    slots: list[TurnSlot] = []
    cursor = 0
    for k, span in enumerate(spans):
        src_start = span.onset - pre[k]
        src_end = span.offset + tail[k]
        pad_after = silence_before[k + 1] if k + 1 < n else 0
        slots.append(TurnSlot(
            turn_idx=turn_ids[k],
            speaker=speakers[k],
            src_start=src_start,
            src_end=src_end,
            bus_start=cursor,
            pad_after=pad_after,
            onset=cursor + pre[k],
            offset=cursor + (span.offset - src_start),
        ))
        cursor += (src_end - src_start) + pad_after
    return slots


def reaction_mix_start(turn_mix_start: float, lead_trim: float, at_sec: float) -> float:
    """Absolute start of a reaction: ``at_sec`` is relative to the untrimmed turn audio."""
    return turn_mix_start + (at_sec - lead_trim)


def map_reactions(
    placements: Sequence[ReactionPlacement],
    slots: Sequence[TurnSlot],
    clips: Mapping[str, Mapping[str, ReactionClip]],
    *,
    sample_rate: int = SAMPLE_RATE,
) -> tuple[list[PlacedReaction], int]:
    """Placements on the voice bus + the number skipped.

    Skipped: unknown turn, listener equal to the speaker, missing clip or
    audio file, or a reaction outside the turn's kept audio.
    """
    by_turn = {slot.turn_idx: slot for slot in slots}
    placed: list[PlacedReaction] = []
    skipped = 0
    for p in sorted(placements or [], key=lambda x: (x.turn_idx, x.at_sec)):
        slot = by_turn.get(p.turn_idx)
        clip = (clips or {}).get(p.listener, {}).get(p.reaction_id)
        if (slot is None or clip is None or p.listener not in PAN or p.listener == slot.speaker
                or not Path(clip.audio_path).is_file()):
            skipped += 1
            continue
        duration = float(p.duration_sec) if p.duration_sec > 0 else float(clip.duration_sec)
        at = _samples(p.at_sec, sample_rate)
        if duration <= 0 or at < slot.src_start or at + _samples(duration, sample_rate) > slot.src_end:
            skipped += 1
            continue
        placed.append(PlacedReaction(
            turn_idx=p.turn_idx,
            listener=p.listener,
            reaction_id=p.reaction_id,
            text=clip.text,
            audio_path=Path(clip.audio_path),
            bus_start=slot.bus_start + at - slot.src_start,
            duration_sec=duration,
            gain_db=float(p.gain_db),
        ))
    return placed, skipped


def plan_program(
    slots: Sequence[TurnSlot],
    placed: Sequence[PlacedReaction],
    bus_len: int,
    *,
    intro_len: Optional[int],
    outro_len: Optional[int],
    sample_rate: int = SAMPLE_RATE,
) -> ProgramLayout:
    """Place the voice bus and the logos.

    With the intro, the first word starts ``INTRO_UNDER_SPEECH_SEC`` before the
    logo ends (its faded tail); otherwise after ``LEAD_IN_SEC``. The outro
    starts ``OUTRO_AFTER_SPEECH_SEC`` after the last word (or reaction).
    """
    if intro_len:
        first_word = intro_len - _samples(INTRO_UNDER_SPEECH_SEC, sample_rate)
    else:
        first_word = _samples(LEAD_IN_SEC, sample_rate)
    voice_offset = max(0, first_word - slots[0].onset)
    content_end = max([slots[-1].offset]
                      + [r.bus_start + _samples(r.duration_sec, sample_rate) for r in placed])
    total = voice_offset + bus_len
    outro_start = None
    if outro_len:
        outro_start = voice_offset + content_end + _samples(OUTRO_AFTER_SPEECH_SEC, sample_rate)
        total = max(total, outro_start + outro_len)
    return ProgramLayout(voice_offset=voice_offset, total=total, outro_start=outro_start)


def combined_loudness(parts: Sequence[tuple[float, Optional[float]]]) -> Optional[float]:
    """Energy average of per-part integrated loudness (LUFS), weighted by duration."""
    num = den = 0.0
    for weight, lufs in parts:
        if lufs is None or weight <= 0 or not math.isfinite(lufs):
            continue
        num += weight * 10 ** (lufs / 10)
        den += weight
    if den <= 0 or num <= 0:
        return None
    return 10 * math.log10(num / den)


def level_gains(speakers: Sequence[str], loudness: Sequence[Optional[float]]) -> list[float]:
    """Per-turn gain (dB) bringing each turn to ``TURN_LEVEL_LUFS``.

    A turn whose loudness is unknown borrows its speaker's median gain (then
    the overall median, else 0 dB).
    """
    low, high = TURN_GAIN_RANGE_DB
    gains: list[Optional[float]] = [
        None if lufs is None else max(low, min(high, TURN_LEVEL_LUFS - lufs)) for lufs in loudness
    ]
    known = [g for g in gains if g is not None]
    overall = float(np.median(known)) if known else 0.0
    by_speaker = {s: [g for g, sp in zip(gains, speakers) if sp == s and g is not None] for s in set(speakers)}
    return [g if g is not None else (float(np.median(by_speaker[s])) if by_speaker[s] else overall)
            for g, s in zip(gains, speakers)]


def voice_gains(speakers: Sequence[str], gains: Sequence[float]) -> dict[str, float]:
    """Median levelling gain of each voice (applied to its backchannels too)."""
    out: dict[str, float] = {}
    for speaker in set(speakers):
        values = [g for g, s in zip(gains, speakers) if s == speaker]
        out[speaker] = float(np.median(values)) if values else 0.0
    return out


def _clean_text(value: object, limit: int) -> str:
    text = " ".join(_UNSAFE_TEXT.sub(" ", str(value or "")).split())
    return text[:limit].rstrip()


def iso639_2(language: str) -> str:
    """ISO 639-2 code of a BCP-47 tag (``fr-FR`` → ``fra``); ``und`` when unknown."""
    primary = (language or "").strip().replace("_", "-").split("-", 1)[0].lower()
    return ISO_639_2.get(primary, "und")


def ordered_hosts(hosts: Optional[Sequence[PodcastHost]], roles: Any = None) -> list[PodcastHost]:
    """Hosts interviewer first; derived from ``roles`` display names when empty."""
    order = {"interviewer": 0, "expert": 1}
    if hosts:
        return sorted(hosts, key=lambda h: order.get(h.role, 2))
    derived: list[PodcastHost] = []
    for role in SPEAKERS:
        cfg = getattr(roles, role, None) if roles is not None else None
        if cfg is None:
            continue
        name = _clean_text(getattr(cfg, "display_name", ""), ID3_NAME_MAX) or role.title()
        derived.append(PodcastHost(role=role, display_name=name,
                                   avatar_id=(getattr(cfg, "avatar", "") or None)))
    return derived


def id3_metadata(title: str, hosts: Sequence[PodcastHost], language: str, year: int) -> dict[str, str]:
    """The only ID3 tags ever written (``ID3_KEYS``, in that order).

    Public values only: the episode title, the hosts' display names, the
    brand, the year, the language and the AI disclosure.
    """
    names: list[str] = []
    for host in ordered_hosts(hosts):
        name = _clean_text(host.display_name, ID3_NAME_MAX)
        if name and name not in names:
            names.append(name)
    return {
        "title": _clean_text(title, ID3_TITLE_MAX) or ALBUM_ARTIST,
        "artist": " & ".join(names) or ALBUM_ARTIST,
        "album_artist": ALBUM_ARTIST,
        "album": ALBUM,
        "genre": GENRE,
        "date": str(int(year)),
        "language": iso639_2(language),
        "comment": ID3_COMMENT,
    }


_EBUR_I_RE = re.compile(r"\bI:\s+(-?\d+(?:\.\d+)?|-?inf|nan)\s+LUFS")
_LOUDNORM_JSON_RE = re.compile(r"\{[^{}]*\"input_i\"[^{}]*\}", re.S)


def parse_ebur128_integrated(log_text: str) -> Optional[float]:
    """Integrated loudness (LUFS) from an ``ebur128`` summary; None for silence."""
    idx = (log_text or "").rfind("Summary:")
    if idx < 0:
        return None
    match = _EBUR_I_RE.search(log_text, idx)
    if not match:
        return None
    try:
        value = float(match.group(1))
    except ValueError:
        return None
    return value if math.isfinite(value) and value > -69.5 else None


def parse_loudnorm_json(log_text: str) -> Optional[dict[str, str]]:
    """The last ``loudnorm`` ``print_format=json`` block of an ffmpeg log."""
    blocks = _LOUDNORM_JSON_RE.findall(log_text or "")
    if not blocks:
        return None
    try:
        data = json.loads(blocks[-1])
    except ValueError:
        return None
    return {str(k): str(v) for k, v in data.items()} if isinstance(data, dict) else None


def loudnorm_stats(data: Optional[Mapping[str, str]]) -> Optional[LoudnormStats]:
    """Validated first-pass measurement (None when missing, infinite or out of range)."""
    if not data:
        return None
    try:
        stats = LoudnormStats(
            i=float(data["input_i"]),
            tp=float(data["input_tp"]),
            lra=float(data["input_lra"]),
            thresh=float(data["input_thresh"]),
            offset=float(data["target_offset"]),
        )
    except (KeyError, TypeError, ValueError):
        return None
    values = (stats.i, stats.tp, stats.lra, stats.thresh, stats.offset)
    if not all(math.isfinite(v) for v in values):
        return None
    if not (-99 < stats.i < 0 and -99 < stats.tp < 99 and 0 <= stats.lra < 99
            and -99 < stats.thresh < 0 and -99 < stats.offset < 99):
        return None
    return stats


def linear_feasible(stats: LoudnormStats) -> bool:
    """loudnorm only stays linear when the gain keeps the true peak under TP and LRA fits."""
    return (stats.tp + (TARGET_I - stats.i) <= TARGET_TP - LINEAR_TP_MARGIN_DB
            and stats.lra <= TARGET_LRA)


def loudnorm_filter(stats: Optional[LoudnormStats]) -> str:
    """Second-pass (linear, measured) filter, or the single-pass one without stats."""
    base = f"loudnorm=I={TARGET_I:g}:TP={TARGET_TP:g}:LRA={TARGET_LRA:g}"
    if stats is None:
        return f"{base}:print_format=json"
    return (f"{base}:measured_I={stats.i:.2f}:measured_TP={stats.tp:.2f}"
            f":measured_LRA={stats.lra:.2f}:measured_thresh={stats.thresh:.2f}"
            f":offset={stats.offset:.2f}:linear=true:print_format=json")


def limiter_chain(gain_db: float, ceiling_dbfs: float = LIMITER_CEILING_DBFS) -> str:
    """Pre-gain + sample-peak limiter (auto-level off) ahead of loudnorm."""
    gain = max(-30.0, min(30.0, gain_db))
    limit = 10 ** (max(-24.0, min(-1.0, ceiling_dbfs)) / 20)
    return (f"volume={gain:.2f}dB,alimiter=limit={limit:.4f}:attack={LIMITER_ATTACK_MS}"
            f":release={LIMITER_RELEASE_MS}:level=0")


def _pan_expr(pan: float, gain_db: float = 0.0) -> str:
    left, right = pan_gains(pan)
    g = 10 ** (gain_db / 20)
    return f"pan=stereo|c0={left * g:.6f}*c0|c1={right * g:.6f}*c0"


def _delay(samples: int) -> str:
    return f"adelay=delays={samples}S|{samples}S"


def voice_bus_graph(
    slots: Sequence[TurnSlot],
    reactions: Sequence[tuple[int, PlacedReaction]],
    *,
    turn_gains: Optional[Sequence[float]] = None,
    listener_gains: Optional[Mapping[str, float]] = None,
    sample_rate: int = SAMPLE_RATE,
) -> str:
    """Filter graph of the voice bus; output pad ``[voice]``.

    Input ``i`` is turn ``slots[i]`` (mono float WAV of the untrimmed audio);
    ``reactions`` pairs an input index with its placement. Turns are trimmed,
    faded at the cuts, levelled (``turn_gains``), panned, padded with their
    following silence and concatenated; reactions get their voice's levelling
    gain (``listener_gains``) plus the placement gain, are panned to the
    listener's side, delayed and summed without normalisation.
    """
    gains = list(turn_gains) if turn_gains is not None else [0.0] * len(slots)
    if len(gains) != len(slots):
        raise ValueError("voice_bus_graph: one gain per turn")
    fade_in = _samples(SEGMENT_FADE_IN_SEC, sample_rate)
    fade_out = _samples(SEGMENT_FADE_OUT_SEC, sample_rate)
    chains: list[str] = []
    for i, (slot, gain) in enumerate(zip(slots, gains)):
        parts = [f"atrim=start_sample={slot.src_start}:end_sample={slot.src_end}", "asetpts=N/SR/TB"]
        if slot.length > 2 * (fade_in + fade_out):
            parts.append(f"afade=t=in:start_sample=0:nb_samples={fade_in}")
            parts.append(f"afade=t=out:start_sample={slot.length - fade_out}:nb_samples={fade_out}")
        parts.append(_pan_expr(PAN.get(slot.speaker, 0.0), gain))
        if slot.pad_after > 0:
            parts.append(f"apad=pad_len={slot.pad_after}")
        chains.append(f"[{i}:a]{','.join(parts)}[t{i}]")
    turns = "".join(f"[t{i}]" for i in range(len(slots)))
    concat = f"{turns}concat=n={len(slots)}:v=0:a=1"
    if not reactions:
        chains.append(f"{concat}[voice]")
        return ";".join(chains)
    chains.append(f"{concat}[speech]")
    pads = ["[speech]"]
    for k, (input_idx, r) in enumerate(reactions):
        gain = r.gain_db + (listener_gains or {}).get(r.listener, 0.0)
        delay = f",{_delay(r.bus_start)}" if r.bus_start > 0 else ""
        chains.append(f"[{input_idx}:a]{_pan_expr(PAN.get(r.listener, 0.0), gain)}{delay}[r{k}]")
        pads.append(f"[r{k}]")
    chains.append(f"{''.join(pads)}amix=inputs={len(pads)}:normalize=0:duration=first[voice]")
    return ";".join(chains)


@dataclass(frozen=True)
class BedSpec:
    """Licensed music bed: gain to its base level and the sidechain level."""
    gain_db: float
    level_sc: float


def program_graph(
    layout: ProgramLayout,
    *,
    intro_gain_db: Optional[float] = None,
    outro_gain_db: Optional[float] = None,
    bed: Optional[BedSpec] = None,
    pre_gain_db: Optional[float] = None,
    sample_rate: int = SAMPLE_RATE,
) -> str:
    """Filter graph of the programme; output pad ``[out]``.

    Inputs: 0 = silent stereo base (fixes the length), 1 = voice bus, then the
    intro logo (when ``intro_gain_db`` is set), the outro logo (when
    ``outro_gain_db`` is set) and the looping bed (when ``bed`` is set).
    """
    total = layout.total
    chains: list[str] = []
    voice = f"[1:a]{_delay(layout.voice_offset)}" if layout.voice_offset > 0 else "[1:a]anull"
    chains.append(f"{voice},asplit=2[v][sc]" if bed else f"{voice}[v]")
    pads = ["[0:a]", "[v]"]
    idx = 2
    if intro_gain_db is not None:
        chains.append(f"[{idx}:a]volume={intro_gain_db:.2f}dB[ji]")
        pads.append("[ji]")
        idx += 1
    if outro_gain_db is not None and layout.outro_start is not None:
        chains.append(f"[{idx}:a]volume={outro_gain_db:.2f}dB,{_delay(layout.outro_start)}[jo]")
        pads.append("[jo]")
        idx += 1
    if bed is not None:
        fade_in = min(_samples(BED_FADE_IN_SEC, sample_rate), total // 3)
        fade_out = min(_samples(BED_FADE_OUT_SEC, sample_rate), total // 3)
        chains.append(
            f"[{idx}:a]aresample={sample_rate},aformat=sample_fmts=flt:channel_layouts=stereo,"
            f"volume={bed.gain_db:.2f}dB,atrim=end_sample={total},asetpts=N/SR/TB,"
            f"afade=t=in:start_sample=0:nb_samples={max(1, fade_in)},"
            f"afade=t=out:start_sample={total - max(1, fade_out)}:nb_samples={max(1, fade_out)}[bedraw]"
        )
        chains.append(f"[sc]apad=whole_len={total}[scp]")
        chains.append(f"[bedraw][scp]sidechaincompress={BED_DUCKING}:level_sc={bed.level_sc:.4f}[bed]")
        pads.append("[bed]")
    post = [f"amix=inputs={len(pads)}:normalize=0:duration=first", f"atrim=end_sample={total}"]
    if pre_gain_db is not None:
        post.append(limiter_chain(pre_gain_db))
    fade_in = _samples(PROGRAM_FADE_IN_SEC, sample_rate)
    fade_out = min(_samples(PROGRAM_FADE_OUT_SEC, sample_rate), max(1, total // 4))
    post.append(f"afade=t=in:start_sample=0:nb_samples={fade_in}")
    post.append(f"afade=t=out:start_sample={max(0, total - fade_out)}:nb_samples={fade_out}")
    chains.append(f"{''.join(pads)}{','.join(post)}[out]")
    return ";".join(chains)


def mp3_encode_args(
    source: Path,
    cover: Optional[Path],
    out: Path,
    audio_filter: str,
    metadata: Mapping[str, str],
) -> list[str]:
    """ffmpeg arguments: CBR MP3 44.1 kHz stereo, ID3v2.3 allow-list + APIC cover."""
    args = ["-i", str(source)]
    if cover is not None:
        args += ["-i", str(cover)]
    args += ["-map", "0:a:0"]
    if cover is not None:
        args += ["-map", "1:v:0"]
    args += ["-af", audio_filter,
             "-c:a", "libmp3lame", "-b:a", MP3_BITRATE, "-ar", str(MP3_SAMPLE_RATE), "-ac", "2"]
    if cover is not None:
        args += ["-c:v", "mjpeg", "-q:v", str(COVER_QSCALE), "-disposition:v:0", "attached_pic",
                 "-metadata:s:v:0", "title=Cover", "-metadata:s:v:0", "comment=Cover (front)"]
    args += ["-map_metadata", "-1", "-map_chapters", "-1"]
    for key in ID3_KEYS:
        value = metadata.get(key)
        if value:
            args += ["-metadata", f"{key}={value}"]
    args += ["-id3v2_version", "3", "-write_id3v1", "0",
             "-fflags", "+bitexact", "-flags:a", "+bitexact", "-f", "mp3", str(out)]
    return args


def compute_peaks(samples: np.ndarray, buckets: int = PEAK_BUCKETS) -> list[float]:
    """``buckets`` max-abs values normalised to 0..1 with a gentle sqrt curve."""
    data = np.abs(np.asarray(samples, dtype=np.float64).ravel())
    if data.size == 0 or buckets <= 0:
        return [0.0] * max(0, buckets)
    maxes = np.array([chunk.max() if chunk.size else 0.0 for chunk in np.array_split(data, buckets)])
    top = float(maxes.max())
    if top <= 0:
        return [0.0] * buckets
    return [round(float(v), 3) for v in np.sqrt(maxes / top)]


def _caption_helpers() -> tuple[Callable[[str], list[str]], Callable[[float], str]]:
    # Shared with the video captions; imported lazily (heavy render stack).
    from services import podcast_compose

    return podcast_compose._chunk_text, podcast_compose._srt_time


def speech_cues(
    text: str,
    start: float,
    end: float,
    *,
    speaker: str,
    turn_idx: int,
    chunker: Optional[Callable[[str], list[str]]] = None,
) -> list[TranscriptCue]:
    """Caption chunks (≤ 80 chars, as in the video) timed by words over [start, end]."""
    text = (text or "").strip()
    if not text or end <= start:
        return []
    chunks = [c for c in (chunker or _caption_helpers()[0])(text) if c.strip()]
    counts = [max(1, len(c.split())) for c in chunks]
    total = sum(counts)
    span = end - start
    cues: list[TranscriptCue] = []
    done = 0
    for i, (chunk, count) in enumerate(zip(chunks, counts)):
        cue_start = start + span * done / total
        done += count
        cue_end = end if i == len(chunks) - 1 else start + span * done / total
        cues.append(TranscriptCue(start=round(cue_start, 3), end=round(cue_end, 3), speaker=speaker,
                                  turn_idx=turn_idx, text=chunk, kind="speech"))
    return cues


def build_transcript(
    slots: Sequence[TurnSlot],
    placed: Sequence[PlacedReaction],
    *,
    voice_offset: int,
    duration_sec: float,
    texts: Mapping[int, str],
    hosts: Sequence[PodcastHost],
    peaks: Sequence[float],
    video_offsets: Optional[Mapping[int, tuple[float, float]]] = None,
    sample_rate: int = SAMPLE_RATE,
    chunker: Optional[Callable[[str], list[str]]] = None,
) -> Transcript:
    """Radio-timed transcript: turns (speech onset → offset), speech + reaction cues."""
    def at(samples: int) -> float:
        return round((voice_offset + samples) / sample_rate, 3)

    offsets = {int(k): v for k, v in (video_offsets or {}).items()}
    turns: list[TranscriptTurn] = []
    cues: list[TranscriptCue] = []
    for slot in slots:
        start, end = at(slot.onset), at(slot.offset)
        video = offsets.get(slot.turn_idx)
        turns.append(TranscriptTurn(
            turn_idx=slot.turn_idx, speaker=slot.speaker, start=start, end=end,
            video_start=round(float(video[0]), 3) if video else None,
            video_end=round(float(video[1]), 3) if video else None,
        ))
        cues.extend(speech_cues(texts.get(slot.turn_idx, ""), start, end, speaker=slot.speaker,
                                turn_idx=slot.turn_idx, chunker=chunker))
    for r in placed:
        start = at(r.bus_start)
        cues.append(TranscriptCue(start=start, end=round(start + r.duration_sec, 3), speaker=r.listener,
                                  turn_idx=r.turn_idx, text=r.text, kind="reaction"))
    cues.sort(key=lambda c: (c.start, c.kind != "speech"))
    return Transcript(version=1, duration_sec=round(duration_sec, 3), hosts=list(hosts),
                      turns=turns, cues=cues, peaks=list(peaks))


def srt_text(
    cues: Sequence[TranscriptCue],
    names: Mapping[str, str],
    *,
    srt_time: Optional[Callable[[float], str]] = None,
) -> str:
    """SRT of the speech cues, "Name: text" like the video SRT."""
    fmt = srt_time or _caption_helpers()[1]
    lines: list[str] = []
    number = 0
    for cue in cues:
        if cue.kind != "speech":
            continue
        number += 1
        lines += [str(number), f"{fmt(cue.start)} --> {fmt(cue.end)}",
                  f"{names.get(cue.speaker, cue.speaker)}: {cue.text}", ""]
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------

def mix_radio(
    turn_audio: list[TurnAudio],
    placements: list[ReactionPlacement],
    clips: dict[str, dict[str, ReactionClip]],
    script: Any,
    roles: Any,
    hosts: list[PodcastHost],
    *,
    title: str,
    language: str,
    out_dir: Path,
    intro: bool,
    seed: str,
    video_offsets: Optional[dict[int, tuple[float, float]]] = None,
    music_path: Optional[Path] = None,
    avatar_images: Optional[dict[str, Path]] = None,
    warnings: Optional[list[str]] = None,
) -> RadioResult:
    """Render ``audio.mp3``, ``audio.srt``, ``transcript.json`` and ``cover.jpg`` into ``out_dir``.

    ``warnings`` (optional) receives stable codes: ``reactions_skipped`` when
    a placement could not be mixed, ``cover_fallback`` when the cover art fell
    back. Raises on failure (the caller falls back to the video soundtrack).
    """
    if not turn_audio:
        raise ValueError("mix_radio needs at least one turn")
    _require_tool("ffmpeg")
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    work = out_dir / f"_radio_work_{uuid.uuid4().hex[:8]}"
    work.mkdir()
    try:
        return _mix(
            turn_audio, placements, clips, script, roles, hosts,
            title=title, language=language, out_dir=out_dir, work=work, intro=intro, seed=seed,
            video_offsets=video_offsets, music_path=music_path, avatar_images=avatar_images,
            warnings=warnings,
        )
    finally:
        shutil.rmtree(work, ignore_errors=True)


def _mix(turn_audio, placements, clips, script, roles, hosts, *, title, language, out_dir, work,
         intro, seed, video_offsets, music_path, avatar_images, warnings) -> RadioResult:
    sr = SAMPLE_RATE
    turns = sorted(turn_audio, key=lambda t: t.turn_idx)

    # 1) Decode every turn; detect its speech span and loudness.
    decoded = [_decode(Path(t.path), work / f"turn_{i:03d}.wav", detect=True) for i, t in enumerate(turns)]
    for t, d in zip(turns, decoded):
        if d.frames <= 0:
            raise RuntimeError(f"turn {t.turn_idx} has no audio")
    speakers = [t.speaker for t in turns]
    slots = plan_timeline([t.turn_idx for t in turns], speakers, [d.span for d in decoded],
                          turn_gaps(speakers, seed), sample_rate=sr)
    gains = level_gains(speakers, [d.loudness for d in decoded])
    voice_lufs = combined_loudness([((d.span.offset - d.span.onset) / sr, None if d.loudness is None
                                     else d.loudness + g) for d, g in zip(decoded, gains)])

    # 2) Backchannels on the voice bus.
    placed, skipped = map_reactions(placements, slots, clips, sample_rate=sr)
    if skipped:
        log.info("podcast radio: %d reaction placement(s) skipped", skipped)
        if warnings is not None:
            add_warning(warnings, WARNING_REACTIONS_SKIPPED)
    reaction_wavs: dict[Path, Path] = {}
    for r in placed:
        if r.audio_path not in reaction_wavs:
            target = work / f"reaction_{len(reaction_wavs):02d}.wav"
            _decode(r.audio_path, target, detect=False)
            reaction_wavs[r.audio_path] = target

    # 3) Voice bus: trimmed, panned turns + reactions.
    voice_wav = work / "voice.wav"
    inputs: list[str] = []
    for d in decoded:
        inputs += ["-i", str(d.path)]
    indexed = [(len(decoded) + k, r) for k, r in enumerate(placed)]
    for r in placed:
        inputs += ["-i", str(reaction_wavs[r.audio_path])]
    _ffmpeg([*inputs, "-filter_complex",
             voice_bus_graph(slots, indexed, turn_gains=gains, listener_gains=voice_gains(speakers, gains),
                             sample_rate=sr),
             "-map", "[voice]", "-c:a", "pcm_f32le", "-ar", str(sr), "-f", "wav", str(voice_wav)])
    bus_len = wav_frames(voice_wav)
    for path in [d.path for d in decoded] + list(reaction_wavs.values()):
        path.unlink(missing_ok=True)     # large float WAVs: free the disk early

    # 4) Logos + programme.
    intro_wav = outro_wav = None
    if intro:
        intro_wav = _render_logo("intro", work)
        outro_wav = _render_logo("outro", work)
    layout = plan_program(
        slots, placed, bus_len,
        intro_len=wav_frames(intro_wav) if intro_wav else None,
        outro_len=wav_frames(outro_wav) if outro_wav else None,
        sample_rate=sr,
    )
    program_wav = work / "program.wav"
    bed = _bed_spec(Path(music_path), voice_lufs) if music_path and Path(music_path).is_file() else None
    logo_gains = {kind: _logo_gain(kind, path, voice_lufs)
                  for kind, path in (("intro", intro_wav), ("outro", outro_wav)) if path}
    pre_gain = (PRE_LEVEL_LUFS - voice_lufs) if voice_lufs is not None else None
    try:
        _build_program(program_wav, voice_wav, layout, intro_wav, outro_wav, logo_gains, bed,
                       Path(music_path) if bed else None, pre_gain)
    except RuntimeError:
        if bed is None:
            raise
        log.warning("podcast radio: music bed unusable — mixing without it")
        bed = None
        _build_program(program_wav, voice_wav, layout, intro_wav, outro_wav, logo_gains, None, None, pre_gain)
    voice_wav.unlink(missing_ok=True)

    # 5) Cover, loudness, MP3.
    show_hosts = ordered_hosts(hosts, roles)
    cover = _make_cover(title, show_hosts, out_dir / "cover.jpg", avatar_images, warnings)
    mp3 = out_dir / "audio.mp3"
    metadata = id3_metadata(title, show_hosts, language, datetime.now(timezone.utc).year)
    normalization = _normalize_and_encode(program_wav, cover, mp3, metadata, work)

    # 6) Transcript + radio SRT.
    duration = layout.total / sr
    try:
        peaks = compute_peaks(_decode_pcm(mp3, PEAKS_RATE))
    except (RuntimeError, OSError, subprocess.SubprocessError):
        log.warning("podcast radio: waveform peaks unavailable", exc_info=True)
        peaks = []
    texts = {t.idx: t.text for t in getattr(script, "turns", None) or []}
    transcript = build_transcript(slots, placed, voice_offset=layout.voice_offset, duration_sec=duration,
                                  texts=texts, hosts=show_hosts, peaks=peaks,
                                  video_offsets=video_offsets, sample_rate=sr)
    transcript_path = out_dir / "transcript.json"
    _write_text(transcript_path, json.dumps(transcript.model_dump(mode="json"), ensure_ascii=False,
                                            separators=(",", ":")))
    srt_path = out_dir / "audio.srt"
    names = {h.role: h.display_name for h in show_hosts}
    _write_text(srt_path, srt_text(transcript.cues, names))

    log.info(
        "podcast radio: %d turns, %d reactions (%d skipped), %.1f s, logo=%s, bed=%s, loudnorm=%s",
        len(slots), len(placed), skipped, duration, bool(intro_wav), bed is not None, normalization,
    )
    return RadioResult(mp3=mp3, srt=srt_path, transcript_path=transcript_path, transcript=transcript,
                       cover=cover, duration_sec=round(duration, 3), audio_kind="radio_mix")


def _decode(src: Path, out: Path, *, detect: bool) -> _Decoded:
    """Decode the first audio stream to 48 kHz mono float WAV (+ speech span, loudness)."""
    chain = [f"aresample={SAMPLE_RATE}", "aformat=sample_fmts=flt:channel_layouts=mono", "asetpts=N/SR/TB"]
    if detect:
        chain += [f"silencedetect=noise={SILENCE_NOISE_DB}dB:d={SILENCE_MIN_SEC}", "ebur128=framelog=verbose"]
    proc = _ffmpeg(["-i", str(src), "-map", "0:a:0", "-vn", "-sn", "-dn", "-af", ",".join(chain),
                    "-c:a", "pcm_f32le", "-ar", str(SAMPLE_RATE), "-f", "wav", str(out)],
                   loglevel="info" if detect else "error")
    frames = wav_frames(out)
    if not detect:
        return _Decoded(out, frames, TurnSpan(frames, 0, frames, False), None)
    span = detect_span(frames, parse_silences(proc.stderr))
    if not span.detected:
        log.info("podcast radio: no speech bounds detected for %s — kept untrimmed", out.name)
    return _Decoded(out, frames, span, parse_ebur128_integrated(proc.stderr))


def _render_logo(kind: str, work: Path) -> Optional[Path]:
    try:
        return podcast_jingle.render_jingle(kind, work / f"logo_{kind}.wav")
    except Exception:  # noqa: BLE001 — the programme still works without the logo
        log.warning("podcast radio: %s logo unavailable — mixing without it", kind, exc_info=True)
        return None


def _measure_integrated(path: Path, *, max_sec: Optional[float] = None) -> Optional[float]:
    args = ["-t", f"{max_sec:g}"] if max_sec else []
    proc = _ffmpeg([*args, "-i", str(path), "-af", "ebur128=framelog=verbose", "-f", "null", "-"],
                   loglevel="info", check=False)
    return parse_ebur128_integrated(proc.stderr) if proc.returncode == 0 else None


_LOGO_LOUDNESS: dict[tuple[str, int], Optional[float]] = {}


def _logo_gain(kind: str, path: Path, voice_lufs: Optional[float]) -> float:
    """Gain putting the logo ``JINGLE_UNDER_SPEECH_LU`` under the voices."""
    key = (kind, podcast_jingle.JINGLE_VERSION)
    if key not in _LOGO_LOUDNESS:     # deterministic render: measure once per process
        _LOGO_LOUDNESS[key] = _measure_integrated(path)
    logo = _LOGO_LOUDNESS[key]
    if voice_lufs is None or logo is None:
        return JINGLE_DEFAULT_GAIN_DB
    low, high = JINGLE_GAIN_RANGE_DB
    return max(low, min(high, (voice_lufs - JINGLE_UNDER_SPEECH_LU) - logo))


def _bed_spec(music: Path, voice_lufs: Optional[float]) -> BedSpec:
    bed_lufs = _measure_integrated(music, max_sec=60)
    if voice_lufs is None or bed_lufs is None:
        return BedSpec(gain_db=BED_DEFAULT_GAIN_DB, level_sc=1.0)
    gain = max(-40.0, min(10.0, (voice_lufs - BED_UNDER_SPEECH_LU) - bed_lufs))
    level_sc = max(0.015625, min(64.0, 10 ** ((SIDECHAIN_REF_LUFS - voice_lufs) / 20)))
    return BedSpec(gain_db=gain, level_sc=level_sc)


def _build_program(out: Path, voice_wav: Path, layout: ProgramLayout, intro_wav: Optional[Path],
                   outro_wav: Optional[Path], logo_gains: Mapping[str, float], bed: Optional[BedSpec],
                   music: Optional[Path], pre_gain: Optional[float]) -> None:
    seconds = layout.total / SAMPLE_RATE + 0.05
    args = ["-f", "lavfi", "-t", f"{seconds:.3f}", "-i", f"anullsrc=r={SAMPLE_RATE}:cl=stereo",
            "-i", str(voice_wav)]
    if intro_wav:
        args += ["-i", str(intro_wav)]
    if outro_wav:
        args += ["-i", str(outro_wav)]
    if bed is not None and music is not None:
        args += ["-stream_loop", "-1", "-i", str(music)]
    graph = program_graph(
        layout,
        intro_gain_db=logo_gains.get("intro") if intro_wav else None,
        outro_gain_db=logo_gains.get("outro") if outro_wav else None,
        bed=bed if music is not None else None,
        pre_gain_db=pre_gain,
    )
    _ffmpeg([*args, "-filter_complex", graph, "-map", "[out]",
             "-c:a", "pcm_f32le", "-ar", str(SAMPLE_RATE), "-f", "wav", str(out)])


def _make_cover(title: str, hosts: Sequence[PodcastHost], path: Path,
                avatar_images: Optional[dict[str, Path]], warnings: Optional[list[str]]) -> Path:
    try:
        from services import podcast_cover

        return podcast_cover.make_cover(title, hosts, path, avatar_images=avatar_images, warnings=warnings)
    except Exception:  # noqa: BLE001 — never fail the mix because of the cover
        log.warning("podcast radio: cover art failed — plain card", exc_info=True)
        if warnings is not None:
            add_warning(warnings, WARNING_COVER_FALLBACK)
        _ffmpeg(["-f", "lavfi", "-i", "color=c=0x0B1220:s=1400x1400", "-frames:v", "1",
                 "-q:v", "3", str(path)])
        return path


def _measure_loudnorm(path: Path) -> Optional[LoudnormStats]:
    proc = _ffmpeg(["-i", str(path), "-af", f"{loudnorm_filter(None)}", "-f", "null", "-"],
                   loglevel="info", check=False)
    if proc.returncode != 0:
        return None
    return loudnorm_stats(parse_loudnorm_json(proc.stderr))


def _normalize_and_encode(program: Path, cover: Optional[Path], mp3: Path,
                          metadata: Mapping[str, str], work: Path) -> str:
    """Two-pass loudnorm + MP3 encode; returns the normalisation type used."""
    source = program
    stats = _measure_loudnorm(program)
    if stats is not None and not linear_feasible(stats) and stats.lra <= TARGET_LRA:
        # Peaks too high for a linear gain: limit a copy and measure again. Limiting
        # lowers the loudness when peaks carry much of the energy, and sharp
        # transients overshoot the sample-peak ceiling between samples: each
        # round re-levels and lowers the ceiling by the measured overshoot.
        gain, ceiling = PRE_LEVEL_LUFS - stats.i, LIMITER_CEILING_DBFS
        for attempt in range(LIMITER_ROUNDS):
            limited = work / f"program_limited_{attempt}.wav"
            _ffmpeg(["-i", str(program), "-af", limiter_chain(gain, ceiling),
                     "-c:a", "pcm_f32le", "-f", "wav", str(limited)])
            limited_stats = _measure_loudnorm(limited)
            if limited_stats is None:
                limited.unlink(missing_ok=True)
                break
            if source != program:
                source.unlink(missing_ok=True)
            source, stats = limited, limited_stats
            if linear_feasible(stats) or stats.lra > TARGET_LRA:
                break
            gain += PRE_LEVEL_LUFS - stats.i
            ceiling -= max(0.0, stats.tp - ceiling) + 0.2
    if stats is None:
        log.info("podcast radio: loudness measurement unusable — single-pass loudnorm")
    audio_filter = f"{loudnorm_filter(stats)},aresample={MP3_SAMPLE_RATE}"
    tmp = mp3.with_name(f".{mp3.stem}.{uuid.uuid4().hex}.tmp.mp3")
    try:
        try:
            proc = _ffmpeg(mp3_encode_args(source, cover, tmp, audio_filter, metadata), loglevel="info")
        except RuntimeError:
            if cover is None:
                raise
            log.warning("podcast radio: cover not embeddable — MP3 without APIC")
            proc = _ffmpeg(mp3_encode_args(source, None, tmp, audio_filter, metadata), loglevel="info")
        os.replace(tmp, mp3)
    finally:
        tmp.unlink(missing_ok=True)
    result = parse_loudnorm_json(proc.stderr) or {}
    normalization = result.get("normalization_type") or ("linear" if stats else "dynamic")
    if normalization != "linear":
        log.warning("podcast radio: loudnorm ran in %s mode (linear unreachable)", normalization)
    return normalization


def _decode_pcm(path: Path, rate: int) -> np.ndarray:
    """Mono s16 samples of ``path`` at ``rate`` Hz."""
    cmd = ["ffmpeg", "-hide_banner", "-nostdin", "-nostats", "-loglevel", "error", "-i", str(path),
           "-map", "0:a:0", "-ac", "1", "-ar", str(rate), "-c:a", "pcm_s16le", "-f", "s16le", "-"]
    proc = subprocess.run(cmd, capture_output=True, timeout=FFMPEG_TIMEOUT_SEC)
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg decode failed: {proc.stderr.decode('utf-8', 'replace')[-300:]}")
    return np.frombuffer(proc.stdout, dtype="<i2")


def wav_frames(path: Path) -> int:
    """Sample frames of a RIFF/WAVE file (from its ``data`` chunk)."""
    with open(path, "rb") as fh:
        header = fh.read(12)
        if len(header) < 12 or header[:4] != b"RIFF" or header[8:12] != b"WAVE":
            raise ValueError("not a RIFF/WAVE file")
        block_align = 0
        while True:
            chunk = fh.read(8)
            if len(chunk) < 8:
                raise ValueError("WAV data chunk missing")
            chunk_id, size = chunk[:4], struct.unpack("<I", chunk[4:])[0]
            if chunk_id == b"fmt ":
                fmt = fh.read(size)
                block_align = struct.unpack("<H", fmt[12:14])[0]
                if size % 2:
                    fh.seek(1, 1)
            elif chunk_id == b"data":
                if not block_align:
                    raise ValueError("WAV fmt chunk missing")
                if size in (0, 0xFFFFFFFF):
                    size = Path(path).stat().st_size - fh.tell()
                return size // block_align
            else:
                fh.seek(size + size % 2, 1)


def _write_text(path: Path, text: str) -> None:
    tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        tmp.write_text(text, encoding="utf-8")
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def _ffmpeg(args: Sequence[str], *, loglevel: str = "error", check: bool = True) -> subprocess.CompletedProcess:
    cmd = ["ffmpeg", "-hide_banner", "-nostdin", "-nostats", "-y", "-loglevel", loglevel, *args]
    log.debug("$ %s", " ".join(cmd))
    proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace",
                          timeout=FFMPEG_TIMEOUT_SEC)
    if check and proc.returncode != 0:
        log.error("podcast radio: ffmpeg failed (%d): %s", proc.returncode, proc.stderr[-1500:])
        raise RuntimeError(f"ffmpeg failed: {proc.stderr[-300:]}")
    return proc


def _require_tool(name: str) -> None:
    if shutil.which(name) is None:
        raise RuntimeError(f"required tool missing on PATH: {name}")


__all__ = [
    "ALBUM",
    "ALBUM_ARTIST",
    "GENRE",
    "ID3_COMMENT",
    "ID3_KEYS",
    "ISO_639_2",
    "LoudnormStats",
    "PAN",
    "PlacedReaction",
    "ProgramLayout",
    "TURN_LEVEL_LUFS",
    "TurnSlot",
    "TurnSpan",
    "build_transcript",
    "combined_loudness",
    "compute_peaks",
    "detect_span",
    "id3_metadata",
    "iso639_2",
    "level_gains",
    "linear_feasible",
    "loudnorm_filter",
    "loudnorm_stats",
    "map_reactions",
    "mix_radio",
    "mp3_encode_args",
    "ordered_hosts",
    "pan_gains",
    "parse_ebur128_integrated",
    "parse_loudnorm_json",
    "parse_silences",
    "plan_program",
    "plan_timeline",
    "program_graph",
    "reaction_mix_start",
    "speech_bounds",
    "speech_cues",
    "srt_text",
    "turn_gaps",
    "voice_bus_graph",
    "voice_gains",
    "wav_frames",
]
