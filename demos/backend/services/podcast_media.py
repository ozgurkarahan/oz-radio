"""Shared internal contracts of the podcast render engines (radio + live listener).

Plain dataclasses, constants and env-flag helpers exchanged between the
speech, listener, reactions, radio, compose, library and router units. No
heavy imports: stdlib + ``services.podcast_models`` only. HTTP/JSON shapes
(``RenderRequest``, ``JobOutputs``, ``Transcript``, library DTOs) live in
``services.podcast_models``.

Conventions
-----------
* Times are seconds (float) unless the name ends in ``_ms``.
* Roles are ``"interviewer"`` / ``"expert"`` (``podcast_models.Speaker``); the
  *listener* of a turn is the role that is not speaking it.
* ``after_sentence`` is 1-based and counted with ``avatar.split_sentences_for_pauses``
  (CJK-aware; the splitter ``build_ssml`` uses for pauses); "pauses" are
  ``{turn_idx: {after_sentence: pause_ms}}`` (see ``planned_pauses``).
* ``deadline`` is an absolute ``time.monotonic()`` timestamp; ``None`` = none.
* Reaction clips are keyed by listener role, then reaction id:
  ``dict[str, dict[str, ReactionClip]]``.
* Warnings are stable codes from ``WARNING_CODES`` — never raw exception text,
  voice/character names or file paths.
* Speech character names must never appear in file/blob names, sidecars,
  logs, warnings, ID3 tags or public payloads.

Engine contracts
----------------
Signatures the other units implement (documentation only — call the real modules)::

    # services/avatar.py (additive, backward compatible)
    build_ssml(..., pause_after_sentence: dict[int, int] | None = None) -> str
        # {after_sentence (1-based): pause_ms} -> <break time="{ms}ms"/> after that sentence.

    # services/podcast_render.py (existing behaviour when the new kwargs are omitted)
    render_podcast(cfg, script, roles, progress_cb=None, language="en-US", ..., *,
                   pauses: dict[int, dict[int, int]] | None = None,
                   deadline: float | None = None) -> list[ClipManifest]
        # Video mode: TurnAudio(turn_idx, speaker, Path(clip.blob_url), "avatar", clip.duration_sec).

    # services/podcast_tts.py — audio-only mode, zero avatar calls
    synthesize_turns(cfg, script, roles, work_dir, *,
                     pauses: dict[int, dict[int, int]] | None = None,
                     progress_cb=None, deadline: float | None = None) -> list[TurnAudio]
        # One TTS REST call per turn (WAV PCM, same voices + build_ssml), sorted by
        # turn_idx, source="tts"; progress_cb(turns_done: int); raises TimeoutError
        # past the deadline.
    synthesize_reaction_audio(cfg, voice, language, reaction_ids, cache_dir, *,
                              deadline: float | None = None) -> dict[str, ReactionClip]
        # Audio-only clips (video_path=None) with reaction_text(language, id),
        # trimmed to the speech span (click-robust, re-takes when over
        # reaction_clip_budget_sec), cached under hash-only names; failed ids omitted.

    # services/podcast_listener.py — never raises
    resolve_listener_kits(cfg, roles, language, *, want_reactions: bool,
                          deadline: float) -> dict[str, ListenerKit]
        # Keys "interviewer"/"expert". Honours listener_mode() and the deadline;
        # any failure -> fallback kit ("procedural"/"still") + warning codes.

    # services/podcast_reactions.py
    plan_reactions(turns: list[DialogueTurn], language: str, seed: str,
                   enabled: bool) -> list[PlannedReaction]
        # On the script text, before synthesis; [] when not enabled.
    place_reactions(planned: list[PlannedReaction], turn_audio: dict[int, Path],
                    clips: dict[str, dict[str, ReactionClip]], *,
                    texts: dict[int, str] | None = None, pre_margin=0.06,
                    post_margin=0.06) -> list[ReactionPlacement]
        # After synthesis, once per rendition; reactions that do not fit their
        # pause are omitted (count_skipped / note_skipped report them).

    # services/podcast_jingle.py
    render_jingle(kind: Literal["intro", "outro"], path: Path) -> Path

    # services/podcast_radio.py — raises on failure (caller: soundtrack fallback
    # + WARNING_RADIO_FALLBACK)
    mix_radio(turn_audio: list[TurnAudio], placements: list[ReactionPlacement],
              clips: dict[str, dict[str, ReactionClip]], script, roles,
              hosts: list[PodcastHost], *, title: str, language: str, out_dir: Path,
              intro: bool, seed: str,
              video_offsets: dict[int, tuple[float, float]] | None = None,
              music_path: Path | None = None,
              avatar_images: dict[str, Path] | None = None,
              warnings: list[str] | None = None) -> RadioResult
        # video_offsets = ComposeTimeline.turn_video_offsets (fills
        # TranscriptTurn.video_start/video_end); avatar_images keyed by role.

    # services/podcast_cover.py
    make_cover(title: str, hosts: list[PodcastHost], out_path: Path, *,
               avatar_images: dict[str, Path] | None = None,
               warnings: list[str] | None = None) -> Path

    # services/podcast_compose.py (existing positional arguments unchanged)
    compose_podcast(clips, document, script, roles, out_dir, music=True, intro=True,
                    music_path=None, layout=DEFAULT_LAYOUT, *,
                    listener_kits: dict[str, ListenerKit] | None = None,
                    reactions: list[ReactionPlacement] | None = None,
                    reaction_clips: dict[str, dict[str, ReactionClip]] | None = None,
                    seed: str = "") -> ComposeResult
        # ComposeResult(mp4, mp3, srt, timeline: ComposeTimeline | None = None).

    # services/podcast_library.py (format = files.format; durations are probed)
    PodcastLibrary.publish(job_id, files: LibraryFiles, *, title, document_title,
                           language, style, speaker_names, turn_count, created_at,
                           audience_level=None, hosts: list[PodcastHost] | None = None,
                           audio_kind: AudioKind = "radio_mix",
                           listener_mode: str | None = None) -> dict | None
"""
from __future__ import annotations

import math
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Literal, Optional, cast, get_args

from services.podcast_models import (
    AudioKind,
    PodcastFormat,
    ReactionId,
    Speaker,
    Transcript,
)

# -----------------------------------------------------------------------------
# Listener modes
# -----------------------------------------------------------------------------

# Rendered modes, highest fidelity first.
ListenerMode = Literal["idle_loop", "procedural", "still"]
# PODCAST_LISTENER_MODE values ("auto" = best available).
ListenerModeSetting = Literal["auto", "idle_loop", "procedural", "still"]
LISTENER_MODES: tuple[str, ...] = get_args(ListenerMode)
LISTENER_MODE_SETTINGS: tuple[str, ...] = get_args(ListenerModeSetting)


# -----------------------------------------------------------------------------
# Engine data types
# -----------------------------------------------------------------------------


@dataclass(frozen=True)
class TurnAudio:
    """Synthesized speech of one turn, untrimmed (the 250 ms SSML lead included).

    ``path`` is the downloaded talking clip for ``source="avatar"`` (its audio
    track; same timeline as the video segment) or a WAV PCM file for ``"tts"``.
    """
    turn_idx: int
    speaker: Speaker
    path: Path
    source: Literal["avatar", "tts"]
    duration_sec: float = 0.0


@dataclass(frozen=True)
class PlannedReaction:
    """Backchannel planned on the script text, before synthesis.

    ``listener`` says ``reaction_id`` after sentence ``after_sentence`` of turn
    ``turn_idx``; the speaker's SSML gets a ``pause_ms`` break there.
    """
    turn_idx: int
    listener: Speaker
    reaction_id: ReactionId
    after_sentence: int
    pause_ms: int


@dataclass(frozen=True)
class ReactionClip:
    """One synthesized backchannel phrase of a listener voice.

    ``duration_sec`` is measured: clips are never stretched or truncated.
    ``video_path`` is the lip-synced listener clip (video mode), else None.
    """
    reaction_id: ReactionId
    text: str
    audio_path: Path
    video_path: Optional[Path]
    duration_sec: float
    has_alpha: bool = False


@dataclass(frozen=True)
class IdleLoop:
    """Seamless silent "listening" loop of one avatar (video only)."""
    path: Path
    duration_sec: float
    has_alpha: bool
    # Per-frame signatures used to pick a loop offset matching the listener's pose.
    signature_path: Optional[Path]
    # Face-region motion (higher = livelier); ``static`` = below the frozen threshold.
    motion_score: float
    static: bool


@dataclass(frozen=True)
class ListenerKit:
    """Everything the compose step needs to animate one listener.

    ``mode`` is what will actually be rendered: ``idle`` is set only for
    ``"idle_loop"``; ``reactions`` may be empty (no backchannels for this host).
    """
    avatar_id: str
    voice: str
    mode: ListenerMode
    idle: Optional[IdleLoop]
    reactions: dict[str, ReactionClip]
    warnings: tuple[str, ...] = ()


@dataclass(frozen=True)
class ReactionPlacement:
    """A backchannel placed inside a speaker's measured pause.

    ``at_sec`` is relative to the start of turn ``turn_idx``'s ``TurnAudio``
    (untrimmed); the video and radio timelines each map it onto their own.
    """
    turn_idx: int
    listener: Speaker
    reaction_id: ReactionId
    at_sec: float
    duration_sec: float
    gain_db: float = -4.0


@dataclass
class RadioResult:
    """Radio deliverables (``audio.mp3``, radio-timed ``audio.srt``,
    ``transcript.json``, ``cover.jpg``)."""
    mp3: Path
    srt: Path
    transcript_path: Path
    transcript: Transcript
    cover: Path
    duration_sec: float
    audio_kind: AudioKind = "radio_mix"


@dataclass
class ComposeTimeline:
    """Video timeline facts the radio mix and library need."""
    # turn_idx -> (start, end) in final.mp4, title card included.
    turn_video_offsets: dict[int, tuple[float, float]]
    # Mode actually rendered; the lower-fidelity one when the two hosts differ.
    listener_mode: str
    duration_sec: float


@dataclass
class LibraryFiles:
    """Local paths of one render's deliverables for ``PodcastLibrary.publish`` (v2).

    Radio assets are always required; video assets only exist for ``format="video"``.
    """
    mp3: Path
    audio_srt: Path
    transcript: Path
    cover: Path
    mp4: Optional[Path] = None
    srt: Optional[Path] = None
    scorm: Optional[Path] = None

    @property
    def has_video(self) -> bool:
        return self.mp4 is not None

    @property
    def format(self) -> PodcastFormat:
        return "video" if self.mp4 is not None else "audio"


# -----------------------------------------------------------------------------
# Stable warning codes (PodcastJob.warnings, ListenerKit.warnings)
# -----------------------------------------------------------------------------

WARNING_LISTENER_FALLBACK = "listener_fallback"  # no idle loop: procedural/still listener
WARNING_LISTENER_STATIC = "listener_static"      # idle footage too static: procedural listener
WARNING_LISTENER_TIMEOUT = "listener_timeout"    # kit not ready within PODCAST_LISTENER_TIMEOUT_SEC
WARNING_REACTIONS_SKIPPED = "reactions_skipped"  # some planned backchannels were not placed
WARNING_RADIO_FALLBACK = "radio_fallback"        # radio mix failed: MP3 is the video soundtrack
WARNING_COVER_FALLBACK = "cover_fallback"        # cover art failed: plain fallback cover

WARNING_CODES: frozenset[str] = frozenset({
    WARNING_LISTENER_FALLBACK,
    WARNING_LISTENER_STATIC,
    WARNING_LISTENER_TIMEOUT,
    WARNING_REACTIONS_SKIPPED,
    WARNING_RADIO_FALLBACK,
    WARNING_COVER_FALLBACK,
})


def add_warning(warnings: list[str], code: str) -> None:
    """Append a stable warning code once; unknown codes raise ``ValueError``."""
    if code not in WARNING_CODES:
        raise ValueError("unknown podcast warning code")
    if code not in warnings:
        warnings.append(code)


# -----------------------------------------------------------------------------
# Backchannel phrases
# -----------------------------------------------------------------------------

REACTION_IDS: tuple[str, ...] = get_args(ReactionId)
DEFAULT_REACTION_LOCALE = "en-US"

# Short lexical acknowledgements, one per id and locale. Each phrase was
# synthesized with both DragonHD voices of its locale (2 takes each) and kept
# only when STT recognised it without a "?" and the pitch did not rise at the
# end (> 15 %); exceptions: the en-US "Mm-hmm." (canonical mm-HMM contour) and
# a pitch-accent false alarm on "Exactly.". en-US/fr-FR were also checked on
# the avatar kit (spike S1). Report: session files/spike-reactions.md.
REACTION_PHRASES: dict[str, dict[str, str]] = {
    "en-US": {"ack": "Mm-hmm.", "right": "Right.", "yeah": "Yeah.",
              "exactly": "Exactly.", "isee": "I see.", "interesting": "Interesting."},
    "fr-FR": {"ack": "Oui, oui.", "right": "Tout à fait.", "yeah": "Oui.",
              "exactly": "Exactement.", "isee": "Ah, je vois.", "interesting": "C'est intéressant."},
    "es-ES": {"ack": "Vale.", "right": "Cierto.", "yeah": "Sí.",
              "exactly": "Exacto.", "isee": "Ya veo.", "interesting": "Qué interesante."},
    "de-DE": {"ack": "Ah ja.", "right": "Stimmt.", "yeah": "Ja.",
              "exactly": "Genau.", "isee": "Verstehe.", "interesting": "Spannend."},
    "it-IT": {"ack": "D'accordo.", "right": "Giusto.", "yeah": "Già.",
              "exactly": "Esatto.", "isee": "Capisco.", "interesting": "Interessante."},
    "pt-BR": {"ack": "Sim, sim.", "right": "Pois é.", "yeah": "Sim.",
              "exactly": "Isso mesmo.", "isee": "Ah, entendi.", "interesting": "Interessante."},
    "zh-CN": {"ack": "好。", "right": "对。", "yeah": "是的。",
              "exactly": "没错。", "isee": "明白了。", "interesting": "有意思。"},
    "ja-JP": {"ack": "うんうん。", "right": "確かに。", "yeah": "そうそう。",
              "exactly": "まさに。", "isee": "なるほど。", "interesting": "面白いですね。"},
}

# Speaker pause (ms) planned after the sentence a reaction follows. One pause
# serves both renditions, so it is sized for the longer clip: TTS (longest
# measured speech span over both voices and 2 takes, + 2 x 30 ms trim) or
# avatar kit (S1 span + 2 x 60 ms, en-US/fr-FR). A mid-turn <break> renders as
# the break plus >= 0.25 s of the voice's own boundary silence, and a clip
# needs 60 ms of margin on each side: pause = clip + 2 x 60 - 250, rounded up
# to 10 ms, clamped to [350, 1200]. place_reactions still checks the silence
# actually measured and skips a clip that does not fit.
REACTION_PAUSE_MS: dict[str, dict[str, int]] = {
    "en-US": {"ack": 400, "right": 350, "yeah": 500, "exactly": 690, "isee": 540, "interesting": 720},
    "fr-FR": {"ack": 840, "right": 520, "yeah": 350, "exactly": 760, "isee": 730, "interesting": 610},
    "es-ES": {"ack": 360, "right": 510, "yeah": 350, "exactly": 690, "isee": 550, "interesting": 910},
    "de-DE": {"ack": 570, "right": 490, "yeah": 550, "exactly": 370, "isee": 580, "interesting": 670},
    "it-IT": {"ack": 640, "right": 430, "yeah": 350, "exactly": 570, "isee": 560, "interesting": 850},
    "pt-BR": {"ack": 670, "right": 500, "yeah": 720, "exactly": 590, "isee": 850, "interesting": 760},
    "zh-CN": {"ack": 540, "right": 400, "yeah": 430, "exactly": 520, "isee": 800, "interesting": 680},
    "ja-JP": {"ack": 450, "right": 520, "yeah": 570, "exactly": 470, "isee": 540, "interesting": 950},
}

# Per-id fallback when a locale lacks an entry: the longest pause of that id.
DEFAULT_REACTION_PAUSE_MS: dict[str, int] = {
    rid: max(pauses[rid] for pauses in REACTION_PAUSE_MS.values() if rid in pauses)
    for rid in REACTION_IDS
}

# place_reactions keeps this much silence before and after a clip, and a
# mid-turn break gains at least this much of the voice's own silence.
REACTION_MARGIN_SEC = 0.06
MIN_BOUNDARY_SILENCE_SEC = 0.25


def reaction_locale(language: str) -> str:
    """Phrase locale for ``language``: exact, then same primary language, else en-US."""
    lang = (language or "").strip().replace("_", "-").lower()
    by_lower = {loc.lower(): loc for loc in REACTION_PHRASES}
    if lang in by_lower:
        return by_lower[lang]
    primary = lang.split("-", 1)[0]
    for loc in REACTION_PHRASES:
        if primary and loc.lower().split("-", 1)[0] == primary:
            return loc
    return DEFAULT_REACTION_LOCALE


def reaction_text(language: str, reaction_id: str) -> str:
    """Localized backchannel text (en-US fallback); unknown ids raise ``ValueError``."""
    if reaction_id not in REACTION_IDS:
        raise ValueError("unknown reaction id")
    phrases = REACTION_PHRASES[reaction_locale(language)]
    return phrases.get(reaction_id) or REACTION_PHRASES[DEFAULT_REACTION_LOCALE][reaction_id]


def reaction_pause_ms(language: str, reaction_id: str) -> int:
    """Speaker pause (ms) planned before ``reaction_id`` in ``language``.

    Same locale resolution as ``reaction_text``; a missing entry falls back to
    the per-id default. Unknown ids raise ``ValueError``.
    """
    if reaction_id not in REACTION_IDS:
        raise ValueError("unknown reaction id")
    pauses = REACTION_PAUSE_MS.get(reaction_locale(language)) or {}
    return int(pauses.get(reaction_id) or DEFAULT_REACTION_PAUSE_MS[reaction_id])


def reaction_clip_budget_sec(language: str, reaction_id: str) -> float:
    """Longest reaction clip (seconds) that still fits its planned pause.

    DragonHD durations vary between renders: a synthesizer can re-take a clip
    longer than this; ``place_reactions`` skips clips that do not fit.
    """
    pause_sec = reaction_pause_ms(language, reaction_id) / 1000.0
    return round(pause_sec + MIN_BOUNDARY_SILENCE_SEC - 2 * REACTION_MARGIN_SEC, 3)


def planned_pauses(planned: Iterable[PlannedReaction]) -> dict[int, dict[int, int]]:
    """``{turn_idx: {after_sentence: pause_ms}}`` for the speech engines."""
    pauses: dict[int, dict[int, int]] = {}
    for p in planned:
        per_turn = pauses.setdefault(p.turn_idx, {})
        per_turn[p.after_sentence] = max(per_turn.get(p.after_sentence, 0), p.pause_ms)
    return pauses


# -----------------------------------------------------------------------------
# Env flags (read on every call so tests and operators can flip them live)
# -----------------------------------------------------------------------------

DEFAULT_LISTENER_TIMEOUT_SEC = 900.0
MIN_LISTENER_TIMEOUT_SEC = 30.0

_TRUTHY = frozenset({"1", "true", "yes", "on"})
_FALSY = frozenset({"0", "false", "no", "off"})


def _env_flag(name: str, default: bool = False) -> bool:
    value = (os.environ.get(name) or "").strip().lower()
    if value in _TRUTHY:
        return True
    if value in _FALSY:
        return False
    return default


def public_audio_enabled() -> bool:
    """``PODCAST_PUBLIC_AUDIO``: anonymous visitors of published podcasts get the
    audio, cover and transcript (default off)."""
    return _env_flag("PODCAST_PUBLIC_AUDIO")


def reactions_enabled() -> bool:
    """``PODCAST_REACTIONS``: hard kill switch for backchannels (default off)."""
    return _env_flag("PODCAST_REACTIONS")


def effective_reactions(requested: bool) -> bool:
    """Reactions actually rendered: the request asks for them AND the kill switch allows them."""
    return bool(requested) and reactions_enabled()


def listener_mode() -> ListenerModeSetting:
    """``PODCAST_LISTENER_MODE``: auto | idle_loop | procedural | still (unknown -> auto)."""
    value = (os.environ.get("PODCAST_LISTENER_MODE") or "").strip().lower().replace("-", "_")
    return cast(ListenerModeSetting, value) if value in LISTENER_MODE_SETTINGS else "auto"


def listener_timeout_sec() -> float:
    """``PODCAST_LISTENER_TIMEOUT_SEC``: listener-kit budget (default 900 s, minimum 30 s)."""
    try:
        value = float((os.environ.get("PODCAST_LISTENER_TIMEOUT_SEC") or "").strip())
    except ValueError:
        return DEFAULT_LISTENER_TIMEOUT_SEC
    if not math.isfinite(value):
        return DEFAULT_LISTENER_TIMEOUT_SEC
    return max(MIN_LISTENER_TIMEOUT_SEC, value)


__all__ = [
    "ComposeTimeline",
    "DEFAULT_LISTENER_TIMEOUT_SEC",
    "DEFAULT_REACTION_LOCALE",
    "DEFAULT_REACTION_PAUSE_MS",
    "IdleLoop",
    "LISTENER_MODES",
    "LISTENER_MODE_SETTINGS",
    "LibraryFiles",
    "ListenerKit",
    "ListenerMode",
    "ListenerModeSetting",
    "MIN_BOUNDARY_SILENCE_SEC",
    "MIN_LISTENER_TIMEOUT_SEC",
    "PlannedReaction",
    "REACTION_IDS",
    "REACTION_MARGIN_SEC",
    "REACTION_PAUSE_MS",
    "REACTION_PHRASES",
    "RadioResult",
    "ReactionClip",
    "ReactionPlacement",
    "TurnAudio",
    "WARNING_CODES",
    "WARNING_COVER_FALLBACK",
    "WARNING_LISTENER_FALLBACK",
    "WARNING_LISTENER_STATIC",
    "WARNING_LISTENER_TIMEOUT",
    "WARNING_RADIO_FALLBACK",
    "WARNING_REACTIONS_SKIPPED",
    "add_warning",
    "effective_reactions",
    "listener_mode",
    "listener_timeout_sec",
    "planned_pauses",
    "public_audio_enabled",
    "reaction_clip_budget_sec",
    "reaction_locale",
    "reaction_pause_ms",
    "reaction_text",
    "reactions_enabled",
]
