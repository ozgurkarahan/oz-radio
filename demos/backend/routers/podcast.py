"""
Podcast router — FastAPI endpoints for the dual-avatar podcast generator.

This is a PoC/demo surface. Jobs are held in memory; replace with Cosmos in
production. Long-running render work is kicked off with asyncio background
tasks.

Two render formats (``RenderRequest.format``), both producing the radio mix:

* ``video`` — avatar clips (one batch job per turn, with the planned reaction
  pauses) in parallel with the listener kits and the full-band TTS turns of
  the radio mix (avatar clip audio is band-limited); reactions are placed per
  rendition; the video is composed inside the single-slot compose limiter,
  then the radio mix is rendered (source fallback: TTS turns → avatar clip
  audio → the video soundtrack).
* ``audio`` — TTS turns + reaction audio → radio mix. Zero avatar calls.

Engines are imported lazily inside the render functions.

Routes are mounted under /api/podcast by app.py.
"""
from __future__ import annotations

import asyncio
import json
import logging
import math
import shutil
import subprocess
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, BackgroundTasks, Response
from fastapi.responses import StreamingResponse, FileResponse

from auth import Principal, get_principal, require_admin
from config import AzureConfig, load_config
from security import (
    AVATAR_FILE_RE,
    COMPOSE_SLOTS,
    DAILY_QUOTA,
    MAX_NARRATION_CHARS,
    MAX_TURNS_PER_SCRIPT,
    PENDING_RENDERS,
    PODCAST_JOB_RE,
    PODCAST_SCRIPT_RE,
    acquire_render_slot,
    is_valid,
    read_upload_limited,
    require_id,
    safe_filename,
    safe_join,
)
from services import avatar_registry
from services import podcast_media as media
from services.scorm_packager import build_scorm_package
from services.voice_catalog import HD_VOICES, is_allowed_voice
from services.podcast_models import (
    AvatarOption,
    Document,
    IngestResponse,
    JobOutputs,
    JobProgress,
    JobState,
    LibraryItem,
    LibrarySummary,
    PodcastHost,
    PodcastJob,
    PublishRequest,
    RenderRequest,
    RenderRoles,
    Script,
    ScriptPatch,
    ScriptRequest,
    Transcript,
    VoiceOption,
    audience_level_or_none,
    podcast_format_or_default,
)

logger = logging.getLogger(__name__)

BACKEND_DIR = Path(__file__).resolve().parents[1]
AVATAR_THUMBS_DIR = BACKEND_DIR / "static" / "avatars"
# Optional licensed music bed (absent by default: no bed).
MUSIC_FILE = BACKEND_DIR / "data" / "music" / "background.mp3"
# Work areas, relative to the working directory like the other podcast data.
OUT_ROOT = Path("data/podcast/out")
REACTION_AUDIO_CACHE = Path("data/podcast/reaction_audio")
HOST_ROLES = ("interviewer", "expert")
# Every JSON response carrying SAS URLs.
NO_STORE = "no-store"

# Everything on `router` is admin-only (default deny). Anonymous library
# reads (published items only) live on `public_router`.
router = APIRouter(prefix="/api/podcast", tags=["podcast"], dependencies=[Depends(require_admin)])
public_router = APIRouter(prefix="/api/podcast", tags=["podcast-public"])

# ---------------------------------------------------------------------------
# In-memory stores (PoC only)
# ---------------------------------------------------------------------------
DOCUMENTS: dict[str, Document] = {}
SCRIPTS: dict[str, Script] = {}
JOBS: dict[str, PodcastJob] = {}
_JOB_FILES: dict[str, dict[str, Path]] = {}

_LIBRARY = None  # lazy singleton


def _get_library(cfg: AzureConfig):
    global _LIBRARY
    if _LIBRARY is None:
        from services.podcast_library import PodcastLibrary
        _LIBRARY = PodcastLibrary(cfg)
    return _LIBRARY


# ---------------------------------------------------------------------------
# Catalog data — curated for the demo
# ---------------------------------------------------------------------------
def _avatars() -> list[AvatarOption]:
    return [AvatarOption(**item) for item in avatar_registry.catalog()]


VOICES: list[VoiceOption] = [
    VoiceOption(id=vid, display_name=name, language=lang, gender=gender, hd=True)
    for vid, name, lang, gender in HD_VOICES
]


def get_cfg() -> AzureConfig:
    return load_config()


# ---------------------------------------------------------------------------
# Catalog endpoints
# ---------------------------------------------------------------------------
@router.get("/avatars", response_model=list[AvatarOption])
def list_avatars() -> list[AvatarOption]:
    return _avatars()


@router.get("/voices", response_model=list[VoiceOption])
def list_voices(language: Optional[str] = None) -> list[VoiceOption]:
    if language:
        return [v for v in VOICES if v.language == language]
    return VOICES


# ---------------------------------------------------------------------------
# Ingestion
# ---------------------------------------------------------------------------
@router.post("/ingest", response_model=IngestResponse)
async def ingest_document(
    file: Optional[UploadFile] = File(None),
    url: Optional[str] = Form(None, max_length=2048),
    cfg: AzureConfig = Depends(get_cfg),
    principal: Principal = Depends(require_admin),
) -> IngestResponse:
    """Ingest an uploaded PPTX/PDF/DOCX/TXT/MD file (or, if enabled, a URL)."""
    from services.podcast_ingest import ALLOWED_FILE_SUFFIXES, ingest_file, ingest_url
    from services.url_safety import UnsafeURLError, url_ingest_enabled

    if not file and not url:
        raise HTTPException(400, "Provide either a file upload or a url form field")
    if not file and not url_ingest_enabled():
        raise HTTPException(400, "URL ingestion is disabled; upload a file instead")

    original_name = ""
    if file:
        original_name = file.filename or ""
        suffix = Path(original_name).suffix.lower()
        if suffix not in ALLOWED_FILE_SUFFIXES:
            raise HTTPException(400, f"Unsupported file type. Allowed: {', '.join(sorted(ALLOWED_FILE_SUFFIXES))}")
        content = await read_upload_limited(file)

    # Count against the daily quota only once the request is well-formed.
    DAILY_QUOTA.consume(principal.user_id)

    try:
        if file:
            tmp_dir = Path("data/uploads/podcast"); tmp_dir.mkdir(parents=True, exist_ok=True)
            tmp_path = tmp_dir / f"{uuid.uuid4().hex}{suffix}"
            tmp_path.write_bytes(content)
            doc = await asyncio.to_thread(ingest_file, tmp_path, cfg.libreoffice_path or "soffice")
            # Preserve the original filename as the display title (ingest sees
            # the uuid-renamed temp file).
            if original_name:
                doc.title = Path(safe_filename(original_name)).stem[:200]
        else:
            doc = await asyncio.to_thread(ingest_url, url)
    except UnsafeURLError as e:
        raise HTTPException(400, f"URL not allowed: {e}")
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception:  # noqa: BLE001
        logger.exception("ingest failed")
        raise HTTPException(500, "Ingestion failed")

    DOCUMENTS[doc.id] = doc
    return IngestResponse(document=doc)


# ---------------------------------------------------------------------------
# Script generation (streaming)
# ---------------------------------------------------------------------------
@router.post("/script/stream")
async def stream_script(
    req: ScriptRequest,
    cfg: AzureConfig = Depends(get_cfg),
    principal: Principal = Depends(require_admin),
):
    """Stream GPT-4.1 script generation as Server-Sent Events."""
    from services.podcast_script import generate_script_stream  # lazy import

    doc = DOCUMENTS.get(req.document_id)
    if not doc:
        raise HTTPException(404, "Document not found")
    DAILY_QUOTA.consume(principal.user_id)

    async def gen():
        try:
            turns = []
            async for turn in generate_script_stream(cfg, doc, req):
                turns.append(turn)
                yield f"event: turn\ndata: {turn.model_dump_json()}\n\n"
            script = Script(
                id=f"scr-{uuid.uuid4().hex[:8]}",
                document_id=doc.id,
                language=req.language,
                style=req.style,
                length=req.length,
                audience_level=req.audience_level,
                turns=turns,
            )
            SCRIPTS[script.id] = script
            yield f"event: done\ndata: {{\"script_id\": \"{script.id}\"}}\n\n"
        except Exception:  # noqa: BLE001
            logger.exception("script stream failed")
            yield 'event: error\ndata: {"message": "Script generation failed"}\n\n'

    return StreamingResponse(gen(), media_type="text/event-stream")


@router.patch("/scripts/{script_id}", response_model=Script)
def patch_script(script_id: str, patch: ScriptPatch) -> Script:
    require_id(script_id, PODCAST_SCRIPT_RE, "Script")
    script = SCRIPTS.get(script_id)
    if not script:
        raise HTTPException(404, "Script not found")
    _check_turns(patch.turns)
    script.turns = patch.turns
    SCRIPTS[script_id] = script
    return script


@router.get("/scripts/{script_id}", response_model=Script)
def get_script(script_id: str) -> Script:
    require_id(script_id, PODCAST_SCRIPT_RE, "Script")
    script = SCRIPTS.get(script_id)
    if not script:
        raise HTTPException(404, "Script not found")
    return script


def _check_turns(turns: list) -> None:
    if len(turns) > MAX_TURNS_PER_SCRIPT:
        raise HTTPException(400, f"Too many turns (max {MAX_TURNS_PER_SCRIPT})")
    for t in turns:
        if len(t.text or "") > MAX_NARRATION_CHARS:
            raise HTTPException(400, f"Turn text too long (max {MAX_NARRATION_CHARS} characters)")


# ---------------------------------------------------------------------------
# Render
# ---------------------------------------------------------------------------
def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


@router.post("/render", response_model=PodcastJob)
async def start_render(
    req: RenderRequest,
    bg: BackgroundTasks,
    cfg: AzureConfig = Depends(get_cfg),
    principal: Principal = Depends(require_admin),
) -> PodcastJob:
    script = SCRIPTS.get(req.script_id)
    if not script:
        raise HTTPException(404, "Script not found")
    _check_turns(script.turns)
    # RenderRequest already requires both avatars for video (422). An audio-only
    # render may leave an avatar empty (monogram); a non-empty one must be known.
    for role in (req.roles.interviewer, req.roles.expert):
        if not is_allowed_voice(role.voice):
            raise HTTPException(400, "Unsupported voice")
        avatar = (role.avatar or "").strip()
        if (req.format == "video" or avatar) and not avatar_registry.is_known(avatar):
            raise HTTPException(400, "Unknown avatar")
    acquire_render_slot()
    try:
        DAILY_QUOTA.consume(principal.user_id)
    except HTTPException:
        PENDING_RENDERS.release()
        raise
    job_id = f"job-{uuid.uuid4().hex[:8]}"
    job = PodcastJob(
        id=job_id,
        script_id=script.id,
        roles=req.roles,
        layout=req.layout,
        music=req.music,
        intro=req.intro,
        state=JobState.queued,
        progress=JobProgress(stage="queued", total=len(script.turns)),
        outputs=JobOutputs(),
        created_at=_now(),
        updated_at=_now(),
        format=req.format,
        reactions=req.reactions,
    )
    JOBS[job_id] = job
    bg.add_task(_run_render_job, job_id, cfg)
    return job


@router.get("/jobs/{job_id}", response_model=PodcastJob)
def get_job(job_id: str) -> PodcastJob:
    require_id(job_id, PODCAST_JOB_RE, "Job")
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(404, f"Job {job_id} not found")
    return job


@router.get("/jobs", response_model=list[PodcastJob])
def list_jobs(limit: int = 20) -> list[PodcastJob]:
    limit = max(1, min(100, limit))
    return sorted(JOBS.values(), key=lambda j: j.created_at, reverse=True)[:limit]


_FILE_MEDIA_TYPES: dict[str, str] = {
    "mp4": "video/mp4",
    "mp3": "audio/mpeg",
    "srt": "application/x-subrip",
    "audio_srt": "application/x-subrip",
    "transcript": "application/json",
    "cover": "image/jpeg",
    "scorm": "application/zip",
}


@router.get("/jobs/{job_id}/file/{kind}")
def download_job_file(job_id: str, kind: str):
    """Serve a finished job's file from local disk (PoC).

    Kinds: ``mp4``/``srt`` (video, timed on the MP4), ``mp3``/``audio_srt``
    (radio mix — or the video soundtrack, see ``audio_kind`` — and captions
    timed on it), ``transcript`` (radio transcript JSON), ``cover`` and
    ``scorm``. 404 when the job has no such rendition (e.g. no MP4 for an
    audio-only render).
    """
    require_id(job_id, PODCAST_JOB_RE, "Job")
    if kind not in _FILE_MEDIA_TYPES:
        raise HTTPException(404, "File not found")
    files = _JOB_FILES.get(job_id)
    if not files:
        raise HTTPException(404, "File not found")

    # Lazy-generate the SCORM package on first request: the MP3 with the captions
    # timed on it (radio SRT; the video SRT for a soundtrack MP3).
    if kind == "scorm" and (not files.get("scorm") or not files["scorm"].exists()):
        mp3_path = files.get("mp3")
        srt_path = files.get("audio_srt")
        if not mp3_path or not srt_path or not mp3_path.exists() or not srt_path.exists():
            raise HTTPException(404, "MP3 or SRT not available for SCORM packaging")
        job = JOBS.get(job_id)
        script = SCRIPTS.get(job.script_id) if job else None
        doc = DOCUMENTS.get(script.document_id) if script else None
        title = (doc.title if doc else job_id) or job_id
        language = script.language if script else "en-US"
        files["scorm"] = build_scorm_package(
            title=title,
            language=language,
            media_path=mp3_path,
            srt_path=srt_path,
            out_dir=mp3_path.parent,
        )

    if kind not in files:
        raise HTTPException(404, "File not found")
    p = files[kind]
    if not p.exists():
        raise HTTPException(404, "File not found on disk")
    media_type = _FILE_MEDIA_TYPES[kind]
    filename = p.name
    if kind == "scorm":
        job = JOBS.get(job_id)
        script = SCRIPTS.get(job.script_id) if job else None
        doc = DOCUMENTS.get(script.document_id) if script else None
        safe = "".join(c if c.isalnum() or c in " -_" else "" for c in (doc.title if doc else job_id))[:60].strip()
        filename = f"{safe or job_id}-scorm.zip"
    return FileResponse(p, media_type=media_type, filename=filename)


# ---------------------------------------------------------------------------
# Library
# ---------------------------------------------------------------------------
def _flag(value: object, default: bool) -> bool:
    return value if isinstance(value, bool) else default


def _hosts_dto(value: object) -> list[dict]:
    """Allow-listed ``PodcastHost`` dicts (role, display_name, avatar_id); invalid entries dropped."""
    hosts: list[dict] = []
    for entry in value if isinstance(value, (list, tuple)) else ():
        try:
            hosts.append(PodcastHost.model_validate(entry).model_dump())
        except Exception:  # noqa: BLE001
            continue
    return hosts


def _transcript_dto(value: object) -> Optional[dict]:
    """The transcript re-serialized through its model (contract keys only), else None."""
    if value is None:
        return None
    try:
        return Transcript.model_validate(value).model_dump()
    except Exception:  # noqa: BLE001
        return None


def _names(value: object) -> list[str]:
    return [n for n in value if isinstance(n, str)] if isinstance(value, list) else []


def _public_item(item: dict) -> dict:
    """Anonymous DTO (allow-list) of a published library item.

    Always: identity, duration, language, format, ``has_video``/``has_audio``,
    the thumbnail and the video (``video_url`` = ``mp4_url``). Only with
    ``PODCAST_PUBLIC_AUDIO`` on: the audio (``audio_url`` = ``mp3_url``), its
    duration, the cover, hosts, speaker names and the inline transcript.
    ``PodcastLibrary`` already applies that policy; it is re-applied here so
    the DTO never depends on it. Never: ``srt_url``, ``audio_srt_url``,
    ``scorm_url``, ``script`` (always None) or ``document_title``.
    """
    audio_public = media.public_audio_enabled()
    fmt = podcast_format_or_default(item.get("format"))
    has_video = _flag(item.get("has_video"), fmt == "video")
    has_audio = audio_public and _flag(item.get("has_audio"), False)
    video_url = (item.get("mp4_url") or item.get("video_url")) if has_video else None
    audio_url = (item.get("audio_url") or item.get("mp3_url")) if has_audio else None
    return {
        "job_id": item.get("job_id"),
        "title": item.get("title") or "",
        "created_at": item.get("created_at") or "",
        "duration_sec": item.get("duration_sec"),
        "audio_duration_sec": item.get("audio_duration_sec") if has_audio else None,
        "language": item.get("language") or "en-US",
        "format": fmt,
        "has_video": has_video,
        "has_audio": has_audio,
        "thumbnail_url": item.get("thumbnail_url"),
        "cover_url": item.get("cover_url") if audio_public else None,
        "video_url": video_url,
        "mp4_url": video_url,
        "audio_url": audio_url,
        "mp3_url": audio_url,
        "hosts": _hosts_dto(item.get("hosts")) if audio_public else [],
        "speaker_names": _names(item.get("speaker_names")) if audio_public else [],
        "transcript": _transcript_dto(item.get("transcript")) if has_audio else None,
        "srt_url": None,
        "audio_srt_url": None,
        "scorm_url": None,
        "script": None,
    }


def _summary_fields(item: dict) -> dict:
    fmt = podcast_format_or_default(item.get("format"))
    return {
        "job_id": item["job_id"],
        "title": item.get("title") or "",
        "document_title": item.get("document_title") or "",
        "created_at": item.get("created_at") or "",
        "duration_sec": item.get("duration_sec"),
        "language": item.get("language") or "en-US",
        "style": item.get("style") or "casual",
        "audience_level": audience_level_or_none(item.get("audience_level")),
        "speaker_names": _names(item.get("speaker_names")),
        "turn_count": item.get("turn_count") or 0,
        "thumbnail_url": item.get("thumbnail_url"),
        "published": bool(item.get("published")),
        "format": fmt,
        "has_video": _flag(item.get("has_video"), fmt == "video"),
        "has_audio": _flag(item.get("has_audio"), bool(item.get("mp3_url") or item.get("audio_url"))),
        "audio_duration_sec": item.get("audio_duration_sec"),
        "hosts": _hosts_dto(item.get("hosts")),
    }


def _summary_item(item: dict) -> dict:
    """Admin library card (``LibrarySummary``)."""
    return LibrarySummary(**_summary_fields(item)).model_dump()


def _full_item(item: dict) -> dict:
    """Admin library item (``LibraryItem``) with every signed rendition."""
    return LibraryItem(**{
        **_summary_fields(item),
        "mp4_url": item.get("mp4_url"),
        "mp3_url": item.get("mp3_url"),
        "srt_url": item.get("srt_url"),
        "scorm_url": item.get("scorm_url"),
        "audio_url": item.get("audio_url") or item.get("mp3_url"),
        "cover_url": item.get("cover_url"),
        "audio_srt_url": item.get("audio_srt_url"),
        "transcript": _transcript_dto(item.get("transcript")),
    }).model_dump()


@public_router.get("/library")
def list_library(
    response: Response,
    cfg: AzureConfig = Depends(get_cfg),
    principal: Principal = Depends(get_principal),
) -> list[dict]:
    """Archived podcasts (newest first).

    Admins see every item (with its `published` flag); anonymous callers
    only see published items as public DTOs. Media URLs are minted by
    `GET /library/{job_id}` when the user opens the player.
    """
    response.headers["Cache-Control"] = NO_STORE
    lib = _get_library(cfg)
    if not lib.available:
        return []
    if principal.is_admin:
        return [_summary_item(item) for item in lib.list()]
    return [_public_item(item) for item in lib.list(published_only=True)]


@public_router.get("/library/{job_id}")
def get_library_item(
    job_id: str,
    response: Response,
    cfg: AzureConfig = Depends(get_cfg),
    principal: Principal = Depends(get_principal),
) -> dict:
    """A library item with fresh signed URLs (public DTO for anonymous callers)."""
    require_id(job_id, PODCAST_JOB_RE, "Library item")
    response.headers["Cache-Control"] = NO_STORE
    lib = _get_library(cfg)
    if not lib.available:
        raise HTTPException(503, "Library storage not available")
    if principal.is_admin:
        item = lib.get(job_id)
        if not item:
            raise HTTPException(404, "Library item not found")
        return _full_item(item)
    item = lib.get(job_id, public=True)
    if not item:
        raise HTTPException(404, "Library item not found")
    return _public_item(item)


@router.post("/library/{job_id}/publish")
def publish_library_item(job_id: str, body: PublishRequest, response: Response,
                         cfg: AzureConfig = Depends(get_cfg)) -> dict:
    """Admin: show/hide a library item to anonymous viewers."""
    require_id(job_id, PODCAST_JOB_RE, "Library item")
    response.headers["Cache-Control"] = NO_STORE
    lib = _get_library(cfg)
    if not lib.available:
        raise HTTPException(503, "Library storage not available")
    item = lib.set_published(job_id, body.published)
    if not item:
        raise HTTPException(404, "Library item not found")
    return _full_item(item)


@router.delete("/library/{job_id}")
def delete_library_item(job_id: str, cfg: AzureConfig = Depends(get_cfg)) -> dict:
    require_id(job_id, PODCAST_JOB_RE, "Library item")
    lib = _get_library(cfg)
    if not lib.available:
        raise HTTPException(503, "Library storage not available")
    ok = lib.delete(job_id)
    if not ok:
        raise HTTPException(404, "Not found or delete failed")
    return {"deleted": job_id}


async def _run_render_job(job_id: str, cfg: AzureConfig) -> None:
    try:
        await _render_job_body(job_id, cfg)
    finally:
        PENDING_RENDERS.release()


# ---------------------------------------------------------------------------
# Render pipeline
# ---------------------------------------------------------------------------
_MSG_SYNTHESIZING = "Synthesizing voices…"
_MSG_SIDE_WORK = "Avatar clips ready — finishing the listener and the radio voices…"
_MSG_COMPOSE_WAIT = "Waiting for the video composer (one video is composed at a time)…"
_MSG_COMPOSING = "Composing the video…"
_MSG_MIXING = "Mixing the radio version…"
_MSG_ARCHIVING = "Saving to the library…"

# Hard cap on the video's side work (listener kits, radio voices), from the start
# of the render: max(PODCAST_LISTENER_TIMEOUT_SEC, SIDE_WORK_MIN_SEC) + grace. The
# kits honour their own deadline cooperatively; this only guards against a hung
# engine (side work still running then is treated as timed out).
SIDE_WORK_MIN_SEC = 600.0
SIDE_WORK_GRACE_SEC = 120.0


@dataclass
class _RenderRun:
    """Shared state of one render job."""
    job: PodcastJob
    script: Script
    doc: Optional[Document]
    cfg: AzureConfig
    title: str
    hosts: list[PodcastHost]
    warnings: list[str]
    update: Callable[..., None]
    planned: list = field(default_factory=list)  # podcast_media.PlannedReaction
    pauses: dict = field(default_factory=dict)   # {turn_idx: {after_sentence: pause_ms}}
    # Video side work running in threads alongside the avatar turns.
    side_tasks: list = field(default_factory=list)
    side_deadline: Optional[float] = None

    @property
    def seed(self) -> str:
        return self.job.id

    @property
    def total(self) -> int:
        return len(self.script.turns)

    @property
    def out_dir(self) -> Path:
        return OUT_ROOT / self.job.id

    @property
    def texts(self) -> dict[int, str]:
        return {t.idx: t.text for t in self.script.turns}


@dataclass
class _Deliverables:
    """Local files of a finished render.

    ``mp3`` is the radio mix, or the video soundtrack when ``audio_kind`` is
    ``"soundtrack"`` (``audio_srt`` is then the video SRT: same timeline).
    """
    audio_kind: str
    mp3: Path
    audio_srt: Optional[Path]
    transcript: Optional[Path]
    cover: Optional[Path]
    audio_duration: Optional[float]
    mp4: Optional[Path] = None
    srt: Optional[Path] = None
    video_duration: Optional[float] = None

    def files(self) -> dict[str, Path]:
        pairs = (("mp4", self.mp4), ("mp3", self.mp3), ("srt", self.srt), ("audio_srt", self.audio_srt),
                 ("transcript", self.transcript), ("cover", self.cover))
        return {kind: Path(path) for kind, path in pairs if path is not None}

    def outputs(self, job_id: str) -> JobOutputs:
        kinds = self.files()

        def url(kind: str) -> Optional[str]:
            return f"/api/podcast/jobs/{job_id}/file/{kind}" if kind in kinds else None

        return JobOutputs(
            mp4_url=url("mp4"),
            mp3_url=url("mp3"),
            srt_url=url("srt"),
            duration_sec=self.video_duration if self.mp4 is not None else self.audio_duration,
            audio_srt_url=url("audio_srt"),
            transcript_url=url("transcript"),
            cover_url=url("cover"),
            audio_duration_sec=self.audio_duration,
            video_duration_sec=self.video_duration,
            audio_kind=self.audio_kind,
        )


async def _render_job_body(job_id: str, cfg: AzureConfig) -> None:
    """Render one job (``job.format``), archive it, and record state/outputs/warnings.

    Never raises: failures mark the job ``failed`` with a generic error;
    ``job.warnings`` only ever holds stable ``podcast_media`` codes.
    """
    job = JOBS[job_id]
    script = SCRIPTS[job.script_id]
    doc = DOCUMENTS.get(script.document_id)
    warnings: list[str] = []
    job.warnings = warnings
    job.listener_mode = None
    run: Optional[_RenderRun] = None

    def _update(state: JobState, stage: str, completed: int = 0,
                message: str = "", error: Optional[str] = None) -> None:
        job.state = state
        job.progress.stage = stage
        job.progress.completed = completed
        job.progress.total = len(script.turns)
        job.progress.message = message
        job.error = error
        job.updated_at = _now()

    try:
        run = _RenderRun(job=job, script=script, doc=doc, cfg=cfg,
                         title=(doc.title if doc else script.id) or script.id,
                         hosts=_hosts(job.roles), warnings=warnings, update=_update)
        run.planned = _plan_reactions(run)
        run.pauses = media.planned_pauses(run.planned)
        if job.format == "audio":
            result = await _render_audio(run)
        else:
            result = await _render_video(run)
        job.outputs = result.outputs(job.id)
        # File locations for the local download route.
        _JOB_FILES[job.id] = result.files()
        _update(JobState.composing, "mixing", completed=run.total, message=_MSG_ARCHIVING)
        # A failed archive doesn't fail the job (archive_state=failed for the UI).
        await _archive(run, result)
        _update(JobState.done, "done", completed=run.total, message="Ready")
    except Exception:  # noqa: BLE001
        logger.exception("render job %s failed", job_id)
        _update(JobState.failed, "failed", error="Render failed; see server logs")
    finally:
        if run is not None:
            await _drain_side_work(run)
        job.warnings = list(warnings)


def _plan_reactions(run: _RenderRun) -> list:
    """Backchannels planned on the script text; [] unless the request AND the kill switch allow them."""
    enabled = media.effective_reactions(run.job.reactions)
    try:
        from services.podcast_reactions import plan_reactions

        return list(plan_reactions(run.script.turns, run.script.language, run.seed, enabled=enabled))
    except Exception as exc:  # noqa: BLE001 — backchannels are an optional layer
        logger.warning("podcast %s: reaction planning failed (%s); no reactions", run.job.id, type(exc).__name__)
        if enabled:
            _warn(run.warnings, media.WARNING_REACTIONS_SKIPPED)
        return []


def _avatar_message() -> str:
    try:
        from services.podcast_render import batch_create_per_min

        rate = int(batch_create_per_min())
    except Exception:  # noqa: BLE001
        rate = 2
    return f"Rendering avatar clips (avatar jobs are rate-limited to {rate} per minute)…"


def _in_thread(fn: Callable[..., Any], *args: Any, **kwargs: Any) -> asyncio.Future:
    task = asyncio.ensure_future(asyncio.to_thread(fn, *args, **kwargs))
    task.add_done_callback(_mark_retrieved)
    return task


def _mark_retrieved(task: asyncio.Future) -> None:
    # Failures are handled (or deliberately ignored) by the caller; never let
    # asyncio log them as "never retrieved" with their raw text.
    if not task.cancelled():
        task.exception()


async def _side_results(run: _RenderRun) -> list[object]:
    """Result (or exception) of each side task; one still running at ``side_deadline`` reads as TimeoutError."""
    timeout = None if run.side_deadline is None else max(0.0, run.side_deadline - time.monotonic())
    await asyncio.wait(run.side_tasks, timeout=timeout)
    results: list[object] = []
    for task in run.side_tasks:
        if not task.done():
            results.append(TimeoutError("side work still running"))
        elif task.cancelled():
            results.append(asyncio.CancelledError())
        else:
            exc = task.exception()
            results.append(exc if exc is not None else task.result())
    return results


async def _drain_side_work(run: _RenderRun) -> None:
    """Hold the render slot until the side work stops (bounded by ``side_deadline``)."""
    pending = [task for task in run.side_tasks if not task.done()]
    if not pending:
        return
    timeout = None if run.side_deadline is None else max(0.0, run.side_deadline - time.monotonic())
    _, still_running = await asyncio.wait(pending, timeout=timeout)
    if still_running:
        logger.warning("podcast %s: %d side task(s) still running past their deadline",
                       run.job.id, len(still_running))


async def _render_video(run: _RenderRun) -> _Deliverables:
    """Avatar turns ∥ listener kits ∥ radio voices → video (compose slot) → radio mix.

    A failed avatar render fails the job; the listener, the radio voices and
    the reactions only degrade it (warning codes). Radio source: TTS turns →
    avatar clip audio → the video soundtrack (``radio_fallback``).
    """
    from services.podcast_compose import compose_podcast
    from services.podcast_listener import resolve_listener_kits
    from services.podcast_render import render_podcast

    job, script, cfg = run.job, run.script, run.cfg
    message = _avatar_message()
    run.update(JobState.rendering, "rendering", message=message)

    def on_turn(done: int) -> None:
        run.update(JobState.rendering, "rendering", completed=done, message=message)

    start = time.monotonic()
    listener_budget = media.listener_timeout_sec()
    run.side_deadline = start + max(listener_budget, SIDE_WORK_MIN_SEC) + SIDE_WORK_GRACE_SEC
    avatar_task = _in_thread(render_podcast, cfg, script, job.roles, on_turn, script.language,
                             pauses=run.pauses)
    kits_task = _in_thread(resolve_listener_kits, cfg, job.roles, script.language,
                           want_reactions=bool(run.planned), deadline=start + listener_budget)
    tts_task = _in_thread(_synthesize_turns, run, None)
    voices_task = _in_thread(_reaction_audio, run)
    run.side_tasks.extend((kits_task, tts_task, voices_task))

    clips = sorted(await avatar_task, key=lambda c: c.turn_idx)
    if not all(task.done() for task in run.side_tasks):
        run.update(JobState.rendering, "rendering", completed=run.total, message=_MSG_SIDE_WORK)
    kits_res, tts_res, voices_res = await _side_results(run)

    # Video: avatar clips + the listener kits' lip-synced reaction clips.
    kits = _listener_kits(run, kits_res)
    kit_clips = {role: dict(kit.reactions) for role, kit in kits.items() if getattr(kit, "reactions", None)}
    placements = await _place_reactions(run, {c.turn_idx: Path(c.blob_url) for c in clips}, kit_clips)
    _note_skipped(run, placements)

    composed = await asyncio.to_thread(_compose_in_slot, run, compose_podcast, clips, kits, placements, kit_clips)
    for code in getattr(composed, "warnings", None) or ():
        _warn(run.warnings, code)
    timeline = getattr(composed, "timeline", None)
    mode = getattr(timeline, "listener_mode", None)
    job.listener_mode = mode if mode in media.LISTENER_MODES else None
    video_duration = _positive(getattr(timeline, "duration_sec", None))
    if video_duration is None:
        video_duration = await asyncio.to_thread(_media_duration, Path(composed.mp4))
    mp4, srt = Path(composed.mp4), Path(composed.srt)

    # Radio: full-band TTS turns + reaction audio; else the (band-limited) avatar
    # clip audio, which has the video's placements; else the video soundtrack.
    run.update(JobState.composing, "mixing", completed=run.total, message=_MSG_MIXING)
    sources: list[tuple[str, list, dict, Optional[list]]] = []
    tts_turns = _complete_turns(run, tts_res)
    if tts_turns is not None:
        sources.append(("tts", tts_turns, voices_res if isinstance(voices_res, dict) else {}, None))
    else:
        reason = type(tts_res).__name__ if isinstance(tts_res, BaseException) else "incomplete"
        logger.warning("podcast %s: radio voices unavailable (%s); radio from the avatar audio", job.id, reason)
    avatar_turns = [
        media.TurnAudio(turn_idx=c.turn_idx, speaker=c.speaker, path=Path(c.blob_url), source="avatar",
                        duration_sec=float(c.duration_sec or 0.0))
        for c in clips
    ]
    sources.append(("avatar", avatar_turns, kit_clips, placements))
    offsets = getattr(timeline, "turn_video_offsets", None)
    for source, turns, clips_by_role, radio_placements in sources:
        if radio_placements is None:
            radio_placements = await _place_reactions(
                run, {t.turn_idx: Path(t.path) for t in turns}, clips_by_role)
        try:
            radio, mix_warnings = await _mix_radio(run, turns, radio_placements, clips_by_role, offsets)
        except Exception as exc:  # noqa: BLE001
            logger.warning("podcast %s: radio mix from the %s audio failed (%s)", job.id, source,
                           type(exc).__name__)
            continue
        _note_skipped(run, radio_placements)
        for code in mix_warnings:
            _warn(run.warnings, code)
        return _radio_deliverables(radio, mp4=mp4, srt=srt, video_duration=video_duration)

    _warn(run.warnings, media.WARNING_RADIO_FALLBACK)
    return await asyncio.to_thread(_soundtrack_deliverables, run, mp4, Path(composed.mp3), srt, video_duration)


async def _render_audio(run: _RenderRun) -> _Deliverables:
    """Audio only: TTS turns + reaction audio → radio mix. Zero avatar calls."""
    run.update(JobState.rendering, "synthesizing", message=_MSG_SYNTHESIZING)

    def on_turn(done: int) -> None:
        run.update(JobState.rendering, "synthesizing", completed=done, message=_MSG_SYNTHESIZING)

    turns_res, voices = await asyncio.gather(
        asyncio.to_thread(_synthesize_turns, run, on_turn),
        asyncio.to_thread(_reaction_audio, run),
        return_exceptions=True,
    )
    if isinstance(turns_res, BaseException):
        raise turns_res
    turns = _complete_turns(run, turns_res)
    if turns is None:
        raise RuntimeError("speech synthesis returned an incomplete set of turns")
    clips_by_role = voices if isinstance(voices, dict) else {}
    placements = await _place_reactions(run, {t.turn_idx: Path(t.path) for t in turns}, clips_by_role)
    _note_skipped(run, placements)

    run.update(JobState.composing, "mixing", completed=run.total, message=_MSG_MIXING)
    radio, mix_warnings = await _mix_radio(run, turns, placements, clips_by_role, None)
    for code in mix_warnings:
        _warn(run.warnings, code)
    return _radio_deliverables(radio)


def _synthesize_turns(run: _RenderRun, progress_cb: Optional[Callable[[int], None]]) -> list:
    """Full-band TTS of every turn with the planned pauses (``podcast_tts``)."""
    from services.podcast_tts import synthesize_turns

    work_dir = run.out_dir / "tts"
    work_dir.mkdir(parents=True, exist_ok=True)
    return list(synthesize_turns(run.cfg, run.script, run.job.roles, work_dir,
                                 pauses=run.pauses, progress_cb=progress_cb))


def _complete_turns(run: _RenderRun, res: object) -> Optional[list]:
    """TTS turns sorted by turn, or None when synthesis failed or missed a turn."""
    if isinstance(res, BaseException) or not isinstance(res, (list, tuple)):
        return None
    turns = sorted(res, key=lambda t: t.turn_idx)
    if [t.turn_idx for t in turns] != sorted(t.idx for t in run.script.turns):
        return None
    return turns


def _reaction_ids_by_listener(planned: list) -> dict[str, list[str]]:
    wanted: dict[str, set[str]] = {}
    for p in planned:
        wanted.setdefault(p.listener, set()).add(p.reaction_id)
    return {role: [rid for rid in media.REACTION_IDS if rid in ids]
            for role, ids in wanted.items() if role in HOST_ROLES}


def _reaction_audio(run: _RenderRun) -> dict[str, dict[str, Any]]:
    """Audio-only reaction clips by listener role for the radio mix (one call per voice).

    Never raises: a voice whose phrases fail gets none (its reactions are skipped).
    """
    wanted = _reaction_ids_by_listener(run.planned)
    if not wanted:
        return {}
    try:
        from services.podcast_tts import synthesize_reaction_audio

        REACTION_AUDIO_CACHE.mkdir(parents=True, exist_ok=True)
    except Exception as exc:  # noqa: BLE001
        logger.warning("podcast %s: reaction audio unavailable (%s)", run.job.id, type(exc).__name__)
        return {}
    voice_of = {role: getattr(run.job.roles, role).voice for role in wanted}
    ids_by_voice: dict[str, set[str]] = {}
    for role, ids in wanted.items():
        ids_by_voice.setdefault(voice_of[role], set()).update(ids)
    clips_by_voice: dict[str, dict[str, Any]] = {}
    for voice, ids in ids_by_voice.items():
        try:
            clips = synthesize_reaction_audio(run.cfg, voice, run.script.language,
                                              [rid for rid in media.REACTION_IDS if rid in ids],
                                              REACTION_AUDIO_CACHE)
            clips_by_voice[voice] = dict(clips or {})
        except Exception as exc:  # noqa: BLE001 — the speaker simply pauses
            logger.warning("podcast %s: reaction audio unavailable (%s)", run.job.id, type(exc).__name__)
    return {role: clips_by_voice[voice_of[role]] for role in wanted if voice_of[role] in clips_by_voice}


def _listener_kits(run: _RenderRun, res: object) -> dict[str, Any]:
    """Listener kits by role plus their warning codes (a failure → no kits, still listener)."""
    if isinstance(res, BaseException) or not isinstance(res, dict):
        logger.warning("podcast %s: listener kits unavailable (%s)", run.job.id, type(res).__name__)
        timed_out = isinstance(res, TimeoutError)
        _warn(run.warnings, media.WARNING_LISTENER_TIMEOUT if timed_out else media.WARNING_LISTENER_FALLBACK)
        return {}
    kits = {role: kit for role, kit in res.items() if role in HOST_ROLES and kit is not None}
    for kit in kits.values():
        for code in getattr(kit, "warnings", None) or ():
            _warn(run.warnings, code)
    return kits


async def _place_reactions(run: _RenderRun, turn_audio: dict[int, Path], clips_by_role: dict) -> list:
    """Planned reactions placed in one rendition's measured pauses ([] on any failure)."""
    if not run.planned:
        return []
    try:
        from services.podcast_reactions import place_reactions

        return list(await asyncio.to_thread(place_reactions, run.planned, turn_audio, clips_by_role,
                                            texts=run.texts))
    except Exception as exc:  # noqa: BLE001 — never fail a render because of backchannels
        logger.warning("podcast %s: reaction placement failed (%s)", run.job.id, type(exc).__name__)
        return []


def _note_skipped(run: _RenderRun, placements: list) -> None:
    if len(placements) < len(run.planned):
        _warn(run.warnings, media.WARNING_REACTIONS_SKIPPED)


def _compose_in_slot(run: _RenderRun, compose_podcast: Callable[..., Any], clips: list,
                     kits: dict, placements: list, kit_clips: dict) -> Any:
    """``compose_podcast`` inside the compose limiter (waits for the slot; worker thread only)."""
    if not COMPOSE_SLOTS.acquire(timeout=0):
        run.update(JobState.composing, "composing", completed=run.total, message=_MSG_COMPOSE_WAIT)
        COMPOSE_SLOTS.acquire()
    try:
        run.update(JobState.composing, "composing", completed=run.total, message=_MSG_COMPOSING)
        return compose_podcast(
            clips, run.doc, run.script, run.job.roles, run.out_dir,
            run.job.music, run.job.intro,
            layout=run.job.layout,
            listener_kits=kits,
            reactions=placements,
            reaction_clips=kit_clips,
            seed=run.seed,
        )
    finally:
        COMPOSE_SLOTS.release()


async def _mix_radio(run: _RenderRun, turn_audio: list, placements: list, clips_by_role: dict,
                     video_offsets: Optional[dict]) -> tuple[Any, list[str]]:
    """Radio mix of one audio source: ``(RadioResult, warning codes)``; raises on failure."""
    from services.podcast_radio import mix_radio

    mix_warnings: list[str] = []
    radio = await asyncio.to_thread(
        mix_radio, list(turn_audio), list(placements), clips_by_role, run.script, run.job.roles, run.hosts,
        title=run.title,
        language=run.script.language,
        out_dir=run.out_dir / "radio",
        intro=run.job.intro,
        seed=run.seed,
        video_offsets=dict(video_offsets) if video_offsets else None,
        music_path=_music_path(run.job),
        avatar_images=_avatar_images(run.job.roles),
        warnings=mix_warnings,
    )
    return radio, mix_warnings


def _radio_deliverables(radio: Any, *, mp4: Optional[Path] = None, srt: Optional[Path] = None,
                        video_duration: Optional[float] = None) -> _Deliverables:
    kind = getattr(radio, "audio_kind", None)
    return _Deliverables(
        audio_kind=kind if kind in ("radio_mix", "soundtrack") else "radio_mix",
        mp3=Path(radio.mp3),
        audio_srt=Path(radio.srt),
        transcript=Path(radio.transcript_path),
        cover=Path(radio.cover) if radio.cover else None,
        audio_duration=_positive(radio.duration_sec),
        mp4=mp4,
        srt=srt,
        video_duration=video_duration,
    )


def _soundtrack_deliverables(run: _RenderRun, mp4: Path, mp3: Path, srt: Path,
                             video_duration: Optional[float]) -> _Deliverables:
    """Radio fallback: the video soundtrack, captioned by the video SRT (same timeline)."""
    return _Deliverables(
        audio_kind="soundtrack",
        mp3=mp3,
        audio_srt=srt,
        transcript=_soundtrack_transcript(run, srt, video_duration),
        cover=None,
        audio_duration=video_duration,
        mp4=mp4,
        srt=srt,
        video_duration=video_duration,
    )


def _soundtrack_transcript(run: _RenderRun, srt: Path, duration: Optional[float]) -> Optional[Path]:
    """Transcript of a soundtrack MP3 derived from the video SRT (as for v1 library items)."""
    try:
        from services.podcast_library import transcript_from_srt

        data = transcript_from_srt(srt.read_text(encoding="utf-8"), [h.model_dump() for h in run.hosts],
                                   duration_sec=duration, video_aligned=True)
        if not data:
            return None
        path = run.out_dir / "soundtrack_transcript.json"
        path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        return path
    except Exception as exc:  # noqa: BLE001
        logger.warning("podcast %s: soundtrack transcript unavailable (%s)", run.job.id, type(exc).__name__)
        return None


async def _archive(run: _RenderRun, result: _Deliverables) -> None:
    """Publish the render to the blob library (SCORM = the MP3 + the captions timed on it)."""
    from services.podcast_library import LibraryFiles as SoundtrackLibraryFiles

    job = run.job
    job.archive_state = "archiving"
    job.updated_at = _now()
    try:
        lib = _get_library(run.cfg)
        if not lib.available:
            job.archive_state = "failed"
            return
        scorm = await asyncio.to_thread(_build_scorm, run, result)
        if scorm is not None:
            _JOB_FILES.setdefault(job.id, {})["scorm"] = scorm
        if result.audio_kind == "soundtrack" and result.mp4 is not None and result.srt is not None:
            files: Any = SoundtrackLibraryFiles(mp4=result.mp4, mp3=result.mp3, srt=result.srt, scorm=scorm)
        else:
            files = media.LibraryFiles(
                mp3=result.mp3, audio_srt=result.audio_srt, transcript=result.transcript, cover=result.cover,
                mp4=result.mp4, srt=result.srt, scorm=scorm,
            )
        manifest = await asyncio.to_thread(
            lib.publish,
            job.id,
            files,
            title=run.title,
            document_title=(run.doc.title if run.doc else ""),
            language=run.script.language,
            style=run.script.style,
            speaker_names=[job.roles.interviewer.display_name, job.roles.expert.display_name],
            turn_count=run.total,
            created_at=job.created_at,
            audience_level=run.script.audience_level,
            hosts=run.hosts,
            audio_kind=result.audio_kind,
            listener_mode=job.listener_mode,
        )
        if manifest:
            job.archive_state = "published"
            job.library_job_id = job.id
        else:
            job.archive_state = "failed"
    except Exception:  # noqa: BLE001
        logger.exception("Library archive failed for %s", job.id)
        job.archive_state = "failed"
    finally:
        job.updated_at = _now()


def _build_scorm(run: _RenderRun, result: _Deliverables) -> Optional[Path]:
    """SCORM package of the MP3 + its captions (best effort: None on failure)."""
    srt = result.audio_srt
    if srt is None or not srt.is_file() or not result.mp3.is_file():
        return None
    try:
        return build_scorm_package(title=run.title, language=run.script.language,
                                   media_path=result.mp3, srt_path=srt, out_dir=run.out_dir)
    except Exception as exc:  # noqa: BLE001
        logger.warning("podcast %s: SCORM packaging failed (%s)", run.job.id, type(exc).__name__)
        return None


def _hosts(roles: RenderRoles) -> list[PodcastHost]:
    """Public host identities: display names + registry avatar ids (never Speech character names)."""
    hosts: list[PodcastHost] = []
    for role_name in HOST_ROLES:
        role = getattr(roles, role_name)
        avatar = (role.avatar or "").strip()
        avatar_id = avatar_registry.get(avatar).id if avatar and avatar_registry.is_known(avatar) else None
        name = (role.display_name or "").strip() or role_name.title()
        hosts.append(PodcastHost(role=role_name, display_name=name, avatar_id=avatar_id))
    return hosts


def _avatar_images(roles: RenderRoles) -> dict[str, Path]:
    """Static avatar thumbnails by role (cover portraits), for avatars that have one."""
    images: dict[str, Path] = {}
    prefix = avatar_registry.THUMBNAIL_URL_PREFIX
    for role_name in HOST_ROLES:
        avatar = (getattr(roles, role_name).avatar or "").strip()
        if not avatar or not avatar_registry.is_known(avatar):
            continue
        url = avatar_registry.get(avatar).thumbnail_url or ""
        name = url[len(prefix):] if url.startswith(prefix) else ""
        path = safe_join(AVATAR_THUMBS_DIR, name) if is_valid(name, AVATAR_FILE_RE) else None
        if path is not None and path.is_file():
            images[role_name] = path
    return images


def _music_path(job: PodcastJob) -> Optional[Path]:
    return MUSIC_FILE if job.music and MUSIC_FILE.is_file() else None


def _warn(warnings: list[str], code: object) -> None:
    """Record a stable warning code once; anything else is dropped, never echoed."""
    if isinstance(code, str) and code in media.WARNING_CODES:
        media.add_warning(warnings, code)
    else:
        logger.warning("podcast: dropped an unknown warning code")


def _positive(value: object) -> Optional[float]:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    return number if math.isfinite(number) and number > 0 else None


def _media_duration(path: Path) -> Optional[float]:
    """Container duration (ffprobe), or None."""
    if not shutil.which("ffprobe"):
        return None
    try:
        proc = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
            capture_output=True, text=True, timeout=30,
        )
        return _positive(float(proc.stdout.strip()))
    except (OSError, ValueError, subprocess.SubprocessError):
        return None
