"""Listener backchannels ("Mm-hmm.", "Right.", "Exactly.") for podcast renders.

Two pure steps, both driven by the stable reaction ids of
``podcast_models.ReactionId`` (the spoken text is resolved server-side with
``podcast_media.reaction_text``):

1. :func:`plan_reactions` runs on the script text **before** synthesis. It
   picks the turns that get a backchannel, the sentence it follows and the
   pause the speaker leaves for it (``podcast_media.reaction_pause_ms``). The
   router calls it with ``enabled=podcast_media.effective_reactions(request.reactions)``
   (the request AND the ``PODCAST_REACTIONS`` kill switch) and turns the plan
   into SSML breaks with ``podcast_media.planned_pauses``.
2. :func:`place_reactions` runs **after** synthesis, once per rendition (avatar
   clips for the video, TTS turns for the radio mix). It finds each inserted
   pause with ffmpeg ``silencedetect`` and drops the listener's measured clip
   inside it. A reaction that does not fit is skipped: it never overlaps
   speech and is never stretched or truncated. :func:`note_skipped` raises
   the ``reactions_skipped`` warning code.

Sentences are counted with :func:`split_sentences`, i.e. the splitter
``build_ssml``'s pause option uses (``avatar.split_sentences_for_pauses``,
CJK-aware; ``avatar._split_sentences`` on builds without it), so
``after_sentence`` always points at a real break.
"""
from __future__ import annotations

import logging
import random
import re
import subprocess
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Mapping, Optional, Sequence, cast

from services import avatar
from services.podcast_media import (
    REACTION_IDS,
    REACTION_MARGIN_SEC,
    WARNING_REACTIONS_SKIPPED,
    PlannedReaction,
    ReactionClip,
    ReactionPlacement,
    add_warning,
    reaction_pause_ms,
)
from services.podcast_models import DialogueTurn, ReactionId, Speaker

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Planning (script text, before synthesis)
# ---------------------------------------------------------------------------

# Neutral fallbacks for turns without a usable hint; "exactly" and
# "interesting" carry meaning, so only the script may ask for them.
NEUTRAL_REACTION_IDS: tuple[str, ...] = ("ack", "right", "yeah", "isee")

MIN_SENTENCES = 2            # the speaker must go on after the reaction
MIN_WORDS = 12               # word-equivalents (CJK counted by characters)
MIN_GAP_SEC = 20.0           # estimated distance between two reactions
MAX_PER_EPISODE = 6
NEUTRAL_RATE = 0.5           # share of eligible, unhinted turns that get a neutral reaction

# Speaking-rate estimate (spike S2: Latin voices 2.4-3.3 words/s, zh-CN 5.6-6.0 and
# ja-JP 5.0-5.4 characters/s).
WORDS_PER_SEC = 2.6
CJK_CHARS_PER_SEC = 5.0
SSML_LEAD_SEC = 0.25         # build_ssml's leading break
TURN_GAP_SEC = 0.25          # typical gap between two turns

_OTHER_ROLE: dict[str, Speaker] = {"interviewer": "expert", "expert": "interviewer"}
_CJK_RE = re.compile("[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f]")
_WORD_RE = re.compile(r"[^\W_]+(?:['\u2019\-][^\W_]+)*")


def split_sentences(text: str) -> list[str]:
    """Sentences exactly as ``build_ssml``'s pause option counts them (resolved per call)."""
    splitter = getattr(avatar, "split_sentences_for_pauses", None) or avatar._split_sentences
    return list(splitter(text or ""))


def estimate_speech_sec(text: str) -> float:
    """Rough speaking time of ``text``: words at 2.6/s, CJK characters at 5/s."""
    text = text or ""
    cjk = len(_CJK_RE.findall(text))
    words = len(_WORD_RE.findall(_CJK_RE.sub(" ", text)))
    return words / WORDS_PER_SEC + cjk / CJK_CHARS_PER_SEC


def word_count(text: str) -> float:
    """Word-equivalents of ``text`` (CJK characters converted through the speaking rate)."""
    return estimate_speech_sec(text) * WORDS_PER_SEC


def _listener(speaker: str) -> Speaker:
    return _OTHER_ROLE.get(speaker, "interviewer")


@dataclass(frozen=True)
class _TurnInfo:
    pos: int
    turn: DialogueTurn
    sentences: tuple[str, ...]
    start_sec: float
    eligible: bool
    # Seeded draws, made for every turn so one decision never shifts another.
    take_draw: float
    id_draw: float
    sentence_draw: float

    def reaction_sec(self, after_sentence: int) -> float:
        spoken = " ".join(self.sentences[:after_sentence])
        return self.start_sec + SSML_LEAD_SEC + estimate_speech_sec(spoken)


def _turn_infos(ordered: Sequence[DialogueTurn], rng: random.Random) -> list[_TurnInfo]:
    infos: list[_TurnInfo] = []
    clock = 0.0
    last = len(ordered) - 1
    for pos, turn in enumerate(ordered):
        text = turn.text or ""
        sentences = tuple(split_sentences(text))
        eligible = (0 < pos < last and len(sentences) >= MIN_SENTENCES
                    and word_count(text) >= MIN_WORDS)
        infos.append(_TurnInfo(pos=pos, turn=turn, sentences=sentences, start_sec=clock,
                               eligible=eligible, take_draw=rng.random(), id_draw=rng.random(),
                               sentence_draw=rng.random()))
        clock += SSML_LEAD_SEC + estimate_speech_sec(text) + TURN_GAP_SEC
    return infos


def _valid_hint(info: _TurnInfo) -> Optional[tuple[str, int]]:
    hint = info.turn.reaction
    if hint is None:
        return None
    reaction_id = getattr(hint, "reaction_id", None)
    after = getattr(hint, "after_sentence", None)
    if reaction_id not in REACTION_IDS or isinstance(after, bool) or not isinstance(after, int):
        return None
    if not 1 <= after < len(info.sentences):
        return None
    return reaction_id, after


def _neutral_sentence(info: _TurnInfo) -> int:
    """A sentence boundary inside the turn, preferring ones after >= ~3 s of speech."""
    choices = list(range(1, len(info.sentences)))
    substantial = [k for k in choices
                   if estimate_speech_sec(" ".join(info.sentences[:k])) >= 3.0] or choices
    return substantial[min(int(info.sentence_draw * len(substantial)), len(substantial) - 1)]


def _neutral_id(info: _TurnInfo, previous: Optional[str]) -> str:
    pool = [rid for rid in NEUTRAL_REACTION_IDS if rid != previous] or list(NEUTRAL_REACTION_IDS)
    return pool[min(int(info.id_draw * len(pool)), len(pool) - 1)]


def plan_reactions(turns: Sequence[DialogueTurn], language: str, seed: str,
                   enabled: bool) -> list[PlannedReaction]:
    """Plan the episode's backchannels on the script text, before synthesis.

    ``enabled`` is ``podcast_media.effective_reactions(request.reactions)``;
    ``seed`` is the job id (same script + seed = same plan). Valid script hints
    (known id, ``1 <= after_sentence < sentences``) are honoured first; other
    eligible turns get a seeded neutral reaction (ack/right/yeah/isee) about
    half of the time. Every reaction obeys the density rules: never on the
    first or last turn, only on turns with >= 2 sentences and >= ~12 words, at
    most one per turn, never on consecutive turns, >= 20 s apart (estimated)
    and at most 6 per episode. Sorted by ``turn_idx``.
    """
    if not enabled or len(turns) < 3:
        return []
    ordered = sorted(turns, key=lambda t: t.idx)
    infos = _turn_infos(ordered, random.Random(f"podcast-reactions:{seed}"))
    chosen: dict[int, tuple[_TurnInfo, str, int, float]] = {}

    def fits(pos: int, at_sec: float) -> bool:
        if len(chosen) >= MAX_PER_EPISODE:
            return False
        return all(abs(other - pos) > 1 and abs(when - at_sec) >= MIN_GAP_SEC
                   for other, (_, _, _, when) in chosen.items())

    hinted = 0
    for info in infos:
        hint = _valid_hint(info) if info.eligible else None
        if hint is None:
            continue
        reaction_id, after = hint
        at_sec = info.reaction_sec(after)
        if fits(info.pos, at_sec):
            chosen[info.pos] = (info, reaction_id, after, at_sec)
            hinted += 1

    for info in infos:
        if not info.eligible or info.pos in chosen or info.take_draw >= NEUTRAL_RATE:
            continue
        after = _neutral_sentence(info)
        at_sec = info.reaction_sec(after)
        if not fits(info.pos, at_sec):
            continue
        before = [p for p in chosen if p < info.pos]
        previous = chosen[max(before)][1] if before else None
        chosen[info.pos] = (info, _neutral_id(info, previous), after, at_sec)

    planned = [
        PlannedReaction(turn_idx=info.turn.idx, listener=_listener(info.turn.speaker),
                        reaction_id=cast(ReactionId, reaction_id), after_sentence=after,
                        pause_ms=reaction_pause_ms(language, reaction_id))
        for info, reaction_id, after, _ in (chosen[pos] for pos in sorted(chosen))
    ]
    log.info("reactions: planned %d (%d from script hints) over %d turns",
             len(planned), hinted, len(ordered))
    return planned


def needed_reaction_ids(planned: Iterable[PlannedReaction]) -> dict[str, list[str]]:
    """Reaction ids each listener role must be able to say, in stable id order."""
    wanted: dict[str, set[str]] = {}
    for p in planned:
        wanted.setdefault(p.listener, set()).add(p.reaction_id)
    return {role: [rid for rid in REACTION_IDS if rid in ids] for role, ids in wanted.items()}


# ---------------------------------------------------------------------------
# Placement (synthesized audio, after synthesis)
# ---------------------------------------------------------------------------

SILENCE_NOISE_DB = -40.0
SILENCE_MIN_SEC = 0.20
# A mid-turn break renders as the break + 0.26-0.47 s of the voice's own boundary
# silence (spike S2, speech-foundation check). "Strong" candidates show that extra
# silence; "weak" ones only last >= 70 % of the break and win only when clearly
# closer to the expected spot.
PAUSE_MATCH_RATIO = 0.7
PAUSE_EXTRA_SEC = 0.10
WEAK_PAUSE_PENALTY_SEC = 1.0
DEFAULT_MARGIN_SEC = REACTION_MARGIN_SEC
REACTION_GAIN_DB = -4.0
_LEAD_EPS_SEC = 0.02         # a silence starting this close to 0 is the leading silence
_TAIL_EPS_SEC = 0.10         # container durations can exceed the audio track (MP4 video)
_FFMPEG_TIMEOUT_SEC = 120

_NUM = r"(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)"
_SIL_START_RE = re.compile(r"silence_start:\s*" + _NUM)
_SIL_END_RE = re.compile(r"silence_end:\s*" + _NUM)
_DURATION_RE = re.compile(r"Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)")


@dataclass(frozen=True)
class SilenceMap:
    """Silences of one turn's audio (seconds from the start of the file)."""
    duration_sec: float
    silences: tuple[tuple[float, float], ...]
    speech_start: float
    speech_end: float

    @property
    def internal(self) -> tuple[tuple[float, float], ...]:
        """Silences between the first and the last speech (leading/trailing ones excluded)."""
        return tuple((s, e) for s, e in self.silences
                     if s > self.speech_start + 1e-6 and e < self.speech_end - 1e-6)


def _parse_silencedetect(stderr: str) -> tuple[Optional[float], list[tuple[float, Optional[float]]]]:
    duration: Optional[float] = None
    raw: list[tuple[float, Optional[float]]] = []
    start: Optional[float] = None
    for line in stderr.splitlines():
        if duration is None:
            m = _DURATION_RE.search(line)
            if m:
                h, mnt, sec = m.groups()
                duration = int(h) * 3600 + int(mnt) * 60 + float(sec)
        m = _SIL_START_RE.search(line)
        if m:
            start = max(0.0, float(m.group(1)))
            continue
        m = _SIL_END_RE.search(line)
        if m and start is not None:
            raw.append((start, max(start, float(m.group(1)))))
            start = None
    if start is not None:
        raw.append((start, None))  # silence running to the end of the file
    return duration, raw


def detect_silences(path: Path, *, noise_db: float = SILENCE_NOISE_DB,
                    min_silence_sec: float = SILENCE_MIN_SEC) -> Optional[SilenceMap]:
    """``silencedetect`` on the first audio stream of ``path`` (WAV, MP4, WebM).

    Returns None when ffmpeg is missing or the file has no decodable audio.
    """
    cmd = ["ffmpeg", "-hide_banner", "-nostats", "-i", str(path), "-map", "0:a:0",
           "-af", f"silencedetect=noise={noise_db}dB:d={min_silence_sec}", "-f", "null", "-"]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8",
                              errors="replace", timeout=_FFMPEG_TIMEOUT_SEC)
    except (OSError, subprocess.SubprocessError):
        return None
    if proc.returncode != 0:
        return None
    duration, raw = _parse_silencedetect(proc.stderr or "")
    ends = [e for _, e in raw if e is not None]
    if duration is None or duration <= 0:
        duration = max(ends, default=0.0)
    # (start, end, runs_to_eof); zero-length entries dropped.
    spans = [(s, duration if e is None else min(e, duration), e is None) for s, e in raw]
    spans = [(s, e, open_end) for s, e, open_end in spans if e > s]
    silences = tuple((s, e) for s, e, _ in spans)
    speech_start, speech_end = 0.0, duration
    if spans and spans[0][0] <= _LEAD_EPS_SEC:
        speech_start = spans[0][1]
    if spans and (spans[-1][2] or spans[-1][1] >= duration - _TAIL_EPS_SEC):
        speech_end = spans[-1][0]
    if speech_end <= speech_start:
        return SilenceMap(duration, silences, speech_start, speech_start)
    return SilenceMap(duration, silences, speech_start, speech_end)


def _expected_pause_start(smap: SilenceMap, reaction: PlannedReaction, text: Optional[str],
                          earlier_pause_sec: float, turn_pause_sec: float) -> Optional[float]:
    """Where sentence ``after_sentence`` should end, by cumulative character share."""
    if not text:
        return None
    sentences = split_sentences(text)
    if not 1 <= reaction.after_sentence < len(sentences):
        return None
    weights = [len(re.sub(r"\s+", "", s)) for s in sentences]
    total = sum(weights)
    if total <= 0:
        return None
    share = sum(weights[:reaction.after_sentence]) / total
    spoken = max(0.0, smap.speech_end - smap.speech_start - turn_pause_sec)
    return smap.speech_start + share * spoken + earlier_pause_sec


def _pick_pause(candidates: list[tuple[float, float]], expected: Optional[float],
                strong_len: float) -> Optional[tuple[float, float]]:
    """Nearest candidate to ``expected`` (weak ones penalised); longest without an estimate."""
    if not candidates:
        return None
    if expected is None:
        return max(candidates, key=lambda c: (c[1] - c[0], -c[0]))

    def distance(c: tuple[float, float]) -> float:
        weak = c[1] - c[0] < strong_len
        return abs(c[0] - expected) + (WEAK_PAUSE_PENALTY_SEC if weak else 0.0)

    return min(candidates, key=lambda c: (distance(c), -(c[1] - c[0])))


def place_reactions(planned: Sequence[PlannedReaction], turn_audio: Mapping[int, Path],
                    clips: Mapping[str, Mapping[str, ReactionClip]], *,
                    texts: Optional[Mapping[int, str]] = None,
                    pre_margin: float = DEFAULT_MARGIN_SEC,
                    post_margin: float = DEFAULT_MARGIN_SEC) -> list[ReactionPlacement]:
    """Place planned reactions inside the pauses measured in one rendition's audio.

    ``turn_audio`` maps ``turn_idx`` to that turn's untrimmed audio (TTS WAV or
    avatar MP4/WebM); ``clips`` maps listener role -> reaction id -> measured
    clip. ``texts`` (``turn_idx`` -> turn text) locates the expected break by
    character share — pass it: natural sentence pauses can be as long as the
    inserted one (French), and without it the longest pause is assumed.

    For each reaction: candidates are internal silences (noise -40 dB, >= 0.2 s)
    lasting >= 70 % of ``pause_ms``; the one nearest to the expected break wins
    (a candidate shorter than ``pause_ms`` + 0.1 s counts 1 s farther). The clip
    is placed at ``silence_start + pre_margin`` only when
    ``silence >= pre_margin + clip + post_margin``; otherwise (or with no clip,
    audio or pause) the reaction is skipped. Never raises for media problems.
    Returns placements sorted by ``(turn_idx, at_sec)``.
    """
    texts = texts or {}
    maps: dict[Path, Optional[SilenceMap]] = {}
    used: dict[int, list[tuple[float, float]]] = {}
    turn_pause: Counter[int] = Counter()
    for p in planned:
        turn_pause[p.turn_idx] += max(0, p.pause_ms)
    placements: list[ReactionPlacement] = []
    reasons: Counter[str] = Counter()
    for p in sorted(planned, key=lambda r: (r.turn_idx, r.after_sentence)):
        clip = (clips.get(p.listener) or {}).get(p.reaction_id)
        if clip is None or not clip.duration_sec > 0:
            reasons["no_clip"] += 1
            continue
        path = turn_audio.get(p.turn_idx)
        if path is None:
            reasons["no_audio"] += 1
            continue
        path = Path(path)
        if path not in maps:
            maps[path] = detect_silences(path) if path.is_file() else None
        smap = maps[path]
        if smap is None:
            reasons["no_audio"] += 1
            continue
        taken = used.setdefault(p.turn_idx, [])
        pause_sec = p.pause_ms / 1000.0
        candidates = [c for c in smap.internal
                      if c[1] - c[0] >= PAUSE_MATCH_RATIO * pause_sec and c not in taken]
        earlier = sum(q.pause_ms for q in planned
                      if q.turn_idx == p.turn_idx and q.after_sentence < p.after_sentence) / 1000.0
        expected = _expected_pause_start(smap, p, texts.get(p.turn_idx), earlier,
                                         turn_pause[p.turn_idx] / 1000.0)
        pause = _pick_pause(candidates, expected, pause_sec + PAUSE_EXTRA_SEC)
        if pause is None:
            reasons["no_pause"] += 1
            continue
        start, end = pause
        if end - start + 1e-9 < pre_margin + clip.duration_sec + post_margin:
            reasons["too_short"] += 1
            continue
        taken.append(pause)
        placements.append(ReactionPlacement(
            turn_idx=p.turn_idx, listener=p.listener, reaction_id=p.reaction_id,
            at_sec=round(start + pre_margin, 3), duration_sec=clip.duration_sec,
            gain_db=REACTION_GAIN_DB))
    if reasons:
        log.info("reactions: placed %d of %d (skipped: %s)", len(placements), len(planned),
                 ", ".join(f"{k}={v}" for k, v in sorted(reasons.items())))
    return sorted(placements, key=lambda r: (r.turn_idx, r.at_sec))


def count_skipped(planned: Iterable[PlannedReaction], placements: Iterable[ReactionPlacement]) -> int:
    """Planned reactions that ``place_reactions`` did not place."""
    placed = Counter((r.turn_idx, r.listener, r.reaction_id) for r in placements)
    skipped = 0
    for p in planned:
        key = (p.turn_idx, p.listener, p.reaction_id)
        if placed[key] > 0:
            placed[key] -= 1
        else:
            skipped += 1
    return skipped


def note_skipped(warnings: list[str], planned: Iterable[PlannedReaction],
                 placements: Iterable[ReactionPlacement]) -> int:
    """Add ``reactions_skipped`` to ``warnings`` when any planned reaction was not placed."""
    skipped = count_skipped(planned, placements)
    if skipped:
        add_warning(warnings, WARNING_REACTIONS_SKIPPED)
    return skipped


__all__ = [
    "CJK_CHARS_PER_SEC",
    "DEFAULT_MARGIN_SEC",
    "MAX_PER_EPISODE",
    "MIN_GAP_SEC",
    "MIN_SENTENCES",
    "MIN_WORDS",
    "NEUTRAL_REACTION_IDS",
    "REACTION_GAIN_DB",
    "SilenceMap",
    "WORDS_PER_SEC",
    "count_skipped",
    "detect_silences",
    "estimate_speech_sec",
    "needed_reaction_ids",
    "note_skipped",
    "place_reactions",
    "plan_reactions",
    "word_count",
]
