"""Pydantic models shared by podcast endpoints and services.

Internal (non-HTTP) types shared by the render engines — turn audio, listener
kits, reaction placements, radio results, library files — live in
``services.podcast_media``.
"""
from __future__ import annotations

from enum import Enum
from typing import Literal, Optional, get_args

from pydantic import BaseModel, Field, model_validator


# -----------------------------------------------------------------------------
# Ingestion
# -----------------------------------------------------------------------------

SourceKind = Literal["pptx", "pdf", "docx", "txt", "md", "url"]


class Section(BaseModel):
    heading: str = ""
    text: str


class Document(BaseModel):
    id: str
    title: str
    source_kind: SourceKind
    sections: list[Section] = []
    # PPTX only
    slide_images: list[str] = Field(
        default_factory=list, description="Ordered blob URLs or local paths (PPTX only)"
    )
    slide_titles: list[str] = Field(default_factory=list)
    slide_notes: list[str] = Field(default_factory=list)


class IngestResponse(BaseModel):
    document: Document


# -----------------------------------------------------------------------------
# Script
# -----------------------------------------------------------------------------

Speaker = Literal["interviewer", "expert"]
Style = Literal["casual", "formal", "debate", "explainer"]
Length = Literal["short", "medium", "long"]  # ~3 / ~6 / ~10 min
# Target listener expertise; None keeps the generic (pre-existing) prompt.
AudienceLevel = Literal["beginner", "practitioner", "expert"]


def audience_level_or_none(value: object) -> Optional[str]:
    """Known audience level (e.g. from a stored manifest), else None."""
    return value if isinstance(value, str) and value in get_args(AudienceLevel) else None


class WordTiming(BaseModel):
    word: str
    start_sec: float
    end_sec: float


# Stable, language-independent backchannel ids. The spoken text is resolved
# server-side per language (``podcast_media.reaction_text``), never by the LLM.
ReactionId = Literal["ack", "right", "yeah", "exactly", "isee", "interesting"]


class ReactionHint(BaseModel):
    """Listener backchannel requested by the script for one turn (at most one).

    The *other* host reacts right after sentence ``after_sentence`` (1-based,
    counted with the same sentence splitter as ``avatar.build_ssml``) of the
    turn. Hints that do not fit are dropped by ``podcast_reactions.plan_reactions``.
    """
    after_sentence: int = Field(..., ge=1, le=20)
    reaction_id: ReactionId


class DialogueTurn(BaseModel):
    idx: int
    speaker: Speaker
    text: str
    # When source document is a PPTX, GPT assigns the slide that should be
    # visible while this turn is spoken. 0-based index into Document.slide_images.
    slide_idx: Optional[int] = None
    # Populated after render, from the batch avatar WebVTT output.
    word_timings: list[WordTiming] = Field(default_factory=list)
    reaction: Optional[ReactionHint] = None


class Script(BaseModel):
    id: str
    document_id: str
    language: str = "en-US"
    style: Style = "casual"
    length: Length = "medium"
    audience_level: Optional[AudienceLevel] = None
    turns: list[DialogueTurn]


class ScriptRequest(BaseModel):
    document_id: str = Field(..., max_length=64)
    language: str = Field("en-US", max_length=16)
    style: Style = "casual"
    length: Length = "medium"
    num_turns: int = Field(8, ge=4, le=16)
    focus: Optional[str] = Field(None, max_length=500, description="Optional topic focus or angle")
    audience_level: Optional[AudienceLevel] = Field(
        None, description="Target audience expertise; null keeps the generic prompt"
    )


class ScriptPatch(BaseModel):
    turns: list[DialogueTurn]


# -----------------------------------------------------------------------------
# Render
# -----------------------------------------------------------------------------

# "video" = MP4 + radio MP3 (Watch and Listen); "audio" = radio MP3 only
# (no avatar synthesis: plain TTS, fast and cheap).
PodcastFormat = Literal["video", "audio"]
# "radio_mix" = dedicated radio master; "soundtrack" = fallback ripped from the MP4.
AudioKind = Literal["radio_mix", "soundtrack"]


def podcast_format_or_default(value: object) -> PodcastFormat:
    """Known format (e.g. from a stored manifest), else ``"video"`` (legacy items)."""
    return "audio" if value == "audio" else "video"


class RoleConfig(BaseModel):
    display_name: str = Field(..., max_length=80)
    # Registry id, e.g. 'lisa', 'photo_female'. May be empty only for audio-only
    # renders (enforced by RenderRequest); registry checks stay in the router.
    avatar: str = Field("", max_length=64)
    voice: str = Field(..., max_length=100)  # e.g. 'en-US-Ava:DragonHDLatestNeural'


class RenderRoles(BaseModel):
    interviewer: RoleConfig
    expert: RoleConfig


Layout = Literal["split_screen_with_slides", "split_screen_only"]


class RenderRequest(BaseModel):
    script_id: str = Field(..., max_length=32)
    roles: RenderRoles
    layout: Layout = "split_screen_with_slides"
    music: bool = True
    intro: bool = True
    background_image: Optional[str] = None
    format: PodcastFormat = "video"
    # Listener backchannels; effective only when the PODCAST_REACTIONS kill switch is on too.
    reactions: bool = True

    @model_validator(mode="after")
    def _video_needs_avatars(self) -> "RenderRequest":
        if self.format == "video":
            missing = [name for name in ("interviewer", "expert")
                       if not getattr(self.roles, name).avatar.strip()]
            if missing:
                raise ValueError(f"video podcasts need an avatar for each host (missing: {', '.join(missing)})")
        return self


class JobState(str, Enum):
    queued = "queued"
    rendering = "rendering"
    composing = "composing"
    done = "done"
    failed = "failed"
    cancelled = "cancelled"


class JobProgress(BaseModel):
    stage: str = "queued"
    completed: int = 0
    total: int = 0
    message: str = ""


# JobProgress.stage values. Video: queued -> rendering -> composing -> mixing -> done;
# audio: queued -> synthesizing -> mixing -> done; "failed" on error. JobState is
# unchanged: "synthesizing" runs under JobState.rendering, "mixing" under composing.
ProgressStage = Literal["queued", "rendering", "synthesizing", "composing", "mixing", "done", "failed"]
# Kinds served by GET /api/podcast/jobs/{id}/file/{kind} (404 when that rendition is absent).
JobFileKind = Literal["mp4", "mp3", "srt", "audio_srt", "transcript", "cover", "scorm"]


class JobOutputs(BaseModel):
    """Download routes of a finished job; ``None`` when a rendition is absent.

    Audio-only jobs have no ``mp4_url``/``srt_url``. ``mp3_url`` is the radio
    mix (``audio_kind``); ``srt_url`` is timed on the video, ``audio_srt_url``
    on the MP3. ``duration_sec`` is the primary rendition's (video when present).
    """
    mp4_url: Optional[str] = None
    mp3_url: Optional[str] = None
    srt_url: Optional[str] = None
    duration_sec: Optional[float] = None
    audio_srt_url: Optional[str] = None
    transcript_url: Optional[str] = None
    cover_url: Optional[str] = None
    audio_duration_sec: Optional[float] = None
    video_duration_sec: Optional[float] = None
    audio_kind: Optional[AudioKind] = None


ArchiveState = Literal["none", "archiving", "published", "failed"]


class PodcastJob(BaseModel):
    id: str
    script_id: str
    roles: RenderRoles
    layout: Layout
    music: bool
    intro: bool
    state: JobState = JobState.queued
    progress: JobProgress = Field(default_factory=JobProgress)
    outputs: JobOutputs = Field(default_factory=JobOutputs)
    error: Optional[str] = None
    created_at: str
    updated_at: str
    archive_state: ArchiveState = "none"
    library_job_id: Optional[str] = None  # same as job.id once published
    format: PodcastFormat = "video"
    reactions: bool = True  # as requested; see RenderRequest.reactions
    # Stable codes from podcast_media.WARNING_CODES only — never raw exception text.
    warnings: list[str] = Field(default_factory=list)
    # Listener rendering used by the video ("idle_loop" | "procedural" | "still"); None for audio.
    listener_mode: Optional[str] = None


# -----------------------------------------------------------------------------
# Transcript (``transcript.json``, radio timeline)
# -----------------------------------------------------------------------------


class PodcastHost(BaseModel):
    """Public host identity. ``avatar_id`` is a registry id (None = monogram),
    never a Speech character name."""
    role: Speaker
    display_name: str
    avatar_id: Optional[str] = None


class TranscriptTurn(BaseModel):
    """One turn on the radio timeline, in seconds; ``video_*`` locate the same
    turn in the MP4 (Watch <-> Listen position mapping), None without video."""
    turn_idx: int
    speaker: Speaker
    start: float
    end: float
    video_start: Optional[float] = None
    video_end: Optional[float] = None


TranscriptCueKind = Literal["speech", "reaction"]


class TranscriptCue(BaseModel):
    """A caption on the radio timeline; ``reaction`` cues are the listener's
    backchannels (``speaker`` = the listener, ``turn_idx`` = the turn reacted to)."""
    start: float
    end: float
    speaker: Speaker
    turn_idx: int
    text: str
    kind: TranscriptCueKind = "speech"


class Transcript(BaseModel):
    """Radio-timed transcript for the live captions and host lighting (no chapters)."""
    version: int = 1
    duration_sec: float
    hosts: list[PodcastHost] = Field(default_factory=list)
    turns: list[TranscriptTurn] = Field(default_factory=list)
    cues: list[TranscriptCue] = Field(default_factory=list)
    # Waveform: ~240 values in 0..1, evenly spaced over duration_sec.
    peaks: list[float] = Field(default_factory=list)


# -----------------------------------------------------------------------------
# Library
# -----------------------------------------------------------------------------


class LibrarySummary(BaseModel):
    """Lightweight card for the library grid — no media URLs.

    Legacy (v1, video-only) items keep the defaults: a video with its soundtrack.
    """
    job_id: str
    title: str
    document_title: str = ""
    created_at: str
    duration_sec: Optional[float] = None
    language: str = "en-US"
    style: str = "casual"
    audience_level: Optional[AudienceLevel] = None
    speaker_names: list[str] = Field(default_factory=list)
    turn_count: int = 0
    thumbnail_url: Optional[str] = None
    published: bool = False
    format: PodcastFormat = "video"
    has_video: bool = True
    has_audio: bool = True
    audio_duration_sec: Optional[float] = None
    hosts: list[PodcastHost] = Field(default_factory=list)


class LibraryItem(LibrarySummary):
    """Full library item with signed media URLs; use when opening the player."""
    mp4_url: Optional[str] = None
    mp3_url: Optional[str] = None
    srt_url: Optional[str] = None
    scorm_url: Optional[str] = None
    audio_url: Optional[str] = None  # radio MP3 (the player's source; same blob as mp3_url)
    cover_url: Optional[str] = None
    audio_srt_url: Optional[str] = None
    transcript: Optional[Transcript] = None


# -----------------------------------------------------------------------------
# Voices / avatars catalog
# -----------------------------------------------------------------------------


class VoiceOption(BaseModel):
    id: str  # e.g. 'en-US-Ava:DragonHDLatestNeural'
    display_name: str
    language: str
    gender: Literal["male", "female", "neutral"]
    hd: bool = False
    style_list: list[str] = Field(default_factory=list)


class AvatarOption(BaseModel):
    """Public avatar shape (never includes the Speech character name)."""
    id: str
    display_name: str
    gender: str = "female"
    thumbnail_url: str = ""
    is_default: bool = False
    default_style: str = ""  # e.g. 'casual-sitting'; empty for photo avatars


class PublishRequest(BaseModel):
    published: bool
