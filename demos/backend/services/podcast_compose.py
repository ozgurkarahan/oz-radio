"""ffmpeg composition for the podcast.

Builds a single 1920x1080 25 fps video following the geometry contract
documented in ``docs/podcast.md`` ("Video layout"):

``split_screen_with_slides`` (default)
  * interviewer tile 560x360 at (0,0), expert tile 560x360 at (1360,0) —
    head-and-shoulders crop of each avatar; the active speaker plays its live
    clip inside a 4 px clay frame with a soft inner glow; the listener stays
    in full colour (never dimmed) inside a subtle 2 px neutral border
  * centre label zone (560,0,800,96): "Name · Role" for both speakers in the
    same font sizes — colour and a clay accent bar mark the active one
  * centre caption zone (560,96,800,264): karaoke captions (ASS ``\\k``),
    centred and wrapped to ≤3 lines so they never cover a face or the slide
  * slide contained — never stretched or cropped — into 1280x720 at
    (320,360); dark gutters left/right with an "n / N" slide counter

``split_screen_only``
  * two 960x900 tiles, labels at y 900..960, captions at y 960..1080

Live listener — what fills the listener tile of a segment, best first:

1. ``idle_loop``: the listener kit's silent "listening" loop
   (``podcast_media.IdleLoop``: VP9+alpha WebM, or green mp4 keyed like the
   talking clips) read with a finite ``-stream_loop`` and trimmed from an
   offset picked by pose matching (``choose_loop_offset``), else from a
   per-role running cursor that starts at a job-seeded offset. Its audio is
   never mapped.
2. ``procedural``: the still with a subtle "breathing" sway — ≤ 0.8 % zoom
   anchored at the bottom centre (no point moves more than 2 px), a ~5.6 s
   sine — rendered on a ×4 supersampled frame so ``zoompan``'s integer crop
   never jitters.
3. ``still``: the plain still (an early frame of the listener's own clip;
   never its talking footage).
4. no tile: the listener has no clip at all.

``PODCAST_LISTENER_MODE`` (``still`` / ``procedural``) caps the choice and a
segment that fails to render is retried with the plain still. Backchannels
(``ReactionPlacement``) overlay the listener's lip-synced reaction clip on its
tile with 100 ms alpha fades and mix its audio under the speaker. Every
segment but the first opens with a 160 ms whole-frame dissolve from the
previous segment's last frame — inside the talking clip's 250 ms silent lead,
never across speech — without changing the segment length.

Plus an optional branded intro + outro card carrying the Oz Radio sonic logo
(``podcast_jingle``; the card tagline, the closing line and the speaker role
labels follow the episode's language, see ``card_wording``), background music
ducked to -25 dB (graceful skip if the file is missing) and loudnorm
I=-16:TP=-1.5:LRA=11. Exports final.mp4
(H.264+AAC), final.mp3 (its soundtrack — the radio fallback), final.srt and a
``ComposeTimeline`` (per-turn offsets in final.mp4 + the listener mode).
The commands are validated on ffmpeg 5.1 (Debian bookworm) and 7.1 (Debian
trixie — the production ``python:3.12-slim`` image).
"""

from __future__ import annotations

import functools
import hashlib
import json
import logging
import math
import re
import shutil
import subprocess
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Callable, Optional, Sequence

import numpy as np

from services import avatar_registry
from services.podcast_ingest import Document
from services.podcast_jingle import jingle_duration, render_jingle
from services.podcast_media import (
    WARNING_LISTENER_FALLBACK,
    WARNING_REACTIONS_SKIPPED,
    ComposeTimeline,
    IdleLoop,
    ListenerKit,
    ReactionClip,
    ReactionPlacement,
    add_warning,
    listener_mode,
)
from services.podcast_render import ClipManifest, DialogueTurn, RenderRoles, Script  # noqa: F401

log = logging.getLogger(__name__)

VIDEO_W = 1920
VIDEO_H = 1080
FPS = 25
MUSIC_DEFAULT = Path(__file__).resolve().parent.parent / "data" / "music" / "background.mp3"
# Minimum title-card lengths; a longer sonic logo stretches its card.
INTRO_SEC = 2.0
OUTRO_SEC = 2.0

BG_COLOR = "#0B1220"          # canvas, gutters and slide letter/pillar-box
TILE_BG_COLOR = "#16213A"     # avatar tile panel
ACCENT_COLOR = "#B8461E"      # clay: active frame + label accent
FRAME_PX = 4
GLOW_PX = 4                   # soft inner glow just inside the active frame
GLOW_ALPHA = 0.35
LISTENER_BORDER_COLOR = "#475569"   # subtle neutral border: the listener is never dimmed
LISTENER_BORDER_PX = 2
LABEL_NAME_SIZE = 28          # identical for both speakers: colour + accent bar mark
LABEL_ROLE_SIZE = 20          # the active one, so the labels never jump in size
LABEL_LINE_SIZE = 28          # split_screen_only "Name · Role" line

DISSOLVE_SEC = 0.16           # whole-frame dissolve at every turn start but the first
REACTION_FADE_SEC = 0.10      # alpha fade in/out of a backchannel clip
REACTION_AUDIO_FADE_SEC = 0.015
MIN_REACTION_SEC = 0.12

SUPERSAMPLE = 4               # procedural breathing renders at ×4, then scales down
BREATH_PERIOD_SEC = 5.6
BREATH_MAX_ZOOM = 0.008       # ≤ 1 % zoom, further capped so that ...
BREATH_DRIFT_PX = 2.0         # ... no point of the tile moves more than 2 px

# Segment render budget (s): base + per second of segment. Rendering runs at
# ≈ real time on 2 vCPU; the budget only stops a stuck ffmpeg (→ retry ladder).
SEGMENT_TIMEOUT_BASE_SEC = 90.0
SEGMENT_TIMEOUT_PER_SEC = 8.0

# Rendered listener sources, highest fidelity first ("none" = no listener tile).
LISTENER_RANK = {"none": -1, "still": 0, "procedural": 1, "idle_loop": 2}

# Pose-matching signature filter — must equal services.podcast_listener.SIGNATURE_VF,
# applied to the original (unkeyed) footage on both sides.
SIGNATURE_VF = "crop=iw*0.6:ih*0.6:iw*0.2:ih*0.2,scale=64:64:flags=area,format=gray"

DEFAULT_LAYOUT = "split_screen_with_slides"


@dataclass(frozen=True)
class CardWording:
    """Viewer-facing words burned into the video, in the language of the episode."""
    tagline: str        # subtitle of both title cards
    outro: str          # headline of the closing card
    interviewer: str    # role label under the interviewer's name
    expert: str         # role label under the expert's name


_ENGLISH = CardWording("AI Avatar Podcast", "Thanks for listening", "Interviewer", "Expert")
# By primary language subtag. The render fonts (Liberation, DejaVu) only cover Latin
# scripts, so zh and ja keep the English words rather than draw missing-glyph boxes.
# Role labels avoid gendered forms where the language has a neutral word.
CARD_WORDING = {
    "en": _ENGLISH,
    "fr": CardWording("Podcast d’avatars IA", "Merci de votre écoute", "Journaliste", "Expert"),
    "es": CardWording("Pódcast con avatares de IA", "Gracias por escuchar", "Periodista", "Especialista"),
    "de": CardWording("KI-Avatar-Podcast", "Danke fürs Zuhören", "Interviewer", "Experte"),
    "it": CardWording("Podcast con avatar IA", "Grazie per l’ascolto", "Giornalista", "Specialista"),
    "pt": CardWording("Podcast com avatares de IA", "Obrigado por ouvir", "Jornalista", "Especialista"),
}


def card_wording(language: Optional[str]) -> CardWording:
    """Cards and role labels for an episode language (``fr-FR``, ``fr_CA``, ``FR``…); English when unknown."""
    primary = re.split(r"[-_]", (language or "").strip().lower(), maxsplit=1)[0]
    return CARD_WORDING.get(primary, _ENGLISH)


def _find_font() -> Optional[str]:
    """Pick a usable TTF for drawtext (Windows ffmpeg lacks fontconfig defaults)."""
    candidates = [
        "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        r"C:\Windows\Fonts\arial.ttf",
        r"C:\Windows\Fonts\segoeui.ttf",
    ]
    for c in candidates:
        if Path(c).exists():
            return c
    return None


_FONT = _find_font()


def _font_arg() -> str:
    """':fontfile=...' suffix for drawtext, or empty when none found."""
    if not _FONT:
        return ""
    p = _FONT.replace("\\", "/").replace(":", "\\:")
    return f":fontfile='{p}'"

# Neutral brand palette (placeholder).
BRAND_PRIMARY = "&H00C8412B&"   # ASS color = AABBGGRR
BRAND_SECONDARY = "&H00FFFFFF&"


# ---------------------------------------------------------------------------
# Layout geometry (contract v1)
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Rect:
    x: int
    y: int
    w: int
    h: int

    @property
    def cx(self) -> int:
        return self.x + self.w // 2

    @property
    def cy(self) -> int:
        return self.y + self.h // 2


@dataclass(frozen=True)
class LayoutGeometry:
    name: str
    interviewer_tile: Rect
    expert_tile: Rect
    label_zone: Rect
    caption_zone: Rect
    slide: Optional[Rect]
    caption_font_size: int
    caption_max_chars: int     # per line, sized so a line fits the zone width
    caption_max_lines: int

    def tile(self, speaker: str) -> Rect:
        return self.interviewer_tile if speaker == "interviewer" else self.expert_tile


LAYOUTS: dict[str, LayoutGeometry] = {
    "split_screen_with_slides": LayoutGeometry(
        name="split_screen_with_slides",
        interviewer_tile=Rect(0, 0, 560, 360),
        expert_tile=Rect(1360, 0, 560, 360),
        label_zone=Rect(560, 0, 800, 96),
        caption_zone=Rect(560, 96, 800, 264),
        slide=Rect(320, 360, 1280, 720),
        # Arial Bold 34 px ≈ 18.5 px/char → 40 chars ≈ 740 px (< 760 px usable).
        caption_font_size=34,
        caption_max_chars=40,
        caption_max_lines=3,
    ),
    "split_screen_only": LayoutGeometry(
        name="split_screen_only",
        interviewer_tile=Rect(0, 0, 960, 900),
        expert_tile=Rect(960, 0, 960, 900),
        label_zone=Rect(0, 900, 1920, 60),
        caption_zone=Rect(80, 960, 1760, 120),
        slide=None,
        caption_font_size=34,
        caption_max_chars=72,
        caption_max_lines=2,
    ),
}


def get_layout(name: Optional[str]) -> LayoutGeometry:
    """Resolve a ``podcast_models.Layout`` value (unknown → default)."""
    if name and name in LAYOUTS:
        return LAYOUTS[name]
    if name:
        log.warning("unknown podcast layout %r — using %s", name, DEFAULT_LAYOUT)
    return LAYOUTS[DEFAULT_LAYOUT]


@dataclass(frozen=True)
class SpeakerVisual:
    """How one speaker's avatar footage must be keyed and framed."""
    chroma_key: bool = False
    crop: tuple[float, float, float, float] = avatar_registry.PODCAST_CROP_PREBUILT


@dataclass(frozen=True)
class ListenerSource:
    """What fills the listener tile during one segment.

    ``mode`` ``idle_loop``: ``path`` = loop video, ``offset`` = loop start (s),
    ``has_alpha`` = native alpha (VP9 WebM, no chroma key), ``loop_duration``
    = loop length (s; sizes the finite ``-stream_loop`` count); ``procedural``:
    ``path`` = still, ``offset`` = breathing phase (s); ``still``: ``path`` =
    still.
    """
    mode: str = "still"
    path: Optional[Path] = None
    offset: float = 0.0
    has_alpha: bool = False
    loop_duration: float = 0.0


@dataclass(frozen=True)
class SegmentReaction:
    """A backchannel rendered inside one segment (``at`` is segment-relative, s)."""
    at: float
    duration: float
    gain_db: float = -4.0
    has_alpha: bool = False
    video: Optional[Path] = None
    audio: Optional[Path] = None


@dataclass(frozen=True)
class SegmentInputs:
    """``ffmpeg -i`` indices of one segment render (see ``_segment_input_indices``)."""
    slide: Optional[int]
    active: int
    listener: Optional[int]
    reactions: tuple[tuple[int, int], ...]   # (clip video, clip audio) per reaction
    prev: Optional[int]


@dataclass
class ComposeResult:
    mp4: Path
    mp3: Path
    srt: Path
    timeline: Optional[ComposeTimeline] = None
    # Stable podcast_media warning codes (listener fallback, skipped reactions).
    warnings: list[str] = field(default_factory=list)


@dataclass
class _Listener:
    """Per-role listener plan and running state across one compose."""
    speaker: str
    mode: str                          # idle_loop | procedural | still | none
    still: Optional[Path] = None
    loop: Optional[IdleLoop] = None
    loop_duration: float = 0.0
    signatures: Optional[np.ndarray] = None
    sig_fps: float = float(FPS)
    cursor: float = 0.0                # idle-loop running cursor (s)
    phase: float = 0.0                 # breathing phase (s)
    last_seg: int = -2                 # last segment this role listened in
    last_mode: str = "none"


def compose_podcast(
    clips: list[ClipManifest],
    document: Optional[Document],
    script: Script,
    roles: RenderRoles,
    out_dir: Path,
    music: bool = True,
    intro: bool = True,
    music_path: Optional[Path] = None,
    layout: str = DEFAULT_LAYOUT,
    *,
    listener_kits: Optional[dict[str, ListenerKit]] = None,
    reactions: Optional[list[ReactionPlacement]] = None,
    reaction_clips: Optional[dict[str, dict[str, ReactionClip]]] = None,
    seed: str = "",
) -> ComposeResult:
    """Run the full compose pipeline; returns the deliverables + timeline.

    ``listener_kits`` (keyed by role) animate the listener (none → the still
    with a procedural sway, subject to ``PODCAST_LISTENER_MODE``);
    ``reactions`` are placed backchannels (``at_sec`` relative to the turn's
    untrimmed talking clip) drawn from ``reaction_clips`` (role → reaction id
    → clip; default: the kits' own reactions); ``seed`` (the job id) makes
    the loop offsets deterministic. A missing or broken kit, loop or reaction
    clip never fails the render — it degrades (see ``ComposeResult.warnings``).
    """
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    if not clips:
        raise ValueError("compose_podcast requires at least one clip")

    _require_tool("ffmpeg")
    _require_tool("ffprobe")

    geo = get_layout(layout)
    clips_sorted = sorted(clips, key=lambda c: c.turn_idx)
    turn_by_idx = {t.idx: t for t in script.turns}
    language = getattr(script, "language", None)   # cards and role labels follow the episode
    warnings: list[str] = []

    # 1) Probe each clip's actual duration.
    durations = [_probe_duration(Path(c.blob_url)) for c in clips_sorted]

    # 2) Resolve a slide image (+ "n / N" counter) per turn.
    slides = _resolve_slides(document, script, out_dir) if geo.slide else {}

    # 2b) Per-speaker framing: chroma flag + head-and-shoulders crop. The
    #     listener tile must use the listener's own chroma flag.
    visuals = {
        speaker: _speaker_visual(roles, speaker, clips_sorted)
        for speaker in ("interviewer", "expert")
    }

    # 2c) One neutral still per speaker (an early frame of its own clip, inside
    #     the silent lead) — the base of the procedural/still listener, never
    #     its talking footage.
    idle_frames: dict[str, Optional[Path]] = {}
    for speaker in ("interviewer", "expert"):
        idle_frames[speaker] = None
        for clip in clips_sorted:
            if clip.speaker == speaker:
                fp = out_dir / f"_idle_{speaker}.png"
                try:
                    _extract_frame(Path(clip.blob_url), fp, at_sec=0.1)
                    idle_frames[speaker] = fp
                except Exception as exc:  # noqa: BLE001
                    log.warning("idle frame extract failed for %s: %s", speaker, exc)
                break

    # 2d) Listener plan per role (kit + PODCAST_LISTENER_MODE), reactions per turn.
    setting = listener_mode()
    kits = dict(listener_kits or {})
    listeners = {
        speaker: _plan_listener(speaker, kits.get(speaker), idle_frames[speaker], setting, seed, warnings)
        for speaker in ("interviewer", "expert")
    }
    speakers = [_turn_speaker(c, turn_by_idx) for c in clips_sorted]
    placements = _group_placements(reactions)
    lookup = _reaction_lookup(reaction_clips, kits)
    edge_cache: dict[tuple[str, str], Optional[np.ndarray]] = {}

    # 3) Per-turn segment videos (one at a time), then concat. A single
    #    monolithic filtergraph for N turns blows past ffmpeg's stack on long
    #    podcasts; rendering per segment + concat is more robust.
    fallback_slide: Optional[Path] = None
    segment_paths: list[Path] = []
    seg_durations: list[float] = []
    modes_used: list[str] = []
    bad_clips: set[Path] = set()
    for i, (clip, dur) in enumerate(zip(clips_sorted, durations)):
        active_speaker = speakers[i]
        idle_speaker = _other(active_speaker)
        st = listeners[idle_speaker]
        slide_path: Optional[Path] = None
        counter: Optional[str] = None
        if geo.slide:
            slide_path, counter = slides.get(clip.turn_idx, (None, None))
            if slide_path is None:
                if fallback_slide is None:
                    fallback_slide = _fallback_slide(document, out_dir)
                slide_path = fallback_slide
        lead_in = 0.0
        total = dur + lead_in

        entry = exit_ = None
        if st.mode == "idle_loop" and st.signatures is not None and not _continues(st, i):
            size = st.signatures.shape[1:]
            prev_talk = next((j for j in range(i - 1, -1, -1) if speakers[j] == idle_speaker), None)
            next_talk = next((j for j in range(i + 1, len(speakers)) if speakers[j] == idle_speaker), None)
            if prev_talk is not None:
                entry = _edge_signature(Path(clips_sorted[prev_talk].blob_url), "last", size, edge_cache)
            if next_talk is not None:
                exit_ = _edge_signature(Path(clips_sorted[next_talk].blob_url), "first", size, edge_cache)
        primary = _listener_source(st, i, total, entry, exit_)
        still_src = ListenerSource("still", st.still) if st.still is not None else None

        seg_rx, skipped = _segment_reactions(
            placements.get(clip.turn_idx, ()), idle_speaker, total, lead_in, lookup,
        )
        if bad_clips:
            kept = [r for r in seg_rx if r.video not in bad_clips]
            skipped += len(seg_rx) - len(kept)
            seg_rx = kept
        if skipped:
            add_warning(warnings, WARNING_REACTIONS_SKIPPED)

        prev_frame = None
        if segment_paths:
            prev_frame = _extract_last_frame(segment_paths[-1], out_dir / f"_last_{i - 1:03d}.png")

        seg_out = out_dir / f"seg_{i:03d}.mp4"
        ladder = _attempt_ladder(primary, still_src, seg_rx, prev_frame)
        last_exc: Optional[Exception] = None
        used = ladder[0]
        for k, (lsrc, rx, pf) in enumerate(ladder):
            try:
                _render_segment(
                    clip_path=Path(clip.blob_url),
                    idle_frame=None,
                    slide_path=slide_path,
                    duration=dur,
                    active_speaker=active_speaker,
                    roles=roles,
                    out=seg_out,
                    lead_in=lead_in,
                    chroma_key=bool(getattr(clip, "chroma_key", visuals[active_speaker].chroma_key)),
                    idle_chroma_key=visuals[idle_speaker].chroma_key,
                    active_crop=visuals[active_speaker].crop,
                    idle_crop=visuals[idle_speaker].crop,
                    layout=geo.name,
                    slide_counter=counter,
                    listener=lsrc,
                    reactions=rx,
                    prev_frame=pf,
                    language=language,
                )
            except RuntimeError as exc:
                last_exc = exc
                log.warning(
                    "podcast compose: segment %d failed (listener %s, %d reaction(s), dissolve %s) — %s",
                    i, lsrc.mode if lsrc else "none", len(rx), pf is not None,
                    "retrying with the plain still" if k + 1 < len(ladder) else "giving up",
                )
                continue
            used = (lsrc, rx, pf)
            break
        else:
            assert last_exc is not None
            raise last_exc

        lsrc, rx, _pf = used
        used_mode = lsrc.mode if lsrc is not None else "none"
        planned_mode = primary.mode if primary is not None else "none"
        if used_mode != planned_mode:
            # The listener source broke: plain still for the rest of the episode.
            st.mode = "still" if st.still is not None else "none"
            add_warning(warnings, WARNING_LISTENER_FALLBACK)
        if len(rx) < len(seg_rx):
            # Only the attempt without backchannels rendered: skip these clips from now on.
            bad_clips.update(r.video for r in seg_rx if r.video is not None)
            add_warning(warnings, WARNING_REACTIONS_SKIPPED)
        modes_used.append(used_mode)
        _advance(st, lsrc, total, i)
        segment_paths.append(seg_out)
        # The concat places turns on the video timeline (see _concat).
        seg_durations.append(_probe_video_duration(seg_out) or _safe_probe_duration(seg_out) or total)

    # 4) Title cards carry the sonic logo (a longer logo stretches its card).
    wording = card_wording(language)
    intro_sec = max(INTRO_SEC, jingle_duration("intro")) if intro else 0.0
    outro_sec = max(OUTRO_SEC, jingle_duration("outro")) if intro else 0.0
    extras: list[Path] = []
    if intro:
        intro_card = out_dir / "intro.mp4"
        _render_card_with_jingle(intro_card, "Oz Radio", intro_sec, "intro", out_dir,
                                 subtitle=wording.tagline)
        extras.append(intro_card)

    body_concat = out_dir / "body.mp4"
    _concat(extras + segment_paths, body_concat)

    if intro:
        outro_card = out_dir / "outro.mp4"
        _render_card_with_jingle(outro_card, wording.outro, outro_sec, "outro", out_dir,
                                 subtitle=wording.tagline)
        full_concat = out_dir / "full.mp4"
        _concat([body_concat, outro_card], full_concat)
    else:
        full_concat = body_concat

    # 5) Karaoke subtitles timed on the rendered segments (+ the intro card),
    #    burned in with (optional) music + loudnorm.
    ass_path = out_dir / "subs.ass"
    _write_ass(ass_path, clips_sorted, seg_durations, turn_by_idx, roles,
               offset=intro_sec, layout=geo.name)

    final_mp4 = out_dir / "final.mp4"
    _finalize(full_concat, ass_path, final_mp4, music_path if music else None)

    final_mp3 = out_dir / "final.mp3"
    _extract_mp3(final_mp4, final_mp3)

    final_srt = out_dir / "final.srt"
    _write_srt(
        final_srt,
        clips_sorted,
        seg_durations,
        turn_by_idx,
        roles,
        offset=intro_sec,
    )

    offsets: dict[int, tuple[float, float]] = {}
    cursor = intro_sec
    for clip, seg_dur in zip(clips_sorted, seg_durations):
        offsets[clip.turn_idx] = (round(cursor, 3), round(cursor + seg_dur, 3))
        cursor += seg_dur
    timeline = ComposeTimeline(
        turn_video_offsets=offsets,
        listener_mode=_lowest_mode(modes_used),
        duration_sec=round(_safe_probe_duration(final_mp4) or (cursor + outro_sec), 3),
    )
    return ComposeResult(mp4=final_mp4, mp3=final_mp3, srt=final_srt,
                         timeline=timeline, warnings=warnings)


def _speaker_visual(roles: RenderRoles, speaker: str, clips: list[ClipManifest]) -> SpeakerVisual:
    """Chroma flag + crop rect for ``speaker`` from its clips and the registry."""
    role = getattr(roles, speaker)
    first = next((c for c in clips if c.speaker == speaker), None)
    avatar_id = role.avatar
    if first is not None and "avatar_id" in getattr(first, "model_fields_set", set()):
        avatar_id = first.avatar_id
    if not avatar_registry.is_known(avatar_id):
        chroma = bool(first.chroma_key) if first is not None else False
        crop = avatar_registry.PODCAST_CROP_PHOTO if chroma else avatar_registry.PODCAST_CROP_PREBUILT
        return SpeakerVisual(chroma_key=chroma, crop=crop)
    entry = avatar_registry.get(avatar_id)
    chroma = bool(first.chroma_key) if first is not None else entry.chroma_key
    crop = avatar_registry.podcast_crop_for(entry)
    if entry.podcast_crop is None and chroma != entry.chroma_key:
        # The clip was rendered differently from the registry kind — frame it
        # by what was actually rendered (green-screen portrait vs 16:9 stage).
        crop = avatar_registry.PODCAST_CROP_PHOTO if chroma else avatar_registry.PODCAST_CROP_PREBUILT
    return SpeakerVisual(chroma_key=chroma, crop=crop)


# ---------------------------------------------------------------------------
# Live listener: plan, loop offsets, reactions
# ---------------------------------------------------------------------------

def _other(speaker: str) -> str:
    return "expert" if speaker == "interviewer" else "interviewer"


def _turn_speaker(clip: ClipManifest, turn_by_idx: dict) -> str:
    turn = turn_by_idx.get(clip.turn_idx)
    return turn.speaker if turn else clip.speaker


def _resolve_listener_mode(setting: str, kit: Optional[ListenerKit], has_still: bool) -> str:
    """Planned listener source for one role: ``idle_loop`` / ``procedural`` / ``still`` / ``none``.

    ``setting`` is ``PODCAST_LISTENER_MODE``: ``still`` and ``procedural``
    cap the choice; ``auto`` / ``idle_loop`` follow the kit (no kit → the
    procedural sway; a kit loop that is missing on disk → procedural). The
    still-based modes need the listener's still, else there is no tile.
    """
    floor = "still" if has_still else "none"
    procedural = "procedural" if has_still else floor
    if setting == "still":
        return floor
    if setting == "procedural" or kit is None:
        return procedural
    if kit.mode == "idle_loop" and kit.idle is not None and Path(kit.idle.path).is_file():
        return "idle_loop"
    if kit.mode == "still":
        return floor
    return procedural


def _seeded_unit(seed: str, key: str) -> float:
    """Deterministic value in [0, 1) for (job seed, key)."""
    digest = hashlib.sha256(f"{seed}\x1f{key}".encode("utf-8")).digest()
    return int.from_bytes(digest[:8], "big") / float(1 << 64)


def _plan_listener(speaker: str, kit: Optional[ListenerKit], still: Optional[Path],
                   setting: str, seed: str, warnings: list[str]) -> _Listener:
    has_still = still is not None and Path(still).is_file()
    mode = _resolve_listener_mode(setting, kit, has_still)
    unit = _seeded_unit(seed, speaker)
    st = _Listener(speaker=speaker, mode=mode, still=Path(still) if has_still else None,
                   phase=unit * BREATH_PERIOD_SEC)
    kit_wants_loop = kit is not None and kit.mode == "idle_loop" and setting in ("auto", "idle_loop")
    if kit_wants_loop and mode != "idle_loop":
        add_warning(warnings, WARNING_LISTENER_FALLBACK)
    if mode != "idle_loop":
        return st
    assert kit is not None and kit.idle is not None
    idle = kit.idle
    loop_duration = float(idle.duration_sec or 0.0)
    if not (math.isfinite(loop_duration) and loop_duration > 0):
        loop_duration = _safe_probe_duration(Path(idle.path))
    if loop_duration < 2.0 / FPS or not _decodes_video(Path(idle.path)):
        # Unreadable or degenerate loop: the plain still (like a failed render).
        st.mode = "still" if has_still else "none"
        add_warning(warnings, WARNING_LISTENER_FALLBACK)
        return st
    st.loop = idle
    st.loop_duration = loop_duration
    st.cursor = unit * loop_duration
    sig = _load_signatures(idle.signature_path)
    if sig is not None:
        st.signatures, st.sig_fps = sig
    return st


def _decodes_video(path: Path) -> bool:
    """True when ``path`` decodes at least one video frame.

    Checked once per compose before the loop is fed to ``-stream_loop``: an
    input that opens but never yields a frame would only fail (or stall) the
    segment renders.
    """
    try:
        proc = subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", *_decoder_args(Path(path)),
             "-i", str(path), "-map", "0:v:0", "-frames:v", "1", "-vf", "scale=16:16",
             "-f", "rawvideo", "-pix_fmt", "gray", "-"],
            capture_output=True, timeout=60,
        )
    except Exception:  # noqa: BLE001
        return False
    return proc.returncode == 0 and len(proc.stdout) >= 16 * 16


def _continues(st: _Listener, seg_idx: int) -> bool:
    """The role already listened (on its loop) in the previous segment."""
    return st.last_seg == seg_idx - 1 and st.last_mode == "idle_loop"


def _listener_source(st: _Listener, seg_idx: int, total: float,
                     entry: Optional[np.ndarray] = None,
                     exit_frame: Optional[np.ndarray] = None) -> Optional[ListenerSource]:
    if st.mode == "none" or (st.mode != "idle_loop" and st.still is None):
        return None
    if st.mode == "still":
        return ListenerSource("still", st.still)
    if st.mode == "procedural":
        return ListenerSource("procedural", st.still, offset=round(st.phase % BREATH_PERIOD_SEC, 3))
    assert st.loop is not None
    if _continues(st, seg_idx):
        offset = _snap_offset(st.cursor, st.loop_duration)
    else:
        offset = choose_loop_offset(
            st.loop_duration, total, st.cursor,
            signatures=st.signatures, fps=st.sig_fps,
            entry_frame=entry, exit_frame=exit_frame,
        )
    path = Path(st.loop.path)
    return ListenerSource("idle_loop", path, offset=offset,
                          has_alpha=bool(st.loop.has_alpha) and path.suffix.lower() == ".webm",
                          loop_duration=st.loop_duration)


def _advance(st: _Listener, used: Optional[ListenerSource], total: float, seg_idx: int) -> None:
    st.phase = (st.phase + total) % BREATH_PERIOD_SEC
    if used is not None and used.mode == "idle_loop" and st.loop_duration > 0:
        st.cursor = (used.offset + total) % st.loop_duration
    st.last_seg = seg_idx
    st.last_mode = used.mode if used is not None else "none"


def _lowest_mode(modes: Sequence[str]) -> str:
    """Lowest-fidelity listener mode rendered ("none" and no listener → "still")."""
    real = [m for m in modes if LISTENER_RANK.get(m, -1) >= 0]
    if not real or len(real) < len(modes):
        return "still"
    return min(real, key=lambda m: LISTENER_RANK[m])


def _snap_offset(t: float, loop_duration: float) -> float:
    """Wrap ``t`` into [0, loop_duration) on the 25 fps grid."""
    if not (math.isfinite(loop_duration) and loop_duration > 0):
        return 0.0
    if not math.isfinite(t):
        t = 0.0
    snapped = round((t % loop_duration) * FPS) / FPS
    return 0.0 if snapped >= loop_duration - 1e-9 else round(snapped, 3)


def choose_loop_offset(
    loop_duration: float,
    segment_duration: float,
    cursor: float = 0.0,
    *,
    signatures: Optional[np.ndarray] = None,
    fps: float = float(FPS),
    entry_frame: Optional[np.ndarray] = None,
    exit_frame: Optional[np.ndarray] = None,
) -> float:
    """Start offset (s) into an idle loop for a listening stretch of ``segment_duration``.

    Pure. Without signatures or target frames: the running ``cursor`` wrapped
    into the loop and snapped to the 25 fps grid. With ``signatures`` (the
    ``frames`` of ``IdleLoop.signature_path``: uint8 [N, H, W], frame ``i`` =
    the loop at ``i / fps`` s) plus an ``entry_frame`` (the listener's previous
    visible frame: the last frame of its previous talking clip) and/or an
    ``exit_frame`` (the first frame of its next talking clip), each [H, W] and
    computed with the same ``SIGNATURE_VF`` on unkeyed footage: the loop frame
    ``i`` minimizing ``MSE(sig[i], entry) + MSE(sig[(i + n - 1) mod loop],
    exit)`` where ``n`` is the number of frames the stretch shows; ties go to
    the frame nearest the cursor. Targets of another shape are ignored.
    """
    if not (math.isfinite(loop_duration) and loop_duration > 0):
        return 0.0
    fallback = _snap_offset(cursor, loop_duration)
    if signatures is None or not (math.isfinite(fps) and fps > 0):
        return fallback
    sig = np.asarray(signatures)
    if sig.ndim != 3 or sig.shape[0] == 0:
        return fallback
    n_loop = min(sig.shape[0], max(1, int(round(loop_duration * fps))))
    frame_shape = tuple(sig.shape[1:])
    flat = sig[:n_loop].reshape(n_loop, -1).astype(np.float32)
    cost = np.zeros(n_loop, dtype=np.float64)
    used = False
    if entry_frame is not None and tuple(np.shape(entry_frame)) == frame_shape:
        target = np.asarray(entry_frame, dtype=np.float32).reshape(1, -1)
        cost += np.mean((flat - target) ** 2, axis=1)
        used = True
    if exit_frame is not None and tuple(np.shape(exit_frame)) == frame_shape:
        shown = max(1, int(round(segment_duration * fps)))
        last = (np.arange(n_loop) + shown - 1) % n_loop
        target = np.asarray(exit_frame, dtype=np.float32).reshape(1, -1)
        cost += np.mean((flat[last] - target) ** 2, axis=1)
        used = True
    if not used:
        return fallback
    best = float(cost.min())
    candidates = np.flatnonzero(cost <= best + 1e-6 * max(1.0, best))
    cur_idx = (fallback * fps) % n_loop
    dist = np.abs(candidates - cur_idx)
    dist = np.minimum(dist, n_loop - dist)
    idx = int(candidates[int(np.argmin(dist))])
    return _snap_offset(idx / fps, loop_duration)


def _load_signatures(path: Optional[Path]) -> Optional[tuple[np.ndarray, float]]:
    """``(frames uint8 [N, H, W], fps)`` from an IdleLoop signature .npz, or None."""
    if not path:
        return None
    p = Path(path)
    if not p.is_file():
        return None
    try:
        with np.load(p, allow_pickle=False) as data:
            frames = np.asarray(data["frames"])
            fps = float(np.asarray(data["fps"]).reshape(-1)[0])
    except Exception as exc:  # noqa: BLE001 — pose matching is optional
        log.warning("podcast compose: unreadable loop signatures — running cursor (%s)",
                    type(exc).__name__)
        return None
    if frames.ndim != 3 or frames.shape[0] < 2 or min(frames.shape[1:]) < 2:
        return None
    if not (math.isfinite(fps) and fps > 0):
        return None
    return frames.astype(np.uint8, copy=False), fps


def _signature_vf() -> str:
    """The listener kit's signature filter (fallback: the identical local constant)."""
    try:
        from services.podcast_listener import SIGNATURE_VF as kit_vf  # noqa: PLC0415
    except Exception:  # noqa: BLE001 — unit optional / mid-deployment
        return SIGNATURE_VF
    return kit_vf if isinstance(kit_vf, str) and kit_vf else SIGNATURE_VF


def _edge_signature(video: Path, which: str, size: tuple[int, ...],
                    cache: dict[tuple[str, str], Optional[np.ndarray]]) -> Optional[np.ndarray]:
    """Signature [H, W] of the first or last frame of a talking clip (cached), or None."""
    key = (str(video), which)
    if key in cache:
        return cache[key]
    sig: Optional[np.ndarray] = None
    h, w = int(size[0]), int(size[1])
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error"]
    if which == "last":
        cmd += ["-sseof", "-0.25"]
    cmd += [*_decoder_args(video), "-i", str(video), "-an", "-vf", _signature_vf()]
    if which == "first":
        cmd += ["-frames:v", "1"]
    cmd += ["-f", "rawvideo", "-pix_fmt", "gray", "-"]
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=120)
        n = h * w
        count = len(proc.stdout) // n if proc.returncode == 0 and n > 0 else 0
        if count:
            pick = 0 if which == "first" else count - 1
            sig = np.frombuffer(proc.stdout[pick * n:(pick + 1) * n], dtype=np.uint8).reshape(h, w)
    except Exception as exc:  # noqa: BLE001 — pose matching is optional
        log.debug("podcast compose: edge signature failed (%s)", type(exc).__name__)
    cache[key] = sig
    return sig


def _group_placements(placements: Optional[Sequence[ReactionPlacement]]) -> dict[int, list[ReactionPlacement]]:
    grouped: dict[int, list[ReactionPlacement]] = {}
    for p in placements or ():
        grouped.setdefault(int(p.turn_idx), []).append(p)
    return grouped


def _reaction_lookup(
    reaction_clips: Optional[dict[str, dict[str, ReactionClip]]],
    kits: dict[str, ListenerKit],
) -> Callable[[str, str], Optional[ReactionClip]]:
    """Reaction clip by (listener role, reaction id): explicit clips first, then the kit's."""
    def lookup(listener: str, reaction_id: str) -> Optional[ReactionClip]:
        by_id = (reaction_clips or {}).get(listener)
        if by_id is None:
            kit = kits.get(listener)
            by_id = kit.reactions if kit is not None else {}
        return (by_id or {}).get(reaction_id)
    return lookup


def _segment_reactions(
    placements: Sequence[ReactionPlacement],
    listener: str,
    seg_dur: float,
    lead_in: float,
    lookup: Callable[[str, str], Optional[ReactionClip]],
) -> tuple[list[SegmentReaction], int]:
    """Renderable reactions of one segment (+ how many placements were skipped).

    A placement is skipped — never fatal — when it is not voiced by this
    segment's listener, its clip or video/audio file is missing, or it does
    not fit in the segment. Clips play from ``lead_in + at_sec`` for the
    placement's duration, clamped to the clip and to the segment end.
    """
    out: list[SegmentReaction] = []
    skipped = 0
    for p in placements:
        clip = lookup(p.listener, p.reaction_id) if p.listener == listener else None
        video = Path(clip.video_path) if clip is not None and clip.video_path else None
        audio = Path(clip.audio_path) if clip is not None and clip.audio_path else None
        if clip is None or video is None or audio is None or not video.is_file() or not audio.is_file():
            skipped += 1
            continue
        at = lead_in + float(p.at_sec)
        dur = float(p.duration_sec) if p.duration_sec and p.duration_sec > 0 else float(clip.duration_sec or 0.0)
        if clip.duration_sec and clip.duration_sec > 0:
            dur = min(dur, float(clip.duration_sec))
        dur = min(dur, seg_dur - at)
        if not (math.isfinite(at) and math.isfinite(dur)) or at < 0 or dur < MIN_REACTION_SEC:
            skipped += 1
            continue
        out.append(SegmentReaction(
            at=round(at, 3),
            duration=round(dur, 3),
            gain_db=float(p.gain_db),
            has_alpha=bool(clip.has_alpha) and video.suffix.lower() == ".webm",
            video=video,
            audio=audio,
        ))
    out.sort(key=lambda r: r.at)
    return out, skipped


def _attempt_ladder(
    primary: Optional[ListenerSource],
    still: Optional[ListenerSource],
    reactions: Sequence[SegmentReaction],
    prev_frame: Optional[Path],
) -> list[tuple[Optional[ListenerSource], tuple[SegmentReaction, ...], Optional[Path]]]:
    """Segment render attempts: as planned → plain still → plain still, no extras."""
    rx = tuple(reactions)
    ladder = [(primary, rx, prev_frame)]
    if primary is not None and primary.mode != "still":
        ladder.append((still, rx, prev_frame))
    if rx or prev_frame is not None:
        ladder.append((still if primary is not None else None, (), None))
    unique: list[tuple[Optional[ListenerSource], tuple[SegmentReaction, ...], Optional[Path]]] = []
    for attempt in ladder:
        if attempt not in unique:
            unique.append(attempt)
    return unique


# ---------------------------------------------------------------------------
# Per-segment composition
# ---------------------------------------------------------------------------

def _clamp_crop(crop) -> tuple[float, float, float, float]:
    """Clamp a normalized (x, y, w, h) rect into the unit square."""
    try:
        x, y, w, h = (float(v) for v in crop)
    except (TypeError, ValueError):
        return avatar_registry.PODCAST_CROP_PREBUILT
    x = min(max(x, 0.0), 0.95)
    y = min(max(y, 0.0), 0.95)
    w = min(max(w, 0.05), 1.0 - x)
    h = min(max(h, 0.05), 1.0 - y)
    return (x, y, w, h)


def _crop_filter(crop) -> str:
    """ffmpeg crop on a normalized rect, rounded down to even pixel values."""
    x, y, w, h = _clamp_crop(crop)
    return (
        f"crop=w=trunc(iw*{w:.4f}/2)*2:h=trunc(ih*{h:.4f}/2)*2:"
        f"x=trunc(iw*{x:.4f}/2)*2:y=trunc(ih*{y:.4f}/2)*2"
    )


def _chroma_filter(enabled: bool) -> str:
    # Photo avatars come in as mp4 with a #00FF00 background — strip the
    # green before any other filter so crop/scale/pad see a clean alpha layer.
    if not enabled:
        return ""
    return (
        "chromakey=0x00ff00:0.22:0.12,"
        "despill=type=green:mix=0.6:expand=0.3:brightness=0,"
    )


def _tile_chain(src: str, out: str, visual: SpeakerVisual, tile: Rect,
                *, pre: str = "", post: str = "", alpha_source: bool = False) -> str:
    """[pre] → chromakey/despill → crop → scale(decrease) → pad → yuva420p → [post] → fps.

    ``pre`` holds timing-only filters (trim/setpts/tpad); ``alpha_source``
    = the footage carries native alpha (no chroma key).
    """
    key = "" if alpha_source else _chroma_filter(visual.chroma_key)
    return (
        f"{src}{pre}{key}{_crop_filter(visual.crop)},"
        f"scale={tile.w}:{tile.h}:force_original_aspect_ratio=decrease,setsar=1,"
        f"format=rgba,pad={tile.w}:{tile.h}:(ow-iw)/2:oh-ih:color=black@0,"
        f"format=yuva420p,{post}fps={FPS}{out};"
    )


def _breathing_filter(tile: Rect, phase: float, total_dur: float) -> str:
    """Subtle supersampled sway of a still tile (``zoompan`` on a ×4 frame).

    The zoom (≤ ``BREATH_MAX_ZOOM``, capped so the top edge rises at most
    ``BREATH_DRIFT_PX``) is anchored at the bottom centre and follows a slow
    sine continued from ``phase`` seconds. ``zoompan`` crops on whole pixels
    (even ones for subsampled chroma), so it works on a 4:4:4 frame
    supersampled ×4: the motion steps by ¼ px and the downscale smooths it —
    no visible integer jitter.
    """
    # Floored (not rounded) so the formatted amplitude never exceeds the drift cap.
    amp = math.floor(min(BREATH_MAX_ZOOM, BREATH_DRIFT_PX / tile.h) * 1e5) / 1e5
    zoom = (
        f"1+{amp:.5f}*(0.5-0.5*cos(2*PI*(on/{FPS}+{phase:.3f})/{BREATH_PERIOD_SEC}))"
    )
    # y='ih' is clipped by zoompan to exactly ih-h (its own truncated crop height):
    # bottom-anchored on every frame, never one row off. zoompan's input and
    # output share one pixel format, so 4:4:4 is pinned on both sides.
    return (
        f"scale={tile.w * SUPERSAMPLE}:{tile.h * SUPERSAMPLE}:flags=bicubic,format=yuva444p,"
        f"loop=loop=-1:size=1:start=0,"
        f"zoompan=z='{zoom}':x='(iw-iw/zoom)/2':y='ih':d=1:"
        f"s={tile.w}x{tile.h}:fps={FPS},format=yuva444p,"
        f"trim=duration={total_dur:.3f},setpts=PTS-STARTPTS,format=yuva420p,"
    )


def _listener_chain(src: str, out: str, visual: SpeakerVisual, tile: Rect,
                    listener: ListenerSource, total_dur: float) -> str:
    """Listener tile in full colour (no dim) from a loop, a swaying still or a still."""
    if listener.mode == "idle_loop":
        pre = f"trim=start={listener.offset:.3f}:duration={total_dur:.3f},setpts=PTS-STARTPTS,"
        return _tile_chain(src, out, visual, tile, pre=pre, alpha_source=listener.has_alpha)
    if listener.mode == "procedural":
        return _tile_chain(src, out, visual, tile,
                           post=_breathing_filter(tile, listener.offset, total_dur))
    return _tile_chain(src, out, visual, tile)


def _reaction_video_chain(src: str, j: int, visual: SpeakerVisual, tile: Rect,
                          reaction: SegmentReaction) -> str:
    """Opaque listener tile playing reaction ``j`` from ``reaction.at`` → ``[rx{j}]``.

    The keyed clip is flattened on the tile colour so it fully covers the
    idle source, and its alpha fades in/out over ``REACTION_FADE_SEC``.
    """
    d = reaction.duration
    fade = min(REACTION_FADE_SEC, d / 2)
    key = "" if reaction.has_alpha else _chroma_filter(visual.chroma_key)
    return (
        f"{src}trim=duration={d:.3f},setpts=PTS-STARTPTS,{key}{_crop_filter(visual.crop)},"
        f"scale={tile.w}:{tile.h}:force_original_aspect_ratio=decrease,setsar=1,"
        f"format=rgba,pad={tile.w}:{tile.h}:(ow-iw)/2:oh-ih:color=black@0,"
        f"format=yuva420p,fps={FPS}[rxk{j}];"
        f"color=c={TILE_BG_COLOR}:s={tile.w}x{tile.h}:r={FPS}:d={d:.3f},format=yuv420p[rxb{j}];"
        f"[rxb{j}][rxk{j}]overlay=format=auto,format=yuva420p,"
        f"fade=t=in:st=0:d={fade:.3f}:alpha=1,"
        f"fade=t=out:st={d - fade:.3f}:d={fade:.3f}:alpha=1,"
        f"setpts=PTS+{reaction.at:.3f}/TB[rx{j}];"
    )


def _truncate(text: str, limit: int) -> str:
    text = (text or "").strip()
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "\u2026"


def _drawtext(text: str, x: str, y: int | str, size: int, color: str) -> str:
    return (
        f"drawtext=text='{_esc(text)}':x={x}:y={y}:fontsize={size}:"
        f"fontcolor={color}{_font_arg()}"
    )


def _label_filters(geo: LayoutGeometry, active_speaker: str,
                   names: dict[str, str], language: Optional[str] = None) -> list[str]:
    """drawbox/drawtext filters for the speaker name labels (same sizes for both)."""
    wording = card_wording(language)
    roles = {"interviewer": wording.interviewer, "expert": wording.expert}
    lz = geo.label_zone
    parts: list[str] = []
    if geo.slide is not None:
        # Both names in the centre label zone, each next to its own tile.
        for speaker in ("interviewer", "expert"):
            active = speaker == active_speaker
            name = _truncate(names.get(speaker, ""), 22)
            name_color = "white" if active else "#94A3B8"
            role_color = "#F2B8A0" if active else "#64748B"
            if speaker == "interviewer":
                x = str(lz.x + 28)
                bar_x = lz.x + 10
            else:
                x = f"{lz.x + lz.w - 28}-text_w"
                bar_x = lz.x + lz.w - 16
            if active:
                parts.append(
                    f"drawbox=x={bar_x}:y={lz.y + 14}:w=6:h=68:color={ACCENT_COLOR}:t=fill"
                )
            parts.append(_drawtext(name, x, lz.y + 14, LABEL_NAME_SIZE, name_color))
            parts.append(_drawtext(roles[speaker], x, lz.y + 56, LABEL_ROLE_SIZE, role_color))
    else:
        # One "Name · Role" line centred under each tile.
        for speaker in ("interviewer", "expert"):
            active = speaker == active_speaker
            tile = geo.tile(speaker)
            label = f"{_truncate(names.get(speaker, ''), 40)} \u00b7 {roles[speaker]}"
            color = "white" if active else "#94A3B8"
            parts.append(_drawtext(label, f"{tile.x}+({tile.w}-text_w)/2", lz.y + 12,
                                   LABEL_LINE_SIZE, color))
            if active:
                parts.append(
                    f"drawbox=x={tile.cx - 90}:y={lz.y + 50}:w=180:h=4:color={ACCENT_COLOR}:t=fill"
                )
    return parts


def _segment_input_indices(*, layout: str = DEFAULT_LAYOUT, has_listener: bool = True,
                           n_reactions: int = 0, dissolve: bool = False) -> SegmentInputs:
    """Input order of a segment render (mirrored by ``_segment_inputs``)."""
    geo = get_layout(layout)
    nxt = 0
    slide: Optional[int] = None
    if geo.slide:
        slide, nxt = 0, 1
    active = nxt
    nxt += 1
    listener: Optional[int] = None
    if has_listener:
        listener = nxt
        nxt += 1
    rx = tuple((nxt + 2 * j, nxt + 2 * j + 1) for j in range(n_reactions))
    nxt += 2 * n_reactions
    return SegmentInputs(slide=slide, active=active, listener=listener, reactions=rx,
                         prev=nxt if dissolve else None)


def _build_segment_filter(
    *,
    active_speaker: str,
    total_dur: float,
    active: SpeakerVisual,
    idle: SpeakerVisual,
    names: dict[str, str],
    layout: str = DEFAULT_LAYOUT,
    lead_in: float = 0.0,
    has_idle: bool = True,
    slide_counter: Optional[str] = None,
    listener: Optional[ListenerSource] = None,
    reactions: Sequence[SegmentReaction] = (),
    dissolve: bool = False,
    language: Optional[str] = None,
) -> str:
    """Pure builder of the per-segment ``-filter_complex`` graph.

    Input indices (``_segment_input_indices``): with slides ``0`` = slide
    still, then the active clip (video + audio), the listener source (still,
    single still frame for the sway, or idle loop; absent when ``has_idle``
    is False), two inputs per reaction (clip video, clip audio) and finally
    the previous segment's last frame when ``dissolve``. ``listener``
    defaults to the plain still. ``language`` (the episode's) picks the role
    labels (English when absent or unknown). Outputs ``[vout]`` and ``[aout]``.
    """
    geo = get_layout(layout)
    idle_speaker = _other(active_speaker)
    if not has_idle:
        listener = None
    elif listener is None:
        listener = ListenerSource("still")
    reactions = tuple(reactions)
    idx = _segment_input_indices(layout=geo.name, has_listener=listener is not None,
                                 n_reactions=len(reactions), dissolve=dissolve)
    act_in, act_a = f"[{idx.active}:v]", f"[{idx.active}:a]"
    a_tile, i_tile = geo.tile(active_speaker), geo.tile(idle_speaker)

    parts: list[str] = []
    canvas = (
        f"color=c={BG_COLOR}:s={VIDEO_W}x{VIDEO_H}:r={FPS}:d={total_dur:.3f},format=yuv420p"
    )
    for t in (geo.interviewer_tile, geo.expert_tile):
        canvas += f",drawbox=x={t.x}:y={t.y}:w={t.w}:h={t.h}:color={TILE_BG_COLOR}:t=fill"
    parts.append(f"{canvas}[bg];")

    if geo.slide:
        s = geo.slide
        parts.append(
            f"[0:v]scale={s.w}:{s.h}:force_original_aspect_ratio=decrease,"
            f"pad={s.w}:{s.h}:(ow-iw)/2:(oh-ih)/2:color={BG_COLOR},setsar=1,"
            f"fps={FPS}[slide];"
        )

    # Prepend a cloned frame to the active avatar if lead_in > 0 so its
    # lip-sync stays aligned with the (delayed) audio.
    pre = f"tpad=start_duration={lead_in:.3f}:start_mode=clone," if lead_in > 0 else ""
    parts.append(_tile_chain(act_in, "[av_a]", active, a_tile, pre=pre))
    if listener is not None:
        parts.append(_listener_chain(f"[{idx.listener}:v]", "[av_i]", idle, i_tile,
                                     listener, total_dur))
    for j, r in enumerate(reactions):
        parts.append(_reaction_video_chain(f"[{idx.reactions[j][0]}:v]", j, idle, i_tile, r))

    cur = "[bg]"
    if geo.slide:
        parts.append(f"{cur}[slide]overlay=x={geo.slide.x}:y={geo.slide.y}[c_s];")
        cur = "[c_s]"
    parts.append(f"{cur}[av_a]overlay=x={a_tile.x}:y={a_tile.y}[c_a];")
    cur = "[c_a]"
    if listener is not None:
        parts.append(f"{cur}[av_i]overlay=x={i_tile.x}:y={i_tile.y}[c_i];")
        cur = "[c_i]"
    for j, r in enumerate(reactions):
        parts.append(
            f"{cur}[rx{j}]overlay=x={i_tile.x}:y={i_tile.y}:eof_action=pass:"
            f"enable='between(t,{r.at:.3f},{r.at + r.duration:.3f})'[c_r{j}];"
        )
        cur = f"[c_r{j}]"

    deco = [
        f"drawbox=x={a_tile.x}:y={a_tile.y}:w={a_tile.w}:h={a_tile.h}:"
        f"color={ACCENT_COLOR}:t={FRAME_PX}",
        f"drawbox=x={a_tile.x + FRAME_PX}:y={a_tile.y + FRAME_PX}:"
        f"w={a_tile.w - 2 * FRAME_PX}:h={a_tile.h - 2 * FRAME_PX}:"
        f"color={ACCENT_COLOR}@{GLOW_ALPHA}:t={GLOW_PX}",
        f"drawbox=x={i_tile.x}:y={i_tile.y}:w={i_tile.w}:h={i_tile.h}:"
        f"color={LISTENER_BORDER_COLOR}:t={LISTENER_BORDER_PX}",
    ]
    deco += _label_filters(geo, active_speaker, names, language)
    if geo.slide and slide_counter:
        gx = geo.slide.x + geo.slide.w   # right gutter
        deco.append(_drawtext(
            slide_counter, f"{gx}+({VIDEO_W - gx}-text_w)/2", VIDEO_H - 64, 28, "#94A3B8",
        ))
    if dissolve:
        # 160 ms whole-frame dissolve from the previous segment's last frame;
        # offset 0 keeps the segment length unchanged. xfade needs a known
        # constant frame rate on both inputs, and setpts resets it to unknown
        # on ffmpeg ≥ 6.1, so fps closes both chains.
        parts.append(f"{cur}{','.join(deco)},format=yuv420p,setsar=1,fps={FPS}[vmain];")
        parts.append(
            f"[{idx.prev}:v]scale={VIDEO_W}:{VIDEO_H},setsar=1,format=yuv420p,"
            f"trim=duration={DISSOLVE_SEC:.2f},setpts=PTS-STARTPTS,fps={FPS}[vprev];"
        )
        parts.append(
            f"[vprev][vmain]xfade=transition=fade:duration={DISSOLVE_SEC:.2f}:offset=0[vout];"
        )
    else:
        parts.append(f"{cur}{','.join(deco)}[vout];")

    if lead_in > 0:
        ms = int(lead_in * 1000)
        speech = f"{act_a}adelay={ms}|{ms}"
    else:
        speech = f"{act_a}anull"
    if not reactions:
        parts.append(f"{speech}[aout]")
        return "".join(parts)
    parts.append(f"{speech}[spk];")
    pads = ["[spk]"]
    for j, r in enumerate(reactions):
        ms = int(round(r.at * 1000))
        fade = min(REACTION_AUDIO_FADE_SEC, r.duration / 4)
        parts.append(
            f"[{idx.reactions[j][1]}:a]atrim=duration={r.duration:.3f},asetpts=PTS-STARTPTS,"
            f"afade=t=in:st=0:d={fade:.3f},afade=t=out:st={r.duration - fade:.3f}:d={fade:.3f},"
            f"volume={r.gain_db:.2f}dB,adelay=delays={ms}:all=1[ra{j}];"
        )
        pads.append(f"[ra{j}]")
    # Backchannels sit under the speaker: plain sum (no normalisation), speech length.
    parts.append(
        f"{''.join(pads)}amix=inputs={len(pads)}:normalize=0:duration=first:"
        f"dropout_transition=0[aout]"
    )
    return "".join(parts)


def _loop_count(listener: ListenerSource, total_dur: float) -> int:
    """``-stream_loop`` value covering ``offset + total_dur`` with one spare pass.

    Finite on purpose: with ``-1`` the threaded ffmpeg scheduler (7.x+) was
    seen to deadlock now and then once the graph had trimmed what it needed.
    Unknown loop length → ``-1`` (callers bound the render with a timeout).
    """
    if not (math.isfinite(listener.loop_duration) and listener.loop_duration > 0):
        return -1
    return max(1, math.ceil((max(0.0, listener.offset) + total_dur) / listener.loop_duration))


def _listener_input_args(listener: ListenerSource, total_dur: float) -> list[str]:
    path = str(listener.path)
    if listener.mode == "idle_loop":
        # Looped input; the graph trims it from the chosen offset. Its audio
        # is never mapped.
        return ["-stream_loop", str(_loop_count(listener, total_dur)),
                *_decoder_args(Path(path)), "-i", path]
    if listener.mode == "procedural":
        return ["-i", path]          # one frame, looped inside the graph after the ×4 upscale
    return ["-loop", "1", "-t", f"{total_dur:.3f}", "-i", path]


def _segment_inputs(
    *,
    layout: str,
    total_dur: float,
    slide_path: Optional[Path],
    clip_path: Path,
    listener: Optional[ListenerSource],
    reactions: Sequence[SegmentReaction] = (),
    prev_frame: Optional[Path] = None,
) -> list[str]:
    """``ffmpeg`` input arguments in ``_segment_input_indices`` order."""
    geo = get_layout(layout)
    args: list[str] = []
    if geo.slide:
        if slide_path is None:
            raise ValueError("slide_path is required for layout " + geo.name)
        args += ["-loop", "1", "-t", f"{total_dur:.3f}", "-i", str(slide_path)]
    args += [*_decoder_args(clip_path), "-i", str(clip_path)]
    if listener is not None:
        args += _listener_input_args(listener, total_dur)
    for r in reactions:
        args += [*_decoder_args(Path(r.video)), "-i", str(r.video), "-i", str(r.audio)]
    if prev_frame is not None:
        args += ["-loop", "1", "-framerate", str(FPS),
                 "-t", f"{DISSOLVE_SEC + 2.0 / FPS:.2f}", "-i", str(prev_frame)]
    return args


def _render_segment(
    clip_path: Path,
    idle_frame: Optional[Path],
    slide_path: Optional[Path],
    duration: float,
    active_speaker: str,
    roles: RenderRoles,
    out: Path,
    lead_in: float = 0.0,
    chroma_key: bool = False,
    *,
    idle_chroma_key: Optional[bool] = None,
    active_crop: Optional[tuple[float, float, float, float]] = None,
    idle_crop: Optional[tuple[float, float, float, float]] = None,
    layout: str = DEFAULT_LAYOUT,
    slide_counter: Optional[str] = None,
    listener: Optional[ListenerSource] = None,
    reactions: Sequence[SegmentReaction] = (),
    prev_frame: Optional[Path] = None,
    language: Optional[str] = None,
) -> None:
    """Render a single dialogue segment to MP4 (see module docstring for layout).

    ``listener`` fills the listener tile (default: ``idle_frame`` as a plain
    still; no tile without either) — never the listener's own talking
    footage, which would make it gesture/lip-sync during the active turn.
    ``reactions`` overlay backchannel clips on the listener tile and mix
    their audio; ``prev_frame`` (the previous segment's last frame) opens
    the segment with a dissolve; ``language`` picks the role labels. If
    ``lead_in > 0`` leading silence is added so the first word isn't clipped.
    """
    geo = get_layout(layout)
    total_dur = duration + lead_in
    if listener is None and idle_frame is not None and Path(idle_frame).exists():
        listener = ListenerSource("still", Path(idle_frame))
    if listener is not None and (listener.path is None or not Path(listener.path).is_file()):
        raise RuntimeError(f"listener {listener.mode} source missing")
    if listener is not None and listener.mode == "idle_loop" and not listener.loop_duration > 0:
        listener = replace(listener, loop_duration=_safe_probe_duration(Path(listener.path)))
    reactions = tuple(reactions)
    dissolve = (
        prev_frame is not None and Path(prev_frame).is_file() and total_dur >= 3 * DISSOLVE_SEC
    )

    inputs = _segment_inputs(
        layout=geo.name,
        total_dur=total_dur,
        slide_path=slide_path,
        clip_path=clip_path,
        listener=listener,
        reactions=reactions,
        prev_frame=prev_frame if dissolve else None,
    )

    active = SpeakerVisual(
        chroma_key=chroma_key,
        crop=active_crop or avatar_registry.PODCAST_CROP_PREBUILT,
    )
    idle = SpeakerVisual(
        chroma_key=chroma_key if idle_chroma_key is None else idle_chroma_key,
        crop=idle_crop or avatar_registry.PODCAST_CROP_PREBUILT,
    )
    fc = _build_segment_filter(
        active_speaker=active_speaker,
        total_dur=total_dur,
        active=active,
        idle=idle,
        names={
            "interviewer": roles.interviewer.display_name,
            "expert": roles.expert.display_name,
        },
        layout=geo.name,
        lead_in=lead_in,
        has_idle=listener is not None,
        slide_counter=slide_counter,
        listener=listener,
        reactions=reactions,
        dissolve=dissolve,
        language=language,
    )

    cmd = [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        *inputs,
        "-filter_complex", fc,
        "-map", "[vout]", "-map", "[aout]",
        "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
        # 2 s GOP: the next segment's last-frame grab (-sseof) decodes ≤ 50 frames.
        "-g", str(2 * FPS),
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
        "-r", str(FPS),
        "-t", f"{total_dur:.3f}",
        str(out),
    ]
    # Bounded: a stuck input (e.g. an endless loop that stops yielding frames)
    # fails the attempt instead of hanging the render job.
    _run(cmd, timeout=SEGMENT_TIMEOUT_BASE_SEC + SEGMENT_TIMEOUT_PER_SEC * total_dur)


@functools.lru_cache(maxsize=None)
def _has_decoder(name: str) -> bool:
    try:
        proc = subprocess.run(
            ["ffmpeg", "-hide_banner", "-decoders"], capture_output=True, text=True, timeout=30,
        )
    except Exception:  # noqa: BLE001
        return False
    return any(line.split()[1:2] == [name] for line in proc.stdout.splitlines() if line.strip())


def _probe_video_codec(path: Path) -> str:
    try:
        proc = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=codec_name", "-of", "csv=p=0", str(path)],
            capture_output=True, text=True, timeout=30,
        )
    except Exception:  # noqa: BLE001
        return ""
    return (proc.stdout or "").strip().splitlines()[0].strip() if proc.stdout.strip() else ""


@functools.lru_cache(maxsize=256)
def _cached_video_codec(path: str, mtime_ns: int, size: int) -> str:
    return _probe_video_codec(Path(path))


def _decoder_args(video: Path) -> list[str]:
    """Force libvpx-vp9 for VP9 WebM so the avatar's alpha channel survives.

    ffmpeg's native vp9 decoder silently drops the alpha plane, which turns
    the transparent stage of prebuilt avatars into opaque black.
    """
    video = Path(video)
    if video.suffix.lower() != ".webm":
        return []
    try:
        st = video.stat()
        codec = _cached_video_codec(str(video), st.st_mtime_ns, st.st_size)
    except OSError:
        codec = _probe_video_codec(video)
    if codec == "vp9" and _has_decoder("libvpx-vp9"):
        return ["-c:v", "libvpx-vp9"]
    return []


def _extract_frame(video: Path, out_png: Path, at_sec: float = 0.1) -> Path:
    """Grab one frame from `video` at `at_sec` seconds, save as PNG (keeps alpha)."""
    _run([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-ss", f"{at_sec:.3f}", *_decoder_args(video), "-i", str(video),
        "-frames:v", "1", "-q:v", "2", str(out_png),
    ])
    return out_png


def _extract_last_frame(video: Path, out_png: Path) -> Optional[Path]:
    """Last frame of a rendered segment as PNG (the next dissolve's source), or None."""
    try:
        out_png.unlink(missing_ok=True)
        _run([
            "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
            "-sseof", "-0.12", "-i", str(video),
            "-an", "-compression_level", "1", "-update", "1", str(out_png),
        ])
    except (RuntimeError, OSError) as exc:
        log.warning("podcast compose: last-frame grab failed — no dissolve (%s)", type(exc).__name__)
        return None
    return out_png if out_png.is_file() and out_png.stat().st_size > 0 else None


# ---------------------------------------------------------------------------
# Concat / finalize / extract
# ---------------------------------------------------------------------------

def _concat(parts: list[Path], out: Path) -> None:
    """Concatenate MP4 segments with FULL re-encode.

    The concat *demuxer* with `-c copy` produces clicks at AAC frame
    boundaries AND can desync when segments have slightly different PTS
    origins. Using the concat *filter* (via `-filter_complex`) resamples
    timestamps from zero and eliminates both artifacts.

    Cost: re-encode time (≈1× realtime). For a <10-min podcast this is
    acceptable and far preferable to audible noise.
    """
    if len(parts) == 1:
        shutil.copyfile(parts[0], out)
        return

    inputs: list[str] = []
    for p in parts:
        inputs += ["-i", str(p)]

    n = len(parts)
    # [0:v][a0][1:v][a1]...concat=n=N:v=1:a=1[vout][aout] — each part's audio
    # is padded/trimmed to its video length, so AAC end padding never shifts
    # later parts (turn offsets and captions stay on the video timeline).
    chains: list[str] = []
    refs: list[str] = []
    for i, p in enumerate(parts):
        vdur = _probe_video_duration(p)
        if vdur > 0:
            chains.append(f"[{i}:a]apad=whole_dur={vdur:.3f},atrim=duration={vdur:.3f}[a{i}];")
            refs.append(f"[{i}:v][a{i}]")
        else:
            refs.append(f"[{i}:v][{i}:a]")
    fc = "".join(chains) + f"{''.join(refs)}concat=n={n}:v=1:a=1[vout][aout]"

    _run([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        *inputs,
        "-filter_complex", fc,
        "-map", "[vout]", "-map", "[aout]",
        "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
        "-r", str(FPS),
        str(out),
    ])


def _finalize(src: Path, ass_path: Path, out: Path, music_path: Optional[Path]) -> None:
    """Burn subtitles, mix music, normalize loudness."""
    ass_arg = ass_path.resolve().as_posix().replace(":", "\\:")
    fc_video = f"[0:v]subtitles='{ass_arg}'[vout]"

    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", str(src)]
    if music_path and Path(music_path).exists():
        cmd += ["-stream_loop", "-1", "-i", str(music_path)]
        fc_audio = (
            "[1:a]volume=-25dB,aloop=loop=-1:size=2e9[mus];"
            "[0:a][mus]amix=inputs=2:duration=first:dropout_transition=2[mix];"
            "[mix]loudnorm=I=-16:TP=-1.5:LRA=11[aout]"
        )
    else:
        fc_audio = "[0:a]loudnorm=I=-16:TP=-1.5:LRA=11[aout]"

    cmd += [
        "-filter_complex", f"{fc_video};{fc_audio}",
        "-map", "[vout]", "-map", "[aout]",
        "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
        # loudnorm resamples to 192 kHz internally: deliver 48 kHz AAC.
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
        "-shortest",
        str(out),
    ]
    _run(cmd)


def _extract_mp3(src: Path, out: Path) -> None:
    _run([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-i", str(src), "-vn", "-acodec", "libmp3lame", "-q:a", "2", str(out),
    ])


def _render_card(out: Path, title: str, duration: float, audio: Optional[Path] = None,
                 subtitle: str = _ENGLISH.tagline) -> None:
    """Branded title card; ``audio`` (the sonic logo) is padded/trimmed to the card."""
    fc = (
        f"color=c={BG_COLOR}:s={VIDEO_W}x{VIDEO_H}:r={FPS}:d={duration:.3f},"
        f"drawtext=text='{_esc(title)}':fontcolor=#C8412B:fontsize=96{_font_arg()}:"
        "x=(w-text_w)/2:y=(h-text_h)/2-40,"
        f"drawtext=text='{_esc(subtitle)}':fontcolor=white:fontsize=36{_font_arg()}:"
        "x=(w-text_w)/2:y=(h-text_h)/2+80[v]"
    )
    if audio is not None:
        inputs = ["-i", str(audio)]
        fc += f";[0:a]apad=whole_dur={duration:.3f},atrim=duration={duration:.3f}[a]"
        audio_map = "[a]"
    else:
        inputs = ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"]
        audio_map = "0:a"
    _run([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        *inputs,
        "-filter_complex", fc,
        "-map", "[v]", "-map", audio_map,
        "-t", f"{duration:.3f}",
        "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
        "-r", str(FPS),
        str(out),
    ])


def _render_card_with_jingle(out: Path, title: str, duration: float, kind: str,
                             out_dir: Path, subtitle: str = _ENGLISH.tagline) -> None:
    """Title card carrying the ``kind`` sonic logo; a silent card if the logo fails."""
    try:
        jingle = render_jingle(kind, out_dir / f"_jingle_{kind}.wav")  # type: ignore[arg-type]
        _render_card(out, title, duration, audio=jingle, subtitle=subtitle)
        return
    except Exception as exc:  # noqa: BLE001 — a silent card beats a failed render
        log.warning("podcast compose: %s sonic logo failed — silent card (%s)", kind, type(exc).__name__)
    _render_card(out, title, duration, subtitle=subtitle)


# ---------------------------------------------------------------------------
# Slide resolution
# ---------------------------------------------------------------------------

def _resolve_slides(
    document: Optional[Document], script: Script, out_dir: Path,
) -> dict[int, tuple[Optional[Path], Optional[str]]]:
    """Map turn idx → (slide image path or None for fallback, "n / N" counter)."""
    images = list(document.slide_images) if document else []
    total = len(images)
    resolved: dict[int, tuple[Optional[Path], Optional[str]]] = {}
    warned: set[int] = set()
    for turn in sorted(script.turns, key=lambda t: t.idx):
        if not images:
            resolved[turn.idx] = (None, None)
            continue
        slide_idx = turn.slide_idx if turn.slide_idx is not None else 0
        idx = max(0, min(slide_idx, total - 1))
        raw = images[idx]
        p = Path(raw) if raw else None
        if p is not None and p.is_file():
            resolved[turn.idx] = (p, f"{idx + 1} / {total}")
        else:
            if idx not in warned:
                log.warning("podcast compose: slide %d image missing (%r) — using fallback slide",
                            idx + 1, raw)
                warned.add(idx)
            resolved[turn.idx] = (None, None)
    return resolved


def _fallback_slide(document: Optional[Document], out_dir: Path) -> Path:
    out = out_dir / "_fallback_slide.png"
    if not out.exists():
        _make_fallback_slide(out, (document.title if document else "") or "Oz Radio")
    return out


def _make_fallback_slide(out: Path, title: str) -> None:
    """Title card rendered at the slide's native 1280x720 (16:9)."""
    s = LAYOUTS[DEFAULT_LAYOUT].slide
    assert s is not None
    vf = (
        f"drawtext=text='{_esc(_truncate(title, 40))}':fontcolor=white:fontsize=56{_font_arg()}:"
        "x=(w-text_w)/2:y=(h-text_h)/2"
    )
    _run([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", f"color=c=#1E293B:s={s.w}x{s.h}:d=0.04",
        "-vf", vf,
        "-frames:v", "1", str(out),
    ])


# ---------------------------------------------------------------------------
# Subtitles — ASS karaoke + SRT
# ---------------------------------------------------------------------------

def _ass_header(layout: str = DEFAULT_LAYOUT) -> str:
    """ASS header whose margins confine text to the layout's caption zone."""
    geo = get_layout(layout)
    cz = geo.caption_zone
    margin_l = cz.x + 20
    margin_r = VIDEO_W - (cz.x + cz.w) + 20
    return f"""[Script Info]
ScriptType: v4.00+
PlayResX: {VIDEO_W}
PlayResY: {VIDEO_H}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Karaoke,Arial,{geo.caption_font_size},&H00FFFFFF&,&H0000C8FF&,&H00000000&,&H80000000&,1,0,0,0,100,100,0,0,1,3,1,5,{margin_l},{margin_r},0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""


# Back-compat: the default-layout header.
ASS_HEADER = _ass_header(DEFAULT_LAYOUT)


def _chunk_text(text: str, max_chars: int = 80) -> list[str]:
    """Split text into subtitle-friendly chunks by sentence, then by max_chars."""
    sentences = re.split(r'(?<=[.!?])\s+', text.strip())

    chunks: list[str] = []
    current = ""
    for sentence in sentences:
        if current and len(current) + len(sentence) + 1 > max_chars:
            chunks.append(current.strip())
            current = sentence
        else:
            current = f"{current} {sentence}".strip() if current else sentence
    if current:
        chunks.append(current.strip())

    final: list[str] = []
    for chunk in chunks:
        if len(chunk) <= max_chars:
            final.append(chunk)
        else:
            words = chunk.split()
            line = ""
            for word in words:
                if line and len(line) + len(word) + 1 > max_chars:
                    final.append(line.strip())
                    line = word
                else:
                    line = f"{line} {word}".strip() if line else word
            if line:
                final.append(line.strip())

    return final if final else [text.strip()]


def _greedy_wrap(pieces: list[str], max_chars: int) -> list[list[str]]:
    lines: list[list[str]] = []
    cur: list[str] = []
    cur_len = 0
    for w in pieces:
        add = len(w) + (1 if cur else 0)
        if cur and cur_len + add > max_chars:
            lines.append(cur)
            cur, cur_len = [w], len(w)
        else:
            cur.append(w)
            cur_len += add
    if cur:
        lines.append(cur)
    return lines


def _wrap_words(words: list[str], max_chars: int) -> list[list[str]]:
    """Balanced word wrap into lines of ≤ max_chars (over-long words are split).

    Uses the greedy line count, then the narrowest width that keeps that count
    so lines come out even (no lone trailing word).
    """
    pieces: list[str] = []
    for w in words:
        while len(w) > max_chars:
            pieces.append(w[:max_chars])
            w = w[max_chars:]
        if w:
            pieces.append(w)
    greedy = _greedy_wrap(pieces, max_chars)
    n = len(greedy)
    if n <= 1:
        return greedy
    longest = max(len(p) for p in pieces)
    for width in range(max(longest, len(" ".join(pieces)) // n), max_chars):
        lines = _greedy_wrap(pieces, width)
        if len(lines) <= n:
            return lines
    return greedy


def _caption_blocks(text: str, max_chars: int, max_lines: int) -> list[list[list[str]]]:
    """Wrap ``text`` and group the lines into on-screen events of ≤ max_lines."""
    words = [_ass_esc(w) for w in text.split()]
    words = [w for w in words if w]
    lines = _wrap_words(words, max_chars)
    return [lines[i:i + max_lines] for i in range(0, len(lines), max_lines)]


def _write_ass(path, clips, durations, turn_by_idx, roles, offset=0.0,
               layout: str = DEFAULT_LAYOUT):
    geo = get_layout(layout)
    cz = geo.caption_zone
    pos = f"{{\\an5\\pos({cz.cx},{cz.cy})}}"
    lines = [_ass_header(geo.name)]
    cursor = offset
    for clip, dur in zip(clips, durations):
        turn = turn_by_idx.get(clip.turn_idx)
        text = (turn.text if turn else "").strip()
        if not text:
            cursor += dur
            continue

        chunks = _chunk_text(text)
        total_words = len(text.split())
        chunk_cursor = cursor

        for chunk in chunks:
            chunk_dur = dur * (len(chunk.split()) / max(1, total_words))
            blocks = _caption_blocks(chunk, geo.caption_max_chars, geo.caption_max_lines)
            block_words_total = sum(len(ln) for b in blocks for ln in b) or 1
            block_cursor = chunk_cursor
            for block in blocks:
                n_words = sum(len(ln) for ln in block)
                block_dur = chunk_dur * (n_words / block_words_total)
                per = max(0.001, block_dur / max(1, n_words))
                kara = "\\N".join(
                    " ".join(f"{{\\k{int(per * 100)}}}{w}" for w in ln) for ln in block
                )
                start_ts = _ass_time(block_cursor)
                end_ts = _ass_time(block_cursor + block_dur)
                lines.append(f"Dialogue: 0,{start_ts},{end_ts},Karaoke,,0,0,0,,{pos}{kara}")
                block_cursor += block_dur
            chunk_cursor += chunk_dur

        cursor += dur
    path.write_text("\n".join(lines), encoding="utf-8")


def _write_srt(path, clips, durations, turn_by_idx, roles, offset=0.0):
    out_lines: list[str] = []
    cursor = offset
    cue_num = 0
    for clip, dur in zip(clips, durations):
        turn = turn_by_idx.get(clip.turn_idx)
        text = (turn.text if turn else "").strip()
        speaker_label = (
            roles.interviewer.display_name if clip.speaker == "interviewer"
            else roles.expert.display_name
        )
        if not text:
            cursor += dur
            continue

        chunks = _chunk_text(text)
        total_words = len(text.split())
        chunk_cursor = cursor

        for chunk in chunks:
            cue_num += 1
            chunk_words = chunk.split()
            chunk_dur = dur * (len(chunk_words) / max(1, total_words))
            out_lines.append(str(cue_num))
            out_lines.append(f"{_srt_time(chunk_cursor)} --> {_srt_time(chunk_cursor + chunk_dur)}")
            out_lines.append(f"{speaker_label}: {chunk}")
            out_lines.append("")
            chunk_cursor += chunk_dur

        cursor += dur
    path.write_text("\n".join(out_lines), encoding="utf-8")


# ---------------------------------------------------------------------------
# Tiny utilities
# ---------------------------------------------------------------------------

def _run(cmd: list[str], timeout: Optional[float] = None) -> None:
    log.debug("$ %s", " ".join(cmd))
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        log.error("ffmpeg timed out after %.0f s: %s", timeout or 0, " ".join(cmd[:3]))
        raise RuntimeError(f"ffmpeg timed out after {timeout or 0:.0f} s") from exc
    if proc.returncode != 0:
        log.error("ffmpeg failed: %s\nSTDERR: %s", " ".join(cmd[:3]), proc.stderr[-2000:])
        raise RuntimeError(f"ffmpeg/ffprobe failed: {proc.stderr[-500:]}")


def _require_tool(name: str) -> None:
    if shutil.which(name) is None:
        raise RuntimeError(f"required tool missing on PATH: {name}")


def _probe_duration(path: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", str(path)],
        capture_output=True, text=True, check=True,
    )
    data = json.loads(out.stdout)
    return float(data.get("format", {}).get("duration", 0.0) or 0.0)


def _safe_probe_duration(path: Path) -> float:
    """Container duration in seconds, or 0.0 when unknown/unreadable."""
    try:
        duration = _probe_duration(Path(path))
    except Exception:  # noqa: BLE001
        return 0.0
    return duration if math.isfinite(duration) and duration > 0 else 0.0


def _probe_video_duration(path: Path) -> float:
    """First video stream's duration in seconds (frames × 1/25 for our renders), or 0.0."""
    try:
        proc = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=duration", "-of", "csv=p=0", str(path)],
            capture_output=True, text=True, timeout=30,
        )
        duration = float((proc.stdout or "").strip().splitlines()[0])
    except Exception:  # noqa: BLE001
        return 0.0
    return duration if math.isfinite(duration) and duration > 0 else 0.0


_DRAWTEXT_ESC = str.maketrans({
    "\\": "\\\\", ":": "\\:", "'": "\u2019", "%": "\\%",
})


def _esc(text: str) -> str:
    return (text or "").translate(_DRAWTEXT_ESC)


def _ass_esc(word: str) -> str:
    return re.sub(r"[{}\\]", "", word)


def _ass_time(t: float) -> str:
    h = int(t // 3600)
    m = int((t % 3600) // 60)
    s = t % 60
    return f"{h}:{m:02d}:{s:05.2f}"


def _srt_time(t: float) -> str:
    h = int(t // 3600)
    m = int((t % 3600) // 60)
    s = int(t % 60)
    ms = int((t - int(t)) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


# Re-expose for tests
__all__ = [
    "CARD_WORDING",
    "CardWording",
    "ComposeResult",
    "LAYOUTS",
    "ListenerSource",
    "MUSIC_DEFAULT",
    "SegmentReaction",
    "card_wording",
    "choose_loop_offset",
    "compose_podcast",
    "get_layout",
]
